/**
 * Orphan transcript-tree sweeper (#424, audit LT-10).
 *
 * mirrorTicketAssets/transcript writes live under
 * {DATA_DIR}/ticket-transcripts/{communityId}/ as {token}/ dirs (nested
 * index.html + assets) plus legacy {token}.html files. Before #424 NOTHING
 * ever removed any of it: an archive that crashed between mkdir and
 * finalize left a dir with no DB reference — invisible to the web surface
 * (token never stored), invisible to cleanup (no cleanup exists), permanent.
 * The retention sweep now deletes entries whose token matches NO tickets row
 * and whose mtime is past the orphan window; referenced tokens are
 * permanent truth, young entries may be mid-run.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before every src/ require (fresh temp DB, cache reset).
const { tmpDir, cleanup } = loadDb();

const {
  sweepOrphanTicketTranscripts,
  runRetentionSweeps,
  DAY_MS,
} = require("../src/features/retention/sweeps");

after(() => cleanup?.());

const T = Date.parse("2026-10-18T12:00:00.000Z");

function seedTree() {
  const root = fs.mkdtempSync(path.join(tmpDir, "tx-tree-"));
  const cdir = path.join(root, "42");
  fs.mkdirSync(cdir, { recursive: true });

  const mkDir = (token, ageDays) => {
    const d = path.join(cdir, token);
    fs.mkdirSync(path.join(d, "assets"), { recursive: true });
    fs.writeFileSync(path.join(d, "index.html"), "<html>ok</html>");
    fs.writeFileSync(path.join(d, "assets", "a.png"), Buffer.alloc(64));
    const t = new Date(T - ageDays * DAY_MS);
    fs.utimesSync(path.join(d, "assets", "a.png"), t, t);
    fs.utimesSync(path.join(d, "index.html"), t, t);
    fs.utimesSync(path.join(d, "assets"), t, t);
    fs.utimesSync(d, t, t);
    return d;
  };
  const mkFile = (token, ageDays) => {
    const f = path.join(cdir, `${token}.html`);
    fs.writeFileSync(f, "<html>legacy</html>");
    const t = new Date(T - ageDays * DAY_MS);
    fs.utimesSync(f, t, t);
    return f;
  };

  const deadDir = mkDir(crypto.randomUUID(), 8); // orphan, past window
  const deadFile = mkFile(crypto.randomUUID(), 30); // legacy orphan
  const referencedDir = mkDir(crypto.randomUUID(), 400); // old but REACHABLE
  const referencedFile = mkFile(crypto.randomUUID(), 90); // legacy + reachable
  const youngDir = mkDir(crypto.randomUUID(), 1); // in-flight window
  const boundaryDir = mkDir(crypto.randomUUID(), 7); // EXACTLY the cutoff
  const foreign = path.join(cdir, "notes.txt");
  fs.writeFileSync(foreign, "not ours");
  const foreignDir = path.join(cdir, "not-a-token");
  fs.mkdirSync(foreignDir);

  return {
    root,
    referenced: new Set([
      path.basename(referencedDir),
      path.basename(referencedFile, ".html"),
    ]),
    deadDir,
    deadFile,
    referencedDir,
    referencedFile,
    youngDir,
    boundaryDir,
    foreign,
    foreignDir,
  };
}

describe("orphan transcript-tree sweep (#424)", () => {
  it("deletes unreferenced entries past the window; keeps reachable/young/foreign", () => {
    const t = seedTree();
    const row = sweepOrphanTicketTranscripts(
      T,
      { ticketTranscriptOrphanDays: 7 },
      { root: t.root, referencedTokens: t.referenced },
    );
    assert.equal(row.table, "ticket-transcripts");
    assert.equal(row.deleted, 2, `row: ${JSON.stringify(row)}`);
    assert.equal(row.error, null);
    assert.equal(fs.existsSync(t.deadDir), false, "old orphan dir swept");
    assert.equal(fs.existsSync(t.deadFile), false, "old orphan legacy file swept");
    assert.ok(fs.existsSync(t.referencedDir), "REFERENCED dir is permanent, ever old");
    assert.ok(fs.existsSync(t.referencedFile), "referenced legacy file permanent");
    assert.ok(fs.existsSync(t.youngDir), "young dir may be mid-run — kept");
    assert.ok(fs.existsSync(t.boundaryDir), "exactly-at-cutoff survives (table-sweep rule)");
    assert.ok(fs.existsSync(t.foreign), "foreign files untouched");
    assert.ok(fs.existsSync(t.foreignDir), "foreign dirs untouched");
  });

  it("the days knob disables the sweep (0/off → nothing touched)", () => {
    const t = seedTree();
    const row = sweepOrphanTicketTranscripts(
      T,
      { ticketTranscriptOrphanDays: null },
      { root: t.root, referencedTokens: new Set() },
    );
    assert.equal(row.skipped, "disabled");
    assert.equal(row.deleted, 0);
    assert.ok(fs.existsSync(t.deadDir), "disabled means NOTHING dies");
  });

  it("missing root and broken dirs degrade without throwing", () => {
    const row = sweepOrphanTicketTranscripts(
      T,
      { ticketTranscriptOrphanDays: 7 },
      { root: path.join(tmpDir, "no-such-tree"), referencedTokens: new Set() },
    );
    assert.equal(row.deleted, 0);
    assert.equal(row.error, null);

    const root = fs.mkdtempSync(path.join(tmpDir, "tx-partial-"));
    const cdir = path.join(root, "42");
    fs.mkdirSync(cdir);
    const deadFile = path.join(cdir, `${crypto.randomUUID()}.html`);
    fs.writeFileSync(deadFile, "x");
    fs.utimesSync(deadFile, new Date(T - 30 * DAY_MS), new Date(T - 30 * DAY_MS));
    // A FILE where a community dir was expected is skipped by the walk
    // (only directories are entered) — prove the run still sweeps real dirs.
    fs.writeFileSync(path.join(root, "stray.txt"), "x");
    const row2 = sweepOrphanTicketTranscripts(
      T,
      { ticketTranscriptOrphanDays: 7 },
      { root, referencedTokens: new Set() },
    );
    assert.equal(row2.deleted, 1, "sweep continues past foreign entries");
    assert.equal(fs.existsSync(deadFile), false);
    assert.ok(fs.existsSync(path.join(root, "stray.txt")));
  });

  it("runRetentionSweeps carries the tree row without disturbing table rows", () => {
    const t = seedTree();
    const results = runRetentionSweeps({
      at: T,
      treeSweep: { root: t.root, referencedTokens: t.referenced },
    });
    const row = results.find((r) => r.table === "ticket-transcripts");
    assert.ok(row, "tree sweep rides the standard results");
    assert.equal(row.deleted, 2, JSON.stringify(row));
    assert.equal(
      results.filter((r) => r.table === "ticket-transcripts").length,
      1,
      "exactly one tree row",
    );
    assert.ok(
      results.some((r) => r.table === "activity_log"),
      "table sweeps still present in order",
    );
  });

  it("config default is 7 days and the env name parses", () => {
    const { retentionConfig, DEFAULT_TICKET_TRANSCRIPT_ORPHAN_DAYS } =
      require("../src/features/retention/config");
    assert.equal(DEFAULT_TICKET_TRANSCRIPT_ORPHAN_DAYS, 7);
    delete process.env.RETENTION_TICKET_TRANSCRIPT_ORPHAN_DAYS;
    assert.equal(retentionConfig().ticketTranscriptOrphanDays, 7);
    process.env.RETENTION_TICKET_TRANSCRIPT_ORPHAN_DAYS = "off";
    assert.equal(retentionConfig().ticketTranscriptOrphanDays, null);
    process.env.RETENTION_TICKET_TRANSCRIPT_ORPHAN_DAYS = "14";
    assert.equal(retentionConfig().ticketTranscriptOrphanDays, 14);
    delete process.env.RETENTION_TICKET_TRANSCRIPT_ORPHAN_DAYS;
  });
});
