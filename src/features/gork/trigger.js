/**
 * Gork trigger: keyword matching + the onMessageCreate pipeline hook
 * (roadmap/gork.md §7.1, §7.6; design decisions 2, 3, 11–13, 20).
 *
 * The pipeline hook runs only fast checks inline, in order:
 * guild + author + non-bot, text-based channel, guild keyword enabled,
 * open-ticket channel skip, AI key present, keyword match, keyword-alone
 * rule, per-user cooldown (staff bypass), queue admission. The slow LLM
 * job is then fired as a detached promise (caught + logged) so the
 * onMessageCreate pipeline never stalls — XP awards keep flowing.
 *
 * Canned replies (LOCKED — roadmap/gork.md decision 20, verbatim):
 * - queue full:  "My one (1) brain is already busy, and the queue is full. Your question has been dropped — no hard feelings."
 * - LLM failure: "*gork's brain went to lunch* — try again in a bit."
 * - keyword alone with no reply reference: no reply at all (no LLM call).
 */

const { PermissionFlagsBits } = require("discord.js");
const {
  getGuildSettings,
  getTicketByChannel,
  memberHasStaffRole,
} = require("../../db");
const { getAiConfig, chatWithTools } = require("../../core/ai");
const { buildContext, hasReference } = require("./context");
const { buildSystemPrompt } = require("./prompt");
const { createGorkQueue, DEFAULT_COOLDOWN_SEC } = require("./queue");
const {
  WEB_SEARCH_TOOL,
  isWebSearchEnabled,
  executeWebSearch,
} = require("./tools/webSearch");
const { logGorkQa, logGorkFailure, describeContext } = require("./audit");

/** One gork queue per process (in-memory cooldowns + per-guild FIFO). */
const gorkQueue = createGorkQueue();

/** Refresh the typing indicator on this cadence (spec: every 8s). */
const TYPING_REFRESH_MS = 8000;

/** LLM budget (roadmap/gork.md §7.3). */
const LLM_TEMPERATURE = 0.8;
const LLM_MAX_TOKENS = 600;
const LLM_TIMEOUT_MS = 60_000;
const LLM_MAX_TOOL_ROUNDS = 3;

/** LOCKED canned reply: the guild queue is full (decision 20, verbatim). */
const QUEUE_FULL_REPLY =
  "My one (1) brain is already busy, and the queue is full. Your question has been dropped — no hard feelings.";

/** LOCKED canned reply: the LLM job failed or timed out (decision 20, verbatim). */
const LLM_FAILURE_REPLY = "*gork's brain went to lunch* — try again in a bit.";

/** One optional leading separator stripped from the question (spec §7.1). */
const SEPARATORS = new Set([":", "-", "?", "!"]);

/**
 * Match a message against the guild's gork keyword (pure).
 *
 * The trimmed content must start with the keyword, compared
 * case-insensitively. The question is the remainder, trimmed, with one
 * optional leading separator (`:`, `-`, `?`, `!`) + surrounding
 * whitespace stripped (roadmap/gork.md §7.1, decision 2).
 *
 * @param {unknown} content raw message content
 * @param {unknown} keyword guild `gork_keyword` (null/empty = disabled)
 * @returns {{ triggered: boolean, question: string }}
 */
function matchKeyword(content, keyword) {
  const text = typeof content === "string" ? content.trim() : "";
  const kw = typeof keyword === "string" ? keyword.trim() : "";
  if (!text || !kw) return { triggered: false, question: "" };
  if (!text.toLowerCase().startsWith(kw.toLowerCase())) {
    return { triggered: false, question: "" };
  }
  let question = text.slice(kw.length).trim();
  if (question && SEPARATORS.has(question[0])) {
    question = question.slice(1).trim();
  }
  return { triggered: true, question };
}

/**
 * Find where to cut a chunk of at most `limit` chars: the chunk ends with
 * the last newline inside the first `limit` chars (so all characters are
 * preserved across chunks); a hard cut at `limit` when no newline exists.
 * A newline at index 0 alone is not accepted (avoids degenerate 1-char
 * chunks when the text starts with a newline).
 *
 * @param {string} text remaining text
 * @param {number} limit max chunk size
 * @returns {number} cut index (1..limit)
 */
function findBreakAt(text, limit) {
  for (let i = limit - 1; i >= 1; i -= 1) {
    if (text[i] === "\n") return i + 1;
  }
  return limit;
}

/**
 * Split a long answer into consecutive Discord-sized chunks (pure).
 *
 * Text at or under `max` chars stays a single chunk. Longer text is split
 * into chunks of at most `chunk` chars, preferring line boundaries (hard
 * cut as fallback). All characters are preserved: `chunks.join("")`
 * reproduces the input (roadmap/gork.md §7.3, decision 8).
 *
 * @param {unknown} text the answer text
 * @param {{ max?: number, chunk?: number }} [options]
 * @param {number} [options.max=2000] threshold above which splitting happens
 * @param {number} [options.chunk=1900] max chars per chunk
 * @returns {string[]}
 */
function splitLongAnswer(text, { max = 2000, chunk = 1900 } = {}) {
  const source = text == null ? "" : String(text);
  if (source.length <= max) return [source];
  const size = Math.max(1, Math.min(Math.floor(chunk), Math.floor(max)));
  const chunks = [];
  let rest = source;
  while (rest.length > max) {
    const limit = Math.min(size, rest.length);
    const cut = findBreakAt(rest, limit);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

/**
 * Build the user message for the LLM call.
 *
 * With a question: the question followed by the conversation context
 * block. Without (keyword alone, replying to a message): a fixed
 * instruction to answer from the conversation context (decision 3).
 *
 * @param {string} question trimmed question text ("" = keyword alone)
 * @param {{ text?: string }} ctx buildContext() result
 * @returns {string}
 */
function buildUserContent(question, ctx) {
  const context = (ctx?.text || "").trim() || "(none)";
  if (question) {
    return `${question}\n\nConversation context:\n${context}`;
  }
  return (
    "The user sent only the keyword, replying to the message below. Answer from the conversation context.\n\n" +
    context
  );
}

/**
 * onMessageCreate pipeline hook for gork (roadmap/gork.md §7.6).
 *
 * Runs the fast checks inline (see module header for the order), starts
 * the typing indicator, and fires the LLM job as a detached promise.
 * Never throws and never rejects: the pipeline must not see a rejection,
 * and a broken gork must never break XP awards or other pipeline steps.
 *
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").Message} message
 * @returns {Promise<void>}
 */
async function handleGorkMessage(client, message) {
  try {
    // 1. Guild-only; skip webhook (no author) and bot messages.
    if (!message?.guild || !message.author || message.author.bot) return;
    const guildId = message.guild.id;

    // 2. Text-based channel only (threads qualify; DMs excluded above).
    const channel = message.channel;
    if (
      !channel ||
      typeof channel.isTextBased !== "function" ||
      !channel.isTextBased()
    ) {
      return;
    }

    // 3. Guild must have a non-blank keyword (null/blank = gork disabled).
    const settings = getGuildSettings(guildId);
    const keyword = settings?.gork_keyword;
    if (typeof keyword !== "string" || !keyword.trim()) return;

    // 4. Disabled in open ticket channels (decision 19) — silent.
    const ticket = getTicketByChannel(message.channelId);
    if (ticket && Number(ticket.archived) !== 1) return;

    // 5. No AI key -> gork is off (decision 7) — silent.
    const cfg = getAiConfig();
    if (!cfg.apiKey) return;

    // 6. Keyword must be a prefix of the trimmed content (decision 1).
    const { triggered, question } = matchKeyword(message.content, keyword);
    if (!triggered) return;

    // 7. Keyword alone: answer from reply-chain context only when the
    //    message references another message; otherwise fully silent —
    //    no LLM call, no reply (decision 3).
    if (!question && !hasReference(message)) return;

    // 8. Staff (ManageGuild or any staff_roles role) bypass the cooldown.
    const staff =
      Boolean(
        message.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild),
      ) ||
      memberHasStaffRole(guildId, [
        ...(message.member?.roles?.cache?.keys() ?? []),
      ]);

    // 9. Per-user cooldown (guild-overridable; 0 = disabled) — silent hit.
    const cd = gorkQueue.checkCooldown({
      guildId,
      userId: message.author.id,
      cooldownSec: settings.gork_cooldown_sec ?? DEFAULT_COOLDOWN_SEC,
      staff,
    });
    if (!cd.allowed) return;

    // 10. Concurrency: 1 in-flight per guild, FIFO up to 5 waiting; a
    //     full queue drops the trigger with the locked canned reply.
    const slot = gorkQueue.admit({ guildId });
    if (slot.dropped) {
      await message.reply(QUEUE_FULL_REPLY).catch(() => {});
      return;
    }

    // 11. Typing immediately (also while queued) and every 8s.
    await channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(
      () => channel.sendTyping().catch(() => {}),
      TYPING_REFRESH_MS,
    );

    // 12. Detached LLM job: fire-and-forget so the pipeline never awaits.
    const auditClient = client || message.guild.client || null;
    void (async () => {
      let replied = false;
      try {
        if (slot.queued) await slot.turn; // wait for our FIFO slot
        const ctx = await buildContext(message, settings.gork_context_window);
        const system = buildSystemPrompt({
          extraRules: settings.gork_extra_rules,
        });
        const searchOn = isWebSearchEnabled(settings);
        const res = await chatWithTools(cfg, {
          messages: [
            { role: "system", content: system },
            { role: "user", content: buildUserContent(question, ctx) },
          ],
          temperature: LLM_TEMPERATURE,
          maxTokens: LLM_MAX_TOKENS,
          timeoutMs: LLM_TIMEOUT_MS,
          maxToolRounds: LLM_MAX_TOOL_ROUNDS,
          tools: searchOn ? [WEB_SEARCH_TOOL] : undefined,
          executeTool: (name, args) =>
            name === "web_search"
              ? executeWebSearch(args?.query)
              : `unknown tool: ${name}`,
        });

        if (res.ok && (res.content || "").trim()) {
          // Plain text reply TO the keyword message (decision 11); long
          // answers continue as consecutive channel messages.
          const chunks = splitLongAnswer(res.content);
          const replyMessage = await message.reply(chunks[0]);
          replied = true;
          for (let i = 1; i < chunks.length; i += 1) {
            await channel.send(chunks[i]);
          }
          logGorkQa(auditClient, guildId, {
            user: message.author,
            question,
            contextLabel: describeContext(ctx),
            searchQueries: res.toolCalls,
            model: cfg.model,
            durationMs: res.durationMs,
            answer: res.content,
            questionMessage: message,
            replyMessage,
          }).catch(() => {});
        } else {
          // Failure / timeout: locked canned reply, never a silent hang.
          await message.reply(LLM_FAILURE_REPLY).catch(() => {});
          replied = true;
          console.warn(
            `[gork] LLM failure in ${guildId}: ${res.reason || res.error || "unknown"}`,
          );
          logGorkFailure(auditClient, guildId, {
            user: message.author,
            question,
            reason: res.error || res.reason || "unknown error",
          }).catch(() => {});
        }
      } catch (err) {
        console.error(`[gork] job failed in ${guildId}:`, err?.message || err);
        if (!replied) {
          await message.reply(LLM_FAILURE_REPLY).catch(() => {});
        }
      } finally {
        clearInterval(typingInterval);
        gorkQueue.release({ guildId });
      }
    })().catch(() => {});
  } catch (err) {
    // 13. The pipeline must never see a rejection.
    console.error("[gork] pipeline hook error:", err?.message || err);
  }
}

module.exports = {
  matchKeyword,
  splitLongAnswer,
  buildUserContent,
  handleGorkMessage,
  gorkQueue,
  QUEUE_FULL_REPLY,
  LLM_FAILURE_REPLY,
  TYPING_REFRESH_MS,
  LLM_TEMPERATURE,
  LLM_MAX_TOKENS,
  LLM_TIMEOUT_MS,
  LLM_MAX_TOOL_ROUNDS,
};
