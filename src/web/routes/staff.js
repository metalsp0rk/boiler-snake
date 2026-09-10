/**
 * GET /g/:guildId/staff + GET /g/:guildId/commands — the staff-roles view +
 * command-visibility sync status (roadmap/web-admin.md §8.6 "Staff & roles:
 * staff_roles CRUD + levels | Staff (view) | Admin | 1 view · 2 write" and
 * "Command visibility: sync status + trigger | Staff (view) | Admin (sync) |
 * 1 view · 3 action").
 *
 * Phase 2 mutations (subtask 25) JOINED the GET surface: five POST routes,
 * each registered through the registerWebMutation + app.post LOCKSTEP helper
 * (makeMethodGate 405s every unregistered /g/ verb — see app.js):
 *
 *   POST /g/:guildId/staff/role/add        tier ADMIN   → db.addStaffRole
 *   POST /g/:guildId/staff/role/remove     tier ADMIN   → db.removeStaffRole
 *   POST /g/:guildId/staff/role/setlevel   tier ADMIN   → db.setStaffRoleLevel
 *   POST /g/:guildId/staff/levelrole/set   tier STAFF   → db.upsertLevelRole
 *   POST /g/:guildId/staff/levelrole/remove tier STAFF  → db.deleteLevelRole
 *
 * TIER PROOF (slash parity — handlers are the security source of truth):
 *  - /staff role add|remove|setlevel gate on isAdminOrMod(interaction)
 *    (src/features/staffRoles/index.js: "Only server administrators can…",
 *    ManageGuild-only per AGENTS.md §4) ⇒ web requireTier("admin").
 *  - /leveltorole set|remove gate on isStaff(interaction)
 *    (src/features/levelRoles/index.js: `if (!isStaff(interaction))
 *    replyDenied`) — ManageGuild is only the picker's
 *    defaultMemberPermissions, NOT the handler gate ⇒ web requireTier
 *    ("staff"), which the tier ladder (staff < senior < admin) resolves to
 *    exactly isStaff semantics (admin satisfies staff, never the reverse).
 *
 * SERVICE PARITY: the same src/db facade helpers the slash handlers call
 * (addStaffRole upsert semantics, removeStaffRole's boolean, setStaffRoleLevel
 * requiring an existing row, normalizeStaffLevel, unconditional
 * upsertLevelRole / deleteLevelRole) — with the same validation the slash
 * gets from Discord's role picker / option whitelist re-implemented for
 * free-text web input: strict snowflake role id (no @everyone), staff level
 * whitelist (jr/sr aliases accepted EXACTLY as normalizeStaffLevel accepts
 * them; anything else is REJECTED instead of silently defaulting to senior),
 * level/drop-days non-negative integers (slash min:0 + Math.max(0,·)).
 *
 * DISCORD-SIDE PREFLIGHT (cache-only client seam, never a fetch): slash role
 * options can only ever name a role that exists in the guild, so the web
 * mirrors that invariant when — and ONLY when — the guild's role cache is
 * available: role absent from a live cache ⇒ rejected (a role the config
 * could never act on). Bot-above-role: level_roles rows are GRANTED to
 * members by levelRoles/sync.js; when the cache proves the bot's highest role
 * is at or below the target, the web REFUSES the mapping with the same
 * hierarchy warning sync.js logs post-hoc ("the bot's highest role is below
 * the role it is trying to manage") instead of silently storing a mapping
 * that can never be granted (§8.1-6: surfaced as a user error, not silent).
 * staff_roles rows are never role-ASSIGNED by the bot (member gate is pure
 * DB, ticket overwrites are not position-bound) ⇒ existence check only.
 * An UNAVAILABLE cache (no client / no guild in cache) skips the preflight —
 * exactly slash behavior (Discord itself guarantees the picker's roles).
 *
 * AUDIT (§8.6, DB-first fail-closed): every successful mutation writes ONE
 * admin_audit row via req.audit (origin defaults 'web') reusing the EXACT
 * slash action strings + detail shapes — staff.role_add {level,
 * previous_level}, staff.role_remove {previous_level}, staff.role_setlevel
 * {previous_level, level}, level_roles.set {level_required, drop_grace_days},
 * level_roles.remove (no details) — plus the best-effort channel-embed
 * MIRROR (same titles/commands the slash logConfigChange posts; degrades
 * clean when no client is bound, §8.1-7). Rejections write NOTHING.
 *
 * Success answers POST-Redirect-GET with a 302 to /g/:guildId/staff; user
 * validation errors answer 400 with a fixed plain-text message (inputs are
 * never echoed). Route position: AFTER routes/guildShell.js in app.js, so
 * the shell's /g/:guildId guildScope already ran (anon ⇒ login redirect,
 * cross-guild/stranger ⇒ generic 404 — §8.6 never-403 rule); requireTier
 * inside each route denies the wrong tier with the fixed generic 403. CSRF
 * is auto-enforced on every /g/ POST (middleware/csrf.js); views embed the
 * hidden _csrf from req.csrfToken. NO route HERE triggers OAuth or the
 * permission sync — the Phase-3 sync TRIGGER is its own module
 * (routes/syncAction.js, POST /g/:guildId/commands/sync, ADMIN); this file
 * renders the panel it lives in (staff page only — the /commands GET stays
 * forms-free, Phase-1 pin) and reads its whitelisted PRG flash back.
 *
 * Data: exclusively src/web/data/staffData.js (facade-only reads; the
 * command-permission OAuth row is whitelist-projected onto status fields so
 * refresh/access token columns can never reach a view — §8.1-9/§8.7). The
 * env view of the sync panel comes from the EXISTING
 * features/commandPermissions/config.js reader, SANITIZED here to
 * { available, ready, redirectUri, missing[] } — env values, CLIENT_ID and
 * CLIENT_SECRET are never handed to a view.
 *
 * Role labels: cache-only via the optional getClient seam (same pattern as
 * routes/settings.js makeChannelNameResolver) — a cached role name decorates
 * the id; nothing is ever fetched on a request path, and the id alone is
 * always a complete rendering.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { readFields } = require("./shared/req.js");
const { rawFlashQuery } = require("./shared/req.js");
const { shellGuilds } = require("./shared/shell.js");
const { makeGuildRoleNameResolver: makeRoleNameResolver } = require("./shared/discord-cache.js");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const {
  renderStaffBody,
  renderCommandsBody,
} = require("../views/staff");
const { flashFromQuery } = require("../views/syncAction");
const { createStaffData } = require("../data/staffData");

/** Mutation mount templates (methodGate registry + app.post read these SAME
 * constants — the lockstep is structural, not by convention). */
const ROLE_ADD_PATH = "/g/:guildId/staff/role/add";
const ROLE_REMOVE_PATH = "/g/:guildId/staff/role/remove";
const ROLE_SETLEVEL_PATH = "/g/:guildId/staff/role/setlevel";
const LEVELROLE_SET_PATH = "/g/:guildId/staff/levelrole/set";
const LEVELROLE_REMOVE_PATH = "/g/:guildId/staff/levelrole/remove";

/** Snowflake gate — same digit range as guildScope's GUILD_ID_RE. */
const { URL_ID_RE: ROLE_ID_RE } = require("../shared/snowflake");
/** Whole numbers ≥ 0, ≤ 9 digits (slash IntegerOption min:0; DB/JS-safe). */
const NONNEG_INT_RE = /^(0|[1-9][0-9]{0,8})$/;
/**
 * Level whitelist for free-text web input. The slash picker only ever
 * supplies "junior"|"senior"; the DB normalizer ALSO accepts jr/sr, so the
 * web accepts exactly that set — and NEVER the silent senior default
 * normalizeStaffLevel gives unknown values (slash can't produce one).
 */
const STAFF_LEVEL_INPUTS = Object.freeze({
  junior: "junior",
  jr: "junior",
  senior: "senior",
  sr: "senior",
});

/** Fixed 400 bodies (never echo input; short, actionable, no internals). */
const ERR_ROLE_INVALID = "Invalid role id: expected a Discord role id.";
const ERR_EVERYONE = "You cannot use @everyone as a staff role.";
const ERR_LEVEL_INVALID = "Invalid staff level (junior or senior).";
const ERR_NUMBER_INVALID =
  "Invalid number: level and drop days must be whole numbers 0 or greater.";
const ERR_ROLE_NOT_IN_GUILD =
  "That role does not exist in this guild (check the role id).";
const ERR_BOT_BELOW_ROLE =
  "The bot's highest role is below the role it is trying to manage (or it lacks Manage Roles) — move the bot role up first.";
const ERR_NOT_A_STAFF_ROLE =
  "That role is not a staff role. Use /staff role add (or the add form) first.";
const ERR_ALREADY_LEVEL = (level) => `That role is already ${level} staff.`;
const ERR_NOT_A_CONFIGURED_ROLE = "That role is not a configured staff role.";


/**
 * Cache-only guild-role probe for the mutation preflight (NEVER a fetch):
 *  - { verifiable:false }            — client / guild / role-cache absent:
 *    nothing can be verified; slash never needed this (Discord's picker IS
 *    the guild role list), so behavior stays slash-identical;
 *  - { verifiable:true, exists:false } — the cache KNOWS the guild and the
 *    role is not in it ⇒ reject (the mirror of slash's picker guarantee);
 *  - { verifiable:true, exists:true, botBelow } — botBelow is tri-state:
 *    true/false only when BOTH positions are finite numbers, null when the
 *    cache cannot answer (then no hierarchy claim is made).
 * @param {(() => any)|null|undefined} getClient
 * @param {string} guildId
 * @param {string} roleId
 */
function probeGuildRole(getClient, guildId, roleId) {
  try {
    const client = typeof getClient === "function" ? getClient() : null;
    const guild = client?.guilds?.cache?.get?.(guildId) ?? null;
    const roleCache = guild?.roles?.cache;
    if (!roleCache || typeof roleCache.get !== "function") {
      return { verifiable: false, exists: null, botBelow: null };
    }
    const role = roleCache.get(roleId);
    if (!role) return { verifiable: true, exists: false, botBelow: null };
    const rolePos = Number(role.position);
    const botPos = Number(guild?.me?.roles?.highest?.position);
    const botBelow =
      Number.isFinite(rolePos) && Number.isFinite(botPos)
        ? botPos <= rolePos
        : null;
    return { verifiable: true, exists: true, botBelow };
  } catch {
    return { verifiable: false, exists: null, botBelow: null };
  }
}

/** Slash levelLabel mirror (staffRoles/index.js): junior | senior only. */
function levelLabel(level) {
  return String(level || "").trim().toLowerCase() === "junior"
    ? "junior"
    : "senior";
}


/** Raw text/plain 400 with a FIXED message (input never echoed). */
function respondMutationError(res, message) {
  res.writeHead(400, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(message);
}

/** POST-Redirect-GET back to the staff page (empty body, no-store). */
function respondMutationRedirect(res, guildId) {
  res.writeHead(302, {
    Location: `/g/${guildId}/staff`,
    "Cache-Control": "no-store",
  });
  res.end();
}

/**
 * Validate a free-text role id against the guild: strict snowflake, never
 * @everyone (roleId === guildId — the slash add handler rejects it; the web
 * rejects it on every staff-role mutation because a role picker could never
 * name it). Returns { roleId } or { error }.
 * @param {unknown} raw
 * @param {string} guildId
 */
function parseRoleId(raw, guildId) {
  const value = String(raw == null ? "" : raw).trim();
  if (!ROLE_ID_RE.test(value)) return { error: ERR_ROLE_INVALID };
  if (value === String(guildId)) return { error: ERR_EVERYONE };
  return { roleId: value };
}

/**
 * Whitelisted staff level (see STAFF_LEVEL_INPUTS). The DB normalizer must
 * agree with the whitelist answer (belt-and-suspenders slash parity).
 * @param {unknown} raw
 * @param {(level: string) => string} normalizeStaffLevel
 * @returns {"junior"|"senior"|null}
 */
function parseStaffLevelInput(raw, normalizeStaffLevel) {
  const mapped = STAFF_LEVEL_INPUTS[String(raw == null ? "" : raw).trim().toLowerCase()];
  if (!mapped) return null;
  return typeof normalizeStaffLevel === "function" &&
    normalizeStaffLevel(mapped) !== mapped
    ? null
    : mapped;
}

/** Whole number ≥ 0 (slash IntegerOption min:0; "" / "1.5" / "-1" → null). */
function parseNonNegativeInt(raw) {
  const value = String(raw == null ? "" : raw).trim();
  if (!NONNEG_INT_RE.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Embed-mirror change line for a role (slash logConfigChange shape, minus
 * the live <@&id> mention markup the slash gets from Discord's role object).
 */
function roleChangeLine(roleId) {
  return `Role: <@&${roleId}> (\`${roleId}\`)`;
}

/**
 * Read + SANITIZE the command-permission OAuth env config (§8.7): the raw
 * reader also returns clientId/clientSecret — NONE of that leaves this
 * function. `missing` entries are env-variable NAMES by construction
 * (e.g. "CLIENT_SECRET"), never values.
 * @param {() => any} oauthConfigFn
 */
function readEnvConfig(oauthConfigFn) {
  try {
    const cfg = oauthConfigFn();
    return {
      available: true,
      ready: !!cfg.ready,
      redirectUri: typeof cfg.redirectUri === "string" ? cfg.redirectUri : null,
      missing: Array.isArray(cfg.missing)
        ? cfg.missing.filter((m) => typeof m === "string").map((m) => m.slice(0, 120))
        : [],
    };
  } catch {
    return { available: false, ready: false, redirectUri: null, missing: [] };
  }
}



/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (app.js passes the SAME instance the guild shell
 *   uses — one tier cache, §8.3); default builds one from the seams below.
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {(() => import("discord.js").Client|null)|null} [options.getClient]
 *   live bot client (cache-only role names + cache-only mutation preflight;
 *   null in tests/dark boot — preflight then behaves like slash, see header).
 * @param {{getStaffView: Function, getOauthStatus: Function}} [options.staffData]
 *   pre-built createStaffData() instance (tests inject counting/fake ones;
 *   default is a process-wide lazily-built singleton).
 * @param {() => any} [options.oauthConfig] env-config reader; default is
 *   the EXISTING features/commandPermissions/config.js reader.
 * @param {object} [options.db] db facade (slash parity); default src/db —
 *   methods are looked up PER CALL so injected counting proxies run as-is.
 */
function registerStaffRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  let defaultData = null;
  const getData = () => {
    if (!defaultData) defaultData = createStaffData();
    return defaultData;
  };
  const staffData = options.staffData || {
    getStaffView: (guildId) => getData().getStaffView(guildId),
    getOauthStatus: (guildId) => getData().getOauthStatus(guildId),
  };

  const oauthConfigFn =
    options.oauthConfig ||
    require("../../features/commandPermissions/config").getCommandPermissionOAuthConfig;

  // Slash-identical service layer (src/db facade): the EXACT helpers the
  // /staff role … and /leveltorole … handlers call. Resolved lazily so the
  // module never binds an older db than the one tests boot (loadDb resets
  // the require cache; registerStaffRoutes runs after that).
  const facade = options.db || require("../../db");

  // LAZY require: app.js requires THIS module while app.js itself is still
  // loading, so a top-level `require("../app")` would observe a partially
  // initialized module. registerStaffRoutes only ever runs from inside
  // createWebApp(), long after ../app's exports are complete.
  const { registerWebMutation } = require("../app");

  /**
   * Structural lockstep (subtask 24/25 mutation-gate contract): the
   * methodGate registry entry and the Express route are minted from ONE
   * call with ONE template constant — they cannot drift.
   * @param {string} template
   * @param {"staff"|"senior"|"admin"} tier
   * @param {(req: any, res: any, next: (err?: unknown) => void) => Promise<void>|void} handler
   */
  const postMutation = (template, tier, handler) => {
    registerWebMutation(app, "POST", template);
    app.post(template, requireTier(tier), handler);
  };

  /**
   * Role id + level preamble for the staff-role routes. Returns
   * { guildId, roleId, level? } or answers the 400 and returns null.
   */
  const parseStaffRoleInput = (req, res, { level: needLevel }) => {
    const guildId = req.guildAccess.guildId;
    const fields = readFields(req);
    const role = parseRoleId(fields.role_id, guildId);
    if (role.error) {
      respondMutationError(res, role.error);
      return null;
    }
    let level = null;
    if (needLevel) {
      level = parseStaffLevelInput(fields.level, facade.normalizeStaffLevel);
      if (!level) {
        respondMutationError(res, ERR_LEVEL_INVALID);
        return null;
      }
    }
    return { guildId, roleId: role.roleId, level };
  };

  // ---- staff: staff_roles table view (+ sync panel, §8.6 rows) ------------
  app.get("/g/:guildId/staff", requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const view = staffData.getStaffView(guildId);
      const document = renderShellPage(req, {
        title: "Staff roles",
        heading: "Staff roles",
        subheading:
          "Which roles the bot treats as staff (junior/senior), the level→role mappings, and the command-visibility sync state.",
        content: renderStaffBody({
          view,
          resolveRoleName: makeRoleNameResolver(options.getClient, guildId),
          envConfig: readEnvConfig(oauthConfigFn),
          guildId,
          tier: req.guildAccess.tier,
          csrfToken: req.csrfToken || null,
          // Phase-3: the panel derives the ADMIN trigger form from this
          // same render context (guildId + tier + csrf are already bound
          // for the Phase-2 forms) + reads the whitelisted PRG flash — a
          // hostile query renders nothing (§8.7).
          flash: flashFromQuery(rawFlashQuery(req.url)),
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  });

  // ---- staff: command-visibility sync status page (§8.6 row) --------------
  app.get("/g/:guildId/commands", requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      // ONE bounded read — this surface never shows the roles table.
      const view = staffData.getOauthStatus(guildId);
      const document = renderShellPage(req, {
        title: "Command visibility",
        heading: "Command visibility",
        subheading:
          "OAuth authorization + last permission-sync state for the staff-tier slash commands — read-only; the Admin trigger lives on the staff page (Phase 3).",
        content: renderCommandsBody({
          view,
          envConfig: readEnvConfig(oauthConfigFn),
          // Same whitelisted flash vocabulary as the staff page — the PRG
          // may target either surface; NO form renders here (Phase-1 pin).
          flash: flashFromQuery(rawFlashQuery(req.url)),
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Phase 2 mutations (subtask 25). EVERY route: CSRF auto-enforced on /g/
  // (middleware chain) → requireTier (§8.6 mutate tiers, slash-proven) →
  // validation → SLASH-IDENTICAL db helper → one req.audit row (fail-closed:
  // an audit throw answers the generic 500, never a silent success) → 302.
  // =========================================================================

  // ---- POST …/staff/role/add — ADMIN (slash isAdminOrMod; upsert parity:
  // re-adding an existing role updates its level, exactly like slash, and
  // the audit carries previous_level) ----------------------------------------
  postMutation(ROLE_ADD_PATH, "admin", async (req, res, next) => {
    try {
      const parsed = parseStaffRoleInput(req, res, { level: true });
      if (!parsed) return;
      const { guildId, roleId, level } = parsed;

      const probe = probeGuildRole(options.getClient, guildId, roleId);
      if (probe.verifiable && !probe.exists) {
        respondMutationError(res, ERR_ROLE_NOT_IN_GUILD);
        return;
      }

      const existing = facade.getStaffRole(guildId, roleId);
      facade.addStaffRole(guildId, roleId, level);
      req.audit({
        action: "staff.role_add",
        targetType: "role",
        targetId: roleId,
        guildId,
        details: { level, previous_level: existing ? existing.level : null },
        mirror: {
          title: existing ? "Staff role level updated" : "Staff role added",
          command: "/staff role add",
          changes: [
            roleChangeLine(roleId),
            existing
              ? `Level: **${levelLabel(existing.level)}** → **${level}**`
              : `Level: **${level}**`,
          ],
        },
      });
      respondMutationRedirect(res, guildId);
    } catch (err) {
      next(err);
    }
  });

  // ---- POST …/staff/role/remove — ADMIN (slash: audit + mirror ONLY when a
  // row was actually deleted; "not a configured staff role" answers 400 with
  // NO db write and NO audit. No existence preflight: cleaning up rows whose
  // Discord role is already deleted must stay possible.) ---------------------
  postMutation(ROLE_REMOVE_PATH, "admin", async (req, res, next) => {
    try {
      const parsed = parseStaffRoleInput(req, res, { level: false });
      if (!parsed) return;
      const { guildId, roleId } = parsed;

      const existing = facade.getStaffRole(guildId, roleId);
      const removed = facade.removeStaffRole(guildId, roleId);
      if (!removed) {
        respondMutationError(res, ERR_NOT_A_CONFIGURED_ROLE);
        return;
      }
      req.audit({
        action: "staff.role_remove",
        targetType: "role",
        targetId: roleId,
        guildId,
        details: { previous_level: existing ? existing.level : null },
        mirror: {
          title: "Staff role removed",
          command: "/staff role remove",
          changes: [roleChangeLine(roleId)],
        },
      });
      respondMutationRedirect(res, guildId);
    } catch (err) {
      next(err);
    }
  });

  // ---- POST …/staff/role/setlevel — ADMIN (slash: unknown role → "not a
  // staff role"; same level → "already X staff"; BOTH are rejections with
  // no write and no audit — mirrored exactly) --------------------------------
  postMutation(ROLE_SETLEVEL_PATH, "admin", async (req, res, next) => {
    try {
      const parsed = parseStaffRoleInput(req, res, { level: true });
      if (!parsed) return;
      const { guildId, roleId, level } = parsed;

      const probe = probeGuildRole(options.getClient, guildId, roleId);
      if (probe.verifiable && !probe.exists) {
        respondMutationError(res, ERR_ROLE_NOT_IN_GUILD);
        return;
      }

      const existing = facade.getStaffRole(guildId, roleId);
      if (!existing) {
        respondMutationError(res, ERR_NOT_A_STAFF_ROLE);
        return;
      }
      if (facade.normalizeStaffLevel(existing.level) === level) {
        respondMutationError(res, ERR_ALREADY_LEVEL(level));
        return;
      }

      facade.setStaffRoleLevel(guildId, roleId, level);
      req.audit({
        action: "staff.role_setlevel",
        targetType: "role",
        targetId: roleId,
        guildId,
        details: { previous_level: existing.level, level },
        mirror: {
          title: "Staff role level changed",
          command: "/staff role setlevel",
          changes: [
            roleChangeLine(roleId),
            `Level: **${levelLabel(existing.level)}** → **${level}**`,
          ],
        },
      });
      respondMutationRedirect(res, guildId);
    } catch (err) {
      next(err);
    }
  });

  // ---- POST …/staff/levelrole/set — STAFF (slash /leveltorole set gates on
  // isStaff, NOT admin — see the header's tier proof). Level/drop-days
  // mirror the slash IntegerOptions (required, min 0). Bot-above-role is
  // checked cache-only because syncMemberRoles GRANTS this role to members:
  // a provably unmanageable mapping is refused with sync.js's own hierarchy
  // warning instead of being silently stored. --------------------------------
  postMutation(LEVELROLE_SET_PATH, "staff", async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const fields = readFields(req);
      const role = parseRoleId(fields.role_id, guildId);
      if (role.error) {
        respondMutationError(res, role.error);
        return;
      }
      const level = parseNonNegativeInt(fields.level);
      const dropDays = parseNonNegativeInt(fields.drop_days);
      if (level === null || dropDays === null) {
        respondMutationError(res, ERR_NUMBER_INVALID);
        return;
      }

      const probe = probeGuildRole(options.getClient, guildId, role.roleId);
      if (probe.verifiable && !probe.exists) {
        respondMutationError(res, ERR_ROLE_NOT_IN_GUILD);
        return;
      }
      if (probe.botBelow === true) {
        respondMutationError(res, ERR_BOT_BELOW_ROLE);
        return;
      }

      facade.upsertLevelRole(
        guildId,
        role.roleId,
        Math.max(0, level),
        Math.max(0, dropDays)
      );
      req.audit({
        action: "level_roles.set",
        targetType: "role",
        targetId: role.roleId,
        guildId,
        details: { level_required: level, drop_grace_days: dropDays },
        mirror: {
          title: "Level→role mapping set",
          command: "/leveltorole set",
          changes: [
            roleChangeLine(role.roleId),
            `Level required: **${level}**`,
            `Drop grace: **${dropDays}** day(s)`,
          ],
        },
      });
      respondMutationRedirect(res, guildId);
    } catch (err) {
      next(err);
    }
  });

  // ---- POST …/staff/levelrole/remove — STAFF (slash /leveltorole remove
  // deletes UNCONDITIONALLY (also clearing role_drop_state) and audits
  // unconditionally — the web mirrors that exactly, including removing a
  // mapping for a role Discord has already deleted; no preflight applies.) --
  postMutation(LEVELROLE_REMOVE_PATH, "staff", async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const role = parseRoleId(readFields(req).role_id, guildId);
      if (role.error) {
        respondMutationError(res, role.error);
        return;
      }

      facade.deleteLevelRole(guildId, role.roleId);
      req.audit({
        action: "level_roles.remove",
        targetType: "role",
        targetId: role.roleId,
        guildId,
        mirror: {
          title: "Level→role mapping removed",
          command: "/leveltorole remove",
          changes: [roleChangeLine(role.roleId)],
        },
      });
      respondMutationRedirect(res, guildId);
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  registerStaffRoutes,
  // Env-config probe (consumed by routes/system.js + web-routes-staff.test.js)
  readEnvConfig,
};
