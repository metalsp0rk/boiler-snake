/**
 * SDK-free Fluxer test fixtures (roadmap/fluxer.md § Tests, "Fake Fluxer
 * fixture"). No sockets, no SDK: tests drive the outbound client, the
 * dispatcher, and the normalizer against a scripted fake REST transport.
 *
 * SDK-free by contract: the SDK package name string must NEVER appear in
 * this file (enforced by test/fluxer-sdk-import-guard.test.js).
 */

const { createFluxerOutbound } = require("../../src/platform/fluxer/outbound");

/**
 * Error shaped like the SDK's REST failures: HTTP status + API code packed
 * into the message (spec § Outbound client: "status + API code in the
 * message, NEVER the token").
 */
class FluxerRestError extends Error {
  /**
   * @param {string} message e.g. "404 FAKE_NO_ROUTE: GET /v1/..."
   * @param {{ status?: number, code?: string|null }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "FluxerRestError";
    this.status = info.status ?? null;
    this.code = info.code ?? null;
  }
}

/**
 * Build a fake `rest` object with the SDK Rest-compatible shape
 * (PR 6 shared contract 5): `request(method, path, { body?, query? } = {})
 * => Promise<any>`, resolving to the response data DIRECTLY (not an
 * { ok, data } envelope).
 *
 * @param {{ routes?: Record<string, any | ((body: any, req: { method: string, path: string, query: any }) => any)> }} [options]
 *   routes keys are `"METHOD /path"` (e.g. `"POST /v1/channels/7/messages"`).
 *   Values are returned as-is, or awaited when a function.
 * @returns {{ request: (method: string, path: string, opts?: { body?: any, query?: any }) => Promise<any>, calls: Array<{ method: string, path: string, body: any, query: any }> }}
 */
function makeFakeRest({ routes = {} } = {}) {
  const calls = [];
  return {
    calls,
    async request(method, path, options = {}) {
      const key = `${String(method).toUpperCase()} ${path}`;
      calls.push({
        method: String(method).toUpperCase(),
        path,
        body: options?.body,
        query: options?.query,
      });
      if (!Object.prototype.hasOwnProperty.call(routes, key)) {
        throw new FluxerRestError(`404 FAKE_NO_ROUTE: ${key}`, {
          status: 404,
          code: "FAKE_NO_ROUTE",
        });
      }
      const handler = routes[key];
      if (typeof handler === "function") {
        return handler(options?.body, {
          method: String(method).toUpperCase(),
          path,
          query: options?.query,
          calls,
        });
      }
      return handler;
    },
  };
}

/**
 * Default MESSAGE_CREATE `d` payload with the Phase 0 recorded field names
 * (id, channel_id, guild_id, author{id,bot,...}, content, timestamp,
 * attachments, mentions = user objects, mention_roles, mention_channels,
 * mention_everyone, member). There is NO `mention_users` field.
 *
 * @param {object} [overrides] shallow overrides (author/member merge shallowly)
 * @returns {object} the `d` payload
 */
function gatewayMessage(overrides = {}) {
  return {
    id: "50",
    channel_id: "7",
    guild_id: "99",
    author: { id: "5", username: "tester", bot: false },
    content: "",
    timestamp: "2026-09-29T12:00:00.000Z",
    attachments: [],
    mentions: [],
    mention_roles: [],
    mention_channels: [],
    mention_everyone: false,
    member: { roles: [] },
    ...overrides,
  };
}

/**
 * Build a contract-5 handle for outbound/dispatch tests.
 *
 * @param {{ instanceKey?: string, userId?: string, rest?: object }} [options]
 * @returns {{ instanceKey: string, userId: string, rest: object,
 *   outbound: object, fetchGuild: () => Promise<null>, ready: boolean,
 *   destroy: () => void }}
 */
function makeFakeHandle({
  instanceKey = "https://fluxer.test",
  userId = "bot-1",
  rest = makeFakeRest(),
} = {}) {
  const handle = {
    instanceKey,
    userId,
    rest,
    fetchGuild: async () => null,
    ready: true,
    destroy() {},
  };
  // Contract 5: OutboundClient is built over the handle (and reads back
  // handle.outbound for the K2 self-check, exactly like a real handle).
  handle.outbound = createFluxerOutbound(handle);
  return handle;
}

module.exports = {
  FluxerRestError,
  makeFakeRest,
  makeFakeHandle,
  gatewayMessage,
};
