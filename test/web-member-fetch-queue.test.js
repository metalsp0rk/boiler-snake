/**
 * §8.15 lazy member-fetch queue (option C): cache misses render as ids NOW
 * and get resolved OFF the request path, bounded + rate-cooled, so later
 * renders show names. No HTTP here — pure service + resolve-seam seams.
 */
const { test, describe, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");


// #609: this file LOADS src/db-bound modules at require time (the first
// such require is `../src/web/routes/shared/discord-cache` below) — connection.js opens AND migrates
// DB_PATH at LOAD time, so two concurrent node --test files sharing an
// ambient DB_PATH race mid-migration (the #470 G2-6 class). Bind a
// private temp DB HERE; later env flows (createIntegrationEnv /
// per-test loadDb) rebind to their own env exactly as before.
const { cleanup: cleanupTempDb } = require("./helpers/env").loadDb();
after(cleanupTempDb);
const {
  resolveMemberNames,
} = require("../src/web/routes/shared/discord-cache");
const queue = require("../src/web/services/memberFetchQueue");

const GUILD = "199256932081467392";

/** Client fake: member cache Map + recording fetch that populates it. */
function makeClient(fetchImpl) {
  const members = new Map();
  const calls = [];
  const client = {
    guilds: {
      cache: new Map([
        [
          GUILD,
          {
            members: {
              cache: members,
              fetch: async (opts) => {
                const user = typeof opts === "string" ? opts : opts?.user;
                calls.push(user);
                const member = await fetchImpl(user);
                members.set(user, member);
                return member;
              },
            },
          },
        ],
      ]),
    },
  };
  return { client, members, calls };
}

const okMember = (user) => ({ displayName: `Name-${user}`, user: { username: `u${user}` } });

function discordErr(code, message) {
  const err = new Error(message || `discord error ${code}`);
  err.code = code;
  return err;
}

describe("memberFetchQueue (§8.15 option C)", () => {
  let warn, error, warnLines, errorLines;
  beforeEach(() => {
    queue.stopMemberFetchQueue();
    warnLines = [];
    errorLines = [];
    warn = console.warn;
    error = console.error;
    console.warn = (...a) => warnLines.push(a.join(" "));
    console.error = (...a) => errorLines.push(a.join(" "));
  });
  afterEach(() => {
    console.warn = warn;
    console.error = error;
    queue.stopMemberFetchQueue();
  });

  test("hero: miss renders null, background flush fills cache, next render shows name", async () => {
    const { client } = makeClient(okMember);
    const getClient = () => client;

    const first = resolveMemberNames(getClient, GUILD, ["111"]);
    assert.equal(first.get("111"), null, "cold cache still renders id-only");
    assert.equal(queue.queueStats()[GUILD], 1, "miss was queued off-path");

    const attempted = await queue.flushMemberFetchQueue();
    assert.equal(attempted, 1);

    const second = resolveMemberNames(getClient, GUILD, ["111"]);
    assert.equal(second.get("111"), "Name-111", "next render resolves the name");
    assert.equal(queue.queueStats()[GUILD], undefined, "nothing left to fetch");
  });

  test("dedupe: repeated renders of the same miss fetch exactly once", async () => {
    const { client, calls } = makeClient(okMember);
    const getClient = () => client;
    resolveMemberNames(getClient, GUILD, ["222"]);
    resolveMemberNames(getClient, GUILD, ["222"]);
    resolveMemberNames(getClient, GUILD, ["222"]);
    assert.equal(queue.queueStats()[GUILD], 1, "queue dedupes ids");
    await queue.flushMemberFetchQueue();
    assert.deepEqual(calls, ["222"]);
  });

  test("cooldown: a re-missing id is not re-fetched immediately", async () => {
    let fail = true;
    const { client, calls } = makeClient(async (u) => {
      if (fail) throw discordErr(50003, "missing access");
      return okMember(u);
    });
    const get = () => client;

    queue.queueMissingMembers(get, GUILD, ["333"]);
    await queue.flushMemberFetchQueue();
    assert.deepEqual(calls, ["333"], "transient failure still attempted once");
    assert.ok(errorLines.some((l) => l.includes("member fetch failed")), "failure logged");

    const added = queue.queueMissingMembers(get, GUILD, ["333"]);
    assert.equal(added, 0, "cooldown blocks immediate retry");
    assert.equal(calls.length, 1, "no second fetch within cooldown");
  });

  test("unknown member (10007): logged honestly, parked ~24h, no hammering", async () => {
    const { client, calls } = makeClient(async () => {
      throw discordErr(10007, "Unknown Member");
    });
    const get = () => client;
    queue.queueMissingMembers(get, GUILD, ["444"]);
    await queue.flushMemberFetchQueue();
    assert.ok(
      warnLines.some((l) => l.includes("444") && l.includes("left/deleted")),
      "honest warn with ids"
    );
    const added = queue.queueMissingMembers(get, GUILD, ["444"]);
    assert.equal(added, 0, "negative cache holds for a day");
    assert.equal(calls.length, 1);
  });

  test("dark boot: no client ⇒ nulls, no queueing, no crash", () => {
    const names = resolveMemberNames(undefined, GUILD, ["555"]);
    assert.equal(names.get("555"), null);
    assert.deepEqual(queue.queueStats(), {});
    const broken = resolveMemberNames(() => { throw new Error("boom"); }, GUILD, ["555"]);
    assert.equal(broken.get("555"), null);
    assert.deepEqual(queue.queueStats(), {});
  });

  test("fake clients without members.fetch never enqueue (suite-safe)", () => {
    const fake = { guilds: { cache: new Map([[GUILD, { members: { cache: new Map() } }]]) } };
    const names = resolveMemberNames(() => fake, GUILD, ["666"]);
    assert.equal(names.get("666"), null);
    assert.deepEqual(queue.queueStats(), {}, "no fetch capability ⇒ no queue");
  });

  test("flush with empty queue is a cheap no-op", async () => {
    assert.equal(await queue.flushMemberFetchQueue(), 0);
  });

  test("bounded: one flush attempts at most 60 ids per guild; rest stay queued", async () => {
    const ids = Array.from({ length: 70 }, (_, i) => `${700 + i}`);
    const { client, calls } = makeClient(okMember);
    const get = () => client;
    queue.queueMissingMembers(get, GUILD, ids);
    assert.equal(queue.queueStats()[GUILD], 70);
    const attempted = await queue.flushMemberFetchQueue();
    assert.equal(attempted, 60, "fetch budget per guild per flush");
    assert.equal(calls.length, 60);
    assert.equal(queue.queueStats()[GUILD], 10, "remainder keeps draining later");
  });

  test("queue cap is bounded (pathological id dumps drop, not explode)", () => {
    const fake = { guilds: { cache: new Map([[GUILD, { members: { cache: new Map(), fetch: async () => ({}) } }]]) } };
    const get = () => fake;
    const many = Array.from({ length: 1500 }, (_, i) => `${800000 + i}`);
    queue.queueMissingMembers(get, GUILD, many);
    assert.equal(queue.queueStats()[GUILD], 1000, "hard cap 1000 per guild");
  });

  test("guild that disappears mid-queue: queue discarded, nothing throws", async () => {
    const { client } = makeClient(okMember);
    const get = () => client;
    queue.queueMissingMembers(get, GUILD, ["999"]);
    client.guilds.cache.delete(GUILD); // guild left / cache evicted
    const attempted = await queue.flushMemberFetchQueue();
    assert.equal(attempted, 0);
    assert.deepEqual(queue.queueStats(), {}, "stale queue cleaned up");
  });

  // -------------------------------------------------------------------------
  // #467 (C1-9): the header always promised "bounded, LOGGED, never silent" —
  // cap drops now COUNT and WARN; the Fluxer lane got the long negative
  // cooldown the Discord UNKNOWN_MEMBER path always had (both branches used
  // to be identical 10-min retries — permanently-deleted users re-fetched
  // forever).
  // -------------------------------------------------------------------------

  test("#467 cap drops are counted and warned, not silent", () => {
    const fake = { guilds: { cache: new Map() } };
    const ids = Array.from({ length: 1200 }, (_, i) => `cap9-${i}`);
    const added = queue.queueMissingMembersExternal(() => fake, "cap-drop-guild", ids);
    assert.equal(added, 1000, "cap holds");
    assert.ok(
      warnLines.some(
        (l) => l.includes("cap-drop-guild") && l.includes("dropped 200 id(s)")
      ),
      `the drop is loud with count + key (warns: ${JSON.stringify(warnLines)})`
    );
  });

  test("#467 unresolvable fluxer user parks ~24h, not forever-retry", async () => {
    const { loadDb } = require("./helpers/env");
    const loaded = loadDb();
    try {
      const { ensureCommunity } = require("../src/platform/community");
      const cid = ensureCommunity({
        platform: "fluxer",
        instanceKey: "fluxer",
        externalGuildId: "940000000000000077",
      });
      const cacheSeam = require("../src/web/routes/shared/discord-cache");
      const origClient = cacheSeam.communityClient;
      let fetchCalls = 0;
      cacheSeam.communityClient = (id) =>
        id === cid
          ? {
              fetchUser: async () => {
                fetchCalls += 1;
                return null; // OutboundClient null = unresolvable
              },
            }
          : null;
      try {
        queue.queueMissingMembers(() => null, String(cid), ["gone-user"]);
        await queue.flushMemberFetchQueue();
        assert.equal(fetchCalls, 1, "one REST attempt");
        assert.ok(
          warnLines.some(
            (l) => l.includes("gone-user") && l.includes("stays raw for ~24h")
          ),
          `honest warn naming the ~24h park (warns: ${JSON.stringify(warnLines)})`
        );

        // The RED discriminator: 30 minutes later the OLD identical 10-min
        // retry cooldown has expired (id re-queues, re-fetch forever); the
        // negative park must still hold.
        const realNow = Date.now;
        try {
          Date.now = () => realNow() + 30 * 60 * 1000;
          assert.equal(
            queue.queueMissingMembers(() => null, String(cid), ["gone-user"]),
            0,
            "30 min later the 24h park still holds (old code: 10-min retry re-queued)"
          );
        } finally {
          Date.now = realNow;
        }
      } finally {
        cacheSeam.communityClient = origClient;
      }
    } finally {
      loaded.cleanup?.();
    }
  });
});

// ── #905 item 4 (audit r4 F10d): the tick is a GATE, not a metronome ───────
// A drain awaits up to 60 SEQUENTIAL fetches (429 backoff parks discord.js);
// a drain slower than the 2 s tick used to start OVERLAPPING drains, each
// enforcing the fetch budget on its own counter — the documented "≤60 ids
// per tick" became k×60 concurrent fetches. Pin: while one drain is in
// flight, later ticks are skipped entirely; after the queue empties, a
// fresh enqueue re-arms the (possibly self-stopped) timer and still drains.

test("#905: a slow drain never overlaps; the ticker re-arms after idle", async (t) => {
  queue.stopMemberFetchQueue();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const settle = async () => {
    for (let i = 0; i < 25; i += 1) await new Promise((r) => setImmediate(r));
  };

  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const { client, calls } = makeClient(async (u) => {
    if (calls.length === 1) await firstGate; // drain #1 parks on id 501
    return okMember(u);
  });
  const get = () => client;

  try {
    queue.queueMissingMembers(get, GUILD, ["501", "502"]);
    t.mock.timers.tick(2000); // tick 1: drain #1 starts, fetches 501, parks
    await settle();
    assert.equal(calls.length, 1, "drain #1 in flight, parked mid-fetch");

    t.mock.timers.tick(2000 * 5); // five more ticks WHILE drain #1 is parked
    await settle();
    assert.equal(
      calls.length,
      1,
      "#905: overlapping drains are skipped (old code: drain #2 grabbed 502 immediately)"
    );

    releaseFirst();
    await settle();
    assert.equal(calls.length, 2, "drain #1 continued to 502 within its OWN budget");

    // Queue is now empty — the timer may have stopped itself. A new
    // enqueue must still drain on the next tick (re-arm law).
    queue.queueMissingMembers(get, GUILD, ["503"]);
    t.mock.timers.tick(2000);
    await settle();
    assert.equal(calls.length, 3, "re-armed after idle: fresh ids still drain");
  } finally {
    t.mock.timers.reset();
    queue.stopMemberFetchQueue();
  }
});
