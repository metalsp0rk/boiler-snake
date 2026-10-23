const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

/**
 * Poller unit section for RSS feed notifications (issue #305, subtask 06):
 * src/features/rss/poller.js against a REAL migrated SQLite (loadDb()
 * harness — same fidelity bar as test/rss.test.js), the REAL rss-parser
 * fed with canned XML strings, a fake fetchImpl transport (no network),
 * and a fake outbound recorder (no Discord). Fixed `now` everywhere — no
 * real timers, no wall-clock races.
 *
 * The seams mirror the poller's dependency injection:
 *   fetchImpl      — fetch-shaped responses ({status, headers.get,
 *                    arrayBuffer}); guardedFetchForFeed adds the guard
 *                    posture on top (no real DNS: resolveHost fake).
 *   resolveHost    — one public IP, so the SSRF class-check passes.
 *   outbound       — records {channelId, payload}; optional failure at
 *                    send #n.
 *   db             — the real facade, optionally spread-wrapped with
 *                    spies / a smaller RSS_SEEN_CAP.
 *
 * Documented behaviors this file pins (poller.js module header #1/#2):
 * a failed send KEEPS the claimed seen-row (burn named in the log) but
 * PRESERVES last_checked (review fix S1), so the un-attempted backlog
 * genuinely retries on the next poll; fetch/parse failures still stamp
 * the retry clock.
 */
describe("rss poller", () => {
  let api;
  let cleanup;
  let poller;

  before(() => {
    // Contract: loadDb() before any `src/` require in this file (fresh temp
    // DB_PATH + require-cache reset). The poller is required AFTER it.
    ({ api, cleanup } = loadDb());
    poller = require("../src/features/rss/poller");
  });

  after(() => cleanup?.());

  // ---------------------------------------------------------------------------
  // Fixtures and seams
  // ---------------------------------------------------------------------------

  const MIN = 60_000;
  const HOUR = 3_600_000;
  /** Fixed epoch (2024-10-27T06:13:20Z), second-aligned so RFC-822 pubDates
   * round-trip exactly through rss-parser. */
  const T0 = 1_730_000_000_000;

  const EMDASH = String.fromCharCode(8212);

  /** Public-IP DNS fake — the SSRF guard is subtask 03's contract, here the
   * class check only needs to pass. */
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

  /** Recording fetchImpl: responses are consumed in order; the LAST one
   * repeats (so extra calls never crash, they just assert against .calls). */
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

  function rss2(items) {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<rss version="2.0"><channel><title>Example News</title>' +
      "<link>https://example.com</link><description>Headlines</description>" +
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

  function atomFeed(entries) {
    return (
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Blog</title>' +
      '<link href="https://atom.example/" rel="alternate"/>' +
      entries.join("") +
      "</feed>"
    );
  }

  function atomEntry({ id, title, link, pubMs, summary }) {
    return (
      "<entry>" +
      (id ? `<id>${id}</id>` : "") +
      (title ? `<title>${title}</title>` : "") +
      (link ? `<link href="${link}" rel="alternate"/>` : "") +
      (pubMs != null ? `<published>${new Date(pubMs).toISOString()}</published>` : "") +
      (summary ? `<summary>${summary}</summary>` : "") +
      "</entry>"
    );
  }

  /** Fake OutboundClient: records sends; `failAt: n` makes send #n (and
   * later) return { ok:false } the way a real rate/permission failure does. */
  function makeOutbound({ failAt = Infinity } = {}) {
    const sent = [];
    let sends = 0;
    return {
      sent,
      async sendChannel(channelId, payload) {
        sends += 1;
        if (sends >= failAt) return { ok: false, error: "simulated missing access" };
        sent.push({ channelId, payload });
        return { ok: true };
      },
    };
  }

  function setupCommunity(name, { roleId = null } = {}) {
    const cid = communityKey(name);
    api.updateGuildSettings(cid, {
      rss_notification_channel_id: `chan-${name}`,
      rss_notify_role_id: roleId,
      rss_polling_interval_minutes: 15,
    });
    return cid;
  }

  /** Settings row for cid (pollFeedRow consumes the guild_settings row). */
  const settingsFor = (cid) => api.getGuildSettings(cid);

  /** Fresh facade wrapper carrying call spies (tri-state writes matter). */
  function spyDb(overrides = {}) {
    const successCalls = [];
    const failureCalls = [];
    const db = {
      ...api,
      ...overrides,
      recordRssFeedSuccess: (...args) => {
        successCalls.push(args);
        return api.recordRssFeedSuccess(...args);
      },
      recordRssFeedFailure: (...args) => {
        failureCalls.push(args);
        return api.recordRssFeedFailure(...args);
      },
    };
    return { db, successCalls, failureCalls };
  }

  const pollOne = (params) => poller.pollFeedRow({ db: api, resolveHost: resolveHostOk, ...params });

  // ---------------------------------------------------------------------------
  // API surface (acceptance names: pollFeed / pollDueFeeds are aliases)
  // ---------------------------------------------------------------------------

  it("exposes pollFeedRow / pollAllFeeds plus the pollFeed / pollDueFeeds aliases", () => {
    assert.equal(typeof poller.pollFeedRow, "function");
    assert.equal(typeof poller.pollAllFeeds, "function");
    assert.equal(typeof poller.pollFeed, "function");
    assert.equal(typeof poller.pollDueFeeds, "function");
    assert.equal(poller.MAX_POSTS_PER_FEED_PER_TICK, 5, "flood cap matches the spec");
  });

  // ---------------------------------------------------------------------------
  // First-poll window (post fresh, seed stale silently, drop unkeyed)
  // ---------------------------------------------------------------------------

  it("first poll posts the last-hour entries, seeds stale ones silently, skips unkeyed items", async () => {
    const cid = setupCommunity("rss-poller-first-poll");
    const url = "https://feeds.example.com/first-poll.xml";
    api.addRssFeed(cid, url, {
      displayName: "Example News",
      feedTitle: "Example Feed",
      feedLink: "https://example.com",
    });

    const fetchImpl = fetchStub(
      httpOk(
        rss2([
          rssItem({ guid: "e1", title: "First", link: "https://example.com/e1", pubMs: T0 - 10 * MIN, desc: "one" }),
          rssItem({ guid: "e2", title: "Second", link: "https://example.com/e2", pubMs: T0 - 5 * MIN, desc: "two" }),
          rssItem({ guid: "e3", title: "Stale", link: "https://example.com/e3", pubMs: T0 - 2 * HOUR, desc: "old" }),
          rssItem({ guid: "e4", title: "Undated", link: "https://example.com/e4", desc: "no date" }),
          rssItem({ desc: "orphan text — no guid, no title, no link" }),
        ]),
      ),
    );
    const outbound = makeOutbound();

    const res = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl,
      outbound,
    });

    assert.equal(res.ok, true);
    assert.equal(res.outcome, "posted");
    assert.equal(res.posted, 3, "two fresh + one date-less (youtube's Date.now() fallback)");
    assert.equal(res.skipped, 2, "one stale seed + one unkeyed");

    // Oldest-first delivery order; the date-less entry treated as `now` lands last.
    assert.deepEqual(
      outbound.sent.map((s) => s.payload.embeds[0].title),
      ["First", "Second", "Undated"],
    );
    assert.equal(outbound.sent[0].channelId, "chan-rss-poller-first-poll");
    assert.equal(
      outbound.sent[0].payload.content,
      `**Example News** ${EMDASH} new post`,
      "content line follows the format.js spec string",
    );
    assert.deepEqual(outbound.sent[0].payload.allowedMentions, { parse: [] }, "no role configured → no ping");

    // Seen-set: everything keyable is seen; the stale entry seeded silently;
    // the unkeyable item never enters the set (nothing to key on).
    assert.deepEqual(
      api.listRssSeenKeysForFeed(cid, url).sort(),
      ["e1", "e2", "e3", "e4"],
    );

    // Watermark row: clock stamped, failure count clean, key pointer on the
    // newest claimed entry (the date-less one, publishedMs = the injected now).
    const row = api.getRssFeed(cid, url);
    assert.equal(row.last_checked, T0);
    assert.equal(row.failure_count, 0);
    assert.equal(row.etag, null);
    assert.equal(row.last_entry_key, "e4");
  });

  it("mention rides the payload only when rss_notify_role_id is set", async () => {
    const ROLE = "1234567890123456789";
    const cid = setupCommunity("rss-poller-role", { roleId: ROLE });
    const url = "https://feeds.example.com/role.xml";
    api.addRssFeed(cid, url, { displayName: "Role Feeds" });

    const outbound = makeOutbound();
    const res = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl: fetchStub(
        httpOk(rss2([rssItem({ guid: "r1", title: "Pingable", link: "https://e.com/r1", pubMs: T0 - MIN })])),
      ),
      outbound,
    });

    assert.equal(res.outcome, "posted");
    assert.equal(outbound.sent.length, 1);
    assert.equal(outbound.sent[0].payload.content, `<@&${ROLE}> **Role Feeds** ${EMDASH} new post`);
    assert.deepEqual(
      outbound.sent[0].payload.allowedMentions,
      { roles: [ROLE] },
      "#272 strict allow-list arm",
    );
  });

  it("atom feeds parse through the real rss-parser; dedup keys come from <id>", async () => {
    const cid = setupCommunity("rss-poller-atom");
    const url = "https://atom.example/feed";
    api.addRssFeed(cid, url, { displayName: "Atom Blog" });

    const outbound = makeOutbound();
    const res = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl: fetchStub(
        httpOk(
          atomFeed([
            atomEntry({ id: "urn:atom:post-2", title: "Atom Two", link: "https://atom.example/2", pubMs: T0 - 4 * MIN, summary: "second" }),
            atomEntry({ id: "urn:atom:post-1", title: "Atom One", link: "https://atom.example/1", pubMs: T0 - 20 * MIN, summary: "first" }),
          ]),
        ),
      ),
      outbound,
    });

    assert.equal(res.outcome, "posted");
    assert.equal(res.posted, 2);
    assert.deepEqual(
      outbound.sent.map((s) => s.payload.embeds[0].title),
      ["Atom One", "Atom Two"],
      "oldest-first across an out-of-order feed",
    );
    assert.deepEqual(
      api.listRssSeenKeysForFeed(cid, url).sort(),
      ["urn:atom:post-1", "urn:atom:post-2"],
      "no <guid>: the Atom <id> is the key",
    );
  });

  // ---------------------------------------------------------------------------
  // Second poll (seen-set silence)
  // ---------------------------------------------------------------------------

  it("second poll over unchanged entries posts nothing (seen-set)", async () => {
    const cid = setupCommunity("rss-poller-second");
    const url = "https://feeds.example.com/second.xml";
    api.addRssFeed(cid, url, { displayName: "Quiet Feed" });

    const fetchImpl = fetchStub(
      httpOk(
        rss2([
          rssItem({ guid: "s1", title: "One", link: "https://example.com/s1", pubMs: T0 - 30 * MIN }),
          rssItem({ guid: "s2", title: "Two", link: "https://example.com/s2", pubMs: T0 - 10 * MIN }),
        ]),
      ),
    );
    const outbound = makeOutbound();

    const first = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl,
      outbound,
    });
    assert.equal(first.posted, 2);

    // Due at T0 + 16min (15-minute interval, failure_count 0).
    const T1 = T0 + 16 * MIN;
    const second = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T1,
      fetchImpl,
      outbound,
    });

    assert.equal(second.ok, true);
    assert.equal(second.outcome, "no-change", "seen entries are never reposted");
    assert.equal(second.posted, 0);
    assert.equal(outbound.sent.length, 2, "outbound untouched on the quiet pass");
    assert.equal(api.getRssFeed(cid, url).last_checked, T1, "the free pass still advances the clock");
  });

  // ---------------------------------------------------------------------------
  // Conditional GET: 304 = free poll
  // ---------------------------------------------------------------------------

  it("304 carries the stored etag, advances ONLY last_checked, posts nothing", async () => {
    const cid = setupCommunity("rss-poller-304");
    const url = "https://feeds.example.com/304.xml";
    api.addRssFeed(cid, url, { displayName: "Validated Feed" });

    // First poll: 200 with an ETag — the validator must be STORED.
    const fetchImpl = fetchStub(
      httpOk(
        rss2([rssItem({ guid: "v1", title: "Versioned", link: "https://example.com/v1", pubMs: T0 - MIN })]),
        { etag: 'W/"v1"' },
      ),
      HttpStatus(304),
    );
    const outbound = makeOutbound();

    const first = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl,
      outbound,
    });
    assert.equal(first.outcome, "posted");
    assert.equal(api.getRssFeed(cid, url).etag, 'W/"v1"', "response etag stored for the next conditional GET");

    // Second poll on a spy db: recordRssFeedSuccess must see ONLY lastChecked.
    const { db, successCalls } = spyDb();
    const T1 = T0 + 16 * MIN;
    const second = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T1,
      fetchImpl,
      outbound,
      db,
    });

    assert.equal(second.ok, true);
    assert.equal(second.outcome, "not-modified");
    assert.equal(second.posted, 0);
    assert.equal(outbound.sent.length, 1, "304 posts nothing");

    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(
      fetchImpl.calls[1].init.headers["If-None-Match"],
      'W/"v1"',
      "the stored etag rides the conditional GET",
    );

    assert.equal(successCalls.length, 1, "304 records exactly one success");
    const [okCid, okUrl, fields] = successCalls[0];
    assert.equal(okCid, cid);
    assert.equal(okUrl, url);
    assert.deepEqual(
      Object.keys(fields),
      ["lastChecked"],
      "spec: 304 advances last_checked ONLY — validators/watermark untouched",
    );
    assert.equal(fields.lastChecked, T1);

    const row = api.getRssFeed(cid, url);
    assert.equal(row.etag, 'W/"v1"', "stored validators survive the 304");
    assert.equal(row.last_checked, T1);
    assert.equal(row.failure_count, 0);
  });

  // ---------------------------------------------------------------------------
  // Failure → backoff → success reset
  // ---------------------------------------------------------------------------

  it("fetch failure increments failure_count, the next tick is backed off, success resets", async () => {
    const cid = setupCommunity("rss-poller-backoff");
    const url = "https://feeds.example.com/backoff.xml";
    api.addRssFeed(cid, url, { displayName: "Flaky Feed" });

    const failing = fetchStub(HttpStatus(500));
    const first = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl: failing,
      outbound: makeOutbound(),
    });
    assert.equal(first.ok, false);
    assert.equal(first.outcome, "fetch-failed");
    assert.match(first.error, /HTTP 500/, "the specific cause travels in the result");

    let row = api.getRssFeed(cid, url);
    assert.equal(row.failure_count, 1, "one consecutive failure recorded");
    assert.equal(row.last_checked, T0, "the retry gate counts from the failure stamp");

    // fc=1 doubles the 15-minute base → next try at T0+30min. T0+16min is
    // NOT due, and the gate must close BEFORE any fetch happens.
    const later = fetchStub(httpOk(rss2([])));
    const backed = await pollOne({
      row,
      settings: settingsFor(cid),
      now: T0 + 16 * MIN,
      fetchImpl: later,
      outbound: makeOutbound(),
    });
    assert.equal(backed.outcome, "backoff");
    assert.equal(backed.ok, true, "a backed-off poll is a clean skip, not an error");
    assert.equal(later.calls.length, 0, "the gate closes before the transport");

    // Past the doubled window the feed is due; the successful poll resets fc.
    const recovered = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0 + 31 * MIN,
      fetchImpl: later,
      outbound: makeOutbound(),
    });
    assert.equal(recovered.outcome, "no-change");
    assert.equal(later.calls.length, 1);
    row = api.getRssFeed(cid, url);
    assert.equal(row.failure_count, 0, "success drops the backoff to the plain interval");
  });

  // ---------------------------------------------------------------------------
  // Flood cap (twitch overflow semantics)
  // ---------------------------------------------------------------------------

  it("flood cap: 9 fresh entries → oldest 5 posted, newest 4 marked seen WITHOUT posting", async () => {
    const cid = setupCommunity("rss-poller-flood");
    const url = "https://feeds.example.com/flood.xml";
    api.addRssFeed(cid, url, { displayName: "Chatty Feed" });

    // Nine fresh entries, feed order NEWEST-first (real feeds list newest
    // first — the poller re-sorts oldest-first for delivery).
    const offsets = [4, 6, 10, 15, 20, 25, 30, 35, 40]; // minutes before T0
    const items = offsets.map((m, i) =>
      rssItem({
        guid: `p${i + 1}`,
        title: `Post ${i + 1}`,
        link: `https://example.com/p${i + 1}`,
        pubMs: T0 - m * MIN,
      }),
    );

    const fetchImpl = fetchStub(httpOk(rss2(items)));
    const outbound = makeOutbound();

    const first = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl,
      outbound,
    });

    assert.equal(first.outcome, "posted");
    assert.equal(first.posted, 5, "cap is 5 per feed per tick");
    assert.equal(first.skipped, 4, "the overflow counts as skipped, not lost silently");

    // The OLDEST five (p9..p5 by offset order) deliver, oldest-first.
    assert.deepEqual(
      outbound.sent.map((s) => s.payload.embeds[0].title),
      ["Post 9", "Post 8", "Post 7", "Post 6", "Post 5"],
    );

    // Twitch precedent: overflow is marked seen (NOT left for the next tick)
    // — the drop is bounded and logged, never a slow back-flood.
    assert.deepEqual(
      api.listRssSeenKeysForFeed(cid, url).sort(),
      ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"],
      "all nine keys are in the bounded seen-set",
    );

    const second = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0 + 16 * MIN,
      fetchImpl,
      outbound,
    });
    assert.equal(second.outcome, "no-change");
    assert.equal(outbound.sent.length, 5, "the overflow does NOT come back next tick");
  });

  // ---------------------------------------------------------------------------
  // Send failure mid-batch
  // ---------------------------------------------------------------------------

  it("send failure mid-batch stops the tick, records one failure, and keeps the claimed key (documented)", async () => {
    const cid = setupCommunity("rss-poller-sendfail");
    const url = "https://feeds.example.com/sendfail.xml";
    api.addRssFeed(cid, url, { displayName: "Blocked Feed" });

    const feedFixture = httpOk(
      rss2([
        rssItem({ guid: "k1", title: "Sent", link: "https://example.com/k1", pubMs: T0 - 30 * MIN }),
        rssItem({ guid: "k2", title: "Burned", link: "https://example.com/k2", pubMs: T0 - 20 * MIN }),
        rssItem({ guid: "k3", title: "Stopped", link: "https://example.com/k3", pubMs: T0 - 10 * MIN }),
      ]),
    );
    const fetchImpl = fetchStub(feedFixture);
    const outbound = makeOutbound({ failAt: 2 });

    const res = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl,
      outbound,
    });

    assert.equal(res.ok, false);
    assert.equal(res.outcome, "send-failed");
    assert.equal(res.posted, 1, "the batch STOPPED at the first failure (youtube #380 shape)");
    assert.equal(res.error, "simulated missing access", "the outbound cause travels");
    assert.equal(outbound.sent.length, 1);

    const row = api.getRssFeed(cid, url);
    assert.equal(row.failure_count, 1, "one failure recorded for the send");
    assert.equal(
      row.last_checked,
      null,
      "send failure PRESERVES the watermark (review fix S1): never-checked stays NULL, the backlog retries",
    );

    const seen = api.listRssSeenKeysForFeed(cid, url);
    assert.ok(seen.includes("k1"), "delivered entry is seen");
    assert.ok(seen.includes("k2"), "the FAILED send keeps its claim (documented decision #1)");
    assert.ok(!seen.includes("k3"), "entries after the stop point are left unclaimed");

    // Recovery poll (review fix S1): the watermark survived the send
    // failure, so k3 (published 41 min before this poll — inside the
    // first-hour window of a NULL watermark) is GENUINELY RETRIED instead
    // of being silently seeded past.
    const recovery = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0 + 31 * MIN,
      fetchImpl: fetchStub(feedFixture),
      outbound: makeOutbound(),
    });
    assert.equal(recovery.outcome, "posted", "the un-attempted backlog retries on the next poll (review fix S1)");
    assert.equal(recovery.posted, 1, "k3 is announced on recovery");
    assert.ok(api.listRssSeenKeysForFeed(cid, url).includes("k3"), "k3 claimed + delivered on recovery");
    assert.equal(api.getRssFeed(cid, url).failure_count, 0, "the clean pass reset the counter");
  });

  // ---------------------------------------------------------------------------
  // Robustness: unparseable body, unready client, refused config
  // ---------------------------------------------------------------------------

  it("unparseable 200 body records a failure instead of crashing", async () => {
    const cid = setupCommunity("rss-poller-parse");
    const url = "https://feeds.example.com/broken.xml";
    api.addRssFeed(cid, url, { displayName: "Broken Feed" });

    const outbound = makeOutbound();
    const res = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl: fetchStub(httpOk("this is definitely not xml")),
      outbound,
    });

    assert.equal(res.ok, false);
    assert.equal(res.outcome, "parse-failed", "never a throw, always a named failure");
    assert.equal(outbound.sent.length, 0);
    assert.equal(api.getRssFeed(cid, url).failure_count, 1, "the parse failure backs off like a fetch failure");
  });

  it("pollFeedRow never throws on garbage input (last-resort net)", async () => {
    const res = await pollOne({
      row: {},
      settings: { rss_notification_channel_id: "chan-broken" },
      now: T0,
      fetchImpl: fetchStub(httpOk(rss2([]))),
      outbound: makeOutbound(),
    });
    assert.equal(res.ok, false, "the failure surfaces in the result, not as an exception");
    assert.equal(res.outcome, "error");
    assert.ok(res.error, "carries a cause");
  });

  it("refused-config row: no channel → outcome refused-config with ZERO fetches", async () => {
    const cid = communityKey("rss-poller-nochan"); // guild_settings auto-ensured, channel NULL
    const url = "https://feeds.example.com/never-fetched.xml";
    api.addRssFeed(cid, url, { displayName: "Homeless Feed" });

    const fetchImpl = fetchStub(httpOk(rss2([])));
    const res = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl,
      outbound: makeOutbound(),
    });

    assert.equal(res.ok, true);
    assert.equal(res.outcome, "refused-config");
    assert.equal(fetchImpl.calls.length, 0, "the config gate precedes the transport");
  });

  it("pollAllFeeds: refused-config counted, unready clients logged-and-skipped, nothing fetched, no throw", async () => {
    // One community WITHOUT a channel, one WITH a channel but no ready client.
    const chanless = communityKey("rss-poller-sweep-nochan");
    const nochanUrl = "https://feeds.example.com/sweep-nochan.xml";
    api.addRssFeed(chanless, nochanUrl, {});

    const clientless = setupCommunity("rss-poller-sweep-noclient");
    const noclientUrl = "https://feeds.example.com/sweep-noclient.xml";
    api.addRssFeed(clientless, noclientUrl, {});

    const fetchImpl = fetchStub(HttpStatus(599)); // would fail loudly if called
    const supervisor = { clientForCommunity: () => null };

    const agg = await poller.pollAllFeeds({
      db: api,
      supervisor,
      fetchImpl,
      resolveHost: resolveHostOk,
      now: T0 + 40 * MIN,
    });

    assert.ok(agg.feeds >= 2);
    assert.ok(agg.refusedConfig >= 1, "the channelless row counted once as refused-config");
    assert.ok(agg.noClient >= 1, "the clientless row counted as no-client");
    assert.ok(agg.skipped >= agg.refusedConfig + agg.noClient);
    assert.equal(agg.polled, 0, "no row reached the transport");
    assert.equal(agg.posted, 0);
    assert.equal(agg.failures, 0, "skips are not failures");
    assert.equal(
      fetchImpl.calls.filter((c) => c.url === nochanUrl || c.url === noclientUrl).length,
      0,
      "neither skip category ever fetched",
    );
  });

  it("pollAllFeeds logs at most ONE aggregate [rss] tick line per sweep with work", async () => {
    const original = console.log;
    const lines = [];
    console.log = (...args) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const agg = await poller.pollAllFeeds({
        db: api,
        supervisor: { clientForCommunity: () => null },
        fetchImpl: fetchStub(HttpStatus(599)),
        resolveHost: resolveHostOk,
        now: T0 + 41 * MIN,
      });
      const tickLines = lines.filter((l) => l.includes("[rss] tick:"));
      assert.equal(tickLines.length, 1, "exactly one aggregate line per working sweep");
      assert.equal(agg.noClient >= 1, true, "sanity: this sweep did have work");
    } finally {
      console.log = original;
    }
  });

  it("supervisor-less sweep (null) never throws — every due row logs-and-skips", async () => {
    const agg = await poller.pollAllFeeds({ db: api, supervisor: null, now: T0 + 42 * MIN });
    assert.equal(agg.failures, 0, "resolveOutbound(null) is a skip, not a sweep failure");
  });

  // ---------------------------------------------------------------------------
  // Bounded seen-set: prune fires when the partition asks for it
  // ---------------------------------------------------------------------------

  it("prune fires when the seen-set crosses the cap (oldest keys die, newest survive)", async () => {
    const cid = setupCommunity("rss-poller-prune");
    const url = "https://feeds.example.com/prune.xml";
    api.addRssFeed(cid, url, { displayName: "Pruned Feed" });

    // Tiny cap via the injected facade (the poller passes db.RSS_SEEN_CAP
    // to partitionEntries and to pruneRssSeenForFeed explicitly).
    const db = { ...api, RSS_SEEN_CAP: 3 };

    // Poll 1: one fresh entry (ka) → posted, seen_at backdated to publishedMs.
    const first = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0,
      fetchImpl: fetchStub(
        httpOk(rss2([rssItem({ guid: "ka", title: "Keep A", link: "https://example.com/ka", pubMs: T0 - 10 * MIN })])),
      ),
      outbound: makeOutbound(),
      db,
    });
    assert.equal(first.outcome, "posted");

    // Three older keys join the set (oldest die first on prune).
    api.addRssSeenEntry(cid, url, "old1", T0 - 3 * HOUR);
    api.addRssSeenEntry(cid, url, "old2", T0 - 2 * HOUR);
    api.addRssSeenEntry(cid, url, "old3", T0 - 1 * HOUR);

    // Poll 2: ka is seen; knew is fresh → posted. seen(4) + new(1) > cap(3)
    // → pruneNeeded → prune keeps the three newest rows.
    const second = await pollOne({
      row: api.getRssFeed(cid, url),
      settings: settingsFor(cid),
      now: T0 + 16 * MIN,
      fetchImpl: fetchStub(
        httpOk(
          rss2([
            rssItem({ guid: "ka", title: "Keep A", link: "https://example.com/ka", pubMs: T0 - 10 * MIN }),
            rssItem({ guid: "knew", title: "New", link: "https://example.com/knew", pubMs: T0 + 5 * MIN }),
          ]),
        ),
      ),
      outbound: makeOutbound(),
      db,
    });

    assert.equal(second.outcome, "posted");
    assert.equal(second.posted, 1);
    assert.deepEqual(
      api.listRssSeenKeysForFeed(cid, url),
      ["old3", "ka", "knew"],
      "two oldest rows pruned; the freshest cap rows survive",
    );
    assert.equal(api.getRssFeed(cid, url).last_entry_key, "knew");
  });
});
