"use strict";

/**
 * #905 item 6 (audit r4 F10f-b): the event POST primitives are draft-scoped
 * CAS, and the failure counter increments ATOMICALLY.
 *
 * The scheduled arm claims due drafts with a proper CAS
 * (`claimDueScheduledPosts`), but the settle writes used to be unconditional
 * UPDATEs by bare id: an event skipped/cancelled between the claim and the
 * settle kept `post_attempts`, `next_attempt_at` and `last_post_error` from
 * a post that raced the cancel — a dead retry schedule on a settled row —
 * and failures collapsed because the counter was an absolute write from a
 * stale read.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(() => cleanup());

const CID = communityKey("190500000000000001");

function mkEvent(status = "draft", over = {}) {
  const out = db.createEvent({
    communityId: CID,
    creatorId: "900000000000000001",
    title: "f10b fixture",
    status,
    startAt: Date.now() + 3_600_000,
    postAt: Date.now() - 1000, // due: the scheduled arm would claim it
    ...over,
  });
  assert.equal(out.ok ?? true, true, out.error);
  const ev = out.event ?? out;
  assert.ok(ev.id != null, "event row created");
  return ev;
}

const row = (id) => db.getEventById(id);

test("markEventPosted: drafts/wizard rows/posted REPOSTS move; terminal rows never do", () => {
  const draft = mkEvent();
  const posted = db.markEventPosted(draft.id, { channelId: "7001", messageId: "8001" });
  assert.equal(posted.status, "posted");
  assert.equal(posted.message_id, "8001");
  assert.equal(posted.next_attempt_at, null);

  // The wizard/manual path posts straight from pending_confirm (#905's
  // first draft-scope draft BROKE this — the vocabulary has no 'cancelled':
  // the terminal states are 'skipped'/'archived').
  const wizard = mkEvent("pending_confirm");
  assert.equal(db.markEventPosted(wizard.id, { channelId: "7003", messageId: "8003" }).status, "posted");

  // The documented repost path: posted → posted with fresh coordinates.
  const reposted = db.markEventPosted(draft.id, { channelId: "7001", messageId: "9001" });
  assert.equal(reposted.status, "posted");
  assert.equal(reposted.message_id, "9001", "repost re-stamps the live coordinates");

  // The wedge: a row skipped/archived between the claim and this write
  // must NOT be resurrected (the live row comes back; the Discord post
  // that raced the staff decision is real and already logged).
  const skipped = mkEvent("skipped");
  const refused = db.markEventPosted(skipped.id, { channelId: "7002", messageId: "8002" });
  assert.equal(refused.status, "skipped", "#905: the CAS lost — the terminal row stands");
  assert.equal(refused.message_id, null, "no coordinates written onto a terminal event");
  const archived = mkEvent("archived");
  assert.equal(db.markEventPosted(archived.id, { channelId: "7004", messageId: "8004" }).status, "archived");
});

test("recordEventPostFailure: atomic counter on drafts, honest SKIP on settled rows", () => {
  const draft = mkEvent();

  const first = db.recordEventPostFailure(draft.id, "channel gone");
  assert.equal(first.attempts, 1);
  assert.equal(first.failed, false);
  assert.ok(Number.isInteger(first.nextAttemptAt), "backoff scheduled");

  const second = db.recordEventPostFailure(draft.id, "channel gone again");
  assert.equal(second.attempts, 2, "ATOMIC increment (old code: absolute write from a stale read)");
  assert.equal(row(draft.id).post_attempts, 2);
  assert.match(row(draft.id).last_post_error, /again/);

  // Settled between claim and failure: nothing writes, the live counter
  // is reported, skipped names why the caller's backoff is null.
  const skipped = mkEvent("skipped");
  const out = db.recordEventPostFailure(skipped.id, "late failure");
  assert.equal(out.skipped, true, "lost CAS is an honest skip, not a silent pass");
  assert.equal(out.nextAttemptAt, null, "no retry schedule invented for a settled row");
  const settled = row(skipped.id);
  assert.equal(settled.post_attempts, 0, "the settled row's counter never moved");
  assert.equal(settled.last_post_error, null, "no error text lands on the settled row");
  assert.equal(settled.next_attempt_at, null, "no backoff lands on the settled row");
});
