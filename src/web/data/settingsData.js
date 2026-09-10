/**
 * Settings read-model for GET /g/:guildId/settings (roadmap/web-admin.md
 * §8.6 "Settings: guild settings, command channels, logs channels,
 * cooldowns, decay | Staff | per-setting tier | 1 view" — subtask 18,
 * Phase 1 READ-ONLY).
 *
 * Query-budget contract (§8.6, review-blocking):
 *  - EXACTLY ONE bounded facade query per settings cluster:
 *      guild-settings row  → getGuildSettings(guildId)        (1 PK row)
 *      command channels    → listAllowedCommandChannels(gid)  (guild-scoped)
 *      level→role mappings → listLevelRoles(guildId)          (guild-scoped)
 *    No N+1, no full scans, no raw SQL in this file — the existing src/db
 *    facade helpers ONLY (repositories stay untouched/read-only here).
 *  - the assembled snapshot is cached per guild ≥ 30 s (same floor discipline
 *    as data/dashboardData.js); a second request inside the window issues
 *    ZERO queries (pinned by test/web-routes-settings.test.js).
 *  - NOTE (slash parity, not a bug): getGuildSettings AUTO-ENSURES the
 *    settings row (INSERT..ON CONFLICT) exactly like the slash /settings
 *    command does on first read — the web view never mutates config values.
 *
 * Secrets contract: the snapshot is BUILT BY WHITELIST — only the named
 * fields below ever leave this module, so a column added to guild_settings
 * tomorrow cannot leak through this page. Defense in depth:
 * {@link isSecretColumnName} flags token/secret/password-shaped column names
 * (guild_settings carries NONE today — the test asserts that against the
 * live row shape) and any such key found on the raw row is dropped before
 * assembly even for whitelisted groupings.
 *
 * Design: pure factory (db/now/ttl injectable, cache lookup-per-call so
 * monkey-patched facade methods are what actually run — same contract as
 * data/dashboardData.js).
 */


/**
 * Schema defaults mirrored for DISPLAY ONLY ("current vs default" column).
 * Source of truth: migration 001_base_schema.js column DEFAULTs + the
 * getGuildSettings() fallback row in src/db/repositories/guildSettings.js
 * (AGENTS.md: message 20 s / reaction 10 s). The test proves these match a
 * freshly-ensured settings row, so drift between the two fails loudly.
 */
const { DEFAULT_CACHE_TTL_MS, MIN_CACHE_TTL_MS, DEFAULT_MAX_ENTRIES, textOrNull, numOrNull, makeGuardRead, makeCacheSet } = require("./_shared");


const guardRead = makeGuardRead("settings");
const DEFAULTS = Object.freeze({
  msgXp: 5,
  reactionXp: 2,
  voiceXpPerMin: 1,
  msgCooldownSec: 20,
  reactionCooldownSec: 10,
  decayEnabled: true,
  decayMinMessages: 20,
  decayWindowDays: 7,
  decayPercent: 0.1,
  levelXpFactor: 100,
});

/** Column-name shapes that must NEVER reach an HTML page (§8.7 secrets). */
const SECRET_COLUMN_RE =
  /(?:token|secret|pass(?:word|wd)|credential|oauth|client_?id|api_?key|(^|_)key$|auth)/i;

/**
 * True when a column name looks like it carries a secret. Exported for the
 * test that pins the guild_settings row shape stays secret-free.
 * @param {string} name
 */
function isSecretColumnName(name) {
  return SECRET_COLUMN_RE.test(String(name));
}




/**
 * Whitelist-project ONE raw guild_settings row onto the view model,
 * dropping any secret-shaped column found on the row (defense in depth —
 * guild_settings has none today).
 * @param {object} row raw getGuildSettings row
 */
function projectSettingsRow(row) {
  for (const key of Object.keys(row)) {
    if (isSecretColumnName(key)) {
      // Loud but secret-safe: NAME only, never the value.
      console.warn(`[web] settings: refusing to surface secret-shaped column "${key}"`);
    }
  }
  return {
    msgXp: numOrNull(row.msg_xp),
    reactionXp: numOrNull(row.reaction_xp),
    voiceXpPerMin: numOrNull(row.voice_xp_per_min),
    levelXpFactor: numOrNull(row.level_xp_factor),
    msgCooldownSec: numOrNull(row.msg_cooldown_sec),
    reactionCooldownSec: numOrNull(row.reaction_cooldown_sec),
    decayEnabled: row.decay_enabled != null ? !!Number(row.decay_enabled) : null,
    decayMinMessages: numOrNull(row.decay_min_messages),
    decayWindowDays: numOrNull(row.decay_window_days),
    decayPercent: numOrNull(row.decay_percent),
    auditLogChannelId: textOrNull(row.audit_log_channel_id),
    messageLogChannelId: textOrNull(row.message_log_channel_id),
    warnLogChannelId: textOrNull(row.warn_log_channel_id),
    updatedAt: numOrNull(row.updated_at),
  };
}

/**
 * Pure factory for the per-guild cached settings read-model.
 * @param {object} [options]
 * @param {object} [options.db] src/db facade (looked up per call; tests
 *   inject a counting proxy)
 * @param {() => number} [options.now] clock (fake in tests)
 * @param {number} [options.ttlMs] cache TTL; default 30 s, hard floor 30 s
 *   (§8.6; tests may inject any value)
 * @param {number} [options.maxEntries] per-guild cache entry cap
 * @returns {{ getSettings: (guildId: string) => object, invalidate: (guildId?: string) => void, _cacheSizeForTests: () => number }}
 */
function createSettingsData(options = {}) {
  const facade = options.db || require("../../db");
  const now = options.now || Date.now;
  const ttlMs =
    options.ttlMs != null
      ? // explicit injection (tests/wiring) wins, clamped to sane bounds …
        Math.min(24 * 3600_000, Math.max(1, Math.floor(options.ttlMs)))
      : // … production default is the §8.6 floor.
        DEFAULT_CACHE_TTL_MS;
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.floor(options.maxEntries))
    : DEFAULT_MAX_ENTRIES;

  /** guildId → { data, cachedAt } (insertion-ordered bound, lazy expiry). */
  const cache = new Map();

  const cacheSet = makeCacheSet(cache, maxEntries);

  /**
   * ONE uncached assembly = exactly 3 bounded facade queries.
   * @param {string} guildId
   * @param {number} at clock ms for freshness math
   */
  function buildSnapshot(guildId, at) {
    const rowRes = guardRead(() => facade.getGuildSettings(guildId), "guild settings");
    const chansRes = guardRead(
      () => facade.listAllowedCommandChannels(guildId),
      "command channels"
    );
    const rolesRes = guardRead(() => facade.listLevelRoles(guildId), "level roles");

    const channelIds = Array.isArray(chansRes.value)
      ? chansRes.value
          .map((r) => textOrNull(r?.channel_id, 64))
          .filter((id) => id !== null)
      : [];
    const levelRoles = Array.isArray(rolesRes.value)
      ? rolesRes.value.map((r) => ({
          roleId: textOrNull(r?.role_id, 64),
          levelRequired: numOrNull(r?.level_required),
          dropGraceDays: numOrNull(r?.drop_grace_days),
        }))
      : [];

    return {
      guildId,
      guildSettings: rowRes.available
        ? projectSettingsRow(rowRes.value || {})
        : { available: false },
      commandChannels: {
        available: chansRes.available,
        ids: channelIds,
        // Mirrors core/permissions.commandsAllowed: EMPTY LIST ⇒ EVERYWHERE.
        everywhere: chansRes.available && channelIds.length === 0,
      },
      levelRoles: { available: rolesRes.available, rows: levelRoles },
      freshness: { generatedAt: at, fromCache: false, ageMs: 0 },
    };
  }

  /**
   * Current settings snapshot for one guild (sync; cached ≥30 s).
   * @param {string} guildId
   */
  function getSettings(guildId) {
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

  return { getSettings, invalidate, _cacheSizeForTests: () => cache.size };
}

module.exports = {
  DEFAULTS,
  MIN_CACHE_TTL_MS,
  SECRET_COLUMN_RE,
  isSecretColumnName,
  projectSettingsRow,
  createSettingsData,
};
