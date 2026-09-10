/**
 * Voice & music read-model for GET /g/:guildId/voice (roadmap/web-admin.md
 * §8.6 "Voice & Music: now-playing, queue VIEW only | Staff | none (control
 * out of scope) | 1" — subtask 21, Phase 1 READ-ONLY).
 *
 * Query-budget contract (§8.6, review-blocking):
 *  - the DB sections are TWO bounded facade reads per uncached assembly:
 *      current voice sessions → voice_sessions, ONE parameterized
 *                             `WHERE guild_id = ? … LIMIT ≤ SESSIONS_CAP`
 *                             PK-prefix read (see readVoiceSessions for why
 *                             the facade `db` handle is used directly), and
 *      voice-XP config row    → getGuildSettings(guildId)  (1 PK row)
 *    cache hit issues ZERO queries; the whole snapshot is cached per guild
 *    for DEFAULT_CACHE_TTL_MS (30 s — the §8.6 floor and far above the ≥5 s
 *    cache the subtask requires; a hit ALSO skips both runtime providers, so
 *    the request path never fans out to Lavalink or Discord per hit);
 *  - the live-voice and music sections are PURE cache/memory reads of the
 *    running client (voiceStates cache / lavalink-client player state).
 *    They are injected providers exactly like data/dashboardData.js
 *    getNowPlaying: unwired ⇒ "unavailable", throwing ⇒ degraded, never a
 *    fabricated state, NEVER a REST fetch and NEVER a player/manager
 *    creation or connection attempt (only getManager/isNodeReady/getPlayer
 *    state inspection — the same seam surface dashboardData's exported
 *    snapshotMusicPlayer uses; that seam is REUSED in spirit, its status
 *    strings mirrored 1:1, and this module never imports the bot runtime
 *    except through the lazily-required musicApi default parameter).
 *
 * DATA-SOURCE NOTES (report, 2026-09-08):
 *  1. voice_sessions stores ONLY the current session per (guild, user) —
 *     rows are upserted on join/move and deleted on leave (repository
 *     inspected). "Recent activity" therefore means CURRENT sessions with
 *     elapsed minutes; a historical per-user voice-minute summary would
 *     need a NEW bounded activity_log aggregate helper (kind='voice_minute')
 *     — repositories are READ-ONLY here (dashboardData gap 3 flagged the
 *     same: a `listVoiceSessions(guildId)` helper is the missing piece), so
 *     the per-guild session list is read via the facade's exported `db`
 *     handle with a parameterized, guild-scoped, LIMIT-capped statement.
 *  2. Live connected humans come ONLY from the cache-only client seam
 *     (guild.voiceStates cache — the exact same source the voice ticker
 *     iterates). No intents/data ⇒ "live state unavailable", never a fetch.
 *  3. Music control (skip/pause/stop/…) is OUT of v1 scope (§8.9) — this
 *     module exposes state inspection ONLY.
 *
 * Secrets contract (§8.7): whitelist projections only; the settingsData
 * isSecretColumnName guard (reused, not forked) runs over the raw
 * guild_settings row shape as defense in depth.
 *
 * Design: pure factory (db/now/ttl/providers injectable, cache lookup-per-
 * call so monkey-patched facade methods are what actually run — settings-
 * Data/integrationsData twin; async getVoice mirrors dashboardData).
 */

const { isSecretColumnName } = require("./settingsData");
const { DEFAULT_CACHE_TTL_MS, MIN_CACHE_TTL_MS, DEFAULT_MAX_ENTRIES, textOrNull, numOrNull, makeGuardRead, makeCacheSet } = require("./_shared");

const guardRead = makeGuardRead("voice");


/** §8.6 list cap: the session panel never renders or reads more. */
const SESSIONS_CAP = 100;
/** Slash parity: /music queue shows 10 upcoming tracks (render.js queueEmbed). */
const QUEUE_DISPLAY_CAP = 10;
/** Live-channel cap (a guild can show at most this many voice channels). */
const LIVE_CHANNEL_CAP = 50;

/** Statuses the view renders for the music section (dashboardData mirror). */
const MUSIC_STATUSES = Object.freeze(["playing", "idle", "unavailable", "unknown"]);

const LIVE_UNAVAILABLE_DETAIL = "live state unavailable";



/** Non-negative integer read (null when absent/non-finite/negative). */
function nonNegNumOrNull(value) {
  const n = numOrNull(value);
  return n == null || n < 0 ? null : Math.floor(n);
}


/**
 * ONE bounded, guild-scoped, parameterized session read (see module header,
 * data-source note 1): the voice_sessions PK is (guild_id, user_id), so
 * WHERE guild_id = ? is a PK-prefix scan bounded by the guild's CONNECTED
 * users (rows live only while a user is connected), and the LIMIT keeps the
 * §8.6 cap even for absurd fixtures. Repositories stay untouched.
 * @param {object} facade src/db facade (exports the better-sqlite3 handle)
 * @param {string} guildId
 * @param {number} cap
 */
function readVoiceSessions(facade, guildId, cap) {
  const handle = facade && facade.db;
  if (!handle || typeof handle.prepare !== "function") {
    throw new TypeError("voice sessions read needs the facade db handle");
  }
  return handle
    .prepare(
      `SELECT guild_id, user_id, channel_id, joined_at
       FROM voice_sessions
       WHERE guild_id = ?
       ORDER BY joined_at DESC
       LIMIT ?`
    )
    .all(guildId, cap);
}

/**
 * One session row → the view model. `minutesConnected` is the CURRENT
 * session's elapsed whole minutes (now − joined_at, clamped ≥ 0); joined_at
 * in the future (clock skew) renders 0 with the honest joined-stamp.
 * @param {object} row raw voice_sessions row
 * @param {number} at build clock ms
 */
function projectSessionRow(row, at) {
  const joinedAt = nonNegNumOrNull(row?.joined_at);
  let minutesConnected = null;
  if (joinedAt != null) {
    minutesConnected = Math.max(0, Math.floor((at - joinedAt) / 60_000));
  }
  return {
    userId: textOrNull(row?.user_id, 64),
    channelId: textOrNull(row?.channel_id, 64),
    joinedAt,
    minutesConnected,
  };
}

/**
 * Pure mirror of src/features/voice/index.js isMutedOrDeafened (verified
 * 2026-09-08; kept local so this module never loads the feature runtime).
 */
function isMutedOrDeafened(voiceState) {
  return !!(
    voiceState?.selfMute ||
    voiceState?.serverMute ||
    voiceState?.selfDeaf ||
    voiceState?.serverDeaf
  );
}

// ---------------------------------------------------------------------------
// Runtime providers (cache/memory reads; injectable)
// ---------------------------------------------------------------------------

/**
 * Cache-only LIVE voice snapshot from the bot client's voiceStates cache —
 * the exact same source the voice ticker iterates (features/voice/index.js).
 * Connection rules mirrored from the ticker (AGENTS.md §Intentions 2):
 * AFK-channel members and muted/deafened members are NOT XP-eligible; a
 * channel "earns" only with ≥ 2 eligible humans. EVERY read is memory-cache
 * only — a missing client/guild/intent data degrades to
 * `{ available:false, detail:"live state unavailable" }`; this NEVER fetches
 * over REST and NEVER throws (fixed detail only, §8.7).
 *
 * @param {object|null} client discord.js client (or a test fake)
 * @param {string} guildId
 */
function snapshotLiveVoice(client, guildId) {
  try {
    if (!client) return { available: false, detail: LIVE_UNAVAILABLE_DETAIL };
    const guild = client.guilds?.cache?.get?.(guildId);
    const voiceStates = guild?.voiceStates?.cache;
    if (!guild || !voiceStates || typeof voiceStates.values !== "function") {
      return { available: false, detail: LIVE_UNAVAILABLE_DETAIL };
    }

    const byChannel = new Map();
    for (const vs of voiceStates.values()) {
      const channelId = vs?.channelId;
      if (!channelId) continue;
      const member = vs?.member || guild.members?.cache?.get?.(vs?.id ?? "") || null;
      if (member?.user?.bot) continue; // humans only

      let bucket = byChannel.get(channelId);
      if (!bucket) {
        bucket = { humans: 0, afk: 0, mutedOrDeaf: 0, eligible: 0 };
        byChannel.set(channelId, bucket);
      }
      bucket.humans += 1;

      const isAfk = !!guild.afkChannelId && channelId === guild.afkChannelId;
      if (isAfk) bucket.afk += 1;
      if (isMutedOrDeafened(vs)) bucket.mutedOrDeaf += 1;
      if (!isAfk && !isMutedOrDeafened(vs)) bucket.eligible += 1;
    }

    const channels = [...byChannel.entries()]
      .map(([channelId, b]) => ({
        channelId,
        humans: b.humans,
        afk: b.afk,
        mutedOrDeaf: b.mutedOrDeaf,
        eligible: b.eligible,
        earning: b.eligible >= 2, // voice rule: ≥2 eligible humans per channel
      }))
      .sort((a, b) => b.humans - a.humans || String(a.channelId).localeCompare(String(b.channelId)))
      .slice(0, LIVE_CHANNEL_CAP);

    const totals = channels.reduce(
      (acc, c) => ({
        humans: acc.humans + c.humans,
        eligible: acc.eligible + c.eligible,
      }),
      { humans: 0, eligible: 0 }
    );

    return {
      available: true,
      channels,
      truncated: byChannel.size > LIVE_CHANNEL_CAP,
      totals,
      afkChannelId: textOrNull(guild.afkChannelId, 64),
    };
  } catch {
    // Fixed detail only — voice-state errors could carry internals (§8.7).
    return { available: false, detail: LIVE_UNAVAILABLE_DETAIL };
  }
}

/** Clamp helper for numeric queue fields. */
function clampNonNeg(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** One lavalink track → view row (never invents a title — render.js twin). */
function projectTrackRow(track, position) {
  const info = track?.info || {};
  const requesterId = track?.requester?.id;
  return {
    position,
    title: textOrNull(info.title, 200) ?? "Unknown track",
    author: textOrNull(info.author, 120) ?? "Unknown",
    durationMs: clampNonNeg(info.duration) ?? 0,
    isStream: !!info.isStream,
    requesterId:
      typeof requesterId === "string" || typeof requesterId === "number"
        ? textOrNull(String(requesterId), 64)
        : null,
  };
}

/**
 * Now-playing + queue snapshot read from the music feature's LIVE PLAYER
 * STATE ONLY (lavalink-client keeps queue/position in process memory — this
 * performs no Lavalink REST round-trip, opens no connection and never calls
 * tryCreateManager). The status ladder and detail strings MIRROR
 * dashboardData.snapshotMusicPlayer (subtask 14 seam) 1:1 so both pages
 * speak the same honest language:
 *   no client             → unknown  "no client wired"
 *   no manager            → unavailable "lavalink not configured"
 *   node down             → unavailable "no lavalink node connected"
 *   no player             → idle      "no active player in this guild"
 * plus the queue section (≤ QUEUE_DISPLAY_CAP rows, slash /music queue
 * parity) whenever a player object exists. EVERY failure mode degrades;
 * lavalink-down is normal; this NEVER throws.
 *
 * @param {object|null} client discord.js client (or a test fake)
 * @param {string} guildId
 * @param {{getManager: Function, isNodeReady: Function}} [musicApi]
 *   defaults to src/features/music/lavalink.js (test seam, same as
 *   dashboardData's snapshotMusicPlayer)
 */
function snapshotMusicState(client, guildId, musicApi = require("../../features/music/lavalink")) {
  try {
    if (!client) return { status: "unknown", detail: "no client wired" };
    const manager = musicApi.getManager(client);
    if (!manager) return { status: "unavailable", detail: "lavalink not configured" };
    if (!musicApi.isNodeReady(client)) {
      return { status: "unavailable", detail: "no lavalink node connected" };
    }
    const player = manager.getPlayer?.(guildId) || null;
    if (!player) return { status: "idle", detail: "no active player in this guild" };

    const current = player.queue?.current || null;
    const status = current ? "playing" : "idle";
    const detail = current ? null : "queue empty";

    const nowPlaying = current
      ? {
          ...projectTrackRow(current, 0),
          paused: !!player.paused,
          positionMs: clampNonNeg(player.position) ?? 0,
        }
      : null;

    const tracks = Array.isArray(player.queue?.tracks) ? player.queue.tracks : [];
    const queue = {
      rows: tracks.slice(0, QUEUE_DISPLAY_CAP).map((t, i) => projectTrackRow(t, i + 1)),
      total: tracks.length,
      truncated: tracks.length > QUEUE_DISPLAY_CAP,
      volume: clampNonNeg(player.volume),
      voiceChannelId: textOrNull(player.voiceChannelId, 64),
    };

    return { status, detail, nowPlaying, queue };
  } catch {
    // Music state must never break the page — degrade to unknown.
    return { status: "unknown", detail: "player read failed" };
  }
}

/**
 * Provider factories used by the route's DEFAULT data instance: they wrap
 * the injectable getClient seam (may be null / may THROW) around the pure
 * snapshots above, so even a throwing seam degrades instead of 500ing.
 * @param {(() => any)|null|undefined} getClient
 */
function makeMusicStateAccessor(getClient, musicApi) {
  return function getMusicState(guildId) {
    try {
      const client = typeof getClient === "function" ? getClient() : null;
      return snapshotMusicState(client, guildId, musicApi);
    } catch {
      return { status: "unknown", detail: "player read failed" };
    }
  };
}

/** @see makeMusicStateAccessor — same cache-only contract. */
function makeLiveVoiceAccessor(getClient) {
  return function getLiveVoice(guildId) {
    try {
      const client = typeof getClient === "function" ? getClient() : null;
      return snapshotLiveVoice(client, guildId);
    } catch {
      return { available: false, detail: LIVE_UNAVAILABLE_DETAIL };
    }
  };
}

// ---------------------------------------------------------------------------
// Provider-result normalization (never trust the injected provider's shape)
// ---------------------------------------------------------------------------

/** Normalize the injected music-provider result to the view contract. */
function normalizeMusic(raw) {
  if (raw == null) {
    return { status: "unavailable", detail: "not wired" };
  }
  if (typeof raw !== "object") return { status: "unknown" };
  const status = MUSIC_STATUSES.includes(raw.status) ? raw.status : "unknown";
  const out = { status, detail: textOrNull(raw.detail, 160) };
  const np = raw.nowPlaying;
  if (np && typeof np === "object") {
    out.nowPlaying = {
      title: textOrNull(np.title, 200) ?? "Unknown track",
      author: textOrNull(np.author, 120) ?? "Unknown",
      durationMs: clampNonNeg(np.durationMs) ?? 0,
      positionMs: clampNonNeg(np.positionMs) ?? 0,
      isStream: !!np.isStream,
      paused: !!np.paused,
      requesterId: textOrNull(np.requesterId, 64),
    };
  }
  const q = raw.queue;
  if (q && typeof q === "object") {
    const rows = (Array.isArray(q.rows) ? q.rows : [])
      .slice(0, QUEUE_DISPLAY_CAP)
      .map((r, i) => ({
        position: clampNonNeg(r?.position) ?? i + 1,
        title: textOrNull(r?.title, 200) ?? "Unknown track",
        author: textOrNull(r?.author, 120) ?? "Unknown",
        durationMs: clampNonNeg(r?.durationMs) ?? 0,
        isStream: !!r?.isStream,
        requesterId: textOrNull(r?.requesterId, 64),
      }));
    const total = clampNonNeg(q.total) ?? rows.length;
    out.queue = {
      rows,
      total,
      truncated: !!q.truncated || total > QUEUE_DISPLAY_CAP,
      volume: clampNonNeg(q.volume),
      voiceChannelId: textOrNull(q.voiceChannelId, 64),
    };
  }
  return out;
}

/** Normalize the injected live-voice provider result to the view contract. */
function normalizeLive(raw) {
  if (raw == null || typeof raw !== "object") {
    return { available: false, detail: LIVE_UNAVAILABLE_DETAIL };
  }
  if (!raw.available) {
    return { available: false, detail: textOrNull(raw.detail, 160) || LIVE_UNAVAILABLE_DETAIL };
  }
  const channels = (Array.isArray(raw.channels) ? raw.channels : [])
    .slice(0, LIVE_CHANNEL_CAP)
    .map((c) => ({
      channelId: textOrNull(c?.channelId, 64),
      humans: clampNonNeg(c?.humans) ?? 0,
      afk: clampNonNeg(c?.afk) ?? 0,
      mutedOrDeaf: clampNonNeg(c?.mutedOrDeaf) ?? 0,
      eligible: clampNonNeg(c?.eligible) ?? 0,
      earning: !!c?.earning && (clampNonNeg(c?.eligible) ?? 0) >= 2,
    }))
    .filter((c) => c.channelId !== null);
  return {
    available: true,
    channels,
    truncated: !!raw.truncated || channels.length >= LIVE_CHANNEL_CAP,
    totals: {
      humans: clampNonNeg(raw.totals?.humans) ?? channels.reduce((n, c) => n + c.humans, 0),
      eligible:
        clampNonNeg(raw.totals?.eligible) ?? channels.reduce((n, c) => n + c.eligible, 0),
    },
    afkChannelId: textOrNull(raw.afkChannelId, 64),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Pure factory for the per-guild cached voice & music read-model.
 * @param {object} [options]
 * @param {object} [options.db] src/db facade (looked up per call; tests
 *   inject a counting proxy)
 * @param {() => number} [options.now] clock (fake in tests)
 * @param {number} [options.ttlMs] cache TTL; default 30 s, §8.6 floor
 *   (injected values clamp to [1, 24 h] like settingsData)
 * @param {number} [options.maxEntries] per-guild cache entry cap
 * @param {(guildId: string) => unknown|Promise<unknown>} [options.getMusicState]
 *   player-state provider (default null → "unavailable / not wired")
 * @param {(guildId: string) => unknown|Promise<unknown>} [options.getLiveVoice]
 *   live voiceStates provider (default null → "live state unavailable")
 * @returns {{ getVoice: (guildId: string) => Promise<object>, invalidate: (guildId?: string) => void, _cacheSizeForTests: () => number }}
 */
function createVoiceData(options = {}) {
  const facade = options.db || require("../../db");
  const now = options.now || Date.now;
  const ttlMs =
    options.ttlMs != null
      ? Math.min(24 * 3600_000, Math.max(1, Math.floor(options.ttlMs)))
      : DEFAULT_CACHE_TTL_MS;
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.floor(options.maxEntries))
    : DEFAULT_MAX_ENTRIES;
  const getMusicState = options.getMusicState || null;
  const getLiveVoice = options.getLiveVoice || null;

  /** guildId → { data, cachedAt } (insertion-ordered bound, lazy expiry). */
  const cache = new Map();

  const cacheSet = makeCacheSet(cache, maxEntries);

  /** Voice-XP config cluster: 1 PK row, whitelist projection only. */
  function buildConfig(guildId) {
    const res = guardRead(() => facade.getGuildSettings(guildId), "guild settings");
    const row = res.value || {};
    if (res.available) {
      for (const key of Object.keys(row)) {
        // Defense in depth (§8.7): NAME only, never the value.
        if (isSecretColumnName(key)) {
          console.warn(`[web] voice: refusing to surface secret-shaped column "${key}"`);
        }
      }
    }
    return {
      available: res.available,
      voiceXpPerMin: res.available ? numOrNull(row.voice_xp_per_min) : null,
    };
  }

  /** Sessions cluster: the ONE bounded guild-scoped statement (see header). */
  function buildSessions(guildId, at) {
    const res = guardRead(
      () => readVoiceSessions(facade, guildId, SESSIONS_CAP),
      "voice sessions"
    );
    const rows = res.available && Array.isArray(res.value) ? res.value : [];
    return {
      available: res.available,
      rows: rows.map((r) => projectSessionRow(r, at)),
      truncated: rows.length >= SESSIONS_CAP, // honest: LIMIT may have bitten
    };
  }

  async function callProvider(provider, guildId, label, degrade) {
    if (!provider) return degrade();
    try {
      return await provider(guildId);
    } catch (err) {
      console.warn(
        `[web] voice: ${label} provider failed:`,
        err?.code || err?.name || err?.message || "unknown"
      );
      return degrade();
    }
  }

  /**
   * ONE uncached assembly: 2 bounded facade queries + 2 in-memory provider
   * reads (never awaited twice, never on cache hits).
   * @param {string} guildId
   * @param {number} at clock ms for freshness + elapsed-minutes math
   */
  async function buildSnapshot(guildId, at) {
    const [sessions, config, musicRaw, liveRaw] = await Promise.all([
      Promise.resolve(buildSessions(guildId, at)),
      Promise.resolve(buildConfig(guildId)),
      callProvider(getMusicState, guildId, "music state", () => null),
      callProvider(getLiveVoice, guildId, "live voice", () => null),
    ]);

    return {
      guildId,
      sessions,
      config,
      music: normalizeMusic(musicRaw),
      live: normalizeLive(liveRaw),
      freshness: { generatedAt: at, fromCache: false, ageMs: 0 },
    };
  }

  /**
   * Current voice & music snapshot for one guild (cached ≥30 s; a hit runs
   * ZERO queries and ZERO provider code — §8.6 query budget + the subtask's
   * "never a live Lavalink round-trip per request" acceptance).
   * @param {string} guildId
   */
  async function getVoice(guildId) {
    if (typeof guildId !== "string" || !guildId) {
      throw new TypeError("getVoice: guildId must be a non-empty string");
    }
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
    const data = await buildSnapshot(guildId, at);
    cacheSet(guildId, { data, cachedAt: at });
    return data;
  }

  /** Drop one guild's (or all) cached snapshots — future write hooks/tests. */
  function invalidate(guildId) {
    if (guildId === undefined) cache.clear();
    else cache.delete(guildId);
  }

  return { getVoice, invalidate, _cacheSizeForTests: () => cache.size };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  MIN_CACHE_TTL_MS,
  SESSIONS_CAP,
  QUEUE_DISPLAY_CAP,
  LIVE_CHANNEL_CAP,
  MUSIC_STATUSES,
  LIVE_UNAVAILABLE_DETAIL,
  readVoiceSessions,
  projectSessionRow,
  snapshotLiveVoice,
  snapshotMusicState,
  makeMusicStateAccessor,
  makeLiveVoiceAccessor,
  createVoiceData,
};
