"use strict";
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll, namespaceIds } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — see e2e-buttons/e2e-reactions headers.

/**
 * Tier-4 gork coverage (issue #327). Namespace 22.
 *
 * Issue-matrix correction pinned by this suite: there is NO `/gork ask` and
 * no GEMINI_API_KEY on disk — the AI seam is src/core/ai.js getAiConfig()
 * (AI_API_KEY / AI_BASE_URL / AI_MODEL, READ AT CALL TIME), and the question
 * surface is the MESSAGE keyword trigger. Matrix row 1 ("no key → specific
 * actionable reply") is therefore TWO truths: the keyless keyword trigger is
 * FULLY SILENT by design (silence IS the product decision — pinned), and
 * `/gork status` says `**not configured**`. Model calls stay out of scope
 * (todos name the fixtures); everything else is real: gates, the full
 * config-subcommand matrix with exact copies + the 10-action admin_audit
 * roster + guild_settings persistence, bans/memory/budget DB round-trips,
 * the summarize refusal ladder, and a FAKE-KEY network degradation via the
 * base-URL seam (AI_API_KEY="ns22-fake" + http://127.0.0.1:9 discard port —
 * clearly-fake placeholder per the no-secrets rule; ECONNREFUSED is local).
 *
 * Tier-2 parity cites: test/integration/gork.test.js (keyless silence :673,
 * ban flow :1370, queue/gates), gork-budget.test.js, gork-summarize.test.js,
 * gork-interaction-log.test.js. Tier-4 delta here = real router/register
 * wire, picker "32", admin_audit rows from live slashes, mock option-
 * resolution quirks (bogus USER/CHANNEL ids drop from resolved), and the
 * env seams driving degradation through the real gateway pipeline.
 */
describe(
  "e2e: gork — config subcommand matrix, audit roster, bans/memory/budget round-trips, keyless silence + fake-key network degradation",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    const ids = namespaceIds(22);
    const MSG_DENIED = "You don't have permission to use this.";

    // Tier-2 hygiene idiom (integration/gork.test.js): scrub every env the
    // gork surfaces re-read at call time, restore on teardown.
    const AI_ENV_KEYS = [
      "AI_API_KEY",
      "AI_BASE_URL",
      "AI_MODEL",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "SEARXNG_URL",
      "GORK_LLM_MAX_TOKENS",
      "GORK_LLM_TIMEOUT_MS",
      "GORK_LLM_MAX_TOOL_ROUNDS",
      "GORK_LLM_THINKING_TOKEN_BUDGET",
      "GORK_MAX_ANSWER_CHARS",
      "GORK_SUMMARIZE_TURN_TIMEOUT_MS",
    ];
    const savedEnv = {};

    before(async () => {
      for (const k of AI_ENV_KEYS) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
      env = await createE2eEnv({
        ns: 22,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "gork-log" },
          { id: ids.category, name: "cats", type: 4 },
        ],
      });
      // MG + ViewChannel (the mock grants ONLY explicit bits; the summarize
      // reader gate computes permissionsFor(member) from this mask).
      const adminRole = await env.mock.createRole("E2E Gork Admin", {
        permissions: String(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ViewChannel),
      });
      await env.mock.grantRole(env.ids.human, adminRole.id);
      // Junior staff_roles (bitless) for the served-vs-denied gate pin.
      const junior = await env.mock.createRole("E2E Gork Junior");
      await env.mock.grantRole(env.ids.target, junior.id);
      env.dbmod.addStaffRole(env.communityId, String(junior.id), "junior");
    });

    after(async () => {
      for (const k of AI_ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await env?.cleanup();
    });

    // ---- helpers ------------------------------------------------------------

    const sub = (name, options = []) => ({ name, type: 1, ...(options.length && { options }) });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const boolOpt = (name, value) => ({ name, type: 5, value });
    const userOpt = (name, id) => ({ name, type: 6, value: id });

    const slash = (options = [], who = env.ids.human) =>
      env.mock.slash({ command: "gork", options, userId: who });
    const replyOf = async (inter) => env.mock.awaitSettledReply(inter);
    const contentOf = async (inter) => String((await replyOf(inter)).content);
    const embed0 = async (inter) => (await replyOf(inter)).embeds?.[0] ?? {};
    const gork = async (options = [], who = env.ids.human) => contentOf(await slash(options, who));

    const settings = () => env.dbmod.getGuildSettings(env.communityId);
    const statusFields = async () =>
      Object.fromEntries(
        (((await replyOf(await slash([sub("status")]))).embeds?.[0] ?? {}).fields ?? []).map(
          (f) => [f.name, f.value],
        ),
      );

    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);
    const auditTotal = () =>
      env.dbmod.db
        .prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE community_id = ?")
        .get(env.communityId).n;

    const botMsgs = async (channelId) =>
      ((await env.mock.messages(channelId)) ?? []).filter(
        (m) => String(m?.author?.id ?? "") === String(ids.app),
      );

    // ---- gates / picker / fall-through ---------------------------------------

    it("gates: /gork picker carries ManageGuild, outsider denied ZERO-WRITE, junior staff_roles SERVED, bare /gork names the unknown sub", async () => {
      const cmds = await env.mock.listGuildCommands();
      const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));
      assert.ok(byName.gork, "gork registered");
      assert.equal(String(byName.gork.default_member_permissions), "32");

      assert.equal(await gork([sub("status")], ids.outsider), MSG_DENIED);
      assert.equal(
        await gork([sub("ban", [userOpt("user", ids.target)])], ids.outsider),
        MSG_DENIED,
      );
      assert.equal(
        env.dbmod.db
          .prepare("SELECT COUNT(*) AS n FROM gork_user_blocks WHERE community_id = ?")
          .get(env.communityId).n,
        0,
        "denied ban wrote no rows",
      );
      assert.equal(auditTotal(), 0, "denials wrote no audit rows");

      // Junior (staff_roles, zero permission bits) is served — staff tier.
      const juniorStatus = await replyOf(await slash([sub("status")], ids.target));
      assert.equal(juniorStatus.embeds?.[0]?.title, "Gork status");

      // No subcommand at all → getSubcommand null → the named-unknown copy.
      assert.equal(
        await gork(),
        "Unknown gork subcommand: `null`.",
      );
    });

    // ---- status defaults (keyless scrubbed) ----------------------------------

    it("/gork status renders ALL defaults keyless (AI provider `not configured`) and writes nothing", async () => {
      const totalBefore = auditTotal();
      const f = await statusFields();
      assert.deepEqual(f, {
        Enabled: "on",
        Keyword: "`@gork`",
        // #174: role-mention trigger row (unset on a fresh guild).
        "Role trigger": "not set",
        "Context window": "10 messages",
        // #705: tool-round budget — fresh guild never set → "(global)" tag.
        "Tool rounds": "50 (global)",
        Cooldown: "180s per user (staff bypass)",
        Rules: "none",
        "Search (SearXNG)": "on",
        "STE answer style": "off",
        "AI provider": "**not configured**", // env read LIVE — keyless scrub
        "SearXNG URL": "not set",
        "Banned users": "0",
        Memory: "off",
        "Interaction Log": "On (0 rows)",
        Budget: "default unlimited · 0 rules",
        "Summarize budget": "80000 input tokens",
        // #33b9d97 added the Q&A Log line (dedicated /gork logchannel);
        // the fresh e2e guild never sets one → audit-log fallback.
        "Q&A Log": "audit log (fallback)",
      });
      assert.equal(auditTotal(), totalBefore, "status is read-only");
    });

    // ---- keyword / context / cooldown / rules --------------------------------

    it("keyword+context+cooldown+rules: exact echoes, handler refusals, audits (guild-target), status round-trips, keyword-clear semantics", async () => {
      // --- keyword
      assert.equal(
        await gork([sub("keyword", [strOpt("keyword", "snark")])]),
        "Gork keyword set to `snark`. Trigger it with `snark <question>`, or `snark` replying to a message.",
      );
      assert.equal(settings().gork_keyword, "snark");
      let row = auditRow("gork.keyword_set");
      assert.equal(row.origin, "slash");
      assert.equal(String(row.actor_user_id), String(ids.human));
      assert.equal(row.target_type, "guild");
      assert.equal(String(row.target_id), String(ids.guild), "EXTERNAL snowflake, not community id");
      assert.deepEqual(JSON.parse(row.details_json), { keyword: "snark", cleared: false });

      const f1 = await statusFields();
      assert.equal(f1.Keyword, "`snark`");

      assert.equal(
        await gork([sub("keyword", [strOpt("keyword", "x".repeat(51))])]),
        "The keyword must be 1-50 characters (or `clear` to disable gork).",
      );

      assert.equal(
        await gork([sub("keyword", [strOpt("keyword", "clear")])]),
        "Gork is now **disabled** for this server — triggers are ignored.",
      );
      assert.equal(settings().gork_keyword, null, "clear stores NULL (triggers ignored)");
      assert.equal((await statusFields()).Keyword, "disabled");
      assert.deepEqual(JSON.parse(auditRow("gork.keyword_set").details_json), {
        keyword: null,
        cleared: true,
      });

      // --- context
      assert.equal(
        await gork([sub("context", [intOpt("context", 25)])]),
        "Gork context window set to **25** prior messages.",
      );
      assert.equal(Number(settings().gork_context_window), 25);
      assert.equal(auditRow("gork.context_set").origin, "slash");
      assert.deepEqual(JSON.parse(auditRow("gork.context_set").details_json), {
        context_window: 25,
      });
      for (const bad of [0, 51]) {
        assert.equal(
          await gork([sub("context", [intOpt("context", bad)])]),
          "The context window must be 1-50 messages.",
        );
      }

      // --- cooldown (0 is a VALID special case with its own copy)
      assert.equal(
        await gork([sub("cooldown", [intOpt("cooldown", 0)])]),
        "Gork cooldown is now **disabled** (0s). Staff always bypass.",
      );
      assert.equal(Number(settings().gork_cooldown_sec), 0);
      assert.equal(
        await gork([sub("cooldown", [intOpt("cooldown", 3600)])]),
        "Gork cooldown set to **3600s** per user per server. Staff always bypass.",
      );
      assert.deepEqual(JSON.parse(auditRow("gork.cooldown_set").details_json), {
        cooldown_sec: 3600,
      });
      assert.equal(
        await gork([sub("cooldown", [intOpt("cooldown", 3601)])]),
        "The cooldown must be 0-3600 seconds (0 = disabled).",
      );

      // --- rules (stored raw; clear writes EMPTY STRING not NULL)
      assert.equal(
        await gork([sub("rules", [strOpt("rules", "no spoilers")])]),
        "Gork staff rules set to:\n`no spoilers`\n\nThey are appended to the system prompt; the SFW / questions-only guardrails always apply.",
      );
      assert.equal(settings().gork_extra_rules, "no spoilers");
      assert.deepEqual(JSON.parse(auditRow("gork.rules_set").details_json), {
        rules: "no spoilers",
        cleared: false,
      });
      assert.equal(
        await gork([sub("rules", [strOpt("rules", "   ")])]),
        "Rules cannot be empty — use `clear` to remove them.",
      );
      assert.equal(
        await gork([sub("rules", [strOpt("rules", "x".repeat(501))])]),
        "Rules must be at most 500 characters.",
      );
      assert.equal(await gork([sub("rules", [strOpt("rules", "clear")])]), "Gork staff rules removed.");
      assert.equal(settings().gork_extra_rules, "");

      // status round-trip after the churn
      const f = await statusFields();
      assert.deepEqual([f["Context window"], f.Cooldown, f.Rules], ["25 messages", "3600s per user (staff bypass)", "none"]);
    });

    // ---- toggles: search / ste / enable / log ---------------------------------

    it("toggles: search+ste+enable+log on/off exact copies + audits where defined; choice-string refusals; `log` interpolates the live interaction-row count", async () => {
      assert.equal(
        await gork([sub("search", [strOpt("search", "off")])]),
        "Gork web search is now **off** — answers come from conversation context only.",
      );
      assert.equal(Number(settings().gork_search_enabled), 0);
      assert.deepEqual(JSON.parse(auditRow("gork.search_set").details_json), { enabled: 0 });

      assert.equal(
        await gork([sub("ste", [strOpt("ste", "on")])]),
        "Gork STE answer style is now **on** — answers follow the anti-slop writing rules (short active sentences, answer first, no padding). The sarcasm stays.",
      );
      assert.equal(Number(settings().gork_ste_enabled), 1);
      assert.equal(auditRow("gork.ste_set").target_type, "guild");

      // choice-string refusals (builder restricts choices; the mock does not —
      // the HANDLER refusal is the assertion layer).
      assert.equal(await gork([sub("search", [strOpt("search", "maybe")])]), "Search must be `on` or `off`.");
      assert.equal(await gork([sub("ste", [strOpt("ste", "yes")])]), "STE must be `on` or `off`.");
      assert.equal(
        await gork([sub("enable", [strOpt("enable", "sideways")])]),
        "Enable must be `on` or `off`.",
      );

      assert.equal(
        await gork([sub("enable", [strOpt("enable", "off")])]),
        "Gork is now **disabled** for this server — all triggers are ignored. Every other gork setting is kept; re-enable with `/gork enable on`.",
      );
      assert.equal(Number(settings().gork_enabled), 0);
      assert.deepEqual(JSON.parse(auditRow("gork.enabled_set").details_json), { enabled: 0 });
      assert.equal((await statusFields()).Enabled, "**off** (server disabled)");
      assert.equal(
        await gork([sub("enable", [strOpt("enable", "on")])]),
        "Gork is now **enabled** for this server — keyword triggers are active again.",
      );

      // log: no validation copy (non-true silently writes 0) + live count.
      assert.equal(
        await gork([sub("log", [boolOpt("enabled", false)])]),
        "Gork interaction log is now **off** — agent calls are no longer recorded (`0` rows remain; they age out with retention).",
      );
      assert.equal(Number(settings().gork_interaction_log_enabled), 0);
      assert.equal(
        await gork([sub("log", [boolOpt("enabled", true)])]),
        "Gork interaction log is now **on** — every gork agent call in this server is recorded (`0` rows stored so far).",
      );
      const auditTotalNow = auditTotal();
      assert.ok(
        !(await env.dbmod.db
          .prepare("SELECT 1 FROM admin_audit WHERE community_id = ? AND action LIKE 'gork.log%' LIMIT 1")
          .get(env.communityId)),
        "log toggle writes NO admin_audit row (mirror embed is its only trace)",
      );
      assert.equal(auditTotal(), auditTotalNow);
    });

    // ---- bans lifecycle --------------------------------------------------------

    it("bans: ban→bans-list→unban→unban-again with exact copies + user-target audits; idempotent re-ban keeps ONE row; bogus user refused", async () => {
      assert.equal(await gork([sub("bans")]), "No users are banned from gork in this server.");

      assert.equal(
        await gork([sub("ban", [userOpt("user", ids.target)])]),
        `<@${ids.target}> is now **banned from gork** in this server — triggers get the generic "brain went to lunch" reply (they are not told it's a ban). Lift it with \`/gork unban\`.`,
      );
      let row = auditRow("gork.ban");
      assert.equal(row.origin, "slash");
      assert.equal(row.target_type, "user");
      assert.equal(String(row.target_id), String(ids.target));

      // Idempotent (INSERT OR IGNORE): re-ban keeps exactly one row.
      await gork([sub("ban", [userOpt("user", ids.target)])]);
      assert.equal(
        env.dbmod.db
          .prepare("SELECT COUNT(*) AS n FROM gork_user_blocks WHERE community_id = ?")
          .get(env.communityId).n,
        1,
      );

      const list = await gork([sub("bans")]);
      assert.equal(list, `**Gork bans (1):**\n- <@${ids.target}>`);
      assert.equal((await statusFields())["Banned users"], "1");

      assert.equal(await gork([sub("unban", [userOpt("user", ids.target)])]), `<@${ids.target}> can use gork again in this server.`);
      assert.equal(auditRow("gork.unban").target_type, "user");
      assert.ok(
        (await gork([sub("unban", [userOpt("user", ids.target)])])).includes("is not banned from gork"),
      );

      // Bogus USER id (no mock users row) never enters data.resolved →
      // getUser null → the "pick a user" copy (ns21's CHANNEL doctrine for USER).
      assert.equal(
        await gork([sub("ban", [userOpt("user", "999999999999999999")])]),
        "Pick a user to ban from gork.",
      );
    });

    // ---- memory round-trips ------------------------------------------------------

    it("memory: seeded rows render/forget/clear with previews, budget CLAMPS, unknown action refused — and ZERO admin_audit rows (embed-only audit)", async () => {
      const totalBefore = auditTotal();
      const seed = (title, body, subject = ids.target) =>
        env.dbmod.gorkMemoryUpsert({
          communityId: env.communityId,
          subjectUserId: subject,
          memDate: "2026-10-16",
          title,
          titleKey: title.toLowerCase().replace(/\s+/g, "-"),
          body,
        });
      const m1 = seed("likes coffee", "Prefers espresso, always after midnight.");
      assert.ok(m1.id > 0 && m1.created);

      const showUser = await gork([sub("memory", [strOpt("action", "show"), userOpt("user", ids.target)])]);
      assert.ok(showUser.includes(`**Gork memories for <@${ids.target}> (1):**`), showUser);
      assert.ok(
        showUser.includes(`#${m1.id} — <@${ids.target}> — 2026-10-16 · likes coffee: Prefers espresso, always after midnight.`),
        `memory line format (got: ${showUser})`,
      );
      assert.ok(
        (await gork([sub("memory", [strOpt("action", "show")])])).includes("**Gork memories (newest 1):**"),
      );

      // forget: bad id / miss / hit
      assert.equal(
        await gork([sub("memory", [strOpt("action", "forget")])]),
        "`id` must be a positive whole number — the `#id` handle from `/gork memory show`.",
      );
      assert.equal(
        await gork([sub("memory", [strOpt("action", "forget"), intOpt("id", 999999)])]),
        "No memory #999999 in this guild.",
      );
      assert.equal(
        await gork([sub("memory", [strOpt("action", "forget"), intOpt("id", m1.id)])]),
        `Forgot memory **#${m1.id}** — \`likes coffee\` (about <@${ids.target}>).`,
      );

      // clear: preview → confirm, with the nothing-to-erase arm
      const m2 = seed("team color", "Wears green on Fridays.", ids.outsider);
      assert.equal(
        await gork([sub("memory", [strOpt("action", "clear"), userOpt("user", ids.outsider)])]),
        `This will erase **1** memories for <@${ids.outsider}>. Re-run with \`confirm: true\` to actually erase.`,
      );
      assert.equal(
        await gork([
          sub("memory", [strOpt("action", "clear"), userOpt("user", ids.outsider), boolOpt("confirm", true)]),
        ]),
        `Erased **1** memories for <@${ids.outsider}>.`,
      );
      assert.equal(
        await gork([sub("memory", [strOpt("action", "clear"), userOpt("user", ids.outsider)])]),
        `No memories stored for <@${ids.outsider}> — nothing to erase.`,
      );
      env.dbmod.gorkMemoryDeleteForGuild(env.communityId); // housekeeping

      // on/off toggles + budget CLAMPS (handler-level: -5→default, 99999→cap)
      assert.equal(
        await gork([sub("memory", [strOpt("action", "on")])]),
        "Gork memory is now **on** — gork extracts durable facts about people after each answer and remembers them. Turn it off again with `/gork memory off`.",
      );
      assert.equal(Number(settings().gork_memory_enabled), 1);
      assert.equal(
        await gork([sub("memory", [strOpt("action", "budget"), intOpt("chars", -5)])]),
        "Gork memory budget set to **12000** chars. `0` = unlimited.",
      );
      assert.equal(
        await gork([sub("memory", [strOpt("action", "budget"), intOpt("chars", 99999)])]),
        "Gork memory budget set to **64000** chars. `0` = unlimited.",
      );
      assert.equal(
        await gork([sub("memory", [strOpt("action", "budget")])]),
        "Provide `chars` — the memory-block budget in characters (0–64000; 0 = unlimited).",
      );
      assert.match((await statusFields()).Memory, /^on · 64000 chars · 0 stored$/);

      assert.equal(await gork([sub("memory", [strOpt("action", "dance")])]), "Unknown memory action: `dance`.");
      assert.equal(auditTotal(), totalBefore, "memory arms write ZERO admin_audit rows");
    });

    // ---- daily budget rules --------------------------------------------------------

    it("budget: default CLAMPS (-500→blocked, 5000→1000), channel/category rules + kind mismatches, remove arms, list embed — all audit-free", async () => {
      const totalBefore = auditTotal();

      assert.equal(
        await gork([sub("budget", [strOpt("action", "default"), intOpt("limit", 5000)])]),
        "Guild-default daily budget set to **1000/day** (`1000`).",
      );
      assert.equal(Number(settings().gork_daily_limit), 1000, "settings layer clamps silently");
      assert.equal(
        await gork([sub("budget", [strOpt("action", "default"), intOpt("limit", -500)])]),
        "Guild-default daily budget set to **blocked** (`-1`).",
      );
      assert.equal(
        await gork([sub("budget", [strOpt("action", "default")])]),
        "Provide `limit`: `-1` blocked · `0` unlimited · `1–1000` successful answers per user per UTC day.",
      );

      assert.equal(
        await gork([
          sub("budget", [strOpt("action", "channel"), intOpt("limit", 3), chanOpt("target", ids.channel2)]),
        ]),
        `Daily gork budget for channel <#${ids.channel2}> is now **3/day** (\`3\`).`,
      );
      assert.equal(
        await gork([
          sub("budget", [strOpt("action", "category"), intOpt("limit", 2), chanOpt("target", ids.category)]),
        ]),
        `Daily gork budget for category \`${ids.category}\` (\`cats\`) is now **2/day** (\`2\`).`,
      );

      // Kind mismatches (handler-checked; the mock passes anything through).
      assert.equal(
        await gork([
          sub("budget", [strOpt("action", "category"), intOpt("limit", 1), chanOpt("target", ids.channel2)]),
        ]),
        "`target` must be a **category** for `category` rules (a rule on a text channel belongs to `channel`).",
      );
      assert.equal(
        await gork([
          sub("budget", [strOpt("action", "channel"), intOpt("limit", 1), chanOpt("target", ids.category)]),
        ]),
        "`target` must be a **channel/thread** for `channel` rules (use `category` for categories).",
      );

      // list embed shows both rules.
      const embed = await embed0(await slash([sub("budget", [strOpt("action", "list")])]));
      assert.equal(embed.title, "Gork daily budgets");
      const lf = Object.fromEntries((embed.fields ?? []).map((x) => [x.name, x.value]));
      assert.equal(lf["Guild default"], "blocked");
      assert.ok(lf.Rules.includes(`Channel <#${ids.channel2}> — **3/day** · by <@${ids.human}>`), lf.Rules);
      assert.ok(lf.Rules.includes(`Category \`${ids.category}\` — **2/day** · by <@${ids.human}>`), lf.Rules);
      assert.match((await statusFields()).Budget, /^default blocked · 2 rules$/);

      // remove arms: picker hit, then raw-id miss.
      assert.equal(
        await gork([sub("budget", [strOpt("action", "remove_channel"), chanOpt("target", ids.channel2)])]),
        `Removed the channel budget rule for <#${ids.channel2}> — it falls back to its category → the guild default.`,
      );
      assert.equal(
        await gork([sub("budget", [strOpt("action", "remove_category"), strOpt("id", "123456789012345678")])]),
        "No `category` budget rule for `123456789012345678` in this server.",
      );

      assert.equal(auditTotal(), totalBefore, "budget arms write ZERO admin_audit rows");
    });

    // ---- summarize refusal ladder (keyless) ------------------------------------------

    it("/gork summarize (keyless): mode-gate copies verbatim, armed 10-min cooldown copy via the module seam, config-failure degradation + interaction-log row, summarize-budget arms", async () => {
      const MODE_HELP =
        "Give exactly one range: from:+to: (closed range), from: alone (through the newest message), or last:<N>";
      assert.equal(await gork([sub("summarize")]), `${MODE_HELP} — none was given.`);
      assert.equal(
        await gork([sub("summarize", [strOpt("from", "1"), intOpt("last", 5)])]),
        `${MODE_HELP} — got both from: and last:.`,
      );
      assert.equal(
        await gork([sub("summarize", [strOpt("to", "1")])]),
        `${MODE_HELP} — got to: without a from: anchor.`,
      );
      assert.equal(
        await gork([sub("summarize", [intOpt("last", 0)])]),
        'last: must be an integer between 1 and 1000 — got "0".',
      );

      // Guild rundown cooldown armed via the in-process seam (same process as
      // the bot): copy names the minutes; reset seam restores for later arms.
      const cooldown = require("../../src/features/gork/summarizeCooldown.js");
      cooldown.armSummarizeGuildCooldown(env.communityId);
      try {
        assert.equal(
          await gork([sub("summarize", [intOpt("last", 5)])]),
          "One rundown per server per 10 minutes — this server already posted one. Try again in **10 minutes**. Nothing was read or generated.",
        );
      } finally {
        cooldown.resetSummarizeGuildCooldownForTests();
      }

      // Restore unlimited: T7's clamp arm left the guild default BLOCKED
      // (-1) on purpose, and the budget gate sits before the queue — without
      // this the valid arm answers `gork isn't available in this server.`
      // (the locked blocked-surface copy, itself a real gate worth its pin).
      await gork([sub("budget", [strOpt("action", "default"), intOpt("limit", 0)])]);

      // Valid mode over real (injected) messages: range read runs against the
      // mock, generation fails at the KEY check → exact config copy + the
      // fixed retry sentence; a summarize interaction-log row must land.
      for (const c of ["one", "two", "three"]) await env.mock.inject(`summarize-me ${c}`, ids.target, ids.general);
      const gen = await gork([sub("summarize", [intOpt("last", 5)])]);
      assert.equal(
        gen,
        "gork summarize: AI is not configured — set AI_API_KEY (or OPENAI_API_KEY) to enable rundown generation.\n" +
          "Nothing was posted, no cooldown was armed, and your budget was not counted — you can retry.",
      );
      const summaryRows = env.dbmod.db
        .prepare("SELECT * FROM gork_interactions WHERE community_id = ? AND kind = 'summarize'")
        .all(env.communityId);
      assert.equal(summaryRows.length, 1, "one summarize log row");
      // Singular/plural interpolation flips with the live count (rows=1 → `row`).
      assert.match(
        await gork([sub("log", [boolOpt("enabled", false)])]),
        /\(`1` row remain/,
      );
      await gork([sub("log", [boolOpt("enabled", true)])]);

      // summarize-budget: REJECTS out of range (no clamp path), stores + audits.
      assert.equal(
        await gork([sub("summarize-budget", [intOpt("tokens", 7999)])]),
        "The summarize input token budget must be 8000-200000 tokens.",
      );
      assert.equal(
        await gork([sub("summarize-budget", [intOpt("tokens", 9000)])]),
        "Gork summarize input budget set to **9000** tokens (default 80000).",
      );
      assert.equal(Number(settings().gork_summarize_input_tokens), 9000);
      // #368 FIXED (word-component redaction): the budget COUNT survives —
      // it matched the old substring belt only because "tokens" contains
      // "token". Genuine credential keys are MASKED ("[redacted]"), never
      // silently dropped; the unit pin lives in
      // test/admin-audit-slash-origin.test.js.
      assert.deepEqual(JSON.parse(auditRow("gork.summarize_budget_set").details_json), {
        summarize_input_tokens: 9000,
      });
      assert.equal((await statusFields())["Summarize budget"], "9000 input tokens");
    });

    // ---- keyless silence + fake-key network degradation -------------------------------

    it("keyless keyword trigger is FULLY SILENT (matrix row 1); with a FAKE key + unreachable base URL the trigger answers the locked lunch reply — banned users get it too, without being told", async () => {
      // Keyword left at `gork` for the trigger arms.
      await gork([sub("keyword", [strOpt("keyword", "gork")])]);

      // 1) KEYLESS: getAiConfig() is read before keyword-matching, budget,
      //    cooldown, ban and the queue → NOTHING ever posts (product design:
      //    "gork is live whenever AI_API_KEY is set").
      // Oracle = ABSENCE of every copy the trigger path could produce (lunch
      // canned reply, budget-blocked line, question-echoed answer): with no
      // key the handler returns before the queue, so nothing CAN post. The
      // fake-key phase below proves the oracle discriminates (same tape,
      // same inject path, replies DO appear). Channel-message COUNTS are not
      // the oracle — the mock's stored-history view wobbles as interaction
      // callbacks get edited in place.
      const TRIGGER_COPIES = [
        "*gork's brain went to lunch* — try again in a bit.",
        "gork isn't available in this server.",
      ];
      const triggerCopyHits = async () =>
        (await botMsgs(ids.general)).filter(
          (m) =>
            TRIGGER_COPIES.includes(String(m.content)) ||
            String(m.content).includes("what is up"),
        ).length;
      await env.mock.inject("gork what is up", ids.outsider, ids.general);
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(await triggerCopyHits(), 0, "keyless triggers produce no reply of any kind");

      // 2) FAKE-KEY network degradation: clearly-fake placeholder key + the
      //    discard port → instant ECONNREFUSED, two tries, locked reply.
      process.env.AI_API_KEY = "ns22-fake";
      process.env.AI_BASE_URL = "http://127.0.0.1:9/v1";
      process.env.GORK_LLM_TIMEOUT_MS = "1500";
      try {
        // 2a) banned user: SHORT-CIRCUIT lunch reply (no network attempt) —
        //     and they are NOT told it's a ban.
        await gork([sub("ban", [userOpt("user", ids.outsider)])]);
        const LUNCH = TRIGGER_COPIES[0];
        const lunchCount = async () =>
          (await botMsgs(ids.general)).filter((m) => String(m.content) === LUNCH).length;
        // EXACT equality only: the /gork ban reply QUOTES "brain went to
        // lunch" inside its sentence and would pollute an `includes` oracle.
        await env.mock.inject("gork why am I sad", ids.outsider, ids.general);
        await poll(async () => (await lunchCount()) >= 1, {
          timeoutMs: 6000,
          label: "banned-user lunch reply",
        });
        assert.equal(await lunchCount(), 1, "banned path replied once");

        // 2b) NON-banned fresh user through the REAL network failure (one
        //     retry) → the same locked copy.
        await env.mock.inject("gork happy birthday", ids.target, ids.general);
        await poll(async () => (await lunchCount()) >= 2, {
          timeoutMs: 15000,
          label: "network-failure lunch reply",
        });

        await gork([sub("unban", [userOpt("user", ids.outsider)])]);
      } finally {
        delete process.env.AI_API_KEY;
        delete process.env.AI_BASE_URL;
        delete process.env.GORK_LLM_TIMEOUT_MS;
      }

      // 3) Scrubbed again → silence returns (call-time env reads, no boot cache).
      await env.mock.inject("gork are you back", ids.outsider, ids.general);
      await new Promise((r) => setTimeout(r, 1200));
      assert.ok(
        (await botMsgs(ids.general)).every(
          (m) => !String(m.content).includes("are you back") && !String(m.content).startsWith("You:"),
        ),
        "keyless silence restored after env restore (call-time env reads)",
      );
    });

    // ---- honest gaps --------------------------------------------------------------------

    it.todo("/gork summarize HAPPY rundown (real generation + embed render) needs a live AI key + fixtures — gate/read/booking math pinned offline by test/integration/gork-summarize.test.js");

    it.todo("gork Q&A answer content + web_search/read_discord/read_page/vision happy paths need live model + SearXNG fixtures (golden replays pin the offline math: test/integration/gork-replay.test.js)");

    it.todo("memory EXTRACTION turn (post-answer durable-fact write) is a model call — replay fixtures cover it offline (test/integration/gork-memory-replay.test.js)");

    it.todo("!gork Fluxer prefix surface (K10 id-only copies, overlay) + Fluxer keyword trigger + NOT_ON_FLUXER summarize arm are Fluxer-only — unreachable through the mock Discord surface");

    it.todo("/gork summarize queue-full drop copy — saturating the shared gorkQueue needs live in-flight LLM jobs (locked reply pinned offline by test/integration/gork.test.js:911); 10-min cooldown EXPIRY likewise (armed-side copy pinned here)");

    it.todo("/gork ban `Bots can't be banned from gork` arm — the mock's app user carries bot=1 but discord.js User.bot coercion from the numeric wire flag decides; probe kept OUT to avoid a flaky arm");

    it.todo("budget-set `Could not find <#id>…` + thread-parent-binding arms — fauxcord resolves only channel rows it owns and cannot provision threads (ns21's bogus-CHANNEL doctrine; thread normalization pinned offline by test/gork-budget-commands.test.js)");

    it.todo("interaction-log RETENTION (GORK_INTERACTION_LOG_RETENTION_DAYS lazy prune) is time-based — pinned offline by test/gork-interaction-log.test.js");
  },
);
