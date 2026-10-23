/**
 * RSS ticker registration unit (issue #305, subtask 08).
 *
 * Pins the scheduler surface ONLY: the aligned 5-minute job name,
 * interval, and boot-hook idempotency. The tick BODY is covered by the
 * poller units (rss-poller.test.js) and the integration suite — firing
 * it here would reach for the real db facade, which this file must not.
 */
const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const scheduler = require("../src/core/scheduler");
const { startRssTicker, RSS_TICK_INTERVAL_MS } = require("../src/features/rss/ticker");
const feature = require("../src/features/rss");

describe("rss ticker registration (#305)", () => {
  afterEach(() => {
    scheduler.stop("rss");
  });

  it("registers the aligned 5-minute rss job", () => {
    startRssTicker(null);
    const job = scheduler.getJob("rss");
    assert.ok(job, "rss job registered");
    assert.equal(RSS_TICK_INTERVAL_MS, 5 * 60_000);
    const snap = scheduler.snapshot().find((s) => s.name === "rss");
    assert.equal(snap.intervalMs, RSS_TICK_INTERVAL_MS);
  });

  it("boot hook is idempotent (re-register replaces, never stacks)", () => {
    startRssTicker(null);
    feature.start(null, undefined);
    feature.start(null, undefined);
    const rssJobs = scheduler.listNames().filter((n) => n === "rss");
    assert.equal(rssJobs.length, 1, "exactly one rss job");
  });

  it("feature module carries the load.js contract", () => {
    assert.equal(feature.name, "rss");
    assert.deepEqual(Object.keys(feature.handlers).sort(), ["rss", "setrss"]);
    assert.deepEqual(feature.handlerApi, { rss: "context", setrss: "context" });
    assert.equal(typeof feature.autocomplete.rss, "function");
    assert.equal(feature.commands.length, 2);
    assert.equal(typeof feature.start, "function");
  });
});
