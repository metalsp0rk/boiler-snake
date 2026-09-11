const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");

describe("integration: github releases", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let processWatch;

  after(() => {
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    processWatch = require("../../src/features/githubReleases/ticker")
      .processWatch;
  });

  function rel(id, opts = {}) {
    return {
      id,
      tag: `v1.0.${id}`,
      name: opts.name ?? `Release ${id}`,
      body: opts.body ?? `notes ${id}`,
      prerelease: !!opts.prerelease,
      htmlUrl: `https://github.com/acme/widgets/releases/tag/v1.0.${id}`,
      author: "acme-bot",
      publishedAtMs: 1_700_000_000_000 + id * 1000,
    };
  }

  function fakeClient({ failSend = false } = {}) {
    const sent = [];
    const channel = {
      send: async (payload) => {
        if (failSend) throw new Error("missing permissions: Send Messages");
        sent.push(payload);
        return { id: `m${sent.length}` };
      },
    };
    return {
      sent,
      client: { channels: { fetch: async () => channel } },
    };
  }

  it("repo: add/get/update/remove watch with token semantics", () => {
    const row = env.db.addGithubWatch(env.guild.id, "https://github.com/Acme/Widgets", "Acme/Widgets", {
      channelId: env.channels.notify.id,
      token: "tok-1",
    });
    assert.equal(row.repo, "acme/widgets");
    assert.equal(row.channel_id, env.channels.notify.id);
    assert.equal(row.has_token, 1);
    assert.equal(row.last_release_id, null);

    // Re-add without token/channel keeps existing values (COALESCE)
    const readded = env.db.addGithubWatch(env.guild.id, "acme/widgets", "acme/widgets");
    assert.equal(readded.channel_id, env.channels.notify.id);
    assert.equal(readded.has_token, 1);

    const updated = env.db.updateGithubWatch(env.guild.id, "acme/widgets", {
      roleId: "role-9",
    });
    assert.equal(updated.role_id, "role-9");

    const cleared = env.db.updateGithubWatch(env.guild.id, "acme/widgets", {
      roleId: null,
      token: null,
    });
    assert.equal(cleared.role_id, null);
    assert.equal(cleared.has_token, 0);

    assert.equal(env.db.removeGithubWatch(env.guild.id, "acme/Widgets"), true);
    assert.equal(env.db.removeGithubWatch(env.guild.id, "acme/widgets"), false);
    assert.equal(env.db.getGithubWatch(env.guild.id, "acme/widgets"), null);
  });

  it("watch rows never leak the token through list/get", () => {
    env.db.addGithubWatch(env.guild.id, "sec/ret", "Sec/Ret", {
      channelId: env.channels.notify.id,
      token: "super-secret",
    });
    const list = env.db.getGithubWatches(env.guild.id);
    const row = list.find((w) => w.repo === "sec/ret");
    assert.equal(row.has_token, 1);
    assert.ok(!("token" in row), "display rows must not carry the token");
    const single = env.db.getGithubWatch(env.guild.id, "sec/ret");
    assert.ok(!("token" in single));
    env.db.removeGithubWatch(env.guild.id, "sec/ret");
  });

  it("baseline: first check posts only the newest release", async () => {
    env.db.addGithubWatch(env.guild.id, "acme/widgets", "Acme/Widgets", {
      channelId: env.channels.notify.id,
    });
    const watch = env.db.getAllGithubWatches().find((w) => w.repo === "acme/widgets");
    const { client, sent } = fakeClient();
    const calls = [];
    const deps = {
      fetchReleases: async (repo, token) => {
        calls.push({ repo, token });
        return { ok: true, releases: [rel(3), rel(2), rel(1)] };
      },
    };

    const result = await processWatch(client, watch, deps);
    assert.deepEqual(calls, [{ repo: "acme/widgets", token: null }]);
    assert.equal(result.ok, true);
    assert.equal(result.announced, 1);
    assert.equal(sent.length, 1);

    const after = env.db.getGithubWatch(env.guild.id, "acme/widgets");
    assert.equal(after.last_release_id, 3);
    assert.equal(after.last_release_published_at, rel(3).publishedAtMs);
    assert.ok(after.last_checked > 0);
    env.db.removeGithubWatch(env.guild.id, "acme/widgets");
  });

  it("multiple releases between ticks send one message each, oldest-first", async () => {
    env.db.addGithubWatch(env.guild.id, "acme/widgets", "Acme/Widgets", {
      channelId: env.channels.notify.id,
    });
    env.db.updateGithubWatchReleaseState(env.guild.id, "acme/widgets", {
      lastReleaseId: 3,
      lastReleasePublishedAt: rel(3).publishedAtMs,
      lastChecked: Date.now(),
    });
    const watch = env.db.getAllGithubWatches().find((w) => w.repo === "acme/widgets");
    const { client, sent } = fakeClient();
    const deps = {
      fetchReleases: async () => ({
        ok: true,
        releases: [rel(5, { name: "five" }), rel(4, { name: "four" }), rel(3)],
      }),
    };

    const result = await processWatch(client, watch, deps);
    assert.equal(result.announced, 2);
    const titles = sent.map((p) => p.embeds[0].toJSON().title);
    assert.deepEqual(titles, ["📦 four", "📦 five"]);

    const after = env.db.getGithubWatch(env.guild.id, "acme/widgets");
    assert.equal(after.last_release_id, 5);
    env.db.removeGithubWatch(env.guild.id, "acme/widgets");
  });

  it("failed send keeps the pointer for retry next tick", async () => {
    env.db.addGithubWatch(env.guild.id, "acme/widgets", "Acme/Widgets", {
      channelId: env.channels.notify.id,
    });
    env.db.updateGithubWatchReleaseState(env.guild.id, "acme/widgets", {
      lastReleaseId: 3,
      lastReleasePublishedAt: rel(3).publishedAtMs,
      lastChecked: Date.now(),
    });
    const watch = env.db.getAllGithubWatches().find((w) => w.repo === "acme/widgets");
    const { client, sent } = fakeClient({ failSend: true });
    const deps = {
      fetchReleases: async () => ({ ok: true, releases: [rel(4), rel(3)] }),
    };

    const result = await processWatch(client, watch, deps);
    assert.equal(result.ok, false);
    assert.equal(result.announced, 0);
    assert.match(result.error, /could not deliver/i);
    assert.equal(sent.length, 0);

    const after = env.db.getGithubWatch(env.guild.id, "acme/widgets");
    assert.equal(after.last_release_id, 3, "pointer must not advance");
    env.db.removeGithubWatch(env.guild.id, "acme/widgets");
  });

  it("failed GitHub lookup keeps the pointer and reports the cause", async () => {
    env.db.addGithubWatch(env.guild.id, "acme/widgets", "Acme/Widgets", {
      channelId: env.channels.notify.id,
      token: "tok",
    });
    env.db.updateGithubWatchReleaseState(env.guild.id, "acme/widgets", {
      lastReleaseId: 7,
      lastReleasePublishedAt: rel(7).publishedAtMs,
      lastChecked: Date.now(),
    });
    const watch = env.db.getAllGithubWatches().find((w) => w.repo === "acme/widgets");
    const { client, sent } = fakeClient();
    const deps = {
      fetchReleases: async () => ({ ok: false, error: "GitHub rate limit reached" }),
    };

    const result = await processWatch(client, watch, deps);
    assert.equal(result.ok, false);
    assert.match(result.error, /rate limit/);
    assert.equal(sent.length, 0);

    const after = env.db.getGithubWatch(env.guild.id, "acme/widgets");
    assert.equal(after.last_release_id, 7);
    env.db.removeGithubWatch(env.guild.id, "acme/widgets");
  });

  it("watch without channel is skipped before any API call", async () => {
    env.db.addGithubWatch(env.guild.id, "no/channel", "No/Channel");
    const watch = env.db.getAllGithubWatches().find((w) => w.repo === "no/channel");
    let fetched = false;
    const { client } = fakeClient();
    const result = await processWatch(client, watch, {
      fetchReleases: async () => {
        fetched = true;
        return { ok: true, releases: [] };
      },
    });
    assert.equal(fetched, false);
    assert.equal(result.ok, false);
    assert.match(result.skipped, /no channel configured/);
    env.db.removeGithubWatch(env.guild.id, "no/channel");
  });

  it("/github watch rejects malformed repo refs", async () => {
    const interaction = await env.runCommand({
      commandName: "github",
      subcommand: "watch",
      admin: true,
      options: { repo: "not-a-repo-ref" },
    });
    assertEphemeralReply(interaction, /not a repository reference/i);
  });

  it("/github list reports watches and /github remove deletes them", async () => {
    env.db.addGithubWatch(env.guild.id, "demo/app", "Demo/App", {
      channelId: env.channels.notify.id,
    });

    const list = await env.runCommand({
      commandName: "github",
      subcommand: "list",
      admin: true,
      options: {},
    });
    assertReplyContains(list, /Demo\/App/);
    assert.ok(
      env.db.getGithubWatches(env.guild.id).length >= 1,
    );

    const removed = await env.runCommand({
      commandName: "github",
      subcommand: "remove",
      admin: true,
      options: { repo: "demo/app" },
    });
    assertReplyContains(removed, /Stopped tracking/i);
    assert.equal(env.db.getGithubWatch(env.guild.id, "demo/app"), null);

    const missing = await env.runCommand({
      commandName: "github",
      subcommand: "remove",
      admin: true,
      options: { repo: "demo/app" },
    });
    assertReplyContains(missing, /not tracked/i);
  });

  it("/github channel and /github role configure an existing watch", async () => {
    env.db.addGithubWatch(env.guild.id, "demo/app", "Demo/App");

    const ch = await env.runCommand({
      commandName: "github",
      subcommand: "channel",
      admin: true,
      options: { repo: "demo/app", channel: env.channels.notify },
    });
    assertReplyContains(ch, /sent to/i);
    assert.equal(
      env.db.getGithubWatch(env.guild.id, "demo/app").channel_id,
      env.channels.notify.id,
    );

    const role = { id: "role-exempt", toString: () => "<@&role-exempt>" };
    const withRole = await env.runCommand({
      commandName: "github",
      subcommand: "role",
      admin: true,
      options: { repo: "demo/app", role },
    });
    assertReplyContains(withRole, /will mention/i);
    assert.equal(
      env.db.getGithubWatch(env.guild.id, "demo/app").role_id,
      "role-exempt",
    );

    const untracked = await env.runCommand({
      commandName: "github",
      subcommand: "channel",
      admin: true,
      options: { repo: "no/such", channel: env.channels.notify },
    });
    assertReplyContains(untracked, /not tracked/i);

    env.db.removeGithubWatch(env.guild.id, "demo/app");
  });

  it("/github check reports config issues without calling GitHub", async () => {
    env.db.addGithubWatch(env.guild.id, "demo/app", "Demo/App");
    const interaction = await env.runCommand({
      commandName: "github",
      subcommand: "check",
      admin: true,
      options: {},
    });
    assertReplyContains(interaction, /Checked 1 watch/i);
    assertReplyContains(interaction, /no channel configured/i);
    env.db.removeGithubWatch(env.guild.id, "demo/app");
  });

  it("/github is denied for non-staff", async () => {
    const interaction = await env.runCommand({
      commandName: "github",
      subcommand: "list",
      admin: false,
      options: {},
    });
    assertEphemeralReply(interaction, /permission/i);
  });
});
