/**
 * Resolve Discord user display names for ticket transcripts and archives.
 */

// Discord snowflakes are typically 17–19 digits; \d+ also covers short test ids.
const MENTION_RE = /<@!?(\d+)>/g;

/**
 * Prefer server nickname / global display name / username.
 * @param {object} u
 * @param {string} u.id
 * @param {string|null} [u.displayName]
 * @param {string|null} [u.globalName]
 * @param {string|null} [u.username]
 * @param {string|null} [u.tag]
 * @returns {string} long label for headers: "Nick (@user) · id"
 */
function formatUserLabel(u) {
  if (!u) return "unknown";
  const id = String(u.id || "");
  const display =
    u.displayName || u.globalName || u.username || u.tag || id || "unknown";
  const username = u.username || null;

  if (username && display !== username) {
    return `${display} (@${username}) · ${id}`;
  }
  if (username) {
    return `${username} · ${id}`;
  }
  return id || "unknown";
}

/**
 * Short label for inline mentions / message authors.
 * @param {object} u
 * @returns {string}
 */
function formatUserLabelShort(u) {
  if (!u) return "unknown";
  return (
    u.displayName ||
    u.globalName ||
    u.username ||
    u.tag ||
    String(u.id || "unknown")
  );
}

/**
 * Extract user IDs from Discord mention markup in message content.
 * @param {string|null|undefined} content
 * @returns {string[]}
 */
function collectMentionIds(content) {
  if (!content) return [];
  const ids = [];
  const re = new RegExp(MENTION_RE.source, "g");
  let m;
  while ((m = re.exec(String(content))) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

/**
 * Replace <@id> / <@!id> with @DisplayName using a resolved map.
 * Unknown IDs are left as-is.
 * @param {string|null|undefined} content
 * @param {Map<string, object>} userMap
 * @returns {string}
 */
function replaceMentionsInContent(content, userMap) {
  if (!content) return content == null ? "" : String(content);
  return String(content).replace(MENTION_RE, (full, id) => {
    const u = userMap?.get?.(id);
    if (!u) return full;
    return `@${formatUserLabelShort(u)}`;
  });
}

/**
 * Build a resolved user entry from Discord member/user objects.
 * @param {string} id
 * @param {import("discord.js").GuildMember|null} [member]
 * @param {import("discord.js").User|null} [user]
 * @returns {object}
 */
function entryFromDiscord(id, member, user) {
  const u = user || member?.user || null;
  const displayName =
    member?.displayName ||
    u?.globalName ||
    u?.username ||
    null;
  const username = u?.username || null;
  const globalName = u?.globalName || null;
  const tag = u?.tag || null;
  const base = { id: String(id), displayName, username, globalName, tag };
  return {
    ...base,
    label: formatUserLabel(base),
    shortLabel: formatUserLabelShort(base),
  };
}

/**
 * Resolve many user IDs via guild cache/fetch then client users.
 * Best-effort; failures leave a minimal id-only entry.
 *
 * @param {import("discord.js").Client|null|undefined} client
 * @param {import("discord.js").Guild|null|undefined} guild
 * @param {Iterable<string>} userIds
 * @returns {Promise<Map<string, object>>}
 */
async function resolveUsers(client, guild, userIds) {
  const map = new Map();
  const unique = [
    ...new Set(
      [...userIds]
        .filter((id) => id != null && String(id).trim() !== "")
        .map(String)
    ),
  ];

  for (const id of unique) {
    let member = null;
    let user = null;

    try {
      member = guild?.members?.cache?.get?.(id) || null;
      if (!member && typeof guild?.members?.fetch === "function") {
        member = await guild.members.fetch(id).catch(() => null);
      }
    } catch {
      member = null;
    }

    try {
      user = member?.user || client?.users?.cache?.get?.(id) || null;
      if (!user && typeof client?.users?.fetch === "function") {
        user = await client.users.fetch(id).catch(() => null);
      }
    } catch {
      user = null;
    }

    if (member || user) {
      map.set(id, entryFromDiscord(id, member, user));
    } else {
      map.set(id, entryFromDiscord(id, null, null));
    }
  }

  return map;
}

/**
 * Collect every user id we may want to resolve for a ticket archive.
 * @param {object} ticket
 * @param {object[]} messages
 * @returns {string[]}
 */
function collectTicketUserIds(ticket, messages) {
  const ids = new Set();
  if (ticket?.creator_user_id) ids.add(String(ticket.creator_user_id));
  if (ticket?.staff_owner_id) ids.add(String(ticket.staff_owner_id));
  if (ticket?.closed_by_user_id) ids.add(String(ticket.closed_by_user_id));
  if (ticket?.opened_by_staff_id) ids.add(String(ticket.opened_by_staff_id));

  for (const m of messages || []) {
    if (m.author_id) ids.add(String(m.author_id));
    for (const mid of collectMentionIds(m.content)) {
      ids.add(mid);
    }
  }
  return [...ids];
}

/**
 * Enrich archived messages with resolved author labels and expanded mentions.
 * Returns new array (does not mutate input).
 *
 * @param {object[]} messages
 * @param {Map<string, object>} userMap
 * @returns {object[]}
 */
function enrichMessagesForArchive(messages, userMap) {
  return (messages || []).map((m) => {
    const resolved = userMap.get(String(m.author_id));
    const author_tag = resolved
      ? resolved.label
      : m.author_tag || m.author_id || "unknown";
    const content = replaceMentionsInContent(m.content, userMap);
    return {
      ...m,
      author_tag,
      content,
    };
  });
}

/**
 * Labels for ticket meta fields from a user map.
 * @param {object} ticket
 * @param {Map<string, object>} userMap
 * @returns {{ requesterLabel: string, staffOwnerLabel: string, closedByLabel: string }}
 */
function ticketUserLabels(ticket, userMap) {
  const requester = userMap.get(String(ticket.creator_user_id));
  const owner = ticket.staff_owner_id
    ? userMap.get(String(ticket.staff_owner_id))
    : null;
  const closer = ticket.closed_by_user_id
    ? userMap.get(String(ticket.closed_by_user_id))
    : null;

  return {
    requesterLabel: requester
      ? requester.label
      : String(ticket.creator_user_id || "—"),
    staffOwnerLabel: ticket.staff_owner_id
      ? owner
        ? owner.label
        : String(ticket.staff_owner_id)
      : "—",
    closedByLabel: ticket.closed_by_user_id
      ? closer
        ? closer.label
        : String(ticket.closed_by_user_id)
      : "—",
  };
}

module.exports = {
  MENTION_RE,
  formatUserLabel,
  formatUserLabelShort,
  collectMentionIds,
  replaceMentionsInContent,
  entryFromDiscord,
  resolveUsers,
  collectTicketUserIds,
  enrichMessagesForArchive,
  ticketUserLabels,
};
