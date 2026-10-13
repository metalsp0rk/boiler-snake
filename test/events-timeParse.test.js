/**
 * Unit tests: /event time parsing (E3) and series math.
 * timeParse: relative/naive-zone/ISO handling — the confirmation-preview
 * doctrine means AMBIGUOUS inputs still resolve (never null silently), but
 * unparseable input must return a human-editable error.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseEventTime,
  parseDuration,
  parseCutoff,
  tzOffsetMs,
  wallClockParts,
  wallToUtc,
} = require("../src/features/events/timeParse");
const {
  nextOccurrence,
  countAllows,
  seriesShapeFromStart,
} = require("../src/features/events/recurrence");

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0); // Tue 2026-10-13 12:00Z

function opts(extra = {}) {
  return { timeZone: "UTC", nowMs: NOW, ...extra };
}

describe("timeParse.parseEventTime", () => {
  it("parses relative in-N formats", () => {
    assert.equal(parseEventTime("in 2h", opts()).atMs, NOW + 2 * 3600_000);
    assert.equal(parseEventTime("in 45m", opts()).atMs, NOW + 45 * 60_000);
    assert.equal(parseEventTime("in 3d", opts()).atMs, NOW + 3 * 86400_000);
  });

  it("parses bare relative shorthand (2h, 3d)", () => {
    assert.equal(parseEventTime("2h", opts()).atMs, NOW + 2 * 3600_000);
  });

  it("parses ISO with explicit Z", () => {
    const r = parseEventTime("2026-11-05T19:00Z", opts());
    assert.ok(r.ok);
    assert.equal(r.atMs, Date.UTC(2026, 10, 5, 19, 0, 0));
  });

  it("reads naive datetimes in the guild zone (E3)", () => {
    const r = parseEventTime("2026-11-05 19:00", opts({ timeZone: "America/New_York" }));
    assert.ok(r.ok);
    // Nov 5 2026 is EST (UTC-5) — 19:00 local = 00:00Z next day
    assert.equal(r.atMs, Date.UTC(2026, 10, 6, 0, 0, 0));
  });

  it("resolves 'tomorrow 7pm' in the guild zone, not UTC", () => {
    const r = parseEventTime("tomorrow 7pm", opts({ timeZone: "Europe/Berlin" }));
    assert.ok(r.ok);
    // tomorrow = Oct 14; Berlin is UTC+2 in October → 19:00 CEST = 17:00Z
    assert.equal(r.atMs, Date.UTC(2026, 9, 14, 17, 0, 0));
  });

  it("resolves bare weekday names to the NEXT such day", () => {
    const r = parseEventTime("fri 19:00", opts({ timeZone: "UTC" }));
    assert.ok(r.ok);
    assert.equal(r.atMs, Date.UTC(2026, 9, 16, 19, 0, 0)); // Tue→Fri
  });

  it("rejects an explicit 'today' time that already passed", () => {
    const r = parseEventTime("today 5am", opts({ timeZone: "UTC" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /already passed|tomorrow/i);
  });

  it("rolls a bare past clock time to tomorrow", () => {
    // "5am" with no day-word must not silently land in the past
    const r = parseEventTime("5am", opts({ timeZone: "UTC" }));
    // 05:00 today is before NOW (12:00) → rolls to tomorrow 05:00
    assert.ok(r.ok);
    assert.equal(r.atMs, Date.UTC(2026, 9, 14, 5, 0, 0));
  });

  it("rejects garbage with an actionable error", () => {
    const r = parseEventTime("sometime soonish", opts());
    assert.equal(r.ok, false);
    assert.match(r.error, /couldn.t read|understand/i);
  });

  it("flags unknown timezone instead of guessing", () => {
    const r = parseEventTime("tomorrow 7pm", opts({ timeZone: "Mars/Olympus" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /Mars\/Olympus|timezone/i);
  });
});

describe("timeParse helpers", () => {
  it("parseDuration accepts plain minutes and h/m combos", () => {
    assert.equal(parseDuration("90").minutes, 90);
    assert.equal(parseDuration("1h30m").minutes, 90);
    assert.equal(parseDuration("2 hours").minutes, 120);
    assert.equal(parseDuration("").minutes, null);
    assert.equal(parseDuration("-5").ok, false);
  });

  it("parseCutoff → signed minute offsets", () => {
    assert.equal(parseCutoff("at start").offsetMinutes, 0);
    assert.equal(parseCutoff("30m before").offsetMinutes, -30);
    assert.equal(parseCutoff("1h after").offsetMinutes, 60);
    assert.equal(parseCutoff("").offsetMinutes, null);
    assert.equal(parseCutoff("whenever").ok, false);
  });

  it("tzOffsetMs flips across the US DST boundary", () => {
    const before = tzOffsetMs(Date.UTC(2026, 10, 1), "America/New_York"); // Nov 1 = EDT
    const after = tzOffsetMs(Date.UTC(2026, 10, 8), "America/New_York"); // Nov 8 = EST
    assert.equal(before, -4 * 3600_000);
    assert.equal(after, -5 * 3600_000);
  });

  it("wallToUtc round-trips wallClockParts", () => {
    const tz = "Europe/Berlin";
    const at = Date.UTC(2026, 6, 4, 20, 30); // 22:30 CEST
    const parts = wallClockParts(at, tz);
    assert.deepEqual([parts.h, parts.mi], [22, 30]);
    const back = wallToUtc(2026, 6, 4, 22, 30, tz);
    assert.ok(Math.abs(back - at) <= 3600_000); // DST-tolerant to one hour
  });
});

describe("recurrence math", () => {
  const weeklyShape = (weekdays, tod = 19 * 60) => ({
    cadence: "weekly",
    weekdays,
    timeOfDayMin: tod,
    endMode: "never",
  });

  it("weekly advances to the next selected weekday", () => {
    const after = Date.UTC(2026, 9, 13); // Tue
    const next = nextOccurrence(weeklyShape([2, 4]), after, after); // Tue/Thu
    assert.ok(next.ok);
    const day = new Date(next.atMs).getUTCDay();
    assert.ok([2, 4].includes(day));
    assert.ok(next.atMs > after);
  });

  it("daily hits every day at the fixed time", () => {
    const shape = { ...weeklyShape([0]), cadence: "daily" };
    const after = Date.UTC(2026, 9, 13, 0, 0);
    const n1 = nextOccurrence(shape, after, after);
    assert.ok(n1.ok);
    assert.equal(new Date(n1.atMs).getUTCMinutes() + new Date(n1.atMs).getUTCHours() * 60, 19 * 60);
  });

  it("monthly SKIPS months without the day (locked rule, no clamping)", () => {
    const shape = {
      cadence: "monthly",
      weekdays: [],
      monthDay: 31,
      timeOfDayMin: 60,
      endMode: "never",
    };
    // Nov 2026 has 30 days → must skip to Dec 31
    const after = Date.UTC(2026, 10, 5); // Nov 5
    const n = nextOccurrence(shape, after, after);
    assert.ok(n.ok);
    const d = new Date(n.atMs);
    assert.equal(d.getUTCMonth(), 11); // December
    assert.equal(d.getUTCDate(), 31);
  });

  it("end 'until' reports ended past the horizon", () => {
    const shape = { ...weeklyShape([1]), endMode: "until", endAt: Date.UTC(2026, 9, 20) };
    // Wed Oct 21 → next Monday is Oct 26 19:00, past the Oct 20 horizon
    const n = nextOccurrence(shape, Date.UTC(2026, 9, 21), Date.UTC(2026, 9, 21));
    assert.ok(!n.ok);
    assert.equal(n.ended, true);
    // and one inside the horizon still resolves
    const ok = nextOccurrence(shape, Date.UTC(2026, 9, 14), Date.UTC(2026, 9, 14));
    assert.ok(ok.ok);
    assert.equal(ok.atMs, Date.UTC(2026, 9, 19, 19, 0));
  });

  it("countAllows tracks occurrences_created", () => {
    const s = { cadence: "daily", timeOfDayMin: 0, endMode: "count", endCount: 3, occurrences_created: 2 };
    assert.equal(countAllows(s), true);
    assert.equal(countAllows({ ...s, occurrences_created: 3 }), false);
    assert.equal(countAllows({ ...s, endMode: "never", occurrences_created: 99 }), true);
  });

  it("seriesShapeFromStart derives weekday/month day/time", () => {
    const start = Date.UTC(2026, 9, 15, 18, 30); // Thu
    const shape = seriesShapeFromStart("weekly", start, {});
    assert.equal(shape.weekdays[0], 4);
    assert.equal(shape.timeOfDayMin, 18 * 60 + 30);
    const monthly = seriesShapeFromStart("monthly", start, {});
    assert.equal(monthly.monthDay, 15);
  });
});
