/**
 * Unit tests for the "Report Post" (message variant) modal submit (#745
 * subtask 08): src/features/tickets/report.js — handleReportMessageModal.
 *
 * House style follows test/ticket-reports-user-modal.test.js: real db facade
 * on a temp SQLite via loadDb(), real requireStaff gating, the process-wide
 * pendingReports singleton driven through its public put/take/count/reset
 * seams, the shared ./helpers/discord modal-submit factory, and the TEST-only
 * `opts.deps` seam (createReportTicketDeps) — production goes through the
 * router with (interaction, ctx) only.
 *
 * THE call-order recorder is the heart of this file (decision 4's ORDER is
 * the safety design): openTicketChannel pushes "create", the handler's own
 * ticket-channel sends push "evidence" (embeds) or "note" (content-only) via
 * a wrapper installed AFTER the real pipeline's open-notice, the seeded
 * message's delete() pushes "delete", recordSlashAudit pushes "audit". The
 * happy path asserts the EXACT sequence ["create","evidence","delete",
 * "audit"]; every evidence-failure arm asserts "delete" is absent from it.
 *
 * Covers (acceptance): decision-2 parse table (yes/Y/Yes/y delete; no/n keep
 * silent; 'maybe' keep + the EXACT echo in reply AND snapshot_note; "" keep);
 * expired/unknown/wrong-kind token → no create; one-shot replay; non-staff
 * denial + lost-staff re-check (token untouched); the full happy path against
 * the REAL openTicketChannel (staff-self creator === opener, NO DMs,
 * is_sensitive 0, reported user never a member, row kind 'message' with
 * reported/source ids + message_deleted 1, message actually deleted, audit
 * captured); delete rejects → message_deleted 0 + the ⚠ correction posted
 * into the ticket + reply warning; delete fetch 10008 → same honest shape;
 * evidence post throws → delete NEVER called + ticket + row stand + specific
 * cause; evidence build refused → same skip; duplicate-open-report nudge
 * (decision 12: second report still creates and NAMES the first ref);
 * insert failure → ticket-intact wording (rules 3 + 5).
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

const {
  createGuild,
  createClient,
  createTextChannel,
  createUser,
  createMember,
  createModalSubmitInteraction,
  embedToSearchText,
  lastReplyContent,
  lastReplyEphemeral,
  PermissionFlagsBits,
} = require("./helpers/discord");

let api;
let cleanup;
let report;
let pendingReports;
let constants;
let realHelpers;

before(() => {
  // CONTRACT: loadDb() runs before every `src/` require in this file (the
  // submit pipeline pulls the db facade through report.js itself).
  ({ api, cleanup } = loadDb());
  report = require("../src/features/tickets/report.js");
  pendingReports = require("../src/features/tickets/pendingReports.js");
  constants = require("../src/features/tickets/constants.js");
  realHelpers = require("../src/features/tickets/helpers.js");
});

after(() => cleanup?.());

beforeEach(() => {
  // Every test starts (and asserts from) an empty pending store.
  pendingReports.resetPendingReportsForTests();
});

// ---------- harness ----------

/** Monotonic snowflake-shaped ids (unique per call, mention-renderable). */
let idSeq = 0;
function snowflake() {
  idSeq += 1;
  return String(400000000000000000n + BigInt(idSeq));
}

/**
 * Community-scoped row counts: every test gets its own guild → its own
 * community key, and the runner shares ONE database across the file, so
 * global table counts would collide across tests.
 */
function countRows(table, env) {
  const communityId = communityKey(env.guildId);
  if (table === "tickets") {
    return api.db
      .prepare(`SELECT COUNT(*) AS n FROM tickets WHERE community_id=?`)
      .get(communityId).n;
  }
  if (table === "ticket_reports") {
    return api.db
      .prepare(
        `SELECT COUNT(*) AS n FROM ticket_reports r
         JOIN tickets t ON t.id = r.ticket_id
         WHERE t.community_id=?`,
      )
      .get(communityId).n;
  }
  throw new Error(`countRows: unsupported table ${table}`);
}

/** Plain content + flattened embed text of one channel payload. */
function payloadText(payload) {
  const embeds = (payload?.embeds || []).map((e) => embedToSearchText(e)).join("\n");
  return [payload?.content || "", embeds].filter(Boolean).join("\n");
}

/** Swap console.error for a capture buffer; returns lines + restore(). */
function captureConsoleError() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

/**
 * Fresh guild with a source channel, a ManageChannels bot member (the real
 * openTicketChannel's permission gate), an admin reporter (ManageGuild leg
 * of requireStaff), a message author (the report subject), and a plain
 * (denied) member.
 */
function makeEnv() {
  const guildId = snowflake();
  const guild = createGuild({ id: guildId });
  const sourceChannel = createTextChannel({ id: snowflake(), guild, name: "general" });
  guild.addChannel(sourceChannel);

  const client = createClient();
  client.addGuild(guild);

  const botUser = createUser({ id: snowflake(), bot: true });
  const botMember = createMember({
    guild,
    user: botUser,
    permissions:
      BigInt(PermissionFlagsBits.ManageChannels) |
      BigInt(PermissionFlagsBits.ManageGuild),
  });
  guild.addMember(botMember);
  guild.members.me = botMember;

  const reporter = createUser({ id: snowflake() });
  const reporterMember = createMember({ guild, user: reporter, admin: true });
  guild.addMember(reporterMember);

  const subject = createUser({ id: snowflake(), username: "suspect" });
  const subjectMember = createMember({ guild, user: subject });
  guild.addMember(subjectMember);

  const plain = createUser({ id: snowflake() });
  const plainMember = createMember({ guild, user: plain });
  guild.addMember(plainMember);

  return {
    guildId,
    guild,
    sourceChannel,
    client,
    botUser,
    reporter,
    reporterMember,
    subject,
    subjectMember,
    plain,
    plainMember,
  };
}

/**
 * makeEnv + a REAL seeded message in the source channel: the handler's
 * delete step resolves the reported id through the channel's message cache,
 * and tests assert the delete via msg.deleted / _deletedMessages.
 */
function makeMessageEnv() {
  const env = makeEnv();
  env.reportedMessage = env.sourceChannel.addMessage({
    id: snowflake(),
    content: "buy followers cheap >>> spam.example",
    author: env.subject,
  });
  return env;
}

/**
 * Deps seam + CALL-ORDER RECORDER per test: openTicketChannel SPY wraps the
 * real one (real channel + real tickets row offline) and pushes "create";
 * the returned channel's send is wrapped AFTER the pipeline's own open-
 * notice, so the recorder labels ONLY the handler's writes — "evidence" for
 * the embed payload, "note" for the content-only failure lines.
 * recordSlashAudit pushes "audit". Overrides win per key.
 */
function makeRecorder(overrides = {}) {
  const order = [];
  const openCalls = [];
  const audits = [];
  const deps = {
    openTicketChannel: async (opts) => {
      order.push("create");
      openCalls.push(opts);
      const res = await realHelpers.openTicketChannel(opts);
      const realSend = res.channel.send.bind(res.channel);
      res.channel.send = async (payload) => {
        order.push(payload?.embeds?.length ? "evidence" : "note");
        return realSend(payload);
      };
      return res;
    },
    recordSlashAudit: (entry) => {
      order.push("audit");
      audits.push(entry);
      return null;
    },
    ...overrides,
  };
  return { order, openCalls, audits, deps };
}

/**
 * Wrap the seeded message's delete() so the recorder sees "delete" the
 * moment the flow actually calls it (and can force a rejection — the
 * delete-failure arm). Never called on a keep or a skipped delete.
 */
function spyDelete(message, order, failWith = null) {
  const real = message.delete.bind(message);
  message.delete = async () => {
    order.push("delete");
    if (failWith) throw failWith;
    return real();
  };
}

/** Seed a message-variant snapshot (the invoke-time snapshot) + token. */
function putMessageReport(env, overrides = {}) {
  return pendingReports.putReport({
    kind: "message",
    guildId: env.guildId,
    reporterUserId: env.reporter.id,
    messageId: env.reportedMessage.id,
    channelId: env.sourceChannel.id,
    channelName: "general",
    authorId: env.subject.id,
    content: env.reportedMessage.content,
    attachments: [],
    subjectUserId: env.subject.id,
    ...overrides,
  });
}

/** Modal submit carrying tk:rep:m:<token> + context + delete-answer fields. */
function makeSubmit({
  env,
  token,
  del = "yes",
  context,
  user = env.reporter,
  member = env.reporterMember,
}) {
  return createModalSubmitInteraction({
    customId: constants.MODAL_REPORT_MESSAGE_PREFIX + token,
    guild: env.guild,
    user,
    member,
    client: env.client,
    channelId: env.sourceChannel.id,
    fields: {
      [constants.MODAL_REPORT_FIELD_CONTEXT]:
        context ?? "cross-posted spam invite links, please remove",
      [constants.MODAL_REPORT_FIELD_DELETE]: del,
    },
  });
}

const RUN_CTX = (env) => ({ supervisor: { discord: env.client } });

/** The real ticket channel created by the pipeline (assertion buffer). */
function ticketChannelFor(env) {
  return env.guild.channels.created[0];
}

/** The evidence payload = the ONLY ticket-channel send carrying files. */
function sentEvidencePayload(env) {
  return ticketChannelFor(env)?.sent.find((p) => Array.isArray(p.files)) ?? null;
}

/** Handler-posted content-only notes (open-notice carries embeds). */
function sentNotePayloads(env) {
  return (ticketChannelFor(env)?.sent || []).filter(
    (p) =>
      typeof p?.content === "string" &&
      !Array.isArray(p.embeds) &&
      !Array.isArray(p.files),
  );
}

/** The community's tickets row (single-ticket tests) or null. */
function ticketRowFor(env) {
  const communityId = communityKey(env.guildId);
  return (
    api.db
      .prepare(`SELECT * FROM tickets WHERE community_id=? ORDER BY id LIMIT 1`)
      .get(communityId) || null
  );
}

/** The ticket_reports row beside env's (first) ticket. */
function reportRowFor(env) {
  const t = ticketRowFor(env);
  return t ? api.getTicketReport(t.id) : null;
}

/** The Discord jump link the failure notes/corrections must carry. */
function jumpUrlOf(env) {
  return `https://discord.com/channels/${env.guildId}/${env.sourceChannel.id}/${env.reportedMessage.id}`;
}

// ---------- decision-2 parse table ----------

describe("report message submit — delete-choice parse (decision 2: never destroy on a misread)", () => {
  const PARSE_TABLE = [
    { answer: "yes", deletes: true },
    { answer: "Y", deletes: true },
    { answer: "Yes", deletes: true },
    { answer: "y", deletes: true },
    { answer: "no", deletes: false },
    { answer: "n", deletes: false },
    {
      answer: "maybe",
      deletes: false,
      echo: "input 'maybe' not understood — message kept",
    },
    // Required field makes "" theoretical — the keep-path must still hold.
    { answer: "", deletes: false },
  ];

  for (const { answer, deletes, echo } of PARSE_TABLE) {
    it(`"${answer}" → ${deletes ? "delete" : "keep"}${echo ? " + exact echo" : " (silent)"}`, async () => {
      const env = makeMessageEnv();
      const r = makeRecorder();
      spyDelete(env.reportedMessage, r.order);
      const token = putMessageReport(env);

      const interaction = makeSubmit({ env, token, del: answer });
      await report.handleReportMessageModal(interaction, RUN_CTX(env), {
        deps: r.deps,
      });

      // The message's REAL disposition is the law.
      assert.equal(
        env.reportedMessage.deleted,
        deletes,
        deletes ? "recognised yes deleted the message" : "NEVER destroy on a misread",
      );
      assert.equal(
        r.order.includes("delete"),
        deletes,
        "the delete step ran exactly on the recognised words",
      );

      // Row flag mirrors the ACTUAL outcome (acceptance: both branches).
      const row = reportRowFor(env);
      assert.ok(row, "the side record was written");
      assert.equal(row.message_deleted, deletes ? 1 : 0);
      assert.equal(row.kind, "message");

      // Decision-13 disposition line inside the evidence embed.
      const evidenceText = payloadText(sentEvidencePayload(env));
      assert.ok(
        evidenceText.includes(deletes ? "Original message deleted by" : "Original kept:"),
        "disposition line matches the branch",
      );

      const final = lastReplyContent(interaction);
      if (echo) {
        // EXACT phrase, verbatim, in BOTH the reply and the row.
        assert.ok(final.includes(echo), `reply echoes: ${echo}`);
        assert.equal(row.snapshot_note, echo, "snapshot_note carries the echo");
      } else {
        assert.ok(!/not understood/.test(final), "recognised answers echo nothing");
        assert.equal(row.snapshot_note, null, "no note for a clean read");
      }
    });
  }
});

// ---------- expired / unknown / wrong-kind token ----------

describe("report message submit — token lifecycle (decision 3)", () => {
  it("expired token: specific ephemeral, NO create, NO delete, zero rows", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    spyDelete(env.reportedMessage, r.order);
    const token = putMessageReport(env, {
      capturedAt: Date.now() - pendingReports.PENDING_REPORT_TTL_MS - 60_000,
    });
    assert.ok(token);

    const interaction = makeSubmit({ env, token });
    await report.handleReportMessageModal(interaction, RUN_CTX(env), {
      deps: r.deps,
    });

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /expired or was already used/i);
    assert.match(lastReplyContent(interaction), /run the command again/i, "rule 3: actionable");
    assert.ok(lastReplyEphemeral(interaction));
    assert.equal(interaction.deferred, false, "nothing deferred — the reply is direct");
    assert.deepEqual(r.order, [], "NO create and NO delete after a spent token");
    assert.equal(countRows("tickets", env), 0);
    assert.equal(countRows("ticket_reports", env), 0);
    assert.equal(env.reportedMessage.deleted, false);
    assert.equal(pendingReports.pendingReportCountForTests(), 0, "expired entry swept");
    assert.deepEqual(r.audits, []);
  });

  it("unknown token (never minted): same specific expired reply, no side effects", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();

    const interaction = makeSubmit({ env, token: "f".repeat(32) });
    await report.handleReportMessageModal(interaction, RUN_CTX(env), {
      deps: r.deps,
    });

    assert.match(lastReplyContent(interaction), /expired or was already used/i);
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(r.order, []);
    assert.equal(countRows("tickets", env), 0);
  });

  it("a user-kind snapshot never rides the message prefix: expired reply, snapshot consumed", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    const token = pendingReports.putReport({
      kind: "user",
      guildId: env.guildId,
      reporterUserId: env.reporter.id,
      subjectUserId: env.subject.id,
    });

    const interaction = makeSubmit({ env, token });
    await report.handleReportMessageModal(interaction, RUN_CTX(env), {
      deps: r.deps,
    });

    assert.match(lastReplyContent(interaction), /expired or was already used/i);
    assert.deepEqual(r.order, []);
    assert.equal(countRows("tickets", env), 0);
    assert.equal(pendingReports.pendingReportCountForTests(), 0, "kind mismatch burns the one-shot");
  });

  it("token is consumed once: a replayed submit gets the expired reply", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    spyDelete(env.reportedMessage, r.order);
    const token = putMessageReport(env);

    const first = makeSubmit({ env, token });
    await report.handleReportMessageModal(first, RUN_CTX(env), { deps: r.deps });
    assert.equal(r.order.includes("create"), true);

    const second = makeSubmit({ env, token });
    await report.handleReportMessageModal(second, RUN_CTX(env), { deps: r.deps });

    assert.match(lastReplyContent(second), /expired or was already used/i);
    assert.equal(r.order.filter((label) => label === "create").length, 1, "no second ticket");
    assert.equal(r.order.filter((label) => label === "delete").length, 1, "no second delete");
    assert.equal(countRows("tickets", env), 1);
  });
});

// ---------- staff gate on the submitter ----------

describe("report message submit — staff gate (submitter is authoritative)", () => {
  it("non-staff submitter: standard denial, token untouched, zero side effects", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    spyDelete(env.reportedMessage, r.order);
    const token = putMessageReport(env);

    const interaction = makeSubmit({
      env,
      token,
      user: env.plain,
      member: env.plainMember,
    });
    await report.handleReportMessageModal(interaction, RUN_CTX(env), {
      deps: r.deps,
    });

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /don't have permission/);
    assert.ok(lastReplyEphemeral(interaction));
    assert.equal(interaction.deferred, false);
    assert.deepEqual(r.order, []);
    assert.equal(env.reportedMessage.deleted, false);
    assert.equal(countRows("tickets", env), 0);
    assert.equal(countRows("ticket_reports", env), 0);
    // The gate runs BEFORE take(): the staff member's own token stays valid.
    assert.equal(pendingReports.pendingReportCountForTests(), 1);
  });

  it("submitter who lost staff status after the invoke is denied (re-check, not the invoke's word)", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    spyDelete(env.reportedMessage, r.order);
    const token = putMessageReport(env);
    env.reporterMember.setAdmin(false);

    const interaction = makeSubmit({ env, token });
    await report.handleReportMessageModal(interaction, RUN_CTX(env), {
      deps: r.deps,
    });

    assert.match(lastReplyContent(interaction), /don't have permission/);
    assert.deepEqual(r.order, []);
    assert.equal(env.reportedMessage.deleted, false);
    assert.equal(countRows("tickets", env), 0);
  });
});

// ---------- happy path (real openTicketChannel harness) ----------

describe("report message submit — happy path (decision 4 order, decision 5 ticket, decision 13 record)", () => {
  it("yes → create → evidence → delete → audit, full row + embed + audit assertions", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    spyDelete(env.reportedMessage, r.order);
    const context = "spam invite chain across three channels";
    const token = putMessageReport(env);

    const interaction = makeSubmit({ env, token, del: "yes", context });
    await report.handleReportMessageModal(interaction, RUN_CTX(env), {
      deps: r.deps,
    });

    // -- THE order IS the safety design (decision 4) ------------------------
    assert.deepEqual(
      r.order,
      ["create", "evidence", "delete", "audit"],
      "create → evidence post → delete → audit, EXACTLY once each, in order",
    );

    // -- openTicketChannel contract (locked decision 5) ---------------------
    assert.equal(r.openCalls.length, 1);
    const open = r.openCalls[0];
    assert.equal(open.creatorUserId, env.reporter.id);
    assert.equal(open.openedByStaffId, env.reporter.id, "staff-self branch (helpers.js ~L765)");
    assert.equal(open.creatorUserId, open.openedByStaffId);
    assert.equal(open.guild, env.guild);
    assert.equal(open.client, env.client, "client resolves via ctx.supervisor.discord");
    assert.ok(Number.isInteger(open.communityId), "community id resolved at the Discord edge");
    assert.equal(open.reason, context, "the context IS the ticket reason");

    // -- NEVER DM (decisions 5/7): nobody received a DM ----------------------
    assert.deepEqual(env.subject.sends, [], "the reported user is NEVER DM'd");
    assert.deepEqual(env.reporter.sends, [], "the reporter is not DM'd either");

    // -- tickets row ----------------------------------------------------------
    const ticketRow = ticketRowFor(env);
    assert.ok(ticketRow, "the real openTicketChannel pipeline wrote the row");
    assert.equal(ticketRow.is_sensitive, 0, "report tickets stay non-sensitive (decision 6)");
    assert.equal(ticketRow.status, "open");
    assert.equal(ticketRow.creator_user_id, env.reporter.id);
    assert.equal(ticketRow.opened_by_staff_id, env.reporter.id);

    // The reported user never joined the ticket.
    const memberIds = api.db
      .prepare(`SELECT user_id FROM ticket_members WHERE ticket_id=?`)
      .all(ticketRow.id)
      .map((row) => row.user_id);
    assert.ok(memberIds.includes(env.reporter.id), "reporter participates");
    assert.ok(!memberIds.includes(env.subject.id), "reported user is NEVER a participant");

    // -- the message was REALLY deleted, after the evidence posted ----------
    assert.equal(env.reportedMessage.deleted, true);
    assert.ok(
      env.sourceChannel._deletedMessages.includes(env.reportedMessage.id),
      "channel-level delete recorded",
    );

    // -- ticket_reports row (decision 13) ------------------------------------
    const row = api.getTicketReport(ticketRow.id);
    assert.ok(row);
    assert.equal(row.kind, "message");
    assert.equal(row.subject_user_id, env.subject.id, "subject = the message author");
    assert.equal(row.reported_message_id, env.reportedMessage.id);
    assert.equal(row.source_channel_id, env.sourceChannel.id);
    assert.equal(row.message_deleted, 1, "row flag matches the successful delete");
    assert.equal(row.snapshot_note, null, "clean run leaves no note");

    // -- evidence message in the ticket channel (decisions 4/15) -------------
    const ticketChannel = ticketChannelFor(env);
    const evidence = sentEvidencePayload(env);
    assert.ok(evidence, "the evidence message (embeds + files) posted");
    assert.ok(Array.isArray(evidence.files), "files array passed through to send");
    const evidenceText = payloadText(evidence);
    assert.ok(evidenceText.includes("Reported message evidence"), "header embed present");
    assert.ok(evidenceText.includes(env.reportedMessage.content), "message content preserved");
    assert.ok(evidenceText.includes(env.reporter.id), "reporter recorded");
    assert.ok(
      evidenceText.includes(`Original message deleted by <@${env.reporter.id}> via this ticket`),
      "decision-13 deleted-by line names the staff actor (audit log shows only 'bot')",
    );

    // -- audit (decision 13) --------------------------------------------------
    assert.equal(r.audits.length, 1);
    const audit = r.audits[0];
    assert.equal(audit.action, "tickets.report_message");
    assert.equal(audit.communityId, communityKey(env.guildId));
    assert.equal(audit.targetType, "ticket");
    assert.equal(audit.targetId, String(ticketRow.id));
    assert.equal(audit.details.ticket_number, ticketRow.ticket_number);
    assert.equal(audit.details.subject_user_id, env.subject.id);
    assert.equal(audit.details.reported_message_id, env.reportedMessage.id);
    assert.equal(audit.details.message_deleted, 1);
    assert.equal(audit.details.channel_id, ticketChannel.id);

    // -- ephemeral confirmation -------------------------------------------------
    assert.ok(interaction.deferred, "ephemeral defer ran before the REST work");
    const final = interaction.replies[interaction.replies.length - 1];
    assert.ok(final._edited, "confirmation edits the deferred reply");
    assert.match(final.content, new RegExp(`Ticket \\*\\*#${ticketRow.ticket_number}\\*\\*`));
    assert.ok(final.content.includes(`<#${ticketChannel.id}>`), "channel link");
    assert.ok(
      !/could not|not understood|delete failed|already reported/i.test(final.content),
      "clean run carries no anomaly lines",
    );
  });

  it("no → keep: evidence carries the kept line with the jump link, delete step never runs", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    spyDelete(env.reportedMessage, r.order);
    const token = putMessageReport(env);

    const interaction = makeSubmit({ env, token, del: "no" });
    await report.handleReportMessageModal(interaction, RUN_CTX(env), {
      deps: r.deps,
    });

    assert.deepEqual(r.order, ["create", "evidence", "audit"], "the delete step is skipped entirely");
    assert.equal(env.reportedMessage.deleted, false);
    assert.equal(reportRowFor(env).message_deleted, 0);
    const evidenceText = payloadText(sentEvidencePayload(env));
    assert.ok(evidenceText.includes("Original kept:"), "decision-13 kept line");
    assert.ok(evidenceText.includes(jumpUrlOf(env)), "kept line carries the jump link");
    assert.equal(sentNotePayloads(env).length, 0, "a clean keep posts no notes");
  });
});

// ---------- delete failure (rules 3 + 5) ----------

describe("report message submit — delete failure keeps the ticket AND corrects the record", () => {
  it("delete rejects: message_deleted 0, ⚠ correction posted into the ticket, reply warning, audit still records", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    spyDelete(env.reportedMessage, r.order, new Error("Missing Permissions"));
    const token = putMessageReport(env);

    const interaction = makeSubmit({ env, token, del: "yes" });
    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportMessageModal(interaction, RUN_CTX(env), { deps: r.deps });
    } finally {
      restore();
    }

    // Evidence landed BEFORE the delete was attempted (order preserved).
    assert.ok(r.order.includes("evidence") && r.order.includes("delete"));
    assert.ok(r.order.indexOf("evidence") < r.order.indexOf("delete"));
    assert.ok(r.order.indexOf("delete") < r.order.indexOf("note"), "the correction follows the delete failure");

    // The message stands.
    assert.equal(env.reportedMessage.deleted, false);

    // Row + audit carry the ACTUAL outcome (0), not the intent.
    const row = reportRowFor(env);
    assert.equal(row.message_deleted, 0, "row flag matches the failed delete");
    assert.equal(r.audits.length, 1);
    assert.equal(r.audits[0].details.message_deleted, 0);

    // Rule 5: the embed's deleted-claim is corrected IN the ticket — the
    // posted evidence (built before the delete) overstates, the note fixes it.
    const notes = sentNotePayloads(env);
    assert.equal(notes.length, 1, "exactly one correction note");
    const note = notes[0].content;
    assert.ok(note.includes("⚠ Delete failed: Missing Permissions"), note);
    assert.ok(note.includes("original message KEPT"), "the correction states the truth");
    assert.ok(note.includes(jumpUrlOf(env)), "the correction carries the jump link");

    // Rule 3: the reply names the specific cause AND the ticket ref (rule 5).
    const ticketRow = ticketRowFor(env);
    const final = interaction.replies[interaction.replies.length - 1];
    assert.match(final.content, new RegExp(`Ticket \\*\\*#${ticketRow.ticket_number}\\*\\*`));
    assert.match(final.content, /Delete failed: Missing Permissions/);
    assert.match(final.content, /original message KEPT/);

    // Rule 2: ids + cause logged.
    const log = lines.join("\n");
    assert.match(log, /\[tickets\] report message delete failed/);
    assert.match(log, new RegExp(`guild=${env.guildId}`));
    assert.match(log, /Missing Permissions/);
  });

  it("delete fetch 10008 (author already deleted it): honest failure path with the specific cause", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    const token = putMessageReport(env);
    // The author deletes the message between invoke and modal submit: the
    // real discord.js fetch REJECTS with 10008 — the failure must be specific.
    env.sourceChannel.messages.cache.delete(env.reportedMessage.id);

    const interaction = makeSubmit({ env, token, del: "yes" });
    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportMessageModal(interaction, RUN_CTX(env), { deps: r.deps });
    } finally {
      restore();
    }

    assert.equal(r.order.includes("delete"), false, "nothing was ever deleted through this flow");
    assert.equal(reportRowFor(env).message_deleted, 0);
    const notes = sentNotePayloads(env);
    assert.equal(notes.length, 1);
    assert.match(notes[0].content, /Delete failed: .*Unknown Message/);
    assert.match(lastReplyContent(interaction), /Delete failed/);
    assert.match(lines.join("\n"), /\[tickets\] report message delete failed/);
  });
});

// ---------- evidence failure → SKIP the delete entirely (locked) ----------

describe("report message submit — evidence failure skips the delete (decision 4)", () => {
  it("evidence post throws: delete NEVER called, ticket + row stand, specific cause in the reply", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder();
    spyDelete(env.reportedMessage, r.order);
    // Arm both sends the moment the handler creates the channel: the FIRST
    // is openTicketChannel's open-notice (helpers.js warns and keeps the
    // ticket — #421), the SECOND is the evidence message (our failure). The
    // handler's best-effort note (third send) lands.
    const realCreate = env.guild.channels.create.bind(env.guild.channels);
    env.guild.channels.create = async (data) => {
      const ch = await realCreate(data);
      ch.__failSends = [
        { message: "Missing Permissions", code: 50013 },
        { message: "Missing Permissions", code: 50013 },
      ];
      return ch;
    };
    const token = putMessageReport(env);

    const interaction = makeSubmit({ env, token, del: "yes" });
    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportMessageModal(interaction, RUN_CTX(env), { deps: r.deps });
    } finally {
      restore();
    }

    // LOCKED: evidence-post failure → the delete step NEVER runs.
    assert.equal(r.order.includes("delete"), false, "delete NEVER called after a failed evidence post");
    assert.equal(env.reportedMessage.deleted, false, "the original message stands");
    assert.ok(!env.sourceChannel._deletedMessages.includes(env.reportedMessage.id));

    // The ticket stands and the row records the truth (rule 5).
    const ticketRow = ticketRowFor(env);
    assert.ok(ticketRow, "the ticket was NOT lost to the evidence failure");
    const row = api.getTicketReport(ticketRow.id);
    assert.equal(row.kind, "message");
    assert.equal(row.message_deleted, 0);
    assert.match(row.snapshot_note, /Could not post the evidence/, "the row carries the failure summary");

    // The explanatory note made it into the ticket (third send succeeds).
    const notes = sentNotePayloads(env);
    assert.equal(notes.length, 1);
    assert.match(notes[0].content, /Could not post the evidence \(Missing Permissions\)/);
    assert.match(notes[0].content, /the original message was NOT deleted/);
    assert.ok(notes[0].content.includes(jumpUrlOf(env)), "note carries the jump link");

    // Rule 3: the reply carries the specific cause + ticket ref.
    const final = interaction.replies[interaction.replies.length - 1];
    assert.match(final.content, new RegExp(`Ticket \\*\\*#${ticketRow.ticket_number}\\*\\*`));
    assert.match(final.content, /Could not post the evidence/);
    assert.match(final.content, /Missing Permissions/, "specific cause in the reply");
    assert.match(final.content, /NOT deleted/);

    // Rules 2 + 13: logged with ids, audit still records the opened ticket.
    assert.match(lines.join("\n"), /\[tickets\] report message evidence post failed/);
    assert.match(lines.join("\n"), new RegExp(`guild=${env.guildId}`));
    assert.equal(r.audits.length, 1);
    assert.equal(r.audits[0].details.message_deleted, 0);
  });

  it("evidence build refused (ok:false): no evidence send, no delete, note + reply name the cause", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder({
      buildEvidenceMessage: async () => ({
        ok: false,
        error: "forced: Evidence snapshot is missing its source channel id",
      }),
    });
    spyDelete(env.reportedMessage, r.order);
    const token = putMessageReport(env);

    const interaction = makeSubmit({ env, token, del: "yes" });
    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportMessageModal(interaction, RUN_CTX(env), { deps: r.deps });
    } finally {
      restore();
    }

    // No "evidence" (nothing posted) and NO "delete" — ever (locked gate).
    assert.deepEqual(r.order, ["create", "note", "audit"]);
    assert.equal(env.reportedMessage.deleted, false);

    const row = reportRowFor(env);
    assert.equal(row.message_deleted, 0);
    assert.match(row.snapshot_note, /forced: Evidence snapshot/);

    const notes = sentNotePayloads(env);
    assert.equal(notes.length, 1);
    assert.match(notes[0].content, /Could not post the evidence \(forced: Evidence snapshot/);

    assert.match(lastReplyContent(interaction), /forced: Evidence snapshot/);
    assert.match(lastReplyContent(interaction), /the original message was NOT deleted/);
    assert.match(lines.join("\n"), /\[tickets\] report message evidence build failed/);
    assert.equal(r.audits.length, 1, "the mutation (opened ticket) is audited regardless");
  });
});

// ---------- duplicate-open-report nudge (decision 12) ----------

describe("report message submit — duplicate nudge (decision 12: still creates, names the first)", () => {
  it("second open report on the same message creates a ticket AND links the first", async () => {
    const env = makeMessageEnv();
    // Seed a prior OPEN report for the same message via the real DB.
    const cid = communityKey(env.guildId);
    const first = api.createTicket({
      communityId: cid,
      creatorUserId: env.reporter.id,
      channelId: snowflake(),
      reason: "prior report on the same post",
      openedByStaffId: env.reporter.id,
    });
    const seeded = api.insertTicketReport({
      ticketId: first.id,
      kind: "message",
      subjectUserId: env.subject.id,
      reportedMessageId: env.reportedMessage.id,
      sourceChannelId: env.sourceChannel.id,
    });
    assert.ok(seeded.ok, "seed row landed");

    const r = makeRecorder();
    spyDelete(env.reportedMessage, r.order);
    const token = putMessageReport(env);

    const interaction = makeSubmit({ env, token, del: "no" });
    await report.handleReportMessageModal(interaction, RUN_CTX(env), {
      deps: r.deps,
    });

    // Decision 12: the nudge NEVER blocks — a second ticket exists.
    assert.equal(countRows("tickets", env), 2, "the second report STILL creates");
    assert.equal(countRows("ticket_reports", env), 2);

    const final = lastReplyContent(interaction);
    assert.match(final, /Already reported on this message/);
    assert.ok(
      final.includes(`**#${first.ticket_number}**`),
      `names the first ticket ref (#${first.ticket_number})`,
    );
    assert.ok(final.includes(`<#${first.channel_id}>`), "links the first ticket's channel");
    // The new ticket is named too (the report itself succeeded).
    assert.match(final, new RegExp(`Ticket \\*\\*#${first.ticket_number + 1}\\*\\* opened`));
  });
});

// ---------- side-record failure (rules 3 + 5) ----------

describe("report message submit — partial failures keep the ticket and name the cause", () => {
  it("report-record insert failure: ticket stands, ref + specific failure in the reply, cause logged", async () => {
    const env = makeMessageEnv();
    const r = makeRecorder({
      insertTicketReport: () => ({
        ok: false,
        error: "forced: UNIQUE constraint failed: ticket_reports.ticket_id",
      }),
    });
    spyDelete(env.reportedMessage, r.order);
    const token = putMessageReport(env);

    const interaction = makeSubmit({ env, token, del: "no" });
    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportMessageModal(interaction, RUN_CTX(env), { deps: r.deps });
    } finally {
      restore();
    }

    const log = lines.join("\n");
    assert.match(log, /\[tickets\] report message record failed/);
    assert.match(log, new RegExp(`guild=${env.guildId}`));
    assert.match(log, /UNIQUE constraint failed/, "cause logged (rule 2)");

    const ticketRow = ticketRowFor(env);
    assert.ok(ticketRow, "the ticket was NOT lost");
    assert.equal(countRows("ticket_reports", env), 0, "the failed row really is absent");

    // Rule 5: partial result — ticket ref AND the failure cause.
    const final = interaction.replies[interaction.replies.length - 1];
    assert.ok(final._edited);
    assert.match(final.content, new RegExp(`Ticket \\*\\*#${ticketRow.ticket_number}\\*\\*`));
    assert.match(final.content, /Could not save the report record/);
    assert.match(final.content, /UNIQUE constraint failed/, "specific cause rides into the reply");
    assert.match(final.content, /the ticket itself is intact/);
    // The audit still records the happened mutation.
    assert.equal(r.audits.length, 1);
    assert.equal(r.audits[0].action, "tickets.report_message");
  });

  it("ticket-create failure: the translated cause IS the reply, nothing else runs", async () => {
    const env = makeMessageEnv();
    const boom = async () => {
      const err = new Error(
        "Discord rejected channel creation (**Missing Permissions**). Check:\n1. Bot role has **Manage Channels**",
      );
      err.code = "CHANNEL_CREATE";
      throw err;
    };
    const r = makeRecorder({ openTicketChannel: boom });
    spyDelete(env.reportedMessage, r.order);
    const token = putMessageReport(env);

    const interaction = makeSubmit({ env, token, del: "yes" });
    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportMessageModal(interaction, RUN_CTX(env), { deps: r.deps });
    } finally {
      restore();
    }

    assert.match(lines.join("\n"), /\[tickets\] report ticket open failed/);
    assert.match(lines.join("\n"), new RegExp(`guild=${env.guildId}`));

    const final = interaction.replies[interaction.replies.length - 1];
    assert.ok(final._edited, "delivered on the deferred ephemeral");
    assert.match(final.content, /Missing Permissions/, "translated create cause verbatim (rule 3)");
    assert.equal(countRows("tickets", env), 0);
    assert.equal(countRows("ticket_reports", env), 0);
    assert.equal(env.reportedMessage.deleted, false, "no delete without a ticket");
    assert.deepEqual(r.audits, [], "nothing was audited that did not happen");
  });
});
