const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { j, poll, namespaceIds } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — importing anything that pulls in the db
// before createE2eEnv() sets the env vars silently binds the dev database.
// Lazily require src modules INSIDE tests instead.

/**
 * Tier-4 reaction-pipeline coverage (issue #321). Namespace 16: the full
 * `/reactionrole` lifecycle — panel create/list/edit/sync arms, the
 * PENDING-EMOJI message flow (`option add` → human sends "🎉" as the next
 * message → invalid-input "still waiting" arm → `stop` cancel → confirm +
 * option row + panel embed re-render + the bot's own seed reaction on the
 * panel), the CLAIM engine driven by injected REACTION_ADD/REMOVE (patch
 * v7 — the issue's "hard blocker" text was stale; ns23 proved the injection
 * plumbing): role grant + revoke on the mock member, unconfigured-emoji
 * STRIP arm, `removable:false` role persistence, the min-LEVEL gate (level
 * 5 option: reaction removed, role never granted), `option remove` pending
 * flow, panel deploy (config + options copied) → delete (row + message),
 * and the whole honeypot surface: `/honeypot channel add/list/del`, the
 * BAN leg fired by a bait post (admin_audit `honeypot.enforce`, ban row,
 * message deletion, audit-channel alert embed), the staff-role exemption
 * (delete-only, no ban, no second audit), the admin-only `/honeypot exempt`
 * trio (exempt roles land in staff_roles per the handler) honored on the
 * next bait, and the exempt-gate copy that NON-admins get.
 *
 * Reaction XP + cooldown + remove semantics are ALREADY pinned by ns23
 * (e2e-mockgaps gap-3 proof) — not repeated.
 *
 * #356 FIXED and pinned here: live claim/revoke POST the audit
 * embed (raw Client passed where OutboundClient required; silent catch).
 *
 * Documented dark arms (todos at the bottom): member-side DM copies (mock
 * cannot list DM channels). The honeypot warning-notice PNG was the last
 * multipart-gap casualty (#312) — delivered, now a live arm.
 */
describe(
  "e2e: reaction pipeline — /reactionrole pending-emoji flow, claims via injected reactions, honeypot enforcement",
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

    let junior; // 4th member, junior staff role (exempt-via-staff arm)
    let waiverUser; // 5th member, exempt-only via /honeypot exempt role
    let trap; // honeypot-trap channel (created mid-suite)
    const roles = {}; // { color, lock, star, mg, junior, waiver }
    const st = { panel: null, trapId: null };

    before(async () => {
      const ids = namespaceIds(16);
      env = await createE2eEnv({
        ns: 16,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "rr-logs" },
        ],
      });
      junior = String(Number(ids.ghost) + 1);
      waiverUser = String(Number(ids.ghost) + 2);

      roles.mg = await env.mock.createRole("E2E RR Admin MG", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, roles.mg.id);

      roles.junior = await env.mock.createRole("E2E RR Junior");
      await env.mock.createUser("E2EJunior", junior);
      await env.mock.inject(`member-bootstrap ${junior}`, junior, env.ids.general);
      await env.mock.grantRole(junior, roles.junior.id);
      // Honeypot exemption is by staff_roles membership — register it.
      await replied(
        await slash("staff", [grp("role", "add", [roleOpt("role", roles.junior.id), strOpt("level", "junior")])]),
      );

      roles.waiver = await env.mock.createRole("E2E RR Waiver");
      await env.mock.createUser("E2EWaiver", waiverUser);
      await env.mock.inject(`member-bootstrap ${waiverUser}`, waiverUser, env.ids.general);
      await env.mock.grantRole(waiverUser, roles.waiver.id);

      // Claim targets (bot must be able to assign; mock does not enforce
      // hierarchy, plain roles are fine).
      roles.color = await env.mock.createRole("E2E RR Color");
      roles.lock = await env.mock.createRole("E2E RR Lock");
      roles.star = await env.mock.createRole("E2E RR Star");

      // Audit channel for logReactionRoleChange / logHoneypotTrigger.
      env.dbmod.updateGuildSettings(env.communityId, {
        audit_log_channel_id: env.ids.channel2,
      });
    });

    after(async () => {
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
    const strOpt = (name, value) => ({ name, type: 3, value });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const roleOpt = (name, id) => ({ name, type: 8, value: id });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const boolOpt = (name, value) => ({ name, type: 5, value });

    const slash = (command, options, who = env.ids.human) =>
      env.mock.slash({ command, options, userId: who });
    const replied = async (inter) => env.mock.awaitSettledReply(inter);
    const contentOf = async (inter) => String((await replied(inter)).content);

    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);
    const auditCount = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT COUNT(*) AS n FROM admin_audit WHERE community_id = ? AND action = ?",
        )
        .get(env.communityId, action).n;

    const memberRoleIds = async (userId) => {
      try {
        const m = await api(`/guilds/${env.ids.guild}/members/${userId}`);
        // Mock shape: roles is a plain array of role-id STRINGS.
        return (m.roles ?? []).map((r) => String(typeof r === "string" ? r : r?.id));
      } catch (err) {
        if (err.status === 404) return [];
        throw err;
      }
    };
    const reactionMembers = async (messageId, emoji, channelId = env.ids.general) => {
      try {
        const rows = await api(
          `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
        );
        return (rows ?? []).map((r) => String(r.id ?? r.user?.id));
      } catch (err) {
        if (err.status === 404) return [];
        throw err;
      }
    };
    const banState = async (userId) => {
      try {
        await api(`/guilds/${env.ids.guild}/bans/${userId}`);
        return true;
      } catch (err) {
        if (err.status === 404) return false;
        throw err;
      }
    };
    const msgExists = async (channelId, messageId) => {
      try {
        await api(`/channels/${channelId}/messages/${messageId}`);
        return true;
      } catch (err) {
        if (err.status === 404) return false;
        throw err;
      }
    };
    const embedTitles = async () =>
      ((await env.mock.messages(logs())) ?? []).map((m) => m.embeds?.[0]?.title);

    const panelRow = (messageId) =>
      env.dbmod.getReactionRolePanel(env.communityId, messageId);

    // Delivery-verified pending flow. Root cause (proven via the #361
    // diagnostic + a scratch force-kill experiment): on the CI runner the
    // bot's gateway socket blinks mid-suite (~15s discord.js reconnect
    // cycle); MESSAGE_CREATEs dispatched during the gap are LOST FOREVER
    // (the mock has no RESUME replay — #362). The blind +4s re-inject
    // failed because both attempts landed inside the same gap. Oracle: a
    // per-arm `messageCreate` listener — discord.js fires it ONLY on
    // gateway dispatch (REST reads never emit it; proven by the
    // dead-socket experiment), so seen.has(id) is exact delivery truth.
    // On a missed delivery: ride out the reconnect ladder, re-inject
    // (bounded), then delete the never-delivered residue so flow-side
    // cleanup asserts keep meaning "the flow deleted what it processed".
    // The same exposure remains on the reaction-event arms (green so far);
    // #362 removes the whole class mock-side.
    const injectAndPoll = async (text, predicate, label) => {
      const client = env.supervisor?.discord;
      const seen = new Set();
      const listener = client?.on ? (msg) => seen.add(String(msg?.id)) : null;
      if (listener) client.on("messageCreate", listener);
      const delivered = async (id, ms = 4000) => {
        if (!id || !listener) return true;
        try {
          await poll(() => (seen.has(String(id)) ? true : null), {
            timeoutMs: ms,
            label: `${label} (delivery)`,
          });
          return true;
        } catch {
          return false;
        }
      };
      try {
        const first = await env.mock.inject(text, env.ids.human, env.ids.general);
        if (first?.id && !(await delivered(first.id))) {
          for (let round = 0; round < 3; round++) {
            await new Promise((r) => setTimeout(r, 4000)); // reconnect-ladder budget
            const again = await env.mock.inject(text, env.ids.human, env.ids.general);
            if (!again?.id || (await delivered(again.id, 5000))) break;
          }
          for (const m of ((await env.mock.messages(env.ids.general)) ?? [])) {
            if (
              String(m.content) === text &&
              String(m.author?.id ?? m.authorId ?? "") === String(env.ids.human)
            ) {
              await api(`/channels/${env.ids.general}/messages/${m.id}`, {
                method: "DELETE",
              }).catch(() => {});
            }
          }
        }
        try {
          return await poll(predicate, { timeoutMs: 10000, label: `${label} (confirm)` });
        } catch (err) {
          // Tripwire diagnostic (kept post-root-cause: fires only if the
          // recovery path above stops rescuing — see #362). Read-only.
          try {
            const d = env.supervisor?.discord;
            const all = (await env.mock.messages(env.ids.general)) ?? [];
            console.error(
              `[ns16-diag] ${JSON.stringify({
                label,
                ws: String(d?.ws?.status ?? "?"),
                shard: String(d?.ws?.shards?.first?.()?.status ?? "?"),
                genCached: d ? d.channels.cache.has(env.ids.general) : "?",
                lockRow: !!env.dbmod.getReactionRoleOption(env.communityId, st.panel, "🔒"),
                colorRow: !!env.dbmod.getReactionRoleOption(env.communityId, st.panel, "🎉"),
                msgTotal: all.length,
                newest: all.slice(0, 5).map((m) => String(m.content).slice(0, 40)),
              })}`,
            );
          } catch {
            /* diagnostics must never mask the real failure */
          }
          throw err;
        }
      } finally {
        if (listener) client.off("messageCreate", listener);
      }
    };

    it("gates: outsider denied on reactionrole + honeypot channels; exempt trio is admin-only for staff too", async () => {
      const denied = "You don't have permission to use this.";
      assert.equal(
        await contentOf(await slash("reactionrole", [grp("panel", "create", [chanOpt("channel", env.ids.general)])], env.ids.outsider)),
        denied,
      );
      assert.equal(
        await contentOf(await slash("reactionrole", [sub("sync", [strOpt("message_id", "1")])], env.ids.outsider)),
        denied,
      );
      assert.equal(
        await contentOf(await slash("honeypot", [grp("channel", "list")], env.ids.outsider)),
        denied,
      );

      // exempt group answers with its OWN admin copy (not the generic):
      // outsider (non-staff) and junior staff both hit the admin gate.
      const adminCopy = "Only server administrators can manage honeypot exempt roles.";
      assert.equal(
        await contentOf(await slash("honeypot", [grp("exempt", "list")], env.ids.outsider)),
        adminCopy,
      );
      assert.equal(
        await contentOf(await slash("honeypot", [grp("exempt", "add", [roleOpt("role", roles.waiver.id)])], junior)),
        adminCopy,
      );
    });

    it("/reactionrole panel create/list/edit: message + row + embed re-render + audits", async () => {
      const inter = await slash(
        "reactionrole",
        [grp("panel", "create", [chanOpt("channel", env.ids.general), strOpt("title", "Pick a role"), strOpt("description", "React below")])],
      );
      const created = await contentOf(inter);
      assert.match(created, /Created reaction-role panel in <#/);
      const m = /Message ID: `(\d+)`/.exec(created);
      assert.ok(m, `message id line (got: ${created})`);
      st.panel = m[1];

      const row = panelRow(st.panel);
      assert.ok(row, "panel row persisted");
      assert.equal(row.channel_id, env.ids.general);
      assert.equal(row.title, "Pick a role");

      const msg = await env.mock.message(st.panel, env.ids.general);
      assert.equal(msg.embeds[0].title, "Pick a role");
      assert.ok(
        msg.embeds[0].description.includes("_No roles configured yet"),
        "empty-options placeholder",
      );
      assert.equal(msg.embeds[0].footer.text, "React to claim · remove reaction to drop (where allowed)");
      assert.ok(auditRow("reaction_roles.panel_create"));

      const listed = await contentOf(await slash("reactionrole", [grp("panel", "list")]));
      assert.ok(listed.includes(st.panel), "panel list shows the id");

      const edited = await contentOf(
        await slash("reactionrole", [grp("panel", "edit", [strOpt("message_id", st.panel), strOpt("title", "Claim your roles")])]),
      );
      assert.ok(/edit|update/i.test(edited), `edit reply (got: ${edited})`);
      const after = await env.mock.message(st.panel, env.ids.general);
      assert.equal(after.embeds[0].title, "Claim your roles", "embed re-rendered");
      assert.ok(auditRow("reaction_roles.panel_update"));

      assert.equal(
        await contentOf(await slash("reactionrole", [sub("sync", [strOpt("message_id", "999999999999999999")])])),
        "No reaction-role panel with message ID `999999999999999999`.",
      );
    });

    it("option add pending-emoji flow: invalid keeps waiting, stop cancels, emoji configures (row + embed + bot seed reaction)", async () => {
      const start = await slash(
        "reactionrole",
        [grp("option", "add", [strOpt("message_id", st.panel), roleOpt("role", roles.color.id)])],
      );
      const prompt = await contentOf(start);
      assert.match(prompt, /\*\*Send the emoji\*\* as your next message/);
      assert.match(prompt, /Type \*\*`stop`\*\* to cancel\. Expires in \d+ minutes\./);

      // Plain-text label (no emoji codepoints, pure shortcode charset, NOT a
      // known shortcode) → parse refusal, session RETAINED (still waiting).
      // NOTE: arbitrary prose like "not an emoji" PARSES as a literal unicode
      // emoji (product behavior) — only looksLikePlainTextLabel inputs refuse.
      const refusal = await injectAndPoll(
        "gamer",
        async () =>
          ((await env.mock.messages(env.ids.general)) ?? []).find(
            (m) => String(m.content).includes("That doesn't look like an emoji"),
          ),
        "pending-emoji refusal",
      );
      assert.ok(String(refusal.content).includes("Still waiting for an emoji"), "still-waiting footer");

      // stop → cancel copy, session cleared (a later emoji is NOT consumed).
      const cancelled = await injectAndPoll(
        "stop",
        async () =>
          ((await env.mock.messages(env.ids.general)) ?? []).find((m) =>
            String(m.content).includes("Cancelled — no longer waiting"),
          ),
        "pending-emoji cancel",
      );
      assert.ok(cancelled);

      // Re-arm, then the emoji itself.
      await slash(
        "reactionrole",
        [grp("option", "add", [strOpt("message_id", st.panel), roleOpt("role", roles.color.id)])],
      );
      await injectAndPoll(
        "🎉",
        async () =>
          ((await env.mock.messages(env.ids.general)) ?? []).find((m) =>
            String(m.content).includes("Configured 🎉"),
          ),
        "option configured confirm",
      );

      const opt = env.dbmod.getReactionRoleOption(env.communityId, st.panel, "🎉");
      assert.ok(opt, "option row persisted");
      assert.equal(String(opt.role_id), roles.color.id);
      assert.equal(Number(opt.removable), 1, "removable defaults true");

      const msg = await env.mock.message(st.panel, env.ids.general);
      assert.ok(
        msg.embeds[0].description.includes("🎉 → <@&"),
        "panel embed lists the option",
      );

      // The bot seeds its OWN reaction for configured emojis (sync-on-add).
      const members = await poll(async () => {
        const r = await reactionMembers(st.panel, "🎉");
        return r.includes(env.ids.app) ? r : null;
      }, { timeoutMs: 8000, label: "bot seed reaction on panel" });
      assert.ok(members.includes(env.ids.app));

      // Emoji command message was deleted by the flow (deleteAdminEmojiMessage).
      const emojiMsgGone = await poll(async () => {
        const msgs = (await env.mock.messages(env.ids.general)) ?? [];
        return !msgs.some((m) => m.content === "🎉" && m.author?.id === env.ids.human)
          ? true
          : null;
      }, { timeoutMs: 8000, label: "emoji message cleaned up" });
      assert.ok(emojiMsgGone);

      const listCopy = await contentOf(
        await slash("reactionrole", [grp("option", "list", [strOpt("message_id", st.panel)])]),
      );
      assert.match(listCopy, /Options for panel `/);
      assert.ok(listCopy.includes("🎉 → <@&"), "option list line");
      assert.ok(listCopy.includes("Level 0+ · removable"));
      assert.ok(auditRow("reaction_roles.option_add"));

      // Empty-state list on a fresh panel.
      const p2inter = await slash("reactionrole", [grp("panel", "create", [chanOpt("channel", env.ids.general)])]);
      const p2m = /Message ID: `(\d+)`/.exec(await contentOf(p2inter));
      const p2 = p2m[1];
      assert.match(
        await contentOf(await slash("reactionrole", [grp("option", "list", [strOpt("message_id", p2)])])),
        new RegExp(`Panel \\\`${p2}\\\` has no options yet\\.`),
      );
      // cleanup the extra panel
      await slash("reactionrole", [grp("panel", "delete", [strOpt("message_id", p2)])]);
    });

    it("claims via injected REACTION_ADD/REMOVE: grant, revoke, strip arms, non-panel survival, #356 embed pin", async () => {
      await env.mock.react({ messageId: st.panel, emoji: "🎉", userId: env.ids.outsider });
      await poll(async () => ((await memberRoleIds(env.ids.outsider)).includes(roles.color.id) ? true : null), {
        timeoutMs: 8000,
        label: "role granted on react",
      });
      assert.ok(
        (await reactionMembers(st.panel, "🎉")).includes(env.ids.outsider),
        "reaction stored meanwhile",
      );

      // #356 FIXED: the live-claim path was handing logReactionRoleChange a
      // raw discord.js Client (needs an OutboundClient) — sendChannel was
      // undefined, the TypeError died in catch(() => {}), and the embed
      // NEVER posted. The claim embed now reaches the audit channel:
      const granted = await poll(async () => {
        const msgs = (await env.mock.messages(logs())) ?? [];
        return msgs.find((m) => m.embeds?.[0]?.title === "Reaction role granted") ?? null;
      }, { timeoutMs: 8000, label: "#356 grant audit embed posted" });
      const grantFields = Object.fromEntries(
        (granted.embeds[0].fields ?? []).map((f) => [String(f.name), String(f.value)]),
      );
      assert.ok(
        String(grantFields["Role"] ?? "").includes(roles.color.id),
        `embed names the granted role (fields: ${JSON.stringify(grantFields)})`,
      );

      await env.mock.unreact({ messageId: st.panel, emoji: "🎉", userId: env.ids.outsider });
      await poll(async () => ((await memberRoleIds(env.ids.outsider)).includes(roles.color.id) ? null : true), {
        timeoutMs: 8000,
        label: "role revoked on unreact",
      });
      // The remove leg had the SAME raw-Client bug — pinned fixed too.
      await poll(async () => {
        const msgs = (await env.mock.messages(logs())) ?? [];
        return msgs.find((m) => m.embeds?.[0]?.title === "Reaction role removed") ?? null;
      }, { timeoutMs: 8000, label: "#356 revoke audit embed posted" });

      // Unconfigured emoji on a MANAGED panel → strip (reactor removed).
      await env.mock.react({ messageId: st.panel, emoji: "🚫", userId: env.ids.outsider });
      await poll(async () =>
        (await reactionMembers(st.panel, "🚫")).includes(env.ids.outsider) ? null : true,
      { timeoutMs: 8000, label: "unconfigured reaction stripped" });
      assert.ok(
        !(await memberRoleIds(env.ids.outsider)).includes(roles.color.id),
        "strip arm did not grant anything",
      );

      // Reactions on NON-panel messages are NOT consumed by the feature
      // (no strip, no role): a plain message keeps the reaction.
      const someMsg = await env.mock.inject("non-panel reaction host", env.ids.target, env.ids.general);
      await env.mock.react({ messageId: String(someMsg.id), emoji: "🎉", userId: env.ids.outsider });
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(
        (await reactionMembers(st.panel, "🚫")).length === 0,
        "still stripped; unrelated reaction untouched by panels",
      );
      assert.ok(
        (await reactionMembers(String(someMsg.id), "🎉")).includes(env.ids.outsider),
        "non-panel reaction survives",
      );
    });

    it("removable:false persists after unreact; min-level option strips the reaction and never grants", async () => {
      // 🔒 → lock role, level 0, NOT removable.
      await slash(
        "reactionrole",
        [grp("option", "add", [strOpt("message_id", st.panel), roleOpt("role", roles.lock.id), boolOpt("removable", false)])],
      );
      await injectAndPoll(
        "🔒",
        async () => (env.dbmod.getReactionRoleOption(env.communityId, st.panel, "🔒") ? true : null),
        "🔒 option row",
      );

      await env.mock.react({ messageId: st.panel, emoji: "🔒", userId: env.ids.outsider });
      await poll(async () => ((await memberRoleIds(env.ids.outsider)).includes(roles.lock.id) ? true : null), {
        timeoutMs: 8000,
        label: "permanent role granted",
      });
      await env.mock.unreact({ messageId: st.panel, emoji: "🔒", userId: env.ids.outsider });
      // Give the remove pipeline a beat, then assert the role SURVIVES.
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(
        (await memberRoleIds(env.ids.outsider)).includes(roles.lock.id),
        "removable:false keeps the role after unreact",
      );

      // ⭐ → star role, LEVEL 5 gate: outsider is far below (fresh XP).
      await slash(
        "reactionrole",
        [grp("option", "add", [strOpt("message_id", st.panel), roleOpt("role", roles.star.id), intOpt("level", 5)])],
      );
      await env.mock.inject("⭐", env.ids.human, env.ids.general);
      await poll(async () => (env.dbmod.getReactionRoleOption(env.communityId, st.panel, "⭐") ? true : null), {
        timeoutMs: 8000,
        label: "⭐ option row",
      });

      await env.mock.react({ messageId: st.panel, emoji: "⭐", userId: env.ids.outsider });
      // Level-gated → reaction REMOVED by the handler (DM copy unassertable).
      await poll(async () =>
        (await reactionMembers(st.panel, "⭐")).includes(env.ids.outsider) ? null : true,
      { timeoutMs: 8000, label: "level-gated reaction removed" });
      assert.ok(
        !(await memberRoleIds(env.ids.outsider)).includes(roles.star.id),
        "level gate blocked the grant",
      );
    });

    it("option remove pending flow deletes rows + re-renders; panel deploy copies, delete removes row + message", async () => {
      const rmStart = await slash("reactionrole", [grp("option", "remove", [strOpt("message_id", st.panel)])]);
      assert.match(await contentOf(rmStart), /\*\*Send the emoji\*\* to remove/);
      await injectAndPoll(
        "🔒",
        async () =>
          ((await env.mock.messages(env.ids.general)) ?? []).find((m) =>
            String(m.content).includes("Removed 🔒 from panel"),
          ),
        "remove confirm",
      );
      assert.equal(env.dbmod.getReactionRoleOption(env.communityId, st.panel, "🔒"), null, "row deleted");
      const msg = await env.mock.message(st.panel, env.ids.general);
      assert.ok(!msg.embeds[0].description.includes("🔒"), "embed re-rendered without the option");
      assert.ok(auditRow("reaction_roles.option_remove"));

      // Deploy into the logs channel: config + options copied to a NEW panel.
      const deploy = await contentOf(
        await slash(
          "reactionrole",
          [grp("panel", "deploy", [strOpt("message_id", st.panel), chanOpt("channel", logs())])],
        ),
      );
      const dm = /`(\d{15,})`/.exec(deploy);
      assert.ok(/deploy/i.test(deploy), `deploy reply (got: ${deploy})`);
      const copied = (env.dbmod.listReactionRolePanels(env.communityId) ?? []).find(
        (p) => p.channel_id === logs() && p.message_id !== st.panel,
      );
      assert.ok(copied, "deployed panel row exists in the logs channel");
      assert.equal(copied.title, "Claim your roles", "panel config copied");
      assert.ok(
        env.dbmod.listReactionRoleOptions(env.communityId, copied.message_id).some((o) => o.emoji_display === "🎉"),
        "options copied",
      );
      void dm;

      // Delete the deployed copy: row gone, message deleted.
      await contentOf(await slash("reactionrole", [grp("panel", "delete", [strOpt("message_id", copied.message_id)])]));
      assert.equal(panelRow(copied.message_id), null, "row deleted");
      assert.equal(await msgExists(logs(), copied.message_id), false, "panel message deleted");
      assert.ok(auditRow("reaction_roles.panel_delete"));
    });

    it("honeypot channel add/list: bait channel armed; enforcing trigger BANs + audits + alerts the log channel", async () => {
      // Mid-suite channel over REST (no mockenv helper; the mock dispatches
      // CHANNEL_CREATE so the bot cache sees the trap too).
      const trapCh = await api(`/guilds/${env.ids.guild}/channels`, {
        method: "POST",
        body: JSON.stringify({ name: "honeypot-trap", type: 0 }),
      });
      trap = String(trapCh.id);

      const added = await contentOf(await slash("honeypot", [grp("channel", "add", [chanOpt("channel", trap)])]));
      assert.match(added, new RegExp(`Marked <#${trap}> as a \\*\\*honeypot\\*\\* channel\\.`));
      assert.match(added, /\/staff role add|exempt roles/i, "guidance line");
      const rows = env.dbmod.listHoneypotChannels(env.communityId);
      assert.ok(rows.some((r) => r.channel_id === trap), "honeypot row");

      const listed = await contentOf(await slash("honeypot", [grp("channel", "list")]));
      assert.ok(listed.includes(`<#${trap}>`), "list shows the trap");

      // BAIT: outsider posts in the trap → message deleted + BAN issued.
      const bait = await env.mock.inject("free nitro go here", env.ids.outsider, trap);
      st.trapId = String(bait.id);

      assert.equal(await poll(async () => ((await banState(env.ids.outsider)) ? true : null), { timeoutMs: 8000, label: "honeypot ban" }), true);
      assert.equal(await poll(async () => ((await msgExists(trap, st.trapId)) ? null : true), { timeoutMs: 8000, label: "bait message deleted" }), true);

      const enforce = auditRow("honeypot.enforce");
      assert.ok(enforce, "honeypot.enforce audit written");
      assert.equal(enforce.target_id, env.ids.outsider, "banned user recorded");

      // Alert embed to the audit channel (logHoneypotTrigger).
      await poll(async () => ((await embedTitles()).some((t) => /honeypot/i.test(String(t))) ? true : null), {
        timeoutMs: 8000,
        label: "honeypot alert embed",
      });
    });

    it("exemptions: staff-role member only loses the message; /honeypot exempt role honored on the next bait", async () => {
      // Junior-staff member: delete-only, NO ban, NO second enforce row.
      const before = auditCount("honeypot.enforce");
      const bait = await env.mock.inject("staff walks into the trap", junior, trap);
      assert.equal(await poll(async () => ((await msgExists(trap, String(bait.id))) ? null : true), { timeoutMs: 8000, label: "exempt message deleted" }), true);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(await banState(junior), false, "staff role never banned");
      assert.equal(auditCount("honeypot.enforce"), before, "exempt hit wrote no enforce audit");

      // /honeypot exempt trio (admin) — exempt roles land in staff_roles.
      const addedCopy = await contentOf(await slash("honeypot", [grp("exempt", "add", [roleOpt("role", roles.waiver.id)])]));
      assert.match(addedCopy, /exempt/i);
      const list = await contentOf(await slash("honeypot", [grp("exempt", "list")]));
      assert.ok(list.includes(`<@&${roles.waiver.id}>`), "exempt list shows the role");

      const bait2 = await env.mock.inject("waiver walks in", waiverUser, trap);
      assert.equal(await poll(async () => ((await msgExists(trap, String(bait2.id))) ? null : true), { timeoutMs: 8000, label: "waived message deleted" }), true);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(await banState(waiverUser), false, "exempt role honored on next bait click");

      const removedCopy = await contentOf(await slash("honeypot", [grp("exempt", "del", [roleOpt("role", roles.waiver.id)])]));
      assert.match(removedCopy, /removed/i);

      // Channel del disarms the trap.
      const delCopy = await contentOf(await slash("honeypot", [grp("channel", "del", [chanOpt("channel", trap)])]));
      assert.match(delCopy, /honeypot/i, `del copy (got: ${delCopy})`);
      assert.ok(!env.dbmod.listHoneypotChannels(env.communityId).some((r) => r.channel_id === trap), "trap row cleared");

      // Post-del arm: the same trap channel is now an ordinary channel.
      const plain = await env.mock.inject("ordinary chatter again", junior, trap);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(await msgExists(trap, String(plain.id)), true, "messages survive after disarm");
    });

    // Members receive BAN/level-gate DM copies — unassertable while the
    // mock cannot enumerate DM channels (GET /users/@me/channels 404).
    it.todo("honeypot BAN DM + level-gate DM embed content (mock cannot list DM channels)");

    // #312 DELIVERED: channel-send multipart persists uploads — the former
    // "warning-notice PNG blocked" todo became this arm. The exemptions arm
    // above already DISARMED `trap`, so re-adding posts a fresh notice.
    it("/honeypot channel add posts the warning-notice PNG into the trap (multipart channel-send)", async () => {
      const addCopy = await contentOf(
        await slash("honeypot", [grp("channel", "add", [chanOpt("channel", trap)])]),
      );
      assert.match(addCopy, /honeypot|trap/i, `channel add copy (got: ${addCopy})`);

      const notice = await poll(
        async () =>
          (await env.mock.messages(trap)).find(
            (m) => (m.attachments ?? []).some((a) => a.filename === "honeypot-warning.png"),
          ) ?? null,
        { timeoutMs: 8000, label: "warning-notice PNG in trap" },
      );
      const att = notice.attachments.find((a) => a.filename === "honeypot-warning.png");
      assert.equal(att.content_type, "image/png", "content-type sniffed from PNG bytes");
      assert.ok(att.size > 0, "non-empty render");
      assert.match(String(att.url), /\/_mock\/attachments\//, "mock serves the bytes");

      const res = await fetch(att.url);
      assert.ok(res.ok, `PNG GET (HTTP ${res.status})`);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.deepEqual(
        bytes.subarray(0, 4),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        "PNG magic bytes",
      );
      assert.equal(bytes.length, att.size, "served bytes match the stored size");

      // Reuse contract: adding the trap again must NOT post a second notice.
      await slash("honeypot", [grp("channel", "add", [chanOpt("channel", trap)])]);
      await new Promise((r) => setTimeout(r, 400));
      const notices = (await env.mock.messages(trap)).filter((m) =>
        (m.attachments ?? []).some((a) => a.filename === "honeypot-warning.png"),
      );
      assert.equal(notices.length, 1, "existing warning notice reused (ensureHoneypotWarning)");
    });
  },
);
