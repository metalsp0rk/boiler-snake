# Boiler Snake AGENTS.md

## Quick Start

```bash
cp .env.example .env && npm install && npm start
```

Docker:
```bash
cp .env.example .env   # set DISCORD_TOKEN, CLIENT_ID
docker compose up -d --build
docker compose run --rm bot node src/commands/register.js
```

## Critical Setup Notes

- **Database**: SQLite (`xpbot.sqlite`). Default: project root. Override with `DATA_DIR` (dir) or `DB_PATH` (full file path). Docker compose uses `DATA_DIR=/data` + named volume.
- **Environment**: `.env` is ignored. Required: `DISCORD_TOKEN`, `CLIENT_ID`. Optional: `DEV_GUILD_ID` for instant command registration.
- **Never commit secrets**: Do not put real or realistic-looking API keys, tokens, passwords, or credentials in the repo — including docs, examples, tests, comments, or commit messages. Use clearly fake placeholders (e.g. `YOUR_YOUTUBE_API_KEY`, `YOUR_BOT_TOKEN`). Real secrets belong only in `.env` (gitignored) or a secret manager. Patterns like Google `AIza…` keys trigger GitHub secret scanning even in documentation.
- **Discord Intents**: Enable "Message Content Intent" in Developer Portal for reliable message tracking.
- **Releases**: Conventional Commits + release-please on `main` → GitHub Release + GHCR image (`ghcr.io/metalsp0rk/boiler-snake`).

## Key Commands

| Command | Description |
|---------|-------------|
| `npm start` | Run bot (`src/index.js`) |
| `npm run register` | Register slash commands (`src/commands/register.js`) |
| `npm test` | Unit + integration tests (`node --test`) |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Offline full-stack integration tests (mocked Discord I/O, real SQLite) |
| `docker compose up -d` | Run bot in container (volume for SQLite) |

## Architecture Highlights

| Path | Role |
|------|------|
| `src/index.js` | Thin entry: client, feature boot, ordered pipelines, login |
| `src/features/*` | Product modules (commands, handlers, events/start) |
| `src/commands/` | Registry, router, registration CLI |
| `src/core/` | XP math, cooldowns, permissions, interaction helpers |
| `src/services/awardXp.js` | Unified XP award + role sync + audit |
| `src/db/` | Connection, migrations, repositories (`src/db.js` facade) |
| `src/bot/pipelines.js` | Ordered MessageCreate / ReactionAdd pipelines |
| `src/render/leaderboard.js` | Leaderboard PNG |

**Features:** settings, commandChannels, xp, decay, voice, levelRoles, logs, youtube, honeypot, reactionRoles, eventReminders, staffRoles, staffNotes, warnings, userinfo, tickets.

See [docs/architecture.md](docs/architecture.md) for the full layout and boot sequence.

## Intentions & Constraints

1. **Cooldowns**: message (default 20s), reaction (default 10s) — configurable per guild
2. **Voice XP**: ignore AFK; ≥2 eligible humans; no XP if muted/deafened
3. **Command channels**: empty allow-list → everywhere; `/setcommandchannel` always for admins
4. **Admin gate**: `/xp`, `/leaderboard`, `/warn mine`, `/ticket create` public; staff/config commands use `requireStaff` (ManageGuild **or** `staff_roles`); `/setwarn`, ticket `set*`, and staff-role edits are ManageGuild-only
5. **Bot role** must be above roles it manages
6. **XP caps**: max award 1e9 per event; DB/JS-safe totals
7. **Level→role drop**: grace days after falling below threshold
8. **Leaderboard**: top 10 PNG via `@napi-rs/canvas`

## Known Gotchas

- Global slash commands can be slow to propagate (`DEV_GUILD_ID` for dev)
- Voice ticker aligns to minute boundaries
- Migrations under `src/db/migrations/` run automatically on db load
- Docker: persist the whole data dir (WAL files beside the DB)
- Use Conventional Commit prefixes (`feat:`, `fix:`, …) for release-please

## Documentation (VitePress)

Docs site builds from **`docs/` only** (`npm run docs:build` → GitHub Pages).

- **Never link from `docs/**/*.md` to repo paths outside `docs/`** with relative links (e.g. `../ROADMAP.md`, `../../package.json`). VitePress treats those as dead links and **fails the build**.
- For root files such as `ROADMAP.md` or `LICENSE`, use absolute GitHub URLs, e.g.  
  `https://github.com/metalsp0rk/boiler-snake/blob/main/ROADMAP.md#section`  
  (same pattern as `docs/staff-notes.md` / `docs/warnings.md`).
- Prefer links to other pages under `docs/` (`tickets.md`, `architecture.md`, …).
- After adding or changing docs links, run **`npm run docs:build`** and fix any “Found dead link” errors before merge.
