/**
 * AI structured summary for non-sensitive ticket archives.
 * Falls back to stats + close reason when AI is unavailable.
 *
 * The OpenAI-compatible HTTP call lives in src/core/ai.js (shared with
 * gork); this module keeps the prompt, fallbacks, and feature warnings.
 *
 * The completion call is DEADLINE-BOUNDED (audit-2026-10 #197): a hung LLM
 * call used to pin the archive pipeline open indefinitely. Reuses the gork
 * deadline mechanism (chatCompletion's timeoutMs → AbortController), knob
 * re-read at call time like every other gork timeout. On timeout the archive
 * COMPLETES with the stats fallback summary and a warning line naming the
 * deadline (partial-failure pattern of close.js), never a silent drop.
 */

const { formatTicketRef } = require("../../core/theme");
const { getAiConfig, chatCompletion } = require("../../core/ai");

/** Summary-turn deadline default (single small JSON turn; matches gork's
 * memory-extraction turn default, raise via TICKET_SUMMARY_TIMEOUT_MS). */
const DEFAULT_SUMMARY_TIMEOUT_MS = 20_000;

/**
 * Summary-turn deadline, re-read AT CALL TIME like every other gork knob
 * (GORK_MEMORY_TURN_TIMEOUT_MS / GORK_SUMMARIZE_TURN_TIMEOUT_MS style).
 * Unset/invalid → the default.
 * @returns {number}
 */
function ticketSummaryTimeoutMs() {
  const raw = Number(process.env.TICKET_SUMMARY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_SUMMARY_TIMEOUT_MS;
}

/**
 * Stats-only fallback summary (no external call).
 * @param {object} ticket
 * @param {object[]} messages
 * @param {object} [opts]
 * @returns {object}
 */
function buildFallbackSummary(ticket, messages, opts = {}) {
  const count = messages?.length ?? 0;
  const closeReason = ticket.close_reason || opts.closeReason || null;
  const reason = ticket.reason || "—";
  let excerpt = "";
  if (count) {
    const sample = messages
      .filter((m) => m.content && String(m.content).trim())
      .slice(0, 3)
      .map(
        (m) =>
          `${m.author_tag || m.author_id}: ${String(m.content).slice(0, 120)}`,
      );
    excerpt = sample.join(" | ");
  }

  return {
    source: "fallback",
    ticket_number: ticket.ticket_number,
    subject: reason,
    requester_id: ticket.creator_user_id,
    staff_owner_id: ticket.staff_owner_id || null,
    message_count: count,
    close_reason: closeReason,
    resolution: closeReason || "Closed",
    summary:
      closeReason ||
      (excerpt
        ? `Ticket closed with ${count} message(s). Excerpt: ${excerpt.slice(0, 400)}`
        : `Ticket ${formatTicketRef(ticket.ticket_number)} closed with ${count} message(s).`),
  };
}

/**
 * Try OpenAI-compatible chat completion for a short structured summary.
 * Never throws; returns fallback on any failure. A failed turn additionally
 * carries a `warning` string for the archive reply (AGENTS.md: user-facing
 * replies carry the specific cause; the archive itself completes).
 *
 * @param {object} ticket
 * @param {object[]} messages
 * @param {object} [opts]
 * @param {string} [opts.closeReason]
 * @param {Function} [opts.chatImpl] chatCompletion override (tests — gork
 *   summarize.js pattern)
 * @param {Function} [opts.fetchImpl] injectable fetch for the real client
 * @param {Function} [opts.setTimer] fake-timer seam for the deadline (tests)
 * @param {Function} [opts.clearTimer] fake-timer canceller (tests)
 * @param {number} [opts.timeoutMs] explicit deadline override (tests);
 *   default: ticketSummaryTimeoutMs()
 * @returns {Promise<object>} summary; `warning` set when the AI turn failed
 */
async function summarizeTicket(ticket, messages, opts = {}) {
  const fallback = buildFallbackSummary(ticket, messages, opts);
  const cfg = getAiConfig();
  if (!cfg.apiKey) return fallback;

  const transcriptText = (messages || [])
    .map((m) => {
      const body = (m.content || "").slice(0, 500);
      return `[${m.author_tag || m.author_id}] ${body}`;
    })
    .join("\n")
    .slice(0, 12000);

  const system =
    "You summarize Discord support tickets for staff archives. " +
    'Respond with JSON only: {"resolution": string one-liner, "summary": string 2-4 sentences}. ' +
    "Do not invent facts. Be neutral and concise.";

  const user = [
    `Ticket ${formatTicketRef(ticket.ticket_number)}`,
    `Open reason: ${ticket.reason || "(none)"}`,
    `Close reason: ${ticket.close_reason || opts.closeReason || "(none)"}`,
    `Messages (${messages?.length ?? 0}):`,
    transcriptText || "(no text)",
  ].join("\n");

  const chat = typeof opts.chatImpl === "function" ? opts.chatImpl : chatCompletion;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.trunc(opts.timeoutMs)
      : ticketSummaryTimeoutMs();
  const result = await chat(cfg, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    responseFormat: { type: "json_object" },
    // Deadline-bounded (audit #197): the same AbortController timeout gork
    // runs its turns under, so a wedged provider can never pin the archive.
    timeoutMs,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
    ...(opts.clearTimer ? { clearTimer: opts.clearTimer } : {}),
  });

  if (!result.ok) {
    const ref = formatTicketRef(ticket.ticket_number);
    if (result.reason === "timeout") {
      const secs = Math.max(1, Math.round(timeoutMs / 1000));
      console.warn(
        `[tickets] AI summary timed out after ${timeoutMs}ms for ticket ${ref}; using fallback`
      );
      return {
        ...fallback,
        warning:
          `Ticket ${ref} summary generation timed out after ${secs}s — ` +
          "archived with the stats fallback summary.",
      };
    }
    if (result.status) {
      console.warn(`[tickets] AI summary HTTP ${result.status}; using fallback`);
    } else {
      console.warn("[tickets] AI summary failed:", result.error);
    }
    const detail = result.status
      ? `HTTP ${result.status}${result.errorBody ? `: ${result.errorBody}` : ""}`
      : result.error || "unknown AI error";
    return {
      ...fallback,
      warning:
        `Ticket ${ref} AI summary unavailable (${detail}) — ` +
        "archived with the stats fallback summary.",
    };
  }

  const raw = result.content;
  if (!raw) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }

  return {
    ...fallback,
    source: "ai",
    model: cfg.model,
    resolution: String(parsed.resolution || fallback.resolution).slice(
      0,
      500,
    ),
    summary: String(parsed.summary || fallback.summary).slice(0, 2000),
  };
}

module.exports = {
  getAiConfig,
  buildFallbackSummary,
  summarizeTicket,
  ticketSummaryTimeoutMs,
  DEFAULT_SUMMARY_TIMEOUT_MS,
};
