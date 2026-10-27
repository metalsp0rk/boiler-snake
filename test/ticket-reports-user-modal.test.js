/**
 * Unit tests for the "Report User" modal submit (#745 subtask 06):
 * src/features/tickets/report.js — handleReportUserModal + openReportTicket.
 *
 * House style follows test/ticket-reports-invoke.test.js: real db facade on
 * a temp SQLite via loadDb(), real requireStaff gating, the process-wide
 * pendingReports singleton driven through its public put/take/count/reset
 * seams, and the shared ./helpers/discord modal-submit factory.
 *
 * Seam (per the subtask contract): the handler takes a third, TEST-only
 * `opts.deps` argument (createReportTicketDeps) — production goes through
 * the router with (interaction, ctx) only. openTicketChannel is SPIED by
 * wrapping the real helpers.openTicketChannel (argument capture + real
 * channel + real tickets row offline), recordSlashAudit / insertTicketReport
 * are stubbed or forced where a failure arm is under test.
 *
 * Covers (acceptance): expired token → specific ephemeral + openTicketChannel
 * NEVER called + zero tickets/ticket_reports rows; happy path → openTicketChannel
 * called with creatorUserId === openedByStaffId === reporter, NO DM, ticket
 * row is_sensitive 0 + reported user absent from ticket_members,
 * ticket_reports row kind 'user' (subject, message_deleted 0, snapshot_note
 * null), the decision-7 evidence card carries the code-wrapped mention + raw
 * id + context, recordSlashAudit('tickets.report_user', …), the ephemeral
 * confirmation names ticket + channel; token consumed once; non-staff denial
 * before the token; submit-time bot/self re-checks; insert failure and
 * evidence-post failure keep the ticket and surface the cause (rules 3 + 5);
 * reason truncation with marker at MAX_TICKET_REASON.
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
 * of requireStaff), a reported member with its DM surface, and a plain
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
 * Deps seam per test: openTicketChannel SPY wrapping the real one (captures
 * the exact opts AND produces the real channel + real tickets row offline),
 * recordSlashAudit captured. Overrides (e.g. a failing insertTicketReport)
 * win per key.
 */
function makeHarness(overrides = {}) {
  const openCalls = [];
  const audits = [];
  const deps = {
    openTicketChannel: async (opts) => {
      openCalls.push(opts);
      return realHelpers.openTicketChannel(opts);
    },
    recordSlashAudit: (entry) => {
      audits.push(entry);
      return null;
    },
    ...overrides,
  };
  return { openCalls, audits, deps };
}

/** Seed a user-variant snapshot and return its modal token. */
function putUserReport(env, overrides = {}) {
  return pendingReports.putReport({
    kind: "user",
    guildId: env.guildId,
    reporterUserId: env.reporter.id,
    subjectUserId: env.subject.id,
    ...overrides,
  });
}

/** Modal submit carrying the tk:rep:u:<token> customId + context field. */
function makeSubmit({ env, token, context, user = env.reporter, member = env.reporterMember }) {
  return createModalSubmitInteraction({
    customId: constants.MODAL_REPORT_USER_PREFIX + token,
    guild: env.guild,
    user,
    member,
    client: env.client,
    channelId: env.sourceChannel.id,
    fields: {
      [constants.MODAL_REPORT_FIELD_CONTEXT]:
        context ?? "posting spam invite links in #general",
    },
  });
}

const RUN_CTX = (env) => ({ supervisor: { discord: env.client } });

// ---------- expired / unknown token ----------

describe("report user submit — token lifecycle (decision 3)", () => {
  it("expired token: specific ephemeral, openTicketChannel NEVER called, zero rows", async () => {
    const env = makeEnv();
    const h = makeHarness();
    // A capturedAt older than the TTL is the natural expiry path — the store
    // sweeps it on the next take, exactly like the bot-restart scenario.
    const token = putUserReport(env, {
      capturedAt: Date.now() - pendingReports.PENDING_REPORT_TTL_MS - 60_000,
    });
    assert.ok(token);

    const interaction = makeSubmit({ env, token });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /expired or was already used/i);
    assert.match(lastReplyContent(interaction), /run the command again/i, "rule 3: actionable");
    assert.ok(lastReplyEphemeral(interaction));
    assert.equal(interaction.deferred, false, "nothing deferred — the reply is direct");
    assert.deepEqual(h.openCalls, [], "no ticket open was attempted");
    assert.equal(countRows("tickets", env), 0);
    assert.equal(countRows("ticket_reports", env), 0);
    assert.equal(pendingReports.pendingReportCountForTests(), 0, "expired entry swept — nothing replayable");
    assert.deepEqual(h.audits, []);
  });

  it("unknown token (never minted): same specific expired reply, no side effects", async () => {
    const env = makeEnv();
    const h = makeHarness();

    const interaction = makeSubmit({ env, token: "f".repeat(32) });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    assert.match(lastReplyContent(interaction), /expired or was already used/i);
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(h.openCalls, []);
    assert.equal(countRows("tickets", env), 0);
  });

  it("a message-kind snapshot never rides the user prefix: expired reply, snapshot consumed", async () => {
    const env = makeEnv();
    const h = makeHarness();
    const token = pendingReports.putReport({
      kind: "message",
      guildId: env.guildId,
      reporterUserId: env.reporter.id,
      messageId: "999",
      channelId: env.sourceChannel.id,
      subjectUserId: env.subject.id,
    });

    const interaction = makeSubmit({ env, token });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    assert.match(lastReplyContent(interaction), /expired or was already used/i);
    assert.deepEqual(h.openCalls, []);
    assert.equal(countRows("tickets", env), 0);
    assert.equal(pendingReports.pendingReportCountForTests(), 0, "kind mismatch still burns the one-shot");
  });

  it("token is consumed once: a replayed submit gets the expired reply", async () => {
    const env = makeEnv();
    const h = makeHarness();
    const token = putUserReport(env);

    const first = makeSubmit({ env, token });
    await report.handleReportUserModal(first, RUN_CTX(env), { deps: h.deps });
    assert.equal(h.openCalls.length, 1);

    const second = makeSubmit({ env, token });
    await report.handleReportUserModal(second, RUN_CTX(env), { deps: h.deps });

    assert.match(lastReplyContent(second), /expired or was already used/i);
    assert.ok(lastReplyEphemeral(second));
    assert.equal(h.openCalls.length, 1, "the replay opened no second ticket");
    assert.equal(countRows("tickets", env), 1);
    assert.equal(countRows("ticket_reports", env), 1);
  });
});

// ---------- staff gate on the submitter ----------

describe("report user submit — staff gate (submitter is authoritative)", () => {
  it("non-staff submitter: standard denial, token untouched, zero rows", async () => {
    const env = makeEnv();
    const h = makeHarness();
    const token = putUserReport(env);

    const interaction = makeSubmit({
      env,
      token,
      user: env.plain,
      member: env.plainMember,
    });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /don't have permission/);
    assert.ok(lastReplyEphemeral(interaction));
    assert.equal(interaction.deferred, false);
    assert.deepEqual(h.openCalls, []);
    assert.equal(countRows("tickets", env), 0);
    assert.equal(countRows("ticket_reports", env), 0);
    // The gate runs BEFORE take(): the staff member's own token stays valid.
    assert.equal(pendingReports.pendingReportCountForTests(), 1);
  });

  it("submitter who lost staff status after the invoke is denied (re-check, not the invoke's word)", async () => {
    const env = makeEnv();
    const h = makeHarness();
    // Snapshot names the reporter as the staff invoker…
    const token = putUserReport(env);
    // …but on SUBMIT the same member is no longer staff: admin bits flipped
    // off and no staff_roles row exists for them.
    env.reporterMember.setAdmin(false);

    const interaction = makeSubmit({ env, token });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    assert.match(lastReplyContent(interaction), /don't have permission/);
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(h.openCalls, []);
    assert.equal(countRows("tickets", env), 0);
  });
});

// ---------- submit-time subject guards ----------

describe("report user submit — defensive bot/self re-checks (decision 7)", () => {
  it("snapshot subject resolved as a bot: handleFor-mirroring reply, no ticket", async () => {
    const env = makeEnv();
    const h = makeHarness();
    const botSubject = createUser({ id: snowflake(), username: "fauna", bot: true });
    env.guild.addMember(createMember({ guild: env.guild, user: botSubject }));
    const token = putUserReport(env, { subjectUserId: botSubject.id });

    const interaction = makeSubmit({ env, token });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    assert.equal(interaction.replies.length, 1);
    assert.equal(lastReplyContent(interaction), "Cannot open a ticket for a bot.");
    assert.ok(lastReplyEphemeral(interaction));
    assert.equal(interaction.deferred, false);
    assert.deepEqual(h.openCalls, []);
    assert.equal(countRows("tickets", env), 0);
  });

  it("snapshot subject is the submitter: self-report reply mirrors the invoke copy, no ticket", async () => {
    const env = makeEnv();
    const h = makeHarness();
    const token = putUserReport(env, { subjectUserId: env.reporter.id });

    const interaction = makeSubmit({ env, token });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /can't report yourself/i);
    assert.match(lastReplyContent(interaction), /\/ticket create/);
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(h.openCalls, []);
    assert.equal(countRows("tickets", env), 0);
  });

  it("snapshot subject without an id: specific unresolvable reply, no ticket", async () => {
    const env = makeEnv();
    const h = makeHarness();
    const token = putUserReport(env, { subjectUserId: null });

    const interaction = makeSubmit({ env, token });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /could not resolve the reported member/i);
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(h.openCalls, []);
  });
});

// ---------- happy path ----------

describe("report user submit — happy path (decision 5 ticket, decision 7 card, decision 13 audit)", () => {
  it("opens the staff-self ticket, records the report, cards the channel, audits, confirms", async () => {
    const env = makeEnv();
    const h = makeHarness();
    const context = "spamming invite links across #general, see profile";
    const token = putUserReport(env);

    const interaction = makeSubmit({ env, token, context });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    // -- openTicketChannel contract (locked decision 5) --------------------
    assert.equal(h.openCalls.length, 1);
    const open = h.openCalls[0];
    assert.equal(open.creatorUserId, env.reporter.id);
    assert.equal(open.openedByStaffId, env.reporter.id, "staff-self branch (helpers.js ~L765)");
    assert.equal(open.creatorUserId, open.openedByStaffId);
    assert.equal(open.guild, env.guild);
    assert.equal(open.client, env.client, "client resolves via ctx.supervisor.discord");
    assert.ok(Number.isInteger(open.communityId), "community id resolved at the Discord edge");
    assert.equal(open.reason, context, "the context IS the ticket reason");

    // -- NEVER DM (decision 5): nobody received a DM ------------------------
    assert.deepEqual(env.subject.sends, [], "the reported user is NEVER DM'd");
    assert.deepEqual(env.reporter.sends, [], "the reporter is not DM'd either");

    // -- tickets row ---------------------------------------------------------
    const communityId = communityKey(env.guildId);
    const ticketRow = api.db
      .prepare(`SELECT * FROM tickets WHERE community_id=?`)
      .get(communityId);
    assert.ok(ticketRow, "the real openTicketChannel pipeline wrote the row");
    assert.equal(ticketRow.is_sensitive, 0, "report tickets stay non-sensitive (decision 6)");
    assert.equal(ticketRow.status, "open");
    assert.equal(ticketRow.creator_user_id, env.reporter.id);
    assert.equal(ticketRow.opened_by_staff_id, env.reporter.id);
    assert.equal(ticketRow.reason, context);

    // The reported user never joined the ticket.
    const memberIds = api.db
      .prepare(`SELECT user_id FROM ticket_members WHERE ticket_id=?`)
      .all(ticketRow.id)
      .map((r) => r.user_id);
    assert.ok(memberIds.includes(env.reporter.id), "reporter participates");
    assert.ok(!memberIds.includes(env.subject.id), "reported user is NEVER a participant");

    // -- ticket_reports row (decision 13) -----------------------------------
    const reportRow = api.getTicketReport(ticketRow.id);
    assert.ok(reportRow);
    assert.equal(reportRow.kind, "user");
    assert.equal(reportRow.subject_user_id, env.subject.id);
    assert.equal(reportRow.message_deleted, 0);
    assert.equal(reportRow.snapshot_note, null, "context lives on reason + card, not the row");

    // -- evidence card in the ticket channel (decision 7) -------------------
    const ticketChannel = env.guild.channels.created[0];
    assert.ok(ticketChannel, "the staff-self ticket channel was created");
    assert.ok(
      ticketChannel.sent.length >= 2,
      "open-notice first, then the card",
    );
    const card = ticketChannel.sent.find((p) => payloadText(p).includes("Reported user"));
    assert.ok(card, "the reported-user card was posted");

    const cardText = payloadText(card);
    assert.ok(
      cardText.includes(`\`<@!${env.subject.id}>\``),
      "mention rendered INSIDE inline code (inert, transcript-safe)",
    );
    assert.ok(cardText.includes(`ID: \`${env.subject.id}\``), "raw id line present");
    assert.ok(cardText.includes(env.reporter.id), "reporter recorded");
    assert.ok(cardText.includes(`\`${env.reporter.id}\``) === false, "reporter is a LIVE mention, not code");
    assert.ok(/<t:\d+:F>/.test(cardText), "report timestamp renders as a Discord timestamp");
    assert.ok(cardText.includes(context), "context text present");
    // Context sits in a fenced block: raw planted mentions stay byte-visible
    // but inert — assert the fence around a hostile context instead (below).
    assert.deepEqual(
      card.allowedMentions?.users,
      [env.reporter.id],
      "only the reporter may be pinged — the subject never",
    );

    // -- audit (decision 13) -------------------------------------------------
    assert.equal(h.audits.length, 1);
    const audit = h.audits[0];
    assert.equal(audit.action, "tickets.report_user");
    assert.equal(audit.communityId, communityId);
    assert.equal(audit.targetType, "ticket");
    assert.equal(audit.targetId, String(ticketRow.id));
    assert.equal(audit.details.ticket_number, ticketRow.ticket_number);
    assert.equal(audit.details.subject_user_id, env.subject.id);
    assert.equal(audit.details.channel_id, ticketChannel.id);

    // -- ephemeral confirmation ----------------------------------------------
    assert.ok(interaction.deferred, "ephemeral defer ran before the REST work");
    const final = interaction.replies[interaction.replies.length - 1];
    assert.ok(final._edited, "confirmation edits the deferred reply");
    assert.match(final.content, new RegExp(`Ticket \\*\\*#${ticketRow.ticket_number}\\*\\*`));
    assert.ok(final.content.includes(`<#${ticketChannel.id}>`), "channel link");
    assert.ok(!/could not/i.test(final.content), "clean run carries no failure lines");
  });

  it("hostile context stays fenced and inert, and the reporter still reads as staff-self", async () => {
    const env = makeEnv();
    const h = makeHarness();
    const context = "ping me at @everyone ``` or <@400000000000000999> ```";
    const token = putUserReport(env);

    const interaction = makeSubmit({ env, token, context });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    const ticketChannel = env.guild.channels.created[0];
    const card = ticketChannel.sent.find((p) => payloadText(p).includes("Reported user"));
    const description = card.embeds[0].toJSON().description;
    assert.ok(description.startsWith("````"), "fence longer than the planted backtick run");
    assert.ok(description.includes(context), "raw context preserved as evidence");
    assert.ok(!/\n```\n/.test(description), "the planted fence cannot close its own block");
    assert.deepEqual(card.allowedMentions?.users, [env.reporter.id]);
  });

  it("context beyond MAX_TICKET_REASON is cut at the DB cap with an ellipsis marker", async () => {
    const env = makeEnv();
    const h = makeHarness();
    const context = "a".repeat(4000); // the modal field's full budget
    const token = putUserReport(env);

    const interaction = makeSubmit({ env, token, context });
    await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });

    assert.equal(h.openCalls.length, 1);
    assert.equal(h.openCalls[0].reason.length, api.MAX_TICKET_REASON);
    assert.ok(h.openCalls[0].reason.endsWith("…"), "truncation carries a marker");

    const communityId = communityKey(env.guildId);
    const ticketRow = api.db.prepare(`SELECT reason FROM tickets WHERE community_id=?`).get(communityId);
    assert.equal(ticketRow.reason.length, api.MAX_TICKET_REASON, "reason stored inside the DB cap");
  });
});

// ---------- partial failures (rules 3 + 5) ----------

describe("report user submit — partial failures keep the ticket and name the cause", () => {
  it("report-record insert failure: ticket stands, ref + specific failure in the reply, cause logged", async () => {
    const env = makeEnv();
    const h = makeHarness({
      insertTicketReport: () => ({
        ok: false,
        error: "forced: UNIQUE constraint failed: ticket_reports.ticket_id",
      }),
    });
    const token = putUserReport(env);

    const interaction = makeSubmit({ env, token });
    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });
    } finally {
      restore();
    }

    const log = lines.join("\n");
    assert.match(log, /\[tickets\] report user record failed/);
    assert.match(log, new RegExp(`guild=${env.guildId}`));
    assert.match(log, /UNIQUE constraint failed/, "cause logged (rule 2)");

    // The ticket + card exist despite the record failure (rule 5).
    const communityId = communityKey(env.guildId);
    const ticketRow = api.db.prepare(`SELECT * FROM tickets WHERE community_id=?`).get(communityId);
    assert.ok(ticketRow, "the ticket was NOT lost");
    assert.equal(countRows("ticket_reports", env), 0, "the failed row really is absent");
    const ticketChannel = env.guild.channels.created[0];
    assert.ok(
      ticketChannel.sent.some((p) => payloadText(p).includes("Reported user")),
      "the card still posted",
    );

    // Rule 5: partial result reported — ticket ref AND the failure cause.
    const final = interaction.replies[interaction.replies.length - 1];
    assert.ok(final._edited);
    assert.match(final.content, new RegExp(`Ticket \\*\\*#${ticketRow.ticket_number}\\*\\*`));
    assert.match(final.content, /Could not save the report record/);
    assert.match(final.content, /UNIQUE constraint failed/, "specific cause rides into the reply");
    assert.match(final.content, /the ticket itself is intact/);
    // The audit still records the happened mutation.
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0].action, "tickets.report_user");
  });

  it("evidence-card post failure: ticket + record stand, the reply names the post failure", async () => {
    const env = makeEnv();
    const h = makeHarness();
    // Arm both sends the moment the handler creates the channel: the FIRST
    // is openTicketChannel's open-notice (helpers.js warns and keeps the
    // ticket — #421), the SECOND is the evidence card (our partial failure).
    const realCreate = env.guild.channels.create.bind(env.guild.channels);
    env.guild.channels.create = async (data) => {
      const ch = await realCreate(data);
      ch.__failSends = [
        { message: "Missing Permissions", code: 50013 },
        { message: "Missing Permissions", code: 50013 },
      ];
      return ch;
    };
    const token = putUserReport(env);

    const interaction = makeSubmit({ env, token });
    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });
    } finally {
      restore();
    }

    const log = lines.join("\n");
    assert.match(log, /\[tickets\] report user evidence post failed/);
    assert.match(log, new RegExp(`guild=${env.guildId}`), "ids on the failure log (rule 2)");

    const communityId = communityKey(env.guildId);
    const ticketRow = api.db.prepare(`SELECT * FROM tickets WHERE community_id=?`).get(communityId);
    assert.ok(ticketRow, "the ticket was NOT lost to the send failure");
    const row = api.getTicketReport(ticketRow.id);
    assert.equal(row.kind, "user", "the side record still landed");

    // Rule 5: partial result — ticket ref AND the specific post failure.
    const final = interaction.replies[interaction.replies.length - 1];
    assert.match(final.content, new RegExp(`Ticket \\*\\*#${ticketRow.ticket_number}\\*\\*`));
    assert.match(final.content, /Could not post the evidence card/);
    assert.match(final.content, /Missing Permissions/, "specific cause in the reply (rule 3)");
  });

  it("ticket-create failure: the translated cause IS the reply and nothing else happens", async () => {
    const env = makeEnv();
    const boom = async (opts) => {
      const err = new Error(
        "Discord rejected channel creation (**Missing Permissions**). Check:\n1. Bot role has **Manage Channels**",
      );
      err.code = "CHANNEL_CREATE";
      throw err;
    };
    const h = makeHarness({ openTicketChannel: boom });
    const token = putUserReport(env);

    const interaction = makeSubmit({ env, token });
    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportUserModal(interaction, RUN_CTX(env), { deps: h.deps });
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
    assert.deepEqual(h.audits, [], "nothing was audited that did not happen");
  });
});
