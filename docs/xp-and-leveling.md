# XP and Leveling System

The core feature of Boiler Snake is its customizable XP and leveling system, which rewards participation across multiple activity types.

**On Fluxer:** XP accrual is identical on [Fluxer instances](fluxer.md) — messages and reactions there flow through the same community-scoped award pipeline (same XP math, cooldowns, and level curve), so a message earns `msg_xp` whether it lands on Discord or a Fluxer community. Two caveats: a line that parses as a **prefix command** (`!xp`, `!help`, …) still counts as message activity but earns no XP, and **voice XP has no Fluxer source** — normalized voice states carry no XP arm, so voice remains Discord-only (see [Voice XP](voice-xp.md)).

## XP Sources

### 1. Messages
- **Configurable**: Set XP per message (default: 5)
- **Cooldown**: Prevents spam farming (default: 20 seconds)
- Theoretical cap: `3600 / msg_cooldown_sec × msg_xp` XP/hour — the defaults (`msg_xp=5`, `msg_cooldown_sec=20`) give **900 XP/h**, only reachable by posting steadily every 20 seconds for a full hour

### 2. Reactions
- **Configurable**: Set XP per reaction (default: 2)
- **Cooldown**: Configurable delay between reaction XP awards (default: 10 seconds)
- Theoretical cap: `3600 / reaction_cooldown_sec × reaction_xp` XP/hour — the defaults (`reaction_xp=2`, `reaction_cooldown_sec=10`) give **720 XP/h** (reactions only; caps are per-source and stack with the others)

### 3. Voice Channels
- **Per-minute ticker**: Awards XP once per minute for eligible voice participants (a user holds one voice channel per guild, so one award per user per tick; **every** eligible channel is awarded each tick)
- **Configurable rate**: Set XP per minute (default: 1)
- Theoretical cap: `60 × voice_xp_per_min` XP/hour of continuous eligible voice (default: 60 XP/h)
- **Eligibility rules**:
  - Must be in a non-AFK voice channel
  - Cannot be muted or deafened (self or server)
  - At least 2 eligible humans required in the channel
  - Bots are excluded

### 4. Admin grant (`/grantxp`)
- **Manage Server only** (staff roles do not grant access)
- Adds a fixed amount of XP to a member (not bots)
- Runs the same pipeline as natural XP: level roles + level-role audit
- Optional `reason` is recorded in the config audit log
- Logged in `activity_log` as kind `admin_grant` (does **not** count toward decay message thresholds)

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

The curve uses `guild_settings.level_xp_factor` (default **100**). Change it with `/setxp factor:<int>` (range 1–10,000).

- **Lower factor (e.g., 50)**: Easier leveling (less XP needed)
- **Higher factor (e.g., 200)**: Harder leveling (more XP needed)

Example with `level_xp_factor=50`:
- Level 1: ≥ 50 XP
- Level 2: ≥ 200 XP
- Level 10: ≥ 5,000 XP

## XP Safety Mechanisms

### Event-Level Capping
- **Maximum XP awarded per event:** 1,000,000,000 (1 billion)
- Prevents accidental or malicious inflation of XP values

### Database-Level Capping
- JavaScript-safe limit: `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991)
- Atomic database transactions prevent race conditions
- Automatic clamping of Infinity/NaN/overflow values on read/write

## Cooldown System

In-memory cooldown tracking prevents spam farming:

| Cooldown Type | Purpose | Default | Max |
|---------------|---------|---------|-----|
| `msg_cooldown_sec` | Delay between message XP awards | 20 seconds | 86,400 s (24 h) |
| `reaction_cooldown_sec` | Delay between reaction XP awards | 10 seconds | 86,400 s (24 h) |

The two `/setxp` cooldown options (`msgcooldown`, `reactioncooldown`) are hard-capped at **86,400 seconds (24 h)** in the command itself — larger values are rejected by Discord's option validation. Legacy out-of-range rows were pulled inside the cap by migration `050_xp_cooldown_clamp`.

**Window stamping**: the cooldown window is stamped only **after** an award actually succeeds ("no pay, no window"). An award that throws (e.g. a transient DB fault) leaves the window free, so the user's next event is not silently skipped.

**Memory Management**: Cooldown entries are swept every 10 minutes, removing entries older than **25 hours** to keep memory usage bounded. The horizon is deliberately past the largest legitimate window (max configurable 24 h + 1 h slack, #429): an earlier 6 h horizon evicted entries *inside* configured windows above 6 h, silently re-arming awards early while the setting looked applied. The sweep age must always exceed the max configurable cooldown.

## Activity Tracking

All XP-earning activities are logged in the `activity_log` table for analysis and decay calculations:

| Kind | Description |
|------|-------------|
| `message` | Message-based XP earnings |
| `reaction` | Reaction-based XP earnings |
| `voice_minute` | Voice channel XP awards |
| `admin_grant` | Manual grants via `/grantxp` (ignored by decay message counts) |

This data enables:
- Decay calculations (counting messages in time windows)
- Analytics on which activities generate the most XP
- Future features like activity statistics
