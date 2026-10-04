/**
 * Account-linking service (roadmap/account-linking.md T2).
 *
 * The ONE service behind every linking surface (Discord slash and Fluxer
 * prefix arrive with T3; XP fan-out is T4 and memory fan-out is T5, both of
 * which consume the pure read helpers at the bottom of this file). Contract,
 * mirroring src/features/bridge/service.js:
 *
 *  - Every method returns { ok: true, ... } | { ok: false, error: string }.
 *    `error` is a specific, actionable sentence (AGENTS.md § Error Handling
 *    rule 3) written HERE, in one place, so T3 handlers reply it verbatim.
 *    Expected failures are values, never thrown (rule 6).
 *  - The service never replies to a platform: it imports neither discord.js
 *    nor the Fluxer SDK, and touches only the user_links repository and the
 *    community registry. All platform access stays in the handlers. The T4
 *    XP fan-out keeps that promise structurally: it resolves the target's
 *    OutboundClient through the boot-attached supervisor (attachSupervisor)
 *    and delegates the actual award to src/services/awardXp.js via a LAZY
 *    require (load-order cycle guard), passing fanOut:false as the loop guard.
 *  - Every entry point is wrapped, and every internal failure logs
 *    `console.error("[linking] ...")` with the ids needed to reproduce it
 *    (rule 2). The plaintext code is the one value that never enters a log
 *    line, a returned error, or an audit row.
 *  - Identity firewall (src/platform/community.js): every public function
 *    takes the INTEGER community id and asserts it first. A link row is the
 *    only structure allowed to relate a Discord snowflake to a Fluxer sub.
 *
 * Canonical orientation (locked design decision): side `a` is the Discord side
 * and side `b` is the Fluxer side, decided by `communities.platform`. The
 * repository is platform-agnostic, so this file is the only place that decides
 * which side is which.
 *
 * The functions named `resolveMirrorTarget` and `expandLinkedIds` are pure
 * repository reads (no writes, no platform I/O) and let programmer errors
 * (bad id types) THROW loudly, exactly like the repository does — they run
 * inside the XP and gork hot paths, where a snowflake passed where a community
 * id belongs must fail loudly instead of silently mirroring nothing.
 */

const repo = require("../../db/repositories/userLinks");
const { getCommunityById, assertCommunityId } = require("../../platform/community");
const codes = require("./codes");

// ---------------------------------------------------------------------------
// Message surface (single source; handlers reply `error` verbatim)
// ---------------------------------------------------------------------------

/** Command hint shown to the caller's platform ("/link" or "!link"). */
const DEFAULT_SURFACE_CMD = "/link";

const LINK_MESSAGES = Object.freeze({
  noCommunity: (communityId) =>
    `Community ${String(communityId)} is not registered with this bot, so there is no account to link from it. ` +
    "Run any bot command in that community first (the bot registers it on first contact), then link again.",
  missingCode: (cmd) =>
    `A link code is required. The person on the other platform gets theirs with ${cmd} create.`,
  alphabetGarbage:
    "That link code has characters a code can't contain. Paste the LNK- code again, with or without the dashes.",
  unknownCode: (cmd) =>
    `That link code was never created, was purged, or was typed wrong. Codes are minted by ${cmd} create, ` +
    "last 15 minutes, and work exactly once. Create a fresh one.",
  expired: (iso, cmd) =>
    `That link code expired at ${iso} UTC (codes last 15 minutes). Create a new one with ${cmd} create.`,
  alreadyUsed: (iso, cmd) =>
    `That link code was already redeemed on ${iso} UTC and cannot be used twice. Create a new one with ${cmd} create.`,
  samePlatform: (platformLabel, cmd) =>
    `A link joins one Discord account and one Fluxer account. This code was created on ${platformLabel}; ` +
    `run ${cmd} connect on the OTHER platform.`,
  unsupportedPair: (aLabel, bLabel) =>
    `Linking supports a Discord account paired with a Fluxer account. This code's community is on ${aLabel} ` +
    `and yours is on ${bLabel}, which the bot cannot pair.`,
  codeCommunityGone: (communityId, cmd) =>
    `The community that minted this code (id ${String(communityId)}) no longer exists on this deployment. ` +
    `Create a new code with ${cmd} create.`,
  noBridge: (communityIdA, communityIdB, cmd) =>
    `No active bridge connects communities ${communityIdA} and ${communityIdB}, so accounts there cannot be linked. ` +
    `Pair the two communities with bridge create + bridge connect first, then run ${cmd} connect again.`,
  callerLinked: (userId, communityId, peerUserId, peerCommunityId, iso, cmd) =>
    `You (user ${userId} in community ${communityId}) are already linked to user ${peerUserId} ` +
    `in community ${peerCommunityId} (linked since ${iso}). Run ${cmd} remove to unlink first.`,
  targetLinked: (userId, communityId, peerUserId, peerCommunityId, iso, cmd) =>
    `The account behind that code (user ${userId} in community ${communityId}) is already linked to user ${peerUserId} ` +
    `in community ${peerCommunityId} (linked since ${iso}). That account must run ${cmd} remove before it can be linked again.`,
  createFailed: (detail, cmd) =>
    `Could not save the link: ${detail}. The link code was already spent, so create a new one with ${cmd} create.`,
  mintFailed: (detail) => `Could not mint a link code: ${detail}.`,
  mirrorNoLink: (userId, communityId, cmd) =>
    `user ${userId} in community ${communityId} has no account link to configure — ` +
    `${cmd} create mints a code and ${cmd} connect creates the link.`,
  mirrorSamePlatform: (communityIdA, communityIdB, label, cmd) =>
    `Stored link between communities ${communityIdA} and ${communityIdB} joins two ${label} communities, ` +
    `which is a data problem the bot cannot mirror. Run ${cmd} remove and create the link again.`,
  mirrorPeerGone: (peerCommunityId, cmd) =>
    `The other side of this link points at community ${peerCommunityId}, which no longer exists on this deployment. ` +
    `Run ${cmd} remove to clear the broken link.`,
  mirrorNeedsPct: (cmd) =>
    `link config needs a percentage with its direction, e.g. "${cmd} config to-fluxer 50".`,
  mirrorNothingToSet: (cmd) =>
    `Nothing to change. Use "${cmd} config <direction> <0-100>" for XP mirroring, ` +
    `or "${cmd} config memory on|off" for gork memory mirroring.`,
  saveFailed: (detail) => `Could not save the link: ${detail}.`,
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function causeOf(err) {
  return String(err?.message || err);
}

/**
 * Programmer-error guard for external user id strings (Discord snowflakes,
 * Fluxer subs). Mirrors userLinks.requireUserId so the service can answer with
 * its own sentence before a repository call.
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requireUserId(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    const shape =
      typeof value === "string" ? "empty string" : value === null ? "null" : typeof value;
    throw new TypeError(`linking: ${name} must be a non-empty string, got ${shape}`);
  }
  return value.trim();
}

/** @param {unknown} community @returns {boolean} true for a communities row. */
function isCommunityRow(community) {
  return (
    community !== null &&
    typeof community === "object" &&
    Number.isSafeInteger(community.id) &&
    typeof community.platform === "string" &&
    typeof community.instanceKey === "string"
  );
}

function platformLabel(platform) {
  if (platform === "discord") return "Discord";
  if (platform === "fluxer") return "Fluxer";
  return String(platform ?? "unknown");
}

/** ISO instant for a stored ms epoch, rendered defensively. */
function isoUtc(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : String(ms);
}

/**
 * Peer identity from the caller's side of a link row.
 * @param {object} link user_links row
 * @param {number} communityId caller's community
 * @param {string} userId caller's user id
 * @returns {'a'|'b'} which side the caller occupies
 */
function callerSide(link, communityId, userId) {
  if (link.community_id_a === communityId && link.user_id_a === userId) return "a";
  if (link.community_id_b === communityId && link.user_id_b === userId) return "b";
  return null;
}

/** @returns {{ communityId: number, userId: string }} the other side. */
function peerSide(link, side) {
  return side === "a"
    ? { communityId: link.community_id_b, userId: link.user_id_b }
    : { communityId: link.community_id_a, userId: link.user_id_a };
}

/**
 * The peer descriptor handlers render (id + platform, never a handle the bot
 * cannot resolve — T3 decorates it with names via fetchMember).
 */
function describePeer(link, side) {
  const peer = peerSide(link, side);
  const community = getCommunityById(peer.communityId);
  return {
    communityId: peer.communityId,
    userId: peer.userId,
    platform: community?.platform ?? "unknown",
    platformLabel: platformLabel(community?.platform),
    instanceKey: community?.instanceKey ?? "unknown",
  };
}

/**
 * Resolve both sides' community rows for a link and validate the canonical
 * orientation (Discord = a, Fluxer = b). Returns { ok: true, rows } or an
 * { ok: false, error } describing exactly what is wrong with the stored row.
 */
function linkPlatformPair(link) {
  const communityA = getCommunityById(link.community_id_a);
  const communityB = getCommunityById(link.community_id_b);
  if (!isCommunityRow(communityA)) {
    return {
      ok: false,
      error: LINK_MESSAGES.mirrorPeerGone(link.community_id_a, DEFAULT_SURFACE_CMD),
    };
  }
  if (!isCommunityRow(communityB)) {
    return {
      ok: false,
      error: LINK_MESSAGES.mirrorPeerGone(link.community_id_b, DEFAULT_SURFACE_CMD),
    };
  }
  if (communityA.platform === communityB.platform) {
    return {
      ok: false,
      error: LINK_MESSAGES.mirrorSamePlatform(
        link.community_id_a,
        link.community_id_b,
        platformLabel(communityA.platform),
        DEFAULT_SURFACE_CMD,
      ),
    };
  }
  return { ok: true, communityA, communityB };
}

/**
 * Map a user-supplied mirror-direction token to storage form, from the
 * CALLER's platform (KD 19 style, same tokens bridge uses):
 *   discord caller: to-fluxer → a_to_b, from-fluxer → b_to_a
 *   fluxer  caller: to-discord → b_to_a, from-discord → a_to_b
 * Storage keys ("a_to_b", "b_to_a", "both") are accepted verbatim so web/API
 * callers can skip the platform-relative dance.
 *
 * @param {string} callerPlatform
 * @param {unknown} raw
 * @returns {{ ok: true, direction: 'a_to_b'|'b_to_a'|'both' } | { ok: false }}
 */
function normalizeMirrorDirection(callerPlatform, raw) {
  const token = String(raw ?? "").trim().toLowerCase();
  if (token === "both" || token === "a_to_b" || token === "b_to_a") {
    return { ok: true, direction: token };
  }
  if (callerPlatform === "discord") {
    if (token === "to-fluxer") return { ok: true, direction: "a_to_b" };
    if (token === "from-fluxer") return { ok: true, direction: "b_to_a" };
  } else if (callerPlatform === "fluxer") {
    if (token === "to-discord") return { ok: true, direction: "b_to_a" };
    if (token === "from-discord") return { ok: true, direction: "a_to_b" };
  }
  return { ok: false };
}

// ---------------------------------------------------------------------------
// createLinkCode
// ---------------------------------------------------------------------------

/**
 * Mint a one-time link code for (community, user) — the `link create` half.
 *
 * The plaintext code is returned to the caller exactly once (T3 delivers it
 * ephemerally on Discord / in-channel on Fluxer); only its SHA-256 digest is
 * stored. The community pair is NOT checked here: the code's counterpart is
 * chosen at redemption, and `redeemLinkCode` enforces the bridge-pair gate.
 *
 * @param {number} communityId integer community id (firewall-validated)
 * @param {string} userId external user id at that community's platform
 * @param {object} [opts]
 * @param {() => number} [opts.clock] epoch-ms clock (tests inject)
 * @param {object} [opts.repo] repository seam (tests inject)
 * @param {string} [opts.surfaceCmd='/link'] command hint in user replies
 * @returns {Promise<{ ok: true, code: string, canonical: string, expiresAt: number, linkCode: object } | { ok: false, error: string }>}
 */
async function createLinkCode(communityId, userId, opts = {}) {
  const linkRepo = opts.repo ?? repo;
  const clock = typeof opts.clock === "function" ? opts.clock : () => Date.now();
  const surfaceCmd = opts.surfaceCmd ?? DEFAULT_SURFACE_CMD;
  try {
    const cid = assertCommunityId(communityId);
    const uid = requireUserId(userId, "userId");

    const community = getCommunityById(cid);
    if (!isCommunityRow(community)) {
      return { ok: false, error: LINK_MESSAGES.noCommunity(cid) };
    }

    const lifetimeMs = linkRepo.LINK_CODE_LIFETIME_MS ?? repo.LINK_CODE_LIFETIME_MS;
    const expiresAt = clock() + lifetimeMs;
    let created = null;
    let lastError = null;
    // Collision-retry: a minted digest already in the table (astronomically
    // unlikely, observable through the UNIQUE index) gets a fresh mint.
    for (let attempt = 0; attempt < codes.MAX_CODE_ATTEMPTS && !created; attempt += 1) {
      const minted = codes.generateLinkCode({
        isTaken: (digest) => Boolean(linkRepo.getLinkCodeByHash(digest)),
      });
      const res = linkRepo.createLinkCode({
        communityId: cid,
        userId: uid,
        codeHash: minted.digest,
        expiresAt,
      });
      if (!res.ok) {
        lastError = res.error;
        continue;
      }
      created = { minted, row: res.linkCode };
    }
    if (!created) {
      console.error(
        `[linking] createLinkCode: minting failed for community ${cid} user ${uid}: ${lastError ?? "no attempt succeeded"}`,
      );
      return {
        ok: false,
        error: LINK_MESSAGES.mintFailed(lastError ?? "no link code could be minted"),
      };
    }

    return {
      ok: true,
      // The plaintext credential: handlers may show it ONLY in the minting
      // reply. Never logged, never audited, never stored.
      code: created.minted.displayCode,
      canonical: created.minted.canonical,
      expiresAt: Number(created.row.expires_at),
      linkCode: created.row,
      communityId: cid,
      userId: uid,
      platform: community.platform,
      lifetimeMs,
      surfaceCmd,
    };
  } catch (err) {
    // Programmer errors (bad community id / user id) surface as a specific
    // sentence so a handler reply is always actionable (rule 3).
    console.error(
      `[linking] createLinkCode failed (community ${String(communityId)} user ${String(userId)}):`,
      causeOf(err),
    );
    return { ok: false, error: LINK_MESSAGES.saveFailed(causeOf(err)) };
  }
}

// ---------------------------------------------------------------------------
// redeemLinkCode
// ---------------------------------------------------------------------------

/**
 * Redeem a link code — the `link connect` half.
 *
 * Fail-closed ordering (bridge §10.7 lesson): every check that can reject runs
 * BEFORE the atomic consume, so a user who fixes the problem (unlinks an
 * account, pairs the communities) can retry with the SAME code. Only the
 * consume and the link insert happen after the last refusal.
 *
 * @param {number} communityId redeem-side integer community id
 * @param {string} userId redeem-side external user id
 * @param {string} rawCode the LNK- credential as typed
 * @param {object} [opts]
 * @param {() => number} [opts.clock] epoch-ms clock (tests inject)
 * @param {object} [opts.repo] repository seam (tests inject)
 * @param {string} [opts.surfaceCmd='/link'] command hint in user replies
 * @returns {Promise<{ ok: true, link: object, peer: object } | { ok: false, error: string }>}
 */
async function redeemLinkCode(communityId, userId, rawCode, opts = {}) {
  const linkRepo = opts.repo ?? repo;
  const clock = typeof opts.clock === "function" ? opts.clock : () => Date.now();
  const surfaceCmd = opts.surfaceCmd ?? DEFAULT_SURFACE_CMD;
  try {
    const cid = assertCommunityId(communityId);
    const uid = requireUserId(userId, "userId");

    const community = getCommunityById(cid);
    if (!isCommunityRow(community)) {
      return { ok: false, error: LINK_MESSAGES.noCommunity(cid) };
    }

    // ---- Format (classified before hashing, like bridge connect).
    const classify = codes.classifyLinkInput(rawCode);
    if (classify.kind === "empty") {
      return { ok: false, error: LINK_MESSAGES.missingCode(surfaceCmd) };
    }
    if (classify.kind === "garbage") {
      return { ok: false, error: LINK_MESSAGES.alphabetGarbage };
    }

    const digest = codes.hashLinkCode(classify.canonical);
    const codeRow = linkRepo.getLinkCodeByHash(digest);
    if (!codeRow) return { ok: false, error: LINK_MESSAGES.unknownCode(surfaceCmd) };
    // Defence in depth: the row the UNIQUE index served must carry the exact
    // digest we hashed (mirrors bridge connect's digestsEqual read-back).
    if (!codes.digestsEqual(codeRow.code_hash, digest)) {
      console.error(
        `[linking] redeem: code row ${codeRow.id} (community ${codeRow.community_id}) stores a code_hash that does not match its lookup — corrupt row`,
      );
      return { ok: false, error: LINK_MESSAGES.unknownCode(surfaceCmd) };
    }

    // ---- Single use + expiry, reported separately (specific causes only).
    if (codeRow.used_at != null) {
      return { ok: false, error: LINK_MESSAGES.alreadyUsed(isoUtc(codeRow.used_at), surfaceCmd) };
    }
    const nowMs = clock();
    const expiresAt = Number(codeRow.expires_at);
    if (!(expiresAt > nowMs)) {
      return { ok: false, error: LINK_MESSAGES.expired(isoUtc(expiresAt), surfaceCmd) };
    }

    // ---- Creation side (the code's owner) and the cross-platform rule.
    const creator = getCommunityById(codeRow.community_id);
    if (!isCommunityRow(creator)) {
      console.error(
        `[linking] redeem: code ${codeRow.id} belongs to community ${codeRow.community_id}, which is not a registered community`,
      );
      return { ok: false, error: LINK_MESSAGES.codeCommunityGone(codeRow.community_id, surfaceCmd) };
    }
    if (creator.platform === community.platform) {
      return {
        ok: false,
        error: LINK_MESSAGES.samePlatform(platformLabel(creator.platform), surfaceCmd),
      };
    }
    const creatorIsDiscord = creator.platform === "discord";
    const redeemerIsDiscord = community.platform === "discord";
    if (creatorIsDiscord === redeemerIsDiscord) {
      return {
        ok: false,
        error: LINK_MESSAGES.unsupportedPair(
          platformLabel(creator.platform),
          platformLabel(community.platform),
        ),
      };
    }

    // ---- Scope gate (locked decision 3): links live only between communities
    // with an ACTIVE bridge. A community row that vanished mid-call is caught
    // here too (hasActiveBridgeBetween asserts both ids and finds no row).
    if (!linkRepo.hasActiveBridgeBetween(creator.id, cid)) {
      return {
        ok: false,
        error: LINK_MESSAGES.noBridge(creator.id, cid, surfaceCmd),
      };
    }

    // ---- One link per identity, both sides, checked before the consume so a
    // spent code is never burned by a conflict the user can fix.
    const callerLink = linkRepo.getLinkFor(cid, uid);
    if (callerLink) {
      const side = callerSide(callerLink, cid, uid);
      const peer = peerSide(callerLink, side ?? "a");
      return {
        ok: false,
        error: LINK_MESSAGES.callerLinked(
          uid,
          cid,
          peer.userId,
          peer.communityId,
          isoUtc(callerLink.created_at),
          surfaceCmd,
        ),
      };
    }
    const targetLink = linkRepo.getLinkFor(codeRow.community_id, codeRow.user_id);
    if (targetLink) {
      const side = callerSide(targetLink, codeRow.community_id, codeRow.user_id);
      const peer = peerSide(targetLink, side ?? "a");
      return {
        ok: false,
        error: LINK_MESSAGES.targetLinked(
          codeRow.user_id,
          codeRow.community_id,
          peer.userId,
          peer.communityId,
          isoUtc(targetLink.created_at),
          surfaceCmd,
        ),
      };
    }

    // ---- The atomic consume: one UPDATE flipping used_at only when the row
    // is still unused and unexpired. Two racing redemptions cannot both win.
    const consumed = linkRepo.consumeLinkCode(digest, nowMs);
    if (!consumed) {
      // Lost the race, or the clock moved between the checks and the consume.
      // Re-read so the reply names the real cause.
      const fresh = linkRepo.getLinkCodeByHash(digest);
      if (fresh && fresh.used_at != null) {
        return { ok: false, error: LINK_MESSAGES.alreadyUsed(isoUtc(fresh.used_at), surfaceCmd) };
      }
      if (fresh && !(Number(fresh.expires_at) > nowMs)) {
        return { ok: false, error: LINK_MESSAGES.expired(isoUtc(fresh.expires_at), surfaceCmd) };
      }
      return { ok: false, error: LINK_MESSAGES.unknownCode(surfaceCmd) };
    }

    // ---- Canonical orientation: the Discord side is stored as `a`.
    const communityIdA = creatorIsDiscord ? creator.id : cid;
    const userIdA = creatorIsDiscord ? codeRow.user_id : uid;
    const communityIdB = creatorIsDiscord ? cid : creator.id;
    const userIdB = creatorIsDiscord ? uid : codeRow.user_id;

    const created = linkRepo.createLink({
      communityIdA,
      userIdA,
      communityIdB,
      userIdB,
    });
    if (!created.ok) {
      // The code is already spent (single use is atomic and irreversible), so
      // tell the user the retry path, not a bare failure (rule 3/5).
      console.error(
        `[linking] redeem: link create failed for community ${cid} user ${uid}: ${created.error}`,
      );
      return {
        ok: false,
        codeBurned: true,
        error: LINK_MESSAGES.createFailed(created.error, surfaceCmd),
      };
    }

    const callerIsA = created.link.community_id_a === cid && created.link.user_id_a === uid;
    return {
      ok: true,
      link: created.link,
      // The peer seen from the caller's side (the code's owner).
      peer: describePeer(created.link, callerIsA ? "a" : "b"),
      codeBurned: true,
    };
  } catch (err) {
    console.error(
      `[linking] redeemLinkCode failed (community ${String(communityId)} user ${String(userId)}):`,
      causeOf(err),
    );
    return { ok: false, error: LINK_MESSAGES.saveFailed(causeOf(err)) };
  }
}

// ---------------------------------------------------------------------------
// getLinkFor / removeLink
// ---------------------------------------------------------------------------

/**
 * The caller's link, from their own side (status surface). A pure read:
 * `{ ok: true, link: null }` is the "nothing to show" answer, not a failure.
 *
 * @param {number} communityId
 * @param {string} userId
 * @returns {{ ok: true, link: object|null, peer: object|null, side: 'a'|'b'|null }}
 */
function getLinkFor(communityId, userId) {
  try {
    const cid = assertCommunityId(communityId);
    const uid = requireUserId(userId, "userId");
    const link = repo.getLinkFor(cid, uid) || null;
    if (!link) return { ok: true, link: null, peer: null, side: null };
    const side = callerSide(link, cid, uid);
    return {
      ok: true,
      link,
      side,
      peer: side ? describePeer(link, side) : null,
    };
  } catch (err) {
    console.error(
      `[linking] getLinkFor failed (community ${String(communityId)} user ${String(userId)}):`,
      causeOf(err),
    );
    return { ok: false, error: LINK_MESSAGES.saveFailed(causeOf(err)) };
  }
}

/**
 * Delete the caller's link. The caller must be a party.
 *
 * Mirrored XP rows and gork memories already written are NOT retroactively
 * removed (documented limitation); mirroring stops for future awards. The
 * note rides along so T3 can state it in the reply.
 *
 * @param {number} communityId
 * @param {string} userId
 * @param {object} [opts]
 * @param {object} [opts.repo]
 * @param {string} [opts.surfaceCmd='/link']
 * @returns {{ ok: true, link: object, note: string } | { ok: false, error: string }}
 */
function removeLink(communityId, userId, opts = {}) {
  const linkRepo = opts.repo ?? repo;
  try {
    const cid = assertCommunityId(communityId);
    const uid = requireUserId(userId, "userId");
    const res = linkRepo.removeLink(cid, uid);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      link: res.link,
      note:
        "XP and memories already mirrored on the other platform stay in place; " +
        "mirroring stops from now on.",
    };
  } catch (err) {
    console.error(
      `[linking] removeLink failed (community ${String(communityId)} user ${String(userId)}):`,
      causeOf(err),
    );
    return { ok: false, error: LINK_MESSAGES.saveFailed(causeOf(err)) };
  }
}

// ---------------------------------------------------------------------------
// configureMirror
// ---------------------------------------------------------------------------

/**
 * Configure XP mirror rates and/or the gork memory mirror switch.
 *
 * Accepts (all optional, at least one required):
 *  - `direction`: 'a_to_b' | 'b_to_a' | 'both' (storage keys) or the
 *    caller-relative tokens 'to-fluxer' | 'from-fluxer' | 'to-discord' |
 *    'from-discord', resolved against the caller's platform.
 *  - `pct`: integer 0–100 (required whenever `direction` is given).
 *  - `mirrorMemory`: true/1 or false/0.
 *
 * Applies in order (pct, then memory) and stops at the first refusal, so a
 * bad percentage never leaves a half-applied "memory off" surprise; whatever
 * DID land is reported in `applied` (AGENTS.md rule 5).
 *
 * @param {number} communityId caller's community
 * @param {string} userId caller's user id
 * @param {object} [opts]
 * @param {string} [opts.direction]
 * @param {number} [opts.pct]
 * @param {boolean|number} [opts.mirrorMemory]
 * @param {object} [opts.repo]
 * @param {string} [opts.surfaceCmd='/link']
 * @returns {Promise<{ ok: true, link: object, applied: string[], peer: object } | { ok: false, error: string, applied?: string[], link?: object }>}
 */
async function configureMirror(communityId, userId, opts = {}) {
  const linkRepo = opts.repo ?? repo;
  const surfaceCmd = opts.surfaceCmd ?? DEFAULT_SURFACE_CMD;
  try {
    const cid = assertCommunityId(communityId);
    const uid = requireUserId(userId, "userId");

    const link = linkRepo.getLinkFor(cid, uid);
    if (!link) {
      return { ok: false, error: LINK_MESSAGES.mirrorNoLink(uid, cid, surfaceCmd) };
    }
    const side = callerSide(link, cid, uid);
    if (!side) {
      // Unreachable through getLinkFor; state it loudly in the log.
      console.error(
        `[linking] configureMirror: link ${link.id} does not list community ${cid} user ${uid} as a party — data corruption`,
      );
      return {
        ok: false,
        error: `Link ${link.id} does not include user ${uid} in community ${cid}. Run ${surfaceCmd} remove and create the link again.`,
      };
    }

    // Canonical orientation sanity (side a is Discord, side b is Fluxer).
    const platforms = linkPlatformPair(link);
    if (!platforms.ok) return { ok: false, error: platforms.error };
    const callerPlatform = side === "a" ? platforms.communityA.platform : platforms.communityB.platform;

    const hasDirection = opts.direction != null && String(opts.direction).trim() !== "";
    const hasPct = opts.pct !== undefined;
    const hasMemory = opts.mirrorMemory !== undefined;

    if (!hasDirection && !hasPct && !hasMemory) {
      return { ok: false, error: LINK_MESSAGES.mirrorNothingToSet(surfaceCmd) };
    }
    if (hasPct && !hasDirection) {
      return { ok: false, error: LINK_MESSAGES.mirrorNeedsPct(surfaceCmd) };
    }

    let current = link;
    const applied = [];

    if (hasDirection) {
      const parsed = normalizeMirrorDirection(callerPlatform, opts.direction);
      if (!parsed.ok) {
        const [toOther, fromOther] =
          callerPlatform === "discord" ? ["to-fluxer", "from-fluxer"] : ["to-discord", "from-discord"];
        return {
          ok: false,
          error: `That is not a mirror direction. Use ${toOther}, ${fromOther}, both, a_to_b, b_to_a, or leave the direction out and pass on/off for memory.`,
        };
      }
      if (!hasPct) {
        return { ok: false, error: LINK_MESSAGES.mirrorNeedsPct(surfaceCmd) };
      }
      const dirs = parsed.direction === "both" ? ["a_to_b", "b_to_a"] : [parsed.direction];
      for (const dir of dirs) {
        const res = linkRepo.setMirrorPct(cid, uid, dir, opts.pct);
        if (!res.ok) {
          // setMirrorPct's own sentence is already specific (range/type).
          return { ok: false, error: res.error, applied, link: current };
        }
        current = res.link;
        applied.push(`${dir}=${dir === "a_to_b" ? current.mirror_a_to_b_pct : current.mirror_b_to_a_pct}`);
      }
    }

    if (hasMemory) {
      const res = linkRepo.setMirrorMemory(cid, uid, opts.mirrorMemory);
      if (!res.ok) return { ok: false, error: res.error, applied, link: current };
      current = res.link;
      applied.push(`mirror_memory=${current.mirror_memory}`);
    }

    return {
      ok: true,
      link: current,
      applied,
      peer: describePeer(current, side),
      mirror: {
        a_to_b_pct: current.mirror_a_to_b_pct,
        b_to_a_pct: current.mirror_b_to_a_pct,
        memory: current.mirror_memory === 1,
      },
    };
  } catch (err) {
    console.error(
      `[linking] configureMirror failed (community ${String(communityId)} user ${String(userId)}):`,
      causeOf(err),
    );
    return { ok: false, error: LINK_MESSAGES.saveFailed(causeOf(err)) };
  }
}

// ---------------------------------------------------------------------------
// Supervisor seam (T4 XP fan-out, shared with later surfaces)
// ---------------------------------------------------------------------------

/**
 * The platform supervisor ({ discord, fluxer, clientForCommunity }) captured
 * at boot by src/features/linking/index.js's start hook. It is the ONLY
 * source of OutboundClients for mirror targets — the service stays
 * platform-blind (no discord.js, no Fluxer SDK), and outbound resolution
 * rides the same accessor bridge uses (src/features/bridge/handlers.js:443:
 * supervisor.clientForCommunity).
 * @type {object|null}
 */
let supervisor = null;

/**
 * Capture the platform supervisor. Idempotent: re-attaching the same object
 * changes nothing, and the LAST attach wins (boot re-start replaces clients).
 *
 * @param {object|null} sup supervisor with a clientForCommunity(communityId)
 *   accessor; null detaches (mirrors then report "no client" warnings).
 */
function attachSupervisor(sup) {
  supervisor = sup ?? null;
}

/**
 * OutboundClient for one community through the supervisor, `null` when the
 * supervisor is absent or has no client for it. A throwing
 * clientForCommunity is logged and answered with null — a broken outbound
 * lookup can never throw into an award pipeline (AGENTS.md rule 1).
 *
 * @param {number} communityId
 * @returns {object|null}
 */
function getTargetOutbound(communityId) {
  try {
    return supervisor?.clientForCommunity?.(communityId) ?? null;
  } catch (err) {
    console.error(
      `[linking] clientForCommunity(${String(communityId)}) failed:`,
      causeOf(err),
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// XP fan-out (T4 — the awardXp mirror leg)
// ---------------------------------------------------------------------------

/**
 * Sign-preserving mirror of an XP delta at a link's percentage:
 * `Math.sign(delta) * Math.round(Math.abs(delta) * pct / 100)`.
 * Rounding the ABSOLUTE value keeps negatives mirroring negatives (decay and
 * admin subtraction must not mirror into a grant), and avoids the
 * Math.round(-2.5) = -2 asymmetry: 50% of 5 AND of -5 both land on magnitude 3.
 *
 * @param {number} delta source award delta (any sign)
 * @param {number} pct mirror percentage 1–100 (0 mirrors nothing upstream)
 * @returns {number} integer delta for the target side (never -0)
 */
function mirrorDelta(delta, pct) {
  const mirrored = Math.sign(delta) * Math.round((Math.abs(delta) * pct) / 100);
  return mirrored === 0 ? 0 : mirrored; // normalize -0 (sign of a zero award is noise)
}

/**
 * Fan an XP award out to the linked counterpart account — the seam
 * src/services/awardXp.js calls after every successful primary award
 * (roadmap/account-linking.md T4 § XP fan-out seam).
 *
 * Contract with awardXp:
 *  - NEVER throws. Every outcome (no link, direction off at 0%, no target
 *    client, a target award that failed) resolves to
 *    `{ awarded: number|null, warnings: string[] }`. The primary award has
 *    already landed, so a broken mirror DEGRADES: specific warnings surface
 *    through awardXp's additive `linkMirror` field and every failure logs
 *    `console.error("[linking] ...")` with the ids (AGENTS.md rules 2/5/6).
 *  - The target award reuses the EXISTING award machinery — level math,
 *    guild settings, member fetch and role sync run on the TARGET community
 *    through the TARGET's OutboundClient (K8-gated by the target community's
 *    own elevated_permissions flag).
 *  - The target call passes `source: "link_mirror"` and `fanOut: false`.
 *    That fanOut:false is THE LOOP GUARD: a mirror-issued award never fans
 *    out again, so a→b→a ping-pong is structurally impossible.
 *
 * @param {number} sourceCommunityId award side's integer community id
 * @param {string} userId award side's external user id
 * @param {number} delta the primary award's delta (sign is preserved)
 * @param {string} activityKind activity kind, forwarded unchanged (decay
 *   counts mirror symmetrically — no ".mirror" suffix, per the design bundle)
 * @param {object} [opts]
 * @param {(communityId: number) => object|null} [opts.getOutbound] outbound
 *   resolver seam (tests inject; defaults to getTargetOutbound)
 * @param {Function} [opts.awardXp] award service seam (tests inject;
 *   defaults to the lazy-required src/services/awardXp)
 * @returns {Promise<{ awarded: number|null, warnings: string[] }>}
 *   `awarded`: the mirrored delta actually awarded (0 when the link exists
 *   but the pct rounded the award away), null when nothing was attempted.
 */
async function fanOutLinkedXp(sourceCommunityId, userId, delta, activityKind, opts = {}) {
  const warnings = [];
  try {
    const cid = assertCommunityId(sourceCommunityId);
    const uid = requireUserId(userId, "userId");

    const numericDelta = Number(delta);
    if (!Number.isFinite(numericDelta)) {
      const msg = `mirror delta must be a finite number, got ${String(delta)}`;
      console.error(`[linking] xp mirror skipped for community ${cid} user ${uid}: ${msg}`);
      return { awarded: null, warnings: [msg] };
    }

    // Pure read: no link — or this direction is off at 0% — is a NO-OP, not
    // an error. resolveMirrorTarget picks the direction column for us.
    const { mirror } = resolveMirrorTarget(cid, uid);
    if (!mirror) return { awarded: null, warnings };

    const getOutbound =
      typeof opts.getOutbound === "function" ? opts.getOutbound : getTargetOutbound;
    const targetOutbound = getOutbound(mirror.targetCommunityId);
    if (!targetOutbound) {
      const msg = `no client for target community ${mirror.targetCommunityId}`;
      console.error(`[linking] xp mirror skipped for community ${cid} user ${uid}: ${msg}`);
      warnings.push(msg);
      return { awarded: null, warnings };
    }

    // Sign-preserving rounding (negative decay-safe); a sub-rounding award
    // (e.g. 50% of 1) writes nothing and is reported as awarded: 0.
    const mirrored = mirrorDelta(numericDelta, mirror.pct);
    if (mirrored === 0) return { awarded: 0, warnings };

    // Lazy require: services/awardXp → features/linking/service → services/
    // awardXp is a load-time cycle; resolved at call time, after boot.
    const awardXpFn =
      typeof opts.awardXp === "function"
        ? opts.awardXp
        : require("../../services/awardXp").awardXp;

    try {
      await awardXpFn(targetOutbound, {
        communityId: mirror.targetCommunityId,
        userId: mirror.targetUserId,
        delta: mirrored,
        activityKind,
        member: null, // fetched via the TARGET outbound — role math runs on the target side
        source: "link_mirror",
        fanOut: false, // LOOP GUARD: a mirror never fans out again
      });
    } catch (err) {
      // awardXp validates ids and can throw on a broken row (e.g. the peer
      // community vanished). A failed target award is a PARTIAL failure:
      // report it, keep the primary award (rules 5/6).
      const msg =
        `mirror award of ${mirrored} XP to community ${mirror.targetCommunityId} ` +
        `user ${mirror.targetUserId} failed: ${causeOf(err)}`;
      console.error(`[linking] ${msg}`);
      warnings.push(msg);
      return { awarded: null, warnings };
    }

    return { awarded: mirrored, warnings };
  } catch (err) {
    // Net for everything else, including the loud programmer errors
    // resolveMirrorTarget throws (snowflake as community id). The award
    // pipeline must never die on its mirror leg (AGENTS.md rule 1).
    const msg =
      `xp mirror failed for community ${String(sourceCommunityId)} ` +
      `user ${String(userId)}: ${causeOf(err)}`;
    console.error(`[linking] ${msg}`);
    warnings.push(`xp mirror failed: ${causeOf(err)}`);
    return { awarded: null, warnings };
  }
}

// ---------------------------------------------------------------------------
// Pure read helpers for T4 (XP fan-out) and T5 (memory fan-out)
// ---------------------------------------------------------------------------

/**
 * Resolve the mirror target for a source identity (the seam T4's
 * fanOutLinkedXp calls). Pure repository read — no writes, no platform I/O.
 *
 * Direction is read from the SOURCE side of the link: a source that is side a
 * uses `mirror_a_to_b_pct` and writes to side b, and vice versa. `pct === 0`
 * means "this direction is off": the answer is `{ ok: true, mirror: null }`
 * so callers treat it as a no-op, not an error.
 *
 * Programmer errors (snowflake passed as community id, non-string user id)
 * THROW loudly, exactly like the repository.
 *
 * @param {number} communityId source community (integer)
 * @param {string} userId source external user id
 * @returns {{ ok: true, link: object|null, mirror: {
 *   sourceCommunityId: number, sourceUserId: string,
 *   targetCommunityId: number, targetUserId: string,
 *   pct: number, direction: 'a_to_b'|'b_to_a', mirrorMemory: boolean
 * }|null, pct: number }}
 */
function resolveMirrorTarget(communityId, userId) {
  const cid = assertCommunityId(communityId);
  const uid = requireUserId(userId, "userId");
  const link = repo.getLinkFor(cid, uid) || null;
  if (!link) return { ok: true, link: null, mirror: null, pct: 0 };

  const sourceIsA = link.community_id_a === cid && link.user_id_a === uid;
  const pct = Number(sourceIsA ? link.mirror_a_to_b_pct : link.mirror_b_to_a_pct);
  if (pct === 0) return { ok: true, link, mirror: null, pct: 0 };

  return {
    ok: true,
    link,
    pct,
    mirror: {
      sourceCommunityId: cid,
      sourceUserId: uid,
      targetCommunityId: sourceIsA ? link.community_id_b : link.community_id_a,
      targetUserId: sourceIsA ? link.user_id_b : link.user_id_a,
      pct,
      direction: sourceIsA ? "a_to_b" : "b_to_a",
      mirrorMemory: Number(link.mirror_memory) === 1,
    },
  };
}

/**
 * Expand a batch of source user ids to their linked counterparts — the read
 * helper for gork fan-out (T5: read fan-out in loadMemoryContext, write
 * fan-out in runMemoryTurn, and the recall tool).
 *
 * Inclusion follows the EXISTENCE of a link, not the XP percentage: memory
 * mirroring has its own switch (`mirror_memory`), so an id whose XP mirror is
 * 0% still expands and carries `mirrorMemory: true|1|0` for the caller to act
 * on. Callers use the flag to skip write fan-out while keeping read fan-out.
 *
 * Non-string / blank ids in the input are skipped (counted, logged once);
 * duplicates collapse to one entry.
 *
 * @param {number} communityId source community (integer)
 * @param {Array<string>} userIds source-side external user ids
 * @returns {{ ok: true, targets: Array<{ sourceUserId: string, targetCommunityId: number, targetUserId: string, mirrorMemory: boolean }>, skipped: number }}
 */
function expandLinkedIds(communityId, userIds) {
  const cid = assertCommunityId(communityId);
  if (!Array.isArray(userIds)) {
    throw new TypeError(
      `linking: expandLinkedIds needs an array of user ids, got ${userIds === null ? "null" : typeof userIds}`,
    );
  }
  const targets = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of userIds) {
    const uid = typeof raw === "string" ? raw.trim() : "";
    if (uid === "") {
      skipped += 1;
      continue;
    }
    if (seen.has(uid)) continue;
    seen.add(uid);
    const link = repo.getLinkFor(cid, uid);
    if (!link) continue;
    const side = callerSide(link, cid, uid);
    if (!side) continue; // defensive: getLinkFor guarantees a party match
    const peer = peerSide(link, side);
    targets.push({
      sourceUserId: uid,
      targetCommunityId: peer.communityId,
      targetUserId: peer.userId,
      mirrorMemory: Number(link.mirror_memory) === 1,
    });
  }
  if (skipped > 0) {
    console.error(
      `[linking] expandLinkedIds skipped ${skipped} blank/non-string user id(s) for community ${cid}`,
    );
  }
  return { ok: true, targets, skipped };
}

/**
 * Sweeper GC for spent/expired link codes (T2's index.js arms the job; the
 * repository keeps used rows until expiry so replays can report "already
 * used"). Thin, logged wrapper so no caller touches the repository directly.
 *
 * @param {number} [at=Date.now()] ms epoch cutoff
 * @param {object} [opts]
 * @param {object} [opts.repo]
 * @returns {number} deleted row count
 */
function purgeExpiredLinkCodes(at = Date.now(), opts = {}) {
  const linkRepo = opts.repo ?? repo;
  try {
    return linkRepo.purgeExpiredLinkCodes(Number(at));
  } catch (err) {
    console.error("[linking] purgeExpiredLinkCodes failed:", causeOf(err));
    return 0;
  }
}

module.exports = {
  // message surface (tests and T3 handlers pin the sentences)
  LINK_MESSAGES,
  DEFAULT_SURFACE_CMD,
  // command-facing services (T3 handlers)
  createLinkCode,
  redeemLinkCode,
  getLinkFor,
  removeLink,
  configureMirror,
  // pure read helpers (T4 XP fan-out, T5 memory fan-out)
  resolveMirrorTarget,
  expandLinkedIds,
  // T4 XP fan-out seam (awardXp consumes fanOutLinkedXp; index.js attaches
  // the supervisor at boot; mirrorDelta is exported for tests/audit)
  attachSupervisor,
  getTargetOutbound,
  mirrorDelta,
  fanOutLinkedXp,
  // maintenance
  purgeExpiredLinkCodes,
};
