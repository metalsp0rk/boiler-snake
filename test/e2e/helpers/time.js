/**
 * Time anchors for forced-clock e2e tests (#470 G2-7).
 *
 * The rule (test/README.md #5): when a test FORCES the execution clock
 * (`runEventsTick(nowMs)`) but CONFIGURES with the real one, the config is
 * silently wrong whenever the forced instant lands in a different UTC hour —
 * digestDueBoundary placed the daily boundary in the future and the digest
 * suite failed deterministically… only at UTC 20:00–23:59 (#382: schedule
 * luck masquerading as green CI). Derive every clock-derived setup value
 * from the SAME forced instant.
 */

/**
 * The UTC hour the FORCED tick will consider "now" — the only legitimate
 * source for hour_utc-style configuration when a future nowMs is injected.
 *
 * @param {number} forcedNowMs epoch ms handed to runEventsTick/twin seams
 * @returns {number} 0–23
 */
function forcedHourFor(forcedNowMs) {
  return new Date(Number(forcedNowMs)).getUTCHours();
}

module.exports = { forcedHourFor };
