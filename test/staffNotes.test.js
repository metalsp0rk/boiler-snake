const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("staff notes repository", () => {
  let api;
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-notes-"));
    dbPath = path.join(tmpDir, "test.sqlite");
    process.env.DB_PATH = dbPath;
    for (const key of Object.keys(require.cache)) {
      if (
        key.includes(`${path.sep}src${path.sep}db`) ||
        key.endsWith(`${path.sep}db.js`)
      ) {
        delete require.cache[key];
      }
    }
    api = require("../src/db");
  });

  it("creates notes with sequential per-guild note_number", () => {
    const a = api.createStaffNote({
      guildId: "g1",
      userId: "u1",
      authorId: "staff1",
      content: "First note",
    });
    const b = api.createStaffNote({
      guildId: "g1",
      userId: "u2",
      authorId: "staff1",
      content: "Second note",
    });
    const otherGuild = api.createStaffNote({
      guildId: "g2",
      userId: "u1",
      authorId: "staff1",
      content: "Other guild",
    });

    assert.equal(a.note_number, 1);
    assert.equal(b.note_number, 2);
    assert.equal(otherGuild.note_number, 1);
    assert.equal(a.user_id, "u1");
    assert.equal(a.author_id, "staff1");
    assert.equal(a.deleted_at, null);
  });

  it("rejects empty and oversized content", () => {
    assert.throws(
      () =>
        api.createStaffNote({
          guildId: "g1",
          userId: "u1",
          authorId: "staff1",
          content: "   ",
        }),
      (err) => err.code === "INVALID_CONTENT"
    );

    const tooLong = "x".repeat(api.MAX_NOTE_CONTENT + 1);
    assert.throws(
      () =>
        api.createStaffNote({
          guildId: "g1",
          userId: "u1",
          authorId: "staff1",
          content: tooLong,
        }),
      (err) => err.code === "INVALID_CONTENT"
    );
  });

  it("lists by user, newest first; get by note_number", () => {
    const g = "g-list";
    api.createStaffNote({
      guildId: g,
      userId: "u1",
      authorId: "s",
      content: "older",
    });
    // tiny delay not needed — note_number order is enough with same created_at
    const n2 = api.createStaffNote({
      guildId: g,
      userId: "u1",
      authorId: "s",
      content: "newer",
    });
    api.createStaffNote({
      guildId: g,
      userId: "u2",
      authorId: "s",
      content: "other user",
    });

    const list = api.listStaffNotes(g, "u1");
    assert.equal(list.length, 2);
    assert.equal(list[0].content, "newer");
    assert.equal(list[1].content, "older");

    const got = api.getStaffNote(g, n2.note_number);
    assert.equal(got.content, "newer");
    assert.equal(api.countStaffNotes(g, "u1"), 2);
  });

  it("updates content and soft-deletes", () => {
    const g = "g-edit";
    const note = api.createStaffNote({
      guildId: g,
      userId: "u1",
      authorId: "s1",
      content: "original",
    });

    const updated = api.updateStaffNote(g, note.note_number, {
      content: "revised",
      editedBy: "s2",
    });
    assert.equal(updated.content, "revised");
    assert.equal(updated.edited_by, "s2");
    assert.ok(updated.edited_at != null);

    const deleted = api.softDeleteStaffNote(g, note.note_number, "s3");
    assert.ok(deleted.deleted_at != null);
    assert.equal(deleted.deleted_by, "s3");

    // Active list hides soft-deleted
    assert.equal(api.listStaffNotes(g, "u1").length, 0);
    assert.equal(
      api.listStaffNotes(g, "u1", { includeDeleted: true }).length,
      1
    );

    // Cannot edit deleted
    assert.equal(
      api.updateStaffNote(g, note.note_number, {
        content: "nope",
        editedBy: "s1",
      }),
      null
    );

    // Idempotent soft-delete
    const again = api.softDeleteStaffNote(g, note.note_number, "s4");
    assert.equal(again.deleted_by, "s3");
  });

  it("lists recent guild-wide notes", () => {
    const g = "g-recent";
    api.createStaffNote({
      guildId: g,
      userId: "a",
      authorId: "s",
      content: "one",
    });
    api.createStaffNote({
      guildId: g,
      userId: "b",
      authorId: "s",
      content: "two",
    });
    const recent = api.listRecentStaffNotes(g, { limit: 10 });
    assert.equal(recent.length, 2);
    assert.equal(api.countStaffNotes(g), 2);
  });
});
