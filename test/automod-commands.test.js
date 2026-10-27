/**
 * #725 (epic #723): /automod + /automodconfig command-layer unit tests,
 * extended for #726's /automod refer slash intake wiring.
 *
 * Hand-built CommandContext (the fluxer-honeypot / staffNotes unit pattern) —
 * no gateway, no network. Covers: gates (staff read / admin mutations), the
 * status render (incl. budget sentinels + breaker reason), the rules-modal
 * flow (slash → modal → submit), the H2-15 confirm: idiom on
 * `safety resume`, the @everyone-view warning on `channel set` (read
 * only — the command must never rewrite overwrites), and the /automod refer
 * wiring (gates first, cross-option enforcement, ack + row + audit).
 * The refusal battery itself lives in test/automod-refer.test.js.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");
const automod = require("../src/features/automod");
const service = require("../src/features/automod/settings");
const repo = require("../src/db/repositories/automodSettings");
const { MSG_DENIED } = require("../src/core/theme");

after(() => cleanup());

const MANAGE_GUILD = String(PermissionFlagsBits.ManageGuild);
const EXTERNAL_GUILD = "925000000000000000";

let seq = 0;
const freshCommunity = () => communityKey(`${EXTERNAL_GUILD}-725c-${++seq}`);

/**
 * Minimal @everyone-ViewChannel channel fake (only what everyoneCanView reads).
 * @param {boolean} viewable
 */
function fakeChannel(viewable) {
  return {
    permissionsFor: () => ({
      has: (flag) => flag === PermissionsBitField.Flags.ViewChannel && viewable,
    }),
  };
}

/**
 * Raw Discord interaction stub: guild cache + channels cache + showModal spy.
 */
function makeRaw({ channelViews = {}, showModal } = {}) {
  const modals = [];
  return {
    modals,
    raw: {
      guild: {
        id: EXTERNAL_GUILD,
        roles: { everyone: { id: EXTERNAL_GUILD } },
        channels: {
          cache: {
            get: (id) =>
              channelViews[id] === undefined
                ? null
                : fakeChannel(channelViews[id]),
          },
        },
      },
      showModal: async (modal) => {
        modals.push(modal);
        if (showModal) await showModal(modal);
      },
    },
  };
}

/**
 * Hand-built CommandContext (mirrors the fluxer-honeypot-banrole fake).
 * @param {object} o
 */
function makeCtx({
  commandName = "automodconfig",
  communityId,
  group = null,
  sub = null,
  options = {},
  manageGuild = true,
  memberRoleIds = [],
  raw = null,
  noRaw = false,
}) {
  const replies = [];
  const ctx = {
    platform: "discord",
    instanceKey: "discord",
    communityId,
    externalGuildId: EXTERNAL_GUILD,
    channelId: "10",
    userId: "u-admin-725",
    user: { id: "u-admin-725", username: "admin" },
    commandName,
    subcommandGroup: group,
    subcommand: sub,
    options: {
      getString: (name) => (options[name] ?? null),
      getInteger: (name) => (options[name] ?? null),
      getBoolean: (name) => (options[name] ?? null),
      getChannel: (name) => (options[name] ?? null),
      // #726: /automod refer resolves the user option (the adapter hands
      // handlers a normalized { id, ... } — tests pass that shape).
      getUser: (name) => (options[name] ?? null),
    },
    channelPermissions: manageGuild ? MANAGE_GUILD : "0",
    memberRoleIds,
    guildOwner: false,
    deferred: false,
    replied: false,
    outbound: null,
    // noRaw:true models a Fluxer context — the adapter omits rawInteraction
    // entirely (never a null placeholder; the gate reads presence).
    rawInteraction: noRaw ? undefined : (raw ?? makeRaw().raw),
    reply: async (payload) => {
      replies.push(payload);
    },
    editReply: async (payload) => {
      replies.push(payload);
    },
    defer: async () => {},
  };
  return { ctx, replies };
}

const content = (replies, i = 0) => String(replies[i]?.content ?? "");

describe("/automod status — staff read surface", () => {
  it("denies non-staff with the standard denial (picker tier is staff)", async () => {
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId: freshCommunity(),
      sub: "status",
      manageGuild: false,
    });
    await automod.handlers.automod(ctx, {});
    assert.equal(replies.length, 1);
    assert.equal(content(replies), MSG_DENIED);
  });

  it("renders the epic defaults: off, suggest everywhere, budget 50, breaker active", async () => {
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId: freshCommunity(),
      sub: "status",
    });
    await automod.handlers.automod(ctx, {});
    const c = content(replies);
    assert.match(c, /\*\*Enabled:\*\* \*\*off\*\*/);
    assert.match(c, /\*\*Channel:\*\* _not set_/);
    assert.match(c, /\*\*Rules:\*\* _not set_/);
    for (const action of repo.AUTOMOD_ACTIONS) {
      assert.ok(c.includes(`\`${action}\`: **suggest**`), `mode line for ${action}`);
    }
    assert.match(c, /\*\*Staff notes:\*\* always on/);
    assert.match(c, /\*\*Timeout cap:\*\* 3600 s \(1 h\)/);
    assert.match(c, /\*\*Daily budget:\*\* \*\*50\*\* of 50 left today/);
    assert.match(c, /\*\*Safety:\*\* active/);
    assert.equal(replies[0].sensitive, true, "status stays ephemeral");
  });

  it("shows real config: channel, rules chars, budget usage, paused breaker + reason", async () => {
    const communityId = freshCommunity();
    service.setEnabled(communityId, true);
    service.setChannel(communityId, "700000000000000001");
    service.setRules(communityId, "No spam. No hate speech. Be kind.");
    service.setMode(communityId, "delete_message", "auto");
    service.setDailyBudget(communityId, 50);
    repo.consumeAutomodCase(communityId);
    repo.setAutomodPause(communityId, { reason: "auto-ban burst (6 in 10m)" });

    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "status",
    });
    await automod.handlers.automod(ctx, {});
    const c = content(replies);
    assert.match(c, /\*\*Enabled:\*\* \*\*yes\*\*/);
    assert.match(c, /<#700000000000000001>/);
    assert.match(c, /\*\*33\*\* chars/);
    assert.ok(c.includes("`delete_message`: **auto**"));
    assert.match(c, /\*\*49\*\* of 50 left today/);
    assert.match(c, /\*\*paused\*\*/);
    assert.match(c, /reason: `auto-ban burst \(6 in 10m\)`/);
  });

  it("budget sentinels: 0 renders unlimited, -1 renders blocked", async () => {
    const unlimited = freshCommunity();
    service.setDailyBudget(unlimited, 0);
    const a = makeCtx({ commandName: "automod", communityId: unlimited, sub: "status" });
    await automod.handlers.automod(a.ctx, {});
    assert.match(content(a.replies), /\*\*Daily budget:\*\* \*\*unlimited\*\* \(0\)/);

    const blocked = freshCommunity();
    service.setDailyBudget(blocked, -1);
    const b = makeCtx({ commandName: "automod", communityId: blocked, sub: "status" });
    await automod.handlers.automod(b.ctx, {});
    assert.match(content(b.replies), /\*\*Daily budget:\*\* \*\*blocked\*\* \(`-1`\)/);
  });

  it("Fluxer contexts get the documented NOT_ON_FLUXER refusal (decision 8)", async () => {
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId: freshCommunity(),
      sub: "status",
      noRaw: true,
    });
    await automod.handlers.automod(ctx, {});
    assert.equal(content(replies), "That command is not available on Fluxer yet.");
  });
});

describe("/automodconfig — gates + mutations", () => {
  it("staff roles do NOT reach the config surface (admin tier, handler gate)", async () => {
    const communityId = freshCommunity();
    db.addStaffRole(communityId, "role-staff-725", "junior", "u-admin-725");
    const { ctx, replies } = makeCtx({
      communityId,
      group: null,
      sub: "enable",
      options: { state: "on" },
      manageGuild: false,
      memberRoleIds: ["role-staff-725"],
    });
    await automod.handlers.automodconfig(ctx, {});
    assert.equal(content(replies), MSG_DENIED);
    assert.equal(Number(db.getGuildSettings(communityId).automod_enabled), 0);
  });

  it("channel set persists, audits, and WARNS when @everyone can view (read-only)", async () => {
    const communityId = freshCommunity();
    const { modals, raw } = makeRaw({
      channelViews: { "700000000000000002": true },
    });
    void modals;
    const { ctx, replies } = makeCtx({
      communityId,
      group: "channel",
      sub: "set",
      options: { channel: { id: "700000000000000002", type: 0 } },
      raw,
    });
    await automod.handlers.automodconfig(ctx, {});
    const c = content(replies);
    assert.match(c, /\*\*Automod channel set:\*\* <#700000000000000002>/);
    assert.match(c, /\*\*Warning:\*\* `@everyone` can currently view/);
    assert.match(c, /never\s+rewrites channel overwrites/);
    assert.equal(db.getGuildSettings(communityId).automod_channel_id, "700000000000000002");
    const audit = db
      .listAdminAudit(communityId, { limit: 10 })
      .find((r) => r.action === "automod.channel_set");
    assert.ok(audit, "every mutation records an automod.* audit row");
  });

  it("channel set on a staff-only channel carries NO warning", async () => {
    const { raw } = makeRaw({ channelViews: { "700000000000000003": false } });
    const { ctx, replies } = makeCtx({
      communityId: freshCommunity(),
      group: "channel",
      sub: "set",
      options: { channel: { id: "700000000000000003", type: 0 } },
      raw,
    });
    await automod.handlers.automodconfig(ctx, {});
    assert.doesNotMatch(content(replies), /Warning/);
    assert.match(content(replies), /Automod channel set/);
  });

  it("rules set inline persists; over-cap refuses with the count", async () => {
    const communityId = freshCommunity();
    const ok = makeCtx({
      communityId,
      group: "rules",
      sub: "set",
      options: { text: "No ads." },
    });
    await automod.handlers.automodconfig(ok.ctx, {});
    assert.match(content(ok.replies), /\*\*Automod rules set\*\* \(\*\*7\*\* of 4000 chars\)/);
    assert.equal(db.getGuildSettings(communityId).automod_rules, "No ads.");

    const bad = makeCtx({
      communityId,
      group: "rules",
      sub: "set",
      options: { text: "x".repeat(4001) },
    });
    await automod.handlers.automodconfig(bad.ctx, {});
    assert.match(content(bad.replies), /4001 characters/);
  });

  it("rules set WITHOUT text opens the modal (prefilled with the current text)", async () => {
    const communityId = freshCommunity();
    service.setRules(communityId, "Old rules");
    const { modals, raw } = makeRaw();
    const { ctx, replies } = makeCtx({
      communityId,
      group: "rules",
      sub: "set",
      options: {},
      raw,
    });
    await automod.handlers.automodconfig(ctx, {});
    assert.equal(modals.length, 1, "omitting the string shows the modal, not a save");
    assert.equal(replies.length, 0);
    const json = modals[0].toJSON();
    assert.equal(json.custom_id, "am:rules");
    assert.equal(
      json.components[0].components[0].value,
      "Old rules",
      "modal prefills the existing rules (edit-in-place)",
    );
  });

  it("rules modal submit persists (admin-gated on the raw interaction too)", async () => {
    const communityId = freshCommunity();
    // ensureCommunity maps the interaction's snowflake to the same integer.
    const replies = [];
    const interaction = {
      customId: "am:rules",
      guildId: EXTERNAL_GUILD,
      user: { id: "u-admin-725" },
      client: {},
      memberPermissions: { has: (flag) => flag === PermissionFlagsBits.ManageGuild },
      fields: { getTextInputValue: (id) => (id === "rules" ? "Kindness first." : "") },
      reply: async (payload) => {
        replies.push(payload);
      },
    };
    void communityId;
    await automod.modalHandlers["am:rules"](interaction, { client: interaction.client });
    assert.match(String(replies[0]?.content), /\*\*Automod rules set\*\*/);
    assert.equal(
      db.getGuildSettings(communityKey(EXTERNAL_GUILD)).automod_rules,
      "Kindness first.",
    );

    // Non-admin submitter is refused and nothing saves.
    const denied = {
      ...interaction,
      memberPermissions: { has: () => false },
      fields: { getTextInputValue: () => "should not save" },
      reply: async () => {},
    };
    await automod.modalHandlers["am:rules"](denied, { client: interaction.client });
    assert.equal(
      db.getGuildSettings(communityKey(EXTERNAL_GUILD)).automod_rules,
      "Kindness first.",
      "denied submit changes nothing",
    );
  });

  it("enable on/off replies name the missing pieces while enabled", async () => {
    const communityId = freshCommunity();
    const on = makeCtx({ communityId, sub: "enable", options: { state: "on" } });
    await automod.handlers.automodconfig(on.ctx, {});
    assert.match(content(on.replies), /\*\*Automod enabled:\*\* \*\*yes\*\*/);
    assert.match(content(on.replies), /modes stay \*\*suggest\*\*/);
    assert.match(content(on.replies), /\*\*Missing for cases:\*\* channel .* rules/);
    assert.equal(Number(db.getGuildSettings(communityId).automod_enabled), 1);

    const off = makeCtx({ communityId, sub: "enable", options: { state: "off" } });
    await automod.handlers.automodconfig(off.ctx, {});
    assert.match(content(off.replies), /\*\*Automod enabled:\*\* \*\*off\*\*/);
    assert.equal(Number(db.getGuildSettings(communityId).automod_enabled), 0);
  });

  it("mode set persists and states the consequence; auto kick/ban warns about no approve click", async () => {
    const communityId = freshCommunity();
    const m = makeCtx({
      communityId,
      sub: "mode",
      options: { action: "ban", mode: "auto" },
    });
    await automod.handlers.automodconfig(m.ctx, {});
    assert.equal(db.getGuildSettings(communityId).automod_mode_ban, "auto");
    assert.match(content(m.replies), /WITHOUT a staff approve click/);

    const bad = makeCtx({
      communityId,
      sub: "mode",
      options: { action: "notes", mode: "auto" },
    });
    await automod.handlers.automodconfig(bad.ctx, {});
    assert.match(content(bad.replies), /Unknown action `notes`/);
    assert.match(content(bad.replies), /Staff notes are always on/);
  });

  it("timeout-cap + budget echo the persisted values and their sentinels", async () => {
    const communityId = freshCommunity();
    const cap = makeCtx({ communityId, sub: "timeout-cap", options: { seconds: 7200 } });
    await automod.handlers.automodconfig(cap.ctx, {});
    assert.match(content(cap.replies), /\*\*Automod timeout cap set:\*\* \*\*7200\*\* seconds/);
    assert.equal(db.getGuildSettings(communityId).automod_timeout_cap, 7200);

    // Out-of-range (belt: the picker clamps, the handler still refuses).
    const bad = makeCtx({ communityId, sub: "timeout-cap", options: { seconds: 30 } });
    await automod.handlers.automodconfig(bad.ctx, {});
    assert.match(content(bad.replies), /got `30`/);

    const blocked = makeCtx({ communityId, sub: "budget", options: { limit: -1 } });
    await automod.handlers.automodconfig(blocked.ctx, {});
    assert.match(content(blocked.replies), /\*\*blocked\*\* \(`-1`\)/);
    assert.match(content(blocked.replies), /Separate from Gork's budget/);
  });
});

describe("/automodconfig safety resume — H2-15 confirm: idiom", () => {
  it("not paused → refuses specifically, no mutation", async () => {
    const { ctx, replies } = makeCtx({ communityId: freshCommunity(), group: "safety", sub: "resume" });
    await automod.handlers.automodconfig(ctx, {});
    assert.match(content(replies), /not paused — nothing to resume/);
  });

  it("without confirm: previews exactly what re-arms and leaves the pause in place", async () => {
    const communityId = freshCommunity();
    service.setMode(communityId, "kick", "auto");
    service.setMode(communityId, "timeout", "auto");
    service.setMode(communityId, "warn", "suggest");
    repo.setAutomodPause(communityId, { reason: "3 bans in 5 minutes" });

    const { ctx, replies } = makeCtx({
      communityId,
      group: "safety",
      sub: "resume",
      options: {},
    });
    await automod.handlers.automodconfig(ctx, {});
    const c = content(replies);
    assert.match(c, /reason: `3 bans in 5 minutes`/);
    assert.ok(c.includes("`kick`") && c.includes("`timeout`"), "lists the auto actions");
    assert.ok(!c.includes("`warn`"), "suggest-mode actions are not re-armed");
    assert.match(c, /kick and ban are irreversible/);
    assert.match(c, /Re-run with `confirm: true`/);
    assert.equal(repo.isAutomodPaused(communityId).paused, true, "preview mutates nothing");
  });

  it("confirm:true clears BOTH pause fields, audits, and echoes the re-armed list", async () => {
    const communityId = freshCommunity();
    service.setMode(communityId, "ban", "auto");
    repo.setAutomodPause(communityId, { reason: "ban burst" });

    const { ctx, replies } = makeCtx({
      communityId,
      group: "safety",
      sub: "resume",
      options: { confirm: true },
    });
    await automod.handlers.automodconfig(ctx, {});
    assert.match(content(replies), /\*\*Automod safety resumed\*\*/);
    assert.ok(content(replies).includes("`ban`"));
    const state = repo.isAutomodPaused(communityId);
    assert.equal(state.paused, false);
    assert.equal(state.reason, null, "resume clears the reason too");
    const audit = db
      .listAdminAudit(communityId, { limit: 10 })
      .find((r) => r.action === "automod.safety_resume");
    assert.ok(audit, "resume is audited with what was armed");
    assert.deepEqual(JSON.parse(audit.details_json).re_armed, ["ban"]);
  });
});

// ── #726: /automod refer (slash intake wiring) ─────────────────────────────

const REFER_AMOD_CH = "700000000000000011";
const REFER_SRC_CH = "700000000000000012";
const REFER_MSG = "800000000000000012";
const referLink = (guildId = EXTERNAL_GUILD) =>
  `https://discord.com/channels/${guildId}/${REFER_SRC_CH}/${REFER_MSG}`;

/**
 * Raw-interaction fake rich enough for the referral deps seam: guild channel
 * cache (automod + source channels with permission reads + messages.fetch),
 * guild.members.me, and the invoker member.
 */
function makeReferRaw({ automodSend = true, sourceView = true } = {}) {
  const chan = (view, send) => ({
    permissionsFor: () => ({
      has: (flag) => {
        if (flag === PermissionsBitField.Flags.ViewChannel) return view === true;
        if (flag === PermissionsBitField.Flags.SendMessages) return send === true;
        return false;
      },
    }),
    messages: { fetch: async (id) => ({ id: String(id) }) },
  });
  return {
    user: { id: "u-admin-725" },
    member: { id: "u-admin-725" },
    guild: {
      id: EXTERNAL_GUILD,
      roles: { everyone: { id: EXTERNAL_GUILD } },
      members: { me: { id: "u-bot-725" }, cache: { get: () => null } },
      channels: {
        cache: {
          get: (id) => {
            if (id === REFER_AMOD_CH) return chan(true, automodSend);
            if (id === REFER_SRC_CH) return chan(sourceView, false);
            return null;
          },
        },
      },
    },
  };
}

/** Configure a community for referral intake through the shipped services. */
function readyReferCommunity({ channelId = REFER_AMOD_CH } = {}) {
  const communityId = freshCommunity();
  service.setEnabled(communityId, true);
  service.setChannel(communityId, channelId);
  service.setRules(communityId, "No spam. Be kind.");
  return communityId;
}

describe("/automod refer — slash intake wiring (#726)", () => {
  it("denies non-staff with the standard denial and records NOTHING", async () => {
    const communityId = readyReferCommunity();
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: { message: referLink() },
      manageGuild: false,
      raw: makeReferRaw(),
    });
    await automod.handlers.automod(ctx, {});
    assert.equal(content(replies), MSG_DENIED);
    assert.equal(db.listAutomodCases(communityId).length, 0);
  });

  it("Fluxer contexts get the NOT_ON_FLUXER refusal before anything else (decision 8)", async () => {
    const communityId = readyReferCommunity();
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: { message: referLink() },
      noRaw: true,
    });
    await automod.handlers.automod(ctx, {});
    assert.equal(content(replies), "That command is not available on Fluxer yet.");
    assert.equal(db.listAutomodCases(communityId).length, 0);
  });

  it("no message AND no user → the specific target-required reply", async () => {
    const communityId = readyReferCommunity();
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: {},
      raw: makeReferRaw(),
    });
    await automod.handlers.automod(ctx, {});
    assert.match(content(replies), /\*\*Target required:\*\*/);
    assert.equal(db.listAutomodCases(communityId).length, 0);
  });

  it("staff-role leg (no ManageGuild) files the case: ack, row, automod.refer audit", async () => {
    const communityId = readyReferCommunity();
    db.addStaffRole(communityId, "role-726-junior", "junior", "u-admin-725");
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: {
        message: referLink(),
        user: { id: "u-target-726" },
        note: "targeted harassment in #general",
      },
      manageGuild: false,
      memberRoleIds: ["role-726-junior"],
      raw: makeReferRaw(),
    });
    await automod.handlers.automod(ctx, {});

    assert.equal(
      content(replies),
      `Case: **A-1** — recorded.\nRecommendations will post in <#${REFER_AMOD_CH}>.`,
    );
    assert.equal(replies[0].sensitive, true, "the ack stays ephemeral");

    const row = db.listAutomodCases(communityId)[0];
    assert.equal(row.referrer_user_id, "u-admin-725");
    assert.equal(row.message_id, REFER_MSG);
    assert.equal(row.channel_id, REFER_SRC_CH);
    assert.equal(row.target_user_id, "u-target-726");
    assert.equal(row.note, "targeted harassment in #general");
    assert.equal(row.status, "recorded");

    const audit = db
      .listAdminAudit(communityId, { limit: 10 })
      .find((r) => r.action === "automod.refer");
    assert.ok(audit, "staff intake lands an automod.* audit row (#725 vocabulary)");
    assert.equal(JSON.parse(audit.details_json).case_number, 1);

    // Intake never consumes the budget (the harness does, #728).
    assert.equal(repo.getAutomodBudget(communityId).used, 0);
  });

  it("a malformed link through the slash arm names its own specific cause", async () => {
    const communityId = readyReferCommunity();
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: { message: REFER_MSG }, // bare id — strict grammar refuses
      raw: makeReferRaw(),
    });
    await automod.handlers.automod(ctx, {});
    assert.match(content(replies), /\*\*Message link:\*\*/);
    assert.equal(db.listAutomodCases(communityId).length, 0);
  });

  it("an unpostable automod channel refuses the referral by name", async () => {
    const communityId = readyReferCommunity();
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: { message: referLink() },
      raw: makeReferRaw({ automodSend: false }),
    });
    await automod.handlers.automod(ctx, {});
    assert.match(content(replies), /\*\*Automod channel:\*\*.*not postable/);
    assert.equal(db.listAutomodCases(communityId).length, 0);
  });
});
