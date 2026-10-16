"use strict";
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { namespaceIds } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — see e2e-buttons/e2e-reactions headers.

/**
 * Tier-4 audit/log surfaces + decay config (issue #326). Namespace 21.
 *
 * Pins `/setlog` (audit/message streams: set/repeat/show/clear/precedence/
 * bogus-id arm, exact copies, mirror-embed visibility, guild_settings keys),
 * `/setdecay` (persist-echo embed, handler-side SILENT CLAMPS — the mock
 * enforces nothing, so out-of-range values must be asserted as clamps, not
 * refusals; empty-patch refusal; mirror embed only on REAL change), and the
 * tier-4 completion of the admin-audit slash-origin roster for
 * `logs.channel_set` / `logs.channel_clear` / `decay.settings_update` /
 * `warnings.add` (the grantxp `xp.grant` row is already pinned by ns5).
 *
 * Mock contract pinned here (fauxcord buildResolvedEntities): unknown
 * CHANNEL-option ids never enter data.resolved → discord.js getChannel()
 * yields null → `/setlog` lands on the PROVIDE-A-CHANNEL copy, not the
 * `I can't find channel…` copy (that arm is honestly it.todo — no mock seam
 * can resolve a channel that has no row).
 *
 * Decay ticker note (issue #326): `/setdecay enabled:false` runs EARLY so a
 * suite that happens to cross the 04:00-local cron boundary (`decay_enabled`
 * defaults ON) never mutates this namespace; the apply arm itself is an
 * honest todo — logic is pinned offline in test/integration/decay.test.js.
 * Retention exposes NO interaction surface at all (docs note, todo below).
 */
describe(
  "e2e: audit/log surfaces + decay config — /setlog lifecycle, /setdecay clamps, slash-origin admin_audit rows",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    const ids = namespaceIds(21);
    const MSG_DENIED = "You don't have permission to use this.";

    before(async () => {
      env = await createE2eEnv({
        ns: 21,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "audit-log" },
        ],
      });
      // Staff pattern per ns5: staff_roles row (junior, bitless) + MG role.
      const junior = await env.mock.createRole("E2E AD Junior");
      await env.mock.grantRole(env.ids.target, junior.id);
      env.dbmod.addStaffRole(env.communityId, String(junior.id), "junior");
      const adminRole = await env.mock.createRole("E2E AD Admin", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, adminRole.id);
    });

    after(async () => {
      await env?.cleanup();
    });

    // ---- helpers ----------------------------------------------------------

    const sub = (name, options = []) => ({ name, type: 1, ...(options.length && { options }) });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const boolOpt = (name, value) => ({ name, type: 5, value });
    // ApplicationCommandOptionType.Number = 10 — setdecay `percent` is a
    // NUMBER option; sending type 4 makes discord.js throw → router generic.
    const numOpt = (name, value) => ({ name, type: 10, value });
    const userOpt = (name, id) => ({ name, type: 6, value: id });

    const slash = (command, options = [], who = env.ids.human) =>
      env.mock.slash({ command, options, userId: who });
    const replyOf = async (inter) => env.mock.awaitSettledReply(inter);
    const contentOf = async (inter) => String((await replyOf(inter)).content);
    const embed0 = async (inter) => (await replyOf(inter)).embeds?.[0] ?? {};

    const settings = () => env.dbmod.getGuildSettings(env.communityId);

    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);
    const auditCount = (action) =>
      env.dbmod.db
        .prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE community_id = ? AND action = ?")
        .get(env.communityId, action).n;

    const msgTitles = async (channelId) =>
      ((await env.mock.messages(channelId)) ?? []).map((m) => m.embeds?.[0]?.title);
    const embedChanges = async (channelId, title) => {
      const msgs = ((await env.mock.messages(channelId)) ?? []).filter(
        (m) => m.embeds?.[0]?.title === title,
      );
      const last = msgs[msgs.length - 1];
      return String(last?.embeds?.[0]?.fields?.find((f) => f.name === "Changes")?.value ?? "");
    };

    // ---- gates / picker parity ---------------------------------------------

    it("gates: setlog+setdecay carry ManageGuild pickers, outsiders are denied (zero writes), junior staff_roles members are SERVED", async () => {
      const cmds = await env.mock.listGuildCommands();
      const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));
      // Extends ns6's register-PUT parity rule to the two config names here.
      assert.equal(String(byName.setlog.default_member_permissions), "32");
      assert.equal(String(byName.setdecay.default_member_permissions), "32");

      // Staff tier ⇒ the SERVICE gate answers (mock delivers regardless).
      assert.equal(await contentOf(await slash("setlog", [sub("show")], ids.outsider)), MSG_DENIED);
      assert.equal(
        await contentOf(
          await slash("setlog", [sub("audit", [chanOpt("channel", ids.channel2)])], ids.outsider),
        ),
        MSG_DENIED,
      );
      assert.equal(
        await contentOf(await slash("setdecay", [boolOpt("enabled", false)], ids.outsider)),
        MSG_DENIED,
      );
      assert.equal(auditRow("logs.channel_set"), undefined, "denials wrote no audit rows");
      assert.equal(auditRow("decay.settings_update"), undefined);
      assert.equal(Number(settings().decay_enabled), 1, "denial wrote no settings");

      // Junior (staff_roles, ZERO permission bits) is served — staff tier is
      // ManageGuild-OR-staff_roles, unlike admin-tier /setcommandchannel.
      const juniorShow = await contentOf(await slash("setlog", [sub("show")], ids.target));
      assert.equal(
        juniorShow,
        "**Log channels**\n" +
          "• **Audit log** (bans, kicks, role changes): _Not configured_\n" +
          "• **Message log** (deleted messages): _Not configured_",
        `junior served the pristine show copy (got: ${juniorShow})`,
      );
    });

    // ---- /setdecay: early disable + persist echo + audit shape -------------

    it("/setdecay enabled:false (early, cron-flake defense): echo embed fields verbatim, row write, decay.settings_update row", async () => {
      const inter = await slash("setdecay", [boolOpt("enabled", false)]);
      const embed = await embed0(inter);
      assert.equal(embed.title, "Updated decay settings");
      assert.equal(embed.footer?.text, "Staff only");
      const field = (name) => (embed.fields ?? []).find((f) => f.name === name)?.value;
      // Echo shows the FULL MERGED row (defaults + patch), not just options.
      assert.equal(field("Enabled"), "**false**");
      assert.equal(field("Threshold"), "**20** messages / **7** days");
      assert.equal(field("Percent"), "**10%**");

      assert.equal(Number(settings().decay_enabled), 0);

      const row = auditRow("decay.settings_update");
      assert.ok(row, "audit row written");
      assert.equal(row.origin, "slash", "slash-origin metadata (tier-4 roster, issue #326)");
      assert.equal(String(row.actor_user_id), String(ids.human));
      assert.equal(Number(row.community_id), env.communityId);
      assert.equal(row.target_type, "guild");
      assert.equal(String(row.target_id), String(ids.guild), "target_id stays the EXTERNAL snowflake");
      assert.deepEqual(JSON.parse(row.details_json).patch, { decay_enabled: 0 });
      // The mirror embed is best-effort through the audit stream — no stream
      // is configured yet, so it lands nowhere (asserted absence via tape).
      assert.ok(!(await msgTitles(ids.channel2)).includes("Decay settings updated"));
    });

    // ---- /setlog lifecycle --------------------------------------------------

    it("/setlog audit+message streams: exact copies, mirrors IN the target channel, show readback, clear + precedence arms, bogus-id mock contract", async () => {
      // --- set audit → channel2
      assert.equal(
        await contentOf(await slash("setlog", [sub("audit", [chanOpt("channel", ids.channel2)])])),
        `Audit log will be sent to <#${ids.channel2}>.`,
      );
      assert.equal(String(settings().audit_log_channel_id), String(ids.channel2));
      let row = auditRow("logs.channel_set");
      assert.equal(row.origin, "slash");
      assert.equal(String(row.actor_user_id), String(ids.human));
      assert.equal(row.target_type, "channel");
      assert.equal(String(row.target_id), String(ids.channel2));
      assert.deepEqual(JSON.parse(row.details_json), {
        stream: "audit",
        previous_channel_id: null,
      });
      // Mirror embed posts AFTER the write → self-lands in the new channel.
      assert.ok((await msgTitles(ids.channel2)).includes("Audit log channel set"));
      assert.ok(
        (await embedChanges(ids.channel2, "Audit log channel set")).includes(
          `Audit log: *none* → <#${ids.channel2}>`,
        ),
      );

      // --- re-set the SAME channel: documented no-op-copy + fresh audit
      //     (previous_channel_id = same id) — pinned, not treated as a bug.
      const setCountBefore = auditCount("logs.channel_set");
      assert.equal(
        await contentOf(await slash("setlog", [sub("audit", [chanOpt("channel", ids.channel2)])])),
        `Audit log will be sent to <#${ids.channel2}>.`,
      );
      assert.equal(auditCount("logs.channel_set"), setCountBefore + 1, "re-set re-audits");
      row = auditRow("logs.channel_set");
      assert.equal(
        JSON.parse(row.details_json).previous_channel_id,
        String(ids.channel2),
        "previous_channel_id = same id on re-set",
      );

      // --- show readback (exact multi-line copy, id-suffix format)
      assert.equal(
        await contentOf(await slash("setlog", [sub("show")])),
        "**Log channels**\n" +
          `• **Audit log** (bans, kicks, role changes): <#${ids.channel2}> (\`${ids.channel2}\`)\n` +
          "• **Message log** (deleted messages): _Not configured_",
      );

      // --- message stream on the SAME channel (separate key)
      assert.equal(
        await contentOf(
          await slash("setlog", [sub("message", [chanOpt("channel", ids.channel2)])]),
        ),
        `Message log will be sent to <#${ids.channel2}>.`,
      );
      assert.equal(String(settings().message_log_channel_id), String(ids.channel2));
      assert.deepEqual(JSON.parse(auditRow("logs.channel_set").details_json), {
        stream: "message",
        previous_channel_id: null,
      });

      // --- precedence: clear:true WINS over a provided channel (checked
      //     first) — even with channel:general present, the stream clears.
      assert.equal(
        await contentOf(
          await slash("setlog", [
            sub("audit", [chanOpt("channel", ids.general), boolOpt("clear", true)]),
          ]),
        ),
        "Audit log channel cleared. That log stream is disabled until set again.",
      );
      assert.equal(settings().audit_log_channel_id, null);
      row = auditRow("logs.channel_clear");
      assert.equal(row.origin, "slash");
      assert.equal(row.target_type, "guild");
      assert.equal(String(row.target_id), String(ids.guild));
      assert.deepEqual(JSON.parse(row.details_json), {
        stream: "audit",
        previous_channel_id: String(ids.channel2),
      });
      // Mirror runs BEFORE the clear (while the channel still exists):
      assert.ok((await msgTitles(ids.channel2)).includes("Audit log channel cleared"));
      assert.ok(
        (await embedChanges(ids.channel2, "Audit log channel cleared")).includes(
          `Audit log: <#${ids.channel2}> → *none*`,
        ),
      );

      // --- clearing an ALREADY-UNSET field still writes + audits (no
      //     same-value guard); its mirror goes nowhere (no stream channel).
      const clearCountBefore = auditCount("logs.channel_clear");
      assert.equal(
        await contentOf(await slash("setlog", [sub("audit", [boolOpt("clear", true)])])),
        "Audit log channel cleared. That log stream is disabled until set again.",
      );
      assert.equal(auditCount("logs.channel_clear"), clearCountBefore + 1);
      assert.deepEqual(JSON.parse(auditRow("logs.channel_clear").details_json), {
        stream: "audit",
        previous_channel_id: null,
      });

      // --- MOCK CONTRACT: a channel id with no mock row never enters
      //     data.resolved → getChannel() null → PROVIDE-A-CHANNEL copy (the
      //     `I can't find channel…` fetchChannel-null arm is it.todo below).
      const setCount2 = auditCount("logs.channel_set");
      assert.equal(
        await contentOf(
          await slash("setlog", [sub("audit", [chanOpt("channel", "999999999999999999")])]),
        ),
        "Provide a `channel`, or set `clear:true` to disable the audit log.",
      );
      assert.equal(auditCount("logs.channel_set"), setCount2, "bogus id wrote nothing");
      assert.equal(settings().audit_log_channel_id, null);

      // --- /settings embed round-trip (both config surfaces, exact fields):
      //     audit cleared above, message stream still on channel2; decay
      //     still the T2 write over defaults.
      const settingsEmbed = await embed0(await slash("settings"));
      const sfield = (name) =>
        (settingsEmbed.fields ?? []).find((f) => f.name === name)?.value;
      assert.equal(
        sfield("Logs"),
        `Audit _Not configured_ · Message <#${ids.channel2}>`,
        `Logs field (got: ${sfield("Logs")})`,
      );
      assert.equal(
        sfield("Decay"),
        "Enabled **false** · threshold **20** msgs / **7** days · **10%**",
        `Decay field (got: ${sfield("Decay")})`,
      );
    });

    // ---- /setdecay clamps + mirror discipline ------------------------------

    it("/setdecay handler-side SILENT CLAMPS (percent 500→95%, days 0→1, messages -5→0), patch audit details, mirror only on REAL change, empty-patch refusal", async () => {
      // Make decay mirrors observable: point the audit stream at channel2
      // again (previous_channel_id is null now — T3 cleared it).
      await slash("setlog", [sub("audit", [chanOpt("channel", ids.channel2)])]);

      const embed = await embed0(
        await slash("setdecay", [
          intOpt("messages", -5),
          intOpt("days", 0),
          numOpt("percent", 500),
        ]),
      );
      assert.equal(embed.title, "Updated decay settings");
      const field = (name) => (embed.fields ?? []).find((f) => f.name === name)?.value;
      // The builder bounds (min 0 / min 1 / 0..95) are PICKER-ONLY — the
      // mock enforces nothing and the handler CLAMPS silently:
      assert.equal(field("Enabled"), "**false**", "unmentioned option keeps stored value");
      assert.equal(field("Threshold"), "**0** messages / **1** days");
      assert.equal(field("Percent"), "**95%**");
      const s = settings();
      assert.equal(Number(s.decay_min_messages), 0);
      assert.equal(Number(s.decay_window_days), 1);
      assert.equal(Number(s.decay_percent), 0.95, "percent stored as FRACTION");

      const row = auditRow("decay.settings_update");
      assert.equal(row.origin, "slash");
      assert.equal(String(row.actor_user_id), String(ids.human));
      assert.deepEqual(JSON.parse(row.details_json).patch, {
        decay_min_messages: 0,
        decay_window_days: 1,
        decay_percent: 0.95,
      });

      // Mirror embed: percent line rewritten as percents, enabled line
      // SKIPPED (unchanged keys never appear).
      const titles = await msgTitles(ids.channel2);
      assert.equal(
        titles.filter((t) => t === "Decay settings updated").length,
        1,
        `one decay mirror (got: ${JSON.stringify(titles)})`,
      );
      const changes = await embedChanges(ids.channel2, "Decay settings updated");
      assert.ok(changes.includes("`decay_percent`: 10% → **95%**"), changes);
      assert.ok(changes.includes("`decay_min_messages`: 20 → **0**"), changes);
      assert.ok(changes.includes("`decay_window_days`: 7 → **1**"), changes);
      assert.ok(!changes.includes("decay_enabled"), "unchanged key skipped");

      // Empty patch: the ONLY validation-flavored refusal on the surface.
      const updBefore = auditCount("decay.settings_update");
      assert.equal(
        await contentOf(await slash("setdecay")),
        "No decay settings provided to update.",
      );
      assert.equal(auditCount("decay.settings_update"), updBefore, "empty patch wrote nothing");

      // Same-value patch: row + audit YES, mirror embed NO (diff empty).
      assert.equal(
        (await embed0(await slash("setdecay", [intOpt("messages", -5)])).catch(() => ({}))).title,
        "Updated decay settings",
        "same-value patch still echoes the merged row",
      );
      assert.equal(auditCount("decay.settings_update"), updBefore + 1, "same-value still audits");
      assert.equal(
        (await msgTitles(ids.channel2)).filter((t) => t === "Decay settings updated").length,
        1,
        "same-value patch posted NO mirror",
      );
    });

    // ---- slash-origin roster completion + fall-through ---------------------

    it("slash-origin roster: /warn add writes warnings.add (origin slash, actor, target, reason); bare /setlog is a silent no-reply fall-through", async () => {
      // Issue #326 matrix row: seeded staff action ⇒ admin_audit carries
      // slash-origin metadata (mirrors unit admin-audit-slash-origin; the
      // xp.grant row is already pinned by ns5 e2e-xp.test.js).
      const inter = await slash("warn", [
        sub("add", [userOpt("user", ids.target), strOpt("reason", "ns21 audit probe")]),
      ]);
      const embed = await embed0(inter);
      assert.match(String(embed.title), /W-\d+/, `warn add embed (got: ${embed.title})`);
      const row = auditRow("warnings.add");
      assert.equal(row.origin, "slash");
      assert.equal(String(row.actor_user_id), String(ids.human));
      assert.equal(Number(row.community_id), env.communityId);
      assert.equal(row.target_type, "user");
      assert.equal(String(row.target_id), String(ids.target));
      assert.equal(JSON.parse(row.details_json).reason, "ns21 audit probe");

      // Bare /setlog (no subcommand): handler matches no branch and replies
      // NOTHING — the interaction stays unresponded (silent fall-through,
      // pinned as CURRENT behavior; awaiting a reply would just time out).
      const bare = await slash("setlog");
      const state = await env.mock.interactionState(bare.id);
      assert.ok(
        state.response_json == null,
        `bare /setlog never responded (got: ${JSON.stringify(state).slice(0, 160)})`,
      );
    });

    // ---- honest gaps ---------------------------------------------------------

    it.todo("decay TICKER apply arm: cron is 04:00-local daily (no runImmediately, no time seam) — apply math pinned offline by test/integration/decay.test.js; forced-tick (runDecayForGuild) precedented but deferred per issue #326");

    it.todo("/setlog `I can't find channel <#id>…` arm — fauxcord only resolves channel ids that have rows, so fetchChannel-null is unreachable (bogus ids prove the Provide-a-channel copy instead)");

    it.todo("retention: exposes NO interaction surface (no commands/handlers — ticker-only feature; docs/e2e.md carries the out-of-scope note per issue #326)");
  },
);
