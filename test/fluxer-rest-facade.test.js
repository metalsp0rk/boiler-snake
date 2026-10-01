/**
 * Unit tests for buildRestFacade in src/platform/fluxer/client.js.
 *
 * Background (prod 2026-10-01): the shipped façade required rest.request(),
 * which @fluxerjs/rest@3.x's REST class does NOT have (verbs only: get/post/
 * patch/put/delete) — every outbound call threw "SDK surface mismatch".
 * It also forwarded Phase 0 "/v1/..." routes verbatim, and the SDK's
 * resolveRequestUrl ALWAYS prepends /v{version} → /api/v1/v1/... → 404 on
 * every send. The SDK ignores options.query, so the façade must serialize it.
 * These tests pin all three behaviors. No network, no SDK import.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildRestFacade } = require("../src/platform/fluxer/client");

/** REST-class-shaped fake: verb methods only, like the real SDK. */
function verbRest() {
  const calls = [];
  const rest = {};
  for (const verb of ["get", "post", "patch", "put", "delete"]) {
    rest[verb] = (route, options) => {
      calls.push({ verb, route, options });
      return Promise.resolve({ ok: verb, route });
    };
  }
  return { rest, calls };
}

describe("platform/fluxer/client — buildRestFacade (SDK REST verbs)", () => {
  it("dispatches verbs and strips the /v1 prefix (no double-prefix 404s)", async () => {
    const { rest, calls } = verbRest();
    const facade = buildRestFacade({ rest }, "chat.test");

    await facade.request("GET", "/v1/guilds/123");
    await facade.request("POST", "/v1/channels/9/messages", { body: { content: "hi" } });
    await facade.request("PUT", "/v1/channels/9/messages/5/reactions/%F0%9F%91%8D/@me");
    await facade.request("DELETE", "/v1/channels/9/messages/5/reactions/x/@me");
    await facade.request("PATCH", "/v1/channels/9/messages/5", { body: { content: "edit" } });

    assert.deepEqual(
      calls.map((c) => `${c.verb} ${c.route}`),
      [
        "get /guilds/123",
        "post /channels/9/messages",
        "put /channels/9/messages/5/reactions/%F0%9F%91%8D/@me",
        "delete /channels/9/messages/5/reactions/x/@me",
        "patch /channels/9/messages/5",
      ],
      "version prefix stripped, leading slash kept (SDK Routes convention)",
    );
    assert.deepEqual(calls[1].options, { body: { content: "hi" } });
    assert.deepEqual(calls[4].options, { body: { content: "edit" } });
  });

  it("serializes options.query into the route string (SDK ignores options.query)", async () => {
    const { rest, calls } = verbRest();
    const facade = buildRestFacade({ rest }, "chat.test");

    await facade.request("GET", "/v1/channels/9/messages", {
      query: { limit: 100, before: "1555314179143892992", after: null },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].verb, "get");
    assert.equal(calls[0].route, "/channels/9/messages?limit=100&before=1555314179143892992");
    assert.ok(!("query" in calls[0].options), "query must not leak into SDK options");
  });

  it("accepts leading-slash-free routes unchanged", async () => {
    const { rest, calls } = verbRest();
    const facade = buildRestFacade({ rest }, "chat.test");

    await facade.request("GET", "gateway/bot");

    assert.equal(calls[0].route, "gateway/bot");
  });

  it("falls back to rest.request for the test-fake surface (law paths verbatim)", async () => {
    const seen = [];
    const facade = buildRestFacade(
      { rest: { request: (m, p, o) => { seen.push([m, p, o]); return Promise.resolve("via-request"); } } },
      "chat.test",
    );

    const out = await facade.request("GET", "/v1/guilds/5", { body: { x: 1 } });

    assert.equal(out, "via-request");
    assert.deepEqual(seen, [["GET", "/v1/guilds/5", { body: { x: 1 } }]]);
  });

  it("throws a specific surface-mismatch error when the SDK exposes neither surface", async () => {
    const facade = buildRestFacade({ rest: {} }, "chat.test");

    await assert.rejects(
      () => facade.request("GET", "/v1/guilds/5"),
      /SDK surface mismatch/,
    );

    const noRest = buildRestFacade({}, "chat.test");
    await assert.rejects(
      () => noRest.request("GET", "/v1/guilds/5"),
      /SDK surface mismatch/,
    );
  });
});
