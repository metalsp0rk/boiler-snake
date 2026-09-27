# Twitch Stream Notifications

Get notified when any of your subscribed Twitch streamers go live. Subscribe to **any number of channels** per server, pick where the alerts post, and optionally ping a role. Opt in per-channel to **new clips** and **new VODs** too.

## Overview

- **Go-live detection**: one alert per new stream session (deduped by stream id)
- **EventSub fast path (optional)**: Twitch pushes go-live/offline webhooks for near-instant alerts; the poller keeps running as reconciliation/fallback
- **Clips & VODs (optional, per channel)**: announce new clips and new archive VODs (both **off** by default)
- **Flexible input**: Twitch login, `https://twitch.tv/…` URL, or numeric user id
- **Separate from YouTube**: its own notification channel and ping role
- **Polling**: the bot checks Helix on a minute-aligned cadence; each guild's `interval` (1–60 min, default 2) controls how often its subscriptions are re-checked

## Setup

### Required Environment Variables

Add to your `.env` file:

```bash
TWITCH_CLIENT_ID=your_twitch_client_id
TWITCH_CLIENT_SECRET=your_twitch_client_secret
```

**Getting credentials**:
1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console)
2. Create (or select) an application
3. The **Client ID** and **Client Secret** are on the app's Info page
4. No user OAuth is needed — the bot uses the Client Credentials grant

Without these variables the Twitch feature is disabled: `/twitch add` will tell you, and the poller won't start.

### Optional: EventSub fast path (push notifications)

Enable Twitch **webhook** EventSub so go-live/offline arrives in seconds instead of waiting up to one poll interval. Everything keeps working without it (pure polling). All three pieces are required:

```bash
TWITCH_EVENTSUB_SECRET=generate-a-random-string-10-100-chars
TWITCH_EVENTSUB_CALLBACK_URL=https://bot.example.com/hooks/twitch  # optional; defaults to PUBLIC_BASE_URL + /hooks/twitch
TWITCH_EVENTSUB_MAX_CHANNELS=50                                    # optional quota guard
```

Requirements:

- The bot's [public web server](/web-admin) must be reachable at an **HTTPS URL on port 443** (a reverse proxy terminating TLS in front of `PUBLIC_HTTP_PORT` is fine). Plain HTTP is rejected by Twitch and by the bot at startup.
- `TWITCH_EVENTSUB_SECRET` signs every delivery (HMAC-SHA256); the bot rejects bad signatures and deliveries older than 10 minutes.
- The subscription endpoint must be `POST {callback}`; the bot serves it at `/hooks/twitch` on the public web server.

`/settwitch settings` shows whether EventSub is enabled, how many subscriptions are healthy, and any failures. The bot self-heals: subscriptions are created when you `/twitch add`, deleted when the last guild removes the broadcaster, and an hourly reconcile prunes orphans and retries failures. Twitch redeliveries are deduped against the poller, so you never get double alerts.

### Subscribe a Channel

```bash
/twitch add login:SomeStreamer
/twitch add login:https://twitch.tv/SomeStreamer
/twitch add login:12345678
```

## Supported Input Formats

| Format | Example | Notes |
|--------|---------|-------|
| Login | `somechannel` | Resolved to a numeric id via Helix |
| URL | `https://twitch.tv/somechannel` | Path is extracted and normalized |
| URL with suffix | `twitch.tv/somechannel/videos` | Everything after the login is ignored |
| @-prefixed | `@somechannel` | `@` is stripped |
| Numeric id | `12345678` | Used directly |

## Commands

All Twitch commands are **staff-gated** (Manage Server or a guild [staff role](/staff-roles)).

### `/twitch add`

Subscribe to a Twitch channel.

```bash
/twitch add login:MoistCr1TiKaL
```

Resolves the login immediately; if the channel is already subscribed you're told instead of duplicating.

### `/twitch remove`

Unsubscribe (autocomplete over the guild's subscriptions).

```bash
/twitch remove channel:MoistCr1TiKaL
```

### `/twitch list`

List subscribed channels, which ones are currently **LIVE**, whether clips/VOD alerts are on, plus the notification channel and ping role.

### `/twitch clips` / `/twitch vod`

Opt one of your subscriptions in to **new clip** / **new VOD** alerts (default **off**):

```bash
/twitch clips channel:SomeStreamer enabled:True
/twitch vod channel:SomeStreamer enabled:True
```

- Clips: announced when Helix lists a clip **created after** you enabled the toggle (older clips are never backfilled). Up to 5 clips per poll per channel.
- VODs: **archive** broadcasts only (past broadcasts saved to your channel), newest-first, same flood cap. Highlights/uploads are not announced.
- Clip/VOD alerts post to the same `/settwitch channel` but **never ping** the role.
- Helix has no push API for clips/VODs, so these ride the normal poll interval.

## Configuration Commands

### `/settwitch channel`

Set where go-live alerts are posted:

```bash
/settwitch channel #stream-notifications
```

### `/settwitch role`

Set (or clear) the role mentioned on go-live alerts:

```bash
/settwitch role role:@StreamAlerts
/settwitch role
```

Leave `role` empty to disable the mention. The Twitch role is **independent** of the YouTube roles — no fallback to `@everyone` or to `youtube_upload_role_id`.

### `/settwitch interval`

How often this guild's subscriptions are re-checked, in minutes (1–60, default **2**):

```bash
/settwitch interval 2
```

The bot runs a minute-aligned poll loop; a subscription is skipped when it was checked less than the guild interval ago. Lower = faster alerts, more Helix calls.

### `/settwitch settings`

Show current channel, ping role, interval, subscription count, and whether bot credentials are configured.

## Notification Behavior

- **Trigger**: offline → live transition for a **new** stream id
- **Embed**: purple (`#9146FF`), stream title, game/category, viewer count, watch link, broadcaster thumbnail
- **Mention**: the `/settwitch role` role only, via `allowedMentions`
- **Dedup**: while the same stream id is live, no repeat alerts; a new stream session re-notifies
- **Offline**: state is cleared silently (no go-offline message in the MVP)

## Examples

### Complete Setup Workflow

1. **Set the notification channel**:
   ```bash
   /settwitch channel #stream-notifications
   ```

2. **(Optional) Ping role**:
   ```bash
   /settwitch role role:@StreamAlerts
   ```

3. **Subscribe streamers**:
   ```bash
   /twitch add login:StreamerOne
   /twitch add login:https://twitch.tv/StreamerTwo
   ```

4. **Verify**:
   ```bash
   /twitch list
   /settwitch settings
   ```

### Example Notification

```
<@&StreamAlerts> **StreamerOne** is live!

[embed] StreamerOne is live!
        Building a Discord Bot in 2026
        Playing: Just Chatting   Viewers: 1,234
        Watch on Twitch
```

## Technical Details

### Helix Endpoints Used

1. **`GET /users`** — resolve a login or id to a broadcaster (on subscribe + lazy re-resolve)
2. **`GET /streams`** — batched (≤100 ids per request) current-stream lookup for all subscriptions
3. **`GET /clips`** — per opted-in channel, `started_at` windowed poll for new clips
4. **`GET /videos`** — per opted-in channel, `type=archive` poll for new VODs
5. **`POST/DELETE/GET /eventsub/subscriptions`** — manage the webhook fast path (when enabled)

Auth is a cached app access token from `id.twitch.tv/oauth2/token` (Client Credentials), refreshed ~60s before expiry.

### State

- `twitch_channels`: one row per guild + broadcaster (login, display name, avatar, `is_live`, `last_stream_id`, `last_checked`, media flags: `notify_clips`, `notify_vods`, `last_clip_id`, `last_clip_created_at`, `last_video_id`, `last_video_created_at`)
- `twitch_eventsub_subs`: one row per subscription type + broadcaster (Twitch subscription id, status, last error) — the bot's view of its EventSub subscriptions
- `guild_settings`: `twitch_notification_channel_id`, `twitch_notify_role_id`, `twitch_polling_interval_minutes`

### Poller

Runs on a minute-aligned interval after login. Each pass: resolve any pending logins → filter subscriptions by each guild's polling interval → batch-fetch streams (≤100 ids/request) → compare against stored `last_stream_id` → notify new go-lives → update live state → run clip/VOD polls for opted-in subscriptions.

- A **failed** stream fetch leaves live state untouched (no false offline → no duplicate go-live next tick)
- An in-flight guard prevents overlapping ticks
- Helix requests time out after 15s

### EventSub webhook (fast path)

- Route: `POST /hooks/twitch` on the [public web server](/web-admin) — the only non-`/g/` public POST besides logout; authenticated by HMAC-SHA256 (`twitch-eventsub-message-signature`), not by login/CSRF
- `webhook_callback_verification` → replies with the challenge; `notification` → answers 204 **first**, then processes (Twitch revokes subscriptions whose handler is slow); `revocation` → recorded and pruned
- `stream.online` events are enriched with one `GET /streams` lookup (title/game/thumbnail); if that fetch fails the bot falls back to the event payload — the stream id in the event matches Helix, so the poller still won't duplicate
- Go-live/offline claims are write-first in SQLite (`claimTwitchStream`/`claimTwitchOffline`), so webhook + poller can never both announce the same session
- Hourly reconcile: create missing subs, delete subs for untracked broadcasters, enforce `TWITCH_EVENTSUB_MAX_CHANNELS`, and self-heal verification failures

## Troubleshooting

### "Twitch is not configured"

Set `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` in `.env` and restart the bot.

### "Could not find a Twitch channel for …"

The login doesn't exist (or is wrong). Twitch logins are case-insensitive but unique; check the exact spelling.

### No alerts even though a streamer is live

1. `/settwitch settings` — is the notification channel set and are credentials configured?
2. `/twitch list` — is the channel subscribed and does it show **LIVE**?
3. The bot can only see streams that started **after** it began polling (or after a new stream id appears); a stream that was already live at first poll will announce on the next new session.
4. Check the bot can post in the notification channel.
