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

  it("stores evidence message URL and freeform evidence text", () => {
    const g = "999001";
    const url = `https://discord.com/channels/${g}/111/222`;
    const warn = api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "With evidence",
      evidenceMessageUrl: url,
      evidenceText: "Screenshot in #mod-queue",
    });
    assert.equal(warn.evidence_message_url, url);
    assert.equal(warn.evidence_text, "Screenshot in #mod-queue");

    assert.throws(
      () =>
        api.createWarning({
          guildId: g,
          userId: "u1",
          issuerId: "s",
          reason: "bad url",
          evidenceMessageUrl: "https://example.com/not-discord",
        }),
      (err) => err.code === "INVALID_EVIDENCE_URL"
    );

    assert.throws(
      () =>
        api.createWarning({
          guildId: g,
          userId: "u1",
          issuerId: "s",
          reason: "wrong guild link",
          evidenceMessageUrl: "https://discord.com/channels/888888/1/2",
        }),
      (err) => err.code === "INVALID_EVIDENCE_URL"
    );
  });

  it("resolves expires_at from guild default and per-warning override", () => {
    const g = "g-expiry";
    api.updateGuildSettings(g, { warn_expiry_days: 7 });
    assert.equal(Number(api.getGuildSettings(g).warn_expiry_days), 7);

    const fromDefault = api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "default expiry",
      guildDefaultDays: 7,
    });
    assert.ok(fromDefault.expires_at != null);
    const expected = fromDefault.created_at + 7 * 24 * 60 * 60 * 1000;
    assert.equal(fromDefault.expires_at, expected);

    const never = api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "override never",
      expiresDays: 0,
      guildDefaultDays: 7,
    });
    assert.equal(never.expires_at, null);

    const override = api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "override 1 day",
      expiresDays: 1,
      guildDefaultDays: 7,
    });
    assert.equal(
      override.expires_at,
      override.created_at + 1 * 24 * 60 * 60 * 1000
    );
  });

  it("lists expired active warnings for the ticker", () => {
    const g = "g-expired-list";
    const past = Date.now() - 60_000;
    const future = Date.now() + 86_400_000;

    const expired = api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "past expiry",
      expiresAt: past,
    });
    api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "future expiry",
      expiresAt: future,
    });
    api.createWarning({
      guildId: g,
      userId: "u1",
      issuerId: "s",
      reason: "no expiry",
    });

    const due = api.listExpiredActiveWarnings(Date.now(), 50);
    const ids = due.map((w) => w.id);
    assert.ok(ids.includes(expired.id));
    assert.equal(
      due.filter((w) => w.guild_id === g && w.reason === "future expiry").length,
      0
    );

    api.voidWarning(g, expired.warning_number, {
      voidedBy: "system:expiry",
      voidReason: "Auto-voided: expiry date reached",
    });
    const after = api.listExpiredActiveWarnings(Date.now(), 50);
    assert.equal(
      after.filter((w) => w.id === expired.id).length,
      0
    );
  });

  it("normalizeEvidenceMessageUrl canonicalizes hosts", () => {
    const r = api.normalizeEvidenceMessageUrl(
      "https://canary.discord.com/channels/1/2/3/",
      "1"
    );
    assert.equal(r.ok, true);
    assert.equal(r.url, "https://discord.com/channels/1/2/3");
  });

  it("resolveExpiryDays prefers override over guild default", () => {
    assert.equal(
      api.resolveExpiryDays({ expiresDays: 0, guildDefaultDays: 30 }),
      0
    );
    assert.equal(
      api.resolveExpiryDays({ expiresDays: 3, guildDefaultDays: 30 }),
      3
    );
    assert.equal(api.resolveExpiryDays({ guildDefaultDays: 14 }), 14);
    assert.equal(api.resolveExpiryDays({}), 0);
  });
});

describe("warnings export markdown", () => {
  it("builds a staff handoff markdown body", () => {
    const {
      buildStaffRecordMarkdown,
      exportFilename,
    } = require("../src/features/warnings/exportRecord");

    const md = buildStaffRecordMarkdown({
      guildId: "g1",
      guildName: "Test Guild",
      userId: "u1",
      userTag: "member#0001",
      exportedById: "staff1",
      exportedByTag: "mod#0001",
      warnings: [
        {
          warning_number: 1,
          issuer_id: "staff1",
          created_at: 1_700_000_000_000,
          expires_at: null,
          reason: "Spam",
          voided_at: null,
          evidence_message_url: "https://discord.com/channels/g1/1/2",
          evidence_text: "see link",
          related_note_id: 9,
        },
      ],
      notes: [
        {
          id: 9,
          note_number: 3,
          author_id: "staff1",
          created_at: 1_700_000_000_000,
          content: "Prior context",
          deleted_at: null,
        },
      ],
      activeWarnings: 1,
      totalWarnings: 1,
      activeNotes: 1,
      totalNotes: 1,
      notesById: new Map([
        [
          9,
          {
            id: 9,
            note_number: 3,
            author_id: "staff1",
            created_at: 1_700_000_000_000,
            content: "Prior context",
          },
        ],
      ]),
      exportedAt: 1_700_000_100_000,
    });

    assert.match(md, /Staff record export/);
    assert.match(md, /W-1 \[ACTIVE\]/);
    assert.match(md, /N-3 \[ACTIVE\]/);
    assert.match(md, /\*\*Linked note:\*\* N-3/);
    assert.match(md, /Evidence message/);
    assert.equal(
      exportFilename("u1", 1_700_000_100_000),
      "staff-record-u1-2023-11-14.md"
    );
  });
});
