# Scheduled Event Reminders

Pre-event reminder pings for Discord **Guild Scheduled Events**. Only members who marked **Interested** are notified (via a dedicated `event-<shortname>` role). Users can opt out of all reminder pings per guild.

## How it works

1. An authorized user runs `/eventreminder create` and picks a scheduled event.
2. A modal configures shortname, reminder offsets, optional channel override, and message.
3. The bot creates role `event-<shortname>`, grants it to currently Interested users (minus opt-outs), and keeps the role in sync as interest changes.
4. At each offset before start, the bot posts **one message** mentioning that role in the notify channel.
5. When the event completes/cancels (or on `/eventreminder clear`), the bot deletes the role and config so shortnames can be reused.

## Role lifecycle (with the Discord event)

Configs are keyed by Discord’s `scheduled_event_id`. The bot-managed role `event-<shortname>` lives only while that config is active. Terminal Discord statuses (**Completed**, **Canceled**), event **delete**, manual **clear**, or ticker safety cleanup all run the same path: **delete the Discord role + delete the DB config** (shortname freed for reuse).

### One-time event

```mermaid
stateDiagram-v2
  direction TB

  [*] --> NoRole: Discord event created\n(status: Scheduled)

  NoRole --> RoleExists: /eventreminder create\ncreate role event-shortname\ngrant Interested ∩ ¬opt-out

  state RoleExists {
    [*] --> Syncing
    Syncing --> Syncing: Interest add → grant role\nInterest remove → strip role\noptout strips / optin re-grants\n/eventreminder sync
    Syncing --> Firing: cron every 60s\nfire_at ≤ now → one message\nmention @event-shortname
    Firing --> Syncing: more unsent offsets
    Firing --> WaitingEnd: all offsets sent\nor past
    Syncing --> WaitingEnd: event start reached
  }

  RoleExists --> NoRole: Event → Active → Completed\nOR Scheduled → Canceled\nOR event deleted\nOR /eventreminder clear\nOR safety cleanup after start
  note right of RoleExists
    Optional path while Scheduled:
    start time change → recompute
    unsent fire_at only
    (role kept)
  end note

  NoRole --> [*]: shortname free again
```

**Timeline view (one-time):**

```mermaid
sequenceDiagram
  participant Staff
  participant Bot
  participant Discord as Discord (event + role)
  participant Members

  Staff->>Discord: Create one-time scheduled event
  Note over Discord: status = Scheduled<br/>role does not exist yet

  Staff->>Bot: /eventreminder create + modal
  Bot->>Discord: Create role event-shortname
  Bot->>Discord: Fetch Interested users
  Bot->>Discord: Assign role (skip opt-outs)
  Note over Bot,Discord: Config + offsets stored in SQLite

  loop While Scheduled (before start)
    Members->>Discord: Mark / unmark Interested
    Discord-->>Bot: GuildScheduledEventUserAdd/Remove
    Bot->>Discord: Grant or remove event-shortname
    Bot->>Bot: node-cron every 60s
    alt fire_at due and not sent
      Bot->>Discord: Post reminder mentioning @event-shortname
    end
  end

  Discord->>Discord: status → Active (event starts)
  Discord->>Discord: status → Completed
  Discord-->>Bot: GuildScheduledEventUpdate (terminal)
  Bot->>Discord: Delete role event-shortname
  Bot->>Bot: Delete config + offsets
  Note over Bot,Discord: Role gone; shortname reusable
```

### Recurring event (series)

Discord can attach a **recurrence rule** to a scheduled event. The bot still binds reminders to **one** `scheduled_event_id` (one occurrence object at a time). It does **not** automatically re-attach when Discord advances the series to a new occurrence/event id.

```mermaid
stateDiagram-v2
  direction TB

  [*] --> SeriesExists: Staff creates recurring\nDiscord scheduled event

  SeriesExists --> OccN_NoRole: Occurrence N visible\n(status: Scheduled)

  OccN_NoRole --> OccN_Role: /eventreminder create\non this occurrence's id\ncreate event-shortname

  state OccN_Role {
    [*] --> Live
    Live --> Live: Interest sync\ncron reminder fires\nreschedule if start moves
  }

  OccN_Role --> OccN_Cleaned: Occurrence N ends\n(Completed / Canceled / Delete)\nor /clear or safety cleanup
  note right of OccN_Cleaned
    Role deleted
    Config for that event id deleted
    shortname freed
  end note

  OccN_Cleaned --> OccN1_NoRole: Discord surfaces next\noccurrence (often new or\nreset scheduled_event identity)

  OccN1_NoRole --> OccN1_Role: Staff must run\n/eventreminder create again\n(new role for next cycle)
  OccN1_Role --> OccN1_Cleaned: Same cleanup path\nas occurrence N
  OccN1_Cleaned --> OccN1_NoRole: Further occurrences…

  OccN1_NoRole --> [*]: Series ends or\nno further create
```

**Timeline view (recurring, two occurrences):**

```mermaid
sequenceDiagram
  participant Staff
  participant Bot
  participant Discord as Discord (series)
  participant Role as event-shortname role

  Staff->>Discord: Create recurring scheduled event
  Note over Discord: Occurrence 1 · Scheduled

  Staff->>Bot: /eventreminder create (event id = Occ1)
  Bot->>Role: Create + sync Interested
  Note over Bot: SQLite config.scheduled_event_id = Occ1

  loop Countdown to Occ1
    Bot->>Bot: cron fires due offsets
    Bot->>Discord: Ping @event-shortname
  end

  Discord->>Discord: Occ1 → Completed
  Discord-->>Bot: Update (terminal) / Delete
  Bot->>Role: Delete role
  Bot->>Bot: Delete config for Occ1
  Note over Role: Role no longer exists

  Discord->>Discord: Series advances to Occ2
  Note over Discord: New/next occurrence (new or rotated id)
  Note over Bot: No config for Occ2 yet

  Staff->>Bot: /eventreminder create (event id = Occ2)
  Bot->>Role: Create event-shortname again
  Note over Bot: Fresh config + offsets for Occ2

  Discord->>Discord: Occ2 → Completed
  Bot->>Role: Delete role again
```

| | One-time | Recurring (current MVP) |
|--|----------|-------------------------|
| Role created | On `/eventreminder create` for that event id | Same, **per occurrence you configure** |
| Role while live | Synced to Interested ∩ ¬opt-out | Same |
| Reminder messages | Offsets before that start | Offsets before **that** occurrence’s start |
| Role deleted | Complete / cancel / delete / clear / safety | Same when **that** occurrence is terminal |
| Next occurrence | N/A | **No automatic re-link** — run create again |

## Permissions

| Action | Who |
|--------|-----|
| Create / edit / clear / sync for an event | **Manage Guild** **or** that scheduled event’s **creator** |
| Set default notify channel | **Manage Guild** only |
| Opt out / opt in / status | Everyone |

Bot needs: **Manage Roles** (role above `event-*`), **Send Messages** (and ability to mention the role by ID) in the notify channel. Enable the **Guild Scheduled Events** intent in the Developer Portal.

## Commands

| Command | Description |
|---------|-------------|
| `/eventreminder create event:` | Open configure modal for a scheduled event |
| `/eventreminder edit event:` | Re-open modal for an existing config |
| `/eventreminder list` | Active configs, offsets, next fire |
| `/eventreminder clear event:` | Stop reminders, delete role + DB rows |
| `/eventreminder sync event:` | Re-fetch Interested users and reconcile roles |
| `/eventreminder setchannel [channel]` | Guild default notify channel |
| `/eventreminder optout` | Opt out of all reminder roles/pings in this guild |
| `/eventreminder optin` | Re-enable; re-grant roles for events you are still Interested in |
| `/eventreminder status` | Opt-out state and event roles you hold |

## Modal fields

| Field | Purpose |
|-------|---------|
| Shortname | Role suffix → `event-<shortname>` (`[a-z0-9-]`) |
| Offsets (multi-select) | Presets: 1 week, 1 day, 1 hour, 30 min, 15 min, 5 min (defaults: 1d, 1h, 15m) |
| Extra custom offsets | Freeform `2h, 10m` (`(\d+)(m\|h\|d)`) |
| Channel override | Optional; empty uses guild default |
| Custom message | Placeholders: `{event}`, `{starts_in}`, `{starts_at}`, `{role}` |

Offsets already in the past relative to the event start are skipped. Max **8** offsets; max lookback **30 days**.

## Opt-out

Guild-wide (MVP). Opt-out strips bot-managed event reminder roles and prevents future grants. Per-event opt-out is post-MVP.

## Delivery & cleanup

- Background **node-cron** job every **60 seconds** (`* * * * *`) posts due offsets and runs safety cleanup (same dependency as XP decay).
- Gateway: interest add/remove, event update (reschedule or terminal), event delete.
- Reschedule: unsent `fire_at` values recomputed when the event start time changes.

## Database

Tables: `event_reminder_configs`, `event_reminder_offsets`, `event_reminder_optouts`.  
Guild setting: `event_reminder_channel_id`.

See [database.md](database.md) and [architecture.md](architecture.md).
