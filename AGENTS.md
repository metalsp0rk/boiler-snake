# HeisenXP-Bot AGENTS.md

## Quick Start

```bash
cp .env.example .env && npm install && npm start
```

Docker:
```bash
cp .env.example .env   # set DISCORD_TOKEN, CLIENT_ID
docker compose up -d --build
docker compose run --rm bot node src/register-commands.js
```

## Critical Setup Notes

- **Database**: SQLite (`xpbot.sqlite`). Default: project root. Override with `DATA_DIR` (dir) or `DB_PATH` (full file path). Docker compose uses `DATA_DIR=/data` + named volume.
- **Environment**: `.env` is ignored. Required values: `DISCORD_TOKEN`, `CLIENT_ID`. Optional: `DEV_GUILD_ID` for instant command registration.
- **Discord Intents**: Enable "Message Content Intent" in Developer Portal for reliable message tracking.
- **Releases**: Conventional Commits + release-please on `main` → GitHub Release + GHCR image (`ghcr.io/metalsp0rk/heisenxp-bot`).

## Key Commands

| Command | Description |
|---------|-------------|
| `npm start` | Run bot (entrypoint: `src/index.js`) |
| `npm run register` | Register slash commands (global or DEV_GUILD_ID) |
| `docker compose up -d` | Run bot in container (volume for SQLite) |

## Architecture Highlights

- **Entry**: `src/index.js` — Discord client setup, event handlers, command router
- **Database**: `src/db.js` — SQLite wrapper with WAL mode and migrations
- **XP Logic**: `src/xp.js`—Level = floor(sqrt(xp / factor))
- **Voice XP**: `src/voiceTicker.js` — Per-minute ticker; requires ≥2 eligible humans per channel (non-muted/deafened)
- **Roles**: `src/roles.js` — Auto-grant on level-up; auto-revoke after grace period
- **Decay**: `src/decay.js` — Daily cron at 4 AM server time; reduces XP for inactive users

## Intentions & Constraints

1. **CoDOWNS**:
   - Message: configurable (default 20s)
   - Reaction: configurable (default 10s)

2. **Voice XP Rules**:
   - Ignores AFK channel
   - Requires at least 2 eligible humans in voice channel
   - Not awarded if muted/deafened

3. **Command Restriction**:
   - Per-guild config via `/setcommandchannel`
   - If empty list: commands allowed everywhere
   - Exception: `/setcommandchannel` always accessible for admins (prevents lockout)

4. **Admin Gate**: `/xp`, `/leaderboard` are public; all others require `ManageGuild` permission

5. **Bot Permissions Must**:
   - Have `Manage Roles`
   - Position its own role ABOVE roles it manages in Discord guild settings

6. **XP Safety Caps**:
   - Max XP awarded per event: 1,000,000,000 (clamped)
   - DB stores capped values to prevent Infinity/overflow
   - JS-safe cap: `Number.MAX_SAFE_INTEGER`

7. **Level→Role Drop Logic**: User keeps role for configured grace days after dropping below level threshold

8. **Leaderboard**: Top 10 only; renders PNG with `@napi-rs/canvas`

## Known Gotchas

- Global slash commands can take time to propagate (DEV_GUILD_ID preferred for dev)
- Voice xp ticker runs on minute boundaries; initial delay calculated from current time
- If DB schema changes, migrations in `db.js` run automatically on startup
- For emoji rendering: ensure fonts installed (`fonts-noto-core`, `fonts-dejavu-core`, `fonts-noto-color-emoji`); Docker image includes them
- Persist the whole data directory in Docker (WAL creates `xpbot.sqlite-wal` / `-shm` beside the DB)
- Use Conventional Commit prefixes (`feat:`, `fix:`, …) so release-please can cut versions
