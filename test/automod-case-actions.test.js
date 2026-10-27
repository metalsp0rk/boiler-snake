/**
 * #729 (epic #723): automod_case_actions ledger repository tests — the
 * migration surface (enum CHECKs, the slot index), the atomic claim
 * primitives (single winner, losers re-read the existing row), the finalize
 * gate (claim before record), and the considered-row reads #730/#731 use.
 *
 * Real SQLite via loadDb — same house style as automod-settings.test.js.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

const repo = require("../src/db/repositories/automodCaseActions");

after(() => cleanup());

let seq = 0;
const freshCommunity = () => communityKey(`automod-729-repo-${++seq}`);
const GUILD = "700000000000000101";

const baseIntent = (over = {}) => ({
  communityId: undefined,
  guildId: GUILD,
  caseId: 101,
  subjectUserId: "u-subject",
  action: "kick",
  mode: "auto",
  params: { reason: "repeat spam" },
  ...over,
});

describe("migration 069 — automod_case_actions surface", () => {
  it("is registered, creates the table, the two reads + the slot index", () => {
    const { migrations } = require("../src/db/migrate");
    assert.ok(
      migrations.some((m) => m.id === "069_automod_case_actions"),
      "069_automod_case_actions must be registered in migrate.js",
    );
    const names = db.db
      .prepare(`SELECT name, type FROM sqlite_master WHERE name LIKE 'automod_case_actions%' OR name LIKE '%automod_case_actions%'`)
      .all()
      .map((r) => r.name);
    for (const expected of [
      "automod_case_actions",
      "idx_automod_case_actions_case",
      "idx_automod_case_actions_subject",
      "ux_automod_case_actions_slot",
    ]) {
      assert.ok(names.includes(expected), `missing object: ${expected} (${names})`);
    }
  });

  it("case_id is a NULLABLE plain column — NO FK to the concurrent automod_cases table", () => {
    const ddl = db.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='automod_case_actions'`)
      .get().sql;
    assert.match(ddl, /case_id INTEGER(?!\s*REFERENCES)/i);
    assert.doesNotMatch(ddl, /automod_cases/i, "no FK to #726's table may exist here");
    // A NULL-case row inserts fine (case linkage is optional by contract).
    const cid = freshCommunity();
    const r = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, caseId: null, mode: "suggest" }));
    assert.equal(r.ok, true);
    assert.equal(r.row.case_id, null);
  });

  it("state/action/mode enum CHECKs pin the vocabulary at the storage layer", () => {
    const cid = freshCommunity();
    const junkInserts = [
      ["state", `INSERT INTO automod_case_actions (community_id, action, mode, state, created_at, updated_at)
                 VALUES (?, 'kick', 'auto', 'bogus', 1, 1)`],
      ["action", `INSERT INTO automod_case_actions (community_id, action, mode, state, created_at, updated_at)
                  VALUES (?, 'inspect', 'auto', 'suggested', 1, 1)`],
      ["mode", `INSERT INTO automod_case_actions (community_id, action, mode, state, created_at, updated_at)
                VALUES (?, 'kick', 'sometimes', 'suggested', 1, 1)`],
    ];
    for (const [column, sql] of junkInserts) {
      assert.throws(
        () => db.db.prepare(sql).run(cid),
        /CHECK constraint failed/i,
        `${column} enum must reject junk`,
      );
    }
    // Every state the repo pins round-trips through raw SQL.
    for (const state of repo.AUTOMOD_ACTION_STATES) {
      const info = db.db
        .prepare(
          `INSERT INTO automod_case_actions (community_id, action, mode, state, created_at, updated_at)
           VALUES (?, 'warn', 'suggest', ?, 1, 1)`,
        )
        .run(cid, state);
      assert.ok(Number(info.lastInsertRowid) > 0);
    }
    // Considered semantics (decision 4 / #731): EVERY recorded state counts.
    assert.deepEqual(
      [...repo.AUTOMOD_CONSIDERED_STATES],
      [...repo.AUTOMOD_ACTION_STATES],
    );
  });

  it("re-running the full migration set is safe and preserves recorded rows", () => {
    const cid = freshCommunity();
    const before = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, mode: "suggest" }));
    assert.equal(before.ok, true);
    const { runMigrations } = require("../src/db/migrate");
    db.db.pragma("user_version = 0");
    assert.doesNotThrow(() => runMigrations());
    assert.ok(repo.getAutomodAction(before.row.id), "ledger row survives the replay");
  });
});

describe("automod case-action repo — intent inserts + the slot", () => {
  it("suggestion insert round-trips every field", () => {
    const cid = freshCommunity();
    const r = repo.insertAutomodActionSuggestion(
      baseIntent({ communityId: cid, mode: "suggest", params: { durationSeconds: 600 }, nowMs: 111 }),
    );
    assert.equal(r.ok, true);
    const row = r.row;
    assert.equal(row.community_id, cid);
    assert.equal(row.guild_id, GUILD);
    assert.equal(row.case_id, 101);
    assert.equal(row.subject_user_id, "u-subject");
    assert.equal(row.action, "kick");
    assert.equal(row.mode, "suggest");
    assert.equal(row.state, "suggested");
    assert.equal(row.params_json, JSON.stringify({ durationSeconds: 600 }));
    assert.equal(row.claimed_by, null, "a suggestion is NOT claimed");
    assert.equal(row.claimed_at, null);
    assert.equal(row.created_at, 111);
    assert.equal(row.updated_at, 111);
    assert.deepEqual(repo.parseAutomodActionParams(row).params, { durationSeconds: 600 });
  });

  it("input validation returns {ok:false,error} — never throws, never writes", () => {
    const cid = freshCommunity();
    assert.match(repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, action: "inspect" })).error, /Unknown auto-mod action/);
    assert.match(repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, mode: "yolo" })).error, /Unknown auto-mod mode/);
    assert.match(repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, caseId: 0 })).error, /positive integer/);
    assert.match(repo.claimAutomodActionSlot(baseIntent({ communityId: cid, caseId: "x" })).error, /positive integer/);
    assert.throws(
      () => repo.insertAutomodActionSuggestion(baseIntent({ communityId: "not-a-number" })),
      /community id required/,
      "a junk community id is a programmer error (assertCommunityId posture)",
    );
  });

  it("the (community, case, action, subject) slot is UNIQUE — the second claim reads the existing row", () => {
    const cid = freshCommunity();
    const first = repo.claimAutomodActionSlot(baseIntent({ communityId: cid, claimant: "auto" }));
    assert.equal(first.ok, true, "the insert IS the claim: the row starts approved+claimed");
    assert.equal(first.row.state, "approved");
    assert.equal(first.row.claimed_by, "auto");
    assert.ok(Number.isInteger(first.row.claimed_at));

    const again = repo.claimAutomodActionSlot(baseIntent({ communityId: cid, claimant: "auto" }));
    assert.equal(again.ok, false);
    assert.equal(again.deduped, true);
    assert.equal(again.existing.id, first.row.id, "loser re-reads the WINNER's row");

    // Different subject / different action ⇒ different slots (both win).
    assert.equal(repo.claimAutomodActionSlot(baseIntent({ communityId: cid, subjectUserId: "u-other" })).ok, true);
    assert.equal(repo.claimAutomodActionSlot(baseIntent({ communityId: cid, action: "ban" })).ok, true);
  });

  it("suggestion + refusal inserts share the slot too — and rows WITHOUT a case skip it", () => {
    const cid = freshCommunity();
    const sug = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, mode: "suggest" }));
    assert.equal(sug.ok, true);
    const dup = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, mode: "suggest" }));
    assert.equal(dup.deduped, true);
    assert.equal(dup.existing.id, sug.row.id);

    const ref1 = repo.recordAutomodActionRefusal(baseIntent({ communityId: cid, action: "ban", mode: "off", error: "ban is off for this guild" }));
    assert.equal(ref1.row.state, "refused");
    assert.equal(ref1.row.error_text, "ban is off for this guild");

    // No case_id ⇒ the slot index does not apply; two refusals are two rows.
    const nc1 = repo.recordAutomodActionRefusal(baseIntent({ communityId: cid, caseId: null, action: "warn", mode: "off", error: "warn is off for this guild" }));
    const nc2 = repo.recordAutomodActionRefusal(baseIntent({ communityId: cid, caseId: null, action: "warn", mode: "off", error: "warn is off for this guild" }));
    assert.equal(nc1.ok, true);
    assert.equal(nc2.ok, true);
    assert.notEqual(nc1.row.id, nc2.row.id);
  });

  it("a foreign community id refuses with a specific error (FK, never a throw)", () => {
    const r = repo.insertAutomodActionSuggestion(baseIntent({ communityId: 999999 }));
    assert.equal(r.ok, false);
    assert.match(r.error, /Could not record the auto-mod action \(kick\)/);
  });
});

describe("automod case-action repo — claim / dismiss / finalize transitions", () => {
  it("claim flips suggested→approved exactly once; losers get the row back", () => {
    const cid = freshCommunity();
    const sug = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, mode: "suggest" }));
    const won = repo.claimAutomodSuggestion(sug.row.id, "staff-1", { nowMs: 222 });
    assert.equal(won.ok, true);
    assert.equal(won.row.state, "approved");
    assert.equal(won.row.claimed_by, "staff-1");
    assert.equal(won.row.claimed_at, 222);

    const lost = repo.claimAutomodSuggestion(sug.row.id, "staff-2", { nowMs: 333 });
    assert.equal(lost.ok, false);
    assert.equal(lost.deduped, true);
    assert.equal(lost.row.claimed_by, "staff-1", "the winner's claim survives");
    assert.equal(lost.row.claimed_at, 222);

    assert.match(repo.claimAutomodSuggestion(999999, "staff").error, /No auto-mod action row/);
    assert.match(repo.claimAutomodSuggestion("x", "staff").error, /positive integer/);
  });

  it("dismiss records the decline under the same single-winner gate", () => {
    const cid = freshCommunity();
    const sug = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, mode: "suggest" }));
    const gone = repo.dismissAutomodSuggestion(sug.row.id, "staff-9", { note: "false positive", nowMs: 444 });
    assert.equal(gone.ok, true);
    assert.equal(gone.row.state, "dismissed");
    assert.equal(gone.row.result_text, "false positive");
    assert.equal(gone.row.claimed_by, "staff-9");

    const again = repo.dismissAutomodSuggestion(sug.row.id, "staff-9b");
    assert.equal(again.deduped, true);
    assert.equal(again.row.state, "dismissed");
    assert.equal(again.row.result_text, "false positive", "second click changes nothing");

    // Dismiss AFTER claim: the claimer owns the row — dismiss loses.
    const other = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, action: "ban", mode: "suggest" }));
    repo.claimAutomodSuggestion(other.row.id, "staff-a");
    const refused = repo.dismissAutomodSuggestion(other.row.id, "staff-b");
    assert.equal(refused.deduped, true);
    assert.equal(refused.row.state, "approved");
  });

  it("default dismiss note + finalize rules", () => {
    const cid = freshCommunity();
    const sug = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, mode: "suggest" }));
    const gone = repo.dismissAutomodSuggestion(sug.row.id, "staff");
    assert.match(gone.row.result_text, /Dismissed by staff — the suggested action was not run\./);
  });

  it("finalize only exits a CLAIMED row; params merge per column", () => {
    const cid = freshCommunity();
    const sug = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, mode: "suggest" }));

    // Not claimed yet → no finalize (claim first, record second).
    const early = repo.recordAutomodActionResult(sug.row.id, { state: "executed", resultText: "x" });
    assert.equal(early.ok, false);
    assert.equal(early.deduped, true);
    assert.equal(early.row.state, "suggested");

    repo.claimAutomodSuggestion(sug.row.id, "staff-1");
    const done = repo.recordAutomodActionResult(
      sug.row.id,
      { state: "executed", resultText: "Kicked <@u-subject>.", params: { durationSeconds: 60, clamped: true } },
      { nowMs: 555 },
    );
    assert.equal(done.ok, true);
    assert.equal(done.row.state, "executed");
    assert.equal(done.row.result_text, "Kicked <@u-subject>.");
    assert.deepEqual(repo.parseAutomodActionParams(done.row).params, { durationSeconds: 60, clamped: true });
    assert.ok(done.row.updated_at >= 555);

    // Second finalize loses — the first outcome stands.
    const twice = repo.recordAutomodActionResult(sug.row.id, { state: "failed", errorText: "late" });
    assert.equal(twice.deduped, true);
    assert.equal(twice.row.state, "executed");
    assert.equal(twice.row.error_text, null);

    assert.match(repo.recordAutomodActionResult(sug.row.id, { state: "suggested" }).error, /Invalid auto-mod action outcome/);

    // error/params omitted ⇒ prior columns preserved (COALESCE posture).
    const other = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, action: "timeout", mode: "suggest" }));
    repo.claimAutomodSuggestion(other.row.id, "staff-1");
    repo.recordAutomodActionResult(other.row.id, { state: "refused", errorText: "guard said no" });
    const keep = repo.getAutomodAction(other.row.id);
    assert.equal(keep.error_text, "guard said no");
    assert.equal(keep.params_json, JSON.stringify({ reason: "repeat spam" }), "omitted params keep the recorded intent");
  });

  it("reads: by id, by slot, per-case list with optional state filter", () => {
    const cid = freshCommunity();
    const caseId = 777;
    const a = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, caseId, mode: "suggest" }));
    const b = repo.insertAutomodActionSuggestion(
      baseIntent({ communityId: cid, caseId, action: "ban", subjectUserId: "u-two", mode: "suggest" }),
    );
    assert.equal(repo.getAutomodAction(a.row.id).id, a.row.id);
    assert.equal(repo.getAutomodAction(0), null);
    assert.equal(repo.getAutomodAction("junk"), null);

    const bySlot = repo.getAutomodActionBySlot({ communityId: cid, caseId, subjectUserId: "u-subject", action: "kick" });
    assert.equal(bySlot.id, a.row.id);
    assert.equal(repo.getAutomodActionBySlot({ communityId: cid, caseId: null, subjectUserId: "u-subject", action: "kick" }), null);
    assert.equal(repo.getAutomodActionBySlot({ communityId: cid, caseId, subjectUserId: "u-subject", action: "nope" }), null);

    const all = repo.listAutomodActionsForCase(cid, caseId);
    assert.deepEqual(all.map((r) => r.id), [a.row.id, b.row.id], "insertion order, all states");
    assert.deepEqual(repo.listAutomodActionsForCase(cid, caseId, { state: "suggested" }).map((r) => r.id), [a.row.id, b.row.id]);
    assert.deepEqual(repo.listAutomodActionsForCase(cid, caseId, { state: "executed" }), []);
    assert.deepEqual(repo.listAutomodActionsForCase(cid, caseId, { state: "bogus" }), [], "unknown filter never leaks rows");
    assert.deepEqual(repo.listAutomodActionsForCase(cid, "junk"), []);
    // Other communities see nothing of this case.
    assert.deepEqual(repo.listAutomodActionsForCase(freshCommunity(), caseId), []);
  });

  it("parseAutomodActionParams: parses, tolerates garbage, null-safe", () => {
    const cid = freshCommunity();
    const r = repo.insertAutomodActionSuggestion(baseIntent({ communityId: cid, mode: "suggest" }));
    assert.deepEqual(repo.parseAutomodActionParams(r.row).params, { reason: "repeat spam" });
    assert.equal(repo.parseAutomodActionParams({ ...r.row, params_json: "{oops" }).params, null);
    assert.equal(repo.parseAutomodActionParams(null), null);
  });
});

describe("db facade surface for #730/#731 consumers", () => {
  it("exports the ledger primitives + the state constants", () => {
    for (const name of [
      "insertAutomodActionSuggestion",
      "claimAutomodActionSlot",
      "recordAutomodActionRefusal",
      "claimAutomodSuggestion",
      "dismissAutomodSuggestion",
      "recordAutomodActionResult",
      "getAutomodAction",
      "getAutomodActionBySlot",
      "listAutomodActionsForCase",
      "parseAutomodActionParams",
    ]) {
      assert.equal(typeof db[name], "function", `src/db must export ${name}`);
    }
    assert.deepEqual(
      [...db.AUTOMOD_ACTION_STATES],
      ["suggested", "approved", "dismissed", "executed", "refused", "failed"],
    );
    assert.deepEqual([...db.AUTOMOD_CONSIDERED_STATES], [...db.AUTOMOD_ACTION_STATES]);
  });
});
