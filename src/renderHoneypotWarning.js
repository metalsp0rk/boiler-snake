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
 * Text lives in the image (not plain message content) so simplistic scrapers miss it.
 * @returns {Buffer}
 */
function renderHoneypotWarningPng() {
  const width = 720;
  const height = 360;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Backdrop
  ctx.fillStyle = "#0a0a0c";
  ctx.fillRect(0, 0, width, height);

  // Dim vignette
  const grad = ctx.createRadialGradient(width / 2, height / 2, 40, width / 2, height / 2, width * 0.7);
  grad.addColorStop(0, "rgba(237, 66, 69, 0.18)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Modal card
  const mx = 48;
  const my = 36;
  const mw = width - mx * 2;
  const mh = height - my * 2;
  const radius = 16;

  // Card shadow
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  roundRect(ctx, mx + 6, my + 8, mw, mh, radius);
  ctx.fill();

  // Card body
  const cardGrad = ctx.createLinearGradient(mx, my, mx, my + mh);
  cardGrad.addColorStop(0, "#1a1214");
  cardGrad.addColorStop(1, "#12090b");
  ctx.fillStyle = cardGrad;
  roundRect(ctx, mx, my, mw, mh, radius);
  ctx.fill();

  // Red border
  ctx.strokeStyle = "#ed4245";
  ctx.lineWidth = 3;
  roundRect(ctx, mx, my, mw, mh, radius);
  ctx.stroke();

  // Top accent bar
  ctx.fillStyle = "#ed4245";
  roundRectTop(ctx, mx, my, mw, 10, radius);
  ctx.fill();

  // Icon circle
  const cx = width / 2;
  const cy = my + 78;
  ctx.beginPath();
  ctx.arc(cx, cy, 36, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(237, 66, 69, 0.2)";
  ctx.fill();
  ctx.strokeStyle = "#ed4245";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = "#ed4245";
  ctx.font = `bold 42px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", cx, cy + 2);

  // Title
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 32px ${FONT_STACK}`;
  ctx.fillText("DO NOT POST HERE", cx, cy + 72);

  // Subtitle
  ctx.fillStyle = "#f2a0a2";
  ctx.font = `bold 20px ${FONT_STACK}`;
  ctx.fillText("Restricted channel — human notice", cx, cy + 108);

  // Body lines
  ctx.fillStyle = "#d4d4d8";
  ctx.font = `18px ${FONT_STACK}`;
  const lines = [
    "Any message sent in this channel will result in",
    "an immediate permanent ban from this server.",
    "",
    "If you can read this, leave without posting.",
  ];
  let y = cy + 148;
  for (const line of lines) {
    ctx.fillText(line, cx, y);
    y += 26;
  }

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

module.exports = { renderHoneypotWarningPng };
