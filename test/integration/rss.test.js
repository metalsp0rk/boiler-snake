const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const {
  exactlyOneSend,
  assertPingsRoleOnly,
  assertPingsNobody,
} = require("../helpers/sendShape");
const { IDS } = require("../helpers/fixtures");
const { createGuild, createTextChannel } = require("../helpers/discord");

/**
 * Integration test for RSS feed notifications (issue #305, subtask 09) —
 * the FULL-STACK twin of test/rss-poller.test.js: real migrated SQLite via
 * createIntegrationEnv() (freshEnv idiom: loadDb-bound temp DB_PATH, env
 * handled by the harness), stubbed fetch returning canned RSS XML through
 * the REAL rss-parser, mocked outbound via the supervisor/outbound seams —
 * NO network, NO real timers, every clock injected (T0 fixed epoch, same
 * convention as test/rss-poller.test.js / test/rss-commands.test.js).
 *
 * Command arms drive the real router through env.runCommand (the youtube
 * integration shape); the poller seam is pollAllFeeds({ db, supervisor,
 * fetchImpl, resolveHost, now }) exactly as registered in src/features
 * (src/features/index.js → rss → ticker → poller). Commands honor the
 * featureCtx.rss DI box ({ env, now, fetchImpl, resolveHost }) — attached
 * to the LIVE harness ctx object (env.ctx) the router hands every handler,
 * deleted again in a finally. The db seam is deliberately NOT injected:
 * commands bind to the harness-rebound facade, i.e. the real temp DB.
 *
 * Scenario map (issue #305 verification list):
 *   S1  /rss add happy path          — row stores resolved feed_title/feed_link,
 *                                      reply confirms, audit path survives
 *   S2  add → tick posts once        — exactly ONE send, strict { parse: [] },
 *                                      linked embed title + snippet
 *   S3  second tick silent           — seen-set dedup, last_checked advances
 *   S4  role + mention defense       — /setrss role → content prefix +
 *                                      strict { roles: [id] }; smuggled
 *                                      @everyone / <@&123> neutralized
 *   S5  /rss check vs /rss test      — check bypasses the interval gate and
 *                                      WRITES state; test posts WITHOUT any
 *                                      state writes (row + seen unchanged)
 *   S6  two communities, one URL     — per-community seen scoping; one
 *                                      unready clientForCommunity logs and
 *                                      skips, the others still post
 *   S7  misconfigured + failing rows — refused-config skipped without killing
 *                                      the sweep; a fetch failure bumps
 *                                      failure_count (backoff state observable)
 *   S8  conditional GET              — 304 advances last_checked ONLY, zero
 *                                      outbound, validators survive
 *   S9  non-staff denied             — /rss + /setrss refused, zero db writes
 *
 * Test order is a deliberate story arc: S1's subscription feeds S2's first
 * tick, which feeds S3's dedup silence, etc. Rows no longer needed are
 * RETIRED (removeRssFeed also clears the feed's seen rows) so every later
 * pollAllFeeds sweep sees exactly the rows its own test created — the same
 * "leave the shared env clean" discipline as test/integration/youtube.test.js.
 */

/** Fixed epoch (2024-10-27T06:13:20Z), second-aligned so RFC-822 pubDates
 * round-trip exactly through rss-parser (poller-test convention). */
const T0 = 1_730_000_000_000;
const MIN = 60_000;

const EMDASH = String.fromCharCode(8212);
/** format.js ZWSP twin (test/rss.test.js convention): invisible-byte
 * assertions never depend on editor round-tripping. */
const ZWSP = String.fromCharCode(0x200b);

/** The one role used across S4 — a bare snowflake, the only shape
 * format.resolveNotifyRoleId accepts. */
const ROLE_ID = "666000000000000001";

// Feed URLs are keys into the routing fetch stub; every test uses urls the
// resolver has an entry for, and unknown urls answer HTTP 599 LOUDLY (a
// gated row that leaked past its gate shows up as a 599 failure instead of
// silently poisoning the canned data).
const URL_MAIN = "https://feeds.example.com/blog.xml";
const URL_SMUGGLE = "https://feeds.example.com/smuggle.xml";
const URL_CHECK = "https://feeds.example.com/check.xml";
const URL_SHARED = "https://feeds.example.com/shared.xml";
const URL_FLAKEY = "https://feeds.example.com/flakey.xml";
const URL_CHANLESS = "https://feeds.example.com/chanless.xml";
const URL_COND = "https://feeds.example.com/cond.xml";

describe("integration: rss notifications", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  let pollAllFeeds;

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  before(async () => {
    env = await createIntegrationEnv();
    // Required AFTER env creation (loadDb cache reset) so the poller's lazy
    // facade default and every repository bind to the temp DB.
    ({ pollAllFeeds } = require("../../src/features/rss/poller"));
  });

  // ---------------------------------------------------------------------------
  // Fixtures and seams (same vocabulary as test/rss-poller.test.js)
  // ---------------------------------------------------------------------------

  /** Public-IP DNS fake — the SSRF class-check passes (03 owns its contract). */
  const resolveHostOk = async () => ["93.184.216.34"];

  function httpOk(body, headers = {}) {
    return {
      status: 200,
      headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
      arrayBuffer: async () => Buffer.from(String(body), "utf8"),
    };
  }

  function HttpStatus(status) {
    return { status, headers: { get: () => null } };
  }

  /** URL-routed stubbed fetch: responses are canned per feed url; sources may
   * be a constant response or a (url, init) => response function (conditional
   * GET). Unknown urls answer 599 — a fetch that should NOT have happened
   * fails LOUD (recorded as a fetch failure + a named log line, never as a
   * silent success with the wrong body). */
  function routingFetch(sources) {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url, init });
      const source = sources[url];
      if (source === undefined) return HttpStatus(599);
      return typeof source === "function" ? source(url, init) : source;
    };
    fn.calls = calls;
    fn.callsFor = (url) => calls.filter((c) => c.url === url);
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

  function rssItem({ guid, title, link, pubMs, desc }) {
    return (
      "<item>" +
      (guid ? `<guid>${guid}</guid>` : "") +
      (title ? `<title>${title}</title>` : "") +
      (link ? `<link>${link}</link>` : "") +
      (pubMs != null ? `<pubDate>${new Date(pubMs).toUTCString()}</pubDate>` : "") +
      (desc ? `<description>${desc}</description>` : "") +
      "</item>"
    );
  }

  /** Fake OutboundClient (poller-test shape) for supervisor-less communities:
   * records { channelId, payload } and reports success. */
  function makeOutbound() {
    const sent = [];
    return {
      sent,
      async sendChannel(channelId, payload) {
        sent.push({ channelId, payload });
        return { ok: true, id: `rec-${sent.length}` };
      },
    };
  }

  /** PR 7 fake supervisor keyed by community: communities in the map get
   * their recording outbound, EVERYONE ELSE resolves null — the unready /
   * not-ready client arm the ticker must log and skip (youtube
   * resolveOutbound posture). Mirrors the youtube integration's
   * fakeSupervisor doc block. */
  function fakeSupervisor(byCommunity = new Map()) {
    return {
      discord: env.client,
      fluxer: new Map(),
      clientForCommunity: (communityId) => byCommunity.get(communityId) ?? null,
    };
  }

  /** Register (or look up) a discord community row for an external guild id
   * (lazy require — same pattern as youtube.test.js #377). */
  function communityFor(externalGuildId) {
    const { ensureCommunity } = require("../../src/platform/community");
    return ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: String(externalGuildId),
    });
  }

  /** featureCtx.rss DI box for the command arms — attached to the LIVE ctx
   * object the router hands every handler, removed again afterwards. db is
   * deliberately absent: commands run on the harness-rebound facade
   * (real temp SQLite). */
  async function withRssDeps(di, fn) {
    env.ctx.rss = di;
    try {
      return await fn();
    } finally {
      delete env.ctx.rss;
    }
  }

  /** Full-row + seen retirement so a later sweep never sees this feed.
   * removeRssFeed deletes the seen rows too (repository contract). */
  function retire(communityId, url) {
    env.db.removeRssFeed(communityId, url);
  }

  const settingsOf = (communityId) => env.db.getGuildSettings(communityId);
  const rowOf = (communityId, url) => env.db.getRssFeed(communityId, url);

  // ===========================================================================
  // S1 — /rss add happy path over the real router-facing surface
  // ===========================================================================

  it("S1: /setrss channel + /rss add store the subscription with resolved title/link", async () => {
    // /setrss channel — the standing config gate /rss add demands an answer to.
    const setChannel = await env.runCommand({
      commandName: "setrss",
      subcommand: "channel",
      admin: true,
      options: { channel: env.channels.notify },
    });
    assertReplyContains(setChannel, /RSS notifications will be sent to/i);
    assert.equal(
      settingsOf(env.communityId).rss_notification_channel_id,
      IDS.channelNotify,
    );

    const fetchImpl = routingFetch({
      [URL_MAIN]: httpOk(
        rss2([
          rssItem({
            guid: "introducing-rss",
            title: "Introducing RSS",
            link: "https://example.com/introducing-rss",
            pubMs: T0 - 10 * MIN,
            desc: "The bot now reads feeds.",
          }),
        ]),
      ),
    });

    const add = await withRssDeps(
      { fetchImpl, resolveHost: resolveHostOk, env: {} },
      () =>
        env.runCommand({
          commandName: "rss",
          subcommand: "add",
          admin: true,
          options: { url: URL_MAIN },
        }),
    );

    // Success arm — NOT the router's last-resort generic and not the refusal
    // arm: the whole add path (validate → guarded fetch → parse → insert →
    // recordSlashAudit → logConfigChange over the mock outbound) survived.
    const text = env.lastReplyContent(add);
    assert.match(text, /Subscribed to \*\*Example News\*\*/);
    assert.match(text, /\*\*Feed title:\*\* Example News/);
    assert.doesNotMatch(text, /Could not add feed|Unhandled command|Internal error/i);

    const row = rowOf(env.communityId, URL_MAIN);
    assert.ok(row, "subscription row stored on the real migrated SQLite");
    assert.equal(row.community_id, env.communityId);
    assert.equal(row.url, URL_MAIN, "the validator-canonical URL is stored verbatim");
    assert.equal(row.feed_title, "Example News", "feed title resolved at add time");
    assert.equal(row.feed_link, "https://example.com", "feed link resolved at add time");
    assert.equal(row.added_by, env.users.adminUser.id);
    assert.equal(env.db.countRssFeedsForCommunity(env.communityId), 1);
    // Poll state is the FIRST TICK's business, not add's:
    assert.equal(row.last_checked, null, "add seeds no poll state");
    assert.equal(row.failure_count, 0);
  });

  // ===========================================================================
  // S2 — add → tick posts exactly once (first-poll window, silent no-role)
  // ===========================================================================

  it("S2: the first pollAllFeeds tick posts the qualifying entry once to the configured channel", async () => {
    env.channels.notify.sent.length = 0;
    const fetchImpl = routingFetch({
      [URL_MAIN]: httpOk(
        rss2([
          rssItem({
            guid: "introducing-rss",
            title: "Introducing RSS",
            link: "https://example.com/introducing-rss",
            pubMs: T0 - 10 * MIN, // inside the injected first-hour window
            desc: "The bot now reads feeds.",
          }),
        ]),
      ),
    });

    const agg = await pollAllFeeds({
      db: env.db,
      supervisor: env.supervisor, // harness supervisor → Discord OutboundClient
      fetchImpl,
      resolveHost: resolveHostOk,
      now: T0,
    });

    assert.deepEqual(
      { ...agg },
      {
        feeds: 1,
        polled: 1,
        posted: 1,
        skipped: 0,
        failures: 0,
        notModified: 0,
        notDue: 0,
        refusedConfig: 0,
        noClient: 0,
      },
      "one feed, polled once, posted once, nothing skipped or failed",
    );

    // Outbound assertion on the PRODUCTION send path (supervisor →
    // OutboundClient → mock channel.send records payloads verbatim):
    const payload = exactlyOneSend(env.channels.notify.sent, "rss new-entry alert");
    assertPingsNobody(payload, { label: "rss alert (no role configured)" });
    assert.equal(
      payload.content,
      `**Example News** ${EMDASH} new post`,
      "content line follows the format spec string",
    );

    const embed = payload.embeds[0];
    assert.equal(embed.title, "Introducing RSS");
    assert.equal(embed.url, "https://example.com/introducing-rss", "embed title is linked to the entry");
    assert.match(embed.description, /The bot now reads feeds\./, "snippet present");
    assert.equal(embed.footer.text, "Example News");
    assert.equal(
      embed.timestamp,
      new Date(T0 - 10 * MIN).toISOString(),
      "timestamp = the real pubDate",
    );

    // State: seen-set holds the key, watermark advanced, no failures.
    assert.ok(
      env.db.listRssSeenKeysForFeed(env.communityId, URL_MAIN).includes("introducing-rss"),
      "posted entry claimed in the per-feed seen-set",
    );
    let row = rowOf(env.communityId, URL_MAIN);
    assert.equal(row.last_checked, T0, "watermark stamped with the injected clock");
    assert.equal(row.failure_count, 0);
    assert.equal(row.last_entry_key, "introducing-rss");
  });

  // ===========================================================================
  // S3 — second tick silent (seen-set dedup), clock advances
  // ===========================================================================

  it("S3: the next due tick replays the same feed and posts NOTHING", async () => {
    env.channels.notify.sent.length = 0;
    const before = rowOf(env.communityId, URL_MAIN);
    // Same canned body as S2 — every replayed entry is already seen.
    const fetchImpl = routingFetch({
      [URL_MAIN]: httpOk(
        rss2([
          rssItem({
            guid: "introducing-rss",
            title: "Introducing RSS",
            link: "https://example.com/introducing-rss",
            pubMs: T0 - 10 * MIN,
            desc: "The bot now reads feeds.",
          }),
        ]),
      ),
    });

    const T1 = T0 + 16 * MIN; // 15-minute default interval: due
    const agg = await pollAllFeeds({
      db: env.db,
      supervisor: env.supervisor,
      fetchImpl,
      resolveHost: resolveHostOk,
      now: T1,
    });

    assert.equal(agg.polled, 1, "the row is due again (interval elapsed)");
    assert.equal(agg.posted, 0, "seen-set dedup: nothing reposted");
    assert.equal(agg.failures, 0);
    assert.equal(env.channels.notify.sent.length, 0, "zero outbound on the quiet pass");

    const after = rowOf(env.communityId, URL_MAIN);
    assert.equal(after.last_checked, T1, "the free pass still advances last_checked");
    assert.equal(after.failure_count, 0);
    assert.ok(before.last_checked === T0, "sanity: previous watermark was the first tick");
    assert.deepEqual(
      env.db.listRssSeenKeysForFeed(env.communityId, URL_MAIN),
      ["introducing-rss"],
      "seen-set unchanged — the quiet pass adds nothing",
    );
    assert.equal(fetchImpl.callsFor(URL_MAIN).length, 1, "the pass DID fetch (it is a real poll, not a skip)");
  });

  // ===========================================================================
  // S4 — role mention + smuggled-mention neutralization on the tick send
  // ===========================================================================

  it("S4: /setrss role → next new entry pings ONLY that role; smuggled @everyone/<@&id> neutralized", async () => {
    const setRole = await env.runCommand({
      commandName: "setrss",
      subcommand: "role",
      admin: true,
      options: { role: { id: ROLE_ID } },
    });
    assertReplyContains(setRole, new RegExp(`RSS notifications will mention <@&${ROLE_ID}>`));
    assert.equal(settingsOf(env.communityId).rss_notify_role_id, ROLE_ID);

    // A second feed carrying an entry with a smuggled @everyone + role token.
    // XML-entity-encoded like a real hostile feed would send it: rss-parser
    // decodes the entities once, so the parsed title is literal mention text.
    env.db.addRssFeed(env.communityId, URL_SMUGGLE, {
      displayName: "Smuggle Blog",
      feedTitle: "Smuggle Blog",
      feedLink: "https://smuggle.example",
    });

    env.channels.notify.sent.length = 0;
    const T2 = T0 + 20 * MIN;
    const fetchImpl = routingFetch({
      [URL_SMUGGLE]: httpOk(
        rss2(
          [
            rssItem({
              guid: "smug-1",
              title: "You @everyone &lt;@&amp;123&gt; won!",
              link: "https://smuggle.example/prize",
              pubMs: T0 + 5 * MIN,
              desc: "Details inside.",
            }),
          ],
          { title: "Smuggle Blog", link: "https://smuggle.example" },
        ),
      ),
    });

    const agg = await pollAllFeeds({
      db: env.db,
      supervisor: env.supervisor,
      fetchImpl,
      resolveHost: resolveHostOk,
      now: T2,
    });

    // The MAIN row (last_checked T0+16min, 15-min interval) is NOT due at
    // T0+20min: its gate must close BEFORE the transport.
    assert.equal(fetchImpl.callsFor(URL_MAIN).length, 0, "the interval gate precedes the socket (#379 shape)");
    assert.equal(agg.notDue, 1);
    assert.equal(agg.posted, 1);

    const payload = exactlyOneSend(env.channels.notify.sent, "rss role alert");
    // Two-sided #272 contract: content token ↔ exact strict payload.
    assertPingsRoleOnly(payload, ROLE_ID, { label: "rss new-entry alert (role configured)" });
    assert.equal(
      payload.content,
      `<@&${ROLE_ID}> **Smuggle Blog** ${EMDASH} new post`,
    );

    // Body-level defense-in-depth: the smuggled tokens never survive into
    // the embed (format.js neutralizeRichText — ZWSP break + token strip).
    const embed = payload.embeds[0];
    assert.equal(
      embed.title,
      `You @${ZWSP}everyone won!`,
      "@everyone ZWSP-broken and the smuggled <@&123> token stripped (single-encode caught post-decode)",
    );
    assert.ok(!embed.title.includes("@everyone"), "no live @everyone token in the headline");
    assert.ok(!embed.title.includes("<@&"), "no live role token in the headline");
    assert.match(embed.description, /Details inside\./, "snippet survived the neutralization");

    retire(env.communityId, URL_SMUGGLE);
  });

  // ===========================================================================
  // S5 — /rss check forces NOW (state writes) vs /rss test posts stateless
  //      (driven on a SECOND community so the 60-minute interval knob never
  //      disturbs the main community's 15-minute cadence)
  // ===========================================================================

  it("S5: /rss check bypasses the interval gate WITH state writes; /rss test posts WITHOUT touching state", async () => {
    // Second guild + community (events.test.js second-guild pattern).
    const guild2 = createGuild({ id: "guild-it-2" });
    const notify2 = createTextChannel({ id: "channel-notify-2", guild: guild2, name: "rss-notify" });
    guild2.addChannel(notify2);
    env.client.addGuild(guild2);
    const community2 = communityFor(guild2.id);

    env.db.updateGuildSettings(community2, {
      rss_notification_channel_id: notify2.id,
      rss_polling_interval_minutes: 60, // the gate the forced poll must bypass
    });
    env.db.addRssFeed(community2, URL_CHECK, {
      displayName: "Check Feed",
      feedTitle: "Check Feed",
      feedLink: "https://check.example",
    });
    // Not a first poll: watermark T0 (older rows seed), entry must be
    // published AFTER T0 to count as fresh on the later-poll rule.
    env.db.updateRssFeedWatermark(community2, URL_CHECK, { lastChecked: T0 });

    const T_CHECK = T0 + 20 * MIN; // inside the 60-minute gate → NOT due
    // No URL_MAIN source at all: a main-row gate leak would answer 599 (loud
    // failure) AND trip the zero-calls assertion below.
    const gateSweepFetch = routingFetch({
      [URL_CHECK]: httpOk(
        rss2([rssItem({ guid: "checked-entry", title: "Checked Entry", link: "https://check.example/c1", pubMs: T0 + 17 * MIN })]),
      ),
    });

    // (a) The TICKER would gate this row (and every other row is gated too —
    //     the whole sweep performs ZERO fetches):
    const gated = await pollAllFeeds({
      db: env.db,
      supervisor: env.supervisor,
      fetchImpl: gateSweepFetch,
      resolveHost: resolveHostOk,
      now: T_CHECK,
    });
    assert.equal(gated.notDue, gated.feeds, "every row is interval-gated at this instant");
    assert.ok(gated.notDue >= 1);
    assert.equal(gateSweepFetch.calls.length, 0, "the gate closes before the transport");
    assert.equal(notify2.sent.length, 0);

    // (b) /rss check FORCES the poll at the same clock → posts + writes state.
    const checkFetch = routingFetch({
      [URL_CHECK]: httpOk(
        rss2([
          rssItem({
            guid: "checked-entry",
            title: "Checked Entry",
            link: "https://check.example/c1",
            pubMs: T0 + 17 * MIN, // after the watermark → fresh on the later-poll rule
            desc: "Force-polled payload.",
          }),
        ]),
        { etag: 'W/"chk-1"' },
      ),
    });
    const check = await withRssDeps(
      { fetchImpl: checkFetch, resolveHost: resolveHostOk, env: {}, now: T_CHECK },
      () =>
        env.runCommand({
          commandName: "rss",
          subcommand: "check",
          admin: true,
          guild: guild2,
          options: { feed: URL_CHECK },
        }),
    );
    const checkText = env.lastReplyContent(check);
    assert.match(checkText, /\*\*Forced poll\*\* — 1 feed\(s\)/);
    assert.match(checkText, /\*\*Posted:\*\* 1/);
    assert.doesNotMatch(checkText, /\*\*Failures:\*\*/, "the forced poll succeeded");
    assert.equal(checkFetch.callsFor(URL_CHECK).length, 1, "check reached the transport despite the closed gate");

    const delivered = exactlyOneSend(notify2.sent, "rss forced-poll alert");
    assert.equal(delivered.embeds[0].title, "Checked Entry");
    assertPingsNobody(delivered, { label: "rss forced-poll alert (no role)" });

    let row = rowOf(community2, URL_CHECK);
    assert.equal(row.last_checked, T_CHECK, "check WRITES the watermark with its injected clock");
    assert.equal(row.last_entry_key, "checked-entry", "check advances the entry watermark");
    assert.equal(row.etag, 'W/"chk-1"', "check stores the conditional-GET validator");
    assert.equal(row.failure_count, 0);
    assert.ok(
      env.db.listRssSeenKeysForFeed(community2, URL_CHECK).includes("checked-entry"),
      "check claims the seen-set (it is the stateful path)",
    );

    // (c) /rss test posts the latest entry WITHOUT touching state.
    const seenBefore = env.db.listRssSeenKeysForFeed(community2, URL_CHECK);
    const rowBefore = rowOf(community2, URL_CHECK);
    const testFetch = routingFetch({
      [URL_CHECK]: httpOk(
        rss2([
          rssItem({ guid: "checked-entry", title: "Checked Entry", link: "https://check.example/c1", pubMs: T0 + 17 * MIN }),
          rssItem({
            guid: "test-latest",
            title: "Test Latest",
            link: "https://check.example/c2",
            pubMs: T0 + 18 * MIN,
            desc: "Diagnostic post.",
          }),
        ]),
      ),
    });
    const test = await withRssDeps(
      { fetchImpl: testFetch, resolveHost: resolveHostOk, env: {}, now: T_CHECK + MIN },
      () =>
        env.runCommand({
          commandName: "rss",
          subcommand: "test",
          admin: true,
          guild: guild2,
          options: { feed: URL_CHECK },
        }),
    );
    assertReplyContains(test, /Posted a test notification to/i);
    assert.match(env.lastReplyContent(test), /\*\*Entry:\*\* Test Latest/);
    const sent = exactlyOneSend(notify2.sent.slice(1), "rss test notification");
    assert.equal(sent.embeds[0].title, "Test Latest", "the freshest entry is what a diagnostic posts");

    // The state-freeze at the heart of the /rss test posture:
    assert.deepEqual(
      rowOf(community2, URL_CHECK),
      rowBefore,
      "/rss test wrote NOTHING — the whole feed row is byte-identical",
    );
    assert.deepEqual(
      env.db.listRssSeenKeysForFeed(community2, URL_CHECK),
      seenBefore,
      "/rss test added ZERO seen rows (the ticker must still announce the tested entry for real)",
    );

    retire(community2, URL_CHECK);
    retire(env.communityId, URL_MAIN); // the S1–S4 arc is over — keep later sweeps honest
  });

  // ===========================================================================
  // S6 — two communities sharing one feed URL: per-community seen scoping;
  //      one unready client → logged skip, others still post (partial failure)
  // ===========================================================================

  it("S6: one shared URL in three communities — two post independently, the unready client logs-and-skips", async () => {
    const cidA = communityFor("990000000000000101");
    const cidB = communityFor("990000000000000102");
    const cidC = communityFor("990000000000000103"); // configured but client never ready
    for (const [cid, chan] of [
      [cidA, "chan-rss-shared-a"],
      [cidB, "chan-rss-shared-b"],
      [cidC, "chan-rss-shared-c"],
    ]) {
      env.db.updateGuildSettings(cid, { rss_notification_channel_id: chan });
      env.db.addRssFeed(cid, URL_SHARED, {
        displayName: `Shared ${chan}`,
        feedTitle: "Shared Feed",
        feedLink: "https://shared.example",
      });
    }

    const outA = makeOutbound();
    const outB = makeOutbound();
    // Community C deliberately absent from the map → clientForCommunity null.
    const supervisor = fakeSupervisor(new Map([[cidA, outA], [cidB, outB]]));

    const sharedFeed = () =>
      httpOk(
        rss2(
          [
            rssItem({
              guid: "shared-1",
              title: "Shared Post",
              link: "https://shared.example/p1",
              pubMs: T0 - 5 * MIN,
            }),
          ],
          { title: "Shared Feed", link: "https://shared.example" },
        ),
      );

    const warnOriginal = console.warn;
    const warnings = [];
    console.warn = (...args) => {
      warnings.push(args.map(String).join(" "));
    };
    let agg;
    try {
      agg = await pollAllFeeds({
        db: env.db,
        supervisor,
        fetchImpl: routingFetch({ [URL_SHARED]: sharedFeed() }),
        resolveHost: resolveHostOk,
        now: T0,
      });
    } finally {
      console.warn = warnOriginal;
    }

    assert.equal(agg.posted, 2, "ONE post per community for the SAME url (per-community seen scoping)");
    assert.equal(agg.noClient, 1, "the unready community counted as a client skip");
    assert.equal(agg.skipped, 1);
    assert.equal(agg.polled, 2);
    assert.equal(agg.failures, 0, "a client skip is not a sweep failure — the other communities kept going");

    // makeOutbound records {channelId, payload} envelopes (the supervisor
    // seam is one level below the harness channel mocks) — hand the
    // payload itself to the send-shape helper.
    const payloadA = exactlyOneSend(outA.sent.map((s) => s.payload), "community A rss alert");
    const payloadB = exactlyOneSend(outB.sent.map((s) => s.payload), "community B rss alert");
    assert.equal(outA.sent[0].channelId, "chan-rss-shared-a");
    assert.equal(outB.sent[0].channelId, "chan-rss-shared-b");
    assert.match(payloadA.content, new RegExp(`\\*\\*Shared chan-rss-shared-a\\*\\* ${EMDASH} new post`));
    assert.match(payloadB.content, new RegExp(`\\*\\*Shared chan-rss-shared-b\\*\\* ${EMDASH} new post`));

    // The skip is LOUD in the log (rule 2): named community + named url.
    const skipLines = warnings.filter((l) => /no ready client/.test(l) && l.includes(String(cidC)));
    assert.equal(skipLines.length, 1, "exactly one [rss] skip line naming the unready community");
    assert.ok(skipLines[0].includes(URL_SHARED), "the skip line names the skipped feed url too");

    // Independent seen-sets — B's post never depended on A's, and C has none.
    assert.ok(env.db.listRssSeenKeysForFeed(cidA, URL_SHARED).includes("shared-1"));
    assert.ok(env.db.listRssSeenKeysForFeed(cidB, URL_SHARED).includes("shared-1"));
    assert.deepEqual(env.db.listRssSeenKeysForFeed(cidC, URL_SHARED), [], "the skipped community claimed nothing");

    // Second due tick: both ready communities are silent (each from ITS OWN
    // seen-set), the unready one still only skips.
    agg = await pollAllFeeds({
      db: env.db,
      supervisor,
      fetchImpl: routingFetch({ [URL_SHARED]: sharedFeed() }),
      resolveHost: resolveHostOk,
      now: T0 + 16 * MIN,
    });
    assert.equal(agg.posted, 0, "per-community dedup: neither community reposts");
    assert.equal(agg.noClient, 1);
    assert.equal(outA.sent.length, 1);
    assert.equal(outB.sent.length, 1);

    for (const cid of [cidA, cidB, cidC]) retire(cid, URL_SHARED);
  });

  // ===========================================================================
  // S7 — misconfigured + failing communities: skipped/failed per-row without
  //      killing the sweep; failure_count observable (backoff state)
  // ===========================================================================

  it("S7: no-channel community is logged-and-skipped with zero fetches; a fetch failure bumps failure_count", async () => {
    const chanless = communityFor("990000000000000104"); // NO rss_notification_channel_id
    const flaky = communityFor("990000000000000105");
    env.db.updateGuildSettings(flaky, { rss_notification_channel_id: "chan-rss-flaky" });
    env.db.addRssFeed(chanless, URL_CHANLESS, { displayName: "Homeless Feed" });
    env.db.addRssFeed(flaky, URL_FLAKEY, { displayName: "Flaky Feed" });

    const outFlaky = makeOutbound();
    const supervisor = fakeSupervisor(new Map([[flaky, outFlaky]]));
    const fetchImpl = routingFetch({ [URL_FLAKEY]: HttpStatus(500) });

    const agg = await pollAllFeeds({
      db: env.db,
      supervisor,
      fetchImpl,
      resolveHost: resolveHostOk,
      now: T0,
    });

    assert.equal(agg.feeds, 2);
    assert.equal(agg.refusedConfig, 1, "the channel-less row counted as refused-config");
    assert.equal(agg.skipped, 1);
    assert.equal(agg.polled, 1, "the sweep kept going to the flaky row");
    assert.equal(agg.failures, 1, "the 500 recorded as one failure");
    assert.equal(agg.posted, 0);
    assert.equal(fetchImpl.callsFor(URL_CHANLESS).length, 0, "the config gate precedes the transport");
    assert.equal(outFlaky.sent.length, 0);

    const flakyRow = rowOf(flaky, URL_FLAKEY);
    assert.equal(flakyRow.failure_count, 1, "failure_count observable — the backoff window doubles from here");
    assert.equal(flakyRow.last_checked, T0, "the retry gate counts from the failure stamp");
    assert.equal(rowOf(chanless, URL_CHANLESS).last_checked, null, "refused-config touched no state");

    // The backed-off row must NOT be fetched on the next (due-ish) tick:
    // fc=1 doubles the 15-min base → next try at T0+30min, not T0+16min.
    const gatedFetch = routingFetch({ [URL_FLAKEY]: HttpStatus(599) });
    const gated = await pollAllFeeds({
      db: env.db,
      supervisor,
      fetchImpl: gatedFetch,
      resolveHost: resolveHostOk,
      now: T0 + 16 * MIN,
    });
    assert.equal(gated.notDue, 1, "the failure backoff gates the flaky row before the transport");
    assert.equal(gatedFetch.callsFor(URL_FLAKEY).length, 0);

    retire(chanless, URL_CHANLESS);
    retire(flaky, URL_FLAKEY);
  });

  // ===========================================================================
  // S8 — conditional GET: 304 is a FREE poll (last_checked advances only)
  // ===========================================================================

  it("S8: second poll receives 304 — last_checked advances, validators survive, zero outbound", async () => {
    const cid = communityFor("990000000000000106");
    env.db.updateGuildSettings(cid, { rss_notification_channel_id: "chan-rss-cond" });
    env.db.addRssFeed(cid, URL_COND, { displayName: "Cond Feed" });
    const outbound = makeOutbound();
    const supervisor = fakeSupervisor(new Map([[cid, outbound]]));

    // One stub for both sweeps: 200 + ETag first, 304 once the client
    // revalidates with the STORED validator.
    const fetchImpl = routingFetch({
      [URL_COND]: (url, init) =>
        init?.headers?.["If-None-Match"]
          ? HttpStatus(304)
          : httpOk(
              rss2(
                [rssItem({ guid: "cond-1", title: "Conditional", link: "https://cond.example/1", pubMs: T0 - 5 * MIN })],
                { title: "Cond Feed", link: "https://cond.example" },
              ),
              { etag: 'W/"c1"' },
            ),
    });

    const first = await pollAllFeeds({
      db: env.db,
      supervisor,
      fetchImpl,
      resolveHost: resolveHostOk,
      now: T0,
    });
    assert.equal(first.posted, 1);
    assert.equal(rowOf(cid, URL_COND).etag, 'W/"c1"', "the response validator is STORED for the next conditional GET");

    const second = await pollAllFeeds({
      db: env.db,
      supervisor,
      fetchImpl,
      resolveHost: resolveHostOk,
      now: T0 + 16 * MIN,
    });

    assert.equal(second.notModified, 1, "304 counted as a free poll");
    assert.equal(second.posted, 0, "zero outbound on a 304");
    assert.equal(outbound.sent.length, 1, "still only the first tick's post");

    assert.equal(
      fetchImpl.callsFor(URL_COND)[1].init.headers["If-None-Match"],
      'W/"c1"',
      "the stored etag rode the conditional GET",
    );

    const row = rowOf(cid, URL_COND);
    assert.equal(row.last_checked, T0 + 16 * MIN, "spec: 304 advances last_checked");
    assert.equal(row.etag, 'W/"c1"', "…ONLY — the validators survive the free poll");
    assert.equal(row.last_entry_key, "cond-1", "…and the entry watermark survives too");
    assert.equal(row.failure_count, 0);

    retire(cid, URL_COND);
  });

  // ===========================================================================
  // S9 — staff gate: non-staff ctx refused on every rss surface, no writes
  //      (mirrors youtube.test.js "denies non-staff /youtube")
  // ===========================================================================

  it("S9: non-staff /rss add|list and /setrss are refused ephemerally with zero db writes", async () => {
    const feedsBefore = env.db.listRssFeedsForCommunity(env.communityId);
    const settingsBefore = settingsOf(env.communityId);
    const spyFetch = routingFetch({});

    const add = await withRssDeps(
      { fetchImpl: spyFetch, resolveHost: resolveHostOk, env: {} },
      () =>
        env.runCommand({
          commandName: "rss",
          subcommand: "add",
          admin: false,
          user: env.users.memberUser,
          options: { url: "https://evil.example/feed.xml" },
        }),
    );
    assertEphemeralReply(add, /permission/i);

    const list = await env.runCommand({
      commandName: "rss",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(list, /permission/i);

    const setChannel = await env.runCommand({
      commandName: "setrss",
      subcommand: "channel",
      admin: false,
      user: env.users.memberUser,
      options: { channel: env.channels.general },
    });
    assertEphemeralReply(setChannel, /permission/i);

    assert.deepEqual(
      env.db.listRssFeedsForCommunity(env.communityId),
      feedsBefore,
      "no subscription rows written by denied commands",
    );
    assert.deepEqual(
      settingsOf(env.communityId),
      settingsBefore,
      "no settings written by the denied /setrss",
    );
    assert.equal(spyFetch.calls.length, 0, "the staff gate precedes every service call — zero fetches");
  });
});
