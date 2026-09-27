/**
 * EventSub subscription reconciler (roadmap/twitch-notifications.md).
 *
 * Desired state: one `stream.online` + `stream.offline` webhook
 * subscription per TRACKED broadcaster (unique across guilds — a
 * subscription is app-scoped, not guild-scoped), capped at
 * cfg.maxChannels so a small app-token quota can't be blown (channels past
 * the cap stay covered by the polling ticker — the fast path is an
 * optimization, never the only path).
 *
 * Reconcile runs hourly + after /twitch add|remove (fire-and-forget):
 *  1. ensure a row + a Twitch subscription for each wanted broadcaster
 *     (409 = already exists, keeps the returned id);
 *  2. retry rows in error/revoked/verification_failed states;
 *  3. prune rows whose broadcaster no guild tracks anymore (DELETE remote);
 *  4. best-effort: pull Twitch's view of verification-failed subs so a
 *     botched challenge round-trip self-heals on the next sweep.
 *
 * All Helix access is injectable for offline tests. Every entry point here
 * is fire-and-forget safe: it logs and returns a summary, never throws.
 */

const db = require("../../../db");
const { getEventsubConfig } = require("./config");
const {
  createEventsubSubscription,
  deleteEventsubSubscription,
  listEventsubSubscriptions,
} = require("../helix");

const SUB_TYPES = ["stream.online", "stream.offline"];

/**
 * Whether the next sweep must (re)create this subscription.
 * Healthy/in-flight states (enabled, verification_pending, or a pending row
 * that already captured a subscription id) are left alone. A `pending` row
 * with NO subscription id is a stuck create (Twitch 202 without an id) and
 * gets retried; error / revoked:* / verification_failed / unknown are retried.
 */
function needsCreate(row) {
  if (!row) return true;
  const s = String(row.status || "");
  if (s === "enabled" || s === "verification_pending") return false;
  if (s === "pending") return !row.subscription_id;
  return true;
}

function mapTwitchStatus(status, conflict) {
  if (conflict) return "enabled";
  switch (String(status || "")) {
    case "enabled":
      return "enabled";
    case "webhook_callback_verification_pending":
      return "verification_pending";
    case "":
    case "null":
      return "pending";
    default:
      return String(status);
  }
}

/** Unique numeric broadcaster ids currently tracked by at least one guild. */
function getTrackedBroadcasterIds() {
  const ids = new Set();
  for (const row of db.getAllTwitchChannels()) {
    if (/^\d+$/.test(row.broadcaster_id)) ids.add(row.broadcaster_id);
  }
  return [...ids];
}

/**
 * Ensure the two webhook subscriptions for one broadcaster.
 * @param {string} broadcasterId
 * @param {object} cfg getEventsubConfig() result
 * @param {object} [deps]
 * @returns {Promise<{ created: number, failed: number }>}
 */
async function ensureBroadcasterSubs(broadcasterId, cfg, deps = {}) {
  const create = deps.createEventsubSubscription || createEventsubSubscription;
  let created = 0;
  let failed = 0;

  for (const type of SUB_TYPES) {
    const existing = db.getTwitchEventsubSub(type, broadcasterId);
    if (!needsCreate(existing)) continue;

    const res = await create({
      type,
      version: "1",
      condition: { broadcaster_user_id: broadcasterId },
      callback: cfg.callbackUrl,
      secret: cfg.secret,
    });

    if (res?.ok) {
      created += 1;
      db.upsertTwitchEventsubSub({
        type,
        broadcasterId,
        subscriptionId: res.subscription?.id ?? null,
        status: mapTwitchStatus(res.subscription?.status, res.conflict),
        lastError: null,
      });
    } else {
      failed += 1;
      const error = res?.error || `HTTP ${res?.status ?? "?"}`;
      console.error(
        `[twitch] EventSub create failed (${type}/${broadcasterId}): ${error}`,
      );
      // COALESCE in the upsert keeps any prior subscription_id so a later
      // prune can still DELETE the Twitch-side sub.
      db.upsertTwitchEventsubSub({
        type,
        broadcasterId,
        subscriptionId: res?.subscription?.id ?? null,
        status: "error",
        lastError: String(error).slice(0, 200),
      });
    }
  }
  return { created, failed };
}

/**
 * Delete + untrack a broadcaster's subs (call only when NO guild tracks it
 * anymore — the /twitch remove path checks that first).
 */
async function dropBroadcasterSubs(broadcasterId, deps = {}) {
  const del = deps.deleteEventsubSubscription || deleteEventsubSubscription;
  for (const row of db.getTwitchEventsubSubsForBroadcaster(broadcasterId)) {
    if (row.subscription_id) {
      const res = await del(row.subscription_id);
      if (!res?.ok) {
        console.error(
          `[twitch] EventSub delete failed (${row.type}/${broadcasterId} id=${row.subscription_id}): HTTP ${res?.status ?? "network"}`,
        );
      }
    }
    db.deleteTwitchEventsubSub(row.type, broadcasterId);
  }
}

/**
 * /twitch remove hook: prune EventSub subs for a broadcaster that no guild
 * tracks anymore. Fire-and-forget safe.
 */
async function pruneBroadcasterIfUntracked(broadcasterId, deps = {}) {
  try {
    if (db.getTwitchSubsByBroadcaster(broadcasterId).length > 0) {
      return { skipped: "still-tracked" };
    }
    await dropBroadcasterSubs(broadcasterId, deps);
    return { pruned: true };
  } catch (err) {
    console.error(
      `[twitch] EventSub prune failed for ${broadcasterId}:`,
      err?.message || err,
    );
    return { error: err?.message || String(err) };
  }
}

/**
 * /twitch add hook: best-effort immediate subscription (the hourly sweep is
 * the backstop). Fire-and-forget safe.
 */
async function syncBroadcaster(broadcasterId, deps = {}) {
  try {
    const cfg = (deps.getConfig || getEventsubConfig)();
    if (!cfg.enabled) return { skipped: "disabled" };
    if (!/^\d+$/.test(String(broadcasterId || ""))) return { skipped: "unresolved" };
    return await ensureBroadcasterSubs(String(broadcasterId), cfg, deps);
  } catch (err) {
    console.error(
      `[twitch] EventSub sync failed for ${broadcasterId}:`,
      err?.message || err,
    );
    return { error: err?.message || String(err) };
  }
}

/**
 * Full reconcile sweep. Returns a summary (also logged). Never throws.
 * @param {object} [deps]
 */
async function reconcileEventsubSubscriptions(deps = {}) {
  try {
    const cfg = (deps.getConfig || getEventsubConfig)();
    if (!cfg.enabled) {
      return { skipped: "disabled", missing: cfg.missing };
    }

    const tracked = getTrackedBroadcasterIds();
    const wanted = tracked.slice(0, cfg.maxChannels);
    if (tracked.length > wanted.length) {
      console.warn(
        `[twitch] EventSub cap hit: ${tracked.length} tracked broadcasters > TWITCH_EVENTSUB_MAX_CHANNELS=${cfg.maxChannels}; the rest stay polling-only`,
      );
    }
    const wantedSet = new Set(wanted);
    const trackedSet = new Set(tracked);

    let created = 0;
    let failed = 0;
    for (const id of wanted) {
      const r = await ensureBroadcasterSubs(id, cfg, deps);
      created += r.created;
      failed += r.failed;
    }

    // Prune locals whose broadcaster is no longer in the wanted set
    // (untracked, or tracked but cut by maxChannels → frees quota).
    let pruned = 0;
    const toPrune = new Set();
    for (const row of db.getTwitchEventsubSubs()) {
      if (!wantedSet.has(row.broadcaster_id)) toPrune.add(row.broadcaster_id);
    }
    for (const broadcasterId of toPrune) {
      await dropBroadcasterSubs(broadcasterId, deps);
      pruned += 1;
    }

    // Self-heal botched challenge round-trips: Twitch's own view of
    // verification failures marks matching rows for the NEXT sweep.
    const list = deps.listEventsubSubscriptions || listEventsubSubscriptions;
    try {
      const failedSubs = await list({
        status: "webhook_callback_verification_failed",
      });
      for (const sub of failedSubs || []) {
        const bid = sub?.condition?.broadcaster_user_id;
        if (bid && db.isValidEventsubType(sub?.type)) {
          db.markTwitchEventsubSubStatus(
            sub.type,
            bid,
            "verification_failed",
            "challenge never completed",
          );
        }
      }
    } catch (err) {
      console.error(
        "[twitch] EventSub verification-failure sweep failed:",
        err?.message || err,
      );
    }

    const summary = {
      tracked: tracked.length,
      wanted: wanted.length,
      created,
      failed,
      pruned,
    };
    if (created || failed || pruned) {
      console.log(`[twitch] EventSub reconcile: ${JSON.stringify(summary)}`);
    }
    return summary;
  } catch (err) {
    console.error("[twitch] EventSub reconcile failed:", err?.message || err);
    return { error: err?.message || String(err) };
  }
}

module.exports = {
  SUB_TYPES,
  needsCreate,
  getTrackedBroadcasterIds,
  ensureBroadcasterSubs,
  dropBroadcasterSubs,
  pruneBroadcasterIfUntracked,
  syncBroadcaster,
  reconcileEventsubSubscriptions,
};
