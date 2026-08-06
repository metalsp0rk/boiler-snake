const { db, now } = require("../connection");
const { MAX_XP_AWARD } = require("../../core/constants");

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
      ticket_category_id: null,
      ticket_archive_channel_id: null,
      ticket_rate_limit_minutes: 60,
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
    "ticket_category_id",
    "ticket_archive_channel_id",
    "ticket_rate_limit_minutes",
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

  const sets = keys.map((k) => `${k}=@${k}`).join(", ");
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
