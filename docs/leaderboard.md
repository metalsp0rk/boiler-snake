# Leaderboard Rendering

Beautiful, high-quality PNG leaderboards showing top users by XP with gradients, rankings, and level information.

## Overview

The leaderboard system generates professional-grade images using the `@napi-rs/canvas` library for pixel-perfect rendering across Discord platforms.

## Features

- **Top 10 display**: Shows best performers in a guild
- **Dark theme**: Modern blue gradient background matching HeisenXP branding
- **Gradient bars**: Visual XP progression with cyan/green colors
- **Trophy icons**: Gold/silver/bronze for top 3
- **Level integration**: Shows level alongside raw XP
- **Unicode support**: Handles emoji and special characters via font stack

## Command Usage

### Basic Leaderboard

```bash
/leaderboard
```

Shows top 10 users with:
- Rank position (1-10)
- Username or display name
- Total XP
- Current level

### Custom Limit (Advanced)

```bash
/leaderboard limit:20
```

Shows up to 20 users (default is always 10). Note: Rendered image still shows only top 10 visually.

## Image Specifications

### Dimensions
- **Width**: 900 pixels
- **Height**: Variable (base + rows)
- **Total height for 10 users**: ~856 pixels

### Color Scheme

| Element | Color |
|---------|-------|
| Background (top) | `#070A12` |
| Background (bottom) | `#0B1224` |
| XP bar gradient start | Cyan-ish |
| XP bar gradient end | Green-ish |
| Rank text | White/silver |
| Username | Cyan |

### Font Stack

Fallback chain for maximum Unicode coverage:
```
Noto Sans → DejaVu Sans → Segoe UI Symbol → 
Apple Color Emoji → Noto Color Emoji → system-ui
```

Install at least one of these packages on your host:
```bash
# Ubuntu/Debian
sudo apt install fonts-noto-core fonts-dejavu-core fonts-noto-color-emoji

# Alpine Linux
sudo apk add noto-fonts ttf-dejavu ttf-nerd-fonts
```

## Rendering Algorithm

### Layout Calculation

```
Total Height = padding(28)
             + header_height(110)
             + gap_after_header(22)  
             + rows × row_step(70)   [for 10 users]
             + bottom_padding(56)
```

### Row Design

Each user row includes:
- **Rank**: Large, bold numbers (gold (#FFD700) for top 3)
- **Username**: Display name with emoji support
- **XP Bar**: Visual gradient representing XP amount
- **Level**: Secondary information below bar

### Trophy Implementation

```javascript
// Top 3 get special treatment
if (rank === 1) { trophy = "🏆" }  // Gold
if (rank === 2) { trophy = "🥈" }  // Silver  
if (rank === 3) { trophy = "🥉" }  // Bronze

// Others show rank number only
```

## Code Implementation

### Main Function Signature

```javascript
function renderLeaderboardPng(entries, factor = 100)
```

**Parameters**:
- `entries`: Array of `{ rank, name, xp, level }` objects
- `factor`: Level curve factor (default: 100)

**Returns**: PNG buffer ready for Discord attachment

### Entry Processing

```javascript
const top10 = entries.slice(0, 10);
// For each entry:
{ rank, name, xp, level } = {
  rank: idx + 1,
  name: member?.displayName || username || "Unknown",
  xp: XP total (raw number),
  level: Math.floor(Math.sqrt(xp / factor))
}
```

## Integration with Other Features

### Relationship to Level System

Leaderboard uses the same `levelFromXp()` function:
```javascript
Level = floor(sqrt(XP / level_xp_factor))
```

This ensures consistency between `/xp`, `/leaderboard`, and auto-granted roles.

### Activity Log Connection

Top users are pulled from `users` table, which is updated by:
- Message XP (levelled through `activity_log`)
- Reaction XP (tracked in `activity_log`)  
- Voice XP (logged as "voice_minute" activity)

## Performance Considerations

### Memory Usage
- Canvas rendering: ~20-50MB temporary allocation
- PNG buffer: ~100-300KB per image
- No ongoing memory footprint after response sent

### Optimization Tips

✅ Batch member fetches (fetch by user ID array)
✅ Cache leaderboard results in high-traffic servers  
✅ Consider `/leaderboard` cooldowns on busy bots

## Troubleshooting

### Issue: "Tofu blocks / boxes instead of emojis"

**Cause**: Missing Unicode fonts
**Fix**: Install emoji font packages (see Font Stack above)

### Issue: "Image looks corrupted or blank"

**Checklist**:
1. ✅ @napi-rs/canvas installed (`npm install`)
2. ✅ System has canvas support libraries
3. ✅ Bot has sufficient memory for canvas operations

### Issue: "Wrong XP values displayed"

Verify guild settings match expectations:
```bash
/settings
```

Check that `level_xp_factor` is correct (default 100).

## Security Considerations

### Input Sanitization

Display names are sanitized to prevent rendering attacks:
- Removed control characters (`\u0000-\u001F`, `\u007F-\u009F`)
- Removed bidirectional overrides (`\u200E`, `\u202A-\u202E`)
- Collapsed multiple whitespace to single space
- Fallback to "—" if empty after cleaning

### Data Exposure

Leaderboard shows:
- Public data only (XP, levels)
- No PII or sensitive info
- Respects Discord privacy model

## Customization Ideas

Want to change the look?

### Modify Colors in `src/renderLeaderboard.js`

```javascript
// Background gradient stop 1
const bg0 = "#070A12";

// XP bar color
const barStart = "cyan";
```

### Adjust Layout Dimensions

```javascript
const ROW_COUNT = 15;     // Show more/less rows
const width = 1200;       // Wider leaderboard
const rowStep = 80;       // More vertical spacing
```

### Add Custom Branding

Add your server's logo:
```javascript
const logo = createCanvas(64, 64);
// ...draw logo...
ctx.drawImage(logo, padding, padding);
```
