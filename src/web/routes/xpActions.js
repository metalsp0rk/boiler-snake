/**
 * POST /g/:guildId/xp/grant + GET form page — the Phase-3 XP GRANT action
 * (roadmap/web-admin.md §8.6 "XP" row: grant xp = ADMIN mutate; §8.8 Phase 3;
 * subtask 28). This is the ONLY web mutation that awards XP, and it exists to
 * do one thing: reach the SAME service the slash command reaches.
 *
 * SERVICE PARITY (the whole point — src/features/xp/index.js handleGrantXp,
 * lines 421–492, mirrors exactly):
 *  - awardXp(client, { guild, userId, delta, activityKind: "admin_grant",
 *    levelXpFactor: settings.level_xp_factor, source: "admin_grant" }) — the
 *    unified XP award + activity log + level→role sync + channel-audit path
 *    (src/services/awardXp.js). NO re-implementation, NO direct SQL, NO
 *    addXp/setXp/updateGuildSettings call from this route (the XP write is the
 *    service's; the Phase-2 gate proxy proves it).
 *  - Validation mirrors /grantxp: amount is a whole number in 1…MAX_XP_AWARD
 *    (slash IntegerOption min:1 max:MAX_XP_AWARD + validateXpValue + the
 *    explicit `amount < 1` guard); reason optional ≤ 200 chars (slash
 *    setMaxLength(200)), trimmed, empty → null; bots are refused (slash:
 *    "You can't grant XP to bots.").
 *  - UNKNOWN USER (valid snowflake, no users row): the SLASH does NOT require
 *    an existing row — db.addXp auto-creates it via ensureUser, and a member
 *    resolution miss only skips role sync (awardXp returns level/changes
 *    null). The web mirrors that decision exactly: grant succeeds, row is
 *    auto-created, no membership/row pre-check.
 *
 * TIER: requireTier("admin"). Slash evidence: /grantxp runs
 * `requireAdmin(interaction)` (ManageGuild, src/core/permissions.js) and is
 * listed ManageGuild-ONLY in AGENTS.md §4 — the web tier ladder
 * (staff < senior < admin) resolves "admin" to exactly that gate. guildScope
 * (routes/guildShell.js, mounted earlier in app.js) already answered anon ⇒
 * 302 login and cross-guild/stranger ⇒ generic 404 (never 403, §8.6).
 *
 * DISCORD-SIDE NICETIES = CACHE-ONLY SEAM, NEVER A FETCH. The route reads
 * `getClient()` caches only: (a) the bot check reads the guild member cache /
 * user cache — an UNKNOWN cached state cannot claim "bot", so the grant
 * proceeds (same outcome as slash for a non-bot pick; a provable bot is
 * refused); (b) the guild handed to awardXp is a CACHE-ONLY wrapper whose
 * `members.fetch` resolves from `guild.members.cache` or null — the service
 * code path is identical to slash, but a web request never hits the Discord
 * API. A member that is NOT in the bot's cache degrades exactly like slash's
 * member-fetch-failure path (XP + activity recorded, role sync skipped,
 * honest flash wording), never silently claiming role work.
 *
 * AUDIT (§8.6, DB-first fail-closed via req.audit, origin defaults 'web'):
 * ONE admin_audit row reusing the EXACT slash vocabulary + detail shape —
 * xp.grant / target user / details { amount, before_xp, after_xp, reason }
 * (features/xp/index.js:460–471) — plus the best-effort channel-embed
 * MIRROR with the slash logConfigChange's title/command/lines (§8.1-7; plain
 * numbers instead of toLocaleString so no server locale can vary the mirror).
 * Rejections write NOTHING; an audit insert failure aborts with the generic
 * 500 (fail-closed — the grant outcome is never silently claimed).
 *
 * MUTATION CONTRACT (Phase-2 doctrine): the methodGate registry entry and
 * the Express route are minted from ONE path constant via postMutation
 * (registerWebMutation + app.post + requireTier lockstep — they cannot
 * drift). CSRF is auto-enforced on every /g/ POST (middleware/csrf.js); the
 * GET form embeds the hidden _csrf from req.csrfToken. Body fields arrive
 * pre-parsed on req.bodyFields (body-cap consumed the stream — no express
 * parsers on top). PRG: success ⇒ 302 to THIS page with `?done=<slug>`,
 * validation refusal ⇒ 302 `?error=<slug>` — slugs are frozen constants
 * re-checked against the view's whitelists before the Location is minted;
 * NO submitted value is ever echoed into a redirect (§8.7).
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const {
  renderGrantForm,
  flashFromQuery,
  FLASH_DONE,
  FLASH_ERROR,
} = require("../views/xpActions");
const { USER_ID_RE } = require("../data/leaderboard");
const { validateXpValue, levelFromXp, MAX_XP_AWARD } = require("../../core/xpMath");

/** Grant surface (GET form + POST mutation share the exact template). */
const GRANT_PATH = "/g/:guildId/xp/grant";

/** Whole numbers ≤ 10 digits (JS-safe; bounds checked against [1, 1e9]). */
const AMOUNT_RE = /^(0|[1-9][0-9]{0,9})$/;

/** Slash setMaxLength(200) on the reason option. */
const REASON_MAX_LEN = 200;

/**
 * Parse + validate one grant submission into the slash-equivalent inputs.
 * Pure function (validate-at-boundary): returns { userId, amount, reason }
 * or { errorSlug } — a slug from the view's frozen FLASH_ERROR vocabulary,
 * never free text, never an echo.
 *
 * Bounds provenance (slash /grantxp, features/xp/index.js):
 *  - user: required snowflake (Discord's picker can only ever supply one);
 *    a user id EQUAL to the guild id is @everyone-shaped, impossible for the
 *    picker, refused as invalid_user.
 *  - amount: IntegerOption 1…MAX_XP_AWARD + validateXpValue(value, "Grant")
 *    + explicit `amount < 1` guard → everything outside collapses to
 *    invalid_amount (fixed message covers the full range, no per-value echo).
 *  - reason: optional string, trimmed, ≤ 200 chars → "" becomes null
 *    (slash: `reason?.trim() ? reason.trim() : null`).
 *
 * @param {Record<string, unknown>} fields req.bodyFields
 * @param {string} guildId server-derived (guildScope snowflake)
 * @returns {{ ok: true, userId: string, amount: number, reason: string|null }
 *          | { ok: false, errorSlug: string }}
 */
function parseGrantInput(fields, guildId) {
  const rawUser = String(fields.user_id == null ? "" : fields.user_id).trim();
  if (!USER_ID_RE.test(rawUser) || rawUser === String(guildId)) {
    return { ok: false, errorSlug: "invalid_user" };
  }

  const rawAmount = String(fields.amount == null ? "" : fields.amount).trim();
  if (!AMOUNT_RE.test(rawAmount)) {
    return { ok: false, errorSlug: "invalid_amount" };
  }
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount) || validateXpValue(amount, "Grant")) {
    return { ok: false, errorSlug: "invalid_amount" };
  }
  if (amount < 1 || amount > MAX_XP_AWARD) {
    return { ok: false, errorSlug: "invalid_amount" };
  }

  const reason = String(fields.reason == null ? "" : fields.reason).trim();
  if (reason.length > REASON_MAX_LEN) {
    return { ok: false, errorSlug: "reason_too_long" };
  }

  return { ok: true, userId: rawUser, amount, reason: reason || null };
}

/**
 * Cache-only bot probe (slash parity: `if (target.bot)` refusal). Reads the
 * bot's caches ONLY — guild member cache, then global user cache — and only
 * ever REFUSES on PROVEN bot status. An unanswerable cache (client unbound,
 * user unknown) makes no claim and lets the grant through: exactly slash's
 * outcome for a human pick, and the orchestrator-mandated "cache-only seam,
 * graceful skip — never fetch" for the rest.
 * @param {any} client resolved client or null
 * @param {string} guildId
 * @param {string} userId
 * @returns {boolean} true ONLY when a cache proves the target is a bot
 */
function isProvenBot(client, guildId, userId) {
  try {
    const guild = client?.guilds?.cache?.get?.(guildId) ?? null;
    const member = guild?.members?.cache?.get?.(userId) ?? null;
    const memberBot = member?.user?.bot === true || member?.bot === true;
    if (memberBot) return true;
    const cachedUser = client?.users?.cache?.get?.(userId) ?? null;
    return cachedUser?.bot === true;
  } catch {
    return false; // a broken cache object can never PROVE a bot
  }
}

/**
 * Cache-ONLY guild seam handed to awardXp. The service's own member
 * resolution (`guild.members.fetch(userId).catch(() => null)`) runs
 * UNCHANGED, but resolves from `members.cache` or null — a web request never
 * touches the Discord API. A cache miss degrades exactly like slash's
 * member-fetch failure: XP + activity still recorded, role sync skipped,
 * `level`/`changes` null (features/xp/index.js:457 falls back to levelFromXp
 * for display; the web flash is slug-only so nothing needs the fallback).
 * With no client / uncached guild (dark boot) the shim behaves like the same
 * slash member-miss path instead of pretending role work happened.
 * @param {any} client resolved client or null
 * @param {string} guildId
 */
function makeCacheOnlyGuild(client, guildId) {
  let live = null;
  try {
    live = client?.guilds?.cache?.get?.(guildId) ?? null;
  } catch {
    live = null;
  }
  if (!live || typeof live !== "object") {
    return { id: guildId, members: { fetch: async () => null } };
  }
  return {
    id: live.id || guildId,
    members: {
      fetch: async (userId) => {
        try {
          return live.members?.cache?.get?.(userId) ?? null;
        } catch {
          return null;
        }
      },
    },
  };
}

/** Parsed urlencoded fields (bodyCap/CSRF contract — no express parsers). */
function readFields(req) {
  const src = req?.bodyFields;
  return src && typeof src === "object" ? src : {};
}

/**
 * PRG 302 to the grant page with a WHITELISTED flash slug. Both the flag and
 * the slug are re-checked against the view's frozen vocabularies before the
 * Location is minted (settings.js redirectSettings doctrine): a bug at a
 * call site can still never reflect input into a redirect (§8.7).
 * @param {import("http").ServerResponse} res
 * @param {string} guildId server-derived (guildScope snowflake)
 * @param {"done"|"error"} flag
 * @param {string} slug
 */
function respondGrantRedirect(res, guildId, flag, slug) {
  const safeFlag = flag === "done" ? "done" : "error";
  const table = safeFlag === "done" ? FLASH_DONE : FLASH_ERROR;
  const safeSlug = typeof slug === "string" && table[slug] ? slug : Object.keys(table)[0];
  res.writeHead(302, {
    Location: `/g/${encodeURIComponent(guildId)}/xp/grant?${safeFlag}=${safeSlug}`,
    "Cache-Control": "no-store",
  });
  res.end();
}

/** Shared switcher list (same contract as routes/staff.js shellGuilds). */
async function shellGuilds(resolver, req) {
  const listed = await resolver.listGuilds(req.webSession);
  const guilds = listed.guilds.slice();
  const currentId = req.guildAccess.guildId;
  if (!guilds.some((g) => g.id === currentId)) {
    guilds.unshift({ id: currentId, name: currentId });
  }
  return guilds;
}

/**
 * Raw-url flash read (app doctrine: never req.query — the Express 5 "simple"
 * parser and path-to-regexp decoding must not decide behavior here).
 * @param {string} rawUrl
 */
function rawFlashQuery(rawUrl) {
  const idx = String(rawUrl || "").indexOf("?");
  const params = new URLSearchParams(idx === -1 ? "" : String(rawUrl).slice(idx + 1));
  return { done: params.get("done"), error: params.get("error") };
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (app.js passes the SAME instance the guild shell uses
 *   — one tier cache, §8.3); default builds one from the seams below.
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {(() => import("discord.js").Client|null)|null} [options.getClient]
 *   live bot client — cache-only bot probe + cache-only guild seam (null in
 *   tests/dark boot → slash member-miss-equivalent behavior, see header).
 * @param {object} [options.db] db facade (slash parity reads: getGuildSettings
 *   / getXp); default src/db — resolved at registration time, so the
 *   loadDb require-cache reset in tests binds the fresh connection first.
 * @param {{awardXp: Function}} [options.services] service-layer override for
 *   tests (call-through spies); production omits it and the REAL
 *   src/services/awardXp module is resolved lazily PER CALL — so the
 *   Phase-2 gate's facade recorder (installed before the first POST) is what
 *   the service itself binds.
 */
function registerXpActionsRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  // Slash-identical service layer. Resolved lazily so the module never binds
  // an older db than the one tests boot (loadDb resets the require cache;
  // registerXpActionsRoutes runs after that — same doctrine as routes/staff.js).
  const facade = options.db || require("../../db");

  const awardXp =
    options.services?.awardXp ||
    // Lazy require (per call): keeps the service binding to the CURRENT src/db
    // facade (the gate recorder wraps the module object before the first
    // POST) and never couples route load order to feature load order.
    ((...args) => require("../../services/awardXp").awardXp(...args));

  // LAZY require: app.js requires THIS module while app.js itself is still
  // loading, so a top-level `require("../app")` would observe a partially
  // initialized module. registerXpActionsRoutes only ever runs from inside
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

  // ---- admin: grant-XP form page (§8.6 XP row — the mutate surface is
  // ADMIN-only end to end, so staff/senior never even see a form that 403s) --
  app.get(GRANT_PATH, requireTier("admin"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const document = renderShellPage(req, {
        title: "Grant XP",
        heading: "Grant XP",
        subheading:
          "Admin-only XP grant — the same award pipeline as slash /grantxp.",
        content: renderGrantForm({
          guildId,
          csrfToken: req.csrfToken || null,
          flash: flashFromQuery(rawFlashQuery(req.url)),
          maxAward: MAX_XP_AWARD,
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  });

  // =========================================================================
  // Phase 3 mutation (subtask 28). Route choreography: CSRF (auto, /g/) →
  // requireTier("admin") → validation (slash bounds) → cache-only bot probe →
  // awardXp service (slash-identical args) → ONE req.audit row (fail-closed)
  // → 302 PRG with a whitelisted slug.
  // =========================================================================
  postMutation(GRANT_PATH, async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const parsed = parseGrantInput(readFields(req), guildId);
      if (!parsed.ok) {
        respondGrantRedirect(res, guildId, "error", parsed.errorSlug);
        return;
      }
      const { userId, amount, reason } = parsed;

      // Client reads are CACHE-ONLY (never a network fetch on a request path).
      let client = null;
      try {
        client = typeof options.getClient === "function" ? options.getClient() : null;
      } catch {
        client = null;
      }

      // Slash parity: `if (target.bot)` refusal — refusal only on PROVEN bot.
      if (isProvenBot(client, guildId, userId)) {
        respondGrantRedirect(res, guildId, "error", "bot_target");
        return;
      }

      // Slash-identical read-then-award (features/xp/index.js:444–455).
      const settings = facade.getGuildSettings(guildId);
      const beforeXp = facade.getXp(guildId, userId);

      const { newXp, level } = await awardXp(client, {
        guild: makeCacheOnlyGuild(client, guildId),
        userId,
        delta: amount,
        activityKind: "admin_grant",
        levelXpFactor: settings.level_xp_factor,
        source: "admin_grant",
      });

      // Audit mirror of the slash recordSlashAudit call EXACTLY — action,
      // target, and detail shape (origin stays the 'web' default, §8.6).
      const levelText =
        level != null ? String(level) : String(levelFromXp(newXp, settings.level_xp_factor));
      req.audit({
        action: "xp.grant",
        targetType: "user",
        targetId: userId,
        guildId,
        details: { amount, before_xp: beforeXp, after_xp: newXp, reason },
        // Same title/command/lines the slash logConfigChange posts (plain
        // numbers — no locale-dependent formatting in a machine-facing mirror).
        mirror: {
          title: "XP granted",
          command: "/grantxp",
          changes: [
            `Target: <@${userId}> (\`${userId}\`)`,
            `Amount: **+${amount}** XP`,
            `XP: **${beforeXp}** → **${newXp}**`,
            `Level: **${levelText}**`,
            reason ? `Reason: ${reason}` : null,
          ].filter(Boolean),
        },
      });

      respondGrantRedirect(res, guildId, "done", "xp_granted");
    } catch (err) {
      next(err); // fail-closed: an audit throw aborts with the generic 500
    }
  });
}

module.exports = {
  registerXpActionsRoutes,
};
