# XP and Leveling System

The core feature of Boiler Snake is its customizable XP and leveling system, which奖励s participation across multiple activity types.

## XP Sources

### 1. Messages
- **Configurable**: Set XP per message (default: 5)
- **Cooldown**: Prevents spam farming (default: 20 seconds)
- Example: With `msg_xp=5` and `msg_cooldown_sec=20`, a user can earn up to 270 XP/hour from messages

### 2. Reactions
- **Configurable**: Set XP per reaction (default: 2)
- **Cooldown**: Configurable delay between reaction XP awards (default: 10 seconds)
- Example: With `reaction_xp=2` and `reaction_cooldown_sec=10`, users can earn up to 720 XP/hour from reactions

### 3. Voice Channels
- **Per-minute ticker**: Awards XP once per minute for eligible voice participants
- **Configurable rate**: Set XP per minute (default: 1)
- **Eligibility rules**:
  - Must be in a non-AFK voice channel
  - Cannot be muted or deafened (self or server)
  - At least 2 eligible humans required in the channel
  - Bots are excluded

## Level Calculation Formula

Levels are calculated using a square root formula:

```
Level = floor(sqrt(XP / factor))
```

Where:
- **Factor** is configurable (default: 100)
- XP required for level L: `L² × factor`

### Example XP Requirements (with factor=100)

| Level | Required XP |
|-------|-------------|
| 1     | ≥ 100       |
| 2     | ≥ 400       |
| 3     | ≥ 900       |
| 5     | ≥ 2,500     |
| 10    | ≥ 10,000    |
| 20    | ≥ 40,000    |

### Customizing the Level Curve

The curve uses `guild_settings.level_xp_factor` (default **100**). **`/setxp` does not change this factor** (only message/reaction/voice XP and cooldowns). To change the factor, update the database or call `updateGuildSettings` programmatically — see [Configuration — Level curve](configuration.md#level-curve-configuration).

- **Lower factor (e.g., 50)**: Easier leveling (less XP needed)
- **Higher factor (e.g., 200)**: Harder leveling (more XP needed)

Example with `level_xp_factor=50`:
- Level 1: ≥ 50 XP
- Level 2: ≥ 200 XP  
- Level 10: ≥ 5,000 XP

## XP Safety Mechanisms

### Event-Level Capping
- Maximum XP awarded per event: **1,000,000,000** (1 billion)
- Prevents accidental or malicious inflation of XP values

### Database-Level Capping
- JavaScript-safe limit: `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991)
- Atomic database transactions prevent race conditions
- Automatic clamping of Infinity/NaN/overflow values on read/write

## Cooldown System

In-memory cooldown tracking prevents spam farming:

| Cooldown Type | Purpose | Default |
|---------------|---------|---------|
| `msg_cooldown_sec` | Delay between message XP awards | 20 seconds |
| `reaction_cooldown_sec` | Delay between reaction XP awards | 10 seconds |

**Memory Management**: Cooldown entries are swept every 10 minutes, removing entries older than 6 hours to keep memory usage bounded.

## Activity Tracking

All XP-earning activities are logged in the `activity_log` table for analysis and decay calculations:

| Kind | Description |
|------|-------------|
| `message` | Message-based XP earnings |
| `reaction` | Reaction-based XP earnings |
| `voice_minute` | Voice channel XP awards |

This data enables:
- Decay calculations (counting messages in time windows)
- Analytics on which activities generate the most XP
- Future features like activity statistics
