const { db, now } = require("../connection");
const { MAX_SAFE_XP, clampDelta, clampXpTotal } = require("../../core/xpMath");

function ensureUser(guildId, userId) {
  const t = now();
  db.prepare(`
  INSERT INTO users (guild_id, user_id, xp, created_at, updated_at)
  VALUES (?, ?, 0, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET updated_at=excluded.updated_at
  `).run(guildId, userId, t, t);
}

/**
 * Atomic XP update (prevents lost updates on concurrent events).
 * Also clamps XP to a JS-safe range to prevent Infinity/precision loss.
 * Returns the new XP.
 */
function addXp(guildId, userId, delta) {
  const tx = db.transaction((gId, uId, d) => {
    ensureUser(gId, uId);
    const t = now();

    const currentRow = db
      .prepare(`SELECT xp FROM users WHERE guild_id=? AND user_id=?`)
      .get(gId, uId);
    const currentXp = clampXpTotal(currentRow?.xp ?? 0);

    let safeDelta = clampDelta(d);

    if (safeDelta > 0) {
      const headroom = MAX_SAFE_XP - currentXp;
      safeDelta = Math.min(safeDelta, headroom);
    } else if (safeDelta < 0) {
      safeDelta = -Math.min(Math.abs(safeDelta), currentXp);
    }

    if (safeDelta === 0) return currentXp;

    db.prepare(`
      UPDATE users
      SET xp = MIN(?, MAX(0, xp + ?)),
          updated_at = ?
      WHERE guild_id=? AND user_id=?
    `).run(MAX_SAFE_XP, safeDelta, t, gId, uId);

    const row = db
      .prepare(`SELECT xp FROM users WHERE guild_id=? AND user_id=?`)
      .get(gId, uId);

    const safeXp = clampXpTotal(row?.xp ?? 0);
    if (row && row.xp !== safeXp) {
      db.prepare(`
        UPDATE users
        SET xp=?, updated_at=?
        WHERE guild_id=? AND user_id=?
      `).run(safeXp, now(), gId, uId);
    }
    return safeXp;
  });

  return tx(guildId, userId, delta);
}

function setXp(guildId, userId, xp) {
  ensureUser(guildId, userId);
  const safe = clampXpTotal(xp);

  db.prepare(`
  UPDATE users
  SET xp=?, updated_at=?
  WHERE guild_id=? AND user_id=?
  `).run(safe, now(), guildId, userId);
}

function getXp(guildId, userId) {
  const row = db.prepare(`SELECT xp FROM users WHERE guild_id=? AND user_id=?`).get(guildId, userId);
  const safe = clampXpTotal(row?.xp ?? 0);

  if (row && row.xp !== safe) {
    db.prepare(`
    UPDATE users
    SET xp=?, updated_at=?
    WHERE guild_id=? AND user_id=?
    `).run(safe, now(), guildId, userId);
  }

  return safe;
}

function topUsers(guildId, limit = 10) {
  const rows = db.prepare(`
  SELECT user_id, xp
  FROM users
  WHERE guild_id=?
  ORDER BY xp DESC
  LIMIT ?
  `).all(guildId, limit);

  let changed = false;
  const out = rows.map((r) => {
    const safe = clampXpTotal(r.xp);
    if (r.xp !== safe) changed = true;
    return { user_id: r.user_id, xp: safe };
  });

  if (changed) {
    const t = now();
    const stmt = db.prepare(`
    UPDATE users
    SET xp=?, updated_at=?
    WHERE guild_id=? AND user_id=?
    `);
    const tx = db.transaction(() => {
      for (const r of out) {
        stmt.run(r.xp, t, guildId, r.user_id);
      }
    });
    tx();
  }

  return out;
}

function allUsersInGuild(guildId) {
  const rows = db.prepare(`
  SELECT user_id, xp
  FROM users
  WHERE guild_id=?
  `).all(guildId);

  return rows.map((r) => ({ user_id: r.user_id, xp: clampXpTotal(r.xp) }));
}

module.exports = {
  ensureUser,
  addXp,
  setXp,
  getXp,
  topUsers,
  allUsersInGuild,
};
