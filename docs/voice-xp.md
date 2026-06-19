# Voice XP System

The voice XP system rewards users for participating in voice channels while preventing abuse through eligibility checks.

## How It Works

### The Ticker
- Runs every minute on minute boundaries (00, :01, :02, etc.)
- Calculates initial delay to align with next minute mark
- Example: If current time is 14:35:23, waits 37 seconds before first tick

### Eligibility Rules

For a user to earn voice XP in a given minute:

✅ **Must be**:
- In an active voice channel (not disconnected)
- NOT in the AFK channel (if configured)
- A human user (bots excluded)
- NOT muted or deafened (self-mute/server-mute/self-deaf/server-deaf all block)

✅ **Voice Channel Requirements**:
- Must have at least 2 eligible humans
- Single users in voice channels earn no XP

❌ **Blocked Cases**:
- Alone in a voice channel
- AFK channel participation
- Muted or deafened (any type)
- Bot accounts

## Configuration

Set in `/setxp` command:

```bash
/voice <int>          # XP per minute (default: 1)
```

### Example Calculations

With `voice_xp_per_min = 5`:
- 10 minutes in voice = 50 XP
- 1 hour in voice = 300 XP
- Level-up threshold at level 5: 2,500 XP → ~8.3 hours of total voice time

## Technical Implementation

### Voice State Tracking
- Uses Discord.js `GatewayIntentBits.GuildVoiceStates` intent
- Scans all active voice states on each tick
- Maps channel IDs to arrays of eligible members

### Code Flow
```javascript
for each guild {
  for each voice state {
    if (eligible) add to channel's eligible list
  }
  for each channel with ≥2 eligibles {
    award XP to each member
  }
}
```

## Potential Issues & Troubleshooting

### Issue: "I'm in voice but not getting XP"

**Checklist**:
1. ✅ Is there at least one other person in the channel?
2. ✅ Are you muted or deafened? (check both self and server status)
3. ✅ Are you in an AFK channel?
4. ✅ Did the bot start after you joined voice? (requires tick to fire)
5. ✅ Is `voice_xp_per_min > 0` in settings?

### Issue: "Too much XP from voice"

**Solutions**:
- Reduce `voice_xp_per_min` setting
- Move users between channels (only one channelAwarded per minute)
- Use decay system to balance long-term accumulation
