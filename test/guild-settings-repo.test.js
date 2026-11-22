"use strict";

/**
 * #905 item 2 (audit r4 F10b): `updateGuildSettings` must bind ONLY the
 * allow-listed patch keys plus its own scope columns. The old spread of the
 * raw patch let a caller-supplied `community_id` (or `updated_at`) key
 * overwrite the scope bind — better-sqlite3 takes the LAST bind for a
 * duplicate name — silently retargeting the UPDATE at another community's
 * row while returning the caller's own (cross-tenant write; latent until a
 * caller forwards a request body). The SET clause was always allow-listed;
 * the PARAMETERS were not.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(() => cleanup());

const rawRow = (cid) =>
  db.db.prepare(`SELECT * FROM guild_settings WHERE community_id=?`).get(cid);

test("a community_id key inside the patch cannot retarget the UPDATE", () => {
  const a = communityKey("f10b-a");
  const b = communityKey("f10b-b");
  // B exists first, holding its own value (the probe's community 9).
  db.updateGuildSettings(b, { msg_xp: 11 });
  const bBefore = rawRow(b);
  assert.equal(bBefore.msg_xp, 11);

  // The probe from the issue: community A writes WITH a foreign
  // community_id (B) in the patch. Pre-fix the bind object's LATER
  // community_id won — B's row moved, A's did not, and the call still
  // RETURNED A as the "after" picture.
  db.updateGuildSettings(a, { community_id: b, msg_xp: 50 });

  const aRow = rawRow(a);
  const bRow = rawRow(b);
  assert.equal(aRow.msg_xp, 50, "the intended row took the write");
  assert.equal(bRow.msg_xp, 11, "#905: the foreign row was NOT touched");
});

test("an updated_at key inside the patch cannot forge the scope bind", () => {
  const a = communityKey("f10b-c");
  db.updateGuildSettings(a, { msg_xp: 1 }); // materialize the row
  const t0 = Date.now();
  db.updateGuildSettings(a, { updated_at: 1, reaction_xp: 7 });
  const row = rawRow(a);
  assert.equal(row.reaction_xp, 7, "the real key still lands");
  assert.ok(Number(row.updated_at) >= t0, `updated_at stays the DB's clock (got ${row.updated_at})`);
});

test("ordinary writes and the allow-list gate still behave", () => {
  const a = communityKey("f10b-d");
  db.updateGuildSettings(a, { msg_xp: 123, definitely_not_a_column: 999999 });
  const row = rawRow(a);
  assert.equal(row.msg_xp, 123);
  assert.equal(row.definitely_not_a_column, undefined, "unknown keys are inert");
});
