# Fluxer Instances

Boiler Snake can serve Discord **and** any number of [Fluxer](https://fluxer.app) chat instances from one process: one bot, one SQLite database, one set of features. Fluxer runs the text-command surface (prefix commands, not slash), XP, reactions, notes, warnings, tickets, notification tickers, and web-admin login.

Feature design and locked decisions live in the repo roadmap ([`roadmap/fluxer.md`](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/fluxer.md) on `main`); this page is the operator guide.

## What's supported today

| Works on Fluxer | Not available on Fluxer |
|-----------------|-------------------------|
| Message & reaction XP, cooldowns, decay | Voice XP |
| Text commands: `!help`, `!xp`, `!leaderboard`, notes, warnings, `!userinfo`, ticket text subcommands | Slash commands (Discord-side; Fluxer uses a text prefix) |
| YouTube / Twitch / GitHub Releases notifications | Event reminders (Discord scheduled events — ticker no-ops) |
| Reaction-role panels (real reactions) | Music (Lavalink is Discord-only) |
| Web-admin sign-in with a Fluxer account | Buttons, selects, modals, `/ticket panel`, `/staff syncpermissions` (Discord-only) |

Role assignment (level→role), ticket **channel creation**, and honeypot **bans** are implemented behind a per-community `elevated_permissions` flag that **defaults to off**. Leave it off unless your instance is verified for bot role/channel/ban writes — everything in the left column works with it off.

## Getting started with a Fluxer instance

1. **Create the app on the instance.** In that instance's user settings → **Apps**, create an application, add a **bot**, and copy its bot token. For web-admin login, also create OAuth credentials (client id/secret) on **that instance's** application and register the redirect URI `{PUBLIC_BASE_URL}/auth/fluxer/<slug>/callback` — the slug is the first 16 hex chars of SHA-256 of the instance key, e.g. instance key `https://fluxer.app` → slug `ca018642478f5c55` (`echo -n "https://fluxer.app" | sha256sum | cut -c1-16`).
2. **Set `FLUXER_INSTANCES`** in `.env` (full example below).
3. **Restart the bot.** Each connected instance logs one line: `[fluxer] <instanceKey> api=… gateway=…`.
4. **Check the sign-in page.** If the entry has `clientId` + `clientSecret`, a **Continue with Fluxer** button appears on `{PUBLIC_BASE_URL}/auth/login` (see [Web Admin Console](web-admin.md)).
5. Try `!xp` in a server the bot is a member of.

## Environment variables

| Variable | Meaning |
|----------|---------|
| `FLUXER_INSTANCES` | JSON array, one object per instance (see below). Unset/empty = Discord-only, exactly as before |
| `FLUXER_COMMAND_PREFIX` | Text prefix for Fluxer commands. Default `!`. 1–8 characters, no whitespace, no `<`/`>`. `/` is accepted only as an explicit value |
| `FLUXER_ALLOW_INSECURE` | Set to `1` to allow non-loopback `http:` origins. Dev/lab only — the bot token travels unencrypted |

All of this is additive and env-only: keep `DISCORD_TOKEN` for the Discord bot, add `FLUXER_INSTANCES` to run both (Fluxer-only, without `DISCORD_TOKEN`, works too). `npm run register` stays Discord-only and ignores `FLUXER_INSTANCES`.

`CLIENT_ID` / `CLIENT_SECRET` remain the **Discord** application's own credentials (command registration, staff-permission OAuth). Fluxer OAuth is **per instance**: `clientId` / `clientSecret` live inside `FLUXER_INSTANCES`.

### `FLUXER_INSTANCES` format

```env
FLUXER_INSTANCES=[{"instanceKey":"https://fluxer.app","origin":"https://fluxer.app","token":"YOUR_FLUXER_BOT_TOKEN","clientId":"YOUR_FLUXER_OAUTH_CLIENT_ID","clientSecret":"YOUR_FLUXER_OAUTH_CLIENT_SECRET","label":"Fluxer"}]
```

Per-entry fields:

| Field | Required | Rule |
|-------|----------|------|
| `origin` | yes | Absolute `http:`/`https:` URL of the instance. The bot discovers endpoints via `GET {origin}/.well-known/fluxer`. `http:` is allowed only for loopback hosts, or with `FLUXER_ALLOW_INSECURE=1` |
| `token` | yes | The instance bot's token. Sent only to endpoints that instance's own discovery document declares; never logged |
| `instanceKey` | no | Stable id used in logs, the database, and the web-login slug. Defaults to the normalized origin |
| `clientId` / `clientSecret` | no | OAuth app registered on **that** instance — needed only for the web-admin login button |
| `label` | no | Login-button label. Defaults to the origin |

A broken `FLUXER_INSTANCES` value (malformed JSON, missing `origin` or `token`, duplicate `instanceKey`, illegal URL scheme) **stops the bot at boot** with the specific reason — a half-configured Fluxer block is never silently ignored. An individual instance failing to log in later only degrades that instance (see Troubleshooting).

## Commands and the prefix

- Fluxer has no slash-command picker. Commands run as **prefixed text**: `!help`, `!xp`, `!warn add user 123456789012345678 reason "spam"`.
- The prefix is a literal, case-sensitive match (default `!`, set your own with `FLUXER_COMMAND_PREFIX`); command names are case-insensitive.
- Options are **named, not positional**: `name value` pairs. Quote multi-word values (`reason "too many words"`).
- `!help`, `!help warn`, `!help warn add` show what you may run; Discord-only commands print a "Discord only" line.
- A message that doesn't match the prefix is normal chat (XP-eligible). A prefix command never earns XP.
- The server's command-channel allow-list applies here too: commands in an unlisted channel get `Commands aren't enabled in this channel.`

## Private replies (DM policy)

Fluxer has no ephemeral messages, so anything the bot answers **privately** on Discord — `!xp`, warning detail, `!warn mine`, notes, `!userinfo`, warning exports, expiry notices — is **DM'd** on Fluxer. If the user's DMs are closed or the DM send fails, the channel reply is **only the specific error** (e.g. `I could not DM you the result: …`) — never the private content. Leaderboards and notification posts are not private; they stay in the channel.

## Web admin sign-in

With the console enabled ([Web Admin Console](web-admin.md)), the sign-in page shows one **Continue with Fluxer** button per configured instance that has `clientId` + `clientSecret`. Operator-relevant behavior:

- **Fluxer-only deployments** (no Discord `CLIENT_ID`/`CLIENT_SECRET`): set `SESSION_SECRET` **and** `OAUTH_STATE_SECRET` explicitly. Both default to Discord's `CLIENT_SECRET`, so without them the web login fails closed (`OAuth state secret not configured`) and the sign-in page stays unavailable.

- Fluxer login is a **second provider**: it sets its own cookie (`web_session_fx`) and never touches the Discord `web_session`. A Fluxer session sees only that instance's communities.
- Scopes are `identify` + `guilds` only; the flow uses PKCE (S256).
- **One Fluxer session per browser**: signing into a second Fluxer instance rotates the Fluxer session — it does not add a cookie.
- Sessions last at most the instance's refresh-token horizon (**30 days** by default) and refresh transparently before the 7-day access token expires.
- An instance whose discovery fails shows "Login unavailable" behind its button until it's reachable.

## Snapshot & rollback

The communities migration (the schema change that lets Fluxer and Discord coexist) is **forward-only**. Snapshot before the first new version starts against a live volume:

1. **Stop the bot** so the WAL is quiet. Optionally run `PRAGMA wal_checkpoint(TRUNCATE);` on `xpbot.sqlite`.
2. **Copy all four things**: `xpbot.sqlite`, `xpbot.sqlite-wal`, `xpbot.sqlite-shm`, **and** `ticket-transcripts/`. Copying the `.sqlite` file alone drops commits still sitting in the WAL.
3. **Deploy.** The migration runs in one transaction; a failure rolls it back.

To **roll back**: stop the new bot, restore all three SQLite files **and** `ticket-transcripts/` from the copy, then start the **previous image**. Never start the new image on old files (it re-migrates them) and never start the old image on migrated files (missing columns). See [Database — Backup Recommendations](database.md#backup-recommendations) for WAL-safe backups.

## Running two deployments (warning)

Running a Discord-only container next to a Fluxer-only container is an **ops choice**, not a supported share: give them **separate `DATA_DIR` volumes** and separate `.env` files. **Never mount one volume into both deployments.** SQLite allows a single writer — two processes sharing one `xpbot.sqlite` is corruption, not isolation — and both copies would run the same tickers (YouTube, Twitch, decay, …) twice. The same rule applies during rollbacks: one deployment owns a volume at a time.

## Troubleshooting

- **`FLUXER_INSTANCES is not valid JSON: …` at boot** → the bot exits with the exact parser error. The value must be a single-line JSON array; keep the double quotes.
- **`... uses plain http:; allowed only for loopback hosts or with FLUXER_ALLOW_INSECURE=1`** → use `https:` for real deployments; set `FLUXER_ALLOW_INSECURE=1` only for dev/lab.
- **`[fluxer] <key> login failed: …` in the log** → that instance is unreachable or the token was revoked. Discord and every other instance keep serving; the bot exits non-zero only when **every** configured endpoint fails to log in.
- **`[web] FLUXER_INSTANCES is invalid — Fluxer web login disabled`** → the web console keeps running with Discord login. Fix the JSON to restore the Fluxer buttons.
- **No Fluxer button on `/auth/login`** → that entry is missing `clientId`/`clientSecret` (the bot works; only the button needs OAuth credentials).
- **`I could not DM you the result: …` in a channel** → expected when the user's DMs are closed (see DM policy).
