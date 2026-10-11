/**
 * Audit C1 regression (issue #182): the bridge's PRODUCTION seams must wire
 * the Fluxer handle's discovered API origin into createFluxerWebhooks so the
 * webhook token endpoints resolve to ABSOLUTE URLs.
 *
 * Pre-fix, BOTH seams (relay.supervisorOutboundSeams → getWebhookApi and
 * handlers.webhookApiFor) passed `apiOrigin: ""`, so every relay fetched the
 * relative path /v1/webhooks/… → "Failed to parse URL" → all five retry
 * attempts burned → poison-park. The whole Discord→Fluxer relay was dead in
 * production while the suite stayed green because every fixture injected a
 * fake REAL origin — fixtures mirroring the code instead of modelling the
 * platform (audit §4.1).
 *
 * These tests exercise the ACTUAL production seam functions (exported for
 * tests) against a handle built like the real client.js one (apiOrigin from
 * discovery's endpoints.api_public), and assert on the FULL URL handed to
 * fetch — the observable contract the outage violated — plus the loud-failure
 * path: a handle whose discovery never resolved api_public must yield a
 * specific logged error and NO built api, never a relative-URL machine.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before every src/ require (fresh temp DB, cache reset).
const { cleanup } = loadDb();

const relay = require("../src/features/bridge/relay");
const handlers = require("../src/features/bridge/handlers");
const { makeFakeHandle } = require("./helpers/fluxer");

test.after(() => cleanup?.());

const API = "https://api.fluxer.test";
const INSTANCE = "https://fluxer.test";
const WH = { id: "1554600000000000050", token: "wh.tok.SECRET" };
const EXECUTE_URL = `${API}/v1/webhooks/${WH.id}/${WH.token}?wait=true`;

/** Supervisor shaped like the real one: fluxer is a Map keyed by instanceKey. */
function supervisorFor(handle) {
  return { discord: null, fluxer: new Map([[handle.instanceKey, handle]]) };
}

/** fetch stub recording every URL it is handed (the seam uses globalThis.fetch). */
function stubFetch(result = { id: "m-1" }) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: String(init.method ?? "GET").toUpperCase() });
    return { ok: true, status: 200, json: async () => result };
  };
  fn.calls = calls;
  return fn;
}

/** Run fn with globalThis.fetch replaced (the seams never inject a fetch). */
async function withFetchStub(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Capture console.error lines while running fn. */
async function captureConsoleError(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.error = original;
  }
}

// ---------------------------------------------------------------------------
// relay seam: supervisorOutboundSeams(...).getWebhookApi
// ---------------------------------------------------------------------------

test("relay seam: a configured handle yields an ABSOLUTE webhook URL base (C1)", async () => {
  const handle = makeFakeHandle({ instanceKey: INSTANCE, apiOrigin: API });
  const seams = relay.supervisorOutboundSeams(supervisorFor(handle));

  const api = seams.getWebhookApi("fluxer", INSTANCE);
  assert.ok(api, "a handle with a discovered apiOrigin must build a webhook api");

  const fetchStub = stubFetch({ id: "m-42" });
  const res = await withFetchStub(fetchStub, () =>
    api.executeRelayWebhook(WH, { content: "hello fluxer" }),
  );

  assert.deepEqual(res, { ok: true, messageId: "m-42" });
  assert.equal(fetchStub.calls.length, 1);
  // The C1 assertion: the URL is ABSOLUTE and equal to origin + route. The
  // old seams produced `/v1/webhooks/…` here — what real fetch rejects with
  // "Failed to parse URL".
  assert.ok(
    !fetchStub.calls[0].url.startsWith("/"),
    `relay must NEVER fetch a relative URL, got ${fetchStub.calls[0].url}`,
  );
  assert.equal(fetchStub.calls[0].url, EXECUTE_URL);
});

test("relay seam: a handle whose discovery never resolved api_public fails LOUDLY (null api + specific log)", async () => {
  const handle = makeFakeHandle({ instanceKey: INSTANCE, apiOrigin: null });
  const seams = relay.supervisorOutboundSeams(supervisorFor(handle));

  const { value: api, lines } = await captureConsoleError(async () =>
    seams.getWebhookApi("fluxer", INSTANCE),
  );

  assert.equal(api, null, "no api object — construction refused to build a relative-URL machine");
  assert.ok(
    lines.some(
      (line) =>
        line.includes("webhook api build failed") &&
        line.includes(INSTANCE) &&
        line.includes("apiOrigin is required") &&
        line.includes("endpoints.api_public"),
    ),
    `expected a logged, instance-named cause, got: ${JSON.stringify(lines)}`,
  );
});

test("relay seam: handle without an apiOrigin field at all (pre-C1 handle shape) also fails loudly", async () => {
  const handle = makeFakeHandle({ instanceKey: INSTANCE });
  delete handle.apiOrigin; // model a handle built before the C1 fix existed
  const seams = relay.supervisorOutboundSeams(supervisorFor(handle));

  const { value: api, lines } = await captureConsoleError(async () =>
    seams.getWebhookApi("fluxer", INSTANCE),
  );
  assert.equal(api, null);
  assert.ok(lines.some((line) => line.includes("apiOrigin is required")));
});

// ---------------------------------------------------------------------------
// handlers seam: webhookApiFor (the connect path)
// ---------------------------------------------------------------------------

test("handlers seam: webhookApiFor passes the handle's apiOrigin through to an absolute URL", async () => {
  const handle = makeFakeHandle({ instanceKey: INSTANCE, apiOrigin: API });

  const api = handlers.webhookApiFor(supervisorFor(handle), "fluxer", INSTANCE);
  assert.ok(api, "connect-path seam must build the api for a configured handle");

  const fetchStub = stubFetch();
  const res = await withFetchStub(fetchStub, () =>
    api.patchRelayMessage(WH, "m-7", { content: "edited" }),
  );
  assert.deepEqual(res, { ok: true });
  assert.equal(
    fetchStub.calls[0].url,
    `${API}/v1/webhooks/${WH.id}/${WH.token}/messages/m-7`,
    "edit relay resolves against the DISCOVERED api origin, absolute",
  );
});

test("handlers seam: empty apiOrigin on the handle → null api + specific logged cause (connect fails closed)", async () => {
  const handle = makeFakeHandle({ instanceKey: INSTANCE, apiOrigin: "" });

  const { value: api, lines } = await captureConsoleError(async () =>
    handlers.webhookApiFor(supervisorFor(handle), "fluxer", INSTANCE),
  );

  assert.equal(api, null, "the service's !api guard then refuses connect with its own sentence");
  assert.ok(
    lines.some((line) => line.includes(INSTANCE) && line.includes("apiOrigin is required")),
    `expected the instance-named construction failure in the log, got: ${JSON.stringify(lines)}`,
  );
});

test("handlers seam: unknown instance still returns null without touching the webhook module", async () => {
  const { value: api, lines } = await captureConsoleError(async () =>
    handlers.webhookApiFor({ discord: null, fluxer: new Map() }, "fluxer", INSTANCE),
  );
  assert.equal(api, null);
  assert.deepEqual(lines, [], "absent handle is not a construction failure — no error log expected");
});
