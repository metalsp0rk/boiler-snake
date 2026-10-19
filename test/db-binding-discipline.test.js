/**
 * #609: temp-DB binding discipline — no test file may LOAD a src/db-bound
 * module without having bound its own temp DB.
 *
 * The audited incident (root-caused in #470 G2-6): `gork-read-discord` and
 * `gork-summarize-range` flaked with `database is locked` / `no such column:
 * guild_id` surfacing as a rendered read line. The files REQUIRED (at load
 * time) src modules whose chain reaches src/db WITHOUT binding env first, so
 * connection.js opened whatever ambient DB_PATH the shell exported;
 * `node --test` runs files as CONCURRENT processes, two such files sharing
 * one path raced mid-MIGRATION, and the loser saw a partially-migrated
 * schema. The failure always masquerades as a product bug in an unrelated
 * assertion.
 *
 * The rule (test/README.md #6): a test file may only LOAD src/db-bound code
 * after its own temp DB is bound — loadDb() / createIntegrationEnv() /
 * createE2eEnv() — and the binder must run BEFORE the first such require,
 * because connection.js opens its SQLite file at require time: the binding
 * is a LOAD-TIME fact, not a runtime one.
 *
 * The scan follows TOP-LEVEL requires only (column-0 require lines) —
 * exactly the load-time class. Requires inside functions (the sanctioned
 * lazy style: harness internals, loadDb's own `require("../../src/db")`)
 * execute only after the binder ran, and the binder check below keeps every
 * file that references one honest. Lazy requires OUTSIDE those binders are
 * invisible to static analysis — the blessed helpers exist precisely so new
 * code does not hand-roll them; audit any new dynamic style.
 *
 * The #609 ORDERING pin (added the day after #609 shipped, when the web
 * tier caught files carrying the binder token while the binder RAN in a
 * late before()): for a file whose load-time graph reaches src/db, an
 * actual loadDb() CALL must PRECEDE the first db-bound column-0 require.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const TESTS = __dirname;
const SRC_DB = path.join(__dirname, "..", "src", "db");
const SRC_DB_JS = path.join(__dirname, "..", "src", "db.js");

/** Sanctioned per-file binders (each opens a fresh temp DB + env). */
const TOKENS = ["loadDb(", "createIntegrationEnv(", "createE2eEnv("];

/**
 * Audited allow-list: files exempt from the pin WITH a written reason.
 * Keep this EMPTY by preference — the gork files were FIXED to the pattern,
 * not allow-listed.
 */
const ALLOWED = new Set([
  // (none)
]);

function walkTestFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".vitepress") {
      continue;
    }
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTestFiles(p, out);
    else if (entry.name.endsWith(".test.js")) out.push(p);
  }
  return out;
}

const readCache = new Map();
function read(file) {
  if (!readCache.has(file)) readCache.set(file, fs.readFileSync(file, "utf8"));
  return readCache.get(file);
}

/** Resolve a literal require specifier to an existing file (or null). */
function resolves(fromFile, spec) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // bare specifier
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, path.join(base, "index.js")]) {
    try {
      if (fs.statSync(cand).isFile()) return cand;
    } catch {
      /* not this candidate */
    }
  }
  return null;
}

function isDbModule(abs) {
  return abs === SRC_DB_JS || abs.startsWith(SRC_DB + path.sep);
}

/**
 * TOP-LEVEL require lines only (column 0 — the file's load-time graph).
 * `const {x} = require("…")`, `const x = require("…")`, bare `require("…")`,
 * and the LAST line of a multi-line destructure (`} = require("…")` sits at
 * column 0). Anything else-indented is inside a block/function — executed at
 * call time, after the binder (if the file has one; the token rule pins that).
 */
const TOP_REQ =
  /^(?:const|let|var)\s[^\n=]*?=\s*require\(\s*["']([^"']+)["']\s*\)|^require\(\s*["']([^"']+)["']\s*\)|^\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)/;

/** Does this file's LOAD-TIME graph reach the database layer? */
function loadTimeReachesDb(file, seen = new Set([file])) {
  for (const line of read(file).split("\n")) {
    const m = TOP_REQ.exec(line);
    const spec = m && (m[1] || m[2] || m[3]);
    if (!spec) continue;
    const resolved = resolves(file, spec);
    if (!resolved) continue;
    if (isDbModule(resolved)) return true;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      if (loadTimeReachesDb(resolved, seen)) return true;
    }
  }
  return false;
}

describe("#609: every db-reaching test file binds its own temp DB", () => {
  const corpus = walkTestFiles(TESTS).sort();

  it("the corpus is scanned (sanity: it is large and the walk has teeth)", () => {
    assert.ok(corpus.length >= 200, `expected the whole test corpus, found ${corpus.length}`);
    // Positive control: this file top-level-REQUIRES src features whose load
    // chain reaches src/db — if the walk ever misses it, the pin is vacuous.
    assert.equal(
      loadTimeReachesDb(path.join(TESTS, "fluxer-xp-award.test.js")),
      true,
      "load-time walk must reach src/db through src modules (scan teeth)",
    );
    // Negative control: a pure-math unit file loads nothing db-bound.
    assert.equal(
      loadTimeReachesDb(path.join(TESTS, "xp-math.test.js")),
      false,
      "pure unit closure must stay db-free",
    );
  });

  it("the gork incident files demonstrate the pinned pattern", () => {
    // The #470 G2-6 flakers are the canonical example: fixed IN PLACE to
    // loadDb() + cleanup BEFORE their src/** requires — not allow-listed.
    for (const f of ["gork-read-discord.test.js", "gork-summarize-range.test.js"]) {
      const file = path.join(TESTS, f);
      assert.ok(fs.existsSync(file), `${f} exists (rename = update this pin)`);
      const src = read(file);
      assert.ok(src.includes("loadDb("), `${f} binds its own temp DB`);
      assert.ok(
        src.indexOf("loadDb(") < src.indexOf('require("../src/'),
        `${f} binds BEFORE the first src/** require (connection.js binds DB_PATH at LOAD time)`,
      );
    }
  });

  it("no test file LOADS src/db-bound code without a sanctioned binding", () => {
    const offenders = [];
    for (const file of corpus) {
      if (ALLOWED.has(file)) continue;
      const src = read(file);
      if (TOKENS.some((t) => src.includes(t))) continue;
      if (loadTimeReachesDb(file)) {
        offenders.push(path.relative(path.join(__dirname, ".."), file));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a test file must call loadDb() / createIntegrationEnv() / createE2eEnv() BEFORE its " +
        "first load-time require of src/** (connection.js binds DB_PATH at require time; " +
        "concurrent node --test files sharing an ambient DB_PATH race mid-migration — the " +
        "#609 gork flake class). Allow-list additions need an audit note.",
    );
  });

  it("the FIRST db-bound require is preceded by an actual loadDb() CALL (#609 ordering)", () => {
    // The day after #609 merged, the web tier caught the residue of the
    // containment-only rule: web-oauth-ratelimit / web-security-middleware /
    // web-member-fetch-queue all CONTAINED a binder token, but the binder
    // RAN in a late before()/test while the FIRST column-0 require of a
    // db-bound module had already opened (and raced migrations on) the
    // ambient DB_PATH at LOAD time. Token presence is not enough — for a
    // file whose LOAD-TIME graph reaches src/db, the text preceding the
    // first db-bound require must contain an actual loadDb() CALL.
    // (createIntegrationEnv/createE2eEnv are async — they cannot bind the
    // load order; such files keep src requires lazy, harness style, and
    // stay in the load-time-db-free lane above.)
    const offenders = [];
    for (const file of corpus) {
      if (ALLOWED.has(file)) continue;
      const lines = read(file).split("\n");
      let firstIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const m = TOP_REQ.exec(lines[i]);
        const spec = m && (m[1] || m[2] || m[3]);
        if (!spec) continue;
        const resolved = resolves(file, spec);
        if (!resolved) continue;
        if (isDbModule(resolved) || loadTimeReachesDb(resolved, new Set([resolved]))) {
          firstIdx = i;
          break;
        }
      }
      if (firstIdx === -1) continue; // (b) load-time db-free — ordering vacuous
      const before = lines.slice(0, firstIdx).join("\n");
      if (!/loadDb\(\)/.test(before)) {
        offenders.push(
          `${path.relative(path.join(__dirname, ".."), file)} (line ${firstIdx + 1}: ${lines[firstIdx].trim().slice(0, 60)})`,
        );
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a module-level loadDb() CALL must PRECEDE the first column-0 require whose graph " +
        "reaches src/db — a binder buried in before()/a test body runs AFTER the ambient " +
        "DB_PATH was already opened and migrated at LOAD time (the class that corrupted " +
        "the shared dev DB the day #609 shipped). The inline `require(\"…/helpers/env\")" +
        ".loadDb()` one-liner above the first db-bound require is the minimal fix.",
    );
  });

  it("no test file lazy-requires src/db-bound code without ever binding env (#620 lazy reach)", () => {
    // The walk above and the ordering pin judge COLUMN-0 lines. A require
    // INSIDE a function body — the classic `require("../src/db/...")` in a
    // test — binds sqlite at CALL time, and without any binder that is
    // still the ambient DB_PATH (bridge-sole-owner loaded the bridges repo
    // this way and created the root sqlite during a full npm test — the
    // lazy class the containment scan could not see). This pin walks every
    // require literal in the test file itself: for each NON-column-0
    // require, follow only the target's LOAD-TIME graph (module internals
    // stay a load-time verdict — helpers/env's own lazy `require("../../src/db")`
    // inside loadDb is exactly why the full closure from shared helpers is
    // NOT walked). Files with an audited private-DB mechanism (their own
    // `process.env.DB_PATH =` assignment, the legacy migration-test idiom)
    // satisfy the token rule.
    const LAZY_TOKENS = [
      ...TOKENS,
      "process.env.DB_PATH =", // legacy manual private bind (mkdtemp idiom)
    ];
    const ANY_REQ = /require\(\s*["']([^"']+)["']\s*\)/g;
    const offenders = [];
    for (const file of corpus) {
      if (ALLOWED.has(file)) continue;
      const src = read(file);
      if (LAZY_TOKENS.some((t) => src.includes(t))) continue;
      const lines = src.split("\n");
      const rel = path.relative(path.join(__dirname, ".."), file);
      outer: for (let i = 0; i < lines.length; i++) {
        if (TOP_REQ.test(lines[i])) continue; // column-0 lane (pins above)
        for (const m of lines[i].matchAll(ANY_REQ)) {
          const resolved = resolves(file, m[1]);
          if (!resolved) continue;
          if (isDbModule(resolved) || loadTimeReachesDb(resolved, new Set([resolved]))) {
            offenders.push(`${rel} (line ${i + 1}: ${m[1]})`);
            break outer; // one hit per file is proof enough
          }
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a test file that lazy-requires src/db-bound code (inside a test body) must bind env " +
        "too — the require binds sqlite at CALL time on whatever DB_PATH is ambient. " +
        "Module-level loadDb() is the fix; migration-sandbox files may keep their own " +
        "audited process.env.DB_PATH mechanism instead. (#620)"
    );
  });
});
