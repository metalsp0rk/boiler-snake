/**
 * Auto-moderation action executor (#729, epic #723).
 *
 * ONE executor for every sanction: a suggest-mode Approve (#730's card) and
 * auto mode both call it — the gate is mode, never the code path (locked
 * decision 2). Discord-free by contract: this is a SERVICE (AGENTS.md rule
 * 6) — it never replies to Discord itself, every failure returns
 * { ok:false, error } with the specific cause, and every failure path logs
 * `[automod]` with community/guild/user/case ids (rule 2). Cards and command
 * handlers decide how to surface the outcome.
 *
 * Mode gate (locked decision 2):
 *  - `off`     — unrunnable. Refused even when called anyway; the case still
 *                gets its refused row (considered for #731).
 *  - `suggest` — recorded as a pending suggestion row; ZERO Discord calls.
 *                The card later calls approveSuggestion/dismissSuggestion,
 *                which claim that row and run THIS executor.
 *  - `auto`    — guards, then the mutation, then the recorded outcome.
 *
 * Subject guards (locked decision 6): warn / delete_message / ticket /
 * timeout / kick / ban REFUSE when the subject holds ANY `staff_roles` role
 * (same resolution requireStaff uses: memberHasStaffRole over staff_roles)
 * or when the bot's highest role is not above the subject's top role. A
 * refusal is { ok:false, error } with the specific reason AND a recorded
 * row — the user still counts as considered. `no_action` has no Discord
 * mutation, may name a staff member, and bypasses the guards entirely.
 * The staff-note write is NOT behind this gate (#731 owns it).
 *
 * Commit shape (epic #723 "Approve must claim the action row before calling
 * Discord — compare the atomic ticket-create slot"): every non-suggest run
 * first claims atomically — auto mode via `claimAutomodActionSlot` (the
 * INSERT itself is the winner), Approve via `claimAutomodSuggestion` (the
 * UPDATE ... WHERE state='suggested' single-winner). A re-entry or second
 * click gets the EXISTING row's outcome back with deduped:true and never
 * re-runs the mutation.
 *
 * Clamp: timeout duration lands in [60 s, min(guild automod_timeout_cap,
 * 28 days)] using the shipped constants; the recorded params and result
 * echo the duration ACTUALLY used and note the clamp (contract: "the card
 * shows the duration actually used when clamping changed it").
 *
 * Deps seam: every Discord touch is injectable (`deps`), with production
 * defaults wired to `deps.client` (a discord.js v14 Client). The `warn`
 * default calls the real `createWarning` service AND the guild's warn-DM
 * setting (#733 — see the warn handler's member-facing law). The `ticket`
 * default deliberately refuses with a specific #735 sentence — the ticket
 * tool ships in its own issue. The circuit breaker gate (#739) will add
 * its `isAutomodPaused` check inside runClaimedAction — one choke point,
 * both auto and approve already flow through it.
 *
 * THE WARN TOOL (#733, epic #723) — member-facing law lives HERE:
 *  - `params.reason` is the MEMBER-FACING reason: it is the formal record's
 *    reason and the ONLY prose the warning DM carries. The staff-note body,
 *    the model's rationale, note refs, and evidence NEVER enter the DM
 *    (locked contract: "Do not put the staff note body in the DM"); the DM
 *    is the standard framing `/warn add` ships, built by the shared
 *    `buildWarnDmPayload` (src/features/warnings/helpers.js).
 *  - The guild's `warn_dm_members` gate (warnDmEnabled) decides whether the
 *    DM goes, exactly like `/warn add` (no automod-specific setting); the
 *    send itself is the `deps.sendWarnDm` seam so tests record calls. A DM
 *    failure never rolls the warning back — the executed result line
 *    reports `warning recorded, member DM failed: <cause>` (rule 5).
 *  - `relatedNoteId` = the case's ONE staff note for that user (#731's
 *    row). The harness's two-phase commit (#733) injects it when the intent
 *    is recorded (so the suggestion row carries it and Approve replays
 *    it); a row without it resolves the note through `deps.resolveCaseNoteId`
 *    (production default: the shared card.js discovery law in
 *    ./caseNote.js — author = bot/'automod' + the `(automod case A-n)`
 *    suffix). Best-effort by contract: an unresolvable note NEVER costs the
 *    warning — the note itself is the record, the link is the convenience.
 *  - Expiry honours the guild's `warn_expiry_days` (guildDefaultDays —
 *    `params.expiresDays` overrides per row, same law as `/warn add`).
 */

const {
  getGuildSettings,
  listStaffRoles,
  createWarning,
  countActiveWarnings,
  getAutomodCaseById,
  now,
  insertAutomodActionSuggestion,
  claimAutomodActionSlot,
  recordAutomodActionRefusal,
  claimAutomodSuggestion,
  dismissAutomodSuggestion,
  recordAutomodActionResult,
  getAutomodAction,
  parseAutomodActionParams,
} = require("../../db");
// READ-ONLY imports of the shipped warnings feature (#733): the same member
// DM gate and the same standard DM framing `/warn add` uses — no parallel
// warning copy. (Deliberate cross-feature import named by the #733 contract;
// NOT the gork isolation case of locked decision 7.)
const { warnDmEnabled, buildWarnDmPayload } = require("../warnings/helpers");
const { findCaseNoteRow } = require("./caseNote");
const {
  AUTOMOD_ACTIONS,
  AUTOMOD_MODES,
  AUTOMOD_TIMEOUT_CAP_MIN,
  AUTOMOD_TIMEOUT_CAP_MAX,
  AUTOMOD_DEFAULT_TIMEOUT_CAP,
  automodModeColumn,
  normalizeAutomodMode,
} = require("./constants");

/** Actions with a Discord mutation (or formal write) behind them — the six
 * that run the staff/hierarchy guards. `no_action` deliberately absent. */
const MUTATING_ACTIONS = Object.freeze([
  "warn",
  "delete_message",
  "ticket",
  "timeout",
  "kick",
  "ban",
]);

// ── Logging (AGENTS.md rule 2: ids enough to reproduce from logs alone) ────

function idTag({ communityId, guildId, subjectUserId, caseId, action, actionRowId }) {
  return (
    `(community ${communityId ?? "?"} guild ${guildId ?? "?"} user ` +
    `${subjectUserId ?? "?"} case ${caseId ?? "?"} action ${action ?? "?"}` +
    `${actionRowId != null ? ` row ${actionRowId}` : ""})`
  );
}

function logFail(what, ids, err) {
  console.error(
    `[automod] executor ${what} failed ${idTag(ids)}:`,
    err?.message || err,
  );
}

// ── Pure gates (testable without Discord) ──────────────────────────────────

/**
 * Current per-action mode for a community, read through the shipped
 * accessors. A missing/garbage stored value falls back to `suggest` (the
 * epic default; the settings belt already normalizes writes).
 *
 * @param {number} communityId
 * @param {string} action validated action id
 * @returns {"off"|"suggest"|"auto"}
 */
function resolveActionMode(communityId, action) {
  const column = automodModeColumn(action); // validated action ⇒ safe column
  const stored = getGuildSettings(communityId)?.[column];
  return normalizeAutomodMode(stored) ?? "suggest";
}

/**
 * Clamp one timeout duration into [60 s, min(guild cap, 28 days)].
 * Non-numeric/missing input REFUSES (there is nothing to clamp); any finite
 * number clamps. Returns the EFFECTIVE seconds plus the requested one so
 * the row + card can show what actually ran.
 *
 * @param {{ requestedSeconds: unknown, guildCapSeconds: unknown }} opts
 * @returns {{ ok: true, durationSeconds: number, clampedFrom: number|null,
 *            floorSeconds: number, ceilingSeconds: number }
 *          | { ok: false, error: string }}
 */
function clampTimeoutDuration({ requestedSeconds, guildCapSeconds } = {}) {
  const requested = Number(requestedSeconds);
  if (requestedSeconds == null || String(requestedSeconds).trim() === "" ||
      !Number.isFinite(requested)) {
    return {
      ok: false,
      error:
        "The `timeout` action needs params.durationSeconds (a number of seconds) — nothing was run.",
    };
  }
  const cap = Number.isFinite(Number(guildCapSeconds)) && Number(guildCapSeconds) > 0
    ? Number(guildCapSeconds)
    : AUTOMOD_DEFAULT_TIMEOUT_CAP;
  const ceiling = Math.min(cap, AUTOMOD_TIMEOUT_CAP_MAX);
  const floor = AUTOMOD_TIMEOUT_CAP_MIN;
  const clamped = Math.min(ceiling, Math.max(floor, Math.floor(requested)));
  return {
    ok: true,
    durationSeconds: clamped,
    clampedFrom: clamped === Math.floor(requested) ? null : Math.floor(requested),
    floorSeconds: floor,
    ceilingSeconds: ceiling,
  };
}

/** Guild timeout cap (seconds) with the shipped default as the belt. */
function readTimeoutCap(communityId) {
  const cap = Number(getGuildSettings(communityId)?.automod_timeout_cap);
  return Number.isFinite(cap) && cap > 0 ? cap : AUTOMOD_DEFAULT_TIMEOUT_CAP;
}

/**
 * Re-project an existing (claimed/terminal) row into an outcome — the
 * single-winner loser's answer ("a second click returns the existing
 * result"). `inFlight:true` means another claimer owns a still-running row.
 */
function outcomeFromRow(row, { deduped = true } = {}) {
  const parsed = parseAutomodActionParams(row);
  const base = {
    actionRowId: row.id,
    state: row.state,
    mode: row.mode,
    deduped,
  };
  switch (row.state) {
    case "suggested":
      return { ok: true, ...base, note: "Still a pending suggestion — approve or dismiss it." };
    case "approved":
      return { ok: true, ...base, inFlight: true };
    case "dismissed":
      return { ok: true, ...base, result: row.result_text };
    case "executed":
      return { ok: true, ...base, result: row.result_text, params: parsed.params };
    case "refused":
      return { ok: false, ...base, error: row.error_text || "The action was refused." };
    case "failed":
      return { ok: false, ...base, error: row.error_text || "The action failed." };
    default:
      return { ok: false, ...base, error: `Unknown auto-mod action state \`${row.state}\`.` };
  }
}

// ── Production deps (discord.js v14 behind the seam) ───────────────────────

function requireClient(deps) {
  const client = deps?.client;
  if (!client?.guilds?.cache?.get) {
    throw new Error(
      "no Discord client on deps — inject deps.client (or explicit deps seams) for the Discord-backed steps",
    );
  }
  return client;
}

/**
 * Member-facing "Issued by" label for the warning DM (#733): a snowflake
 * issuer (the referring staff member / the approving staff id) renders as a
 * mention; anything else ("automod", a legacy label) gets the neutral
 * moderation-team wording. NEVER a note ref or staff-only label.
 */
function warnDmIssuerLabel(issuerId) {
  const id = String(issuerId ?? "");
  return /^[0-9]{5,20}$/.test(id) ? `<@${id}>` : "the moderation team";
}

/**
 * Production default for every Discord seam. Each seam is individually
 * overridable: `deps.fetchMemberRoleIds = ...` replaces just the role read.
 * With no deps.client the seams throw the specific "no Discord client"
 * error, which the executor records as a `failed` row — never a silent run.
 * The #733 warn seams (`fetchGuildName`, `sendWarnDm`, `resolveCaseNoteId`)
 * degrade per the warn handler's own error paths — a missing client shows
 * up as the DM-failure partial line, never a lost warning.
 */
function buildDefaultDeps(deps = {}) {
  const guildOf = (guildId) => {
    const client = requireClient(deps);
    const guild = client.guilds.cache.get(String(guildId));
    if (!guild) throw new Error(`guild ${guildId} is not cached by this client`);
    return guild;
  };

  const base = {
    // Subject role ids — the staff-role guard's Discord half (staff_roles
    // itself resolves in the db, same source requireStaff uses).
    fetchMemberRoleIds: async (guildId, userId) => {
      const member = await guildOf(guildId).members.fetch(String(userId));
      return [...(member?.roles?.cache?.keys() ?? [])];
    },
    // Role POSITIONS — the hierarchy guard. Null when unresolvable.
    fetchMemberTopRolePosition: async (guildId, userId) => {
      const member = await guildOf(guildId).members.fetch(String(userId));
      return member?.roles?.highest?.position ?? null;
    },
    fetchBotTopRolePosition: async (guildId) => {
      const me = guildOf(guildId).members?.me;
      return me?.roles?.highest?.position ?? null;
    },
    // Mutations.
    fetchMessage: async (channelId, messageId) => {
      const client = requireClient(deps);
      const channel = await client.channels.fetch(String(channelId));
      return (await channel?.messages?.fetch(String(messageId))) ?? null;
    },
    fetchMember: async (guildId, userId) =>
      guildOf(guildId).members.fetch(String(userId)),
    createBan: async (guildId, userId, { reason }) =>
      guildOf(guildId).bans.create(String(userId), { reason }),
    // ── #733 warn-tool seams ───────────────────────────────────────────────
    // Guild display name for the warning DM (cache read; a plain no-guild
    // "this server" fallback — this read must never kill the DM attempt).
    fetchGuildName: async (guildId) => {
      const guild = deps?.client?.guilds?.cache?.get?.(String(guildId));
      return guild?.name ?? "this server";
    },
    // The member DM. THROWING with a specific cause is the contract — the
    // warn handler turns it into the partial-success line (rule 5); the
    // warnings feature's tryDmUser swallows the cause, which is exactly why
    // this seam does not use it (staff must see WHY the DM failed).
    sendWarnDm: async (userId, payload) => {
      const client = deps?.client;
      if (!client?.users?.fetch) {
        throw new Error("no Discord client users cache — the member DM cannot be sent");
      }
      const user = await client.users.fetch(String(userId));
      if (!user || typeof user.send !== "function") {
        throw new Error(`member ${userId} did not resolve to a DM-able user`);
      }
      await user.send(payload);
    },
    // The case's ONE automod note for this subject → its staff_notes row id
    // (= createWarning's relatedNoteId). Production default = the shared
    // card.js discovery law (./caseNote.js), read against the real db.
    resolveCaseNoteId: async ({ communityId, subjectUserId, caseRow }) => {
      const note = findCaseNoteRow({
        communityId,
        userId: subjectUserId,
        caseNumber: caseRow?.case_number,
        botUserId: deps?.client?.user?.id ?? null,
      });
      return note?.id ?? null;
    },
  };

  // Shallow merge: explicit seams win over the defaults.
  return { ...base, ...deps };
}

// ── Subject guards (locked decision 6) ─────────────────────────────────────

/**
 * Staff-role + role-hierarchy guards for the six mutating actions.
 * Returns { ok:true } to proceed or { ok:false, state, error } to record.
 * `no_action` never comes here — it has no mutation to refuse.
 */
async function guardSubject({ action, communityId, guildId, subjectUserId, deps }) {
  const staffRoleIds = new Set(listStaffRoles(communityId).map((r) => String(r.role_id)));
  let subjectRoleIds;
  try {
    subjectRoleIds = await deps.fetchMemberRoleIds(guildId, subjectUserId);
  } catch (err) {
    return {
      ok: false,
      state: "failed",
      error:
        `Could not check the subject's roles: ${err?.message || err} — refusing to run ` +
        `\`${action}\` without knowing whether they are staff.`,
    };
  }
  const held = (subjectRoleIds ?? []).map(String).find((r) => staffRoleIds.has(r));
  if (held) {
    return {
      ok: false,
      state: "refused",
      error:
        `Refusing to run \`${action}\` against <@${subjectUserId}> — they hold staff role ` +
        `<@&${held}>. Auto-moderation never executes against staff (#723 decision 6); ` +
        "the consideration and this refusal are recorded.",
    };
  }

  let subjectTop = null;
  let botTop = null;
  try {
    [subjectTop, botTop] = await Promise.all([
      deps.fetchMemberTopRolePosition(guildId, subjectUserId),
      deps.fetchBotTopRolePosition(guildId),
    ]);
  } catch (err) {
    return {
      ok: false,
      state: "failed",
      error:
        `Could not check the role hierarchy: ${err?.message || err} — refusing to run ` +
        `\`${action}\` without knowing the bot can moderate the subject.`,
    };
  }
  if (subjectTop == null || botTop == null) {
    return {
      ok: false,
      state: "failed",
      error:
        `Could not resolve the role hierarchy for <@${subjectUserId}> (subject role ` +
        `position ${subjectTop ?? "unknown"}, bot role position ${botTop ?? "unknown"}) — ` +
        `refusing to run \`${action}\` rather than guess whether the bot can moderate them.`,
    };
  }
  if (subjectTop >= botTop) {
    return {
      ok: false,
      state: "refused",
      error:
        `Refusing to run \`${action}\` against <@${subjectUserId}> — their top role ` +
        `(position ${subjectTop}) is not below the bot's highest role (position ${botTop}). ` +
        "Discord only lets a higher role moderate a lower one; move the bot's role up.",
    };
  }
  return { ok: true };
}

// ── The executor ───────────────────────────────────────────────────────────

/**
 * Execute one automod sanction through the mode gate and the guards.
 *
 * @param {object} opts
 * @param {number} opts.communityId integer community id (asserted shape here)
 * @param {string} opts.guildId Discord guild snowflake (Discord-only feature)
 * @param {number|null} [opts.caseId] automod_cases row (#726); with a case
 *   the (case, action, subject) slot is unique — re-entry dedupes to the
 *   existing row's outcome instead of running twice.
 * @param {string} opts.action one of AUTOMOD_ACTIONS
 * @param {string} opts.subjectUserId the considered member's snowflake
 * @param {object} [opts.params] per-action params (see the action handlers)
 * @param {string|null} [opts.referrerUserId] referring staff (warn issuer)
 * @param {string} [opts.claimant] label recorded as the slot claimer
 * @param {string|null} [opts.mode] caller override (validated); default =
 *   read the guild setting via the shipped accessors
 * @param {object} [opts.deps] injectable Discord seams + `client`
 * @param {number} [opts.nowMs] injectable clock
 * @returns {Promise<{ ok: true, state: "recorded_suggestion"|"executed"|"approved"|
 *                    "dismissed"|"suggested", actionRowId?: number, deduped?: boolean,
 *                    params?: object, result?: string|null, inFlight?: boolean }
 *   | { ok: false, state?: "refused"|"failed", error: string, actionRowId?: number|null,
 *       deduped?: boolean }>}
 */
async function executeAutomodAction(opts = {}) {
  try {
    return await executeAutomodActionInner(opts);
  } catch (err) {
    // Belt: the inner flow already maps every known failure to {ok:false}.
    // Anything escaping to here is a bug — log it with the ids and still
    // return the service shape (rule 6: a service never throws).
    logFail("unexpected", opts, err);
    return {
      ok: false,
      error: `Auto-mod executor error: ${err?.message || err}`,
    };
  }
}

async function executeAutomodActionInner(opts) {
  const {
    communityId,
    guildId,
    caseId = null,
    action,
    subjectUserId = null,
    params = {},
    referrerUserId = null,
    claimant = "auto",
    mode: modeOverride = null,
    deps = {},
    nowMs = now(),
  } = opts;

  // ── Input validation (no row is possible without a valid action name) ──
  const act = String(action ?? "").trim().toLowerCase();
  if (!AUTOMOD_ACTIONS.includes(act)) {
    const error = `Unknown auto-mod action \`${action ?? ""}\` — choose one of: ${AUTOMOD_ACTIONS.join(", ")}.`;
    logFail("input validation", { ...opts, action }, error);
    return { ok: false, error };
  }
  if (!Number.isInteger(Number(communityId)) || Number(communityId) < 1) {
    const error = "A valid integer communityId is required — the action cannot be recorded without it.";
    logFail("input validation", { ...opts, action: act }, error);
    return { ok: false, error };
  }
  const cid = Number(communityId);
  const gid = String(guildId ?? "").trim();
  if (!gid) {
    const error = "A guildId (Discord snowflake) is required — auto-moderation is Discord-only for this milestone.";
    logFail("input validation", { ...opts, action: act }, error);
    return { ok: false, error };
  }
  const subject = String(subjectUserId ?? "").trim();
  if (!subject) {
    const error =
      `The \`${act}\` action requires a subjectUserId — automod never acts against ` +
      "an anonymous subject, and #731's note needs someone to be about.";
    logFail("input validation", { ...opts, action: act }, error);
    return { ok: false, error };
  }

  let mode = null;
  if (modeOverride != null && String(modeOverride).trim() !== "") {
    mode = normalizeAutomodMode(modeOverride);
    if (!mode) {
      const error = `Unknown auto-mod mode \`${modeOverride}\` — choose one of: ${AUTOMOD_MODES.join(", ")}.`;
      logFail("input validation", { ...opts, action: act }, error);
      return { ok: false, error };
    }
  } else {
    mode = resolveActionMode(cid, act);
  }

  const ids = { communityId: cid, guildId: gid, subjectUserId: subject, caseId, action: act };

  // ── Mode gate: off ──────────────────────────────────────────────────────
  if (mode === "off") {
    const error =
      `The \`${act}\` auto-mod action is off for this guild — it cannot run ` +
      "(staff must set its mode to suggest or auto first).";
    const written = recordAutomodActionRefusal({
      communityId: cid, caseId, guildId: gid, subjectUserId: subject,
      action: act, mode: "off", params, error, nowMs,
    });
    logFail("mode gate", { ...ids, actionRowId: written.row?.id }, error);
    if (!written.ok && !written.deduped) {
      logFail("refusal record", ids, written.error);
      return { ok: false, error: `${error} (${written.error})` };
    }
    if (written.deduped) return outcomeFromRow(written.existing);
    return { ok: false, state: "refused", actionRowId: written.row.id, error };
  }

  // ── Mode gate: suggest — record, zero Discord calls ─────────────────────
  if (mode === "suggest") {
    const written = insertAutomodActionSuggestion({
      communityId: cid, caseId, guildId: gid, subjectUserId: subject,
      action: act, mode: "suggest", params, nowMs,
    });
    if (!written.ok && !written.deduped) {
      logFail("suggestion record", ids, written.error);
      return { ok: false, state: "failed", error: written.error };
    }
    if (written.deduped) return outcomeFromRow(written.existing);
    return {
      ok: true,
      state: "recorded_suggestion",
      actionRowId: written.row.id,
      mode: "suggest",
    };
  }

  // ── Mode: auto — ATOMIC CLAIM (the insert is the slot), then run ────────
  const slot = claimAutomodActionSlot({
    communityId: cid, caseId, guildId: gid, subjectUserId: subject,
    action: act, mode: "auto", params, claimant, nowMs,
  });
  if (!slot.ok && !slot.deduped) {
    logFail("action claim", ids, slot.error);
    return { ok: false, state: "failed", error: slot.error };
  }
  if (slot.deduped) {
    // Auto re-entry on a claimed/terminal row: report the existing result,
    // never re-run the mutation.
    return outcomeFromRow(slot.existing);
  }
  return runClaimedAction(slot.row, { deps, referrerUserId, nowMs });
}

/**
 * Thin over the executor: the card's Approve button. Claims the suggested
 * row FIRST (single-winner UPDATE), then runs the same path auto mode uses
 * — mode gate re-applies at run time, so an action staff turned `off` after
 * the suggestion was recorded refuses even mid-approval.
 *
 * @param {{ actionRowId: number, claimant?: string, deps?: object,
 *           referrerUserId?: string|null, nowMs?: number }} opts
 */
async function approveSuggestion({
  actionRowId,
  claimant = "staff",
  deps = {},
  referrerUserId = null,
  nowMs = now(),
} = {}) {
  try {
    const row = getAutomodAction(actionRowId);
    if (!row) {
      return { ok: false, error: `No auto-mod suggestion row #${actionRowId} to approve.` };
    }
    const claimed = claimAutomodSuggestion(row.id, claimant, { nowMs });
    if (!claimed.ok) {
      if (!claimed.deduped) {
        logFail("approve claim", { communityId: row.community_id, action: row.action }, claimed.error);
        return { ok: false, error: claimed.error };
      }
      return outcomeFromRow(claimed.row);
    }
    return await runClaimedAction(claimed.row, { deps, referrerUserId, nowMs });
  } catch (err) {
    logFail("approve unexpected", { communityId: null, action: null, actionRowId }, err);
    return { ok: false, error: `Auto-mod approve failed: ${err?.message || err}` };
  }
}

/**
 * Thin over the ledger: the card's Dismiss button. Claims the suggestion
 * away from execution and records the DECLINE — nothing runs. A second
 * click returns the existing row (single-winner), and an Approve on a
 * dismissed row can never revive it.
 *
 * @param {{ actionRowId: number, claimant?: string, note?: string|null,
 *           nowMs?: number }} opts
 */
async function dismissSuggestion({
  actionRowId,
  claimant = "staff",
  note = null,
  nowMs = now(),
} = {}) {
  try {
    const done = dismissAutomodSuggestion(actionRowId, claimant, { note, nowMs });
    if (done.ok) {
      return { ok: true, state: "dismissed", actionRowId: done.row.id, result: done.row.result_text };
    }
    if (!done.deduped) {
      return { ok: false, error: done.error };
    }
    return outcomeFromRow(done.row);
  } catch (err) {
    logFail("dismiss unexpected", { actionRowId }, err);
    return { ok: false, error: `Auto-mod dismiss failed: ${err?.message || err}` };
  }
}

// ── Claimed-row execution: guards → clamp → handler → record ───────────────

async function runClaimedAction(row, { deps, referrerUserId = null, nowMs = now() }) {
  const resolved = buildDefaultDeps(deps);
  const ids = {
    communityId: row.community_id,
    guildId: row.guild_id,
    subjectUserId: row.subject_user_id,
    caseId: row.case_id,
    action: row.action,
    actionRowId: row.id,
  };
  const act = row.action;
  const baseParams = parseAutomodActionParams(row).params ?? {};
  let params = { ...baseParams };

  // #739 inserts the circuit-breaker gate here (isAutomodPaused is already
  // on the db facade) — auto and Approve share this choke point.

  // Off is UNRUNNABLE at commit time, not just at call time (locked
  // decision 2): the mode may have changed since the suggestion landed, so
  // every claimed run re-reads it — including the approval path.
  const currentMode = resolveActionMode(row.community_id, act);
  if (currentMode === "off") {
    return finalize(row, {
      state: "refused",
      error:
        `The \`${act}\` auto-mod action is off for this guild now — the run ` +
        "cannot proceed (locked decision: off is unrunnable).",
      ids,
      nowMs,
    });
  }

  if (MUTATING_ACTIONS.includes(act)) {
    const guard = await guardSubject({
      action: act,
      communityId: row.community_id,
      guildId: row.guild_id,
      subjectUserId: row.subject_user_id,
      deps: resolved,
    });
    if (!guard.ok) {
      return finalize(row, { state: guard.state, error: guard.error, ids, nowMs });
    }
  }

  // Action-specific param pre-flight (cheap, before any REST call).
  if (act === "timeout") {
    const clamped = clampTimeoutDuration({
      requestedSeconds: params.durationSeconds,
      guildCapSeconds: readTimeoutCap(row.community_id),
    });
    if (!clamped.ok) {
      return finalize(row, { state: "refused", error: clamped.error, ids, nowMs });
    }
    params = {
      ...params,
      durationSeconds: clamped.durationSeconds,
      ...(clamped.clampedFrom != null
        ? { requestedDurationSeconds: clamped.clampedFrom, clamped: true }
        : {}),
    };
  }
  if (act === "delete_message") {
    if (!params.channelId || !params.messageId) {
      return finalize(row, {
        state: "refused",
        error:
          "The `delete_message` action needs params.channelId and params.messageId — " +
          "the delete tool removes specific messages only (no bulk purge).",
        ids,
        nowMs,
      });
    }
  }

  const handler =
    resolved.actions?.[act] ?? buildActionHandler(act, { resolved, row, params, referrerUserId });
  let outcome;
  try {
    // Injected handlers (deps.actions.<action>, e.g. #735's ticket tool)
    // receive { row, params, deps } — defaults ignore the argument.
    outcome = await handler({ row, params, deps: resolved });
  } catch (err) {
    return finalize(row, {
      state: "failed",
      error: `The \`${act}\` action could not run: ${err?.message || err}`,
      ids,
      nowMs,
      params,
    });
  }
  if (!outcome?.ok) {
    const error = outcome?.error || `The \`${act}\` action refused to run (handler returned no reason).`;
    return finalize(row, { state: "refused", error, ids, nowMs, params });
  }
  return finalize(row, {
    state: "executed",
    result: outcome.result ?? defaultResultText(act, row, params),
    params,
    ids,
    nowMs,
  });
}

/**
 * Action handlers behind the deps seam. Every one closes over the resolved
 * deps, the claimed row, and the EFFECTIVE (post-clamp) params; a caller
 * overrides any single action via `deps.actions.<action>`.
 */
function buildActionHandler(act, { resolved, row, params, referrerUserId = null }) {
  const guildId = row.guild_id;
  const subject = row.subject_user_id;
  const caseTag = row.case_id != null ? `case #${row.case_id}` : "referral";
  const auditReason = `Auto-mod ${act} (${caseTag})`;

  switch (act) {
    case "no_action":
      return async () => ({ ok: true });

    case "warn":
      return async () => {
        // Real formal warning (locked decision 3): createWarning owns the
        // reason/evidence/expiry validation and THROWS typed errors —
        // translated to {ok:false} here (rule 6: services don't throw).
        //
        // #733 MEMBER-FACING LAW: `params.reason` is what the warned member
        // reads — it lands on the formal record and is the ONLY prose the
        // warning DM carries. The staff-note body, the model's rationale,
        // note refs, and evidence NEVER enter the DM: the payload comes
        // from buildWarnDmPayload, which accepts nothing but the standard
        // warning framing (W-n / issuer / count / reason / when / expiry).
        const ids = {
          communityId: row.community_id,
          guildId,
          subjectUserId: subject,
          caseId: row.case_id,
          action: act,
          actionRowId: row.id,
        };
        const reason =
          String(params.reason ?? "").trim() ||
          `Auto-moderation sanction from ${caseTag}`;
        const guildDefaultDays = Number(
          getGuildSettings(row.community_id)?.warn_expiry_days,
        );

        // relatedNoteId = the case's ONE staff note for this subject
        // (#733). The harness's two-phase commit injects it when the row
        // is RECORDED (so auto AND approve both carry it from the row's
        // own params); a row without one — a replay of an older suggestion
        // or a direct executor call — resolves it here through the card's
        // discovery law. Best-effort by contract: an unresolvable link
        // never costs the warning (the note itself is the record), and a
        // createWarning INVALID_NOTE surfaces below as its specific cause.
        if (params.relatedNoteId == null && row.case_id != null) {
          try {
            const caseRowForNote = getAutomodCaseById(Number(row.case_id));
            if (
              caseRowForNote &&
              Number(caseRowForNote.community_id) === Number(row.community_id)
            ) {
              const found = await resolved.resolveCaseNoteId({
                communityId: row.community_id,
                subjectUserId: subject,
                caseRow: caseRowForNote,
              });
              if (found != null && Number.isFinite(Number(found))) {
                params.relatedNoteId = Math.floor(Number(found));
              }
            }
          } catch (err) {
            logFail("warn note-link (best effort)", ids, err);
          }
        }

        let warn;
        try {
          warn = createWarning({
            communityId: row.community_id,
            // Evidence URLs embed the external (Discord) snowflake —
            // same posture as the /warn handler.
            externalGuildId: guildId,
            userId: subject,
            // Actor fields: the referring staff member is the issuer when
            // known (auto runs carry it from the referral); the claimant
            // label is the fallback ("staff:<id>" clicks / "auto").
            issuerId: String(referrerUserId ?? row.claimed_by ?? "automod"),
            reason,
            relatedNoteId: params.relatedNoteId ?? null,
            expiresDays: params.expiresDays ?? null,
            guildDefaultDays: Number.isFinite(guildDefaultDays) ? guildDefaultDays : 0,
            evidenceMessageUrl: params.evidenceMessageUrl ?? null,
            evidenceText: params.evidenceText ?? null,
          });
        } catch (err) {
          return {
            ok: false,
            error: `Could not record the warning: ${err?.message || err}`,
          };
        }

        // Member DM (#733): honour the guild's warn-DM setting EXACTLY like
        // /warn add does — same shipped gate (warnDmEnabled), same standard
        // framing (buildWarnDmPayload). Auto AND Approve both land here —
        // one code path, mode is not the DM gate (locked decision 2).
        const base =
          `Formal warning W-${warn.warning_number} recorded against <@${subject}> ` +
          `(issuer ${warn.issuer_id}).`;
        if (!warnDmEnabled(row.community_id)) {
          return {
            ok: true,
            result:
              `${base} Member DM skipped — member DMs are disabled for this ` +
              "server (`/setwarn dm`).",
          };
        }
        try {
          const guildName = await resolved.fetchGuildName(guildId);
          const payload = buildWarnDmPayload({
            warn,
            guildName: guildName || "this server",
            issuedByLabel: warnDmIssuerLabel(warn.issuer_id),
            activeCount: countActiveWarnings(row.community_id, subject),
          });
          await resolved.sendWarnDm(subject, payload);
          return { ok: true, result: `${base} Member notified by DM.` };
        } catch (err) {
          // Partial success, reported (rule 5): the warning row EXISTS and
          // this row is executed — the card/note line names the DM cause.
          logFail("warn member DM (warning stays recorded)", ids, err);
          return {
            ok: true,
            result:
              `${base.slice(0, -1)} — warning recorded, member DM failed: ` +
              `${err?.message || err}.`,
          };
        }
      };

    case "delete_message":
      return async () => {
        const message = await resolved.fetchMessage(params.channelId, params.messageId);
        if (!message) {
          return {
            ok: false,
            error: `Message ${params.messageId} was not found in channel ${params.channelId} — nothing was deleted.`,
          };
        }
        await message.delete(auditReason);
        return { ok: true, result: `Deleted message ${params.messageId}.` };
      };

    case "timeout":
      return async () => {
        const member = await resolved.fetchMember(guildId, subject);
        if (!member) {
          return {
            ok: false,
            error: `Member ${subject} was not found in guild ${guildId} — nobody was timed out.`,
          };
        }
        // discord.js v14: member.timeout(ms, reason)
        await member.timeout(params.durationSeconds * 1000, auditReason);
        const clampNote =
          params.clamped && params.requestedDurationSeconds != null
            ? ` (clamped from ${params.requestedDurationSeconds}s)`
            : "";
        return {
          ok: true,
          result:
            `Timed out <@${subject}> for ${params.durationSeconds}s${clampNote} — ` +
            "the duration recorded here is the duration actually applied.",
        };
      };

    case "kick":
      return async () => {
        const member = await resolved.fetchMember(guildId, subject);
        if (!member) {
          return {
            ok: false,
            error: `Member ${subject} was not found in guild ${guildId} — nobody was kicked.`,
          };
        }
        await member.kick(auditReason);
        return { ok: true, result: `Kicked <@${subject}>.` };
      };

    case "ban":
      return async () => {
        // No delete-message window on purpose: banning is not a bulk-delete
        // tool (epic #723 decision 9) — the delete tool removes specifics.
        await resolved.createBan(guildId, subject, { reason: auditReason });
        return { ok: true, result: `Banned <@${subject}>.` };
      };

    case "ticket":
      return async () => ({
        ok: false,
        error:
          "the ticket action is not wired yet (#735) — the automod ticket tool must " +
          "open the case ticket through the help-ticket system with the subject in it. " +
          "Nothing was opened.",
      });

    default:
      return async () => ({
        ok: false,
        error: `No executor handler for action \`${act}\`.`,
      });
  }
}

function defaultResultText(act, row, params) {
  if (act === "no_action") {
    // #732 canonical key is `reason`; `rationale` stays readable for rows
    // recorded before the rename.
    const rationale = String(params?.reason ?? params?.rationale ?? "").trim();
    return rationale
      ? `No action — <@${row.subject_user_id}> considered: ${rationale}`
      : `No action — <@${row.subject_user_id}> considered, no sanction warranted.`;
  }
  return `${act} completed for <@${row.subject_user_id}>.`;
}

/**
 * Record the claimed row's terminal state. A record-claim loss means
 * someone already finalized it — their outcome wins (returned deduped);
 * a record FAILURE is logged with full ids and returned as ok:false
 * (nothing silently drops).
 */
async function finalize(row, { state, result = null, error = null, params = null, ids, nowMs }) {
  const written = recordAutomodActionResult(
    row.id,
    { state, resultText: result, errorText: error, params },
    { nowMs },
  );
  if (!written.ok && !written.deduped) {
    logFail(`result record (${state})`, ids, written.error);
    return {
      ok: false,
      state: "failed",
      actionRowId: row.id,
      error: `${error || result || `Could not record the ${state} outcome`}: ${written.error}`,
    };
  }
  if (written.deduped) {
    logFail("duplicate finalize", ids, error || result || state);
    return outcomeFromRow(written.row);
  }
  if (state !== "executed") {
    // Every refusal/failure is a staff-facing specific cause AND a log line
    // with the ids (rules 2+3) — the card shows `error` verbatim.
    logFail(`guarded ${state}`, ids, error || "no reason recorded");
    return { ok: false, state, actionRowId: row.id, error: error || result };
  }
  return {
    ok: true,
    state: "executed",
    actionRowId: row.id,
    result: written.row.result_text,
    params: parseAutomodActionParams(written.row).params,
  };
}

module.exports = {
  executeAutomodAction,
  approveSuggestion,
  dismissSuggestion,
  // Pure/testable pieces (also useful to #730's card + #739's breaker):
  buildDefaultDeps,
  clampTimeoutDuration,
  resolveActionMode,
  outcomeFromRow,
  MUTATING_ACTIONS,
};
