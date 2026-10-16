const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { j, poll, namespaceIds } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — see e2e-buttons/e2e-reactions headers.

/**
 * Tier-4 level→role coverage (issue #322). Namespace 17: the full
 * `/leveltorole set|list|remove` surface (replies, rows, admin_audit +
 * audit-channel config embeds), the GRANT leg driven through the real
 * award pipeline (/grantxp crosses the threshold → awardXp → syncMemberRoles
 * → outbound role PUT → mock member asserts), the DROP-within-grace arm
 * (below_since timer started, role kept), the grace-EXPIRY arm (below_since
 * backdated, next award removes + clears), and the role-mutation failure
 * translation (mapping seeded directly to an unknown role id — the mock
 * never resolves forged ROLE options through discord.js, so the mapping is
 * DB-seeded; sync then fails the outbound PUT and must log the
 * "bot hierarchy / Manage Roles" guidance, never crash the award).
 *
 * Matrix deviations (stale issue text): "/setxp" seeds XP-RATES, not user
 * XP — /grantxp (admin) is the real seeding surface and runs the FULL award
 * pipeline including role sync. Role-id "validity feedback": real Discord
 * (and faithful mock discord.js) never resolve unknown role ids through
 * slash options, so no in-band validation exists — pinned via the DB-seeded
 * failure-translation arm instead.
 */
describe(
  "e2e: level→role sync — /leveltorole CRUD, /grantxp threshold grant, grace timer + expiry, failure translation",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    const logs = () => env.ids.channel2;
    const api = (path, opts = {}) =>
      j(`${env.mock.base}/api${path}`, {
        ...opts,
        headers: { ...env.mock.auth, ...(opts.headers || {}) },
      });

    let lvl2Role;
    const FORGED = "999900001111222233"; // well-formed, never exists in the mock

    before(async () => {
      const ids = namespaceIds(17);
      env = await createE2eEnv({
        ns: 17,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "lr-logs" },
        ],
      });

      const mg = await env.mock.createRole("E2E LR Admin MG", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, mg.id);

      // Member rows for the USER-option targets (discord.js refuses
      // non-members on guild interactions).
      await env.mock.inject(`member-bootstrap ${env.ids.target}`, env.ids.target, env.ids.general);
      await env.mock.inject(`member-bootstrap ${env.ids.outsider}`, env.ids.outsider, env.ids.general);

      // Deterministic factor (level = floor(sqrt(xp/100)) ⇒ L2 @ 400 XP)
      // + audit channel for logConfigChange / logLevelRoleChanges embeds.
      env.dbmod.updateGuildSettings(env.communityId, {
        audit_log_channel_id: env.ids.channel2,
        level_xp_factor: 100,
      });

      lvl2Role = await env.mock.createRole("E2E LR Lvl2");
    });

    after(async () => {
      await env?.cleanup();
    });

    const sub = (name, options = []) => ({ name, type: 1, ...(options.length && { options }) });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const roleOpt = (name, id) => ({ name, type: 8, value: id });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const userOpt = (name, id) => ({ name, type: 6, value: id });

    const slash = (command, options, who = env.ids.human) =>
      env.mock.slash({ command, options, userId: who });
    const replied = async (inter) => env.mock.awaitSettledReply(inter);
    const contentOf = async (inter) => String((await replied(inter)).content);

    const grantXp = async (userId, amount, reason) =>
      contentOf(
        await slash(
          "grantxp",
          [
            userOpt("user", userId),
            intOpt("amount", amount),
            ...(reason ? [strOpt("reason", reason)] : []),
          ],
        ),
      );

    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);

    // Mock shape: member.roles is a plain array of role-id STRINGS.
    const memberRoleIds = async (userId) => {
      try {
        const m = await api(`/guilds/${env.ids.guild}/members/${userId}`);
        return (m.roles ?? []).map((r) => String(typeof r === "string" ? r : r?.id));
      } catch (err) {
        if (err.status === 404) return [];
        throw err;
      }
    };

    const mapping = (roleId) =>
      env.dbmod.listLevelRoles(env.communityId).find((r) => r.role_id === roleId) ?? null;

    const logEmbeds = async () =>
      ((await env.mock.messages(logs())) ?? []).map((m) => m.embeds?.[0]).filter(Boolean);
    const sawEmbedTitle = async (re) => (await logEmbeds()).some((e) => re.test(String(e.title)));

    it("gates: outsider denied on /leveltorole and (admin-gated) /grantxp; amount floor + ghost-target edges", async () => {
      const denied = "You don't have permission to use this.";
      assert.equal(
        await contentOf(
          await slash("leveltorole", [sub("list")], env.ids.outsider),
        ),
        denied,
      );
      assert.equal(
        await contentOf(
          await slash("grantxp", [userOpt("user", env.ids.human), intOpt("amount", 5)], env.ids.outsider),
        ),
        denied,
      );
      // Amount floor lives in the handler (option has no min):
      assert.equal(await grantXp(env.ids.human, 0), "Amount must be at least 1.");
    });

    it("/leveltorole set/list/remove: replies, rows, audits, and config embeds in the log channel", async () => {
      assert.equal(
        await contentOf(await slash("leveltorole", [sub("list")])),
        "No level→role mappings configured.",
      );

      const setCopy = await contentOf(
        await slash("leveltorole", [sub("set", [roleOpt("role", lvl2Role.id), intOpt("level", 2), intOpt("dropdays", 1)])]),
      );
      assert.equal(
        setCopy,
        `Mapped <@&${lvl2Role.id}> to **Lvl 2** (remove after **1** day(s) below).`,
      );
      const row = mapping(lvl2Role.id);
      assert.ok(row, "mapping persisted");
      assert.equal(row.level_required, 2);
      assert.equal(row.drop_grace_days, 1);
      assert.ok(auditRow("level_roles.set"), "level_roles.set audit");

      const listed = await contentOf(await slash("leveltorole", [sub("list")]));
      assert.match(listed, /\*\*Level→Role mappings\*\*/);
      assert.ok(
        listed.includes(`@ **Lvl 2** (drop after **1d**)`),
        `list line (got: ${listed})`,
      );

      await poll(async () => ((await sawEmbedTitle(/Level→role mapping set/i)) ? true : null), {
        timeoutMs: 5000,
        label: "config-change embed",
      });
    });

    it("threshold grant via /grantxp: award pipeline adds the role to the MOCK MEMBER + embeds + audits", async () => {
      const copy = await grantXp(env.ids.target, 400, "cross to L2");
      assert.match(copy, /Granted \*\*400\*\* XP/);
      assert.match(copy, /Level \*\*2\*\*/, "floor(sqrt(400/100)) = 2");

      await poll(async () => ((await memberRoleIds(env.ids.target)).includes(lvl2Role.id) ? true : null), {
        timeoutMs: 8000,
        label: "outbound role PUT persisted on member",
      });

      assert.ok(auditRow("xp.grant"), "xp.grant audit");
      await poll(async () => ((await sawEmbedTitle(/XP granted/i)) ? true : null), {
        timeoutMs: 5000,
        label: "grant config embed",
      });
      // logLevelRoleChanges → audit-channel embed naming the member/role.
      await poll(async () => {
        const mentions = (await logEmbeds()).some((e) =>
          JSON.stringify(e).includes(lvl2Role.id),
        );
        return mentions ? true : null;
      }, { timeoutMs: 5000, label: "level-role change embed" });
      assert.equal(
        env.dbmod.getRoleDropState(env.communityId, env.ids.target, lvl2Role.id)?.below_since ?? null,
        null,
        "no drop timer while meeting the level",
      );
    });

    it("drop below threshold INSIDE grace: timer starts, role kept", async () => {
      // Pull XP below the L2 threshold directly (addXp delta −350 ⇒ ~51 XP,
      // level 0 — exact total depends on bootstrap message XP timing), then
      // fire one award so syncMemberRoles runs.
      env.dbmod.addXp(env.communityId, env.ids.target, -350);
      const copy = await grantXp(env.ids.target, 1);
      assert.match(copy, /Granted \*\*1\*\* XP/, `award lands below threshold (got: ${copy})`);

      await poll(async () => {
        const st = env.dbmod.getRoleDropState(env.communityId, env.ids.target, lvl2Role.id);
        return st?.below_since ? true : null;
      }, { timeoutMs: 5000, label: "below_since timer started" });

      assert.ok(
        (await memberRoleIds(env.ids.target)).includes(lvl2Role.id),
        "role KEPT inside the grace window",
      );
    });

    it("grace expiry: backdated below_since + next award removes the role and clears the timer", async () => {
      env.dbmod.setRoleBelowSince(
        env.communityId,
        env.ids.target,
        lvl2Role.id,
        Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days below > 1-day grace
      );

      await grantXp(env.ids.target, 1);
      await poll(async () => ((await memberRoleIds(env.ids.target)).includes(lvl2Role.id) ? null : true), {
        timeoutMs: 8000,
        label: "role removed after grace",
      });
      assert.equal(
        env.dbmod.getRoleDropState(env.communityId, env.ids.target, lvl2Role.id)?.below_since ?? null,
        null,
        "timer cleared after removal",
      );
    });

    it("failure translation: mapping to an UNKNOWN role id logs the hierarchy guidance and never crashes the award", async () => {
      // Forged ROLE options can never resolve through discord.js (faithful
      // mock), so seed the mapping the way a stale role id reaches prod.
      env.dbmod.upsertLevelRole(env.communityId, FORGED, 1, 0);

      const errors = [];
      const real = console.error;
      console.error = (...args) => {
        errors.push(args.map(String).join(" "));
      };
      try {
        // Push to 112 XP ⇒ level 1 ⇒ meets the forged mapping ⇒ add attempt.
        const copy = await grantXp(env.ids.target, 60);
        assert.match(copy, /Granted \*\*60\*\* XP/, "award itself still succeeds");
        await poll(
          async () => (errors.some((l) => /Failed to add role/.test(l)) ? true : null),
          { timeoutMs: 6000, label: "role-add failure logged" },
        );
      } finally {
        console.error = real;
      }

      const line = errors.find((l) => /Failed to add role/.test(l));
      assert.ok(line.includes(FORGED), `log names the role id (got: ${line})`);
      assert.ok(
        errors.some((l) => /highest role|Manage Roles/i.test(l)),
        "hierarchy/permission guidance emitted",
      );
      assert.ok(auditRow("xp.grant"), "award still audited — no crash");
      assert.ok(
        !(await memberRoleIds(env.ids.target)).includes(FORGED),
        "member obviously does not hold a nonexistent role",
      );

      env.dbmod.deleteLevelRole(env.communityId, FORGED);
    });

    it("remove mapping: row gone + audit + embed; empty list again", async () => {
      const copy = await contentOf(
        await slash("leveltorole", [sub("remove", [roleOpt("role", lvl2Role.id)])]),
      );
      assert.equal(copy, `Removed mapping for <@&${lvl2Role.id}>.`);
      assert.equal(mapping(lvl2Role.id), null, "row deleted");
      assert.ok(auditRow("level_roles.remove"), "level_roles.remove audit");
      await poll(async () => ((await sawEmbedTitle(/Level→role mapping removed/i)) ? true : null), {
        timeoutMs: 5000,
        label: "removal config embed",
      });

      assert.equal(
        await contentOf(await slash("leveltorole", [sub("list")])),
        "No level→role mappings configured.",
      );
    });

    // "/grantxp user:<BOT>" would hit discord.js's non-member USER refusal
    // in the mock (app user is not a guild member) — same limitation as the
    // ns15 ghost-slash pin; the "You can’t grant XP to bots." copy stays dark.
    it.todo("grantxp bot-target copy (mock: app user is not a guild member ⇒ USER option refused)");
  },
);
