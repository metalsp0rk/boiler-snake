/**
 * Weekly/daily event digest (epic #218, phase 4).
 *
 * `event_guild_settings` carries the per-community digest config (channel,
 * daily/weekly/none, UTC hour, weekday). The ticker calls runDigestTick once
 * a minute; a guild is due when its boundary timestamp for the current
 * window has passed and nothing was sent since (digest_last_sent_at gate,
 * one send per window even across restarts).
 */
const repo = require("../../db/repositories/events");
const service = require("./service");

/**
 * One digest pass: every configured guild that is due gets its upcoming-
 * events roundup. Failures are logged per guild and never abort the pass.
 * @param {object} client
 * @param {number} [nowMs]
 */
async function runDigestTick(client, nowMs = Date.now()) {
  let sent = 0;
  let failed = 0;
  const settingsRows = repo.listDigestSettings();
  for (const settings of settingsRows) {
    try {
      const due = service.digestDueBoundary(settings, nowMs);
      if (due == null) continue;
      const res = await service.sendDigest(client, settings);
      if (res.ok) sent += 1;
      else {
        failed += 1;
        console.error(
          `[events] digest guild=${settings.community_id}: ${res.error}`
        );
      }
    } catch (err) {
      failed += 1;
      console.error(
        `[events] digest guild=${settings.community_id} failed:`,
        err?.message || err
      );
    }
  }
  return { sent, failed, considered: settingsRows.length };
}

module.exports = { runDigestTick };
