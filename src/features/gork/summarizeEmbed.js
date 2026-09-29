/**
 * `/gork summarize` embed renderer (roadmap/gork.md §7.21.4, decision 56).
 *
 * Turns the sanitized rundown text plus render metadata (mode, resolved range,
 * invoker, clamp disclosure from the range reader) into an ARRAY of themed
 * EmbedBuilder embeds — the rundown always posts as embeds, never plain text.
 *
 * Pure renderer contract:
 * - No Discord calls, no I/O, no clock reads — same input, same embeds.
 * - Never throws: empty/garbage/oversized input degrades to a minimal valid
 *   embed (the catch-all mirrors audit.js's never-throws audit modules; the
 *   only impurity allowed is the console.error breadcrumb on a render bug).
 * - The generation output cap (GORK_SUMMARIZE_OUTPUT_MAX, 3,500) is sized so
 *   one embed always holds a normal rundown; more than one embed in the
 *   returned array is the EMERGENCY path only (model overflowed the embed
 *   budget) — those continuations are still embeds, never a plain-text dump.
 *
 * Poster contract (enforced by the handler, subtask 08 — decision 32's
 * all-chunks-land counting lives there, not here):
 * - Post the embeds IN ORDER, one embed per message (use buildRundownPayloads,
 *   which stamps `allowedMentions: NO_PING_MENTIONS` on EVERY payload — no
 *   post of a rundown may skip it, Fix 1 precedent).
 * - The success count (cooldown arm + budget count) happens ONLY once the
 *   LAST embed lands; a mid-sequence post failure must surface how many
 *   embeds posted and why it stopped (partial-results rule), and must count
 *   nothing.
 * - `embeds.length > 1` is the overflow signal: the handler may log/audit
 *   that continuations were needed (and should treat it as the model
 *   ignoring the 3,500-cap).
 *
 * Clamp disclosure: the reader returns the window it actually read when a
 * cap clamped the range (decision 54's clamp-and-disclose). The handler
 * formats that once — either a pre-built `disclosure` string or the `clamp`
 * object via formatWindowDisclosure() — and passes the SAME string to the
 * reply text, so embed and reply carry identical wording.
 */

const { Color, baseEmbed, truncateField } = require("../../core/theme");
const { sliceSafe } = require("../../core/text");
// Re-exported for the poster: every rundown message must be sent with
// `allowedMentions: NO_PING_MENTIONS` (single source: sanitize.js).
const { NO_PING_MENTIONS } = require("./sanitize");

/** Embed title of the primary rundown embed (house style: plain, no emoji). */
const RUNDOWN_TITLE = "Gork rundown";
/**
 * Per-embed body budget (description only). Discord's hard description cap is
 * 4,096; 4,000 keeps every chunk (plus the truncation ellipsis path) safely
 * under it. The 3,500 output cap (§7.21.3) therefore never needs a
 * continuation — overflow chunks are the emergency path only.
 */
const EMBED_BODY_MAX = 4000;
/** Field-value caps (Discord hard cap 1,024; tighter here to keep the whole embed well under its ~6,000-char practical budget). */
const MODE_FIELD_MAX = 200;
const DISCLOSURE_FIELD_MAX = 600;
/** Body shown when the model produced nothing renderable. */
const EMPTY_RUNDOWN_BODY = "(empty)";
/** House fallback for an id we cannot name (sanitize.js "@someone" precedent). */
const UNKNOWN_USER_LABEL = "@someone";

/**
 * Discord jump URL for one message, or null when any id leg is missing.
 * Same shape as audit.js `messageJumpUrl` (kept local so this module stays
 * dependency-light and pure — audit.js pulls in the log sender).
 *
 * @param {string|number|null|undefined} guildId
 * @param {string|number|null|undefined} channelId
 * @param {string|number|null|undefined} messageId
 * @returns {string|null}
 */
function messageJumpUrl(guildId, channelId, messageId) {
  if (guildId == null || channelId == null || messageId == null) return null;
  const gid = String(guildId);
  const cid = String(channelId);
  const mid = String(messageId);
  if (!gid || !cid || !mid) return null;
  return `https://discord.com/channels/${gid}/${cid}/${mid}`;
}

/**
 * "@Name" label for the invoking user, without any `<@id>` markup (footer
 * text renders mentions literally, so names only). Accepts a
 * string, a discord.js User/Member-ish object, or an object wrapping one
 * as `.user`. Unknown-but-present id degrades to "@someone"; nothing
 * usable degrades to "" (the footer then omits the invoker entirely).
 *
 * @param {unknown} invoker
 * @returns {string}
 */
function formatUserHandle(invoker) {
  if (!invoker) return "";
  if (typeof invoker === "string") {
    const name = invoker.trim().replace(/^@/, "");
    return name ? `@${name}` : "";
  }
  const src = invoker.user && typeof invoker.user === "object" ? invoker.user : invoker;
  const name =
    String(src.displayName ?? "").trim() ||
    String(src.globalName ?? "").trim() ||
    String(src.username ?? "").trim() ||
    String(src.tag ?? "").trim();
  if (name) return `@${name.replace(/^@/, "")}`;
  return src?.id ? UNKNOWN_USER_LABEL : "";
}

/**
 * Readable range as message links: `[firstUrl → lastUrl]` (decision 56).
 * Degrades to `[id → id]` bare ids when channel/guild legs are missing, and
 * to "" when neither end is known. A partially known range still renders
 * (`[… → url]`), because a half-disclosed range beats a silent one.
 *
 * @param {{ firstId?: string|number|null, lastId?: string|number|null, channelId?: string|number|null }|null|undefined} range
 * @param {string|number|null|undefined} guildId
 * @returns {string}
 */
function formatRangeLabel(range, guildId) {
  const first = range?.firstId != null ? String(range.firstId) : "";
  const last = range?.lastId != null ? String(range.lastId) : "";
  if (!first && !last) return "";
  const link = (id) => (id ? messageJumpUrl(guildId, range?.channelId, id) || id : "…");
  return `[${link(first)} → ${link(last)}]`;
}

/**
 * The disclosed-window line naming the window actually read (decision 54's
 * clamp-and-disclose): "Cap hit — read …". Returns "" when nothing clamped,
 * so callers can branch on emptiness. The handler uses this ONCE and feeds
 * the same string to the embed and to the reply text.
 *
 * `clamp` is the range reader's shaped result (the reader owns exact
 * wording via a `windowLabel`/`reason` it supplies; a fully custom string
 * can bypass formatting entirely via the renderer's `disclosure` option):
 * - `clamped`    truthy gate (false/absent → no line at all)
 * - `windowLabel` e.g. "1234567→1234599" / "the 850 oldest in range"
 * - `read`       messages actually read
 * - `requested`  messages the caller asked for (only shown when > read)
 * - `reason`     which cap bit ("over the 1,000-message cap" / "312k transcript cap")
 *
 * @param {{ clamped?: boolean, windowLabel?: string, read?: number, requested?: number, reason?: string }|null|undefined} clamp
 * @returns {string} formatted disclosure line, or ""
 */
function formatWindowDisclosure(clamp) {
  if (!clamp || !clamp.clamped) return "";
  const label = String(clamp.windowLabel ?? "").trim();
  const reason = String(clamp.reason ?? "").trim();
  const read = Number(clamp.read);
  const requested = Number(clamp.requested);
  let count = "";
  if (Number.isFinite(read) && read > 0) {
    count =
      Number.isFinite(requested) && requested > read
        ? `${read} of ${requested} messages`
        : `${read} message${read === 1 ? "" : "s"}`;
  }
  const window = label
    ? count
      ? `${label} (${count})`
      : label
    : count || "the largest window the caps allow";
  return `Cap hit — read ${window}${reason ? `: ${reason}` : ""}`;
}

/**
 * Resolve the disclosure text: an explicit `disclosure` string wins (the
 * handler passes the reader's exact wording verbatim so embed and reply
 * match byte-for-byte); otherwise format the structured `clamp`.
 *
 * @param {object} meta render metadata
 * @returns {string} "" when nothing was clamped
 */
function resolveDisclosure(meta) {
  const explicit = String(meta?.disclosure ?? "").trim();
  if (explicit) return explicit;
  return formatWindowDisclosure(meta?.clamp);
}

/**
 * Split the body into ≤ budget-sized pieces, preferring newline boundaries
 * (the join reproduces the input exactly); when no newline exists the cut is
 * code-point-safe via sliceSafe, so an emoji never lands split.
 *
 * @param {string} text non-empty body
 * @param {number} budget max chars per piece
 * @returns {string[]} pieces, joinable back into `text`
 */
function chunkBody(text, budget) {
  const size = Math.max(1, Math.floor(Number(budget)) || 1);
  const chunks = [];
  let rest = text;
  while (rest.length > size) {
    const breakAt = rest.lastIndexOf("\n", size - 1);
    let cut = breakAt >= 1 ? breakAt + 1 : sliceSafe(rest, size).length;
    // Infinite-loop guard; unreachable at real budgets (sliceSafe shrinks by
    // at most one surrogate half, so cut >= size - 1 >= 1 for size >= 2).
    if (cut < 1) cut = 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

/**
 * Footer text shared by every embed: range as message links + the invoking
 * user (decision 56). "" when both parts are unusable (baseEmbed then omits
 * the footer entirely).
 *
 * @param {object} meta
 * @returns {string}
 */
function buildFooter(meta) {
  const rangeLabel = formatRangeLabel(meta?.range, meta?.guildId);
  const handle = formatUserHandle(meta?.invoker);
  return [rangeLabel, handle ? `Requested by ${handle}` : ""].filter(Boolean).join(" · ");
}

/**
 * Render the rundown into embeds (pure, never throws).
 *
 * @param {unknown} text sanitized rundown (normally ≤ GORK_SUMMARIZE_OUTPUT_MAX)
 * @param {object} [meta] render metadata supplied by the handler (08) from
 *   the reader result — the renderer stays decoupled from how it is produced
 * @param {string|number|null} [meta.guildId] for the footer jump links
 * @param {string} [meta.mode] mode label ("from→now" etc.) — shown in an
 *   inline "Mode" field when non-empty (audit carries the canonical copy)
 * @param {{ firstId?: string|number|null, lastId?: string|number|null, channelId?: string|number|null }} [meta.range]
 *   resolved range (first/last message read + the channel they live in)
 * @param {unknown} [meta.invoker] invoking user (string / User / MessageInteraction-ish)
 * @param {string} [meta.disclosure] pre-formatted disclosed-window line (wins
 *   over `clamp`; the reply text must use the SAME string)
 * @param {object} [meta.clamp] structured clamp info for formatWindowDisclosure
 * @param {boolean|Date|number} [meta.timestamp] passed to baseEmbed (true = now,
 *   stamped by the caller — kept out of this module to stay pure)
 * @returns {import("discord.js").EmbedBuilder[]} one embed normally; more are
 *   emergency continuations (title carries "(continued i/n)")
 */
function renderSummarizeEmbeds(text, meta = {}) {
  try {
    const body = (text == null ? "" : String(text)).trim() || EMPTY_RUNDOWN_BODY;
    const chunks = chunkBody(body, EMBED_BODY_MAX);
    const footer = buildFooter(meta);
    const mode = String(meta?.mode ?? "").trim();
    const disclosure = resolveDisclosure(meta);

    return chunks.map((chunk, i) => {
      // The primary keeps the canonical title (the handler and audits key on
      // it); only emergency continuations carry "(continued i/n)".
      const title =
        chunks.length > 1 && i > 0
          ? `${RUNDOWN_TITLE} (continued ${i + 1}/${chunks.length})`
          : RUNDOWN_TITLE;
      const embed = baseEmbed({
        color: Color.brand,
        title,
        description: chunk,
        footer,
        timestamp: meta?.timestamp,
      });
      // Meta fields ride on the PRIMARY embed only — continuations stay
      // pure body so the sequence joins back into the original rundown.
      if (i === 0) {
        const fields = [];
        if (mode) {
          fields.push({
            name: "Mode",
            value: truncateField(mode, MODE_FIELD_MAX),
            inline: true,
          });
        }
        if (disclosure) {
          fields.push({
            name: "Disclosed window",
            value: truncateField(disclosure, DISCLOSURE_FIELD_MAX),
            inline: false,
          });
        }
        if (fields.length) embed.addFields(fields);
      }
      return embed;
    });
  } catch (err) {
    // Never-throw contract (audit.js precedent): a render bug must still
    // produce a valid embed; the breadcrumb carries the cause.
    console.error("[gork] summarize embed render failed:", err?.message || err);
    return [
      baseEmbed({
        color: Color.brand,
        title: RUNDOWN_TITLE,
        description: "(rundown embed failed to render)",
      }),
    ];
  }
}

/**
 * Turn rendered embeds into ready-to-send message payloads — one embed per
 * message, EACH carrying `allowedMentions: NO_PING_MENTIONS` so no rundown
 * post can ping anyone (Fix 1 precedent; the renderer already received
 * sanitize-rewritten text). The poster sends these IN ORDER and applies the
 * all-chunks-land counting (decision 32) described in the module header.
 *
 * @param {import("discord.js").EmbedBuilder[]|import("discord.js").EmbedBuilder} embeds
 * @returns {{ embeds: import("discord.js").EmbedBuilder[], allowedMentions: { parse: never[] } }[]}
 */
function buildRundownPayloads(embeds) {
  const list = Array.isArray(embeds)
    ? embeds.filter(Boolean)
    : embeds
      ? [embeds]
      : [];
  return list.map((embed) => ({
    embeds: [embed],
    allowedMentions: NO_PING_MENTIONS,
  }));
}

module.exports = {
  NO_PING_MENTIONS,
  RUNDOWN_TITLE,
  EMBED_BODY_MAX,
  EMPTY_RUNDOWN_BODY,
  messageJumpUrl,
  formatUserHandle,
  formatRangeLabel,
  formatWindowDisclosure,
  renderSummarizeEmbeds,
  buildRundownPayloads,
};
