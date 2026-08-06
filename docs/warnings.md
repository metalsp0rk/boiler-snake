# Warning System

Formal, **permanent** disciplinary records for guild members. Complements [Staff Notes](staff-notes.md): notes are private working memory; warnings are countable, auditable strikes that staff and (optionally) the member can see.

## How it works

```
Staff issues /warn add @user reason
        → requireStaff (Manage Server or guild staff role)
        → allocate sequential warning_number (W-n)
        → persist row (active; never hard-deleted by bot commands)
        → optional DM to member (guild setting; default ON)
        → optional embed to audit log channel
        → ephemeral confirm to staff with active count

Staff voids /warn void id reason
        → set voided_at / voided_by / void_reason
        → row remains queryable forever as voided

Staff / member lists history
        → active by default; full history includes voided
```

| Rule | Detail |
|------|--------|
| Permanence | No hard-delete command. **Void** only, with reason and actor |
| Reason | Required on issue and on void; **immutable** after issue |
| Scope | Per guild + user |
| Active count | Non-voided rows for that guild/user |
| Self-service | Members may view **their own** warnings (`/warn mine`) |
| Staff access | [Staff gate](https://github.com/metalsp0rk/boiler-snake/blob/main/ROADMAP.md#4-guild-staff-roles-admin-gate) (`requireStaff`) |
| Escalation | Auto kick/ban thresholds = not in MVP |

## Notes vs warnings

| | Staff notes | Warnings |
|--|-------------|----------|
| Intent | Informal context | Formal disciplinary action |
| Member visibility | Never | Active list via `/warn mine`; optional DM on issue |
| Mutability | Edit + soft-delete | No edit of reason; **void** only |
| Counting | Not counted | Active count for history / future auto-mod |
| Human id | `N-{n}` | `W-{n}` |

Use **notes** for soft context and **warnings** when the action is on the record.

## Commands

### Staff ops (`requireStaff`)

All replies are **ephemeral**. Staff logs go to the configured audit channel when set.

| Command | Description |
|---------|-------------|
| `/warn add user:<member> reason:<text> [silent] [note]` | Issue a warning. `silent` skips member DM for this issue only. `note` links a staff note number (N-n). |
| `/warn list user:<member> [page] [include_voided]` | History for a member (default active only) |
| `/warn info id:<warning_number>` | Full detail: reason, issuer, timestamps, void metadata |
| `/warn void id:<…> reason:<text>` | Void a warning (permanent row; marks inactive) |
| `/warn count user:<member>` | Active warning count (+ recent snippet) |
| `/warn settings` | DM flag, log target, access info |

### Config (Manage Server only)

| Command | Description |
|---------|-------------|
| `/setwarn dm enabled:<true\|false>` | Toggle member DMs on issue/void (default **true**) |
| `/setwarn log channel:<#channel>` | Dedicated staff channel for issue/void embeds |
| `/setwarn log clear:true` | Clear dedicated warn log (fall back to audit log) |

### Everyone

| Command | Description |
|---------|-------------|
| `/warn mine [include_voided]` | View your own warnings in this guild (ephemeral) |

### Warning IDs

Each guild has a sequential **warning number** (refs like **W-12**). Use that number as the `id` option on void / info—not the internal SQLite row id. IDs stay stable after void.

**Reason length:** non-empty trimmed text; max **1000** characters. Longer narratives belong in a linked staff note.

## Member DMs

When a warning is issued and guild DMs are on (and `silent` is not set):

- Embed title: `Warning issued in {guild name}`
- Fields: `W-n`, reason, issuer display name, active count, timestamp
- Footer: how to view history (`/warn mine`)

On void (if DMs on): short notice that `W-n` was voided, by whom, and void reason.

| Control | Effect |
|---------|--------|
| `/setwarn dm enabled:false` | No DMs for the guild |
| `/warn add … silent:true` | Skip DM for that issue only |

**DM failure never rolls back** the warning. Staff still get the ephemeral confirm.

## Staff log (issue / void)

Issue and void post a staff embed (warning ref, subject, active count, short reason snippet) to:

1. **Dedicated warning log** when set via `/setwarn log channel:#…` (`guild_settings.warn_log_channel_id`)
2. Otherwise the **general audit log** (`/setlog audit` → `audit_log_channel_id`)
3. If neither is set, no channel embed is posted (commands still work)

Config changes (`/setwarn dm`, `/setwarn log`) always use the general audit log stream when configured.

```bash
/setwarn log channel:#warn-log
/setwarn log clear:true
```

## Access

| Who | Access |
|-----|--------|
| Manage Server | Full staff ops + `/setwarn` |
| Guild staff roles (`/staff role list`) | Staff ops (`/warn add|list|…`) |
| Any member | `/warn mine` only |

There is **no** warnings-specific role table. Access shares the guild [staff role](https://github.com/metalsp0rk/boiler-snake/blob/main/ROADMAP.md#4-guild-staff-roles-admin-gate) list.

## Database

```sql
-- guild_settings.warn_dm_members INTEGER NOT NULL DEFAULT 1
-- guild_settings.warn_log_channel_id TEXT  -- NULL → fall back to audit_log_channel_id

CREATE TABLE warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  warning_number INTEGER NOT NULL,   -- sequential per guild (W-12)
  user_id TEXT NOT NULL,            -- subject
  issuer_id TEXT NOT NULL,          -- staff who issued
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  voided_at INTEGER,
  voided_by TEXT,
  void_reason TEXT,
  related_note_id INTEGER REFERENCES staff_notes(id) ON DELETE SET NULL,
  UNIQUE (guild_id, warning_number)
);
```

See [Database Schema](database.md) for indexes and migration id `009_warnings`.

## Design decisions

1. **Permanent record** — never hard-delete via bot commands; void only with reason and actor.
2. **Reason immutable** after issue — void + re-issue, not silent edit.
3. **Complement to staff notes** — informal context in notes; formal strikes in warnings.
4. **DM members by default**; guild toggle + per-issue `silent`.
5. **Member self-view** via `/warn mine` (no staff role required).
6. **Access via guild staff roles** — no `warn_access_roles` table.
7. **`/setwarn dm`:** Manage Server only (meta config).
8. **Human ids** sequential per guild (`W-n`); stable forever including after void.
9. **No auto-mod escalation** in MVP.
10. **Audit stream:** reuse `audit_log_channel_id` when set.

## Related

- [Staff Notes](staff-notes.md)
- `/userinfo` — staff card with note/warning counts and drill-down buttons
- [ROADMAP — Warning System](https://github.com/metalsp0rk/boiler-snake/blob/main/ROADMAP.md#6-warning-system)
- [ROADMAP — Guild staff roles](https://github.com/metalsp0rk/boiler-snake/blob/main/ROADMAP.md#4-guild-staff-roles-admin-gate)
- [Audit Log](audit-log.md)
- [Commands reference](commands/index.md)
