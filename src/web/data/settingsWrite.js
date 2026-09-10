/**
 * Settings WRITE service layer for POST /g/:guildId/settings/* (Phase 2,
 * subtask 24, roadmap/web-admin.md §8.6 "Settings: per-setting tier" +
 * §8.1-6 "web mutations call the service layer, not SQL").
 *
 * THE RULE: every mutation here calls the SAME src/db facade helpers the
 * slash handlers call — updateGuildSettings (src/features/xp, /decay, /logs,
 * /warnings), addAllowedCommandChannel / removeAllowedCommandChannel
 * (src/features/commandChannels) — with the SAME validation bounds the
 * slash commands enforce (SlashCommandBuilder min/max + handler clamps):
 *   /setxp   → ints ≥ 0, ≤ MAX_XP_AWARD (validateXpValue);
 *              factor 1..10000; cooldowns ≥ 0 (Discord integer ceiling).
 *   /setdecay→ enabled on/off; messages ≥ 0; days ≥ 1; percent 0..95
 *              stored as a fraction clamped 0..0.95.
 *   /setlog  → audit|message stream, channel XOR clear (snowflake id).
 *   /setwarn log → warn_log_channel_id, channel XOR clear.
 *   /setcommandchannel add|remove → snowflake channel id (ADMIN-gated in
 *              the route layer; this module never gates tiers — routes do).
 *
 * Validation happens BEFORE any DB call: a rejected payload issues ZERO
 * facade calls (tests spy the module object to prove it — "validation
 * rejection writes NOTHING"). Accepted payloads call the facade helper
 * EXACTLY ONCE (point ops; the 10k-row budget is inherent — a PK UPDATE /
 * one INSERT OR IGNORE / one DELETE).
 *
 * Design mirrors data/settingsData.js: pure factory-style DI — the `db`
 * facade is a parameter and methods are looked up AT CALL TIME on the object
 * the caller passes (routes pass the shared module object, so test spies
 * installed on require("src/db") are what actually run).
 */

const { validateXpValue, MAX_XP_AWARD } = require("../../core/xpMath");

/** Same snowflake gate the web layer uses everywhere (users/leaderboard). */
const { STRICT_SNOWFLAKE_RE: CHANNEL_ID_RE } = require("../shared/snowflake");

/** Discord integer-option ceiling (2^53−1): no int mutation exceeds it. */
const INT_MAX = Number.MAX_SAFE_INTEGER;

/** /setxp integer bounds mirrored from the SlashCommandBuilder. */
const XP_VALUE_MAX = MAX_XP_AWARD; // 1e9, via validateXpValue
const LEVEL_FACTOR_MIN = 1;
const LEVEL_FACTOR_MAX = 10000;

/** /setdecay bounds mirrored from SlashCommandBuilder + handler clamps. */
const DECAY_PERCENT_MIN = 0;
const DECAY_PERCENT_MAX = 95; // slash stores fraction = percent / 100
const DECAY_FRACTION_MAX = 0.95;

/** /setlog streams → the guild_settings column each one owns. */
const LOG_STREAM_FIELDS = Object.freeze({
  audit: "audit_log_channel_id",
  message: "message_log_channel_id",
});
const WARN_LOG_FIELD = "warn_log_channel_id";

/** Fixed copy for the empty-patch cases (slash replies mirrored exactly). */
const NO_XP_FIELDS = "No XP settings provided to update.";
const NO_DECAY_FIELDS = "No decay settings provided to update.";
const NO_LOG_TARGET = "Provide a channel id, or clear the stream.";
const NO_CHANNEL = "Provide a channel id.";

const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const BOOL_OFF = new Set(["off", "false", "0", "disabled", "no"]);
const BOOL_ON = new Set(["on", "true", "1", "enabled", "yes"]);

/**
 * Read the urlencoded form fields the body-cap middleware drained
 * (req.bodyFields; never req.query — raw-URL doctrine of src/web/app.js).
 * @param {object} req
 * @returns {Record<string, string>}
 */
function readFormFields(req) {
  const raw = req && (req.bodyFields || req.body);
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * Parse one optional int field. "" / absent = NOT provided (slash option
 * omitted — the column is left alone, exactly like slash partial updates).
 * @param {Record<string, string>} fields
 * @param {string} name
 * @param {{ min?: number, max?: number, label: string }} bounds
 * @returns {{ provided: false } | { provided: true, value: number } | { provided: true, error: string }}
 */
function parseOptionalInt(fields, name, bounds) {
  const raw = (fields[name] ?? "").trim();
  if (raw === "") return { provided: false };
  if (!INT_RE.test(raw)) {
    return { provided: true, error: `${bounds.label} must be a whole number.` };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < (bounds.min ?? -INT_MAX) || value > (bounds.max ?? INT_MAX)) {
    const range =
      bounds.min != null && bounds.max != null
        ? `${bounds.min}–${bounds.max}`
        : bounds.min != null
          ? `≥ ${bounds.min}`
          : `≤ ${bounds.max}`;
    return { provided: true, error: `${bounds.label} must be a whole number ${range}.` };
  }
  return { provided: true, value };
}

/** Parse one optional float field (/setdecay percent accepts decimals). */
function parseOptionalNumber(fields, name, bounds) {
  const raw = (fields[name] ?? "").trim();
  if (raw === "") return { provided: false };
  if (!NUM_RE.test(raw)) {
    return { provided: true, error: `${bounds.label} must be a number.` };
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < (bounds.min ?? -Number.MAX_VALUE) ||
    value > (bounds.max ?? Number.MAX_VALUE)
  ) {
    return {
      provided: true,
      error: `${bounds.label} must be between ${bounds.min} and ${bounds.max}.`,
    };
  }
  return { provided: true, value };
}

/** Validate a channel id the way the web layer does everywhere: snowflake. */
function parseChannelId(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, error: NO_CHANNEL };
  if (!CHANNEL_ID_RE.test(text)) {
    return { ok: false, error: "Channel id must be a numeric Discord channel id." };
  }
  return { ok: true, channelId: text };
}

/**
 * Build the /setxp patch from form fields — SAME columns, SAME bounds the
 * handleSetXp slash handler produces (msg_xp, reaction_xp, voice_xp_per_min,
 * msg_cooldown_sec, reaction_cooldown_sec, level_xp_factor).
 * @param {Record<string, string>} fields
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
function buildXpPatch(fields) {
  const xpSpecs = [
    ["message", "msg_xp", "Message"],
    ["reaction", "reaction_xp", "Reaction"],
    ["voice", "voice_xp_per_min", "Voice"],
  ];
  const cooldownSpecs = [
    ["msgcooldown", "msg_cooldown_sec", "Message cooldown"],
    ["reactioncooldown", "reaction_cooldown_sec", "Reaction cooldown"],
  ];

  const patch = {};
  const errors = [];

  for (const [field, column, label] of xpSpecs) {
    const parsed = parseOptionalInt(fields, field, { min: 0, max: INT_MAX, label });
    if (!parsed.provided) continue;
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    // Slash calls core/xpMath.validateXpValue on exactly these three.
    const xpError = validateXpValue(parsed.value, label);
    if (xpError) {
      errors.push(xpError);
      continue;
    }
    patch[column] = parsed.value;
  }

  for (const [field, column, label] of cooldownSpecs) {
    const parsed = parseOptionalInt(fields, field, { min: 0, max: INT_MAX, label });
    if (!parsed.provided) continue;
    if (parsed.error) {
      errors.push(parsed.error);
      continue;
    }
    patch[column] = parsed.value;
  }

  const factor = parseOptionalInt(fields, "factor", {
    min: LEVEL_FACTOR_MIN,
    max: LEVEL_FACTOR_MAX,
    label: "Level curve factor",
  });
  if (factor.provided) {
    if (factor.error) errors.push(factor.error);
    else patch.level_xp_factor = factor.value;
  }

  if (errors.length) return { ok: false, error: errors.join(" ") };
  if (!Object.keys(patch).length) return { ok: false, error: NO_XP_FIELDS };
  return { ok: true, patch };
}

/**
 * Build the /setdecay patch — same columns + clamps as handleSetDecay
 * (decay_enabled 0/1, decay_min_messages ≥0, decay_window_days ≥1,
 * decay_percent stored as a 0..0.95 fraction from a 0..95 percent input).
 * @param {Record<string, string>} fields
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
function buildDecayPatch(fields) {
  const patch = {};
  const errors = [];

  const enabled = (fields.enabled ?? "").trim().toLowerCase();
  if (enabled !== "") {
    if (BOOL_ON.has(enabled)) patch.decay_enabled = 1;
    else if (BOOL_OFF.has(enabled)) patch.decay_enabled = 0;
    else errors.push("Decay enabled must be on or off.");
  }

  const messages = parseOptionalInt(fields, "messages", { min: 0, max: INT_MAX, label: "Decay threshold messages" });
  if (messages.provided) {
    if (messages.error) errors.push(messages.error);
    else patch.decay_min_messages = Math.max(0, messages.value); // slash clamp
  }

  const days = parseOptionalInt(fields, "days", { min: 1, max: INT_MAX, label: "Decay window days" });
  if (days.provided) {
    if (days.error) errors.push(days.error);
    else patch.decay_window_days = Math.max(1, days.value); // slash clamp
  }

  const percent = parseOptionalNumber(fields, "percent", {
    min: DECAY_PERCENT_MIN,
    max: DECAY_PERCENT_MAX,
    label: "Decay percent",
  });
  if (percent.provided) {
    if (percent.error) errors.push(percent.error);
    else patch.decay_percent = Math.min(DECAY_FRACTION_MAX, Math.max(0, percent.value / 100));
  }

  if (errors.length) return { ok: false, error: errors.join(" ") };
  if (!Object.keys(patch).length) return { ok: false, error: NO_DECAY_FIELDS };
  return { ok: true, patch };
}

/**
 * Validate the /setlog payload: stream + (channel XOR clear). Slash takes a
 * channel picker; the web form supplies the id, so the snowflake gate here
 * is the strictest equivalent that works without a Discord lookup.
 * @returns {{ ok: true, stream: string, field: string, channelId: string|null }}
 */
function parseLogStreamTarget(fields, streamNames = LOG_STREAM_FIELDS) {
  const stream = (fields.stream ?? "").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(streamNames, stream)) {
    return { ok: false, error: "Unknown log stream." };
  }
  const clear = (fields.clear ?? "").trim() !== "";
  const channelRaw = (fields.channel ?? "").trim();
  if (clear && channelRaw !== "") {
    return { ok: false, error: "Provide a channel id OR clear the stream — not both." };
  }
  if (clear) return { ok: true, stream, field: streamNames[stream], channelId: null };
  if (channelRaw === "") return { ok: false, error: NO_LOG_TARGET };
  const parsed = parseChannelId(channelRaw);
  if (!parsed.ok) return parsed;
  return { ok: true, stream, field: streamNames[stream], channelId: parsed.channelId };
}

// ---------------------------------------------------------------------------
// Service ops — validate first, then the ONE facade call the slash handler
// would make. `db` is the src/db facade object (methods bound at call time).
// ---------------------------------------------------------------------------

/**
 * /setxp equivalent: updateGuildSettings(guildId, patch) — the exact call
 * handleSetXp makes after validation.
 * @param {object} db src/db facade
 */
function saveXpSettings(db, guildId, fields) {
  const built = buildXpPatch(fields);
  if (!built.ok) return built;
  const before = db.getGuildSettings(guildId);
  const after = db.updateGuildSettings(guildId, built.patch);
  return { ok: true, patch: built.patch, before, after };
}

/** /setdecay equivalent (same helper + stored shape as handleSetDecay). */
function saveDecaySettings(db, guildId, fields) {
  const built = buildDecayPatch(fields);
  if (!built.ok) return built;
  const before = db.getGuildSettings(guildId);
  const after = db.updateGuildSettings(guildId, built.patch);
  return { ok: true, patch: built.patch, before, after };
}

/**
 * /setlog audit|message equivalent: updateGuildSettings with the stream's
 * column set to the id — or null on clear (slash writes {[field]: null}).
 */
function saveLogChannel(db, guildId, fields) {
  const target = parseLogStreamTarget(fields);
  if (!target.ok) return target;
  const before = db.getGuildSettings(guildId);
  const previous = before[target.field] ?? null;
  const after = db.updateGuildSettings(guildId, { [target.field]: target.channelId });
  return { ok: true, stream: target.stream, field: target.field, channelId: target.channelId, previous, before, after };
}

/**
 * /setwarn log equivalent: warn_log_channel_id set/clear via
 * updateGuildSettings (exactly what the warnings handleSetLog does).
 */
function saveWarnLogChannel(db, guildId, fields) {
  const clear = (fields.clear ?? "").trim() !== "";
  const channelRaw = (fields.channel ?? "").trim();
  if (clear && channelRaw !== "") {
    return { ok: false, error: "Provide a channel id OR clear the channel — not both." };
  }
  if (!clear && channelRaw === "") {
    return { ok: false, error: "Provide a channel id, or clear the warning log." };
  }
  let channelId = null;
  if (!clear) {
    const parsed = parseChannelId(channelRaw);
    if (!parsed.ok) return parsed;
    channelId = parsed.channelId;
  }
  const before = db.getGuildSettings(guildId);
  const previous = before[WARN_LOG_FIELD] ?? null;
  const after = db.updateGuildSettings(guildId, { [WARN_LOG_FIELD]: channelId });
  return { ok: true, field: WARN_LOG_FIELD, channelId, previous, before, after };
}

/**
 * /setcommandchannel add equivalent: addAllowedCommandChannel (INSERT OR
 * IGNORE — idempotent like slash re-add). Tier gate (ADMIN) lives in the
 * route; this op assumes it passed.
 */
function addCommandChannel(db, guildId, fields) {
  const parsed = parseChannelId(fields.channel);
  if (!parsed.ok) return parsed;
  db.addAllowedCommandChannel(guildId, parsed.channelId);
  return { ok: true, channelId: parsed.channelId };
}

/** /setcommandchannel remove equivalent: removeAllowedCommandChannel. */
function removeCommandChannel(db, guildId, fields) {
  const parsed = parseChannelId(fields.channel);
  if (!parsed.ok) return parsed;
  db.removeAllowedCommandChannel(guildId, parsed.channelId);
  return { ok: true, channelId: parsed.channelId };
}

module.exports = {
  CHANNEL_ID_RE,
  LOG_STREAM_FIELDS,
  WARN_LOG_FIELD,
  LEVEL_FACTOR_MIN,
  LEVEL_FACTOR_MAX,
  DECAY_PERCENT_MAX,
  readFormFields,
  parseOptionalInt,
  parseChannelId,
  buildXpPatch,
  buildDecayPatch,
  parseLogStreamTarget,
  saveXpSettings,
  saveDecaySettings,
  saveLogChannel,
  saveWarnLogChannel,
  addCommandChannel,
  removeCommandChannel,
};
