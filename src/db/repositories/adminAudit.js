/**
 * Admin audit trail — guild-scoped record of every mutating action across
 * transports (web admin, slash handlers, system jobs). Written alongside the
 * service-layer mutation, never instead of it (roadmap/web-admin.md §8.5/§8.6).
 *
 * List helpers enforce the §8.6 query budget: guild-scoped, LIMIT ≤ 100,
 * offset-paged, newest first, served by idx_admin_audit_guild_created.
 */

const { db, now } = require("../connection");

/** Allowed audit origins (mirrors the admin_audit CHECK constraint). */
const AUDIT_ORIGINS = Object.freeze(["web", "slash", "system"]);

/** §8.6 query budget: hard cap on audit list page size. */
const MAX_AUDIT_LIST_LIMIT = 100;

/** Row-size guard for serialized details_json (chars). */
const MAX_AUDIT_DETAILS_JSON = 4000;

/** Field-length guards (action/target columns stay log- and index-friendly). */
const MAX_AUDIT_ACTION = 100;
const MAX_AUDIT_TARGET = 100;

function auditError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Normalize + validate an audit origin.
 * @param {string|null|undefined} origin
 * @returns {{ ok: true, origin: string } | { ok: false, error: string }}
 */
function normalizeAuditOrigin(origin) {
  const value = origin == null ? "" : String(origin).trim().toLowerCase();
  if (AUDIT_ORIGINS.includes(value)) return { ok: true, origin: value };
  return {
    ok: false,
    error: `Audit origin must be one of: ${AUDIT_ORIGINS.join(", ")}.`,
  };
}

/**
 * Coerce to trimmed string or null (empty → null).
 * @param {unknown} value
 * @param {number} maxLen
 * @param {string} label
 * @returns {string|null}
 */
function boundedField(value, maxLen, label) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return null;
  if (text.length > maxLen) {
    throw auditError("FIELD_TOO_LONG", `${label} is too long (max ${maxLen} characters).`);
  }
  return text;
}

/**
 * Serialize audit details to JSON text with validation.
 * Accepts an object/array (stringified) or an already-serialized JSON string
 * (validated as parseable). null/undefined → SQL NULL.
 * @param {unknown} details
 * @returns {{ ok: true, json: string|null } | { ok: false, error: string }}
 */
function serializeAuditDetails(details) {
  if (details == null) return { ok: true, json: null };

  let json;
  if (typeof details === "string") {
    try {
      JSON.parse(details); // reject non-JSON strings rather than double-encoding
    } catch {
      return { ok: false, error: "Audit details string must be valid JSON." };
    }
    json = details;
  } else {
    try {
      json = JSON.stringify(details);
    } catch {
      return { ok: false, error: "Audit details must be JSON-serializable (no circular references)." };
    }
  }

  if (json.length > MAX_AUDIT_DETAILS_JSON) {
    return {
      ok: false,
      error: `Audit details serialize to more than ${MAX_AUDIT_DETAILS_JSON} characters.`,
    };
  }
  return { ok: true, json };
}

/**
 * Insert one audit row. Throws Error with `code` on invalid input:
 * INVALID_GUILD | INVALID_ORIGIN | INVALID_ACTION | INVALID_DETAILS.
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string|null} [opts.actorUserId]  Discord user id; null for 'system'
 * @param {"web"|"slash"|"system"} opts.origin
 * @param {string} opts.action              e.g. "settings.command_channel.add"
 * @param {string} [opts.targetType]        e.g. "user" | "channel" | "role" | "guild"
 * @param {string} [opts.targetId]
 * @param {object|string|null} [opts.details]  object → JSON.stringify; string must already be JSON
 * @param {number} [opts.createdAt]         epoch ms; defaults to now() (backdating for tests/mirrors)
 * @returns {object} stored row shape (id + all columns) assembled from the
 *   insert — NOT re-read from the DB (details_json as stored JSON text)
 */
function insertAdminAudit(opts) {
  const guildId = opts?.guildId == null ? "" : String(opts.guildId).trim();
  if (!guildId) throw auditError("INVALID_GUILD", "Audit rows require a guild_id.");

  const normalized = normalizeAuditOrigin(opts?.origin);
  if (!normalized.ok) throw auditError("INVALID_ORIGIN", normalized.error);

  const action = opts?.action == null ? "" : String(opts.action).trim();
  if (!action) throw auditError("INVALID_ACTION", "Audit rows require an action.");
  if (action.length > MAX_AUDIT_ACTION) {
    throw auditError("INVALID_ACTION", `Action is too long (max ${MAX_AUDIT_ACTION} characters).`);
  }

  const details = serializeAuditDetails(opts?.details);
  if (!details.ok) throw auditError("INVALID_DETAILS", details.error);

  const actorUserId = boundedField(opts?.actorUserId, MAX_AUDIT_TARGET, "Actor user id");
  const targetType = boundedField(opts?.targetType, MAX_AUDIT_TARGET, "Target type");
  const targetId = boundedField(opts?.targetId, MAX_AUDIT_TARGET, "Target id");

  const createdAt = Number(opts?.createdAt) || now();
  const info = db
    .prepare(
      `
      INSERT INTO admin_audit (
        guild_id, actor_user_id, origin, action,
        target_type, target_id, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      guildId,
      actorUserId,
      normalized.origin,
      action,
      targetType,
      targetId,
      details.json,
      createdAt
    );

  // Return the stored shape ASSEMBLED from the values we just wrote — no
  // read-back SELECT. Every insert site (87 slash + 35 web) calls this as a
  // statement; only the migration test reads the result, and the columns
  // below are the full table (id + the 8 INSERT columns), so the contract
  // "returns the inserted row" holds without a per-mutation PK round-trip.
  return {
    id: Number(info.lastInsertRowid),
    guild_id: guildId,
    actor_user_id: actorUserId,
    origin: normalized.origin,
    action,
    target_type: targetType,
    target_id: targetId,
    details_json: details.json,
    created_at: createdAt,
  };
}

/**
 * @param {number} id
 * @returns {object|null}
 */
function getAdminAuditById(id) {
  if (id == null) return null;
  return (
    db.prepare(`SELECT * FROM admin_audit WHERE id=?`).get(Number(id)) || null
  );
}

/**
 * Guild-scoped audit page, newest first, LIMIT hard-capped (§8.6).
 * @param {string} guildId
 * @param {object} [opts]
 * @param {number} [opts.limit=25]   clamped to 1..100
 * @param {number} [opts.offset=0]   clamped to >= 0
 * @param {string} [opts.origin]     optional filter: web | slash | system
 * @param {number} [opts.before]     epoch ms; only rows with created_at < before (cursor)
 * @returns {object[]} rows, details_json as stored JSON text
 */
function listAdminAudit(guildId, opts = {}) {
  const guild = guildId == null ? "" : String(guildId).trim();
  if (!guild) return [];

  const limit = Math.min(
    Math.max(Number(opts.limit) || 25, 1),
    MAX_AUDIT_LIST_LIMIT
  );
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const where = ["guild_id=?"];
  const params = [guild];

  if (opts.origin != null && opts.origin !== "") {
    const normalized = normalizeAuditOrigin(opts.origin);
    if (!normalized.ok) {
      throw auditError("INVALID_ORIGIN", normalized.error);
    }
    where.push("origin=?");
    params.push(normalized.origin);
  }

  if (opts.before != null && Number.isFinite(Number(opts.before))) {
    where.push("created_at < ?");
    params.push(Number(opts.before));
  }

  // id tiebreaker keeps paging stable for rows sharing a created_at ms.
  return db
    .prepare(
      `
      SELECT * FROM admin_audit
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `
    )
    .all(...params, limit, offset);
}

/**
 * Total rows for a guild (for viewer paging). Optional origin filter.
 * @param {string} guildId
 * @param {object} [opts]
 * @param {string} [opts.origin]
 * @returns {number}
 */
function countAdminAudit(guildId, opts = {}) {
  const guild = guildId == null ? "" : String(guildId).trim();
  if (!guild) return 0;

  if (opts.origin != null && opts.origin !== "") {
    const normalized = normalizeAuditOrigin(opts.origin);
    if (!normalized.ok) {
      throw auditError("INVALID_ORIGIN", normalized.error);
    }
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM admin_audit WHERE guild_id=? AND origin=?`
        )
        .get(guild, normalized.origin)?.c || 0
    );
  }

  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM admin_audit WHERE guild_id=?`)
      .get(guild)?.c || 0
  );
}

module.exports = {
  AUDIT_ORIGINS,
  MAX_AUDIT_LIST_LIMIT,
  MAX_AUDIT_DETAILS_JSON,
  normalizeAuditOrigin,
  serializeAuditDetails,
  insertAdminAudit,
  getAdminAuditById,
  listAdminAudit,
  countAdminAudit,
};
