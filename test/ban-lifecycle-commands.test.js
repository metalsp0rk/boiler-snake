/**
 * #772 §1/§6: /ban + /bannotify + "Ban member" menu + ban-modal unit suite
 * (test/ban-lifecycle-commands.test.js).
 *
 * Hand-built CommandContext (the automod-commands idiom) + raw interaction
 * doubles — no gateway, no network. Pinned surface:
 *  - /ban inline vs modal branch (reason+duration → inline run; either
 *    missing → the ONE shared modal; a slash-invalid duration rejects inline
 *    with the field-named #745 copy and NO form opens);
 *  - modal invalid-duration submit → ephemeral reject naming "Duration" +
 *    the example, with ZERO banService.banUser calls and ZERO ban_records
 *    rows (the never-act-on-misread law, asserted at the service seam);
 *  - "Ban member" context menu always opens the modal, never bans directly;
 *  - exactly ONE banService.banUser call per accepted flow (inline, menu →
 *    modal submit, slash-duration fallback when the modal leaves Duration
 *    blank);
 *  - pending-token law: one-shot pop + TTL expiry via setPendingClock;
 *  - /bannotify status read (defaults ON) and toggle arms: real
 *    updateGuildSettings writes (asserted through the repository), real
 *    recordSlashAudit rows (asserted via db.listAdminAudit — the
 *    automod-commands idiom), and logConfigChange embeds (module seam);
 *  - Fluxer/rawInteraction-absent contexts answer NOT_ON_FLUXER with zero
 *    mutation (#772 explicit no-parity).
 *
 * Stub discipline: commands.js/banModal.js destructure their module deps at
 * require time, so getDiscordOutbound / logConfigChange are patched on the
 * freshly-loaded module objects BEFORE commands.js is ever required (the
 * same stub-at-the-module-object law the automod rulesExtract tests use).
 * recordSlashAudit is NOT stubbed — the real fail-safe writer lands rows in
 * the temp DB, which is a stronger proof than a spy.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

const BAN_CONTEXT_MENU_NAME = "Ban member";

// ── module seams installed BEFORE commands.js loads (require-time capture) ──
const auditLogMod = require("../src/features/logs/auditLog");
const outboundMod = require("../src/platform/discord/outbound");

const origLogConfigChange = auditLogMod.logConfigChange;
const origGetDiscordOutbound = outboundMod.getDiscordOutbound;

let configEmbeds = [];
auditLogMod.logConfigChange = async (outbound, guildId, opts) => {
  configEmbeds.push({ outbound, guildId, opts });
  return { ok: true };
};
let modalOutbound = null; // what the patched factory hands the modal arm
outboundMod.getDiscordOutbound = () => modalOutbound;

const commands = require("../src/features/banLifecycle/commands");
const banModal = require("../src/features/banLifecycle/banModal");
const banService = require("../src/features/banLifecycle/banService");
const { NOT_ON_FLUXER: AUTOMOD_NOT_ON_FLUXER } = require("../src/features/automod/constants");
const { MSG_DENIED } = require("../src/core/theme");
const {
  MODAL_BAN_PREFIX,
  MODAL_FIELD_REASON,
  MODAL_FIELD_DURATION,
  DURATION_EXAMPLES,
} = require("../src/features/banLifecycle/constants");

after(() => {
  auditLogMod.logConfigChange = origLogConfigChange;
  outboundMod.getDiscordOutbound = origGetDiscordOutbound;
  banModal.setPendingClock(null);
  banModal.clearPendingBans();
  cleanup();
});

const { PermissionFlagsBits } = require("discord.js");
const MANAGE_GUILD = String(PermissionFlagsBits.ManageGuild);

const EXTERNAL_GUILD = "978200000000000001";
const ADMIN = "878200000000000012";
const SUB = "878200000000000013";

let seq = 0;
const freshCid = () => communityKey(`9782000000000099${String(++seq).padStart(3, "0")}`);
const banRecordCount = (cid) =>
  db.db.prepare("SELECT COUNT(*) AS c FROM ban_records WHERE community_id=?").get(cid).c;

/** banService.banUser spy: commands.js calls it through the module object. */
const origBanUser = banService.banUser;
let serviceCalls = [];
banService.banUser = async (opts) => {
  serviceCalls.push(opts);
  return origBanUser(opts);
};

// ── doubles ──────────────────────────────────────────────────────────────────

/** Client double for banService's DEFAULT guard seams (card-buttons shape). */
function makeClient(guildId = EXTERNAL_GUILD) {
  const guild = {
    id: guildId,
    name: "Test Guild",
    members: {
      me: { roles: { highest: { position: 10 } } },
      fetch: async () => ({
        roles: { cache: new Map(), highest: { position: 1 } },
        permissions: { has: () => false },
      }),
    },
  };
  return {
    user: { id: "778200000000000099" },
    guilds: { cache: { get: (id) => (String(id) === String(guildId) ? guild : null) } },
  };
}

function makeOutbound() {
  const calls = [];
  return {
    calls,
    async sendDm(userId, payload) {
      calls.push({ op: "sendDm", userId, payload });
      return { ok: true };
    },
    async banMember(communityId, userId, reason) {
      calls.push({ op: "banMember", communityId, userId: String(userId), reason });
      return { ok: true };
    },
    async unbanMember() {
      calls.push({ op: "unbanMember" });
      return { ok: true };
    },
  };
}

/** CommandContext double (automod-commands makeCtx shape). */
function makeCtx({
  commandName = "ban",
  communityId,
  sub = null,
  options = {},
  manageGuild = true,
  noRaw = false,
  externalGuildId = EXTERNAL_GUILD,
  outbound = null,
}) {
  const replies = [];
  const editReplies = [];
  const defers = [];
  const modals = [];
  const client = makeClient();
  const ctx = {
    platform: "discord",
    instanceKey: "discord",
    communityId,
    externalGuildId,
    channelId: "10",
    userId: ADMIN,
    user: { id: ADMIN, username: "admin" },
    commandName,
    subcommandGroup: null,
    subcommand: sub,
    options: {
      getString: (name) => (options[name] ?? null),
      getUser: (name) => (options[name] ?? null),
    },
    channelPermissions: manageGuild ? MANAGE_GUILD : "0",
    memberRoleIds: [],
    guildOwner: false,
    deferred: false,
    replied: false,
    outbound,
    // noRaw:true models a Fluxer context — the adapter omits rawInteraction
    // entirely (never a null placeholder; the gate reads presence).
    rawInteraction: noRaw
      ? undefined
      : {
          guild: { id: externalGuildId, name: "Test Guild" },
          client,
          showModal: async (modal) => {
            modals.push(modal);
          },
        },
    reply: async (payload) => {
      replies.push(payload);
    },
    editReply: async (payload) => {
      editReplies.push(payload);
      replies.push(payload);
    },
    defer: async (payload) => {
      ctx.deferred = true;
      defers.push(payload ?? {});
    },
  };
  return { ctx, replies, editReplies, defers, modals, client };
}

const content = (replies, i = 0) => String(replies[i]?.content ?? "");

/** ModalBuilder → wire customId (builders expose .data/.toJSON, not .customId —
 *  the ticket-reports / warnnotes idiom). */
const modalCustomId = (modal) =>
  String(modal?.toJSON?.().custom_id ?? modal?.data?.custom_id ?? modal?.customId ?? "");

/** Raw modal-submit double for handleBanModal. */
function makeSubmit({
  token,
  fields = {},
  staff = true,
  shapeOk = true,
  userId = ADMIN,
  client = makeClient(),
}) {
  const it = {
    isModalSubmit: () => shapeOk,
    customId: MODAL_BAN_PREFIX + token,
    guildId: EXTERNAL_GUILD,
    guild: { id: EXTERNAL_GUILD, name: "Test Guild" },
    user: { id: userId },
    member: { roles: { cache: new Map() } },
    memberPermissions: { has: () => staff },
    client,
    fields: { getTextInputValue: (id) => fields[id] ?? "" },
    deferred: false,
    replied: false,
    replies: [],
    defers: [],
    edits: [],
    async reply(payload) {
      this.replies.push(payload);
      this.replied = true;
    },
    async followUp(payload) {
      this.replies.push(payload);
    },
    async deferReply(payload) {
      this.deferred = true;
      this.defers.push(payload ?? {});
    },
    async editReply(payload) {
      this.edits.push(payload);
    },
  };
  return it;
}

function putEntry(overrides = {}) {
  return banModal.putPendingBan({
    communityId: overrides.communityId ?? freshCid(),
    guildId: EXTERNAL_GUILD,
    guildName: "Test Guild",
    targetUserId: SUB,
    reason: null,
    durationRaw: null,
    ...overrides,
  });
}

const RUN_CTX = (client) => ({ supervisor: { discord: client } });

// ═══ /ban — inline vs modal branch ══════════════════════════════════════════

test("/ban with reason AND duration runs INLINE: defer → one service call → B-n + both stamps + audit row", async () => {
  const cid = freshCid();
  const outbound = makeOutbound();
  const { ctx, replies, editReplies, defers, modals } = makeCtx({
    communityId: cid,
    options: { member: { id: SUB, username: "sub", bot: false }, reason: "raiding", duration: "24h" },
    outbound,
  });
  serviceCalls = [];

  await commands.handlers.ban(ctx, {});

  assert.equal(modals.length, 0, "complete intents never open the form");
  assert.equal(ctx.deferred, true, "inline runs defer before the long flow");
  assert.equal(defers.length, 1);
  assert.equal(serviceCalls.length, 1, "exactly ONE banService.banUser per accepted flow");
  assert.equal(serviceCalls[0].source, "staff");
  assert.equal(serviceCalls[0].userId, SUB);
  assert.equal(serviceCalls[0].moderatorId, ADMIN);

  const reply = content(editReplies);
  assert.match(reply, new RegExp(`\\*\\*Banned:\\*\\* <@${SUB}> \\(\\*\\*B-1\\*\\*\\)`));
  assert.match(reply, /<t:\d+:F> \(<t:\d+:R>\)/, "staff-side expiry carries BOTH stamps");
  assert.match(reply, /\*\*Ban DM:\*\* sent\./);

  // DM-before-ban actually ran through the ctx.outbound seam.
  assert.deepEqual(outbound.calls.map((c) => c.op), ["sendDm", "banMember"]);

  // Record + staff audit row (real recordSlashAudit, real temp DB).
  const row = db.findActiveBanRecord(cid, SUB);
  assert.ok(row, "the ban landed its lifecycle record");
  assert.ok(row.expires_at > row.banned_at + 23 * 3_600_000, "24h expiry stored");
  const replyUnix = Math.floor(row.expires_at / 1000);
  assert.ok(reply.includes(`<t:${replyUnix}:F>`), "reply stamp matches the stored expiry");

  const audits = db.listAdminAudit(cid, { limit: 25 });
  const banAudit = audits.find((r) => r.action === "banLifecycle.ban");
  assert.ok(banAudit, "staff ban owns ONE slash-origin audit row");
  assert.equal(banAudit.origin, "slash");
  assert.equal(banAudit.actor_user_id, ADMIN);
  assert.equal(banAudit.target_id, SUB);
  assert.equal(JSON.parse(banAudit.details_json).source, "staff");
});

test("/ban duration 'permanent' stays inline and answers with the permanent duration line", async () => {
  const cid = freshCid();
  const outbound = makeOutbound();
  const { ctx, editReplies } = makeCtx({
    communityId: cid,
    options: { member: { id: SUB }, reason: "spam wave", duration: "permanent" },
    outbound,
  });
  serviceCalls = [];

  await commands.handlers.ban(ctx, {});

  assert.equal(serviceCalls.length, 1);
  assert.match(content(editReplies), /\*\*Duration:\*\* permanent — no auto-expiry; staff lift it manually\./);
  const row = db.findActiveBanRecord(cid, SUB);
  assert.ok(row);
  assert.equal(row.expires_at, null, "permanent → no expiry column");
});

test("/ban missing the reason opens the ONE modal with a bl:ban: token and touches the service ZERO times", async () => {
  const cid = freshCid();
  const before = banModal.pendingBanCount();
  const { ctx, modals, replies } = makeCtx({
    communityId: cid,
    options: { member: { id: SUB }, duration: "24h" },
  });
  serviceCalls = [];

  await commands.handlers.ban(ctx, {});

  assert.equal(modals.length, 1, "incomplete intents funnel into the shared modal");
  assert.match(modalCustomId(modals[0]), /^bl:ban:[0-9a-f]{32}$/);
  assert.equal(banModal.pendingBanCount(), before + 1, "the slash intents rode the pending entry");
  assert.equal(serviceCalls.length, 0);
  assert.equal(replies.length, 0, "no chatter alongside the form");
  assert.equal(ctx.deferred, false, "a modal can never open on a deferred interaction");
  assert.equal(banRecordCount(cid), 0);
  banModal.clearPendingBans();
});

test("slash-invalid duration rejects inline naming Duration + example, NO modal, ZERO service calls", async () => {
  const cid = freshCid();
  const { ctx, replies, modals } = makeCtx({
    communityId: cid,
    options: { member: { id: SUB }, reason: "raiding", duration: "59x" },
  });
  serviceCalls = [];

  await commands.handlers.ban(ctx, {});

  const c = content(replies);
  assert.match(c, /\*\*Duration:\*\*/);
  assert.ok(c.includes(DURATION_EXAMPLES) && c.includes("24h") && c.includes("7d"), c);
  assert.match(c, /Nothing was banned\./);
  assert.equal(replies[0].sensitive, true, "ephemeral");
  assert.equal(modals.length, 0, "NEVER open a form built on a misread");
  assert.equal(serviceCalls.length, 0);
  assert.equal(banRecordCount(cid), 0);
});

test("/ban with an unresolvable member refuses with the field truth and bans nothing", async () => {
  const cid = freshCid();
  const { ctx, replies } = makeCtx({ communityId: cid, options: {} });
  serviceCalls = [];
  await commands.handlers.ban(ctx, {});
  assert.match(content(replies), /Could not resolve the member/);
  assert.match(content(replies), /Nothing was banned\./);
  assert.equal(serviceCalls.length, 0);
});

test("/ban for a non-admin is denied with the standard denial BEFORE anything else", async () => {
  const cid = freshCid();
  const { ctx, replies } = makeCtx({
    communityId: cid,
    manageGuild: false,
    options: { member: { id: SUB }, reason: "raiding", duration: "24h" },
  });
  serviceCalls = [];
  await commands.handlers.ban(ctx, {});
  assert.equal(content(replies), MSG_DENIED);
  assert.equal(serviceCalls.length, 0);
  assert.equal(banRecordCount(cid), 0);
});

test("/ban on a Fluxer-shaped context (no rawInteraction) answers NOT_ON_FLUXER with zero mutation", async () => {
  const cid = freshCid();
  const { ctx, replies } = makeCtx({
    communityId: cid,
    noRaw: true,
    options: { member: { id: SUB }, reason: "raiding", duration: "24h" },
  });
  serviceCalls = [];
  await commands.handlers.ban(ctx, {});
  assert.equal(content(replies), commands.NOT_ON_FLUXER);
  assert.equal(commands.NOT_ON_FLUXER, AUTOMOD_NOT_ON_FLUXER, "one shipped refusal sentence across features");
  assert.equal(replies[0].sensitive, true);
  assert.equal(serviceCalls.length, 0);
  assert.equal(banRecordCount(cid), 0);
});

// ═══ "Ban member" context menu — always the modal, never a direct ban ═══════

test("the context menu opens the modal (never a direct ban) and reuses the registered community", async () => {
  const cid = communityKey(EXTERNAL_GUILD); // menu resolves THIS id via ensureCommunity
  const modals = [];
  const replies = [];
  const interaction = {
    commandName: BAN_CONTEXT_MENU_NAME,
    guildId: EXTERNAL_GUILD,
    guild: { id: EXTERNAL_GUILD, name: "Test Guild" },
    user: { id: ADMIN },
    memberPermissions: { has: () => true },
    options: { getUser: (name) => (name === "user" ? { id: SUB } : null) },
    deferred: false,
    replied: false,
    async reply(payload) {
      replies.push(payload);
      this.replied = true;
    },
    async followUp(payload) {
      replies.push(payload);
    },
    showModal: async (modal) => {
      modals.push(modal);
    },
  };
  const before = banModal.pendingBanCount();
  serviceCalls = [];

  await commands.handlers[BAN_CONTEXT_MENU_NAME](interaction, {});

  assert.equal(modals.length, 1, "the menu ALWAYS answers with the form");
  assert.match(modalCustomId(modals[0]), new RegExp(`^${MODAL_BAN_PREFIX}[0-9a-f]{32}$`));
  assert.equal(banModal.pendingBanCount(), before + 1);
  // The pending entry carries the menu target + the resolved community:
  // it must be THE SAME community id the guild already maps to.
  const entry = banModal.takePendingBan(modalCustomId(modals[0]).slice(MODAL_BAN_PREFIX.length));
  assert.equal(entry.communityId, cid, "menu and slash resolve ONE community per guild");
  assert.equal(entry.targetUserId, SUB);
  assert.equal(serviceCalls.length, 0, "menus never ban directly");
  assert.equal(banRecordCount(cid), 0);
});

test("the context menu denied for non-admins (picker tier is ManageGuild)", async () => {
  const modals = [];
  const replies = [];
  const interaction = {
    guildId: EXTERNAL_GUILD,
    user: { id: "878200000000000042" },
    memberPermissions: { has: () => false },
    options: { getUser: () => ({ id: SUB }) },
    deferred: false,
    replied: false,
    async reply(payload) {
      replies.push(payload);
      this.replied = true;
    },
    async followUp(payload) {
      replies.push(payload);
    },
    showModal: async (m) => modals.push(m),
  };
  await commands.handlers[BAN_CONTEXT_MENU_NAME](interaction, {});
  assert.equal(modals.length, 0);
  assert.equal(String(replies[0]?.content ?? ""), MSG_DENIED);
});

// ═══ modal submit — the never-act-on-misread law at the surface ═════════════

test("modal submit with an invalid Duration: field-named reject, ZERO service calls, ZERO ban_records rows", async () => {
  const cid = freshCid();
  modalOutbound = makeOutbound();
  const token = putEntry({ communityId: cid });
  const it = makeSubmit({ token, fields: { [MODAL_FIELD_REASON]: "raiding", [MODAL_FIELD_DURATION]: "59x" } });
  serviceCalls = [];

  await banModal.handleBanModal(it, RUN_CTX(makeClient()));

  assert.equal(it.edits.length, 0, "the reject lands as an ephemeral reply, not an edit");
  assert.equal(it.replies.length, 1);
  const c = String(it.replies[0].content);
  assert.match(c, /\*\*Duration:\*\*/);
  assert.ok(c.includes(DURATION_EXAMPLES), c);
  assert.match(c, /Nothing was banned\./);
  assert.deepEqual(it.replies[0].allowedMentions, { parse: [] });
  assert.equal(it.deferred, false, "a refused submit never even defers");

  // #745 proof at the service seam + storage: NOTHING happened.
  assert.equal(serviceCalls.length, 0, "banService.banUser was NEVER called");
  assert.equal(modalOutbound.calls.length, 0, "zero outbound");
  assert.equal(banRecordCount(cid), 0, "no ban_records row exists after the reject");

  // The one-shot token was consumed by the attempt: a replay reads expired.
  const replay = makeSubmit({ token, fields: { [MODAL_FIELD_REASON]: "raiding" } });
  await banModal.handleBanModal(replay, RUN_CTX(makeClient()));
  assert.match(String(replay.replies[0].content), /\*\*Modal expired:\*\*/);
  assert.match(String(replay.replies[0].content), /nothing was banned/);
  assert.equal(serviceCalls.length, 0, "replays never ban twice either");
});

test("modal submit without a reason refuses naming **Reason:** and bans nothing", async () => {
  const cid = freshCid();
  modalOutbound = makeOutbound();
  const token = putEntry({ communityId: cid });
  const it = makeSubmit({ token, fields: { [MODAL_FIELD_DURATION]: "24h" } });
  serviceCalls = [];

  await banModal.handleBanModal(it, RUN_CTX(makeClient()));

  assert.match(String(it.replies[0].content), /\*\*Reason:\*\* is required — nothing was banned\./);
  assert.equal(serviceCalls.length, 0);
  assert.equal(banRecordCount(cid), 0);
});

test("modal happy path: defer → ONE service call → B-n reply with stamps; record lands", async () => {
  const cid = freshCid();
  modalOutbound = makeOutbound();
  const client = makeClient();
  const token = putEntry({ communityId: cid });
  const it = makeSubmit({ token, fields: { [MODAL_FIELD_REASON]: "raid leader", [MODAL_FIELD_DURATION]: "7d" }, client });
  serviceCalls = [];

  await banModal.handleBanModal(it, RUN_CTX(client));

  assert.equal(it.deferred, true, "the slow ban flow defers first");
  assert.equal(it.defers[0]?.flags != null, true, "deferred ephemerally (MessageFlags.Ephemeral)");
  assert.equal(serviceCalls.length, 1, "ONE banService.banUser per accepted modal submit");
  assert.equal(serviceCalls[0].communityId, cid, "the pending entry carried the community — no re-resolve");

  assert.equal(it.edits.length, 1);
  const c = String(it.edits[0].content);
  assert.match(c, new RegExp(`\\*\\*Banned:\\*\\* <@${SUB}> \\(\\*\\*B-1\\*\\*\\)`));
  assert.match(c, /\*\*Expires:\*\* <t:\d+:F> \(<t:\d+:R>\)/);
  assert.match(c, /\*\*Ban DM:\*\* sent\./);
  assert.deepEqual(it.edits[0].allowedMentions, { parse: [] });

  const row = db.findActiveBanRecord(cid, SUB);
  assert.ok(row);
  assert.ok(c.includes(`<t:${Math.floor(row.expires_at / 1000)}:F>`));
  assert.equal(modalOutbound.calls.map((x) => x.op).join(","), "sendDm,banMember");

  const banAudit = db.listAdminAudit(cid, { limit: 25 }).find((r) => r.action === "banLifecycle.ban");
  assert.ok(banAudit, "modal bans are audited at the staff layer too");
});

test("modal Duration blank falls back to the slash-provided duration intent (7d rode the token)", async () => {
  const cid = freshCid();
  modalOutbound = makeOutbound();
  const client = makeClient();
  const token = putEntry({ communityId: cid, reason: "raid wave", durationRaw: "7d" });
  const it = makeSubmit({ token, fields: { [MODAL_FIELD_REASON]: "raid wave" }, client });
  serviceCalls = [];

  await banModal.handleBanModal(it, RUN_CTX(client));

  assert.equal(serviceCalls.length, 1);
  const row = db.findActiveBanRecord(cid, SUB);
  assert.ok(row, "the slash duration made the ban EXPIRING");
  const span = row.expires_at - row.banned_at;
  assert.ok(
    span > 7 * 86_400_000 - 60_000 && span < 7 * 86_400_000 + 60_000,
    `expiry anchored at the actual ban (~7d): ${span}`,
  );
});

test("modal submit with an unknown/expired token answers the honest expiry refusal — never a half-read ban", async () => {
  modalOutbound = makeOutbound();
  serviceCalls = [];
  const it = makeSubmit({ token: "dead0000000000000000000000000beef", fields: { [MODAL_FIELD_REASON]: "x" } });
  await banModal.handleBanModal(it, RUN_CTX(makeClient()));
  assert.match(String(it.replies[0].content), /\*\*Modal expired:\*\*.*nothing was banned/s);
  assert.match(String(it.replies[0].content), /Open it again with `\/ban`/);
  assert.equal(serviceCalls.length, 0);
});

test("modal submit shape belt (non-modal interaction) answers the shipped NOT_ON_FLUXER", async () => {
  const it = makeSubmit({ token: "x", shapeOk: false });
  await banModal.handleBanModal(it, {});
  assert.equal(String(it.replies[0].content), commands.NOT_ON_FLUXER);
});

test("modal submit requires admin at SUBMIT time (permissions may change between open and submit)", async () => {
  const cid = freshCid();
  const token = putEntry({ communityId: cid });
  const it = makeSubmit({ token, staff: false, fields: { [MODAL_FIELD_REASON]: "x" } });
  serviceCalls = [];
  await banModal.handleBanModal(it, RUN_CTX(makeClient()));
  assert.equal(content(it.replies), MSG_DENIED);
  assert.equal(serviceCalls.length, 0);
  // The token survived the denial…
  assert.ok(banModal.takePendingBan(token), "a denied submit never burns the operator's form");
});

// ═══ pending-token store: one-shot + injectable TTL clock ═══════════════════

test("pending tokens are one-shot and expire at exactly the TTL under the injected clock", () => {
  banModal.clearPendingBans();
  let fake = 1_000_000;
  const filedAt = fake;
  banModal.setPendingClock(() => fake);
  try {
    const t1 = putEntry({ communityId: communityKey(EXTERNAL_GUILD) });
    assert.equal(banModal.pendingBanCount(), 1);
    assert.ok(banModal.takePendingBan(t1), "live token pops");
    assert.equal(banModal.takePendingBan(t1), null, "ONE shot — a consumed token never re-pops");

    // Two forms filed at the same injected instant…
    const t2 = putEntry({ communityId: communityKey(EXTERNAL_GUILD) });
    const t3 = putEntry({ communityId: communityKey(EXTERNAL_GUILD) });
    assert.equal(banModal.pendingBanCount(), 2);

    // …one ms INSIDE their shared TTL a submit still runs…
    fake = filedAt + banModal.BAN_MODAL_TTL_MS - 1;
    assert.ok(banModal.takePendingBan(t2), "one ms inside the TTL still lives");

    // …AT the TTL the entry is dead (expiresAt <= clock law) and the store
    // never keeps the corpse (take deletes before the expiry check).
    fake = filedAt + banModal.BAN_MODAL_TTL_MS;
    assert.equal(banModal.takePendingBan(t3), null, "at expiresAt the entry is DEAD (<= law)");
    assert.equal(banModal.takePendingBan("nope"), null, "unknown tokens read expired too");
    assert.equal(banModal.pendingBanCount(), 0, "expired entries never linger in the store");
  } finally {
    banModal.setPendingClock(null);
    banModal.clearPendingBans();
  }
});

// ═══ /bannotify — notice toggles (§6) ═══════════════════════════════════════

test("/bannotify status reads BOTH toggles in **Label:** value style with the defaults note (real read)", async () => {
  const cid = freshCid();
  const { ctx, replies } = makeCtx({ commandName: "bannotify", communityId: cid, sub: "status" });
  configEmbeds = [];

  await commands.handlers.bannotify(ctx, {});

  const c = content(replies);
  assert.match(c, /\*\*Ban DM:\*\* on — members get a DM before the ban runs\./);
  assert.match(c, /\*\*Welcome-back DM:\*\* on — exactly one DM per unban cycle \(auto-expiry or manual\)\./);
  assert.match(c, /\*\*Defaults:\*\* both notices ship \*\*on\*\*/);
  assert.equal(replies[0].sensitive, true);
  assert.equal(configEmbeds.length, 0, "the read arm never posts an embed");
});

test("/bannotify ban off writes via the settings seam AND lands audit + logConfigChange embed", async () => {
  const cid = freshCid();
  const { ctx, replies } = makeCtx({ commandName: "bannotify", communityId: cid, sub: "ban", options: { state: "off" } });
  configEmbeds = [];

  await commands.handlers.bannotify(ctx, {});

  // Real updateGuildSettings through the seam, asserted through the repo:
  assert.equal(db.getGuildSettings(cid).ban_dm, 0, "ban_dm flipped to 0 in guild_settings");
  assert.equal(db.getGuildSettings(cid).welcome_back_dm, 1, "the other toggle is untouched");

  // Real recordSlashAudit row (origin 'slash'), asserted through the repo:
  const audit = db
    .listAdminAudit(cid, { limit: 25 })
    .find((r) => r.action === "banLifecycle.ban_dm_set");
  assert.ok(audit, "the toggle mutation is audited");
  assert.equal(audit.origin, "slash");
  assert.equal(audit.actor_user_id, ADMIN);
  assert.equal(audit.target_id, EXTERNAL_GUILD);
  assert.deepEqual(JSON.parse(audit.details_json), { ban_dm: 0 });

  // /automodconfig-style embed through the logConfigChange module seam:
  assert.equal(configEmbeds.length, 1, "one config-change embed per toggle mutation");
  assert.equal(configEmbeds[0].guildId, EXTERNAL_GUILD);
  assert.equal(configEmbeds[0].opts.command, "/bannotify ban");
  assert.deepEqual(configEmbeds[0].opts.changes, ["Ban DM: off"]);

  assert.match(content(replies), /\*\*Ban DM:\*\* now \*\*off\*\*\./);
  assert.match(content(replies), /Bans skip the DM — the ban itself is unchanged\./);
});

test("/bannotify welcome on mirrors the ban arm (welcome_back_dm + banLifecycle.welcome_dm_set)", async () => {
  const cid = freshCid();
  db.updateGuildSettings(cid, { welcome_back_dm: 0 }); // start from off
  const { ctx, replies } = makeCtx({ commandName: "bannotify", communityId: cid, sub: "welcome", options: { state: "on" } });
  configEmbeds = [];

  await commands.handlers.bannotify(ctx, {});

  assert.equal(db.getGuildSettings(cid).welcome_back_dm, 1);
  const audit = db.listAdminAudit(cid, { limit: 25 }).find((r) => r.action === "banLifecycle.welcome_dm_set");
  assert.ok(audit);
  assert.deepEqual(JSON.parse(audit.details_json), { welcome_back_dm: 1 });
  assert.deepEqual(configEmbeds[0].opts.changes, ["Welcome-back DM: on"]);
  assert.match(content(replies), /\*\*Welcome-back DM:\*\* now \*\*on\*\*\./);
  assert.match(content(replies), /exactly one welcome DM/);
});

test("/bannotify Fluxer-shaped context: NOT_ON_FLUXER, no settings write, no audit, no embed", async () => {
  const cid = freshCid();
  const { ctx, replies } = makeCtx({
    commandName: "bannotify",
    communityId: cid,
    sub: "ban",
    options: { state: "off" },
    noRaw: true,
  });
  configEmbeds = [];

  await commands.handlers.bannotify(ctx, {});

  assert.equal(content(replies), commands.NOT_ON_FLUXER);
  assert.equal(db.getGuildSettings(cid).ban_dm, 1, "NOT_ON_FLUXER arm mutates NOTHING");
  assert.equal(db.listAdminAudit(cid, { limit: 25 }).length, 0);
  assert.equal(configEmbeds.length, 0);
});

test("/bannotify non-admin is denied before the subcommand dispatch", async () => {
  const cid = freshCid();
  const { ctx, replies } = makeCtx({
    commandName: "bannotify",
    communityId: cid,
    sub: "ban",
    options: { state: "off" },
    manageGuild: false,
  });
  await commands.handlers.bannotify(ctx, {});
  assert.equal(content(replies), MSG_DENIED);
  assert.equal(db.getGuildSettings(cid).ban_dm, 1);
});

test("/bannotify unknown subcommand answers the automodconfig fall-through copy", async () => {
  const cid = freshCid();
  const { ctx, replies } = makeCtx({ commandName: "bannotify", communityId: cid, sub: "banish" });
  await commands.handlers.bannotify(ctx, {});
  assert.match(content(replies), /Unknown subcommand: `banish`/);
});

// ═══ exported seams ═════════════════════════════════════════════════════════

test("settings seam: {ok:true}/{ok:false} values, never throws (automod/settings.js shape)", () => {
  const cid = freshCid();
  const read = commands.settings.readNoticeSettings(cid);
  assert.equal(read.ok, true);
  assert.deepEqual(read.settings, { banDm: true, welcomeBackDm: true }, "defaults are ON");

  assert.deepEqual(commands.settings.setNoticeSetting(cid, "ban", false), {
    ok: true,
    column: "ban_dm",
    enabled: false,
  });
  assert.equal(commands.settings.readNoticeSettings(cid).settings.banDm, false);

  const bad = commands.settings.setNoticeSetting(cid, "modmail", true);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown notice toggle `modmail`/);
});

test("formatBanResult + banNoticeLines translate service warnings into **Label:** staff-side notices (never apologies)", () => {
  const result = {
    banNumber: "B-7",
    expiresAtMs: 1_761_984_000_000,
    banDmSent: false,
    banDmSkipped: false,
    warnings: ["Ban DM not delivered: Cannot send messages", "Record stamps lagged"],
  };
  const text = commands.formatBanResult(result, SUB);
  assert.ok(text.startsWith(`**Banned:** <@${SUB}> (**B-7**).`), text);
  assert.ok(text.includes("**Expires:** <t:1761984000:F> (<t:1761984000:R>)"), text);
  assert.ok(text.includes("**Ban DM:** not delivered — Cannot send messages"), text);
  assert.ok(text.includes("**Notice:** Record stamps lagged"), text);
  assert.doesNotMatch(text, /sorry|apolog/i);

  const skipped = commands.formatBanResult(
    { banNumber: "B-8", expiresAtMs: null, banDmSent: false, banDmSkipped: true, warnings: [] },
    SUB,
  );
  assert.ok(skipped.includes("**Duration:** permanent — no auto-expiry; staff lift it manually."), skipped);
  assert.ok(skipped.includes("**Ban DM:** off for this server — `/bannotify ban on` turns it back on."), skipped);
});
