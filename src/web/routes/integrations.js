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
 *    carry the hidden `_csrf` field (scripted requests may send X-CSRF-Token);
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
  SECTION_IDS,
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
 *
 * #644: this surface declares its frozen page sections (views/integrations
 * SECTION_IDS), so a handler that passes an accepted section as the 5th
 * argument redirects to
 *   ?<flag>=<slug>&at=<section>#<section>
 * The handler CHOOSES the section (never `_return`, `next`, or a posted
 * hash); the shared core re-checks the value against sectionIds and writes
 * nothing for an omitted/unknown one (historical bytes preserved).
 */
const redirectIntegrations = makeFlashRedirect({
  pageOf: (guildId) => `/g/${encodeURIComponent(guildId)}/integrations`,
  doneTable: FLASH_DONE,
  errorTable: FLASH_ERROR,
  headers: { "X-Content-Type-Options": "nosniff" },
  sectionIds: SECTION_IDS,
});

/**
 * Frozen page-section ids (#644) — one definition (views/integrations)
 * shared by the redirect writer (via sectionIds above), the GET `at` reader
 * below, and the view's banner/open placement.
 */
const INTEG_SECTIONS = new Set(SECTION_IDS);

/**
 * Read the SECTION the GET should open (#644). The redirect repeats the
 * section as `?at=` because the URL FRAGMENT never arrives on the GET after
 * a redirect — and even then only the frozen set is accepted; an unknown or
 * missing `at` opens nothing (banner stays at the top of the page). The raw
 * query value is NEVER interpolated into an id attribute: it is only ever
 * tested for set membership (routes/settings.js readSectionAt twin; this
 * route already consumes the parsed query for the flash pair).
 * @param {{at?: unknown}|undefined|null} query parsed req.query
 * @returns {string|null} validated section id
 */
function readSectionAt(query) {
  const at = query && typeof query === "object" ? query.at : undefined;
  return typeof at === "string" && INTEG_SECTIONS.has(at) ? at : null;
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
 *   live bot client (cache-only names AND cache-only mutation preflights).
 * @param {{getIntegrations: Function, invalidate?: Function}} [options.integrationsData]
 *   pre-built createIntegrationsData() instance (tests inject counting/fake
 *   ones; default is a process-wide lazily-built singleton). Successful
 *   mutations call invalidate(communityId) when the instance offers it (the
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
    getIntegrations: (communityId) => getData().getIntegrations(communityId),
    invalidate: (communityId) => getData().invalidate(communityId),
  };
  /** Drop the per-community snapshot after a successful write (§8.6 cache). */
  const invalidateCache = (communityId) => {
    try {
      if (typeof integrationsData.invalidate === "function") {
        integrationsData.invalidate(communityId);
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

  /**
   * The three settings-field shapes shared by the YouTube and Twitch twins
   * (channel = required + preflight; role = optional, empty clears; interval
   * = int range re-check). Facade order — read-before → update → audit →
   * invalidate → redirect — is the parity anchor with the slash handlers
   * these mirror; do not reorder.
   *
   * #644: one helper serves BOTH twins, so the flash slug cannot place the
   * redirect section (invalid_interval fires from both the YouTube and the
   * Twitch interval route). The mount passes `section` explicitly and it is
   * forwarded on EVERY redirect inside the helper — no exception.
   */
  function mountSettingsField(
    path,
    { kind, field, key = "channel_id", auditAction, detailsOf, done, doneCleared, section }
  ) {
    mountMutation(path, "staff", (req, res) => {
      const guildId = guildOf(req); // external: preflight caches + audit target
      const communityId = communityOf(req); // integer: settings repo + PRG link
      let value;
      let targetId;
      let targetType;
      if (kind === "interval") {
        value = intInRange(bodyFields(req).minutes, POLL_MIN, POLL_MAX);
        if (value === null) {
          return redirectIntegrations(res, communityId, "error", "invalid_interval", section);
        }
        targetId = guildId;
        targetType = "guild";
      } else {
        const parsed = snowflakeOrEmpty(bodyFields(req)[key]);
        if (kind === "channel") {
          if (!parsed.present || !parsed.ok) {
            return redirectIntegrations(res, communityId, "error", "invalid_channel_id", section);
          }
          const fail = preflightChannel(guildFromCache(guildId), parsed.value);
          if (fail) return redirectIntegrations(res, communityId, "error", fail, section);
          value = parsed.value;
          targetId = parsed.value;
          targetType = "channel";
        } else {
          if (!parsed.ok) {
            return redirectIntegrations(res, communityId, "error", "invalid_role_id", section);
          }
          if (parsed.present) {
            const fail = preflightRole(guildFromCache(guildId), parsed.value);
            if (fail) return redirectIntegrations(res, communityId, "error", fail, section);
          }
          value = parsed.value || null;
          targetId = parsed.value || guildId;
          targetType = "role";
        }
      }
      const before = db.getGuildSettings(communityId)[field] ?? null;
      db.updateGuildSettings(communityId, { [field]: value });
      req.audit({
        action: auditAction,
        targetType,
        targetId,
        details: detailsOf(value, before),
      });
      invalidateCache(communityId);
      redirectIntegrations(
        res,
        communityId,
        "done",
        doneCleared !== undefined && value === null ? doneCleared : done,
        section
      );
    });
  }

  /**
   * Guild id every Discord-facing handler works against (guildScope
   * validated it). Fluxer PR 2 split: guildOf = EXTERNAL Discord snowflake
   * (client caches, @everyone comparison, audit entry targets);
   * communityOf = INTEGER communities.id (repositories, the integrations
   * data builder, the PRG link). One consumer each — never swap them.
   */
  const guildOf = (req) => req.guildAccess.guildId;
  const communityOf = (req) => req.guildAccess.communityId;

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
      const communityId = communityOf(req); // repos + PRG link (integer)
      const url = field(bodyFields(req), "url");
      if (!url) return redirectIntegrations(res, communityId, "error", "missing_field", "youtube");
      if (!(process.env.YOUTUBE_API_KEY || "").trim()) {
        return redirectIntegrations(res, communityId, "error", "youtube_not_configured", "youtube");
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
        return redirectIntegrations(res, communityId, "error", "invalid_input", "youtube");
      }

      const normalizedChannelName = normalizeYoutubeName(channelName);
      let thumbnail = "";
      if (channelId && !channelId.startsWith("@")) {
        const channelInfo = await fetchYoutubeInfo(channelId).catch(() => null);
        thumbnail =
          channelInfo?.thumbnail_url ||
          `https://i.ytimg.com/vi/${channelId}/maxresdefault.jpg`;
      }

      db.addYoutubeChannel(communityId, channelId, normalizedChannelName, url, thumbnail);
      req.audit({
        action: "youtube.channel_add",
        targetType: "youtube_channel",
        targetId: channelId,
        details: { channel_name: normalizedChannelName, url },
      });
      invalidateCache(communityId);
      redirectIntegrations(res, communityId, "done", "yt_added", "youtube");
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
      const communityId = communityOf(req); // repos + PRG link (integer)
      const wanted = field(bodyFields(req), "channel_id");
      if (!wanted) return redirectIntegrations(res, communityId, "error", "missing_field", "youtube");

      const channelsBefore = db.getYoutubeChannels(communityId);
      const found = channelsBefore.find(
        (c) =>
          normalizeYoutubeName(String(c.id)) === normalizeYoutubeName(wanted) &&
          c.community_id === communityId
      );
      if (!found) return redirectIntegrations(res, communityId, "error", "yt_not_found", "youtube");

      // #442 (audit INT-7): the repo return is honest now (res.changes > 0;
      // the old `SELECT changes()` probe yielded a column named "changes()"
      // and lied false), so this no longer needs the row-count rescue —
      // false means the row genuinely isn't there (e.g. removed concurrently).
      const removed = db.removeYoutubeChannel(communityId, found.id);
      if (!removed) {
        return redirectIntegrations(res, communityId, "error", "yt_not_found", "youtube");
      }
      req.audit({
        action: "youtube.channel_remove",
        targetType: "youtube_channel",
        targetId: found.id,
        details: { channel_name: found.channel_name },
      });
      invalidateCache(communityId);
      redirectIntegrations(res, communityId, "done", "yt_removed", "youtube");
    }
  );





  /** POST .../youtube/channel — /setyoutube channel (notify channel). */
  mountSettingsField("/g/:guildId/integrations/youtube/channel", {
    kind: "channel",
    field: "youtube_notification_channel_id",
    auditAction: "youtube.notify_channel_set",
    detailsOf: (v, before) => ({ previous_channel_id: before }),
    done: "yt_channel_set",
    section: "youtube",
  });

  /** POST .../youtube/interval — /setyoutube interval (1-60 re-check twin). */
  mountSettingsField("/g/:guildId/integrations/youtube/interval", {
    kind: "interval",
    field: "youtube_polling_interval_minutes",
    auditAction: "youtube.polling_interval_set",
    detailsOf: (v, before) => ({ previous_minutes: before, minutes: v }),
    done: "yt_interval_set",
    section: "youtube",
  });

  /**
   * POST .../youtube/uploadrole — /setyoutube uploadrole; empty field clears
   * the role exactly like the slash's optional role option.
   */
  mountSettingsField("/g/:guildId/integrations/youtube/uploadrole", {
    kind: "role",
    key: "role_id",
    field: "youtube_upload_role_id",
    auditAction: "youtube.upload_role_set",
    detailsOf: (v, before) => ({ role_id: v, previous_role_id: before }),
    done: "yt_upload_role_set",
    doneCleared: "yt_upload_role_cleared",
    section: "youtube",
  });

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
      const communityId = communityOf(req); // repos + PRG link (integer)
      const raw = field(bodyFields(req), "login");
      if (!raw) return redirectIntegrations(res, communityId, "error", "missing_field", "twitch");

      if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
        return redirectIntegrations(res, communityId, "error", "twitch_not_configured", "twitch");
      }

      const login = normalizeTwitchLogin(raw);
      const user = await resolveTwitch(login).catch(() => null);
      if (!user) {
        return redirectIntegrations(res, communityId, "error", "tw_resolve_failed", "twitch");
      }
      if (db.getTwitchChannel(communityId, user.login)) {
        return redirectIntegrations(res, communityId, "error", "tw_exists", "twitch");
      }

      db.addTwitchChannel(communityId, user.id, user.login, user.display_name, user.profile_image_url);
      req.audit({
        action: "twitch.channel_add",
        targetType: "twitch_channel",
        targetId: user.id,
        details: { login: user.login, display_name: user.display_name },
      });
      invalidateCache(communityId);
      redirectIntegrations(res, communityId, "done", "tw_added", "twitch");
    }
  );

  /** POST .../twitch/remove — /twitch remove (login OR broadcaster id). */
  mountMutation(
    "/g/:guildId/integrations/twitch/remove",
    "staff",
    (req, res) => {
      const communityId = communityOf(req); // repos + PRG link (integer)
      const raw = field(bodyFields(req), "channel");
      if (!raw) return redirectIntegrations(res, communityId, "error", "missing_field", "twitch");

      const found = db.getTwitchChannel(communityId, raw);
      if (!found) return redirectIntegrations(res, communityId, "error", "tw_not_found", "twitch");

      db.removeTwitchChannel(communityId, found.login);
      req.audit({
        action: "twitch.channel_remove",
        targetType: "twitch_channel",
        targetId: found.broadcaster_id,
        details: { login: found.login, display_name: found.display_name },
      });
      invalidateCache(communityId);
      redirectIntegrations(res, communityId, "done", "tw_removed", "twitch");
    }
  );





  /** POST .../twitch/channel — /settwitch channel (notify channel). */
  mountSettingsField("/g/:guildId/integrations/twitch/channel", {
    kind: "channel",
    field: "twitch_notification_channel_id",
    auditAction: "twitch.notify_channel_set",
    detailsOf: (v, before) => ({ previous_channel_id: before }),
    done: "tw_channel_set",
    section: "twitch",
  });

  /** POST .../twitch/role — /settwitch role; empty clears (parity). */
  mountSettingsField("/g/:guildId/integrations/twitch/role", {
    kind: "role",
    key: "role_id",
    field: "twitch_notify_role_id",
    auditAction: "twitch.notify_role_set",
    detailsOf: (v, before) => ({ role_id: v, previous_role_id: before }),
    done: "tw_role_set",
    doneCleared: "tw_role_cleared",
    section: "twitch",
  });

  /** POST .../twitch/interval — /settwitch interval (picker min/max twin). */
  mountSettingsField("/g/:guildId/integrations/twitch/interval", {
    kind: "interval",
    field: "twitch_polling_interval_minutes",
    auditAction: "twitch.polling_interval_set",
    detailsOf: (v, before) => ({ previous_minutes: before, minutes: v }),
    done: "tw_interval_set",
    section: "twitch",
  });

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
      const guildId = guildOf(req); // external: channel cache lookups
      const communityId = communityOf(req); // repos + PRG link (integer)
      const fields = bodyFields(req);
      const parsed = snowflakeOrEmpty(fields.channel_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, communityId, "error", "invalid_channel_id", "reaction-roles");
      }
      const title = field(fields, "title") || "Reaction Roles";
      const description =
        field(fields, "description") ||
        "React to get a role. Remove your reaction to drop it (if allowed).";
      if (title.length > 256 || description.length > 1000) {
        return redirectIntegrations(res, communityId, "error", "missing_field", "reaction-roles");
      }

      const guild = guildFromCache(guildId);
      if (!guild) return redirectIntegrations(res, communityId, "error", "rr_offline", "reaction-roles");
      const ch = cachedChannel(guild, parsed.value);
      if (!ch) return redirectIntegrations(res, communityId, "error", "channel_missing", "reaction-roles");
      if (typeof ch.isTextBased === "function" && !ch.isTextBased()) {
        return redirectIntegrations(res, communityId, "error", "rr_channel_unsendable", "reaction-roles");
      }
      if (typeof ch.send !== "function") {
        return redirectIntegrations(res, communityId, "error", "rr_channel_unsendable", "reaction-roles");
      }

      const embed = reactionRolesService.buildPanelEmbed(
        // Row-shape stub (rows carry the integer community id post-cutover).
        { title, description, community_id: communityId, channel_id: parsed.value, message_id: "pending" },
        []
      );
      let msg;
      try {
        msg = await ch.send({
          embeds: [embed],
          allowedMentions: reactionRolesService.NO_PING_MENTIONS,
        });
      } catch {
        return redirectIntegrations(res, communityId, "error", "rr_post_failed", "reaction-roles");
      }

      db.createReactionRolePanel(communityId, parsed.value, msg.id, title, description);
      req.audit({
        action: "reaction_roles.panel_create",
        targetType: "reaction_role_panel",
        targetId: msg.id,
        details: { channel_id: parsed.value, title },
      });
      invalidateCache(communityId);
      redirectIntegrations(res, communityId, "done", "rr_panel_created", "reaction-roles");
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
      const guildId = guildOf(req); // external: message-deletion channel lookup
      const communityId = communityOf(req); // repos + PRG link (integer)
      const messageId = field(bodyFields(req), "message_id");
      if (!messageId || messageId.length > MESSAGE_ID_MAX) {
        return redirectIntegrations(res, communityId, "error", "invalid_message_id", "reaction-roles");
      }

      const { removed, channel_id: channelId } = db.deleteReactionRolePanel(communityId, messageId);
      if (!removed) {
        return redirectIntegrations(res, communityId, "error", "rr_panel_not_found", "reaction-roles");
      }
      req.audit({
        action: "reaction_roles.panel_delete",
        targetType: "reaction_role_panel",
        targetId: messageId,
        details: { channel_id: channelId ?? null },
      });
      invalidateCache(communityId);

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
      redirectIntegrations(res, communityId, "done", "rr_panel_deleted", "reaction-roles");
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
      const guildId = guildOf(req); // external: role + emoji cache preflights
      const communityId = communityOf(req); // repos + PRG link (integer)
      const fields = bodyFields(req);
      const messageId = field(fields, "message_id");
      if (!messageId || messageId.length > MESSAGE_ID_MAX) {
        return redirectIntegrations(res, communityId, "error", "invalid_message_id", "reaction-roles");
      }
      if (!db.getReactionRolePanel(communityId, messageId)) {
        return redirectIntegrations(res, communityId, "error", "rr_panel_not_found", "reaction-roles");
      }
      const parsedRole = snowflakeOrEmpty(fields.role_id);
      if (!parsedRole.present || !parsedRole.ok) {
        return redirectIntegrations(res, communityId, "error", "invalid_role_id", "reaction-roles");
      }
      const level = field(fields, "level") === "" ? 0 : intInRange(fields.level, 0, 999999);
      if (level === null) {
        return redirectIntegrations(res, communityId, "error", "invalid_level", "reaction-roles");
      }
      const removable = parseBoolFlag(fields.removable, true);

      const guild = guildFromCache(guildId);
      if (guild) {
        const role = cachedRole(guild, parsedRole.value);
        if (!role) return redirectIntegrations(res, communityId, "error", "role_missing", "reaction-roles");
        if (role.managed) {
          return redirectIntegrations(res, communityId, "error", "rr_role_managed", "reaction-roles");
        }
      }

      const parsed = reactionRolesService.parseEmojiInput(fields.emoji);
      if (!parsed) return redirectIntegrations(res, communityId, "error", "rr_emoji_invalid", "reaction-roles");
      if (guild && reactionRolesService.validateEmojiForGuild(guild, parsed)) {
        return redirectIntegrations(res, communityId, "error", "rr_emoji_unavailable", "reaction-roles");
      }

      const existing = db.getReactionRoleOption(communityId, messageId, parsed.key);
      if (!existing && db.countReactionRoleOptions(communityId, messageId) >= reactionRolesService.MAX_OPTIONS_PER_PANEL) {
        return redirectIntegrations(res, communityId, "error", "rr_option_limit", "reaction-roles");
      }

      const enriched = enrichEmojiDisplay(guild, parsed);
      db.upsertReactionRoleOption(
        communityId,
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
      invalidateCache(communityId);

      // Best-effort embed/reaction refresh (slash awaits it inside its
      // ephemeral flow; the console redirects and never blocks on Discord).
      if (guild) {
        Promise.resolve()
          .then(() =>
            reactionRolesService.refreshPanelMessage(
              guild,
              db.getReactionRolePanel(communityId, messageId)
            )
          )
          .catch(() => {});
      }
      redirectIntegrations(res, communityId, "done", "rr_option_added", "reaction-roles");
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
      const guildId = guildOf(req); // external: emoji display cache enrichment
      const communityId = communityOf(req); // repos + PRG link (integer)
      const fields = bodyFields(req);
      const messageId = field(fields, "message_id");
      if (!messageId || messageId.length > MESSAGE_ID_MAX) {
        return redirectIntegrations(res, communityId, "error", "invalid_message_id", "reaction-roles");
      }
      if (!db.getReactionRolePanel(communityId, messageId)) {
        return redirectIntegrations(res, communityId, "error", "rr_panel_not_found", "reaction-roles");
      }
      const parsed = reactionRolesService.parseEmojiInput(fields.emoji);
      if (!parsed) return redirectIntegrations(res, communityId, "error", "rr_emoji_invalid", "reaction-roles");

      const guild = guildFromCache(guildId);
      const enriched = enrichEmojiDisplay(guild, parsed);
      const removed = db.deleteReactionRoleOption(communityId, messageId, enriched.key);
      if (!removed) {
        return redirectIntegrations(res, communityId, "error", "rr_option_not_found", "reaction-roles");
      }
      req.audit({
        action: "reaction_roles.option_remove",
        targetType: "reaction_role_panel",
        targetId: messageId,
        details: { emoji: enriched.display },
      });
      invalidateCache(communityId);

      if (guild) {
        Promise.resolve()
          .then(() =>
            reactionRolesService.refreshPanelMessage(
              guild,
              db.getReactionRolePanel(communityId, messageId)
            )
          )
          .catch(() => {});
      }
      redirectIntegrations(res, communityId, "done", "rr_option_removed", "reaction-roles");
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
      const guildId = guildOf(req); // external: channel cache preflight + audit target
      const communityId = communityOf(req); // settings repo + PRG link (integer)
      const parsed = snowflakeOrEmpty(bodyFields(req).channel_id);
      if (!parsed.ok) {
        return redirectIntegrations(res, communityId, "error", "invalid_channel_id", "reminders");
      }
      const value = parsed.value || null;
      if (value) {
        const guild = guildFromCache(guildId);
        if (guild) {
          const ch = cachedChannel(guild, value);
          if (!ch) return redirectIntegrations(res, communityId, "error", "channel_missing", "reminders");
          if (
            typeof ch.type === "number" &&
            ch.type !== CHANNEL_TYPE_GUILD_TEXT &&
            ch.type !== CHANNEL_TYPE_GUILD_ANNOUNCEMENT
          ) {
            return redirectIntegrations(res, communityId, "error", "er_channel_type", "reminders");
          }
        }
      }

      db.updateGuildSettings(communityId, { event_reminder_channel_id: value });
      req.audit({
        action: "event_reminders.channel_set",
        targetType: "guild",
        targetId: guildId,
        details: { channel_id: value },
      });
      invalidateCache(communityId);
      redirectIntegrations(
        res,
        communityId,
        "done",
        value ? "er_channel_set" : "er_channel_cleared",
        "reminders"
      );
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
      const guildId = guildOf(req); // external: channel preflight + warning post
      const communityId = communityOf(req); // repos + PRG link (integer)
      const parsed = snowflakeOrEmpty(bodyFields(req).channel_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, communityId, "error", "invalid_channel_id", "honeypot");
      }
      const fail = preflightChannel(guildFromCache(guildId), parsed.value);
      if (fail) return redirectIntegrations(res, communityId, "error", fail, "honeypot");
      if (db.isHoneypotChannel(communityId, parsed.value)) {
        return redirectIntegrations(res, communityId, "error", "hp_channel_exists", "honeypot");
      }

      db.addHoneypotChannel(communityId, parsed.value);
      req.audit({
        action: "honeypot.channel_add",
        targetType: "channel",
        targetId: parsed.value,
      });
      invalidateCache(communityId);

      const guild = guildFromCache(guildId);
      if (guild) {
        try {
          await ensureHoneypotWarning(guild, parsed.value);
        } catch {
          /* warning post is best-effort, exactly like the slash's status note */
        }
      }
      redirectIntegrations(res, communityId, "done", "hp_channel_added", "honeypot");
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
      const guildId = guildOf(req); // external: warning-message channel lookup
      const communityId = communityOf(req); // repos + PRG link (integer)
      const parsed = snowflakeOrEmpty(bodyFields(req).channel_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, communityId, "error", "invalid_channel_id", "honeypot");
      }

      const { removed, warning_message_id: warningMessageId } = db.removeHoneypotChannel(
        communityId,
        parsed.value
      );
      if (!removed) {
        return redirectIntegrations(res, communityId, "error", "hp_channel_not_found", "honeypot");
      }
      req.audit({
        action: "honeypot.channel_del",
        targetType: "channel",
        targetId: parsed.value,
      });
      invalidateCache(communityId);

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
      redirectIntegrations(res, communityId, "done", "hp_channel_removed", "honeypot");
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
      const guildId = guildOf(req); // external: @everyone id comparison + role cache
      const communityId = communityOf(req); // repos + PRG link (integer)
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, communityId, "error", "invalid_role_id", "honeypot");
      }
      if (parsed.value === guildId) {
        return redirectIntegrations(res, communityId, "error", "hp_role_everyone", "honeypot");
      }
      const guild = guildFromCache(guildId);
      if (guild) {
        const role = cachedRole(guild, parsed.value);
        if (!role) return redirectIntegrations(res, communityId, "error", "role_missing", "honeypot");
        if (role.managed) {
          return redirectIntegrations(res, communityId, "error", "hp_role_managed", "honeypot");
        }
      }
      if (db.isHoneypotBanRole(communityId, parsed.value)) {
        return redirectIntegrations(res, communityId, "error", "hp_banrole_exists", "honeypot");
      }

      db.addHoneypotBanRole(communityId, parsed.value);
      req.audit({
        action: "honeypot.ban_role_add",
        targetType: "role",
        targetId: parsed.value,
      });
      invalidateCache(communityId);
      redirectIntegrations(res, communityId, "done", "hp_banrole_added", "honeypot");
    }
  );

  /** POST .../honeypot/banrole/del — /honeypot banrole del (unknown ⇒ no audit). */
  mountMutation(
    "/g/:guildId/integrations/honeypot/banrole/del",
    "staff",
    (req, res) => {
      const communityId = communityOf(req); // repos + PRG link (integer)
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, communityId, "error", "invalid_role_id", "honeypot");
      }

      const removed = db.removeHoneypotBanRole(communityId, parsed.value);
      if (!removed) {
        return redirectIntegrations(res, communityId, "error", "hp_banrole_not_found", "honeypot");
      }
      req.audit({
        action: "honeypot.ban_role_del",
        targetType: "role",
        targetId: parsed.value,
      });
      invalidateCache(communityId);
      redirectIntegrations(res, communityId, "done", "hp_banrole_removed", "honeypot");
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
      const guildId = guildOf(req); // external: @everyone id comparison + role cache
      const communityId = communityOf(req); // staffRoles repo + PRG link (integer)
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, communityId, "error", "invalid_role_id", "honeypot");
      }
      if (parsed.value === guildId) {
        return redirectIntegrations(res, communityId, "error", "hp_role_everyone", "honeypot");
      }
      const fail = preflightRole(guildFromCache(guildId), parsed.value);
      if (fail) return redirectIntegrations(res, communityId, "error", fail, "honeypot");

      db.addStaffRole(communityId, parsed.value);
      req.audit({
        action: "staff.role_add",
        targetType: "role",
        targetId: parsed.value,
        details: { via: "honeypot.exempt" },
      });
      invalidateCache(communityId);
      redirectIntegrations(res, communityId, "done", "hp_exempt_added", "honeypot");
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
      const communityId = communityOf(req); // staffRoles repo + PRG link (integer)
      const parsed = snowflakeOrEmpty(bodyFields(req).role_id);
      if (!parsed.present || !parsed.ok) {
        return redirectIntegrations(res, communityId, "error", "invalid_role_id", "honeypot");
      }

      const removed = db.removeStaffRole(communityId, parsed.value);
      if (!removed) {
        return redirectIntegrations(res, communityId, "error", "hp_exempt_not_found", "honeypot");
      }
      req.audit({
        action: "staff.role_remove",
        targetType: "role",
        targetId: parsed.value,
        details: { via: "honeypot.exempt" },
      });
      invalidateCache(communityId);
      redirectIntegrations(res, communityId, "done", "hp_exempt_removed", "honeypot");
    }
  );

  // ---------------------------------------------------------------------
  // GET (Phase 1, unchanged behavior) — now also renders the write forms +
  // the PRG flash (whitelisted slugs only; the raw query value is dropped)
  // + the #644 section chrome: a whitelisted ?at= opens that section's
  // disclosures and moves the banner inside it (unknown/missing opens
  // nothing; the fragment never arrives, `at` carries the section).
  // ---------------------------------------------------------------------
  app.get(
    "/g/:guildId/integrations",
    requireTier("staff"),
    async (req, res) => {
      // Fluxer PR 2: the integrations read-model keys by integer community id.
      const communityId = req.guildAccess.communityId;
      // One cached per-community snapshot (§8.6 floor 30 s). Facade reads
      // happen inside the data module — never here.
      const snapshot = integrationsData.getIntegrations(communityId);
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
          section: readSectionAt(req.query),
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
