/**
 * Account-linking pairing-credential surface (roadmap/account-linking.md T2).
 *
 * #472 (LT-15): this used to be a full fork of the bridge credential engine
 * ("same table as bridges.js", "same algorithm as encodeCrockford" said the
 * file itself — two format engines drifting behind pinned-copy tests). The
 * engine now lives in src/core/pairingCodes.js; this file is the LNK naming
 * adapter the T2 layout names, so every consumer keeps importing
 * canonicalizeLinkCode/hashLinkCode/… from here.
 *
 * Conventions the engine guarantees (bridge §10.1 inherited):
 *  - 128 random bits (crypto.randomBytes(16)) → Crockford base32 (excludes
 *    I, L, O, U) → a canonical 22-character uppercase string.
 *  - The user-facing display form carries an "LNK-" prefix; the canonical
 *    storage/comparison form never does (canonicalize strips it).
 *  - Storage is SHA-256 of the canonical form only. The plaintext exists in
 *    the minting reply (a DM on Fluxer since #194) and in the redeemer's
 *    message and nowhere else — it is never logged, never audited, never stored.
 *  - Input is classified BEFORE hashing: alphabet garbage gets its own
 *    sentence, and a code-shaped string that matches no row is a plain miss.
 *
 * Linking has no handle surface (bridges have `b_…` handles to post around;
 * a link is private between two users), so nothing here mirrors
 * normalizeHandle / isBridgeHandle.
 *
 * This file imports neither discord.js nor the Fluxer SDK and performs no I/O.
 */

const core = require("../../core/pairingCodes");

/** Display prefix, mirroring the bridge "BRG" prefix (spec: three letters). */
const CODE_PREFIX = "LNK";

const linkCodes = core.createPairingCodes({ prefix: CODE_PREFIX });

module.exports = {
  // constants (tests and docs pin the format)
  CROCKFORD_UPPER: core.CROCKFORD_UPPER,
  CODE_SEED_BYTES: core.CODE_SEED_BYTES,
  CODE_CANONICAL_LEN: core.CODE_CANONICAL_LEN,
  CODE_PREFIX,
  MAX_CODE_ATTEMPTS: core.MAX_MINT_ATTEMPTS,
  // format surface (delegated — one engine, two prefixes)
  encodeCrockford: core.encodeCrockford,
  formatDisplayCode: core.formatDisplayCode,
  canonicalizeLinkCode: linkCodes.canonicalize,
  hashLinkCode: linkCodes.hash,
  classifyLinkInput: linkCodes.classify,
  generateLinkCode: (opts) => linkCodes.mint(opts),
  digestsEqual: core.digestsEqual,
};
