/**
 * HTML transcript render + filesystem paths for archived tickets.
 *
 * Layout (current):
 *   {DATA_DIR}/ticket-transcripts/{guild_id}/{token}/index.html
 *   {DATA_DIR}/ticket-transcripts/{guild_id}/{token}/assets/*
 *
 * Legacy (still readable):
 *   {DATA_DIR}/ticket-transcripts/{guild_id}/{token}.html
 */

const fs = require("fs");
const { formatTicketRef } = require("../../core/theme");
const path = require("path");
const { dataDir } = require("../../db/connection");
const { parseAttachmentList, mediaKind } = require("./assets");

/**
 * Absolute directory for a guild's transcripts.
 * @param {string} guildId
 * @returns {string}
 */
function transcriptDir(guildId) {
  return path.join(dataDir, "ticket-transcripts", String(guildId));
}

/**
 * Absolute directory for one transcript token (html + assets).
 * @param {string} guildId
 * @param {string} token
 * @returns {string}
 */
function absoluteTranscriptBundleDir(guildId, token) {
  return path.join(transcriptDir(guildId), String(token));
}

/**
 * Absolute assets directory.
 * @param {string} guildId
 * @param {string} token
 * @returns {string}
 */
function absoluteAssetsDir(guildId, token) {
  return path.join(absoluteTranscriptBundleDir(guildId, token), "assets");
}

/**
 * Relative path stored in DB (under DATA_DIR) — nested index.html.
 * @param {string} guildId
 * @param {string} token
 * @returns {string}
 */
function relativeTranscriptPath(guildId, token) {
  return path.join(
    "ticket-transcripts",
    String(guildId),
    String(token),
    "index.html",
  );
}

/**
 * Absolute path for the HTML file (nested layout).
 * @param {string} guildId
 * @param {string} token
 * @returns {string}
 */
function absoluteTranscriptPath(guildId, token) {
  return path.join(absoluteTranscriptBundleDir(guildId, token), "index.html");
}

/**
 * Escape text for HTML.
 * @param {string|null|undefined} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function formatTs(ms) {
  if (ms == null) return "—";
  try {
    return new Date(Number(ms)).toISOString();
  } catch {
    return "—";
  }
}

/**
 * Render attachment / media block for one message.
 * @param {object[]} attachments
 * @returns {string}
 */
function renderAttachmentsHtml(attachments) {
  if (!attachments?.length) return "";
  const parts = attachments.map((a) => {
    const href = a.href || a.url || "";
    const name = a.name || href || "attachment";
    const kind = a.kind || mediaKind(name, a.contentType);
    if (!href) return "";

    if (kind === "image") {
      return `<figure class="att image">
        <a href="${escapeHtml(href)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(href)}" alt="${escapeHtml(name)}" loading="lazy"/>
        </a>
        <figcaption><a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></figcaption>
      </figure>`;
    }
    if (kind === "video") {
      return `<div class="att video">
        <video controls preload="metadata" src="${escapeHtml(href)}"></video>
        <div><a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></div>
      </div>`;
    }
    if (kind === "audio") {
      return `<div class="att audio">
        <audio controls preload="metadata" src="${escapeHtml(href)}"></audio>
        <div><a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></div>
      </div>`;
    }
    return `<div class="att file"><a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(name)}</a></div>`;
  });
  return `<div class="attachments">${parts.join("\n")}</div>`;
}

/**
 * @param {object} ticket
 * @param {object[]} messages  rows from ticket_messages or fetch shape
 * @param {object} [meta]
 * @param {string} [meta.guildName]
 * @param {string} [meta.requesterLabel]
 * @param {string} [meta.staffOwnerLabel]
 * @param {string} [meta.closedByLabel]
 * @param {string|null} [meta.closeReason]
 * @param {number|null} [meta.closedAt]
 * @param {string} [meta.token] transcript token (for absolute asset links)
 * @returns {string} HTML document
 */
function renderTranscriptHtml(ticket, messages, meta = {}) {
  const title = `Ticket ${formatTicketRef(ticket.ticket_number)}`;
  const guildName = meta.guildName || ticket.guild_id;
  const requesterLabel = meta.requesterLabel || ticket.creator_user_id || "—";
  const staffOwnerLabel =
    meta.staffOwnerLabel ||
    (ticket.staff_owner_id ? String(ticket.staff_owner_id) : "—");
  const closedByLabel = meta.closedByLabel || null;

  const rows = (messages || [])
    .map((m) => {
      const attachments = parseAttachmentList(m.attachment_urls);
      const attHtml = renderAttachmentsHtml(attachments);
      const authorLabel = m.author_tag || m.author_id || "unknown";
      return `
      <div class="msg">
        <div class="meta">
          <span class="author">${escapeHtml(authorLabel)}</span>
          <span class="time">${escapeHtml(formatTs(m.sent_at))}</span>
          <span class="id">#${escapeHtml(m.message_id)}</span>
        </div>
        <div class="content">${escapeHtml(m.content || "").replace(/\n/g, "<br/>") || "<em>(empty)</em>"}</div>
        ${attHtml}
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} — ${escapeHtml(guildName)}</title>
<style>
  :root { color-scheme: dark light; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 1.5rem auto; padding: 0 1rem; line-height: 1.45; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .header { border-bottom: 1px solid #5553; padding-bottom: 1rem; margin-bottom: 1rem; }
  .header dl { display: grid; grid-template-columns: 10rem 1fr; gap: 0.25rem 0.75rem; font-size: 0.9rem; }
  .header dt { font-weight: 600; opacity: 0.8; }
  .msg { border: 1px solid #5553; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.6rem 0; }
  .meta { font-size: 0.8rem; opacity: 0.75; margin-bottom: 0.35rem; display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .author { font-weight: 600; opacity: 1; }
  .content { white-space: normal; word-break: break-word; }
  .attachments { margin-top: 0.65rem; display: flex; flex-direction: column; gap: 0.75rem; }
  .att img { max-width: min(100%, 520px); height: auto; border-radius: 6px; display: block; }
  .att video { max-width: min(100%, 520px); border-radius: 6px; display: block; }
  .att audio { width: min(100%, 420px); }
  .att figcaption, .att a { font-size: 0.85rem; word-break: break-all; }
  footer { margin-top: 2rem; font-size: 0.75rem; opacity: 0.6; }
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(title)}</h1>
    <p>Staff transcript · ${escapeHtml(guildName)}</p>
    <dl>
      <dt>Requester</dt><dd>${escapeHtml(requesterLabel)}</dd>
      <dt>Staff owner</dt><dd>${escapeHtml(staffOwnerLabel)}</dd>
      ${
        closedByLabel
          ? `<dt>Closed by</dt><dd>${escapeHtml(closedByLabel)}</dd>`
          : ""
      }
      <dt>Opened</dt><dd>${escapeHtml(formatTs(ticket.created_at))}</dd>
      <dt>Closed</dt><dd>${escapeHtml(formatTs(ticket.closed_at || meta.closedAt))}</dd>
      <dt>Reason</dt><dd>${escapeHtml(ticket.reason || "—")}</dd>
      <dt>Close reason</dt><dd>${escapeHtml(ticket.close_reason || meta.closeReason || "—")}</dd>
      <dt>Messages</dt><dd>${messages?.length ?? 0}</dd>
      <dt>Sensitive</dt><dd>${Number(ticket.is_sensitive) ? "yes (should not appear)" : "no"}</dd>
    </dl>
  </div>
  <div class="messages">
    ${rows || "<p><em>No messages archived.</em></p>"}
  </div>
  <footer>Generated by Boiler Snake · do not share publicly</footer>
</body>
</html>`;
}

/**
 * Write HTML to disk; returns relative path under DATA_DIR.
 * @param {object} ticket
 * @param {string} token
 * @param {object[]} messages
 * @param {object} [meta]
 * @returns {{ relativePath: string, absolutePath: string }}
 */
function writeTranscriptFile(ticket, token, messages, meta = {}) {
  const abs = absoluteTranscriptPath(ticket.guild_id, token);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const html = renderTranscriptHtml(ticket, messages, { ...meta, token });
  fs.writeFileSync(abs, html, "utf8");
  return {
    relativePath: relativeTranscriptPath(ticket.guild_id, token),
    absolutePath: abs,
  };
}

/**
 * Resolve absolute path from a ticket row (nested or legacy flat).
 * @param {object} ticket
 * @returns {string|null}
 */
function resolveTranscriptAbsolutePath(ticket) {
  if (!ticket?.transcript_path && !ticket?.transcript_token) return null;

  if (ticket.transcript_token) {
    const nested = absoluteTranscriptPath(
      ticket.guild_id,
      ticket.transcript_token,
    );
    if (fs.existsSync(nested)) return nested;

    // Legacy flat file
    const flat = path.join(
      transcriptDir(ticket.guild_id),
      `${ticket.transcript_token}.html`,
    );
    if (fs.existsSync(flat)) return flat;
  }

  if (ticket.transcript_path) {
    const abs = path.isAbsolute(ticket.transcript_path)
      ? ticket.transcript_path
      : path.join(dataDir, ticket.transcript_path);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

module.exports = {
  transcriptDir,
  absoluteTranscriptBundleDir,
  absoluteAssetsDir,
  relativeTranscriptPath,
  absoluteTranscriptPath,
  escapeHtml,
  renderTranscriptHtml,
  writeTranscriptFile,
  resolveTranscriptAbsolutePath,
};
