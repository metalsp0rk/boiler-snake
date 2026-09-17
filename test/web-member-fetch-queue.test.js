/**
 * §8.15 lazy member-fetch queue (option C): cache misses render as ids NOW
 * and get resolved OFF the request path, bounded + rate-cooled, so later
 * renders show names. No HTTP here — pure service + resolve-seam seams.
 */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

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
});
