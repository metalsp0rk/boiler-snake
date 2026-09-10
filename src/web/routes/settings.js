/**
 * GET /g/:guildId/settings — the guild settings view (Phase 1 read view,
 * subtask 18) + the Phase 2 config mutations (subtask 24).
 * roadmap/web-admin.md §8.6 "Settings: guild settings, command channels,
 * logs channels, cooldowns, decay | Staff | per-setting tier
 * (/setcommandchannel = Admin) | 1 view · 2 write".
 *
 * MUTATIONS (Phase 2, POST-redirect-GET):
 *   POST /g/:guildId/settings/xp                      staff   (=/setxp,
 *        incl. cooldowns + level curve factor — the /setxp field set)
 *   POST /g/:guildId/settings/decay                   staff   (=/setdecay)
 *   POST /g/:guildId/settings/logs                    staff   (=/setlog audit|message)
 *   POST /g/:guildId/settings/warn-log                staff   (=/setwarn log)
 *   POST /g/:guildId/settings/command-channels/add    ADMIN   (=/setcommandchannel add)
 *   POST /g/:guildId/settings/command-channels/remove ADMIN  (=/setcommandchannel remove)
 *
 * Every mutation follows the §8.6 cross-cutting contract:
 *  - methodGate: registerWebMutation(app, "POST", T) AND app.post(T, …) in
 *    LOCKSTEP (same literal template — the gate byte-405s anything else,
 *    which the suites pin; app.js mounts this file via createWebApp, so the
 *    lazy require("../app") inside registerSettingsRoutes is cycle-safe);
 *  - CSRF: app-level createCsrfMiddleware auto-enforces _csrf / X-CSRF-Token
 *    on every /g/ mutation (forms embed req.csrfToken — nothing per-route);
 *  - tier: guildScope already published req.guildAccess (anon ⇒ 302,
 *    stranger/cross-guild ⇒ generic 404, §8.6 never-403); requireTier
 *    enforces staff|admin per route (wrong-tier same guild ⇒ 403);
 *  - body: req.bodyFields drained by createBodyCapMiddleware (NO
 *    express.json/urlencoded here — the stream is already consumed);
 *  - service layer: data/settingsWrite.js ONLY (same facade helpers + bounds
 *    as the slash handlers) — zero SQL in this file (code-review check);
 *  - audit: one req.audit per SUCCESSFUL mutation (origin 'web' default,
 *    slash action strings EXACTLY: xp.settings_update, decay.settings_update,
 *    logs.channel_set / logs.channel_clear, warnings.log_channel_set /
 *    warnings.log_channel_clear, command_channels.add / .remove) — DB-first
 *    fail-closed: a throw from req.audit becomes a generic 500;
 *  - cache: settingsData.invalidate(guildId) after every accepted write so
 *    the view (≥30 s cache) goes straight back to the source of truth;
 *  - response: 302 → /g/<guildId>/settings?ok|err=<cluster> — the keys are
 *    fixed constants (no user data ever reflected into the Location).
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { renderSettingsBody } = require("../views/settings");
const { createSettingsData } = require("../data/settingsData");
const settingsWrite = require("../data/settingsWrite");
const { diffConfigLines } = require("../../features/logs/auditLog");
const { shellGuilds } = require("./shared/shell.js");
const { makeCacheNameResolver } = require("./shared/discord-cache.js");



/** Whitelisted flash keys (rendered as fixed banners — never free text). */
const FLASH_KEYS = new Set(["xp", "decay", "logs", "warn", "channels"]);

/**
 * 302 back to the settings page with a whitelisted result flag. Both the
 * flag and the key are code constants — nothing user-supplied is ever
 * reflected into the Location header (§8.7 generic bodies).
 * @param {import("http").ServerResponse} res
 * @param {string} guildId server-derived (guildScope snowflake)
 * @param {"ok"|"err"} flag
 * @param {string} key one of FLASH_KEYS
 */
function redirectSettings(res, guildId, flag, key) {
  if (flag !== "ok" && flag !== "err") flag = "err";
  if (!FLASH_KEYS.has(key)) key = "logs";
  res.writeHead(302, {
    Location: `/g/${guildId}/settings?${flag}=${key}`,
    "Cache-Control": "no-store",
  });
  res.end();
}

/**
 * Build one mutation handler. The shared choreography (fields → service op
 * → cache invalidate → req.audit → 302) lives here; per-cluster logic is
 * just the `op` + `auditOf` pair below (validation errors NEVER reach
 * updateGuildSettings — settingsWrite validates before touching the facade).
 *
 * @param {object} spec
 * @param {(db: object, guildId: string, fields: Record<string,string>) => object} spec.op
 * @param {string} spec.key flash key
 * @param {(outcome: object, guildId: string) => object} spec.auditOf entry for req.audit
 * @param {object} deps { db, settingsData }
 */
function makeMutationHandler(spec, deps) {
  return async function settingsMutation(req, res, next) {
    try {
      const guildId = req.guildAccess.guildId;
      const fields = settingsWrite.readFormFields(req);
      const outcome = spec.op(deps.db, guildId, fields);
      if (!outcome.ok) {
        // Validation rejection: nothing written, NOTHING audited (§8.6).
        redirectSettings(res, guildId, "err", spec.key);
        return;
      }
      // Accepted write: drop the cached snapshot FIRST so even a fail-closed
      // audit 500 leaves the next GET reading fresh truth (never stale).
      deps.settingsData.invalidate?.(guildId);
      // Fail-closed (§8.1-7): a throwing req.audit propagates → generic 500.
      req.audit(spec.auditOf(outcome, guildId));
      redirectSettings(res, guildId, "ok", spec.key);
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  };
}

// ---------------------------------------------------------------------------
// Mirror change-lines — copied from the slash handlers these mirror so the
// channel-embed path (req.audit's best-effort mirror) says exactly what
// /setxp / /setdecay / /setlog / /setwarn log / /setcommandchannel post.
// ---------------------------------------------------------------------------

/** XP cluster lines (slash: diffConfigLines(before, updated, keys)). */
function xpChangeLines(outcome) {
  return diffConfigLines(outcome.before, outcome.after, Object.keys(outcome.patch));
}

/** Decay lines (slash's percent/enabled-aware formatter, verbatim shape). */
function decayChangeLines(outcome) {
  const { before, after, patch } = outcome;
  return diffConfigLines(before, after, Object.keys(patch)).map((line) => {
    if (line.includes("decay_percent")) {
      const pctBefore = Math.round((Number(before.decay_percent) || 0) * 100);
      const pctAfter = Math.round((Number(after.decay_percent) || 0) * 100);
      return `\`decay_percent\`: ${pctBefore}% → **${pctAfter}%**`;
    }
    if (line.includes("decay_enabled")) {
      return `\`decay_enabled\`: ${!!before.decay_enabled} → **${!!after.decay_enabled}**`;
    }
    return line;
  });
}

const LOG_STREAM_LABELS = Object.freeze({ audit: "Audit log", message: "Message log" });

// ---------------------------------------------------------------------------
// Cluster specs (path ↔ tier ↔ op ↔ audit entry in ONE table — the method
// gate registration and the app.post mount read the same literal template
// from here, so they can never drift apart).
// ---------------------------------------------------------------------------

/**
 * @param {object} deps { db, settingsData }
 * @returns {Array<{path: string, tier: string, key: string, op: Function, handler: Function}>}
 */
function buildMutationSpecs(deps) {
  const specs = [
    {
      path: "/g/:guildId/settings/xp",
      tier: "staff",
      key: "xp",
      op: settingsWrite.saveXpSettings,
      auditOf: (outcome, guildId) => ({
        action: "xp.settings_update",
        targetType: "guild",
        targetId: guildId,
        details: { patch: outcome.patch },
        mirror: (() => {
          const changes = xpChangeLines(outcome);
          // Slash only posts the embed when something actually changed.
          if (!changes.length) return undefined;
          return { kind: "audit", title: "XP settings updated", command: "/setxp", changes };
        })(),
      }),
    },
    {
      path: "/g/:guildId/settings/decay",
      tier: "staff",
      key: "decay",
      op: settingsWrite.saveDecaySettings,
      auditOf: (outcome, guildId) => ({
        action: "decay.settings_update",
        targetType: "guild",
        targetId: guildId,
        details: { patch: outcome.patch },
        mirror: (() => {
          const changes = decayChangeLines(outcome);
          if (!changes.length) return undefined;
          return { kind: "audit", title: "Decay settings updated", command: "/setdecay", changes };
        })(),
      }),
    },
    {
      path: "/g/:guildId/settings/logs",
      tier: "staff",
      key: "logs",
      op: settingsWrite.saveLogChannel,
      auditOf: (outcome, guildId) => {
        const label = LOG_STREAM_LABELS[outcome.stream] || "Log";
        if (outcome.channelId == null) {
          return {
            action: "logs.channel_clear",
            targetType: "guild",
            targetId: guildId,
            details: { stream: outcome.stream, previous_channel_id: outcome.previous },
            mirror: {
              kind: "audit",
              title: `${label} channel cleared`,
              command: `/setlog ${outcome.stream}`,
              changes: [
                outcome.previous
                  ? `${label}: <#${outcome.previous}> → *none*`
                  : `${label}: was already unset`,
              ],
            },
          };
        }
        return {
          action: "logs.channel_set",
          targetType: "channel",
          targetId: outcome.channelId,
          details: { stream: outcome.stream, previous_channel_id: outcome.previous },
          mirror: {
            kind: "audit",
            title: `${label} channel set`,
            command: `/setlog ${outcome.stream}`,
            changes: [
              outcome.previous
                ? `${label}: <#${outcome.previous}> → <#${outcome.channelId}>`
                : `${label}: *none* → <#${outcome.channelId}>`,
            ],
          },
        };
      },
    },
    {
      path: "/g/:guildId/settings/warn-log",
      tier: "staff",
      key: "warn",
      op: settingsWrite.saveWarnLogChannel,
      auditOf: (outcome, guildId) =>
        outcome.channelId == null
          ? {
              action: "warnings.log_channel_clear",
              targetType: "guild",
              targetId: guildId,
              details: { previous_channel_id: outcome.previous },
              mirror: {
                kind: "audit",
                title: "Warning log channel cleared",
                command: "/setwarn log",
                changes: [
                  outcome.previous
                    ? `Warn log: <#${outcome.previous}> → *none* (fallback to audit log)`
                    : "Warn log: was already unset",
                ],
              },
            }
          : {
              action: "warnings.log_channel_set",
              targetType: "channel",
              targetId: outcome.channelId,
              details: { previous_channel_id: outcome.previous, channel_id: outcome.channelId },
              mirror: {
                kind: "audit",
                title: "Warning log channel set",
                command: "/setwarn log",
                changes: [
                  outcome.previous
                    ? `Warn log: <#${outcome.previous}> → <#${outcome.channelId}>`
                    : `Warn log: *none* → <#${outcome.channelId}>`,
                ],
              },
            },
    },
    {
      path: "/g/:guildId/settings/command-channels/add",
      tier: "admin",
      key: "channels",
      op: settingsWrite.addCommandChannel,
      auditOf: (outcome) => ({
        action: "command_channels.add",
        targetType: "channel",
        targetId: outcome.channelId,
        details: { channel_id: outcome.channelId },
        mirror: {
          kind: "audit",
          title: "Command channel allowed",
          command: "/setcommandchannel add",
          changes: [`Channel: <#${outcome.channelId}> (\`${outcome.channelId}\`)`],
        },
      }),
    },
    {
      path: "/g/:guildId/settings/command-channels/remove",
      tier: "admin",
      key: "channels",
      op: settingsWrite.removeCommandChannel,
      auditOf: (outcome) => ({
        action: "command_channels.remove",
        targetType: "channel",
        targetId: outcome.channelId,
        details: { channel_id: outcome.channelId },
        mirror: {
          kind: "audit",
          title: "Command channel restriction removed",
          command: "/setcommandchannel remove",
          changes: [`Channel: <#${outcome.channelId}> (\`${outcome.channelId}\`)`],
        },
      }),
    },
  ];

  for (const spec of specs) spec.handler = makeMutationHandler(spec, deps);
  return specs;
}

/**
 * Read the whitelisted flash flag from the RAW url (never req.query — the
 * src/web/app.js parsing doctrine). Unknown/absent ⇒ no banner; nothing is
 * ever reflected, only fixed per-key strings are looked up in the view.
 * @param {import("http").IncomingMessage & { url?: string }} req
 */
function readFlashFlag(req) {
  try {
    const search = new URL(String(req.url || "/"), "http://settings.local").searchParams;
    for (const flag of ["err", "ok"]) {
      const value = search.get(flag);
      if (typeof value === "string" && FLASH_KEYS.has(value)) {
        return flag === "err" ? { kind: "error", key: value } : { kind: "info", key: value };
      }
    }
  } catch {
    /* malformed url — simply no banner */
  }
  return null;
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
 *   live bot client (cache-only channel names; null in tests/dark boot).
 * @param {{getSettings: Function, invalidate?: Function}} [options.settingsData]
 *   pre-built createSettingsData() instance (tests inject counting/fake
 *   ones; default is a process-wide lazily-built singleton). Mutations call
 *   invalidate(guildId) after every accepted write.
 * @param {object} [options.db] src/db facade override (tests); default is
 *   the shared facade — methods resolve at CALL time so spies still run.
 */
function registerSettingsRoutes(app, options = {}) {
  // app.js (which requires THIS module at top level) owns the mutation
  // registry; requiring it at THIS module's top level would deadlock the
  // CommonJS cycle, so the getter resolves it lazily at mount time — by
  // then app.js is fully loaded and the cache hit is the whole cost.
  const { registerWebMutation } = require("../app");

  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  let defaultData = null;
  const getData = () => {
    if (!defaultData) defaultData = createSettingsData();
    return defaultData;
  };
  const settingsData = options.settingsData || {
    getSettings: (guildId) => getData().getSettings(guildId),
    invalidate: (guildId) => getData().invalidate(guildId),
  };

  const deps = { db: options.db || require("../../db"), settingsData };

  app.get("/g/:guildId/settings", requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      // One cached per-guild snapshot (§8.6 floor 30 s). Facade reads happen
      // inside the data module — never here.
      const snapshot = settingsData.getSettings(guildId);
      const document = renderShellPage(req, {
        title: "Settings",
        heading: "Settings",
        subheading:
          "Current guild configuration — values, defaults, and the slash command that owns each. Every form below mirrors one slash command at the same tier.",
        content: renderSettingsBody({
          snapshot,
          resolveChannelName: makeCacheNameResolver(options.getClient, "channels"),
          csrfToken: req.csrfToken || null,
          guildId,
          flash: readFlashFlag(req),
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  });

  // Phase 2 writes (§8.6): methodGate registration + mount in LOCKSTEP on
  // the SAME literal template — a drift here would 405 the route's own
  // traffic, and the subtask suites pin both halves.
  for (const spec of buildMutationSpecs(deps)) {
    registerWebMutation(app, "POST", spec.path);
    app.post(spec.path, requireTier(spec.tier), spec.handler);
  }
}

module.exports = {
  registerSettingsRoutes,
};
