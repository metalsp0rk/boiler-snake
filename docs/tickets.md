# Help Ticket System

Private per-server support tickets: members open a channel with staff, staff respond, then **non-sensitive** tickets are closed and **archived** (HTML transcript + summary in a staff channel). **Sensitive** tickets are never content-archived—closing deletes the channel and posts a metadata-only stub.

## How it works

```
Member /ticket create [reason]
        → rate limit (default 1 self-create / 60 min)
        → channel ticket-N under configured category
        → overwrites: @everyone deny view; members + each staff role allow
        → welcome embed

Staff /ticket claim · adduser · sensitive · close · archive
        → close: remove non-staff members; keep channel for staff
        → archive: non-sensitive → fetch → HTML transcript → archive embed → delete channel
                   sensitive → metadata stub only → delete channel (no content)
```

| Rule | Detail |
|------|--------|
| Staff access | Guild [staff roles](https://github.com/metalsp0rk/boiler-snake/blob/main/ROADMAP.md#4-guild-staff-roles-admin-gate) + Manage Server (not a ticket-only role) |
| Rate limit | Self-create only; `/ticket for` is unlimited |
| Concurrent opens | No cap per user |
| Transcript URL | Staff archive channel only — never DMed to the requester |
| Sensitive | No message fetch, no HTML, no AI; channel delete is disposal |

## Setup

1. Give the bot **Manage Channels** (and keep **Manage Roles** if you use level/reaction roles). Without Manage Channels, Discord returns `50013 Missing Permissions` on create.
2. Put the **bot role above** every staff role in Server Settings → Roles. Discord will not let the bot set overwrites for higher roles.
3. Add staff roles: `/staff role add` (so mods see ticket channels and pass the command gate).
4. Optional category: `/ticket setcategory` (Manage Server). Ensure the bot is allowed to create channels under that category.
5. Archive channel (staff-only in Discord perms): `/ticket setarchive`.
6. Optional rate limit: `/ticket setratelimit` (default **60** minutes; `0` = off).
7. Optional transcript HTTP (for clickable HTML links + staff index):

```bash
TICKET_HTTP_PORT=8080
TICKET_PUBLIC_BASE_URL=https://tickets.example.com
```

| Path | Purpose |
|------|---------|
| `GET /t` or `/` | **Index** of content-archived tickets (ticket #, guild, closed time, subject, link) |
| `GET /t/{uuid}` | Single HTML transcript |
| `GET /t/{uuid}/assets/{file}` | Mirrored attachment / embed media for that transcript |
| `GET /t?guild=<id>` | Filter index to one guild |
| `GET /t?page=N` | Pagination (50 per page) |
| `GET /health` | Health check |

On-disk layout (under `DATA_DIR`):

```
ticket-transcripts/{guild_id}/{uuid}/index.html
ticket-transcripts/{guild_id}/{uuid}/assets/001_photo.png
```

Reverse-proxy TLS in front of the bot process. The index is **not** Discord-login-gated (MVP) — keep the host private (VPN, basic auth, firewall). Sensitive tickets never appear on the index (no content archive). Still treat the Discord archive channel as staff-only.

8. Optional AI summaries (non-sensitive closes only):

```bash
AI_API_KEY=...
AI_BASE_URL=https://api.openai.com/v1   # OpenAI-compatible
AI_MODEL=gpt-4o-mini
```

Without an API key, archives use a stats + close-reason fallback summary.

## Commands

### Everyone

| Command | Description |
|---------|-------------|
| `/ticket create [reason]` | Open a ticket for yourself (rate-limited) |
| `/ticket settings` | Show category, archive channel, rate limit, staff roles |

### Staff (`requireStaff`)

| Command | Description |
|---------|-------------|
| `/ticket for user [reason]` | Open a ticket for a member (not rate-limited) |
| `/ticket claim` | Become staff owner (in ticket channel) |
| `/ticket transfer staff` | Reassign staff owner |
| `/ticket adduser` / `removeuser` | Member participants |
| `/ticket addstaff` / `removestaff` | Named staff allow-list (esp. when sensitive) |
| `/ticket sensitive` | Lock-down; auto-claims if no owner |
| `/ticket unsensitive` | Restore staff-role visibility |
| `/ticket close [reason]` | Soft-close: remove non-staff; **keep** channel for staff |
| `/ticket archive` | After close: save transcript (if not sensitive), post summary, **delete** channel |
| `/ticket list [user]` | Open tickets |
| `/ticket info` | Detail for the current ticket channel (open or soft-closed) |

Lifecycle commands work **inside the ticket channel** even if command-channel restrictions are set.

### Admin (Manage Server)

| Command | Description |
|---------|-------------|
| `/ticket setcategory` | Parent category for new tickets |
| `/ticket setarchive` | Channel for close embeds + transcript links |
| `/ticket setratelimit` | Minutes between self-creates (`0` = off) |

## Sensitive tickets

1. Prefer `/ticket claim`, then `/ticket sensitive` (auto-claims if needed).
2. Overwrites remove staff **roles** and allow only owner + `/ticket addstaff` users + members + bot.
3. On **archive**: metadata stub in the archive channel only; **no** transcript URL or message storage.

## Close vs archive

### `/ticket close` (soft-close)

1. Mark ticket `status=closed` (channel id **kept**).
2. Rewrite overwrites: staff retain access; **non-staff members lose view**.
3. Post an in-channel notice; optional DM to requester (reason only).
4. Channel stays for staff review until archive.

### `/ticket archive` (dispose)

Requires a **closed** ticket channel.

**Non-sensitive:**

1. Fetch channel messages (oldest → newest).
2. Resolve display names (guild nickname → global name → username) for requester, staff owner, message authors, and `<@id>` mentions in content.
3. **Download media** (attachments, embed images/thumbnails/videos, stickers) into  
   `{DATA_DIR}/ticket-transcripts/{guild_id}/{uuid}/assets/`, rewrite links to  
   `/t/{uuid}/assets/…` (served by the bot). Caps: 50 MiB/file, 100 files/ticket (env overrides below).
4. Store rows in `ticket_messages` (resolved authors, expanded mentions, local asset hrefs).
5. Write HTML under `{DATA_DIR}/ticket-transcripts/{guild_id}/{uuid}/index.html`.
6. Summarize (AI or fallback).
7. Post embed to the archive channel (summary + link if `TICKET_PUBLIC_BASE_URL` set).
8. Delete the live ticket channel.

Transcript people lines look like `Cool Nick (@username) · 1234567890`. Mentions in message text become `@Cool Nick` (id kept in the author meta line). Images/videos/audio render inline in the HTML when mirrored.

**Sensitive:** metadata stub only → delete channel (no fetch/HTML/AI/URL/media).

Optional env for media mirroring:

```bash
# TICKET_MAX_ASSET_BYTES=52428800   # default 50 MiB per file
# TICKET_MAX_ASSETS=100            # default max files per ticket
```

## Not in MVP

- Panel message + “Open ticket” button → modal
- Discord OAuth gate on `/t/{uuid}`
- Concurrent open-ticket caps
- Re-download / re-mirror media for tickets archived before local assets existed

## Related

- [Staff notes](staff-notes.md) — private staff memory
- [Warnings](warnings.md) — formal disciplinary records
- [Architecture](architecture.md) — feature module layout
- [Database](database.md) — `tickets` tables
