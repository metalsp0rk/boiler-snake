# Command Restrictions

Control where slash commands can be used within your Discord guild.

## Overview

By default, all HeisenXP-Bot commands are accessible anywhere in the server. You can restrict this to specific channels using `/setcommandchannel`.

### Why Use Command Restrictions?

- Keep XP-related commands out of general chat
- Organize command usage in designated channels
- Reduce visual noise in busy channels
- Create admin-only areas for configuration

## Default Behavior

**Without any configuration**: All commands work everywhere.
**With configuration**: Commands only work in explicitly allowed channels.

### Exception: Self-Lockout Prevention

`/setcommandchannel` is always accessible to users with `ManageGuild` permission, even if they're not in an allowed channel. This prevents administrators from accidentally locking themselves out.

## Commands

### `/setcommandchannel add`

Add a channel to the allowed list:

```bash
/setcommandchannel add channel:#xp-trackers
```

**Effect**: Slash commands now only work in #xp-trackers (and channels added previously).

### `/setcommandchannel remove`

Remove a channel from the allowed list:

```bash
/setcommandchannel remove channel:#xp-trackers
```

**Effect**: Commands can no longer be used in that channel.

### `/setcommandchannel list`

View all currently allowed channels:

```bash
/setcommandchannel list
```

**Output format**:
```
**Allowed command channels:**
- <#123456789>
- <#987654321>
```

## Usage Notes

### Multiple Channels

You can have multiple allowed channels:

```bash
/setcommandchannel add channel:#xp-general
/setcommandchannel add channel:#xp-admins
/setcommandchannel add channel:#xp-announcements
```

All three channels will then receive commands.

### Clearing Restrictions

To disable restrictions entirely (allow everywhere again):

**Method 1**: Remove all channels from the list manually:
```bash
# Run/remove each channel you added
/setcommandchannel remove channel:#channel1
/setcommandchannel remove channel:#channel2
```

**Method 2**: Use a fresh database or reset guild settings (advanced users only).

### Effect on Admin Commands

All admin commands are affected by restrictions:
- `/settings` ✓ (restricted if in non-allowed channel)
- `/setxp` ✓ (restricted)
- `/leveltorole` ✓ (restricted)

### Effect on Public Commands

Even public commands respect restrictions:
- `/xp [user]` ✓ (restricted to allowed channels)
- `/leaderboard` ✓ (restricted to allowed channels)

## Visual Feedback in Discord

When a user tries to use a command in a non-allowed channel:

**Response**:
```
Commands aren't enabled in this channel.
```

This message is ephemeral (only visible to the user who tried).

## Use Cases

### Use Case 1: Dedicated XP Server
```
Channels:
- #xp-trackers    ← Commands allowed here only
- #general        ← No XP commands here
```

Configuration:
```bash
/setcommandchannel add channel:#xp-trackers
```

### Use Case 2: Admin-Only Configuration
```
Channels:
- #bot-admins     ← Command configuration only
- #member-area    ← Public commands allowed too
```

Configuration:
```bash
# Allow public access in member area
/setcommandchannel add channel:#member-area
# Restrict admin commands to staff channel
/setcommandchannel remove channel:#general
```

### Use Case 3: Event-Based Commands
```
Channels:
- #event-xp       ← XP tracking during event
- #off-season     ← Commands disabled here
```

Configuration:
```bash
# Setup for active period
/setcommandchannel add channel:#event-xp

# Switch after event ends  
/setcommandchannel remove channel:#event-xp
```

## DatabaseStorage

### `allowed_command_channels` Table

```sql
CREATE TABLE allowed_command_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,  -- ms epoch timestamp
  PRIMARY KEY (guild_id, channel_id)
);
```

**Query pattern**:
```javascript
// Check if commands are allowed in current channel
SELECT channel_id FROM allowed_command_channels 
WHERE guild_id=? AND channel_id=?
```

## Monitoring

### View Current Configuration

Use `/settings` to see command restriction status:

```
**Commands allowed in:** <#123456789>, <#987654321>
```

If no restrictions are set:
```
**Commands allowed in:** All channels (no restriction set)
```

## Best Practices

### naming Conventions
- Use `#xp-*` prefix for XP-related channels
- Clear separation between "public" and "admin" areas
- Example: `#xp-general`, `#xp-admins`, `#xp-log`

### Communication
Inform users about command restrictions:
> "XP commands are now only available in #xp-trackers"

Use your own bot's `/xp` and `/leaderboard` outputs to show current status.

### Security Note

Command restriction is purely cosmetic/user-experience:
- Does not lock out administrators with `ManageGuild`
- Does not prevent direct message usage (DMs bypass guild restrictions)
- Does not affect command registration in Developer Portal

## Resetting Settings

### Complete Reset (Database Level)

⚠️ **Warning**: This removes all XP data, roles, and configuration.

```sql
-- SQLite console (xpbot.sqlite file)
DELETE FROM allowed_command_channels;
UPDATE guild_settings SET msg_xp=5, reaction_xp=2, voice_xp_per_min=1, ...;
```

### Per-Guild Reset

If using multi-guild setup, clear individual guilds:
```javascript
db.prepare("DELETE FROM allowed_command_channels WHERE guild_id=?").run(guildId);
```
