"use strict";

/**
 * #917 item 1 (audit r4 F10a): `npm run register` must reach EVERY guild.
 * `client.guilds.fetch()` without a cursor is ONE `GET /users/@me/guilds`
 * page (server caps 200, vendored GuildManager does no loop) — a bot in
 * more guilds silently registered commands to page 1 and exited 0.
 * Pins: forward `after`-cursor paging, termination on short pages, and a
 * non-advancing cursor (mock/API ignoring `after`) never spins forever.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { fetchAllGuilds } = require("../src/commands/register");

function fakeApi(total) {
  const ids = Array.from({ length: total }, (_, i) => String(1000 + i));
  const calls = [];
  return {
    calls,
    client: {
      guilds: {
        fetch: async (opts = {}) => {
          calls.push(opts);
          const start = opts.after ? ids.indexOf(String(opts.after)) + 1 : 0;
          const limit = Number.isSafeInteger(opts.limit) ? opts.limit : 200;
          return new Map(
            ids
              .slice(start, start + limit)
              .map((id) => [id, { id, name: `guild-${id}` }])
          );
        },
      },
    },
  };
}

test("fetchAllGuilds pages past the 200-guild page cap with the after cursor", async () => {
  const api = fakeApi(450);
  const all = await fetchAllGuilds(api.client);
  assert.equal(all.size, 450, "every guild across three pages");
  assert.equal(api.calls.length, 3, "three page fetches");
  assert.deepEqual(
    api.calls.map((c) => c.after ?? null),
    [null, "1199", "1399"],
    "each page starts after the previous page's last id"
  );
  assert.ok(
    api.calls.every((c) => c.limit === 200),
    "pages ask for the server maximum"
  );
});

test("a short first page ends after ONE fetch (no trailing empty call)", async () => {
  const api = fakeApi(7);
  const all = await fetchAllGuilds(api.client);
  assert.equal(all.size, 7);
  assert.equal(api.calls.length, 1);
});

test("a cursor-ignoring API terminates instead of looping forever", async () => {
  // Every call returns the SAME full 200-guild page regardless of `after`
  // (a broken/alternate API shape): the pager must stop, not spin.
  const ids = Array.from({ length: 200 }, (_, i) => String(2000 + i));
  let calls = 0;
  const client = {
    guilds: {
      fetch: async () => {
        calls += 1;
        if (calls > 10) throw new Error("pager looped — non-advancing cursor not caught");
        return new Map(ids.map((id) => [id, { id, name: "same-page" }]));
      },
    },
  };
  const all = await fetchAllGuilds(client);
  assert.equal(all.size, 200);
  assert.equal(calls, 2, "second identical page ends the loop");
});

test("an empty community is an empty result, zero surprises", async () => {
  const api = fakeApi(0);
  const all = await fetchAllGuilds(api.client);
  assert.equal(all.size, 0);
  assert.equal(api.calls.length, 1);
});
