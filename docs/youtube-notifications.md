# YouTube Notifications

Monitor YouTube channels for live streams and video uploads, with automatic notifications to your Discord server.

## Overview

The YouTube integration supports both:
- **Live stream detection**: Alert when subscribed creators go live
- **Video upload detection**: Notify on new video releases
- **Flexible input formats**: Accepts @username, channel URLs, or numeric IDs
- **Automatic resolution**: Fetches actual channel IDs from @username patterns

## Setup

### Required Environment Variable

Add to your `.env` file:
```bash
YOUTUBE_API_KEY=your_google_cloud_api_key_here
```

**Getting an API Key**:
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable YouTube Data API v3
4. Create credentials → API key
5. Copy the key to your `.env` file

### Subscribe a Channel

```bash
/youtube add url:https://www.youtube.com/@SomeChannel
```

## Supported URL Formats

Inputs for `/youtube add` (and the `channel:` option of `/testnotification`):

| Format | Example | Notes |
|--------|---------|-------|
| @username URL | `https://www.youtube.com/@Crunchbase` | Automatically resolves to numeric ID |
| Numeric ID URL | `https://www.youtube.com/channel/UCxxxxxxxxxxx` | Direct channel identification |
| Bare @username | `@SomeChannel` | Starts with `@`, resolves immediately |
| Numeric ID only | `UCxxxxxxxxxxx` | Channel ID starts with UC or HC |

Anything else is rejected (on `/youtube add` the refusal itself lists the accepted formats).

## Commands

All three commands are **staff tier** (`/youtube`, `/setyoutube`, `/testnotification`): the handlers require ManageGuild **or** any configured `staff_roles` level, and the slash picker hides them from members without ManageGuild until staff roles are synced via `/staff syncpermissions`.

### `/youtube add`

Subscribe to a YouTube channel for notifications.

```bash
/youtube add url:https://www.youtube.com/@TechReviews
```

**Response**: `Subscribed to **@<name>**. I'll notify when they go live.` (ephemeral). When an @handle was given, the bot resolves it to the real channel ID during the command whenever the API key and search quota allow. If the handle can't be resolved, the subscription is **still stored** with the raw handle as its id, and the ticker retries the resolution on later sweeps — it is a pending row, not a failed one. Nothing deletes it behind your back: the once-hidden "malformed channel" cleanup that ran as a side effect of *every* guild-settings write (silently unsubscribing pending rows on an unrelated `/setcommandchannel`) is gone — pending rows are by-design state the ticker retries, not debris.

### `/youtube remove`

Unsubscribe from a YouTube channel.

```bash
/youtube remove channel:UCxxxxxxxxxxx
```

**Parameter**: matches the **stored channel id** (`UC…`/`HC…`) — or the plain `@handle`/handle text of a pending row — never a channel URL. The `channel:` option has **autocomplete**: pick the subscription from the picker (it inserts the stored id).

**Replies**: `Unsubscribed from **<name>**.` on success; `No subscription found.` when nothing matches the id/handle you typed; and on a failed delete the honest `Failed to unsubscribe: <cause> (subscription still present).` — the row is not silently dropped.

### `/youtube list`

View all subscribed channels for this guild.

```bash
/youtube list
```

**Output shows**:
- Header with the subscription count and the notification-channel status
- Channel name (normalized, `@name` display) plus its stored ID and channel URL
- Pending rows (unresolved @handles) show the raw handle as the ID until the ticker resolves them

Long lists are capped at the 2000-character message limit with an honest hidden-remaining count.

## Configuration Commands

### `/setyoutube channel`

Set where YouTube notifications appear:

```bash
/setyoutube channel #announcements
```

All live stream and video upload alerts will be posted here.

### `/setyoutube interval`

Set the per-community **polling interval** (1–60 minutes, default **5**):

```bash
/setyoutube interval 5
```

Replies `YouTube polling interval set to **N** minute(s).` The scheduler sweeps every minute but only checks rows that are due against this setting (see [Polling model](#polling-model)) — a lower number means faster alerts **and** proportionally more quota; a higher number batches checks.

*(The shipped slash-command description still reads "Set RSS polling interval." — it configures the Data-API polling cadence; there is no RSS path.)*

### `/setyoutube uploadrole`

Set (or clear) the role mentioned on **video upload** notifications:

```bash
/setyoutube uploadrole role:@VideoAlerts
```

Leave `role` empty to disable the mention:

```bash
/setyoutube uploadrole
```

**Notes**:
- Applies to **uploads only** (not live stream alerts)
- Live stream notifications use a fixed `@everyone` content line in the ticker
- Upload alerts never ping `@everyone` — only the configured role
- Role is stored as `youtube_upload_role_id` in guild settings

### `/testnotification`

Send a **one-off test** for a channel's latest video or stream (staff). Does not wait for the poller.

```bash
/testnotification channel:https://www.youtube.com/@TechChannel
/testnotification channel:https://www.youtube.com/@TechChannel simple:true
```

| Option | Required | Description |
|--------|----------|-------------|
| `channel` | Yes | YouTube URL, `@username`, or channel ID (same formats as `/youtube add`) |
| `simple` | No | If true, use the simple text upload body — **exactly what the production ticker sends for uploads**. The rich upload embed is only observable here (without `simple:true`) |

**Behavior**:
- If the channel is not already subscribed, the bot **subscribes it** first, then tests
- Detects live vs upload from the latest feed entry and builds the matching body
- Upload tests include the configured upload-role mention (if set)
- Replies in the **current** channel (not the YouTube notification channel)
- **Failures name the specific cause** — e.g. `Could not fetch videos from this channel: YOUTUBE_API_KEY is not set on this bot — add it to .env and restart.`, a named Google API error, or `no subscription row for <id> after subscribing and YOUTUBE_API_KEY is not set on this bot (channel lookup is impossible)`. There is no bare "something failed" on this command.

## Notification Behavior

### Live Stream Alerts
- **Trigger**: a feed entry whose `liveBroadcastContent` is `live` **or** `upcoming` — scheduled streams alert too
- **Content**: `@everyone {channel} just went live!` (the mention is the message content, not the embed)
- **Embed**: red (`#FF0000`) — author `{channel} just went live!` (linking the channel page), title = stream title, description `[Watch Live](https://youtu.be/<videoId>)`, fields **Channel** (linked name) and **Video ID**, the video banner as image, publish timestamp
- **Dedup**: exactly one alert per stream — live alerts track their own `last_live_id` pointer (see [Reliability and dedup](#reliability-and-dedup))

### Video Upload Alerts
- **Trigger**: entries published after the row's notification floor (`last_checked`)
- **Shipped form — always simple text, no embed at all**:

  ```
  <@&role> {channel} uploaded a new video!
  https://youtu.be/<videoId>
  ```

  The `<@&role> ` prefix appears only when `/setyoutube uploadrole` is configured. The alert carries **no title, no thumbnail, no duration, no upload-date fields**.
- The orange (`#FFA500`) rich upload embed exists only as the `/testnotification` preview (it is not on the ticker's delivery path).

## Examples

### Complete Setup Workflow

1. **Set up notification channel**:
   ```bash
   /setyoutube channel #stream-notifications
   ```

2. **(Optional) Upload ping role**:
   ```bash
   /setyoutube uploadrole role:@VideoAlerts
   ```

3. **Subscribe multiple channels**:
   ```bash
   /youtube add url:https://www.youtube.com/@TechChannel
   /youtube add url:@GamingChannel
   /youtube add url:UCxxxxxxxxxxxxx
   ```

4. **Configure polling frequency** (check every 10 minutes):
   ```bash
   /setyoutube interval 10
   ```

5. **Verify configuration**:
   ```bash
   /youtube list
   ```

6. **(Optional) Dry-run a notification**:
   ```bash
   /testnotification channel:https://www.youtube.com/@TechChannel
   ```

### Example Notifications (shipped layout)

**Live Stream** — message content `@everyone TechChannel just went live!` (the name is the stored channel name, `@`-normalized) plus a red embed:

```
@everyone TechChannel just went live!
┌ 🔴 Author: TechChannel just went live!   ← links the channel page
│  Building a Discord Bot in 2026           ← stream title
│  [Watch Live](https://youtu.be/<videoId>)
│  Channel: TechChannel   ·   Video ID: dQw4…
└ published timestamp · YouTube footer
```

**Video Upload** — plain text, embeds empty (role prefix only if configured):

```
@VideoAlerts TechChannel uploaded a new video!
https://youtu.be/dQw4w9WgXcQ
```

## Technical Details

### API Endpoints Used

1. **YouTube Search API**
   - Resolves @username to channel ID (on subscribe; 100 quota units)
   - Endpoint: `/youtube/v3/search`

2. **YouTube Channels API**
   - Gets uploads playlist ID (and channel snippet on subscribe)
   - Endpoint: `/youtube/v3/channels`

3. **YouTube Playlist Items API**
   - Fetches recent videos from the uploads playlist (up to 50 per fetch)
   - Endpoint: `/youtube/v3/playlistItems`

The poller is **Data-API-only**: the legacy `rss-parser` feed fallback was removed as dead code — no RSS path exists in the feature.

### Normalization Process

When a @username is detected:

1. Extract username from URL (`@SomeChannel` → `SomeChannel`)
2. Call Search API with query parameter
3. Find exact or close match by channel title
4. Store numeric ID and normalized name
5. If resolution fails, the pending handle row is retried by the ticker on later sweeps

### Polling model

The scheduler job **ticks once a minute** (aligned to the minute), but a tick is not a check: each row is only swept when it is **due** — its `last_checked_at` stamp older than the community's `youtube_polling_interval_minutes` (default **5**). Details:

- **Never-checked rows are always due** — a fresh subscription is picked up on the next minute tick.
- `last_checked_at` (wall-clock **sweep stamp**) and `last_checked` (the **notification floor**: publish-time watermark) are **separate clocks**. The sweep stamp is booked even when a fetch transiently fails (so cadence equals what the setting promises); the notification floor only ever moves past videos that were actually delivered.
- A row whose settings read throws drops itself from the sweep with a logged cause — one bad community can't kill the tick.

### Reliability and dedup

The watermark/dedup model (audit #380/#378 per-community bundle):

- **Failed sends keep the watermark.** Pending videos are delivered **oldest-first**, the loop stops at the first failure, and state persists **per delivery** — retried videos re-fire on the next tick (at-least-once delivery; a revoked-post perm or rate-limit burst no longer permanently burns uploads).
- **Live alerts dedup on their own `last_live_id`** pointer, set only after a *delivered* alert — **exactly one `@everyone` per stream**, with no mid-stream re-fire loop even when an upload lands during the stream, and a failed live send is retried next tick.
- **Watermarks are scoped per community row.** The same YouTuber subscribed in N guilds is N rows; one guild's tick can no longer rewrite its siblings' watermarks and silently eat their pending uploads.
- **First-ever check notifies only videos published within the last hour** — subscribing to a busy channel neither spams you its back catalogue nor starts the clock from forever ago.

## Troubleshooting

### Issue: "YouTube notifications not working"

**Checklist**:
1. ✅ `YOUTUBE_API_KEY` set in `.env`
2. ✅ YouTube Data API v3 enabled in Google Cloud Console
3. ✅ Channel subscription added successfully (check `/youtube list`)
4. ✅ Bot has permission to post in notification channel
5. ✅ Run `/testnotification channel:<id>` — its reply names the **specific** failure cause (missing key, named API error, …) instead of a generic error

### Issue: "Slow notifications"

**Solutions**:
- First alert may wait one poll interval (default 5 min) — the sweep itself runs every minute; adjust with `/setyoutube interval 1`
- Some creators have delayed metadata (normal behavior)

### Issue: "Channel not found when subscribing"

**Causes**:
- @username doesn't exist
- Channel is private/unpublished
- YouTube API rate limit exceeded

### Issue: `/youtube remove` answers "No subscription found."

You typed a **channel URL or display name** — removal matches the stored channel id (or a pending row's handle). Use the autocomplete picker in the `channel:` option.

## Performance & Quota Management

### Google Cloud API Limits

YouTube Data API v3 uses quota units:

| Operation | Quota Cost |
|-----------|-----------|
| Search list | 100 units |
| Channels.list | 1 unit |
| PlaylistItems.list | 1 unit |

**What a poll actually costs**:
- **Each check of one channel: exactly 2 units** — `channels.list` (1u, uploads-playlist lookup) + `playlistItems.list` (1u). There is no hidden third call.
- **Subscribe with an @handle: ~101 units one-off** — 100u for the Search API resolution + 1u channel-info fetch. Subscribing with a bare `UC…` id skips search entirely (~1u).
- Rows that are not **due** cost nothing this minute (the due-gate above).

**Example**: 3 channels at a 10-minute interval ≈ 3 × 2 units × 144 checks/day = **~864 units/day**, well under the 10,000/day default budget.

### Optimization Tips
✅ Use numeric channel IDs when possible (skip the 100u search API call)
✅ Set polling interval ≥5 minutes to stay under rate limits
✅ Limit subscribed channels per guild (no hard limit enforced)
