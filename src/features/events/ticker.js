/**
 * Community events scheduler (epic #218).
 *
 * ONE cron job, ordered steps — a step failure is logged and the next step
 * still runs (AGENTS: never kill the loop):
 *   1. postDue      — drafts with post_at due → post (CAS claim + failure
 *                     backoff mirroring feature 2's 038 contract)
 *   2. reminders    — due event_notifications rows → deliver / retry / retire
 *   3. series       — materialize due occurrences and post them
 *   4. autoArchive  — E8: posted events past end+delay → archived
 *   5. digest       — daily/weekly roundups (once per window)
 *   6. crosspending — delayed destination copies whose due passed
 *   7. cleanup      — expired preview drafts + stale DM wizards
 */
const { registerJob } = require("../../core/scheduler");
const repo = require("../../db/repositories/events");
const service = require("./service");
const series = require("./series");
const digest = require("./digest");

const TICK_CRON = "* * * * *";

async function stepPostDue(client, nowMs) {
  let posted = 0;
  let failed = 0;
  const due = repo.claimDueScheduledPosts(nowMs);
  for (const event of due) {
    try {
      const res = await service.postEventNow(client, event, { announce: true });
      if (res.ok) posted += 1;
      else {
        failed += 1;
        const back = repo.recordEventPostFailure(event.id, res.error || "post failed");
        console.error(
          `[events] scheduled post event=${event.id} failed${
            back?.nextAttemptAt ? ` (retry ${new Date(back.nextAttemptAt).toISOString()})` : " (gave up)"
          }: ${res.error}`
        );
      }
    } catch (err) {
      failed += 1;
      repo.recordEventPostFailure(event.id, err?.message || String(err));
      console.error(`[events] scheduled post event=${event.id} threw:`, err?.message || err);
    }
  }
  return { posted, failed };
}

async function stepReminders(client, nowMs) {
  let sent = 0;
  let retried = 0;
  let retired = 0;
  const due = repo.claimDueEventReminders(nowMs);
  for (const row of due) {
    try {
      const res = await service.deliverReminder(client, row);
      if (res.status === "sent") {
        repo.markEventReminderSent(row.id, res.messageId);
        sent += 1;
      } else if (res.status === "retired") {
        repo.retireEventReminder(row.id, res.reason);
        retired += 1;
      } else {
        const back = repo.markEventReminderRetry(row.id, res.reason || "delivery failed");
        if (back?.terminal) retired += 1;
        else retried += 1;
        console.error(
          `[events] reminder row=${row.id} event=${row.event_id} retry: ${res.reason}`
        );
      }
    } catch (err) {
      const back = repo.markEventReminderRetry(row.id, err?.message || String(err));
      if (back?.terminal) retired += 1;
      else retried += 1;
      console.error(
        `[events] reminder row=${row.id} event=${row.event_id} threw:`,
        err?.message || err
      );
    }
  }
  return { sent, retried, retired };
}

async function stepSeries(client, nowMs) {
  let materialized = 0;
  let stopped = 0;
  for (const s of repo.listDueEventSeries(nowMs)) {
    try {
      const res = series.materializeOccurrence(s, s.next_occurrence_at);
      if (!res.ok) {
        if (!res.ended) {
          console.error(`[events] series ${s.id} materialize failed: ${res.error}`);
        } else {
          stopped += 1;
        }
        continue;
      }
      const post = await service.postEventNow(client, res.event, { announce: true });
      if (!post.ok) {
        console.error(
          `[events] series ${s.id} occurrence ${res.event.id} post failed: ${post.error}`
        );
        series.advanceCursor(s, s.next_occurrence_at);
        continue;
      }
      series.advanceCursor(s, s.next_occurrence_at);
      materialized += 1;
    } catch (err) {
      console.error(`[events] series ${s.id} tick failed:`, err?.message || err);
    }
  }
  return { materialized, stopped };
}

async function stepAutoArchive(client, nowMs) {
  let archived = 0;
  for (const event of repo.listEventsToAutoArchive(nowMs)) {
    try {
      const res = await service.archiveEvent(client, event, { reason: "auto-archive" });
      if (res && res.ok === false) {
        console.error(`[events] auto-archive event=${event.id}: ${res.error}`);
      } else {
        archived += 1;
      }
    } catch (err) {
      console.error(`[events] auto-archive event=${event.id} threw:`, err?.message || err);
    }
  }
  return { archived };
}

async function stepCleanup(client, nowMs) {
  let drafts = 0;
  try {
    for (const draft of repo.listExpiredDrafts(nowMs)) {
      const res = await service.deleteEvent(client, draft, { removeDiscord: false });
      if (res && res.ok === false) {
        console.error(`[events] draft cleanup event=${draft.id}: ${res.error}`);
      } else {
        drafts += 1;
      }
    }
  } catch (err) {
    console.error("[events] draft cleanup failed:", err?.message || err);
  }
  let wizards = 0;
  try {
    wizards = repo.deleteStaleEventWizards(nowMs);
  } catch (err) {
    console.error("[events] wizard cleanup failed:", err?.message || err);
  }
  return { drafts, wizards };
}

/**
 * One full tick in order. Exported for integration tests (they call it
 * directly instead of waiting on cron).
 * @param {object} client
 */
async function runEventsTick(client, nowMs = Date.now()) {
  const out = {};
  const steps = [
    ["postDue", () => stepPostDue(client, nowMs)],
    ["reminders", () => stepReminders(client, nowMs)],
    ["series", () => stepSeries(client, nowMs)],
    ["autoArchive", () => stepAutoArchive(client, nowMs)],
    ["digest", () => digest.runDigestTick(client, nowMs)],
    ["crosspending", async () => {
      const x = require("./crosspost");
      return x.deliverPending(client, nowMs);
    }],
    ["cleanup", () => stepCleanup(client, nowMs)],
  ];
  for (const [name, fn] of steps) {
    try {
      out[name] = await fn();
    } catch (err) {
      out[name] = { error: err?.message || String(err) };
      console.error(`[events] tick step ${name} failed:`, err?.message || err);
    }
  }
  return out;
}

function startEventsTicker(client) {
  registerJob({
    name: "events",
    cron: TICK_CRON,
    delayFirstMs: 6_000,
    run: () => runEventsTick(client),
  });
}

module.exports = {
  TICK_CRON,
  runEventsTick,
  startEventsTicker,
  stepPostDue,
  stepReminders,
  stepSeries,
  stepAutoArchive,
  stepCleanup,
};
