# 8. Web Admin Console

### Purpose

Replace the minimal, mostly-unauthenticated HTTP surface (`src/features/tickets/httpServer.js`) with a fully-featured, **Discord-login-gated admin interface** for guild staff and admins — a second transport for the *same* authorization model and service layer the slash commands already use. It also closes the long-standing ticket TODO "Login with Discord on transcript HTTP routes" ([help-tickets.md](help-tickets.md)) by making login **mandatory** on all ticket routes.

### Status

**Phases 0a → 3 complete** (subtasks 01–32). Program exit net:
`test/web-phase3-gate.test.js` — registry↔matrix integrity (all 40 mounted
mutations), the 40-row acceptance ladder, audit-origin verification
(forgery-immune `web`/`slash`/`system` labels + ledger invariant proving
every `admin_audit` row is booked at its source), the full tier
conformance sweep, boot wiring, and slash↔web two-transport equivalence
for grant-XP, warn/void, notes, ticket claim/close/summarize and
visibility sync (documented deltas D1–D5). Shared fixtures/ladder live in
`test/helpers/mutation-ladder.js`; the historical per-phase gates
(`web-phase1-gate`, `web-phase2-gate`) remain green. Phase 4 (polish) is
separate and out of scope for this breakdown.

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
| Guilds the user is in | OAuth `guilds` — returns **all** user guilds; must be intersected with the bot's guilds (`client.guilds` cache) | session row `guild_snapshot` (025), re-checked at TTL |
| Admin tier fast path | `guild_snapshot[].permissions` decimal bitset (`MANAGE_GUILD`/`ADMINISTRATOR`, BigInt) + `owner` flag — no per-guild fetch needed | as above |
| User's role ids in guild | OAuth `guilds.members.read` — **role ids only** (no computed permissions) | 60 s (`WEB_TIER_CACHE_TTL_MS`) |
| Which roles carry ManageGuild (attribution only) | Bot REST `GET /guilds/:id/roles` (`permissions` bitmask) — needed only to show *which* role grants it | 5 min + invalidated on role events |
| Staff / senior membership | `staff_roles` table (SQLite) | none (cheap) |

Tier = `admin` if any role has ManageGuild → else `senior`/`staff` via `staff_roles.level` → else no access. Decision inputs are `(roleIds, manageGuildBit, staffRoleIds)` so the slash-command gates and web middleware stay provably equivalent.

**Degradation matrix** (deliberate, not accidental):

| Failure | Behavior |
|---------|----------|
| Bot not in guild | Guild hidden from switcher; routes 404 |
| `guilds.members.read` member fetch unavailable | Admin tier still resolves via `guild_snapshot.permissions`; **staff/senior unresolvable** (need role ids) → those users see admin-tier-allowed content only via snapshot, nothing staff-scoped; operator banner + log. Escape: none needed for admins; retry on TTL |
| Snapshot stale after role/permission change | Bounded by `WEB_TIER_CACHE_TTL_MS` (§8.1-8) |
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
| `023_web_sessions` | `web_sessions (id TEXT PK, user_id TEXT, discord_tag TEXT, created_at, last_seen_at, expires_at)` + `idx(user_id)`; prune index on `expires_at` |
| `024_admin_audit` | `admin_audit (id, guild_id, actor_user_id, origin 'web'\|'slash'\|'system', action, target_type, target_id, details_json, created_at)` + `idx(guild_id, created_at)` |
| `025_web_session_tokens` | Adds NULLable `access_token_enc` (AES-256-GCM envelope, HKDF key from `SESSION_SECRET`), `token_expires_at`, `scopes`, `guild_snapshot` (bot∩user guild list w/ per-guild `permissions` bitset + `owner`) to `web_sessions`. AT lifetime ≈ session cap ⇒ no refresh flow in v1; secret rotation ⇒ decrypt fails ⇒ re-auth. Login tokens still never leave the DB (§8.1-9) |

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
  **Pinned (Phase 0c):** `htmx.org@2.0.10` → `src/web/public/vendor/htmx.2.0.10.min.js`
  (MIT; npm-registry tarball sha512-verified at vendor time; `/*! htmx.org v2.0.10 … */`
  banner is the first bytes; no CDN, no build step). **Upgrade procedure:** bump the
  pinned version, re-vendor from the registry tarball, drop the old file, and bump
  `HTMX_SRC` in `src/web/views/layout.js` — the filename is the cache-buster
  (`/static/*` is served `immutable`), and `test/web-views-layout.test.js` pins both
  the banner and the layout reference.

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
