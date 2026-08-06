# Audit Log & Message Log

Staff-facing Discord channel logs for moderation and role activity.

## Overview

Boiler Snake can post rich embeds to independently configured channels:

| Stream | Setting | Events |
|--------|---------|--------|
| **Audit log** | `audit_log_channel_id` | Bans, kicks, reaction-role changes, level→role grants/drops (including after XP decay), config changes |
| **Message log** | `message_log_channel_id` | Single and bulk message deletes |
| **Warning log** (optional) | `warn_log_channel_id` | Warning issue/void embeds; when unset, those events fall back to the **audit log** |

Raw XP gain/decay amounts are **not** logged. Only **role changes** caused by XP/level systems appear in the audit log.

If a stream’s channel is unset, that stream is disabled (no errors).

## Setup

### 1. Bot permissions & intents

In the [Discord Developer Portal](https://discord.com/developers/applications) → Bot → Privileged Gateway Intents:

- ✅ **Message Content Intent** (message XP + delete content when cached)
- ✅ **Server Members Intent** (kick detection via `GuildMemberRemove`)

In each log channel, the bot needs:

| Permission | Why |
|------------|-----|
| **View Channel** | See the channel |
| **Send Messages** | Post embeds |
| **Embed Links** | Rich embeds |
| **View Audit Log** (guild-wide) | Attribute bans, kicks, and deletes to moderators |

### 2. Configure channels

```bash
/setlog audit channel:#staff-audit
/setlog message channel:#message-deletes
/setlog show
```

Optional dedicated channel for formal warnings (see [Warning System](warnings.md)):

```bash
/setwarn log channel:#warn-log
/setwarn log clear:true
```

Clear a stream (disable it):

```bash
/setlog audit clear:true
/setlog message clear:true
```

Also shown under **Logs** in `/settings`. Warning log target is listed in `/warn settings`.

Re-register slash commands after updating the bot:

```bash
npm run register
```

## What gets logged

### Message log

**Message deleted**
- Author, channel, message ID
- Content (when the bot had seen the message — short-lived in-memory cache)
- Attachment names/links and embed summaries when available
- Original send time when known
- Deleter when Discord’s audit log can identify them (best-effort)

**Messages bulk-deleted**
- Channel, count, sample of recovered author/content from cache

### Audit log

**Member banned**
- Target, executor, reason
- Marks bans performed by this bot when the Discord audit log executor is the bot
- **Honeypot bans are not duplicated here** — they use the dedicated honeypot embed below

**Honeypot ban** (or **Honeypot ban failed**)
- Fired when the bot enforces a honeypot (channel post or ban-role grant)
- User, trigger type, channel and/or ban role(s), ban success/failure, DM status, reason
- Failed bans still post (permissions / hierarchy issues) so staff can fix setup
- Requires `audit_log_channel_id` configured via `/setlog audit`

**Member kicked**
- Only when Discord’s audit log shows a Kick for that user within a short window
- Voluntary leaves are **not** logged

**Reaction role granted / removed**
- Member, role, emoji, panel link, min level, removable flag
- Only when a role actually changes (no log if the member already had the role)

**Level role granted / removed**
- After XP-driven `syncMemberRoles` (message, reaction, voice XP, or `/grantxp`) when roles change
- After daily decay when level→role grace drops fire
- After decay when reaction-claim roles are stripped for min level
- Batched per user per sync (all granted/removed roles in one embed)
- Source field: `XP / level sync`, `XP decay (level→role)`, `XP decay (reaction role min level)`, or `Admin /grantxp`

**Admin configuration changes** (purple embeds)
- Who changed settings, which slash command, and a before→after (or action) summary
- Covers successful mutations for:
  - `/setlog`, `/setxp`, `/setdecay`, `/grantxp`
  - `/leveltorole` set/remove
  - `/setcommandchannel` add/remove
  - `/youtube` add/remove, `/setyoutube` *
  - `/honeypot` channel/banrole/exempt add/del
  - `/reactionrole` panel create/edit/deploy/delete, option add/remove (when emoji is applied), sync
- **Not** logged: read-only commands (`/settings`, `list`/`show` subcommands, `/testnotification`, `/xp`, `/leaderboard`)

## Privacy & retention

- Message content is cached **in memory only** (capped size, ~1 hour TTL) to improve delete logs. It is **not** written to SQLite.
- Audit/message history lives only in the Discord channels you configure (and Discord’s own retention).
- The existing `activity_log` table is for XP decay math only, not staff audit embeds.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Nothing posts | `/setlog show`; bot can Send Messages + Embed Links in those channels |
| Bans/kicks lack “Banned by” / no kicks | Bot needs **View Audit Log**; **Server Members Intent** enabled for kicks |
| Delete logs have no content | Bot must be online and able to read the channel when the message was sent (cache miss on old messages) |
| `/setlog` missing | Run `npm run register` and restart the bot |
