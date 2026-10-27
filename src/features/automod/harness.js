/**
 * Auto-moderation LLM harness — THE case runner (#728, epic #723).
 *
 * One recorded referral → one judged run. This module owns the case
 * lifecycle (recorded→processing→complete|failed, 068 vocabulary), the
 * provider round loop (through the shared `src/core/ai.js` client —
 * function calling, same as Gork's tools), the COMMIT through the shipped
 * executor (#729), the staff-facing outcome post, and the run-metadata
 * persistence (070). NOT a Gork tool, not Gork's prompt, not Gork's queue,
 * not Gork's daily counter (locked decision 7): nothing here imports
 * `../gork/**`; the shared surface is the AI_* env trio via core/ai.js and
 * the harness's OWN budget counter (`consumeAutomodCase`, one case key per
 * community per UTC day, settings #725).
 *
 * Run lifecycle (contract #728):
 *  1. Input + case-row validation, budget PRE-GATE (blocked/exhausted
 *     refuses BEFORE any mutation so the case stays re-runnable after the
 *     day rolls — intake already gates this; the belt exists because the
 *     run may happen long after the referral).
 *  2. ATOMIC CLAIM — `UPDATE automod_cases SET status='processing'
 *     WHERE id=? AND status='recorded'`. A second run for the same case
 *     can never claim (the status guard IS the WHERE clause), which is why
 *     this is a conditional UPDATE rather than the unconditioned
 *     `setAutomodCaseStatus` facade helper.
 *  3. Placeholder post to the automod channel at start (names the
 *     referrer). A post failure is logged and the run CONTINUES — the
 *     referrer-visible surface then degrades to the completion message
 *     only (contract).
 *  4. Context via `buildCaseContext` (#727); its {ok:false} fails the run
 *     with the specific cause.
 *  5. Tool rounds through `deps.chat` (production default: core/ai
 *     `chatWithTools`; tests script every round). READ tools execute
 *     immediately; ACTION tools + the staff-note tool only RECORD INTENT
 *     during the loop — NOTHING mutates until commit (contract commit
 *     shape). Rounds capped by AUTOMOD_MAX_TOOL_ROUNDS.
 *  6. PROVIDER ACCEPTED ⟺ the loop got a parsed provider response at some
 *     point (ok result, ≥1 executed tool call, cap, or an empty-but-2xx
 *     body). Exactly then — and exactly ONCE — `consumeAutomodCase` runs.
 *     A call that never got accepted (HTTP 4xx/5xx, network, timeout,
 *     parse) consumes NOTHING (contract; test-pinned).
 *  7. COMMIT: every recorded action intent through
 *     `executeAutomodAction({... caseId, referrerUserId, claimant:
 *     "harness" })` — the executor already applies the mode gate, staff/
 *     hierarchy guards, the atomic claim, and the timeout clamp; the
 *     harness clamps nothing itself. Recorded staff-note intents then write
 *     through the REAL `createStaffNote` (author = the bot acting for the
 *     harness; content = the model's note + a case A-n reference; the
 *     dispatcher already guaranteed only-considered users, one note each).
 *     `deps.reconcileNotes` is #731's completeness hook (no-op today).
 *  8. Outcome post: the placeholder is EDITED (or a fresh post lands when
 *     the placeholder never did) with per-intent lines straight from the
 *     executor results + the meta line (model · duration · rounds · tools).
 *     Provider failures name the specific cause to the referrer:
 *     `Referred by <@id> — provider error: <cause>`.
 *  9. Metadata persist (070): last_model / last_duration_ms /
 *     last_tool_names / decision_log / last_run_error.
 *
 * Status semantics (documented decisions):
 *  - clean finish (model stopped with no tool calls) → `complete`.
 *  - ROUND CAP hit → commit STILL RUNS (contract: "still passes
 *    reconciliation"); the post names `tool-round cap (12) reached`; the
 *    case ends `complete` with that cause in `last_run_error` (the run
 *    finished and committed — it just ran out of rounds).
 *  - provider failure after acceptance (a mid-loop round died) → intents
 *    commit too, the case ends `failed` with the provider cause.
 *  - provider failure without acceptance → nothing was recorded, `failed`,
 *    zero budget consumed. A no-key configuration follows the same failed
 *    path AFTER the claim (the referrer-visible post names it).
 *
 * Isolation (AGENTS.md rules 1–3 + 6): nothing here may kill the client.
 * `runAutomodCase` never throws (belt catch names the cause); the detached
 * fire lives in refer.js with its own `.catch`; the boot sweep is defensive
 * per row. Every failure logs `[automod]` with community/guild/case ids and
 * every staff-facing line carries the specific cause.
 *
 * Lifecycle SQL note (file-ownership): the claim/metadata/sweep statements
 * live HERE against the shared connection handle (precedent:
 * `src/features/bridge/service.js`) because #728 may not edit
 * `src/db/repositories/automodCases.js`; they touch ONLY the columns 068
 * and 070 own and the status vocabulary `AUTOMOD_CASE_STATUSES` pins.
 *
 * Post shapes #730 replaces (exported builders — grep them in tests):
 *  - `buildReviewPlaceholderPayload(caseRow)` — the start placeholder.
 *  - `buildDecisionPayload({...})` — the outcome post (plain embed, NO
 *    buttons: Approve/Dismiss arrive with #730's card).
 *  - `buildInterruptedPayload(caseRow)` — the boot-sweep notice.
 */

const { sliceSafe } = require("../../core/text");
const {
  db: facadeDb,
  now: facadeNow,
  getAutomodCaseById,
  getAutomodBudget,
  consumeAutomodCase,
  createStaffNote,
  MAX_NOTE_CONTENT,
} = require("../../db");
const { getAiConfig, chatWithTools } = require("../../core/ai");
const { buildCaseContext } = require("./caseContext");
const { executeAutomodAction } = require("./executor");
const { readSettings } = require("./settings");
const { createToolDispatcher } = require("./harnessTools");
const { buildSystemPrompt, buildUserMessage } = require("./prompt");
const {
  AUTOMOD_ACTIONS,
  AUTOMOD_MAX_TOOL_ROUNDS,
  AUTOMOD_RUN_TIMEOUT_MS,
} = require("./constants");

/** The boot-sweep cause, pinned by the sweep test (#728 contract copy). */
const INTERRUPTED_ERROR = "run interrupted by restart";

/** Embed palette (review yellow / decision green / failure red). */
const COLORS = Object.freeze({
  review: 0xf1c40f,
  complete: 0x57f287,
  failed: 0xed4245,
});

/** Discord embed field cap is 1024 — stay under it. */
const EMBED_FIELD_MAX = 1000;

/* ── logging + service shape (AGENTS.md rules 2/3/6) ─────────────────────── */

function idTag({ communityId, guildId, caseId, caseNumber }) {
  return (
    `(community ${communityId ?? "?"} guild ${guildId ?? "?"} case ` +
    `${caseNumber != null ? `A-${caseNumber}` : `#${caseId ?? "?"}`})`
  );
}

function logFail(what, ids, err) {
  console.error(
    `[automod] harness ${what} failed ${idTag(ids)}:`,
    err?.message || err,
  );
}

/** Empty/whitespace → null (the automod family idiom). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** The ONE pre-run failure exit (no claim happened — nothing mutated). */
function refuseRun(ids, message) {
  console.error(`[automod] harness run refused ${idTag(ids)}: ${message}`);
  return { ok: false, state: "refused", error: message };
}

/**
 * The provider's SPECIFIC failure text (contract: the referrer gets the
 * provider's own words, not "something failed"). core/ai attaches
 * `errorBody` (truncated provider body) on HTTP errors — it usually names
 * the real cause ("invalid API key", "model not found").
 */
function formatProviderCause(res) {
  const base = res?.error || (res?.reason ? `provider ${res.reason}` : "unknown error");
  const status = res?.status != null && !String(base).includes(String(res.status))
    ? ` (HTTP ${res.status})`
    : "";
  const body = optionalText(res?.errorBody);
  return `${base}${status}${body ? ` — provider said: ${sliceSafe(body, 200)}` : ""}`;
}

/* ── lifecycle SQL (claim / metadata / sweep) — harness-owned, see header ── */

function claimProcessing(dbHandle, caseId, t) {
  const info = dbHandle
    .prepare(
      `UPDATE automod_cases SET status='processing', updated_at=? WHERE id=? AND status='recorded'`,
    )
    .run(t, caseId);
  return info.changes === 1;
}

function writeRunMetadata(dbHandle, caseId, meta, t) {
  dbHandle
    .prepare(
      `UPDATE automod_cases
          SET status=?, updated_at=?, last_model=?, last_duration_ms=?,
              last_tool_names=?, decision_log=?, last_run_error=?
        WHERE id=?`,
    )
    .run(
      meta.status,
      t,
      meta.model ?? null,
      Number.isFinite(Number(meta.durationMs)) ? Math.max(0, Math.floor(Number(meta.durationMs))) : null,
      meta.toolNames ? JSON.stringify(meta.toolNames) : null,
      meta.decisionLog ? JSON.stringify(meta.decisionLog) : null,
      meta.lastRunError ?? null,
      caseId,
    );
}

/* ── post payload builders (exact shapes #730 replaces with the card) ────── */

/**
 * The start placeholder — posted to the automod channel when the run
 * claims the case. Shape:
 *   { allowedMentions: {parse:[]},
 *     embeds: [{ title: "Automod — case A-n — reviewing",
 *                description, fields: [{name:"Referral", value:"Referred by <@id>"}],
 *                color: 0xf1c40f }] }
 *
 * @param {object} caseRow the automod_cases row
 * @returns {object} a channel.send-able payload
 */
function buildReviewPlaceholderPayload(caseRow) {
  return {
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: `Automod — case A-${caseRow.case_number} — reviewing`,
        description:
          "The judge is reading the referral, the message window, and the records. The decision posts on this message when the run finishes.",
        fields: [
          { name: "Referral", value: sliceSafe(`Referred by <@${caseRow.referrer_user_id}>`, EMBED_FIELD_MAX) },
        ],
        color: COLORS.review,
      },
    ],
  };
}

/**
 * The outcome post (placeholder edit or fresh post). Shape:
 *   { allowedMentions: {parse:[]},
 *     embeds: [{ title: "Automod — case A-n — decision|run failed",
 *                description: summaryText   // failure lines name the referrer
 *                fields: [{name:"Decision", value: per-intent lines}],
 *                footer: {text: "Model X · N ms · R round(s) · tools: …"},
 *                color }] }
 * Plain embed: NO components/buttons — the Approve/Dismiss card is #730's.
 */
function buildDecisionPayload({ caseRow, summaryText, lines = [], meta = {}, failed = false }) {
  const fieldLines = lines.length ? lines.join("\n") : "_No action calls were recorded this run._";
  const footerParts = [
    `Model ${meta.model ?? "?"}`,
    `${Number.isFinite(Number(meta.durationMs)) ? Math.floor(Number(meta.durationMs)) : "?"} ms`,
    `${Number.isFinite(Number(meta.rounds)) ? Math.floor(Number(meta.rounds)) : 0} round(s)`,
    `tools: ${(meta.toolNames ?? []).join(", ") || "none"}`,
  ];
  return {
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: `Automod — case A-${caseRow.case_number} — ${failed ? "run failed" : "decision"}`,
        description: sliceSafe(summaryText ?? "", 4000),
        fields: [{ name: "Decision", value: sliceSafe(fieldLines, EMBED_FIELD_MAX) }],
        footer: { text: sliceSafe(footerParts.join(" · "), 2048) },
        color: failed ? COLORS.failed : COLORS.complete,
      },
    ],
  };
}

/** The boot-sweep notice (minimal; the case's real state is the row). */
function buildInterruptedPayload(caseRow) {
  return {
    allowedMentions: { parse: [] },
    embeds: [
      {
        title: `Automod — case A-${caseRow.case_number} — interrupted`,
        description: sliceSafe(
          `Referred by <@${caseRow.referrer_user_id}> — the review run was interrupted by a restart. The case was marked **failed** (${INTERRUPTED_ERROR}); a staff member can handle it manually.`,
          4000,
        ),
        color: COLORS.failed,
      },
    ],
  };
}

/* ── deps seams ──────────────────────────────────────────────────────────── */

/**
 * Production deps over a Discord client, every seam individually
 * overridable (executor/caseContext `buildDefaultDeps` posture). Tests
 * replace `chat`, the posts, the executor entry, the note writer, or any
 * single read — the runner itself never touches Discord directly.
 *
 * @param {{client?: object}} [over]
 */
function makeRunDeps({ client = null } = {}) {
  return {
    db: facadeDb,
    now: () => facadeNow(),
    aiConfig: () => getAiConfig(),
    /**
     * The provider seam. Same argument shape as core/ai `chatWithTools`
     * (cfg, {messages, tools, executeTool, maxToolRounds, timeoutMs}).
     * A result may carry an extra `rounds` number (the meta line prefers
     * it); the production wrapper attaches it from the round-tagged
     * capture events so fakes can pin the meta line too.
     */
    chat: (cfg, opts) => {
      let maxRound = -1;
      const wrapped = {
        ...opts,
        onEvent: (evt) => {
          if (Number.isFinite(evt?.round)) maxRound = Math.max(maxRound, evt.round);
          if (typeof opts.onEvent === "function") opts.onEvent(evt);
        },
      };
      return chatWithTools(cfg, wrapped).then((res) => ({
        ...res,
        rounds: Number.isFinite(res?.rounds) ? res.rounds : Math.max(0, maxRound + 1),
      }));
    },
    getCase: (caseId) => getAutomodCaseById(caseId),
    readSettings: (communityId) => readSettings(communityId),
    getBudget: (communityId, nowMs) => getAutomodBudget(communityId, nowMs),
    consume: (communityId, nowMs) => consumeAutomodCase(communityId, { nowMs }),
    /** seam passed THROUGH to buildCaseContext (its own buildDefaultDeps
     *  fills the rest from `client`). */
    contextDeps: { client },
    /** seam for the lookups' guild-isolation member read. */
    lookupDeps: { client },
    /** seam passed THROUGH to executeAutomodAction (its buildDefaultDeps
     *  fills the Discord mutations from `client`; tests inject `actions`). */
    actionDeps: { client },
    /** The executor entry — tests inject a recording wrapper around the
     *  REAL executor to prove commit order without mocking its guts. */
    executeAction: (input) => executeAutomodAction(input),
    /** The REAL staff-notes write (repository via the facade). */
    createNote: ({ communityId, userId, authorId, content }) =>
      createStaffNote({ communityId, userId, authorId, content }),
    botUserId: client?.user?.id ? String(client.user.id) : "automod",
    postToChannel: async (channelId, payload) => {
      if (!client?.channels?.fetch) {
        throw new Error("no Discord client — the case outcome cannot post");
      }
      const channel = await client.channels.fetch(String(channelId));
      if (!channel?.send) throw new Error(`channel ${channelId} did not resolve to a sendable channel`);
      return channel.send(payload);
    },
    editMessage: async (message, payload) => {
      if (!message || typeof message.edit !== "function") {
        throw new Error("the placeholder message cannot be edited");
      }
      return message.edit(payload);
    },
    /** #731's staff-note completeness reconciler plugs in HERE (see
     *  commitRunIntents). Default: absent → no-op. */
    reconcileNotes: null,
  };
}

/** Merge caller deps over the production defaults (explicit seams win). */
function buildRunDeps(over = {}) {
  const base = makeRunDeps({ client: over?.client ?? null });
  return { ...base, ...over };
}

/* ── commit ──────────────────────────────────────────────────────────────── */

/** One decision-post line per recorded action intent, from the EXECUTOR
 *  RESULT (state + error/result verbatim — the card never re-derives). */
function formatActionLine(intent, out) {
  const state = out?.state ?? (out?.ok ? "executed" : "failed");
  const detail =
    out?.error ??
    out?.result ??
    (out?.inFlight ? "already claimed by another run" : "") ??
    "";
  const suffix = detail ? ` — ${sliceSafe(String(detail), 220)}` : "";
  return `- \`${intent.action}\` → <@${intent.subjectUserId}>: **${state}**${suffix}`;
}

/**
 * Run every recorded intent through the executor + the real note writer.
 * Order (documented for #730/#731): ACTIONS first (the executor's own
 * claims/dedupe own those rows), then NOTES, then the reconciler hook.
 * Partial failures report partial results (AGENTS.md rule 5) — one dead
 * intent never cancels the rest.
 */
async function commitRunIntents({ d, cid, gid, caseRow, referrerUserId, dispatcher, ids }) {
  const lines = [];
  const actionResults = [];
  const noteResults = [];

  for (const intent of dispatcher.actionIntents) {
    let out;
    try {
      out = await d.executeAction({
        communityId: cid,
        guildId: gid,
        caseId: caseRow.id,
        action: intent.action,
        subjectUserId: intent.subjectUserId,
        params: intent.params,
        referrerUserId,
        claimant: "harness",
        deps: d.actionDeps ?? {},
      });
    } catch (err) {
      // Belt: executeAutomodAction never throws (rule 6) — an injected seam
      // that does still gets a specific line instead of killing the loop.
      logFail("action commit (executor threw)", { ...ids, caseId: caseRow.id }, err);
      out = { ok: false, state: "failed", error: `executor threw: ${err?.message || err}` };
    }
    actionResults.push({ intent, out });
    lines.push(formatActionLine(intent, out));
  }

  const suffix = ` (automod case A-${caseRow.case_number})`;
  for (const note of dispatcher.noteIntents) {
    try {
      const body = sliceSafe(note.content, Math.max(1, MAX_NOTE_CONTENT - suffix.length));
      const row = d.createNote({
        communityId: cid,
        userId: note.userId,
        // Actor = the bot acting for the harness (the repository stores the
        // id verbatim; the staff surfaces render the bot user).
        authorId: optionalText(d.botUserId) ?? "automod",
        content: `${body}${suffix}`,
      });
      noteResults.push({ ok: true, userId: note.userId, row });
      lines.push(`- staff note → <@${note.userId}>: recorded (N-${row?.note_number ?? "?"}).`);
    } catch (err) {
      logFail("staff-note commit", { ...ids, userId: note.userId }, err);
      noteResults.push({ ok: false, userId: note.userId, error: err?.message || String(err) });
      lines.push(`- staff note → <@${note.userId}>: **could not record** — ${sliceSafe(err?.message || String(err), 200)}`);
    }
  }

  // #731 HOOK POINT — the staff-note completeness reconciler (every
  // considered user ends with a note; the considered set is exactly
  // dispatcher.consideredUserIds(), the action rows already record
  // consideration independently). Absent today → no-op; guarded so a
  // broken reconciler can never break the commit.
  if (typeof d.reconcileNotes === "function") {
    try {
      const extra = await d.reconcileNotes({
        communityId: cid,
        guildId: gid,
        caseRow,
        consideredUserIds: dispatcher.consideredUserIds(),
        notedUserIds: dispatcher.noteIntents.map((n) => n.userId),
        deps: d,
      });
      if (Array.isArray(extra?.lines)) lines.push(...extra.lines);
    } catch (err) {
      logFail("note reconciliation", ids, err);
      lines.push(`- note reconciliation: **failed** — ${sliceSafe(err?.message || String(err), 200)}`);
    }
  }

  return { lines, actionResults, noteResults };
}

/* ── the runner ──────────────────────────────────────────────────────────── */

/**
 * Run the LLM harness for ONE recorded case. Service contract (rule 6):
 * never throws, never replies to Discord by itself outside the automod
 * channel posts, returns { ok, state, error? }.
 *
 * @param {object} input
 * @param {number} input.communityId
 * @param {string} input.guildId
 * @param {number} input.caseId                     automod_cases row id
 * @param {object} [input.deps]                     seam overrides (see makeRunDeps)
 * @param {number} [input.nowMs]
 * @returns {Promise<{ ok: boolean, state: "complete"|"failed"|"refused",
 *                     caseRef?: string, error?: string }>}
 */
async function runAutomodCase(input = {}) {
  const { communityId = null, guildId = null, caseId = null, deps = {}, nowMs } = input;
  try {
    return await runCaseInner({ communityId, guildId, caseId, deps, nowMs });
  } catch (err) {
    // Belt (rule 6): every known path returns the service shape; anything
    // escaping is a bug — name it with the ids, never a silent drop.
    logFail("unexpected run error", {
      communityId,
      guildId,
      caseId,
    }, err);
    return { ok: false, state: "failed", error: `Auto-mod harness error: ${err?.message || err}` };
  }
}

async function runCaseInner({ communityId, guildId, caseId, deps, nowMs }) {
  const cid = Number(communityId);
  const gid = optionalText(guildId);
  const caseIdNum = Number(caseId);
  const ids = { communityId: Number.isInteger(cid) ? cid : null, guildId: gid, caseId: Number.isInteger(caseIdNum) ? caseIdNum : null };
  const d = buildRunDeps(deps ?? {});
  const t0 = nowMs ?? d.now();
  const startedAt = d.now();

  // ── 1. inputs + case row (read-only) ────────────────────────────────────
  if (!Number.isInteger(cid) || cid < 1) {
    return refuseRun(ids, "A valid integer communityId is required — the run cannot start without it.");
  }
  if (!gid) {
    return refuseRun(ids, "A guildId (Discord snowflake) is required — auto-moderation is Discord-only for this milestone (#723 decision 8).");
  }
  if (!Number.isInteger(caseIdNum) || caseIdNum < 1) {
    return refuseRun(ids, "A valid integer caseId is required — one run judges exactly one recorded case.");
  }
  ids.caseId = caseIdNum;

  const loaded = (() => {
    try {
      return d.getCase(caseIdNum);
    } catch (err) {
      logFail("case load", ids, err);
      return undefined;
    }
  })();
  if (loaded === undefined) {
    return refuseRun(ids, `Could not read the case row (database error) — nothing was run.`);
  }
  if (!loaded) {
    return refuseRun(ids, `No auto-mod case row #${caseIdNum} — there is nothing to run.`);
  }
  const caseRow = loaded;
  ids.caseNumber = caseRow.case_number;
  const caseRef = `A-${caseRow.case_number}`;
  if (Number(caseRow.community_id) !== cid) {
    return refuseRun(ids, `Case ${caseRef} belongs to community ${caseRow.community_id}, not ${cid} — refusing to run a case across communities.`);
  }
  const referrerUserId = String(caseRow.referrer_user_id ?? "");

  // ── settings (modes + the automod channel) ──────────────────────────────
  const settings = d.readSettings(cid);
  if (!settings.ok) {
    return refuseRun(ids, `Could not read the automod settings: ${settings.error}`);
  }
  const modes = settings.settings.modes ?? {};
  const automodChannelId = settings.settings.channelId;

  // ── budget PRE-GATE (before any mutation; day-rollover retry stays open) ─
  const budget = (() => {
    try {
      return d.getBudget(cid, t0);
    } catch (err) {
      logFail("budget read", ids, err);
      return null;
    }
  })();
  if (!budget) {
    return refuseRun(ids, "Could not read the daily case budget (database error) — refusing to run unaccountably.");
  }
  if (budget.remaining === -1 || budget.limit <= -1) {
    return refuseRun(ids, "**Daily budget:** blocked (`-1`) — no case can run until an admin opens the budget with `/automodconfig budget`.");
  }
  if (budget.limit > 0 && budget.remaining === 0) {
    return refuseRun(ids, `**Daily budget:** exhausted — ${budget.used} of ${budget.limit} cases counted today (UTC day). The case stays recorded; the run retries after the day rolls or an admin raises the cap.`);
  }

  // ── 2. atomic claim (recorded → processing) — the status guard ──────────
  let claimed = false;
  try {
    claimed = claimProcessing(d.db, caseIdNum, t0);
  } catch (err) {
    logFail("case claim", ids, err);
    return { ok: false, state: "failed", caseRef, error: `Could not claim the case for a run (database error): ${err?.message || err}` };
  }
  if (!claimed) {
    let currentStatus = "?";
    try {
      currentStatus = d.getCase(caseIdNum)?.status ?? "?";
    } catch {
      /* display only */
    }
    return {
      ok: false,
      state: "refused",
      caseRef,
      error: `Case ${caseRef} is not runnable (status \`${currentStatus}\`) — one referral starts exactly one run.`,
    };
  }

  // ── 3. placeholder post (failure logged; the run continues) ─────────────
  let placeholder = null;
  const deliver = async (payload) => {
    if (!automodChannelId) return; // intake required one; cleared since — logged below
    if (placeholder) {
      try {
        await d.editMessage(placeholder, payload);
        return;
      } catch (err) {
        logFail("placeholder edit (falling back to a fresh post)", ids, err);
      }
    }
    try {
      await d.postToChannel(automodChannelId, payload);
    } catch (err) {
      logFail("outcome post", ids, err); // degrade: the row + logs carry the truth
    }
  };
  if (!automodChannelId) {
    console.error(
      `[automod] harness automod channel unset ${idTag(ids)} — the outcome cannot post; the decision still runs and records.`,
    );
  } else {
    try {
      placeholder = await d.postToChannel(automodChannelId, buildReviewPlaceholderPayload(caseRow));
    } catch (err) {
      logFail("placeholder post (continuing without it)", ids, err);
      placeholder = null;
    }
  }

  /** Finish: persist metadata (070) + deliver the outcome post. */
  const finishRun = async ({ status, runError = null, model = null, lines = [], summaryText, toolNames = [], decisionLog = [], rounds = 0 }) => {
    const durationMs = d.now() - startedAt;
    try {
      writeRunMetadata(d.db, caseIdNum, {
        status,
        model: model ?? null,
        durationMs,
        toolNames,
        decisionLog,
        lastRunError: runError,
      }, d.now());
    } catch (err) {
      // The outcome is already decided; a metadata failure is loud, not fatal.
      logFail("run metadata persist", ids, err);
    }
    await deliver(
      buildDecisionPayload({
        caseRow,
        summaryText:
          summaryText ??
          (status === "failed"
            ? `Referred by <@${referrerUserId}> — automod run failed: ${runError ?? "unknown error"}`
            : `Referred by <@${referrerUserId}> — review complete.`),
        lines,
        meta: { model, durationMs, rounds, toolNames },
        failed: status === "failed",
      }),
    );
    return durationMs;
  };

  // ── 4. AI config (after the claim — the referrer-visible cause is a FAILED
  //       case with zero consumption, per the #728 test contract) ──────────
  let cfg = null;
  try {
    cfg = d.aiConfig();
  } catch (err) {
    logFail("AI config read", ids, err);
  }
  if (!cfg || !cfg.apiKey) {
    const error =
      "AI not configured — no AI_API_KEY (or OPENAI_API_KEY) is set, so no provider call was made and no case was consumed. An operator must configure the provider.";
    await finishRun({ status: "failed", runError: error });
    return { ok: false, state: "failed", caseRef, error };
  }

  // ── 5. evidence bundle (#727) — its {ok:false} fails the run specifically ─
  const built = await buildCaseContext({
    communityId: cid,
    guildId: gid,
    case: caseRow,
    deps: d.contextDeps ?? {},
    nowMs: t0,
  });
  if (!built.ok) {
    await finishRun({
      status: "failed",
      runError: built.error,
      summaryText: `Referred by <@${referrerUserId}> — automod could not build the case context: ${built.error}`,
      model: cfg.model,
    });
    return { ok: false, state: "failed", caseRef, error: built.error };
  }
  const context = built.context;

  // ── 6. tool rounds (schemas FROM the mode gate; intent-only during loop) ─
  const dispatcher = createToolDispatcher({
    communityId: cid,
    guildId: gid,
    caseRow,
    modes,
    subjectUserId: context?.subject?.user_id ?? null,
    deps: { lookupDeps: d.lookupDeps ?? {} },
  });
  const offeredActions = dispatcher.tools
    .map((t) => t?.function?.name)
    .filter((name) => AUTOMOD_ACTIONS.includes(name));

  const chatMessages = [
    {
      role: "system",
      content: buildSystemPrompt({
        rules: context.rules ?? "",
        modes,
        offeredActions,
        caseRef: context?.case?.case_ref ?? caseRef,
      }),
    },
    { role: "user", content: buildUserMessage(context) },
  ];

  let res;
  try {
    res = await d.chat(cfg, {
      messages: chatMessages,
      tools: dispatcher.tools,
      executeTool: dispatcher.executeTool,
      maxToolRounds: AUTOMOD_MAX_TOOL_ROUNDS,
      timeoutMs: AUTOMOD_RUN_TIMEOUT_MS,
    });
  } catch (err) {
    // A throwing seam is still "the provider failed": a specific cause,
    // no consumption, a failed case (rule 3).
    logFail("provider call threw", ids, err);
    res = { ok: false, reason: "network", error: `provider call threw: ${err?.message || err}`, toolCalls: 0 };
  }

  // ── 7. ACCEPTANCE → consume EXACTLY once (failed calls consume nothing) ─
  const toolCalls = Number(res?.toolCalls) || 0;
  const accepted =
    res?.ok === true || toolCalls > 0 || res?.reason === "empty" || res?.reason === "cap";
  if (accepted) {
    try {
      const consumed = d.consume(cid, d.now());
      if (consumed && consumed.ok === false) {
        // The provider call already happened — surface the accounting gap
        // loudly (the counter refused on a race: blocked/exhausted between
        // the pre-gate and acceptance). Never pretend it counted.
        console.error(
          `[automod] harness budget consume refused ${idTag(ids)}:`,
          consumed.reason ?? "unknown",
        );
      }
    } catch (err) {
      logFail("budget consume (after an accepted provider call)", ids, err);
    }
  }

  // ── 8. status/cause determination (cap commits; errors fail the case) ───
  let status = "complete";
  let runError = null;
  if (!res?.ok) {
    if (res?.reason === "cap") {
      runError = `tool-round cap (${AUTOMOD_MAX_TOOL_ROUNDS}) reached — the run committed what it had recorded`;
    } else {
      status = "failed";
      runError = `provider error: ${formatProviderCause(res)}`;
    }
  }

  // ── 9. COMMIT (contract: nothing mutated during the rounds; the
  //       executor + the real note writer own everything from here) ────────
  const commit = await commitRunIntents({ d, cid, gid, caseRow, referrerUserId, dispatcher, ids });

  // ── 10. outcome post + metadata ─────────────────────────────────────────
  let summaryText;
  if (status === "failed") {
    // Contract naming: the referrer sees the provider's specific failure.
    summaryText = `Referred by <@${referrerUserId}> — provider error: ${formatProviderCause(res)}`;
  } else if (runError) {
    summaryText =
      `Referred by <@${referrerUserId}> — partial decision: the run hit the ${runError}. ` +
      "What it had recorded committed; nothing further ran.";
  } else {
    summaryText = `Referred by <@${referrerUserId}> — review complete.`;
  }

  await finishRun({
    status,
    runError,
    model: cfg.model,
    lines: commit.lines,
    summaryText,
    toolNames: dispatcher.toolNames,
    decisionLog: dispatcher.decisionLog,
    rounds: Number.isFinite(Number(res?.rounds)) ? Number(res.rounds) : toolCalls,
  });

  return {
    ok: status === "complete",
    state: status,
    caseRef,
    ...(runError ? { error: runError } : {}),
    commit,
  };
}

/* ── boot sweep + wiring ─────────────────────────────────────────────────── */

/**
 * Fail cases stuck in `processing` from a previous boot (the runner is
 * in-process; a restart orphans them). Best-effort channel notice naming
 * the case when the automod channel still exists — logged, never thrown.
 *
 * Synchronous DB pass + DETACHED post promises (each carries its own
 * catch), returned as `posts` so tests can await delivery; the feature
 * start hook never blocks and load.js's per-feature guard already wraps
 * the hook itself.
 *
 * @param {{client?: object, db?: object, postToChannel?: Function}} [opts]
 * @returns {{ checked: number, flipped: number, posts: Promise[] }}
 */
function sweepInterruptedRuns({ client = null, db: dbHandle = null, postToChannel = null } = {}) {
  const out = { checked: 0, flipped: 0, posts: [] };
  const handle = dbHandle ?? facadeDb;
  try {
    const rows = handle
      .prepare(`SELECT * FROM automod_cases WHERE status='processing' ORDER BY id ASC`)
      .all();
    for (const row of rows) {
      out.checked += 1;
      const ids = {
        communityId: row.community_id,
        guildId: null,
        caseId: row.id,
        caseNumber: row.case_number,
      };
      try {
        handle
          .prepare(
            `UPDATE automod_cases SET status='failed', updated_at=?, last_run_error=? WHERE id=?`,
          )
          .run(facadeNow(), INTERRUPTED_ERROR, row.id);
        out.flipped += 1;
      } catch (err) {
        logFail("boot sweep flip", ids, err);
        continue;
      }
      // Detached, best-effort, self-catching (rule 1):
      const post = (async () => {
        try {
          const channelId = (() => {
            const read = readSettings(Number(row.community_id));
            return read.ok ? read.settings.channelId : null;
          })();
          if (!channelId) return;
          const send =
            postToChannel ??
            (async (chId, payload) => {
              if (!client?.channels?.fetch) throw new Error("no Discord client for the sweep notice");
              const channel = await client.channels.fetch(String(chId));
              if (!channel?.send) throw new Error(`channel ${chId} is not sendable`);
              return channel.send(payload);
            });
          await send(channelId, buildInterruptedPayload(row));
        } catch (err) {
          logFail("boot sweep notice (best effort)", ids, err);
        }
      })();
      out.posts.push(post);
    }
    if (out.checked > 0) {
      console.log(`[automod] boot sweep: ${out.flipped}/${out.checked} case run(s) interrupted by restart marked failed.`);
    }
  } catch (err) {
    console.error("[automod] boot sweep failed:", err?.message || err);
  }
  return out;
}

/**
 * Build the refer.js run hook: the detached trigger installed on boot
 * (see index.js). It only forwards ids — the run owns every seam.
 *
 * @param {{client?: object, deps?: object}} [opts]
 * @returns {(input: {communityId: number, guildId: string, case: object}) => Promise<object>}
 */
function makeReferRunHook({ client = null, deps = {} } = {}) {
  const runDeps = { client, ...deps };
  return ({ communityId = null, guildId = null, case: caseRow = null } = {}) =>
    runAutomodCase({
      communityId,
      guildId,
      caseId: caseRow?.id ?? null,
      deps: runDeps,
    });
}

module.exports = {
  INTERRUPTED_ERROR,
  runAutomodCase,
  sweepInterruptedRuns,
  makeReferRunHook,
  makeRunDeps,
  buildRunDeps,
  // Post shapes (#730 replaces these with the case card — grep before changing):
  buildReviewPlaceholderPayload,
  buildDecisionPayload,
  buildInterruptedPayload,
  // Pure pieces:
  formatProviderCause,
  formatActionLine,
  commitRunIntents,
};
