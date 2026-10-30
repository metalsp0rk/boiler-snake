# Database Schema

Deep dive into Boiler Snake's SQLite database structure and how data is organized.

## Overview

The bot uses **SQLite** with **WAL mode** for reliable single-writer/multi-reader access. All data is stored in a single file: `xpbot.sqlite` (located in the project root by default). Override with `DATA_DIR` (directory) or `DB_PATH` (full file path). Docker Compose uses `DATA_DIR=/data` with a named volume. Exactly **one bot process may own a given database file** — see [Single-Writer Contract](#single-writer-contract).

Since migration `034_communities` every formerly guild-scoped table keys on
`communities.id` (`community_id INTEGER`), not the raw platform id: a Discord
snowflake (or Fluxer id) is only ever stored in `communities.external_guild_id`
and resolved to the integer key first — see the `communities` section below and
[id resolution for ad-hoc queries](#common-queries-for-self-hosters). Every DDL
block below is the **live (post-migration) `sqlite_master` text**, not the
original per-migration `CREATE TABLE`.

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
| `communities` | One row per Discord guild / Fluxer community; owns the external snowflake, `id` is the `community_id` every other table keys on |
| `users` | Per-guild XP totals for each user |
| `activity_log` | Historical XP activity tracking for decay analysis |
| `guild_settings` | Per-guild configuration settings |
| `level_roles` | Role-to-level mappings with grace periods |
| `role_drop_state` | Track when users dropped below role thresholds |
| `allowed_command_channels` | Command channel restrictions per guild |
| `youtube_channels` | YouTube subscriptions and metadata |
| `twitch_channels` | Twitch broadcaster subscriptions + live/stream dedup state |
| `github_watches` | GitHub repos watched for releases + announcement routing/state |
| `rss_feeds` | RSS feed subscriptions per community + poll/dedup/backoff state (§8e) |
| `rss_seen` | Bounded per-feed announced-entry seen-sets for RSS dedup (§8f) |
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
| `gork_user_blocks` | Users blocked from using gork (AI Q&A) per guild |
| `gork_memories` | Gork community memory rows (per person; guild-scoped `#id` handles) |
| `gork_budget_rules` | Gork per-channel/category daily-limit rules (tri-state) |
| `gork_usage` | Gork daily usage counters (per user + winning scope + UTC day) |
| `gork_interactions` | Gork interaction log: one captured request/response per agent call (replay fixtures) |
| `bridges` | Channel-bridge relay row: `pending`/`active`/`broken` state machine, hashed connect code (§21) |
| `bridge_ends` | The two channel ends (a/b) of a bridge incl. envelope-encrypted relay webhook token |
| `bridge_outbox` | Durable outbound relay queue (create/edit/delete) with delivery state machine |
| `bridge_message_links` | Source message → destination message id map, one row per relayed part |
| `bridge_src_snapshots` | Last-relayed content hash per source message (edit-detection gate) |
| `bridge_connect_attempts` | Failed connect-miss window counter per destination community (lockout) |
| `user_links` | One Discord ↔ one Fluxer identity link with per-direction XP-mirror percentages (§22) |
| `user_link_codes` | Single-use 15-minute link codes — only SHA-256 hashes stored |
| `web_sessions` | Web admin console sessions + envelope-encrypted OAuth tokens (§23) |
| `admin_audit` | Durable admin audit trail: one row per mutating web/slash/system action |
| `guild_command_permission_oauth` | Per-community Discord OAuth grant for slash command permission sync (encrypted tokens) |
| `fluxer_oauth_transactions` | Single-use Fluxer web sign-in state (PKCE verifier, ≤10-minute lifetime) |
| `ticket_panels` | Posted ticket-panel messages managed via `/ticket panel` (§17) |
| `ticket_create_reservations` | Atomic ticket self-create rate-limit slot (#420) |
| `reaction_role_claims` | Per-emoji role-claim ledger — reaction removal can't strip a role another path granted (#433) |
| `twitch_eventsub_subs` | EventSub subscription ledger per (type, broadcaster), shared across guilds (§8d) |
| `automod_cases` | Staff referrals into auto-moderation: one case row per referral with per-community `A-n` number, referrer, referred message/channel, target user, note (case input), pipeline `status` (#726, epic #723), plus the harness run-metadata columns `last_model` / `last_duration_ms` / `last_tool_names` / `decision_log` / `last_run_error` (#728, `070`) |
| `applied_migrations` | Migration ledger: ordered id list of the last complete migration pass (§24) |
| `sqlite_sequence` | SQLite-internal AUTOINCREMENT high-water counter (not bot data) |
| `events` | Community events: title/status/times, post + retry bookkeeping, role gates (§20) |
| `event_options` | Signup options per event (capacity, waitlist, role whitelist; `position` orders buttons) |
| `event_signups` | One row per (event, option, user): `signed_up` / `waitlisted` |
| `event_notifications` | Queued reminder deliveries with delivery state machine + backoff |
| `event_mutes` | Per-user "don't ping me for this event" switch on the RSVP card |
| `event_guild_settings` | Per-community events settings: time zone, role gates, digests, Google auto-sync |
| `event_activity` | Append-only event action log backing the web calendar feed |
| `event_series` | Recurrence rules (daily/weekly/monthly) with next-occurrence cursor |
| `event_presets` | Saved signup-option groups per community (case-insensitive unique name) |
| `event_preset_options` | Options inside a saved preset (mirrors `event_options` fields) |
| `event_channels` | Marked event channels per community with optional purge opt-in |
| `event_wizards` | DM creation-wizard drafts, one per (community, user) |
| `event_google_links` | Per-user Google Calendar OAuth — envelope-encrypted tokens, never plaintext |
| `event_crossposts` | Cross-community crosspost pairs (invite-code approval, per-destination settings) |
| `event_crosspost_messages` | Destination message rows mapping crosspost copies to the source event |
| `automod_case_actions` | Auto-moderation case-action ledger: one suggested→claimed→terminal row per action a case took, refused, or failed against a considered user (#729, §25) |

---

## Detailed Table Specifications

### 0. `communities`

Root identity row per deployment-visible community, added by migration
`034_communities` (Discord guild or Fluxer server). Every table that used to
carry `guild_id TEXT` now carries `community_id INTEGER NOT NULL` pointing
here, and raw platform ids live **only** in `external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE communities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('discord', 'fluxer')),
  instance_key TEXT NOT NULL,          -- 'discord', or the normalized Fluxer origin
  external_guild_id TEXT NOT NULL,     -- snowflake that deployment issued
  elevated_permissions INTEGER NOT NULL DEFAULT 0,  -- Phase 0 MFA result, per instance, copied onto rows
  voice_states_complete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (platform, instance_key, external_guild_id)
);
```

Resolve a snowflake to the integer key with:

```sql
SELECT id FROM communities WHERE platform='discord' AND external_guild_id='123456789';
```

---

### 1. `users`

Stores XP totals for each user in each guild.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "users" (
  community_id INTEGER NOT NULL,
  user_id  TEXT NOT NULL,
  xp       INTEGER NOT NULL DEFAULT 0 CHECK (xp BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);
```

Since migration `040_schema_hygiene` the live table carries
`CHECK (xp BETWEEN 0 AND 9007199254740991)` — the documented `clampXpTotal`
domain, so TEXT/`Infinity` poisoned cells and out-of-range totals are rejected
by SQLite itself, not just by the JS clamps. Migration `034_communities`
re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve
snowflakes via `communities.external_guild_id`.

**Query patterns** (`?` for `community_id` is the integer id, not a snowflake):
```javascript
// Get a user's XP
SELECT xp FROM users WHERE community_id=? AND user_id=?

// Add XP (atomic via transaction)
UPDATE users SET xp = MIN(?, MAX(0, xp + ?)), updated_at = ?
WHERE community_id=? AND user_id=?

// Top 10 users
SELECT user_id, xp FROM users
WHERE community_id=? ORDER BY xp DESC LIMIT ?
```

**Indices**:
- Primary key on `(community_id, user_id)`
- `idx_users_guild_xp` on `(community_id, xp DESC, user_id)` — added by
  migration `040`: serves the slash and web leaderboard sorts without a
  temp B-tree (the name keeps "guild" for compatibility; the column is
  `community_id`)

---

### 2. `activity_log`

Tracks every XP-earning activity for decay analysis and future features.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "activity_log" (
  community_id INTEGER NOT NULL,
  user_id  TEXT NOT NULL,
  kind     TEXT NOT NULL, -- message|reaction|voice_minute
  amount   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_activity_recent
ON activity_log (community_id, user_id, kind, created_at);

CREATE INDEX idx_activity_created_at
ON activity_log (created_at);
```

Migration `034_communities` re-keyed this table from `guild_id TEXT` to
`community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

**Query patterns**:
```javascript
// Log a new activity
INSERT INTO activity_log (community_id, user_id, kind, amount, created_at)
VALUES (?, ?, ?, ?, ?)

// Count messages in time window (decay calculation)
SELECT COALESCE(SUM(amount), 0) AS c
FROM activity_log
WHERE community_id=? AND user_id=? AND kind='message' AND created_at >= ?

// Get recent voice XP
SELECT * FROM activity_log
WHERE kind='voice_minute' AND user_id=? ORDER BY created_at DESC LIMIT 10
```

**Data retention**: Logs accumulate indefinitely. Consider periodic cleanup for large servers.

**Note**: This is separate from staff [user activity](user-activity.md) counters (`user_channel_message_daily`), which count every human message regardless of XP cooldowns.

---

### 3. `voice_sessions` — retired

Removed by migration `040_schema_hygiene` (audit-2026-10 #204). The write-side
repository had zero wired callers, so the table never held rows on a
bot-managed DB; the paired code (repository, facade entries, and the web
voice page's DB-backed "sessions" panel) was removed in the same change.
Connected voice users are read live from the bot's voice-state cache
(cache-only web section) — nothing is persisted per session.

---

### 4. `guild_settings`

One row per guild storing all configuration options. Base columns come from migration `001`; later migrations add columns via `addColumnIfMissing`. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`, and migration `057_level_role_fk` rebuilt it again to declare the PK foreign key `PRIMARY KEY REFERENCES communities(id)`; the newest columns arrive with `065_gork_max_tool_rounds` (`gork_max_tool_rounds`, NULL = never set — the state that keeps `GORK_LLM_MAX_TOOL_ROUNDS` the fallback, #705) and `067_automod_guild_settings` (the `automod_*` auto-moderation family: master switch, channel, rules, seven per-action modes, timeout cap, daily case budget + UTC-day counter, breaker pause — #725). Resolve snowflakes via `communities.external_guild_id`. The live DDL below is `sqlite_master` text as rebuilt by `057`: post-`001` columns were appended by later migrations, so SQLite records them after `updated_at` in ALTER order — that trailing comma is real, not a typo.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "guild_settings" (
  community_id INTEGER NOT NULL PRIMARY KEY REFERENCES communities(id),

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
, reaction_xp INTEGER NOT NULL DEFAULT 2, reaction_cooldown_sec INTEGER NOT NULL DEFAULT 10, audit_log_channel_id TEXT, message_log_channel_id TEXT, event_reminder_channel_id TEXT, warn_dm_members INTEGER NOT NULL DEFAULT 1, ticket_category_id TEXT, ticket_archive_channel_id TEXT, ticket_rate_limit_minutes INTEGER NOT NULL DEFAULT 60, warn_log_channel_id TEXT, warn_expiry_days INTEGER NOT NULL DEFAULT 0, twitch_notification_channel_id TEXT, twitch_notify_role_id TEXT, twitch_polling_interval_minutes INTEGER NOT NULL DEFAULT 2, gork_keyword TEXT DEFAULT '@gork', gork_context_window INTEGER NOT NULL DEFAULT 10, gork_extra_rules TEXT NOT NULL DEFAULT '', gork_search_enabled INTEGER NOT NULL DEFAULT 1, gork_cooldown_sec INTEGER NOT NULL DEFAULT 180, gork_enabled INTEGER NOT NULL DEFAULT 1, gork_memory_enabled INTEGER NOT NULL DEFAULT 0, gork_memory_chars INTEGER NOT NULL DEFAULT 12000, gork_daily_limit INTEGER NOT NULL DEFAULT 0, gork_interaction_log_enabled INTEGER NOT NULL DEFAULT 1, gork_ste_enabled INTEGER NOT NULL DEFAULT 0, gork_summarize_input_tokens INTEGER NOT NULL DEFAULT 80000, gork_log_channel_id TEXT, honeypot_paused_at INTEGER, honeypot_pause_reason TEXT, gork_role_id TEXT, twitch_golive_template TEXT, rss_notification_channel_id TEXT, rss_notify_role_id TEXT, rss_polling_interval_minutes INTEGER NOT NULL DEFAULT 15, gork_max_tool_rounds INTEGER, automod_enabled INTEGER NOT NULL DEFAULT 0, automod_channel_id TEXT, automod_rules TEXT, automod_mode_no_action TEXT NOT NULL DEFAULT 'suggest', automod_mode_warn TEXT NOT NULL DEFAULT 'suggest', automod_mode_delete_message TEXT NOT NULL DEFAULT 'suggest', automod_mode_ticket TEXT NOT NULL DEFAULT 'suggest', automod_mode_timeout TEXT NOT NULL DEFAULT 'suggest', automod_mode_kick TEXT NOT NULL DEFAULT 'suggest', automod_mode_ban TEXT NOT NULL DEFAULT 'suggest', automod_timeout_cap INTEGER NOT NULL DEFAULT 3600, automod_daily_case_limit INTEGER NOT NULL DEFAULT 50, automod_cases_today INTEGER NOT NULL DEFAULT 0, automod_cases_day TEXT, automod_paused_at INTEGER, automod_pause_reason TEXT);
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
| `twitch_golive_template` | NULL | Per-guild custom Twitch go-live message template (`061`); `NULL` = built-in `**{streamer}** is live!` |
| `rss_notification_channel_id` | NULL | Channel for RSS new-entry alerts (`064`); NULL = the feature idles for the guild |
| `rss_notify_role_id` | NULL | Role mentioned on RSS new-entry posts (`064`); NULL = no mention (never an `@everyone` fallback) |
| `rss_polling_interval_minutes` | 15 | Per-community RSS poll interval, minutes 1–60 (`064`) |
| `gork_enabled` | 1 | Master gork switch (`0` = keyword triggers ignored, other settings kept) |
| `gork_keyword` | @gork | Trigger keyword; `NULL` = gork trigger disabled |
| `gork_role_id` | NULL | Role whose @mention also invokes gork (`/gork role`, issue #174); `NULL` = role path off (keyword is the master trigger switch) |
| `gork_context_window` | 10 | Prior messages used as answer context (1–50) |
| `gork_max_tool_rounds` | NULL | Per-guild gork tool-round budget (`/gork toolrounds`, 5–300, `065`); NULL = never set → global `GORK_LLM_MAX_TOOL_ROUNDS` (fallback 50) applies; drives the derived answer deadline |
| `gork_extra_rules` | (empty) | Extra staff rules appended to the answer prompt |
| `gork_search_enabled` | 1 | Gork web-search tool toggle (also needs `SEARXNG_URL`) |
| `gork_cooldown_sec` | 180 | Seconds between gork answers per user (`0` = off) |
| `gork_memory_enabled` | 0 | Community memory master switch (memory inert until on) |
| `gork_memory_chars` | 12000 | Memory-block char budget (`0` = unlimited) |
| `gork_daily_limit` | 0 | Guild-default gork daily budget: `-1` blocked, `0` unlimited, `1–1000` (clamped on write) |
| `gork_log_channel_id` | NULL | Dedicated gork Q&A log channel (`/gork logchannel`; NULL → fall back to audit log) |
| `gork_interaction_log_enabled` | 1 | Per-guild gork interaction-log switch (`/gork log on\|off`) |
| `gork_ste_enabled` | 0 | STE anti-slop answer-style toggle (`031`) |
| `gork_summarize_input_tokens` | 80000 | Per-guild `/gork summarize` input token budget (`033`) |
| `honeypot_paused_at` | NULL | Mass-ban safety-valve pause timestamp (`049`) |
| `honeypot_pause_reason` | NULL | Why the honeypot ban pipeline is paused (`049`) |
| `automod_enabled` | 0 | Auto-moderation master switch — default OFF, referrals refuse naming this cause (`067`, #725) |
| `automod_channel_id` | NULL | Case-card channel (`067`); NULL = cases refuse until set (clearing while enabled is allowed) |
| `automod_rules` | NULL | Rules text the judge applies (`067`); cap 4000 enforced service-side with an error, never truncated |
| `automod_mode_*` | 'suggest' | Per-action modes `off`/`suggest`/`auto` for the seven actions (`no_action`…`ban`, `067`); NO column for staff notes — always on (locked decision 4) |
| `automod_timeout_cap` | 3600 | Max automod-run timeout, seconds; command range 60–2,419,200 (28 days = Discord's ceiling), storage belt clamps (`067`) |
| `automod_daily_case_limit` | 50 | Daily case budget tri-state: `-1` blocked, `0` unlimited, `1–100000` (`067`) — separate from `gork_daily_limit` |
| `automod_cases_today` | 0 | Cases counted this UTC day (`067`); consumed once per ACCEPTED provider call — a provider failure does not count |
| `automod_cases_day` | NULL | `YYYY-MM-DD` UTC key of `automod_cases_today` (`067`); a differing day resets the counter (no ticker) |
| `automod_paused_at` | NULL | Persisted circuit-breaker pause timestamp (`067`) — a restart never silently re-arms auto kick/ban/timeout |
| `automod_pause_reason` | NULL | Why auto-moderation's irreversible arms are paused (`067`); cleared by `/automodconfig safety resume` (confirm) |
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
INSERT INTO guild_settings (community_id, updated_at)
VALUES (?, ?) ON CONFLICT(community_id) DO UPDATE SET updated_at=excluded.updated_at

// Get all settings for guild
SELECT * FROM guild_settings WHERE community_id=?

// Update specific settings
UPDATE guild_settings
SET msg_xp=@new_msg_xp, reaction_xp=@new_reaction_xp, updated_at=@now
WHERE community_id=@community_id
```

See also [Configuration](configuration.md), [Tickets](tickets.md), [Warnings](warnings.md).

---

### 5. `level_roles`

Stores role→level mappings with drop grace periods. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "level_roles" (
  community_id INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  level_required INTEGER NOT NULL,
  drop_grace_days INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, role_id)
);
```

**Example Data** (first column is now the integer `community_id`):
```sql
-- columns: community_id, role_id, level_required, drop_grace_days, created_at, updated_at
INSERT INTO level_roles VALUES
(123456789, 987654321, 5, 3, 1700000000000, 1700000000000),
(123456789, 555666777, 20, 7, 1700000000000, 1700000000000);
```

**Query patterns**:
```javascript
// Get all role mappings for guild
SELECT role_id, level_required, drop_grace_days
FROM level_roles WHERE community_id=? ORDER BY level_required ASC

// Insert or update mapping
INSERT INTO level_roles (community_id, role_id, level_required, drop_grace_days, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(community_id, role_id) DO UPDATE SET ...

// Delete mapping
DELETE FROM level_roles WHERE community_id=? AND role_id=?
```

---

### 6. `role_drop_state`

Tracks when users first dropped below a role's threshold (for grace period). Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`, and migration `057_level_role_fk` rebuilt it with FK coverage (issue #469): `community_id` references `communities(id)`, and a composite `(community_id, role_id)` FK references `level_roles` `ON DELETE CASCADE` — deleting a role mapping cleans its drop-state rows with it (after an idempotent orphan pre-clean).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "role_drop_state" (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER, -- ms epoch, NULL when not below
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id, role_id),
  FOREIGN KEY (community_id, role_id)
    REFERENCES level_roles (community_id, role_id) ON DELETE CASCADE
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
WHERE community_id=? AND user_id=? AND role_id=?

// Mark user as dropped (start timer)
INSERT INTO role_drop_state (community_id, user_id, role_id, below_since, updated_at)
VALUES (?, ?, ?, ?, ?) ON CONFLICT(...) DO UPDATE SET ...

// Clear drop state (user promoted back)
UPDATE role_drop_state SET below_since=NULL WHERE ...
```

---

### 7. `allowed_command_channels`

Command channel restrictions per guild. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "allowed_command_channels" (
  community_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, channel_id)
);
```

**Query patterns**:
```javascript
// Add allowed channel
INSERT OR IGNORE INTO allowed_command_channels (community_id, channel_id, created_at)
VALUES (?, ?, ?)

// Check if channel is allowed
SELECT EXISTS(SELECT 1 FROM allowed_command_channels
WHERE community_id=? AND channel_id=?)

// List all allowed channels
SELECT channel_id FROM allowed_command_channels WHERE community_id=?
ORDER BY created_at ASC

// Remove from allowed list
DELETE FROM allowed_command_channels WHERE community_id=? AND channel_id=?
```

Empty allow-list means commands are allowed everywhere. See [Command Restrictions](command-restrictions.md).

---

### 8. `youtube_channels`

YouTube channel subscriptions and metadata. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`. `last_live_id` / `last_checked_at` arrive with `046` / `047`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "youtube_channels" (
  community_id INTEGER NOT NULL,
  id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  channel_url TEXT NOT NULL,
  thumbnail_url TEXT,
  last_video_id TEXT,
  last_checked INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, last_live_id TEXT, last_checked_at INTEGER,
  PRIMARY KEY (community_id, id),
  UNIQUE(community_id, channel_name)
);
```

**Query patterns**:
```javascript
// Get all subscriptions for guild
SELECT id, community_id, channel_name, channel_url, thumbnail_url,
       last_video_id, last_checked
FROM youtube_channels WHERE community_id=?

// Add or update subscription
INSERT INTO youtube_channels (id, community_id, channel_name, channel_url,
                              thumbnail_url, last_video_id, last_checked, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(...) DO UPDATE SET ...

// Update last checked timestamp
UPDATE youtube_channels SET last_checked=?, last_video_id=?, updated_at=?
WHERE id=?
```

See [YouTube Notifications](youtube-notifications.md).

---

### 8b. `twitch_channels`

Twitch broadcaster subscriptions and live-state dedup. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`. Clip/VOD alert columns arrive with `032_twitch_eventsub_media`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "twitch_channels" (
    community_id INTEGER NOT NULL,
    broadcaster_id    TEXT NOT NULL,
    login             TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    profile_image_url TEXT,
    is_live           INTEGER NOT NULL DEFAULT 0,
    last_stream_id    TEXT,
    last_checked      INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL, notify_clips INTEGER NOT NULL DEFAULT 0, notify_vods INTEGER NOT NULL DEFAULT 0, last_clip_id TEXT, last_clip_created_at INTEGER, last_video_id TEXT, last_video_created_at INTEGER, notify_channel_id TEXT, notify_role_id TEXT, notify_offline INTEGER NOT NULL DEFAULT 0, last_offline_stream_id TEXT, last_offline_at INTEGER,
    PRIMARY KEY (community_id, broadcaster_id),
    UNIQUE (community_id, login)
  );
CREATE INDEX idx_twitch_channels_broadcaster
    ON twitch_channels(broadcaster_id);
```

**Query patterns**:
```javascript
// All subscriptions for the poller
SELECT community_id, broadcaster_id, login, display_name, profile_image_url,
       is_live, last_stream_id, last_checked
FROM twitch_channels ORDER BY created_at ASC

// Update live state after a poll
UPDATE twitch_channels
SET is_live=?, last_stream_id=?, last_checked=?, updated_at=?
WHERE community_id=? AND broadcaster_id=?
```

See [Twitch Stream Notifications](twitch-notifications.md).

---

### 8c. `github_watches`

Per-guild watched GitHub repositories for release announcements. `token`
(optional per-repo GitHub token) is stored **AES-256-GCM envelope-encrypted
at rest** (`v1`/`v2` envelope — #281 makes new writes `v2.<key-id>.…`, legacy `v1.…` stays readable; `TOKEN_ENCRYPTION_KEY` — audit C6, migration
039 back-encrypts pre-existing plaintext rows and fails boot loudly if the
key is missing while rows exist). It is never surfaced by display queries —
the ticker reads the decrypted value via `getAllGithubWatches()` only.
Migration `034_communities` re-keyed this table from `guild_id TEXT` to
`community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "github_watches" (
    community_id INTEGER NOT NULL,
    repo                      TEXT NOT NULL,
    repo_display              TEXT NOT NULL,
    channel_id                TEXT,
    role_id                   TEXT,
    token                     TEXT,
    last_release_id           INTEGER,
    last_release_published_at INTEGER,
    last_checked              INTEGER,
    created_at                INTEGER NOT NULL,
    updated_at                INTEGER NOT NULL,
    PRIMARY KEY (community_id, repo)
  );
CREATE INDEX idx_github_watches_channel
    ON github_watches(channel_id);
```

See [GitHub Release Notifications](github-releases.md).

---

### 8d. `twitch_eventsub_subs`

EventSub webhook subscription ledger (migration `032_twitch_eventsub_media`): one row per **(subscription type, broadcaster)** — the EventSub uniqueness constraint — not per guild: one `stream.online` / `stream.offline` subscription per broadcaster serves every guild tracking that channel. Rows are reconciler bookkeeping: `subscription_id` is Twitch's UUID (`NULL` until created), `status` mirrors the Twitch/local state (`pending` / `enabled` / `verification_pending` / `revoked:<reason>` / `error`), `last_error` carries the last create/delete failure for triage. Primary writer: `src/db/repositories/twitchEventsub.js` (driven by the Twitch feature's EventSub reconciler).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE twitch_eventsub_subs (
    type            TEXT NOT NULL,
    broadcaster_id  TEXT NOT NULL,
    subscription_id TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    last_error      TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (type, broadcaster_id)
  );
CREATE INDEX idx_twitch_eventsub_subs_broadcaster
    ON twitch_eventsub_subs(broadcaster_id);
```

See [Twitch Stream Notifications](twitch-notifications.md).

---

### 8e. `rss_feeds`

Per-community RSS/Atom feed subscriptions (migration `062_rss_feeds`, issue #305): one row per **(community, feed URL)** — the same URL in two communities is two independent rows, which is why the PK is `(community_id, url)` and not the URL alone. The row carries the subscription labels (`display_name`, resolved `feed_title`/`feed_link`), the conditional-GET validators (`etag`, `last_modified`), the watermark pair (`last_entry_key`, `last_checked`), and `failure_count` — the driver of the per-feed exponential backoff (NOT NULL DEFAULT 0: the backoff math multiplies off it every poll). Real `REFERENCES communities(id) ON DELETE CASCADE` (unlike 035/042's documentation-only references): a community's subscriptions are meaningless without it. `up` refuses to run before `034_communities`. Primary writer: `src/db/repositories/rss.js`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE rss_feeds (
  community_id   INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  url            TEXT    NOT NULL,
  display_name   TEXT,
  feed_title     TEXT,
  feed_link      TEXT,
  etag           TEXT,
  last_modified  TEXT,
  last_entry_key TEXT,
  last_checked   INTEGER,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  added_by       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (community_id, url)
);
```

See [RSS Feed Notifications](rss-notifications.md).

---

### 8f. `rss_seen`

Bounded per-feed seen-set for RSS entry dedup (migration `063_rss_seen`, issue #305): one row per **(community, feed, entry key)** already announced. The entry key is the item's guid/id when present, else its permalink link (a `sha256:` digest past 2048 chars) — so the column is plain TEXT: the schema guarantees uniqueness of whatever key the poller derived, nothing more. The PRIMARY KEY *is* the set semantics: `INSERT OR IGNORE` membership makes the poller's claim-before-send one-row race (ticker vs `/rss check`) announce exactly once. Bounded by contract: the repository prunes each feed's group to ~100 rows oldest-first after every poll; `idx_rss_seen_feed_prune` is exactly that access path. `ON DELETE CASCADE` matches `rss_feeds`; feed removal itself is an explicit repository delete (child-then-parent).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE rss_seen (
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  feed_url     TEXT    NOT NULL,
  entry_key    TEXT    NOT NULL,
  seen_at      INTEGER NOT NULL,
  PRIMARY KEY (community_id, feed_url, entry_key)
);
CREATE INDEX idx_rss_seen_feed_prune
  ON rss_seen (community_id, feed_url, seen_at);
```

See [RSS Feed Notifications](rss-notifications.md).

---

### 9. `honeypot_channels`

Channels configured as honeypots. Non-exempt users who post are banned. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "honeypot_channels" (
  community_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  warning_message_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, channel_id)
);
```

**Query patterns**:
```javascript
// Add honeypot channel
INSERT OR IGNORE INTO honeypot_channels (community_id, channel_id, created_at)
VALUES (?, ?, ?)

// Store / update warning message id
UPDATE honeypot_channels SET warning_message_id=? WHERE community_id=? AND channel_id=?

// Check if channel is a honeypot
SELECT 1 FROM honeypot_channels WHERE community_id=? AND channel_id=?

// List honeypot channels
SELECT channel_id, warning_message_id FROM honeypot_channels WHERE community_id=?
ORDER BY created_at ASC

// Remove honeypot
DELETE FROM honeypot_channels WHERE community_id=? AND channel_id=?
```

See [Honeypot](honeypot.md). Exemption is driven by [`staff_roles`](#10-staff_roles), not a separate table.

---

### 10. `staff_roles`

Guild-wide staff role allow-list. Powers the admin gate (`isStaff` / `requireStaff`), honeypot exemption, ticket channel overwrites (senior only), and related staff features.

Formerly `honeypot_exempt_roles`; migration `008_staff_roles` renames/merges legacy rows. Migration `011_staff_role_levels` adds `level`, `024_staff_roles_added_by` adds `added_by`. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "staff_roles" (
  community_id INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, level TEXT NOT NULL DEFAULT 'senior', added_by TEXT,
  PRIMARY KEY (community_id, role_id)
);
```

| Column | Description |
|--------|-------------|
| `community_id` | Internal `communities.id` (INTEGER) — resolves the Discord/Fluxer guild via `communities.external_guild_id` |
| `role_id` | Discord role snowflake |
| `level` | `junior` or `senior` (default `senior` for existing rows) |
| `added_by` | Staff who added the role (`024`); `NULL` = unknown |
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
INSERT INTO staff_roles (community_id, role_id, level, created_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(community_id, role_id) DO UPDATE SET level=excluded.level

// List all staff roles for guild
SELECT role_id, level, created_at FROM staff_roles
WHERE community_id=?
ORDER BY CASE level WHEN 'senior' THEN 0 ELSE 1 END, created_at ASC

// Remove staff role
DELETE FROM staff_roles WHERE community_id=? AND role_id=?
```

**Notes**:
- A member is staff (any level) if they have **any** role present in this table
- Honeypot channel posts and honeypot ban-role grants use the same exemption list
- There is no automatic exemption for Manage Server / Administrator from honeypots
- Configure via `/staff role add|remove|setlevel|list`

See [Staff Roles](staff-roles.md), [Honeypot](honeypot.md), [Tickets](tickets.md).

---

### 11. `honeypot_ban_roles`

Roles that ban a non-exempt member when **granted** (not retroactive for existing holders). Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "honeypot_ban_roles" (
  community_id INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, role_id)
);
```

**Query patterns**:
```javascript
// Add ban role
INSERT OR IGNORE INTO honeypot_ban_roles (community_id, role_id, created_at)
VALUES (?, ?, ?)

// List ban roles
SELECT role_id FROM honeypot_ban_roles WHERE community_id=?
ORDER BY created_at ASC

// Remove ban role
DELETE FROM honeypot_ban_roles WHERE community_id=? AND role_id=?
```

See [Honeypot](honeypot.md).

---

### 12. `reaction_role_panels`

Bot-owned panel messages for self-serve reaction roles. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "reaction_role_panels" (
  community_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Reaction Roles',
  description TEXT NOT NULL DEFAULT 'React to get a role. Remove your reaction to drop it (if allowed).',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, message_id)
);
```

---

### 13. `reaction_role_options`

Emoji → role mappings on a panel. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "reaction_role_options" (
  community_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  emoji_key TEXT NOT NULL,
  emoji_display TEXT NOT NULL,
  role_id TEXT NOT NULL,
  min_level INTEGER NOT NULL DEFAULT 0,
  removable INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, message_id, emoji_key)
);
```

**Query patterns**:
```javascript
// Look up option for a reaction
SELECT * FROM reaction_role_options
WHERE community_id=? AND message_id=? AND emoji_key=?

// List options for panel refresh
SELECT * FROM reaction_role_options
WHERE community_id=? AND message_id=?
ORDER BY created_at ASC
```

**Notes**:
- Deleting a panel also deletes its options
- Max 20 options per panel (enforced in application code)

See [Reaction Roles](reaction-roles.md).

---

### 13a. `reaction_role_claims`

Per-emoji role-claim ledger (migration `051_reaction_role_claims`, issue #433): one row per (community, user, message, emoji) whose reaction actually granted the role. When a reaction is removed the handler drops the role only if no other live option still claims it — so stripping one reaction can't revoke a role another panel/emoji granted. Primary writer: `src/db/repositories/reactionRoles.js` (claim on accepted reaction, unclaim on removal, bulk-pruned when an option/panel dies).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE reaction_role_claims (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji_key TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id, message_id, emoji_key)
);
CREATE INDEX idx_rrc_user
  ON reaction_role_claims(community_id, user_id);
```

See [Reaction Roles](reaction-roles.md).

---

### 14. Event reminder tables

Created by migration `006_event_reminders`. Also adds `guild_settings.event_reminder_channel_id`. Migration `034_communities` re-keyed `event_reminder_configs`, `event_reminder_optouts`, and `event_reminder_event_optouts` from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id` (`event_reminder_offsets` hangs off `config_id` and has no community column of its own).

#### `event_reminder_configs`

One config per Discord scheduled event (and unique shortname per guild).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "event_reminder_configs" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL,
  scheduled_event_id TEXT NOT NULL,
  shortname TEXT NOT NULL,
  role_id TEXT NOT NULL,
  channel_id TEXT,
  message_template TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL, persistent INTEGER NOT NULL DEFAULT 0,
  UNIQUE (community_id, scheduled_event_id),
  UNIQUE (community_id, shortname)
);
```

#### `event_reminder_offsets`

Scheduled fire times for a config; `sent_at` set when the reminder posts. The delivery state machine (`status` / `attempts` / `next_attempt_at` / `claimed_at` / `last_error`) arrives with `038_event_reminder_claim_state`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE event_reminder_offsets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id INTEGER NOT NULL REFERENCES event_reminder_configs(id) ON DELETE CASCADE,
  offset_minutes INTEGER NOT NULL,
  fire_at INTEGER NOT NULL,
  sent_at INTEGER,
  message_id TEXT
, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, claimed_at INTEGER, last_error TEXT);
CREATE INDEX idx_event_reminder_claimable
      ON event_reminder_offsets(status, next_attempt_at, fire_at)
      WHERE status IN ('pending','sending')
  ;
CREATE INDEX idx_event_reminder_due
  ON event_reminder_offsets(fire_at) WHERE sent_at IS NULL;
CREATE INDEX idx_event_reminder_offsets_config
  ON event_reminder_offsets(config_id);
```

#### `event_reminder_optouts`

Users who opted out of all event reminder role pings in a guild.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "event_reminder_optouts" (
  community_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  opted_out_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);
```

#### `event_reminder_event_optouts`

Per-event mute rows (independent of guild-wide opt-out). Created by migration `015_event_reminder_event_optouts`. Purged when the matching reminder config is cleared.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "event_reminder_event_optouts" (
  community_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  scheduled_event_id TEXT NOT NULL,
  muted_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id, scheduled_event_id)
);
CREATE INDEX idx_er_event_optouts_user
  ON event_reminder_event_optouts(community_id, user_id);
CREATE INDEX idx_er_event_optouts_event
  ON event_reminder_event_optouts(community_id, scheduled_event_id);
```

See [Event Reminders](event-reminders.md).

---

### 15. `staff_notes`

Private staff-only notes about guild members. Soft-delete only; sequential `note_number` per guild (refs like N-12). Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "staff_notes" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL,
  note_number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  edited_by TEXT,
  deleted_at INTEGER,
  deleted_by TEXT,
  UNIQUE (community_id, note_number)
);
CREATE INDEX idx_staff_notes_user
  ON staff_notes(community_id, user_id, created_at DESC);
CREATE INDEX idx_staff_notes_active
  ON staff_notes(community_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_staff_notes_guild_recent
  ON staff_notes(community_id, created_at DESC);
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

Formal permanent disciplinary records. Void only (no hard delete); sequential `warning_number` per guild (refs like W-12). Optional link to a staff note. Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "warnings" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL,
  warning_number INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  issuer_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  voided_at INTEGER,
  voided_by TEXT,
  void_reason TEXT,
  related_note_id INTEGER REFERENCES staff_notes(id) ON DELETE SET NULL, expires_at INTEGER, evidence_message_url TEXT, evidence_text TEXT,
  UNIQUE (community_id, warning_number)
);
CREATE INDEX idx_warnings_user
  ON warnings(community_id, user_id, created_at DESC);
CREATE INDEX idx_warnings_active
  ON warnings(community_id, user_id) WHERE voided_at IS NULL;
CREATE INDEX idx_warnings_expires
      ON warnings(expires_at)
      WHERE voided_at IS NULL AND expires_at IS NOT NULL;
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

Created by migration `010_tickets`, which also adds `ticket_category_id`, `ticket_archive_channel_id`, and `ticket_rate_limit_minutes` on `guild_settings`. The panel registry (`019_ticket_panels`) and the self-create rate-limit slot (`052_ticket_create_reservations`, issue #420) join it below.

#### `tickets`

Support ticket lifecycle, sensitive flag, and archive metadata (`archive_claimed_at` from `037_ticket_archive_claim`). Migration `034_communities` re-keyed this table from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`. The same cutover retired the legacy **global** `channel_id UNIQUE` (two communities could never share a ticket channel row) in favour of `UNIQUE (community_id, channel_id)`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "tickets" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL,
  ticket_number INTEGER NOT NULL,
  channel_id TEXT,
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
  archived INTEGER NOT NULL DEFAULT 0, archive_claimed_at INTEGER,
  UNIQUE (community_id, ticket_number)
,
  UNIQUE (community_id, channel_id)
);
CREATE INDEX idx_tickets_guild_status
  ON tickets(community_id, status);
CREATE INDEX idx_tickets_creator
  ON tickets(community_id, creator_user_id);
CREATE INDEX idx_tickets_creator_created
  ON tickets(community_id, creator_user_id, created_at);
CREATE INDEX idx_tickets_channel
  ON tickets(channel_id);
```

Migration `040_schema_hygiene` adds a partial index for the archived-ticket
listing — it matches the exact filter every archived read uses and the
community-scoped ORDER BY, so open tickets never touch it:

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE INDEX idx_tickets_archived
          ON tickets (community_id, closed_at DESC, ticket_number DESC)
          WHERE archived = 1 AND transcript_token IS NOT NULL
      ;
```

#### `ticket_members`

Extra member participants on a ticket (beyond the creator).

```sql
-- Live DDL (migrated schema, from sqlite_master)
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
-- Live DDL (migrated schema, from sqlite_master)
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
-- Live DDL (migrated schema, from sqlite_master)
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

#### `ticket_panels`

Registry of **posted ticket-panel messages** (migration `019_ticket_panels`): one row per panel message so `/ticket panel list|edit|delete` can find and manage them. Primary writer: `src/db/repositories/tickets.js` (`createTicketPanel` on post; update/delete handlers keep the row in step).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "ticket_panels" (
  community_id INTEGER NOT NULL,
  channel_id   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (community_id, message_id)
);
CREATE INDEX idx_ticket_panels_guild
  ON ticket_panels(community_id);
```

#### `ticket_create_reservations`

Atomic self-create rate-limit slot (migration `052_ticket_create_reservations`, issue #420): one row per (community, user) stamped `reserved_at` inside the create transaction — the INSERT itself is the reservation, so concurrent creates can't both pass the `ticket_rate_limit_minutes` gate. Primary writer: `src/db/repositories/tickets.js`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE ticket_create_reservations (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  reserved_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);
```

See [Help Ticket System](tickets.md).

---

### 18. User activity tables

Staff activity stats (independent of XP / `activity_log`). Created by migrations `013_user_channel_activity` and `014_guild_activity_backfill`. Migration `034_communities` re-keyed all six tables below from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

#### `user_channel_message_daily`

Per-user per-channel daily message counts. Counts every human guild message (no XP cooldown).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "user_channel_message_daily" (
  community_id INTEGER NOT NULL,
  user_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, user_id, channel_id, day)
);
CREATE INDEX idx_ucmd_day
  ON user_channel_message_daily (day);
CREATE INDEX idx_ucmd_user_day
  ON user_channel_message_daily (community_id, user_id, day);
CREATE INDEX idx_ucmd_user_channel
  ON user_channel_message_daily (community_id, user_id, channel_id);
```

#### `activity_ignore`

Channels or categories excluded from activity stats (`kind` is `channel` or `category`).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "activity_ignore" (
  community_id INTEGER NOT NULL,
  target_id  TEXT NOT NULL,
  kind       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, target_id)
);
CREATE INDEX idx_activity_ignore_guild
  ON activity_ignore (community_id);
```

#### `guild_activity_settings`

Live watermark (`collect_from_ms`) plus guild-wide backfill progress columns (added in `014`).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "guild_activity_settings" (
  community_id INTEGER NOT NULL PRIMARY KEY,
  collect_from_ms INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
, guild_backfill_status TEXT NOT NULL DEFAULT 'none', guild_backfill_started_at INTEGER, guild_backfill_finished_at INTEGER, guild_backfill_error TEXT, guild_backfill_channels_done INTEGER NOT NULL DEFAULT 0, guild_backfill_channels_total INTEGER NOT NULL DEFAULT 0, guild_backfill_messages_counted INTEGER NOT NULL DEFAULT 0);
```

#### `user_activity_meta`

Per-user backfill status for optional history scans.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "user_activity_meta" (
  community_id INTEGER NOT NULL,
  user_id                  TEXT NOT NULL,
  tracking_since_ms        INTEGER,
  backfill_status          TEXT NOT NULL DEFAULT 'none',
  backfill_started_at      INTEGER,
  backfill_finished_at     INTEGER,
  backfill_error           TEXT,
  backfill_channels_done   INTEGER NOT NULL DEFAULT 0,
  backfill_channels_total  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, user_id)
);
```

#### `user_channel_backfill_cursor`

Per-user per-channel history scan progress.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "user_channel_backfill_cursor" (
  community_id INTEGER NOT NULL,
  user_id           TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  oldest_message_id TEXT,
  complete          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, user_id, channel_id)
);
```

#### `guild_channel_backfill_cursor`

Guild-wide per-channel history scan progress (single-pass all users).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "guild_channel_backfill_cursor" (
  community_id INTEGER NOT NULL,
  channel_id        TEXT NOT NULL,
  oldest_message_id TEXT,
  complete          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, channel_id)
);
```

See [User Activity Summary](user-activity.md).

---

### 19. Gork tables

Access control, community memory, daily usage budgets, and the interaction log for [Gork](gork.md) (AI keyword Q&A). Created by migrations `022_gork_access`, `023_gork_memory`, `026_gork_budget`, and `027_gork_interaction_log`; all gork configuration lives as `gork_*` columns on [`guild_settings`](#4-guild_settings) (added by migrations `021`–`027`, `031`, `033`, `048`). Migration `034_communities` re-keyed all five tables in this section from `guild_id TEXT` to `community_id INTEGER`; resolve snowflakes via `communities.external_guild_id`.

#### `gork_user_blocks`

Users a guild has banned from using gork. Unlike the per-user cooldown, a block binds staff too (no bypass). Blocks are invisible to the blocked user (they get the locked LLM-failure canned reply), so this table is the only record.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "gork_user_blocks" (
    community_id INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (community_id, user_id)
  );
```

**Query patterns**:
```javascript
// Block a user (idempotent, same membership-table pattern as honeypot_ban_roles)
INSERT OR IGNORE INTO gork_user_blocks (community_id, user_id, created_by, created_at)
VALUES (?, ?, ?, ?)

// Check before answering
SELECT 1 AS ok FROM gork_user_blocks WHERE community_id=? AND user_id=?

// List blocked users for the guild (oldest first)
SELECT user_id, created_by, created_at FROM gork_user_blocks
WHERE community_id=? ORDER BY created_at ASC, user_id ASC

// Unblock (reports whether a row existed)
DELETE FROM gork_user_blocks WHERE community_id=? AND user_id=?
```

#### `gork_memories`

Community memory (roadmap §7.16): one row per (community, person, UTC day, normalized title). Memory stays fully inert until staff turn on `gork_memory_enabled` (default off).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "gork_memories" (
    id INTEGER PRIMARY KEY,                 -- rowid alias = the /gork memory "#id" handle
    community_id INTEGER NOT NULL,
    subject_user_id TEXT NOT NULL,
    mem_date TEXT NOT NULL,                 -- YYYY-MM-DD UTC, server-stamped
    title TEXT NOT NULL,                    -- display (model casing)
    title_key TEXT NOT NULL,                -- normalizeTitle() output (key half)
    body TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'profile',   -- profile|preference|project|relationship|event
    importance INTEGER NOT NULL DEFAULT 3,  -- 1..5
    source_message_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE(community_id, subject_user_id, mem_date, title_key)
  );
CREATE INDEX idx_gork_memories_subject
    ON gork_memories(community_id, subject_user_id);
```

| Column | Description |
|--------|-------------|
| `id` | Guild-scoped `#id` handle for `/gork memory` (rowid alias; reuse after eviction is acceptable) |
| `mem_date` | UTC day the memory belongs to (`YYYY-MM-DD`), stamped by the server |
| `title` | Display title keeping the model's casing |
| `title_key` | Normalized title — collision-key half (SQLite BINARY collation is case-sensitive, so it needs its own column) |
| `kind` | `profile` \| `preference` \| `project` \| `relationship` \| `event` |
| `importance` | 1–5 ranking weight (drives recall order and eviction) |
| `source_message_ids` | JSON array of source message ids (union-merged, capped at 20 newest) |
| `last_used_at` | ms epoch of last recall; `NULL` until first used |

**Query patterns**:
```javascript
// Same day+title_key updates in place (created_at / last_used_at survive)
INSERT INTO gork_memories (community_id, subject_user_id, mem_date, title_key, title,
                           body, kind, importance, source_message_ids, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(community_id, subject_user_id, mem_date, title_key) DO UPDATE SET ...

// One person's memories, newest first
SELECT * FROM gork_memories
WHERE community_id=? AND subject_user_id=? ORDER BY updated_at DESC, id DESC

// Guild-scoped fetch / delete by the "#id" handle
SELECT * FROM gork_memories WHERE community_id=? AND id=?
DELETE FROM gork_memories WHERE community_id=? AND id=?

// Wipe one person's memories, or the whole guild's
DELETE FROM gork_memories WHERE community_id=? AND subject_user_id=?
DELETE FROM gork_memories WHERE community_id=?
```

**Eviction**: each person's rows are capped (25 by default); overflow is deleted ranked by `importance DESC, COALESCE(last_used_at, updated_at) DESC, mem_date DESC, id DESC` — so recalling a memory (stamping `last_used_at`) protects it from eviction.

#### `gork_budget_rules`

Per-scope daily-limit overrides for the gork usage budget (roadmap §7.17). Resolution is **channel → category → guild default** (`guild_settings.gork_daily_limit`); the most specific rule wins and owns the single counter. Limits are tri-state and clamped on write — and since migration `040_schema_hygiene` enforced by the schema itself: `CHECK (daily_limit BETWEEN -1 AND 1000)`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "gork_budget_rules" (
    community_id INTEGER NOT NULL,
    scope_kind  TEXT NOT NULL,                -- 'channel' | 'category'
    target_id   TEXT NOT NULL,
    daily_limit INTEGER NOT NULL CHECK (daily_limit BETWEEN -1 AND 1000),             -- -1 blocked | 0 unlimited | 1..1000
    created_by  TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (community_id, scope_kind, target_id)
  );
```

#### `gork_usage`

Daily success counters: one row per (user, **winning** scope, UTC day). DB-backed on purpose — a restart must not refund budgets. `day` is the trigger message's UTC calendar date (`YYYY-MM-DD`, reset 00:00 UTC); guild-default scope rows store `scope_id='0'`. Days older than yesterday are pruned lazily on the increment path (no ticker).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "gork_usage" (
    community_id INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    scope_kind TEXT NOT NULL,                 -- 'channel' | 'category' | 'guild'
    scope_id   TEXT NOT NULL,                 -- channel/category id; '0' = guild default
    day        TEXT NOT NULL,                 -- UTC date 'YYYY-MM-DD'
    count      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (community_id, user_id, scope_kind, scope_id, day)
  );
CREATE INDEX idx_gork_usage_day
  ON gork_usage (day);
```

**Query patterns**:
```javascript
// Count one success (upsert +1) — called once per trigger after every reply
// chunk landed, before the guild queue slot is released
INSERT INTO gork_usage (community_id, user_id, scope_kind, scope_id, day, count)
VALUES (?, ?, ?, ?, ?, 1)
ON CONFLICT(...) DO UPDATE SET count = count + 1;
DELETE FROM gork_usage WHERE day < ?;   -- lazy prune (< yesterday), same write path

// Budget check (enqueue AND dequeue): used >= limit → bounce
SELECT count FROM gork_usage
WHERE community_id=? AND user_id=? AND scope_kind=? AND scope_id=? AND day=?
```

#### `gork_interactions`

Gork interaction log (E2E capture, session 2026-09-13): **one row per agent
call** — the exact prompts sent, sampling params, tool schemas, the guild
settings / context / roster / memory snapshots, the full per-round wire
transcript, and the raw + shipped answer. Default ON per guild
(`guild_settings.gork_interaction_log_enabled`, migration `027` adds it with
`DEFAULT 1`); staff opt out with `/gork log off`, and `GORK_INTERACTION_LOG=0`
is the process-wide kill-switch. Rows export as replay fixtures via
`scripts/export-gork-log.js`. See [Gork Interaction Logging](gork-logging.md).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "gork_interactions" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'qa',          -- qa | memory_turn
    parent_uid TEXT,                          -- memory_turn → qa uid
    community_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,                 -- trigger message
    user_id TEXT NOT NULL,                    -- asker
    status TEXT NOT NULL,                     -- shipped | partial | failure | error
    started_at INTEGER NOT NULL,
    duration_ms INTEGER,
    model TEXT,
    params TEXT,                              -- JSON: temperature,max_tokens,thinking_token_budget,max_tool_rounds,timeout_ms
    tools TEXT,                               -- JSON: tool schemas array actually sent (or null)
    settings TEXT,                            -- JSON: relevant guild_settings snapshot (keyword, context_window, cooldown, rules present?, search/memory flags)
    system_prompt TEXT,
    user_prompt TEXT,                         -- exact composed user content as sent
    trigger_content TEXT,                     -- RAW trigger message content (with keyword) for replay
    reply_to_message_id TEXT,                 -- message.reference?.messageId ?? null
    context_meta TEXT,                        -- JSON: {mode, collected, chars}
    context_messages TEXT,                    -- JSON: [{id,authorId,content,timestamp}] as buildContext collected
    roster_meta TEXT,                         -- JSON: {entries:n, truncated:n}
    roster_block TEXT,                        -- formatRosterBlock output as sent
    roster_entries TEXT,                      -- JSON: [{id,display,handle,nickname,roles?}] for replay member stubs
    memory_meta TEXT,                         -- JSON: {mode,indexed,selectedIds,blockChars} or null
    transcript TEXT,                          -- JSON: {events:[...], truncated:bool} — see event contract
    answer_raw TEXT,
    answer_shipped TEXT,                      -- post sanitize+cap, exactly what was posted
    finish_reason TEXT,
    usage TEXT,                               -- JSON provider usage
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL);
CREATE INDEX idx_gork_interactions_msg ON gork_interactions (community_id, message_id);
CREATE INDEX idx_gork_interactions_kind ON gork_interactions (kind, created_at);
CREATE INDEX idx_gork_interactions_uid ON gork_interactions (uid);
CREATE INDEX idx_gork_interactions_created ON gork_interactions (created_at); -- retention-prune scan
CREATE INDEX idx_gork_interactions_guild ON gork_interactions (community_id, created_at);
```

| Column | Description |
|--------|-------------|
| `uid` | External handle (`crypto.randomUUID`) for `--uid` export; `UNIQUE` so rows survive id churn |
| `kind` / `parent_uid` | `qa` = the keyword answer call; `memory_turn` = a memory-extraction call linked to its qa row via `parent_uid` |
| `status` | `shipped` (answer delivered / extraction got an ok LLM response) \| `partial` (tool-round cap hit but content still shipped) \| `failure` (canned LLM reply; memory_turn with no successful extraction response) \| `error` (job crashed) |
| `params` | JSON of the sampling params actually sent — **camelCase keys**: `temperature`, `maxTokens`, `timeoutMs`, `maxToolRounds`, `thinkingTokenBudget` (memory_turn rows add the extraction outcome: `stored`, `skippedInvalid`) |
| `system_prompt` / `user_prompt` | Byte-exact prompt strings as placed on the wire (memory_turn rows leave these `NULL`; their extraction prompts ride inside `transcript` request events) |
| `trigger_content` / `reply_to_message_id` | The raw trigger message + reply reference, so a fixture can re-drive the pipeline |
| `context_*` / `roster_*` / `memory_meta` | As-collected snapshots (replayable: ids, authors, contents, roster handles) |
| `transcript` | Ordered `{events, truncated}` capture of `request`/`response`/`tool` events per round and attempt (oldest events dropped first to stay under `GORK_INTERACTION_LOG_MAX_JSON_CHARS`) |
| `answer_raw` / `answer_shipped` | Model output vs. what was actually posted (sanitize + cap applied) |
| `created_at` | Epoch ms; the lazy retention prune (per insert, `GORK_INTERACTION_LOG_RETENTION_DAYS`, default 30) deletes `created_at < cutoff` — served by `idx_gork_interactions_created` |

**Query patterns**:
```javascript
// Insert (recorder finalize) — JSON columns arrive already-stringified;
// a successful insert lazily prunes the retention window in the same call
INSERT INTO gork_interactions (uid, kind, parent_uid, community_id, ...) VALUES (?, ?, ?, ?, ...)

// Staff listing: summaries ONLY (no prompt/transcript blobs), newest first
SELECT id, uid, kind, status, model, user_id, channel_id, message_id,
       duration_ms, tool_call_count, created_at, error
FROM gork_interactions WHERE community_id=? ORDER BY id DESC LIMIT ?

// Full row (incl. transcript) for export/replay — by the uid handle
SELECT * FROM gork_interactions WHERE uid=?

// /gork status / /gork log row counts; wipe one guild's log
SELECT COUNT(*) FROM gork_interactions WHERE community_id=?
DELETE FROM gork_interactions WHERE community_id=?
```

See [Gork (AI Keyword Q&A)](gork.md) and [Gork Interaction Logging](gork-logging.md).

---

### 20. Community events tables

Bot-owned events with button RSVPs (migrations `042`–`045`; feature guide: [Community Events](community-events.md)). All ids are `INTEGER PRIMARY KEY AUTOINCREMENT` unless noted; all times are epoch ms.

| Table | Purpose — notable columns |
|---|---|
| `events` | The event: `community_id`, `creator_id`, `title`, `status` (`draft` / `pending_confirm` / `posted` / `archived` / `skipped` — `skipped` = a series occurrence the organizer skipped), `start_at`, `end_at`, `duration_minutes`, `channel_id`, `message_id`, `thread_id`, `post_at` (scheduled post), `cutoff_at`, `location`, `image_url`, `color`, `announce_role_ids` (JSON), `attendee_role_id` + `attendee_role_existing`, `role_mode` (`none` / `temp` / `existing`), `role_whitelist`, `multiple_signups`, `thread_enabled`, `thread_private`, `series_id` (set on series occurrences), post-retry bookkeeping (`post_attempts`, `next_attempt_at`, `last_post_error`). |
| `event_options` | Signup options per event (`label`, `emoji`, `position`, `capacity` — 0 unlimited, `waitlist_on`, `reminders_on`, `role_whitelist` JSON). `position` orders the buttons. |
| `event_signups` | One row per (event, option, user) — `UNIQUE (event_id, option_id, user_id)` — with `state` (`signed_up` / `waitlisted`) and `updated_by` (who flipped the row). |
| `event_notifications` | Queued reminder deliveries: `event_id`, `offset_minutes`, `fire_at`, `message`, `target` (`attendees` / `role` + `role_id`), `status` (`pending` / `sending` / `sent` / `failed` / `retired`), `attempts`, `next_attempt_at` (backoff), `claimed_at` (claim TTL anchor), `sent_at`, `message_id`, `last_error`. |
| `event_mutes` | Per-user, per-event reminder mute, PK `(community_id, event_id, user_id)` — the "don't ping me for this event" switch on the RSVP card. |
| `event_guild_settings` | One row per community (`community_id` PK): `time_zone` (IANA), `default_reminder_minutes`, `show_attendees`, `thread_reminders`, `auto_archive` + `auto_archive_delay_minutes`, `reminder_channel_id`, `digest_channel_id` + `digest_frequency` (`none` / `daily` / `weekly`) + `digest_hour_utc` + `digest_weekday` + `digest_last_sent_at`, role gates `create_role_id` / `edit_role_id` / `delete_role_id` / `channels_role_id` / `options_role_id`, Google auto-sync `google_auto_user_id` + `google_auto_enabled`, `updated_at`. |
| `event_activity` | Append-only event log (`event_id`, `actor_id`, `action`, `detail`, `created_at`) — backs the web calendar activity feed. |
| `event_series` | Recurrence: `template_event_id` (the occurrence that seeded the series), `cadence` (`daily` / `weekly` / `monthly`), `weekdays` JSON (0=Sun…6=Sat), `month_day`, `time_of_day_min`, `end_mode` (`never` / `count` / `until`) + `end_count` / `end_at`, `next_occurrence_at` cursor, `occurrences_created`, `status` (`active` / `stopped`). |
| `event_presets` + `event_preset_options` | Saved signup-option groups per community (`name` unique per community, `COLLATE NOCASE`; options carry label/emoji/capacity/waitlist/reminders/whitelist). |
| `event_channels` | Marked event channels per community, PK `(community_id, channel_id)`, with `purge` opt-in flag (E7). |
| `event_wizards` | DM creation-wizard state, one row per `(community_id, user_id)`: current `step`, partial answers JSON (`draft`), optional `event_id` for edit mode, `started_at` / `updated_at`. |
| `event_google_links` | Per-user Google OAuth, `UNIQUE (community_id, user_id)`: `access_token_enc` / `refresh_token_enc` (AES-256-GCM envelope, `TOKEN_ENCRYPTION_KEY`; refresh NULL for manual grants), `email`, `calendar_id` (default `primary`), `expiry`, `enabled`. The guild's auto-sync calendar is the `event_guild_settings` pair `google_auto_user_id` + `google_auto_enabled`. |
| `event_crossposts` + `event_crosspost_messages` | Cross-community pairs: `invite_code` (UNIQUE — the destination approves with it), `source_community_id` / `dest_community_id` + `dest_channel_id`, `state` (`pending` / `active` / `revoked`), `mentions` (per-destination announce role ids, JSON), per-destination `role_whitelist` (signup gate), `post_offset_minutes`, `created_by` / `approved_by` / timestamps, `UNIQUE (source_community_id, dest_community_id)`; message rows (PK `(crosspost_id, event_id)`) map destination copies to the source event via `dest_message_id`. |

The personal reminder opt-out is one row per user in feature 2's opt-outs table, written only by `/eventreminder optout`. `/eventconfig reminders off|on` is a different mechanism entirely: it toggles `event_guild_settings.default_reminder_minutes` for the whole guild (#348 corrected the command copy that conflated the two).

---

### 21. Bridge relay tables

The six tables behind the [channel bridge](bridge.md) (relay between a Discord channel and a Fluxer channel), created together by migration `035_bridges`. **`src/db/repositories/bridges.js` is the only module that reads or writes them** — bridge deletes are explicit child-then-parent cascades in one transaction (`deleteBridgeCascade()`), never FK-driven. The connect service (`src/features/bridge/service.js`) owns the `pending → active` compare-and-swap; the relay pipeline (`src/features/bridge/relay.js`) drives the queue through the repository.

#### `bridges`

One row per bridge: state machine `pending` / `active` / `broken`, one-way or both direction (`a` = the create side), and the hashed connect code. The plaintext connect code is never stored — only `code_hash` (SHA-256); `expires_at` is enforced by `connect` itself and a sweeper GCs expired `pending` rows. Primary writer: `src/db/repositories/bridges.js` (`/bridge create`).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE bridges (
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'broken')),
  direction TEXT NOT NULL DEFAULT 'both'
    CHECK (direction IN ('both', 'a_to_b', 'b_to_a')),   -- a = create side (KD 19)
  created_at INTEGER NOT NULL,
  expires_at INTEGER,               -- connect enforces this itself; sweeper GCs pending rows
  connected_at INTEGER,
  code_hash BLOB,                   -- SHA-256(canonical code); kept on active rows until disconnect
  created_by_user_id TEXT NOT NULL, -- external id, scoped by end A community; display-only
  last_error TEXT,
  broken_reason TEXT
);
```

#### `bridge_ends`

The two channel ends of a bridge (`position` `a`/`b`): which community channel participates, its posture flags (`nsfw`, `everyone_denied_view`), and the relay webhook pair each end posts through. `webhook_token_enc` holds **only** an AES-256-GCM envelope of the webhook token — `v2.<key-id>.…` writes, legacy `v1.…` readable, converged forward on relay reads (#281) (`src/features/bridge/tokenCrypto.js`, key `BRIDGE_TOKEN_KEY`) — never plaintext. `UNIQUE (community_id, channel_id)` pins a channel to at most one bridge. Primary writer: the connect flow in `src/features/bridge/service.js` (ends created by the repository).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE bridge_ends (
  bridge_id INTEGER NOT NULL REFERENCES bridges(id),
  position TEXT NOT NULL CHECK (position IN ('a', 'b')),
  community_id INTEGER NOT NULL REFERENCES communities(id),
  channel_id TEXT NOT NULL,
  webhook_id TEXT,
  webhook_token_enc TEXT,           -- AES-256-GCM envelope; never plaintext
  upload_limit_bytes INTEGER,
  nsfw INTEGER NOT NULL DEFAULT 0,
  everyone_denied_view INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bridge_id, position),
  UNIQUE (community_id, channel_id) -- a channel is in at most one bridge
);
```

#### `bridge_outbox`

The durable outbound relay queue: one row per pending operation (create / edit / delete of a source message, per direction) with a delivery state machine (`pending | sending | done | failed`), attempt counter, and `last_error`. `payload_json` carries only metadata + attachment descriptors — no CDN URLs, no tokens, no credentials. Survives restarts by design; the supervisor drains it through the repository. Primary writer: `src/db/repositories/bridges.js` (enqueue paths).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE bridge_outbox (
  id INTEGER PRIMARY KEY,
  bridge_id INTEGER NOT NULL REFERENCES bridges(id),
  direction TEXT NOT NULL CHECK (direction IN ('a_to_b', 'b_to_a')),
  kind TEXT NOT NULL DEFAULT 'create'
    CHECK (kind IN ('create', 'edit', 'delete')),
  src_message_id TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  state TEXT NOT NULL,              -- pending | sending | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,       -- metadata + attachment descriptors; no CDN URLs,
                                    -- no tokens, no credential
  dest_message_id TEXT,             -- first destination execute only; full set in links
  last_error TEXT,
  UNIQUE (bridge_id, direction, src_message_id, kind)
);
CREATE INDEX idx_bridge_outbox_queue
  ON bridge_outbox (bridge_id, direction, state, enqueued_at);
CREATE INDEX idx_bridge_outbox_settled
  ON bridge_outbox (state, enqueued_at);
```

#### `bridge_message_links`

Provenance map from a source message to every destination message copy: one row per relayed part (`part_index` is the 0-based chunk / overflow-file execute). Edits and deletes fan out by looking up all parts of the source message. Primary writer: `src/db/repositories/bridges.js` (called by the relay after a successful destination execute).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE bridge_message_links (
  bridge_id INTEGER NOT NULL,
  src_community_id INTEGER NOT NULL,
  src_message_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,      -- 0-based chunk / overflow-file execute
  dst_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (bridge_id, src_community_id, src_message_id, part_index)
);
CREATE INDEX idx_bridge_message_links_created
  ON bridge_message_links (created_at);
```

#### `bridge_src_snapshots`

Edit-detection gate: the SHA-256 `content_hash` of the **canonical relay payload** last relayed for a source message. The relay re-enqueues an edit only when the recomputed hash differs (pin/flag changes alone never re-relay). Primary writer: `src/db/repositories/bridges.js` (upsert from `src/features/bridge/relay.js`).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE bridge_src_snapshots (
  bridge_id INTEGER NOT NULL,
  src_message_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,       -- SHA-256 of the canonical relay payload
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bridge_id, src_message_id)
);
```

#### `bridge_connect_attempts`

Lockout counter for wrong-code connects: one row per **destination** community holding the current failure window (`window_started_at` + `failures`). The first miss starts a window, a repeated miss within the window escalates, and an elapsed window is replaced (the 10-minute reset); repeated misses lock the destination out of `connect`. Primary writer: `src/db/repositories/bridges.js` (`recordBridgeConnectMiss`).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE bridge_connect_attempts (
  community_id INTEGER PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  failures INTEGER NOT NULL
);
```

---

### 22. Account linking tables

Discord ↔ Fluxer account linking (migration `036_user_links`; feature guide: [Account Linking](account-linking.md)). Sole writer: `src/db/repositories/userLinks.js`.

#### `user_links`

One row binding exactly one Discord-side identity to one Fluxer-side identity — both sides are `UNIQUE`, so a user is in at most one link. `mirror_a_to_b_pct` / `mirror_b_to_a_pct` set the per-direction XP mirror percentage; `mirror_memory` toggles gork-memory mirroring.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE user_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id_a INTEGER NOT NULL,          -- one side (e.g. Discord community)
  user_id_a      TEXT NOT NULL,             -- external user id in that community's platform
  community_id_b INTEGER NOT NULL,          -- other side (e.g. Fluxer community)
  user_id_b      TEXT NOT NULL,
  mirror_a_to_b_pct INTEGER NOT NULL DEFAULT 100,  -- XP earned in A → mirrored to B
  mirror_b_to_a_pct INTEGER NOT NULL DEFAULT 100,
  mirror_memory INTEGER NOT NULL DEFAULT 1,       -- gork memory mirroring on/off
  created_at INTEGER NOT NULL,
  UNIQUE (community_id_a, user_id_a),
  UNIQUE (community_id_b, user_id_b)
);
CREATE INDEX idx_user_links_a_lookup
  ON user_links (user_id_a, community_id_a);
CREATE INDEX idx_user_links_b_lookup
  ON user_links (user_id_b, community_id_b);
```

#### `user_link_codes`

The handoff ticket for linking: the plaintext code is shown to its creator on a private surface only (ephemeral reply on Discord, DM on Fluxer) — the row stores just its SHA-256 `code_hash`, bound to the creating community + user, valid 15 minutes, `used_at` stamps the single redemption on the other side. Expired rows ride `idx_user_link_codes_expires_at` into cleanup.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE user_link_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,           -- SHA-256 of the plaintext code
  community_id INTEGER NOT NULL,            -- community where the code was CREATED
  user_id TEXT NOT NULL,                    -- external user id at creation side
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,              -- now + 15 min
  used_at INTEGER                           -- NULL until redeemed (single use)
);
CREATE INDEX idx_user_link_codes_expires_at
  ON user_link_codes (expires_at);
```

---

### 23. Web console & OAuth state tables

Server-side state for the [web admin console](web-admin.md) and the OAuth flows that gate it. Keys differ per table: the session id, its own append-only id, the `community_id` (command-permission grant), or the OAuth state nonce.

#### `web_sessions`

Session store for the web console: opaque random `id` (the cookie value), sliding `expires_at` with an absolute cap anchored at `created_at`, and `platform` + `instance_key` (migration `034`) so one table serves Discord and Fluxer sign-ins. The OAuth token columns (`030` + `034`) hold **AES-256-GCM `v1.` envelopes, never plaintext** — access/refresh tokens for the signed-in user, encrypted with the HKDF-derived key from `src/web/auth/tokens.js` (rooted at `SESSION_SECRET`); rotating the secret just forces re-login. Primary writer: `src/db/repositories/webSessions.js` (driven by `src/web/auth`).

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE web_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  discord_tag  TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
, access_token_enc TEXT, token_expires_at INTEGER, scopes TEXT, guild_snapshot TEXT, platform TEXT NOT NULL DEFAULT 'discord', instance_key TEXT NOT NULL DEFAULT 'discord', refresh_token_enc TEXT, refresh_expires_at INTEGER);
CREATE INDEX idx_web_sessions_expires_at
  ON web_sessions(expires_at);
CREATE INDEX idx_web_sessions_user
  ON web_sessions(user_id);
```

#### `admin_audit`

The durable admin audit trail (migration `029`): one row per mutating web / slash / system action — `origin` CHECK, actor, target, and a `details_json` payload whose credential-shaped keys are **masked** before insert (`src/core/auditTrail.js`). Staff browse it at `/g/:guildId/audit` in the web console; a yearly retention prune (indexed by `056`) bounds growth. Primary writers: `recordSlashAudit` / `recordSystemAudit` in `src/core/auditTrail.js` → `src/db/repositories/adminAudit.js`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "admin_audit" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL,
  actor_user_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('web', 'slash', 'system')),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_admin_audit_guild_created
  ON admin_audit(community_id, created_at);
CREATE INDEX idx_admin_audit_created_at
  ON admin_audit (created_at);
```

#### `guild_command_permission_oauth`

The per-community Discord OAuth grant behind slash-command permission sync (`016_command_permission_oauth`): `refresh_token` / `access_token` are stored **envelope-encrypted** (`v1`/`v2` — #281, `TOKEN_ENCRYPTION_KEY` via `src/core/thirdPartyTokens.js`; migration `039` back-encrypts pre-encryption rows), plus sync bookkeeping (`last_sync_at` / `last_sync_error`). The grant is obtained by the `/staff syncpermissions` OAuth flow. Primary writer: `src/db/repositories/commandPermissionOauth.js`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE "guild_command_permission_oauth" (
      community_id INTEGER NOT NULL PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      access_expires_at INTEGER,
      authorized_by_user_id TEXT,
      last_sync_at INTEGER,
      last_sync_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
```

#### `fluxer_oauth_transactions`

Single-use server-side state for a Fluxer web sign-in (created in `034`): the row ties the `nonce` already embedded in the signed OAuth `state` to its PKCE `code_verifier` and instance, expiring at `min(state exp, now + 10 minutes)`. Redemption is compare-and-delete, so a state can never be replayed; expired rows are pruned lazily and by the retention sweep. Primary writer: `src/db/repositories/fluxerOAuthTransactions.js`.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE fluxer_oauth_transactions (
  nonce TEXT PRIMARY KEY,          -- the nonce already inside the signed state
  code_verifier TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL      -- min(state exp, now + 10 minutes)
);
```

---

### 24. Migration ledger & SQLite internals

#### `applied_migrations`

Not feature data — the migration **ledger** audited in [Schema version tracking](#schema-version-tracking-pragma-user_version): the ordered `id` list of the last complete migration pass, rebuilt transactionally with the `user_version` stamp. The boot fast-skip requires `user_version` AND this ledger to agree with the registry; on disagreement the idempotent full replay runs and re-stamps both (audit #394). Writer: `src/db/migrate.js` only.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE applied_migrations (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
```

#### `sqlite_sequence`

SQLite's own bookkeeping (auto-created by the first `AUTOINCREMENT` insert): one row per AUTOINCREMENT table with its high-water mark. Not bot data; never touched by application code.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE sqlite_sequence(name,seq);
```

---

### 25. Auto-moderation tables

#### `automod_case_actions`

One row per sanction a case **suggested, executed, refused, or failed** to execute against a considered user (migration `069_automod_case_actions`, issue #729, epic #723). This is the intent/commit ledger the executor claims and finalizes — the automod sibling of the atomic `ticket_create_reservations` slot: transitions are single-statement conditional UPDATEs (or the claim INSERT against the UNIQUE slot index), so a double Approve click or an auto re-entry can never re-run a Discord mutation. Primary writer: `src/db/repositories/automodCaseActions.js` (executor: `src/features/automod/executor.js`; readers: the case card #730 and the staff-note commit #731 — an existing row IS the "considered" flag, every state counts).

`case_id` is a NULLABLE plain INTEGER **without** a foreign key: the `automod_cases` table ships in the concurrent referral issue (#726) and this ledger links by value, never by constraint. The state machine (`suggested`→`approved`→`executed`/`refused`/`failed`, or `suggested`→`dismissed`) is pinned by both the CHECK below and `AUTOMOD_ACTION_STATES` in the repository. `params_json` stores the EFFECTIVE (post-timeout-clamp) params — the row echoes the duration actually applied.

```sql
-- Live DDL (migrated schema, from sqlite_master)
CREATE TABLE automod_case_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  case_id INTEGER,
  guild_id TEXT,
  subject_user_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('no_action','warn','delete_message','ticket','timeout','kick','ban')),
  mode TEXT NOT NULL CHECK (mode IN ('off','suggest','auto')),
  state TEXT NOT NULL DEFAULT 'suggested' CHECK (state IN ('suggested','approved','dismissed','executed','refused','failed')),
  params_json TEXT,
  result_text TEXT,
  error_text TEXT,
  claimed_by TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_automod_case_actions_case
  ON automod_case_actions(community_id, case_id) WHERE case_id IS NOT NULL;
CREATE INDEX idx_automod_case_actions_subject
  ON automod_case_actions(community_id, subject_user_id) WHERE subject_user_id IS NOT NULL;
CREATE UNIQUE INDEX ux_automod_case_actions_slot
  ON automod_case_actions(community_id, case_id, action, IFNULL(subject_user_id,''))
 WHERE case_id IS NOT NULL;
```

---

## Database Migrations

Migrations run **automatically** when the db module loads (`src/db/migrate.js` via `src/db/index.js` / the `src/db.js` facade). Steps live under `src/db/migrations/` and are written to be **idempotent** (`CREATE TABLE IF NOT EXISTS`, `addColumnIfMissing`, gated rebuilds, no-op cleanups).

There is no separate manual migration CLI for normal operation: starting the bot (or any process that loads the db) applies all steps in order.

### Schema version tracking (`PRAGMA user_version`)

Since the 2026-10 audit (#202) the database records a schema version in SQLite's `PRAGMA user_version` header field:

- **The version is the registry size.** The ordered list in `src/db/migrate.js` is append-only (same rule as the numbered files); with `001`–`070` registered the version is `70`.
- **Full replay stays the correctness mechanism.** Every migration is idempotent, so `runMigrations()` replays the entire set whenever the recorded version does not match the registry, and stamps `user_version` only after the whole pass succeeds.
- **`user_version` is a fast-skip record, not a per-migration cursor.** When the recorded version equals the registry size AND the `applied_migrations` ledger agrees (below), the replay is skipped entirely (one boot log line). Databases created before the guard have `user_version = 0`: they get one idempotent full replay and are stamped — every boot after that is a skip.
- **The `applied_migrations` ledger records WHAT ran (audit #394).** A count can never record a set: a length-preserving registry change (reorder, or a swap that keeps the list the same size) leaves `user_version` identical and would fast-skip a replay the changed registry needs. The ledger (`seq`/`id`/`applied_at`) stores the ORDERED id list of the last complete pass and is rebuilt transactionally with the version stamp — a crashed pass leaves neither honest. The fast-skip requires both records to agree; on disagreement (including legacy DBs with no ledger yet) the idempotent replay runs once and re-stamps both.
- **Partial versions are never trusted.** A crash *between* migrations (exactly the non-transactional data-move 003 represented, later hardened against in 034) leaves the older version recorded, so the next boot re-runs the full idempotent set instead of resuming from a cursor.
- **Downgrades fail loud.** If `user_version` is *higher* than the registered migrations (old code against a newer database), boot throws with both version numbers named and refuses to modify anything.
- **Legacy drift heals via NEW migrations, never via re-runs.** The fast-skip plus per-migration idempotence gates mean a step whose guard says "already done" never re-evaluates — so a database left in a *historically partial* state by an old version of a migration file can only converge through a NEW migration written for that state. That is exactly what `041_heal_partial_community_cutover` is for (audit #285): `034_communities` gates its rebuild block on `users` still having `guild_id`, and DBs whose `users` was cut over by a pre-fix 034 kept stragglers (e.g. `youtube_channels` on `guild_id TEXT`, breaking every repository query on `community_id`). 041 detects any surviving guild-scoped straggler and rebuilds it with 034's DDL-derivation discipline; on healthy databases it is a pure no-op.

There is deliberately no down-migration story — fix-forward SQLite with the backup discipline below (per the 2026-10 audit).

### Connection PRAGMAs (explicit)

`src/db/connection.js` sets every runtime pragma explicitly at open. Each value matches what the bot already ran with under ambient library defaults; they are written down so a library upgrade cannot silently change behaviour, and `test/migrations-user-version.test.js` pins them:

| PRAGMA | Value | Why |
|--------|-------|-----|
| `journal_mode` | `WAL` | Readers never block the writer; `-wal`/`-shm` sidecars live beside the DB (see below) |
| `foreign_keys` | `ON` | FK enforcement. better-sqlite3 opened connections with this ON already — the bot's effective value never changes, it is now explicit. Migration 034 toggles it OFF around its own table rebuilds and restores it |
| `synchronous` | `FULL` | Durable on every commit (SQLite's own default, kept) |
| `busy_timeout` | `5000` | Wait up to 5 s on a locked DB instead of erroring instantly — a safety valve for a brief overlap (e.g. an `sqlite3` CLI `.backup`), **not** a licence to run a second writer |

`user_version` itself is managed by `src/db/migrate.js`, not at connect time.

### Single-writer contract

**One process per SQLite file. Ever.** The bot opens exactly one read-write connection per process (better-sqlite3 is synchronous), and everything built on the database — migration replay on boot, claim/CAS patterns for tickets, reminders and the bridge outbox — assumes an exclusive writer.

Concretely this means:

- Do **not** run two bot processes, two containers, or a staging and a production deployment against the same `DB_PATH` / shared volume. WAL lets *readers* coexist with the single writer inside cooperating processes on one machine; it is not a multi-writer or multi-host coordination mechanism.
- Short-lived external access is fine: an `sqlite3` CLI session or a `.backup` run rides on WAL's reader support (and `busy_timeout` absorbs a momentary lock clash). Never run scripts that *write* while the bot is live.
- WAL keeps `xpbot.sqlite-wal` and `xpbot.sqlite-shm` **beside the DB file** — persist the whole data directory, never the `.sqlite` file alone. The Docker deployment notes carry the same rule (see [AGENTS.md on GitHub](https://github.com/metalsp0rk/boiler-snake/blob/main/AGENTS.md) — Known Gotchas: “persist the whole data dir (WAL files beside the DB)”).
- Backups: prefer `.backup` (see [Backup Recommendations](#backup-recommendations)); snapshot the full directory only with the bot stopped.

| Id | Purpose |
|----|---------|
| `001_base_schema` | `CREATE TABLE IF NOT EXISTS` for core domains (users, activity_log, voice_sessions — later dropped by `040`, guild_settings, level roles, command channels, YouTube, honeypot, `staff_roles`, reaction roles) |
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
| `017_event_reminder_persistent` | `persistent` flag on `event_reminder_configs` (skip auto-cleanup so configs survive recurring events) |
| `018_warn_post_mvp` | `warn_expiry_days`; `warnings.expires_at` / evidence columns + expiry index |
| `019_ticket_panels` | `ticket_panels` registry (posted panel messages for list/edit/delete) |
| `020_twitch` | `twitch_channels` table + `twitch_*` columns on `guild_settings` |
| `021_gork` | Gork (AI keyword Q&A) `guild_settings` columns: keyword, context window, extra rules, search, cooldown |
| `022_gork_access` | `gork_user_blocks` table + `gork_enabled` master switch on `guild_settings` |
| `023_gork_memory` | `gork_memories` table (per-person community memory) + `gork_memory_enabled` / `gork_memory_chars` columns |
| `024_staff_roles_added_by` | `staff_roles.added_by` provenance column (who added the role; NULL = unknown) |
| `025_github_releases` | `github_watches` table (repo → channel routing, per-repo token, release pointer) |
| `026_gork_budget` | `gork_budget_rules` + `gork_usage` tables + `gork_daily_limit` column (gork daily usage budget, roadmap §7.17) |
| `027_gork_interaction_log` | `gork_interactions` table — captured agent calls for replay fixtures (see [Gork logging](gork-logging.md)) |
| `028_web_sessions` | `web_sessions` table — web admin console sessions (see [Web admin console](web-admin.md)) |
| `029_admin_audit` | `admin_audit` trail table — one row per mutating action (`web`/`slash`/`system` origins) |
| `030_web_session_tokens` | OAuth columns on `web_sessions` (access token, expiry, scopes, guild snapshot) |
| `031_gork_ste_enabled` | `guild_settings.gork_ste_enabled` — STE anti-slop answer style toggle (roadmap §7.20, see [Gork](gork.md#answer-style-ste)) |
| `032_twitch_eventsub_media` | `twitch_eventsub_subs` table + per-subscription clip/VOD alert columns with watermarks |
| `033_gork_summarize_input_tokens` | `guild_settings.gork_summarize_input_tokens` — per-guild `/gork summarize` input token budget |
| `034_communities` | Communities cutover (Fluxer PR 2): `communities` table; every guild-scoped table re-keyed `guild_id TEXT` → `community_id INTEGER` in one transaction (003-style move, transactional + FK-gated); transcript dirs moved post-commit |
| `035_bridges` | Channel bridge schema: `bridges` state machine, `bridge_ends`, outbox, message links, snapshots, connect-attempt state (see [Bridge](bridge.md)) |
| `036_user_links` | Account linking: `user_links` pairs + `user_link_codes` (one Discord ↔ one Fluxer identity, per-direction mirror flags; see [Account Linking](account-linking.md)) |
| `037_ticket_archive_claim` | CAS archive-claim marker on `tickets` so concurrent closes can't double-archive (audit #197) |
| `038_event_reminder_claim_state` | Real delivery state machine on `event_reminder_offsets` (`sending`/backoff/attempts; audit #196) |
| `039_encrypt_third_party_tokens` | One-time re-encryption of third-party credentials (Discord OAuth tokens, GitHub PATs) to the AES-256-GCM envelope (`v1.` at migration time; new writes are `v2.<key-id>` since #281); loud boot gate when `TOKEN_ENCRYPTION_KEY` is missing while rows exist — or when a sealed row decrypts with NEITHER the current key NOR a `TOKEN_ENCRYPTION_KEY_RETIRED` entry (audit C6, #189; rotation #281) |
| `040_schema_hygiene` | CHECK constraints via DDL-derived table rebuilds (`users.xp BETWEEN 0 AND 9007199254740991`, `gork_budget_rules.daily_limit BETWEEN -1 AND 1000`; violating rows fail boot loudly by name), `idx_users_guild_xp` + partial `idx_tickets_archived`, drop the dead `voice_sessions` table (audit #204) |
| `041_heal_partial_community_cutover` | Self-healing repair for DBs stuck in a **partial** 034 cutover (audit #285): detects every surviving `GUILD_SCOPED_TABLES` straggler (still `guild_id`, or missing `community_id`), backfills `communities` from its guild values and rebuilds it with 034's live-DDL derivation (data/PK/indexes preserved, FK-toggled transaction). Un-mappable rows (NULL guild_id etc.) fail boot loudly by name; healthy DB = pure no-op. Idempotent; the only convergence path for the historical partial state under #202's fast-skip |
| `042_events_core` | Community events core schema (epic #218 phases 1–2): `events`, `event_options`, `event_signups`, `event_notifications`, `event_mutes`, `event_activity`, `event_guild_settings` |
| `043_events_series_presets` | Recurring series + signup presets: `event_series`, `event_presets`, `event_preset_options`, `events.series_id` |
| `044_event_channels_wizards` | `event_channels` registry + `event_wizards` DM creation-wizard drafts |
| `045_event_integrations` | Phase 5 integrations: `event_google_links`, `event_crossposts`, `event_crosspost_messages`, Google auto-sync + digest columns |
| `046_youtube_live_pointer` | `youtube_channels.last_live_id` — separate dedup pointer for live alerts (audit #378) |
| `047_youtube_checked_at` | `youtube_channels.last_checked_at` — the polling-interval gate the poller actually reads (audit #379) |
| `048_gork_log_channel` | `guild_settings.gork_log_channel_id` — dedicated Gork Q&A log channel (audit-log de-cluttering) |
| `049_honeypot_pause` | `guild_settings.honeypot_paused_at` / `honeypot_pause_reason` — honeypot mass-ban safety valve (#440) |
| `050_xp_cooldown_clamp` | Heals + clamps out-of-range `msg_cooldown_sec` / `reaction_cooldown_sec` values (#429) |
| `051_reaction_role_claims` | `reaction_role_claims` — per-emoji claim ledger so removing one reaction can't strip a role another path granted (#433) |
| `052_ticket_create_reservations` | `ticket_create_reservations` — atomic self-create rate-limit slot (#420) |
| `053_retention_sweep_indexes` | Indexes for the retention sweep's settled-row scans (issue #399) |
| `054_ucmd_day_index` | `idx_ucmd_day` — day-lead index for the daily-aggregate prune (issue #396) |
| `055_gork_usage_day_index` | `idx_gork_usage_day` — day-lead index for the gork_usage lazy prune (issue #395) |
| `056_admin_audit_created_at_index` | `idx_admin_audit_created_at` — retention-scan index for the yearly admin_audit prune (issue #468) |
| `057_level_role_fk` | FK coverage for `role_drop_state` (→`communities` + composite →`level_roles` `ON DELETE CASCADE`, with an idempotent orphan pre-clean) and `guild_settings` (→`communities` on the PK) (issue #469) |
| `058_gork_role_id` | `guild_settings.gork_role_id` — the role whose mention also invokes gork (`/gork role`, issue #174); `NULL` = role path off |
| `059_twitch_sub_overrides` | `twitch_channels.notify_channel_id` + `notify_role_id` — per-subscription notification routing/ping overrides (`/twitch notify`, issue #177); `NULL` = use the guild-wide pair |
| `060_twitch_go_offline` | `twitch_channels.notify_offline` + `last_offline_stream_id` + `last_offline_at` — per-subscription go-offline announcements with their announce watermark (`/twitch offline`, issue #179); flag defaults **off** |
| `061_twitch_golive_template` | `guild_settings.twitch_golive_template` — per-guild custom Twitch go-live message template (issue #178); `NULL` = built-in default copy `**{streamer}** is live!` |
| `062_rss_feeds` | `rss_feeds` — per-community RSS feed subscriptions with poll state: conditional-GET validators (`etag`/`last_modified`), watermark pair (`last_entry_key`/`last_checked`), `failure_count` backoff driver; real `ON DELETE CASCADE` FK to `communities` (issue #305) |
| `063_rss_seen` | `rss_seen` — bounded per-feed seen-set `(community_id, feed_url, entry_key)` for RSS entry dedup (~100 rows/feed, pruned oldest-first via `idx_rss_seen_feed_prune`); the PK doubles as the poller's claim-before-send race guard (#305) |
| `064_rss_guild_settings` | `guild_settings.rss_notification_channel_id` + `rss_notify_role_id` + `rss_polling_interval_minutes` (default 15) — the RSS notification settings trio behind `/setrss` (#305); NULL channel = the feature idles, NULL role = no mention |
| `065_gork_max_tool_rounds` | `guild_settings.gork_max_tool_rounds` (nullable) — per-guild gork tool-round budget (`/gork toolrounds`, 5–300) driving the derived answer deadline; NULL = never set so `GORK_LLM_MAX_TOOL_ROUNDS` stays the global fallback (#705) |
| `066_ticket_reports` | `ticket_reports` — one structured side record per context-menu Report Post / Report User ticket (#745): `kind` CHECK (`message`/`user`), reported subject, message + source-channel ids, `message_deleted` flag, modal context note; PK `ticket_id` with `ON DELETE CASCADE` to `tickets`, partial index on `reported_message_id` for the duplicate-open-report nudge |
| `067_automod_guild_settings` | `guild_settings.automod_*` — auto-moderation config family (#725, epic #723): master switch `automod_enabled` (default 0), `automod_channel_id` / `automod_rules` (both required to run a case), seven `automod_mode_<action>` columns (`off`/`suggest`/`auto`, default `suggest`; no mode for staff notes — always on), `automod_timeout_cap` (default 3600 s), tri-state `automod_daily_case_limit` (default 50; `-1` blocked, `0` unlimited; separate from `gork_daily_limit`) with the UTC-day counter `automod_cases_today`/`automod_cases_day`, and the persisted breaker pause `automod_paused_at`/`automod_pause_reason` (049 posture: a restart never silently re-arms) |
| `068_automod_cases` | `automod_cases` — staff referrals into auto-moderation, one row per referral (#726, epic #723): per-community sequential display `case_number` (`A-n`, `UNIQUE (community_id, case_number)` allocation belt — repository assigns MAX+1 in a transaction, staff-notes posture), `referrer_user_id`, nullable `message_id`/`channel_id`/`target_user_id` (at least one of message/user, enforced by the referral service), `note` (referrer's case input — NOT a staff note), `status` CHECK (`recorded`/`processing`/`complete`/`failed`; intake writes only `recorded`); real `ON DELETE CASCADE` FK to `communities` (062 posture, 034-order guard) with `(community_id, status)` and recent-first indexes |
| `069_automod_case_actions` | `automod_case_actions` — auto-moderation case-action ledger (#729, epic #723): one row per action a case suggested, executed, refused, or failed against a considered user; `state` CHECK pins `suggested`→`approved`→`executed`/`refused`/`failed` (or `suggested`→`dismissed`), the UNIQUE partial index on (community, case, action, subject) is the single-winner claim slot (052 posture), `claimed_by`/`claimed_at` stamp the execution slot, `params_json` records the effective post-clamp params, and every row counts its subject as considered (#731). `case_id` stays a NULLABLE plain INTEGER — the #726 `automod_cases` table is linked by value, no FK |
| `070_automod_case_run_metadata` | `automod_cases` run-metadata columns (#728, epic #723, `addColumnIfMissing` appends): `last_model` / `last_duration_ms` / `last_tool_names` (JSON array) / `decision_log` / `last_run_error`. `decision_log` is a SHORT STRUCTURED log — JSON `[{seq, tool, args_summary, state, result_or_error}]`, `state ∈ read_ok/read_error/recorded/refused/_log_truncated` — explicitly NOT a transcript copy (Gork's interaction-log store stays single-source; staff notes hold the human record). Written only by the harness (`src/features/automod/harness.js`) and its boot sweep; a round-cap run finishes `complete` yet keeps its `tool-round cap (N) reached` cause in `last_run_error`, and the sweep stamps `run interrupted by restart`. 068-order guard; old rows read NULLs |
| `071_automod_case_queue` | `automod_cases` moderation-queue columns (#771, epic #723, `addColumnIfMissing` appends, 068-order guard): `required_context` (reviewer-need text, sibling of `note`), `read_before`/`read_after` (per-case read-window counts 0–500; NULL = legacy Gork-owned 40/10), `message_snippet` (anchor-message excerpt at intake; the card's "Reported message" line), `incident_summary` (harness "What happened" line, 070 write posture), `revealed_at`/`revealed_by_user_id` (reporter anonymity until a single-winner staff Reveal), `resolved_at`/`resolution`/`resolved_by_user_id` (first valid resolution wins; vocabulary `recommended`/`manual`/`none` enforced in the repository). Idempotent replay no-ops; pre-#771 rows read NULLs (unrevealed, unresolved, legacy-windowed) |
| `072_heal_event_dates` | Heal degraded TEXT instants the web calendar rendered as literal "NaN": INTEGER affinity stores non-numeric text AS TEXT (affinity, not coercion — the 005 corruption family), so `events.start_at/end_at/post_at/cutoff_at`, `event_reminder_offsets.fire_at` and `event_series.next_occurrence_at` get REAL dust truncated to integer ms, parseable TEXT instants (ISO / `YYYY-MM-DD HH:MM[:SS]`) converted via `strftime('%s')`, and junk (`'NaN'`, gibberish) set to NULL — except `start_at` (NOT NULL) which falls back to its `created_at` and reminder `fire_at` which lands 0 with `sent_at` stamped (a TEXT `fire_at` never matched the numeric ticker clock, so the reminder never fired). Re-run safe: the second pass matches nothing |

Public API remains available via `require("./db")` (facade over repositories).

---

## Common Queries for Self-Hosters

Since migration `034_communities` the per-community tables key on the integer
`communities.id`, **not** the Discord snowflake. Resolve the snowflake once and
use that id in every query below (this is the only place a raw snowflake
appears in ad-hoc SQL):

```sql
-- One-time id resolution for the guild you are asking about:
SELECT id FROM communities
WHERE platform='discord' AND external_guild_id='123456789';
-- e.g. → 42; the examples below assume community_id = 42
```

For one-shot queries you can inline the lookup as a subquery instead:
`WHERE community_id=(SELECT id FROM communities WHERE platform='discord' AND external_guild_id='123456789')`.

### Check Total XP in Guild

```sql
SELECT SUM(xp) as total_xp, COUNT(*) as users
FROM users WHERE community_id=42;
```

### Find Top 100 XP Hogs

```sql
SELECT user_id, xp FROM users
WHERE community_id=42 ORDER BY xp DESC LIMIT 100;
```

### Count Users by Level (using factor=100)

```sql
-- SQLite doesn't have sqrt in UPDATE, so use a query:
SELECT user_id, xp, CAST(SQRT(xp/100.0) AS INTEGER) as level
FROM users WHERE community_id=42 ORDER BY xp DESC;
```

### Export All XP Data (CSV)

```bash
sqlite3 xpbot.sqlite "
.mode csv
.headers on
SELECT u.community_id, u.user_id, u.xp FROM users u
JOIN communities c ON c.id = u.community_id
WHERE c.platform='discord' AND c.external_guild_id='123456789';
" > xp_export.csv
```

---

## Performance Optimizations

### Indices in Place:
- `PRIMARY KEY` = automatic index (community-keyed tables: `(community_id, …)` composites — e.g. `users` PK is `(community_id, user_id)`)
- `idx_users_guild_xp`: `(community_id, xp DESC, user_id)` — leaderboard sorts (the *name* predates the 034 rename; the columns are `community_id`)
- `idx_activity_recent`: `(community_id, user_id, kind, created_at)`
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
- **No passwords are stored** — the web console signs in through OAuth; there is
  no local password table. The database **does** store third-party secrets,
  always **envelope-encrypted at rest** (AES-256-GCM envelope — `v2.<key-id>`
  for core-codec stores since #281, legacy `v1` readable everywhere; never
  plaintext):
  - per-repo GitHub PATs — `github_watches.token`
    (see [GitHub releases](github-releases.md))
  - Discord command-permission OAuth tokens — `guild_command_permission_oauth.access_token` / `.refresh_token`
  - web-console OAuth tokens for Discord **and** Fluxer sign-ins — `web_sessions.access_token_enc` / `.refresh_token_enc`
  - Google Calendar tokens — `event_google_links.access_token_enc` / `.refresh_token_enc`
  - bridge relay webhook tokens — `bridge_ends.webhook_token_enc`
- Key domains: `TOKEN_ENCRYPTION_KEY` (32 bytes of base64, `.env` only) powers
  the PAT / command-permission / Google-calendar envelopes via
  `src/core/thirdPartyTokens.js`; bridge webhook tokens use the same envelope
  scheme under a separate `BRIDGE_TOKEN_KEY`; web-console tokens use the
  HKDF-derived key in `src/web/auth/tokens.js` (rooted at `SESSION_SECRET`).
  Rotation (#281): the core-codec keys accept a `*_RETIRED` list of previous
  keys; rows re-seal with the current key as they are read, so a rotation
  needs no re-authorization dance. Migration `039` back-encrypted legacy
  plaintext rows and boot **fails loudly** when the key is missing while
  token rows exist — the bot never runs with mixed plaintext/ciphertext
  columns
- Ciphertext is still a secret: the same file-permission and backup care as the
  rest of the DB applies (ticket `transcript_token` values are random
  bearer-capability URLs — treat exports as sensitive)

### Backup Recommendations
```bash
# Automated daily backup
0 2 * * * sqlite3 /path/to/xpbot.sqlite ".backup '/backups/xpbot-$(date +\%Y\%m\%d).sqlite'"
```

When using WAL mode, back up the whole data directory (or use SQLite’s `.backup` API as above) so `-wal` / `-shm` siblings stay consistent.
