# Community Events (`/event`)

Bot-owned events with **button signups**, taken entirely inside Discord: post an event, members RSVP with a button, and the bot runs capacity, waitlists, reminders, threads, and attendee roles. It replaces creating events through Discord's own "Create Event" flow for anything this bot manages.

> **`/event` vs `/eventreminder`.** [Scheduled Event Reminders](event-reminders.md) keeps running for configs that already exist (it pings Discord's *Interested* list). It takes **no new configs**: `/eventreminder create` is retired and redirects to `/event create` / `/event adopt`. `/event` reminders ping *your signup list* instead — people who actually signed up, including waitlist promotions and custom options.

## How it works

1. **Create** — `/event create title:"Movie Night" start:"Fri 8pm"`. Times are typed in the **server's timezone** (`/event settings timezone`); every viewer sees them localized in their own language via Discord timestamps.
2. **Draft → confirm** — the event lands as a draft with **Post / Discard** buttons (private reply). Edit first with `/event edit` or the edit button, then **Post**.
3. **Posted** — one embed in the channel with RSVP buttons. Signups live in the bot; the message updates live (counts, waitlist, attendee names when enabled).
4. **Reminders** — one reminder is armed automatically before start (guild default, `/event reminders default`). Pings hit the signup list minus opt-outs and mutes.
5. **End** — the event auto-archives after the configured delay (or `/event delete` removes it). Attendee role is cleaned up.

On a scheduled **series**, the bot materializes the next occurrence as a draft automatically when the previous one ends.

## Commands

All of `/event` is one slash command; `event` id pickers use autocomplete.

| Subcommand | What it does |
|---|---|
| `/event create` | Create + confirm. Time, duration, channel, description, location, image, color, announce roles, signup options/preset, capacity, cutoff, thread flags, attendee role, recurrence. |
| `/event edit` | Edit any field through a modal (creator or staff). `in_dm:yes` runs the same flow as the DM wizard. |
| `/event delete` | Delete with a confirm button; cleans role, reminders, thread. |
| `/event list` | Upcoming events (embed, includes your drafts). |
| `/event wizard` | Create through a step-by-step **DM conversation** (buttons + short answers). |
| `/event duplicate` | Copy an event into a fresh draft (options copied). |
| `/event post` | Post a scheduled/pending event now (staff/edit rights). |
| `/event adopt` | Turn an existing Discord scheduled event into a bot-owned draft. Discord's *Interested* list is **not** copied — RSVPs start empty. |
| `/event response add\|remove\|move` | Organizer-side signup management (bypasses cutoff/whitelist; see E5 in the design record). |
| `/event reminders` | `off` / `on` (personal, shared with `/eventreminder` opt-out), `mute`/`unmute` one event, `status`, `default <minutes>`, `add`/`remove`/`list` extra reminders (offset, custom message, ping role). |
| `/event settings` | `show`, `show-attendees`, `timezone`, `role` (create/edit/delete gates), `thread-reminders`, `reminder-channel`, `auto-archive`, `digest` (channel + daily/weekly/hour/weekday). |
| `/event options` | Manage signup options on a live event: `list`, `add`, `edit`, `remove`, `reorder`, `whitelist` (per-option role restriction). |
| `/event preset` | Saved signup-option groups: `save`, `list`, `delete`. |
| `/event series` | `list`, `skip` (drop the next occurrence), `stop`. |
| `/event channel` | Event channels: `mark`, `unmark`, `list`, `sort` (re-post event messages in start-time order), `purge` (opt-in cleanup of non-event, unpinned messages). |
| `/event crosspost` | Post one event into **another guild**: `invite`, `approve` (their admin), `revoke` (either side), `list`, `config` (mentions, destination signup role, post offset). |
| `/event google` | Per-member Google Calendar connect + a guild auto-sync calendar: `connect`, `status`, `disconnect`, `autoset`. |

Buttons on posted events: RSVP options, **Edit**/**Delete** for the creator and staff, and (after edits) everyone signed up is refreshed in place.

## Signups, options, waitlists

- Default options are **Yes / No / Maybe**; replace them with `signup_options:"Pizza|Pasta|Salad"` or a preset. One choice per member unless `multiple:yes`.
- **Capacity** is per option; overflow lands on a **waitlist** and is promoted automatically (with a note on the event message) when a spot opens.
- **Whitelist** (`/event options whitelist` or create-time `role_whitelist`) restricts who may pick an option; staff and the creator bypass all restrictions.
- **Cutoff** closes signups N minutes before start (`cutoff:` at create, editable later).
- Attendee **names** are shown on the embed up to the field cap ("and N more") — toggle with `/event settings show-attendees`.

## Attendee role

Every event can grant a role to confirmed attendees: a temporary `event-<slug>` role created and deleted by the bot (default), or an **existing** role via `attendee_role:`. The bot's role must sit above it. Role sync is best-effort and reports partial failures on the event message — it never silently drops.

## Reminders

- Reminders are a **property of the event**, not a separate product. A default reminder arms at the guild interval when the event is created; `/event reminders default 60` changes the interval, `add`/`remove` stack extra offsets (optional custom message + ping role).
- Delivery audience: signed up on an option with reminders on → minus personal opt-out (`/event reminders off`, shared with `/eventreminder optout`) → minus per-event mute.
- Changing the start time **moves unsent reminders**. Thread delivery (posts the reminder in the event thread) is opt-in: `/event settings thread-reminders`.
- Reminder delivery has states (`sent`, `retry`, `retired`) — a failed send retries with backoff and says so rather than vanishing.

## Recurring series

`recurrence:weekly` (pick weekdays) or `monthly` (day-of-month; months lacking the day are **skipped**, never clamped). End by date or count. Each materialized occurrence is an independent event (own signups, reminders, threads) linked by a series cursor; `/event series skip` drops the next occurrence, `stop` keeps posted ones and kills the rest.

## Google Calendar

- A member runs `/event google connect` (browser OAuth), then can sync events they can see to their own calendar.
- Staff set one **guild auto-sync calendar** (`/event google autoset <member>`): newly posted events are added automatically. If that member revokes access, auto-sync switches **off** and staff are told why — it never fails silently.
- Tokens are envelope-encrypted at rest (`TOKEN_ENCRYPTION_KEY`). Env setup in [Configuration](configuration.md) — placeholders only, never real secrets.

## Cross-posting

Source guild invites the destination (`/event crosspost invite`); a destination **admin** approves with the code. Copies post to the destination channel with per-destination mentions, optional signup role restriction, and an optional post offset. Buttons in the destination write through to the **source** signup list (gated by the destination restriction). Revoke from either side stops future copies; messages already sent stay.

## Permissions

| Action | Who |
|---|---|
| `/event create` | Everyone by default; if a **create role** is set (`/event settings role create`), that role or staff. |
| Edit / delete an event | Creator, staff (`ManageGuild` or any staff role), or the configured edit/delete roles. |
| `response add/remove/move`, `post`, series controls | Staff / edit rights (organizers on their own events). |
| `/event settings`, `/event channel`, `/event crosspost approve/config`, `google autoset` | Staff — settings mutations that Discord hides use `ManageGuild`-only gates where the command visibility tier says so. |

## Web admin

Staff get the same data on the [Web Admin](web-admin.md) calendar: month view, drafts, event pages with attendees/waitlists, editing that writes back to the Discord message, archive, activity log, presets, series, and scheduled posts.

## Limits & gotchas

- Max 25 signup options per event; options need unique labels.
- Drafts that are never posted are cleaned up after 24 h; posted events auto-archive (default 120 min after end, configurable, opt-in for the *auto* part).
- Global slash-command propagation is slow — set `DEV_GUILD_ID` while testing.
- Message edits use Discord timestamps; there is no per-viewer setting for 12/24 h — the client decides.

## Design & tracking

The locked design decisions (E1–E15), schema, and phase plans live in the design record: [roadmap/community-events.md](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/community-events.md). Feature work is tracked in GitHub issues #218–#225 (label `community-events`).
