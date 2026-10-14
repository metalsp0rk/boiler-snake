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
