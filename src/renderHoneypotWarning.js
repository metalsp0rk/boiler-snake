// src/renderHoneypotWarning.js
const { createCanvas } = require("@napi-rs/canvas");

const FONT_STACK = [
  '"Noto Sans"',
  '"DejaVu Sans"',
  "system-ui",
  "-apple-system",
  '"Segoe UI"',
  "Roboto",
  "Arial",
  "sans-serif",
].join(", ");

/**
 * Render a modal-style honeypot warning as a PNG buffer.
 * All human-readable text lives in the image so scrapers that only
 * read message/embed text get nothing useful.
 * @returns {Buffer}
 */
function renderHoneypotWarningPng() {
  const width = 800;
  // ~1.5 body lines taller so the footer strip doesn't collide with gray copy
  const height = 522;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Backdrop
  ctx.fillStyle = "#07070a";
  ctx.fillRect(0, 0, width, height);

  // Soft red glow behind the card
  const glow = ctx.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, width * 0.55);
  glow.addColorStop(0, "rgba(237, 66, 69, 0.22)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // Modal card
  const mx = 40;
  const my = 32;
  const mw = width - mx * 2;
  const mh = height - my * 2;
  const radius = 18;

  // Drop shadow
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  roundRect(ctx, mx + 8, my + 10, mw, mh, radius);
  ctx.fill();

  // Card body
  const cardGrad = ctx.createLinearGradient(mx, my, mx, my + mh);
  cardGrad.addColorStop(0, "#1c1215");
  cardGrad.addColorStop(0.5, "#140c0e");
  cardGrad.addColorStop(1, "#0f090a");
  ctx.fillStyle = cardGrad;
  roundRect(ctx, mx, my, mw, mh, radius);
  ctx.fill();

  // Red border
  ctx.strokeStyle = "#ed4245";
  ctx.lineWidth = 3.5;
  roundRect(ctx, mx, my, mw, mh, radius);
  ctx.stroke();

  // Top accent bar
  ctx.fillStyle = "#ed4245";
  roundRectTop(ctx, mx, my, mw, 12, radius);
  ctx.fill();

  const cx = width / 2;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Warning icon circle
  const iconY = my + 72;
  ctx.beginPath();
  ctx.arc(cx, iconY, 34, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(237, 66, 69, 0.18)";
  ctx.fill();
  ctx.strokeStyle = "#ed4245";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = "#ed4245";
  ctx.font = `bold 40px ${FONT_STACK}`;
  ctx.fillText("!", cx, iconY + 2);

  // Primary headline — large
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 48px ${FONT_STACK}`;
  ctx.fillText("DO NOT POST HERE", cx, iconY + 78);

  // Thin divider under headline
  const divY = iconY + 108;
  const divW = 280;
  ctx.strokeStyle = "rgba(237, 66, 69, 0.65)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - divW / 2, divY);
  ctx.lineTo(cx + divW / 2, divY);
  ctx.stroke();

  // Honeypot label — medium/smaller
  ctx.fillStyle = "#f2a0a2";
  ctx.font = `bold 22px ${FONT_STACK}`;
  ctx.fillText("This is a honeypot channel.", cx, divY + 36);

  // Body copy — smaller, all warning detail lives in the image
  ctx.fillStyle = "#d4d4d8";
  ctx.font = `18px ${FONT_STACK}`;
  const bodyLines = [
    "This channel is a decoy used to catch spam accounts and raiders.",
    "Any message sent here results in an immediate permanent ban",
    "from this server.",
    "",
    "If you can read this notice, leave without posting.",
    "Staff with exempt roles will not be banned.",
  ];

  let y = divY + 78;
  for (const line of bodyLines) {
    if (line === "") {
      y += 12;
      continue;
    }
    ctx.fillText(line, cx, y);
    y += 28;
  }

  // Bottom strip emphasis
  const stripH = 44;
  const stripY = my + mh - stripH;
  ctx.fillStyle = "rgba(237, 66, 69, 0.16)";
  roundRectBottom(ctx, mx + 2, stripY, mw - 4, stripH - 2, radius - 2);
  ctx.fill();

  ctx.fillStyle = "#ed4245";
  ctx.font = `bold 16px ${FONT_STACK}`;
  ctx.fillText("POSTING HERE = INSTANT BAN", cx, stripY + stripH / 2 - 1);

  return canvas.toBuffer("image/png");
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function roundRectTop(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function roundRectBottom(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.lineTo(x, y);
  ctx.closePath();
}

module.exports = { renderHoneypotWarningPng };
