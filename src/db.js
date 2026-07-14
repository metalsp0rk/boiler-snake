// src/db.js
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "xpbot.sqlite"));
db.pragma("journal_mode = WAL");

function now() {
  return Date.now();
}

// JS-safe XP cap (prevents Infinity/precision loss in Node)
const MAX_SAFE_XP = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991

/**
 * Clamp any value to a safe finite integer delta (can be negative).
 * - Non-finite -> 0
 * - Too large magnitude -> +/- MAX_SAFE_XP
 * - Coerces to integer
 */
function clampDelta(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x === 0) return 0;
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const clampedAbs = Math.min(Math.floor(abs), MAX_SAFE_XP);
  return sign * clampedAbs;
}

/**
 * Clamp an XP total to a safe finite integer in [0, MAX_SAFE_XP].
 * - Non-finite -> MAX_SAFE_XP (you can change this to 0 if you prefer)
 * - Coerces to integer
 */
function clampXpTotal(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return MAX_SAFE_XP;
  if (x <= 0) return 0;
  return Math.min(Math.floor(x), MAX_SAFE_XP);
}

/**
 * Helper: check if a table exists.
 */
function tableExists(name) {
  const row = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
  .get(name);
  return !!row;
}

/**
 * Helper: get columns for a table (empty if table doesn't exist)
 */
function getColumns(table) {
  if (!tableExists(table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
}

/**
 * Helper: add column if missing (SQLite doesn't support IF NOT EXISTS for columns).
 */
function addColumnIfMissing(table, columnName, columnDefSql) {
  const cols = new Set(getColumns(table));
  if (cols.has(columnName)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDefSql}`).run();
}

/**
 * Base schema creation.
 * Note: if you change schema later, add migration logic below.
 */
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

-- YouTube channel subscriptions
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

-- Roles exempt from honeypot bans (e.g. staff)
CREATE TABLE IF NOT EXISTS honeypot_exempt_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

`);

/**
 * === MIGRATIONS ===
 * Add new columns safely for existing installs.
 */
(function runMigrations() {
  // Add per-guild reaction XP + cooldown (new feature)
  addColumnIfMissing(
    "guild_settings",
    "reaction_xp",
    "reaction_xp INTEGER NOT NULL DEFAULT 2"
  );
  addColumnIfMissing(
    "guild_settings",
    "reaction_cooldown_sec",
    "reaction_cooldown_sec INTEGER NOT NULL DEFAULT 10"
  );



  // Recreate youtube_channels table with composite primary key (guild_id, id) instead of just id
  // This allows the same YouTube channel ID to be used across different guilds
  db.prepare(`CREATE TABLE IF NOT EXISTS youtube_channels_new (
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
  )`).run();
  
  db.prepare(`INSERT INTO youtube_channels_new SELECT * FROM youtube_channels`).run();
  db.prepare(`DROP TABLE youtube_channels`).run();
  db.prepare(`ALTER TABLE youtube_channels_new RENAME TO youtube_channels`).run();

  // Add last_checked column for YouTube channels (migration)
  addColumnIfMissing(
    "youtube_channels",
    "last_checked",
    "last_checked INTEGER"
  );

  // Add youtube_upload_role_id column for guild settings
  addColumnIfMissing(
    "guild_settings",
    "youtube_upload_role_id",
    "youtube_upload_role_id TEXT"
  );

  // Honeypot warning message id (bot-posted notice in the channel)
  addColumnIfMissing(
    "honeypot_channels",
    "warning_message_id",
    "warning_message_id TEXT"
  );

  // Cleanup pass: clamp any bad/overflow XP already stored (Infinity/NaN/too big/negative)

  // Cleanup pass: clamp any bad/overflow XP already stored (Infinity/NaN/too big/negative)
  // Handles:
  // - REAL inf/nan
  // - TEXT 'Infinity'/'NaN' (if ever inserted as strings)
  // - values > MAX_SAFE_XP
  // - values < 0
  //
  // Note: SQLite compares INF > any finite number, so xp > MAX_SAFE_XP will catch REAL Infinity.
  db.prepare(`
  UPDATE users
  SET xp = ?, updated_at = ?
  WHERE xp > ?
  OR xp < 0
  OR xp = 'Infinity'
  OR xp = 'inf'
  OR xp = 'INF'
  OR xp = 'NaN'
  OR xp = 'nan'
  `).run(MAX_SAFE_XP, now(), MAX_SAFE_XP);
})();

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

  // This should never be undefined due to ensureGuildSettings, but be defensive.
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
      decay_percent: 0.10,
      level_xp_factor: 100,
      youtube_notification_channel_id: null,
      youtube_polling_interval_minutes: 5,
      youtube_upload_role_id: null,
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
  ]);

  const keys = Object.keys(patch).filter(k => allowed.has(k));
  if (!keys.length) return getGuildSettings(guildId);

  // Optional: clamp absurd XP award values to safe deltas (prevents "quintillion per message" silliness)
  // You can adjust these caps to whatever you prefer.
  const MAX_XP_AWARD = 1_000_000_000; // 1 billion per event is already wildly high, but finite & safe
  const clampAward = (v) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(Math.floor(x), MAX_XP_AWARD));
  };

  const safePatch = { ...patch };
  if (safePatch.msg_xp !== undefined) safePatch.msg_xp = clampAward(safePatch.msg_xp);
  if (safePatch.reaction_xp !== undefined) safePatch.reaction_xp = clampAward(safePatch.reaction_xp);
  if (safePatch.voice_xp_per_min !== undefined) safePatch.voice_xp_per_min = clampAward(safePatch.voice_xp_per_min);

  const sets = keys.map(k => `${k}=@${k}`).join(", ");
  db.prepare(`
  UPDATE guild_settings
  SET ${sets}, updated_at=@updated_at
  WHERE guild_id=@guild_id
 `).run({ guild_id: guildId, updated_at: now(), ...safePatch });
  
  // Cleanup malformed channel entries (e.g., before normalization fix)
  cleanupMalformedYoutubeChannels();
  
   return getGuildSettings(guildId);
}

/**
 * Users / XP
 */
function ensureUser(guildId, userId) {
  const t = now();
  db.prepare(`
  INSERT INTO users (guild_id, user_id, xp, created_at, updated_at)
  VALUES (?, ?, 0, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET updated_at=excluded.updated_at
  `).run(guildId, userId, t, t);
}

/**
 * Atomic XP update (prevents lost updates on concurrent events).
 * Also clamps XP to a JS-safe range to prevent Infinity/precision loss.
 * Returns the new XP.
 */
function addXp(guildId, userId, delta) {
  // Transaction ensures read-modify-write operations are atomic.
  // We also cap the *delta* to avoid overshooting the global XP cap.
  const tx = db.transaction((gId, uId, d) => {
    ensureUser(gId, uId);
    const t = now();

    const currentRow = db
      .prepare(`SELECT xp FROM users WHERE guild_id=? AND user_id=?`)
      .get(gId, uId);
    const currentXp = clampXpTotal(currentRow?.xp ?? 0);

    let safeDelta = clampDelta(d);

    // Cumulative cap: don't allow the *applied* delta to exceed remaining headroom.
    if (safeDelta > 0) {
      const headroom = MAX_SAFE_XP - currentXp;
      safeDelta = Math.min(safeDelta, headroom);
    } else if (safeDelta < 0) {
      // Don't underflow below 0.
      safeDelta = -Math.min(Math.abs(safeDelta), currentXp);
    }

    if (safeDelta === 0) return currentXp;

    db.prepare(`
      UPDATE users
      SET xp = MIN(?, MAX(0, xp + ?)),
          updated_at = ?
      WHERE guild_id=? AND user_id=?
    `).run(MAX_SAFE_XP, safeDelta, t, gId, uId);

    const row = db
      .prepare(`SELECT xp FROM users WHERE guild_id=? AND user_id=?`)
      .get(gId, uId);

    const safeXp = clampXpTotal(row?.xp ?? 0);
    if (row && row.xp !== safeXp) {
      db.prepare(`
        UPDATE users
        SET xp=?, updated_at=?
        WHERE guild_id=? AND user_id=?
      `).run(safeXp, now(), gId, uId);
    }
    return safeXp;
  });

  return tx(guildId, userId, delta);
}

function setXp(guildId, userId, xp) {
  ensureUser(guildId, userId);
  const safe = clampXpTotal(xp);

  db.prepare(`
  UPDATE users
  SET xp=?, updated_at=?
  WHERE guild_id=? AND user_id=?
  `).run(safe, now(), guildId, userId);
}

function getXp(guildId, userId) {
  const row = db.prepare(`SELECT xp FROM users WHERE guild_id=? AND user_id=?`).get(guildId, userId);
  const safe = clampXpTotal(row?.xp ?? 0);

  // Normalize legacy bad values on read
  if (row && row.xp !== safe) {
    db.prepare(`
    UPDATE users
    SET xp=?, updated_at=?
    WHERE guild_id=? AND user_id=?
    `).run(safe, now(), guildId, userId);
  }

  return safe;
}

function topUsers(guildId, limit = 10) {
  const rows = db.prepare(`
  SELECT user_id, xp
  FROM users
  WHERE guild_id=?
  ORDER BY xp DESC
  LIMIT ?
  `).all(guildId, limit);

  // Sanitize results (and normalize DB if needed)
  let changed = false;
  const out = rows.map(r => {
    const safe = clampXpTotal(r.xp);
    if (r.xp !== safe) changed = true;
    return { user_id: r.user_id, xp: safe };
  });

  if (changed) {
    const t = now();
    const stmt = db.prepare(`
    UPDATE users
    SET xp=?, updated_at=?
    WHERE guild_id=? AND user_id=?
    `);
    const tx = db.transaction(() => {
      for (const r of out) {
        stmt.run(r.xp, t, guildId, r.user_id);
      }
    });
    tx();
  }

  return out;
}

function allUsersInGuild(guildId) {
  const rows = db.prepare(`
  SELECT user_id, xp
  FROM users
  WHERE guild_id=?
  `).all(guildId);

  return rows.map(r => ({ user_id: r.user_id, xp: clampXpTotal(r.xp) }));
}

/**
 * Activity log
 */
function logActivity(guildId, userId, kind, amount = 1) {
  db.prepare(`
  INSERT INTO activity_log (guild_id, user_id, kind, amount, created_at)
  VALUES (?, ?, ?, ?, ?)
  `).run(guildId, userId, kind, amount, now());
}

function countMessagesInWindow(guildId, userId, windowDays) {
  const since = now() - windowDays * 24 * 60 * 60 * 1000;
  const row = db.prepare(`
  SELECT COALESCE(SUM(amount), 0) AS c
  FROM activity_log
  WHERE guild_id=? AND user_id=? AND kind='message' AND created_at >= ?
  `).get(guildId, userId, since);
  return row?.c ?? 0;
}

/**
 * Voice sessions (kept for compatibility / future)
 */
function upsertVoiceSession(guildId, userId, channelId, joinedAtMs) {
  db.prepare(`
  INSERT INTO voice_sessions (guild_id, user_id, channel_id, joined_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id=excluded.channel_id, joined_at=excluded.joined_at
  `).run(guildId, userId, channelId, joinedAtMs);
}

function getVoiceSession(guildId, userId) {
  return db.prepare(`
  SELECT guild_id, user_id, channel_id, joined_at
  FROM voice_sessions
  WHERE guild_id=? AND user_id=?
  `).get(guildId, userId);
}

function deleteVoiceSession(guildId, userId) {
  db.prepare(`DELETE FROM voice_sessions WHERE guild_id=? AND user_id=?`).run(guildId, userId);
}

/**
 * Level roles
 */
function upsertLevelRole(guildId, roleId, levelRequired, dropGraceDays) {
  const t = now();
  db.prepare(`
  INSERT INTO level_roles (guild_id, role_id, level_required, drop_grace_days, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, role_id) DO UPDATE SET
  level_required=excluded.level_required,
  drop_grace_days=excluded.drop_grace_days,
  updated_at=excluded.updated_at
  `).run(guildId, roleId, levelRequired, dropGraceDays, t, t);
}

function deleteLevelRole(guildId, roleId) {
  db.prepare(`DELETE FROM level_roles WHERE guild_id=? AND role_id=?`).run(guildId, roleId);
  db.prepare(`DELETE FROM role_drop_state WHERE guild_id=? AND role_id=?`).run(guildId, roleId);
}

function listLevelRoles(guildId) {
  return db.prepare(`
  SELECT role_id, level_required, drop_grace_days
  FROM level_roles
  WHERE guild_id=?
  ORDER BY level_required ASC
  `).all(guildId);
}

/**
 * Role drop state
 */
function getRoleDropState(guildId, userId, roleId) {
  return db.prepare(`
  SELECT below_since
  FROM role_drop_state
  WHERE guild_id=? AND user_id=? AND role_id=?
  `).get(guildId, userId, roleId);
}

function setRoleBelowSince(guildId, userId, roleId, belowSinceOrNull) {
  const t = now();
  db.prepare(`
  INSERT INTO role_drop_state (guild_id, user_id, role_id, below_since, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id, role_id) DO UPDATE SET
  below_since=excluded.below_since,
  updated_at=excluded.updated_at
  `).run(guildId, userId, roleId, belowSinceOrNull, t);
}

/**
 * Allowed command channels
 */
function addAllowedCommandChannel(guildId, channelId) {
  db.prepare(`
  INSERT OR IGNORE INTO allowed_command_channels (guild_id, channel_id, created_at)
  VALUES (?, ?, ?)
  `).run(guildId, channelId, now());
}

function removeAllowedCommandChannel(guildId, channelId) {
  db.prepare(`
  DELETE FROM allowed_command_channels
  WHERE guild_id=? AND channel_id=?
  `).run(guildId, channelId);
}

function listAllowedCommandChannels(guildId) {
  return db.prepare(`
  SELECT channel_id
  FROM allowed_command_channels
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

/**
 * YouTube subscriptions
 */
// Normalize YouTube @username to remove leading @ for consistent storage
// Normalize YouTube @username to remove leading @ for consistent storage, but add it back for display
function normalizeYoutubeName(name) {
  return name.startsWith("@") ? name.substring(1) : name;
}

function getYoutubeChannels(guildId) {
  return db.prepare(`
  SELECT id, guild_id, channel_name, channel_url, thumbnail_url, last_video_id, last_checked
  FROM youtube_channels
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

function getAllYoutubeChannels() {
  return db.prepare(`
  SELECT id, guild_id, channel_name, channel_url, thumbnail_url, last_video_id, last_checked
  FROM youtube_channels
  ORDER BY created_at ASC
  `).all();
}

function getYoutubeChannelById(guildId, channelId) {
  const normalized = normalizeYoutubeName(channelId);
  return db.prepare(`
  SELECT id, guild_id, channel_name, channel_url, thumbnail_url, last_video_id, last_checked
  FROM youtube_channels
  WHERE guild_id=? AND (id=? OR channel_url LIKE '%/' || ? || '/')
  `).get(guildId, normalized, normalized);
}

function addYoutubeChannel(guildId, channelId, channelName, channelUrl, thumbnailUrl) {
  const t = now();
   
  // Normalize: strip @ from name for consistent storage
    const normalizedId = normalizeYoutubeName(channelId);
    const normalizedChannelName = normalizeYoutubeName(channelName);
    
    // Skip if exact same data already exists (avoid unnecessary updates)
   const existing = getYoutubeChannelById(guildId, normalizedId);
   if (existing && existing.channel_name === normalizedChannelName && existing.channel_url === channelUrl) {
     return existing;
   }
   
  const stmt = db.prepare(`
     INSERT INTO youtube_channels (id, guild_id, channel_name, channel_url, thumbnail_url, last_video_id, last_checked, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
     ON CONFLICT(guild_id, channel_name) DO UPDATE SET
       id=excluded.id,
       channel_url=excluded.channel_url,
       thumbnail_url=excluded.thumbnail_url,
       updated_at=excluded.updated_at
   `);
   
   try {
     stmt.run(normalizedId, guildId, normalizedChannelName, channelUrl, thumbnailUrl || null, null, t, t);
   } catch (err) {
     console.error(`[youtube] DB error:`, err.message);
     throw err;
   }
    
    return getYoutubeChannelById(guildId, normalizedId);
}

function removeYoutubeChannel(guildId, channelId) {
  db.prepare(`DELETE FROM youtube_channels WHERE guild_id=? AND id=?`).run(guildId, channelId);
  return !!db.prepare(`SELECT changes()`).get().changes;
}




function updateYoutubeChannelLastChecked(channelId, lastCheckedMs, lastVideoId) {
   const t = now();
   if (lastVideoId) {
     db.prepare(`
     UPDATE youtube_channels
     SET last_checked=?, last_video_id=?, updated_at=?
     WHERE id=?
     `).run(lastCheckedMs, lastVideoId, t, channelId);
   } else {
     db.prepare(`
     UPDATE youtube_channels
     SET last_checked=?, updated_at=?
     WHERE id=?
     `).run(lastCheckedMs, t, channelId);
   }
}

function cleanupOldNotifications(thresholdDays = 30) {
   const cutoff = now() - thresholdDays * 24 * 60 * 60 * 1000;
   
   db.prepare(`DELETE FROM youtube_channels WHERE last_checked < ?`).run(cutoff);
}

// Cleanup malformed YouTube channel entries (non-numeric IDs from before normalization fix)
function cleanupMalformedYoutubeChannels() {
   const rows = db.prepare("SELECT guild_id, channel_name FROM youtube_channels WHERE NOT id LIKE 'UC%' AND NOT id LIKE 'HC%'").all();
  
  if (!rows.length) return;
  
  console.log(`[youtube] Cleaning up ${rows.length} malformed channel entries...`);
  
  for (const row of rows) {
     db.prepare("DELETE FROM youtube_channels WHERE guild_id=? AND channel_name=?").run(row.guild_id, row.channel_name);
  }
}

/**
 * Honeypot channels
 */
function addHoneypotChannel(guildId, channelId) {
  db.prepare(`
  INSERT OR IGNORE INTO honeypot_channels (guild_id, channel_id, created_at)
  VALUES (?, ?, ?)
  `).run(guildId, channelId, now());
}

function getHoneypotChannel(guildId, channelId) {
  return db.prepare(`
  SELECT channel_id, warning_message_id
  FROM honeypot_channels
  WHERE guild_id=? AND channel_id=?
  `).get(guildId, channelId) || null;
}

function setHoneypotWarningMessage(guildId, channelId, messageIdOrNull) {
  db.prepare(`
  UPDATE honeypot_channels
  SET warning_message_id=?
  WHERE guild_id=? AND channel_id=?
  `).run(messageIdOrNull, guildId, channelId);
}

function removeHoneypotChannel(guildId, channelId) {
  const existing = getHoneypotChannel(guildId, channelId);
  const result = db.prepare(`
  DELETE FROM honeypot_channels
  WHERE guild_id=? AND channel_id=?
  `).run(guildId, channelId);
  return {
    removed: result.changes > 0,
    warning_message_id: existing?.warning_message_id || null,
  };
}

function listHoneypotChannels(guildId) {
  return db.prepare(`
  SELECT channel_id, warning_message_id
  FROM honeypot_channels
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

function isHoneypotChannel(guildId, channelId) {
  const row = db.prepare(`
  SELECT 1 AS ok
  FROM honeypot_channels
  WHERE guild_id=? AND channel_id=?
  `).get(guildId, channelId);
  return !!row;
}

/**
 * Honeypot exempt roles
 */
function addHoneypotExemptRole(guildId, roleId) {
  db.prepare(`
  INSERT OR IGNORE INTO honeypot_exempt_roles (guild_id, role_id, created_at)
  VALUES (?, ?, ?)
  `).run(guildId, roleId, now());
}

function removeHoneypotExemptRole(guildId, roleId) {
  const result = db.prepare(`
  DELETE FROM honeypot_exempt_roles
  WHERE guild_id=? AND role_id=?
  `).run(guildId, roleId);
  return result.changes > 0;
}

function listHoneypotExemptRoles(guildId) {
  return db.prepare(`
  SELECT role_id
  FROM honeypot_exempt_roles
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

function memberHasHoneypotExemptRole(guildId, memberRoleIds) {
  if (!memberRoleIds?.length) return false;
  const rows = listHoneypotExemptRoles(guildId);
  if (!rows.length) return false;
  const exempt = new Set(rows.map(r => r.role_id));
  return memberRoleIds.some(id => exempt.has(id));
}

module.exports = {
  db,
  now,

  // caps/helpers (exported in case you want to show warnings)
  MAX_SAFE_XP,

  // guild settings
  getGuildSettings,
  updateGuildSettings,

  // users/xp
  addXp,
  setXp,
  getXp,
  topUsers,
  allUsersInGuild,

  // activity
  logActivity,
  countMessagesInWindow,

  // voice sessions
  upsertVoiceSession,
  getVoiceSession,
  deleteVoiceSession,

  // roles
  upsertLevelRole,
  deleteLevelRole,
  listLevelRoles,
  getRoleDropState,
  setRoleBelowSince,

  // command channel restriction
  addAllowedCommandChannel,
  removeAllowedCommandChannel,
  listAllowedCommandChannels,

  // YouTube subscriptions
  normalizeYoutubeName,
  getYoutubeChannels,
  getAllYoutubeChannels,
  getYoutubeChannelById,
  addYoutubeChannel,
  removeYoutubeChannel,
  updateYoutubeChannelLastChecked,
  cleanupOldNotifications,
  cleanupMalformedYoutubeChannels,

  // honeypot
  addHoneypotChannel,
  getHoneypotChannel,
  setHoneypotWarningMessage,
  removeHoneypotChannel,
  listHoneypotChannels,
  isHoneypotChannel,
  addHoneypotExemptRole,
  removeHoneypotExemptRole,
  listHoneypotExemptRoles,
  memberHasHoneypotExemptRole,
};



