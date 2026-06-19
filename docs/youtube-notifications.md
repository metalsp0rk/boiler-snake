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

| Format | Example | Notes |
|--------|---------|-------|
| @username URL | `https://www.youtube.com/@Crunchbase` | Automatically resolves to numeric ID |
| Numeric ID URL | `https://www.youtube.com/channel/UCxxxxxxxxxxx` | Direct channel identification |
| Bare @username | `@SomeChannel` | Starts with `@`, resolves immediately |
| Numeric ID only | `UCxxxxxxxxxxx` | Channel ID starts with UC or HC |

## Commands

### `/youtube add`

Subscribe to a YouTube channel for notifications.

```bash
/youtube add url:https://www.youtube.com/@TechReviews
```

**Response**: Confirms subscription and resolution status if @username was used.

### `/youtube remove`

Unsubscribe from a YouTube channel.

```bash
/youtube remove channel:https://www.youtube.com/channel/UCxxxxxxxxxxx
```

**Parameter**: Accepts channel URL or numeric ID.

### `/youtube list`

View all subscribed channels for this guild.

```bash
/youtube list
```

**Output shows**:
- Channel name (normalized, @username format)
- Channel ID and full URL
- Notification channel status
- Resolved vs. pending identification status

## Configuration Commands

### `/setyoutube channel`

Set where YouTube notifications appear:

```bash
/setyoutube channel #announcements
```

All live stream and video upload alerts will be posted here.

### `/setyoutube interval`

Configure how often the bot checks for updates (1-60 minutes):

```bash
/setyoutube interval 5
```

**Tradeoffs**:
- **Lower interval** (1-2 min): Faster alerts, more API quota use
- **Higher interval** (30-60 min): Fewer API calls, slightly delayed alerts

## Notification Behavior

### Live Stream Alerts
- **Trigger**: Channel starts streaming
- **Color**: Red embed (`#FF0000`)
- **Content**: Channel name + stream title + direct link

### Video Upload Alerts  
- **Trigger**: New video published to uploads playlist
- **Color**: Orange embed (`#FFA500`)
- **Content**: Video title, duration, upload date, thumbnail

## Examples

### Complete Setup Workflow

1. **Set up notification channel**:
   ```bash
   /setyoutube channel #stream-notifications
   ```

2. **Subscribe multiple channels**:
   ```bash
   /youtube add url:https://www.youtube.com/@TechChannel
   /youtube add url:@GamingChannel
   /youtube add url:UCxxxxxxxxxxxxx
   ```

3. **Configure polling frequency** (check every 10 minutes):
   ```bash
   /setyoutube interval 10
   ```

4. **Verify configuration**:
   ```bash
   /youtube list
   ```

### Example Notifications

**Live Stream**:
```
🔴 [STREAMING] @TechChannel just went live!
Title: Building a Discord Bot in 2026
Watch: https://www.youtube.com/watch?v=...
```

**Video Upload**:
```
🎥 New video from @TechChannel!
Title: Complete Guide to Level Up Systems
Duration: 15:32
Upload Date: June 15, 2026
https://www.youtube.com/watch?v=...
```

## Technical Details

### API Endpoints Used

1. **YouTube Search API**
   - Resolves @username to channel ID
   - Endpoint: `/youtube/v3/search`
   
2. **YouTube Channels API**
   - Gets uploads playlist ID
   - Endpoint: `/youtube/v3/channels`

3. **YouTube Playlist Items API**
   - Fetches recent videos from uploads playlist
   - Endpoint: `/youtube/v3/playlistItems`

### RSS Fallback (Legacy)
- Also checks RSS feeds for video updates
- Used as backup to Data API v3

### Normalization Process

When a @username is detected:

1. Extract username from URL (`@SomeChannel` → `SomeChannel`)
2. Call Search API with query parameter
3. Find exact or close match by channel title
4. Store numeric ID and normalized name
5. Future checks use stable numeric ID

## Troubleshooting

### Issue: "YouTube notifications not working"

**Checklist**:
1. ✅ `YOUTUBE_API_KEY` set in `.env`
2. ✅ YouTube Data API v3 enabled in Google Cloud Console
3. ✅ Channel subscription added successfully (check `/youtube list`)
4. ✅ Bot has permission to post in notification channel

### Issue: "Slow notifications"

**Solutions**:
- Reduce polling interval: `/setyoutube interval 1`
- Some creators have delayed metadata (normal behavior)

### Issue: "Channel not found when subscribing"

** Causes**:
- @username doesn't exist
- Channel is private/unpublished
- YouTube API rate limit exceeded

## Performance & Quota Management

### Google Cloud API Limits

YouTube Data API v3 uses quota units:

| Operation | Quota Cost |
|-----------|-----------|
| Search list | 100 units |
| Channels.list | 1 unit |
| PlaylistItems.list | 1 unit |

**Typical usage per guild**:
- Subscribe: ~100 units (search API)
- Check for updates: ~2-3 channels × ~5 units per check
- With 60-min interval: <1,000 units/day total

### Optimization Tips
✅ Use numeric channel IDs when possible (skip search API)
✅ Set polling interval ≥5 minutes to stay under rate limits
✅ Limit subscribed channels per guild (no hard limit enforced)
