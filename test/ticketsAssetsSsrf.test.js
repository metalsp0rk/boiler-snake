/**
 * Ticket-archive asset SSRF tests (audit C5 / issue #188).
 *
 * downloadUrlToFile previously fetched ANY http(s) URL found in
 * member-authored ticket content (redirect: "follow", no private-IP guard, no
 * timeout) and the bytes were then served to browsers at
 * /t/{token}/assets/… — an internal-network read primitive. It now runs
 * through the shared guard (src/core/ssrfGuard.js) and every refusal is
 * recorded as a specific warning on the mirror result (AGENTS.md partial
 * failures), never a silent drop.
 *
 * No sockets anywhere: a tripwire on globalThis.fetch proves refused URLs
 * never leave the process (literal IPs are refused BEFORE DNS), and the
 * resolveHost seam simulates names that resolve to internal ranges.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadDb, communityKey } = require("./helpers/env");

// CONTRACT: loadDb() before every src/ require (fresh temp DB, cache reset).
const { api: db, tmpDir, cleanup } = loadDb();

const assets = require("../src/features/tickets/assets");

after(() => cleanup?.());

const PUBLIC_IP = "93.184.216.34"; // public example address (no traffic)
const publicResolve = async () => [PUBLIC_IP];

function tripwireFetch() {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    throw new Error(`TRIPOWIRE: fetch attempted for ${url}`);
  };
  fn.calls = calls;
  return fn;
}

describe("ticket asset downloads are SSRF-guarded (C5)", () => {
  let tmpDirUsed;
  before(() => {
    tmpDirUsed = tmpDir;
    process.env.DATA_DIR = tmpDir;
  });

  it("downloadUrlToFile refuses the cloud-metadata literal; fetch is never called", async () => {
    const dest = path.join(tmpDirUsed, "never", "meta.txt");
    let dnsTouched = false;
    await assert.rejects(
      () =>
        assets.downloadUrlToFile("https://169.254.169.254/latest/meta-data/", dest, {
          fetchImpl: tripwireFetch(),
          resolveHost: async () => {
            dnsTouched = true;
            return [PUBLIC_IP];
          },
        }),
      (err) => {
        assert.match(
          err.message,
          /refused address range for 169\.254\.169\.254 for https:\/\/169\.254\.169\.254/
        );
        return true;
      }
    );
    assert.equal(dnsTouched, false, "the literal must be refused without DNS");
    assert.equal(fs.existsSync(dest), false, "no bytes on disk");
  });

  it("downloadUrlToFile refuses plain http (the guard is https-only)", async () => {
    const fetchImpl = tripwireFetch();
    await assert.rejects(
      () =>
        assets.downloadUrlToFile("http://169.254.169.254/latest/meta-data/", path.join(tmpDirUsed, "x"), {
          fetchImpl,
          resolveHost: publicResolve,
        }),
      /non-https url \(http:\)/
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("downloadUrlToFile refuses a name resolving to loopback (rebinding shape)", async () => {
    const fetchImpl = tripwireFetch();
    await assert.rejects(
      () =>
        assets.downloadUrlToFile("https://evil.example/secret.png", path.join(tmpDirUsed, "y"), {
          fetchImpl,
          resolveHost: async () => ["127.0.0.1"],
        }),
      /refused address range for 127\.0\.0\.1/
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  it("downloadUrlToFile streams through a public host with the CDN User-Agent", async () => {
    const dest = path.join(tmpDirUsed, "ok", "photo.png");
    let seenInit;
    const { bytes, contentType } = await assets.downloadUrlToFile(
      "https://cdn.example/attachments/1/photo.png",
      dest,
      {
        resolveHost: publicResolve,
        fetchImpl: async (url, init) => {
          seenInit = init;
          const png = Buffer.from("fake-png-bytes", "utf8");
          return {
            ok: true,
            status: 200,
            headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "image/png" : null) },
            arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
          };
        },
      }
    );
    assert.equal(bytes, 14);
    assert.equal(contentType, "image/png");
    assert.equal(seenInit.headers["User-Agent"], "BoilerSnake-TicketArchive/1.0");
    assert.equal(fs.readFileSync(dest).toString(), "fake-png-bytes");
  });

  it("mirrorTicketAssets refuses a metadata URL, records the warning, and keeps archiving", async () => {
    const token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    // Tripwire ANY ambient fetch: the archive step must not touch the network
    // for the refused URL even with default (unstubbed) resolution, because
    // 169.254.169.254 is a refused literal.
    const origFetch = globalThis.fetch;
    const tripwire = tripwireFetch();
    globalThis.fetch = tripwire;
    try {
      const result = await assets.mirrorTicketAssets(
        [
          {
            message_id: "1",
            author_id: "u",
            content: "look at this",
            attachment_urls: [
              {
                url: "https://169.254.169.254/latest/meta-data/iam/security-credentials/",
                name: "creds.json",
                contentType: "application/json",
              },
            ],
          },
        ],
        { communityId: communityKey("g-ssrf"), token }
      );

      assert.equal(result.downloaded, 0);
      assert.equal(result.failed, 1);
      assert.equal(tripwire.calls.length, 0, "the metadata URL must never leave the process");

      const warning = result.warnings.find((w) => w.includes("Media not archived"));
      assert.ok(warning, `expected a specific per-file warning, got: ${JSON.stringify(result.warnings)}`);
      assert.match(warning, /169\.254\.169\.254\/latest\/meta-data/);
      assert.match(warning, /refused address range for 169\.254\.169\.254/);

      // The archive still succeeds: the attachment is kept as a remote ref,
      // explicitly NOT local, with the source URL preserved.
      const att = result.messages[0].attachment_urls[0];
      assert.equal(att.local, false);
      assert.equal(att.url, "https://169.254.169.254/latest/meta-data/iam/security-credentials/");
      // Nothing was written for the refused asset.
      const assetFiles = fs.readdirSync(result.assetsDir);
      assert.deepEqual(assetFiles, []);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("mirrorTicketAssets refuses DNS-rebound hosts and mixes successes with warnings", async () => {
    const token = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const png = Buffer.from("png-bytes", "utf8");
    const result = await assets.mirrorTicketAssets(
      [
        {
          message_id: "1",
          author_id: "u",
          content: "one good, one evil",
          attachment_urls: [
            { url: "https://cdn.example/ok.png", name: "ok.png", contentType: "image/png" },
            { url: "https://evil.example/rebind.png", name: "rebind.png", contentType: "image/png" },
          ],
        },
      ],
      {
        communityId: communityKey("g-ssrf2"),
        token,
        resolveHost: async (host) => (host === "evil.example" ? ["10.0.0.5"] : [PUBLIC_IP]),
        fetchImpl: async (url) => {
          if (!String(url).includes("cdn.example")) {
            throw new Error(`TRIPOWIRE: unexpected fetch for ${url}`);
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            arrayBuffer: async () =>
              png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
          };
        },
      }
    );
    assert.equal(result.downloaded, 1);
    assert.equal(result.failed, 1);
    const warning = result.warnings.find((w) => w.includes("rebind.png"));
    assert.ok(warning && warning.includes("refused address range for 10.0.0.5"));
    const atts = result.messages[0].attachment_urls;
    assert.equal(atts[0].local, true);
    assert.equal(atts[1].local, false);
    assert.deepEqual(fs.readdirSync(result.assetsDir), ["001_ok.png"]);
  });

  it("enforces the per-file byte cap through the guard", async () => {
    const dest = path.join(tmpDirUsed, "cap", "big.bin");
    await assert.rejects(
      () =>
        assets.downloadUrlToFile("https://big.example/big.bin", dest, {
          resolveHost: publicResolve,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: (h) => (String(h).toLowerCase() === "content-length" ? "99999999999" : null) },
            arrayBuffer: async () => {
              throw new Error("body must not be read once content-length exceeds the cap");
            },
          }),
        }),
      /file too large \(99999999999 bytes\) for https:\/\/big\.example\/big\.bin/
    );
    assert.equal(fs.existsSync(dest), false);
  });
});
