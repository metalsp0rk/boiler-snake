const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll, namespaceIds } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE TIME — importing anything that pulls in the db
// before createE2eEnv() sets the env vars silently binds the dev database.
// Lazily require src modules INSIDE tests instead.

/**
 * Tier-4 userinfo-views + user-activity coverage (issue #320). Namespace 15:
 * everything ns2 (e2e-buttons) does not touch — the `ui:w:` warnings view
 * (seeded via real /warn add, voided marker), `ui:a:`/`ui:c:` activity views
 * rendered from injected message history (live pipeline feeds the daily
 * counters), the window/page toggle matrix (aw/ap disabled invariants),
 * `ui:b:` PER-USER BACKFILL counting pre-watermark history injected with
 * REAL PAST TIMESTAMPS (mock patch v8 — the message snowflake encodes
 * `created_timestamp`, which is exactly what `backfillChannelHistory` keys
 * off), the backfill running-state UI (disabled Danger button + progress
 * label while the detached job sleeps between pages), `/userinfo` for the
 * BOT member (Bot field) and non-member ghost (renders without join data),
 * the `user_<id>` resolve fallback on a forged `ui:o:` click for an id with
 * no user row at all, and the full `/activityconfig` surface (ignore add/
 * list/remove incl. kind-type mismatches + duplicates, live-count
 * suppression through the ignore list, status rollup lines, guild
 * `backfill all` start → mid-run `cancel` → cancelled settings + audits,
 * cancel-with-nothing-running).
 *
 * ns2 already pins: panel render, ui:o/n round-trip, junior senior-denial,
 * unknown control, non-staff slash/click denials — not repeated here.
 *
 * Cross-feature note: the backfill COUNTED arm was untestable before patch
 * v8 (every injected message was "now" ⇒ always ≥ watermark ⇒ counted 0).
 */
describe(
  "e2e: userinfo views + user activity — ui:w/a/c/b, backfill counts, /activityconfig",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    let junior; // 4th member: junior staff (extra ghost-slot-adjacent id)
    const warnLog = () => env.ids.channel2;

    before(async () => {
      const ids = namespaceIds(15);
      junior = String(Number(ids.ghost) + 1);
      env = await createE2eEnv({
        ns: 15,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "warn-log" },
          { id: ids.category, name: "staff-cats", type: 4 },
        ],
      });
      const mgRole = await env.mock.createRole("E2E UA Senior MG", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, mgRole.id);

      // Junior staff on a FOURTH member (outsider stays a pure non-staff
      // control): junior passes requireStaff but fails requireSeniorStaff.
      await env.mock.createUser("E2EJunior", junior);
      await env.mock.inject(`member-bootstrap ${junior}`, junior, env.ids.general);
      const jrRole = await env.mock.createRole("E2E UA Junior");
      await env.mock.grantRole(junior, jrRole.id);
      const addRole = await env.mock.slash({
        command: "staff",
        options: [
          {
            name: "role",
            type: 2,
            options: [
              {
                name: "add",
                type: 1,
                options: [
                  { name: "role", type: 8, value: jrRole.id },
                  { name: "level", type: 3, value: "junior" },
                ],
              },
            ],
          },
        ],
      });
      await env.mock.awaitSettledReply(addRole);
    });

    after(async () => {
      const { setBackfillPageDelayForTests } = require("../../src/features/userActivity/backfill");
      setBackfillPageDelayForTests(null);
      await env?.cleanup();
    });

    const sub = (name, options = []) => ({
      name,
      type: 1,
      ...(options.length && { options }),
    });
    const grp = (name, subName, options = []) => ({
      name,
      type: 2,
      options: [sub(subName, options)],
    });
    const userOpt = (name, id) => ({ name, type: 6, value: id });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const intOpt = (name, value) => ({ name, type: 4, value });

    const slash = (command, options, who = env.ids.human) =>
      env.mock.slash({ command, options, userId: who });
    const replied = async (inter) => env.mock.awaitSettledReply(inter);
    const contentOf = async (inter) => String((await replied(inter)).content);
    const embedOf = async (inter) => (await replied(inter)).embeds?.[0];
    const fieldOf = (embed, name) =>
      (embed?.fields ?? []).find((f) => f.name === name);

    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);
    const sumChan = (userId, channelId) =>
      env.dbmod
        .sumByChannel(env.communityId, userId, { sinceDay: null })
        .find((r) => r.channel_id === channelId)?.count ?? 0;
    const meta = (userId) =>
      env.dbmod.getUserActivityMeta(env.communityId, userId);
    const guildSettings = () =>
      env.dbmod.getGuildActivitySettings(env.communityId) ?? {};

    /** Buttons of the CURRENT content of a (mutated) message. */
    const buttonsOf = async (messageId, channelId = env.ids.general) => {
      const msg = await env.mock.message(messageId, channelId);
      return (msg.components ?? [])
        .flatMap((row) => row.components ?? [])
        .map((b) => ({
          id: String(b.custom_id),
          label: b.label,
          disabled: !!b.disabled,
        }));
    };
    const btn = (list, id) => {
      const b = list.find((x) => x.id === id);
      assert.ok(b, `button ${id} present (ids: ${list.map((x) => x.id)})`);
      return b;
    };

    const st = { card: null };

    it("/userinfo renders the staff card — member + BOT target; non-member ghost is discord.js-dark", async () => {
      const cardInter = await slash("userinfo", [userOpt("user", env.ids.target)], env.ids.human);
      const card = await replied(cardInter);
      const embed = card.embeds?.[0];
      assert.equal(embed.title, "Staff user card");
      assert.ok(String(embed.description).includes(env.ids.target));
      assert.ok(fieldOf(embed, "XP / Level").value.includes(" XP · Level "));
      assert.equal(fieldOf(embed, "Warnings").value, "**0** active");
      assert.ok(fieldOf(embed, "Staff notes").value.endsWith("active"));
      st.card = String(card.id);

      // BOT member target: resolved bot flag drives the Bot field.
      const botCard = await embedOf(
        await slash("userinfo", [userOpt("user", env.ids.app)], env.ids.human),
      );
      assert.equal(fieldOf(botCard, "Bot").value, "Yes");
      assert.ok(botCard.description.includes(env.ids.app));

      // Ghost (user row, NOT a member): discord.js v14 only resolves USER
      // options through `resolved.members` on guild interactions, and real
      // Discord never offers a non-member in the picker — the mock is
      // faithful here (it resolves `resolved.users` but discord.js still
      // refuses). The required-option throw lands on the router's
      // sanctioned generic. The BUTTON arm below (resolveUser with the
      // fetch-catch fallback) is the testable matrix row.
      assert.equal(
        await contentOf(await slash("userinfo", [userOpt("user", env.ids.ghost)])),
        "Something went wrong handling that command (check bot logs).",
      );
    });

    it("ui:w renders seeded warnings; active-view disabled invariants extend to w/a", async () => {
      // Real cross-feature seed: issue + void one warning for the target.
      const add = await slash(
        "warn",
        [sub("add", [userOpt("user", env.ids.target), strOpt("reason", "activity-seed spam")])],
      );
      const wN = Number(String((await embedOf(add))?.title).match(/W-(\d+)/)?.[1]);
      const voidEmbed = await embedOf(
        await slash("warn", [sub("void", [intOpt("id", wN), strOpt("reason", "appealed")])]),
      );
      assert.equal(voidEmbed.title, `Warning W-${wN} voided`);
      const w2 = await slash(
        "warn",
        [sub("add", [userOpt("user", env.ids.target), strOpt("reason", "still active")])],
      );
      const w2N = Number(String((await embedOf(w2))?.title).match(/W-(\d+)/)?.[1]);

      // Click Warnings on the live card → UPDATE_MESSAGE re-renders it.
      const click = await env.mock.click({
        customId: `ui:w:${env.ids.target}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      const msg = await poll(async () => {
        const m = await env.mock.message(st.card);
        return m.embeds?.[0]?.title?.startsWith("Warnings ·") ? m : null;
      }, { timeoutMs: 8000, label: "ui:w view render" });

      const embed = msg.embeds[0];
      assert.ok(embed.description.includes(env.ids.target));
      assert.match(embed.description, /\*\*1\*\* active · \*\*1\*\* voided/);
      const lines = embed.fields[0].value;
      assert.ok(lines.includes(`**W-${wN}**`), "voided warn row");
      assert.ok(lines.includes("~~voided~~"), "voided marker");
      assert.ok(lines.includes(`**W-${w2N}**`), "active warn row");

      // Disabled invariants on the warnings view (matrix row: extend to w).
      const buttons = await buttonsOf(st.card);
      assert.equal(btn(buttons, `ui:w:${env.ids.target}`).disabled, true, "w disabled on w-view");
      assert.equal(btn(buttons, `ui:o:${env.ids.target}`).disabled, false);
      assert.equal(btn(buttons, `ui:n:${env.ids.target}`).disabled, false);
      assert.equal(btn(buttons, `ui:a:${env.ids.target}`).disabled, false);
      assert.equal(btn(buttons, `ui:n:${env.ids.target}`).label, "Notes (0)");
      assert.equal(btn(buttons, `ui:w:${env.ids.target}`).label, `Warnings (${1} active)`);
    });

    it("ui:a renders from injected history (senior); ui:a for a subject with no rows is the empty state", async () => {
      // Fresh live history for the target (pipeline records injected msgs).
      for (let i = 0; i < 3; i += 1) {
        await env.mock.inject(`activity chat ${i}`, env.ids.target, env.ids.general);
      }

      const click = await env.mock.click({
        customId: `ui:a:${env.ids.target}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      const msg = await poll(async () => {
        const m = await env.mock.message(st.card);
        return m.embeds?.[0]?.title?.startsWith("Activity · Channels") ? m : null;
      }, { timeoutMs: 8000, label: "ui:a view render" });

      const embed = msg.embeds[0];
      assert.equal(embed.title, "Activity · Channels · All time");
      assert.match(embed.description, /Subject: <@.*> · `/);
      assert.match(embed.description, /\*\*Window total:\*\* \d+ · \*\*Lifetime:\*\* \d+/);
      assert.ok(embed.fields[0].value.startsWith("**1.**"), "rank list renders");
      assert.ok(
        embed.fields[0].value.includes("#general") || embed.fields[0].value.includes(env.ids.general),
        "rank line labels the channel",
      );
      assert.match(embed.footer.text, /Senior staff · posts\/wk = lifetime ÷ weeks since join/);

      // Full disabled matrix on the activity view (all-time, channels).
      const buttons = await buttonsOf(st.card);
      assert.equal(btn(buttons, `ui:a:${env.ids.target}`).disabled, true, "primary Activity disabled on own view");
      assert.equal(btn(buttons, `ui:aw:a:ch:${env.ids.target}`).disabled, true, "All-window disabled on all-time");
      assert.equal(btn(buttons, `ui:aw:7:ch:${env.ids.target}`).disabled, false);
      assert.equal(btn(buttons, `ui:aw:30:ch:${env.ids.target}`).disabled, false);
      assert.equal(btn(buttons, `ui:aw:90:ch:${env.ids.target}`).disabled, false);
      assert.equal(btn(buttons, `ui:ap:ch:a:${env.ids.target}`).disabled, true, "Channels disabled on channels page");
      assert.equal(btn(buttons, `ui:ap:ca:a:${env.ids.target}`).disabled, false);
      const backfill = btn(buttons, `ui:b:${env.ids.target}`);
      assert.equal(backfill.disabled, false);
      assert.equal(backfill.label, "Backfill history");

      // Empty state: forged ui:a for the ghost (senior clicker, no counters).
      const ghostClick = await env.mock.click({
        customId: `ui:a:${env.ids.ghost}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      await poll(async () => {
        const m = await env.mock.message(st.card);
        return String(m.embeds?.[0]?.fields?.[0]?.value).includes("No tracked messages yet") ? m : null;
      }, { timeoutMs: 8000, label: "ui:a ghost empty state" });

      // Restore the target's activity view for the toggle tests below.
      await env.mock.click({
        customId: `ui:a:${env.ids.target}`,
        messageId: st.card,
        userId: env.ids.human,
      });
    });

    it("window + page toggles re-render with rotated disabled states (aw:7, ap:ca)", async () => {
      const w7 = await env.mock.click({
        customId: `ui:aw:7:ch:${env.ids.target}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      await poll(async () => {
        const m = await env.mock.message(st.card);
        return m.embeds?.[0]?.title === "Activity · Channels · Last 7 days" ? m : null;
      }, { timeoutMs: 8000, label: "7d window view" });
      let buttons = await buttonsOf(st.card);
      assert.equal(btn(buttons, `ui:aw:7:ch:${env.ids.target}`).disabled, true, "7d now active");
      assert.equal(btn(buttons, `ui:aw:a:ch:${env.ids.target}`).disabled, false, "All re-enabled");

      const ca = await env.mock.click({
        customId: `ui:ap:ca:7:${env.ids.target}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      const catMsg = await poll(async () => {
        const m = await env.mock.message(st.card);
        return m.embeds?.[0]?.title === "Activity · Categories · Last 7 days" ? m : null;
      }, { timeoutMs: 8000, label: "categories page" });
      assert.ok(
        catMsg.embeds[0].fields[0].value.includes("Uncategorized"),
        "no parents wired ⇒ Uncategorized rollup",
      );
      buttons = await buttonsOf(st.card);
      assert.equal(btn(buttons, `ui:ap:ca:7:${env.ids.target}`).disabled, true);
      assert.equal(btn(buttons, `ui:ap:ch:7:${env.ids.target}`).disabled, false);
    });

    it("ui:b backfill counts PRE-WATERMARK history (patch v8 timestamps) and flips the UI", async () => {
      // 3 old warn-log messages (snowflake-encoded −30d ⇒ below watermark)
      // plus 1 live one: the live counter already has the fresh message,
      // backfill must add EXACTLY the 3 old ones (no double count — its
      // `ts >= watermark ⇒ skip` rule is what this pins).
      const old = Date.now() - 30 * 86400000;
      for (let i = 0; i < 3; i += 1) {
        await env.mock.inject(`old warn-log chat ${i}`, env.ids.target, warnLog(), { atMs: old + i });
      }
      await env.mock.inject("live warn-log chat", env.ids.target, warnLog());
      assert.equal(sumChan(env.ids.target, warnLog()), 1, "pre-backfill: only the live message counted");

      // Click Backfill on the activity view (back to channels/all-time via the primary row first).
      const click = await env.mock.click({
        customId: `ui:b:${env.ids.target}`,
        messageId: st.card,
        userId: env.ids.human,
      });

      // Detached job (one inter-page sleep per channel ⇒ ≥2 channels of
      // wall-clock room). A mid-run ui:a click must show the RUNNING UI:
      // progress label + disabled Danger button + "backfill: running" footer.
      const mid = await env.mock.click({
        customId: `ui:a:${env.ids.target}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      await poll(async () => {
        const m = await env.mock.message(st.card);
        return String(m.embeds?.[0]?.footer?.text).includes("backfill: running") ? m : null;
      }, { timeoutMs: 8000, label: "mid-run running footer" });
      const midButtons = await buttonsOf(st.card);
      const runningBtn = btn(midButtons, `ui:b:${env.ids.target}`);
      assert.equal(runningBtn.disabled, true, "backfill button disabled while running");
      assert.match(runningBtn.label, /^Backfill… \d+\/(\d|\?)/, "progress label (total may still be '?')");

      // #354 FIXED: update() consumes the interaction, and the handler now
      // follows up (replyOrFollowUpEphemeral) instead of replying into
      // InteractionAlreadyReplied. The stored response stays the activity
      // UPDATE, and the confirmation lands as a followup message.
      const resp = await poll(async () => {
        const s = await env.mock.interactionState(click.id);
        return s.response_json ? s.response_json : null;
      }, { timeoutMs: 8000, label: "ui:b interaction response stored" });
      assert.ok(resp.data?.embeds?.length, "response is the activity-view UPDATE");
      const follow = await poll(async () => {
        const msgs = await env.mock.messages(env.ids.general);
        return (
          msgs.find((m) => String(m.content ?? "").includes("Backfill started")) ?? null
        );
      }, { timeoutMs: 8000, label: "ui:b followup confirmation delivered" });
      assert.match(
        String(follow.content),
        /Backfill started\. History older than live tracking/,
        "#354: staff finally SEE the backfill confirmation (was silently thrown away)",
      );

      // Terminal state: done with every non-ignored text channel scanned.
      const doneMeta = await poll(async () => {
        const m = meta(env.ids.target);
        return m?.backfill_status === "done" ? m : null;
      }, { timeoutMs: 30000, label: "user backfill done" });
      assert.ok(doneMeta.backfill_channels_done >= 2, `channels scanned: ${doneMeta.backfill_channels_done}`);

      assert.equal(sumChan(env.ids.target, warnLog()), 4, "3 old + 1 live, counted once");
      assert.equal(sumChan(env.ids.target, env.ids.general) >= 1, true, "general history intact");

      // Final view: enabled ✓ button + done footer + warn-log ranking row.
      const final = await env.mock.click({
        customId: `ui:a:${env.ids.target}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      await poll(async () => {
        const m = await env.mock.message(st.card);
        return String(m.embeds?.[0]?.footer?.text).includes("backfill: done") ? m : null;
      }, { timeoutMs: 8000, label: "done footer" });
      const finalButtons = await buttonsOf(st.card);
      const doneBtn = btn(finalButtons, `ui:b:${env.ids.target}`);
      assert.equal(doneBtn.disabled, false);
      assert.equal(doneBtn.label, "Backfill ✓");
      void final;

      // Clicking Backfill again while a NEW job is impossible is fine; but
      // a SECOND click starts another pass — meta returns to done again and
      // counts stay stable (cursors make page 2 of each channel empty).
      await env.mock.click({
        customId: `ui:b:${env.ids.target}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      await poll(async () => {
        const m = meta(env.ids.target);
        return m?.backfill_status === "done" ? m : null;
      }, { timeoutMs: 30000, label: "second backfill done" });
      assert.equal(sumChan(env.ids.target, warnLog()), 4, "idempotent recount (cursor + watermark)");
    });

    it("/activityconfig staff gate: pure non-staff outsider denied, junior-staff passes", async () => {
      assert.equal(
        await contentOf(await slash("activityconfig", [grp("ignore", "list")], env.ids.outsider)),
        "You don't have permission to use this.",
      );

      // activityconfig is requireStaff-gated (NOT senior): the junior
      // fourth member passes — the matrix's "non-staff denial" reads as
      // the staff gate, which junior satisfies.
      assert.equal(
        await contentOf(await slash("activityconfig", [grp("ignore", "list")], junior)),
        "No ignored channels or categories. Honeypot channels are always skipped.",
      );

      // kind/type mismatches are refused BEFORE persisting.
      assert.equal(
        await contentOf(
          await slash("activityconfig", [grp("ignore", "add", [strOpt("kind", "category"), chanOpt("target", warnLog())])]),
        ),
        "Pick a **category** channel when kind is `category`.",
      );
      assert.equal(
        await contentOf(
          await slash("activityconfig", [grp("ignore", "add", [strOpt("kind", "channel"), chanOpt("target", env.ids.category)])]),
        ),
        "That target is a category. Use kind `category`, or pick a text channel.",
      );

      // Ignore the warn-log channel: live counting for NEW messages stops.
      assert.equal(
        await contentOf(
          await slash("activityconfig", [grp("ignore", "add", [strOpt("kind", "channel"), chanOpt("target", warnLog())])]),
        ),
        `Now ignoring **channel** <#${warnLog()}> in activity stats.`,
      );
      assert.equal(
        await contentOf(
          await slash("activityconfig", [grp("ignore", "add", [strOpt("kind", "channel"), chanOpt("target", warnLog())])]),
        ),
        `Already ignoring <#${warnLog()}>.`,
      );
      const list = await contentOf(await slash("activityconfig", [grp("ignore", "list")]));
      assert.match(list, /• \*\*channel\*\* <#/);

      const beforeCount = sumChan(env.ids.target, warnLog());
      await env.mock.inject("ignored chatter", env.ids.target, warnLog());
      assert.equal(sumChan(env.ids.target, warnLog()), beforeCount, "ignored channel not counted live");

      assert.equal(
        await contentOf(await slash("activityconfig", [grp("ignore", "remove", [chanOpt("target", warnLog())])])),
        `Removed <#${warnLog()}> from the activity ignore list.`,
      );
      assert.equal(
        await contentOf(await slash("activityconfig", [grp("ignore", "remove", [chanOpt("target", warnLog())])])),
        `<#${warnLog()}> was not on the ignore list.`,
      );
      await env.mock.inject("counted again", env.ids.target, warnLog());
      assert.equal(sumChan(env.ids.target, warnLog()), beforeCount + 1, "un-ignored channel counts again");

      for (const action of ["activity.ignore_add", "activity.ignore_remove"]) {
        assert.ok(auditRow(action), `admin_audit ${action}`);
      }
    });

    it("/activityconfig status rollup + guild backfill all → mid-run cancel → cancelled settings", async () => {
      const status0 = await contentOf(await slash("activityconfig", [sub("status")]));
      assert.match(status0, /Live collect from: /);
      assert.match(status0, /Daily counter rows: \*\*\d+\*\*/);
      assert.match(status0, /Ignore entries: \*\*0\*\*/);
      assert.match(status0, /Guild backfill: \*\*none\*\*/);

      // Unknown sub falls through the dispatcher copy.
      assert.equal(
        await contentOf(await slash("activityconfig", [grp("ignore", "bogus")])),
        "Unknown subcommand.",
      );

      // Start the guild-wide pass: deferred reply confirms the scan set.
      const start = await slash("activityconfig", [grp("backfill", "all", [intOpt("max_pages", 1)])]);
      const startText = await contentOf(start);
      assert.match(startText, /\*\*Guild backfill started\*\* for \*\*\d+\*\* channels/);
      assert.ok(auditRow("activity.backfill_start"));
      assert.equal(guildSettings().guild_backfill_status, "running");

      // Cancel lands while the detached job sleeps between pages.
      const cancel = await contentOf(await slash("activityconfig", [grp("backfill", "cancel")]));
      assert.match(cancel, /\*\*Backfill cancel\*\*/);
      assert.ok(auditRow("activity.backfill_cancel"));

      const settled = await poll(async () => {
        const s = guildSettings();
        return s.guild_backfill_status !== "running" ? s : null;
      }, { timeoutMs: 30000, label: "guild backfill settles" });
      assert.equal(settled.guild_backfill_status, "cancelled");
      assert.ok(settled.guild_backfill_channels_total >= 2);

      const status1 = await contentOf(await slash("activityconfig", [sub("status")]));
      assert.match(status1, /Guild backfill: \*\*cancelled\*\* · channels \d+\/\d+/);

      // Cancel with nothing running → dark copy.
      assert.match(
        await contentOf(await slash("activityconfig", [grp("backfill", "cancel")])),
        /No backfill is running in this server\./,
      );
    });

    it("ui:o button resolves unknown subjects: resolveUser catch → user_<id> fallback card", async () => {
      const ghostId = "999999999999999999"; // no users row at all
      const click = await env.mock.click({
        customId: `ui:o:${ghostId}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      const msg = await poll(async () => {
        const m = await env.mock.message(st.card);
        return String(m.embeds?.[0]?.description ?? "").includes(ghostId) ? m : null;
      }, { timeoutMs: 8000, label: "fallback card render" });

      // members.fetch 404 + users.fetch 404 → resolveUser's final fallback.
      const embed = msg.embeds[0];
      assert.equal(embed.title, "Staff user card");
      assert.equal(fieldOf(embed, "Username").value, `user_${ghostId}`);
      assert.equal(fieldOf(embed, "Warnings").value, "**0** active");

      // Ghost (row EXISTS but not a member): the client.users.fetch catch-
      // path resolves the real row — either outcome renders the card; the
      // counts prove the fallback chain completed without throwing.
      const ghostClick = await env.mock.click({
        customId: `ui:o:${env.ids.ghost}`,
        messageId: st.card,
        userId: env.ids.human,
      });
      await poll(async () => {
        const m = await env.mock.message(st.card);
        return String(m.embeds?.[0]?.description ?? "").includes(env.ids.ghost) ? m : null;
      }, { timeoutMs: 8000, label: "ghost overview card" });
    });

    it("junior staff may open w/o/n views but never Activity (senior gate, cross-checked from the OTHER side)", async () => {
      // ns2 pins the DENIAL side; here: junior CAN open the warnings view
      // (staff gate passes) — proving the senior gate is view-scoped.
      const click = await env.mock.click({
        customId: `ui:w:${env.ids.target}`,
        messageId: st.card,
        userId: junior,
      });
      await poll(async () => {
        const m = await env.mock.message(st.card);
        return m.embeds?.[0]?.title?.startsWith("Warnings ·") ? m : null;
      }, { timeoutMs: 8000, label: "junior warnings view" });

      const denied = await env.mock.click({
        customId: `ui:a:${env.ids.target}`,
        messageId: st.card,
        userId: junior,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        "Activity requires **senior** staff (or Manage Server). Ask an admin to set your role with `/staff role setlevel`.",
      );
    });
  },
);
