# Architecture Overview

Technical deep dive into Boiler Snake for developers and contributors.

## Overview

Boiler Snake is a [Discord.js](https://discord.js.org/) v14 bot with a SQLite backend. The codebase is a **modular monolith**: product areas live under `src/features/`, shared infrastructure under `src/core/`, `src/db/`, and `src/services/`, with a thin entrypoint.

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
│   ├── permissions.js
│   └── interaction.js
├── services/
│   └── awardXp.js           # Unified XP → activity → roles → audit
├── features/
│   ├── load.js              # applyFeaturesToRegistry / start / registerEvents
│   ├── index.js             # Ordered feature list
│   ├── settings/            # /settings
│   ├── commandChannels/     # /setcommandchannel
│   ├── xp/                  # /xp /leaderboard /setxp + award helpers
│   ├── decay/               # /setdecay + daily cron
│   ├── voice/               # Voice XP ticker
│   ├── levelRoles/          # /leveltorole + syncMemberRoles
│   ├── logs/                # /setlog + auditLog + delete/ban/kick
│   ├── youtube/             # YouTube commands + RSS/API ticker
│   ├── honeypot/            # /honeypot + ban/warn pipeline
│   └── reactionRoles/       # /reactionrole + panel service
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
| **MessageCreate** | cache → pending RR emoji → honeypot → message XP |
| **MessageReactionAdd** | partials → honeypot warning strip → RR panels → reaction XP |
| **MessageReactionRemove** | reaction-role remove |

Independent events (message delete, ban, kick, honeypot ban-role, tickers) register via each feature’s `registerEvents` / `start`.

---

## Database Layer (`db/`)

- **connection.js** — SQLite open (`DB_PATH` / `DATA_DIR`), WAL
- **migrate.js** + **migrations/** — idempotent ordered steps
- **repositories/** — users, guildSettings, activity, youtube, honeypot, reactionRoles, …
- **index.js** — public facade (same API as legacy single-file `db.js`)

Migrations on load:

| Id | Purpose |
|----|---------|
| `001_base_schema` | CREATE TABLE IF NOT EXISTS |
| `002_guild_settings_columns` | reaction XP, log channels, upload role |
| `003_youtube_composite_pk` | rebuild youtube_channels only if PK is legacy |
| `004_youtube_and_honeypot_columns` | last_checked, warning_message_id |
| `005_clamp_bad_xp` | sanitize bad XP rows |

### Core XP API

| Function | Purpose |
|----------|---------|
| `addXp` | Atomic XP add with clamps |
| `getXp` / `setXp` | Read / write XP |
| `topUsers` | Leaderboard rows |
| `getGuildSettings` / `updateGuildSettings` | Per-guild config |

---

## Shared XP award (`services/awardXp.js`)

Used by message XP, reaction XP, and voice ticker:

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
| **honeypot** | Channel posts / ban-roles; warning PNG; exempt roles |
| **reactionRoles** | Bot panels, min level, removable options |

---

## Commands

Slash builders and handlers are **co-located** on features. Registration:

```bash
npm run register   # node src/commands/register.js
```

- `DEV_GUILD_ID` set → that guild only (instant)
- else → every guild the bot is in

Router: `commands/router.js` → channel restriction → `registry.getHandler(name)`.

Public: `/xp`, `/leaderboard`. Admin (ManageGuild): everything else. `/setcommandchannel` always allowed for admins (lockout escape).

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
npm test   # node --test
```

Unit coverage includes `core/xpMath`, cooldowns, db layer (temp DB), and command registry (13 commands, feature list).

---

## Operator notes

- Env: `DISCORD_TOKEN`, `CLIENT_ID`; optional `DEV_GUILD_ID`, `DATA_DIR`, `DB_PATH`
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
