const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

/**
 * #822 (audit r3, A2-9/C2-4): the post-#469 moderation-PII family joins the
 * erasure bus — automod_cases (+ case_actions riding the same knob),
 * ban_records, ban_appeals, ticket_reports. Laws pinned here:
 *  1. unset knobs = every row lives (opt-in, honest "disabled" skips —
 *     moderation data never vanishes silently);
 *  2. deletes are STATE-QUALIFIED: only terminal/settled/decided rows ever
 *     die — live queue, in-flight appeals, welcome-machine rows and the
 *     staff-owned quarantine states are outside the WHERE entirely;
 *  3. boundary law inherited from the suite: a row at EXACTLY the cutoff
 *     instant SURVIVES (strict `<`);
 *  4. the two ban knobs are order-independent: the records sweep refuses a
 *     settled ban whose appeal is still live (the CASCADE never shreds an
 *     in-flight appeal);
 *  5. primitives guard their inputs with typed throws (rule 6).
 *
 * CONTRACT: loadDb() runs before every `src/` require (private temp DB).
 */
const loaded = loadDb();
const api = loaded.api;

const { runRetentionSweeps } = require("../src/features/retention/sweeps");

const DAY = 24 * 60 * 60 * 1000;
/** Fixed sweep instant — boundaries are exact fake-clock arithmetic. */
const T = 1_791_000_000_000;

let cid;
const GUILD = "842200000000000001";

before(() => {
  cid = communityKey(GUILD);
});

after(() => loaded.cleanup());

const sql = (text) => api.db.prepare(text);
const count = (table) => sql(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

// ── raw seeders (explicit timestamps: boundaries must be EXACT) ────────────

function seedCase(status, updatedAt, overrides = {}) {
  const info = sql(
    `INSERT INTO automod_cases
       (community_id, case_number, referrer_user_id, note, status, created_at, updated_at)
     VALUES (?, ?, '842200000000000010', 'referral prose', ?, ?, ?)`
  ).run(
    cid,
    overrides.caseNumber ?? Math.floor(Math.random() * 1e9),
    status,
    updatedAt - DAY,
    updatedAt
  );
  return info.lastInsertRowid;
}

function seedAction(caseId, updatedAt, overrides = {}) {
  return sql(
    `INSERT INTO automod_case_actions
       (community_id, case_id, guild_id, subject_user_id, action, mode, state,
        result_text, created_at, updated_at)
     VALUES (?, ?, ?, '842200000000000011', 'warn', 'auto', 'executed',
             'did the thing', ?, ?)`
  ).run(
    cid,
    caseId,
    GUILD,
    updatedAt - DAY,
    updatedAt
  ).lastInsertRowid;
}

function seedBan(status, bannedAt, userId = "842200000000000021", overrides = {}) {
  return sql(
    `INSERT INTO ban_records
       (community_id, ban_number, user_id, moderator_id, source, reason,
        banned_at, status)
     VALUES (?, ?, ?, '842200000000000010', 'staff', 'do not do the thing', ?, ?)`
  ).run(
    cid,
    overrides.banNumber ?? Math.floor(Math.random() * 1e9),
    userId,
    bannedAt,
    status
  ).lastInsertRowid;
}

/** Appeal one ban (1:1 — ux_ban_appeals bans a second appeal per record),
 *  minting a SETTLED-BUT-RECENT parent by default so the appeals sweep runs
 *  independently of the records sweep (parent never qualifies: age < any
 *  window; and runs below pass banRecordsDays: null anyway). */
let appealSeq = 0;
function seedAppeal(banRecordId, status, updatedAt, parent = {}) {
  const parentId =
    banRecordId ??
    seedBan(parent.status ?? "expired_unbanned", parent.at ?? T - DAY,
      `84220000000000006${(appealSeq += 1)}`);
  return sql(
    `INSERT INTO ban_appeals
       (community_id, ban_record_id, status, appeal_statement,
        created_at, updated_at)
     VALUES (?, ?, ?, 'I am writing to appeal the ban, sincerely.', ?, ?)`
  ).run(
    cid,
    parentId,
    status,
    updatedAt - DAY,
    updatedAt
  ).lastInsertRowid;
}

function seedReport(createdAt, overrides = {}) {
  const tid = sql(
    `INSERT INTO tickets
       (community_id, ticket_number, creator_user_id, created_at, reason)
     VALUES (?, ?, '842200000000000031', ?, 'report intake')`
  ).run(
    cid,
    overrides.ticketNumber ?? Math.floor(Math.random() * 1e9),
    createdAt
  ).lastInsertRowid;
  sql(
    `INSERT INTO ticket_reports
       (ticket_id, kind, subject_user_id, reported_message_id, snapshot_note, created_at)
     VALUES (?, 'message', '842200000000000032', '700', 'snapshot prose', ?)`
  ).run(tid, createdAt);
  return tid;
}

const allFamily = () =>
  count("automod_case_actions") +
  count("automod_cases") +
  count("ban_appeals") +
  count("ban_records") +
  count("ticket_reports");

function clearFamily() {
  sql("DELETE FROM automod_case_actions").run();
  sql("DELETE FROM automod_cases").run();
  sql("DELETE FROM ban_appeals").run();
  sql("DELETE FROM ban_records").run();
  sql("DELETE FROM ticket_reports").run();
  sql("DELETE FROM tickets").run();
}

// ── 1. opt-in posture ───────────────────────────────────────────────────────

describe("#822: the family is opt-in — unset knobs never delete anything", () => {
  before(() => {
    clearFamily();
    // Rows PAST every possible window: terminal, settled, decided, ancient.
    const c = seedCase("complete", T - 4000 * DAY);
    seedAction(c, T - 4000 * DAY);
    const b = seedBan("expired_unbanned", T - 4000 * DAY);
    seedAppeal(b, "denied", T - 4000 * DAY);
    seedReport(T - 4000 * DAY);
    assert.ok(allFamily() >= 5);
  });

  it("every family table reports an honest 'disabled' skip and zero deletes", () => {
    const rows = runRetentionSweeps({ at: T, overrides: {} });
    for (const table of [
      "automod_case_actions",
      "automod_cases",
      "ban_appeals",
      "ban_records",
      "ticket_reports",
    ]) {
      const row = rows.find((r) => r.table === table);
      assert.ok(row, `${table} is swept`);
      assert.equal(row.skipped, "disabled", `${table} default-off`);
      assert.equal(row.deleted, 0);
    }
    assert.ok(allFamily() >= 5, "nothing vanished with knobs unset");
  });

  it("garbage knobs keep rows forever too (default is null: fail-closed)", () => {
    process.env.RETENTION_AUTOMOD_CASES_DAYS = "banana";
    process.env.RETENTION_BAN_RECORDS_DAYS = "-3";
    try {
      const rows = runRetentionSweeps({ at: T });
      for (const table of ["automod_cases", "ban_records"]) {
        assert.equal(rows.find((r) => r.table === table).skipped, "disabled");
      }
      assert.ok(allFamily() >= 5);
    } finally {
      delete process.env.RETENTION_AUTOMOD_CASES_DAYS;
      delete process.env.RETENTION_BAN_RECORDS_DAYS;
    }
  });
});

// ── 2. automod cases + actions ──────────────────────────────────────────────

describe("#822: automod_cases + case_actions (one knob, terminal-only)", () => {
  before(clearFamily);

  it("terminal cases + their actions die past the window; the live queue cannot", () => {
    const gone = seedCase("complete", T - 400 * DAY);
    const goneAction = seedAction(gone, T - 400 * DAY);
    const boundary = seedCase("failed", T - 365 * DAY); // EXACTLY at cutoff
    const boundaryAction = seedAction(boundary, T - 365 * DAY);
    const liveQueue = seedCase("recorded", T - 4000 * DAY); // ancient but live
    const processing = seedCase("processing", T - 4000 * DAY);
    const recentTerminal = seedCase("complete", T - 10 * DAY);
    const liveActionOnOldCase = seedAction(
      seedCase("complete", T - 400 * DAY),
      T - 10 * DAY // recently claimed on an old terminal case
    );

    const rows = runRetentionSweeps({
      at: T,
      overrides: { automodCasesDays: 365 },
    });
    const caseRow = rows.find((r) => r.table === "automod_cases");
    const actionRow = rows.find((r) => r.table === "automod_case_actions");
    assert.equal(caseRow.deleted, 2, "both terminal cases past the window (the recently-claimed action's parent is one of them)");
    assert.ok(sql("SELECT 1 FROM automod_cases WHERE id=?").get(boundary),
      "a case at EXACTLY the cutoff survives (strict <)");
    for (const id of [liveQueue, processing, recentTerminal, boundary]) {
      assert.ok(sql("SELECT 1 FROM automod_cases WHERE id=?").get(id), `case ${id} lives`);
    }
    assert.equal(actionRow.deleted, 1, "only the action whose case + row both aged out");
    assert.equal(sql("SELECT 1 FROM automod_case_actions WHERE id=?").get(goneAction), undefined,
      "the old action died with its terminal case");
    assert.ok(sql("SELECT 1 FROM automod_case_actions WHERE id=?").get(boundaryAction),
      "an action at EXACTLY the cutoff survives too");
    assert.ok(sql("SELECT 1 FROM automod_case_actions WHERE id=?").get(liveActionOnOldCase),
      "a recently-touched action survives even on an old terminal case");
  });

  it("actions orphaned by the case sweep die; NULL-case rows are never claimed", () => {
    clearFamily();
    const doomed = seedCase("failed", T - 400 * DAY);
    seedAction(doomed, T - 400 * DAY);
    const nullCase = seedAction(null, T - 400 * DAY); // dedupe-slot exception

    const rows = runRetentionSweeps({
      at: T,
      overrides: { automodCasesDays: 365 },
    });
    // spec order: actions BEFORE cases — the terminal-case arm catches both
    // while the parent still exists; assert the family is left clean of the
    // doomed pair but the NULL-case row stands.
    assert.ok(rows.find((r) => r.table === "automod_cases").deleted >= 1);
    assert.equal(
      sql("SELECT COUNT(*) c FROM automod_case_actions WHERE case_id IS NOT NULL").get().c,
      0,
      "terminal-case actions all swept (now-orphan rows included)"
    );
    assert.ok(sql("SELECT 1 FROM automod_case_actions WHERE id=?").get(nullCase),
      "NULL-case rows are outside this sweep's reachability claim");

    // And an action whose case row is GONE at sweep time (case pre-deleted):
    sql("DELETE FROM automod_cases").run();
    const orphan = seedAction(
      // a case id that does not exist: pre-seed then delete the parent
      (() => {
        const c = seedCase("recorded", T);
        sql("DELETE FROM automod_cases WHERE id=?").run(c);
        return c;
      })(),
      T - 400 * DAY
    );
    const rows2 = runRetentionSweeps({
      at: T,
      overrides: { automodCasesDays: 365 },
    });
    assert.equal(rows2.find((r) => r.table === "automod_case_actions").deleted, 1,
      "the orphan arm prunes actions whose case row is gone");
    assert.equal(sql("SELECT 1 FROM automod_case_actions WHERE id=?").get(orphan), undefined);
  });
});

// ── 3. bans + appeals: two knobs, no ordering hazard ────────────────────────

describe("#822: ban_records + ban_appeals (settled-only, live-appeal guard)", () => {
  before(clearFamily);

  it("settled bans die; live/quarantine/welcome rows and live-appeal bans cannot", () => {
    const expired = seedBan("expired_unbanned", T - 3000 * DAY, "842200000000000041");
    const manual = seedBan("unbanned_manual", T - 3000 * DAY, "842200000000000042");
    const clemency = seedBan("clemency_granted", T - 3000 * DAY, "842200000000000043");
    const boundary = seedBan("expired_unbanned", T - 2555 * DAY, "842200000000000044"); // exact
    const active = seedBan("active", T - 4000 * DAY, "842200000000000045");
    const welcome = seedBan("pending_rejoin", T - 4000 * DAY, "842200000000000046");
    const welcomed = seedBan("welcomed", T - 4000 * DAY, "842200000000000047");
    const held = seedBan("expired_held", T - 4000 * DAY, "842200000000000048");
    const quarantined = seedBan("expiry_failed", T - 4000 * DAY, "842200000000000049");
    // The guard: settled + ancient, but a staffer is mid-appeal on it.
    const guarded = seedBan("unbanned_manual", T - 3000 * DAY, "842200000000000050");
    seedAppeal(guarded, "open", T - DAY);

    const rows = runRetentionSweeps({
      at: T,
      overrides: { banRecordsDays: 2555, banAppealsDays: null },
    });
    const banRow = rows.find((r) => r.table === "ban_records");
    assert.equal(banRow.deleted, 3, "expired_unbanned + unbanned_manual + clemency_granted");

    for (const id of [active, welcome, welcomed, held, quarantined, guarded, boundary]) {
      assert.ok(sql("SELECT 1 FROM ban_records WHERE id=?").get(id), `ban ${id} lives`);
    }
    for (const id of [expired, manual, clemency]) {
      assert.equal(sql("SELECT 1 FROM ban_records WHERE id=?").get(id), undefined);
    }
  });

  it("decided appeals die on their own knob; filed/open never; order is safe", () => {
    clearFamily();
    // 1:1 law: every appeal rides its own parent ban (#773 appeal:<banId>).
    const denied = seedAppeal(null, "denied", T - 800 * DAY);
    const closed = seedAppeal(null, "closed", T - 800 * DAY);
    const boundary = seedAppeal(null, "granted", T - 730 * DAY); // exact cutoff
    const filed = seedAppeal(null, "filed", T - 4000 * DAY);
    const open = seedAppeal(null, "open", T - 4000 * DAY);
    const recent = seedAppeal(null, "denied", T - 5 * DAY);

    const rows = runRetentionSweeps({
      at: T,
      overrides: { banAppealsDays: 730, banRecordsDays: null },
    });
    const appealRow = rows.find((r) => r.table === "ban_appeals");
    assert.equal(appealRow.deleted, 2, "denied + closed; the exact-cutoff row survives");

    for (const id of [boundary, filed, open, recent]) {
      assert.ok(sql("SELECT 1 FROM ban_appeals WHERE id=?").get(id), `appeal ${id} lives`);
    }
    for (const id of [denied, closed]) {
      assert.equal(sql("SELECT 1 FROM ban_appeals WHERE id=?").get(id), undefined);
    }

    // CASCADE safety across knobs: sweep BOTH with the records window LONGER
    // — the open appeal keeps its (settled, old) parent alive; the granted
    // sibling (decided, young) also survives its own window.
    const settledOld = seedBan("expired_unbanned", T - 3000 * DAY, "842200000000000052");
    seedAppeal(settledOld, "filed", T - DAY);
    const rows2 = runRetentionSweeps({
      at: T,
      overrides: { banAppealsDays: 730, banRecordsDays: 2555 },
    });
    assert.ok(
      sql("SELECT 1 FROM ban_records WHERE id=?").get(settledOld),
      "the records sweep refuses to cascade-shred a settled ban with a live appeal"
    );
    assert.equal(rows2.find((r) => r.table === "ban_records").deleted, 0);
  });
});

// ── 4. ticket reports: the dormant CASCADE gets a real erasure path ─────────

describe("#822: ticket_reports die by age on their own opt-in knob", () => {
  before(clearFamily);

  it("old snapshots die, recent + exact-boundary live", () => {
    seedReport(T - 800 * DAY);
    seedReport(T - 730 * DAY); // exact cutoff
    seedReport(T - 10 * DAY);

    const rows = runRetentionSweeps({
      at: T,
      overrides: { ticketReportsDays: 730 },
    });
    assert.equal(rows.find((r) => r.table === "ticket_reports").deleted, 1);
    assert.equal(count("ticket_reports"), 2);
  });
});

// ── 5. primitive input guards (rule 6) ──────────────────────────────────────

describe("#822: primitives reject garbage loudly (typed throws)", () => {
  const primitives = [
    "deleteTerminalAutomodCasesOlderThan",
    "deleteAutomodCaseActionsOlderThan",
    "deleteSettledBanRecordsOlderThan",
    "deleteSettledBanAppealsOlderThan",
    "deleteTicketReportsOlderThan",
  ];
  for (const name of primitives) {
    it(`${name}: non-integer cutoff and zero limit throw TypeError`, () => {
      assert.throws(() => api[name]("yesterday", 10), TypeError);
      assert.throws(() => api[name](T, 0), TypeError);
      assert.throws(() => api[name](T, 1.5), TypeError);
    });
  }
});
