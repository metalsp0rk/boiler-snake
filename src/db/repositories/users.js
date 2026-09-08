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

/**
 * Point-read one user's row (web profile existence check). No row ⇒ the bot
 * has never tracked XP for this member in this guild. Read-only (unlike
 * getXp, never seeds or clamps-writes).
 * @param {string} guildId
 * @param {string} userId
 * @returns {{ user_id: string, xp: number }|null}
 */
function getUser(guildId, userId) {
  const row = db
    .prepare(`SELECT user_id, xp FROM users WHERE guild_id=? AND user_id=?`)
    .get(guildId, userId);
  if (!row) return null;
  return { user_id: row.user_id, xp: clampXpTotal(row.xp) };
}

/** Web user search never returns more than this many rows (§8.6 budget). */
const SEARCH_LIMIT = 50;

/**
 * Search tracked users of ONE guild by snowflake text (web users index).
 *
 * Boundedness (§8.6): the users table stores NO display names, so name/LIKE
 * search is impossible without a per-request Discord fan-out; this helper
 * therefore answers EXACT and PREFIX id matches only — both served by the
 * (guild_id, user_id) PK index, no scans. Non-digit queries can never match
 * a numeric id and short-circuit to [] WITHOUT touching the DB.
 * LIKE metacharacters are escaped with ESCAPE '\' so junk input cannot
 * widen the pattern (defense in depth — the digit guard already blocks %).
 *
 * @param {string} guildId
 * @param {string} query raw search text (trimmed by the caller)
 * @param {{ limit?: number }} [opts]
 * @returns {{ user_id: string, xp: number }[]}
 */
function searchUsers(guildId, query, opts = {}) {
  const q = String(query ?? "").trim();
  // Snowflake-ish guard: digits only, 1..20 chars. Anything else matches no
  // id, and we refuse to run a scan-shaped query for it.
  if (!/^[0-9]{1,20}$/.test(q)) return [];

  const limit = Math.min(Math.max(Number(opts.limit) || SEARCH_LIMIT, 1), SEARCH_LIMIT);

  // Two index-friendly point/prefix reads, merged exact-first (§ PK use).
  const exact = db
    .prepare(`SELECT user_id, xp FROM users WHERE guild_id=? AND user_id=?`)
    .all(guildId, q);
  if (exact.length >= limit) {
    return exact.slice(0, limit).map((r) => ({ user_id: r.user_id, xp: clampXpTotal(r.xp) }));
  }
  const like = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const prefix = db
    .prepare(
      `SELECT user_id, xp FROM users
       WHERE guild_id=? AND user_id LIKE ? ESCAPE '\\'
       ORDER BY user_id ASC
       LIMIT ?`
    )
    .all(guildId, `${like}%`, limit);

  const seen = new Set(exact.map((r) => r.user_id));
  const out = [...exact, ...prefix.filter((r) => !seen.has(r.user_id))].slice(0, limit);
  return out.map((r) => ({ user_id: r.user_id, xp: clampXpTotal(r.xp) }));
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
  getUser,
  searchUsers,
  SEARCH_LIMIT,
  topUsers,
  allUsersInGuild,
};
