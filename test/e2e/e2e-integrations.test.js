const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll, namespaceIds } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — see e2e-buttons/e2e-reactions headers.

/**
 * Tier-4 integrations coverage (issue #324). Namespace 19.
 *
 * Structural limit honored: no live-network reliance — assertions are the
 * pre-external-call paths, key-missing guidance, DB-seeded row surfaces,
 * autocomplete over seeded rows (mock autocomplete-sim shipped in patch v7 —
 * the issue's "gap" note is stale), and failure-path copy STRUCTURE only
 * (e.g. `/github watch` always answers `Could not track **repo**: <cause>`,
 * whether the network 404s or DNS dies).
 *
 * Deterministic offline facts pinned by the product: with no
 * YOUTUBE_API_KEY the YouTube api helpers return null BEFORE any call, so
 * `/youtube add` (UC-id / @handle forms) still SUBSCRIBES locally with a
 * fallback thumbnail, and `/testnotification` on an id with no resolvable
 * channel answers the specific "Could not find…" copy — never generic.
 * TWITCH creds absent ⇒ `/twitch add` answers the set-the-env guidance
 * while remove/list/clips/vod run fully OFF the API over seeded rows.
 * A `/github watch … token:` without TOKEN_ENCRYPTION_KEY refuses BEFORE
 * the API call with the key-vocabulary copy.
 *
 * Github REPO autocomplete itself is already pinned by ns23 (e2e-mockgaps);
 * here it's youtube/twitch autocomplete over seeded rows + the row CRUD.
 */
describe(
  "e2e: integrations degradation — /youtube + /twitch + /github surfaces, key-missing guidance, seeded rows + autocomplete",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    const logs = () => env.ids.channel2;

    before(async () => {
      const ids = namespaceIds(19);
      env = await createE2eEnv({
        ns: 19,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "it-logs" },
        ],
      });
      const mg = await env.mock.createRole("E2E IT Admin MG", {
        permissions: String(PermissionFlagsBits.ManageGuild),
      });
      await env.mock.grantRole(env.ids.human, mg.id);
      env.dbmod.updateGuildSettings(env.communityId, {
        audit_log_channel_id: env.ids.channel2,
      });
    });

    after(async () => {
      await env?.cleanup();
    });

    const sub = (name, options = []) => ({ name, type: 1, ...(options.length && { options }) });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const roleOpt = (name, id) => ({ name, type: 8, value: id });
    const intOpt = (name, value) => ({ name, type: 4, value });

    const slash = (command, options, who = env.ids.human) =>
      env.mock.slash({ command, options, userId: who });
    const contentOf = async (inter) => String((await env.mock.awaitSettledReply(inter)).content);

    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);

    const autocompleteChoices = async (command, option, focused) => {
      const inter = await env.mock.autocomplete({
        command,
        options: [{ name: option, type: 3, value: focused, focused: true }],
      });
      const state = await poll(async () => {
        const s = await env.mock.interactionState(inter.id);
        return s?.response_json?.data ? s : null;
      }, { timeoutMs: 8000, label: `${command}:${option} autocomplete` });
      return state.response_json.data.choices ?? [];
    };

    it("staff gates across every integrations command (outsider denied on all six)", async () => {
      const denied = "You don't have permission to use this.";
      const cases = [
        ["youtube", [sub("list")]],
        ["setyoutube", [sub("channel", [chanOpt("channel", env.ids.general)])]],
        ["testnotification", [strOpt("channel", "UCwhatever")]],
        ["twitch", [sub("list")]],
        ["settwitch", [sub("channel", [chanOpt("channel", env.ids.general)])]],
        ["github", [sub("list")]],
      ];
      for (const [cmd, options] of cases) {
        assert.equal(await contentOf(await slash(cmd, options, env.ids.outsider)), denied, `/${cmd}`);
      }
    });

    it("/youtube: invalid copy, offline UC + @handle subscribes, list states, remove arms", async () => {
      assert.equal(
        await contentOf(await slash("youtube", [sub("list")])),
        "No YouTube channels subscribed.",
      );

      const invalid = await contentOf(await slash("youtube", [sub("add", [strOpt("url", "just words")])]));
      assert.match(invalid, /^Invalid YouTube URL\. Please use:/);

      // No YOUTUBE_API_KEY ⇒ api helpers null out BEFORE any network call;
      // the UC-id arm still subscribes with a fallback thumbnail.
      const uc = "UCe2efakechannelid0001";
      const added = await contentOf(await slash("youtube", [sub("add", [strOpt("url", uc)])]));
      assert.equal(added, `Subscribed to **@Channel ID: ${uc}**. I'll notify when they go live.`);
      let rows = env.dbmod.getYoutubeChannels(env.communityId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, uc);
      assert.ok(auditRow("youtube.channel_add"), "channel_add audit");

      const handleAdd = await contentOf(
        await slash("youtube", [sub("add", [strOpt("url", "https://www.youtube.com/@e2efakechan")])]),
      );
      assert.equal(handleAdd, "Subscribed to **@e2efakechan**. I'll notify when they go live.");

      const listed = await contentOf(await slash("youtube", [sub("list")]));
      assert.match(listed, /\*\*YouTube subscriptions\*\* \(2\)/);
      assert.ok(listed.includes("Notification channel: _Not configured_"), listed);
      assert.ok(listed.includes(`ID: \`${uc}\``), listed);
      assert.ok(listed.includes("`@e2efakechan`") || listed.includes("**@e2efakechan**"), listed);

      // NOTE: no guild-settings writes below — updateGuildSettings silently
      // deletes the @handle row (BUG #360), so the set-channel/list-with-channel
      // arm lives in its own test against a UC-shaped row AFTER autocomplete.
      assert.equal(
        await contentOf(await slash("youtube", [sub("remove", [strOpt("channel", "UCnope")])])),
        "No subscription found.",
      );
      const removed = await contentOf(await slash("youtube", [sub("remove", [strOpt("channel", uc)])]));
      assert.match(removed, /Unsubscribed from/);
      assert.ok(auditRow("youtube.channel_remove"));
      assert.deepEqual(
        env.dbmod.getYoutubeChannels(env.communityId).map((r) => r.id),
        ["e2efakechan"],
        "UC row removed; the @handle row survives when no settings write happens",
      );
    });

    it("/youtube autocomplete over seeded rows (focused filter + value=id contract)", async () => {
      const choices = await autocompleteChoices("youtube", "channel", "e2efake");
      assert.deepEqual(
        choices.map((c) => [c.name, c.value]),
        [["@e2efakechan", "e2efakechan"]],
      );
      const none = await autocompleteChoices("youtube", "channel", "zzzz");
      assert.deepEqual(none, []);
      env.dbmod.removeYoutubeChannel(env.communityId, "e2efakechan");
    });

    it("/setyoutube channel: persists + list reflects it (UC-shaped row; @handle rows die on settings writes — #360)", async () => {
      const probe = "UCsetchanprobe000000001";
      env.dbmod.addYoutubeChannel(env.communityId, probe, "Channel ID: probe", probe, "");
      try {
        const chSet = await contentOf(
          await slash("setyoutube", [sub("channel", [chanOpt("channel", env.ids.general)])]),
        );
        assert.equal(chSet, `YouTube notifications will be sent to <#${env.ids.general}>.`);
        assert.equal(
          env.dbmod.getGuildSettings(env.communityId).youtube_notification_channel_id,
          env.ids.general,
        );
        assert.ok(auditRow("youtube.notify_channel_set"), "notify_channel_set audit");
        const listed = await contentOf(await slash("youtube", [sub("list")]));
        assert.ok(listed.includes(`Notification channel: <#${env.ids.general}>`), listed);
      } finally {
        env.dbmod.removeYoutubeChannel(env.communityId, probe);
      }
    });

    it("/setyoutube interval bounds (handler-side) + uploadrole set/clear", async () => {
      assert.equal(
        await contentOf(await slash("setyoutube", [sub("interval", [intOpt("minutes", 0)])])),
        "Polling interval must be between 1 and 60 minutes.",
      );
      assert.equal(
        await contentOf(await slash("setyoutube", [sub("interval", [intOpt("minutes", 15)])])),
        "YouTube polling interval set to **15** minute(s).",
      );
      assert.equal(env.dbmod.getGuildSettings(env.communityId).youtube_polling_interval_minutes, 15);

      const role = await env.mock.createRole("E2E IT Ping");
      const set = await contentOf(await slash("setyoutube", [sub("uploadrole", [roleOpt("role", role.id)])]));
      assert.match(set, new RegExp(`<@&${role.id}>`));
      assert.equal(env.dbmod.getGuildSettings(env.communityId).youtube_upload_role_id, role.id);

      const cleared = await contentOf(await slash("setyoutube", [sub("uploadrole", [])]));
      assert.equal(cleared, "Upload notifications will no longer mention a role.");
      assert.ok(
        !env.dbmod.getGuildSettings(env.communityId).youtube_upload_role_id,
        "role cleared from settings",
      );
    });

    it("@handle youtube subscriptions SURVIVE every guild-settings write (#360 fixed)", async () => {
      // #360 (DB-3): updateGuildSettings used to end with
      // cleanupMalformedYoutubeChannels() — sweeping every non-UC/HC row,
      // which is the by-design @handle storage shape from `/youtube add`
      // while resolution is pending. Any /set* in ANY feature quietly
      // unsubscribed the user. The side effect is gone and the cleanup is
      // INERT: one row per (community, name) is REPLACE-enforced, so a
      // sweep of non-UC ids could only ever kill live pending subs.
      env.dbmod.addYoutubeChannel(
        env.communityId,
        "e2edataloss",
        "e2edataloss",
        "https://www.youtube.com/@e2edataloss",
        "",
      );
      const ucSurvivor = "UCsurvivor00000000000001";
      env.dbmod.addYoutubeChannel(env.communityId, ucSurvivor, "Channel ID: survivor", ucSurvivor, "");
      try {
        assert.equal(env.dbmod.getYoutubeChannels(env.communityId).length, 2, "both rows seeded");
        env.dbmod.updateGuildSettings(env.communityId, { youtube_polling_interval_minutes: 7 });
        const ids = env.dbmod.getYoutubeChannels(env.communityId).map((r) => r.id);
        assert.ok(ids.includes("e2edataloss"), "#360: the pending @handle row SURVIVES the settings write");
        assert.ok(ids.includes(ucSurvivor), "UC-shaped rows survive too");

        // The (now inert) cleanup itself never resurrects a name sweep.
        env.dbmod.cleanupMalformedYoutubeChannels();
        assert.ok(
          env.dbmod.getYoutubeChannels(env.communityId).some((r) => r.id === "e2edataloss"),
          "a pending row is a subscription, not debris — no sweep, ever",
        );
      } finally {
        env.dbmod.removeYoutubeChannel(env.communityId, "e2edataloss");
        env.dbmod.removeYoutubeChannel(env.communityId, ucSurvivor);
      }
    });

    it("/testnotification: invalid URL copy offline; unresolvable id answers the specific find copy", async () => {
      assert.equal(
        await contentOf(await slash("testnotification", [strOpt("channel", "not a url")])),
        "Invalid YouTube URL.",
      );
      // UC-id row not subscribed + no API key ⇒ "Could not find or subscribe"
      // (never the router generic — error rule 3).
      const copy = await contentOf(
        await slash("testnotification", [strOpt("channel", "UCneverseen123456")]),
      );
      assert.match(
        copy,
        /could not (find|fetch)/i,
        `specific actionable copy (got: ${copy})`,
      );
      assert.doesNotMatch(copy, /check bot logs|unknown error/i, "never generic");
    });

    it("/twitch: creds guidance BEFORE any call; seeded-row list/clips/vod/remove run API-free", async () => {
      const added = await contentOf(await slash("twitch", [sub("add", [strOpt("login", "e2estream")])]));
      assert.equal(
        added,
        "Twitch is not configured on this bot. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` first.",
      );

      assert.equal(
        await contentOf(await slash("twitch", [sub("list")])),
        "No Twitch channels subscribed.",
      );

      env.dbmod.addTwitchChannel(env.communityId, "100001", "e2estream", "E2EStream", "");
      const listed = await contentOf(await slash("twitch", [sub("list")]));
      assert.match(listed, /\*\*Twitch subscriptions\*\* \(1\)/);
      assert.ok(listed.includes("• **E2EStream** (`e2estream`)"), listed);
      assert.ok(listed.includes("Notification channel:"), listed);

      const clipsOn = await contentOf(
        await slash("twitch", [sub("clips", [strOpt("channel", "e2estream"), { name: "enabled", type: 5, value: true }])]),
      );
      assert.match(clipsOn, /announce new \*\*clips\*\* from \*\*E2EStream\*\*/);
      assert.match(
        clipsOn,
        /no notification channel is set yet; run `\/settwitch channel`/,
        "channel-less enable carries the next-step guidance",
      );
      assert.ok(auditRow("twitch.clips_toggle"));

      const chSet = await contentOf(
        await slash("settwitch", [sub("channel", [chanOpt("channel", logs())])]),
      );
      assert.equal(chSet, `Twitch go-live notifications will be sent to <#${logs()}>.`);

      const vodOn = await contentOf(
        await slash("twitch", [sub("vod", [strOpt("channel", "e2estream"), { name: "enabled", type: 5, value: true }])]),
      );
      assert.match(vodOn, /announce new \*\*VODs\*\*.*to <#/);

      const listed2 = await contentOf(await slash("twitch", [sub("list")]));
      assert.ok(listed2.includes("_(clips + vods)_"), `flags in list line: ${listed2}`);

      assert.equal(
        await contentOf(await slash("twitch", [sub("remove", [strOpt("channel", "ghost")])])),
        "No matching subscription found.",
      );
      const gone = await contentOf(await slash("twitch", [sub("remove", [strOpt("channel", "e2estream")])]));
      assert.equal(gone, "Unsubscribed from **E2EStream**.");
    });

    it("/twitch autocomplete matches login OR display name", async () => {
      env.dbmod.addTwitchChannel(env.communityId, "100002", "e2etw", "E2E Two", "");
      try {
        const byLogin = await autocompleteChoices("twitch", "channel", "e2et");
        assert.deepEqual(byLogin.map((c) => [c.name, c.value]), [["E2E Two", "e2etw"]]);
        const byDisplay = await autocompleteChoices("twitch", "channel", "two");
        assert.equal(byDisplay.length, 1, "display-name match");
      } finally {
        env.dbmod.removeTwitchChannel(env.communityId, "e2etw");
      }
    });

    it("/github: ref validation, token-without-key refusal (pre-network), untracked arms", async () => {
      const bad = await contentOf(await slash("github", [sub("watch", [strOpt("repo", "not a repo")])]));
      assert.match(bad, /is not a repository reference\. Use `owner\/name` or a GitHub URL\./);

      // #444: token entry lives in /github token (modal-only). Without
      // TOKEN_ENCRYPTION_KEY the command must refuse BEFORE ever opening
      // the prompt — same pre-network guarantee, new surface.
      const refused = await contentOf(
        await slash("github", [sub("token", [strOpt("repo", "octo/hello")])]),
      );
      assert.match(
        refused,
        /Cannot store a GitHub token: TOKEN_ENCRYPTION_KEY .* is not configured\. Tokens are never stored in plaintext/,
      );

      // Untracked arms for remove/channel/role — specific, never generic:
      assert.match(
        await contentOf(await slash("github", [sub("remove", [strOpt("repo", "octo/ghost")])])),
        /\*\*octo\/ghost\*\* is not tracked in this server\./,
      );
      assert.match(
        await contentOf(
          await slash("github", [sub("channel", [strOpt("repo", "octo/ghost"), chanOpt("channel", logs())])]),
        ),
        /is not tracked here\. Add it with `\/github watch` first\./,
      );

      // The watch arm ALWAYS fails through fetchRepo (fake repo 404 online,
      // DNS fail offline) — assert the STRUCTURE, not the network cause.
      const failed = await contentOf(
        await slash("github", [sub("watch", [strOpt("repo", "e2e-fake-owner/e2e-fake-repo")])]),
      );
      assert.match(
        failed,
        /^Could not track \*\*e2e-fake-owner\/e2e-fake-repo\*\*: .+/,
        `actionable failure structure (got: ${failed})`,
      );
    });

    it("/github seeded-row surfaces: list lines, channel/role set, remove", async () => {
      assert.equal(
        await contentOf(await slash("github", [sub("list")])),
        "No GitHub repositories tracked. Add one with `/github watch`.",
      );

      env.dbmod.addGithubWatch(env.communityId, "e2e/repoA", "E2EOrg/repoA", {});
      const listed = await contentOf(await slash("github", [sub("list")]));
      assert.match(listed, /\*\*GitHub release watches\*\* \(1\)/);
      assert.ok(listed.includes("• **E2EOrg/repoA** → **no channel**"), listed);

      const chSet = await contentOf(
        await slash("github", [sub("channel", [strOpt("repo", "e2e/repoA"), chanOpt("channel", logs())])]),
      );
      assert.equal(chSet, "Release notes for **E2EOrg/repoA** will be sent to <#" + logs() + ">.");

      const role = await env.mock.createRole("E2E IT Release Ping");
      const roleSet = await contentOf(
        await slash("github", [sub("role", [strOpt("repo", "e2e/repoA"), roleOpt("role", role.id)])]),
      );
      assert.match(roleSet, new RegExp(`<@&${role.id}>`));

      const listed2 = await contentOf(await slash("github", [sub("list")]));
      assert.ok(
        listed2.includes(`→ <#${logs()}> · ping <@&${role.id}>`),
        `list shows channel + role: ${listed2}`,
      );

      const removed = await contentOf(await slash("github", [sub("remove", [strOpt("repo", "e2e/repoA")])]));
      assert.equal(removed, "Stopped tracking **E2EOrg/repoA**.");
      assert.equal(
        await contentOf(await slash("github", [sub("list")])),
        "No GitHub repositories tracked. Add one with `/github watch`.",
      );
    });

    it("/github check answers the rollup structure even when every fetch fails", async () => {
      env.dbmod.addGithubWatch(env.communityId, "e2e/offline", "E2EOrg/offline", {});
      try {
        const inter = await slash("github", [sub("check", [strOpt("repo", "e2e/offline")])]);
        const msg = await env.mock.awaitSettledReply(inter);
        assert.match(String(msg.content), /^Checked 1 watch\(es\)\. \d+ release\(s\) announced\./);
        if (/Issues:/.test(msg.content)) {
          assert.ok(msg.content.split("Issues:")[1].trim().length > 0, "issues listed with causes");
        }
      } finally {
        env.dbmod.removeGithubWatch
          ? env.dbmod.removeGithubWatch(env.communityId, "e2e/offline")
          : null;
      }
    });

    // Live-success arms need real third-party creds (YouTube/Twitch/GitHub
    // API keys + valid resources) — out of program scope by design (#324
    // structural limit); failure-path copy above is the contract.
    it.todo("youtube/twitch/github announce happy paths need live creds + fixtures (by-design dark)");
  },
);
