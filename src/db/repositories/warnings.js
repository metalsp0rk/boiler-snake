const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/** Max reason / void_reason length (roadmap §6.3). */
const MAX_WARN_REASON = 1000;

/** Max freeform evidence text length. */
const MAX_EVIDENCE_TEXT = 500;

/** Max days for guild default or per-warning expiry override (≈10 years). */
const MAX_EXPIRY_DAYS = 3650;

/**
 * Discord message jump-link patterns.
 * Production uses snowflake segments; path shape is guild/channel/message.
 */
const DISCORD_MESSAGE_URL_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/([^/?#\s]+)\/([^/?#\s]+)\/([^/?#\s]+)\/?$/i;

/**
 * Normalize and validate warning reason text.
 * @param {string} reason
 * @param {string} [label="Reason"]
 * @returns {{ ok: true, reason: string } | { ok: false, error: string }}
 */
function normalizeWarnReason(reason, label = "Reason") {
  const text = reason == null ? "" : String(reason).trim();
  if (!text) {
    return { ok: false, error: `${label} cannot be empty.` };
  }
  if (text.length > MAX_WARN_REASON) {
    return {
      ok: false,
      error: `${label} is too long (max ${MAX_WARN_REASON} characters).`,
    };
  }
  return { ok: true, reason: text };
}

/**
 * Normalize optional freeform evidence text (null/empty → null).
 * @param {string|null|undefined} text
 * @returns {{ ok: true, text: string|null } | { ok: false, error: string }}
 */
function normalizeEvidenceText(text) {
  if (text == null) return { ok: true, text: null };
  const s = String(text).trim();
  if (!s) return { ok: true, text: null };
  if (s.length > MAX_EVIDENCE_TEXT) {
    return {
      ok: false,
      error: `Evidence text is too long (max ${MAX_EVIDENCE_TEXT} characters).`,
    };
  }
  return { ok: true, text: s };
}

/**
 * Validate and normalize a Discord message jump URL.
 * @param {string|null|undefined} url
 * @param {string} [expectedExternalGuildId] EXTERNAL Discord snowflake (the URL path
 *   embeds external guild ids — evidence URLs stay opaque text per spec).
 *   When set, the URL's guild segment must match. Never pass the internal
 *   community id here.
 * @returns {{ ok: true, url: string|null } | { ok: false, error: string }}
 */
function normalizeEvidenceMessageUrl(url, expectedExternalGuildId) {
  if (url == null) return { ok: true, url: null };
  const s = String(url).trim();
  if (!s) return { ok: true, url: null };

  const m = s.match(DISCORD_MESSAGE_URL_RE);
  if (!m) {
    return {
      ok: false,
      error:
        "Evidence message must be a Discord message link " +
        "(https://discord.com/channels/…/…/…).",
    };
  }

  const guildId = m[1];
  if (expectedExternalGuildId && guildId !== String(expectedExternalGuildId)) {
    return {
      ok: false,
      error: "Evidence message link must be from this server.",
    };
  }

  // Canonical form (no trailing slash, discord.com host)
  const canonical = `https://discord.com/channels/${m[1]}/${m[2]}/${m[3]}`;
  return { ok: true, url: canonical };
}

/**
 * Clamp expiry day counts (0 = never).
 * @param {unknown} days
 * @returns {{ ok: true, days: number } | { ok: false, error: string }}
 */
function normalizeExpiryDays(days) {
  if (days == null || days === "") {
    return { ok: false, error: "Expiry days is required." };
  }
  const n = Number(days);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return {
      ok: false,
      error: "Expiry days must be an integer ≥ 0 (0 = never expire).",
    };
  }
  if (n > MAX_EXPIRY_DAYS) {
    return {
      ok: false,
      error: `Expiry days cannot exceed ${MAX_EXPIRY_DAYS}.`,
    };
  }
  return { ok: true, days: n };
}

/**
 * Resolve absolute expires_at from create time + day count.
 * @param {number} createdAtMs
 * @param {number} days 0 or negative → null (never)
 * @returns {number|null}
 */
function expiresAtFromDays(createdAtMs, days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return null;
  const base = Number(createdAtMs);
  if (!Number.isFinite(base)) return null;
  return base + Math.floor(d) * 24 * 60 * 60 * 1000;
}

/**
 * Effective expiry days for a new warning.
 * Per-warning override wins when provided; else guild default.
 * @param {object} opts
 * @param {number|null|undefined} opts.expiresDays override (0 = never)
 * @param {number|null|undefined} opts.guildDefaultDays
 * @returns {number} days (0 = never)
 */
function resolveExpiryDays(opts = {}) {
  if (opts.expiresDays != null) {
    const n = Number(opts.expiresDays);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), MAX_EXPIRY_DAYS);
  }
  const g = Number(opts.guildDefaultDays ?? 0);
  if (!Number.isFinite(g) || g <= 0) return 0;
  return Math.min(Math.floor(g), MAX_EXPIRY_DAYS);
}

/**
 * Next sequential warning_number for a community. Internal helper — callers
 * (createWarning) assert the community id before entering.
 * @param {number} communityId
 * @returns {number}
 */
function nextWarningNumber(communityId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(warning_number), 0) AS max_n FROM warnings WHERE community_id=?`
    )
    .get(communityId);
  return Number(row?.max_n || 0) + 1;
}

/**
 * @param {object} opts
 * @param {number} opts.communityId
 * @param {string|null} [opts.externalGuildId] Discord snowflake used to scope
 *   the evidence message link (URLs embed external ids, not community ids)
 * @param {string} opts.userId
 * @param {string} opts.issuerId
 * @param {string} opts.reason
 * @param {number|null} [opts.relatedNoteId]
 * @param {number|null} [opts.expiresAt] absolute ms; preferred when set
 * @param {number|null} [opts.expiresDays] relative days from create (if expiresAt omitted)
 * @param {number|null} [opts.guildDefaultDays] used when expiresDays omitted
 * @param {string|null} [opts.evidenceMessageUrl]
 * @param {string|null} [opts.evidenceText]
 * @returns {object} created warning row
 */
function createWarning(opts) {
  assertCommunityId(opts.communityId);
  const normalized = normalizeWarnReason(opts.reason, "Reason");
  if (!normalized.ok) {
    const err = new Error(normalized.error);
    err.code = "INVALID_REASON";
    throw err;
  }

  const evidenceUrl = normalizeEvidenceMessageUrl(
    opts.evidenceMessageUrl,
    opts.externalGuildId
  );
  if (!evidenceUrl.ok) {
    const err = new Error(evidenceUrl.error);
    err.code = "INVALID_EVIDENCE_URL";
    throw err;
  }

  const evidenceText = normalizeEvidenceText(opts.evidenceText);
  if (!evidenceText.ok) {
    const err = new Error(evidenceText.error);
    err.code = "INVALID_EVIDENCE_TEXT";
    throw err;
  }

  let relatedNoteId = null;
  if (opts.relatedNoteId != null) {
    const n = Number(opts.relatedNoteId);
    if (!Number.isFinite(n) || n < 1) {
      const err = new Error("related_note_id must be a positive integer.");
      err.code = "INVALID_NOTE";
      throw err;
    }
    relatedNoteId = Math.floor(n);
  }

  const t = now();
  let expiresAt = null;
  if (opts.expiresAt != null) {
    const e = Number(opts.expiresAt);
    if (!Number.isFinite(e) || e <= 0) {
      const err = new Error("expires_at must be a positive timestamp.");
      err.code = "INVALID_EXPIRY";
      throw err;
    }
    expiresAt = Math.floor(e);
  } else {
    const days = resolveExpiryDays({
      expiresDays: opts.expiresDays,
      guildDefaultDays: opts.guildDefaultDays,
    });
    expiresAt = expiresAtFromDays(t, days);
  }

  const insert = db.prepare(`
    INSERT INTO warnings (
      community_id, warning_number, user_id, issuer_id, reason, created_at,
      related_note_id, expires_at, evidence_message_url, evidence_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const warningNumber = nextWarningNumber(opts.communityId);
    const info = insert.run(
      opts.communityId,
      warningNumber,
      opts.userId,
      opts.issuerId,
      normalized.reason,
      t,
      relatedNoteId,
      expiresAt,
      evidenceUrl.url,
      evidenceText.text
    );
    return Number(info.lastInsertRowid);
  });

  const id = tx();
  return getWarningById(id);
}

/**
 * @param {number} id
 * @returns {object|null}
 */
function getWarningById(id) {
  if (id == null) return null;
  return (
    db.prepare(`SELECT * FROM warnings WHERE id=?`).get(Number(id)) || null
  );
}

/**
 * Lookup by human-friendly per-community warning number.
 * @param {number} communityId
 * @param {number} warningNumber
 * @returns {object|null}
 */
function getWarning(communityId, warningNumber) {
  assertCommunityId(communityId);
  if (warningNumber == null) return null;
  return (
    db
      .prepare(
        `SELECT * FROM warnings WHERE community_id=? AND warning_number=?`
      )
      .get(communityId, Number(warningNumber)) || null
  );
}

/**
 * List warnings for a subject user (newest first).
 * @param {number} communityId
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.includeVoided=false]
 * @param {number} [opts.limit=25]
 * @param {number} [opts.offset=0]
 * @returns {object[]}
 */
function listWarnings(communityId, userId, opts = {}) {
  assertCommunityId(communityId);
  const includeVoided = !!opts.includeVoided;
  const maxLimit = opts.export ? 5000 : 100;
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), maxLimit);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  if (includeVoided) {
    return db
      .prepare(
        `
      SELECT * FROM warnings
      WHERE community_id=? AND user_id=?
      ORDER BY created_at DESC, warning_number DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(communityId, userId, limit, offset);
  }

  return db
    .prepare(
      `
    SELECT * FROM warnings
    WHERE community_id=? AND user_id=? AND voided_at IS NULL
    ORDER BY created_at DESC, warning_number DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(communityId, userId, limit, offset);
}

/**
 * @param {number} communityId
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.includeVoided=false]
 * @returns {number}
 */
function countWarnings(communityId, userId, opts = {}) {
  assertCommunityId(communityId);
  const includeVoided = !!opts.includeVoided;
  if (includeVoided) {
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM warnings WHERE community_id=? AND user_id=?`
        )
        .get(communityId, userId)?.c || 0
    );
  }
  return countActiveWarnings(communityId, userId);
}

/**
 * Normalize the community-wide list state filter (web console moderation
 * lists, roadmap/web-admin.md §8.6 — subtask 17). Whitelist-only:
 * "voided" → only voided rows, "all" → no void predicate, anything else
 * → "active" (the slash `/warn list` default of hiding voided).
 * @param {unknown} state
 * @returns {"active"|"voided"|"all"}
 */
function normalizeWarnState(state) {
  const s = String(state ?? "active").trim().toLowerCase();
  if (s === "voided" || s === "all") return s;
  return "active";
}

/**
 * Shared WHERE builder for the community-wide list/count pair. Declarative
 * from whitelisted inputs only (state via normalizeWarnState, userId as
 * a bound parameter) — no SQL ever built from raw strings.
 * @param {number} communityId
 * @param {{ userId?: string|null, state?: unknown }} opts
 * @returns {{ where: string, params: (string|number)[] }}
 */
function guildWarnWhere(communityId, opts = {}) {
  const state = normalizeWarnState(opts.state);
  const clauses = ["community_id=?"];
  const params = [communityId];
  if (opts.userId) {
    clauses.push("user_id=?");
    params.push(String(opts.userId));
  }
  if (state === "active") clauses.push("voided_at IS NULL");
  else if (state === "voided") clauses.push("voided_at IS NOT NULL");
  return { where: clauses.join(" AND "), params };
}

/**
 * Community-wide warnings list for the web moderation console — newest first
 * by warning_number DESC (per-community sequential ⇒ creation order; served
 * by the UNIQUE(community_id, warning_number) index with no sort step,
 * unlike created_at which has no community-wide index — see migration 009).
 * The per-user list keeps listWarnings(); this is its community-scoped
 * sibling.
 *
 * Phase 2/3 reuse: web warn/void actions re-read the list page through
 * this exact helper (same filters, same bounds).
 *
 * @param {number} communityId
 * @param {object} [opts]
 * @param {string|null} [opts.userId=null] exact subject filter (snowflake)
 * @param {"active"|"voided"|"all"} [opts.state="active"] void-state filter
 * @param {number} [opts.limit=25] hard-capped at 100 (§8.6 query budget)
 * @param {number} [opts.offset=0]
 * @returns {object[]}
 */
function listGuildWarnings(communityId, opts = {}) {
  assertCommunityId(communityId);
  const { where, params } = guildWarnWhere(communityId, opts);
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  return db
    .prepare(
      `
    SELECT * FROM warnings
    WHERE ${where}
    ORDER BY warning_number DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(...params, limit, offset);
}

/**
 * Count behind listGuildWarnings — SAME filter semantics so pagers are
 * honest (state default "active", exact userId filter).
 * @param {number} communityId
 * @param {object} [opts]
 * @param {string|null} [opts.userId=null]
 * @param {"active"|"voided"|"all"} [opts.state="active"]
 * @returns {number}
 */
function countGuildWarnings(communityId, opts = {}) {
  assertCommunityId(communityId);
  const { where, params } = guildWarnWhere(communityId, opts);
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM warnings WHERE ${where}`).get(...params)?.c || 0
  );
}

/**
 * Active (non-voided) warning count for a user in a community.
 * @param {number} communityId
 * @param {string} userId
 * @returns {number}
 */
function countActiveWarnings(communityId, userId) {
  assertCommunityId(communityId);
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM warnings WHERE community_id=? AND user_id=? AND voided_at IS NULL`
      )
      .get(communityId, userId)?.c || 0
  );
}

/**
 * Active warnings past their expires_at (for auto-void ticker).
 * @param {number} [nowMs]
 * @param {number} [limit=50]
 * @returns {object[]}
 */
function listExpiredActiveWarnings(nowMs = now(), limit = 50) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db
    .prepare(
      `
    SELECT * FROM warnings
    WHERE voided_at IS NULL
      AND expires_at IS NOT NULL
      AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT ?
  `
    )
    .all(Number(nowMs), lim);
}

/**
 * Void a warning (permanent row; marks inactive). Cannot un-void.
 * @param {number} communityId
 * @param {number} warningNumber
 * @param {object} opts
 * @param {string} opts.voidedBy
 * @param {string} opts.voidReason
 * @returns {object|null} updated row, or null if not found
 * @throws {{ code: string }} INVALID_REASON | ALREADY_VOIDED
 */
function voidWarning(communityId, warningNumber, opts) {
  assertCommunityId(communityId);
  const normalized = normalizeWarnReason(opts.voidReason, "Void reason");
  if (!normalized.ok) {
    const err = new Error(normalized.error);
    err.code = "INVALID_REASON";
    throw err;
  }

  const existing = getWarning(communityId, warningNumber);
  if (!existing) return null;
  if (existing.voided_at != null) {
    const err = new Error(
      `Warning W-${existing.warning_number} is already voided.`
    );
    err.code = "ALREADY_VOIDED";
    err.warning = existing;
    throw err;
  }

  const t = now();
  db.prepare(
    `
    UPDATE warnings
    SET voided_at=?, voided_by=?, void_reason=?
    WHERE community_id=? AND warning_number=? AND voided_at IS NULL
  `
  ).run(
    t,
    opts.voidedBy,
    normalized.reason,
    communityId,
    Number(warningNumber)
  );

  return getWarning(communityId, warningNumber);
}

module.exports = {
  MAX_WARN_REASON,
  MAX_EVIDENCE_TEXT,
  MAX_EXPIRY_DAYS,
  DISCORD_MESSAGE_URL_RE,
  normalizeWarnReason,
  normalizeEvidenceText,
  normalizeEvidenceMessageUrl,
  normalizeExpiryDays,
  expiresAtFromDays,
  resolveExpiryDays,
  createWarning,
  getWarningById,
  getWarning,
  listWarnings,
  countWarnings,
  listGuildWarnings,
  countGuildWarnings,
  normalizeWarnState,
  countActiveWarnings,
  listExpiredActiveWarnings,
  voidWarning,
};
