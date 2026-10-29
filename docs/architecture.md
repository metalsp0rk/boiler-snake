# Architecture Overview

Technical deep dive into Boiler Snake for developers and contributors.

## Overview

Boiler Snake is a [Discord.js](https://discord.js.org/) v14 bot with a SQLite backend. The codebase is a **modular monolith**: product areas live under `src/features/`, shared infrastructure under `src/core/`, `src/db/`, and `src/services/`, with a thin entrypoint.

## Testing

- **Unit** (`npm run test:unit`): pure math, cooldowns, registry, DB smoke — `test/*.test.js`
- **Integration** (`npm run test:integration`): full stack offline with temp SQLite and mocked Discord I/O — `test/integration/*.test.js`
- **E2E tier 4** (`npm run test:e2e`): the real bot booted against the pinned + patched fauxcord mock Discord — `test/e2e/*.test.js`, see [e2e.md](e2e.md)
- **All** (`npm test`): unit + integration via `node --test`
- Harness: `test/helpers/` (`createIntegrationEnv`). See `test/README.md`.
- Pipeline handlers (`onMessageCreate`, etc.), `runVoiceTick`, and YouTube `processChannel`/`runYoutubeTick` are exported for direct invocation without gateway login.

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
│   ├── lifecycle.js         # Crash net (unhandledRejection/uncaughtException) + SIGTERM/SIGINT drain
│   ├── permissions.js       # isAdminOrMod / isStaff / isSeniorStaff + require*
│   ├── interaction.js
│   ├── ai.js                # shared OpenAI-compatible client (tickets + gork)
│   ├── commandVisibility.js # slash picker tiers (public/staff/admin)
│   ├── scheduler.js         # named jobs: overlap skip, align, cron, snapshots
│   ├── tokenCrypto.js       # generic AES-256-GCM `v1.` envelope codec (shared by bridge + third-party bindings)
│   ├── thirdPartyTokens.js  # at-rest encryption for GitHub PATs + command-permission OAuth tokens (TOKEN_ENCRYPTION_KEY)
│   ├── theme.js
│   └── text.js
├── services/
│   └── awardXp.js           # Unified XP → activity → roles → audit
├── features/
│   ├── load.js              # applyFeaturesToRegistry / start / registerEvents
│   ├── index.js             # Ordered feature list (27 modules)
│   ├── settings/            # /settings
│   ├── commandChannels/     # /setcommandchannel
│   ├── xp/                  # /xp /leaderboard /setxp /grantxp + award helpers
│   ├── decay/               # /setdecay + daily cron
│   ├── voice/               # Voice XP ticker
│   ├── music/               # /play /music + Lavalink voice streaming
│   ├── levelRoles/          # /leveltorole + syncMemberRoles
│   ├── logs/                # /setlog + auditLog + delete/ban/kick
│   ├── youtube/             # YouTube commands + Data API ticker
│   ├── twitch/              # /twitch /settwitch + Helix go-live ticker
│   ├── githubReleases/      # /github + hourly GitHub releases ticker
│   ├── honeypot/            # /honeypot + ban/warn pipeline
│   ├── reactionRoles/       # /reactionrole + panel service
│   ├── eventReminders/      # /eventreminder + modal + ticker + gateway
│   ├── events/              # /event + /eventsignup /eventconfig /eventchannels community events: buttons RSVP, series, presets, gcal, crossposts + web calendar
│   ├── staffRoles/          # /staff role gate (isStaff / requireStaff; junior|senior)
│   ├── commandPermissions/  # OAuth slash visibility sync (no slash of its own)
│   ├── staffNotes/          # /note staff-only private notes
│   ├── warnings/            # /warn + /setwarn formal disciplinary records
│   ├── userinfo/            # /userinfo staff card + note/warn/activity buttons
│   ├── userActivity/        # /activityconfig + channel message counters + backfill
│   ├── retention/           # hourly sweeps pruning the growth-only tables (#192)
│   ├── tickets/             # /ticket support channels + panel button/modal + archive HTTP
│   ├── gork/                # keyword AI Q&A, memory, budget, interaction log
│   ├── web/                 # Web admin console boot feature (starts src/web server)
│   ├── bridge/              # /bridge Discord↔Fluxer channel relay (webhooks + outbox)
│   └── linking/             # !link Discord↔Fluxer account pairs + XP mirroring
├── commands/
│   ├── registry.js          # name → handler map (from features); api: "interaction" | "context"
│   ├── router.js            # InteractionCreate dispatch (builds + asserts CommandContext)
│   └── register.js          # CLI: register slash commands
├── platform/
│   ├── boot.js              # Supervisor boot: endpoints, feature gate, drain
│   ├── context.js           # Platform-neutral CommandContext seam (#457 guard)
│   ├── community.js         # ensureCommunity (guild snowflake → communities row)
│   ├── normalizedMessageContract.js # adapter-boundary validators (Normalized* shapes)
│   ├── discord/context.js   # Discord CommandContext builder (router side)
│   └── fluxer/context.js    # Fluxer CommandContext builder
├── db.js                    # Facade re-export (stable require("./db"))
├── db/
│   ├── connection.js
│   ├── migrate.js
│   ├── migrations/
│   └── repositories/
├── render/
│   └── leaderboard.js       # PNG leaderboard (@napi-rs/canvas)
├── web/                     # Web admin console (Express-style app, dark by default)
│   ├── server.js            # startWebServer() — listens only when PUBLIC_HTTP_PORT (or ticket alias) is set
│   ├── app.js               # App assembly: routes + middleware
│   ├── config.js            # PUBLIC_HTTP_PORT / PUBLIC_BASE_URL contract (+ legacy TICKET_* aliases)
│   ├── auth/                # Discord OAuth login, sessions, bot-guild provider
│   ├── routes/              # dashboard, users, tickets, moderation, settings, sessions, system, events, …
│   ├── views/               # Server-rendered pages per console area
│   ├── data/                # Data-access layer for views (guild/ticket/dashboard data)
│   ├── assets/              # Forge source (Vite input): tokens, primitives, Shoelace entry
│   ├── middleware/          # auth guards, audit mirror, rate limiting
│   └── public/              # Legacy shell assets (app.js, styles.css, vendored Chart.js)
└── (compat shims)           # auditLog.js, roles.js, decay.js, … → features

xpbot.sqlite
package.json
.env.example
```

---

## Boot Sequence

Entry (`src/index.js`) is a thin gate over `platform/boot.js` — current flow,
supervisor era (PR 7):

```javascript
require("dotenv").config();
assertRuntimeEnv();     // >=1 platform credential: DISCORD_TOKEN or FLUXER_INSTANCES
assertConfigSanity();   // #205: [config] WARN lines + LAVALINK_HOST-without-password fail-fast

const registry = buildDefaultRegistry();   // features → commands + handlers
const result = await boot({ registry });   // everything below happens in boot()
// terminal outcome only when EVERY configured endpoint failed:
if (!result.ok) await drainAndExit({ reason: "…", exitCode: result.exitCode });
```

Inside `boot()` (`src/platform/boot.js`):

```javascript
installProcessGuards();          // core/lifecycle: crash net + SIGTERM/SIGINT drain, once per process
const supervisor = { discord, fluxer, clientForCommunity };  // N endpoints, one process

// Discord arm (when DISCORD_TOKEN set): createClient → registerAllFeatureEvents
//   → registerOrderedPipelines → ClientReady → startFeaturesOnce; InteractionCreate
//   → router (with its own .catch — C8). An INITIAL login rejection is TERMINAL
//   for the endpoint: one fatal, client released, supervisor.discord → null.
// Fluxer arm: one handle per FLUXER_INSTANCES entry, logging in concurrently;
//   onFluxerReady listeners wire late-arriving handles (bridge DM consumer).

// Feature gate: arms when >=1 endpoint is READY (Discord ClientReady, or a
//   Fluxer handle whenever Discord is not live — including after a terminal
//   Discord failure). Never armed on a dead process. The watchdog RE-ARMS:
//   every FEATURE_GATE_WATCHDOG_MS window (default 120000, 0 disables)
//   re-logs what it waits on (#392); FEATURE_GATE_MAX_HOLD_MS (default 0 =
//   never) caps the hold with a documented DEGRADED open.

// startAllFeatures runs load.js hooks per feature with failure isolation
//   ([features] <name>.start failed: logged, skipped) and registers any
//   returned { stop() } loop handle for the shutdown drain (LIFO:
//   member-fetch-queue → scheduler → feature loops → endpoints).
```

The **web** feature's `start()` wires the Discord seams (`setBotGuildsProvider`, audit client binding) and calls `startWebServer()` — the public HTTP console. It is **dark by default**: nothing listens unless `PUBLIC_HTTP_PORT` (or the legacy `TICKET_HTTP_PORT` alias) is set. See [web-admin.md](./web-admin.md).

Forged Instrument (#709) adds a Vite asset build beside that server. `npm run assets:build` writes gitignored `dist/web` and `dist/forge-stamp.json` from `src/web/assets` (tokens, self-hosted Inter and JetBrains Mono, Shoelace 2.20.1). The same static middleware serves the result at `/static/forge/*`. The signed-in shell loads that bundle after `/static/styles.css`, so forge tokens win on the chrome. The shell (header, nav, grid, footer) and the dashboard page-group use it (#711). Phase 3 (#712) moves the data surfaces onto the same tokens: users, ticket actions, the ticket archive, warnings, notes, staff, settings, sessions, voice, the events calendar, and the system and audit pages. Those tables use the compact density (13px type, 34px rows from 720px up; under that, stacked phone cards still grow with their content). Identifier fields are lookup comboboxes. A snowflake on a person, a role, or an audit target has a copy button. The leaderboard, grant-XP page, transcripts, and the sign-in landing still use the previous page styles. The sign-in landing loads neither script. When public HTTP is enabled, `npm start` and `startWebServer()` refuse to listen if the stamp is missing or stale, so the console never comes up half-styled. `npm run assets:dev` is the local preview. Screenshot baselines under `test/visual/` are the real shell, the dashboard, and each migrated page-group (`npm run test:visual`). CI runs that harness in `scripts/visual/Dockerfile`, because the self-hosted runner cannot install Chrome's libraries. User ids and inline code use JetBrains Mono. The left arrow, the right arrow, ≤, and ≥ are a self-hosted Inter subset: the operating-system fallback for any of these changes line height or pixels between machines.

### Process guards (`core/lifecycle.js`)

`boot()` installs two process-level safety nets once per process (audit C8/C9):

- **Crash net** — `unhandledRejection` logs the specific cause with context and keeps the process alive (one dropped async op ≠ broken invariants); `uncaughtException` logs, runs the same drain, then exits 1 for the supervisor to restart (`restart: unless-stopped`). The named dispatch sites (`boot.js` InteractionCreate, `bot/pipelines.js` gateway listeners incl. a try/catch around `normalizeDiscordMessage`) carry their own `.catch()`/guard — the net is the backstop, never the plan.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` drains named stop handles in reverse registration order (member-fetch queue → scheduler jobs → feature loop handles → Fluxer handles → Discord client), each awaited, each failure logged and continued. An 8s overall deadline (under docker's 10s grace) and a second-signal force-exit keep it from hanging; clean drain exits 0.

### Endpoint failure policy (audit C7)

`boot()` treats an endpoint as **terminal for the process** only when its INITIAL login fails — a later gateway reconnect loop never is (the login promise already settled):

- **Discord login rejected/failed** → one specific fatal (`[boot] discord login failed: … — endpoint disabled for this process`), the dead client is released, and `supervisor.discord` returns to `null` — exactly the state a Fluxer-only boot has — so the feature layer arms on the surviving Fluxer endpoint(s). Discord-hard features are isolated by the per-feature boot hooks (`[features] <name>.start failed:` logged, skipped). A bad `DISCORD_TOKEN` degrades; it does not zombie-boot or kill the process.
- **No endpoint ever ready** → the feature gate stays shut (no tickers/web console/relay on a dead process); `boot()` reports `{ ok:false, exitCode:1 }` and `src/index.js` exits **through the lifecycle drain** (`core/lifecycle.drainAndExit`).
- **Watchdog** → if the gate has not opened within `FEATURE_GATE_WATCHDOG_MS` (default 120000, `0` disables), boot logs `[boot] watchdog: feature layer has not started after …ms — still waiting on: …` naming the endpoint(s) still pending — and **re-arms**: every window re-reports while the gate is shut (#392; the old one-shot made the second hour silent). Unref'd, cleared when the gate opens or the all-endpoints-failed fatal owns the outcome.
- **Max-hold (degraded open)** → `FEATURE_GATE_MAX_HOLD_MS` (default `0` = never force, the C7 contract) bounds how long a READY Fluxer endpoint waits on an unsettled Discord login. When the cap elapses and the in-flight login is the SOLE blocker (≥1 Fluxer handle live, none still connecting — else it retries next window), boot logs `[boot] DEGRADED gate open …`, features arm on the live endpoint, and `supervisor.discord` **reads null** while the login crawls — the same degrade signal a Fluxer-only boot and the C7 terminal path already use. A late `ClientReady` lifts the hold and logs a notice; features that skipped need a restart (their sockets were never cancelled).

### Feature module contract

```javascript
module.exports = {
  name: "example",
  commands: [/* SlashCommandBuilder */],
  handlers: { example: async (interaction, ctx) => {} },
  handlerApi: { example: "context" }, // optional: opt this handler into CommandContext
  autocomplete: { example: async (interaction, ctx) => {} }, // optional
  modalHandlers: { "prefix:": async (interaction, ctx) => {} }, // optional
  buttonHandlers: { "prefix:": async (interaction, ctx) => {} }, // optional
  registerEvents(client, ctx) {},  // optional
  start(client, ctx) {},           // optional (ClientReady) — register scheduler jobs here
                                   // may return `{ stop() }` — auto-drained on SIGTERM/SIGINT
};
```

**Two handler calling conventions (`CommandContext` seam).** The registry
stores every handler with an `api` (`registerHandler(name, fn, { api })`,
default `"interaction"`; `load.js` passes each feature's `handlerApi` map
through). On the **interaction** arm the handler receives the raw platform
interaction; on the **context** arm it receives a platform-neutral
`CommandContext` — the vocabulary lives in `src/platform/context.js` (pure,
gateway-free), and each adapter builds its own (`src/platform/discord/context.js`,
`src/platform/fluxer/context.js`). The router owns the seam: it builds the
context and runs `assertCommandContext` (the #457 boundary guard) before
dispatch, so a builder field rename or omission fails at the router as a
named contract error — never as a `TypeError` deep inside a handler.
Everything around the call (command-channel gate, logging, `safeErrorReply`)
keeps operating on the raw interaction.

### Ordered pipelines (`bot/pipelines.js`)

| Event | Order |
|-------|--------|
| **MessageCreate** | bridge loop gate (relay copies / bot traffic / echoes stop here — honeypot bot-trap exception) → bridge command-line branch (dispatch once, stop) → cache → pending RR emoji → honeypot → prefix-command stop (activity record + dispatch, no gork/XP; Fluxer) → gork (detached) → bridge enqueue (never early-returns) → user channel activity → message XP |
| **MessageReactionAdd** | partials → honeypot warning strip → RR panels → reaction XP |
| **MessageReactionRemove** | reaction-role remove |

**Normalized-message contract.** Both adapters (`src/platform/discord/normalize.js`, `src/platform/fluxer/normalize.js`) hand the pipeline the same duck-free shape, and the required subset of that shape is asserted at the single boundary both flow through — `assertNormalizedMessage` in `src/platform/normalizedMessageContract.js`, called first inside `onMessageCreate`. Required fields (ids as non-empty strings, arrays as arrays, `authorBot` boolean, `createdAt`/`communityId`/`externalGuildId`/`webhookId`/`type`/`parsePrefix` explicitly nullable) are listed with their nullability in the validator’s header. A half-shaped message can never enter a feature: the validator throws naming the field and the platform, and the pipeline catch logs it as a distinct `normalized-message contract violation` line and skips the message. Guild-vs-DM is modeled by the contract, not duck-typed: `externalGuildId` is string-or-null (`null` only for guild-less Discord DMs; the Fluxer normalizer gates guild-less payloads into the separate DM shape), so pipeline gates key off that field instead of `!message.guild`. Separate shapes — `NormalizedReaction`, the MESSAGE_DELETE identity partial, and `NormalizedDmMessage` — are separate contracts with their own intake-time checks.

Independent events (message delete, ban, kick, honeypot ban-role, tickers) register via each feature’s `registerEvents` / `start`.

---

## Database Layer (`db/`)

- **connection.js** — SQLite open (`DB_PATH` / `DATA_DIR`), explicit pragmas: WAL, `foreign_keys=ON`, `synchronous=FULL`, `busy_timeout=5000` (single-writer contract: one process per DB file — see [database.md](database.md))
- **migrate.js** + **migrations/** — idempotent ordered steps; `PRAGMA user_version` + the ordered `applied_migrations` ledger (#394) jointly record a completed pass and fast-skip replay only when BOTH agree with the registry; any mismatch re-runs the full idempotent set and re-stamps; a version newer than the registry fails boot loudly
- **repositories/** — users, guildSettings, activity, youtube, twitch, honeypot, reactionRoles, staff notes/roles, warnings, tickets, user activity, events (events/options/signups/series/presets/channels/gcal/crossposts), …
- **index.js** — public facade (same API as legacy single-file `db.js`)

Migrations on load:

| Id | Purpose |
|----|---------|
| `001_base_schema` | CREATE TABLE IF NOT EXISTS |
| `002_guild_settings_columns` | reaction XP, log channels, upload role |
| `003_youtube_composite_pk` | rebuild youtube_channels only if PK is legacy |
| `004_youtube_and_honeypot_columns` | last_checked, warning_message_id |
| `005_clamp_bad_xp` | sanitize bad XP rows |
| `006_event_reminders` | event reminder tables + default channel column |
| `007_staff_notes` | staff_notes table (soft-delete, per-guild note_number) |
| `008_staff_roles` | staff_roles table (generalized honeypot exempt) |
| `009_warnings` | warnings + warn_dm_members |
| `010_tickets` | tickets / members / staff / messages + ticket_* settings |
| `011_staff_role_levels` | `staff_roles.level` junior \| senior (ticket visibility) |
| `012_warn_log_channel` | `guild_settings.warn_log_channel_id` (warn issue/void embeds) |
| `013_user_channel_activity` | daily per-channel message counters, ignore list, user backfill meta |
| `014_guild_activity_backfill` | guild-wide activity backfill status + channel cursors |
| `015_event_reminder_event_optouts` | per-event mute table for event reminders |
| `016_command_permission_oauth` | OAuth token storage for slash command permission sync |
| `017_event_reminder_persistent` | `persistent` flag on `event_reminder_configs` (skip auto-cleanup for recurring events) |
| `018_warn_post_mvp` | `guild_settings.warn_expiry_days` + `warnings` expiry / evidence columns |
| `019_ticket_panels` | `ticket_panels` registry (posted panels for list/edit/delete) |
| `020_twitch` | twitch_channels table + twitch_* guild_settings columns |
| `021_gork` | `gork_*` guild_settings columns (keyword, context window, rules, search, cooldown) |
| `022_gork_access` | `gork_user_blocks` table + `gork_enabled` master switch |
| `023_gork_memory` | `gork_memories` table + `gork_memory_enabled` / `gork_memory_chars` columns |
| `024_staff_roles_added_by` | `staff_roles.added_by` provenance column (NULL = unknown) |
| `025_github_releases` | `github_watches` table (repo watches, routing, per-repo token, release pointer) |
| `026_gork_budget` | `gork_budget_rules` + `gork_usage` tables + `gork_daily_limit` column (gork daily usage budget, roadmap §7.17) |
| `027_gork_interaction_log` | `gork_interactions` table — default-on (opt-out) interaction capture (see [Gork logging](gork-logging.md)) |
| `028_web_sessions` | `web_sessions` table — opaque session ids → Discord user, sliding expiry (web console) |
| `029_admin_audit` | `admin_audit` table — one row per mutating action across web / slash / system origins |
| `030_web_session_tokens` | OAuth artifacts on sessions (access token, refresh) for per-request Discord calls |
| `031_gork_ste_enabled` | `gork_ste_enabled` guild_settings column (gork STE answer style, roadmap §7.20) |
| `032_twitch_eventsub_media` | Twitch EventSub fast-path + clips/VOD hooks (`twitch_eventsub_subs` table, clip/VOD alert columns + watermarks) |
| `033_gork_summarize_input_tokens` | `guild_settings.gork_summarize_input_tokens` (per-guild `/gork summarize` input token budget) |
| `034_communities` | Communities cutover (Fluxer PR 2): `communities` table; guild-scoped tables re-keyed `guild_id` → `community_id` in one transaction |
| `035_bridges` | Channel bridge schema: `bridges` state machine, ends, outbox, message links, snapshots, connect-attempt state |
| `036_user_links` | Account linking: `user_links` pairs + `user_link_codes` (per-direction mirror flags) |
| `037_ticket_archive_claim` | CAS archive-claim marker on `tickets` (concurrent closes can't double-archive) |
| `038_event_reminder_claim_state` | Real delivery state machine on `event_reminder_offsets` (`sending`/backoff/attempts) |
| `039_encrypt_third_party_tokens` | One-time re-encryption of GitHub PATs + command-permission OAuth tokens to the `v1.` envelope (`TOKEN_ENCRYPTION_KEY`) |
| `040_schema_hygiene` | CHECK constraints (`users.xp`, `gork_budget_rules.daily_limit`), `idx_users_guild_xp`, partial archived-ticket index, drop dead `voice_sessions` |
| `041_heal_partial_community_cutover` | One-time repair of communities left half-cutover by the 035 crash window (duplicate/discarded rows healed deterministically) |
| `042_events_core` | Community Events ([community-events.md](community-events.md)): `events`, `event_options`, `event_signups`, `event_notifications` (reminder rows), `event_activity`, `event_mutes`, `event_guild_settings` |
| `043_events_series_presets` | `event_series` (recurrence cursor) + `event_presets` / `event_preset_options` (signup presets) |
| `044_event_channels_wizards` | `event_channels` (per-channel event config incl. create-role narrowing) + `event_wizards` (DM create-wizard state) |
| `045_event_integrations` | `event_google_links` (per-user gcal OAuth tokens, `v1.` envelope) + `event_crossposts` / `event_crosspost_messages` (cross-post pipeline) |
| `046_youtube_live_pointer` | `youtube_channels.last_live_id` — dedicated live-alert pointer; live dedup no longer competes with upload bookkeeping (#378) |
| `047_youtube_checked_at` | `youtube_channels.last_checked_at` — wall-clock sweep stamp gating per-community polling intervals (#379) |
| `048_gork_log_channel` | `guild_settings.gork_log_channel_id` — dedicated gork Q&A log channel (NULL = fall back to the audit log) |
| `049_honeypot_pause` | `honeypot_paused_at` / `honeypot_pause_reason` — persisted mass-ban breaker pause (#440, F2-4) |
| `050_xp_cooldown_clamp` | pull legacy msg/reaction cooldown rows inside the 24 h clamp (#429, XE-2) |
| `051_reaction_role_claims` | `reaction_role_claims` — per-panel claim refcounts so un-reacting one panel can't strip a role another panel's claim still holds (#433, E2-09) |
| `052_ticket_create_reservations` | `ticket_create_reservations` — one-statement slot reservation makes the self-create rate limit atomic (#420, LT-3) |
| `053_retention_sweep_indexes` | sweep-lead indexes for `bridge_outbox`, `bridge_message_links`, `event_activity`, `event_notifications` (#399, B2-7) |
| `054_ucmd_day_index` | day-lead index on `user_channel_message_daily` for the global hourly daily-aggregate prune (#396, DB-4) |
| `055_gork_usage_day_index` | day-lead index on `gork_usage` for the lazy prune that runs on every gork answer (#395, DB-3) |
| `056_admin_audit_created_at_index` | global `created_at` index for the hourly `admin_audit` retention delete (#468, DB-5) |
| `057_level_role_fk` | rebuild `role_drop_state` + `guild_settings` with FKs to `communities` + the composite `level_roles` FK (`ON DELETE CASCADE`) (#469, DB-9/DB-10) |
| `058_gork_role_id` | `guild_settings.gork_role_id` — role-mention invocation for gork alongside the keyword (#174) |
| `059_twitch_sub_overrides` | per-subscription `twitch_channels.notify_channel_id` / `notify_role_id` overrides (#177) |
| `060_twitch_go_offline` | `notify_offline` opt-in + go-offline announce watermark (one post per stream) (#179) |
| `061_twitch_golive_template` | `guild_settings.twitch_golive_template` — per-guild go-live message template (NULL = built-in default) (#178) |

Current registry: **61** migrations (`PRAGMA user_version` = **61** on a
current DB — the version is the registry size, `LATEST_VERSION` in
`src/db/migrate.js`). The authoritative per-migration table with full
column/DDL notes lives in [database.md](database.md).

### Core XP API

| Function | Purpose |
|----------|---------|
| `addXp` | Atomic XP add with clamps |
| `getXp` | Read XP (the absolute `setXp` write is gone — #472 XE-8; XP changes flow through `awardXp`/`addXp`, and deterministic test seeding uses `test/helpers/xpSeed.js`) |
| `topUsers` | Leaderboard rows |
| `getGuildSettings` / `updateGuildSettings` | Per-guild config |

---

## Shared XP award (`services/awardXp.js`)

Used by message XP, reaction XP, voice ticker, and admin `/grantxp`:

1. `addXp` (atomic)
2. `logActivity`
3. Resolve member
4. `levelFromXp` → `syncMemberRoles` → `logLevelRoleChanges`

---

## Feature highlights

| Feature | Notes |
|---------|--------|
| **xp** | Cooldowns in-memory; PNG leaderboard via `render/leaderboard` |
| **voice** | Per-minute; ≥2 eligible humans; skip mute/deafen/AFK; job `voice` on `core/scheduler` |
| **decay** | Cron `0 4 * * *` (hardcoded const, evaluated in the **process timezone** — deployments pin `TZ=UTC`, see [decay.md](decay.md)); relative write against the live row (#191); re-syncs level + reaction roles; job `decay` |
| **levelRoles** | Grace-period drop via `levelRoles/sync.js`; daily sweeper job `levelrole-drop` (cron `17 5 * * *`) fires expired timers even when XP is frozen (#428) |
| **logs** | Audit + message log channels; in-memory delete cache |
| **youtube** | Data API ticker (optional `YOUTUBE_API_KEY`); guild notification channel |
| **twitch** | Helix poll (≤100 ids/req); go-live dedup by stream id; separate channel + role from YouTube |
| **githubReleases** | Hourly GitHub releases poll; per-repo channel/token; one post per release via id pointer |
| **honeypot** | Channel posts / ban-roles; warning PNG; exempt roles |
| **reactionRoles** | Bot panels, min level, removable options |
| **eventReminders** | Modal config, interest-synced roles, offset ticker, cleanup |
| **events** | `/event` + `/eventsignup`/`/eventconfig`/`/eventchannels` community events (E1–E15, [roadmap record](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/community-events.md)): DM create-wizard, button RSVP + waitlists, temp/existing attendee roles, reminders (attendee + role targets), weekly/monthly series, signup presets, scheduled posts with backoff, auto-archive, gcal sync, cross-post pairs + the web calendar (`/g/:guildId/events*`) — see [community-events.md](community-events.md) |
| **staffRoles** | `/staff` role list; junior (command gate) vs senior (ticket channel overwrites); ManageGuild for mutations |
| **staffNotes** | `/note` private staff notes (`requireStaff`) |
| **warnings** | `/warn` add/void/list; `/warn mine` public; `/setwarn` staff gate |
| **userinfo** | Staff member card; note/warn buttons; Activity tab needs **senior** staff |
| **userActivity** | Live per-channel counts; `/activityconfig` ignore/status/backfill (staff); feeds `/userinfo` Activity |
| **tickets** | Support channels, sensitive mode, panel button→modal, HTML archive HTTP; senior roles get auto ticket view |
| **music** | Lavalink `/play` `/music`; optional when `LAVALINK_HOST` unset |
| **gork** | Keyword Q&A; detached from MessageCreate; per-guild queue + budget |
| **web** | Web admin console (OAuth sign-in, guild-scoped pages, audit trail); boot feature starts the HTTP server dark-by-default — see [web-admin.md](./web-admin.md) |
| **commandPermissions** | OAuth slash visibility for `staff_roles`; HTTP callback on the public ticket server |
| **retention** | Hourly sweep pruning the growth-only tables (`activity_log`, `admin_audit`, `user_channel_message_daily`, expired `fluxer_oauth_transactions`) — `RETENTION_*` knobs, job `retentionSweeps` |
| **bridge** | Discord↔Fluxer channel pairs: webhook copies + durable outbox (CAS claim), source-side edit/delete relay, SSRF-guarded media — jobs `bridge-relay` + `bridge-relay-ttl` |
| **linking** | One Discord ↔ one Fluxer identity (`!link` codes), per-direction XP/roster mirroring; link-code sweeper job |

Tickers (voice, youtube, twitch, twitch-eventsub, githubReleases, eventReminders, events (due posts, reminders, series cursor, auto-archive, cleanup — one `events` cron job with named steps), warnings expiry, decay, honeypot sweep, XP cooldown sweep, audit message-cache, retention sweeps, link-code sweeper, bridge relay + TTL) register named jobs on `src/core/scheduler.js`. The scheduler skips overlapping runs, always logs tick failures as `[scheduler] <name> tick failed:`, and exposes `snapshot()` (`lastTickAt`, `intervalMs`, `running`) for dashboards. Feature `start()` still decides *whether* a job is armed (e.g. YouTube skips without `YOUTUBE_API_KEY`). Invoke `runVoiceTick` / `runYoutubeTick` / … directly in tests — do not start timers.

---

## Commands

Slash builders and handlers are **co-located** on features. The registry exports the slash commands (unique names — the current count is asserted in `test/registry.test.js`; every name has a tier in `core/commandVisibility.js` — see `test/command-visibility.test.js`). Registration:

```bash
npm run register   # node src/commands/register.js
```

- `DEV_GUILD_ID` set → that guild only (instant)
- else → every guild the bot is in

Router: `commands/router.js` → autocomplete / modal submit / button / chat input → channel restriction (chat) → handler.

### Access gates (`core/permissions.js`)

| Gate | Meaning |
|------|---------|
| **Public** | No staff check: `/xp`, `/leaderboard`, `/warn mine`, `/ticket create` (and panel open), `/play`, `/music`, `/link` (account pairing). `/eventreminder` opt-out/status (and create for event creators). |
| **Staff** (`requireStaff` / `isStaff`) | ManageGuild **or** any `staff_roles` role — notes, warnings, tickets (incl. panel/set*), activity config, honeypot channel/banrole, XP/YouTube/Twitch/decay/logs/reaction-roles, `/userinfo` (except Activity), most config |
| **Senior staff** (`requireSeniorStaff` / `isSeniorStaff`) | ManageGuild **or** a **senior** `staff_roles` role — `/userinfo` Activity; senior roles also receive automatic ticket channel overwrites (junior = command gate only, no auto ticket view) |
| **ManageGuild-only** (`requireAdmin` / `isAdminOrMod`) | **`/grantxp`**; staff-role add/remove/setlevel; **`/staff syncpermissions`**; **`/setcommandchannel`**; **`/honeypot exempt`** (staff-role alias) |

`/setcommandchannel` is ManageGuild-only and always allowed for admins even when command channels are restricted (lockout escape). `/ticket` inside an open (or soft-closed, not archived) ticket channel bypasses the command-channel allow-list.

**Slash picker visibility** (`src/core/commandVisibility.js` + `src/features/commandPermissions/`): staff-tier commands register with ManageGuild `defaultMemberPermissions`. Optional OAuth (`/staff syncpermissions`, scope `applications.commands.permissions.update`) writes Discord role allow overwrites for `staff_roles` so staff without Manage Server see those commands. Public and admin-tier commands are not overwritten. Handlers remain authoritative.

---

## Error & safety strategy

- Cooldown violations: silent skip
- Permission denied: ephemeral reply
- Interaction errors: `safeErrorReply` (ephemeral)
- XP: clamp deltas/totals to JS-safe range; award events capped at `MAX_XP_AWARD` (1e9)
- SQL: prepared statements only

---

## Testing Strategy

```bash
npm test                 # unit + integration (node --test)
npm run test:unit        # test/*.test.js
npm run test:integration # test/integration/*.test.js
npm run test:e2e         # tier-4: real bot vs pinned fauxcord mock Discord (mock must be started first)
```

Unit coverage includes `core/xpMath`, cooldowns, scheduler, db layer (temp DB), event reminder helpers, tickets helpers, and command registry (commands × features — both counted, not hardcoded, in `test/registry.test.js`). Integration tests exercise pipelines and feature flows offline with real SQLite and mocked Discord I/O. The tier-4 E2E suite (`test/e2e/*.test.js`) boots the real bot against the fauxcord mock — `scripts/e2e/start-mock.sh` first; topology, CI queue, and per-suite coverage in [e2e.md](e2e.md).

---

## Operator notes

- Env: `DISCORD_TOKEN` or `FLUXER_INSTANCES` (one credential minimum); `CLIENT_ID` recommended — boot `[config] WARN`s without it, and registration/OAuth/web sign-in need it; optional `DEV_GUILD_ID`, `DATA_DIR`, `DB_PATH`, `TZ` (compose pins UTC for the decay cron — see [configuration.md](./configuration.md))
- YouTube (optional): `YOUTUBE_API_KEY` — see [youtube-notifications.md](./youtube-notifications.md)
- Twitch (optional): `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` — see [twitch-notifications.md](./twitch-notifications.md)
- Tickets (optional): `TICKET_HTTP_PORT`, `TICKET_PUBLIC_BASE_URL`, `TICKET_MAX_ASSET_BYTES`, `TICKET_MAX_ASSETS`; AI close summaries: `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` — see [tickets.md](./tickets.md)
- Web console (optional): `PUBLIC_HTTP_PORT`, `PUBLIC_BASE_URL` (+ `CLIENT_SECRET` for OAuth login) — see [web-admin.md](./web-admin.md)
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
| `commands/definitions.js` | per-feature definitions under `src/features` (empty stub) |
| `commands/handlers.js` | per-feature handlers under `src/features` (no-op stub) |

Prefer importing feature/canonical paths in new code.

**Deprecation status (audit #206).** The twelve shims above `db.js` have zero
importers in `src/` or `test/` — they exist only for external scripts. Deleting
them needs a major release (the repo is 1.x), so each now logs a one-time
`[deprecation] <file> is deprecated and will be removed in v2 — use <target>`
warning on first require (`core/deprecation.js`; once per process, pinned by
`test/deprecation.test.js`). **v2.0 removes these files and the helper
together.** `db.js` is not deprecated: 40+ internal consumers keep it as the
stable facade.
