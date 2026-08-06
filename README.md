# Boiler Snake (discord.js v14)
# MIT LICENSE

Per-guild configurable XP/level bot that tracks:
- **Messages**
- **Reactions**
- **Voice minutes** (per-minute ticker; ignores muted/deafened users and alone-in-channel idling)

Includes:
- Per-guild settings stored in **SQLite** (zero-setup for self-hosting)
- Tunable **decay** (daily cron)
- **Level → Role** automation with **drop-below grace days**
- **Command restriction** to allowed channels per guild
- Admin/mod commands for configuration

## Architecture

Modular monolith: feature modules under `src/features/`, shared `src/core/` + `src/db/`, thin `src/index.js`.  
See [docs/architecture.md](docs/architecture.md) and [AGENTS.md](AGENTS.md).

**Documentation site:** [metalsp0rk.github.io/boiler-snake](https://metalsp0rk.github.io/boiler-snake/) (built from `docs/` with VitePress).

## Setup

Requirements: **Node.js 18+** (Discord.js 14; Node 13.x will not work)

### Option A: Node (local)

1) Install dependencies
```bash
npm install
```

2) Create `.env`
```bash
cp .env.example .env
# edit .env
```

3) Register slash commands
- **Production (multi-guild):** register global commands (default). Note: global command updates can take time to propagate.
- **Development (fast):** set `DEV_GUILD_ID` in `.env` to register instantly to one guild.

```bash
npm run register
```

4) Run bot
```bash
npm start
```

### Option B: Docker Compose

1) Create `.env` with `DISCORD_TOKEN` and `CLIENT_ID` (see `.env.example`).

2) Build and start (SQLite persists on the `bot-data` volume under `/data`):
```bash
docker compose up -d --build
```

Or pull a published image from GHCR (after a release):
```bash
docker compose pull
docker compose up -d
```

3) Register slash commands once:
```bash
docker compose run --rm bot node src/commands/register.js
```

Image: `ghcr.io/metalsp0rk/boiler-snake` (tags: `latest`, `vX.Y.Z`).

### Database path

By default the DB is `xpbot.sqlite` in the project root. Override with:

| Variable | Meaning |
|----------|---------|
| `DATA_DIR` | Directory for `xpbot.sqlite` (Docker sets `/data`) |
| `DB_PATH` | Full path to the database file (wins over `DATA_DIR`) |

## Required Discord Developer Portal settings

- Enable the **Message Content Intent** if you want `messageCreate` to fire reliably for all message events.
  - Without it, the bot may not receive message content and (depending on gateway/intents configuration) may not receive message events as expected.
- Create Bot & Token from Discord Developer Portal.  Bot must have the following permissions:
![Bot Permissions](https://github.com/metalsp0rk/boiler-snake/blob/main/bot_settings.png "Bot Permissions")

## Commands

User commands:
- `/xp [user]`
- `/leaderboard`

Admin/mod commands (requires **Manage Guild** by default):
- `/setxp message:<int> reaction:<int> voice:<int> msgcooldown:<int> reactioncooldown:<int>`
- `/setdecay enabled:<bool> messages:<int> days:<int> percent:<0-95>`
- `/leveltorole set role:<role> level:<int> dropdays:<int>`
- `/leveltorole remove role:<role>`
- `/leveltorole list`
- `/reactionrole panel create|edit|delete|list` — bot-owned self-serve role panels
- `/reactionrole option add|remove|list` — emoji → role (add: send emoji as next message)
- `/reactionrole sync` — repair panel embed + bot reactions
- `/setcommandchannel add channel:<channel>`
- `/setcommandchannel remove channel:<channel>`
- `/setcommandchannel list`
- `/settings` (shows current guild settings, role mappings, allowed channels)
- `/eventreminder create|edit|list|clear|sync|setchannel|optout|optin|mute|unmute|status` — scheduled event reminder pings
- `/staff role add|remove|list` · `/staff settings` — guild staff roles (admin gate; also honeypot exemption)
- `/note add|list|edit|delete|info|settings` — private staff notes about members
- `/warn add|list|info|void|count|mine|settings` — formal permanent warnings
- `/setwarn dm` — toggle member DMs on warn issue/void
- `/setwarn log` — dedicated channel for warning issue/void embeds (falls back to audit log)
- `/userinfo user:<member>` — staff card (XP + note/warning counts + Activity + drill-down buttons)
- `/activityconfig ignore|backfill|status` — user-activity ignore list and history backfill (Manage Server)
- `/ticket create|for|close|archive|claim|…` — help tickets; `/ticket panel` posts Open-ticket button → modal

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
