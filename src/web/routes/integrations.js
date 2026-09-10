/**
 * GET + POST /g/:guildId/integrations — the Phase 1 read view (subtask 20)
 * extended with the Phase 2 config mutations (subtask 26; roadmap
 * web-admin.md §8.6 "Integrations: YouTube, Twitch, reaction roles, event
 * reminders, honeypot | Staff | per-command tier (/honeypot exempt = Admin)").
 *
 * MUTATION CONTRACT (identical discipline to subtask 23's gate + subtask 24):
 *  - every POST path is registered via registerWebMutation(app, "POST", path)
 *    in LOCKSTEP with app.post(path, requireTier(tier), handler) — the
 *    app-wide methodGate 405s every unregistered verb/path byte-identically
 *    (../app is required lazily: app.js requires THIS module, so a top-level
 *    require would be a load-order cycle);
 *  - CSRF is automatic for every /g/ mutation (middleware/csrf.js): forms
 *    carry the hidden `_csrf` field, htmx sends X-CSRF-Token;
 *  - tier via requireTier on req.guildAccess (guildScope already 404s wrong
 *    guilds — cross-guild is a 404 long before the tier gate runs):
 *      staff  → every config mutation EXCEPT the honeypot exempt pair
 *      admin  → /honeypot/exempt/add|del (AGENTS.md §4: /honeypot exempt is
 *               ManageGuild-only; mirrors isAdminOrMod on the slash path)
 *  - POST-REDIRECT-GET: success ⇒ 302 /g/:id/integrations?done=<slug>,
 *    validation reject ⇒ 302 ?error=<slug> (slugs are whitelisted view
 *    constants — the query value is NEVER echoed, only looked up);
 *  - one admin_audit row per successful mutation via req.audit (DB-first,
 *    origin 'web', fail-closed 500 on insert failure) with the EXACT action
 *    strings the slash path records (src/core/auditTrail.js vocabulary).
 *
 * SERVICE PARITY: every write goes through the SAME db-facade helpers +
 * validation the slash handlers use (youtube/twitch/reactionRoles/
 * eventReminders/honeypot features) — no SQL in this file, no new repo SQL.
 * Where the slash gets a guaranteed-real channel/role object from the
 * Discord picker, the web form accepts a snowflake and preflights it
 * against the CACHE-ONLY client seam (guildScope doctrine): when the bot
 * guild is cached, missing/managed/foreign entities are rejected with the
 * slash's own wording; with no client bound (dark boot) the existence
 * preflight degrades to "plausible snowflake" (documented deviation — the
 * slash is unreachable when the bot is down, the console is not).
 *
 * ENV GATES (§8.7, names only — values NEVER read, rendered, or logged):
 *  - twitch add     → slash parity: refuses when TWITCH_CLIENT_ID/SECRET are
 *                     absent (slash's own message, rendered from a fixed slug);
 *  - youtube add    → refuses with "not configured: YOUTUBE_API_KEY"
 *                     (DEViation from slash, which silently stores an
 *                     unresolved @username row; the web console refuses to
 *                     create a subscription it knows cannot resolve);
 *  - config writes (notify channels, intervals, roles, setchannel) are NOT
 *    env-gated — exactly like /setyoutube, /settwitch and
 *    /eventreminder setchannel on the slash path.
 *
 * EVENT-CREATOR AXIS (deliberate v1 restriction, §8.6 "web writes stay
 * staff-gated"): /eventreminder create|edit|clear|sync also accept the
 * event CREATOR on slash (no ManageGuild). The web console has no
 * per-resource creator notion, so creator-without-staff users get no web
 * path — event-reminder mutation here is setchannel only, staff tier.
 *
 * Honeypot EXEMPT writes mutate staff_roles via the facade's EXISTING
 * addStaffRole/removeStaffRole aliases (same helpers the slash exempt group
 * and /staff role add use) — no staffRoles.js edit, no collision with the
 * staff-role page work; the audit reuses the slash's vocabulary
 * (staff.role_add / staff.role_remove with details.via "honeypot.exempt").
 *
 * userActivity CONFIG stays slash-only (§8.9) — no activity endpoints here.
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const {
  renderIntegrationsBody,
  flashFromQuery,
  FLASH_DONE,
  FLASH_ERROR,
} = require("../views/integrations");
const { createIntegrationsData } = require("../data/integrationsData");

// Slash-parity service surfaces (the same imports the feature handlers use).
const db = require("../../db");
const youtubeFeature = require("../../features/youtube");
const { resolveTwitchUser: defaultResolveTwitchUser } = require("../../features/twitch/helix");
const reactionRolesService = require("../../features/reactionRoles/service");
const honeypotFeature = require("../../features/honeypot");
const { shellGuilds } = require("./shared/shell.js");
const { makeCacheNameResolver } = require("./shared/discord-cache.js");
const { makeFlashRedirect } = require("./shared/flash.js");
const {
  normalizeTwitchLogin,
  normalizeYoutubeName,
} = require("../../db");

/** Snowflake gate for channel/role form fields (service.js SNOWFLAKE_RE twin). */
const { STRICT_SNOWFLAKE_RE: SNOWFLAKE_RE } = require("../shared/snowflake");
/** Panel message ids: slash trims only — cap the shape, never the value set. */
const MESSAGE_ID_MAX = 20;
const POLL_MIN = 1;
const POLL_MAX = 60;

/** discord.js ChannelType numerics the /eventreminder picker allows. */
const CHANNEL_TYPE_GUILD_TEXT = 0;
const CHANNEL_TYPE_GUILD_ANNOUNCEMENT = 5;



/** Parsed form fields — the body-cap middleware contract (req.bodyFields). */
function bodyFields(req) {
  const src = req.bodyFields || req.body;
  return src && typeof src === "object" ? src : {};
}

/** Trimmed string field ('' when absent/non-string). */
function field(fields, name) {
  const v = fields[name];
  return typeof v === "string" ? v.trim() : "";
}

/** Validated snowflake field; ''-when-empty keeps "clear" semantics distinct. */
function snowflakeOrEmpty(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return { present: false, ok: true, value: "" };
  return SNOWFLAKE_RE.test(v)
    ? { present: true, ok: true, value: v }
    : { present: true, ok: false, value: v };
}

// (local twin of the service's internal enrichParsedEmojiDisplay — that
// helper is not part of the service's exports, so the display enrichment
// from the guild emoji cache is done here with the SAME output shape.)
/** Custom-emoji display from the guild cache when available (unicode pass-through). */
function enrichEmojiDisplay(guild, parsed) {
  if (!parsed || !parsed.isCustom || !guild) return parsed;
  try {
    const ge = guild.emojis?.cache?.get?.(parsed.key);
    if (ge?.id) {
      return {
        ...parsed,
        display: ge.animated ? `<a:${ge.name}:${ge.id}>` : `<:${ge.name}:${ge.id}>`,
      };
    }
  } catch {
    /* cache miss keeps the parsed display — service parity */
  }
  return parsed;
}

/** Form booleans: absent ⇒ default; "0"/"false"/"off" ⇒ false; else true. */
function parseBoolFlag(value, dflt) {
  if (value === undefined || value === null) return dflt;
  const s = String(value).trim().toLowerCase();
  if (s === "0" || s === "false" || s === "off") return false;
  return true;
}

/** Integer field within [min,max]; null when invalid. */
function intInRange(value, min, max) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,6}$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * POST-REDIRECT-GET (302, empty body, never cached) — shared flash core,
 * which RE-CHECKS the slug against the view's frozen vocabularies before
 * minting Location (previously this surface interpolated the slug unchecked;
 * all 50 call sites pass table literals, so bytes are unchanged — this is
 * the §8.7 no-echo guarantee, not a behavior change).
 */
const redirectIntegrations = makeFlashRedirect({
  pageOf: (guildId) => `/g/${encodeURIComponent(guildId)}/integrations`,
  doneTable: FLASH_DONE,
  errorTable: FLASH_ERROR,
  headers: { "X-Content-Type-Options": "nosniff" },
});

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (app.js passes the SAME instance the guild shell
 *   uses — one tier cache, §8.3); default builds one from the seams below.
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {(() => import("discord.js").Client|null)|null} [options.getClient]
 *   live bot client (cache-only names AND cache-only mutation preflights).
 * @param {{getIntegrations: Function, invalidate?: Function}} [options.integrationsData]
 *   pre-built createIntegrationsData() instance (tests inject counting/fake
 *   ones; default is a process-wide lazily-built singleton). Successful
 *   mutations call invalidate(guildId) when the instance offers it (the
 *   real factory always does) so the next GET reflects the write.
 * @param {(login: string) => Promise<{id: string, login: string, display_name: string, profile_image_url?: string}|null>} [options.resolveTwitchUser]
 *   Twitch user lookup seam (default: features/twitch/helix.resolveTwitchUser
 *   — the exact resolver /twitch add runs; injected fakes keep tests offline).
 * @param {(username: string) => Promise<{id: string, name: string}|null>} [options.lookupYoutubeChannel]
 *   @-handle resolver (default: the feature's lookupChannelByName — the
 *   exact resolver /youtube add runs).
 * @param {(channelId: string) => Promise<{thumbnail_url?: string}|null>} [options.fetchYoutubeChannelInfo]
 *   thumbnail enrichment (default: the feature's fetchChannelInfo; null
 *   without YOUTUBE_API_KEY exactly like the slash path).
 * @param {(guild: any, channelId: string) => Promise<unknown>} [options.ensureHoneypotWarning]
 *   warning-post seam (default: the honeypot feature's ensureHoneypotWarning).
 */
function registerIntegrationsRoutes(app, options = {}) {
  // Lazy: app.js requires this module during evaluation — requiring ../app at
  // module top would read app.js's half-built exports. By register() time
  // (inside createWebApp) the module is fully loaded and cached.
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
    if (!defaultData) defaultData = createIntegrationsData();
    return defaultData;
  };
  const integrationsData = options.integrationsData || {
    getIntegrations: (guildId) => getData().getIntegrations(guildId),
    invalidate: (guildId) => getData().invalidate(guildId),
  };
  /** Drop the per-guild snapshot after a successful write (§8.6 cache). */
  const invalidateCache = (guildId) => {
    try {
      if (typeof integrationsData.invalidate === "function") {
        integrationsData.invalidate(guildId);
      }
    } catch {
      /* cache hygiene only — the write + audit already succeeded */
    }
  };

  const resolveTwitch = options.resolveTwitchUser || defaultResolveTwitchUser;
  const lookupYoutube = options.lookupYoutubeChannel || youtubeFeature.lookupChannelByName;
  const fetchYoutubeInfo = options.fetchYoutubeChannelInfo || youtubeFeature.fetchChannelInfo;
  const ensureHoneypotWarning =
    options.ensureHoneypotWarning || honeypotFeature.ensureHoneypotWarning;

  // ---------------------------------------------------------------------
  // Cache-only Discord preflight helpers (never network, never throw)
  // ---------------------------------------------------------------------

  /** The bot's cached Guild object for guildId, or null (dark/partial cache). */
  function guildFromCache(guildId) {
    try {
      const client = typeof options.getClient === "function" ? options.getClient() : null;
      return client?.guilds?.cache?.get?.(guildId) ?? null;
    } catch {
      return null;
    }
  }
  function cachedChannel(guild, channelId) {
    try {
      return guild?.channels?.cache?.get?.(channelId) ?? null;
    } catch {
      return null;
    }
  }
  function cachedRole(guild, roleId) {
    try {
      return guild?.roles?.cache?.get?.(roleId) ?? null;
    } catch {
      return null;
    }
  }
  /**
   * Channel preflight mirroring the slash channel PICKER's guarantee (the
   * picker can only yield a real channel of this guild). Runs ONLY when the
   * guild is cached — no client (dark boot) cannot run the slash at all, and
   * the console then degrades to format-only validation (file header).
   * @returns {string|null} error slug or null when acceptable
   */
  function preflightChannel(guild, channelId) {
    if (!guild) return null;
    return cachedChannel(guild, channelId) ? null : "channel_missing";
  }
  /** Role preflight (same picker-parity reasoning). */
  function preflightRole(guild, roleId) {
    if (!guild) return null;
    return cachedRole(guild, roleId) ? null : "role_missing";
  }

  /**
   * Mount one mutation: registry entry + route in lockstep (the methodGate
   * 405s every other verb on these paths byte-identically). Handler throws
   * (including a throwing req.audit — DB-first fail-closed) land in
   * handleAppError as the generic 500.
   */
  function mountMutation(path, tier, handler) {
    registerWebMutation(app, "POST", path);
    app.post(path, requireTier(tier), async (req, res) => {
      await handler(req, res);
    });
  }

  /** Guild id every handler works against (guildScope validated it). */
  const guildOf = (req) => req.guildAccess.guildId;

  // ---------------------------------------------------------------------
  // YouTube — staff tier (slash gates: isStaff on /youtube + /setyoutube)
  // ---------------------------------------------------------------------

  /**
   * POST .../youtube/add — mirrors /youtube add's URL parsing EXACTLY
   * (@handle resolution + thumbnail enrichment via the injected service
   * seams; stored channel_url is the raw input, exactly like slash). Web
   * gate: YOUTUBE_API_KEY must exist (slash stores unresolved @username
   * rows silently when it is missing — the console refuses instead; the
   * rejection names the VARIABLE, never a value).
   */
  mountMutation(
    "/g/:guildId/integrations/youtube/add",
    "staff",
    async (req, res) => {
      const guildId = guildOf(req);
      const url = field(bodyFields(req), "url");
      if (!url) return redirectIntegrations(res, guildId, "error", "missing_field");
      if (!(process.env.YOUTUBE_API_KEY || "").trim()) {
        return redirectIntegrations(res, guildId, "error", "youtube_not_configured");
      }

      let channelId = "";
      let channelName = "";
      if (url.includes("youtube.com/@")) {
        const match = url.match(/youtube\.com\/@([^/?]+)/);
        if (match) {
          channelId = match[1];
          channelName = "@" + match[1];
          const resolved = await lookupYoutube(channelId);
          if (resolved) {
            channelId = resolved.id;
            channelName = normalizeYoutubeName(resolved.name);
          }
        }
      } else if (url.startsWith("@")) {
        const username = url.substring(1);
        channelId = username;
        channelName = "@" + username;
        const resolved = await lookupYoutube(username);
        if (resolved) {
          channelId = resolved.id;
          channelName = normalizeYoutubeName(resolved.name);
        }
      } else if (url.includes("youtube.com/channel/")) {
        const match = url.match(/youtube\.com\/channel\/([^/?]+)/);
        if (match) {
          channelId = match[1];
          channelName = `Channel ID: ${channelId}`;
        }
      } else if (url.startsWith("UC") || url.startsWith("HC")) {
        channelId = url;
        channelName = `Channel ID: ${url}`;
      }
      if (!channelId || !channelName) {
        return redirectIntegrations(res, guildId, "error", "invalid_input");
      }

      const normalizedChannelName = normalizeYoutubeName(channelName);
      let thumbnail = "";
      if (channelId && !channelId.startsWith("@")) {
        const channelInfo = await fetchYoutubeInfo(channelId).catch(() => null);
        thumbnail =
          channelInfo?.thumbnail_url ||
          `https://i.ytimg.com/vi/${channelId}/maxresdefault.jpg`;
      }

      db.addYoutubeChannel(guildId, channelId, normalizedChannelName, url, thumbnail);
      req.audit({
        action: "youtube.channel_add",
        targetType: "youtube_channel",
        targetId: channelId,
        details: { channel_name: normalizedChannelName, url },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "yt_added");
    }
  );

  /**
   * POST .../youtube/remove — mirrors /youtube remove (normalizeYoutubeName
   * id match over the guild's rows; "No subscription found." refusal without
   * a write/audit; removeYoutubeChannel is the exact repo helper).
   */
  mountMutation(
    "/g/:guildId/integrations/youtube/remove",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const wanted = field(bodyFields(req), "channel_id");
      if (!wanted) return redirectIntegrations(res, guildId, "error", "missing_field");

      const channelsBefore = db.getYoutubeChannels(guildId);
      const found = channelsBefore.find(
        (c) =>
          normalizeYoutubeName(String(c.id)) === normalizeYoutubeName(wanted) &&
          c.guild_id === guildId
      );
      if (!found) return redirectIntegrations(res, guildId, "error", "yt_not_found");

      db.removeYoutubeChannel(guildId, found.id);
      // Slash's own rescue (features/youtube/index.js): the repo's
      // `SELECT changes()` probe yields a column literally named
      // "changes()", so removeYoutubeChannel can return false even when the
      // DELETE landed — confirm by row count instead of trusting the flag.
      if (db.getYoutubeChannels(guildId).length >= channelsBefore.length) {
        return redirectIntegrations(res, guildId, "error", "yt_not_found");
      }
      req.audit({
        action: "youtube.channel_remove",
        targetType: "youtube_channel",
        targetId: found.id,
        details: { channel_name: found.channel_name },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "yt_removed");
    }
  );

  /** POST .../youtube/channel — /setyoutube channel (notify channel). */
  mountMutation(
    "/g/:guildId/integrations/youtube/channel",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).channel_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_channel_id");
      }
      const fail = preflightChannel(guildFromCache(guildId), parsed.value);
      if (fail) return redirectIntegrations(res, guildId, "error", fail);

      const before = db.getGuildSettings(guildId).youtube_notification_channel_id;
      db.updateGuildSettings(guildId, { youtube_notification_channel_id: parsed.value });
      req.audit({
        action: "youtube.notify_channel_set",
        targetType: "channel",
        targetId: parsed.value,
        details: { previous_channel_id: before ?? null },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "yt_channel_set");
    }
  );

  /** POST .../youtube/interval — /setyoutube interval (1-60 re-check twin). */
  mountMutation(
    "/g/:guildId/integrations/youtube/interval",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const minutes = intInRange(bodyFields(req).minutes, POLL_MIN, POLL_MAX);
      if (minutes === null) {
        return redirectIntegrations(res, guildId, "error", "invalid_interval");
      }
      const before = db.getGuildSettings(guildId).youtube_polling_interval_minutes;
      db.updateGuildSettings(guildId, { youtube_polling_interval_minutes: minutes });
      req.audit({
        action: "youtube.polling_interval_set",
        targetType: "guild",
        targetId: guildId,
        details: { previous_minutes: before ?? null, minutes },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "yt_interval_set");
    }
  );

  /**
   * POST .../youtube/uploadrole — /setyoutube uploadrole; empty field clears
   * the role exactly like the slash's optional role option.
   */
  mountMutation(
    "/g/:guildId/integrations/youtube/uploadrole",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_role_id");
      }
      if (parsed.present) {
        const fail = preflightRole(guildFromCache(guildId), parsed.value);
        if (fail) return redirectIntegrations(res, guildId, "error", fail);
      }
      const before = db.getGuildSettings(guildId).youtube_upload_role_id;
      db.updateGuildSettings(guildId, { youtube_upload_role_id: parsed.value || null });
      req.audit({
        action: "youtube.upload_role_set",
        targetType: "role",
        targetId: parsed.value || guildId,
        details: { role_id: parsed.value || null, previous_role_id: before ?? null },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", parsed.value ? "yt_upload_role_set" : "yt_upload_role_cleared");
    }
  );

  // ---------------------------------------------------------------------
  // Twitch — staff tier
  // ---------------------------------------------------------------------

  /**
   * POST .../twitch/add — /twitch add: env gate FIRST (slash's exact
   * refusal — names both variables, never values), then normalize → resolve
   * (helix seam) → duplicate check → addTwitchChannel, same audit shape.
   */
  mountMutation(
    "/g/:guildId/integrations/twitch/add",
    "staff",
    async (req, res) => {
      const guildId = guildOf(req);
      const raw = field(bodyFields(req), "login");
      if (!raw) return redirectIntegrations(res, guildId, "error", "missing_field");

      if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        return redirectIntegrations(res, guildId, "error", "twitch_not_configured");
      }

      const login = normalizeTwitchLogin(raw);
      const user = await resolveTwitch(login).catch(() => null);
      if (!user) {
        return redirectIntegrations(res, guildId, "error", "tw_resolve_failed");
      }
      if (db.getTwitchChannel(guildId, user.login)) {
        return redirectIntegrations(res, guildId, "error", "tw_exists");
      }

      db.addTwitchChannel(guildId, user.id, user.login, user.display_name, user.profile_image_url);
      req.audit({
        action: "twitch.channel_add",
        targetType: "twitch_channel",
        targetId: user.id,
        details: { login: user.login, display_name: user.display_name },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "tw_added");
    }
  );

  /** POST .../twitch/remove — /twitch remove (login OR broadcaster id). */
  mountMutation(
    "/g/:guildId/integrations/twitch/remove",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const raw = field(bodyFields(req), "channel");
      if (!raw) return redirectIntegrations(res, guildId, "error", "missing_field");

      const found = db.getTwitchChannel(guildId, raw);
      if (!found) return redirectIntegrations(res, guildId, "error", "tw_not_found");

      db.removeTwitchChannel(guildId, found.login);
      req.audit({
        action: "twitch.channel_remove",
        targetType: "twitch_channel",
        targetId: found.broadcaster_id,
        details: { login: found.login, display_name: found.display_name },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "tw_removed");
    }
  );

  /** POST .../twitch/channel — /settwitch channel (notify channel). */
  mountMutation(
    "/g/:guildId/integrations/twitch/channel",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).channel_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_channel_id");
      }
      const fail = preflightChannel(guildFromCache(guildId), parsed.value);
      if (fail) return redirectIntegrations(res, guildId, "error", fail);

      const before = db.getGuildSettings(guildId).twitch_notification_channel_id;
      db.updateGuildSettings(guildId, { twitch_notification_channel_id: parsed.value });
      req.audit({
        action: "twitch.notify_channel_set",
        targetType: "channel",
        targetId: parsed.value,
        details: { previous_channel_id: before ?? null },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "tw_channel_set");
    }
  );

  /** POST .../twitch/role — /settwitch role; empty clears (parity). */
  mountMutation(
    "/g/:guildId/integrations/twitch/role",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_role_id");
      }
      if (parsed.present) {
        const fail = preflightRole(guildFromCache(guildId), parsed.value);
        if (fail) return redirectIntegrations(res, guildId, "error", fail);
      }
      const before = db.getGuildSettings(guildId).twitch_notify_role_id;
      db.updateGuildSettings(guildId, { twitch_notify_role_id: parsed.value || null });
      req.audit({
        action: "twitch.notify_role_set",
        targetType: "role",
        targetId: parsed.value || guildId,
        details: { role_id: parsed.value || null, previous_role_id: before ?? null },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", parsed.value ? "tw_role_set" : "tw_role_cleared");
    }
  );

  /** POST .../twitch/interval — /settwitch interval (picker min/max twin). */
  mountMutation(
    "/g/:guildId/integrations/twitch/interval",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const minutes = intInRange(bodyFields(req).minutes, POLL_MIN, POLL_MAX);
      if (minutes === null) {
        return redirectIntegrations(res, guildId, "error", "invalid_interval");
      }
      const before = db.getGuildSettings(guildId).twitch_polling_interval_minutes;
      db.updateGuildSettings(guildId, { twitch_polling_interval_minutes: minutes });
      req.audit({
        action: "twitch.polling_interval_set",
        targetType: "guild",
        targetId: guildId,
        details: { previous_minutes: before ?? null, minutes },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "tw_interval_set");
    }
  );

  // ---------------------------------------------------------------------
  // Reaction roles — staff tier
  // ---------------------------------------------------------------------

  /**
   * POST .../reaction-roles/panel/create — /reactionrole panel create:
   * posts the panel embed FIRST (slash order), then stores. The channel
   * comes from the cache-only seam (slash's picker object twin): unsendable
   * channels get the slash's exact refusal wording. No bound client ⇒ the
   * post is impossible, so the mutation is refused outright (slash is
   * unreachable in a dark boot too).
   */
  mountMutation(
    "/g/:guildId/integrations/reaction-roles/panel/create",
    "staff",
    async (req, res) => {
      const guildId = guildOf(req);
      const fields = bodyFields(req);
      const parsed = snowflakeOrEmpty(fields.channel_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_channel_id");
      }
      const title = field(fields, "title") || "Reaction Roles";
      const description =
        field(fields, "description") ||
        "React to get a role. Remove your reaction to drop it (if allowed).";
      if (title.length > 256 || description.length > 1000) {
        return redirectIntegrations(res, guildId, "error", "missing_field");
      }

      const guild = guildFromCache(guildId);
      if (!guild) return redirectIntegrations(res, guildId, "error", "rr_offline");
      const ch = cachedChannel(guild, parsed.value);
      if (!ch) return redirectIntegrations(res, guildId, "error", "channel_missing");
      if (typeof ch.isTextBased === "function" && !ch.isTextBased()) {
        return redirectIntegrations(res, guildId, "error", "rr_channel_unsendable");
      }
      if (typeof ch.send !== "function") {
        return redirectIntegrations(res, guildId, "error", "rr_channel_unsendable");
      }

      const embed = reactionRolesService.buildPanelEmbed(
        { title, description, guild_id: guildId, channel_id: parsed.value, message_id: "pending" },
        []
      );
      let msg;
      try {
        msg = await ch.send({
          embeds: [embed],
          allowedMentions: reactionRolesService.NO_PING_MENTIONS,
        });
      } catch {
        return redirectIntegrations(res, guildId, "error", "rr_post_failed");
      }

      db.createReactionRolePanel(guildId, parsed.value, msg.id, title, description);
      req.audit({
        action: "reaction_roles.panel_create",
        targetType: "reaction_role_panel",
        targetId: msg.id,
        details: { channel_id: parsed.value, title },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "rr_panel_created");
    }
  );

  /**
   * POST .../reaction-roles/panel/delete — /reactionrole panel delete:
   * deleteReactionRolePanel (DB first, options cascade), audit only when a
   * row existed (slash order), then best-effort Discord message removal
   * (cache-first; any failure just means the message lingers — slash's own
   * "(Could not delete Discord message…)" degradation).
   */
  mountMutation(
    "/g/:guildId/integrations/reaction-roles/panel/delete",
    "staff",
    async (req, res) => {
      const guildId = guildOf(req);
      const messageId = field(bodyFields(req), "message_id");
      if (!messageId || messageId.length > MESSAGE_ID_MAX) {
        return redirectIntegrations(res, guildId, "error", "invalid_message_id");
      }

      const { removed, channel_id: channelId } = db.deleteReactionRolePanel(guildId, messageId);
      if (!removed) {
        return redirectIntegrations(res, guildId, "error", "rr_panel_not_found");
      }
      req.audit({
        action: "reaction_roles.panel_delete",
        targetType: "reaction_role_panel",
        targetId: messageId,
        details: { channel_id: channelId ?? null },
      });
      invalidateCache(guildId);

      const guild = guildFromCache(guildId);
      const channel = channelId ? cachedChannel(guild, channelId) : null;
      try {
        const msg = channel?.messages?.fetch
          ? await channel.messages.fetch(messageId).catch(() => null)
          : null;
        if (msg?.delete) await msg.delete().catch(() => null);
      } catch {
        /* the DB panel is gone; the orphan message mirrors slash's note path */
      }
      redirectIntegrations(res, guildId, "done", "rr_panel_deleted");
    }
  );

  /**
   * POST .../reaction-roles/option/add — single-step twin of the slash
   * option-add flow (the slash stages a pending wait because slash has no
   * emoji field; the web form carries the emoji directly). Reuses the
   * SERVICE emoji parser + guild-emoji validator + bound check
   * (MAX_OPTIONS_PER_PANEL with the upsert-key exemption, exactly like
   * applyReactionRoleOption) and the repo upsert helper. Audit fires on DB
   * success even when the best-effort panel refresh degrades (deviation:
   * slash defers the audit until its full flow completes — a web mutation
   * that persisted a row must always be audited).
   */
  mountMutation(
    "/g/:guildId/integrations/reaction-roles/option/add",
    "staff",
    async (req, res) => {
      const guildId = guildOf(req);
      const fields = bodyFields(req);
      const messageId = field(fields, "message_id");
      if (!messageId || messageId.length > MESSAGE_ID_MAX) {
        return redirectIntegrations(res, guildId, "error", "invalid_message_id");
      }
      if (!db.getReactionRolePanel(guildId, messageId)) {
        return redirectIntegrations(res, guildId, "error", "rr_panel_not_found");
      }
      const parsedRole = snowflakeOrEmpty(fields.role_id);
      if (!parsedRole.present || !parsedRole.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_role_id");
      }
      const level = field(fields, "level") === "" ? 0 : intInRange(fields.level, 0, 999999);
      if (level === null) {
        return redirectIntegrations(res, guildId, "error", "invalid_level");
      }
      const removable = parseBoolFlag(fields.removable, true);

      const guild = guildFromCache(guildId);
      if (guild) {
        const role = cachedRole(guild, parsedRole.value);
        if (!role) return redirectIntegrations(res, guildId, "error", "role_missing");
        if (role.managed) {
          return redirectIntegrations(res, guildId, "error", "rr_role_managed");
        }
      }

      const parsed = reactionRolesService.parseEmojiInput(fields.emoji);
      if (!parsed) return redirectIntegrations(res, guildId, "error", "rr_emoji_invalid");
      if (guild && reactionRolesService.validateEmojiForGuild(guild, parsed)) {
        return redirectIntegrations(res, guildId, "error", "rr_emoji_unavailable");
      }

      const existing = db.getReactionRoleOption(guildId, messageId, parsed.key);
      if (!existing && db.countReactionRoleOptions(guildId, messageId) >= reactionRolesService.MAX_OPTIONS_PER_PANEL) {
        return redirectIntegrations(res, guildId, "error", "rr_option_limit");
      }

      const enriched = enrichEmojiDisplay(guild, parsed);
      db.upsertReactionRoleOption(
        guildId,
        messageId,
        enriched.key,
        enriched.display,
        parsedRole.value,
        level,
        removable
      );
      req.audit({
        action: "reaction_roles.option_add",
        targetType: "reaction_role_panel",
        targetId: messageId,
        details: {
          role_id: parsedRole.value,
          emoji: enriched.display,
          min_level: level,
          removable: removable ? 1 : 0,
        },
      });
      invalidateCache(guildId);

      // Best-effort embed/reaction refresh (slash awaits it inside its
      // ephemeral flow; the console redirects and never blocks on Discord).
      if (guild) {
        Promise.resolve()
          .then(() =>
            reactionRolesService.refreshPanelMessage(
              guild,
              db.getReactionRolePanel(guildId, messageId)
            )
          )
          .catch(() => {});
      }
      redirectIntegrations(res, guildId, "done", "rr_option_added");
    }
  );

  /**
   * POST .../reaction-roles/option/remove — single-step twin of the slash
   * option-remove flow (emoji comes from the form). Mirrors the finalize
   * step: parseable emoji required; missing option ⇒ refusal with no
   * audit/write (slash "No option for …"); DB delete then audit then
   * best-effort refresh.
   */
  mountMutation(
    "/g/:guildId/integrations/reaction-roles/option/remove",
    "staff",
    async (req, res) => {
      const guildId = guildOf(req);
      const fields = bodyFields(req);
      const messageId = field(fields, "message_id");
      if (!messageId || messageId.length > MESSAGE_ID_MAX) {
        return redirectIntegrations(res, guildId, "error", "invalid_message_id");
      }
      if (!db.getReactionRolePanel(guildId, messageId)) {
        return redirectIntegrations(res, guildId, "error", "rr_panel_not_found");
      }
      const parsed = reactionRolesService.parseEmojiInput(fields.emoji);
      if (!parsed) return redirectIntegrations(res, guildId, "error", "rr_emoji_invalid");

      const guild = guildFromCache(guildId);
      const enriched = enrichEmojiDisplay(guild, parsed);
      const removed = db.deleteReactionRoleOption(guildId, messageId, enriched.key);
      if (!removed) {
        return redirectIntegrations(res, guildId, "error", "rr_option_not_found");
      }
      req.audit({
        action: "reaction_roles.option_remove",
        targetType: "reaction_role_panel",
        targetId: messageId,
        details: { emoji: enriched.display },
      });
      invalidateCache(guildId);

      if (guild) {
        Promise.resolve()
          .then(() =>
            reactionRolesService.refreshPanelMessage(
              guild,
              db.getReactionRolePanel(guildId, messageId)
            )
          )
          .catch(() => {});
      }
      redirectIntegrations(res, guildId, "done", "rr_option_removed");
    }
  );

  // ---------------------------------------------------------------------
  // Event reminders — staff tier (setchannel ONLY in web v1; the slash
  // create/edit/clear/sync creator axis is deliberately NOT replicated —
  // see the file header's "EVENT-CREATOR AXIS" note).
  // ---------------------------------------------------------------------

  /**
   * POST .../event-reminders/channel — /eventreminder setchannel. Empty
   * field clears (slash's optional channel); the slash picker's
   * text|announcement type restriction is enforced cache-only.
   */
  mountMutation(
    "/g/:guildId/integrations/event-reminders/channel",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).channel_id);
      if (!parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_channel_id");
      }
      const value = parsed.value || null;
      if (value) {
        const guild = guildFromCache(guildId);
        if (guild) {
          const ch = cachedChannel(guild, value);
          if (!ch) return redirectIntegrations(res, guildId, "error", "channel_missing");
          if (
            typeof ch.type === "number" &&
            ch.type !== CHANNEL_TYPE_GUILD_TEXT &&
            ch.type !== CHANNEL_TYPE_GUILD_ANNOUNCEMENT
          ) {
            return redirectIntegrations(res, guildId, "error", "er_channel_type");
          }
        }
      }

      db.updateGuildSettings(guildId, { event_reminder_channel_id: value });
      req.audit({
        action: "event_reminders.channel_set",
        targetType: "guild",
        targetId: guildId,
        details: { channel_id: value },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", value ? "er_channel_set" : "er_channel_cleared");
    }
  );

  // ---------------------------------------------------------------------
  // Honeypot — staff tier; the EXEMPT pair is ADMIN (§8.6 per-command tier
  // = the slash group's isAdminOrMod gate; the exempt rows live in
  // staff_roles, mutated via the facade's existing staffRoles aliases).
  // ---------------------------------------------------------------------

  /**
   * POST .../honeypot/channel/add — /honeypot channel add: duplicate check,
   * addHoneypotChannel, audit BEFORE the warning post, then the feature's
   * own ensureHoneypotWarning best-effort (its status string is a slash
   * reply artifact; the console's flash stays generic).
   */
  mountMutation(
    "/g/:guildId/integrations/honeypot/channel/add",
    "staff",
    async (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).channel_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_channel_id");
      }
      const fail = preflightChannel(guildFromCache(guildId), parsed.value);
      if (fail) return redirectIntegrations(res, guildId, "error", fail);
      if (db.isHoneypotChannel(guildId, parsed.value)) {
        return redirectIntegrations(res, guildId, "error", "hp_channel_exists");
      }

      db.addHoneypotChannel(guildId, parsed.value);
      req.audit({
        action: "honeypot.channel_add",
        targetType: "channel",
        targetId: parsed.value,
      });
      invalidateCache(guildId);

      const guild = guildFromCache(guildId);
      if (guild) {
        try {
          await ensureHoneypotWarning(guild, parsed.value);
        } catch {
          /* warning post is best-effort, exactly like the slash's status note */
        }
      }
      redirectIntegrations(res, guildId, "done", "hp_channel_added");
    }
  );

  /**
   * POST .../honeypot/channel/del — /honeypot channel del: unknown channel
   * ⇒ refusal WITHOUT audit (slash); removal audits then best-effort
   * removes the warning notice (cache-first fetch, every failure silent).
   */
  mountMutation(
    "/g/:guildId/integrations/honeypot/channel/del",
    "staff",
    async (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).channel_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_channel_id");
      }

      const { removed, warning_message_id: warningMessageId } = db.removeHoneypotChannel(
        guildId,
        parsed.value
      );
      if (!removed) {
        return redirectIntegrations(res, guildId, "error", "hp_channel_not_found");
      }
      req.audit({
        action: "honeypot.channel_del",
        targetType: "channel",
        targetId: parsed.value,
      });
      invalidateCache(guildId);

      const guild = guildFromCache(guildId);
      const channel = warningMessageId ? cachedChannel(guild, parsed.value) : null;
      try {
        const msg =
          warningMessageId && channel?.messages?.fetch
            ? await channel.messages.fetch(warningMessageId).catch(() => null)
            : null;
        if (msg?.delete) await msg.delete().catch(() => null);
      } catch {
        /* slash removes it manually in that case — same posture here */
      }
      redirectIntegrations(res, guildId, "done", "hp_channel_removed");
    }
  );

  /**
   * POST .../honeypot/banrole/add — /honeypot banrole add: @everyone and
   * managed-role refusals (slash's exact wording; @everyone is arithmetic —
   * checked always, managed needs the cache) plus the duplicate refusal,
   * then addHoneypotBanRole + audit.
   */
  mountMutation(
    "/g/:guildId/integrations/honeypot/banrole/add",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_role_id");
      }
      if (parsed.value === guildId) {
        return redirectIntegrations(res, guildId, "error", "hp_role_everyone");
      }
      const guild = guildFromCache(guildId);
      if (guild) {
        const role = cachedRole(guild, parsed.value);
        if (!role) return redirectIntegrations(res, guildId, "error", "role_missing");
        if (role.managed) {
          return redirectIntegrations(res, guildId, "error", "hp_role_managed");
        }
      }
      if (db.isHoneypotBanRole(guildId, parsed.value)) {
        return redirectIntegrations(res, guildId, "error", "hp_banrole_exists");
      }

      db.addHoneypotBanRole(guildId, parsed.value);
      req.audit({
        action: "honeypot.ban_role_add",
        targetType: "role",
        targetId: parsed.value,
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "hp_banrole_added");
    }
  );

  /** POST .../honeypot/banrole/del — /honeypot banrole del (unknown ⇒ no audit). */
  mountMutation(
    "/g/:guildId/integrations/honeypot/banrole/del",
    "staff",
    (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_role_id");
      }

      const removed = db.removeHoneypotBanRole(guildId, parsed.value);
      if (!removed) {
        return redirectIntegrations(res, guildId, "error", "hp_banrole_not_found");
      }
      req.audit({
        action: "honeypot.ban_role_del",
        targetType: "role",
        targetId: parsed.value,
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "hp_banrole_removed");
    }
  );

  /**
   * POST .../honeypot/exempt/add — /honeypot exempt add. §8.6 per-command
   * tier = ADMIN (slash gate isAdminOrMod = ManageGuild only; staff-tier
   * roles get 403 here). Writes the SHARED staff_roles table through the
   * facade's existing addStaffRole alias (default level "senior" — the
   * exact slash exempt call), audited with the slash's own vocabulary.
   */
  mountMutation(
    "/g/:guildId/integrations/honeypot/exempt/add",
    "admin",
    (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_role_id");
      }
      if (parsed.value === guildId) {
        return redirectIntegrations(res, guildId, "error", "hp_role_everyone");
      }
      const fail = preflightRole(guildFromCache(guildId), parsed.value);
      if (fail) return redirectIntegrations(res, guildId, "error", fail);

      db.addStaffRole(guildId, parsed.value);
      req.audit({
        action: "staff.role_add",
        targetType: "role",
        targetId: parsed.value,
        details: { via: "honeypot.exempt" },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "hp_exempt_added");
    }
  );

  /**
   * POST .../honeypot/exempt/del — /honeypot exempt del (ADMIN). Unknown
   * role ⇒ refusal without audit (slash "is not a configured staff role").
   */
  mountMutation(
    "/g/:guildId/integrations/honeypot/exempt/del",
    "admin",
    (req, res) => {
      const guildId = guildOf(req);
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, guildId, "error", "invalid_role_id");
      }

      const removed = db.removeStaffRole(guildId, parsed.value);
      if (!removed) {
        return redirectIntegrations(res, guildId, "error", "hp_exempt_not_found");
      }
      req.audit({
        action: "staff.role_remove",
        targetType: "role",
        targetId: parsed.value,
        details: { via: "honeypot.exempt" },
      });
      invalidateCache(guildId);
      redirectIntegrations(res, guildId, "done", "hp_exempt_removed");
    }
  );

  // ---------------------------------------------------------------------
  // GET (Phase 1, unchanged behavior) — now also renders the write forms +
  // the PRG flash (whitelisted slugs only; the raw query value is dropped).
  // ---------------------------------------------------------------------
  app.get(
    "/g/:guildId/integrations",
    requireTier("staff"),
    async (req, res) => {
      const guildId = req.guildAccess.guildId;
      // One cached per-guild snapshot (§8.6 floor 30 s). Facade reads
      // happen inside the data module — never here.
      const snapshot = integrationsData.getIntegrations(guildId);
      const document = renderShellPage(req, {
        title: "Integrations",
        heading: "Integrations",
        subheading:
          "YouTube, Twitch, reaction roles, event reminders and honeypot — current values, the slash commands that own them, and the staff-tier write forms (honeypot exempt writes need admin).",
        content: renderIntegrationsBody({
          snapshot,
          resolveChannelName: makeCacheNameResolver(options.getClient, "channels"),
          resolveRoleName: makeCacheNameResolver(options.getClient, "roles"),
          csrfToken: req.csrfToken || null,
          tier: req.guildAccess.tier || null,
          flash: flashFromQuery(req.query),
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    }
  );
}

module.exports = {
  registerIntegrationsRoutes,
};
