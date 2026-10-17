const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

// Audit-2026-10 #202: PRAGMA user_version migration guard + explicit
// connection pragmas. See src/db/migrate.js for the tracking model:
// full idempotent replay stays the correctness mechanism; user_version is
// the record of a completed pass and the fast-skip flag.
describe("user_version migration guard (audit #202)", () => {
  let api;
  let cleanup;

  before(() => {
    // Contract: loadDb() runs before any other `src/` require — it points
    // DB_PATH at a fresh temp SQLite file, resets the src require cache and
    // only then loads src/db (which runs runMigrations() on load).
    ({ api, cleanup } = loadDb());
  });

  after(() => cleanup?.());

  const version = () => Number(api.db.pragma("user_version", { simple: true }));

  // Swap a registry entry's up() for an instrumented one. Returns
  // { restore, calls } — `calls.count` PROVES whether the replay actually
  // ran (or was skipped) instead of scraping console output.
  function instrument(migrationId) {
    const { migrations } = require("../src/db/migrate");
    const idx = migrations.findIndex((m) => m.id === migrationId);
    assert.ok(idx >= 0, `migration ${migrationId} must be registered`);
    const original = migrations[idx];
    const calls = { count: 0 };
    migrations[idx] = {
      ...original,
      up: (db, helpers) => {
        calls.count += 1;
        return original.up(db, helpers);
      },
    };
    return { calls, restore: () => (migrations[idx] = original) };
  }

  it("fresh DB: load-time migrate() stamps user_version with the full registry", () => {
    const { migrations, LATEST_VERSION } = require("../src/db/migrate");
    // Tripwire pinned per the issue's verification: the current registry is
    // 001–049. When a new migration lands, bump this number AND the registry
    // rule (versions are registry size; migrations are append-only).
    assert.equal(migrations.length, 49);
    assert.equal(LATEST_VERSION, 49);
    assert.equal(version(), 49, "load-time migrate() must stamp the version");
  });

  it("re-run on an applied DB is a recorded no-op skip", () => {
    const { runMigrations } = require("../src/db/migrate");
    // Poison one up() — if the guard truly SKIPS the replay this call cannot
    // throw; if it (wrongly) replays, the poison throws and the test fails.
    const { migrations } = require("../src/db/migrate");
    const idx = migrations.findIndex((m) => m.id === "020_twitch");
    const original = migrations[idx];
    migrations[idx] = {
      ...original,
      up: () => {
        throw new Error("replay must not run when user_version is current");
      },
    };
    try {
      const result = runMigrations();
      assert.deepEqual(result, { skipped: true, version: 49, latest: 49 });
    } finally {
      migrations[idx] = original;
    }
    assert.equal(version(), 49, "skip path must not touch the recorded version");
  });

  it("legacy DB (user_version=0): full replay runs, is safe on applied schema, re-stamps", () => {
    const { runMigrations } = require("../src/db/migrate");
    // Seed data so the replay proves it preserves an already-migrated DB.
    const g = communityKey("g-userversion-legacy");
    api.addXp(g, "u-keep", 42);

    api.db.pragma("user_version = 0"); // every pre-guard DB looks like this
    const probe = instrument("035_bridges");
    try {
      const result = runMigrations();
      assert.equal(result.skipped, false, "version 0 must take the full replay path");
      assert.equal(result.version, 49);
      assert.equal(
        probe.calls.count,
        1,
        "the instrumented migration must actually have been replayed"
      );
    } finally {
      probe.restore();
    }
    assert.equal(version(), 49, "successful replay re-stamps the version");
    assert.equal(api.getXp(g, "u-keep"), 42, "replay must not disturb data");
  });

  it("interrupted pass (partial version) still runs the FULL replay, not just the tail", () => {
    const { runMigrations } = require("../src/db/migrate");
    // A stale partial version must NOT be treated as "those steps are done":
    // correctness comes from replaying everything idempotently.
    api.db.pragma("user_version = 20");
    const { migrations } = require("../src/db/migrate");
    const early = migrations[4]; // migration 005 — far below version 20
    const original = early;
    let earlyRan = false;
    migrations[4] = {
      ...original,
      up: (db, helpers) => {
        earlyRan = true;
        return original.up(db, helpers);
      },
    };
    try {
      const result = runMigrations();
      assert.equal(result.skipped, false);
      assert.ok(earlyRan, "steps BELOW the recorded version must still replay");
      assert.equal(version(), 49);
    } finally {
      migrations[4] = original;
    }
  });

  it("downgrade guard: user_version newer than the registry throws specifically", () => {
    const { runMigrations } = require("../src/db/migrate");
    api.db.pragma("user_version = 999");
    assert.throws(
      () => runMigrations(),
      (err) =>
        /user_version=999/.test(err.message) &&
        /NEWER/.test(err.message) &&
        /version 49/.test(err.message) &&
        /049_honeypot_pause/.test(err.message),
      "error must name both the DB version and the newest known migration"
    );
    // The guard refuses to mutate: version stays exactly as found.
    assert.equal(version(), 999);
    api.db.pragma("user_version = 49"); // leave the DB usable for later tests
  });

  it("a failing migration does NOT stamp the version (next boot replays)", () => {
    const { runMigrations, migrations } = require("../src/db/migrate");
    api.db.pragma("user_version = 0");
    const original = migrations[2]; // 003 — the audit's non-transactional outlier
    migrations[2] = { ...original, up: () => { throw new Error("boom: simulated 003 crash"); } };
    try {
      assert.throws(() => runMigrations(), /simulated 003 crash/);
    } finally {
      migrations[2] = original;
    }
    assert.equal(version(), 0, "an interrupted pass must leave the old version recorded");
    // Recovery: the replay is idempotent, so the next boot finishes and stamps.
    const result = runMigrations();
    assert.equal(result.skipped, false);
    assert.equal(version(), 49);
  });

  it("a second skip path after recovery reports the stamped version", () => {
    const { runMigrations } = require("../src/db/migrate");
    assert.deepEqual(runMigrations(), { skipped: true, version: 49, latest: 49 });
  });
});

describe("explicit connection pragmas (audit #202)", () => {
  let api;
  let cleanup;

  before(() => {
    ({ api, cleanup } = loadDb());
  });

  after(() => cleanup?.());

  const pragma = (name) => api.db.pragma(name, { simple: true });

  it("journal_mode is WAL (file DB), set explicitly in connection.js", () => {
    assert.equal(String(pragma("journal_mode")).toLowerCase(), "wal");
  });

  it("foreign_keys is ON — matches the pre-#202 effective value (better-sqlite3 default)", () => {
    assert.equal(Number(pragma("foreign_keys")), 1);
  });

  it("synchronous is FULL (2) — SQLite durable default, now explicit", () => {
    assert.equal(Number(pragma("synchronous")), 2);
  });

  it("busy_timeout is 5000ms — bounded wait, consistent with the single-writer contract", () => {
    assert.equal(Number(pragma("busy_timeout")), 5000);
  });
});

describe("migration registry integrity (audit #278)", () => {
  let api;
  let cleanup;

  before(() => {
    ({ api, cleanup } = loadDb());
  });

  after(() => cleanup?.());

  const registry = () => require("../src/db/migrate").migrations;

  it("every registered migration exports a unique non-empty id", () => {
    const ids = registry().map((m) => m.id);
    assert.ok(
      ids.every((id) => typeof id === "string" && id.trim() !== ""),
      `all ${ids.length} entries must export an id`
    );
    assert.equal(new Set(ids).size, ids.length, "registry ids must be unique");
    assert.doesNotThrow(() =>
      require("../src/db/migrate").assertRegistryIntegrity()
    );
  });

  it("016 exports its id (the file the audit flagged as the lone outlier)", () => {
    const migration = require("../src/db/migrations/016_command_permission_oauth");
    assert.equal(migration.id, "016_command_permission_oauth");
    assert.equal(typeof migration.up, "function");
  });

  it("a missing id is refused with the registry position named", () => {
    const { assertRegistryIntegrity } = require("../src/db/migrate");
    const { migrations } = require("../src/db/migrate");
    const original = migrations[15]; // 016 — the historical offender
    migrations[15] = { up: original.up }; // strip the id, keep the shape
    try {
      assert.throws(
        () => assertRegistryIntegrity(),
        (err) =>
          /registry integrity/i.test(err.message) &&
          /entry #16/.test(err.message) &&
          /exports no id/.test(err.message)
      );
    } finally {
      migrations[15] = original;
    }
  });

  it("a duplicate id is refused with the id named", () => {
    const { assertRegistryIntegrity } = require("../src/db/migrate");
    const { migrations } = require("../src/db/migrate");
    const original = migrations[16]; // 017
    migrations[16] = { ...original, id: migrations[15].id }; // collide with 016
    try {
      assert.throws(
        () => assertRegistryIntegrity(),
        (err) =>
          /registry integrity/i.test(err.message) &&
          /duplicate id "016_command_permission_oauth"/.test(err.message) &&
          /#16 and #17/.test(err.message)
      );
    } finally {
      migrations[16] = original;
    }
  });

  it("runMigrations enforces the assertion on the fast-skip path too", () => {
    const { runMigrations } = require("../src/db/migrate");
    // DB is already stamped (skip path) — the registry check must still run.
    assert.deepEqual(
      runMigrations(),
      { skipped: true, version: 49, latest: 49 },
      "sanity: healthy registry takes the skip path"
    );
    const { migrations } = require("../src/db/migrate");
    const original = migrations[0];
    migrations[0] = { up: original.up };
    try {
      assert.throws(() => runMigrations(), /registry integrity/i);
    } finally {
      migrations[0] = original;
    }
  });
});
