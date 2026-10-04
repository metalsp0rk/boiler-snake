/**
 * Account-linking pairing-credential surface (roadmap/account-linking.md T2).
 *
 * Mirrors src/features/bridge/codes.js one-for-one in spirit: the code format
 * is defined in exactly one place, so the code minted at `link create` and the
 * code hashed at `link connect` can never drift apart. Bridge sources its
 * format from the bridges repository (bridges.js owns the code column); the
 * user_links repository deliberately stores only an opaque digest, so the
 * format lives HERE and the repository keeps its platform-agnostic contract.
 *
 * Conventions inherited from bridges.js §10.1:
 *  - 128 random bits (crypto.randomBytes(16)) → Crockford base32 (excludes
 *    I, L, O, U) → a canonical 22-character uppercase string.
 *  - The user-facing display form carries an "LNK-" prefix; the canonical
 *    storage/comparison form never does (canonicalizeLinkCode strips it).
 *  - Storage is SHA-256 of the canonical form only. The plaintext exists in
 *    the minting reply and in the redeemer's message and nowhere else — it is
 *    never logged, never audited, never stored.
 *  - Input is classified BEFORE hashing: alphabet garbage gets its own
 *    sentence, and a code-shaped string that matches no row is a plain miss.
 *
 * Linking has no handle surface (bridges have `b_…` handles to post around;
 * a link is private between two users), so nothing here mirrors
 * normalizeHandle / isBridgeHandle.
 *
 * This file imports neither discord.js nor the Fluxer SDK and performs no I/O.
 */

const crypto = require("crypto");

/** Crockford base32 alphabet (excludes I, L, O, U) — same table as bridges.js. */
const CROCKFORD_UPPER = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Canonical (uppercase, stripped) link-code length: 22 chars, 128 bits of seed. */
const CODE_SEED_BYTES = 16;
const CODE_CANONICAL_LEN = 22;

/** Display prefix, mirroring the bridge "BRG-" prefix (spec: two letters + G). */
const CODE_PREFIX = "LNK";

/** Canonical codes contain only Crockford characters (uppercase form). */
const CROCKFORD_UPPER_RE = /^[0-9A-HJ-KM-NP-TV-Z]+$/;

/** Collision-retry budget for generateLinkCode (2^128 space; this is paranoia). */
const MAX_CODE_ATTEMPTS = 16;

/**
 * Base32-encode bytes with a Crockford-style alphabet, MSB first, trailing
 * bits zero-padded (same algorithm as bridges.js encodeCrockford). Returns
 * exactly `charCount` characters.
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
 * Group a canonical code for display: LNK-XXXX-XXXX-XXXX-XXXX-XXXX-XX.
 * Canonical strings whose length is not 22 pass through untouched — display
 * formatting never validates, classification does.
 *
 * @param {string} canonical
 * @returns {string}
 */
function formatDisplayCode(canonical) {
  return String(canonical).replace(
    /^(.{4})(.{4})(.{4})(.{4})(.{4})(.*)$/,
    "$1-$2-$3-$4-$5-$6",
  );
}

/**
 * Canonical storage/comparison form: uppercase, hyphens and spaces stripped,
 * a leading LNK prefix stripped (so "LNK-ABCD-…" and "abcd…" are the same code).
 *
 * @param {string} raw
 * @returns {string} canonical form ('' for non-strings / empty input)
 */
function canonicalizeLinkCode(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().toUpperCase().replace(/[-\s]/g, "");
  if (s.startsWith(CODE_PREFIX)) s = s.slice(CODE_PREFIX.length);
  return s;
}

/**
 * SHA-256 of the canonical code — the value stored in user_link_codes.code_hash
 * (as lowercase hex TEXT by the repository, migration 036).
 *
 * @param {string} raw
 * @returns {Buffer} 32-byte digest
 */
function hashLinkCode(raw) {
  return crypto.createHash("sha256").update(canonicalizeLinkCode(raw), "utf8").digest();
}

/**
 * Classify raw connect input BEFORE any hashing (mirrors bridges
 * classifyConnectInput): alphabet garbage gets its own sentence, and a
 * code-shaped string is a well-formed candidate whose lookup miss is the
 * ordinary "expired or unknown" reply. Length is deliberately not classified
 * here — no row can match a wrong-length digest, so it is a plain miss too.
 *
 * @param {string} raw
 * @returns {{ kind: 'empty' } | { kind: 'garbage', canonical: string } |
 *            { kind: 'code', canonical: string }}
 */
function classifyLinkInput(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "empty" };
  const canonical = canonicalizeLinkCode(raw);
  if (canonical === "") return { kind: "empty" };
  if (!CROCKFORD_UPPER_RE.test(canonical)) return { kind: "garbage", canonical };
  return { kind: "code", canonical };
}

/**
 * Mint a one-time link credential: 128 random bits → Crockford base32 → the
 * canonical 22-char form, its display form, and the at-rest SHA-256 digest.
 *
 * Two mints of the same digest are impossible in practice (128 bits), but the
 * UNIQUE index on code_hash makes it observable, so callers pass an `isTaken`
 * probe and get a fresh mint (the repository's createLinkCode answers
 * {ok:false} on a duplicate digest — same posture as bridge code minting).
 *
 * A minted body that happens to start with "LNK" is discarded and re-minted:
 * canonicalizeLinkCode strips a leading LNK, so such a code could never be
 * typed back in. The rejection costs one in ~32,768 mints.
 *
 * @param {object} [opts]
 * @param {(digest: Buffer) => boolean} [opts.isTaken] collision probe (e.g.
 *   `(digest) => Boolean(getLinkCodeByHash(digest))`)
 * @returns {{ displayCode: string, canonical: string, digest: Buffer }}
 */
function generateLinkCode({ isTaken } = {}) {
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
    const canonical = encodeCrockford(
      crypto.randomBytes(CODE_SEED_BYTES),
      CODE_CANONICAL_LEN,
      CROCKFORD_UPPER,
    );
    if (canonical.startsWith(CODE_PREFIX)) continue; // prefix-strip ambiguity
    const digest = hashLinkCode(canonical);
    if (typeof isTaken === "function" && isTaken(digest)) continue;
    return {
      displayCode: `${CODE_PREFIX}-${formatDisplayCode(canonical)}`,
      canonical,
      digest,
    };
  }
  throw new Error(
    `generateLinkCode: ${MAX_CODE_ATTEMPTS} consecutive code collisions — refusing to mint (link code table corrupt?)`,
  );
}

/**
 * Constant-time compare of two stored digests. Accepts Buffers, Uint8Arrays,
 * and the lowercase hex TEXT the repository stores in code_hash. Length/type
 * mismatches are false, never a throw (timingSafeEqual throws on length
 * mismatch) — a mismatch is a data-integrity signal, not user input.
 *
 * @param {Buffer|Uint8Array|string|null|undefined} a
 * @param {Buffer|Uint8Array|string|null|undefined} b
 * @returns {boolean}
 */
function digestsEqual(a, b) {
  const toBuf = (v) => {
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v.trim())) {
      return Buffer.from(v.trim(), "hex");
    }
    return null;
  };
  const ba = toBuf(a);
  const bb = toBuf(b);
  if (!ba || !bb) return false;
  if (ba.length !== 32 || bb.length !== 32) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  // constants (tests and docs pin the format)
  CROCKFORD_UPPER,
  CODE_SEED_BYTES,
  CODE_CANONICAL_LEN,
  CODE_PREFIX,
  MAX_CODE_ATTEMPTS,
  // format surface
  encodeCrockford,
  formatDisplayCode,
  canonicalizeLinkCode,
  hashLinkCode,
  classifyLinkInput,
  generateLinkCode,
  digestsEqual,
};
