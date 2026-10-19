"use strict";

/**
 * Shared pairing-code engine (#472 LT-15).
 *
 * The two cross-platform credential surfaces — bridge ("BRG-…") and account
 * linking ("LNK-…") — each carried a complete fork of this format engine:
 * the Crockford base32 table + encoder, display grouping, prefix-stripping
 * canonicalization, SHA-256 hashing, constant-time digest comparison and
 * pre-hash input classification. linking/codes.js said the quiet part out
 * loud ("same table as bridges.js", "same algorithm as encodeCrockford"):
 * a format fix had to land twice and the tests pinned each COPY — exactly
 * the drift ssrfGuard.js was extracted the same quarter to prevent
 * ("share it, don't fork").
 *
 * createPairingCodes({ prefix }) mints the per-caller engine. Surface
 * decoration stays with the caller: bridge keeps its handle branches (b_…
 * ids are NOT credentials) and handle minting on top of the shared encoder;
 * linking is a thin naming adapter. What leaves this file is identical for
 * both: 128 random bits → Crockford base32 → canonical 22-char form; the
 * display form carries the prefix, the storage form never does; only the
 * SHA-256 digest of the canonical form is ever persisted — the plaintext
 * lives in the minting reply and the redeemer's message and nowhere else.
 *
 * No I/O, no platform imports — safe to require from repositories, features
 * and services alike.
 */

const crypto = require("crypto");

/** Crockford base32 alphabet (excludes I, L, O, U). */
const CROCKFORD_UPPER = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CROCKFORD_LOWER = CROCKFORD_UPPER.toLowerCase();

/** Canonical (uppercase, stripped) pairing-code length: 22 chars, 128-bit seed. */
const CODE_SEED_BYTES = 16;
const CODE_CANONICAL_LEN = 22;

/** Canonical codes contain only Crockford characters (uppercase form). */
const CROCKFORD_UPPER_RE = /^[0-9A-HJ-KM-NP-TV-Z]+$/;

/** Collision-retry budget for minting (2^128 space; this is paranoia). */
const MAX_MINT_ATTEMPTS = 16;

/**
 * Base32-encode bytes with a Crockford-style alphabet, MSB first, trailing
 * bits zero-padded (bridge spec §10.1: "128 bits from crypto.randomBytes,
 * Crockford base32"). Returns exactly `charCount` characters.
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
 * Group a canonical code for display: XXXX-XXXX-XXXX-XXXX-XXXX-XX (the
 * caller prefixes "BRG-"/"LNK-"). Canonical strings whose length is not 22
 * pass through untouched — display formatting never validates,
 * classification does.
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
 * Constant-time compare of two stored digests. Accepts Buffers, Uint8Arrays,
 * and the lowercase hex TEXT repositories may store (linking's code_hash is
 * TEXT; bridge stores BLOB Buffers). Length/type mismatches are false, never
 * a throw (timingSafeEqual throws on length mismatch) — a mismatch is a
 * data-integrity signal, not user input.
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

/**
 * Build the pairing-code surface for one credential family.
 *
 * @param {object} opts
 * @param {string} opts.prefix display prefix, e.g. "BRG" or "LNK"
 *   (letters only; canonicalization strips a leading match, so prefix
 *   letters must never survive into a minted body — mint guards this)
 * @returns {{
 *   CODE_PREFIX: string,
 *   canonicalize: (raw: string) => string,
 *   hash: (raw: string) => Buffer,
 *   classify: (raw: string) => { kind: 'empty' } | { kind: 'garbage', canonical: string } | { kind: 'code', canonical: string },
 *   mint: (opts?: { isTaken?: (digest: Buffer) => boolean }) => { displayCode: string, canonical: string, digest: Buffer },
 * }}
 */
function createPairingCodes({ prefix } = {}) {
  if (typeof prefix !== "string" || prefix.trim() === "") {
    throw new TypeError("createPairingCodes: prefix must be a non-empty string");
  }
  const p = prefix.trim().toUpperCase();

  /**
   * Canonical storage/comparison form: uppercase, hyphens and spaces
   * stripped, a leading display prefix stripped (so "LNK-ABCD-…" and
   * "abcd…" are the same code).
   *
   * @param {string} raw
   * @returns {string} canonical form ('' for non-strings / empty input)
   */
  function canonicalize(raw) {
    if (typeof raw !== "string") return "";
    let s = raw.trim().toUpperCase().replace(/[-\s]/g, "");
    if (s.startsWith(p)) s = s.slice(p.length);
    return s;
  }

  /**
   * SHA-256 of the canonical code — the only representation that is ever
   * stored.
   *
   * @param {string} raw
   * @returns {Buffer} 32-byte digest
   */
  function hash(raw) {
    return crypto
      .createHash("sha256")
      .update(canonicalize(raw), "utf8")
      .digest();
  }

  /**
   * Classify raw redemption input BEFORE any hashing: alphabet garbage gets
   * its own sentence (and never counts toward a failure counter), and a
   * code-shaped string is a well-formed candidate whose lookup miss is the
   * ordinary "expired or unknown" reply. Length is deliberately not
   * classified — no row can match a wrong-length digest, so it is a plain
   * miss too.
   *
   * @param {string} raw
   * @returns {{ kind: 'empty' } | { kind: 'garbage', canonical: string } |
   *            { kind: 'code', canonical: string }}
   */
  function classify(raw) {
    if (typeof raw !== "string" || raw.trim() === "") return { kind: "empty" };
    const canonical = canonicalize(raw);
    if (canonical === "") return { kind: "empty" };
    if (!CROCKFORD_UPPER_RE.test(canonical)) return { kind: "garbage", canonical };
    return { kind: "code", canonical };
  }

  /**
   * Mint a one-time credential: 128 random bits → Crockford base32 → the
   * canonical 22-char form, its display form, and the at-rest SHA-256
   * digest.
   *
   * A minted body that happens to start with the display prefix is
   * discarded and re-minted: canonicalize strips a leading prefix, so such
   * a code could never be typed back in (costs one in ~32,768 mints).
   *
   * Two mints of the same digest are impossible in practice (128 bits), but
   * the UNIQUE digest index makes it observable, so callers pass an
   * `isTaken` probe and get a fresh mint.
   *
   * @param {object} [opts]
   * @param {(digest: Buffer) => boolean} [opts.isTaken] collision probe
   * @returns {{ displayCode: string, canonical: string, digest: Buffer }}
   */
  function mint({ isTaken } = {}) {
    for (let attempt = 1; attempt <= MAX_MINT_ATTEMPTS; attempt += 1) {
      const canonical = encodeCrockford(
        crypto.randomBytes(CODE_SEED_BYTES),
        CODE_CANONICAL_LEN,
        CROCKFORD_UPPER,
      );
      if (canonical.startsWith(p)) continue; // prefix-strip ambiguity
      const digest = hash(canonical);
      if (typeof isTaken === "function" && isTaken(digest)) continue;
      return {
        // The user-facing display form carries the prefix; the canonical
        // storage form never does (canonicalize strips it).
        displayCode: `${p}-${formatDisplayCode(canonical)}`,
        canonical,
        digest,
      };
    }
    throw new Error(
      `pairingCodes(${p}): ${MAX_MINT_ATTEMPTS} consecutive code collisions — refusing to mint (code table corrupt?)`,
    );
  }

  return { CODE_PREFIX: p, canonicalize, hash, classify, mint };
}

module.exports = {
  // constants (tests and docs pin the format)
  CROCKFORD_UPPER,
  CROCKFORD_LOWER,
  CROCKFORD_UPPER_RE,
  CODE_SEED_BYTES,
  CODE_CANONICAL_LEN,
  MAX_MINT_ATTEMPTS,
  // shared primitives
  encodeCrockford,
  formatDisplayCode,
  digestsEqual,
  // per-caller engine factory
  createPairingCodes,
};
