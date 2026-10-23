/**
 * Pure notification-format unit for RSS feed notifications (issue #305, subtask 05).
 *
 * Turns ONE rss-parser entry + its stored `rss_feeds` row + the community's
 * notify settings into the EXACT plain-JSON payload `outbound.sendChannel`
 * consumes — one message per new entry (no batching):
 *
 *   buildNotification(entry, feed, settings)
 *     -> null                                    (nothing postable)
 *     -> { content, embeds: [embed], allowedMentions }
 *
 * The payload is plain JSON end to end (no EmbedBuilder, no toJSON — the
 * `toPlainEmbed` pass-through in src/core/embeds.js is a no-op on it), so the
 * poller (subtask 08) sends it verbatim:
 *   `outbound.sendChannel(channelId, buildNotification(entry, row, settings))`
 * Mirrors the outbound shape of the youtube/twitch tickers
 * (youtube ticker.js `sendNotification`, twitch ticker.js
 * `sendGoLiveNotification`) and the #272 strict-role form whose canonical
 * precedent is src/features/eventReminders/service.js `buildReminderDelivery`.
 *
 * Locked spec (context bundle § Notification format), restated with the
 * documented decisions this unit makes:
 *
 *  - CONTENT: optional `<@&{role}> ` prefix + one-line
 *    `**{feed name}** — new post` (em-dash form per the spec string; the bold
 *    label follows #471 H2-13). The feed name resolves
 *    `display_name || feed_title || hostname(url) || "RSS feed"` — the
 *    youtube/twitch precedence of stored display name first, resolved title
 *    second, machine identity last (twitch: `sub.display_name || sub.login`;
 *    youtube: fetched `channel_name` over the raw id).
 *  - EMBED title: entry title, linked. Link chain `entry.link -> feed.feed_link
 *    -> title stays plain`, each URL only if it parses as http(s) (a
 *    `javascript:`/`data:` "link" is dropped, never linkified).
 *  - HEADLINE RULE: a title-less entry falls back to its OWN permalink
 *    (`entry.link`) as the headline text; with no entry link the entry is
 *    NOT postable → null. `feed_link` is deliberately never a headline — it
 *    is the feed home page, not this post's address.
 *  - SNIPPET: first non-empty of content → summary → description →
 *    content:encoded → contentSnippet → itunes.summary → itunes.subtitle
 *    (rss-parser v3.13 puts RSS `description`/Atom `content` in `content`,
 *    Atom `summary` in `summary`, and derives `contentSnippet` = decoded +
 *    tag-stripped but NOT truncated — the ≤300 clamp with "…" ellipsis is
 *    ours). Skipped when it duplicates the title (feeds echo title as body).
 *  - THUMBNAIL: duck-safe over every rss-parser media shape, in precedence
 *    media:thumbnail (raw/customField passthrough: `{$:{url}}`, `{url}`, or
 *    arrays of either, incl. inside media:group) → mediaContent /
 *    media:content (image medium/type ONLY — a video URL as thumbnail is
 *    always wrong) → enclosure (native `{url,type}` attr object; image type
 *    required, or typeless + image-extension URL so podcast audio never
 *    wins) → itunes image (native `entry.itunes.image` href string, or raw
 *    `itunes:image` forms). Absent → key omitted.
 *  - FOOTER: feed display name, plus " · {feed title}" when a feed title
 *    exists and differs. (Discord caps footer at 2048; we clamp to 512.)
 *  - TIMESTAMP: real `pubDate` (then parser-normalized `isoDate`) as ISO
 *    8601; MISSING/UNPARSEABLE → key omitted. This differs from
 *    feedState.resolveEntryPublishedMs on purpose: the windowing fallback to
 *    `now` is a decision input, but stamping an embed with a fabricated
 *    publish time would lie about when the post happened.
 *
 * MENTION-DEFENSE POSTURE (#272 + bridge/mentions.js): feed text is attacker-
 * controlled, so pings ride ONLY the payload — `allowedMentions` is the
 * STRICT form `{ roles: [id] }` (live Discord docs make `parse` mutually
 * exclusive with the id lists; the strict arm pins the ping to exactly the
 * configured role) else `{ parse: [] }`. A stored role id that is not a
 * bare snowflake (e.g. a hand-poisoned "@everyone") is treated as unset, so
 * no non-numeric value ever reaches a payload. Defense in depth for the
 * BODY (the bridge lesson: defaults can change and other transports may
 * ignore the payload, so the text rewrite is load-bearing too): every feed-
 * derived string passes neutralizeRichText — HTML stripped, entities decoded
 * EXACTLY ONCE, Discord mention tokens `<@id>` `<@!id>` `<@&id>` `<#id>`
 * stripped (post-decode, so single-encoded smuggling like
 * `&lt;@&amp;123&gt;` is caught), `@everyone`/`@here` broken with a ZWSP
 * (word stays readable, ping token dies), whitespace collapsed (the content
 * line can never be broken by an embedded newline).
 */

/** Embed description clamp (spec: snippet ≤300 chars INCLUDING the ellipsis). */
const RSS_SNIPPET_MAX_LENGTH = 300;

/** Discord embed-title cap; titles longer than this are clamped with "…". */
const RSS_TITLE_MAX_LENGTH = 256;

/** Footer clamp — well under Discord's 2048 footer cap, keeps lines readable. */
const RSS_FOOTER_MAX_LENGTH = 512;

/** Feed-name budget for the content line + footer parts (message cap is 2000). */
const RSS_FEED_NAME_MAX_LENGTH = 256;

/** Single-char truncation marker so the ≤max length math stays exact. */
const RSS_TRUNCATION_MARKER = "…";

/** Last-resort content label for a row with no name, no title, and a broken URL. */
const FALLBACK_FEED_NAME = "RSS feed";

/** Separator between the display name and the feed title in the embed footer. */
const FOOTER_SEPARATOR = " · ";

/**
 * Zero-width space: breaks the @everyone/@here ping token, keeps the word
 * readable (the bridge/mentions.js disarm idiom). This file carries it as a
 * literal invisible character; test/rss.test.js asserts behavior against a
 * String.fromCharCode(0x200b) twin so the assertions never depend on
 * editor round-tripping of invisible bytes.
 */
const ZWSP = "​";

/**
 * Snippet source precedence, matching rss-parser v3.13.0's real output
 * (live README + lib/parser.js): RSS `description` / Atom `content` land in
 * `content`, Atom `summary` in `summary`; `contentSnippet` is the parser's
 * pre-stripped twin of `content` (kept late in the chain — raw first so OUR
 * strip/decode/clamp rules are the ones users see); namespaced extras
 * (`content:encoded`, `itunes:*`) only exist via customFields / the itunes
 * decorator, so they ride as duck-safe tail candidates.
 */
const SNIPPET_SOURCE_FIELDS = Object.freeze([
  "content",
  "summary",
  "description",
  "content:encoded",
  "contentSnippet",
]);

/**
 * "Common" entity table — XML essentials + the typographic set feeds
 * actually emit. Unknown named entities stay literal (single decode pass:
 * `&amp;lt;` becomes plain `&lt;`, never re-decoded into `<`). Note the
 * literal invisible/look-alike whitespace values (nbsp is U+00A0, shy
 * decodes to nothing) — the behavior tests pin them by code point.
 */
const HTML_ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ", // non-breaking space — collapsed to plain space by the final pass
  shy: "", // soft hyphen — dropped
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
  laquo: "«",
  raquo: "»",
  times: "×",
});

/** Block-ish tags: replaced by a newline (word-glue guard) before tag-strip. */
const BLOCK_TAG_RE =
  /<\/?(?:h[1-6]|br|p|div|section|article|blockquote|ul|ol|li|table|tr|td|th|pre|figure|figcaption|header|footer|nav|aside|hr)\b[^>]*>/gi;

/** Any leftover tag after the block pass. */
const ANY_TAG_RE = /<[^>]*>/g;

/** One entity per match: named (`&amp;`) or numeric (`&#38;` / `&#x26;`). */
const ENTITY_RE = /&#?[a-zA-Z0-9]{1,32};/g;

/** Typed Discord mention tokens (stripped outright — always noise in a news snippet). */
const MENTION_TOKEN_RES = [
  /<@!?[0-9]{1,25}>/g, // user, incl. the legacy <@!id> form
  /<@&[0-9]{1,25}>/g, // role
  /<#[0-9]{1,25}>/g, // channel
];

/**
 * Residual-markup sweep (bridge/mentions.js hard rule: NO raw `<@` / `<#`
 * shape survives neutralization — odd ids, oversized numbers, nested junk).
 */
const ANGLE_MARKUP_SWEEP_RE = /<[@#][^<>]{1,32}>/g;

/**
 * Decode one entity match. Numeric forms are range-checked (no lone
 * surrogates, no > U+10FFFF, control chars dropped except \t \n \r); named
 * forms fall back to the literal text when unknown.
 */
function decodeEntity(match) {
  const body = match.slice(1, -1);
  if (body.startsWith("#")) {
    const hex = body[1] === "x" || body[1] === "X";
    const digits = hex ? body.slice(2) : body.slice(1);
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return "";
    if (code >= 0xd800 && code <= 0xdfff) return ""; // not a valid standalone code point
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return "";
    if (code === 0x7f) return "";
    try {
      return String.fromCodePoint(code);
    } catch {
      return "";
    }
  }
  const named = Object.prototype.hasOwnProperty.call(HTML_ENTITIES, body)
    ? HTML_ENTITIES[body]
    : undefined;
  return named === undefined ? match : named;
}

/**
 * The full feed-text neutralization pipeline (documented in the module
 * header): strip CDATA leftovers → drop script/style ELEMENTS (bodies too,
 * so their text never leaks into the snippet) → block tags to newline →
 * strip remaining tags → decode entities ONCE → strip mention tokens
 * (post-decode, catching single-encoded smuggling) → ZWSP-break
 * @everyone/@here → collapse all whitespace (incl. decoded &nbsp; — JS \s
 * covers U+00A0) and trim.
 *
 * @param {unknown} raw attacker-controlled feed text
 * @returns {string} plain, mention-safe, whitespace-collapsed text
 */
function neutralizeRichText(raw) {
  if (raw == null) return "";
  let text = String(raw);
  text = text.replace(/<!\[CDATA\[|\]\]>/g, "");
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ");
  text = text.replace(BLOCK_TAG_RE, "\n");
  text = text.replace(ANY_TAG_RE, "");
  text = text.replace(ENTITY_RE, decodeEntity);
  for (const re of MENTION_TOKEN_RES) text = text.replace(re, "");
  text = text.replace(ANGLE_MARKUP_SWEEP_RE, "");
  text = text.replace(/@everyone/g, `@${ZWSP}everyone`);
  text = text.replace(/@here/g, `@${ZWSP}here`);
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Clamp to `maxLength` INCLUDING the single-char ellipsis: 299/300 in →
 * verbatim, 301 in → exactly 300 out ending in "…".
 */
function clamp(text, maxLength) {
  if (text.length <= maxLength) return text;
  return (
    text.slice(0, maxLength - RSS_TRUNCATION_MARKER.length).trimEnd() +
    RSS_TRUNCATION_MARKER
  );
}

/**
 * http(s)-only URL gate for every value destined for an embed url/thumbnail:
 * a feed serving `javascript:`, `data:`, or junk never gets linkified. The
 * trimmed ORIGINAL string is returned (no URL normalization surprises);
 * WHATWG parsing already percent-encodes `<>` in paths it accepts.
 */
function safeHttpUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** rss-parser passthroughs hand back arrays wherever xml2js saw duplicates. */
function firstOf(value) {
  return Array.isArray(value) ? value : [value];
}

/**
 * Duck-safe attribute-object reader for the media/enclosure shapes confirmed
 * against rss-parser v3.13.0 lib/parser.js: NATIVE flat attr objects
 * (`item.enclosure = xmlItem.enclosure[0].$`, `item.mediaContent = …[0].$`,
 * `entry.itunes.image` as a plain href string) AND raw xml2js passthroughs
 * via customFields (`[0]` element objects carrying `.$`), any of them
 * possibly array-wrapped.
 * @returns {object|null} first object item, unwrapped to `.$` attrs when present
 */
function attrsOf(node) {
  for (const item of firstOf(node)) {
    if (!item || typeof item !== "object") continue;
    const raw = item.$;
    return raw && typeof raw === "object" ? raw : item;
  }
  return null;
}

function looksLikeImageUrl(url) {
  try {
    const path = new URL(url).pathname;
    return /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(path);
  } catch {
    return false;
  }
}

/** media:thumbnail is an image BY TAG NAME — url (or href) is enough. */
function thumbnailFromMediaNode(node) {
  const attrs = attrsOf(node);
  if (!attrs) return null;
  return safeHttpUrl(attrs.url) || safeHttpUrl(attrs.href);
}

/** media:content needs an IMAGE claim (medium attr or image/* mime). */
function imageMediaContentUrl(node) {
  const attrs = attrsOf(node);
  if (!attrs) return null;
  const url = safeHttpUrl(attrs.url);
  if (!url) return null;
  const medium = String(attrs.medium ?? "").toLowerCase();
  const type = String(attrs.type ?? "").toLowerCase();
  return medium === "image" || type.startsWith("image/") ? url : null;
}

/**
 * First postable thumbnail URL for one entry (precedence documented in the
 * module header). Never throws; "nothing image-shaped" reads as null and the
 * embed simply carries no thumbnail.
 *
 * @param {object|null} entry rss-parser item
 * @returns {string|null}
 */
function resolveThumbnailUrl(entry) {
  if (!entry || typeof entry !== "object") return null;
  // media:group rides customFields as the plain element object OR (keepArray)
  // an array of them — accept both shapes here, single object below.
  const groupNode = entry["media:group"];
  const group = Array.isArray(groupNode)
    ? firstOf(groupNode).find((item) => item && typeof item === "object")
    : groupNode && typeof groupNode === "object"
      ? groupNode
      : null;

  const thumbNodes = [
    entry["media:thumbnail"],
    entry.mediaThumbnail,
    group && group["media:thumbnail"],
    group && group.mediaThumbnail,
  ];
  for (const node of thumbNodes) {
    const url = thumbnailFromMediaNode(node);
    if (url) return url;
  }

  const contentNodes = [
    entry.mediaContent,
    entry["media:content"],
    group && group.mediaContent,
    group && group["media:content"],
  ];
  for (const node of contentNodes) {
    const url = imageMediaContentUrl(node);
    if (url) return url;
  }

  for (const item of firstOf(entry.enclosure)) {
    const attrs =
      item && typeof item === "object"
        ? item.$ && typeof item.$ === "object"
          ? item.$
          : item
        : null;
    if (!attrs) continue;
    const url = safeHttpUrl(attrs.url);
    if (!url) continue;
    const type = String(attrs.type ?? "").toLowerCase();
    if (type.startsWith("image/")) return url;
    if (type === "" && looksLikeImageUrl(url)) return url;
  }

  const itunesNative =
    entry.itunes && typeof entry.itunes === "object" ? entry.itunes.image : null;
  for (const candidate of [itunesNative, entry["itunes:image"]]) {
    if (typeof candidate === "string") {
      const url = safeHttpUrl(candidate);
      if (url) return url;
      continue;
    }
    const attrs = attrsOf(candidate);
    if (!attrs) continue;
    const url = safeHttpUrl(attrs.href) || safeHttpUrl(attrs.url);
    if (url) return url;
  }

  return null;
}

/**
 * Snippet text for the embed description: first non-empty candidate in
 * SNIPPET_SOURCE_FIELDS (plus nested itunes.summary / itunes.subtitle),
 * neutralized then clamped to RSS_SNIPPET_MAX_LENGTH. "" when the entry
 * simply has no body text.
 *
 * @param {object|null} entry rss-parser item
 * @returns {string} clamped plain-text snippet (possibly "")
 */
function buildSnippet(entry) {
  if (!entry || typeof entry !== "object") return "";
  const candidates = SNIPPET_SOURCE_FIELDS.map((field) => entry[field]);
  if (entry.itunes && typeof entry.itunes === "object") {
    candidates.push(entry.itunes.summary, entry.itunes.subtitle);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    const text = clamp(neutralizeRichText(candidate), RSS_SNIPPET_MAX_LENGTH);
    if (text) return text;
  }
  return "";
}

function hostnameOf(feedUrl) {
  try {
    return new URL(String(feedUrl)).hostname;
  } catch {
    return "";
  }
}

/**
 * Feed display name for the bold content label + footer (youtube/twitch
 * precedence, documented in the module header):
 * `display_name || feed_title || hostname(url) || "RSS feed"`.
 *
 * @param {object|null} feed stored rss_feeds row (snake_case columns)
 * @returns {string} never empty
 */
function resolveFeedDisplayName(feed) {
  const row = feed && typeof feed === "object" ? feed : {};
  const named = clamp(
    neutralizeRichText(row.display_name) || neutralizeRichText(row.feed_title),
    RSS_FEED_NAME_MAX_LENGTH,
  );
  if (named) return named;
  const host = hostnameOf(row.url);
  return host ? clamp(host, RSS_FEED_NAME_MAX_LENGTH) : FALLBACK_FEED_NAME;
}

/**
 * Snowflake-validated notify role. Anything that is not a bare 1–25 digit
 * id (null, "", "@everyone", hand-poisoned junk) resolves to null so it can
 * never reach a payload in ANY position — content prefix included.
 *
 * @param {{notifyRoleId?: unknown}|null} settings community notify settings
 * @returns {string|null} the role id string, or null when effectively unset
 */
function resolveNotifyRoleId(settings) {
  const raw = settings && typeof settings === "object" ? settings.notifyRoleId : null;
  if (raw == null) return null;
  const id = String(raw).trim();
  return /^[0-9]{1,25}$/.test(id) ? id : null;
}

/**
 * The #272 strict allow-list (mirrors twitch ticker `sendGoLiveNotification`
 * and eventReminders `buildReminderDelivery`): `{ roles: [id] }` pins the
 * ping to exactly the configured role — `parse` is MUTUALLY EXCLUSIVE with
 * the id lists on the live Discord API, so the two arms are never merged.
 * Unset/invalid → `{ parse: [] }`: nothing in the message can mention.
 *
 * @param {{notifyRoleId?: unknown}|null} settings
 * @returns {{roles: [string]}|{parse: []}}
 */
function toAllowedMentions(settings) {
  const roleId = resolveNotifyRoleId(settings);
  return roleId ? { roles: [roleId] } : { parse: [] };
}

/**
 * Embed timestamp (ISO 8601, discord.js `setTimestamp` wire form) from a
 * REAL publish date: `pubDate` first, then the parser-normalized `isoDate`;
 * `undefined` when neither parses — the timestamp key is then omitted
 * entirely (documented: an embed timestamp claims WHEN the post happened,
 * so unlike the feedState windowing fallback it is never fabricated as `now`).
 *
 * @param {object|null} entry rss-parser item
 * @returns {string|undefined}
 */
function resolveEntryTimestampIso(entry) {
  if (!entry || typeof entry !== "object") return undefined;
  for (const candidate of [entry.pubDate, entry.isoDate]) {
    if (candidate == null || candidate === "") continue;
    const ms = new Date(candidate).getTime();
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return undefined;
}

function buildFooterText(feed, feedName) {
  const row = feed && typeof feed === "object" ? feed : {};
  const feedTitle = clamp(neutralizeRichText(row.feed_title), RSS_FEED_NAME_MAX_LENGTH);
  if (feedTitle && feedTitle !== feedName) {
    return clamp(feedName + FOOTER_SEPARATOR + feedTitle, RSS_FOOTER_MAX_LENGTH);
  }
  return clamp(feedName, RSS_FOOTER_MAX_LENGTH);
}

/**
 * Build the one-message payload announcing one new feed entry.
 *
 * @param {object} entry rss-parser item (`{title, link, content?, enclosure?,
 *   mediaContent?, itunes?, pubDate?, isoDate?, ...}` — every field optional,
 *   everything attacker-controlled)
 * @param {object} feed stored rss_feeds row (`{url, display_name, feed_title,
 *   feed_link, ...}` — snake_case DB columns)
 * @param {{channelId?: string|null, notifyRoleId?: string|null}} settings
 *   community notify settings; the poller maps
 *   `guild_settings.rss_notification_channel_id -> channelId` and
 *   `rss_notify_role_id -> notifyRoleId`. `channelId` is NOT consumed here —
 *   routing is the poller's job (sendChannel takes it separately); this
 *   unit only shapes the message body.
 * @returns {{
 *   content: string,
 *   embeds: Array<object>,          // exactly one plain-JSON embed
 *   allowedMentions: {roles: [string]}|{parse: []},
 * } | null} null when the entry has no headline (no title AND no entry
 *   permalink — see the documented HEADLINE RULE); the poller counts those
 *   as skipped, it never sends an empty announcement.
 */
function buildNotification(entry, feed, settings) {
  if (!entry || typeof entry !== "object") return null;

  const feedName = resolveFeedDisplayName(feed);
  const roleId = resolveNotifyRoleId(settings);
  const prefix = roleId ? `<@&${roleId}> ` : "";
  const content = `${prefix}**${feedName}** — new post`;

  const entryLink = safeHttpUrl(entry.link);
  const feedRow = feed && typeof feed === "object" ? feed : {};
  const embedUrl = entryLink || safeHttpUrl(feedRow.feed_link);

  let titleText = clamp(neutralizeRichText(entry.title), RSS_TITLE_MAX_LENGTH);
  if (!titleText) {
    if (!entryLink) return null; // no headline, no permalink → nothing postable
    titleText = clamp(neutralizeRichText(entryLink), RSS_TITLE_MAX_LENGTH);
  }

  const embed = { title: titleText };
  if (embedUrl) embed.url = embedUrl;

  const snippet = buildSnippet(entry);
  if (snippet && snippet !== titleText) embed.description = snippet;

  const thumbnail = resolveThumbnailUrl(entry);
  if (thumbnail) embed.thumbnail = { url: thumbnail };

  embed.footer = { text: buildFooterText(feedRow, feedName) };

  const timestamp = resolveEntryTimestampIso(entry);
  if (timestamp) embed.timestamp = timestamp;

  return {
    content,
    embeds: [embed],
    allowedMentions: toAllowedMentions(settings),
  };
}

module.exports = {
  RSS_SNIPPET_MAX_LENGTH,
  RSS_TITLE_MAX_LENGTH,
  RSS_FOOTER_MAX_LENGTH,
  RSS_FEED_NAME_MAX_LENGTH,
  FALLBACK_FEED_NAME,
  SNIPPET_SOURCE_FIELDS,
  neutralizeRichText,
  buildSnippet,
  resolveThumbnailUrl,
  resolveFeedDisplayName,
  resolveNotifyRoleId,
  toAllowedMentions,
  resolveEntryTimestampIso,
  buildNotification,
};
