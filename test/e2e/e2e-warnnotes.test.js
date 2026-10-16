const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll, namespaceIds } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — importing anything that pulls in the db
// before createE2eEnv() sets the env vars silently binds the dev database.
// Lazily require src modules INSIDE tests instead.

/**
 * Tier-4 warnings-deep + staff-notes coverage (issue #319). Namespace 14:
 * the half of the warnings system ns4 (e2e-warnings) does not touch —
 * `/warn info` (+bogus copy), `/warn void` (state machine, already-voided,
 * DM + warn-log fan-out), `/warn add` evidence/note/expiry/silent option
 * arms (canonical URL pinning, per-warn `expires_days`, guild-default
 * expiry, note-link validation), `/warn list` pagination + include_voided
 * boundary copy, `/warn count` / `mine` / `export` (staff-record file),
 * the FULL `/setwarn` surface (dm toggle, expiry bounds incl. the >MAX
 * refusal, log channel set/clear with the audit-fallback copy), and the
 * FORCED `runWarnExpiryTick` (clock-injected — expired warn flips to
 * voided with the auto reason, drops out of active counts, posts the
 * "auto-voided (expired)" embed).
 *
 * Staff notes: `/note add` direct + `note:add:` modal round-trip (patch v7
 * supports modal submit — the issue's "mock modal gap" blocker is stale),
 * `/note list` (per-user pagination header, guild feed, include_deleted),
 * `/note edit` direct + `note:edit:` MODAL PREFILLED (value pin) with edit
 * lineage (edited_by/edited_at render), `/note delete` soft-delete +
 * already-deleted + edit-deleted arms, `/note info`, `/note settings`
 * counts, and the ticket-embedded `tk:sn:` button → `tk:snm:` modal flow
 * (gate denial for outsiders, invalid-reference arms, note content built
 * from ticket + close reason). The tk:sn happy path from ns10 closed the
 * loop on a close that PASSED `staff_note`; here the button drives the
 * no-staff_note close path whose reply carries the "Optional: click
 * **Add staff note**" hint.
 *
 * Mock invariants used: DM create+send works (wizard handshake), so the
 * staff-side dmNote pins "Member notified by DM." for real; DM *content*
 * stays unassertable (GET /users/@me/channels is 404 — documented todo).
 * listExpiredActiveWarnings(now) is clock-injectable through
 * runWarnExpiryTick(supervisor, {now}) — no DB surgery needed.
 */
describe(
  "e2e: warnings deep + staff notes — /warn void/info/expiry, /setwarn, /note modals, tk:sn",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    const log = () => env.ids.channel2; // "warn-log" channel

    before(async () => {
      const ids = namespaceIds(14);
      env = await createE2eEnv({
        ns: 14,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "warn-log" },
        ],
      });
      // requireStaff / requireStaffFromContext = ManageGuild OR staff_roles.
      const mgRole = await env.mock.createRole("E2E Warn Notes MG", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, mgRole.id);
    });

    after(async () => {
      await env?.cleanup();
    });

    const sub = (name, options = []) => ({
      name,
      type: 1,
      ...(options.length && { options }),
    });
    const userOpt = (name, id) => ({ name, type: 6, value: id });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const boolOpt = (name, value) => ({ name, type: 5, value });

    const slash = (command, options, who = env.ids.human, channelId) =>
      env.mock.slash({
        command,
        options,
        userId: who,
        ...(channelId && { channelId }),
      });
    const replied = async (inter) => env.mock.awaitSettledReply(inter);
    const contentOf = async (inter) =>
      String((await replied(inter)).content);
    const embedOf = async (inter) => (await replied(inter)).embeds?.[0];
    const fieldOf = (embed, name) =>
      (embed?.fields ?? []).find((f) => f.name === name);

    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);
    const warnRow = (n) => env.dbmod.getWarning(env.communityId, n);
    const noteRow = (n) => env.dbmod.getStaffNote(env.communityId, n);
    const warnCount = (userId, opts = {}) =>
      env.dbmod.countWarnings(env.communityId, userId, {
        includeVoided: true,
        ...opts,
      });
    const activeCount = (userId) =>
      env.dbmod.countActiveWarnings(env.communityId, userId);
    const msgTitles = async (channelId) =>
      ((await env.mock.messages(channelId)) ?? []).map(
        (m) => m.embeds?.[0]?.title,
      );

    /** Issue a warn add and parse its W-number out of the embed title. */
    const addWarn = async (opts) => {
      const inter = await slash("warn", [sub("add", opts)]);
      const embed = await embedOf(inter);
      return { inter, embed, n: Number(String(embed?.title).match(/W-(\d+)/)?.[1]) };
    };

    // Shared state across the sequential tests.
    const st = { w1: 0, w2: 0, w3: 0, w4: 0, closeMsg: null, ticketChan: null };

    it("outsider gate: warn/setwarn/note staff surfaces denied, /warn mine stays public", async () => {
      const denied = "You don't have permission to use this.";
      for (const [command, options] of [
        [
          "warn",
          [sub("add", [userOpt("user", env.ids.target), strOpt("reason", "x")])],
        ],
        ["warn", [sub("list", [userOpt("user", env.ids.target)])]],
        ["warn", [sub("info", [intOpt("id", 1)])]],
        ["warn", [sub("void", [intOpt("id", 1), strOpt("reason", "x")])]],
        ["setwarn", [sub("dm", [boolOpt("enabled", false)])]],
        ["setwarn", [sub("expiry", [intOpt("days", 10)])]],
        ["note", [sub("add", [userOpt("user", env.ids.target), strOpt("content", "x")])]],
        ["note", [sub("list")]],
      ]) {
        assert.equal(
          await contentOf(await slash(command, options, env.ids.outsider)),
          denied,
          `${command} outsider denial`,
        );
      }

      // mine is handler-public (own history).
      assert.equal(
        await contentOf(await slash("warn", [sub("mine")], env.ids.outsider)),
        "You have no **active** warnings in this server. Use `include_voided:true` to see full history.",
      );
      assert.equal(warnCount(env.ids.outsider), 0, "denials wrote nothing");
    });

    it("/setwarn dm|expiry|log persist, bound-refusal, settings echo, audit", async () => {
      // DM off → on across the test (adds below pin the real DM branch).
      assert.match(
        await contentOf(await slash("setwarn", [sub("dm", [boolOpt("enabled", false)])])),
        /Warning member DMs are now \*\*disabled\*\*/,
      );
      assert.equal(
        env.dbmod.getGuildSettings(env.communityId).warn_dm_members,
        0,
        "warn_dm_members persisted",
      );

      // Guild default expiry 30d + bound refusal (builder max is 3650; the
      // mock does not enforce option bounds, so the HANDLER normalize must
      // reject — pinning the server-side guard).
      assert.match(
        await contentOf(await slash("setwarn", [sub("expiry", [intOpt("days", 30)])])),
        /auto-void after \*\*30\*\* day\(s\) by default/,
      );
      assert.equal(env.dbmod.getGuildSettings(env.communityId).warn_expiry_days, 30);
      assert.equal(
        await contentOf(await slash("setwarn", [sub("expiry", [intOpt("days", 99999)])])),
        "Expiry days cannot exceed 3650.",
      );
      assert.equal(env.dbmod.getGuildSettings(env.communityId).warn_expiry_days, 30, "bad expiry unchanged");

      // log: missing channel arm, then set, then settings echo.
      assert.match(
        await contentOf(await slash("setwarn", [sub("log")])),
        /Provide a `channel` or set `clear:true`/,
      );
      const logSet = await contentOf(
        await slash("setwarn", [sub("log", [chanOpt("channel", log())])]),
      );
      assert.ok(
        logSet.includes(`Warning issue/void embeds will post to <#${log()}>`),
        `log-set copy (got: ${logSet.slice(0, 80)})`,
      );
      assert.equal(env.dbmod.getGuildSettings(env.communityId).warn_log_channel_id, log());

      assert.match(
        await contentOf(await slash("setwarn", [sub("dm", [boolOpt("enabled", true)])])),
        /Warning member DMs are now \*\*enabled\*\*/,
      );

      const settings = await contentOf(await slash("warn", [sub("settings")]));
      assert.match(settings, /Member DMs on issue\/void: \*\*on\*\*/);
      assert.ok(
        settings.includes(`Warning log: <#${log()}> (dedicated;`),
        "dedicated log line in settings",
      );
      assert.match(settings, /Default expiry: \*\*30\*\* day\(s\)/);
      assert.match(settings, /Warnings are \*\*permanent\*\*/);

      for (const action of ["warnings.dm_set", "warnings.expiry_set", "warnings.log_channel_set"]) {
        assert.ok(auditRow(action), `admin_audit ${action}`);
      }
      assert.equal(
        JSON.parse(auditRow("warnings.log_channel_set").details_json).channel_id,
        log(),
      );
    });

    it("/warn add refuses malformed evidence, foreign-guild links, unknown note links", async () => {
      const bad = await slash(
        "warn",
        [sub("add", [userOpt("user", env.ids.target), strOpt("reason", "x"), strOpt("message", "not a link")])],
      );
      assert.equal(
        await contentOf(bad),
        "Evidence message must be a Discord message link (https://discord.com/channels/…/…/…).",
      );

      const foreign = await slash(
        "warn",
        [
          sub("add", [
            userOpt("user", env.ids.target),
            strOpt("reason", "x"),
            strOpt("message", "https://discord.com/channels/999999999999999999/111/222"),
          ]),
        ],
      );
      assert.equal(await contentOf(foreign), "Evidence message link must be from this server.");

      const badNote = await slash(
        "warn",
        [sub("add", [userOpt("user", env.ids.target), strOpt("reason", "x"), intOpt("note", 999)])],
      );
      assert.equal(
        await contentOf(badNote),
        "No staff note **N-999** in this server. Omit `note` or use a valid note number.",
      );

      const longEv = await slash(
        "warn",
        [
          sub("add", [
            userOpt("user", env.ids.target),
            strOpt("reason", "x"),
            strOpt("evidence", "e".repeat(501)),
          ]),
        ],
      );
      assert.match(await contentOf(longEv), /too long/i);

      assert.equal(
        env.dbmod.db
          .prepare("SELECT COUNT(*) AS n FROM warnings WHERE community_id = ?")
          .get(env.communityId).n,
        0,
        "refusals wrote no rows",
      );
    });

    it("/warn add happy path: guild-default expiry, DM branch, silent arm, note link", async () => {
      // Seed the note the warn will link (also ns14's first /note surface).
      const noteInter = await slash(
        "note",
        [sub("add", [userOpt("user", env.ids.target), strOpt("content", "pre-existing context")])],
      );
      const noteEmbed = await embedOf(noteInter);
      assert.equal(noteEmbed.title, "Note N-1 created");
      assert.equal(noteEmbed.description, "pre-existing context");
      assert.equal(fieldOf(noteEmbed, "Subject").value, `<@${env.ids.target}>`);
      assert.ok(auditRow("notes.add"));

      // Main add: guild default (30d) applies; real DM sent (mock DM works).
      const msgUrl = `https://discord.com/channels/${env.ids.guild}/${env.ids.general}/777777777777777777`;
      const a1 = await addWarn([
        userOpt("user", env.ids.target),
        strOpt("reason", "spam in general"),
        strOpt("message", msgUrl),
        strOpt("evidence", "screenshots filed"),
      ]);
      st.w1 = a1.n;
      assert.equal(st.w1, 1, "per-community W sequence");
      assert.equal(a1.embed.title, "Warning W-1 issued");
      assert.equal(fieldOf(a1.embed, "Expires").value.endsWith("(30d)"), true, "guild-default expiry render");
      assert.equal(fieldOf(a1.embed, "Notification").value, "Member notified by DM.");
      assert.equal(fieldOf(a1.embed, "Evidence message").value, msgUrl, "canonical URL stored");
      assert.equal(fieldOf(a1.embed, "Evidence notes").value, "screenshots filed");
      assert.equal(fieldOf(a1.embed, "Active count").value, "1");
      const r1 = warnRow(1);
      const days = (r1.expires_at - r1.created_at) / 86400000;
      assert.ok(days > 29 && days < 31, `expires_at ≈ created+30d (got ${days})`);
      assert.equal(r1.evidence_message_url, msgUrl);

      // silent:true skips the DM attempt entirely.
      const a2 = await addWarn([
        userOpt("user", env.ids.target),
        strOpt("reason", "repeat spam"),
        boolOpt("silent", true),
      ]);
      st.w2 = a2.n;
      assert.equal(a2.embed.title, "Warning W-2 issued");
      assert.equal(fieldOf(a2.embed, "Notification").value, "DM skipped (silent).");
      assert.equal(fieldOf(a2.embed, "Expires").value.endsWith("(30d)"), true);

      // note link resolves to the seeded N-1.
      const a3 = await addWarn([
        userOpt("user", env.ids.target),
        strOpt("reason", "harassment (paired with note)"),
        intOpt("note", 1),
      ]);
      st.w3 = a3.n;
      assert.equal(fieldOf(a3.embed, "Linked note").value, "N-1");
      assert.equal(warnRow(3).related_note_id, noteRow(1).id, "related_note_id FK");
      assert.ok(auditRow("warnings.add"));
    });

    it("/warn list + info + count + mine render the state", async () => {
      const list = await contentOf(await slash("warn", [sub("list", [userOpt("user", env.ids.target)])]));
      assert.match(
        list,
        new RegExp(
          `\\*\\*Warnings for <@${env.ids.target}>\\*\\* · page 1/1 · \\*\\*3\\*\\* active · 3 listed`,
        ),
      );
      for (const ref of ["W-1", "W-2", "W-3"]) {
        assert.ok(list.includes(`**${ref}**`), `list shows ${ref}`);
      }

      const info = await embedOf(await slash("warn", [sub("info", [intOpt("id", 1)])]));
      assert.equal(info.title, "Warning W-1");
      assert.equal(info.description, "spam in general");
      assert.equal(fieldOf(info, "Status").value, "Active");
      assert.equal(fieldOf(info, "Subject active count").value, "3");
      assert.ok(fieldOf(info, "Expires").value.length > 0);

      assert.equal(
        await contentOf(await slash("warn", [sub("info", [intOpt("id", 77)])])),
        "No warning **W-77** in this server.",
      );

      const count = await contentOf(await slash("warn", [sub("count", [userOpt("user", env.ids.target)])]));
      assert.ok(
        count.startsWith(`<@${env.ids.target}> has **3** active warnings`),
        `count copy (got: ${count.slice(0, 90)})`,
      );
      assert.match(count, /\*\*Recent active:\*\*/);

      // mine stays public self-service.
      const mine = await contentOf(await slash("warn", [sub("mine")], env.ids.target));
      assert.match(mine, /\*\*Your warnings\*\*/);
      assert.ok(mine.includes("**W-1**"));
    });

    it("/warn void: state flip, DM + warn-log fan-out, already-voided, list arms", async () => {
      const v = await embedOf(
        await slash("warn", [sub("void", [intOpt("id", 1), strOpt("reason", "resolved with member")])]),
      );
      assert.equal(v.title, "Warning W-1 voided");
      assert.equal(fieldOf(v, "Voided by").value, `<@${env.ids.human}>`);
      assert.equal(fieldOf(v, "Active remaining").value, "2");
      assert.equal(fieldOf(v, "Void reason").value, "resolved with member");
      assert.equal(fieldOf(v, "Notification").value, "Member notified by DM.");

      const row = warnRow(1);
      assert.ok(row.voided_at != null, "voided_at recorded");
      assert.equal(String(row.voided_by), env.ids.human);
      assert.equal(row.void_reason, "resolved with member");

      assert.equal(
        await contentOf(await slash("warn", [sub("void", [intOpt("id", 1), strOpt("reason", "again")])])),
        "Warning W-1 is already voided.",
      );
      assert.equal(
        await contentOf(await slash("warn", [sub("void", [intOpt("id", 99), strOpt("reason", "ghost")])])),
        "No warning **W-99** in this server.",
      );

      const info = await embedOf(await slash("warn", [sub("info", [intOpt("id", 1)])]));
      assert.equal(fieldOf(info, "Status").value, "Voided");
      assert.ok(fieldOf(info, "Voided").value.includes(`<@${env.ids.human}>`));
      assert.equal(fieldOf(info, "Void reason").value, "resolved with member");

      // List default excludes voided; include_voided adds it + ~~voided~~.
      const list = await contentOf(await slash("warn", [sub("list", [userOpt("user", env.ids.target)])]));
      assert.match(list, /\*\*2\*\* active · 2 listed/);
      assert.ok(!list.includes("**W-1**"), "voided excluded");

      const all = await contentOf(
        await slash("warn", [sub("list", [userOpt("user", env.ids.target), boolOpt("include_voided", true)])]),
      );
      assert.match(all, /3 total \(incl\. voided\) · including voided/);
      assert.ok(all.includes("~~voided~~"), "voided marker renders");

      // Dedicated warn-log channel received issue + void embeds.
      const titles = await msgTitles(log());
      assert.equal(titles.filter((t) => t === "Warning issued").length, 3);
      assert.ok(titles.includes("Warning voided"));

      assert.ok(auditRow("warnings.void"));
    });

    it("forced runWarnExpiryTick voids expired warns; setwarn log clear falls back dark", async () => {
      const a4 = await addWarn([
        userOpt("user", env.ids.target),
        strOpt("reason", "short fuse"),
        intOpt("expires_days", 1),
      ]);
      st.w4 = a4.n;
      assert.equal(fieldOf(a4.embed, "Expires").value.endsWith("(1d)"), true, "per-warn override beats 30d default");

      // Clock injection (no DB surgery): tick 2 days ahead → W-4 is due.
      const { runWarnExpiryTick } = require("../../src/features/warnings/ticker");
      const res = await runWarnExpiryTick(env.supervisor, { now: Date.now() + 2 * 86400000 });
      assert.ok(res.voided >= 1, `tick voided the expired warn (got ${JSON.stringify(res)})`);

      const row = warnRow(st.w4);
      assert.ok(row.voided_at != null);
      assert.equal(row.void_reason, "Auto-voided: expiry date reached");
      assert.equal(String(row.voided_by), env.ids.app, "auto-void attributed to the bot");
      assert.equal(activeCount(env.ids.target), 2, "expired warn left the active count");

      const titles = await msgTitles(log());
      assert.ok(titles.includes("Warning auto-voided (expired)"), "expiry embed to warn log");

      // Target sees it in full history as voided.
      const mine = await contentOf(
        await slash("warn", [sub("mine", [boolOpt("include_voided", true)])], env.ids.target),
      );
      assert.ok(mine.includes("~~voided~~"), "mine include_voided renders voided rows");

      // Clear the dedicated log: dark fallback copy (no audit channel set).
      const cleared = await contentOf(await slash("setwarn", [sub("log", [boolOpt("clear", true)])]));
      assert.equal(
        cleared,
        "Dedicated warning log channel cleared. No audit log is set either — issue/void will not post channel embeds until one is configured.",
      );
      assert.equal(env.dbmod.getGuildSettings(env.communityId).warn_log_channel_id, null);
      assert.match(
        await contentOf(await slash("warn", [sub("settings")])),
        /Warning log: _not set_/,
      );
      assert.ok(auditRow("warnings.log_channel_clear"));
    });

    // #312 DELIVERED: the mock now parses multipart interaction callbacks, so
    // the former "warn export blocked" todo became this live arm. (Record
    // STRUCTURE stays unit-covered in test/warningsExport*.)
    it("/warn export replies ephemerally with the staff-record .md attachment", async () => {
      for (const reason of ["EXPORT-MARKER alpha", "EXPORT-MARKER beta"]) {
        env.dbmod.createWarning({
          communityId: env.communityId,
          externalGuildId: env.ids.guild,
          userId: env.ids.target,
          issuerId: env.ids.human,
          reason,
          guildDefaultDays: 0,
        });
      }

      const inter = await slash("warn", [
        sub("export", [userOpt("user", env.ids.target)]),
      ]);
      const reply = await env.mock.awaitSettledReply(inter);
      assert.match(
        String(reply.content),
        new RegExp(
          `Staff record for <@${env.ids.target}>: \\*\\*\\d+\\*\\* warning\\(s\\), \\*\\*\\d+\\*\\* note\\(s\\) in file`,
        ),
      );

      const atts = reply.attachments ?? [];
      assert.equal(atts.length, 1, "the markdown export rides along");
      const att = atts[0];
      assert.match(
        String(att.filename),
        new RegExp(`^staff-record-${env.ids.target}-\\d{4}-\\d{2}-\\d{2}\\.md$`),
        "exportFilename contract",
      );
      assert.ok(att.size > 0, "non-empty file");

      const res = await fetch(att.url);
      assert.ok(res.ok, `export bytes served (HTTP ${res.status})`);
      const body = Buffer.from(await res.arrayBuffer()).toString("utf8");
      const hits = body.match(/EXPORT-MARKER/g) ?? [];
      assert.equal(hits.length, 2, "both seeded warnings made the record");
      assert.match(body, /Staff Record/i, "markdown header present");
    });

    it("/warn list pagination: full pages, tail page, out-of-range boundary copy", async () => {
      for (let i = 0; i < 12; i += 1) {
        env.dbmod.createWarning({
          communityId: env.communityId,
          externalGuildId: env.ids.guild,
          userId: env.ids.outsider,
          issuerId: env.ids.human,
          reason: `seeded spam ${i + 1}`,
          guildDefaultDays: 0,
        });
      }
      const p1 = await contentOf(
        await slash("warn", [sub("list", [userOpt("user", env.ids.outsider), intOpt("page", 1)])]),
      );
      assert.match(p1, new RegExp(`\\*\\*Warnings for <@${env.ids.outsider}>\\*\\* · page 1/2 · \\*\\*12\\*\\* active · 12 listed`));
      assert.equal((p1.match(/\*\*W-\d+\*\*/g) ?? []).length, 10, "page size 10");

      const p2 = await contentOf(
        await slash("warn", [sub("list", [userOpt("user", env.ids.outsider), intOpt("page", 2)])]),
      );
      assert.match(p2, /· page 2\/2 ·/);
      assert.equal((p2.match(/\*\*W-\d+\*\*/g) ?? []).length, 2, "tail page");

      assert.equal(
        await contentOf(
          await slash("warn", [sub("list", [userOpt("user", env.ids.outsider), intOpt("page", 3)])]),
        ),
        `No warnings on page **3** for <@${env.ids.outsider}> (pages 1–2).`,
      );
    });

    it("/note add: direct embed arm + note:add: modal round-trip; list feeds; info arms", async () => {
      // Omit content → modal display (type 9).
      const modalInter = await slash("note", [sub("add", [userOpt("user", env.ids.target)])]);
      const modal = await poll(async () => {
        const s = await env.mock.interactionState(modalInter.id);
        return s.response_json?.type === 9 ? s.response_json : null;
      }, { timeoutMs: 8000, label: "note:add modal display" });
      assert.equal(modal.data.custom_id, `note:add:${env.ids.target}`);
      assert.equal(modal.data.title, "Add staff note");
      assert.equal(modal.data.components[0].components[0].custom_id, "content");
      assert.equal(modal.data.components[0].components[0].required, true);

      // Round-trip the modal → note created (audit + subject pin).
      const submit = await env.mock.modal({
        customId: `note:add:${env.ids.target}`,
        fields: { content: "modal-authored note" },
        userId: env.ids.human,
      });
      const embed = (await replied(submit)).embeds?.[0];
      assert.equal(embed.title, "Note N-2 created");
      assert.equal(noteRow(2).content, "modal-authored note");
      assert.equal(String(noteRow(2).user_id), env.ids.target);

      const n3 = await embedOf(
        await slash("note", [sub("add", [userOpt("user", env.ids.outsider), strOpt("content", "outsider watch")])]),
      );
      assert.equal(n3.title, "Note N-3 created");

      const perUser = await contentOf(await slash("note", [sub("list", [userOpt("user", env.ids.target)])]));
      assert.match(
        perUser,
        new RegExp(`\\*\\*Staff notes for <@${env.ids.target}>\\*\\* · page 1/1 · 2 total`),
      );

      const feed = await contentOf(await slash("note", [sub("list")]));
      assert.match(feed, /\*\*Recent staff notes\*\* \(last 3 of 3\)/);
      assert.ok(feed.includes("· subject <@"), "guild feed shows subjects");

      const info = await embedOf(await slash("note", [sub("info", [intOpt("id", 2)])]));
      assert.equal(info.title, "Note N-2");
      assert.equal(fieldOf(info, "Subject").value, `<@${env.ids.target}>`);
      assert.equal(fieldOf(info, "Author").value, `<@${env.ids.human}>`);
      assert.equal(
        await contentOf(await slash("note", [sub("info", [intOpt("id", 77)])])),
        "No note **N-77** in this server.",
      );
    });

    it("/note edit lineage + modal prefill; delete/already-deleted/edit-deleted arms", async () => {
      // Slash edit persists lineage.
      const upd = await embedOf(
        await slash("note", [sub("edit", [intOpt("id", 1), strOpt("content", "edited body one")])]),
      );
      assert.equal(upd.title, "Note N-1 updated");
      assert.equal(upd.description, "edited body one");
      assert.equal(fieldOf(upd, "Edited by").value, `<@${env.ids.human}>`);
      const row = noteRow(1);
      assert.ok(row.edited_at != null && String(row.edited_by) === env.ids.human);

      const info = await embedOf(await slash("note", [sub("info", [intOpt("id", 1)])]));
      assert.ok(fieldOf(info, "Last edited").value.includes(`<@${env.ids.human}>`), "edit lineage renders");

      // Edit modal PREFILLED with the current body.
      const modalInter = await slash("note", [sub("edit", [intOpt("id", 1)])]);
      const modal = await poll(async () => {
        const s = await env.mock.interactionState(modalInter.id);
        return s.response_json?.type === 9 ? s.response_json : null;
      }, { timeoutMs: 8000, label: "note:edit modal display" });
      assert.equal(modal.data.custom_id, "note:edit:1");
      assert.equal(modal.data.title, "Edit N-1");
      assert.equal(modal.data.components[0].components[0].value, "edited body one", "prefill");

      const submit = await env.mock.modal({
        customId: "note:edit:1",
        fields: { content: "second edit" },
        userId: env.ids.human,
      });
      assert.equal((await replied(submit)).embeds?.[0].title, "Note N-1 updated");
      assert.equal(noteRow(1).content, "second edit");
      assert.ok(auditRow("notes.update"));

      // Soft-delete lifecycle on N-3 (the outsider note).
      const del = await contentOf(await slash("note", [sub("delete", [intOpt("id", 3)])]));
      assert.ok(
        del.startsWith(`Soft-deleted **N-3** about <@${env.ids.outsider}>.`),
        `delete copy (got: ${del})`,
      );
      assert.ok(noteRow(3).deleted_at != null, "soft delete keeps the row");
      assert.ok(auditRow("notes.delete"));

      assert.equal(
        await contentOf(await slash("note", [sub("delete", [intOpt("id", 3)])])),
        `Note **N-3** is already soft-deleted (by <@${env.ids.human}>).`,
      );
      assert.equal(
        await contentOf(await slash("note", [sub("edit", [intOpt("id", 3), strOpt("content", "nope")])])),
        "Note **N-3** is soft-deleted and cannot be edited. Add a new note instead.",
      );
      assert.equal(
        await contentOf(await slash("note", [sub("delete", [intOpt("id", 99)])])),
        "No note **N-99** in this server.",
      );

      // Deleted rendering: excluded by default, marked with include_deleted.
      assert.equal(
        await contentOf(await slash("note", [sub("list", [userOpt("user", env.ids.outsider)])])),
        `No active staff notes for <@${env.ids.outsider}>.`,
      );
      const incl = await contentOf(
        await slash("note", [sub("list", [userOpt("user", env.ids.outsider), boolOpt("include_deleted", true)])]),
      );
      assert.match(incl, /· 1 total · including deleted/);
      assert.ok(incl.includes("~~deleted~~"), "deleted marker renders");

      const settings = await contentOf(await slash("note", [sub("settings")]));
      assert.match(settings, /Active notes: \*\*2\*\* · soft-deleted: \*\*1\*\*/);
    });

    it("ticket close → tk:sn button (hint path) → tk:snm modal → note on requester", async () => {
      // Open + close WITHOUT the staff_note option: the reply carries the
      // "Optional: click Add staff note" hint + persistent button.
      const open = await slash(
        "ticket",
        [sub("for", [userOpt("user", env.ids.target), strOpt("reason", "ns14 wrap-up")])],
      );
      const m = new RegExp(`Ticket \\*\\*#1\\*\\* opened for <@${env.ids.target}>: <#(\\d+)>`).exec(
        String((await replied(open)).content),
      );
      assert.ok(m, "open-for reply");
      st.ticketChan = m[1];

      const close = await slash("ticket", [sub("close", [strOpt("reason", "wrap up")])], env.ids.human, st.ticketChan);
      const closeMsg = await replied(close);
      st.closeMsg = String(closeMsg.id);
      const closeText = String(closeMsg.content);
      assert.match(closeText, /Ticket \*\*#1\*\* closed\./);
      assert.match(closeText, /Optional: click \*\*Add staff note\*\* to record private context on/);

      const ticketId = env.dbmod.getTicketByNumber(env.communityId, 1).id;
      const buttons = await env.mock.buttons(st.closeMsg, st.ticketChan);
      const btn = buttons.find((b) => String(b.custom_id).startsWith("tk:sn:"));
      assert.equal(String(btn?.custom_id), `tk:sn:${ticketId}`);

      // Gate: outsider click denied.
      const outsiderClick = await env.mock.click({
        customId: `tk:sn:${ticketId}`,
        messageId: st.closeMsg,
        userId: env.ids.outsider,
        channelId: st.ticketChan,
      });
      assert.equal(
        String((await env.mock.awaitReply(outsiderClick)).content),
        "You don't have permission to use this.",
      );

      // Staff click → tk:snm modal.
      const click = await env.mock.click({
        customId: `tk:sn:${ticketId}`,
        messageId: st.closeMsg,
        userId: env.ids.human,
        channelId: st.ticketChan,
      });
      const modal = await poll(async () => {
        const s = await env.mock.interactionState(click.id);
        return s.response_json?.type === 9 ? s.response_json : null;
      }, { timeoutMs: 8000, label: "tk:snm modal display" });
      assert.equal(modal.data.custom_id, `tk:snm:${ticketId}`);
      assert.equal(modal.data.title, "Note · ticket #1");

      const submit = await env.mock.modal({
        customId: `tk:snm:${ticketId}`,
        fields: { staff_note: "post-close context" },
        userId: env.ids.human,
        channelId: st.ticketChan,
      });
      const replyText = String((await replied(submit)).content);
      const noteN = Number(replyText.match(/N-(\d+)/)?.[1]);
      assert.match(replyText, new RegExp(`Staff note \\*\\*N-${noteN}\\*\\* saved on <@${env.ids.target}>`));
      assert.match(replyText, new RegExp(`View with \`/note info id:${noteN}\``));

      const note = noteRow(noteN);
      assert.equal(String(note.user_id), env.ids.target, "note lands on the requester");
      assert.ok(note.content.includes("Ticket #1 closed"), `note body template (got: ${note.content})`);
      assert.ok(note.content.includes("Close reason: wrap up"));
      assert.ok(note.content.includes("post-close context"));

      // Invalid-reference arms ride the same button message.
      const ghost = await env.mock.click({
        customId: "tk:sn:999999999",
        messageId: st.closeMsg,
        userId: env.ids.human,
        channelId: st.ticketChan,
      });
      assert.equal(
        String((await env.mock.awaitReply(ghost)).content),
        "That ticket was not found in this server.",
      );
      const junk = await env.mock.click({
        customId: "tk:sn:oops",
        messageId: st.closeMsg,
        userId: env.ids.human,
        channelId: st.ticketChan,
      });
      assert.equal(
        String((await env.mock.awaitReply(junk)).content),
        "Invalid ticket reference on this button.",
      );

      const list = await contentOf(await slash("note", [sub("list", [userOpt("user", env.ids.target)])]));
      assert.match(list, /· 3 total/);
    });

    // Staff-side dmNote pins ("Member notified by DM." / "DM skipped
    // (silent)." / disabled copy) are asserted above; the member-side embed
    // render needs GET /users/@me/channels + message read in fauxcord.
    it.todo(
      "warn/void/expiry DM EMBED CONTENT stays unassertable (mock cannot list DM channels)",
    );
  },
);
