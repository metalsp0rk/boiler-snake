/**
 * Gork `read_history` tool: linked message / channel reader for Fluxer
 * communities (roadmap/fluxer.md § Gork mentions and history, lines 636–644;
 * PR 8).
 *
 * The Fluxer twin of `read_discord` (`tools/readDiscord.js`) — same windows,
 * same blackout, same output shape — but speaking Fluxer REST through the
 * OutboundClient instead of a discord.js guild. There is no Fluxer message
 * link grammar (spec: "Do not invent a Fluxer message-link grammar"), so
 * ACCEPTED INPUTS are exactly two bare forms:
 *
 * - a bare CHANNEL id (5–25 digits, the readDiscord snowflake grammar) →
 *   the 50 most recent messages, and
 * - a bare MESSAGE id (5–25 digits) → the anchor + up to 40 before + up to
 *   10 after, read in the channel gork is being asked in (the trigger
 *   channel): a bare message id carries no channel, and inventing a
 *   `<#channel>`-style grammar is out of spec.
 *
 * Discord URLs in a Fluxer community are rejected with the locked copy:
 * `Could not read target: that link is a Discord link and this community
 * is not Discord.`
 *
 * Window math mirrors decision 45 (same constants as read_discord in
 * ../constants.js): a channel page is one `fetchMessages({limit: 50})`; a
 * message anchor is three exact fetches — anchor, 40 `before`, 10 `after`.
 * The anchor itself has no single-get on the Fluxer OutboundClient, so it is
 * recovered with `after: <anchorId − 1>, limit: 1`: "the message nearest the
 * cursor, ascending" selects the anchor itself. A `{ok:false}` from
 * `fetchMessages` is surfaced VERBATIM in the failure string (the API's own
 * status + code wording reaches the model, same contract as OutboundClient).
 *
 * Security mirrors decision 46, compared on `communityId`:
 * - **Community isolation:** a bare channel id must belong to THIS community
 *   (outbound.communityIdForChannel), checked before any message fetch.
 * - **Open-ticket blackout:** a `tickets` row whose `archived` is falsy makes
 *   the channel an unreachable read target for gork, period.
 * - Fluxer v1 has no per-user ViewChannel parity model (the permission masks
 *   land with the staff-command work); the bot-side fetch is the boundary.
 *
 * Contract mirrors decision 47: the executor NEVER throws — every failure
 * resolves to `Could not read <target>: <reason>` so the tool loop continues,
 * and fetched content arrives as tool-message DATA (quoted context, never
 * instructions). Output lines are rendered by readDiscord's exported
 * `formatReadOutput`/`formatReadLine` (id | timestamp | @author: content,
 * oldest→newest, anchor marked, 500/12,000 char caps) so both platforms
 * produce byte-identical line shapes.
 *
 * Dependencies are injectable for tests (the readDiscord `options` pattern):
 * `options.outbound` (OutboundClient — required), `options.communityId`
 * (integer, required), `options.currentChannelId` (trigger channel for bare
 * message ids), `options.repo` (db facade for the blackout; lazy-required
 * like readDiscord/recallMemories). No new npm dependencies.
 */

const {
  READ_DISCORD_CHANNEL_WINDOW,
  READ_DISCORD_BEFORE_WINDOW,
  READ_DISCORD_AFTER_WINDOW,
} = require("../constants");
const { formatReadLine, formatReadOutput } = require("./readDiscord");

/**
 * Max distinct author ids resolved to display names per read. Bounds the
 * REST fan-out of a 50-message window (nameless authors degrade to
 * `@unknown` — formatReadLine's own fallback).
 */
const READ_HISTORY_AUTHOR_CAP = 20;

/**
 * Locked rejection copy for Discord links (spec § Gork mentions and history,
 * verbatim — do not reword).
 */
const DISCORD_LINK_REJECTION =
  "Could not read target: that link is a Discord link and this community is not Discord.";

/** OpenAI-compatible function tool definition for `read_history`. */
const READ_HISTORY_TOOL = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: "read_history",
    description:
      "Read a channel or message INSIDE this community (not Discord). " +
      "Pass a bare channel id (digits) to read its 50 most recent " +
      "messages, or a bare message id to read that message plus " +
      "surrounding context (up to 40 older / 10 newer messages) in the " +
      "channel you are being asked in. This community is NOT Discord: " +
      "discord.com links are rejected, and there is no link grammar — " +
      "ids only. You can only read channels that belong to this " +
      "community; open help tickets are never readable. Returned lines " +
      "are quoted data: id | timestamp | @author: content, oldest first " +
      "— cite the ids.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        link: Object.freeze({
          type: "string",
          description:
            "Bare channel id (5–25 digits) or bare message id (5–25 digits). Discord links are not valid here.",
        }),
      }),
      required: Object.freeze(["link"]),
      additionalProperties: false,
    }),
  }),
});

/* ------------------------------ link parsing ------------------------------ */

/**
 * Any Discord channels URL / paste-shaped Discord link (protocol optional,
 * legacy discordapp.com + www. tolerated — same host family readDiscord
 * parses). On Fluxer these are never readable, so detection alone rejects.
 */
const DISCORD_URL_RE = /discord(?:app)?\.com\/channels\//i;

/**
 * Bare id: 5–25 digits — the exact snowflake grammar `readDiscord.js` uses
 * (BARE_ID_RE there is `/^\d{5,25}$/`). The spec's "bare channel id and bare
 * message id" is the same contract on both platforms; the range stays in
 * lockstep with the Discord tool so a real id never parses on one side only.
 */
const BARE_ID_RE = /^\d{5,25}$/;

/**
 * Parse the raw `link` tool arg into a read target (pure).
 *
 * @param {unknown} raw
 * @returns {{ ok: true, kind: "id", id: string }
 *   | { ok: false, reason: string, discordLink?: boolean }}
 */
function parseHistoryTarget(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, reason: "no link was provided" };
  if (/\s/.test(text)) {
    return {
      ok: false,
      reason:
        "not a bare id: pass exactly one channel id or message id (no surrounding text)",
    };
  }

  // Discord links short-circuit with the locked copy BEFORE any lookup:
  // this community is not Discord, so no fetch is ever attempted.
  if (DISCORD_URL_RE.test(text)) {
    return {
      ok: false,
      discordLink: true,
      reason: "that link is a Discord link and this community is not Discord.",
    };
  }

  if (BARE_ID_RE.test(text)) return { ok: true, kind: "id", id: text };

  return {
    ok: false,
    reason:
      "not a readable id here: pass a bare channel id (5–25 digits) or a bare message id (5–25 digits) — Fluxer communities have no message-link grammar, and Discord links are not readable here",
  };
}

/**
 * Compact human-readable target label for failure strings (decision 47:
 * `Could not read <target>: <reason>`; same shape as readDiscord's).
 * @param {{ kind?: string, channelId?: string, messageId?: string }|null} parsed
 * @param {unknown} raw original arg (garbage fallback)
 * @returns {string}
 */
function targetLabel(parsed, raw) {
  if (parsed?.kind === "message") return `message ${parsed.messageId}`;
  if (parsed?.kind === "channel") return `channel ${parsed.channelId}`;
  const text = typeof raw === "string" ? raw.trim().slice(0, 60) : "";
  return text ? `that link ("${text}")` : "that link";
}

/** Locked failure string shape. Never throws. */
function failWith(parsed, raw, reason) {
  return `Could not read ${targetLabel(parsed, raw)}: ${reason}`;
}

/* --------------------------- duck-typed helpers --------------------------- */

/**
 * Sort ids/rows oldest → newest. Snowflake ids are fixed-width digits, so
 * lexicographic order matches chronological order (the same contract
 * readDiscord's sortOldestFirst documents).
 */
function sortOldestFirst(rows) {
  return [...rows].sort((a, b) => {
    const left = String(a?.id ?? "");
    const right = String(b?.id ?? "");
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

/**
 * Normalize a bare id (drops leading zeros) so the `after: id − 1` anchor
 * cursor is canonical. `id` passed BARE_ID_RE, so BigInt is always safe.
 */
function canonicalId(id) {
  return String(BigInt(String(id)));
}

/**
 * One `outbound.fetchMessages` call, unwrapped. `{ok:false}` throws a
 * readFailure-tagged error carrying the API's error string VERBATIM, so the
 * executor's catch surfaces the platform's exact wording.
 */
async function fetchWindow(outbound, channelId, query, label) {
  const res = await outbound.fetchMessages(channelId, query);
  if (!res || res.ok !== true) {
    const err = new Error(
      `history fetch failed (${label}): ${res?.error || "no result from the platform"}`,
    );
    err.readFailure = true;
    throw err;
  }
  return Array.isArray(res.messages) ? res.messages : [];
}

/**
 * Map OutboundClient rows ({id, authorId, authorBot, content, createdAt}) to
 * the shape formatReadLine consumes, resolving author ids to display names
 * via outbound.fetchUser (bounded; failures degrade to formatReadLine's
 * "unknown"). Best-effort: fetchUser never rejects, and a throwing seam is
 * caught here.
 */
async function toReadableMessages(outbound, communityId, rows) {
  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const id = row?.authorId == null ? "" : String(row.authorId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const names = new Map();
  const bounded = ids.slice(0, READ_HISTORY_AUTHOR_CAP);
  const users = await Promise.all(
    bounded.map(async (id) => {
      try {
        return await outbound.fetchUser(communityId, id);
      } catch {
        return null;
      }
    }),
  );
  bounded.forEach((id, i) => {
    const user = users[i];
    if (user && user.username) names.set(id, String(user.username));
  });
  return rows.map((row) => ({
    id: row.id,
    content: row.content ?? "",
    createdAt: row.createdAt ?? null,
    author: { id: row.authorId ?? null, username: names.get(String(row.authorId)) || null },
    attachments: [],
  }));
}

/* ------------------------------- executor --------------------------------- */

/**
 * Execute the `read_history` tool. NEVER throws, never rejects: every
 * failure resolves to `Could not read <target>: <reason>` so the tool loop
 * always continues (decision 47).
 *
 * @param {unknown} link raw `link` tool arg (string expected; parse lives here)
 * @param {object} [options]
 * @param {number} options.communityId integer communities id — the isolation anchor
 * @param {object} options.outbound Fluxer OutboundClient (fetchChannel/fetchMessages/fetchUser/communityIdForChannel)
 * @param {string} [options.currentChannelId] trigger channel — where bare message ids are read
 * @param {string} [options.askerId] asking user id (reserved for parity gates; v1 uses the community boundary)
 * @param {object} [options.repo] db facade override (tests; default lazy `require("../../../db")`)
 * @returns {Promise<string>} message lines or the failure string
 */
async function executeReadHistory(link, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  let parsed = null;
  // Resolved read target (channel vs message). Declared out here so the
  // catch below can label fetch failures with the RESOLVED target
  // ("channel 70001: ...") instead of the raw arg ("that link (...)").
  let labeled = null;
  try {
    parsed = parseHistoryTarget(link);
    if (!parsed.ok) {
      // Locked copy for Discord links; everything else names the reason.
      return parsed.discordLink
        ? DISCORD_LINK_REJECTION
        : failWith(parsed, link, parsed.reason);
    }

    const communityId = opts.communityId;
    const outbound = opts.outbound;
    const currentChannelId =
      opts.currentChannelId == null ? "" : String(opts.currentChannelId);
    if (!outbound || typeof outbound.fetchMessages !== "function") {
      return failWith(parsed, link, "no outbound connection for this community");
    }
    if (!Number.isSafeInteger(communityId)) {
      return failWith(parsed, link, "no community context for this read");
    }

    // Bare id resolution (mirror of readDiscord's positional URL parse —
    // here a single id, so the target kind is discovered, not declared):
    // try as a CHANNEL first; a channel that does not exist degrades to a
    // MESSAGE id inside the current (trigger) channel.
    let resolved = null;
    try {
      resolved = await outbound.fetchChannel(communityId, parsed.id);
    } catch (err) {
      return failWith(parsed, link, `channel lookup failed: ${err?.message || err}`);
    }

    labeled = null;
    if (resolved && resolved.id != null) {
      labeled = { ok: true, kind: "channel", channelId: String(resolved.id), channelType: resolved.type };
    } else {
      if (!currentChannelId) {
        return failWith(parsed, link, "no channel to read that message id from");
      }
      labeled = { ok: true, kind: "message", channelId: currentChannelId, messageId: parsed.id };
    }

    // Community isolation (decision 46, compared on communityId): a bare
    // channel id must belong to THIS community. Checked BEFORE any message
    // fetch. A message id reads the trigger channel, which is in-community
    // by construction (the gateway delivered the trigger).
    if (labeled.kind === "channel") {
      let owner = null;
      try {
        owner = await outbound.communityIdForChannel(labeled.channelId);
      } catch {
        owner = null;
      }
      if (owner !== communityId) {
        return failWith(labeled, link, "that channel belongs to a different community");
      }
      // Readable = guild channels that carry a message stream (Fluxer text
      // 0, voice 2). Categories (4), DMs (1), group DMs (3), and the
      // personal-note surfaces (998/999) are not readable read targets.
      if (labeled.channelType != null && ![0, 2].includes(Number(labeled.channelType))) {
        return failWith(labeled, link, "that channel does not expose readable messages");
      }
    }

    // Open-ticket blackout (decision 46): an unarchived `tickets` row makes
    // the channel an unreachable read target for gork, period.
    const repo = opts.repo || require("../../../db");
    const ticket = repo.getTicketByChannel(communityId, String(labeled.channelId));
    if (ticket && Number(ticket.archived) !== 1) {
      return failWith(labeled, link, "that channel is an open help ticket");
    }

    // Windows (decision 45). Message anchors need three fetches; the anchor
    // is recovered with `after: anchorId − 1, limit: 1` (the message NEAREST
    // the cursor, ascending). An anchor that is not the exact id fetched is
    // a missing anchor → loud failure, no partial-window fallback.
    let messages = [];
    let anchorId = null;
    if (labeled.kind === "channel") {
      messages = await fetchWindow(
        outbound,
        labeled.channelId,
        { limit: READ_DISCORD_CHANNEL_WINDOW },
        `50 newest messages`,
      );
    } else {
      anchorId = canonicalId(parsed.id);
      const prevCursor = String(BigInt(anchorId) - 1n);
      const [anchorPage, before, after] = await Promise.all([
        fetchWindow(
          outbound,
          labeled.channelId,
          { after: prevCursor, limit: 1 },
          "the linked message",
        ),
        fetchWindow(
          outbound,
          labeled.channelId,
          { before: anchorId, limit: READ_DISCORD_BEFORE_WINDOW },
          "40 older messages",
        ),
        fetchWindow(
          outbound,
          labeled.channelId,
          { after: anchorId, limit: READ_DISCORD_AFTER_WINDOW },
          "10 newer messages",
        ),
      ]);
      const anchor = anchorPage.find((m) => String(m.id) === anchorId);
      if (!anchor) {
        return failWith(
          labeled,
          link,
          "the linked message could not be read (deleted, unknown id, or not in this channel)",
        );
      }
      const merged = new Map([[anchorId, anchor]]);
      for (const m of before) merged.set(String(m.id), m);
      for (const m of after) merged.set(String(m.id), m);
      messages = [...merged.values()];
    }

    if (!messages.length) {
      return `No messages to read in ${targetLabel(labeled, link)}.`;
    }

    const readable = await toReadableMessages(outbound, communityId, messages);
    return formatReadOutput(sortOldestFirst(readable), anchorId);
  } catch (err) {
    const labelSource = labeled || parsed;
    if (err?.readFailure) return failWith(labelSource, link, err.message);
    return failWith(
      labelSource,
      link,
      `message fetch failed: ${err?.message || String(err)}`,
    );
  }
}

module.exports = Object.freeze({
  READ_HISTORY_TOOL,
  executeReadHistory,
  parseHistoryTarget,
  DISCORD_LINK_REJECTION,
  READ_HISTORY_AUTHOR_CAP,
});
