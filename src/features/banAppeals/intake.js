/**
 * Ban appeals — VALIDATION CORE (#773 §1 + locked decision 6).
 *
 * The intake battery every press and every modal submit must pass BEFORE
 * anything is filed. The validation core is pure decision logic: NO Discord
 * objects enter the validators, and every storage read is an injectable dep
 * (defaults resolve the db facade lazily at CALL time, banService posture —
 * requiring this module never opens SQLite). BELOW the validators lives the
 * FILING ORCHESTRATION (#773 subtask 04): `buildAppealModal` + the one submit
 * pipeline `handleAppealModalSubmit` — validate → `fileAppeal` → `ticket.js
 * openAppealTicket` → `filed→open` → confirmation DM → ban-DM button
 * edit-away. It returns DECISION OBJECTS for the guildless listener (subtask
 * 07 owns the InteractionCreate wiring); it never replies itself and never
 * rejects.
 *
 * Pending-truth law (#730, issue §2): a ticket failure leaves the appeal row
 * `filed` with NULL ticket — the honest pending state — the user gets the
 * SPECIFIC cause and is never told "filed", and the failure is logged loudly
 * with ids. There is deliberately NO automatic ticket retry in v1: the filed
 * row + the loud log are the pending surface (a boot/staff sweep is a
 * documented follow-up, not shipped copy).
 *
 * Decision-code enum (INTAKE_CODES — the single source later tasks match
 * on; values are stable strings, never re-spelled inline):
 *
 *   OK                the press/submit passed the whole battery — proceed
 *   NOT_YOU           presser/submitter is not the record's banned member
 *                     (stale or forged press) — or carried no identity
 *   NO_RECORD         no ban record behind the id: gone, or the ban was
 *                     never tracked by #772 (honeypot/external = no record =
 *                     no appeal path, issue "Known gaps"), or the id is a
 *                     cross-community forgery (answered as if gone — a
 *                     forged probe never learns the other row exists)
 *   NOT_ACTIVE        record exists but the ban is no longer `active`
 *   APPEALS_OFF       the guild's `ban_appeals` toggle is off
 *   ALREADY_FILED     one appeal per ban cycle — result.appeal carries the
 *                     LIVE row (status keys the copy: filed/open/granted/
 *                     denied/closed)
 *   DB_ERROR          a storage read threw — result.error carries the
 *                     specific cause (AGENTS.md rule 3), never a generic
 *   MISSING_STATEMENT modal submit without the required statement
 *   STATEMENT_TOO_LONG statement over MAX_APPEAL_STATEMENT (modal clamps
 *                     first; this is the belt)
 *
 * There is deliberately NO untracked-guild code: the record itself carries
 * `community_id`, so a GUILDESS presser (banned users cannot resolve a
 * guild context) resolves everything through the record — a ban with no
 * record has no appeal lane at all and reads as NO_RECORD.
 *
 * Every failure result carries `error`: the SPECIFIC ephemeral refusal copy
 * (constants.js builders — never generic, always "Nothing was filed.").
 * The CALLER logs it as `[appeals] <what> refused: code=… record=… user=…`
 * with the guild/user/record ids and replies it ephemerally with
 * allowedMentions {parse: []} — the validator performs neither.
 */

// Modal chrome for the statement form (banModal.js posture; discord.js is
// load-safe — nothing SQLite enters the require graph at load).
const {
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
// core/theme is load-safe (discord.js + core/text only).
const { tsFull } = require("../../core/theme");
const {
  LOG_PREFIX, // re-exported so the caller's log lines share one grep
  APPEAL_MODAL_TITLE,
  MODAL_APPEAL_PREFIX,
  MODAL_FIELD_STATEMENT,
  MODAL_LABEL_STATEMENT,
  parseModalAppealRecordId,
  refusalNotYou,
  refusalNoRecord,
  refusalNotActive,
  refusalAppealsOff,
  refusalAlreadyFiled,
  refusalMissingStatement,
  refusalStatementTooLong,
  refusalValidationFailed,
} = require("./constants");

/* ── decision codes (assigned consts — the colon-literal object form trips
 * the env-parity SCREAMING-literal scan; banAppeals.js fileAppeal pins the
 * same law) ─────────────────────────────────────────────────────────────── */

const CODE_OK = "OK";
const CODE_NOT_YOU = "NOT_YOU";
const CODE_NO_RECORD = "NO_RECORD";
const CODE_NOT_ACTIVE = "NOT_ACTIVE";
const CODE_APPEALS_OFF = "APPEALS_OFF";
const CODE_ALREADY_FILED = "ALREADY_FILED";
const CODE_DB_ERROR = "DB_ERROR";
const CODE_MISSING_STATEMENT = "MISSING_STATEMENT";
const CODE_STATEMENT_TOO_LONG = "STATEMENT_TOO_LONG";

/** The enum every caller matches against (frozen — never mutate at runtime). */
const INTAKE_CODES = Object.freeze({
  OK: CODE_OK,
  NOT_YOU: CODE_NOT_YOU,
  NO_RECORD: CODE_NO_RECORD,
  NOT_ACTIVE: CODE_NOT_ACTIVE,
  APPEALS_OFF: CODE_APPEALS_OFF,
  ALREADY_FILED: CODE_ALREADY_FILED,
  DB_ERROR: CODE_DB_ERROR,
  MISSING_STATEMENT: CODE_MISSING_STATEMENT,
  STATEMENT_TOO_LONG: CODE_STATEMENT_TOO_LONG,
});

/* ── dependency seams ─────────────────────────────────────────────────────── */

/**
 * Lazy db access (call time, never require time — #699 load-cycle law,
 * banService exemplar). A non-integer community id stays a programmer error
 * INSIDE the repositories; the validator only ever feeds them the record's
 * own stored community_id.
 */
const dbApi = () => require("../../db");

/**
 * Normalize the caller's deps. Defaults are the shipped reads; tests inject
 * plain doubles and unit-run the whole battery with zero SQLite.
 *
 * @param {object} [deps]
 * @param {(id: number) => object|null} [deps.getBanRecord]
 * @param {(communityId: number, banRecordId: number) => object|null} [deps.getAppealByBanRecord]
 * @param {(communityId: number) => { ok: boolean, enabled?: boolean, error?: string }} [deps.appealsGate]
 * @param {number} [deps.maxStatementLength]
 * @param {() => number} [deps.now]
 */
function resolveDeps(deps = {}) {
  return {
    getBanRecord:
      deps.getBanRecord || ((id) => dbApi().getBanRecord(id)),
    getAppealByBanRecord:
      deps.getAppealByBanRecord ||
      ((communityId, banRecordId) =>
        dbApi().getAppealByBanRecord(communityId, banRecordId)),
    // The toggle read rides the settings seam (single source for the
    // default-ON posture: Number(ban_appeals ?? 1) !== 0).
    appealsGate:
      deps.appealsGate ||
      ((communityId) => {
        const read = require("./settings").readSettings(communityId);
        if (!read.ok) return { ok: false, error: read.error };
        return { ok: true, enabled: read.settings.appealsEnabled };
      }),
    // LEFT NULL on purpose: the cap lives in the repository (single truth);
    // resolve it at USE time, so a fully-injected test never touches the
    // db facade — resolveDeps itself must stay SQLite-free.
    maxStatementLength:
      deps.maxStatementLength != null ? Number(deps.maxStatementLength) : null,
    now: deps.now || (() => Date.now()),
  };
}

/** Statement cap: the repository's truth, read only when actually needed. */
function statementCap(d) {
  return d.maxStatementLength != null
    ? d.maxStatementLength
    : dbApi().MAX_APPEAL_STATEMENT;
}

/* ── shape helpers (pure) ─────────────────────────────────────────────────── */

/**
 * Positive-integer coercion for a parsed customId payload; else null.
 * isSafeInteger, not isInteger: a forged 1e24-id would pass the shape as a
 * JS float and die at the SQLite bind — garbage belongs at the shape gate
 * (NO_RECORD), not inside a read.
 */
function positiveIntOrNull(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Failure result builder (refusal copy is the user-facing `error`). */
function fail(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

/** Storage-failure result: specific cause quoted, never a generic. */
function dbFail(what, err, extra = {}) {
  return fail(
    CODE_DB_ERROR,
    refusalValidationFailed(what, String(err?.message || err || "read failed")),
    extra,
  );
}

/* ── the press battery ────────────────────────────────────────────────────── */

/**
 * Validate an `appeal:<recordId>` BUTTON PRESS before the statement modal
 * opens. Battery order (each failure short-circuits with its own specific
 * refusal — locked decision 6: stale/forged presses get named, logged
 * refusals, never a generic drop):
 *
 *   id shape → record exists (+ community consistency) → presser identity →
 *   ban still active → guild toggle ON → no appeal filed for the cycle yet
 *
 * The OK result hands the caller everything filing needs: the live record,
 * the record's community (guildless pressers resolve community ONLY through
 * the row) and the parsed id.
 *
 * @param {object} input
 * @param {number|string} input.banRecordId parsed digits-only record id
 *        (constants.js parseAppealPressRecordId already stripped the customId)
 * @param {string|null} [input.pressingUserId] the guildless interaction's user id
 * @param {number|string|null} [input.communityId] OPTIONAL caller-side claim;
 *        present and different from the record's community reads as NO_RECORD
 * @param {object} [input.deps] test seams (see resolveDeps)
 * @returns {{ ok: true, code: "OK", communityId: number, banRecordId: number, record: object }
 *          | { ok: false, code: string, error: string, record?: object, appeal?: object }}
 */
function validateAppealPress(input = {}) {
  const d = resolveDeps(input.deps);
  const banRecordId = positiveIntOrNull(input.banRecordId);
  const pressingUserId = String(input.pressingUserId ?? "").trim();

  // A garbage id and a stripped record are the same honest answer: there is
  // no tracked ban behind this link. A press with no identity is never OK.
  if (banRecordId == null) return fail(CODE_NO_RECORD, refusalNoRecord());
  if (pressingUserId === "") return fail(CODE_NOT_YOU, refusalNotYou());

  let record = null;
  try {
    record = d.getBanRecord(banRecordId) || null;
  } catch (err) {
    return dbFail("ban record lookup", err, { banRecordId });
  }
  if (!record) return fail(CODE_NO_RECORD, refusalNoRecord());

  const recordCommunity = Number(record.community_id);
  if (
    input.communityId != null &&
    Number(input.communityId) !== recordCommunity
  ) {
    // Cross-community forged id: answered as if the record were GONE — a
    // probe learns nothing beyond "this link is dead here".
    return fail(CODE_NO_RECORD, refusalNoRecord());
  }

  // Presser identity is the record's, not the interaction's (the ban DM
  // went to this user; anyone else's press is stale or forged).
  if (String(record.user_id ?? "") !== pressingUserId) {
    return fail(CODE_NOT_YOU, refusalNotYou(), {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }

  // Only an ACTIVE ban is appealable (lifted/expired/decided cycles closed
  // their window — the status machine's word is the row's, not ours).
  if (record.status !== "active") {
    return fail(CODE_NOT_ACTIVE, refusalNotActive(), {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }

  // Per-guild intake gate (default ON — migration 075 + settings seam).
  let gate = null;
  try {
    gate = d.appealsGate(recordCommunity);
  } catch (err) {
    return dbFail("appeals setting read", err, {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }
  if (!gate || gate.ok !== true) {
    return dbFail(
      "appeals setting read",
      gate?.error || "no result from the appeals gate",
      { record, communityId: recordCommunity, banRecordId },
    );
  }
  if (!gate.enabled) {
    return fail(CODE_APPEALS_OFF, refusalAppealsOff(), {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }

  // One appeal per ban cycle — read BEFORE filing so the refusal names the
  // live appeal's status (the 075 UNIQUE stays the race-proof belt when two
  // presses sail past this check together).
  let existing = null;
  try {
    existing = d.getAppealByBanRecord(recordCommunity, banRecordId) || null;
  } catch (err) {
    return dbFail("existing appeal lookup", err, {
      record,
      communityId: recordCommunity,
      banRecordId,
    });
  }
  if (existing) {
    return fail(CODE_ALREADY_FILED, refusalAlreadyFiled(existing.status), {
      record,
      appeal: existing,
      communityId: recordCommunity,
      banRecordId,
    });
  }

  return { ok: true, code: CODE_OK, communityId: recordCommunity, banRecordId, record };
}

/* ── the modal-submit battery ─────────────────────────────────────────────── */

/**
 * Validate an `appeal:s:<recordId>` MODAL SUBMIT. Runs the FULL press
 * battery again first — settings can flip, and another press can file the
 * cycle's single appeal, between press and submit; the durable-id modal has
 * no token store to age out, so the DATABASE is the one-shot (uniqueness
 * enforced by the 075 UNIQUE, honesty enforced here). Statement rules then
 * apply: presence is required (verbatim into the ticket header, issue §1),
 * the cap is MAX_APPEAL_STATEMENT (the modal clamps first; this is the
 * belt).
 *
 * @param {object} input validateAppealPress input + `statement` (raw modal text)
 * @returns {{ ok: true, code: "OK", communityId: number, banRecordId: number, record: object, statement: string, nowMs: number }
 *          | { ok: false, code: string, error: string, record?: object, appeal?: object }}
 */
function validateModalSubmission(input = {}) {
  const press = validateAppealPress(input);
  if (!press.ok) return press;

  const d = resolveDeps(input.deps);
  const statement = String(input.statement ?? "").trim();
  if (statement === "") {
    return fail(CODE_MISSING_STATEMENT, refusalMissingStatement(), {
      record: press.record,
      communityId: press.communityId,
      banRecordId: press.banRecordId,
    });
  }
  const maxStatement = statementCap(d);
  if (statement.length > maxStatement) {
    return fail(
      CODE_STATEMENT_TOO_LONG,
      refusalStatementTooLong(maxStatement),
      {
        record: press.record,
        communityId: press.communityId,
        banRecordId: press.banRecordId,
      },
    );
  }

  return { ...press, statement, nowMs: d.now() };
}

/* ══ FILING ORCHESTRATION (#773 subtask 04 — §1 §2 §3 up-front notice) ══════
 * One pipeline behind the `appeal:s:<banRecordId>` modal submit (durable-id
 * based — NO token store; the 075 UNIQUE is the one-shot belt):
 *
 *   validate (full press battery AGAIN + statement rules)
 *     → fileAppeal (status 'filed' — the pending truth)
 *     → ticket.js openAppealTicket (staff-only channel + header + buttons)
 *     → attach channel + filed→open (CAS inside openAppealTicket)
 *     → §5 audit row → confirmation DM (§3 up-front notice)
 *     → ban-DM button edit-away to `**Appeal:** filed <timestamp>`
 *
 * Every terminal is a DECISION OBJECT ({ ok, code, error?, ids… }) for the
 * guildless listener (07): this module NEVER replies to Discord. Post-filing
 * outbound steps (audit / DM / edit-away) are individually guarded — a
 * confirmation DM or ban-DM edit failure is logged with ids and changes
 * NOTHING that already succeeded (K2 DM law: logged, never echoed).
 */

/* ── filing decision codes (ASSIGNED consts — env-parity scanner law; the
 * validator codes above cover everything BEFORE filing) ──────────────────── */

const CODE_FILED = "FILED";
const CODE_FILE_FAILED = "FILE_FAILED";
const CODE_TICKET_FAILED = "TICKET_FAILED";
const CODE_INTERNAL = "INTERNAL";

/** The enum every filing caller matches against (frozen). */
const FILING_CODES = Object.freeze({
  FILED: CODE_FILED,
  FILE_FAILED: CODE_FILE_FAILED,
  TICKET_FAILED: CODE_TICKET_FAILED,
  INTERNAL: CODE_INTERNAL,
});

/** admin_audit action vocabulary entry for a filing (issue §5). */
const AUDIT_ACTION_FILE = "banAppeals.file";

/* ── user-facing copy (exact strings docs + 05/06/07 consume) ───────────────
 * `**Label:** value` law (#471 H2-13); no mentions are ever sent, so every
 * payload carries allowedMentions { parse: [] } (dmCopy DM law). */

/**
 * The filing confirmation DM (issue §3 "Up-front notice": it MUST state the
 * text/images/video rule and the no-reactions rule; the pause mention keeps
 * the user honest about silence).
 *
 * @returns {{ content: string, allowedMentions: { parse: string[] } }}
 */
function buildFilingConfirmationDm() {
  return {
    content: [
      "**Appeal:** filed — staff have your statement and can reply to you here.",
      "**Shared:** only text, images, and video are relayed to staff — " +
        "reactions, embeds, audio, stickers, polls, and forwarded messages " +
        "are never shared; anything un-sharable gets you a specific notice here.",
      "**Replies:** staff may pause the relay while they discuss your case, " +
        "so answers can take a while.",
      "**One per ban:** this ban gets exactly one appeal — staff decisions " +
        "are final for this ban.",
    ].join("\n"),
    allowedMentions: { parse: [] },
  };
}

/**
 * The ban-DM replacement line after a successful filing (issue §1: the
 * button is edited away and replaced by `**Appeal:** filed <timestamp>`).
 * @param {number} filedAtMs ms epoch (the stored appeal's created_at)
 */
function buildFiledBanDmLine(filedAtMs) {
  return `**Appeal:** filed ${tsFull(filedAtMs)}`;
}

/**
 * Amended ban-DM content: the original copy kept (the user's record of the
 * ban), the button line appended below it. Empty/garbage original degrades
 * to the filed line alone — the edit never throws on shape.
 *
 * @param {unknown} originalContent the ban DM's current content
 * @param {number} filedAtMs ms epoch
 * @returns {string}
 */
function buildAppealDmEditContent(originalContent, filedAtMs) {
  const base = String(originalContent ?? "").trim();
  const line = buildFiledBanDmLine(filedAtMs);
  return base === "" ? line : `${base}\n\n${line}`;
}

/**
 * Ticket-failure user copy (#730/§2: the SPECIFIC cause, the honest pending
 * state — never "filed", never a ticket claim).
 * @param {string} cause the specific failure sentence from ticket.js
 */
function refusalTicketFailed(cause) {
  return (
    "**Appeal:** your statement was saved, but the private staff review " +
    `channel could not be opened (${String(cause ?? "unknown failure")}). ` +
    "Staff can still see the pending appeal on their side — if you don't " +
    "hear back, reach out to a staff member another way. The ban itself is " +
    "unchanged."
  );
}

/* ── the modal builder ────────────────────────────────────────────────────── */

/** Tolerant text-input reader (banModal/report idiom): missing/odd → "". */
function readModalText(interaction, fieldId) {
  try {
    return String(
      interaction?.fields?.getTextInputValue?.(fieldId) ?? "",
    ).trim();
  } catch {
    return "";
  }
}

/**
 * The statement modal (`appeal:s:<banRecordId>` — durable-id based, NO token
 * store; the 075 UNIQUE(ban_record_id) is the durable one-shot). Paragraph,
 * REQUIRED, capped at MAX_APPEAL_STATEMENT (the repository's truth; the
 * modal clamps first, `validateModalSubmission` belts).
 *
 * @param {number|string} recordId the ban record id riding in the customId
 * @param {object} [opts]
 * @param {number} [opts.maxChars] cap override (tests)
 * @returns {ModalBuilder}
 */
function buildAppealModal(recordId, opts = {}) {
  // Lazy: the cap mirrors the repository's MAX_APPEAL_STATEMENT and the db
  // facade opens SQLite at require time (#699 law — banModal exemplar).
  const maxChars =
    opts?.maxChars != null
      ? Number(opts.maxChars)
      : require("../../db").MAX_APPEAL_STATEMENT;
  const statement = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_STATEMENT)
    .setLabel(`${MODAL_LABEL_STATEMENT} — required`)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(maxChars)
    .setPlaceholder(
      "What should staff consider? Your statement reaches them verbatim.",
    );
  return new ModalBuilder()
    .setCustomId(`${MODAL_APPEAL_PREFIX}${recordId}`)
    .setTitle(APPEAL_MODAL_TITLE)
    .addComponents(new ActionRowBuilder().addComponents(statement));
}

/* ── the one submit pipeline (listener: 07 wires InteractionCreate) ───────── */

/** Fail-safe §5 audit row for a landed filing (auditTrail is fail-safe by
 * contract — the try/catch is the belt, a broken audit write must never turn
 * a delivered appeal into a reported failure). */
function auditFiling({
  communityId,
  actorUserId,
  appealId,
  banRecordId,
  status,
  ticketChannelId,
}) {
  try {
    // Lazy: core/auditTrail requires the db facade at load (#699 law).
    const { recordSlashAudit } = require("../../core/auditTrail");
    recordSlashAudit({
      communityId,
      actorUserId,
      action: AUDIT_ACTION_FILE,
      targetType: "ban_appeal",
      targetId: String(appealId),
      details: {
        ban_record_id: banRecordId,
        status,
        ticket_channel_id: ticketChannelId ?? null,
      },
    });
  } catch (err) {
    console.error(
      `${LOG_PREFIX} appeal filing audit failed community=${communityId} appeal=${appealId}:`,
      err?.message || err,
    );
  }
}

/**
 * File the appeal behind an `appeal:s:<banRecordId>` MODAL SUBMIT. Inputs
 * arrive as plain data (the listener already routed the guildless
 * interaction); everything Discord-facing rides injectable seams.
 *
 * Decision outcomes (all `{ ...ids }`-carrying; the CALLER logs
 * `[appeals] …` with them and owns the ephemeral reply — this module never
 * replies):
 *  - validator codes (NOT_YOU/NO_RECORD/…) — the battery result, passed
 *    through untouched;
 *  - FILED — appeal open, confirmation DM + ban-DM edit attempted (their
 *    per-step results ride on the decision: dmDelivered/dmError/banDmEdited/
 *    banDmEditError — logged here, never fatal);
 *  - ALREADY_FILED — includes the UNIQUE-race re-read (copy keys the live
 *    status);
 *  - FILE_FAILED — the repository's specific sentence, nothing stored;
 *  - TICKET_FAILED — the appeal row STAYS `filed` with NULL ticket (the
 *    pending truth; never claimed filed), error names the specific cause;
 *  - INTERNAL / DB_ERROR — unexpected throw before filing.
 *
 * @param {object} params
 * @param {object} [params.interaction] the modal submit (user/message/customId source)
 * @param {number|string} [params.banRecordId] parsed record id (defaults to parsing the customId)
 * @param {string} [params.pressingUserId] submitter id override (tests / listener shape)
 * @param {string} [params.statement] statement override (else read from the modal fields)
 * @param {object} [params.client] Discord client (supervisor.discord at the edge; DM sender + ticket guilds)
 * @param {object} [params.deps] seams: getBanRecord, getAppealByBanRecord, appealsGate,
 *   maxStatementLength, now, fileAppeal, openAppealTicket, guild, sendDm, editBanDm,
 *   banDmMessage (explicit ban-DM message reference, overriding interaction.message),
 *   ticketDeps (seams forwarded INTO ticket.js openAppealTicket: openTicketChannel,
 *   attachAppealTicketChannel, openAppeal, listWarnings, listStaffNotes, fetchUser)
 * @returns {Promise<object>} decision object (never rejects)
 */
async function handleAppealModalSubmit(params = {}) {
  const deps = params.deps || {};
  // Hoisted so the outer catch can tell "before filing" (Nothing was filed.)
  // from "after filing" (pending-truth copy) honestly.
  let filed = null;
  let record = null;
  let communityId = null;
  let banRecordId = null;
  const ids = () =>
    `community=${communityId ?? "?"} record=${banRecordId ?? "?"}` +
    ` user=${record?.user_id ?? "?"} appeal=${filed?.id ?? "?"}`;

  try {
    const interaction = params.interaction ?? null;
    const submitterId =
      params.pressingUserId ?? interaction?.user?.id ?? null;
    const recordIdRaw =
      params.banRecordId ??
      parseModalAppealRecordId(interaction?.customId ?? "");
    const statement =
      params.statement ?? readModalText(interaction, MODAL_FIELD_STATEMENT);
    const client =
      params.client ?? deps.client ?? interaction?.client ?? null;

    // ── 1. the FULL battery AGAIN (settings can have flipped, a parallel
    // press can have filed the cycle's single appeal between press and
    // submit) + statement rules ─────────────────────────────────────────────
    const validation = validateModalSubmission({
      banRecordId: recordIdRaw,
      pressingUserId: submitterId,
      communityId: params.communityId ?? null,
      statement,
      deps,
    });
    if (!validation.ok) return validation; // validator's specific refusal

    communityId = validation.communityId;
    banRecordId = validation.banRecordId;
    record = validation.record;

    // ── 2. file (status 'filed' — pending truth until a ticket exists) ─────
    const fileFn = deps.fileAppeal || ((p) => dbApi().fileAppeal(p));
    const fileRes = await fileFn({
      communityId,
      banRecordId,
      appealStatement: validation.statement,
      createdAt: validation.nowMs,
    });
    if (!fileRes || fileRes.ok !== true) {
      if (fileRes?.code === "APPEAL_EXISTS") {
        // UNIQUE belt caught a race past the validator read — answer with
        // the LIVE row so the refusal names the real status (§1).
        let existing = null;
        try {
          const readFn =
            deps.getAppealByBanRecord ||
            ((c, r) => dbApi().getAppealByBanRecord(c, r));
          existing = readFn(communityId, banRecordId) || null;
        } catch (err) {
          console.error(
            `${LOG_PREFIX} appeal race re-read failed ${ids()}:`,
            err?.message || err,
          );
        }
        return fail(CODE_ALREADY_FILED, refusalAlreadyFiled(existing?.status), {
          record,
          appeal: existing,
          communityId,
          banRecordId,
        });
      }
      console.error(
        `${LOG_PREFIX} appeal filing failed ${ids()}:`,
        fileRes?.error || "fileAppeal returned no result",
      );
      return fail(
        CODE_FILE_FAILED,
        fileRes?.error || "Could not save the ban appeal — nothing was filed.",
        { record, communityId, banRecordId },
      );
    }
    filed = fileRes.appeal;

    // ── 3. the staff ticket (channel + header + buttons + filed→open) ──────
    const openTicketFn =
      deps.openAppealTicket ||
      ((p) => require("./ticket").openAppealTicket(p));
    const ticketRes = await openTicketFn({
      appeal: filed,
      banRecord: record,
      communityId,
      client,
      statement: validation.statement,
      guild: deps.guild,
      deps: deps.ticketDeps,
    });
    if (!ticketRes || ticketRes.ok !== true) {
      // #730 + issue §2: the appeal row stays `filed` with NULL ticket —
      // the pending truth — and the user learns the SPECIFIC cause. Logged
      // loudly here; ticket.js logged its own cause with the same ids.
      console.error(
        `${LOG_PREFIX} appeal filed but ticket FAILED ${ids()} — appeal ` +
          "stays pending (filed, no ticket):",
        ticketRes?.error || "openAppealTicket returned no result",
      );
      auditFiling({
        communityId,
        actorUserId: String(record.user_id ?? ""),
        appealId: filed.id,
        banRecordId,
        status: "filed",
        ticketChannelId: null,
      });
      return fail(
        CODE_TICKET_FAILED,
        refusalTicketFailed(
          ticketRes?.error || "the staff review channel could not be created",
        ),
        {
          record,
          appeal: filed,
          communityId,
          banRecordId,
          appealId: filed.id,
          ticketError: ticketRes?.error ?? null,
        },
      );
    }
    const liveAppeal = ticketRes.appeal ?? filed;

    // ── 4. §5 audit row (one per filing; reflects the TRUTHFUL state) ──────
    auditFiling({
      communityId,
      actorUserId: String(record.user_id ?? ""),
      appealId: filed.id,
      banRecordId,
      status: liveAppeal?.status ?? "open",
      ticketChannelId: ticketRes.channelOfRecordId ?? null,
    });

    // ── 5. confirmation DM — best-effort (K2: logged with ids, never
    // echoed to any channel; a failed notice never re-files or re-opens) ────
    let dm = {
      ok: false,
      error: "no Discord client — the confirmation DM had no sender",
    };
    if (deps.sendDm || client) {
      const sendFn =
        deps.sendDm ||
        ((userId, payload) =>
          require("../../platform/discord/outbound")
            .getDiscordOutbound(client)
            .sendDm(userId, payload));
      try {
        dm =
          (await sendFn(String(record.user_id), buildFilingConfirmationDm())) ||
          dm;
      } catch (err) {
        dm = { ok: false, error: err?.message || String(err) };
      }
    }
    if (!dm || dm.ok !== true) {
      console.error(
        `${LOG_PREFIX} filing confirmation DM failed ${ids()} channel=${
          ticketRes.channelOfRecordId ?? "?"
        }:`,
        dm?.error || "sendDm returned no result",
      );
    }

    // ── 6. ban-DM button edit-away (issue §1) — the interaction's own
    // message is the ban DM (button→modal→submit carries it); best-effort:
    // the DM channel being gone is EXPECTED for some users and never
    // un-files anything (filing success never depends on this edit). ────────
    const banDmMessage =
      deps.banDmMessage !== undefined
        ? deps.banDmMessage
        : interaction?.message ?? null;
    const filedAtMs =
      Number(filed.created_at) > 0 ? Number(filed.created_at) : validation.nowMs;
    let banDmEdited = false;
    let banDmEditError = null;
    if (banDmMessage && typeof banDmMessage.edit === "function") {
      try {
        const payload = {
          content: buildAppealDmEditContent(
            banDmMessage.content,
            filedAtMs,
          ),
          components: [],
          allowedMentions: { parse: [] },
        };
        if (deps.editBanDm) {
          await deps.editBanDm(banDmMessage, payload);
        } else {
          await banDmMessage.edit(payload);
        }
        banDmEdited = true;
      } catch (err) {
        banDmEditError = err?.message || String(err);
        console.error(
          `${LOG_PREFIX} ban-DM button edit-away failed ${ids()} (non-fatal):`,
          banDmEditError,
        );
      }
    } else {
      banDmEditError = "no ban-DM message reference carried by the submit";
      console.warn(
        `${LOG_PREFIX} ban-DM button edit-away skipped ${ids()}: ${banDmEditError}`,
      );
    }

    return {
      ok: true,
      code: CODE_FILED,
      communityId,
      banRecordId,
      appealId: filed.id,
      userId: String(record.user_id ?? ""),
      appeal: liveAppeal,
      ticket: ticketRes.ticket,
      channel: ticketRes.channel,
      ticketChannelId: ticketRes.channelOfRecordId ?? null,
      dmDelivered: dm?.ok === true,
      dmError: dm?.ok === true ? null : dm?.error ?? "send failed",
      banDmEdited,
      banDmEditError,
    };
  } catch (err) {
    // Rule 1/6: name the ids, answer with the CAUSE (rule 3). Post-filing
    // throws report the pending truth; pre-filing throws honestly say
    // nothing was filed.
    const cause = String(err?.message || err);
    console.error(
      `${LOG_PREFIX} appeal modal submit failed ${ids()}:`,
      err?.message || err,
    );
    if (filed) {
      return fail(CODE_TICKET_FAILED, refusalTicketFailed(cause), {
        record,
        appeal: filed,
        communityId,
        banRecordId,
        appealId: filed.id,
      });
    }
    return fail(
      CODE_INTERNAL,
      refusalValidationFailed("appeal filing", cause),
      { record, communityId, banRecordId },
    );
  }
}

module.exports = {
  LOG_PREFIX,
  INTAKE_CODES,
  FILING_CODES,
  AUDIT_ACTION_FILE,
  // individual codes (tests + callers may import any subset):
  CODE_OK,
  CODE_NOT_YOU,
  CODE_NO_RECORD,
  CODE_NOT_ACTIVE,
  CODE_APPEALS_OFF,
  CODE_ALREADY_FILED,
  CODE_DB_ERROR,
  CODE_MISSING_STATEMENT,
  CODE_STATEMENT_TOO_LONG,
  CODE_FILED,
  CODE_FILE_FAILED,
  CODE_TICKET_FAILED,
  CODE_INTERNAL,
  validateAppealPress,
  validateModalSubmission,
  // filing orchestration (listener subtask 07 wires these):
  buildAppealModal,
  handleAppealModalSubmit,
  // instruction-compat alias for the same pipeline:
  handleModalSubmission: handleAppealModalSubmit,
  // copy seams (docs + tests + subtasks 05/06/07 quote these exactly):
  buildFilingConfirmationDm,
  buildFiledBanDmLine,
  buildAppealDmEditContent,
  refusalTicketFailed,
  readModalText,
};
