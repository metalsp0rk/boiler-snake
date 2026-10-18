/**
 * #473 (B2-11): the feature-layer JS re-implementation of the signup-count
 * aggregate is GONE. options.js used to fetch every signup row
 * (unbounded listEventSignups) and count signed_up/waitlisted in JS —
 * a second implementation of repo.countEventSignups' GROUP BY with the
 * same output shape. Divergent parallel helpers are exactly how B2-2's
 * key mismatch stayed invisible; hot render paths paid the row churn.
 *
 * Pins:
 *  1. renderOptionTable still renders exact per-option counts (behavior);
 *  2. the render path never touches listEventSignups again — a poisoned
 *     row-fetch must not break the table (RED on the old code: it counted
 *     over exactly that fetch).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb, communityKey } = require("./helpers/env");

describe("event option tables count via the SQL aggregate (#473/B2-11)", () => {
  let api;
  let cleanup;
  let CID = null;
  let options;
  let repo;

  before(() => {
    const loaded = loadDb();
    api = loaded.api;
    cleanup = loaded.cleanup;
    CID = communityKey("740000000000000002");
    options = require("../src/features/events/options");
    repo = require("../src/db/repositories/events");
  });

  after(() => cleanup?.());

  /** Event with opt1 cap 1 (u1 signed_up, u2 waitlisted) + opt2 open (u3). */
  function seeded() {
    const created = api.createEvent({
      communityId: CID,
      creatorId: "u-473",
      title: "Counts Night",
      status: "posted",
      startAt: Date.now() + 3_600_000,
      options: [{ label: "Full", capacity: 1 }, { label: "Open" }],
    });
    assert.ok(created.ok, created.error);
    const [full, open] = api.listEventOptions(created.event.id);
    assert.equal(
      api.applyEventSignupChoice({ eventId: created.event.id, optionId: full.id, userId: "u1" })
        .result,
      "signed_up"
    );
    assert.equal(
      api.applyEventSignupChoice({ eventId: created.event.id, optionId: full.id, userId: "u2" })
        .result,
      "waitlisted",
      "capacity 1 forces the waitlist lane"
    );
    api.applyEventSignupChoice({ eventId: created.event.id, optionId: open.id, userId: "u3" });
    return { eventId: created.event.id, full, open };
  }

  it("renderOptionTable shows exact signedUp/capacity/waitlist per option", () => {
    const { eventId, full, open } = seeded();
    const text = options.renderOptionTable(eventId);
    assert.ok(
      text.includes(". Full** — 1/1 (waitlist 1)"),
      `full option line shows 1/1 + waitlist (got: ${text})`
    );
    assert.ok(text.includes(". Open** — 1 ·"), "open option shows its single attendee");
    assert.ok(full.id > 0 && open.id > 0);
  });

  it("the render path never fetches signup ROWS — only the aggregate", () => {
    const { eventId } = seeded();
    const orig = repo.listEventSignups;
    repo.listEventSignups = () => {
      throw new Error("MUTATION: row-fetch on the render path (pre-#473 shape)");
    };
    try {
      const text = options.renderOptionTable(eventId);
      assert.ok(text.includes("(waitlist 1)"), "table renders from the SQL aggregate alone");
    } finally {
      repo.listEventSignups = orig;
    }
  });

  it("countsFor is gone — the second implementation cannot come back", () => {
    assert.equal(
      options.countsFor,
      undefined,
      "the JS re-aggregate was deleted, not merely unused",
    );
  });
});
