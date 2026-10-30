const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// Write-boundary guard (companion to migration 072 + the view hardening):
// event instant columns must persist as finite epoch-ms. A TEXT value in an
// INTEGER-affinity column survives AS text and poisons the calendar render.
const { loadDb, communityKey } = require("./helpers/env");
const { cleanup: cleanupTempDb } = loadDb();
after(cleanupTempDb);

const db = require("../src/db");

const CID = communityKey("720000000000099001");
const GUILD = "720000000000099001";

function seedEvent() {
  const out = db.createEvent({
    communityId: CID,
    creatorId: "830000000000099002",
    title: "Boundary night",
    status: "draft",
    startAt: Date.UTC(2026, 5, 6, 20, 0, 0),
    channelId: "710000000000099003",
  });
  assert.ok(out.ok, out.error);
  return out.event;
}

describe("events repository — instant columns reject calendar-poisoning junk", () => {
  it("createEvent refuses junk startAt/postAt with a specific error", () => {
    const junkStart = db.createEvent({
      communityId: CID,
      creatorId: "1",
      title: "x",
      startAt: "2026-06-06 20:00",
    });
    assert.equal(junkStart.ok, false);
    assert.match(junkStart.error, /start/i);

    const junkPost = db.createEvent({
      communityId: CID,
      creatorId: "1",
      title: "x",
      startAt: Date.now(),
      postAt: "NaN",
    });
    assert.equal(junkPost.ok, false);
    assert.match(junkPost.error, /post_at must be a finite epoch-ms instant/);
  });

  it("updateEvent refuses junk instants and heals numeric strings", () => {
    const ev = seedEvent();

    for (const bad of ["NaN", "2026-06-06 20:00", "", {}, true]) {
      const out = db.updateEvent(ev.id, { start_at: bad });
      assert.equal(out.ok, false, `start_at ${JSON.stringify(bad)} rejected`);
      assert.match(out.error, /start_at must be/);
    }
    // The row still carries its original integer instant.
    assert.equal(db.getEventForCommunity(ev.id, CID).start_at, ev.start_at);

    // Numeric strings coerce exactly like INTEGER affinity would.
    const coerced = db.updateEvent(ev.id, { post_at: "1780992000000" });
    assert.ok(coerced.ok, coerced.error);
    const row = db.getEventForCommunity(ev.id, CID);
    assert.equal(typeof row.post_at, "number");
    assert.equal(row.post_at, 1780992000000);

    // null stays the legal "clear" signal on nullable instants.
    assert.ok(db.updateEvent(ev.id, { post_at: null }).ok);
    assert.equal(db.getEventForCommunity(ev.id, CID).post_at, null);
  });

  it("every persisted instant stays integer-or-NULL through the guard", () => {
    const ev = seedEvent();
    db.updateEvent(ev.id, {
      end_at: Date.UTC(2026, 5, 6, 22, 0),
      cutoff_at: null,
    });
    // The facade's rows are typed values — the guard means the calendar
    // renderer can never receive a TEXT instant from a guarded write.
    for (const r of db.listEvents(CID, { limit: 10 })) {
      for (const col of ["start_at", "end_at", "post_at", "cutoff_at"]) {
        assert.ok(
          r[col] == null || typeof r[col] === "number",
          `${col} is number-or-null on row ${r.id}`,
        );
      }
    }
    assert.ok(ev.id > 0);
  });
});
