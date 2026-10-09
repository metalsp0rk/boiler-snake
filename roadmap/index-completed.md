# Boiler Snake Roadmap — Completed Features

> **Tracking moved to GitHub Issues (2026-10-09).** Open work for this feature lives in [GitHub issues](https://github.com/metalsp0rk/boiler-snake/issues), ordered by [milestones](https://github.com/metalsp0rk/boiler-snake/milestones). This file stays the **design record** — locked decisions, schemas, and history here remain authoritative. Do not add new tracking items here; open an issue instead (see [index.md](index.md)). Completed-feature history; nothing to track here.

Archive for **fully implemented** roadmap features: shipped **and** zero open
items in their feature file. The active roadmap (open features, spec/draft
work, and every open item) lives in [index.md](index.md) — link "completed
features" there points here.

> **Authority rule (same as index.md):** the feature files are the single
> source for design and status. This file mirrors *shipped* state only; never
> restate multi-part design or open work here. When a feature listed in
> [index.md](index.md) fully ships (status → shipped, every checkbox in its
> file ticked), move its index row, its §7 migration table, and its §8 block
> here, and leave nothing behind in index.md.

## Completed Feature Index

| # | Feature | File | Status | User docs |
|---|---------|------|--------|-----------|
| 2 | Scheduled Event Reminders | [event-reminders.md](event-reminders.md) | Shipped | [docs/event-reminders.md](../docs/event-reminders.md) |
| 5 | Staff Notes System | [staff-notes.md](staff-notes.md) | Shipped | [docs/staff-notes.md](../docs/staff-notes.md) |
| 6 | Warning System | [warnings.md](warnings.md) | Shipped (MVP + post-MVP polish) | [docs/warnings.md](../docs/warnings.md) |
| 8 | Web Admin Console (panel overhaul) | [web-admin.md](web-admin.md) | Shipped (Phases 0a–4; PR #55 + Phase 4 2026-09-25) | [docs/web-admin.md](../docs/web-admin.md) |

Also completed here: **XP & leaderboard polish** (§8 below — work with no
feature file of its own) and the **Honeypot** note (§7 below).

**Moved out of this archive:** nothing so far. A feature only lands here when
its feature file has no unchecked boxes — e.g. Web Admin was archived once
`web-admin.md` Task 15.6 (tickerHealth job-state wiring) shipped with
Phase 4 (PR #116).

---

## 7. Database Migration Summary

### Event reminders

| Table / change | Notes |
|----------------|-------|
| `event_reminder_configs` | Event ↔ role ↔ channel ↔ template (**shipped**, migration `006`) |
| `event_reminder_event_optouts` | Per-event mute (**shipped**, migration `015`) |
| `event_reminder_offsets` | Each “X before” fire + sent state (**shipped**) |
| `event_reminder_optouts` | Per-guild user opt-out (**shipped**) |
| `guild_settings.event_reminder_channel_id` | Default notify channel (**shipped**) |

### Staff notes

| Table / change | Notes |
|----------------|-------|
| `staff_notes` | Per-guild sequential notes; soft-delete; edit metadata (**shipped**) |

### Warnings

| Table / change | Notes |
|----------------|-------|
| `warnings` | Permanent rows; void metadata; optional `related_note_id` → `staff_notes` (**shipped**, migration `009`) |
| `warnings.expires_at` / evidence columns | Opt-in expiry + staff evidence (**shipped**, migration `018`) |
| `guild_settings.warn_dm_members` | Default `1` — DM subject on issue/void (**shipped**) |
| `guild_settings.warn_log_channel_id` | Dedicated warn issue/void log; audit fallback (**shipped**) |
| `guild_settings.warn_expiry_days` | Default `0` (never); guild default for new warnings (**shipped**, migration `018`) |

### Web admin console (shipped — PR #55 + PR #116)

| Table / change | Notes |
|----------------|-------|
| `web_sessions` | DB-backed login sessions; cookie carries opaque id only (**shipped**, migration `028`) |
| OAuth columns on `web_sessions` | Server-side Discord access token per session, no refresh flow in v1 (**shipped**, migration `030` — extends `web_sessions`, not a separate table) |
| `admin_audit` | Queryable mutation trail, `origin` = web/slash/system; channel embeds stay mirrors (**shipped**, migration `029`) |
| `tickets` / `ticket_members` / `ticket_staff` / `ticket_messages` | Reused as-is for transcript participant access — **no schema change** (**shipped**) |

> **Migration numbering (resolved):** shipped as `028`–`030`, reserved at implementation time per the rule above. See [web-admin.md §8.5](web-admin.md).

**Removed from roadmap as standalone product:** Honeypot feature (implemented — see `docs/honeypot.md`). Exempt roles are **absorbed** into guild staff roles (tracked in [index.md](index.md) / [staff-roles.md](staff-roles.md)).

---

## 8. Post-MVP TODOs (completed features — landed-work record)

> Every box below is ticked: these blocks document work that **landed** and
> stay as-is. For anything still open, see [index.md §8](index.md).

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

### Event reminders

- [x] Richer templates / embed reminders (always embed + placeholders `{url}` `{description}` `{offset}`)
- [x] Per-event mute (`/mute` / `/unmute`; guild `/optout` still wins)
- [x] Auto-suggest shortname from event title (+ collision suffix `-2`…)
- [x] **Fix:** `/eventreminder create`/`edit` modal exceeded Discord's 5-component limit — dropped the `persistent` select from the modal (back to 5); create now takes an optional `persistent` boolean (encoded in the modal customId `:p1`) and a **♾️ Recurring: on/off** button on the create/edit confirmation toggles it for either flow (see [event-reminders.md §2.12](event-reminders.md))

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
