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
 * plus the lifecycle extras `label`, `ready`, `destroy`, `outbound`, and the
 * opt-in DM consumer hook `onDmMessage(listener)` (§10.3 delta 1 — returns an
 * unsubscribe function; consumers receive NormalizedDmMessage objects).
 *
 * Error handling (AGENTS.md): every async entry attaches its own catch;
 * every log carries `[fluxer]` + the instance key; nothing here ever calls
 * process.exit, and a failed Fluxer login never touches Discord.
 */

const pipelines = require("../../bot/pipelines");
const {
  normalizeFluxerMessage,
  normalizeFluxerDmMessage,
  normalizeFluxerReaction,
} = require("./normalize");
const { createFluxerOutbound } = require("./outbound");
const { discoverInstance } = require("./discovery");
const { normalizeWebappBase } = require("../../core/jumpUrl");
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
 * HTTP verb → @fluxerjs/rest REST facade method. The real SDK REST surface
 * (@fluxerjs/rest@3.x, verified in prod 2026-10-01) exposes get/post/patch/
 * put/delete — NO `.request()`. RequestManager routes are resolved as
 * `{api}/v{version}{route}`, i.e. the version prefix is ALWAYS prepended, so
 * Phase 0 "law" paths (`/v1/...`, correct for raw REST against api_public)
 * must have their leading `/v1` stripped here to avoid `/api/v1/v1/...` 404s.
 * RequestManager also ignores an `options.query` object, so query params are
 * serialized into the route string here.
 */
const REST_VERBS = {
  GET: "get",
  POST: "post",
  PATCH: "patch",
  PUT: "put",
  DELETE: "delete",
};
const VERSION_PREFIX_RE = /^\/v1(?=\/|$)/;

/**
 * Rest façade over the SDK client. Contract 5: `request(method, path,
 * { body?, query? } = {}) => Promise<any>` — SDK Rest-compatible, and the
 * fake in test/helpers/fluxer.js implements the same shape.
 *
 * Dispatch order: verb methods (real SDK) → `.request()` (test fake / any
 * SDK surface exposing it) → surface-mismatch error. Paths keep the Phase 0
 * `/v1/...` form from callers; the version prefix is stripped for the SDK
 * verb path only (the fallback path passes the law path through verbatim).
 *
 * @param {any} client SDK client (post-construction; may lack .rest on odd builds)
 * @param {string} instanceKey
 */
function buildRestFacade(client, instanceKey) {
  return {
    async request(method, path, options = {}) {
      const rest = client && client.rest;
      const verb = REST_VERBS[String(method).toUpperCase()];
      const fn = verb && rest && typeof rest[verb] === "function" ? rest[verb] : null;
      if (fn) {
        const route = String(path).replace(VERSION_PREFIX_RE, "");
        const opts = { ...options };
        let qs = "";
        if (options.query && typeof options.query === "object") {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(options.query)) {
            if (value != null) params.set(key, String(value));
          }
          qs = params.toString();
          delete opts.query;
        }
        return fn.call(rest, qs ? `${route}?${qs}` : route, opts);
      }
      if (rest && typeof rest.request === "function") {
        return rest.request(method, path, options);
      }
      throw new Error(
        `[fluxer] ${instanceKey} SDK client exposes no REST surface (get/post/patch/put/delete) — SDK surface mismatch`,
      );
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
 * Opt-in DM consumer registry (§10.3 delta 1, KD 24) — the listener array
 * behind handle.onDmMessage. Multiple consumers may register; emission is
 * async-safe: each listener runs detached-in-order with its OWN catch, so one
 * consumer throwing can never skip the next listener, kill the gateway
 * handler, or take the instance down (AGENTS.md rule 1).
 *
 * Policy-free by contract (KD 1): this dispatcher knows nothing about the
 * bridge — it hands the NormalizedDmMessage to whoever registered.
 *
 * @param {string} instanceKey instance label for the consumer-failure log line
 * @returns {{
 *   register: (listener: (dm: object) => any) => () => void,
 *   emit: (dm: object) => Promise<void>,
 *   listenerCount: () => number,
 * }}
 */
function createDmDispatcher(instanceKey = "fluxer") {
  const listeners = [];
  return {
    /**
     * Register one consumer. Returns an unsubscribe function (safe to call
     * twice; removing an unregistered listener is a no-op).
     * @param {(dm: object) => any} listener
     * @returns {() => void}
     */
    register(listener) {
      if (typeof listener !== "function") {
        throw new TypeError(
          `[fluxer] ${instanceKey} onDmMessage: listener must be a function`,
        );
      }
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    /**
     * Fan one NormalizedDmMessage out to every registered listener, awaiting
     * each (a slow consumer delays the next — relay ordering beats concurrency).
     * @param {object} dm NormalizedDmMessage
     */
    async emit(dm) {
      for (const listener of [...listeners]) {
        try {
          await listener(dm);
        } catch (err) {
          console.error(
            `[fluxer] dm consumer failed: ${err?.message || err} ` +
              `(instance ${instanceKey}, message ${dm?.id ?? "?"}, author ${dm?.authorId ?? "?"})`,
          );
        }
      }
    },
    listenerCount() {
      return listeners.length;
    },
  };
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
 *   onDmMessage: (listener: (dm: object) => any) => () => void,
 *   destroy: () => Promise<void>,
 * } | null>}
 */
/**
 * Derive the jump-URL base from a discovery result (gap #2 wiring, review
 * B1 pin): endpoints.webapp → normalized http(s) base, null when absent.
 * An advertised-but-unusable value is warned once (specific cause). Exported
 * so the `normalizeWebappBase` import binding is unit-testable WITHOUT
 * booting the SDK — the shipped regression destructured it from ./discovery
 * (which never exported it), went undefined at runtime, and the surrounding
 * catch swallowed the TypeError, silently nulling every Fluxer jump link.
 *
 * @param {{ document?: { endpoints?: { webapp?: unknown } } }|null} discovered
 * @param {string} instanceKey  log label only
 * @returns {string|null}
 */
function deriveWebappBaseUrl(discovered, instanceKey) {
  const raw = discovered?.document?.endpoints?.webapp;
  const base = normalizeWebappBase(raw);
  if (discovered && base == null && raw != null) {
    console.warn(
      `[fluxer] ${instanceKey} discovery exposed an unusable endpoints.webapp — jump links will be omitted for this instance`,
    );
  }
  return base;
}

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

  const rest = buildRestFacade(client, instanceKey);

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
  // Discovered webapp base (endpoints.webapp) for platform-aware jump URLs
  // (src/core/jumpUrl.js). Absent/unusable → null → jump links are omitted.
  let webappBaseUrl = null;
  let discovered = null;
  try {
    discovered = await discoverInstance(origin);
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
  // Pure derivation, outside the try (PR #168 review M1): the catch above
  // must describe only genuine discovery fetch failures.
  webappBaseUrl = deriveWebappBaseUrl(discovered, instanceKey);

  // Opt-in DM consumer registry (§10.3 delta 1, KD 24): MESSAGE_CREATE payloads
  // with no guild normalize to NormalizedDmMessage and fan out to consumers
  // registered via handle.onDmMessage. The guild pipeline path is untouched.
  const dmDispatcher = createDmDispatcher(instanceKey);

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
    webappBaseUrl,
    outbound: null,
    /**
     * Register a consumer for normalized inbound DMs (§10.3 delta 1, KD 24):
     * `onDmMessage((normalizedDm) => …)` receives NormalizedDmMessage objects
     * for gateway MESSAGE_CREATE events with no guild. Multiple consumers are
     * allowed; returns an unsubscribe function. The guild pipeline (pipelines
     * .onMessageCreate) is NOT touched by this path.
     * @type {(listener: (dm: object) => any) => () => void}
     */
    onDmMessage: dmDispatcher.register,
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
    if (normalized) {
      await pipelines.onMessageCreate(handle.outbound, normalized, {
        registry: pipelineHooks.registry,
        supervisor: pipelineHooks.supervisor,
        gorkClient: null,
      });
      return;
    }
    // Guild gate hit: try the DM path (§10.3 delta 1). Payloads missing the
    // fields a DM needs (id, channel, author) normalize to null and drop,
    // exactly like the pre-PR-3 behavior.
    const dm = normalizeFluxerDmMessage(msg, { instanceKey });
    if (dm) await dmDispatcher.emit(dm);
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
  deriveWebappBaseUrl,
  buildRestFacade,
  createDmDispatcher,
};
