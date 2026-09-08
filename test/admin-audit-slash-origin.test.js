/**
 * admin_audit trail for BOT-side mutation paths (web-admin subtask 10,
 * roadmap §8.5). Two layers:
 *
 *  1. UNIT — src/core/auditTrail.js helper contract: fail-safe (a throwing
 *     insert is swallowed and logged, never breaks the command), origin
 *     normalization ('slash' default, 'system' for jobs), actor rules, and
 *     credential redaction.
 *  2. INTEGRATION — real router + real SQLite: representative slash paths
 *     (warn add/void, grantxp, staff role add/remove, setcommandchannel,
 *     note add, ticket create/claim/close/archive) each land one
 *     origin='slash' admin_audit row with the right actor/target/details,
 *     and the warn-expiry ticker writes origin='system'.
 */
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// Bind src modules to a temp SQLite BEFORE requiring anything from src/
// (same discipline as the integration harness; never touch the repo DB).
const { loadDb } = require("./helpers/env");
const unitDb = loadDb().api;

// Required after loadDb so the helper's default deps bind to temp SQLite.
const {
  recordSlashAudit,
  recordSystemAudit,
  redactSensitive,
} = require("../src/core/auditTrail");

const { createIntegrationEnv } = require("./helpers/harness");
const { IDS } = require("./helpers/fixtures");
const { assertReplyContains } = require("./helpers/assert");

function makeLogger() {
  const logs = [];
  return {
    logs,
    warn: (...args) => logs.push(args.join(" ")),
    error: (...args) => logs.push(args.join(" ")),
  };
}

function detailsOf(row) {
  return row.details_json == null ? null : JSON.parse(row.details_json);
}

function findRow(rows, action) {
  return rows.find((r) => r.action === action);
}

describe("auditTrail helper contract (unit)", () => {
  it("defaults to origin 'slash' and derives guild+actor from the interaction", () => {
    const seen = [];
    const fakeRow = { id: 7 };
    const result = recordSlashAudit(
      {
        interaction: { guildId: IDS.guild, user: { id: IDS.admin } },
        action: "test.action",
        targetType: "user",
        targetId: IDS.member,
        details: { ok: 1 },
      },
      {
        insertAdminAudit: (opts) => {
          seen.push(opts);
          return fakeRow;
        },
        logger: makeLogger(),
      }
    );

    assert.equal(result, fakeRow);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].origin, "slash");
    assert.equal(seen[0].guildId, IDS.guild);
    assert.equal(seen[0].actorUserId, IDS.admin);
    assert.equal(seen[0].action, "test.action");
    assert.equal(seen[0].targetType, "user");
    assert.equal(seen[0].targetId, IDS.member);
  });

  it("swallows a throwing insert and logs — an audit failure never breaks a command", () => {
    const logger = makeLogger();
    const result = recordSlashAudit(
      {
        guildId: IDS.guild,
        actorUserId: IDS.admin,
        action: "test.action",
      },
      {
        insertAdminAudit: () => {
          throw new Error("SQLITE_BUSY");
        },
        logger,
      }
    );

    assert.equal(result, null);
    assert.equal(logger.logs.length, 1);
    assert.match(logger.logs[0], /insert failed/);
    assert.match(logger.logs[0], /SQLITE_BUSY/);
  });

  it("swallows failures from origin normalization too", () => {
    const logger = makeLogger();
    let inserts = 0;
    const result = recordSlashAudit(
      { guildId: IDS.guild, actorUserId: IDS.admin, action: "test.action" },
      {
        insertAdminAudit: () => {
          inserts += 1;
          return {};
        },
        normalizeAuditOrigin: () => {
          throw new Error("boom");
        },
        logger,
      }
    );

    assert.equal(result, null);
    assert.equal(inserts, 0);
    assert.equal(logger.logs.length, 1);
  });

  it("rejects an unknown origin before inserting", () => {
    const logger = makeLogger();
    let inserts = 0;
    const result = recordSlashAudit(
      {
        guildId: IDS.guild,
        actorUserId: IDS.admin,
        action: "test.action",
        origin: "sms",
      },
      {
        insertAdminAudit: () => {
          inserts += 1;
          return {};
        },
        logger,
      }
    );

    assert.equal(result, null);
    assert.equal(inserts, 0);
  });

  it("skips 'slash' rows without an actor but allows 'system' rows to omit it", () => {
    const logger = makeLogger();
    const seen = [];
    const opts = {
      insertAdminAudit: (o) => {
        seen.push(o);
        return {};
      },
      logger,
    };

    // No actor + default origin 'slash' → skipped (viewer must see attribution).
    assert.equal(
      recordSlashAudit({ guildId: IDS.guild, action: "test.action" }, opts),
      null
    );
    assert.equal(seen.length, 0);

    // Ticker rows legitimately have no human behind them.
    assert.ok(
      recordSystemAudit({ guildId: IDS.guild, action: "test.action" }, opts)
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].origin, "system");
    assert.equal(seen[0].actorUserId, null);
  });

  it("skips entries without an action or guild", () => {
    const logger = makeLogger();
    let inserts = 0;
    const opts = {
      insertAdminAudit: () => {
        inserts += 1;
        return {};
      },
      logger,
    };

    assert.equal(
      recordSlashAudit({ guildId: IDS.guild, actorUserId: IDS.admin }, opts),
      null
    );
    assert.equal(
      recordSlashAudit({ actorUserId: IDS.admin, action: "test.action" }, opts),
      null
    );
    assert.equal(inserts, 0);
  });

  it("redacts credential-like detail keys recursively without mutating input", () => {
    const input = {
      keep: 1,
      bot_token: "nope",
      nested: {
        clientSecret: "nope",
        keep: 2,
        list: [{ password: "nope", cookie: "nope", ok: 3 }],
      },
    };
    const out = redactSensitive(input);

    assert.deepEqual(out, { keep: 1, nested: { keep: 2, list: [{ ok: 3 }] } });
    // Original object untouched (handlers may keep using their details object).
    assert.ok("bot_token" in input);
    assert.ok("clientSecret" in input.nested);
  });

  it("redaction collapses cycles instead of looping forever", () => {
    const cyclic = { keep: 1 };
    cyclic.self = cyclic;
    const out = redactSensitive(cyclic);
    assert.equal(out.keep, 1);
    assert.equal(out.self, null);
  });

  it("default deps insert a real row into SQLite (fail-open round-trip)", () => {
    const row = recordSlashAudit({
      guildId: "guild-unit-audit-roundtrip",
      actorUserId: IDS.admin,
      action: "test.roundtrip",
      targetType: "user",
      targetId: IDS.member,
      details: { bot_token: "nope", kept: true },
    });

    assert.ok(row && row.id);
    assert.equal(row.origin, "slash");
    const details = JSON.parse(row.details_json);
    assert.equal(details.kept, true);
    assert.equal(details.bot_token, undefined);

    const listed = unitDb.listAdminAudit("guild-unit-audit-roundtrip");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].actor_user_id, IDS.admin);
  });
});

describe("admin_audit rows from slash mutations (integration)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
  });

  function auditRows() {
    return env.db.listAdminAudit(env.guild.id, { limit: 100 });
  }

  it("/warn add + void each write one slash-origin row", async () => {
    const add = await env.runCommand({
      commandName: "warn",
      subcommand: "add",
      admin: true,
      options: {
        user: env.users.memberUser,
        reason: "Audit trail spam",
        silent: true,
      },
    });
    assertReplyContains(add, /W-1|issued/i);

    let rows = auditRows();
    const addRow = findRow(rows, "warnings.add");
    assert.ok(addRow, "warnings.add audit row expected");
    assert.equal(addRow.origin, "slash");
    assert.equal(addRow.actor_user_id, IDS.admin);
    assert.equal(addRow.target_type, "user");
    assert.equal(addRow.target_id, IDS.member);
    const addDetails = detailsOf(addRow);
    assert.equal(addDetails.reason, "Audit trail spam");

    const voided = await env.runCommand({
      commandName: "warn",
      subcommand: "void",
      admin: true,
      options: { id: addDetails.warning_number, reason: "Appeal granted" },
    });
    assertReplyContains(voided, /voided|W-/i);

    rows = auditRows();
    const voidRow = findRow(rows, "warnings.void");
    assert.ok(voidRow, "warnings.void audit row expected");
    assert.equal(voidRow.origin, "slash");
    assert.equal(voidRow.actor_user_id, IDS.admin);
    assert.equal(voidRow.target_type, "warning");
    assert.equal(voidRow.target_id, String(addDetails.warning_id));
    assert.equal(detailsOf(voidRow).void_reason, "Appeal granted");
  });

  it("/grantxp writes xp.grant with before/after XP", async () => {
    await env.runCommand({
      commandName: "grantxp",
      admin: true,
      options: { user: env.users.memberUser, amount: 250, reason: "Audit bonus" },
    });

    const row = findRow(auditRows(), "xp.grant");
    assert.ok(row, "xp.grant audit row expected");
    assert.equal(row.origin, "slash");
    assert.equal(row.actor_user_id, IDS.admin);
    assert.equal(row.target_type, "user");
    assert.equal(row.target_id, IDS.member);
    const details = detailsOf(row);
    assert.equal(details.amount, 250);
    assert.equal(details.after_xp - details.before_xp, 250);
    assert.equal(details.reason, "Audit bonus");
  });

  it("/staff role add + remove write role rows with level before/after", async () => {
    const staffRole = { id: IDS.roleExempt, name: "Staff" };

    await env.runCommand({
      commandName: "staff",
      subcommandGroup: "role",
      subcommand: "add",
      admin: true,
      options: { role: staffRole, level: "junior" },
    });

    let row = findRow(auditRows(), "staff.role_add");
    assert.ok(row, "staff.role_add audit row expected");
    assert.equal(row.origin, "slash");
    assert.equal(row.actor_user_id, IDS.admin);
    assert.equal(row.target_type, "role");
    assert.equal(row.target_id, IDS.roleExempt);
    assert.equal(detailsOf(row).level, "junior");
    assert.equal(detailsOf(row).previous_level, null);

    await env.runCommand({
      commandName: "staff",
      subcommandGroup: "role",
      subcommand: "remove",
      admin: true,
      options: { role: staffRole },
    });

    row = findRow(auditRows(), "staff.role_remove");
    assert.ok(row, "staff.role_remove audit row expected");
    assert.equal(row.origin, "slash");
    assert.equal(row.target_type, "role");
    assert.equal(row.target_id, IDS.roleExempt);
    assert.equal(detailsOf(row).previous_level, "junior");
  });

  it("/setcommandchannel add writes a channel row", async () => {
    const ch = env.channels.cmds;
    await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "add",
      admin: true,
      options: { channel: ch },
    });

    const row = findRow(auditRows(), "command_channels.add");
    assert.ok(row, "command_channels.add audit row expected");
    assert.equal(row.origin, "slash");
    assert.equal(row.actor_user_id, IDS.admin);
    assert.equal(row.target_type, "channel");
    assert.equal(row.target_id, ch.id);

    // Reset the allow-list so later tests' non-admin commands stay allowed
    // (an empty allow-list means "everywhere"); also covers the remove verb.
    await env.runCommand({
      commandName: "setcommandchannel",
      subcommand: "remove",
      admin: true,
      options: { channel: ch },
    });
    assert.equal(env.db.listAllowedCommandChannels(env.guild.id).length, 0);
    assert.ok(findRow(auditRows(), "command_channels.remove"));
  });

  it("/note add writes a note row with truncated content", async () => {
    await env.runCommand({
      commandName: "note",
      subcommand: "add",
      admin: true,
      options: {
        user: env.users.memberUser,
        content: "Audited staff note content",
      },
    });

    const row = findRow(auditRows(), "notes.add");
    assert.ok(row, "notes.add audit row expected");
    assert.equal(row.origin, "slash");
    assert.equal(row.actor_user_id, IDS.admin);
    assert.equal(row.target_type, "note");
    const details = detailsOf(row);
    assert.equal(details.subject_user_id, IDS.member);
    assert.equal(details.content, "Audited staff note content");
  });

  it("/ticket create → claim → close → archive each write slash rows", async () => {
    env.db.updateGuildSettings(env.guild.id, { ticket_rate_limit_minutes: 0 });

    const create = await env.runCommand({
      commandName: "ticket",
      subcommand: "create",
      admin: false,
      user: env.users.memberUser,
      options: { reason: "Audit trail ticket" },
    });
    assertReplyContains(create, /Ticket|opened/i);

    const open = env.db.listOpenTickets(env.guild.id, {
      userId: IDS.member,
      limit: 5,
    });
    const ticket = open.find((t) => t.reason === "Audit trail ticket");
    assert.ok(ticket, "created ticket expected");

    let rows = auditRows();
    const createRow = findRow(rows, "tickets.create");
    assert.ok(createRow, "tickets.create audit row expected");
    assert.equal(createRow.origin, "slash");
    // Self-create: the MEMBER is the actor, not an admin.
    assert.equal(createRow.actor_user_id, IDS.member);
    assert.equal(createRow.target_type, "ticket");
    assert.equal(createRow.target_id, String(ticket.id));

    await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: ticket.channel_id,
    });
    rows = auditRows();
    const claimRow = findRow(rows, "tickets.claim");
    assert.ok(claimRow, "tickets.claim audit row expected");
    assert.equal(claimRow.actor_user_id, IDS.admin);
    assert.equal(claimRow.target_id, String(ticket.id));

    await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: ticket.channel_id,
      options: { reason: "Resolved via test" },
    });
    rows = auditRows();
    const closeRow = findRow(rows, "tickets.close");
    assert.ok(closeRow, "tickets.close audit row expected");
    assert.equal(closeRow.origin, "slash");
    assert.equal(closeRow.actor_user_id, IDS.admin);
    assert.equal(closeRow.target_id, String(ticket.id));
    const closeDetails = detailsOf(closeRow);
    assert.equal(closeDetails.close_reason, "Resolved via test");
    assert.equal(closeDetails.status, "closed");

    await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: ticket.channel_id,
    });
    rows = auditRows();
    const archiveRow = findRow(rows, "tickets.archive");
    assert.ok(archiveRow, "tickets.archive audit row expected");
    assert.equal(archiveRow.origin, "slash");
    assert.equal(archiveRow.actor_user_id, IDS.admin);
    assert.equal(archiveRow.target_id, String(ticket.id));

    env.db.updateGuildSettings(env.guild.id, { ticket_rate_limit_minutes: 60 });
  });

  it("warn-expiry ticker writes origin 'system' rows without an actor", async () => {
    env.db.createWarning({
      guildId: env.guild.id,
      userId: IDS.member2,
      issuerId: IDS.admin,
      reason: "Expires under audit",
      expiresAt: Date.now() - 5000,
    });

    const { runWarnExpiryTick } = require("../src/features/warnings/ticker");
    const result = await runWarnExpiryTick(env.client, { now: Date.now() });
    assert.ok(result.voided >= 1);

    const row = findRow(auditRows(), "warnings.expire");
    assert.ok(row, "warnings.expire audit row expected");
    assert.equal(row.origin, "system");
    assert.equal(row.actor_user_id, null);
    assert.equal(row.target_type, "warning");
    assert.equal(detailsOf(row).subject_user_id, IDS.member2);

    const systemRows = env.db.listAdminAudit(env.guild.id, {
      limit: 50,
      origin: "system",
    });
    assert.ok(systemRows.every((r) => r.origin === "system"));
  });
});
