# Role Management

Automatically grant and revoke Discord roles based on user levels with configurable grace periods.

For **self-serve emoji panels** (react to claim a role with optional min level), see [Reaction Roles](reaction-roles.md).

## How It Works

### Role Mappings

Configure role→level mappings using:

```bash
/leveltorole set role:@RoleName level:10 dropdays:7
```

This creates a mapping:

- **Grant**: When user reaches Level 10 or higher, give @RoleName
- **Revoke**: If user drops below Level 10, keep role for 7 days, then remove

### Command Subcommands

#### `set` - Create/Update Mapping

```bash
/leveltorole set role:@Member level:5 dropdays:3
```

#### `remove` - Delete Mapping

```bash
/leveltorole remove role:@Member
```

#### `list` - Show All Mappings

```bash
/leveltorole list
```

Displays all mappings with their thresholds and grace periods.

## Grace Period System

### Purpose

Prevent users from immediately losing Roles when they temporarily drop in level (e.g., due to XP decay or server activity changes).

### Logic Flow

1. User has role B, at Level 10
2. User's XP decreases, dropping to Level 9
3. **Timer starts**: Mark user as "below threshold for role B"
4. If user returns to Level 10+ within grace period: Clear timer, keep role
5. If grace period expires while below threshold: Revoke role

### Time Calculation

```javascript
graceMs = drop_grace_days × 24 × 60 × 60 × 1000
```

Example with `dropdays=7`:

- If user drops below level at 14:00 on Monday
- Role is revoked at 14:00 on the following Monday (if not promoted back)

### When the Drop Is Evaluated

The grace timer is checked from three places:

1. **On any XP award** — the unified award path re-syncs the member's roles.
2. **On the daily decay tick** — for every user whose XP it rewrote that tick.
3. **Daily grace-drop sweeper** (`levelRoles/dropSweeper.js`, cron
   `17 5 * * *` on the **process** clock) — re-runs the sync for every armed
   timer whose grace has expired, purely on elapsed time. Docker compose pins
   `TZ: ${TZ:-UTC}`, so on container deploys it fires at 05:17 **UTC**; a bare
   host runs it at its own local 05:17 (same caveat as decay's
   `DECAY_CRON`). This is the safety net for users whose XP never changes
   again (decayed to 0, or decay-exempt): without it the timer would never
   fire and the role would be kept forever (#428). Actual revocation
   therefore lands on the first sweep after the deadline — at most ~24h
   after the exact moment.

### When role ops fail

Role adds/removes can fail — the classic cause is the bot’s highest role
sitting **below** the role it tries to manage (or missing Manage Roles).
Failed ops are **reported, not just logged** (#430, audit XE-3):

- **`/grantxp`** — XP landed but a role may not have: the reply appends
  `⚠️ **Role sync incomplete**: couldn't add role <@&role-id> (cause)`
  naming each failed role and error.
- **Level-role audit embed** — every failed op lands in a **Failed** field
  (`⚠ add <@&role-id> (role-id): cause`) so staff see WHICH role and WHY
  without grepping the console.
- A sync where **everything** failed posts a loud **`Level role sync FAILED`**
  embed instead of looking like a quiet no-op.
- **Drop sweeper** — failures post through the same embed path and log with
  user/community ids (bot-below-role is the named cause in `[roles]` console
  lines).

## Best Practices

### Setting Level Thresholds

Consider your community goals:

| Use Case | Recommended Levels |
|----------|-------------------|
| Early engagement | Lvl 2-5 roles |
| Moderate Activity | Lvl 10-25 roles |
| High commitment | Lvl 50+ roles |

**Tip**: Space levels meaningfully (e.g., role at L5, L15, L30, L50) rather than every level.

### Role Position in Discord

⚠️ **Critical Requirement**:
The bot's highest role must be positioned ABOVE any roles it manages.

**Setup Path**:

1. Server Settings → Roles
2. Find your bot's role
3. Drag it above the roles it should manage
4. Ensure bot has "Manage Roles" permission

### Naming Conventions

Consider using:

```
Lvl 5: Novice
Lvl 10: Member  
Lvl 25: Veteran
Lvl 50: Elite
Lvl 100: Legend
```

## Database Schema

Both tables were re-keyed from `guild_id TEXT` to `community_id INTEGER` by migration `034_communities` (the guild snowflake now lives in `communities.external_guild_id`).

### `level_roles` Table

```sql
-- Live DDL (migrated schema)
CREATE TABLE level_roles (
  community_id INTEGER NOT NULL,   -- communities.id (re-keyed by 034_communities)
  role_id TEXT NOT NULL,
  level_required INTEGER NOT NULL,
  drop_grace_days INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, role_id)
);
```

### `role_drop_state` Table

Tracks when users first dropped below a role's threshold. Rebuilt by migration `057_level_role_fk` (#469 DB-9/DB-10), which added the foreign keys:

```sql
-- Live DDL (rebuilt by 057_level_role_fk)
CREATE TABLE role_drop_state (
  community_id INTEGER NOT NULL REFERENCES communities(id),
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER, -- ms epoch, NULL when not below
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id, role_id),
  FOREIGN KEY (community_id, role_id)
    REFERENCES level_roles (community_id, role_id) ON DELETE CASCADE
);
```

The composite FK makes the repository's promise ("`deleteLevelRole` removes both rows") a database invariant: deleting a mapping cascades away its members' drop-timer rows, and orphaned drop-state rows can no longer exist (057 pre-cleaned the legacy ones with a named count).

## CommonPatterns

### Pattern 1: Access Control

```bash
/leveltorole set role:@Verified level:1 dropdays:0      # Immediate verification
/leveltorole set role:@Member level:5 dropdays:3        # Basic access after 5 levels
/leveltorole set role:@Community level:20 dropdays:7    # Community access
```

### Pattern 2: Temporary Recognition

```bash
# Grant special event roles, remove after grace period even if XP drops
/leveltorole set role:@Summer2024 level:15 dropdays:14
```

### Pattern 3: No Drop (Permanent Roles)

```bash
# Keep roles forever once earned
/leveltorole set role:@Alumni level:50 dropdays:9999
```

## View Current Mappings

Use `/settings` to see all active mappings for the guild:

```
**Level→Role mappings:**
- <@&123456789> @ Lvl 5 (drop after 3d)
- <@&987654321> @ Lvl 20 (drop after 7d)
```
