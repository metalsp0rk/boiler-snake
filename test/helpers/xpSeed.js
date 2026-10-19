"use strict";

/**
 * Absolute XP seeding for TESTS only — #472 (XE-8).
 *
 * The absolute XP write used to live in production: `users.setXp` was
 * exported through the db facade with zero runtime callers. H10/#191
 * deliberately replaced that write style with column-relative updates
 * (addXp / applyDecay compute from the CURRENT column — "never from a
 * value the caller snapshotted earlier"), so a reviveable absolute-write
 * on the hardened XP module was a standing invitation to reintroduce the
 * lost-update class, silently bypassing the award funnel. The facade
 * binding is gone; deterministic seeding (fixtures need an EXACT XP, not a
 * delta) now lives here, beside the tests that legitimately need it.
 *
 * Semantics mirror the deleted production function: ensure the row, write
 * the clamped absolute value, refresh updated_at. Production XP writes go
 * through awardXp/addXp — never through a helper like this one.
 *
 * @param {object} api db facade (loadDb()/require("src/db")) — needs .db
 * @param {number} communityId internal communities.id
 * @param {string} userId
 * @param {number} xp absolute XP value to land
 */
function seedXp(api, communityId, userId, xp) {
  const { clampXpTotal } = require("../../src/core/xpMath");
  const t = Date.now();
  // Same upsert ensureUser performs (row creation with 0 XP).
  api.db
    .prepare(
      `INSERT INTO users (community_id, user_id, xp, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(community_id, user_id) DO UPDATE SET updated_at=excluded.updated_at`,
    )
    .run(communityId, userId, t, t);
  api.db
    .prepare(
      "UPDATE users SET xp=?, updated_at=? WHERE community_id=? AND user_id=?",
    )
    .run(clampXpTotal(xp), t, communityId, userId);
}

module.exports = { seedXp };
