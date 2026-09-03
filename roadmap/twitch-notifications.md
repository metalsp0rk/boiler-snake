# 3. Twitch Stream Notifications

### Purpose

Notify a guild when any subscribed Twitch channel goes live. Supports **any number of channels** per guild, posts to a configurable Discord channel, and optionally **pings a guild-configurable role** that is **independent of YouTube** notification roles (`youtube_upload_role_id` and any future YouTube live role).

### Status

**Shipped (MVP)** — implemented in `src/features/twitch/` with migration `020_twitch`. Go-live notifications via Helix polling, multi-channel per guild, separate notify channel + ping role. See [docs/twitch-notifications.md](../docs/twitch-notifications.md). Design decisions in [3.8](#38-design-decisions-locked) remain the product contract. Post-MVP: EventSub, per-channel overrides, templates, go-offline, clips/VODs.

---

### 3.1 Core behavior

```
Admin adds one or more Twitch logins
        → bot resolves login → broadcaster user id (Helix)
        → ticker polls Helix streams for subscribed broadcasters
        → on transition offline → live: post embed to notify channel
        → if twitch_notify_role_id set: mention that role on the message
        → record last_stream_id / is_live so the same stream is not re-announced
```

| Rule | Detail |
|------|--------|
| Scope | **Go-live only** (MVP). No go-offline, no VODs, no follows/clips |
| Channels | **Any number** of Twitch channels per guild (same broadcaster may be tracked in multiple guilds) |
| Notify channel | Per-guild `twitch_notification_channel_id` — **separate** from YouTube’s channel |
| Role ping | Optional per-guild `twitch_notify_role_id` — **separate** from `youtube_upload_role_id` |
| No role | If role unset, post embed with no role mention (do **not** fall back to YouTube role or `@everyone`) |
| Dedup | Track `last_stream_id` (and/or `is_live`) per subscription; notify only on offline→live transition for a new stream id |
| Auth | Helix app access token via Client Credentials (`TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET`) |
| Permission | Config / subscribe commands: **ManageGuild** (same as YouTube) |

---

### 3.2 Commands

#### Channel subscriptions

| Command | Description |
|---------|-------------|
| `/twitch add login:<name\|url>` | Subscribe to a Twitch channel (login, `https://twitch.tv/…`, or bare username) |
| `/twitch remove channel:<…>` | Unsubscribe (autocomplete over guild subscriptions) |
| `/twitch list` | List subscribed channels + notify channel / role status |

#### Guild configuration

| Command | Description |
|---------|-------------|
| `/settwitch channel <channel>` | Discord channel for go-live posts |
| `/settwitch role [role]` | Role to mention on go-live (omit or clear to disable pings) |
| `/settwitch interval <minutes>` | Polling interval 1–60 (default **2** — streams are more time-sensitive than YT uploads) |
| `/settwitch settings` | Show current channel, role, interval, and subscription count |

**Optional (nice-to-have in same PR or follow-up):** `/testtwitchnotification` mirroring `/testnotification` for YouTube.

**Not in MVP:** per-channel Discord channel override, per-channel role override, custom message templates.

---

### 3.3 Notification content

On go-live, post to the configured Discord channel:

- **Content line:** optional `<@&roleId> ` prefix when `twitch_notify_role_id` is set
- **Embed** (purple/Twitch brand, e.g. `#9146FF`):
  - Title / name: `{display_name} is live!`
  - Description: stream title
  - URL: `https://twitch.tv/{login}`
  - Thumbnail or preview image when Helix provides one
  - Footer / fields: game/category name if available

One Discord message per newly detected live stream (not a digest of multiple channels in one message).

**Allowed mentions:** when posting, set `allowedMentions: { roles: [roleId] }` so only the configured Twitch role is pinged.

---

### 3.4 Polling ticker (MVP)

Module layout (mirror YouTube):

| Path | Responsibility |
|------|----------------|
| `src/features/twitch/index.js` | Slash commands, handlers, registration export |
| `src/features/twitch/ticker.js` | Helix auth + stream poll loop + send notification |

**Ticker loop:**

1. Load all guilds with ≥1 `twitch_channels` row and a set `twitch_notification_channel_id`.
2. Batch Helix `GET /helix/streams?user_id=` (up to Helix’s multi-id limit per request) across unique broadcaster ids.
3. For each subscription:
   - If stream present and `stream.id !== last_stream_id` (or was not live): send notification; set `is_live=1`, `last_stream_id`, `last_checked`.
   - If stream absent and was live: set `is_live=0`, update `last_checked` (no Discord message).
4. Honor per-guild `twitch_polling_interval_minutes` (or a single process interval = min of configured guilds, then gate per guild by last run—same practical approach as YouTube is fine).

**Startup:** skip ticker if `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` missing; log once (same pattern as YouTube without `YOUTUBE_API_KEY`).

**Env vars:**

```bash
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
```

App registration: [Twitch Developer Console](https://dev.twitch.tv/console) → application → Client Credentials grant (no user OAuth for MVP).

---

### 3.5 Database schema (working draft)

**`guild_settings` columns:**

| Column | Purpose |
|--------|---------|
| `twitch_notification_channel_id` | Discord channel for go-live posts |
| `twitch_notify_role_id` | Optional role to mention (null = no ping) |
| `twitch_polling_interval_minutes` | Default **2**; clamp 1–60 |

**`twitch_channels` table:**

```sql
CREATE TABLE IF NOT EXISTS twitch_channels (
  guild_id TEXT NOT NULL,
  broadcaster_id TEXT NOT NULL,     -- Twitch user id (stable)
  login TEXT NOT NULL,              -- lowercase login
  display_name TEXT NOT NULL,
  profile_image_url TEXT,
  is_live INTEGER NOT NULL DEFAULT 0,
  last_stream_id TEXT,             -- Helix stream id; dedup go-live
  last_checked INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, broadcaster_id),
  UNIQUE (guild_id, login)
);
```

**Repositories / db facade (sketch):**

- `getTwitchChannels(guildId)` / `addTwitchChannel(...)` / `removeTwitchChannel(guildId, broadcasterId)`
- `updateTwitchChannelLiveState(guildId, broadcasterId, { isLive, lastStreamId, lastChecked })`
- `listAllTwitchSubscriptions()` for the ticker
- `updateGuildSettings` keys for the three `twitch_*` settings

---

### 3.6 Integration points

| Area | Change |
|------|--------|
| `src/features/twitch/` | New feature module (commands + ticker) |
| `src/commands/` registry | Register `/twitch`, `/settwitch`, autocomplete for remove |
| `src/index.js` / client startup | Start Twitch ticker beside YouTube ticker |
| `src/db/` | Migration for columns + table; repository + facade exports |
| Docs | `docs/twitch-notifications.md` (mirror `docs/youtube-notifications.md`) |
| `.env.example` | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` |
| Audit log | Config changes for channel / role / interval (same style as YouTube) |

**Bot permissions:** Send Messages + Embed Links in the notify channel; ability to mention the configured role (role must be mentionable **or** bot uses role id mention with `allowedMentions` — prefer id mention without requiring the role to be open-mentionable).

---

### 3.7 Implementation order

1. Migration + repository + guild_settings defaults  
2. Helix app-token helper + user/login resolve + streams lookup  
3. `/twitch add|remove|list`  
4. `/settwitch channel|role|interval|settings`  
5. Ticker + go-live embed + role mention  
6. Wire startup + register commands  
7. Docs + `.env.example`  
8. Tests: repo CRUD, dedup transition offline→live, no notify when still live with same `stream.id`

---

### 3.8 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Multi-channel:** any number of Twitch subscriptions per guild; no hard cap in MVP (monitor Helix rate limits). |
| 2 | **Role is guild-wide and Twitch-only:** `twitch_notify_role_id` never shares storage or fallback with YouTube roles. |
| 3 | **Optional ping:** null role ⇒ silent embed (no `@everyone` fallback). |
| 4 | **Go-live only** for MVP; offline cleanup is DB state only. |
| 5 | **Polling Helix** for MVP (matches existing YouTube ticker ops model). EventSub webhooks = post-MVP if we want lower latency / less quota. |
| 6 | **Dedup by stream id** on offline→live; re-notify only for a new stream session. |
| 7 | **Separate notify channel** from YouTube (`twitch_notification_channel_id`). |
| 8 | **Admin gate:** guild [staff roles](staff-roles.md#4-guild-staff-roles-admin-gate) (`requireStaff`) for all Twitch config/subscribe commands (ManageGuild or staff role once §4 ships; ManageGuild-only until then). |

**Still open (non-blocking):**

- Exact default polling interval (recommend **2** minutes).
- Whether to include game/category and viewer count on the embed (recommend **yes** for title + game; viewer count optional).
- Test command in MVP vs follow-up.
