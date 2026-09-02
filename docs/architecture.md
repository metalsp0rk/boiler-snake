# Architecture Overview

Technical deep dive into Boiler Snake for developers and contributors.

## Overview

Boiler Snake is a [Discord.js](https://discord.js.org/) v14 bot with a SQLite backend. The codebase is a **modular monolith**: product areas live under `src/features/`, shared infrastructure under `src/core/`, `src/db/`, and `src/services/`, with a thin entrypoint.

## Testing

- **Unit** (`npm run test:unit`): pure math, cooldowns, registry, DB smoke — `test/*.test.js`
- **Integration** (`npm run test:integration`): full stack offline with temp SQLite and mocked Discord I/O — `test/integration/*.test.js`
- **All** (`npm test`): unit + integration via `node --test`
- Harness: `test/helpers/` (`createIntegrationEnv`). See `test/README.md`.
- Pipeline handlers (`onMessageCreate`, etc.), `runVoiceTick`, and YouTube `processChannel`/`runYoutubeTick` are exported for direct invocation without gateway login.

---

## File Structure

```
src/
├── index.js                 # Thin entry: env, client, features, pipelines, login
├── client.js                # Discord.js Client factory (intents/partials)
├── config.js                # Env contract + runtime assert
├── bot/
│   └── pipelines.js         # Ordered MessageCreate / ReactionAdd pipelines
├── core/
│   ├── constants.js         # MAX_XP_AWARD, MAX_SAFE_XP
│   ├── xpMath.js            # levelFromXp, clamps, validateXpValue
│   ├── cooldowns.js
│   ├── permissions.js       # isAdminOrMod / isStaff / isSeniorStaff + require*
│   └── interaction.js
├── services/
│   └── awardXp.js           # Unified XP → activity → roles → audit
├── features/
│   ├── load.js              # applyFeaturesToRegistry / start / registerEvents
│   ├── index.js             # Ordered feature list (20 modules)
│   ├── settings/            # /settings
│   ├── commandChannels/     # /setcommandchannel
│   ├── xp/                  # /xp /leaderboard /setxp /grantxp + award helpers
│   ├── decay/               # /setdecay + daily cron
│   ├── voice/               # Voice XP ticker
│   ├── music/               # /play /music + Lavalink voice streaming
│   ├── levelRoles/          # /leveltorole + syncMemberRoles
│   ├── logs/                # /setlog + auditLog + delete/ban/kick
│   ├── youtube/             # YouTube commands + RSS/API ticker
│   ├── twitch/              # /twitch /settwitch + Helix go-live ticker
│   ├── honeypot/            # /honeypot + ban/warn pipeline
│   ├── reactionRoles/       # /reactionrole + panel service
│   ├── eventReminders/      # /eventreminder + modal + ticker + gateway
│   ├── staffRoles/          # /staff role gate (isStaff / requireStaff; junior|senior)
│   ├── staffNotes/          # /note staff-only private notes
│   ├── warnings/            # /warn + /setwarn formal disciplinary records
│   ├── userinfo/            # /userinfo staff card + note/warn/activity buttons
│   ├── userActivity/        # /activityconfig + channel message counters + backfill
│   └── tickets/             # /ticket support channels + panel button/modal + archive HTTP
├── commands/
│   ├── registry.js          # name → handler map (from features)
│   ├── router.js            # InteractionCreate dispatch
│   └── register.js          # CLI: register slash commands
├── db.js                    # Facade re-export (stable require("./db"))
├── db/
│   ├── connection.js
│   ├── migrate.js
│   ├── migrations/
│   └── repositories/
├── render/
│   └── leaderboard.js       # PNG leaderboard (@napi-rs/canvas)
└── (compat shims)           # auditLog.js, roles.js, decay.js, … → features

xpbot.sqlite
package.json
.env.example
```

---

## Boot Sequence

```javascript
require("dotenv").config();
assertRuntimeEnv();                    // DISCORD_TOKEN
const client = createClient();
const registry = buildDefaultRegistry(); // features → commands + handlers
const ctx = { client, registry, ensureHoneypotWarning };

registerAllFeatureEvents(client, features, ctx);  // delete/ban/kick, ban-role, …
registerOrderedPipelines(client);                   // MessageCreate / ReactionAdd

client.once(ClientReady, () => startAllFeatures(client, features, ctx));
client.on(InteractionCreate, (i) => handleInteraction(i, ctx));
client.login(token);
```

### Feature module contract

```javascript
module.exports = {
  name: "example",
  commands: [/* SlashCommandBuilder */],
  handlers: { example: async (interaction, ctx) => {} },
  autocomplete: { example: async (interaction, ctx) => {} }, // optional
  registerEvents(client, ctx) {},  // optional
  start(client, ctx) {},           // optional (ClientReady)
};
```

### Ordered pipelines (`bot/pipelines.js`)

| Event | Order |
|-------|--------|
| **MessageCreate** | cache → pending RR emoji → honeypot → user channel activity → message XP |
| **MessageReactionAdd** | partials → honeypot warning strip → RR panels → reaction XP |
| **MessageReactionRemove** | reaction-role remove |

Independent events (message delete, ban, kick, honeypot ban-role, tickers) register via each feature’s `registerEvents` / `start`.

---

## Database Layer (`db/`)

- **connection.js** — SQLite open (`DB_PATH` / `DATA_DIR`), WAL
- **migrate.js** + **migrations/** — idempotent ordered steps
- **repositories/** — users, guildSettings, activity, youtube, twitch, honeypot, reactionRoles, staff notes/roles, warnings, tickets, user activity, …
- **index.js** — public facade (same API as legacy single-file `db.js`)

Migrations on load:

| Id | Purpose |
|----|---------|
| `001_base_schema` | CREATE TABLE IF NOT EXISTS |
| `002_guild_settings_columns` | reaction XP, log channels, upload role |
| `003_youtube_composite_pk` | rebuild youtube_channels only if PK is legacy |
| `004_youtube_and_honeypot_columns` | last_checked, warning_message_id |
| `005_clamp_bad_xp` | sanitize bad XP rows |
| `006_event_reminders` | event reminder tables + default channel column |
| `007_staff_notes` | staff_notes table (soft-delete, per-guild note_number) |
| `008_staff_roles` | staff_roles table (generalized honeypot exempt) |
| `009_warnings` | warnings + warn_dm_members |
| `010_tickets` | tickets / members / staff / messages + ticket_* settings |
| `011_staff_role_levels` | `staff_roles.level` junior \| senior (ticket visibility) |
| `012_warn_log_channel` | `guild_settings.warn_log_channel_id` (warn issue/void embeds) |
| `013_user_channel_activity` | daily per-channel message counters, ignore list, user backfill meta |
| `014_guild_activity_backfill` | guild-wide activity backfill status + channel cursors |
| `015_event_reminder_event_optouts` | per-event mute table for event reminders |
| `020_twitch` | twitch_channels table + twitch_* guild_settings columns |

### Core XP API

| Function | Purpose |
|----------|---------|
| `addXp` | Atomic XP add with clamps |
| `getXp` / `setXp` | Read / write XP |
| `topUsers` | Leaderboard rows |
| `getGuildSettings` / `updateGuildSettings` | Per-guild config |

---

## Shared XP award (`services/awardXp.js`)

Used by message XP, reaction XP, voice ticker, and admin `/grantxp`:

1. `addXp` (atomic)
2. `logActivity`
3. Resolve member
4. `levelFromXp` → `syncMemberRoles` → `logLevelRoleChanges`

---

## Feature highlights

| Feature | Notes |
|---------|--------|
| **xp** | Cooldowns in-memory; PNG leaderboard via `render/leaderboard` |
| **voice** | Per-minute; ≥2 eligible humans; skip mute/deafen/AFK |
| **decay** | Cron `0 4 * * *` local; re-syncs level + reaction roles |
| **levelRoles** | Grace-period drop via `levelRoles/sync.js` |
| **logs** | Audit + message log channels; in-memory delete cache |
| **youtube** | RSS + optional Data API; guild notification channel |
| **twitch** | Helix poll (≤100 ids/req); go-live dedup by stream id; separate channel + role from YouTube |
| **honeypot** | Channel posts / ban-roles; warning PNG; exempt roles |
| **reactionRoles** | Bot panels, min level, removable options |
| **eventReminders** | Modal config, interest-synced roles, offset ticker, cleanup |
| **staffRoles** | `/staff` role list; junior (command gate) vs senior (ticket channel overwrites); ManageGuild for mutations |
| **staffNotes** | `/note` private staff notes (`requireStaff`) |
| **warnings** | `/warn` issue/void/list; `/warn mine` public; `/setwarn` staff gate |
| **userinfo** | Staff member card; note/warn buttons; Activity tab needs **senior** staff |
| **userActivity** | Live per-channel counts; `/activityconfig` ignore/status/backfill (staff); feeds `/userinfo` Activity |
| **tickets** | Support channels, sensitive mode, panel button→modal, HTML archive HTTP; senior roles get auto ticket view |

---

## Commands

Slash builders and handlers are **co-located** on features. The registry exports **26** slash commands (unique names; see `test/registry.test.js`). Registration:

```bash
npm run register   # node src/commands/register.js
```

- `DEV_GUILD_ID` set → that guild only (instant)
- else → every guild the bot is in

Router: `commands/router.js` → autocomplete / modal submit / button / chat input → channel restriction (chat) → handler.

### Access gates (`core/permissions.js`)

| Gate | Meaning |
|------|---------|
| **Public** | No staff check: `/xp`, `/leaderboard`, `/warn mine`, `/ticket create` (and panel open), `/play`, `/music`. `/eventreminder` opt-out/status (and create for event creators). |
| **Staff** (`requireStaff` / `isStaff`) | ManageGuild **or** any `staff_roles` role — notes, warnings, tickets (incl. panel/set*), activity config, honeypot channel/banrole, XP/YouTube/Twitch/decay/logs/reaction-roles, `/userinfo` (except Activity), most config |
| **Senior staff** (`requireSeniorStaff` / `isSeniorStaff`) | ManageGuild **or** a **senior** `staff_roles` role — `/userinfo` Activity; senior roles also receive automatic ticket channel overwrites (junior = command gate only, no auto ticket view) |
| **ManageGuild-only** (`requireAdmin` / `isAdminOrMod`) | **`/grantxp`**; staff-role add/remove/setlevel; **`/staff syncpermissions`**; **`/setcommandchannel`**; **`/honeypot exempt`** (staff-role alias) |

`/setcommandchannel` is ManageGuild-only and always allowed for admins even when command channels are restricted (lockout escape). `/ticket` inside an open (or soft-closed, not archived) ticket channel bypasses the command-channel allow-list.

**Slash picker visibility** (`src/core/commandVisibility.js` + `src/features/commandPermissions/`): staff-tier commands register with ManageGuild `defaultMemberPermissions`. Optional OAuth (`/staff syncpermissions`, scope `applications.commands.permissions.update`) writes Discord role allow overwrites for `staff_roles` so staff without Manage Server see those commands. Public and admin-tier commands are not overwritten. Handlers remain authoritative.

---

## Error & safety strategy

- Cooldown violations: silent skip
- Permission denied: ephemeral reply
- Interaction errors: `safeErrorReply` (ephemeral)
- XP: clamp deltas/totals to JS-safe range; award events capped at `MAX_XP_AWARD` (1e9)
- SQL: prepared statements only

---

## Testing

```bash
npm test                 # unit + integration (node --test)
npm run test:unit        # test/*.test.js
npm run test:integration # test/integration/*.test.js
```

Unit coverage includes `core/xpMath`, cooldowns, db layer (temp DB), event reminder helpers, tickets helpers, and command registry (**22** commands, **17** features). Integration tests exercise pipelines and feature flows offline with real SQLite and mocked Discord I/O.

---

## Operator notes

- Env: `DISCORD_TOKEN`, `CLIENT_ID`; optional `DEV_GUILD_ID`, `DATA_DIR`, `DB_PATH`
- YouTube (optional): `YOUTUBE_API_KEY` — see [youtube-notifications.md](./youtube-notifications.md)
- Twitch (optional): `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` — see [twitch-notifications.md](./twitch-notifications.md)
- Tickets (optional): `TICKET_HTTP_PORT`, `TICKET_PUBLIC_BASE_URL`, `TICKET_MAX_ASSET_BYTES`, `TICKET_MAX_ASSETS`; AI close summaries: `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` — see [tickets.md](./tickets.md)
- Docker: `DATA_DIR=/data` volume; persist WAL siblings
- Fonts for PNG: Noto / DejaVu (image includes them)
- Bot role must sit above managed roles

---

## Compat shims

Root files that re-export features (for older requires / external scripts):

| Shim | Target |
|------|--------|
| `db.js` | `db/index.js` |
| `xp.js` | `core/xpMath` (`levelFromXp`) |
| `roles.js` | `features/levelRoles/sync` |
| `auditLog.js` | `features/logs/auditLog` |
| `decay.js` | `features/decay` |
| `voiceTicker.js` | `features/voice` |
| `youtubeTicker.js` | `features/youtube/ticker` |
| `reactionRoles.js` | `features/reactionRoles/service` |
| `renderLeaderboard.js` | `render/leaderboard` |
| `renderHoneypotWarning.js` | `features/honeypot/renderWarning` |
| `register-commands.js` | `commands/register` |

Prefer importing feature/canonical paths in new code.
