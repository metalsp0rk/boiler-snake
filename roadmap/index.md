# Boiler Snake Roadmap

> ✅ **Fully implemented features are archived in [index-completed.md](index-completed.md).**
> A feature moves there once it is shipped with **zero open items** in its feature
> file (currently: Scheduled Event Reminders, Staff Notes, Warnings, the
> Web Admin Console, plus the XP & leaderboard polish). This file tracks
> everything still open or planned.

## Project Overview

Boiler Snake is a Discord bot for XP tracking, voice activities, YouTube notifications, Twitch stream notifications, role management, honeypots, scheduled-event reminders, staff notes, guild staff roles, user warnings, help tickets, and music playback — with multi-platform reach to self-hosted Fluxer instances (text-command surface, see [fluxer.md](fluxer.md); live channel bridge between Discord and Fluxer channels, see [bridge.md](bridge.md)). Planned next: bot-owned community events with button RSVP, copied from Apollo’s feature set ([community-events.md](community-events.md)). This roadmap documents **planned** features and their implementation stages; completed features are archived in [index-completed.md](index-completed.md).

**Shipped (user docs in `docs/`; completed-feature records in [index-completed.md](index-completed.md) §7; rows for features with open work below):** XP/leveling, voice XP, decay, level roles, reaction roles, YouTube notifications, Twitch stream notifications (go-live MVP + EventSub fast path + clips/VOD alerts), command-channel restrictions, audit/message logs, honeypot channels & ban roles, scheduled event reminders, guild staff roles (`staff_roles` / `requireStaff`), staff notes, warnings, user activity tracking (`/userinfo` Activity + `/activityconfig`), help tickets (MVP), music player (`/play` via Lavalink + Spotify catalog), Fluxer multi-platform endpoints (text-command surface: prefix commands, XP, reactions, notification tickers, web-admin login — voice XP and elevated actions stay flag-gated, see [fluxer.md](fluxer.md)), channel bridge (Discord ↔ Fluxer live relay: text, files, source-side edits/deletes — see [bridge.md](bridge.md)).

## Feature Index

Each feature has its own file with the full design, status, and locked decisions. Cross-feature tracking (this index, the migration summary, and post-MVP TODOs) stays here — or in [index-completed.md](index-completed.md) once a feature fully ships. When updating a feature, edit its file; update the status table below when its status changes; when the last checkbox in a shipped feature's file gets ticked, move its row (and its §7/§8 blocks) to [index-completed.md](index-completed.md).

| # | Feature | File | Status | Open items |
|---|---------|------|--------|------------|
| 1 | Help Ticket System | [help-tickets.md](help-tickets.md) | Shipped (MVP + panel) | Richer `/ticket list` filters (OAuth-on-transcripts closed — shipped via [web-admin.md](web-admin.md) §8.4) |
| 3 | Twitch Stream Notifications | [twitch-notifications.md](twitch-notifications.md) | Shipped (MVP + EventSub + clips/VODs) | Per-channel overrides; templates; go-offline messages |
| 4 | Guild Staff Roles (Admin Gate) | [staff-roles.md](staff-roles.md) | Shipped | Capability flags beyond junior/senior |
| 7 | Gork (AI Keyword Q&A) | [gork.md](gork.md) | Shipped | Open fixes in [gork.md §7.15](gork.md): reply/`@user`-message crash repro triage; input policy (pass-through) + no-tables rule **closed & shipped** ([decisions 42–43](gork.md)); per-scope daily usage budget **shipped** (migration `026`; [gork.md §7.17](gork.md)); `read_discord` linked message/channel reader **shipped** ([gork.md §7.19](gork.md)); STE anti-slop answer style **shipped 2026-09-28** ([gork.md §7.20](gork.md)); `/gork summarize` conversation rundown **shipped — decisions 53–57 locked 2026-09-27** ([gork.md §7.21](gork.md)) |
| 9 | Fluxer (Discord + Fluxer endpoints) | [fluxer.md](fluxer.md) | **Shipped (v1.30.0 / v1.30.1, 2026-09-30 → 10-01)** | Live-verification items in [fluxer.md § Phase 0 open items](fluxer.md): voice-state capture, ban 204 on a non-owner, MFA capture, 429 bodies, presigned chunked flow, live OAuth exchange (voice XP + elevated actions stay flag-gated off until recorded) |
| 10 | Channel bridge (Discord ↔ Fluxer) | [bridge.md](bridge.md) | **Shipped (v1.31.0, 2026-10-01 → 10-02)** | Docs-only spike follow-ups in [bridge.md § 10.14](bridge.md): B1 mfa_level-1 MFA run, B12 avatar CDN template (relay omits avatars until recorded), B14 `#name` chip capture; relay worker → web ticker-health UI wiring |
| 12 | Community Events (Apollo-style) | [community-events.md](community-events.md) | **Planned (2026-10-09)** | Not started. Primary create path is `/event`, including a DM wizard ([§12.6](community-events.md)). Reminders follow those signups. `/eventreminder` retires after parity ([§12.7](community-events.md)). |

Completed features (**2** Scheduled Event Reminders, **5** Staff Notes, **6** Warnings, **8** Web Admin Console) live in [index-completed.md](index-completed.md) — original numbers are kept for cross-reference.

Review findings and small fixes (docs, tests, roadmap hygiene) are tracked as a work-as-time-allows backlog in [wishlist.md](wishlist.md) — feature files stay authoritative for design.

**Open items follow the same authority rule:** the feature files' checkboxes are the single source — the *Open items* cells here and the §8 bullets below hold only short summaries that link to the right section (e.g. "see [gork.md §7.15](gork.md)"), never restatements of multi-part open work, because parallel copies are what rot. Update the feature file first and trim the mirror to fit; genuinely short, unambiguous one-liners may stay.

---

## 7. Database Migration Summary

### Guild staff roles (admin gate)

| Table / change | Notes |
|----------------|-------|
| `staff_roles` | Generalized from `honeypot_exempt_roles` — legacy rows folded in + legacy table dropped (**shipped**, migration `008`; fresh DBs create `staff_roles` directly in `001`). Base columns `guild_id`, `role_id`, `created_at`, PK |
| `staff_roles.level` | junior \| senior tier; existing rows defaulted **senior** (**shipped**, migration `011`) — senior adds ticket-channel overwrites + `/userinfo` Activity; the staff gate accepts both levels |
| `staff_roles.added_by` | Provenance — actor user id on add; NULL on pre-migration rows (**shipped**, migration `024`) |
| `guild_command_permission_oauth` | OAuth tokens + last-sync state for `/staff syncpermissions` slash-command visibility (**shipped**, migration `016`) |
| — | No per-feature access-role tables for notes/warns/tickets |

### Tickets

| Table / change | Notes |
|----------------|-------|
| `tickets` | Lifecycle, sensitive flag, UUID transcript token, `archived` |
| `ticket_members` | Extra member participants |
| `ticket_staff` | Named staff allow-list on a ticket (sensitive / extras) — **not** the guild staff role list |
| `ticket_messages` | Only for fully archived (non-sensitive) tickets |
| `ticket_panels` | Stored panel registry — posted **Open ticket** panels (channel, message id, title/description) backing `/ticket panel create\|list\|edit\|delete` (**shipped**, migration `019`) |
| `guild_settings.ticket_*` | category, archive channel, rate limit (**no** `ticket_staff_role`) |

### Twitch stream notifications

| Table / change | Notes |
|----------------|-------|
| `twitch_channels` | Per-guild broadcaster subscriptions + live/stream dedup state (**shipped**, migration `020`) |
| `guild_settings.twitch_notification_channel_id` | Go-live Discord channel (**shipped**) |
| `guild_settings.twitch_notify_role_id` | Optional ping role (≠ YouTube roles) (**shipped**) |
| `guild_settings.twitch_polling_interval_minutes` | Poll interval (default 2) (**shipped**) |
| `twitch_channels.notify_clips` / `notify_vods` + `last_clip_*` / `last_video_*` | Per-subscription clip/VOD alerts + watermarks (**shipped**, migration `032`) |
| `twitch_eventsub_subs` | Bot's EventSub webhook subscriptions (type+broadcaster → id/status) (**shipped**, migration `032`) |

### Gork (AI keyword Q&A)

| Table / change | Notes |
|----------------|-------|
| `guild_settings.gork_keyword` | Trigger keyword (default `@gork`; `NULL` = disabled) (**shipped**, migration `021`) |
| `guild_settings.gork_context_window` | Prior-message context size; default `10` (**shipped**) |
| `guild_settings.gork_extra_rules` | Staff prompt additions, ≤500 chars (**shipped**) |
| `guild_settings.gork_search_enabled` | SearXNG `web_search` tool toggle; default `1` (**shipped**) |
| `guild_settings.gork_cooldown_sec` | Per-user cooldown seconds; default `180`, staff bypass (**shipped**) |
| `gork_user_blocks` | Per-guild gork ban list — `guild_id`+`user_id` PK, `created_by`, `created_at` (**shipped**, migration `022`) |
| `guild_settings.gork_enabled` | Master server switch; `0` = fully silent (**shipped**, migration `022`) |
| `gork_memories` + `guild_settings.gork_memory_enabled` / `gork_memory_chars` | Community memory (**shipped**, migration `023`) — memories keyed `(guild, person, date, title_key)` (key fields server-stamped); per-person cap + eviction; **off** by default; bodies-or-index block budget default 12,000 ([gork.md §7.16](gork.md)) |
| `guild_settings.gork_daily_limit` + `gork_budget_rules` + `gork_usage` | Per-scope daily usage budget — tri-state limit (`-1` blocked / `0` unlimited / cap), channel → category → guild-default precedence, enqueue+dequeue checks, success-only counting (**shipped**, migration `026`; [gork.md §7.17](gork.md)) |

Event reminders, staff notes, warnings, and web admin console migration tables: see [index-completed.md §7](index-completed.md).

### Community events (planned)

Schema sketch and the “reserve the next free migration id” rule: [community-events.md](community-events.md). No migration until phase 1. Highest shipped id on 2026-10-09 is `036`. New signup tables are not an extension of `event_reminder_*`. Guild opt-out keeps using `event_reminder_optouts` until `/eventreminder` retires.

---

## 8. Post-MVP TODOs

> **Status: convenience mirror.** Feature files are authoritative for open items (rule above) — where a feature file exists, the open bullets below stay short summaries linking to the right section; the shipped blocks document landed work and stay as-is. Work with no feature file (the XP & leaderboard polish) is fully landed and recorded in [index-completed.md §8](index-completed.md).

### Guild staff roles

- [ ] Optional capability flags per role beyond **junior | senior** — short open list in [staff-roles.md §4.8](staff-roles.md)  
- [x] `level` junior/senior tier (migration `011`) — `/staff role add` takes a required `level`, `/staff role setlevel` flips it; **senior** rows alone get ticket channel overwrites (`listSeniorStaffRoles` in `overwrites.js`) and `/userinfo` Activity (`requireSeniorStaff`)  
- [x] `/staff syncpermissions` + OAuth slash-visibility sync (migration `016`, `src/features/commandPermissions/`) — ManageGuild picker defaults kept + per-guild allow overwrites for staff roles; auto-resync on role changes (see [staff-roles.md §4.4](staff-roles.md))  
- [x] `added_by` column on `staff_roles` (migration `024`) — recorded on add via upsert (COALESCE keeps provenance), shown in `/staff role list`  
- [x] Audit embed when staff roles are added/removed/leveled — `logConfigChange` in `src/features/staffRoles/index.js` (also on the `/honeypot exempt` alias paths)  

### Tickets

- [x] Panel message + button → modal for ticket description  
- [x] **Fix (shipped):** ticket create warned “`N` staff role(s) could not get channel access” even when the bot role is above staff roles — `getManageableStaffRoleIds` now resolves roles via `guild.roles.fetch` on cache miss, skips a role the bot itself holds silently, and lists per-role name + reason in the note (see [help-tickets.md §1.11](help-tickets.md))  
- [x] **Fix (shipped):** on archive, DM the requester the transcript link (non-sensitive tickets only) in addition to posting the archive-channel embed — revises locked decision 3 (see [help-tickets.md §1.11](help-tickets.md))  
- [x] Login with Discord on transcript HTTP routes (shipped via [web-admin.md](web-admin.md) §8.4 / tasks 15.9 + 15.13)  
- [x] Download/mirror all attachments into transcript storage at archive time (replace hotlinks)  
- [ ] Richer `/ticket list` filters  
- [x] Stored panel registry (list/edit/delete via commands)  

### Twitch stream notifications

- [x] MVP: multi-channel go-live alerts via Helix polling; `/twitch add|remove|list`; `/settwitch channel|role|interval|settings`; stream-id dedup  
- [x] Twitch EventSub webhooks as push fast path (`POST /hooks/twitch`, HMAC + hourly reconcile; polling kept as fallback, claim-first dedup; migration `032`)  
- [x] Clips/VOD alerts — `/twitch clips` / `/twitch vod` per-subscription opt-in (default off; archive VODs only; `032` watermarks)  
- [ ] Per-channel Discord channel or role overrides  
- [ ] Custom go-live message templates  
- [ ] Optional go-offline message (default off)

### Gork

- [x] **Fix (shipped):** raw `<@id>` markup in gork replies — `sanitizeAnswer()` rewrites mention tokens to display names and replies send `allowedMentions: { parse: [] }` (no unintended pings); **embed-based** "chip" rendering **rejected** — decision 11 (plain text) stands (see [gork.md §7.15](gork.md))  
- [x] **Fix (shipped):** user roster in the generation context — `src/features/gork/roster.js` (`id | @handle | display name (nickname)`; asker + authors + mentions) (see [gork.md §7.15](gork.md))  
- [ ] **Fix (triage, open):** reported crash on reply / `@user`-mention messages — still no live crash evidence captured; evidence list, fixed surface, and repro matrix are tracked in [gork.md §7.15](gork.md) (Fix 3)  
- [x] **Fix (shipped):** special-character safety in chunking/truncation — `safeCutIndex`/`sliceSafe` code-point cuts + `pullBeforeTokens` token-aware chunks + capped context slices (see [gork.md §7.15](gork.md))  
- [x] **Policy (closed & shipped 2026-09-16):** Fix 4 closed — answer markdown stays as-is; input policy = **pass-through**; tables → base-prompt no-tables line shipped (locked decisions 42–43; see [gork.md §7.15](gork.md), Fix 4)  
- [x] **Feature (shipped):** gork community memory — per-person durable facts keyed **(person, date, title_key)** with server-stamped key fields; bodies-or-index MEMORY BLOCK per trigger (asker + mentioned + talked-about via the Fix 2 roster) under `gork_memory_chars`, `recall_memories` tool on overflow, post-send extraction turn after reply+audit+slot-release, staff-only `/gork memory show|forget|clear|on|off|budget` (locked decisions 25–29, migration `023`, default **off**; see [gork.md §7.16](gork.md))
- [x] **Feature (shipped 2026-09):** per-scope daily usage budget — per-user X successful answers/day per channel/category (guild-default fallback, tri-state `-1/0/cap`), success-only counting, enqueue+dequeue no-overage checks (locked decisions 30–37, migration `026`, `/gork budget` command family; see [gork.md §7.17](gork.md))
- [x] **Feature (shipped 2026-09):** `read_discord` tool — read a linked message (anchor + 40 before / 10 after) or channel (50 latest) via one tool call; guild isolation, asker ViewChannel parity, open-ticket blackout (locked decisions 44–48; see [gork.md §7.19](gork.md))
- [x] **Feature (shipped 2026-09-28):** STE answer style — toggle-able anti-slop writing-system card (`/gork ste`, migration `031`, default off) so answers read like a person, not a slop factory; flavored mode keeps the persona; linter + repair loop deferred (locked decisions 49–52; see [gork.md §7.20](gork.md))
- [x] **Feature (shipped 2026-09-27):** `/gork summarize` conversation rundown — staff pick a range in one of three modes (`from`+`to`, `from`→now, `last:<N>`≤1000) with optional `focus:`/`lang:` steering; gork reads it (decision-46 security; bots labeled, system messages skipped; clamp-and-disclose) and posts a digest **as an embed** (one message, no chunk wall) with a per-guild 10-minute success-armed cooldown; V2 (Discourse forum posting) stays recorded-but-unbuilt in the design (locked decisions 53–57; see [gork.md §7.21](gork.md))

### Fluxer (multi-platform endpoints)

- [x] **Shipped 2026-09-29 → 10-01 (v1.30.0 / v1.30.1).** All eleven PRs from [fluxer.md](fluxer.md) landed: `src/platform/` (shared `CommandContext`/community/snowflake core, `discord/` + `fluxer/` adapters), migration `034_communities`, `@fluxerjs/core@3.1.0`, web-admin Fluxer login (dual-cookie session split), operator page `docs/fluxer.md`. The migration-id plan held: `031` stayed with gork STE; communities shipped as `034`. Remaining live-verification items (voice, MFA/elevated, ban-204, 429 bodies, presigned uploads, OAuth exchange) stay open in [fluxer.md § Phase 0 open items](fluxer.md).

### Channel bridge (Discord ↔ Fluxer)

- [x] **Shipped 2026-10-01 → 10-02 (v1.31.0).** All eight PRs from [bridge.md](bridge.md) landed: spike script + Phase 0 results recorded live on the operator instance (2026-10-02; 11 PASS / 3 DOC, no PENDING → KD 21 closed), schema `035_bridges` + repository/codes/expiry, adapter deltas (normalized DM ingestion, `fetchMessage`, webhook lifecycle), `src/features/bridge/` service + `/bridge` + pipeline gates, media spool + at-least-once worker, edit/delete relay, activation (Fluxer `!bridge` prefix, DM connect, `BRIDGE_ENABLED`), operator page `docs/bridge.md`. The migration-id plan held: bridge shipped as `035`; `031` stayed with gork STE.
- [ ] **Open (docs-only by design):** spike follow-ups — B1 `TWO_FACTOR_REQUIRED` run against an mfa_level-1 community, B12 Fluxer avatar CDN template (relay omits avatars until recorded), B14 `#name` chip serialization capture (see [bridge.md § 10.14](bridge.md) open follow-ups); relay worker health wiring into the web ticker-health UI (§ Observability).

### Community events (Apollo-style)

- [ ] Not started. Bot-owned `/event` is the primary create path, including the DM wizard ([community-events.md §12.6](community-events.md)). Reminders follow button signups and share feature 2’s opt-out. `/eventreminder create` retires after the parity list in [§12.7](community-events.md).
