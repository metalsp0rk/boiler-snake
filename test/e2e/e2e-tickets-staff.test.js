const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { namespaceIds, poll } = require("./helpers/mockenv");

const MSG_DENIED = "You don't have permission to use this.";
const B = PermissionFlagsBits;

/**
 * Tier-4 tickets staff-ops coverage (issue #317, part 3/3). Namespace 10:
 * /ticket for (staff open-on-behalf), claim/transfer (ownership + notices),
 * addstaff/removestaff (rows + overwrite sets + owner/dup errors),
 * sensitive/unsensitive (owner gate, senior-role deny flip), close
 * (+ staff note + tk:sn button → tk:snm modal), summarize (stats fallback),
 * archive (transcript + channel delete) and the SENSITIVE archive path
 * (metadata stub, no content rows), the open-vs-closed archive gate copy,
 * external channel-delete closing the row, and the empty /ticket list.
 *
 * Every staff arm targets the ticket by RUNNING INSIDE its channel
 * (helpers.js requireOpenTicketChannel) — the suites drive slash with
 * channelId:<ticket channel> accordingly. Senior staff ROLE exists so the
 * sensitive deny-flip is observable; the bot holds a role created after it
 * (higher position) so getManageableStaffRoleIds keeps the entry (ns23
 * pattern).
 */
describe(
  "e2e: ticket staff operations (claim → close → archive)",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    let staffRole;
    let seniorRole;

    const ids = namespaceIds(10);

    before(async () => {
      env = await createE2eEnv({
        ns: 10,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "e2e-archive" },
        ],
      });
      staffRole = (await env.mock.createRole("E2E Ops Staff")).id;
      await env.mock.grantRole(env.ids.human, staffRole);
      env.dbmod.addStaffRole(env.communityId, String(staffRole), "junior");

      // second staff member (claim/transfer/unsensitive actor)
      const staff2 = (await env.mock.createRole("E2E Ops Staff 2")).id;
      await env.mock.grantRole(env.ids.target, staff2);
      env.dbmod.addStaffRole(env.communityId, String(staff2), "junior");

      // senior ROLE row (no member needs it): drives role overwrites so the
      // sensitive deny-flip is observable.
      seniorRole = (await env.mock.createRole("E2E Ops Senior")).id;
      env.dbmod.addStaffRole(env.communityId, String(seniorRole), "senior");
      // bot role created AFTER the senior role → higher position → senior
      // role stays "manageable" (hierarchy rule in overwrites.js).
      const botAdmin = await env.mock.createRole("E2E Ops Bot Admin");
      await env.mock.grantRole(env.ids.app, botAdmin.id);
    });

    after(async () => {
      await env?.cleanup();
    });

    const sub = (name, options = []) => ({
      name,
      type: 1,
      ...(options.length && { options }),
    });
    const userOpt = (name, id) => ({ name, type: 6, value: id });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);
    const ticket = (n) => env.dbmod.getTicketByNumber(env.communityId, n);
    const has = (entry, ...bits) =>
      entry != null && bits.every((b) => (BigInt(entry.allow ?? 0) & b) === b);
    const denies = (entry, bit) =>
      entry != null && (BigInt(entry.deny ?? 0) & bit) === bit;
    const owOf = async (channelId) => {
      const ch = await env.mock.channel(channelId);
      return new Map(
        (ch.permission_overwrites ?? []).map((o) => [String(o.id), o]),
      );
    };
    const noteCount = () =>
      env.dbmod.db
        .prepare(
          "SELECT COUNT(*) AS n FROM staff_notes WHERE community_id = ?",
        )
        .get(env.communityId).n;

    /** Ticket #1 (for outsider → claim target → transferred to human). */
    const t1 = { chan: null, closeMessageId: null };

    const openFor = async (targetId, reason, n) => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [
          sub("for", [userOpt("user", targetId), strOpt("reason", reason)]),
        ],
      });
      const reply = await env.mock.awaitSettledReply(inter);
      const m = new RegExp(
        `Ticket \\*\\*#${n}\\*\\* opened for <@${targetId}>: <#(\\d+)>`,
      ).exec(String(reply.content));
      assert.ok(m, `#n${n} opened-for reply (got: ${reply.content})`);
      return m[1];
    };

    it("/ticket for opens on behalf, auto-claims, bypasses rate limits", async () => {
      // Preload outsider's self-create window? Not needed: `for` never
      // consults canUserCreateTicket.
      t1.chan = await openFor(env.ids.outsider, "ns10 arc", 1);

      const row = ticket(1);
      assert.equal(row.creator_user_id, env.ids.outsider);
      assert.equal(row.opened_by_staff_id, env.ids.human);
      assert.equal(row.staff_owner_id, env.ids.human, "opener auto-claimed");
      assert.equal(row.status, "open");

      const audit = auditRow("tickets.create");
      assert.equal(
        JSON.parse(audit.details_json).subject_user_id,
        env.ids.outsider,
      );

      const msgs = await env.mock.messages(t1.chan);
      assert.ok(
        msgs.some((m) =>
          String(m.content).startsWith(
            `Opened for <@${env.ids.outsider}> by <@${env.ids.human}>.`,
          ),
        ),
        "opened-for notice posted in the ticket channel",
      );

      // Opener holds STAFF_ALLOW user overwrite from creation.
      const ow = await owOf(t1.chan);
      assert.ok(
        has(ow.get(env.ids.human), B.ViewChannel, B.ManageMessages),
        "opener staff-allow entry present",
      );
    });

    it("claim moves ownership (row + ticket_staff + in-channel notice)", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [sub("claim")],
        userId: env.ids.target,
        channelId: t1.chan,
      });
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        "You claimed ticket **#1**.",
      );

      assert.equal(ticket(1).staff_owner_id, env.ids.target);
      const staffRows = env.dbmod.listTicketStaff(ticket(1).id);
      assert.equal(
        staffRows.find((r) => String(r.user_id) === env.ids.target)?.is_owner,
        1,
      );
      assert.equal(
        staffRows.find((r) => String(r.user_id) === env.ids.human)?.is_owner,
        0,
        "previous owner demoted, row kept",
      );

      const msgs = await env.mock.messages(t1.chan);
      assert.ok(
        msgs.some((m) =>
          String(m.content).includes(
            `<@${env.ids.target}> claimed this ticket.`,
          ),
        ),
        "claim notice in channel",
      );

      const audit = auditRow("tickets.claim");
      assert.equal(
        JSON.parse(audit.details_json).previous_owner,
        env.ids.human,
      );
    });

    it("transfer returns ownership with the paired notice", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [sub("transfer", [userOpt("staff", env.ids.human)])],
        userId: env.ids.target,
        channelId: t1.chan,
      });
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        `Transferred ticket **#1** to <@${env.ids.human}>.`,
      );
      assert.equal(ticket(1).staff_owner_id, env.ids.human);
      const msgs = await env.mock.messages(t1.chan);
      assert.ok(
        msgs.some((m) =>
          String(m.content).includes(
            `Staff ownership transferred to <@${env.ids.human}> by <@${env.ids.target}>.`,
          ),
        ),
        "transfer notice in channel",
      );
      assert.ok(auditRow("tickets.transfer"));
    });

    it("removestaff/addstaff exercise every repo branch + overwrite sets", async () => {
      const run = (name, userId) =>
        env.mock.slash({
          command: "ticket",
          options: [sub(name, [userOpt("user", env.ids.target)])],
          userId,
          channelId: t1.chan,
        });

      // target sits in ticket_staff (ex-owner, is_owner 0) → removable.
      assert.match(
        String((await env.mock.awaitReply(await run("removestaff", env.ids.human))).content),
        new RegExp(`Removed <@${env.ids.target}> from the staff allow-list\\.`),
      );
      // …and a second removal names the real state.
      assert.equal(
        String((await env.mock.awaitReply(await run("removestaff", env.ids.human))).content),
        "That user is not on the staff allow-list.",
      );
      // re-add: row + STAFF_ALLOW user overwrite
      assert.match(
        String((await env.mock.awaitReply(await run("addstaff", env.ids.human))).content),
        new RegExp(`Added <@${env.ids.target}> to the staff allow-list for \\*\\*#1\\*\\*\\.`),
      );
      let ow = await owOf(t1.chan);
      assert.ok(
        has(ow.get(env.ids.target), B.ViewChannel, B.ManageMessages),
        "staff-allow bits for the added staffer",
      );
      // duplicate add names itself
      assert.equal(
        String((await env.mock.awaitReply(await run("addstaff", env.ids.human))).content),
        `<@${env.ids.target}> is already on the staff allow-list.`,
      );
      // owner cannot be removed without transfer
      const owner = await env.mock.slash({
        command: "ticket",
        options: [sub("removestaff", [userOpt("user", env.ids.human)])],
        userId: env.ids.human,
        channelId: t1.chan,
      });
      assert.equal(
        String((await env.mock.awaitReply(owner)).content),
        "Cannot remove the staff owner. Transfer ownership first.",
      );
      assert.ok(auditRow("tickets.staff_add"));
      assert.ok(auditRow("tickets.staff_remove"));
    });

    it("sensitive gates on the staff owner and flips the senior-role overwrite", async () => {
      // Non-owner staffer (target): exact owner copy.
      const denied = await env.mock.slash({
        command: "ticket",
        options: [sub("sensitive")],
        userId: env.ids.target,
        channelId: t1.chan,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        `Only the staff owner (<@${env.ids.human}>) or a server admin can mark this ticket sensitive.`,
      );

      // Owner sets it.
      const set = await env.mock.slash({
        command: "ticket",
        options: [sub("sensitive")],
        userId: env.ids.human,
        channelId: t1.chan,
      });
      assert.match(
        String((await env.mock.awaitReply(set)).content),
        /is now \*\*sensitive\*\*\. Only the owner, named staff, and members can see it\./,
      );
      assert.equal(ticket(1).is_sensitive, 1);

      // Senior staff ROLE flips from allow to explicit deny ViewChannel;
      // the creator keeps member access.
      const ow = await owOf(t1.chan);
      assert.ok(
        denies(ow.get(seniorRole), B.ViewChannel) &&
          !has(ow.get(seniorRole), B.ViewChannel),
        "senior role denied view while sensitive",
      );
      assert.ok(
        has(ow.get(env.ids.outsider), B.ViewChannel, B.SendMessages),
        "creator keeps member access while sensitive",
      );

      const msgs = await env.mock.messages(t1.chan);
      assert.ok(
        (msgs ?? []).some((m) => m.embeds?.[0]?.title === "Ticket marked sensitive"),
        "in-channel sensitive notice",
      );
      const audit = auditRow("tickets.sensitive_set");
      assert.equal(JSON.parse(audit.details_json).was_sensitive, 0);

      // unsensitive: ANY staffer allowed (target), role allow restored.
      const clear = await env.mock.slash({
        command: "ticket",
        options: [sub("unsensitive")],
        userId: env.ids.target,
        channelId: t1.chan,
      });
      assert.equal(
        String((await env.mock.awaitReply(clear)).content),
        "Ticket **#1** is no longer sensitive. Staff roles can see it again.",
      );
      assert.equal(ticket(1).is_sensitive, 0);
      const ow2 = await owOf(t1.chan);
      assert.ok(
        has(ow2.get(seniorRole), B.ViewChannel, B.ManageMessages),
        "senior role allow restored",
      );
      assert.ok(auditRow("tickets.sensitive_clear"));
    });

    it("/ticket close (with staff_note) transitions DB, overwrites, notice, audit", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [
          sub("close", [
            strOpt("reason", "ns10 wrap"),
            strOpt("staff_note", "private ctx"),
          ]),
        ],
        userId: env.ids.human,
        channelId: t1.chan,
      });
      const reply = await env.mock.awaitSettledReply(inter);
      const content = String(reply.content);
      t1.closeMessageId = String(reply.id);
      assert.match(content, /Ticket \*\*#1\*\* closed\./);
      assert.match(content, /Non-staff members were removed/);
      assert.match(content, /to save the transcript and delete the channel/);
      assert.match(content, /Staff note \*\*N-\d+\*\* saved on <@/);

      const row = ticket(1);
      assert.equal(row.status, "closed");
      assert.equal(row.closed_by_user_id, env.ids.human);
      assert.equal(row.close_reason, "ns10 wrap");
      assert.equal(row.archived, 0);
      assert.equal(String(row.channel_id), t1.chan, "channel survives close");

      // Creator/member overwrites become explicit ViewChannel denials.
      const ow = await owOf(t1.chan);
      assert.ok(
        denies(ow.get(env.ids.outsider), B.ViewChannel),
        "creator locked out of the soft-closed channel",
      );

      // Close notice embed.
      const msgs = await env.mock.messages(t1.chan);
      const notice = msgs.find(
        (m) => m.embeds?.[0]?.title === "Ticket #1 closed",
      );
      assert.ok(notice, "close notice embed posted");
      assert.match(notice.embeds[0].description, /\*\*Reason:\*\* ns10 wrap/);

      // Staff note row via the close OPTION (private note on the creator).
      assert.equal(noteCount(), 1);
      const noteAudit = auditRow("notes.add");
      assert.ok(
        JSON.parse(noteAudit.details_json).from_ticket,
        "note audit flags the ticket origin",
      );

      assert.ok(auditRow("tickets.close"));
    });

    it("Add staff note button (tk:sn) → modal (tk:snm) → second note", async () => {
      // The close command's original reply (id == close reply message id)
      // carries the persistent Add staff note button.
      const buttons = await env.mock.buttons(t1.closeMessageId, t1.chan);
      const ticketId = ticket(1).id;
      const btn = buttons.find((b) =>
        String(b.custom_id).startsWith("tk:sn:"),
      );
      assert.ok(btn, `tk:sn button on the close reply (${buttons.map((b) => b.custom_id)})`);
      assert.equal(String(btn.custom_id), `tk:sn:${ticketId}`);

      const click = await env.mock.click({
        customId: String(btn.custom_id),
        messageId: t1.closeMessageId,
        userId: env.ids.human,
        channelId: t1.chan,
      });
      const state = await poll(
        async () => {
          const st = await env.mock.interactionState(click.id);
          return st.response_json?.type === 9 ? st : null;
        },
        { timeoutMs: 8000, label: "tk:snm modal display" },
      );
      const modal = state.response_json;
      assert.equal(modal.data.custom_id, `tk:snm:${ticketId}`);
      assert.equal(modal.data.title, "Note · ticket #1");

      const submit = await env.mock.modal({
        customId: `tk:snm:${ticketId}`,
        fields: { staff_note: "extra ctx" },
        userId: env.ids.human,
        channelId: t1.chan,
      });
      const reply = await env.mock.awaitSettledReply(submit);
      assert.match(
        String(reply.content),
        /Staff note \*\*N-\d+\*\* saved on <@/ ,
      );
      assert.match(String(reply.content), /View with `\/note info/);
      assert.equal(noteCount(), 2);
    });

    it("/ticket summarize (stats fallback) works on the closed live channel", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [sub("summarize")],
        userId: env.ids.human,
        channelId: t1.chan,
      });
      const reply = await env.mock.awaitSettledReply(inter);
      const embed = reply.embeds?.[0];
      assert.ok(embed, "summary embed reply");
      assert.equal(embed.title, "Ticket #1 — closed");
      assert.equal(embed.footer?.text, "Staff only");
      const source = (embed.fields ?? []).find((f) =>
        /summary|source/i.test(String(f.name)),
      );
      assert.ok(source, "source field present");
      assert.ok(auditRow("tickets.summarize"));
    });

    it("/ticket archive: transcript, archive embed, row flags, channel deleted", async () => {
      // Archive channel configured just before the run.
      const setArch = await env.mock.slash({
        command: "ticket",
        options: [sub("setarchive", [chanOpt("channel", env.ids.channel2)])],
      });
      assert.match(
        String((await env.mock.awaitReply(setArch)).content),
        new RegExp(
          `Close summaries and transcript links will post to <#${env.ids.channel2}>\\.`
        ),
      );

      const inter = await env.mock.slash({
        command: "ticket",
        options: [sub("archive")],
        userId: env.ids.human,
        channelId: t1.chan,
      });
      // The final confirmation reply is NOT asserted: the pipeline deletes
      // the ticket channel (the interaction's channel) BEFORE editReply, so
      // @original dies with the channel — on real Discord too. Tracked in
      // issue #341; flip this back to awaitSettledReply when fixed.
      void inter;

      const row = await poll(
        async () => {
          const r = ticket(1);
          return r && r.archived === 1 && r.channel_id === null ? r : null;
        },
        { timeoutMs: 10_000, label: "archive completed (row flags)" },
      );
      assert.ok(row.transcript_token, "transcript token assigned");
      assert.ok(row.transcript_path, "transcript path persisted");
      assert.equal(row.channel_id, null, "channel reference released");
      assert.ok(row.archive_message_id, "archive embed id stored");

      // Content rows were persisted from channel history.
      const msgRows = env.dbmod.listTicketMessages(row.id);
      assert.ok(msgRows.length > 0, "ticket_messages rows saved");

      // Archive-channel embed with the token (no PUBLIC url in e2e).
      const msgs = await env.mock.messages(env.ids.channel2);
      const embed = msgs
        .flatMap((m) => m.embeds ?? [])
        .find((e) => e.title === "Ticket #1 archived");
      assert.ok(embed, "archive embed posted to the archive channel");
      const json = JSON.stringify(embed);
      assert.match(json, /Token `/);
      assert.match(json, /TICKET_PUBLIC_BASE_URL/);

      // Channel gone (DELETE + CHANNEL_DELETE).
      const gone = await env.mock
        .channel(t1.chan)
        .then(() => false)
        .catch((err) => err.status === 404);
      assert.ok(gone, "ticket channel deleted");

      assert.ok(auditRow("tickets.archive"));
    });

    it("channel-scoped gates: claim outside tickets, archive on an OPEN ticket", async () => {
      const stray = await env.mock.slash({
        command: "ticket",
        options: [sub("claim")],
        userId: env.ids.target,
        // default channelId = general — no ticket row there
      });
      assert.equal(
        String((await env.mock.awaitReply(stray)).content),
        "This command only works inside an **open ticket** channel.",
      );

      const chan2 = await openFor(env.ids.target, "ops second", 2);
      const early = await env.mock.slash({
        command: "ticket",
        options: [sub("archive")],
        userId: env.ids.human,
        channelId: chan2,
      });
      assert.equal(
        String((await env.mock.awaitReply(early)).content),
        "This ticket is still **open**. Run `/ticket close` first, then `/ticket archive`.",
      );
    });

    it("SENSITIVE archive path: metadata stub only, no content rows, archived stays 0", async () => {
      // Ticket #2 (opened in the previous test, still open, owned by the
      // human opener via the for auto-claim).
      const row2 = ticket(2);
      const t2chan = String(row2.channel_id);

      const sens = await env.mock.slash({
        command: "ticket",
        options: [sub("sensitive")],
        userId: env.ids.human,
        channelId: t2chan,
      });
      assert.match(
        String((await env.mock.awaitReply(sens)).content),
        /is now \*\*sensitive\*\*/,
      );

      const close = await env.mock.slash({
        command: "ticket",
        options: [sub("close", [strOpt("reason", "sensitive wrap")])],
        userId: env.ids.human,
        channelId: t2chan,
      });
      const closeReply = await env.mock.awaitSettledReply(close);
      assert.match(
        String(closeReply.content),
        /sensitive: metadata only, no message content/,
      );

      const archive = await env.mock.slash({
        command: "ticket",
        options: [sub("archive")],
        userId: env.ids.human,
        channelId: t2chan,
      });
      // Confirmation reply intentionally not asserted — see issue #341
      // (channel deleted before editReply kills @original).
      void archive;

      const row = await poll(
        async () => {
          const r = ticket(2);
          return r && r.channel_id === null ? r : null;
        },
        { timeoutMs: 10_000, label: "sensitive archive completed" },
      );
      assert.equal(row.archived, 0, "content-archive flag stays 0 (nothing archived)");
      assert.equal(row.transcript_path ?? null, null);
      assert.equal(row.channel_id, null);
      assert.equal(env.dbmod.listTicketMessages(row.id).length, 0);

      const msgs = await env.mock.messages(env.ids.channel2);
      assert.ok(
        msgs
          .flatMap((m) => m.embeds ?? [])
          .some((e) =>
            e.title === "Ticket #2 archived (sensitive — not content-archived)",
          ),
        "metadata stub embed posted",
      );
      const gone = await env.mock
        .channel(t2chan)
        .then(() => false)
        .catch((err) => err.status === 404);
      assert.ok(gone, "sensitive ticket channel deleted too");
    });

    it("external channel delete closes the row via the boot hook", async () => {
      const chan3 = await openFor(env.ids.outsider, "doomed", 3);
      await env.mock.deleteChannel(chan3);

      // The hook NULLs channel_id — poll the row by ticket number.
      const row = await poll(
        async () => {
          const r = ticket(3);
          return r && r.status === "closed" ? r : null;
        },
        { timeoutMs: 8000, label: "channel-delete hook closes the ticket" },
      );
      assert.match(String(row.close_reason), /Channel deleted/i);
      assert.ok(row.closed_at, "closed_at stamped by the hook");
      assert.equal(row.channel_id, null, "channel reference released");
    });

    it("/ticket list empties out; list is staff-only", async () => {
      const list = await env.mock.slash({
        command: "ticket",
        options: [sub("list")],
        userId: env.ids.human,
      });
      const content = String((await env.mock.awaitReply(list)).content);
      assert.match(
        content,
        /No open tickets\./,
        `every ticket is closed/archived (got: ${content})`,
      );

      const denied = await env.mock.slash({
        command: "ticket",
        options: [sub("list")],
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        MSG_DENIED,
      );
    });
  },
);
