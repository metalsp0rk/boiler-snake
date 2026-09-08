/**
 * Gork trigger: keyword matching + the onMessageCreate pipeline hook
 * (roadmap/gork.md §7.1, §7.6; design decisions 2, 3, 11–13, 20).
 *
 * The pipeline hook runs only fast checks inline, in order:
 * guild + author + non-bot, text-based channel, guild enable switch +
 * keyword enabled, open-ticket channel skip, AI key present, keyword
 * match, keyword-alone rule, per-user cooldown (staff bypass), guild ban
 * list (banned users get the LLM-failure reply, no staff bypass), queue
 * admission. The slow LLM job is then fired as a detached promise (caught
 * + logged) so the onMessageCreate pipeline never stalls — XP awards keep
 * flowing.
 *
 * Canned replies (LOCKED — roadmap/gork.md decision 20, verbatim):
 * - queue full:  "My one (1) brain is already busy, and the queue is full. Your question has been dropped — no hard feelings."
 * - LLM failure: "*gork's brain went to lunch* — try again in a bit."
 *   (guild-banned users get this same text so a ban is indistinguishable
 *   from a normal failure)
 * - keyword alone with no reply reference: no reply at all (no LLM call).
 */

const { PermissionFlagsBits } = require("discord.js");
const {
  getGuildSettings,
  getTicketByChannel,
  isGorkBlocked,
  memberHasStaffRole,
} = require("../../db");
const { getAiConfig, chatWithTools } = require("../../core/ai");
const { safeCutIndex } = require("../../core/text");
const { buildContext, hasReference } = require("./context");
const { buildRoster, formatRosterBlock } = require("./roster");
const { NO_PING_MENTIONS, sanitizeAnswer } = require("./sanitize");
const { buildSystemPrompt } = require("./prompt");
const { createGorkQueue, DEFAULT_COOLDOWN_SEC } = require("./queue");
const {
  WEB_SEARCH_TOOL,
  isWebSearchEnabled,
  executeWebSearch,
} = require("./tools/webSearch");
const { READ_PAGE_TOOL, executeReadPage } = require("./tools/readPage");
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

/** Max wait for the channel-history fetch phase (§7.15 Fix 3 hardening). */
const CONTEXT_DEADLINE_MS = 20_000;

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
 * Pull a candidate cut index back so it never splits a surrogate pair, a
 * `<…>` Discord token (mention/custom-emoji/timestamp), a `||` spoiler
 * span, or a ``` fenced code block (§7.15 Fix 4). Cutting earlier than
 * `limit` is always allowed (chunks may be shorter); the cut stays ≥ 1.
 *
 * @param {string} text remaining text
 * @param {number} cut candidate cut index (1..text.length)
 * @returns {number} adjusted cut index (≥ 1, ≤ cut)
 */
function pullBeforeTokens(text, cut) {
  for (let guard = 0; guard < 16 && cut > 1; guard += 1) {
    const cpSafe = safeCutIndex(text, cut);
    if (cpSafe >= 1 && cpSafe < cut) {
      cut = cpSafe;
      continue;
    }
    const lt = text.lastIndexOf("<", cut - 1);
    if (lt >= 1) {
      const gt = text.indexOf(">", lt);
      if (gt === -1 || gt >= cut) {
        cut = lt;
        continue;
      }
    }
    if (
      (text.slice(0, cut).match(/\|\|/g) || []).length % 2 === 1 &&
      text.lastIndexOf("||", cut - 1) >= 1
    ) {
      cut = text.lastIndexOf("||", cut - 1);
      continue;
    }
    if (
      (text.slice(0, cut).match(/```/g) || []).length % 2 === 1 &&
      text.lastIndexOf("```", cut - 1) >= 1
    ) {
      cut = text.lastIndexOf("```", cut - 1);
      continue;
    }
    return cut;
  }
  return Math.max(1, cpSafeIfPossible(text, cut));
}

/**
 * Best-effort final code-point clamp (cut 1 edge cases).
 *
 * @param {string} text
 * @param {number} cut
 * @returns {number}
 */
function cpSafeIfPossible(text, cut) {
  const safe = safeCutIndex(text, Math.max(1, cut));
  return safe >= 1 ? safe : Math.max(1, cut);
}

/**
 * Find where to cut a chunk of at most `limit` chars: the chunk ends with
 * the last newline inside the first `limit` chars (so all characters are
 * preserved across chunks); a hard cut at `limit` when no newline exists.
 * A newline at index 0 alone is not accepted (avoids degenerate 1-char
 * chunks when the text starts with a newline). The cut is then pulled
 * back off surrogate pairs and Discord tokens (§7.15 Fix 4).
 *
 * @param {string} text remaining text
 * @param {number} limit max chunk size
 * @returns {number} cut index (1..limit)
 */
function findBreakAt(text, limit) {
  let cut = limit;
  for (let i = limit - 1; i >= 1; i -= 1) {
    if (text[i] === "\n") {
      cut = i + 1;
      break;
    }
  }
  return pullBeforeTokens(text, cut);
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
 * When a roster block is provided (Fix 2), it is appended as a
 * "People roster" data block — the byte-locked base prompt stays
 * untouched (decision-21 guidance pattern).
 *
 * @param {string} question trimmed question text ("" = keyword alone)
 * @param {{ text?: string }} ctx buildContext() result
 * @param {string} [rosterBlock] formatRosterBlock() result ("" = none)
 * @returns {string}
 */
function buildUserContent(question, ctx, rosterBlock = "") {
  const context = (ctx?.text || "").trim() || "(none)";
  const roster = (rosterBlock || "").trim();
  const rosterSection = roster ? `\n\nPeople roster:\n${roster}` : "";
  if (question) {
    return `${question}\n\nConversation context:\n${context}${rosterSection}`;
  }
  return (
    "The user sent only the keyword, replying to the message below. Answer from the conversation context.\n\n" +
    context +
    rosterSection
  );
}

/**
 * Race a promise against a deadline, resolving to `fallback` on timeout
 * (Fix 3: a hung channel fetch must never hold the guild queue slot
 * open). The raced promise is already "never rejects" by contract; an
 * added catch keeps the race free of unhandled rejections.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms deadline
 * @param {T} fallback
 * @returns {Promise<T>}
 */
function withDeadline(promise, ms, fallback) {
  const guarded = Promise.resolve(promise).catch(() => fallback);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === "function") timer.unref();
    guarded.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
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

    // 3. Guild must have gork enabled: the `/gork enable` master switch
    //    (off = fully silent; keyword + all other settings are preserved)
    //    and a non-blank keyword (null/blank = gork disabled).
    const settings = getGuildSettings(guildId);
    if (Number(settings?.gork_enabled ?? 1) !== 1) return;
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

    // 10. Guild ban list (`/gork ban`): banned users — staff included, no
    //     bypass — get the locked LLM-failure canned reply so the ban is
    //     indistinguishable from a normal failure. Checked after the
    //     cooldown so a banned trigger stays silent during the cooldown
    //     window (rate-limits the reply); no LLM call, no QA audit.
    if (isGorkBlocked(guildId, message.author.id)) {
      await message.reply(LLM_FAILURE_REPLY).catch(() => {});
      return;
    }

    // 11. Concurrency: 1 in-flight per guild, FIFO up to 5 waiting; a
    //     full queue drops the trigger with the locked canned reply.
    const slot = gorkQueue.admit({ guildId });
    if (slot.dropped) {
      await message.reply(QUEUE_FULL_REPLY).catch(() => {});
      return;
    }

    // 12. Typing immediately (also while queued) and every 8s.
    await channel.sendTyping().catch(() => {});
    const typingInterval = setInterval(
      () => channel.sendTyping().catch(() => {}),
      TYPING_REFRESH_MS,
    );

    // 13. Detached LLM job: fire-and-forget so the pipeline never awaits.
    const auditClient = client || message.guild.client || null;
    void (async () => {
      let replied = false;
      try {
        if (slot.queued) await slot.turn; // wait for our FIFO slot
        // Fix 3 hardening: buildContext is never-rejects by contract, but
        // a hung channel fetch would hold the guild slot forever (the
        // guild then looks "crashed"). Deadline it; degrade to no context.
        const ctx = await withDeadline(
          buildContext(message, settings.gork_context_window),
          CONTEXT_DEADLINE_MS,
          { text: "", mode: "prior", collected: 0, messages: [] },
        );
        // Fix 2: compact roster of the people involved (asker, context
        // authors, mentioned users) so the model can map names ↔ ids.
        let roster = { entries: new Map(), lines: [], truncated: 0 };
        try {
          roster = await buildRoster(
            auditClient,
            message.guild,
            message,
            ctx.messages || [],
            question,
          );
        } catch {
          // Roster is best-effort: answering must not depend on it.
        }
        const system = buildSystemPrompt({
          extraRules: settings.gork_extra_rules,
        });
        const searchOn = isWebSearchEnabled(settings);
        // Per-job tool counters for the audit embed (locked spec:
        // separate search / page-read tallies, not the combined total).
        let searches = 0;
        let reads = 0;
        const res = await chatWithTools(cfg, {
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: buildUserContent(
                question,
                ctx,
                formatRosterBlock(roster),
              ),
            },
          ],
          temperature: LLM_TEMPERATURE,
          maxTokens: LLM_MAX_TOKENS,
          timeoutMs: LLM_TIMEOUT_MS,
          maxToolRounds: LLM_MAX_TOOL_ROUNDS,
          tools: searchOn
            ? [WEB_SEARCH_TOOL, READ_PAGE_TOOL]
            : undefined,
          executeTool: (name, args) => {
            if (name === "web_search") {
              searches += 1;
              return executeWebSearch(args?.query);
            }
            if (name === "read_page") {
              reads += 1;
              // The tool module coerces/dedupes/caps urls itself; pass
              // the raw args through (never throws).
              return executeReadPage(args);
            }
            return `unknown tool: ${name}`;
          },
        });

        if (res.ok && (res.content || "").trim()) {
          // Fix 1: rewrite echoed mention markup to readable names, and
          // send with pings disabled so nothing notifies unintentionally.
          const answer = sanitizeAnswer(res.content, {
            roster,
            guild: message.guild,
          });
          // Plain text reply TO the keyword message (decision 11); long
          // answers continue as consecutive channel messages.
          const chunks = splitLongAnswer(answer);
          const replyMessage = await message.reply({
            content: chunks[0],
            allowedMentions: NO_PING_MENTIONS,
          });
          replied = true;
          for (let i = 1; i < chunks.length; i += 1) {
            await channel.send({
              content: chunks[i],
              allowedMentions: NO_PING_MENTIONS,
            });
          }
          logGorkQa(auditClient, guildId, {
            user: message.author,
            question,
            contextLabel: describeContext(ctx),
            searchQueries: searches,
            pageReads: reads,
            model: cfg.model,
            durationMs: res.durationMs,
            answer,
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
    // 14. The pipeline must never see a rejection.
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
