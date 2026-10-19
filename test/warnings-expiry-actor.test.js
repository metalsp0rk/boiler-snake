/**
 * #469 (F2-9): auto-expiry writes NULL into voided_by, not the
 * non-snowflake string "system:expiry" — voided_by is an ACTOR-ID column,
 * and every `<@${voided_by}>` renderer turned the sentinel into a broken
 * mention in /warn info. The renderers now say "auto-expiry" for NULL and
 * for the legacy sentinel rows that predate the fix.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");
const { api, cleanup } = loadDb(); // CONTRACT: temp DB before any src/ require

const { runWarnExpiryTick } = require("../src/features/warnings/ticker");
const handlers = require("../src/features/warnings/handlers");

after(cleanup);

const GUILD = "930000000000000001";
const CID = communityKey(GUILD);

function seedExpiredWarning(userId) {
  // The facade hands back the full row.
  const warn = api.createWarning({
    communityId: CID,
    userId,
    issuerId: "830000000000000009",
    reason: "expired on purpose",
  });
  api.db
    .prepare("UPDATE warnings SET expires_at=? WHERE id=?")
    .run(Date.now() - 1000, warn.id);
  return warn;
}

describe("#469 (F2-9): the expiry ticker records an honest actor", () => {
  it("no client ⇒ voided_by is NULL — never the string pseudo-id", async () => {
    const warn = seedExpiredWarning("830000000000000021");

    // PR 7 supervisor shape (the raw/foreign object throws by design).
    const noClient = {
      discord: null,
      fluxer: new Map(),
      clientForCommunity: () => null,
    };
    await runWarnExpiryTick(noClient, { now: Date.now() });

    const row = api.db
      .prepare("SELECT voided_at, voided_by FROM warnings WHERE id=?")
      .get(warn.id);
    assert.ok(row.voided_at != null, "the warning did expire");
    assert.equal(
      row.voided_by,
      null,
      'old code wrote "system:expiry" into the actor-id column — <@system:expiry> is not a person',
    );
  });

  it("a live client still records ITS id", async () => {
    const warn = seedExpiredWarning("830000000000000022");
    const supervisor = {
      discord: { user: { id: "730000000000000001" } },
      fluxer: new Map(),
      clientForCommunity: () => null,
    };

    await runWarnExpiryTick(supervisor, { now: Date.now() });

    const row = api.db
      .prepare("SELECT voided_by FROM warnings WHERE id=?")
      .get(warn.id);
    assert.equal(row.voided_by, "730000000000000001");
  });
});

describe("#469 (F2-9): voidedByLabel — mentions for ids, honesty for the rest", () => {
  it("snowflake-shaped ⇒ mention", () => {
    assert.equal(handlers.voidedByLabel("800000000000000001"), "<@800000000000000001>");
  });

  it("NULL (auto-expiry) and the LEGACY sentinel both read 'auto-expiry'", () => {
    assert.equal(handlers.voidedByLabel(null), "auto-expiry");
    assert.equal(handlers.voidedByLabel(undefined), "auto-expiry");
    assert.equal(handlers.voidedByLabel("system:expiry"), "auto-expiry");
  });

  it("anything else renders as PLAIN TEXT — never a fake mention", () => {
    assert.equal(handlers.voidedByLabel("operator-note"), "operator-note");
  });
});
