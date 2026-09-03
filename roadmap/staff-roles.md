# 4. Guild Staff Roles (Admin Gate)

### Purpose

One guild-scoped **multi-role allow-list** that powers the bot’s **admin/staff gate** for every feature that today checks `ManageGuild` (config, honeypot ops, logs, YouTube, tickets, notes, warnings, …).

Built by **generalizing the existing honeypot exempt-role store** (`honeypot_exempt_roles`) — same shape, same “these roles are trusted staff” meaning, expanded purpose. No parallel per-feature staff lists.

### Status

**Shipped** — implemented in `src/features/staffRoles/` with migration `008_staff_roles` and `isStaff` / `requireStaff` in `src/core/permissions.js`. Design decisions in [4.8](#48-design-decisions-locked) remain the product contract.

---

### 4.1 Existing data structure (reuse)

Shipped today for honeypot exemption:

```sql
-- src/db/migrations/001_base_schema.js (current name)
CREATE TABLE IF NOT EXISTS honeypot_exempt_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
```

API already in `src/db/repositories/honeypot.js`:

| Function | Behavior |
|----------|----------|
| `addHoneypotExemptRole(guildId, roleId)` | `INSERT OR IGNORE` |
| `removeHoneypotExemptRole` | Delete row |
| `listHoneypotExemptRoles` | Ordered by `created_at` |
| `memberHasHoneypotExemptRole(guildId, memberRoleIds)` | True if **any** member role is listed |

**MVP migration:** rename table → `staff_roles` (data preserved). Keep thin honeypot wrappers or re-export under staff names so honeypot exemption **is** “member has a staff role” — one source of truth.

Optional columns later (not required for rename): `added_by TEXT` — skip for MVP to avoid rewriting every row; `created_at` already records when the role was trusted.

---

### 4.2 Permission model (admin gate)

Replace the narrow check in `src/core/permissions.js`:

```
// Today
isAdminOrMod(interaction) ⇔ member has ManageGuild

// Target
isStaff(interaction) ⇔
    member has ManageGuild
    OR member holds any role in staff_roles for this guild
```

| Helper | Use |
|--------|-----|
| `isStaff(interaction \| member, guildId)` | Gate for staff/config commands (successor to `isAdminOrMod`) |
| `requireStaff(interaction)` | Ephemeral deny if not staff (successor to `requireAdmin`) |
| `listStaffRoles(guildId)` / `addStaffRole` / `removeStaffRole` | CRUD on `staff_roles` |
| `memberHasStaffRole(guildId, roleIds)` | Pure DB check (honeypot + tickets) |

**Who may edit the staff role list:** **`ManageGuild` only** (true Discord admins). Staff-role holders get feature access but **cannot** grant or revoke staff roles (no privilege escalation).

**Empty `staff_roles`:** only ManageGuild passes the gate — same practical default as today for command access. Honeypot still has **no** automatic ManageGuild exemption (unchanged product rule): only listed roles skip honeypot bans; admins without a listed role can still be banned if they trip a honeypot. Document clearly.

**Two related but distinct rules:**

| Context | Rule |
|---------|------|
| **Slash / bot admin gate** | ManageGuild **or** staff role |
| **Honeypot ban exemption** | Staff role only (not bare ManageGuild) — preserves current honeypot safety |

---

### 4.3 Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/staff role add role:<role>` | ManageGuild | Trust this role as staff (insert into `staff_roles`) |
| `/staff role remove role:<role>` | ManageGuild | Remove from staff list |
| `/staff role list` | Staff gate | List trusted staff roles |
| `/staff settings` | Staff gate | Show staff roles + short “used by: admin gate, honeypot exempt, tickets, …” |

**Honeypot UX compatibility:**

| Approach | Detail |
|----------|--------|
| **Preferred** | `/honeypot exempt add\|list\|del` become **aliases** of staff role CRUD (same table). Help text: “Guild staff roles — also used for honeypot exemption.” |
| **Or** | Deprecate exempt subcommands after `/staff` ships; migrate docs only. |

Do **not** keep two tables.

---

### 4.4 Discord slash visibility

Today many commands set `setDefaultMemberPermissions(ManageGuild)`, which **hides** them from non-admins in the Discord UI even if the bot would allow staff roles in code.

**MVP approach (pick one; recommend A):**

| Option | Behavior |
|--------|----------|
| **A (recommended)** | Clear or lower `defaultMemberPermissions` on staff-gated commands; **always** enforce `requireStaff` in handlers. Server Integration overrides remain available. |
| **B** | Keep Discord-level ManageGuild default; document that guild owners must grant command access to staff roles under **Server Settings → Integrations → Boiler Snake**. |

Option A matches “staff roles are first-class admin gate.” Public commands (`/xp`, `/leaderboard`, `/warn mine`) stay unrestricted.

---

### 4.5 What uses the gate

| Area | How staff roles apply |
|------|------------------------|
| **Core permissions** | `isStaff` / `requireStaff` for all current `isAdminOrMod` call sites |
| **Honeypot** | Exempt list **is** `staff_roles` (rename + same semantics) |
| **Tickets** | Command gate + **channel overwrites** for every staff role on open tickets |
| **Staff notes** | Ops gate via `requireStaff` — no note-specific role table |
| **Warnings** | Staff ops via `requireStaff` — no warn-specific role table |
| **Settings, logs, YouTube, Twitch, reaction roles, decay config, …** | Same staff gate as today but staff-role aware |
| **Event reminders** | Keep **ManageGuild or event creator** for create/edit (creator exception stays); guild default channel may stay ManageGuild-only **or** staff — prefer **staff gate** for consistency unless product wants stricter |

**Not gated by staff roles:** public XP/leaderboard; member `/warn mine`; ticket self-create; eventreminder opt-out/in.

---

### 4.6 Module layout

| Path | Responsibility |
|------|----------------|
| `src/db/repositories/staffRoles.js` | CRUD + `memberHasStaffRole` (migrated from honeypot exempt helpers) |
| `src/core/permissions.js` | `isStaff`, `requireStaff`; deprecate/alias `isAdminOrMod` → `isStaff` |
| `src/features/staff/` (or `staffRoles/`) | `/staff` slash commands |
| Honeypot feature | Exempt commands → staff repo; ban path uses `memberHasStaffRole` |

**Migration sketch:**

```sql
ALTER TABLE honeypot_exempt_roles RENAME TO staff_roles;
-- SQLite supports RENAME TABLE; app code switches queries.
```

Repository facade exports both names temporarily if needed:

- `addStaffRole` / `listStaffRoles` / `memberHasStaffRole` (canonical)
- `addHoneypotExemptRole` = alias of `addStaffRole` during transition

---

### 4.7 Implementation order

1. Migration rename `honeypot_exempt_roles` → `staff_roles`; move repo to `staffRoles.js`; honeypot imports staff helpers  
2. Upgrade `permissions.js` (`isStaff` / `requireStaff`); swap call sites  
3. `/staff role add|remove|list` + `/staff settings`  
4. Alias or rewire `/honeypot exempt *` to the same store; update honeypot docs  
5. Adjust `defaultMemberPermissions` strategy (prefer option A)  
6. Tests: ManageGuild passes; staff role passes; neither fails; honeypot exempt still works after rename; empty list = ManageGuild-only for gate  

---

### 4.8 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Single table:** generalize `honeypot_exempt_roles` → `staff_roles`; no per-feature access-role tables. |
| 2 | **Admin gate:** ManageGuild **or** any staff role for staff/config commands. |
| 3 | **Only ManageGuild** may add/remove staff roles. |
| 4 | **Honeypot exemption** = staff role membership only (not bare ManageGuild) — keep current honeypot safety. |
| 5 | **Tickets / notes / warnings** consume this module; they do not define their own staff role lists. |
| 6 | **Empty list:** command gate = ManageGuild only; honeypot bans anyone without a listed role. |
| 7 | **Modular:** one permissions + repository module; features call `requireStaff` / `listStaffRoles` only. |

**Still open (non-blocking):**

- Keep `/honeypot exempt` as permanent alias vs deprecate after one release.  
- Whether event-reminder **guild** defaults require staff gate vs ManageGuild-only.  
- Optional future **capabilities** (e.g. role may warn but not edit honeypot) — **out of MVP**; all staff roles are full admin-gate equivalents.
