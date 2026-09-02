/**
 * Shared visual language for bot messages and embeds.
 *
 * Prefer these tokens over local hex constants so staff, public, and audit
 * surfaces read as one product.
 */

const { EmbedBuilder } = require("discord.js");

/** Semantic embed colors */
const Color = {
  /** Default brand / info / neutral product embeds */
  brand: 0x5865f2,
  /** Created, opened, granted, success */
  success: 0x57f287,
  /** Warnings issued, sensitive, deletes, danger */
  danger: 0xe74c3c,
  /** Needs attention (active warning detail) — not "updated" */
  caution: 0xfaa61a,
  /** Voided, closed, deleted, removed */
  muted: 0x95a5a6,
  /** Admin reconfiguration audit */
  config: 0x9b59b6,
  /** Analytics / activity */
  accent: 0x1abc9c,
  /** Kick audit */
  kick: 0xe67e22,
  /** Ban audit */
  ban: 0x8b0000,
  /** Honeypot-specific ban audit */
  honeypot: 0x922b21,
  /** Bulk message delete */
  bulkDelete: 0xc0392b,
  /** Mixed role changes */
  mixed: 0x3498db,
  /** YouTube live */
  youtubeLive: 0xff0000,
  /** YouTube upload */
  youtubeUpload: 0xffa500,
  /** Music player now-playing / queue (Spotify catalog branding) */
  music: 0x1db954,
};

/** Standard permission denial (straight apostrophe). */
const MSG_DENIED = "You don't have permission to use this.";

/** Default ephemeral error when a handler throws. */
const MSG_GENERIC_ERROR =
  "Something went wrong handling that command (check bot logs).";

// ---------- Discord timestamps ----------

/**
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function tsRelative(ms) {
  if (ms == null) return "—";
  const sec = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(sec)) return "—";
  return `<t:${sec}:R>`;
}

/**
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function tsFull(ms) {
  if (ms == null) return "—";
  const sec = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(sec)) return "—";
  return `<t:${sec}:F>`;
}

/**
 * Short date/time (`:f`).
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function tsShort(ms) {
  if (ms == null) return "—";
  const sec = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(sec)) return "—";
  return `<t:${sec}:f>`;
}

/**
 * Full + relative: `<t:…:F> (<t:…:R>)`
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function tsBoth(ms) {
  if (ms == null) return "—";
  const sec = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(sec)) return "—";
  return `<t:${sec}:F> (<t:${sec}:R>)`;
}

/**
 * Relative first, then full: `<t:…:R> · <t:…:F>`
 * @param {number|null|undefined} ms
 * @returns {string}
 */
function tsRelativeFull(ms) {
  if (ms == null) return "—";
  const sec = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(sec)) return "—";
  return `<t:${sec}:R> · <t:${sec}:F>`;
}

// ---------- Entity refs ----------

/**
 * @param {number|string} n
 * @returns {string}
 */
function formatNoteRef(n) {
  return `N-${n}`;
}

/**
 * @param {number|string} n
 * @returns {string}
 */
function formatWarnRef(n) {
  return `W-${n}`;
}

/**
 * Ticket display ref (`#12`). Prefer this over raw string concat.
 * @param {number|string} n
 * @returns {string}
 */
function formatTicketRef(n) {
  return `#${n}`;
}

// ---------- Embed factory ----------

/**
 * Build a themed EmbedBuilder with common chrome applied.
 *
 * @param {object} [opts]
 * @param {number} [opts.color=Color.brand]
 * @param {string} [opts.title]
 * @param {string} [opts.description]
 * @param {string} [opts.footer]
 * @param {boolean|Date|number} [opts.timestamp] true = now; Date/ms = that time
 * @returns {EmbedBuilder}
 */
function baseEmbed(opts = {}) {
  const embed = new EmbedBuilder().setColor(
    opts.color != null ? opts.color : Color.brand
  );
  if (opts.title != null && opts.title !== "") {
    embed.setTitle(String(opts.title).slice(0, 256));
  }
  if (opts.description != null && opts.description !== "") {
    embed.setDescription(String(opts.description).slice(0, 4096));
  }
  if (opts.footer != null && opts.footer !== "") {
    embed.setFooter({ text: String(opts.footer).slice(0, 2048) });
  }
  if (opts.timestamp === true) {
    embed.setTimestamp(new Date());
  } else if (opts.timestamp instanceof Date) {
    embed.setTimestamp(opts.timestamp);
  } else if (
    opts.timestamp != null &&
    opts.timestamp !== false &&
    Number.isFinite(Number(opts.timestamp))
  ) {
    embed.setTimestamp(new Date(Number(opts.timestamp)));
  }
  return embed;
}

/**
 * Truncate a string for embed field values (Discord max 1024).
 * @param {string} s
 * @param {number} [max=1024]
 * @returns {string}
 */
function truncateField(s, max = 1024) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  if (max <= 1) return "…";
  return `${str.slice(0, max - 1)}…`;
}

/**
 * Truncate for embed description (max 4096).
 * @param {string} s
 * @param {number} [max=4096]
 * @returns {string}
 */
function truncateDescription(s, max = 4096) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  if (max <= 1) return "…";
  return `${str.slice(0, max - 1)}…`;
}

module.exports = {
  Color,
  MSG_DENIED,
  MSG_GENERIC_ERROR,
  tsRelative,
  tsFull,
  tsShort,
  tsBoth,
  tsRelativeFull,
  formatNoteRef,
  formatWarnRef,
  formatTicketRef,
  baseEmbed,
  truncateField,
  truncateDescription,
};
