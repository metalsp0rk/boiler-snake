/**
 * #826 — waitlist OFF must survive every copy path.
 *
 * duplicateEvent (and the series expander) map `listEventOptions` rows
 * STRAIGHT back into createEvent/createEventOption. Those rows carry the
 * stored INTEGERs (0/1), and the repo's old `v !== false` default-ON test
 * made a stored 0 truthy — an organizer's explicitly disabled waitlist
 * flipped ON in every duplicate/occurrence, silently inverting capacity
 * semantics (full options parked members in a growing waitlist instead of
 * refusing them). Presets already normalized ints; slash-create passes
 * booleans — the bug lived exactly where raw DB ints re-enter.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb, communityKey } = require("./helpers/env");

describe("event option waitlist copy fidelity (#826)", () => {
  /** @type {object} */
  let api;
  /** @type {() => void} */
  let cleanup;
  let CID = null;
  let service = null;

  before(() => {
    const loaded = loadDb();
    api = loaded.api;
    cleanup = loaded.cleanup;
    CID = communityKey("782600000000000001");
    // after loadDb so its top-level require of ../../db binds this DB
    service = require("../src/features/events/service");
  });

  after(() => cleanup?.());

  function seedEvent(label, option) {
    const created = api.createEvent({
      communityId: CID,
      creatorId: "u-826",
      title: "Hard Cap Night",
      status: "posted",
      startAt: Date.now() + 3_600_000,
      options: [{ label, ...option }],
    });
    assert.ok(created.ok, created.error);
    return created.event;
  }

  const waitlistOf = (eventId) => api.listEventOptions(eventId).map((o) => o.waitlist_on);

  it("a stored 0 round-trips through createEvent as 0 (the `0 !== false` flip is dead)", () => {
    const ev = seedEvent("Hard cap", { capacity: 2, waitlist_on: false });
    assert.deepEqual(waitlistOf(ev.id), [0]);

    // The exact duplicateEvent mapping: raw stored rows → createEvent again.
    const raw = api.listEventOptions(ev.id).map((o) => ({
      label: o.label,
      emoji: o.emoji,
      position: o.position,
      capacity: o.capacity,
      waitlist_on: o.waitlist_on, // INTEGER 0 — the bug's trigger
      reminders_on: o.reminders_on,
      role_whitelist: o.role_whitelist,
    }));
    const again = api.createEvent({
      communityId: CID,
      creatorId: "u-826",
      title: "Re-copy",
      startAt: Date.now() + 7_200_000,
      options: raw,
    });
    assert.ok(again.ok, again.error);
    assert.deepEqual(waitlistOf(again.event.id), [0], "raw 0 must NOT flip back to 1");
  });

  it("duplicateEvent with the waitlist OFF copies the waitlist OFF", async () => {
    const ev = seedEvent("Two seats, no waitlist", { capacity: 2, waitlist_on: false });
    const dup = await service.duplicateEvent(null, ev, "u-copier");
    assert.equal(dup.ok, true, dup.error);
    assert.deepEqual(
      waitlistOf(dup.event.id),
      [0],
      "#826: the duplicate silently re-enabled a disabled waitlist",
    );

    // The ON case must stay ON through the copy (the normalizer only fixes 0).
    const ev2 = seedEvent("Waitlist please", { capacity: 2, waitlist_on: true });
    const dup2 = await service.duplicateEvent(null, ev2, "u-copier");
    assert.equal(dup2.ok, true, dup2.error);
    assert.deepEqual(waitlistOf(dup2.event.id), [1]);
  });

  it("createEventOption and replaceEventOptions read raw stored ints too", () => {
    const ev = seedEvent("Base", { capacity: 1, waitlist_on: false });

    const added = api.createEventOption(ev.id, {
      label: "Extra",
      capacity: 4,
      waitlist_on: api.listEventOptions(ev.id)[0].waitlist_on, // raw 0
    });
    assert.equal(added.ok, true, added.error);
    assert.equal(added.option.waitlist_on, 0, "raw 0 via createEventOption must stay 0");

    // Web edit round-trip shape: list rows straight back into replace.
    const rows = api.listEventOptions(ev.id).map((o) => ({
      label: o.label,
      capacity: o.capacity,
      waitlist_on: o.waitlist_on,
      reminders_on: o.reminders_on,
      role_whitelist: o.role_whitelist,
    }));
    const replaced = api.replaceEventOptions(ev.id, rows);
    assert.equal(replaced.ok, true, replaced.error);
    assert.deepEqual(
      api.listEventOptions(ev.id).map((o) => [o.label, o.waitlist_on]),
      [
        ["Base", 0],
        ["Extra", 0],
      ],
      "replaceEventOptions must not re-enable either raw-0 row",
    );
  });

  it("unset waitlist still defaults ON (documented default preserved)", () => {
    const ev = seedEvent("Default on", { capacity: 3 });
    assert.deepEqual(waitlistOf(ev.id), [1]);
  });
});
