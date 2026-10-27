const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

// #745: ticket_reports side table (migration 066) + repository accessors.
// Proven here: the locked decision-8 schema lands on a fresh DB, insert +
// readback round-trip, the kind CHECK, ON DELETE CASCADE, and the
// duplicate-report nudge query — OPEN-only and community-scoped exactly the
// way repositories/tickets.js scopes (integer community_id via migration
// 034). Error rule 6: every bad input answers { ok:false, error }, never a
// throw.
describe("ticket_reports repository (migration 066, #745)", () => {
  let api;
  let cleanup;
  let commA;
  let commB;

  before(() => {
    // Contract: loadDb() runs before any other `src/` require — it points
    // DB_PATH at a fresh temp SQLite file and only then loads src/db (which
    // runs runMigrations() on load). See test/helpers/env.js.
    ({ api, cleanup } = loadDb());
    commA = communityKey("g-ticket-reports-a");
    commB = communityKey("g-ticket-reports-b");
  });

  after(() => cleanup?.());

  let seq = 0;
  const seedTicket = (communityId = commA) => {
    seq += 1;
    return api.createTicket({
      communityId,
      creatorUserId: `u-tr-${seq}`,
      channelId: `chan-tr-${seq}`,
      reason: "seed",
    });
  };

  const closeTicket = (ticket) =>
    api.markTicketClosed(ticket.id, { closedBy: "staff-closer" });

  const reportRows = () =>
    Number(api.db.prepare(`SELECT COUNT(*) AS n FROM ticket_reports`).get().n);

  describe("migration 066 — schema on a fresh DB", () => {
    it("every migration ran: ledger holds 066_ticket_reports, user_version is current", () => {
      const { LATEST_VERSION, readLedgerIds } = require("../src/db/migrate");
      assert.ok(
        readLedgerIds().includes("066_ticket_reports"),
        "the applied-migrations ledger records 066_ticket_reports",
      );
      assert.equal(
        Number(api.db.pragma("user_version", { simple: true })),
        LATEST_VERSION,
        "load-time migrate() stamped the full registry",
      );
    });

    it("ticket_reports matches the locked decision-8 schema exactly", () => {
      const cols = api.db.prepare(`PRAGMA table_info(ticket_reports)`).all();
      assert.deepEqual(
        cols.map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
        [
          ["ticket_id", "INTEGER", 0, null, 1],
          ["kind", "TEXT", 1, null, 0],
          ["subject_user_id", "TEXT", 1, null, 0],
          ["reported_message_id", "TEXT", 0, null, 0],
          ["source_channel_id", "TEXT", 0, null, 0],
          ["message_deleted", "INTEGER", 1, "0", 0],
          ["snapshot_note", "TEXT", 0, null, 0],
          ["created_at", "INTEGER", 1, null, 0],
        ],
      );
    });

    it("declares the cascading FK to tickets and the partial nudge index", () => {
      assert.deepEqual(
        api.db
          .prepare(`PRAGMA foreign_key_list(ticket_reports)`)
          .all()
          .map((f) => [f.table, f.from, f.to, f.on_delete, f.on_update]),
        [["tickets", "ticket_id", "id", "CASCADE", "NO ACTION"]],
      );
      const idx = api.db
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_ticket_reports_message'`
        )
        .get();
      assert.ok(idx, "idx_ticket_reports_message exists");
      assert.match(
        idx.sql,
        /reported_message_id IS NOT NULL/,
        "partial index keeps user-kind (NULL message id) rows out",
      );
    });

    it("the kind CHECK rejects values outside message|user at the SQL layer too", () => {
      const ticket = seedTicket();
      assert.throws(
        () =>
          api.db
            .prepare(
              `INSERT INTO ticket_reports (ticket_id, kind, subject_user_id, created_at)
               VALUES (?, 'spam', 'u-x', 1)`
            )
            .run(ticket.id),
        /CHECK constraint failed/,
      );
    });

    it("facade re-exports the accessors in the tickets mapping style", () => {
      assert.deepEqual([...api.REPORT_KINDS], ["message", "user"]);
      for (const name of [
        "insertTicketReport",
        "getTicketReport",
        "findOpenReportForMessage",
      ]) {
        assert.equal(
          typeof api[name],
          "function",
          `${name} must be on the src/db facade`,
        );
      }
    });
  });

  describe("insertTicketReport + getTicketReport round-trip", () => {
    it("full message report stores every field and stamps created_at from now()", () => {
      const ticket = seedTicket();
      const t0 = Date.now();
      const res = api.insertTicketReport({
        ticketId: ticket.id,
        kind: "message",
        subjectUserId: "123456789012345678",
        reportedMessageId: "987654321098765432",
        sourceChannelId: "555555555555555555",
        messageDeleted: true,
        snapshotNote: "kept reposting the same spam",
      });
      const t1 = Date.now();
      assert.equal(res.ok, true, res.error || "");

      const r = api.getTicketReport(ticket.id);
      assert.ok(r, "readback row exists");
      assert.deepEqual(r, res.report, "the insert returns the stored row");
      assert.equal(r.ticket_id, ticket.id);
      assert.equal(r.kind, "message");
      assert.equal(r.subject_user_id, "123456789012345678");
      assert.equal(r.reported_message_id, "987654321098765432");
      assert.equal(r.source_channel_id, "555555555555555555");
      assert.equal(r.message_deleted, 1, "messageDeleted coerced to 1");
      assert.equal(r.snapshot_note, "kept reposting the same spam");
      assert.ok(
        r.created_at >= t0 && r.created_at <= t1,
        `created_at ${r.created_at} must sit in the insert window [${t0}, ${t1}]`,
      );
    });

    it("user report defaults: absent message ids, message_deleted 0, note null", () => {
      const ticket = seedTicket();
      const res = api.insertTicketReport({
        ticketId: ticket.id,
        kind: "user",
        subjectUserId: "u-subject",
      });
      assert.equal(res.ok, true, res.error || "");

      const r = api.getTicketReport(ticket.id);
      assert.equal(r.kind, "user");
      assert.equal(r.reported_message_id, null);
      assert.equal(r.source_channel_id, null);
      assert.equal(r.message_deleted, 0, "default 0 — nothing deleted by default");
      assert.equal(r.snapshot_note, null);
    });

    it("getTicketReport reads null for junk or missing keys", () => {
      assert.equal(api.getTicketReport(null), null);
      assert.equal(api.getTicketReport("not-a-number"), null);
      assert.equal(api.getTicketReport(0), null);
      assert.equal(api.getTicketReport(42424242), null);
    });
  });

  describe("bad input never throws — { ok:false, error } (AGENTS.md rule 6)", () => {
    it("every malformed insert shape answers ok:false with a specific error and writes nothing", () => {
      const ticket = seedTicket();
      const beforeRows = reportRows();
      const bad = [
        ["no fields at all", {}],
        ["missing ticketId", { kind: "user", subjectUserId: "u-1" }],
        ["ticketId 0", { ticketId: 0, kind: "user", subjectUserId: "u-1" }],
        ["ticketId negative", { ticketId: -5, kind: "user", subjectUserId: "u-1" }],
        ["ticketId fractional", { ticketId: 1.5, kind: "user", subjectUserId: "u-1" }],
        ["ticketId not a number", { ticketId: "abc", kind: "user", subjectUserId: "u-1" }],
        ["kind outside the CHECK", { ticketId: ticket.id, kind: "spam", subjectUserId: "u-1" }],
        ["kind missing", { ticketId: ticket.id, subjectUserId: "u-1" }],
        ["subjectUserId missing", { ticketId: ticket.id, kind: "user" }],
        ["subjectUserId blank", { ticketId: ticket.id, kind: "user", subjectUserId: "   " }],
        ["message kind without a message id", { ticketId: ticket.id, kind: "message", subjectUserId: "u-1" }],
        ["message id blank after trim", { ticketId: ticket.id, kind: "message", subjectUserId: "u-1", reportedMessageId: "   " }],
        ["ticket does not exist", { ticketId: 999999, kind: "user", subjectUserId: "u-1" }],
      ];
      for (const [label, input] of bad) {
        const res = api.insertTicketReport(input);
        assert.equal(res.ok, false, `${label} must be rejected`);
        assert.ok(
          typeof res.error === "string" && res.error.length > 0,
          `${label} must carry a specific error`,
        );
      }
      assert.equal(reportRows(), beforeRows, "no rejected attempt wrote a row");
    });

    it("a second report for the same ticket is refused as { ok:false } (PK = one report per ticket)", () => {
      const ticket = seedTicket();
      assert.equal(
        api.insertTicketReport({ ticketId: ticket.id, kind: "user", subjectUserId: "u-1" })
          .ok,
        true,
      );
      const second = api.insertTicketReport({
        ticketId: ticket.id,
        kind: "message",
        subjectUserId: "u-2",
        reportedMessageId: "m-dup",
      });
      assert.equal(second.ok, false, "the PK (one report per ticket) must reject the replay");
      assert.match(
        second.error,
        /Could not save the ticket report/,
        "constraint failures stay specific (rule 3), never a silent drop",
      );
    });
  });

  describe("ON DELETE CASCADE", () => {
    it("deleting the parent ticket row removes the report row", () => {
      const ticket = seedTicket();
      assert.equal(
        api.insertTicketReport({
          ticketId: ticket.id,
          kind: "user",
          subjectUserId: "u-sub",
        }).ok,
        true,
      );
      assert.ok(api.getTicketReport(ticket.id));
      api.db.prepare(`DELETE FROM tickets WHERE id=?`).run(ticket.id);
      assert.equal(
        api.getTicketReport(ticket.id),
        null,
        "ticket_reports cascades away with tickets (migration 066 FK)",
      );
    });
  });

  describe("findOpenReportForMessage — duplicate-report nudge", () => {
    it("matches an OPEN report and carries ticket_number + live channel for the note", () => {
      const ticket = seedTicket();
      assert.equal(
        api.insertTicketReport({
          ticketId: ticket.id,
          kind: "message",
          subjectUserId: "u-sub",
          reportedMessageId: "m-open-1",
          sourceChannelId: "chan-src-1",
        }).ok,
        true,
      );
      const hit = api.findOpenReportForMessage(commA, "m-open-1");
      assert.ok(hit, "open report found");
      assert.equal(hit.ticket_id, ticket.id);
      assert.equal(hit.kind, "message");
      assert.equal(hit.subject_user_id, "u-sub");
      assert.equal(hit.source_channel_id, "chan-src-1");
      assert.equal(hit.ticket_number, ticket.ticket_number);
      assert.equal(hit.ticket_channel_id, ticket.channel_id);
    });

    it("ignores closed tickets — closed-only never nudges, open wins over closed on the same message", () => {
      const closedFirst = seedTicket();
      assert.equal(
        api.insertTicketReport({
          ticketId: closedFirst.id,
          kind: "message",
          subjectUserId: "u-sub",
          reportedMessageId: "m-same",
        }).ok,
        true,
      );
      closeTicket(closedFirst);
      assert.equal(
        api.findOpenReportForMessage(commA, "m-same"),
        null,
        "a CLOSED ticket with the same message id must not nudge",
      );

      const open = seedTicket();
      assert.equal(
        api.insertTicketReport({
          ticketId: open.id,
          kind: "message",
          subjectUserId: "u-sub",
          reportedMessageId: "m-same",
        }).ok,
        true,
      );
      assert.equal(
        api.findOpenReportForMessage(commA, "m-same").ticket_id,
        open.id,
        "the OPEN ticket's report wins over the closed one",
      );

      closeTicket(open);
      assert.equal(
        api.findOpenReportForMessage(commA, "m-same"),
        null,
        "all closed → no nudge",
      );
    });

    it("is community-scoped — the same message id never leaks across communities", () => {
      const ta = seedTicket(commA);
      const tb = seedTicket(commB);
      assert.equal(
        api.insertTicketReport({
          ticketId: ta.id,
          kind: "message",
          subjectUserId: "u-a",
          reportedMessageId: "m-shared",
        }).ok,
        true,
      );
      assert.equal(
        api.insertTicketReport({
          ticketId: tb.id,
          kind: "message",
          subjectUserId: "u-b",
          reportedMessageId: "m-shared",
        }).ok,
        true,
      );
      assert.equal(
        api.findOpenReportForMessage(commA, "m-shared").ticket_id,
        ta.id,
        "community A sees only its own report",
      );
      assert.equal(
        api.findOpenReportForMessage(commB, "m-shared").ticket_id,
        tb.id,
        "community B sees only its own report",
      );
    });

    it("returns the OLDEST open report when several tickets report the same message", () => {
      const first = seedTicket();
      const second = seedTicket();
      assert.equal(
        api.insertTicketReport({
          ticketId: first.id,
          kind: "message",
          subjectUserId: "u-sub",
          reportedMessageId: "m-multi",
        }).ok,
        true,
      );
      assert.equal(
        api.insertTicketReport({
          ticketId: second.id,
          kind: "message",
          subjectUserId: "u-sub",
          reportedMessageId: "m-multi",
        }).ok,
        true,
      );
      assert.equal(
        api.findOpenReportForMessage(commA, "m-multi").ticket_id,
        first.id,
        "the nudge points at the existing (oldest) open report",
      );
    });

    it("user-kind rows never match, and junk message ids read as null", () => {
      const ticket = seedTicket();
      assert.equal(
        api.insertTicketReport({
          ticketId: ticket.id,
          kind: "user",
          subjectUserId: "u-quiet",
        }).ok,
        true,
      );
      // reported_message_id is NULL on user rows — no string can hit it.
      assert.equal(api.findOpenReportForMessage(commA, "u-quiet"), null);
      assert.equal(api.findOpenReportForMessage(commA, "never-reported-m-404"), null);
      assert.equal(api.findOpenReportForMessage(commA, ""), null);
      assert.equal(api.findOpenReportForMessage(commA, "   "), null);
      assert.equal(api.findOpenReportForMessage(commA, null), null);
    });
  });
});
