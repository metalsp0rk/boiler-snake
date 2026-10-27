/**
 * Integration (tier 3, #745): the context-menu "Report Post" / "Report User"
 * flows END-TO-END through the real router (env.handleInteraction) against
 * REAL SQLite — real modal customIds (`tk:rep:m:` / `tk:rep:u:` + token) and
 * real pending-store tokens obtained by running the INVOKE command through the
 * same env first. The opts/deps seam of report.js stays INERT here: the router
 * only ever calls handlers as (interaction, ctx), so nothing in this file
 * injects deps, fetchImpl, or resolveHost — every step runs the production
 * pipeline (locked decisions 4/5/6/12/13).
 *
 * Transport story (documented harness choice): the SSRF guard's default
 * transport PINS sockets for DNS-name hops, so member-URL downloads can only
 * reach `globalThis.fetch` through IP-LITERAL hosts (test/ssrfGuard.test.js
 * pins that routing: literal hop → no DNS → globalThis.fetch). Every mock
 * media URL here therefore uses a public IPv4 literal host: the REAL
 * downloadGuarded/checkHost code runs, zero DNS, zero sockets, and the file
 * swaps `globalThis.fetch` for a URL-keyed byte server (SSRF-archive test
 * precedent, test/integration/ticketsArchiveSsrf.test.js). `dns.promises.lookup`
 * is tripwired: ANY resolution attempt is a failure.
 *
 * Durability (locked decision 6): after a happy-path report with attachments
 * the suite runs the harness close→archive flow (tickets.test.js /
 * ticketsArchiveSsrf.test.js precedents) and asserts mirrorTicketAssets
 * downloads the RE-UPLOADED evidence bytes into the per-transcript asset dir
 * BEFORE the channel deletion disposes the only Discord copy —
 * is_sensitive 0 is what makes the full-content archive apply.
 *
 * Tier-4 fauxcord E2E is explicitly OUT of scope (decision 16: context menus
 * may not be supported there — tracked as a follow-up issue, not a blocker).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns");
const { PermissionFlagsBits } = require("discord.js");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  createChatInputInteraction,
  createModalSubmitInteraction,
  createMember,
  createUser,
} = require("../helpers/discord");
const { IDS } = require("../helpers/fixtures");
const { assertEphemeralReply } = require("../helpers/assert");

describe("integration: ticket-reports", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  /** Same-generation module bindings (required AFTER createIntegrationEnv so
   *  they resolve to the require cache the router/report.js were built with). */
  let reportConstants; // MODAL_REPORT_* prefixes + field names
  let overwritesLib; // STAFF_ALLOW / BOT_ALLOW / MEMBER_ALLOW bit fields
  let theme; // formatTicketRef for exact reply-copy pins

  // ── Offline transport (per-file) ───────────────────────────────────────────
  const PUBLIC_IP = "93.184.216.34"; // public example address (no traffic), same as test/ssrfGuard.test.js
  const cdnUrl = (name) => `https://${PUBLIC_IP}/mock-cdn/${name}`;

  /** @type {Map<string, { bytes: Buffer, contentType: string }>} URL → bytes */
  const served = new Map();
  const attempted = { fetch: [], dns: [] };
  let origFetch;
  let origLookup;

  before(async () => {
    env = await createIntegrationEnv();
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "senior");
    env.db.updateGuildSettings(env.communityId, {
      ticket_archive_channel_id: IDS.channelLog,
      ticket_rate_limit_minutes: 0,
    });

    reportConstants = require("../../src/features/tickets/constants");
    overwritesLib = require("../../src/features/tickets/overwrites");
    theme = require("../../src/core/theme");

    // --- byte server on globalThis.fetch + DNS tripwire -----------------------
    // IP-literal media URLs keep the guard on its no-DNS literal hop, so the
    // guard hands EVERY download to globalThis.fetch (pinned routing, see
    // file header). Anything unmocked — or any DNS lookup — is a hard failure.
    origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const key = String(url);
      attempted.fetch.push(key);
      const hit = served.get(key);
      if (!hit) {
        throw new Error(`TRIPOWIRE: unexpected fetch for ${key}`);
      }
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => {
            const n = String(name).toLowerCase();
            if (n === "content-type") return hit.contentType;
            if (n === "content-length") return String(hit.bytes.length);
            return null;
          },
        },
        arrayBuffer: async () => hit.bytes,
      };
    };
    origLookup = dns.promises.lookup;
    dns.promises.lookup = async (host) => {
      attempted.dns.push(String(host));
      throw new Error(`TRIPOWIRE: DNS lookup attempted for ${host}`);
    };
  });

  after(() => {
    globalThis.fetch = origFetch;
    dns.promises.lookup = origLookup;
    env?.cleanup();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Register bytes for a mock CDN URL and return the URL.
   * @param {string} name file name (becomes the URL tail)
   * @param {Buffer} bytes exact bytes the byte server will serve
   * @param {string} contentType served as the response Content-Type
   * @returns {string}
   */
  function serveFile(name, bytes, contentType) {
    const url = cdnUrl(name);
    served.set(url, { bytes, contentType });
    return url;
  }

  /**
   * Context-menu invoke mock (same technique as test/integration/router.test.js
   * — extend the chat-input mock and flip the kind predicates; the target
   * rides options.getMessage()/getUser() like the real discord.js getters).
   */
  function createContextMenuInteraction({
    kind,
    commandName,
    target = {},
    ...chatOpts
  }) {
    const interaction = createChatInputInteraction({ commandName, ...chatOpts });
    interaction.isChatInputCommand = () => false;
    interaction.isMessageContextMenuCommand = () => kind === "message";
    interaction.isUserContextMenuCommand = () => kind === "user";
    interaction.options.getMessage = () => target.message ?? null;
    interaction.options.getUser = () => target.user ?? null;
    return interaction;
  }

  /**
   * Drive a context-menu INVOKE through the real router.
   * @param {object} opts
   * @param {"message"|"user"} opts.kind
   * @param {object} [opts.user] invoker (defaults to the admin/staff user)
   * @param {object} [opts.member]
   * @param {boolean} [opts.admin]
   * @param {{ message?: object, user?: object }} [opts.target]
   */
  async function invokeReport(opts) {
    const commandName =
      opts.kind === "user" ? "Report User" : "Report Post";
    const interaction = createContextMenuInteraction({
      kind: opts.kind,
      commandName,
      guild: env.guild,
      user: opts.user || env.users.adminUser,
      member: opts.member || env.members.adminMember,
      admin: opts.admin !== false,
      client: env.client,
      channelId: opts.channelId || IDS.channelGeneral,
      target: opts.target || {},
    });
    await env.handleInteraction(interaction, env.ctx);
    return interaction;
  }

  /**
   * The REAL modal customId (prefix + token) the invoke handler just showed —
   * read off the ModalBuilder exactly like the unit tier does.
   * @param {object} interaction
   * @returns {string}
   */
  function modalCustomId(interaction) {
    const modal = interaction.modals[interaction.modals.length - 1];
    assert.ok(modal, "expected the invoke to show a modal");
    const json = typeof modal?.toJSON === "function" ? modal.toJSON() : modal;
    const customId = json?.custom_id ?? modal?.data?.custom_id;
    assert.ok(
      typeof customId === "string" && customId.startsWith("tk:rep:"),
      `modal customId must carry a report token, got ${JSON.stringify(customId)}`,
    );
    return customId;
  }

  /**
   * Drive a MODAL SUBMIT through the real router (the router passes
   * (interaction, ctx) — production-arity only, opts seam stays inert).
   * @param {object} opts
   * @param {string} opts.customId
   * @param {Record<string, string>} [opts.fields] text-input customId → value
   * @param {object} [opts.user] @param {object} [opts.member] @param {boolean} [opts.admin]
   */
  async function submitReport(opts) {
    const interaction = createModalSubmitInteraction({
      customId: opts.customId,
      guild: env.guild,
      user: opts.user || env.users.adminUser,
      member: opts.member || env.members.adminMember,
      admin: opts.admin !== false,
      client: env.client,
      channelId: IDS.channelGeneral,
      fields: opts.fields || {},
    });
    await env.handleInteraction(interaction, env.ctx);
    return interaction;
  }

  /**
   * Report-message modal submit with the real field ids from constants.js.
   * @param {string} customId
   * @param {string} context
   * @param {string} deleteAnswer "yes" | "no" | anything else
   * @param {object} [extra] submitReport overrides (non-staff submitter etc.)
   */
  function reportPostFields(context, deleteAnswer) {
    return {
      [reportConstants.MODAL_REPORT_FIELD_CONTEXT]: context,
      [reportConstants.MODAL_REPORT_FIELD_DELETE]: deleteAnswer,
    };
  }

  /**
   * Seed a reported message into the mock #general channel (returns the live
   * fake Message; delete() is observable via .deleted + the channel's
   * _deletedMessages buffer).
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.content
   * @param {object[]} [opts.attachments] attachment metadata ({id,name,url,size,contentType})
   */
  function seedReportedMessage(opts) {
    return env.channels.general.addMessage({
      id: opts.id,
      content: opts.content,
      author: { id: IDS.member, username: "member", tag: "member#0000", bot: false },
      attachments: opts.attachments || [],
    });
  }

  /**
   * Counting wrapper for the fake message's delete() — pins "called exactly
   * once" (and "NEVER" for the safety-ordering tests).
   * @param {object} message
   * @returns {{ calls: number }}
   */
  function spyDelete(message) {
    const spy = { calls: 0 };
    const orig = message.delete.bind(message);
    message.delete = async () => {
      spy.calls += 1;
      return orig();
    };
    return spy;
  }

  /**
   * Exact "Ticket **#N** opened" confirmation pin — built through the SAME
   * ref formatter production uses (theme.formatTicketRef), so a ref-format
   * change fails here instead of silently loosening these regexes.
   * @param {number} ticketNumber
   * @returns {RegExp}
   */
  function openedReplyPin(ticketNumber) {
    return new RegExp(
      `Ticket \\*\\*${theme.formatTicketRef(ticketNumber)}\\*\\* opened`,
    );
  }

  /** Row-count snapshot for the zero-side-effect asserts (real SQLite). */
  function counts() {
    const c = (sql) => env.db.db.prepare(sql).get().c;
    return {
      tickets: c("SELECT COUNT(*) AS c FROM tickets"),
      reports: c("SELECT COUNT(*) AS c FROM ticket_reports"),
      audit: c("SELECT COUNT(*) AS c FROM admin_audit"),
    };
  }

  /**
   * The admin_audit row one flow wrote (action + target id).
   * @param {string} action
   * @param {number|string} targetId
   */
  function auditRow(action, targetId) {
    return (
      env.db
        .listAdminAudit(env.communityId, { limit: 50 })
        .find((r) => r.action === action && String(r.target_id) === String(targetId)) || null
    );
  }

  /** @param {object} row @returns {object} */
  function detailsOf(row) {
    return typeof row.details_json === "string"
      ? JSON.parse(row.details_json)
      : row.details_json;
  }

  /**
   * The FULL Report Post loop the way production runs it: real staff INVOKE
   * (snapshot into the real pending store, real modal shown) → read the real
   * modal customId off the shown modal → real MODAL SUBMIT with the real
   * field ids. Returns the created channel + ticket row + both interactions.
   * @param {object} opts
   * @param {object} opts.message seeded reported message
   * @param {string} opts.context modal "Additional context"
   * @param {string} opts.deleteAnswer modal delete answer
   */
  async function fullReportPostLoop(opts) {
    const invoke = await invokeReport({ kind: "message", target: { message: opts.message } });
    const customId = modalCustomId(invoke);
    const createdBefore = env.guild.channels.created.length;
    const submit = await submitReport({
      customId,
      fields: reportPostFields(opts.context, opts.deleteAnswer),
    });
    const ticketChannel = env.guild.channels.created[createdBefore];
    assert.ok(ticketChannel, "the modal submit created the ticket channel");
    const ticket = env.db.getTicketByChannel(env.communityId, ticketChannel.id);
    assert.ok(ticket, "the ticket row exists in the real DB");
    return { invoke, submit, customId, ticketChannel, ticket };
  }

  // ── 1. Report Post: full happy loop ────────────────────────────────────────

  it("Report Post full loop: staff-self ticket + overwrite shape, evidence re-uploads bytes with inline image, delete exactly once, DB + audit rows", async () => {
    const PNG = Buffer.from("\x89PNG\r\n\x1a\n fake png bytes 0123456789", "utf8");
    const PDF = Buffer.from("%PDF-1.4 fake pdf evidence bytes 9876543210", "utf8");
    const pngUrl = serveFile("photo.png", PNG, "image/png");
    const pdfUrl = serveFile("evidence.pdf", PDF, "application/pdf");

    const message = seedReportedMessage({
      id: "rep-msg-happy",
      content: "this is the reported post",
      attachments: [
        { id: "att-1", name: "photo.png", url: pngUrl, size: PNG.length, contentType: "image/png" },
        { id: "att-2", name: "evidence.pdf", url: pdfUrl, size: PDF.length, contentType: "application/pdf" },
      ],
    });
    const del = spyDelete(message);

    const { submit, ticketChannel, ticket } = await fullReportPostLoop({
      message,
      context: "coordinated harassment; delete requested",
      deleteAnswer: "yes",
    });

    // Ephemeral confirmation names the ticket ref + channel (rule 3) and
    // carries NO warning block on a clean run (rule 5: warnings only ride
    // along when something actually failed).
    const reply = env.lastReplyContent(submit);
    assert.match(reply, openedReplyPin(ticket.ticket_number));
    assert.match(reply, new RegExp(`<#${ticketChannel.id}>`));
    assert.ok(!reply.includes("⚠"), `clean run must surface no warnings: ${reply}`);

    // Ticket row: decision-5 staff-self shape + decision-6 is_sensitive 0.
    assert.equal(Number(ticket.is_sensitive), 0, "report tickets stay non-sensitive (decision 6)");
    assert.equal(ticket.creator_user_id, IDS.admin);
    assert.equal(ticket.opened_by_staff_id, IDS.admin, "creator == opened_by (staff-self branch, decision 5)");
    assert.equal(ticket.staff_owner_id, IDS.admin);
    assert.equal(ticket.status, "open");
    assert.equal(ticket.reason, "coordinated harassment; delete requested");

    // Overwrite shape (channel.permissionOverwrites.set ran through
    // openTicketChannel + applyTicketOverwrites on the REAL created channel):
    // reporter + senior staff role allowed, @everyone denied, bot allowed,
    // and the REPORTED USER is nowhere present (decision 5).
    const ow = ticketChannel._overwrites;
    const byId = (id) => ow.find((o) => String(o.id) === String(id));
    const VC = PermissionFlagsBits.ViewChannel;
    const STAFF = overwritesLib.STAFF_ALLOW;
    const BOT = overwritesLib.BOT_ALLOW;

    const everyone = byId(env.guildId);
    assert.ok(everyone, "@everyone overwrite present");
    assert.equal((BigInt(everyone.deny ?? 0n) & VC) === VC, true, "@everyone denied ViewChannel");

    const reporter = byId(IDS.admin);
    assert.ok(reporter, "reporter overwrite present");
    assert.equal(
      (BigInt(reporter.allow ?? 0n) & STAFF) === STAFF,
      true,
      "reporter granted STAFF_ALLOW (staff-self branch)",
    );

    const staffRole = byId(IDS.roleExempt);
    assert.ok(staffRole, "senior staff-role overwrite present");
    assert.equal((BigInt(staffRole.allow ?? 0n) & STAFF) === STAFF, true, "staff role STAFF_ALLOW");

    const botOw = byId(IDS.bot);
    assert.ok(botOw, "bot overwrite present");
    assert.equal((BigInt(botOw.allow ?? 0n) & BOT) === BOT, true, "bot BOT_ALLOW");

    assert.equal(byId(IDS.member), undefined, "the reported user is NEVER granted channel access");

    // Evidence message: exactly one send carries files — the two snapshot
    // attachments were fetched through the REAL SSRF-guard path and
    // re-uploaded as byte-exact files; the image is inline via attachment://.
    const evidencePayloads = ticketChannel.sent.filter(
      (p) => Array.isArray(p?.files) && p.files.length > 0,
    );
    assert.equal(evidencePayloads.length, 1, "exactly one evidence send with files");
    const evidence = evidencePayloads[0];
    assert.deepEqual(
      evidence.files.map((f) => f.name),
      ["photo.png", "evidence.pdf"],
      "both attachments re-uploaded, snapshot order",
    );
    const fileBytes = (name) => evidence.files.find((f) => f.name === name).attachment;
    assert.deepEqual(fileBytes("photo.png"), PNG, "re-uploaded image bytes are exact");
    assert.deepEqual(fileBytes("evidence.pdf"), PDF, "re-uploaded pdf bytes are exact");

    const embedJson = evidence.embeds.map((e) => e.toJSON());
    assert.equal(embedJson[0].title, "Reported message evidence");
    assert.ok(
      embedJson.some((e) => e?.image?.url === "attachment://photo.png"),
      "image renders inline via an attachment:// reference",
    );
    assert.ok(
      !embedJson.some((e) => String(e?.image?.url || "").includes("evidence.pdf")),
      "the pdf ships as a playable file, not an inline image",
    );
    assert.ok(
      embedJson.some((e) => String(e?.description || "").includes("this is the reported post")),
      "message content captured into the evidence embeds",
    );
    assert.match(
      JSON.stringify(embedJson[0].fields),
      /Original message deleted by .* via this ticket/,
      "decision 13: the embed records WHO triggered the deletion",
    );

    // Delete: exactly once, on the ORIGINAL message, gone from its channel.
    assert.equal(del.calls, 1, "message.delete() invoked exactly once for 'yes'");
    assert.equal(message.deleted, true);
    assert.equal(
      env.channels.general._deletedMessages.filter((id) => id === message.id).length,
      1,
    );

    // DB records (decision 13): side row + audit row.
    const report = env.db.getTicketReport(ticket.id);
    assert.ok(report, "ticket_reports row exists");
    assert.equal(report.kind, "message");
    assert.equal(report.message_deleted, 1);
    assert.equal(report.reported_message_id, message.id);
    assert.equal(report.source_channel_id, IDS.channelGeneral);
    assert.equal(report.subject_user_id, IDS.member, "snapshot author is the report subject");

    const audit = auditRow("tickets.report_message", ticket.id);
    assert.ok(audit, "tickets.report_message audit row exists");
    const details = detailsOf(audit);
    assert.equal(details.message_deleted, 1);
    assert.equal(details.reported_message_id, message.id);
    assert.equal(details.ticket_number, ticket.ticket_number);
    assert.equal(details.subject_user_id, IDS.member);
  });

  // ── 2. Report User: full happy loop ────────────────────────────────────────

  it("Report User full loop: reported-user card posted (code-wrapped mention), zero DMs to the subject, kind 'user' + audit rows", async () => {
    // A snowflake-shaped subject so the decision-7 code mention renders in its
    // real form (`<@!id>` inside a code span). Registered as a member so the
    // submit-time bot re-check resolves a HUMAN from the guild cache.
    const subjectUser = createUser({ id: "456789012345678901", username: "raidboss" });
    const subjectMember = createMember({ guild: env.guild, user: subjectUser, admin: false });
    env.guild.addMember(subjectMember);
    env.client.users.addUser(subjectUser);
    const adminSendsBefore = env.users.adminUser.sends.length;

    const invoke = await invokeReport({ kind: "user", target: { user: subjectUser } });
    assert.equal(invoke.modals.length, 1, "invoke showed the report-user modal");
    const customId = modalCustomId(invoke);
    assert.match(customId, /^tk:rep:u:[0-9a-f]{32}$/);

    const createdBefore = env.guild.channels.created.length;
    const submit = await submitReport({
      customId,
      fields: { [reportConstants.MODAL_REPORT_FIELD_CONTEXT]: "raid leader, coordinated alt spam" },
    });
    const ticketChannel = env.guild.channels.created[createdBefore];
    assert.ok(ticketChannel, "submit created the ticket channel");
    const ticket = env.db.getTicketByChannel(env.communityId, ticketChannel.id);
    assert.ok(ticket);

    // Ephemeral confirmation names the ticket.
    assert.match(
      env.lastReplyContent(submit),
      openedReplyPin(ticket.ticket_number),
    );

    // Decision-7 card: code-wrapped mention (production 2-arg handler path
    // built this payload), reporter live-mentioned, subject NEVER pinged.
    const card = ticketChannel.sent.find(
      (p) => typeof p?.content === "string" && p.content.includes("Reported user card"),
    );
    assert.ok(card, "reported-user card posted into the ticket");
    assert.equal(typeof card.embeds[0].toJSON, "function", "card embed built by production code");
    const cardJson = card.embeds[0].toJSON();
    assert.equal(cardJson.title, "Reported user");
    const subjectField = cardJson.fields.find((f) => f.name === "Reported user").value;
    assert.ok(
      subjectField.includes("`<@!456789012345678901>`"),
      `subject mention rendered inside a code span, got ${JSON.stringify(subjectField)}`,
    );
    assert.ok(subjectField.includes("ID: `456789012345678901`"));
    assert.deepEqual(
      card.allowedMentions?.users ?? [],
      [],
      "no live user mentions — the reporter id here is not snowflake-shaped; the subject is NEVER pinnable",
    );
    assert.equal(card.allowedMentions?.repliedUser, false);

    // Decision 5/7: NO DM anywhere in the report flow — the subject spy is
    // empty and the reporter was not DM'd either.
    assert.equal(subjectUser.sends.length, 0, "the reported user is never DM'd");
    assert.equal(env.users.adminUser.sends.length, adminSendsBefore, "no DMs to the reporter either");

    // DB records.
    assert.equal(Number(ticket.is_sensitive), 0);
    assert.equal(ticket.creator_user_id, IDS.admin);
    assert.equal(ticket.opened_by_staff_id, IDS.admin);
    const report = env.db.getTicketReport(ticket.id);
    assert.ok(report);
    assert.equal(report.kind, "user");
    assert.equal(report.message_deleted, 0);
    assert.equal(report.reported_message_id, null, "user reports carry no message id");
    assert.equal(report.source_channel_id, null);
    assert.equal(report.subject_user_id, subjectUser.id);

    const audit = auditRow("tickets.report_user", ticket.id);
    assert.ok(audit, "tickets.report_user audit row exists");
    const details = detailsOf(audit);
    assert.equal(details.subject_user_id, subjectUser.id);
    assert.equal(details.ticket_number, ticket.ticket_number);
  });

  // ── 3. Safety ordering (decision 4) with the real DB ───────────────────────

  it("evidence-post failure → the delete NEVER runs: ticket stands, cause named in the ephemeral and the ticket", async () => {
    const message = seedReportedMessage({
      id: "rep-msg-evfail",
      content: "post that must keep its original",
      attachments: [
        { id: "att-e", name: "shot.png", url: serveFile("shot.png", Buffer.from("PNG!"), "image/png"), size: 4, contentType: "image/png" },
      ],
    });
    const del = spyDelete(message);

    // Arm the harness channel mock: any EVIDENCE-shaped send (the payload that
    // carries a files array — postReportEvidence's {embeds, files}) rejects.
    // The open notice and the failure NOTE are content-only payloads and pass,
    // so the run keeps the real ordering while only the evidence send fails.
    const origCreate = env.guild.channels.create;
    env.guild.channels.create = async (data) => {
      const ch = await origCreate(data);
      const origSend = ch.send.bind(ch);
      ch.send = async (payload) => {
        if (payload && Array.isArray(payload.files)) {
          throw Object.assign(new Error("Missing Access"), { code: 50013 });
        }
        return origSend(payload);
      };
      return ch;
    };
    let loop;
    try {
      loop = await fullReportPostLoop({
        message,
        context: "evidence-send rejection probe",
        deleteAnswer: "yes",
      });
    } finally {
      env.guild.channels.create = origCreate;
    }
    const { submit, ticketChannel, ticket } = loop;

    // The ticket stands…
    assert.ok(ticket, "ticket created BEFORE the evidence attempt — it stands");
    assert.equal(ticket.status, "open");
    // …but the destructive step was skipped ENTIRELY (decision 4).
    assert.equal(del.calls, 0, "delete() must NEVER run when the evidence did not land");
    assert.equal(message.deleted, false);
    assert.ok(!env.channels.general._deletedMessages.includes(message.id));

    // The ephemeral names the specific cause (rule 3) + the skip statement.
    const reply = env.lastReplyContent(submit);
    assert.match(reply, openedReplyPin(ticket.ticket_number));
    assert.match(reply, /Could not post the evidence/);
    assert.match(reply, /Missing Access/, "the specific cause rides the reply (rule 3)");
    assert.match(reply, /was NOT deleted/);

    // The same sentence also landed IN the ticket (rule 5, belt-and-braces).
    assert.ok(
      ticketChannel.sent.some(
        (p) => typeof p?.content === "string" && p.content.includes("was NOT deleted"),
      ),
      "explanatory note posted into the ticket channel",
    );

    // DB: record + audit exist with message_deleted 0 (what ACTUALLY happened).
    const report = env.db.getTicketReport(ticket.id);
    assert.ok(report);
    assert.equal(report.kind, "message");
    assert.equal(report.message_deleted, 0);
    assert.match(String(report.snapshot_note), /NOT deleted/);
    assert.equal(detailsOf(auditRow("tickets.report_message", ticket.id)).message_deleted, 0);
  });

  it("delete failure → ticket stands, warning in the reply + correction posted into the ticket, message kept", async () => {
    const message = seedReportedMessage({
      id: "rep-msg-delfail",
      content: "cannot be deleted",
      attachments: [],
    });
    // Real Discord answers deletions with 50003 when the bot lost permission.
    message.delete = async () => {
      throw Object.assign(new Error("DiscordAPIError[50003]: Missing Permissions"), { code: 50003 });
    };

    const { submit, ticketChannel, ticket } = await fullReportPostLoop({
      message,
      context: "delete-rejection probe",
      deleteAnswer: "yes",
    });

    // Evidence DID post first (locked order), the delete then failed, and
    // nothing was retried behind the reporter's back.
    assert.ok(
      ticketChannel.sent.some(
        (p) => Array.isArray(p?.embeds) && p.embeds.some((e) => e?.toJSON?.().title === "Reported message evidence"),
      ),
      "evidence message posted before the delete was attempted (decision 4 order)",
    );
    assert.equal(message.deleted, false, "the original message stands");

    const reply = env.lastReplyContent(submit);
    assert.match(reply, openedReplyPin(ticket.ticket_number), "ticket stands");
    assert.match(reply, /⚠ Delete failed/);
    assert.match(reply, /Missing Permissions/, "specific cause named (rule 3)");
    assert.match(reply, /original message KEPT/);

    assert.ok(
      ticketChannel.sent.some(
        (p) => typeof p?.content === "string" && p.content.includes("Delete failed"),
      ),
      "delete-correction note posted INTO the ticket (closes the embed's honesty gap)",
    );

    const report = env.db.getTicketReport(ticket.id);
    assert.equal(report.message_deleted, 0, "message_deleted reflects the ACTUAL outcome");
    assert.match(String(report.snapshot_note), /Delete failed/);
    assert.equal(detailsOf(auditRow("tickets.report_message", ticket.id)).message_deleted, 0);
  });

  // ── 4. Token gates at this tier ────────────────────────────────────────────

  it("unknown-token submit (no invoke): the specific expired reply and ZERO new rows", async () => {
    const before = counts();
    const channelsBefore = env.guild.channels.created.length;

    const submit = await submitReport({
      customId: reportConstants.MODAL_REPORT_MESSAGE_PREFIX + "f".repeat(32),
      fields: reportPostFields("ghost token", "yes"),
    });
    assertEphemeralReply(submit, /expired or was already used/i);

    assert.deepEqual(counts(), before, "no ticket, no report, no audit row");
    assert.equal(env.guild.channels.created.length, channelsBefore, "no channel was created");
  });

  it("one-shot token: replaying the SAME consumed submit gets the expired reply — no second ticket, no second delete", async () => {
    const message = seedReportedMessage({ id: "rep-msg-once", content: "one-shot probe", attachments: [] });
    const del = spyDelete(message);

    const { submit, customId } = await fullReportPostLoop({
      message,
      context: "one-shot probe",
      deleteAnswer: "yes",
    });
    assert.match(env.lastReplyContent(submit), /opened/);
    assert.equal(del.calls, 1);

    const before = counts();
    const replay = await submitReport({ customId, fields: reportPostFields("one-shot probe", "yes") });
    assertEphemeralReply(replay, /expired or was already used/i);
    assert.deepEqual(counts(), before, "the consumed token cannot open a second ticket");
    assert.equal(del.calls, 1, "and cannot delete twice");
  });

  // ── 5. Duplicate-open-report nudge (decision 12) ───────────────────────────

  it("duplicate nudge: two Report Post loops on the same message → both tickets, second reply names the first", async () => {
    const message = seedReportedMessage({ id: "rep-msg-dup", content: "reported twice", attachments: [] });

    const first = await fullReportPostLoop({
      message,
      context: "first report",
      deleteAnswer: "no",
    });
    assert.ok(
      !env.lastReplyContent(first.submit).includes("Already reported"),
      "the first report has nothing to nudge about",
    );

    const second = await fullReportPostLoop({
      message,
      context: "second report",
      deleteAnswer: "no",
    });
    assert.notEqual(second.ticket.id, first.ticket.id, "both reports produced their own ticket");

    const secondReply = env.lastReplyContent(second.submit);
    assert.match(
      secondReply,
      new RegExp(
        `Already reported on this message: \\*\\*${theme.formatTicketRef(
          first.ticket.ticket_number,
        )}\\*\\*`,
      ),
      "decision 12: the nudge names the OLDEST open report",
    );
    assert.match(secondReply, new RegExp(`<#${first.ticket.channel_id}>`), "the nudge links the live channel");

    // The repository view agrees (oldest open report = the first ticket).
    const dup = env.db.findOpenReportForMessage(env.communityId, message.id);
    assert.ok(dup);
    assert.equal(dup.ticket_number, first.ticket.ticket_number);
    assert.equal(dup.ticket_channel_id, first.ticket.channel_id);

    const firstReport = env.db.getTicketReport(first.ticket.id);
    const secondReport = env.db.getTicketReport(second.ticket.id);
    assert.equal(firstReport.reported_message_id, message.id);
    assert.equal(secondReport.reported_message_id, message.id);
    assert.equal(firstReport.message_deleted, 0);
    assert.equal(secondReport.message_deleted, 0);
  });

  // ── 6. Durability (decision 6): close → archive mirrors the evidence ──────

  it("durability: close→archive downloads the re-uploaded evidence bytes to the transcript asset dir; is_sensitive 0 ⇒ full transcript", async () => {
    const PNG = Buffer.from("\x89PNG\r\n\x1a\n durable image bytes 42", "utf8");
    const PDF = Buffer.from("%PDF-1.7 durable document bytes 43", "utf8");
    const message = seedReportedMessage({
      id: "rep-msg-durable",
      content: "evidence that must outlive the channel",
      attachments: [
        { id: "att-d1", name: "media-photo.png", url: serveFile("media-photo.png", PNG, "image/png"), size: PNG.length, contentType: "image/png" },
        { id: "att-d2", name: "media-doc.pdf", url: serveFile("media-doc.pdf", PDF, "application/pdf"), size: PDF.length, contentType: "application/pdf" },
      ],
    });

    const { ticketChannel, ticket } = await fullReportPostLoop({
      message,
      context: "durability probe — archive owns the evidence",
      deleteAnswer: "yes",
    });

    // Stand-in for Discord's CDN re-host (documented harness gap: the mock
    // channel records payload.files but cannot mint CDN attachments). Attach
    // the EXACT bytes the flow uploaded to the evidence message as attachment
    // metadata — the archive pipeline must download them from there.
    const evidenceMsg = [...ticketChannel.messages.cache.values()].find(
      (m) => Array.isArray(m.files) && m.files.length > 0,
    );
    assert.ok(evidenceMsg, "evidence message (with re-uploaded files) lives in the ticket channel");
    evidenceMsg.attachments = evidenceMsg.files.map((f) => {
      const url = cdnUrl(`mirror-${f.name}`);
      served.set(url, {
        bytes: f.attachment,
        contentType: f.name.endsWith(".pdf") ? "application/pdf" : "image/png",
      });
      return {
        url,
        name: f.name,
        contentType: f.name.endsWith(".pdf") ? "application/pdf" : "image/png",
      };
    });

    // Close + archive exactly as the other integration suites drive them.
    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: ticketChannel.id,
      options: { reason: "probe complete" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: ticketChannel.id,
    });
    assert.match(env.lastReplyContent(archive), /archived/i);

    // Row: full-content archive (is_sensitive 0 is what makes this apply).
    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.archived, 1);
    assert.equal(Number(after.is_sensitive), 0, "decision 6: non-sensitive ⇒ content IS archived");
    assert.ok(after.transcript_token, "transcript token issued");
    assert.ok(after.transcript_path, "transcript written");

    // The Discord copy is GONE — the channel was deleted with the archive.
    assert.equal(ticketChannel._wasDeleted(), true, "ticket channel deleted after archive");
    assert.ok(!env.guild.channels.cache.get(ticketChannel.id));

    // DURABILITY: mirrorTicketAssets downloaded the re-uploaded evidence bytes
    // into the per-transcript asset dir under the REAL DATA_DIR.
    const assetsDir = path.join(
      env.tmpDir,
      "ticket-transcripts",
      String(env.communityId),
      after.transcript_token,
      "assets",
    );
    assert.ok(fs.existsSync(assetsDir), `asset dir must exist: ${assetsDir}`);
    const mirrored = fs.readdirSync(assetsDir).sort();
    assert.ok(mirrored.includes("001_media-photo.png"), `mirrored files: ${mirrored}`);
    assert.ok(mirrored.includes("002_media-doc.pdf"), `mirrored files: ${mirrored}`);
    assert.deepEqual(
      fs.readFileSync(path.join(assetsDir, "001_media-photo.png")),
      PNG,
      "mirrored image bytes are exact",
    );
    assert.deepEqual(
      fs.readFileSync(path.join(assetsDir, "002_media-doc.pdf")),
      PDF,
      "mirrored document bytes are exact",
    );

    // Archive payload: the stored evidence row's attachments were rewritten to
    // local asset refs with the source URL preserved (served from /t/<token>).
    const rows = env.db.listTicketMessages(ticket.id);
    const evidenceRow = rows.find((m) => {
      try {
        const a = JSON.parse(m.attachment_urls);
        return Array.isArray(a) && a.length > 0;
      } catch {
        return false;
      }
    });
    assert.ok(evidenceRow, "evidence row persisted with attachment metadata");
    const atts = JSON.parse(evidenceRow.attachment_urls);
    assert.equal(atts.length, 2);
    assert.ok(atts.every((a) => a.local === true), "both attachments mirrored (local:true)");
    assert.ok(
      atts.every((a) => String(a.href).startsWith(`/t/${after.transcript_token}/assets/`)),
      `attachment hrefs point at the local asset paths: ${JSON.stringify(atts)}`,
    );
    assert.ok(
      atts.every((a) => String(a.source_url).startsWith(`https://${PUBLIC_IP}/mock-cdn/`)),
      "source URLs preserved for provenance",
    );

    // Nothing left the process: every download rode the byte server on an
    // IP-literal hop and the guard NEVER invoked a DNS resolver.
    assert.deepEqual(attempted.dns, [], "the SSRF guard performed zero DNS lookups");
    assert.ok(
      attempted.fetch.every((u) => u.startsWith(`https://${PUBLIC_IP}/mock-cdn/`)),
      `only mock CDN URLs were fetched: ${JSON.stringify(attempted.fetch)}`,
    );
  });

  // ── 7. Non-staff denials at THIS tier (handlers are the source of truth) ───

  it("non-staff invoke: standard denial, NO modal, no snapshot, zero rows", async () => {
    const message = seedReportedMessage({ id: "rep-msg-nonstaff", content: "member cannot report", attachments: [] });
    const before = counts();
    const channelsBefore = env.guild.channels.created.length;

    const invoke = await invokeReport({
      kind: "message",
      user: env.users.memberUser,
      member: env.members.member,
      admin: false,
      target: { message },
    });
    assertEphemeralReply(invoke, /permission/i);
    assert.equal(invoke.modals.length, 0, "denied BEFORE any target read or modal");
    assert.deepEqual(counts(), before);
    assert.equal(env.guild.channels.created.length, channelsBefore);
  });

  it("non-staff submitter with a LIVE token: denied with zero side effects; the token survives for the staff invoker (submitter is authoritative)", async () => {
    const message = seedReportedMessage({ id: "rep-msg-gate", content: "submitter gate probe", attachments: [] });
    const del = spyDelete(message);

    const invoke = await invokeReport({ kind: "message", target: { message } });
    const customId = modalCustomId(invoke);

    const before = counts();
    const denied = await submitReport({
      customId,
      fields: reportPostFields("member steals the modal", "yes"),
      user: env.users.memberUser,
      member: env.members.member,
      admin: false,
    });
    assertEphemeralReply(denied, /permission/i);
    assert.deepEqual(counts(), before, "denial has ZERO side effects");
    assert.equal(del.calls, 0, "and never touches the reported message");

    // The denial ran BEFORE token consumption — the staff invoker's report
    // still completes with the same customId.
    const submit = await submitReport({
      customId,
      fields: reportPostFields("submitter gate probe", "yes"),
    });
    assert.match(env.lastReplyContent(submit), /opened/);
    assert.equal(del.calls, 1, "the staff submitter's delete ran exactly once");
  });
});
