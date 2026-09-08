/**
 * Voice & music page body for GET /g/:guildId/voice (roadmap/web-admin.md
 * §8.6 "Voice & Music: now-playing, queue VIEW only | Staff | none (control
 * out of scope) | 1" — subtask 21, Phase 1 READ-ONLY VIEW).
 *
 * Renders the snapshot from src/web/data/voiceData.js. COMPOSED ENTIRELY
 * with the escaped-by-default `html` helper: track titles/authors (operator
 * search strings!), channel/user ids and every provider detail string
 * interpolate through it — nothing here ever wraps data in raw().
 *
 * NO CONTROLS (§8.9 — locked decision 11): zero forms, zero buttons, zero
 * mutation affordances for the player. The queue is a VIEW; skip/pause/stop
 * live in Discord slash/button land only. This is asserted (not just
 * intended) by test/web-routes-voice.test.js.
 *
 * Degradation language (never a fabricated state):
 *  - music: playing | idle ("no active player…") | unavailable ("lavalink
 *    not configured" / "no lavalink node connected") | unknown — the same
 *    status ladder dashboardData.snapshotMusicPlayer uses;
 *  - live voice: "live state unavailable" whenever the cache-only client
 *    seam is unwired/broken (never a REST fetch);
 *  - sessions/config: honest "read failed" lines when a cluster degrades.
 */

const { html } = require("../escape");
const { emptyState, banner } = require("../components");
const { DEFAULTS: SETTINGS_DEFAULTS } = require("../../data/settingsData");
const { QUEUE_DISPLAY_CAP, SESSIONS_CAP } = require("../../data/voiceData");

/** Honest degradation line for a cluster whose read failed. */
const READ_FAILED = "Unavailable — the voice read failed for this section.";

/**
 * Governing slash commands (frozen view-author constants). Music has NO web
 * write tier at all (§8.9) — the badges say "via slash in Discord".
 */
const GOVERN = Object.freeze({
  music: { cmd: "play · music queue|nowplaying", tier: "none" },
  voiceXp: { cmd: "setxp voice", tier: "staff" },
});

/** Music status → whitelisted pill class (never a class from data). */
const MUSIC_PILL = Object.freeze({
  playing: "live",
  idle: "idle",
  unavailable: "off",
  unknown: "off",
});

/** Integer-ish display that never invents a number for null. */
function num(value, suffix = "") {
  return value == null ? html`<em class="muted">unset</em>` : html`${value}${suffix}`;
}

/**
 * Deterministic UTC stamp for stored epoch-ms values (view twins keep this
 * identical — no locale drift, no fake "relative" times).
 */
function utcMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return html`<em class="muted">—</em>`;
  let iso;
  try {
    iso = new Date(Number(ms)).toISOString();
  } catch {
    return html`<em class="muted">invalid</em>`;
  }
  return html`${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** ms → "m:ss" / "h:mm:ss" (music/resolve.js formatDuration parity). */
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Duration cell: streams honestly say "Live" (slash render.js parity). */
function durationCell(row) {
  return row.isStream ? html`<em>Live</em>` : html`${formatDuration(row.durationMs)}`;
}

/**
 * Channel reference — settings/integrations twin (id is the source-of-truth
 * value; an OPTIONAL cache-only name decorates it; absent ⇒ id alone).
 */
function channelRef(channelId, resolveName) {
  if (!channelId) return html`<em class="muted">—</em>`;
  const name = typeof resolveName === "function" ? resolveName(channelId) : null;
  return html`<code class="channel-id">${channelId}</code>${name
    ? html` <span class="channel-name">(${name})</span>`
    : html``}`;
}

/** Whitelisted state pill; kind comes from the frozen map, never from data. */
function pill(status, label) {
  const kind = MUSIC_PILL[status] || "off";
  return html`<span class="voice-pill voice-pill-${kind}">${label}</span>`;
}

/** Static govern line (music has NO web tier — §8.9). */
function governsLine(key) {
  const g = GOVERN[key];
  if (!g) return html`via slash command`;
  if (g.tier === "none") {
    return html`via <code>/${g.cmd}</code> in Discord — no web control exists (§8.9)`;
  }
  return html`via <code>/${g.cmd}</code> · write tier
    <span class="badge badge-tier badge-tier-${g.tier === "admin" ? "admin" : "staff"}">${g.tier}</span>`;
}

function section(title, bodyHtml, opts = {}) {
  return html`
    <section class="panel settings-panel voice-panel">
      <h2>${title}</h2>
      ${opts.notice ? banner("warn", opts.notice) : html``}
      ${bodyHtml}
    </section>`;
}

// ---------------------------------------------------------------------------
// Now playing + queue (music) — VIEW ONLY, §8.9
// ---------------------------------------------------------------------------

function nowPlayingCell(music) {
  if (music.status === "playing" && music.nowPlaying) {
    const np = music.nowPlaying;
    const pos = np.isStream
      ? html``
      : html` <span class="voice-meta">
          · ${formatDuration(np.positionMs)} / ${formatDuration(np.durationMs)}</span>`;
    return html`
      <p class="voice-now">
        <strong class="voice-now-title">${np.title}</strong>
        <span class="voice-meta">— ${np.author}</span>${pos}
        ${np.paused ? pill("idle", "paused") : pill("playing", "playing")}
        ${np.requesterId ? html`<span class="voice-meta">· requested by <code>${np.requesterId}</code></span>` : html``}
      </p>`;
  }
  if (music.status === "idle") {
    return emptyState(
      html`Nothing is playing${music.detail ? html` — ${music.detail}` : html``}.`
    );
  }
  if (music.status === "unavailable") {
    return emptyState(
      html`Player state is <strong>unavailable</strong>${music.detail
        ? html` — ${music.detail}`
        : html``}. This is normal when no Lavalink node is configured or the
      node is down; the view never reaches out to the player.`
    );
  }
  return emptyState(
    html`Player state <strong>unknown</strong>${music.detail ? html` — ${music.detail}` : html``}.`
  );
}

function musicSection(music, resolveChannelName) {
  const body = html`
    ${nowPlayingCell(music)}
    ${music.queue
      ? html`
          ${music.queue.rows.length
            ? html`<table class="list-table settings-table voice-queue">
                <thead>
                  <tr><th scope="col">#</th><th scope="col">Track</th><th scope="col">Duration</th><th scope="col">Requested by</th></tr>
                </thead>
                <tbody>
                  ${music.queue.rows.map(
                    (r) => html`<tr>
                      <td class="voice-pos">${r.position}</td>
                      <td>${r.title}<br/><span class="voice-meta">${r.author}</span></td>
                      <td>${durationCell(r)}</td>
                      <td>${r.requesterId ? html`<code>${r.requesterId}</code>` : html`<em class="muted">—</em>`}</td>
                    </tr>`
                  )}
                </tbody>
              </table>
              ${music.queue.truncated
                ? html`<p class="subheading">
                    Showing the first ${QUEUE_DISPLAY_CAP} of ${music.queue.total} queued tracks (slash
                    <code>/music queue</code> shows the same page).
                  </p>`
                : html``}`
            : emptyState("No upcoming tracks in the queue.")}
          <p class="voice-meta">
            ${music.queue.total} in queue${music.queue.volume != null
              ? html` · volume ${music.queue.volume}%`
              : html``}${music.queue.voiceChannelId
              ? html` · in ${channelRef(music.queue.voiceChannelId, resolveChannelName)}`
              : html``}
          </p>`
      : html``}
    <p class="subheading">${governsLine("music")}</p>`;
  return section("Now playing · queue (view-only)", body);
}

// ---------------------------------------------------------------------------
// Live voice channels (cache-only connected humans + eligibility)
// ---------------------------------------------------------------------------

function liveSection(live, resolveChannelName) {
  if (!live.available) {
    return section(
      "Live voice",
      emptyState(
        html`<strong>${live.detail || "live state unavailable"}</strong> — the
        live connected-voice view reads the bot's in-memory voice-state cache
        only; it is absent when the web console runs without the bot client
        (or the voice-state cache is empty). Nothing was fetched.`
      )
    );
  }
  const rows = live.channels.length
    ? html`<table class="list-table settings-table">
        <thead>
          <tr><th scope="col">Channel</th><th scope="col">Humans</th><th scope="col">AFK</th><th scope="col">Muted/deaf</th><th scope="col">Eligible</th><th scope="col">Earning XP</th></tr>
        </thead>
        <tbody>
          ${live.channels.map(
            (c) => html`<tr>
              <td>${channelRef(c.channelId, resolveChannelName)}</td>
              <td>${c.humans}</td>
              <td>${c.afk}</td>
              <td>${c.mutedOrDeaf}</td>
              <td>${c.eligible}</td>
              <td>${c.earning ? pill("playing", "yes") : pill("idle", "no")}</td>
            </tr>`
          )}
        </tbody>
      </table>`
    : emptyState("No humans are connected to voice right now.");
  return section(
    "Live voice",
    html`
      ${rows}
      <p class="voice-meta">
        ${live.totals.humans} humans connected · ${live.totals.eligible} XP-eligible
        across the shown channels${live.truncated ? html` (channel list truncated)` : html``}.
        Eligible excludes AFK-channel members and muted/deafened members; a
        channel earns only with ≥2 eligible humans (voice-ticker rules).
        ${live.afkChannelId ? html` AFK channel: <code>${live.afkChannelId}</code>.` : html``}
      </p>
      <p class="subheading">
        Cache-only read of the bot's voice-state cache — never a Discord API call.
      </p>`
  );
}

// ---------------------------------------------------------------------------
// Current voice sessions (voice_sessions table, bounded)
// ---------------------------------------------------------------------------

function sessionsSection(sessions, resolveChannelName) {
  if (!sessions.available) {
    return section("Voice sessions", emptyState(READ_FAILED));
  }
  const rows = sessions.rows.length
    ? html`<table class="list-table settings-table">
        <thead>
          <tr><th scope="col">User</th><th scope="col">Channel</th><th scope="col">Joined</th><th scope="col">Minutes (this session)</th></tr>
        </thead>
        <tbody>
          ${sessions.rows.map(
            (r) => html`<tr>
              <td><code class="user-id">${r.userId ?? "—"}</code></td>
              <td>${channelRef(r.channelId, resolveChannelName)}</td>
              <td>${utcMs(r.joinedAt)}</td>
              <td class="voice-minutes">${r.minutesConnected == null
                ? html`<em class="muted">—</em>`
                : html`${r.minutesConnected}`}</td>
            </tr>`
          )}
        </tbody>
      </table>`
    : emptyState("No current voice sessions stored for this guild.");
  return section(
    "Voice sessions",
    html`
      ${rows}
      ${sessions.truncated
        ? html`<p class="subheading">
            Showing at most ${SESSIONS_CAP} rows (§8.6 cap — more may exist).
          </p>`
        : html``}
      <p class="subheading">
        <code>voice_sessions</code> stores the CURRENT session per user
        (upsert on join, delete on leave) — minutes are for the ongoing
        session. Historical per-user voice-minute totals need a new bounded
        activity helper and are deferred (Phase 1 read-only).
      </p>`
  );
}

// ---------------------------------------------------------------------------
// Voice XP config (read-only)
// ---------------------------------------------------------------------------

function configSection(config, guildId) {
  if (!config.available) {
    return section("Voice XP config", emptyState(READ_FAILED));
  }
  const settingsHref = `/g/${encodeURIComponent(String(guildId || ""))}/settings`;
  return section(
    "Voice XP config",
    html`
      <div class="settings-rows">
        <div class="setting-row">
          <span class="setting-label">XP per voice minute</span>
          <span class="setting-value">${num(config.voiceXpPerMin)}</span>
          <span class="setting-default">default ${SETTINGS_DEFAULTS.voiceXpPerMin}</span>
          <span class="setting-slash">${governsLine("voiceXp")}</span>
        </div>
      </div>
      <p class="subheading">
        The voice ticker ignores AFK-channel members and muted/deafened
        members and awards nothing below 2 eligible humans per channel
        (AGENTS.md voice rules; handler code stays the source of truth).
        Full settings live on the <a href="${settingsHref}">settings page</a>.
      </p>`
  );
}

// ---------------------------------------------------------------------------
// Page body
// ---------------------------------------------------------------------------

/** Compact age for the freshness stamp (settings-page twin). */
function formatAge(ms) {
  const s = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Full voice & music body (goes into the shell via renderShellPage).
 * @param {object} input
 * @param {object} input.snapshot from data/voiceData.js getVoice()
 * @param {(id: string) => string|null} [input.resolveChannelName] cache-only (getClient seam)
 * @returns {import("../escape").SafeString}
 */
function renderVoiceBody({ snapshot, resolveChannelName }) {
  const s = snapshot || {};
  const emptyCluster = { available: false };
  const sessions = s.sessions || emptyCluster;
  const config = s.config || emptyCluster;
  const music = s.music || { status: "unknown" };
  const live = s.live || { available: false };
  const f = s.freshness || null;
  const stamp = f
    ? html` snapshot ${formatAge(f.ageMs || 0)} old${f.fromCache ? html` (cached)` : html``}`
    : html``;

  return html`
    <div class="settings-grid voice-grid">
      ${musicSection(music, resolveChannelName)}
      ${liveSection(live, resolveChannelName)}
      ${sessionsSection(sessions, resolveChannelName)}
      ${configSection(config, s.guildId)}
      <p class="subheading settings-stamp">
        Read-only view — music CONTROL (skip/pause/stop) is out of v1 scope
        (§8.9); values cached at least 30&nbsp;s per guild (§8.6 query
        budget floor).${stamp}
      </p>
    </div>`;
}

module.exports = {
  renderVoiceBody,
  GOVERN,
  MUSIC_PILL,
  formatDuration,
};
