# Daily XP Decay

Reduce XP for inactive users to encourage consistent participation and prevent "hoarding" of high levels.

## Overview

The decay system runs daily at 4:00 AM server time (configurable via cron) and reduces XP for users who don't meet minimum activity thresholds.

## Configuration

### Enable/Disable
```bash
/setdecay enabled:true messages:20 days:7 percent:10
```

### Parameters

| Parameter | Description | Range | Default |
|-----------|-------------|-------|---------|
| `enabled` | Enable/disable decay | boolean | true |
| `messages` | Minimum messages required in window | ≥ 0 | 20 |
| `days` | Time window size (days) | ≥ 1 | 7 |
| `percent` | XP reduction percentage | 0-95% | 10% |

### How Decay Works

#### Step 1: Activity Check
For each user in the guild, count messages sent in the last N days:
```javascript
msgCount = countMessagesInWindow(guildId, userId, decay_window_days)
```

#### Step 2: Apply Decay (if needed)
If `msgCount < decay_min_messages`:
```javascript
newXp = floor(oldXp × (1 - decay_percent))
```

### Example Scenarios

#### Scenario A: Low Activity
Settings: `messages=20, days=7, percent=10`
- User has 15 messages in last 7 days → XP reduced by 10%
- User has 50 messages in last 7 days → No decay

#### Scenario B: High Decay
Settings: `messages=5, days=3, percent=25`
- User inactive for 3+ days → Loses 25% of XP immediately
- Encourages faster re-engagement

#### Scenario C: Graceful Decay
Settings: `messages=10, days=14, percent=5`
- Users with ~1 message/day are considered active
- Only mildly reduces XP for truly inactive users

## Technical Implementation

### Schedule
```javascript
// Runs at 4 AM server time daily
cron.schedule("0 4 * * *", runDecayForGuild);
```

### Code Flow
```javascript
for each guild {
  for each user {
    msgCount = count recent messages (last N days)
    
    if msgCount < minimum {
      newXp = floor(oldXp × (1 - decay_percent))
      
      // Update XP in database
      setXp(guildId, userId, newXp)
      
      // Sync roles (may drop below thresholds)
      level = levelFromXp(newXp)
      syncMemberRoles(member, level)           // /leveltorole (+ grace period)
      syncMemberReactionRoles(member, level) // reaction-role min_level (immediate)
    }
  }
}

### Role checks after decay

For every user who **actually loses XP**, the bot re-evaluates roles at the new level:

| System | Behavior after decay |
|--------|----------------------|
| **`/leveltorole`** | Existing grace-period logic: role is kept until the user has been below the required level longer than `dropdays` |
| **Reaction roles** | If the member holds a reaction-claim role and their level is below that role’s **minimum** configured `min_level` (lowest among all options granting that role), the role is **removed immediately** |

Reaction-role removal on decay does **not** remove the user’s reaction on the panel message (they can re-react once they meet the level again).
```

### Activity Log Integration

Decay uses the `activity_log` table with `kind='message'` entries.
Each message XP award increments this counter automatically.

## Use Cases

### Use Case 1: SeasonalServers (High Engagement)
**Goal**: Keep peak activity during "seasons"

```bash
/setdecay enabled:true messages:50 days:7 percent:20
```
- Requires ~7 messages/day to avoid decay
- 20% reduction for inactive users
- Encourages daily participation

### Use Case 2: Low-MaintenanceServer (Passive)
**Goal**: Don't penalize occasional users

```bash
/setdecay enabled:true messages:5 days:30 percent:10
```
- Requires ~1 message every 6 days
- Only 10% decay for truly inactive
- Forgiving for infrequent but loyal members

### Use Case 3: Event-BasedServer (Seasonal)
**Goal**: Ramp up during events, reduce otherwise

```bash
# During event
/setdecay enabled:true messages:30 days:7 percent:30

# Off-season (disable decay entirely)
/setdecay enabled:false messages:20 days:7 percent:10
```

## View Current Decay Settings

Use `/settings` command:
```
**Decay:** enabled=true, threshold=20 msgs / 7 days, percent=10%
```

## Performance Considerations

### Scaling
- Iterates over ALL users in guild (DB table `users`)
- For large servers (>10,000 users), consider:
  - Running decay less frequently (not recommended)
  - Disabling decay during high-traffic periods
  - Using database indexes on activity_log

### Database Load
Decay query pattern:
```sql
SELECT COALESCE(SUM(amount), 0) 
FROM activity_log 
WHERE guild_id=? AND user_id=? AND kind='message' AND created_at >= ?
```

Index in place: `idx_activity_recent (guild_id, user_id, kind, created_at)`

## Edge Cases

### Edge Case 1: Zero XP After Decay
```javascript
floor(50 × (1 - 0.9)) = floor(5) = 5 XP
```
XP can never reach zero via decay (always at least floor(XP × 0.05))

### Edge Case 2: Already Low XP
If user has very little XP, decay may have negligible effect:
```javascript
floor(10 × 0.9) = 9 XP  // Only loses 1 XP
```

### Edge Case 3: User Not in Database
Users never awarded XP are not included in decay (not in `users` table)

## Recommendations

### Good Patterns
✅ Start with conservative settings (`messages=20, days=7, percent=5-10`)
✅ Monitor user feedback after enabling
✅ Use `/settings` to verify configuration
✅ Test with a few users before enabling guild-wide

### Avoid
❌ Setting `percent > 95` (can strip all XP too aggressively)
❌ Setting `days < 3` (too short for reasonable activity patterns)
❌ Combining decay with very high base XP rates without compensation
