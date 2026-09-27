/**
 * EventSub webhook callback (POST /hooks/twitch on the public web server).
 *
 * Contract (dev.twitch.tv/docs/eventsub/handling-webhook-events):
 *  - every delivery is HMAC-SHA256 signed with the subscription secret over
 *    messageId + timestamp + RAW BODY, hex, prefixed "sha256=" — verify
 *    FIRST, timing-safe, always; reject with 403 otherwise;
 *  - webhook_callback_verification → 200 with the RAW challenge string as
 *    the body (never JSON-wrapped) — this is how a subscription gets
 *    enabled;
 *  - notification → answer 204 immediately and process AFTER the response
 *    (slow handlers get subscriptions revoked via
 *    notification_failures_exceeded);
 *  - revocation → record why (204). user_removed rows are dropped — the
 *    channel is gone; everything else stays for the reconciler.
 *
 * Dedup across the EventSub path and the polling ticker is delegated to the
 * claim-first helpers in processSubscription (same last_stream_id
 * watermark), so Twitch's at-least-once redelivery can never double-post.
 *
 * The route itself is mounted on src/web (carve-out past its method gate);
 * this module only touches req.rawBody (drained by the body-cap
 * middleware) and writes raw responses.
 */

const crypto = require("crypto");
const db = require("../../../db");
const { parseTwitchTimestamp, fetchStreams } = require("../helix");
const { getEventsubConfig } = require("./config");
const { processSubscription } = require("../ticker");

const MESSAGE_ID_HEADER = "twitch-eventsub-message-id";
const MESSAGE_TIMESTAMP_HEADER = "twitch-eventsub-message-timestamp";
const MESSAGE_SIGNATURE_HEADER = "twitch-eventsub-message-signature";
const MESSAGE_TYPE_HEADER = "twitch-eventsub-message-type";

const HMAC_PREFIX = "sha256=";
/** Replay brake: reject deliveries older than this (Twitch retries stay well inside). */
const MAX_MESSAGE_AGE_MS = 10 * 60_000;

let warnedDisabled = false;

function respond(res, status, body = "") {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

/**
 * Verify the Twitch HMAC signature. `rawBody` must be the EXACT bytes
 * received (Buffer or string). Fail-closed on any missing input.
 *
 * @param {{ secret: string, messageId: string, timestamp: string,
 *   rawBody: Buffer|string, signature: string, nowMs?: number }} input
 * @returns {boolean}
 */
function verifyEventsubHmac({
  secret,
  messageId,
  timestamp,
  rawBody,
  signature,
  nowMs = Date.now(),
}) {
  if (!secret || !messageId || !timestamp || !signature) return false;

  const sentMs = parseTwitchTimestamp(timestamp);
  if (sentMs == null) return false;
  if (Math.abs(nowMs - sentMs) > MAX_MESSAGE_AGE_MS) return false;

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const expected =
    HMAC_PREFIX +
    crypto
      .createHmac("sha256", secret)
      .update(messageId + timestamp + bodyStr)
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Process one notification after the 204 went out. stream.online is
 * enriched with one Helix /streams lookup (the event payload lacks
 * title/game/thumbnail) and degrades to a minimal event-derived stream on
 * fetch failure — the poller re-sends nothing thanks to stream-id dedup.
 * Fan-out: every guild tracking the broadcaster gets its own
 * processSubscription pass (per-guild settings + claim dedup).
 *
 * @param {object|null} client
 * @param {object} payload parsed EventSub body ({ subscription, event })
 * @param {object} [deps]
 * @param {(ids: string[]) => Promise<Array<object>|null>} [deps.fetchStreams]
 */
async function dispatchEventsubNotification(client, payload, deps = {}) {
  const type = payload?.subscription?.type;
  const event = payload?.event;
  const broadcasterId = event?.broadcaster_user_id;
  if (!type || !event || !broadcasterId) return;

  if (type !== "stream.online" && type !== "stream.offline") return;

  const fetch = deps.fetchStreams || fetchStreams;
  let stream;
  if (type === "stream.online") {
    let live = null;
    try {
      live = await fetch([String(broadcasterId)]);
    } catch (err) {
      console.error("[twitch] EventSub stream enrich fetch failed:", err?.message || err);
    }
    if (Array.isArray(live)) {
      stream = live.find((s) => String(s.user_id) === String(broadcasterId)) || null;
    }
    if (!stream) {
      // Minimal fallback: event.id IS the Helix stream id, so dedup stays
      // consistent with the poller even when enrichment failed.
      stream = {
        id: event.id || null,
        user_id: String(broadcasterId),
        title: null,
        started_at: event.started_at || null,
      };
      if (!stream.id) {
        console.error(
          `[twitch] EventSub stream.online without a stream id for ${broadcasterId}; leaving it to the poller`,
        );
        return;
      }
    }
  } else {
    stream = undefined; // offline path
  }

  if (!client) {
    console.error(
      "[twitch] EventSub notification but no Discord client wired — leaving state to the poller",
    );
    return;
  }

  const subs = db.getTwitchSubsByBroadcaster(broadcasterId);
  for (const sub of subs) {
    try {
      await processSubscription(client, sub.guild_id, sub, stream);
    } catch (err) {
      console.error(
        `[twitch] EventSub ${type} handling failed for guild ${sub.guild_id}/${sub.login}:`,
        err?.message || err,
      );
    }
  }
}

/** Record why Twitch revoked a subscription (204 still required). */
function handleRevocation(subscription) {
  const type = subscription?.type;
  const broadcasterId = subscription?.condition?.broadcaster_user_id;
  const status = subscription?.status || "unknown";
  console.warn(
    `[twitch] EventSub subscription revoked: ${type} broadcaster=${broadcasterId ?? "?"} status=${status}`,
  );
  if (!type || !broadcasterId) return;
  if (!db.isValidEventsubType(type)) return;
  if (status === "user_removed") {
    db.deleteTwitchEventsubSub(type, broadcasterId);
    return;
  }
  const marked = db.markTwitchEventsubSubStatus(type, broadcasterId, `revoked:${status}`);
  if (!marked) {
    // Revocation for a sub we never tracked locally — the reconciler's
    // orphan prune (GET-based) is the backstop.
    console.warn(
      `[twitch] Revocation for untracked subscription (${type}/${broadcasterId}) — ignored`,
    );
  }
}

/**
 * Route handler for POST /hooks/twitch. Reads req.rawBody (set by the web
 * body-cap middleware). Never throws — every failure answers and logs.
 *
 * @param {import("http").IncomingMessage & { rawBody?: Buffer }} req
 * @param {import("http").ServerResponse} res
 * @param {object} [deps]
 * @param {() => object} [deps.getConfig] config seam (tests)
 * @param {(() => object|null)|object} [deps.getClient] live client accessor (web wiring)
 * @param {(client, payload, deps) => Promise<void>} [deps.onNotification] dispatch seam
 * @param {(ids: string[]) => Promise<Array<object>|null>} [deps.fetchStreams]
 */
async function handleTwitchEventsub(req, res, deps = {}) {
  try {
    const cfg = (deps.getConfig || getEventsubConfig)();
    if (!cfg.enabled) {
      if (!warnedDisabled) {
        warnedDisabled = true;
        console.warn(
          `[twitch] EventSub webhook hit but disabled (missing: ${cfg.missing.join(", ")})`,
        );
      }
      respond(res, 404);
      return;
    }

    const headers = req.headers || {};
    const messageId = headers[MESSAGE_ID_HEADER];
    const timestamp = headers[MESSAGE_TIMESTAMP_HEADER];
    const signature = headers[MESSAGE_SIGNATURE_HEADER];
    const messageType = headers[MESSAGE_TYPE_HEADER];
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);

    if (!verifyEventsubHmac({
      secret: cfg.secret,
      messageId,
      timestamp,
      rawBody,
      signature,
    })) {
      console.warn(
        "[twitch] EventSub webhook rejected: HMAC mismatch, missing headers, or stale timestamp",
      );
      respond(res, 403);
      return;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      respond(res, 400);
      return;
    }

    if (messageType === "webhook_callback_verification") {
      const challenge = payload?.challenge;
      if (typeof challenge !== "string" || !challenge) {
        console.error("[twitch] EventSub verification request without a challenge");
        respond(res, 400);
        return;
      }
      respond(res, 200, challenge);
      return;
    }

    if (messageType === "revocation") {
      respond(res, 204);
      try {
        handleRevocation(payload?.subscription);
      } catch (err) {
        console.error("[twitch] EventSub revocation handling failed:", err?.message || err);
      }
      return;
    }

    if (messageType === "notification") {
      // Answer FIRST, process after — slow handlers trip Twitch's
      // notification_failures_exceeded revocation.
      respond(res, 204);
      const client =
        typeof deps.getClient === "function" ? deps.getClient() : (deps.getClient ?? null);
      const dispatch = deps.onNotification || dispatchEventsubNotification;
      Promise.resolve()
        .then(() => dispatch(client, payload, deps))
        .catch((err) =>
          console.error("[twitch] EventSub notification processing failed:", err?.message || err),
        );
      return;
    }

    respond(res, 204);
  } catch (err) {
    console.error("[twitch] EventSub webhook handler error:", err?.message || err);
    if (!res.headersSent) respond(res, 500);
  }
}

/** Test seam only. */
function _resetCallbackWarningsForTests() {
  warnedDisabled = false;
}

module.exports = {
  MESSAGE_ID_HEADER,
  MESSAGE_TIMESTAMP_HEADER,
  MESSAGE_SIGNATURE_HEADER,
  MESSAGE_TYPE_HEADER,
  MAX_MESSAGE_AGE_MS,
  verifyEventsubHmac,
  dispatchEventsubNotification,
  handleRevocation,
  handleTwitchEventsub,
  _resetCallbackWarningsForTests,
};
