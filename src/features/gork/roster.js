/**
 * Gork user roster (roadmap/gork.md §7.15 Fix 2).
 *
 * Builds a compact roster of the people involved in a gork exchange —
 * the asker, the authors of the collected context messages, and any
 * users mentioned in that content — resolved through the guild member
 * cache/fetch. The roster gives the model an id → name mapping so it can
 * answer questions like "what did @alice say?" and so Fix 1's output
 * sanitizer can render `<@id>` tokens as readable handles.
 *
 * Shape (one line per user, in first-seen order):
 *   `<id> | @<handle> | <display name> (<nickname>)`
 * Unresolvable users degrade to an id-only line. The roster is bounded
 * (max users, per-line and total char caps) to protect the 12k context
 * budget (decision 5).
 *
 * Never throws: every resolution failure degrades to an id-only entry.
 */

/** Max users listed before the "more" line (protects the context budget). */
const MAX_ROSTER_USERS = 12;
/** Max chars per roster line (name truncation). */
const MAX_ROSTER_LINE_CHARS = 100;
/** Max total roster block chars (header excluded from the per-line cap). */
const MAX_ROSTER_CHARS = 1200;

const USER_MENTION_RE = /<@!?([\w-]+)>/g;

/**
 * Collect involved user ids in first-seen order: asker first, then each
 * context message author, then every mentioned id found in the context
 * content (deduped).
 *
 * @param {import("discord.js").Message} triggerMessage
 * @param {Array<{ author?: { id?: string }, content?: string|null }>} messages
 *   collected context messages (oldest → newest; buildContext `messages`)
 * @param {string} [question] trigger question text (scanned for mentions)
 * @returns {string[]} unique user ids, first-seen order
 */
function collectParticipantIds(triggerMessage, messages, question = "") {
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    const value = id == null ? "" : String(id).trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    ids.push(value);
  };

  add(triggerMessage?.author?.id);
  for (const m of messages || []) {
    add(m?.author?.id);
  }
  const sources = [question, ...(messages || []).map((m) => m?.content)];
  for (const source of sources) {
    if (typeof source !== "string" || !source) continue;
    const re = new RegExp(USER_MENTION_RE.source, "g");
    let match;
    while ((match = re.exec(source)) !== null) add(match[1]);
  }
  return ids;
}

/**
 * Resolve one user id to a roster entry via guild member cache/fetch,
 * then client user cache. Best-effort: failures yield an id-only entry.
 *
 * @param {import("discord.js").Client|null|undefined} client
 * @param {import("discord.js").Guild|null|undefined} guild
 * @param {string} id
 * @returns {Promise<{ id: string, handle: string|null, display: string|null, nickname: string|null }>}
 */
async function resolveEntry(client, guild, id) {
  const entry = { id, handle: null, display: null, nickname: null };
  let member = null;
  try {
    member = guild?.members?.cache?.get?.(id) || null;
    if (!member && typeof guild?.members?.fetch === "function") {
      member = await guild.members.fetch(id).catch(() => null);
    }
  } catch {
    member = null;
  }
  let user = null;
  try {
    user =
      member?.user ||
      client?.users?.cache?.get?.(id) ||
      null;
    if (!user && typeof client?.users?.fetch === "function") {
      user = await client.users.fetch(id).catch(() => null);
    }
  } catch {
    user = null;
  }
  if (!member && !user) return entry;

  entry.handle = user?.username || null;
  entry.nickname = member?.nickname || null;
  entry.display =
    member?.displayName ||
    user?.globalName ||
    user?.username ||
    user?.tag ||
    null;
  return entry;
}

/**
 * Format one roster entry as `id | @handle | display (nickname)`,
 * truncated to MAX_ROSTER_LINE_CHARS. Unresolved entries degrade to
 * `id | (unresolved)`.
 *
 * @param {{ id: string, handle?: string|null, display?: string|null, nickname?: string|null }} entry
 * @returns {string}
 */
function formatRosterLine(entry) {
  if (!entry?.id) return "";
  if (!entry.display && !entry.handle) return `${entry.id} | (unresolved)`;
  const name = entry.display || entry.handle;
  const nick =
    entry.nickname && entry.nickname !== name ? ` (${entry.nickname})` : "";
  const handlePart = entry.handle ? `@${entry.handle}` : "(no handle)";
  const line = `${entry.id} | ${handlePart} | ${name}${nick}`;
  return line.length > MAX_ROSTER_LINE_CHARS
    ? `${line.slice(0, MAX_ROSTER_LINE_CHARS - 1)}…`
    : line;
}

/**
 * Build the roster for a gork exchange.
 *
 * @param {import("discord.js").Client|null|undefined} client
 * @param {import("discord.js").Guild|null|undefined} guild
 * @param {import("discord.js").Message} triggerMessage
 * @param {Array<object>} messages collected context messages (oldest → newest)
 * @param {string} [question] trigger question text
 * @returns {Promise<{ entries: Map<string, { id: string, handle: string|null, display: string|null, nickname: string|null }>, lines: string[], truncated: number }>}
 *   `entries` maps user id → resolved entry (also includes users cut by
 *   the cap, so output sanitizing still resolves them); `lines` are the
 *   listed roster lines (≤ MAX_ROSTER_USERS); `truncated` counts users
 *   resolved but not listed.
 */
async function buildRoster(client, guild, triggerMessage, messages, question = "") {
  const ids = collectParticipantIds(triggerMessage, messages, question);
  const entries = new Map();
  for (const id of ids) {
    entries.set(id, await resolveEntry(client, guild, id));
  }
  const listed = ids.slice(0, MAX_ROSTER_USERS);
  const lines = listed.map((id) => formatRosterLine(entries.get(id)));
  return {
    entries,
    lines,
    truncated: Math.max(0, ids.length - listed.length),
  };
}

/**
 * Render the roster as a model-facing block with usage guidance (the
 * decision-21 guidance pattern: the byte-locked base prompt stays
 * untouched; guidance lives in this data block).
 *
 * @param {{ lines?: string[], truncated?: number }} roster buildRoster() result
 * @returns {string} "" when the roster is empty
 */
function formatRosterBlock(roster) {
  const lines = roster?.lines || [];
  if (!lines.length) return "";
  const header =
    "People in this conversation (id | handle | display name). " +
    "Refer to members by their display names; never write raw <@id>, <@&id> or <#id> markup in your answer.";
  const parts = [header, ...lines];
  if (roster.truncated > 0) {
    parts.push(`(${roster.truncated} more participants not listed)`);
  }
  const block = parts.join("\n");
  return block.length > MAX_ROSTER_CHARS
    ? `${block.slice(0, MAX_ROSTER_CHARS - 1)}…`
    : block;
}

module.exports = {
  collectParticipantIds,
  resolveEntry,
  formatRosterLine,
  buildRoster,
  formatRosterBlock,
  MAX_ROSTER_USERS,
  MAX_ROSTER_LINE_CHARS,
  MAX_ROSTER_CHARS,
};
