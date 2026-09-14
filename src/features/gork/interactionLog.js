/**
 * Gork interaction log (E2E capture) — config knobs + the per-call recorder
 * (session 2026-09-13-gork-interaction-log, locked spec §3).
 *
 * One recorder per Gork agent call: `onEvent` is the capture sink wired into
 * the src/core/ai.js seam (it snapshots every request/response/tool event as
 * it happens), and `finalize(outcome)` assembles the ONE `gork_interactions`
 * row (request prompts, guild/context/roster/memory snapshots, transcript,
 * raw + shipped answer) and inserts it through the injectable repo.
 *
 * Never-throw contract everywhere (same posture as the audit log and the
 * repo): a broken capture or a broken insert degrades to a `[gork]`
 * console.warn and `{ok:false,error}` — logging must never alter or break
 * the reply path (AGENTS.md error handling).
 */

const crypto = require("crypto");

/** Transcript event cap — overflow drops the OLDEST events (latest matter most). */
const MAX_EVENTS = 64;
/** Per-string cap inside a captured event (tool outputs, message contents). */
const EVENT_STRING_CAP = 4000;
/** Marker appended to a capped string so truncation is obvious in fixtures. */
const STRING_CAP_MARKER = "…[interaction-log-truncated]";
/** Retention days when the env knob is unset/garbage (0 = forever). */
const DEFAULT_RETENTION_DAYS = 30;
/** Transcript JSON char budget when the env knob is unset/garbage. */
const DEFAULT_MAX_JSON_CHARS = 200_000;
/** Env names owned by this module (read PER CALL, like llmParams()). */
const ENV_KEYS = Object.freeze([
  "GORK_INTERACTION_LOG",
  "GORK_INTERACTION_LOG_RETENTION_DAYS",
  "GORK_INTERACTION_LOG_MAX_JSON_CHARS",
]);

/**
 * Env config, re-read on every call (same "overrides apply without a
 * restart" idiom as llmParams()/memoryTurnConfig()). GORK_INTERACTION_LOG
 * "0" is the process-wide kill-switch; retention 0 keeps rows forever;
 * garbage values fall back to the defaults.
 *
 * @returns {{ enabled: boolean, retentionDays: number, maxJsonChars: number }}
 */
function interactionLogConfig() {
  const kill = String(process.env.GORK_INTERACTION_LOG ?? "").trim();
  // Number(undefined) and Number("") are NaN/0 traps → an EMPTY string counts
  // as unset (default), only an explicitly set value may parse.
  const rawRetention = String(process.env.GORK_INTERACTION_LOG_RETENTION_DAYS ?? "").trim();
  const retention = Number(rawRetention);
  const maxJson = Number(process.env.GORK_INTERACTION_LOG_MAX_JSON_CHARS);
  return {
    enabled: kill !== "0",
    retentionDays:
      rawRetention !== "" && Number.isFinite(retention) && retention >= 0
        ? Math.floor(retention)
        : DEFAULT_RETENTION_DAYS,
    maxJsonChars:
      Number.isFinite(maxJson) && maxJson > 0
        ? Math.floor(maxJson)
        : DEFAULT_MAX_JSON_CHARS,
  };
}

/**
 * Master switch for writing rows: the env kill-switch AND the per-guild
 * `gork_interaction_log_enabled` setting (default 1 when the column is
 * absent — the row is still useful for the count-only kill check).
 *
 * @param {{ gork_interaction_log_enabled?: unknown }|null} [settings]
 * @returns {boolean}
 */
function isInteractionLogEnabled(settings) {
  if (!interactionLogConfig().enabled) return false;
  return Number(settings?.gork_interaction_log_enabled ?? 1) === 1;
}

/**
 * Snapshot of the prompt-relevant guild settings (stored as the `settings`
 * JSON column; the fixture exporter replays against exactly these).
 *
 * @param {object|null} [settings] getGuildSettings() result
 * @returns {object} JSON-safe snapshot
 */
function buildSettingsSnapshot(settings) {
  const rules =
    typeof settings?.gork_extra_rules === "string" &&
    settings.gork_extra_rules.trim()
      ? settings.gork_extra_rules
      : null;
  return {
    gork_keyword: settings?.gork_keyword ?? null,
    gork_context_window: settings?.gork_context_window ?? null,
    gork_cooldown_sec: settings?.gork_cooldown_sec ?? null,
    gork_search_enabled: settings?.gork_search_enabled ?? null,
    gork_memory_enabled: settings?.gork_memory_enabled ?? null,
    gork_extra_rules: rules,
    gork_interaction_log_enabled:
      Number(settings?.gork_interaction_log_enabled ?? 1) === 1 ? 1 : 0,
  };
}

/**
 * Deep copy of `value` capping every string at `cap` chars — tool outputs and
 * wire message contents can be arbitrarily large and the DB rows must stay
 * bounded. Pure; arrays/objects are rebuilt (never mutated).
 *
 * @param {unknown} value
 * @param {number} [cap]
 * @returns {unknown}
 */
function capStrings(value, cap = EVENT_STRING_CAP) {
  if (typeof value === "string") {
    return value.length > cap
      ? `${value.slice(0, cap)}${STRING_CAP_MARKER}`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => capStrings(item, cap));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = capStrings(item, cap);
    }
    return out;
  }
  return value ?? null;
}

/** JSON.stringify that never throws and never returns undefined. */
function safeStringify(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * One recorder per agent call. Every knob is injectable for tests: `repo`
 * (default: the src/db facade, required LAZILY at finalize so this module
 * loads before any DB exists), `retentionDays` / `maxJsonChars` (default:
 * interactionLogConfig()), `uid` (default crypto.randomUUID()) and `now`.
 *
 * @param {object} opts
 * @param {string} [opts.kind] 'qa' | 'memory_turn'
 * @param {string|null} [opts.parentUid] memory_turn → qa uid link
 * @param {object|null} [opts.params] sampling params as sent (JSON column)
 * @param {object[]|null} [opts.tools] tool schemas as sent (JSON column)
 * @param {object|null} [opts.settings] buildSettingsSnapshot() result
 * @param {string|null} [opts.system] exact system prompt as sent
 * @param {string|null} [opts.user] exact composed user content as sent
 * @param {number|null} [opts.startedAt] job start epoch-ms (duration base)
 * @param {{ insertGorkInteraction: Function }} [opts.repo] db-facade override
 * @param {number} [opts.retentionDays] prune window handed to the repo
 * @param {number} [opts.maxJsonChars] transcript JSON budget
 * @returns {{ uid: string, onEvent: (evt: object) => void, finalize: (outcome: object) => {ok:boolean} }}
 */
function createInteractionRecorder(opts = {}) {
  const {
    kind = "qa",
    guildId = null,
    channelId = null,
    messageId = null,
    userId = null,
    parentUid = null,
    question = null,
    triggerContent = null,
    replyToMessageId = null,
    model = null,
    params = null,
    tools = null,
    settings = null,
    system = null,
    user = null,
    contextMeta = null,
    contextMessages = null,
    rosterMeta = null,
    rosterBlock = null,
    rosterEntries = null,
    memoryMeta = null,
    startedAt = null,
    repo,
    retentionDays,
    maxJsonChars,
    now = Date.now,
    uid = crypto.randomUUID(),
  } = opts;

  const config = interactionLogConfig();
  const retention = retentionDays ?? config.retentionDays;
  const jsonCap = Number.isFinite(Number(maxJsonChars))
    ? Math.max(2, Math.floor(Number(maxJsonChars)))
    : config.maxJsonChars;

  let events = [];
  let overflowed = false;
  let settled = false;
  let lastResult = null;

  /**
   * Capture sink for the src/core/ai.js seam. Each event is snapshotted
   * immediately (JSON round-trip over `capStrings`) so later mutation of the
   * growing conversation can never rewrite history; exceeding MAX_EVENTS
   * drops the OLDEST events and flags `truncated`. Never throws.
   */
  function onEvent(evt) {
    try {
      let snap;
      try {
        snap = JSON.parse(JSON.stringify(capStrings(evt)));
      } catch {
        // Circular/unserializable garbage: keep the slot, mark it degraded.
        snap = { type: String(evt?.type ?? "unknown"), capture_failed: true };
      }
      events.push(snap);
      while (events.length > MAX_EVENTS) {
        events.shift();
        overflowed = true;
      }
    } catch (err) {
      console.warn(
        "[gork] interaction log event capture failed:",
        err?.message || err,
      );
    }
  }

  /** Transcript JSON under the char budget: drop oldest events first. */
  function buildTranscriptJson() {
    let kept = events;
    let trunc = overflowed;
    let json = safeStringify({ events: kept, truncated: trunc });
    while ((json === null || json.length > jsonCap) && kept.length > 0) {
      kept = kept.slice(1);
      trunc = true;
      json = safeStringify({ events: kept, truncated: trunc });
    }
    return json ?? '{"events":[],"truncated":true}';
  }

  /**
   * Insert the row. Idempotent — only the FIRST finalize writes; later calls
   * return the first result. NEVER throws: a broken repo degrades to a warn
   * + {ok:false,error} (the repo logs its own failures already).
   *
   * @param {object} [outcome] {status, answerRaw, answerShipped, finishReason,
   *   usage, toolCallCount, durationMs, error}
   * @returns {{ok:true,id:number}|{ok:false,error:string}}
   */
  function finalize(outcome = {}) {
    if (settled) return lastResult;
    settled = true;
    try {
      const row = {
        uid,
        kind,
        parent_uid: parentUid ?? null,
        guild_id: guildId ?? null,
        channel_id: channelId ?? null,
        message_id: messageId ?? null,
        user_id: userId ?? null,
        status: String(outcome.status || "error"),
        started_at: startedAt ?? now(),
        duration_ms: outcome.durationMs ?? null,
        model: model ?? null,
        params: safeStringify(params),
        tools: safeStringify(tools),
        settings: safeStringify(settings),
        system_prompt: system ?? null,
        user_prompt: user ?? null,
        trigger_content: triggerContent ?? null,
        reply_to_message_id: replyToMessageId ?? null,
        context_meta: safeStringify(contextMeta),
        context_messages: safeStringify(contextMessages),
        roster_meta: safeStringify(rosterMeta),
        roster_block: rosterBlock ?? null,
        roster_entries: safeStringify(rosterEntries),
        memory_meta: safeStringify(memoryMeta),
        transcript: buildTranscriptJson(),
        answer_raw: outcome.answerRaw ?? null,
        answer_shipped: outcome.answerShipped ?? null,
        finish_reason: outcome.finishReason ?? null,
        usage: safeStringify(outcome.usage),
        tool_call_count: Number.isFinite(Number(outcome.toolCallCount))
          ? Math.trunc(Number(outcome.toolCallCount))
          : 0,
        error: outcome.error ?? null,
        created_at: now(),
      };
      const store = repo || require("../../db");
      lastResult = store.insertGorkInteraction(row, { retentionDays: retention });
      return lastResult;
    } catch (err) {
      // Ids ride along (AGENTS.md: enough to reproduce from logs alone).
      console.warn(
        "[gork] interaction log finalize failed:",
        err?.message || err,
        `(uid=${uid} guild=${guildId ?? "none"} message=${messageId ?? "none"})`,
      );
      lastResult = { ok: false, error: err?.message || String(err) };
      return lastResult;
    }
  }

  return { uid, onEvent, finalize };
}

module.exports = {
  ENV_KEYS,
  MAX_EVENTS,
  EVENT_STRING_CAP,
  STRING_CAP_MARKER,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_JSON_CHARS,
  interactionLogConfig,
  isInteractionLogEnabled,
  buildSettingsSnapshot,
  capStrings,
  createInteractionRecorder,
};
