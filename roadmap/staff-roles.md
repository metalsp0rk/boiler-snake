# 4. Guild Staff Roles (Admin Gate)

### Purpose

One guild-scoped **multi-role allow-list** that powers the bot’s **admin/staff gate** for every feature that originally checked `ManageGuild` (config, honeypot ops, logs, YouTube, tickets, notes, warnings, …).

Built by **generalizing the original honeypot exempt-role store** (`honeypot_exempt_roles`) — same shape, same “these roles are trusted staff” meaning, expanded purpose. No parallel per-feature staff lists.

### Status

**Shipped** — implemented in `src/features/staffRoles/` with migration `008_staff_roles` and `isStaff` / `requireStaff` in `src/core/permissions.js`. Post-MVP additions, all shipped since: **junior | senior levels** (migration `011` + `/staff role setlevel`), **OAuth slash-visibility sync** (`/staff syncpermissions`, migration `016`, `src/features/commandPermissions/`), **`added_by` provenance** (migration `024`), and **audit embeds** on every staff-role mutation. Design decisions in [4.8](#48-design-decisions-locked) remain the product contract.

---

### 4.1 Existing data structure (reuse)

Original draft state (pre-MVP; `honeypot_exempt_roles` no longer exists):

```sql
-- src/db/migrations/001_base_schema.js (at draft time)
CREATE TABLE IF NOT EXISTS honeypot_exempt_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
```

API was in `src/db/repositories/honeypot.js` at draft time. *(Shipped: the honeypot exempt helpers no longer exist as a separate store — `src/features/honeypot/index.js` imports `addStaffRole` / `removeStaffRole` / `listStaffRoles` / `memberHasStaffRole` straight from the staff repository. The "thin honeypot wrappers / re-export under staff names" option resolved to **direct staff-name imports only**.)*

**MVP migration:** rename table → `staff_roles` (data preserved). *(Shipped as migration `008_staff_roles.js` — not a literal `ALTER TABLE … RENAME`: it folds legacy rows with `INSERT OR IGNORE … SELECT` and `DROP`s the legacy table, idempotent across re-runs; fresh DBs get `staff_roles` created directly in `001_base_schema.js`.)*

~~Optional columns later (not required for rename): `added_by TEXT` — skip for MVP to avoid rewriting every row~~ — **Shipped later** (migration `024_staff_roles_added_by.js`): `added_by TEXT` nullable; rows trusted before the migration stay `NULL` ("unknown provenance") instead of back-filled; `/staff role add` refreshes it via the repository upsert (COALESCE keeps existing provenance on actor-less re-adds).

**Shipped schema** (`staff_roles` = `001` base + `011` level + `024` added_by):

```sql
CREATE TABLE staff_roles (
  guild_id   TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  level      TEXT NOT NULL DEFAULT 'senior',  -- 011: 'junior' | 'senior'; existing rows became senior
  added_by   TEXT,                            -- 024: actor user id; NULL = pre-migration / unknown
  PRIMARY KEY (guild_id, role_id)
);
```

**`level` (migration `011_staff_role_levels.js`, shipped):**

| Level | Grants |
|-------|--------|
| **junior** | Staff gate (`requireStaff`) + honeypot exempt — **no** automatic ticket channel view |
| **senior** | Junior + **ticket channel overwrites** (and `/userinfo` Activity, see [4.5](#45-what-uses-the-gate)) |

Current API in `src/db/repositories/staffRoles.js` (shipped):

| Function | Behavior |
|----------|----------|
| `addStaffRole(guildId, roleId, level, addedBy)` | Upsert; sets `level`, refreshes `added_by` when an actor is present (COALESCE otherwise) |
| `setStaffRoleLevel(guildId, roleId, level)` | junior ↔ senior flip |
| `removeStaffRole` / `listStaffRoles` | Delete / list (senior first, then `created_at`; optional `{ level }` filter) |
| `getStaffRole` | Single row (existence + prior level for audits) |
| `listSeniorStaffRoles(guildId)` | The rows that receive ticket channel overwrites |
| `memberHasStaffRole(guildId, roleIds)` | Any configured level (gate + honeypot) |
| `memberHasSeniorStaffRole(guildId, roleIds)` | Senior rows only (ticket-visibility checks, `/userinfo` Activity) |
| `normalizeStaffLevel` / `STAFF_LEVELS` | Value coercion; **only** `junior` / `senior` exist |

---

### 4.2 Permission model (admin gate)

The draft's `isAdminOrMod` → `isStaff` replacement shipped, with a second tier added later (migration `011`):

```
isStaff(interaction)        ⇔ member has ManageGuild OR any role in staff_roles (either level)
isSeniorStaff(interaction)  ⇔ member has ManageGuild OR a role in staff_roles at level 'senior'
```

| Helper (`src/core/permissions.js`) | Use |
|--------|-----|
| `isStaff(interaction)` / `requireStaff(interaction)` | Gate for staff/config commands |
| `isSeniorStaff(interaction)` / `requireSeniorStaff(interaction)` | Sensitive surfaces: ticket-visibility context, `/userinfo` Activity (deny message points at `/staff role setlevel`) |
| `isAdminOrMod(interaction)` | **Kept** as the primitive for genuinely admin-only surfaces — staff-role mutations, `/grantxp`, `/setcommandchannel`, `/honeypot exempt *`, `/staff syncpermissions` (`isStaff` builds on it) |
| `listStaffRoles` / `addStaffRole` / `removeStaffRole` / `setStaffRoleLevel` / `getStaffRole` | CRUD on `staff_roles` |
| `memberHasStaffRole` / `memberHasSeniorStaffRole` (guildId + roleIds) | Pure DB checks (honeypot, tickets, userinfo) |

**Who may edit the staff role list:** **`ManageGuild` only** (true Discord admins). Staff-role holders get feature access but **cannot** grant, revoke, or re-level staff roles (no privilege escalation). *(Shipped and verified: add / remove / setlevel / syncpermissions all check `isAdminOrMod`. `/staff role add` also rejects **@everyone** as a staff role.)*

**Empty `staff_roles`:** only ManageGuild passes the gate — same practical default as today for command access. Honeypot still has **no** automatic ManageGuild exemption (unchanged product rule): only listed roles skip honeypot bans; admins without a listed role can still be banned if they trip a honeypot. Document clearly.

**Three related but distinct rules** (third row added with `011`, shipped):

| Context | Rule |
|---------|------|
| **Slash / bot admin gate** | ManageGuild **or** any staff role (junior or senior) |
| **Honeypot ban exemption** | Staff role only (either level; not bare ManageGuild) — preserves current honeypot safety |
| **Ticket channel overwrites + `/userinfo` Activity** | ManageGuild **or** a **senior** staff role — junior never gets automatic ticket visibility |

---

### 4.3 Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/staff role add role:<role> level:<junior\|senior>` | ManageGuild | Trust this role as staff (upsert into `staff_roles`). **`level` is required** *(shipped — the draft predated levels; re-adding an existing role updates its level and refreshes `added_by`)* |
| `/staff role remove role:<role>` | ManageGuild | Remove from staff list |
| `/staff role setlevel role:<role> level:<junior\|senior>` | ManageGuild | Flip an existing staff role between levels *(shipped post-MVP with `011`; refuses on non-staff roles and no-op levels; ticket overwrites refresh on the next lifecycle apply)* |
| `/staff role list` | Staff gate | List trusted staff roles **grouped senior/junior**, each annotated `added by <@user>` when `added_by` is known |
| `/staff settings` | Staff gate | Show role counts by level, what the list controls (gate, honeypot, senior ticket overwrites, notes, warnings), and command-visibility sync status |
| `/staff syncpermissions [force_reauth]` | ManageGuild | OAuth flow so staff roles can **see** staff slash commands in the picker — see [4.4](#44-discord-slash-visibility) |

Every mutation writes an **audit embed** via `logConfigChange` (shipped — the §8 TODO landed): "Staff role added" / "Staff role level updated" (re-add) / "Staff role level changed" (`setlevel`) / "Staff role removed", with role id, actor, and old→new level. `/staff` is `setDefaultMemberPermissions(ManageGuild)` at registration.

**Honeypot UX compatibility:**

| Approach | Detail |
|----------|--------|
| **Preferred — shipped** | `/honeypot exempt add\|list\|del` are **aliases** over the same `staff_roles` table (`add` stores level **senior** with no `added_by` actor; `list` prints staff roles). The exempt group is ManageGuild-gated in the handler because it mutates `staff_roles`. Help text: "Guild staff roles — also used for honeypot exemption." |
| ~~**Or**~~ | ~~Deprecate exempt subcommands after `/staff` ships~~ — **not taken**; the alias is kept as a permanent surface (deprecation would be a separate future product call). |

Do **not** keep two tables. *(Honored: one table, both command surfaces.)*

---

### 4.4 Discord slash visibility

Today many commands set `setDefaultMemberPermissions(ManageGuild)`, which **hides** them from non-admins in the Discord UI even if the bot would allow staff roles in code.

Draft options A/B **superseded — shipped as a third approach** (OAuth command-permission sync):

1. Staff-tier commands **keep** the `defaultMemberPermissions = ManageGuild` picker default at registration (option A's "clear or lower" was not taken).
2. An admin runs `/staff syncpermissions` → **OAuth2 authorize link** (`applications.commands.permissions.update` Bearer flow) → on callback the bot PUTs per-guild **command permission overwrites** allowing **each configured staff role** on the staff-tier commands (`src/features/commandPermissions/sync.js` + `permissionsPayload.js`; Discord caps a command at 100 role overwrites).
3. `src/core/commandVisibility.js` is the single tier map — every top-level command is `public` | `staff` | `admin`; it drives both the registration defaults and the sync target list (`test/command-visibility.test.js` fails if a registered command lacks a tier). Staff-tier names get role overwrites; **`admin` tier (`/staff`, `/grantxp`, `/setcommandchannel`) never does** — `/staff` stays invisible in the picker to staff-role holders without ManageGuild even though its list/settings handlers would pass them.
4. Tokens + sync state persist in `guild_command_permission_oauth` (migration `016_command_permission_oauth.js`: refresh/access tokens, `authorized_by_user_id`, `last_sync_at`, `last_sync_error`).
5. **Auto-resync:** after a role add/remove/setlevel, an already-authorized guild re-syncs in the background (`maybeAutoSyncCommandPermissions`; fire-and-forget, logged, never breaks the command reply). Levels don't change command overwrites — **all** staff roles receive picker allows; the junior/senior split is ticket-visibility only.
6. Requirements: `CLIENT_ID` + `CLIENT_SECRET` + public HTTP (`PUBLIC_HTTP_PORT`/`TICKET_HTTP_PORT` + `PUBLIC_BASE_URL`/`TICKET_PUBLIC_BASE_URL` or `OAUTH_REDIRECT_URI`) + the redirect URI registered in the Developer Portal (`<public base>/oauth/command-permissions/callback`, served by the tickets HTTP server). Without config, `/staff syncpermissions` replies with the exact missing env list.

**Handlers remain the security source of truth** — picker visibility is convenience, never the gate. Public commands (`/xp`, `/leaderboard`, `/warn`, `/ticket`, `/eventreminder`, `/play`, `/music`) stay unrestricted in the tier map. Option B (manual Server Settings → Integrations grants) is no longer needed but still works as a manual fallback.

---

### 4.5 What uses the gate

| Area | How staff roles apply |
|------|------------------------|
| **Core permissions** | `isStaff` / `requireStaff` for all staff/config call sites; `requireSeniorStaff` where senior-only |
| **Honeypot** | Exempt list **is** `staff_roles` (any level); the ban path is pure `memberHasStaffRole` — no bare ManageGuild exemption |
| **Tickets** | Command gate for any level; **channel overwrites go to senior roles only** — `getManageableStaffRoleIds()` reads `listSeniorStaffRoles()` (`src/features/tickets/overwrites.js`); `/ticket settings` lists which roles are senior vs junior |
| **Userinfo** | Card + notes/warnings tabs: staff gate; **Activity tabs: senior only** (`requireSeniorStaff`, denial suggests `/staff role setlevel`) |
| **Staff notes** | Ops gate via `requireStaff` — no note-specific role table |
| **Warnings** | Staff ops via `requireStaff` — no warn-specific role table |
| **Settings, logs, YouTube, Twitch, reaction roles, decay config, gork, …** | Same staff gate as before but staff-role aware (staff-tier in the picker map) |
| **Event reminders** | Create/edit keeps **ManageGuild or event creator** (creator exception stays); guild default channel `/eventreminder setchannel` uses the **staff gate** *(shipped — the draft's "prefer staff gate" was taken; resolved, see [4.8](#48-design-decisions-locked))* |

**Not gated by staff roles:** public XP/leaderboard; member `/warn mine`; ticket self-create; eventreminder opt-out/in.

---

### 4.6 Module layout

| Path | Responsibility |
|------|----------------|
| `src/db/repositories/staffRoles.js` | CRUD + levels + `added_by` + `memberHasStaffRole` / `memberHasSeniorStaffRole` / `listSeniorStaffRoles` (replaces the honeypot exempt helpers) |
| `src/core/permissions.js` | `isStaff`, `requireStaff`, `isSeniorStaff`, `requireSeniorStaff`; `isAdminOrMod` / `requireAdmin` kept for admin-only surfaces |
| `src/features/staffRoles/` | `/staff role add\|remove\|setlevel\|list`, `/staff settings`, `/staff syncpermissions` *(draft's "`src/features/staff/` (or `staffRoles/`)" resolved to `staffRoles/`)* |
| `src/core/commandVisibility.js` + `src/features/commandPermissions/` | Picker tier map + OAuth visibility sync ([4.4](#44-discord-slash-visibility)) |
| Honeypot feature | `/honeypot exempt *` aliases import the staff repo directly; ban path uses `memberHasStaffRole` |

**Migration history (shipped):**

```sql
-- 001_base_schema.js: fresh DBs CREATE staff_roles directly
-- 008_staff_roles.js (idempotent):
INSERT OR IGNORE INTO staff_roles (guild_id, role_id, created_at)
  SELECT guild_id, role_id, created_at FROM honeypot_exempt_roles;
DROP TABLE honeypot_exempt_roles;
-- 011_staff_role_levels.js:  + level TEXT NOT NULL DEFAULT 'senior'
-- 024_staff_roles_added_by.js: + added_by TEXT
```

*(The draft's `ALTER TABLE … RENAME` sketch was implemented as fold+drop for legacy-DB idempotency; older `001` used to recreate an empty legacy table on every boot, which `008` also cleans up.)*

~~Repository facade exports both names temporarily if needed~~ — **not needed**: only the canonical staff names ship (`addStaffRole` / `listStaffRoles` / `memberHasStaffRole` / …); no `addHoneypotExemptRole` alias exists in the repository.

---

### 4.7 Implementation order (all shipped)

1. ~~Migration rename `honeypot_exempt_roles` → `staff_roles`; move repo to `staffRoles.js`; honeypot imports staff helpers~~ *(shipped — `008` + `repositories/staffRoles.js`; honeypot imports staff names)*
2. ~~Upgrade `permissions.js` (`isStaff` / `requireStaff`); swap call sites~~ *(shipped — later extended with `isSeniorStaff` / `requireSeniorStaff`)*
3. ~~/`staff role add|remove|list` + `/staff settings`~~ *(shipped — later `add` gained a required `level`, and `setlevel` was added)*
4. ~~Alias or rewire `/honeypot exempt *` to the same store; update honeypot docs~~ *(shipped as aliases)*
5. ~~Adjust `defaultMemberPermissions` strategy (prefer option A)~~ *(superseded — shipped the OAuth sync approach in [4.4](#44-discord-slash-visibility), keeping ManageGuild picker defaults + role overwrites)*
6. ~~Tests~~ *(shipped — `test/staff-roles.test.js`, `test/permissions.test.js`, `test/command-visibility.test.js`, `test/command-permissions-oauth.test.js`, `test/command-permission-sync.test.js` + ticket/userinfo senior-gate coverage)*
7. *(Post-MVP, shipped: junior/senior tiers + `setlevel` (`011`), OAuth visibility sync (`016`), `added_by` provenance (`024`), audit embeds on all role mutations.)*

---

### 4.8 Design decisions (locked)

| # | Decision |
|---|----------|
| 1 | **Single table:** generalize `honeypot_exempt_roles` → `staff_roles`; no per-feature access-role tables. |
| 2 | **Admin gate:** ManageGuild **or** any staff role for staff/config commands. **Extended (shipped):** a **senior** sub-tier (`011`) additionally gates ticket channel overwrites and `/userinfo` Activity — one list, two levels, not two lists. |
| 3 | **Only ManageGuild** may add/remove/setlevel staff roles. *(Shipped and verified in handlers.)* |
| 4 | **Honeypot exemption** = staff role membership only (not bare ManageGuild) — keep current honeypot safety. |
| 5 | **Tickets / notes / warnings** consume this module; they do not define their own staff role lists. |
| 6 | **Empty list:** command gate = ManageGuild only; honeypot bans anyone without a listed role. |
| 7 | **Modular:** one permissions + repository module; features call `requireStaff` / `requireSeniorStaff` / `listStaffRoles` only; `commandVisibility.js` centralizes picker tiers so sync and registration can't drift. |

**Still open (non-blocking):**

- Fine-grained **capability flags beyond the junior/senior tiers** (e.g. role may warn but not edit honeypot) — the two-level tier (`STAFF_LEVELS = junior | senior`) is shipped and is the only granularity today; anything finer remains out of scope.

*(Previously open, resolved by shipping: `/honeypot exempt` kept as a permanent alias over `staff_roles`; event-reminder guild default channel moved to the **staff gate**; audit embeds on role changes landed.)*
