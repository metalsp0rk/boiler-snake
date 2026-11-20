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

const crypto = require("node:crypto");
const db = require("../../../db");
const { getEventsubConfig } = require("./config");
const {
  createEventsubSubscription,
  deleteEventsubSubscription,
  listEventsubSubscriptions,
} = require("../helix");

const SUB_TYPES = ["stream.online", "stream.offline"];

/**
 * #824 (audit B1-1): sha256 hex of the EventSub HMAC secret. The row stores
 * the FINGERPRINT, never the secret (token-storage law) — a comparison is
 * all the reconciler needs to notice a rotation.
 */
function eventsubSecretFingerprint(secret) {
  return crypto.createHash("sha256").update(String(secret ?? "")).digest("hex");
}

/**
 * #824: a healthy row is STALE when its recorded binding cannot be the one
 * the live config would create: rotated secret, moved callback URL, or NO
 * recorded binding at all (pre-#824 rows are UNPROVEN — recreate once and
 * the proof lands). Only checked when the config actually carries both
 * halves (an incomplete config never reaches the reconciler anyway).
 */
function subBindingIsStale(row, cfg) {
  if (!row || !cfg || !cfg.secret || !cfg.callbackUrl) return false;
  if (row.secret_fingerprint !== eventsubSecretFingerprint(cfg.secret)) return true;
  if (row.callback_url !== cfg.callbackUrl) return true;
  return false;
}

/**
 * Whether the next sweep must (re)create this subscription.
 * Healthy/in-flight states (enabled, verification_pending, or a pending row
 * that already captured a subscription id) are left alone — UNLESS the
 * recorded binding is stale (#824: a rotated secret/moved callback strands
 * the Twitch-side sub silently; the row says `enabled`, Twitch is
 * 403-ing every delivery, and only the fingerprint comparison can see it).
 * A `pending` row with NO subscription id is a stuck create (Twitch 202
 * without an id) and gets retried; error / revoked:* / verification_failed
 * / unknown are retried.
 */
function needsCreate(row, cfg = null) {
  if (!row) return true;
  const s = String(row.status || "");
  if (s === "enabled" || s === "verification_pending") return subBindingIsStale(row, cfg);
  if (s === "pending") return !row.subscription_id ? true : subBindingIsStale(row, cfg);
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
  const del = deps.deleteEventsubSubscription || deleteEventsubSubscription;
  let created = 0;
  let failed = 0;

  // #824: the binding a create THIS SWEEP performs carries — recorded on
  // the row so a future rotation is detectable.
  const fingerprint = cfg && cfg.secret ? eventsubSecretFingerprint(cfg.secret) : null;

  for (const type of SUB_TYPES) {
    const existing = db.getTwitchEventsubSub(type, broadcasterId);
    if (!needsCreate(existing, cfg)) continue;

    // #824 rebind: the row proves a Twitch-side sub exists on a binding the
    // world has moved past (rotated secret / moved callback — or no proof
    // at all, pre-#824). Best-effort DELETE the old sub FIRST: it is
    // already dead (deliveries 403), it burns app quota, and Twitch
    // 409-conflicts the new create while it lives. A failed delete does
    // NOT block the create — the 409-conflict path keeps the row honest,
    // and the quota bleed, not the row, is the worst case.
    if (existing?.subscription_id && subBindingIsStale(existing, cfg)) {
      try {
        const dropped = await del(existing.subscription_id);
        if (!dropped?.ok) {
          console.error(
            `[twitch] EventSub rebind delete failed (${type}/${broadcasterId} id=${existing.subscription_id}): HTTP ${dropped?.status ?? "network"} — creating anyway (a conflict keeps the row honest)`,
          );
        }
      } catch (err) {
        console.error(
          `[twitch] EventSub rebind delete threw (${type}/${broadcasterId}):`,
          err?.message || err,
        );
      }
    }

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
        callbackUrl: cfg.callbackUrl ?? null,
        secretFingerprint: fingerprint,
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
        callbackUrl: cfg.callbackUrl ?? null,
        secretFingerprint: fingerprint,
      });
    }
  }
  return { created, failed };
}

/**
 * Delete + untrack a broadcaster's subs (call only when NO guild tracks it
 * anymore — the /twitch remove path checks that first).
 *
 * #477 (INT-13): a failed remote delete NO LONGER drops the local row. The
 * row — subscription_id included — is the only record of the Twitch-side
 * subscription; deleting it orphaned the sub on Twitch forever (a real
 * quota bleed: the app quota is small, no later sweep could find the id to
 * DELETE it, and every new broadcaster then failed create with quota
 * errors "error"-marked hourly forever). Failure keeps the row as
 * `prune_pending` and the hourly reconcile prune retries it; a 404 arrives
 * as ok+gone from helix (already deleted elsewhere → untracking is right).
 */
async function dropBroadcasterSubs(broadcasterId, deps = {}) {
  const del = deps.deleteEventsubSubscription || deleteEventsubSubscription;
  for (const row of db.getTwitchEventsubSubsForBroadcaster(broadcasterId)) {
    if (row.subscription_id) {
      const res = await del(row.subscription_id);
      if (!res?.ok) {
        const error = `delete failed (HTTP ${res?.status ?? "network"})`;
        console.error(
          `[twitch] EventSub delete failed (${row.type}/${broadcasterId} id=${row.subscription_id}): HTTP ${res?.status ?? "network"} — keeping the row as prune_pending for the next sweep`,
        );
        db.markTwitchEventsubSubStatus(
          row.type,
          broadcasterId,
          "prune_pending",
          error.slice(0, 200),
        );
        continue;
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
      // #198 (audit §6 P1): per-broadcaster isolation — one broadcaster whose
      // create path throws must not skip the remaining broadcasters, and the
      // prune pass below must still run this sweep.
      try {
        const r = await ensureBroadcasterSubs(id, cfg, deps);
        created += r.created;
        failed += r.failed;
      } catch (err) {
        failed += 1;
        console.error(
          `[twitch] EventSub reconcile failed for broadcaster ${id}:`,
          err?.message || err,
        );
      }
    }

    // Prune locals whose broadcaster is no longer in the wanted set
    // (untracked, or tracked but cut by maxChannels → frees quota).
    let pruned = 0;
    const toPrune = new Set();
    for (const row of db.getTwitchEventsubSubs()) {
      if (!wantedSet.has(row.broadcaster_id)) toPrune.add(row.broadcaster_id);
    }
    for (const broadcasterId of toPrune) {
      try {
        await dropBroadcasterSubs(broadcasterId, deps);
        pruned += 1;
      } catch (err) {
        // One failing prune must not strand the remaining orphans.
        console.error(
          `[twitch] EventSub prune failed for broadcaster ${broadcasterId}:`,
          err?.message || err,
        );
      }
    }

    // Self-heal botched round-trips: Twitch's own view marks matching rows
    // for the NEXT sweep. #824 widened the pull: a rotated secret kills
    // deliveries with `notification_failures_exceeded`, and the revocation
    // delivery is itself signed with the OLD secret (403'd, never
    // recorded) — without this list the local row stays `enabled` forever
    // even in Twitch's own view. The fingerprint rule catches the same
    // rows; this makes the LOCAL status honest about what Twitch did.
    const list = deps.listEventsubSubscriptions || listEventsubSubscriptions;
    const SELF_HEAL_STATUSES = [
      ["webhook_callback_verification_failed", "verification_failed"],
      ["notification_failures_exceeded", "notification_failures_exceeded"],
      ["revoked", "revoked"],
    ];
    for (const [twitchStatus, localStatus] of SELF_HEAL_STATUSES) {
      try {
        const failedSubs = await list({ status: twitchStatus });
        for (const sub of failedSubs || []) {
          const bid = sub?.condition?.broadcaster_user_id;
          if (bid && db.isValidEventsubType(sub?.type)) {
            db.markTwitchEventsubSubStatus(
              sub.type,
              bid,
              localStatus,
              twitchStatus === "webhook_callback_verification_failed"
                ? "challenge never completed"
                : `twitch status: ${twitchStatus}`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[twitch] EventSub ${twitchStatus} sweep failed:`,
          err?.message || err,
        );
      }
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
  // #824 pure seams (unit-pinned): the binding proof + the staleness rule.
  eventsubSecretFingerprint,
  subBindingIsStale,
  getTrackedBroadcasterIds,
  ensureBroadcasterSubs,
  dropBroadcasterSubs,
  pruneBroadcasterIfUntracked,
  syncBroadcaster,
  reconcileEventsubSubscriptions,
};
