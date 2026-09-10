# Wishlist — Review Backlog

> **Source**: three-agent review, 2026-09-09 (docs / tests / roadmap+wishlist). All items are
> concrete, file-cited findings — work them as time allows, in any order. Check off when done.
>
> **Convention**: this file is the backlog ledger. Where an item duplicates a feature file's
> open-items list (tickets, staff-roles, …), the feature file stays authoritative for *design*;
> tick both when the fix lands.

**Counts**: 8 high · 16 medium · 17 low (41 items) + 1 cross-cutting theme · 0 critical
(The 18 medium findings from the review = 16 kept + the architecture.md `/warn issue` mention merged into the §1 high item + the AGENTS.md feature-list finding deduped across reviews.)

---

## 1. Documentation (`docs/`, README, AGENTS.md)

### High

- [ ] **Add a real MIT `LICENSE` file at repo root** — `README.md:2`, `docs/index.md:113`, and `docs/FAQ.md:496` all claim MIT and link to `LICENSE`, which does not exist (404 links + legal gap; `package.json` already declares MIT).
- [x] **Fix phantom `/warn issue` → `/warn add`** — `docs/configuration.md:414` (command table) and `docs/architecture.md:187` (feature table). Real subcommands: `add|list|info|void|count|mine|export|settings` (`src/features/warnings/index.js`).

### Medium

- [x] **Regenerate `docs/database.md` migration table** (~lines 1002–1023): remove nonexistent `017_warn_post_mvp` and the duplicate 017/018 row; add `021_gork`, `022_gork_access`, `023_gork_memory`, `024_staff_roles_added_by`. Verify against `src/db/migrations/`.
- [x] **Add gork tables section to `docs/database.md`** — `gork_user_blocks` (022), `gork_memories` + `gork_memory_*` settings (023) are absent from the "Complete SQLite schema".
- [ ] **Fix `docs/architecture.md` migration table (130–147)** — jumps 015→020; add `016_command_permission_oauth`, `017_event_reminder_persistent`, `018_warn_post_mvp`, `019_ticket_panels`, `021`–`024`.
- [x] **Migration off-by-one: `017` → `018_warn_post_mvp`** — `docs/warnings.md:192` and `roadmap/index.md` §7 warnings rows (lines 75, 78). `017` is `event_reminder_persistent`.
- [ ] **Add `/gork` to `docs/commands/index.md`** — no section and no permission-matrix row despite Gork shipping; mirror the subcommand table from `docs/gork.md:113–123`.
- [ ] **Fix `docs/gork.md:186` values** — "2,000 tokens / 60s" contradicts code (`DEFAULT_LLM_MAX_TOKENS=6000`, `DEFAULT_LLM_TIMEOUT_MS=90000` in `src/features/gork/trigger.js:78–84`) *and the same file's lines 251/257*; update to 6,000 / 90s.
- [ ] **Dead TOC anchor in `docs/configuration.md:10`** — links `#advanced-configuration`; no such heading on the page. Drop or re-point.
- [ ] **AGENTS.md "Features:" line is stale** — missing `gork`, `twitch`, `commandPermissions` (lists 18; `src/features/` has 21). Also flagged by roadmap review — one fix clears both.
- [ ] **AGENTS.md Intentions #8**: "Leaderboard: top 10 PNG" → "paginated 1–20 per page (default 10)" (`src/render/leaderboard.js` `MAX_ROWS=20`; `docs/leaderboard.md:11` agrees).
- [ ] **Bump/remove version stamp in `docs/README.md:158`** — says 1.3.0; `package.json` is 1.11.0.

### Low

- [ ] **Refresh stale command lists in `README.md:99/113/115`** — `/setxp` missing `factor`; `/staff role …` missing `setlevel` and `/staff syncpermissions`; `/warn` missing `export`.
- [ ] **`docs.yml:29` node-version 20 → 22** — `package.json` engines is `>=22.22.2` (only EBADENGINE warnings today, but keep consistent).
- [ ] **`.env.example:11` comment** — `YOUTUBE_API_KEY` says "(for futureEnhancements)"; YouTube notifications shipped.
- [ ] **Duplicate `## Testing` H2 in `docs/architecture.md`** (lines 9 and 232) — ambiguous `#testing` anchor; rename the second (e.g. "Testing Strategy").
- [ ] **`docs/index.md:50`** — Setup guide advertised "with video"; `docs/setup.md` has none. Drop "video".
- [ ] **Enable `lastUpdated: true` in `docs/.vitepress/config.mjs`** (and/or front-matter dates) — no page carries an updated-stamp; this is why the drift above went unnoticed.

---

## 2. Tests (`test/`, helpers, npm scripts)

### High

- [x] **Fix temp-DB leak in the integration harness** — `test/helpers/env.js` / `createIntegrationEnv()` never close DBs or remove mkdtemp dirs. Current machine state: **~4,361 `/tmp/boiler-snake-it-*` dirs, ~1.8 GB**. Return `cleanup()` (close DB + `fs.rmSync(tmpDir, {recursive: true})`) from `loadDb()`/harness and call it in each file's `after()`; purge the existing dirs once.
- [ ] **Test the OAuth exchange + public callback** — `src/features/commandPermissions/oauthTokens.js` (177 LOC) and `httpCallback.js` (165 LOC) have zero direct tests (only the missing-`CLIENT_SECRET` gate via `integration/staff-roles-sync.test.js`). Unit-test the callback handler with faked req/res + mocked fetch: valid state, tampered/expired state, Discord 4xx surfaced as specific cause, missing config.

### Medium

- [ ] **Eliminate wall-clock sleeps** — `test/integration/user-activity.test.js:230` (fixed 2,500 ms wait) and the 9 "wait to confirm absence" sleeps in `test/integration/gork.test.js` (25–500 ms; e.g. line 406). Replace with observable seams (awaitable backfill-cancel / queue-drain) or the injectable-clock pattern already used in unit `test/gork.test.js`.
- [x] **De-duplicate DB bootstrap in 5 unit files** — `db-layer.test.js:15`, `gork-memory-repo.test.js:15`, `gork-memory-commands.test.js:85`, `registry.test.js:8`, `commandVisibility.test.js:8` hand-roll mkdtemp + `DB_PATH` + require-cache invalidation with fragile require-*order* guards against the root `xpbot.sqlite`; switch all to `helpers/env.loadDb()`.
- [ ] **Add coverage instrumentation** — no coverage tooling today, so test-coverage.md targets (critical 100% / high 90%+) are untracked. Add `npm run test:coverage` via `node --test --experimental-test-coverage` (or `c8`) with per-directory reporting + thresholds.

### Low

- [ ] **`src/core/permissions.js` truth-table unit test** — `requireStaff` tier logic (ManageGuild × junior × senior) only covered indirectly via ~50 scattered deny assertions; add boundary-exhaustive matrix for a security gate.
- [x] **Tighten `assertRoleRemoved` (`test/helpers/assert.js:67–72`)** — passes while a role is still cached whenever *any* removal was recorded; require `!cache.has(roleId)`.
- [x] **Rename camelCase unit files to kebab-case** — `staffNotes.test.js`, `xpMath.test.js`, `commandPermissionSync.test.js`, etc. violate the lowercase-with-dashes convention (`test/integration/` is already correct). Batch on next touch.
- [ ] **`test/README.md` helper table** — add `helpers/fixtures.js` and `helpers/lavalink.js`.
- [ ] **Unit-test `src/config.js`** — 41 LOC of pure env parsing/validation gating boot; trivially testable, currently untested.
- [ ] **Remaining low-priority coverage gaps** — `src/features/logs/auditLog.js` misconfig paths (med-low); `src/features/music/render.js` embeds (cosmetic). `index.js`/`client.js`/`register.js` intentionally skipped (need live Discord).

---

## 3. Roadmap & wishlist (`roadmap/`)

### High

- [x] **Close the two shipped ticket "fixes"** — `roadmap/help-tickets.md` §1.11 Fix 1 (`getManageableStaffRoleIds` cache-miss fallback, bot-held-role skip, per-role notes — shipped, `src/features/tickets/overwrites.js:90–212`, tested `test/tickets.test.js:656`) and Fix 2 (DM transcript link to requester — shipped, `src/features/tickets/close.js:191–253,673–693`, tested `test/tickets.test.js:1399+`). Tick in feature file, `roadmap/index.md` row 15, and §8 (lines 145–146) — they are currently the roadmap's stated next actions for tickets.
- [ ] **Rewrite `roadmap/staff-roles.md` + index §7/§8 to the shipped gate** — file/index omit `level` junior/senior (migration `011`), `added_by` (`024`), `/staff role setlevel`, `/staff settings`, `/staff syncpermissions` + OAuth command-visibility (`016` / `commandPermissions`), senior-only ticket overwrites (`src/core/permissions.js:37`), and audit embeds. §7's "Rename only; same columns (`guild_id, role_id, created_at`, PK)" is false; §4.3 omits the required `level` option; §4.4 "option A/B" was overtaken. Keep only "fine-grained capability flags beyond junior/senior" open.
- [ ] **Renumber web-admin planned migrations** — `024_web_sessions` / `025_admin_audit` collide with the shipped `024_staff_roles_added_by.js`; change to `025_web_sessions` / `026_admin_audit` in `roadmap/web-admin.md` §8.5 + `roadmap/index.md` §7, and add "reserve the next free id at implementation time" so the plan can't rot this way again.
- [x] **Reconcile `roadmap/help-tickets.md` core sections with shipped behavior** — (a) document the two-phase `/ticket close` → `/ticket archive` split (`tickets/index.js:187,886,1511`; `close.js:470`); (b) §1.1 "panel has no DB row" is wrong — stored panel registry shipped (`ticket_panels`, migration `019`); (c) §1.3 overwrites go to **senior** staff only; (d) strike the §1.5 attachment-mirror "TODO" and revise locked decision 5 — shipped (`mirrorTicketAssets`, `tickets/assets.js`, wired `close.js:576–599`; file already self-contradicts at §1.9).

### Medium

- [ ] **`roadmap/index.md` line 7 + §7 shipped inventory** — add `userActivity` / `/userinfo` Activity (migrations `013`/`014` — absent from roadmap entirely), `commandPermissions` (`016`), `ticket_panels` (`019`); reword line 7's "not tracked here", which contradicts line 11 (everything *is* tracked).
- [ ] **Bring `roadmap/web-admin.md` up to the repo's own decomposition bar** — no task-level breakdown, no estimates/Total Estimate/Complexity per `feature-breakdown.md`; Phase 1 bundles ~11 route areas in one row. Decompose Phase 0a–0c into 1–2 h checkbox tasks with Files/Estimate/Verification (pattern: `roadmap/gork.md` §7.15), or state estimates are intentionally deferred past Phase 0a.
- [ ] **Adopt a single-source rule for open items** — the DM-transcript item lived in 3 places (`index.md` row 15, §8 line 146, `help-tickets.md` §1.11) and all three drifted stale together. Make feature-file checkboxes authoritative; index rows link, not restate.
*Note: the migration off-by-one fix (`017`→`018`) is tracked once in §1 — it also covers `roadmap/index.md` §7 lines 75/78.*

### Low

- [ ] **`roadmap/event-reminders.md`** — §2.8 module path `src/eventReminders.js` doesn't exist → `src/features/eventReminders/`; §2.7 schema draft missing `persistent` (`017`) and `event_reminder_event_optouts` (`015`).
- [ ] **Sync `roadmap/warnings.md` §6.3/§6.5/§6.6 with its own status line** — add `/warn export`, `/setwarn expiry`, `expires_at`/evidence columns to the command/settings/schema drafts; decision 10 predates the `warn_log_channel_id` preference already recorded in §6.4.
- [ ] **Prune `roadmap/staff-notes.md` "Still open" (lines 131–132)** — both shipped: guild-wide `/note list` without user (`staffNotes/index.js:87`) and the 2000-char content modal (`MAX_NOTE_CONTENT`).
- [ ] **Prune `roadmap/twitch-notifications.md` "Still open" (lines 191–195)** — polling-interval default (2) and embed game/category were both decided and shipped (documented in the same file, §3.3/§3.5); keep only the `/testtwitchnotification` question.
- [ ] **`roadmap/index.md` status-table wording** — row 6 "Shipped (MVP + polish)" vs `warnings.md` "Shipped (MVP + post-MVP polish)"; the one field that must match should do so verbatim.

---

## 4. Cross-cutting theme

- [ ] **One reconciliation pass** — staleness is the systemic issue: docs migration tables, AGENTS.md feature list, and roadmap statuses all lag shipped code in overlapping ways. A single "source of truth = `src/` + `src/db/migrations/` + `package.json`" pass clears roughly 15 items above in one sitting. Candidate: a tiny `npm run check:docs-drift` script that diffs the migration list and feature-module list against the tables that cite them.

---

## Verified clean on 2026-09-09 — do NOT re-audit these

- **Secrets**: repo-wide scan (docs, tests, roadmap, `.env.example`) found zero real/realistic-looking tokens; all placeholders clearly fake.
- **Dead-link rule**: no relative links from `docs/**` escape `docs/`; docs→roadmap refs are absolute GitHub URLs; all verified cross-page links and in-page anchors resolve; nav/sidebar/logo/dist-path correct; `docs.yml` matches the documented build/deploy flow.
- **Suite health**: 624/624 tests green (392 unit / 232 integration), zero skips/`.only`/todo, ~13.5 s total; `npm test` wiring covers all 44 files; all 22 integration files reuse `createIntegrationEnv()`; AGENTS.md error-handling patterns (`{ok:false,error}` services, specific-cause replies, partial-failure reporting) well covered by negative tests.
- **Roadmap**: all 8 headline statuses consistent between index and feature files; docs↔roadmap link hygiene respected; `web-admin.md` "no code yet" premise accurate; `gork.md` is the maintenance model; XP polish sections verified shipped.
