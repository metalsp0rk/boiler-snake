/**
 * Bridge pairing credential surface (roadmap/bridge.md §10.1, §10.13).
 *
 * The format logic (Crockford base32, canonicalization, SHA-256 + timingSafeEqual,
 * handle recognition) is single-sourced in src/db/repositories/bridges.js —
 * the repository is its only implementation site, so code minted at create and
 * code hashed at connect can never drift apart. This module is the feature-
 * facing entry point the §10.13 layout names (service.js imports codes, not
 * the repository, for credential work).
 *
 * This file imports neither discord.js nor the Fluxer SDK, and it performs no
 * I/O: the credential exists in plaintext only in create's delivery (ephemeral
 * reply / DM) and in the connector's input; every other consumer sees digests.
 */

module.exports = {
  generateConnectCode: require("../../db/repositories/bridges").generateConnectCode,
  generatePublicId: require("../../db/repositories/bridges").generatePublicId,
  canonicalizeConnectCode: require("../../db/repositories/bridges").canonicalizeConnectCode,
  normalizeHandle: require("../../db/repositories/bridges").normalizeHandle,
  isBridgeHandle: require("../../db/repositories/bridges").isBridgeHandle,
  classifyConnectInput: require("../../db/repositories/bridges").classifyConnectInput,
  hashConnectCode: require("../../db/repositories/bridges").hashConnectCode,
  digestsEqual: require("../../db/repositories/bridges").digestsEqual,
  formatDisplayCode: require("../../db/repositories/bridges").formatDisplayCode,
};
