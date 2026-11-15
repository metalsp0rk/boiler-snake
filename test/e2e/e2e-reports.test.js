const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll } = require("./helpers/mockenv");

/**
 * Tier-4 coverage for the Apps-menu report flows (#745: "Report Post" /
 * "Report User", plus the #794 "Open ticket for user" twin) — previously
 * unreachable because the mock could not execute context-menu commands.
 * The fauxcord patch now simulates ApplicationCommandType USER/MESSAGE
 * invocations (`target_id` + real-Discord `data.resolved`; boiler-snake
 * issue #757), and the REAL router branches (decision 9) + report handlers
 * + modal submits run end-to-end here on gateway payloads.
 *
 * Honest scope notes:
 *  - "Zero DMs to the reported user" is proven at tier-4 by the STRONGEST
 *    available form since #328 gap 7: the DM channel row IS the evidence,
 *    so GET /users/@me/channels simply never lists one for the subject
 *    (plus the card's inert code mention and the ticket-membership belt).
 *  - Evidence FILE re-upload (attachment bytes) is pinned offline by the
 *    integration tier (#754); content snapshots run live here.
 * Namespace 25.
 */
describe("e2e: context-menu reports (Report Post / Report User / Open-ticket-for-user)", { concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
  let env;

  /** shared arc state (suite runs serially) */
  let firstModal = null; // { invoke, state, customId } for the 'no' submit
  let firstReport = null; // { number, channelId, messageId }
  let keptSnapshotNoteTicket = null;

  before(async () => {
    env = await createE2eEnv({ ns: 25 });
    // senior-staff operator (requireStaff is the security source of truth;
    // the picker tier on the menu commands is cosmetic).
    const role = await env.mock.createRole("E2E Report Staff");
    await env.mock.grantRole(env.ids.human, role.id);
    env.dbmod.addStaffRole(env.communityId, String(role.id), "senior");
    // Bot role strictly above the staff role → ticket-channel overwrites
    // treat it as manageable (same hierarchy rule ns23 relies on).
    const botAdmin = await env.mock.createRole("E2E Bot Admin");
    await env.mock.grantRole(env.ids.app, botAdmin.id);
  });

  after(async () => {
    await env?.cleanup();
  });

  /** Poll the stored interaction until the bot's callback is persisted. */
  async function awaitCallback(interactionId, cbType, label) {
    return poll(
      async () => {
        const state = await env.mock.interactionState(interactionId);
        return state.response_json?.type === cbType ? state : null;
      },
      { timeoutMs: 8000, label: label || `callback type ${cbType}` },
    );
  }

  /** Flattened text-input custom_ids of a stored modal-display callback. */
  function modalFields(state) {
    return (state.response_json?.data?.components ?? [])
      .flatMap((row) => row.components ?? [])
      .filter((c) => c.type === 4)
      .map((c) => c.custom_id);
  }

  /**
   * Full Report Post flow: invoke the menu on a message → await the type-9
   * modal → submit with the given answers → await the settled reply.
   */
  async function reportPost(messageId, { context, deleteAnswer, userId }) {
    const invoke = await env.mock.contextMenu({
      command: "Report Post",
      targetId: messageId,
      ...(userId && { userId }),
    });
    const state = await awaitCallback(invoke.id, 9, "report modal display");
    const customId = state.response_json.data.custom_id;
    const submit = await env.mock.modal({
      customId,
      fields: {
        rep_context: context,
        rep_delete: deleteAnswer,
      },
      ...(userId && { userId }),
    });
    return { invoke, state, customId, submit, reply: await env.mock.awaitSettledReply(submit) };
  }

  /** ticket_reports row for a ticket number. */
  function reportRowFor(number) {
    return env.dbmod.db
      .prepare(
        `SELECT tr.* FROM ticket_reports tr
         JOIN tickets t ON t.id = tr.ticket_id
         WHERE t.ticket_number = ?`,
      )
      .get(number);
  }

  /** Fidelity messages of the given ticket channel (REST, embeds intact). */
  async function channelMessages(channelId) {
    return env.mock.messages(channelId);
  }

  /** Find the evidence embed message in a channel (title match). */
  async function findEmbed(channelId, title) {
    const msgs = await channelMessages(channelId);
    return (
      msgs.find((m) =>
        (m.embeds ?? []).some((e) => String(e.title ?? "") === title),
      ) ?? null
    );
  }

  // ── registration fidelity ────────────────────────────────────────────────

  it("registers the Apps-menu commands with the staff picker tier", async () => {
    const rows = await env.mock.listGuildCommands();
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.equal(byName["Report Post"]?.type, 3, "MESSAGE menu registered");
    assert.equal(byName["Report User"]?.type, 2, "USER menu registered");
    assert.equal(byName["Open ticket for user"]?.type, 2, "#794 twin registered");
    for (const name of ["Report Post", "Report User", "Open ticket for user"]) {
      assert.equal(
        String(byName[name]?.default_member_permissions),
        String(PermissionFlagsBits.ManageGuild),
        `${name} carries the ManageGuild picker tier`,
      );
    }
  });

  // ── gate: the handlers are the security source of truth ─────────────────

  it("refuses a non-staff invoke BEFORE reading the target (no modal)", async () => {
    const msg = await env.mock.inject("outright post", env.ids.target);
    const invoke = await env.mock.contextMenu({
      command: "Report Post",
      targetId: msg.id,
      userId: env.ids.outsider,
    });
    const reply = await env.mock.awaitReply(invoke);
    assert.equal(
      String(reply.content),
      "You don't have permission to use this.",
      "standard staff denial",
    );
    const state = await env.mock.interactionState(invoke.id);
    assert.equal(state.response_json?.type, 4, "denial reply, never a modal");
  });

  // ── Report Post: invoke → modal → submit 'no' ───────────────────────────

  it("Report Post invoke shows the two-field report modal (one-shot token in custom_id)", async () => {
    const msg = await env.mock.inject("harassment in the open", env.ids.target);
    firstReport = { messageId: msg.id };
    const invoke = await env.mock.contextMenu({
      command: "Report Post",
      targetId: msg.id,
    });
    const state = await awaitCallback(invoke.id, 9, "modal display");
    assert.match(
      state.response_json.data.custom_id,
      /^tk:rep:m:[0-9a-f]{32}$/,
      "modal custom_id carries the 32-hex one-shot token (decision 3)",
    );
    assert.deepEqual(
      modalFields(state),
      ["rep_context", "rep_delete"],
      "context + required delete fields, in order",
    );
    assert.equal(
      state.initial_response_message_id,
      null,
      "modal display creates no message",
    );
    firstModal = { invoke, state, customId: state.response_json.data.custom_id };
    firstReport.customId = firstModal.customId;
  });

  it("submit 'no': ticket opens, evidence posts, ORIGINAL SURVIVES (decision 4/2)", async () => {
    const submit = await env.mock.modal({
      customId: firstModal.customId,
      fields: { rep_context: "harassment in #general", rep_delete: "no" },
    });
    const reply = await env.mock.awaitSettledReply(submit);
    const m = /Ticket \*\*#(\d+)\*\* opened: <#(\d+)>/.exec(String(reply.content));
    assert.ok(m, `success reply with ticket ref + channel (got: ${reply.content})`);
    const [, number, channelId] = m;
    firstReport.number = Number(number);
    firstReport.channelId = channelId;

    // Ticket row: reporter is creator AND opener (decision 5 staff-self
    // branch), reason is the modal context, NEVER sensitive (decision 6).
    const ticket = env.dbmod.getTicketByChannel(env.communityId, channelId);
    assert.equal(ticket.creator_user_id, env.ids.human);
    assert.equal(ticket.reason, "harassment in #general");
    assert.equal(ticket.is_sensitive, 0, "decision 6: reports are never sensitive");

    // Side record (decision 13).
    const rec = reportRowFor(number);
    assert.equal(rec.kind, "message");
    assert.equal(rec.subject_user_id, env.ids.target);
    assert.equal(rec.reported_message_id, firstReport.messageId);
    assert.equal(rec.source_channel_id, env.ids.general);
    assert.equal(rec.message_deleted, 0);

    // Evidence embed in the ticket channel with the KEPT disposition line.
    const evidence = await findEmbed(channelId, "Reported message evidence");
    assert.ok(evidence, "evidence embed posted");
    const fields = Object.fromEntries(
      (evidence.embeds[0].fields ?? []).map((f) => [f.name, f.value]),
    );
    assert.match(String(fields.Disposition), /^Original kept: https:\/\//);
    assert.equal(String(fields["Message ID"]), firstReport.messageId);

    // The original message STANDS (kept path).
    const original = await env.mock.message(firstReport.messageId);
    assert.equal(original.id, firstReport.messageId);

    // Audit trail (decision 13).
    const audit = env.dbmod.db
      .prepare(
        "SELECT details_json FROM admin_audit WHERE action = ? ORDER BY id DESC LIMIT 1",
      )
      .get("tickets.report_message");
    const details = JSON.parse(audit.details_json);
    assert.equal(details.message_deleted, 0);
    assert.equal(details.subject_user_id, env.ids.target);
    assert.equal(details.reported_message_id, firstReport.messageId);
  });

  // ── Report Post: submit 'yes' — evidence-before-delete ──────────────────

  it("submit 'yes': evidence posts FIRST, then the original is deleted (decision 4)", async () => {
    const msg = await env.mock.inject("delete-worthy content", env.ids.target);
    const { reply } = await reportPost(msg.id, {
      context: "please remove",
      deleteAnswer: "yes",
    });
    const m = /Ticket \*\*#(\d+)\*\* opened: <#(\d+)>/.exec(String(reply.content));
    assert.ok(m, `opened reply (got: ${reply.content})`);
    const [, number, channelId] = m;

    // Record says the delete ACTUALLY happened.
    const rec = reportRowFor(number);
    assert.equal(rec.message_deleted, 1);

    // The embed was built with the FINAL disposition before the delete ran.
    const evidence = await findEmbed(channelId, "Reported message evidence");
    const fields = Object.fromEntries(
      (evidence.embeds[0].fields ?? []).map((f) => [f.name, f.value]),
    );
    assert.match(
      String(fields.Disposition),
      /^Original message deleted by .* via this ticket$/,
    );

    // Original gone (404 on the mock's REST read).
    await assert.rejects(
      () => env.mock.message(msg.id),
      (err) => err.status === 404,
      "message DELETE persisted — REST read now 404s",
    );
  });

  // ── decision 12: duplicate nudge ────────────────────────────────────────

  it("second report on the SAME message still opens, nudging with the earlier ticket", async () => {
    const { reply } = await reportPost(firstReport.messageId, {
      context: "still active",
      deleteAnswer: "no",
    });
    const text = String(reply.content);
    assert.match(text, /opened: <#\d+>/, "second ticket opened");
    assert.match(
      text,
      new RegExp(
        `Already reported on this message: \\*\\*#${firstReport.number}\\*\\*`,
      ),
      `duplicate nudge names the earlier ticket #${firstReport.number} (decision 12)`,
    );
  });

  // ── decision 2: recognition-only delete ─────────────────────────────────

  it("unrecognized delete answer echoes verbatim and KEEPS the message", async () => {
    const msg = await env.mock.inject("standing post", env.ids.target);
    const { reply } = await reportPost(msg.id, {
      context: "look at this",
      deleteAnswer: "maybe",
    });
    assert.match(
      String(reply.content),
      /input 'maybe' not understood — message kept/,
      "echo carries the submitted string verbatim",
    );
    const m = /Ticket \*\*#(\d+)\*\* opened/.exec(String(reply.content));
    const rec = reportRowFor(m[1]);
    assert.equal(rec.message_deleted, 0);
    assert.match(
      String(rec.snapshot_note),
      /input 'maybe' not understood — message kept/,
      "echo recorded on the side record (decision 13)",
    );
    keptSnapshotNoteTicket = m[1];
    const original = await env.mock.message(msg.id);
    assert.equal(original.id, msg.id, "message kept");
  });

  // ── decision 3: one-shot token ──────────────────────────────────────────

  it("replaying a consumed modal token is refused with zero side effects", async () => {
    const before = env.dbmod.db
      .prepare("SELECT COUNT(*) n FROM tickets")
      .get().n;
    const replay = await env.mock.modal({
      customId: firstModal.customId,
      fields: { rep_context: "replayed", rep_delete: "yes" },
    });
    const reply = await env.mock.awaitReply(replay);
    assert.equal(
      String(reply.content),
      "This report form has expired or was already used — run the command again.",
    );
    const after = env.dbmod.db.prepare("SELECT COUNT(*) n FROM tickets").get().n;
    assert.equal(after, before, "no ticket created by the replay");
  });

  // ── Report User ──────────────────────────────────────────────────────────

  it("Report User: single-field modal; card posts with code mention; subject NEVER joins the ticket", async () => {
    const invoke = await env.mock.contextMenu({
      command: "Report User",
      targetId: env.ids.target,
    });
    const state = await awaitCallback(invoke.id, 9, "modal display");
    assert.match(state.response_json.data.custom_id, /^tk:rep:u:[0-9a-f]{32}$/);
    assert.deepEqual(
      modalFields(state),
      ["rep_context"],
      "user variant: context only, NO delete field (decision 2)",
    );

    const submit = await env.mock.modal({
      customId: state.response_json.data.custom_id,
      fields: { rep_context: "targeted harassment" },
    });
    const reply = await env.mock.awaitSettledReply(submit);
    const m = /Ticket \*\*#(\d+)\*\* opened: <#(\d+)>/.exec(String(reply.content));
    assert.ok(m, `opened reply (got: ${reply.content})`);
    const [, number, channelId] = m;

    const rec = reportRowFor(number);
    assert.equal(rec.kind, "user");
    assert.equal(rec.subject_user_id, env.ids.target);
    assert.equal(rec.message_deleted, 0);

    // Reported-user card (decision 7): code-wrapped mention — visible,
    // inert, NEVER a ping — plus the reporter as a live mention.
    const card = await findEmbed(channelId, "Reported user");
    assert.ok(card, "reported-user card posted");
    const fields = Object.fromEntries(
      (card.embeds[0].fields ?? []).map((f) => [f.name, f.value]),
    );
    assert.ok(
      String(fields["Reported user"]).includes(`\`<@!${env.ids.target}>\``),
      "subject rendered as an inert code mention",
    );
    assert.ok(
      String(fields["Reported user"]).includes(`ID: \`${env.ids.target}\``),
      "raw id recorded",
    );
    assert.equal(String(fields["Reported by"]), `<@${env.ids.human}>`);

    // Zero-contact posture, strongest tier-4 form (#328 gap 7): the user is
    // NOT a member of the ticket channel…
    const ticket = env.dbmod.getTicketByChannel(env.communityId, channelId);
    const members = env.dbmod.listTicketMembers(ticket.id);
    assert.ok(
      !members.some((r) => String(r.user_id) === env.ids.target),
      "reported user never joins the ticket",
    );
    // …and no DM channel with them EXISTS at all — a report never dials
    // the subject (channel row = DM evidence; the mock's createDM is
    // idempotent, so "never sent" ⇔ "no channel").
    assert.equal(
      await env.mock.dmChannel(env.ids.target),
      null,
      "ZERO DMs to the reported user (no DM channel was ever opened)",
    );
  });

  it("self-report is refused before any modal (decision 7)", async () => {
    const invoke = await env.mock.contextMenu({
      command: "Report User",
      targetId: env.ids.human,
    });
    const reply = await env.mock.awaitReply(invoke);
    assert.equal(
      String(reply.content),
      "You can't report yourself — use `/ticket create` to reach staff instead. Nothing was recorded.",
    );
    const state = await env.mock.interactionState(invoke.id);
    assert.notEqual(state.response_json?.type, 9, "no modal for a self-report");
  });

  // ── mock-side target validation (patch proof) ───────────────────────────

  it("the mock refuses invalid menu targets with 400 Invalid Form Body", async () => {
    // A message menu cannot target a vanished message id — real Discord
    // cannot invoke a menu on a deleted target either.
    await assert.rejects(
      () =>
        env.mock.contextMenu({
          command: "Report Post",
          targetId: "999999999999999999",
        }),
      (err) => err.status === 400 && err.body?.code === 50035,
      "400 code 50035, not a 404",
    );
  });

  // ── #794 twin ─────────────────────────────────────────────────────────────

  it("#794 twin: the 'Open ticket for user' menu opens the staff proxy ticket", async () => {
    const before = env.dbmod.db
      .prepare("SELECT COUNT(*) n FROM tickets")
      .get().n;
    const invoke = await env.mock.contextMenu({
      command: "Open ticket for user",
      targetId: env.ids.target,
    });
    const reply = await env.mock.awaitSettledReply(invoke);
    const m = new RegExp(
      `Ticket \\*\\*#(\\d+)\\*\\* opened for <@${env.ids.target}>: <#(\\d+)>`,
    ).exec(String(reply.content));
    assert.ok(m, `opened-for reply (got: ${reply.content})`);
    const [, , channelId] = m;
    const ticket = env.dbmod.getTicketByChannel(env.communityId, channelId);
    assert.equal(
      ticket.creator_user_id,
      env.ids.target,
      "the SUBJECT owns the proxy ticket (creator = target, opener = staff — handleFor core)",
    );
    const members = env.dbmod.listTicketMembers(ticket.id);
    assert.ok(
      members.some((r) => String(r.user_id) === env.ids.target),
      "subject joins the proxy ticket (unlike a report)",
    );
    assert.equal(
      env.dbmod.db.prepare("SELECT COUNT(*) n FROM tickets").get().n,
      before + 1,
    );
  });
});
