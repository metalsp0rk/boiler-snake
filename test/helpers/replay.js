/**
 * Gork replay harness (Phase C): drive the FULL pipeline from a logged
 * interaction fixture (scripts/export-gork-log.js shape v1) with a scripted
 * fetch, so a recorded real-world Q&A becomes a deterministic E2E regression
 * test. Mirrors the proven fake patterns of test/integration/gork.test.js
 * (save/restore env around the AI keys, an in-order scripted mockFetch,
 * makeGorkMessage, `whenGorkIdleForTests()` settle) — without editing it.
 *
 * What a replay does:
 *  - arms the AI env (fake key, default params, interaction log ON),
 *  - applies `fixture.settings` through updateGuildSettings (allow-list
 *    keys only — anything else would throw; cooldown is FORCED to 0),
 *  - serves `fixture.contextMessages` from `channel.messages.fetch`
 *    (newest→oldest, before/limit respected minimally: the fixture's
 *    context is returned as-collected for the recorded trigger),
 *  - attaches `fetchReference()` → the recorded reply-target (only when the
 *    fixture names one),
 *  - serves scripted provider turns — the fixture's own recorded
 *    `transcript` response bodies by default (the exact wire answers
 *    re-sent), overridable with `opts.chatResponses`; a turn whose chat
 *    answer calls a tool executes the REAL tool (web_search/read_page
 *    against a graceful `{}` non-chat body; the in-process
 *    recall_memories DB tool works),
 *  - emits the trigger with a per-run-unique author/guild identity,
 *  - awaits `whenGorkIdleForTests()` and returns the interaction rows
 *    written by THIS replay plus the visible reply content.
 *
 * v1 limitations (deliberate, see docs/gork-logging.md):
 *  - `fixture.memory.turns` (multi-turn conversation seeds) and
 *    `fixture.memory.memoryTurns` are NOT replayed yet;
 *  - fixtures whose replay needs NETWORK tools (web_search/read_page with a
 *    recorded tool round) replay with the graceful-empty tool bodies, so
 *    only round COUNT/params are asserted, not the answer bytes.
 */

const assert = require("node:assert/strict");
const fs = require("fs");

const AI_ENV_KEYS = Object.freeze([
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_SMALL_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "SEARXNG_URL",
  "GORK_LLM_MAX_TOKENS",
  "GORK_LLM_TIMEOUT_MS",
  "GORK_LLM_MAX_TOOL_ROUNDS",
  "GORK_LLM_THINKING_TOKEN_BUDGET",
  "GORK_MAX_ANSWER_CHARS",
]);

const IL_ENV_KEYS = Object.freeze([
  "GORK_INTERACTION_LOG",
  "GORK_INTERACTION_LOG_RETENTION_DAYS",
  "GORK_INTERACTION_LOG_MAX_JSON_CHARS",
]);

// Mirrors the updateGuildSettings allow-list in
// src/db/repositories/guildSettings.js (the keys a fixture may carry).
const SETTINGS_KEYS = new Set([
  "gork_enabled",
  "gork_keyword",
  "gork_context_window",
  "gork_cooldown_sec",
  "audit_log_channel_id",
  "gork_search_enabled",
  "gork_search_max_results",
  "gork_read_page_max_chars",
  "gork_extra_rules",
  "gork_memory_enabled",
  "gork_memory_chars",
  "gork_budget_default",
  "gork_budget_users",
  "gork_budget_channels",
  "gork_budget_categories",
  "gork_budget_threads",
  "gork_budget_guild",
  "gork_interaction_log_enabled",
]);

/** Read a fixture JSON file (v1). */
function loadFixture(file) {
  const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(fixture.v, 1, `unsupported fixture version in ${file}`);
  return fixture;
}

function saveEnv() {
  const saved = {};
  for (const key of [...AI_ENV_KEYS, ...IL_ENV_KEYS]) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
  }
  return saved;
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Deterministic AI env: fake key, default model/params, interaction log ON. */
function armEnv() {
  for (const key of [...AI_ENV_KEYS, ...IL_ENV_KEYS]) delete process.env[key];
  process.env.OPENAI_API_KEY = "replay-test-key";
  process.env.GORK_INTERACTION_LOG = "1";
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/**
 * Script the global fetch: `turns` is a flat list of one-shot responses
 * ({ urlIncludes? | urlMatch?, body, status? } — the first unconsumed turn
 * whose urlIncludes matches the URL is served; `urlMatch` is a predicate
 * `(url) => boolean` for turn classes a substring can't express (e.g. "any
 * NON-chat URL"); default body `{}` for tools). Unexpected calls THROW with
 * the pending turn shape (loud, never silent).
 */
function scriptFetch(turns) {
  const realFetch = globalThis.fetch;
  const calls = [];
  const pending = turns.map((t) => ({ ...t, used: false }));
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, body: init?.body ? String(init.body) : null });
    const turn = pending.find(
      (t) =>
        !t.used &&
        (typeof t.urlMatch === "function"
          ? Boolean(t.urlMatch(urlStr))
          : t.urlIncludes == null || urlStr.includes(t.urlIncludes)),
    );
    if (!turn) {
      throw new Error(
        `replay fetch: unexpected call to ${urlStr} (pending: ` +
          `${JSON.stringify(
            pending
              .filter((t) => !t.used)
              .map((t) => t.urlIncludes ?? (t.urlMatch ? "urlMatch" : "*")),
          )})`,
      );
    }
    turn.used = true;
    return jsonResponse(turn.body ?? {}, turn.status ?? 200);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

/**
 * Fake channel serving `history` (fixture.contextMessages, oldest→newest)
 * via `messages.fetch` with the harness newest→oldest + lexicographic
 * `before` contract. Returns an EMPTY set (never null) for unknown/trigger
 * ids — matches the harness and keeps the trigger's reference chain-walk
 * from pulling in messages the fixture never recorded.
 */
function createFixtureChannel(history, opts = {}) {
  const rosterById = new Map(
    (opts.rosterEntries || []).map((e) => [String(e.id), e]),
  );
  const messages = history.map((m, i) => {
    const entry = rosterById.get(String(m.authorId ?? ""));
    const author = {
      id: String(m.authorId ?? "fixture-h-author"),
      username: entry?.handle || `hist${i}`,
      bot: false,
    };
    const member = entry
      ? {
          id: author.id,
          guild: opts.guild || null /* channel.guild */,
          user: { id: author.id, username: author.username, bot: false },
          permissions: { has: () => false },
          roles: { cache: new Map(), add: async () => {}, remove: async () => {} },
        }
      : undefined;
    return {
      id: String(m.id ?? `fixture-h-${i}`),
      content: String(m.content ?? ""),
      author,
      member,
      createdTimestamp: Number.isFinite(m.timestamp) ? m.timestamp : undefined,
    };
  });
  const byId = new Map(messages.map((m) => [m.id, m]));
  return {
    id: opts.id || `fixture-ch-${messages.length}`,
    name: opts.name || "general",
    type: 0,
    guild: null,
    isTextBased: () => true,
    members: { fetch: async (id) => (id ? byId.get(String(id)) || null : new Map()) },
    sendTyping: async () => {},
    send: async (payload) => ({
      id: `fixture-sent-${messages.length}`,
      content: typeof payload === "string" ? payload : payload?.content,
    }),
    messages: {
      fetch: async (arg) => {
        if (typeof arg === "string") {
          const hit = byId.get(arg);
          return hit ?? { id: arg, content: "", author: { id: "unknown", bot: false } };
        }
        const limit = arg?.limit ?? 100;
        let all = [...messages].sort((a, b) =>
          String(b.id).localeCompare(String(a.id)),
        );
        if (arg?.before) {
          all = all.filter((m) => String(m.id) < String(arg.before));
        }
        return new Map(all.slice(0, limit).map((m) => [m.id, m]));
      },
    },
  };
}

/** Fake guild member with the discord.js-ish fields buildRoster/formatUserLabel read. */
function createFixtureMember(entry, opts = {}) {
  const user = {
    id: String(entry.id),
    username: entry.handle || `user${String(entry.id).slice(-4)}`,
    discriminator: "0000",
    globalName: entry.display || null,
    displayName: entry.display || entry.handle || `user${String(entry.id).slice(-4)}`,
    tag: `${entry.handle || "user"}#0000`,
    bot: false,
    system: false,
    toString: () => `<@${String(entry.id)}>`,
  };
  return {
    id: user.id,
    user,
    // discord.js Message#author IS the member's user — keep them identical
    author: user,
    guild: opts.guild || null,
    displayName: entry.display || user.displayName,
    nickname: entry.nickname ?? null,
    permissions: { has: () => false },
    roles: { cache: new Map(), add: async () => {}, remove: async () => {} },
    toString: () => `<@${String(entry.id)}>`,
  };
}

/**
 * Replay one recorded interaction against a fresh integration env's
 * pipeline. The caller owns `env` (createIntegrationEnv) and cleanup.
 *
 * @param {object} env integration env (from createIntegrationEnv)
 * @param {object} fixture v1 fixture (loadFixture or buildFixture output)
 * @param {{ chatResponses?: object[], extraTurns?: object[], userId?: string,
 *   messageId?: string, guildId?: string }} [opts]
 *   chatResponses overrides the fixture's own recorded responses.
 * @returns {Promise<{ rows: object[], replyContent: string|null,
 *   calls: Array<{url:string,body:string|null}> }>}
 */
async function replayInteraction(env, fixture, opts = {}) {
  const settings = fixture.settings || {};
  assert.ok(
    Object.keys(settings).every((k) => SETTINGS_KEYS.has(k)),
    `fixture settings contain keys outside the allow-list: ${Object.keys(
      settings,
    ).filter((k) => !SETTINGS_KEYS.has(k)).join(", ")}`,
  );

  const saved = saveEnv();
  // The fixture settings are applied to the env's OWN guild row; the replay
  // identity is fresh per run (unique guild+user → the module-level
  // per-guild cooldown map is empty for it → no sleep, no interference).
    // Default identities come from the fixture itself (recorded ids) so the
    // prompt context renders identically to the recording. Callers pass a
    // UNIQUE guild/user per replay to dodge the module-level per-guild
    // cooldown map — settings force gork_cooldown_sec=0, so repeats of the
    // same recorded guild are still safe in-process.
    const guildId = opts.guildId || String(fixture.trigger.guildId || "replay-g");
    env.db.updateGuildSettings(guildId, {
    ...Object.fromEntries(
      Object.entries(settings).filter(([k]) => k !== "gork_cooldown_sec"),
    ),
    gork_cooldown_sec: 0, // replay determinism (the trigger is a fresh identity anyway)
    gork_interaction_log_enabled: 1, // the replay IS the test fixture
  });
  // Keep the env's own guild settings untouched for other flows; the
  // trigger reads settings for message.guild.id — so drive a message ON
  // that guild by rewriting env.guild.id (integration guilds are fakes).
  env.guild.id = guildId;

  armEnv();

  // ---- scripted provider turns ----
  const transcript = Array.isArray(fixture.expect?.transcript)
    ? fixture.expect.transcript
    : [];
  const recordedResponses = transcript
    .filter((e) => e && e.type === "response" && e.data)
    .map((e) => ({ urlIncludes: "chat/completions", body: e.data }));
  const chatBodies = opts.chatResponses
    ? opts.chatResponses.map((b) => ({ urlIncludes: "chat/completions", body: b }))
    : recordedResponses;
  const toolRounds = Number(fixture.expect?.toolCallCount) || 0;
  const turns = [
    ...chatBodies,
    ...(opts.extraTurns || []),
    // Graceful bodies for NETWORK tools the model may invoke in replay
    // (web_search → {entries:[]} degrade; read_page → non-HTML degrade).
    ...Array.from({ length: toolRounds * 2 }, () => ({
      urlIncludes: "searxng",
      body: { entries: [] },
    })),
    // Filler matches NON-chat URLs only: a substring like "http" would also
    // match /chat/completions, so an unexpected extra chat call would
    // silently consume filler instead of tripping the loud guard above.
    ...Array.from({ length: toolRounds * 2 }, () => ({
      urlMatch: (u) => !u.includes("chat/completions"),
      body: {},
    })),
  ];
  const fetchMock = scriptFetch(turns);

  try {
    // Seed the roster identities the recording resolved: replayed
    // context/roster lines must resolve to the SAME labels (resolveName →
    // roster entries built from these member stubs). Entries the recording
    // could NOT resolve (no handle/display) stay unseeded — degrading to
    // "(unresolved)" exactly like at record time.
    for (const entry of fixture.rosterEntries || []) {
      if (entry?.id && (entry.handle || entry.display)) {
        env.guild.addMember(createFixtureMember(entry, { guild: env.guild }));
      }
    }

    // The replied-to message was fetched via `fetchReference` at record time
    // — it was NEVER part of the channel history the walk's backfill reads.
    // Mirror that here or the chain walk would collect it twice. The trigger
    // message itself is likewise never part of its own context history.
    const history = (fixture.contextMessages || []).filter(
      (m) =>
        String(m.id) !== String(fixture.trigger.replyToMessageId ?? "") &&
        String(m.id) !== String(fixture.trigger.messageId ?? ""),
    );
    const channel = createFixtureChannel(history, {
      id: fixture.trigger.channelId,
      // v1 exports can't carry the channel NAME (not stored in the log row);
      // fixtures that do carry one replay byte-exact, exports without it
      // replay with the harness name — see docs/gork-logging.md limitations.
      name: fixture.trigger.channelName || "general",
      rosterEntries: fixture.rosterEntries || [],
      guild: env.guild,
    });
    channel.guild = env.guild;

    // `let`: the unresolved-entry guard below reassigns it (a `const` here
    // would TypeError on real fixtures whose asker row carries neither
    // display nor handle).
    let askerEntry =
      (fixture.rosterEntries || []).find(
        (e) => String(e?.id) === String(fixture.trigger.userId),
      ) || {
        id: fixture.trigger.userId,
        display: "Asker",
        handle: "asker",
        nickname: null,
      };
    const asker = createFixtureMember(askerEntry, { guild: env.guild });
    const member = {
      ...asker,
      guild: env.guild,
      permissions: { has: () => false },
    };

    const replyTo = fixture.trigger.replyToMessageId
      ? String(fixture.trigger.replyToMessageId)
      : null;
    const replyTarget = replyTo
      ? {
          id: replyTo,
          content:
            (fixture.contextMessages || []).find((m) => String(m.id) === replyTo)
              ?.content ?? "",
          embeds: [],
          author: asker,
          createdTimestamp: Date.now() - 60000,
          channel,
        }
      : null;

    const triggerContent = String(fixture.trigger.content ?? "");
    // Roster entries the recording RESOLVED are seeded as guild members so
    // context/roster labels re-render identically; unresolved entries stay
    // unseeded (they degrade to the raw author username at record time).
    if (!askerEntry.handle && !askerEntry.display && askerEntry.id) {
      askerEntry = { ...askerEntry, handle: "repeater", display: "Repeater", nickname: null };
    }
    const messageId =
      opts.messageId || String(fixture.trigger.messageId || `replay-m-${Date.now()}`);
    const message = {
      id: messageId,
      content: triggerContent,
      guild: env.guild,
      guildId,
      channel,
      channelId: channel.id,
      author: asker,
      member,
      memberPermissions: member.permissions,
      reference: replyTo ? { messageId: replyTo } : null,
      // discord.js Message#referencedMessage: resolved reply target (null
      // when there is no reference). Kept consistent with `reference` so
      // both collection strategies (walk vs cache read) see the same thing.
      referencedMessage: replyTarget,
      fetchReference: async () => replyTarget,
      deletable: true,
      deleted: false,
      system: false,
      createdTimestamp: Date.now(),
      attachments: new Map(),
      embeds: [],
      reply: async (payload) => {
        const sent = await channel.send(payload);
        replies.push(sent);
        return sent;
      },
      react: async (emoji) => ({ emoji }),
      delete: async () => {
        message.deleted = true;
      },
    };
    const replies = [];

    await env.onMessageCreate(message);
    await require("../../src/features/gork/trigger").whenGorkIdleForTests();

    const listed = env.db.listGorkInteractions({ guildId, limit: 50 });
    const rows = listed
      .map((r) => env.db.getGorkInteractionByUid(r.uid))
      .filter(Boolean);
    const replyContent = replies.length
      ? String(replies[replies.length - 1].content ?? "")
      : null;
    return { rows, replyContent, calls: fetchMock.calls };
  } finally {
    restoreEnv(saved);
    fetchMock.restore();
  }
}

module.exports = {
  AI_ENV_KEYS,
  IL_ENV_KEYS,
  SETTINGS_KEYS,
  loadFixture,
  saveEnv,
  restoreEnv,
  armEnv,
  scriptFetch,
  jsonResponse,
  createFixtureChannel,
  createFixtureMember,
  replayInteraction,
};
