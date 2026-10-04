/**
 * Account-linking repository (roadmap/account-linking.md T1): the ONLY module
 * that reads/writes `user_links` and `user_link_codes` (migration 036).
 *
 * Contract notes the callers rely on:
 *  - Identity firewall: every function that takes a community id calls
 *    assertCommunityId FIRST, before touching SQL — a Discord snowflake (string)
 *    can never reach a query as a key. A user_links row is the only structure
 *    allowed to relate a Discord id to a Fluxer id; raw ids are never joined
 *    across platforms.
 *  - Reads (getLinkFor / getLinkById / listLinksForCommunity /
 *    getLinkCodeByHash) return rows / null / [] and never throw on empty.
 *    getLinkById is party-scoped: a caller only resolves a link its own
 *    community is a party to.
 *  - Mutations (createLink / removeLink / setMirrorPct / setMirrorMemory /
 *    createLinkCode) answer {ok:false, error} with a specific, human-readable
 *    cause (AGENTS.md § Error Handling) for the EXPECTED races — one side
 *    already linked, code hash replay, caller not a party. Services map these
 *    to user-facing sentences; they never see raw SQLite messages.
 *  - Programmer errors (bad id types, self-pairing, unknown mirror direction)
 *    throw TypeError with the offending value; garbage arguments are never
 *    bound into SQL.
 *  - Single use of a link code is enforced HERE, atomically: consumeLinkCode
 *    runs UPDATE ... WHERE used_at IS NULL AND expires_at > ? and checks
 *    changes === 1 (mirroring consumeOAuthTransaction,
 *    src/db/repositories/fluxerOAuthTransactions.js) so two racing redemptions
 *    can never both succeed.
 *
 * Link canonical orientation (design bundle): side a is the Discord side, side
 * b the Fluxer side, decided by communities.platform. That policy lives in the
 * linking service; this repository is platform-agnostic.
 */

const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/bridges.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** XP mirror direction keys (source side → target side). */
const LINK_MIRROR_DIRECTIONS = Object.freeze(["a_to_b", "b_to_a"]);

/** Link-code lifetime: 15 minutes (design bundle, locked). */
const LINK_CODE_LIFETIME_MS = 15 * 60 * 1000;

const LINK_COLUMNS = `
  id, community_id_a, user_id_a, community_id_b, user_id_b,
  mirror_a_to_b_pct, mirror_b_to_a_pct, mirror_memory, created_at
`;

const LINK_SELECT = `SELECT ${LINK_COLUMNS} FROM user_links`;

const LINK_CODE_SELECT = `
  SELECT id, code_hash, community_id, user_id, created_at, expires_at, used_at
  FROM user_link_codes
`;

// ---------------------------------------------------------------------------
// Validation helpers (programmer errors throw; see file header)
// ---------------------------------------------------------------------------

/**
 * Programmer-error guard for external user id strings (Discord snowflakes,
 * Fluxer subs — opaque TEXT, always scoped by a community id).
 * @param {unknown} value
 * @param {string} name
 * @returns {string} the trimmed value
 */
function requireUserId(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    const shape =
      typeof value === "string" ? "empty string" : value === null ? "null" : typeof value;
    throw new TypeError(`userLinks: ${name} must be a non-empty string, got ${shape}`);
  }
  return value.trim();
}

/**
 * @param {unknown} value
 * @returns {number} the validated link rowid
 */
function requireLinkId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`userLinks: link id must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/**
 * 32-byte SHA-256 digest guard (same contract as bridges.requireDigest) —
 * codes are stored as hashed digests, plaintext never reaches this module.
 * @param {unknown} value
 * @param {string} name
 * @returns {Buffer}
 */
function requireDigest(value, name) {
  const ok = (Buffer.isBuffer(value) || value instanceof Uint8Array) && value.length === 32;
  if (!ok) {
    throw new TypeError(`userLinks: ${name} must be a 32-byte sha256 digest Buffer`);
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

/** Render a value for an error message without throwing on exotic types. */
function displayValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return String(value);
  } catch {
    return typeof value;
  }
}

/**
 * Validate a mirror percentage. Returns {ok:false, error} (not a throw) for
 * user-supplied out-of-range values: the service maps them straight onto the
 * `link config <direction> <pct>` reply. Only a real number type qualifies —
 * strings/null/undefined never coerce (null must not silently mean 0).
 * @param {unknown} value
 * @param {string} label e.g. 'mirror percent (a_to_b)'
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
function normalizeMirrorPct(value, label) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) {
    return { ok: true, value };
  }
  return {
    ok: false,
    error: `${label} must be a whole number between 0 and 100 (got ${displayValue(value)})`,
  };
}

/**
 * Validate the boolean-ish memory-mirror switch (stored 0/1).
 * @param {unknown} value
 * @returns {{ ok: true, value: 0 | 1 } | { ok: false, error: string }}
 */
function normalizeMirrorFlag(value) {
  if (value === true || value === 1) return { ok: true, value: 1 };
  if (value === false || value === 0) return { ok: true, value: 0 };
  return {
    ok: false,
    error: `mirror_memory must be on (true/1) or off (false/0), got ${displayValue(value)}`,
  };
}

function isUniqueViolation(err) {
  return !!err && String(err.code || "").startsWith("SQLITE_CONSTRAINT_UNIQUE");
}

/**
 * Build the "already linked" sentence naming the offending side and the date
 * the existing link was made (design bundle: the conflict message names which
 * side holds the existing link, date only).
 *
 * @param {'first'|'second'} side which create argument collided
 * @param {number} communityId caller-side community of that argument
 * @param {string} userId caller-side user id of that argument
 * @param {object} row the existing user_links row
 * @returns {string}
 */
function describeExistingLink(side, communityId, userId, row) {
  const callerIsA = row.community_id_a === communityId;
  const peerCommunity = callerIsA ? row.community_id_b : row.community_id_a;
  const peerUser = callerIsA ? row.user_id_b : row.user_id_a;
  const when = new Date(Number(row.created_at)).toISOString();
  return (
    `the ${side} side (user ${userId} in community ${communityId}) is already linked to ` +
    `user ${peerUser} in community ${peerCommunity} (linked since ${when}) — ` +
    "remove that link first"
  );
}

// ---------------------------------------------------------------------------
// user_links CRUD
// ---------------------------------------------------------------------------

const selectLinkFor = db.prepare(`${LINK_SELECT} WHERE (community_id_a = ? AND user_id_a = ?) OR (community_id_b = ? AND user_id_b = ?) LIMIT 1`);

/**
 * Resolve a user's link from either side.
 * @param {number} communityId
 * @param {string} userId external user id at that community's platform
 * @returns {object|null} user_links row (raw column names)
 */
function getLinkFor(communityId, userId) {
  const cid = assertCommunityId(communityId);
  const uid = requireUserId(userId, "userId");
  return selectLinkFor.get(cid, uid, cid, uid) || null;
}

/**
 * Fetch one link by rowid, party-scoped: the caller's community must be a
 * party to the link, otherwise null (identity firewall — no enumeration of
 * other communities' links).
 *
 * @param {number} communityId
 * @param {number} linkId
 * @returns {object|null}
 */
function getLinkById(communityId, linkId) {
  const cid = assertCommunityId(communityId);
  const id = requireLinkId(linkId);
  const row = db.prepare(`${LINK_SELECT} WHERE id = ?`).get(id);
  if (!row) return null;
  return row.community_id_a === cid || row.community_id_b === cid ? row : null;
}

/**
 * Every link a community is a party to (status/audit listings), oldest first.
 * @param {number} communityId
 * @returns {object[]}
 */
function listLinksForCommunity(communityId) {
  const cid = assertCommunityId(communityId);
  return db
    .prepare(`${LINK_SELECT} WHERE community_id_a = ? OR community_id_b = ? ORDER BY created_at ASC, id ASC`)
    .all(cid, cid);
}

/**
 * Create a link between two (community, user) identities.
 *
 * Service-layer prerequisites enforced upstream (this repo rejects the obvious
 * programmer violations): the two communities are on OPPOSITE platforms and
 * share an ACTIVE bridge (use hasActiveBridgeBetween). Side `a` is canonically
 * the Discord side.
 *
 * @param {object} args
 * @param {number} args.communityIdA integer community id for side a
 * @param {string} args.userIdA external user id on side a
 * @param {number} args.communityIdB integer community id for side b
 * @param {string} args.userIdB external user id on side b
 * @param {number} [args.mirrorAtoBPct=100] 0–100 integer
 * @param {number} [args.mirrorBtoAPct=100] 0–100 integer
 * @param {boolean|number} [args.mirrorMemory=1] on/off (stored 1/0)
 * @returns {{ ok: true, link: object } | { ok: false, error: string, existingLink?: object }}
 */
function createLink({
  communityIdA,
  userIdA,
  communityIdB,
  userIdB,
  mirrorAtoBPct = 100,
  mirrorBtoAPct = 100,
  mirrorMemory = 1,
} = {}) {
  const cidA = assertCommunityId(communityIdA);
  const cidB = assertCommunityId(communityIdB);
  const uidA = requireUserId(userIdA, "userIdA");
  const uidB = requireUserId(userIdB, "userIdB");
  if (cidA === cidB) {
    throw new TypeError(
      `userLinks: createLink needs two distinct communities (got ${cidA} on both sides) — a platform pair is always cross-platform`,
    );
  }
  const pctA = normalizeMirrorPct(mirrorAtoBPct, "mirror percent (a_to_b)");
  if (!pctA.ok) return { ok: false, error: pctA.error };
  const pctB = normalizeMirrorPct(mirrorBtoAPct, "mirror percent (b_to_a)");
  if (!pctB.ok) return { ok: false, error: pctB.error };
  const memory = normalizeMirrorFlag(mirrorMemory);
  if (!memory.ok) return { ok: false, error: memory.error };

  const insert = db.prepare(`
    INSERT INTO user_links
      (community_id_a, user_id_a, community_id_b, user_id_b,
       mirror_a_to_b_pct, mirror_b_to_a_pct, mirror_memory, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // Pre-check both sides so the message can name WHICH side is taken.
    const takenA = selectLinkFor.get(cidA, uidA, cidA, uidA);
    if (takenA) {
      return { ok: false, error: describeExistingLink("first", cidA, uidA, takenA), existingLink: takenA };
    }
    const takenB = selectLinkFor.get(cidB, uidB, cidB, uidB);
    if (takenB) {
      return { ok: false, error: describeExistingLink("second", cidB, uidB, takenB), existingLink: takenB };
    }
    const info = insert.run(cidA, uidA, cidB, uidB, pctA.value, pctB.value, memory.value, now());
    return { ok: true, link: db.prepare(`${LINK_SELECT} WHERE id = ?`).get(Number(info.lastInsertRowid)) };
  });

  try {
    return tx();
  } catch (err) {
    // Lost the race against a concurrent create on one of the UNIQUE sides:
    // rebuild the specific "already linked" message from the committed row.
    if (isUniqueViolation(err)) {
      const existing = selectLinkFor.get(cidA, uidA, cidA, uidA) || selectLinkFor.get(cidB, uidB, cidB, uidB);
      if (existing) {
        const side =
          (existing.community_id_a === cidA && existing.user_id_a === uidA) ||
          (existing.community_id_b === cidA && existing.user_id_b === uidA)
            ? "first"
            : "second";
        const cid = side === "first" ? cidA : cidB;
        const uid = side === "first" ? uidA : uidB;
        return {
          ok: false,
          error: describeExistingLink(side, cid, uid, existing),
          existingLink: existing,
        };
      }
      const wrapped = new Error(
        `userLinks: createLink hit a UNIQUE constraint with no existing side to name: ${err.message}`,
        { cause: err },
      );
      wrapped.code = "user_link_constraint";
      throw wrapped;
    }
    throw err;
  }
}

/**
 * Delete the caller's link. The caller (communityId, userId) must be a party
 * — a non-party gets {ok:false} naming what is missing.
 *
 * XP rows and memories already mirrored are NOT retroactively removed
 * (documented limitation); mirroring stops for future awards.
 *
 * @param {number} communityId
 * @param {string} userId
 * @returns {{ ok: true, link: object } | { ok: false, error: string }}
 */
function removeLink(communityId, userId) {
  const link = getLinkFor(communityId, userId);
  if (!link) {
    const cid = assertCommunityId(communityId);
    const uid = requireUserId(userId, "userId");
    return {
      ok: false,
      error:
        `user ${uid} in community ${cid} has no account link to remove — ` +
        "link create mints a code and link connect creates the link",
    };
  }
  db.prepare(`DELETE FROM user_links WHERE id = ?`).run(link.id);
  return { ok: true, link };
}

/**
 * Set one XP mirror direction's percentage (0–100 integer). Caller must be a
 * party to the link (resolved via their own (community, user) side).
 *
 * @param {number} communityId caller's community
 * @param {string} userId caller's user id
 * @param {'a_to_b'|'b_to_a'} direction which stored column to write
 * @param {number} pct 0–100 integer
 * @returns {{ ok: true, link: object } | { ok: false, error: string }}
 */
function setMirrorPct(communityId, userId, direction, pct) {
  const cid = assertCommunityId(communityId);
  const uid = requireUserId(userId, "userId");
  if (!LINK_MIRROR_DIRECTIONS.includes(direction)) {
    throw new TypeError(
      `userLinks: mirror direction must be one of ${LINK_MIRROR_DIRECTIONS.join(", ")} (got ${displayValue(direction)})`,
    );
  }
  const checked = normalizeMirrorPct(pct, `mirror percent (${direction})`);
  if (!checked.ok) return { ok: false, error: checked.error };

  const link = getLinkFor(cid, uid);
  if (!link) {
    return {
      ok: false,
      error:
        `user ${uid} in community ${cid} has no account link to configure — ` +
        "link create mints a code and link connect creates the link",
    };
  }
  // Whitelisted column names only — direction never reaches the SQL string raw.
  const column = direction === "a_to_b" ? "mirror_a_to_b_pct" : "mirror_b_to_a_pct";
  db.prepare(`UPDATE user_links SET ${column} = ? WHERE id = ?`).run(checked.value, link.id);
  return { ok: true, link: db.prepare(`${LINK_SELECT} WHERE id = ?`).get(link.id) };
}

/**
 * Flip the gork memory mirror switch for the caller's link.
 *
 * @param {number} communityId caller's community
 * @param {string} userId caller's user id
 * @param {boolean|number} enabled on/off
 * @returns {{ ok: true, link: object } | { ok: false, error: string }}
 */
function setMirrorMemory(communityId, userId, enabled) {
  const cid = assertCommunityId(communityId);
  const uid = requireUserId(userId, "userId");
  const flag = normalizeMirrorFlag(enabled);
  if (!flag.ok) return { ok: false, error: flag.error };

  const link = getLinkFor(cid, uid);
  if (!link) {
    return {
      ok: false,
      error:
        `user ${uid} in community ${cid} has no account link to configure — ` +
        "link create mints a code and link connect creates the link",
    };
  }
  db.prepare(`UPDATE user_links SET mirror_memory = ? WHERE id = ?`).run(flag.value, link.id);
  return { ok: true, link: db.prepare(`${LINK_SELECT} WHERE id = ?`).get(link.id) };
}

// ---------------------------------------------------------------------------
// user_link_codes (mint / redeem / purge)
// ---------------------------------------------------------------------------

const selectCodeByHash = db.prepare(`${LINK_CODE_SELECT} WHERE code_hash = ?`);

/**
 * Storage/comparison key for a digest: lowercase hex TEXT, matching the
 * column's declared TEXT affinity (036). Callers pass 32-byte Buffers; the
 * hex form is what the UNIQUE index and equality lookups see.
 * @param {Buffer} digest
 * @returns {string}
 */
const codeHashKey = (digest) => digest.toString("hex");

/**
 * Mint a one-time link code row for (community, user). The plaintext lives
 * only in the minting service's reply; this table stores the SHA-256 digest
 * (same at-rest rule as bridges.code_hash).
 *
 * @param {object} args
 * @param {number} args.communityId community where the code is created
 * @param {string} args.userId external user id at the creation side
 * @param {Buffer|Uint8Array} args.codeHash 32-byte sha256 digest of the canonical code
 * @param {number|null} [args.expiresAt=null] ms epoch; defaults to now + 15 min
 * @returns {{ ok: true, linkCode: object } | { ok: false, error: string }}
 */
function createLinkCode({ communityId, userId, codeHash, expiresAt = null } = {}) {
  const cid = assertCommunityId(communityId);
  const uid = requireUserId(userId, "userId");
  const hash = requireDigest(codeHash, "codeHash");
  const ts = now();
  let expiry = expiresAt;
  if (expiry == null) {
    expiry = ts + LINK_CODE_LIFETIME_MS;
  } else {
    expiry = Number(expiresAt);
    if (!Number.isSafeInteger(expiry)) {
      throw new TypeError(`userLinks: expiresAt must be an integer ms epoch, got ${String(expiresAt)}`);
    }
  }

  try {
    const info = db
      .prepare(
        `INSERT INTO user_link_codes (code_hash, community_id, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(codeHashKey(hash), cid, uid, ts, expiry);
    return { ok: true, linkCode: selectCodeByHash.get(codeHashKey(hash)) };
  } catch (err) {
    // A duplicate digest means the exact code was minted before; mint a fresh
    // one (bridge codes follow the same collision-retry posture).
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        error:
          "a link code with this exact code hash already exists — mint a fresh code and retry",
      };
    }
    throw err;
  }
}

/**
 * @param {Buffer|Uint8Array} codeHash 32-byte sha256 digest
 * @returns {object|null} user_link_codes row (used_at visible)
 */
function getLinkCodeByHash(codeHash) {
  const hash = requireDigest(codeHash, "codeHash");
  return selectCodeByHash.get(codeHashKey(hash)) || null;
}

/**
 * Atomically redeem a live (unused, unexpired) code: the single-use flip and
 * the expiry filter run in ONE UPDATE, so two racing redemptions can never
 * both see changes === 1 (mirrors consumeOAuthTransaction,
 * src/db/repositories/fluxerOAuthTransactions.js:75 — the linking flavor
 * marks used_at instead of deleting, so replays resolve to a used row).
 *
 * @param {Buffer|Uint8Array} codeHash 32-byte sha256 digest of the canonical code
 * @param {number} [at=now()] ms epoch for the expiry filter (injectable clock)
 * @returns {object|null} the redeemed row (used_at stamped), or null when the
 *   code is unknown, already used, or expired.
 */
function consumeLinkCode(codeHash, at = now()) {
  const hash = requireDigest(codeHash, "codeHash");
  const ts = Number(at);
  if (!Number.isSafeInteger(ts)) {
    throw new TypeError(`userLinks: consumeLinkCode at must be an integer ms epoch, got ${String(at)}`);
  }
  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE user_link_codes
         SET used_at = ?
         WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .run(ts, codeHashKey(hash), ts);
    if (result.changes !== 1) return null; // unknown / used / expired — single use holds
    return selectCodeByHash.get(codeHashKey(hash)) || null;
  });
  return tx();
}

/**
 * Sweeper GC: drop codes whose expiry has passed (used codes keep their row
 * until expiry so replays report "already used", then they leave the table).
 *
 * @param {number} [at=now()] ms epoch cutoff (injectable clock)
 * @returns {number} deleted row count
 */
function purgeExpiredLinkCodes(at = now()) {
  const ts = Number(at);
  if (!Number.isSafeInteger(ts)) {
    throw new TypeError(`userLinks: purgeExpiredLinkCodes at must be an integer ms epoch, got ${String(at)}`);
  }
  return db.prepare(`DELETE FROM user_link_codes WHERE expires_at <= ?`).run(ts).changes;
}

// ---------------------------------------------------------------------------
// Bridge-pair gate (design bundle: links only live between bridge-paired
// communities)
// ---------------------------------------------------------------------------

const selectActivePair = db.prepare(`
  SELECT b.id
  FROM bridges b
  JOIN bridge_ends ea ON ea.bridge_id = b.id AND ea.position = 'a'
  JOIN bridge_ends eb ON eb.bridge_id = b.id AND eb.position = 'b'
  WHERE b.state = 'active'
    AND ((ea.community_id = ? AND eb.community_id = ?) OR (ea.community_id = ? AND eb.community_id = ?))
  LIMIT 1
`);

/**
 * Does an ACTIVE bridge connect these two communities? (roadmap/bridge.md
 * state machine: bridges.state 'active' with one 'a' and one 'b' end;
 * pending/broken rows never qualify.) Orientation-agnostic — bridges are
 * stored create-side-first, links are queried in both orders.
 *
 * @param {number} communityIdA
 * @param {number} communityIdB
 * @returns {boolean}
 */
function hasActiveBridgeBetween(communityIdA, communityIdB) {
  const cidA = assertCommunityId(communityIdA);
  const cidB = assertCommunityId(communityIdB);
  if (cidA === cidB) return false; // a community is never paired with itself
  return selectActivePair.get(cidA, cidB, cidB, cidA) !== undefined;
}

module.exports = {
  // constants
  LINK_MIRROR_DIRECTIONS,
  LINK_CODE_LIFETIME_MS,
  // links
  createLink,
  getLinkFor,
  getLinkById,
  listLinksForCommunity,
  removeLink,
  setMirrorPct,
  setMirrorMemory,
  // codes
  createLinkCode,
  getLinkCodeByHash,
  consumeLinkCode,
  purgeExpiredLinkCodes,
  // pairing gate
  hasActiveBridgeBetween,
};
