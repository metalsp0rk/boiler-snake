/**
 * Admin audit repository — the durable record of every mutating action
 * (roadmap/web-admin.md §8.5/§8.6). Keyed by the internal communities.id
 * (roadmap/fluxer.md § Repository boundary): every function asserts the
 * numeric community id, so a Discord snowflake can never key a trail row.
 *
 * §8.6 query budget: lists are guild(scoped)-bounded, newest first,
 * LIMIT ≤ MAX_AUDIT_LIST_LIMIT, offset paging.
 */

const { db, now } = require("../connection");

// Lazy require: src/platform/community.js requires the db facade, so a
// top-level require would be a load-time cycle. See src/db/repositories/users.js.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** Valid audit origins. */
const AUDIT_ORIGINS = Object.freeze(["web", "slash", "system"]);

/** §8.6: max list page size. */
const MAX_AUDIT_LIST_LIMIT = 100;

/** §8.6: serialized details_json hard cap (characters). */
const MAX_AUDIT_DETAILS_JSON = 4000;

/** Field length guards (action/target stay index- and log-friendly). */
const MAX_AUDIT_ACTION = 100;
const MAX_AUDIT_TARGET = 100;

/** Error factory — stable codes for callers + tests. */
function auditError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Normalize + validate an audit origin.
 * @param {unknown} origin
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
 * Trim to a bounded string field, null for empty.
 * @param {unknown} value
 * @param {number} maxLen
 * @param {string} label
 * @returns {string|null}
 */
function boundedField(value, maxLen, label) {
  const text = value == null ? "" : String(value).trim();
  if (!text) return null;
  if (text.length > maxLen) {
    throw auditError(
      "FIELD_TOO_LONG",
      `${label} is too long (max ${maxLen} characters).`,
    );
  }
  return text;
}

/**
 * Serialize the details payload to JSON text (§8.6 caps).
 * @param {unknown} details
 * @returns {string|null}
 */
function serializeAuditDetails(details) {
  if (details == null) return null;
  let json;
  if (typeof details === "string") {
    // Already-serialized input: validate it parses (never double-encode).
    try {
      JSON.parse(details);
    } catch {
      throw auditError("INVALID_DETAILS", "Audit details string must be valid JSON.");
    }
    json = details;
  } else {
    try {
      json = JSON.stringify(details);
    } catch {
      throw auditError("INVALID_DETAILS", "Audit details must be JSON-serializable.");
    }
  }
  if (json.length > MAX_AUDIT_DETAILS_JSON) {
    throw auditError(
      "DETAILS_TOO_LARGE",
      `Audit details JSON exceeds ${MAX_AUDIT_DETAILS_JSON} characters.`,
    );
  }
  return json;
}

/**
 * Insert one audit row.
 * @param {object} opts
 * @param {number} opts.communityId   internal communities.id (asserted)
 * @param {string|null} [opts.actorUserId]  external user id; null for 'system'
 * @param {"web"|"slash"|"system"} [opts.origin]
 * @param {string} [opts.action]      `feature.verb` vocabulary
 * @param {string} [opts.targetType]
 * @param {string} [opts.targetId]    external id (stays a snowflake)
 * @param {object|string|null} [opts.details] object → JSON; string must be JSON
 * @param {number} [opts.createdAt]
 * @returns {object} the inserted row
 */
function insertAdminAudit(opts) {
  assertCommunityId(opts?.communityId);

  const normalized = normalizeAuditOrigin(opts?.origin ?? "system");
  if (!normalized.ok) throw auditError("INVALID_ORIGIN", normalized.error);

  const action = boundedField(opts?.action, MAX_AUDIT_ACTION, "Audit action");
  if (!action) {
    throw auditError("INVALID_ACTION", "Audit rows require a non-empty action.");
  }
  const actorUserId = boundedField(opts?.actorUserId, MAX_AUDIT_TARGET, "Actor user id");
  const targetType = boundedField(opts?.targetType, MAX_AUDIT_TARGET, "Target type");
  const targetId = boundedField(opts?.targetId, MAX_AUDIT_TARGET, "Target id");
  const detailsJson = serializeAuditDetails(opts?.details);

  const createdAt =
    opts?.createdAt != null && Number.isFinite(Number(opts.createdAt))
      ? Number(opts.createdAt)
      : now();

  const info = db
    .prepare(
      `
    INSERT INTO admin_audit (
      community_id, actor_user_id, origin, action,
      target_type, target_id, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
    )
    .run(
      opts.communityId,
      actorUserId,
      normalized.origin,
      action,
      targetType,
      targetId,
      detailsJson,
      createdAt
    );

  return {
    id: Number(info.lastInsertRowid),
    community_id: opts.communityId,
    actor_user_id: actorUserId,
    origin: normalized.origin,
    action,
    target_type: targetType,
    target_id: targetId,
    details_json: detailsJson,
    created_at: createdAt,
  };
}

/**
 * @param {number} id
 * @returns {object|null}
 */
function getAdminAuditById(id) {
  if (id == null) return null;
  const row = db
    .prepare(`SELECT * FROM admin_audit WHERE id=?`)
    .get(Number(id));
  return row || null;
}

/**
 * List audit rows for a community, newest first (§8.6 budget: LIMIT ≤ 100).
 * @param {number} communityId
 * @param {{ limit?: number, offset?: number, origin?: string }} [opts]
 * @returns {object[]}
 */
function listAdminAudit(communityId, opts = {}) {
  assertCommunityId(communityId);
  const limit = Math.min(Math.max(1, Number(opts.limit) || 25), MAX_AUDIT_LIST_LIMIT);
  const offset = Math.max(0, Number(opts.offset) || 0);

  if (opts.origin != null && opts.origin !== "") {
    const normalized = normalizeAuditOrigin(opts.origin);
    if (!normalized.ok) throw auditError("INVALID_ORIGIN", normalized.error);
    return db
      .prepare(
        `
      SELECT * FROM admin_audit
      WHERE community_id=? AND origin=?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(communityId, normalized.origin, limit, offset);
  }
  return db
    .prepare(
      `
    SELECT * FROM admin_audit
    WHERE community_id=?
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(communityId, limit, offset);
}

/**
 * @param {number} communityId
 * @param {{ origin?: string }} [opts]
 * @returns {number}
 */
function countAdminAudit(communityId, opts = {}) {
  assertCommunityId(communityId);
  if (opts.origin != null && opts.origin !== "") {
    const normalized = normalizeAuditOrigin(opts.origin);
    if (!normalized.ok) throw auditError("INVALID_ORIGIN", normalized.error);
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM admin_audit WHERE community_id=? AND origin=?`
        )
        .get(communityId, normalized.origin)?.c ?? 0
    );
  }
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM admin_audit WHERE community_id=?`)
      .get(communityId)?.c ?? 0
  );
}

module.exports = {
  AUDIT_ORIGINS,
  MAX_AUDIT_LIST_LIMIT,
  MAX_AUDIT_DETAILS_JSON,
  MAX_AUDIT_ACTION,
  MAX_AUDIT_TARGET,
  normalizeAuditOrigin,
  insertAdminAudit,
  getAdminAuditById,
  listAdminAudit,
  countAdminAudit,
};
