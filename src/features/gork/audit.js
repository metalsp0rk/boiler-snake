/**
 * Gork audit logging (roadmap/gork.md §7.7, design decision 14).
 *
 * Every completed Q&A posts a "Gork Q&A" embed to the guild's audit
 * channel (via logs/auditLog `sendAuditLog`): asker mention, question
 * (≤300 chars; "(keyword only)" when the trigger was just the keyword),
 * context mode (e.g. "reply chain (4 msgs)" / "10 prior messages"),
 * search usage ("yes — 2 queries" / "no"), model + duration, the answer
 * (≤1000 chars), and jump links to the question and the gork reply.
 *
 * Failed / timed-out exchanges log a compact one-liner (asker + error
 * reason). When no audit channel is configured (or the send fails), a
 * one-line console log is the fallback.
 *
 * Nothing in this module throws: audit failures must never break the
 * gork reply path.
 */

const { sendAuditLog } = require("../logs/auditLog");
const { Color, baseEmbed, truncateField } = require("../../core/theme");

/** Max chars for the Question field (spec §7.7). */
const QUESTION_MAX_CHARS = 300;
/** Max chars for the Answer field (spec §7.7). */
const ANSWER_MAX_CHARS = 1000;
/** Max chars of the question quoted in the failure one-liner. */
const FAILURE_QUESTION_MAX_CHARS = 200;
/** Max chars of the reason quoted in the failure one-liner. */
const FAILURE_REASON_MAX_CHARS = 200;

/**
 * Render the context mode for the audit "Context" field.
 *
 * @param {{ mode?: "reply-chain"|"prior", collected?: number }} ctx
 *   buildContext() result (or a subset of it)
 * @returns {string} e.g. "reply chain (4 msgs)" / "10 prior messages"
 */
function describeContext(ctx = {}) {
  const count = Math.max(0, Math.floor(Number(ctx.collected) || 0));
  if (ctx.mode === "reply-chain") return `reply chain (${count} msgs)`;
  return `${count} prior messages`;
}

/**
 * Build a Discord "jump to message" URL, or null when the message does
 * not carry enough ids to construct one.
 *
 * @param {string} guildId
 * @param {object|null|undefined} message discord.js Message (or a
 *   { id, channelId }-shaped subset)
 * @returns {string|null}
 */
function messageJumpUrl(guildId, message) {
  if (!guildId || !message?.id) return null;
  const channelId = message.channelId || (message.channel && message.channel.id);
  if (!channelId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${message.id}`;
}

/**
 * Markdown link for a jump URL, or null when the URL is unavailable.
 * @param {string} label link text (e.g. "Question")
 * @param {string} guildId
 * @param {object} message
 * @returns {string|null}
 */
function jumpLink(label, guildId, message) {
  const url = messageJumpUrl(guildId, message);
  return url ? `[${label}](${url})` : null;
}

/**
 * Post the "Gork Q&A" audit embed for a completed exchange.
 *
 * Never throws; a missing audit channel (or a failed send) degrades to a
 * one-line console log.
 *
 * @param {import("discord.js").Client} client
 * @param {string} guildId
 * @param {object} opts
 * @param {import("discord.js").User} [opts.user] asker
 * @param {string} [opts.question] trigger question ("" = keyword alone)
 * @param {string} [opts.contextLabel] describeContext() output
 * @param {number} [opts.searchQueries] web_search tool executions (0 = none)
 * @param {string} [opts.model] AI model used
 * @param {number} [opts.durationMs] wall-clock ms of the LLM call
 * @param {string} [opts.answer] final answer text
 * @param {object} [opts.questionMessage] the keyword message (jump link)
 * @param {object} [opts.replyMessage] gork's reply message (jump link)
 * @returns {Promise<void>}
 */
async function logGorkQa(client, guildId, opts = {}) {
  const {
    user,
    question,
    contextLabel,
    searchQueries,
    model,
    durationMs,
    answer,
    questionMessage,
    replyMessage,
  } = opts;
  try {
    const embed = baseEmbed({ color: Color.brand, title: "Gork Q&A", timestamp: true });

    const askedBy = user?.id ? `<@${user.id}>` : "Unknown";
    const questionValue = question?.trim()
      ? truncateField(question, QUESTION_MAX_CHARS)
      : "(keyword only)";
    const queries = Math.max(0, Math.floor(Number(searchQueries) || 0));
    const searchValue = queries > 0 ? `yes — ${queries} queries` : "no";
    const durationSuffix =
      typeof durationMs === "number" && Number.isFinite(durationMs)
        ? ` / ${(durationMs / 1000).toFixed(1)}s`
        : "";
    const answerValue = answer?.trim()
      ? truncateField(answer, ANSWER_MAX_CHARS)
      : "(empty)";

    embed.addFields(
      { name: "Asked by", value: askedBy, inline: true },
      { name: "Question", value: questionValue, inline: false },
      { name: "Context", value: contextLabel || "—", inline: true },
      { name: "Search", value: searchValue, inline: true },
      { name: "Model / duration", value: `${model || "unknown"}${durationSuffix}`, inline: true },
      { name: "Answer", value: answerValue, inline: false },
    );

    const links = [
      questionMessage ? jumpLink("Question", guildId, questionMessage) : null,
      replyMessage ? jumpLink("Reply", guildId, replyMessage) : null,
    ].filter(Boolean);
    if (links.length) {
      embed.addFields({ name: "Jump", value: links.join(" · ") });
    }

    const sent = await sendAuditLog(client, guildId, { embeds: [embed] });
    if (!sent) {
      console.log(
        `[gork] Q&A (no audit channel): ${askedBy} asked: ${truncateField(questionValue, 120)}`,
      );
    }
  } catch (err) {
    console.warn("[gork] Q&A audit log failed:", err?.message || err);
  }
}

/**
 * Post the compact one-liner audit for a failed / timed-out exchange.
 *
 * Never throws; a missing audit channel (or a failed send) degrades to a
 * one-line console log.
 *
 * @param {import("discord.js").Client} client
 * @param {string} guildId
 * @param {object} opts
 * @param {import("discord.js").User} [opts.user] asker
 * @param {string} [opts.question] trigger question ("" = keyword alone)
 * @param {string} [opts.reason] failure reason (AI result error/reason)
 * @returns {Promise<void>}
 */
async function logGorkFailure(client, guildId, opts = {}) {
  const { user, question, reason } = opts;
  try {
    const askedBy = user?.id ? `<@${user.id}>` : "Unknown";
    const why = truncateField(reason || "unknown error", FAILURE_REASON_MAX_CHARS);
    const body = question?.trim()
      ? `${askedBy}: ${why} — question: ${truncateField(question, FAILURE_QUESTION_MAX_CHARS)}`
      : `${askedBy}: ${why}`;

    const embed = baseEmbed({
      color: Color.danger,
      title: "Gork Q&A",
      description: body,
      timestamp: true,
    });

    const sent = await sendAuditLog(client, guildId, { embeds: [embed] });
    if (!sent) {
      console.log(`[gork] failure (no audit channel): ${body}`);
    }
  } catch (err) {
    console.warn("[gork] failure audit log failed:", err?.message || err);
  }
}

module.exports = {
  describeContext,
  logGorkQa,
  logGorkFailure,
};
