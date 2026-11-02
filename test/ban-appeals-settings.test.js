/**
 * #773 §1/§5: /banappeals SETTINGS SURFACE unit suite
 * (test/ban-appeals-settings.test.js).
 *
 * Two layers, one file — the toggle's whole shipped surface:
 *  settings.js (service): default-ON semantics (migration 075 `DEFAULT 1` +
 *  the `Number(x ?? 1) !== 0` reader idiom), the write path through the REAL
 *  updateGuildSettings (asserted through the repository), and the audited
 *  mutation — exactly ONE recordSlashAudit row `banAppeals.toggle_set` (real
 *  writer, asserted via db.listAdminAudit — the ban-lifecycle-commands
 *  idiom) plus exactly one /automodconfig-style logConfigChange embed
 *  (module seam), which is best-effort and NEVER flips a committed toggle.
 *  commands.js (/banappeals enable|disable|status): hand-built CommandContext
 *  doubles; the requireAdminFromContext gate denies FIRST (before the Fluxer
 *  gate and before dispatch), the Fluxer arm answers NOT_ON_FLUXER
 *  byte-identical to the automod/banLifecycle sentence, status READS without
 *  writing, and all copy follows the `**Label:** value` law (#471 H2-13).
 *
 * Stub discipline (ban-lifecycle-commands law): settings.js destructures
 * logConfigChange at REQUIRE time — the stub is installed on the freshly
 * loaded auditLog module object BEFORE settings/commands are required.
 * recordSlashAudit is NOT stubbed: real fail-safe rows in the temp DB.
 *
 * Header contract: loadDb() above every src/ require.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

// ── module seam installed BEFORE settings/commands load (require-time capture) ─
// settings.js destructures logConfigChange at REQUIRE time, so the captured
// value must be a DYNAMIC DISPATCHER — tests then swap `embedImpl` per case
// and the already-destructured reference keeps following it (the same
// stub-at-the-module-object law the ban-lifecycle-commands suite runs).
const auditLogMod = require("../src/features/logs/auditLog");
const origLogConfigChange = auditLogMod.logConfigChange;
let configEmbeds = [];
let embedImpl = async (outbound, guildId, opts) => {
  configEmbeds.push({ outbound, guildId, opts });
  return { ok: true };
};
auditLogMod.logConfigChange = (...args) => embedImpl(...args);

const settings = require("../src/features/banAppeals/settings");
const commands = require("../src/features/banAppeals/commands");
const { BANAPPEALS_COMMAND, NOT_ON_FLUXER } = require("../src/features/banAppeals/constants");
const { NOT_ON_FLUXER: AUTOMOD_NOT_ON_FLUXER } = require("../src/features/automod/constants");
const banLifecycleCommands = require("../src/features/banLifecycle/commands");
const { MSG_DENIED } = require("../src/core/theme");

after(() => {
  auditLogMod.logConfigChange = origLogConfigChange;
  cleanup();
});

const { PermissionFlagsBits } = require("discord.js");
const MANAGE_GUILD = String(PermissionFlagsBits.ManageGuild);

const GUILD = "978500000000000001";
const ADMIN = "878500000000000012";

let seq = 0;
const freshCid = () =>
  communityKey(`9785000000000${String(++seq).padStart(4, "0")}`);

const toggleRows = (cid) =>
  db.listAdminAudit(cid, { limit: 50 }).filter((r) => r.action === "banAppeals.toggle_set");

/** Whole-DB toggle-audit count (for the failed-write zero-audit proof). */
const globalToggleCount = () =>
  db.db
    .prepare("SELECT COUNT(*) AS c FROM admin_audit WHERE action='banAppeals.toggle_set'")
    .get().c;

/** CommandContext double (automod-commands / ban-lifecycle makeCtx shape). */
function makeCtx({
  communityId,
  sub = "status",
  manageGuild = true,
  noRaw = false,
  externalGuildId = GUILD,
  outbound = { name: "ctx-outbound" },
}) {
  const replies = [];
  const ctx = {
    platform: "discord",
    instanceKey: "discord",
    communityId,
    externalGuildId,
    channelId: "10",
    userId: ADMIN,
    user: { id: ADMIN, username: "admin" },
    commandName: BANAPPEALS_COMMAND,
    subcommandGroup: null,
    subcommand: sub,
    options: { getString: () => null },
    channelPermissions: manageGuild ? MANAGE_GUILD : "0",
    memberRoleIds: [],
    guildOwner: false,
    deferred: false,
    replied: false,
    outbound,
    // noRaw:true models the Fluxer dispatcher — rawInteraction ABSENT,
    // never a null placeholder (the gate reads presence).
    rawInteraction: noRaw
      ? undefined
      : { guild: { id: externalGuildId, name: "Test Guild" }, client: {} },
    reply: async (payload) => {
      replies.push(payload);
      ctx.replied = true;
    },
    defer: async () => {
      ctx.deferred = true;
    },
  };
  return { ctx, replies };
}

const content = (replies, i = 0) => String(replies[i]?.content ?? "");

const handle = commands.handlers[BANAPPEALS_COMMAND];

// ═══ service layer: default-ON semantics + the write belt ════════════════════

test("readSettings: appeals ship ON — a fresh community's row carries ban_appeals=1 and reads enabled", () => {
  const cid = freshCid();
  const read = settings.readSettings(cid);
  assert.equal(read.ok, true);
  assert.deepEqual(read.settings, { appealsEnabled: true }, "defaults are ON (issue §1, migration 075 DEFAULT 1)");
  assert.equal(db.getGuildSettings(cid).ban_appeals, 1, "the schema default is the truth (NOT NULL DEFAULT 1 — no NULL can hide here)");

  assert.equal(settings.setEnabled(cid, false).ok, true);
  assert.equal(settings.readSettings(cid).settings.appealsEnabled, false, "explicit 0 → OFF");
  assert.equal(settings.setEnabled(cid, true).ok, true);
  assert.equal(settings.readSettings(cid).settings.appealsEnabled, true, "explicit 1 → ON");
});

test("readSettings NEVER throws: an invalid community key answers the specific read failure (rule 6)", () => {
  const bad = settings.readSettings(0);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Could not read the ban-appeals setting: /);
  assert.doesNotMatch(bad.error, /unknown error/i);
});

test("setEnabled: REAL updateGuildSettings writes land in guild_settings; non-boolean is refused with the teaching sentence", () => {
  const cid = freshCid();
  assert.deepEqual(settings.setEnabled(cid, false), { ok: true, column: "ban_appeals", enabled: false });
  assert.equal(db.getGuildSettings(cid).ban_appeals, 0);
  assert.deepEqual(settings.setEnabled(cid, true), { ok: true, column: "ban_appeals", enabled: true });
  assert.equal(db.getGuildSettings(cid).ban_appeals, 1, "strict booleans write exact 0/1 through the repository belt");

  for (const junk of ["off", 1, 0, null, undefined]) {
    const res = settings.setEnabled(cid, junk);
    assert.equal(res.ok, false, JSON.stringify(junk));
    assert.match(res.error, /Choose `enable` or `disable` for ban appeals/);
  }
  assert.equal(db.getGuildSettings(cid).ban_appeals, 1, "a refused strictness gate never moved the toggle");

  // Write failure (invalid community) surfaces the specific save sentence:
  const fail = settings.setEnabled(0, true);
  assert.equal(fail.ok, false);
  assert.match(fail.error, /Could not save the ban-appeals setting \(ban_appeals\): /);
});

test("module identity: the audit action + column names later tasks and docs match on", () => {
  assert.equal(settings.AUDIT_ACTION_TOGGLE_SET, "banAppeals.toggle_set");
  assert.equal(settings.SETTING_COLUMN, "ban_appeals");
  assert.equal(settings.LOG_PREFIX, "[appeals]");
});

// ═══ the audited mutation: ONE admin_audit row + ONE embed per toggle ════════

test("toggleAppeals(enable): write + exactly ONE banAppeals.toggle_set row + one logConfigChange embed with the /automodconfig args", async () => {
  const cid = freshCid();
  settings.setEnabled(cid, false); // start from OFF so enable is a real mutation
  configEmbeds = [];
  const actor = { id: ADMIN, username: "admin" };

  const res = await settings.toggleAppeals({
    communityId: cid,
    guildId: GUILD,
    enabled: true,
    actorUserId: ADMIN,
    outbound: { marker: true },
    actor,
  });

  assert.deepEqual(res, { ok: true, column: "ban_appeals", enabled: true });
  assert.equal(db.getGuildSettings(cid).ban_appeals, 1);

  const rows = toggleRows(cid);
  assert.equal(rows.length, 1, "exactly ONE slash audit row per mutation — never a second writer");
  assert.equal(rows[0].origin, "slash");
  assert.equal(rows[0].actor_user_id, ADMIN);
  assert.equal(rows[0].target_id, GUILD, "the Discord guild snowflake is the audit target");
  assert.deepEqual(JSON.parse(rows[0].details_json), { ban_appeals: 1 });

  assert.equal(configEmbeds.length, 1, "one config-change embed per toggle mutation");
  assert.equal(configEmbeds[0].outbound.marker, true, "the caller's outbound rides to the audit stream");
  assert.equal(configEmbeds[0].guildId, GUILD);
  assert.deepEqual(configEmbeds[0].opts, {
    title: "Ban appeals changed",
    command: "/banappeals enable",
    actor,
    changes: ["Ban appeals: on"],
  });
});

test("toggleAppeals(disable) mirrors the enable arm: ban_appeals=0, one audited row, 'off' embed", async () => {
  const cid = freshCid();
  configEmbeds = [];

  const res = await settings.toggleAppeals({
    communityId: cid,
    guildId: GUILD,
    enabled: false,
    actorUserId: ADMIN,
    outbound: {},
    actor: { id: ADMIN },
  });

  assert.equal(res.ok, true);
  assert.equal(db.getGuildSettings(cid).ban_appeals, 0);
  assert.equal(toggleRows(cid).length, 1);
  assert.deepEqual(JSON.parse(toggleRows(cid)[0].details_json), { ban_appeals: 0 });
  assert.equal(configEmbeds[0].opts.command, "/banappeals disable");
  assert.deepEqual(configEmbeds[0].opts.changes, ["Ban appeals: off"]);
});

test("toggleAppeals belt layers: a failed write audits NOTHING; the embed is best-effort and never flips a committed toggle", async () => {
  // (a) write failure → the write's error rides, ZERO audit surface:
  configEmbeds = [];
  const auditsBefore = globalToggleCount();
  const failed = await settings.toggleAppeals({
    communityId: 0, // assertCommunityId explodes inside the write belt
    guildId: GUILD,
    enabled: true,
    actorUserId: ADMIN,
    outbound: {},
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Could not save the ban-appeals setting \(ban_appeals\): /);
  assert.equal(globalToggleCount(), auditsBefore, "a failed write lands NO audit row");
  assert.equal(configEmbeds.length, 0, "nothing was changed — nothing is announced");

  // (b) audit-stream hiccup after a COMMITTED write → mutation still ok:true
  // (the admin_audit row is the record; the embed is best-effort — §8.1).
  // The dispatcher seam keeps the require-time-destructured reference live:
  const cid = freshCid();
  configEmbeds = [];
  embedImpl = async () => {
    throw new Error("audit channel deleted");
  };
  try {
    const res = await settings.toggleAppeals({
      communityId: cid,
      guildId: GUILD,
      enabled: false,
      actorUserId: ADMIN,
      outbound: {},
      actor: { id: ADMIN },
    });
    assert.equal(res.ok, true, "a stream hiccup never fails the committed toggle");
    assert.equal(db.getGuildSettings(cid).ban_appeals, 0);
    assert.equal(toggleRows(cid).length, 1, "the admin_audit row STILL landed (fail-safe writer)");
  } finally {
    embedImpl = async (outbound, guildId, opts) => {
      configEmbeds.push({ outbound, guildId, opts });
      return { ok: true };
    };
  }

  // (c) no outbound at all → embed skipped, mutation unaffected:
  const cid2 = freshCid();
  const res2 = await settings.toggleAppeals({
    communityId: cid2,
    guildId: GUILD,
    enabled: true,
    actorUserId: ADMIN,
  });
  assert.equal(res2.ok, true);
  assert.equal(toggleRows(cid2).length, 1);
});

// ═══ /banappeals arms: gate → NOT_ON_FLUXER → dispatch ═══════════════════════

test("non-admin is denied with the standard MSG_DENIED BEFORE dispatch — and the gate outranks the Fluxer gate", async () => {
  const cid = freshCid();
  configEmbeds = [];
  const { ctx, replies } = makeCtx({ communityId: cid, sub: "disable", manageGuild: false });
  await handle(ctx, {});
  assert.equal(content(replies), MSG_DENIED);
  assert.equal(replies.length, 1, "denial replies exactly once");
  assert.equal(replies[0].sensitive, true, "denials are ephemeral");

  // Gate FIRST even on a Fluxer-shaped context (deny beats 'not here yet'):
  const p = makeCtx({ communityId: cid, sub: "disable", manageGuild: false, noRaw: true });
  await handle(p.ctx, {});
  assert.equal(content(p.replies), MSG_DENIED);

  assert.equal(db.getGuildSettings(cid).ban_appeals, 1, "a denial mutates NOTHING");
  assert.equal(toggleRows(cid).length, 0);
  assert.equal(configEmbeds.length, 0);
});

test("Fluxer-shaped context answers the shipped NOT_ON_FLUXER BYTE-IDENTICAL to the sibling features, zero mutation", async () => {
  const cid = freshCid();
  configEmbeds = [];
  const { ctx, replies } = makeCtx({ communityId: cid, sub: "disable", noRaw: true });
  await handle(ctx, {});

  assert.equal(content(replies), NOT_ON_FLUXER);
  assert.equal(NOT_ON_FLUXER, AUTOMOD_NOT_ON_FLUXER, "one shipped refusal sentence across features");
  assert.equal(NOT_ON_FLUXER, banLifecycleCommands.NOT_ON_FLUXER);
  assert.equal(replies[0].sensitive, true);
  assert.equal(db.getGuildSettings(cid).ban_appeals, 1, "the NOT_ON_FLUXER arm mutates NOTHING");
  assert.equal(toggleRows(cid).length, 0);
  assert.equal(configEmbeds.length, 0);
});

test("/banappeals status reads the DEFAULT-ON state in **Label:** value style — without writing anything", async () => {
  const cid = freshCid();
  configEmbeds = [];
  const auditsBefore = db.listAdminAudit(cid, { limit: 50 }).length;
  const { ctx, replies } = makeCtx({ communityId: cid, sub: "status" });
  await handle(ctx, {});

  const c = content(replies);
  assert.match(c, /\*\*Ban appeals:\*\* on — tracked bans carry an Appeal button in the ban DM\./);
  assert.match(c, /\*\*One per ban:\*\* every tracked ban cycle gets exactly one appeal/);
  assert.match(c, /\*\*Defaults:\*\* appeals ship \*\*on\*\* \(non-destructive\)/);
  assert.match(c, /tickets already in flight keep ferrying until staff decide them/);
  assert.equal(replies[0].sensitive, true);

  // READ law: no writes, no audit, no embed:
  assert.equal(db.listAdminAudit(cid, { limit: 50 }).length, auditsBefore, "status writes NO audit row");
  assert.equal(db.getGuildSettings(cid).ban_appeals, 1, "status leaves the toggle untouched");
  assert.equal(configEmbeds.length, 0, "the read arm never posts an embed");
});

test("/banappeals status after a disable flips BOTH state sentences (off / do-not-carry) — still read-only", async () => {
  const cid = freshCid();
  settings.setEnabled(cid, false);
  configEmbeds = [];
  const { ctx, replies } = makeCtx({ communityId: cid, sub: "status" });
  await handle(ctx, {});
  const c = content(replies);
  assert.match(c, /\*\*Ban appeals:\*\* off — tracked bans do not carry an Appeal button in the ban DM\./);
  assert.ok(c.includes("**on** (non-destructive)"), "the defaults note stays true in both states");
  assert.equal(configEmbeds.length, 0);
  assert.equal(db.getGuildSettings(cid).ban_appeals, 0, "the OFF state survived a read unchanged");
});

test("/banappeals disable: one audited mutation, real write, embed + reply with the consequence line", async () => {
  const cid = freshCid();
  configEmbeds = [];
  const { ctx, replies } = makeCtx({ communityId: cid, sub: "disable" });
  await handle(ctx, {});

  assert.equal(db.getGuildSettings(cid).ban_appeals, 0);
  const rows = toggleRows(cid);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].details_json), { ban_appeals: 0 });
  assert.equal(configEmbeds.length, 1);
  assert.equal(configEmbeds[0].guildId, GUILD, "ctx.externalGuildId routes the audit embed");
  assert.equal(configEmbeds[0].opts.command, "/banappeals disable");

  const c = content(replies);
  assert.match(c, /^\*\*Ban appeals:\*\* now \*\*off\*\*\./);
  assert.match(c, /Ban DMs stop carrying the Appeal button; appeal tickets already in flight keep ferrying\./);
  assert.equal(replies[0].sensitive, true);
});

test("/banappeals enable mirrors the arm and names the intake consequence", async () => {
  const cid = freshCid();
  settings.setEnabled(cid, false);
  configEmbeds = [];
  const { ctx, replies } = makeCtx({ communityId: cid, sub: "enable" });
  await handle(ctx, {});

  assert.equal(db.getGuildSettings(cid).ban_appeals, 1);
  assert.equal(toggleRows(cid).length, 1);
  assert.equal(configEmbeds[0].opts.command, "/banappeals enable");
  assert.deepEqual(configEmbeds[0].opts.changes, ["Ban appeals: on"]);
  assert.match(content(replies), /^\*\*Ban appeals:\*\* now \*\*on\*\*\./);
  assert.match(content(replies), /Every tracked ban DM carries the Appeal button; presses open a staff appeal ticket\./);
});

test("settings-service failure surfaces its SPECIFIC save sentence ephemerally (never MSG_GENERIC_ERROR)", async () => {
  configEmbeds = [];
  const { ctx, replies } = makeCtx({ communityId: 0, sub: "disable" });
  await handle(ctx, {});
  assert.match(content(replies), /Could not save the ban-appeals setting \(ban_appeals\): /);
  assert.equal(replies[0].sensitive, true);
  assert.equal(configEmbeds.length, 0);
});

test("unknown subcommand answers the /bannotify fall-through copy with zero mutation", async () => {
  const cid = freshCid();
  const { ctx, replies } = makeCtx({ communityId: cid, sub: "banish" });
  await handle(ctx, {});
  assert.equal(content(replies), "Unknown subcommand: `banish`");
  assert.equal(replies[0].sensitive, true);
  assert.equal(toggleRows(cid).length, 0);
});

test("ALL /banappeals copy follows the **Label:** value law — the retired Label: **value** style never appears", async () => {
  const cid = freshCid();
  const bodies = [];
  for (const spec of [
    { sub: "status" },
    { sub: "disable" },
    { sub: "enable" },
    { sub: "status" },
    { sub: "banish" },
    { sub: "status", manageGuild: false },
    { sub: "disable", noRaw: true },
  ]) {
    const { ctx, replies } = makeCtx({ communityId: cid, ...spec });
    await handle(ctx, {});
    bodies.push(content(replies));
  }
  for (const c of bodies) {
    assert.ok(c.length > 0);
    assert.doesNotMatch(c, /Ban appeals: \*\*/, "retired style is banned on every arm");
    if (/\*\*Ban appeals:/.test(c)) {
      assert.match(c, /\*\*Ban appeals:\*\* /, "the declared style carries label+colon INSIDE the bold");
    }
  }
});

// ═══ command surface (builder shape the picker + registry tests consume) ══════

test("builder: /banappeals carries ManageGuild picker + exactly the enable|disable|status subcommands", () => {
  const json = commands.commands[0].toJSON();
  assert.equal(json.name, "banappeals");
  assert.equal(BANAPPEALS_COMMAND, "banappeals");
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.ManageGuild),
    "admin picker posture — byte-identical to /ban + /bannotify");
  assert.deepEqual(json.options.map((o) => o.name), ["enable", "disable", "status"]);
  assert.deepEqual(commands.handlerApi, { banappeals: "context" });
  assert.equal(typeof handle, "function");
});
