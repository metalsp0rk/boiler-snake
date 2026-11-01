/**
 * #725 (epic #723): /automod + /automodconfig command-layer unit tests,
 * extended for #726's /automod refer slash intake wiring.
 *
 * Hand-built CommandContext (the fluxer-honeypot / staffNotes unit pattern) —
 * no gateway, no network. Covers: gates (staff read / admin mutations), the
 * status render (incl. budget sentinels + breaker reason), the rules
 * EXTRACTION arms (`source` = store + one-time batch extract, `extract` =
 * re-run the stored source, `clear` = text + source — the old manual
 * `rules set` + `am:rules` modal surface is retired), the H2-15 confirm:
 * idiom on `safety resume`, the @everyone-view warning on `channel set`
 * (read only — the command must never rewrite overwrites), and the /automod
 * refer wiring (gates first, cross-option enforcement, ack + row + audit).
 * The refusal battery itself lives in test/automod-refer.test.js; the
 * extraction module's own seams live in test/automod-rules-extract.test.js.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");
const automod = require("../src/features/automod");
const service = require("../src/features/automod/settings");
const rulesExtract = require("../src/features/automod/rulesExtract");
const repo = require("../src/db/repositories/automodSettings");
const { MSG_DENIED } = require("../src/core/theme");

after(() => cleanup());

const MANAGE_GUILD = String(PermissionFlagsBits.ManageGuild);
const EXTERNAL_GUILD = "925000000000000000";
/** Rules channel the extraction-arm tests point `rules source` at. */
const RULES_CH = "700000000000000074";

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
 * Raw-interaction fake whose guild carries a REAL-SHAPE rules channel — the
 * object the extraction arms hand to rulesExtract as `deps.guild`. Message
 * reads, pins, and the permission probe are all present so the arm contract
 * (rawInteraction.guild → the extraction deps) is pinned by identity here;
 * the provider round itself is scripted per test.
 */
function makeRulesRaw({ messages = [], pins = [], readable = true } = {}) {
  const rulesChannel = {
    id: RULES_CH,
    permissionsFor: () => ({ has: () => readable }),
    messages: {
      fetch: async () => messages,
      fetchPinned: async () => pins,
    },
  };
  return {
    rulesChannel,
    raw: {
      guild: {
        id: EXTERNAL_GUILD,
        roles: { everyone: { id: EXTERNAL_GUILD } },
        members: { me: { id: "u-bot-725" } },
        channels: {
          cache: { get: (id) => (id === RULES_CH ? rulesChannel : null) },
        },
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
  externalGuildId = EXTERNAL_GUILD,
}) {
  const replies = [];
  const editReplies = [];
  const defers = [];
  const ctx = {
    platform: "discord",
    instanceKey: "discord",
    communityId,
    externalGuildId,
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
    // The extraction arms defer + editReply — record each surface
    // separately (and keep the shared replies stream for content()).
    editReply: async (payload) => {
      editReplies.push(payload);
      replies.push(payload);
    },
    defer: async (payload) => {
      ctx.deferred = true;
      defers.push(payload ?? {});
    },
  };
  return { ctx, replies, editReplies, defers };
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

  it("Rules line names the extraction source (and admits a cleared source honestly)", async () => {
    const communityId = freshCommunity();
    service.setRules(communityId, "No spam. Be kind.");
    service.setRulesChannel(communityId, "700000000000000009");
    const a = makeCtx({ commandName: "automod", communityId, sub: "status" });
    await automod.handlers.automod(a.ctx, {});
    assert.match(
      content(a.replies),
      /\*\*Rules:\*\* set \(\*\*17\*\* chars\) — extracted from <#700000000000000009> \(refresh: `\/automodconfig rules extract`\)/,
    );

    // Text still set but the source gone: never claim a channel that is not.
    service.clearRulesChannel(communityId);
    const b = makeCtx({ commandName: "automod", communityId, sub: "status" });
    await automod.handlers.automod(b.ctx, {});
    assert.match(content(b.replies), /\*\*Rules:\*\* set \(\*\*17\*\* chars\) — extracted from _a source since cleared_/);
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

  // ── rules source|extract|clear — the extraction arms (epic #723) ─────────
  //
  // The manual `rules set` slash option and the `am:rules` modal are
  // retired: `source` stores the rules channel AND runs the one-time batch
  // extraction, `extract` re-runs the stored source, `clear` resets both.
  // The extraction is long-running, so its arms defer ephemerally and
  // editReply the result. Where the provider round must be scripted,
  // rulesExtract.extractRules is stubbed at the MODULE PROPERTY (config.js
  // holds the module object and calls through it per arm) — the real
  // config.js arms, store writes, audits, and shipped copy all still run.
  // The extraction module's own behavior (provider contract, refusals,
  // trim, lock) lives in test/automod-rules-extract.test.js.

  /** Scripted extractRules seam: records args, returns the scripted
   *  result. Always restore()d in a finally. */
  function stubExtract(result) {
    const calls = [];
    const original = rulesExtract.extractRules;
    rulesExtract.extractRules = async (args) => {
      calls.push(args);
      return typeof result === "function" ? result(args) : result;
    };
    return {
      calls,
      restore: () => {
        rulesExtract.extractRules = original;
      },
    };
  }

  /** Shipped-shaped extraction success over RULES_CH (config.js renders it). */
  function extractionOk(over = {}) {
    return {
      ok: true,
      rules: "1. No ads.",
      rulesChars: 10,
      messagesRead: 3,
      pinsKept: 1,
      kept: 2,
      dropped: 0,
      truncated: false,
      pinsFailed: false,
      historyFailed: false,
      channelId: RULES_CH,
      ...over,
    };
  }

  describe("rules source|extract|clear — extraction arms", () => {
    it("rules source stores the channel, extracts, and editReplies the distilled copy (both audits)", async () => {
      const communityId = freshCommunity();
      const { raw, rulesChannel } = makeRulesRaw();
      const { calls, restore } = stubExtract(extractionOk());
      try {
        const { ctx, replies, editReplies, defers } = makeCtx({
          communityId,
          group: "rules",
          sub: "source",
          options: { channel: { id: RULES_CH, type: 0 } },
          raw,
        });
        await automod.handlers.automodconfig(ctx, {});

        // The source stored through the real service BEFORE the batch ran.
        assert.equal(
          db.getGuildSettings(communityId).automod_rules_channel_id,
          RULES_CH,
        );

        // Long-running arm: deferred ephemerally, result edited in.
        assert.deepEqual(defers, [{ sensitive: true }]);
        assert.equal(editReplies.length, 1, "one edit, no direct reply");
        assert.equal(replies.length, 1);

        // The batch ran over the raw guild the arm injected as deps.
        assert.equal(calls.length, 1);
        assert.equal(calls[0].communityId, communityId);
        assert.equal(calls[0].guildId, EXTERNAL_GUILD);
        assert.equal(calls[0].channelId, RULES_CH);
        assert.equal(calls[0].deps.guild, raw.guild, "deps.guild rides the raw interaction guild");
        assert.equal(calls[0].deps.guild.channels.cache.get(RULES_CH), rulesChannel);

        const c = content(editReplies);
        assert.match(
          c,
          /\*\*Automod rules extracted\*\* \(\*\*10\*\* of 4000 chars\) from <#700000000000000074> — 2 post\(s\) distilled \(1 pinned\)\./,
        );
        assert.match(c, /Refresh after channel edits with `\/automodconfig rules extract`\./);

        const audits = db.listAdminAudit(communityId, { limit: 10 });
        const src = audits.find((r) => r.action === "automod.rules_source_set");
        assert.ok(src, "the source write is audited under its own verb");
        assert.equal(JSON.parse(src.details_json).rules_channel_id, RULES_CH);
        const ext = audits.find((r) => r.action === "automod.rules_extracted");
        assert.ok(ext, "the batch run is audited under its own verb");
        assert.deepEqual(JSON.parse(ext.details_json), {
          rules_chars: 10,
          rules_channel_id: RULES_CH,
          posts_kept: 2,
          posts_dropped: 0,
          pins_kept: 1,
          truncated: 0,
        });
      } finally {
        restore();
      }
    });

    it("rules source stores the REAL provider-config refusal through the live module (no stub)", async () => {
      // No extractRules stub: the real rulesExtract runs over the fake
      // guild (channel cache + permission probe + scripted messages) and
      // refuses on the missing AI provider BEFORE any provider round —
      // proof the arm wires deps.guild end-to-end.
      const savedAi = process.env.AI_API_KEY;
      const savedOpenAi = process.env.OPENAI_API_KEY;
      delete process.env.AI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        const communityId = freshCommunity();
        const { ctx, replies, defers } = makeCtx({
          communityId,
          group: "rules",
          sub: "source",
          options: { channel: { id: RULES_CH, type: 0 } },
          raw: makeRulesRaw({ messages: [
            { id: "1", content: "Server rules go here.", author: { username: "op" }, createdTimestamp: 1, pinned: false },
          ] }).raw,
        });
        await automod.handlers.automodconfig(ctx, {});
        assert.equal(db.getGuildSettings(communityId).automod_rules_channel_id, RULES_CH);
        assert.deepEqual(defers, [{ sensitive: true }]);
        assert.match(
          content(replies),
          /The AI provider is not configured \(AI_API_KEY\), so rules cannot be distilled/,
        );
        assert.equal(db.getGuildSettings(communityId).automod_rules, null, "refusal stores no rules");
        const audits = db.listAdminAudit(communityId, { limit: 10 });
        assert.ok(audits.some((r) => r.action === "automod.rules_source_set"));
        assert.ok(!audits.some((r) => r.action === "automod.rules_extracted"));
      } finally {
        if (savedAi !== undefined) process.env.AI_API_KEY = savedAi;
        if (savedOpenAi !== undefined) process.env.OPENAI_API_KEY = savedOpenAi;
      }
    });

    it("extraction failure keeps the stored source and editReplies the specific cause", async () => {
      const communityId = freshCommunity();
      const failure = {
        ok: false,
        channelGone: true,
        error:
          `Rules channel <#${RULES_CH}> is gone or I cannot read it — it may have been deleted, ` +
          "or the channel type does not carry messages. Point the source at a text channel with " +
          "`/automodconfig rules source` again.",
      };
      const { restore } = stubExtract(failure);
      try {
        const { ctx, replies, defers } = makeCtx({
          communityId,
          group: "rules",
          sub: "source",
          options: { channel: { id: RULES_CH, type: 0 } },
        });
        await automod.handlers.automodconfig(ctx, {});
        // Config hygiene first: the SOURCE survives the failed batch.
        assert.equal(db.getGuildSettings(communityId).automod_rules_channel_id, RULES_CH);
        assert.equal(defers.length, 1);
        assert.equal(content(replies), failure.error, "the specific cause rides through verbatim");
        const actions = db.listAdminAudit(communityId, { limit: 10 }).map((r) => r.action);
        assert.ok(actions.includes("automod.rules_source_set"));
        assert.ok(
          !actions.includes("automod.rules_extracted"),
          "nothing extracted, nothing claimed",
        );
      } finally {
        restore();
      }
    });

    it("rules extract WITHOUT a stored source refuses naming rules source (no deferral, no batch)", async () => {
      const communityId = freshCommunity();
      const { calls, restore } = stubExtract(extractionOk());
      try {
        const { ctx, replies, defers } = makeCtx({
          communityId,
          group: "rules",
          sub: "extract",
        });
        await automod.handlers.automodconfig(ctx, {});
        assert.equal(
          content(replies),
          "No rules channel is set — `/automodconfig rules source <channel>` stores it and runs " +
            "the first extraction.",
        );
        assert.equal(defers.length, 0, "the refusal is an immediate reply, not a deferred edit");
        assert.equal(calls.length, 0);
      } finally {
        restore();
      }
    });

    it("rules extract re-runs the STORED source (deferred, audited under automod.rules_extracted)", async () => {
      const communityId = freshCommunity();
      service.setRulesChannel(communityId, RULES_CH);
      const { calls, restore } = stubExtract(extractionOk());
      try {
        const { ctx, replies, defers } = makeCtx({
          communityId,
          group: "rules",
          sub: "extract",
        });
        await automod.handlers.automodconfig(ctx, {});
        assert.equal(calls.length, 1);
        assert.equal(calls[0].channelId, RULES_CH, "the arm re-read the stored source");
        assert.deepEqual(defers, [{ sensitive: true }]);
        assert.match(content(replies), /\*\*Automod rules extracted\*\* \(\*\*10\*\* of 4000 chars\)/);
        const ext = db
          .listAdminAudit(communityId, { limit: 10 })
          .find((r) => r.action === "automod.rules_extracted");
        assert.ok(ext);
        assert.equal(JSON.parse(ext.details_json).rules_channel_id, RULES_CH);
      } finally {
        restore();
      }
    });

    it("the honest tail (trim disclosure + pins/history read failures) rides in the SAME edit", async () => {
      const communityId = freshCommunity();
      service.setRulesChannel(communityId, RULES_CH);
      const { restore } = stubExtract(
        extractionOk({ kept: 38, dropped: 7, truncated: true, pinsFailed: true, historyFailed: true }),
      );
      try {
        const { ctx, replies } = makeCtx({ communityId, group: "rules", sub: "extract" });
        await automod.handlers.automodconfig(ctx, {});
        const c = content(replies);
        assert.match(c, /— 38 post\(s\) distilled \(1 pinned\)\./);
        assert.match(
          c,
          /\*\*Note:\*\* the channel held more than the extraction input cap — the oldest 7 post\(s\) were left out of the batch/,
        );
        assert.match(c, /\*\*Note:\*\* the pins read failed — only recent history was distilled\./);
        assert.match(c, /\*\*Note:\*\* the history read stopped early \(see logs\)/);
        const ext = db
          .listAdminAudit(communityId, { limit: 10 })
          .find((r) => r.action === "automod.rules_extracted");
        assert.equal(JSON.parse(ext.details_json).truncated, 1, "the disclosure lands in the audit too");
      } finally {
        restore();
      }
    });

    it("rules clear resets BOTH the text and the source, audited under both verbs", async () => {
      const communityId = freshCommunity();
      service.setRules(communityId, "1. No ads.");
      service.setRulesChannel(communityId, RULES_CH);
      const { ctx, replies } = makeCtx({ communityId, group: "rules", sub: "clear" });
      await automod.handlers.automodconfig(ctx, {});
      const row = db.getGuildSettings(communityId);
      assert.equal(row.automod_rules, null);
      assert.equal(row.automod_rules_channel_id, null);
      assert.match(
        content(replies),
        /\*\*Automod rules cleared\*\* \(text \+ rules-channel source\)\. Cases will refuse naming the missing rules until `\/automodconfig rules source` runs again/,
      );
      const actions = db.listAdminAudit(communityId, { limit: 10 }).map((r) => r.action);
      assert.ok(actions.includes("automod.rules_clear"), "the text clear is audited");
      assert.ok(actions.includes("automod.rules_channel_clear"), "the source clear is audited");
    });

    it("rules clear reports PARTIAL failure honestly when the source clear fails", async () => {
      const communityId = freshCommunity();
      service.setRules(communityId, "1. No ads.");
      service.setRulesChannel(communityId, RULES_CH);
      const original = service.clearRulesChannel;
      service.clearRulesChannel = () => ({ ok: false, error: "simulated store failure" });
      try {
        const { ctx, replies } = makeCtx({ communityId, group: "rules", sub: "clear" });
        await automod.handlers.automodconfig(ctx, {});
        assert.match(
          content(replies),
          /\*\*Automod rules text cleared\*\*, but the rules-channel source could NOT be unset: simulated store failure/,
        );
        const row = db.getGuildSettings(communityId);
        assert.equal(row.automod_rules, null, "the text clear DID happen");
        assert.equal(row.automod_rules_channel_id, RULES_CH, "the source honestly stayed");
        const actions = db.listAdminAudit(communityId, { limit: 10 }).map((r) => r.action);
        assert.ok(actions.includes("automod.rules_clear"));
        assert.ok(
          !actions.includes("automod.rules_channel_clear"),
          "a failed clear is never audited as done",
        );
      } finally {
        service.clearRulesChannel = original;
      }
    });

    it("non-admin never reaches any rules arm (handler gate before the store)", async () => {
      const communityId = freshCommunity();
      for (const sub of ["source", "extract", "clear"]) {
        const { ctx, replies, defers } = makeCtx({
          communityId,
          group: "rules",
          sub,
          options: { channel: { id: RULES_CH } },
          manageGuild: false,
        });
        await automod.handlers.automodconfig(ctx, {});
        assert.equal(content(replies), MSG_DENIED, `rules ${sub} denied`);
        assert.equal(defers.length, 0);
      }
      assert.equal(db.getGuildSettings(communityId).automod_rules_channel_id, null);
    });
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
function makeReferRaw({ automodSend = true, sourceView = true, guildId = EXTERNAL_GUILD } = {}) {
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
  const raw = {
    user: { id: "u-admin-725" },
    member: { id: "u-admin-725" },
    guild: {
      id: guildId,
      roles: { everyone: { id: guildId } },
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
  // #771: the refer arm opens the referral modal — record it so the test can
  // submit the form like Discord would (submitReferModal).
  raw.showModal = async (modal) => {
    raw.__shownModal = typeof modal?.toJSON === "function" ? modal.toJSON() : modal;
  };
  return raw;
}

/** Configure a community for referral intake through the shipped services. */
function readyReferCommunity({ channelId = REFER_AMOD_CH } = {}) {
  const communityId = freshCommunity();
  service.setEnabled(communityId, true);
  service.setChannel(communityId, channelId);
  service.setRules(communityId, "No spam. Be kind.");
  return communityId;
}

/**
 * #771 intake driver: the slash arm now OPENS the referral modal before the
 * case exists. After `automod.handlers.automod(ctx)` opened it (raw.showModal
 * spy captured it), submit the form through the real modal handler — the
 * whole refusal battery + case write run there. The submit fake re-uses the
 * ctx's staff legs (ManageGuild bit or the member's role ids).
 */
async function submitReferModal(ctx, manageGuild, fields = { problem: "targeted harassment" }) {
  const referModal = require("../src/features/automod/referModal");
  const raw = ctx.rawInteraction;
  const shown = raw.__shownModal;
  const replies = [];
  const submit = {
    isModalSubmit: () => true,
    customId: shown?.custom_id ?? "am:refer:",
    guildId: raw.guild?.id ?? ctx.externalGuildId,
    guild: raw.guild,
    user: raw.user,
    member: {
      id: ctx.userId,
      roles: { cache: new Map((ctx.memberRoleIds ?? []).map((r) => [r, {}])) },
    },
    memberPermissions: {
      has: (flag) => manageGuild === true && String(flag) === String(PermissionFlagsBits.ManageGuild),
    },
    fields: { getTextInputValue: (id) => fields[id] ?? "" },
    replies,
    reply: async (payload) => {
      replies.push(typeof payload === "string" ? { content: payload } : payload);
      return payload;
    },
  };
  await referModal.handleReferModal(submit, {});
  return submit;
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
    // Unique guild string for BOTH the community and the raw interaction:
    // #771 the submit leg's staff gate maps the GUILD to the community
    // (discordCommunityId) to resolve the staff-role membership.
    const guild = `934${String(++seq).padStart(15, "0")}`; // digits-only: the strict link grammar
    const communityId = communityKey(guild);
    service.setEnabled(communityId, true);
    service.setChannel(communityId, REFER_AMOD_CH);
    service.setRules(communityId, "No spam. Be kind.");
    db.addStaffRole(communityId, "role-726-junior", "junior", "u-admin-725");
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: {
        message: referLink(guild),
        user: { id: "u-target-726" },
      },
      manageGuild: false,
      memberRoleIds: ["role-726-junior"],
      externalGuildId: guild,
      raw: makeReferRaw({ guildId: guild }),
    });
    await automod.handlers.automod(ctx, {});

    // #771: the invoke opens the modal (the staff-role leg passed BOTH gates)
    // and files NOTHING yet — the case rides on the submit.
    assert.equal(replies.length, 0, "no ack before the form");
    assert.match(ctx.rawInteraction.__shownModal.custom_id, /^am:refer:[0-9a-f]{32}$/);
    assert.equal(db.listAutomodCases(communityId).length, 0);

    const submit = await submitReferModal(ctx, false, {
      problem: "targeted harassment in #general",
    });
    assert.equal(
      String(submit.replies[0]?.content ?? ""),
      `Case: **A-1** — recorded.\nRecommendations will post in <#${REFER_AMOD_CH}>.`,
    );
    assert.ok(submit.replies[0]?.flags != null, "the ack stays ephemeral");

    const row = db.listAutomodCases(communityId)[0];
    assert.equal(row.referrer_user_id, "u-admin-725");
    assert.equal(row.message_id, REFER_MSG);
    assert.equal(row.channel_id, REFER_SRC_CH);
    assert.equal(row.target_user_id, "u-target-726");
    assert.equal(row.note, "targeted harassment in #general");
    assert.equal(row.read_before, 100, "#771 default window (empty modal fields)");
    assert.equal(row.read_after, 20);
    assert.equal(row.status, "recorded");

    const audit = db
      .listAdminAudit(communityId, { limit: 10 })
      .find((r) => r.action === "automod.refer");
    assert.ok(audit, "staff intake lands an automod.* audit row (#725 vocabulary)");
    assert.equal(JSON.parse(audit.details_json).case_number, 1);

    // Intake never consumes the budget (the harness does, #728).
    assert.equal(repo.getAutomodBudget(communityId).used, 0);
  });

  it("a malformed link names its own specific cause AT SUBMIT (#771)", async () => {
    const communityId = readyReferCommunity();
    const { ctx, replies } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: { message: REFER_MSG }, // bare id — strict grammar refuses
      raw: makeReferRaw(),
    });
    await automod.handlers.automod(ctx, {});
    assert.ok(ctx.rawInteraction.__shownModal, "the form opens with any target text");
    const submit = await submitReferModal(ctx, true);
    assert.match(String(submit.replies[0]?.content ?? ""), /\*\*Message link:\*\*/);
    assert.equal(db.listAutomodCases(communityId).length, 0);
    void replies;
  });

  it("an unpostable automod channel refuses the referral by name AT SUBMIT (#771)", async () => {
    const communityId = readyReferCommunity();
    const { ctx } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: { message: referLink() },
      raw: makeReferRaw({ automodSend: false }),
    });
    await automod.handlers.automod(ctx, {});
    const submit = await submitReferModal(ctx, true);
    assert.match(
      String(submit.replies[0]?.content ?? ""),
      /\*\*Automod channel:\*\*.*not postable/,
    );
    assert.equal(db.listAutomodCases(communityId).length, 0);
  });

  // ── #771 §1: the modal's own parse contract (reject/clamp/default) ───────

  it("a non-integer window field refuses naming the EXACT field — nothing filed", async () => {
    const communityId = readyReferCommunity();
    const { ctx } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: { message: referLink() },
      raw: makeReferRaw(),
    });
    await automod.handlers.automod(ctx, {});
    const submit = await submitReferModal(ctx, true, { problem: "slurs", read_before: "lots" });
    assert.equal(
      String(submit.replies[0]?.content ?? ""),
      "`Messages before` wasn't a number — nothing was filed.",
    );
    assert.equal(db.listAutomodCases(communityId).length, 0);
  });

  it("over-cap windows CLAMP and the reply SAYS SO", async () => {
    const communityId = readyReferCommunity();
    const { ctx } = makeCtx({
      commandName: "automod",
      communityId,
      sub: "refer",
      options: { message: referLink() },
      raw: makeReferRaw(),
    });
    await automod.handlers.automod(ctx, {});
    const submit = await submitReferModal(ctx, true, {
      problem: "slurs",
      read_before: "5000",
      read_after: "9999",
    });
    const ack = String(submit.replies[0]?.content ?? "");
    assert.match(ack, /Case: \*\*A-1\*\* — recorded\./);
    assert.match(ack, /`Messages before` was above the 500 cap — clamped to 500\./);
    assert.match(ack, /`Messages after` was above the 500 cap — clamped to 500\./);
    const row = db.listAutomodCases(communityId)[0];
    assert.equal(row.read_before, 500);
    assert.equal(row.read_after, 500);
  });

  // ── #771 §6: /set-moderation-queue — the admin alias over the channel ────

  describe("/set-moderation-queue — queue alias (#771)", () => {
    it("admin sets the queue: same stored channel, own audit verb", async () => {
      const communityId = readyReferCommunity({ channelId: null });
      service.clearChannel(communityId);
      const { ctx, replies } = makeCtx({
        commandName: "set-moderation-queue",
        communityId,
        sub: "set",
        options: { channel: { id: REFER_AMOD_CH } },
      });
      await automod.handlers["set-moderation-queue"](ctx, {});
      assert.match(content(replies), /\*\*Moderation queue set:\*\*/);
      assert.equal(service.readSettings(communityId).settings.channelId, REFER_AMOD_CH);
      const audit = db
        .listAdminAudit(communityId, { limit: 10 })
        .find((r) => r.action === "automod.queue_set");
      assert.ok(audit, "the alias names its OWN surface in the trail");
      assert.equal(JSON.parse(audit.details_json).channel_id, REFER_AMOD_CH);
    });

    it("clear unsets it with the alias copy + automod.queue_clear", async () => {
      const communityId = readyReferCommunity();
      const { ctx, replies } = makeCtx({
        commandName: "set-moderation-queue",
        communityId,
        sub: "clear",
        options: {},
      });
      await automod.handlers["set-moderation-queue"](ctx, {});
      assert.match(content(replies), /\*\*Moderation queue cleared\.\*\*/);
      assert.equal(service.readSettings(communityId).settings.channelId, null);
      assert.ok(
        db
          .listAdminAudit(communityId, { limit: 10 })
          .some((r) => r.action === "automod.queue_clear"),
      );
    });

    it("non-admin is denied; Fluxer contexts get NOT_ON_FLUXER", async () => {
      const communityId = readyReferCommunity();
      const denied = makeCtx({
        commandName: "set-moderation-queue",
        communityId,
        sub: "set",
        options: { channel: { id: REFER_AMOD_CH } },
        manageGuild: false,
      });
      await automod.handlers["set-moderation-queue"](denied.ctx, {});
      assert.equal(content(denied.replies), MSG_DENIED);

      const fluxer = makeCtx({
        commandName: "set-moderation-queue",
        communityId,
        sub: "clear",
        options: {},
        noRaw: true,
      });
      await automod.handlers["set-moderation-queue"](fluxer.ctx, {});
      assert.equal(content(fluxer.replies), "That command is not available on Fluxer yet.");
    });

    it("the alias writes the SAME setting /automodconfig channel uses (one queue)", async () => {
      const communityId = readyReferCommunity({ channelId: null });
      service.clearChannel(communityId);
      const setCtx = makeCtx({
        commandName: "set-moderation-queue",
        communityId,
        sub: "set",
        options: { channel: { id: REFER_SRC_CH } },
      });
      await automod.handlers["set-moderation-queue"](setCtx.ctx, {});
      const viaConfig = makeCtx({
        commandName: "automodconfig",
        communityId,
        group: "channel",
        sub: "set",
        options: { channel: { id: REFER_AMOD_CH } },
      });
      await automod.handlers.automodconfig(viaConfig.ctx, {});
      // Last writer wins on the ONE column — no second queue exists.
      assert.equal(service.readSettings(communityId).settings.channelId, REFER_AMOD_CH);
    });
  });
});
