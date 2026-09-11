const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  describeError,
  githubGet,
  fetchRepo,
  fetchReleases,
} = require("../src/features/githubReleases/github");

function mockFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
}

function response({ status = 200, body = {}, headers = {}, throwOnJson = false }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => {
      if (throwOnJson) throw new Error("invalid json");
      return body;
    },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("github describeError", () => {
  it("surfaces the fetch cause", () => {
    const cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND api.github.com"),
      { code: "ENOTFOUND" },
    );
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    const text = describeError(err);
    assert.match(text, /^TypeError: fetch failed/);
    assert.match(text, /cause: getaddrinfo ENOTFOUND api\.github\.com$/);
  });

  it("keeps plain errors on one line", () => {
    assert.equal(describeError(new Error("boom")), "Error: boom");
  });
});

describe("githubGet", () => {
  let restore = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("returns parsed JSON on success", async () => {
    restore = mockFetch(async (url, opts) => {
      globalThis.__lastUrl = String(url);
      globalThis.__lastHeaders = opts.headers;
      return response({ body: { hello: "world" } });
    });
    const res = await githubGet("/repos/a/b", "tok-123");
    assert.equal(res.ok, true);
    assert.deepEqual(res.data, { hello: "world" });
    assert.equal(globalThis.__lastUrl, "https://api.github.com/repos/a/b");
    assert.equal(globalThis.__lastHeaders.Authorization, "Bearer tok-123");
  });

  it("omits Authorization without a token", async () => {
    restore = mockFetch(async (url, opts) => {
      globalThis.__lastHeaders = opts.headers;
      return response({ body: [] });
    });
    await githubGet("/x");
    assert.equal(globalThis.__lastHeaders.Authorization, undefined);
  });

  it("translates 404 with the private-repo hint", async () => {
    restore = mockFetch(async () => response({ status: 404 }));
    const res = await githubGet("/repos/a/b");
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.match(res.error, /not found.*private/i);
  });

  it("translates 401 token rejection", async () => {
    restore = mockFetch(async () => response({ status: 401 }));
    const res = await githubGet("/repos/a/b", "bad-tok");
    assert.equal(res.ok, false);
    assert.match(res.error, /rejected the configured token/);
  });

  it("reports rate limits with remaining header", async () => {
    restore = mockFetch(async () =>
      response({
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    );
    const res = await githubGet("/repos/a/b");
    assert.equal(res.ok, false);
    assert.match(res.error, /rate limit reached \(remaining: 0\)/);
    assert.match(res.error, /configure a token/);
  });

  it("extracts GitHub JSON error messages on 5xx", async () => {
    restore = mockFetch(async () =>
      response({ status: 502, body: { message: "Bad gateway" } }),
    );
    const res = await githubGet("/repos/a/b");
    assert.equal(res.ok, false);
    assert.match(res.error, /API error 502: Bad gateway/);
  });

  it("maps network failures to a cause description", async () => {
    restore = mockFetch(async () => {
      const cause = Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      });
      throw Object.assign(new TypeError("fetch failed"), { cause });
    });
    const res = await githubGet("/repos/a/b");
    assert.equal(res.ok, false);
    assert.equal(res.status, null);
    assert.match(res.error, /ECONNRESET socket hang up/);
  });

  it("fails on unreadable JSON body", async () => {
    restore = mockFetch(async () =>
      response({ status: 200, body: "", throwOnJson: true }),
    );
    const res = await githubGet("/repos/a/b");
    assert.equal(res.ok, false);
    assert.match(res.error, /unreadable response/);
  });
});

describe("fetchRepo", () => {
  let restore = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("returns the canonical full_name", async () => {
    restore = mockFetch(async () =>
      response({ body: { full_name: "Acme/Widgets" } }),
    );
    const res = await fetchRepo("acme/widgets");
    assert.deepEqual(res, { ok: true, fullName: "Acme/Widgets" });
  });

  it("passes errors through", async () => {
    restore = mockFetch(async () => response({ status: 404 }));
    const res = await fetchRepo("no/such");
    assert.equal(res.ok, false);
    assert.match(res.error, /not found/i);
  });
});

describe("fetchReleases", () => {
  let restore = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  const raw = (id, opts = {}) => ({
    id,
    tag_name: `v${id}`,
    name: opts.name ?? `Release ${id}`,
    body: "notes",
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    html_url: `https://github.com/a/b/releases/tag/v${id}`,
    author: { login: "a" },
    published_at: new Date(1_700_000_000_000 + id * 1000).toISOString(),
  });

  it("filters drafts and sorts newest-first with normalized fields", async () => {
    restore = mockFetch(async () =>
      response({
        body: [
          raw(1, { draft: true }),
          raw(2),
          { id: 3, tag_name: "v3" }, // no published_at → filtered
          { ...raw(4, { prerelease: true }), name: null },
        ],
      }),
    );
    const res = await fetchReleases("a/b", "tok");
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.releases.map((r) => r.id),
      [4, 2],
    );
    assert.equal(res.releases[0].prerelease, true);
    assert.equal(res.releases[0].name, "v4"); // name falls back to tag
    assert.equal(res.releases[1].tag, "v2");
    assert.ok(res.releases[0].publishedAtMs > res.releases[1].publishedAtMs);
  });

  it("rejects unexpected payloads", async () => {
    restore = mockFetch(async () => response({ body: { message: "oops" } }));
    const res = await fetchReleases("a/b");
    assert.equal(res.ok, false);
    assert.match(res.error, /unexpected releases payload/);
  });
});
