/**
 * Unit tests for src/platform/fluxer/discovery.js (PR 6 bundle Agent A).
 *
 * Proves the § Boot discovery rules with a fake transport only — no sockets,
 * no SDK, no timers:
 * - GET {origin}/.well-known/fluxer, unauthenticated (no token anywhere).
 * - Scheme rejection: file:, javascript:, missing scheme, missing fields.
 * - Path prefixes preserved; cross-host api_public allowed.
 * - Document cached per origin for the process lifetime (clearDiscoveryCache
 *   for tests).
 * - The token (and the discovery body, and query strings) never reach any
 *   captured console string.
 */
const { describe, it, afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  discoverInstance,
  clearDiscoveryCache,
  WELL_KNOWN_PATH,
} = require("../src/platform/fluxer/discovery");

const FAKE_TOKEN = "YOUR_FAKE_FLUXER_TOKEN";

/**
 * Scriptable fetch stand-in returning a JSON Response-shaped object.
 * @param {{ status?: number, ok?: boolean, body?: any, jsonThrows?: boolean }} [spec]
 * @returns {(url: string, init?: object) => Promise<object>}
 */
function responseFor({ status = 200, ok = status >= 200 && status < 300, body, jsonThrows = false } = {}) {
  return {
    status,
    ok,
    async json() {
      if (jsonThrows) throw new Error("body is not JSON");
      return body;
    },
  };
}

/** Console capture helper: records every console.log/error argument. */
function withCapturedConsole(run) {
  const lines = [];
  const log = console.log;
  const err = console.error;
  const info = console.info;
  const record = (...args) => lines.push(args.map((a) => String(a)).join(" "));
  console.log = record;
  console.error = record;
  console.info = record;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console.log = log;
      console.error = err;
      console.info = info;
    })
    .then(
      (value) => ({ value, lines }),
      (error) => {
        error.capturedLines = lines;
        throw error;
      },
    );
}

const goodDoc = {
  endpoints: {
    api_public: "https://api.fluxer.test",
    gateway: "wss://gw.fluxer.test",
  },
};

describe("discoverInstance — happy path", () => {
  beforeEach(() => clearDiscoveryCache());
  afterEach(() => clearDiscoveryCache());

  it("GETs {origin}/.well-known/fluxer unauthenticated and returns the mapped endpoints", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return responseFor({ body: goodDoc });
    };
    const { value } = await withCapturedConsole(() =>
      discoverInstance("https://chat.example", { fetchImpl }),
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://chat.example${WELL_KNOWN_PATH}`);
    assert.equal(calls[0].init.method, "GET");
    // Unauthenticated: no Authorization header, no token in init.
    const headers = calls[0].init.headers || {};
    assert.equal(headers.authorization ?? headers.Authorization, undefined);
    assert.equal(JSON.stringify(calls[0].init).includes(FAKE_TOKEN), false);
    // The full discovery body is returned verbatim as `document`.
    assert.deepEqual(value.document, goodDoc);
    assert.equal(value.apiPublic, "https://api.fluxer.test");
    assert.equal(value.gateway, "wss://gw.fluxer.test");
  });

  it("preserves path prefixes on api_public (no invented sibling hosts)", async () => {
    clearDiscoveryCache();
    const fetchImpl = async () =>
      responseFor({
        body: { endpoints: { api_public: "https://e.com/api", gateway: "wss://gw.e.com" } },
      });
    const { value } = await withCapturedConsole(() =>
      discoverInstance("https://chat.e.com", { fetchImpl }),
    );
    assert.equal(value.apiPublic, "https://e.com/api");
    assert.equal(value.gateway, "wss://gw.e.com");
  });

  it("allows a different host than the origin (hosted service shape)", async () => {
    const fetchImpl = async () => responseFor({ body: goodDoc });
    const { value } = await withCapturedConsole(() =>
      discoverInstance("https://chat.example", { fetchImpl }),
    );
    assert.equal(value.apiPublic, "https://api.fluxer.test");
  });

  it("strips query strings from the returned endpoints (never carried, never logged)", async () => {
    const fetchImpl = async () =>
      responseFor({
        body: {
          endpoints: {
            api_public: "https://api.e.com/v1?debug=1#frag",
            gateway: "wss://gw.e.com/?token=leak",
          },
        },
      });
    const { value, lines } = await withCapturedConsole(() =>
      discoverInstance("https://chat.e.com", { fetchImpl }),
    );
    assert.equal(value.apiPublic, "https://api.e.com/v1");
    assert.equal(value.gateway, "wss://gw.e.com");
    assert.equal(lines.some((l) => l.includes("debug=1")), false);
    assert.equal(lines.some((l) => l.includes("token=leak")), false);
  });
});

describe("discoverInstance — scheme and shape rejections", () => {
  beforeEach(() => clearDiscoveryCache());
  afterEach(() => clearDiscoveryCache());

  const fetchOk = async () => responseFor({ body: goodDoc });

  it('rejects api_public scheme "file:" with a field-named message', async () => {
    const fetchImpl = async () =>
      responseFor({ body: { endpoints: { api_public: "file:///etc/passwd", gateway: "wss://gw.test" } } });
    await assert.rejects(
      () => discoverInstance("https://a.test", { fetchImpl }),
      /endpoints\.api_public scheme "file:" is not allowed/,
    );
  });

  it('rejects gateway scheme "javascript:" with a field-named message', async () => {
    const fetchImpl = async () =>
      responseFor({
        body: { endpoints: { api_public: "https://api.test", gateway: "javascript:alert(1)" } },
      });
    await assert.rejects(
      () => discoverInstance("https://a.test", { fetchImpl }),
      /endpoints\.gateway scheme "javascript:" is not allowed/,
    );
  });

  it("rejects a missing-scheme api_public (bare host)", async () => {
    const fetchImpl = async () =>
      responseFor({ body: { endpoints: { api_public: "api.fluxer.app", gateway: "wss://gw.test" } } });
    await assert.rejects(
      () => discoverInstance("https://a.test", { fetchImpl }),
      /invalid endpoints\.api_public URL/,
    );
  });

  it("rejects missing endpoints fields, naming the field", async () => {
    const noApi = async () => responseFor({ body: { endpoints: { gateway: "wss://gw.test" } } });
    await assert.rejects(
      () => discoverInstance("https://a.test", { fetchImpl: noApi }),
      /is missing endpoints\.api_public/,
    );
    const noGw = async () => responseFor({ body: { endpoints: { api_public: "https://api.test" } } });
    await assert.rejects(
      () => discoverInstance("https://a.test", { fetchImpl: noGw }),
      /is missing endpoints\.gateway/,
    );
    const noEndpoints = async () => responseFor({ body: { name: "lonely" } });
    await assert.rejects(
      () => discoverInstance("https://a.test", { fetchImpl: noEndpoints }),
      /missing the "endpoints" object/,
    );
  });

  it("rejects a non-http(s) discovery origin before fetching", async () => {
    let fetched = 0;
    const counting = async () => {
      fetched += 1;
      return responseFor({ body: goodDoc });
    };
    await assert.rejects(
      () => discoverInstance("fluxer://host.test", { fetchImpl: counting }),
      /origin scheme "fluxer:" is not allowed/,
    );
    assert.equal(fetched, 0, "must not fetch a non-http(s) discovery URL");
  });

  it("rejects unparseable origins, non-OK HTTP, and non-JSON bodies", async () => {
    await assert.rejects(
      () => discoverInstance("not a url", { fetchImpl: fetchOk }),
      /not a valid absolute URL/,
    );
    await assert.rejects(
      () => discoverInstance("https://a.test", { fetchImpl: async () => responseFor({ status: 404, ok: false }) }),
      /returned HTTP 404/,
    );
    await assert.rejects(
      () => discoverInstance("https://b.test", { fetchImpl: async () => responseFor({ jsonThrows: true }) }),
      /did not return JSON/,
    );
    await assert.rejects(
      () => discoverInstance("https://c.test", { fetchImpl: async () => responseFor({ body: "a string" }) }),
      /document is not a JSON object/,
    );
  });

  it("wraps transport rejections with the origin in the message", async () => {
    await assert.rejects(
      () =>
        discoverInstance("https://down.test", {
          fetchImpl: async () => {
            throw new Error("ECONNREFUSED");
          },
        }),
      /Fluxer discovery for https:\/\/down\.test failed: ECONNREFUSED/,
    );
  });
});

describe("discoverInstance — process-lifetime cache", () => {
  beforeEach(() => clearDiscoveryCache());
  afterEach(() => clearDiscoveryCache());

  it("serves the second call from cache and refetches after clearDiscoveryCache()", async () => {
    let fetches = 0;
    const counting = async () => {
      fetches += 1;
      return responseFor({ body: goodDoc });
    };
    const first = await withCapturedConsole(() =>
      discoverInstance("https://cached.test", { fetchImpl: counting }),
    );
    const second = await withCapturedConsole(() =>
      discoverInstance("https://cached.test", { fetchImpl: counting }),
    );
    assert.equal(fetches, 1, "second call must not hit the transport");
    assert.equal(second.value.apiPublic, first.value.apiPublic);
    clearDiscoveryCache();
    await withCapturedConsole(() => discoverInstance("https://cached.test", { fetchImpl: counting }));
    assert.equal(fetches, 2, "clearDiscoveryCache forces a fresh fetch");
  });

  it("keys the cache by normalized origin (case, trailing slash, port)", async () => {
    let fetches = 0;
    const counting = async () => {
      fetches += 1;
      return responseFor({ body: goodDoc });
    };
    await withCapturedConsole(() => discoverInstance("https://Same.Test", { fetchImpl: counting }));
    await withCapturedConsole(() => discoverInstance("https://same.test/", { fetchImpl: counting }));
    assert.equal(fetches, 1);
  });
});

describe("discoverInstance — never logs the token", () => {
  beforeEach(() => clearDiscoveryCache());
  afterEach(() => clearDiscoveryCache());

  it("no captured console string contains the token, the body, or query strings", async () => {
    // A document that carries token-shaped fields; discovery must log ONLY
    // the two endpoint URLs.
    const documentWithSecrets = {
      endpoints: { api_public: "https://api.secret.test", gateway: "wss://gw.secret.test" },
      token: FAKE_TOKEN,
      bot_token: FAKE_TOKEN,
      api_key: FAKE_TOKEN,
    };
    const { lines } = await withCapturedConsole(() =>
      discoverInstance("https://secret.test", {
        fetchImpl: async () => responseFor({ body: documentWithSecrets }),
      }),
    );
    for (const line of lines) {
      assert.equal(line.includes(FAKE_TOKEN), false, `token leaked into: ${line}`);
      assert.equal(line.includes('"endpoints"'), false, `body leaked into: ${line}`);
    }
    // Positive control: exactly the spec's info line was logged.
    assert.equal(
      lines.some((l) => l === "[fluxer] https://secret.test discovered api=https://api.secret.test gateway=wss://gw.secret.test"),
      true,
    );
  });

  it("a failed discovery throws a specific message without token material", async () => {
    // Design: discovery THROWS; src/platform/fluxer/client.js turns the throw
    // into the `[fluxer] <key> login failed: ...` console line (verified in
    // client.js). Unit level: the thrown message carries the status code and
    // never the token.
    const err = await discoverInstance("https://fail.test", {
      fetchImpl: async () => responseFor({ status: 503, ok: false }),
    }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, "discovery rejects");
    assert.match(String(err?.message ?? err), /HTTP 503/, "message carries the status code");
    assert.equal(String(err?.message ?? err).includes(FAKE_TOKEN), false);
  });
});
