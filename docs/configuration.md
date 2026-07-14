# Configuration Guide

Configure HeisenXP-Bot for your server's needs using environment variables and in-game commands.

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
DISCORD_TOKEN=OTg3NjU0MzIx.example-token-here
```

⚠️ **Never commit this to version control!** The `.gitignore` file should already exclude it.

#### `CLIENT_ID` (Required)
Your application's client ID. Also from Developer Portal → General Information.

```env
CLIENT_ID=987654321098765432
```

### Optional Variables

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
DEV_GUILD_ID=123456789012345678
```

Using this registers commands instantly to one guild instead of globally (which can take 1 hour).

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
| `level_xp_factor` | 100 | Level formula factor |
| `youtube_polling_interval_minutes` | 5 | YouTube API check frequency |
| `audit_log_channel_id` | *(none)* | Channel for bans, kicks, role-change embeds |
| `message_log_channel_id` | *(none)* | Channel for deleted-message embeds |

See [Audit Log & Message Log](audit-log.md) for setup and event details.

---

## Command Reference

### View Current Settings

```bash
/settings
```

**Output**:
```
**HeisenXP-Bot Settings**
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

### Configure XP Awards

```bash
/setxp message:<int> reaction:<int> voice:<int> msgcooldown:<int> reactioncooldown:<int>
```

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

### Adjusting the Curve

**Make it easier** (faster leveling):
```bash
/setxp level_xp_factor:50
```

**Make it harder** (slower leveling):
```bash
/setxp level_xp_factor:200
```

**Recommended values**:
- **Fast-paced server**: 30-75
- **Standard server**: 100 (default)
- **Long-term server**: 150-300

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

Verify XP rates and cooldowns match expectations.

**Test manually**:
```bash
# Give test user XP (if you have admin access to DB)
# Or just wait for natural progression
```

### Issue: Role not being granted

1. Check [`/settings`](/docs/commands/index.md) output for role mappings
2. Verify bot has **Manage Roles** permission
3. Ensure bot's highest role is **above** the role it manages
4. Confirm user has reached required level (check with `/xp [user]`)

### Issue: Decay not reducing XP

1. Check decay settings are enabled in [`/settings`](/docs/commands/index.md)
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
- [ ] Role position configured (bot above managed roles)
- [ ] XP rates adjusted (`/setxp`)
- [ ] Level→role mappings created (`/leveltorole`)
- [ ] Command channels restricted if needed (`/setcommandchannel`)
- [ ] YouTube notifications configured (optional)
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
