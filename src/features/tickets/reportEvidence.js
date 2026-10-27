/**
 * Evidence message builder for the "Report Post" flow (#745 — locked
 * decisions 4, 13, 15).
 *
 * Takes the invoke-time snapshot from ./pendingReports.js (metadata only —
 * decision 3) and turns it into the Discord message the modal handler (subtask
 * 08) posts into the fresh ticket: a header embed (reporter, source channel +
 * jump link, message author, message id, capture timestamp, reporter's
 * context note, embed/sticker text metadata, the decision-13 disposition
 * line), the escaped message content split across embeds, and the attachment
 * BYTES re-uploaded as files (images inline via `attachment://`, everything
 * else playable attachments). URLs are still alive at this point — the
 * deletion only happens AFTER a successful evidence post (decision 4).
 *
 * Service contract (error rule 6 — nothing here replies to Discord and
 * nothing here throws uncaught):
 * - `{ ok: true, embeds, files, warnings }` on success. `embeds` is an array
 *   of discord.js `EmbedBuilder`s (1–10, Discord's per-message cap), `files`
 *   entries are `{ attachment: Buffer, name: string }` exactly as
 *   `MessageOptions.files` wants them, `warnings` are human-readable lines
 *   (every unrecovered file lands there, plus cap notes). The CALLER decides
 *   what to do with warnings before it dares to delete — never this module.
 * - `{ ok: false, error }` for a structurally broken snapshot (missing
 *   reporter/message/channel/guild id, wrong kind) or an unforeseen internal
 *   failure (logged with ids, error rule 2). The caller SKIPS the delete on
 *   `ok: false` — that gate IS the safety design (decision 4).
 * - Per-file problems never abort the build (error rule 5): every failed
 *   fetch becomes one warning line naming the file, its size, the specific
 *   reason, and the phrase "may not survive deletion" — while every other
 *   file still ships.
 *
 * Markdown safety (member-influenced text is hostile):
 * - Free text (message content, reporter context) renders INSIDE fenced code
 *   blocks. The fence is longer than the longest backtick run in that chunk,
 *   so the chunk can never close its own fence — and Discord never pings on
 *   mentions inside code blocks. That is the ping-proofness guarantee; the
 *   raw planted `<@id>` stays byte-visible as evidence but cannot ping.
 * - Short metadata lines (channel name, sticker names, embed URLs, file
 *   names) go through `inlineEscape` (backslash before every markdown/mention
 *   marker) — visible as `\<@123>` in the raw string, rendered as `<@123>`.
 * - The ONLY live mentions are the bot-built reporter/author pings and the
 *   decision-13 disposition line — they exist precisely to record which staff
 *   member triggered the deletion (the Discord audit log shows only "bot").
 *
 * Size model (every Discord embed limit honored, no send-time 400s):
 * - chunk budget 3800 chars leaves room (with a pathological fence) under
 *   the 4096-per-embed cap; split parts are labeled `(i/N)`.
 * - the whole embed set stays under EVIDENCE_MESSAGE_CHAR_BUDGET (5850 of
 *   Discord's 6000-char ACROSS-EMBED cap) and ≤ 10 embeds. Over either: the
 *   message content is attached in full as a .txt file (decision 15's
 *   fallback) with a pointer line in the header; then the reporter context
 *   gets the same treatment; then trailing image inlines demote to plain
 *   file entries. The bytes always ship — only presentation degrades.
 *
 * Test seams: `fetchImpl` / `resolveHost` reach the shared SSRF guard
 * (src/core/ssrfGuard.js — ticket media URLs are member-authored, so the
 * audit-C5 posture applies here too: https-only, per-hop address checks,
 * pinned sockets in production). Default transport is the guard's own
 * pinned fetch, not raw `globalThis.fetch`; `maxBytesPerFile` overrides the
 * per-file copy budget (EVIDENCE_MAX_BYTES, 10 MiB — a chat-window cap, not
 * an archive budget; the archive mirror keeps its own 50 MiB policy).
 */

const { EmbedBuilder } = require("discord.js");
const { buildMessageJumpUrl } = require("../../core/jumpUrl");
const { Color, tsFull, truncateDescription, truncateField } = require("../../core/theme");
const { joinCapped, safeCutIndex, sliceSafe } = require("../../core/text");
const { downloadGuarded } = require("../../core/ssrfGuard");
const { sanitizeFilename, mediaKind } = require("./assets");

/** Default per-file copy budget for evidence re-upload (10 MiB). */
const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Max raw chars per content/context embed part ("~3900" per decision 15).
 * 3800 + a pathological fence + the `(i/N)` title stays under the 4096
 * per-embed cap; over-budget content takes the .txt fallback instead.
 */
const EVIDENCE_CHUNK_CHARS = 3800;

/** Discord's per-message embed cap (header + context + content + images). */
const EVIDENCE_MAX_EMBEDS = 10;

/** Safety margin under Discord's 6000-char ACROSS-EMBED cap (#446 style). */
const EVIDENCE_MESSAGE_CHAR_BUDGET = 5850;

/** Discord's per-embed cap (title + fields + description + footer). */
const EVIDENCE_EMBED_CHAR_MAX = 4096;

/** Hard caps on how many metadata lines the header block shows each. */
const EVIDENCE_EMBED_URL_LINES = 12;
const EVIDENCE_STICKER_LINES = 12;

/** Files fetched at all — beyond this, the rest is metadata only (#446). */
const EVIDENCE_MAX_FILES = 10;

/** Snowflake-shaped ids may render as a live mention / jump link. */
const SNOWFLAKE_RE = /^[0-9]{1,25}$/;

/** Exact phrase every unrecovered-file warning carries (locked decision 4). */
const MAY_NOT_SURVIVE = "may not survive deletion";

/** CDN user agent, same convention as assets.js downloadUrlToFile. */
const EVIDENCE_USER_AGENT = "BoilerSnake-TicketEvidence/1.0";

/**
 * Tolerant id coercion — the same rule as pendingReports.js `toId` (empty
 * strings and `0` carry no identity). Kept local: the store does not export
 * its private helpers and this module must not invent an import surface.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toId(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value ? String(value) : null;
  }
  return null;
}

/**
 * Tolerant text coercion (string|number|bigint → string, else null) — same
 * rule as pendingReports.js `toText`.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function toText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

/**
 * Byte copy for warning lines. Mirrors the private `formatBytes` in
 * assets.js; assets.js does not export it and this file is the only other
 * byte-warning site in the feature (do not fork a THIRD copy — export from
 * assets.js if a third appears).
 *
 * @param {number} n
 * @returns {string}
 */
function formatBytesLocal(n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MiB`;
  return `${Math.max(1, Math.round(n / 1024))} KiB`;
}

/**
 * Backslash-escape every Discord markdown / mention marker in a SHORT
 * single-line string. Rendered text is unchanged; the raw string keeps the
 * backslashes, which is what makes the inertness test assertable. Newlines
 * collapse to spaces — metadata lines are one line by definition.
 *
 * @param {unknown} value
 * @returns {string}
 */
function inlineEscape(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_~|<>@#[\]()]/g, "\\$&");
}

/**
 * Longest run of backticks in a string (drives the code-fence length).
 *
 * @param {string} text
 * @returns {number}
 */
function longestBacktickRun(text) {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * Wrap text in a fenced code block whose fence is LONGER than any backtick
 * run inside, so the wrapped text can never escape the fence. Mentions
 * inside a Discord code block are displayed literally and never ping —
 * that is the evidence-preserving inertness mechanism for free text.
 *
 * @param {string} text
 * @returns {string}
 */
function fencedBlock(text) {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Split text into ≤ chunkChars pieces on code-point boundaries (never
 * between the halves of a surrogate pair — core/text rule).
 *
 * @param {string} text
 * @param {number} chunkChars
 * @returns {string[]} non-empty chunks
 */
function splitChunks(text, chunkChars) {
  const chunks = [];
  let rest = text;
  while (rest.length > chunkChars) {
    const cut = safeCutIndex(rest, chunkChars);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);
  if (chunks.length === 0) chunks.push("");
  return chunks;
}

/**
 * Text → plain section descriptors (one per split part), rendered as fenced
 * embed bodies. Built as PLAIN OBJECTS so the fallback ladder can drop them
 * before any EmbedBuilder exists.
 *
 * @param {string} text
 * @param {string} label section title prefix ("(i/N)" appended when split)
 * @returns {{kind: "text", title: string, description: string}[]}
 */
function renderTextSections(text, label) {
  const chunks = splitChunks(text, EVIDENCE_CHUNK_CHARS);
  return chunks.map((chunk, i) => ({
    kind: "text",
    title: chunks.length > 1 ? `${label} (${i + 1}/${chunks.length})` : label,
    description: fencedBlock(chunk),
  }));
}

/**
 * Char cost of one section (everything Discord counts toward the 6000-char
 * message cap). Header sections are objects with {title, description, fields}.
 *
 * @param {{title?: string, description?: string, footer?: string, fields?: {name: string, value: string}[]}} section
 * @returns {number}
 */
function sectionChars(section) {
  let n = 0;
  if (section.title) n += section.title.length;
  if (section.description) n += section.description.length;
  if (section.footer) n += section.footer.length;
  for (const field of section.fields || []) {
    n += field.name.length + field.value.length;
  }
  return n;
}

/**
 * Collision-free file name: the sanitize step guarantees filesystem safety,
 * the `-N` infix keeps two same-named attachments distinct — the
 * `attachment://` image references must resolve to exactly one file.
 *
 * @param {string} base already-sanitized name
 * @param {Set<string>} used claimed names
 * @returns {string}
 */
function uniqueName(base, used) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * One warning/metadata line for a file that did not make it into the
 * message. Names the file, its declared size when known, the SPECIFIC
 * reason (error rule 3), and the locked decision-4 phrase.
 *
 * @param {string} name
 * @param {number|null} size declared bytes
 * @param {string} reason
 * @returns {string}
 */
function notCopiedLine(name, size, reason) {
  const sizePart = size != null ? ` (~${formatBytesLocal(size)} declared)` : "";
  const head = `"${sliceSafe(name, 80)}"${sizePart} not copied: ${sliceSafe(reason, 140)}`;
  return `${head} — original copy ${MAY_NOT_SURVIVE}`;
}

/**
 * Fetch every snapshot attachment URL through the shared SSRF guard and
 * collect {files, warnings, inlineImageNames}. One file's failure NEVER
 * aborts the loop (error rule 5) and the guard itself cannot throw (its
 * contract), so no per-file try/catch is needed — but the whole loop is
 * still defensive about malformed snapshot entries.
 *
 * @param {object} snapshot validated report snapshot
 * @param {object} opts build options (fetch seam + byte budget)
 * @returns {Promise<{files: {attachment: Buffer, name: string}[], warnings: string[], inlineImageNames: string[]}>}
 */
async function recoverAttachments(snapshot, opts) {
  const maxBytes =
    Number.isFinite(opts.maxBytesPerFile) && opts.maxBytesPerFile > 0
      ? opts.maxBytesPerFile
      : EVIDENCE_MAX_BYTES;

  const raw = Array.isArray(snapshot.attachments) ? snapshot.attachments : [];
  const warnings = [];
  const files = [];
  const inlineImageNames = [];
  /** @type {Set<string>} */
  const usedNames = new Set();

  if (raw.length > EVIDENCE_MAX_FILES) {
    // Cap the FETCHING too, not just the presentation — member-steerable
    // URL lists are the #446/LT-10 pattern.
    warnings.push(
      `Evidence file cap reached (${EVIDENCE_MAX_FILES} of ${raw.length} attachments) — the remaining files were not copied; original copies ${MAY_NOT_SURVIVE}.`,
    );
  }

  for (const entry of raw.slice(0, EVIDENCE_MAX_FILES)) {
    const att = typeof entry === "string" ? { url: entry } : entry || {};
    const name = sanitizeFilename(toText(att.name) || toText(att.url) || "file");
    const declared = Number(att.size);
    const size = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : null;
    const url = toText(att.url);

    if (size != null && size > maxBytes) {
      // Declared-size skip: do NOT download a file we are going to refuse.
      warnings.push(
        notCopiedLine(
          name,
          size,
          `declared size exceeds the ${formatBytesLocal(maxBytes)} evidence limit`,
        ),
      );
      continue;
    }
    if (!url || url.trim() === "") {
      warnings.push(notCopiedLine(name, size, "no source URL was captured"));
      continue;
    }

    // downloadGuarded never throws: guard refusals, HTTP failures, and
    // transport errors all arrive as { ok:false, reason } (specific text —
    // error rule 3), and its maxBytes covers BOTH a lying content-length
    // AND mid-stream overruns.
    const res = await downloadGuarded(url, {
      fetchImpl: typeof opts.fetchImpl === "function" ? opts.fetchImpl : undefined,
      resolveHost: typeof opts.resolveHost === "function" ? opts.resolveHost : undefined,
      timeoutMs: Number.isFinite(opts.downloadTimeoutMs) ? opts.downloadTimeoutMs : undefined,
      maxBytes,
      headers: { "User-Agent": EVIDENCE_USER_AGENT },
    });

    if (!res.ok) {
      warnings.push(notCopiedLine(name, size, res.reason || "unknown download failure"));
      continue;
    }

    const contentType = toText(res.contentType) || toText(att.contentType);
    const finalName = uniqueName(name, usedNames);
    files.push({ attachment: res.bytes, name: finalName });
    if (mediaKind(finalName, contentType) === "image") {
      inlineImageNames.push(finalName);
    }
  }

  return { files, warnings, inlineImageNames };
}

/**
 * Live-mention rendering for an id: snowflake-shaped ids become a real
 * mention (intentional — reporter/author must show as who they are);
 * anything else is escaped display text so a garbage snapshot can never
 * smuggle a markup payload into an "id".
 *
 * @param {string} id
 * @returns {string}
 */
function mentionFor(id) {
  return SNOWFLAKE_RE.test(id) ? `<@${id}>` : `\`${inlineEscape(sliceSafe(id, 64))}\``;
}

/**
 * Build the header section (plain object; EmbedBuilder comes at the end).
 *
 * @param {object} p
 * @param {string} p.reporterId
 * @param {string|null} p.authorId
 * @param {string|null} p.jumpLink short, id-shape-validated jump URL or null
 * @param {string|null} p.channelLabel raw channel name (escaped here)
 * @param {string} p.messageId
 * @param {number|null} p.capturedAt
 * @param {string} p.disposition decision-13 line (exact wording)
 * @param {number} [p.descriptionLimit] header description cap (fallback trim)
 * @param {string[]} p.descriptionBlocks already-escaped metadata lines
 * @returns {{kind: "header", title: string, description: string, fields: {name: string, value: string, inline?: boolean}[]}}
 */
function buildHeaderSection(p) {
  const channelValue = p.jumpLink
    ? `${inlineEscape(sliceSafe(`#${p.channelLabel || "unknown-channel"}`, 120))} · [Jump to original](${p.jumpLink})`
    : inlineEscape(sliceSafe(`#${p.channelLabel || "unknown-channel"}`, 120));

  return {
    kind: "header",
    title: "Reported message evidence",
    description: truncateDescription(
      p.descriptionBlocks.filter(Boolean).join("\n\n"),
      Number.isFinite(p.descriptionLimit) ? p.descriptionLimit : 2800,
    ),
    fields: [
      { name: "Reported by", value: mentionFor(p.reporterId), inline: true },
      {
        name: "Message author",
        value: p.authorId ? mentionFor(p.authorId) : "Unknown",
        inline: true,
      },
      { name: "Reported", value: tsFull(p.capturedAt), inline: true },
      {
        name: "Source channel",
        value: truncateField(channelValue, 900),
      },
      {
        name: "Message ID",
        value: truncateField(inlineEscape(sliceSafe(p.messageId, 64)), 100),
        inline: true,
      },
      { name: "Disposition", value: truncateField(p.disposition, 1000) },
    ],
  };
}

/**
 * Turn a plain section descriptor into its EmbedBuilder.
 *
 * @param {{kind: string, title?: string, description?: string, footer?: string, imageName?: string, fields?: object[]}} section
 * @returns {EmbedBuilder}
 */
function toEmbed(section) {
  const embed = new EmbedBuilder().setColor(
    section.kind === "image" ? Color.brand : Color.caution,
  );
  if (section.title) embed.setTitle(sliceSafe(section.title, 256));
  if (section.description) embed.setDescription(section.description);
  if (section.fields?.length) embed.addFields(section.fields);
  if (section.imageName) embed.setImage(`attachment://${section.imageName}`);
  if (section.footer) embed.setFooter({ text: sliceSafe(section.footer, 2000) });
  return embed;
}

/**
 * @returns {string} never-throwing id hint for the catch-path log (rule 2)
 */
function idHint(snapshot) {
  try {
    return `guild=${toId(snapshot?.guildId) ?? "?"} message=${toId(snapshot?.messageId) ?? "?"}`;
  } catch {
    return "guild=? message=?";
  }
}

/**
 * Build the evidence message for one message-variant report.
 *
 * @param {object} snapshot pendingReports snapshot (kind 'message':
 *   content, authorId, channelId, channelName, messageId, guildId,
 *   attachments [{id,name,url,size,contentType}], embedUrls[], stickers[],
 *   capturedAt)
 * @param {object} [opts]
 * @param {string} [opts.reporterUserId] overrides the snapshot reporter (the
 *   handler knows the real submitting user)
 * @param {string} [opts.contextText] modal "Additional context" input
 * @param {boolean} [opts.deleted] true AFTER a successful deletion; false
 *   renders the kept-line with the jump URL (decision 13)
 * @param {(url: string, init?: object, addresses?: string[]) => Promise<any>} [opts.fetchImpl]
 *   fetch seam for the SSRF guard (tests)
 * @param {(host: string) => Promise<string[]>} [opts.resolveHost] DNS seam
 *   for the guard (tests — production uses dns.lookup)
 * @param {number} [opts.downloadTimeoutMs] per-attempt download timeout
 * @param {number} [opts.maxBytesPerFile] per-file copy budget override
 *   (default EVIDENCE_MAX_BYTES)
 * @param {string} [opts.platform] jump-URL platform pass-through
 *   ('fluxer' + webappBaseUrl; reports themselves are Discord-only —
 *   locked decision 14)
 * @param {string|null} [opts.webappBaseUrl] Fluxer webapp base for the link
 * @returns {Promise<{ ok: true, embeds: EmbedBuilder[], files: {attachment: Buffer, name: string}[], warnings: string[] }
 *   | { ok: false, error: string }>} never rejects
 */
async function buildEvidenceMessage(snapshot, opts = {}) {
  try {
    return await buildEvidence(snapshot, opts);
  } catch (err) {
    // Rule 6 boundary: the caller never sees a throw, only a specific
    // error it can quote in its reply (rule 3). Logged with ids (rule 2).
    console.error(
      `[tickets] report evidence build failed (${idHint(snapshot)}):`,
      err?.message || err,
    );
    return { ok: false, error: `Evidence build failed: ${err?.message || err}` };
  }
}

/**
 * The pipeline itself — allowed to throw; buildEvidenceMessage catches.
 *
 * @param {object} snapshot
 * @param {object} opts
 * @returns {Promise<object>} success/failure shape as buildEvidenceMessage
 */
async function buildEvidence(snapshot, opts) {
  // ---- structural validation (specific errors; rule 3) ----
  if (!snapshot || typeof snapshot !== "object") {
    return { ok: false, error: "Evidence snapshot is missing or not an object" };
  }
  if (snapshot.kind !== "message") {
    const shown = inlineEscape(sliceSafe(String(snapshot.kind ?? "none"), 40));
    return {
      ok: false,
      error: `Evidence snapshot is not a message report (kind: ${shown})`,
    };
  }
  const reporterId = toId(opts.reporterUserId) || toId(snapshot.reporterUserId);
  if (!reporterId) {
    return { ok: false, error: "Evidence snapshot is missing its reporter user id" };
  }
  const messageId = toId(snapshot.messageId);
  if (!messageId) {
    return { ok: false, error: "Evidence snapshot is missing its message id" };
  }
  const channelId = toId(snapshot.channelId);
  if (!channelId) {
    return { ok: false, error: "Evidence snapshot is missing its source channel id" };
  }
  const guildId = toId(snapshot.guildId);
  if (!guildId) {
    return { ok: false, error: "Evidence snapshot is missing its guild id" };
  }

  // ---- jump link (null renders as no link, never a dead one) ----
  const rawJump = buildMessageJumpUrl({
    platform: opts.platform,
    guildId,
    channelId,
    messageId,
    webappBaseUrl: opts.webappBaseUrl ?? null,
  });
  // Only an id-shaped link goes inside a markdown link / plain-text line:
  // an escaped-injection URL inside [text](url) would be a markup foothold.
  const idsAreClean =
    SNOWFLAKE_RE.test(guildId) && SNOWFLAKE_RE.test(channelId) && SNOWFLAKE_RE.test(messageId);
  const jumpLink = idsAreClean && rawJump && rawJump.length <= 240 ? rawJump : null;

  // ---- attachment recovery (rule 5: per-file failures accumulate) ----
  const { files, warnings, inlineImageNames } = await recoverAttachments(snapshot, opts);

  // ---- text sections (plain objects; the ladder may still drop them) ----
  const contentText = toText(snapshot.content) ?? "";
  const contextText = toText(opts.contextText) ?? "";
  const contentSections =
    contentText === "" ? [] : renderTextSections(contentText, "Reported message content");
  const contextSections =
    contextText.trim() === "" ? [] : renderTextSections(contextText, "Reporter context");

  // ---- header metadata blocks (member strings escaped inline) ----
  const descriptionBlocks = [];
  const embedUrlLines = (Array.isArray(snapshot.embedUrls) ? snapshot.embedUrls : [])
    .map((u) => inlineEscape(sliceSafe(toText(u) ?? "", 200)))
    .filter(Boolean);
  if (embedUrlLines.length > 0) {
    descriptionBlocks.push(
      `**Original embed URLs:**\n${joinCapped(embedUrlLines.slice(0, EVIDENCE_EMBED_URL_LINES), 900, "\n")}`,
    );
  }
  const stickerLines = (Array.isArray(snapshot.stickers) ? snapshot.stickers : [])
    .map((s) => inlineEscape(sliceSafe(toText(s) ?? "", 120)))
    .filter(Boolean);
  if (stickerLines.length > 0) {
    descriptionBlocks.push(
      `**Original stickers:**\n${joinCapped(stickerLines.slice(0, EVIDENCE_STICKER_LINES), 900, "\n")}`,
    );
  }
  if (warnings.some((w) => w.includes(MAY_NOT_SURVIVE))) {
    // The decision-4 "metadata-only evidence line": every unrecovered file
    // stays named IN the evidence with the exact warning phrase. Lines are
    // selected BY PHRASE so later cap/demotion notes (which do not mean an
    // unrecovered file) never leak into this block.
    descriptionBlocks.push(
      `**Files not recovered (metadata only):**\n${joinCapped(
        warnings.filter((w) => w.includes(MAY_NOT_SURVIVE)).slice(0, 20),
        900,
        "\n",
      )}`,
    );
  }

  // ---- disposition line — exactly one of the decision-13 strings ----
  const disposition = opts.deleted
    ? `Original message deleted by ${mentionFor(reporterId)} via this ticket`
    : jumpLink
      ? `Original kept: ${jumpLink}`
      : "Original kept: jump link unavailable";

  // ---- embed-assembly fallback ladder ----
  // The .txt fallback trigger (documented, deterministic): the embed set
  // exceeds Discord's 10-embed OR 6000-char-across-embed caps, or a
  // pathologically backtick-heavy chunk busts the 4096 per-embed cap.
  const usedFileNames = new Set(
    files.map((f) => f.name),
  );
  let contentTxtName = null;
  let contextTxtName = null;
  let headerDescLimit = 2800;
  const liveContent = contentSections.slice();
  const liveContext = contextSections.slice();
  const liveImages = inlineImageNames.map((name) => ({
    kind: "image",
    imageName: name,
    footer: `Image evidence: ${inlineEscape(name)}`,
  }));

  const headerSection = (textNote) =>
    buildHeaderSection({
      reporterId,
      authorId: toId(snapshot.authorId),
      jumpLink,
      channelLabel: toText(snapshot.channelName) ?? "",
      messageId,
      capturedAt: Number.isFinite(Number(snapshot.capturedAt))
        ? Math.floor(Number(snapshot.capturedAt))
        : null,
      disposition,
      descriptionLimit: headerDescLimit,
      descriptionBlocks: textNote ? [textNote, ...descriptionBlocks] : descriptionBlocks,
    });

  const assemble = () => {
    const notes = [];
    if (contentTxtName != null) {
      notes.push(`**Message text:** attached in full as \`${contentTxtName}\`.`);
    } else if (contentText === "") {
      notes.push("**Message text:** (no text content)");
    }
    if (contextTxtName != null) {
      notes.push(`**Reporter context:** attached in full as \`${contextTxtName}\`.`);
    }
    const sections = [
      headerSection(notes.join("\n")),
      ...liveContent,
      ...liveContext,
      ...liveImages,
    ];
    const total = sections.reduce((n, s) => n + sectionChars(s), 0);
    return {
      sections,
      withinCount: sections.length <= EVIDENCE_MAX_EMBEDS,
      withinBudget: total <= EVIDENCE_MESSAGE_CHAR_BUDGET,
      perEmbedOk: sections.every(
        (s) => s.kind === "image" || sectionChars(s) <= EVIDENCE_EMBED_CHAR_MAX,
      ),
    };
  };
  const fits = () => {
    const a = assemble();
    return a.withinCount && a.withinBudget && a.perEmbedOk;
  };

  const attachTxt = (text, prefix) => {
    const name = uniqueName(
      sanitizeFilename(`${prefix}-${sliceSafe(messageId, 40)}.txt`),
      usedFileNames,
    );
    files.push({ attachment: Buffer.from(text, "utf8"), name });
    return name;
  };

  // Content first (the biggest lever), then context — the text ALWAYS
  // ships as a .txt file part when it cannot live in embeds.
  if (liveContent.length > 0 && !fits()) {
    contentTxtName = attachTxt(contentText, "report-content");
    liveContent.length = 0;
  }
  if (liveContext.length > 0 && !fits()) {
    contextTxtName = attachTxt(contextText, "report-context");
    liveContext.length = 0;
  }
  // Still over the embed COUNT: trailing image embeds demote — the files
  // already ship as plain attachments, only the inline preview goes away.
  let demoted = 0;
  while (!fits() && liveImages.length > 0) {
    liveImages.pop();
    demoted += 1;
  }
  if (demoted > 0) {
    warnings.push(
      `Evidence embed budget reached — ${demoted} image(s) ship as plain attachments without an inline preview.`,
    );
  }

  let assembled = assemble();
  if (!assembled.withinCount || !assembled.withinBudget || !assembled.perEmbedOk) {
    // Last resort (realistically unreachable: the header is bounded): trim
    // the header description via its limit, so the next assemble() honors
    // it — mutating an already-assembled section would be silently undone.
    const total = assembled.sections.reduce((n, s) => n + sectionChars(s), 0);
    const overflow = Math.max(0, total - EVIDENCE_MESSAGE_CHAR_BUDGET);
    const descLen = (assembled.sections[0].description || "").length;
    headerDescLimit = Math.max(120, descLen - overflow - 40);
    assembled = assemble();
    if (
      !assembled.withinBudget ||
      !assembled.perEmbedOk ||
      !assembled.withinCount
    ) {
      return {
        ok: false,
        error:
          "Evidence embeds exceeded the Discord message budget even after trimming — nothing was posted",
      };
    }
  }

  const embeds = assembled.sections.map((section) => {
    const embed = toEmbed(section);
    if (section.kind === "header") {
      const ms = Number(snapshot.capturedAt);
      if (Number.isFinite(ms) && ms > 0) embed.setTimestamp(new Date(ms));
    }
    return embed;
  });

  return { ok: true, embeds, files, warnings };
}

module.exports = {
  buildEvidenceMessage,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_CHUNK_CHARS,
  EVIDENCE_MAX_EMBEDS,
  EVIDENCE_MESSAGE_CHAR_BUDGET,
  EVIDENCE_MAX_FILES,
  MAY_NOT_SURVIVE,
  // Helper seams: exported for unit-test auditing (escaping, fencing,
  // collision naming) without re-implementing them in the test file.
  inlineEscape,
  fencedBlock,
  uniqueName,
};
