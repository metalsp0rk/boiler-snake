/**
 * Channel bridge repository (roadmap/bridge.md § Data Model Changes, §10.1,
 * §10.10) — the only module that reads/writes the six bridge tables.
 *
 * Contract notes the callers rely on:
 *  - NOTHING here sets state='active'. The pending→active flip is a
 *    compare-and-swap owned by the connect service (PR 4, KD 22); a build
 *    that cannot copy files and PATCH/DELETE copies must not be able to
 *    activate a bridge.
 *  - Every delete of a bridge is deleteBridgeCascade(): explicit
 *    child-then-parent order in one transaction. FK cascade is documentation
 *    only (spec § Background & Motivation), and an end row left behind pins
 *    UNIQUE (community_id, channel_id) forever (the 034 lesson).
 *  - The repository throws on programmer errors (bad ids, garbage arguments)
 *    and tags the two expected constraint races with err.code
 *    ('bridge_channel_taken' / 'bridge_public_id_taken') so the future
 *    service can map them to the §10.2 sentences. Services never see raw
 *    SQLite messages.
 */

const crypto = require("crypto");
const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/honeypot.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** @typedef {import('../../platform/community')} Community */

/** States the bridges.state CHECK accepts. */
const BRIDGE_STATES = Object.freeze(["pending", "active", "broken"]);

/** Outbox queue states (bridge_outbox.state; CHECK-free by spec — enforced here). */
const BRIDGE_OUTBOX_STATES = Object.freeze(["pending", "sending", "done", "failed"]);

/** Relayed directions (KD 19). 'both' exists only on bridges.direction. */
const BRIDGE_RELAY_DIRECTIONS = Object.freeze(["a_to_b", "b_to_a"]);

/** Legal bridges.direction values (KD 19; 'both' is the create-side default). */
const BRIDGE_DIRECTIONS = Object.freeze(["both", "a_to_b", "b_to_a"]);

/** Bridge create → connect window (spec §10.1 "Lifetime of the code": 30 minutes). */
const BRIDGE_CODE_LIFETIME_MS = 30 * 60 * 1000;

/** Well-formed connect misses allowed per community per window (spec §10.1). */
const BRIDGE_CONNECT_MISS_LIMIT = 5;

/** Sliding window for the connect-failure counter (spec: 5 per 10 minutes). */
const BRIDGE_CONNECT_WINDOW_MS = 10 * 60 * 1000;

/** Poison-park threshold for a single outbox row (spec §10.10 failure ladder). */
const BRIDGE_OUTBOX_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Pairing credential format (roadmap/bridge.md §10.1)
// ---------------------------------------------------------------------------

/** Crockford base32 alphabet (excludes I, L, O, U). */
const CROCKFORD_UPPER = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_LOWER = CROCKFORD_UPPER.toLowerCase();

/** Canonical (upper, stripped) pairing code length: 22 chars, 128 bits of seed. */
const CODE_SEED_BYTES = 16;
const CODE_CANONICAL_LEN = 22;

/** Handle shape (safe to post): b_ + 8 lowercase Crockford chars. */
const HANDLE_PREFIX = "b_";
const HANDLE_BODY_LEN = 8;
const HANDLE_RE = /^b_[0-9a-hjkmnp-tv-z]{8}$/;

/** Canonical codes contain only Crockford characters (uppercase form). */
const CROCKFORD_UPPER_RE = /^[0-9A-HJ-KM-NP-TV-Z]+$/;

/** Collision-retry budget for generatePublicId (2^40 space; this is paranoia). */
const MAX_HANDLE_ATTEMPTS = 16;

/**
 * Base32-encode bytes with a Crockford-style alphabet, MSB first, trailing
 * bits zero-padded (spec §10.1: "128 bits from crypto.randomBytes, Crockford
 * base32"). Returns exactly `charCount` characters.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {number} charCount
 * @param {string} alphabet 32-character alphabet
 * @returns {string}
 */
function encodeCrockford(bytes, charCount, alphabet) {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = ((acc << 8) | byte) & 0xffffffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return out.slice(0, charCount);
}

/**
 * Group a canonical code for display: BRG-XXXX-XXXX-XXXX-XXXX-XXXX-XX.
 * Canonical strings whose length is not 22 pass through untouched — display
 * formatting never validates, classification does.
 *
 * @param {string} canonical
 * @returns {string}
 */
function formatDisplayCode(canonical) {
  return canonical.replace(
    /^(.{4})(.{4})(.{4})(.{4})(.{4})(.*)$/,
    "$1-$2-$3-$4-$5-$6",
  );
}

/**
 * Canonical storage/comparison form (spec §10.1): uppercase, hyphens and
 * spaces stripped, a leading BRG prefix stripped.
 *
 * @param {string} raw
 * @returns {string} canonical form ('' for non-strings / empty input)
 */
function canonicalizeConnectCode(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().toUpperCase().replace(/[-\s]/g, "");
  if (s.startsWith("BRG")) s = s.slice(3);
  return s;
}

/** Handle inputs are trimmed + lowercased before validation (spec §10.1). */
function normalizeHandle(raw) {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * @param {string} raw
 * @returns {boolean} true when the input is a bridge handle (never a credential)
 */
function isBridgeHandle(raw) {
  return HANDLE_RE.test(normalizeHandle(raw));
}

/**
 * Mint a one-time connect credential: 128 random bits → Crockford base32 →
 * the canonical 22-char form, its display form, and the at-rest SHA-256
 * digest (32 bytes). The raw code exists only in create's delivery; only the
 * digest is ever stored.
 *
 * @returns {{ displayCode: string, canonical: string, digest: Buffer }}
 */
function generateConnectCode() {
  const canonical = encodeCrockford(
    crypto.randomBytes(CODE_SEED_BYTES),
    CODE_CANONICAL_LEN,
    CROCKFORD_UPPER,
  );
  return {
    // Spec §10.1: the user-facing display form carries the BRG- prefix; the
    // canonical storage form never does (canonicalizeConnectCode strips it).
    displayCode: "BRG-" + formatDisplayCode(canonical),
    canonical,
    digest: hashConnectCode(canonical),
  };
}

/**
 * Independent random id used in notices/status/list — NOT a credential, and
 * never run through the hasher (spec §10.1 "Two values, not one id").
 *
 * @param {object} [opts]
 * @param {(publicId: string) => boolean} [opts.isTaken] collision probe (e.g.
 *   `(id) => !!getBridgeByPublicId(id)`) — a taken handle is retried, up to
 *   MAX_HANDLE_ATTEMPTS times.
 * @returns {string} 'b_' + 8 lowercase Crockford chars
 */
function generatePublicId({ isTaken } = {}) {
  for (let attempt = 1; attempt <= MAX_HANDLE_ATTEMPTS; attempt++) {
    const bytes = crypto.randomBytes(HANDLE_BODY_LEN);
    const publicId = HANDLE_PREFIX + encodeCrockford(bytes, HANDLE_BODY_LEN, CROCKFORD_LOWER);
    if (typeof isTaken !== "function" || !isTaken(publicId)) return publicId;
  }
  throw new Error(
    `generatePublicId: ${MAX_HANDLE_ATTEMPTS} consecutive handle collisions — refusing to mint (bridge table corrupt?)`,
  );
}

/**
 * SHA-256 of the canonical code — the value stored in bridges.code_hash.
 * Handles are rejected here: connect rejects the handle before the hasher
 * (spec §10.1), and a hash of 'b_…' could never match a code row anyway.
 *
 * @param {string} raw
 * @returns {Buffer} 32-byte digest
 */
function hashConnectCode(raw) {
  if (isBridgeHandle(raw)) {
    throw new TypeError("hashConnectCode: bridge handles are never run through the code hasher");
  }
  return crypto.createHash("sha256").update(canonicalizeConnectCode(raw), "utf8").digest();
}

/**
 * Constant-time compare of two stored digests. Length/type mismatches are
 * false, never a throw (timingSafeEqual throws on length mismatch).
 *
 * @param {Buffer|Uint8Array|null|undefined} a
 * @param {Buffer|Uint8Array|null|undefined} b
 * @returns {boolean}
 */
function digestsEqual(a, b) {
  const toBuf = (v) => (Buffer.isBuffer(v) ? v : v instanceof Uint8Array ? Buffer.from(v) : null);
  const ba = toBuf(a);
  const bb = toBuf(b);
  if (!ba || !bb) return false;
  if (ba.length !== 32 || bb.length !== 32) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Classify raw connect input BEFORE any hashing (spec §10.1): a handle is
 * rejected with the handle sentence, alphabet garbage gets the alphabet
 * sentence (and does NOT count toward the failure counter), and a
 * code-shaped string is a well-formed candidate whose lookup miss does.
 *
 * Length is deliberately not classified here: a code-shaped string of the
 * wrong length is a well-formed miss (no row can match its digest), matching
 * the spec's only defined split — "alphabet garbage does not" count.
 *
 * @param {string} raw
 * @returns {{ kind: 'empty' } | { kind: 'handle', publicId: string } |
 *            { kind: 'garbage', canonical: string } |
 *            { kind: 'code', canonical: string }}
 */
function classifyConnectInput(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "empty" };
  const handle = normalizeHandle(raw);
  if (HANDLE_RE.test(handle)) return { kind: "handle", publicId: handle };
  const canonical = canonicalizeConnectCode(raw);
  if (canonical === "") return { kind: "empty" };
  if (!CROCKFORD_UPPER_RE.test(canonical)) return { kind: "garbage", canonical };
  return { kind: "code", canonical };
}

// ---------------------------------------------------------------------------
// Shared validation helpers (programmer errors throw; see file header)
// ---------------------------------------------------------------------------

function requireText(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`bridges: ${name} must be a non-empty string`);
  }
  return value.trim();
}

function requireDigest(value, name) {
  const ok = (Buffer.isBuffer(value) || value instanceof Uint8Array) && value.length === 32;
  if (!ok) {
    throw new TypeError(`bridges: ${name} must be a 32-byte sha256 digest Buffer`);
  }
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function requireBridgeId(bridgeId) {
  if (!Number.isSafeInteger(bridgeId) || bridgeId < 1) {
    throw new TypeError(`bridges: bridge id must be a positive integer, got ${String(bridgeId)}`);
  }
  return bridgeId;
}

function toFlag(value) {
  return value ? 1 : 0;
}

function isUniqueViolation(err) {
  return !!err && String(err.code || "").startsWith("SQLITE_CONSTRAINT_UNIQUE");
}

function isCheckViolation(err) {
  return !!err && String(err.code || "").startsWith("SQLITE_CONSTRAINT_CHECK");
}

/**
 * Translate the constraint races into the codes the service maps to §10.2
 * sentences. Anything else keeps its original throw.
 */
function translateBridgeConstraint(err, context) {
  if (isCheckViolation(err)) {
    const wrapped = new Error(
      `bridges: ${context} rejected by a schema CHECK constraint: ${err.message}`,
      { cause: err },
    );
    wrapped.code = "bridge_check_constraint";
    throw wrapped;
  }
  if (isUniqueViolation(err)) {
    const msg = String(err.message || "");
    if (msg.includes("bridge_ends")) {
      const wrapped = new Error(
        `bridges: ${context} — the (community_id, channel_id) pair is already a bridge end (1:1 rule)`,
        { cause: err },
      );
      wrapped.code = "bridge_channel_taken";
      throw wrapped;
    }
    if (msg.includes("public_id")) {
      const wrapped = new Error(
        `bridges: ${context} — handle collision; mint a fresh public id and retry`,
        { cause: err },
      );
      wrapped.code = "bridge_public_id_taken";
      throw wrapped;
    }
    if (msg.includes("bridge_outbox")) {
      const wrapped = new Error(
        `bridges: ${context} — a queued row already exists for (bridge, direction, src_message_id, kind)`,
        { cause: err },
      );
      wrapped.code = "bridge_outbox_duplicate";
      throw wrapped;
    }
  }
  throw err;
}

// ---------------------------------------------------------------------------
// bridges + bridge_ends
// ---------------------------------------------------------------------------

const SELECT_BRIDGE = `
  SELECT id, public_id, state, direction, created_at, expires_at, connected_at,
         code_hash, created_by_user_id, last_error, broken_reason
  FROM bridges
`;

/**
 * @param {number} id
 * @returns {object|null} bridges row (raw column names)
 */
function getBridgeById(id) {
  requireBridgeId(id);
  return db.prepare(`${SELECT_BRIDGE} WHERE id = ?`).get(id) || null;
}

/**
 * @param {string} publicId handle, e.g. 'b_7k2m9qxp'
 * @returns {object|null}
 */
function getBridgeByPublicId(publicId) {
  const id = requireText(publicId, "publicId");
  return db.prepare(`${SELECT_BRIDGE} WHERE public_id = ?`).get(id) || null;
}

/**
 * Connect's credential lookup: digest of the canonical code → the owning row.
 * Rows keep code_hash until disconnect, so a replay of a spent code resolves
 * to the (now active) bridge and reports "already used" (spec §10.10 Replay).
 *
 * @param {Buffer|Uint8Array} digest 32-byte sha256 digest
 * @returns {object|null}
 */
function getBridgeByCodeHash(digest) {
  const buf = requireDigest(digest, "codeHash");
  return db.prepare(`${SELECT_BRIDGE} WHERE code_hash = ?`).get(buf) || null;
}

/**
 * Create the pending row + end A in ONE transaction (spec §10.1 create step).
 * The public id is minted by the service via generatePublicId (with an
 * isTaken probe); a UNIQUE race surfaces as err.code 'bridge_public_id_taken'.
 *
 * state is 'pending' by construction — this module never writes 'active'.
 *
 * @param {object} args
 * @param {string} args.publicId handle from generatePublicId
 * @param {string} args.createdByUserId external user id of the creator (display-only)
 * @param {number} args.endACommunityId create-side community id
 * @param {string} args.endAChannelId create-side channel id
 * @param {string} [args.direction='both'] 'both' | 'a_to_b' | 'b_to_a'
 * @param {number|null} [args.expiresAt] ms epoch; defaults to now + 30 minutes
 * @param {Buffer|Uint8Array|null} [args.codeHash] 32-byte digest of the pairing code
 * @param {boolean|number} [args.nsfw=0] end A channel flag (spec §10.9)
 * @param {boolean|number} [args.everyoneDeniedView=0] end A channel flag (spec §10.9)
 * @returns {object} the created bridges row
 */
function createBridge({
  publicId,
  createdByUserId,
  endACommunityId,
  endAChannelId,
  direction = "both",
  expiresAt = null,
  codeHash = null,
  nsfw = 0,
  everyoneDeniedView = 0,
} = {}) {
  const handle = requireText(publicId, "publicId");
  if (!HANDLE_RE.test(handle)) {
    throw new TypeError(`bridges: publicId must match ${HANDLE_RE} (got "${handle}")`);
  }
  const actor = requireText(createdByUserId, "createdByUserId");
  assertCommunityId(endACommunityId);
  const channel = requireText(endAChannelId, "endAChannelId");
  if (!BRIDGE_DIRECTIONS.includes(direction)) {
    throw new TypeError(
      `bridges: direction must be one of ${BRIDGE_DIRECTIONS.join(", ")} (got "${String(direction)}")`,
    );
  }
  const hash = codeHash == null ? null : requireDigest(codeHash, "codeHash");
  const ts = now();
  const expiry = expiresAt == null ? ts + BRIDGE_CODE_LIFETIME_MS : Number(expiresAt);
  if (!Number.isSafeInteger(expiry)) {
    throw new TypeError(`bridges: expiresAt must be an integer ms epoch, got ${String(expiresAt)}`);
  }

  const insertBridge = db.prepare(`
    INSERT INTO bridges (public_id, state, direction, created_at, expires_at, code_hash, created_by_user_id)
    VALUES (?, 'pending', ?, ?, ?, ?, ?)
  `);
  const insertEndA = db.prepare(`
    INSERT INTO bridge_ends (bridge_id, position, community_id, channel_id, nsfw, everyone_denied_view)
    VALUES (?, 'a', ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const info = insertBridge.run(handle, direction, ts, expiry, hash, actor);
    const newId = Number(info.lastInsertRowid);
    insertEndA.run(
      newId,
      endACommunityId,
      channel,
      toFlag(nsfw),
      toFlag(everyoneDeniedView),
    );
    return getBridgeById(newId);
  });

  try {
    return tx();
  } catch (err) {
    // Rollback is implicit (better-sqlite3). A taken channel and a handle
    // collision both surface as UNIQUE; name them for the service.
    translateBridgeConstraint(err, `createBridge(${handle})`);
  }
}

/**
 * All ends of a bridge, ordered 'a' then 'b'.
 * @param {number} bridgeId
 * @returns {object[]} bridge_ends rows
 */
function listBridgeEnds(bridgeId) {
  requireBridgeId(bridgeId);
  return db
    .prepare(`SELECT * FROM bridge_ends WHERE bridge_id = ? ORDER BY position ASC`)
    .all(bridgeId);
}

/**
 * The 1:1 lookup: which bridge end occupies (community, channel)?
 * @param {number} communityId
 * @param {string} channelId
 * @returns {object|null} bridge_ends row
 */
function getBridgeEndForChannel(communityId, channelId) {
  assertCommunityId(communityId);
  const channel = requireText(channelId, "channelId");
  return (
    db
      .prepare(`SELECT * FROM bridge_ends WHERE community_id = ? AND channel_id = ?`)
      .get(communityId, channel) || null
  );
}

/**
 * End + owning bridge in one step (status/list/disconnect resolve by channel).
 * @param {number} communityId
 * @param {string} channelId
 * @returns {{ bridge: object, end: object }|null}
 */
function getBridgeForChannel(communityId, channelId) {
  const end = getBridgeEndForChannel(communityId, channelId);
  if (!end) return null;
  return { bridge: getBridgeById(end.bridge_id), end };
}

/**
 * Every bridge touching a community (status/list). One row per end, joined.
 * @param {number} communityId
 * @returns {Array<{ bridge: object, end: object }>} oldest first
 */
function listBridgesForCommunity(communityId) {
  assertCommunityId(communityId);
  const ends = db
    .prepare(`SELECT * FROM bridge_ends WHERE community_id = ?`)
    .all(communityId);
  return ends
    .map((end) => ({ bridge: getBridgeById(end.bridge_id), end }))
    .filter((row) => row.bridge !== null)
    .sort((x, y) => x.bridge.created_at - y.bridge.created_at);
}

/**
 * Insert one end row. Used by connect for end B (inside its CAS transaction,
 * PR 4) and by tests; createBridge owns end A.
 *
 * @param {object} args
 * @param {number} args.bridgeId
 * @param {'a'|'b'} args.position
 * @param {number} args.communityId
 * @param {string} args.channelId
 * @param {boolean|number} [args.nsfw=0]
 * @param {boolean|number} [args.everyoneDeniedView=0]
 * @returns {object} the inserted bridge_ends row
 */
function addBridgeEnd({
  bridgeId,
  position,
  communityId,
  channelId,
  nsfw = 0,
  everyoneDeniedView = 0,
} = {}) {
  requireBridgeId(bridgeId);
  if (position !== "a" && position !== "b") {
    throw new TypeError(`bridges: end position must be 'a' or 'b' (got "${String(position)}")`);
  }
  assertCommunityId(communityId);
  const channel = requireText(channelId, "channelId");
  const insert = db.prepare(`
    INSERT INTO bridge_ends (bridge_id, position, community_id, channel_id, nsfw, everyone_denied_view)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  try {
    insert.run(bridgeId, position, communityId, channel, toFlag(nsfw), toFlag(everyoneDeniedView));
  } catch (err) {
    translateBridgeConstraint(err, `addBridgeEnd(bridge=${bridgeId}, position=${position})`);
  }
  return db
    .prepare(`SELECT * FROM bridge_ends WHERE bridge_id = ? AND position = ?`)
    .get(bridgeId, position);
}

/**
 * Record the relay webhook for one end (connect step 8 / recreate, PR 5+).
 * Token is the AES-256-GCM envelope ciphertext only — never plaintext.
 *
 * @param {number} bridgeId
 * @param {'a'|'b'} position
 * @param {{ webhookId?: string|null, tokenEnc?: string|null, uploadLimitBytes?: number|null }} patch
 * @returns {boolean} true when an end row was updated
 */
function setBridgeEndWebhook(bridgeId, position, { webhookId = null, tokenEnc = null, uploadLimitBytes = null } = {}) {
  requireBridgeId(bridgeId);
  if (position !== "a" && position !== "b") {
    throw new TypeError(`bridges: end position must be 'a' or 'b' (got "${String(position)}")`);
  }
  if (tokenEnc != null && typeof tokenEnc !== "string") {
    throw new TypeError("bridges: tokenEnc must be a string envelope (plaintext tokens are never stored)");
  }
  const result = db
    .prepare(`
      UPDATE bridge_ends
      SET webhook_id = ?, webhook_token_enc = ?, upload_limit_bytes = ?
      WHERE bridge_id = ? AND position = ?
    `)
    .run(webhookId, tokenEnc, uploadLimitBytes, bridgeId, position);
  return result.changes > 0;
}

/**
 * Persist the §10.9 warning flags for one end (captured at connect).
 * @param {number} bridgeId
 * @param {'a'|'b'} position
 * @param {{ nsfw?: boolean|number, everyoneDeniedView?: boolean|number }} flags
 * @returns {boolean} true when an end row was updated
 */
function setBridgeEndFlags(bridgeId, position, { nsfw, everyoneDeniedView } = {}) {
  requireBridgeId(bridgeId);
  if (position !== "a" && position !== "b") {
    throw new TypeError(`bridges: end position must be 'a' or 'b' (got "${String(position)}")`);
  }
  const result = db
    .prepare(`
      UPDATE bridge_ends
      SET nsfw = COALESCE(?, nsfw), everyone_denied_view = COALESCE(?, everyone_denied_view)
      WHERE bridge_id = ? AND position = ?
    `)
    .run(nsfw == null ? null : toFlag(nsfw), everyoneDeniedView == null ? null : toFlag(everyoneDeniedView), bridgeId, position);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// bridge_outbox (durable queue, FIFO per direction — spec §10.10)
// ---------------------------------------------------------------------------

function requireRelayDirection(direction) {
  if (!BRIDGE_RELAY_DIRECTIONS.includes(direction)) {
    throw new TypeError(
      `bridges: relay direction must be one of ${BRIDGE_RELAY_DIRECTIONS.join(", ")} (got "${String(direction)}")`,
    );
  }
  return direction;
}

/**
 * @param {number} outboxId
 * @returns {object|null} bridge_outbox row
 */
function getBridgeOutboxById(outboxId) {
  if (!Number.isSafeInteger(outboxId) || outboxId < 1) {
    throw new TypeError(`bridges: outbox id must be a positive integer, got ${String(outboxId)}`);
  }
  return db.prepare(`SELECT * FROM bridge_outbox WHERE id = ?`).get(outboxId) || null;
}

/**
 * Enqueue a relay row. Kind semantics (spec § Data Model Changes, §10.10):
 *  - create: one row per source message; the UNIQUE(bridge, direction, src,
 *    kind) constraint is the durable one-per-message rule.
 *  - edit: at most ONE PENDING edit per (bridge, direction, src) — a new edit
 *    replaces the pending row's payload (content hash recomputed by the
 *    caller). enqueued_at is kept so the coalesced edit stays behind its own
 *    create row (FIFO per direction).
 *  - delete: a takedown supersedes copies in flight — pending create/edit
 *    rows for the same source message are deleted, then the delete row lands.
 *
 * Sending/done/failed rows are never superseded: 'sending' means bytes are in
 * flight (at-least-once, KD 14).
 *
 * @param {number} bridgeId
 * @param {object} args
 * @param {'a_to_b'|'b_to_a'} args.direction
 * @param {'create'|'edit'|'delete'} [args.kind='create']
 * @param {string} args.srcMessageId
 * @param {object|string} [args.payload] payload_json content (object is stringified)
 * @param {number} [args.enqueuedAt] ms epoch; defaults to now()
 * @returns {object} the created/replaced bridge_outbox row
 */
function enqueueBridgeOutbox(bridgeId, { direction, kind = "create", srcMessageId, payload = "{}", enqueuedAt = null } = {}) {
  requireBridgeId(bridgeId);
  requireRelayDirection(direction);
  if (!["create", "edit", "delete"].includes(kind)) {
    throw new TypeError(`bridges: outbox kind must be create, edit, or delete (got "${String(kind)}")`);
  }
  const srcId = requireText(srcMessageId, "srcMessageId");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  const ts = enqueuedAt == null ? now() : Number(enqueuedAt);
  if (!Number.isSafeInteger(ts)) {
    throw new TypeError(`bridges: enqueuedAt must be an integer ms epoch, got ${String(enqueuedAt)}`);
  }
  if (!getBridgeById(bridgeId)) {
    throw new Error(`bridges: enqueue refused — bridge ${bridgeId} does not exist`);
  }

  const tx = db.transaction(() => {
    if (kind === "edit") {
      const pending = db
        .prepare(`
          SELECT id FROM bridge_outbox
          WHERE bridge_id = ? AND direction = ? AND src_message_id = ? AND kind = 'edit' AND state = 'pending'
        `)
        .get(bridgeId, direction, srcId);
      if (pending) {
        // One-pending-edit rule: replace in place, keep the queue slot.
        db.prepare(`UPDATE bridge_outbox SET payload_json = ? WHERE id = ?`).run(body, pending.id);
        return getBridgeOutboxById(pending.id);
      }
    } else if (kind === "delete") {
      db.prepare(`
        DELETE FROM bridge_outbox
        WHERE bridge_id = ? AND direction = ? AND src_message_id = ? AND kind IN ('create', 'edit') AND state = 'pending'
      `).run(bridgeId, direction, srcId);
    }
    const info = db
      .prepare(`
        INSERT INTO bridge_outbox (bridge_id, direction, kind, src_message_id, enqueued_at, state, payload_json)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `)
      .run(bridgeId, direction, kind, srcId, ts, body);
    return getBridgeOutboxById(Number(info.lastInsertRowid));
  });

  try {
    return tx();
  } catch (err) {
    translateBridgeConstraint(err, `enqueueBridgeOutbox(bridge=${bridgeId}, src=${srcId}, kind=${kind})`);
  }
}

/**
 * Claim the oldest pending row for one direction and move it to 'sending'
 * in a single transaction (one in-flight send per direction, KD 14).
 * A concurrent claim that loses the CAS returns null.
 *
 * @param {number} bridgeId
 * @param {'a_to_b'|'b_to_a'} direction
 * @returns {object|null} the claimed row (state 'sending')
 */
function claimNextOutboxRow(bridgeId, direction) {
  requireBridgeId(bridgeId);
  requireRelayDirection(direction);
  const tx = db.transaction(() => {
    const row = db
      .prepare(`
        SELECT id FROM bridge_outbox
        WHERE bridge_id = ? AND direction = ? AND state = 'pending'
        ORDER BY enqueued_at ASC, id ASC
        LIMIT 1
      `)
      .get(bridgeId, direction);
    if (!row) return null;
    const result = db
      .prepare(`UPDATE bridge_outbox SET state = 'sending' WHERE id = ? AND state = 'pending'`)
      .run(row.id);
    if (result.changes !== 1) return null; // lost the claim race
    return getBridgeOutboxById(row.id);
  });
  return tx();
}

/**
 * Destination ACK: the row is durable-copied. (Spool cleanup is the worker's.)
 * @param {number} outboxId
 * @returns {boolean} true when a sending/pending row was marked done
 */
function markOutboxDone(outboxId) {
  const result = db
    .prepare(`UPDATE bridge_outbox SET state = 'done' WHERE id = ? AND state IN ('pending', 'sending')`)
    .run(outboxId);
  return result.changes > 0;
}

/**
 * One failed attempt. Back to 'pending' for the next backoff step; parked as
 * 'failed' at the poison limit (spec §10.10: 5 attempts, then park + notice).
 *
 * @param {number} outboxId
 * @param {string|null} [lastError] reason recorded for status
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=5]
 * @returns {object|null} the updated row, null when the id does not exist
 */
function recordOutboxFailure(outboxId, lastError = null, { maxAttempts = BRIDGE_OUTBOX_MAX_ATTEMPTS } = {}) {
  const tx = db.transaction(() => {
    const row = getBridgeOutboxById(outboxId);
    if (!row) return null;
    const attempts = Number(row.attempts) + 1;
    const parked = attempts >= maxAttempts;
    db
      .prepare(`UPDATE bridge_outbox SET attempts = ?, state = ?, last_error = ? WHERE id = ?`)
      .run(attempts, parked ? "failed" : "pending", lastError == null ? row.last_error : String(lastError), outboxId);
    return getBridgeOutboxById(outboxId);
  });
  return tx();
}

/**
 * Restart recovery: rows abandoned mid-send go back to 'pending' and replay
 * from spool (spec §10.10 "Restart").
 * @returns {number} rows returned to pending
 */
function requeueStaleOutbox() {
  return db.prepare(`UPDATE bridge_outbox SET state = 'pending' WHERE state = 'sending'`).run()
    .changes;
}

/**
 * Outbox depth per direction for status (queued rows only: pending + sending).
 * @param {number} bridgeId
 * @returns {{ a_to_b: number, b_to_a: number }}
 */
function countOutboxDepth(bridgeId) {
  requireBridgeId(bridgeId);
  const depth = { a_to_b: 0, b_to_a: 0 };
  for (const row of db
    .prepare(`
      SELECT direction, COUNT(*) AS depth FROM bridge_outbox
      WHERE bridge_id = ? AND state IN ('pending', 'sending')
      GROUP BY direction
    `)
    .all(bridgeId)) {
    if (row.direction in depth) depth[row.direction] = Number(row.depth);
  }
  return depth;
}

// ---------------------------------------------------------------------------
// bridge_message_links + bridge_src_snapshots
// ---------------------------------------------------------------------------

/**
 * Record one destination execute (chunk/part) for a source message. Every
 * relay execute inserts a row with the next part_index (spec § Data Model).
 *
 * @param {object} args
 * @param {number} args.bridgeId
 * @param {number} args.srcCommunityId community owning the source end
 * @param {string} args.srcMessageId
 * @param {number} args.partIndex 0-based
 * @param {string} args.dstMessageId
 * @returns {object} the inserted row
 */
function addBridgeMessageLink({ bridgeId, srcCommunityId, srcMessageId, partIndex, dstMessageId } = {}) {
  requireBridgeId(bridgeId);
  assertCommunityId(srcCommunityId);
  const srcId = requireText(srcMessageId, "srcMessageId");
  const dstId = requireText(dstMessageId, "dstMessageId");
  if (!Number.isSafeInteger(partIndex) || partIndex < 0) {
    throw new TypeError(`bridges: part_index must be a non-negative integer, got ${String(partIndex)}`);
  }
  const ts = now();
  db
    .prepare(`
      INSERT INTO bridge_message_links (bridge_id, src_community_id, src_message_id, part_index, dst_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(bridgeId, srcCommunityId, srcId, partIndex, dstId, ts);
  return db
    .prepare(`
      SELECT * FROM bridge_message_links
      WHERE bridge_id = ? AND src_community_id = ? AND src_message_id = ? AND part_index = ?
    `)
    .get(bridgeId, srcCommunityId, srcId, partIndex);
}

/**
 * All destination parts of a source message, ordered for PATCH/DELETE relay.
 * @param {number} bridgeId
 * @param {string} srcMessageId
 * @returns {object[]}
 */
function listBridgeMessageLinks(bridgeId, srcMessageId) {
  requireBridgeId(bridgeId);
  const srcId = requireText(srcMessageId, "srcMessageId");
  return db
    .prepare(`
      SELECT * FROM bridge_message_links
      WHERE bridge_id = ? AND src_message_id = ?
      ORDER BY part_index ASC
    `)
    .all(bridgeId, srcId);
}

/**
 * Echo-gate lookup (KD 10): is this destination message id a relay copy?
 * (Callers partition by (platform, instanceKey) through communities — the id
 * is only unique inside a deployment.)
 *
 * @param {number} bridgeId
 * @param {string} dstMessageId
 * @returns {object|null}
 */
function getBridgeLinkByDestination(bridgeId, dstMessageId) {
  requireBridgeId(bridgeId);
  const dstId = requireText(dstMessageId, "dstMessageId");
  return (
    db
      .prepare(`SELECT * FROM bridge_message_links WHERE bridge_id = ? AND dst_message_id = ? LIMIT 1`)
      .get(bridgeId, dstId) || null
  );
}

/**
 * Record/refresh the canonical relay payload hash for a source message —
 * the edit coalescing store (spec §10.10: update BEFORE enqueueing so a rapid
 * edit chain coalesces).
 *
 * @param {number} bridgeId
 * @param {string} srcMessageId
 * @param {string} contentHash
 * @returns {object} the upserted row
 */
function upsertBridgeSrcSnapshot(bridgeId, srcMessageId, contentHash) {
  requireBridgeId(bridgeId);
  const srcId = requireText(srcMessageId, "srcMessageId");
  const hash = requireText(contentHash, "contentHash");
  const ts = now();
  db
    .prepare(`
      INSERT INTO bridge_src_snapshots (bridge_id, src_message_id, content_hash, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (bridge_id, src_message_id) DO UPDATE SET content_hash = excluded.content_hash, updated_at = excluded.updated_at
    `)
    .run(bridgeId, srcId, hash, ts);
  return db
    .prepare(`SELECT * FROM bridge_src_snapshots WHERE bridge_id = ? AND src_message_id = ?`)
    .get(bridgeId, srcId);
}

/**
 * @param {number} bridgeId
 * @param {string} srcMessageId
 * @returns {object|null}
 */
function getBridgeSrcSnapshot(bridgeId, srcMessageId) {
  requireBridgeId(bridgeId);
  const srcId = requireText(srcMessageId, "srcMessageId");
  return (
    db
      .prepare(`SELECT * FROM bridge_src_snapshots WHERE bridge_id = ? AND src_message_id = ?`)
      .get(bridgeId, srcId) || null
  );
}

// ---------------------------------------------------------------------------
// bridge_connect_attempts (§10.1 failure counter)
// ---------------------------------------------------------------------------

/**
 * Record ONE well-formed connect miss for a destination community (alphabet
 * garbage and same-platform attempts never reach this — the service filters
 * them). The first miss of a window starts it; a window that has elapsed is
 * replaced, which is the 10-minute reset.
 *
 * @param {number} communityId destination community (spec: per-destination)
 * @param {object} [opts]
 * @param {number} [opts.windowMs=600000]
 * @param {number} [opts.nowMs=now()] injected clock (tests; service uses default)
 * @returns {{ failures: number, locked: boolean, windowStartedAt: number }}
 */
function recordBridgeConnectMiss(communityId, { windowMs = BRIDGE_CONNECT_WINDOW_MS, nowMs = now() } = {}) {
  assertCommunityId(communityId);
  const tx = db.transaction(() => {
    const select = db
      .prepare(`SELECT window_started_at, failures FROM bridge_connect_attempts WHERE community_id = ?`);
    const row = select.get(communityId);
    if (!row || nowMs - Number(row.window_started_at) >= windowMs) {
      db
        .prepare(`
          INSERT INTO bridge_connect_attempts (community_id, window_started_at, failures)
          VALUES (?, ?, 1)
          ON CONFLICT (community_id) DO UPDATE SET window_started_at = excluded.window_started_at, failures = 1
        `)
        .run(communityId, nowMs);
    } else {
      db
        .prepare(`UPDATE bridge_connect_attempts SET failures = failures + 1 WHERE community_id = ?`)
        .run(communityId);
    }
    const after = select.get(communityId);
    return {
      failures: Number(after.failures),
      locked: Number(after.failures) >= BRIDGE_CONNECT_MISS_LIMIT,
      windowStartedAt: Number(after.window_started_at),
    };
  });
  return tx();
}

/**
 * Current counter state without recording an attempt (connect's gate).
 * A window that has fully elapsed reports as empty — the row is replaced by
 * the next miss (spec: 5 per 10 minutes).
 *
 * @param {number} communityId
 * @param {object} [opts]
 * @param {number} [opts.windowMs=600000]
 * @param {number} [opts.nowMs=now()]
 * @returns {{ failures: number, locked: boolean, windowStartedAt: number|null }}
 */
function getBridgeConnectState(communityId, { windowMs = BRIDGE_CONNECT_WINDOW_MS, nowMs = now() } = {}) {
  assertCommunityId(communityId);
  const row = db
    .prepare(`SELECT window_started_at, failures FROM bridge_connect_attempts WHERE community_id = ?`)
    .get(communityId);
  if (!row) return { failures: 0, locked: false, windowStartedAt: null };
  const active = nowMs - Number(row.window_started_at) < windowMs;
  const failures = active ? Number(row.failures) : 0;
  return {
    failures,
    locked: failures >= BRIDGE_CONNECT_MISS_LIMIT,
    windowStartedAt: Number(row.window_started_at),
  };
}

/**
 * Clear a community's counter (tests/tooling; connect clears after a success
 * when the service lands in PR 4).
 * @param {number} communityId
 * @returns {boolean} true when a row was deleted
 */
function clearBridgeConnectAttempts(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`DELETE FROM bridge_connect_attempts WHERE community_id = ?`).run(communityId).changes > 0;
}

// ---------------------------------------------------------------------------
// State transitions (repo-side) and destruction
// ---------------------------------------------------------------------------

/**
 * Mark a bridge broken (destination channel gone, spec §10.10). Only active
 * bridges become broken; a pending row past its date expires, it never
 * breaks. last_error rides along for status.
 *
 * @param {number} bridgeId
 * @param {string} reason human-readable cause for status
 * @returns {boolean} true when an active row transitioned
 */
function markBridgeBroken(bridgeId, reason) {
  requireBridgeId(bridgeId);
  const text = requireText(reason, "reason");
  const result = db
    .prepare(`UPDATE bridges SET state = 'broken', broken_reason = ? WHERE id = ? AND state = 'active'`)
    .run(text, bridgeId);
  return result.changes > 0;
}

/**
 * Record/clear the worker's last send failure for status (spec §10.10).
 * @param {number} bridgeId
 * @param {string|null} lastError null clears
 * @returns {boolean} true when the row exists
 */
function setBridgeLastError(bridgeId, lastError) {
  requireBridgeId(bridgeId);
  const result = db
    .prepare(`UPDATE bridges SET last_error = ? WHERE id = ?`)
    .run(lastError == null ? null : String(lastError), bridgeId);
  return result.changes > 0;
}

/**
 * Destroy a bridge and every row that hangs off it, in ONE transaction,
 * explicit CHILD-then-parent order (FK cascade is documentation only; the
 * §10.10 disconnect contract). Order: snapshots, links, outbox, ends, then
 * bridges. Used by disconnect, the expiry sweeper, and the guild-paste burn.
 *
 * Never touches spool files (media owns those, PR 5) or webhooks (PR 4+).
 *
 * @param {number} bridgeId
 * @returns {{ bridge_src_snapshots: number, bridge_message_links: number,
 *              bridge_outbox: number, bridge_ends: number, bridges: number }}
 *          per-table delete counts; bridges: 0 means the bridge did not exist.
 */
function deleteBridgeCascade(bridgeId) {
  requireBridgeId(bridgeId);
  const tx = db.transaction(() => {
    const counts = {};
    // Children first — 'bridges' last. The ends delete is the one that must
    // never be skipped: an orphan end pins UNIQUE (community_id, channel_id).
    for (const table of ["bridge_src_snapshots", "bridge_message_links", "bridge_outbox", "bridge_ends"]) {
      counts[table] = db.prepare(`DELETE FROM ${table} WHERE bridge_id = ?`).run(bridgeId).changes;
    }
    counts.bridges = db.prepare(`DELETE FROM bridges WHERE id = ?`).run(bridgeId).changes;
    return counts;
  });
  return tx();
}

/**
 * The sweeper's query (expire.js): pending rows whose code has expired.
 * Only 'pending' — active/broken are never swept (spec §10.10), and rows
 * with expires_at NULL can never expire.
 *
 * @param {number} [nowMs=now()] ms epoch (injectable clock)
 * @returns {object[]} bridges rows, earliest expiry first
 */
function findExpiredPendingBridges(nowMs = now()) {
  const ts = Number(nowMs);
  if (!Number.isSafeInteger(ts)) {
    throw new TypeError(`bridges: nowMs must be an integer ms epoch, got ${String(nowMs)}`);
  }
  return db
    .prepare(`${SELECT_BRIDGE} WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at < ? ORDER BY expires_at ASC`)
    .all(ts);
}

module.exports = {
  // constants
  BRIDGE_STATES,
  BRIDGE_DIRECTIONS,
  BRIDGE_RELAY_DIRECTIONS,
  BRIDGE_OUTBOX_STATES,
  BRIDGE_CODE_LIFETIME_MS,
  BRIDGE_CONNECT_MISS_LIMIT,
  BRIDGE_CONNECT_WINDOW_MS,
  BRIDGE_OUTBOX_MAX_ATTEMPTS,
  // pairing credential helpers (§10.1)
  generateConnectCode,
  generatePublicId,
  canonicalizeConnectCode,
  normalizeHandle,
  isBridgeHandle,
  classifyConnectInput,
  hashConnectCode,
  digestsEqual,
  formatDisplayCode,
  // bridges / ends
  getBridgeById,
  getBridgeByPublicId,
  getBridgeByCodeHash,
  createBridge,
  listBridgeEnds,
  getBridgeEndForChannel,
  getBridgeForChannel,
  listBridgesForCommunity,
  addBridgeEnd,
  setBridgeEndWebhook,
  setBridgeEndFlags,
  // outbox
  getBridgeOutboxById,
  enqueueBridgeOutbox,
  claimNextOutboxRow,
  markOutboxDone,
  recordOutboxFailure,
  requeueStaleOutbox,
  countOutboxDepth,
  // links / snapshots
  addBridgeMessageLink,
  listBridgeMessageLinks,
  getBridgeLinkByDestination,
  upsertBridgeSrcSnapshot,
  getBridgeSrcSnapshot,
  // connect attempts
  recordBridgeConnectMiss,
  getBridgeConnectState,
  clearBridgeConnectAttempts,
  // lifecycle
  markBridgeBroken,
  setBridgeLastError,
  findExpiredPendingBridges,
  deleteBridgeCascade,
};
