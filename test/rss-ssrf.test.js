/**
 * RSS feed-fetch SSRF unit tests (src/features/rss/feedFetch.js — issue #305).
 *
 * Own file (NOT test/rss.test.js) so the validation table stays file-disjoint
 * from the db/state tasks. Everything runs with NO real DNS, NO sockets and
 * NO real timers: the resolver seam (resolveHost), the transport seam
 * (fetchImpl) and the guard-inherited timer seams (setTimer/clearTimer) drive
 * every scenario — the same idiom as test/ssrfGuard.test.js.
 *
 * Covers (spec § Ticker, subtask 03 acceptance):
 *  - validateFeedUrl table: non-http(s) schemes, userinfo tricks, IP-literal
 *    hosts (ALL refused at the feed-URL posture), and every refused address
 *    class through the REAL shared guard (127/8, RFC1918, 169.254/16 incl.
 *    the metadata IP, ::1, fc00::/7, fe80::/10, mixed public+private answers);
 *  - per-poll DNS-rebind defense: public-at-add-time + private-at-poll-time
 *    is refused and never fetched; EVERY poll re-resolves (no cross-poll
 *    cache) and the validated addresses ride to the transport (pin);
 *  - redirect re-validation: same-host flip to loopback refused mid-chain,
 *    cross-host redirects allowed ONLY through a fresh full check per hop,
 *    chains landing private never fetched, scheme/IP-literal redirect
 *    targets refused, budget capped at the guard's MAX_REDIRECTS;
 *  - conditional GET: If-None-Match / If-Modified-Since sent, 304 pass-
 *    through with validator echo, CRLF-poisoned stored validators dropped;
 *  - 1 MiB cap (declared + streamed), 10 s timeout via injected timer,
 *    User-Agent pin + RSS_USER_AGENT override, never-throw contract.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_FEED_USER_AGENT,
  RSS_FETCH_TIMEOUT_MS,
  MAX_FEED_BYTES,
  MAX_FEED_REDIRECTS,
  feedUserAgent,
  validateFeedUrl,
  guardedFetchForFeed,
} = require("../src/features/rss/feedFetch");

const PUBLIC_IP = "93.184.216.34"; // public example address (no traffic)
const publicResolve = async () => [PUBLIC_IP];

/** Resolver seam that must NEVER run (refusal-shape tests). */
function tripwireResolve() {
  const fn = async (host) => {
    throw new Error(`TRIPOWIRE: DNS lookup attempted for ${host}`);
  };
  return fn;
}

/** Fetch stub that records calls and must never be reached in refusal tests. */
function tripwireFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    throw new Error(`TRIPOWIRE: fetch attempted for ${url}`);
  };
  fn.calls = calls;
  return fn;
}

/** Fetch stub recording (url, init, addresses) and answering from a script. */
function recordingFetch(script) {
  const calls = [];
  const fn = async (url, init, addresses) => {
    calls.push({ url, init, addresses });
    const entry = typeof script === "function" ? script(calls.length - 1, url) : script;
    return entry;
  };
  fn.calls = calls;
  return fn;
}

/** Minimal Response-shaped object (buffered body, header lookup). */
function response({ status = 200, headers = {}, body = "<rss/>" } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => lower[String(n).toLowerCase()] ?? null },
    arrayBuffer: async () => {
      const bytes = Buffer.from(body, "utf8");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

/** Response whose body STREAMS scripted chunks (cap behavior observability). */
function streamingRes(chunks, { headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const state = { reads: 0, cancelled: 0 };
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: (n) => lower[String(n).toLowerCase()] ?? null },
    body: {
      getReader() {
        return {
          read: async () => {
            state.reads += 1;
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
          cancel: async () => {
            state.cancelled += 1;
          },
        };
      },
    },
    arrayBuffer: async () => {
      state.reads = chunks.length;
      return Buffer.concat(chunks);
    },
    state,
  };
}

/** Success fetch stub for polls that just need to complete. */
const okFetch = async () => response({ body: "feed-bytes" });

/** Success poll with permissive defaults — the rebind table drives policy. */
function poll(url, opts = {}) {
  return guardedFetchForFeed(url, { resolveHost: publicResolve, fetchImpl: okFetch, ...opts });
}

// ---------------------------------------------------------------------------
// validateFeedUrl — the add-time validation table
// ---------------------------------------------------------------------------

describe("rss/feedFetch.validateFeedUrl — scheme + shape refusals (resolver never runs)", () => {
  it("refuses non-http(s) schemes with a specific reason", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/feed.xml",
      "gopher://127.0.0.1:7001/_feed",
      "data:text/xml,<rss/>",
      "javascript:alert(1)",
      "ws://example.com/feed",
      "wss://example.com/feed",
    ]) {
      const res = await validateFeedUrl(url, { resolveHost: tripwireResolve() });
      assert.equal(res.ok, false, `must refuse ${url}`);
      assert.match(res.reason, /non-http\(s\) url/, `${url} → ${res.reason}`);
    }
  });

  it("refuses unparseable/empty/non-string input as invalid urls", async () => {
    for (const url of ["", "   ", "not a url", "example.com/feed", null, undefined, 42]) {
      const res = await validateFeedUrl(url, { resolveHost: tripwireResolve() });
      assert.equal(res.ok, false, `must refuse ${String(url)}`);
      assert.match(res.reason, /invalid url/);
    }
  });

  it("refuses userinfo host-spoof tricks before DNS", async () => {
    for (const url of [
      "https://feeds.example.com@evil.example/feed",
      "https://feeds.example.com@169.254.169.254/latest/meta-data/",
      "http://good.example.com:bad@evil.example/rss",
      "https://a%40b:pw@evil.example/rss",
    ]) {
      const res = await validateFeedUrl(url, { resolveHost: tripwireResolve() });
      assert.equal(res.ok, false, `must refuse ${url}`);
      assert.match(res.reason, /userinfo/, `${url} → ${res.reason}`);
    }
  });

  it("refuses ALL IP-literal hosts (feed-URL posture), public ones included", async () => {
    for (const url of [
      "http://127.0.0.1/feed",
      "http://169.254.169.254/latest/meta-data/",
      "https://93.184.216.34/rss", // PUBLIC literal still refused: subscriptions never legitimately point at bare IPs
      "http://[::1]/feed",
      "https://[fd00::5]/feed",
      "http://[fe80::1]/rss",
    ]) {
      const res = await validateFeedUrl(url, { resolveHost: tripwireResolve() });
      assert.equal(res.ok, false, `must refuse ${url}`);
      assert.match(res.reason, /ip-literal hostnames not allowed/, `${url} → ${res.reason}`);
    }
  });

  it("accepts http AND https for public hostnames (RSS spec: http(s) only)", async () => {
    const httpRes = await validateFeedUrl("http://feeds.example.com/rss", {
      resolveHost: publicResolve,
    });
    assert.equal(httpRes.ok, true);
    assert.equal(httpRes.url, "http://feeds.example.com/rss");
    assert.equal(httpRes.hostname, "feeds.example.com");

    const httpsRes = await validateFeedUrl("https://Feeds.Example.COM/RSS?a=1", {
      resolveHost: publicResolve,
    });
    assert.equal(httpsRes.ok, true);
    assert.equal(httpsRes.hostname, "feeds.example.com", "hostname normalized to lowercase");
    assert.match(httpsRes.url, /^https:\/\/feeds\.example\.com\/RSS\?a=1$/);
  });
});

describe("rss/feedFetch.validateFeedUrl — resolved-address table (shared guard classes)", () => {
  it("refuses names resolving into every private/reserved class via the guard", async () => {
    const cases = [
      ["loopback", "127.0.0.1"],
      ["loopback anywhere in /8", "127.5.5.5"],
      ["RFC1918 10/8", "10.0.0.5"],
      ["RFC1918 172.16/12", "172.16.0.1"],
      ["RFC1918 192.168/16", "192.168.1.1"],
      ["link-local /16", "169.254.1.1"],
      ["cloud metadata IP", "169.254.169.254"],
      ["IPv6 loopback", "::1"],
      ["ULA fc00::/7", "fc00::1"],
      ["ULA fd.. edge", "fd12:3456::78"],
      ["link-local fe80::/10", "fe80::1"],
    ];
    for (const [, addr] of cases) {
      const res = await validateFeedUrl(`https://feeds.${addr.replace(/[.:]/g, "x")}.test/rss`, {
        resolveHost: async () => [addr],
      });
      assert.equal(res.ok, false, `must refuse a name resolving to ${addr}`);
      assert.match(res.reason, new RegExp(`refused address range for ${addr.replace(/[\\.^$*+?()[\]{}|^$.]/g, "\\$&")}`));
    }
  });

  it("refuses a MIXED public+private DNS answer (all addresses validated)", async () => {
    const res = await validateFeedUrl("https://evil.example/rss", {
      resolveHost: async () => [PUBLIC_IP, "127.0.0.1"],
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /refused address range for 127\.0\.0\.1/);
  });

  it("refuses resolver failures and empty answers with the guard's named cause", async () => {
    const boom = await validateFeedUrl("https://gone.example/rss", {
      resolveHost: async () => {
        throw new Error("ENOTFOUND gone.example");
      },
    });
    assert.equal(boom.ok, false);
    assert.match(boom.reason, /dns lookup failed for gone\.example: ENOTFOUND/);

    const empty = await validateFeedUrl("https://empty.example/rss", {
      resolveHost: async () => [],
    });
    assert.equal(empty.ok, false);
    assert.match(empty.reason, /no address resolved for empty\.example/);
  });

  it("never throws: a resolver seam that explodes is a refusal, not an exception", async () => {
    const res = await validateFeedUrl("https://x.example/rss", {
      // checkHost catches this one — but even a raw throw stays a refusal.
      resolveHost: () => {
        throw new Error("kaboom");
      },
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /dns lookup failed|validation failed/);
  });
});

// ---------------------------------------------------------------------------
// Per-poll DNS-rebind defense: the add-time answer is worthless at poll time
// ---------------------------------------------------------------------------

describe("rss/feedFetch guardedFetchForFeed — per-poll DNS-rebind defense", () => {
  it("public at add time, private at poll time → REFUSED, never fetched", async () => {
    let lookups = 0;
    const resolveHost = async () => {
      lookups += 1;
      return lookups === 1 ? [PUBLIC_IP] : ["127.0.0.1"]; // record flips after the add
    };
    const added = await validateFeedUrl("https://rebind.example/rss", { resolveHost });
    assert.equal(added.ok, true, "add-time validation passes on the public answer");

    const fetchImpl = tripwireFetch();
    const res = await guardedFetchForFeed("https://rebind.example/rss", {
      resolveHost,
      fetchImpl,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /refused address range for 127\.0\.0\.1/);
    assert.equal(fetchImpl.calls.length, 0, "the rebound private address must never be connected to");
  });

  it("metadata IP at poll time (add-time was clean) → REFUSED pre-connect", async () => {
    const fetchImpl = tripwireFetch();
    const res = await guardedFetchForFeed("https://innocent.example/rss", {
      resolveHost: async () => ["169.254.169.254"],
      fetchImpl,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /refused address range for 169\.254\.169\.254/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("EVERY poll re-resolves — no cross-poll resolution cache", async () => {
    let lookups = 0;
    const resolveHost = async () => {
      lookups += 1;
      return [PUBLIC_IP];
    };
    const a = await guardedFetchForFeed("https://feeds.example.test/rss", {
      resolveHost,
      fetchImpl: okFetch,
    });
    const b = await guardedFetchForFeed("https://feeds.example.test/rss", {
      resolveHost,
      fetchImpl: okFetch,
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(lookups, 2, "poll #2 re-ran its own DNS resolution");
  });

  it("the JUST-validated addresses ride to the transport (pin semantics)", async () => {
    const fetchImpl = recordingFetch(response({ body: "ok" }));
    const res = await guardedFetchForFeed("https://feeds.example.test/rss", {
      resolveHost: async () => [PUBLIC_IP],
      fetchImpl,
    });
    assert.equal(res.ok, true);
    assert.deepEqual(
      fetchImpl.calls[0].addresses,
      [PUBLIC_IP],
      "the checked list rides to the socket (pinnedCoreFetch consumes it)",
    );
  });

  it("enforces the feed-URL policy on the FETCH path too (scheme/literal refused)", async () => {
    const fetchImpl = tripwireFetch();
    for (const url of ["file:///etc/passwd", "https://93.184.216.34/rss", "https://a@evil.test/x"]) {
      const res = await guardedFetchForFeed(url, {
        resolveHost: tripwireResolve(),
        fetchImpl,
      });
      assert.equal(res.ok, false, url);
      assert.match(res.reason, /non-http\(s\)|ip-literal|userinfo/);
    }
    assert.equal(fetchImpl.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Redirect re-validation + cap
// ---------------------------------------------------------------------------

describe("rss/feedFetch redirects — re-validated every hop, capped", () => {
  it("refuses a SAME-HOST redirect whose fresh answer flips to loopback", async () => {
    const fetchImpl = recordingFetch(() =>
      response({ status: 302, headers: { location: "https://rebind.example/private" } }),
    );
    let lookups = 0;
    const resolveHost = async () => {
      lookups += 1;
      return lookups === 1 ? [PUBLIC_IP] : ["127.0.0.1"];
    };
    const res = await guardedFetchForFeed("https://rebind.example/start", {
      resolveHost,
      fetchImpl,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /refused address range for 127\.0\.0\.1/);
    assert.equal(lookups, 2, "the redirect hop re-ran its own resolution");
    assert.deepEqual(
      fetchImpl.calls.map((c) => c.url),
      ["https://rebind.example/start"],
      "the private hop is never fetched",
    );
  });

  it("CROSS-HOST redirects are allowed but fully re-validated (fresh check + pin per hop)", async () => {
    const routes = {
      "origin.test": [PUBLIC_IP],
      "cdn.test": ["8.8.8.8"],
    };
    const fetchImpl = recordingFetch((hop) =>
      hop === 0
        ? response({ status: 301, headers: { location: "https://cdn.test/feed.xml" } })
        : response({ body: "final-feed" }),
    );
    const res = await guardedFetchForFeed("https://origin.test/rss", {
      resolveHost: async (host) => routes[host] ?? (() => {
        throw new Error(`unexpected lookup ${host}`);
      })(),
      fetchImpl,
    });
    assert.equal(res.ok, true);
    assert.equal(res.text, "final-feed");
    assert.deepEqual(
      fetchImpl.calls.map((c) => [c.url, c.addresses]),
      [
        ["https://origin.test/rss", [PUBLIC_IP]],
        ["https://cdn.test/feed.xml", ["8.8.8.8"]],
      ],
      "each hop rides ITS OWN freshly validated list",
    );
  });

  it("a redirect chain landing on a private/reserved address is REFUSED pre-connect", async () => {
    const fetchImpl = recordingFetch((hop) =>
      hop === 0
        ? response({ status: 302, headers: { location: "http://internal.test/admin" } })
        : response({ body: "STOLEN" }),
    );
    const res = await guardedFetchForFeed("https://public.test/rss", {
      resolveHost: async (host) => (host === "public.test" ? [PUBLIC_IP] : ["10.0.0.7"]),
      fetchImpl,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /refused address range for 10\.0\.0\.7/);
    assert.equal(fetchImpl.calls.length, 1, "the internal hop was never fetched");
  });

  it("redirect targets re-run the scheme + IP-literal policy", async () => {
    const ftp = await guardedFetchForFeed("https://public.test/rss", {
      resolveHost: publicResolve,
      fetchImpl: recordingFetch(() =>
        response({ status: 302, headers: { location: "ftp://cdn.test/x" } }),
      ),
    });
    assert.equal(ftp.ok, false);
    assert.match(ftp.reason, /non-http\(s\) url/);

    const literal = await guardedFetchForFeed("https://public.test/rss", {
      resolveHost: publicResolve,
      fetchImpl: recordingFetch(() =>
        response({ status: 302, headers: { location: "https://93.184.216.34/feed" } }),
      ),
    });
    assert.equal(literal.ok, false);
    assert.match(literal.reason, /ip-literal hostnames not allowed/);
  });

  it("surfaces missing redirect locations specifically", async () => {
    const res = await guardedFetchForFeed("https://public.test/rss", {
      resolveHost: publicResolve,
      fetchImpl: recordingFetch(response({ status: 301 })),
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /redirect with no location \(HTTP 301\)/);
  });

  it("caps the redirect budget at the guard's MAX_REDIRECTS (exported)", () => {
    assert.equal(MAX_FEED_REDIRECTS, 3, "reuses the guard's constant — no second number");
  });

  it("the budget is enforced: 3 redirects land, the 4th refuses", async () => {
    function chainFetch(redirects) {
      return recordingFetch((hop) =>
        hop < redirects
          ? response({ status: 301, headers: { location: `https://cdn.test/hop${hop}` } })
          : response({ body: "final" }),
      );
    }
    const three = await guardedFetchForFeed("https://cdn.test/start", {
      resolveHost: publicResolve,
      fetchImpl: chainFetch(3),
    });
    assert.equal(three.ok, true);
    assert.equal(three.text, "final");

    const four = await guardedFetchForFeed("https://cdn.test/start", {
      resolveHost: publicResolve,
      fetchImpl: chainFetch(4),
    });
    assert.equal(four.ok, false);
    assert.match(four.reason, /too many redirects/);
  });
});

// ---------------------------------------------------------------------------
// Conditional GET: validators out, 304 free-poll back
// ---------------------------------------------------------------------------

describe("rss/feedFetch conditional GET", () => {
  it("sends stored If-None-Match / If-Modified-Since", async () => {
    const fetchImpl = recordingFetch(response({ body: "x" }));
    await guardedFetchForFeed("https://feeds.test/rss", {
      resolveHost: publicResolve,
      fetchImpl,
      etag: '"abc123"',
      lastModified: "Wed, 15 Oct 2026 04:00:00 GMT",
    });
    const headers = fetchImpl.calls[0].init.headers;
    assert.equal(headers["If-None-Match"], '"abc123"');
    assert.equal(headers["If-Modified-Since"], "Wed, 15 Oct 2026 04:00:00 GMT");
  });

  it("304 is a free poll: ok + notModified, body NEVER touched, validators echoed", async () => {
    const bodyTripwire = {
      status: 304,
      ok: false,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "etag" ? '"fresh"' : null,
      },
      arrayBuffer: async () => {
        throw new Error("TRIPOWIRE: body read on 304");
      },
    };
    const res = await guardedFetchForFeed("https://feeds.test/rss", {
      resolveHost: publicResolve,
      fetchImpl: recordingFetch(bodyTripwire),
      etag: '"stale"',
      lastModified: "Wed, 15 Oct 2026 04:00:00 GMT",
    });
    assert.equal(res.ok, true);
    assert.equal(res.notModified, true);
    assert.equal(res.status, 304);
    assert.equal(res.etag, '"fresh"', "the response validator wins");
    assert.equal(res.lastModified, "Wed, 15 Oct 2026 04:00:00 GMT", "omitted → the stored one stays in force");
  });

  it("200 captures new validators + content for rss-parser's parseFromString", async () => {
    const res = await guardedFetchForFeed("https://feeds.test/rss", {
      resolveHost: publicResolve,
      fetchImpl: recordingFetch(
        response({
          status: 200,
          headers: { etag: '"v2"', "last-modified": "Thu, 16 Oct 2026 08:00:00 GMT", "content-type": "application/rss+xml" },
          body: "<rss>hi</rss>",
        }),
      ),
    });
    assert.equal(res.ok, true);
    assert.equal(res.notModified, false);
    assert.equal(res.status, 200);
    assert.equal(res.text, "<rss>hi</rss>");
    assert.equal(res.contentType, "application/rss+xml");
    assert.equal(res.etag, '"v2"');
    assert.equal(res.lastModified, "Thu, 16 Oct 2026 08:00:00 GMT");
  });

  it("drops CRLF-poisoned stored validators instead of sending them (poll goes unconditional)", async () => {
    const fetchImpl = recordingFetch(response({ body: "x" }));
    const res = await guardedFetchForFeed("https://feeds.test/rss", {
      resolveHost: publicResolve,
      fetchImpl,
      etag: '"evil"\r\nX-Injected: yes',
      lastModified: "ok\r\nvalue",
    });
    assert.equal(res.ok, true);
    const headers = fetchImpl.calls[0].init.headers;
    assert.equal(headers["If-None-Match"], undefined, "poisoned validator must not reach the wire");
    assert.equal(headers["If-Modified-Since"], undefined);
    assert.equal(res.etag, null, "and never echoes back");
  });
});

// ---------------------------------------------------------------------------
// Size cap (1 MiB), timeout (10 s), User-Agent, never-throw
// ---------------------------------------------------------------------------

describe("rss/feedFetch response cap + timeout + UA", () => {
  it("spec constants are pinned", () => {
    assert.equal(MAX_FEED_BYTES, 1024 * 1024, "1 MiB response cap");
    assert.equal(RSS_FETCH_TIMEOUT_MS, 10_000, "10 s per-attempt timeout");
  });

  it("refuses a lying declared size BEFORE touching the body", async () => {
    let touched = false;
    const res = await guardedFetchForFeed("https://big.test/rss", {
      resolveHost: publicResolve,
      maxBytes: 64,
      fetchImpl: recordingFetch({
        ok: true,
        status: 200,
        headers: { get: (n) => (String(n).toLowerCase() === "content-length" ? "999999" : null) },
        body: {
          getReader: () => {
            touched = true;
            throw new Error("unread");
          },
        },
        arrayBuffer: async () => {
          touched = true;
          return new Uint8Array();
        },
      }),
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /feed response too large \(999999 bytes\)/);
    assert.equal(touched, false);
  });

  it("stops a chunked drip AT the cap and cancels the transfer", async () => {
    const chunk = Buffer.alloc(1024, 7);
    const res0 = streamingRes(Array.from({ length: 20 }, () => chunk));
    const res = await guardedFetchForFeed("https://drip.test/rss", {
      resolveHost: publicResolve,
      maxBytes: 4096,
      fetchImpl: recordingFetch(res0),
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "feed response too large (5120 bytes)", "refuses the moment the stream crosses the cap");
    assert.ok(res0.state.reads <= 6, `reads stopped at the cap, saw ${res0.state.reads}`);
    assert.equal(res0.state.cancelled >= 1, true, "the transfer is cancelled, not abandoned open");
  });

  it("within-cap streamed bodies land whole (text for parseFromString)", async () => {
    const res0 = streamingRes([Buffer.from("<rss>"), Buffer.from("</rss>")]);
    const res = await guardedFetchForFeed("https://fine.test/rss", {
      resolveHost: publicResolve,
      maxBytes: 4096,
      fetchImpl: recordingFetch(res0),
    });
    assert.equal(res.ok, true);
    assert.equal(res.text, "<rss></rss>");
  });

  it("the timeout aborts the attempt via the timer seams (named reason, no real clock)", async () => {
    // Same fake-timer idiom as test/ssrfGuard.test.js: the production timer
    // is unref'd, so tests MUST drive the abort themselves (Node 22/24
    // event-loop-ref semantics differ).
    let fireTimeout;
    let cleared = false;
    let stubAttached;
    const attached = new Promise((r) => (stubAttached = r));

    const pending = guardedFetchForFeed("https://stall.test/rss", {
      resolveHost: publicResolve,
      timeoutMs: 5, // never armed on a real clock — setTimer below replaces it
      setTimer: (fn) => {
        fireTimeout = fn;
        return {}; // fake handle (no unref) — must be tolerated
      },
      clearTimer: () => {
        cleared = true;
      },
      fetchImpl: (url, init) => {
        assert.ok(init?.signal, "must pass an AbortSignal to the transport");
        return new Promise((_resolve, reject) => {
          const abortError = () =>
            Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
          if (init.signal.aborted) {
            reject(abortError());
            return;
          }
          init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
          stubAttached();
        });
      },
    });

    await attached;
    assert.equal(cleared, false, "the timer stays armed while the request is in flight");
    fireTimeout();
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.reason, "feed fetch timed out");
    assert.equal(cleared, true, "the timer is cleared once the attempt settles");
  });

  it("sends the STABLE default User-Agent; RSS_USER_AGENT and opts.userAgent override", async () => {
    const seen = (opts) => {
      const fetchImpl = recordingFetch(response({ body: "x" }));
      return guardedFetchForFeed("https://feeds.test/rss", {
        resolveHost: publicResolve,
        fetchImpl,
        ...opts,
      }).then(() => fetchImpl.calls[0].init.headers["User-Agent"]);
    };

    assert.equal(await seen({}), DEFAULT_FEED_USER_AGENT, "stable built-in UA by default");
    assert.equal(await seen({ userAgent: "CustomBot/2.0" }), "CustomBot/2.0", "explicit override wins");

    const saved = process.env.RSS_USER_AGENT;
    try {
      process.env.RSS_USER_AGENT = "DeployBot/1.1 (ops.example.com)";
      assert.equal(await seen({}), "DeployBot/1.1 (ops.example.com)", "env override, re-read per call");
      process.env.RSS_USER_AGENT = "   ";
      assert.equal(await seen({}), DEFAULT_FEED_USER_AGENT, "blank env value falls back to the stable UA");
    } finally {
      if (saved === undefined) delete process.env.RSS_USER_AGENT;
      else process.env.RSS_USER_AGENT = saved;
    }
  });

  it("feedUserAgent reads an injected env source (test seam) without touching process.env", () => {
    assert.equal(feedUserAgent({ RSS_USER_AGENT: "FromEnv/9" }), "FromEnv/9");
    assert.equal(feedUserAgent({}), DEFAULT_FEED_USER_AGENT);
  });

  it("never throws: a throwing transport seam becomes a specific refusal", async () => {
    const res = await guardedFetchForFeed("https://dead.test/rss", {
      resolveHost: publicResolve,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED 93.184.216.34:443");
      },
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /fetch failed: ECONNREFUSED 93\.184\.216\.34:443/);
  });

  it("HTTP errors surface with the status; non-ok 2xx/4xx/5xx refuse without a body read", async () => {
    for (const status of [403, 404, 429, 500, 503]) {
      const res = await poll("https://gone.test/rss", {
        fetchImpl: recordingFetch(response({ status })),
      });
      assert.equal(res.ok, false);
      assert.equal(res.reason, `HTTP ${status}`);
    }
  });
});
