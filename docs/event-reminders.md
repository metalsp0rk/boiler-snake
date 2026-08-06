# Scheduled Event Reminders

Pre-event reminder pings for Discord **Guild Scheduled Events**. Only members who marked **Interested** are notified (via a dedicated `event-<shortname>` role). Users can opt out of **all** reminder pings per guild, or **mute** a single linked event.

## How it works

1. An authorized user runs `/eventreminder create` and picks a scheduled event.
2. A modal configures shortname (auto-suggested from the event title, with a `-2`/`-3` suffix if taken), reminder offsets, optional channel override, and embed description.
3. The bot creates role `event-<shortname>`, grants it to currently Interested users (minus guild opt-outs and per-event mutes), and keeps the role in sync as interest changes.
4. At each offset before start, the bot posts **one message**: role mention in content + an **embed** with event details in the notify channel.
5. When the event completes/cancels (or on `/eventreminder clear`), the bot deletes the role and config (and any mute rows for that event) so shortnames can be reused.

## Role lifecycle (with the Discord event)

Configs are keyed by Discord’s `scheduled_event_id`. The bot-managed role `event-<shortname>` lives only while that config is active. Terminal Discord statuses (**Completed**, **Canceled**), event **delete**, manual **clear**, or ticker safety cleanup all run the same path: **delete the Discord role + delete the DB config** (shortname freed for reuse).

### One-time event

```mermaid
stateDiagram-v2
  direction TB

  [*] --> NoRole: Discord event created<br>(status: Scheduled)

  NoRole --> RoleExists: /eventreminder create<br>create role event-shortname<br>grant Interested NE opt-out/mute

  state RoleExists {
    [*] --> Syncing
    Syncing --> Syncing: Interest add → grant role<br>Interest remove → strip role<br>optout strips / mute strips<br>optin/unmute re-grants<br>/eventreminder sync
    Syncing --> Firing: cron every 60s<br>fire_at ≤ now → role ping + embed
    Firing --> Syncing: more unsent offsets
    Firing --> WaitingEnd: all offsets sent<br>or past
    Syncing --> WaitingEnd: event start reached
  }

  RoleExists --> NoRole: Event → Active → Completed<br>OR Scheduled → Canceled<br>OR event deleted<br>OR /eventreminder clear<br>OR safety cleanup after start
  note right of RoleExists
    Optional path while Scheduled:<br>start time change → recompute<br>unsent fire_at only<br>(role kept)
  end note

  NoRole --> [*]: shortname free again
```

**Timeline view (one-time):**

```mermaid
sequenceDiagram
  participant Staff
  participant Bot
  participant Discord as DiscordAPI
  participant Members
  participant Role as EventRole

  Staff->>Discord: Create one-time scheduled event
  Note over Discord: status is Scheduled and no role yet

  Staff->>Bot: eventreminder create plus modal
  Bot->>Role: Create role
  Bot->>Discord: Fetch Interested users
  Bot->>Role: Assign to Interested skip opt-outs and mutes
  Note over Bot: Config and offsets saved in SQLite

  loop While event is Scheduled
    Members->>Discord: Mark or unmark Interested
    Discord-->>Bot: GuildScheduledEventUserAdd or Remove
    Bot->>Role: Grant or remove membership
    Bot->>Bot: node-cron every 60s
    alt Offset fire_at is due and unsent
      Bot->>Discord: Post reminder (role content + embed)
      Note over Discord,Role: Content mentions the role
    else No offset due this minute
      Bot->>Bot: Idle until next cron tick
    end
  end

  Discord->>Discord: status becomes Active
  Discord->>Discord: status becomes Completed
  Discord-->>Bot: GuildScheduledEventUpdate terminal
  Bot->>Role: Delete role
  Bot->>Bot: Delete config and offsets
  Note over Bot,Role: Shortname free for reuse
```

### Recurring event (series)

Discord can attach a **recurrence rule** to a scheduled event. The bot still binds reminders to **one** `scheduled_event_id` (one occurrence object at a time). It does **not** automatically re-attach when Discord advances the series to a new occurrence/event id.

```mermaid
stateDiagram-v2
  direction TB

  [*] --> SeriesExists: Staff creates recurring<br>Discord scheduled event

  SeriesExists --> OccN_NoRole: Occurrence N visible<br>(status: Scheduled)

  OccN_NoRole --> OccN_Role: /eventreminder create<br>on this occurrence's id<br>create event-shortname

  state OccN_Role {
    [*] --> Live
    Live --> Live: Interest sync<br>cron reminder fires<br>reschedule if start moves
  }

  OccN_Role --> OccN_Cleaned: Occurrence N ends<br>(Completed / Canceled / Delete)<br>or /clear or safety cleanup
  note right of OccN_Cleaned
    Role deleted<br>Config for that event id deleted<br>shortname freed
  end note

  OccN_Cleaned --> OccN1_NoRole: Discord surfaces next<br>occurrence (often new or<br>reset scheduled_event identity)

  OccN1_NoRole --> OccN1_Role: Staff must run<br>/eventreminder create again<br>(new role for next cycle)
  OccN1_Role --> OccN1_Cleaned: Same cleanup path<br>as occurrence N
  OccN1_Cleaned --> OccN1_NoRole: Further occurrences…

  OccN1_NoRole --> [*]: Series ends or<br>no further create
```

**Timeline view (recurring, two occurrences):**

```mermaid
sequenceDiagram
  participant Staff
  participant Bot
  participant Discord as DiscordAPI
  participant Role as EventRole

  Staff->>Discord: Create recurring scheduled event
  Note over Discord: Occurrence 1 Scheduled

  Staff->>Bot: eventreminder create for Occ1 id
  Bot->>Role: Create role and sync Interested
  Note over Bot: SQLite config uses Occ1 event id

  loop Countdown to Occ1
    Bot->>Bot: cron fires due offsets
    Bot->>Discord: Post reminder mentioning role
  end

  Discord->>Discord: Occ1 becomes Completed
  Discord-->>Bot: Update terminal or Delete
  Bot->>Role: Delete role
  Bot->>Bot: Delete config for Occ1
  Note over Role: Role no longer exists

  Discord->>Discord: Series advances to Occ2
  Note over Discord: Next occurrence may use new event id
  Note over Bot: No config for Occ2 yet

  Staff->>Bot: eventreminder create for Occ2 id
  Bot->>Role: Create EventRole again
  Note over Bot: Fresh config and offsets for Occ2

  Discord->>Discord: Occ2 becomes Completed
  Bot->>Role: Delete role again
```

| | One-time | Recurring (current MVP) |
|--|----------|-------------------------|
| Role created | On `/eventreminder create` for that event id | Same, **per occurrence you configure** |
| Role while live | Synced to Interested ∩ ¬opt-out ∩ ¬mute | Same |
| Reminder messages | Offsets before that start (embed + role ping) | Offsets before **that** occurrence’s start |
| Role deleted | Complete / cancel / delete / clear / safety | Same when **that** occurrence is terminal |
| Next occurrence | N/A | **No automatic re-link** — run create again |

## Permissions

| Action | Who |
|--------|-----|
| Create / edit / clear / sync for an event | **Manage Guild** **or** that scheduled event’s **creator** |
| Set default notify channel | **Manage Guild** only |
| Opt out / opt in / mute / unmute / status | Everyone |

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
| `/eventreminder optin` | Re-enable; re-grant roles for events you are still Interested in (skips muted) |
| `/eventreminder mute event:` | Mute one linked event (strip that role; block future grants) |
| `/eventreminder unmute event:` | Clear mute; re-grant if still Interested and not guild-opted-out |
| `/eventreminder status` | Guild opt-out, muted events, and event roles you hold |

## Modal fields

| Field | Purpose |
|-------|---------|
| Shortname | Role suffix → `event-<shortname>` (`[a-z0-9-]`). **Create** prefills a slug of the event title; if taken, suggests `title-2`, `title-3`, … |
| Offsets (multi-select) | Presets: 1 week, 1 day, 1 hour, 30 min, 15 min, 5 min (defaults: 1d, 1h, 15m) |
| Extra custom offsets | Freeform `2h, 10m` (`(\d+)(m\|h\|d)`) |
| Channel override | Optional; empty uses guild default |
| Custom embed description | Optional body for the reminder **embed**. Leave empty for the default (`Starts {starts_in}`) |

### Placeholders (embed description)

| Token | Meaning |
|-------|---------|
| `{event}` | Event name |
| `{location}` | Voice/stage channel mention or external location text |
| `{starts_in}` | Relative Discord timestamp (`<t:unix:R>`) |
| `{starts_at}` | Full Discord timestamp (`<t:unix:F>`) |
| `{url}` | `https://discord.com/events/{guildId}/{eventId}` |
| `{description}` | Event description (trimmed, max ~300 chars) |
| `{offset}` | Human offset for this fire (e.g. `1 hour`) |
| `{role}` | Role mention text (does **not** ping inside the embed) |

**`{location}`:** if the scheduled event is hosted in a voice/stage channel, expands to a channel mention (`<#id>`). For external events, expands to the external location text. Empty when unset. Trailing ` in ` clauses are dropped when location is empty.

### Delivery shape

Every due offset posts:

1. **Content:** `<@&role>` (this is what notifies role holders)
2. **Embed:** title = event name, optional event URL, description (custom or default), fields for Starts / Location / Reminder offset, cover image when available

Role mentions inside embed bodies do **not** notify in Discord — the content line is required.

Offsets already in the past relative to the event start are skipped. Max **8** offsets; max lookback **30 days**.

## Opt-out and mute

| Mode | Command | Scope |
|------|---------|--------|
| Guild opt-out | `/eventreminder optout` / `optin` | All events in this guild |
| Per-event mute | `/eventreminder mute` / `unmute` | One linked config |

- **Guild opt-out always wins:** muting/unmuting does not restore roles while guild-opted-out; use `optin` first.
- Mute strips that event’s reminder role and blocks future grants for that `scheduled_event_id`.
- Unmute re-grants only if you are still **Interested** and not guild-opted-out.
- Mute rows are deleted when the event config is cleared (complete / cancel / delete / `/clear`).

## Delivery & cleanup

- Background **node-cron** job every **60 seconds** (`* * * * *`) posts due offsets and runs safety cleanup (same dependency as XP decay).
- Gateway: interest add/remove, event update (reschedule or terminal), event delete.
- Reschedule: unsent `fire_at` values recomputed when the event start time changes.

## Database

Tables: `event_reminder_configs`, `event_reminder_offsets`, `event_reminder_optouts`, `event_reminder_event_optouts` (per-event mutes).  
Guild setting: `event_reminder_channel_id`.

See [database.md](database.md) and [architecture.md](architecture.md).
