/**
 * Boundary-exhaustive truth-table pin for the SECURITY gates in
 * `src/core/permissions.js` (wishlist T6).
 *
 * Objective: pin the ACTUAL shipped allow/deny behavior of every permission
 * gate for EVERY combination of the tier inputs:
 *   - ManageGuild permission bit (on/off)
 *   - staff_roles config (none / junior-only / senior-only / both)
 *   - roles the member actually holds (none / junior / senior / junior+senior)
 * => full 2 × 4 × 4 = 32-row matrix, asserted against all five relevant
 * exports (isAdminOrMod, isStaff, isSeniorStaff, requireAdmin, requireStaff,
 * requireSeniorStaff — admin/staff/senior gates share the same 32 rows).
 *
 * Also pinned (security-relevant exceptions and edges):
 *   - `commandsAllowed` admin lockout exemption (`/setcommandchannel`) and the
 *     TWO-PHASE `/ticket` lifecycle exemption (permissions.js ~L65–70): open
 *     OR soft-closed-but-not-archived ticket channels bypass the channel
 *     allow-list; `archived=1` rows lose the exemption.
 *   - missing member → deny; staff_roles are guild-scoped (cross-guild roles
 *     do NOT grant access); denials after a prior reply route to followUp.
 *
 * Positive rows: gate returns exactly `true` and posts NO reply (allow side
 * effect-free). Negative rows: gate returns exactly `false` and posts exactly
 * one EPHEMERAL denial carrying the shipped copy — how each case meets the
 * objective: a silent allow (privilege escalation) fails `allowed` rows' reply
 * count or `denied` rows' verdict; a silent deny fails the allow verdict.
 *
 * Deterministic: temp SQLite via helpers/env.loadDb(), plain-object Discord
 * fakes via helpers/discord, no sleeps, no network, no timers.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb } = require("./helpers/env");
const {
  createChatInputInteraction,
  createGuild,
  createMember,
  createUser,
  lastReplyContent,
  lastReplyEphemeral,
  MessageFlags,
} = require("./helpers/discord");

// ---------------------------------------------------------------------------
// Matrix dimensions (Arrange data)
// ---------------------------------------------------------------------------

const JR = "role-junior-staff";
const SR = "role-senior-staff";

/** staff_roles configuration per guild: which of JR/SR are registered, at what level. */
const CONFIGS = [
  { key: "none", junior: false, senior: false },
  { key: "junior", junior: true, senior: false },
  { key: "senior", junior: false, senior: true },
  { key: "both", junior: true, senior: true },
].map((c) => ({
  ...c,
  // one dedicated guild per config so seed states never interfere
  guildId: `g-perm-cfg-${c.key}`,
  staffSet: new Set([...(c.junior ? [JR] : []), ...(c.senior ? [SR] : [])]),
  seniorSet: new Set(c.senior ? [SR] : []),
}));

/** Which of the configured staff roles the invoking member actually holds. */
const MEMBERSHIPS = [
  { key: "none", roleIds: [] },
  { key: "junior", roleIds: [JR] },
  { key: "senior", roleIds: [SR] },
  { key: "junior+senior", roleIds: [JR, SR] },
];

/**
 * Full 2 × 4 × 4 = 32 truth-table rows. Expected verdicts are computed here
 * from the dimension definition itself (independent of the module under test):
 *   staff  = ManageGuild OR member holds ANY configured staff role (any level)
 *   senior = ManageGuild OR member holds a role configured at SENIOR level
 *   admin  = ManageGuild
 */
const ROWS = [];
for (const cfg of CONFIGS) {
  for (const mem of MEMBERSHIPS) {
    for (const mg of [false, true]) {
      const holds = (set) => mem.roleIds.some((r) => set.has(r));
      ROWS.push({
        cfg,
        mem,
        mg,
        staffAllow: mg || holds(cfg.staffSet),
        seniorAllow: mg || holds(cfg.seniorSet),
        adminAllow: mg,
      });
    }
  }
}
assert.equal(ROWS.length, 32, "matrix is 2(MG) × 4(config) × 4(membership)");

const rowLabel = (row) =>
  `ManageGuild=${row.mg ? "on" : "off"} ` +
  `junior=${row.cfg.junior ? "on" : "off"} ` +
  `senior=${row.cfg.senior ? "on" : "off"} ` +
  `member=${row.mem.key}`;

describe("permissions.js — requireStaff/requireSeniorStaff truth-table matrix", () => {
  /** @type {object} db facade bound to the temp DB */
  let db;
  /** @type {typeof import("../src/core/permissions.js")} */
  let perms;
  let env;
  /** Shipped copy of the generic denial, loaded from src so it stays honest. */
  let MSG_DENIED;

  before(() => {
    env = loadDb(); // fresh temp SQLite + reset of the src/ require cache
    db = env.api;
    perms = require("../src/core/permissions.js"); // binds to THIS db
    MSG_DENIED = require("../src/core/theme").MSG_DENIED;

    // Seed one guild per staff_roles config (deterministic, upsert-safe).
    for (const cfg of CONFIGS) {
      if (cfg.junior) db.addStaffRole(cfg.guildId, JR, "junior");
      if (cfg.senior) db.addStaffRole(cfg.guildId, SR, "senior");
    }
  });

  after(() => env.cleanup());

  /**
   * Arrange: guild + member + chat interaction for a matrix row.
   * `admin` on createMember sets ONLY the ManageGuild bit, which is exactly
   * what isAdminOrMod consults via interaction.memberPermissions.
   */
  function makeInteraction(row) {
    const guild = createGuild({ id: row.cfg.guildId });
    const user = createUser({ id: `u-${row.cfg.key}-${row.mem.key}-${row.mg}` });
    const member = createMember({
      guild,
      user,
      roleIds: row.mem.roleIds,
      admin: row.mg,
    });
    return createChatInputInteraction({
      commandName: "notes",
      guild,
      user,
      member,
      channelId: "chan-perm",
    });
  }

  // -------- negative-side helpers: denial must be loud, ephemeral, specific --

  function assertStandardDenial(interaction, msg) {
    assert.equal(interaction.replies.length, 1, msg);
    assert.ok(lastReplyEphemeral(interaction), "denial must be ephemeral");
    assert.equal(lastReplyContent(interaction), MSG_DENIED, msg);
  }

  // -------- the matrix: one named test per (gate × row) + predicate row -----

  for (const row of ROWS) {
    const label = rowLabel(row);

    it(`requireStaff: ${label} tier=staff → ${row.staffAllow ? "allowed" : "denied"}`, async () => {
      // Arrange
      const interaction = makeInteraction(row);
      // Act
      const allowed = await perms.requireStaff(interaction);
      // Assert: verdict pinned; allow is side-effect-free, denial replies
      assert.equal(allowed, row.staffAllow);
      if (row.staffAllow) {
        assert.equal(interaction.replies.length, 0, "allowed gate must not reply");
      } else {
        assertStandardDenial(
          interaction,
          `staff denial must reply MSG_DENIED (${label})`,
        );
      }
    });

    it(`requireSeniorStaff: ${label} tier=senior → ${row.seniorAllow ? "allowed" : "denied"}`, async () => {
      // Arrange
      const interaction = makeInteraction(row);
      // Act
      const allowed = await perms.requireSeniorStaff(interaction);
      // Assert: senior tier is STRICTER — junior-only staff is not enough
      assert.equal(allowed, row.seniorAllow);
      if (row.seniorAllow) {
        assert.equal(interaction.replies.length, 0, "allowed gate must not reply");
      } else {
        const content = lastReplyContent(interaction);
        assert.equal(interaction.replies.length, 1, `senior denial replies once (${label})`);
        assert.ok(lastReplyEphemeral(interaction), "denial must be ephemeral");
        assert.match(content, /senior/i, "senior denial names the tier");
        assert.match(content, /setlevel/, "senior denial names the fix command");
      }
    });

    it(`requireAdmin: ${label} → ${row.adminAllow ? "allowed" : "denied"}`, async () => {
      // Arrange
      const interaction = makeInteraction(row);
      // Act
      const allowed = await perms.requireAdmin(interaction);
      // Assert: admin gate ignores staff_roles entirely — pure ManageGuild bit
      assert.equal(allowed, row.adminAllow);
      if (row.adminAllow) {
        assert.equal(interaction.replies.length, 0, "allowed gate must not reply");
      } else {
        assertStandardDenial(
          interaction,
          `admin denial must reply MSG_DENIED (${label})`,
        );
      }
    });

    it(`predicates: ${label} → isAdminOrMod=${row.mg} isStaff=${row.staffAllow} isSeniorStaff=${row.seniorAllow}`, () => {
      // Arrange
      const interaction = makeInteraction(row);
      // Act + Assert: sync predicates agree with the async gates' verdicts
      assert.equal(perms.isAdminOrMod(interaction), row.mg);
      assert.equal(perms.isStaff(interaction), row.staffAllow);
      assert.equal(perms.isSeniorStaff(interaction), row.seniorAllow);
    });
  }

  // ------------------------- edge rows outside the matrix ------------------

  it("edge: missing member (member=null, no perms) → all gates deny with replies", async () => {
    // Arrange: fully member-less interaction in a guild configured with BOTH
    // staff levels — a hole here would be privilege escalation.
    const cfg = CONFIGS.find((c) => c.key === "both");
    const guild = createGuild({ id: cfg.guildId });

    const makeNoMemberInteraction = (seq) =>
      createChatInputInteraction({
        commandName: "notes",
        guild,
        user: createUser({ id: `u-perm-no-member-${seq}` }),
        channelId: "chan-perm",
      });

    // Act: separate interactions so each denial lands on its own reply path
    const staffI = makeNoMemberInteraction(1);
    const seniorI = makeNoMemberInteraction(2);
    const adminI = makeNoMemberInteraction(3);
    const staff = await perms.requireStaff(staffI);
    const senior = await perms.requireSeniorStaff(seniorI);
    const admin = await perms.requireAdmin(adminI);

    // Assert: every gate denies, and each denial posted exactly one reply
    assert.equal(staff, false, "isStaff must deny without a member");
    assert.equal(senior, false, "requireSeniorStaff must deny without a member");
    assert.equal(admin, false, "requireAdmin must deny without a member");
    for (const i of [staffI, seniorI, adminI]) {
      assert.equal(i.replies.length, 1, "one denial reply per interaction");
      assert.ok(lastReplyEphemeral(i), "denial must be ephemeral");
    }
  });

  it("edge: staff_roles are guild-scoped — junior+senior roles configured in ANOTHER guild do not grant access", async () => {
    // Arrange: JR/SR are staff in `g-perm-cfg-both` (seeded in before()), but
    // this interaction runs in `g-perm-stranger`, which has NO staff_roles.
    const stranger = createGuild({ id: "g-perm-stranger" });
    const user = createUser({ id: "u-perm-crossguild" });
    const member = createMember({
      guild: stranger,
      user,
      roleIds: [JR, SR], // member holds the same role IDs as the other guild's staff
    });
    const interaction = createChatInputInteraction({
      commandName: "notes",
      guild: stranger,
      user,
      member,
      channelId: "chan-perm",
    });

    // Act
    const staff = await perms.requireStaff(interaction);
    const senior = await perms.requireSeniorStaff(interaction);

    // Assert: config lookup is scoped to interaction.guildId → denied
    assert.equal(staff, false, "cross-guild role ids must not grant staff");
    assert.equal(senior, false, "cross-guild role ids must not grant senior");
  });

  it("edge: denial after an earlier reply goes to followUp, not a second reply", async () => {
    // Arrange: mg off / no config row held → denied; pre-set replied=true.
    const cfg = CONFIGS.find((c) => c.key === "none");
    const guild = createGuild({ id: cfg.guildId });
    const user = createUser({ id: "u-perm-followup" });
    const member = createMember({ guild, user, roleIds: [] });
    const interaction = createChatInputInteraction({
      commandName: "notes",
      guild,
      user,
      member,
      channelId: "chan-perm",
    });
    await interaction.reply("ack"); // handler already responded once

    // Act
    const allowed = await perms.requireStaff(interaction);

    // Assert: denial still happens (return false) via followUp
    assert.equal(allowed, false);
    assert.equal(interaction.replies.length, 1, "original ack reply untouched");
    assert.equal(interaction.followUps.length, 1, "denial followed up");
    const denied = interaction.followUps[0];
    assert.equal(
      denied.flags,
      MessageFlags.Ephemeral,
      "follow-up denial is ephemeral",
    );
    assert.equal(denied.content, MSG_DENIED);
  });

  // --------------------- commandsAllowed exception matrix ------------------

  describe("commandsAllowed — setcommandchannel admin exemption + two-phase /ticket exemption", () => {
    const G = "g-cmdallow";
    const LISTED = "chan-listed";
    const UNLISTED = "chan-unlisted";
    const CH_OPEN = "chan-ticket-open"; // status=open, archived=0
    const CH_SOFT = "chan-ticket-soft"; // status=closed, archived=0 (awaits /ticket archive)
    const CH_ARCH = "chan-ticket-arch"; // archived=1 while the channel row still exists

    /** @type {object} */
    let cmdGuild;

    before(() => {
      cmdGuild = createGuild({ id: G });
      // Restrictive allow-list: ONLY LISTED is configured → every UNLISTED
      // row proves the exception under test rather than an open guild.
      db.addAllowedCommandChannel(G, LISTED);

      db.createTicket({ guildId: G, creatorUserId: "u-req", channelId: CH_OPEN });

      const soft = db.createTicket({
        guildId: G,
        creatorUserId: "u-req",
        channelId: CH_SOFT,
      });
      db.markTicketClosed(soft.id, { closedBy: "u-staff" });

      const arch = db.createTicket({
        guildId: G,
        creatorUserId: "u-req",
        channelId: CH_ARCH,
      });
      db.markTicketClosed(arch.id, { closedBy: "u-staff" });
      // Archive finalized (archived=1) while the channel row is still bound —
      // the exact state permissions.js guards with Number(archived) !== 1.
      db.db.prepare("UPDATE tickets SET archived=1 WHERE id=?").run(arch.id);
    });

    function makeCmdInteraction(commandName, channelId, admin) {
      const user = createUser({ id: `u-ca-${commandName}-${channelId}-${admin}` });
      const member = createMember({ guild: cmdGuild, user, admin });
      return createChatInputInteraction({
        commandName,
        guild: cmdGuild,
        user,
        member,
        channelId,
      });
    }

    // Truth table for the channel-allow-list exemptions. `expect` pins the
    // shipped code path: only (/setcommandchannel && admin) and (/ticket &&
    // live ticket row with archived !== 1) escape the list; ManageGuild
    // itself grants NOTHING on the channel axis.
    const CA_ROWS = [
      {
        cmd: "setcommandchannel",
        admin: true,
        channelId: UNLISTED,
        expect: true,
        why: "admin lockout exemption works anywhere",
      },
      {
        cmd: "setcommandchannel",
        admin: false,
        channelId: UNLISTED,
        expect: false,
        why: "non-admin gets no exemption",
      },
      {
        cmd: "setcommandchannel",
        admin: false,
        channelId: LISTED,
        expect: true,
        why: "listed channel passes the list",
      },
      {
        cmd: "ticket",
        admin: false,
        channelId: CH_OPEN,
        expect: true,
        why: "open ticket channel: lifecycle exemption",
      },
      {
        cmd: "ticket",
        admin: false,
        channelId: CH_SOFT,
        expect: true,
        why: "soft-closed ticket channel still exempt (archive phase pending)",
      },
      {
        cmd: "ticket",
        admin: false,
        channelId: CH_ARCH,
        expect: false,
        why: "archived=1 ticket channel loses the exemption",
      },
      {
        cmd: "ticket",
        admin: true,
        channelId: CH_ARCH,
        expect: false,
        why: "ManageGuild does not bypass the list for /ticket",
      },
      {
        cmd: "ticket",
        admin: false,
        channelId: UNLISTED,
        expect: false,
        why: "no ticket row bound to channel: list applies",
      },
      {
        cmd: "warn",
        admin: false,
        channelId: CH_OPEN,
        expect: false,
        why: "ticket exemption is /ticket-only",
      },
      {
        cmd: "warn",
        admin: false,
        channelId: LISTED,
        expect: true,
        why: "listed channel passes for any command",
      },
      {
        cmd: "xp",
        admin: true,
        channelId: UNLISTED,
        expect: false,
        why: "ManageGuild is not a channel bypass (only setcommandchannel is)",
      },
    ];

    for (const r of CA_ROWS) {
      it(`commandsAllowed: /${r.cmd} in ${r.channelId} admin=${r.admin ? "on" : "off"} → ${r.expect ? "allowed" : "denied"} (${r.why})`, () => {
        // Arrange
        const interaction = makeCmdInteraction(r.cmd, r.channelId, r.admin);
        // Act
        const allowed = perms.commandsAllowed(interaction);
        // Assert: boolean-verdict pin (no reply side effects on this gate)
        assert.equal(allowed, r.expect);
        assert.equal(interaction.replies.length, 0, "gate does not reply");
      });
    }

    it("commandsAllowed: empty allow-list → every command allowed in every channel", () => {
      // Arrange: guild with NO allowed_command_channels rows at all.
      const openGuild = createGuild({ id: "g-cmdallow-empty" });
      const user = createUser({ id: "u-ca-empty" });
      const member = createMember({ guild: openGuild, user, admin: false });
      const interaction = createChatInputInteraction({
        commandName: "warn",
        guild: openGuild,
        user,
        member,
        channelId: "chan-nowhere",
      });

      // Act + Assert
      assert.equal(perms.commandsAllowed(interaction), true);
    });
  });
});
