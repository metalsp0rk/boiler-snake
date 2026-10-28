/**
 * Auto-moderation harness TOOL LAYER — schemas + dispatch (#728, epic #723).
 *
 * Two jobs, one module:
 *  1. Schema building: the OpenAI-compatible function definitions offered to
 *     the model for ONE case run, derived FROM THE MODE GATE (locked
 *     decision 2): every `off` action is OMITTED from the toolset entirely;
 *     `no_action / warn / delete_message / ticket / timeout / kick / ban`
 *     appear only for modes that are `suggest` or `auto`. The staff-note
 *     tool and the two read tools (lookups.js, #727) are ALWAYS present —
 *     they have no mode flag and cannot be disabled (locked decisions 4/5).
 *     Authoring style follows `src/features/gork/tools/readDiscord.js`
 *     (frozen JSON Schema per function); Gork's own tools/prompt/queue stay
 *     untouched — this module imports nothing from `../gork/**` (locked
 *     decision 7: the harness shares only the provider env via
 *     `src/core/ai.js`, which the RUNNER owns, not this module).
 *
 *  2. Dispatch: `createToolDispatcher` returns the `executeTool(name, args)`
 *     the provider tool loop calls. Contract (issue #728, verbatim law):
 *     - READ tools (read_warnings / read_staff_notes) execute IMMEDIATELY
 *       through the ungated, guild-isolated lookups service (#727).
 *     - ACTION tools + the staff-note tool only RECORD INTENT during the
 *       round loop (the commit shape the executor consumes at commit):
 *       NOTHING mutates here — no action rows, no warnings, no notes, no
 *       Discord calls. The tool result tells the model it was recorded and
 *       when it applies ("applied at commit"; suggest-mode lines carry the
 *       neutral `**Status:** awaiting staff approval` — no forward
 *       references to unshipped card surfaces in user-facing copy).
 *     - Params are validated ON DISPATCH with a specific tool-result error
 *       string; the dispatcher NEVER throws (a garbage tool call feeds the
 *       model a cause and the loop continues — the gork decision-47 posture).
 *     - Enforcement lives here, not in the prompt alone (locked decision 4):
 *       * one staff note per user per case (a second call is refused),
 *       * a note call QUEUES the note for COMMIT RECONCILIATION (#731): the
 *         note lands only for users with recorded action intent (including
 *         `no_action`); the commit-time reconciler writes notes for subjects,
 *         DROPS notes for users with no intent (zero rows, card names it) and
 *         harness-fills narratives the model omitted. Call order therefore
 *         does not matter — but param validation and the per-user dedupe DO
 *         run here, at call time,
 *       * one call per (action, user) per run (mirrors the executor's
 *         unique case slot),
 *       * an `off` action cannot run even if a model hallucinates the call.
 *
 * Timeout durations are validated as a positive number of seconds and
 * passed through UNCLAMPED — the executor owns the [60 s, guild cap] clamp
 * and the row that echoes the duration actually used (#729). No second
 * clamp here.
 */

const { sliceSafe } = require("../../core/text");
const { MAX_NOTE_CONTENT } = require("../../db");
const {
  readWarningsForLookup,
  readStaffNotesForLookup,
  LOOKUP_TOOL_NAMES,
} = require("./lookups");
const { anchorJumpLink } = require("./caseNote");
const {
  AUTOMOD_ACTIONS,
  AUTOMOD_TOOL_RESULT_MAX_CHARS,
  AUTOMOD_DECISION_LOG_MAX_ENTRIES,
} = require("./constants");

/** Model-facing tool names. Action tools are named EXACTLY like the
 *  executor's action ids (one vocabulary across schema → dispatch → row). */
const TOOL_NAMES = Object.freeze({
  staffNote: "write_staff_note",
  readWarnings: LOOKUP_TOOL_NAMES.warnings, // "read_warnings"
  readStaffNotes: LOOKUP_TOOL_NAMES.notes, // "read_staff_notes"
});

/** Hard cap on a persisted per-entry summary/result string (belt). */
const SUMMARY_MAX = 200;

/* ────────────────────────────── schemas ─────────────────────────────────── */

/** Shared `user_id` property (every tool takes an explicit member id). */
function userIdProp(what) {
  return Object.freeze({
    type: "string",
    description:
      `The Discord user id of the member this ${what} is about — an id from ` +
      "the referral or the message window, never a guess.",
  });
}

/** Standard reason/rationale property. */
function reasonProp(label) {
  return Object.freeze({
    type: "string",
    description: `${label} — short, factual, and grounded in the quoted rules.`,
  });
}

/** One OpenAI-compatible function tool definition (readDiscord.js shape). */
function toolDef(name, description, properties, required = ["user_id"]) {
  return Object.freeze({
    type: "function",
    function: Object.freeze({
      name,
      description,
      parameters: Object.freeze({
        type: "object",
        properties: Object.freeze(properties),
        required: Object.freeze(required),
        additionalProperties: false,
      }),
    }),
  });
}

/** Per-action schema descriptors. `extra` adds action-specific params. */
const ACTION_TOOL_SPECS = Object.freeze({
  no_action: Object.freeze({
    description:
      "Record that a user WAS CONSIDERED and no sanction is warranted (they " +
      "came close, or the rules simply do not reach them). This is how a " +
      "user becomes considered — a staff note can then be written about " +
      "them. Do NOT use this for bystanders you did not weigh. `reason` is " +
      "required: it is stored on the decision row and in the staff note.",
    extra: Object.freeze({
      reason: reasonProp("Why no action is warranted for this user"),
    }),
    required: Object.freeze(["user_id", "reason"]),
  }),
  warn: Object.freeze({
    description:
      "Record a FORMAL warning against the user (the permanent warnings " +
      "record, distinct from a staff note). Read their history first. " +
      "`reason` is MEMBER-FACING — the warned user reads it verbatim in " +
      "their warning DM, so write what they did, never your private " +
      "rationale or anything from a staff note.",
    extra: Object.freeze({
      reason: reasonProp(
        "The rule broken, in one line — shown to the member on the formal record and in their DM",
      ),
      evidence_message_url: Object.freeze({
        type: "string",
        description:
          "Permalink to the message the warning is about (defaults to the referred message)",
      }),
    }),
  }),
  delete_message: Object.freeze({
    description:
      "Delete ONE specific message. channel_id/message_id default to the " +
      "referred message when omitted. This removes specific messages only — " +
      "there is no bulk purge.",
    extra: Object.freeze({
      channel_id: Object.freeze({
        type: "string",
        description: "Channel holding the message (defaults to the referred message's channel)",
      }),
      message_id: Object.freeze({
        type: "string",
        description: "Message id to delete (defaults to the referred message)",
      }),
      reason: reasonProp("Why the message breaks the rules"),
    }),
  }),
  ticket: Object.freeze({
    description:
      "Open a help ticket WITH the subject in it — to discuss what happened " +
      "or explain the rules. Ticket text is member-visible: never put " +
      "staff-note bodies or staff-only history in `reason`.",
    extra: Object.freeze({
      reason: reasonProp("What the ticket should discuss (member-visible wording)"),
    }),
  }),
  timeout: Object.freeze({
    description:
      "Time the user out. duration_seconds is the requested length; the " +
      "guild's timeout cap and the 60-second floor are applied by the " +
      "executor and the row records the duration ACTUALLY used.",
    extra: Object.freeze({
      duration_seconds: Object.freeze({
        type: "number",
        description: "Requested timeout length in whole seconds (e.g. 300 for five minutes)",
      }),
      reason: reasonProp("The rule broken, in one line"),
    }),
    required: Object.freeze(["user_id", "duration_seconds"]),
  }),
  kick: Object.freeze({
    description:
      "Kick the user from this server. Serious, considered escalation — " +
      "their history belongs in a staff note alongside it.",
    extra: Object.freeze({
      reason: reasonProp("Why the user is being removed from the server"),
    }),
  }),
  ban: Object.freeze({
    description:
      "Ban the user from this server. The most serious sanction; never " +
      "used to bulk-delete history (the delete tool removes specifics).",
    extra: Object.freeze({
      reason: reasonProp("Why the user is being banned"),
    }),
  }),
});

/**
 * Action tool schemas for a run: EVERY `off` action omitted (locked
 * decision 2 — off is not offered to the model at all).
 *
 * @param {Record<string,string>} modes per-action modes ({ warn: "suggest", … })
 * @returns {object[]} tool definitions
 */
function buildActionSchemas(modes = {}) {
  const offered = [];
  for (const action of AUTOMOD_ACTIONS) {
    const mode = String(modes?.[action] ?? "suggest").trim().toLowerCase();
    if (mode === "off") continue;
    const spec = ACTION_TOOL_SPECS[action];
    offered.push(
      toolDef(
        action,
        spec.description,
        Object.freeze({ user_id: userIdProp(`${action} action`), ...spec.extra }),
        spec.required ?? ["user_id"],
      ),
    );
  }
  return offered;
}

/** The always-present tools: staff note + both reads (no mode flag). */
const ALWAYS_ON_SCHEMAS = Object.freeze([
  toolDef(
    TOOL_NAMES.staffNote,
    "Write the staff note — the human record of your consideration of one " +
      "user in this case. ALWAYS available. Write one for every user you " +
      "select an action for (`no_action` included) — any order: the note is " +
      "reconciled at commit against your recorded actions. A note for a user " +
      "you never selected is DROPPED at commit (bystanders get no note), and " +
      "a subject with no note gets one written from the structured decision. " +
      "One note per user per case.",
    Object.freeze({
      user_id: userIdProp("consideration record"),
      content: Object.freeze({
        type: "string",
        description:
          "What you weighed and why — the readable human record staff will " +
          `trust later (max ${MAX_NOTE_CONTENT} characters).`,
      }),
    }),
    ["user_id", "content"],
  ),
  toolDef(
    TOOL_NAMES.readWarnings,
    "Read a user's warning history in THIS server — active and expired " +
      "(voided history is disclosed as a count). Use it for a user you are " +
      "actually considering; the referred subject's records are already in " +
      "the bundle.",
    Object.freeze({ user_id: userIdProp("warning lookup") }),
  ),
  toolDef(
    TOOL_NAMES.readStaffNotes,
    "Read a user's live staff notes in THIS server. Use it for a user you " +
      "are actually considering; the referred subject's notes are already " +
      "in the bundle.",
    Object.freeze({ user_id: userIdProp("staff-note lookup") }),
  ),
]);

/**
 * The full toolset for one run: mode-gated action tools + the always-on
 * trio. (Staff notes have no mode and the reads are never gated — locked
 * decisions 4/5; #727's lookups are ungated by design.)
 *
 * @param {Record<string,string>} modes
 * @returns {object[]}
 */
function buildToolset(modes = {}) {
  return [...buildActionSchemas(modes), ...ALWAYS_ON_SCHEMAS];
}

/* ───────────────────────────── dispatch ─────────────────────────────────── */

/** Trim-to-null (the automod family idiom). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Cap a string fed back to the model / persisted in the log. */
function cap(text, max) {
  const s = text == null ? "" : String(text);
  return s.length <= max ? s : `${sliceSafe(s, max)}…[truncated]`;
}

/** One decision-log entry (short, structured — NOT transcript material). */
function logEntry(seq, toolName, args, state, note) {
  const user = optionalText(args?.user_id);
  const duration = Number.isFinite(Number(args?.duration_seconds))
    ? ` dur=${Math.floor(Number(args.duration_seconds))}s`
    : "";
  const reason = optionalText(args?.reason ?? args?.rationale ?? args?.content);
  return {
    seq,
    tool: toolName,
    args_summary: cap(`${user ?? "?"}${duration}${reason ? ` "${sliceSafe(reason, 60)}"` : ""}`, SUMMARY_MAX),
    state,
    result_or_error: cap(note, SUMMARY_MAX),
  };
}

/**
 * Build the per-run dispatcher. Everything it returns is scoped to ONE case
 * run: the recorded intents, the considered-user set, the structured
 * decision log, and `executeTool` for the provider tool loop.
 *
 * @param {object} opts
 * @param {number} opts.communityId
 * @param {string} opts.guildId
 * @param {object} opts.caseRow                  the automod_cases row (anchor ids, referrer)
 * @param {Record<string,string>} opts.modes     per-action modes (settings read)
 * @param {string|null} [opts.subjectUserId]     the preloaded judgment subject (context)
 * @param {object} [opts.deps]
 * @param {object} [opts.deps.lookupDeps]        seam for the lookups' getMember
 * @param {(entry: object) => void} [opts.deps.onToolResult] observation hook (harness log)
 * @returns {{
 *   tools: object[],
 *   executeTool: (name: string, args: object) => Promise<string>,
 *   actionIntents: object[], noteIntents: object[],
 *   consideredUserIds: string[], toolNames: string[], decisionLog: object[],
 * }}
 */
function createToolDispatcher({ communityId, guildId, caseRow, modes = {}, subjectUserId = null, deps = {} } = {}) {
  const actionIntents = []; // { action, subjectUserId, params } — commit order
  const noteIntents = []; // { userId, content } — commit order after actions
  const considered = new Set();
  const actionSlots = new Set(); // "action|user" — one call per pair per run
  const notedUsers = new Set();
  const toolNames = [];
  const decisionLog = [];
  let seq = 0;

  const rememberTool = (name) => {
    if (!toolNames.includes(name)) toolNames.push(name);
  };
  const log = (name, args, state, note) => {
    if (decisionLog.length >= AUTOMOD_DECISION_LOG_MAX_ENTRIES) {
      if (decisionLog[decisionLog.length - 1]?.tool !== "_log_truncated") {
        decisionLog.push({
          seq: seq + 1,
          tool: "_log_truncated",
          args_summary: "",
          state: "capped",
          result_or_error: `decision log capped at ${AUTOMOD_DECISION_LOG_MAX_ENTRIES} entries`,
        });
      }
      return;
    }
    seq += 1;
    decisionLog.push(logEntry(seq, name, args, state, note));
  };

  const availableNames = () => buildToolset(modes).map((t) => t.function.name);

  /** The ONE failure exit: specific, logged-free (the run logs), never throws. */
  const refuse = (name, args, message) => {
    log(name, args, "refused", message);
    return message;
  };

  async function executeTool(rawName, rawArgs) {
    const name = String(rawName ?? "");
    let args = rawArgs;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    if (args == null || typeof args !== "object" || Array.isArray(args)) args = {};
    try {
      return await dispatch(name, args);
    } catch (err) {
      // Belt: every known path returns a string above; a bug must still feed
      // the model a cause instead of breaking the loop (decision-47 posture).
      const message = `Tool \`${name}\` hit an internal error: ${err?.message || err}`;
      log(name, args, "refused", message);
      return message;
    }
  }

  async function dispatch(name, args) {
    rememberTool(name);

    // ── READ tools: execute immediately (never gated, guild-isolated) ─────
    if (name === TOOL_NAMES.readWarnings || name === TOOL_NAMES.readStaffNotes) {
      const userId = optionalText(args.user_id);
      if (!userId) {
        return refuse(name, args, `The \`${name}\` tool needs a user_id — an explicit member id from the referral or the message window.`);
      }
      const service = name === TOOL_NAMES.readWarnings ? readWarningsForLookup : readStaffNotesForLookup;
      const result = await service({
        communityId,
        guildId,
        userId,
        actorUserId: caseRow?.referrer_user_id ?? null,
        deps: deps.lookupDeps ?? {},
      });
      if (!result.ok) {
        log(name, args, "read_error", result.error);
        return cap(JSON.stringify(result), AUTOMOD_TOOL_RESULT_MAX_CHARS);
      }
      log(name, args, "read_ok", `count=${result.count}`);
      return cap(JSON.stringify(result), AUTOMOD_TOOL_RESULT_MAX_CHARS);
    }

    // ── STAFF NOTE tool: always present; QUEUED for commit reconciliation ─
    // #731 law: call order does not matter — the note lands only if the user
    // has recorded action intent by COMMIT (the reconciler in harness.js owns
    // writing, dropping, and harness-filling). Call time keeps the mechanical
    // checks: params, the cap, and one note per user per case.
    if (name === TOOL_NAMES.staffNote) {
      const userId = optionalText(args.user_id);
      if (!userId) {
        return refuse(name, args, `The \`${TOOL_NAMES.staffNote}\` tool needs a user_id — the user you considered.`);
      }
      const content = optionalText(args.content);
      if (!content) {
        return refuse(name, args, `The \`${TOOL_NAMES.staffNote}\` tool needs non-empty \`content\` — what you weighed and why.`);
      }
      if (content.length > MAX_NOTE_CONTENT) {
        return refuse(name, args, `Staff note content is ${content.length} characters — the cap is ${MAX_NOTE_CONTENT}. Shorten it.`);
      }
      if (notedUsers.has(userId)) {
        return refuse(name, args, `write_staff_note refused for <@${userId}>: one staff note per user per case — a note for them is already recorded this run.`);
      }
      notedUsers.add(userId);
      noteIntents.push({ userId, content });
      const message =
        `Staff note queued for <@${userId}> for commit reconciliation. It is written only if you also record an action ` +
        "for that user (`no_action` included) before the run commits — a note for a user you never selected is dropped, " +
        "and a selected user without a note gets one written from the structured decision.";
      log(name, args, "queued", message);
      return message;
    }

    // ── ACTION tools: record intent ONLY (nothing mutates during rounds) ─
    if (AUTOMOD_ACTIONS.includes(name)) {
      const userId = optionalText(args.user_id);
      if (!userId) {
        return refuse(name, args, `The \`${name}\` tool needs a user_id — automod never acts against an anonymous subject.`);
      }
      const mode = String(modes?.[name] ?? "suggest").trim().toLowerCase();
      if (mode === "off") {
        // Defense in depth: `off` is not offered (no schema), so a call here
        // means the model hallucinated — it cannot run (locked decision 2).
        return refuse(name, args, `The \`${name}\` action is off for this guild — it is not offered and cannot run this case.`);
      }
      const slot = `${name}|${userId}`;

      const params = {};
      // #732: no_action's reason is REQUIRED — it is stored on the action
      // row AND carried into the staff note (contract verbatim). Every other
      // action keeps reason optional. Param validation runs BEFORE the slot
      // check so a malformed call learns the param contract first (#728).
      const reason = optionalText(args.reason);
      if (name === "no_action") {
        if (!reason) {
          return refuse(
            name,
            args,
            "`no_action` needs `reason` — why no sanction is warranted for this user. It is recorded on the decision row and in the staff note. If they were merely a bystander, call NOTHING: no_action marks consideration and is not a bystander bin.",
          );
        }
        params.reason = reason;
      } else if (reason) {
        params.reason = reason;
      }
      if (name === "timeout") {
        const seconds = Number(args.duration_seconds);
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return refuse(
            name,
            args,
            "`timeout` needs `duration_seconds` — a positive number of seconds. The 60-second floor and the guild cap are applied by the executor; pass what you intend.",
          );
        }
        params.durationSeconds = Math.floor(seconds);
      }
      if (name === "delete_message") {
        const channelId = optionalText(args.channel_id) ?? optionalText(caseRow?.channel_id);
        const messageId = optionalText(args.message_id) ?? optionalText(caseRow?.message_id);
        if (!channelId || !messageId) {
          return refuse(
            name,
            args,
            "`delete_message` needs `channel_id` and `message_id` — this case has no referred message to default to, so pass both explicitly. Specific messages only (no purge).",
          );
        }
        params.channelId = channelId;
        params.messageId = messageId;
      }
      if (name === "warn") {
        // #733 evidence default: the case anchor's jump link, recorded ONCE
        // here so the auto run and a later Approve replay share the exact
        // evidence URL. An explicit model URL always wins; a case with no
        // anchor message carries no evidence (parity with the delete-tool
        // defaults above).
        const evidenceUrl =
          optionalText(args.evidence_message_url) ?? anchorJumpLink(guildId, caseRow);
        if (evidenceUrl) params.evidenceMessageUrl = evidenceUrl;
      }

      // Param validation ABOVE the slot check: a malformed call must learn
      // the param contract, not the (secondary) one-per-(action,user) rule.
      if (actionSlots.has(slot)) {
        return refuse(name, args, `**${name}** is already recorded for <@${userId}> in this case — one call per (action, user) per run.`);
      }
      actionSlots.add(slot);
      considered.add(userId);
      actionIntents.push({ action: name, subjectUserId: userId, params });
      const message =
        `Recorded: ${name} for <@${userId}> (mode: ${mode} — applied at commit).\n` +
        (mode === "suggest"
          ? "**Status:** awaiting staff approval"
          : "**Status:** the executor runs it at commit and the case post carries the result.");
      log(name, args, "recorded", `mode=${mode}`);
      return message;
    }

    return refuse(name, args, `Unknown tool "${name}" — available tools: ${availableNames().join(", ")}.`);
  }

  return {
    tools: buildToolset(modes),
    executeTool,
    actionIntents,
    noteIntents,
    consideredUserIds: () => [...considered],
    toolNames,
    decisionLog,
    // Exposed for the runner's completeness check + #731's reconciler hook:
    subjectUserId,
  };
}

module.exports = {
  TOOL_NAMES,
  ACTION_TOOL_SPECS,
  buildActionSchemas,
  ALWAYS_ON_SCHEMAS,
  buildToolset,
  createToolDispatcher,
};
