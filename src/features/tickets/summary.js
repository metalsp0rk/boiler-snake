/**
 * AI structured summary for non-sensitive ticket archives.
 * Falls back to stats + close reason when AI is unavailable.
 *
 * The OpenAI-compatible HTTP call lives in src/core/ai.js (shared with
 * gork); this module keeps the prompt, fallbacks, and feature warnings.
 */

const { formatTicketRef } = require("../../core/theme");
const { getAiConfig, chatCompletion } = require("../../core/ai");

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
 * Never throws; returns fallback on any failure.
 * @param {object} ticket
 * @param {object[]} messages
 * @param {object} [opts]
 * @returns {Promise<object>}
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

  const result = await chatCompletion(cfg, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.2,
    responseFormat: { type: "json_object" },
  });

  if (!result.ok) {
    if (result.status) {
      console.warn(`[tickets] AI summary HTTP ${result.status}; using fallback`);
    } else {
      console.warn("[tickets] AI summary failed:", result.error);
    }
    return fallback;
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
};
