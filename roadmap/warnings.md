# 6. Warning System

### Purpose

Formal, **permanent** disciplinary record for guild members. Complements [staff notes](staff-notes.md#5-staff-notes-system): notes are private working memory; warnings are countable, auditable strikes that staff and (optionally) the member can see. Built for long-term history—voidable with a paper trail, **not** casually deleted.

**Staff ops access:** same [guild staff roles / admin gate](staff-roles.md#4-guild-staff-roles-admin-gate).

### Status

**Shipped (MVP + post-MVP polish)** — `/warn` + `/setwarn`, permanent rows, void with reason, member `/warn mine`, optional note link, DMs + audit embeds, opt-in expiry, staff export, evidence fields. Design decisions in [6.9](#69-design-decisions-locked). Auto-mod thresholds remain post-MVP.

---

### 6.1 Notes vs warnings (product contract)

| | Staff notes | Warnings |
|--|-------------|----------|
| Intent | Informal context | Formal disciplinary action |
| Member visibility | Never | Active warnings listable by subject; optional DM on issue |
| Mutability | Edit + soft-delete | **No edit of reason** after issue; **void** only (keeps row) |
| Counting | Not counted | Active count drives history / future auto-mod |
| Permanence | Soft-deleted notes hidden by default | **Permanent record** — voided still appears in full history |
| Human id | `N-{n}` | `W-{n}` |
| Staff access | Guild staff roles (§4) | Guild staff roles (§4) |

Staff should use **notes** for soft context and **warnings** when the action is on the record.

---

### 6.2 Core behavior

```
Staff issues /warn add @user reason
        → requireStaff
        → allocate sequential warning_number (W-n)
        → persist row (active; never hard-deleted by bot commands)
        → optional DM to member (guild setting; default ON)
        → optional embed to audit / warn-log channel
        → ephemeral confirm to staff with active count

Staff voids /warn void id reason
        → set voided_at / voided_by / void_reason
        → row remains queryable forever as voided
        → optional DM + staff log “warning voided”

Staff / member lists history
        → active by default; full history includes voided
```

| Rule | Detail |
|------|--------|
| Permanence | No hard-delete command. Void = soft cancel with reason. |
| Reason | **Required** on issue and on void |
| Scope | Per guild + user |
| Active count | `COUNT(*) WHERE voided_at IS NULL` for that guild/user |
| Self-service | Members may view **their own** warnings (`/warn mine`) without staff role |
| Staff access | `requireStaff` ([§4](staff-roles.md#4-guild-staff-roles-admin-gate)) |
| Escalation | Threshold auto-kick/ban = **post-MVP** |

---

### 6.3 Commands

#### Staff ops (`requireStaff`)

| Command | Description |
|---------|-------------|
| `/warn add user:<member> reason:<text> [silent:<bool>]` | Issue a warning. `silent` skips member DM for this issue only. |
| `/warn list user:<member> [include_voided:<bool>]` | History for a member (default active only) |
| `/warn info id:<warning_id\|W-n>` | Full detail: reason, issuer, timestamps, void metadata |
| `/warn void id:<…> reason:<text>` | Void a warning (permanent row; marks inactive) |
| `/warn count user:<member>` | Active warning count (+ optional recent snippet) |
| `/warn settings` | DM flag, log target; points at `/staff role list` for access |

#### Config (ManageGuild only — same meta-privilege as staff role config)

| Command | Description |
|---------|-------------|
| `/setwarn dm <true\|false>` | Toggle member DMs on issue/void (default true) |

#### Everyone

| Command | Description |
|---------|-------------|
| `/warn mine [include_voided:<bool>]` | View your own warnings in this guild (ephemeral) |

Ephemeral replies for all `/warn` commands (staff logs are separate channel posts).

**Reason length:** non-empty trimmed text; max **1000** chars (MVP). Longer narratives belong in a linked staff note.

---

### 6.4 Member notification & staff log

#### DM to member (default on)

When a warning is issued and DMs are open:

- Embed title: `Warning issued in {guild name}`
- Fields: warning id (`W-n`), reason, issuer (display name), active count after issue, timestamp
- Footer: how to view history (`/warn mine`)

On void (if DM on): short notice that `W-n` was voided and by whom (optional reason).

Guild setting `warn_dm_members` (default **1**). Per-issue `silent:true` overrides DM off for that issue only (staff still get confirm).

#### Staff / audit channel

When dedicated `warn_log_channel_id` is set **or** `audit_log_channel_id` is set (fallback):

| Event | Embed |
|-------|--------|
| Warning issued | Target, issuer, `W-n`, reason, new active count |
| Warning voided | Target, voider, `W-n`, void reason, remaining active count |

**Shipped:** prefer `warn_log_channel_id` (`/setwarn log`); fall back to **audit log** when dedicated channel is unset.

---

### 6.5 Configuration

| Setting / command | Description |
|-------------------|-------------|
| Guild staff roles | Access control via [§4](staff-roles.md#4-guild-staff-roles-admin-gate) (`/staff role *`) |
| `/warn settings` | DM flag, log target |
| `/setwarn dm <true\|false>` | Toggle member DMs (ManageGuild) |
| `/setwarn log channel\|clear` | Dedicated warn log channel (ManageGuild); falls back to audit |

**Stored in `guild_settings`:**

| Column | Purpose |
|--------|---------|
| `warn_dm_members` | `1` (default) / `0` — DM subject on issue/void |
| `warn_log_channel_id` | Optional dedicated issue/void log channel (**shipped**) |

**Later:** auto-mod thresholds, warn-expiry timers.

---

### 6.6 Database schema (working draft)

```sql
-- guild_settings.warn_dm_members INTEGER NOT NULL DEFAULT 1
-- Access roles: staff_roles (see §4) — no warn_access_roles table

CREATE TABLE IF NOT EXISTS warnings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id        TEXT NOT NULL,
    warning_number  INTEGER NOT NULL,       -- sequential per guild (W-12)
    user_id         TEXT NOT NULL,         -- subject
    issuer_id       TEXT NOT NULL,         -- staff who issued
    reason          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    voided_at       INTEGER,
    voided_by       TEXT,
    void_reason     TEXT,
    related_note_id INTEGER REFERENCES staff_notes(id) ON DELETE SET NULL,
    UNIQUE (guild_id, warning_number)
);
CREATE INDEX IF NOT EXISTS idx_warnings_user
  ON warnings(guild_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warnings_active
  ON warnings(guild_id, user_id) WHERE voided_at IS NULL;
```

**Repositories / db facade (sketch):**

- `createWarning({ guildId, userId, issuerId, reason, relatedNoteId? })`
- `listWarnings(guildId, userId, { includeVoided })`
- `getWarning(guildId, warningNumberOrId)`
- `voidWarning(id, { voidedBy, voidReason })`
- `countActiveWarnings(guildId, userId)`
- `updateGuildSettings` key `warn_dm_members`

**Integrity rules:**

- `void` requires non-empty `void_reason`.
- Cannot “un-void” in MVP (re-issue if needed).
- `related_note_id` is optional; soft-deleting a note does not remove the warning.

---

### 6.7 Integration points

| Area | Change |
|------|--------|
| `src/features/warnings/` | Feature module (commands + DM/log helpers) |
| `src/commands/` registry | Register `/warn`, `/setwarn` |
| `src/db/` | Migration + repository + facade; optional FK to `staff_notes` |
| `src/core/permissions.js` | `requireStaff` on staff ops; `/warn mine` public |
| `src/features/logs/` / audit | Issue/void embeds on audit channel |
| Command channels | Honor existing allow-list for slash commands |
| Docs | `docs/warnings.md` (cross-link staff notes + staff roles) |

**Bot permissions:** Send Messages + Embed Links in audit channel; DM failure does not roll back the warning.

---

### 6.8 Implementation order

1. Depends on §4 `requireStaff`  
2. Migration + repository (`warnings` + `warn_dm_members`)  
3. `/warn add` + `/warn list` + `/warn count` + `/warn info`  
4. `/warn void`  
5. `/warn mine` (no staff role required)  
6. DM + audit embeds; `/setwarn dm` + `/warn settings`  
7. Optional `related_note_id` once staff notes exist  
8. Docs + tests: issue, void, count, DM-off, staff role / outsider, permanence  

---

### 6.9 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Permanent record:** never hard-delete via bot commands; **void** only, with reason and actor. |
| 2 | **Reason immutable** after issue — void + re-issue, not silent edit. |
| 3 | **Complement to staff notes:** informal context in notes; formal strikes in warnings. |
| 4 | **DM members by default**; guild toggle + per-issue `silent`. DM failure does not roll back. |
| 5 | **Member self-view** via `/warn mine` (no staff role required). |
| 6 | **Access via guild staff roles** ([§4](staff-roles.md#4-guild-staff-roles-admin-gate)) — no `warn_access_roles` table. |
| 7 | **`/setwarn dm`:** ManageGuild only (meta config). |
| 8 | **Human ids** sequential per guild (`W-n`); stable forever including after void. |
| 9 | **No auto-mod escalation in MVP**. |
| 10 | **Audit stream:** reuse `audit_log_channel_id` when set. |

**Still open (non-blocking):**

- Whether void DMs use the same toggle as issue DMs (recommend **yes**).  
- Cross-link UX: `/warn add` optional `note:` from staff notes.  
- Export / prune policy for left members (recommend **keep forever**).
