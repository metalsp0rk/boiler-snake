const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// #609 CONTRACT: fresh DB before any src/ require.
const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb();
after(cleanup);

const { ensureCommunity } = require("../src/platform/community");
const repo = require("../src/db");

/**
 * #895 (audit r4 F3): the event_notifications failure/retire primitives
 * used to write by bare id — a late retry write resurrected `sent` and
 * `retired` rows to `pending` (cancelled/already-notified events re-pinged
 * @roles), and retireEventReminder rewrote `sent` rows. These primitives
 * had ZERO test coverage before this file.
 */

const communityId = ensureCommunity({
  platform: "discord",
  instanceKey: "discord",
  externalGuildId: "9001000001",
});

let seq = 0;
function mkReminder(status, overrides = {}) {
  seq += 1;
  const created = repo.createEvent({
    communityId,
    creatorId: "1",
    title: `ev-${seq}`,
    startAt: 5_000_000,
  });
  assert.equal(created.ok, true, created.error);
  const ev = created.event;
  const info = repo.db
    .prepare(
      `INSERT INTO event_notifications
         (event_id, offset_minutes, fire_at, target, role_id, status, attempts, claimed_at, sent_at)
       VALUES (?, 10, 1000, 'role', '555', ?, ?, ?, ?)`,
    )
    .run(ev.id, status, overrides.attempts ?? 0, overrides.claimedAt ?? null, overrides.sentAt ?? null);
  return { id: info.lastInsertRowid, event: ev };
}

const state = (id) =>
  repo.db.prepare(`SELECT status, attempts, next_attempt_at FROM event_notifications WHERE id=?`).get(id);

describe("#895: markEventReminderRetry is CAS'd on the caller's lease", () => {
  it("settles the legal ladder: sending → pending with relative attempts", () => {
    const { id } = mkReminder("sending", { attempts: 3 });
    const out = repo.markEventReminderRetry(id, "transient", 10_000);
    assert.equal(out.outcome, "retry");
    assert.equal(out.attempts, 4, "counter is relative, not a caller snapshot");
    assert.equal(out.terminal, false);
    assert.equal(state(id).status, "pending");
    assert.ok(state(id).next_attempt_at > 10_000, "backoff gate installed");
  });

  it("NEVER resurrects a sent row — the false re-ping (#895)", () => {
    const { id } = mkReminder("sending");
    assert.equal(repo.markEventReminderSent(id, "12345").won, true);
    const late = repo.markEventReminderRetry(id, "deliver threw late", 20_000);
    assert.equal(late.outcome, "skipped");
    assert.equal(state(id).status, "sent", "an already-notified event stays notified");
    assert.equal(state(id).attempts, 0, "delivered traffic never accrues attempts");
  });

  it("NEVER resurrects an organizer-retired row (cancelled event)", () => {
    const { id } = mkReminder("sending");
    assert.equal(repo.retireEventReminder(id, "organizer cancelled"), true);
    const late = repo.markEventReminderRetry(id, "late failure after retire", 30_000);
    assert.equal(late.outcome, "skipped");
    assert.equal(state(id).status, "retired", "a cancelled event's reminder stays dead");
  });

  it("NEVER resurrects a row retired by cancel-all mid-delivery", () => {
    const { id, event } = mkReminder("sending");
    const moved = repo.retireAllUnsentEventReminders(event.id, "event cancelled");
    assert.equal(moved, 1);
    const late = repo.markEventReminderRetry(id, "delivery failed", 40_000);
    assert.equal(late.outcome, "skipped");
    assert.equal(state(id).status, "retired");
  });

  it("parks at the attempt cap (terminal failed)", () => {
    const { id } = mkReminder("sending", { attempts: 11 });
    const out = repo.markEventReminderRetry(id, "boom", 50_000);
    assert.equal(out.outcome, "failed");
    assert.equal(out.terminal, true);
    assert.equal(state(id).status, "failed");
    // Failed is settled: later failure writes change nothing.
    assert.equal(repo.markEventReminderRetry(id, "again", 60_000).outcome, "skipped");
    assert.equal(state(id).attempts, 12, "attempts do not climb past the cap");
  });

  it("answers null for a missing row (contract unchanged)", () => {
    assert.equal(repo.markEventReminderRetry(999_999, "nope", 1), null);
  });
});

describe("#895: retireEventReminder only retires UNSSENT rows", () => {
  it("retires pending and sending rows (won)", () => {
    const a = mkReminder("pending");
    const b = mkReminder("sending");
    assert.equal(repo.retireEventReminder(a.id, "deleted"), true);
    assert.equal(repo.retireEventReminder(b.id, "deleted"), true);
    assert.equal(state(a.id).status, "retired");
    assert.equal(state(b.id).status, "retired");
  });

  it("refuses to rewrite a sent row (audit trail preserved)", () => {
    const { id } = mkReminder("sending");
    repo.markEventReminderSent(id, "999");
    assert.equal(repo.retireEventReminder(id, "late retire"), false);
    assert.equal(state(id).status, "sent", "sent is not rewritable to retired");
  });
});

describe("#895: claim belt mirrors the twin (sent_at IS NULL)", () => {
  it("claims due pending rows and stale claims, never a sent-at row", () => {
    const due = mkReminder("pending", { attempts: 0 });
    repo.db
      .prepare(`UPDATE event_notifications SET fire_at = 1000 WHERE id=?`)
      .run(due.id);
    const stale = mkReminder("sending", { claimedAt: 1001 - 10 * 60_000 });
    const corrupted = mkReminder("sending", {
      claimedAt: 1001 - 10 * 60_000,
      sentAt: 900, // corrupt: status sending but sent_at set — never re-deliver
    });

    const claimed = repo.claimDueEventReminders(1001).map((r) => r.id);
    assert.ok(claimed.includes(due.id), "due pending row is claimed");
    assert.ok(claimed.includes(stale.id), "stale sending claim is recoverable");
    assert.ok(!claimed.includes(corrupted.id), "a row with sent_at set can never re-fire");
    assert.equal(state(corrupted.id).status, "sending", "the belt leaves the corrupt row untouched");
  });
});
