# Configuration Guide

Configure Boiler Snake for your server's needs using environment variables and in-game commands.

## Table of Contents

- [Environment Variables](#environment-variables)
- [Per-Guild Settings](#per-guild-settings)
- [Command Reference](#command-reference)
- [Advanced Configuration](#advanced-configuration)

---

## Environment Variables

### Required Variables

#### `DISCORD_TOKEN` (Required)
Your Discord bot's token. Get this from [Discord Developer Portal](https://discord.com/developers/applications).

```env
DISCORD_TOKEN=YOUR_BOT_TOKEN
```

⚠️ **Never commit this to version control!** The `.gitignore` file should already exclude it.

#### `CLIENT_ID` (Required)
Your application's client ID. Also from Developer Portal → General Information.

```env
CLIENT_ID=YOUR_APP_CLIENT_ID
```

### Optional Variables

#### `LAVALINK_HOST` (Optional — required for music)
Hostname of a Lavalink **4.2+** node. Compose sets `lavalink`. Local: `127.0.0.1`. See [Music player](music.md).

```env
LAVALINK_HOST=127.0.0.1
LAVALINK_PORT=2333
LAVALINK_PASSWORD=YOUR_LAVALINK_PASSWORD
```

#### `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` (Optional)
Spotify Web API **client credentials** for catalog search and playlist resolve. They do **not** stream Spotify audio. Required for Spotify URLs; YouTube/SoundCloud still work without them.

```env
SPOTIFY_CLIENT_ID=YOUR_SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET=YOUR_SPOTIFY_CLIENT_SECRET
```

#### `YOUTUBE_API_KEY` (Optional)
Google Cloud API key for YouTube notifications. Required only if using `/youtube` features.

**Setup**:
1. Create project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable YouTube Data API v3
3. Create API Key
4. Add to `.env`

```env
YOUTUBE_API_KEY=YOUR_YOUTUBE_API_KEY
```

#### `DEV_GUILD_ID` (Optional)
Server ID for instant command registration during development.

```env
DEV_GUILD_ID=YOUR_TEST_GUILD_ID
```

Using this registers commands instantly to one guild instead of globally (which can take 1 hour).

#### Ticket transcripts (optional)

| Variable | Purpose |
|----------|---------|
| `TICKET_HTTP_PORT` | Serve HTML transcripts + media (`GET /t`, `/t/{uuid}`, `/t/{uuid}/assets/…`) |
| `TICKET_PUBLIC_BASE_URL` | Public origin for archive embed links |
| `TICKET_MAX_ASSET_BYTES` | Max size per mirrored file (default 50 MiB) |
| `TICKET_MAX_ASSETS` | Max media files downloaded per ticket (default 100) |
| `AI_API_KEY` | Optional OpenAI-compatible key for non-sensitive close summaries |
| `AI_BASE_URL` | API base URL (default OpenAI) |
| `AI_MODEL` | Model name |

See [Help Tickets](tickets.md).

#### Database location

| Variable | Purpose |
|----------|---------|
| `DATA_DIR` | Directory for `xpbot.sqlite` and `ticket-transcripts/` |
| `DB_PATH` | Full path to the SQLite file (overrides `DATA_DIR` for the DB file only) |

---

## Per-Guild Settings

Each Discord server (guild) has its own settings stored in SQLite.

### Default Values

| Setting | Default | Description |
|---------|---------|-------------|
| `msg_xp` | 5 | XP per message |
| `reaction_xp` | 2 | XP per reaction |
| `voice_xp_per_min` | 1 | XP earned per minute in voice |
| `msg_cooldown_sec` | 20 | Seconds between message XP awards |
| `reaction_cooldown_sec` | 10 | Seconds between reaction XP awards |
| `decay_enabled` | 1 (true) | Enable daily XP decay |
| `decay_window_days` | 7 | Time window for activity check |
| `decay_min_messages` | 20 | Minimum messages to avoid decay |
| `decay_percent` | 0.10 | XP reduction (10%) |
| `level_xp_factor` | 100 | Level formula factor (see [Level Curve](#level-curve-configuration)) |
| `youtube_polling_interval_minutes` | 5 | YouTube API check frequency |
| `audit_log_channel_id` | *(none)* | Channel for bans, kicks, role-change embeds |
| `message_log_channel_id` | *(none)* | Channel for deleted-message embeds |
| `warn_log_channel_id` | *(none)* | Dedicated warning issue/void log; falls back to audit log |
| `warn_dm_members` | `1` | DM members on warn issue/void (`0` = off) |
| `ticket_category_id` | *(none)* | Parent category for open tickets |
| `ticket_archive_channel_id` | *(none)* | Staff channel for close summaries / transcripts |
| `ticket_rate_limit_minutes` | 60 | Minutes between member self-creates (`0` = off) |

See [Audit Log & Message Log](audit-log.md) for setup and event details.

---

## Command Reference

### View Current Settings

```bash
/settings
```

**Output**:
```
**Boiler Snake Settings**
**XP:** msg=5, reaction=2, voice/min=1
**Cooldowns:** msg=20s, reaction=10s
**Decay:** enabled=true, threshold=20 msgs / 7 days, percent=10%
**Level curve factor:** 100 (Level L starts at L²×factor)
**Commands allowed in:** All channels (no restriction set)
**Level→Role mappings:**
- <@&123456789> @ Lvl 5 (drop after 3d)
```

### Configure Staff Log Channels

```bash
/setlog audit channel:#staff-audit
/setlog message channel:#message-deletes
/setlog show
/setlog audit clear:true
```

Full details: [Audit Log & Message Log](audit-log.md).

### Configure XP Awards

```bash
/setxp message:<int> reaction:<int> voice:<int> msgcooldown:<int> reactioncooldown:<int> factor:<int>
```

`/setxp` accepts all six options above, including `factor` to change the [level curve](#level-curve-configuration) (1–10,000, default 100).

#### Examples

**Aggressive XP Gain** (for new server with low baseline):
```bash
/setxp message:10 reaction:5 voice:5 msgcooldown:10 reactioncooldown:5
```
Users earn more XP, but still need 20 seconds between messages to prevent spam.

**Conservative XP** (stable server):
```bash
/setxp message:3 reaction:1 voice:1 msgcooldown:60 reactioncooldown:30
```

**Disable Message XP**:
```bash
/setxp message:0
```
Set `message` to 0 to disable XP from messages entirely. Users can still earn via reactions and voice.

### Configure Decay

```bash
/setdecay enabled:<bool> messages:<int> days:<int> percent:<number>
```

#### Common Patterns

**Standard Decay** (recommended starting point):
```bash
/setdecay enabled:true messages:20 days:7 percent:5
```
Requires ~3 messages/week to maintain XP. Loses 5% for inactivity.

**Tough Enforcement** (high engagement server):
```bash
/setdecay enabled:true messages:10 days:3 percent:20
```

**No Decay**:
```bash
/setdecay enabled:false
```
Disable decay system entirely while keeping other features.

### Managing Level→Role Mappings

#### View Current Mappings
```bash
/leveltorole list
```

#### Add a New Mapping
```bash
/leveltorole set role:@Member level:5 dropdays:7
```

**Parameter details**:
- `role`: Role to grant (required)
- `level`: Level threshold (minimum: 0)
- `dropdays`: Days to keep role after dropping below threshold (minimum: 0)

#### Remove a Mapping
```bash
/leveltorole remove role:@Member
```

### Command Channel Restrictions

#### Add Allowed Channel
```bash
/setcommandchannel add channel:#xp-trackers
```

#### Remove from Allowed List
```bash
/setcommandchannel remove channel:#general
```

#### View Allowed Channels
```bash
/setcommandchannel list
```

### YouTube Configuration (Requires API Key)

#### Set Notification Channel
```bash
/setyoutube channel #stream-alerts
```

#### Configure Polling Frequency
```bash
/setyoutube interval 10
```
Range: 1-60 minutes. Lower = faster alerts but more API quota usage.

### Subscribe to YouTube Channels

```bash
/youtube add url:https://www.youtube.com/@SomeChannel
```

**Supported formats**:
- Full URL with @username: `https://www.youtube.com/@SomeChannel`
- Channel ID URL: `https://www.youtube.com/channel/UCxxxxxxxxxxx`
- Numeric ID: `UCxxxxxxxxxxx`
- Bare username: `@SomeChannel`

#### View Subscriptions
```bash
/youtube list
```

#### Unsubscribe
```bash
/youtube remove channel:UCxxxxxxxxxxx
```

### Honeypot Channels

Decoy channels that ban users who post (except exempt roles). Full guide: [Honeypot Channels](honeypot.md).

**Setup order** (important):

```bash
# 1. Exempt staff first
/honeypot exempt add role:@Moderator
/honeypot exempt add role:@Admin

# 2. Then mark decoy channels
/honeypot channel add channel:#trap-channel

# 3. Verify
/honeypot channel list
/honeypot exempt list
```

Requires bot **Ban Members** permission (and **Manage Messages** to delete honeypot posts).

### Staff Roles

Trusted roles for the staff command gate (and ticket visibility by level). Full guide: [Staff Roles](staff-roles.md).

```bash
# Trust a role as senior staff (staff gate + ticket channel view)
/staff role add role:@Moderator level:senior

# Junior: staff commands / notes / warns, but no automatic ticket overwrites
/staff role add role:@Helper level:junior

/staff role list
/staff settings
```

- **Mutations** (`add` / `remove` / `setlevel`): **Manage Server** only
- **List / settings**: staff gate (Manage Server **or** any trusted staff role)
- **senior** → staff commands + automatic ticket channel overwrites
- **junior** → staff commands only (tickets need claim / `/ticket addstaff`)

### Audit & Message Logs

```bash
/setlog audit channel:#staff-audit
/setlog message channel:#message-deletes
/setlog show
```

See [Audit Log & Message Log](audit-log.md).

### Reaction Roles (brief)

Self-serve emoji panels with optional min-level gates. Full guide: [Reaction Roles](reaction-roles.md).

```bash
/reactionrole panel create channel:#roles title:Self Roles description:Pick a role
# Then add options using the panel message ID from the create reply:
/reactionrole option add message_id:… role:@Announcements level:0 removable:true
```

Requires the **staff gate** (Manage Server or a trusted staff role). Bot needs **Manage Roles** (and **Manage Messages** to strip unconfigured reactions).

### Help Tickets (brief)

Private support channels with panel, sensitive mode, and HTML archives. Full guide: [Help Tickets](tickets.md).

```bash
/staff role add role:@Moderator level:senior   # ticket visibility
/ticket setcategory category:#Tickets
/ticket setarchive channel:#ticket-archive
/ticket panel channel:#support
/ticket settings
```

Requires bot **Manage Channels**. Put the bot role **above** senior staff roles so ticket overwrites succeed.

### Event Reminders

Pre-event pings for members who marked **Interested** on a Discord scheduled event. Full guide: [Scheduled Event Reminders](event-reminders.md).

```bash
/eventreminder create event:…
/eventreminder list
/eventreminder setchannel channel:#event-alerts
```

### Staff Notes & Warnings

| Feature | Entry commands | Docs |
|---------|----------------|------|
| **Staff notes** | `/note add`, `/note list`, … | [Staff Notes](staff-notes.md) |
| **Warnings** | `/warn issue`, `/warn mine`, `/setwarn` | [Warning System](warnings.md) |

Notes are private staff context; warnings are formal permanent records (voidable). Both use the staff gate (Manage Server or a trusted staff role), including `/setwarn`.

### User Activity Config

Ignore channels/categories and backfill post rankings used by `/userinfo` **Activity** (senior staff). Full guide: [User Activity Summary](user-activity.md).

```bash
/activityconfig ignore add kind:channel target:#spam
/activityconfig ignore list
/activityconfig status
```

`/activityconfig` requires the **staff gate** (Manage Server or a trusted staff role).

---

## Level Curve Configuration

### Understanding the Formula

```
Level = floor(sqrt(XP / level_xp_factor))
```

**XP required for level L**: `L² × factor`

| Level | Factor=50 | Factor=100 | Factor=200 |
|-------|----------|-----------|-----------|
| 1     | ≥ 50 XP  | ≥ 100 XP  | ≥ 200 XP  |
| 5     | ≥ 1,250  | ≥ 2,500   | ≥ 5,000   |
| 10    | ≥ 5,000  | ≥ 10,000  | ≥ 20,000  |
| 20    | ≥ 20,000 | ≥ 40,000  | ≥ 80,000  |

### Defaults and how to change the factor

| Item | Value |
|------|--------|
| Default `level_xp_factor` | **100** (stored in `guild_settings`) |
| Shown in | `/settings` → **Level curve factor** |
| Slash command | `/setxp factor:<int>` (range 1–10,000) |

Change the level curve via slash command:

```bash
/setxp factor:150    # Slower leveling (more XP per level)
/setxp factor:50     # Faster leveling (less XP per level)
```

The reply shows before/after values and a reminder of the formula (`L² × factor`). You can also adjust rates and the factor in one command:

```bash
/setxp message:3 factor:200
```

Use a positive integer. Recommended ranges if you do change it:

- **Fast-paced server**: 30–75
- **Standard server**: 100 (default)
- **Long-term server**: 150–300

**Lower factor** → faster leveling (less XP per level). **Higher factor** → slower leveling.

---

## Best Practices by Server Type

### Small servers (<100 members)

**Focus**: Quick engagement, visible progression

```bash
/setxp message:2 reaction:1 voice:2 msgcooldown:10 reactioncooldown:5
/setdecay enabled:true messages:5 days:7 percent:5
/leveltorole set role:@Member level:3 dropdays:3
```

### Medium servers (100-1,000 members)

**Focus**: Balanced progression

```bash
/setxp message:5 reaction:2 voice:1 msgcooldown:20 reactioncooldown:10
/setdecay enabled:true messages:10 days:7 percent:5
/leveltorole set role:@Member level:5 dropdays:3
/leveltorole set role:@Veteran level:20 dropdays:7
```

### Large servers (1,000+ members)

**Focus**: Prevent XP inflation, long-term goals

```bash
/setxp message:3 reaction:1 voice:1 msgcooldown:60 reactioncooldown:30
/setdecay enabled:true messages:5 days:14 percent:5
/leveltorole set role:@Member level:10 dropdays:7
/leveltorole set role:@Veteran level:50 dropdays:14
/leveltorole set role:@Elite level:100 dropdays:30
```

---

## Troubleshooting Configuration

### Issue: Users aren't leveling up as expected

**Check settings**:
```bash
/settings
```

Verify XP rates, cooldowns, and the **Level curve factor** match expectations. Use `/setxp factor:<int>` to adjust the curve directly.

**Test manually**:
```bash
# Give test user XP (if you have admin access to DB)
# Or just wait for natural progression
```

### Issue: Role not being granted

1. Check [`/settings`](./commands/) output for role mappings
2. Verify bot has **Manage Roles** permission
3. Ensure bot's highest role is **above** the role it manages
4. Confirm user has reached required level (check with `/xp [user]`)

### Issue: Decay not reducing XP

1. Check decay settings are enabled in [`/settings`](./commands/)
2. Verify user sent enough messages in time window
3. Wait for 4:00 AM server time (when decay runs)

**Force test decay** (manual):
```javascript
// In bot console or via database:
UPDATE users SET xp=1000 WHERE guild_id='XYZ' AND user_id='ABC';
-- Then wait for next scheduled decay run at 4 AM
```

### Issue: YouTube notifications not working

1. Verify `YOUTUBE_API_KEY` in `.env`
2. Check that YouTube Data API v3 is enabled
3. Test subscription with `/youtube add` and `/youtube list`

---

## Configuration Checklist

Before going live:

- [ ] Bot added to server (with correct permissions)
- [ ] Commands registered (`npm run register`)
- [ ] `DISCORD_TOKEN` and `CLIENT_ID` set in `.env`
- [ ] Role position configured (bot above managed / senior staff roles)
- [ ] Staff roles configured (`/staff role add …`, `/staff role list`)
- [ ] XP rates adjusted (`/setxp`)
- [ ] Level→role mappings created (`/leveltorole`)
- [ ] Command channels restricted if needed (`/setcommandchannel`)
- [ ] Optional: audit/message logs (`/setlog`)
- [ ] Optional: tickets (category, archive, panel) — see [tickets](tickets.md)
- [ ] Optional: reaction-role panels — see [reaction roles](reaction-roles.md)
- [ ] Optional: YouTube notifications
- [ ] Database backups set up

---

## Resetting Configuration

### Individual Settings
Use command overrides to reset individual values:
```bash
/setxp message:5  # Reset to default
/setdecay enabled:false
```

### Complete Reset
Reset to default settings for entire guild:

**Option 1**: Use `/settings` UI (admin commands with no args)
**Option 2**: Manual database update (advanced)

```sql
UPDATE guild_settings SET 
  msg_xp=5,
  reaction_xp=2, 
  voice_xp_per_min=1,
  msg_cooldown_sec=20,
  decay_enabled=1,
  decay_window_days=7,
  decay_min_messages=20,
  decay_percent=0.10,
  level_xp_factor=100;
```
