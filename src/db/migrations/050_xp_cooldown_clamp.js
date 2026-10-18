/**
 * XP cooldown clamp (#429, audit XE-2).
 *
 * `msg_cooldown_sec` / `reaction_cooldown_sec` were never bounded: an admin
 * (or an old web write) could store e.g. 86400, while the in-memory award
 * dedupe maps were swept at 6 h — entries evicted mid-window, `last = 0`,
 * and XP awarded up to 4× a day while the setting LOOKED applied. The write
 * path now clamps to MAX_CONFIG_COOLDOWN_SEC (24 h); this migration pulls any
 * legacy out-of-range rows inside it so the sweep can never truncate them.
 *
 * @param {import("better-sqlite3").Database} db
 */
function up(db) {
  db.prepare(
    `UPDATE guild_settings
        SET msg_cooldown_sec = ?
      WHERE msg_cooldown_sec IS NOT NULL AND msg_cooldown_sec > ?`,
  ).run(86_400, 86_400);
  db.prepare(
    `UPDATE guild_settings
        SET reaction_cooldown_sec = ?
      WHERE reaction_cooldown_sec IS NOT NULL AND reaction_cooldown_sec > ?`,
  ).run(86_400, 86_400);
}

module.exports = { id: "050_xp_cooldown_clamp", up };
