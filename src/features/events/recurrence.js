/**
 * Recurrence occurrence math (phase 3, roadmap/community-events.md §12.3).
 *
 * Pure UTC math — instants in, instants out; the ticker owns persistence.
 * A series stores: cadence (daily|weekly|monthly), a weekday mask (weekly),
 * a month day (monthly), and a UTC time-of-day (minutes past midnight),
 * taken from the seed event at creation time.
 *
 * Monthly rule (locked with the design): if a month does not have the day
 * (e.g. day 31 in April), that month is SKIPPED — no clamping to month end.
 */

/** Minutes-past-midnight of an instant in UTC. */
function minutesOfDayUtc(atMs) {
  const d = new Date(atMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function daysInMonthUtc(year, monthIdx0) {
  // Day 0 of month+1 == last day of monthIdx0.
  return new Date(Date.UTC(year, monthIdx0 + 1, 0)).getUTCDate();
}

/**
 * First occurrence instant STRICTLY AFTER `afterMs` matching the series
 * cadence/time-of-day, or { ok:false, ended:true } when the end condition
 * rules it out.
 *
 * @param {object} series {cadence, weekdays:number[], monthDay, timeOfDayMin,
 *                         endMode:'never'|'count'|'until', endAt, endCount,
 *                         occurrencesCreated}
 * @param {number} afterMs previous occurrence start (or seed start)
 * @param {number} [nowMs] lower bound — never return a slot already in the
 *        past by more than a minute (catch-up guard)
 */
function nextOccurrence(series, afterMs, nowMs = afterMs) {
  const tod = Number.isFinite(series.timeOfDayMin) ? series.timeOfDayMin : 0;
  const floor = Math.max(afterMs, nowMs - 60_000);
  const guard = (at) => {
    if (at == null || !Number.isFinite(at)) return { ok: false, error: "recurrence math failed" };
    if (series.endMode === "until" && series.endAt != null && at > series.endAt) {
      return { ok: false, ended: true };
    }
    return { ok: true, atMs: at };
  };

  if (series.cadence === "daily") {
    let at = slotAfterDaily(floor, tod);
    return guard(at);
  }

  if (series.cadence === "weekly") {
    const mask = new Set((series.weekdays || []).map(Number).filter((n) => n >= 0 && n <= 6));
    if (!mask.size) return { ok: false, error: "weekly series need at least one weekday" };
    for (let i = 0; i <= 8; i++) {
      const day = new Date(floor);
      day.setUTCDate(day.getUTCDate() + i);
      if (!mask.has(day.getUTCDay())) continue;
      const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + tod * 60_000;
      if (at > floor) return guard(at);
    }
    return { ok: false, error: "weekly search exhausted (impossible)" };
  }

  if (series.cadence === "monthly") {
    const dayOfMonth = Number(series.monthDay);
    if (!(dayOfMonth >= 1 && dayOfMonth <= 31))
      return { ok: false, error: "monthly series need month_day 1..31" };
    const from = new Date(floor);
    let y = from.getUTCFullYear();
    let m = from.getUTCMonth();
    for (let step = 0; step < 48; step++) {
      if (daysInMonthUtc(y, m) >= dayOfMonth) {
        const at = Date.UTC(y, m, dayOfMonth) + tod * 60_000;
        if (at > floor) return guard(at);
      }
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
    return { ok: false, ended: true }; // 4 years with no matching day is impossible; safety net
  }

  return { ok: false, error: `unknown cadence ${series.cadence}` };
}

/** Next daily slot strictly after `floor` (every calendar day at `tod`). */
function slotAfterDaily(floor, tod) {
  const d = new Date(floor);
  const todaySlot =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + tod * 60_000;
  if (todaySlot > floor) return todaySlot;
  return todaySlot + 86_400_000;
}

/** Whether creating another occurrence is allowed by end_mode=count. */
function countAllows(series) {
  if (series.endMode !== "count") return true;
  return (series.occurrences_created ?? series.occurrencesCreated ?? 0) < Number(series.endCount);
}

/** Derive the series shape from a seed event's start instant. */
function seriesShapeFromStart(cadence, startMs, { weekdays = null, monthDay = null } = {}) {
  const d = new Date(startMs);
  return {
    cadence,
    weekdays:
      weekdays ??
      (cadence === "weekly" ? [d.getUTCDay()] : []),
    monthDay:
      monthDay ?? (cadence === "monthly" ? d.getUTCDate() : null),
    timeOfDayMin: minutesOfDayUtc(startMs),
  };
}

module.exports = {
  nextOccurrence,
  countAllows,
  daysInMonthUtc,
  minutesOfDayUtc,
  seriesShapeFromStart,
};
