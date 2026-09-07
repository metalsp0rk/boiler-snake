const { db, now } = require("../connection");
const { MAX_XP_AWARD } = require("../../core/constants");

const GORK_DEFAULT_CONTEXT_WINDOW = 10;
const GORK_DEFAULT_COOLDOWN_SEC = 180;
const GORK_RULES_MAX_LEN = 500;
const GORK_KEYWORD_MAX_LEN = 50;

/** Clamp to an integer range; null/non-finite input falls back to the default. */
function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Truncate staff prompt rules at the 500-char cap. */
function truncateGorkRules(value) {
  const rules = value === null || value === undefined ? "" : String(value);
  return rules.slice(0, GORK_RULES_MAX_LEN);
}

/**
 * Normalize the gork trigger keyword.
 * - null / empty / whitespace-only -> null (gork disabled for the guild)
 * - 1-50 chars (trimmed) -> keyword to store
 * - over 50 chars -> undefined (rejected; prior value is kept)
 */
function normalizeGorkKeyword(value) {
  if (value === null || value === undefined) return null;
  const keyword = String(value).trim();
  if (!keyword) return null;
  if (keyword.length > GORK_KEYWORD_MAX_LEN) return undefined;
  return keyword;
}

/** Coerce the SearXNG tool toggle to a 0/1 integer. */
function normalizeGorkSearchEnabled(value) {
  if (value === false || value === 0 || value === "0" || value === "off") return 0;
  return 1;
}

/**
 * Ensure a settings row exists for a guild.
 * This also ensures defaults are present for all columns (including migrated ones).
 */
function ensureGuildSettings(guildId) {
  const t = now();
  db.prepare(`
  INSERT INTO guild_settings (guild_id, updated_at)
  VALUES (?, ?)
  ON CONFLICT(guild_id) DO UPDATE SET updated_at=excluded.updated_at
  `).run(guildId, t);
}

function getGuildSettings(guildId) {
  ensureGuildSettings(guildId);
  const row = db.prepare(`SELECT * FROM guild_settings WHERE guild_id=?`).get(guildId);

  if (!row) {
    return {
      guild_id: guildId,
      msg_xp: 5,
      reaction_xp: 2,
      voice_xp_per_min: 1,
      msg_cooldown_sec: 20,
      reaction_cooldown_sec: 10,
      decay_enabled: 1,
      decay_window_days: 7,
      decay_min_messages: 20,
      decay_percent: 0.1,
      level_xp_factor: 100,
      youtube_notification_channel_id: null,
      youtube_polling_interval_minutes: 5,
      youtube_upload_role_id: null,
      audit_log_channel_id: null,
      message_log_channel_id: null,
      event_reminder_channel_id: null,
      warn_dm_members: 1,
      warn_log_channel_id: null,
      warn_expiry_days: 0,
      ticket_category_id: null,
      ticket_archive_channel_id: null,
      ticket_rate_limit_minutes: 60,
      twitch_notification_channel_id: null,
      twitch_notify_role_id: null,
      twitch_polling_interval_minutes: 2,
      gork_keyword: "@gork",
      gork_context_window: 10,
      gork_extra_rules: "",
      gork_search_enabled: 1,
      gork_cooldown_sec: 180,
      updated_at: now(),
    };
  }
  return row;
}

function updateGuildSettings(guildId, patch) {
  ensureGuildSettings(guildId);

  const allowed = new Set([
    "msg_xp",
    "reaction_xp",
    "voice_xp_per_min",
    "msg_cooldown_sec",
    "reaction_cooldown_sec",
    "decay_enabled",
    "decay_window_days",
    "decay_min_messages",
    "decay_percent",
    "level_xp_factor",
    "youtube_notification_channel_id",
    "youtube_polling_interval_minutes",
    "youtube_upload_role_id",
    "audit_log_channel_id",
    "message_log_channel_id",
    "event_reminder_channel_id",
    "warn_dm_members",
    "warn_log_channel_id",
    "warn_expiry_days",
    "ticket_category_id",
    "ticket_archive_channel_id",
    "ticket_rate_limit_minutes",
    "twitch_notification_channel_id",
    "twitch_notify_role_id",
    "twitch_polling_interval_minutes",
    "gork_keyword",
    "gork_context_window",
    "gork_extra_rules",
    "gork_search_enabled",
    "gork_cooldown_sec",
  ]);

  const keys = Object.keys(patch).filter((k) => allowed.has(k));
  if (!keys.length) return getGuildSettings(guildId);

  const clampAward = (v) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(Math.floor(x), MAX_XP_AWARD));
  };

  const safePatch = { ...patch };
  if (safePatch.msg_xp !== undefined) safePatch.msg_xp = clampAward(safePatch.msg_xp);
  if (safePatch.reaction_xp !== undefined) {
    safePatch.reaction_xp = clampAward(safePatch.reaction_xp);
  }
  if (safePatch.voice_xp_per_min !== undefined) {
    safePatch.voice_xp_per_min = clampAward(safePatch.voice_xp_per_min);
  }
  if (safePatch.gork_context_window !== undefined) {
    safePatch.gork_context_window = clampInt(
      safePatch.gork_context_window,
      1,
      50,
      GORK_DEFAULT_CONTEXT_WINDOW
    );
  }
  if (safePatch.gork_cooldown_sec !== undefined) {
    safePatch.gork_cooldown_sec = clampInt(
      safePatch.gork_cooldown_sec,
      0,
      3600,
      GORK_DEFAULT_COOLDOWN_SEC
    );
  }
  if (safePatch.gork_extra_rules !== undefined) {
    safePatch.gork_extra_rules = truncateGorkRules(safePatch.gork_extra_rules);
  }
  if (safePatch.gork_keyword !== undefined) {
    safePatch.gork_keyword = normalizeGorkKeyword(safePatch.gork_keyword);
  }
  if (safePatch.gork_search_enabled !== undefined) {
    safePatch.gork_search_enabled = normalizeGorkSearchEnabled(safePatch.gork_search_enabled);
  }

  // A sanitized value of undefined means "rejected" (over-length keyword) —
  // skip that column so the prior value is kept.
  const finalKeys = keys.filter((k) => safePatch[k] !== undefined);
  if (!finalKeys.length) return getGuildSettings(guildId);

  const sets = finalKeys.map((k) => `${k}=@${k}`).join(", ");
  db.prepare(`
  UPDATE guild_settings
  SET ${sets}, updated_at=@updated_at
  WHERE guild_id=@guild_id
 `).run({ guild_id: guildId, updated_at: now(), ...safePatch });

  // Side effect retained for parity with pre-split db.js
  const { cleanupMalformedYoutubeChannels } = require("./youtube");
  cleanupMalformedYoutubeChannels();

  return getGuildSettings(guildId);
}

module.exports = {
  ensureGuildSettings,
  getGuildSettings,
  updateGuildSettings,
};
