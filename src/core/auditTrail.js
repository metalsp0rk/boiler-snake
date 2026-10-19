/**
 * Thin admin_audit writer for the BOT-side mutation paths (roadmap/web-admin.md
 * §8.5): slash handlers write origin 'slash', automated jobs (tickers,
 * enforcement) write origin 'system'. Channel embeds via features/logs stay
 * best-effort MIRRORS only — the admin_audit row is the record (§8.1 decision 7).
 *
 * DELIBERATE ASYMMETRY vs the web layer (src/web/middleware/audit.js):
 *   - Web mutations FAIL CLOSED: the audit insert runs inside the request
 *     pipeline and a DB failure aborts the response (500). An unaudited web
 *     mutation must never silently succeed.
 *   - Slash/system paths are instrumented AFTER THE FACT here: by the time
 *     recordSlashAudit runs, the command is already permission-validated,
 *     committed to SQLite, and (usually) replied to. Killing or rolling back
 *     a shipped bot workflow because its audit TRAIL write hiccuped would be a
 *     worse user-visible failure than a missing trail row, and the handlers
 *     remain the security source of truth either way. So: any failure is
 *     logged as a warning and swallowed — this module NEVER throws and NEVER
 *     changes a command's reply or behavior. Handlers await it freely; it
 *     always resolves to a row or null.
 *
 * ACTION VOCABULARY (shared with future web mutations for §8.11 parity tests):
 * `feature.verb`, e.g. warnings.add, warnings.void, staff.role_add, xp.grant,
 * command_channels.add, decay.settings_update, tickets.close. Keep verbs
 * snake_case; do not rename once shipped — the Phase 1 audit viewer and the
 * slash↔web parity tests diff on this string.
 *
 * DETAILS: minimal before/after values only. CREDENTIAL-SHAPED keys (a whole
 * word component that IS token/secret/password/cookie — see isCredentialKey)
 * have their VALUES masked to REDACTED recursively before insert (§8.7
 * redaction belt; the repo's size/circular guards are the backstop).
 *
 * #368: this used to DELETE any key merely CONTAINING one of those words
 * (substring match), so the numeric "summarize_input_tokens" budget vanished
 * from gork.summarize_budget_set — the value the row exists to record. Two
 * fixes: match whole word COMPONENTS (so the plural count "...tokens" stays),
 * and MASK rather than drop (so a genuine redaction is visible in the audit
 * row instead of silently missing).
 */

const db = require("../db");
const { ensureCommunity } = require("../platform/community");

/** Placeholder replacing the value of every credential-shaped key (#368). */
const REDACTED = "[redacted]";

/**
 * Whole-word credential vocabulary. PLURAL credential words are included
 * ("client_secrets", "cookies"); the DELIBERATE omission is "tokens" — the
 * plural is the COUNT sense in this codebase's vocabulary
 * (summarize_input_tokens, max_tokens): budgets, not secrets (#368).
 */
const CREDENTIAL_WORDS = new Set([
  "token",
  "secret",
  "secrets",
  "password",
  "passwords",
  "cookie",
  "cookies",
]);

/**
 * A details key is credential-shaped when one of its WORD COMPONENTS is a
 * credential word: "bot_token", "accessToken", "clientSecret", "cookie" —
 * but NOT longer/plural words that merely CONTAIN one ("..._tokens" counts,
 * "tokenizer"). The old substring belt deleted those legitimate payloads
 * too; that over-reach was #368.
 * @param {string} key
 * @returns {boolean}
 */
function isCredentialKey(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase boundary → space
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return words.some((word) => CREDENTIAL_WORDS.has(word.toLowerCase()));
}

/**
 * Recursively MASK credential-shaped keys (value → REDACTED; the key stays
 * visible so the audit row shows something was hidden rather than nothing
 * being recorded). Returns NEW structures; the input is
 * never mutated. Cycles collapse to null so the walker can never spin.
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
    out[key] = isCredentialKey(key) ? REDACTED : redactSensitive(value[key], seen);
  }
  return out;
}

/**
 * Dep-injection seam (mirrors the web audit middleware's createAuditDeps
 * pattern): insert function + logger are overridable for tests.
 * @param {object} [options]
 */
function createAuditTrailDeps(options = {}) {
  return {
    insertAdminAudit: options.insertAdminAudit || db.insertAdminAudit,
    normalizeAuditOrigin: options.normalizeAuditOrigin || db.normalizeAuditOrigin,
    // Discord snowflake -> communities.id. Default registers the guild on
    // sight (ensureCommunity); tests may inject a stub for a DB-free unit run.
    resolveCommunity:
      options.resolveCommunity ||
      ((externalId) =>
        ensureCommunity({
          platform: "discord",
          instanceKey: "discord",
          externalGuildId: externalId,
        })),
    logger: options.logger || console,
  };
}

function warn(deps, reason, ctx, err) {
  deps.logger.warn(
    `[auditTrail] skipped audit row (${reason})${ctx ? ` ${ctx}` : ""}:`,
    err ? err?.message || err : "unknown"
  );
}

/**
 * Record one slash-path audit row (origin 'slash' unless overridden, e.g.
 * 'system' for automated jobs). Fail-safe by contract: returns the inserted
 * admin_audit row on success, null (with a logged warning) on ANY problem —
 * never throws, so an audit failure can never break a slash command.
 *
 * @param {object} entry
 * @param {number} [entry.communityId] internal communities.id (asserted by the
 *        repository). Preferred over the interaction-derived lookup.
 * @param {object} [entry.interaction]  Discord interaction; the Discord guild
 *        snowflake is resolved to a community id when communityId is absent.
 * @param {string} [entry.actorUserId]  explicit override; null allowed for
 *        origin 'system' (no human behind the row).
 * @param {string} entry.action       `feature.verb` vocabulary (see header).
 * @param {string} [entry.targetType] "user" | "channel" | "role" | "guild" ...
 * @param {string} [entry.targetId]
 * @param {object|string|null} [entry.details] before/after values; redacted.
 * @param {string} [entry.origin]     'slash' (default) | 'system' | 'web'.
 * @param {object} [options]          dep overrides (tests).
 * @returns {object|null} inserted row, or null when skipped/failed.
 */
function recordSlashAudit(entry, options = {}) {
  const deps = createAuditTrailDeps(options);
  try {
    if (!entry || typeof entry !== "object") {
      warn(deps, "invalid entry");
      return null;
    }

    let communityId = entry.communityId;
    if (typeof communityId !== "number") {
      const externalId = String(
        entry.externalGuildId ?? entry.guildId ?? entry.interaction?.guildId ?? "",
      ).trim();
      // Create-on-sight (same edge pattern every feature uses): the audit
      // trail must never silently drop a slash row for a guild whose
      // registry row has not been written yet.
      communityId = externalId ? deps.resolveCommunity(externalId) : null;
    }
    if (!Number.isSafeInteger(communityId)) {
      warn(deps, "no community id", `action=${entry.action}`);
      return null;
    }

    const actorUserId = String(
      entry.actorUserId ?? entry.interaction?.user?.id ?? ""
    ).trim();

    const normalized = deps.normalizeAuditOrigin(entry.origin ?? "slash");
    if (!normalized.ok) {
      warn(deps, normalized.error, `action=${entry.action}`);
      return null;
    }

    // 'system' rows legitimately have no human actor; 'slash' rows must be
    // attributed or the viewer shows an unattributed admin change.
    if (normalized.origin === "slash" && !actorUserId) {
      warn(deps, "slash audit without actor", `action=${entry.action}`);
      return null;
    }

    const action = entry.action == null ? "" : String(entry.action).trim();
    if (!action) {
      warn(deps, "missing action");
      return null;
    }

    return deps.insertAdminAudit({
      communityId,
      actorUserId: actorUserId || null,
      origin: normalized.origin,
      action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      details:
        entry.details == null ? null : redactSensitive(entry.details),
    });
  } catch (err) {
    // Fail-safe: the mutation already happened; never break the command.
    warn(
      deps,
      "insert failed",
      entry?.action ? `action=${entry.action}` : "",
      err
    );
    return null;
  }
}

/**
 * Origin-'system' shorthand for automated mutations (decay ticker, warn
 * expiry, ticker-driven role changes). Actor stays null unless given.
 * @param {object} entry Same shape as recordSlashAudit (origin ignored).
 * @param {object} [options] dep overrides (tests).
 * @returns {object|null}
 */
function recordSystemAudit(entry, options = {}) {
  return recordSlashAudit({ ...entry, origin: "system" }, options);
}

module.exports = {
  REDACTED,
  isCredentialKey,
  redactSensitive,
  recordSlashAudit,
  recordSystemAudit,
};
