/**
 * Boot orchestration (roadmap/fluxer.md § Boot + § Supervisor).
 *
 * One process, N endpoints: the Discord client (when DISCORD_TOKEN is set)
 * plus one handle per configured Fluxer instance. Each endpoint logs in
 * independently; one failed login never takes down the others. The process
 * exits non-zero ONLY when every configured endpoint failed — and boot
 * itself only reports that via `{ ok: false, exitCode: 1 }`; the entry
 * point (src/index.js) decides to exit, so tests can exercise boot() safely.
 *
 * Through PR 6 the feature hooks keep the Discord client as their FIRST
 * argument (`supervisor.discord`, null when Discord is not configured) —
 * PR 7 performs the supervisor-argument cutover together with every hook
 * body (spec § Supervisor). `featureCtx.client` mirrors that via a getter
 * so late Discord construction stays visible to features.
 */

const { Events } = require("discord.js");

const features = require("../features");
const { registerAllFeatureEvents, startAllFeatures } = require("../features/load");
const { registerOrderedPipelines } = require("../bot/pipelines");
const { handleInteraction } = require("../commands/router");
const { buildDefaultRegistry } = require("../commands/registry");
const { createClient } = require("../client");
const { getDiscordOutbound } = require("./discord/outbound");
const { getCommunityById } = require("./community");
const { parseFluxerInstances } = require("../config");
const { ensureHoneypotWarning } = require("../features/honeypot");
const { createFluxerHandle } = require("./fluxer/client");

/**
 * @typedef {object} Supervisor
 * @property {import("discord.js").Client|null} discord
 * @property {Map<string, object>} fluxer  // instanceKey → handle; not ClientCluster (K6)
 * @property {(communityId: number) => object|null} clientForCommunity
 */

/**
 * Read and validate the Fluxer entries from the environment. A malformed
 * block throws (spec rule 2: never ignore a broken Fluxer block) — the
 * message is specific, and assertRuntimeEnv performs the same validation
 * earlier in src/index.js.
 *
 * @returns {Array<object>} validated entries (empty array = no Fluxer block)
 */
function readFluxerEntries() {
  const raw = process.env.FLUXER_INSTANCES;
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    return parseFluxerInstances(raw);
  } catch (err) {
    console.error(`[fluxer] FLUXER_INSTANCES rejected: ${err?.message || err}`);
    throw err;
  }
}

/**
 * Start every configured platform endpoint and build the supervisor.
 *
 * Feature lifecycle (spec § Boot line 177): features start once at least
 * ONE endpoint is ready — Discord fires this on ClientReady (identical to
 * today's src/index.js); a Fluxer-only boot fires it after the first
 * successful handle. `startAllFeatures` is called exactly once per process.
 *
 * @param {{ registry?: object }} [options] registry to share with features
 *   and prefix dispatch (defaults to buildDefaultRegistry())
 * @returns {Promise<{ ok: boolean, exitCode: number, supervisor: Supervisor }>}
 */
async function boot({ registry } = {}) {
  const commandRegistry = registry ?? buildDefaultRegistry();
  const entries = readFluxerEntries();
  const discordToken = process.env.DISCORD_TOKEN;

  /** @type {Supervisor} */
  const supervisor = {
    discord: null,
    fluxer: new Map(),
    clientForCommunity,
  };

  /**
   * Map a community id to the OutboundClient that can speak to it.
   * Loads the `communities` row (spec § Supervisor — the only lookup).
   * Missing client → null; callers log and skip (never throw out of a tick).
   */
  function clientForCommunity(communityId) {
    let row;
    try {
      row = getCommunityById(communityId);
    } catch (err) {
      // A bad/unknown id is a programming error: log it with the id, return
      // null, and let the caller skip (spec § Supervisor).
      console.error(
        `[boot] clientForCommunity(${communityId}) failed: ${err?.message || err}`,
      );
      return null;
    }
    if (!row) return null;
    if (row.platform === "discord") {
      return supervisor.discord ? getDiscordOutbound(supervisor.discord) : null;
    }
    const handle = supervisor.fluxer.get(row.instanceKey);
    return handle ? handle.outbound : null;
  }

  const featureCtx = {
    // Mirrors the legacy contract: features read ctx.client === the Discord
    // client. Getter so the value is correct even if Discord is constructed
    // after features captured this object.
    get client() {
      return supervisor.discord;
    },
    supervisor,
    registry: commandRegistry,
    ensureHoneypotWarning,
  };

  let featuresStarted = false;
  let discordReady = false;
  function startFeaturesOnce() {
    if (featuresStarted) return;
    // Spec: features start when at least ONE endpoint is ready. "As today"
    // means a configured-and-constructed Discord client keeps ownership of
    // the trigger (ClientReady); a Fluxer-only process (no Discord client)
    // starts features after the first successful Fluxer handle.
    if (supervisor.discord && !discordReady) return;
    featuresStarted = true;
    // First argument stays the Discord client through PR 6 (spec § Supervisor).
    startAllFeatures(supervisor.discord, features, featureCtx);
  }

  /** One boolean promise per configured endpoint: true = that endpoint came up. */
  const endpointJobs = [];

  // --- Discord (identical sequence to today's src/index.js) ---
  if (discordToken) {
    let discordLogin = null;
    try {
      const client = createClient();
      supervisor.discord = client;
      registerAllFeatureEvents(client, features, featureCtx);
      registerOrderedPipelines(client);
      client.once(Events.ClientReady, () => {
        // Console parity with the pre-Fluxer entry point (PR 6 bundle).
        console.log(`Boiler Snake logged in as ${client.user.tag}`);
        discordReady = true;
        startFeaturesOnce();
      });
      client.on(Events.InteractionCreate, (interaction) =>
        handleInteraction(interaction, featureCtx)
      );
      discordLogin = client.login(discordToken);
    } catch (err) {
      // Construction/wiring failure: Discord is down for this process;
      // Fluxer endpoints (if any) keep running.
      console.error(`[discord] client setup failed: ${err?.message || err}`);
      supervisor.discord = null;
    }
    endpointJobs.push(
      discordLogin
        ? discordLogin
            .then(() => true)
            .catch((err) => {
              console.error(`[discord] login failed: ${err?.message || err}`);
              return false;
            })
        : Promise.resolve(false),
    );
  }

  // --- Fluxer: every entry logs in concurrently (Promise.allSettled-style;
  //     createFluxerHandle resolves null instead of rejecting) ---
  for (const entry of entries) {
    endpointJobs.push(
      createFluxerHandle(entry, {
        pipelineHooks: { registry: commandRegistry, supervisor },
      })
        .then((handle) => {
          if (!handle) return false;
          supervisor.fluxer.set(handle.instanceKey, handle);
          // Fluxer-only boot reaches "at least one endpoint ready" here.
          startFeaturesOnce();
          return true;
        })
        .catch((err) => {
          // createFluxerHandle swallows its own failures; this is a last-
          // resort net so one broken handle can never reject the batch.
          console.error(
            `[fluxer] ${entry?.instanceKey || entry?.origin || "unknown"} boot failed: ${err?.message || err}`,
          );
          return false;
        }),
    );
  }

  const results = await Promise.all(endpointJobs);
  const anyReady = results.some(Boolean);

  if (!anyReady) {
    // Spec: "The process exits only when every configured endpoint failed."
    // The ENTRY POINT performs the exit; boot just reports it (test-safe).
    console.error(
      `[boot] every configured endpoint failed (${results.length} endpoint(s)) — nothing is connected`,
    );
  }

  return {
    ok: anyReady,
    exitCode: anyReady ? 0 : 1,
    supervisor,
  };
}

module.exports = {
  boot,
};
