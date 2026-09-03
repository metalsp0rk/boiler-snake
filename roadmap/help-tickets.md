# 1. Help Ticket System

### Purpose

Ephemeral per-server ticket support: members open private channels with staff, staff respond, then **non-sensitive** tickets are closed and **archived** (AI summary + HTML transcript served by the bot). **Sensitive** tickets are never archived—content is destroyed with the channel.

### Status

**Shipped (MVP + panel)** — see [docs/tickets.md](../docs/tickets.md). Design decisions locked in [1.10](#110-design-decisions-locked). Post-MVP remaining: Discord OAuth on transcripts; further attachment/panel polish.

---

### 1.1 Configuration

| Command | Description |
|---------|-------------|
| `/ticket setcategory <category>` | Category where ticket channels are created |
| `/ticket setarchive <channel>` | Channel that receives close-summary embeds + transcript links (staff-only channel recommended) |
| `/ticket setratelimit <minutes>` | Min minutes between self-created tickets per user (default **60** = 1/hour). `0` = disable |
| `/ticket settings` | Show current ticket configuration (incl. which guild **staff roles** apply) |

**Staff access** for ticket commands and open-ticket channel overwrites comes from the guild-wide [staff roles](staff-roles.md#4-guild-staff-roles-admin-gate) list — **not** a ticket-only role. Configure with `/staff role add|remove|list`.

**Stored in `guild_settings`:**

| Column | Purpose |
|--------|---------|
| `ticket_category_id` | Parent category for open tickets |
| `ticket_archive_channel_id` | Staff-visible channel for archive posts |
| `ticket_rate_limit_minutes` | Cooldown for member self-create; default `60` |

**Panel:** `/ticket panel` posts a public embed + **Open a ticket** button (no DB row; delete the Discord message to remove).

---

### 1.2 Ticket Creation

| Command | Who | Description |
|---------|-----|-------------|
| `/ticket create [reason]` | Any member | Open a ticket for yourself (subject to rate limit) |
| `/ticket for <user> [reason]` | Staff | Pull a member into a **new** ticket (staff-initiated; **not** rate-limited like self-create) |

**Create UX:** slash `/ticket create` + staff `/ticket for`, plus admin `/ticket panel` → button → **modal** for description (same self-create pipeline and rate limit).

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
| **Each guild staff role** (from `staff_roles` / generalized honeypot exempt list) | Full staff access (view, send, manage messages, etc.) |
| Bot | Full channel management |

Any member with a configured staff role (or ManageGuild for commands) can help. If **no** staff roles are configured, only ManageGuild holders pass the command gate; channel overwrites still need at least one staff role for non-admin staff to see tickets—admins should run `/staff role add` first.

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
| `/ticket unsensitive` | Restore default staff-role visibility. **Staff owner** or **staff gate** (ManageGuild / staff role) only |

**Overwrite strategy when sensitive:**

1. Keep `@everyone` deny view.
2. **Remove allow / explicitly deny** every guild staff role on this channel.
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
--   ticket_category_id TEXT
--   ticket_archive_channel_id TEXT
--   ticket_rate_limit_minutes INTEGER NOT NULL DEFAULT 60
-- Staff roles for overwrites + command gate: see staff_roles (generalized honeypot_exempt_roles)
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
| Slash + panel button/modal | Create, for, close, sensitive, claim, adduser, addstaff; panel open → modal |
| `ChannelDelete` | If ticket channel deleted outside `/ticket close`: mark `closed`, `archived=0`, no salvage for sensitive intent; non-sensitive best-effort only if we still have cache (usually not) |

Channel create is **bot-driven**.

---

### 1.9 Implementation Order

1. **Schema + settings** — migrations; setcategory / setarchive / setratelimit / settings (depends on [staff roles](staff-roles.md#4-guild-staff-roles-admin-gate) for gate + overwrites)  
2. **Create paths** — `/ticket create`, `/ticket for`, overwrites for **all** staff roles, rate limit  
3. **Claim / adduser / addstaff / sensitive** — overwrite rewrite (deny all staff roles when sensitive)  
4. **Close (sensitive branch)** — metadata + required archive-channel stub + delete channel  
5. **Close (archive branch)** — fetch, HTML, UUID route HTTP server, archive embed (stats fallback)  
6. **AI summary** — non-sensitive only; graceful fallback  
7. **Post-MVP** — Discord OAuth on `/t/{uuid}`; panel registry list/edit; further attachment polish (local mirror is already implemented)  

---

### 1.10 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Ownership:** claim / auto-claim on sensitive; `/ticket transfer`; `/ticket addstaff` for extra named staff without restoring staff role |
| 2 | **Sensitive tickets are never content-archived** — no message fetch, no HTML, no AI, no transcript URL; channel delete is disposal; **required** metadata-only archive stub |
| 3 | **Transcript URL is staff-only** — posted only to the ticket archive channel; never DMed to members/requesters |
| 4 | **MVP URL security:** UUID path `/t/{uuid}`; **later:** Login with Discord for real access control |
| 5 | **Attachments MVP:** hotlink Discord CDN URLs; **TODO:** download all thread assets at archive time and serve locally |
| 6 | **Create UX:** slash `/ticket create` + staff `/ticket for @user` + **panel button → modal** for description (same pipeline) |
| 7 | **Rate limit:** configurable per guild; **default 60 minutes** (1 self-create per hour); staff `/ticket for` not subject to member cooldown |
| 8 | **No concurrent open-ticket cap** per user — rate limit only throttles new self-creates |
| 9 | **Sensitive close stub required** in the archive channel (metadata only; no transcript) |
| 10 | **`/ticket unsensitive`:** staff **owner** or anyone passing the [staff/admin gate](staff-roles.md#4-guild-staff-roles-admin-gate) |
| 11 | **No ticket-only staff role** — use guild `staff_roles` (generalized `honeypot_exempt_roles`) for commands + channel overwrites |
