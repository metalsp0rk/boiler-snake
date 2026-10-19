/**
 * Shared gork test fakes (#470 G2-6).
 *
 * These lived as near-verbatim per-file copies in gork-read-discord and
 * gork-summarize-range — the REST pagination semantics ("after-only: the
 * limit messages NEAREST the cursor ascending; everything else newest-first")
 * are the Discord contract, and a contract detail fixed in one copy silently
 * left the other — and the real behavior — behind. test/helpers/discord.js
 * documents the same contract for the gateway-shaped mock client; THIS file
 * is the plain-array variant the gork executors consume.
 */

const cmp = (a, b) => {
  const l = String(a);
  const r = String(b);
  return l === r ? 0 : l < r ? -1 : 1;
};

/** Canonical snowflake-ish ids shared by the gork suites. */
const GUILD_ID = "1000000000000000001";
const CHANNEL_ID = "2000000000000000002";
const ASKER_ID = "3000000000000000003";
const BOT_ID = "4000000000000000004";

function makeMessage(id, author, content, extra = {}) {
  return {
    id: String(id),
    author: { id: `u-${author}`, username: author },
    content,
    createdTimestamp: Date.parse("2026-09-16T00:00:00.000Z") + Number(id) * 1000,
    attachments: new Map(),
    ...extra,
  };
}

/**
 * Duck-typed channel. `messages.fetch` implements the Discord REST
 * contract: single id → message|null; {limit,before|after} → Map
 * NEWEST→oldest. `fetchCalls` records every window fetch (to prove
 * short-circuits never fetched).
 */
function makeChannel({ id = CHANNEL_ID, messages = [], perms = null, seam = true }) {
  const fetchCalls = [];
  return {
    id,
    _fetchCalls: fetchCalls,
    messages: seam
      ? {
          fetch: async (arg) => {
            fetchCalls.push(arg);
            if (typeof arg === "string") {
              return messages.find((m) => String(m.id) === arg) || null;
            }
            const limit = Number(arg?.limit) || 100;
            // after-only: the limit messages NEAREST the cursor, oldest
            // first (the real API's ascending mode); everything else:
            // newest first (descending mode).
            const ascending = Boolean(arg?.after) && !arg?.before;
            let list = [...messages].sort((a, b) =>
              ascending ? cmp(a.id, b.id) : cmp(b.id, a.id),
            );
            if (arg?.before) list = list.filter((m) => cmp(m.id, arg.before) < 0);
            if (arg?.after) list = list.filter((m) => cmp(m.id, arg.after) > 0);
            return new Map(list.slice(0, limit).map((m) => [String(m.id), m]));
          },
        }
      : undefined,
    permissionsFor:
      perms === null
        ? () => ({ has: () => true })
        : (member) => ({
            has: (flag) => (typeof perms === "function" ? perms(member, flag) : perms),
          }),
  };
}

function makeGuild({
  id = GUILD_ID,
  channels = [],
  members = [],
  me = { id: BOT_ID },
} = {}) {
  return {
    id,
    channels: {
      fetch: async (channelId) => channels.find((c) => c.id === String(channelId)) || null,
    },
    members: {
      me,
      fetch: async (userId) => {
        const m = members.find((x) => x.id === String(userId));
        if (!m) throw new Error(`Member ${userId} not found`);
        return m;
      },
    },
  };
}

const repoStub = (ticket = null) => ({
  calls: [],
  // Fluxer PR 2: repo is community-keyed — (communityId, channelId).
  getTicketByChannel(communityId, channelId) {
    this.calls.push(channelId);
    return ticket;
  },
});

module.exports = {
  cmp,
  GUILD_ID,
  CHANNEL_ID,
  ASKER_ID,
  BOT_ID,
  makeMessage,
  makeChannel,
  makeGuild,
  repoStub,
};
