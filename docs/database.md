# Database Schema

Deep dive into HeisenXP-Bot's SQLite database structure and how data is organized.

## Overview

The bot uses **SQLite** with **WAL mode** for reliable concurrent access. All data is stored in a single file: `xpbot.sqlite` (located in the project root).

## Database Location

```
HeisenXP-Bot/
├── xpbot.sqlite          # Main database file
└── xpbot.sqlite-wal      # Write-ahead log (SQLite WAL mode)
└── xpbot.sqlite-shm      # Shared memory file (WAL mode)
```

## Schema Summary

| Table | Purpose |
|-------|---------|
| `users` | Per-guild XP totals for each user |
| `activity_log` | Historical activity tracking for decay analysis |
| `voice_sessions` | Voice channel session data (legacy) |
| `guild_settings` | Per guild configuration settings |
| `level_roles` | Role-to-level mappings with grace periods |
| `role_drop_state` | Track when users dropped below role thresholds |
| `allowed_command_channels` | Command channel restrictions per guild |
| `youtube_channels` | YouTube subscriptions and metadata |

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

---

### 3. `voice_sessions`

Kept for compatibility; not actively used by current voice ticker implementation.

```sql
CREATE TABLE voice_sessions (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,    -- ms epoch when voice state recorded
  PRIMARY KEY (guild_id, user_id)
);
```

**Status**: Legacy table. Future features might use this instead of tracking in memory.

---

### 4. `guild_settings`

One row per guild storing all configuration options.

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
  
  updated_at INTEGER NOT NULL
);
```

**Default Values**:
| Setting | Default | Unit |
|---------|---------|------|
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

## Database Migrations

Migrations run automatically on bot startup (defined in `db.js`):

### Currently Applied Migrations:

1. **Reaction XP Support**
   - Added `reaction_xp` column to `guild_settings`
   - Added `reaction_cooldown_sec` column to `guild_settings`

2. **YouTube Channel Key Change**
   - Recreated `youtube_channels` table with composite primary key `(guild_id, id)` instead of just `id`
   - Allows same YouTube channel ID across different guilds

3. **Last Checked Timestamp**
   - Added `last_checked` column to `youtube_channels`

4. **XP Data Cleanup**
   - Normalizes all XP values: clamps Infinity/NaN/too large/negative
   - Ensures data integrity with safe JavaScript integer limits

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

## Performance Optimizations

### Indices in Place:
- `PRIMARY KEY` = automatic index
- `idx_activity_recent`: `(guild_id, user_id, kind, created_at)`
- `idx_activity_created_at`: `(created_at)`

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

## Security Considerations

### Data Exposure
- SQLite database is local-only (no network exposure)
- Contains Discord user IDs (not PII, but still sensitive)
- No passwords or API keys in database

### Backup Recommendations
```bash
# Automated daily backup
0 2 * * * sqlite3 /path/to/xpbot.sqlite ".backup '/backups/xpbot-$(date +\%Y\%m\%d).sqlite'"
```
