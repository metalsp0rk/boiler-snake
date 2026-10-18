/**
 * Transcript asset-tree budget (#424, audit LT-10).
 *
 * Per-file (50 MiB) and per-ticket (100 files) caps left the AGGREGATE
 * member-influenced: embed image URLs are enough for a member to steer what
 * a staff `/ticket archive` downloads, and the tree that grows next to the
 * SQLite DB had no byte bound and no sweep. This file pins the bound
 * (mirrorTicketAssets tree budget, with the test seams treeBudgetBytes /
 * treeRoot) plus the budget parser and the early-abort byte walk. The
 * sweeper for what already lies there lives in
 * test/retention-transcript-sweep.test.js.
 *
 * No sockets: downloads run through the SSRF-guard seam with a fake
 * fetchImpl serving fixed-size bodies and a public-IP resolveHost.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before every src/ require (fresh temp DB, cache reset).
const { tmpDir, cleanup } = loadDb();
process.env.DATA_DIR = tmpDir;

const assets = require("../src/features/tickets/assets");

after(() => cleanup?.());

const PUBLIC_IP = "93.184.216.34";
const publicResolve = async () => [PUBLIC_IP];

/** Fake guarded fetch serving a fixed-size PNG-ish body per URL. */
function fakeFetch(bytes) {
  return async () => ({
    ok: true,
    headers: {
      get: (h) =>
        String(h).toLowerCase() === "content-type" ? "image/png" : null,
    },
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  });
}

function mediaMessage(n) {
  return {
    attachment_urls: JSON.stringify([
      { url: `https://media.example.com/${n}.png`, name: `${n}.png` },
    ]),
  };
}

function freshTreeRoot(tag) {
  return fs.mkdtempSync(path.join(tmpDir, `tree-${tag}-`));
}

describe("transcript asset-tree budget (#424)", () => {
  it("parseAssetTreeBudget: unset/garbage default to 2 GiB, 0/off disable", () => {
    const TWO_GIB = 2 * 1024 * 1024 * 1024;
    assert.equal(assets.parseAssetTreeBudget(undefined), TWO_GIB);
    assert.equal(assets.parseAssetTreeBudget(""), TWO_GIB);
    assert.equal(assets.parseAssetTreeBudget("garbage"), TWO_GIB);
    assert.equal(assets.parseAssetTreeBudget("-5"), TWO_GIB);
    assert.equal(assets.parseAssetTreeBudget("0"), 0, "0 = unlimited (explicit)");
    assert.equal(assets.parseAssetTreeBudget("off"), 0);
    assert.equal(assets.parseAssetTreeBudget("unlimited"), 0);
    assert.equal(assets.parseAssetTreeBudget("1024"), 1024);
    assert.equal(assets.parseAssetTreeBudget("1024.9"), 1024, "floored");
    assert.equal(assets.MAX_ASSET_TREE_BYTES, TWO_GIB, "module default is the 2 GiB");
  });

  it("treeBytes sums regular files recursively and early-aborts past stopAfter", () => {
    const root = freshTreeRoot("walk");
    fs.mkdirSync(path.join(root, "7", "tok", "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "7", "tok", "index.html"), Buffer.alloc(100));
    fs.writeFileSync(path.join(root, "7", "tok", "assets", "a.png"), Buffer.alloc(1000));
    fs.writeFileSync(path.join(root, "7", "loose.html"), Buffer.alloc(7));

    assert.equal(assets.treeBytes(root), 1107);
    assert.ok(assets.treeBytes(root, 500) > 500, "early abort crosses the stop");
    assert.equal(assets.treeBytes(path.join(root, "missing")), 0, "missing dir = 0");
  });

  it("a tree already at budget mirrors NOTHING and creates no dir (RED pre-fix)", async () => {
    const treeRoot = freshTreeRoot("full");
    fs.mkdirSync(path.join(treeRoot, "9"), { recursive: true });
    fs.writeFileSync(path.join(treeRoot, "9", "fat.bin"), Buffer.alloc(1000));

    const res = await assets.mirrorTicketAssets(
      [mediaMessage(1), mediaMessage(2)],
      {
        communityId: 7,
        token: crypto.randomUUID(),
        fetchImpl: fakeFetch(600),
        resolveHost: publicResolve,
        treeRoot,
        treeBudgetBytes: 1000,
      },
    );
    assert.equal(res.downloaded, 0, "nothing crosses the door");
    assert.equal(res.failed, 0);
    assert.equal(res.messages.length, 2, "messages pass through untouched");
    assert.ok(
      res.warnings.some((w) => /asset tree is at its .*budget/i.test(w)),
      `budget warning names the tree: ${JSON.stringify(res.warnings)}`,
    );
    // RED on old code: mirrorTicketAssets mkdir'd its token dir BEFORE any
    // work — an empty dir is exactly the orphan garbage LT-10 counted.
    assert.equal(
      fs.existsSync(res.assetsDir),
      false,
      "skip path creates NO assets dir (no fresh garbage)",
    );
  });

  it("crossing the budget mid-run stops the mirror and reports the count", async () => {
    const treeRoot = freshTreeRoot("mid");
    const token = crypto.randomUUID();
    const res = await assets.mirrorTicketAssets(
      [mediaMessage(1), mediaMessage(2), mediaMessage(3)],
      {
        communityId: 7,
        token,
        fetchImpl: fakeFetch(600),
        resolveHost: publicResolve,
        treeRoot,
        treeBudgetBytes: 1100,
      },
    );
    // 0 < 1100 → file 1 (600 written); 600 < 1100 → file 2 (1200 written);
    // 1200 >= 1100 → file 3 NEVER starts.
    assert.equal(res.downloaded, 2, "the file over budget is not fetched");
    assert.ok(
      res.warnings.some((w) => /reached after 2 media file\(s\)/.test(w)),
      `partial result is reported: ${JSON.stringify(res.warnings)}`,
    );
    const files = fs.readdirSync(res.assetsDir);
    assert.equal(files.length, 2, "only the two in-budget files exist");
  });

  it("budget 0 is the documented unlimited knob", async () => {
    const treeRoot = freshTreeRoot("unlimited");
    fs.writeFileSync(
      path.join(treeRoot, "huge.bin"),
      Buffer.alloc(4 * 1024 * 1024),
    );
    const res = await assets.mirrorTicketAssets([mediaMessage(1)], {
      communityId: 7,
      token: crypto.randomUUID(),
      fetchImpl: fakeFetch(600),
      resolveHost: publicResolve,
      treeRoot,
      treeBudgetBytes: 0,
    });
    assert.equal(res.downloaded, 1, "no budget = no opinions");
    assert.equal(res.warnings.length, 0);
  });
});
