/**
 * Unit tests for gork vision (issue #227) — src/features/gork/images.js.
 *
 * Pure/DI only — no database, no network: canvas-built PNG buffers for the
 * resize core, fetch/dns seams for the download posture. Covers: the
 * locked 1280-box math (aspect kept, never upscale, already-small
 * passthrough), buffer-in/buffer-out downscaling, attachment filtering,
 * candidate collection order/dedupe, and the per-attachment degradation
 * contract (logged + noted, never a throw).
 */
const { describe, it, after, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createCanvas, loadImage } = require("@napi-rs/canvas");

const im = require("../src/features/gork/images");

// ---------- helpers ----------

const VISION_ENV_KEYS = [
  "GORK_VISION_MAX_IMAGES",
  "GORK_VISION_MAX_IMAGE_BYTES",
  "GORK_VISION_MAX_TOTAL_BYTES",
  "GORK_VISION_DOWNLOAD_TIMEOUT_MS",
];

function clearVisionEnv() {
  for (const key of VISION_ENV_KEYS) delete process.env[key];
}

/** Real decodable PNG of the requested size (deterministic paint). */
function makePng(width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(9,120,201)";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgb(220,40,40)";
  ctx.fillRect(
    0,
    0,
    Math.max(1, Math.floor(width / 3)),
    Math.max(1, Math.floor(height / 3)),
  );
  return canvas.toBuffer("image/png");
}

/** fetch seam: every URL returns the same bytes/behavior. */
function fetchReturning(bytesOrThunk) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const value =
      typeof bytesOrThunk === "function" ? bytesOrThunk(String(url)) : bytesOrThunk;
    if (value instanceof Error) throw value;
    if (value === null) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => value,
    };
  };
  return { impl, calls };
}

/** resolveHost seam: always a public address (SSRF checks pass). */
const publicResolver = async () => ["93.184.216.34"];

beforeEach(clearVisionEnv);
afterEach(clearVisionEnv);

// ---------- resize math (locked 1280-box rule) ----------

describe("resolveTargetSize (issue #227 hard requirement)", () => {
  it("downscales landscape to the box: 4032×3024 → 1280×960", () => {
    assert.deepEqual(im.resolveTargetSize(4032, 3024), { width: 1280, height: 960 });
  });

  it("downscales portrait keeping aspect: 3024×4032 → 960×1280", () => {
    assert.deepEqual(im.resolveTargetSize(3024, 4032), { width: 960, height: 1280 });
  });

  it("downscales square: 2000×2000 → 1280×1280", () => {
    assert.deepEqual(im.resolveTargetSize(2000, 2000), { width: 1280, height: 1280 });
  });

  it("keeps extreme aspect ratios (2560×100 → 1280×50)", () => {
    assert.deepEqual(im.resolveTargetSize(2560, 100), { width: 1280, height: 50 });
  });

  it("never upscales: images already inside the box return null", () => {
    assert.equal(im.resolveTargetSize(800, 600), null);
    assert.equal(im.resolveTargetSize(1, 1), null);
  });

  it("the box edge itself is inside the box (1280×1280 → null)", () => {
    assert.equal(im.resolveTargetSize(1280, 1280), null);
    assert.equal(im.resolveTargetSize(1281, 1280).width, 1280);
  });

  it("fractional pixels round DOWN with a floor of 1", () => {
    // 4000×3 → scale 0.32 → 1280×0.96 → floor 0 → clamped to 1
    assert.deepEqual(im.resolveTargetSize(4000, 3), { width: 1280, height: 1 });
  });

  it("garbage dimensions return null (no resize, never NaN)", () => {
    assert.equal(im.resolveTargetSize(0, 100), null);
    assert.equal(im.resolveTargetSize(NaN, 100), null);
    assert.equal(im.resolveTargetSize("x", "y"), null);
  });

  it("custom max edge scales the same rule", () => {
    assert.deepEqual(im.resolveTargetSize(2000, 1000, 100), { width: 100, height: 50 });
  });
});

// ---------- resize core (buffer-in / buffer-out) ----------

describe("downscaleImageBuffer", () => {
  it("resizes an oversized PNG to exactly the box (1600×1200 → 1280×960)", async () => {
    const src = makePng(1600, 1200);
    const out = await im.downscaleImageBuffer(src, { mediaType: "image/jpeg" });
    assert.equal(out.resized, true);
    assert.equal(out.width, 1280);
    assert.equal(out.height, 960);
    const decoded = await loadImage(out.buffer);
    assert.equal(decoded.width, 1280);
    assert.equal(decoded.height, 960);
    // JPEG magic bytes
    assert.equal(out.buffer[0], 0xff);
    assert.equal(out.buffer[1], 0xd8);
  });

  it("sends already-small images through BYTE-IDENTICAL (no re-encode)", async () => {
    const src = makePng(800, 600);
    const out = await im.downscaleImageBuffer(src, { mediaType: "image/jpeg" });
    assert.equal(out.resized, false);
    assert.ok(out.buffer.equals(src), "original bytes untouched");
    assert.equal(out.width, 800);
    assert.equal(out.height, 600);
  });

  it("keeps PNG output when asked (screenshot path)", async () => {
    const src = makePng(1600, 1200);
    const out = await im.downscaleImageBuffer(src, { mediaType: "image/png" });
    assert.equal(out.mediaType, "image/png");
    // PNG magic
    assert.equal(out.buffer.subarray(1, 4).toString(), "PNG");
    const decoded = await loadImage(out.buffer);
    assert.equal(decoded.width, 1280);
  });

  it("honors a custom maxDimension", async () => {
    const src = makePng(800, 600);
    const out = await im.downscaleImageBuffer(src, {
      maxDimension: 200,
      mediaType: "image/jpeg",
    });
    assert.equal(out.width, 200);
    assert.equal(out.height, 150);
  });

  it("rejects on non-image bytes (caller degrades per-attachment)", async () => {
    await assert.rejects(() =>
      im.downscaleImageBuffer(Buffer.from("this is definitely not a png")),
    );
  });
});

// ---------- attachment filtering ----------

describe("isImageAttachment / messageHasImage", () => {
  it("accepts the allow-listed content types", () => {
    for (const contentType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      assert.equal(
        im.isImageAttachment({ name: "a", url: "https://x/a", contentType }),
        true,
        contentType,
      );
    }
  });

  it("refuses non-allowlisted content types (svg, tiff, video…)", () => {
    for (const contentType of [
      "image/svg+xml",
      "image/tiff",
      "video/mp4",
      "application/pdf",
      "text/plain",
    ]) {
      assert.equal(
        im.isImageAttachment({ name: "a", url: "https://x/a", contentType }),
        false,
        contentType,
      );
    }
  });

  it("an explicit content-type decides ALONE (a video named .gif is refused)", () => {
    assert.equal(
      im.isImageAttachment({ name: "lie.gif", url: "https://x", contentType: "video/mp4" }),
      false,
    );
  });

  it("content-type-less (Fluxer) attachments fall back to the extension", () => {
    assert.equal(im.isImageAttachment({ name: "shot.PNG", url: "https://x" }), true);
    assert.equal(im.isImageAttachment({ name: "photo.jpg", url: "https://x" }), true);
    assert.equal(im.isImageAttachment({ name: "clip.mp4", url: "https://x" }), false);
    assert.equal(im.isImageAttachment({ name: "notes", url: "https://x" }), false);
  });

  it("messageHasImage is duck-safe over Collection/Map/array/missing", () => {
    const att = { name: "a.png", url: "https://x/a.png" };
    assert.equal(im.messageHasImage({ attachments: [att] }), true);
    assert.equal(im.messageHasImage({ attachments: new Map([["1", att]]) }), true);
    assert.equal(
      im.messageHasImage({ attachments: { values: () => [att][Symbol.iterator]() } }),
      true,
    );
    assert.equal(im.messageHasImage({ attachments: [] }), false);
    assert.equal(im.messageHasImage({}), false);
    assert.equal(im.messageHasImage(null), false);
  });

  it("iterAttachments normalizes array/Collection/Map/generic-iterable/garbage", () => {
    const a = { name: "a" };
    assert.deepEqual(im.iterAttachments([a]), [a]);
    assert.deepEqual(im.iterAttachments(new Map([["1", a]])), [a]);
    assert.deepEqual(im.iterAttachments({ values: () => [a][Symbol.iterator]() }), [a]);
    assert.deepEqual(
      im.iterAttachments({ [Symbol.iterator]: function* () { yield a; } }),
      [a],
    );
    assert.deepEqual(im.iterAttachments({ not: "iterable" }), []);
    assert.deepEqual(im.iterAttachments(undefined), []);
    assert.deepEqual(im.iterAttachments(0), []);
  });
});

describe("collectImageCandidates", () => {
  it("trigger images come FIRST, then context images, non-images dropped, urls deduped", () => {
    const cands = im.collectImageCandidates(
      {
        attachments: [
          { name: "t2.png", url: "https://x/t2", contentType: "image/png" },
          { name: "clip.mp4", url: "https://x/tc", contentType: "video/mp4" },
          { name: "t1.png", url: "https://x/t1", contentType: "image/png" },
        ],
      },
      [
        { attachments: [{ name: "c1.jpg", url: "https://x/c1", contentType: "image/jpeg" }] },
        { attachments: [{ name: "dup.png", url: "https://x/t1", contentType: "image/png" }] },
        { attachments: undefined },
      ],
    );
    assert.deepEqual(
      cands.map((c) => `${c.name}@${c.origin}`),
      ["t2.png@trigger", "t1.png@trigger", "c1.jpg@context"],
    );
  });

  it("keeps the declared size for the oversize pre-check (null when absent)", () => {
    const cands = im.collectImageCandidates({
      attachments: [
        { name: "a.png", url: "https://x/a", contentType: "image/png", size: "1234" },
        { name: "b.png", url: "https://x/b", contentType: "image/png" },
      ],
    });
    assert.equal(cands[0].size, 1234);
    assert.equal(cands[1].size, null);
  });

  it("#683: stamps the owning message's author on every candidate (duck-safe)", () => {
    const cands = im.collectImageCandidates(
      {
        author: { id: "u1", username: "alice" },
        attachments: [{ name: "t.png", url: "https://x/t", contentType: "image/png" }],
      },
      [
        {
          author: { id: 7, username: "  bob  " },
          attachments: [{ name: "c.jpg", url: "https://x/c", contentType: "image/jpeg" }],
        },
        {
          // Fluxer-shape duck: author present but username is null →
          // senderName degrades to null, the id still stamps.
          author: { id: "9", username: null },
          attachments: [{ name: "f.png", url: "https://x/f" }],
        },
        { attachments: [{ name: "n.png", url: "https://x/n" }] },
      ],
    );
    assert.deepEqual(
      cands.map((c) => [c.senderId, c.senderName]),
      [
        ["u1", "alice"],
        ["7", "bob"],
        ["9", null],
        [null, null],
      ],
    );
  });
});

// ---------- orchestration ----------

describe("prepareVisionImages (data URLs + degradation)", () => {
  const ids = { guildId: "g1", userId: "u1", messageId: "m1" };

  it("builds [label, image_url] part pairs in candidate order (#683)", async () => {
    const png = makePng(800, 600); // small → passthrough → source type names it
    const { impl } = fetchReturning(png);
    const out = await im.prepareVisionImages(
      [
        { url: "https://x/a.png", name: "a.png", contentType: "image/png", size: png.length, origin: "trigger" },
        { url: "https://x/b.jpg", name: "b.jpg", contentType: "image/jpeg", size: png.length, origin: "trigger" },
      ],
      { fetchImpl: impl, resolveHost: publicResolver, ids },
    );
    assert.equal(out.sent, 2);
    assert.equal(out.skipped, 0);
    assert.deepEqual(out.notes, []);
    // #683: no senderLabel known → each image still carries an ordinal
    // caption (never silently anonymous), adjacent and BEFORE its part.
    assert.deepEqual(
      out.parts.map((p) => p.type),
      ["text", "image_url", "text", "image_url"],
    );
    assert.equal(out.parts[0].text, "[Image 1 of 2]");
    assert.equal(out.parts[2].text, "[Image 2 of 2]");
    assert.ok(out.parts[1].image_url.url.startsWith("data:image/png;base64,"));
    assert.ok(out.parts[3].image_url.url.startsWith("data:image/jpeg;base64,"));
    // The base64 payload round-trips to the original (passthrough) bytes.
    const b64 = out.parts[1].image_url.url.split("base64,")[1];
    assert.ok(Buffer.from(b64, "base64").equals(png));
  });

  it("#683: a resolved senderLabel rides as an adjacent attribution caption", async () => {
    const png = makePng(64, 64);
    const { impl } = fetchReturning(png);
    const out = await im.prepareVisionImages(
      [
        { url: "https://x/a.png", name: "a.png", contentType: "image/png", size: png.length, origin: "trigger", senderLabel: "Main Guy (@member)" },
        { url: "https://x/b.png", name: "b.png", contentType: "image/png", size: png.length, origin: "context", senderLabel: "Two (@member2)" },
      ],
      { fetchImpl: impl, resolveHost: publicResolver, ids },
    );
    assert.equal(out.sent, 2);
    assert.equal(out.parts[0].text, "[Image 1 of 2 — uploaded by Main Guy (@member)]");
    assert.equal(out.parts[2].text, "[Image 2 of 2 — uploaded by Two (@member2)]");
    assert.equal(out.parts[1].type, "image_url");
    assert.equal(out.parts[3].type, "image_url");
  });

  it("#683: 'of N' numbering survives budget-walk skips (N = images that ride)", async () => {
    const png = makePng(300, 200);
    const { impl } = fetchReturning(png);
    const cands = [1, 2, 3].map((n) => ({
      url: `https://x/${n}.png`,
      name: `${n}.png`,
      contentType: "image/png",
      size: png.length,
      origin: "trigger",
      senderLabel: `user${n}`,
    }));
    const out = await im.prepareVisionImages(cands, {
      fetchImpl: impl,
      resolveHost: publicResolver,
      ids,
      limits: { maxTotalBytes: png.length * 2 }, // third image loses the walk
    });
    assert.equal(out.sent, 2);
    assert.equal(out.skipped, 1);
    const labels = out.parts.filter((p) => p.type === "text").map((p) => p.text);
    assert.deepEqual(labels, [
      "[Image 1 of 2 — uploaded by user1]",
      "[Image 2 of 2 — uploaded by user2]",
    ]);
  });

  it("#683: failure notes name the uploader when any identity is known", async () => {
    const { impl } = fetchReturning(null); // 404 → every download fails
    const out = await im.prepareVisionImages(
      [{ url: "https://x/cat.png", name: "cat.png", contentType: "image/png", size: null, origin: "trigger", senderName: "alice" }],
      { fetchImpl: impl, resolveHost: publicResolver, ids },
    );
    assert.equal(out.sent, 0);
    assert.match(out.notes[0], /^image "cat\.png" from alice could not be included: /);
  });

  it("resizes oversized images BEFORE encoding the data URL (1600×1200 → 1280×960)", async () => {
    const png = makePng(1600, 1200);
    const { impl } = fetchReturning(png);
    const out = await im.prepareVisionImages(
      [{ url: "https://x/big.png", name: "big.png", contentType: "image/png", size: png.length, origin: "trigger" }],
      { fetchImpl: impl, resolveHost: publicResolver, ids },
    );
    assert.equal(out.sent, 1);
    const b64 = out.parts[1].image_url.url.split("base64,")[1];
    const decoded = await loadImage(Buffer.from(b64, "base64"));
    assert.equal(decoded.width, 1280);
    assert.equal(decoded.height, 960);
    // A real resize re-encodes to the output mime (png source → png).
    assert.ok(out.parts[1].image_url.url.startsWith("data:image/png;base64,"));
  });

  it("skips oversize attachments BEFORE downloading (declared size)", async () => {
    const { impl, calls } = fetchReturning(makePng(100, 100));
    const out = await im.prepareVisionImages(
      [{ url: "https://x/huge.png", name: "huge.png", contentType: "image/png", size: 99_000_000, origin: "trigger" }],
      {
        fetchImpl: impl,
        resolveHost: publicResolver,
        ids,
        limits: { maxImageBytes: 1024 },
      },
    );
    assert.equal(calls.length, 0, "no fetch for a declared-oversize file");
    assert.equal(out.sent, 0);
    assert.match(out.notes[0], /declared size 99000000 exceeds/);
  });

  it("caps the ACTUAL downloaded bytes (lying declared size)", async () => {
    const png = makePng(400, 300);
    const { impl } = fetchReturning(png);
    const out = await im.prepareVisionImages(
      [{ url: "https://x/liar.png", name: "liar.png", contentType: "image/png", size: 1, origin: "trigger" }],
      { fetchImpl: impl, resolveHost: publicResolver, ids, limits: { maxImageBytes: 64 } },
    );
    assert.equal(out.sent, 0);
    assert.match(out.notes[0], /downloaded bytes exceed the 64-byte cap/);
  });

  it("applies the per-request image count cap with a note", async () => {
    const png = makePng(50, 50);
    const { impl } = fetchReturning(png);
    const cands = [1, 2, 3].map((n) => ({
      url: `https://x/${n}.png`,
      name: `${n}.png`,
      contentType: "image/png",
      size: png.length,
      origin: "trigger",
    }));
    const out = await im.prepareVisionImages(cands, {
      fetchImpl: impl,
      resolveHost: publicResolver,
      ids,
      limits: { maxImages: 2 },
    });
    assert.equal(out.sent, 2);
    assert.match(out.notes.join(" "), /1 more image attachment\(s\) were not included \(cap: 2 per request\)/);
    assert.equal(out.skipped, 1);
  });

  it("applies the TOTAL bytes budget deterministically in candidate order", async () => {
    const png = makePng(300, 200);
    const { impl } = fetchReturning(png);
    const cands = [1, 2].map((n) => ({
      url: `https://x/${n}.png`,
      name: `${n}.png`,
      contentType: "image/png",
      size: png.length,
      origin: "trigger",
    }));
    const out = await im.prepareVisionImages(cands, {
      fetchImpl: impl,
      resolveHost: publicResolver,
      ids,
      limits: { maxTotalBytes: png.length }, // exactly one image fits
    });
    assert.equal(out.sent, 1, "first candidate wins the budget, second is dropped");
    assert.equal(out.skipped, 1);
  });

  it("GORK_VISION_MAX_IMAGES=0 disables vision entirely", async () => {
    process.env.GORK_VISION_MAX_IMAGES = "0";
    const { impl, calls } = fetchReturning(makePng(50, 50));
    const out = await im.prepareVisionImages(
      [{ url: "https://x/a.png", name: "a.png", contentType: "image/png", size: null, origin: "trigger" }],
      { fetchImpl: impl, resolveHost: publicResolver, ids },
    );
    assert.equal(calls.length, 0);
    assert.equal(out.sent, 0);
    assert.equal(out.parts.length, 0);
  });

  it("degrades per-attachment: failed download → logged + noted, NEVER throws", async () => {
    const boom = new Error("boom");
    const { impl } = fetchReturning(boom);
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.map(String).join(" "));
    try {
      const out = await im.prepareVisionImages(
        [{ url: "https://x/x.png", name: "x.png", contentType: "image/png", size: null, origin: "trigger" }],
        { fetchImpl: impl, resolveHost: publicResolver, ids },
      );
      assert.equal(out.sent, 0);
      assert.equal(out.skipped, 1);
      assert.match(out.notes[0], /x\.png.*fetch failed: boom/);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /\[gork\] vision image skipped guild=g1 user=u1 msg=m1/);
      assert.match(errors[0], /x\.png \[trigger\]/);
    } finally {
      console.error = original;
    }
  });

  it("undecodable bytes degrade to a logged note (content-type lied)", async () => {
    const { impl } = fetchReturning(Buffer.from("not an image at all"));
    const original = console.error;
    console.error = () => {};
    try {
      const out = await im.prepareVisionImages(
        [{ url: "https://x/fake.png", name: "fake.png", contentType: "image/png", size: 5, origin: "context" }],
        { fetchImpl: impl, resolveHost: publicResolver, ids },
      );
      assert.equal(out.sent, 0);
      assert.match(out.notes[0], /decode\/resize failed/);
    } finally {
      console.error = original;
    }
  });

  it("enforces the download security posture: https only + private hosts refused BEFORE fetch", async () => {
    let fetched = 0;
    const impl = async () => {
      fetched += 1;
      return { ok: true, status: 200, arrayBuffer: async () => makePng(10, 10) };
    };
    const out = await im.prepareVisionImages(
      [
        { url: "http://93.184.216.34/a.png", name: "http.png", contentType: "image/png", size: null, origin: "trigger" },
        { url: "https://127.0.0.1/b.png", name: "loop.png", contentType: "image/png", size: null, origin: "trigger" },
        { url: "https://10.1.2.3/c.png", name: "rfc1918.png", contentType: "image/png", size: null, origin: "trigger" },
      ],
      { fetchImpl: impl, resolveHost: publicResolver, ids },
    );
    assert.equal(fetched, 0, "refused hosts never reach fetch");
    assert.equal(out.sent, 0);
    assert.match(out.notes[0], /non-https/);
    assert.match(out.notes[1], /refused address range/);
    assert.match(out.notes[2], /refused address range/);
  });

  it("refuses when DNS resolves to a private address (even though fetch would succeed)", async () => {
    const { impl, calls } = fetchReturning(makePng(10, 10));
    const out = await im.prepareVisionImages(
      [{ url: "https://evil.example/a.png", name: "a.png", contentType: "image/png", size: null, origin: "trigger" }],
      { fetchImpl: impl, resolveHost: async () => ["192.168.0.1"], ids },
    );
    assert.equal(calls.length, 0);
    assert.equal(out.sent, 0);
  });

  it("drops a candidate without a url (never fetches undefined)", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const out = await im.prepareVisionImages(
        [{ url: "", name: "ghost.png", contentType: "image/png", size: null, origin: "trigger" }],
        { fetchImpl: async () => ({ ok: true }), resolveHost: publicResolver, ids },
      );
      assert.equal(out.sent, 0);
      assert.match(out.notes[0], /attachment has no url/);
    } finally {
      console.error = original;
    }
  });
});

// ---------- env knobs ----------

describe("visionLimits (env knobs)", () => {
  const saved = {};
  before(() => {
    for (const key of VISION_ENV_KEYS) saved[key] = process.env[key];
  });
  after(() => {
    for (const key of VISION_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("defaults: 4 images, 15 MiB per image, 12 MiB total, 10 s", () => {
    clearVisionEnv();
    const limits = im.visionLimits();
    assert.equal(limits.maxImages, 4);
    assert.equal(limits.maxImageBytes, 15 * 1024 * 1024);
    assert.equal(limits.maxTotalBytes, 12 * 1024 * 1024);
    assert.equal(limits.downloadTimeoutMs, 10_000);
  });

  it("GORK_VISION_MAX_IMAGES=0 is honored (off switch), garbage falls back", () => {
    process.env.GORK_VISION_MAX_IMAGES = "0";
    assert.equal(im.visionLimits().maxImages, 0);
    process.env.GORK_VISION_MAX_IMAGES = "-3";
    assert.equal(im.visionLimits().maxImages, 4);
    process.env.GORK_VISION_MAX_IMAGES = "9";
    assert.equal(im.visionLimits().maxImages, 9);
  });

  it("byte caps override via env", () => {
    process.env.GORK_VISION_MAX_IMAGE_BYTES = "1234";
    process.env.GORK_VISION_MAX_TOTAL_BYTES = "5678";
    assert.equal(im.visionLimits().maxImageBytes, 1234);
    assert.equal(im.visionLimits().maxTotalBytes, 5678);
  });
});

// #414 (LT-7): the vision download stops AT maxImageBytes mid-stream —
// a lying declared size can no longer buffer the whole giant body first.
describe("vision streamed image cap (#414)", () => {
  const ids = { guildId: "g1", userId: "u1", messageId: "m1" };

  it("stops the drip AT the image cap, names the cap, cancels the transfer", async () => {
    let reads = 0;
    let cancelled = 0;
    const impl = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader() {
          let sent = 0;
          return {
            read: async () => {
              reads += 1;
              if (sent >= 10) return { done: true, value: undefined };
              sent += 1;
              return { done: false, value: Buffer.alloc(16, 1) };
            },
            cancel: async () => {
              cancelled += 1;
            },
          };
        },
      },
      arrayBuffer: async () => {
        reads = 10;
        return Buffer.alloc(160);
      },
    });
    const out = await im.prepareVisionImages(
      [{ url: "https://x/drip.png", name: "drip.png", contentType: "image/png", size: 4, origin: "trigger" }],
      { fetchImpl: impl, resolveHost: publicResolver, ids, limits: { maxImageBytes: 64 } },
    );
    assert.equal(out.sent, 0);
    assert.match(out.notes[0], /bytes exceed the 64-byte cap \(stopped mid-stream\)/);
    assert.ok(reads <= 6, `the transport stopped at the cap (reads=${reads}; whole-buffer path = 10)`);
    assert.equal(cancelled, 1, "the drip transfer is cancelled — not left trickling");
  });
});
