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
