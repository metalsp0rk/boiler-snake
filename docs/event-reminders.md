# Scheduled Event Reminders

Pre-event reminder pings for Discord **Guild Scheduled Events**. Only members who marked **Interested** are notified (via a dedicated `event-<shortname>` role). Users can opt out of all reminder pings per guild.

## How it works

1. An authorized user runs `/eventreminder create` and picks a scheduled event.
2. A modal configures shortname, reminder offsets, optional channel override, and message.
3. The bot creates role `event-<shortname>`, grants it to currently Interested users (minus opt-outs), and keeps the role in sync as interest changes.
4. At each offset before start, the bot posts **one message** mentioning that role in the notify channel.
5. When the event completes/cancels (or on `/eventreminder clear`), the bot deletes the role and config so shortnames can be reused.

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
