# Audit Log & Message Log

Staff-facing Discord channel logs for moderation and role activity.

## Overview
> **Scope note (#471 INT-15):** the message-audit stream is **Discord-only by
> construction** — `cacheMessage` gates Fluxer writes (per #277) and `logs/index.js`
> binds delete/ban/kick to the Discord client. A future Fluxer consumer must add a
> normalized-message contract assertion before wiring events here.


Boiler Snake can post rich embeds to independently configured channels:

| Stream | Setting | Events |
|--------|---------|--------|
| **Audit log** | `audit_log_channel_id` | Bans, kicks, reaction-role changes, level→role grants/drops (including after XP decay), config changes |
| **Message log** | `message_log_channel_id` | Single and bulk message deletes |
| **Warning log** (optional) | `warn_log_channel_id` | Warning issue/void embeds; when unset, those events fall back to the **audit log** |
| **Gork Q&A log** (optional) | `gork_log_channel_id` (`/gork logchannel`) | "Gork Q&A" embeds + failure one-liners; when unset, they fall back to the **audit log** |

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

**Delivery is verified, not assumed (#445).** When you set a channel, the bot
posts the config-change embed onto that stream **first**. If it can't deliver —
missing **View Channel** / **Send Messages**, the channel is a category, or it
was race-deleted — the setting is **not saved**, and the reply carries the
specific cause instead of a false success. Previously a stream pointed at a
channel the bot couldn't post to died silently forever, and `/setlog` confirmed
it anyway. Every resolve/send failure is now logged with community + channel
context, so a dead stream is visible from the logs alone.

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

**Gork Q&A fallback**
- The gork audit stream (`src/features/gork/audit.js`) posts a "Gork Q&A" embed per completed exchange (and a compact one-liner for failed/timed-out ones) to the dedicated gork log channel when `/gork logchannel` has set one — and to this **audit log channel** when it has not. So a guild with only `/setlog audit` configured sees every gork exchange here. See [Gork](gork.md).

**Admin configuration changes** (purple embeds)
- Who changed settings, which slash command, and a before→after (or action) summary
- Covers successful mutations for:
  - `/setlog`, `/setxp`, `/setdecay`, `/grantxp`
  - `/leveltorole` set/remove
  - `/setcommandchannel` add/remove
  - `/youtube` add/remove, `/setyoutube` *
  - `/twitch` add/remove, `/settwitch` *
  - `/github` watch/channel/role/remove/token (clear + set)
  - `/honeypot` channel/banrole/exempt add/del
  - `/reactionrole` panel create/edit/deploy/delete, option add/remove (when emoji is applied), sync
  - `/gork *` config commands (keyword, role trigger, context, cooldown, rules, search, ste, enable, logchannel, memory, budget, summarize-budget, bans)
  - `/staff role` add/remove/setlevel
  - `/ticket settings` + panel create/edit/delete + `close` with a staff note
  - `/eventreminder` channel/offsets/persistent/clear
  - `/note settings`
  - `/setwarn` dm/expiry/log
  - `/activityconfig` ignore/backfill
- **Not** logged: read-only commands (`/settings`, `list`/`show` subcommands, `/testnotification`, `/xp`, `/leaderboard`)

## Durable audit trail (`admin_audit`)

The Discord channel embeds above are **best-effort mirrors** — the durable
record of every mutating action lives in the SQLite `admin_audit` table
(migration `029_admin_audit`) regardless of what any channel is configured
to do.

- **Who writes it** — every mutating web, slash, and system action:
  - Web mutations write inside the request pipeline and **fail closed** — a
    failed audit insert aborts the response (`src/web/middleware/audit.js`);
    an unaudited web mutation never silently succeeds.
  - Slash handlers write `origin: 'slash'` rows via `recordSlashAudit`
    (`src/core/auditTrail.js`); automated jobs (decay tick, warning expiry,
    enforcement) write `origin: 'system'` via `recordSystemAudit`. These
    bot-side writes are deliberately fail-safe: a trail hiccup is logged
    and swallowed, never changing a command's reply (the mutation already
    committed; handlers stay the security source of truth).
  - Rows use the `feature.verb` action vocabulary (`warnings.add`,
    `xp.grant`, `github.watch_add`, `logs.channel_set`, …) with
    origin/actor/target columns and a redacted `details_json` (below).
- **Who reads it** — the web console's audit viewer at
  `/g/:guildId/audit` (admin-only, read-only, per-guild) — see
  [Web admin console](web-admin.md).
- **Retention** — pruned by the hourly retention sweep under
  `RETENTION_ADMIN_AUDIT_DAYS` (default **365** days — a full annual audit
  cycle; see [Configuration](configuration.md)).

### Details redaction

`details` objects are scanned before insert (`redactSensitive`, #368): a key
whose **whole word components** hit the credential vocabulary (`token`,
`secret`/`secrets`, `password`/`passwords`, `cookie`/`cookies` — so
`bot_token`, `accessToken`, `clientSecret` all match) has its **value
masked to `[redacted]`** while the **key stays** — the row shows something
was hidden instead of nothing being recorded. Matching is word-component,
not substring: count-sense plurals like `summarize_input_tokens` or
`max_tokens` (a deliberate vocabulary omission) and words like `tokenizer`
are legitimate payloads and survive intact. Nothing is ever dropped — the
pre-#368 belt that deleted whole matching keys is gone.

## Privacy & retention

- Message content is cached **in memory only** (capped size, ~1 hour TTL) to improve delete logs. It is **not** written to SQLite.
- The Discord channels you configure are the live feed (subject to Discord's own retention) — but every mutating action additionally lives in the durable `admin_audit` table described above, independent of any channel setting.
- The existing `activity_log` table is for XP decay math only, not staff audit embeds.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Nothing posts | `/setlog show`; bot can Send Messages + Embed Links in those channels |
| Bans/kicks lack “Banned by” / no kicks | Bot needs **View Audit Log**; **Server Members Intent** enabled for kicks |
| Delete logs have no content | Bot must be online and able to read the channel when the message was sent (cache miss on old messages) |
| `/setlog` missing | Run `npm run register` and restart the bot |
