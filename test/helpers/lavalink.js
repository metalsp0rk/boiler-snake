/**
 * In-memory Lavalink stand-in for integration tests.
 */

const { EventEmitter } = require("events");

function makeTrack(partial = {}) {
  const info = {
    identifier: partial.identifier || "id-1",
    title: partial.title || "Never Gonna Give You Up",
    author: partial.author || "Rick Astley",
    duration: partial.duration != null ? partial.duration : 213000,
    uri: partial.uri || "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    artworkUrl: partial.artworkUrl || null,
    sourceName: partial.sourceName || "spotify",
    isSeekable: partial.isSeekable !== false,
    isStream: !!partial.isStream,
    isrc: partial.isrc || null,
  };
  return {
    encoded: partial.encoded || "fake-encoded",
    info,
    requester: partial.requester || null,
    pluginInfo: {},
  };
}

function createFakeQueue() {
  const queue = {
    tracks: [],
    current: null,
    previous: [],
    async add(trackOrTracks) {
      const list = Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks];
      queue.tracks.push(...list.filter(Boolean));
      return queue.tracks.length;
    },
    async remove(index) {
      if (typeof index !== "number" || !queue.tracks[index]) return null;
      const removed = queue.tracks.splice(index, 1);
      return { removed };
    },
    async shuffle() {
      for (let i = queue.tracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
      }
    },
    async splice(index, amount) {
      return queue.tracks.splice(index, amount);
    },
  };
  return queue;
}

function createFakePlayer(opts, manager) {
  const player = {
    guildId: opts.guildId,
    voiceChannelId: opts.voiceChannelId,
    textChannelId: opts.textChannelId || null,
    connected: false,
    playing: false,
    paused: false,
    volume: opts.volume != null ? opts.volume : 80,
    queue: createFakeQueue(),
    _manager: manager,
    _fromCommand: false,
    destroyed: false,
    lastSeek: null,
    lastSearch: null,
    async connect() {
      player.connected = true;
      return player;
    },
    async search(query, requester) {
      player.lastSearch = { query, requester };
      if (typeof manager.searchOverride === "function") {
        return manager.searchOverride(query, requester);
      }
      const q =
        typeof query === "string" ? query : query?.query || JSON.stringify(query);
      const track = makeTrack({
        title: q,
        requester,
      });
      return {
        loadType: "search",
        exception: null,
        playlist: null,
        tracks: [track],
      };
    },
    async play() {
      if (!player.queue.current) {
        player.queue.current = player.queue.tracks.shift() || null;
      }
      player.playing = !!player.queue.current;
      player.paused = false;
      if (player.playing) {
        manager.emit("trackStart", player, player.queue.current);
      }
      return player;
    },
    async skip(skipTo = 0, _throwError = true) {
      player.queue.previous.unshift(player.queue.current);
      player.queue.current = null;
      if (skipTo > 1) {
        player.queue.tracks.splice(0, skipTo - 1);
      }
      if (player.queue.tracks.length) {
        await player.play();
      } else {
        player.playing = false;
      }
      return player;
    },
    async pause() {
      player.paused = true;
      return player;
    },
    async resume() {
      player.paused = false;
      return player;
    },
    async setVolume(v) {
      player.volume = v;
      return player;
    },
    async seek(ms) {
      player.lastSeek = ms;
      return player;
    },
    async stopPlaying() {
      player.queue.tracks = [];
      player.queue.current = null;
      player.playing = false;
      player.paused = false;
      return player;
    },
    async destroy() {
      player.destroyed = true;
      player.connected = false;
      player.playing = false;
      player.voiceChannelId = null;
      manager.players.delete(player.guildId);
      return player;
    },
  };
  return player;
}

function createFakeLavalinkManager() {
  const manager = new EventEmitter();
  manager._fake = true;
  manager.useable = true;
  manager.players = new Map();
  manager.rawPackets = [];
  manager.searchOverride = null;

  manager.getPlayer = (guildId) => manager.players.get(guildId) || null;
  manager.createPlayer = (opts) => {
    const existing = manager.players.get(opts.guildId);
    if (existing) return existing;
    const player = createFakePlayer(opts, manager);
    manager.players.set(opts.guildId, player);
    return player;
  };
  manager.deletePlayer = (guildId) => manager.players.delete(guildId);
  manager.sendRawData = (d) => {
    manager.rawPackets.push(d);
  };
  manager.init = async () => manager;
  return manager;
}

module.exports = {
  makeTrack,
  createFakeLavalinkManager,
};
