# Daily XP Decay

Reduce XP for inactive users to encourage consistent participation and prevent "hoarding" of high levels.

## Overview

The decay system runs daily on a cron schedule — **`0 4 * * *` by default
(daily 04:00 in the process timezone)**, overridable with the `DECAY_CRON`
env knob (issue #282) — and reduces XP for users who don't meet minimum
activity thresholds. With the default, the way to control *when* it fires
is still the process clock: deployments pin `TZ=UTC` (docker compose
defaults it, audit #206), so the shipped contract is **04:00 UTC on every
host**. A malformed `DECAY_CRON` value **stops boot** and names the bad
expression (config sanity rule 4, audit #205 pattern).

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
For each user in the community, count messages **that earned XP** in the last N days — `activity_log` rows with `kind='message'`, written once per award. Messages inside the message cooldown or filtered by the command-channel / honeypot gates never earned XP and therefore do not count toward the threshold:
```javascript
msgCount = countMessagesInWindow(communityId, userId, decay_window_days)
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
// src/config.js — DECAY_CRON env knob (issue #282), default unchanged
const DEFAULT_DECAY_CRON = "0 4 * * *";  // node-cron semantics: PROCESS timezone

startDecayScheduler → registerJob({ name: "decay", cron: getDecayCron(), run: … })
```

`DECAY_CRON` (unset → the default) is validated at boot with node-cron —
the same grammar the scheduler fires with — and a malformed value stops
boot naming the bad expression.

The job runs on the shared scheduler (`core/scheduler.js`, overlap-skip). Docker
compose sets `TZ: ${TZ:-UTC}`, so the fire time is 04:00 **UTC** on every
deploy; a bare host runs it at its own local 4 AM.

### Code Flow
```javascript
for each community with tracked users {          // one failure never aborts the rest
  for each user row {                            // snapshot is ENUMERATION only (#191)
    msgCount = countMessagesInWindow(community, user, decay_window_days)
    if msgCount >= decay_min_messages continue

    // Relative write against the LIVE row, in one transaction (#191/H10):
    //   UPDATE users SET xp = MIN(MAX_SAFE, MAX(0, FLOOR(xp * (1 - pct))))
    // XP earned while the tick runs is never overwritten.
    applyDecay(community, user, pct)             // no-op ⇒ null (pct 0, xp 0, unchanged)

    // role re-sync at the new level (per-user try/catch, #198):
    syncMemberRoles(...)                         // /leveltorole (+ grace period)
    syncMemberReactionRoles(...)                 // reaction-role min_level (immediate)
  }
}
```

### Role checks after decay

For every user who **actually loses XP**, the bot re-evaluates roles at the new level:

| System | Behavior after decay |
|--------|----------------------|
| **`/leveltorole`** | Existing grace-period logic: role is kept until the user has been below the required level longer than `dropdays` |
| **Reaction roles** | If the member holds a reaction-claim role and their level is below that role’s **minimum** configured `min_level` (lowest among all options granting that role), the role is **removed immediately** |

Reaction-role removal on decay does **not** remove the user’s reaction on the panel message (they can re-react once they meet the level again).

Platform caveat: the table above is the Discord arm. On **Fluxer** communities the `/leveltorole` re-sync runs only when the community row carries `elevated_permissions = 1` (the K8 gate — without it the decay still applies, roles stay untouched), and reaction-role removal stays **Discord-only** (it needs discord.js member objects). See [Fluxer](fluxer.md).

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

Use `/settings` command — the **Decay** field of the settings embed shows:

```
Enabled **true** · threshold **20** msgs / **7** days · **10%**
```

## Performance Considerations

### Scaling
- Iterates over ALL users in guild (DB table `users`)
- For large servers (>10,000 users), consider:
  - Running decay less frequently (not recommended)
  - Disabling decay during high-traffic periods
  - Using database indexes on activity_log

### Database Load
Decay query pattern (`src/db/repositories/activity.js`):
```sql
SELECT COALESCE(SUM(amount), 0) 
FROM activity_log 
WHERE community_id=? AND user_id=? AND kind='message' AND created_at >= ?
```

Index in place: `idx_activity_recent (community_id, user_id, kind, created_at)` — both the counter and the index are keyed by the internal `communities.id` (`community_id INTEGER`) since migration `034_communities` re-keyed the guild-scoped tables (same treatment as [Warnings](warnings.md)).

## Edge Cases

### Edge Case 1: XP Reaching Zero
```javascript
floor(50 × (1 - 0.9)) = floor(5) = 5 XP       // one 90% tick: 50 → 5…
floor(5 × 0.9)  = 4                           // …repeated 10% ticks keep walking down:
floor(4 × 0.9)  = 3
floor(1 × 0.9)  = 0   // with 10% decay, 1 XP decays to NOTHING
floor(19 × (1 - 0.95)) = floor(0.95) = 0   // 95% decay zeroes 19 XP in one tick
```

XP **can** reach zero via decay. The write is `MAX(0, FLOOR(xp × keep))` — a
repeated floor of a fraction strictly below 1, so any XP total an inactive user
keeps below the message threshold eventually walks down to `0` (faster for
small totals: any total below `1 / keep` hits zero on the next tick). Zero is
absorbing: `applyDecay` is a no-op once the row is 0.

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
