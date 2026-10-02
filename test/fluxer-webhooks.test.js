/**
 * Unit tests for src/platform/fluxer/webhooks.js (PR 3, §10.3 delta 3).
 *
 * NO real network: every call goes through the injected `fetch` stub below
 * (the module's injectable transport) and the SDK-free fake REST from
 * test/helpers/fluxer.js for the bot-authorized create route. The tests pin:
 *
 *   - routes: POST /v1/channels/{id}/webhooks, POST/PATCH/DELETE
 *     /v1/webhooks/{id}/{token}[/messages/{mid}], `?wait=true` on execute;
 *   - the NO-`Origin`-header rule (INVALID_API_ORIGIN, spike B13);
 *   - nonce pass-through and multipart payload_json/files[i] shape;
 *   - error-code mapping (TWO_FACTOR_REQUIRED, MAX_WEBHOOKS_PER_CHANNEL, …)
 *     and the retryable ladder (429/5xx/network → true, 4xx → false);
 *   - 404-on-delete counts as ok;
 *   - token hygiene: a webhook token never appears in an error string.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createFluxerWebhooks } = require("../src/platform/fluxer/webhooks");
const { makeFakeRest, FluxerRestError } = require("./helpers/fluxer");

const API = "https://api.fluxer.test";
const WH = { id: "1554600000000000050", token: "wh.tok.SECRET" };
const TOKEN = "wh.tok.SECRET";

/** fetch stub: key = "METHOD full-url"; every call is recorded. */
function makeFakeFetch(handlers = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = String(init.method ?? "GET").toUpperCase();
    const key = `${method} ${url}`;
    calls.push({ url, method, init, key });
    const handler = handlers[key];
    if (handler === undefined) {
      throw new Error(`unrouted fetch in test: ${key}`);
    }
    return typeof handler === "function" ? await handler(init) : handler;
  };
  fn.calls = calls;
  return fn;
}

/** Response double shaped like the global fetch Response (what the module reads). */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function apiPath(suffix) {
  return `${API}/v1/webhooks/${WH.id}/${TOKEN}${suffix}`;
}

describe("platform/fluxer/webhooks — createRelayWebhook (bot-authorized create)", () => {
  it("POSTs /v1/channels/{id}/webhooks and returns the webhook { id, token } in full", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/channels/444/webhooks": { id: WH.id, token: TOKEN, name: "Bridge Relay" },
      },
    });
    const api = createFluxerWebhooks({ rest, apiOrigin: API, fetch: makeFakeFetch() });

    const res = await api.createRelayWebhook(1, "444", { name: "Bridge Relay" });

    assert.deepEqual(res, { ok: true, webhook: { id: WH.id, token: TOKEN } });
    assert.equal(rest.calls.length, 1);
    assert.equal(rest.calls[0].method, "POST");
    assert.equal(rest.calls[0].path, "/v1/channels/444/webhooks");
    assert.deepEqual(rest.calls[0].body, { name: "Bridge Relay" });
  });

  it("rejects a missing/blank name and a non-integer community id before touching the network", async () => {
    const rest = makeFakeRest({ routes: {} });
    const api = createFluxerWebhooks({ rest, apiOrigin: API, fetch: makeFakeFetch() });

    const missing = await api.createRelayWebhook(1, "444", {});
    assert.equal(missing.ok, false);
    assert.match(missing.error, /createRelayWebhook: \{ name \} needs a non-empty string name/);

    // A Discord snowflake in the communityId slot is a PROGRAMMER ERROR:
    // assertCommunityId rejects (async) — outbound contract.
    await assert.rejects(
      () => api.createRelayWebhook("1554590611015729152", "444", { name: "x" }),
      { message: /community id required/ },
    );

    assert.equal(rest.calls.length, 0, "no request was sent for validation failures");
  });

  it("maps TWO_FACTOR_REQUIRED into { ok:false, code } — create is NOT gated by elevated_permissions", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/channels/444/webhooks": () => {
          throw new FluxerRestError("403 TWO_FACTOR_REQUIRED: bot MFA", {
            status: 403,
            code: "TWO_FACTOR_REQUIRED",
          });
        },
      },
    });
    const api = createFluxerWebhooks({ rest, apiOrigin: API, fetch: makeFakeFetch() });

    const res = await api.createRelayWebhook(1, "444", { name: "Relay" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "TWO_FACTOR_REQUIRED");
    assert.match(res.error, /status 403/);
    assert.match(res.error, /code TWO_FACTOR_REQUIRED/);
  });

  it("maps MAX_WEBHOOKS_PER_CHANNEL (400) into { ok:false, code }", async () => {
    const rest = makeFakeRest({
      routes: {
        "POST /v1/channels/444/webhooks": () => {
          throw new FluxerRestError("400 MAX_WEBHOOKS_PER_CHANNEL: 15/15", {
            status: 400,
            code: "MAX_WEBHOOKS_PER_CHANNEL",
          });
        },
      },
    });
    const api = createFluxerWebhooks({ rest, apiOrigin: API, fetch: makeFakeFetch() });
    const res = await api.createRelayWebhook(1, "444", { name: "Relay" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "MAX_WEBHOOKS_PER_CHANNEL");
  });

  it("fails when the API returns a webhook without a token (no half-built handle)", async () => {
    const rest = makeFakeRest({ routes: { "POST /v1/channels/444/webhooks": { id: "11" } } });
    const api = createFluxerWebhooks({ rest, apiOrigin: API, fetch: makeFakeFetch() });
    const res = await api.createRelayWebhook(1, "444", { name: "Relay" });
    assert.equal(res.ok, false);
    assert.match(res.error, /without a token/);
  });
});

describe("platform/fluxer/webhooks — executeRelayWebhook", () => {
  it("POSTs the token route with wait=true, NO Origin header, and all §10.3 fields", async () => {
    const fetchStub = makeFakeFetch({
      [`POST ${apiPath("?wait=true")}`]: jsonResponse(200, { id: "1554600000000007777" }),
    });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });

    const res = await api.executeRelayWebhook(WH, {
      content: "hello from the other side",
      username: "Relay (Bridge)",
      avatarUrl: "https://cdn.test/avatar.png",
      allowedMentions: {},
      flags: 1 << 12, // SUPPRESS_NOTIFICATIONS
      nonce: "a".repeat(32),
    });

    assert.deepEqual(res, { ok: true, messageId: "1554600000000007777" });
    assert.equal(fetchStub.calls.length, 1);
    const call = fetchStub.calls[0];
    assert.equal(call.method, "POST");
    assert.ok(call.url.endsWith("/v1/webhooks/1554600000000000050/wh.tok.SECRET?wait=true"));

    // NO Origin header — Fluxer refuses first-party web origins (B13).
    const headerNames = Object.keys(call.init.headers ?? {}).map((h) => h.toLowerCase());
    assert.equal(headerNames.includes("origin"), false, "no Origin header is ever sent");

    const body = JSON.parse(call.init.body);
    assert.equal(body.content, "hello from the other side");
    assert.equal(body.username, "Relay (Bridge)", "attribution rides the username override");
    assert.equal(body.avatar_url, "https://cdn.test/avatar.png");
    assert.deepEqual(body.allowed_mentions, {}, "the relay pins {} to suppress pings");
    assert.equal(body.flags, 4096, "numeric flags pass through");
    assert.equal(body.nonce, "a".repeat(32), "nonce passes through verbatim");
  });

  it("sends multipart (payload_json + files[i]) when files are present", async () => {
    const fetchStub = makeFakeFetch({
      [`POST ${apiPath("?wait=true")}`]: jsonResponse(200, { id: "m-2" }),
    });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });

    const res = await api.executeRelayWebhook(WH, {
      content: "see attached",
      username: "Relay",
      files: [{ name: "board.png", data: Buffer.from("PNGBYTES"), contentType: "image/png" }],
      nonce: "n-1",
    });

    assert.deepEqual(res, { ok: true, messageId: "m-2" });
    const body = fetchStub.calls[0].init.body;
    assert.ok(body instanceof FormData, "files ride the multipart path");
    const payload = JSON.parse(body.get("payload_json"));
    assert.equal(payload.content, "see attached");
    assert.equal(payload.nonce, "n-1", "nonce travels inside payload_json");
    const part = body.get("files[0]");
    assert.ok(part instanceof Blob);
    assert.equal(await part.text(), "PNGBYTES");
    assert.equal(part.type, "image/png");
    assert.deepEqual(
      fetchStub.calls[0].init.headers,
      {},
      "no content-type header on multipart — fetch owns the boundary",
    );
  });

  it("maps 429 to { ok:false, retryable:true } with the platform code", async () => {
    const fetchStub = makeFakeFetch({
      [`POST ${apiPath("?wait=true")}`]: jsonResponse(429, {
        code: "RATE_LIMITED",
        message: "slow down",
      }),
    });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });

    const res = await api.executeRelayWebhook(WH, { content: "hi" });
    assert.equal(res.ok, false);
    assert.equal(res.retryable, true);
    assert.equal(res.code, "RATE_LIMITED");
    assert.match(res.error, /HTTP 429/);
    assert.match(res.error, /RATE_LIMITED/);
    assert.ok(!res.error.includes(TOKEN), "the webhook token never enters the error text");
  });

  it("maps 5xx to retryable:true and 4xx to retryable:false with the code captured", async () => {
    const fetchStub = makeFakeFetch({
      [`POST ${apiPath("?wait=true")}`]: jsonResponse(503, { code: "MAINTENANCE" }),
      [`PATCH ${apiPath("/messages/m-9")}`]: jsonResponse(403, { code: "Missing Permissions" }),
    });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });

    const failed500 = await api.executeRelayWebhook(WH, { content: "hi" });
    assert.equal(failed500.retryable, true);
    assert.equal(failed500.code, "MAINTENANCE");

    const failed403 = await api.patchRelayMessage(WH, "m-9", { content: "edit" });
    assert.equal(failed403.ok, false);
    assert.equal(failed403.code, "Missing Permissions");
    assert.ok(!("retryable" in failed403), "patch failures carry no retryable (spec shape)");
  });

  it("treats transport failures (fetch throws) as retryable", async () => {
    const fetchStub = makeFakeFetch({
      [`POST ${apiPath("?wait=true")}`]: () => {
        throw new TypeError("fetch failed: socket closed");
      },
    });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });

    const res = await api.executeRelayWebhook(WH, { content: "hi" });
    assert.equal(res.ok, false);
    assert.equal(res.retryable, true, "a network-level failure is transient");
    assert.match(res.error, /socket closed/);
  });

  it("returns { ok:true, messageId:null } when an accepted send carries no message id", async () => {
    const fetchStub = makeFakeFetch({ [`POST ${apiPath("?wait=true")}`]: jsonResponse(200, null) });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });
    const res = await api.executeRelayWebhook(WH, { content: "hi" });
    assert.deepEqual(res, { ok: true, messageId: null });
  });

  it("validates the RelayWebhook handle before any network (error names the method, never the token)", async () => {
    const fetchStub = makeFakeFetch({});
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });

    const res = await api.executeRelayWebhook({ id: "11", token: "" }, { content: "hi" });
    assert.equal(res.ok, false);
    assert.equal(res.retryable, false);
    assert.match(res.error, /executeRelayWebhook: webhook 11 has no token/);
    assert.ok(!res.error.includes(TOKEN));
    assert.equal(fetchStub.calls.length, 0);

    const noId = await api.deleteRelayWebhook({ token: TOKEN });
    assert.equal(noId.ok, false);
    assert.match(noId.error, /deleteRelayWebhook: webhook.id is required/);
    assert.equal(fetchStub.calls.length, 0, "validation failures never reach the network");
  });

  it("rejects bad file descriptors before the network (index named)", async () => {
    const fetchStub = makeFakeFetch({});
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });
    const res = await api.executeRelayWebhook(WH, { files: [{ name: "x.bin", data: 42 }] });
    assert.equal(res.ok, false);
    assert.equal(res.retryable, false);
    assert.match(res.error, /files\[0\] \("x.bin"\) needs Buffer data/);
    assert.equal(fetchStub.calls.length, 0);
  });
});

describe("platform/fluxer/webhooks — patch / delete lifecycle", () => {
  it("PATCHes /v1/webhooks/{id}/{token}/messages/{mid} with the JSON body", async () => {
    const fetchStub = makeFakeFetch({
      [`PATCH ${apiPath("/messages/1554600000000007777")}`]: jsonResponse(200, { id: "1554600000000007777" }),
    });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });

    const res = await api.patchRelayMessage(WH, "1554600000000007777", {
      content: "edited body",
    });
    assert.deepEqual(res, { ok: true });
    const call = fetchStub.calls[0];
    assert.equal(call.method, "PATCH");
    assert.ok(call.url.endsWith(`/v1/webhooks/${WH.id}/${TOKEN}/messages/1554600000000007777`));
    assert.deepEqual(JSON.parse(call.init.body), { content: "edited body" });
  });

  it("DELETEs a relayed message and counts 404 as ok (idempotent delete)", async () => {
    const fetchStub = makeFakeFetch({
      [`DELETE ${apiPath("/messages/m-9")}`]: jsonResponse(404, { code: "Unknown Message" }),
    });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });

    const res = await api.deleteRelayMessage(WH, "m-9");
    assert.deepEqual(res, { ok: true });
    assert.ok(fetchStub.calls[0].url.endsWith(`/v1/webhooks/${WH.id}/${TOKEN}/messages/m-9`));
  });

  it("reports non-404 delete failures with the code", async () => {
    const fetchStub = makeFakeFetch({
      [`DELETE ${apiPath("/messages/m-9")}`]: jsonResponse(500, { code: "INTERNAL" }),
    });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });
    const res = await api.deleteRelayMessage(WH, "m-9");
    assert.equal(res.ok, false);
    assert.equal(res.code, "INTERNAL");
    assert.ok(!res.error.includes(TOKEN), "no token in the failure text");
  });

  it("DELETEs the webhook itself; 404 = ok, 500 = { ok:false, error } with no code", async () => {
    const fetchStub = makeFakeFetch({
      [`DELETE ${apiPath("")}`]: jsonResponse(404, { code: "Unknown Webhook" }),
    });
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: fetchStub });
    assert.deepEqual(await api.deleteRelayWebhook(WH), { ok: true });

    const failing = makeFakeFetch({
      [`DELETE ${apiPath("")}`]: jsonResponse(500, { code: "INTERNAL" }),
    });
    const api2 = createFluxerWebhooks({ apiOrigin: API, fetch: failing });
    const res = await api2.deleteRelayWebhook(WH);
    assert.equal(res.ok, false);
    assert.match(res.error, /deleteRelayWebhook: request failed: HTTP 500 INTERNAL/);
    assert.equal(res.code, undefined, "deleteRelayWebhook failures carry no platform code (§10.3)");
    assert.ok(!res.error.includes(TOKEN));
  });

  it("requires a messageId for patch/delete (specific, actionable error)", async () => {
    const api = createFluxerWebhooks({ apiOrigin: API, fetch: makeFakeFetch({}) });
    assert.match((await api.patchRelayMessage(WH, null, { content: "x" })).error, /messageId is required/);
    assert.match((await api.deleteRelayMessage(WH, "")).error, /messageId is required/);
  });
});

describe("platform/fluxer/webhooks — transport wiring", () => {
  it("createRelayWebhook fails specifically when no REST transport is injected", async () => {
    const api = createFluxerWebhooks({ fetch: makeFakeFetch({}) });
    const res = await api.createRelayWebhook(1, "7", { name: "Relay" });
    assert.equal(res.ok, false);
    assert.match(res.error, /transport needs a rest facade with request\(\)/);
  });
});
