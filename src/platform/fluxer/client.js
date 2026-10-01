/**
 * Fluxer SDK boundary (roadmap/fluxer.md § Topology: "fluxer/client.js —
 * dynamic import of @fluxerjs/core; one client per instanceKey").
 *
 * This file is the ONLY production module allowed to reference the SDK
 * package name (enforced by test/fluxer-sdk-import-guard.test.js), and it
 * references it exclusively through a dynamic `await import()` inside the
 * async factory. A CommonJS `require` would hard-fail module load when the
 * dependency is absent; a dynamic import that rejects lets THIS instance
 * fail login with a logged cause while every other endpoint keeps running
 * (K6: a failing spike/dependency must not take the process down).
 *
 * Handle shape (PR 6 shared contract 5, consumed by fluxer/outbound.js):
 *   { instanceKey, rest, userId, fetchGuild(externalId),
 *     guildFetch(communityId, guildId) }
 * plus the lifecycle extras `label`, `ready`, `destroy`, and `outbound`.
 *
 * Error handling (AGENTS.md): every async entry attaches its own catch;
 * every log carries `[fluxer]` + the instance key; nothing here ever calls
 * process.exit, and a failed Fluxer login never touches Discord.
 */

const pipelines = require("../../bot/pipelines");
const { normalizeFluxerMessage, normalizeFluxerReaction } = require("./normalize");
const { createFluxerOutbound } = require("./outbound");
const { discoverInstance } = require("./discovery");
const { getCommunityById } = require("../community");
const { normalizeOriginForKey } = require("../../config");

/**
 * The single allowed mention of the SDK package name in production code
 * (test/fluxer-sdk-import-guard.test.js). Keep it in exactly this one
 * expression; do not split it into fragments.
 */
const SDK_PACKAGE_NAME = "@fluxerjs/core";

/**
 * Dynamic-import the SDK. Failure (package absent, broken install, ESM
 * resolution error) is logged with the instance key and yields null so the
 * caller can degrade this instance alone.
 *
 * @param {string} instanceKey
 * @returns {Promise<any|null>} the SDK module namespace, or null
 */
async function loadFluxerSdk(instanceKey) {
  try {
    return await import(SDK_PACKAGE_NAME);
  } catch (err) {
    console.error(
      `[fluxer] ${instanceKey} SDK load failed (${SDK_PACKAGE_NAME}): ${err?.message || err}`,
    );
    return null;
  }
}

/**
 * Rest façade over the SDK client. Contract 5: `request(method, path,
 * { body?, query? } = {}) => Promise<any>` — SDK Rest-compatible, and the
 * fake in test/helpers/fluxer.js implements the same shape.
 *
 * @param {any} client SDK client (post-construction; may lack .rest on odd builds)
 * @param {string} instanceKey
 */
function buildRestFacade(client, instanceKey) {
  return {
    async request(method, path, options = {}) {
      const rest = client && client.rest;
      if (!rest || typeof rest.request !== "function") {
        throw new Error(
          `[fluxer] ${instanceKey} SDK client exposes no rest.request() — SDK surface mismatch`,
        );
      }
      return rest.request(method, path, options);
    },
  };
}

/**
 * Strip query/fragment from a URL for logging (never log query strings).
 * Malformed values are passed through as strings, never thrown at the logger.
 * @param {unknown} value
 * @returns {string}
 */
function safeLogUrl(value) {
  if (typeof value !== "string" || value === "") return String(value ?? "");
  try {
    const u = new URL(value);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return value.split(/[?#]/)[0];
  }
}

/**
 * Create one Fluxer endpoint handle: dynamic SDK load → Client.fromDiscovery
 * (the SDK performs the § Boot discovery itself) → gateway login → event
 * wiring into the shared pipelines.
 *
 * Every failure mode returns null after a specific `[fluxer] <key> ...`
 * log; nothing here rejects, and nothing here exits the process.
 *
 * @param {{ instanceKey: string, origin: string, token: string, label?: string }} entry
 *   one entry from config.parseFluxerInstances
 * @param {{ pipelineHooks?: { registry?: object, supervisor?: object } }} [options]
 *   pipelineHooks.registry enables prefix dispatch in the pipeline for this
 *   instance; pipelineHooks.supervisor is threaded to dispatch (contract 3).
 * @returns {Promise<{
 *   instanceKey: string, label: string, userId: string|null, ready: boolean,
 *   rest: object, outbound: object,
 *   fetchGuild: (externalId: string) => Promise<object|null>,
 *   guildFetch: (communityId: number, guildId?: string|null) => Promise<object|null>,
 *   destroy: () => Promise<void>,
 * } | null>}
 */
async function createFluxerHandle(entry, { pipelineHooks = {} } = {}) {
  const origin = typeof entry?.origin === "string" ? entry.origin : "";
  const instanceKey =
    (typeof entry?.instanceKey === "string" && entry.instanceKey.trim()) ||
    (() => {
      try {
        return normalizeOriginForKey(origin);
      } catch {
        return origin || "unknown";
      }
    })();

  if (!origin) {
    console.error(
      `[fluxer] ${instanceKey} cannot start: entry is missing an "origin"`,
    );
    return null;
  }
  const token = typeof entry?.token === "string" ? entry.token : "";
  if (!token) {
    console.error(
      `[fluxer] ${instanceKey} cannot start: entry is missing a token`,
    );
    return null;
  }

  const sdk = await loadFluxerSdk(instanceKey);
  if (!sdk) return null;

  const events = sdk.Events || {};
  const eventName = (enumKey, fallback) => events[enumKey] ?? fallback;

  // fromDiscovery runs GET {origin}/.well-known/fluxer itself (the real
  // static factory on the pinned @fluxerjs/core@3.1.0 surface — fromInstance
  // does not exist; caught by the boot smoke test).
  let client;
  try {
    if (typeof sdk.Client?.fromDiscovery !== "function") {
      throw new Error("Client.fromDiscovery is not a function (SDK surface mismatch)");
    }
    client = await sdk.Client.fromDiscovery(origin);
  } catch (err) {
    console.error(
      `[fluxer] ${instanceKey} login failed: instance discovery for ${safeLogUrl(origin)}: ${err?.message || err}`,
    );
    return null;
  }

  try {
    await client.login(token);
  } catch (err) {
    // Spec: "One failed Fluxer login: log ... never take Discord down,
    // never process.exit." Release the half-open client best-effort.
    console.error(`[fluxer] ${instanceKey} login failed: ${err?.message || err}`);
    try {
      if (typeof client.destroy === "function") await client.destroy();
    } catch (destroyErr) {
      console.error(
        `[fluxer] ${instanceKey} cleanup after failed login: ${destroyErr?.message || destroyErr}`,
      );
    }
    return null;
  }

  // Post-connect info line: the endpoints from the SDK's own instance
  // document (spec § Boot: log the discovered API host and gateway host).
  const inst = (client && client.instance) || {};
  console.log(
    `[fluxer] ${instanceKey} api=${safeLogUrl(inst.api_public)} gateway=${safeLogUrl(inst.gateway)}`,
  );

  const rest = buildRestFaçade(client, instanceKey);

  /**
   * REST guild fetch — the Phase 0 record is law: bot-facing GUILD_CREATE
   * payloads carry NO name/owner_id, so REST GET /v1/guilds/{id} is the
   * source for guild metadata. Failure → null + one log line (spec § Boot:
   * "Commands do one fetch and, on failure, reply with that error").
   */
  async function fetchGuild(externalId) {
    try {
      const g = await rest.request(
        "GET",
        `/v1/guilds/${encodeURIComponent(String(externalId))}`,
      );
      if (!g || g.id == null) return null;
      return {
        id: String(g.id),
        name: g.name ?? null,
        ownerId: g.owner_id ?? null,
        afkChannelId: g.afk_channel_id ?? null,
      };
    } catch (err) {
      console.error(
        `[fluxer] ${instanceKey} guild fetch for ${externalId} failed: ${err?.message || err}`,
      );
      return null;
    }
  }

  /**
   * Resolve a community id to this instance's external guild over REST.
   * The community row must belong to THIS instance (K3 isolation): a row
   * for another platform or instance yields null, never a cross-platform fetch.
   */
  async function guildFetch(communityId, guildId) {
    let externalId = typeof guildId === "string" && guildId.trim() !== "" ? guildId : null;
    try {
      const row = getCommunityById(communityId);
      if (!row || row.platform !== "fluxer" || row.instanceKey !== instanceKey) {
        return null;
      }
      externalId = externalId ?? row.externalGuildId;
    } catch (err) {
      console.error(
        `[fluxer] ${instanceKey} guildFetch(community=${communityId}) failed: ${err?.message || err}`,
      );
      return null;
    }
    if (!externalId) return null;
    return fetchGuild(externalId);
  }

  async function destroy() {
    try {
      if (typeof client.destroy === "function") await client.destroy();
    } catch (err) {
      console.error(
        `[fluxer] ${instanceKey} destroy failed: ${err?.message || err}`,
      );
    }
  }

  // Spec § Embeds and attachments (PR 8): the presigned attachment flow is
  // selected by the instance's OWN discovery document ("a presigned upload
  // when discovery features.presigned_attachment_uploads is true"). The SDK's
  // parseInstanceDiscovery drops unknown keys (features included), so we read
  // the document through our own discovery — cached per origin for the process
  // lifetime, so this is a cache hit after the boot validation call. A failure
  // here is logged and degrades to multipart file sends (flag off).
  let features = {};
  try {
    const discovered = await discoverInstance(origin);
    const rawFeatures = discovered?.document?.features;
    if (rawFeatures && typeof rawFeatures === "object") {
      features = {
        presignedAttachmentUploads: rawFeatures.presigned_attachment_uploads === true,
      };
    }
  } catch (err) {
    console.warn(
      `[fluxer] ${instanceKey} discovery features lookup failed (file sends default to multipart): ${err?.message || err}`,
    );
  }

  const handle = {
    instanceKey,
    label: (typeof entry?.label === "string" && entry.label.trim()) || origin,
    userId: (client.user && client.user.id) || null,
    ready: false,
    rest,
    fetchGuild,
    guildFetch,
    destroy,
    features,
    outbound: null,
  };
  // Contract 5: the OutboundClient is built over this handle. Outbound's
  // method set is spec 375-397; it never sees the SDK client itself.
  handle.outbound = createFluxerOutbound(handle);

  /** Attach one gateway event with its own catch (AGENTS.md rule 1). */
  const onEvent = (name, label, fn) => {
    client.on(name, (payload) => {
      Promise.resolve()
        .then(() => fn(payload))
        .catch((err) => {
          console.error(
            `[fluxer] ${instanceKey} ${label} failed: ${err?.message || err}`,
          );
        });
    });
  };

  onEvent(eventName("MessageCreate", "messageCreate"), "messageCreate", async (msg) => {
    const normalized = normalizeFluxerMessage(msg, { instanceKey });
    if (!normalized) return; // DM / payload without guild_id (contract 4)
    await pipelines.onMessageCreate(handle.outbound, normalized, {
      registry: pipelineHooks.registry,
      supervisor: pipelineHooks.supervisor,
      gorkClient: null,
    });
  });

  onEvent(eventName("MessageReactionAdd", "messageReactionAdd"), "messageReactionAdd", async (payload) => {
    const normalized = normalizeFluxerReaction(payload, { instanceKey });
    if (!normalized) return;
    await pipelines.onFluxerReactionAdd(handle.outbound, normalized);
  });

  onEvent(eventName("MessageReactionRemove", "messageReactionRemove"), "messageReactionRemove", async (payload) => {
    const normalized = normalizeFluxerReaction(payload, { instanceKey });
    if (!normalized) return;
    await pipelines.onFluxerReactionRemove(handle.outbound, normalized);
  });

  // Ready refreshes identity fields the login promise raced.
  client.once(eventName("Ready", "ready"), () => {
    handle.ready = true;
    if (client.user && client.user.id) handle.userId = client.user.id;
  });

  // Gateway errors after ready are logged only — the SDK reconnects, and
  // nothing here may disconnect Discord or exit the process (spec § Boot).
  try {
    client.on(eventName("Error", "error"), (err) => {
      console.error(
        `[fluxer] ${instanceKey} gateway error (SDK will attempt reconnect): ${err?.message || err}`,
      );
    });
  } catch (err) {
    console.error(
      `[fluxer] ${instanceKey} could not attach gateway error listener: ${err?.message || err}`,
    );
  }

  handle.ready = Boolean(handle.userId) || handle.ready;
  return handle;
}

module.exports = {
  createFluxerHandle,
};
