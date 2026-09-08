/**
 * Per-request audit helper for web mutations (roadmap/web-admin.md §8.1
 * decision 7, §8.5, §8.6): the `admin_audit` DB row IS the trail; channel
 * embeds are mirrors only. Built on the subtask-03 repository helpers
 * (insertAdminAudit / listAdminAudit / countAdminAudit) — nothing re-implemented.
 *
 * CONTRACT (Phases 1–3):
 *   mount once, after the session middleware:
 *     app.use(createAuditMiddleware());
 *   then in route handlers, AFTER a successful service-layer mutation:
 *     const row = req.audit({
 *       action,                 // required, e.g. "warnings.void"
 *       targetType, targetId,   // optional context columns
 *       details,                // optional object (or JSON string) — redacted
 *       guildId,                // optional override; else req.guildId → req.params.guildId
 *       origin,                 // optional, default 'web' (slash reuse allowed)
 *       mirror,                 // optional embed descriptor, see below
 *     });
 *   - RETURNS the inserted admin_audit row.
 *   - THROWS (→ Express 5 error middleware → generic 500) when the request is
 *     anonymous (AUDIT_ANONYMOUS), no guild resolves (AUDIT_NO_GUILD), the
 *     action is missing (AUDIT_INVALID_ACTION), the origin is invalid
 *     (AUDIT_INVALID_ORIGIN), or the DB write fails (repo/DB error verbatim).
 *     Fail closed: an unaudited mutation must never silently succeed — only
 *     call req.audit on the success path, and let the throw abort the response.
 *   - Synchronous by design (better-sqlite3 + Express 5): async handlers that
 *     let this throw reject, and router/lib/layer.js routes the rejection to
 *     the error middleware. Never await or return the mirror — req.audit
 *     itself never returns a Promise.
 *
 * MIRROR (§8.1-7 best-effort): `mirror` =
 *   { kind?: "audit"|"warn", title?, command?, changes?, details?, payload? }
 *   — or a raw { payload } (e.g. prebuilt { embeds: [...] }). Fire-and-forget
 *   dispatch to features/logs/auditLog posters (channel resolution, disabled
 *   channels and send failures live inside sendAuditLog/sendWarnLog). The
 *   dispatch carries its own .catch because Node 22 kills the process on an
 *   unhandled rejection; any mirror problem only logs a warning and can never
 *   affect the response or the DB row.
 *
 * REDACTION (§8.7 belt, atop the repo's 4000-byte/circular guards): keys
 * matching /(token|secret|password|cookie)/i are stripped recursively from
 * `details` before serialization.
 */

const db = require("../../db");
const auditLog = require("../../features/logs/auditLog");

/** Origin the web layer writes (§8.6); callers may override for slash reuse. */
const DEFAULT_AUDIT_ORIGIN = "web";

/** Details keys that smell like credentials never reach details_json. */
const REDACT_KEY_PATTERN = /(token|secret|password|cookie)/i;

/** Boot-bound Discord client for channel mirrors (bound via bindAuditClient). */
let boundAuditClient = null;

function auditError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Recursively strip credential-like keys. Returns a NEW structure (input is
 * never mutated); cycles collapse to null so the walker itself can never spin
 * (the repo's serializer guard stays the backstop).
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
function redactSensitive(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  const out = {};
  for (const key of Object.keys(value)) {
    if (REDACT_KEY_PATTERN.test(key)) continue;
    out[key] = redactSensitive(value[key], seen);
  }
  return out;
}

/**
 * Redaction entry point for user-supplied details. JSON strings are parsed,
 * redacted (when structured) and handed back as an object for the repo to
 * serialize; unparseable strings flow through untouched so the repo still
 * rejects them with INVALID_DETAILS.
 * @param {unknown} details
 * @returns {unknown}
 */
function redactDetails(details) {
  if (typeof details === "string") {
    let parsed;
    try {
      parsed = JSON.parse(details);
    } catch {
      return details;
    }
    return parsed && typeof parsed === "object" ? redactSensitive(parsed) : details;
  }
  return redactSensitive(details);
}

/**
 * Guild resolution order: explicit entry override → req.guildId (guildScope)
 * → req.params.guildId (routes mounted under /g/:guildId). Empty → null.
 * @param {object} req
 * @param {object} entry
 * @returns {string|null}
 */
function resolveGuildId(req, entry) {
  const raw = entry.guildId ?? req?.guildId ?? req?.params?.guildId;
  const text = raw == null ? "" : String(raw).trim();
  return text || null;
}

/**
 * Actor shape consumed by auditLog's embed builders ({ id, tag }).
 * @param {object} req
 * @returns {{ id: string, tag: string|null }|null}
 */
function mirrorActor(req) {
  const user = req?.user;
  if (!user?.userId) return null;
  return { id: String(user.userId), tag: user.discordTag || null };
}

/**
 * Explicit dependency injection (all overridable in tests): DB facade,
 * embed poster module, client accessor, logger.
 * @param {object} [options]
 */
function createAuditDeps(options = {}) {
  return {
    insertAdminAudit: options.insertAdminAudit || db.insertAdminAudit,
    listAdminAudit: options.listAdminAudit || db.listAdminAudit,
    countAdminAudit: options.countAdminAudit || db.countAdminAudit,
    normalizeAuditOrigin: options.normalizeAuditOrigin || db.normalizeAuditOrigin,
    auditLog: options.auditLog || auditLog,
    getClient: options.getClient || (() => boundAuditClient),
    logger: options.logger || console,
  };
}

/**
 * Bind the Discord client used by channel mirrors (called from web boot).
 * @param {import("discord.js").Client|null} client
 */
function bindAuditClient(client) {
  boundAuditClient = client || null;
}

/**
 * Build + post the mirror embed. Throws flow to scheduleMirror's .catch.
 * @param {object} mirror descriptor (see header)
 * @param {{ guildId: string, actor: object|null }} ctx
 * @param {object} deps
 * @returns {Promise<boolean>} whether something was posted
 */
async function dispatchMirror(mirror, ctx, deps) {
  const client = deps.getClient();
  if (!client) return false; // no client bound (dark boot / tests): nothing to mirror to

  const poster =
    mirror.kind === "warn" ? deps.auditLog.sendWarnLog : deps.auditLog.sendAuditLog;
  const payload =
    mirror.payload != null
      ? mirror.payload
      : {
          embeds: [
            deps.auditLog.buildConfigChangeEmbed({
              title: mirror.title,
              command: mirror.command,
              actor: ctx.actor,
              changes: mirror.changes,
              details: mirror.details,
            }),
          ],
        };

  return poster(client, ctx.guildId, payload);
}

/**
 * Fire-and-forget mirror dispatch. The .catch is MANDATORY: an unhandled
 * rejection kills the process on Node ≥15, and a mirror failure must never
 * surface on the response.
 * @param {unknown} mirror
 * @param {{ guildId: string, actor: object|null }} ctx
 * @param {object} deps
 */
function scheduleMirror(mirror, ctx, deps) {
  if (!mirror || typeof mirror !== "object") {
    deps.logger.warn("[web.audit] ignored mirror descriptor (not an object)");
    return;
  }
  Promise.resolve()
    .then(() => dispatchMirror(mirror, ctx, deps))
    .catch((err) => {
      deps.logger.warn("[web.audit] mirror dispatch failed:", err?.message || err);
    });
}

/**
 * Core write path: validate → DB insert (propagates on failure) → schedule
 * optional mirror. Returns the inserted row.
 * @param {object} req
 * @param {object} entry
 * @param {object} deps
 * @returns {object} the inserted admin_audit row
 */
function writeAudit(req, entry, deps) {
  if (!entry || typeof entry !== "object") {
    throw auditError("AUDIT_INVALID_ENTRY", "audit() expects an entry object.");
  }

  const action = entry.action == null ? "" : String(entry.action).trim();
  if (!action) {
    throw auditError("AUDIT_INVALID_ACTION", "audit() requires an action.");
  }

  const actorUserId = req?.user?.userId ? String(req.user.userId) : null;
  if (!actorUserId) {
    // Defensive: routes gate auth first; an anonymous mutation trail is worse
    // than a 500 because the audit viewer would show an unattributed change.
    throw auditError("AUDIT_ANONYMOUS", "audit() requires an authenticated actor (req.user).");
  }

  const guildId = resolveGuildId(req, entry);
  if (!guildId) {
    throw auditError(
      "AUDIT_NO_GUILD",
      "audit() could not resolve a guild id (pass guildId or mount under /g/:guildId)."
    );
  }

  const normalized = deps.normalizeAuditOrigin(entry.origin ?? DEFAULT_AUDIT_ORIGIN);
  if (!normalized.ok) {
    throw auditError("AUDIT_INVALID_ORIGIN", normalized.error);
  }

  // DB-first (§8.1-7): insertAdminAudit failures intentionally PROPAGATE —
  // the mutation is reported as failed rather than silently unaudited.
  const row = deps.insertAdminAudit({
    guildId,
    actorUserId,
    origin: normalized.origin,
    action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    details: redactDetails(entry.details),
  });

  if (entry.mirror) {
    scheduleMirror(entry.mirror, { guildId, actor: mirrorActor(req) }, deps);
  }
  return row;
}

/**
 * Express middleware factory: attaches the per-request `req.audit` helper.
 * Zero I/O, zero response writes — safe to mount globally (app.js) without
 * perturbing the Phase 0a byte-parity surface.
 * @param {object} [options] dep overrides, see createAuditDeps
 * @returns {(req: object, res: object, next: (err?: unknown) => void) => void}
 */
function createAuditMiddleware(options = {}) {
  const deps = createAuditDeps(options);
  return function auditMiddleware(req, res, next) {
    req.audit = (entry) => writeAudit(req, entry, deps);
    next();
  };
}

/**
 * One-shot form (subtask-09 description): equivalent to req.audit(entry) for
 * call sites that hold req without the middleware attached (tests, scripts).
 * @param {object} req
 * @param {object} res (unused; kept for the documented signature)
 * @param {object} entry
 * @param {object} [options] dep overrides
 * @returns {object} the inserted admin_audit row
 */
function attachAudit(req, res, entry, options = {}) {
  return writeAudit(req, entry, createAuditDeps(options));
}

/**
 * Thin passthrough for the Phase 1 System audit viewer (§8.6): delegates to
 * db.listAdminAudit (guild-scoped, LIMIT ≤ 100, newest first).
 * @param {string} guildId
 * @param {{ limit?: number, offset?: number, origin?: string, before?: number }} [opts]
 * @param {object} [options] dep overrides
 * @returns {object[]}
 */
function listAudit(guildId, opts = {}, options = {}) {
  return createAuditDeps(options).listAdminAudit(guildId, opts);
}

/**
 * Thin passthrough for the Phase 1 System audit viewer: total rows per guild.
 * @param {string} guildId
 * @param {{ origin?: string }} [opts]
 * @param {object} [options] dep overrides
 * @returns {number}
 */
function countAudit(guildId, opts = {}, options = {}) {
  return createAuditDeps(options).countAdminAudit(guildId, opts);
}

module.exports = {
  DEFAULT_AUDIT_ORIGIN,
  REDACT_KEY_PATTERN,
  bindAuditClient,
  createAuditMiddleware,
  attachAudit,
  listAudit,
  countAudit,
  redactSensitive,
};
