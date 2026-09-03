// src/renderLeaderboard.js
const { createCanvas } = require("@napi-rs/canvas");

// Font stack with broad Unicode coverage (install at least one of these on the host):
// - fonts-noto (Noto Sans + Symbols)
// - fonts-dejavu
// - (optional) fonts-noto-color-emoji
// This prevents "tofu" (\u25A1) blocks for nicknames containing uncommon Unicode.
const FONT_STACK = [
  '"Noto Sans"',
  '"Noto Sans Symbols2"',
  '"Noto Sans Symbols"',
  '"Noto Sans Math"',
  '"DejaVu Sans"',
  '"Segoe UI Symbol"',
  '"Apple Color Emoji"',
  '"Noto Color Emoji"',
  '"Twemoji Mozilla"',
  'system-ui',
  '-apple-system',
  '"Segoe UI"',
  'Roboto',
  'Arial',
  'sans-serif',
].join(", ");

function sanitizeDisplayName(name) {
  const raw = String(name ?? "");
  // Remove control chars + bidi controls that can break rendering or spoof text.
  // Also collapse whitespace/newlines.
  const cleaned = raw
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned.length ? cleaned : "—";
}

/**
 * Render a leaderboard as a PNG buffer (dark theme + Boiler Snake colors).
 *
 * entries: Array<{ rank: number, name: string, xp: number, level: number }>
 * factor: number (XP curve factor, default 100). XP needed for level L is L^2 * factor.
 * subtitle: optional header subtitle (default: "Top {rows} by XP • Quantum-approved").
 *
 * Renders as many rows as provided (capped at 20) so pages can have varying sizes.
 *
 * Returns: Buffer (PNG)
 */
function renderLeaderboardPng(entries, factor = 100, subtitle = null) {
    const MAX_ROWS = 20;
    const top = entries.slice(0, MAX_ROWS);
    const ROW_COUNT = top.length;

    // Layout
    const width = 900;
    const padding = 28;

    const headerH = 110;

    // Row block
    const rowStep = 70;   // vertical step per row (spacing)
    const rowBoxH = 56;   // actual row rectangle height
    const gapAfterHeader = 22;

    // Extra safe space at bottom so Discord preview doesn't clip
    const bottomPad = 56;

    const height =
    padding +
    headerH +
    gapAfterHeader +
    ROW_COUNT * rowStep +
    bottomPad;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    // Theme colors (match logo vibe: cyan + green on dark)
    const bg0 = "#070A12";
    const bg1 = "#0B1224";
    const panel = "#0F1A33";
    const panelEdge = "rgba(0, 220, 255, 0.22)";
    const text = "#EAF2FF";
    const subtext = "rgba(234, 242, 255, 0.72)";
    const cyan = "#00D8FF";
    const green = "#57FF9A";

    // Trophy colors
    const gold = "#F6C453";
    const silver = "#C9D1D9";
    const bronze = "#C67C4E";

    // Helpers
    const roundRect = (x, y, w, h, r) => {
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    };

    const drawGlowLine = (x1, y1, x2, y2, color, widthPx, blur) => {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = widthPx;
        ctx.shadowColor = color;
        ctx.shadowBlur = blur;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
    };

    const measureFitText = (str, maxW, font) => {
        const input = sanitizeDisplayName(str);
        ctx.font = font;
        if (ctx.measureText(input).width <= maxW) return input;

        // Split by Unicode codepoints so we don't chop surrogate pairs (emoji, some symbols)
        const cps = Array.from(input);
        let hi = cps.length;
        // Fast-ish: binary search the max prefix that fits
        let lo = 0;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const candidate = cps.slice(0, mid).join("") + "…";
            if (ctx.measureText(candidate).width <= maxW) lo = mid;
            else hi = mid - 1;
        }
        const prefixLen = Math.max(1, lo);
        return cps.slice(0, prefixLen).join("") + "…";
    };

    /**
     * Draw a simple vector trophy icon (no asset needed).
     * x,y is center.
     */
    const drawTrophy = (x, y, rank) => {
        let fill = null;
        if (rank === 1) fill = gold;
        else if (rank === 2) fill = silver;
        else if (rank === 3) fill = bronze;
        else return;

        ctx.save();
        ctx.translate(x, y);

        // glow
        ctx.shadowColor = fill;
        ctx.shadowBlur = 18;

        // cup
        ctx.fillStyle = fill;
        ctx.beginPath();
        // Cup body (rounded trapezoid)
        ctx.moveTo(-14, -14);
        ctx.lineTo(14, -14);
        ctx.quadraticCurveTo(16, -14, 15, -10);
        ctx.lineTo(10, 2);
        ctx.quadraticCurveTo(0, 10, -10, 2);
        ctx.lineTo(-15, -10);
        ctx.quadraticCurveTo(-16, -14, -14, -14);
        ctx.closePath();
        ctx.fill();

        // handles
        ctx.shadowBlur = 10;
        ctx.beginPath();
        // left handle
        ctx.moveTo(-14, -12);
        ctx.quadraticCurveTo(-24, -10, -20, -2);
        ctx.quadraticCurveTo(-17, 4, -11, 2);
        ctx.quadraticCurveTo(-15, 2, -16, -2);
        ctx.quadraticCurveTo(-19, -8, -14, -10);
        ctx.closePath();
        ctx.fill();

        ctx.beginPath();
        // right handle
        ctx.moveTo(14, -12);
        ctx.quadraticCurveTo(24, -10, 20, -2);
        ctx.quadraticCurveTo(17, 4, 11, 2);
        ctx.quadraticCurveTo(15, 2, 16, -2);
        ctx.quadraticCurveTo(19, -8, 14, -10);
        ctx.closePath();
        ctx.fill();

        // stem
        ctx.shadowBlur = 0;
        ctx.fillStyle = fill;
        roundRect(-5, 8, 10, 8, 3);
        ctx.fill();

        // base
        ctx.fillStyle = "#0A0F1E";
        roundRect(-16, 16, 32, 10, 4);
        ctx.fill();

        // rank number on cup
        ctx.fillStyle = "#0A0F1E";
        ctx.font = `900 12px ${FONT_STACK}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(rank), 0, -4);

        ctx.restore();
    };

    /**
     * Compute progress within the current level toward next level.
     * Uses: startXP = L^2 * factor; nextXP = (L+1)^2 * factor
     */
    const levelProgress = (xp, lvl) => {
        const L = Math.max(0, Math.floor(lvl));
        const startXP = L * L * factor;
        const nextXP = (L + 1) * (L + 1) * factor;
        const denom = Math.max(1, nextXP - startXP);
        const raw = (xp - startXP) / denom;
        return Math.max(0, Math.min(1, raw));
    };

    // Background gradient
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, bg0);
    g.addColorStop(1, bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);

    // Header panel
    const headerX = padding;
    const headerY = padding;
    const headerW = width - padding * 2;

    roundRect(headerX, headerY, headerW, headerH, 22);
    ctx.fillStyle = panel;
    ctx.fill();

    // Header edge glow
    ctx.save();
    ctx.strokeStyle = panelEdge;
    ctx.lineWidth = 2;
    ctx.shadowColor = cyan;
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.restore();

    // Accent lines
    drawGlowLine(
        headerX + 22,
        headerY + headerH - 18,
        headerX + headerW - 22,
        headerY + headerH - 18,
        "rgba(0,216,255,0.35)",
                 2,
                 10
    );
    drawGlowLine(
        headerX + 22,
        headerY + headerH - 16,
        headerX + headerW - 22,
        headerY + headerH - 16,
        "rgba(87,255,154,0.22)",
                 2,
                 10
    );

    // Title
    ctx.save();
    ctx.fillStyle = text;
    ctx.font = `800 34px ${FONT_STACK}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText("Boiler Snake Leaderboard", headerX + 28, headerY + 22);

    // Subtitle
    const subtitleText =
      subtitle ?? `Top ${ROW_COUNT} by XP • Quantum-approved`;
    ctx.fillStyle = subtext;
    ctx.font = `500 16px ${FONT_STACK}`;
    ctx.fillText(subtitleText, headerX + 30, headerY + 62);
    ctx.restore();

    // Rows
    const startY = headerY + headerH + gapAfterHeader;

    // Right-side text block width reservation so bars never collide with XP/Lvl
    const rightTextPad = 22;
    const rightTextBlockW = 140; // reserved for "99999 XP" + "Lvl 99"

    // Bar placement: left-shift and constrained
    const barShiftLeft = 30;

    for (let i = 0; i < ROW_COUNT; i++) {
        const entry = top[i] || { rank: i + 1, name: "—", xp: 0, level: 0 };
        const rowX = padding;
        const rowY = startY + i * rowStep;
        const rowW = width - padding * 2;

        // Row background
        roundRect(rowX, rowY, rowW, rowBoxH, 18);
        ctx.fillStyle = i % 2 === 0 ? "rgba(15,26,51,0.86)" : "rgba(12,20,40,0.84)";
        ctx.fill();

        // Subtle edge
        ctx.save();
        ctx.strokeStyle = "rgba(0, 216, 255, 0.10)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        const leftPad = rowX + 22;
        const midY = rowY + rowBoxH / 2;

        // Trophy / rank
        if (entry.rank <= 3) {
            drawTrophy(leftPad + 20, midY, entry.rank);
        } else {
            ctx.save();
            ctx.fillStyle = "rgba(234, 242, 255, 0.65)";
            ctx.font = `700 16px ${FONT_STACK}`;
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(`${entry.rank}.`, leftPad + 8, midY);
            ctx.restore();
        }

        // Name (truncate to fit)
        const nameX = leftPad + 64;
        const nameMaxW = rowW * 0.46;

        ctx.save();
        ctx.fillStyle = text;
        ctx.font = `800 18px ${FONT_STACK}`;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const safeName = measureFitText(sanitizeDisplayName(entry.name), nameMaxW, ctx.font);
        ctx.fillText(safeName, nameX, midY);
        ctx.restore();

        // XP text
        const xpText = `${entry.xp} XP`;
        ctx.save();
        ctx.fillStyle = "rgba(234, 242, 255, 0.86)";
        ctx.font = `700 16px ${FONT_STACK}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(xpText, rowX + rowW - rightTextPad, midY - 9);
        ctx.restore();

        // Level text
        const lvlText = `Lvl ${entry.level}`;
        ctx.save();
        ctx.fillStyle = "rgba(234, 242, 255, 0.70)";
        ctx.font = `600 14px ${FONT_STACK}`;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(lvlText, rowX + rowW - rightTextPad, midY + 12);
        ctx.restore();

        // XP bar = progress within current level toward next level
        const barH = 10;
        const barY = rowY + rowBoxH - 14;

        const barXBase = rowX + rowW * 0.60 - barShiftLeft;
        const barRightLimit = rowX + rowW - rightTextPad - rightTextBlockW;

        const barW = Math.max(80, barRightLimit - barXBase);
        const barX = barXBase;

        // track
        ctx.save();
        roundRect(barX, barY, barW, barH, 6);
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        ctx.fill();

        // fill based on progress to next level
        const pct = levelProgress(entry.xp || 0, entry.level || 0);
        const fillW = Math.max(0, Math.floor(barW * pct));

        const barGrad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        barGrad.addColorStop(0, cyan);
        barGrad.addColorStop(1, green);

        roundRect(barX, barY, fillW, barH, 6);
        ctx.fillStyle = barGrad;
        ctx.shadowColor = cyan;
        ctx.shadowBlur = 10;
        ctx.fill();

        ctx.restore();
    }

    return canvas.toBuffer("image/png");
}

module.exports = { renderLeaderboardPng };
