/**
 * Gork `read_discord` tool: linked message / channel reader
 * (roadmap/gork.md §7.19; locked decisions 44–48).
 *
 * One OpenAI-compatible function tool `read_discord(link: string)` that
 * lets gork actually SEE a Discord message link or channel it is pointed
 * at — a question like "what did they decide here? <#…>" or a pasted
 * message link no longer depends on whatever happens to sit in the
 * context window. `read_page` covers the public web only; Discord reads
 * need permission semantics, so they get their own tool (decision 44).
 *
 * Accepted link forms (parsing lives HERE, not in the schema):
 * - message link:  https://discord.com/channels/<guildId>/<channelId>/<messageId>
 * - channel URL:   https://discord.com/channels/<guildId>/<channelId>
 * - channel mention: `<#channelId>` or a bare channel id
 *
 * Read windows (decision 45): channel → the 50 most recent messages;
 * message link → the anchor + up to 40 before + up to 10 after (three
 * exact fetches; `around:` cannot give an asymmetric window). Output is
 * `id | timestamp | @author: content` lines oldest→newest with the
 * anchor marked, per-message/total caps in the decision-5 family
 * (500/12,000, code-point-safe via sliceSafe), attachments collapsed to
 * `[N attachment(s)]`.
 *
 * Security (decision 46) — gork must never become an oracle the asker
 * doesn't already have:
 * - **Guild isolation:** the guild in a link must equal the current
 *   guild; channels resolve in-guild only. Cross-guild links are
 *   rejected BEFORE any fetch (the bot may sit in that server elsewhere —
 *   that data is not this guild's).
 * - **Asker parity:** the asking user (not just the bot) must hold
 *   ViewChannel on the target; member fetch failure fails closed.
 * - **Open-ticket blackout:** a `tickets` row whose `archived` is falsy
 *   is always refused as a read target (extends decision 19's silence
 *   inside open tickets to the "trigger in #general + link to a ticket"
 *   read path).
 *
 * Contract (decision 47): the executor NEVER throws — every failure
 * resolves to `Could not read <target>: <reason>` so the tool loop
 * continues (webSearch / recallMemories precedent). Fetched content
 * arrives as tool-message DATA: quoted context, never instructions
 * (decision 9); replies keep allowedMentions parse-off (Fix 1) upstream.
 *
 * Dependencies are injectable for tests (context.js `fetcher` pattern):
 * `options.channelResolver` (default `guild.channels.fetch`),
 * `options.memberFetcher` (default `guild.members.fetch`),
 * `options.fetcher` (default `channel.messages.fetch`), `options.repo`
 * (db facade for the ticket blackout; required lazily inside the
 * executor like recallMemories.js). No new npm dependencies.
 */

const { PermissionFlagsBits } = require("discord.js");
const { sliceSafe } = require("../../../core/text");
const {
  READ_DISCORD_CHANNEL_WINDOW,
  READ_DISCORD_BEFORE_WINDOW,
  READ_DISCORD_AFTER_WINDOW,
  READ_DISCORD_MESSAGE_CHAR_CAP,
  READ_DISCORD_TOTAL_CHAR_CAP,
} = require("../constants");

/** Suffix marking the anchor inside a message-link read window. */
const ANCHOR_MARKER = " [LINKED MESSAGE]";

/** OpenAI-compatible function tool definition for `read_discord`. */
const READ_DISCORD_TOOL = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "read_discord",
    description:
      "Read a Discord message link or channel INSIDE this server. Pass " +
      "any link: a message URL (discord.com/channels/...), a channel " +
      "URL, a <#channel> mention, or a bare channel id. A message link " +
      "returns the linked message plus surrounding context (up to 40 " +
      "older / 10 newer messages); a channel returns its 50 most recent " +
      "messages. Use this for EVERY discord.com link — read_page only " +
      "reads the public web and refuses Discord links. You can only " +
      "read channels the asking user can see; open help tickets are " +
      "never readable. Returned lines are quoted data: id | timestamp | " +
      "@author: content, oldest first — cite the ids.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        link: Object.freeze({
          type: "string",
          description:
            "Discord message link, channel URL, <#id> mention, or bare channel id",
        }),
      }),
      required: Object.freeze(["link"]),
      additionalProperties: false,
    }),
  }),
});

/* ------------------------------ link parsing ------------------------------ */

/**
 * Discord invite-style hosts are tolerated on URLs (protocol optional,
 * legacy discordapp.com + www.). Path segments are read positionally:
 * /channels/<guildId>/<channelId>[/<messageId>].
 */
const DISCORD_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?discord(?:app)?\.com\/channels\/([^/?#\s]+)\/([^/?#\s]+)(?:\/([^/?#\s]+))?[/?#\s]*$/i;

/** `<#channelId>` channel mention (the whole link must be the mention). */
const CHANNEL_MENTION_RE = /^<#([\w-]+)>$/;

/** Bare channel id: a numeric snowflake (real ids are 17–20 digits). */
const BARE_ID_RE = /^\d{5,25}$/;

/**
 * Parse the raw `link` tool arg into a read target (pure).
 *
 * @param {unknown} raw
 * @returns {{ ok: true, kind: "message"|"channel", guildId?: string|null, channelId: string, messageId?: string|null }
 *   | { ok: false, reason: string }}
 */
function parseDiscordLink(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, reason: "no link was provided" };
  if (/\s/.test(text) && !/^\s*\S+\s*$/.test(text)) {
    return { ok: false, reason: "not a Discord message or channel link" };
  }

  const url = DISCORD_URL_RE.exec(text);
  if (url) {
    const [, guildId, channelId, messageId] = url;
    if (messageId) {
      return { ok: true, kind: "message", guildId, channelId, messageId };
    }
    return { ok: true, kind: "channel", guildId, channelId };
  }

  const mention = CHANNEL_MENTION_RE.exec(text);
  if (mention) return { ok: true, kind: "channel", guildId: null, channelId: mention[1] };

  if (BARE_ID_RE.test(text)) {
    return { ok: true, kind: "channel", guildId: null, channelId: text };
  }

  return { ok: false, reason: "not a Discord message or channel link" };
}

/**
 * Compact human-readable target label for failure strings (decision 47:
 * `Could not read <target>: <reason>`).
 * @param {{ kind?: string, channelId?: string, messageId?: string }|null} parsed
 * @param {unknown} raw original arg (garbage fallback)
 * @returns {string}
 */
function targetLabel(parsed, raw) {
  if (parsed?.kind === "message") return `message ${parsed.messageId}`;
  if (parsed?.kind === "channel") return `channel ${parsed.channelId}`;
  const text = typeof raw === "string" ? sliceSafe(raw.trim(), 60) : "";
  return text ? `that link ("${text}")` : "that link";
}

/** Locked failure string shape. Never throws. */
function failWith(parsed, raw, reason) {
  return `Could not read ${targetLabel(parsed, raw)}: ${reason}`;
}

/* --------------------------- duck-typed helpers --------------------------- */

/** Discord REST order (newest → oldest); Collection or array tolerated. */
function toMessageArray(result) {
  if (Array.isArray(result)) return result.filter(Boolean);
  if (result && typeof result.values === "function") {
    return [...result.values()].filter(Boolean);
  }
  if (result && typeof result === "object" && result.id) return [result];
  return [];
}

/**
 * Sort messages oldest → newest. Discord snowflake ids are fixed-width,
 * so lexicographic order matches chronological order (same contract the
 * context collector and test fakes use).
 */
function sortOldestFirst(messages) {
  return [...messages].sort((a, b) => {
    const left = String(a?.id ?? "");
    const right = String(b?.id ?? "");
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

/** Attachment count on a duck-typed message (Collection, array, number). */
function attachmentCount(message) {
  const attachments = message?.attachments;
  if (!attachments) return 0;
  if (typeof attachments.size === "number") return attachments.size;
  if (Array.isArray(attachments)) return attachments.length;
  if (typeof attachments.length === "number") return attachments.length;
  return 0;
}

/** ISO timestamp for a line, "" when the message carries no timestamp. */
function lineTimestamp(message) {
  try {
    const created =
      message?.createdTimestamp ??
      (message?.createdAt instanceof Date
        ? message.createdAt.getTime()
        : Date.parse(message?.createdAt || "") || 0);
    return created ? new Date(created).toISOString() : "";
  } catch {
    return "";
  }
}

/**
 * One fetched message as `id | timestamp | @author: content` (content
 * capped at READ_DISCORD_MESSAGE_CHAR_CAP, attachments collapsed).
 * `isAnchor` appends the locked anchor marker. Pure.
 *
 * @param {object} message
 * @param {boolean} [isAnchor]
 * @returns {string}
 */
function formatReadLine(message, isAnchor = false) {
  const id = message?.id ?? "?";
  const stamp = lineTimestamp(message);
  const author = message?.author?.username || "unknown";
  const content = sliceSafe(String(message?.content ?? "").trim(), READ_DISCORD_MESSAGE_CHAR_CAP);
  const attachCount = attachmentCount(message);
  const attachNote = attachCount > 0 ? `[${attachCount} attachment(s)]` : "";
  const body = [content, attachNote].filter(Boolean).join(" ") || "(no text)";
  return `${id} | ${stamp} | @${author}: ${body}${isAnchor ? ANCHOR_MARKER : ""}`;
}

/**
 * Render the whole window: one line per message oldest→newest, the
 * anchor marked, total capped at READ_DISCORD_TOTAL_CHAR_CAP
 * (code-point-safe). Pure.
 *
 * @param {object[]} messagesOldestFirst
 * @param {string|null} [anchorId]
 * @returns {string}
 */
function formatReadOutput(messagesOldestFirst, anchorId = null) {
  const joined = (messagesOldestFirst || [])
    .map((m) => formatReadLine(m, anchorId != null && String(m?.id) === String(anchorId)))
    .join("\n");
  return sliceSafe(joined, READ_DISCORD_TOTAL_CHAR_CAP);
}

/* ------------------------------ default deps ------------------------------ */

function defaultChannelResolver(guild, channelId) {
  return guild.channels.fetch(channelId);
}

function defaultMemberFetcher(guild, userId) {
  return guild.members.fetch(userId);
}

/**
 * `channel.messages.fetch` seam: `opts` is either a message id (single
 * fetch) or `{ limit, before?|after? }` (window fetch). Selection follows
 * the Discord REST contract: `before` → the `limit` messages NEAREST the
 * cursor (newer ones first, descending); `after` → the `limit` messages
 * NEAREST the cursor (older ones first, ascending); missing edges simply
 * return fewer. The executor re-sorts by id anyway, so response ORDER is
 * irrelevant — only the SELECTION matters.
 */
function defaultFetcher(channel, opts) {
  return channel.messages.fetch(opts);
}

/** `.has(flag)` probe that tolerates missing/garbage perm surfaces (true = proceed). */
function permsAllow(perms, flag) {
  if (!perms || typeof perms.has !== "function") return true;
  try {
    return perms.has(flag) === true;
  } catch {
    return false; // a throwing perm surface fails closed
  }
}

/* ------------------------------- windows ---------------------------------- */

/**
 * Channel window: the READ_DISCORD_CHANNEL_WINDOW most recent messages,
 * oldest→newest. Throws (executor converts to a failure string).
 */
async function fetchChannelWindow(channel, deps) {
  const page = await deps.fetcher(channel, { limit: READ_DISCORD_CHANNEL_WINDOW });
  return { messages: sortOldestFirst(toMessageArray(page)), anchorId: null };
}

/**
 * Message window: three exact fetches — the anchor (`fetch(id)`), up to
 * 40 `before:`, up to 10 `after:` — merged unique and sorted
 * oldest→newest. A missing/unfetchable anchor THROWS with the reason
 * (no partial-window fallback, decision 45).
 */
async function fetchMessageWindow(channel, messageId, deps) {
  const anchor = await deps.fetcher(channel, String(messageId));
  if (!anchor || !anchor.id) {
    const err = new Error("the linked message could not be read (deleted or unknown id)");
    err.readFailure = true;
    throw err;
  }
  const [before, after] = await Promise.all([
    deps.fetcher(channel, { limit: READ_DISCORD_BEFORE_WINDOW, before: String(anchor.id) }),
    deps.fetcher(channel, { limit: READ_DISCORD_AFTER_WINDOW, after: String(anchor.id) }),
  ]);
  const merged = new Map([[String(anchor.id), anchor]]);
  for (const m of toMessageArray(before)) merged.set(String(m.id), m);
  for (const m of toMessageArray(after)) merged.set(String(m.id), m);
  return {
    messages: sortOldestFirst([...merged.values()]),
    anchorId: String(anchor.id),
  };
}

/* ------------------------------- executor --------------------------------- */

/**
 * Execute the `read_discord` tool. NEVER throws, never rejects: every
 * failure resolves to `Could not read <target>: <reason>` so the tool
 * loop always continues (decision 47).
 *
 * @param {unknown} link raw `link` tool arg (string expected; parse lives here)
 * @param {object} [options]
 * @param {string} options.guildId current guild — the isolation anchor
 * @param {object} options.guild duck-typed guild (`channels.fetch`, `members.fetch`, `members.me`)
 * @param {string} options.askerId the asking user (parity gate subject)
 * @param {(guild: object, channelId: string) => Promise<object|null>} [options.channelResolver]
 * @param {(guild: object, userId: string) => Promise<object|null>} [options.memberFetcher]
 * @param {(channel: object, opts: object|string) => Promise<unknown>} [options.fetcher]
 * @param {object} [options.repo] db facade override (tests; default lazy `require("../../../db")`)
 * @returns {Promise<string>} message lines or the failure string
 */
async function executeReadDiscord(link, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  let parsed = null;
  try {
    parsed = parseDiscordLink(link);
    if (!parsed.ok) return failWith(null, link, parsed.reason);

    const guildId = opts.guildId == null ? "" : String(opts.guildId);
    const guild = opts.guild;
    const askerId = opts.askerId == null ? "" : String(opts.askerId);
    if (!guild || !guildId) {
      return failWith(parsed, link, "no guild context for this read");
    }

    // Guild isolation — BEFORE any fetch (decision 46): the guild id in
    // the link (message links and channel URLs carry one) must be this
    // guild; bare ids/mentions resolve in-guild only by construction.
    if (parsed.guildId && String(parsed.guildId) !== guildId) {
      return failWith(parsed, link, "that link points to another server");
    }

    // In-guild channel resolution.
    const channelResolver =
      typeof opts.channelResolver === "function"
        ? opts.channelResolver
        : defaultChannelResolver;
    let channel = null;
    try {
      channel = await channelResolver(guild, parsed.channelId);
    } catch (err) {
      return failWith(parsed, link, `channel lookup failed: ${err?.message || err}`);
    }
    if (!channel || !channel.id) {
      return failWith(parsed, link, "no channel with that id in this server");
    }

    // Only channels exposing a messages.fetch seam read (text channels,
    // threads, voice-text); forums/categories/garbage do not.
    const fetcher =
      typeof opts.fetcher === "function" ? opts.fetcher : defaultFetcher;
    if (!channel.messages || typeof channel.messages.fetch !== "function") {
      return failWith(parsed, link, "that channel does not expose readable messages");
    }

    // Open-ticket blackout (decision 46): an unarchived `tickets` row
    // makes the channel an unreachable read target for gork, period.
    const repo = opts.repo || require("../../../db");
    const ticket = repo.getTicketByChannel(String(channel.id));
    if (ticket && !ticket.archived) {
      return failWith(parsed, link, "that channel is an open help ticket");
    }

    // Asker parity: the asker — not just the bot — must hold ViewChannel
    // on the target. Member fetch failure fails closed.
    if (!askerId) {
      return failWith(parsed, link, "cannot identify the asking user");
    }
    const memberFetcher =
      typeof opts.memberFetcher === "function" ? opts.memberFetcher : defaultMemberFetcher;
    let askerMember = null;
    try {
      askerMember = await memberFetcher(guild, askerId);
    } catch (err) {
      return failWith(
        parsed,
        link,
        `could not check the asking user's access: ${err?.message || err}`,
      );
    }
    if (!askerMember) {
      return failWith(parsed, link, "the asking user is not a member of this server");
    }
    if (typeof channel.permissionsFor !== "function") {
      return failWith(parsed, link, "cannot verify the asking user's access to that channel");
    }
    let askerPerms = null;
    try {
      askerPerms = channel.permissionsFor(askerMember);
    } catch (err) {
      return failWith(
        parsed,
        link,
        `could not check the asking user's access: ${err?.message || err}`,
      );
    }
    if (!permsAllow(askerPerms, PermissionFlagsBits.ViewChannel)) {
      return failWith(parsed, link, "the asking user cannot view that channel");
    }

    // Bot-side readability: a bot without ViewChannel/ReadMessageHistory
    // gets a specific failure instead of a raw 50003 from the fetch.
    const botMember = guild.members?.me ?? null;
    if (botMember) {
      let botPerms = null;
      try {
        botPerms = channel.permissionsFor(botMember);
      } catch {
        botPerms = null;
      }
      if (!permsAllow(botPerms, PermissionFlagsBits.ViewChannel)) {
        return failWith(parsed, link, "the bot cannot view that channel");
      }
      if (!permsAllow(botPerms, PermissionFlagsBits.ReadMessageHistory)) {
        return failWith(parsed, link, "the bot cannot read message history there");
      }
    }

    // Windows (decision 45). Anchors fail loudly (no partial fallback);
    // channel pages degrade only through genuine API errors.
    const window =
      parsed.kind === "message"
        ? await fetchMessageWindow(channel, parsed.messageId, { fetcher })
        : await fetchChannelWindow(channel, { fetcher });

    if (!window.messages.length) {
      return `No messages to read in ${targetLabel(parsed, link)}.`;
    }
    return formatReadOutput(window.messages, window.anchorId);
  } catch (err) {
    if (err?.readFailure) return failWith(parsed, link, err.message);
    return failWith(
      parsed,
      link,
      `message fetch failed: ${err?.message || String(err)}`,
    );
  }
}

module.exports = Object.freeze({
  READ_DISCORD_TOOL,
  executeReadDiscord,
  parseDiscordLink,
  formatReadLine,
  formatReadOutput,
  ANCHOR_MARKER,
});
