/**
 * Gork `read_page` tool unit tests (locked spec: session 2026-09-07).
 *
 * Fully dependency-injected — NO network and NO database anywhere: the
 * DNS resolver (`resolver`) and fetch (`fetchImpl`) are stubbed on every
 * call, and only `tools/readPage` is required (never trigger.js or
 * audit.js, whose require chains open SQLite at load). Covers the SSRF
 * matrix, manual-redirect revalidation, extraction + body-fallback,
 * content-type / size guards, caps (URL, per-page, combined), mixed
 * failures in order, and the args-coercion that trigger dispatch relies
 * on (urls array|string, singular url, dedupe).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const rp = require("../src/features/gork/tools/readPage");

// ---------- helpers ----------

const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_V6 = "2606:4700:4700::1111";

/**
 * Fake fetch Response with the exact surface readPage consumes:
 * ok, status, headers.get, text. Redirect fakes carry ok:false like the
 * real `redirect: "manual"` contract.
 */
function fakeRes({
  status = 200,
  ok,
  contentType = "text/html; charset=utf-8",
  body = "",
  location = null,
  contentLength = null,
}) {
  const headers = new Map();
  headers.set("content-type", contentType);
  if (location !== null) headers.set("location", location);
  if (contentLength !== null) headers.set("content-length", contentLength);
  return {
    ok: ok === undefined ? status >= 200 && status < 300 : ok,
    status,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => body,
  };
}

/** Resolver stub: host → records from `map`, defaulting to one public v4. */
function resolverFor(map, calls = []) {
  const resolver = async (host, opts) => {
    calls.push({ host, opts });
    return map[host] ?? [{ address: PUBLIC_V4, family: 4 }];
  };
  return { resolver, calls };
}

/** fetchImpl stub: exact URL → response (or thunk); records calls. */
function fetchFor(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) {
      return fakeRes({ status: 404, body: "unrouted" });
    }
    return typeof route === "function" ? route(url, init) : route;
  };
  return { impl, calls };
}

const hangingFetch = (_url, { signal }) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });

/** All `### ` block headers in a combined output. */
const blockHeaders = (out) => out.split("\n").filter((l) => l.startsWith("### "));

// NOTE: fixture markers contain NO underscores — turndown escapes `_` to
// `\_`, which would weaken presence/absence assertions on the markdown.
const ARTICLE_HTML = [
  "<!DOCTYPE html><html><head><title>Widget Docs</title></head><body>",
  "<nav>NAVMARKERX home about pricing contact</nav>",
  '<script>var evil = "EVILSCRIPTMARKER";</script>',
  "<style>.c { color: STYLEMARKERX; }</style>",
  "<main><article><h1>Widget pricing</h1>",
  "<p>Widget pricing is exactly forty-two credits per month billed ",
  "annually to every member of the workspace. The enterprise tier adds ",
  "priority routing, dedicated capacity, and a signed support agreement ",
  "with a next business day response time.</p>",
  "<p>Refunds cover the first thirty days on any plan, no questions ",
  "asked, and the docs page describes the full policy for everyone.</p>",
  "</article></main>",
  "<footer>FOOTERMARKERX copyright widgets inc</footer>",
  "</body></html>",
].join("");

const FALLBACK_HTML = [
  "<!DOCTYPE html><html><head><title>Short Page</title></head><body>",
  '<div id="wrap"><span id="msg">FALLBACKMARKER short text under the readability threshold.</span></div>',
  "<nav>NAVJUNKFOO</nav>",
  '<script>var s = "SCRIPTJUNKBAR";</script>',
  "</body></html>",
].join("");

/** Page whose article text exceeds the 4000-char per-page cap. */
const longHtml = (marker) =>
  `<html><head><title>${marker}</title></head><body><article><p>${marker} ${"lorem ipsum dolor sit amet ".repeat(280)}</p></article></body></html>`;

// ---------- tool schema + constants ----------

describe("read_page tool schema + locked constants", () => {
  it("schema: function read_page with a required string-array urls", () => {
    const fn = rp.READ_PAGE_TOOL.function;
    assert.equal(rp.READ_PAGE_TOOL.type, "function");
    assert.equal(fn.name, "read_page");
    assert.equal(fn.parameters.type, "object");
    assert.deepEqual([...fn.parameters.required], ["urls"]);
    assert.equal(fn.parameters.properties.urls.type, "array");
    assert.equal(fn.parameters.properties.urls.items.type, "string");
    assert.match(fn.description, /up to 3 URLs/i);
  });

  it("exports the locked caps and defaults", () => {
    assert.equal(rp.DEFAULT_TIMEOUT_MS, 10_000);
    assert.equal(rp.MAX_URLS, 3);
    assert.equal(rp.MAX_PAGE_CHARS, 4000);
    assert.equal(rp.MAX_TOTAL_CHARS, 10_000);
    assert.equal(rp.MAX_BYTES, 1_000_000);
    assert.equal(rp.MAX_REDIRECTS, 2);
    assert.equal(rp.TRUNCATION_MARKER, "\n…[truncated]");
  });
});

// ---------- isPublicAddress / isBlockedHostname (pure) ----------

describe("isPublicAddress (locked SSRF policy)", () => {
  it("blocks every reserved IPv4 range from the spec", () => {
    for (const ip of [
      "0.0.0.0", "0.255.255.255", // 0/8
      "10.1.2.3", "10.255.255.255",
      "100.64.0.1", "100.127.255.255", // CGNAT 100.64/10
      "127.0.0.1", "127.9.9.9",
      "169.254.169.254",
      "172.16.0.1", "172.31.255.255",
      "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.10.10",
      "198.18.0.1", "198.19.255.255", // 198.18/15
      "198.51.100.1", "203.0.113.5",
      "224.0.0.1", "239.255.255.255", // multicast 224/4
      "240.0.0.1", "255.255.255.255", // reserved 240/4
    ]) {
      assert.equal(rp.isPublicAddress(ip), false, `${ip} must be blocked`);
    }
  });

  it("blocks reserved IPv6 (spec list)", () => {
    for (const ip of [
      "::", "::1",
      "fc00::", "fc12::34", "fd12:3456::789", // fc00::/7
      "fe80::1", "febf::9", // fe80::/10
      "ff00::", "ff02::1", "ffff::1", // ff00::/2
    ]) {
      assert.equal(rp.isPublicAddress(ip), false, `${ip} must be blocked`);
    }
  });

  it("unwraps IPv4-mapped IPv6 and re-checks as IPv4", () => {
    assert.equal(rp.isPublicAddress("::ffff:192.168.1.1"), false);
    assert.equal(rp.isPublicAddress("::ffff:10.0.0.5"), false);
    assert.equal(rp.isPublicAddress("::ffff:0a00:0005"), false); // hex form
    assert.equal(rp.isPublicAddress("::ffff:0808:0808"), true); // 8.8.8.8
    assert.equal(rp.isPublicAddress("::ffff:8.8.8.8"), true);
  });

  it("allows real public addresses", () => {
    for (const ip of [
      "8.8.8.8", PUBLIC_V4, "100.128.0.1", "100.63.255.1", "172.32.0.1",
      PUBLIC_V6, "2001:4860:4860::8888", "2a00:1450:4000:800::2001",
    ]) {
      assert.equal(rp.isPublicAddress(ip), true, `${ip} must be allowed`);
    }
  });

  it("fails closed on malformed input", () => {
    for (const junk of ["", "  ", "garbage", "999.1.1.1", "01.2.3.4",
      "1.2.3", "1.2.3.4.5", ":::", "1:2:3:4:5:6:7", "0x7f.1", "127.1",
      null, undefined, 42]) {
      assert.equal(rp.isPublicAddress(junk), false, `${junk} must fail closed`);
    }
  });
});

describe("isBlockedHostname (pre-DNS gate)", () => {
  it("blocks localhost + .local/.internal/.localhost, allows the rest", () => {
    for (const host of ["localhost", "LOCALHOST", "x.localhost",
      "api.internal", "printer.local", ""]) {
      assert.equal(rp.isBlockedHostname(host), true, `${host} must be blocked`);
    }
    for (const host of ["example.com", "localhost.example.com",
      "notlocalhost.com", "sub.api.internal.example.com", "8.8.8.8"]) {
      assert.equal(rp.isBlockedHostname(host), false, `${host} must pass`);
    }
  });
});

// ---------- SSRF through the tool (resolver + fetch stubbed) ----------

describe("executeReadPage SSRF matrix (no network)", () => {
  const PRIVATE_IPS = [
    "127.1.2.3", "10.0.0.5", "172.16.9.9", "192.168.4.4",
    "169.254.169.254", "100.64.1.2", "0.1.2.3",
    "::1", "fe80::1", "fc00::1", "fd12:3456::789", "ff02::1",
    "::ffff:192.168.1.1",
  ];

  it("blocks a host whose DNS resolves into a private/reserved address", async () => {
    for (const ip of PRIVATE_IPS) {
      const { resolver } = resolverFor({ "evil.test": [{ address: ip, family: ip.includes(":") ? 6 : 4 }] });
      const { impl, calls } = fetchFor({});
      const out = await rp.executeReadPage(
        { urls: ["http://evil.test/leak"] },
        { resolver, fetchImpl: impl },
      );
      assert.match(out, /Could not read: blocked address/, `${ip} blocked`);
      assert.equal(calls.length, 0, `no fetch for ${ip}`);
    }
  });

  it("blocks when ANY of several DNS records is private (all must pass)", async () => {
    const { resolver } = resolverFor({
      "multi.test": [
        { address: PUBLIC_V4, family: 4 },
        { address: "10.9.9.9", family: 4 },
      ],
    });
    const { impl, calls } = fetchFor({});
    const out = await rp.executeReadPage({ urls: ["http://multi.test/"] }, { resolver, fetchImpl: impl });
    assert.match(out, /blocked address/);
    assert.equal(calls.length, 0);
  });

  // One URL per call: 4+ URLs in a single call would hit the MAX_URLS
  // cap, so per-URL calls keep the block-path assertions unambiguous.
  const expectBlockedNoIo = async (url) => {
    const { resolver, calls: dnsCalls } = resolverFor({});
    const { impl, calls } = fetchFor({});
    const out = await rp.executeReadPage({ urls: [url] }, { resolver, fetchImpl: impl });
    assert.equal(blockHeaders(out).length, 1);
    assert.ok(out.includes(`### ${url}`), `header for ${url}`);
    assert.match(out, /Could not read: blocked address/, url);
    assert.equal(dnsCalls.length, 0, `no DNS for ${url}`);
    assert.equal(calls.length, 0, `no fetch for ${url}`);
  };

  it("blocks literal-IP hosts and IPv6 URL hosts without any DNS", async () => {
    for (const url of [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/x",
      "http://[::ffff:192.168.1.1]/x",
    ]) {
      await expectBlockedNoIo(url);
    }
  });

  it("blocks localhost/.local/.internal/.localhost pre-DNS", async () => {
    for (const url of [
      "http://localhost:8080/x",
      "http://db.internal/q",
      "http://p.local/m",
      "http://a.localhost/z",
    ]) {
      await expectBlockedNoIo(url);
    }
  });

  it("blocks non-http(s) schemes and malformed URLs", async () => {
    for (const url of [
      "ftp://ok.test/x",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
    ]) {
      await expectBlockedNoIo(url);
    }
  });

  it("allows a public host — fetch is reached (and DNS uses all+verbatim)", async () => {
    const { resolver, calls: dnsCalls } = resolverFor({ "pub.test": [{ address: PUBLIC_V6, family: 6 }] });
    const { impl, calls } = fetchFor({ "http://pub.test/x": fakeRes({ status: 404 }) });
    const out = await rp.executeReadPage({ urls: ["http://pub.test/x"] }, { resolver, fetchImpl: impl });
    assert.equal(calls.length, 1, "public IP passed the gate");
    assert.match(out, /Could not read: http 404/);
    assert.deepEqual(dnsCalls[0], { host: "pub.test", opts: { all: true, verbatim: true } });
  });

  it("maps resolver failure and rejection to a fetch-failed block (never throws)", async () => {
    const out1 = await rp.executeReadPage(
      { urls: ["http://nodns.test/"] },
      { resolver: async () => [], fetchImpl: fetchFor({}).impl },
    );
    assert.match(out1, /Could not read: fetch failed/);
    const out2 = await rp.executeReadPage(
      { urls: ["http://boom.test/"] },
      { resolver: async () => { throw new Error("ENOTFOUND"); }, fetchImpl: fetchFor({}).impl },
    );
    assert.match(out2, /Could not read: fetch failed/);
  });
});

// ---------- redirects ----------

describe("redirect policy (manual, ≤2, revalidated per hop)", () => {
  const A = "http://r.test/a";
  const B = "http://r.test/b";
  const C = "http://r.test/c";

  it("follows a 2-hop chain (relative Location) and reads the final page", async () => {
    const { resolver } = resolverFor({});
    const { impl, calls } = fetchFor({
      [A]: fakeRes({ status: 302, location: "/b" }),
      [B]: fakeRes({ status: 302, location: C }),
      [C]: fakeRes({ contentType: "text/plain", body: "after two hops" }),
    });
    const out = await rp.executeReadPage({ urls: [A] }, { resolver, fetchImpl: impl });
    assert.equal(calls.length, 3, "initial + 2 redirects = 3 fetches");
    assert.equal(calls[1].url, B, "relative Location resolved");
    assert.match(out, /Source: http:\/\/r\.test\/c/);
    assert.match(out, /after two hops/);
  });

  it("gives up on the 3rd redirect with 'redirect limit'", async () => {
    const { resolver } = resolverFor({});
    const loop = () => fakeRes({ status: 301, location: "http://r.test/loop" });
    const { impl, calls } = fetchFor({ "http://r.test/loop": loop });
    const out = await rp.executeReadPage({ urls: ["http://r.test/loop"] }, { resolver, fetchImpl: impl });
    assert.match(out, /Could not read: redirect limit/);
    assert.equal(calls.length, 3, "stops after MAX_REDIRECTS+1 fetches");
  });

  it("blocks mid-chain when a redirect target is private", async () => {
    const { resolver } = resolverFor({});
    const { impl, calls } = fetchFor({
      [A]: fakeRes({ status: 302, location: "http://10.0.0.5/internal" }),
    });
    const out = await rp.executeReadPage({ urls: [A] }, { resolver, fetchImpl: impl });
    assert.match(out, /Could not read: blocked address/);
    assert.equal(calls.length, 1, "the private hop was never fetched");
  });

  it("never re-points at a non-http scheme via Location", async () => {
    const { resolver } = resolverFor({});
    const { impl, calls } = fetchFor({
      [A]: fakeRes({ status: 302, location: "file:///etc/passwd" }),
    });
    const out = await rp.executeReadPage({ urls: [A] }, { resolver, fetchImpl: impl });
    assert.match(out, /blocked address/);
    assert.equal(calls.length, 1);
  });
});

// ---------- extraction ----------

describe("extraction + fallback", () => {
  it("article page → clean markdown block (no script/style/nav noise)", async () => {
    const { resolver } = resolverFor({});
    const { impl } = fetchFor({ "http://docs.test/widget": fakeRes({ body: ARTICLE_HTML }) });
    const out = await rp.executeReadPage(
      { urls: ["http://docs.test/widget"] },
      { resolver, fetchImpl: impl },
    );
    assert.match(out, /^### Widget Docs/);
    assert.match(out, /Source: http:\/\/docs\.test\/widget/);
    assert.match(out, /forty-two credits per month/);
    // Deterministic guarantees: turndown strips script/style unconditionally
    // and the output is markdown, not raw html. (Nav/footer removal is
    // deterministic only in the body-fallback path — asserted below.)
    assert.ok(!out.includes("EVILSCRIPTMARKER"), "script text stripped");
    assert.ok(!out.includes("STYLEMARKERX"), "style stripped");
    assert.ok(!out.includes("<article"), "converted to markdown, not raw html");
  });

  it("text/plain is passed through raw (no readability/turndown)", async () => {
    const { resolver } = resolverFor({});
    const { impl } = fetchFor({
      "http://plain.test/notes": fakeRes({
        contentType: "text/plain; charset=utf-8",
        body: "plain-page-marker\nsecond line\n\n\n\nfourth",
      }),
    });
    const out = await rp.executeReadPage({ urls: ["http://plain.test/notes"] }, { resolver, fetchImpl: impl });
    assert.match(out, /plain-page-marker\nsecond line\n\nfourth/);
  });

  it("non-article page still yields text via the body fallback", async () => {
    const { resolver } = resolverFor({});
    const { impl } = fetchFor({ "http://tiny.test/": fakeRes({ body: FALLBACK_HTML }) });
    const out = await rp.executeReadPage({ urls: ["http://tiny.test/"] }, { resolver, fetchImpl: impl });
    assert.match(out, /FALLBACKMARKER short text/);
    assert.ok(!out.includes("NAVJUNKFOO"), "nav stripped in fallback");
    assert.ok(!out.includes("SCRIPTJUNKBAR"), "script stripped in fallback");
  });

  it("non-readable content-type → 'unreadable content-type'", async () => {
    const { resolver } = resolverFor({});
    const { impl } = fetchFor({
      "http://api.test/j": fakeRes({ contentType: "application/json", body: "{}" }),
    });
    const out = await rp.executeReadPage({ urls: ["http://api.test/j"] }, { resolver, fetchImpl: impl });
    assert.match(out, /Could not read: unreadable content-type/);
  });

  it("declared content-length over MAX_BYTES → rejected before read", async () => {
    const { resolver } = resolverFor({});
    const { impl } = fetchFor({
      "http://big.test/": fakeRes({ contentType: "text/plain", body: "x", contentLength: String(rp.MAX_BYTES + 1) }),
    });
    const out = await rp.executeReadPage({ urls: ["http://big.test/"] }, { resolver, fetchImpl: impl });
    assert.match(out, /Could not read: fetch failed/);
  });

  it("html with no extractable content → 'empty content'", async () => {
    const { resolver } = resolverFor({});
    const { impl } = fetchFor({
      "http://void.test/": fakeRes({ body: "<html><head><title>t</title></head><body>  </body></html>" }),
    });
    const out = await rp.executeReadPage({ urls: ["http://void.test/"] }, { resolver, fetchImpl: impl });
    assert.match(out, /Could not read: empty content/);
  });
});

// ---------- caps ----------

describe("caps (URLs, per-page, combined)", () => {
  const urls4 = ["http://c.test/1", "http://c.test/2", "http://c.test/3", "http://c.test/4"];

  it("reads only 3 of 4 URLs and reports the overflow inline", async () => {
    const { resolver } = resolverFor({});
    const { impl, calls } = fetchFor(
      Object.fromEntries(urls4.map((u, i) => [u, fakeRes({ contentType: "text/plain", body: `page ${i + 1}` })])),
    );
    const out = await rp.executeReadPage({ urls: urls4 }, { resolver, fetchImpl: impl });
    assert.equal(calls.length, 3, "MAX_URLS enforced at fetch level");
    assert.ok(out.includes("page 3"), "first three read");
    assert.ok(!out.includes("Source: http://c.test/4"), "fourth not fetched");
    assert.match(out, /### http:\/\/c\.test\/4\nSkipped: read_page reads at most 3 URLs per call\./);
  });

  it("cuts a >4000-char page and marks it with the locked truncation marker", async () => {
    const { resolver } = resolverFor({});
    const { impl } = fetchFor({ "http://c.test/long": fakeRes({ body: longHtml("LONGPAGE_MARKER") }) });
    const out = await rp.executeReadPage({ urls: ["http://c.test/long"] }, { resolver, fetchImpl: impl });
    assert.match(out, /…\[truncated\]$/);
    const body = out.slice(out.indexOf("\n", out.indexOf("Source:")) + 1);
    assert.ok(body.length <= rp.MAX_PAGE_CHARS + rp.TRUNCATION_MARKER.length);
  });

  it("drops whole pages beyond the 10000-char combined budget", async () => {
    const pages = ["p1", "p2", "p3"];
    const { resolver } = resolverFor({});
    const { impl } = fetchFor(
      Object.fromEntries(pages.map((p) => [`http://c.test/${p}`, fakeRes({ contentType: "text/plain", body: `${p}_MARKER ${"filler text ".repeat(400)}` })])),
    );
    const out = await rp.executeReadPage(
      { urls: pages.map((p) => `http://c.test/${p}`) },
      { resolver, fetchImpl: impl },
    );
    assert.ok(out.includes("p1_MARKER") && out.includes("p2_MARKER"), "first pages fit");
    assert.ok(!out.includes("Source: http://c.test/p3"), "third page dropped whole");
    assert.match(out, /Skipped: 1 page dropped .*10000-character combined output limit/);
  });
});

// ---------- mixed failures / ordering / never throws ----------

describe("mixed failures stay ordered and never throw", () => {
  it("ok / http 500 / timeout blocks come back in input order", async () => {
    const { resolver } = resolverFor({});
    const { impl } = fetchFor({
      "http://mix.test/ok": fakeRes({ contentType: "text/plain", body: "OK_PAGE_MARKER" }),
      "http://mix.test/err": fakeRes({ status: 500, body: "boom" }),
    });
    const routes = { "http://mix.test/hang": hangingFetch };
    const out = await rp.executeReadPage(
      { urls: ["http://mix.test/ok", "http://mix.test/err", "http://mix.test/hang"] },
      {
        resolver,
        timeoutMs: 60,
        fetchImpl: async (url, init) =>
          routes[url] ? routes[url](url, init) : impl(url, init),
      },
    );
    const okIdx = out.indexOf("OK_PAGE_MARKER");
    const errIdx = out.indexOf("Could not read: http 500");
    const toIdx = out.indexOf("Could not read: timeout");
    assert.ok(okIdx >= 0 && errIdx > okIdx && toIdx > errIdx, "input order preserved");
    assert.equal(blockHeaders(out).length, 3);
  });

  it("a rejecting fetch becomes a failure block, not a rejection", async () => {
    const { resolver } = resolverFor({});
    const out = await rp.executeReadPage(
      { urls: ["http://down.test/"] },
      { resolver, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } },
    );
    assert.match(out, /### http:\/\/down\.test\/\nCould not read: fetch failed/);
  });

  it("no usable URLs → informative string, zero fetches", async () => {
    const { resolver } = resolverFor({});
    const { impl, calls } = fetchFor({});
    for (const args of [{}, null, { urls: [] }, { urls: [123, "", "   "] }, undefined]) {
      const out = await rp.executeReadPage(args, { resolver, fetchImpl: impl });
      assert.match(out, /no usable urls/i, JSON.stringify(args));
    }
    assert.equal(calls.length, 0);
  });
});

// ---------- dispatch coercion (what trigger hands to executeReadPage) ----------

describe("args coercion (trigger dispatch tolerance)", () => {
  const U = "http://one.test/x";

  it("normalizeUrls: array | string | {url} | dedupe | cap-3 are pure", () => {
    assert.deepEqual(rp.normalizeUrls({ urls: U }), { urls: [U], skipped: [] });
    assert.deepEqual(rp.normalizeUrls({ url: U }), { urls: [U], skipped: [] });
    assert.deepEqual(rp.normalizeUrls({ urls: [U, U, "  ", `  ${U} `] }), { urls: [U], skipped: [] });
    const many = ["a", "b", "c", "d", "e"];
    const capped = rp.normalizeUrls({ urls: many });
    assert.deepEqual(capped.urls, many.slice(0, 3));
    assert.deepEqual(capped.skipped, many.slice(3));
    assert.deepEqual(rp.normalizeUrls(null), { urls: [], skipped: [] });
  });

  it("executeReadPage accepts urls-as-string, singular url, and dedupes", async () => {
    const { resolver } = resolverFor({});
    const { impl, calls } = fetchFor({ [U]: fakeRes({ contentType: "text/plain", body: "coerced" }) });
    for (const args of [
      { urls: U },
      { url: U },
      { urls: [U, U, "  ", U] },
      U,
      [U],
    ]) {
      calls.length = 0;
      const out = await rp.executeReadPage(args, { resolver, fetchImpl: impl });
      assert.equal(calls.length, 1, `one fetch for ${JSON.stringify(args)}`);
      assert.match(out, /coerced/);
    }
  });
});
