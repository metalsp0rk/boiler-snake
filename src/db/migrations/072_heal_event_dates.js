/**
 * Heal non-numeric event date columns (web-ui polish pass).
 *
 * The Community Events calendar rendered a literal "NaN" wherever a stored
 * instant had degraded to TEXT. SQLite's INTEGER affinity stores anything
 * it cannot numeric-convert AS TEXT (type affinity, not coercion): a TEXT
 * date like '2026-06-06 20:00', or the string 'NaN' left by a historical
 * writer that stringified a computed NaN — the exact corruption family
 * migration 005 clamped in `users.xp`. The web calendar renders whatever
 * the row holds, so one bad row poisons the page.
 *
 * Repair per targeted column (events.*, event_reminder_offsets.fire_at,
 * event_series.next_occurrence_at), in order:
 *   1. REAL values  → integer ms (drop the float dust; SQLite NaN is NULL).
 *   2. parseable TEXT instants (ISO / 'YYYY-MM-DD HH:MM[:SS]') → ms instant
 *      via strftime('%s'). Pure numeric strings never reach here — affinity
 *      already stored them as integers.
 *   3. junk TEXT ('NaN', '', gibberish): nullable columns → NULL (the UI
 *      says "—" / "on approval" / "no cutoff"); events.start_at (NOT NULL)
 *      → its created_at; reminder fire_at → 0 + sent_at stamped, preserving
 *      the row's effective behavior (a TEXT fire_at compared against the
 *      numeric ticker clock NEVER matched due date — numbers sort before
 *      text in SQLite — so the reminder never fired and never will).
 *
 * Safe to re-run: after one pass every targeted column is integer/NULL and
 * each statement matches nothing.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ now: () => number }} helpers
 */

/** SQLite parses these TEXT shapes; anything else returns NULL from strftime. */
const parseableMs = (col) =>
  `CAST(strftime('%s', replace(replace(${col}, 'T', ' '), 'Z', '')) AS INTEGER) * 1000`;
const parsesToMs = (col) =>
  `strftime('%s', replace(replace(${col}, 'T', ' '), 'Z', '')) IS NOT NULL`;

function up(db, { now }) {
  // 1. REAL dust → INTEGER ms.
  db.prepare(
    `UPDATE events SET start_at = CAST(start_at AS INTEGER) WHERE typeof(start_at) = 'real'`
  ).run();
  for (const col of ["end_at", "post_at", "cutoff_at"]) {
    db.prepare(
      `UPDATE events SET ${col} = CAST(${col} AS INTEGER) WHERE typeof(${col}) = 'real'`
    ).run();
  }
  db.prepare(
    `UPDATE event_reminder_offsets SET fire_at = CAST(fire_at AS INTEGER) WHERE typeof(fire_at) = 'real'`
  ).run();
  db.prepare(
    `UPDATE event_series SET next_occurrence_at = CAST(next_occurrence_at AS INTEGER)
      WHERE typeof(next_occurrence_at) = 'real'`
  ).run();

  // 2. Parseable TEXT dates → ms instant.
  db.prepare(
    `UPDATE events SET start_at = ${parseableMs("start_at")}
      WHERE typeof(start_at) = 'text' AND ${parsesToMs("start_at")}`
  ).run();
  for (const col of ["end_at", "post_at", "cutoff_at"]) {
    db.prepare(
      `UPDATE events SET ${col} = ${parseableMs(col)}
        WHERE typeof(${col}) = 'text' AND ${parsesToMs(col)}`
    ).run();
  }
  db.prepare(
    `UPDATE event_reminder_offsets SET fire_at = ${parseableMs("fire_at")}
      WHERE typeof(fire_at) = 'text' AND ${parsesToMs("fire_at")}`
  ).run();
  db.prepare(
    `UPDATE event_series SET next_occurrence_at = ${parseableMs("next_occurrence_at")}
      WHERE typeof(next_occurrence_at) = 'text' AND ${parsesToMs("next_occurrence_at")}`
  ).run();

  // 3. Unparseable junk.
  //  events.start_at (NOT NULL): fall back to the row's created_at so the
  //  event still lands on a real day; created_at itself broken ⇒ epoch.
  db.prepare(
    `UPDATE events
        SET start_at = CASE WHEN typeof(created_at) = 'integer' THEN created_at ELSE 0 END
      WHERE typeof(start_at) <> 'integer' AND start_at IS NOT NULL`
  ).run();
  // Nullable event instants → NULL (honest "—" / "on approval" / "no cutoff").
  for (const col of ["end_at", "post_at", "cutoff_at"]) {
    db.prepare(
      `UPDATE events SET ${col} = NULL
        WHERE ${col} IS NOT NULL AND typeof(${col}) <> 'integer'`
    ).run();
  }
  db.prepare(
    `UPDATE event_series SET next_occurrence_at = NULL
      WHERE next_occurrence_at IS NOT NULL AND typeof(next_occurrence_at) <> 'integer'`
  ).run();
  // Reminder fire_at: keep its never-due behavior and stamp it settled so
  // the console stops offering a reminder that could never fire.
  db.prepare(
    `UPDATE event_reminder_offsets
        SET fire_at = 0, sent_at = COALESCE(sent_at, ?)
      WHERE typeof(fire_at) <> 'integer' OR fire_at IS NULL`
  ).run(now());
}

module.exports = { id: "072_heal_event_dates", up };
