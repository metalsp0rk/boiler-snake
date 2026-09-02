# Twitch Stream Notifications

Get notified when any of your subscribed Twitch streamers go live. Subscribe to **any number of channels** per server, pick where the alerts post, and optionally ping a role.

## Overview

- **Go-live detection**: one alert per new stream session (deduped by stream id)
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

List subscribed channels, which ones are currently **LIVE**, plus the notification channel and ping role.

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

Auth is a cached app access token from `id.twitch.tv/oauth2/token` (Client Credentials), refreshed ~60s before expiry.

### State

- `twitch_channels`: one row per guild + broadcaster (login, display name, avatar, `is_live`, `last_stream_id`, `last_checked`)
- `guild_settings`: `twitch_notification_channel_id`, `twitch_notify_role_id`, `twitch_polling_interval_minutes`

### Poller

Runs on a minute-aligned interval after login. Each pass: resolve any pending logins → filter subscriptions by each guild's polling interval → batch-fetch streams (≤100 ids/request) → compare against stored `last_stream_id` → notify new go-lives → update live state.

- A **failed** stream fetch leaves live state untouched (no false offline → no duplicate go-live next tick)
- An in-flight guard prevents overlapping ticks
- Helix requests time out after 15s

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
