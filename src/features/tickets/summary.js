/**
 * AI structured summary for non-sensitive ticket archives.
 * Falls back to stats + close reason when AI is unavailable.
 */

const { formatTicketRef } = require("../../core/theme");

/**
 * @returns {{ apiKey: string|null, baseUrl: string, model: string }}
 */
function getAiConfig() {
  return {
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || null,
    baseUrl: (
      process.env.AI_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://api.openai.com/v1"
    ).replace(/\/$/, ""),
    model: process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  };
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

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      console.warn(`[tickets] AI summary HTTP ${res.status}; using fallback`);
      return fallback;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
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
  } catch (err) {
    console.warn("[tickets] AI summary failed:", err?.message || err);
    return fallback;
  }
}

module.exports = {
  getAiConfig,
  buildFallbackSummary,
  summarizeTicket,
};
