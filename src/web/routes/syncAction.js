/**
 * POST /g/:guildId/commands/sync — the Phase-3 COMMAND-VISIBILITY SYNC
 * TRIGGER (roadmap/web-admin.md §8.6 "Command visibility: sync status +
 * trigger | Staff (view) | Admin (sync)" row + §8.8 Phase 3; subtask 31).
 * The web twin of `/staff syncpermissions` (with a token stored): ONE
 * admin-only POST mutation that fires the SHARED sync core both call sites
 * use — nothing about the sync itself is re-implemented here.
 *
 * SERVICE PARITY (the whole point): the flow lives in
 * src/features/commandPermissions/syncTrigger.js — the slash handler
 * (src/features/staffRoles/index.js handleSyncPermissions) and this route
 * call the SAME runCommandVisibilitySync(): env preconditions from the
 * existing config reader, the stored-authorization gate on
 * guild_command_permission_oauth (the slash's OAuth storage — decision 9
 * keeps WEB LOGIN tokens OUT of this path: the sync reads/refreshes the
 * guild's stored user token via oauthTokens#getValidAccessToken inside
 * commandPermissions/sync.js, and the panel + tests prove a web session
 * token is NEVER sent to Discord), then applyGuildCommandPermissions()
 * unchanged (bot-token GET of the guild command list + one Bearer PUT per
 * staff-tier command + persisting last_sync_at/last_sync_error). The audit
 * entry this route writes is built by the core's shared
 * buildSyncAuditDetails() with the core's SYNC_AUDIT_ACTION constant —
 * identical action string, target and detail shape on both transports;
 * only origin differs ('web' vs 'slash'), which is what the column is for.
 *
 * TIER: requireTier("admin"). Slash evidence: /staff syncpermissions gates
 * on isAdminOrMod(interaction) (ManageGuild) and is listed ManageGuild-ONLY
 * in AGENTS.md §4 — the web tier ladder (staff < senior < admin) resolves
 * "admin" to exactly that gate. guildScope (routes/guildShell.js, mounted
 * earlier in app.js) already answered anon ⇒ 302 login and
 * cross-guild/stranger ⇒ generic 404 (never 403, §8.6).
 *
 * PRECONDITION REJECTIONS — ZERO Discord calls, zero audit, PRG with a
 * whitelisted slug only (the same doctrine as routes/xpActions.js):
 *  - env missing (CLIENT_SECRET / PUBLIC_* pair …): the config reader's
 *    `missing` NAMES are mapped through a FROZEN name→token table before
 *    the Location is minted; every slug segment is re-checked against the
 *    view's whitelist, so a redirect can carry env-variable NAMES but never
 *    env VALUES (§8.7). Slug: `env_not_configured:<names…>` ("+"-joined).
 *  - no stored authorization: `not_authorized_run_slash` — the panel
 *    advice verbatim: authorization is the slash's OAuth UX; run
 *    /staff syncpermissions ONCE in Discord, then the web can re-trigger.
 *
 * FAILURE MAPPING (mirror of the slash's catch branches — never a fabricated
 * success): err.code reauth_required/not_authorized (token expired/revoked
 * mid-run, refresh rejected) ⇒ `reauth_required`; any other sync throw ⇒
 * `sync_failed`. A PARTIAL result (some commands failed, the sync resolved)
 * is NOT a rejection: like the slash, this route audits it and PRGs
 * `sync_partial` (the panel's last-sync-error banner shows the reason —
 * persisted by the SHARED applyGuildCommandPermissions, same as slash).
 * AUDIT (§8.6, DB-first fail-closed via req.audit, origin defaults 'web'):
 * ONE admin_audit row per started trigger on every resolved outcome
 * (success AND partial), same action string, same target, same details as
 * the slash. NO channel mirror: the slash syncpermissions path posts NO
 * logConfigChange embed (only the staff-role CRUD handlers do), so parity
 * = the web mirrors nothing. An audit INSERT failure aborts with the
 * generic 500 — fail-closed, the outcome is never silently claimed.
 *
 * CONCURRENCY (documented slash parity): the slash path has NO lock or
 * debounce around applyGuildCommandPermissions — the sync is an idempotent
 * full-replace PUT per command (last writer wins, identical payload), and
 * maybeAutoSyncCommandPermissions fire-and-forgets freely next to it. The
 * web matches that: no extra lock; the per-user mutation rate limiter
 * (middleware/rateLimit.js) bounds scripted hammering, which the slash has
 * no equivalent of (stricter than slash, never looser).
 *
 * MUTATION CONTRACT (Phase-2 doctrine): the methodGate registry entry and
 * the Express route are minted from ONE path constant via postMutation
 * (registerWebMutation + app.post + requireTier lockstep — they cannot
 * drift). CSRF is auto-enforced on every /g/ POST (middleware/csrf.js);
 * the staff-page sync form embeds the hidden _csrf. Body fields arrive
 * pre-parsed on req.bodyFields (body-cap consumed the stream — no express
 * parsers on top). PRG: every answer is a 302 to ONE of the two whitelisted
 * surfaces (/staff or /commands, chosen by the whitelisted `return` field)
 * with a frozen `done=`/`error=` slug; NO submitted value is ever echoed
 * into a redirect (§8.7). The trigger UI renders ONLY on the staff page
 * (admin tier); GET /commands stays read-only (Phase-1 pin).
 */

const { requireTier } = require("../middleware/requireTier");
const {
  FLASH_DONE,
  FLASH_ERROR,
  ENV_SLUG_PREFIX,
  envNotConfiguredSlug,
  parseEnvSlug,
} = require("../views/syncAction");
const {
  SYNC_AUDIT_ACTION,
  buildSyncAuditDetails,
} = require("../../features/commandPermissions/syncTrigger");

/** Sync trigger surface (methodGate registry + app.post read this SAME
 * constant — the lockstep is structural, not by convention). */
const SYNC_PATH = "/g/:guildId/commands/sync";

/** PRG return targets — the ONLY two surfaces this mutation redirects to. */
const RETURN_TARGETS = Object.freeze({
  staff: "staff",
  commands: "commands",
});
const DEFAULT_RETURN = "commands";

/** err.code values the sync core propagates for a dead authorization
 * (oauthTokens#getValidAccessToken) — both mean "slash re-auth needed". */
const REAUTH_CODES = new Set(["reauth_required", "not_authorized"]);

/** Parsed urlencoded fields (bodyCap/CSRF contract — no express parsers). */
function readFields(req) {
  const src = req?.bodyFields;
  return src && typeof src === "object" ? src : {};
}

/**
 * Whitelisted `return` field → redirect surface. Unknown/hostile values are
 * REFUSED with the invalid_return slug (xpActions validation doctrine:
 * never echo, never silently accept); anything else than staff|commands
 * never shapes a Location.
 * @param {unknown} raw
 * @returns {"staff"|"commands"|null} null = invalid (rejected)
 */
function parseReturnTarget(raw) {
  const value = String(raw == null ? "" : raw).trim().toLowerCase();
  if (value === "") return DEFAULT_RETURN;
  return RETURN_TARGETS[value] || null;
}

/**
 * PRG 302 to one of the TWO whitelisted surfaces with a WHITELISTED flash
 * slug. Both the target and the slug are re-checked against the frozen
 * vocabularies before the Location is minted (settings.js redirectSettings
 * doctrine): a bug at a call site can still never reflect input into a
 * redirect (§8.7).
 * @param {import("http").ServerResponse} res
 * @param {string} guildId server-derived (guildScope snowflake)
 * @param {"staff"|"commands"} target
 * @param {"done"|"error"} flag
 * @param {string} slug
 */
function respondSyncRedirect(res, guildId, target, flag, slug) {
  const safeTarget = RETURN_TARGETS[target] ? target : DEFAULT_RETURN;
  const safeFlag = flag === "done" ? "done" : "error";
  const table = safeFlag === "done" ? FLASH_DONE : FLASH_ERROR;
  const known =
    typeof slug === "string" &&
    (Object.prototype.hasOwnProperty.call(table, slug) ||
      // env_not_configured carries the whitelisted env-name tokens — the
      // STRICT re-check via the view's parseEnvSlug (every "+"-joined
      // segment must exist in the frozen ENV_SLUG_NAMES table), so the
      // Location can only ever carry known token names, never an arbitrary
      // substring, even if a caller constructed the slug elsewhere (§8.7).
      slug.startsWith(ENV_SLUG_PREFIX) && parseEnvSlug(slug) !== null);
  const safeSlug = known
    ? slug
    : safeFlag === "done"
      ? Object.keys(FLASH_DONE)[0]
      : Object.keys(FLASH_ERROR)[0];
  res.writeHead(302, {
    // The composite env slug joins tokens with "+" — in a QUERY that must
    // travel percent-encoded ("%2B"), or form-decoding (URLSearchParams)
    // turns it back into SPACES and the whitelist re-check on the next read
    // (correctly) refuses it. Encode at mint time; single-token slugs have
    // no separator and pass through untouched.
    Location: `/g/${encodeURIComponent(guildId)}/${safeTarget}?${safeFlag}=${safeSlug.split("+").join("%2B")}`,
    "Cache-Control": "no-store",
  });
  res.end();
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {any} [options.guildAccess] accepted for mount-shape parity but NOT
 *   used here: this is a POST-only surface, so there is no guild switcher to
 *   build (shellGuilds lives in the GET modules). Tier comes from
 *   req.guildAccess, populated by guildScope (routes/guildShell.js) which
 *   app.js mounts BEFORE this module — the SAME resolver instance the shell
 *   uses (§8.3: one tier cache).
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {{runCommandVisibilitySync?: Function}} [options.syncActions]
 *   service-layer override for tests/gates (call-through spies / offline
 *   fakes — the T3 ticketActions doctrine: ONLY the outbound Discord HTTP
 *   is faked, every guard around it is real). Production omits it and the
 *   REAL shared core (src/features/commandPermissions/syncTrigger.js) is
 *   resolved lazily PER CALL — so the Phase-2 gate's facade recorder
 *   (installed before the first POST) and the parity suite's fetch spies
 *   are what the sync itself binds. There is deliberately NO seam to
 *   replace the token store or the audit action — both are parity anchors.
 */
function registerSyncActionRoutes(app, options = {}) {
  const runSync =
    options.syncActions?.runCommandVisibilitySync ||
    // Lazy require (per call): keeps the core binding to the CURRENT src/db
    // facade (the gate recorder wraps the module object before the first
    // POST) and never couples route load order to feature load order.
    ((...args) =>
      require("../../features/commandPermissions/syncTrigger").runCommandVisibilitySync(
        ...args
      ));

  // LAZY require: app.js requires THIS module while app.js itself is still
  // loading, so a top-level `require("../app")` would observe a partially
  // initialized module. registerSyncActionRoutes only ever runs from inside
  // createWebApp(), long after ../app's exports are complete.
  const { registerWebMutation } = require("../app");

  /**
   * Structural lockstep (mutation-gate contract): the methodGate registry
   * entry and the Express route are minted from ONE call with ONE template
   * constant — they cannot drift.
   * @param {string} template
   * @param {(req: any, res: any, next: (err?: unknown) => void) => Promise<void>|void} handler
   */
  const postMutation = (template, handler) => {
    registerWebMutation(app, "POST", template);
    app.post(template, requireTier("admin"), handler);
  };

  // =========================================================================
  // Phase 3 mutation (subtask 31). Route choreography: CSRF (auto, /g/) →
  // requireTier("admin") → return-target whitelist → SHARED sync core
  // (env preconditions + stored-authorization gate BEFORE any Discord call)
  // → ONE req.audit row on every resolved outcome (fail-closed) → 302 PRG
  // with a whitelisted slug.
  // =========================================================================
  postMutation(SYNC_PATH, async (req, res, next) => {
    const guildId = req.guildAccess.guildId;
    const target = parseReturnTarget(readFields(req).return);
    if (!target) {
      respondSyncRedirect(res, guildId, DEFAULT_RETURN, "error", "invalid_return");
      return;
    }

    let out;
    try {
      out = await runSync(guildId);
    } catch (err) {
      // Sync started but blew up mid-flight (expired/revoked authorization,
      // transport failure). Slash parity: the handler replies an honest
      // failure and writes NO audit row (the recordSlashAudit call sits
      // AFTER a resolved result) — the web mirrors both: failure slug, zero
      // audit. Nothing was claimed, nothing was fabricated.
      const code = err?.code;
      respondSyncRedirect(
        res,
        guildId,
        target,
        "error",
        REAUTH_CODES.has(code) ? "reauth_required" : "sync_failed"
      );
      return;
    }

    if (out.status === "env_not_configured") {
      respondSyncRedirect(
        res,
        guildId,
        target,
        "error",
        envNotConfiguredSlug(out.missing)
      );
      return;
    }

    if (out.status === "not_authorized") {
      respondSyncRedirect(res, guildId, target, "error", "not_authorized_run_slash");
      return;
    }

    // Synced (full or partial). Audit FIRST (fail-closed §8.1-7), mirroring
    // the slash entry EXACTLY: action + target + shared details builder.
    const result = out.result;
    try {
      req.audit({
        action: SYNC_AUDIT_ACTION,
        targetType: "guild",
        targetId: guildId,
        guildId,
        details: buildSyncAuditDetails(result),
        // NO mirror descriptor: /staff syncpermissions posts no
        // logConfigChange embed — parity means mirroring NOTHING here.
      });
    } catch (err) {
      next(err); // fail-closed: the generic 500; the outcome is never claimed
      return;
    }

    respondSyncRedirect(
      res,
      guildId,
      target,
      "done",
      (Array.isArray(result.failed) ? result.failed.length : 0) > 0
        ? "sync_partial"
        : "sync_completed"
    );
  });
}

module.exports = {
  registerSyncActionRoutes,
  // Sync-trigger surface (pinned by test/web-visibility-sync.test.js + the
  // Phase-2 gate registry cross-check)
  SYNC_PATH,
  RETURN_TARGETS,
  DEFAULT_RETURN,
  REAUTH_CODES,
  parseReturnTarget,
  respondSyncRedirect,
};
