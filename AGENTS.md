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
- **PR workflow**: Always create a feature branch from `main`, push it, and open a PR with `gh pr create`. **Never push directly to `main`**. Merge with **rebase merge only** (`gh pr merge --rebase --delete-branch`). Do **not** use merge commits (`--merge`) or squash unless the user explicitly asks. Prefer linear history on `main`.

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

**Features:** settings, commandChannels, xp, decay, voice, music, levelRoles, logs, youtube, honeypot, reactionRoles, eventReminders, staffRoles, staffNotes, warnings, userinfo, userActivity, tickets.

See [docs/architecture.md](docs/architecture.md) for the full layout and boot sequence.

## Error Handling

Every unit of functionality must be wrapped so a failure produces a **logged, specific error** — never a silent drop and never a dead-end "something failed".

1. **Wrap all entry points**: command/autocomplete/modal/button handlers, pipeline steps, tickers, and boot hooks. The router (`src/commands/router.js`) and pipelines (`src/bot/pipelines.js`) wrap at their boundaries; any *detached* async work (fire-and-forget promises, `setInterval` callbacks) must attach its own `.catch()` / try/catch so one failure can't kill the loop or login.
2. **Log with context**: `console.error("[feature] what failed:", err?.message || err)` plus identifying ids (guild, user, command, customId) — enough to reproduce from logs alone.
3. **User-facing replies carry the cause**: embed the specific error (`` `Could not post panel: ${err?.message || err}` ``) or translate it (see `formatChannelCreateError` in `src/features/tickets/overwrites.js`). Never reply "check logs", `"unknown error"`, or bare `"(database error)"` — if the user can't act on it, it's not an error message.
4. **Sanctioned generics are the exception, not the tool**: `MSG_GENERIC_ERROR` via `safeErrorReply` is the router's last-resort fallback only (handler threw before being specific), and the public HTTP server's generic 500 `Internal error` (`src/features/tickets/httpServer.js`) intentionally never leaks internals to unauthenticated callers. Features must not invent their own generic replies.
5. **Partial failures report partial results**: multi-step operations (bulk role sync, ticket close, batch deletes) accumulate per-item failures and surface them (see the "warnings" pattern in `src/features/tickets/close.js`) instead of aborting silently or claiming total success.
6. **Return `{ ok:false, error }` from services** — services never reply to Discord themselves and never throw uncaught; handlers decide how to surface the error.

## Intentions & Constraints

1. **Cooldowns**: message (default 20s), reaction (default 10s) — configurable per guild
2. **Voice XP**: ignore AFK; ≥2 eligible humans; no XP if muted/deafened
3. **Command channels**: empty allow-list → everywhere; `/setcommandchannel` always for admins
4. **Admin gate**: `/xp`, `/leaderboard`, `/warn mine`, `/ticket create`, `/play`, `/music` public; staff/config commands use `requireStaff` (ManageGuild **or** any `staff_roles` level). **ManageGuild-only:** `/grantxp`, staff-role mutations (`/staff role add|remove|setlevel`), `/setcommandchannel`, `/honeypot exempt`, and `/staff syncpermissions`. **Slash picker visibility:** staff-tier commands use ManageGuild `defaultMemberPermissions`; after admin OAuth via `/staff syncpermissions`, Discord overwrites allow each `staff_roles` role to see those commands (requires `CLIENT_SECRET` + public HTTP). Handlers remain the security source of truth. **Ticket channel overwrites** and **`/userinfo` Activity** use **senior** staff; junior = command gate without auto ticket view / without Activity
5. **Bot role** must be above roles it manages
6. **XP caps**: max award 1e9 per event; DB/JS-safe totals
7. **Level→role drop**: grace days after falling below threshold
8. **Leaderboard**: top 10 PNG via `@napi-rs/canvas`

## Known Gotchas

- Global slash commands can be slow to propagate (`DEV_GUILD_ID` for dev)
- Voice ticker aligns to minute boundaries
- Migrations under `src/db/migrations/` run automatically on db load
- Docker: persist the whole data dir (WAL files beside the DB)
- Feature boot hooks in `src/features/load.js` wrap each `registerEvents`/`start` call per feature and log `[feature] <name>.<hook> failed` — a broken feature degrades instead of killing login; keep hooks idempotent and don't remove the guards
- Use Conventional Commit prefixes (`feat:`, `fix:`, …) for release-please

## Documentation (VitePress)

Docs site builds from **`docs/` only** (`npm run docs:build` → GitHub Pages).

- **Never link from `docs/**/*.md` to repo paths outside `docs/`** with relative links (e.g. `../roadmap/index.md`, `../../package.json`). VitePress treats those as dead links and **fails the build**.
- For files outside `docs/` (the `roadmap/` folder, `LICENSE`, …), use absolute GitHub URLs, e.g.  
  `https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/warnings.md#section`  
  (same pattern as `docs/staff-notes.md` / `docs/warnings.md`).
- Prefer links to other pages under `docs/` (`tickets.md`, `architecture.md`, …).
- After adding or changing docs links, run **`npm run docs:build`** and fix any “Found dead link” errors before merge.
