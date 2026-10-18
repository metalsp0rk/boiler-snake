/**
 * #344 — the role-whitelist contract: the repo's toJsonArray() stringifies
 * ARRAYS and maps EVERYTHING ELSE (including pre-stringified JSON) to "[]".
 * Three handler arms and the preset path used to hand it `JSON.stringify(…)`
 * strings, so the gate silently flattened to "open" while the replies
 * promised restriction — and renderOptionTable printed "role-gated" on every
 * row because a parsed [] is truthy. This suite pins the whole contract:
 * the repo normalizer, the handler-level array flow (via the repo calls the
 * handlers now make), the table gate, and the preset round-trip.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb, communityKey } = require("./helpers/env");

describe("event role_whitelist array contract (#344)", () => {
  /** @type {object} */
  let api;
  /** @type {() => void} */
  let cleanup;
  let CID = null;
  let options;
  let presets;

  before(() => {
    const loaded = loadDb();
    api = loaded.api;
    cleanup = loaded.cleanup;
    CID = communityKey("740000000000000009");
    options = require("../src/features/events/options");
    presets = require("../src/features/events/presets");
  });

  after(() => cleanup?.());

  function seedEvent(title, opts = [{ label: "Seat" }]) {
    const created = api.createEvent({
      communityId: CID,
      creatorId: "u-344",
      title,
      status: "posted",
      startAt: Date.now() + 3_600_000,
      options: opts,
    });
    assert.ok(created.ok, created.error);
    return created.event;
  }

  const rawWhitelist = (eventId) => api.getEventById(eventId).role_whitelist;

  it("updateEvent round-trips a REAL array (the handler fix's repo side)", () => {
    const ev = seedEvent("Array Contract");
    const res = api.updateEvent(ev.id, { role_whitelist: ["111222333444555666"] });
    assert.equal(res.ok, true, res.error);
    assert.equal(rawWhitelist(ev.id), '["111222333444555666"]');
    api.updateEvent(ev.id, { role_whitelist: [] });
    assert.equal(rawWhitelist(ev.id), "[]", "an empty ARRAY is the honest clear");
  });

  it("a pre-stringified whitelist still flattens to [] — WHY the handlers must pass arrays", () => {
    // This is the repo's documented normalizer contract (toJsonArray maps
    // non-arrays to "[]"): the bug was never here, it was callers sending
    // strings. Pinned so nobody "fixes" the repo by accepting strings and
    // re-opens the silent-gate class from the other side.
    const ev = seedEvent("String Contract");
    api.updateEvent(ev.id, { role_whitelist: JSON.stringify(["111222333444555666"]) });
    assert.equal(
      rawWhitelist(ev.id),
      "[]",
      "toJsonArray refuses to guess — strings carry NO roles, exactly what flattened #344's gate",
    );
  });

  it("option-level whitelist round-trips arrays through create + update", () => {
    const ev = seedEvent("Option Gates");
    const created = api.createEventOption(ev.id, {
      label: "VIP",
      role_whitelist: ["999888777666555444"],
    });
    assert.equal(created.ok, true, created.error);
    assert.deepEqual(created.option.role_whitelist, ["999888777666555444"]);

    const upd = api.updateEventOption(created.option.id, { role_whitelist: [] });
    assert.deepEqual(upd.option.role_whitelist, [], "clear via array");
    const back = api.updateEventOption(created.option.id, {
      role_whitelist: ["999888777666555444", "555444333222111000"],
    });
    assert.deepEqual(back.option.role_whitelist, ["999888777666555444", "555444333222111000"]);
  });

  it("renderOptionTable gates on LENGTH — an open option is not 'role-gated'", () => {
    const ev = seedEvent("Table Honesty", [
      { label: "Open" },
      { label: "Locked", role_whitelist: ["444333222111000999"] },
    ]);
    const table = options.renderOptionTable(ev.id);
    const openRow = table.split("\n").find((l) => l.includes("Open**"));
    const lockedRow = table.split("\n").find((l) => l.includes("Locked**"));
    assert.ok(openRow && lockedRow, `both rows render:\n${table}`);
    assert.ok(
      !openRow.includes("role-gated"),
      "#344: an EMPTY parsed whitelist used to be truthy — every row claimed gated",
    );
    assert.ok(lockedRow.includes("role-gated"), "a real whitelist still advertises");
  });

  it("preset save→apply PRESERVES option whitelists (the toSpecs string-bug dies here)", () => {
    const source = seedEvent("Preset Source", [
      { label: "Door", role_whitelist: ["777666555444333222"] },
      { label: "Patio" },
    ]);
    const saved = presets.save(CID, "gated", source.id, "u-344");
    assert.ok(saved.ok !== false, JSON.stringify(saved));

    const target = seedEvent("Preset Target", [{ label: "placeholder" }]);
    const applied = presets.applyToEvent(CID, "gated", target.id);
    assert.equal(applied.ok, true, applied.error);

    const rows = api.listEventOptions(target.id);
    const door = rows.find((o) => o.label === "Door");
    const patio = rows.find((o) => o.label === "Patio");
    assert.ok(door && patio, "both options landed");
    assert.deepEqual(
      door.role_whitelist,
      ["777666555444333222"],
      "#344: toSpecs used to JSON.stringify the array — toJsonArray flattened it and the applied gate vanished",
    );
    assert.deepEqual(patio.role_whitelist, []);
  });

  it("toSpecs normalizes legacy stored strings and junk to real arrays", () => {
    assert.deepEqual(
      presets.toSpecs([{ label: "A", role_whitelist: '["123456789012345678"]' }])[0]
        .role_whitelist,
      ["123456789012345678"],
      "a legacy JSON STRING blob parses into the array the repo demands",
    );
    assert.deepEqual(
      presets.toSpecs([{ label: "B", role_whitelist: "not json" }])[0].role_whitelist,
      [],
      "junk carries no whitelist — degrades to open, never to a crash",
    );
    assert.deepEqual(
      presets.toSpecs([{ label: "C" }])[0].role_whitelist,
      [],
      "absent means open",
    );
  });
});
