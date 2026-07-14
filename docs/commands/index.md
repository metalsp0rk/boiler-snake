# Commands Reference

Complete guide to all HeisenXP-Bot slash commands, organized by permission level.

## Table of Contents

- [Public Commands](#public-commands) - Available to everyone
- [Admin/Mod Commands](#adminmod-commands) - Require ManageGuild permission

---

## Public Commands

Available to all guild members without special permissions.

### `/xp` - View XP and Level

Show your own or another user's current XP and level.

**Usage**:
```bash
/xp                          # Your stats
/xp user:@SomeUser           # Another user's stats
```

**Options**:
- `user`: User to check (optional, defaults to command author)

**Response**:
```
@Username: **1250 XP** (Level **3**)
```

### `/leaderboard` - View Top Users

Display the top 10 users by XP with a generated PNG leaderboard.

**Usage**:
```bash
/leaderboard                 # Top 10
/leaderboard limit:20        # Show up to 20 users (still renders top 10)
```

**Options**:
- `limit`: Maximum number of users to query (max: 20)

**Response**: PNG image attachment titled "heisenxp-leaderboard.png"

---

## Admin/Mod Commands

Require the **Manage Guild** permission. All responses are ephemeral.

### `/settings` - Show Guild Configuration

Display current XP rates, decay settings, role mappings, and allowed command channels.

**Usage**:
```bash
/settings
```

**Response**:
```
**HeisenXP-Bot Settings**
**XP:** msg=5, reaction=2, voice/min=1
**Cooldowns:** msg=20s, reaction=10s
**Decay:** enabled=true, threshold=20 msgs / 7 days, percent=10%
**Level curve factor:** 100 (Level L starts at L²×factor)
**Commands allowed in:** <#123456789>, All channels (no restriction set)
**Level→Role mappings:**
- <@&123456789> @ Lvl 5 (drop after 3d)
```

### `/setxp` - Configure XP Settings

Adjust XP rewards and cooldowns for messages, reactions, and voice activity.

**Usage**:
```bash
/setxp message:10 reaction:5 voice:2 msgcooldown:30 reactioncooldown:15
```

**Options** (all optional):
- `message`: XP per message (default: 5)
- `reaction`: XP per reaction (default: 2)
- `voice`: XP per minute in voice (default: 1)
- `msgcooldown`: Message cooldown seconds (default: 20)
- `reactioncooldown`: Reaction cooldown seconds (default: 10)

**Limits**:
- Maximum per-event XP: 1,000,000,000 (1 billion)
- All values must be ≥ 0
- Cooldowns can be set to 0 for no delay

**Example Configurations**:

Aggressive XP gain:
```bash
/setxp message:20 reaction:5 voice:5 msgcooldown:10 reactioncooldown:5
```

Conservative (low inflation):
```bash
/setxp message:3 reaction:1 voice:1 msgcooldown:60 reactioncooldown:30
```

### `/setdecay` - Configure XP Decay

Set up daily XP reduction for inactive users.

**Usage**:
```bash
/setdecay enabled:true messages:20 days:7 percent:10
```

**Options** (all optional):
- `enabled`: Enable/disable decay system (true/false)
- `messages`: Minimum messages required in time window
- `days`: Time window size (days)
- `percent`: XP reduction percentage (0-95%)

**Logic**: If user sends fewer than `messages` messages in the last `days`, their XP is reduced by `percent`.

**Examples**:

Balanced decay:
```bash
/setdecay enabled:true messages:10 days:7 percent:5
# Lose 5% XP if < 1 msg/day for a week
```

Strict enforcement:
```bash
/setdecay enabled:true messages:3 days:7 percent:25
# Lose 25% XP if < 3 msgs in a week
```

Disable decay:
```bash
/setdecay enabled:false
```

### `/leveltorole` - Manage Level→Role Mappings

Create or remove automatic role grants based on XP levels.

#### Subcommand: `set` - Create Mapping

Grant a role when users reach a certain level, with optional drop grace period.

**Usage**:
```bash
/leveltorole set role:@Member level:5 dropdays:7
```

**Parameters**:
- `role`: Role to grant (required)
- `level`: Level threshold (≥ 0)
- `dropdays`: Days to keep role after dropping below threshold

**Example**:
```bash
# Basic member role at level 5
/leveltorole set role:@Member level:5 dropdays:3

# Veteran status at level 20 with longer grace period
/leveltorole set role:@Veteran level:20 dropdays:14
```

#### Subcommand: `remove` - Delete Mapping

Remove an existing level→role mapping.

**Usage**:
```bash
/leveltorole remove role:@Member
```

**Example**:
```bash
/leveltorole remove role:@SeasonalRole
```

#### Subcommand: `list` - Show Mappings

Display all configured role mappings.

**Usage**:
```bash
/leveltorole list
```

### `/setcommandchannel` - Restrict Command Locations

Control which channels can use bot commands.

#### Subcommand: `add` - Allow Commands in Channel

Add a channel to the allowed list.

**Usage**:
```bash
/setcommandchannel add channel:#xp-trackers
```

#### Subcommand: `remove` - Remove from Allowed List

Remove a channel from allowed channels.

**Usage**:
```bash
/setcommandchannel remove channel:#general
```

#### Subcommand: `list` - View Allowed Channels

Show all channels where commands are permitted.

**Usage**:
```bash
/setcommandchannel list
```

### `/youtube` - YouTube Channel Management

Manage subscriptions to YouTube channels for live stream and video notifications. Requires `YOUTUBE_API_KEY` in environment.

#### Subcommand: `add` - Subscribe to Channel

Add a YouTube channel for notifications.

**Usage**:
```bash
/youtube add url:https://www.youtube.com/@TechChannel
```

**Supported formats**:
- Full URL with @username: `https://www.youtube.com/@SomeChannel`
- Full URL with ID: `https://www.youtube.com/channel/UCxxxxx`
- Numeric ID only: `UCxxxxxxxxxxx`
- Bare @username: `@SomeChannel`

#### Subcommand: `remove` - Unsubscribe

Remove a YouTube channel subscription.

**Usage**:
```bash
/youtube remove channel:https://www.youtube.com/channel/UCxxxxx
```

#### Subcommand: `list` - View Subscriptions

Display all subscribed channels.

**Usage**:
```bash
/youtube list
```

### `/setyoutube` - YouTube Configuration

Configure YouTube notification settings.

#### Subcommand: `channel` - Set Notification Location

Choose where live stream and video alerts appear.

**Usage**:
```bash
/setyoutube channel #stream-notifications
```

#### Subcommand: `interval` - Configure Polling Frequency

Set how often the bot checks for updates (1-60 minutes).

**Usage**:
```bash
/setyoutube interval 5
```

**Notes**:
- Lower intervals = faster alerts but more API quota usage
- Recommended: 5-30 minutes for most servers

### `/honeypot` - Honeypot Channel Management

Configure decoy channels that ban users who post, and roles that are exempt from those bans. See [Honeypot Channels](../honeypot.md) for full setup guidance.

#### Subcommand group: `channel` - Manage Honeypot Channels

##### `channel add` - Mark Channel as Honeypot

```bash
/honeypot channel add channel:#trap-channel
```

**Effect**:
- Non-exempt users who post are DM'd, their message is deleted if possible, and they are banned
- The bot posts a **pinned image-only warning** (large “DO NOT POST HERE” + honeypot explanation baked into the PNG; no plain text for scrapers)

##### `channel list` - List Honeypot Channels

```bash
/honeypot channel list
```

##### `channel del` - Remove Honeypot Marking

```bash
/honeypot channel del channel:#trap-channel
```

Does not delete the Discord channel—only removes honeypot enforcement.

#### Subcommand group: `exempt` - Manage Exempt Roles

##### `exempt add` - Exempt a Role

```bash
/honeypot exempt add role:@Moderator
```

Members with this role will not be banned for posting in honeypot channels. Configure exempt roles **before** enabling honeypots.

##### `exempt list` - List Exempt Roles

```bash
/honeypot exempt list
```

##### `exempt del` - Remove Role Exemption

```bash
/honeypot exempt del role:@Moderator
```

### `/reactionrole` - Reaction Role Panels

Bot-managed embeds where members claim roles by reacting. See [Reaction Roles](../reaction-roles.md) for full behavior (level gates, removable flag, unconfigured reaction stripping).

#### Subcommand group: `panel`

##### `panel create` - Post a New Panel

```bash
/reactionrole panel create channel:#roles title:Self Roles description:React to claim a role
```

Posts an embed and returns the panel **message ID** for option commands.

##### `panel edit` - Update Title/Description

```bash
/reactionrole panel edit message_id:123456789 title:New Title
```

##### `panel deploy` - Copy Panel to Another Channel

```bash
/reactionrole panel deploy message_id:123456789 channel:#roles
```

Copies title, description, and all emoji→role options into a new message in the destination channel (source left in place). Returns the new message ID.

##### `panel list` - List Panels

```bash
/reactionrole panel list
```

##### `panel delete` - Delete Panel

```bash
/reactionrole panel delete message_id:123456789
```

Removes DB rows and tries to delete the Discord message.

#### Subcommand group: `option`

##### `option add` - Map Emoji → Role

```bash
/reactionrole option add message_id:123 role:@Gamer level:5 removable:true
```

Then send the emoji as your **next message** (or type `stop` to cancel). The bot updates the panel, confirms, and deletes your emoji message.

**Parameters**:
- `message_id`: Panel message ID (required)
- `role`: Role to grant (required)
- `level`: Minimum level (default 0)
- `removable`: Remove role when reaction removed (default true)

##### `option remove` - Remove Mapping

```bash
/reactionrole option remove message_id:123
```

Then send the emoji to remove as your **next message** (or type `stop` to cancel).

##### `option list` - List Options

```bash
/reactionrole option list message_id:123
```

#### Subcommand: `sync` - Repair Embed + Reactions

```bash
/reactionrole sync message_id:123456789
```

---

## Permission Matrix

| Command | Permissions Required | Ephemeral Response |
|---------|---------------------|-------------------|
| `/xp` [user] | None (public) | Yes |
| `/leaderboard` | None (public) | No (but uses attachments) |
| `/settings` | ManageGuild | Yes |
| `/setxp` | ManageGuild | Yes |
| `/setdecay` | ManageGuild | Yes |
| `/leveltorole set` | ManageGuild | Yes |
| `/leveltorole remove` | ManageGuild | Yes |
| `/leveltorole list` | ManageGuild | Yes |
| `/setcommandchannel add` | ManageGuild | Yes |
| `/setcommandchannel remove` | ManageGuild | Yes |
| `/setcommandchannel list` | ManageGuild | Yes |
| `/youtube add` | ManageGuild | Yes |
| `/youtube remove` | ManageGuild | Yes |
| `/youtube list` | ManageGuild | Yes |
| `/setyoutube channel` | ManageGuild | Yes |
| `/setyoutube interval` | ManageGuild | Yes |
| `/honeypot channel add` | ManageGuild | Yes |
| `/honeypot channel list` | ManageGuild | Yes |
| `/honeypot channel del` | ManageGuild | Yes |
| `/honeypot exempt add` | ManageGuild | Yes |
| `/honeypot exempt list` | ManageGuild | Yes |
| `/honeypot exempt del` | ManageGuild | Yes |
| `/reactionrole panel create` | ManageGuild | Yes |
| `/reactionrole panel edit` | ManageGuild | Yes |
| `/reactionrole panel deploy` | ManageGuild | Yes |
| `/reactionrole panel delete` | ManageGuild | Yes |
| `/reactionrole panel list` | ManageGuild | Yes |
| `/reactionrole option add` | ManageGuild | Yes |
| `/reactionrole option remove` | ManageGuild | Yes |
| `/reactionrole option list` | ManageGuild | Yes |
| `/reactionrole sync` | ManageGuild | Yes |

---

## Error Handling

### "You don't have permission to use this"

User attempts admin command without `ManageGuild` permission.

**Solution**: Grant the user or their role "Manage Server" permission in Discord.

### "Commands aren't enabled in this channel"

Command restriction is active, and user is not in an allowed channel.

**Solutions**:
- Add current channel to allowed list: `/setcommandchannel add`
- Remove restrictions entirely by removing all allowed channels

### "Invalid YouTube URL"

YouTube subscription command receives malformed URL.

**Valid formats**:
```
https://www.youtube.com/@SomeChannel
https://www.youtube.com/channel/UCxxxxxxxxxxx
@SomeChannel
UCxxxxxxxxxxx
```

---

## Quick Reference Card

```
PUBLIC:
/xp [user]              → View XP & level
/leaderboard            → Top 10 PNG leaderboard

ADMIN/MOD:
/settings               → Show current config
/setxp                  → Set XP rates & cooldowns
/setdecay               → Configure decay system
/leveltorole set/remove/list → Manage role mappings
/setcommandchannel add/remove/list → Command restrictions
/youtube add/remove/list        → YouTube subscriptions
/setyoutube channel/interval    → YouTube settings
/honeypot channel add/list/del  → Honeypot channels
/honeypot exempt add/list/del   → Honeypot exempt roles
/reactionrole panel|option|sync → Reaction-role panels
```
