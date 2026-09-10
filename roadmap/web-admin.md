# 8. Web Admin Console

### Purpose

Replace the minimal, mostly-unauthenticated HTTP surface (`src/features/tickets/httpServer.js`) with a fully-featured, **Discord-login-gated admin interface** for guild staff and admins — a second transport for the *same* authorization model and service layer the slash commands already use. It also closes the long-standing ticket TODO "Login with Discord on transcript HTTP routes" ([help-tickets.md](help-tickets.md)) by making login **mandatory** on all ticket routes.

### Status

**Planned** — design v2 (post critical review). No code yet. Program runs Phases 0a → 3, polish in Phase 4. Task-level breakdown and estimates (Phases 0a–1): [§8.14](#814-task-breakdown-planned).

---

### 8.1 Locked decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Express 5** replaces raw `node:http`; single server on `PUBLIC_HTTP_PORT` | CJS-native, mature; keeps one container/port/topology. Pin version (path-to-regexp v8 route-syntax changes). |
| 2 | **SSR templates + vendored htmx + small nonce'd vanilla JS modules. No Alpine, no React, no build step** | Alpine's `x-*` attributes need `unsafe-eval`/`unsafe-hashes` under CSP — unacceptable on an admin panel. No build step keeps Docker/CI unchanged. |
| 3 | **Login is required (no flag, no escape hatch)** for `/t` index, `/t/{uuid}` transcripts, and transcript assets. Only `/health` and OAuth endpoints stay public | Operator decision. Closes [help-tickets.md](help-tickets.md) open item and the "not login-gated (MVP)" warning in the index page. |
| 4 | **Transcript access = guild staff-tier OR ticket participant** | Staff can moderate; the people a transcript is *about* keep the right to read it. Participants resolve from existing tables — no new schema. |
| 5 | Panel tiers mirror the bot gates exactly (Staff / Senior / ManageGuild-only) | Handlers are the source of truth; the panel must never be a bypass. |
| 6 | Panel mutations **call the existing service layer** (`awardXp`, warnings, staffRoles, tickets, …) — never reimplement logic | Single business logic, consistent audit and validation. |
| 7 | **DB-backed audit trail (`admin_audit`)** — the existing `auditLog.js` is a Discord *channel embed poster*, not a trail; channel mirrors stay best-effort | A queryable audit viewer is impossible against embeds. |
| 8 | Sessions in DB (`web_sessions`), cookie carries only an opaque id; tier re-validated per request against a ≤60 s cache | Revocation bounded by cache TTL — honestly documented, not "instant". |
| 9 | Web login tokens ≠ per-guild `guild_command_permission_oauth` tokens — separate tables/flows | Different identity semantics (user session vs. guild-admin authorization). |
| 10 | Production **requires HTTPS** (reverse proxy TLS); config warns on non-localhost `http://` base URL | Discord redirect URIs need HTTPS; `Secure` cookies need TLS. |
| 11 | Gork admin, music queue **control**, and public (non-staff) pages are **out of scope for v1** | Explicit exclusions; see §8.9. |

---

### 8.2 Architecture

New `src/web/` owns the HTTP surface; the tickets feature registers routes instead of owning the server.

```
src/web/
  server.js          # start/stop, owns PUBLIC_HTTP_PORT (moved from tickets)
  app.js             # pure factory → express app (testable without listen())
  middleware/
    session.js       # cookie → session row → req.user (null = anonymous)
    guildScope.js    # :guildId ∈ viewer access list else 404 (never 403)
    requireTier.js   # staff / senior / admin equivalents of core/permissions
    csrf.js          # per-session token, required on all non-GET
    rateLimit.js     # buckets: login, oauth callback, mutations
    audit.js         # mutation → admin_audit row (DB-first) + best-effort embed
  auth/
    login.js         # authorize redirect + callback (purpose-scoped state)
    guildAccess.js   # tier resolution + caches (see 8.3)
    sessions.js      # create/touch/destroy; rotation
  views/             # layout, components, escaped-by-default templates
  public/            # vendored htmx (version-stamped), app.js, styles.css
  routes/
    dashboard.js  users.js  xp.js  tickets.js  settings.js  moderation.js
    staff.js  integrations.js  system.js  transcripts.js
```

- **Boot**: `src/features/index.js` gains a `web` module that starts the server when `PUBLIC_HTTP_PORT` is set (today the tickets feature starts it — ownership moves; `tickets/httpServer.js` shrinks to route registration; compat shims kept).
- **Feature contract**: features may contribute routes via a `web` descriptor, collected at boot like commands/handlers are today.

---

### 8.3 Authentication & authorization

**Login flow** — Discord OAuth2, scopes `identify guilds guilds.members.read`:

- New callback route `/auth/login/callback` (register it in the Dev Portal next to the existing command-permissions callback; both paths documented in `docs/setup.md`).
- State tokens reuse `commandPermissions/oauthState.js` but the signed payload gains a **`purpose` field** (`web_login` vs `cmd_perms`); the callback rejects purpose mismatch → no cross-flow substitution.
- Callback fetches member role IDs per accessible guild (via the user access token), stores session, **rotates the session id** on login.

**Tier resolution** (`auth/guildAccess.js`) — per request, bounded-staleness caches:

| Input | Source | Cache |
|-------|--------|-------|
| Guilds the user is in | OAuth `guilds` (+ bot-membership filter: guild must **also have the bot**) | session, re-checked at TTL |
| User's role ids in guild | OAuth `guilds.members.read` — **role ids only** | 60 s (`WEB_TIER_CACHE_TTL_MS`) |
| Which roles carry ManageGuild | Bot REST `GET /guilds/:id/roles` (`permissions` bitmask) | 5 min + invalidated on role events |
| Staff / senior membership | `staff_roles` table (SQLite) | none (cheap) |

Tier = `admin` if any role has ManageGuild → else `senior`/`staff` via `staff_roles.level` → else no access. Decision inputs are `(roleIds, manageGuildBit, staffRoleIds)` so the slash-command gates and web middleware stay provably equivalent.

**Degradation matrix** (deliberate, not accidental):

| Failure | Behavior |
|---------|----------|
| Bot not in guild | Guild hidden from switcher; routes 404 |
| Roles fetch unavailable (rate-limited / scope missing) | ManageGuild tier unresolvable → staff/senior still work via `staff_roles`; admin-only pages blocked; operator banner + log. Escape: add the admin's role to `staff_roles` |
| Member left guild | Deny + session's guild list refreshed |

**Sessions** (`web_sessions`): opaque 32-byte id (cookie, `httpOnly`, `SameSite=Lax`, `Secure` when https), sliding 12 h (`WEB_SESSION_TTL_HOURS`), absolute 7 d cap, destroy on logout, prune job on boot. Cookie signing via **`SESSION_SECRET`** (dedicated; falls back to `CLIENT_SECRET` with boot warning — mirrors the `OAUTH_STATE_SECRET` precedent). Revocation latency ≤ tier-cache TTL (default 60 s).

---

### 8.4 Ticket transcript access (Phase 0c — first gated surface)

All ticket routes require login. Viewer may open `/t/{uuid}` (and its assets) when **either**:

1. **Staff tier** for the ticket's guild (per §8.3), **or**
2. **Participant** of that ticket, resolved from existing tables:
   - `tickets.creator_user_id`
   - `ticket_members` (added via `/ticket adduser`)
   - `ticket_staff` (named staff on the ticket)
   - `ticket_messages.author_id` (spoke in the channel)

Rules:

- **Sensitive tickets**: never content-archived → still 404, unchanged; they never appear in the index.
- `/t` index: guild-scoped to the viewer's access list; the legacy `?guild=` param is only honored for guilds the viewer can access (closes the current cross-guild leak).
- Participant check is **per ticket row** — knowing a UUID is never sufficient without a session.
- Token-URL links posted in channels before rollout stop resolving without login: **accepted breaking change**, shipped as a minor bump with release notes (no flag by design).

---

### 8.5 Data model additions

| Migration | Change |
|-----------|--------|
| `025_web_sessions` | `web_sessions (id TEXT PK, user_id TEXT, discord_tag TEXT, created_at, last_seen_at, expires_at)` + `idx(user_id)`; prune index on `expires_at` |
| `026_admin_audit` | `admin_audit (id, guild_id, actor_user_id, origin 'web'\|'slash'\|'system', action, target_type, target_id, details_json, created_at)` + `idx(guild_id, created_at)` |

> **Numbering note:** the migration ids above are planning-time placeholders. Every migration shipped after this plan was written shifts them — reserve the next free id at implementation time (verify against `src/db/migrations/` before numbering), never trust the numbers written here.

No new tables for participants (existing ticket schema covers §8.4). Slash handlers gain a thin `admin_audit` write alongside their existing channel embeds so origin is consistent across transports.

---

### 8.6 Page inventory & tiers

| Area (routes under `/g/:guildId`) | View tier | Mutate tier | Phase |
|---|---|---|---|
| Dashboard (activity, open tickets, ticker health, now-playing) | Staff | — | 1 (data) / 4 (charts) |
| Tickets: index + transcripts | Staff **or participant** (transcripts) / Staff (index) | Senior: claim/close/summary regen | 0c read · 3 write |
| Users: unified profile (XP, warnings, notes) | Staff | Staff (add note) | 1 read · 2–3 write |
| Users: Activity tab | **Senior** | — | 1 |
| XP: leaderboard, history | Staff | **Admin** (grant xp) | 1 read · 3 write |
| Moderation: warnings list/issue/void, notes | Staff | Staff | 1 read · 3 write |
| Settings: guild settings, command channels, logs channels, cooldowns, decay | Staff | per-setting tier (`/setcommandchannel` = **Admin**) | 1 view · 2 write |
| Staff & roles: `staff_roles` CRUD + levels | Staff (view) | **Admin** | 1 view · 2 write |
| Command visibility: sync status + trigger | Staff (view) | **Admin** (sync) | 1 view · 3 action |
| Integrations: YouTube, Twitch, reaction roles, event reminders, honeypot | Staff | per-command tier (`/honeypot exempt` = Admin) | 1 view · 2 write |
| Voice & Music: now-playing, queue **view only** | Staff | none (control out of scope) | 1 |
| System: health, tickers, OAuth state, **audit viewer (`admin_audit`)** | **Admin** | — | 1 (viewer) |

**Cross-cutting acceptance rules (every phase):** the `:guildId` param must be in the viewer's access list or the route returns 404 (never 403 — no guild enumeration); every mutation passes CSRF, writes `admin_audit`, and calls the service layer, not SQL directly.

**Query-budget rule (shared process with the bot; better-sqlite3 is synchronous):** list endpoints hard-cap `LIMIT ≤ 100` with offset/cursor; no full-table scans or per-request aggregation in JS; dashboard aggregates cached ≥ 30 s. Violations are review-blocking.

---

### 8.7 Security controls

- Session cookie hygiene as §8.3; regenerate on login; idle + absolute expiry.
- CSRF token (per-session, form + `X-CSRF-Token` for htmx) on all non-GET.
- CSP: `default-src 'self'`; `script-src 'self' 'nonce-…'`; no inline handlers; `frame-ancestors 'none'`; `X-Content-Type-Options: nosniff` (kept); `Referrer-Policy: no-referrer` on auth pages.
- Rate limits: login/callback (per IP + per user), mutations (per user); body size caps; generic 500s.
- HTTPS validation at boot: non-localhost `http://` `PUBLIC_BASE_URL` → loud warning + `Secure` cookie caveat in docs.
- Secrets: `SESSION_SECRET` placeholder in `.env.example` only; never logged (tags/tokens redacted in logs).
- Vendored htmx pinned with version header comment + upgrade note in this file.

---

### 8.8 Phases & exit criteria

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| **0a — Test port + extraction** | **First task:** HTTP-level tests (ephemeral port + `fetch`) covering `/health`, `/t`, `/t/{uuid}`, assets, oauth callback — replaces the `handleRequest(mockReq, mockRes)` seam in `test/tickets.test.js`. Then extract to `src/web/` on Express 5, **byte-identical behavior** | New tests green before extraction and after; old mock-based tests removed; zero route diffs |
| **0b — Auth core** | `web_sessions`, Discord login/logout, purpose-scoped state, guildAccess + tier middleware, SESSION_SECRET handling, HTTPS validation, rate limits | Login works against mocked Discord (injectable API base); unauthenticated `/g/*` → login redirect; tier matrix unit tests |
| **0c — Shell + ticket gating** | Guild switcher shell; **login required on all ticket routes** incl. participant rule (§8.4); cross-guild probe tests | Staff, each participant class, and stranger all tested per transcript; index guild-scoped; sensitive tickets 404 |
| **1 — Read-only** | Dashboard data, users (incl. senior Activity), XP/leaderboard, moderation lists, settings/staff/integrations views, audit viewer | Every read page behind correct tier; query-budget checks pass on seeded DB (10k users/messages) |
| **2 — Config writes** | Settings, command channels, logs, cooldowns, decay, staff roles (+levels), level roles, integrations, activity config; visibility status | Each mutation: CSRF-gated, tier-correct, service-layer call, `admin_audit` row; parity checklist vs. slash command |
| **3 — Actions** | Grant xp (admin), warn/void, add note, ticket claim/close/summary regen, visibility sync trigger | Slash↔web equivalence tests; audit origin labels correct |
| **4 — Polish** | Dashboard charts, mobile pass, session admin (list/revoke), docs site page | `docs/web-admin.md` + env table + VitePress sidebar; `npm run docs:build` green |

Each phase ships dark-by-default: with `PUBLIC_HTTP_PORT` unset, boot behavior is unchanged.

**Task breakdown & estimates:** Phases 0a–0c are decomposed into 1–2 h checkbox tasks (Files / Estimate / Dependencies / Verification) and the Phase 1 row above is split into per-area tasks in [§8.14](#814-task-breakdown-planned). **Phases 2–4 estimates are intentionally deferred** — those phases keep exactly the row-level fidelity above and get their own task breakdown only after Phase 0a completes (the test net + extraction lands first, so the remaining estimates land on proven ground).

---

### 8.9 Out of scope (v1) — explicit

| Item | Why | Revisit |
|------|-----|---------|
| Gork (AI) admin UI | Its config surface is 5 `guild_settings` knobs + access list; low panel value, separate audit model already exists | After Phases 0–3 |
| Music queue control (skip/stop/etc.) via web | Mutates live player state through an async path; risk/complexity disproportionate | Phase 4+ maybe |
| userActivity **config** beyond senior Activity view | Config stays slash-only until tiers are proven | After 3 |
| Public/member-facing pages, i18n, theming, 2FA, third-party API tokens, multi-process scaling | Not admin console goals | Never scheduled |

---

### 8.10 Environment

| Var | Required | Notes |
|-----|----------|-------|
| `PUBLIC_HTTP_PORT` (or `TICKET_HTTP_PORT`) | Panel on/off | Existing. Unset → no HTTP, unchanged bot behavior |
| `PUBLIC_BASE_URL` (or `TICKET_PUBLIC_BASE_URL`) | Yes for panel | Must be **https** in production; boot warns otherwise |
| `CLIENT_ID` / `CLIENT_SECRET` | Yes | Existing (OAuth app) |
| `SESSION_SECRET` | Recommended | Signs session cookies; falls back to `CLIENT_SECRET` with warning |
| `OAUTH_STATE_SECRET` | Existing | Signs OAuth state (now purpose-tagged) |
| `WEB_TIER_CACHE_TTL_MS` | Optional | Default `60000` — revocation bound |
| `WEB_SESSION_TTL_HOURS` | Optional | Default `12`, absolute cap 7 d |

**Operator steps (docs/setup.md):** register `{base}/auth/login/callback` redirect URI in the Discord Dev Portal; set `SESSION_SECRET`; put TLS/reverse proxy in front in production.

---

### 8.11 Testing

- **Pattern**: existing offline integration style — real SQLite, mocked Discord. Auth tests use an injectable Discord API base (token URL, `/users/@me`, `/users/@me/guilds`, member + guild-roles endpoints) mirroring current integration mocks.
- **Access matrix suite** (CI must-have): every route × {anonymous, stranger-in-guild, staff, senior, admin, ticket participant} → expected 200/404/redirect.
- **Cross-guild probe**: session valid for guild A → all guild-B routes 404.
- **Slash↔web parity**: same service call outcome + audit row shape.
- `node --test` only — no new test framework; HTTP via `fetch` on ephemeral ports.

### 8.12 Release / migration notes

- Minor version bump (release-please from `feat:` commits); release notes call out: ticket transcripts now require login (**no opt-out flag**), new `SESSION_SECRET`, new redirect URI registration.
- Upgrade guide snippet in `docs/setup.md` + this file updated per phase completion.

---

### 8.13 Design decisions (locked) — summary

1. Express 5, single port, opt-in. 2. SSR + vendored htmx + nonce'd vanilla JS; **no Alpine/React/build step** (CSP-safe). 3. Ticket routes login-mandatory, no flag; access = staff-tier **or** participant. 4. Tiers mirror bot gates via shared decision inputs; degradation matrix defined. 5. DB sessions, ≤60 s revocation, `SESSION_SECRET`. 6. Purpose-tagged OAuth state; web login tokens separate from command-permission tokens. 7. `admin_audit` DB trail (channel embeds remain mirrors). 8. HTTPS required; Secure cookies. 9. Phase 0a re-establishes the HTTP test net **before** extraction. 10. Cross-guild 404 rule + query budget are review-blocking acceptance criteria.

---

### 8.14 Task breakdown (Planned)

> **All work in this section is Planned — none of it exists or has shipped.** File paths are
> planned locations (per §8.2); migration ids follow the §8.5 reserve-the-next-free-id note —
> verify against `src/db/migrations/` at implementation time, never trust the numbers here.

**Estimate scope:** Phases 0a–0c are decomposed into 1–2 h tasks and Phase 1 is split into
per-area tasks (coarser, roughly half-day units). **Phases 2–4 are intentionally left
unestimated** — they stay at the §8.8 row level and are decomposed only after Phase 0a
completes. The Total Estimate below therefore covers **Phases 0a–1 only**.

Format follows the repo's feature-breakdown convention (checkbox tasks with
Files / Estimate / Dependencies / Verification — cf. `roadmap/gork.md` §7.15).

#### 8.14.1 Phase 0a — test port + extraction

**Goal:** HTTP-level test net on the current raw `node:http` server, then a byte-identical
extraction onto Express 5 under `src/web/`. No behavior change, no auth yet.

- [ ] **Task 0a.1:** HTTP-level test net — `fetch` against the current `httpServer.js` on an
      ephemeral port: `/health`, `/t` (pagination + `?guild=`), `/t/{uuid}`,
      `/t/{uuid}/assets/…`, `/oauth/command-permissions/callback` (success + error paths)
  - **Files:** `test/integration/web-http.test.js` (new)
  - **Estimate:** 2 h
  - **Dependencies:** none
  - **Verification:** `node --test test/integration/web-http.test.js` green **before** any
    refactor; all five route families covered.
- [ ] **Task 0a.2:** Retire the `handleRequest(mockReq, mockRes)` seam — port anything unique
    in the old unit seam to the 0a.1 HTTP tests, then delete the seam
  - **Files:** `test/tickets.test.js`
  - **Estimate:** 1 h
  - **Dependencies:** 0a.1
  - **Verification:** no `handleRequest`/mock-req references left under `test/`; full suite green.
- [ ] **Task 0a.3:** Express 5 (pinned) + pure app factory + server wrapper owning
    `PUBLIC_HTTP_PORT` — `listen()` lives only in `server.js`; app boots in tests without it
  - **Files:** `package.json`, `src/web/app.js`, `src/web/server.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0a.1
  - **Verification:** factory boots on an ephemeral port in tests; empty app 404s; no route
    logic in `server.js`.
- [ ] **Task 0a.4:** Extract `/health` + `/t` index **byte-identical** (same HTML, pagination,
    `?guild=` param, headers)
  - **Files:** `src/web/routes/system.js`, `src/web/routes/transcripts.js`
  - **Estimate:** 1.5 h
  - **Dependencies:** 0a.3
  - **Verification:** the 0a.1 health/index cases pass through the Express app — zero route diff.
- [ ] **Task 0a.5:** Extract `/t/{uuid}` + `/t/{uuid}/assets/…` byte-identical — keeps the
    path-traversal guard, sensitive 404, and the generic-500 no-leak rule (§8 error-handling law)
  - **Files:** `src/web/routes/transcripts.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0a.4
  - **Verification:** transcript + asset cases (incl. traversal attempts and sensitive tickets)
    pass unchanged.
- [ ] **Task 0a.6:** Mount the existing command-permissions OAuth callback
    (`handleCommandPermissionOAuthCallback`, unchanged) on the app; leave compat shims in
    `tickets/httpServer.js` so `transcriptPublicUrl`/config imports keep working
  - **Files:** `src/web/app.js`, `src/features/tickets/httpServer.js`,
    `src/features/commandPermissions/httpCallback.js`
  - **Estimate:** 1.5 h
  - **Dependencies:** 0a.3
  - **Verification:** OAuth callback cases from 0a.1 green; `tickets/close.js` and
    `tickets/summary.js` imports unbroken.
- [ ] **Task 0a.7:** Boot ownership move — `src/web/` becomes the `web` feature module that
    starts the server when `PUBLIC_HTTP_PORT` is set; tickets stops starting it
  - **Files:** `src/features/index.js`, `src/web/server.js`, `src/features/tickets/index.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0a.4–0a.6
  - **Verification:** boot with the port unset behaves exactly as before (dark by default);
    with it set, exactly one listener; the start path stays idempotent.
- [ ] **Task 0a.8:** Phase 0a sign-off — drop the legacy `node:http` request path, keep only
    the shim exports; run the full suite; record route parity
  - **Files:** `src/features/tickets/httpServer.js`
  - **Estimate:** 1 h
  - **Dependencies:** 0a.1–0a.7
  - **Verification:** `npm test` green; the 0a.1 suite passes on both the old code (recorded)
    and the extraction; zero route diffs.

**Phase 0a subtotal: 8 tasks · 13 h**

#### 8.14.2 Phase 0b — auth core

**Goal:** Discord login, DB sessions, tier resolution, and the middleware stack — no page
content yet.

- [ ] **Task 0b.1:** `web_sessions` migration (**reserve the next free id at implementation
    time** per the §8.5 note; planned `025`) + session repository + prune job on boot
  - **Files:** `src/db/migrations/025_web_sessions.js`, `src/db/repositories/webSessions.js`
  - **Estimate:** 1.5 h
  - **Dependencies:** none
  - **Verification:** migration applies to fresh **and** existing DBs; prune unit test removes
    expired rows only.
- [ ] **Task 0b.2:** Purpose-tagged OAuth state — signed payload gains `purpose`
    (`web_login` / `cmd_perms`); each callback rejects a mismatch (no cross-flow substitution)
  - **Files:** `src/features/commandPermissions/oauthState.js`,
    `src/features/commandPermissions/httpCallback.js`
  - **Estimate:** 1.5 h
  - **Dependencies:** none
  - **Verification:** unit test — `cmd_perms` state on the web callback rejected and vice versa;
    existing sync flow still green.
- [ ] **Task 0b.3:** Login flow — `/auth/login` redirect + `/auth/login/callback` (register in
    Dev Portal per §8.10); injectable Discord API base; fetch guilds + member role ids;
    **session id rotates on login**
  - **Files:** `src/web/auth/login.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0b.1, 0b.2
  - **Verification:** integration test against a mocked Discord API — login stores the session,
    sets the cookie, and the pre-login id no longer resolves.
- [ ] **Task 0b.4:** Session lifecycle — create/touch/destroy, sliding 12 h + absolute 7 d
    (both env-tunable), cookie hygiene (`httpOnly`, `SameSite=Lax`, `Secure` on https),
    `SESSION_SECRET` with `CLIENT_SECRET` fallback + boot warning
  - **Files:** `src/web/auth/sessions.js`, `.env.example`
  - **Estimate:** 2 h
  - **Dependencies:** 0b.1
  - **Verification:** unit matrix for touch/expiry/cap/destroy; cookie flags asserted in the
    0b.3 integration test; fallback path logs its warning.
- [ ] **Task 0b.5:** `guildAccess` tier resolution — admin/senior/staff from `(roleIds,
    manageGuildBit, staffRoleIds)`; role-ids cache ≤60 s, ManageGuild bitmask 5 min +
    role-event invalidation; degradation matrix (§8.3) honored
  - **Files:** `src/web/auth/guildAccess.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0b.3
  - **Verification:** unit matrix admin/senior/staff/denied + one test per §8.3 degradation row;
    cache-TTL boundary cases; guild hidden when bot absent.
- [ ] **Task 0b.6:** Route middleware — `session` (cookie → `req.user`, null = anonymous),
    `guildScope` (`:guildId` ∈ viewer list else **404, never 403**), `requireTier`
    (staff/senior/admin equivalents of `core/permissions`)
  - **Files:** `src/web/middleware/session.js`, `src/web/middleware/guildScope.js`,
    `src/web/middleware/requireTier.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0b.4, 0b.5
  - **Verification:** unauthenticated `/g/*` → login redirect; foreign guild → 404; below-tier →
    the designed deny — all as unit + integration cases.
- [ ] **Task 0b.7:** CSRF (per-session token; form field + `X-CSRF-Token` for htmx, required on
    all non-GET) + rate-limit buckets (login, OAuth callback, mutations — per IP + per user)
  - **Files:** `src/web/middleware/csrf.js`, `src/web/middleware/rateLimit.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0b.4
  - **Verification:** non-GET without/with-wrong token → 403; bucket-limit unit cases; body-size
    cap holds.
- [ ] **Task 0b.8:** Env wiring + HTTPS validation — `WEB_TIER_CACHE_TTL_MS`,
    `WEB_SESSION_TTL_HOURS`, `PUBLIC_BASE_URL` reuse; non-localhost `http://` base → loud boot
    warning + `Secure`-cookie caveat in setup docs
  - **Files:** `src/web/server.js`, `.env.example`, `docs/setup.md`
  - **Estimate:** 1 h
  - **Dependencies:** 0b.4
  - **Verification:** warning observed on an `http://` prod base; env overrides provably reach
    the caches/TTLs.
- [ ] **Task 0b.9:** Auth integration suite + **access-matrix scaffold** (§8.11) — every route
    × {anonymous, stranger-in-guild, staff, senior, admin, participant} against stub routes
  - **Files:** `test/integration/web-auth.test.js`, `test/web.test.js` (tier/session units)
  - **Estimate:** 2 h
  - **Dependencies:** 0b.1–0b.8
  - **Verification:** `node --test test/integration/web-auth.test.js test/web.test.js` green;
    matrix runs all six identities; CI picks the files up via existing globs (no package.json
    change).

**Phase 0b subtotal: 9 tasks · 15 h**

#### 8.14.3 Phase 0c — shell + ticket gating

**Goal:** Rendered shell with the guild switcher, and ticket routes become login-mandatory
with the §8.4 access rule. First user-visible behavior change of the program.

- [ ] **Task 0c.1:** View layer — escaped-by-default templates, layout, CSP wiring
    (`default-src 'self'`, `'nonce-…'` scripts, `frame-ancestors 'none'`, nosniff kept),
    vendored htmx pinned with the version-stamp header comment
  - **Files:** `src/web/views/layout.js`, `src/web/app.js`, `src/web/public/htmx.min.js`
  - **Estimate:** 2 h
  - **Dependencies:** Phase 0b
  - **Verification:** CSP header asserts incl. nonce on every response; no inline handlers exist;
    htmx loads with its version comment.
- [ ] **Task 0c.2:** Shell + guild switcher — lists the session's guilds where **the bot is
    also present**; selecting scopes `/g/:guildId`; minimal `/g/:guildId` placeholder page
  - **Files:** `src/web/views/shell.js`, `src/web/routes/dashboard.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0c.1
  - **Verification:** bot-less guild hidden and its routes 404; switch re-scopes every page
    (probe case added to the matrix).
- [ ] **Task 0c.3:** `/t` index gating — login required; guild-scoped to the viewer's access
    list; `?guild=` honored **only** for accessible guilds (closes the cross-guild leak)
  - **Files:** `src/web/routes/transcripts.js`
  - **Estimate:** 1.5 h
  - **Dependencies:** 0c.2
  - **Verification:** anonymous → login redirect; foreign `?guild=` shows only own rows;
    sensitive tickets still absent.
- [ ] **Task 0c.4:** `/t/{uuid}` + `/t/{uuid}/assets/…` gating — staff tier **or** participant
    (`tickets.creator_user_id`, `ticket_members`, `ticket_staff`, `ticket_messages.author_id`);
    per-row check — a UUID alone is never sufficient; sensitive tickets stay 404
  - **Files:** `src/web/routes/transcripts.js`, `src/db/repositories/tickets.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0b.5, 0c.3
  - **Verification:** per-transcript matrix — staff 200, each participant class 200, authenticated
    stranger 404, anonymous redirect, sensitive 404; assets follow the parent's verdict.
- [ ] **Task 0c.5:** 0c suite hardening — full §8.11 access matrix on every route live at the
    end of 0c + cross-guild probe (valid guild-A session → all guild-B routes 404)
  - **Files:** `test/integration/web-transcripts.test.js`
  - **Estimate:** 2 h
  - **Dependencies:** 0c.3, 0c.4
  - **Verification:** suite green in CI; no route returns 403 where 404 is specified.
- [ ] **Task 0c.6:** Operator notes for the breaking change — second redirect URI
    (`{base}/auth/login/callback`), transcripts-require-login with **no opt-out flag** in
    setup docs + the §8.12 release-note blurb
  - **Files:** `docs/setup.md`, `roadmap/web-admin.md` (§8.12 update on completion)
  - **Estimate:** 1 h
  - **Dependencies:** 0b.3
  - **Verification:** both callbacks documented; `npm run docs:build` green; release note states
    the accepted breaking change.

**Phase 0c subtotal: 6 tasks · 10.5 h**

#### 8.14.4 Phase 1 — read-only pages (per-area split of the §8.8 row)

**Goal:** every §8.6 area readable behind the correct tier — no mutations. One task per route
area; estimates are coarser per-area units (half-day scale), not 1–2 h steps. Each area task
shares the same acceptance bar: correct view tier, cross-guild 404, `LIMIT ≤ 100` + cursor
per the §8.6 query-budget rule, and access-matrix entries.

- [ ] **Task 1.1:** Dashboard data — recent activity, open tickets, ticker health,
    now-playing; guild aggregates cached ≥ 30 s (shared-process budget)
  - **Files:** `src/web/routes/dashboard.js`, `src/web/views/dashboard.js`
  - **Estimate:** 4 h · **Dependencies:** Phase 0c
  - **Verification:** staff sees all panels, stranger 404s; no per-request full-table scans
    (seeded-DB check in 1.12); cache holds under repeat loads.
- [ ] **Task 1.2:** Users — unified profile read (XP/level, warnings incl. voided, staff notes)
  - **Files:** `src/web/routes/users.js`, `src/web/views/users.js`
  - **Estimate:** 3 h · **Dependencies:** Phase 0c
  - **Verification:** matches what `/xp`, `/warn list`, `/note list` show for the same user;
    senior-only Activity tab stays hidden until 1.3.
- [ ] **Task 1.3:** Users — Activity tab, **senior-tier only** (mirrors `/userinfo` Activity)
  - **Files:** `src/web/routes/users.js`
  - **Estimate:** 2 h · **Dependencies:** 1.2
  - **Verification:** junior-staff session → tab absent **and** data route 404; senior → renders.
- [ ] **Task 1.4:** XP — leaderboard + per-user history (paginated, capped)
  - **Files:** `src/web/routes/xp.js`
  - **Estimate:** 2 h · **Dependencies:** Phase 0c
  - **Verification:** ordering matches `topUsers()`; cap + cursor enforced; staff gate on both.
- [ ] **Task 1.5:** Moderation — warnings list + notes list with filters
    (user / status / date range)
  - **Files:** `src/web/routes/moderation.js`
  - **Estimate:** 3 h · **Dependencies:** Phase 0c
  - **Verification:** list output consistent with `/warn list` / `/note list` for the same
    filters; staff gate; limits honored.
- [ ] **Task 1.6:** Settings view — guild settings, command channels, logs channels,
    cooldowns, decay (read-only; writes land in Phase 2)
  - **Files:** `src/web/routes/settings.js`
  - **Estimate:** 3 h · **Dependencies:** Phase 0c
  - **Verification:** every value shown equals what the matching slash command displays; staff
    view gate; no mutation routes exist yet.
- [ ] **Task 1.7:** Staff & roles view — `staff_roles` with levels + `added_by` provenance
  - **Files:** `src/web/routes/staff.js`
  - **Estimate:** 2 h · **Dependencies:** Phase 0c
  - **Verification:** equals `/staff role list`; view = staff tier (writes are Admin, Phase 2).
- [ ] **Task 1.8:** Command visibility — sync status + last-sync state (trigger action
    lands in Phase 3)
  - **Files:** `src/web/routes/staff.js`
  - **Estimate:** 2 h · **Dependencies:** 1.7
  - **Verification:** status reads from `guild_command_permission_oauth` state only; no sync
    POST route exists yet.
- [ ] **Task 1.9:** Integrations view — YouTube, Twitch, reaction roles, event reminders,
    honeypot (per-config status; writes land in Phase 2)
  - **Files:** `src/web/routes/integrations.js`
  - **Estimate:** 3 h · **Dependencies:** Phase 0c
  - **Verification:** each panel matches its `/set…`/`/… list` command output; staff view gate;
    honeypot exempt list shown read-only (its write is Admin-only, Phase 2).
- [ ] **Task 1.10:** Voice & music — now-playing + queue **view only** (control stays out of
    scope per §8.9)
  - **Files:** `src/web/routes/system.js`
  - **Estimate:** 2 h · **Dependencies:** Phase 0c
  - **Verification:** snapshot rendered without touching player state; staff gate; zero control
    routes exist.
- [ ] **Task 1.11:** System — health, ticker states, OAuth state summary +
    **`admin_audit` viewer** (admin-only; queryable trail per §8.5); includes the audit-trail
    groundwork so a trail exists **before** the first web mutation (Phase 2): the
    `admin_audit` migration (**reserve id at implementation time**, planned `026`), the
    `recordAudit()` helper, and the thin slash-handler write alongside existing embeds (§8.5)
  - **Files:** `src/web/routes/system.js`, `src/db/migrations/026_admin_audit.js`,
    `src/db/repositories/adminAudit.js`, `src/web/middleware/audit.js`
  - **Estimate:** 4 h · **Dependencies:** Phase 0c
  - **Verification:** admin-only (staff/senior 404); viewer paginates `admin_audit` with the
    `idx(guild_id, created_at)` path; slash mutations land `origin='slash'` rows with embeds
    still posting unchanged; no secrets/tokens rendered.
- [ ] **Task 1.12:** Phase 1 hardening — access matrix filled for **every** read route +
    query-budget suite on a seeded DB (10k users / 10k messages): `LIMIT ≤ 100`, no full scans,
    no per-request JS aggregation
  - **Files:** `test/integration/web-reads.test.js` (new), `test/integration/web-auth.test.js`
    (matrix rows)
  - **Estimate:** 3 h · **Dependencies:** 1.1–1.11
  - **Verification:** 0c exit criteria met ("query-budget checks pass on seeded DB"); matrix
    covers 6 identities × all Phase 0c+1 routes; §8.11 CI must-have green.

**Phase 1 subtotal: 12 tasks · 33 h**

#### 8.14.5 Totals

| Phase | Tasks | Estimate |
|-------|-------|----------|
| 0a — test port + extraction | 8 | 13 h |
| 0b — auth core | 9 | 15 h |
| 0c — shell + ticket gating | 6 | 10.5 h |
| 1 — read-only pages | 12 | 33 h |

**Total Estimate** (covers **Phases 0a–1 only** — the estimated phases; Phases 2–4 are
intentionally deferred, see §8.14 preamble):

**Time:** 71.5 hours
**Complexity:** High

Estimates include writing the tests named in each Verification line; they exclude review
round-trips and any Phase 0a discovery that reopens a locked §8.1 decision.
