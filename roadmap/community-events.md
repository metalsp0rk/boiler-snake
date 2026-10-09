# 12. Community Events (Apollo-style)

> **Tracking moved to GitHub Issues (2026-10-09).** Open work for this feature lives in [GitHub issues labeled `community-events`](https://github.com/metalsp0rk/boiler-snake/issues/labels/community-events), ordered by [milestones](https://github.com/metalsp0rk/boiler-snake/milestones). This file stays the **design record** — locked decisions, schemas, and history here remain authoritative. Do not add new tracking items here; open an issue instead (see [index.md](index.md)). Phases: epic #218; #219–#223 (phases 1–5), #224 (DM wizard), #225 (`/eventreminder` retirement) — the phase checklists below are mirrored in those issue bodies; work the issues.

| | |
|---|---|
| Author | Boiler Snake |
| Date | 2026-10-09 |
| Status | **Planned.** Not started. Decisions below are proposed from a review of [Apollo](https://apollo.fyi/) ([docs](https://docs.apollo.fyi/), [pricing](https://apollo.fyi/premium), news through 2026-10-06), revised 2026-10-09: bot-owned events are the primary create path, reminders follow those signups, and `/eventreminder` retires once parity lands ([12.7](#127-retire-eventreminder)). |
| Roadmap feature | 12 |
| Migration id | Reserve the next free id at implementation time. Highest shipped migration on this date is `036_user_links`. Do not hardcode a lower id. |
| Depends on | Shipped web admin (sessions, guild pages, audit), `src/core/scheduler.js`, staff gate (`requireStaff` / ManageGuild), command visibility tiers, and the shipped reminder behaviors in [event-reminders.md](event-reminders.md) (offsets, opt-out, per-event mute, role ping, reschedule on time change). |

## Purpose

Give a guild a calendar it actually runs inside Discord: a member posts an event, other members sign up with a button, and the bot handles capacity, waitlists, reminders, threads, and attendee roles. Organizers get the same event on the web admin console — drafts, a month view, an archive, and edits that write back to the Discord message.

**`/event` is the primary way to create an event** on a guild that uses this bot. Discord’s own “Create Event” stays a Discord feature, and this bot does not grow a second reminder product beside it. Feature 2 ([event-reminders.md](event-reminders.md)) keeps running for configs that already exist. New reminder configs go on bot-owned events, and `/eventreminder create` retires when [12.7](#127-retire-eventreminder) says parity is met.

Reminders are a property of the event, not a parallel command. The people who get pinged are the people signed up for an option that has reminders on, minus a guild opt-out and a per-event mute. Changing the start time moves unsent reminders. That is the same contract feature 2 already ships, pointed at our signup list instead of Discord’s Interested list.

Apollo ([apollo.fyi](https://apollo.fyi/)) is the product to copy. Their pitch is the scope: create in Discord (including a DM wizard) or on a dashboard, one-click signup, custom signup options, recurring series, scheduled posts, reminders, waitlists, threads, attendee roles, restricted signups, Google Calendar, and an archive. Premium and Premium Pro are packaging for a hosted bot. Boiler Snake is self-hosted, so those paywalls are not copied. The capabilities underneath them are.

## What is already shipped

| Need | Where it lives today | Gap |
|------|----------------------|-----|
| Ping people before a Discord scheduled event | `/eventreminder` — role `event-<shortname>`, offsets, opt-out / mute, reschedule when the start time moves | Audience is Discord’s Interested list, so it cannot follow a waitlist, a custom option, or a cutoff. Retirement plan is [12.7](#127-retire-eventreminder). |
| Role grant / revoke | Level roles, reaction roles, event-reminder roles | No role that means “signed up for this event”. |
| Scheduler | `src/core/scheduler.js` | No event-post or reminder jobs. |
| Web admin | `src/web/` guild pages, sessions, `admin_audit` | No calendar, drafts, or attendee list. |
| Staff gate | `requireStaff`, junior / senior, command visibility | No event-host permission short of staff. |

New events get their own tables. Do not store button signups in `event_reminder_*`, and do not treat Discord’s Interested list as a signup. The one shared preference is guild opt-out: `/event reminders` and `/eventreminder optout` read and write the same row until the old command is gone ([E14](#proposed-decisions)).

## Apollo inventory

Sources: marketing page, [premium comparison](https://apollo.fyi/premium), [command list](https://docs.apollo.fyi/commands), and the docs and news posts linked in the Notes column. “Free / Premium / Pro” is how Apollo sells it. We ship the capability to every guild.

| Capability | Apollo packaging | Phase | Notes |
|------------|------------------|-------|-------|
| Create an event (title, start, optional description, duration, announce-mention roles) | Free. `/event`, then a DM wizard. [Creating events](https://docs.apollo.fyi/creating_events) | 1, wizard in [12.6](#126-dm-creation-wizard) | Slash create is the short form. The wizard is the long form inside Discord. Neither is required if the other, or the dashboard, is available (E2, E15). |
| One-click RSVP on the posted message | Free. Default yes / no / maybe. | 1 | Buttons on the embed. |
| Edit and delete, by the creator or Manage Server | Free. `/edit`, Edit / Delete buttons. [Modifying](https://docs.apollo.fyi/modifying_events), [Deleting](https://docs.apollo.fyi/deleting_events) | 1 | Extra delete role is a guild setting (E4). |
| Show or hide attendee names | Free. `/settings show_attendees` | 1 | Embed cap: names until the field is full, then “and N more”. Full list on the dashboard in phase 4. |
| Local time for each viewer | Free. `/settings localize_time`, `/settings 24_hour_time` | 1 | Use Discord timestamps (`<t:unix:F>`, `<t:unix:R>`). Skip a separate 12h/24h setting — the viewer’s client already does that. |
| One default reminder (15 minutes), personal opt-out | Free. [Reminders](https://docs.apollo.fyi/reminders), `/reminders off` | 1 | Guild default interval, overridable per event. Guild opt-out is shared with feature 2 (E14). Per-event mute from feature 2 is kept. |
| Organizer can add, remove, or move a signup | Free. `/response add\|remove\|move` | 1 | Organizer and staff bypass restrictions (E5). |
| Per-action role gates (create, edit, delete, channels, signup options) | Free. `/settings role …` | 1 | See E4. |
| Capacity and automatic waitlist | Free. | 2 | Per signup option, not only per event. |
| Signup presets (saved option groups) | Free. `/signup_presets`. Dashboard page, [2026-06-10](https://apollo.fyi/news/signup-presets-and-editing). | 2 | |
| Custom option label, emoji, order, per-option capacity, per-option reminder flag | Premium. `/signup_options`. Also editable after create as of [2026-06-10](https://apollo.fyi/news/signup-presets-and-editing) (older docs said options could not be added or removed). | 2 | Copy the newer behavior: options are editable on an existing event. |
| Multiple signups (a member holds more than one option) | Editable attribute. [Modifying events](https://docs.apollo.fyi/modifying_events) | 2 | Off by default. |
| Role whitelist, event-wide or per option | Premium. [Signup restrictions](https://docs.apollo.fyi/signup_restrictions) | 2 | Member needs one of the roles. |
| Signup cutoff (at start, before start, or after start) | Premium. | 2 | Closed signups get a specific ephemeral reason. |
| Several reminders, each with its own message | Premium, up to 5. [2025-07-24](https://apollo.fyi/news/custom-reminders), [2025-09-09](https://apollo.fyi/news/reminder-messages). | 2 | Cap at 8, matching feature 2’s offset cap. Not a paid gate. |
| Role-based reminder (ping a role even if they have not signed up) | [2026-06-10](https://apollo.fyi/news/signup-presets-and-editing) | 2 | Separate from attendee reminders. |
| Reminder in the event thread, or in the channel | `/settings thread_reminders`. [Reminders](https://docs.apollo.fyi/reminders) | 2 | Default: thread. |
| Recurring series (cadence, end date or occurrence count, skip one, edit one vs series) | Free up to 5 active series; Premium unlimited. [2026-03-31](https://apollo.fyi/news/recurring-reimagined), homepage. | 3 | No series cap. Deleting one occurrence does not delete the series. Deleting the series leaves posted occurrences as one-off events ([Deleting](https://docs.apollo.fyi/deleting_events)). |
| Scheduled post time | Premium. [Scheduled posts](https://docs.apollo.fyi/scheduled_posts), [2026-05-05](https://apollo.fyi/news/scheduled-posts) | 3 | Draft stays off Discord until `post_at`. Retry, then tell the organizer. |
| Event thread; add attendees as they sign up; remove them if they back out | Premium. `/settings event_threads`, `/settings auto_join_threads`. [Recommended settings](https://docs.apollo.fyi/premium/recommended_settings) | 3 | Public thread by default. Private thread is a per-event choice. |
| Attendee role (temporary role, or an existing role) | Premium. [Attendee roles](https://docs.apollo.fyi/attendee_roles), `/settings temp_roles` | 3 | Granted for options that count as “attending”. Shared existing roles use a refcount: remove the role only when the member has no remaining signup that uses it. |
| Location (text, address, or a Discord channel) | [2026-08-12](https://apollo.fyi/news/activity-logs-and-locations) | 3 | |
| Event image and embed color | Premium. Dashboard upload [2026-08-12](https://apollo.fyi/news/activity-logs-and-locations). | 3 | Static images. Animated images are not a separate tier. |
| Announce mentions when the event is posted | Free. Creating-events docs. | 3 | |
| Duplicate an event into a draft | Premium. `/duplicate`. [2026-02-25](https://apollo.fyi/news/event-duplication) | 3 | |
| Event channel: create or convert, sort chronologically, purge non-event unpinned messages | Free. [Event channels](https://docs.apollo.fyi/event_channels), `/channel`, `/sort`, `/settings purge`. Sort is capped at 10 (50 on Premium) and gated on a top.gg vote unless Premium. | 3 | No vote gate. Sort cap 50. Purge default **off** (E7). |
| Auto-archive after the event ends | Free. Default two hours after end. `/settings auto_archive`, `/settings auto_archive_interval`. [Archive](https://apollo.fyi/news/event-archives) | 3 | Removes the Discord message and thread. Row stays for the dashboard. |
| Dashboard: month view, drafts, create, edit-syncs-to-Discord, attendee and waitlist lists | [Dashboard launch](https://apollo.fyi/news/dashboard-launch), homepage. | 4 | Built on the existing web admin, not a second site. |
| Archive browser | Free: current and previous month. Premium: unlimited. [2026-01-20](https://apollo.fyi/news/event-archives) | 4 | No history window. |
| Activity log (posted, signup, removal, time change, archive) with actor | [2026-08-12](https://apollo.fyi/news/activity-logs-and-locations) | 4 | Also write `admin_audit` for staff mutations, same as other web actions. |
| Signup-option and preset management on the web | [2026-02-25](https://apollo.fyi/news/event-duplication), [2026-06-10](https://apollo.fyi/news/signup-presets-and-editing) | 4 | |
| Recurring tab: unposted occurrences, skip, edit one or the series, next post time | [2026-03-31](https://apollo.fyi/news/recurring-reimagined) | 4 | |
| Scheduled-posts list | [Scheduled posts](https://docs.apollo.fyi/scheduled_posts) | 4 | |
| Upcoming-event digest (daily or weekly) with signup counts and capacity | Premium comparison table. | 5 | |
| Google Calendar: per-user manual sync; guild auto-sync | Manual on Free, auto on Premium. [Google Calendar](https://docs.apollo.fyi/google_calendar) | 5 | Needs a Google OAuth client in the environment. Revoking the authorizing user disables auto-sync. |
| Cross-post one event to other guilds, one signup list, per-destination mentions / restrictions / post time | Premium Pro. [2026-10-06](https://apollo.fyi/news/premium-pro) | 5 | A guild posts into another guild only after that guild’s admin approves. Either admin can revoke. |
| Custom bot name, bio, avatar, banner | Premium Pro. | — | Out of scope. One bot identity. |
| Premium billing, trials, transfers, per-server memberships | `/premium`, [pricing](https://apollo.fyi/premium) | — | Out of scope. |
| top.gg vote requirement on `/sort` | [Event channels](https://docs.apollo.fyi/event_channels) | — | Out of scope. |

## Out of scope

- A live sync that copies Discord “Interested” into button signups, or that creates a Guild Scheduled Event as a shadow of a bot-owned event. Two RSVP lists drift. Showing the event in Discord’s event list can be revisited later as a display-only mirror with Interested ignored.
- Automatically converting existing `/eventreminder` configs into bot-owned events. The Interested list is not a signup list. Staff recreate those as `/event` when they want the new model. [12.7](#127-retire-eventreminder) only stops new configs and lets old ones finish.
- Paywalls, signup caps sold as upgrades, and Apollo’s free-tier limits (5 series, 1 reminder, 2 months of history, sort cap 10).
- Custom bot branding.
- Making the DM wizard the only create path. Apollo requires DMs for `/event`. We keep slash create and the dashboard for members whose DMs are closed (E15).
- Fluxer buttons. Fluxer has no components. Phases 1–4 and the wizard are Discord. A text RSVP on Fluxer (`!event signup …`) is a follow-up, not part of these phases.
- Animated event images as a distinct feature.

## Proposed decisions

| # | Decision | Why |
|---|----------|-----|
| E1 | New feature module `src/features/events/`. New tables for events, options, signups, and reminders. Do not write signups into `event_reminder_*`. | Feature 2’s audience is Discord’s Interested list. This feature’s audience is button signups. Sharing the signup tables would mix the two. |
| E2 | Three create surfaces, any one of them enough: slash `/event create` (short form, in channel), the DM wizard ([12.6](#126-dm-creation-wizard)), and the web admin (phase 4). | The wizard is how Apollo fits a long form into Discord. Slash and the dashboard cover members who cannot open a DM. |
| E3 | Time entry is a parsed string plus a confirmation that shows the Discord timestamp before anything is posted. The dashboard uses a real datetime field. Stored instant is UTC. | Discord modals have no date picker (same constraint feature 2 already documents). Confirmation catches a bad parse. |
| E4 | Anyone may create, edit their own, and delete their own. ManageGuild or staff may edit and delete any event. Guild settings may additionally require a role for create, edit, delete, event-channel management, and signup-option management. Empty role setting means “no extra role required”. | Copies Apollo’s defaults and `/settings role` without inventing a new permission system. Handler checks stay the source of truth. |
| E5 | Restrictions and cutoffs do not apply to the organizer or to staff using add / remove / move. | [Signup restrictions](https://docs.apollo.fyi/signup_restrictions): the organizer or an admin can always fix the list. |
| E6 | “Attending” means the member’s chosen option has reminders enabled. Waitlist is not attending. Declined / maybe are not, unless that option opts in. Attendee role, thread membership, and reminder pings all use this bit. | Matches Apollo: by default only Accepted has reminders, and the attendee role follows that bit. |
| E7 | Event-channel purge of non-event, unpinned messages defaults **off**. | Apollo defaults it on and their FAQ exists mostly to explain the surprise deletions. Opt-in. |
| E8 | Auto-archive defaults **off**. When on, the default delay is two hours after the event’s end (or after start, if there is no duration). Archive removes the Discord message and archives the thread. The database row stays. | Same delay as Apollo. Default off so a guild that only wanted RSVP does not lose the message. |
| E9 | Reminder delivery reuses `src/core/scheduler.js` (minute ticker). One message per due reminder. Failure is logged with guild id, event id, and the Discord error text, and the organizer is told after retries fail. | Same bar as feature 2 and the project error rules. No silent skip. |
| E13 | Bot-owned `/event` is the primary way to create an event. `/eventreminder create` is retired in [12.7](#127-retire-eventreminder) once the parity list there is checked off. Configs that already exist keep firing until the Discord event ends or staff clear them. | A guild with two create buttons gets two audiences. Custom options, waitlists, and cutoffs only exist on the bot-owned event, so reminders have to be born there. |
| E14 | Reminder audience is computed from the event, every time it matters. Signed up for an option with reminders on (E6), not guild-opted-out, not muted for this event. Editing the start time rewrites unsent fire times. The ping mentions that event’s attendee role. Guild opt-out is one row shared with feature 2 (`event_reminder_optouts`) until `/eventreminder` is gone. | This is feature 2’s contract (offsets, opt-out, mute, role ping, reschedule) applied to signups. A second opt-out flag would let someone silence one system and still get pinged by the other during the overlap. |
| E15 | The DM wizard is Apollo’s interview: the bot DMs the creator and asks one thing at a time, then posts the event. If the DM cannot be opened, the reply names that failure and points at `/event create` and, once phase 4 exists, the dashboard. The wizard never becomes the only path. | Copies [Creating events](https://docs.apollo.fyi/creating_events) without locking out closed DMs. |
| E10 | Series posting and scheduled posts retry a few times, then mark the occurrence failed and notify the organizer with the reason and a way to post it now. | [Scheduled posts](https://docs.apollo.fyi/scheduled_posts) and the [recurring rework](https://apollo.fyi/news/recurring-reimagined). |
| E11 | Command visibility: `/event` is **public** (RSVP and create are member actions; staff-only subcommands are enforced in handlers, same pattern as `/ticket` and `/warn`). `/event` settings that change guild defaults are staff-gated in the handler. Add the tier in `src/core/commandVisibility.js` in the same change as the command. | `test/commandVisibility.test.js` fails if a command has no tier. |
| E12 | Web pages live under the existing guild admin (`src/web/routes/`, `src/web/views/`). A member only sees events they could see in Discord. Mutations from the web go through `admin_audit`. | The console already has sessions and permission checks. A second origin would split auth. |

## 12.1 Phase 1 — Post an event and take signups

The smallest thing that replaces a “react with ✅” message.

- [ ] Schema for an event, its signup options, and its signups. Reserve the next free migration id. Guild defaults: reminder interval (15 minutes), show attendee names (on), who may create (everyone).
- [ ] `/event create` — title, start time (E3), channel (current channel by default), optional description, duration, and announce roles. Posts an embed with Yes / No / Maybe buttons. Yes is the only option with reminders on (E6).
- [ ] Button handler updates the signup and edits the message in place. One signup per member. Switching option replaces the previous one. Picking the same option again removes it.
- [ ] `/event edit` and an Edit button. `/event delete` and a Delete button with a confirm. Creator, or staff (E4).
- [ ] `/event list` — upcoming events in this guild.
- [ ] `/event response add|remove|move` for the organizer and staff.
- [ ] One reminder per event at the guild default interval. Personal `/event reminders off|on`, stored in the same guild opt-out row as `/eventreminder optout` (E14). Per-event mute and unmute. Delivery in a thread on the event message (E9).
- [ ] Phase 1 creates a temporary attendee role and assigns it to members on a reminder-enabled option (E6, E14). The reminder mentions that role. Withdrawing, opting out, or muting removes it. Bot role must sit above it; a failure names the role and the Discord error. Richer role choices (use an existing role, refcount across events) stay in phase 3.
- [ ] Guild settings for the extra role gates (E4), show-attendees, and the default reminder interval.
- [ ] User docs in `docs/` and a commands-index entry. Docs links stay inside `docs/` (see AGENTS.md).
- [ ] Tests: create, signup, switch, withdraw, permission refusal with the specific reason, reminder fire, opt-out skips the ping.

## 12.2 Phase 2 — Signups that match the event

- [ ] Custom options: label, emoji, capacity, waitlist flag, reminders flag, role whitelist, display order. Add, edit, remove, and reorder on an existing event.
- [ ] Waitlist: over-capacity signups land on the list; a withdrawal promotes the next waiter and tells them.
- [ ] Signup presets, saved per guild, chosen at create time. Saving the current options as a preset does not leave the flow.
- [ ] Multiple-signups toggle. Off means one option per member.
- [ ] Event-level role whitelist and a signup cutoff (at start, before, or after) with a specific closed message.
- [ ] Up to 8 reminders, each with an offset and an optional message. Per-option reminder flag (E6).
- [ ] Role reminder: at an offset, ping a chosen role whether or not they signed up.
- [ ] Setting for thread reminders vs channel reminders.
- [ ] Tests for capacity, promotion, cutoff, role whitelist (including staff bypass), and a second reminder.

## 12.3 Phase 3 — Keep it running without a babysitter

- [ ] Recurrence: daily, weekly (selected weekdays), monthly. End by date or by count, or open-ended. Edit one occurrence without touching the series. Skip an occurrence. Delete one vs stop the series (posted occurrences become one-offs).
- [ ] Scheduled `post_at`. The event exists as a draft until then. Retry, then notify (E10). The organizer can post now.
- [ ] Event thread on post. Auto-add and auto-remove attendees (E6). Private thread option.
- [ ] Attendee role: create a temporary role, or use an existing role with refcount. Reconcile when the role setting changes. Bot role must sit above roles it assigns; a failure names the role and the Discord error.
- [ ] Location, image, embed color, announce mentions.
- [ ] `/event duplicate` → draft copy.
- [ ] Event channels: mark a channel, `/event channel` create-or-convert, sort up to 50 messages chronologically, optional purge (E7, default off).
- [ ] Auto-archive (E8).
- [ ] Tests for “edit this Tuesday only”, waitlist promotion across a role refcount, and a failed scheduled post surfacing the Discord error.

## 12.4 Phase 4 — Web admin calendar

Same data as Discord. Edits made on the web update the Discord message.

- [ ] Month view of upcoming events, with a marker for anything in progress.
- [ ] Create, save draft, publish, duplicate.
- [ ] Event page: attendees, waitlist, location, link to the Discord message.
- [ ] Click-to-edit fields, including options, reminders, restrictions, cutoff, color, image upload, attendee role. Writes sync back to Discord.
- [ ] Archive list with no history window. Permanent delete from the archive page.
- [ ] Activity log on the event (who signed up, who removed them, time changes, archive). Staff mutations also hit `admin_audit`.
- [ ] Preset management page. Recurring series page (unposted occurrences, skip, next post time). Scheduled-posts list.
- [ ] Visibility follows Discord channel permissions for the logged-in member.
- [ ] Browser check of create → Discord message updates → edit on the web → Discord message updates, on desktop and a narrow viewport.

## 12.5 Phase 5 — Digests, calendar export, cross-post

- [ ] Upcoming digest, daily or weekly, in a chosen channel. Each line shows signup count and capacity when set.
- [ ] Google Calendar. A member connects their own calendar and syncs an event they can see. A guild may set one calendar for automatic sync of newly posted events; if that member revokes Google access, auto-sync turns off and staff are told why. Tokens stay in the database, never in the repo. New env placeholders go in `.env.example` as obvious fakes (`YOUR_GOOGLE_CLIENT_ID`).
- [ ] Cross-post. Destination guild approves the source guild first. One signup list. Per-destination mentions, restrictions, and post time. Revoke from either side stops further posts and leaves messages already sent.
- [ ] Tests for digest contents, auto-sync disabling itself on revoke, and a cross-post refusal when the destination has not approved.

## 12.6 DM creation wizard

Apollo’s `/event` does not use a modal. It DMs the creator and walks through the event one question at a time ([Creating events](https://docs.apollo.fyi/creating_events)). That is a create surface of its own, next to slash `/event create` and the dashboard. It is not required (E15).

The wizard starts once phase 1 can post an event. Later phases add questions. Each new question is skipped, with the phase’s default, until that phase has shipped. Cancelling at any step drops the draft and says so. A finished wizard posts immediately unless the creator chose a scheduled post time (phase 3).

- [ ] `/event wizard` (and the same entry from `/event create` when the creator asks for the long form) opens a DM. First message states that answers stay in the DM and that `/event create` is available if they would rather not.
- [ ] DM closed, blocked, or otherwise unsendable: the channel reply includes the Discord error and the slash command to use instead. No silent fallback that posts a half-filled event.
- [ ] Questions for phase 1 fields: title, start time (confirm with a Discord timestamp before continuing, E3), channel, description, duration, announce roles. Defaults match `/event create`.
- [ ] Resume: an unfinished wizard for this creator and guild is offered again on the next `/event wizard`, with the answers so far. Starting over discards it. One open wizard per creator per guild.
- [ ] Questions added with phase 2: signup preset or custom options, capacity, multiple signups, role whitelist, cutoff, reminder list (offsets and messages).
- [ ] Questions added with phase 3: recurrence, scheduled post time, thread (including private), attendee role, location, image, color.
- [ ] Edit of an existing event can re-enter the wizard at a single question (`/event edit` → “edit in DM”) without re-asking the rest. The Discord message updates when that answer is saved.
- [ ] Tests: happy path posts the event, a closed DM names the error, cancel keeps the channel clean, a phase-2 question is absent when phase 2 is off.

## 12.7 Retire `/eventreminder`

Feature 2 stays the contract for configs already in `event_reminder_*`. This section is the plan for stopping new ones. Bot-owned events are the create path from the day `/event` ships (E13). Retirement of the old command waits until a new event can do what an old config can do.

Parity, all required before `/eventreminder create` is refused:

| Already shipped on `/eventreminder` | Where the new event covers it |
|-------------------------------------|--------------------------------|
| One or more offsets before start, one message each | Phase 1 (one reminder), phase 2 (up to 8, custom message) |
| Guild opt-out / opt-in | Phase 1, shared row (E14) |
| Mute / unmute one event | Phase 1 |
| Ping a role, not a list of user mentions | Phase 1 temporary attendee role (E14) |
| Start time moves → unsent fires move | Phase 1 edit |
| ManageGuild or the event’s creator may configure | E4. The “event creator” becomes the bot-event organizer, since Discord’s `creatorId` no longer applies |
| Persistent config survives the occurrence | Phase 3 series. A persistent old config is not converted; staff recreate it with `/event` if they want it to continue |
| `/eventreminder status` | `/event reminders status` lists guild opt-out, mutes, and roles held |

- [ ] Check the parity table above against the running bot. Do not refuse `/eventreminder create` while any row is still unmet.
- [ ] `/eventreminder create` then replies that new events are made with `/event create` or `/event wizard`, and it does not insert a config. `edit`, `list`, `clear`, `sync`, `setchannel`, and the opt-out family keep working for rows already stored.
- [ ] `/event adopt` (optional, staff or the native event’s creator): copy title, scheduled start, description, and location from a Guild Scheduled Event into a **draft** bot-owned event. Do not copy Interested users. Staff review the draft and post it. The old reminder config is left untouched until they clear it.
- [ ] When a guild has no active feature-2 configs left, `/eventreminder` opt-out verbs become aliases of `/event reminders` and the other subcommands reply that nothing is left to manage.
- [ ] Docs: `docs/event-reminders.md` and the commands index describe the old command as legacy, and point new setups at `/event`.

## Schema sketch

Not a migration. Names can change. Reserve the id when the first phase is implemented.

- `events` — guild, channel, message id, thread id, creator, title, description, location, start, end, image, color, recurrence id, post_at, status (draft / scheduled / posted / archived), flags (multiple signups, attendee role, private thread).
- `event_options` — event, label, emoji, capacity, position, reminders_on, waitlist_on, role whitelist.
- `event_signups` — event, option, user, state (signed_up / waitlisted), created_at, updated_by.
- `event_reminders` — event, offset or absolute fire time, custom message, target (attendees or a role id), sent_at, error. Unsent rows are rewritten when `events.start` changes (E14).
- `event_mutes` — guild, event, user. Not the same table as `event_reminder_event_optouts`, which is keyed by a Discord scheduled-event id.
- Guild opt-out stays `event_reminder_optouts` through the overlap, written by both `/event reminders` and `/eventreminder optout`. A later migration may rename it once [12.7](#127-retire-eventreminder) has finished. Do not add a second flag.
- `event_series` — cadence, weekdays or month rule, end condition, next occurrence, status.
- `event_presets` and `event_preset_options` — guild-level saved option groups.
- `event_channels` — guild channel marked as an event channel, plus purge flag.
- `event_guild_settings` — default reminder, show attendees, auto-archive and its delay, role gates, digest channel. Columns on `guild_settings` are fine if they stay few; a side table is better once phase 3 lands.
- `event_activity` — event, actor, action, detail, created_at. Phase 4 can be the first writer; earlier phases should still record signup and edit rows so the log is not empty on day one of the dashboard.
- `event_google_links` and `event_crossposts` — phase 5 only. Do not create them early.

Services return `{ ok: false, error }` and do not talk to Discord. Handlers turn `error` into the reply text. Button handlers, the scheduler callback, and any post-retry notification each catch their own failures and log `[events] …` with guild id and event id.

## Verification

Each phase lands with `npm test` green, including `test/commandVisibility.test.js` once `/event` is registered. Phase 4 also needs a browser pass through the new pages (create, edit, archive, empty month, a member who cannot see the channel). Docs changes that add links run `npm run docs:build`.

## See also

- [event-reminders.md](event-reminders.md) — shipped behavior for configs that already exist. Retirement is [12.7](#127-retire-eventreminder).
- [web-admin.md](web-admin.md) — sessions, audit, and guild pages this dashboard extends.
- [staff-roles.md](staff-roles.md) — staff gate used when a member is not the event creator.
