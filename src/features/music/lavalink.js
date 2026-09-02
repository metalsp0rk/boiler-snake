/**
 * Lavalink manager factory. Tests inject a fake via setManagerForTests.
 */

/** @type {object|null} */
let injectedManager = null;

/**
 * @returns {{
 *   host: string,
 *   port: number,
 *   authorization: string,
 *   secure: boolean,
 * }|null}
 */
function getLavalinkConfig() {
  const host = String(process.env.LAVALINK_HOST || "").trim();
  if (!host) return null;
  const port = Number(process.env.LAVALINK_PORT || 2333);
  return {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 2333,
    authorization: String(process.env.LAVALINK_PASSWORD || "youshallnotpass"),
    secure: process.env.LAVALINK_SECURE === "true",
  };
}

function hasSpotifyCreds() {
  return !!(
    String(process.env.SPOTIFY_CLIENT_ID || "").trim() &&
    String(process.env.SPOTIFY_CLIENT_SECRET || "").trim()
  );
}

/**
 * @param {object|null} manager
 */
function setManagerForTests(manager) {
  injectedManager = manager || null;
}

/**
 * @param {import("discord.js").Client} client
 * @returns {object|null}
 */
function getManager(client) {
  if (injectedManager) return injectedManager;
  if (client?._lavalinkManager) return client._lavalinkManager;
  return null;
}

function isNodeReady(client) {
  const manager = getManager(client);
  if (!manager) return false;
  return !!manager.useable;
}

/**
 * @param {import("discord.js").Client} client
 * @returns {object|null}
 */
function tryCreateManager(client) {
  if (injectedManager) return injectedManager;
  if (client._lavalinkManager) return client._lavalinkManager;

  const cfg = getLavalinkConfig();
  if (!cfg) return null;

  const { LavalinkManager } = require("lavalink-client");
  const manager = new LavalinkManager({
    nodes: [
      {
        id: "main",
        host: cfg.host,
        port: cfg.port,
        authorization: cfg.authorization,
        secure: cfg.secure,
        retryAmount: 10,
        retryDelay: 10_000,
      },
    ],
    sendToShard: (guildId, payload) => {
      client.guilds.cache.get(guildId)?.shard?.send(payload);
    },
    client: {
      id: client.user?.id || process.env.CLIENT_ID,
      username: client.user?.username || "Boiler Snake",
    },
    autoSkip: true,
    autoSkipOnResolveError: true,
    playerOptions: {
      defaultSearchPlatform: hasSpotifyCreds() ? "spsearch" : "ytmsearch",
      volumeDecrementer: 1,
      onEmptyQueue: {
        destroyAfterMs: 5 * 60 * 1000,
      },
      onDisconnect: {
        autoReconnect: false,
        destroyPlayer: true,
      },
    },
  });

  client._lavalinkManager = manager;
  return manager;
}

module.exports = {
  getLavalinkConfig,
  hasSpotifyCreds,
  setManagerForTests,
  getManager,
  isNodeReady,
  tryCreateManager,
};
