const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// Load src modules whose require chain reaches src/db AFTER binding a
// private temp DB (same discipline as test/migrations-xp-clamp-050.test.js).
const { loadDb } = require("./helpers/env");
const { cleanup: cleanupTempDb } = loadDb();
after(cleanupTempDb);

const Database = require("better-sqlite3");

// The web calendar printed a literal "NaN" wherever an event instant had
// degraded to TEXT (SQLite INTEGER affinity stores non-numeric text AS
// text). Migration 072 repairs the data; the view hardening keeps the
// renderer honest even if a fresh bad row slips in.
const { id, up } = require("../src/db/migrations/072_heal_event_dates");

const START = Date.UTC(2026, 5, 6, 20, 0, 0);
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

function seed() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      start_at INTEGER NOT NULL,
      end_at INTEGER,
      post_at INTEGER,
      cutoff_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE event_reminder_offsets (
      id INTEGER PRIMARY KEY,
      fire_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE TABLE event_series (
      id INTEGER PRIMARY KEY,
      next_occurrence_at INTEGER
    );
  `);
  // Affinity proof: these non-numeric strings stay TEXT on insert.
  db.prepare(
    `INSERT INTO events (id, start_at, end_at, post_at, cutoff_at, created_at) VALUES
      (1, ${START}, ${START + 7200000}, NULL, NULL, ${START - 86400000}),
      (2, '2026-06-06T20:00:00Z', 'NaN', 'gibberish', '2026-06-06 19:00:00', ${START - 86400000}),
      (3, '2026-06-07 20:00:00', 1780992000500.5, '2026-06-07T18:30:00Z', NULL, ${START}),
      (4, 'NaN', 'not a date', 'NaN', 'NaN', ${START - 3600000})`
  ).run();
  db.prepare(
    `INSERT INTO event_reminder_offsets (id, fire_at, sent_at) VALUES
      (1, ${START - 1800000}, NULL),
      (2, 'NaN', NULL),
      (3, '2026-06-06T19:30:00Z', NULL)`
  ).run();
  db.prepare(
    `INSERT INTO event_series (id, next_occurrence_at) VALUES
      (1, ${START}),
      (2, '2026-07-04 18:00:00'),
      (3, 'whenever')`
  ).run();
  return db;
}

const row = (db, sql) => db.prepare(sql).get();

describe(`${id} — event date columns heal to integer ms`, () => {
  it("repairs parseable text instants, drops REAL dust, NULLs junk nullable columns", () => {
    const db = seed();
    // Affinity guard: the junk really is TEXT in an INTEGER-affinity column.
    assert.equal(row(db, `SELECT typeof(start_at) t FROM events WHERE id=2`).t, "text");

    up(db, { now: () => NOW });

    // Row 1 (clean) untouched.
    const clean = row(db, `SELECT * FROM events WHERE id=1`);
    assert.equal(clean.start_at, START);
    assert.equal(clean.end_at, START + 7200000);

    // Row 2: ISO Z parsed; junk post_at → NULL; space-date cutoff parsed.
    const healed = row(db, `SELECT * FROM events WHERE id=2`);
    assert.equal(healed.start_at, Date.parse("2026-06-06T20:00:00Z"));
    assert.equal(healed.end_at, null, "junk end_at → NULL (renders —)");
    assert.equal(healed.post_at, null, "junk post_at → NULL (renders on approval)");
    assert.equal(healed.cutoff_at, Date.parse("2026-06-06T19:00:00Z"));

    // Row 3: wall-clock date parsed in UTC; REAL cast to integer ms.
    const r3 = row(db, `SELECT * FROM events WHERE id=3`);
    assert.equal(r3.start_at, Date.UTC(2026, 5, 7, 20, 0, 0));
    assert.equal(r3.end_at, 1780992000500, "REAL dust casts to integer ms");
    assert.equal(typeof r3.end_at, "number");
    assert.equal(r3.post_at, Date.parse("2026-06-07T18:30:00Z"));

    // Row 4: unparseable start_at → created_at; all junk nullables NULL.
    const r4 = row(db, `SELECT * FROM events WHERE id=4`);
    assert.equal(r4.start_at, START - 3600000, "start_at falls back to created_at");
    assert.equal(r4.end_at, null);
    assert.equal(r4.post_at, null);
    assert.equal(r4.cutoff_at, null);

    // Every column is now integer or NULL — the calendar can never print NaN.
    for (const col of ["start_at", "end_at", "post_at", "cutoff_at"]) {
      const bad = db
        .prepare(`SELECT count(*) c FROM events WHERE ${col} IS NOT NULL AND typeof(${col}) <> 'integer'`)
        .get().c;
      assert.equal(bad, 0, `${col} holds only integer ms after healing`);
    }
  });

  it("reminders and series heal too (never-due junk stays never-due)", () => {
    const db = seed();
    up(db, { now: () => NOW });

    const ok = row(db, `SELECT * FROM event_reminder_offsets WHERE id=1`);
    assert.equal(ok.fire_at, START - 1800000, "valid reminder untouched");
    assert.equal(ok.sent_at, null);

    const junk = row(db, `SELECT * FROM event_reminder_offsets WHERE id=2`);
    assert.equal(junk.fire_at, 0);
    assert.equal(junk.sent_at, NOW, "broken reminder stamped settled — it could never fire");

    const parsed = row(db, `SELECT * FROM event_reminder_offsets WHERE id=3`);
    assert.equal(parsed.fire_at, Date.parse("2026-06-06T19:30:00Z"));

    assert.equal(row(db, `SELECT next_occurrence_at v FROM event_series WHERE id=1`).v, START);
    assert.equal(
      row(db, `SELECT next_occurrence_at v FROM event_series WHERE id=2`).v,
      Date.UTC(2026, 6, 4, 18, 0, 0)
    );
    assert.equal(row(db, `SELECT next_occurrence_at v FROM event_series WHERE id=3`).v, null);
  });

  it("is idempotent (replay heals nothing and changes nothing)", () => {
    const db = seed();
    up(db, { now: () => NOW });
    const first = db.prepare(`SELECT * FROM events ORDER BY id`).all();
    const firstRem = db.prepare(`SELECT * FROM event_reminder_offsets ORDER BY id`).all();
    up(db, { now: () => NOW + 999 });
    assert.deepEqual(db.prepare(`SELECT * FROM events ORDER BY id`).all(), first);
    assert.deepEqual(
      db.prepare(`SELECT * FROM event_reminder_offsets ORDER BY id`).all(),
      firstRem
    );
  });
});
