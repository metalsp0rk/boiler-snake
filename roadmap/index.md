# Boiler Snake Roadmap

## Project Overview

Boiler Snake is a Discord bot for XP tracking, voice activities, YouTube notifications, Twitch stream notifications, role management, honeypots, scheduled-event reminders, staff notes, guild staff roles, user warnings, help tickets, and music playback. This roadmap documents **planned** features and their implementation stages.

**Shipped (see docs, not tracked here):** XP/leveling, voice XP, decay, level roles, reaction roles, YouTube notifications, Twitch stream notifications (go-live MVP), command-channel restrictions, audit/message logs, honeypot channels & ban roles, scheduled event reminders, guild staff roles (`staff_roles` / `requireStaff`), staff notes, warnings, help tickets (MVP), music player (`/play` via Lavalink + Spotify catalog).

## Feature Index

Each feature has its own file with the full design, status, and locked decisions. Cross-feature tracking (this index, the migration summary, and post-MVP TODOs) stays here. When updating a feature, edit its file; update the status table below when its status changes.

| # | Feature | File | Status | Open items |
|---|---------|------|--------|------------|
| 1 | Help Ticket System | [help-tickets.md](help-tickets.md) | Shipped (MVP + panel) | Discord OAuth on transcripts; richer `/ticket list` filters |
| 2 | Scheduled Event Reminders | [event-reminders.md](event-reminders.md) | Shipped | — |
| 3 | Twitch Stream Notifications | [twitch-notifications.md](twitch-notifications.md) | Shipped (MVP) | EventSub; per-channel overrides; templates; go-offline; clips/VODs |
| 4 | Guild Staff Roles (Admin Gate) | [staff-roles.md](staff-roles.md) | Shipped | Capability flags; `added_by`; audit embeds |
| 5 | Staff Notes System | [staff-notes.md](staff-notes.md) | Shipped | — |
| 6 | Warning System | [warnings.md](warnings.md) | Shipped (MVP + polish) | Auto-mod thresholds |

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
- [ ] Login with Discord on transcript HTTP routes  
- [x] Download/mirror all attachments into transcript storage at archive time (replace hotlinks)  
- [ ] Richer `/ticket list` filters  
- [x] Stored panel registry (list/edit/delete via commands)  

### Event reminders

- [x] Richer templates / embed reminders (always embed + placeholders `{url}` `{description}` `{offset}`)  
- [x] Per-event mute (`/mute` / `/unmute`; guild `/optout` still wins)  
- [x] Auto-suggest shortname from event title (+ collision suffix `-2`…)  

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
- [ ] Auto-mod thresholds (e.g. 3 active → timeout / kick / ban with configurable actions)  
- [x] Dedicated `warn_log_channel_id` separate from general audit log (`/setwarn log`; falls back to audit)  
- [x] Warning expiry / auto-void after N days (opt-in; default still permanent) — guild `/setwarn expiry` + per-warn `expires_days`  
- [x] Export user record (notes + warnings) for staff handoff — `/warn export` ephemeral `.md`  
- [x] ~~Un-void / re-activate~~ — **skipped**; prefer re-issue (no un-void command)  
- [x] Evidence: message jump link + freeform staff-only notes on `/warn add` (not in member DM / `/warn mine`)

