/**
 * Create core tables if missing. Safe to re-run (IF NOT EXISTS).
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  xp       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL, -- message|reaction|voice_minute
  amount   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_recent
ON activity_log (guild_id, user_id, kind, created_at);

-- Helps range scans on time windows (e.g., decay checks, pruning).
CREATE INDEX IF NOT EXISTS idx_activity_created_at
ON activity_log (created_at);

-- Kept for compatibility / future features
CREATE TABLE IF NOT EXISTS voice_sessions (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

-- Per-guild settings (one row per guild)
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,

  msg_xp INTEGER NOT NULL DEFAULT 5,
  voice_xp_per_min INTEGER NOT NULL DEFAULT 1,
  msg_cooldown_sec INTEGER NOT NULL DEFAULT 20,

  decay_enabled INTEGER NOT NULL DEFAULT 1,
  decay_window_days INTEGER NOT NULL DEFAULT 7,
  decay_min_messages INTEGER NOT NULL DEFAULT 20,
  decay_percent REAL NOT NULL DEFAULT 0.10,

  level_xp_factor INTEGER NOT NULL DEFAULT 100,

  youtube_notification_channel_id TEXT,
  youtube_polling_interval_minutes INTEGER NOT NULL DEFAULT 5,
  youtube_upload_role_id TEXT,

  updated_at INTEGER NOT NULL
);

-- Level -> role mapping, plus drop grace days
CREATE TABLE IF NOT EXISTS level_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  level_required INTEGER NOT NULL,
  drop_grace_days INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

-- Tracks when user first fell below a role's required level
CREATE TABLE IF NOT EXISTS role_drop_state (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER, -- ms epoch, NULL when not below
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, role_id)
);

-- Allowed command channels per guild (if empty => commands allowed everywhere)
CREATE TABLE IF NOT EXISTS allowed_command_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

-- YouTube channel subscriptions (composite PK: same YT channel across guilds)
CREATE TABLE IF NOT EXISTS youtube_channels (
  guild_id TEXT NOT NULL,
  id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_url TEXT NOT NULL,
  thumbnail_url TEXT,
  last_video_id TEXT,
  last_checked INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, id),
  UNIQUE(guild_id, channel_name)
);

-- Honeypot channels: anyone who posts is banned (unless exempt)
CREATE TABLE IF NOT EXISTS honeypot_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  warning_message_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

-- Guild staff roles (admin gate + honeypot exemption). Legacy name was
-- honeypot_exempt_roles; migration 008 renames existing DBs.
CREATE TABLE IF NOT EXISTS staff_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

-- Ban roles: anyone who receives one of these roles is banned (unless exempt)
CREATE TABLE IF NOT EXISTS honeypot_ban_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

-- Bot-owned reaction role panel messages
CREATE TABLE IF NOT EXISTS reaction_role_panels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Reaction Roles',
  description TEXT NOT NULL DEFAULT 'React to get a role. Remove your reaction to drop it (if allowed).',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id)
);

-- Emoji → role options on a reaction role panel
CREATE TABLE IF NOT EXISTS reaction_role_options (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji_key TEXT NOT NULL,
  emoji_display TEXT NOT NULL,
  role_id TEXT NOT NULL,
  min_level INTEGER NOT NULL DEFAULT 0,
  removable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id, emoji_key)
);
`);
}

module.exports = { id: "001_base_schema", up };
