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
 * defaults ride the REAL ticket system through dedicated seams (#735 — see
 * the ticket handler's member-visible law): the rate-slot pair over
 * `claimTicketCreateSlot`/`releaseTicketCreateSlot` and `openCaseTicket`
 * over the real `openTicketChannel`. The circuit breaker gate (#739) will
 * add its `isAutomodPaused` check inside runClaimedAction — one choke
 * point, both auto and approve already flow through it.
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
 *
 * THE DELETE-MESSAGE TOOL (#734, epic #723) — specific messages only: never
 * a channel purge, never ban's "delete N days of history" (decisions 2/9).
 *  - Canonical params (recorded by the dispatcher): `params.messages =
 *    [{ channelId, messageId }, …]`. LEGACY FALLBACK LAW: a row without
 *    `params.messages` still executes its single `params.channelId` +
 *    `params.messageId` pair (rows recorded before #734 stay alive — the
 *    card reads the same resolved list).
 *  - Manage Messages is verified on EVERY distinct channel of the call
 *    BEFORE a single delete runs (`deps.channelCanManageMessages`, fail
 *    closed like refer.js channelAllows): a missing permission refuses the
 *    whole row naming the channel(s) with ZERO deletions; a vanished channel
 *    or bot-not-in-guild refuses with THAT cause. The MUTATING_ACTIONS
 *    staff-role + hierarchy guard still runs first (decision 6 — a staff
 *    author's suggestion records but Approve/auto refuse there, not here).
 *  - Per-message honesty (contract): every id's outcome is its own — all ok
 *    `Deleted N message(s) in this case.`; a partial failure is executed
 *    with the honest line `Deleted 2 of 3 — failed: <id> (<cause>)…` (the
 *    line IS the report, #733 partial idiom); ALL failed is the failed row
 *    with the same list. A vanished message is that id's 10003 failure,
 *    never a crash.
 *
 * THE TICKET TOOL (#735, epic #723) — member-visible law lives HERE too:
 *  - `params.reason` is the ticket's MEMBER-VISIBLE opening: `openTicketChannel`
 *    posts it VERBATIM into the open notice the subject reads in the ticket
 *    channel. No second ticket system: the subject is the CREATOR (that IS
 *    the shipped member-add path — the creator overwrite grants them the
 *    channel), the referring staff rides as `openedByStaffId` (named staff
 *    overwrite); a null referrer opens subject + staff-roles only — the
 *    ticket is never orphaned. ZERO DMs anywhere: the member-visible
 *    opening IS the ticket channel's own open notice.
 *  - Commit-time NOTE-OVERLAP SCRUB (decision 4 spirit — enforcement, not
 *    prompt hope): the harness passes the subject's queued note narrative as
 *    the optional `queuedNoteNarrative` input (NEVER persisted into
 *    params_json). Normalized (trimmed, space-collapsed), a narrative of
 *    ≥ AUTOMOD_TICKET_NOTE_OVERLAP_MIN chars whose start the reason
 *    reproduces makes the reason a staff-note DUPLICATE — the row refuses
 *    naming the duplication. Shorter/absent narratives never refuse (the
 *    dispatcher's machine-marker belt covers literal note artifacts).
 *  - Rate limit (#420 law): the subject IS the rate-limited creator, so the
 *    claim runs SYNCHRONOUSLY before the first await via
 *    `deps.claimTicketRateSlot`; a refusal names both minute counts and
 *    states the staff note stands. ANY open failure releases the EXACT
 *    stamp (release failure logged only); a success keeps the reservation
 *    (it ages out). The thrown cause rides the refusal VERBATIM — the typed
 *    BOT_PERMISSIONS / CHANNEL_CREATE causes already name themselves (they
 *    ride `formatChannelCreateError`; the K8 elevation gate belongs to the
 *    Fluxer arm this Discord-only path never reaches).
 *  - Success line (result-line idiom, mirrors warn's `Formal warning W-n
 *    recorded…`): `Opened ticket T-<n> with <@subject>: <#channelId> (case
 *    A-<n>).` — the channel MENTION is the card's channel link. Skipped
 *    staff-role overwrites append the shipped honest access note. A
 *    refusal NEVER deletes or omits the subject's staff note (#731 law).
 */

const { PermissionFlagsBits } = require("discord.js");
const {
  getGuildSettings,
  listStaffRoles,
  createWarning,
  countActiveWarnings,
  getAutomodCaseById,
  claimTicketCreateSlot,
  releaseTicketCreateSlot,
  now,
  insertAutomodActionSuggestion,
  claimAutomodActionSlot,
  recordAutomodActionRefusal,
  claimAutomodSuggestion,
  dismissAutomodSuggestion,
  recordAutomodActionResult,
  getAutomodAction,
  parseAutomodActionParams,
  isAutomodPaused,
} = require("../../db");
// READ-ONLY imports of the shipped warnings feature (#733): the same member
// DM gate and the same standard DM framing `/warn add` uses — no parallel
// warning copy. (Deliberate cross-feature import named by the #733 contract;
// NOT the gork isolation case of locked decision 7.)
const { warnDmEnabled, buildWarnDmPayload } = require("../warnings/helpers");
// READ-ONLY imports of the shipped ticket system (#735): the ONE ticket
// opening pipeline (creator = the subject — that IS the existing member-add
// path) and the honest skipped-overwrite access note `/ticket create`
// renders. No second ticket system (contract), and both are pure imports of
// exported functions — no interaction context is dragged in.
const { openTicketChannel } = require("../tickets/helpers");
const { formatStaffRoleAccessNote } = require("../tickets/overwrites");
// The platform outbound layer's kick helper (#737): the automod kick tool
// rides `kickMember` beside `banMember` — the model tool loop never touches
// discord.js, and the executor's `createKick` seam wraps this one pipeline
// (tests script the seam, production reaches the cached outbound).
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { findCaseNoteRow } = require("./caseNote");
const {
  AUTOMOD_ACTIONS,
  AUTOMOD_MODES,
  AUTOMOD_TIMEOUT_CAP_MIN,
  AUTOMOD_TIMEOUT_CAP_MAX,
  AUTOMOD_DEFAULT_TIMEOUT_CAP,
  AUTOMOD_TICKET_NOTE_OVERLAP_MIN,
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

/** The breaker's scope (#736 gate / #739 trip, epic #723): the escalating
 *  three stay DARK while the safety pause is set — warn, delete_message,
 *  ticket, no_action, and staff notes keep running. Auto commit AND
 *  Approve clicks flow through the one gated choke point
 *  (`runClaimedAction`); suggestions still RECORD (#739: the card keeps
 *  showing them, Approve answers with the pause refusal). */
const BREAKER_GATED_ACTIONS = Object.freeze(["timeout", "kick", "ban"]);

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
 * THE DELETE TARGET RESOLVER (#734) — ONE reading law for the executor
 * handler and the case card. Canonical `params.messages` wins when present
 * (entries deduped on channel+message, unusable entries dropped); a row
 * WITHOUT it falls back to the LEGACY single `params.channelId` +
 * `params.messageId` pair — rows recorded before #734 keep executing and
 * rendering unchanged (fallback law, pinned by test/automod-executor and
 * test/automod-card). Both missing → [] (the delete pre-flight refuses).
 *
 * @param {object|null} [params] the row's parsed params
 * @returns {Array<{channelId: string, messageId: string}>}
 */
function resolveDeleteTargets(params = null) {
  if (Array.isArray(params?.messages)) {
    const out = [];
    const seen = new Set();
    for (const entry of params.messages) {
      const channelId = String(entry?.channelId ?? "").trim();
      const messageId = String(entry?.messageId ?? "").trim();
      if (!channelId || !messageId) continue;
      const key = `${channelId}|${messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ channelId, messageId });
    }
    return out;
  }
  const channelId = String(params?.channelId ?? "").trim();
  const messageId = String(params?.messageId ?? "").trim();
  return channelId && messageId ? [{ channelId, messageId }] : [];
}

/**
 * #735 NOTE-OVERLAP SCRUB — the ONE normalized form a queued staff-note
 * narrative and a ticket reason are compared in: trimmed, inner whitespace
 * collapsed. No case-folding: the scrub catches VERBATIM reproduction, not
 * paraphrase (the dispatcher's machine-marker belt already refuses literal
 * note artifacts).
 */
function normalizeNarrativeText(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

/**
 * THE COMMIT-TIME OVERLAP LAW (#735, epic #723 decision 4's spirit): the
 * ticket reason is MEMBER-VISIBLE; the subject's staff note is NOT. The
 * harness threads the subject's queued note narrative at commit (the note
 * may be queued AFTER the ticket call, so dispatch cannot judge this).
 * Rule: a narrative that normalizes to ≥ AUTOMOD_TICKET_NOTE_OVERLAP_MIN
 * characters and whose first AUTOMOD_TICKET_NOTE_OVERLAP_MIN characters the
 * reason (same normalization) contains ⇒ the reason reproduces the private
 * note ⇒ the row refuses. A narrative below the floor (or absent) never
 * refuses — quoted phrases under the floor are coincidence, not leakage.
 *
 * @param {string|null|undefined} reason the member-visible ticket reason
 * @param {string|null|undefined} narrative the subject's queued note content
 * @returns {boolean} true ⇒ the reason duplicates the note — refuse the row
 */
function ticketReasonDuplicatesNote(reason, narrative) {
  const narr = normalizeNarrativeText(narrative);
  if (narr.length < AUTOMOD_TICKET_NOTE_OVERLAP_MIN) return false;
  const needle = narr.slice(0, AUTOMOD_TICKET_NOTE_OVERLAP_MIN);
  return normalizeNarrativeText(reason).includes(needle);
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
 * up as the DM-failure partial line, never a lost warning. The #735 ticket
 * seams (`claimTicketRateSlot` / `releaseTicketRateSlot` over the real repo
 * slot pair, `openCaseTicket` over the real `openTicketChannel`) open the
 * case ticket through the shipped help-ticket system — a missing client
 * throws the specific cause, which the handler reports verbatim.
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
    // ── #734 delete pre-flight: does the bot hold Manage Messages HERE?
    // Fail CLOSED like refer.js channelAllows — an unreadable permission
    // surface means FALSE (the refusal names the channel, zero deletions).
    // STRUCTURAL deaths throw with the specific cause instead: no client,
    // a vanished channel, or the bot not being a guild member (the delete
    // handler reports those verbatim — "channel gone", "bot not in guild").
    channelCanManageMessages: async (guildId, channelId) => {
      const client = requireClient(deps);
      const channel = await client.channels.fetch(String(channelId));
      if (!channel) throw new Error(`channel ${channelId} no longer exists`);
      const guild =
        client.guilds?.cache?.get?.(String(guildId)) ?? channel?.guild ?? null;
      const me = guild?.members?.me ?? null;
      if (!me) {
        throw new Error(
          `the bot is not a member of guild ${guildId} — Manage Messages cannot be verified`,
        );
      }
      if (typeof channel.permissionsFor !== "function") {
        console.error(
          `[automod] executor channel permission read failed (channel ${channelId}): no permissionsFor surface`,
        );
        return false;
      }
      const bits = channel.permissionsFor(me);
      if (!bits || typeof bits.has !== "function") {
        console.error(
          `[automod] executor channel permission read failed (channel ${channelId}): unreadable permission bits`,
        );
        return false;
      }
      try {
        return bits.has(PermissionFlagsBits.ManageMessages) === true;
      } catch (err) {
        console.error(
          `[automod] executor channel permission read failed (channel ${channelId}):`,
          err?.message || err,
        );
        return false;
      }
    },
    fetchMember: async (guildId, userId) =>
      guildOf(guildId).members.fetch(String(userId)),
    createBan: async (guildId, userId, { reason }) =>
      guildOf(guildId).bans.create(String(userId), { reason }),
    // #737: the kick rides the platform outbound's kickMember helper (the
    // cached Discord outbound over the same client). {ok:false, error, code}
    // comes back from the outbound — the handler reports the cause verbatim.
    createKick: async (communityId, userId, { reason }) =>
      getDiscordOutbound(requireClient(deps)).kickMember(
        communityId,
        userId,
        reason,
      ),
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
    // ── #735 ticket-tool seams ─────────────────────────────────────────────
    // The subject's ticket-create rate slot over the REAL repo claim
    // (#420 law — synchronous, no await inside; the handler takes it before
    // its first await). Tests record calls / script refusals here.
    claimTicketRateSlot: (communityId, userId) =>
      claimTicketCreateSlot(communityId, userId),
    // Hand the EXACT claimed stamp back after a FAILED open (release is
    // stamp-guarded in the repo — a newer claim is never clobbered). A
    // successful open never calls this: the reservation ages out.
    releaseTicketRateSlot: (communityId, userId, stamp) =>
      releaseTicketCreateSlot(communityId, userId, stamp),
    // The REAL ticket pipeline. The subject is the CREATOR (the shipped
    // member-add path: the creator overwrite is what puts them IN the
    // channel), the referring staff rides as openedByStaffId (named staff
    // overwrite; null opens subject + staff-role overwrites — never
    // orphaned). Typed throws ride through untouched: "Bot user not ready",
    // code BOT_PERMISSIONS, code CHANNEL_CREATE (already through
    // formatChannelCreateError) — the handler reports them verbatim.
    openCaseTicket: async ({ guildId: gid, communityId, subjectUserId, reason, openedByStaffId }) => {
      const client = requireClient(deps);
      const guild = guildOf(gid);
      return openTicketChannel({
        guild,
        client,
        communityId,
        creatorUserId: String(subjectUserId),
        reason,
        openedByStaffId: openedByStaffId ? String(openedByStaffId) : null,
      });
    },
    // ── #736 breaker gate seam ─────────────────────────────────────────────
    // The persisted safety pause over the real repo read (#725 columns; the
    // TRIP that writes them is #739, the `safety resume` CLEAR is shipped).
    // The gate calls it for kick/ban/timeout only; tests script the state
    // here without touching the database.
    isAutomodPaused: (communityId) => isAutomodPaused(communityId),
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
 * @param {string|null} [opts.referrerUserId] referring staff (warn issuer;
 *   #735: the ticket's `openedByStaffId` participant)
 * @param {string|null} [opts.queuedNoteNarrative] #735 commit-time ticket
 *   scrub input — the subject's queued staff-note content, threaded by the
 *   harness. Read by the ticket overlap law only; NEVER persisted into
 *   params_json and never member-visible.
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
    // #735 commit-time member-visible scrub: the subject's QUEUED staff-note
    // narrative, supplied by the harness at commit (the note may be queued
    // after the ticket call, so commit is the authoritative seam). Read by
    // the ticket handler's overlap law only — NEVER persisted into
    // params_json, never offered to the model.
    queuedNoteNarrative = null,
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
  return runClaimedAction(slot.row, {
    deps,
    referrerUserId,
    nowMs,
    queuedNoteNarrative,
  });
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

async function runClaimedAction(row, {
  deps,
  referrerUserId = null,
  nowMs = now(),
  // #735: the subject's queued staff-note narrative (ticket overlap scrub
  // input — read by the ticket handler only, never persisted).
  queuedNoteNarrative = null,
} = {}) {
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

  // #736/#739 CIRCUIT-BREAKER GATE (locked decision 2's safety half): while
  // the persisted pause is set, kick/ban/timeout are DARK for BOTH paths —
  // auto commit and Approve clicks share this choke point (the card's
  // pre-gate answers the clicker early; this is the source of truth).
  // Warn / delete / ticket / no_action / staff notes keep running — the
  // pause covers the escalating three only (epic #723; #739 owns the TRIP,
  // the `safety resume` clear ships with #725).
  if (BREAKER_GATED_ACTIONS.includes(act)) {
    const pause = resolved.isAutomodPaused(row.community_id);
    if (pause?.paused) {
      return finalize(row, {
        state: "refused",
        error:
          `**Safety paused:** the auto-moderation circuit breaker is tripped — ` +
          `\`${act}\` runs stay dark until an admin runs ` +
          "`/automodconfig safety resume` (confirm:true). " +
          `**Pause reason:** ${pause.reason ?? "not recorded"}`,
        ids,
        nowMs,
      });
    }
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
    // #734 canonical list OR the legacy single pair (fallback law — shared
    // resolver with the card). Nothing resolvable = nothing to delete.
    if (resolveDeleteTargets(params).length === 0) {
      return finalize(row, {
        state: "refused",
        error:
          "The `delete_message` action needs params.messages ([{channelId, messageId}, …]) " +
          "or the legacy params.channelId and params.messageId — " +
          "the delete tool removes specific messages only (no bulk purge).",
        ids,
        nowMs,
      });
    }
  }

  const handler =
    resolved.actions?.[act] ??
    buildActionHandler(act, { resolved, row, params, referrerUserId, queuedNoteNarrative });
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
    return finalize(row, {
      // A handler may escalate the terminal state to `failed` (e.g. #734:
      // every message's Discord call died — that is a FAILED row, not a
      // guard refusal). Plain {ok:false} stays the shipped `refused`.
      state: outcome?.state === "failed" ? "failed" : "refused",
      error,
      ids,
      nowMs,
      params,
    });
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
 * `queuedNoteNarrative` (#735) is the ticket handler's commit-time scrub
 * input — never persisted, never shown to the model, never DM'd.
 */
function buildActionHandler(act, {
  resolved,
  row,
  params,
  referrerUserId = null,
  queuedNoteNarrative = null,
}) {
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
        // #734 — specific messages only (never a purge, never ban's history
        // window: #723 decisions 2/9). MANAGE MESSAGES PRE-FLIGHT first:
        // every distinct channel of the call is verified BEFORE a single
        // delete; a channel the bot cannot manage (or cannot verify) refuses
        // the whole row naming the cause with ZERO deletions.
        const targets = resolveDeleteTargets(params);
        const channelIds = [...new Set(targets.map((t) => t.channelId))];
        const missing = [];
        for (const channelId of channelIds) {
          let allowed = false;
          try {
            allowed = (await resolved.channelCanManageMessages(guildId, channelId)) === true;
          } catch (err) {
            return {
              ok: false,
              error:
                `Could not verify the bot's Manage Messages permission in channel ${channelId}: ` +
                `${err?.message || err} — nothing was deleted.`,
            };
          }
          if (!allowed) missing.push(channelId);
        }
        if (missing.length > 0) {
          return {
            ok: false,
            error:
              `Bot is missing **Manage Messages** in channel(s) ${missing.map((c) => `<#${c}>`).join(", ")} — ` +
              "nothing was deleted.",
          };
        }
        // PER-MESSAGE RESULTS (contract): each id's outcome is its own —
        // successes counted, failures keep THEIR id + the raw Discord cause.
        // Partial executes honestly (the line IS the report, #733 idiom);
        // ALL failed is the failed row with the same list. Never a clean
        // success claim when anything failed, never a crash on a vanished
        // message (10003 is that id's failure).
        const failed = [];
        let deleted = 0;
        for (const target of targets) {
          try {
            const message = await resolved.fetchMessage(target.channelId, target.messageId);
            if (!message) {
              failed.push(`${target.messageId} (Discord 10003 — message not found, already gone)`);
              continue;
            }
            await message.delete(auditReason);
            deleted += 1;
          } catch (err) {
            failed.push(`${target.messageId} (${err?.message || err})`);
          }
        }
        if (deleted === 0) {
          return {
            ok: false,
            state: "failed",
            error: `Deleted 0 of ${targets.length} — failed: ${failed.join(", ")}.`,
          };
        }
        if (failed.length > 0) {
          return {
            ok: true,
            result: `Deleted ${deleted} of ${targets.length} — failed: ${failed.join(", ")}.`,
          };
        }
        return { ok: true, result: `Deleted ${deleted} message(s) in this case.` };
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
        // #736: the stated reason IS the Discord timeout reason — it rides
        // the audit entry the subject's client can surface. The dispatcher
        // requires it; a legacy/direct row without one falls back to the
        // generic case-tag audit line (belt, never a dead end).
        const stated = String(params.reason ?? "").trim();
        const discordReason = stated
          ? `${stated} (automod ${caseTag})`
          : auditReason;
        // discord.js v14: member.timeout(ms, reason)
        await member.timeout(params.durationSeconds * 1000, discordReason);
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
        // #737: the kick rides the platform outbound's `kickMember` helper
        // (beside `banMember`) through the createKick seam — the tool loop
        // never calls discord.js directly. The STATED reason is the audit-log
        // reason (the dispatcher requires it; a legacy/direct row without one
        // falls back to the generic case-tag line — belt, never a dead end).
        // Every Discord failure (unknown member 10007, hierarchy 50013,
        // missing permissions) refuses with the outbound's specific cause.
        const stated = String(params.reason ?? "").trim();
        const discordReason = stated
          ? `${stated} (automod ${caseTag})`
          : auditReason;
        const kicked = await resolved.createKick(row.community_id, subject, {
          reason: discordReason,
        });
        if (!kicked?.ok) {
          return {
            ok: false,
            error:
              (kicked?.error
                ? String(kicked.error)
                : `Kick of <@${subject}> failed with no cause recorded.`) +
              " — nobody was kicked.",
          };
        }
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
      return async () => {
        // #735 — open this case's HELP TICKET with the subject in it. NO
        // second ticket system: openTicketChannel IS the shipped pipeline
        // (subject = creator — that IS the member-add path; the referring
        // staff rides as openedByStaffId). That pipeline posts `reason`
        // VERBATIM into the member-visible open notice the subject reads —
        // the member-visible law is why the dispatcher requires/scrubs
        // `reason` and why the note-overlap scrub below runs BEFORE
        // anything opens. ZERO DMs anywhere: the open notice is the whole
        // member-facing surface.
        const ids = {
          communityId: row.community_id,
          guildId,
          subjectUserId: subject,
          caseId: row.case_id,
          action: act,
          actionRowId: row.id,
        };
        const reason = String(params.reason ?? "").trim();
        if (!reason) {
          return {
            ok: false,
            error:
              "The `ticket` action needs params.reason — the member-visible opening the subject reads in the ticket. Nothing was opened.",
          };
        }
        // COMMIT-TIME OVERLAP SCRUB (#735, decision 4's spirit): a reason
        // reproducing the subject's queued staff-note narrative would hand
        // them their own private note through the member-visible opening.
        if (ticketReasonDuplicatesNote(reason, queuedNoteNarrative)) {
          return {
            ok: false,
            error:
              `Refusing to open the case ticket: the member-visible reason reproduces <@${subject}>'s queued staff-note narrative — the opening would leak private staff-note text (#735 member-visible law). The staff note stands; the ticket was not opened.`,
          };
        }
        // Case ref for the success line — read BEFORE the open so a failed
        // lookup can never force a dishonest line on a ticket that exists.
        let caseRef = null;
        if (row.case_id != null) {
          try {
            const caseRowForRef = getAutomodCaseById(Number(row.case_id));
            if (caseRowForRef?.case_number != null) {
              caseRef = `A-${caseRowForRef.case_number}`;
            }
          } catch (err) {
            logFail("ticket case-ref read (display only)", ids, err);
          }
        }
        // THE RATE SLOT FIRST (#420 law): the subject IS the ticket
        // creator, so the shipped self-create limit applies to THEM — the
        // claim is SYNCHRONOUS, taken before the first await (two racing
        // commits can never double-open the subject's window away).
        let claim;
        try {
          claim = resolved.claimTicketRateSlot(row.community_id, subject);
        } catch (err) {
          logFail("ticket rate-slot claim", ids, err);
          return {
            ok: false,
            error: `Could not check the subject's ticket-create rate limit: ${err?.message || err} — nothing was opened.`,
          };
        }
        if (!claim?.ok) {
          const minutes = Number(claim?.minutes);
          const retryMinutes = Math.max(
            1,
            Math.ceil(Number(claim?.retryAfterMs ?? 0) / 60000),
          );
          return {
            ok: false,
            error:
              `Could not open the case ticket: <@${subject}> already opened a ticket inside the rate window — the ticket system allows one self-created ticket per ${Number.isFinite(minutes) ? minutes : "?"} minute(s); the next attempt can succeed in about ${retryMinutes} minute(s). The staff note for this case stands — the ticket was not opened.`,
          };
        }
        // Open through the REAL ticket pipeline. ANY throw: hand the EXACT
        // stamp back (a create that never happened never costs the subject
        // a window) and refuse with the THROWN message VERBATIM — the typed
        // BOT_PERMISSIONS / CHANNEL_CREATE causes ride formatChannelCreateError
        // and already name what staff must fix (rule 3: no invented generic).
        let opened;
        try {
          opened = await resolved.openCaseTicket({
            guildId,
            communityId: row.community_id,
            subjectUserId: subject,
            reason,
            // Referrer resolution (decision 3 participants): the harness
            // commit and the card's Approve arm both thread the case's
            // referrer here — they always supply it. A null belt (direct
            // executor call without a referral) still opens the ticket
            // subject + staff-role overwrites: never orphaned.
            openedByStaffId: referrerUserId ?? null,
          });
        } catch (err) {
          try {
            resolved.releaseTicketRateSlot(row.community_id, subject, claim.stamp);
          } catch (releaseErr) {
            // The slot ages out on its own; the OPEN cause is what staff
            // must see — the release failure is a log line, nothing more.
            logFail("ticket rate-slot release (open already failed)", ids, releaseErr);
          }
          return { ok: false, error: err?.message || String(err) };
        }
        // SUCCESS keeps the reservation (it ages out — only a FAILED open
        // hands the slot back, #420). This line is only reachable with a
        // real ticket + channel; it is never fabricated. The channel
        // MENTION is the case card's channel link (contract auto law); the
        // skipped-staff-role note is the shipped honest access report.
        const ticketNumber = opened?.ticket?.ticket_number ?? "?";
        const channelId = opened?.channel?.id != null ? String(opened.channel.id) : null;
        let result =
          `Opened ticket T-${ticketNumber} with <@${subject}>: ` +
          (channelId ? `<#${channelId}>` : "(channel id unrecorded)") +
          (caseRef ? ` (case ${caseRef})` : "") +
          ".";
        const skippedNote = formatStaffRoleAccessNote(opened?.skippedStaffRoles ?? []);
        if (skippedNote) result += skippedNote;
        return { ok: true, result };
      };

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
  readTimeoutCap,
  resolveActionMode,
  outcomeFromRow,
  MUTATING_ACTIONS,
  BREAKER_GATED_ACTIONS,
  // Delete tool (#734): the ONE target-reading law (canonical messages +
  // legacy single pair) shared by the handler and the case card.
  resolveDeleteTargets,
  // Ticket tool (#735): the commit-time note-overlap law (pure) + the ONE
  // normalization the scrub compares in.
  ticketReasonDuplicatesNote,
  normalizeNarrativeText,
};
