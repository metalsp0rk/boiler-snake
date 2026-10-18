/**
 * Shared SSRF guard unit tests (src/core/ssrfGuard.js — audit C5 / §6 P0.7).
 *
 * Proves, with NO real DNS and NO sockets (resolver + fetch injected):
 *  - every refused address class: loopback, "this host" (0/8), RFC1918,
 *    link-local incl. the cloud-metadata IP 169.254.169.254, IPv6 unspecified
 *    /loopback/ULA/link-local, IPv4-mapped IPv6 forms, empty/garbage input;
 *  - https-only refusal BEFORE any resolver or fetch runs;
 *  - refused hosts never reach fetch (tripwire fetch would throw);
 *  - the address check RE-RUNS per redirect hop — a same-host redirect whose
 *    second DNS answer flips to loopback (rebinding shape) is refused and the
 *    second hop is never fetched;
 *  - cross-host redirects refused, same-host budget ≤ 3 enforced;
 *  - an aborted fetch surfaces as the named "download timed out" reason —
 *    driven through the INJECTED timer seams: the suite arms no real timers
 *    at all (the production timer is unref'd, and awaiting one is exactly
 *    what killed the Node 22 CI run — see the timeout test);
 *  - maxBytes: content-length refused BEFORE the body is read, and actual
 *    bytes capped after read;
 *  - headers (User-Agent) and redirect:"manual" + signal pass-through.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const guard = require("../src/core/ssrfGuard");

const PUBLIC_IP = "93.184.216.34"; // public example address (no traffic)
const publicResolve = async () => [PUBLIC_IP];

/** Fetch stub that MUST never be called in refusal tests. */
function tripwireFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    throw new Error(`TRIPOWIRE: fetch attempted for ${url}`);
  };
  fn.calls = calls;
  return fn;
}

/** Minimal Response-shaped object with header support. */
function response({ status = 200, headers = {}, body = "data" } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => lower[String(n).toLowerCase()] ?? null },
    bodyRead: false,
    arrayBuffer: async () => {
      const bytes = Buffer.from(body, "utf8");
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

describe("ssrfGuard.isDisallowedAddress", () => {
  it("refuses IPv4 loopback, this-host, RFC1918 and link-local classes", () => {
    for (const ip of [
      "127.0.0.1",
      "127.5.5.5", // whole 127/8, not just .0.0.1
      "0.0.0.0",
      "0.9.9.9", // "this host" 0/8
      "10.0.0.5",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // AWS/GCP-style cloud metadata
      "169.254.1.1", // link-local /16
    ]) {
      assert.equal(guard.isDisallowedAddress(ip), true, `must refuse ${ip}`);
    }
  });

  it("refuses IPv6 unspecified, loopback, ULA and link-local (+ bracketed + mapped IPv4)", () => {
    for (const ip of [
      "::",
      "::1",
      "[::1]",
      "fc00::1",
      "fd12:3456::78", // ULA fc00::/7
      "fe80::1",
      "febf::ffff", // link-local fe80::/10 upper edge
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:169.254.169.254", // IPv4-mapped link-local metadata
    ]) {
      assert.equal(guard.isDisallowedAddress(ip), true, `must refuse ${ip}`);
    }
  });

  it("refuses empty and unparseable addresses", () => {
    assert.equal(guard.isDisallowedAddress(""), true);
    assert.equal(guard.isDisallowedAddress("  "), true);
    assert.equal(guard.isDisallowedAddress("not-an-ip"), true);
    assert.equal(guard.isDisallowedAddress("999.1.1.1"), true);
    assert.equal(guard.isDisallowedAddress(null), true);
  });

  // #273 union: the shared list absorbed gork's locked read-page policy.
  // Every added class is non-routable-to-public, so bridge/tickets keep
  // every legitimate host while the whole surface gets the strict posture.
  it("refuses the #273 union classes (CGNAT, IANA/TEST-NET, benchmarking, multicast, reserved)", () => {
    for (const ip of [
      "100.64.0.1", // CGNAT 100.64/10 lower edge (was ALLOWED pre-#273)
      "100.127.255.255", // CGNAT upper edge
      "192.0.0.1", // IANA special-purpose /24
      "192.0.2.1", // TEST-NET-1
      "192.88.99.1", // 6to4 relay anycast
      "198.18.0.1", // benchmarking 198.18/15
      "198.51.100.1", // TEST-NET-2
      "203.0.113.1", // TEST-NET-3
      "224.0.0.1", // multicast 224/4 lower edge
      "239.255.255.255", // multicast upper edge
      "240.0.0.1", // reserved 240/4
      "255.255.255.255", // broadcast
    ]) {
      assert.equal(guard.isDisallowedAddress(ip), true, `must refuse ${ip}`);
    }
  });

  it("refuses IPv4-mapped IPv6 in HEX hextet form (the pre-#273 shared-guard bypass)", () => {
    // ::ffff:7f00:1 IS 127.0.0.1 — the old guard classified it as a plain
    // IPv6 address and let it through. All mapped notations unwrap to IPv4.
    assert.equal(guard.isDisallowedAddress("::ffff:7f00:1"), true);
    assert.equal(guard.isDisallowedAddress("::ffff:0a00:0005"), true); // 10.0.0.5
    assert.equal(guard.isDisallowedAddress("::ffff:c0a8:0101"), true); // 192.168.1.1
  });

  it("refuses the unassigned c000::/2 block (incl. ff00::/8 multicast) but not global unicast", () => {
    for (const ip of ["c000::1", "ff00::", "ff02::1", "ffff::1", "febf::1"]) {
      assert.equal(guard.isDisallowedAddress(ip), true, `must refuse ${ip}`);
    }
    for (const ip of [
      "bfff::ffff", // just below c000::/2
      "2001:db8::1",
      "2606:4700:4700::1111",
    ]) {
      assert.equal(guard.isDisallowedAddress(ip), false, `must allow ${ip}`);
    }
  });

  it("isIpLiteralHost recognizes v4/v6 literals (bracketed forms) and rejects names", () => {
    assert.equal(guard.isIpLiteralHost("93.184.216.34"), true);
    assert.equal(guard.isIpLiteralHost("[::1]"), true);
    assert.equal(guard.isIpLiteralHost("::ffff:0a00:0005"), true);
    assert.equal(guard.isIpLiteralHost("example.com"), false);
    assert.equal(guard.isIpLiteralHost("01.2.3.4"), false); // leading zeros are not literals
    assert.equal(guard.isIpLiteralHost(""), false);
  });

  it("allows public addresses (same classes the bridge guard allows)", () => {
    for (const ip of [
      PUBLIC_IP,
      "8.8.8.8",
      "172.15.0.1", // just below RFC1918 172.16/12
      "172.32.0.1", // just above
      "169.253.0.1", // just below link-local
      "99.255.255.255", // just below the #273 CGNAT block
      "100.128.0.1", // just above it (CGNAT itself is refused — see union test)
      "223.255.255.255", // just below multicast 224/4
      "2606:2800:220:1:248:1893:25c8:1946",
      "::ffff:8.8.8.8",
      "::ffff:0808:0808", // same, in hex hextet form
      "::ffff:0102:0304", // 1.2.3.4 — mapped form of a public address
    ]) {
      assert.equal(guard.isDisallowedAddress(ip), false, `must allow ${ip}`);
    }
  });
});

describe("ssrfGuard.hostRefusalReason", () => {
  it("refuses dangerous literals by name and accepts public ones", async () => {
    assert.match(
      await guard.hostRefusalReason("169.254.169.254", tripwireFetch()),
      /refused address range for 169\.254\.169\.254/
    );
    assert.equal(await guard.hostRefusalReason("93.184.216.34", tripwireFetch()), null);
    assert.match(await guard.hostRefusalReason("[::1]", tripwireFetch()), /refused address range for ::1/);
  });

  it("refuses names whose DNS answer contains any disallowed address", async () => {
    assert.match(
      await guard.hostRefusalReason("intranet.example", async () => ["10.0.0.5"]),
      /refused address range for 10\.0\.0\.5/
    );
    assert.match(
      await guard.hostRefusalReason("rebind.example", async () => [PUBLIC_IP, "127.0.0.1"]),
      /refused address range for 127\.0\.0\.1/,
      "one bad address in an otherwise-public answer is refused"
    );
    assert.equal(await guard.hostRefusalReason("cdn.example", publicResolve), null);
  });

  it("refuses resolver failures, empty answers and unparseable hostnames", async () => {
    assert.match(
      await guard.hostRefusalReason("nope.example", async () => {
        throw new Error("ENOTFOUND");
      }),
      /dns lookup failed for nope\.example: ENOTFOUND/
    );
    assert.match(
      await guard.hostRefusalReason("empty.example", async () => []),
      /no address resolved for empty\.example/
    );
    assert.match(
      await guard.hostRefusalReason("bad host!.example", publicResolve),
      /unparseable hostname/
    );
    assert.match(await guard.hostRefusalReason("", publicResolve), /empty hostname/);
  });
});

describe("ssrfGuard.downloadGuarded", () => {
  it("refuses non-https schemes before any resolver or fetch runs", async () => {
    for (const url of [
      "http://example.com/x.png",
      "file:///etc/passwd",
      "ftp://host/x",
      "gopher://127.0.0.1:7001/",
    ]) {
      const fetchImpl = tripwireFetch();
      const res = await guard.downloadGuarded(url, { fetchImpl, resolveHost: publicResolve });
      assert.equal(res.ok, false, `must refuse ${url}`);
      assert.match(res.reason, /non-https url|invalid url/);
      assert.equal(fetchImpl.calls.length, 0, `${url} must not reach fetch`);
    }
  });

  it("refuses the cloud-metadata IP literal without touching fetch or DNS", async () => {
    const fetchImpl = tripwireFetch();
    const resolveHost = async () => {
      throw new Error("TRIPOWIRE: DNS lookup attempted");
    };
    const res = await guard.downloadGuarded(
      "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
      { fetchImpl, resolveHost }
    );
    assert.equal(res.ok, false);
    assert.match(res.reason, /refused address range for 169\.254\.169\.254/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("refuses a name resolving to a private address, naming the address", async () => {
    const fetchImpl = tripwireFetch();
    const res = await guard.downloadGuarded("https://intranet.example/x.png", {
      fetchImpl,
      resolveHost: async () => ["10.0.0.5"],
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /refused address range for 10\.0\.0\.5/);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("re-checks addresses on every redirect hop (rebinding shape refused mid-chain)", async () => {
    // Hop 1 resolves PUBLIC and returns a SAME-HOST redirect; hop 2's fresh
    // DNS answer has flipped to loopback. The guard must refuse on the second
    // hop and NEVER fetch the redirected URL.
    const fetchImpl = async (url) => {
      fetchImpl.calls.push(url);
      return response({
        status: 302,
        headers: { location: "https://rebind.example/secret" },
      });
    };
    fetchImpl.calls = [];
    let lookups = 0;
    const resolveHost = async () => {
      lookups += 1;
      return lookups === 1 ? [PUBLIC_IP] : ["127.0.0.1"];
    };
    const res = await guard.downloadGuarded("https://rebind.example/start", {
      fetchImpl,
      resolveHost,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /refused address range for 127\.0\.0\.1/);
    assert.equal(lookups, 2, "the redirected hop re-ran DNS resolution");
    assert.deepEqual(
      fetchImpl.calls,
      ["https://rebind.example/start"],
      "the loopback hop must never be fetched"
    );
  });

  it("refuses cross-host redirects and enforces the ≤ 3 same-host budget", async () => {
    const offHost = await guard.downloadGuarded("https://cdn.example.test/x", {
      fetchImpl: async () =>
        response({ status: 302, headers: { location: "https://evil.example/x" } }),
      resolveHost: publicResolve,
    });
    assert.equal(offHost.ok, false);
    assert.match(offHost.reason, /redirect left the original host/);

    function chain(redirects) {
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls <= redirects) {
          return response({
            status: 301,
            headers: { location: `https://cdn.example.test/hop${calls}` },
          });
        }
        return response({ body: "final" });
      };
    }
    const threeHops = await guard.downloadGuarded("https://cdn.example.test/start", {
      fetchImpl: chain(3),
      resolveHost: publicResolve,
    });
    assert.equal(threeHops.ok, true);
    assert.equal(threeHops.bytes.toString(), "final");
    const fourHops = await guard.downloadGuarded("https://cdn.example.test/start", {
      fetchImpl: chain(4),
      resolveHost: publicResolve,
    });
    assert.equal(fourHops.ok, false);
    assert.match(fourHops.reason, /too many redirects/);
  });

  it("surfaces HTTP errors and missing redirect locations specifically", async () => {
    const nf = await guard.downloadGuarded("https://cdn.example.test/404", {
      fetchImpl: async () => response({ status: 404 }),
      resolveHost: publicResolve,
    });
    assert.equal(nf.ok, false);
    assert.equal(nf.reason, "HTTP 404");

    const noloc = await guard.downloadGuarded("https://cdn.example.test/301", {
      fetchImpl: async () => response({ status: 301 }),
      resolveHost: publicResolve,
    });
    assert.equal(noloc.ok, false);
    assert.match(noloc.reason, /redirect with no location \(HTTP 301\)/);
  });

  it("maps an aborted fetch to the named timeout reason (injected fake timer, no real clock)", async () => {
    // The guard's production timeout timer is UNREF'd on purpose. A test that
    // awaited the real timer would hinge on the runner's event-loop-ref
    // detection (Node 22: "Promise resolution is still pending but the event
    // loop has already resolved" + sibling cancellations; Node 24+: passes).
    // Drive the abort through the timer seams instead: zero real timers,
    // everything settles through microtasks the test itself orders.
    let fireTimeout;
    let cleared = false;
    let stubAttached;
    const attached = new Promise((r) => {
      stubAttached = r;
    });

    const download = guard.downloadGuarded("https://stall.example/x", {
      timeoutMs: 5, // never armed on a real clock — setTimer below replaces it
      setTimer: (fn) => {
        fireTimeout = fn;
        return {}; // fake handle; the guard must tolerate a no-unref handle
      },
      clearTimer: () => {
        cleared = true;
      },
      resolveHost: publicResolve,
      fetchImpl: (url, init) => {
        assert.ok(init?.signal, "guard must pass an AbortSignal");
        return new Promise((_resolve, reject) => {
          const abortError = () =>
            Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
          if (init.signal.aborted) {
            reject(abortError()); // already-aborted: settle NOW, never hangs
            return;
          }
          init.signal.addEventListener(
            "abort",
            () => reject(abortError()),
            { once: true }
          );
          stubAttached();
        });
      },
    });

    await attached; // the stub has attached its listener; the fake timer is captured
    assert.equal(cleared, false, "the fake timer stays armed while the request is in flight");
    fireTimeout(); // deterministic: fire the guard's own timeout callback NOW
    const res = await download;

    assert.equal(res.ok, false);
    assert.equal(res.reason, "download timed out");
    assert.equal(cleared, true, "the timer must be cleared once the request settles");
  });

  it("settles even when the timeout fires BEFORE the fetch stub starts (no hang)", async () => {
    // The timer seam fires at ARM time: the signal is already aborted when
    // the stub runs. A stub that only listens for the event would hang here;
    // checking signal.aborted settles it. (Guards the exact race the fake
    // timer can expose.)
    const res = await guard.downloadGuarded("https://early.example/x", {
      setTimer: (fn) => {
        fn();
        return {};
      },
      clearTimer: () => {},
      resolveHost: publicResolve,
      fetchImpl: (url, init) =>
        new Promise((_resolve, reject) => {
          const abortError = () =>
            Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
          if (init.signal.aborted) {
            reject(abortError());
            return;
          }
          init.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "download timed out");
  });

  it("enforces maxBytes via content-length BEFORE reading the body", async () => {
    let bodyRead = false;
    const res = await guard.downloadGuarded("https://big.example/test.bin", {
      maxBytes: 10,
      fetchImpl: async () => {
        const r = response({ status: 200, headers: { "content-length": "1000000" } });
        const orig = r.arrayBuffer;
        r.arrayBuffer = async () => {
          bodyRead = true;
          return orig();
        };
        return r;
      },
      resolveHost: publicResolve,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /file too large \(1000000 bytes\)/);
    assert.equal(bodyRead, false, "the oversized body must never be read");
  });

  it("caps actual bytes after the body read when content-length is absent", async () => {
    const res = await guard.downloadGuarded("https://sneaky.example/test.bin", {
      maxBytes: 4,
      fetchImpl: async () => response({ status: 200, body: "far too many bytes" }),
      resolveHost: publicResolve,
    });
    assert.equal(res.ok, false);
    assert.match(res.reason, /file too large \(\d+ bytes\)/);
  });

  it("downloads with the caller's headers, manual redirect and a signal; reports contentType", async () => {
    let seenInit;
    const res = await guard.downloadGuarded("https://cdn.example.test/photo.png", {
      headers: { "User-Agent": "UA/1.0" },
      fetchImpl: async (url, init) => {
        seenInit = init;
        return response({
          status: 200,
          headers: { "content-type": "image/png" },
          body: "pngbytes",
        });
      },
      resolveHost: publicResolve,
    });
    assert.equal(res.ok, true);
    assert.equal(res.bytes.toString(), "pngbytes");
    assert.equal(res.contentType, "image/png");
    assert.equal(seenInit.redirect, "manual", "redirects must be followed manually per hop");
    assert.ok(seenInit.signal);
    assert.deepEqual(seenInit.headers, { "User-Agent": "UA/1.0" });
  });
});

// ---------------------------------------------------------------------------
// #415 (BRG-9): the checked resolution and the connected socket are ONE
// lookup. The pins below lock the whole chain: checkHost hands out the
// validated addresses, downloadGuarded/readPage thread them to the
// transport, and pinnedCoreFetch connects to the IP with SNI/Host on the
// original name (fake core modules — still zero sockets).
// ---------------------------------------------------------------------------

describe("ssrfGuard DNS pin (#415/BRG-9)", () => {
  /** Minimal ok-200 fetch stub that records the addresses argument. */
  function recordingFetch() {
    const calls = [];
    const fn = async (url, init, addresses) => {
      calls.push({ url, init, addresses });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]),
      };
    };
    fn.calls = calls;
    return fn;
  }

  // --- checkHost: addresses leave WITH the verdict -------------------------

  it("checkHost returns the validated addresses alongside a clear verdict", async () => {
    const res = await guard.checkHost("cdn.example.test", async () => [
      PUBLIC_IP,
      "2606:4700:4700::1111",
    ]);
    assert.equal(res.refusal, null);
    assert.deepEqual(res.addresses, [PUBLIC_IP, "2606:4700:4700::1111"]);
  });

  it("checkHost: an IP literal carries NO pin (no lookup happens → nothing to rebind)", async () => {
    const res = await guard.checkHost(PUBLIC_IP, async () => {
      throw new Error("literal hosts must not hit the resolver");
    });
    assert.equal(res.refusal, null);
    assert.deepEqual(res.addresses, []);
  });

  it("checkHost: a refused answer hands out NOTHING to pin", async () => {
    const res = await guard.checkHost("evil.test", async () => ["169.254.169.254"]);
    assert.match(res.refusal, /refused address range/);
    assert.deepEqual(res.addresses, []);
  });

  it("hostRefusalReason stays the string wrapper (bridge/gork pre-checks)", async () => {
    assert.equal(await guard.hostRefusalReason("ok.example.test", publicResolve), null);
    assert.match(
      await guard.hostRefusalReason("evil.test", async () => ["10.0.0.1"]),
      /refused address range/,
    );
  });

  // --- downloadGuarded threads the pin per hop ------------------------------

  it("downloadGuarded hands the transport EXACTLY the addresses validated for the hop", async () => {
    const fetchImpl = recordingFetch();
    const res = await guard.downloadGuarded("https://cdn.example.test/a.png", {
      resolveHost: async () => [PUBLIC_IP],
      fetchImpl,
    });
    assert.equal(res.ok, true);
    assert.deepEqual(
      fetchImpl.calls[0].addresses,
      [PUBLIC_IP],
      "the JUST-CHECKED list rides to the socket — a rebinding window can no " +
        "longer open between the check and a second resolution",
    );
  });

  it("downloadGuarded: an IP-literal URL pins nothing ([] rides the transport)", async () => {
    const fetchImpl = recordingFetch();
    const res = await guard.downloadGuarded(`https://${PUBLIC_IP}/a.png`, {
      resolveHost: async () => {
        throw new Error("must not resolve a literal");
      },
      fetchImpl,
    });
    assert.equal(res.ok, true);
    assert.deepEqual(fetchImpl.calls[0].addresses, []);
  });

  it("a mid-chain record flip is PINNED per hop, not fetched blind", async () => {
    const seen = [];
    let resolverCalls = 0;
    const fetchImpl = async (url, init, addresses) => {
      seen.push(addresses);
      const first = seen.length === 1;
      return {
        ok: true,
        status: first ? 302 : 200,
        headers: { get: (n) => (first && n === "location" ? "/b.png" : null) },
        arrayBuffer: async () => new Uint8Array([7]),
      };
    };
    const res = await guard.downloadGuarded("https://cdn.example.test/a.png", {
      resolveHost: async () => (++resolverCalls === 1 ? [PUBLIC_IP] : ["8.8.8.8"]),
      fetchImpl,
    });
    assert.equal(res.ok, true, "the flipped answer still passes the CLASS check — and is now the pinned target");
    assert.equal(resolverCalls, 2, "the guard re-resolved on the redirect hop");
    // The second hop must ride the SECOND resolution — the old code handed
    // the socket nothing and undici re-resolved whatever the record said at
    // connect time (the rebinding window).
    assert.deepEqual(
      seen,
      [[PUBLIC_IP], ["8.8.8.8"]],
      "each hop rides ITS OWN validated list",
    );
  });

  // --- default transport routing --------------------------------------------

  it("defaultGuardedFetch: empty pin list (IP-literal hop) goes to globalThis.fetch", async () => {
    const real = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (u) => {
      calls.push(u);
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array() };
    };
    try {
      const res = await guard.defaultGuardedFetch(`https://${PUBLIC_IP}/a.png`, {}, []);
      assert.equal(res.ok, true);
      assert.equal(calls.length, 1, "no DNS for a literal → no pinning needed → global fetch is provably safe");
    } finally {
      globalThis.fetch = real;
    }
  });

  it("defaultGuardedFetch: name hops route THROUGH the pinned core fetch", async () => {
    const reqOpts = [];
    const real = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("global fetch must NOT run for a pinned name hop");
    };
    try {
      await guard.defaultGuardedFetch("https://cdn.example.test/a.png", {}, [PUBLIC_IP], {
        httpsImpl: fakeCoreTransport(reqOpts),
      });
      assert.equal(reqOpts.length, 1);
      assert.equal(reqOpts[0].host, PUBLIC_IP);
    } finally {
      globalThis.fetch = real;
    }
  });

  // --- pinnedCoreFetch: the socket IS the check ------------------------------

  /**
   * Fake node:https/http module: records request options, answers with a
   * scripted body, tracks destroy(). Zero sockets.
   * @param {object[]} reqOpts capture sink
   */
  function fakeCoreTransport(
    reqOpts,
    {
      chunks = [Buffer.from("ok")],
      status = 200,
      headers = {},
      onDestroy = null,
      error = null,
    } = {},
  ) {
    return {
      request(options, cb) {
        reqOpts.push(options);
        const req = {
          destroyed: false,
          on() {
            return this;
          },
          destroy() {
            req.destroyed = true;
            if (onDestroy) onDestroy();
          },
          end() {
            if (error != null) {
              Promise.resolve().then(() => req.emitError(error));
              return;
            }
            const coreRes = {
              statusCode: status,
              headers,
              [Symbol.asyncIterator]: async function* () {
                for (const c of chunks) yield c;
              },
            };
            Promise.resolve().then(() => cb(coreRes));
          },
          emitError(err) {
            if (errorListeners.length) for (const h of errorListeners) h(err);
          },
        };
        const errorListeners = [];
        req.on = (ev, h) => {
          if (ev === "error") errorListeners.push(h);
          return req;
        };
        return req;
      },
    };
  }

  it("pinnedCoreFetch: socket on the validated IP, SNI + Host on the ORIGINAL name", async () => {
    const reqOpts = [];
    const res = await guard.pinnedCoreFetch(
      "https://cdn.example.test:8443/img.png?v=2",
      { headers: { "user-agent": "bot/1", host: "attacker.evil.test" } },
      ["203.0.113.7"],
      { httpsImpl: fakeCoreTransport(reqOpts) },
    );
    const o = reqOpts[0];
    assert.equal(o.host, "203.0.113.7", "connect target is the CHECKED IP — the name never reaches the resolver");
    assert.equal(o.servername, "cdn.example.test", "TLS identity (SNI + cert verification) stays on the name");
    assert.equal(o.port, 8443);
    assert.equal(o.path, "/img.png?v=2");
    assert.equal(o.headers.host, "cdn.example.test:8443", "a caller/attacker Host header is REPLACED");
    assert.equal(o.headers["user-agent"], "bot/1", "other headers ride normally");
    assert.equal(o.lookup, undefined, "no resolver hook at all: the literal connects directly");
    assert.equal(res.ok, true);
    assert.equal(await res.text(), "ok");
  });

  it("pinnedCoreFetch: prefers a validated IPv4, accepts an all-v6 pin list", async () => {
    const reqOpts = [];
    await guard.pinnedCoreFetch("https://v6.test/", {}, ["2606:4700:4700::1111", PUBLIC_IP], {
      httpsImpl: fakeCoreTransport(reqOpts),
    });
    assert.equal(reqOpts[0].host, PUBLIC_IP);
    await guard.pinnedCoreFetch("https://v6.test/", {}, ["2606:4700:4700::1111"], {
      httpsImpl: fakeCoreTransport(reqOpts),
    });
    assert.equal(reqOpts[1].host, "2606:4700:4700::1111");
  });

  it("pinnedCoreFetch fails CLOSED: no validated address → no request, ever", async () => {
    const reqOpts = [];
    await assert.rejects(
      () => guard.pinnedCoreFetch("https://x.test/", {}, [], { httpsImpl: fakeCoreTransport(reqOpts) }),
      /no validated address/,
    );
    await assert.rejects(
      () => guard.pinnedCoreFetch("https://x.test/", {}, ["rebound.example"], { httpsImpl: fakeCoreTransport(reqOpts) }),
      /no validated address/,
      "an UNVALIDATED string in the pin list is rejected, not connected to",
    );
    assert.equal(reqOpts.length, 0);
  });

  it("pinnedCoreFetch: transport errors reject; a pre-aborted signal rejects without connecting", async () => {
    const ac = new AbortController();
    ac.abort();
    const reqOpts = [];
    await assert.rejects(
      () => guard.pinnedCoreFetch("https://x.test/", { signal: ac.signal }, ["1.2.3.4"], {
        httpsImpl: fakeCoreTransport(reqOpts),
      }),
      /abort/i,
    );
    assert.equal(reqOpts.length, 0, "aborted BEFORE the request was made");

    const badOpts = [];
    await assert.rejects(
      () =>
        guard.pinnedCoreFetch("https://x.test/", {}, ["1.2.3.4"], {
          httpsImpl: fakeCoreTransport(badOpts, { error: new Error("ECONNREFUSED 1.2.3.4:443") }),
        }),
      /ECONNREFUSED/,
      "a transport failure REJECTS with the cause — the guard reports it",
    );
  });

  it("the response adapter: joined headers, buffered bytes, reader.cancel DESTROYS the request", async () => {
    const reqOpts = [];
    let sawDestroy = null;
    const res = await guard.pinnedCoreFetch("https://x.test/a", {}, ["1.2.3.4"], {
      httpsImpl: fakeCoreTransport(reqOpts, {
        chunks: [Buffer.from("ab"), Buffer.from("cd")],
        status: 200,
        headers: { "content-type": ["text/plain", "x/y"] },
        onDestroy: () => (sawDestroy = true),
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain, x/y");
    assert.equal(res.headers.get("missing"), null);
    const buf = await res.arrayBuffer();
    assert.deepEqual(Buffer.from(buf).toString(), "abcd");

    // Second call: drive the reader to done, then cancel — cancel must
    // destroy (readPage's byte budget depends on stopping the transfer).
    const res2 = await guard.pinnedCoreFetch("https://x.test/b", {}, ["1.2.3.4"], {
      httpsImpl: fakeCoreTransport(reqOpts, {
        chunks: [Buffer.from("zz")],
        onDestroy: () => (sawDestroy = true),
      }),
    });
    const reader = res2.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(first.value.toString(), "zz");
    const second = await reader.read();
    assert.equal(second.done, true);
    await reader.cancel();
    assert.equal(sawDestroy, true, "cancel tears the socket down — no silent buffering beyond the cap");
  });
});

// ---------------------------------------------------------------------------
// #414 (BRG-8/LT-7): the timeout covers the BODY too, and maxBytes is
// enforced WHILE streaming — never "buffer everything, then check".
// ---------------------------------------------------------------------------

describe("ssrfGuard body-phase timeout + streamed cap (#414)", () => {
  /** Fake timer seam: arm captures the abort cb; clears are recorded. */
  function fakeTimers() {
    const armed = [];
    const cleared = [];
    return {
      armed,
      cleared,
      setTimer: (fn) => {
        armed.push(fn);
        return { id: armed.length };
      },
      clearTimer: (handle) => cleared.push(handle),
      /** Fire the live timer the way the real one would. */
      fire: () => armed.forEach((fn) => fn()),
    };
  }

  /** Response whose body streams scripted chunks with observability. */
  function streamingRes(chunks, { signal = null } = {}) {
    const state = { reads: 0, cancelled: 0 };
    let i = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null }, // chunked: NO content-length
      body: {
        getReader() {
          return {
            read: async () => {
              state.reads += 1;
              if (signal) {
                // A slow-drip host: this read only finishes if someone
                // aborts — the real transport rejects the stream then.
                await new Promise((resolve, reject) => {
                  if (signal.aborted) return reject(new Error("This operation was aborted"));
                  signal.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
                  if (!signal) resolve();
                });
              }
              if (i >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: chunks[i++] };
            },
            cancel: async () => {
              state.cancelled += 1;
            },
          };
        },
      },
      // Buffered fallback the OLD code path used — kept so a regression to
      // "buffer everything" still completes the download (and reads all).
      arrayBuffer: async () => {
        const all = Buffer.concat(chunks);
        state.reads = chunks.length;
        return all;
      },
      state,
    };
  }

  it("the timer STAYS ARMED through the body read (cleared only after)", async () => {
    const t = fakeTimers();
    const res = streamingRes([Buffer.from("hello")]);
    const out = await guard.downloadGuarded("https://slow.test/a.png", {
      resolveHost: publicResolve,
      fetchImpl: async () => res,
      maxBytes: 1 << 20,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    assert.equal(out.ok, true);
    assert.equal(t.armed.length, 1, "one timer per hop");
    assert.equal(t.cleared.length, 1, "cleared exactly once, AFTER the body settled");
  });

  it("a slow-drip body that outlives the timeout is a TIMEOUT, not a hang", async () => {
    const t = fakeTimers();
    let capturedSignal = null;
    let reads = 0;
    const res = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          return {
            read: async () => {
              reads += 1;
              if (reads === 1) return { done: false, value: Buffer.from("first") };
              // the drip stops here — only the abort timer ends this read
              return await new Promise((_resolve, reject) => {
                capturedSignal.addEventListener("abort", () =>
                  reject(new Error("This operation was aborted")),
                );
              });
            },
            cancel: async () => {},
          };
        },
      },
      // the pre-#414 buffered path — if a regression buffers instead of
      // streaming, this throws and the failure reason says so.
      arrayBuffer: async () => {
        throw new Error("buffered read of a drip body (timer would be cleared!)");
      },
    };
    const pending = guard.downloadGuarded("https://drip.test/a.png", {
      resolveHost: publicResolve,
      fetchImpl: async (_u, init) => {
        capturedSignal = init.signal;
        return res;
      },
      maxBytes: 1 << 20,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(t.cleared.length, 0, "the timer is STILL ARMED while the body is mid-read");
    t.fire(); // the per-attempt timeout expiring — NOW it still has teeth
    const out = await pending;
    assert.equal(out.ok, false);
    assert.equal(
      out.reason,
      "download timed out",
      "a stalled BODY is the same named failure as a stalled header phase",
    );
  });

  it("over-cap chunked bodies are stopped AT the cap and CANCELLED — never buffered whole", async () => {
    const chunk = Buffer.alloc(1024, 7);
    const res = streamingRes(Array.from({ length: 20 }, () => chunk), {});
    const out = await guard.downloadGuarded("https://giant.test/a.bin", {
      resolveHost: publicResolve,
      fetchImpl: async () => res,
      maxBytes: 4096,
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, "file too large (5120 bytes)",
      "refuses the moment the STREAM crosses the cap (5×1KiB > 4096) — the old code buffered all 20 KiB and named THAT size");
    assert.ok(res.state.reads <= 6, `reads stopped at the cap, saw ${res.state.reads}`);
    assert.equal(res.state.cancelled >= 1, true, "the transfer is cancelled, not abandoned open");
  });

  it("within-cap streamed bodies land whole", async () => {
    const res = streamingRes([Buffer.from("ab"), Buffer.from("cd")], {});
    const out = await guard.downloadGuarded("https://fine.test/a.bin", {
      resolveHost: publicResolve,
      fetchImpl: async () => res,
      maxBytes: 4096,
    });
    assert.equal(out.ok, true);
    assert.equal(out.bytes.toString(), "abcd");
  });

  it("the declared content-length pre-check still refuses BEFORE reading", async () => {
    let touched = false;
    const out = await guard.downloadGuarded("https://liar.test/a.png", {
      resolveHost: publicResolve,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: (n) => (n === "content-length" ? "999999" : null) },
        body: { getReader: () => { touched = true; throw new Error("unread"); } },
        arrayBuffer: async () => { touched = true; return new Uint8Array(); },
      }),
      maxBytes: 4096,
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /file too large \(999999 bytes\)/);
    assert.equal(touched, false, "the body must not be touched for a lying declared size");
  });
});
