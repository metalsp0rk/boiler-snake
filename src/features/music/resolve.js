/**
 * Query classification, playlist cap, and seek timestamps for the music player.
 */

const PLAYLIST_CAP = 100;

const SPOTIFY_URI_RE =
  /^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]+)$/i;

const SPOTIFY_URL_RE =
  /^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(?:user\/[^/]+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)(?:[/?#]|$)/i;

const YOUTUBE_RE =
  /(?:https?:\/\/)?(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\//i;

const SOUNDCLOUD_RE = /(?:https?:\/\/)?(?:(?:www|on|m)\.)?soundcloud\.com\//i;

const HTTP_RE = /^https?:\/\//i;

/**
 * @typedef {"empty"|"spotify"|"youtube"|"soundcloud"|"url"|"search"} QueryKind
 *
 * @typedef {object} ClassifiedQuery
 * @property {QueryKind} kind
 * @property {string} [text]
 * @property {string} [url]
 * @property {string} [spotifyType]
 * @property {string} [spotifyId]
 */

/**
 * @param {string} raw
 * @returns {ClassifiedQuery}
 */
function classifyQuery(raw) {
  const text = String(raw || "").trim();
  if (!text) return { kind: "empty" };

  const uri = text.match(SPOTIFY_URI_RE);
  if (uri) {
    return {
      kind: "spotify",
      url: text,
      spotifyType: uri[1].toLowerCase(),
      spotifyId: uri[2],
    };
  }

  const spUrl = text.match(SPOTIFY_URL_RE);
  if (spUrl) {
    return {
      kind: "spotify",
      url: text,
      spotifyType: spUrl[1].toLowerCase(),
      spotifyId: spUrl[2],
    };
  }

  if (YOUTUBE_RE.test(text)) {
    return { kind: "youtube", url: text };
  }
  if (SOUNDCLOUD_RE.test(text)) {
    return { kind: "soundcloud", url: text };
  }
  if (HTTP_RE.test(text)) {
    return { kind: "url", url: text };
  }
  return { kind: "search", text };
}

/**
 * @param {string} raw
 * @param {{ spotifyEnabled?: boolean }} [opts]
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   query?: string,
 *   source?: string,
 *   classified?: ClassifiedQuery,
 * }}
 */
function resolveQuery(raw, opts = {}) {
  const classified = classifyQuery(raw);
  if (classified.kind === "empty") {
    return { ok: false, error: "empty", classified };
  }
  if (classified.kind === "spotify") {
    if (!opts.spotifyEnabled) {
      return { ok: false, error: "spotify_unconfigured", classified };
    }
    return { ok: true, query: classified.url, classified };
  }
  if (
    classified.kind === "youtube" ||
    classified.kind === "soundcloud" ||
    classified.kind === "url"
  ) {
    return { ok: true, query: classified.url, classified };
  }
  return {
    ok: true,
    query: classified.text,
    source: opts.spotifyEnabled ? "spsearch" : "ytmsearch",
    classified,
  };
}

/**
 * @param {unknown[]} tracks
 * @param {number} [limit]
 * @returns {{ tracks: unknown[], truncated: boolean, total: number }}
 */
function capTracks(tracks, limit = PLAYLIST_CAP) {
  const list = Array.isArray(tracks) ? tracks : [];
  const max = Number(limit);
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : PLAYLIST_CAP;
  return {
    tracks: list.slice(0, cap),
    truncated: list.length > cap,
    total: list.length,
  };
}

/**
 * Parse `1:23`, `1:02:03`, or seconds (`90`) into milliseconds.
 * @param {string|number} input
 * @returns {{ ok: true, ms: number } | { ok: false, error: string }}
 */
function parseTimestamp(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      return { ok: false, error: "invalid" };
    }
    return { ok: true, ms: Math.floor(input * 1000) };
  }
  const s = String(input || "").trim();
  if (!s) return { ok: false, error: "empty" };
  if (/^\d+$/.test(s)) {
    return { ok: true, ms: Number(s) * 1000 };
  }
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return { ok: false, error: "invalid" };
  }
  if (!parts.every((p) => /^\d+$/.test(p))) {
    return { ok: false, error: "invalid" };
  }
  const nums = parts.map((p) => Number(p));
  let h = 0;
  let m = 0;
  let sec = 0;
  if (nums.length === 2) {
    [m, sec] = nums;
  } else {
    [h, m, sec] = nums;
  }
  if (sec > 59 || m > 59) return { ok: false, error: "invalid" };
  return { ok: true, ms: ((h * 60 + m) * 60 + sec) * 1000 };
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?:??";
  if (ms === 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

module.exports = {
  PLAYLIST_CAP,
  classifyQuery,
  resolveQuery,
  capTracks,
  parseTimestamp,
  formatDuration,
};
