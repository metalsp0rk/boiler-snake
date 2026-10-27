# Boiler Snake AGENTS.md

## Quick Start

```bash
cp .env.example .env && npm install && npm start
```

Docker:
```bash
cp .env.example .env   # set DISCORD_TOKEN (+ CLIENT_ID for the register step below)
docker compose up -d --build
docker compose run --rm bot node src/commands/register.js
```

## Critical Setup Notes

- **Database**: SQLite (`xpbot.sqlite`). Default: project root. Override with `DATA_DIR` (dir) or `DB_PATH` (full file path). Docker compose uses `DATA_DIR=/data` + named volume.
- **Lavalink under compose**: `LAVALINK_PASSWORD` is **required in `.env`** (#455) — compose always runs the sidecar and aborts when the variable is unset (no more `youshallnotpass` defaults; this is what makes the #205 boot fail-fast reachable).
- **Environment**: `.env` is gitignored (never commit it). Boot gate (`assertRuntimeEnv`): at least one platform credential — `DISCORD_TOKEN` **or** `FLUXER_INSTANCES` (a malformed Fluxer block throws even when a token is set). `CLIENT_ID` is optional for login but boot `[config] WARN`s without it and registration/OAuth/web-sign-in stay dark; `npm run register` itself requires **both** `DISCORD_TOKEN` and `CLIENT_ID`. Optional: `DEV_GUILD_ID` for instant command registration.
- **Never commit secrets**: Do not put real or realistic-looking API keys, tokens, passwords, or credentials in the repo — including docs, examples, tests, comments, or commit messages. Use clearly fake placeholders (e.g. `YOUR_YOUTUBE_API_KEY`, `YOUR_BOT_TOKEN`). Real secrets belong only in `.env` (gitignored) or a secret manager. Patterns like Google `AIza…` keys trigger GitHub secret scanning even in documentation.
- **Discord Intents**: Enable "Message Content Intent" in Developer Portal for reliable message tracking.
- **Releases**: Conventional Commits + release-please on `main` → GitHub Release + GHCR image (`ghcr.io/metalsp0rk/boiler-snake`). The release-please PR stays open and gets force-updated after each merge; **merge it to cut the release** (it creates the tag + GitHub Release). PR titles become changelog entries, so keep them descriptive.
- **PR workflow**: Always create a feature branch from `main`, push it, and open a PR with `gh pr create`. **Never push directly to `main`**. Merge with **rebase merge only** (`gh pr merge --rebase --delete-branch`). Do **not** use merge commits (`--merge`) or squash unless the user explicitly asks. Prefer linear history on `main`.
- **Docs obligation (#471)**: any user/admin-facing change — slash commands/options/tiers, reply copy, guild settings/env vars, web routes, or shipped behavior — ships its docs update in the **same PR** (see **Documentation obligations** below). A merged-but-undocumented change stays an open issue; the feature is not "Shipped" until docs land (same bar as live verification).
- **Subagents**: Use subagents **frequently** for large jobs to keep the main session's context manageable (exploration, research, review, parallel work units). The limit is on **concurrency**: never run more than **2 subagents simultaneously**. For larger workloads, process in sequential batches of ≤2 — launch the next batch only when the current one finishes.
- **Rebasing PRs**: When a PR conflicts, rebase the **branch** (`git checkout <branch> && git rebase main`), resolve, force-push with `--force-with-lease`, then rebase-merge. After rebasing, run the **full** `npm test` — conflicts can silently drop declarations (e.g. a const used by code from both sides).
- **Command visibility**: Every registered slash command needs a tier in `src/core/commandVisibility.js`; `test/command-visibility.test.js` fails the suite if a command is missing or mis-tiered. Add the tier in the same commit as the command.
- **Roadmap & tracking — everything lives in GitHub** (since 2026-10-09): Open features, bugs, triage, and live-verification work are **GitHub issues**, ordered via **milestones** (`P0/P1/P2 — audit`, `P3 — post-audit findings`, `Gork next`, `Fluxer/Bridge live verification`, `Community Events v1`, `Auto-moderation v1`, `Feature backlog`), rolled up in **GitHub Projects** boards where useful, and filtered by area labels (`gork`, `fluxer`, `bridge`, `community-events`, `tickets`, `twitch`, `staff-roles`, `automod`, `core-infra`, `documentation`, plus `triage`, `audit-finding`). Do **not** track work in local files, TODO lists, or the README — open an issue and put it on a milestone. `roadmap/` is the **design archive** — locked decisions/schemas stay authoritative there, but **do not add tracking items to roadmap files; open an issue** and design-change via PR. No feature is "Shipped" without a dated live-verification record (merged-but-unverified stays an open issue).

## Key Commands

| Command | Description |
|---------|-------------|
| `npm start` | Run bot (`src/index.js`) |
| `npm run register` | Register slash commands (`src/commands/register.js`) |
| `npm test` | Unit + integration tests (`node --test`) |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Offline full-stack integration tests (mocked Discord I/O, real SQLite) |
| `npm run test:e2e` | Tier-4 E2E vs fauxcord mock Discord (`scripts/e2e/start-mock.sh` first; see docs/e2e.md) |
| `npm run test:coverage` | Coverage gate (CI-enforced on the Node 22 leg): 88 lines / 76 branches / 87 funcs over `src/` |
| `npm run ensure-role` | One-off: bulk-grant a role to every guild member (needs Server Members intent) |
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
| `src/web/` | Web admin console HTTP surface (Express 5: routes, views, auth) — started by the `web` feature |
| `src/render/leaderboard.js` | Leaderboard PNG |

**Features:** settings, commandChannels, commandPermissions, xp, decay, voice, music, levelRoles, logs, youtube, twitch, githubReleases, honeypot, reactionRoles, eventReminders, events, staffRoles, staffNotes, warnings, userinfo, userActivity, retention, gork, tickets, web, bridge, linking.

See [docs/architecture.md](docs/architecture.md) for the full layout and boot sequence.

## Error Handling

Every unit of functionality must be wrapped so a failure produces a **logged, specific error** — never a silent drop and never a dead-end "something failed".

1. **Wrap all entry points**: command/autocomplete/modal/button handlers, pipeline steps, tickers, and boot hooks. The router (`src/commands/router.js`) and pipelines (`src/bot/pipelines.js`) wrap at their boundaries; any *detached* async work (fire-and-forget promises, `setInterval` callbacks) must attach its own `.catch()` / try/catch so one failure can't kill the loop or login.
2. **Log with context**: `console.error("[feature] what failed:", err?.message || err)` plus identifying ids (guild, user, command, customId) — enough to reproduce from logs alone.
3. **User-facing replies carry the cause**: embed the specific error (`` `Could not post panel: ${err?.message || err}` ``) or translate it (see `formatChannelCreateError` in `src/features/tickets/overwrites.js`). Never reply "check logs", `"unknown error"`, or bare `"(database error)"` — if the user can't act on it, it's not an error message.
4. **Sanctioned generics are the exception, not the tool**: `MSG_GENERIC_ERROR` via `safeErrorReply` is the router's last-resort fallback only (handler threw before being specific), and the public HTTP server's generic 500 `Internal error` (under `src/web/`, e.g. `src/web/middleware/requireTier.js`) intentionally never leaks internals to unauthenticated callers. Features must not invent their own generic replies.
5. **Partial failures report partial results**: multi-step operations (bulk role sync, ticket close, batch deletes) accumulate per-item failures and surface them (see the "warnings" pattern in `src/features/tickets/close.js`) instead of aborting silently or claiming total success.
6. **Return `{ ok:false, error }` from services** — services never reply to Discord themselves and never throw uncaught; handlers decide how to surface the error.

## Intentions & Constraints

1. **Cooldowns**: message (default 20s), reaction (default 10s) — configurable per guild, clamped to 24h (#429: the award-dedupe sweep horizon is defined past this max — never below a configurable window)
2. **Voice XP**: ignore AFK; ≥2 eligible humans; no XP if muted/deafened
3. **Command channels**: empty allow-list → everywhere; `/setcommandchannel` always for admins
4. **Admin gate**: public-tier commands (`commandVisibility.js`): `/xp`, `/leaderboard`, `/warn` (incl. `mine`), `/ticket` (incl. `create`), `/event`, `/eventsignup`, `/eventconfig`, `/eventchannels`, `/eventreminder`, `/play`, `/music`, `/link` — mixed staff subcommands stay gated **in handlers**; staff/config commands use `requireStaff` (ManageGuild **or** any `staff_roles` level); `/staffsettings` is the staff-tier read twin of `/staff role list` + `/staff settings` (#599). **ManageGuild-only:** `/grantxp`, staff-role mutations (`/staff role add|remove|setlevel`), `/setcommandchannel`, `/honeypot exempt`, `/honeypot safety resume`, and `/staff syncpermissions`. **Slash picker visibility:** staff-tier commands use ManageGuild `defaultMemberPermissions`; after admin OAuth via `/staff syncpermissions`, Discord overwrites allow each `staff_roles` role to see those commands (requires `CLIENT_SECRET` + public HTTP). Handlers remain the security source of truth. **Ticket channel overwrites** and **`/userinfo` Activity** use **senior** staff; junior = command gate without auto ticket view / without Activity
5. **Bot role** must be above roles it manages
6. **XP caps**: max award 1e9 per event; DB/JS-safe totals
7. **Level→role drop**: grace days after falling below threshold
8. **Leaderboard**: paginated PNG via `@napi-rs/canvas`, 1–20 rows per page (default 10)

## Known Gotchas

- `npm run register` registers **per-guild only** (PUTs `applicationGuildCommands` for every guild the bot is in — there is no global-registration path); re-run it after the bot joins new guilds. `DEV_GUILD_ID` narrows registration to one guild for instant propagation while developing.
- Voice ticker aligns to minute boundaries
- Migrations under `src/db/migrations/` run automatically on db load
- Docker: persist the whole data dir (WAL files beside the DB)
- Feature boot hooks in `src/features/load.js` wrap each `registerEvents`/`start` call per feature and log `[features] <name>.<hook> failed:` — a broken feature degrades instead of killing login; keep hooks idempotent and don't remove the guards
- **Reply-copy convention (#471 H2-13)**: bold labels are `**Label:** value` (label inside the bold, colon inside). The `Label: **value**` style also exists in older copy — fix it opportunistically when touching a line; new copy uses the declared style only.
- **Destructive-action confirms (#471 H2-15)**: anything irreversible (destroying credentials/webhooks, unrecoverable row deletes) follows the gork `confirm:` idiom — run without `confirm` shows an ephemeral what-will-be-lost preview, `confirm: true` executes. Two-step flows (ticket close→archive) count as built-in confirmation.
- Use Conventional Commit prefixes (`feat:`, `fix:`, …) for release-please

## Documentation (VitePress)

Docs site builds from **`docs/` only** (`npm run docs:build` → GitHub Pages).

- **Never link from `docs/**/*.md` to repo paths outside `docs/`** with relative links (e.g. `../roadmap/index.md`, `../../package.json`). VitePress treats those as dead links and **fails the build**.
- For files outside `docs/` (the `roadmap/` folder, `LICENSE`, …), use absolute GitHub URLs, e.g.  
  `https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/warnings.md#section`  
  (same pattern as `docs/staff-notes.md` / `docs/warnings.md`).
- Prefer links to other pages under `docs/` (`tickets.md`, `architecture.md`, …).
- After adding or changing docs links, run **`npm run docs:build`** and fix any “Found dead link” errors before merge.

### Documentation obligations

Tied to the **Docs obligation** rule above — per surface, what "docs updated" means in a PR:

- **Commands**: any new/changed slash command, option, or tier (`src/commands/definitions.js`, `src/core/commandVisibility.js`) → update `docs/commands/index.md` **and** the owning feature page in the same PR. New `confirm:` options follow the H2-15 two-step copy.
- **Settings/env**: new guild setting or env var → owning feature page + `docs/configuration.md` (+ the per-guild settings table) + `.env.example`. `test/env-parity.test.js` pins env *names*; doc *meaning* is review-gated.
- **Copy**: user-facing reply changes → update every docs snippet quoting the old copy (grep the old string across `docs/`); new copy uses `**Label:** value` (#471 H2-13).
- **Web routes**: `src/web` route/tier/visibility changes → `docs/web-admin.md` (or the owning feature page). Dual-platform features state the Fluxer parity (or explicit no-parity) in the same pass.
- **New page**: add it to `docs/.vitepress/config.mjs` nav **and** sidebar (unlisted = unreachable), plus the `docs/index.md` TOC / `docs/README.md` index where it fits — then `npm run docs:build`.
- **Severity**: merged-but-undocumented stays an open issue (documentation label, `P3 — post-audit findings` or the feature's milestone). Don't mark a feature Shipped until its docs land — the 2026-10-20 docs audit found 17 such gaps on ship-with-docs-later features.
