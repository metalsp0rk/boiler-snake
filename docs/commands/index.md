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

Display top users by XP with a generated PNG leaderboard.

**Usage**:
```bash
/leaderboard
/leaderboard limit:20
/leaderboard page:3
```

**Options**:
- `limit`: Users per page (integer 1–20, default **10**).
- `page`: Page number (integer 1–20, default **1**).

**Response**: Public message with content like `**Leaderboard — ranks 1–10**` and PNG attachment `boiler-snake-leaderboard.png` (not ephemeral), plus a **◀ Prev / Next ▶** button row. Only the user who ran the command can page; each click re-queries current XP. Prev is disabled on page 1 and Next on the last page — with **page 20 as a hard ceiling** (`page:` clamps to 1–20 too), so browsable ranks stop at page 20 × page size regardless of guild size.

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

Members can also use a public **Open a ticket** panel button (posted by staff with `/ticket panel create`) which opens a modal for the description, then uses the same create pipeline.

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

Guild opt-out always wins over per-event unmute. The config subcommands `edit`/`clear`/`sync` require **Manage Server** or being the scheduled event’s **creator** (see below); `create` is retired to a pointer reply.

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

### `/link` - Cross-Platform Account Linking

Link your Discord and Fluxer accounts so XP (and optionally gork memory)
mirror between the two identities. **Self-service — no staff gate**; every
caller can only ever act on their own pairing. Replies are **DM-first** (K2):
the minted code and detail views arrive by DM, the channel keeps a neutral
ack that never leaks link codes or peer identity.

**Usage**:
```bash
/link create                      # Mint a one-time LNK- code (15 minutes, by DM)
/link connect code:LNK-…          # Redeem the other platform's code in guild
/link status                      # Peer, linked date, mirror rates (DM detail)
/link remove                      # Unlink. History already mirrored stays mirrored
/link config direction:<dir> pct:<0-100> [memory:on|off]  # XP mirror rate + memory toggle
```

| Subcommand | Effect |
|------------|--------|
| `create` | Mint a one-time link code (delivered by DM) |
| `connect code:` | Redeem a peer's code against your account |
| `status` | Peer + linked date + mirror rates (DM detail, channel ack) |
| `remove` | Unlink the pair (mirrored history is not undone) |
| `config direction: pct: [memory:]` | XP mirror direction + rate (0–100), gork memory mirroring on/off |

See [Account Linking](../account-linking.md) for the pairing flow and what
mirroring actually copies.

---

## Admin/Mod Commands

Require the **Manage Server** permission, or a configured **staff role** for staff-gated commands (`/note`, `/warn` staff ops, `/ticket` staff ops, etc.). All responses are ephemeral unless noted.

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
**Staff gate:** `for`, `claim`, `transfer`, `adduser`, `removeuser`, `addstaff`, `removestaff`, `sensitive`, `unsensitive`, `close`, `archive`, `list`, `info`, `summarize`, `panel …` (subcommand group: `create`/`list`/`edit`/`delete`), `setcategory`, `setarchive`, `setratelimit`

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
/ticket list status:closed
/ticket list staff:@Mod unclaimed:True
/ticket list sensitive:True since:2026-10-01 until:2026-10-19
/ticket info
/ticket summarize
```

- **`close`** — remove non-staff members; keep the channel for staff. Optional `reason` (shown to requester / archive) and `staff_note` (private note on the requester).  
- **`archive`** — after close: save transcript (if not sensitive) and delete the channel.  
- **`for`** — staff open a ticket on behalf of a member (no self-create rate limit).  
- **`list`** — filters (issue #180): `status` `open` (default) / `closed` / `all`; `user` = requester **or** added member; `staff` = claiming staff owner; `unclaimed:True` = nobody has claimed; `sensitive:True`/`False` = only locked / only unlocked; `since`/`until` = created-date window (`YYYY-MM-DD`, UTC, inclusive; `until` covers the whole day). The reply echoes the applied filters, closed rows carry their close date, and an over-budget list says `(… more)` instead of truncating silently.
- **`summarize`** — on-demand AI summary of the current ticket conversation (open or soft-closed, pre-archive). Uses `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL` when configured; otherwise replies with a stats-only fallback and labels it as such.  
- **Ticket channel overwrites** (automatic staff-role view) use **senior** staff roles only; junior staff need named access (`addstaff`) or Manage Server.

#### `/ticket panel` - Public entry panels (subcommand group)

Staff-only stored **panel registry** (table `ticket_panels`). Panels post an embed with an **Open a ticket** button; clicking it opens a modal for a short description, then runs the same self-create pipeline as `/ticket create` (same rate limit). Each posted panel is keyed by its Discord **message ID** and can be listed, re-edited in place, or deleted.

##### `panel create` - Post a New Panel

```bash
/ticket panel create
/ticket panel create channel:#support title:Need help? description:Staff will reply in a private channel.
```

Posts the panel embed + button. Options: `channel` (optional, text/announcement; defaults to the current channel), `title` (optional, ≤256), `description` (optional, ≤2000). Replies ephemerally with the panel **message ID** (and jump link) to use with `edit`/`delete`.

##### `panel list` - List Registered Panels

```bash
/ticket panel list
```

Ephemeral list of every panel in this server: title, channel, message ID, and jump link.

##### `panel edit` - Re-edit a Posted Panel

```bash
/ticket panel edit message_id:123456789 title:New Title
```

`message_id` **required**; `title` (≤256) and `description` (≤2000) optional, but at least one must be provided. Updates the registry row and re-edits the posted embed in place. Unknown message ID → ephemeral "no panel" reply.

##### `panel delete` - Remove a Panel

```bash
/ticket panel delete message_id:123456789
```

`message_id` **required**. Removes the registry row and best-effort deletes the Discord message (reports the Discord delete as a warning if it fails; still deletes the row). If you deleted the Discord message by hand, use this to clear the stored row.

#### Admin config

```bash
/ticket setcategory category:Tickets
/ticket setarchive channel:#ticket-archives
/ticket setratelimit minutes:60
```

### Report Post / Report User - Context-menu reports (staff)

Discord **context-menu** commands — no slash. Open via **right-click (long-press) → Apps → Report Post** on a message, or **Report User** on a member. Both open a staff-only moderation ticket with the reported target captured as evidence; the reported user is never contacted. Full flow: [Report flow](../tickets.md#report-flow-context-menu-commands).

**Permission**: staff-tier picker — **Manage Server** default hides the entries from regulars; `/staff syncpermissions` adds allow overwrites for configured `staff_roles` (the handlers re-check the staff gate on invoke **and** modal submit — that gate is the source of truth). A denied invoke records nothing and shows no modal.

**Report Post** (message context menu) → modal `Report this post`:

- `Additional context` — paragraph, required
- `Delete original? (yes/no)` — short text, required, **no default** (a destructive question is never pre-answered)

**Delete rule** — recognition is the only path to a destructive choice (#471 H2-15 idiom): `yes` / `y` (case-insensitive) deletes the original message **after** its evidence copy lands in the ticket; `no` / `n` keeps it; **anything else also keeps** and echoes the raw input in the reply and the ticket record: `input 'X' not understood — message kept`. Never destroyed on a misread.

**Report User** (user context menu) → modal `Report this user`: `Additional context` only. Never deletes anything. Bot targets and self-reports are refused: `Cannot open a ticket for a bot.` / ``You can't report yourself — use `/ticket create` to reach staff instead. Nothing was recorded.`

Replies are ephemeral; the confirmation is `Ticket **#12** opened: <#ticket-channel>`. A modal reopened after the ~10-minute capture window or a bot restart answers: `This report form has expired or was already used — run the command again.` Need the subject-facing ticket? Open it manually afterwards with `/ticket for` — the report itself never adds or DMs the reported user.

**Deploy**: re-run `npm run register` after deploy — registration PUTs commands **per guild** (no global path), so the new Apps entries stay invisible until pushed.

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
**Decay:** Enabled **true** · threshold **20** msgs / **7** days · **10%**
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

**Parameters** (all three required):
- `role`: Role to grant (required)
- `level`: Level threshold (required, ≥ 0)
- `dropdays`: Days to keep role after dropping below threshold (required, ≥ 0)

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

### `/twitch` - Twitch Channel Management

Manage subscriptions to Twitch channels for **go-live** notifications. Requires `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` in the environment. See [Twitch Stream Notifications](../twitch-notifications.md).

#### Subcommand: `add` - Subscribe to Channel

Add a Twitch channel for go-live notifications.

**Usage**:
```bash
/twitch add login:SomeStreamer
/twitch add login:https://twitch.tv/SomeStreamer
/twitch add login:12345678
```

**Supported formats**: login, `twitch.tv/…` URL, `@login`, or numeric user id.

#### Subcommand: `remove` - Unsubscribe

Remove a Twitch channel subscription (autocomplete over subscriptions).

**Usage**:
```bash
/twitch remove channel:SomeStreamer
```

#### Subcommand: `list` - View Subscriptions

Display all subscribed channels (with live status), the notification channel, ping role, and any per-channel `/twitch notify` overrides.

**Usage**:
```bash
/twitch list
```

#### Subcommand: `notify` - Per-Channel Notification Overrides

Route one subscription's notifications elsewhere (issue #177): `discord_channel` overrides where its go-live/clip/VOD posts land, `role` overrides the go-live ping. Unset fields fall back to the `/settwitch` guild pair; `clear:True` removes both overrides. The channel is validated at set time.

**Usage**:
```bash
/twitch notify channel:SomeStreamer discord_channel:#partner-streams
/twitch notify channel:SomeStreamer role:@PartnerAlerts
/twitch notify channel:SomeStreamer clear:True
```

#### Subcommand: `offline` - Go-Offline Announcements

Opt one subscription in to a "went offline" announcement when its stream ends (issue #179, default **off**): announced exactly once per stream, never for a broadcast already live at opt-in time, never with a role ping. Follows the `/twitch notify` routing override.

**Usage**:
```bash
/twitch offline channel:SomeStreamer enabled:True
/twitch offline channel:SomeStreamer enabled:False
```

#### Subcommand: `clips` - New-Clip Alerts

Toggle new-clip notifications for one subscribed channel (default **off**). Clips created **after** the toggle was enabled are announced (no backfill), up to 5 per poll; alerts follow the `/twitch notify` routing but never ping the role.

**Usage**:
```bash
/twitch clips channel:SomeStreamer enabled:True
```

#### Subcommand: `vod` - New-VOD Alerts

Toggle new-VOD (past-broadcast) notifications for one subscribed channel (default **off**). Archive broadcasts only, newest-first, same flood cap as clips; media alerts never ping the role.

**Usage**:
```bash
/twitch vod channel:SomeStreamer enabled:True
```

#### Subcommand: `template` - Go-Live Message Template

Show or set the guild's custom go-live content line. Placeholders: `{streamer}` `{login}` `{title}` `{game}` `{url}` `{viewers}` `{uptime}`. `clear:True` restores the built-in default on its own (drop `text`); with no options it shows the current template.

**Usage**:
```bash
/twitch template
/twitch template text:**{streamer}** is live playing {game} — {url}
/twitch template clear:True
```

### `/settwitch` - Twitch Configuration

Configure Twitch notification settings.

#### Subcommand: `channel` - Set Notification Location

Choose where go-live alerts appear.

**Usage**:
```bash
/settwitch channel channel:#stream-notifications
```

#### Subcommand: `role` - Mention Role on Go-Live

Set (or clear) a role mentioned when a subscribed streamer goes live. Independent of the YouTube roles; no `@everyone` fallback.

**Usage**:
```bash
/settwitch role role:@StreamAlerts
/settwitch role
# omit role → disable mentions
```

#### Subcommand: `interval` - Configure Polling Frequency

Set how often the bot checks Twitch (1–60 minutes, default 2).

**Usage**:
```bash
/settwitch interval minutes:2
```

#### Subcommand: `settings` - Show Current Configuration

```bash
/settwitch settings
```

Shows credentials status, notification channel, ping role, interval, and subscription count.

### `/rss` - RSS Feed Notifications

Manage RSS/Atom feed subscriptions whose **new entries** post to the community notify channel. No API keys needed. See [RSS Feed Notifications](../rss-notifications.md).

**Permission**: **Staff gate** (staff-tier picker: Manage Guild hides the command from members until staff roles are synced via `/staff syncpermissions`; the handler enforces the gate either way). All replies are ephemeral.

#### Subcommand: `add` - Subscribe to a Feed

Validates the URL now (scheme, SSRF guard, parses, ≥1 item) and stores the resolved feed title.

```bash
/rss add url:https://feeds.example.com/blog.xml
/rss add url:https://example.com/news/feed name:Example News
```

**Options**: `url` (required), `name` (optional display label). The notify channel must be set first (`/setrss channel`); the per-community cap is 20 by default (`RSS_MAX_FEEDS_PER_COMMUNITY`). Refusals embed the specific cause.

#### Subcommand: `remove` - Unsubscribe

```bash
/rss remove feed:https://example.com/news/feed
```

`feed:` has **autocomplete** over the community's subscriptions (inserts the stored URL).

#### Subcommand: `list` - View Subscriptions

Feeds plus the notify channel / role / interval status block and the count against the cap.

#### Subcommand: `test` - Dry-Run Notification

Fetch now and post the latest entry to the notify channel — **side-effect-free** (no seen-set claim, no watermark move). Defaults to the most recent subscription.

```bash
/rss test
/rss test feed:https://example.com/news/feed   # autocomplete
```

#### Subcommand: `check` - Force a Poll Now

Live-verification aid: runs a **real** poll (skips only the interval/backoff clock gate) for one feed or, with no `feed:`, every subscription — replying per-feed with **Polled / Posted / Not modified** and named failures.

```bash
/rss check
/rss check feed:https://example.com/news/feed
```

### `/setrss` - RSS Configuration

Configure RSS notification settings (staff gate; replies ephemeral).

#### Subcommand: `channel` - Set Notification Location

```bash
/setrss channel channel:#feed-alerts
```

Independent of the YouTube/Twitch channels.

#### Subcommand: `role` - Mention Role on New Entries

```bash
/setrss role role:@NewsAlerts
/setrss role
# omit role → disable mentions
```

Only the configured role is ever mentioned (strict `allowedMentions`); no `@everyone` fallback, ever.

#### Subcommand: `interval` - Configure Polling Frequency

Set how often this community's feeds are checked (1–60 minutes, default **15**).

```bash
/setrss interval minutes:15
```

#### Subcommand: `settings` - Show Current Configuration

```bash
/setrss settings
```

Shows notify channel, ping role, interval, and the subscription count against the cap.

### `/github` - GitHub Release Notifications

Track GitHub repositories and post release notes when new releases are cut (checked hourly). Multiple repositories per server, each with its own channel and ping role. See [GitHub Release Notifications](../github-releases.md).

#### Subcommand: `watch` - Track Repository

```bash
/github watch repo:owner/name channel:#releases
/github watch repo:https://github.com/owner/repo
```

`repo` **required** (`owner/name`, GitHub URL, or SSH remote); `channel` optional. Re-running an existing watch updates the channel without resetting release state. There is **no `token:` option** — it was removed (audit INT-9): slash option values render publicly in channel, which leaked entered PATs. For a private repo, store the PAT with `/github token` below, then watch normally.

#### Subcommand: `token` - Enter the Repo Token (private prompt)

```bash
/github token repo:owner/name
```

Opens a **private modal** to enter/clear the GitHub token for one repository — the only way to track **private** repos (creates the watch if new; modal submissions are visible only to the submitter). Refuses up front, before the prompt opens, when `TOKEN_ENCRYPTION_KEY` is unset (tokens are never stored unencrypted). Tokens are validated against GitHub first and stored envelope-encrypted; `/github list` only shows "token set". See [GitHub Release Notifications](../github-releases.md).

#### Subcommand: `remove` - Stop Tracking

```bash
/github remove repo:owner/name
```

#### Subcommand: `list` - View Watches

Show all watched repositories with their channels, ping roles, and token state.

#### Subcommand: `channel` - Set Announcement Channel

```bash
/github channel repo:owner/name channel:#releases
```

#### Subcommand: `role` - Mention Role on Release

```bash
/github role repo:owner/name role:@Announcements
/github role repo:owner/name
# omit role → disable mentions
```

#### Subcommand: `check` - Probe Now

Force an immediate release lookup for all (or one) watches instead of waiting for the hourly tick.

```bash
/github check
/github check repo:owner/name
```

### `/staff` - Staff Roles

Configure trusted staff roles for the admin/staff gate, honeypot exemption, and ticket visibility. See [Staff Roles](../staff-roles.md).

**Permission**:
- `role add` / `remove` / `setlevel` / `syncpermissions` — **ManageGuild** only
- `role list` / `settings` — **Staff gate** in the handler, but the command itself is admin-tier in the picker; staff without Manage Server use **`/staffsettings`** (#599, see below)

**`/staff syncpermissions [force_reauth]`** — optional OAuth flow so staff roles can **see** staff-tier slash commands in Discord’s picker (handlers already enforce the staff gate). `force_reauth:true` always opens a fresh authorize link instead of reusing a stored token. Requires operator setup (`CLIENT_SECRET`, public HTTP, OAuth redirect). See [Staff Roles](../staff-roles.md#command-visibility-sync-optional).

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

### `/staffsettings` - Staff Roles, staff-visible read view

Read-only twin of `/staff role list` and `/staff settings` (#599). `/staff` registers at the Manage Server picker tier (its mutations are admin-only), so junior/senior staff couldn't check their own status from Discord without an admin. `/staffsettings` registers at the **staff picker tier**: Manage Server default, plus allow overwrites for configured staff roles after `/staff syncpermissions` — the same views, reachable by staff. It mutates nothing; the `/staff` read subcommands keep working unchanged. See [Staff Roles](../staff-roles.md).

**Permission**: **Staff gate** — Manage Server or any `staff_roles` role (junior or senior). Replies are ephemeral; the handler enforces the gate regardless of picker visibility.

```bash
/staffsettings roles     # same view as /staff role list
/staffsettings overview  # same view as /staff settings
```

| Subcommand | Options | Description |
|------------|---------|-------------|
| `roles` | — | List senior and junior staff roles (includes `added by` provenance) |
| `overview` | — | Counts, what each level controls, and command-visibility sync status |

### `/event` - Community Events (bot-owned events + RSVP)

The **bot-owned** events system: create events the bot posts (no Discord "Scheduled Event" dependency), members RSVP with **buttons**, and signups drive an attendee role, reminders, and optional Google Calendar entries. The feature spans **four public-tier commands** — `/event` (lifecycle), `/eventsignup` (signups/options/presets), `/eventconfig` (settings/reminders/series/Google Calendar), `/eventchannels` (channels + cross-posting). Full guide: [Community Events](../community-events.md).

**Permission**: all four commands register **without `defaultMemberPermissions`** — the slash picker is visible to everyone and every gate lives in the handlers (the source of truth). `create` and `list` are open to everyone by default (a configured `event_channels` **create-role** narrows creation), organizer/staff gates apply per event (`edit`, `post`, `duplicate`, `delete`, `response`, `options`, `series`, per-event `reminders add/remove/list`, `channel`, `crosspost`), **`/event adopt` is a plain Staff gate** (no organizer arm), and `/eventconfig settings …` is **Staff gate**.

#### Subcommands

```bash
/event create title:"…" start:"7pm" channel:#announcements   # DM wizard fallback: /event wizard
/event list · edit (event|in_dm) · duplicate · post · delete · adopt [scheduled_event]
```

**Start times** parse natural text in the guild timezone (`/eventconfig settings timezone`): `7pm`, `tomorrow 14:00`, `in 2 days`, `2026-11-05 19:00`.

**Ephemeral**: yes (config/edit/duplicate/reminders/preset/series/channel replies); the posted event is a public embed + buttons.

### `/eventsignup` - Event Signups, Options & Presets

Organizer-side signup management, live option editing, and saved signup presets for Community Events. Full guide: [Community Events](../community-events.md).

**Permission**: registers at the **public** picker tier; `response` and `options` gate to **Staff gate or event organizer** per event, `preset` is **Staff gate**.

#### Subcommands

```bash
/eventsignup response add|remove|move member option (event)  # organizer stand-ins
/eventsignup options list|add|edit|remove|reorder|whitelist (event)
/eventsignup preset save|list|delete [name]                  # signup presets (≤10/server)
```

**Ephemeral**: yes.

### `/eventconfig` - Community Events Settings, Reminders, Series & Google Calendar

Guild-wide Community Events settings, reminder preferences/offsets, recurring-series control, and Google Calendar sync. Full guide: [Community Events](../community-events.md).

**Permission**: registers at the **public** picker tier; `reminders status|mute|unmute` are personal prefs (open to all), `reminders on|off|default` are **Staff gate** guild-default toggles for **new** events (a denial points members at `/eventreminder optout` for personal muting — #348), `reminders add/remove/list` and `series` gate to **Staff gate or event organizer**, and `settings …` plus `google autoset` are **Staff gate** (`google connect|status|disconnect` act on your own account).

#### Subcommands

```bash
/eventconfig settings show|timezone|role|show-attendees|thread-reminders|reminder-channel|auto-archive|digest
/eventconfig reminders on|off|status|mute|unmute|default … · add|remove|list (event)
/eventconfig series list|skip|stop                               # weekly/monthly recurrence
/eventconfig google connect|status|disconnect|autoset            # Google Calendar sync
```

**Ephemeral**: yes.

### `/eventchannels` - Event Channels & Cross-Posting

Mark event channels (with create-role narrowing, sorting, purge) and relay one event into **another guild**. Full guide: [Community Events](../community-events.md).

**Permission**: registers at the **public** picker tier; both groups gate to **Staff gate** in the handler (crosspost `approve` = destination staff).

#### Subcommands

```bash
/eventchannels channel mark|unmark|list|sort|purge           # event channels (+ create-role narrowing)
/eventchannels crosspost invite|approve|revoke|list|config   # two-guild relay (bridge pairing)
```

**Ephemeral**: yes.

> `/eventreminder create` (the Guild-Scheduled-Event reminder twin) is **retired**: it replies with a pointer to the `/event` family. Reminder *delivery* for Community Events is automatic (`/eventconfig reminders`).

### `/eventreminder` - Scheduled Event Reminders

Pre-event reminder pings for Discord **Guild Scheduled Events**. Members who marked **Interested** get a bot-managed `event-<shortname>` role and are pinged at configured offsets. See [Scheduled Event Reminders](../event-reminders.md).

**Permission**:
- `create` — **retired** (E13): replies with a pointer to [`/event`](#event---community-events-bot-owned-events--rsvp); new reminder configs no longer live here
- `edit` / `clear` / `sync` — **ManageGuild** **or** that scheduled event's **creator**
- `setchannel` — **Staff gate**
- `list` — any member
- `optout` / `optin` / `mute` / `unmute` / `status` — any member (documented under [Public Commands](#public-commands))

Bot needs **Manage Roles** (role above `event-*`), send access in the notify channel, and the **Guild Scheduled Events** intent.

#### Subcommands

```bash
/eventreminder create event:<scheduled event>   # RETIRED — see /event create
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
| `create` | **Retired** (E13) — ephemeral redirect to `/event create` / `/event wizard`; bot-owned events drive reminders off button signups instead of Interested roles |
| `edit` | Re-open the configure modal for an existing config |
| `list` | Active configs, offsets, next fire time, default channel |
| `clear` | Stop reminders; delete the `event-<shortname>` role and DB rows |
| `sync` | Re-fetch Interested users and reconcile role membership |
| `setchannel` | Guild default notify channel (text/announcement); per-event modal can override |

**Edit modal fields** (`edit` only — the create modal is retired with `create`): shortname → role `event-<shortname>` (prefilled with the config’s current shortname; must stay unique); offset multi-select (defaults 1d / 1h / 15m) + optional custom offsets (`2h, 10m`); optional channel override; optional **embed description** with placeholders `{event}`, `{location}`, `{starts_in}`, `{starts_at}`, `{url}`, `{description}`, `{offset}`, `{role}`. Delivery is always an embed + role mention in message content.

### `/honeypot` - Honeypot Channel Management

Configure decoy channels that ban users who post, roles that ban on grant, and roles exempt from those bans. See [Honeypot Channels](../honeypot.md) for full setup guidance.

**Permission**:
- `channel` / `banrole` — **Staff gate**
- `exempt` — **ManageGuild only** (mutates `staff_roles`, same as `/staff role`)
- `safety resume` — **ManageGuild only** in the handler (staff-tier picker)

Replies are ephemeral.

**Exempt list** = shared `staff_roles` table (same as `/staff`). `/honeypot exempt add` adds a staff role at default **junior** if new; existing rows keep their level (#438 — promote via `/staff role setlevel`).

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

Adds the role to `staff_roles` (new roles join at **junior**; existing roles keep their level — #438). Members with **any** staff role will not be banned for posting in honeypot channels or receiving honeypot ban roles. Configure exempt / staff roles **before** enabling honeypots.

##### `exempt list` - List Exempt Roles

```bash
/honeypot exempt list
```

##### `exempt del` - Remove Role Exemption

```bash
/honeypot exempt del role:@Moderator
```

Removes the role from `staff_roles` entirely (also drops staff gate and ticket overwrites for that role).

#### Subcommand group: `safety` - Mass-Ban Safety Valve

```bash
/honeypot safety resume
```

If the #440 mass-ban safety valve **paused** honeypot enforcement after a ban burst, `resume` clears the pause and re-arms banning (replies honestly when nothing is paused). **Manage Server only** in the handler — the picker itself is staff-tier. See [Honeypot](../honeypot.md).

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
/note delete id:12                  # no confirm → preview only
/note delete id:12 confirm:true     # actually deletes
/note info id:12
```

`id` is the per-guild note number (**N-12**), not an internal database id.

`delete` is **confirm-once** (#471 H2-15): without `confirm:true` nothing is deleted — the reply previews the note (ref, subject, snippet) and names what will be lost; re-run with `confirm:true` to proceed. The body erase is irreversible (no restore command exists).

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

### `/gork` - Gork AI Q&A (staff)

Configure and moderate [Gork](../gork.md), the AI keyword Q&A bot. Q&A itself is triggered by typing the guild's keyword (`@gork` by default) in chat — `/gork` subcommands only configure and moderate it.

Gork's `read_discord` tool (reading a pasted message/channel link) is **always on** whenever gork is live — there is no command or setting for it.

**Permission**: **Staff gate** for **all** subcommands — Manage Server or a role from `/staff role list`. The command registers with a Manage Server default member permission, so staff roles see it in Discord's picker only after `/staff syncpermissions`; the handler enforces the staff gate either way.

```bash
/gork keyword @gork
/gork keyword clear                # disables gork for the guild
/gork role @GorkRole               # role mention also invokes gork (keyword stays master)
/gork role clear:true
/gork context 10
/gork toolrounds 50                # per-guild tool-round budget (5-300) — scales the answer deadline
/gork cooldown 180
/gork rules Keep answers about this server
/gork search on
/gork ste on
/gork enable off
/gork ban user:@SomeUser
/gork unban user:@SomeUser
/gork bans
/gork memory show
/gork budget default 10
/gork budget channel target:#general limit:3
/gork budget list
/gork log enabled:false
/gork logchannel #gork-qa
/gork logchannel clear:true
/gork summarize last:200 channel:#support
/gork summarize from:https://discord.com/channels/…/…/… to:https://discord.com/channels/…/…/…
/gork summarize-budget 80000
/gork status
```

| Subcommand | Description |
|------------|-------------|
| `keyword <text\|clear>` | Set the trigger keyword (1–50 chars); `clear` disables gork for the guild |
| `role [<@role>\|clear:true]` | Set the role whose **mention** also invokes gork anywhere in a message (`clear:true` removes it). The keyword stays the master switch — a cleared keyword keeps gork fully silent |
| `context <1-50>` | Prior-message context window (default 10) |
| `toolrounds <5-300>` | Per-guild **tool-round budget** — how many tool rounds one answer may spend (default **50**); the whole-loop answer deadline is derived from it (`min(90s + 40s×rounds, 45 min)`). Unset guilds fall back to the global `GORK_LLM_MAX_TOOL_ROUNDS` |
| `cooldown <seconds>` | Per-user cooldown (0–3600; default **180**, 0 = disabled). Staff always bypass |
| `rules <text\|clear>` | Additional staff prompt rules (≤500 chars); `clear` removes them |
| `search <on\|off>` | Toggle the SearXNG web-search / page-reading tools for this guild (shared lever) |
| `ste <on\|off>` | Toggle the **STE answer style** — anti-slop writing rules (ASD-STE100-distilled card) for gork's answers in this guild; **off** by default — see [Gork](../gork.md#answer-style-ste) |
| `enable <on\|off>` | Turn gork **entirely** on/off for this server — off makes every trigger silent; all other settings are kept |
| `ban <user>` | Ban a user from gork in this server (they get the generic failure reply — never told it's a ban) |
| `unban <user>` | Lift a user's gork ban |
| `bans` | List the users banned from gork in this server |
| `memory <action>` | Curate the per-person community memory — see below |
| `budget <action>` | Per-user daily usage budgets per channel/category/server (tri-state, off by default) — see below |
| `log enabled:<true\|false>` | Toggle the gork [interaction log](../gork-logging.md) (every agent call stored for replay/debug) via the **required boolean** `enabled` (True/False picker — not an on/off choice) — **on** by default, per-guild |
| `logchannel [<channel>\|clear:true]` | Dedicated channel for Gork Q&A audit embeds; without it they fall back to the `/setlog audit` channel (`clear:true` restores the fallback) |
| `summarize <mode>` | Conversation rundown embed for a message range (staff, shared 10-min guild cooldown) — see below |
| `summarize-budget <tokens>` | Per-guild **input token budget** for `/gork summarize` (8,000–200,000; default 80,000) — see below |
| `status` | Ephemeral status embed: enabled, keyword, window, cooldown, rules, search, ste, AI provider configured?, `SEARXNG_URL` set?, banned-user count, memory state, budget default + rule count, summarize input token budget |

`/gork memory` carries the verbs as an `action` choice (Discord caps option depth at 2), plus optional `user`, `id`, `chars`, and `confirm` options:

| Action | Description |
|--------|-------------|
| `show [user]` | Ephemeral listing with `#id` handles — one person's entries with `user:`, else the newest 25 in the guild |
| `forget id:<n>` | Delete one memory by its `#id` handle (guild-scoped) |
| `clear [user]` | Wipe one person's — or the whole guild's — memories. **Confirm-once:** without `confirm:true` it only previews the count |
| `on` / `off` | Memory master switch (default **off** — each answered question costs an extra extraction call when on) |
| `budget chars:<n>` | Memory-block cap (0–64,000; default **12,000**, 0 = unlimited; out-of-range values are clamped) |

`/gork budget` also carries its verbs as an `action` choice, plus `limit` (integer, −1–1000), `target` (channel/category picker), and `id` (raw scope id for removes):

| Action | Description |
|--------|-------------|
| `default limit:<n>` | Guild-default daily limit: `-1` blocked, `0` unlimited (**default**), `1–1000` successful answers per user per UTC day |
| `channel target:<ch> limit:<n>` | Add/replace a channel rule (a thread target binds to its **parent channel**) |
| `category target:<cat> limit:<n>` | Add/replace a category rule — pools every channel inside it |
| `remove_channel target:<ch>` / `id:<n>` | Drop the rule — falls back to category → guild default |
| `remove_category target:<cat>` / `id:<n>` | Drop the rule — falls back to the guild default |
| `list` | Guild default + rules table with `created_by` provenance |

Precedence is **channel → category → guild default → unlimited**; the winning scope owns the single counter. Checked at queue entry **and** promotion (overage impossible), staff are **not** exempt, counts only on fully-delivered answers, reset 00:00 UTC. See [Daily usage budget](../gork.md#daily-usage-budget).

`/gork summarize` needs **exactly one** anchor mode: `from`+`to` (closed, inclusive, both in one channel — a newer `from` swaps), `from` alone (through the channel's newest message), or `last:<N>` (newest N readable messages, integer **1–1000**). Anchors are message links or bare ids (bare ids need `channel:` or run in that channel); `channel` defaults to the command's channel. `focus` (≤200 chars) shifts emphasis **within** the fixed rundown sections; `lang` (≤40 chars) overrides the output language (default: the conversation's dominant language). Caps: 1,000 messages / the guild's **input token budget** (`/gork summarize-budget`, 8,000–200,000 tokens, default 80,000 → a 312,000-char transcript at 4 chars/token minus a prompt reserve; clamped with the actually-read window disclosed in the embed) / 3,500-char output. Bots and webhooks are included labeled `[bot]`; system messages are skipped. One rundown posts per server per **10 minutes** (arms only when the embed lands; failures never arm it), and a success counts against the invoker's daily gork budget. Refused: other servers, cross-channel ranges, and channels the invoker can't view (open tickets always). See [Conversation rundown](../gork.md#conversation-rundown).

The **rundown itself posts publicly** in the channel (embed, never pings); its usage/cooldown/budget rejections are ephemeral. Every config change — including bans, memory edits, and budget rule changes — posts a config-change embed to the audit channel (`/setlog audit`). See [Gork](../gork.md) for trigger, memory, and moderation behavior.

### `/bridge` - Cross-Platform Message Bridge

Pair one Discord channel with one Fluxer channel; messages are copied with
media, replies and provenance (staff gate: **Manage Server** or any staff
role — the service re-checks on every call).

**Usage**:
```bash
/bridge create [channel] [direction:both|to-fluxer|from-fluxer]   # mint a pending bridge + BRG- code
/bridge connect code:BRG-… [channel]                              # consume a peer's credential here
/bridge disconnect [bridge:b_] [channel] confirm:true             # destroy (confirm-once, see below)
/bridge retry [bridge:b_] [channel]                               # re-queue parked (failed) copies
/bridge status [bridge:b_] [channel]                              # state, direction, queue depth, ends
/bridge list                                                      # every bridge touching this community
```

| Subcommand | Effect |
|------------|--------|
| `create` | Create a pending bridge for a channel (default: this one) |
| `connect code:` | Pair this channel using a peer's BRG- credential |
| `disconnect` | Destroy by handle or local channel — **confirm-once (#471 H2-15)**: without `confirm: true` this only previews what will be lost (both relay webhooks go; reconnect needs fresh credentials) |
| `retry` | Re-queue a bridge's parked (failed) copies with a fresh attempt ladder |
| `status` | State, direction, outbox depth, spool bytes, per-end detail |
| `list` | Every bridge touching this community |

`!bridge …` works identically from Fluxer (same option spec). See
[Bridge](../bridge.md) for relay semantics, media handling, and failure modes.

---

### `/automod` - Auto-moderation status (staff)

Read-only view of the auto-moderation configuration (epic
[#723](https://github.com/metalsp0rk/boiler-snake/issues/723) — the settings
slice, #725). Discord-only; Fluxer is explicit no-parity
(`That command is not available on Fluxer yet.`). See
[Auto-moderation](../automod.md).

**Usage**:
```bash
/automod status    # enabled, channel, rules, 7 modes, timeout cap, budget remaining, breaker
```

**Response** (ephemeral): `**Enabled:**`, `**Channel:**`, `**Rules:**`
(set + char count / not set), all seven action **Modes** (staff notes shown
as always-on — no mode by design), `**Timeout cap:**`,
`**Daily budget:**` (real remaining today; `0` = unlimited, `-1` = blocked),
`**Safety:**` (breaker state + pause reason). No secrets.

### `/automodconfig` - Auto-moderation configuration (admin)

Manage Server in the picker AND in the handler. Every mutation records an
`automod.*` admin-audit row. Settings live on `guild_settings`
(migration `067`); see [Auto-moderation](../automod.md).

**Usage**:
```bash
/automodconfig channel set channel:#automod   # warns if @everyone can view (never rewrites)
/automodconfig channel clear
/automodconfig rules set [text]               # omit text → modal (like /note add); cap 4000
/automodconfig rules clear
/automodconfig enable on|off                  # master switch (default off)
/automodconfig mode action:<a> mode:off|suggest|auto
/automodconfig timeout-cap seconds:3600       # 60 … 2419200 (28 days), never silently clamped
/automodconfig budget limit:50                # -1 blocked · 0 unlimited · 1–100000 / UTC day
/automodconfig safety resume                  # preview; then confirm:true to re-arm
```

| Subcommand | Effect |
|------------|--------|
| `channel set\|clear` | Case-card channel. `set` replies with a **Warning** when `@everyone` can view the channel — overwrites are read, NEVER rewritten. Clearing while enabled is allowed (referrals name the missing piece). |
| `rules set\|clear` | Rules text the judge applies (required to run a case). Over-cap input refuses with the offending character count. |
| `enable on\|off` | Master switch, default **off**. Enabling does not arm any action — modes stay `suggest`. |
| `mode` | Per-action mode for `no_action`, `warn`, `delete_message`, `ticket`, `timeout`, `kick`, `ban` (`off` / `suggest` / `auto`, default `suggest`). No mode exists for the staff-note tool — always on. |
| `timeout-cap` | Max automod-run timeout, 60 s – 2,419,200 s (Discord's 28-day ceiling); default 3600. |
| `budget` | Daily case budget per server (`-1` blocked / `0` unlimited / `1–100000`, default 50). Separate from Gork's budget; a case counts only when a provider call is accepted. |
| `safety resume` | Clears the persisted circuit-breaker pause. **Confirm-once (#471 H2-15)**: without `confirm: true` this only previews which auto kick/ban/timeout actions re-arm. |

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
| `/link create\|connect\|status\|remove\|config` | Public (self-service; DM-first replies) | DM detail, channel ack |
| `/note add\|list\|edit\|delete\|info\|settings` | Staff gate | Yes |
| `/bridge create\|connect\|disconnect\|retry\|status\|list` | Staff gate | Yes |
| `/warn add\|list\|info\|void\|count\|export\|settings` | Staff gate | Yes |
| `/userinfo` | Staff gate | Yes |
| `/userinfo` **Activity** tab | Senior staff | Yes |
| `/ticket for\|claim\|transfer\|adduser\|removeuser\|addstaff\|removestaff\|sensitive\|unsensitive\|close\|archive\|list\|info\|summarize` | Staff gate | Yes |
| Report Post / Report User (message / user **context menus**, right-click → Apps) | Staff gate (staff-tier picker: Manage Server default + `staff_roles` overwrites after `/staff syncpermissions`) | Yes |
| `/staff role list` | Staff gate | Yes |
| `/staff settings` | Staff gate | Yes |
| `/staffsettings roles\|overview` | Staff gate | Yes |
| `/setwarn dm\|log\|expiry` | Staff gate | Yes |
| `/activityconfig` | Staff gate | Yes |
| `/grantxp` | ManageGuild | Yes |
| `/ticket panel create\|list\|edit\|delete` | Staff gate | Yes |
| `/ticket setcategory\|setarchive\|setratelimit` | Staff gate | Yes |
| `/honeypot channel\|banrole` | Staff gate | Yes |
| `/honeypot exempt …` | ManageGuild | Yes |
| `/honeypot safety resume` | ManageGuild (handler gate; staff-tier picker) | Yes |
| `/eventreminder setchannel` | Staff gate | Yes |
| `/eventreminder edit\|clear\|sync` | ManageGuild **or** event creator | Yes |
| `/event create\|list\|wizard` | Public (create narrowed by `event_channels` create-role when set) | Yes |
| `/event edit\|post\|duplicate\|delete` | Staff gate **or** event organizer | Yes |
| `/event adopt` | Staff gate (plain — no organizer arm) | Yes |
| `/eventsignup response\|options` | Staff gate **or** event organizer | Yes |
| `/eventsignup preset` | Staff gate | Yes |
| `/eventconfig reminders status\|mute\|unmute` | Public (own prefs) | Yes |
| `/eventconfig reminders on\|off\|default` | Staff gate (guild default for **new** events; personal muting is `/eventreminder optout` — #348) | Yes |
| `/eventconfig reminders add\|remove\|list` | Staff gate **or** event organizer | Yes |
| `/eventconfig series` | Staff gate **or** event organizer | Yes |
| `/eventconfig settings …` | Staff gate | Yes |
| `/eventconfig google …` | Own account (`autoset` = Staff gate) | Yes |
| `/eventchannels channel` | Staff gate | Yes |
| `/eventchannels crosspost …` | Staff gate (approve = dest staff) | Yes |
| `/eventreminder create` | **Retired** → redirects to `/event create` (E13) | Yes |
| `/settings` | Staff gate | Yes |
| `/setxp` | Staff gate | Yes |
| `/setdecay` | Staff gate | Yes |
| `/setlog` | Staff gate | Yes |
| `/leveltorole set\|remove\|list` | Staff gate | Yes |
| `/youtube add\|remove\|list` | Staff gate | Yes |
| `/setyoutube channel\|interval\|uploadrole` | Staff gate | Yes |
| `/testnotification` | Staff gate | No |
| `/twitch add\|remove\|list\|clips\|vod\|offline\|notify\|template` | Staff gate | Yes |
| `/settwitch channel\|role\|interval\|settings` | Staff gate | Yes |
| `/rss add\|remove\|list\|test\|check` | Staff gate | Yes |
| `/setrss channel\|role\|interval\|settings` | Staff gate | Yes |
| `/github watch\|token\|remove\|list\|channel\|role\|check` | Staff gate | Yes |
| `/reactionrole panel\|option\|sync` | Staff gate | Yes |
| `/gork keyword\|role\|context\|cooldown\|rules\|search\|ste\|enable\|ban\|unban\|bans\|memory\|budget\|log\|logchannel\|summarize-budget\|status` | Staff gate | Yes |
| `/gork summarize` | Staff gate | No — rundown embed posts publicly (gate/error replies ephemeral) |
| `/automod status` (#725) | Staff gate | Yes |
| `/automodconfig …` (#725) | ManageGuild (picker AND handler) | Yes |
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
/leaderboard [limit] [page]          → Paginated PNG leaderboard (1-20/page, max page 20)
/warn mine                         → Your own warnings
/ticket create [reason]            → Open a support ticket
/ticket settings                   → View ticket config
/eventreminder optout|optin|mute|unmute|status → Reminder ping preferences
/eventreminder list                → List active event reminders
/event create|list|wizard          → Community events (edit/post/delete per-event gated; adopt = staff gate)
/eventsignup response|options|preset → Event signups/options/presets (staff/organizer gates)
/eventconfig settings|reminders|google|series → Event settings (reminder mute/unmute/status personal; reminders on/off/default + settings = staff)
/eventchannels channel|crosspost   → Event channels + cross-posting (staff gate)
/play query:                       → Play in your voice channel
/music skip|pause|resume|stop|leave|queue|nowplaying|volume|shuffle|remove|seek
/link create|connect|status|remove|config → Cross-platform account link (DM-first)

STAFF GATE (Manage Server OR any staff role):
/note add|list|edit|delete|info|settings
/warn add|list|info|void|count|export|settings
/setwarn dm|log|expiry
/userinfo user:                    → Member card (Activity = senior)
/activityconfig ignore|status|backfill
/ticket for|claim|transfer|list|info|summarize
/ticket adduser|removeuser|addstaff|removestaff
/ticket sensitive|unsensitive|close|archive
/ticket panel create|list|edit|delete | setcategory|setarchive|setratelimit
"Report Post" / "Report User"  → Right-click message/member → Apps (staff report ticket)
/bridge create|connect|disconnect|retry|status|list → Cross-platform channel bridge (staff)
/staff role list | /staff settings
/staffsettings roles|overview       → Staff-visible read view of the above (#599)
/settings | /setxp | /setdecay | /setlog
/leveltorole set|remove|list
/youtube add|remove|list
/setyoutube channel|interval|uploadrole
/testnotification
/twitch add|remove|list|clips|vod|offline|notify|template
/settwitch channel|role|interval|settings
/rss add|remove|list|test|check
/setrss channel|role|interval|settings
/github watch|token|remove|list|channel|role|check
/reactionrole panel|option|sync
/gork keyword|role|context|cooldown|rules|search|ste|enable|ban|unban|bans|memory|budget|log|logchannel|summarize-budget|status
/gork summarize (from|to|last)       → conversation rundown (10-min guild cooldown)
/automod status                      → Auto-mod config + budget + breaker (staff, #725)
/honeypot channel|banrole
/eventreminder setchannel
/eventreminder edit|clear|sync       → creator OR Manage Server (create retired → /event)

MANAGE SERVER ONLY:
/grantxp user amount [reason]      → Manually grant XP
/staff role add|remove|setlevel    → Configure staff roles
/staff syncpermissions             → OAuth sync slash visibility for staff roles
/setcommandchannel add|remove|list → Command channel allow-list
/honeypot exempt …                 → Staff-role alias
/honeypot safety resume            → Un-pause honeypot bans after the #440 safety valve
/automodconfig channel|rules|enable|mode|timeout-cap|budget → Auto-mod config (#725)
/automodconfig safety resume       → Re-arm auto kick/ban/timeout (confirm:true, #725)
```
