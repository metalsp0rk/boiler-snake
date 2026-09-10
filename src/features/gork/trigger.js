/**
 * Gork trigger: keyword matching + the onMessageCreate pipeline hook
 * (roadmap/gork.md §7.1, §7.6; design decisions 2, 3, 11–13, 20).
 *
 * The pipeline hook runs only fast checks inline, in order:
 * guild + author + non-bot, text-based channel, guild enable switch +
 * keyword enabled, open-ticket channel skip, AI key present, keyword
 * match, keyword-alone rule, per-user cooldown (staff bypass; a hit reacts
 * to the trigger with a clock emoji), guild ban list (banned users get the
 * LLM-failure reply, no staff bypass), queue admission. The slow LLM job
 * is then fired as a detached promise (caught + logged) so the
 * onMessageCreate pipeline never stalls — XP awards keep flowing.
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
  gorkMemoryTouch,
  isGorkBlocked,
  memberHasStaffRole,
} = require("../../db");
const { getAiConfig, chatWithTools } = require("../../core/ai");
const { safeCutIndex, sliceSafe } = require("../../core/text");
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
const {
  RECALL_MEMORIES_TOOL,
  executeRecallMemory,
} = require("./tools/recallMemories");
const {
  clampMemoryChars,
  loadMemoryContext,
  runMemoryTurn,
  formatExistingMemoriesBlock,
} = require("./memory");
const {
  logGorkQa,
  logGorkFailure,
  describeContext,
  formatMemoryLabel,
} = require("./audit");

/** One gork queue per process (in-memory cooldowns + per-guild FIFO). */
const gorkQueue = createGorkQueue();

/**
 * TEST SEAM — settle tracking for gork's detached work.
 *
 * The gork hook and everything it detaches (the LLM job, its audit posts,
 * the §7.16 memory turn) never block the pipeline, which left integration
 * tests no option but wall-clock sleeps to "confirm absence" of a reply.
 * Every detached unit registers its completion promise here, so tests can
 * `await whenGorkIdleForTests()` and observe a settled state
 * deterministically. In production the set is write-only (read only by
 * the ForTests drain) — shipped behavior unchanged, same spirit as the
 * injectable `now` clock (queue.js) and music's `setManagerForTests`.
 */
const pendingGorkWork = new Set();

/**
 * Register a detached unit of gork work until it settles. Swallows any
 * rejection into the tracked promise so tracking can never change error
 * semantics or create unhandled rejections.
 *
 * @param {Promise<unknown>} promise
 * @returns {Promise<void>}
 */
function trackGorkWork(promise) {
  const tracked = Promise.resolve(promise)
    .catch(() => {})
    .then(() => {
      pendingGorkWork.delete(tracked);
    });
  pendingGorkWork.add(tracked);
  return tracked;
}

/**
 * Resolves once every detached gork work unit started so far has settled.
 * Settled jobs may register follow-up work (e.g. the memory turn after an
 * answer job), so this keeps draining until the set stays empty.
 * TEST ONLY — never called by the shipped paths.
 *
 * @returns {Promise<void>}
 */
async function whenGorkIdleForTests() {
  while (pendingGorkWork.size > 0) {
    await Promise.allSettled([...pendingGorkWork]);
  }
}

/** Refresh the typing indicator on this cadence (spec: every 8s). */
const TYPING_REFRESH_MS = 8000;

/** LLM budget defaults (roadmap/gork.md §7.3), env-overridable below. */
const LLM_TEMPERATURE = 0.8;
/**
 * Default completion budget. Spec §7.3 says "~600" for the ANSWER, but
 * reasoning/thinking providers (Qwen3-style, DeepSeek-R1, o-series) spend
 * max_tokens on hidden reasoning FIRST — a 600 budget came back
 * content:null (finish_reason "length") on a local thinking model
 * (roadmap/gork.md §7.15, Fix 5/Fix 6 incidents). 6,000 = a 4,000-token
 * thinking cap (pair with GORK_LLM_THINKING_TOKEN_BUDGET, enforced
 * server-side on e.g. vLLM --reasoning-parser) plus ~2,000 tokens of
 * visible-answer headroom; override with GORK_LLM_MAX_TOKENS.
 */
const DEFAULT_LLM_MAX_TOKENS = 6000;
/**
 * Total LLM deadline. 4,000 reasoning tokens on local models routinely
 * exceed 60s, so the whole loop gets 90s by default; override with
 * GORK_LLM_TIMEOUT_MS.
 */
const DEFAULT_LLM_TIMEOUT_MS = 90_000;
const DEFAULT_LLM_MAX_TOOL_ROUNDS = 3;

/**
 * Visible-answer char cap default. 0 = off, which keeps the LOCKED
 * multi-message long-answer spec (splitLongAnswer continuations) intact —
 * set GORK_MAX_ANSWER_CHARS to hard-cap answers to one message instead.
 */
const DEFAULT_MAX_ANSWER_CHARS = 0;

/** Marker appended by capAnswerChars when a visible answer gets truncated. */
const ANSWER_TRUNCATE_MARKER = "…[truncated]";

/**
 * Positive-integer env knob with a fallback (unset/invalid → default).
 *
 * @param {string} name env var name
 * @param {number} fallback default value
 * @returns {number}
 */
function envPositiveInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Per-call LLM parameters, re-read every job so env overrides apply to
 * queued requests without a restart.
 *
 * `thinkingTokenBudget` (GORK_LLM_THINKING_TOKEN_BUDGET) is the hidden
 * reasoning cap passed through to the provider as thinking_token_budget.
 * 0 = "do not send" (strict-provider safety: unknown params are rejected
 * by e.g. api.openai.com; the cap only does anything on servers that
 * enforce it, e.g. vLLM with --reasoning-parser).
 *
 * @returns {{ temperature: number, maxTokens: number, timeoutMs: number, maxToolRounds: number, thinkingTokenBudget: number }}
 */
function llmParams() {
  return {
    temperature: LLM_TEMPERATURE,
    maxTokens: envPositiveInt("GORK_LLM_MAX_TOKENS", DEFAULT_LLM_MAX_TOKENS),
    timeoutMs: envPositiveInt("GORK_LLM_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS),
    maxToolRounds: envPositiveInt(
      "GORK_LLM_MAX_TOOL_ROUNDS",
      DEFAULT_LLM_MAX_TOOL_ROUNDS,
    ),
    thinkingTokenBudget: envPositiveInt("GORK_LLM_THINKING_TOKEN_BUDGET", 0),
  };
}

/**
 * Human-readable failure description for logs + audit (Fix: the old
 * `reason || error || "unknown"` collapsed successful-but-empty answers
 * into a useless "unknown").
 *
 * For ok-but-empty answers the base string stays exact; provider
 * diagnostics (finish_reason / completion_tokens) are appended when the
 * result carries them — they tell an empty-on-length from a real blank.
 *
 * @param {object} res chatWithTools result
 * @returns {string}
 */
function describeLlmFailure(res) {
  if (res?.ok) {
    const base = "provider returned an empty answer";
    const details = [];
    if (res.finishReason) details.push(`finish_reason=${res.finishReason}`);
    if (typeof res.usage?.completion_tokens === "number") {
      details.push(`completion_tokens=${res.usage.completion_tokens}`);
    }
    return details.length ? `${base} (${details.join(", ")})` : base;
  }
  const bits = [];
  if (res?.reason) bits.push(res.reason);
  if (res?.status) bits.push(`HTTP ${res.status}`);
  if (res?.error) bits.push(String(res.error).slice(0, 160));
  return bits.length ? bits.join(": ") : "unknown error";
}

/** Max wait for the channel-history fetch phase (§7.15 Fix 3 hardening). */
const CONTEXT_DEADLINE_MS = 20_000;

/** LOCKED canned reply: the guild queue is full (decision 20, verbatim). */
const QUEUE_FULL_REPLY =
  "My one (1) brain is already busy, and the queue is full. Your question has been dropped — no hard feelings.";

/** LOCKED canned reply: the LLM job failed or timed out (decision 20, verbatim). */
const LLM_FAILURE_REPLY = "*gork's brain went to lunch* — try again in a bit.";

/**
 * Reaction added to a trigger that hits the per-user cooldown: a visible
 * "rate-limited" signal replacing the old silent drop (still no reply and
 * no LLM call on a hit).
 */
const COOLDOWN_REACTION = "🕐";

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
 * Hard-cap a visible answer at `limit` chars (pure; Fix 6).
 *
 * `limit` <= 0 (or garbage) disables the cap — the locked multi-message
 * splitLongAnswer spec stays in charge. Over-limit text is cut at the last
 * word boundary (space/newline/tab) that leaves room for the marker, then
 * gets `ANSWER_TRUNCATE_MARKER` appended; the cut is code-point-safe
 * (Fix 4 helpers), so emoji never split. When the limit is too small to
 * hold the marker plus a usable prefix, a hard code-point-safe slice is
 * returned instead. Invariant: whenever `limit` > 0 the result is at most
 * `limit` chars.
 *
 * @param {unknown} text the answer text
 * @param {unknown} limit max chars (0/negative/garbage = off)
 * @returns {string}
 */
function capAnswerChars(text, limit) {
  const source = text == null ? "" : String(text);
  const lim = Math.floor(Number(limit));
  if (!(lim > 0)) return source;
  if (source.length <= lim) return source;
  if (lim < ANSWER_TRUNCATE_MARKER.length + 10) {
    // No room for a meaningful prefix + marker: hard code-point-safe cut.
    return sliceSafe(source, lim);
  }
  const window = lim - ANSWER_TRUNCATE_MARKER.length;
  let cut = 0;
  for (const ch of [" ", "\n", "\t"]) {
    const idx = source.lastIndexOf(ch, window - 1);
    if (idx > cut) cut = idx;
  }
  if (!(cut > 0)) cut = window; // no whitespace in window: hard cut at window
  cut = safeCutIndex(source, cut);
  return source.slice(0, cut).trimEnd() + ANSWER_TRUNCATE_MARKER;
}

/**
 * Build the user message for the LLM call.
 *
 * With a question: the question followed by the conversation context
 * block. Without (keyword alone, replying to a message): a fixed
 * instruction to answer from the conversation context (decision 3).
 * When a roster block is provided (Fix 2), it is appended as a
 * "People roster" data block — the byte-locked base prompt stays
 * untouched (decision-21 guidance pattern). The optional 4th argument
 * appends the MEMORY BLOCK after the roster section (§7.16.2); 3-arg
 * callers are unaffected (empty/whitespace block changes nothing).
 *
 * @param {string} question trimmed question text ("" = keyword alone)
 * @param {{ text?: string }} ctx buildContext() result
 * @param {string} [rosterBlock] formatRosterBlock() result ("" = none)
 * @param {string} [memoryBlock] loadMemoryContext().block ("" = none)
 * @returns {string}
 */
function buildUserContent(question, ctx, rosterBlock = "", memoryBlock = "") {
  const context = (ctx?.text || "").trim() || "(none)";
  const roster = (rosterBlock || "").trim();
  const rosterSection = roster ? `\n\nPeople roster:\n${roster}` : "";
  const memorySection = (memoryBlock || "").trim() ? `\n\n${memoryBlock}` : "";
  if (question) {
    return `${question}\n\nConversation context:\n${context}${rosterSection}${memorySection}`;
  }
  return (
    "The user sent only the keyword, replying to the message below. Answer from the conversation context.\n\n" +
    context +
    rosterSection +
    memorySection
  );
}

/**
 * Server-stamped memory date for the extraction turn (§7.16.1, decision
 * 26): the UTC calendar day (YYYY-MM-DD) of the trigger message. The
 * extractor model never emits dates. Primary source is `createdAt`;
 * discord.js always has it on real messages, so the snowflake-id decode
 * is the documented fallback (guarded so a non-numeric id can never
 * throw out of BigInt).
 *
 * @param {object} message discord.js Message (or subset)
 * @returns {string} YYYY-MM-DD (UTC)
 */
function memDateFromMessage(message) {
  const created = message?.createdAt;
  let ms =
    created instanceof Date && Number.isFinite(created.getTime())
      ? created.getTime()
      : null;
  if (ms === null && /^\d{15,20}$/.test(String(message?.id ?? ""))) {
    ms = Number((BigInt(message.id) >> 22n) + 1420070400000n);
  }
  if (ms === null && Number.isFinite(message?.createdTimestamp)) {
    ms = message.createdTimestamp;
  }
  if (ms === null || !Number.isFinite(ms)) ms = Date.now();
  return new Date(ms).toISOString().slice(0, 10);
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
async function runGorkHook(client, message) {
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

    // 9. Per-user cooldown (guild-overridable; 0 = disabled). A hit reacts
    //    to the trigger with a clock emoji (visible rate-limit signal; staff
    //    never see it) — no reply, no LLM call, and hits do not extend the
    //    window. The react is best-effort: a missing permission or a deleted
    //    message must never break the handler.
    const cd = gorkQueue.checkCooldown({
      guildId,
      userId: message.author.id,
      cooldownSec: settings.gork_cooldown_sec ?? DEFAULT_COOLDOWN_SEC,
      staff,
    });
    if (!cd.allowed) {
      await message.react(COOLDOWN_REACTION).catch(() => {});
      return;
    }

    // 10. Guild ban list (`/gork ban`): banned users — staff included, no
    //     bypass — get the locked LLM-failure canned reply so the ban is
    //     indistinguishable from a normal failure. Checked after the
    //     cooldown so a banned trigger only gets the clock reaction during
    //     the cooldown window (rate-limits the reply); no LLM call, no QA
    //     audit.
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

    // 13. Detached LLM job: fire-and-forget so the pipeline never awaits
    //     (registered with the test settle seam; see pendingGorkWork).
    const auditClient = client || message.guild.client || null;
    trackGorkWork(
      (async () => {
      let replied = false;
      // §7.16 write-path state: the shipped sanitized answer (null = no
      // real answer went out → never extract from a canned reply) plus a
      // reference to the read-path data (roster/ctx captured in the try).
      let shippedAnswer = null;
      let memJob = null;
      // §7.16 (decision 29): per-guild memory master switch, default OFF
      // — when OFF the prompt, tool payload, and audit stay byte-identical.
      const memoryOn = Number(settings.gork_memory_enabled ?? 0) === 1;
      // §7.16.2 read-path result (decision 27) — declared here (not in the
      // try) so the post-send write turn after the finally can reuse it.
      let mem = { block: "", mode: "none", indexed: 0, selectedIds: [], rows: [], allRows: [] };
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
        // §7.16.2 read path (decision 27): DB-only MEMORY BLOCK build after
        // the roster exists (the roster supplies the involved-people set;
        // the bot's own id is excluded — decision 26). loadMemoryContext
        // never throws; the wrapper is belt-and-suspenders.
        if (memoryOn) {
          try {
            mem = loadMemoryContext({
              guildId,
              roster,
              budgetChars: clampMemoryChars(settings.gork_memory_chars),
              botId: auditClient?.user?.id ?? null,
            });
            // Capture for the post-send write turn (no re-query later;
            // ctx is try-scoped, so its text is snapshotted here).
            memJob = { roster, ctxText: ctx?.text || "" };
          } catch {
            // Degrade to no memory block; answering never depends on it.
          }
        }
        const system = buildSystemPrompt({
          extraRules: settings.gork_extra_rules,
        });
        const searchOn = isWebSearchEnabled(settings);
        // Fix 6: visible-answer hard cap, re-read per job like the other
        // knobs (0 = off; splitLongAnswer then keeps long answers whole).
        const maxAnswerChars = envPositiveInt(
          "GORK_MAX_ANSWER_CHARS",
          DEFAULT_MAX_ANSWER_CHARS,
        );
        // Per-job tool counters for the audit embed (locked spec:
        // separate search / page-read tallies, not the combined total).
        let searches = 0;
        let reads = 0;
        // §7.16 recall counters: tool runs + memories actually fetched
        // (found ids only) for the Q&A audit's Memory label (decision 27).
        let recalls = 0;
        let recalled = 0;
        // §7.16 (decision 27): shared tool array — search pair and/or
        // recall_memories; empty stays `undefined` (payload unchanged when
        // both features are off).
        const tools = [];
        if (searchOn) tools.push(WEB_SEARCH_TOOL, READ_PAGE_TOOL);
        if (memoryOn) tools.push(RECALL_MEMORIES_TOOL);
        const llmOpts = {
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: buildUserContent(
                question,
                ctx,
                formatRosterBlock(roster),
                mem.block,
              ),
            },
          ],
          ...llmParams(),
          tools: tools.length ? tools : undefined,
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
            if (name === "recall_memories") {
              recalls += 1;
              // Never throws (§7.16.2). Found ids count toward the audit
              // label and stamp last_used_at so recalled rows win the
              // eviction recency tie-break (§7.16.1); touch is best-effort.
              return executeRecallMemory(args, {
                guildId,
                onRecall: (ids) => {
                  recalled += ids.length;
                  try {
                    gorkMemoryTouch(guildId, ids);
                  } catch {
                    // touch failure must never break the tool loop
                  }
                },
              });
            }
            return `unknown tool: ${name}`;
          },
        };
        let res = await chatWithTools(cfg, llmOpts);

        // Providers occasionally answer OK-with-empty-text (thinking-model
        // budget hiccups, transient upstream quirks). One retry beats the
        // canned failure reply.
        if (res.ok && !(res.content || "").trim()) {
          console.log(
            `[gork] ${describeLlmFailure(res)} from ${cfg.model} in ${guildId} (${res.durationMs ?? 0}ms); retrying once`,
          );
          res = await chatWithTools(cfg, llmOpts);
        }

        const answerText = (res.content || "").trim();
        if (answerText) {
          if (!res.ok) {
            // Tool-round cap with real content: deliver the partial answer
            // (better UX than the canned reply) but keep the breadcrumb.
            console.log(
              `[gork] delivering partial answer in ${guildId} (${res.reason}); tool budget exhausted`,
            );
          }
          // Fix 1: rewrite echoed mention markup to readable names, and
          // send with pings disabled so nothing notifies unintentionally.
          const answer = sanitizeAnswer(answerText, {
            roster,
            guild: message.guild,
          });
          // Fix 6: optional hard cap on the visible answer (0 = off).
          const capped = capAnswerChars(answer, maxAnswerChars);
          if (capped !== answer) {
            console.log(
              `[gork] answer capped to ${capped.length} chars in ${guildId}`,
            );
          }
          // Plain text reply TO the keyword message (decision 11); long
          // answers continue as consecutive channel messages.
          const chunks = splitLongAnswer(capped);
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
          // §7.16.3 (decision 25): the write path may only feed on a real
          // shipped (sanitized + capped) answer — never a canned reply.
          shippedAnswer = capped;
          // Audit posts are fire-and-forget for Discord but tracked for the
          // test settle seam, so "idle" also implies audit embeds landed.
          trackGorkWork(
            logGorkQa(auditClient, guildId, {
              user: message.author,
              question,
              contextLabel: describeContext(ctx),
              searchQueries: searches,
              pageReads: reads,
              model: cfg.model,
              durationMs: res.durationMs,
              answer: capped,
              questionMessage: message,
              replyMessage,
              // Read-side audit label (§7.16.3); OFF → undefined → no field.
              memoryLabel: memoryOn
                ? formatMemoryLabel(mem, recalled)
                : undefined,
            }),
          );
        } else {
          // Failure / timeout / persistent empty answer: locked canned
          // reply, never a silent hang.
          await message
            .reply({
              content: LLM_FAILURE_REPLY,
              allowedMentions: NO_PING_MENTIONS,
            })
            .catch(() => {});
          replied = true;
          const why = describeLlmFailure(res);
          console.warn(
            `[gork] LLM failure in ${guildId}: ${why} (model=${cfg.model}, toolCalls=${res.toolCalls ?? 0}, ${res.durationMs ?? 0}ms)`,
          );
          trackGorkWork(
            logGorkFailure(auditClient, guildId, {
              user: message.author,
              question,
              reason: why,
            }),
          );
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
      // §7.16.3 write path (decisions 25/27): detached memory turn AFTER
      // reply + audit + slot release — never adds user-visible latency
      // and never holds the guild slot. Fires only with memory ON and a
      // real sanitized answer shipped (not canned/failure), and only when
      // the roster resolves real people: subjects are roster ∪ asker
      // minus the bot id (§7.16.1, decision 26). memDate is the trigger
      // message's UTC day, stamped server-side (never model-emitted).
      if (memoryOn && shippedAnswer !== null && memJob?.roster?.entries?.size) {
        const roster = memJob.roster;
        const botId = auditClient?.user?.id ?? null;
        // Tracked (not bare `void`) so the settle seam drains extraction
        // turns too: after whenGorkIdleForTests(), the extraction decision
        // AND its fetch are observably settled.
        trackGorkWork(
          runMemoryTurn({
            guildId,
            auditClient,
            question,
            answer: shippedAnswer,
            contextBlock: memJob.ctxText,
            rosterBlock: formatRosterBlock(roster),
            // Reuse the rows loaded on the read path — no re-query (§7.16.3).
            existingMemoriesBlock: formatExistingMemoriesBlock(mem.allRows || []),
            allowList: [...roster.entries.keys()].filter((id) => id !== botId),
            memDate: memDateFromMessage(message),
            sourceMessageIds: [message.id],
            indexed: mem.indexed,
          })
            .then((res) => {
              if (res && (res.stored > 0 || res.skippedInvalid > 0)) {
                console.log(
                  `[gork] memory turn in ${guildId}: +${res.stored} stored · ${res.skippedInvalid} skipped_invalid`,
                );
              }
            })
            .catch(() => {}),
        );
      }
    })(),
    );
  } catch (err) {
    // 14. The pipeline must never see a rejection.
    console.error("[gork] pipeline hook error:", err?.message || err);
  }
}

/**
 * Pipeline-visible hook: the tracked wrapper around runGorkHook so the
 * settle-tracking seam (`whenGorkIdleForTests`) also covers hook-only
 * paths (cooldown clock reaction, banned/queue-full canned replies).
 * Same contract as runGorkHook: never throws, never rejects.
 *
 * @param {import("discord.js").Client} client
 * @param {import("discord.js").Message} message
 * @returns {Promise<void>}
 */
function handleGorkMessage(client, message) {
  return trackGorkWork(runGorkHook(client, message));
}

module.exports = {
  matchKeyword,
  splitLongAnswer,
  capAnswerChars,
  buildUserContent,
  memDateFromMessage,
  handleGorkMessage,
  gorkQueue,
  QUEUE_FULL_REPLY,
  LLM_FAILURE_REPLY,
  TYPING_REFRESH_MS,
  LLM_TEMPERATURE,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_MAX_TOOL_ROUNDS,
  /** 0 = off by default: keeps the locked multi-message long-answer spec intact. */
  DEFAULT_MAX_ANSWER_CHARS,
  ANSWER_TRUNCATE_MARKER,
  llmParams,
  describeLlmFailure,
  /** TEST SEAM: settle-drain for detached gork work (see pendingGorkWork). */
  whenGorkIdleForTests,
};
