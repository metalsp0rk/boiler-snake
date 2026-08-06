# Guild Staff Roles

Guild-wide allow-list of Discord roles that pass Boiler Snake’s **staff gate** (and, at **senior** level, extra privileges). Stored in the `staff_roles` table—not a separate permission system per feature.

Without any staff roles configured, only members with **Manage Server** pass staff and senior gates. Staff role mutations always require Manage Server.

## How it works

```
Admin /staff role add @Mod level:senior
        → row in staff_roles (guild_id, role_id, level)
        → members with that role pass isStaff / requireStaff
        → senior: also ticket channel view overwrites + /userinfo Activity

Admin /staff role add @Helper level:junior
        → same staff gate + honeypot exempt
        → no automatic ticket overwrites; no Activity tab
```

| Rule | Detail |
|------|--------|
| Storage | `staff_roles` (`guild_id`, `role_id`, `level`, `created_at`) |
| Levels | `junior` \| `senior` (migration `011_staff_role_levels`; default **senior** for legacy rows) |
| Manage Server | Always passes **staff** and **senior** gates (permission bit, not a table row) |
| Honeypot | Any staff role (junior or senior) is exempt; bare Manage Server is **not** |
| Ticket visibility | **Senior** roles only (channel overwrites on open/claim/sensitive/close) |
| `@everyone` | Cannot be added as a staff role |

## Junior vs senior

| Level | Staff commands (`requireStaff`) | Honeypot exempt | Ticket channel overwrites | `/userinfo` Activity |
|-------|----------------------------------|-----------------|---------------------------|----------------------|
| **junior** | Yes | Yes | **No** — use `/ticket addstaff` or claim/transfer for named access | **No** |
| **senior** | Yes | Yes | Yes (open non-sensitive tickets) | Yes |
| Manage Server only (no staff role) | Yes (commands) | **No** | No automatic overwrite | Yes |

- **Junior** = `isStaff` / honeypot exempt only.
- **Senior** = junior + ticket channel visibility overwrites + senior-gated surfaces such as `/userinfo` → Activity.

Configure levels with `/staff role add` or `/staff role setlevel`. Prefer **senior** for full moderators who should see every ticket; use **junior** for helpers who may run notes/warnings/ticket lifecycle commands without auto-seeing every private channel.

### Level changes and open tickets

Changing a role between junior and senior does **not** instantly rewrite every open ticket. Overwrites refresh on lifecycle actions (open, claim, sensitive, close, etc.). After a level change, run a lifecycle command or recreate the ticket if visibility looks stale.

## Commands

### Mutations (Manage Server only)

| Command | Description |
|---------|-------------|
| `/staff role add role:<role> level:<junior\|senior>` | Trust a role as staff. If the role is already listed, updates its level. |
| `/staff role remove role:<role>` | Remove a role from the staff list (drops gate, honeypot exempt, and future ticket overwrites). |
| `/staff role setlevel role:<role> level:<junior\|senior>` | Change junior ↔ senior for an existing staff role. |
| `/staff syncpermissions` | OAuth + sync Discord slash-command **visibility** for staff roles (see below). |

```bash
/staff role add role:@Moderator level:senior
/staff role add role:@Trial-Mod level:junior
/staff role setlevel role:@Trial-Mod level:senior
/staff role remove role:@Old-Staff
/staff syncpermissions
```

### Read-only (staff gate)

| Command | Description |
|---------|-------------|
| `/staff role list` | List trusted staff roles grouped by senior / junior |
| `/staff settings` | Counts + what staff roles control (includes sync status) |

Replies are **ephemeral**.

## Command visibility sync (optional)

Handlers always enforce the staff gate. Discord’s `/` picker is separate: staff-tier commands default to **Manage Server** visibility. To also show them to configured staff roles **without** Manage Server, run a one-time OAuth sync per guild.

1. Operator sets `CLIENT_SECRET`, public HTTP (`PUBLIC_HTTP_PORT` / `PUBLIC_BASE_URL` or ticket aliases), and registers the OAuth2 redirect  
   `https://your-host/oauth/command-permissions/callback` in the Discord Developer Portal.
2. Admin runs `/staff syncpermissions` and opens the **Authorize** link (needs Manage Server + Manage Roles).
3. The bot stores a refresh token and sets per-command role **allow** overwrites for every role in `staff_roles`.
4. Later `/staff role add|remove` re-syncs automatically when a token is stored. Use `force_reauth:true` if auth expired.

**Not synced (by design):** public commands (`/xp`, `/warn`, `/ticket`, …) and Manage Server–only commands (`/staff`, `/setcommandchannel`). Mixed commands stay fully visible; staff subcommands are still gated in code.

Guild admins can still override visibility under **Server Settings → Integrations**.

## Permission gates (feature map)

Three gates appear across the bot:

| Gate | Who passes | Typical use |
|------|------------|-------------|
| **Staff** (`requireStaff` / `isStaff`) | Manage Server **or** any `staff_roles` level | Notes, warnings (incl. `/setwarn`), ticket ops (incl. panel/set*), `/activityconfig`, honeypot channel/banrole, XP/YouTube/decay/logs/reaction-roles, `/userinfo` Overview/Notes/Warnings, `/staff role list` / `settings` |
| **Senior** (`requireSeniorStaff` / `isSeniorStaff`) | Manage Server **or** a **senior** staff role | `/userinfo` → **Activity** tab (and related activity controls) |
| **Manage Server** (`requireAdmin` / `isAdminOrMod`) | Manage Server only | Staff role add/remove/setlevel; **`/staff syncpermissions`**; **`/setcommandchannel`**; **`/honeypot exempt`** (alias for staff-role mutations) |

### Feature summary

| Feature | Access |
|---------|--------|
| [Staff notes](staff-notes.md) (`/note *`) | Staff |
| [Warnings](warnings.md) staff ops (`/warn add\|list\|…`) | Staff |
| `/warn mine` | Any member (own history) |
| `/setwarn *` | Staff |
| [Tickets](tickets.md) staff ops (`claim`, `close`, `for`, …) | Staff |
| Ticket channel **view** overwrites | **Senior** staff roles (+ named staff / members on that ticket) |
| Ticket `setcategory` / `setarchive` / `setratelimit` / `panel` | Staff |
| `/userinfo` Overview / Notes / Warnings | Staff |
| [User activity](user-activity.md) (`/userinfo` Activity) | **Senior** |
| `/activityconfig` | Staff |
| [Honeypot](honeypot.md) exemption | Any staff role (not bare Manage Server) |
| Honeypot config (`/honeypot channel\|banrole`) | Staff |
| Honeypot exempt (`/honeypot exempt …`) | Manage Server only (mutates `staff_roles`) |
| XP/config (`/settings`, `/setxp`, `/setdecay`, `/setlog`, `/leveltorole`, YouTube, reaction roles) | Staff |
| `/setcommandchannel` | Manage Server only |
| Manual XP grant (`/grantxp`) | Manage Server only |
| Public `/xp`, `/leaderboard`, `/ticket create` | Everyone (subject to command-channel rules) |

There are **no** per-feature staff tables (no `warn_access_roles`, no notes-only roles). Everything shares `staff_roles`.

## Relationship to honeypot

`/honeypot exempt add|list|del` is an **alias** over the same `staff_roles` table—not a separate `honeypot_exempt_roles` store (that legacy table was generalized in migration `008_staff_roles`).

| Command | Effect on `staff_roles` |
|---------|-------------------------|
| `/honeypot exempt add role:@Mod` | Adds the role as staff (default level **senior** if new) |
| `/honeypot exempt del role:@Mod` | Removes the role from staff entirely |
| `/honeypot exempt list` | Lists staff roles (honeypot-exempt set) |
| `/staff role add … level:junior\|senior` | Preferred when you care about junior vs senior |

Important nuances:

1. **Any** staff level is honeypot-exempt.
2. **Manage Server alone does not exempt** someone from honeypot bans—only listed roles (and bots, which are ignored).
3. Prefer `/staff role add` with an explicit level so ticket visibility and Activity match your intent; use `/honeypot exempt *` only as a short alias when setting up traps.

See [Honeypot Channels](honeypot.md).

## Bot role hierarchy

For **ticket channel overwrites**, the bot’s role must sit **above** every role it grants view access to (especially **senior** staff roles). If the bot is lower in Server Settings → Roles, Discord returns Missing Permissions and private tickets fail to open or refresh overwrites.

Same hierarchy rule applies wherever the bot manages roles (level roles, reaction roles, bans).

## Setup checklist

1. Plan which Discord roles are **senior** (full mod) vs **junior** (helpers).
2. Place the **bot role above** those staff roles.
3. Add roles:

```bash
/staff role add role:@Moderator level:senior
/staff role add role:@Helper level:junior
/staff role list
```

4. Before enabling honeypots, ensure trusted roles are on the list (`/staff role add` or `/honeypot exempt add`).
5. Configure tickets (category, archive) and verify a test ticket is visible to senior roles only.

## Database

```sql
CREATE TABLE staff_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'senior',  -- junior | senior
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
```

| Migration | Change |
|-----------|--------|
| `008_staff_roles` | Generalized honeypot exempt roles → `staff_roles` (admin gate + exemption) |
| `011_staff_role_levels` | `level` column (`junior` \| `senior`; existing rows default senior) |

See [Database Schema](database.md) for the full schema.

## Related

- [Help Tickets](tickets.md) — senior overwrites, `/ticket addstaff`
- [Staff Notes](staff-notes.md) — staff-gated private notes
- [Warning System](warnings.md) — staff-gated formal records
- [User Activity Summary](user-activity.md) — senior-only Activity tab
- [Honeypot Channels](honeypot.md) — exempt list = staff roles
- [Commands reference](commands/index.md)
- [Setup](setup.md) — bot permissions and ticket notes
- [ROADMAP — Guild staff roles](https://github.com/metalsp0rk/boiler-snake/blob/main/ROADMAP.md#4-guild-staff-roles-admin-gate) — design history
