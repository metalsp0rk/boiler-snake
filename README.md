# Boiler Snake

**Multi-platform Discord + Fluxer community bot**: XP & levels, moderation suite, notifications, AI Q&A ("gork"), cross-platform message bridges, account linking, and a staff web console — all per-community configurable on a single SQLite file.

**Documentation site:** [metalsp0rk.github.io/boiler-snake](https://metalsp0rk.github.io/boiler-snake/) (built from `docs/` with VitePress). Start with the [setup guide](docs/setup.md), the [configuration guide](docs/configuration.md), and the [commands reference](docs/commands/).

## Features

**XP & gamification**
- **Multi-source XP** — messages, reactions, and voice minutes (per-minute ticker; ignores muted/deafened and alone-in-channel), all rates per community
- **Levels → roles** automation with drop-below grace days; paginated **PNG leaderboards**
- **Daily XP decay** for inactivity (`/setdecay`, schedule via `DECAY_CRON`)
- **Reaction roles** — self-serve emoji panels with level gates

**Moderation & staff suite**
- **Help tickets** — button→modal panels, private channels, sensitive mode, HTML transcripts
- **Warnings** (formal, voidable, member-visible `/warn mine`) and **private staff notes**
- **Staff userinfo card** + senior-staff user-activity rankings
- **Staff roles** (junior/senior gate), command-channel allow-lists, **honeypot** decoy channels
- **Audit + message logs**, data **retention sweeps**

**Events & notifications**
- **Community events** — bot-owned `/event` with button RSVP, waitlists, reminders, recurring series
- **Scheduled event reminders** for Discord events; **YouTube**, **Twitch** (EventSub + polling fallback), and **GitHub release** notifications
- **Music player** — `/play` in voice via Lavalink (Spotify is catalog-only)

**AI: gork**
- Mention the bot in Discord (select its name), or type `@gork <question>` — grounded LLM answers per community with tool use: **web search**, **`read_page`** (SSRF-guarded), **`read_discord`**, vision (downscaled image understanding), cross-chat **memory**, per-scope budgets

**Multi-platform (Fluxer)**
- Runs against Discord, Fluxer instances, or **both at once** (`FLUXER_INSTANCES`)
- **Channel bridges** — Discord↔Fluxer relay with webhook copies, edit/delete relay, SSRF-guarded media
- **Account linking** (`/link` / `!link`) — mirror XP and gork memories between a member's Discord and Fluxer identities
- **Web admin console** — staff-gated dashboard (health/tickers, settings, events calendar, ticket transcripts), dark unless `PUBLIC_HTTP_PORT` is set

## Architecture

Modular monolith: feature modules under `src/features/`, shared `src/core/` + `src/db/`, thin `src/index.js`; named jobs on a shared scheduler; ordered Discord/Fluxer message pipelines. See [docs/architecture.md](docs/architecture.md) and [AGENTS.md](AGENTS.md).

Slash commands live on Discord; the same command tree is exposed on Fluxer as `<prefix>link`, `<prefix>bridge`, … (default prefix `!`). Handlers are the security source of truth; `src/core/commandVisibility.js` pins picker visibility per command.

## Setup

Requirements: **Node.js 22.22.2+** (discord.js 14; gork `read_page` uses jsdom 30 which needs ≥22.22.2)

Boot gate: the bot needs **at least one platform credential** — `DISCORD_TOKEN` **or** `FLUXER_INSTANCES`. `CLIENT_ID` is optional for login but required for command registration, command-permission OAuth (`/staff syncpermissions`), and web-admin Discord sign-in. The full, commented variable list lives in [`.env.example`](.env.example) (kept in lockstep with the code by a parity test).

### Option A: Node (local)

```bash
npm install
cp .env.example .env   # edit: DISCORD_TOKEN (+ CLIENT_ID recommended)
npm run register       # slash commands (set DEV_GUILD_ID in .env for instant dev registration)
npm start
```

- **Production (multi-guild):** `npm run register` PUTs commands to **every guild the bot is in** (per-guild only — there is no global-registration path). Re-run it after the bot joins new guilds.
- **Development:** set `DEV_GUILD_ID` in `.env` for instant single-guild registration.

### Option B: Docker Compose

```bash
cp .env.example .env   # set DISCORD_TOKEN, CLIENT_ID, and LAVALINK_PASSWORD
docker compose up -d --build
docker compose run --rm bot node src/commands/register.js
```

> **LAVALINK_PASSWORD is required** under Compose (#455): the shipped file always
> runs a Lavalink sidecar, and both containers must share a password. It no longer
> defaults to the public `youshallnotpass` — Compose aborts with a specific message
> when it is unset (the #205 boot fail-fast, previously unreachable under Compose).

Or pull a published image (after a release):

```bash
docker compose pull && docker compose up -d
```

Image: `ghcr.io/metalsp0rk/boiler-snake` (tags: `latest`, `vX.Y.Z`). SQLite persists on the `bot-data` volume under `/data` — persist the whole data dir (WAL files live beside the DB).

### Database path

By default the DB is `xpbot.sqlite` in the project root. Override with:

| Variable | Meaning |
|----------|---------|
| `DATA_DIR` | Directory for `xpbot.sqlite` (Docker sets `/data`) |
| `DB_PATH` | Full path to the database file (wins over `DATA_DIR`) |

Migrations under `src/db/migrations/` run automatically on boot.

## Required Discord Developer Portal settings

- Enable the **Message Content Intent** if you want `messageCreate` to fire reliably for all message events.
  - Without it, the bot may not receive message content and (depending on gateway/intents configuration) may not receive message events as expected.
- Create Bot & Token from Discord Developer Portal. Bot must have the following permissions:
![Bot Permissions](https://github.com/metalsp0rk/boiler-snake/blob/main/bot_settings.png "Bot Permissions")

## Commands

User-facing: `/xp`, `/leaderboard`, `/warn mine`, `/ticket create|…`, `/event …`, `/eventreminder …`, `/play`, `/music …`, `/link …` (public); everything else sits behind the staff gate (Manage Guild **or** a configured `staff_roles` level) or admin-only. Fluxer mirrors the same tree under the configured command prefix. The complete, always-current reference is [docs/commands/](https://metalsp0rk.github.io/boiler-snake/commands/).

## Database Backup

The bot stores all data in `xpbot.sqlite` (or under `DATA_DIR` / `DB_PATH`). Regular backups are recommended:
```bash
# Manual backup (local)
cp xpbot.sqlite xpbot.sqlite.backup

# Docker volume backup example
docker compose stop bot
docker run --rm -v boiler-snake_bot-data:/data -v "$(pwd)":/backup alpine \
  cp /data/xpbot.sqlite /backup/xpbot-$(date +%Y%m%d).sqlite
docker compose start bot

# Automated daily backup (cron, local path)
0 0 * * * cp /path/to/xpbot.sqlite /backups/xpbot-$(date +\%Y\%m\%d).sqlite
```

To restore from backup:
```bash
# Stop the bot first
cp xpbot.sqlite.backup xpbot.sqlite
# Restart the bot
```

## Tests

```bash
npm test              # unit + integration (offline: mocked Discord/Fluxer I/O, real SQLite)
npm run test:unit     # unit only
npm run test:integration
npm run test:coverage # the CI coverage gate (88/76/87 over src/)
npm run test:e2e      # tier-4 E2E vs the fauxcord mock Discord (see docs/e2e.md)
```

## Releases

Versions follow [SemVer](https://semver.org/) via [release-please](https://github.com/googleapis/release-please) and [Conventional Commits](https://www.conventionalcommits.org/):

| Commit prefix | Release bump |
|---------------|--------------|
| `feat:` | minor |
| `fix:` | patch |
| `feat!:` / `BREAKING CHANGE:` | major |
| `chore:`, `docs:`, `ci:` | no version bump (by default) |

Merging to `main` opens/updates a Release PR. Merging that PR tags `vX.Y.Z`, publishes a GitHub Release, and triggers a multi-arch (`linux/amd64`, `linux/arm64`) image push to GHCR.

## Notes

- Bot must have **Manage Roles** permission and its highest role must be **above** roles it manages.
- Reaction-role panels also need **Add Reactions**; **Manage Messages** is recommended so the bot can strip unconfigured reactions.
- Voice XP is awarded once per minute for **eligible** users:
  - not muted/deafened (self or server)
  - and in a voice channel with **at least 2 eligible human users**
- SQLite DB file is created automatically (project root, or `DATA_DIR` / `DB_PATH`).
- Ensure you have a font installed that handles symbols and emoji. (sudo apt install fonts-noto-core fonts-noto fonts-dejavu-core fonts-noto-color-emoji). The Docker image includes these fonts.
- Roles for auto-granting must be BELOW the bot's role in the discord server's role settings (Drag bot's role above the desired roles to grant)

Disclaimer: GPT 5.2 was used for debugging and assisting with creation of the leaderboard extents. Bot logo was AI generated.
