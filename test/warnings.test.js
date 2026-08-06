const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("warnings repository", () => {
  let api;
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boiler-snake-warn-"));
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

  it("creates warnings with sequential per-guild warning_number", () => {
    const a = api.createWarning({
      guildId: "g1",
      userId: "u1",
      issuerId: "staff1",
      reason: "First warning",
    });
    const b = api.createWarning({
      guildId: "g1",
      userId: "u2",
      issuerId: "staff1",
      reason: "Second warning",
    });
    const otherGuild = api.createWarning({
      guildId: "g2",
      userId: "u1",
      issuerId: "staff1",
      reason: "Other guild",
    });

    assert.equal(a.warning_number, 1);
    assert.equal(b.warning_number, 2);
    assert.equal(otherGuild.warning_number, 1);
    assert.equal(a.user_id, "u1");
    assert.equal(a.issuer_id, "staff1");
    assert.equal(a.voided_at, null);
    assert.equal(a.reason, "First warning");
  });

  it("rejects empty and oversized reasons", () => {
    assert.throws(
      () =>
        api.createWarning({
          guildId: "g1",
          userId: "u1",
          issuerId: "staff1",
          reason: "   ",
        }),
      (err) => err.code === "INVALID_REASON"
    );

    const tooLong = "x".repeat(api.MAX_WARN_REASON + 1);
    assert.throws(
      () =>
        api.createWarning({
          guildId: "g1",
          userId: "u1",
          issuerId: "staff1",
          reason: tooLong,
        }),
      (err) => err.code === "INVALID_REASON"
    );
  });

  it("lists by user, counts active, gets by warning_number", () => {
    const g = "g-list";
    api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "older",
    });
    const w2 = api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "newer",
    });
    api.createWarning({
      guildId: g,
      userId: "u2",
      issuerId: "s",
      reason: "other user",
    });

    const list = api.listWarnings(g, "u1");
    assert.equal(list.length, 2);
    assert.equal(list[0].reason, "newer");
    assert.equal(list[1].reason, "older");

    const got = api.getWarning(g, w2.warning_number);
    assert.equal(got.reason, "newer");
    assert.equal(api.countActiveWarnings(g, "u1"), 2);
    assert.equal(api.countWarnings(g, "u1"), 2);
  });

  it("voids with reason; permanent row; cannot re-void", () => {
    const g = "g-void";
    const warn = api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s1",
      reason: "spam",
    });

    assert.equal(api.countActiveWarnings(g, "u1"), 1);

    const voided = api.voidWarning(g, warn.warning_number, {
      voidedBy: "s2",
      voidReason: "appeal accepted",
    });
    assert.ok(voided.voided_at != null);
    assert.equal(voided.voided_by, "s2");
    assert.equal(voided.void_reason, "appeal accepted");
    assert.equal(voided.reason, "spam"); // reason immutable

    assert.equal(api.countActiveWarnings(g, "u1"), 0);
    assert.equal(api.listWarnings(g, "u1").length, 0);
    assert.equal(
      api.listWarnings(g, "u1", { includeVoided: true }).length,
      1
    );
    assert.equal(api.countWarnings(g, "u1", { includeVoided: true }), 1);

    assert.throws(
      () =>
        api.voidWarning(g, warn.warning_number, {
          voidedBy: "s3",
          voidReason: "again",
        }),
      (err) => err.code === "ALREADY_VOIDED"
    );

    assert.throws(
      () =>
        api.voidWarning(g, warn.warning_number, {
          voidedBy: "s3",
          voidReason: "   ",
        }),
      (err) => err.code === "INVALID_REASON" || err.code === "ALREADY_VOIDED"
    );
  });

  it("links optional related_note_id", () => {
    const g = "g-note";
    const note = api.createStaffNote({
      guildId: g,
      userId: "u1",
      authorId: "s",
      content: "Context for the warning",
    });
    const warn = api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "Formal strike",
      relatedNoteId: note.id,
    });
    assert.equal(warn.related_note_id, note.id);
  });

  it("defaults warn_dm_members to on and allows toggle", () => {
    const g = "g-dm";
    const s = api.getGuildSettings(g);
    assert.equal(Number(s.warn_dm_members), 1);

    api.updateGuildSettings(g, { warn_dm_members: 0 });
    assert.equal(Number(api.getGuildSettings(g).warn_dm_members), 0);

    api.updateGuildSettings(g, { warn_dm_members: 1 });
    assert.equal(Number(api.getGuildSettings(g).warn_dm_members), 1);
  });

  it("supports warn_log_channel_id set and clear", () => {
    const g = "g-warn-log";
    const s = api.getGuildSettings(g);
    assert.equal(s.warn_log_channel_id ?? null, null);

    api.updateGuildSettings(g, { warn_log_channel_id: "chan-warn-1" });
    assert.equal(api.getGuildSettings(g).warn_log_channel_id, "chan-warn-1");

    api.updateGuildSettings(g, { warn_log_channel_id: null });
    assert.equal(api.getGuildSettings(g).warn_log_channel_id, null);
  });

  it("void of missing warning returns null", () => {
    assert.equal(
      api.voidWarning("g-missing", 99999, {
        voidedBy: "s",
        voidReason: "nope",
      }),
      null
    );
  });
});
