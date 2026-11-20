/**
 * #400 (B2-8): the signup-option swap is ATOMIC. The old feature-layer loop
 * deleted every option row one committed DELETE at a time, then recreated —
 * so a failure mid-swap stranded a published event with zero options while
 * its Discord message kept pointing at dead option ids. The cap lived in
 * check-then-act land too. Everything now runs inside one repo transaction:
 * failure = the previous set (ids AND signups) survives untouched.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb, communityKey } = require("./helpers/env");

describe("event option replacement atomicity (#400/B2-8)", () => {
  /** @type {object} */
  let api;
  /** @type {() => void} */
  let cleanup;
  let CID = null;
  let options;

  before(() => {
    const loaded = loadDb();
    api = loaded.api;
    cleanup = loaded.cleanup;
    CID = communityKey("740000000000000001");
    options = require("../src/features/events/options");
  });

  after(() => cleanup?.());

  function seedEvent(labels) {
    const created = api.createEvent({
      communityId: CID,
      creatorId: "u-400",
      title: "Atomic Swap Night",
      status: "posted",
      startAt: Date.now() + 3_600_000,
      options: labels.map((label) => ({ label })),
    });
    assert.ok(created.ok, created.error);
    return created.event;
  }

  it("replaceOptions swaps every row with positions 1..n and reports the list", () => {
    const ev = seedEvent(["Old A", "Old B"]);
    const res = options.replaceOptions(ev.id, [
      { label: "New X" },
      { label: "New Y", capacity: 5 },
      { label: "New Z" },
    ]);
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(
      res.options.map((o) => [o.label, o.position]),
      [
        ["New X", 1],
        ["New Y", 2],
        ["New Z", 3],
      ],
    );
  });

  it("a failed insert ROLLS BACK the deletes — options and signups survive (#400)", () => {
    const ev = seedEvent(["Keep 1", "Keep 2"]);
    const before = api.listEventOptions(ev.id);
    assert.equal(before.length, 2);
    const signup = api.applyEventSignupChoice({
      eventId: ev.id,
      optionId: before[0].id,
      userId: "u-signup-400",
    });
    assert.ok(signup?.ok !== false, `signup seed failed: ${signup?.error}`);
    assert.ok(api.listEventSignups(ev.id, {}).length >= 1, "signup seeded");

    // #839 (D1-7): the FEATURE path now refuses any swap while signups
    // exist, so the atomicity law is pinned at the repo boundary the
    // feature wraps. Number(Symbol) throws at the SECOND insert — after
    // the deletes ran (inside the txn, invisible until commit).
    const boom = { label: "boom", capacity: Symbol("no-coercion") };
    const failed = api.replaceEventOptions(ev.id, [{ label: "Fresh" }, boom]);
    assert.equal(failed.ok, false, "the failed swap honestly reports the cause");
    assert.match(String(failed.error), /database error/);

    const after = api.listEventOptions(ev.id);
    assert.deepEqual(
      after.map((o) => o.id),
      before.map((o) => o.id),
      "the deletes ROLLED BACK — ids survive (pre-#400: zero options, dead buttons)",
    );
    assert.ok(
      api.listEventSignups(ev.id, {}).length >= 1,
      "the signup rows survived the failed swap too",
    );
  });

  it("the cap is enforced INSIDE the swap; a refusal changes nothing", () => {
    const ev = seedEvent(["One"]);
    const specs = Array.from({ length: 11 }, (_, i) => ({ label: `opt ${i}` }));
    const res = options.replaceOptions(ev.id, specs);
    assert.equal(res.ok, false);
    assert.match(res.error, /At most 10 options/);
    assert.equal(api.listEventOptions(ev.id).length, 1, "a cap refusal left the rows untouched");
  });

  it("signups exist + count changes → the manual-path refusal still holds the gate", () => {
    const ev = seedEvent(["A", "B"]);
    const [a] = api.listEventOptions(ev.id);
    api.applyEventSignupChoice({ eventId: ev.id, optionId: a.id, userId: "u-401" });
    const res = options.replaceOptions(ev.id, [{ label: "solo" }]);
    assert.equal(res.ok, false);
    assert.match(res.error, /one at a time/);
    assert.equal(api.listEventOptions(ev.id).length, 2, "gate refusal changed nothing");
  });

  it("#839 (D1-7): an EQUAL-count swap with signups is refused too — the old exemption deleted every RSVP", () => {
    const ev = seedEvent(["A", "B"]);
    const [a] = api.listEventOptions(ev.id);
    api.applyEventSignupChoice({ eventId: ev.id, optionId: a.id, userId: "u-eq" });

    // Exactly the preset-apply shape: same number of options, different
    // labels. Pre-fix this slipped the guard and the delete+reinsert
    // cascade took the signup with it.
    const res = options.replaceOptions(ev.id, [{ label: "X" }, { label: "Y" }]);
    assert.equal(res.ok, false, "equal counts no longer bless the swap");
    assert.match(res.error, /one at a time/);
    assert.deepEqual(
      api.listEventOptions(ev.id).map((o) => o.label),
      ["A", "B"],
      "the options survived…",
    );
    assert.ok(
      api.listEventSignups(ev.id, {}).some((r) => r.user_id === "u-eq"),
      "…and so did the RSVP — refusal means ZERO writes",
    );
  });

  it("feature wrap still reports the repo cause when a swap FAILS mid-way (no signups involved)", () => {
    const ev = seedEvent(["A"]);
    const boom = { label: "boom", capacity: Symbol("no-coercion") };
    const res = options.replaceOptions(ev.id, [{ label: "Fresh" }, boom]);
    assert.equal(res.ok, false);
    assert.match(res.error, /database error/, "the specific cause rides the reply (facade-wrapped throw)");
    assert.deepEqual(api.listEventOptions(ev.id).map((o) => o.label), ["A"]);
  });

  it("repo cap: replaceEventOptions alone refuses >MAX with zero writes", () => {
    const ev = seedEvent(["Only"]);
    const res = api.replaceEventOptions(
      ev.id,
      Array.from({ length: 12 }, (_, i) => ({ label: `x${i}` })),
    );
    assert.equal(res.ok, false);
    assert.equal(api.listEventOptions(ev.id).length, 1);
  });
});
