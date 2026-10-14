/**
 * Unit tests: posted event message embed layout (epic #218).
 *
 * Signup options render as INLINE embed fields — Discord lays inline fields
 * out three-per-row, so Yes/No/Maybe read as one column row of status
 * columns. Pins: column-per-option shape, count/waitlist/attendee value
 * blocks, empty-state field, overflow beyond the column cap, and meta last.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildEventMessage } = require("../src/features/events/ui");

const START = Date.UTC(2026, 9, 20, 19, 0, 0);

function embedFor(options, { counts = {}, settings = {}, event = {} } = {}) {
  const msg = buildEventMessage(
    { id: 42, title: "Game Night", start_at: START, creator_id: "u1", ...event },
    { options, counts, settings, nameOf: (id) => `@${id}` }
  );
  return msg.embeds[0].toJSON().fields;
}

const DEFAULT_OPTIONS = [
  { id: 1, label: "Yes", emoji: "✅", capacity: 10, waitlist_on: 1, _attendees: ["a", "b", "c", "d"] },
  { id: 2, label: "No", emoji: "❌", capacity: 0, waitlist_on: 0, _attendees: ["e"] },
  { id: 3, label: "Maybe", emoji: "🤔", capacity: 0, waitlist_on: 0, _attendees: [] },
];

describe("event message signup columns", () => {
  it("renders one inline column per option between Where and meta", () => {
    const fields = embedFor(DEFAULT_OPTIONS, {
      counts: {
        1: { signedUp: 4, waitlisted: 2 },
        2: { signedUp: 1, waitlisted: 0 },
        3: { signedUp: 2, waitlisted: 0 },
      },
    });
    assert.deepEqual(
      fields.map((f) => [f.name, !!f.inline]),
      [
        ["📅 When", false],
        ["📍 Where", false],
        ["✅ Yes", true],
        ["❌ No", true],
        ["🤔 Maybe", true],
        ["ℹ️", false],
      ]
    );
    assert.equal(fields[2].value, "**4/10**\nwaitlist 2\n@a, @b, @c, @d");
    assert.equal(fields[3].value, "**1**\n@e");
    assert.equal(fields[4].value, "**2**");
    assert.match(fields[5].value, /Event `42`/);
  });

  it("attendee overflow reads +N and names cap at MAX_VISIBLE_NAMES", () => {
    const opts = [
      { id: 1, label: "Yes", emoji: "✅", capacity: 0, waitlist_on: 0, _attendees: ["1", "2", "3", "4", "5"] },
    ];
    const fields = embedFor(opts, { counts: { 1: { signedUp: 9, waitlisted: 0 } } });
    assert.equal(fields[2].value, "**9**\n@1, @2, @3, @4, @5 +4");
  });

  it("shows waitlist-ready for full-capacity options and respects show_attendees=0", () => {
    const opts = [
      { id: 1, label: "Yes", emoji: "✅", capacity: 5, waitlist_on: 1, _attendees: ["x", "y"] },
    ];
    const hidden = embedFor(opts, {
      counts: { 1: { signedUp: 2, waitlisted: 0 } },
      settings: { show_attendees: 0 },
    });
    assert.equal(hidden[2].value, "**2/5**\nwaitlist ready");
  });

  it("keeps the single Signups field for the empty state", () => {
    const fields = embedFor([]);
    assert.deepEqual(
      fields.map((f) => f.name),
      ["📅 When", "📍 Where", "🙋 Signups", "ℹ️"]
    );
    assert.match(fields[2].value, /No signup options yet/);
    assert.notEqual(fields[2].inline, true);
  });

  it("caps columns and notes overflow while meta stays last", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      label: `Opt ${i + 1}`,
      emoji: "",
      capacity: 0,
      waitlist_on: 0,
      _attendees: [],
    }));
    const fields = embedFor(many, {
      counts: Object.fromEntries(many.map((o) => [o.id, { signedUp: 0, waitlisted: 0 }])),
    });
    const optionFields = fields.filter((f) => f.inline);
    assert.equal(optionFields.length, 16); // 15 columns + overflow marker
    assert.match(optionFields[15].value, /5 more options/);
    assert.equal(fields[fields.length - 1].name, "ℹ️");
    assert.ok(fields.length <= 25, "stays within the embed field limit");
  });
});
