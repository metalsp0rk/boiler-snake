/**
 * #831 (audit D1-3) — a payload generation counter for the bridge outbox.
 *
 * The relay's edit path is TWO phases: phase 1 enqueues (and an edit that
 * arrives while another edit is pending REPLACES the pending row's payload
 * in place), phase 2 spools attachment bytes asynchronously and writes the
 * spooled descriptors back with `updateOutboxPayloadIfPending` — whose only
 * guard was `state='pending'`. A slow phase-2 spool resolving AFTER a newer
 * edit replaced the same row stomped the newer payload back to the stale
 * one: a silent lost-update, made invisible because the snapshot hash had
 * already moved (re-applying the lost content coalesced away).
 *
 * `payload_seq` numbers every phase-1 payload write (INSERT starts at 1;
 * an in-place edit replacement bumps it). Phase 2 CASes on
 * `id + state='pending' + payload_seq`: a stale generation's late write
 * lands on 0 changes — the newer edit stands. DEFAULT 0 marks the
 * pre-#831 rows: rows a previous build wrote carry no generation anyone
 * can CAS against, which the CAS rule reads honestly (a seq-less legacy
 * call keeps the state-only behavior — the create path, whose payload is
 * never replaced in place).
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  addColumnIfMissing(
    "bridge_outbox",
    "payload_seq",
    "payload_seq INTEGER NOT NULL DEFAULT 0",
  );
}

module.exports = { id: "080_bridge_payload_seq", up };
