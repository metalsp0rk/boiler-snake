/**
 * Community registry — the single seam between external guild ids and the
 * internal integer `communities.id` (roadmap/fluxer.md § Repository boundary).
 *
 * This module is the ONLY place in src/ that queries the `communities` table
 * by external id. Feature code, web routes, and repositories receive an
 * already-resolved numeric `communityId`; only the Discord/Fluxer adapters
 * call getCommunityByExternal / ensureCommunity at the edge (interaction
 * create, gateway event, ticker rows are already community ids).
 *
 * There is no compatibility read: every function that takes a community id
 * asserts it with assertCommunityId, so a Discord snowflake (string-typed in
 * handlers, > 2^31-1 when coerced) can never reach a repository as a key.
 */

const { db, now } = require("../db");

/**
 * #389 (A2-3): first-sight memo, platform\0instance\0externalId -> community id.
 *
 * ensureCommunity used to run INSERT OR IGNORE + SELECT on EVERY call — the
 * MessageCreate/MessageUpdate/MessageDelete normalizers and every
 * context-arm interaction therefore opened a write transaction per chat
 * event, and with journal_mode=WAL + synchronous=FULL that is one fsync per
 * message on a row that never changes after first sight (the second
 * getGuildSettings-class finding from the prior audit's hot-path list).
 *
 * Why the memo can never go stale: the id is a pure function of the
 * UNIQUE identity, and NOTHING in src/ deletes a communities row —
 * pinned structurally by test/platform-community.test.js (source scan).
 * If a delete path ever ships, it must call resetCommunityMemoForTests()
 * (or the narrower forgetCommunity()) at the delete site.
 *
 * Bounded by the number of (deployment, guild) pairs this process serves.
 * Test isolation rides the house contract: loadDb() resets the require
 * cache per test file, so each file gets a fresh map; in-file cases that
 * need a clean slate call resetCommunityMemoForTests().
 */
const firstSight = new Map();

/** Drop every memoized identity (test seam; production callers have none). */
function resetCommunityMemoForTests() {
  firstSight.clear();
}

/** Inclusive upper bound for community ids: 2^31 − 1 (spec § Repository boundary). */
const MAX_COMMUNITY_ID = 2_147_483_647;

/** Platforms the `communities` CHECK constraint accepts (migration 034). */
const KNOWN_PLATFORMS = ["discord", "fluxer"];

/**
 * Guard for every community-id-keyed function. Throws on anything that is not
 * a safe integer in [1, 2147483647] — a Discord snowflake cannot pass, by
 * design. The throw is a programmer error (500-style log), never a user reply.
 *
 * @param {unknown} communityId
 * @returns {number} the validated id
 */
function assertCommunityId(communityId) {
  if (
    typeof communityId !== "number" ||
    !Number.isSafeInteger(communityId) ||
    communityId < 1 ||
    communityId > MAX_COMMUNITY_ID
  ) {
    throw new Error(`community id required, got ${typeof communityId}`);
  }
  return communityId;
}

/**
 * Programmer-error guard for the external identity strings.
 * @param {unknown} value
 * @param {string} name
 * @returns {string} the trimmed value
 */
function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    const shape =
      typeof value === "string" ? "empty string" : value === null ? "null" : typeof value;
    throw new Error(`community ${name} must be a non-empty string, got ${shape}`);
  }
  return value.trim();
}

const selectByExternal = db.prepare(
  `SELECT id FROM communities
   WHERE platform = ? AND instance_key = ? AND external_guild_id = ?`,
);

// #466 (XE-12): the voice readiness logger's OWN question, answered in SQL
// — which fluxer communities carry voice_states_complete=1. Scoping the
// scan in the query (not in a per-minute JS loop over every community of
// every platform) is the point: the old form re-read every row of every
// platform each 60s tick purely to console.log.
const selectElevatedFluxerIds = db.prepare(
  `SELECT id FROM communities
   WHERE platform = 'fluxer' AND elevated_permissions = 1
   ORDER BY id ASC`,
);

const selectVoiceCompleteFluxerIds = db.prepare(
  `SELECT id FROM communities
   WHERE platform = 'fluxer' AND voice_states_complete = 1
   ORDER BY id ASC`,
);

const selectById = db.prepare(
  `SELECT id,
          platform,
          instance_key           AS instanceKey,
          external_guild_id      AS externalGuildId,
          elevated_permissions   AS elevatedPermissions,
          voice_states_complete  AS voiceStatesComplete,
          created_at             AS createdAt
   FROM communities
   WHERE id = ?`,
);

const insertIgnore = db.prepare(
  `INSERT OR IGNORE INTO communities (platform, instance_key, external_guild_id, created_at)
   VALUES (?, ?, ?, ?)`,
);

/**
 * Map an external deployment's guild id to the internal community id.
 *
 * @param {string} platform "discord" | "fluxer"
 * @param {string} instanceKey "discord", or the normalized Fluxer origin
 * @param {string} externalGuildId the snowflake that deployment issued
 * @returns {number|null} community id, or null when the row does not exist yet
 */
function getCommunityByExternal(platform, instanceKey, externalGuildId) {
  const row = selectByExternal.get(
    requireNonEmptyString(platform, "platform"),
    requireNonEmptyString(instanceKey, "instanceKey"),
    requireNonEmptyString(externalGuildId, "externalGuildId"),
  );
  return row ? row.id : null;
}

/**
 * Reverse lookup: internal id → row metadata. Every outbound adapter resolves
 * its community through this before touching the platform API, so feature
 * code never needs the `communities` table.
 *
 * @param {number} communityId
 * @returns {{ id: number, platform: string, instanceKey: string, externalGuildId: string, createdAt: number }|null}
 */
function getCommunityById(communityId) {
  assertCommunityId(communityId);
  return selectById.get(communityId) || null;
}

/**
 * Insert-on-first-sight registry lookup. Idempotent: concurrent calls with
 * the same (platform, instanceKey, externalGuildId) converge on one row via
 * the UNIQUE constraint (INSERT OR IGNORE) plus a read-back of the stored id.
 * Flags (elevated_permissions, voice_states_complete) fall to their schema
 * DEFAULT 0 — only a Fluxer adapter ever writes them (spec § Phase 0, K8).
 *
 * @param {object} args
 * @param {string} args.platform "discord" | "fluxer"
 * @param {string} args.instanceKey
 * @param {string} args.externalGuildId
 * @returns {number} the community id for this identity
 */
function ensureCommunity({ platform, instanceKey, externalGuildId } = {}) {
  const platformKey = requireNonEmptyString(platform, "platform");
  const instance = requireNonEmptyString(instanceKey, "instanceKey");
  const externalId = requireNonEmptyString(externalGuildId, "externalGuildId");

  if (!KNOWN_PLATFORMS.includes(platformKey)) {
    throw new Error(
      `unsupported community platform "${platformKey}", expected one of: ${KNOWN_PLATFORMS.join(", ")}`,
    );
  }

  const key = `${platformKey}\u0000${instance}\u0000${externalId}`;
  const seen = firstSight.get(key);
  if (seen !== undefined) return seen; // warm path: ZERO statements (#389)

  insertIgnore.run(platformKey, instance, externalId, now());

  const id = getCommunityByExternal(platformKey, instance, externalId);
  if (id == null) {
    // Unreachable while the UNIQUE constraint holds; surfaces a corrupted DB
    // with the full identity instead of a bare "undefined" key.
    throw new Error(
      `ensureCommunity: insert did not produce a row for platform=${platformKey}, instance_key=${instance}, external_guild_id=${externalId}`,
    );
  }
  firstSight.set(key, id);
  return id;
}

module.exports = {
  listVoiceCompleteFluxerCommunityIds: () => selectVoiceCompleteFluxerIds.all().map((r) => r.id),
  // #466 (E2-11): which fluxer communities run with elevated_permissions=1
  // (the deferred reaction-role grant sweep's own question, answered in SQL).
  listElevatedFluxerCommunityIds: () => selectElevatedFluxerIds.all().map((r) => r.id),
  assertCommunityId,
  getCommunityByExternal,
  getCommunityById,
  ensureCommunity,
  discordCommunityId,
  resetCommunityMemoForTests,
};

/**
 * Transitional edge helper (PR 2): resolve a Discord guild snowflake held by a
 * Discord object (interaction.guildId, message.guild.id, ticker guild.id) to
 * the internal community id. Read-only — audit/logging helpers must not create
 * rows (edges call ensureCommunity). PR 3-5 replaces these call sites as the
 * OutboundClient surface lands.
 *
 * @param {string} externalGuildId
 * @returns {number|null}
 */
function discordCommunityId(externalGuildId) {
  if (externalGuildId == null) return null;
  try {
    return getCommunityByExternal("discord", "discord", String(externalGuildId));
  } catch (err) {
    // #467 (A2-11): rule 2 — a swallowed read made every DB fault look
    // like "no community row", which the command-channel gate reads as
    // ALLOW (permissions.js null-community branch): fail-open with a
    // silent cause. Callers still get null; the cause is now on the log.
    console.error(
      `[community] discordCommunityId(${externalGuildId}) lookup failed:`,
      err?.message || err,
    );
    return null;
  }
}
