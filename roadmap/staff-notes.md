# 5. Staff Notes System

### Purpose

Private, staff-only notes about a guild member. Informal institutional memory for moderators—context that is **not** a formal disciplinary action and is **never** shown to the member.

Paired with the [Warning System](warnings.md#6-warning-system): notes hold soft context; warnings are the **permanent formal record**.

**Access:** [guild staff roles / admin gate](staff-roles.md#4-guild-staff-roles-admin-gate) — not a notes-specific role list.

### Status

**Shipped** — `/note` commands, soft-delete, sequential `note_number`, audit embeds, content modals, ticket-close attach. Access uses `requireStaff` ([§4 staff roles](staff-roles.md#4-guild-staff-roles-admin-gate)). Design decisions in [5.6](#56-design-decisions-locked).

---

### 5.1 Core behavior

```
Staff adds a note on a user
        → requireStaff (ManageGuild or staff role)
        → store in SQLite (guild-scoped)
        → staff can list / edit / soft-delete notes for that user
        → member never sees notes via bot commands or DMs
        → optional staff log channel embed on create/edit/delete
```

| Rule | Detail |
|------|--------|
| Audience | **Staff gate** only ([§4](staff-roles.md#4-guild-staff-roles-admin-gate)) |
| Visibility | Never DM’d; never exposed on member-facing commands |
| Mutability | Editable and soft-deletable (unlike warnings) |
| Scope | Per guild + user |
| Purpose | Context, history, “watch for X”, prior conversations—not a strike count |

---

### 5.2 Commands

| Command | Description |
|---------|-------------|
| `/note add user:<member> [content:<text>]` | Create a staff note (omit content → modal for long text) |
| `/note list user:<member>` | List notes for a member (newest first; paginate if many) |
| `/note edit id:<note_id> content:<text>` | Replace note body; record `edited_at` / `edited_by` |
| `/note delete id:<note_id>` | Soft-delete (`deleted_at`); keep row for audit |
| `/note info id:<note_id>` | Single note detail (author, timestamps, body) |
| `/note settings` | Brief status; points at `/staff role list` for access |

**Permission:** `requireStaff` for all note commands (no separate `/note role *`).

**UX notes:**
- Prefer a **modal** for long `content` (omit slash `content` on add/edit).
- Ephemeral replies for all note commands.
- List embeds: note id, snippet, author, relative time; deleted notes only if “include deleted” (default: active only).
- **Ticket close:** `/ticket close staff_note:…` and/or **Add staff note** button → modal.

---

### 5.3 Database schema (working draft)

```sql
CREATE TABLE IF NOT EXISTS staff_notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT NOT NULL,
    note_number  INTEGER NOT NULL,          -- sequential per guild (N-12)
    user_id      TEXT NOT NULL,            -- subject
    author_id    TEXT NOT NULL,            -- staff who created
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    edited_at    INTEGER,
    edited_by    TEXT,
    deleted_at   INTEGER,                  -- soft delete; null = active
    deleted_by   TEXT,
    UNIQUE (guild_id, note_number)
);
CREATE INDEX IF NOT EXISTS idx_staff_notes_user
  ON staff_notes(guild_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_notes_active
  ON staff_notes(guild_id, user_id) WHERE deleted_at IS NULL;
```

**Repositories / db facade (sketch):**

- `createStaffNote({ guildId, userId, authorId, content })`
- `listStaffNotes(guildId, userId, { includeDeleted })`
- `getStaffNote(guildId, noteNumberOrId)`
- `updateStaffNote(id, { content, editedBy })`
- `softDeleteStaffNote(id, deletedBy)`

Access checks live in `permissions.js` / staff roles — **not** a notes access-role table.

---

### 5.4 Integration points

| Area | Change |
|------|--------|
| `src/features/staffNotes/` | Feature module (commands + handlers) |
| `src/commands/` registry | Register `/note` subcommands |
| `src/db/` | Migration + repository + facade |
| `src/core/permissions.js` | `requireStaff` on every handler |
| Audit / staff log | Optional embeds on create/edit/delete when audit log channel is set |
| Docs | `docs/staff-notes.md` |

---

### 5.5 Implementation order

1. Depends on §4 staff roles / `requireStaff`  
2. Migration + repository  
3. `/note add` + `/note list`  
4. `/note edit` + `/note delete` + `/note info` + `/note settings`  
5. Optional audit embeds  
6. Docs + tests (CRUD, soft-delete, staff role vs outsider, ManageGuild)

---

### 5.6 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Staff-only:** notes never DMed or shown to the subject member. |
| 2 | **Soft-delete only** in MVP; hard delete not exposed. |
| 3 | **Editable** — notes are working memory, not a legal-style record. |
| 4 | **Separate from warnings** — no automatic promotion of notes into warnings. |
| 5 | **Access via guild staff roles** ([§4](staff-roles.md#4-guild-staff-roles-admin-gate)) — no `staff_note_access_roles` table. |
| 6 | **Per-guild sequential `note_number`** for human-friendly refs (`N-12`). |

**Still open (non-blocking):**

- Whether `/note list` without a user lists recent guild-wide notes (recommend **yes**, capped, staff-only).  
- Max content length (recommend **2000** chars).
