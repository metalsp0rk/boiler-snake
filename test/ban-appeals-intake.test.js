/**
 * #773 §1/§2 + locked decision 6: ban-appeals INTAKE unit suite
 * (test/ban-appeals-intake.test.js).
 *
 * Two layers under test, one file (the decision-core law that later tasks
 * match on is the INTAKE_CODES/FILING_CODES enums, so they are pinned here):
 *
 *  validateAppealPress / validateModalSubmission — the full stale/forged-press
 *  matrix (presser ≠ record user, record gone/closed, appeals off, forged
 *  cross-community id answered as NO_RECORD, ALREADY_FILED carrying the LIVE
 *  row, DB_ERROR carrying the SPECIFIC cause). Validator reads are injected
 *  doubles; the refusal copy is asserted VERBATIM against the constants.js
 *  builders (decision 6: named refusals, never a generic drop). Battery
 *  ORDER is pinned by precedence tests (identity before status before gate).
 *
 *  handleAppealModalSubmit — the one filing pipeline. The validator battery
 *  RE-RUNS on submit (record closed / appeals flipped between press and
 *  submit → refusal with ZERO filing, proven against real rows); the UNIQUE
 *  belt race answers ALREADY_FILED with the live status; a ticket failure
 *  proves #730 (row stays `filed` with NULL ticket — never claimed filed);
 *  post-filing DM/edit-away failures are logged-with-ids and never un-file.
 *
 * Storage law: the real temp-DB repositories seed ban_records/ban_appeals and
 * the real recordSlashAudit lands the filing rows (asserted via
 * db.listAdminAudit — the ban-lifecycle-commands idiom). Every `[appeals]`
 * console line this module owns is captured and asserted to carry ids.
 *
 * Header contract: loadDb() ABOVE every src/ require.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

const intake = require("../src/features/banAppeals/intake");
const {
  LOG_PREFIX,
  INTAKE_CODES,
  FILING_CODES,
  CODE_OK,
  CODE_NOT_YOU,
  CODE_NO_RECORD,
  CODE_NOT_ACTIVE,
  CODE_APPEALS_OFF,
  CODE_ALREADY_FILED,
  CODE_DB_ERROR,
  CODE_MISSING_STATEMENT,
  CODE_STATEMENT_TOO_LONG,
  AUDIT_ACTION_FILE,
  validateAppealPress,
  validateModalSubmission,
  buildAppealModal,
  handleAppealModalSubmit,
  buildFilingConfirmationDm,
  buildAppealDmEditContent,
  buildFiledBanDmLine,
  refusalTicketFailed,
} = intake;
const {
  APPEAL_MODAL_TITLE,
  MODAL_FIELD_STATEMENT,
  MODAL_LABEL_STATEMENT,
  parseAppealPressRecordId,
  parseModalAppealRecordId,
  parseTicketAppealId,
  AP_CLEMENCY_PREFIX,
  AP_DENY_PREFIX,
  AP_DENY_MODAL_PREFIX,
  refusalNotYou,
  refusalNoRecord,
  refusalNotActive,
  refusalAppealsOff,
  refusalAlreadyFiled,
  refusalMissingStatement,
  refusalStatementTooLong,
} = require("../src/features/banAppeals/constants");

after(() => cleanup());

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const DAY = 86_400_000;
const BANNED = "878300000000000013";
const PRESSER_OTHER = "878300000000000066";
const MOD = "878300000000000012";

let seq = 0;
const freshCid = () =>
  communityKey(`9783000000000${String(++seq).padStart(4, "0")}`);

/** Plain ban_records-shaped row double for the pure validator battery. */
function makeRecord(cid, overrides = {}) {
  return {
    id: 41,
    community_id: cid,
    user_id: BANNED,
    moderator_id: MOD,
    source: "staff",
    reason: "raid",
    ban_number: 1,
    banned_at: NOW - DAY,
    expires_at: null,
    status: "active",
    ...overrides,
  };
}

/**
 * Injectable validator world. Every read is recorded; `throwOn` arms the
 * DB_ERROR belts. No SQLite ever opens inside the battery itself.
 */
function world({
  record,
  appeal = null,
  gate = { ok: true, enabled: true },
  throwOn = null,
  cap = 120,
} = {}) {
  const cid = record?.community_id ?? 1;
  const reads = { records: [], appeals: [], gates: [] };
  const deps = {
    getBanRecord: (id) => {
      reads.records.push(id);
      if (throwOn === "record") throw new Error("record table on fire");
      return record && String(record.id) === String(id) ? record : null;
    },
    getAppealByBanRecord: (communityId, banRecordId) => {
      reads.appeals.push([communityId, banRecordId]);
      if (throwOn === "appeal") throw new Error("appeal index corrupted");
      return appeal;
    },
    appealsGate: (communityId) => {
      reads.gates.push(communityId);
      if (throwOn === "gate") throw new Error("settings read exploded");
      return gate;
    },
    maxStatementLength: cap,
    now: () => NOW,
  };
  return { deps, reads };
}

const press = (world_, over = {}) =>
  validateAppealPress({
    banRecordId: 41,
    pressingUserId: BANNED,
    ...over,
    deps: over.deps ?? world_.deps,
  });

const submit = (world_, over = {}) =>
  validateModalSubmission({
    banRecordId: 41,
    pressingUserId: BANNED,
    statement: "I was elsewhere that night.",
    ...over,
    deps: over.deps ?? world_.deps,
  });

// ═══ decision-code enum (single source later tasks match on) ════════════════

test("INTAKE_CODES is the frozen decision vocabulary incl. DB_ERROR", () => {
  assert.deepEqual(
    { ...INTAKE_CODES },
    {
      OK: "OK",
      NOT_YOU: "NOT_YOU",
      NO_RECORD: "NO_RECORD",
      NOT_ACTIVE: "NOT_ACTIVE",
      APPEALS_OFF: "APPEALS_OFF",
      ALREADY_FILED: "ALREADY_FILED",
      DB_ERROR: "DB_ERROR",
      MISSING_STATEMENT: "MISSING_STATEMENT",
      STATEMENT_TOO_LONG: "STATEMENT_TOO_LONG",
    },
  );
  assert.ok(Object.isFrozen(INTAKE_CODES));
  assert.deepEqual({ ...FILING_CODES }, {
    FILED: "FILED",
    FILE_FAILED: "FILE_FAILED",
    TICKET_FAILED: "TICKET_FAILED",
    INTERNAL: "INTERNAL",
  });
  assert.equal(intake.LOG_PREFIX, "[appeals]", "one grep for the whole feature");
  assert.equal(intake.handleModalSubmission, handleAppealModalSubmit,
    "instruction-compat alias is THE SAME pipeline");
});

// ═══ customId parsers — modal-vs-press disambiguation ═══════════════════════

test("parsers: `appeal:s:` never parses as a press; families reject embedded colons", () => {
  assert.equal(parseAppealPressRecordId("appeal:41"), "41");
  assert.equal(parseAppealPressRecordId("appeal:s:41"), null,
    "a modal customId MUST NOT answer as a button press");
  assert.equal(parseAppealPressRecordId("appeal:"), null);
  assert.equal(parseAppealPressRecordId("appeal:4x"), null);
  assert.equal(parseAppealPressRecordId("bl:ban:x"), null);
  assert.equal(parseAppealPressRecordId(undefined), null);

  assert.equal(parseModalAppealRecordId("appeal:s:41"), "41");
  assert.equal(parseModalAppealRecordId("appeal:41"), null);
  assert.equal(parseModalAppealRecordId("appeal:s:"), null);

  assert.equal(parseTicketAppealId("ap:clemency:9", AP_CLEMENCY_PREFIX), "9");
  assert.equal(parseTicketAppealId("ap:deny:m:9", AP_DENY_PREFIX), null,
    "the deny PRESS parse rejects the modal twin's embedded colon");
  assert.equal(parseTicketAppealId("ap:deny:m:9", AP_DENY_MODAL_PREFIX), "9");
  assert.equal(parseTicketAppealId("ap:pause:x", "ap:pause:"), null);
});

// ═══ press battery — the stale/forged-press matrix (decision 6) ═════════════

test("press OK: everything needed for filing rides the result; gate reads the RECORD's community", () => {
  const record = makeRecord(7);
  const w = world({ record });
  const res = press(w);
  assert.equal(res.ok, true);
  assert.equal(res.code, CODE_OK);
  assert.equal(res.communityId, 7, "community resolves THROUGH the row (guildless presser)");
  assert.equal(res.banRecordId, 41, "the id is coerced to a number");
  assert.equal(res.record, record);
  assert.deepEqual(w.reads.gates, [7], "the gate is asked on the record's community");
  assert.deepEqual(w.reads.appeals, [[7, 41]]);
});

test("press with a garbage / unsafe id is NO_RECORD — even before identity", () => {
  const w = world({ record: makeRecord(7) });
  for (const bad of ["", "abc", "0", "-5", "1.5", "1e24", 1e24, 0, -2, null, undefined]) {
    const res = press(w, { banRecordId: bad });
    assert.equal(res.code, CODE_NO_RECORD, `id ${String(bad)}`);
    assert.equal(res.error, refusalNoRecord());
  }
  assert.deepEqual(w.reads.records, [], "a shape-garbage id never reaches a read");
});

test("press carrying no identity is NOT_YOU (a nameless press is never OK)", () => {
  const w = world({ record: makeRecord(7) });
  for (const who of [null, undefined, "", "   "]) {
    const res = press(w, { pressingUserId: who });
    assert.equal(res.code, CODE_NOT_YOU, `presser ${String(who)}`);
    assert.equal(res.error, refusalNotYou());
  }
});

test("presser ≠ the record's banned member → NOT_YOU with the specific refusal + ids for the log", () => {
  const record = makeRecord(7);
  const w = world({ record });
  const res = press(w, { pressingUserId: PRESSER_OTHER });
  assert.equal(res.code, CODE_NOT_YOU);
  assert.equal(res.error, refusalNotYou());
  assert.match(res.error, /belongs to a different member's ban/);
  assert.match(res.error, /Nothing was filed\.$/);
  assert.equal(res.record, record, "the caller's [appeals] log line carries the record ids");
  assert.equal(res.communityId, 7);
  assert.equal(res.banRecordId, 41);
});

test("record gone (deleted or never tracked by #772) → NO_RECORD naming the untracked-lane truth", () => {
  const w = world({ record: makeRecord(7) });
  const res = press(w, { banRecordId: 999 });
  assert.equal(res.code, CODE_NO_RECORD);
  assert.equal(res.error, refusalNoRecord());
  assert.match(res.error, /outside the bot/, "honeypot/external bans name their no-appeal lane");
  assert.match(res.error, /Nothing was filed\.$/);
});

test("cross-community FORGED id reads NO_RECORD — byte-identical to gone, leaks nothing", () => {
  const record = makeRecord(7);
  const w = world({ record });
  const res = press(w, { communityId: 8 });
  assert.equal(res.code, CODE_NO_RECORD);
  assert.equal(res.error, refusalNoRecord(), "a probe cannot learn the other community's row exists");
  assert.deepEqual(Object.keys(res).sort(), ["code", "error", "ok"],
    "no record/community ids ride a forgery refusal");
  // A claim EQUAL to the record's community is NOT a forgery:
  const ok = press(w, { communityId: "7" });
  assert.equal(ok.ok, true, "the community claim is read tolerantly (numeric string rides)");
});

test("record closed (lifted/expired/decided) → NOT_ACTIVE naming the closed window", () => {
  for (const status of ["expired_unbanned", "unbanned_manual", "clemency_granted", "welcomed"]) {
    const w = world({ record: makeRecord(7, { status }) });
    const res = press(w);
    assert.equal(res.code, CODE_NOT_ACTIVE, status);
    assert.equal(res.error, refusalNotActive());
    assert.match(res.error, /appeal window is closed/);
    assert.equal(res.record.user_id, BANNED, "ids ride for the caller's log");
  }
});

test("appeals OFF (per-guild toggle) → APPEALS_OFF teaching the admin the fix command", () => {
  const w = world({ record: makeRecord(7), gate: { ok: true, enabled: false } });
  const res = press(w);
  assert.equal(res.code, CODE_APPEALS_OFF);
  assert.equal(res.error, refusalAppealsOff());
  assert.match(res.error, /`\/banappeals enable`/);
  assert.match(res.error, /Nothing was filed\.$/);
});

test("second press after filing → ALREADY_FILED carrying the LIVE appeal row; status keys the copy", () => {
  const live = { id: 5, status: "open", ticket_channel_id: "500" };
  const w = world({ record: makeRecord(7), appeal: live });
  const res = press(w);
  assert.equal(res.code, CODE_ALREADY_FILED);
  assert.equal(res.appeal, live, "the live row rides so the copy + caller key on the real status");
  assert.equal(res.error, refusalAlreadyFiled("open"));
  assert.match(res.error, /already exists and staff can see it/);

  for (const [status, fragment] of [
    ["granted", /already \*\*granted\*\*/],
    ["denied", /already \*\*denied\*\*/],
    ["closed", /ended this ban's appeal conversation/],
    ["filed", /already exists and staff can see it/],
  ]) {
    const r = press(world({ record: makeRecord(7), appeal: { id: 5, status } }));
    assert.equal(r.code, CODE_ALREADY_FILED, status);
    assert.match(r.error, fragment, status);
    assert.match(r.error, /Nothing was filed\.$/);
  }
});

test("a storage read that THROWS → DB_ERROR quoting the specific cause per read site (rule 3)", () => {
  const rec = press(world({ record: makeRecord(7), throwOn: "record" }));
  assert.equal(rec.code, CODE_DB_ERROR);
  assert.match(rec.error, /ban record lookup/);
  assert.match(rec.error, /record table on fire/, "the CAUSE is user-facing, never 'check logs'");
  assert.match(rec.error, /Nothing was filed\.$/);

  const gate = press(world({ record: makeRecord(7), throwOn: "gate" }));
  assert.equal(gate.code, CODE_DB_ERROR);
  assert.match(gate.error, /appeals setting read/);
  assert.match(gate.error, /settings read exploded/);

  const appeal = press(world({ record: makeRecord(7), throwOn: "appeal" }));
  assert.equal(appeal.code, CODE_DB_ERROR);
  assert.match(appeal.error, /existing appeal lookup/);
  assert.match(appeal.error, /appeal index corrupted/);

  // A gate that answers {ok:false} (settings-service failure) also DB_ERRORs
  // with the service's specific sentence:
  const off = press(world({
    record: makeRecord(7),
    gate: { ok: false, error: "guild row missing" },
  }));
  assert.equal(off.code, CODE_DB_ERROR);
  assert.match(off.error, /guild row missing/);
});

test("battery PRECEDENCE: identity → active → gate → already-filed (each names its own refusal)", () => {
  const record = makeRecord(7, { status: "expired_unbanned" });
  const wrong = press(world({
    record,
    gate: { ok: true, enabled: false },
    appeal: { id: 9, status: "open" },
  }), { pressingUserId: PRESSER_OTHER });
  assert.equal(wrong.code, CODE_NOT_YOU, "identity is checked before any state read matters");

  const closed = press(world({
    record,
    gate: { ok: true, enabled: false },
    appeal: { id: 9, status: "open" },
  }));
  assert.equal(closed.code, CODE_NOT_ACTIVE, "a closed ban outranks the toggle");

  const off = press(world({
    record: makeRecord(7),
    gate: { ok: true, enabled: false },
    appeal: { id: 9, status: "open" },
  }));
  assert.equal(off.code, CODE_APPEALS_OFF, "the gate outranks the filed read");
});

test("EVERY intake refusal is specific: ends 'Nothing was filed.', zero generic fallback strings", () => {
  const cases = [
    press(world({ record: makeRecord(7) }), { banRecordId: "junk" }), // NO_RECORD
    press(world({ record: makeRecord(7) }), { pressingUserId: null }), // NOT_YOU
    press(world({ record: makeRecord(7, { status: "welcomed" }) })), // NOT_ACTIVE
    press(world({ record: makeRecord(7), gate: { ok: true, enabled: false } })), // APPEALS_OFF
    press(world({ record: makeRecord(7), appeal: { id: 1, status: "granted" } })), // ALREADY_FILED
    press(world({ record: makeRecord(7), throwOn: "record" })), // DB_ERROR
    submit(world({ record: makeRecord(7) }), { statement: "   " }), // MISSING_STATEMENT
    submit(world({ record: makeRecord(7), cap: 3 }), { statement: "far too long" }), // TOO_LONG
  ];
  for (const res of cases) {
    assert.equal(res.ok, false, JSON.stringify(res.code));
    assert.match(res.error, /nothing was filed\.$/i, res.error);
    assert.doesNotMatch(res.error, /check logs|unknown error|something (went|failed)|try again later/i,
      `sanctioned generics are never invented: ${res.error}`);
  }
});

// ═══ modal-submit battery: statement rules + full battery RE-RUN ═════════════

test("statement is REQUIRED: blank/whitespace/newline-only refuse naming the field label", () => {
  for (const junk of ["", "   ", "\n\t ", null, undefined]) {
    const res = submit(world({ record: makeRecord(7) }), { statement: junk });
    assert.equal(res.code, CODE_MISSING_STATEMENT, JSON.stringify(junk));
    assert.equal(res.error, refusalMissingStatement());
    assert.match(res.error, new RegExp(`\\*\\*${MODAL_LABEL_STATEMENT}:\\*\\* is required`));
  }
});

test("statement rides VERBATIM (tolerant edge-trim only); newlines survive", () => {
  const res = submit(world({ record: makeRecord(7) }), {
    statement: "  I was elsewhere.\n  Ask my sister!  ",
  });
  assert.equal(res.ok, true);
  assert.equal(res.statement, "I was elsewhere.\n  Ask my sister!");
  assert.equal(res.nowMs, NOW, "the injected clock stamps the filing");
  assert.equal(res.code, CODE_OK);
});

test("statement cap refusal NAMES the cap (injected seam + the repository's real 4000)", () => {
  const small = submit(world({ record: makeRecord(7), cap: 10 }), {
    statement: "x".repeat(11),
  });
  assert.equal(small.code, CODE_STATEMENT_TOO_LONG);
  assert.equal(small.error, refusalStatementTooLong(10));
  assert.match(small.error, /\*\*Appeal statement:\*\* is too long \(max 10 characters\)/);

  // Un-injected cap resolves to the repository's truth (single source):
  const w = world({ record: makeRecord(7) });
  delete w.deps.maxStatementLength;
  assert.equal(db.MAX_APPEAL_STATEMENT, 4000);
  assert.equal(submit(w, { statement: "x".repeat(4000) }).ok, true, "exactly at the cap passes");
  const over = submit(w, { statement: "x".repeat(4001) });
  assert.equal(over.code, CODE_STATEMENT_TOO_LONG);
  assert.match(over.error, /max 4000 characters/);
});

test("the submit battery RE-RUNS the whole press battery first (gate flipped between press and submit)", () => {
  const w = world({ record: makeRecord(7) });
  assert.equal(submit(w).ok, true);
  w.deps.appealsGate = () => ({ ok: true, enabled: false }); // admin disabled mid-form
  const res = submit(w);
  assert.equal(res.code, CODE_APPEALS_OFF, "the durable-id modal has no token store — the DATABASE re-read is the one-shot");
});

// ═══ the statement modal ═════════════════════════════════════════════════════

test("buildAppealModal: durable `appeal:s:<recordId>` customId, required paragraph capped at the repository truth", () => {
  const json = buildAppealModal(42).toJSON();
  assert.equal(json.custom_id, "appeal:s:42");
  assert.equal(json.title, APPEAL_MODAL_TITLE);
  const field = json.components[0].components[0];
  assert.equal(field.custom_id, MODAL_FIELD_STATEMENT);
  assert.equal(field.style, 2, "Paragraph");
  assert.equal(field.required, true, "issue §1: statement is required");
  assert.equal(field.max_length, db.MAX_APPEAL_STATEMENT);
  assert.match(field.label, /required$/);

  const over = buildAppealModal(7, { maxChars: 250 }).toJSON();
  assert.equal(over.components[0].components[0].max_length, 250);
});

// ═══ filing pipeline: handleAppealModalSubmit (real storage, injected edges) ══

const PIPE_STATEMENT = "I was elsewhere that night — ask my sister.";

function seedBan(cid, overrides = {}) {
  const { userId = BANNED, status, moderatorId = MOD, reason = "raid" } = overrides;
  const res = db.createBanRecord({
    communityId: cid,
    userId,
    moderatorId,
    source: "staff",
    reason,
    bannedAt: NOW - DAY,
    expiresAt: null,
  });
  assert.equal(res.ok, true, res.error);
  if (status && status !== "active") {
    db.db.prepare("UPDATE ban_records SET status=? WHERE id=?").run(status, res.record.id);
    return db.getBanRecord(res.record.id);
  }
  return res.record;
}

function seedAppeal(cid, record, statement = "pre-existing") {
  const res = db.fileAppeal({
    communityId: cid,
    banRecordId: record.id,
    appealStatement: statement,
    createdAt: NOW,
  });
  assert.equal(res.ok, true, res.error);
  return res.appeal;
}

const appealRows = (recordId) =>
  db.db.prepare("SELECT * FROM ban_appeals WHERE ban_record_id=?").all(recordId);

/** Recording fileAppeal delegating to the REAL repository (zero-filing proofs). */
function realFile() {
  const calls = [];
  return {
    calls,
    fn: (p) => {
      calls.push(p);
      return db.fileAppeal(p);
    },
  };
}

/** openAppealTicket double. outcome(): decision override per test. */
function ticketDouble(outcome) {
  const calls = [];
  return {
    calls,
    fn: async (p) => {
      calls.push(p);
      return typeof outcome === "function" ? outcome(p) : outcome;
    },
  };
}

function makeBanDm(content = "You have been banned from **Test Guild**.") {
  const edits = [];
  const message = {
    content,
    // closure over the wrapper's `edits` (NOT `this.edits` — the pipeline
    // calls message.edit() and `this` is the message, which has no ledger):
    edit: async (payload) => {
      edits.push(payload);
      return message;
    },
  };
  return { edits, message };
}

function makeModal({ statement = PIPE_STATEMENT, customId, userId = BANNED, message = null }) {
  return {
    customId: customId ?? "appeal:s:0",
    user: { id: userId },
    message,
    fields: { getTextInputValue: () => statement },
    client: null,
  };
}

/** Captures this module's own console output while fn runs. */
async function withCapturedLogs(fn) {
  const lines = [];
  const origErr = console.error;
  const origWarn = console.warn;
  const cap = (level) => (...a) =>
    lines.push(`${level} ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")}`);
  console.error = cap("error");
  console.warn = cap("warn");
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = origErr;
    console.warn = origWarn;
  }
}

test("FILED end-to-end: real fileAppeal row, ticket opened, ONE audit row (status from the LIVE ticket result), §3 confirmation DM, button edited away", async () => {
  const cid = freshCid();
  const record = seedBan(cid);
  const file = realFile();
  const ticket = ticketDouble(() => ({
    ok: true,
    appeal: { id: null, status: "open" },
    ticket: { id: 77, ticket_number: 7 },
    channel: { id: "5551", name: "appeal-B1" },
    channelOfRecordId: "5551",
  }));
  const dmSent = [];
  const dm = makeBanDm();
  const guild = { id: "GUILD-SENTINEL" };
  const modal = makeModal({ customId: `appeal:s:${record.id}`, message: dm.message });
  const client = { user: { id: "778300000000000099" } };

  const { result, lines } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: modal,
      client,
      deps: {
        maxStatementLength: 200,
        now: () => NOW,
        fileAppeal: file.fn,
        openAppealTicket: ticket.fn,
        guild,
        sendDm: async (userId, payload) => {
          dmSent.push({ userId, payload });
          return { ok: true };
        },
      },
    }),
  );

  assert.equal(lines.length, 0, `a clean filing logs nothing: ${lines.join(" | ")}`);
  assert.equal(result.ok, true);
  assert.equal(result.code, FILING_CODES.FILED);
  assert.equal(result.communityId, cid);
  assert.equal(result.banRecordId, record.id, "the record id parsed from the MODAL customId");
  assert.equal(result.userId, BANNED);
  assert.equal(result.ticketChannelId, "5551");
  assert.equal(result.dmDelivered, true);
  assert.equal(result.banDmEdited, true);

  // Filing wrote the real row, statement VERBATIM (already trimmed by the battery):
  assert.equal(file.calls.length, 1, "exactly ONE fileAppeal per accepted submit");
  assert.equal(file.calls[0].appealStatement, PIPE_STATEMENT);
  assert.equal(file.calls[0].createdAt, NOW, "the injected clock stored the row");
  const [row] = appealRows(record.id);
  assert.equal(row.status, "filed", "intake's own write is the pending truth (ticket.js flips it)");
  assert.equal(row.appeal_statement, PIPE_STATEMENT);

  // ticket.js received everything the ticket needs:
  assert.equal(ticket.calls.length, 1);
  const t0 = ticket.calls[0];
  assert.equal(t0.appeal.id, row.id);
  assert.equal(t0.banRecord.id, record.id);
  assert.equal(t0.communityId, cid);
  assert.equal(t0.statement, PIPE_STATEMENT);
  assert.equal(t0.guild, guild, "deps.guild rides through untouched");
  assert.equal(t0.client, client);

  // §5 audit row — real recordSlashAudit, truthful state (status 'open' from the live ticket row):
  const audits = db.listAdminAudit(cid, { limit: 25 });
  assert.equal(audits.length, 1, "ONE audit row per filing");
  assert.equal(audits[0].action, AUDIT_ACTION_FILE);
  assert.equal(audits[0].action, "banAppeals.file");
  assert.equal(audits[0].origin, "slash");
  assert.equal(audits[0].actor_user_id, BANNED, "the filing's actor is the appealing member (record.user_id)");
  assert.equal(audits[0].target_id, String(row.id));
  assert.deepEqual(JSON.parse(audits[0].details_json), {
    ban_record_id: record.id,
    status: "open",
    ticket_channel_id: "5551",
  });

  // §3 up-front-notice DM — exact shipped copy, never mentions:
  assert.equal(dmSent.length, 1);
  assert.equal(dmSent[0].userId, BANNED);
  assert.deepEqual(dmSent[0].payload, buildFilingConfirmationDm());
  assert.match(dmSent[0].payload.content, /\*\*Appeal:\*\* filed/);
  assert.match(dmSent[0].payload.content, /\*\*Shared:\*\* only text, images, and video/);
  assert.match(dmSent[0].payload.content, /\*\*Replies:\*\*.*pause/, "the silence warning ships up-front");
  assert.match(dmSent[0].payload.content, /\*\*One per ban:\*\*/);
  assert.deepEqual(dmSent[0].payload.allowedMentions, { parse: [] });

  // Ban-DM button edited away: original copy kept, filed line appended, components cleared:
  assert.equal(dm.edits.length, 1);
  const edit = dm.edits[0];
  assert.equal(edit.content,
    `You have been banned from **Test Guild**.\n\n**Appeal:** filed <t:${Math.floor(NOW / 1000)}:F>`);
  assert.deepEqual(edit.components, []);
  assert.deepEqual(edit.allowedMentions, { parse: [] });
});

test("record CLOSED between press and submit → NOT_ACTIVE refusal and ZERO filing (battery re-run, not a token)", async () => {
  const cid = freshCid();
  const record = seedBan(cid, { status: "unbanned_manual" }); // lifted while the modal was open
  const file = realFile();
  const ticket = ticketDouble(() => ({ ok: true }));

  const { result } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${record.id}` }),
      deps: { maxStatementLength: 200, now: () => NOW, fileAppeal: file.fn, openAppealTicket: ticket.fn },
    }),
  );

  assert.equal(result.code, CODE_NOT_ACTIVE);
  assert.equal(result.error, refusalNotActive(), "the pass-through refusal is the validator's specific copy");
  assert.equal(file.calls.length, 0, "NOTHING was filed");
  assert.equal(ticket.calls.length, 0);
  assert.deepEqual(appealRows(record.id), []);
  assert.equal(db.listAdminAudit(cid, { limit: 25 }).length, 0);
});

test("appeals toggled OFF between press and submit → APPEALS_OFF, zero filing (real guild_settings re-read)", async () => {
  const cid = freshCid();
  const record = seedBan(cid);
  db.updateGuildSettings(cid, { ban_appeals: 0 });
  const file = realFile();
  const { result } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${record.id}` }),
      deps: { maxStatementLength: 200, fileAppeal: file.fn, openAppealTicket: ticketDouble(() => ({ ok: true })).fn },
    }),
  );
  assert.equal(result.code, CODE_APPEALS_OFF);
  assert.equal(result.error, refusalAppealsOff());
  assert.equal(file.calls.length, 0);
  assert.deepEqual(appealRows(record.id), []);
});

test("pipeline statement gate: blank modal text → MISSING_STATEMENT with ZERO filing and ZERO ticket work", async () => {
  const cid = freshCid();
  const record = seedBan(cid);
  const file = realFile();
  const ticket = ticketDouble(() => ({ ok: true }));
  const { result } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${record.id}`, statement: "   \n  " }),
      deps: { maxStatementLength: 200, fileAppeal: file.fn, openAppealTicket: ticket.fn },
    }),
  );
  assert.equal(result.code, CODE_MISSING_STATEMENT);
  assert.equal(result.error, refusalMissingStatement());
  assert.equal(file.calls.length, 0);
  assert.equal(ticket.calls.length, 0);
  assert.deepEqual(appealRows(record.id), []);
});

test("UNIQUE race past the validator read → ALREADY_FILED answering with the LIVE row's status", async () => {
  const cid = freshCid();
  const record = seedBan(cid);
  const live = seedAppeal(cid, record, "already in review");
  db.db.prepare("UPDATE ban_appeals SET status='denied' WHERE id=?").run(live.id);

  const ticket = ticketDouble(() => {
    throw new Error("must never open a second ticket for a cycle");
  });
  const { result } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${record.id}` }),
      deps: { maxStatementLength: 200, openAppealTicket: ticket.fn },
    }),
  );
  assert.equal(result.code, CODE_ALREADY_FILED);
  assert.equal(result.appeal.status, "denied", "the race re-read answers with the LIVE row");
  assert.equal(result.error, refusalAlreadyFiled("denied"));
  assert.match(result.error, /\*\*denied\*\*/);
  assert.equal(ticket.calls.length, 0);
  assert.deepEqual(appealRows(record.id).length, 1, "the UNIQUE kept the cycle to one row");
});

test("#730 law: ticket failure leaves the row `filed` with NULL ticket, names the SPECIFIC cause, and NEVER claims filed", async () => {
  const cid = freshCid();
  const record = seedBan(cid);
  const cause =
    "Discord rejected channel creation (**Missing Permissions**). Check:\n1. Bot role has **Manage Channels**";
  const ticket = ticketDouble(() => ({ ok: false, error: cause }));
  const dmSent = [];

  const { result, lines } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${record.id}` }),
      deps: {
        maxStatementLength: 200,
        now: () => NOW,
        openAppealTicket: ticket.fn,
        sendDm: async (userId, payload) => {
          dmSent.push({ userId, payload });
          return { ok: true };
        },
      },
    }),
  );

  assert.equal(result.code, FILING_CODES.TICKET_FAILED);
  assert.equal(result.error, refusalTicketFailed(cause));
  assert.match(result.error, /your statement was saved/);
  assert.ok(result.error.includes(cause), "the SPECIFIC cause reaches the user (rule 3)");
  assert.doesNotMatch(result.error, /filed/i, "the user is NEVER told 'filed' without a ticket");
  assert.match(result.error, /The ban itself is unchanged\./);

  // Storage truth (the #730 proof at the real repository): the row exists,
  // STAYED `filed`, and holds NO ticket reference.
  const [row] = appealRows(record.id);
  assert.ok(row, "the statement is durably kept");
  assert.equal(row.status, "filed");
  assert.equal(row.ticket_channel_id, null);

  // The audit row reflects the TRUTHFUL pending state:
  const audits = db.listAdminAudit(cid, { limit: 25 });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, AUDIT_ACTION_FILE);
  assert.deepEqual(JSON.parse(audits[0].details_json), {
    ban_record_id: record.id,
    status: "filed",
    ticket_channel_id: null,
  });

  // Loud log with ids (issue §6) — the pending state is the retry surface:
  const failLog = lines.find((l) => l.includes("ticket FAILED"));
  assert.ok(failLog, lines.join(" | "));
  assert.match(failLog, /\[appeals\]/);
  assert.match(failLog, new RegExp(`community=${cid} record=${record.id} user=${BANNED} appeal=${row.id}`));
  assert.match(failLog, /stays pending \(filed, no ticket\)/);
  assert.equal(dmSent.length, 0, "no confirmation DM — the caller replies the TICKET_FAILED copy");
});

test("ticket step THROWS after filing → still TICKET_FAILED with the pending-truth copy (outer catch is honest about the filed row)", async () => {
  const cid = freshCid();
  const record = seedBan(cid);
  const ticket = ticketDouble(() => {
    throw new Error("gateway exploded");
  });
  const { result } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${record.id}` }),
      deps: { maxStatementLength: 200, openAppealTicket: ticket.fn },
    }),
  );
  assert.equal(result.code, FILING_CODES.TICKET_FAILED);
  assert.match(result.error, /gateway exploded/);
  assert.doesNotMatch(result.error, /filed/i);
  const [row] = appealRows(record.id);
  assert.equal(row.status, "filed");
  assert.equal(row.ticket_channel_id, null);
});

test("FILE_FAILED: the repository's SPECIFIC sentence surfaces, nothing stored, nothing audited", async () => {
  const cid = freshCid(); // community exists, the ban record does NOT (phantom customId)
  const phantom = {
    id: 9_999_999,
    community_id: cid,
    user_id: BANNED,
    status: "active",
  };
  const ticket = ticketDouble(() => {
    throw new Error("must not open a ticket for an un-storable appeal");
  });
  const { result, lines } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${phantom.id}` }),
      deps: {
        maxStatementLength: 200,
        getBanRecord: () => phantom,
        openAppealTicket: ticket.fn,
      },
    }),
  );
  assert.equal(result.code, FILING_CODES.FILE_FAILED);
  assert.equal(result.error, "No such ban record to appeal.",
    "the repository's own sentence — never a generic database error");
  assert.equal(ticket.calls.length, 0);
  assert.equal(db.listAdminAudit(cid, { limit: 25 }).length, 0);
  const errLog = lines.find((l) => l.includes("appeal filing failed"));
  assert.ok(errLog, lines.join(" | "));
  assert.match(errLog, /\[appeals\]/);
  assert.match(errLog, /No such ban record to appeal/);
});

test("pre-filing throw → INTERNAL with the cause (the 'Nothing was filed.' honesty the filed flag protects)", async () => {
  const cid = freshCid();
  const record = seedBan(cid);
  const ticket = ticketDouble(() => ({ ok: true }));
  const { result } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${record.id}` }),
      deps: {
        maxStatementLength: 200,
        fileAppeal: () => {
          throw new Error("vault door jammed");
        },
        openAppealTicket: ticket.fn,
      },
    }),
  );
  assert.equal(result.code, FILING_CODES.INTERNAL);
  assert.match(result.error, /appeal filing/);
  assert.match(result.error, /vault door jammed/);
  assert.match(result.error, /Nothing was filed\.$/);
  assert.equal(ticket.calls.length, 0);
  assert.deepEqual(appealRows(record.id), []);
});

test("post-filing best-effort failures NEVER un-file: a failed DM/edit report themselves and the filing stands (K2 law)", async () => {
  const cid = freshCid();
  const record = seedBan(cid);
  const dm = makeBanDm();
  dm.message.edit = async () => {
    throw new Error("DM channel gone");
  };
  const { result, lines } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${record.id}`, message: dm.message }),
      deps: {
        maxStatementLength: 200,
        now: () => NOW,
        openAppealTicket: () => ({
          ok: true,
          appeal: { id: 1, status: "open" },
          ticket: { id: 2 },
          channel: { id: "5552" },
          channelOfRecordId: "5552",
        }),
        sendDm: async () => {
          throw new Error("Cannot send messages to this user");
        },
      },
    }),
  );

  assert.equal(result.code, FILING_CODES.FILED, "outbound failures never reverse a landed filing");
  assert.equal(result.dmDelivered, false);
  assert.equal(result.dmError, "Cannot send messages to this user");
  assert.equal(result.banDmEdited, false);
  assert.equal(result.banDmEditError, "DM channel gone");

  const dmFail = lines.find((l) => l.includes("confirmation DM failed"));
  assert.ok(dmFail, lines.join(" | "));
  assert.match(dmFail, /\[appeals\]/);
  assert.match(dmFail, /Cannot send messages to this user/);
  assert.match(dmFail, /channel=5552/, "the log carries the ids to reproduce from logs alone");
  const editFail = lines.find((l) => l.includes("edit-away failed"));
  assert.ok(editFail, lines.join(" | "));
  assert.match(editFail, /DM channel gone/);

  const [row] = appealRows(record.id);
  assert.equal(row.status, "filed", "the cycle's appeal row survives its outbound hiccups");
});

test("submit without a ban-DM message reference files anyway — the skip is logged, never fatal", async () => {
  const cid = freshCid();
  const record = seedBan(cid);
  const { result, lines } = await withCapturedLogs(() =>
    handleAppealModalSubmit({
      interaction: makeModal({ customId: `appeal:s:${record.id}` }), // message: null
      deps: {
        maxStatementLength: 200,
        now: () => NOW,
        sendDm: async () => ({ ok: true }),
        openAppealTicket: () => ({
          ok: true,
          appeal: { id: 1, status: "open" },
          ticket: { id: 2 },
          channel: { id: "5553" },
          channelOfRecordId: "5553",
        }),
      },
    }),
  );
  assert.equal(result.code, FILING_CODES.FILED);
  assert.equal(result.banDmEdited, false);
  assert.equal(result.banDmEditError, "no ban-DM message reference carried by the submit");
  assert.ok(lines.some((l) => l.includes("edit-away skipped") && l.includes("[appeals]")), lines.join(" | "));
});

test("ban-DM edit copy seam: the filed line rides `**Appeal:** filed <t:F>` under the preserved original; empty original degrades to the line alone", () => {
  const ts = `<t:${Math.floor(NOW / 1000)}:F>`;
  assert.equal(buildFiledBanDmLine(NOW), `**Appeal:** filed ${ts}`);
  assert.equal(buildAppealDmEditContent("Banned from **X**.", NOW), `Banned from **X**.\n\n**Appeal:** filed ${ts}`);
  assert.equal(buildAppealDmEditContent("   \n  ", NOW), `**Appeal:** filed ${ts}`);
  assert.equal(buildAppealDmEditContent(null, NOW), `**Appeal:** filed ${ts}`);
});
