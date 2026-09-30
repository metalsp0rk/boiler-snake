/**
 * `/gork summarize` range reader (roadmap/gork.md §7.21.2; proposed decision 54).
 *
 * Resolves exactly three discrete anchor modes into one oldest→newest
 * transcript window of a single channel:
 *
 * 1. `from` + `to` — closed range, both anchors inclusive; swapped when
 *                    `from` is newer than `to`.
 * 2. `from` alone  — the anchor through the newest readable message.
 * 3. `last:<N>`    — the newest N readable messages, reversed to oldest→newest.
 *
 * Anchor grammar reuses the `parseDiscordLink` / `formatReadLine` exports of
 * `tools/readDiscord.js` (§7.19) — that module is NOT modified. A full
 * message link carries its own channel; a bare message id is accepted only
 * together with `channel:` (or the invocation channel passed as
 * `fallbackChannelId`). Links pointing to another guild are rejected BEFORE
 * any fetch (decision 46 guild isolation); both anchors must resolve to the
 * SAME channel (the same-channel rule keeps §7.19 read semantics untouched).
 *
 * Reading: `from`-anchored modes paginate `channel.messages.fetch` with
 * `after:` from the anchor toward `to`/newest; `last:<N>` paginates with
 * `before:` from the newest message backwards. Two phases per §7.21.2:
 * - SCAN: collect readable messages (system messages skipped, bots kept)
 *   until the range ends or the GORK_SUMMARIZE_RANGE_MAX_MESSAGES (1,000)
 *   hard cap bites — the cap bounds Discord work; disclosure is mandatory.
 * - BUDGET: the transcript keeps the largest window fitting the guild's
 *   summarize INPUT token budget (options.tokenBudget, default 80,000 tokens
 *   via gork_summarize_input_tokens) converted to a transcript char cap by
 *   summarizeInputTokenCapChars() — 4 chars/token minus the prompt-zone
 *   reserve, 312,000 chars at the default; code-point-safe via sliceSafe.
 *   The oldest-first PREFIX for from-modes ("oldest-first from
 *   the from anchor until a cap bites"), the newest SUFFIX for `last:` (the
 *   largest window that fits — the newest messages are the ones `last:`
 *   asked for). Per-message caps + attachment collapse live in
 *   formatReadLine.
 *
 * Lines are the §7.19 format `id | timestamp | @author: content`; bot AND
 * webhook messages ride along labeled `id | timestamp | @author [bot]:
 * content` (decision 54). Discord system messages (joins, pins, calls) are
 * skipped — not conversational content.
 *
 * Security inherits decision 46 wholesale, mirroring readDiscord.js's
 * checks and ORDER: guild isolation (before any fetch), in-guild channel
 * resolution, the `messages.fetch` seam requirement, the open-ticket
 * blackout, invoker ViewChannel parity (fails closed), bot
 * ViewChannel/ReadMessageHistory readability.
 *
 * Contract: NEVER throws (decision 47 culture). Every failure resolves to
 * `{ ok: false, code, error }` with a specific reason the handler can reply
 * with verbatim; mid-range fetch failures disclose how much of the range
 * was read first (repo partial-results rule). Success returns the window
 * ACTUALLY delivered (`firstId`/`lastId`/`count`) plus the clamp disclosure.
 *
 * Dependencies are injectable for tests (readDiscord.js pattern):
 * `options.channelResolver`, `options.memberFetcher`, `options.fetcher`,
 * `options.repo`, `options.tokenBudget`. No new npm deps; the transcript
 * budget is per-guild configurable (gork_summarize_input_tokens, default
 * 80,000 input tokens → summarizeInputTokenCapChars()).
 */

const { PermissionFlagsBits } = require("discord.js");
const { sliceSafe } = require("../../core/text");
const { parseDiscordLink, formatReadLine } = require("./tools/readDiscord");
const { discordCommunityId } = require("../../platform/community");
const {
  READ_DISCORD_CHANNEL_WINDOW,
  GORK_SUMMARIZE_RANGE_MAX_MESSAGES,
  GORK_SUMMARIZE_LAST_MIN,
  GORK_SUMMARIZE_LAST_MAX,
  clampSummarizeInputTokens,
  summarizeInputTokenCapChars,
} = require("./constants");

/**
 * `after:`/`before:` page size — REUSES the read_discord window constant
 * (50) instead of introducing a new one (§7.21.2: no new constants).
 */
const SUMMARIZE_PAGE_SIZE = READ_DISCORD_CHANNEL_WINDOW;

/** The three discrete modes (exactly one per read). */
const MODE_CLOSED = "from-to";
const MODE_FROM_NOW = "from-now";
const MODE_LAST = "last";

/** Every mode-exclusivity usage error quotes this sentence naming the three modes. */
const MODE_HELP =
  "Give exactly one range: from:+to: (closed range), from: alone (through the newest message), or last:<N>";

/* ------------------------------ tiny helpers ------------------------------ */

/** Non-empty trimmed string presence (option "was provided"). */
function hasText(value) {
  return value != null && String(value).trim() !== "";
}

/** Locked service-boundary failure shape. Never throws. */
function fail(code, error) {
  return { ok: false, code, error };
}

/**
 * Lexicographic snowflake compare — fixed-width ids make lexicographic
 * order chronological (same contract as readDiscord.js's sorter).
 */
function idCmp(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Discord REST order (newest → oldest); Collection or array tolerated. */
function toMessageArray(result) {
  if (Array.isArray(result)) return result.filter(Boolean);
  if (result && typeof result.values === "function") {
    return [...result.values()].filter(Boolean);
  }
  if (result && typeof result === "object" && result.id) return [result];
  return [];
}

const sortOldestFirst = (messages) => [...messages].sort((a, b) => idCmp(a?.id, b?.id));
const sortNewestFirst = (messages) => [...messages].sort((a, b) => idCmp(b?.id, a?.id));

/** `.has(flag)` probe tolerating missing/garbage perm surfaces (true = proceed). */
function permsAllow(perms, flag) {
  if (!perms || typeof perms.has !== "function") return true;
  try {
    return perms.has(flag) === true;
  } catch {
    return false; // a throwing perm surface fails closed
  }
}

/**
 * Discord system message (joins, pins, call starts) — skipped as
 * non-conversational (§7.21.2). `Message#system` is the authoritative
 * boolean (userActivity/service.js precedent); the `type` fallbacks cover
 * raw payloads (0 = Default, 19 = Reply are the conversational types).
 */
function isSystemMessage(message) {
  if (typeof message?.system === "boolean") return message.system;
  const type = message?.type;
  if (typeof type === "string") return type.length > 0 && !/^(default|reply)$/i.test(type);
  return typeof type === "number" && type !== 0 && type !== 19;
}

/** Bot OR webhook message — both ride along labeled `[bot]` (decision 54). */
function isBotMessage(message) {
  if (message?.author?.bot === true) return true;
  return message?.webhookId != null && message?.webhookId !== "";
}

/**
 * One readable message as a §7.19 line; bots/webhooks reuse the SAME
 * formatter through a copied author slot so the format never forks:
 * `id | timestamp | @author [bot]: content`.
 */
function formatTranscriptLine(message) {
  if (!isBotMessage(message)) return formatReadLine(message);
  const author = message?.author?.username || "unknown";
  return formatReadLine({ ...message, author: { username: `${author} [bot]` } });
}

/* ------------------------------- mode gate -------------------------------- */

/**
 * Pure mode-exclusivity check (§7.21.1): exactly one of from+to / from /
 * last; any other combination is a usage error naming the three modes.
 * Exported so the command handler (subtask 08) replies with the SAME
 * strings the service boundary uses.
 *
 * @param {{ from?: unknown, to?: unknown, last?: unknown }} [args]
 * @returns {{ ok: true, mode: string, last?: number }
 *   | { ok: false, code: "usage", error: string }}
 */
function validateSummarizeMode({ from, to, last } = {}) {
  const hasFrom = hasText(from);
  const hasTo = hasText(to);
  const hasLast = last != null && String(last).trim() !== "";
  if (hasFrom && hasLast) {
    return fail("usage", `${MODE_HELP} — got both from: and last:.`);
  }
  if (hasTo && !hasFrom) {
    return fail("usage", `${MODE_HELP} — got to: without a from: anchor.`);
  }
  if (!hasFrom && !hasLast) {
    return fail("usage", `${MODE_HELP} — none was given.`);
  }
  if (hasLast) {
    const raw = String(last).trim();
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < GORK_SUMMARIZE_LAST_MIN || n > GORK_SUMMARIZE_LAST_MAX) {
      return fail(
        "usage",
        `last: must be an integer between ${GORK_SUMMARIZE_LAST_MIN} and ${GORK_SUMMARIZE_LAST_MAX} — got "${raw}".`,
      );
    }
    return { ok: true, mode: MODE_LAST, last: n };
  }
  return { ok: true, mode: hasTo ? MODE_CLOSED : MODE_FROM_NOW };
}

/* ---------------------------- anchor resolution ---------------------------- */

/** Compact preview of a raw option for error strings. */
function optionPreview(raw) {
  return sliceSafe(String(raw).trim(), 60);
}

/**
 * Resolve a `from:`/`to:` option to an anchor target (pure). Message links
 * carry their own channel; a bare numeric id needs the channel default
 * (`channel:` option or the invocation channel); channel URLs / `<#…>`
 * mentions are NOT message anchors (§7.21.1).
 *
 * @returns {{ ok: true, guildId: string|null, channelId: string, messageId: string }
 *   | { ok: false, code: "usage", error: string }}
 */
function resolveMessageAnchor(raw, label, defaultChannelId) {
  const parsed = parseDiscordLink(raw);
  if (!parsed.ok) {
    return fail(
      "usage",
      `${label}: "${optionPreview(raw)}" is not a Discord message link or message id — paste a full message link, or a bare message id together with channel:.`,
    );
  }
  if (parsed.kind === "channel") {
    const rawText = String(raw).trim();
    if (parsed.guildId != null || rawText.startsWith("<#")) {
      return fail(
        "usage",
        `${label}: "${optionPreview(raw)}" points at a channel, not a message — paste a message link (discord.com/channels/<guild>/<channel>/<message>) or a bare message id.`,
      );
    }
    // Bare numeric id: a MESSAGE id only when a channel context exists.
    if (!defaultChannelId) {
      return fail(
        "usage",
        `${label}: "${optionPreview(raw)}" is a bare message id — add channel: (or run the command in the target channel) so the message's channel is known.`,
      );
    }
    return { ok: true, guildId: null, channelId: defaultChannelId, messageId: parsed.channelId };
  }
  return {
    ok: true,
    guildId: parsed.guildId ?? null,
    channelId: parsed.channelId,
    messageId: parsed.messageId,
  };
}

/**
 * Resolve the `channel:` option (pure). Any parseable Discord form works —
 * its channel part is used (a message link's channel is still that
 * message's channel; the message part simply is not needed here).
 */
function resolveChannelOption(raw) {
  const parsed = parseDiscordLink(raw);
  if (!parsed.ok) {
    return fail("usage", `channel: "${optionPreview(raw)}" is not a channel mention, channel link, or channel id.`);
  }
  return { ok: true, guildId: parsed.guildId ?? null, channelId: parsed.channelId };
}

/* --------------------------- security (decision 46) --------------------------- */

/**
 * Resolve the target channel and run every decision-46 gate, mirroring
 * readDiscord.js's checks and ORDER: channel lookup → messages seam →
 * open-ticket blackout → invoker ViewChannel parity (fails closed) → bot
 * ViewChannel/ReadMessageHistory. Each refusal carries its own specific
 * reason string (acceptance: distinct specific error reasons).
 *
 * @returns {Promise<{ ok: true, channel: object } | { ok: false, code: string, error: string }>}
 */
async function ensureReadableChannel({ guild, channelId, invokerId, deps }) {
  const channelResolver =
    typeof deps.channelResolver === "function" ? deps.channelResolver : (g, id) => g.channels.fetch(id);

  let channel = null;
  try {
    channel = await channelResolver(guild, channelId);
  } catch (err) {
    return fail("fetch", `Channel lookup for ${channelId} failed: ${err?.message || err}`);
  }
  if (!channel || !channel.id) {
    return fail("notfound", `No channel ${channelId} in this server.`);
  }
  // Only channels exposing a messages.fetch seam read (text channels,
  // threads, voice-text); forums/categories stay refused exactly as in
  // read_discord (§7.21.1).
  if (!channel.messages || typeof channel.messages.fetch !== "function") {
    return fail("usage", `Channel ${channel.id} does not expose readable messages (forums and categories are not readable).`);
  }

  // Open-ticket blackout (decision 46): an unarchived `tickets` row makes
  // the channel an unreachable read target — live tickets belong to the
  // ticket close flow (§7.21.2 extends decision 19).
  const repo = deps.repo || require("../../db");
  let ticket = null;
  try {
    // Fluxer PR 2: the tickets repo is community-keyed; resolve the integer.
    ticket = repo.getTicketByChannel(discordCommunityId(String(guild.id)), String(channel.id));
  } catch (err) {
    return fail("internal", `Could not check the ticket status of channel ${channel.id}: ${err?.message || err}`);
  }
  if (ticket && !ticket.archived) {
    return fail(
      "security",
      `Channel ${channel.id} is an open help ticket — live tickets are covered by the ticket close flow, not /gork summarize.`,
    );
  }

  // Invoker parity: the invoking staff member — not just the bot — must
  // hold ViewChannel on the target. Member fetch failure fails closed.
  if (!invokerId) {
    return fail("security", "Cannot identify the invoking user for the ViewChannel check.");
  }
  const memberFetcher =
    typeof deps.memberFetcher === "function" ? deps.memberFetcher : (g, id) => g.members.fetch(id);
  let invokerMember = null;
  try {
    invokerMember = await memberFetcher(guild, invokerId);
  } catch (err) {
    return fail("security", `Could not check the invoking user's access: ${err?.message || err}`);
  }
  if (!invokerMember) {
    return fail("security", "The invoking user is not a member of this server.");
  }
  if (typeof channel.permissionsFor !== "function") {
    return fail("security", `Cannot verify the invoking user's access to channel ${channel.id}.`);
  }
  let invokerPerms = null;
  try {
    invokerPerms = channel.permissionsFor(invokerMember);
  } catch (err) {
    return fail("security", `Could not check the invoking user's access: ${err?.message || err}`);
  }
  if (!permsAllow(invokerPerms, PermissionFlagsBits.ViewChannel)) {
    return fail(
      "security",
      `The invoking user cannot view channel ${channel.id} — only channels they can already see can be summarized.`,
    );
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
      return fail("security", `The bot cannot view channel ${channel.id}.`);
    }
    if (!permsAllow(botPerms, PermissionFlagsBits.ReadMessageHistory)) {
      return fail("security", `The bot cannot read message history in channel ${channel.id}.`);
    }
  }

  return { ok: true, channel };
}

/* ------------------------------ fetch helpers ------------------------------ */

/** Progress marker the never-throws boundary turns into a partial-range error. */
function makeProgress(channelId) {
  return { count: 0, firstId: null, lastId: null, channelId };
}

/** Refresh the progress marker from the collected run (either collection order). */
function touchProgress(progress, messages, oldestFirst) {
  progress.count = messages.length;
  const oldest = oldestFirst ? messages[0] : messages[messages.length - 1];
  const newest = oldestFirst ? messages[messages.length - 1] : messages[0];
  progress.firstId = oldest?.id != null ? String(oldest.id) : null;
  progress.lastId = newest?.id != null ? String(newest.id) : null;
}

/** Wrap a page-fetch rejection so the boundary can report the partial range. */
async function fetchPage(channel, fetcher, opts, progress) {
  try {
    return await fetcher(channel, opts);
  } catch (err) {
    const wrapped = new Error(err?.message != null ? String(err.message) : String(err));
    wrapped.failCode = "fetch";
    wrapped.pageFailure = true;
    throw wrapped;
  }
}

/**
 * Single-message anchor fetch. Missing → specific "deleted or unknown id"
 * (decision 54's handler-surfaced failure); a rejection keeps code "fetch".
 */
async function fetchAnchor(channel, fetcher, messageId, label) {
  let message = null;
  try {
    message = await fetcher(channel, String(messageId));
  } catch (err) {
    const wrapped = new Error(
      `The ${label}: message ${messageId} in channel ${channel.id} could not be read: ${err?.message || err}`,
    );
    wrapped.failCode = "fetch";
    throw wrapped;
  }
  if (!message || !message.id) {
    const wrapped = new Error(
      `The ${label}: message ${messageId} in channel ${channel.id} could not be read (deleted or unknown id).`,
    );
    wrapped.failCode = "notfound";
    throw wrapped;
  }
  return message;
}

/* --------------------------------- scanning --------------------------------- */

/**
 * Forward scan (from+to / from→now): the from anchor itself first
 * (inclusive), then `after:` pages toward `to` or the newest message,
 * oldest→newest. System messages are skipped and never count toward the
 * cap; readable messages collect up to GORK_SUMMARIZE_RANGE_MAX_MESSAGES,
 * after which ONE peek distinguishes "the cap bit with range left"
 * (clamp-and-disclose) from "the range ended exactly at the cap".
 *
 * @returns {Promise<{ messages: object[], clampReasons: string[] }>}
 */
async function scanForward(channel, fetcher, fromMessage, toAnchorId, progress) {
  const messages = [];
  const clampReasons = [];
  let reachedEnd = false;
  let cursor = String(fromMessage.id);
  if (!isSystemMessage(fromMessage)) messages.push(fromMessage); // anchors are inclusive
  touchProgress(progress, messages, true);

  while (!reachedEnd && messages.length < GORK_SUMMARIZE_RANGE_MAX_MESSAGES) {
    const page = sortOldestFirst(
      toMessageArray(await fetchPage(channel, fetcher, { limit: SUMMARIZE_PAGE_SIZE, after: cursor }, progress)),
    );
    if (!page.length) {
      reachedEnd = true; // nothing newer exists — from→now is done
      break;
    }
    for (const msg of page) {
      cursor = String(msg.id);
      if (toAnchorId != null && idCmp(msg.id, toAnchorId) > 0) {
        reachedEnd = true; // walked past `to` — the closed range is done
        break;
      }
      if (isSystemMessage(msg)) continue;
      messages.push(msg);
      touchProgress(progress, messages, true);
      if (messages.length >= GORK_SUMMARIZE_RANGE_MAX_MESSAGES) break;
    }
  }

  if (!reachedEnd && messages.length >= GORK_SUMMARIZE_RANGE_MAX_MESSAGES) {
    // At the hard cap without finishing the range: one cheap peek proves
    // whether unread readable-range content actually remains ahead
    // (clamp-and-disclose) or the range ended exactly at the cap.
    const peek = sortOldestFirst(
      toMessageArray(await fetchPage(channel, fetcher, { limit: 1, after: cursor }, progress)),
    );
    const next = peek[0];
    if (!next || (toAnchorId != null && idCmp(next.id, toAnchorId) > 0)) reachedEnd = true;
    else clampReasons.push("messages");
  }
  return { messages, clampReasons };
}

/**
 * Backward scan (last:N): `before:` pages from the newest message
 * backwards (first page has no cursor). Collected newest→oldest so the
 * budget phase keeps the NEWEST suffix — the largest window that fits;
 * caller reverses. `stop=count` (N filled) and page exhaustion are both
 * natural, never clamps.
 *
 * @returns {Promise<{ messages: object[], clampReasons: string[] }>}
 */
async function scanBackward(channel, fetcher, requestedN, progress) {
  const messages = [];
  const clampReasons = [];
  const limit = Math.min(requestedN, GORK_SUMMARIZE_RANGE_MAX_MESSAGES);
  if (limit < requestedN) clampReasons.push("messages"); // defensive: builder bounds make this unreachable
  let cursor = null;
  let stop = false;
  while (!stop) {
    const opts =
      cursor == null
        ? { limit: SUMMARIZE_PAGE_SIZE }
        : { limit: SUMMARIZE_PAGE_SIZE, before: cursor };
    const page = sortNewestFirst(toMessageArray(await fetchPage(channel, fetcher, opts, progress)));
    if (!page.length) break; // no more history — natural end
    for (const msg of page) {
      cursor = String(msg.id);
      if (messages.length >= limit) {
        stop = true; // N filled — natural end of the LAST window
        break;
      }
      if (isSystemMessage(msg)) continue;
      messages.push(msg);
      touchProgress(progress, messages, false);
    }
    if (!stop && page.length < SUMMARIZE_PAGE_SIZE) break; // reached the oldest edge
  }
  return { messages, clampReasons };
}

/* ------------------------------ budget window ------------------------------ */

/**
 * Largest PREFIX (in the given order) of whole lines that fits
 * `totalCharCap` (derived from the guild's summarize input token budget).
 * The very first line always rides, sliced
 * code-point-safe if it alone overflows (never an empty transcript when
 * something readable was found). `lines`/`messages` are parallel.
 *
 * @param {object[]} messages scanned messages (parallel to `lines`)
 * @param {string[]} lines formatted transcript lines
 * @param {number} totalCharCap transcript char budget for this read
 * @returns {{ pairs: {msg: object, line: string}[], clampedByChars: boolean }}
 */
function fitBudget(messages, lines, totalCharCap) {
  const pairs = [];
  let used = 0;
  let clampedByChars = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (pairs.length === 0) {
      const kept = sliceSafe(line, totalCharCap);
      pairs.push({ msg: messages[i], line: kept });
      used = kept.length;
      if (kept.length !== line.length) clampedByChars = true;
      continue;
    }
    if (used + 1 + line.length > totalCharCap) {
      clampedByChars = true; // whole lines past this point do not fit
      break;
    }
    pairs.push({ msg: messages[i], line });
    used += 1 + line.length;
  }
  if (pairs.length < lines.length) clampedByChars = true;
  return { pairs, clampedByChars };
}

/* --------------------------------- service --------------------------------- */

/**
 * Read one `/gork summarize` range. NEVER throws — every failure resolves
 * `{ ok: false, code, error }` (codes: usage | security | notfound | empty
 * | fetch | internal) with a specific, user-surfaceable reason; mid-range
 * page failures add `partial: { count, firstId, lastId }`.
 *
 * @param {{ from?: string, to?: string, last?: number|string, channel?: string }} args
 *   raw command options; exactly one mode (validated at the boundary)
 * @param {object} options
 * @param {string} options.guildId  current guild — the isolation anchor
 * @param {object} options.guild    duck-typed guild (channels.fetch, members.fetch, members.me)
 * @param {string} options.invokerId invoking user (parity gate subject)
 * @param {string} [options.fallbackChannelId] invocation channel (bare-id / last: default)
 * @param {number|string} [options.tokenBudget] guild input token budget
 *   (gork_summarize_input_tokens; clamped at read time, default 80,000)
 * @param {(guild: object, channelId: string) => Promise<object|null>} [options.channelResolver]
 * @param {(guild: object, userId: string) => Promise<object|null>} [options.memberFetcher]
 * @param {(channel: object, opts: object|string) => Promise<unknown>} [options.fetcher]
 * @param {object} [options.repo] db facade override (default lazy `require("../../db")`)
 * @returns {Promise<{ ok: true, mode: string, channelId: string, messages: object[],
 *   transcript: string, firstId: string, lastId: string, count: number, scannedCount: number,
 *   requestedLast: number|null, tokenBudget: number, charCap: number,
 *   clamped: boolean, clampReasons: string[], clampNote: string|null }
 *   | { ok: false, code: string, error: string, partial?: object }>}
 */
async function readSummarizeRange(args = {}, options = {}) {
  const a = args && typeof args === "object" ? args : {};
  const o = options && typeof options === "object" ? options : {};
  const progress = makeProgress(null);
  try {
    const mode = validateSummarizeMode(a);
    if (!mode.ok) return mode;

    const guildId = o.guildId == null ? "" : String(o.guildId);
    const guild = o.guild;
    if (!guild || !guildId) return fail("internal", "No guild context for this summarize read.");
    const fallbackChannelId = o.fallbackChannelId == null ? "" : String(o.fallbackChannelId);

    let channelId = null;
    let fromAnchorId = null;
    let toAnchorId = null;

    if (hasText(a.channel)) {
      const ch = resolveChannelOption(a.channel);
      if (!ch.ok) return ch;
      if (ch.guildId != null && String(ch.guildId) !== guildId) {
        return fail("security", "The channel: link points to another server — /gork summarize only reads messages in this server.");
      }
      channelId = String(ch.channelId);
    }
    const anchorChannel = channelId || fallbackChannelId || null;

    if (mode.mode !== MODE_LAST) {
      const from = resolveMessageAnchor(a.from, "from", anchorChannel);
      if (!from.ok) return from;
      const to = hasText(a.to) ? resolveMessageAnchor(a.to, "to", anchorChannel) : null;
      if (to && !to.ok) return to;
      // Guild isolation BEFORE any channel lookup or fetch (decision 46).
      for (const anchor of [from, to]) {
        if (anchor?.guildId != null && String(anchor.guildId) !== guildId) {
          const label = anchor === from ? "from" : "to";
          return fail("security", `The ${label}: link points to another server — /gork summarize only reads messages in this server.`);
        }
      }
      // Same-channel rule: one range, one channel (§7.21.1).
      if (to && String(to.channelId) !== String(from.channelId)) {
        return fail(
          "usage",
          `from: and to: are in different channels (from: in ${from.channelId}, to: in ${to.channelId}) — one summarize range must stay inside a single channel.`,
        );
      }
      channelId = String(from.channelId);
      fromAnchorId = String(from.messageId);
      toAnchorId = to ? String(to.messageId) : null;
      // Swap rule: `from` newer than `to` → swap (§7.21.1).
      if (toAnchorId != null && idCmp(fromAnchorId, toAnchorId) > 0) {
        const tmp = fromAnchorId;
        fromAnchorId = toAnchorId;
        toAnchorId = tmp;
      }
    } else if (!channelId) {
      if (!fallbackChannelId) {
        return fail("usage", "last: needs a channel — add channel: or run the command in the channel to summarize.");
      }
      channelId = fallbackChannelId;
    }

    progress.channelId = channelId;
    const access = await ensureReadableChannel({
      guild,
      channelId,
      invokerId: o.invokerId == null ? "" : String(o.invokerId),
      deps: o,
    });
    if (!access.ok) return access;
    const channel = access.channel;

    const fetcher =
      typeof o.fetcher === "function" ? o.fetcher : (ch, opts) => ch.messages.fetch(opts);

    let scan = null;
    if (mode.mode === MODE_LAST) {
      scan = await scanBackward(channel, fetcher, mode.last, progress);
    } else {
      const fromMessage = await fetchAnchor(channel, fetcher, fromAnchorId, "from");
      if (toAnchorId != null) await fetchAnchor(channel, fetcher, toAnchorId, "to");
      scan = await scanForward(channel, fetcher, fromMessage, toAnchorId, progress);
    }

    if (!scan.messages.length) {
      return fail(
        "empty",
        mode.mode === MODE_LAST
          ? `No readable messages found in channel ${channel.id} — the channel is empty or holds only system messages.`
          : "No readable messages in that range — Discord system messages (joins, pins, calls) are skipped.",
      );
    }

    // Budget phase: from-modes keep the oldest-first prefix; last: keeps
    // the newest suffix (§7.21.2 "largest window that fits"). The scan
    // order IS the keep-order for both (oldest→newest vs newest→oldest).
    // The guild's input token budget (default 80,000) sets the char cap.
    const tokenBudget = clampSummarizeInputTokens(o.tokenBudget);
    const charCap = summarizeInputTokenCapChars(tokenBudget);
    const budget = fitBudget(scan.messages, scan.messages.map(formatTranscriptLine), charCap);
    const window =
      mode.mode === MODE_LAST ? budget.pairs.slice().reverse() : budget.pairs; // oldest→newest

    const clampReasons = [...scan.clampReasons];
    if (budget.clampedByChars && !clampReasons.includes("chars")) clampReasons.push("chars");
    const messages = window.map((p) => p.msg);
    const firstId = String(messages[0].id ?? "");
    const lastId = String(messages[messages.length - 1].id ?? "");
    return {
      ok: true,
      mode: mode.mode,
      channelId: String(channel.id),
      messages,
      transcript: sliceSafe(window.map((p) => p.line).join("\n"), charCap),
      firstId,
      lastId,
      count: window.length,
      scannedCount: scan.messages.length,
      requestedLast: mode.mode === MODE_LAST ? mode.last : null,
      tokenBudget,
      charCap,
      clamped: clampReasons.length > 0,
      clampReasons,
      clampNote: buildClampNote(clampReasons, window.length, scan.messages.length, firstId, lastId, charCap),
    };
  } catch (err) {
    const detail = err?.message != null ? String(err.message) : String(err);
    if (err?.pageFailure) {
      const read =
        progress.count > 0
          ? ` after reading ${progress.count} message(s) (${progress.firstId} → ${progress.lastId})`
          : " before any message could be read";
      const failure = fail(
        "fetch",
        `Message fetch failed in channel ${progress.channelId}${read}: ${detail} — no rundown was produced.`,
      );
      if (progress.count > 0) {
        failure.partial = { count: progress.count, firstId: progress.firstId, lastId: progress.lastId };
      }
      return failure;
    }
    if (err?.failCode) return fail(err.failCode, detail);
    return fail("internal", `Unexpected summarize read failure: ${detail}`);
  }
}

/** One-sentence disclosure of every cap that bit (reply + embed repeat it). */
function buildClampNote(clampReasons, delivered, scanned, firstId, lastId, charCap) {
  const parts = [];
  if (clampReasons.includes("messages")) {
    parts.push(`the ${GORK_SUMMARIZE_RANGE_MAX_MESSAGES}-message read cap was hit before the end of the range`);
  }
  if (clampReasons.includes("chars")) {
    parts.push(
      `the ${charCap}-character transcript budget kept ${delivered} of ${scanned} read messages`,
    );
  }
  if (!parts.length) return null;
  return `Disclosed window ${firstId} → ${lastId}: ${parts.join("; ")}.`;
}

module.exports = Object.freeze({
  readSummarizeRange,
  validateSummarizeMode,
  MODE_CLOSED,
  MODE_FROM_NOW,
  MODE_LAST,
});
