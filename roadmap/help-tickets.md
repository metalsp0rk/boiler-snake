# 1. Help Ticket System

### Purpose

Ephemeral per-server ticket support: members open private channels with staff, staff respond, then **non-sensitive** tickets are closed and **archived** (AI summary + HTML transcript served by the bot). **Sensitive** tickets are never archived—content is destroyed with the channel.

### Status

**Shipped (MVP, panel registry, two-phase close→archive, asset mirror)** — see [docs/tickets.md](../docs/tickets.md). Design decisions locked in [1.10](#110-design-decisions-locked). Post-MVP remaining: Discord OAuth on transcripts.

---

### 1.1 Configuration

| Command | Description |
|---------|-------------|
| `/ticket setcategory <category>` | Category where ticket channels are created |
| `/ticket setarchive <channel>` | Channel that receives archive-summary embeds + transcript links (posted at `/ticket archive`; staff-only channel recommended) |
| `/ticket setratelimit <minutes>` | Min minutes between self-created tickets per user (default **60** = 1/hour). `0` = disable |
| `/ticket settings` | Show current ticket configuration (incl. which guild **staff roles** apply) |

**Staff access** for ticket commands and open-ticket channel overwrites comes from the guild-wide [staff roles](staff-roles.md#4-guild-staff-roles-admin-gate) list — **not** a ticket-only role. Configure with `/staff role add|remove|list`.

**Stored in `guild_settings`:**

| Column | Purpose |
|--------|---------|
| `ticket_category_id` | Parent category for open tickets |
| `ticket_archive_channel_id` | Staff-visible channel for archive posts |
| `ticket_rate_limit_minutes` | Cooldown for member self-create; default `60` |

**Panel:** `/ticket panel create` (staff) posts a public embed + **Open a ticket** button. Panels are a **stored registry**: every posted panel gets a row in `ticket_panels` (migration `src/db/migrations/019_ticket_panels.js` — guild/channel/message id + title/description), so `/ticket panel list|edit|delete` can find and manage them (delete removes both the Discord message and the row). *(Shipped — the original "no DB row; delete the Discord message to remove" draft was superseded; `handlePanelCreate|List|Edit|Delete` in `index.js`.)*

---

### 1.2 Ticket Creation

| Command | Who | Description |
|---------|-----|-------------|
| `/ticket create [reason]` | Any member | Open a ticket for yourself (subject to rate limit) |
| `/ticket for <user> [reason]` | Staff | Pull a member into a **new** ticket (staff-initiated; **not** rate-limited like self-create) |

**Create UX:** slash `/ticket create` + staff `/ticket for`, plus staff `/ticket panel create` → button → **modal** for description (same self-create pipeline and rate limit).

**On create:**

1. Enforce rate limit for **member self-create** only (`/ticket create` and the panel-button modal). Staff `/ticket for` bypasses member cooldown. **No cap** on concurrent open tickets per user.
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
| **Senior guild staff roles** (rows in `staff_roles` at level **senior**) | Full staff access (view, send, manage messages, etc.). Junior roles get **no** automatic overwrite |
| Bot | Full channel management |

Two tiers off one list (shipped): the **command gate** passes ManageGuild or **any** configured staff role, but **channel overwrites** are granted to **senior** staff roles only — `getManageableStaffRoleIds()` reads `listSeniorStaffRoles` in `overwrites.js`, so junior staff pass `requireStaff` yet get no automatic ticket visibility (promote with `/staff role setlevel`). `/ticket settings` shows which roles are senior. If **no** staff roles are configured, only ManageGuild holders pass the command gate and no role gets ticket overwrites—admins should run `/staff role add` first.

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
2. **Remove allow / explicitly deny** the staff-role overwrites on this channel (the senior set; junior roles never had an allow—the `@everyone` deny covers them).
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
| `/ticket close [reason] [staff_note]` | **Phase 1 (soft-close):** mark closed, strip non-staff members, DM the requester—**channel stays** for staff until archive (see [1.5](#15-close--archive-pipeline)) |
| `/ticket archive` | **Phase 2:** on a closed ticket—transcript + archive post (only if **not** sensitive), then **delete the channel** (see [1.5](#15-close--archive-pipeline)) |
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

Staff only, in a ticket channel. **Shipped as two phases:** `/ticket close` soft-closes and **keeps** the channel; `/ticket archive` runs the archive pipeline on a closed ticket and **deletes** it (`softCloseTicket` + `archiveTicketPipeline` in `close.js`; `handleArchive` requires the ticket `status = closed` with the channel still live).

#### Phase 1 — `/ticket close` (soft-close; shipped)

```
1. Update DB   — status=closed, closed_at, closed_by, close_reason (markTicketClosed;
                 is_sensitive untouched; archived stays 0)
2. Strip access — member participants lose view (explicit deny); staff roles and
                 named staff keep the channel
3. In-channel  — close notice: reason + "run /ticket archive when ready to save the
                 transcript and delete the channel" (sensitive: warns no content saves)
4. DM requester — "closed + reason" only; never a transcript URL
5. Optional    — one-shot staff note on the requester (staff_note option / Add staff note button)
```

Nothing is fetched, rendered, or summarized at close time—both branches below run in Phase 2.

#### Phase 2 — `/ticket archive` (archive + channel delete)

##### Branch A — Sensitive ticket (**no content archive**; metadata stub required)

Sensitive tickets **must not** be content-archived. On `/ticket archive`:

```
1. Finalize DB— closeTicketSensitive (metadata only; is_sensitive remains 1; archived=0;
                status/closed_at/close_reason were already set by the soft-close)
2. No fetch   — do not paginate or store messages
3. No HTML    — do not write transcript files
4. No AI      — do not send content to any LLM
5. No URL     — transcript_token / path stay null
6. Stub post  — required: post a minimal, non-content embed in the archive channel, e.g.
               “Ticket #42 closed (sensitive — not archived)” with closer, requester,
               timestamps, and close reason only. No transcript link, no message excerpts.
7. Delete     — delete the live Discord channel
8. DM note    — the close DM (Phase 1) was “closed + reason” only; never a transcript link
```

Rationale: privacy. Channel deletion is the disposal mechanism; DB + archive stub retain metadata only (who/when/sensitive flag), not conversation content.

##### Branch B — Non-sensitive ticket (full archive)

```
1. Freeze   — deny @everyone sends while archiving
2. Fetch    — paginate all channel messages (oldest → newest); resolve display names
3. Mirror   — download attachments / embed media into the transcript bundle and
              rewrite URLs to local paths (see Attachments below)
4. Persist  — store structured messages in ticket_messages (+ ticket meta)
5. Render   — generate HTML transcript on disk
6. Summarize— AI structured summary (or stats fallback if no AI key)
7. Publish  — post embed to ticket_archive_channel with summary + transcript URL
8. Notify   — once the embed posted, DM the requester: archived + reason +
              **transcript URL** (see §1.11 fix; a failed DM is a warning line, and the
              sensitive branch still never sends a URL)
9. Delete   — delete the live Discord channel (last; failure reported as a warning)
```

#### HTML transcript (bot-served)

- **Render:** standalone HTML — ticket meta, participants, chronological messages, attachment links (local `/t/{uuid}/assets/…` paths after mirroring; CDN hotlink as fallback), timestamps.
- **Store:** one bundle dir per transcript: `{DATA_DIR}/ticket-transcripts/{guild_id}/{uuid}/index.html` + `assets/` (UUID matches public token; legacy flat `{uuid}.html` files stay readable — `transcript.js`).
- **Serve:** small HTTP server in the bot process:
  - Paths: `/t/{uuid}` (UUID v4) and `/t/{uuid}/assets/{file}` (mirrored media — `httpServer.js`)
  - Config: `TICKET_HTTP_PORT`, `TICKET_PUBLIC_BASE_URL` (public origin for embeds; reverse-proxy TLS documented for operators)
- **Access control (MVP):**
  - UUID in the path (unguessable).
  - Link posted in the configured **staff** archive channel, and **DM’d to the ticket requester** at archive time for **non-sensitive** tickets (see §1.11; supersedes the original staff-only rule).
  - Other members / other staff never receive the transcript URL. Sensitive tickets never generate or send one.
  - **Later:** “Login with Discord” gate on `/t/{uuid}`.
- **Attachments (shipped):** at archive time all message attachments + embed media are downloaded into  
  `{DATA_DIR}/ticket-transcripts/{guild_id}/{uuid}/assets/` and the transcript is rewritten to local  
  `/t/{uuid}/assets/…` links (`mirrorTicketAssets` in `assets.js`, wired into the archive pipeline in `close.js`).  
  ~~TODO (post-MVP): local mirror~~ **Shipped** — hotlinking CDN URLs alone was not durable (links expire).  
  Files that fail to download or exceed the caps (defaults: `TICKET_MAX_ASSETS` 100, `TICKET_MAX_ASSET_BYTES` 50 MiB)  
  keep their CDN hotlink and surface as warning lines; the archive never aborts on them.

#### AI-generated structured summary

Only for **non-sensitive** archives (runs inside `/ticket archive`). Posted as embed fields in the archive channel (plus transcript link).

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
| Transcript | `[View HTML transcript](https://…/t/{uuid})` — staff archive embed, plus requester DM (§1.11) |

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
- Embed: structured summary + transcript URL (posted during the `/ticket archive` phase).
- On partial failure: still prefer HTML on disk + DB close row; post “summary unavailable” if AI fails; a missing/unwritable archive channel surfaces as a warning line on the archive reply.

#### Archive channel message (sensitive — required stub)

- Same channel, **metadata only**, clearly labeled **not archived** / **sensitive** (posted during the `/ticket archive` phase).
- No link, no content, no AI.
- If archive channel is unset, the archive still runs and the channel is still deleted; the `/ticket archive` reply carries a warning that the stub could not be posted.

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
    attachment_urls  TEXT,   -- JSON array of attachment objects (CDN hotlinks pre-mirror;
                              --   local /t/{uuid}/assets hrefs + source_url after mirroring)
    embeds_json      TEXT,
    sent_at          INTEGER NOT NULL,
    UNIQUE (ticket_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket ON ticket_messages(ticket_id);

-- guild_settings:
--   ticket_category_id TEXT
--   ticket_archive_channel_id TEXT
--   ticket_rate_limit_minutes INTEGER NOT NULL DEFAULT 60
-- Staff roles: staff_roles (generalized honeypot_exempt_roles); rows at the SENIOR level get
--   ticket channel overwrites, any level passes the command gate (see §1.3)
-- ticket_panels (added post-draft, migration 019_ticket_panels.js): panel registry —
--   guild_id, channel_id, message_id, title, description; PK (guild_id, message_id)
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
- `markTicketClosed(ticketId, { closedBy, closeReason })` — phase 1 `/ticket close` (status/timestamps only)
- `closeTicketSensitive(ticketId, { closedBy, closeReason })` — finalized at `/ticket archive`: metadata only, `archived=0`
- `closeTicketArchived(ticketId, { closedBy, closeReason, transcriptToken, transcriptPath, aiSummaryJson, archiveMessageId })` — finalized at `/ticket archive`: `archived=1`
- `saveTicketMessages(ticketId, messages[])`
- `markTicketClosedByChannelDelete(channelId)` — `ChannelDelete` salvage path
- Panel registry (shipped, `ticket_panels`): `createTicketPanel` / `listTicketPanels` / `updateTicketPanelText` / `deleteTicketPanel`

---

### 1.8 Event Handlers

| Event | Purpose |
|-------|---------|
| Slash + panel button/modal | Create, for, close, archive, sensitive, claim, adduser, addstaff; panel create/list/edit/delete (registry-backed); panel open → modal |
| `ChannelDelete` | If ticket channel deleted outside `/ticket close`: mark `closed`, `archived=0`, no salvage for sensitive intent; non-sensitive best-effort only if we still have cache (usually not) |

Channel create is **bot-driven**.

---

### 1.9 Implementation Order

1. **Schema + settings** — migrations; setcategory / setarchive / setratelimit / settings (depends on [staff roles](staff-roles.md#4-guild-staff-roles-admin-gate) for gate + overwrites)  
2. **Create paths** — `/ticket create`, `/ticket for`, overwrites for staff roles *(shipped: **senior**-level rows only—§1.3)*, rate limit  
3. **Claim / adduser / addstaff / sensitive** — overwrite rewrite (deny all staff roles when sensitive)  
4. **Close (sensitive branch)** — metadata + required archive-channel stub + delete channel *(shipped two-phase: `/ticket close` soft-closes, `/ticket archive` runs the branch—§1.5)*  
5. **Close (archive branch)** — fetch, HTML, UUID route HTTP server, archive embed (stats fallback)  
6. **AI summary** — non-sensitive only; graceful fallback  
7. **Post-MVP** — Discord OAuth on `/t/{uuid}`. *(Shipped since: panel registry list/edit — `ticket_panels` + `/ticket panel create|list|edit|delete`; local attachment mirror — `mirrorTicketAssets` in `assets.js`.)*  

---

### 1.10 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Ownership:** claim / auto-claim on sensitive; `/ticket transfer`; `/ticket addstaff` for extra named staff without restoring staff role |
| 2 | **Sensitive tickets are never content-archived** — no message fetch, no HTML, no AI, no transcript URL; channel delete is disposal; **required** metadata-only archive stub |
| 3 | ~~Transcript URL is staff-only~~ **Revised (see §1.11):** archive-channel embed **plus** DM of the transcript link to the **requester** for non-sensitive tickets; sensitive tickets never get any URL |
| 4 | **MVP URL security:** UUID path `/t/{uuid}`; **later:** Login with Discord for real access control |
| 5 | ~~**Attachments MVP:** hotlink Discord CDN URLs; **TODO:** download all thread assets at archive time and serve locally~~ **Revised (shipped):** archive-time asset mirroring is live — media is downloaded into the transcript bundle and served from `/t/{uuid}/assets/…` (`mirrorTicketAssets`, `assets.js`, wired in `close.js`); CDN hotlink survives only as fallback for failed/over-cap downloads |
| 6 | **Create UX:** slash `/ticket create` + staff `/ticket for @user` + **panel button → modal** for description (same pipeline) |
| 7 | **Rate limit:** configurable per guild; **default 60 minutes** (1 self-create per hour); staff `/ticket for` not subject to member cooldown |
| 8 | **No concurrent open-ticket cap** per user — rate limit only throttles new self-creates |
| 9 | **Sensitive close stub required** in the archive channel (metadata only; no transcript) |
| 10 | **`/ticket unsensitive`:** staff **owner** or anyone passing the [staff/admin gate](staff-roles.md#4-guild-staff-roles-admin-gate) |
| 11 | **No ticket-only staff role** — use guild `staff_roles` (generalized `honeypot_exempt_roles`) for commands + channel overwrites. **Revised (shipped):** overwrites go to **senior**-level rows only (`listSeniorStaffRoles` in `overwrites.js`); any level passes the command gate (junior staff see no tickets without a named add) |
| 12 | **Two-phase lifecycle (shipped):** `/ticket close` soft-closes (DB status + strip member access + requester DM, **channel kept** for staff); `/ticket archive` runs the archive pipeline and **deletes** the channel (`softCloseTicket` + `archiveTicketPipeline`, `close.js`). Supersedes the original one-shot close-and-archive design |

---

### 1.11 Planned fixes (both shipped)

Two reported issues — **both shipped** in `src/features/tickets/` (`overwrites.js`, `close.js`); unit tests in `test/tickets.test.js`, integration coverage in `test/integration/tickets.test.js`.

#### Fix 1 — bogus “staff role(s) could not get channel access” note on ticket create

**Symptom:** `/ticket create` (and the panel / `/ticket for` paths) replies with “_Note: 1 staff role(s) could not get channel access (bot role must be higher than staff roles, and roles must still exist)._” even when the bot's role **is** above the configured staff roles.

**Where:** `getManageableStaffRoleIds()` in `src/features/tickets/overwrites.js`; the note is assembled in `src/features/tickets/index.js` (`completeSelfCreate` / `handleFor`).

**Root causes — all addressed:**

- [x] **Cache-miss false positive:** role lookup is `guild.roles.cache.get()` only. A staff role missing from the role cache (newly created, guild fetched without roles, cache race) is reported “role not found in guild”. Add a `guild.roles.fetch(roleId)` fallback before skipping. *(Shipped: `resolveStaffRole` — v14 semantics keep deleted-role `null` apart from API failures, which report “lookup failed: cause” instead of “not found”.)*
- [x] **Bot holds the staff role itself:** the `rolePos >= botPos` check counts a staff role the bot also holds as “above/equal the bot” and skips it. When the bot holds the role, an overwrite is unnecessary for the bot — distinguish this case (and if any staff members hold it, recommend/rely on a distinct higher bot admin role instead of a misleading note). *(Shipped: `botHoldsRole` — silently skipped; the overwrite is still granted when the bot has a separate higher role.)*
- [x] **Undiagnosable note:** the note shows only a count. Include each skipped role's **name** + specific reason (never a role ping) so admins know what to fix; log the same detail. *(Shipped: `formatStaffRoleAccessNote` — one line per role with name/id + reason; `describeSkippedStaffRoles` mirrors it to the log.)*
- [x] Tests: unit cases for cache-miss fallback, bot-held staff role, managed role, true hierarchy skip; integration test that create succeeds with no note when the bot role is above staff roles.

#### Fix 2 — DM the transcript link to the requester on archive

**Requested change:** when a ticket is archived, the requester should receive the transcript link too — not only the staff archive channel. **Revises locked decision 3** (staff-only URL) for **non-sensitive** tickets only; the sensitive branch is unchanged (no transcript exists to send).

- [x] After the archive embed posts successfully (and before/after channel delete), DM `creator_user_id`: ticket ref, close reason, and `[View transcript](url)` when `TICKET_PUBLIC_BASE_URL` is configured. *(Shipped: `notifyRequesterArchived` + `buildArchiveDmEmbed`; the link only appears when the public URL is configured.)*
- [x] Best-effort: closed DMs / blocked bot → ignore silently (optionally note in the closer's ephemeral reply as a warning). Never fail the archive because the DM failed. *(Shipped: `{ ok:false, error }` return surfaced as a warning line on the archive reply; the archive never aborts.)*
- [x] Requester only — do not DM other ticket members.
- [x] Sensitive tickets: DM stays “closed + reason only”, never a URL (already the contract).
- [x] Update [docs/tickets.md](../docs/tickets.md) transcript access-control wording when shipped. *(Done — staff archive embed **plus** requester DM wording, sensitive never gets a URL.)*
