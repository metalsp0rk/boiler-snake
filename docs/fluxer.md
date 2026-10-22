# Fluxer Instances

Boiler Snake can serve Discord **and** any number of [Fluxer](https://fluxer.app) chat instances from one process: one bot, one SQLite database, one set of features. Fluxer runs the text-command surface (prefix commands, not slash), XP, reactions, notes, warnings, tickets, gork, notification tickers, and web-admin login.

Feature design and locked decisions live in the repo roadmap ([`roadmap/fluxer.md`](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/fluxer.md) on `main`); this page is the operator guide.

## What's supported today

| Works on Fluxer | Not available on Fluxer |
|-----------------|-------------------------|
| Message & reaction XP, cooldowns, decay | Voice XP |
| Text commands: every command whose surface works without components — permission-filtered `!help` is the authority (see Commands and the prefix) | Slash commands (Discord-side; Fluxer uses a text prefix) |
| YouTube / Twitch / GitHub Releases notifications | Event reminders (Discord scheduled events — ticker no-ops) |
| Reaction-role panels (real reactions; grants queue behind `elevated_permissions` — see Elevated permissions below) | Music (Lavalink is Discord-only) |
| Gork AI Q&A: keyword + role-mention triggers, audits posting with platform-neutral jump links | Community Events (`/event`, `/eventsignup`, `/eventconfig`, `/eventchannels` — the events service is Discord-only) |
| Web-admin sign-in with a Fluxer account | Buttons, selects, modals, `/ticket panel`, `/staff syncpermissions`, `/gork summarize` (Discord-only) |

## Elevated permissions (advanced)

Level→role sync, reaction-role grants, ticket **channel creation**, and honeypot **bans** are gated per community on the `communities.elevated_permissions` flag, which **defaults to 0 (off)**. The gate covers every role write (`addRole`/`removeRole`), every channel write (create, delete, rename, permission overwrites), and bans — with the flag off each returns a named refusal (`elevated Fluxer actions are disabled for community …`) instead of calling the instance. So the left column above is **not** entirely true with the flag off: a reaction-role panel claim does not complete — the claim is kept (the user's reaction and its durable row) and the grant is **deferred** until the flag flips and the boot sweep replays it.

Even with the flag on, a ban against the guild **owner** is refused by Fluxer itself (`403 MISSING_PERMISSIONS`; higher-ranked targets can be refused the same way — live record docs:5). Honeypot treats that as a terminal refusal for the target: the hit is still consumed, exactly one ban attempt is made, and the specific verdict lands in the log and the audit trail. A persistently hitting owner-ranked author keeps counting the mass-ban breaker (#440) until you resolve it (exempt the role, or remove the trap).

Nothing in the bot turns the flag on — there is **no command and no env variable** that writes it; it is a manual `communities`-row database change. Flipping it hands the bot real role/channel/ban capability on that community: apply the same caution the bot applies to its confirm-once destructive actions (#471 H2-15) — know exactly which communities you are enabling, and only do it on an instance verified for those writes. The procedure:

1. **Stop the bot.** One writer on the SQLite file; make the change quiet (see [Snapshot & rollback](#snapshot-rollback)).
2. **Flip the rows you mean**: `UPDATE communities SET elevated_permissions = 1 WHERE platform = 'fluxer' AND instance_key = '<instanceKey>' AND external_guild_id = '<guild id>';` — per community, not the whole table (dropping the `external_guild_id` filter elevates every community on that instance).
3. **Restart.** At start the reactionRoles feature sweeps every elevated Fluxer community and replays deferred grants (log: `[reactionRoles] deferred-grant sweep community …: granted …`); role sync and channel/ban writes take the flag from the next read.

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

```dotenv
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

### Discovery endpoints that matter

Beyond `origin`, the bot takes everything from the instance's discovery document (`GET {origin}/.well-known/fluxer`). Two entries decide how loudly things work:

- **`endpoints.api_public` is the only REST authority** — the bot never falls back to the instance origin for API calls (the API commonly lives on a different host). If discovery doesn't resolve it, boot warns (`… discovery did not resolve api_public — webhook URL construction will fail loudly for this instance`) and bridge webhook URL building fails loudly with a specific cause — relay copies are never silently dropped.
- **`endpoints.webapp` is the base for every platform-neutral jump link** the bot posts (message jump URLs, gork rundown footers). An instance that omits it or advertises an unusable value gets those links omitted (`… discovery exposed an unusable endpoints.webapp — jump links will be omitted for this instance`); a *wrong* one gives links that go nowhere.

## Commands and the prefix

- Fluxer has no slash-command picker. Commands run as **prefixed text**: `!help`, `!xp`, `!warn add user 123456789012345678 reason "spam"`.
- **Breadth:** every command whose handler works without Discord components runs on the prefix dispatcher — XP and warnings, notes, userinfo, tickets (text arms), settings and the config verbs, `staff`, `link`, `bridge`, `gork`, and more. What stays Discord-only answers `That command is not available on Fluxer yet.`: `play`, `music`, `eventreminder`, and the Community Events commands (`event*`) are refused by the dispatcher and never listed in `!help`; component-bound arms (`ticket panel`, `gork summarize`, ticket-channel lifecycle subcommands) refuse with the same sentence in-handler.
- The prefix is a literal, case-sensitive match (default `!`, set your own with `FLUXER_COMMAND_PREFIX`); command names are case-insensitive.
- Options are **named, not positional**: `name value` pairs. Quote multi-word values (`reason "too many words"`).
- `!help`, `!help warn`, `!help warn add` show what you may run — the list is **permission-filtered** (staff and admin commands appear only for callers who may run them), so it is the authoritative inventory for you; Discord-only commands print a "Discord only" line.
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
- Sessions last at most the instance's refresh-token horizon — the token response's `refresh_expires_in`, or the **30-day** default when the instance declares none (`FLUXER_REFRESH_HORIZON_MS`). Access-token refresh is driven by the instance's own `expires_in`: rotation happens inside the final 24 h before that declared expiry. 7 days is the access lifetime Fluxer typically issues (also the fallback default when `expires_in` is omitted) — an instance-issued value, not a shipped guarantee.
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

## See also

- [Account linking](account-linking.md) — link a member's Discord and Fluxer accounts so XP and gork memories mirror between a bridge-paired pair
- [Channel bridges](bridge.md) — pair individual channels between the two platforms
