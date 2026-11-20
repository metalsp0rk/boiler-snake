/**
 * #824 (audit B1-1) — every EventSub row remembers what it was bound to.
 *
 * Rotating `TWITCH_EVENTSUB_SECRET` or moving the callback URL
 * (`PUBLIC_BASE_URL` / `TWITCH_EVENTSUB_CALLBACK_URL`) left every
 * Twitch-side subscription bound to the OLD secret/callback while the
 * local row stayed `enabled`: deliveries 403 the HMAC, Twitch revokes,
 * the revocation delivery itself 403s (signed with the old secret), and
 * `needsCreate` skips `enabled` unconditionally — the fast path dies
 * silently while `/twitch settings` keeps printing "enabled". The
 * reconciler COULD detect staleness only if the row recorded what it was
 * created with — and the schema recorded nothing.
 *
 *  - `callback_url` — the exact callback the create request carried.
 *  - `secret_fingerprint` — sha256 hex of the HMAC secret. NEVER the
 *    secret itself (token-storage law): a mismatch is all the reconciler
 *    needs; a match proves the live config can verify the deliveries.
 *
 * Both NULL on pre-#824 rows — which the stale rule reads as UNPROVEN
 * (recreate once on the next sweep, then the binding is on record).
 * Purely additive; nothing existing changes shape.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "twitch_eventsub_subs",
    "callback_url",
    "callback_url TEXT",
  );
  addColumnIfMissing(
    "twitch_eventsub_subs",
    "secret_fingerprint",
    "secret_fingerprint TEXT",
  );
}

module.exports = { id: "079_twitch_eventsub_binding", up };
