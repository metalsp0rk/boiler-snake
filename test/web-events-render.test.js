const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// View-level guard for the calendar NaN defect: events.js must NEVER print
// a stored value that is not a finite instant — neither the string "NaN"
// nor raw ms. Migration 072 heals the data; this keeps the renderer honest
// against fresh bad rows (the dashboard's honest-unknown doctrine).
const views = require("../src/web/views/events.js");

const VALID_MS = Date.UTC(2026, 5, 6, 20, 0, 0);

const ev = (over = {}) => ({
  community_id: "100",
  id: 7,
  title: "Friday raid",
  status: "posted",
  start_at: VALID_MS,
  end_at: VALID_MS + 7200000,
  ...over,
});

describe("events views — date rendering never leaks NaN", () => {
  it("fmtTime: every non-finite instant and every invalid zone is an em-dash", () => {
    assert.equal(views.fmtTime(NaN, "UTC"), "—");
    assert.equal(views.fmtTime("NaN", "UTC"), "—");
    assert.equal(views.fmtTime("2026-06-06 20:00", "UTC"), "—");
    assert.equal(views.fmtTime(undefined, "UTC"), "—");
    assert.equal(views.fmtTime(null, "UTC"), "—");
    assert.equal(views.fmtTime(VALID_MS, "Not/AZone"), "—");
    assert.match(views.fmtTime(VALID_MS, "UTC"), /^Jun 6, 2026/);
  });

  it("month grid + drafts/scheduled lists carry no literal NaN on junk rows", () => {
    const junk = [
      ev({ id: 1, start_at: "NaN", status: "draft" }),
      ev({ id: 2, start_at: "2026-06-06 20:00" }),
      ev({ id: 3 }),
    ];
    const body = String(
      views.renderEventsMonth({
        cid: "100",
        year: 2026,
        month: 6,
        zone: "UTC",
        events: junk,
        drafts: [ev({ id: 4, title: "Broken draft", start_at: "NaN", status: "draft" })],
        scheduled: [ev({ id: 5, title: "Broken queue", status: "draft", post_at: "NaN" })],
        nowMs: Date.UTC(2026, 5, 6, 15, 0, 0),
        csrfToken: "t",
      })
    );
    assert.ok(!body.includes("NaN"), "no NaN token anywhere in the month page");
    assert.match(body, /Friday raid/, "the valid event still renders");
    assert.match(body, /Broken draft/);
    assert.match(body, /—/);
  });

  it("archive / scheduled lists degrade to em-dash, not the raw value", () => {
    const archive = String(
      views.renderArchive({
        cid: "100",
        rows: [ev({ start_at: "gibberish", status: "archived" })],
        zone: "UTC",
        csrfToken: "t",
      })
    );
    assert.ok(!archive.includes("gibberish"));
    assert.match(archive, /—/);

    const scheduled = String(
      views.renderScheduled({
        cid: "100",
        rows: [ev({ status: "draft", post_at: "NaN" })],
        zone: "UTC",
        csrfToken: "t",
      })
    );
    assert.ok(!scheduled.includes("NaN"));
  });

  it("dayKey: junk instants bucket to the empty key (never a fake day)", () => {
    assert.equal(views.dayKey("NaN", "UTC"), "");
    assert.equal(views.dayKey(VALID_MS, "UTC"), "2026-06-06");
  });
});
