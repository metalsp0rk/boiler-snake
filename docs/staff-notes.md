# Staff Notes

Private, staff-only notes about guild members. Informal institutional memory for moderators—context that is **not** a formal disciplinary action and is **never** shown to the member.

Paired with the [Warning System](warnings.md): notes hold soft context; warnings are the permanent formal record.

## How it works

```
Staff adds a note on a user
        → requireStaff (Manage Server or guild staff role)
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

All subcommands require the **staff gate** (`Manage Server` or a role from `/staff role list`). Replies are always **ephemeral**.

| Command | Description |
|---------|-------------|
| `/note add user:<member> [content:<text>]` | Create a staff note (max 2000 characters). **Omit `content`** to open a modal for longer text. |
| `/note list [user] [page] [include_deleted]` | List notes for a member (newest first), or recent guild-wide notes if `user` is omitted |
| `/note edit id:<note_number> [content:<text>]` | Replace note body; records `edited_at` / `edited_by`. **Omit `content`** to open a prefilled modal. |
| `/note delete id:<note_number>` | Soft-delete (`deleted_at`); row kept for audit |
| `/note info id:<note_number>` | Full note detail (author, timestamps, body) |
| `/note settings` | Counts + access info |

### Content modal

Discord slash string options are awkward for multi-paragraph notes. Prefer:

```bash
/note add user:@SomeUser
# → modal: write the full body (up to 2000 chars)
/note edit id:12
# → modal prefilled with the current body
```

You can still pass `content:` inline for short notes.

### From ticket close

When staff runs `/ticket close`:

- Optional `staff_note:` string creates a private note on the **ticket requester** immediately (includes ticket # and close reason).
- The ephemeral close reply always includes an **Add staff note** button → modal for free-form context.

Notes created this way are normal staff notes (`N-n`); they are never shown to the member.

### Note IDs

Each guild has a sequential **note number** (human-friendly refs like **N-12**). Use that number as the `id` option on edit / delete / info—not the internal SQLite row id.

### List behavior

- **With `user`:** paginated (10 per page), newest first. Soft-deleted notes are hidden unless `include_deleted:true`.
- **Without `user`:** recent guild-wide feed (capped), staff-only.

## Access

| Who | Access |
|-----|--------|
| Manage Server | Full note CRUD |
| Guild [staff roles](staff-roles.md) | Same gate via `/staff role list` |
| Subject member | **None** — notes are never shown to them |

There is **no** notes-specific role table. Access shares the guild [staff role](staff-roles.md) list (`/staff role list`).

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
2. **Soft-delete only** — no hard delete command.
3. **Editable** — working memory, not a legal-style record.
4. **Separate from warnings** — no automatic promotion of notes into warnings.
5. **Access via staff gate** — no `staff_note_access_roles` table.
6. **Per-guild sequential `note_number`** for human-friendly refs.
7. **Modal for long content** — omit slash `content` on add/edit.
8. **Ticket close integration** — optional `staff_note` + **Add staff note** button.

## Related

- [Warning System](warnings.md)
- [Staff roles](staff-roles.md) — junior vs senior; who passes the staff gate
- `/userinfo` — staff card with note/warning counts and drill-down buttons
- [ROADMAP — Staff Notes](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/staff-notes.md#5-staff-notes-system)
- [Audit Log](audit-log.md)
- [Commands reference](commands/index.md)
