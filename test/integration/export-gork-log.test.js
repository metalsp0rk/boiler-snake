/**
 * export-gork-log CLI integration test (Phase C, session
 * 2026-09-13-gork-interaction-log): the script runs as a REAL subprocess
 * against a REAL SQLite file (temp DB_PATH) seeded through the db facade.
 * Covers the exit-code contract (0/1/2), fixture files on disk, the
 * memory-turn chain export via --uid, and the specific error surfaces.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gork-export-it-"));
const dbPath = path.join(tmp, "xpbot.sqlite");
const outDir = path.join(tmp, "out");

let db;

function row(overrides) {
  return {
    uid: overrides.uid || `uid-${Math.random().toString(36).slice(2)}`,
    kind: "qa",
    guild_id: "g-export",
    channel_id: "c1",
    message_id: "m1",
    user_id: "u1",
    status: "shipped",
    started_at: Date.now(),
    duration_ms: 5,
    model: "gpt-4o-mini",
    settings: '{"gork_keyword":"gork"}',
    system_prompt: "SYS",
    user_prompt: "USR",
    trigger_content: "gork: hi",
    transcript: '{"events":[{"type":"response","ok":true,"data":{"id":"r1"}}]}',
    answer_shipped: "hi there",
    ...overrides,
  };
}

function runCli(args) {
  return spawnSync(process.execPath, ["scripts/export-gork-log.js", ...args], {
    cwd: path.join(__dirname, "..", ".."),
    encoding: "utf8",
    env: { ...process.env, DB_PATH: dbPath },
    timeout: 30000,
  });
}

before(async () => {
  process.env.DB_PATH = dbPath;
  db = require("../../src/db"); // fresh temp DB via env (same rules as the bot)
  const qa = row({ uid: "qa-1" });
  assert.equal(db.insertGorkInteraction(qa).ok, true);
  assert.equal(
    db
      .insertGorkInteraction(
        row({
          uid: "mem-1",
          kind: "memory_turn",
          parent_uid: "qa-1",
          message_id: "m0-prior",
          trigger_content: "gork: earlier",
        }),
      )
      .ok,
    true,
  );
});

after(() => {
  try {
    if (db && db.db && typeof db.db.close === "function") db.db.close();
  } catch {
    /* best effort */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("export-gork-log CLI (real subprocess, real temp DB)", () => {
  it("--help prints usage and exits 0", () => {
    const r = runCli(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: node scripts\/export-gork-log\.js/);
  });

  it("unknown flag exits 2 with the specific complaint", () => {
    const r = runCli(["--wat"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag: --wat/);
  });

  it("no selector exits 2", () => {
    const r = runCli([]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /one of --uid or --guild is required/);
  });

  it("--guild exports one file per fixture and exits 0", () => {
    const r = runCli(["--guild", "g-export", "--kind", "all", "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 1, `expected fixtures, got: ${files.join(",")}`);
    const fx = JSON.parse(fs.readFileSync(path.join(outDir, "qa-1.json"), "utf8"));
    assert.equal(fx.v, 1);
    assert.equal(fx.uid, "qa-1");
    assert.equal(fx.expect.userPrompt, "USR");
    assert.equal(fx.expect.shippedAnswer, "hi there");
  });

  it("--uid <qa> attaches the memory_turn companions linked via parent_uid", () => {
    // Seed a REAL parent→companion chain (plus a decoy pointing at a
    // different parent and a qa row with no companions at all) straight
    // through the db repo, then export each qa row by uid.
    const base = Date.now();
    for (const seed of [
      row({ uid: "qa-chain", created_at: base }),
      row({
        uid: "mem-chain",
        kind: "memory_turn",
        parent_uid: "qa-chain",
        created_at: base + 5000, // recorded AFTER its qa parent
        message_id: "m-chain",
        trigger_content: "gork: chained extraction",
      }),
      row({
        uid: "mem-decoy",
        kind: "memory_turn",
        parent_uid: "qa-not-in-this-export", // different parent → must NOT attach
        created_at: base + 6000,
      }),
      row({ uid: "qa-lonely", created_at: base }),
    ]) {
      assert.equal(db.insertGorkInteraction(seed).ok, true);
    }

    const out2 = path.join(tmp, "out-uid");
    const r = runCli(["--uid", "qa-chain", "--out", out2]);
    assert.equal(r.status, 0, r.stderr);
    const fx = JSON.parse(fs.readFileSync(path.join(out2, "qa-chain.json"), "utf8"));
    assert.equal(fx.uid, "qa-chain");
    assert.equal(
      fx.memory.memoryTurns.length,
      1,
      `exactly the ONE companion attaches, got: ${JSON.stringify(
        fx.memory.memoryTurns.map((t) => t.uid),
      )}`,
    );
    assert.equal(fx.memory.memoryTurns[0].uid, "mem-chain");

    // A qa row without companions still exports cleanly with none.
    const r2 = runCli(["--uid", "qa-lonely", "--out", out2]);
    assert.equal(r2.status, 0, r2.stderr);
    const fx2 = JSON.parse(
      fs.readFileSync(path.join(out2, "qa-lonely.json"), "utf8"),
    );
    assert.equal(fx2.memory.memoryTurns.length, 0, "qa-only row exports with 0 turns");
  });

  it("missing uid exits 1 with the uid named in the error", () => {
    const r = runCli(["--uid", "uid-does-not-exist"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no gork_interaction with uid "uid-does-not-exist"/);
  });

  it("empty guild is NOT an error: exit 0 + clear message", () => {
    const r = runCli(["--guild", "g-empty", "--out", path.join(tmp, "out-0")]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no kind "qa" rows stored for guild g-empty/);
  });
});
