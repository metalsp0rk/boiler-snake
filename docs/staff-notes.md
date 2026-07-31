# Staff Notes

Private, staff-only notes about guild members. Informal institutional memory for moderators—context that is **not** a formal disciplinary action and is **never** shown to the member.

Paired with the planned [Warning System](../ROADMAP.md#6-warning-system): notes hold soft context; warnings will be the permanent formal record.

## How it works

```
Staff adds a note on a user
        → requireStaff (Manage Server today; staff roles when they ship)
        → store in SQLite (guild-scoped)
        → staff can list / edit / soft-delete notes for that user
        → member never sees notes via bot commands or DMs
        → optional audit-log embed on create / edit / delete
```

| Rule | Detail |
|------|--------|
| Audience | Staff gate only |
| Visibility | Never DMed; never exposed on member-facing commands |
| Mutability | Editable and soft-deletable |
| Scope | Per guild + user |
| Purpose | Context, history, “watch for X”—not a strike count |

## Commands

All subcommands require the **staff gate** (`Manage Server` / `ManageGuild` today). Replies are always **ephemeral**.

| Command | Description |
|---------|-------------|
| `/note add user:<member> content:<text>` | Create a staff note (max 2000 characters) |
| `/note list [user] [page] [include_deleted]` | List notes for a member (newest first), or recent guild-wide notes if `user` is omitted |
| `/note edit id:<note_number> content:<text>` | Replace note body; records `edited_at` / `edited_by` |
| `/note delete id:<note_number>` | Soft-delete (`deleted_at`); row kept for audit |
| `/note info id:<note_number>` | Full note detail (author, timestamps, body) |
| `/note settings` | Counts + access info |

### Note IDs

Each guild has a sequential **note number** (human-friendly refs like **N-12**). Use that number as the `id` option on edit / delete / info—not the internal SQLite row id.

### List behavior

- **With `user`:** paginated (10 per page), newest first. Soft-deleted notes are hidden unless `include_deleted:true`.
- **Without `user`:** recent guild-wide feed (capped), staff-only.

## Access

| Who | Access |
|-----|--------|
| Manage Server | Full note CRUD |
| Guild staff roles (planned) | Same gate once [ROADMAP §4](../ROADMAP.md#4-guild-staff-roles-admin-gate) ships |
| Subject member | **None** — notes are never shown to them |

There is **no** notes-specific role table. Access will share the guild staff-role list when that feature lands (`/staff role list`). Until then, only Manage Server holders can use `/note`.

## Audit log

When an audit log channel is configured (`/setlog`), create / edit / soft-delete emit a config-style embed with note ref, subject, and a short content snippet. The full note body is only visible via `/note` commands (ephemeral).

## Database

```sql
CREATE TABLE staff_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  note_number INTEGER NOT NULL,   -- sequential per guild (N-12)
  user_id TEXT NOT NULL,         -- subject
  author_id TEXT NOT NULL,       -- staff who created
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  edited_by TEXT,
  deleted_at INTEGER,            -- soft delete; null = active
  deleted_by TEXT,
  UNIQUE (guild_id, note_number)
);
```

See [Database Schema](database.md) for indexes and migration id `007_staff_notes`.

## Design decisions

1. **Staff-only** — notes never DMed or shown to the subject.
2. **Soft-delete only** in MVP — no hard delete command.
3. **Editable** — working memory, not a legal-style record.
4. **Separate from warnings** — no automatic promotion of notes into warnings.
5. **Access via staff gate** — no `staff_note_access_roles` table.
6. **Per-guild sequential `note_number`** for human-friendly refs.

## Related

- [ROADMAP — Staff Notes](../ROADMAP.md#5-staff-notes-system)
- [ROADMAP — Guild staff roles](../ROADMAP.md#4-guild-staff-roles-admin-gate)
- [Audit Log](audit-log.md)
- [Commands reference](commands/index.md)
