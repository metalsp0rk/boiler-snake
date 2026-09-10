# Boiler Snake Roadmap

## Project Overview

Boiler Snake is a Discord bot for XP tracking, voice activities, YouTube notifications, Twitch stream notifications, role management, honeypots, scheduled-event reminders, staff notes, guild staff roles, user warnings, help tickets, and music playback. This roadmap documents **planned** features and their implementation stages.

**Shipped (see docs, not tracked here):** XP/leveling, voice XP, decay, level roles, reaction roles, YouTube notifications, Twitch stream notifications (go-live MVP), command-channel restrictions, audit/message logs, honeypot channels & ban roles, scheduled event reminders, guild staff roles (`staff_roles` / `requireStaff`), staff notes, warnings, help tickets (MVP), music player (`/play` via Lavalink + Spotify catalog).

## Feature Index

Each feature has its own file with the full design, status, and locked decisions. Cross-feature tracking (this index, the migration summary, and post-MVP TODOs) stays here. When updating a feature, edit its file; update the status table below when its status changes.

| # | Feature | File | Status | Open items |
|---|---------|------|--------|------------|
| 1 | Help Ticket System | [help-tickets.md](help-tickets.md) | Shipped (MVP + panel) | Fix staff-role skip note on create; DM transcript link to requester on archive; Discord OAuth on transcripts (→ covered by [web-admin.md](web-admin.md) §8.4); richer `/ticket list` filters |
| 2 | Scheduled Event Reminders | [event-reminders.md](event-reminders.md) | Shipped | — |
| 3 | Twitch Stream Notifications | [twitch-notifications.md](twitch-notifications.md) | Shipped (MVP) | EventSub; per-channel overrides; templates; go-offline; clips/VODs |
| 4 | Guild Staff Roles (Admin Gate) | [staff-roles.md](staff-roles.md) | Shipped | Capability flags; `added_by`; audit embeds |
| 5 | Staff Notes System | [staff-notes.md](staff-notes.md) | Shipped | — |
| 6 | Warning System | [warnings.md](warnings.md) | Shipped (MVP + polish) | — |
| 7 | Gork (AI Keyword Q&A) | [gork.md](gork.md) | Shipped | Embed-based mention rendering (deferred — §7.15 Fix 1, would revise decision 11); live repro for the reply / `@user`-message crash triage (§7.15 Fix 3); markdown hygiene + zero-width/bidi input policy (§7.15 Fix 4) |
| 8 | Web Admin Console (panel overhaul) | [web-admin.md](web-admin.md) | Planned (design v2) | Phases 0a–3; login-mandatory transcripts |

Review findings and small fixes (docs, tests, roadmap hygiene) are tracked as a work-as-time-allows backlog in [wishlist.md](wishlist.md) — feature files stay authoritative for design.

---

## 7. Database Migration Summary

### Guild staff roles (admin gate)

| Table / change | Notes |
|----------------|-------|
| `honeypot_exempt_roles` → `staff_roles` | Rename only; same columns (`guild_id`, `role_id`, `created_at`, PK). Existing exempt rows become staff roles. |
| — | No per-feature access-role tables for notes/warns/tickets |

### Tickets

| Table / change | Notes |
|----------------|-------|
| `tickets` | Lifecycle, sensitive flag, UUID transcript token, `archived` |
| `ticket_members` | Extra member participants |
| `ticket_staff` | Named staff allow-list on a ticket (sensitive / extras) — **not** the guild staff role list |
| `ticket_messages` | Only for fully archived (non-sensitive) tickets |
| `guild_settings.ticket_*` | category, archive channel, rate limit (**no** `ticket_staff_role`) |

### Event reminders

| Table / change | Notes |
|----------------|-------|
| `event_reminder_configs` | Event ↔ role ↔ channel ↔ template (**shipped**, migration `006`) |
| `event_reminder_event_optouts` | Per-event mute (**shipped**, migration `015`) |
| `event_reminder_offsets` | Each “X before” fire + sent state (**shipped**) |
| `event_reminder_optouts` | Per-guild user opt-out (**shipped**) |
| `guild_settings.event_reminder_channel_id` | Default notify channel (**shipped**) |

### Twitch stream notifications

| Table / change | Notes |
|----------------|-------|
| `twitch_channels` | Per-guild broadcaster subscriptions + live/stream dedup state (**shipped**, migration `020`) |
| `guild_settings.twitch_notification_channel_id` | Go-live Discord channel (**shipped**) |
| `guild_settings.twitch_notify_role_id` | Optional ping role (≠ YouTube roles) (**shipped**) |
| `guild_settings.twitch_polling_interval_minutes` | Poll interval (default 2) (**shipped**) |

### Staff notes

| Table / change | Notes |
|----------------|-------|
| `staff_notes` | Per-guild sequential notes; soft-delete; edit metadata (**shipped**) |

### Warnings

| Table / change | Notes |
|----------------|-------|
| `warnings` | Permanent rows; void metadata; optional `related_note_id` → `staff_notes` (**shipped**, migration `009`) |
| `warnings.expires_at` / evidence columns | Opt-in expiry + staff evidence (**shipped**, migration `017`) |
| `guild_settings.warn_dm_members` | Default `1` — DM subject on issue/void (**shipped**) |
| `guild_settings.warn_log_channel_id` | Dedicated warn issue/void log; audit fallback (**shipped**) |
| `guild_settings.warn_expiry_days` | Default `0` (never); guild default for new warnings (**shipped**, migration `017`) |

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

### Web admin console (planned)

| Table / change | Notes |
|----------------|-------|
| `web_sessions` | DB-backed login sessions; cookie carries opaque id only (**planned**, migration `024` — `023` shipped as `gork_memory`) |
| `admin_audit` | Queryable mutation trail, `origin` = web/slash/system; channel embeds stay mirrors (**planned**, migration `025`) |
| `tickets` / `ticket_members` / `ticket_staff` / `ticket_messages` | Reused as-is for transcript participant access — **no schema change** (**planned**) |

**Removed from roadmap as standalone product:** Honeypot feature (implemented — see `docs/honeypot.md`). Exempt roles are **absorbed** into guild staff roles (§4).

---

## 8. Post-MVP TODOs

### XP & leaderboard polish

Both slash surfaces below are now shipped; the checkboxes document the work that landed.

#### `/setxp` — expose `level_xp_factor`

**Shipped.** `guild_settings.level_xp_factor` (default `100`) is now exposed as the `factor` option on `/setxp`.

- [x] Add optional integer option `factor` on `/setxp`, min **1**, max **10000**
- [x] Persist via `updateGuildSettings`; included in `/setxp` audit `logConfigChange` payload
- [x] Reply shows before/after factor and a one-line reminder of the formula (`L² × factor` XP for level L)
- [x] Unit/integration: set factor → `/xp` level and leaderboard level labels match new curve
- [x] Update [docs/commands](../docs/commands/index.md), [configuration](../docs/configuration.md), [xp-and-leveling](../docs/xp-and-leveling.md), FAQ

**Out of scope:** per-user curve overrides; non-sqrt formulas.

#### `/leaderboard` — honor `limit` + pagination

**Shipped.** `limit` is the page size (default **10**, min **1**, max **20**). `renderLeaderboardPng` renders a dynamic row count (1–20), and each message gets **◀ Prev / Next ▶** buttons so the caller can page through the whole list. Paging is caller-only, re-queries current XP on every click, and re-fetches `limit × page + 1` rows to detect the last page (no count query). See [docs/leaderboard.md](../docs/leaderboard.md).

- [x] Read `interaction.options.getInteger("limit")` with clamp (default **10**, min **1**, max **20**)
- [x] Pass clamped limit into `topUsers(guildId, n)` (per page: `limit × page + 1`)
- [x] Resize PNG layout (`render/leaderboard.js`) for `n` rows (dynamic height, 1–20 rows)
- [x] Message content: `**Leaderboard — ranks first–last**` reflecting the applied page
- [x] Integration tests: 12 seeded users; page 2 shows ranks 11–12; prev/next button states; caller-only; customId parse/clamp unit cases
- [x] Update [docs/commands](../docs/commands/index.md) and [leaderboard](../docs/leaderboard.md) (removed “limit unused” note)

**Out of scope:** jump-to-page input; ephemeral vs public toggle.

### Guild staff roles

- [ ] Optional capability flags per role (warn-only, config-only, …) — MVP is full admin-gate equivalence  
- [ ] `added_by` column on `staff_roles`  
- [ ] Audit embed when staff roles are added/removed  

### Tickets

- [x] Panel message + button → modal for ticket description  
- [ ] **Fix:** ticket create warns “`N` staff role(s) could not get channel access” even when the bot role is above staff roles — make `getManageableStaffRoleIds` resilient (fetch role on cache miss, don't count roles the bot itself holds as skipped) and show per-role name + reason in the note (see [help-tickets.md §1.11](help-tickets.md))  
- [ ] **Fix:** on archive, DM the requester the transcript link (non-sensitive tickets only) in addition to posting the archive-channel embed — revises locked decision 3 (see [help-tickets.md §1.11](help-tickets.md))  
- [ ] Login with Discord on transcript HTTP routes  
- [x] Download/mirror all attachments into transcript storage at archive time (replace hotlinks)  
- [ ] Richer `/ticket list` filters  
- [x] Stored panel registry (list/edit/delete via commands)  

### Event reminders

- [x] Richer templates / embed reminders (always embed + placeholders `{url}` `{description}` `{offset}`)  
- [x] Per-event mute (`/mute` / `/unmute`; guild `/optout` still wins)  
- [x] Auto-suggest shortname from event title (+ collision suffix `-2`…)  
- [x] **Fix:** `/eventreminder create`/`edit` modal exceeded Discord's 5-component limit — dropped the `persistent` select from the modal (back to 5); create now takes an optional `persistent` boolean (encoded in the modal customId `:p1`) and a **♾️ Recurring: on/off** button on the create/edit confirmation toggles it for either flow (see [event-reminders.md §2.12](event-reminders.md))  

### Twitch stream notifications

- [x] MVP: multi-channel go-live alerts via Helix polling; `/twitch add|remove|list`; `/settwitch channel|role|interval|settings`; stream-id dedup  
- [ ] Twitch EventSub (webhook or conduit) instead of / in addition to polling  
- [ ] Per-channel Discord channel or role overrides  
- [ ] Custom go-live message templates  
- [ ] Optional go-offline message (default off)  
- [ ] Clip / VOD hooks (out of scope for stream-live MVP)  

### Staff notes

- [x] Guild-wide recent notes feed without targeting a user (`/note list` without `user`)  
- [x] Attach note from ticket close flow (`staff_note` option + **Add staff note** button → modal)  
- [x] Content modal for long notes (omit slash `content` on add/edit; max 2000)  
- [x] Wire access to full staff roles once §4 ships (`isStaff` already the call site)  

### Warnings

- [x] MVP: issue / list / info / void / count / mine + `/setwarn dm` + audit + optional note link  

- [x] Dedicated `warn_log_channel_id` separate from general audit log (`/setwarn log`; falls back to audit)  
- [x] Warning expiry / auto-void after N days (opt-in; default still permanent) — guild `/setwarn expiry` + per-warn `expires_days`  
- [x] Export user record (notes + warnings) for staff handoff — `/warn export` ephemeral `.md`  
- [x] ~~Un-void / re-activate~~ — **skipped**; prefer re-issue (no un-void command)  
- [x] Evidence: message jump link + freeform staff-only notes on `/warn add` (not in member DM / `/warn mine`)

### Gork

- [x] **Fix (shipped):** raw `<@id>` markup in gork replies — `sanitizeAnswer()` rewrites mention tokens to display names and replies send `allowedMentions: { parse: [] }` (no unintended pings); **embed-based** "chip" rendering stays **deferred** (would revise locked decision 11 → needs decision 24; see [gork.md §7.15](gork.md))  
- [x] **Fix (shipped):** user roster in the generation context — `src/features/gork/roster.js` (`id | @handle | display name (nickname)`; asker + authors + mentions) (see [gork.md §7.15](gork.md))  
- [ ] **Fix (triage, open):** reported crash on reply / `@user`-mention messages — hang-read-as-crash fixed (20s context deadline, deleted/forwarded-reference fixtures), but **no live crash evidence captured yet**; keep collecting the real stack + payload (see [gork.md §7.15](gork.md))  
- [x] **Fix (shipped):** special-character safety in chunking/truncation — `safeCutIndex`/`sliceSafe` code-point cuts + `pullBeforeTokens` token-aware chunks + capped context slices (see [gork.md §7.15](gork.md))  
- [ ] **Fix (open):** markdown hygiene (balance/escape fences, spoilers, emphasis) + zero-width / bidi / homoglyph input policy (see [gork.md §7.15](gork.md))  
- [x] **Feature (shipped):** gork community memory — per-person durable facts keyed **(person, date, title_key)** with server-stamped key fields; bodies-or-index MEMORY BLOCK per trigger (asker + mentioned + talked-about via the Fix 2 roster) under `gork_memory_chars`, `recall_memories` tool on overflow, post-send extraction turn after reply+audit+slot-release, staff-only `/gork memory show|forget|clear|on|off|budget` (locked decisions 25–29, migration `023`, default **off**; see [gork.md §7.16](gork.md))

