/**
 * One-time re-encryption of third-party credential columns (audit-2026-10 C6,
 * issue #189).
 *
 * `guild_command_permission_oauth.refresh_token` / `.access_token` (Discord
 * user OAuth grants, migration 016) and `github_watches.token` (GitHub PATs,
 * migration 025) were raw TEXT while strictly weaker material (bridge relay
 * webhook tokens, web session ATs) was already AES-256-GCM-encrypted. From
 * here on those columns hold ONLY an AES-256-GCM envelope produced by
 * src/core/tokenCrypto.js (`v1.…` legacy, `v2.<keyid>.…` since #281 — both
 * stay valid; new writes are always v2) keyed by TOKEN_ENCRYPTION_KEY; this
 * migration converts the pre-existing plaintext rows.
 *
 * Decisions (documented in the #189 PR):
 *  - FAIL LOUD, no decrypt-fallback. The bot must never boot with
 *    mixed-state columns (some plaintext, some envelope):
 *      * TOKEN_ENCRYPTION_KEY missing/invalid WHILE token material exists
 *        (plaintext rows to encrypt, or envelope-looking rows to validate)
 *        → throw naming the env var, the affected tables, and an example row
 *        id. The migration runner re-throws → boot dies with the cause.
 *      * A value carrying the `v1.` prefix that does NOT decrypt with the
 *        current key (foreign/rotated key, tampered bytes) → throw naming
 *        table, row id, and column. Re-wrapping it would destroy the only
 *        copy of the credential; silently skipping would hide the split.
 *  - KEY NOT NEEDED when nothing exists to migrate (empty tables or every
 *    token column NULL/empty) — a deployment that never used /github tokens
 *    or command-permission OAuth boots without the env var.
 *  - Idempotent by envelope detection: a row whose value decrypts with the
 *    current key is ALREADY migrated and is left byte-identical, so re-runs
 *    on every boot are no-ops (runtime rows written after this migration are
 *    envelopes too — migrations run on db load BEFORE feature boot, so no
 *    app write can interleave with this pass).
 *  - NULL stays NULL and '' stays '' (no credential, nothing to encrypt;
 *    the repositories store falsy tokens as NULL anyway).
 *  - Writes run in ONE transaction: any failure leaves every row exactly as
 *    it was found.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ tableExists: (name: string) => boolean }} helpers
 */

const core = require("../../core/tokenCrypto");
const {
  KEY_ENV,
  KEY_RETIRED_ENV,
  ENVELOPE_PREFIX,
  ENVELOPE_V2_PREFIX,
  encryptToken,
  decryptToken,
} = require("../../core/thirdPartyTokens");

/** @type {{ table: string, idColumns: string[], tokenColumns: string[] }[]} */
const TARGETS = [
  {
    table: "guild_command_permission_oauth",
    idColumns: ["community_id"],
    tokenColumns: ["refresh_token", "access_token"],
  },
  {
    table: "github_watches",
    idColumns: ["community_id", "repo"],
    tokenColumns: ["token"],
  },
];

/** "github_watches(community_id=7, repo=acme/widgets)" — ids only, never values. */
function rowLabel(table, row, idColumns) {
  return `${table}(${idColumns.map((c) => `${c}=${row[c]}`).join(", ")})`;
}

/** Max row labels quoted in one failure message (logs stay actionable, not megabytes). */
const MAX_REPORTED_ROWS = 5;

function up(db, { tableExists }) {
  const key = core.decodeKey(() => process.env[KEY_ENV]);

  /** Rows needing encryption: { table, idColumns, row, column }. */
  const plaintext = [];
  /** Envelope-shaped values that do NOT decrypt with the current key. */
  const undecryptable = [];
  /** Row labels needing the key when it is absent. */
  const needsKey = [];

  for (const target of TARGETS) {
    if (!tableExists(target.table)) continue;
    const cols = [...target.idColumns, ...target.tokenColumns].join(", ");
    for (const row of db.prepare(`SELECT ${cols} FROM ${target.table}`).all()) {
      for (const column of target.tokenColumns) {
        const value = row[column];
        if (value == null || value === "") continue; // no credential stored
        const label = `${rowLabel(target.table, row, target.idColumns)} column ${column}`;
        if (!key) {
          needsKey.push(label);
          continue;
        }
        if (
          typeof value === "string" &&
          (value.startsWith(ENVELOPE_PREFIX) || value.startsWith(ENVELOPE_V2_PREFIX))
        ) {
          // Carries an envelope marker (v1 or v2): only a SUCCESSFUL
          // decrypt against the key SET (current + any TOKEN_ENCRYPTION_
          // KEY_RETIRED entries, #281) proves "already migrated" — a shape
          // check alone cannot tell our envelopes from foreign-key,
          // corrupted, or v2-junk ones, and re-wrapping any of those would
          // destroy the credential (or entrench garbage). This keeps the
          // scan idempotent.
          try {
            decryptToken(value);
          } catch (err) {
            undecryptable.push(`${label}: ${err.message}`);
          }
          continue;
        }
        plaintext.push({ ...target, row, column });
      }
    }
  }

  if (!key && needsKey.length > 0) {
    throw new Error(
      `${KEY_ENV} (32 bytes of base64, e.g. "openssl rand -base64 32") is required to ` +
        `finish migration 039: ${needsKey.length} row(s) of ${TARGETS.map((t) => t.table).join(" / ")} ` +
        `still carry third-party tokens (Discord command-permission OAuth grants, GitHub PATs) ` +
        `that must be encrypted at rest. Tokens are never stored in plaintext. Example: ${
          needsKey.slice(0, MAX_REPORTED_ROWS).join(", ")
        }${needsKey.length > MAX_REPORTED_ROWS ? `, …` : ""}. Set ${KEY_ENV} in .env and start again.`
    );
  }

  if (undecryptable.length > 0) {
    throw new Error(
      `Migration 039 refused: ${undecryptable.length} stored value(s) look like token ` +
        `envelopes (v1/v2) but do NOT decrypt with the current ${KEY_ENV} or any ` +
        `${KEY_RETIRED_ENV} entry — likely a rotated/foreign ` +
        `${KEY_ENV} or tampered bytes. Restore the key that encrypted them (as ${KEY_ENV} or as a ` +
        `${KEY_RETIRED_ENV} entry, see docs/configuration.md); re-wrapping would destroy the ` +
        `credentials. Offenders: ` +
        `${undecryptable.slice(0, MAX_REPORTED_ROWS).join("; ")}` +
        `${undecryptable.length > MAX_REPORTED_ROWS ? ` (and ${undecryptable.length - MAX_REPORTED_ROWS} more)` : ""}`
    );
  }

  if (plaintext.length === 0) return;

  const updateStmts = new Map();
  const write = db.transaction(() => {
    let done = 0;
    for (const entry of plaintext) {
      const envelope = encryptToken(entry.row[entry.column]);
      if (envelope == null) {
        // Unreachable in practice (key decoded above; encryptToken re-reads
        // the same env synchronously) — but never write NULL over a token.
        throw new Error(
          `Migration 039: failed to encrypt ${rowLabel(entry.table, entry.row, entry.idColumns)} ` +
            `column ${entry.column} with the current ${KEY_ENV}`
        );
      }
      const keyStmt = `${entry.table}|${entry.column}`;
      let stmt = updateStmts.get(keyStmt);
      if (!stmt) {
        const where = entry.idColumns.map((c) => `${c}=?`).join(" AND ");
        stmt = db.prepare(`UPDATE ${entry.table} SET ${entry.column}=? WHERE ${where}`);
        updateStmts.set(keyStmt, stmt);
      }
      stmt.run(envelope, ...entry.idColumns.map((c) => entry.row[c]));
      done += 1;
    }
    return done;
  });
  const count = write();
  console.log(
    `[db] Migration 039_encrypt_third_party_tokens: re-encrypted ${count} third-party ` +
      `token value(s) at rest (AES-256-GCM envelope, ${KEY_ENV})`
  );
}

module.exports = { id: "039_encrypt_third_party_tokens", up };
