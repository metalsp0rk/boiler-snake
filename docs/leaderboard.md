# Leaderboard Rendering

Beautiful, high-quality PNG leaderboards showing top users by XP with gradients, rankings, and level information.

## Overview

The leaderboard system generates professional-grade images using the `@napi-rs/canvas` library for pixel-perfect rendering across Discord platforms.

## Features

- **Paginated display**: 1–20 users per page with Prev/Next buttons (default page size 10)
- **Dark theme**: Modern blue gradient background matching Boiler Snake branding
- **Gradient bars**: Progress within the current level toward the next (cyan → green)
- **Trophy icons**: Vector-drawn gold/silver/bronze trophies for the top 3 (no emoji)
- **Level integration**: Shows level alongside raw XP
- **Unicode support**: Handles emoji and special characters via font stack

## Command Usage

### Basic Leaderboard

```bash
/leaderboard
```

Shows the first 10 users (ranks 1–10) with:
- Rank position
- Username or display name
- Total XP
- Current level

### Limit option

```bash
/leaderboard limit:20
```

`limit` is the **page size**: integer 1–20, default **10**. The handler queries and renders that many rows per page.

### Page option

```bash
/leaderboard limit:20 page:2
```

`page` is the page number: integer **1–20**, default **1**. Requested pages are clamped to the ceiling (`LB_PAGE_MAX = 20`) at parse time, so browsable ranks are hard-capped at `page × limit` regardless of guild size (default page size → rank ≤ 200).

### Pagination

**Every** leaderboard payload — including the `No leaderboard data yet.` notice — carries the **◀ Prev** / **Next ▶** button row (Next disabled; Prev enabled when page > 1):

- **Prev** is disabled on page 1.
- **Next** is disabled on the last page — **and always at page 20**, the page ceiling, even when more rows exist. Past the ceiling every page renders the same last slice, so the button is honestly disabled instead of a live-clicking dead button.
- Only the user who ran `/leaderboard` can press the buttons (others get an ephemeral notice).
- Each click re-queries the leaderboard, so ranks/XP reflect current data.
- Pressing a button from a pre-cap leaderboard message (an out-of-range page id) answers: `This leaderboard page is stale — run **/leaderboard** again.`
- Message content shows the applied range, e.g. `**Leaderboard — ranks 11–20**`.

### Fluxer

On Fluxer the empty-leaderboard notice is answered **in-channel**: Fluxer has no ephemerals, and the DM-first (`sensitive: true`) reply made an empty leaderboard look like a dead bot. On Discord the same notice is `sensitive` (caller-only). The Prev/Next button arm is **Discord-only** — it re-queries through a Discord guild member fetch. See [Fluxer](fluxer.md).

## Image Specifications

### Dimensions
- **Width**: 900 pixels
- **Height**: Variable (base + rows × row step)
- **Total height for 10 users**: 916 pixels
- **Total height for 20 users**: 1616 pixels

(Both follow the layout formula below: `28 + 110 + 22 + rows × 70 + 56`.)

### Color Scheme

| Element | Color |
|---------|-------|
| Background (top) | `#070A12` |
| Background (bottom) | `#0B1224` |
| XP bar gradient start | `#00D8FF` (cyan) |
| XP bar gradient end | `#57FF9A` (green) |
| Trophy metals | gold `#F6C453` · silver `#C9D1D9` · bronze `#C67C4E` |
| Rank text (ranks 4+) | `rgba(234, 242, 255, 0.65)` |
| Username | `#EAF2FF` |

### Font Stack

Fallback chain for maximum Unicode coverage:
```
Noto Sans → Noto Sans Symbols2 → Noto Sans Symbols → Noto Sans Math →
DejaVu Sans → Segoe UI Symbol → Apple Color Emoji → Noto Color Emoji →
Twemoji Mozilla → system-ui → -apple-system → Segoe UI → Roboto →
Arial → sans-serif
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
             + rows × row_step(70)   [rows = page size, 1-20]
             + bottom_padding(56)
```

### Row Design

Each user row includes:
- **Rank**: Top 3 get a vector-drawn trophy with the rank number painted on the cup; ranks 4+ show a plain `<n>.` in `rgba(234, 242, 255, 0.65)`
- **Username**: Display name with emoji support (ellipsis-truncated to fit)
- **XP Bar**: Progress **within the current level** toward the next level — `startXP = L² × factor` → `nextXP = (L+1)² × factor` — not the raw XP amount
- **Level**: Secondary information below the XP total (right-aligned)

### Trophy Implementation

No emoji glyphs are used anywhere — the top 3 get a small vector trophy drawn with canvas paths (`drawTrophy()`), filled with the metal color, with a glow and the rank number painted onto the cup:

```javascript
// Top 3 get the vector trophy; the metal is the fill color
// rank 1 → gold    #F6C453
// rank 2 → silver  #C9D1D9
// rank 3 → bronze  #C67C4E

// Ranks 4+ show "<n>." text only
```

## Code Implementation

### Source of truth

| Path | Role |
|------|------|
| **`src/render/leaderboard.js`** | Canonical PNG renderer (`renderLeaderboardPng`) |
| `src/renderLeaderboard.js` | Thin **compat shim** only (`module.exports = require("./render/leaderboard")`) — do not edit this for theming |

XP command code imports the canonical path:

```javascript
const { renderLeaderboardPng } = require("../../render/leaderboard");
```

### Main Function Signature

```javascript
function renderLeaderboardPng(entries, factor = 100, subtitle = null)
```

**Parameters**:
- `entries`: Array of `{ rank, name, xp, level }` objects (1–20 rows; capped at 20)
- `factor`: Level curve factor (default: 100)
- `subtitle`: Optional header subtitle (default: `Top {rows} by XP • Quantum-approved`)

**Returns**: PNG buffer ready for Discord attachment

### Entry Processing

```javascript
const top = entries.slice(0, 20);
// For each entry on the page:
{ rank, name, xp, level } = {
  rank: global rank (page offset + idx + 1),
  name: resolved display name || `User ${user_id}`,
  xp: XP total (raw number),
  level: Math.floor(Math.sqrt(xp / factor))
}
```

Unresolved members render as `User <user_id>`; a name that is empty after sanitization becomes the placeholder `—` in the renderer.

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
- NFC-normalized first
- Removed control characters (`\u0000-\u001F`, `\u007F-\u009F`)
- Removed bidirectional controls (`\u200E`, `\u200F`, `\u202A-\u202E`, `\u2066-\u2069`)
- Collapsed multiple whitespace to single space
- Fallback to "—" if empty after cleaning

### Data Exposure

Leaderboard shows:
- Public data only (XP, levels)
- No PII or sensitive info
- Respects Discord privacy model

## Customization Ideas

Want to change the look? Edit **`src/render/leaderboard.js`** (not the `src/renderLeaderboard.js` shim).

### Modify Colors

```javascript
// Background gradient stops
const bg0 = "#070A12";
const bg1 = "#0B1224";

// XP bar / accent colors live further down in the same file
```

### Adjust Layout Dimensions

```javascript
const MAX_ROWS = 20;      // Cap rows in the PNG (page size)
const width = 900;        // Canvas width
const rowStep = 70;       // Vertical spacing per row
```

### Add Custom Branding

Add your server's logo:
```javascript
const logo = createCanvas(64, 64);
// ...draw logo...
ctx.drawImage(logo, padding, padding);
```
