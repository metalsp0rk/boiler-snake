const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll } = require("./helpers/mockenv");

const SENIOR_DENIED =
  "Activity requires **senior** staff (or Manage Server). Ask an admin to set your role with `/staff role setlevel`.";

/**
 * Tier-4 staff-roles surface coverage (issue #316). Namespace 7.
 *
 * Already covered elsewhere (not repeated here):
 *  - ns2 e2e-buttons: /userinfo panel round-trip + staff tier clicks
 *  - ns3 e2e-gates: staff_roles rows satisfying requireStaff (consumer side)
 *  - ns6 e2e-settings: /staff syncpermissions dark-config guidance (the
 *    issue matrix says "one owns it" — #315 took it)
 * This file: the /staff role mutation surface itself (ROLE-option
 * resolution via the vendored patch), seniority TRANSITIONS with the live
 * cross-feature effect on the senior-only Activity button, @everyone
 * guard, list, and the admin-gate denials.
 */
describe(
  "e2e: staff roles mutations & seniority transitions",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;

    /** junior staff role (seeded via dbmod, held by target) */
    let s1;
    /** role trusted via /staff role add senior in test 1 */
    let s2;

    before(async () => {
      env = await createE2eEnv({ ns: 7 });
      const adminRole = await env.mock.createRole("E2EAdmin", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, adminRole.id);

      s1 = await env.mock.createRole("E2EJunior");
      env.dbmod.addStaffRole(env.communityId, String(s1.id), "junior");
      await env.mock.grantRole(env.ids.target, s1.id);

      s2 = await env.mock.createRole("E2EFresh");
    });

    after(async () => {
      await env?.cleanup();
    });

    const roleSub = (name, roleId, level) => ({
      name: "role",
      type: 2,
      options: [
        {
          name,
          type: 1,
          ...(roleId && {
            options: [
              { name: "role", type: 8, value: roleId },
              ...(level ? [{ name: "level", type: 3, value: level }] : []),
            ],
          }),
        },
      ],
    });
    const staffRow = (roleId) =>
      env.dbmod.getStaffRole(env.communityId, String(roleId));
    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);

    async function openPanelAs(actorId) {
      const inter = await env.mock.slash({
        command: "userinfo",
        options: [{ name: "user", type: 6, value: env.ids.target }],
        userId: actorId,
      });
      const reply = await env.mock.awaitReply(inter);
      const buttons = await env.mock.buttons(reply.id);
      return { messageId: reply.id, buttons };
    }

    it("/staff role add resolves the ROLE option, persists the row and audits", async () => {
      const inter = await env.mock.slash({
        command: "staff",
        options: [roleSub("add", s2.id, "senior")],
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      assert.match(content, new RegExp(`Added <@&${s2.id}> as \\*\\*senior\\*\\* staff\\.`));
      assert.match(content, /honeypot-exempt/);

      const row = staffRow(s2.id);
      assert.equal(row?.level, "senior", "staff_roles row persisted");

      const audit = auditRow("staff.role_add");
      assert.ok(audit, "staff.role_add audit row");
      assert.equal(audit.actor_user_id, env.ids.human);
      assert.equal(audit.target_id, String(s2.id));
      assert.equal(JSON.parse(audit.details_json).previous_level, null);
    });

    it("@everyone cannot be trusted as a staff role", async () => {
      const inter = await env.mock.slash({
        command: "staff",
        options: [roleSub("add", env.ids.guild, "junior")],
      });
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        "You cannot use @everyone as a staff role.",
      );
      assert.ok(!staffRow(env.ids.guild), "no staff row for the guild id");
    });

    it("junior staff cannot mutate staff roles (admin-only gate)", async () => {
      // target passes requireStaff via s1 but fails ManageGuild-only.
      const inter = await env.mock.slash({
        command: "staff",
        options: [roleSub("add", s2.id, "junior")],
        userId: env.ids.target,
      });
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        "Only server administrators can add staff roles.",
      );
      assert.equal(staffRow(s2.id).level, "senior", "level untouched");
    });

    it("/staff role list shows both levels of the configured roles", async () => {
      const inter = await env.mock.slash({
        command: "staff",
        options: [roleSub("list")],
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      assert.match(content, /\*\*Staff roles\*\*/);
      const seniorSection = content.split("**Junior**")[0];
      const juniorSection = content.split("**Junior**")[1] ?? "";
      assert.match(seniorSection, new RegExp(s2.id), "senior lists s2");
      assert.match(juniorSection, new RegExp(s1.id), "junior lists s1");
    });

    it("setlevel senior flips the live senior gate on the SAME Activity button", async () => {
      const { messageId, buttons } = await openPanelAs(env.ids.human);
      const activity = buttons.find((b) =>
        String(b.custom_id).startsWith("ui:a:"),
      );
      assert.ok(activity, `Activity button present (${buttons.map((b) => b.custom_id).join(",")})`);

      // Junior member: senior-only denial on the button itself.
      const denied = await env.mock.click({
        customId: String(activity.custom_id),
        messageId,
        userId: env.ids.target,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        SENIOR_DENIED,
      );

      // Admin promotes the role via the real command surface.
      const promote = await env.mock.slash({
        command: "staff",
        options: [roleSub("setlevel", s1.id, "senior")],
      });
      assert.match(
        String((await env.mock.awaitReply(promote)).content),
        new RegExp(`Set <@&${s1.id}> to \\*\\*senior\\*\\* staff\\.`),
      );
      const audit = auditRow("staff.role_setlevel");
      assert.equal(JSON.parse(audit.details_json).previous_level, "junior");

      // Same button, same clicker — now served (panel edited in place).
      const ok = await env.mock.click({
        customId: String(activity.custom_id),
        messageId,
        userId: env.ids.target,
      });
      assert.ok(ok.message, "click attached to the stored panel");
      const edited = await poll(async () => {
        const m = await env.mock.message(messageId);
        return m.edited_timestamp ? m : null;
      });
      assert.ok(edited.edited_timestamp, "activity tab rendered (message edit)");
    });

    it("setlevel validation: already-at-level and non-staff roles reply specifically", async () => {
      const same = await env.mock.slash({
        command: "staff",
        options: [roleSub("setlevel", s2.id, "senior")],
      });
      assert.equal(
        String((await env.mock.awaitReply(same)).content),
        `<@&${s2.id}> is already **senior** staff.`,
      );

      const s3 = await env.mock.createRole("E2ENotStaff");
      const unknown = await env.mock.slash({
        command: "staff",
        options: [roleSub("setlevel", s3.id, "senior")],
      });
      assert.equal(
        String((await env.mock.awaitReply(unknown)).content),
        `<@&${s3.id}> is not a staff role. Use \`/staff role add\` first.`,
      );
    });

    it("/staff role remove revokes the senior gate live (follow-up click denied)", async () => {
      const { messageId, buttons } = await openPanelAs(env.ids.human);
      const activity = buttons.find((b) =>
        String(b.custom_id).startsWith("ui:a:"),
      );

      const removed = await env.mock.slash({
        command: "staff",
        options: [roleSub("remove", s1.id)],
      });
      assert.match(
        String((await env.mock.awaitReply(removed)).content),
        new RegExp(`Removed <@&${s1.id}> from staff roles\\.`),
      );
      assert.ok(!staffRow(s1.id), "staff row deleted");
      const audit = auditRow("staff.role_remove");
      assert.equal(JSON.parse(audit.details_json).previous_level, "senior");

      const denied = await env.mock.click({
        customId: String(activity.custom_id),
        messageId,
        userId: env.ids.target,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        SENIOR_DENIED,
        "removed staff immediately loses the senior surface",
      );
    });

    it("removing a non-staff role replies without inventing an audit row", async () => {
      const before = auditRow("staff.role_remove");
      const s4 = await env.mock.createRole("E2ENeverStaff");
      const inter = await env.mock.slash({
        command: "staff",
        options: [roleSub("remove", s4.id)],
      });
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        `<@&${s4.id}> is not a configured staff role.`,
      );
      assert.equal(auditRow("staff.role_remove").id, before.id, "no new audit row");
    });
  },
);
