/**
 * #469 (F2-11): moderation PII finally has an erasure path.
 *
 * 1. DELETING a staff note now DESTROYS its content (tombstone stub keeps
 *    the audit chain). Pre-fix soft-delete kept the full text forever —
 *    and the staff-record export includes deleted notes by DEFAULT, so
 *    "deleted" notes rode every export.
 * 2. Two OPT-IN retention sweeps retire moderation rows past a window:
 *    voided warnings (withdrawn — enforcement-free) and erase-tombstones.
 *    Unset knob ⇒ honest "disabled" skip; active warnings and live notes
 *    are structurally outside both WHEREs.
 * (The finding's third leg — daily counters — has been swept since #399.)
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env"); // CONTRACT: temp DB before src/
const { api, cleanup } = loadDb();

const { runRetentionSweeps } = require("../src/features/retention/sweeps");
const { ERASED_NOTE_CONTENT } = api;

after(cleanup);

const GUILD = "940000000000004611";
const CID = communityKey(GUILD);
const DAY = 86_400_000;

const seedNote = (userId) =>
  api.createStaffNote({
    communityId: CID,
    userId,
    authorId: "840000000000000009",
    content: "very personal note content",
  });

describe("#469 (F2-11): note deletion ERASES content", () => {
  it("the soft-deleted row carries the tombstone, not the text", () => {
    const note = seedNote("840000000000000021");
    const id = typeof note === "object" ? note.id : note;

    api.softDeleteStaffNote(CID, typeof note === "object" ? note.note_number : note.note_number, "840000000000000009");

    const row = api.db.prepare("SELECT * FROM staff_notes WHERE id=?").get(id);
    assert.ok(row.deleted_at != null, "still a soft delete (audit chain intact)");
    assert.equal(row.content, ERASED_NOTE_CONTENT);
    assert.ok(
      !row.content.includes("very personal"),
      "the TEXT is gone — pre-fix the row kept it forever",
    );
  });

  it("active notes keep their content", () => {
    const note = seedNote("840000000000000022");
    const row = api.db.prepare("SELECT content FROM staff_notes WHERE id=?").get(note.id);
    assert.equal(row.content, "very personal note content");
  });
});

describe("#469 (F2-11): the opt-in erasure sweeps", () => {
  const mkVoidedWarning = (userId, voidedAgoDays) => {
    const w = api.createWarning({
      communityId: CID,
      userId,
      issuerId: "840000000000000009",
      reason: "old thing",
    });
    api.db
      .prepare("UPDATE warnings SET voided_at=?, voided_by=?, void_reason=? WHERE id=?")
      .run(Date.now() - voidedAgoDays * DAY, "840000000000000009", "appealed", w.id);
    return w;
  };

  it("unset knobs skip BOTH tables (moderation data never vanishes silently)", () => {
    const rows = runRetentionSweeps({ at: Date.now(), overrides: {} });
    const warn = rows.find((r) => r.table === "warnings");
    const notes = rows.find((r) => r.table === "staff_notes");
    assert.equal(warn.skipped, "disabled");
    assert.equal(notes.skipped, "disabled");
  });

  it("voided warnings past the window die; active ones cannot", () => {
    const gone = mkVoidedWarning("840000000000000031", 400);
    const recent = mkVoidedWarning("840000000000000032", 10);
    const active = api.createWarning({
      communityId: CID,
      userId: "840000000000000033",
      issuerId: "840000000000000009",
      reason: "still enforcing",
    });

    const rows = runRetentionSweeps({
      at: Date.now(),
      overrides: { voidedWarningsDays: 365, erasedNotesDays: null },
    });
    const warn = rows.find((r) => r.table === "warnings");
    assert.equal(warn.deleted, 1, "only the 400-day-old VOIDED row");

    assert.equal(api.db.prepare("SELECT 1 FROM warnings WHERE id=?").get(gone.id), undefined);
    assert.ok(api.db.prepare("SELECT 1 FROM warnings WHERE id=?").get(recent.id));
    assert.ok(api.db.prepare("SELECT 1 FROM warnings WHERE id=?").get(active.id), "active enforcement survives");
  });

  it("erase-tombstones past the window leave the table; live notes cannot", () => {
    const old = seedNote("840000000000000041");
    api.softDeleteStaffNote(CID, old.note_number, "840000000000000009");
    api.db
      .prepare("UPDATE staff_notes SET deleted_at=? WHERE id=?")
      .run(Date.now() - 200 * DAY, old.id);

    const live = seedNote("840000000000000042");

    const rows = runRetentionSweeps({
      at: Date.now(),
      overrides: { voidedWarningsDays: null, erasedNotesDays: 90 },
    });
    const notes = rows.find((r) => r.table === "staff_notes");
    assert.equal(notes.deleted, 1);

    assert.equal(api.db.prepare("SELECT 1 FROM staff_notes WHERE id=?").get(old.id), undefined);
    assert.ok(api.db.prepare("SELECT 1 FROM staff_notes WHERE id=?").get(live.id));
  });

  it("garbage input to the primitives throws (typed guards, rule 6)", () => {
    assert.throws(() => api.deleteVoidedWarningsOlderThan("yesterday", 10), TypeError);
    assert.throws(() => api.deleteErasedNotesOlderThan(Date.now(), 0), TypeError);
  });
});
