# Honeypot Channels & Ban Roles

Catch spam accounts and raiders with decoy **channels** and/or **roles**. Non-exempt users who trigger a honeypot are banned immediately.

## Overview

### Honeypot channels

A **honeypot channel** looks like a normal channel but is only meant to trap bots and malicious accounts that auto-join and post everywhere. Legitimate members are never told about these channels (or are blocked from seeing them via Discord permissions).

When anyone posts in a honeypot channel, the bot **deletes** the message (if it can). Exempt roles are not banned; non-exempt users are:

1. **DMed** with the ban reason (if DMs are open)
2. **Banned** from the guild
3. **Skipped** for XP awards

### Honeypot ban roles

A **honeypot ban role** is a normal Discord role that, when **granted** to a member, causes an immediate ban. Typical uses:

- A decoy role name that raiders self-assign via another bot or a public role menu
- Manual staff assignment as a one-click ban workflow
- Any integration that applies the role to suspicious accounts

When a non-exempt member **receives** a configured ban role, the bot:

1. **DMs** them with the ban reason (if DMs are open)
2. **Bans** them from the guild

Members who **already** hold the role when you run `/honeypot banrole add` are **not** retroactively banned—only new grants (via `GuildMemberUpdate`) trigger the ban.

### Exempt roles = staff roles

Honeypot **exemption uses the same list as guild staff roles** (`staff_roles` table / `/staff`). There is no separate honeypot-only exempt table.

- `/honeypot exempt add` is the **same operation** as `/staff role add` (documented in code as such)
- `/honeypot exempt del` removes the role from **staff roles** (and therefore from honeypot exemption)
- `/honeypot exempt list` lists **staff roles** (with a note that they are also used for honeypot exemption)

Staff and other trusted roles should be on this list so they are not banned if they post in honeypot channels or receive a ban role while testing. Messages from exempt members in honeypot channels are still deleted.

See [Staff Roles](staff-roles.md) for junior vs senior levels and the broader admin gate.

## Bot Permissions

The bot needs these Discord permissions for honeypots to work:

| Permission | Why |
|------------|-----|
| **Ban Members** | Issue the ban |
| **Manage Messages** | Delete bait messages; pin/delete the warning notice; strip reactions on the notice |
| **Send Messages** / **View Channel** | Post the warning notice; read messages |
| **Attach Files** | Attach the warning image |

Also ensure:

- The bot’s **highest role is above** any role it needs to ban
- The bot is **not** blocked from the honeypot channel by channel overwrites
- **Server Members Intent** is enabled (required for ban-role detection via member updates)
- You re-register slash commands after updates: `npm run register`

## Recommended Setup

### 1. Exempt staff first

```bash
/staff role add role:@Moderator
/staff role add role:@Admin
# equivalent:
/honeypot exempt add role:@Moderator
/honeypot exempt add role:@Admin
```

Always configure staff / exempt roles **before** marking channels as honeypots. There is no automatic exemption for users with Manage Server—only listed roles (and bots, which are ignored).

### 2. Create a decoy channel

Typical approaches:

- A channel with a tempting name (`#free-nitro`, `#verify-here`, `#announcements-backup`) that real members cannot see
- Or a public-looking channel that only spam bots tend to find and flood

### 3. Mark it as a honeypot

```bash
/honeypot channel add channel:#free-nitro
```

The bot immediately posts a **warning notice** in that channel:

- **Image-only message** (no plain text body, no embed copy)
- Modal-style PNG with large **DO NOT POST HERE**, smaller honeypot explanation, and ban warning
- Message is **pinned** when the bot has Manage Messages
- Scrapers that only read `message.content` / embed fields get nothing useful
- **Reactions are stripped** from the notice as soon as they appear, and again on a 10-minute sweep (so leftovers from downtime are cleared)

Removing a honeypot with `/honeypot channel del` also deletes that warning message when possible.

### 4. (Optional) Ban role

```bash
/honeypot banrole add role:@Raid-Bait
```

Anyone granted that role is banned (same exempt list as channels — any `staff_roles` entry).

### 5. Verify

```bash
/honeypot channel list
/honeypot banrole list
/honeypot exempt list
# or:
/staff role list
```

## Commands

All honeypot commands require **Manage Guild** and reply **ephemerally**.

### `/honeypot banrole add`

Mark a role as a honeypot ban role.

```bash
/honeypot banrole add role:@Honeypot
```

### `/honeypot banrole list`

List configured ban roles.

### `/honeypot banrole del`

Stop banning when a role is granted.

```bash
/honeypot banrole del role:@Honeypot
```

### `/honeypot channel add`

Mark a channel as a honeypot.

```bash
/honeypot channel add channel:#trap-channel
```

**Effect**: Anyone without a staff / exempt role who posts in that channel is banned.

### `/honeypot channel list`

List all honeypot channels for this guild.

```bash
/honeypot channel list
```

### `/honeypot channel del`

Remove a channel from the honeypot list (does not delete the Discord channel).

```bash
/honeypot channel del channel:#trap-channel
```

### `/honeypot exempt add`

Add a role that is exempt from honeypot bans. **Same as** `/staff role add` — writes to `staff_roles`.

```bash
/honeypot exempt add role:@Staff
```

Members with **any** configured staff role (junior or senior) are safe from honeypot bans.

### `/honeypot exempt list`

List staff roles (also used as the honeypot exempt list).

```bash
/honeypot exempt list
```

### `/honeypot exempt del`

Remove a role from staff roles (and therefore from honeypot exemption).

```bash
/honeypot exempt del role:@Staff
```

Prefer `/staff role remove` when you only mean to change the admin gate, so the intent is clear—both paths update the same table.

## Enforcement Details

| Case | Result |
|------|--------|
| Bot or webhook message | Ignored (no ban, no delete) |
| Human with staff / exempt role | Message deleted; no ban; no XP |
| Human without staff / exempt role | DM → delete message → ban; no XP |
| DM closed / blocked | Ban still proceeds; failure logged |
| Bot lacks Ban Members / role hierarchy | Ban fails; error logged; message may still be deleted |
| Rapid multiple messages | In-flight de-dupe (~10s) avoids repeated ban attempts |

Ban audit reason: `Honeypot: Posted in a honeypot channel`.

### DM text (approx.)

Users who can receive DMs get a message explaining they were banned for posting in a restricted channel used to catch spam and raids, and that they should contact staff if it was a mistake.

## Best Practices

1. **Exempt before enable** — add staff roles first (`/staff role add` or `/honeypot exempt add`).
2. **Hide honeypots from real members** when possible (channel permissions), so only scrapers and raiders post.
3. **Don’t put honeypots in command-allowed channels** if you use `/setcommandchannel`; staff may still need slash commands elsewhere.
4. **Log review** — configure `/setlog audit` so honeypot bans post rich embeds (user, channel/role, DM status, success/failure). Also watch console for `[honeypot]` lines.
5. **False positives** — if a real user is banned, unban them in Discord and tighten channel visibility or exempt roles.

## Troubleshooting

### Users post but are not banned

- Bot missing **Ban Members**
- Bot role is **below** the target member’s highest role
- Channel is not listed: `/honeypot channel list`
- User has a staff / exempt role: `/honeypot exempt list` or `/staff role list`
- Bot process not restarted after deploy (handlers only load on start)

### Staff got banned

- Their role was not in `staff_roles` — add it with `/staff role add` or `/honeypot exempt add`, then unban them in Discord
- Only roles on that list are exempt, not “anyone with Manage Server”

### Message not deleted

- Bot needs **Manage Messages**
- Message may already be gone, or channel overwrites block the bot

### Reactions stick on the warning notice

- Bot needs **Manage Messages** in the honeypot channel
- Live strip runs on every reaction; a full sweep also runs every 10 minutes
- Restart the bot after deploy so the reaction handler and sweep are loaded

### DM not received

- User has DMs closed to server members; ban still applies

## Audit log

When an **audit log channel** is set (`/setlog audit`), each honeypot enforcement posts a **Honeypot ban** embed (or **Honeypot ban failed** if Discord rejects the ban):

| Field | Meaning |
|-------|---------|
| User | Who was banned |
| Trigger | Posted in honeypot channel, or ban role granted |
| Channel / Ban role(s) | Where or how they triggered |
| Ban | Succeeded / Failed |
| DM | Sent, or failed/closed |
| Reason | Short ban reason |

Config changes (`/honeypot channel|banrole|exempt add|del`) also appear as purple configuration embeds. See [Audit Log](audit-log.md).

## Related

- [Staff Roles](staff-roles.md) — shared `staff_roles` list, junior/senior, admin gate
- [Commands Reference](commands/index.md) — full slash command docs
- [Database Schema](database.md) — `honeypot_channels`, `honeypot_ban_roles`, and `staff_roles` (exempt)
- [Architecture Overview](architecture.md) — `MessageCreate` / member-update enforcement path
- [Audit Log](audit-log.md) — staff embeds for honeypot bans
- [Setup](setup.md) — bot permissions
