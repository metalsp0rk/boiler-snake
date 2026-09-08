/**
 * Integrations read-model for GET /g/:guildId/integrations (roadmap/
 * web-admin.md §8.6 "Integrations: YouTube, Twitch, reaction roles, event
 * reminders, honeypot | Staff | per-command tier (/honeypot exempt = Admin)
 * | 1 view · 2 write" — subtask 20, Phase 1 READ-ONLY).
 *
 * Query-budget contract (§8.6, review-blocking):
 *  - every facade helper is guild-scoped: the FIRST positional argument of
 *    all nine reads is always req.guildAccess.guildId (pinned by
 *    test/web-routes-integrations.test.js — no cross-guild leakage);
 *  - the snapshot is assembled from EXISTING repository helpers only —
 *    src/db/repositories/* stay untouched (read-only facade use):
 *      getGuildSettings             (1 PK row; shared config source for
 *                                    the YouTube / Twitch / reminder panels)
 *      getYoutubeChannels           (guild-scoped)
 *      getTwitchChannels            (guild-scoped)
 *      listReactionRolePanels       (guild-scoped)
 *      countReactionRoleOptions   × displayed panels (indexed COUNT, capped)
 *      listEventReminderConfigs   (guild-scoped, activeOnly — slash parity
 *                                    with /eventreminder list)
 *      listHoneypotChannels · listHoneypotBanRoles · listHoneypotExemptRoles
 *  - §8.6 list cap ≤100 enforced HERE by slicing: the guild-scoped helpers
 *    above carry no LIMIT clause (flagged for the Phase 2 helper work —
 *    the page never renders more than the caps below regardless);
 *  - the assembled snapshot is cached per guild ≥ 30 s (same floor as
 *    data/settingsData.js); a hit issues ZERO queries;
 *  - reaction-role option counts reuse countReactionRoleOptions PER PANEL
 *    (an indexed point COUNT, not a scan). A single GROUP BY panel helper
 *    would avoid the loop entirely — none exists in the repository today
 *    and repositories are out of scope here, so the loop is CAPPED to the
 *    displayed panels (≤30) instead of adding SQL;
 *  - NOTE (slash parity, not a bug): getGuildSettings AUTO-ENSURES the
 *    settings row exactly like every slash /…settings read does (same
 *    behaviour data/settingsData.js documents).
 *
 * Secrets contract (§8.7): API keys / client secrets live ONLY in the
 * environment — never in these tables and never in this snapshot. The env
 * check contributes two booleans plus the NAMES of missing variables
 * (mirroring the features' own operator messages); values are never read,
 * copied, or rendered. Guild-settings fields are whitelist-projected too,
 * and isSecretColumnName (the settingsData guard, reused not forked) gets a
 * defense-in-depth pass over the raw row shape.
 *
 * Design: pure factory (db/now/ttl/env injectable, cache lookup-per-call so
 * monkey-patched facade methods are what actually run — settingsData twin).
 */

const { isSecretColumnName } = require("./settingsData");

/** §8.6 floor: per-guild cache ≥ 30 s. */
const DEFAULT_CACHE_TTL_MS = 30_000;
const MIN_CACHE_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 200;

/** §8.6 list budget: no panel of this page ever renders more than 100 rows. */
const LIST_CAP = 100;
/**
 * Panels displayed (and therefore the hard bound on the per-panel option
 * COUNT loop): reaction-role panels are one per posted message, so 30 is
 * generous for any real guild while keeping the uncached assembly ≤ ~39
 * indexed queries.
 */
const PANEL_CAP = 30;

/** Schema defaults for the config fields shown (display notes only). */
const DEFAULTS = Object.freeze({
  youtubePollingIntervalMinutes: 5,
  twitchPollingIntervalMinutes: 2,
});

/** Defensive text read: trim + cap, non-strings → null (settingsData twin). */
function textOrNull(value, max = 100) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Finite-number read (null when absent/non-finite). */
function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Guarded facade read: a failing cluster degrades to { available:false }
 * instead of 500ing the whole page (same discipline as settingsData).
 * @param {() => unknown} read
 * @param {string} label static label for the loud log
 */
function guardRead(read, label) {
  try {
    return { available: true, value: read() };
  } catch (err) {
    console.warn(
      `[web] integrations: ${label} read failed:`,
      err?.code || err?.name || err?.message || "unknown"
    );
    return { available: false, value: null };
  }
}

/**
 * Environment gate for YouTube — mirrors src/features/youtube/ticker.js
 * ("YOUTUBE_API_KEY not configured - live notifications disabled"). The
 * presence of the variable is read; its VALUE never is.
 * @param {NodeJS.ProcessEnv} env
 */
function youtubeEnvState(env) {
  const present = typeof env.YOUTUBE_API_KEY === "string" && env.YOUTUBE_API_KEY.trim() !== "";
  return {
    enabled: present,
    missingVars: present ? [] : ["YOUTUBE_API_KEY"],
    disabledReason: present
      ? null
      : "Disabled — YOUTUBE_API_KEY not configured; YouTube notifications stay off until the environment provides it.",
  };
}

/**
 * Environment gate for Twitch — mirrors the feature's own operator message
 * (src/features/twitch/index.js): "Twitch is not configured on this bot.
 * Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` first." The reason
 * names ONLY the variables that are actually missing. Values never read.
 * @param {NodeJS.ProcessEnv} env
 */
function twitchEnvState(env) {
  const missing = [];
  if (!(typeof env.TWITCH_CLIENT_ID === "string" && env.TWITCH_CLIENT_ID.trim() !== "")) {
    missing.push("TWITCH_CLIENT_ID");
  }
  if (!(typeof env.TWITCH_CLIENT_SECRET === "string" && env.TWITCH_CLIENT_SECRET.trim() !== "")) {
    missing.push("TWITCH_CLIENT_SECRET");
  }
  const present = missing.length === 0;
  return {
    enabled: present,
    missingVars: missing,
    disabledReason: present
      ? null
      : `Twitch is not configured on this bot. Set \`${missing.join("` and `")}\` first.`,
  };
}

/** List cap + honest truncation flags for the view. */
function capRows(rows, cap) {
  const list = Array.isArray(rows) ? rows : [];
  return { shown: list.slice(0, cap), total: list.length, truncated: list.length > cap };
}

// ---------------------------------------------------------------------------
// Whitelist projections (only these named fields ever leave the module)
// ---------------------------------------------------------------------------

function projectYoutubeRow(row) {
  return {
    id: textOrNull(row?.id, 64),
    channelName: textOrNull(row?.channel_name, 120),
    channelUrl: textOrNull(row?.channel_url, 300),
    lastVideoId: textOrNull(row?.last_video_id, 64),
    lastChecked: numOrNull(row?.last_checked),
  };
}

function projectTwitchRow(row) {
  return {
    broadcasterId: textOrNull(row?.broadcaster_id, 64),
    login: textOrNull(row?.login, 100),
    displayName: textOrNull(row?.display_name, 100),
    isLive: !!Number(row?.is_live ?? 0),
    lastStreamId: textOrNull(row?.last_stream_id, 64),
    lastChecked: numOrNull(row?.last_checked),
  };
}

function projectPanelRow(row) {
  return {
    channelId: textOrNull(row?.channel_id, 64),
    messageId: textOrNull(row?.message_id, 64),
    title: textOrNull(row?.title, 150),
    description: textOrNull(row?.description, 240),
  };
}

/**
 * Reminder config → view row. "Next fire" is derived from the offsets the
 * repository ALREADY attached (min fire_at among unsent) — no Discord
 * fetch, no clock math beyond reading the stored rows.
 */
function projectReminderConfig(row) {
  const offsets = Array.isArray(row?.offsets) ? row.offsets : [];
  let unsent = 0;
  let nextFireAt = null;
  for (const off of offsets) {
    if (off?.sent_at == null) {
      unsent += 1;
      const at = numOrNull(off?.fire_at);
      if (at != null && (nextFireAt == null || at < nextFireAt)) nextFireAt = at;
    }
  }
  return {
    id: numOrNull(row?.id),
    scheduledEventId: textOrNull(row?.scheduled_event_id, 64),
    shortname: textOrNull(row?.shortname, 80),
    roleId: textOrNull(row?.role_id, 64),
    channelId: textOrNull(row?.channel_id, 64),
    persistent: !!Number(row?.persistent ?? 0),
    // Custom template content is operator prose — surface presence only,
    // never the body (the slash list never echoes it either).
    hasCustomTemplate: row?.message_template != null,
    offsetCount: offsets.length,
    unsentCount: unsent,
    sentCount: offsets.length - unsent,
    nextFireAt,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Pure factory for the per-guild cached integrations read-model.
 * @param {object} [options]
 * @param {object} [options.db] src/db facade (looked up per call; tests
 *   inject a counting proxy)
 * @param {() => number} [options.now] clock (fake in tests)
 * @param {number} [options.ttlMs] cache TTL; default 30 s, §8.6 floor 30 s
 *   (injected values clamp to [1, 24 h] like settingsData)
 * @param {number} [options.maxEntries] per-guild cache entry cap
 * @param {NodeJS.ProcessEnv} [options.env] env source for the
 *   configured-vs-effective gate (default process.env — presence checked
 *   ONLY, never the values)
 * @returns {{ getIntegrations: (guildId: string) => object, invalidate: (guildId?: string) => void, _cacheSizeForTests: () => number }}
 */
function createIntegrationsData(options = {}) {
  const facade = options.db || require("../../db");
  const now = options.now || Date.now;
  const env = options.env || process.env;
  const ttlMs =
    options.ttlMs != null
      ? Math.min(24 * 3600_000, Math.max(1, Math.floor(options.ttlMs)))
      : DEFAULT_CACHE_TTL_MS;
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.floor(options.maxEntries))
    : DEFAULT_MAX_ENTRIES;

  /** guildId → { data, cachedAt } (insertion-ordered bound, lazy expiry). */
  const cache = new Map();

  function cacheSet(key, entry) {
    cache.set(key, entry);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  /**
   * ONE uncached assembly: 8 fixed guild-scoped facade reads + one indexed
   * option COUNT per displayed panel (≤ PANEL_CAP).
   * @param {string} guildId
   * @param {number} at clock ms for freshness math
   */
  function buildSnapshot(guildId, at) {
    const gsRes = guardRead(() => facade.getGuildSettings(guildId), "guild settings");
    const ytRes = guardRead(() => facade.getYoutubeChannels(guildId), "youtube channels");
    const twRes = guardRead(() => facade.getTwitchChannels(guildId), "twitch channels");
    const panelsRes = guardRead(
      () => facade.listReactionRolePanels(guildId),
      "reaction role panels"
    );
    const remindersRes = guardRead(
      () => facade.listEventReminderConfigs(guildId, { activeOnly: true }),
      "event reminder configs"
    );
    const hpChRes = guardRead(() => facade.listHoneypotChannels(guildId), "honeypot channels");
    const hpBanRes = guardRead(() => facade.listHoneypotBanRoles(guildId), "honeypot ban roles");
    const hpExRes = guardRead(
      () => facade.listHoneypotExemptRoles(guildId),
      "honeypot exempt (staff) roles"
    );

    // Defense in depth (§8.7): guild_settings carries no secret-shaped
    // column today (pinned in the test); if one appears, name it loudly and
    // keep it out of every projection below.
    const gsRow = gsRes.value || {};
    if (gsRes.available) {
      for (const key of Object.keys(gsRow)) {
        if (isSecretColumnName(key)) {
          console.warn(`[web] integrations: refusing to surface secret-shaped column "${key}"`);
        }
      }
    }

    // ---- YouTube (env gate + guild_settings config + subscription rows) ---
    const ytEnv = youtubeEnvState(env);
    const ytCap = capRows(ytRes.value, LIST_CAP);

    // ---- Twitch -----------------------------------------------------------
    const twEnv = twitchEnvState(env);
    const twCap = capRows(twRes.value, LIST_CAP);

    // ---- Reaction roles (panels + per-panel indexed option COUNT) ---------
    const panelsCap = capRows(panelsRes.value, PANEL_CAP);
    const panels = panelsCap.shown.map((row) => {
      const panel = projectPanelRow(row);
      let optionCount = null;
      if (panelsRes.available && panel.messageId) {
        // Count failures degrade THAT panel's count to "—", never the page.
        const res = guardRead(
          () => facade.countReactionRoleOptions(guildId, panel.messageId),
          `reaction role options (${panel.messageId})`
        );
        optionCount = res.available ? numOrNull(res.value) : null;
      }
      return { ...panel, optionCount };
    });

    // ---- Event reminders (configs the ticker ALREADY computed state for) --
    const remCap = capRows(remindersRes.value, LIST_CAP);

    // ---- Honeypot (channels + ban roles; exempt == staff_roles) -----------
    const hpChCap = capRows(hpChRes.value, LIST_CAP);
    const hpBanCap = capRows(hpBanRes.value, LIST_CAP);
    const hpExCap = capRows(hpExRes.value, LIST_CAP);

    return {
      guildId,
      youtube: {
        available: ytRes.available && gsRes.available,
        ...ytEnv,
        notifyChannelId: gsRes.available ? textOrNull(gsRow.youtube_notification_channel_id, 64) : null,
        pollIntervalMinutes: gsRes.available
          ? numOrNull(gsRow.youtube_polling_interval_minutes)
          : null,
        uploadRoleId: gsRes.available ? textOrNull(gsRow.youtube_upload_role_id, 64) : null,
        rows: ytCap.shown.map(projectYoutubeRow),
        total: ytCap.total,
        truncated: ytCap.truncated,
      },
      twitch: {
        available: twRes.available && gsRes.available,
        ...twEnv,
        notifyChannelId: gsRes.available ? textOrNull(gsRow.twitch_notification_channel_id, 64) : null,
        notifyRoleId: gsRes.available ? textOrNull(gsRow.twitch_notify_role_id, 64) : null,
        pollIntervalMinutes: gsRes.available
          ? numOrNull(gsRow.twitch_polling_interval_minutes)
          : null,
        rows: twCap.shown.map(projectTwitchRow),
        total: twCap.total,
        truncated: twCap.truncated,
      },
      reactionRoles: {
        available: panelsRes.available,
        panels,
        total: panelsCap.total,
        truncated: panelsCap.truncated,
      },
      eventReminders: {
        available: remindersRes.available && gsRes.available,
        defaultChannelId: gsRes.available
          ? textOrNull(gsRow.event_reminder_channel_id, 64)
          : null,
        configs: remCap.shown.map(projectReminderConfig),
        total: remCap.total,
        truncated: remCap.truncated,
      },
      honeypot: {
        channels: {
          available: hpChRes.available,
          rows: hpChCap.shown.map((r) => ({
            channelId: textOrNull(r?.channel_id, 64),
            warningMessageId: textOrNull(r?.warning_message_id, 64),
          })),
          truncated: hpChCap.truncated,
        },
        banRoles: {
          available: hpBanRes.available,
          roleIds: hpBanCap.shown
            .map((r) => textOrNull(r?.role_id, 64))
            .filter((id) => id !== null),
          truncated: hpBanCap.truncated,
        },
        exemptRoles: {
          available: hpExRes.available,
          rows: hpExCap.shown.map((r) => ({
            roleId: textOrNull(r?.role_id, 64),
            level: textOrNull(r?.level, 16),
          })),
          truncated: hpExCap.truncated,
        },
      },
      freshness: { generatedAt: at, fromCache: false, ageMs: 0 },
    };
  }

  /**
   * Current integrations snapshot for one guild (sync; cached ≥30 s).
   * @param {string} guildId
   */
  function getIntegrations(guildId) {
    const at = now();
    const hit = cache.get(guildId);
    if (hit && at - hit.cachedAt < ttlMs) {
      return {
        ...hit.data,
        freshness: {
          generatedAt: hit.data.freshness.generatedAt,
          fromCache: true,
          ageMs: Math.max(0, at - hit.cachedAt),
        },
      };
    }
    const data = buildSnapshot(guildId, at);
    cacheSet(guildId, { data, cachedAt: at });
    return data;
  }

  /** Drop one guild's (or all) cached snapshots — Phase 2 write hooks call this. */
  function invalidate(guildId) {
    if (guildId === undefined) cache.clear();
    else cache.delete(guildId);
  }

  return { getIntegrations, invalidate, _cacheSizeForTests: () => cache.size };
}

module.exports = {
  DEFAULTS,
  LIST_CAP,
  PANEL_CAP,
  MIN_CACHE_TTL_MS,
  DEFAULT_CACHE_TTL_MS,
  youtubeEnvState,
  twitchEnvState,
  projectReminderConfig,
  createIntegrationsData,
};
