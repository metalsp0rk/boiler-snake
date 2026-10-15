const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { namespaceIds, poll } = require("./helpers/mockenv");

/**
 * Tier-4 tickets member-flow coverage (issue #317, part 2/3).
 * Namespace 9: /ticket create (modal + direct), self-create rate limiting,
 * ticket-channel shape (name, overwrites, open notice, parent category),
 * the category-missing error translation, and the /ticket channel-gate
 * exception inside open ticket channels.
 */
describe(
  "e2e: ticket member flows (open, modal, rate limit)",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    let staffRoleId;

    const ids = namespaceIds(9);

    before(async () => {
      env = await createE2eEnv({
        ns: 9,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "e2e-two" },
          { id: ids.category, name: "Support", type: 4 },
        ],
      });
      staffRoleId = (await env.mock.createRole("E2E Member Staff")).id;
      await env.mock.grantRole(env.ids.human, staffRoleId);
      env.dbmod.addStaffRole(env.communityId, String(staffRoleId), "junior");
      // human also holds ManageGuild (needed for /setcommandchannel)
      const adminRole = await env.mock.createRole("E2E Member Admin", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, adminRole.id);
    });

    after(async () => {
      await env?.cleanup();
    });

    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const createSub = (...options) => ({
      name: "create",
      type: 1,
      ...(options.length && { options }),
    });
    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);
    const ticketCount = () =>
      env.dbmod.db
        .prepare("SELECT COUNT(*) AS n FROM tickets WHERE community_id = ?")
        .get(env.communityId).n;

    let ticket1 = null; // { number, channelId }

    it("/ticket create without a reason opens the tk:create modal (type 9)", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [createSub()],
        userId: env.ids.outsider,
      });
      const state = await poll(
        async () => {
          const st = await env.mock.interactionState(inter.id);
          return st.response_json?.type === 9 ? st : null;
        },
        { timeoutMs: 8000, label: "tk:create modal display" },
      );
      const modal = state.response_json;
      assert.equal(modal.data.custom_id, "tk:create");
      assert.equal(modal.data.title, "Open a support ticket");
      const field = modal.data.components[0].components[0];
      assert.equal(field.custom_id, "reason");
      assert.equal(field.label, "How can we help?");
      assert.equal(ticketCount(), 0, "no ticket row before submit");
    });

    it("modal submit creates channel + row + notice with correct overwrites", async () => {
      const submit = await env.mock.modal({
        customId: "tk:create",
        fields: { reason: "E2E broken deploy" },
        userId: env.ids.outsider,
      });
      const reply = await env.mock.awaitSettledReply(submit);
      const m = /Ticket \*\*#1\*\* opened: <#(\d+)>/.exec(String(reply.content));
      assert.ok(m, `success reply (got: ${reply.content})`);
      const channelId = m[1];
      ticket1 = { number: 1, channelId };

      const ch = await env.mock.channel(channelId);
      assert.equal(ch.name, "ticket-1");
      assert.equal(ch.parent_id ?? null, null, "no category configured yet");

      const row = env.dbmod.getTicketByChannel(env.communityId, channelId);
      assert.equal(row.creator_user_id, env.ids.outsider);
      assert.equal(row.ticket_number, 1);
      assert.equal(row.status, "open");
      assert.equal(row.reason, "E2E broken deploy");
      assert.equal(row.opened_by_staff_id, null);

      const audit = auditRow("tickets.create");
      assert.equal(audit.actor_user_id, env.ids.outsider);
      assert.equal(JSON.parse(audit.details_json).channel_id, channelId);

      // Open notice posted INTO the ticket channel.
      const msgs = await env.mock.messages(channelId);
      const notice = msgs.find((x) =>
        String(x.content).startsWith(`<@${env.ids.outsider}>`),
      );
      assert.ok(notice, "welcome notice present");
      assert.match(notice.content, /staff will be with you shortly/);
      assert.equal(notice.embeds?.[0]?.title, "Ticket #1");
      assert.equal(
        notice.embeds?.[0]?.description,
        "E2E broken deploy",
      );

      // Channel overwrites: creator member bits + manage deny; junior
      // staff role gets NOTHING automatically (senior-only rule).
      const ow = new Map(
        (ch.permission_overwrites ?? []).map((o) => [String(o.id), o]),
      );
      const creator = ow.get(env.ids.outsider);
      const memberBits =
        PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages;
      assert.equal(
        BigInt(creator.allow) & memberBits,
        memberBits,
        "creator can view + send",
      );
      assert.equal(
        BigInt(creator.deny) & PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageMessages,
        "creator denied manage-messages",
      );
      assert.ok(!ow.has(String(staffRoleId)), "junior staff NOT auto-granted");
      assert.equal(
        BigInt(ow.get(env.ids.guild).deny) & PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ViewChannel,
        "@everyone denied view",
      );
    });

    it("second self-create inside the DEFAULT 60-min window is rate-limited", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [createSub({ name: "reason", type: 3, value: "second attempt" })],
        userId: env.ids.outsider,
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      assert.match(content, /You're creating tickets too quickly\./);
      assert.match(content, /rate limit: 60 min between self-creates/);
      assert.equal(ticketCount(), 1, "no second row");
    });

    it("rate limit disabled → direct create (with reason) skips the modal", async () => {
      const rl = await env.mock.slash({
        command: "ticket",
        options: [
          {
            name: "setratelimit",
            type: 1,
            options: [{ name: "minutes", type: 4, value: 0 }],
          },
        ],
      });
      assert.equal(
        String((await env.mock.awaitReply(rl)).content),
        "Member self-create rate limit **disabled**.",
      );

      const inter = await env.mock.slash({
        command: "ticket",
        options: [createSub({ name: "reason", type: 3, value: "second" })],
        userId: env.ids.outsider,
      });
      const reply = await env.mock.awaitSettledReply(inter);
      const m = /Ticket \*\*#2\*\* opened: <#(\d+)>/.exec(String(reply.content));
      assert.ok(m, `direct create reply (got: ${reply.content})`);
      const row = env.dbmod.getTicketByChannel(env.communityId, m[1]);
      assert.equal(row.reason, "second");
      assert.equal(ticketCount(), 2);
    });

    it("category configured → new tickets land under it (parent_id)", async () => {
      const cat = await env.mock.slash({
        command: "ticket",
        options: [
          {
            name: "setcategory",
            type: 1,
            options: [chanOpt("category", ids.category)],
          },
        ],
      });
      assert.equal(
        String((await env.mock.awaitReply(cat)).content),
        "New tickets will be created under **Support**.",
      );

      const inter = await env.mock.slash({
        command: "ticket",
        options: [createSub({ name: "reason", type: 3, value: "in category" })],
        userId: env.ids.outsider,
      });
      const reply = await env.mock.awaitSettledReply(inter);
      const m = /Ticket \*\*#3\*\* opened: <#(\d+)>/.exec(String(reply.content));
      assert.ok(m, `categorized create (got: ${reply.content})`);
      const ch = await env.mock.channel(m[1]);
      assert.equal(ch.parent_id, ids.category, "parent category honored");
    });

    it("deleted category → specific BOT_PERMISSIONS copy, no ticket, no crash", async () => {
      // Cache-eviction path of assertBotCanCreateTickets: the configured
      // category disappears from the guild (CHANNEL_DELETE), so the user-
      // facing error names the exact fix (AGENTS: replies carry the cause).
      await env.mock.deleteChannel(ids.category);

      const inter = await env.mock.slash({
        command: "ticket",
        options: [createSub({ name: "reason", type: 3, value: "orphan" })],
        userId: env.ids.outsider,
      });
      const content = String(
        (await env.mock.awaitSettledReply(inter)).content,
      );
      assert.equal(
        content,
        "The configured ticket category no longer exists. Run `/ticket setcategory` with a valid category.",
      );
      assert.equal(ticketCount(), 3, "no ticket invented");
    });

    it("/ticket bypasses the command-channel gate only inside open ticket channels", async () => {
      const add = await env.mock.slash({
        command: "setcommandchannel",
        options: [
          {
            name: "add",
            type: 1,
            options: [chanOpt("channel", ids.channel2)],
          },
        ],
      });
      assert.match(
        String((await env.mock.awaitReply(add)).content),
        /Commands are now allowed/,
      );

      // Outside the allow-list: gated like every other command.
      const gated = await env.mock.slash({
        command: "ticket",
        options: [{ name: "settings", type: 1 }],
        userId: env.ids.outsider,
        channelId: ids.general,
      });
      assert.equal(
        String((await env.mock.awaitReply(gated)).content),
        "Commands aren't enabled in this channel.",
      );

      // Inside the OPEN ticket channel: lifecycle exception applies.
      const inside = await env.mock.slash({
        command: "ticket",
        options: [{ name: "settings", type: 1 }],
        userId: env.ids.outsider,
        channelId: ticket1.channelId,
      });
      assert.match(
        String((await env.mock.awaitReply(inside)).content),
        /\*\*Ticket settings\*\*/,
      );

      // And on an explicitly allowed channel, too.
      const listed = await env.mock.slash({
        command: "ticket",
        options: [{ name: "settings", type: 1 }],
        userId: env.ids.outsider,
        channelId: ids.channel2,
      });
      assert.match(
        String((await env.mock.awaitReply(listed)).content),
        /\*\*Ticket settings\*\*/,
      );
    });
  },
);
