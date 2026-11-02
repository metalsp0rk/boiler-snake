/**
 * banRecords repository unit suite (#772). Storage law only:
 * - BAN_RECORD_STATUSES / BAN_SOURCES are asserted against the ACTUAL
 *   migration-074 CHECK text (single-source drift is the bug class);
 * - B-n numbering is per-community, monotonic, and never re-issues numbers
 *   after rows close (the UNIQUE(community_id, ban_number) index is the
 *   race belt — its message contract for createBanRecord's BAN_NUMBER_RACE
 *   branch is pinned here, the schema file pins the index itself);
 * - claim rows follow the tickets.claimTicketArchive law: first-click-wins,
 *   loser gets { ok:true, won:false } + the LIVE row and mutates NOTHING;
 *   the unban claim is a LEASE (crash-wedge #419), boundary tested at
 *   LEASE-1 / LEASE / LEASE+1 with an injected clock — zero wall-clock;
 * - finalizeUnban/markUnbannedManual are CAS'd on status='active' so a
 *   manual unban always wins over the in-flight ticker ("events keep the
 *   record truthful"); finalize from the CLAIMED state keeps the original
 *   claim stamp (COALESCE, never re-stamped);
 * - every community-scoped export runs assertCommunityId (throw =
 *   programmer error); record-scoped primitives answer "No such ban
 *   record." instead of throwing at runtime.
 *
 * Header contract (test/registry.test.js): loadDb() runs ABOVE every src/
 * require; all timestamps are injected (T0 + offsets).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();
after(cleanup);

// ── deterministic clock ─────────────────────────────────────────────────────
const T0 = Date.UTC(2026, 10, 1);
const MIN = 60_000;
const LEASE = db.UNBAN_CLAIM_LEASE_MS;

let seq = 0;
const uid = (label = "u") => `772-${label}-${++seq}`;

/** Community-scoped seed that must succeed — a broken seed fails loudly. */
function mk(communityId, userId, over = {}) {
  const res = db.createBanRecord({
    communityId,
    userId,
    source: "staff",
    reason: "raid",
    bannedAt: T0,
    ...over,
  });
  assert.equal(res.ok, true, `seed failed: ${res.error}`);
  return res.record;
}

/** Garbage community ids for the assertCommunityId battery (per typeof msg). */
const GARBAGE_CIDS = ["1554590611015729152", null, undefined, NaN, 1.5, 0, -1];

function assertGuarded(label, call) {
  for (const bad of GARBAGE_CIDS) {
    assert.throws(
      () => call(bad),
      { message: `community id required, got ${typeof bad}` },
      `${label} must run assertCommunityId on ${JSON.stringify(bad) ?? String(bad)}`,
    );
  }
}

describe("banRecords — vocabulary mirrors the 074 CHECK", () => {
  const tableSql = db.db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ban_records'`)
    .get().sql;

  const inList = (clause) =>
    tableSql
      .match(new RegExp(`${clause}\\s+IN \\(([^)]*)\\)`, "i"))[1]
      .split(",")
      .map((s) => s.trim().replace(/'/g, ""));

  it("BAN_RECORD_STATUSES === the schema's status CHECK, exactly", () => {
    assert.deepEqual([...inList("status")], [...db.BAN_RECORD_STATUSES]);
    assert.ok(Object.isFrozen(db.BAN_RECORD_STATUSES), "code-side source is frozen");
  });

  it("BAN_SOURCES === the schema's source CHECK", () => {
    assert.deepEqual([...inList("source")], [...db.BAN_SOURCES]);
    assert.ok(Object.isFrozen(db.BAN_SOURCES));
  });

  it("the unban-claim lease is a minutes-scale window (tickets #419 law)", () => {
    assert.ok(
      Number.isFinite(LEASE) && LEASE >= 5 * MIN && LEASE <= 60 * MIN,
      `lease is a minutes-scale window, got ${LEASE}`,
    );
  });
});

describe("banRecords.nextBanNumber — per-community B-n allocation", () => {
  const CID = communityKey("772-repo-num");
  const CID_B = communityKey("772-repo-num-b");

  it("starts at 1 and increments per createBanRecord", () => {
    assert.equal(db.nextBanNumber(CID), 1, "empty history → B-1");
    const r1 = mk(CID, uid("n1"));
    assert.equal(r1.ban_number, 1);
    const r2 = mk(CID, uid("n2"));
    assert.equal(r2.ban_number, 2);
    assert.equal(db.nextBanNumber(CID), 3);
  });

  it("is PER COMMUNITY — a crowded neighbor never shifts B-1", () => {
    mk(CID_B, uid("x1"));
    mk(CID_B, uid("x2"));
    mk(CID_B, uid("x3"));
    const cidC = communityKey("772-repo-num-c");
    assert.equal(db.nextBanNumber(cidC), 1);
    assert.equal(db.nextBanNumber(CID_B), 4);
  });

  it("never re-issues numbers once rows close (history is append-only)", () => {
    const cid = communityKey("772-repo-num-d");
    const r1 = mk(cid, uid("c1"));
    const r2 = mk(cid, uid("c2"));
    assert.equal(db.markUnbannedManual(r1.id, "lifted").won, true);
    assert.equal(db.markUnbannedManual(r2.id, "lifted").won, true);
    // MAX+1 counts CLOSED rows — a new cycle gets B-3, never a reused B-1.
    const r3 = mk(cid, uid("c3"));
    assert.equal(r3.ban_number, 3);
  });

  it("rejects garbage community ids (programmer error, throws)", () => {
    assertGuarded("nextBanNumber", (bad) => db.nextBanNumber(bad));
  });
});

describe("banRecords.createBanRecord — round-trip + validation battery", () => {
  const CID = communityKey("772-repo-create");

  it("stores every field and returns the LIVE row", () => {
    const res = db.createBanRecord({
      communityId: CID,
      userId: "900000000000000001",
      moderatorId: "  800000000000000002  ",
      source: "automod",
      reason: "  raid protection  ",
      bannedAt: T0,
      // Far-future expiry: keeps this fixture OUT of the listDueExpiredBans
      // sweep windows asserted by the later describe (the sweep is whole-DB,
      // so an expiring fixture here would be load-bearing over there).
      expiresAt: T0 + 100 * MIN,
    });
    assert.equal(res.ok, true, res.error);
    const rec = res.record;
    assert.deepEqual(rec, db.getBanRecord(rec.id), "record is the live row");
    assert.equal(rec.community_id, CID);
    assert.equal(rec.user_id, "900000000000000001");
    assert.equal(rec.moderator_id, "800000000000000002", "moderatorId trims");
    assert.equal(rec.source, "automod");
    assert.equal(rec.reason, "raid protection", "reason trims");
    assert.equal(rec.banned_at, T0, "injected clock lands verbatim");
    assert.equal(rec.expires_at, T0 + 100 * MIN);
    assert.equal(rec.status, "active");
    assert.equal(rec.ban_dm_sent, 0);
    assert.equal(rec.welcome_dm_sent, 0);
    assert.equal(rec.unban_claimed_at, null);
    assert.equal(rec.unban_reason, null);
  });

  it("absent expiresAt = permanent (expires_at NULL is the permanence marker)", () => {
    const rec = mk(CID, uid("perm"));
    assert.equal(rec.expires_at, null);
  });

  it("answers invalid input with SPECIFIC {ok:false,error} — never a throw, never a generic", () => {
    const cases = [
      [{ userId: "" }, /needs the banned user's id/],
      [{ userId: "   " }, /needs the banned user's id/, "blank userId is absent userId"],
      [{ userId: uid("r"), reason: "" }, /Ban reason cannot be empty/],
      [{ userId: uid("s"), reason: "x", source: "admin" }, /Unknown ban source .admin./],
      [{ userId: uid("e"), reason: "x", expiresAt: 0 }, /positive timestamp/],
      [{ userId: uid("e2"), reason: "x", expiresAt: -5 }, /positive timestamp/],
      [{ userId: uid("e3"), reason: "x", expiresAt: "abc" }, /positive timestamp/],
    ];
    for (const [over, pattern, note] of cases) {
      const res = db.createBanRecord({
        communityId: CID,
        userId: uid("default"),
        source: "staff",
        reason: "raid",
        bannedAt: T0,
        ...over,
      });
      assert.equal(res.ok, false, note || JSON.stringify(over));
      assert.match(res.error, pattern);
    }
    // The unknown-source message teaches the closed vocabulary.
    const src = db.createBanRecord({
      communityId: CID,
      userId: uid("s2"),
      source: "owner",
      reason: "x",
    });
    assert.match(src.error, /staff, automod/);
  });

  it("re-checks the 1000-char reason cap so no caller can store an over-cap audit", () => {
    const tooLong = "x".repeat(db.MAX_BAN_REASON + 1);
    const res = db.createBanRecord({
      communityId: CID,
      userId: uid("long"),
      source: "staff",
      reason: tooLong,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /too long \(max 1000 characters\)/);
    // Boundary: exactly at cap stores fine (the command clamps first; the
    // repo must not refuse what it just allowed).
    assert.equal(
      db.createBanRecord({
        communityId: CID,
        userId: uid("cap"),
        source: "staff",
        reason: "y".repeat(db.MAX_BAN_REASON),
      }).ok,
      true,
    );
  });

  it("a second ACTIVE row for the same user → {ok:false, code:ACTIVE_BAN_EXISTS} via the REAL partial UNIQUE", () => {
    const cid = communityKey("772-repo-dup");
    const first = mk(cid, "990000000000000001");
    const dup = db.createBanRecord({
      communityId: cid,
      userId: "990000000000000001",
      source: "staff",
      reason: "again",
      bannedAt: T0,
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, "ACTIVE_BAN_EXISTS");
    assert.match(dup.error, /already has an active ban record/);
    // The original row is untouched and still THE active record.
    assert.equal(db.findActiveBanRecord(cid, "990000000000000001").id, first.id);
  });

  it("after the cycle closes, the user may be banned again with a FRESH number", () => {
    const cid = communityKey("772-repo-recycle");
    const first = mk(cid, "990000000000000002");
    assert.equal(db.finalizeUnban(first.id, "expired_unbanned", null, { nowMs: T0 + MIN }).won, true);
    const second = db.createBanRecord({
      communityId: cid,
      userId: "990000000000000002",
      source: "staff",
      reason: "round two",
      bannedAt: T0 + 2 * MIN,
    });
    assert.equal(second.ok, true, second.error);
    assert.equal(second.record.ban_number, 2, "new cycle, new B-n — ids never reused");
    assert.notEqual(second.record.id, first.id, "#773 appeals key appeal:<id> — ids are stable");
  });

  it("the number-collision message contract (createBanRecord's BAN_NUMBER_RACE matcher) holds at the schema", () => {
    // A live double-allocation needs two OS processes; better-sqlite3 is
    // synchronous in-process. What this suite CAN pin is the contract the
    // matcher depends on: violating uq_ban_records_number produces a message
    // containing "ban_records.ban_number" — the exact substring the repo
    // maps to code BAN_NUMBER_RACE (the schema file pins the index itself).
    const cid = communityKey("772-repo-race-text");
    db.db
      .prepare(
        `INSERT INTO ban_records (community_id, ban_number, user_id, source, reason, banned_at, status)
         VALUES (?, 1, '990000000000000003', 'staff', 'seed', ?, 'active')`,
      )
      .run(cid, T0);
    assert.throws(
      () =>
        db.db
          .prepare(
            `INSERT INTO ban_records (community_id, ban_number, user_id, source, reason, banned_at, status)
             VALUES (?, 1, '990000000000000004', 'staff', 'collision', ?, 'active')`,
          )
          .run(cid, T0),
      (err) => {
        assert.match(err.message, /ban_records\.ban_number/, "repo matcher substring must ride in the message");
        return true;
      },
    );
  });

  it("runs assertCommunityId before anything else", () => {
    assertGuarded("createBanRecord", (bad) =>
      db.createBanRecord({ communityId: bad, userId: "990000000000000009", source: "staff", reason: "x" }),
    );
  });
});

describe("banRecords.findActiveBanRecord / getBanRecord", () => {
  const CID = communityKey("772-repo-find");

  it("returns only ACTIVE rows, scoped to the community", () => {
    const active = mk(CID, "991000000000000001");
    const closed = mk(CID, "991000000000000002");
    db.markUnbannedManual(closed.id, "lifted");

    assert.equal(db.findActiveBanRecord(CID, "991000000000000001").id, active.id);
    assert.equal(db.findActiveBanRecord(CID, "991000000000000002"), null, "closed ≠ active");
    assert.equal(db.findActiveBanRecord(CID, "nobody"), null);

    const other = communityKey("772-repo-find-b");
    assert.equal(db.findActiveBanRecord(other, "991000000000000001"), null, "no cross-community bleed");
  });

  it("blank userId answers null (nothing to look up, no throw)", () => {
    assert.equal(db.findActiveBanRecord(CID, ""), null);
    assert.equal(db.findActiveBanRecord(CID, "   "), null);
    assert.equal(db.findActiveBanRecord(CID, null), null);
  });

  it("getBanRecord coerces numeric-string ids and null-guards garbage", () => {
    const rec = mk(CID, "991000000000000003");
    assert.equal(db.getBanRecord(String(rec.id)).id, rec.id, "id coercion (#773 keys appeal:<id> strings)");
    assert.equal(db.getBanRecord(0), null);
    assert.equal(db.getBanRecord(-1), null);
    assert.equal(db.getBanRecord("abc"), null);
    assert.equal(db.getBanRecord(null), null);
    assert.equal(db.getBanRecord(9_999_999), null, "missing id is null, not a throw");
  });

  it("both exports run assertCommunityId", () => {
    assertGuarded("findActiveBanRecord", (bad) => db.findActiveBanRecord(bad, "991000000000000001"));
    // getBanRecord is RECORD-scoped — garbage record ids answer null, no throw.
    assert.equal(db.getBanRecord({}), null);
  });
});

describe("banRecords.listDueExpiredBans(nowMs) — the ticker sweep", () => {
  const CID = communityKey("772-repo-due");
  const CID_B = communityKey("772-repo-due-b");

  // Seed once: distinct expiry shapes across TWO communities (cross-community
  // sweep is the point).
  const dueA = mk(CID, uid("due-a"), { expiresAt: T0 + 5 * MIN });
  const dueB = mk(CID_B, uid("due-b"), { expiresAt: T0 + 5 * MIN }); // tie → id order
  const later = mk(CID, uid("later"), { expiresAt: T0 + 30 * MIN });
  const permanent = mk(CID, uid("perm"));
  const closed = mk(CID, uid("closed"), { expiresAt: T0 - 10 * MIN });
  db.finalizeUnban(closed.id, "expired_unbanned", null, { nowMs: T0 });

  it("expires_at == now is DUE (boundary is inclusive)", () => {
    const at = T0 + 5 * MIN;
    const due = db.listDueExpiredBans(at).map((r) => r.id);
    assert.deepEqual(due, [dueA.id, dueB.id], "both communities swept, expires ASC then id ASC");
  });

  it("expires_at == now + 1 is NOT yet due", () => {
    const due = db.listDueExpiredBans(T0 + 5 * MIN - 1).map((r) => r.id);
    assert.deepEqual(due, [], "one ms early, nothing due — the boundary is exact");
  });

  it("orders by expires_at ASC, id ASC", () => {
    const earlier = mk(CID, uid("earlier"), { expiresAt: T0 + MIN }); // created LAST, expires FIRST
    const due = db.listDueExpiredBans(T0 + 30 * MIN).map((r) => r.id);
    assert.deepEqual(due, [earlier.id, dueA.id, dueB.id, later.id]);
  });

  it("permanent rows are NEVER due, however far the clock runs", () => {
    const due = db.listDueExpiredBans(T0 + 365 * 24 * 60 * MIN);
    assert.ok(!due.some((r) => r.id === permanent.id), "expires_at NULL = permanent");
  });

  it("only ACTIVE rows ride the sweep (settled past-due rows never re-appear)", () => {
    const dueRows = db.listDueExpiredBans(T0 + 30 * MIN);
    const due = dueRows.map((r) => r.id);
    assert.ok(!due.includes(closed.id), "expired_unbanned is not re-unbanned");
    // Park it out of active too — pending_rejoin must not be swept either.
    assert.ok(
      dueRows.every((r) => r.status === "active"),
      "every swept row is ACTIVE (assert on the ROWS, not the id array)"
    );
  });

  it("is deliberately NOT community-scoped (whole-DB sweep) and reads the default clock arg without throwing", () => {
    assert.ok(db.listDueExpiredBans().length >= 0);
  });
});

describe("banRecords.listReconcilableActiveBans", () => {
  const CID = communityKey("772-repo-recon");

  it("ACTIVE rows of ONE community, newest ban first", () => {
    const old = mk(CID, uid("r1"), { bannedAt: T0 });
    const fresh = mk(CID, uid("r2"), { bannedAt: T0 + 10 * MIN });
    const closed = mk(CID, uid("r3"), { bannedAt: T0 + 20 * MIN });
    db.markUnbannedManual(closed.id);
    mk(communityKey("772-repo-recon-b"), uid("r-other"));

    const rows = db.listReconcilableActiveBans(CID);
    assert.deepEqual(rows.map((r) => r.id), [fresh.id, old.id], "banned_at DESC; closed rows never surface");
  });

  it("runs assertCommunityId", () => {
    assertGuarded("listReconcilableActiveBans", (bad) => db.listReconcilableActiveBans(bad));
  });
});

describe("banRecords.claimUnban — first-click-wins LEASE (tickets #419 law)", () => {
  const CID = communityKey("772-repo-claim");

  it("winner stamps the claim; the racing loser gets won:false + the LIVE row and mutates NOTHING", () => {
    const rec = mk(CID, uid("cl1"));

    const first = db.claimUnban(rec.id, T0);
    assert.equal(first.ok, true);
    assert.equal(first.won, true);
    assert.equal(first.record.unban_claimed_at, T0, "claim stamped at the injected instant");

    // Mid-flight (the outbound unban is "in progress"): second claimer loses
    // and the row is byte-identical — no duplicate outbound-facing churn.
    const second = db.claimUnban(rec.id, T0 + MIN);
    assert.equal(second.won, false);
    assert.equal(second.record.unban_claimed_at, T0, "the stamp rides from the FIRST claimer — stamped exactly once");
    assert.equal(second.record.status, "active", "loser reads truth, changes nothing");

    // …and the ban record itself is untouched by the losing claim.
    assert.equal(db.getBanRecord(rec.id).unban_claimed_at, T0);
  });

  it("lease boundaries: LEASE-1 held, ==LEASE stealable (re-stamp), +1 loses to the NEW holder, 2×LEASE ages again", () => {
    const rec = mk(CID, uid("cl2"));
    assert.equal(db.claimUnban(rec.id, T0).won, true);

    assert.equal(db.claimUnban(rec.id, T0 + LEASE - 1).won, false, "one ms short: live holder keeps it");

    // At maturity the holder is DEAD (crash-wedge) — next ticker pass steals.
    const steal = db.claimUnban(rec.id, T0 + LEASE);
    assert.equal(steal.won, true, "expired lease must never wedge the row forever");
    assert.equal(steal.record.unban_claimed_at, T0 + LEASE, "the steal RE-STAMPS to the stealing instant");

    assert.equal(db.claimUnban(rec.id, T0 + LEASE + 1).won, false, "the new holder owns a fresh lease");
    assert.equal(db.claimUnban(rec.id, T0 + 2 * LEASE).won, true, "the lease is uniform, not a one-shot");
  });

  it("claims only ACTIVE rows — a settled ban loses with the live row (manual race honesty)", () => {
    const rec = mk(CID, uid("cl3"));
    db.finalizeUnban(rec.id, "unbanned_manual", "lifted by hand", { nowMs: T0 });
    const stale = db.claimUnban(rec.id, T0 + MIN);
    assert.equal(stale.ok, true);
    assert.equal(stale.won, false);
    assert.equal(stale.record.status, "unbanned_manual");
  });

  it("unknown record loses cleanly: {ok:true, won:false, record:null}", () => {
    const res = db.claimUnban(9_999_999, T0);
    assert.deepEqual(res, { ok: true, won: false, record: null });
  });

  it("malformed record ids are {ok:false,error} runtime answers — numeric strings coerce (api ids arrive as strings)", () => {
    for (const bad of [0, -1, "", null, undefined, {}, "abc", 1.5]) {
      const res = db.claimUnban(bad, T0);
      assert.equal(res.ok, false, `${JSON.stringify(bad) ?? String(bad)} must be refused`);
      assert.equal(res.error, "No such ban record.");
    }
    const rec = mk(CID, uid("cl4"));
    assert.equal(db.claimUnban(String(rec.id), T0).won, true, "numeric-string id wins the real row");
  });
});

describe("banRecords.finalizeUnban / markUnbannedManual — CAS on status", () => {
  const CID = communityKey("772-repo-final");

  it("settles an UNCLAIMED active row and back-stamps the claim (manual path honesty)", () => {
    const rec = mk(CID, uid("f1"));
    const res = db.finalizeUnban(rec.id, "expired_unbanned", "Expired — auto-unban", { nowMs: T0 + MIN });
    assert.equal(res.ok, true);
    assert.equal(res.won, true);
    assert.equal(res.record.status, "expired_unbanned");
    assert.equal(res.record.unban_reason, "Expired — auto-unban");
    assert.equal(
      res.record.unban_claimed_at,
      T0 + MIN,
      "COALESCE back-fills the never-claimed path with the injected instant",
    );
  });

  it("finalize from the CLAIMED state keeps the ORIGINAL claim stamp (never re-stamps)", () => {
    const rec = mk(CID, uid("f2"));
    db.claimUnban(rec.id, T0); // ticker claimed here
    const res = db.finalizeUnban(rec.id, "expired_unbanned", null, { nowMs: T0 + 1000 });
    assert.equal(res.won, true);
    assert.equal(res.record.status, "expired_unbanned");
    assert.equal(res.record.unban_claimed_at, T0, "the OUTBOUND-facing claim instant survives finalize");
  });

  it("CAS: a manual unban between claim and finalize WINS — the ticker's finalize loses and reports the existing truth", () => {
    const rec = mk(CID, uid("f3"));
    assert.equal(db.claimUnban(rec.id, T0).won, true, "ticker claimed, outbound about to fire");
    // The GuildBanRemove event lands first: the record must tell what ACTUALLY happened.
    assert.equal(db.markUnbannedManual(rec.id, "staff lifted it").won, true);

    const loser = db.finalizeUnban(rec.id, "expired_unbanned", "ticker says expired", { nowMs: T0 + MIN });
    assert.equal(loser.ok, true);
    assert.equal(loser.won, false, "changes===0 — the loser never overwrites");
    assert.equal(loser.record.status, "unbanned_manual");
    assert.equal(
      loser.record.unban_reason,
      "staff lifted it",
      "the losing finalize wrote NOTHING — the manual reason stands",
    );
  });

  it("two settles for one unban settle EXACTLY ONCE (double event safety)", () => {
    const rec = mk(CID, uid("f4"));
    assert.equal(db.markUnbannedManual(rec.id, "event 1").won, true);
    assert.equal(db.markUnbannedManual(rec.id, "event 2").won, false);
    assert.equal(db.getBanRecord(rec.id).unban_reason, "event 1");
  });

  it("the outcome domain is CLOSED — everything outside it is a named refusal", () => {
    const rec = mk(CID, uid("f5"));
    // #773 widened the domain with `clemency_granted` (moved out of this
    // refusal list into its own settle pin below — the appeal outcome is
    // now one of the ways a ban ends; the domain stays CLOSED beyond that).
    for (const status of ["active", "welcomed", "pending_rejoin", "EXPIRED_UNBANNED", ""]) {
      const res = db.finalizeUnban(rec.id, status, null, { nowMs: T0 });
      assert.equal(res.ok, false, `${JSON.stringify(status)} must be refused`);
      assert.match(res.error, /Unknown ban unban outcome/);
      assert.match(res.error, /expired_unbanned, unbanned_manual, clemency_granted/, "the message teaches the domain");
    }
    assert.equal(db.getBanRecord(rec.id).status, "active", "refusals mutate nothing");
  });

  it("clemency_granted settles an ACTIVE row (#773 appeal outcome) — once; the CAS holds", () => {
    const rec = mk(CID, uid("f5c"));
    const res = db.finalizeUnban(rec.id, "clemency_granted", "Ban appeal — clemency granted by staff", {
      nowMs: T0,
    });
    assert.equal(res.ok, true);
    assert.equal(res.won, true, "the clemency settle wins the active-row CAS");
    assert.equal(res.record.status, "clemency_granted");
    assert.equal(res.record.unban_reason, "Ban appeal — clemency granted by staff");

    // The event path arrives late: manual CAS LOSES (clemency owns the row)
    // and reports the live truth — events never overwrite the decision.
    const late = db.markUnbannedManual(rec.id, "GuildBanRemove");
    assert.equal(late.won, false, "the settled clemency row is final");
    assert.equal(late.record.status, "clemency_granted");
    assert.equal(db.getBanRecord(rec.id).unban_reason, "Ban appeal — clemency granted by staff");
  });

  it("unban_reason rides COALESCE: blank/null are ABSENT (never stored), a real one lands once", () => {
    const rec = mk(CID, uid("f6"));
    assert.equal(db.markUnbannedManual(rec.id, "first truth").won, true);
    assert.equal(db.getBanRecord(rec.id).unban_reason, "first truth");

    const rec2 = mk(CID, uid("f7"));
    assert.equal(db.finalizeUnban(rec2.id, "unbanned_manual", "  ", { nowMs: T0 }).won, true);
    assert.equal(db.getBanRecord(rec2.id).unban_reason, null, "blank reason normalizes to absent");

    // A settled row can never carry a second reason (the CAS above) — the
    // COALESCE is the belt, the CAS is the law.
    assert.equal(db.markUnbannedManual(rec.id, "rewrite attempt").won, false);
    assert.equal(db.getBanRecord(rec.id).unban_reason, "first truth");
  });

  it("unknown record: {ok:true, won:false, record:null} — and garbage ids the {ok:false} answer", () => {
    assert.deepEqual(db.finalizeUnban(9_999_999, "expired_unbanned", null, { nowMs: T0 }), {
      ok: true,
      won: false,
      record: null,
    });
    const bad = db.finalizeUnban(null, "expired_unbanned");
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "No such ban record.");
  });

  it("markUnbannedManual stamps the claim even when nobody claimed (record stays honest)", () => {
    const rec = mk(CID, uid("f9"));
    const res = db.markUnbannedManual(rec.id, "GuildBanRemove");
    assert.equal(res.won, true);
    assert.ok(Number(res.record.unban_claimed_at) > 0, "back-stamp present (wall-clock path — existence pinned, value not)");
    assert.equal(res.record.unban_reason, "GuildBanRemove");
  });
});

describe("banRecords.claimWelcome — the cycle's ONE welcome DM", () => {
  const CID = communityKey("772-repo-welcome");

  const settled = () => {
    const rec = mk(CID, uid("w"));
    assert.equal(db.markUnbannedManual(rec.id, "lifted").won, true);
    return rec;
  };

  it("two racing claimers → exactly one won:true; the flag IS the claim (074 decision)", () => {
    const rec = settled();
    const first = db.claimWelcome(rec.id);
    assert.equal(first.ok, true);
    assert.equal(first.won, true, "first-click-wins flips welcome_dm_sent 0→1");
    assert.equal(first.record.welcome_dm_sent, 1);

    const second = db.claimWelcome(rec.id);
    assert.equal(second.won, false, "one welcome per cycle is claim-row law, not event-ordering luck");
    assert.equal(second.record.welcome_dm_sent, 1, "loser reads the stamped live row");
  });

  it("never claims an ACTIVE row (the ban is still on — nothing to welcome)", () => {
    const rec = mk(CID, uid("wa"));
    const res = db.claimWelcome(rec.id);
    assert.equal(res.won, false);
    assert.equal(res.record.welcome_dm_sent, 0, "the loser mutates nothing");
  });

  it("pending_rejoin and welcomed rows are OUT of the claim domain (event-once law)", () => {
    const parked = settled();
    db.markPendingRejoin(parked.id);
    assert.equal(db.claimWelcome(parked.id).won, false, "the rejoin listener owns parked rows");

    const done = settled();
    db.markPendingRejoin(done.id);
    db.markWelcomed(done.id);
    assert.equal(db.claimWelcome(done.id).won, false, "welcomed is terminal");
  });

  it("garbage record id answers {ok:false, error:'No such ban record.'}", () => {
    assert.equal(db.claimWelcome("nope").ok, false);
    assert.equal(db.claimWelcome("nope").error, "No such ban record.");
  });
});

describe("banRecords.markPendingRejoin / markWelcomed — the welcome sub-machine", () => {
  const CID = communityKey("772-repo-park");

  const settled = () => {
    const rec = mk(CID, uid("p"));
    db.markUnbannedManual(rec.id, "lifted");
    return rec;
  };

  it("both unban outcomes can park for the rejoin retry", () => {
    const manual = settled();
    assert.equal(db.markPendingRejoin(manual.id).status, "pending_rejoin");

    const rec = mk(CID, uid("pe"));
    db.finalizeUnban(rec.id, "expired_unbanned", null, { nowMs: T0 });
    assert.equal(db.markPendingRejoin(rec.id).status, "pending_rejoin");
  });

  it("NEVER resurrects or hijacks an ACTIVE row — CAS lost returns the LIVE unchanged row", () => {
    const active = mk(CID, uid("pa"));
    const live = db.markPendingRejoin(active.id);
    assert.equal(live.id, active.id);
    assert.equal(live.status, "active", "parking is restricted to the two unban outcomes");
  });

  it("markWelcomed is the terminal move: pending_rejoin → welcomed, double events change nothing", () => {
    const rec = settled();
    db.markPendingRejoin(rec.id);
    assert.equal(db.markWelcomed(rec.id).status, "welcomed");
    // Terminal REGARDLESS of DM outcome (issue §5) — a second GuildMemberAdd must not re-open.
    const again = db.markWelcomed(rec.id);
    assert.equal(again.status, "welcomed");
    assert.equal(again.welcome_dm_sent, db.getBanRecord(rec.id).welcome_dm_sent, "second pass is a pure read");
  });

  it("markWelcomed cannot skip the park (only pending_rejoin is CAS-able)", () => {
    const rec = settled();
    const live = db.markWelcomed(rec.id);
    assert.equal(live.status, "unbanned_manual", "welcomed is reached THROUGH pending_rejoin only");
  });

  it("missing / garbage record ids answer null (no throw)", () => {
    assert.equal(db.markPendingRejoin(9_999_999), null);
    assert.equal(db.markWelcomed(9_999_999), null);
    assert.equal(db.markPendingRejoin("x"), null);
    assert.equal(db.markWelcomed(0), null);
  });
});

describe("banRecords DM flags — recordBanDmSent / recordWelcomeDmSent", () => {
  const CID = communityKey("772-repo-flags");

  it("ban DM stamp: first true, second false (one ban DM per cycle is the CALLER's law, the flag records it)", () => {
    const rec = mk(CID, uid("dm"));
    assert.equal(db.recordBanDmSent(rec.id), true);
    assert.equal(db.getBanRecord(rec.id).ban_dm_sent, 1);
    assert.equal(db.recordBanDmSent(rec.id), false, "already stamped — no double DM");
  });

  it("welcome recorder stamps an unstamped row and reports an already-stamped one as false", () => {
    const rec = mk(CID, uid("wdm"));
    db.markUnbannedManual(rec.id);
    assert.equal(db.recordWelcomeDmSent(rec.id), true, "rejoin-retry success lands in the record");
    assert.equal(db.recordWelcomeDmSent(rec.id), false);
  });

  it("claimWelcome IS the stamp — the recorder then reports false (claim === stamp on the locked schema)", () => {
    const rec = mk(CID, uid("both"));
    db.markUnbannedManual(rec.id);
    assert.equal(db.claimWelcome(rec.id).won, true);
    assert.equal(db.recordWelcomeDmSent(rec.id), false, "no second welcome can sneak past the claim");
    assert.equal(db.getBanRecord(rec.id).welcome_dm_sent, 1);
  });

  it("garbage / missing ids answer false, never throw", () => {
    assert.equal(db.recordBanDmSent(9_999_999), false);
    assert.equal(db.recordWelcomeDmSent("x"), false);
    assert.equal(db.recordBanDmSent(null), false);
  });
});

describe("banRecords — the status machine, end to end (injected clock throughout)", () => {
  it("auto path: create → due → claim → finalize → welcome-claim → park → welcomed", () => {
    const cid = communityKey("772-repo-walk-auto");
    const rec = mk(cid, uid("auto"), { expiresAt: T0 + 10 * MIN });
    assert.equal(db.recordBanDmSent(rec.id), true, "K2: DM went out before the ban");

    // Ticker pass at the expiry instant: due → claim → finalize.
    assert.ok(db.listDueExpiredBans(T0 + 10 * MIN).some((r) => r.id === rec.id));
    assert.equal(db.claimUnban(rec.id, T0 + 10 * MIN).won, true);
    assert.equal(
      db.finalizeUnban(rec.id, "expired_unbanned", "Expired — auto-unban", { nowMs: T0 + 10 * MIN + 500 })
        .won,
      true,
    );

    // Welcome DM fails → park for the rejoin retry → rejoin attempt (once).
    assert.equal(db.claimWelcome(rec.id).won, true);
    assert.equal(db.markPendingRejoin(rec.id).status, "pending_rejoin");
    assert.equal(db.markWelcomed(rec.id).status, "welcomed");

    const final = db.getBanRecord(rec.id);
    assert.equal(final.status, "welcomed");
    assert.equal(final.ban_dm_sent, 1);
    assert.equal(final.welcome_dm_sent, 1, "claim flip at unban time is the cycle's one welcome");
    assert.equal(final.unban_claimed_at, T0 + 10 * MIN, "the claimer's instant, finalize never re-stamped");
    assert.equal(final.unban_reason, "Expired — auto-unban");

    // Settled out of every queue: no active row, no due rows left behind.
    assert.equal(db.findActiveBanRecord(cid, final.user_id), null);
    assert.ok(!db.listDueExpiredBans(T0 + 90 * MIN).some((r) => r.id === rec.id));
  });

  it("manual + rejoin-retry path: event settles it, welcome lands on rejoin WITHOUT a prior claim", () => {
    const cid = communityKey("772-repo-walk-manual");
    const rec = mk(cid, uid("man"), { expiresAt: T0 + MIN });

    // Staff lifts the ban outside the bot → GuildBanRemove → CAS settle.
    assert.equal(db.markUnbannedManual(rec.id, "staff lift").won, true);
    // Welcome not sent at unban time (toggle off / DM fail) → park directly.
    assert.equal(db.markPendingRejoin(rec.id).status, "pending_rejoin");
    assert.equal(db.markWelcomed(rec.id).status, "welcomed");
    assert.equal(db.recordWelcomeDmSent(rec.id), true, "the retry success is recorded explicitly");

    const final = db.getBanRecord(rec.id);
    assert.equal(final.status, "welcomed");
    assert.equal(final.welcome_dm_sent, 1);
    assert.equal(final.unban_reason, "staff lift");
  });
});
