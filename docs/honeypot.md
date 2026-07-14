# Honeypot Channels

Catch spam accounts and raiders by marking decoy channels as honeypots. Anyone who posts in a honeypot channel is banned immediately (unless they have an exempt role).

## Overview

A **honeypot channel** looks like a normal channel but is only meant to trap bots and malicious accounts that auto-join and post everywhere. Legitimate members are never told about these channels (or are blocked from seeing them via Discord permissions).

When a non-exempt user posts in a honeypot channel, the bot:

1. **DMs** them with the ban reason (if DMs are open)
2. **Deletes** the triggering message (if the bot can)
3. **Bans** them from the guild
4. **Skips** XP awards for that message

Staff and other trusted roles can be marked **exempt** so they are not banned if they post while testing or cleaning up.

## Bot Permissions

The bot needs these Discord permissions for honeypots to work:

| Permission | Why |
|------------|-----|
| **Ban Members** | Issue the ban |
| **Manage Messages** | Delete bait messages; pin/delete the warning notice |
| **Send Messages** / **View Channel** | Post the warning notice; read messages |
| **Attach Files** | Attach the warning image |

Also ensure:

- The bot’s **highest role is above** any role it needs to ban
- The bot is **not** blocked from the honeypot channel by channel overwrites
- You re-register slash commands after updates: `npm run register`

## Recommended Setup

### 1. Exempt staff first

```bash
/honeypot exempt add role:@Moderator
/honeypot exempt add role:@Admin
```

Always configure exempt roles **before** marking channels as honeypots. There is no automatic exemption for users with Manage Server—only listed roles (and bots, which are ignored).

### 2. Create a decoy channel

Typical approaches:

- A channel with a tempting name (`#free-nitro`, `#verify-here`, `#announcements-backup`) that real members cannot see
- Or a public-looking channel that only spam bots tend to find and flood

### 3. Mark it as a honeypot

```bash
/honeypot channel add channel:#free-nitro
```

The bot immediately posts a **warning notice** in that channel:

- Red **embed** with a clear “do not post” message
- **Modal-style PNG image** with the same warning (text is not in plain message content)
- Message is **pinned** when the bot has Manage Messages
- Simple scrapers that only read `message.content` see an empty body

Removing a honeypot with `/honeypot channel del` also deletes that warning message when possible.

### 4. Verify

```bash
/honeypot channel list
/honeypot exempt list
```

## Commands

All honeypot commands require **Manage Guild** and reply **ephemerally**.

### `/honeypot channel add`

Mark a channel as a honeypot.

```bash
/honeypot channel add channel:#trap-channel
```

**Effect**: Anyone without an exempt role who posts in that channel is banned.

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

Add a role that is exempt from honeypot bans.

```bash
/honeypot exempt add role:@Staff
```

Members with **any** configured exempt role are safe.

### `/honeypot exempt list`

List roles exempt from honeypot bans.

```bash
/honeypot exempt list
```

### `/honeypot exempt del`

Remove a role from the exempt list.

```bash
/honeypot exempt del role:@Staff
```

## Enforcement Details

| Case | Result |
|------|--------|
| Bot or webhook message | Ignored (no ban) |
| Human with exempt role | Message kept; no ban; no XP |
| Human without exempt role | DM → delete message → ban; no XP |
| DM closed / blocked | Ban still proceeds; failure logged |
| Bot lacks Ban Members / role hierarchy | Ban fails; error logged; message may still be deleted |
| Rapid multiple messages | In-flight de-dupe (~10s) avoids repeated ban attempts |

Ban audit reason: `Honeypot: Posted in a honeypot channel`.

### DM text (approx.)

Users who can receive DMs get a message explaining they were banned for posting in a restricted channel used to catch spam and raids, and that they should contact staff if it was a mistake.

## Best Practices

1. **Exempt before enable** — add staff roles first.
2. **Hide honeypots from real members** when possible (channel permissions), so only scrapers and raiders post.
3. **Don’t put honeypots in command-allowed channels** if you use `/setcommandchannel`; staff may still need slash commands elsewhere.
4. **Log review** — watch console for `[honeypot]` lines (successful bans, DM/delete/ban failures).
5. **False positives** — if a real user is banned, unban them in Discord and tighten channel visibility or exempt roles.

## Troubleshooting

### Users post but are not banned

- Bot missing **Ban Members**
- Bot role is **below** the target member’s highest role
- Channel is not listed: `/honeypot channel list`
- User has an exempt role: `/honeypot exempt list`
- Bot process not restarted after deploy (handlers only load on start)

### Staff got banned

- Their role was not exempt — add it with `/honeypot exempt add`, then unban them in Discord
- Only roles are exempt, not “anyone with Manage Server”

### Message not deleted

- Bot needs **Manage Messages**
- Message may already be gone, or channel overwrites block the bot

### DM not received

- User has DMs closed to server members; ban still applies

## Related

- [Commands Reference](commands/index.md) — full slash command docs
- [Database Schema](database.md) — `honeypot_channels` and `honeypot_exempt_roles` tables
- [Architecture Overview](architecture.md) — `MessageCreate` enforcement path
- [Setup](setup.md) — bot permissions
