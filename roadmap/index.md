# Boiler Snake Roadmap — Design Archive Index

> **Roadmap tracking moved to GitHub Issues (2026-10-09).** All open features, bugs,
> triage items, and live-verification work are tracked as
> [GitHub Issues](https://github.com/metalsp0rk/boiler-snake/issues) organized by
> **milestones** (order of operations) and **area labels**. This `roadmap/` folder
> remains the **design archive**: the design records, locked decisions, schemas, and
> completed-feature history. Nothing new gets tracked in these files.

## How tracking works now

- **New feature / bug / investigation / verification item** → open a GitHub issue.
- **Order of operations** → [milestones](https://github.com/metalsp0rk/boiler-snake/milestones):

  | Milestone | Contents |
  |-----------|----------|
  | `P0 — audit criticals` | Small, verified critical fixes from the [2026-10-04 architecture audit](audit-2026-10.md) (§6 P0) |
  | `P1 — audit highs` | High-severity audit remediations (§6 P1) |
  | `P2 — structural paydown` | SDK-shaped tests, migration guard, CI, schema, config debt (§6 P2) |
  | `Gork next` | Gork feature work + open triage (design record: [gork.md](gork.md)) |
  | `Fluxer/Bridge live verification` | Live-verification items gating voice XP / elevated actions + bridge spike follow-ups (design records: [fluxer.md](fluxer.md), [bridge.md](bridge.md)) |
  | `Community Events v1` | Apollo-style events: epic + phases 1–5, DM wizard, `/eventreminder` retirement (design record: [community-events.md](community-events.md)) |
  | `Feature backlog` | Work-as-time-allows items from shipped features |

- **Area labels** filter an issue list per feature: `gork`, `fluxer`, `bridge`,
  `community-events`, `tickets`, `twitch`, `staff-roles`, `core-infra`, plus
  `triage` (evidence needed) and `audit-finding` (from the 2026-10-04 audit).
- **Status semantics:** an issue closes only with its verification bar met. The rule
  the audit forced (and fluxer/bridge invented): **no feature is "Shipped" without a
  dated live-verification record.** Merged-but-unverified stays an open issue.
- **Design changes** (locked decisions, schemas) still land as PRs editing the
  feature's design file in this folder — decisions stay authoritative there.

## Feature design records

One file per feature in this folder; the file header points at its issues. Shipped
features with zero open items are archived in [index-completed.md](index-completed.md).

**Shipped (user docs in `docs/`):** XP/leveling, voice XP, decay, level roles,
reaction roles, YouTube notifications, Twitch stream notifications, command-channel
restrictions, audit/message logs, honeypot channels & ban roles, scheduled event
reminders, guild staff roles (`staff_roles` / `requireStaff`), staff notes, warnings,
user activity tracking, help tickets (MVP), music player (`/play` via Lavalink +
Spotify catalog), Fluxer multi-platform endpoints (see [fluxer.md](fluxer.md)),
channel bridge (Discord ↔ Fluxer, see [bridge.md](bridge.md)), gork AI Q&A
(see [gork.md](gork.md)), web admin console, account linking
(see [account-linking.md](account-linking.md)).

**Planned:** community events with button RSVP
([community-events.md](community-events.md), issue-tracked under the
`Community Events v1` milestone).

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
| `gork_context_window` etc. | Prior-message context size (default `10`), staff rules (≤500 chars), SearXNG toggle (default on), per-user cooldown (default `180`s, staff bypass) (**shipped**) |
| `gork_user_blocks` + `guild_settings.gork_enabled` | Per-guild ban list (PK `guild_id`+`user_id`) + master switch (**shipped**, migration `022`) |
| `gork_memories` + memory settings | Community memory (**shipped**, migration `023`; [gork.md §7.16](gork.md)) |
| `gork_daily_limit` + `gork_budget_rules` + `gork_usage` | Per-scope daily usage budget (**shipped**, migration `026`; [gork.md §7.17](gork.md)) |

Event reminders, staff notes, warnings, web admin console, Fluxer (`034`), bridge
(`035`), and account linking (`036`) migration tables: see
[index-completed.md §7](index-completed.md) and the feature design records.

### Migration-id reservation rule

New tables reserve the **next free id when the PR is written** — never squat an id a
draft does not own. Highest shipped id as of 2026-10-09: `036` (`user_links`).
