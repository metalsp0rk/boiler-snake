# 2. Scheduled Event Reminders

### Purpose

Send configurable pre-event reminder pings for Discord’s built-in **Guild Scheduled Events**. Only users who marked **Interested** on the event are notified (via a per-event role). Anyone can **opt out** of reminder pings globally (per guild).

### Status

**Shipped** — implemented in `src/features/eventReminders/` (see [docs/event-reminders.md](../docs/event-reminders.md)). Design decisions in [2.11](#211-design-decisions-locked) remain the product contract.

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
| Opt-out | **Guild-wide** per user (`/optout`) **or** per-event mute (`/mute`); both skip role grant and thus pings. Guild opt-out always wins |
| Ping mechanism | Mention dedicated role `event-<shortname>` (not mass user mentions) |
| Timing | Relative offsets before the event’s scheduled start (e.g. 1d, 1h, 15m) |
| Delivery | **One Discord message per offset**: role ping in content + **embed** details (not a digest) |
| Create UX | Slash picks the event → **modal** configures shortname (slug + collision suffix), offsets, channel, embed description |
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
| `/eventreminder optin` | Re-enable reminders; re-sync roles for events you are still Interested in (skips muted) |
| `/eventreminder mute` | Mute one linked event (strip that role; block future grants) |
| `/eventreminder unmute` | Clear mute; re-grant if still Interested and not guild-opted-out |
| `/eventreminder status` | Show guild opt-out, muted events, and event roles you currently hold |

Ephemeral replies for opt-out/opt-in/mute/unmute/status.

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
| **Text** `message` (optional) | Custom body; placeholders `{event}`, `{location}`, `{starts_in}`, `{role}` | default template if empty |

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

1. User marks **Interested** → `GuildScheduledEventUserAdd` → if config active and not guild-opted-out and not muted for this event → grant `event-*` role.
2. User removes interest → remove role.
3. `/eventreminder optout` → guild opt-out flag; **strip all bot-managed event reminder roles** for that guild; future sync skips them.
4. `/eventreminder optin` → clear flag; re-grant for events they are still Interested in (skips muted).
5. `/eventreminder mute` → per-event mute row; strip that event’s role; future sync skips that event.
6. `/eventreminder unmute` → clear mute; re-grant if still Interested and not guild-opted-out.

Pings are `@event-<shortname>` in message **content** plus an embed in the notify channel. Only role holders are notified. Opted-out or muted users never hold the role.

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
| `/eventreminder optout` / `optin` / `mute` / `unmute` | Toggle guild opt-out or per-event mute + strip or re-sync roles |

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
| 5 | **Opt-out:** guild-wide `/optout` **and** per-event `/mute`; guild opt-out always wins for grants. |
| 6 | **Default preset selection** in modal: `1 day`, `1 hour`, `15 min` (user can change). |
| 7 | **Delivery:** always embed + role mention in message content (embed mentions do not notify). |
| 8 | **Shortname suggest:** slug of event title; append `-2`…`-99` on collision among existing configs. |

**Still minor (non-blocking):**

- Role `mentionable: false` vs true (recommend **false**; bot mentions by snowflake).
- Exact preset list beyond the defaults above.
