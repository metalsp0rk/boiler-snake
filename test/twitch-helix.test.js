const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  describeError,
  expandThumbnailUrl,
  fetchStreams,
  clearAppTokenCache,
} = require("../src/features/twitch/helix");

describe("describeError", () => {
  it("surfaces the undici DNS cause instead of a bare TypeError", () => {
    // Node wraps network failures as TypeError: fetch failed with the
    // real reason in err.cause — the prod "Helix /streams failed: TypeError"
    // bug was this cause never being logged.
    const cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND api.twitch.tv"),
      { code: "ENOTFOUND" },
    );
    const err = Object.assign(new TypeError("fetch failed"), { cause });

    const text = describeError(err);

    assert.match(text, /^TypeError: fetch failed/);
    assert.match(text, /\| cause: getaddrinfo ENOTFOUND api\.twitch\.tv$/);
    assert.ok(!text.includes("ENOTFOUND ENOTFOUND"), "should not repeat the code");
  });

  it("prefixes the cause code when the cause message omits it", () => {
    const cause = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause });

    assert.match(describeError(err), /\| cause: ECONNRESET socket hang up$/);
  });

  it("keeps plain errors on one line without a cause section", () => {
    assert.equal(describeError(new Error("boom")), "Error: boom");
  });

  it("keeps legacy code-on-error errors informative without duplication", () => {
    const err = Object.assign(
      new Error("getaddrinfo EAI_AGAIN api.twitch.tv"),
      { code: "EAI_AGAIN" },
    );

    assert.equal(describeError(err), "Error: getaddrinfo EAI_AGAIN api.twitch.tv");
  });

  it("adds a code suffix when the top-level message lacks it", () => {
    const err = Object.assign(new Error("request timed out"), {
      code: "ETIMEDOUT",
    });

    assert.equal(describeError(err), "Error (ETIMEDOUT): request timed out");
  });

  it("handles string causes", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: "boom" });

    assert.match(describeError(err), /\| cause: boom$/);
  });

  it("stringifies nullish errors", () => {
    assert.equal(describeError(null), "null");
    assert.equal(describeError(undefined), "undefined");
  });
});

describe("expandThumbnailUrl", () => {
  const HELIX_TEMPLATE =
    "https://static-cdn.jtvnw.net/previews-ttv/live_user_teampgp-{width}x{height}.jpg";

  it("expands the Helix {width}x{height} template", () => {
    // Regression: the raw template contains braces, and Discord rejected
    // every go-live embed with 400 "Invalid Form Body" until they were
    // expanded (prod incident: notifications never sent).
    assert.equal(
      expandThumbnailUrl(HELIX_TEMPLATE),
      "https://static-cdn.jtvnw.net/previews-ttv/live_user_teampgp-640x360.jpg",
    );
  });

  it("accepts explicit dimensions", () => {
    assert.match(expandThumbnailUrl(HELIX_TEMPLATE, 1280, 720), /-1280x720\.jpg$/);
  });

  it("passes plain URLs through untouched", () => {
    assert.equal(
      expandThumbnailUrl("https://example.com/thumb.jpg"),
      "https://example.com/thumb.jpg",
    );
  });

  it("returns null for empty input", () => {
    assert.equal(expandThumbnailUrl(""), null);
    assert.equal(expandThumbnailUrl(null), null);
    assert.equal(expandThumbnailUrl(undefined), null);
  });

  it("returns null when braces remain after expansion", () => {
    assert.equal(expandThumbnailUrl("https://e.com/{unknown}.jpg"), null);
  });
});

describe("fetchStreams", () => {
  /**
   * Stub global fetch with a route table; records every request URL.
   * @param {Array<{match: (u: string) => boolean, respond: (u: string) => object}>} routes
   * @param {object} env
   */
  async function withFetchStub(routes, env) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const route = routes.find((r) => r.match(String(url)));
      if (!route) throw new Error(`unstubbed fetch: ${url}`);
      return route.respond(String(url));
    };
    const prev = {
      id: process.env.TWITCH_CLIENT_ID,
      secret: process.env.TWITCH_CLIENT_SECRET,
    };
    process.env.TWITCH_CLIENT_ID = env.id ?? "test-client-id";
    process.env.TWITCH_CLIENT_SECRET = env.secret ?? "test-client-secret";
    clearAppTokenCache();
    const restore = () => {
      globalThis.fetch = original;
      if (prev.id == null) delete process.env.TWITCH_CLIENT_ID;
      else process.env.TWITCH_CLIENT_ID = prev.id;
      if (prev.secret == null) delete process.env.TWITCH_CLIENT_SECRET;
      else process.env.TWITCH_CLIENT_SECRET = prev.secret;
      clearAppTokenCache();
    };
    return { calls, restore };
  }

  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  const tokenRoute = {
    match: (u) => u.includes("id.twitch.tv/oauth2/token"),
    respond: () => jsonResponse({ access_token: "tok-1", expires_in: 3600 }),
  };

  it("returns [] only when the lookup succeeds with no live streams", async () => {
    const { restore } = await withFetchStub(
      [
        tokenRoute,
        {
          match: (u) => u.includes("/helix/streams"),
          respond: () => jsonResponse({ data: [] }),
        },
      ],
      {},
    );
    try {
      assert.deepEqual(await fetchStreams(["111", "222"]), []);
    } finally {
      restore();
    }
  });

  it("returns null (NOT []) when Helix responds with an error status", async () => {
    // Regression: failures used to collapse to [], so the ticker treated an
    // API outage as "everyone went offline" and its fetch-failed guard
    // (result == null) could never fire in production.
    const { restore } = await withFetchStub(
      [
        tokenRoute,
        {
          match: (u) => u.includes("/helix/streams"),
          respond: () => jsonResponse({ error: "Internal Server Error" }, 500),
        },
      ],
      {},
    );
    try {
      assert.equal(await fetchStreams(["111"]), null);
    } finally {
      restore();
    }
  });

  it("returns null when the request never completes", async () => {
    const { restore } = await withFetchStub(
      [
        tokenRoute,
        {
          match: (u) => u.includes("/helix/streams"),
          respond: () => {
            throw Object.assign(new TypeError("fetch failed"), {
              cause: Object.assign(new Error("connection timeout"), {
                code: "ETIMEDOUT",
              }),
            });
          },
        },
      ],
      {},
    );
    try {
      assert.equal(await fetchStreams(["111"]), null);
    } finally {
      restore();
    }
  });

  it("requests first=100 and follows the pagination cursor", async () => {
    const streamsPage1 = {
      data: [{ id: "s1", user_id: "111" }],
      pagination: { cursor: "page-2" },
    };
    const streamsPage2 = { data: [{ id: "s2", user_id: "222" }] };
    let helixCalls = 0;
    const { calls, restore } = await withFetchStub(
      [
        tokenRoute,
        {
          match: (u) => u.includes("/helix/streams"),
          respond: () =>
            jsonResponse(helixCalls++ === 1 ? streamsPage2 : streamsPage1),
        },
      ],
      {},
    );
    try {
      const streams = await fetchStreams(["111", "222"]);
      assert.deepEqual(
        streams.map((s) => s.id),
        ["s1", "s2"],
      );
      const streamUrls = calls
        .map((c) => c.url)
        .filter((u) => u.includes("/helix/streams"));
      assert.equal(streamUrls.length, 2, "should page until no cursor");
      assert.match(streamUrls[0], /first=100/);
      assert.ok(!streamUrls[0].includes("cursor="), "page 1 has no cursor");
      assert.match(streamUrls[1], /cursor=page-2/);
    } finally {
      restore();
    }
  });

  it("deduplicates broadcaster ids in the query", async () => {
    const { calls, restore } = await withFetchStub(
      [
        tokenRoute,
        {
          match: (u) => u.includes("/helix/streams"),
          respond: () => jsonResponse({ data: [] }),
        },
      ],
      {},
    );
    try {
      await fetchStreams(["111", "111", "222"]);
      const url = calls.find((c) => c.url.includes("/helix/streams")).url;
      const userId = decodeURIComponent(
        new URL(url).searchParams.get("user_id"),
      );
      assert.equal(userId, "111,222");
    } finally {
      restore();
    }
  });

  it("recovers from a revoked token: 401 refreshes the cache and retries", async () => {
    let tokenRequests = 0;
    let streamRequests = 0;
    const { calls, restore } = await withFetchStub(
      [
        {
          match: (u) => u.includes("id.twitch.tv/oauth2/token"),
          respond: () =>
            jsonResponse({ access_token: `tok-${++tokenRequests}`, expires_in: 3600 }),
        },
        {
          match: (u) => u.includes("/helix/streams"),
          respond: () =>
            jsonResponse(
              streamRequests++ === 0
                ? { error: "Unauthorized" }
                : { data: [{ id: "s1", user_id: "111" }] },
              streamRequests === 1 ? 401 : 200,
            ),
        },
      ],
      {},
    );
    try {
      const streams = await fetchStreams(["111"]);
      assert.equal(streams?.length, 1, "retry after 401 must succeed");
      assert.equal(tokenRequests, 2, "fresh token fetched after 401");
      const auths = calls
        .filter((c) => c.url.includes("/helix/streams"))
        .map((c) => c.init.headers.Authorization);
      assert.deepEqual(auths, ["Bearer tok-1", "Bearer tok-2"]);
    } finally {
      restore();
    }
  });

  it("returns [] without any network call when given no ids", async () => {
    const { calls, restore } = await withFetchStub([], {});
    try {
      assert.deepEqual(await fetchStreams([]), []);
      assert.equal(calls.length, 0);
    } finally {
      restore();
    }
  });
});
