# Role Management

Automatically grant and revoke Discord roles based on user levels with configurable grace periods.

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

### `level_roles` Table
```sql
CREATE TABLE level_roles (
  guild_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  level_required INTEGER NOT NULL,
  drop_grace_days INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);
```

### `role_drop_state` Table
Tracks when users first dropped below a role's threshold:

```sql
CREATE TABLE role_drop_state (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  below_since INTEGER,  -- ms epoch, NULL when not below
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, role_id)
);
```

## CommonPatterns

### Pattern 1:阶梯式 Access Control
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
