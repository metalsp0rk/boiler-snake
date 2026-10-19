/**
 * #469 (E2-06): a finite connect budget must not be the END of reconnecting.
 *
 * The node configures retryAmount: 10 / retryDelay: 10s and manager.init()
 * runs EXACTLY once at boot. A Lavalink hiccup longer than ~100s (or a bot
 * that boots while Lavalink is down) exhausted the budget, useable stayed
 * false, and every /play answered "not configured" until the bot PROCESS
 * restarted. The readiness heartbeat replaces that one-shot with a
 * permanent slow probe.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const music = require("../src/features/music/index");

const { reprobeLavalinkNode, startLavalinkReprobe, stopLavalinkReprobe } = music;

after(() => stopLavalinkReprobe());

function fakeManager({ useable = false, node = { connected: false, connecting: false } } = {}) {
  const nodes = new Map([["main", node]]);
  return { useable, nodeManager: { nodes }, _node: node };
}

describe("#469 (E2-06): the readiness heartbeat", () => {
  it("a ready node resets the streak and needs nothing", async () => {
    const state = { streak: 5 };
    const m = fakeManager({ useable: true });
    const verdict = await reprobeLavalinkNode({}, m, state);
    assert.equal(verdict, "ready");
    assert.equal(state.streak, 0);
  });

  it("the first not-ready tick WAITS (lavalink-client owns its own retries)", async () => {
    const state = { streak: 0 };
    const m = fakeManager();
    let connects = 0;
    m._node.connect = async () => {
      connects += 1;
    };
    const verdict = await reprobeLavalinkNode({}, m, state);
    assert.equal(verdict, "waiting");
    assert.equal(connects, 0, "one blip must not pile network onto the client's own loop");
  });

  it("a sustained outage re-connects the node (the budget-exhaustion fix)", async () => {
    const state = { streak: 0 };
    const m = fakeManager();
    let connects = 0;
    m._node.connect = async () => {
      connects += 1;
      m.useable = true; // the reconnect takes
    };

    assert.equal(await reprobeLavalinkNode({}, m, state), "waiting");
    assert.equal(await reprobeLavalinkNode({}, m, state), "attempted", "second sustained tick connects");
    assert.equal(connects, 1);
    assert.equal(await reprobeLavalinkNode({}, m, state), "ready", "back online");
  });

  it("a mid-connect state is observed, not duplicated", async () => {
    const state = { streak: 9 };
    const m = fakeManager({ node: { connected: false, connecting: true } });
    const verdict = await reprobeLavalinkNode({}, m, state);
    assert.equal(verdict, "connecting", "no second connect() onto an in-flight one");
  });

  it("no node at all degrades to a named verdict, never a throw", async () => {
    const state = { streak: 9 };
    const verdict = await reprobeLavalinkNode({}, { useable: false, nodeManager: { nodes: new Map() } }, state);
    assert.equal(verdict, "no_node");
  });

  it("a rejected connect is logged, not fatal", async () => {
    const state = { streak: 9 };
    const m = fakeManager();
    m._node.connect = async () => {
      throw new Error("ECONNREFUSED");
    };
    const verdict = await reprobeLavalinkNode({}, m, state);
    assert.equal(verdict, "failed");
  });

  it("the timer path arms, ticks, and disarms (stop seam)", async () => {
    let connects = 0;
    const m = fakeManager();
    m._node.connect = async () => {
      connects += 1;
      m.useable = true;
    };
    startLavalinkReprobe({}, m, { tickMs: 5 });
    const deadline = Date.now() + 1000;
    while (connects === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    stopLavalinkReprobe();
    assert.equal(connects, 1, "the shipped heartbeat reconnects without any test driver");
  });
});
