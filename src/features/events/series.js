/**
 * Recurring event series (epic #218, phase 3).
 *
 * A series is a cadence (daily/weekly/monthly) anchored on a template event.
 * The ticker's `series` step materializes the next occurrence when the
 * cursor comes due: a fresh event is created (copied content + options, same
 * attendee role), posted immediately, and the cursor advances. Ending by
 * count/until stops the series.
 *
 * Occurrence starts are UTC instants (E3): the series stores time-of-day in
 * MINUTES AFTER UTC MIDNIGHT, so "every Tue 19:00" is unambiguous.
 */
// The db FACADE (not the repository module) — services mutate community state
// through it (same posture as service.js), which also keeps every write
// observable to the web gates' facade recorder (§8.8 mutation ladder).
const repo = require("../../db");
const { nextOccurrence, countAllows } = require("./recurrence");

/** DB row → recurrence.js camelCase shape (weekdays pre-parsed by repo). */
function shapeOf(series) {
  let weekdays = [];
  if (Array.isArray(series.weekdays)) weekdays = series.weekdays.map(Number);
  else {
    try {
      weekdays = JSON.parse(series.weekdays || "[]").map(Number);
    } catch {
      weekdays = [];
    }
  }
  return {
    cadence: series.cadence,
    weekdays,
    monthDay: series.month_day,
    timeOfDayMin: series.time_of_day_min,
    endMode: series.end_mode,
    endCount: series.end_count,
    endAt: series.end_at,
    occurrences_created: series.occurrences_created,
  };
}

/**
 * Create a series from its seed (template) event. `next_occurrence_at` is
 * seeded to the first slot AFTER the template's start.
 */
function createFromEvent(event, { cadence, weekdays = [], monthDay = null, endMode = "never", endCount = null, endUntilMs = null, createdBy }) {
  const timeOfDayMin = Math.floor((event.start_at % 86_400_000) / 60_000);
  const seeded = {
    cadence,
    weekdays,
    monthDay,
    timeOfDayMin,
    endMode,
    endCount,
    endAt: endUntilMs,
  };
  const next = nextOccurrence(seeded, event.start_at, event.start_at);
  if (!next.ok) return { ok: false, error: next.error || "recurrence never produces a next date" };
  const nextAt = next.atMs;
  const monthDayResolved = cadence === "monthly" ? (monthDay ?? new Date(event.start_at).getUTCDate()) : monthDay;
  return repo.createEventSeries({
    communityId: event.community_id,
    templateEventId: event.id,
    cadence,
    weekdays,
    monthDay: monthDayResolved,
    timeOfDayMin,
    endMode,
    endCount,
    endAt: endUntilMs,
    nextOccurrenceAt: nextAt,
    createdBy,
  });
}

/**
 * Copy a template event into its next occurrence at `startMs`.
 * Signups never carry over; the attendee role is reused (existing mode) so
 * the recurring crowd keeps one role.
 */
function materializeOccurrence(series, startMs) {
  const template = repo.getEventById(series.template_event_id);
  if (!template) {
    repo.stopEventSeries(series.id, "template missing");
    return { ok: false, error: `series ${series.id}: template event gone — stopped` };
  }
  if (!countAllows({ ...shapeOf(series), occurrences_created: (series.occurrences_created || 0) + 1 })) {
    // +1: the template event itself counts as occurrence #1 of end_count.
    repo.stopEventSeries(series.id, "count reached");
    return { ok: false, ended: true };
  }
  const duration = template.duration_minutes ?? null;
  const src = repo.listEventOptions(template.id);
  const created = repo.createEvent({
    communityId: template.community_id,
    creatorId: template.creator_id,
    title: template.title,
    status: "draft",
    startAt: startMs,
    channelId: template.channel_id,
    description: template.description,
    location: template.location,
    duration_minutes: template.duration_minutes,
    end_at: duration ? startMs + duration * 60_000 : null,
    image_url: template.image_url,
    color: template.color,
    announce_role_ids: template.announce_role_ids,
    attendee_role_id: template.attendee_role_id,
    attendee_role_existing: template.attendee_role_existing,
    role_mode: template.role_mode,
    cutoff_at: null,
    role_whitelist: template.role_whitelist,
    multiple_signups: template.multiple_signups,
    thread_enabled: template.thread_enabled,
    thread_private: template.thread_private,
    series_id: series.id,
    options: src.map((o) => ({
      label: o.label,
      emoji: o.emoji,
      capacity: o.capacity,
      waitlist_on: o.waitlist_on,
      reminders_on: o.reminders_on,
      role_whitelist: o.role_whitelist,
    })),
  });
  if (!created.ok) return created;
  // Cutoff defaults to the template's *relative* cutoff if it had none set —
  // keep simple: copy absolute offset from start when template had one.
  if (template.cutoff_at && template.start_at) {
    const delta = template.cutoff_at - template.start_at;
    repo.updateEvent(created.event.id, { cutoff_at: startMs + delta });
  }
  repo.updateEventSeries(series.id, {
    next_occurrence_at: null, // caller advances after successful post
    occurrences_created: (series.occurrences_created || 0) + 1,
  });
  repo.logEventActivity({
    eventId: created.event.id,
    actorId: null,
    action: "series_materialized",
    detail: `series ${series.id} occurrence ${series.occurrences_created + 1}`,
  });
  return { ok: true, event: created.event };
}

/** Advance the cursor to the next occurrence after `afterMs` (or stop). */
function advanceCursor(series, afterMs) {
  const next = nextOccurrence(shapeOf(series), afterMs, afterMs);
  if (!next.ok) {
    repo.stopEventSeries(series.id, next.ended ? "series end reached" : next.error);
    repo.updateEventSeries(series.id, { next_occurrence_at: null });
    return { stopped: true, reason: next.ended ? "ended" : next.error };
  }
  repo.updateEventSeries(series.id, { next_occurrence_at: next.atMs });
  return { stopped: false, nextAt: next.atMs };
}

/** Skip the given occurrence: cancel it + advance the cursor if it was next. */
function skipOccurrence(event) {
  if (!event.series_id) return { ok: false, error: `Event **${event.id}** is not part of a series.` };
  const series = repo.getEventSeries(event.series_id);
  if (!series || series.status !== "active") {
    return { ok: false, error: "That series is not active." };
  }
  // schema CHECK vocabulary (042): 'skipped' — 'cancelled' would throw a
  // constraint error and dead-end /eventconfig series skip in the router.
  repo.updateEvent(event.id, { status: "skipped" });
  if (series.next_occurrence_at != null && event.start_at >= series.next_occurrence_at - 86_400_000) {
    advanceCursor(series, series.next_occurrence_at);
  }
  repo.logEventActivity({
    eventId: event.id,
    actorId: null,
    action: "series_skipped",
    detail: `series ${series.id}`,
  });
  return { ok: true, seriesId: series.id };
}

function stopSeries(event, by = null) {
  if (!event.series_id) return { ok: false, error: `Event **${event.id}** is not part of a series.` };
  const res = repo.stopEventSeries(event.series_id, by ? `stopped by ${by}` : "stopped");
  return res && res.ok !== undefined ? res : { ok: true };
}

function listActive(communityId) {
  return repo.listEventSeries(communityId, { activeOnly: true });
}

module.exports = {
  shapeOf,
  createFromEvent,
  materializeOccurrence,
  advanceCursor,
  skipOccurrence,
  stopSeries,
  listActive,
};
