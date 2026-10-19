/**
 * Unit tests for buildRestFacade in src/platform/fluxer/client.js.
 *
 * Background (prod 2026-10-01): the shipped façade required rest.request(),
 * which the REST package's REST class (3.x) does NOT have (verbs only:
 * get/post/
 * patch/put/delete) — every outbound call threw "SDK surface mismatch".
 * It also forwarded Phase 0 "/v1/..." routes verbatim, and the SDK's
 * resolveRequestUrl ALWAYS prepends /v{version} → /api/v1/v1/... → 404 on
 * every send. The SDK ignores options.query, so the façade must serialize it.
 * These tests pin all three behaviors. No network, no SDK import.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// #609: this file LOADS src modules whose require chain reaches src/db —
// connection.js opens DB_PATH at REQUIRE time, so bind a private temp DB
// BEFORE anything else loads. Concurrent node --test files sharing one
// ambient DB_PATH race mid-migration (the #470 G2-6 gork flake class).
const { loadDb } = require("./helpers/env");
const { cleanup: cleanupTempDb } = loadDb();
after(cleanupTempDb);


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
    // #436: every facade call carries an AbortSignal — strip it before
    // comparing payloads (its presence is pinned separately, right here).
    const payloadOf = (o) => {
      const { signal, ...rest } = o;
      assert.ok(signal instanceof AbortSignal, "facade must pass an AbortSignal (#436)");
      return rest;
    };
    assert.deepEqual(payloadOf(calls[1].options), { body: { content: "hi" } });
    assert.deepEqual(payloadOf(calls[4].options), { body: { content: "edit" } });
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
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], "GET");
    assert.equal(seen[0][1], "/v1/guilds/5", "law path verbatim through the fallback");
    const { signal: fallbackSignal, ...seenOptions } = seen[0][2];
    assert.ok(
      fallbackSignal instanceof AbortSignal,
      "the fallback surface is bounded too (#436)",
    );
    assert.deepEqual(seenOptions, { body: { x: 1 } });
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

// ── #436 (audit F1-3): every Fluxer request is bounded ─────────────────────

describe("platform/fluxer/client — request timeout (#436)", () => {
  const savedEnv = process.env.FLUXER_REQUEST_TIMEOUT_MS;
  const restore = () => {
    if (savedEnv === undefined) delete process.env.FLUXER_REQUEST_TIMEOUT_MS;
    else process.env.FLUXER_REQUEST_TIMEOUT_MS = savedEnv;
  };

  it("a hung request rejects with FluxerRequestTimeout naming instance + verb + path", async () => {
    process.env.FLUXER_REQUEST_TIMEOUT_MS = "25";
    try {
      let capturedSignal = null;
      const facade = buildRestFacade(
        {
          rest: {
            // Wedged instance: never settles, IGNORES the signal — the
            // hard race must bound the caller regardless.
            request: (_m, _p, o) => {
              capturedSignal = o.signal;
              return new Promise(() => {});
            },
          },
        },
        "wedged.test",
      );

      await assert.rejects(
        () => facade.request("GET", "/v1/guilds/9"),
        (err) => {
          assert.equal(err.name, "FluxerRequestTimeout");
          assert.match(
            err.message,
            /\[fluxer\] wedged\.test REST GET \/v1\/guilds\/9 timed out after 25ms/,
            "the error names instance, verb, path, and the budget",
          );
          return true;
        },
      );
      assert.ok(
        capturedSignal && capturedSignal.aborted,
        "the transport signal is aborted at the deadline (real socket cancel)",
      );
    } finally {
      restore();
    }
  });

  it("a LATE rejection from the abandoned request stays contained", async () => {
    process.env.FLUXER_REQUEST_TIMEOUT_MS = "20";
    try {
      let rejectLate;
      const facade = buildRestFacade(
        {
          rest: {
            request: () =>
              new Promise((_res, rej) => {
                rejectLate = rej;
              }),
          },
        },
        "late.test",
      );
      await assert.rejects(() => facade.request("GET", "/v1/x"), /timed out/);
      rejectLate(new Error("socket died late"));
      // Give the abandoned promise a chance to surface unhandled — node --test
      // fails the run on unhandled rejections, so a green suite is the pin.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally {
      restore();
    }
  });

  it("responses arriving before the deadline are unaffected ", async () => {
    process.env.FLUXER_REQUEST_TIMEOUT_MS = "5000";
    try {
      const facade = buildRestFacade(
        { rest: { request: () => Promise.resolve({ ok: true }) } },
        "fast.test",
      );
      assert.deepEqual(await facade.request("GET", "/v1/guilds/1"), { ok: true });
    } finally {
      restore();
    }
  });

  it("env parsing: only sane values stick; the transport is ALWAYS bounded", () => {
    const { fluxerRequestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS } = require("../src/platform/fluxer/restTimeout");
    for (const bad of ["", "abc", "0", "-5", "1e999", "600001", "3.5x"]) {
      process.env.FLUXER_REQUEST_TIMEOUT_MS = bad;
      assert.equal(
        fluxerRequestTimeoutMs(),
        DEFAULT_REQUEST_TIMEOUT_MS,
        `env "${bad}" must fall back to the default (no off-switch)`,
      );
    }
    assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 15000, "parity with discord.js requestTimeout");
    process.env.FLUXER_REQUEST_TIMEOUT_MS = "30000";
    assert.equal(fluxerRequestTimeoutMs(), 30000);
    process.env.FLUXER_REQUEST_TIMEOUT_MS = "2500.9";
    assert.equal(fluxerRequestTimeoutMs(), 2500, "fractional values floor");
    restore();
  });
});
