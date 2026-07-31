# Boiler Snake Roadmap

## Project Overview

Boiler Snake is a Discord bot for XP tracking, voice activities, YouTube notifications, role management, honeypots, scheduled-event reminders, and (planned) help tickets and Twitch stream notifications. This roadmap documents **planned** features and their implementation stages.

**Shipped (see docs, not tracked here):** XP/leveling, voice XP, decay, level roles, reaction roles, YouTube notifications, command-channel restrictions, audit/message logs, honeypot channels & ban roles, scheduled event reminders.

---

## 1. Help Ticket System

### Purpose

Ephemeral per-server ticket support: members open private channels with staff, staff respond, then **non-sensitive** tickets are closed and **archived** (AI summary + HTML transcript served by the bot). **Sensitive** tickets are never archived—content is destroyed with the channel.

### Status

**Planned** — design decisions locked (see [1.10](#110-design-decisions-locked)); ready to implement once implementation is scheduled.

---

### 1.1 Configuration

| Command | Description |
|---------|-------------|
| `/ticket setstaff <role>` | Role that counts as staff for tickets (access + staff commands) |
| `/ticket unsetstaff` | Clear staff role (falls back to members with `ManageGuild`) |
| `/ticket setcategory <category>` | Category where ticket channels are created |
| `/ticket setarchive <channel>` | Channel that receives close-summary embeds + transcript links (staff-only channel recommended) |
| `/ticket setratelimit <minutes>` | Min minutes between self-created tickets per user (default **60** = 1/hour). `0` = disable |
| `/ticket settings` | Show current ticket configuration |

**Stored in `guild_settings`:**

| Column | Purpose |
|--------|---------|
| `ticket_staff_role` | Optional staff role ID |
| `ticket_category_id` | Parent category for open tickets |
| `ticket_archive_channel_id` | Staff-visible channel for archive posts |
| `ticket_rate_limit_minutes` | Cooldown for member self-create; default `60` |

**Later (not MVP):** panel channel + persistent “Open ticket” button message ID (see [1.2](#12-ticket-creation)).

---

### 1.2 Ticket Creation

| Command | Who | Description |
|---------|-----|-------------|
| `/ticket create [reason]` | Any member | Open a ticket for yourself (subject to rate limit) |
| `/ticket for <user> [reason]` | Staff | Pull a member into a **new** ticket (staff-initiated; **not** rate-limited like self-create) |

**MVP create UX:** slash commands only.

**Later UX:** staff posts a panel (`/ticket panel` or similar) with an “Open ticket” button → Discord **modal** for initial description → creates ticket. Same pipeline as `/ticket create`.

**On create:**

1. Enforce rate limit for **member self-create** only (`/ticket create` / future panel). Staff `/ticket for` bypasses member cooldown. **No cap** on concurrent open tickets per user.
2. Allocate next sequential `ticket_number` per guild.
3. Create channel `ticket-<NUMBER>` under the configured category (if set).
4. Apply permission overwrites (see [1.3](#13-permissions--sensitive-tickets)).
5. Persist row in `tickets` (`status = open`, `is_sensitive = 0`).
6. Post welcome embed in the ticket (reason, creator, ticket #).
7. If `/ticket for`: DM the target member with a channel link (if DMs open); post a note in-channel (“Opened for @user by @staff”).

**Rate limit default:** 1 ticket per **60 minutes** per user per guild for self-create. Configurable via `/ticket setratelimit`. Based on `tickets.created_at` of that user’s last created ticket (any status), or last self-create only—prefer last **self-created** ticket timestamp.

---

### 1.3 Permissions & Sensitive Tickets

#### Default (non-sensitive) open ticket

| Subject | Access |
|---------|--------|
| `@everyone` | Deny `ViewChannel` |
| Ticket **members** (creator + users added via `/ticket adduser`) | Allow view, send, attach, history; deny manage messages |
| **Staff role** (or ManageGuild holders if role unset—prefer explicit role) | Full staff access (view, send, manage messages, etc.) |
| Bot | Full channel management |

Any staff with the role can join and help.

#### Sensitive ticket

Locks visibility to:

- **Staff owner** (claimer / transfer target)
- **Additional named staff** added via `/ticket addstaff` (user overwrites only—not the whole staff role)
- **Member users** of the ticket (creator + `/ticket adduser`)
- **Bot**

Everyone else, including other staff-role members, **cannot** view the channel.

| Command | Description |
|---------|-------------|
| `/ticket claim` | Become staff owner (sets `staff_owner_id`; always allowed on open tickets) |
| `/ticket transfer <staff>` | Reassign staff owner; update overwrites if sensitive |
| `/ticket addstaff <user>` | Allow-list another staff user on this ticket (especially useful when sensitive) |
| `/ticket removestaff <user>` | Remove a named staff allow-list entry (cannot remove last owner without transfer) |
| `/ticket sensitive` | Mark sensitive and **rewrite overwrites**. Requires a staff owner: if none, **auto-claim** the invoker; if invoker is not owner and owner exists, only owner (or ManageGuild—see below) may flip |
| `/ticket unsensitive` | Restore default staff-role visibility. **Staff owner** or **ManageGuild** only |

**Overwrite strategy when sensitive:**

1. Keep `@everyone` deny view.
2. **Remove allow / explicitly deny** the staff role on this channel.
3. Allow only: each ticket member user + staff owner + each `/ticket addstaff` user + bot.
4. Set `is_sensitive = 1` on the ticket row.

**Ownership model (locked):**

- Prefer `/ticket claim` before sensitive work; `/ticket sensitive` **auto-claims** the invoker if `staff_owner_id` is null.
- Multiple staff: `/ticket addstaff` adds named users without restoring the staff role.
- `/ticket transfer` moves ownership and updates overwrites.

---

### 1.4 Staff & Lifecycle Commands

| Command | Description |
|---------|-------------|
| `/ticket close [reason]` | Close ticket (archive only if **not** sensitive—see [1.5](#15-close--archive-pipeline)) |
| `/ticket adduser <user>` | Add a member participant |
| `/ticket removeuser <user>` | Remove a member participant (creator removal: staff only; optional block) |
| `/ticket claim` | Set yourself as staff owner |
| `/ticket transfer <staff>` | Reassign staff owner |
| `/ticket addstaff` / `/ticket removestaff` | Named staff allow-list |
| `/ticket sensitive` / `/ticket unsensitive` | Toggle lock-down |
| `/ticket list [user]` | Active tickets (staff) |
| `/ticket info` | Ticket #, status, sensitive, owner, members (in-channel) |
| `/ticket for <user> [reason]` | Staff: open ticket for a member |

---

### 1.5 Close → Archive Pipeline

Staff only, in a ticket channel.

#### Branch A — Sensitive ticket (**no content archive**; metadata stub required)

Sensitive tickets **must not** be content-archived. On `/ticket close`:

```
1. Update DB  — status=closed, closed_at, closed_by, close_reason; is_sensitive remains 1; archived=0
2. No fetch   — do not paginate or store messages
3. No HTML    — do not write transcript files
4. No AI      — do not send content to any LLM
5. No URL     — transcript_token / path stay null
6. Stub post  — required: post a minimal, non-content embed in the archive channel, e.g.
              “Ticket #42 closed (sensitive — not archived)” with closer, requester,
              timestamps, and close reason only. No transcript link, no message excerpts.
7. Delete     — delete the live Discord channel
8. Optional DM to requester — “Your ticket was closed” only; never include a transcript link
```

Rationale: privacy. Channel deletion is the disposal mechanism; DB + archive stub retain metadata only (who/when/sensitive flag), not conversation content.

#### Branch B — Non-sensitive ticket (full archive)

```
1. Freeze   — optional: deny send while archiving
2. Fetch    — paginate all channel messages (oldest → newest)
3. Persist  — store structured messages in ticket_messages (+ ticket meta)
4. Render   — generate HTML transcript on disk
5. Summarize— AI structured summary (or stats fallback if no AI key)
6. Publish  — post embed to ticket_archive_channel with summary + transcript URL
              (staff channel only; never DM transcript URL to members)
7. Delete   — delete the live Discord channel
8. Notify   — optional DM to requester: closed + reason only, **no** transcript URL
```

#### HTML transcript (bot-served)

- **Render:** standalone HTML — ticket meta, participants, chronological messages, **hotlinked** attachment URLs, timestamps.
- **Store:** `{DATA_DIR}/ticket-transcripts/{guild_id}/{uuid}.html` (UUID matches public token).
- **Serve:** small HTTP server in the bot process:
  - Path: `/t/{uuid}` (UUID v4)
  - Config: `TICKET_HTTP_PORT`, `TICKET_PUBLIC_BASE_URL` (public origin for embeds; reverse-proxy TLS documented for operators)
- **Access control (MVP):**
  - UUID in the path (unguessable).
  - Link posted **only** in the configured **staff** archive channel.
  - Members / requesters **never** receive the transcript URL.
  - **Later:** “Login with Discord” gate so only staff can load `/t/{uuid}` even with the link.
- **Attachments (MVP):** hotlink Discord CDN URLs in the HTML.  
  **TODO (post-MVP):** at close time, download all thread assets into  
  `{DATA_DIR}/ticket-transcripts/{guild_id}/{uuid}/assets/` and rewrite HTML to local paths (CDN links expire).

#### AI-generated structured summary

Only for **non-sensitive** closes. Posted as embed fields in the archive channel (plus transcript link).

| Field | Example |
|-------|---------|
| Ticket # | `#42` |
| Subject / reason | Open reason |
| Requester | `@user` |
| Staff owner | `@mod` |
| Opened / closed | timestamps + duration |
| Message count | N |
| Close reason | Staff-provided |
| Resolution | AI one-liner (or close reason if no AI) |
| Summary | AI multi-sentence narrative |
| Transcript | `[View HTML transcript](https://…/t/{uuid})` — staff archive only |

**Provider:** env-based OpenAI-compatible API (e.g. SpaceXAI). If no API key: non-AI fallback (stats + close reason + short excerpt). Sensitive path never calls the provider.

```bash
# Ticket transcript HTTP
TICKET_HTTP_PORT=8080
TICKET_PUBLIC_BASE_URL=https://tickets.example.com

# Optional AI summarization (non-sensitive archives only)
AI_API_KEY=
AI_BASE_URL=
AI_MODEL=
```

Docker: publish transcript port; persist `{DATA_DIR}/ticket-transcripts` on the existing data volume.

#### Archive channel message (non-sensitive)

- Channel: `ticket_archive_channel_id` (must be staff-only in Discord permissions—bot cannot enforce “staff eyes only” on Discord itself beyond recommending this).
- Embed: structured summary + transcript URL.
- On partial failure: still prefer HTML on disk + DB close row; post “summary unavailable” if AI fails; alert closer if archive channel missing.

#### Archive channel message (sensitive — required stub)

- Same channel, **metadata only**, clearly labeled **not archived** / **sensitive**.
- No link, no content, no AI.
- If archive channel is unset, still close + delete; warn the closer that the stub could not be posted.

---

### 1.6 Database Schema (working draft)

```sql
CREATE TABLE IF NOT EXISTS tickets (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id           TEXT NOT NULL,
    ticket_number      INTEGER NOT NULL,
    channel_id         TEXT UNIQUE,
    creator_user_id    TEXT NOT NULL,
    staff_owner_id     TEXT,
    status             TEXT NOT NULL DEFAULT 'open',  -- open | closed
    is_sensitive       INTEGER NOT NULL DEFAULT 0,
    reason             TEXT,
    close_reason       TEXT,
    created_at         INTEGER NOT NULL,
    closed_at          INTEGER,
    closed_by_user_id  TEXT,
    -- Archive fields: NULL when sensitive or not yet closed
    transcript_token   TEXT UNIQUE,   -- UUID v4 for /t/{uuid}
    transcript_path    TEXT,          -- relative path under DATA_DIR
    archive_message_id TEXT,
    ai_summary_json    TEXT,
    archived           INTEGER NOT NULL DEFAULT 0,  -- 1 only if full archive ran
    UNIQUE (guild_id, ticket_number)
);
CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets(guild_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_creator ON tickets(guild_id, creator_user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_creator_created ON tickets(guild_id, creator_user_id, created_at);

-- Member participants (creator may also be listed or implied via creator_user_id)
CREATE TABLE IF NOT EXISTS ticket_members (
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    added_at    INTEGER NOT NULL,
    added_by    TEXT,
    PRIMARY KEY (ticket_id, user_id)
);

-- Named staff allow-list (owner + addstaff); used heavily when sensitive
CREATE TABLE IF NOT EXISTS ticket_staff (
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    is_owner    INTEGER NOT NULL DEFAULT 0,
    added_at    INTEGER NOT NULL,
    added_by    TEXT,
    PRIMARY KEY (ticket_id, user_id)
);

-- Message log only for archived (non-sensitive) tickets
CREATE TABLE IF NOT EXISTS ticket_messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id        INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    message_id       TEXT NOT NULL,
    author_id        TEXT NOT NULL,
    author_tag       TEXT NOT NULL,
    content          TEXT,
    attachment_urls  TEXT,   -- JSON array of hotlinked CDN URLs (MVP)
    embeds_json      TEXT,
    sent_at          INTEGER NOT NULL,
    UNIQUE (ticket_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);

-- guild_settings:
--   ticket_staff_role TEXT
--   ticket_category_id TEXT
--   ticket_archive_channel_id TEXT
--   ticket_rate_limit_minutes INTEGER NOT NULL DEFAULT 60
```

---

### 1.7 db.js API (sketch)

- `getTicketSettings(guildId)` / `updateTicketSettings(guildId, patch)`
- `canUserCreateTicket(guildId, userId)` → rate-limit check using `ticket_rate_limit_minutes`
- `createTicket({ guildId, creatorUserId, channelId, reason, openedByStaffId? })`
- `getTicketByChannel` / `getTicketByNumber` / `getTicketByTranscriptToken(uuid)`
- `claimTicket` / `transferTicket` / `addTicketStaff` / `removeTicketStaff`
- `setTicketSensitive` / `setTicketUnsensitive`
- `addTicketMember` / `removeTicketMember` / `listTicketMembers`
- `listOpenTickets(guildId, { userId? })`
- `closeTicketSensitive(ticketId, { closedBy, closeReason })` — metadata only, `archived=0`
- `closeTicketArchived(ticketId, { closedBy, closeReason, transcriptToken, transcriptPath, aiSummaryJson, archiveMessageId })` — `archived=1`
- `saveTicketMessages(ticketId, messages[])`

---

### 1.8 Event Handlers

| Event | Purpose |
|-------|---------|
| Slash (+ later button/modal) | Create, for, close, sensitive, claim, adduser, addstaff |
| `ChannelDelete` | If ticket channel deleted outside `/ticket close`: mark `closed`, `archived=0`, no salvage for sensitive intent; non-sensitive best-effort only if we still have cache (usually not) |

Channel create is **bot-driven**.

---

### 1.9 Implementation Order

1. **Schema + settings** — migrations; setstaff / setcategory / setarchive / setratelimit / settings  
2. **Create paths** — `/ticket create`, `/ticket for`, overwrites, rate limit  
3. **Claim / adduser / addstaff / sensitive** — overwrite rewrite  
4. **Close (sensitive branch)** — metadata + required archive-channel stub + delete channel  
5. **Close (archive branch)** — fetch, HTML, UUID route HTTP server, archive embed (stats fallback)  
6. **AI summary** — non-sensitive only; graceful fallback  
7. **Post-MVP** — panel + modal; Discord OAuth on `/t/{uuid}`; **TODO: download/mirror attachments** into transcript assets  

---

### 1.10 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Ownership:** claim / auto-claim on sensitive; `/ticket transfer`; `/ticket addstaff` for extra named staff without restoring staff role |
| 2 | **Sensitive tickets are never content-archived** — no message fetch, no HTML, no AI, no transcript URL; channel delete is disposal; **required** metadata-only archive stub |
| 3 | **Transcript URL is staff-only** — posted only to the ticket archive channel; never DMed to members/requesters |
| 4 | **MVP URL security:** UUID path `/t/{uuid}`; **later:** Login with Discord for real access control |
| 5 | **Attachments MVP:** hotlink Discord CDN URLs; **TODO:** download all thread assets at archive time and serve locally |
| 6 | **Create UX:** slash `/ticket create` + staff `/ticket for @user` first; **later** panel button → modal for description |
| 7 | **Rate limit:** configurable per guild; **default 60 minutes** (1 self-create per hour); staff `/ticket for` not subject to member cooldown |
| 8 | **No concurrent open-ticket cap** per user — rate limit only throttles new self-creates |
| 9 | **Sensitive close stub required** in the archive channel (metadata only; no transcript) |
| 10 | **`/ticket unsensitive`:** staff **owner** or any member with **ManageGuild** |

---

## 2. Scheduled Event Reminders

### Purpose

Send configurable pre-event reminder pings for Discord’s built-in **Guild Scheduled Events**. Only users who marked **Interested** on the event are notified (via a per-event role). Anyone can **opt out** of reminder pings globally (per guild).

### Status

**Shipped** — implemented in `src/features/eventReminders/` (see [docs/event-reminders.md](docs/event-reminders.md)). Design decisions in [2.11](#211-design-decisions-locked) remain the product contract.

---

### 2.1 Core behavior

```
Authorized user links reminders to a Discord scheduled event
        → bot creates role event-<shortname>
        → syncs role to current “Interested” users (minus opt-outs)
        → keeps role in sync on interest add/remove
        → at each configured offset before start, posts ONE message mentioning @event-<shortname>
        → when event completes/cancels (or manual clear): delete role + deactivate config
          (cleanup prevents shortname/role collisions for future events)
```

| Rule | Detail |
|------|--------|
| Audience | Only members who are **Interested** on that scheduled event |
| Opt-out | **Guild-wide** per user (MVP); skips role grant and thus pings. Per-event opt-out = post-MVP |
| Ping mechanism | Mention dedicated role `event-<shortname>` (not mass user mentions) |
| Timing | Relative offsets before the event’s scheduled start (e.g. 1d, 1h, 15m) |
| Delivery | **One Discord message per offset** (not a digest) |
| Create UX | Slash picks the event → **modal** configures shortname, offsets, channel, message |
| Who may configure | **ManageGuild** **or** the Discord scheduled event’s **creator** |
| Role lifecycle | Create on setup; **delete after event is done** (completed/canceled) or on `/clear` |

---

### 2.2 Commands

#### Staff / event creator

| Command | Description |
|---------|-------------|
| `/eventreminder create` | Pick a scheduled event (autocomplete) → **opens modal** to configure reminders |
| `/eventreminder edit` | Re-open config for an existing linked event (modal; see component notes) |
| `/eventreminder list` | List active configs (offsets, channel, role, next fire) |
| `/eventreminder clear <event>` | Stop reminders, delete `event-*` role, remove/deactivate DB rows |
| `/eventreminder sync <event>` | Re-fetch interested users and reconcile role membership |
| `/eventreminder setchannel [channel]` | Default guild channel for reminder posts (overridable per config in modal) |

**Permission gate:** invoker has `ManageGuild` **or** `invoker.id === scheduledEvent.creatorId` (event creator). Edit/clear/sync for a given event: same rule (ManageGuild or that event’s creator). `setchannel` is guild-wide → **ManageGuild only**.

#### Everyone

| Command | Description |
|---------|-------------|
| `/eventreminder optout` | Opt out of **all** event reminder roles/pings in this guild |
| `/eventreminder optin` | Re-enable reminders; re-sync roles for events you are still Interested in |
| `/eventreminder status` | Show opt-out state; list event roles you currently hold (optional) |

Ephemeral replies for opt-out/opt-in/status.

---

### 2.3 Create flow (modal) & Discord UI limits

#### What Discord modals can and cannot do

| Control | In modals today? | Notes |
|---------|------------------|--------|
| **Date / time picker** | **No** | Not available on modal forms (still a requested platform feature). |
| **Text input** | Yes | Short or paragraph. |
| **String select (dropdown)** | Yes | Up to 25 options; multi-select supported. Ideal for preset offsets. |
| **Channel / user / role select** | Yes | Good for notify-channel override. |
| **Labels / text display** | Yes | Help text inside the modal. |

We do **not** need absolute date/time pickers for MVP: reminders are **offsets relative to the event’s existing start time** (Discord already owns the event schedule). Absolute “remind at 3:00 PM” would be a later enhancement and would use a **text field** (parse ISO / human time) or a multi-step message UI—not a native date picker.

#### Recommended modal layout (MVP)

1. User runs `/eventreminder create event:<scheduled event>` (ManageGuild **or** event creator).
2. Bot validates: event exists, scheduled (not completed/canceled), not already configured (else point to `edit`).
3. Bot shows modal `Reminders: {event name}`:

| Component | Purpose | Example |
|-----------|---------|---------|
| **Text** `shortname` | Role suffix; prefilled with slug of event title | `raid-friday` → `event-raid-friday` |
| **String select** `offsets` (multi) | Preset times before start | `1 week`, `1 day`, `1 hour`, `30 min`, `15 min`, `5 min` — **default selection:** `1 day`, `1 hour`, `15 min` |
| **Text** `offsets_custom` (optional) | Extra freeform offsets | `2h, 10m` grammar `(\d+)(m\|h\|d)` |
| **Channel select** `channel` (optional) | Notify channel override | empty / unset → guild default |
| **Text** `message` (optional) | Custom body; placeholders `{event}`, `{starts_in}`, `{role}` | default template if empty |

4. On submit:
   - Union selected presets + parsed custom offsets; dedupe; reject empty set; cap count (e.g. 8) and max lookback (e.g. 30d).
   - Compute `fire_at = eventStart - offset` for each; drop offsets that are already in the past (or warn and skip).
   - Create role `event-<shortname>` (`mentionable: false` preferred; bot still pings by ID). Hoist off.
   - Persist config + one **offset row** per fire (each gets its **own message** when due).
   - Fetch interested users, skip guild opt-outs, assign role.
   - Ephemeral confirm: role, offsets, channel, computed fire times.

**Shortname rules:** lowercase `[a-z0-9-]`; unique among **active** configs in the guild. After event cleanup deletes the role and frees the shortname.

**Collision fallback:** if an orphaned `event-*` role still exists (manual rename, failed cleanup), delete/reuse only roles the bot created and tracked in DB; otherwise error with “role name in use—clear or pick another shortname.”

---

### 2.4 Who gets pinged

1. User marks **Interested** → `GuildScheduledEventUserAdd` → if config active and not opted out → grant `event-*` role.
2. User removes interest → remove role.
3. `/eventreminder optout` → guild opt-out flag; **strip all bot-managed event reminder roles** for that guild; future sync skips them.
4. `/eventreminder optin` → clear flag; re-grant for events they are still Interested in.

Pings are `@event-<shortname>` in the notify channel. Only role holders are notified. Opt-out users never hold the role.

---

### 2.5 Delivery ticker & cleanup

- Background **node-cron** every **60s** (`* * * * *`; shipped).
- Query pending rows: `fire_at <= now` and `sent_at IS NULL`.
- For each due offset (**one message per offset**):
  1. Resolve channel, role, event; skip if missing/canceled.
  2. Post message (template or default with `<t:unix:R>` / `<t:unix:F>` + role mention).
  3. Set `sent_at` + `message_id`.
- **Post-event cleanup (required):** when the scheduled event is **completed** or **canceled** (gateway update/delete), or after start + all offsets handled as a safety net:
  1. Delete the Discord role `event-<shortname>`.
  2. Mark config `active = 0` (or delete rows).
  3. Free shortname for future events → **prevents role collisions**.
- Manual `/eventreminder clear` runs the same role deletion path.

**Reschedule:** if event start time changes, recompute all **unsent** `fire_at` from new start − offsets.

---

### 2.6 Guild settings & permissions

| Setting | Purpose |
|---------|---------|
| `event_reminder_channel_id` | Default notify channel |

**Configure reminders:** `ManageGuild` **or** scheduled event **creator** (`creatorId`).  
**Set default channel:** `ManageGuild` only.

**Bot needs:** Manage Roles (create/assign/delete; bot role above `event-*`), Send Messages + permission to mention roles in notify channel, scheduled-event subscriber API access.

Gateway: `GuildScheduledEventUserAdd` / `Remove` / `Update` / `Delete`.

---

### 2.7 Database schema (working draft)

```sql
-- guild_settings.event_reminder_channel_id TEXT

CREATE TABLE IF NOT EXISTS event_reminder_configs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id              TEXT NOT NULL,
    scheduled_event_id    TEXT NOT NULL,
    shortname             TEXT NOT NULL,          -- role suffix without "event-"
    role_id               TEXT NOT NULL,
    channel_id            TEXT,                   -- null = guild default
    message_template      TEXT,
    active                INTEGER NOT NULL DEFAULT 1,
    created_at            INTEGER NOT NULL,
    created_by            TEXT NOT NULL,
    UNIQUE (guild_id, scheduled_event_id),
    UNIQUE (guild_id, shortname)
);

CREATE TABLE IF NOT EXISTS event_reminder_offsets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id      INTEGER NOT NULL REFERENCES event_reminder_configs(id) ON DELETE CASCADE,
    offset_minutes INTEGER NOT NULL,              -- minutes before start
    fire_at        INTEGER NOT NULL,              -- ms epoch absolute
    sent_at        INTEGER,                       -- null until that offset's message is posted
    message_id     TEXT                           -- that offset's reminder message
);
CREATE INDEX IF NOT EXISTS idx_event_reminder_due
  ON event_reminder_offsets(fire_at) WHERE sent_at IS NULL;

CREATE TABLE IF NOT EXISTS event_reminder_optouts (
    guild_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    opted_out_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);
```

Note: `UNIQUE (guild_id, shortname)` applies to all rows; if we soft-deactivate with `active=0`, either delete inactive configs on cleanup or use a partial unique index / include only active rows in uniqueness logic (prefer **delete role + delete or rename shortname on cleanup** so the unique constraint stays simple).

---

### 2.8 db.js / module API (sketch)

- `getEventReminderSettings(guildId)` / default channel helpers
- `createEventReminderConfig({ guildId, eventId, shortname, roleId, channelId, template, offsets[], createdBy })`
- `listEventReminderConfigs(guildId)`
- `clearEventReminderConfig(guildId, eventId)` → returns `role_id` for deletion
- `setOffsetFireTimes(configId, eventStartMs)` — recompute unsent fires
- `claimDueReminders(now, limit)` — due unsent offsets
- `markReminderSent(offsetId, messageId)`
- `isEventReminderOptedOut` / `setEventReminderOptOut` / `clearEventReminderOptOut`
- `getConfigByScheduledEventId(guildId, eventId)`
- `canConfigureEventReminder(member, scheduledEvent)` → ManageGuild or creator

Implementation module: `src/eventReminders.js` (ticker + role sync + delivery + cleanup).

---

### 2.9 Event handlers

| Event / trigger | Action |
|-----------------|--------|
| Modal submit (create / edit) | Role + config + offsets + initial subscriber sync |
| `guildScheduledEventUserAdd` | Grant role if active and not opted out |
| `guildScheduledEventUserRemove` | Remove role |
| `guildScheduledEventUpdate` | Start time change → recompute unsent `fire_at`; completed/canceled → **cleanup role + config** |
| `guildScheduledEventDelete` | **Cleanup role + config** |
| Interval ticker | Deliver due offsets (**one message each**); safety cleanup after event end |
| `/eventreminder optout` / `optin` | Toggle DB + strip or re-sync roles |

---

### 2.10 Implementation order

1. Schema + opt-out / opt-in / status  
2. Create + modal (presets select + custom text + channel select) + permission gate (ManageGuild \| creator)  
3. Role create + subscriber sync  
4. Gateway interest add/remove  
5. Ticker + **one message per offset**  
6. **Post-event role cleanup** (update/delete + clear command)  
7. Edit / list / sync / setchannel polish  

---

### 2.11 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Modal UI:** no native date/time pickers on Discord modals. Use **relative offsets** (string **multi-select presets** + optional custom text). Channel override via **channel select**. Absolute datetimes not required for MVP. |
| 2 | **One message per offset** (not a digest). |
| 3 | **Permission:** `ManageGuild` **or** the scheduled event’s **creator**. Guild default channel: ManageGuild only. |
| 4 | **Role cleanup after event completes/cancels** (and on clear) — primary defense against shortname/role collisions. |
| 5 | **Opt-out:** guild-wide for MVP; per-event opt-out post-MVP. |
| 6 | **Default preset selection** in modal: `1 day`, `1 hour`, `15 min` (user can change). |

**Still minor (non-blocking):**

- Role `mentionable: false` vs true (recommend **false**; bot mentions by snowflake).
- Exact preset list beyond the defaults above.

---

## 3. Twitch Stream Notifications

### Purpose

Notify a guild when any subscribed Twitch channel goes live. Supports **any number of channels** per guild, posts to a configurable Discord channel, and optionally **pings a guild-configurable role** that is **independent of YouTube** notification roles (`youtube_upload_role_id` and any future YouTube live role).

### Status

**Planned** — design decisions locked (see [3.8](#38-design-decisions-locked)); ready to implement once scheduled. Patterned after the shipped YouTube feature (`src/features/youtube/`).

---

### 3.1 Core behavior

```
Admin adds one or more Twitch logins
        → bot resolves login → broadcaster user id (Helix)
        → ticker polls Helix streams for subscribed broadcasters
        → on transition offline → live: post embed to notify channel
        → if twitch_notify_role_id set: mention that role on the message
        → record last_stream_id / is_live so the same stream is not re-announced
```

| Rule | Detail |
|------|--------|
| Scope | **Go-live only** (MVP). No go-offline, no VODs, no follows/clips |
| Channels | **Any number** of Twitch channels per guild (same broadcaster may be tracked in multiple guilds) |
| Notify channel | Per-guild `twitch_notification_channel_id` — **separate** from YouTube’s channel |
| Role ping | Optional per-guild `twitch_notify_role_id` — **separate** from `youtube_upload_role_id` |
| No role | If role unset, post embed with no role mention (do **not** fall back to YouTube role or `@everyone`) |
| Dedup | Track `last_stream_id` (and/or `is_live`) per subscription; notify only on offline→live transition for a new stream id |
| Auth | Helix app access token via Client Credentials (`TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET`) |
| Permission | Config / subscribe commands: **ManageGuild** (same as YouTube) |

---

### 3.2 Commands

#### Channel subscriptions

| Command | Description |
|---------|-------------|
| `/twitch add login:<name\|url>` | Subscribe to a Twitch channel (login, `https://twitch.tv/…`, or bare username) |
| `/twitch remove channel:<…>` | Unsubscribe (autocomplete over guild subscriptions) |
| `/twitch list` | List subscribed channels + notify channel / role status |

#### Guild configuration

| Command | Description |
|---------|-------------|
| `/settwitch channel <channel>` | Discord channel for go-live posts |
| `/settwitch role [role]` | Role to mention on go-live (omit or clear to disable pings) |
| `/settwitch interval <minutes>` | Polling interval 1–60 (default **2** — streams are more time-sensitive than YT uploads) |
| `/settwitch settings` | Show current channel, role, interval, and subscription count |

**Optional (nice-to-have in same PR or follow-up):** `/testtwitchnotification` mirroring `/testnotification` for YouTube.

**Not in MVP:** per-channel Discord channel override, per-channel role override, custom message templates.

---

### 3.3 Notification content

On go-live, post to the configured Discord channel:

- **Content line:** optional `<@&roleId> ` prefix when `twitch_notify_role_id` is set
- **Embed** (purple/Twitch brand, e.g. `#9146FF`):
  - Title / name: `{display_name} is live!`
  - Description: stream title
  - URL: `https://twitch.tv/{login}`
  - Thumbnail or preview image when Helix provides one
  - Footer / fields: game/category name if available

One Discord message per newly detected live stream (not a digest of multiple channels in one message).

**Allowed mentions:** when posting, set `allowedMentions: { roles: [roleId] }` so only the configured Twitch role is pinged.

---

### 3.4 Polling ticker (MVP)

Module layout (mirror YouTube):

| Path | Responsibility |
|------|----------------|
| `src/features/twitch/index.js` | Slash commands, handlers, registration export |
| `src/features/twitch/ticker.js` | Helix auth + stream poll loop + send notification |

**Ticker loop:**

1. Load all guilds with ≥1 `twitch_channels` row and a set `twitch_notification_channel_id`.
2. Batch Helix `GET /helix/streams?user_id=` (up to Helix’s multi-id limit per request) across unique broadcaster ids.
3. For each subscription:
   - If stream present and `stream.id !== last_stream_id` (or was not live): send notification; set `is_live=1`, `last_stream_id`, `last_checked`.
   - If stream absent and was live: set `is_live=0`, update `last_checked` (no Discord message).
4. Honor per-guild `twitch_polling_interval_minutes` (or a single process interval = min of configured guilds, then gate per guild by last run—same practical approach as YouTube is fine).

**Startup:** skip ticker if `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` missing; log once (same pattern as YouTube without `YOUTUBE_API_KEY`).

**Env vars:**

```bash
TWITCH_CLIENT_ID=...
TWITCH_CLIENT_SECRET=...
```

App registration: [Twitch Developer Console](https://dev.twitch.tv/console) → application → Client Credentials grant (no user OAuth for MVP).

---

### 3.5 Database schema (working draft)

**`guild_settings` columns:**

| Column | Purpose |
|--------|---------|
| `twitch_notification_channel_id` | Discord channel for go-live posts |
| `twitch_notify_role_id` | Optional role to mention (null = no ping) |
| `twitch_polling_interval_minutes` | Default **2**; clamp 1–60 |

**`twitch_channels` table:**

```sql
CREATE TABLE IF NOT EXISTS twitch_channels (
  guild_id TEXT NOT NULL,
  broadcaster_id TEXT NOT NULL,     -- Twitch user id (stable)
  login TEXT NOT NULL,              -- lowercase login
  display_name TEXT NOT NULL,
  profile_image_url TEXT,
  is_live INTEGER NOT NULL DEFAULT 0,
  last_stream_id TEXT,             -- Helix stream id; dedup go-live
  last_checked INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, broadcaster_id),
  UNIQUE (guild_id, login)
);
```

**Repositories / db facade (sketch):**

- `getTwitchChannels(guildId)` / `addTwitchChannel(...)` / `removeTwitchChannel(guildId, broadcasterId)`
- `updateTwitchChannelLiveState(guildId, broadcasterId, { isLive, lastStreamId, lastChecked })`
- `listAllTwitchSubscriptions()` for the ticker
- `updateGuildSettings` keys for the three `twitch_*` settings

---

### 3.6 Integration points

| Area | Change |
|------|--------|
| `src/features/twitch/` | New feature module (commands + ticker) |
| `src/commands/` registry | Register `/twitch`, `/settwitch`, autocomplete for remove |
| `src/index.js` / client startup | Start Twitch ticker beside YouTube ticker |
| `src/db/` | Migration for columns + table; repository + facade exports |
| Docs | `docs/twitch-notifications.md` (mirror `docs/youtube-notifications.md`) |
| `.env.example` | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` |
| Audit log | Config changes for channel / role / interval (same style as YouTube) |

**Bot permissions:** Send Messages + Embed Links in the notify channel; ability to mention the configured role (role must be mentionable **or** bot uses role id mention with `allowedMentions` — prefer id mention without requiring the role to be open-mentionable).

---

### 3.7 Implementation order

1. Migration + repository + guild_settings defaults  
2. Helix app-token helper + user/login resolve + streams lookup  
3. `/twitch add|remove|list`  
4. `/settwitch channel|role|interval|settings`  
5. Ticker + go-live embed + role mention  
6. Wire startup + register commands  
7. Docs + `.env.example`  
8. Tests: repo CRUD, dedup transition offline→live, no notify when still live with same `stream.id`

---

### 3.8 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Multi-channel:** any number of Twitch subscriptions per guild; no hard cap in MVP (monitor Helix rate limits). |
| 2 | **Role is guild-wide and Twitch-only:** `twitch_notify_role_id` never shares storage or fallback with YouTube roles. |
| 3 | **Optional ping:** null role ⇒ silent embed (no `@everyone` fallback). |
| 4 | **Go-live only** for MVP; offline cleanup is DB state only. |
| 5 | **Polling Helix** for MVP (matches existing YouTube ticker ops model). EventSub webhooks = post-MVP if we want lower latency / less quota. |
| 6 | **Dedup by stream id** on offline→live; re-notify only for a new stream session. |
| 7 | **Separate notify channel** from YouTube (`twitch_notification_channel_id`). |
| 8 | **Admin gate:** ManageGuild for all Twitch config/subscribe commands. |

**Still open (non-blocking):**

- Exact default polling interval (recommend **2** minutes).
- Whether to include game/category and viewer count on the embed (recommend **yes** for title + game; viewer count optional).
- Test command in MVP vs follow-up.

---

## 4. Database Migration Summary

### Tickets

| Table / change | Notes |
|----------------|-------|
| `tickets` | Lifecycle, sensitive flag, UUID transcript token, `archived` |
| `ticket_members` | Extra member participants |
| `ticket_staff` | Owner + named staff allow-list |
| `ticket_messages` | Only for fully archived (non-sensitive) tickets |
| `guild_settings.ticket_*` | staff role, category, archive channel, rate limit |

### Event reminders

| Table / change | Notes |
|----------------|-------|
| `event_reminder_configs` | Event ↔ role ↔ channel ↔ template (**shipped**, migration `006`) |
| `event_reminder_offsets` | Each “X before” fire + sent state (**shipped**) |
| `event_reminder_optouts` | Per-guild user opt-out (**shipped**) |
| `guild_settings.event_reminder_channel_id` | Default notify channel (**shipped**) |

### Twitch stream notifications

| Table / change | Notes |
|----------------|-------|
| `twitch_channels` | Per-guild broadcaster subscriptions + live/stream dedup state |
| `guild_settings.twitch_notification_channel_id` | Go-live Discord channel |
| `guild_settings.twitch_notify_role_id` | Optional ping role (≠ YouTube roles) |
| `guild_settings.twitch_polling_interval_minutes` | Poll interval (default 2) |

**Removed from roadmap:** Honeypot (implemented — see `docs/honeypot.md`).

---

## 5. Post-MVP TODOs

### Tickets

- [ ] Panel message + button → modal for ticket description  
- [ ] Login with Discord on transcript HTTP routes  
- [ ] Download/mirror all attachments into transcript storage at archive time (replace hotlinks)  
- [ ] Richer `/ticket list` filters  

### Event reminders

- [ ] Richer templates / embed reminders  
- [ ] Per-event opt-out (MVP is guild-wide opt-out only)  
- [ ] Auto-suggest shortname from event title in the modal  

### Twitch stream notifications

- [ ] Twitch EventSub (webhook or conduit) instead of / in addition to polling  
- [ ] Per-channel Discord channel or role overrides  
- [ ] Custom go-live message templates  
- [ ] Optional go-offline message (default off)  
- [ ] Clip / VOD hooks (out of scope for stream-live MVP)  

---
