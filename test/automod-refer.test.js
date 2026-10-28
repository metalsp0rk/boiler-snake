/**
 * #726 (epic #723): staff referral into auto-moderation — the intake seam.
 *
 * Covers the referral SERVICE (test/automod-commands.test.js owns the slash
 * wiring, docs quote these exact strings):
 *  - the full refusal battery, EACH gate ALONE → its own specific string and
 *    ZERO automod_cases rows written (contract order: master switch →
 *    channel unset → channel unpostable → rules → budget → target → note →
 *    link format → cross-guild → gone channel → referrer viewability → gone
 *    message);
 *  - happy paths for every shape (message-only / user-only / both / the
 *    context-menu arm — #771: both arms OPEN THE REFERRAL MODAL and the
 *    case is written on submit), the A-n per-community allocation
 *    (staffNotes N-n precedent) with two communities independent;
 *  - the budget is READ, never consumed here (consumeAutomodCase is #728's
 *    accept-time seam) and the breaker PAUSE is never a refusal (contract-
 *    explicit pin);
 *  - the referrer's note is case input: staff_notes stays at zero rows;
 *  - the ack's exact shape — 'Case: **A-n** — recorded.' + where
 *    recommendations will post — and never claims one was produced.
 *
 * Deps fakes per the service's ReferDeps seam; the context-menu arm uses a
 * local MessageContextMenuCommandInteraction mock (ticket-reports-invoke
 * style) so the resolver name pin ("message", verified against discord.js'
 * targetMessage getter) is enforced.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(() => cleanup());

const { PermissionFlagsBits } = require("discord.js");
const refer = require("../src/features/automod/refer");
const automod = require("../src/features/automod");
const settingsService = require("../src/features/automod/settings");
const budgetRepo = require("../src/db/repositories/automodSettings");
const cases = require("../src/db/repositories/automodCases");
const { MSG_DENIED } = require("../src/core/theme");

const GUILD = "930000000000000001";
const AMOD_CH = "700000000000000101";
const SRC_CH = "700000000000000102";
const MSG = "800000000000000001";
const OTHER_GUILD = "930999999999999999";
const REFERRER = "u-referrer-726";

let seq = 0;
const freshCommunity = () => communityKey(`${GUILD}-726-${++seq}`);

/** Full message link (strict grammar). */
const msgLink = (guildId = GUILD, channelId = SRC_CH, messageId = MSG) =>
  `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

/** Configure a community through the SHIPPED service (no raw SQL). */
function readyCommunity() {
  const communityId = freshCommunity();
  settingsService.setEnabled(communityId, true);
  settingsService.setChannel(communityId, AMOD_CH);
  settingsService.setRules(communityId, "No spam. No hate speech. Be kind.");
  return communityId;
}

// ── deps fakes ─────────────────────────────────────────────────────────────

/**
 * Guild-channel fake shaped for the service's permission reads:
 * permissionsFor(member).has(flag) + messages.fetch for the link path.
 */
function fakeChannel({ view = true, send = true, fetch } = {}) {
  return {
    permissionsFor: () => ({
      has: (flag) => {
        if (flag === PermissionFlagsBits.ViewChannel) return view === true;
        if (flag === PermissionFlagsBits.SendMessages) return send === true;
        return false;
      },
    }),
    messages: { fetch: fetch ?? (async (id) => ({ id: String(id) })) },
  };
}

/**
 * ReferDeps fake. The automod channel and the source channel are separate
 * fakes so each side's permission leg can be broken alone.
 */
function makeDeps({
  automodChannel = fakeChannel(),
  sourceChannel = fakeChannel(),
  missing = [],
  botMember = { id: "u-bot-726" },
  referrerMember = { id: REFERRER },
} = {}) {
  return {
    getGuildChannel(_guildId, channelId) {
      if (missing.includes(String(channelId))) return null;
      if (String(channelId) === AMOD_CH) return automodChannel;
      if (String(channelId) === SRC_CH) return sourceChannel;
      return null;
    },
    getBotMember(_guildId) {
      return botMember;
    },
    getMember(_guildId, userId) {
      return String(userId) === REFERRER ? referrerMember : null;
    },
    async fetchMessage(_guildId, channelId, messageId) {
      const channel =
        String(channelId) === SRC_CH
          ? sourceChannel
          : String(channelId) === AMOD_CH
            ? automodChannel
            : null;
      if (!channel?.messages?.fetch) return null;
      return channel.messages.fetch(messageId);
    },
  };
}

const callRefer = (overrides = {}) =>
  refer.referToAutomod({
    guildId: GUILD,
    referrerUserId: REFERRER,
    messageLink: msgLink(),
    deps: makeDeps(),
    ...overrides,
  });

const rowsFor = (communityId) => db.listAutomodCases(communityId);
const staffNoteCount = () =>
  Number(db.db.prepare("SELECT COUNT(*) AS n FROM staff_notes").get().n);

// ── refusal battery ────────────────────────────────────────────────────────

describe("/automod refer — refusal battery (each gate alone, zero rows)", () => {
  it("master switch off → names the switch", async () => {
    const communityId = freshCommunity(); // enabled defaults to 0
    const res = await callRefer({ communityId });
    assert.equal(res.ok, false);
    assert.equal(res.error, refer.REFUSAL_SWITCH_OFF);
    assert.match(res.error, /\*\*Automod off:\*\*/);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("automod channel unset → names channel set", async () => {
    const communityId = freshCommunity();
    settingsService.setEnabled(communityId, true);
    settingsService.setRules(communityId, "Be kind.");
    const res = await callRefer({ communityId });
    assert.equal(res.error, refer.REFUSAL_CHANNEL_UNSET);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("automod channel deleted (uncached) → unpostable names the channel", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({ communityId, deps: makeDeps({ missing: [AMOD_CH] }) });
    assert.equal(res.error, refer.refusalChannelUnpostable(AMOD_CH));
    assert.ok(res.error.includes(`<#${AMOD_CH}>`));
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("bot lacks ViewChannel on the automod channel → unpostable", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({
      communityId,
      deps: makeDeps({ automodChannel: fakeChannel({ view: false }) }),
    });
    assert.equal(res.error, refer.refusalChannelUnpostable(AMOD_CH));
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("bot lacks SendMessages on the automod channel → unpostable", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({
      communityId,
      deps: makeDeps({ automodChannel: fakeChannel({ view: true, send: false }) }),
    });
    assert.match(res.error, /not postable/);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("rules never set → names rules set", async () => {
    const communityId = freshCommunity();
    settingsService.setEnabled(communityId, true);
    settingsService.setChannel(communityId, AMOD_CH);
    const res = await callRefer({ communityId });
    assert.equal(res.error, refer.REFUSAL_RULES_EMPTY);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("rules whitespace-only counts as empty", async () => {
    const communityId = readyCommunity();
    db.updateGuildSettings(communityId, { automod_rules: "   \n\t " });
    const res = await callRefer({ communityId });
    assert.equal(res.error, refer.REFUSAL_RULES_EMPTY);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("budget blocked (-1) → specific blocked cause", async () => {
    const communityId = readyCommunity();
    settingsService.setDailyBudget(communityId, -1);
    const res = await callRefer({ communityId });
    assert.equal(res.error, refer.REFUSAL_BUDGET_BLOCKED);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("budget exhausted → specific cause WITH the numbers", async () => {
    const communityId = readyCommunity();
    settingsService.setDailyBudget(communityId, 2);
    budgetRepo.consumeAutomodCase(communityId);
    budgetRepo.consumeAutomodCase(communityId);
    const res = await callRefer({ communityId });
    assert.equal(res.error, refer.refusalBudgetExhausted(2, 2));
    assert.ok(res.error.includes("2 of 2 cases used today"));
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("unlimited budget (0) keeps recording after heavy usage", async () => {
    const communityId = readyCommunity();
    settingsService.setDailyBudget(communityId, 0);
    budgetRepo.consumeAutomodCase(communityId);
    budgetRepo.consumeAutomodCase(communityId);
    const res = await callRefer({ communityId });
    assert.equal(res.ok, true, "limit 0 = unlimited — never an exhausted refusal");
  });

  it("neither message nor user → target required", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({ communityId, messageLink: null });
    assert.equal(res.error, refer.REFUSAL_TARGET_REQUIRED);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("note over the cap → error naming the length AND the cap", async () => {
    const communityId = readyCommunity();
    const over = "x".repeat(cases.AUTOMOD_REFER_NOTE_MAX_LEN + 1);
    const res = await callRefer({ communityId, note: over });
    assert.equal(
      res.error,
      refer.refusalNoteTooLong(over.length, cases.AUTOMOD_REFER_NOTE_MAX_LEN),
    );
    assert.ok(res.error.includes(`${over.length} characters`));
    assert.ok(res.error.includes("cap is 1000"));
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("a note at exactly the cap is accepted", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({
      communityId,
      note: "x".repeat(cases.AUTOMOD_REFER_NOTE_MAX_LEN),
    });
    assert.equal(res.ok, true);
    assert.equal(res.case.note.length, cases.AUTOMOD_REFER_NOTE_MAX_LEN);
  });
});

describe("/automod refer — message-link arms", () => {
  it("bare message ids and non-conforming links are refused (strict parse)", async () => {
    const communityId = readyCommunity();
    const bads = [
      MSG, // bare message id — explicitly NOT accepted
      `https://discord.com/messages/${MSG}`,
      `http://discord.com/channels/${GUILD}/${SRC_CH}/${MSG}`, // not https
      `https://canary.discord.com/channels/${GUILD}/${SRC_CH}/${MSG}`, // non-prod host
      `https://evil.example/channels/${GUILD}/${SRC_CH}/${MSG}`,
      `https://discord.com/channels/${GUILD}/${SRC_CH}/`, // no message id
      `https://discord.com/channels/${GUILD}/${SRC_CH}/${MSG}?x=1`, // trailing query
    ];
    for (const bad of bads) {
      const res = await callRefer({ communityId, messageLink: bad });
      assert.equal(res.ok, false, `must refuse: ${bad}`);
      assert.match(
        res.error,
        /\*\*Message link:\*\*/,
        `specific format cause for: ${bad}`,
      );
    }
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("the legacy discordapp.com host parses", async () => {
    const communityId = readyCommunity();
    const legacy = msgLink().replace("discord.com", "discordapp.com");
    const res = await callRefer({ communityId, messageLink: legacy });
    assert.equal(res.ok, true);
    assert.equal(res.case.message_id, MSG);
  });

  it("cross-guild link → specific cause naming the foreign guild", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({ communityId, messageLink: msgLink(OTHER_GUILD) });
    assert.equal(res.error, refer.refusalCrossGuild(OTHER_GUILD));
    assert.ok(res.error.includes(OTHER_GUILD));
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("source channel gone (uncached) → 'no longer exists'", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({
      communityId,
      deps: makeDeps({ missing: [SRC_CH] }),
    });
    assert.equal(res.error, refer.REFUSAL_MESSAGE_GONE);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("channel the REFERRER cannot view → specific invisible cause", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({
      communityId,
      deps: makeDeps({ sourceChannel: fakeChannel({ view: false }) }),
    });
    assert.equal(res.error, refer.refusalChannelInvisible(SRC_CH));
    assert.ok(res.error.includes(`<#${SRC_CH}>`));
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("unknown message (fetch → null) → 'no longer exists'", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({
      communityId,
      deps: makeDeps({ sourceChannel: fakeChannel({ fetch: async () => null }) }),
    });
    assert.equal(res.error, refer.REFUSAL_MESSAGE_GONE);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("unknown message (fetch throws Discord 10003) → 'no longer exists'", async () => {
    const communityId = readyCommunity();
    const err = Object.assign(new Error("Unknown Message"), { code: 10003 });
    const res = await callRefer({
      communityId,
      deps: makeDeps({ sourceChannel: fakeChannel({ fetch: async () => { throw err; } }) }),
    });
    assert.equal(res.error, refer.REFUSAL_MESSAGE_GONE);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("a NON-10003 fetch failure surfaces its cause, never a lie", async () => {
    const communityId = readyCommunity();
    const err = Object.assign(new Error("500 internal server error"), { code: 500 });
    const res = await callRefer({
      communityId,
      deps: makeDeps({ sourceChannel: fakeChannel({ fetch: async () => { throw err; } }) }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /Could not read that message/);
    assert.ok(res.error.includes("500 internal server error"));
    assert.equal(rowsFor(communityId).length, 0);
  });
});

// ── intake + ack ───────────────────────────────────────────────────────────

describe("/automod refer — intake shapes and the ack", () => {
  it("message-only referral stores the case and acks A-1 (exact copy)", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({ communityId });
    assert.equal(res.ok, true);
    assert.equal(res.caseRef, "A-1");
    assert.equal(res.automodChannelId, AMOD_CH);
    assert.equal(
      res.ack,
      `Case: **A-1** — recorded.\nRecommendations will post in <#${AMOD_CH}>.`,
    );
    assert.doesNotMatch(
      res.ack,
      /produced|generated|has been reviewed|was reviewed/i,
      "the ack never claims a recommendation was produced (#728 may not exist)",
    );

    const row = rowsFor(communityId)[0];
    assert.equal(rowsFor(communityId).length, 1);
    assert.equal(row.community_id, communityId);
    assert.equal(row.case_number, 1);
    assert.equal(row.referrer_user_id, REFERRER);
    assert.equal(row.message_id, MSG);
    assert.equal(row.channel_id, SRC_CH);
    assert.equal(row.target_user_id, null);
    assert.equal(row.note, null);
    assert.equal(row.status, "recorded");
    assert.ok(Number(row.created_at) > 0 && Number(row.updated_at) > 0);
  });

  it("user-only referral stores the named member, no message fields", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({ communityId, messageLink: null, targetUserId: "u-target-1" });
    assert.equal(res.ok, true);
    const row = rowsFor(communityId)[0];
    assert.equal(row.target_user_id, "u-target-1");
    assert.equal(row.message_id, null);
    assert.equal(row.channel_id, null);
    assert.equal(row.status, "recorded");
  });

  it("message AND user stores both plus the note (case input)", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({
      communityId,
      targetUserId: "u-target-2",
      note:  "  repeatedly slurred a member in #general  ",
    });
    assert.equal(res.ok, true);
    const row = rowsFor(communityId)[0];
    assert.equal(row.message_id, MSG);
    assert.equal(row.channel_id, SRC_CH);
    assert.equal(row.target_user_id, "u-target-2");
    assert.equal(row.note, "repeatedly slurred a member in #general", "note is trimmed");
  });

  it("the referrer's note is CASE INPUT: staff_notes stays empty", async () => {
    const communityId = readyCommunity();
    const before = staffNoteCount();
    await callRefer({ communityId, targetUserId: REFERRER, note: "self-review edge" });
    await callRefer({ communityId, note: "second case" });
    assert.equal(staffNoteCount(), before, "referral intake NEVER writes staff_notes");
    assert.equal(rowsFor(communityId).length, 2);
  });

  it("A-n increments per community; communities are independent", async () => {
    const a = readyCommunity();
    const b = readyCommunity();
    assert.equal((await callRefer({ communityId: a })).caseRef, "A-1");
    assert.equal((await callRefer({ communityId: a })).caseRef, "A-2");
    assert.equal((await callRefer({ communityId: b })).caseRef, "A-1");
    assert.equal((await callRefer({ communityId: a })).caseRef, "A-3");
    assert.deepEqual(
      rowsFor(a).map((r) => r.case_number).sort((x, y) => x - y),
      [1, 2, 3],
    );
    assert.deepEqual(rowsFor(b).map((r) => r.case_number), [1]);
  });

  it("the budget is READ, never consumed: used stays put after a referral", async () => {
    const communityId = readyCommunity();
    settingsService.setDailyBudget(communityId, 5);
    const before = budgetRepo.getAutomodBudget(communityId);
    const res = await callRefer({ communityId });
    assert.equal(res.ok, true);
    const after = budgetRepo.getAutomodBudget(communityId);
    assert.equal(after.used, before.used, "#728 consumes on provider acceptance — not intake");
    assert.equal(after.remaining, before.remaining);
  });

  it("breaker-PAUSED guild still accepts referrals (contract-explicit)", async () => {
    const communityId = readyCommunity();
    budgetRepo.setAutomodPause(communityId, { reason: "auto-ban burst (6 in 10m)" });
    assert.equal(budgetRepo.isAutomodPaused(communityId).paused, true);
    const res = await callRefer({ communityId });
    assert.equal(res.ok, true, "a breaker pause is NEVER a referral refusal");
    assert.equal(rowsFor(communityId).length, 1);
  });

  it("service failures stay { ok:false } — never a throw", async () => {
    const communityId = readyCommunity();
    const res = await callRefer({ communityId, deps: null });
    assert.equal(res.ok, false);
    assert.match(res.error, /Internal referral error/);
  });
});

// ── context-menu arm ───────────────────────────────────────────────────────

/**
 * MessageContextMenuCommandInteraction mock (local — the shared helpers
 * factory owns chat/modal shapes only). `resolved` records every option name
 * the handler resolves so the pin "message" (discord.js' own targetMessage
 * getter, verified in node_modules) stays enforced.
 */
function makeMenuInteraction({
  commandName = "Refer to automod",
  guildId,
  admin = true,
  staffRoleIds = [],
  target = { id: MSG, channelId: SRC_CH, author: { id: "u-offender", bot: false }, type: 0 },
  channelState = { [AMOD_CH]: { view: true, send: true }, [SRC_CH]: { view: true } },
} = {}) {
  const replies = [];
  const resolved = [];
  const botMember = { id: "u-bot-726" };
  const channelFor = (id) => {
    const state = channelState[id];
    if (!state) return null;
    return {
      id,
      permissionsFor: () => ({
        has: (flag) => {
          if (flag === PermissionFlagsBits.ViewChannel) return state.view !== false;
          if (flag === PermissionFlagsBits.SendMessages) return state.send !== false;
          return false;
        },
      }),
      messages: { fetch: async (mid) => ({ id: String(mid) }) },
    };
  };
  const interaction = {
    commandName,
    guildId,
    guild: {
      id: guildId,
      channels: { cache: { get: (id) => channelFor(id) } },
      members: { me: botMember, cache: { get: () => null } },
    },
    user: { id: REFERRER },
    member: {
      id: REFERRER,
      roles: { cache: new Map(staffRoleIds.map((r) => [r, {}])) },
    },
    memberPermissions: {
      has: (flag) => admin && String(flag) === String(PermissionFlagsBits.ManageGuild),
    },
    isMessageContextMenuCommand: () => true,
    isUserContextMenuCommand: () => false,
    resolved,
    replies,
    options: {
      getMessage: (name) => {
        resolved.push(name);
        return target;
      },
    },
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    // #771: the invoke OPENS THE REFERRAL MODAL — the arm calls
    // interaction.showModal(builder); the fake records the payload so the
    // test can submit it like Discord would.
    showModal: async (modal) => {
      interaction.shownModal = typeof modal?.toJSON === "function" ? modal.toJSON() : modal;
    },
  };
  return interaction;
}

/**
 * #771 intake flow driver: invoke the menu, then submit the modal it opened
 * with the given field values (Problem etc.). Returns the SUBMIT fake whose
 * `replies` carry the ack/refusal; a pre-modal refusal carries its reply on
 * the invoke interaction instead (shownModal stays unset).
 */
async function menuFlow(interaction, fields = {}) {
  await automod.handlers["Refer to automod"](interaction, {});
  if (!interaction.shownModal) return interaction;
  const referModal = require("../src/features/automod/referModal");
  const submit = makeModalSubmit(interaction, fields);
  await referModal.handleReferModal(submit, {});
  return submit;
}

/** ModalSubmit fake re-using the opener's guild/member/staff legs. */
function makeModalSubmit(open, fields = {}) {
  const merged = { problem: "posted slurs", ...fields };
  const replies = [];
  return {
    isModalSubmit: () => true,
    customId: open.shownModal.custom_id,
    guildId: open.guildId,
    guild: open.guild,
    user: open.user,
    member: open.member,
    memberPermissions: open.memberPermissions,
    fields: {
      getTextInputValue: (id) => {
        if (id in merged) return merged[id] ?? "";
        throw new Error(`unknown modal field: ${id}`);
      },
    },
    replies,
    reply: async (payload) => {
      replies.push(typeof payload === "string" ? { content: payload } : payload);
      return payload;
    },
  };
}

/** Fresh guild + configured community for one menu test (independent A-n). */
function readyMenuGuild(label) {
  const guildId = `931${String(++seq).padStart(15, "0")}`;
  const communityId = communityKey(guildId);
  settingsService.setEnabled(communityId, true);
  settingsService.setChannel(communityId, AMOD_CH);
  settingsService.setRules(communityId, "No hate speech.");
  return { guildId, communityId };
}

const menuContent = (interaction) => String(interaction.replies[0]?.content ?? "");

describe('"Refer to automod" context menu (#726 intake — #771: modal first)', () => {
  it("resolves the target through options.getMessage('message') — literal pin", async () => {
    const { guildId } = readyMenuGuild("menu-resolve");
    const interaction = makeMenuInteraction({ guildId });
    await automod.handlers["Refer to automod"](interaction, {});
    assert.deepEqual(interaction.resolved, ["message"]);
    assert.match(interaction.shownModal.custom_id, /^am:refer:[0-9a-f]{32}$/);
  });

  it("invoke OPENS THE REFERRAL MODAL (#771: problem + context + window)", async () => {
    const { guildId, communityId } = readyMenuGuild("menu-modal");
    const interaction = makeMenuInteraction({ guildId });
    await automod.handlers["Refer to automod"](interaction, {});
    assert.equal(rowsFor(communityId).length, 0, "the invoke alone files NOTHING");
    const labels = interaction.shownModal.components.map((r) => r.components[0].label);
    assert.deepEqual(labels, [
      "Problem — what is wrong?",
      "Required context (optional)",
      "Messages before (optional)",
      "Messages after (optional)",
    ]);
    assert.equal(
      interaction.shownModal.components[0].components[0].required,
      true,
      "Problem is the required field",
    );
  });

  it("happy path: A-1 row (problem + window on the row), ack copy, automod.refer audit", async () => {
    const { guildId, communityId } = readyMenuGuild("menu-happy");
    const interaction = makeMenuInteraction({ guildId });
    const submit = await menuFlow(interaction, {
      problem: "repeated slurs at a member",
      required_context: "check the thread above it",
      read_before: "250",
      read_after: "50",
    });

    assert.equal(
      String(submit.replies[0]?.content ?? ""),
      `Case: **A-1** — recorded.\nRecommendations will post in <#${AMOD_CH}>.`,
    );

    const row = rowsFor(communityId)[0];
    assert.equal(row.message_id, MSG);
    assert.equal(row.channel_id, SRC_CH);
    assert.equal(row.target_user_id, null);
    assert.equal(row.note, "repeated slurs at a member", "the modal's problem is the case note");
    assert.equal(row.required_context, "check the thread above it");
    assert.equal(row.read_before, 250);
    assert.equal(row.read_after, 50);
    assert.equal(row.referrer_user_id, REFERRER);

    const audit = db
      .listAdminAudit(communityId, { limit: 10 })
      .find((r) => r.action === "automod.refer");
    assert.ok(audit, "a recorded case is audited like the tickets report arms");
    const details = JSON.parse(audit.details_json);
    assert.equal(details.case_number, 1);
    assert.equal(details.message_id, MSG);
    assert.equal(details.channel_id, SRC_CH);
    assert.equal(details.target_user_id, null);
  });

  it("empty modal fields file a case with the window DEFAULTS (100/20)", async () => {
    const { guildId, communityId } = readyMenuGuild("menu-defaults");
    const interaction = makeMenuInteraction({ guildId });
    const submit = await menuFlow(interaction, { problem: "harassment", required_context: "" });
    assert.match(String(submit.replies[0]?.content ?? ""), /A-1/);
    const row = rowsFor(communityId)[0];
    assert.equal(row.read_before, 100);
    assert.equal(row.read_after, 20);
  });

  it("staff-role leg (no ManageGuild) is accepted by the staff gate", async () => {
    const { guildId, communityId } = readyMenuGuild("menu-staffrole");
    db.addStaffRole(communityId, "role-726-junior", "junior", "u-admin-726");
    const interaction = makeMenuInteraction({
      guildId,
      admin: false,
      staffRoleIds: ["role-726-junior"],
    });
    const submit = await menuFlow(interaction);
    assert.match(String(submit.replies[0]?.content ?? ""), /Case: \*\*A-1\*\* — recorded\./);
    assert.equal(rowsFor(communityId).length, 1);
  });

  it("non-staff invoke: standard denial, ZERO rows, resolver never read", async () => {
    const { guildId, communityId } = readyMenuGuild("menu-deny");
    const interaction = makeMenuInteraction({ guildId, admin: false });
    await automod.handlers["Refer to automod"](interaction, {});
    assert.equal(menuContent(interaction), MSG_DENIED);
    assert.equal(rowsFor(communityId).length, 0);
    assert.deepEqual(interaction.resolved, [], "the staff gate runs BEFORE the target read");
  });

  it("bot-authored target is refused before the modal even opens", async () => {
    const { guildId, communityId } = readyMenuGuild("menu-bot");
    const interaction = makeMenuInteraction({
      guildId,
      target: { id: MSG, channelId: SRC_CH, author: { id: "u-bot", bot: true }, type: 0 },
    });
    await automod.handlers["Refer to automod"](interaction, {});
    assert.equal(menuContent(interaction), refer.REFUSAL_BOT_TARGET);
    assert.equal(interaction.shownModal, undefined, "no form for a bot message");
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("system-type target is refused too", async () => {
    const { guildId, communityId } = readyMenuGuild("menu-system");
    const interaction = makeMenuInteraction({
      guildId,
      target: { id: MSG, channelId: SRC_CH, author: { id: "u-x", bot: false }, type: 19 },
    });
    await automod.handlers["Refer to automod"](interaction, {});
    assert.equal(menuContent(interaction), refer.REFUSAL_BOT_TARGET);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("unresolvable target → specific nothing-was-recorded reply", async () => {
    const { guildId, communityId } = readyMenuGuild("menu-gone");
    const interaction = makeMenuInteraction({ guildId, target: null });
    await automod.handlers["Refer to automod"](interaction, {});
    assert.equal(menuContent(interaction), refer.REFUSAL_TARGET_UNRESOLVED);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("config gates apply AT SUBMIT (#771): switch off → its cause", async () => {
    const guildId = `932${String(++seq).padStart(15, "0")}`;
    const communityId = communityKey(guildId);
    settingsService.setChannel(communityId, AMOD_CH);
    settingsService.setRules(communityId, "Kindness.");
    // enabled stays 0.
    const interaction = makeMenuInteraction({ guildId });
    const submit = await menuFlow(interaction);
    assert.equal(String(submit.replies[0]?.content ?? ""), refer.REFUSAL_SWITCH_OFF);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("menu on a guild whose automod channel went unpostable → that cause", async () => {
    const { guildId, communityId } = readyMenuGuild("menu-unpostable");
    const interaction = makeMenuInteraction({
      guildId,
      channelState: { [AMOD_CH]: { view: true, send: false }, [SRC_CH]: { view: true } },
    });
    const submit = await menuFlow(interaction);
    assert.equal(
      String(submit.replies[0]?.content ?? ""),
      refer.refusalChannelUnpostable(AMOD_CH),
    );
    assert.equal(rowsFor(communityId).length, 0);
  });
});

// ── repository surface (#727/#728 read these accessors) ────────────────────

describe("automod_cases repository", () => {
  it("createAutomodCase refuses a missing referrer and an over-cap note", () => {
    const communityId = freshCommunity();
    assert.equal(cases.createAutomodCase({ communityId }).ok, false);
    const res = cases.createAutomodCase({
      communityId,
      referrerUserId: "u-x",
      note: "y".repeat(cases.AUTOMOD_REFER_NOTE_MAX_LEN + 1),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /cap is 1000/);
    assert.equal(rowsFor(communityId).length, 0);
  });

  it("getAutomodCase / getAutomodCaseById look up the A-n row", () => {
    const communityId = freshCommunity();
    const created = cases.createAutomodCase({
      communityId,
      referrerUserId: "u-x",
      targetUserId: "u-subject",
    });
    assert.equal(created.ok, true);
    assert.equal(cases.getAutomodCase(communityId, 1).id, created.case.id);
    assert.equal(cases.getAutomodCaseById(created.case.id).case_number, 1);
    assert.equal(cases.getAutomodCase(communityId, 99), null);
    assert.equal(cases.getAutomodCaseById("junk"), null);
  });

  it("setAutomodCaseStatus moves recorded→processing→complete (068 vocabulary)", () => {
    const communityId = freshCommunity();
    const { case: row } = cases.createAutomodCase({ communityId, referrerUserId: "u-x" });
    assert.deepEqual([...cases.AUTOMOD_CASE_STATUSES], [
      "recorded",
      "processing",
      "complete",
      "failed",
    ]);
    assert.equal(cases.setAutomodCaseStatus(communityId, row.case_number, "processing").ok, true);
    assert.equal(
      cases.setAutomodCaseStatus(communityId, row.case_number, "nonsense").ok,
      false,
      "unknown status refused (CHECK vocabulary)",
    );
    assert.equal(
      cases.setAutomodCaseStatus(communityId, 4242, "complete").ok,
      false,
      "missing case named",
    );
    assert.equal(
      cases.setAutomodCaseStatus(communityId, row.case_number, "complete").ok,
      true,
    );
    assert.equal(cases.getAutomodCase(communityId, row.case_number).status, "complete");
    assert.equal(
      cases.listAutomodCases(communityId, { status: "complete" }).length,
      1,
      "status filter finds the moved row",
    );
  });

  it("listAutomodCases filters by status and is newest-first", () => {
    const communityId = freshCommunity();
    cases.createAutomodCase({ communityId, referrerUserId: "u-a" });
    cases.createAutomodCase({ communityId, referrerUserId: "u-b" });
    cases.setAutomodCaseStatus(communityId, 1, "complete");
    const all = db.listAutomodCases(communityId);
    assert.equal(all.length, 2);
    assert.ok(
      db.listAutomodCases(communityId, { status: "complete" }).every((r) => r.status === "complete"),
    );
    assert.deepEqual(
      db.listAutomodCases(communityId).map((r) => r.referrer_user_id),
      ["u-b", "u-a"],
      "newest first",
    );
    assert.deepEqual(db.listAutomodCases(communityId, { status: "bogus" }), []);
  });
});

// ── parser seam ────────────────────────────────────────────────────────────

describe("parseMessageLink (strict grammar)", () => {
  it("accepts the two production hosts, rejects everything else", () => {
    assert.deepEqual(refer.parseMessageLink(msgLink()), {
      guildId: GUILD,
      channelId: SRC_CH,
      messageId: MSG,
    });
    assert.ok(
      refer.parseMessageLink(
        `https://discordapp.com/channels/${GUILD}/${SRC_CH}/${MSG}`,
      ),
      "legacy host is part of the grammar",
    );
    assert.equal(refer.parseMessageLink(MSG), null);
    assert.equal(refer.parseMessageLink(""), null);
    assert.equal(refer.parseMessageLink(null), null);
    assert.equal(
      refer.parseMessageLink(`https://discord.com/channels/${GUILD}/${SRC_CH}`),
      null,
    );
  });
});
