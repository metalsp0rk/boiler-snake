/**
 * Voice-channel guards and playback operations against a Lavalink manager.
 */

const { PermissionFlagsBits, ChannelType } = require("discord.js");
const { capTracks, resolveQuery } = require("./resolve");
const { hasSpotifyCreds, getManager, isNodeReady } = require("./lavalink");
const { trackTitle, trackAuthor } = require("./render");

const DEFAULT_VOLUME = 80;
const EMPTY_LEAVE_MS = 60_000;
// #588: queue-drain idle-leave window. When the queue drains (TrackEnd with
// nothing left), the bot leaves after this window unless something is played
// first. App-side (not lavalink-client's playerOptions.onEmptyQueue) so ONE
// "should we still be here" decision owns cancel-on-enqueue, the fire-time
// re-check, and the logged-failure path the error doctrine demands.
const IDLE_LEAVE_MS = 5 * 60_000;
// #469 (E2-07): TOTAL queue bound. PLAYLIST_CAP (resolve.js) only ever
// limited one playlist batch to 100 - nothing bounded the AGGREGATE: any
// member of the voice channel could grow lavalink-client's in-process
// queue without limit (/play x N), and the queue embed cheerfully
// rendered "...and N more" with unbounded N. A bounded queue is also the
// honest UX: nobody queues a real 5000-track listening session.
const MAX_QUEUE_TOTAL = 500;

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const emptyLeaveTimers = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const idleLeaveTimers = new Map();

const ERRORS = {
  no_config:
    "Music isn't configured. Set `LAVALINK_HOST` (and run a Lavalink 4.2+ node).",
  no_node:
    "Music isn't connected right now — the Lavalink node is down. Try again in a moment.",
  not_in_voice: "Join a voice channel first.",
  afk: "I can't play in the AFK channel.",
  wrong_channel: "You're not in my voice channel.",
  missing_perm: "I need **Connect** and **Speak** in that voice channel.",
  no_player: "I'm not playing anything in this server.",
  no_tracks: "No tracks found for that query.",
  spotify_unconfigured:
    "Spotify links need `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` on the Lavalink node.",
  empty: "Give me a song name, Spotify/YouTube/SoundCloud URL, or search query.",
  queue_full:
    `Queue is full (${MAX_QUEUE_TOTAL} tracks max). Wait for some to finish, ` +
    "or trim it with /music remove position:.",
  search_failed: "Search failed. Try a different query.",
};

/**
 * @param {import("discord.js").Client} client
 */
function requireReady(client) {
  const manager = getManager(client);
  if (!manager) return { ok: false, error: "no_config" };
  if (!isNodeReady(client)) return { ok: false, error: "no_node", manager };
  return { ok: true, manager };
}

/**
 * @param {import("discord.js").ChatInputCommandInteraction|import("discord.js").ButtonInteraction} interaction
 */
function getCallerVoice(interaction) {
  const guild = interaction.guild;
  if (!guild) return { ok: false, error: "not_in_voice" };
  const vs = guild.voiceStates?.cache?.get(interaction.user.id);
  const channelId =
    vs?.channelId ||
    vs?.channel?.id ||
    interaction.member?.voice?.channelId ||
    null;
  if (!channelId) return { ok: false, error: "not_in_voice" };
  if (guild.afkChannelId && channelId === guild.afkChannelId) {
    return { ok: false, error: "afk" };
  }
  const channel =
    vs?.channel ||
    guild.channels?.cache?.get(channelId) ||
    null;
  return { ok: true, channelId, channel };
}

/**
 * @param {import("discord.js").Guild} guild
 * @param {object|null} channel
 * @param {string} channelId
 */
function botCanJoin(guild, channel, channelId) {
  const ch = channel || guild.channels?.cache?.get(channelId);
  if (!ch?.permissionsFor) return { ok: true };
  const me = guild.members?.me;
  if (!me) return { ok: true };
  const perms = ch.permissionsFor(me);
  if (!perms) return { ok: true };
  if (
    !perms.has(PermissionFlagsBits.Connect) ||
    !perms.has(PermissionFlagsBits.Speak)
  ) {
    return { ok: false, error: "missing_perm" };
  }
  if (
    ch.type != null &&
    ch.type !== ChannelType.GuildVoice &&
    ch.type !== ChannelType.GuildStageVoice &&
    ch.type !== 2 &&
    ch.type !== 13
  ) {
    return { ok: false, error: "not_in_voice" };
  }
  return { ok: true };
}

/**
 * Caller must be in a VC; if a player is already connected, same VC.
 * @param {import("discord.js").Interaction} interaction
 * @param {object|null} player
 */
function requireSameVoice(interaction, player) {
  const voice = getCallerVoice(interaction);
  if (!voice.ok) return voice;
  if (player?.voiceChannelId && player.voiceChannelId !== voice.channelId) {
    return { ok: false, error: "wrong_channel" };
  }
  return voice;
}

/**
 * #469 (E2-07): pending queue depth - current track + waiting. One
 * oracle for every bound check so the paths cannot drift.
 * @param {object|null} player
 * @returns {number}
 */
function queueDepth(player) {
  return (player?.queue?.current ? 1 : 0) + (player?.queue?.tracks?.length || 0);
}

/**
 * @param {object} manager
 * @param {string} guildId
 */
function getPlayer(manager, guildId) {
  return manager.getPlayer?.(guildId) || null;
}

/**
 * @param {object} manager
 * @param {{ guildId: string, voiceChannelId: string, textChannelId?: string }} opts
 */
function ensurePlayer(manager, opts) {
  let player = getPlayer(manager, opts.guildId);
  if (player) {
    if (opts.textChannelId) player.textChannelId = opts.textChannelId;
    return player;
  }
  player = manager.createPlayer({
    guildId: opts.guildId,
    voiceChannelId: opts.voiceChannelId,
    textChannelId: opts.textChannelId,
    selfDeaf: true,
    selfMute: false,
    volume: DEFAULT_VOLUME,
  });
  return player;
}

/**
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {string} rawQuery
 */
async function playQuery(client, interaction, rawQuery) {
  const ready = requireReady(client);
  if (!ready.ok) return ready;

  const { manager } = ready;
  const existing = getPlayer(manager, interaction.guildId);
  const voice = requireSameVoice(interaction, existing);
  if (!voice.ok) return voice;

  const join = botCanJoin(interaction.guild, voice.channel, voice.channelId);
  if (!join.ok) return join;

  const resolved = resolveQuery(rawQuery, {
    spotifyEnabled: hasSpotifyCreds(),
  });
  if (!resolved.ok) return resolved;

  const player = ensurePlayer(manager, {
    guildId: interaction.guildId,
    voiceChannelId: voice.channelId,
    textChannelId: interaction.channelId,
  });

  if (!player.connected && typeof player.connect === "function") {
    await player.connect();
    player.connected = true;
  }

  cancelEmptyLeave(interaction.guildId);
  // #588: playable audio is landing on this player — any running
  // queue-drain window is off.
  cancelIdleLeave(interaction.guildId);

  // #469 (E2-07): already at the bound? Refuse BEFORE paying the search
  // round-trip (and before any add) - specific error, actionable copy.
  if (queueDepth(player) >= MAX_QUEUE_TOTAL) {
    return { ok: false, error: "queue_full" };
  }

  let result;
  try {
    const searchArg = resolved.source
      ? { query: resolved.query, source: resolved.source }
      : resolved.query;
    result = await player.search(searchArg, interaction.user);
  } catch (err) {
    console.error("[music] search failed:", err?.message || err);
    return { ok: false, error: "search_failed" };
  }

  if (!result || result.loadType === "error") {
    return { ok: false, error: "search_failed" };
  }
  if (result.loadType === "empty" || !result.tracks?.length) {
    return { ok: false, error: "no_tracks" };
  }

  const wasPlaying = !!(player.playing || player.paused || player.queue?.current);
  const isPlaylist =
    result.loadType === "playlist" || (result.playlist && result.tracks.length > 1);

  if (isPlaylist) {
    const capped = capTracks(result.tracks);
    // Batch that would cross the bound is refused WHOLE (no partial
    // playlist: half a playlist is nobody's intent).
    if (queueDepth(player) + capped.tracks.length > MAX_QUEUE_TOTAL) {
      return { ok: false, error: "queue_full" };
    }
    await player.queue.add(capped.tracks);
    if (!wasPlaying) {
      player._fromCommand = true;
      await player.play();
    }
    return {
      ok: true,
      started: !wasPlaying,
      playlist: true,
      title: result.playlist?.name || result.playlist?.title || "playlist",
      count: capped.tracks.length,
      truncated: capped.truncated,
      total: capped.total,
      player,
    };
  }

  const track = result.tracks[0];
  // #469 (E2-07): the aggregate check the single-track path never had.
  if (queueDepth(player) + 1 > MAX_QUEUE_TOTAL) {
    return { ok: false, error: "queue_full" };
  }
  await player.queue.add(track);
  if (!wasPlaying) {
    player._fromCommand = true;
    await player.play();
  }
  return {
    ok: true,
    started: !wasPlaying,
    playlist: false,
    track,
    position: wasPlaying ? (player.queue.tracks?.length || 1) : 0,
    player,
  };
}

async function skipCurrent(player) {
  if (!player?.queue?.current && !player?.playing) {
    return { ok: false, error: "no_player" };
  }
  if (typeof player.skip !== "function") return { ok: true };
  try {
    await player.skip(0, false);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/queue size/i.test(msg) && typeof player.stopPlaying === "function") {
      await player.stopPlaying(true, false);
      return { ok: true, ended: true };
    }
    throw err;
  }
  return { ok: true };
}

async function pauseToggle(player) {
  if (!player) return { ok: false, error: "no_player" };
  if (player.paused) {
    if (typeof player.resume === "function") await player.resume();
    player.paused = false;
    // #588: resumed audio IS activity — clears a racing queue-drain window
    // (only when audio actually exists; see notePlayerActivity).
    notePlayerActivity(player);
    return { ok: true, paused: false };
  }
  if (typeof player.pause === "function") await player.pause();
  player.paused = true;
  return { ok: true, paused: true };
}

async function setVolume(player, volume) {
  if (!player) return { ok: false, error: "no_player" };
  const v = Math.max(0, Math.min(100, Math.round(Number(volume))));
  if (typeof player.setVolume === "function") await player.setVolume(v);
  player.volume = v;
  return { ok: true, volume: v };
}

async function shuffleQueue(player) {
  if (!player) return { ok: false, error: "no_player" };
  const n = player.queue?.tracks?.length || 0;
  if (!n) return { ok: false, error: "no_player" };
  if (typeof player.queue.shuffle === "function") await player.queue.shuffle();
  return { ok: true, count: n };
}

async function removeAt(player, position) {
  if (!player) return { ok: false, error: "no_player" };
  const idx = Number(position) - 1;
  const tracks = player.queue?.tracks || [];
  if (!Number.isInteger(idx) || idx < 0 || idx >= tracks.length) {
    return { ok: false, error: "bad_position" };
  }
  const track = tracks[idx];
  if (typeof player.queue.remove === "function") {
    await player.queue.remove(idx);
  } else {
    tracks.splice(idx, 1);
  }
  return { ok: true, track };
}

async function seekTo(player, ms) {
  if (!player?.queue?.current) return { ok: false, error: "no_player" };
  if (player.queue.current.info?.isStream) {
    return { ok: false, error: "not_seekable" };
  }
  const duration = player.queue.current.info?.duration;
  if (Number.isFinite(duration) && ms > duration) {
    return { ok: false, error: "seek_past_end" };
  }
  if (typeof player.seek === "function") await player.seek(ms);
  // #588: seeking is playback activity on the current track — clears a
  // racing queue-drain window (see notePlayerActivity).
  notePlayerActivity(player);
  return { ok: true, ms };
}

async function destroyPlayer(manager, guildId, reason = "stopped") {
  clearLeaveTimers(guildId);
  const player = getPlayer(manager, guildId);
  if (!player) return { ok: true, destroyed: false };
  if (typeof player.destroy === "function") {
    await player.destroy(reason);
  }
  if (typeof manager.deletePlayer === "function") {
    manager.deletePlayer(guildId);
  }
  return { ok: true, destroyed: true };
}

function countHumans(guild, channelId) {
  if (!guild?.voiceStates?.cache || !channelId) return 0;
  let n = 0;
  for (const [userId, vs] of guild.voiceStates.cache) {
    if (vs?.channelId !== channelId) continue;
    const member = vs.member || guild.members?.cache?.get(userId);
    if (member?.user?.bot) continue;
    n += 1;
  }
  return n;
}

function cancelEmptyLeave(guildId) {
  const t = emptyLeaveTimers.get(guildId);
  if (t) {
    clearTimeout(t);
    emptyLeaveTimers.delete(guildId);
  }
}

/**
 * #588: clear the queue-drain idle-leave window for a guild. Cancel points:
 * anything that puts playable audio back on the player (/play enqueue — the
 * playQuery path calls this next to cancelEmptyLeave) and every destroy, so
 * a leaving/re-created player never inherits a stale window.
 */
function cancelIdleLeave(guildId) {
  const t = idleLeaveTimers.get(guildId);
  if (t) {
    clearTimeout(t);
    idleLeaveTimers.delete(guildId);
  }
}

/**
 * #588: disarm BOTH leave windows for a guild. destroyPlayer uses this; so
 * does the shutdown drain in index.js, which destroys players directly (NOT
 * via destroyPlayer) — a window that outlives shutdown is a dangling,
 * non-unref'd timer carrying a stale "should we still be here" decision.
 */
function clearLeaveTimers(guildId) {
  cancelEmptyLeave(guildId);
  cancelIdleLeave(guildId);
}

/**
 * #588: the ACTIVITY side of the ONE "should we still be here" decision
 * (idleLeaveFire owns the fire-time half; onQueueEnd arms, these signals
 * disarm). Audio is verifiably back on the player (resume / seek / a new
 * trackStart), so a pending queue-drain window is off — but ONLY when the
 * queue actually holds audio: cancelling on a silent resume would strand the
 * bot with nothing left to re-arm the window.
 * @param {object|null} player
 */
function notePlayerActivity(player) {
  const guildId = player?.guildId;
  if (!guildId) return;
  if (queueDepth(player) > 0) cancelIdleLeave(guildId);
}

/**
 * #588: the single "should we still be here" decision fired when the queue
 * window elapses. Re-checks at fire time instead of trusting arm time: the
 * player may be gone (already left) or the queue refilled (a fire-time miss
 * would evict a live player). A failed leave is LOGGED with guild + channel
 * ids (error doctrine — never a silent drop; the next queueEnd or human-
 * departure re-arms).
 */
function idleLeaveFire(manager, guildId) {
  idleLeaveTimers.delete(guildId);
  const player = getPlayer(manager, guildId);
  if (!player) return;
  if (queueDepth(player) > 0) return;
  const channelId = player.voiceChannelId;
  destroyPlayer(manager, guildId, "queue_empty_idle").catch((err) => {
    console.error(
      `[music] queue-idle leave failed (guild ${guildId}, channel ${channelId ?? "?"}):`,
      err?.message || err,
    );
  });
}

/**
 * #588: manager "queueEnd" sink — the queue drained. Arm the idle-leave
 * window (once; re-arming resets nothing, the window started with the first
 * drain). NOT empty yet (autoplay filled it / race with an enqueue)? Treat
 * it as activity and cancel any pending window instead.
 *
 * @param {object} manager
 * @param {object|null} player
 */
function onQueueEnd(manager, player) {
  const guildId = player?.guildId;
  if (!guildId) return;
  if (queueDepth(player) > 0) {
    cancelIdleLeave(guildId);
    return;
  }
  if (idleLeaveTimers.has(guildId)) return;
  const timer = setTimeout(() => idleLeaveFire(manager, guildId), IDLE_LEAVE_MS);
  idleLeaveTimers.set(guildId, timer);
}

/**
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").VoiceState} oldState
 * @param {import("discord.js").VoiceState} newState
 */
function onVoiceStateUpdate(client, oldState, newState) {
  const guild = newState?.guild || oldState?.guild;
  if (!guild) return;
  const manager = getManager(client);
  if (!manager) return;
  const player = getPlayer(manager, guild.id);
  if (!player?.voiceChannelId) return;

  const humans = countHumans(guild, player.voiceChannelId);
  if (humans > 0) {
    cancelEmptyLeave(guild.id);
    return;
  }
  if (emptyLeaveTimers.has(guild.id)) return;
  const timer = setTimeout(() => {
    emptyLeaveTimers.delete(guild.id);
    destroyPlayer(manager, guild.id, "empty_channel").catch((err) => {
      console.error("[music] empty-leave destroy failed:", err?.message || err);
    });
  }, EMPTY_LEAVE_MS);
  emptyLeaveTimers.set(guild.id, timer);
}

function errorMessage(code) {
  if (code === "bad_position") return "There's no track at that queue position.";
  if (code === "not_seekable") return "Can't seek on a livestream.";
  if (code === "seek_past_end") return "That timestamp is past the end of the track.";
  return ERRORS[code] || "Something went wrong with playback.";
}

function queuedSummary(result) {
  if (result.playlist) {
    const extra = result.truncated
      ? ` (capped at ${result.count} of ${result.total})`
      : "";
    return `Queued **${result.count}** tracks from **${result.title}**${extra}.`;
  }
  const title = trackTitle(result.track);
  const author = trackAuthor(result.track);
  if (result.started) return `Playing **${title}** — ${author}`;
  return `Queued **${title}** — ${author} (position ${result.position})`;
}

module.exports = {
  DEFAULT_VOLUME,
  EMPTY_LEAVE_MS,
  IDLE_LEAVE_MS,
  MAX_QUEUE_TOTAL,
  queueDepth,
  ERRORS,
  requireReady,
  getCallerVoice,
  requireSameVoice,
  botCanJoin,
  getPlayer,
  ensurePlayer,
  playQuery,
  skipCurrent,
  pauseToggle,
  setVolume,
  shuffleQueue,
  removeAt,
  seekTo,
  destroyPlayer,
  countHumans,
  cancelEmptyLeave,
  clearLeaveTimers,
  onVoiceStateUpdate,
  cancelIdleLeave,
  notePlayerActivity,
  onQueueEnd,
  errorMessage,
  queuedSummary,
};
