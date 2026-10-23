const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

/**
 * Command + subscription-service unit sections for RSS feed notifications
 * (issue #305, subtask 07): src/features/rss/{subscriptions,commands}.js
 * against a REAL migrated SQLite (loadDb() harness — same fidelity bar as
 * test/rss-poller.test.js), with every external seam faked through the
 * featureCtx.rss DI box ({ fetchImpl, resolveHost, env, now }) and a hand-
 * built CommandContext (the test/fluxer-honeypot-banrole.test.js pattern).
 * No network, no wall clock, no Discord.
 *
 * Pins of the subtask-07 contract:
 *  - add-flow table: scheme cause, SSRF refusal cause, parse cause, empty
 *    feed cause, duplicate refusal (repository null), cap refusal NAMES the
 *    cap, happy path stores resolved title/link + addedBy;
 *  - the standing config gate (no rss_notification_channel_id) surfaces as
 *    an actionable /setrss-channel error on add AND test (and check);
 *  - /rss test posts via format.buildNotification + outbound WITHOUT any
 *    poll-state writes (the documented poller-reuse divergence);
 *  - /rss check reuses pollFeedRow with force (state writes DO happen, and
 *    the clock gate is bypassed — proven via an interval that would gate);
 *  - /setrss interval rejects outside 1–60 without writing (the schema
 *    column is NOT NULL);
 *  - feed: autocomplete names display_name || feed_title || url-truncated,
 *    values are the stored urls.
 */
describe("rss commands", () => {
  let api;
  let cleanup;
  let commands;
  let subscriptions;

  before(() => {
    // Contract: loadDb() before any `src/` require in this file (fresh temp
    // DB_PATH + require-cache reset). The feature is required AFTER it.
    ({ api, cleanup } = loadDb());
    commands = require("../src/features/rss/commands");
    subscriptions = require("../src/features/rss/subscriptions");
  });

  after(() => cleanup?.());

  // ---------------------------------------------------------------------------
  // Fixtures and seams (same vocabulary as test/rss-poller.test.js)
  // ---------------------------------------------------------------------------

  const MIN = 60_000;
  /** Fixed epoch (2024-10-27T06:13:20Z), second-aligned so RFC-822 pubDates
   * round-trip exactly through rss-parser. */
  const T0 = 1_730_000_000_000;

  const MANAGE_GUILD = 1n << 5n;

  /** Public-IP DNS fake — the SSRF class-check passes (03 owns its contract). */
  const resolveHostOk = async () => ["93.184.216.34"];
  /** Loopback DNS fake — the shared guard refuses with "…address range…". */
  const resolveHostPrivate = async () => ["127.0.0.1"];

  function httpOk(body) {
    return {
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from(String(body), "utf8"),
    };
  }

  function HttpStatus(status) {
    return { status, headers: { get: () => null } };
  }

  function fetchStub(...responses) {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url, init });
      const res = responses[Math.min(calls.length - 1, responses.length - 1)];
      return typeof res === "function" ? res(url, init) : res;
    };
    fn.calls = calls;
    return fn;
  }

  function rss2(items, { title = "Example News", link = "https://example.com" } = {}) {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<rss version="2.0"><channel><title>${title}</title>` +
      `<link>${link}</link><description>Headlines</description>` +
      items.join("") +
      "</channel></rss>"
    );
  }

  function rssItem({ guid, title, link, pubMs }) {
    return (
      "<item>" +
      (guid ? `<guid>${guid}</guid>` : "") +
      (title ? `<title>${title}</title>` : "") +
      (link ? `<link>${link}</link>` : "") +
      (pubMs != null ? `<pubDate>${new Date(pubMs).toUTCString()}</pubDate>` : "") +
      "</item>"
    );
  }

  /** Fake OutboundClient: records sends (poller-test shape). */
  function makeOutbound() {
    const sent = [];
    return {
      sent,
      async sendChannel(channelId, payload) {
        sent.push({ channelId, payload });
        return { ok: true };
      },
    };
  }

  /** Hand-built CommandContext (fluxer-honeypot-banrole.test.js pattern). */
  function makeCtx({
    communityId,
    commandName,
    sub,
    options = {},
    outbound = null,
    channelPermissions = MANAGE_GUILD,
  }) {
    const replies = [];
    const read = (name) => (options[name] === undefined ? null : options[name]);
    const ctx = {
      platform: "discord",
      instanceKey: "discord",
      communityId,
      externalGuildId: `guild-${communityId}`,
      channelId: "chan-cmd",
      userId: "u-rss-cmd",
      user: { id: "u-rss-cmd", username: "rssadmin", bot: false },
      commandName,
      subcommandGroup: null,
      subcommand: sub,
      options: {
        getString: read,
        getInteger: read,
        getNumber: read,
        getBoolean: read,
        getUser: read,
        getRole: read,
        getChannel: read,
      },
      channelPermissions,
      memberRoleIds: [],
      guildOwner: false,
      deferred: false,
      replied: false,
      reply: async (payload) => {
        replies.push(payload);
      },
      editReply: async () => {},
      followUp: async () => {},
      defer: async () => {},
      outbound,
    };
    return { ctx, replies };
  }

  /** featureCtx carrying ONLY the DI box the handlers understand. */
  function diBox(over = {}) {
    return { rss: { resolveHost: resolveHostOk, ...over } };
  }

  const runRss = (ctx, featureCtx) => commands.handlers.rss(ctx, featureCtx);
  const runSetRss = (ctx, featureCtx) => commands.handlers.setrss(ctx, featureCtx);

  /** Community with the standing RSS config gate satisfied. */
  function configured(name, extra = {}) {
    const cid = communityKey(name);
    api.updateGuildSettings(cid, {
      rss_notification_channel_id: `chan-${name}`,
      rss_polling_interval_minutes: 15,
      ...extra,
    });
    return cid;
  }

  const BLOG_XML = rss2([
    rssItem({
      guid: "post-1",
      title: "Latest Post",
      link: "https://example.com/latest",
      pubMs: T0,
    }),
  ]);

  // ---------------------------------------------------------------------------
  // Feature-module export contract (consumed by subtask 08's rss/index.js)
  // ---------------------------------------------------------------------------

  it("exports the load.js contract with ManageGuild defaults on both families", () => {
    const byName = Object.fromEntries(
      commands.commands.map((b) => [b.toJSON().name, b.toJSON()]),
    );
    assert.deepEqual(Object.keys(byName).sort(), ["rss", "setrss"]);
    // toJSON() surfaces .addSubcommand entries as top-level options
    // (ApplicationCommandOptionType.SUB_COMMAND = 1 — command-option-order
    // .test.js walk shape).
    const subNames = (json) =>
      (json.options ?? []).filter((o) => o.type === 1).map((o) => o.name);
    assert.deepEqual(subNames(byName.rss), [
      "add",
      "remove",
      "list",
      "test",
      "check",
    ]);
    assert.deepEqual(subNames(byName.setrss), [
      "channel",
      "role",
      "interval",
      "settings",
    ]);
    const staffMask = String(MANAGE_GUILD);
    assert.equal(byName.rss.default_member_permissions, staffMask);
    assert.equal(byName.setrss.default_member_permissions, staffMask);

    assert.deepEqual(commands.handlerApi, { rss: "context", setrss: "context" });
    assert.equal(typeof commands.handlers.rss, "function");
    assert.equal(typeof commands.handlers.setrss, "function");
    assert.equal(typeof commands.autocomplete.rss, "function");

    // feed: options carry autocomplete on every surface that names a feed.
    const subOf = (name) =>
      (byName.rss.options ?? []).find((o) => o.type === 1 && o.name === name);
    const feedOptOf = (name) =>
      (subOf(name).options ?? []).find((o) => o.name === "feed");
    assert.equal(feedOptOf("remove").autocomplete, true);
    assert.equal(feedOptOf("remove").required, true);
    assert.equal(feedOptOf("test").autocomplete, true);
    assert.equal(feedOptOf("test").required, false);
    assert.equal(feedOptOf("check").autocomplete, true);
    assert.equal(feedOptOf("check").required, false);

    // Tiers ship in the SAME change as the command families (#305).
    const { TIERS, visibilityTier } = require("../src/core/commandVisibility");
    assert.equal(visibilityTier("rss"), TIERS.staff);
    assert.equal(visibilityTier("setrss"), TIERS.staff);
  });

  it("rejects non-staff invokers before doing anything (requireStaffFromContext)", async () => {
    const cid = configured("rss-gate");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://feeds.example.com/blog.xml" },
      channelPermissions: 0n,
    });
    await runRss(ctx, diBox({ fetchImpl: fetchStub(httpOk(BLOG_XML)) }));
    const { MSG_DENIED } = require("../src/core/theme");
    assert.deepEqual(replies.map((r) => r.content), [MSG_DENIED]);
    assert.equal(api.countRssFeedsForCommunity(cid), 0, "nothing was stored");
  });

  // ---------------------------------------------------------------------------
  // /rss add — refusal table (every reply carries the CAUSE) + happy path
  // ---------------------------------------------------------------------------

  it("add refuses when the notify channel is unset — actionable /setrss error", async () => {
    const cid = communityKey("rss-add-nochan"); // channel intentionally unset
    const fetch = fetchStub(httpOk(BLOG_XML));
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://feeds.example.com/blog.xml" },
    });
    await runRss(ctx, diBox({ fetchImpl: fetch }));
    assert.match(replies[0].content, /Could not add feed:/);
    assert.match(replies[0].content, /\/setrss channel/, "names the fix");
    assert.equal(fetch.calls.length, 0, "the config gate runs BEFORE the network");
    assert.equal(api.countRssFeedsForCommunity(cid), 0);
  });

  it("add surfaces the scheme refusal verbatim", async () => {
    const cid = configured("rss-add-scheme");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "ftp://example.com/feed" },
    });
    await runRss(ctx, diBox({ fetchImpl: fetchStub(httpOk(BLOG_XML)) }));
    assert.match(replies[0].content, /Could not add feed:/);
    assert.match(replies[0].content, /non-http\(s\) url \(ftp:\)/, "validator's reason");
    assert.equal(api.countRssFeedsForCommunity(cid), 0);
  });

  it("add surfaces the add-time SSRF refusal (loopback resolution)", async () => {
    const cid = configured("rss-add-ssrf");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://internal.example.com/feed.xml" },
    });
    await runRss(ctx, diBox({ fetchImpl: fetchStub(httpOk(BLOG_XML)), resolveHost: resolveHostPrivate }));
    assert.match(replies[0].content, /Could not add feed:/);
    assert.match(replies[0].content, /refused address range for 127\.0\.0\.1/, "guard's reason");
    assert.equal(api.countRssFeedsForCommunity(cid), 0);
  });

  it("add surfaces the parse cause for an unparseable body", async () => {
    const cid = configured("rss-add-parse");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://feeds.example.com/broken.xml" },
    });
    await runRss(
      ctx,
      diBox({ fetchImpl: fetchStub(httpOk("<rss><channel>")) }), // mismatched tags
    );
    assert.match(replies[0].content, /Could not add feed: could not parse the feed:/);
    assert.equal(api.countRssFeedsForCommunity(cid), 0);
  });

  it("add refuses an empty feed by name", async () => {
    const cid = configured("rss-add-empty");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://feeds.example.com/empty.xml" },
    });
    await runRss(ctx, diBox({ fetchImpl: fetchStub(httpOk(rss2([]))) }));
    assert.match(replies[0].content, /Could not add feed:/);
    assert.match(replies[0].content, /no items/, "empty-feed cause");
    assert.equal(api.countRssFeedsForCommunity(cid), 0);
  });

  it("add happy path stores resolved feed_title/feed_link + addedBy and names the channel", async () => {
    const cid = configured("rss-add-happy");
    const fetch = fetchStub(httpOk(BLOG_XML));
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://feeds.example.com/blog.xml" },
    });
    await runRss(ctx, diBox({ fetchImpl: fetch }));

    const row = api.getRssFeed(cid, "https://feeds.example.com/blog.xml");
    assert.ok(row, "row stored");
    assert.equal(row.feed_title, "Example News", "resolved from the parsed feed");
    assert.equal(row.feed_link, "https://example.com", "resolved from the parsed feed");
    assert.equal(row.display_name, null, "no name: given");
    assert.equal(row.added_by, "u-rss-cmd", "addedBy = the invoking user");

    assert.match(replies[0].content, /Subscribed to \*\*Example News\*\*\./);
    assert.match(replies[0].content, /\*\*Feed:\*\* <https:\/\/feeds\.example\.com\/blog\.xml>/);
    assert.match(replies[0].content, new RegExp(`\\*\\*Notify channel:\\*\\* <#chan-rss-add-happy>`));
  });

  it("add stores an explicit name: label as display_name", async () => {
    const cid = configured("rss-add-name");
    const { ctx } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://feeds.example.com/blog.xml", name: "Kittens Weekly" },
    });
    await runRss(ctx, diBox({ fetchImpl: fetchStub(httpOk(BLOG_XML)) }));
    const row = api.getRssFeed(cid, "https://feeds.example.com/blog.xml");
    assert.equal(row.display_name, "Kittens Weekly");
  });

  it("add refuses a duplicate subscription (repository null = refusal, not reset)", async () => {
    const cid = configured("rss-add-dup");
    const first = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://feeds.example.com/blog.xml" },
    });
    await runRss(first.ctx, diBox({ fetchImpl: fetchStub(httpOk(BLOG_XML)) }));
    const second = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://feeds.example.com/blog.xml" },
    });
    await runRss(second.ctx, diBox({ fetchImpl: fetchStub(httpOk(BLOG_XML)) }));
    assert.match(second.replies[0].content, /Could not add feed:/);
    assert.match(second.replies[0].content, /already subscribed/);
    assert.equal(api.countRssFeedsForCommunity(cid), 1, "the first row is untouched");
  });

  it("add enforces RSS_MAX_FEEDS_PER_COMMUNITY — the refusal NAMES the cap", async () => {
    const cid = configured("rss-add-cap");
    const fetch = fetchStub(httpOk(BLOG_XML));
    const env = { RSS_MAX_FEEDS_PER_COMMUNITY: "1" };

    const first = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://a.example.com/feed.xml" },
    });
    await runRss(first.ctx, diBox({ fetchImpl: fetch, env }));
    assert.match(first.replies[0].content, /Subscribed to/);

    const second = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "add",
      options: { url: "https://b.example.com/feed.xml" },
    });
    await runRss(second.ctx, diBox({ fetchImpl: fetch, env }));
    assert.match(second.replies[0].content, /Could not add feed:/);
    assert.match(second.replies[0].content, /cap is 1/);
    assert.match(second.replies[0].content, /RSS_MAX_FEEDS_PER_COMMUNITY/);
    assert.equal(fetch.calls.length, 1, "the cap gate runs BEFORE the second fetch");
    assert.equal(api.countRssFeedsForCommunity(cid), 1);
  });

  // ---------------------------------------------------------------------------
  // /rss remove
  // ---------------------------------------------------------------------------

  it("remove names an unknown feed with a specific cause and no write", async () => {
    const cid = configured("rss-remove-unknown");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "remove",
      options: { feed: "https://nope.example.com/feed.xml" },
    });
    await runRss(ctx, diBox());
    assert.match(replies[0].content, /Could not remove feed:/);
    assert.match(replies[0].content, /no subscription found/);
  });

  it("remove deletes the row (and the seen-set) and names the label", async () => {
    const cid = configured("rss-remove-ok");
    const url = "https://feeds.example.com/blog.xml";
    api.addRssFeed(cid, url, { feedTitle: "Example News" });
    api.addRssSeenEntry(cid, url, "stale-key-1", T0);

    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "remove",
      options: { feed: url },
    });
    await runRss(ctx, diBox());
    assert.match(replies[0].content, /Unsubscribed from \*\*Example News\*\*\./);
    assert.equal(api.getRssFeed(cid, url), null, "row deleted");
    assert.deepEqual(api.listRssSeenKeysForFeed(cid, url), [], "seen-set cleaned with it");
  });

  // ---------------------------------------------------------------------------
  // /rss list + /setrss settings — **Label:** value readback
  // ---------------------------------------------------------------------------

  it("list renders channel / role / interval / count with the **Label:** convention", async () => {
    const cid = configured("rss-list", { rss_notify_role_id: "role-list-1" });
    api.updateGuildSettings(cid, { rss_polling_interval_minutes: 9 });
    api.addRssFeed(cid, "https://blog.example.org/rss", {
      displayName: "Kittens Weekly",
      feedTitle: "Kittens Weekly Blog",
    });

    const { ctx, replies } = makeCtx({ communityId: cid, commandName: "rss", sub: "list" });
    await runRss(ctx, diBox());
    const out = replies[0].content;
    assert.match(out, /\*\*Notify channel:\*\* <#chan-rss-list>/);
    assert.match(out, /\*\*Notify role:\*\* <@&role-list-1>/);
    assert.match(out, /\*\*Poll interval:\*\* 9 minute\(s\)/);
    assert.match(out, /\*\*Feeds:\*\* 1\/20/);
    assert.match(out, /\*\*Kittens Weekly\*\*/, "display name is the bullet label");
  });

  it("list on an unconfigured community shows the actionable _Not configured_ twin", async () => {
    const cid = communityKey("rss-list-bare");
    const { ctx, replies } = makeCtx({ communityId: cid, commandName: "rss", sub: "list" });
    await runRss(ctx, diBox());
    const out = replies[0].content;
    assert.match(out, /\*\*Notify channel:\*\* _Not configured_ — set one with `\/setrss channel`/);
    assert.match(out, /\*\*Feeds:\*\* 0\/20/);
    assert.match(out, /No feeds subscribed/);
  });

  // ---------------------------------------------------------------------------
  // /setrss — channel stores, role omit clears, interval re-check
  // ---------------------------------------------------------------------------

  it("setrss channel stores the id and confirms the target", async () => {
    const cid = communityKey("rss-set-chan");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "setrss",
      sub: "channel",
      options: { channel: { id: "chan-set-1", name: "feeds" } },
    });
    await runSetRss(ctx, diBox());
    assert.equal(api.getGuildSettings(cid).rss_notification_channel_id, "chan-set-1");
    assert.match(replies[0].content, /RSS notifications will be sent to <#chan-set-1>\./);
  });

  it("setrss interval OUT of range → specific correction, NOTHING written", async () => {
    const cid = configured("rss-set-interval");
    for (const bad of [0, 61, -5]) {
      const { ctx, replies } = makeCtx({
        communityId: cid,
        commandName: "setrss",
        sub: "interval",
        options: { minutes: bad },
      });
      await runSetRss(ctx, diBox());
      assert.match(
        replies[0].content,
        /Polling interval must be between 1 and 60 minutes\./,
        `minutes=${bad}`,
      );
      assert.equal(
        api.getGuildSettings(cid).rss_polling_interval_minutes,
        15,
        `minutes=${bad} left the stored value alone (NOT NULL column never sees junk)`,
      );
    }
  });

  it("setrss interval in range stores and confirms with bold value (youtube twin)", async () => {
    const cid = configured("rss-set-interval-ok");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "setrss",
      sub: "interval",
      options: { minutes: 7 },
    });
    await runSetRss(ctx, diBox());
    assert.equal(api.getGuildSettings(cid).rss_polling_interval_minutes, 7);
    assert.match(replies[0].content, /RSS polling interval set to \*\*7\*\* minute\(s\)\./);
  });

  it("setrss role sets, and OMITTING the role clears the mention", async () => {
    const cid = configured("rss-set-role");
    const set = makeCtx({
      communityId: cid,
      commandName: "setrss",
      sub: "role",
      options: { role: { id: "role-rss-1", name: "pingers" } },
    });
    await runSetRss(set.ctx, diBox());
    assert.equal(api.getGuildSettings(cid).rss_notify_role_id, "role-rss-1");
    assert.match(set.replies[0].content, /will mention <@&role-rss-1>/);

    const clear = makeCtx({ communityId: cid, commandName: "setrss", sub: "role" });
    await runSetRss(clear.ctx, diBox());
    assert.equal(api.getGuildSettings(cid).rss_notify_role_id, null, "omit clears");
    assert.match(clear.replies[0].content, /no longer mention a role/);
  });

  it("setrss settings reads back channel, role, interval, and subscription count", async () => {
    const cid = configured("rss-settings", { rss_notify_role_id: "role-settings-1" });
    api.updateGuildSettings(cid, { rss_polling_interval_minutes: 11 });
    api.addRssFeed(cid, "https://blog.example.org/rss", { feedTitle: "Bloggy" });

    const { ctx, replies } = makeCtx({ communityId: cid, commandName: "setrss", sub: "settings" });
    await runSetRss(ctx, diBox());
    const out = replies[0].content;
    assert.match(out, /\*\*RSS settings\*\*/);
    assert.match(out, /\*\*Notify channel:\*\* <#chan-rss-settings>/);
    assert.match(out, /\*\*Notify role:\*\* <@&role-settings-1>/);
    assert.match(out, /\*\*Poll interval:\*\* 11 minute\(s\)/);
    assert.match(out, /\*\*Feeds:\*\* 1\/20/);
  });

  // ---------------------------------------------------------------------------
  // /rss test — posts the LATEST entry via buildNotification + outbound,
  // writing NOTHING poll-state (the documented poller-reuse divergence)
  // ---------------------------------------------------------------------------

  it("test without a notify channel is an actionable error with zero sends", async () => {
    const cid = communityKey("rss-test-nochan");
    api.addRssFeed(cid, "https://feeds.example.com/blog.xml", { feedTitle: "Example News" });
    const outbound = makeOutbound();
    const fetch = fetchStub(httpOk(BLOG_XML));
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "test",
      options: { feed: "https://feeds.example.com/blog.xml" },
      outbound,
    });
    await runRss(ctx, diBox({ fetchImpl: fetch }));
    assert.match(replies[0].content, /Test notification failed:/);
    assert.match(replies[0].content, /\/setrss channel/);
    assert.equal(outbound.sent.length, 0);
    assert.equal(fetch.calls.length, 0, "the config gate runs BEFORE the fetch");
  });

  it("test on a feed that is no longer subscribed says so", async () => {
    const cid = configured("rss-test-gone");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "test",
      options: { feed: "https://ghost.example/feed.xml" },
      outbound: makeOutbound(),
    });
    await runRss(ctx, diBox({ fetchImpl: fetchStub(httpOk(BLOG_XML)) }));
    assert.match(replies[0].content, /no longer subscribed/);
  });

  it("test with zero subscriptions points at /rss add", async () => {
    const cid = configured("rss-test-none");
    const { ctx, replies } = makeCtx({ communityId: cid, commandName: "rss", sub: "test", outbound: makeOutbound() });
    await runRss(ctx, diBox({ fetchImpl: fetchStub(httpOk(BLOG_XML)) }));
    assert.match(replies[0].content, /No RSS feeds subscribed/);
  });

  it("test posts the latest entry to the notify channel and writes NO poll state", async () => {
    const cid = configured("rss-test-post", { rss_notify_role_id: "435678901234567890" });
    const url = "https://feeds.example.com/blog.xml";
    api.addRssFeed(cid, url, { feedTitle: "Example News" });

    const fetch = fetchStub(
      httpOk(
        rss2([
          rssItem({ guid: "old", title: "Old Post", link: "https://example.com/old", pubMs: T0 - 2 * MIN }),
          rssItem({ guid: "new", title: "Brand New Post", link: "https://example.com/new", pubMs: T0 }),
        ]),
      ),
    );
    const outbound = makeOutbound();
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "test",
      options: { feed: url },
      outbound,
    });
    await runRss(ctx, diBox({ fetchImpl: fetch, now: T0 }));

    assert.equal(outbound.sent.length, 1, "exactly one test post");
    const { channelId, payload } = outbound.sent[0];
    assert.equal(channelId, "chan-rss-test-post");
    assert.match(
      payload.content,
      /^<@&435678901234567890> \*\*Example News\*\* .* new post/,
      "role prefix + bold feed label (format.js shape)",
    );
    assert.deepEqual(payload.allowedMentions, { roles: ["435678901234567890"] }, "strict #272 form");
    assert.equal(payload.embeds[0].title, "Brand New Post", "the LATEST entry was posted");

    // The no-side-effect contract (why /rss test does NOT reuse pollFeedRow):
    assert.deepEqual(api.listRssSeenKeysForFeed(cid, url), [], "seen-set untouched");
    const row = api.getRssFeed(cid, url);
    assert.equal(row.last_checked, null, "watermark untouched");
    assert.equal(row.failure_count, 0, "failure counter untouched");

    assert.match(replies[0].content, /Posted a test notification to <#chan-rss-test-post>/);
    assert.match(replies[0].content, /\*\*Feed:\*\* </);
    assert.match(replies[0].content, /\*\*Entry:\*\* Brand New Post/);
  });

  it("test with feed: omitted posts the most recent subscription", async () => {
    const cid = configured("rss-test-latest");
    api.addRssFeed(cid, "https://first.example/feed.xml", { feedTitle: "First Feeds" });
    api.addRssFeed(cid, "https://second.example/feed.xml", { feedTitle: "Second Feeds" });
    const outbound = makeOutbound();
    const fetch = fetchStub(httpOk(rss2([rssItem({ guid: "g", title: "T", link: "https://x.example/1", pubMs: T0 })])));
    const { ctx, replies } = makeCtx({ communityId: cid, commandName: "rss", sub: "test", outbound });
    await runRss(ctx, diBox({ fetchImpl: fetch, now: T0 }));
    assert.equal(outbound.sent.length, 1);
    assert.match(
      replies[0].content,
      /\*\*Feed:\*\* <https:\/\/second\.example\/feed\.xml> \*\(most recent subscription\)\*/,
    );
  });

  // ---------------------------------------------------------------------------
  // /rss check — the poller path with force (state writes DO happen)
  // ---------------------------------------------------------------------------

  it("check force-polls despite the interval gate and reports the aggregate", async () => {
    const cid = configured("rss-check-force");
    api.updateGuildSettings(cid, { rss_polling_interval_minutes: 60 });
    const url = "https://feeds.example.com/blog.xml";
    api.addRssFeed(cid, url, { feedTitle: "Check Feeds" });
    // Checked one minute ago at T0-MIN with a 60-minute interval: the clock
    // gate (isRssPollDue) would REFUSE this row without force:true.
    api.updateRssFeedWatermark(cid, url, { lastChecked: T0 - MIN });

    const fetch = fetchStub(
      httpOk(rss2([rssItem({ guid: "fresh", title: "Fresh Entry", link: "https://example.com/fresh", pubMs: T0 })])),
    );
    const outbound = makeOutbound();
    const { ctx, replies } = makeCtx({ communityId: cid, commandName: "rss", sub: "check", outbound });
    await runRss(ctx, diBox({ fetchImpl: fetch, now: T0 }));

    const out = replies[0].content;
    assert.match(out, /\*\*Forced poll\*\* — 1 feed\(s\)/);
    assert.match(out, /\*\*Posted:\*\* 1/, "force:true bypassed the not-due gate");
    assert.equal(outbound.sent.length, 1);
    assert.equal(outbound.sent[0].channelId, "chan-rss-check-force");

    // The check path DOES write poll state (contrast with /rss test):
    const row = api.getRssFeed(cid, url);
    assert.equal(row.last_checked, T0, "watermark advanced to the injected now");
    assert.equal(row.failure_count, 0, "success reset the backoff counter");
    assert.equal(api.listRssSeenKeysForFeed(cid, url).length, 1, "the announced key was claimed");
  });

  it("check without a notify channel refuses before any fetch", async () => {
    const cid = communityKey("rss-check-nochan");
    api.addRssFeed(cid, "https://feeds.example.com/blog.xml", {});
    const fetch = fetchStub(httpOk(BLOG_XML));
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "check",
      outbound: makeOutbound(),
    });
    await runRss(ctx, diBox({ fetchImpl: fetch, now: T0 }));
    assert.match(replies[0].content, /Could not poll:/);
    assert.match(replies[0].content, /\/setrss channel/);
    assert.equal(fetch.calls.length, 0);
  });

  it("check reports per-feed failures WITH causes and still credits the sweep (rule 5)", async () => {
    const cid = configured("rss-check-fail");
    api.addRssFeed(cid, "https://a.example.com/feed.xml", { feedTitle: "A Feeds" });
    api.addRssFeed(cid, "https://b.example.com/feed.xml", { feedTitle: "B Feeds" });
    const fetch = fetchStub(HttpStatus(500));
    const { ctx, replies } = makeCtx({ communityId: cid, commandName: "rss", sub: "check", outbound: makeOutbound() });
    await runRss(ctx, diBox({ fetchImpl: fetch, now: T0 }));

    const out = replies[0].content;
    assert.match(out, /\*\*Forced poll\*\* — 2 feed\(s\)/);
    assert.match(out, /\*\*Polled:\*\* 0/);
    assert.match(out, /\*\*Failures:\*\*/);
    assert.match(out, /\*\*A Feeds:\*\* .*HTTP 500/);
    assert.match(out, /\*\*B Feeds:\*\* .*HTTP 500/);
    assert.equal(fetch.calls.length, 2, "the second row was polled despite the first failing");
    assert.equal(api.getRssFeed(cid, "https://a.example.com/feed.xml").failure_count, 1);
    assert.equal(api.getRssFeed(cid, "https://b.example.com/feed.xml").failure_count, 1);
  });

  it("check on a feed that is no longer subscribed says so", async () => {
    const cid = configured("rss-check-gone");
    const { ctx, replies } = makeCtx({
      communityId: cid,
      commandName: "rss",
      sub: "check",
      options: { feed: "https://ghost.example/feed.xml" },
      outbound: makeOutbound(),
    });
    await runRss(ctx, diBox({ fetchImpl: fetchStub(httpOk(BLOG_XML)), now: T0 }));
    assert.match(replies[0].content, /Could not poll feed:/);
    assert.match(replies[0].content, /no longer subscribed/);
  });

  // ---------------------------------------------------------------------------
  // feed: autocomplete (community-scoped; value = stored url)
  // ---------------------------------------------------------------------------

  function makeAutocomplete(guildId, focused) {
    const responses = [];
    const interaction = {
      guild: guildId == null ? null : { id: String(guildId) },
      options: { getFocused: () => focused },
      respond: async (choices) => {
        responses.push(choices);
      },
    };
    return { interaction, responses };
  }

  it("autocomplete names display_name → feed_title → truncated url, values are urls", async () => {
    const guildId = "960001";
    const cid = communityKey(guildId);
    const longUrl = `https://long.example.com/${"a".repeat(120)}`;
    api.addRssFeed(cid, "https://d.example/feed.xml", {
      displayName: "Display Weekly",
      feedTitle: "Ignored Title",
    });
    api.addRssFeed(cid, "https://t.example/feed.xml", { feedTitle: "Title Only Blog" });
    api.addRssFeed(cid, longUrl, {});

    const { interaction, responses } = makeAutocomplete(guildId, "");
    await commands.autocomplete.rss(interaction);
    const choices = responses[0];
    assert.equal(choices.length, 3);
    const byUrl = Object.fromEntries(choices.map((c) => [c.value, c.name]));
    assert.equal(byUrl["https://d.example/feed.xml"], "Display Weekly", "display_name wins");
    assert.equal(byUrl["https://t.example/feed.xml"], "Title Only Blog", "then feed_title");
    const truncated = byUrl[longUrl];
    assert.ok(truncated.length <= 100, "truncated into Discord's 100-char name cap");
    assert.ok(truncated.endsWith("…"), "ellipsis marks the truncation");
    assert.ok(longUrl.startsWith(truncated.slice(0, -1)), "it IS the url, shortened");

    // Focused filtering matches the name OR the url.
    const focused = makeAutocomplete(guildId, "title only");
    await commands.autocomplete.rss(focused.interaction);
    assert.deepEqual(focused.responses[0].map((c) => c.value), ["https://t.example/feed.xml"]);
  });

  it("autocomplete answers empty for DMs and unregistered guilds", async () => {
    const dm = makeAutocomplete(null, "");
    await commands.autocomplete.rss(dm.interaction);
    assert.deepEqual(dm.responses[0], []);

    const stranger = makeAutocomplete("960002-never-registered", "");
    await commands.autocomplete.rss(stranger.interaction);
    assert.deepEqual(stranger.responses[0], []);
  });

  // ---------------------------------------------------------------------------
  // subscriptions.maxFeedsPerCommunity — the env knob table
  // ---------------------------------------------------------------------------

  it("maxFeedsPerCommunity defaults to 20 and only honors sane overrides", () => {
    assert.equal(subscriptions.maxFeedsPerCommunity({}), 20);
    assert.equal(subscriptions.maxFeedsPerCommunity({ RSS_MAX_FEEDS_PER_COMMUNITY: "5" }), 5);
    assert.equal(subscriptions.maxFeedsPerCommunity({ RSS_MAX_FEEDS_PER_COMMUNITY: " 8 " }), 8);
    assert.equal(subscriptions.maxFeedsPerCommunity({ RSS_MAX_FEEDS_PER_COMMUNITY: "3.7" }), 3);
    assert.equal(subscriptions.maxFeedsPerCommunity({ RSS_MAX_FEEDS_PER_COMMUNITY: "0" }), 20);
    assert.equal(subscriptions.maxFeedsPerCommunity({ RSS_MAX_FEEDS_PER_COMMUNITY: "-4" }), 20);
    assert.equal(subscriptions.maxFeedsPerCommunity({ RSS_MAX_FEEDS_PER_COMMUNITY: "abc" }), 20);
    assert.equal(subscriptions.maxFeedsPerCommunity(), 20, "process.env default path stays 20 in tests");
  });
});
