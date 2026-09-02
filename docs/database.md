# Database Schema

Deep dive into Boiler Snake's SQLite database structure and how data is organized.

## Overview

The bot uses **SQLite** with **WAL mode** for reliable concurrent access. All data is stored in a single file: `xpbot.sqlite` (located in the project root by default). Override with `DATA_DIR` (directory) or `DB_PATH` (full file path). Docker Compose uses `DATA_DIR=/data` with a named volume.

## Database Location

```
boiler-snake/
├── xpbot.sqlite          # Main database file
├── xpbot.sqlite-wal      # Write-ahead log (SQLite WAL mode)
└── xpbot.sqlite-shm      # Shared memory file (WAL mode)
```

## Schema Summary

| Table | Purpose |
|-------|---------|
| `users` | Per-guild XP totals for each user |
| `activity_log` | Historical XP activity tracking for decay analysis |
| `voice_sessions` | Voice channel session data (legacy) |
| `guild_settings` | Per-guild configuration settings |
| `level_roles` | Role-to-level mappings with grace periods |
| `role_drop_state` | Track when users dropped below role thresholds |
| `allowed_command_channels` | Command channel restrictions per guild |
| `youtube_channels` | YouTube subscriptions and metadata |
| `twitch_channels` | Twitch broadcaster subscriptions + live/stream dedup state |
| `honeypot_channels` | Channels that ban non-exempt users who post |
| `staff_roles` | Guild staff roles (admin gate + honeypot exemption); `level` junior\|senior |
| `honeypot_ban_roles` | Roles that ban a member when granted |
| `reaction_role_panels` | Bot-owned reaction-role panel messages |
| `reaction_role_options` | Emoji → role options on panels |
| `event_reminder_configs` | Scheduled event ↔ reminder role/channel config |
| `event_reminder_offsets` | Per-offset fire times and sent state |
| `event_reminder_optouts` | Per-guild user opt-out from event reminder pings |
| `event_reminder_event_optouts` | Per-event mute (user + scheduled_event_id) |
| `staff_notes` | Private staff notes about members (soft-delete) |
| `warnings` | Formal permanent warnings (voidable; sequential W-n) |
| `tickets` | Support ticket lifecycle, sensitive flag, archive metadata |
| `ticket_members` | Extra member participants on a ticket |
| `ticket_staff` | Named staff allow-list (sensitive / extras) |
| `ticket_messages` | Archived messages for non-sensitive closed tickets |
| `user_channel_message_daily` | Per-user per-channel daily message counts (staff activity) |
| `activity_ignore` | Channels/categories excluded from activity stats |
| `guild_activity_settings` | Live watermark + guild-wide backfill progress |
| `user_activity_meta` | Per-user backfill status for activity |
| `user_channel_backfill_cursor` | Per-user per-channel history scan progress |
| `guild_channel_backfill_cursor` | Guild-wide per-channel history scan progress |

---

## Detailed Table Specifications

### 1. `users`

Stores XP totals for each user in each guild.

```sql
CREATE TABLE users (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  xp       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,   -- ms epoch when first XP awarded
  updated_at INTEGER NOT NULL,   -- ms epoch of last XP change
  PRIMARY KEY (guild_id, user_id)
);
```

**Query patterns**:
```javascript
// Get a user's XP
SELECT xp FROM users WHERE guild_id=? AND user_id=?

// Add XP (atomic via transaction)
UPDATE users SET xp = MIN(?, MAX(0, xp + ?)), updated_at = ?
WHERE guild_id=? AND user_id=?

// Top 10 users
SELECT user_id, xp FROM users
WHERE guild_id=? ORDER BY xp DESC LIMIT ?
```

**Indices**:
- Primary key on `(guild_id, user_id)`
- No separate indices (composite PK is sufficient)

---

### 2. `activity_log`

Tracks every XP-earning activity for decay analysis and future features.

```sql
CREATE TABLE activity_log (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,         -- 'message'|'reaction'|'voice_minute'
  amount   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL    -- ms epoch when activity occurred
);

CREATE INDEX idx_activity_recent
ON activity_log (guild_id, user_id, kind, created_at);

CREATE INDEX idx_activity_created_at
ON activity_log (created_at);
```

**Query patterns**:
```javascript
// Log a new activity
INSERT INTO activity_log (guild_id, user_id, kind, amount, created_at)
VALUES (?, ?, ?, ?, ?)

// Count messages in time window (decay calculation)
SELECT COALESCE(SUM(amount), 0) AS c
FROM activity_log
WHERE guild_id=? AND user_id=? AND kind='message' AND created_at >= ?

// Get recent voice XP
SELECT * FROM activity_log
WHERE kind='voice_minute' AND user_id=? ORDER BY created_at DESC LIMIT 10
```

**Data retention**: Logs accumulate indefinitely. Consider periodic cleanup for large servers.

**Note**: This is separate from staff [user activity](user-activity.md) counters (`user_channel_message_daily`), which count every human message regardless of XP cooldowns.

---

### 3. `voice_sessions`

Kept for compatibility; not actively used by current voice ticker implementation.

```sql
CREATE TABLE voice_sessions (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,    -- ms epoch when voice state recorded
  PRIMARY KEY (guild_id, user_id)
);
```

**Status**: Legacy table. Future features might use this instead of tracking in memory.

---

### 4. `guild_settings`

One row per guild storing all configuration options. Base columns come from migration `001`; later migrations add columns via `addColumnIfMissing`.

```sql
CREATE TABLE guild_settings (
  guild_id TEXT PRIMARY KEY,

  msg_xp INTEGER NOT NULL DEFAULT 5,
  reaction_xp INTEGER NOT NULL DEFAULT 2,
  voice_xp_per_min INTEGER NOT NULL DEFAULT 1,

  msg_cooldown_sec INTEGER NOT NULL DEFAULT 20,
  reaction_cooldown_sec INTEGER NOT NULL DEFAULT 10,

  decay_enabled INTEGER NOT NULL DEFAULT 1,      -- 0 or 1
  decay_window_days INTEGER NOT NULL DEFAULT 7,
  decay_min_messages INTEGER NOT NULL DEFAULT 20,
  decay_percent REAL NOT NULL DEFAULT 0.10,     -- 0.0 to 0.95

  level_xp_factor INTEGER NOT NULL DEFAULT 100,

  youtube_notification_channel_id TEXT,          -- NULL when not configured
  youtube_polling_interval_minutes INTEGER NOT NULL DEFAULT 5,
  youtube_upload_role_id TEXT,                   -- optional role pinged on new uploads

  twitch_notification_channel_id TEXT,           -- NULL when not configured
  twitch_notify_role_id TEXT,                    -- optional role pinged on go-live
  twitch_polling_interval_minutes INTEGER NOT NULL DEFAULT 2,

  audit_log_channel_id TEXT,                     -- NULL when not configured
  message_log_channel_id TEXT,                   -- NULL when not configured
  event_reminder_channel_id TEXT,                -- default channel for event reminders
  warn_log_channel_id TEXT,                      -- NULL → warn issue/void fall back to audit log
  warn_dm_members INTEGER NOT NULL DEFAULT 1,
  warn_expiry_days INTEGER NOT NULL DEFAULT 0,   -- 0 = new warnings never expire by default

  ticket_category_id TEXT,                       -- parent category for open tickets
  ticket_archive_channel_id TEXT,                -- staff channel for close summaries
  ticket_rate_limit_minutes INTEGER NOT NULL DEFAULT 60,

  updated_at INTEGER NOT NULL
);
```

**Default Values**:
| Setting | Default | Unit / notes |
|---------|---------|--------------|
| `msg_xp` | 5 | XP per message |
| `reaction_xp` | 2 | XP per reaction |
| `voice_xp_per_min` | 1 | XP per minute in voice |
| `msg_cooldown_sec` | 20 | Seconds between messages |
| `reaction_cooldown_sec` | 10 | Seconds between reactions |
| `decay_enabled` | 1 | Enable decay (boolean) |
| `decay_window_days` | 7 | Time window for activity check |
| `decay_min_messages` | 20 | Minimum messages to avoid decay |
| `decay_percent` | 0.10 | XP reduction fraction (10%) |
| `level_xp_factor` | 100 | Level formula factor |
| `youtube_polling_interval_minutes` | 5 | API check frequency |
| `youtube_upload_role_id` | NULL | Role mentioned on new uploads |
| `twitch_notification_channel_id` | NULL | Channel for go-live alerts |
| `twitch_notify_role_id` | NULL | Role mentioned on go-live (independent of YouTube) |
| `twitch_polling_interval_minutes` | 2 | Helix check frequency |
| `audit_log_channel_id` | NULL | Staff audit log channel |
| `message_log_channel_id` | NULL | Deleted-message log channel |
| `event_reminder_channel_id` | NULL | Default event-reminder notify channel |
| `warn_log_channel_id` | NULL | Dedicated warning log (optional) |
| `warn_dm_members` | 1 | DM members on warn issue/void |
| `warn_expiry_days` | 0 | Default days until new warnings auto-void (`0` = never) |
| `ticket_category_id` | NULL | Parent category for open tickets |
| `ticket_archive_channel_id` | NULL | Staff channel for transcripts / stubs |
| `ticket_rate_limit_minutes` | 60 | Minutes between member self-creates (`0` = off) |

**Query patterns**:
```javascript
// Ensure settings exist for guild (insert if missing)
INSERT INTO guild_settings (guild_id, updated_at)
VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET updated_at=excluded.updated_at

// Get all settings for guild
SELECT * FROM guild_settings WHERE guild_id=?

// Update specific settings
UPDATE guild_settings
SET msg_xp=@new_msg_xp, reaction_xp=@new_reaction_xp, updated_at=@now
WHERE guild_id=@guild_id
```

See also [Configuration](configuration.md), [Tickets](tickets.md), [Warnings](warnings.md).

---

### 5. `level_roles`

Stores role→level mappings with drop grace periods.

```sql
CREATE TABLE level_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  level_required INTEGER NOT NULL,          -- Minimum level to keep role
  drop_grace_days INTEGER NOT NULL DEFAULT 3, -- Days before revoking
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
```

**Example Data**:
```sql
INSERT INTO level_roles VALUES
(123456789, 987654321, 5, 3, 1700000000000, 1700000000000),
(123456789, 555666777, 20, 7, 1700000000000, 1700000000000);
```

**Query patterns**:
```javascript
// Get all role mappings for guild
SELECT role_id, level_required, drop_grace_days
FROM level_roles WHERE guild_id=? ORDER BY level_required ASC

// Insert or update mapping
INSERT INTO level_roles (guild_id, role_id, level_required, drop_grace_days, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, role_id) DO UPDATE SET ...

// Delete mapping
DELETE FROM level_roles WHERE guild_id=? AND role_id=?
```

---

### 6. `role_drop_state`

Tracks when users first dropped below a role's threshold (for grace period).

```sql
CREATE TABLE role_drop_state (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER,        -- ms epoch when user dropped below; NULL if currently meets requirement
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, role_id)
);
```

**Example Data**:
```sql
-- User is currently above threshold (no timer running)
INSERT INTO role_drop_state VALUES
(123456789, 987654321, 555666777, NULL, 1700000000000);

-- User dropped below at epoch time X (timer started)
INSERT INTO role_drop_state VALUES
(123456789, 987654321, 555666777, 1700000000000, 1700000000000);
```

**Query patterns**:
```javascript
// Check if user is below threshold for role
SELECT below_since FROM role_drop_state
WHERE guild_id=? AND user_id=? AND role_id=?

// Mark user as dropped (start timer)
INSERT INTO role_drop_state (guild_id, user_id, role_id, below_since, updated_at)
VALUES (?, ?, ?, ?, ?) ON CONFLICT(...) DO UPDATE SET ...

// Clear drop state (user promoted back)
UPDATE role_drop_state SET below_since=NULL WHERE ...
```

---

### 7. `allowed_command_channels`

Command channel restrictions per guild.

```sql
CREATE TABLE allowed_command_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,   -- ms epoch when added to allowed list
  PRIMARY KEY (guild_id, channel_id)
);
```

**Query patterns**:
```javascript
// Add allowed channel
INSERT OR IGNORE INTO allowed_command_channels (guild_id, channel_id, created_at)
VALUES (?, ?, ?)

// Check if channel is allowed
SELECT EXISTS(SELECT 1 FROM allowed_command_channels
WHERE guild_id=? AND channel_id=?)

// List all allowed channels
SELECT channel_id FROM allowed_command_channels WHERE guild_id=?
ORDER BY created_at ASC

// Remove from allowed list
DELETE FROM allowed_command_channels WHERE guild_id=? AND channel_id=?
```

Empty allow-list means commands are allowed everywhere. See [Command Restrictions](command-restrictions.md).

---

### 8. `youtube_channels`

YouTube channel subscriptions and metadata.

```sql
CREATE TABLE youtube_channels (
  guild_id TEXT NOT NULL,
  id TEXT NOT NULL,                      -- Channel ID (numeric or @username)
  channel_name TEXT NOT NULL,            -- Normalized name (no @ prefix)
  channel_url TEXT NOT NULL,             -- Full YouTube URL
  thumbnail_url TEXT,                    -- Optional thumbnail path
  last_video_id TEXT,                    -- Most recent video's ID
  last_checked INTEGER,                  -- ms epoch of last API check
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, id),
  UNIQUE(guild_id, channel_name)         -- Prevent duplicates in same guild
);
```

**Query patterns**:
```javascript
// Get all subscriptions for guild
SELECT id, guild_id, channel_name, channel_url, thumbnail_url,
       last_video_id, last_checked
FROM youtube_channels WHERE guild_id=?

// Add or update subscription
INSERT INTO youtube_channels (id, guild_id, channel_name, channel_url,
                              thumbnail_url, last_video_id, last_checked, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(...) DO UPDATE SET ...

// Update last checked timestamp
UPDATE youtube_channels SET last_checked=?, last_video_id=?, updated_at=?
WHERE id=?
```

See [YouTube Notifications](youtube-notifications.md).

---

### 8b. `twitch_channels`

Twitch broadcaster subscriptions and live-state dedup.

```sql
CREATE TABLE twitch_channels (
  guild_id          TEXT NOT NULL,
  broadcaster_id    TEXT NOT NULL,     -- Twitch user id (stable)
  login             TEXT NOT NULL,     -- lowercase login
  display_name      TEXT NOT NULL,
  profile_image_url TEXT,
  is_live           INTEGER NOT NULL DEFAULT 0,
  last_stream_id    TEXT,              -- Helix stream id; dedup go-live
  last_checked      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (guild_id, broadcaster_id),
  UNIQUE (guild_id, login)
);
```

**Query patterns**:
```javascript
// All subscriptions for the poller
SELECT guild_id, broadcaster_id, login, display_name, profile_image_url,
       is_live, last_stream_id, last_checked
FROM twitch_channels ORDER BY created_at ASC

// Update live state after a poll
UPDATE twitch_channels
SET is_live=?, last_stream_id=?, last_checked=?, updated_at=?
WHERE guild_id=? AND broadcaster_id=?
```

See [Twitch Stream Notifications](twitch-notifications.md).

---

### 9. `honeypot_channels`

Channels configured as honeypots. Non-exempt users who post are banned.

```sql
CREATE TABLE honeypot_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  warning_message_id TEXT,       -- bot-posted warning message in the channel
  created_at INTEGER NOT NULL,   -- ms epoch when marked as honeypot
  PRIMARY KEY (guild_id, channel_id)
);
```

**Query patterns**:
```javascript
// Add honeypot channel
INSERT OR IGNORE INTO honeypot_channels (guild_id, channel_id, created_at)
VALUES (?, ?, ?)

// Store / update warning message id
UPDATE honeypot_channels SET warning_message_id=? WHERE guild_id=? AND channel_id=?

// Check if channel is a honeypot
SELECT 1 FROM honeypot_channels WHERE guild_id=? AND channel_id=?

// List honeypot channels
SELECT channel_id, warning_message_id FROM honeypot_channels WHERE guild_id=?
ORDER BY created_at ASC

// Remove honeypot
DELETE FROM honeypot_channels WHERE guild_id=? AND channel_id=?
```

See [Honeypot](honeypot.md). Exemption is driven by [`staff_roles`](#10-staff_roles), not a separate table.

---

### 10. `staff_roles`

Guild-wide staff role allow-list. Powers the admin gate (`isStaff` / `requireStaff`), honeypot exemption, ticket channel overwrites (senior only), and related staff features.

Formerly `honeypot_exempt_roles`; migration `008_staff_roles` renames/merges legacy rows. Migration `011_staff_role_levels` adds `level`.

```sql
CREATE TABLE staff_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'senior',  -- 'junior' | 'senior' (011)
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
```

| Column | Description |
|--------|-------------|
| `guild_id` | Discord guild snowflake |
| `role_id` | Discord role snowflake |
| `level` | `junior` or `senior` (default `senior` for existing rows) |
| `created_at` | ms epoch when the row was first added |

**Level semantics**:

| Level | Staff command gate | Honeypot exempt | Ticket channel overwrites |
|-------|--------------------|-----------------|---------------------------|
| `junior` | Yes | Yes | **No** (use `/ticket addstaff` or claim) |
| `senior` | Yes | Yes | **Yes** (open non-sensitive tickets) |

Manage Server alone grants staff **commands** but is not honeypot-exempt and does not get automatic ticket channel overwrites.

**Query patterns**:
```javascript
// Add / upsert staff role with level
INSERT INTO staff_roles (guild_id, role_id, level, created_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(guild_id, role_id) DO UPDATE SET level=excluded.level

// List all staff roles for guild
SELECT role_id, level, created_at FROM staff_roles
WHERE guild_id=?
ORDER BY CASE level WHEN 'senior' THEN 0 ELSE 1 END, created_at ASC

// Remove staff role
DELETE FROM staff_roles WHERE guild_id=? AND role_id=?
```

**Notes**:
- A member is staff (any level) if they have **any** role present in this table
- Honeypot channel posts and honeypot ban-role grants use the same exemption list
- There is no automatic exemption for Manage Server / Administrator from honeypots
- Configure via `/staff role add|remove|setlevel|list`

See [Staff Roles](staff-roles.md), [Honeypot](honeypot.md), [Tickets](tickets.md).

---

### 11. `honeypot_ban_roles`

Roles that ban a non-exempt member when **granted** (not retroactive for existing holders).

```sql
CREATE TABLE honeypot_ban_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,   -- ms epoch when added
  PRIMARY KEY (guild_id, role_id)
);
```

**Query patterns**:
```javascript
// Add ban role
INSERT OR IGNORE INTO honeypot_ban_roles (guild_id, role_id, created_at)
VALUES (?, ?, ?)

// List ban roles
SELECT role_id FROM honeypot_ban_roles WHERE guild_id=?
ORDER BY created_at ASC

// Remove ban role
DELETE FROM honeypot_ban_roles WHERE guild_id=? AND role_id=?
```

See [Honeypot](honeypot.md).

---

### 12. `reaction_role_panels`

Bot-owned panel messages for self-serve reaction roles.

```sql
CREATE TABLE reaction_role_panels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Reaction Roles',
  description TEXT NOT NULL DEFAULT 'React to get a role. Remove your reaction to drop it (if allowed).',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id)
);
```

---

### 13. `reaction_role_options`

Emoji → role mappings on a panel.

```sql
CREATE TABLE reaction_role_options (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji_key TEXT NOT NULL,       -- unicode string, or custom emoji id
  emoji_display TEXT NOT NULL,   -- unicode or <:name:id> for embed/react
  role_id TEXT NOT NULL,
  min_level INTEGER NOT NULL DEFAULT 0,
  removable INTEGER NOT NULL DEFAULT 1,  -- 1 = remove role when reaction removed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id, emoji_key)
);
```

**Query patterns**:
```javascript
// Look up option for a reaction
SELECT * FROM reaction_role_options
WHERE guild_id=? AND message_id=? AND emoji_key=?

// List options for panel refresh
SELECT * FROM reaction_role_options
WHERE guild_id=? AND message_id=?
ORDER BY created_at ASC
```

**Notes**:
- Deleting a panel also deletes its options
- Max 20 options per panel (enforced in application code)

See [Reaction Roles](reaction-roles.md).

---

### 14. Event reminder tables

Created by migration `006_event_reminders`. Also adds `guild_settings.event_reminder_channel_id`.

#### `event_reminder_configs`

One config per Discord scheduled event (and unique shortname per guild).

```sql
CREATE TABLE event_reminder_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  scheduled_event_id TEXT NOT NULL,
  shortname TEXT NOT NULL,
  role_id TEXT NOT NULL,
  channel_id TEXT,
  message_template TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (guild_id, scheduled_event_id),
  UNIQUE (guild_id, shortname)
);
```

#### `event_reminder_offsets`

Scheduled fire times for a config; `sent_at` set when the reminder posts.

```sql
CREATE TABLE event_reminder_offsets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES event_reminder_configs(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL,
  fire_at INTEGER NOT NULL,
  sent_at INTEGER,
  message_id TEXT
);
CREATE INDEX idx_event_reminder_due
  ON event_reminder_offsets(fire_at) WHERE sent_at IS NULL;
CREATE INDEX idx_event_reminder_offsets_config
  ON event_reminder_offsets(config_id);
```

#### `event_reminder_optouts`

Users who opted out of all event reminder role pings in a guild.

```sql
CREATE TABLE event_reminder_optouts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  opted_out_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
```

#### `event_reminder_event_optouts`

Per-event mute rows (independent of guild-wide opt-out). Created by migration `015_event_reminder_event_optouts`. Purged when the matching reminder config is cleared.

```sql
CREATE TABLE event_reminder_event_optouts (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scheduled_event_id TEXT NOT NULL,
  muted_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, scheduled_event_id)
);
CREATE INDEX idx_er_event_optouts_user
  ON event_reminder_event_optouts(guild_id, user_id);
CREATE INDEX idx_er_event_optouts_event
  ON event_reminder_event_optouts(guild_id, scheduled_event_id);
```

See [Event Reminders](event-reminders.md).

---

### 15. `staff_notes`

Private staff-only notes about guild members. Soft-delete only; sequential `note_number` per guild (refs like N-12).

```sql
CREATE TABLE staff_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  note_number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  edited_by TEXT,
  deleted_at INTEGER,
  deleted_by TEXT,
  UNIQUE (guild_id, note_number)
);
CREATE INDEX idx_staff_notes_user
  ON staff_notes(guild_id, user_id, created_at DESC);
CREATE INDEX idx_staff_notes_active
  ON staff_notes(guild_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_staff_notes_guild_recent
  ON staff_notes(guild_id, created_at DESC);
```

| Column | Description |
|--------|-------------|
| `note_number` | Human-friendly id within the guild (`/note edit id:12` → N-12) |
| `user_id` | Subject member |
| `author_id` | Staff who created the note |
| `content` | Note body (max 2000 chars in app) |
| `deleted_at` | Soft-delete timestamp; `NULL` = active |

See [Staff Notes](staff-notes.md).

---

### 16. `warnings`

Formal permanent disciplinary records. Void only (no hard delete); sequential `warning_number` per guild (refs like W-12). Optional link to a staff note.

```sql
CREATE TABLE warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  warning_number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  issuer_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  voided_at INTEGER,
  voided_by TEXT,
  void_reason TEXT,
  related_note_id INTEGER REFERENCES staff_notes(id) ON DELETE SET NULL,
  expires_at INTEGER,
  evidence_message_url TEXT,
  evidence_text TEXT,
  UNIQUE (guild_id, warning_number)
);
CREATE INDEX idx_warnings_user
  ON warnings(guild_id, user_id, created_at DESC);
CREATE INDEX idx_warnings_active
  ON warnings(guild_id, user_id) WHERE voided_at IS NULL;
CREATE INDEX idx_warnings_expires
  ON warnings(expires_at) WHERE voided_at IS NULL AND expires_at IS NOT NULL;
```

| Column | Description |
|--------|-------------|
| `warning_number` | Human-friendly id within the guild (`/warn void id:12` → W-12) |
| `user_id` | Subject member |
| `issuer_id` | Staff who issued the warning |
| `reason` | Immutable after issue (max 1000 chars in app) |
| `voided_at` | Void timestamp; `NULL` = active |
| `related_note_id` | Optional FK to `staff_notes.id` |
| `expires_at` | Optional auto-void deadline (ms); `NULL` = never |
| `evidence_message_url` | Optional Discord jump link (staff-only) |
| `evidence_text` | Optional freeform evidence notes (staff-only, max 500) |

Guild settings: `warn_dm_members` (`1` default / `0`) — DM subject on issue/void; `warn_log_channel_id` — dedicated log channel (falls back to audit log when unset); `warn_expiry_days` (`0` default) — default days until **new** warnings expire.

See [Warning System](warnings.md).

---

### 17. Ticket tables

Created by migration `010_tickets`, which also adds `ticket_category_id`, `ticket_archive_channel_id`, and `ticket_rate_limit_minutes` on `guild_settings`.

#### `tickets`

Support ticket lifecycle, sensitive flag, and archive metadata.

```sql
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  ticket_number INTEGER NOT NULL,
  channel_id TEXT UNIQUE,
  creator_user_id TEXT NOT NULL,
  staff_owner_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  is_sensitive INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  close_reason TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  closed_by_user_id TEXT,
  opened_by_staff_id TEXT,
  transcript_token TEXT UNIQUE,
  transcript_path TEXT,
  archive_message_id TEXT,
  ai_summary_json TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, ticket_number)
);
CREATE INDEX idx_tickets_guild_status
  ON tickets(guild_id, status);
CREATE INDEX idx_tickets_creator
  ON tickets(guild_id, creator_user_id);
CREATE INDEX idx_tickets_creator_created
  ON tickets(guild_id, creator_user_id, created_at);
CREATE INDEX idx_tickets_channel
  ON tickets(channel_id);
```

#### `ticket_members`

Extra member participants on a ticket (beyond the creator).

```sql
CREATE TABLE ticket_members (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT,
  PRIMARY KEY (ticket_id, user_id)
);
```

#### `ticket_staff`

Named staff allow-list (sensitive tickets / extras beyond senior staff role overwrites).

```sql
CREATE TABLE ticket_staff (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  added_by TEXT,
  PRIMARY KEY (ticket_id, user_id)
);
```

#### `ticket_messages`

Archived messages for non-sensitive closed tickets (transcript source).

```sql
CREATE TABLE ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_tag TEXT NOT NULL,
  content TEXT,
  attachment_urls TEXT,
  embeds_json TEXT,
  sent_at INTEGER NOT NULL,
  UNIQUE (ticket_id, message_id)
);
CREATE INDEX idx_ticket_messages_ticket
  ON ticket_messages(ticket_id);
```

See [Help Ticket System](tickets.md).

---

### 18. User activity tables

Staff activity stats (independent of XP / `activity_log`). Created by migrations `013_user_channel_activity` and `014_guild_activity_backfill`.

#### `user_channel_message_daily`

Per-user per-channel daily message counts. Counts every human guild message (no XP cooldown).

```sql
CREATE TABLE user_channel_message_daily (
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  day        TEXT NOT NULL,          -- calendar day key used by the app
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, channel_id, day)
);
CREATE INDEX idx_ucmd_user_day
  ON user_channel_message_daily (guild_id, user_id, day);
CREATE INDEX idx_ucmd_user_channel
  ON user_channel_message_daily (guild_id, user_id, channel_id);
```

#### `activity_ignore`

Channels or categories excluded from activity stats (`kind` is `channel` or `category`).

```sql
CREATE TABLE activity_ignore (
  guild_id   TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,           -- 'channel' | 'category'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, target_id)
);
CREATE INDEX idx_activity_ignore_guild
  ON activity_ignore (guild_id);
```

#### `guild_activity_settings`

Live watermark (`collect_from_ms`) plus guild-wide backfill progress columns (added in `014`).

```sql
CREATE TABLE guild_activity_settings (
  guild_id        TEXT PRIMARY KEY,
  collect_from_ms INTEGER NOT NULL,  -- live ingest only counts messages at/after this ms
  created_at      INTEGER NOT NULL,
  -- 014:
  guild_backfill_status TEXT NOT NULL DEFAULT 'none',
  guild_backfill_started_at INTEGER,
  guild_backfill_finished_at INTEGER,
  guild_backfill_error TEXT,
  guild_backfill_channels_done INTEGER NOT NULL DEFAULT 0,
  guild_backfill_channels_total INTEGER NOT NULL DEFAULT 0,
  guild_backfill_messages_counted INTEGER NOT NULL DEFAULT 0
);
```

#### `user_activity_meta`

Per-user backfill status for optional history scans.

```sql
CREATE TABLE user_activity_meta (
  guild_id                 TEXT NOT NULL,
  user_id                  TEXT NOT NULL,
  tracking_since_ms        INTEGER,
  backfill_status          TEXT NOT NULL DEFAULT 'none',
  backfill_started_at      INTEGER,
  backfill_finished_at     INTEGER,
  backfill_error           TEXT,
  backfill_channels_done   INTEGER NOT NULL DEFAULT 0,
  backfill_channels_total  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
```

#### `user_channel_backfill_cursor`

Per-user per-channel history scan progress.

```sql
CREATE TABLE user_channel_backfill_cursor (
  guild_id          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  oldest_message_id TEXT,
  complete          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, channel_id)
);
```

#### `guild_channel_backfill_cursor`

Guild-wide per-channel history scan progress (single-pass all users).

```sql
CREATE TABLE guild_channel_backfill_cursor (
  guild_id          TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  oldest_message_id TEXT,
  complete          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, channel_id)
);
```

See [User Activity Summary](user-activity.md).

---

## Database Migrations

Migrations run **automatically** when the db module loads (`src/db/migrate.js` via `src/db/index.js` / the `src/db.js` facade). Steps live under `src/db/migrations/` and are written to be **idempotent** (`CREATE TABLE IF NOT EXISTS`, `addColumnIfMissing`, gated rebuilds, no-op cleanups).

There is no separate manual migration CLI for normal operation: starting the bot (or any process that loads the db) applies all steps in order.

| Id | Purpose |
|----|---------|
| `001_base_schema` | `CREATE TABLE IF NOT EXISTS` for core domains (users, activity_log, voice_sessions, guild_settings, level roles, command channels, YouTube, honeypot, `staff_roles`, reaction roles) |
| `002_guild_settings_columns` | Additive `guild_settings` columns: reaction XP/cooldown, YouTube upload role, audit/message log channels |
| `003_youtube_composite_pk` | Rebuild `youtube_channels` **only if** PK is still single-column `id` (legacy installs) |
| `004_youtube_and_honeypot_columns` | Ensure `youtube_channels.last_checked` and `honeypot_channels.warning_message_id` |
| `005_clamp_bad_xp` | Clamp Infinity/NaN/out-of-range user XP rows to safe bounds |
| `006_event_reminders` | Event reminder tables + `event_reminder_channel_id` on `guild_settings` |
| `007_staff_notes` | `staff_notes` table + indexes (soft-delete, per-guild `note_number`) |
| `008_staff_roles` | Rename/merge legacy `honeypot_exempt_roles` → `staff_roles` |
| `009_warnings` | `warnings` table + `warn_dm_members` on `guild_settings` |
| `010_tickets` | `tickets` / `ticket_members` / `ticket_staff` / `ticket_messages` + ticket_* settings columns |
| `011_staff_role_levels` | `staff_roles.level` (`junior` \| `senior`, default senior) |
| `012_warn_log_channel` | `warn_log_channel_id` on `guild_settings` (fallback: audit log) |
| `013_user_channel_activity` | Daily activity counters, ignore list, user meta/cursors, `guild_activity_settings` watermark |
| `014_guild_activity_backfill` | Guild-wide backfill columns on `guild_activity_settings` + `guild_channel_backfill_cursor` |
| `015_event_reminder_event_optouts` | Per-event mute table for scheduled event reminders |
| `016_command_permission_oauth` | OAuth token storage for slash command permission sync |
| `017_warn_post_mvp` | `warn_expiry_days`; `warnings.expires_at` / evidence columns + expiry index |
| `018_warn_post_mvp` | `warnings.expires_at` / evidence columns (post-MVP warning fields) |
| `019_ticket_panels` | `ticket_panels` registry (posted panel messages for list/edit/delete) |
| `020_twitch` | `twitch_channels` table + `twitch_*` columns on `guild_settings` |

Public API remains available via `require("./db")` (facade over repositories).

---

## Common Queries for Self-Hosters

### Check Total XP in Guild

```sql
SELECT SUM(xp) as total_xp, COUNT(*) as users
FROM users WHERE guild_id='123456789';
```

### Find Top 100 XP Hogs

```sql
SELECT user_id, xp FROM users
WHERE guild_id='123456789' ORDER BY xp DESC LIMIT 100;
```

### Count Users by Level (using factor=100)

```sql
-- SQLite doesn't have sqrt in UPDATE, so use a query:
SELECT user_id, xp, CAST(SQRT(xp/100.0) AS INTEGER) as level
FROM users WHERE guild_id='123456789' ORDER BY xp DESC;
```

### Export All XP Data (CSV)

```bash
sqlite3 xpbot.sqlite "
.mode csv
.headers on
SELECT guild_id, user_id, xp FROM users WHERE guild_id='123456789';
" > xp_export.csv
```

---

## Performance Optimizations

### Indices in Place:
- `PRIMARY KEY` = automatic index
- `idx_activity_recent`: `(guild_id, user_id, kind, created_at)`
- `idx_activity_created_at`: `(created_at)`
- Staff notes, warnings, tickets, event reminders, and activity tables add their own indexes (see detailed sections)

### WAL Mode Benefits:
- Concurrent readers and writers don't block each other
- Better write performance for batch operations
- Automatic checkpointing

### vacuum Command (Cleanup)

For servers with thousands of users, occasionally run:
```bash
sqlite3 xpbot.sqlite "VACUUM;"
```

This reclaims space from deleted logs and optimizes file size.

---

## Security Considerations

### Data Exposure
- SQLite database is local-only (no network exposure)
- Contains Discord user IDs (not PII, but still sensitive)
- Ticket transcripts and staff notes may hold message content — treat backups carefully
- No passwords or API keys in database

### Backup Recommendations
```bash
# Automated daily backup
0 2 * * * sqlite3 /path/to/xpbot.sqlite ".backup '/backups/xpbot-$(date +\%Y\%m\%d).sqlite'"
```

When using WAL mode, back up the whole data directory (or use SQLite’s `.backup` API as above) so `-wal` / `-shm` siblings stay consistent.
