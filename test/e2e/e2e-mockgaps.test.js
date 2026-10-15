const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll } = require("./helpers/mockenv");

/**
 * Tier-4 proof suites for the fauxcord patch series part 2 (issue #328):
 * every simulated interaction kind proven here must round-trip through the
 * REAL bot (gateway → router → handler → callback → DB). One group per
 * mock gap. Voice states (gap 6) and DMs (gap 7) remain open per #328 —
 * the dependent feature rows stay `it.todo` in their coverage suites.
 * Namespace 23.
 */
describe("e2e: mock-gap proofs (fauxcord patch series part 2)", { concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
  let env;
  /** message the reaction tests act on (shared to keep the arc explicit) */
  let reactMsgId = null;

  before(async () => {
    env = await createE2eEnv({ ns: 23 });
    // staff operator for surfaces gated on staff (notes, tickets, …)
    const role = await env.mock.createRole("E2E Gap Staff");
    await env.mock.grantRole(env.ids.human, role.id);
    env.dbmod.addStaffRole(env.communityId, String(role.id), "senior");
    // Bot must hold a role strictly above the staff role for ticket-channel
    // senior overwrites to be "manageable" (hierarchy rule in overwrites.js).
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

  // ── gap 1: modal submit ────────────────────────────────────────────────

  it("#328-1 modal display is stored as a type-9 callback (no phantom message)", async () => {
    // /note add WITHOUT content opens the note:add:<userId> modal. The mock
    // persists the display payload on the interaction row and creates NO
    // channel message.
    const inter = await env.mock.slash({
      command: "note",
      options: [
        {
          name: "add",
          type: 1,
          options: [{ name: "user", type: 6, value: env.ids.target }],
        },
      ],
    });
    const state = await awaitCallback(inter.id, 9, "modal display stored");
    assert.equal(state.response_json?.type, 9, "MODAL response stored");
    assert.equal(
      state.response_json?.data?.custom_id,
      `note:add:${env.ids.target}`,
      "modal custom_id carries the subject user",
    );
    const field = state.response_json.data.components
      .flatMap((row) => row.components || [])
      .find((c) => c.type === 4);
    assert.equal(field?.custom_id, "content", "text input field present");
    assert.equal(
      state.initial_response_message_id,
      null,
      "modal display creates no message",
    );
  });

  it("#328-1 modal submit round-trip: fields → handler → note row + reply", async () => {
    const submitted = await env.mock.modal({
      customId: `note:add:${env.ids.target}`,
      fields: { content: "gap-proof note body" },
    });
    const reply = await env.mock.awaitReply(submitted);
    assert.match(
      String(reply.embeds?.[0]?.title),
      /Note N-1 created/,
      "handler replied with the created-note embed",
    );

    const row = env.dbmod.db
      .prepare(
        "SELECT * FROM staff_notes WHERE community_id = ? AND user_id = ?",
      )
      .get(env.communityId, env.ids.target);
    assert.ok(row, "staff note row persisted");
    assert.equal(row.content, "gap-proof note body");
    assert.equal(row.author_id, env.ids.human);
  });

  it("#328-1 modal submit delivers field VALUES verbatim (validation copy proof)", async () => {
    // Whitespace-only content must hit the handler's own validation copy —
    // proves the submitted value reaches getTextInputValue (a dropped field
    // would throw missing-option before the handler gate).
    const submitted = await env.mock.modal({
      customId: `note:add:${env.ids.target}`,
      fields: { content: "   " },
    });
    const reply = await env.mock.awaitReply(submitted);
    assert.equal(
      String(reply.content),
      "Note content cannot be empty.",
      "handler validation copy surfaced",
    );
    const count = env.dbmod.db
      .prepare("SELECT COUNT(*) n FROM staff_notes WHERE community_id = ?")
      .get(env.communityId).n;
    assert.equal(count, 1, "no note row for the rejected submit");
  });

  // ── gap 2: autocomplete ────────────────────────────────────────────────

  it("#328-2 autocomplete: focused option → handler → choices callback", async () => {
    env.dbmod.addGithubWatch(env.communityId, "metalsp0rk/boiler-snake", "boiler-snake");

    const inter = await env.mock.autocomplete({
      command: "github",
      options: [{ name: "repo", type: 3, value: "boiler", focused: true }],
    });
    const state = await awaitCallback(inter.id, 8, "autocomplete choices");
    const choices = state.response_json?.data?.choices ?? [];
    assert.ok(
      choices.some((c) => c.value === "metalsp0rk/boiler-snake"),
      `seeded repo surfaced in choices: ${JSON.stringify(choices)}`,
    );
  });

  it("#328-2 autocomplete: non-matching focus → empty choices", async () => {
    const inter = await env.mock.autocomplete({
      command: "github",
      options: [{ name: "repo", type: 3, value: "zzz-no-match", focused: true }],
    });
    const state = await awaitCallback(inter.id, 8, "autocomplete empty choices");
    assert.deepEqual(state.response_json.data.choices, []);
  });

  // ── gap 3: human reaction injection ────────────────────────────────────

  it("#328-3 injected REACTION_ADD awards reaction XP through the pipeline", async () => {
    const xpOf = (userId) =>
      env.dbmod.db
        .prepare("SELECT xp FROM users WHERE community_id = ? AND user_id = ?")
        .get(env.communityId, userId)?.xp ?? 0;

    // Fresh message authored by TARGET; reactor is the OUTSIDER, so the
    // only XP source for the outsider is the reaction itself.
    const msg = await env.mock.inject("gap-proof reaction target", env.ids.target);
    reactMsgId = msg.id;
    assert.equal(xpOf(env.ids.outsider), 0, "reactor starts at 0 XP");

    await env.mock.react({ messageId: msg.id, emoji: "🎉", userId: env.ids.outsider });
    await poll(() => (xpOf(env.ids.outsider) > 0 ? true : null), {
      timeoutMs: 8000,
      label: "reaction XP award",
    });
    const gained = xpOf(env.ids.outsider);
    assert.equal(gained, 2, "reaction_xp default (2) awarded exactly once");
  });

  it("#328-3 second reaction within the window: REACTION_ADD honors the reaction cooldown", async () => {
    const xpOf = (userId) =>
      env.dbmod.db
        .prepare("SELECT xp FROM users WHERE community_id = ? AND user_id = ?")
        .get(env.communityId, userId)?.xp ?? 0;
    const before = xpOf(env.ids.outsider);

    const msg = await env.mock.inject("gap-proof reaction target 2", env.ids.target);
    await env.mock.react({ messageId: msg.id, emoji: "🎉", userId: env.ids.outsider });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(
      xpOf(env.ids.outsider),
      before,
      "default 10s reaction cooldown suppressed the second award",
    );
  });

  it("#328-3 unreact dispatches REACTION_REMOVE (no negative XP, no crash)", async () => {
    // Remove then re-check: reaction removal must never mutate the total.
    assert.ok(reactMsgId, "reaction message available from the award test");
    const before =
      env.dbmod.db
        .prepare("SELECT xp FROM users WHERE community_id = ? AND user_id = ?")
        .get(env.communityId, env.ids.outsider)?.xp ?? 0;
    await env.mock.unreact({ messageId: reactMsgId, emoji: "🎉", userId: env.ids.outsider });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      env.dbmod.db
        .prepare("SELECT xp FROM users WHERE community_id = ? AND user_id = ?")
        .get(env.communityId, env.ids.outsider)?.xp ?? 0,
      before,
      "REACTION_REMOVE left the XP total untouched",
    );
  });

  // ── patch round 3: deferred replies + overwrite fidelity (#317 unblock) ──

  let panelMessageId = null;
  let ticketChannelId = null;

  it("deferred editReply lands on a real original message (panel create)", async () => {
    // /ticket panel create defers, posts the panel via channel.send, then
    // editReplies. Pre-patch the defer created NO placeholder, so the
    // editReply 404'd and only the router's generic follow-up survived.
    const inter = await env.mock.slash({
      command: "ticket",
      options: [
        {
          name: "panel",
          type: 2,
          options: [{ name: "create", type: 1 }],
        },
      ],
    });
    const reply = await env.mock.awaitSettledReply(inter);
    assert.match(String(reply.content), /Created ticket panel in </);

    const panel = env.dbmod.listTicketPanels(env.communityId)[0];
    assert.ok(panel, "ticket_panels row persisted");
    panelMessageId = String(panel.message_id);

    // channel.send messages now persist components AND the panel embed.
    const msg = await env.mock.message(panelMessageId, String(panel.channel_id));
    assert.equal(msg.embeds?.[0]?.title, "Support Tickets");
    const open = (msg.components ?? [])
      .flatMap((row) => (row.type === 1 ? row.components ?? [] : [row]))
      .find((c) => c.custom_id === "tk:open");
    assert.ok(open, "tk:open button persisted on the panel message");
  });

  it("modal-submit ticket open persists creation-time channel overwrites", async () => {
    // Member journey: tk:open click → type-9 modal display → tk:create
    // submit with a reason → channel + row + deferred reply.
    const openClick = await env.mock.click({
      customId: "tk:open",
      messageId: panelMessageId,
      userId: env.ids.outsider,
    });
    await poll(
      async () => {
        const st = await env.mock.interactionState(openClick.id);
        return st.response_json?.type === 9 ? st : null;
      },
      { timeoutMs: 8000, label: "ticket modal display" },
    );

    const submit = await env.mock.modal({
      customId: "tk:create",
      fields: { reason: "v7 overwrite proof" },
      userId: env.ids.outsider,
    });
    const reply = await env.mock.awaitSettledReply(submit);
    const m = /Ticket \*\*#1\*\* opened: <#(\d+)>/.exec(String(reply.content));
    assert.ok(m, `success reply with channel mention (got: ${reply.content})`);
    ticketChannelId = m[1];

    const ticket = env.dbmod.getTicketByChannel(env.communityId, ticketChannelId);
    assert.equal(ticket.creator_user_id, env.ids.outsider);
    assert.equal(ticket.status, "open");
    assert.equal(ticket.reason, "v7 overwrite proof");

    // Creation-time overwrites are READABLE on the channel (pre-patch the
    // mock discarded them): @everyone denied view, bot full, creator member
    // bits, senior staff bits.
    const ch = await env.mock.channel(ticketChannelId);
    const ow = new Map(
      (ch.permission_overwrites ?? []).map((o) => [String(o.id), o]),
    );
    const has = (entry, ...bits) =>
      entry != null &&
      bits.every((b) => (BigInt(entry.allow ?? 0) & b) === b);
    const denies = (entry, bit) => (BigInt(entry?.deny ?? 0) & bit) === bit;
    const B = PermissionFlagsBits;

    assert.ok(
      denies(ow.get(env.ids.guild), B.ViewChannel),
      "@everyone denied view",
    );
    assert.ok(
      has(ow.get(env.ids.app), B.ManageChannels, B.ViewChannel, B.SendMessages),
      "bot allow carries ManageChannels + talk-back bits",
    );
    assert.ok(
      has(ow.get(env.ids.outsider), B.ViewChannel, B.SendMessages) &&
        denies(ow.get(env.ids.outsider), B.ManageMessages),
      "creator member allow + manage-messages deny",
    );
    assert.ok(
      [...ow.values()].some(
        (o) => o.type === 0 && has(o, B.ViewChannel, B.ManageMessages),
      ),
      "senior staff role allow present",
    );
  });

  it("PATCH-set overwrites replace the stored set (/ticket adduser)", async () => {
    // Staff adds a user inside the ticket channel; discord.js re-applies
    // the FULL overwrite set via channel PATCH — the mock must REPLACE.
    const add = await env.mock.slash({
      command: "ticket",
      options: [
        {
          name: "adduser",
          type: 1,
          options: [{ name: "user", type: 6, value: env.ids.target }],
        },
      ],
      userId: env.ids.human,
      channelId: ticketChannelId,
    });
    await env.mock.awaitReply(add);

    const ch = await env.mock.channel(ticketChannelId);
    const ow = new Map(
      (ch.permission_overwrites ?? []).map((o) => [String(o.id), o]),
    );
    const added = ow.get(env.ids.target);
    assert.ok(
      added != null &&
        (BigInt(added.allow ?? 0) &
          (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages)) ===
          (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages),
      "added user now carries member bits",
    );
    const ticket = env.dbmod.getTicketByChannel(env.communityId, ticketChannelId);
    assert.ok(
      env.dbmod
        .listTicketMembers(ticket.id)
        .some((r) => String(r.user_id) === env.ids.target),
      "ticket_members row recorded",
    );
  });
});
