/**
 * #462 (H1-3): src/core/outbound.js is the ONE supervisor → outbound/
 * client resolution the tickers use. Six drifted copies (plus three of
 * resolveDiscordClient) each carried an unreachable "pre-PR 7 raw client"
 * leg; boot builds exactly one supervisor shape and every ticker receives
 * it. The resolution contract:
 *
 *  - null supervisor → null (fluxer-less / not-yet-booted tolerance);
 *  - supervisor → routed through clientForCommunity / supervisor.discord,
 *    a throwing clientForCommunity logs with the FEATURE label and
 *    returns null (the tickers keep limping, never crashing);
 *  - a non-supervisor object (the dead-leg shape) → THROWS naming the
 *    stale call site — silence is what let six copies rot.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { resolveOutbound, resolveDiscordClient } = require("../src/core/outbound");

describe("core/outbound — the single supervisor resolver (#462)", () => {
  it("null supervisor is a tolerated no-op for both resolvers", () => {
    assert.equal(resolveOutbound(null, 7), null);
    assert.equal(resolveDiscordClient(null), null);
    assert.equal(resolveOutbound(undefined, 7, { label: "x" }), null);
    assert.equal(resolveDiscordClient(undefined, { label: "x" }), null);
  });

  it("a supervisor routes per community through clientForCommunity", () => {
    const asks = [];
    const ob = { name: "ob" };
    const supervisor = {
      discord: { id: "bot" },
      clientForCommunity: (cid) => {
        asks.push(cid);
        return cid === 42 ? ob : null;
      },
    };
    assert.equal(resolveOutbound(supervisor, 42), ob);
    assert.equal(resolveOutbound(supervisor, 43), null, "?? null: unknown community stays null");
    assert.deepEqual(asks, [42, 43]);
    assert.equal(resolveDiscordClient(supervisor), supervisor.discord);
  });

  it("a Discord-less supervisor answers a null client, not a crash", () => {
    const supervisor = { discord: null, clientForCommunity: () => null };
    assert.equal(resolveDiscordClient(supervisor), null);
  });

  it("a throwing clientForCommunity logs with the FEATURE label and returns null", () => {
    const supervisor = {
      clientForCommunity: () => {
        throw new Error("socket gone");
      },
    };
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.map(String).join(" "));
    try {
      assert.equal(resolveOutbound(supervisor, 9, { label: "voiceTicker" }), null);
    } finally {
      console.error = orig;
    }
    assert.deepEqual(lines, ["[voiceTicker] clientForCommunity(9) threw: socket gone"]);
  });

  it("a raw/foreign object THROWS naming the stale call site — the dead leg stays dead", () => {
    // The pre-#462 shapes: the raw discord client duck ({guilds}) and an
    // OutboundClient passed as the supervisor ({sendChannel}).
    for (const stale of [{ guilds: new Map() }, { sendChannel: () => {} }]) {
      assert.throws(() => resolveOutbound(stale, 1, { label: "decay" }), (err) => {
        assert.match(err.message, /^\[decay\] resolveOutbound: expected the PR 7 supervisor/);
        assert.match(err.message, /#462/);
        return true;
      });
      assert.throws(() => resolveDiscordClient(stale, { label: "warnings" }), /resolveDiscordClient: expected the PR 7 supervisor/);
    }
  });
});

// ---------------------------------------------------------------------------
// #837 (B2-6): createSingleClientSupervisor — the ONLY legal forgery of the
// supervisor shape for web-mounted webhook paths (Twitch EventSub). The
// non-supervisor guard used to be satisfied by any hand-built object with
// the key; the factory keeps the contract honest instead.
// ---------------------------------------------------------------------------
describe("core/outbound — createSingleClientSupervisor (#837 B2-6)", () => {
  const { createSingleClientSupervisor } = require("../src/core/outbound");

  it("exposes the live client as .discord and tolerates a resolve with a real communityId", () => {
    // Stub the lazily-required platform module: the factory must route
    // through getDiscordOutbound WITHOUT this test loading the real
    // Discord/db stack (this file is db-free by contract).
    const modId = require.resolve("../src/platform/discord/outbound");
    const marker = { __stubOutbound: true };
    const real = require.cache[modId];
    require.cache[modId] = {
      id: modId,
      filename: modId,
      loaded: true,
      exports: { getDiscordOutbound: (client) => (client.__seen = marker, marker) },
    };
    try {
      const client = { __fake: true };
      const supervisor = createSingleClientSupervisor(client);
      assert.equal(supervisor.discord, client, ".discord IS the live client (resolveDiscordClient leg)");
      assert.equal(supervisor.clientForCommunity(42), marker, "a real communityId resolves the outbound");
      assert.equal(resolveOutbound(supervisor, 42), marker, "the factory satisfies resolveOutbound end-to-end");
      assert.equal(resolveOutbound(supervisor, 99), marker, "single client serves every community BY CONSTRUCTION (documented single-app contract)");
    } finally {
      if (real) require.cache[modId] = real;
      else delete require.cache[modId];
    }
  });

  it("ASSERTS a real communityId — an argument-less resolve is the routing bug the guard exists to catch", () => {
    const supervisor = createSingleClientSupervisor({ __fake: true });
    for (const bad of [undefined, null, ""]) {
      assert.throws(
        () => supervisor.clientForCommunity(bad),
        (err) =>
          /clientForCommunity requires a real communityId/.test(err.message) &&
          /routing bug/.test(err.message),
        `communityId=${JSON.stringify(bad)} must throw, never silently resolve`,
      );
    }
  });

  it("the factory's output trips the non-supervisor guard's THROW for stale raw-client callers (shape parity)", () => {
    // resolveDiscordClient on the factory sees supervisor.discord — the
    // webhook path gets the SAME client back it handed in.
    const client = { __fake: true };
    assert.equal(resolveDiscordClient(createSingleClientSupervisor(client)), client);
  });
});
