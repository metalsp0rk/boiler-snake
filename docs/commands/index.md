# Commands Reference

Complete guide to all Boiler Snake slash commands, organized by permission level.

## Table of Contents

- [Public Commands](#public-commands) — Available to everyone
- [Admin/Mod Commands](#adminmod-commands) — Staff gate, Manage Server, or event creator (varies by command)
- [Permission Matrix](#permission-matrix)
- [Error Handling](#error-handling)
- [Quick Reference Card](#quick-reference-card)

---

## Public Commands

Available to all guild members without special permissions.

### `/xp` - View XP and Level

Show your own or another user's current XP and level.

**Usage**:
```bash
/xp                          # Your stats
/xp user:@SomeUser           # Another user's stats
```

**Options**:
- `user`: User to check (optional, defaults to command author)

**Response**:
```
@Username: **1250 XP** (Level **3**)
```

### `/leaderboard` - View Top Users

Display the top 10 users by XP with a generated PNG leaderboard.

**Usage**:
```bash
/leaderboard
```

**Options**:
- `limit`: Present in the slash definition (integer) but **not applied** by the handler today — the bot always loads and renders the **top 10**.

**Response**: Public message with content `**Leaderboard (Top 10)**` and PNG attachment `boiler-snake-leaderboard.png` (not ephemeral).

### `/warn mine` - View Your Warnings

View your own formal warnings in this server. See [Warning System](../warnings.md).

**Usage**:
```bash
/warn mine
/warn mine include_voided:true
```

**Response**: Ephemeral list of your active (or full) warnings with `W-n` ids and reasons.

Other `/warn` subcommands require the staff gate (below).

### `/ticket create` - Open a Support Ticket

Open a private ticket channel with staff. See [Help Tickets](../tickets.md).

**Usage**:
```bash
/ticket create
/ticket create reason:Cannot join voice
```

**Response**: Ephemeral link to the new `ticket-N` channel. Subject to per-guild rate limit (default 60 minutes between self-creates).

Members can also use a public **Open a ticket** panel button (posted by admins with `/ticket panel`) which opens a modal for the description, then uses the same create pipeline.

### `/ticket settings` - View Ticket Config

Shows category, archive channel, rate limit, and staff roles used for ticket visibility.

```bash
/ticket settings
```

### `/eventreminder optout` / `optin` / `mute` / `unmute` / `status` - Reminder preferences

Control your own event reminder pings. See [Scheduled Event Reminders](../event-reminders.md).

**Usage**:
```bash
/eventreminder optout              # Leave all event reminder roles; no future pings
/eventreminder optin               # Re-enable; restore roles for Interested events (skips muted)
/eventreminder mute event:<id>     # Mute one linked event
/eventreminder unmute event:<id>   # Unmute one event; restore role if still Interested
/eventreminder status              # Guild opt-out, muted events, roles you hold
```

Guild opt-out always wins over per-event unmute. Other `/eventreminder` subcommands require **Manage Guild** or being the scheduled event’s **creator** (see below).

### `/play` - Play a track

Join your voice channel (if needed) and play a song. See [Music player](../music.md).

```bash
/play query:never gonna give you up
/play query:https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT
```

**Who**: Any member in a non-AFK voice channel. If the bot is already playing, you must be in **that** channel.

**Notes**:
- Spotify links need `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`. Audio is resolved from YouTube Music / YouTube / SoundCloud, not streamed from Spotify.
- Playlists/albums enqueue up to 100 tracks.
- Respects `/setcommandchannel` (being in voice is not enough if commands are restricted).

### `/music` - Playback controls

| Subcommand | Effect |
|------------|--------|
| `skip` | Skip current track |
| `pause` / `resume` | Pause / resume |
| `stop` | Clear queue and leave |
| `leave` | Leave voice |
| `queue` | Show upcoming tracks (ephemeral) |
| `nowplaying` | Current track + Pause/Skip/Stop buttons |
| `volume level:` | 0–100 |
| `shuffle` | Shuffle remaining queue |
| `remove position:` | Remove one queued item (1-based) |
| `seek timestamp:` | `1:23` or seconds (`90`) |

Same voice-channel rule as `/play`.

---

## Admin/Mod Commands

Require the **Manage Guild** permission, or a configured **staff role** for staff-gated commands (`/note`, `/warn` staff ops, `/ticket` staff ops, etc.). All responses are ephemeral unless noted.

**Permission terms** (used below and in the [Permission Matrix](#permission-matrix)):

| Term | Meaning |
|------|---------|
| **Public** | Any guild member |
| **Staff gate** | Manage Server **or** any role from `/staff role list` (junior or senior) |
| **Senior staff** | Manage Server **or** a **senior** staff role |
| **ManageGuild** | Manage Server only |
| **Event creator** | Manage Server **or** creator of that Discord scheduled event |

### `/ticket` - Support tickets (staff / admin)

See [Help Tickets](../tickets.md) for full behavior.

**Public:** `create`, `settings`  
**Staff gate:** `for`, `claim`, `transfer`, `adduser`, `removeuser`, `addstaff`, `removestaff`, `sensitive`, `unsensitive`, `close`, `archive`, `list`, `info`, `panel`, `setcategory`, `setarchive`, `setratelimit`

#### Staff lifecycle (open ticket channel unless noted)

```bash
/ticket for user:@Member reason:Follow-up on ban appeal
/ticket claim
/ticket transfer staff:@OtherStaff
/ticket adduser user:@Witness
/ticket removeuser user:@Witness
/ticket addstaff user:@JuniorMod
/ticket removestaff user:@JuniorMod
/ticket sensitive
/ticket unsensitive
/ticket close reason:Resolved staff_note:Followed up in DMs
/ticket archive
/ticket list
/ticket list user:@Member
/ticket info
```

- **`close`** — remove non-staff members; keep the channel for staff. Optional `reason` (shown to requester / archive) and `staff_note` (private note on the requester).  
- **`archive`** — after close: save transcript (if not sensitive) and delete the channel.  
- **`for`** — staff open a ticket on behalf of a member (no self-create rate limit).  
- **Ticket channel overwrites** (automatic staff-role view) use **senior** staff roles only; junior staff need named access (`addstaff`) or Manage Server.

#### `/ticket panel` - Public entry panel

```bash
/ticket panel
/ticket panel channel:#support title:Need help? description:Staff will reply in a private channel.
```

Posts an embed with an **Open a ticket** button. Clicking the button opens a modal; submit creates a ticket (same rate limit as `/ticket create`).

#### Admin config

```bash
/ticket setcategory category:Tickets
/ticket setarchive channel:#ticket-archives
/ticket setratelimit minutes:60
```

### `/settings` - Show Guild Configuration

Display current XP rates, decay settings, role mappings, and allowed command channels.

**Usage**:
```bash
/settings
```

**Response**:
```
**Boiler Snake Settings**
**XP:** msg=5, reaction=2, voice/min=1
**Cooldowns:** msg=20s, reaction=10s
**Decay:** enabled=true, threshold=20 msgs / 7 days, percent=10%
**Level curve factor:** 100 (Level L starts at L²×factor)
**Logs:** audit=<#…>, message=<#…>
**Commands allowed in:** <#123456789>, All channels (no restriction set)
**Level→Role mappings:**
- <@&123456789> @ Lvl 5 (drop after 3d)
```

### `/setlog` - Configure Audit & Message Log Channels

Set separate channels for staff audit embeds and deleted-message embeds. See [Audit Log & Message Log](../audit-log.md).

**Usage**:
```bash
/setlog audit channel:#staff-audit
/setlog message channel:#message-deletes
/setlog show
/setlog audit clear:true
```

**Subcommands**:
- `audit` — bans, kicks, reaction-role and level-role changes
- `message` — single and bulk message deletes
- `show` — current channel configuration

**Options** (on `audit` / `message`):
- `channel`: Target text channel (optional if clearing)
- `clear`: Set true to disable that log stream

### `/setxp` - Configure XP Settings

Adjust XP rewards, cooldowns, and the level curve factor for messages, reactions, and voice activity.

**Usage**:
```bash
/setxp message:10 reaction:5 voice:2 msgcooldown:30 reactioncooldown:15
/setxp factor:100
```

**Options** (all optional):
- `message`: XP per message (default: 5)
- `reaction`: XP per reaction (default: 2)
- `voice`: XP per minute in voice (default: 1)
- `msgcooldown`: Message cooldown seconds (default: 20)
- `reactioncooldown`: Reaction cooldown seconds (default: 10)
- `factor`: Level curve factor (1–10000, default: 100). Level L requires ≥ L² × factor XP.

**Limits**:
- Maximum per-event XP: 1,000,000,000 (1 billion)
- All values must be ≥ 0
- Cooldowns can be set to 0 for no delay
- Factor range: 1–10,000

**Example Configurations**:

Aggressive XP gain:
```bash
/setxp message:20 reaction:5 voice:5 msgcooldown:10 reactioncooldown:5
```

Conservative (low inflation):
```bash
/setxp message:3 reaction:1 voice:1 msgcooldown:60 reactioncooldown:30
```

Easier leveling (lower factor):
```bash
/setxp factor:50
```

### `/grantxp` - Grant XP to a User

Manually grant XP to a member (Manage Server only). Runs the full award pipeline (level roles + audit).

**Permission**: **ManageGuild** only. Staff roles do **not** grant access.

**Usage**:
```bash
/grantxp user:@SomeUser amount:500
/grantxp user:@SomeUser amount:100 reason:Contest winner
```

**Options**:
- `user`: Member to grant XP to (required)
- `amount`: XP to add, 1–1,000,000,000 (required)
- `reason`: Optional note for the audit log (max 200 characters)

**Notes**:
- Bots cannot receive XP
- Ephemeral reply shows new total XP and level
- Posts an audit-log embed when `/setlog audit` is configured
- Does **not** count toward decay message activity


### `/setdecay` - Configure XP Decay

Set up daily XP reduction for inactive users.

**Usage**:
```bash
/setdecay enabled:true messages:20 days:7 percent:10
```

**Options** (all optional):
- `enabled`: Enable/disable decay system (true/false)
- `messages`: Minimum messages required in time window
- `days`: Time window size (days)
- `percent`: XP reduction percentage (0-95%)

**Logic**: If user sends fewer than `messages` messages in the last `days`, their XP is reduced by `percent`.

**Examples**:

Balanced decay:
```bash
/setdecay enabled:true messages:10 days:7 percent:5
# Lose 5% XP if < 1 msg/day for a week
```

Strict enforcement:
```bash
/setdecay enabled:true messages:3 days:7 percent:25
# Lose 25% XP if < 3 msgs in a week
```

Disable decay:
```bash
/setdecay enabled:false
```

### `/leveltorole` - Manage Level→Role Mappings

Create or remove automatic role grants based on XP levels.

#### Subcommand: `set` - Create Mapping

Grant a role when users reach a certain level, with optional drop grace period.

**Usage**:
```bash
/leveltorole set role:@Member level:5 dropdays:7
```

**Parameters**:
- `role`: Role to grant (required)
- `level`: Level threshold (≥ 0)
- `dropdays`: Days to keep role after dropping below threshold

**Example**:
```bash
# Basic member role at level 5
/leveltorole set role:@Member level:5 dropdays:3

# Veteran status at level 20 with longer grace period
/leveltorole set role:@Veteran level:20 dropdays:14
```

#### Subcommand: `remove` - Delete Mapping

Remove an existing level→role mapping.

**Usage**:
```bash
/leveltorole remove role:@Member
```

**Example**:
```bash
/leveltorole remove role:@SeasonalRole
```

#### Subcommand: `list` - Show Mappings

Display all configured role mappings.

**Usage**:
```bash
/leveltorole list
```

### `/setcommandchannel` - Restrict Command Locations

Control which channels can use bot commands.

**Permission**: **ManageGuild only**. **Lockout escape:** members with **Manage Server** can run this command in any channel even when an allow-list is active.

#### Subcommand: `add` - Allow Commands in Channel

Add a channel to the allowed list.

**Usage**:
```bash
/setcommandchannel add channel:#xp-trackers
```

#### Subcommand: `remove` - Remove from Allowed List

Remove a channel from allowed channels.

**Usage**:
```bash
/setcommandchannel remove channel:#general
```

#### Subcommand: `list` - View Allowed Channels

Show all channels where commands are permitted.

**Usage**:
```bash
/setcommandchannel list
```

### `/youtube` - YouTube Channel Management

Manage subscriptions to YouTube channels for live stream and video notifications. Requires `YOUTUBE_API_KEY` in environment.

#### Subcommand: `add` - Subscribe to Channel

Add a YouTube channel for notifications.

**Usage**:
```bash
/youtube add url:https://www.youtube.com/@TechChannel
```

**Supported formats**:
- Full URL with @username: `https://www.youtube.com/@SomeChannel`
- Full URL with ID: `https://www.youtube.com/channel/UCxxxxx`
- Numeric ID only: `UCxxxxxxxxxxx`
- Bare @username: `@SomeChannel`

#### Subcommand: `remove` - Unsubscribe

Remove a YouTube channel subscription.

**Usage**:
```bash
/youtube remove channel:https://www.youtube.com/channel/UCxxxxx
```

#### Subcommand: `list` - View Subscriptions

Display all subscribed channels.

**Usage**:
```bash
/youtube list
```

### `/setyoutube` - YouTube Configuration

Configure YouTube notification settings.

#### Subcommand: `channel` - Set Notification Location

Choose where live stream and video alerts appear.

**Usage**:
```bash
/setyoutube channel channel:#stream-notifications
```

#### Subcommand: `interval` - Configure Polling Frequency

Set how often the bot checks for updates (1-60 minutes).

**Usage**:
```bash
/setyoutube interval minutes:5
```

#### Subcommand: `uploadrole` - Mention Role for Uploads

Set (or clear) a role mentioned when a subscribed channel posts a new video upload. Live notifications are unchanged.

**Usage**:
```bash
/setyoutube uploadrole role:@Uploads
/setyoutube uploadrole
# omit role → disable upload mentions
```

**Notes**:
- Lower intervals = faster alerts but more API quota usage
- Recommended: 5-30 minutes for most servers

### `/testnotification` - Test YouTube Notification

Send a one-off test notification using the latest feed item for a YouTube channel (staff). Uses the configured upload mention role when the latest item is an upload.

**Usage**:
```bash
/testnotification channel:https://www.youtube.com/@TechChannel
/testnotification channel:UCxxxxx simple:true
```

**Options**:
- `channel`: YouTube channel URL, `@username`, or channel ID (required)
- `simple`: Use a simple text-based upload embed instead of the rich embed (optional)

If the channel is not already subscribed, the bot adds it as a subscription so the feed can be fetched. Reply is **not** ephemeral (posted as a normal interaction reply with embed/content).

### `/staff` - Staff Roles

Configure trusted staff roles for the admin/staff gate, honeypot exemption, and ticket visibility. See [Staff Roles](../staff-roles.md).

**Permission**:
- `role add` / `remove` / `setlevel` / `syncpermissions` — **ManageGuild** only
- `role list` / `settings` — **Staff gate**

**`/staff syncpermissions`** — optional OAuth flow so staff roles can **see** staff-tier slash commands in Discord’s picker (handlers already enforce the staff gate). Requires operator setup (`CLIENT_SECRET`, public HTTP, OAuth redirect). See [Staff Roles](../staff-roles.md#command-visibility-sync-optional).

**Levels**:
- **junior** — passes staff gate + honeypot exempt; **no** automatic ticket channel view
- **senior** — junior privileges **plus** ticket channel overwrites on open/claim/sensitive/close

#### Subcommand group: `role`

```bash
/staff role add role:@Moderator level:senior
/staff role add role:@Helper level:junior
/staff role remove role:@Helper
/staff role setlevel role:@Moderator level:junior
/staff role list
```

| Subcommand | Options | Description |
|------------|---------|-------------|
| `add` | `role` (required), `level` (`junior` \| `senior`, required) | Trust a role as staff (updates level if already listed) |
| `remove` | `role` (required) | Drop a role from the staff list |
| `setlevel` | `role` (required), `level` (required) | Switch an existing staff role between junior and senior |
| `list` | — | List senior and junior staff roles |

#### Subcommand: `settings`

```bash
/staff settings
```

Shows counts, what each level controls, and that only Manage Server can mutate staff roles.

### `/eventreminder` - Scheduled Event Reminders

Pre-event reminder pings for Discord **Guild Scheduled Events**. Members who marked **Interested** get a bot-managed `event-<shortname>` role and are pinged at configured offsets. See [Scheduled Event Reminders](../event-reminders.md).

**Permission**:
- `create` / `edit` / `clear` / `sync` — **ManageGuild** **or** that scheduled event’s **creator**
- `setchannel` — **Staff gate**
- `list` — any member
- `optout` / `optin` / `mute` / `unmute` / `status` — any member (documented under [Public Commands](#public-commands))

Bot needs **Manage Roles** (role above `event-*`), send access in the notify channel, and the **Guild Scheduled Events** intent.

#### Subcommands

```bash
/eventreminder create event:<scheduled event>
/eventreminder edit event:<linked event>
/eventreminder list
/eventreminder clear event:<linked event>
/eventreminder sync event:<linked event>
/eventreminder setchannel channel:#event-pings
/eventreminder setchannel
# omit channel → clear guild default
```

| Subcommand | Description |
|------------|-------------|
| `create` | Opens a modal to link reminders to a scheduled event (shortname, offsets, optional channel override + embed description) |
| `edit` | Re-open the configure modal for an existing config |
| `list` | Active configs, offsets, next fire time, default channel |
| `clear` | Stop reminders; delete the `event-<shortname>` role and DB rows |
| `sync` | Re-fetch Interested users and reconcile role membership |
| `setchannel` | Guild default notify channel (text/announcement); per-event modal can override |

**Create/edit modal fields**: shortname → role `event-<shortname>` (create prefills a slug of the event title, with `-2`/`-3` on collision); offset multi-select (defaults 1d / 1h / 15m) + optional custom offsets (`2h, 10m`); optional channel override; optional **embed description** with placeholders `{event}`, `{location}`, `{starts_in}`, `{starts_at}`, `{url}`, `{description}`, `{offset}`, `{role}`. Delivery is always an embed + role mention in message content.

### `/honeypot` - Honeypot Channel Management

Configure decoy channels that ban users who post, roles that ban on grant, and roles exempt from those bans. See [Honeypot Channels](../honeypot.md) for full setup guidance.

**Permission**:
- `channel` / `banrole` — **Staff gate**
- `exempt` — **ManageGuild only** (mutates `staff_roles`, same as `/staff role`)

Replies are ephemeral.

**Exempt list** = shared `staff_roles` table (same as `/staff`). `/honeypot exempt add` adds a staff role at default **senior** if new.

#### Subcommand group: `channel` - Manage Honeypot Channels

##### `channel add` - Mark Channel as Honeypot

```bash
/honeypot channel add channel:#trap-channel
```

**Effect**:
- Non-exempt users who post are DM'd, their message is deleted if possible, and they are banned
- The bot posts a **pinned image-only warning** (large “DO NOT POST HERE” + honeypot explanation baked into the PNG; no plain text for scrapers)

##### `channel list` - List Honeypot Channels

```bash
/honeypot channel list
```

##### `channel del` - Remove Honeypot Marking

```bash
/honeypot channel del channel:#trap-channel
```

Does not delete the Discord channel—only removes honeypot enforcement.

#### Subcommand group: `banrole` - Roles that ban on grant

```bash
/honeypot banrole add role:@Raid-Bait
/honeypot banrole list
/honeypot banrole del role:@Raid-Bait
```

When a non-exempt member is **granted** a ban role, the bot bans them (not retroactive for existing holders). Same exempt list as channels.

#### Subcommand group: `exempt` - Manage Exempt Roles

Alias for staff-role membership used by honeypot enforcement. Prefer `/staff role add … level:` when junior vs senior matters.

##### `exempt add` - Exempt a Role

```bash
/honeypot exempt add role:@Moderator
```

Adds the role to `staff_roles` (default **senior** if new). Members with **any** staff role will not be banned for posting in honeypot channels or receiving honeypot ban roles. Configure exempt / staff roles **before** enabling honeypots.

##### `exempt list` - List Exempt Roles

```bash
/honeypot exempt list
```

##### `exempt del` - Remove Role Exemption

```bash
/honeypot exempt del role:@Moderator
```

Removes the role from `staff_roles` entirely (also drops staff gate and ticket overwrites for that role).

### `/reactionrole` - Reaction Role Panels

Bot-managed embeds where members claim roles by reacting. See [Reaction Roles](../reaction-roles.md) for full behavior (level gates, removable flag, unconfigured reaction stripping).

#### Subcommand group: `panel`

##### `panel create` - Post a New Panel

```bash
/reactionrole panel create channel:#roles title:Self Roles description:React to claim a role
```

Posts an embed and returns the panel **message ID** for option commands.

##### `panel edit` - Update Title/Description

```bash
/reactionrole panel edit message_id:123456789 title:New Title
```

##### `panel deploy` - Copy Panel to Another Channel

```bash
/reactionrole panel deploy message_id:123456789 channel:#roles
```

Copies title, description, and all emoji→role options into a new message in the destination channel (source left in place). Returns the new message ID.

##### `panel list` - List Panels

```bash
/reactionrole panel list
```

##### `panel delete` - Delete Panel

```bash
/reactionrole panel delete message_id:123456789
```

Removes DB rows and tries to delete the Discord message.

#### Subcommand group: `option`

##### `option add` - Map Emoji → Role

```bash
/reactionrole option add message_id:123 role:@Gamer level:5 removable:true
```

Then send the emoji as your **next message** (or type `stop` to cancel). The bot updates the panel, confirms, and deletes your emoji message.

**Parameters**:
- `message_id`: Panel message ID (required)
- `role`: Role to grant (required)
- `level`: Minimum level (default 0)
- `removable`: Remove role when reaction removed (default true)

##### `option remove` - Remove Mapping

```bash
/reactionrole option remove message_id:123
```

Then send the emoji to remove as your **next message** (or type `stop` to cancel).

##### `option list` - List Options

```bash
/reactionrole option list message_id:123
```

#### Subcommand: `sync` - Repair Embed + Reactions

```bash
/reactionrole sync message_id:123456789
```

### `/note` - Staff Notes

Private staff-only notes about members. Never shown to the subject. See [Staff Notes](../staff-notes.md).

**Permission**: Staff gate — Manage Server or a role from `/staff role list`.

#### Subcommand: `add`

```bash
/note add user:@SomeUser content:Watch for repeated spam in #general
/note add user:@SomeUser
# omit content → Discord modal for longer text (max 2000)
```

After `/ticket close`, staff can also attach a note via `staff_note:` or the **Add staff note** button.

#### Subcommand: `list`

```bash
/note list user:@SomeUser
/note list user:@SomeUser page:2 include_deleted:true
/note list                          # recent guild-wide notes
```

#### Subcommand: `edit` / `delete` / `info`

```bash
/note edit id:12 content:Updated context
/note edit id:12                    # modal prefilled with current body
/note delete id:12
/note info id:12
```

`id` is the per-guild note number (**N-12**), not an internal database id.

#### Subcommand: `settings`

```bash
/note settings
```

Shows active/soft-deleted counts and access info.

### `/userinfo` - Staff Member Card

Unified staff view of a member: XP/level, staff-note counts, warning counts, and (for senior staff) **Activity** rankings by channel/category.

**Permission**: Staff gate — Manage Server or a role from `/staff role list`.  
**Activity tab**: senior staff only (Manage Server or a **senior** staff role).

```bash
/userinfo user:@SomeUser
```

**Buttons** (on the ephemeral reply): **Overview** · **Notes** · **Warnings** · **Activity**

Activity controls: **All / 7d / 30d**, **Channels / Categories**, **Backfill history**.  
See [User Activity Summary](../user-activity.md).

### `/activityconfig` - Activity Tracking Config

Ignore noisy channels/categories and inspect tracking status. See [User Activity Summary](../user-activity.md).

**Permission**: Staff gate.

```bash
/activityconfig ignore add kind:channel target:#spam
/activityconfig ignore add kind:category target:Off-topic
/activityconfig ignore remove target:#spam
/activityconfig ignore list
/activityconfig status
/activityconfig backfill all
/activityconfig backfill all max_pages:100
/activityconfig backfill cancel
```

`backfill all` starts a long-running, rate-limited scan (one pass per channel, all human authors). Optional `max_pages` (1–500, default 50) caps history depth per channel (100 messages/page). Check progress with `status`. Use `backfill cancel` to stop a running job (or clear a stale `running` status after a restart).

### `/warn` - Formal Warnings

Permanent disciplinary records. See [Warning System](../warnings.md).

**Permission**: Staff gate for all subcommands except `mine` (public). `/setwarn` is also staff gate.

#### Subcommand: `add`

```bash
/warn add user:@SomeUser reason:Repeated spam in #general
/warn add user:@SomeUser reason:Escalation silent:true note:12
/warn add user:@SomeUser reason:Harassment message:https://discord.com/channels/…/…/… evidence:Second report expires_days:30
```

Optional: `silent`, `note` (N-n), `message` (Discord jump link), `evidence` (staff-only notes), `expires_days` (`0` = never; omit = guild default).

#### Subcommand: `list` / `count` / `info` / `void` / `export`

```bash
/warn list user:@SomeUser
/warn list user:@SomeUser include_voided:true
/warn count user:@SomeUser
/warn info id:12
/warn void id:12 reason:Appeal accepted
/warn export user:@SomeUser
```

`id` is the per-guild warning number (**W-12**), not an internal database id.  
`export` attaches an ephemeral markdown file (notes + warnings) for staff handoff.

#### Subcommand: `settings`

```bash
/warn settings
```

### `/setwarn` - Warning Configuration

```bash
/setwarn dm enabled:false
/setwarn dm enabled:true
/setwarn log channel:#warn-log
/setwarn log clear:true
/setwarn expiry days:30
/setwarn expiry days:0
```

| Subcommand | Description |
|------------|-------------|
| `dm` | Toggle member DMs on issue/void |
| `log` | Dedicated channel for warning issue/void embeds (falls back to `/setlog audit` when cleared) |
| `expiry` | Default auto-void after N days for **new** warnings (`0` = never) |

**Permission**: Staff gate.

---

## Permission Matrix

**Staff gate** = Manage Server **or** any `staff_roles` role (junior or senior).  
**Senior staff** = Manage Server **or** a **senior** `staff_roles` role.  
**ManageGuild** = Manage Server only.  
**Event creator** = Manage Server **or** creator of that Discord scheduled event.

| Command | Permissions Required | Ephemeral Response |
|---------|---------------------|-------------------|
| `/xp` [user] | Public | Yes |
| `/leaderboard` | Public | No (attachment) |
| `/warn mine` | Public | Yes |
| `/ticket create` | Public | Yes |
| `/ticket settings` | Public | Yes |
| `/eventreminder optout` | Public | Yes |
| `/eventreminder optin` | Public | Yes |
| `/eventreminder mute` | Public | Yes |
| `/eventreminder unmute` | Public | Yes |
| `/eventreminder status` | Public | Yes |
| `/eventreminder list` | Public | Yes |
| `/play` | Public (same VC) | No (now-playing) |
| `/music skip\|pause\|resume\|stop\|leave\|volume\|shuffle\|remove\|seek` | Public (same VC) | Yes |
| `/music queue` | Public (same VC) | Yes |
| `/music nowplaying` | Public (same VC) | No |
| `/note add\|list\|edit\|delete\|info\|settings` | Staff gate | Yes |
| `/warn add\|list\|info\|void\|count\|export\|settings` | Staff gate | Yes |
| `/userinfo` | Staff gate | Yes |
| `/userinfo` **Activity** tab | Senior staff | Yes |
| `/ticket for\|claim\|transfer\|adduser\|removeuser\|addstaff\|removestaff\|sensitive\|unsensitive\|close\|archive\|list\|info` | Staff gate | Yes |
| `/staff role list` | Staff gate | Yes |
| `/staff settings` | Staff gate | Yes |
| `/setwarn dm\|log\|expiry` | Staff gate | Yes |
| `/activityconfig` | Staff gate | Yes |
| `/grantxp` | ManageGuild | Yes |
| `/ticket panel\|setcategory\|setarchive\|setratelimit` | Staff gate | Yes |
| `/honeypot channel\|banrole` | Staff gate | Yes |
| `/honeypot exempt …` | ManageGuild | Yes |
| `/eventreminder setchannel` | Staff gate | Yes |
| `/eventreminder create\|edit\|clear\|sync` | ManageGuild **or** event creator | Yes |
| `/settings` | Staff gate | Yes |
| `/setxp` | Staff gate | Yes |
| `/setdecay` | Staff gate | Yes |
| `/setlog` | Staff gate | Yes |
| `/leveltorole set\|remove\|list` | Staff gate | Yes |
| `/youtube add\|remove\|list` | Staff gate | Yes |
| `/setyoutube channel\|interval\|uploadrole` | Staff gate | Yes |
| `/testnotification` | Staff gate | No |
| `/reactionrole panel\|option\|sync` | Staff gate | Yes |
| `/staff role add\|remove\|setlevel` | ManageGuild | Yes |
| `/staff syncpermissions` | ManageGuild | Yes |
| `/setcommandchannel add\|remove\|list` | ManageGuild ¹ | Yes |

¹ `/setcommandchannel` is Manage Server only (handler + Discord default). Channel-restriction **bypass** also applies only to Manage Server holders (lockout prevention).

---

## Error Handling

### "You don't have permission to use this"

User attempts a gated command without Manage Server or a configured staff role (as required for that command).

**Solution**: Grant **Manage Server**, or add their role via `/staff role add` (and use `setlevel` for senior features such as `/userinfo` Activity).

### "Commands aren't enabled in this channel"

Command restriction is active, and user is not in an allowed channel.

**Solutions**:
- Add current channel to allowed list: `/setcommandchannel add`
- Remove restrictions entirely by removing all allowed channels

### "Invalid YouTube URL"

YouTube subscription command receives malformed URL.

**Valid formats**:
```
https://www.youtube.com/@SomeChannel
https://www.youtube.com/channel/UCxxxxxxxxxxx
@SomeChannel
UCxxxxxxxxxxx
```

---

## Quick Reference Card

```
PUBLIC:
/xp [user]                         → View XP & level
/leaderboard                       → Top 10 PNG leaderboard
/warn mine                         → Your own warnings
/ticket create [reason]            → Open a support ticket
/ticket settings                   → View ticket config
/eventreminder optout|optin|mute|unmute|status → Reminder ping preferences
/eventreminder list                → List active event reminders
/play query:                       → Play in your voice channel
/music skip|pause|resume|stop|leave|queue|nowplaying|volume|shuffle|remove|seek

STAFF GATE (Manage Server OR any staff role):
/note add|list|edit|delete|info|settings
/warn add|list|info|void|count|export|settings
/setwarn dm|log|expiry
/userinfo [user]                   → Member card (Activity = senior)
/activityconfig ignore|status|backfill
/ticket for|claim|transfer|list|info
/ticket adduser|removeuser|addstaff|removestaff
/ticket sensitive|unsensitive|close|archive
/ticket panel|setcategory|setarchive|setratelimit
/staff role list | /staff settings
/settings | /setxp | /setdecay | /setlog
/leveltorole set|remove|list
/youtube add|remove|list
/setyoutube channel|interval|uploadrole
/testnotification
/reactionrole panel|option|sync
/honeypot channel|banrole
/eventreminder setchannel
/eventreminder create|edit|clear|sync  → creator OR Manage Server

MANAGE SERVER ONLY:
/grantxp user amount [reason]      → Manually grant XP
/staff role add|remove|setlevel    → Configure staff roles
/staff syncpermissions             → OAuth sync slash visibility for staff roles
/setcommandchannel add|remove|list → Command channel allow-list
/honeypot exempt …                 → Staff-role alias
```
