/**
 * Ban appeals — OUTCOME ENGINE (#773 §4 + §5 + §6) — the staff-decision side.
 *
 * Three entries, one law: the decision is the CLAIM. Every path starts with
 * `claimAppealOutcome` (`UPDATE … WHERE status='open'`, the resolveAutomodCase
 * idiom) — first decision wins, a losing click mutates NOTHING and answers
 * with the LIVE row's truth (`ALREADY_DECIDED` + the actual status). Once the
 * status leaves `open` the ferry stops structurally (ferry.js's status guard,
 * no side-channel flag), and nothing here has to touch the relay.
 *
 * ── Locked ORDER for grantClemency (issue §4, acceptance law) ──────────────
 *  1. claim 'granted'            — loser: specific already-decided reply,
 *                                  ZERO side effects (it never even reads
 *                                  the record for outbound).
 *  2. SPEND the cycle's welcome  — BEFORE any unban call. `claimWelcome` is
 *                                  the domain CAS (expired/unbanned rows);
 *                                  an ACTIVE row sits OUT of its domain on
 *                                  purpose (#772 law, pinned by the repo
 *                                  tests), so the spend completes through
 *                                  `recordWelcomeDmSent`, the shipped
 *                                  status-free belt stamp. Either way the
 *                                  flag leaves 0 BEFORE `unbanMember`
 *                                  fires: a racing GuildBanRemove settles
 *                                  the row and its welcome claim then LOSES
 *                                  — the generic #772 welcome-back DM is
 *                                  structurally unable to double-fire.
 *                                  Exactly ONE DM per clemency.
 *  3. unban                      — ONLY while the record read ACTIVE (a
 *                                  settled row means a NEWER cycle may own
 *                                  the ban — never unban against it).
 *                                  Reason: CLEMENCY_UNBAN_REASON. Discord
 *                                  10026 (NOT_BANNED) is TRUTH, not
 *                                  failure: the ban is already gone — the
 *                                  appeal is still GRANTED, the record
 *                                  settle is still attempted, the user
 *                                  still gets welcome + invite.
 *  4. record settle              — `finalizeUnban(id,'clemency_granted',
 *                                  reason)` CAS from active; a concurrent
 *                                  event/ticker settle WINS that CAS and
 *                                  this reports the live status honestly
 *                                  (events keep the record truthful).
 *  5. invite                     — guild.systemChannel ?? first text
 *                                  channel; permanent + unlimited policy is
 *                                  owned by outbound.createInvite (maxAge
 *                                  0 / maxUses 0 verified v14.27); policy +
 *                                  code audited as banAppeals.invite_created.
 *  6. ONE clemency DM            — invite + welcome copy; never the
 *                                  moderator identity, never case ids
 *                                  (§6). Delivery failure is logged with
 *                                  ids and NEVER echoed (K2).
 *  7. ticket close               — the SHARED close flow (softCloseTicket),
 *                                  best-effort with a warnings ledger; it
 *                                  can never fail a decided outcome.
 *  8. buttons disabled           — best-effort message edit (events.js
 *                                  idiom: update with components:[]),
 *                                  failure logged, non-fatal.
 *  9. audit                      — banAppeals.clemency_granted
 *                                  (+ invite_created at mint time).
 *
 * deny = claim 'denied' first (optional staff reason ≤ MAX_DENIAL_REASON) →
 * DM (denial + conversation ended; timed bans restate eligibility with
 * <t:F>/<t:R>; the staff note rides VERBATIM but markdown-ESCAPED inert) →
 * close → disable → audit. plainClose (the ChannelDelete neutral path, 07)
 * claims 'closed' ONLY while still open — a granted/denied appeal is a
 * no-op; the ban is untouched (zero ban_records writes, no welcome spend,
 * no invite) and the DM is the neutral "staff ended the conversation; the
 * ban stands" notice.
 *
 * Privacy law (§6, non-negotiable): every USER-side payload builder in this
 * file takes only guild name, expiry timestamps, the invite url, and the
 * staff-authored denial note — no moderator id, no automod case id, no
 * warning/staff-note bodies are ever reachable from these inputs. Audit
 * rows and ticket-channel notices are staff-side and carry the ids.
 *
 * Error contract (AGENTS.md rules 1/2/3/5/6): every entry never throws —
 * expected failures are `{ ok:false, code, error }` values with the SPECIFIC
 * cause; partial failures ride the `warnings` ledger and never claim total
 * success; every failure logs `[appeals]` with community/record/appeal/
 * user/ticket ids; DM failures are logged, never echoed. Services never
 * reply to a platform — the caller (07) renders the staff reply from the
 * rich facts returned here.
 *
 * Load posture (#699): requiring this module opens NO SQLite and no
 * db-touching feature module — the db facade, platform community API,
 * discord outbound, tickets/close and the markdown escaper are all
 * CALL-TIME requires; tests inject plain doubles through `deps`.
 */

// discord.js + core/theme are load-safe (banAppeals/ticket.js posture).
const {
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { tsFull, tsRelative } = require("../../core/theme");
const {
  LOG_PREFIX,
  AP_DENY_MODAL_PREFIX,
} = require("./constants");

/* ── Lazy module access (#699 law — every heavy seam at call time) ────────── */
const dbApi = () => require("../../db");
const communityApi = () => require("../../platform/community");
const outboundApi = () => require("../../platform/discord/outbound");
const closeApi = () => require("../tickets/close");
const escapeApi = () => require("./markdownEscape");
const auditApi = () => require("../../core/auditTrail");

/* ── Machine codes (ASSIGNED consts — the colon-literal object form trips
 * the env-parity SCREAMING-literal scan; banRecords/intake pin this law) ─── */

/** outbound.unbanMember's Discord 10026 branch (banService twin): the ban is
 * already gone — clemency still GRANTS (issue §4 "already-expired still DMs"). */
const CODE_NOT_BANNED = "NOT_BANNED";

const CODE_GRANTED = "GRANTED";
const CODE_DENIED = "DENIED";
const CODE_CLOSED = "CLOSED";
const CODE_ALREADY_DECIDED = "ALREADY_DECIDED";
const CODE_NO_APPEAL = "NO_APPEAL";
const CODE_NOT_OPEN = "NOT_OPEN";
const CODE_NO_RECORD = "NO_RECORD";
const CODE_CLAIM_FAILED = "CLAIM_FAILED";
const CODE_UNBAN_FAILED = "UNBAN_FAILED";
const CODE_REASON_TOO_LONG = "REASON_TOO_LONG";
const CODE_NO_TARGET = "NO_TARGET";
const CODE_INTERNAL = "INTERNAL";

/** The stable decision vocabulary 07 renders on (frozen, single source). */
const OUTCOME_CODES = Object.freeze({
  GRANTED: CODE_GRANTED,
  DENIED: CODE_DENIED,
  CLOSED: CODE_CLOSED,
  ALREADY_DECIDED: CODE_ALREADY_DECIDED,
  NO_APPEAL: CODE_NO_APPEAL,
  NOT_OPEN: CODE_NOT_OPEN,
  NO_RECORD: CODE_NO_RECORD,
  CLAIM_FAILED: CODE_CLAIM_FAILED,
  UNBAN_FAILED: CODE_UNBAN_FAILED,
  REASON_TOO_LONG: CODE_REASON_TOO_LONG,
  NO_TARGET: CODE_NO_TARGET,
  INTERNAL: CODE_INTERNAL,
});

/* ── Audit vocabulary (issue §5; sibling of intake's banAppeals.file) ─────── */
const AUDIT_ACTION_CLEMENCY = "banAppeals.clemency_granted";
const AUDIT_ACTION_DENIED = "banAppeals.denied";
const AUDIT_ACTION_CLOSED = "banAppeals.closed";
const AUDIT_ACTION_INVITE = "banAppeals.invite_created";

/**
 * The Discord-side unban reason for clemency (audit-log facing, guild-side
 * copy — never a user DM). Deliberately names WHAT happened, not WHO: the
 * attribution lives in the audit row (actorUserId), not in the reason.
 */
const CLEMENCY_UNBAN_REASON = "Ban appeal — clemency granted by staff";

/** Denial modal chrome (07 wires `ap:deny:m:<id>` submit + readModalText). */
const MODAL_DENY_TITLE = "Deny this appeal";
const MODAL_LABEL_REASON = "Reason (optional)";
const MODAL_FIELD_REASON = "reason";

/** Statuses a decided appeal can carry (mirrors the repo's APPEAL_OUTCOMES —
 * local copy keeps this module's already-decided copy SQLite-free). */
const DECIDED_STATUSES = new Set(["granted", "denied", "closed"]);

/**
 * Text-like guild channel types for the invite fallback (duck-friendly: the
 * offline harness and plain-object doubles carry the numeric or the name).
 */
const TEXTISH_CHANNEL_TYPES = new Set([0, "GuildText", "Text"]);

/* ── Tiny helpers ─────────────────────────────────────────────────────────── */

/** Trim-to-null ("" is absent, never quoted). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Safe positive-integer id gate (intake law: garbage dies at the gate). */
function positiveIntOrNull(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Console-like logger selection (banService pickLog posture). */
function pickLog(deps) {
  const given = deps && typeof deps.log === "object" ? deps.log : null;
  return {
    info: (...args) =>
      (given?.info ?? given?.log ?? console.info.bind(console))(...args),
    warn: (...args) =>
      (given?.warn ?? given?.error ?? given?.log ?? console.warn.bind(console))(...args),
    error: (...args) =>
      (given?.error ?? given?.log ?? console.error.bind(console))(...args),
  };
}

/** One `[appeals]` line with the FULL id set (issue §6 / rule 2). */
function logWith(log, level, what, ids, cause) {
  const line =
    `${LOG_PREFIX} ${what} community=${ids.community ?? "?"} record=${ids.record ?? "?"}` +
    ` appeal=${ids.appeal ?? "?"} user=${ids.user ?? "?"} ticket=${ids.ticket ?? "?"}`;
  const sink = level === "error" ? log.error : log.warn;
  if (cause === undefined || cause === null) sink(`${line}: no cause reported`);
  else sink(`${line}:`, cause?.message || cause);
}

/** ids carrier from an appeal row + the ban's user (never nulls the line). */
function idsOf(appeal, extra = {}) {
  return {
    community: appeal?.community_id ?? "?",
    record: appeal?.ban_record_id ?? "?",
    appeal: appeal?.id ?? "?",
    user: extra.userId ?? "?",
    ticket: appeal?.ticket_channel_id ?? "?",
  };
}

/** Failure result builder — code is ASSIGNED (env-parity law), never literal. */
function fail(code, error, extra = {}) {
  const out = { ok: false, code, error, ...extra };
  return out;
}

/** Ban ref in display form (ticket.js / banService twin). */
function banRef(record) {
  return `B-${record?.ban_number ?? "?"}`;
}

/** Guild name belt (dmCopy guildMention law: never an empty bold run). */
function guildMention(guildName) {
  return `**${String(guildName ?? "").trim() || "the server"}**`;
}

/**
 * The specific ALREADY_DECIDED sentence (repo law: the loser surfaces the
 * LIVE row's truth — a decided status names the decision, anything else
 * names the state; never a generic).
 */
function alreadyDecidedError(liveStatus) {
  const s = String(liveStatus ?? "unknown");
  if (DECIDED_STATUSES.has(s)) {
    return (
      `**Appeal:** this appeal was already decided as \`${s}\` — first ` +
      "decision wins, so this click changed nothing."
    );
  }
  return (
    `**Appeal:** this appeal is no longer open (its status is \`${s}\`) — ` +
    "nothing was decided by this click."
  );
}

/* ── USER-side copy builders (issue §4; exported for 07 + docs + units) ─────
 * `**Label:** value` law (#471 H2-13), allowedMentions { parse: [] } on
 * every payload (dmCopy DM law). The parameters ARE the privacy boundary:
 * only guild name, expiry stamps, invite url and the staff-authored denial
 * note can enter user-visible text — moderator ids, case ids and
 * warning/staff-note bodies are structurally unreachable from here (§6). */

/**
 * The ONE clemency DM (#773 §4): ban lifted + permanent re-join invite.
 * When the invite could not be minted the DM says so SPECIFICALLY and tells
 * the user the actionable alternative (staff can send one) — never a fake
 * link, never a generic.
 *
 * @param {object} opts
 * @param {string|null} [opts.guildName]
 * @param {string|null} [opts.inviteUrl]  the fresh invite url (absent on mint failure)
 * @param {boolean} [opts.inviteError]    true when the mint failed (names it)
 * @returns {{ content: string, allowedMentions: { parse: string[] } }}
 */
function buildClemencyDm({ guildName, inviteUrl, inviteError } = {}) {
  const guild = guildMention(guildName);
  const inviteLine = inviteUrl
    ? `**Invite:** ${inviteUrl} — it does not expire; use it any time to rejoin.`
    : inviteError
      ? "**Invite:** a re-join invite could not be created right now — a " +
        "staff member can send you one directly."
      : null;
  const lines = [
    `**Appeal:** granted — your ban in ${guild} has been lifted. ` +
      "You're welcome back.",
  ];
  if (inviteLine) lines.push(inviteLine);
  lines.push(
    "If you'd like to talk about what happened, any staff member is happy " +
      "to help.",
  );
  return {
    content: lines.join("\n"),
    allowedMentions: { parse: [] },
  };
}

/**
 * The denial-reason modal (`ap:deny:m:<appealId>` — the `ap:deny:` button
 * opens it; 07 reads the field with the shipped tolerant reader). OPTIONAL
 * short note; the cap mirrors the repository's MAX_DENIAL_REASON (lazy read,
 * buildAppealModal posture — the repository re-checks at claim time). The
 * input is a Paragraph because a Short input hard-caps at 100 chars and
 * could never present the 1000-char cap (verified v14 builder range).
 *
 * @param {number|string} appealId digits-only appeal id (customId payload)
 * @param {object} [opts]
 * @param {number} [opts.maxChars] cap override (tests)
 * @returns {ModalBuilder}
 */
function buildDenyReasonModal(appealId, opts = {}) {
  const maxChars =
    opts?.maxChars != null
      ? Number(opts.maxChars)
      : require("../../db").MAX_DENIAL_REASON;
  // Paragraph style is a PLATFORM necessity, not a style pick: @discordjs/
  // builders validates setMaxLength against the CURRENT style
  // (Short: max 100, Paragraph: max 4000), so a Short input could never
  // present the repository's 1000-char denial cap. Style set BEFORE
  // setMaxLength, exactly as intake.js buildAppealModal does.
  const reason = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_REASON)
    .setLabel(`${MODAL_LABEL_REASON} — max ${maxChars} characters`)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(maxChars)
    .setPlaceholder("Optional note added to the denial DM (kept private to this appeal)");
  return new ModalBuilder()
    .setCustomId(`${AP_DENY_MODAL_PREFIX}${appealId}`)
    .setTitle(MODAL_DENY_TITLE)
    .addComponents(new ActionRowBuilder().addComponents(reason));
}

/**
 * The denial DM (#773 §4): denied + conversation ended; timed bans RESTATE
 * eligibility with both timestamp flavours (`<t:F> (<t:R>)`, dmCopy law);
 * permanent bans get the no-eligibility phrasing. The optional staff note is
 * appended VERBATIM but markdown-escaped so planted markup renders inert
 * (§6's escape law extends to every user-visible interpolation).
 *
 * @param {object} opts
 * @param {string|null} [opts.guildName]
 * @param {number|null} [opts.expiresAtMs] record expiry; null/absent → permanent
 * @param {string|null} [opts.denialReason] the stored staff note (optional)
 * @returns {{ content: string, allowedMentions: { parse: string[] } }}
 */
function buildDenyDm({ guildName, expiresAtMs, denialReason } = {}) {
  const guild = guildMention(guildName);
  const e = Number(expiresAtMs);
  const timed = Number.isFinite(e) && e > 0;
  const lines = [
    `**Appeal:** denied — staff reviewed your appeal in ${guild} and the ` +
      "ban stands.",
    timed
      ? `**Eligible again:** ${tsFull(e)} (${tsRelative(e)}) — you may ` +
        "rejoin after that."
      : "**Expiry:** none — this ban has no set end date; staff may lift it " +
        "at their discretion.",
  ];
  const note = optionalText(denialReason);
  if (note) lines.push(`**Staff note:** ${escapeApi().escapeInline(note)}`);
  lines.push(
    "**Conversation:** this appeal's staff conversation is now closed — the " +
      "relay has ended and no further messages will be carried for this ban.",
  );
  return {
    content: lines.join("\n"),
    allowedMentions: { parse: [] },
  };
}

/**
 * The plain-close DM (#773 §4): NEUTRAL. No decision is claimed, the ban is
 * stated unchanged — exactly the issue's "staff ended the conversation; the
 * ban stands".
 *
 * @param {object} opts
 * @param {string|null} [opts.guildName]
 * @returns {{ content: string, allowedMentions: { parse: string[] } }}
 */
function buildPlainCloseDm({ guildName } = {}) {
  const guild = guildMention(guildName);
  return {
    content:
      `**Appeal:** staff ended the conversation about your ban appeal in ` +
      `${guild} without a decision — the ban stands and the relay is closed.\n` +
      "The ban itself was not changed by this. If you want to raise " +
      "anything, you can contact a staff member another way.",
    allowedMentions: { parse: [] },
  };
}

/* ── Seam resolution (defaults = shipped platform surfaces; deps override) ── */

/** The outbound handle: injected double → getDiscordOutbound(deps.client). */
function resolveOutbound(deps) {
  if (deps.outbound) return deps.outbound;
  const client = deps.client ?? null;
  if (!client) return null;
  try {
    return outboundApi().getDiscordOutbound(client);
  } catch (err) {
    return { __error: err?.message || String(err) };
  }
}

/**
 * One seam slot: explicit deps fn → outbound method → a {ok:false} value fn
 * (missing surface is a REPORTED failure, never a crash — rule 6).
 */
function seam(deps, name, outbound, what) {
  if (typeof deps?.[name] === "function") return deps[name];
  if (typeof outbound?.[name] === "function") {
    return (...args) => outbound[name](...args);
  }
  const cause = outbound?.__error
    ? `the Discord outbound could not be built (${outbound.__error})`
    : "no outbound surface is wired for this outcome";
  return async () => ({ ok: false, error: `${what}: ${cause}` });
}

/** The appeal row read (lazy facade default). */
function appealReader(deps) {
  return (
    deps.getAppealById || ((id) => dbApi().getAppealById(id))
  );
}

/** Ban record read (lazy facade default; never throws at the caller). */
function readBanRecord(deps, recordId, log, ids) {
  const fn = deps.getBanRecord || ((id) => dbApi().getBanRecord(id));
  try {
    return fn(recordId) ?? null;
  } catch (err) {
    logWith(log, "error", "ban record read failed", ids, err);
    return null;
  }
}

/** Community row (platform + external guild id) — read-safe, null on trouble. */
function readCommunity(communityId) {
  try {
    return communityApi().getCommunityById(Number(communityId)) ?? null;
  } catch {
    return null;
  }
}

/**
 * The outcome guild (ticket.js resolution chain, throw-proof): injected →
 * cache → fetch. Null means invite/staff-notice legs degrade to warnings —
 * never an outcome failure (the unban/DM legs ride outbound, not this).
 */
async function resolveOutcomeGuild(communityId, deps) {
  if (deps.guild) return deps.guild;
  const community = readCommunity(communityId);
  if (!community || community.platform !== "discord") return null;
  const guildId = String(community.externalGuildId ?? "");
  if (guildId === "") return null;
  const client = deps.client ?? null;
  try {
    const cached = client?.guilds?.cache?.get?.(guildId) ?? null;
    if (cached) return cached;
    if (typeof client?.guilds?.fetch === "function") {
      return (await client.guilds.fetch(guildId)) ?? null;
    }
  } catch {
    return null; // decorative read — invite falls to its own specific warning
  }
  return null;
}

/* ── Welcome suppression (the structural one-DM guarantee) ──────────────────
 * claimWelcome is the shipped domain CAS but sits deliberately OUTSIDE
 * 'active' rows (#772 law, pinned by test/ban-records-repo.test.js — the
 * domain is NOT widened here). recordWelcomeDmSent is the shipped status-
 * free belt stamp ("paths that delivered without a claim"); spending
 * THROUGH the pair leaves welcome_dm_sent=1 on every readable row state
 * BEFORE the unban, so:
 *   - a racing GuildBanRemove (manual-beats-ticker CAS wins the status)
 *     attempts its welcome and LOSES the claim → no DM;
 *   - the expiry ticker's finalize/claim loses the status CAS or the flag →
 *     no DM;
 *   - the rejoin listener never sees a pending row it could park from.
 * The final READ is the truth: spent=true only when the row really says 1.
 */
function spendWelcomeClaim(recordId, deps, log, ids) {
  const claimFn = deps.claimWelcome || ((id) => dbApi().claimWelcome(id));
  const stampFn =
    deps.recordWelcomeDmSent || ((id) => dbApi().recordWelcomeDmSent(id));
  const spentNow = () => {
    try {
      const read = deps.getBanRecord || ((id) => dbApi().getBanRecord(id));
      return Number(read(recordId)?.welcome_dm_sent) === 1;
    } catch {
      return false;
    }
  };

  let claim = null;
  let claimError = null;
  try {
    claim = claimFn(recordId);
  } catch (err) {
    claimError = err?.message || String(err);
  }
  if (claim && claim.ok === true && claim.won === true) {
    return { spent: true, via: "claimWelcome", error: null };
  }
  if (claim && claim.ok === true && Number(claim.record?.welcome_dm_sent) === 1) {
    return { spent: true, via: "already", error: null };
  }
  if (claim && claim.ok !== true) {
    claimError = claim?.error ?? "claimWelcome returned no result";
  }

  // Not won (ACTIVE row, or a claim error): finish with the belt stamp.
  let stamped = false;
  try {
    stamped = stampFn(recordId) === true;
  } catch (err) {
    claimError = `${claimError ? `${claimError}; ` : ""}stamp failed: ${err?.message || err}`;
  }
  const spent = stamped || spentNow();
  if (!spent) {
    logWith(
      log,
      "error",
      "welcome suppression FAILED — a duplicate welcome DM cannot be ruled out",
      ids,
      claimError || "neither the claim nor the belt stamp landed",
    );
  }
  return { spent, via: "welcome_stamp", error: claimError };
}

/* ── Record settle (clemency only) — CAS truth, never a forced write ──────── */
function settleRecordClemency(recordId, deps, log, ids) {
  const fn =
    deps.finalizeUnban ||
    ((id, status, reason, opts) => dbApi().finalizeUnban(id, status, reason, opts));
  try {
    const res = fn(recordId, "clemency_granted", CLEMENCY_UNBAN_REASON, {
      nowMs: deps.nowMs,
    });
    if (!res || res.ok !== true) {
      const error = res?.error || "finalizeUnban returned no result";
      logWith(log, "error", "record settle (clemency) failed", ids, error);
      return { attempted: true, won: false, status: null, error };
    }
    const status = res.record?.status ?? "clemency_granted";
    if (res.won !== true) {
      // A concurrent event/ticker settle won the status CAS — events keep
      // the record truthful; this reports the LIVE status, never overwrites.
      logWith(
        log,
        "warn",
        `record settle lost — kept the live truth (${status})`,
        ids,
        null,
      );
    }
    return { attempted: true, won: res.won === true, status, error: null };
  } catch (err) {
    logWith(log, "error", "record settle (clemency) threw", ids, err);
    return { attempted: true, won: false, status: null, error: String(err?.message || err) };
  }
}

/* ── Invite channel pick (pure; exported for units) ───────────────────────── */
/**
 * systemChannel first (staff's canonical channel), else the FIRST text-ish
 * channel in cache order. Null = nothing mintable (specific warning rides).
 */
function pickInviteChannel(guild) {
  const systemId = optionalText(guild?.systemChannel?.id ?? guild?.systemChannelId);
  if (systemId) return systemId;
  const cache = guild?.channels?.cache;
  const list = Array.isArray(cache)
    ? cache
    : typeof cache?.values === "function"
      ? [...cache.values()]
      : [];
  for (const channel of list) {
    const id = optionalText(channel?.id);
    if (!id) continue;
    if (TEXTISH_CHANNEL_TYPES.has(channel?.type)) return id;
  }
  return null;
}

/* ── Ticket close (the SHARED flow, best-effort) ────────────────────────────
 * softCloseTicket runs the shipped close (mark closed + strip access + the
 * staff-side close notice + requester DM — for appeal tickets the requester
 * is the owning moderator, NEVER the banned user, who was never a party).
 * EVERY leg is individually guarded: an unreachable channel or a throwing
 * pipeline rides the warnings ledger and never fails the decided outcome
 * (issue §4 + rule 5). */
async function closeAppealTicket({
  appeal,
  communityId,
  closedBy,
  closeReason,
  deps,
  log,
  ids,
}) {
  const warnings = [];
  const channelText = optionalText(appeal?.ticket_channel_id);
  if (!channelText) {
    // openAppealTicket attaches the channel BEFORE opening — an open appeal
    // without a channel is the orphan case ticket.js logs; nothing to close.
    warnings.push("This appeal never received a staff ticket channel — nothing to close.");
    return { closed: false, warnings };
  }

  // Channel: injected duck → client.channels.fetch (a ChannelDelete path
  // lands here with the channel already gone — that is EXPECTED, noted).
  let channel = deps.channel ?? null;
  if (!channel) {
    try {
      channel = (await deps.client?.channels?.fetch?.(channelText)) ?? null;
    } catch (err) {
      channel = null;
      const note = `Ticket channel ${channelText} could not be loaded (${err?.message || err}) — close was skipped.`;
      warnings.push(note);
      logWith(log, "warn", "ticket close skipped (channel unreachable)", ids, err);
      return { closed: false, warnings };
    }
  }
  if (!channel) {
    const note = `Ticket channel ${channelText} no longer exists — close was skipped (channel already deleted).`;
    warnings.push(note);
    return { closed: false, warnings };
  }

  // Ticket row by channel (shared repo read; default is the lazy facade).
  let ticket = null;
  try {
    const read =
      deps.getTicketByChannel ||
      ((c, ch) => dbApi().getTicketByChannel(c, ch));
    ticket = read(communityId, channelText) ?? null;
  } catch (err) {
    logWith(log, "error", "ticket row read failed", ids, err);
    warnings.push(`Could not read the ticket row: ${err?.message || err}`);
    return { closed: false, warnings };
  }
  if (!ticket) {
    warnings.push(
      `No ticket row is bound to channel ${channelText} — nothing was closed.`,
    );
    return { closed: false, warnings };
  }
  if (String(ticket.status) !== "open") {
    return { closed: false, alreadyClosed: true, warnings };
  }

  const softClose =
    deps.softCloseTicket || ((opts) => closeApi().softCloseTicket(opts));
  try {
    const res = await softClose({
      client: deps.client ?? null,
      channel,
      ticket,
      closedBy: optionalText(closedBy) ?? "ban-appeals",
      closeReason,
    });
    if (Array.isArray(res?.warnings)) warnings.push(...res.warnings);
    return { closed: true, warnings };
  } catch (err) {
    const note = `Ticket close failed: ${err?.message || err}`;
    warnings.push(note);
    logWith(log, "error", "softCloseTicket threw", ids, err);
    return { closed: false, warnings };
  }
}

/* ── Header button disable (events/buttons.js:183 idiom, best-effort) ───────
 * In-ticket flow: the interaction's OWN message is the header —
 * interaction.update({components:[]}) strips the decided buttons (the
 * embeds/content survive the patch). No interaction (plain-close): the
 * injected header duck's edit, else a logged skip. NEVER fatal. */
async function disableOutcomeButtons({ deps, log, ids }) {
  const interaction = deps.interaction ?? null;
  if (interaction && typeof interaction.update === "function") {
    try {
      await interaction.update({ components: [] });
      return { disabled: true, note: null };
    } catch (err) {
      const note = `Header buttons could not be disabled: ${err?.message || err}`;
      logWith(log, "warn", "outcome button disable failed (non-fatal)", ids, err);
      return { disabled: false, note };
    }
  }
  const header = deps.headerMessage ?? null;
  if (header && typeof header.edit === "function") {
    try {
      await header.edit({ components: [] });
      return { disabled: true, note: null };
    } catch (err) {
      const note = `Header buttons could not be disabled: ${err?.message || err}`;
      logWith(log, "warn", "outcome header edit failed (non-fatal)", ids, err);
      return { disabled: false, note };
    }
  }
  const note =
    "Header buttons were not disabled (no message reference reached this outcome — " +
    "a later click answers 'already decided').";
  logWith(log, "warn", "outcome button disable skipped", ids, note);
  return { disabled: false, note };
}

/* ── Audit (fail-safe by contract — auditTrail never breaks the flow) ─────── */
function outcomeAudit(deps, entry, log, ids) {
  try {
    const record =
      deps.recordSystemAudit ||
      ((e) => auditApi().recordSystemAudit(e));
    record(entry);
    return true;
  } catch (err) {
    logWith(log, "error", `outcome audit failed (action=${entry?.action})`, ids, err);
    return false;
  }
}

/** Shared decision ids for the staff-facing notes + audit details. */
function outcomeFacts(appeal, record) {
  return {
    appealId: Number(appeal?.id),
    communityId: Number(appeal?.community_id),
    banRecordId: Number(appeal?.ban_record_id),
    banNumber: record ? banRef(record) : "B-?",
    userId: String(record?.user_id ?? ""),
  };
}

/** Best-effort staff-side note in the ticket channel (rule 5: partial
 * failures VISIBLE to the staff who own the ticket; never user-facing). */
async function postTicketWarnings({ appeal, warnings, deps, log, ids }) {
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  const channelId = optionalText(appeal?.ticket_channel_id);
  if (!channelId) return;
  const outbound = resolveOutbound(deps);
  const send = seam(deps, "sendChannel", outbound, "sendChannel");
  try {
    const res = await send(channelId, {
      content:
        `**Outcome notes (appeal ${appeal?.id ?? "?"}):** ` +
        warnings.join(" · "),
      allowedMentions: { parse: [] },
    });
    if (!res || res.ok !== true) {
      logWith(log, "warn", "ticket outcome note not posted", ids, res?.error || "no result");
    }
  } catch (err) {
    logWith(log, "warn", "ticket outcome note post threw (non-fatal)", ids, err);
  }
}

/* ══ 1. grantClemency ═══════════════════════════════════════════════════════ */

/**
 * Grant clemency on an OPEN appeal (the `ap:clemency:` winner path).
 *
 * @param {object} params
 * @param {number|string} params.appealId
 * @param {string|null} [params.staffUserId] acting staff id (audit + claim)
 * @param {object} [params.deps] seams: client, outbound, guild, guildName,
 *   channel (ticket duck), interaction | headerMessage (button disable),
 *   getAppealById, getBanRecord, claimAppealOutcome, claimWelcome,
 *   recordWelcomeDmSent, finalizeUnban, unbanMember, createInvite, sendDm,
 *   sendChannel, getTicketByChannel, softCloseTicket, recordSystemAudit,
 *   log, nowMs
 * @returns {Promise<object>} rich facts, never rejects (see OUTCOME_CODES)
 */
async function grantClemency({ appealId, staffUserId = null, deps = {} } = {}) {
  const d = deps || {};
  const log = pickLog(d);
  const numId = positiveIntOrNull(appealId);
  let appeal = null;
  let record = null;
  const ids = idsOf(appeal, { userId: record?.user_id });

  try {
    if (numId == null) return fail(CODE_NO_APPEAL, "No such ban appeal.");
    appeal = appealReader(d)(numId);
    if (!appeal) return fail(CODE_NO_APPEAL, "No such ban appeal.");
    Object.assign(ids, idsOf(appeal, { userId: record?.user_id }));

    const communityId = Number(appeal.community_id);

    // ── 1. THE CLAIM (first decision wins; a loser mutates NOTHING) ────────
    const claimFn =
      d.claimAppealOutcome ||
      ((id, opts) => dbApi().claimAppealOutcome(id, opts));
    const claim = await claimFn(appeal.id, {
      status: "granted",
      decidedBy: optionalText(staffUserId),
      nowMs: d.nowMs,
    });
    if (!claim || claim.ok !== true) {
      const error = claim?.error || "claimAppealOutcome returned no result";
      logWith(log, "error", "clemency claim failed", ids, error);
      return fail(CODE_CLAIM_FAILED, error, { appealId: numId, communityId });
    }
    if (claim.won !== true) {
      const live = claim.appeal ?? null;
      const liveStatus = live?.status ?? "unknown";
      const error = alreadyDecidedError(liveStatus);
      logWith(log, "warn", `clemency click LOST the claim (live=${liveStatus})`, ids, null);
      return fail(CODE_ALREADY_DECIDED, error, {
        appealId: numId,
        communityId,
        liveStatus,
      });
    }
    logWith(log, "info", "clemency claim WON — executing the outcome", ids, null);

    // ── the ban record behind the decision (FK-anchored; read for truth) ───
    record = readBanRecord(d, appeal.ban_record_id, log, ids);
    Object.assign(ids, idsOf(appeal, { userId: record?.user_id }));
    const facts = outcomeFacts(appeal, record);
    if (!record) {
      // FK surprise (rows never vanish under the 075 FK). The decision IS
      // granted — report that honestly with everything else impossible.
      const error =
        "The ban record behind this appeal no longer exists — the appeal is " +
        "marked granted, but no unban, invite, or DM could be run.";
      logWith(log, "error", "clemency granted but ban record MISSING", ids, error);
      outcomeAudit(
        d,
        {
          action: AUDIT_ACTION_CLEMENCY,
          communityId,
          targetType: "ban_appeal",
          targetId: String(appeal.id),
          actorUserId: optionalText(staffUserId),
          details: {
            ban_record_id: appeal.ban_record_id,
            record_missing: true,
          },
        },
        log,
        ids,
      );
      return fail(CODE_NO_RECORD, error, {
        ...facts,
        decision: "granted",
        liveStatus: "granted",
      });
    }

    const outbound = resolveOutbound(d);
    const warnings = [];

    // ── 2. SPEND the welcome BEFORE any unban (structural one-DM law) ─────
    const welcome = spendWelcomeClaim(record.id, d, log, ids);
    if (!welcome.spent) {
      warnings.push(
        "Welcome-DM suppression could not be recorded — a generic welcome " +
          "notice may still follow this cycle.",
      );
    }

    // ── 3. the unban (only against an ACTIVE record) ───────────────────────
    const recordActive = String(record.status) === "active";
    let unban = { attempted: false, ok: true, notBanned: false, error: null };
    if (recordActive) {
      const unbanFn = seam(d, "unbanMember", outbound, "unbanMember");
      let res = null;
      try {
        res = await unbanFn(communityId, String(record.user_id), CLEMENCY_UNBAN_REASON);
      } catch (err) {
        res = { ok: false, error: err?.message || String(err) };
      }
      if (res?.ok === true) {
        unban = { attempted: true, ok: true, notBanned: false, error: null };
      } else if (res?.code === CODE_NOT_BANNED) {
        // 10026: the ban is already gone — TRUTH, not failure. Still GRANT
        // (issue §4: clemency on an already-expired ban still runs the DM).
        unban = { attempted: true, ok: true, notBanned: true, error: null };
        logWith(log, "info", "unban answered NOT_BANNED — ban already gone, still granting", ids, null);
      } else {
        unban = {
          attempted: true,
          ok: false,
          notBanned: false,
          error: res?.error || "unbanMember returned no result",
        };
      }
    } else {
      logWith(
        log,
        "info",
        `record already settled (${record.status}) — no unban call (a newer cycle may own the ban)`,
        ids,
        null,
      );
    }

    // ── hard unban failure: decision stands, execution did NOT ─────────────
    if (!unban.ok) {
      logWith(log, "error", "clemency unban FAILED — no invite, no DM, ticket kept open", ids, unban.error);
      warnings.push(`The Discord unban failed: ${unban.error}`);
      outcomeAudit(
        d,
        {
          action: AUDIT_ACTION_CLEMENCY,
          communityId,
          targetType: "ban_appeal",
          targetId: String(appeal.id),
          actorUserId: optionalText(staffUserId),
          details: {
            ban_record_id: record.id,
            ban_number: record.ban_number,
            subject_user_id: record.user_id,
            unban_failed: true,
            unban_error: unban.error,
          },
        },
        log,
        ids,
      );
      await postTicketWarnings({ appeal, warnings, deps: d, log, ids });
      return fail(CODE_UNBAN_FAILED, unban.error, {
        ...facts,
        decision: "granted",
        liveStatus: "granted",
        welcome,
        unban,
        recordStatus: record.status,
        ticketClosed: false,
        warnings,
      });
    }

    // ── 4. record settle (CAS; the live row wins a race and is REPORTED) ───
    let recordSettled = { attempted: false, won: false, status: record.status, error: null };
    if (recordActive) {
      recordSettled = settleRecordClemency(record.id, d, log, ids);
      if (recordSettled.error) {
        warnings.push(`Record settle failed: ${recordSettled.error}`);
      } else if (recordSettled.won !== true) {
        warnings.push(
          `The ban record was settled concurrently as \`${recordSettled.status}\` — kept truthful.`,
        );
      }
    }

    // ── 5. the re-join invite (policy + code audited) ──────────────────────
    const guild = await resolveOutcomeGuild(communityId, d);
    const guildName = optionalText(d.guildName) ?? optionalText(guild?.name);
    const inviteChannelId = optionalText(d.inviteChannelId) ?? pickInviteChannel(guild);
    const invite = { created: false, url: null, code: null, channelId: inviteChannelId, error: null };
    if (!inviteChannelId) {
      invite.error =
        "no system channel and no text channel is visible to mint the invite in";
      warnings.push(`Invite not created: ${invite.error}.`);
    } else {
      const inviteFn = seam(d, "createInvite", outbound, "createInvite");
      let res = null;
      try {
        res = await inviteFn(communityId, inviteChannelId, {
          reason: `Ban appeal — clemency granted (appeal ${appeal.id})`,
        });
      } catch (err) {
        res = { ok: false, error: err?.message || String(err) };
      }
      if (res?.ok === true && optionalText(res.invite?.code)) {
        invite.created = true;
        invite.code = String(res.invite.code);
        invite.url = res.invite.url ?? `https://discord.gg/${invite.code}`;
        // Policy row (issue §5): the minted channel + the pinned policy +
        // the code, staff-side audit only.
        outcomeAudit(
          d,
          {
            action: AUDIT_ACTION_INVITE,
            communityId,
            targetType: "ban_appeal",
            targetId: String(appeal.id),
            actorUserId: optionalText(staffUserId),
            details: {
              ban_record_id: record.id,
              channel_id: inviteChannelId,
              max_age: 0, // pinned policy: PERMANENT (outbound owns the call shape)
              max_uses: 0, // pinned policy: unlimited
              unique: false,
              invite_code: invite.code,
            },
          },
          log,
          ids,
        );
      } else {
        invite.error = res?.error || "createInvite returned no result";
        warnings.push(`Invite not created: ${invite.error}.`);
        logWith(log, "error", "clemency invite mint failed", ids, invite.error);
      }
    }

    // ── 6. the ONE clemency DM (welcome + invite; K2 on failure) ───────────
    let dmDelivered = false;
    let dmError = null;
    const sendDm = seam(d, "sendDm", outbound, "sendDm");
    try {
      const res = await sendDm(
        String(record.user_id),
        buildClemencyDm({
          guildName,
          inviteUrl: invite.url,
          inviteError: !invite.created,
        }),
      );
      dmDelivered = res?.ok === true;
      if (!dmDelivered) dmError = res?.error || "sendDm returned no result";
    } catch (err) {
      dmError = err?.message || String(err);
    }
    if (!dmDelivered) {
      // K2: logged with ids, never echoed to any channel or the staff reply body.
      logWith(log, "error", "clemency DM failed", ids, dmError);
    }

    // ── 7. ticket close via the SHARED flow (best-effort, ledger) ──────────
    const close = await closeAppealTicket({
      appeal,
      communityId,
      closedBy: optionalText(staffUserId),
      closeReason: "Ban appeal decided — clemency granted",
      deps: d,
      log,
      ids,
    });
    warnings.push(...close.warnings);

    // ── 8. header buttons disabled (best-effort) ───────────────────────────
    const buttons = await disableOutcomeButtons({ deps: d, log, ids });
    if (buttons.note) warnings.push(buttons.note);

    // ── 9. the outcome audit row (all facts in; staff-side ids OK) ─────────
    outcomeAudit(
      d,
      {
        action: AUDIT_ACTION_CLEMENCY,
        communityId,
        targetType: "ban_appeal",
        targetId: String(appeal.id),
        actorUserId: optionalText(staffUserId),
        details: {
          ban_record_id: record.id,
          ban_number: record.ban_number,
          subject_user_id: record.user_id,
          record_status: recordSettled.status ?? record.status,
          not_banned: unban.notBanned,
          welcome_spent: welcome.spent,
          invite_created: invite.created,
        },
      },
      log,
      ids,
    );

    await postTicketWarnings({ appeal, warnings, deps: d, log, ids });

    return {
      ok: true,
      code: CODE_GRANTED,
      ...facts,
      recordStatus: recordSettled.status ?? record.status,
      recordSettled,
      welcome,
      unban,
      invite,
      dmDelivered,
      // surfaced for the caller's log line only (banUser warnings[] law) —
      // never echoed into channel copy:
      dmError,
      ticketClosed: close.closed,
      ticketAlreadyClosed: close.alreadyClosed === true,
      closeWarnings: close.warnings,
      buttonsDisabled: buttons.disabled,
      warnings,
    };
  } catch (err) {
    const error = `Could not grant clemency (appeal ${numId ?? "?"}): ${err?.message || err}`;
    logWith(log, "error", "clemency outcome errored", ids, err);
    return fail(CODE_INTERNAL, error, { appealId: numId });
  }
}

/* ══ 2. deny ════════════════════════════════════════════════════════════════ */

/**
 * Deny an OPEN appeal (the `ap:deny:m:` submit winner). Claim FIRST, then
 * DM (eligibility restated for timed bans, staff note escaped-inert), close
 * the ticket, disable the header, audit. The ban is NEVER touched here.
 *
 * @param {object} params
 * @param {number|string} params.appealId
 * @param {string|null} [params.staffUserId]
 * @param {string|null} [params.reason] optional short staff note (≤ cap)
 * @param {object} [params.deps] same seam family as grantClemency
 * @returns {Promise<object>} never rejects
 */
async function deny({
  appealId,
  staffUserId = null,
  reason = null,
  deps = {},
} = {}) {
  const d = deps || {};
  const log = pickLog(d);
  const numId = positiveIntOrNull(appealId);
  let appeal = null;
  const ids = idsOf(null);

  try {
    if (numId == null) return fail(CODE_NO_APPEAL, "No such ban appeal.");
    appeal = appealReader(d)(numId);
    if (!appeal) return fail(CODE_NO_APPEAL, "No such ban appeal.");
    const communityId = Number(appeal.community_id);
    Object.assign(ids, idsOf(appeal));

    // Cap belt (the modal clamps first): the repository re-checks at claim.
    const note = optionalText(reason);
    if (note) {
      let cap = null;
      try {
        cap = dbApi().MAX_DENIAL_REASON;
      } catch {
        cap = null; // repo claim re-checks; never die on the cap read
      }
      if (cap != null && note.length > cap) {
        const error = `The denial reason is too long (max ${cap} characters). Nothing was denied.`;
        logWith(log, "warn", "deny refused — reason over cap", ids, error);
        return fail(CODE_REASON_TOO_LONG, error, { appealId: numId, communityId });
      }
    }

    // ── THE CLAIM (first decision wins) ────────────────────────────────────
    const claimFn =
      d.claimAppealOutcome ||
      ((id, opts) => dbApi().claimAppealOutcome(id, opts));
    const claim = await claimFn(appeal.id, {
      status: "denied",
      decidedBy: optionalText(staffUserId),
      denialReason: note,
      nowMs: d.nowMs,
    });
    if (!claim || claim.ok !== true) {
      const error = claim?.error || "claimAppealOutcome returned no result";
      logWith(log, "error", "deny claim failed", ids, error);
      return fail(CODE_CLAIM_FAILED, error, { appealId: numId, communityId });
    }
    if (claim.won !== true) {
      const liveStatus = claim.appeal?.status ?? "unknown";
      const error = alreadyDecidedError(liveStatus);
      logWith(log, "warn", `deny click LOST the claim (live=${liveStatus})`, ids, null);
      return fail(CODE_ALREADY_DECIDED, error, {
        appealId: numId,
        communityId,
        liveStatus,
      });
    }
    logWith(log, "info", "deny claim WON — executing the outcome", ids, null);

    // ── the ban record (user id + expiry ONLY — never ban metadata into DM
    // copy beyond the eligibility stamps, §6) ───────────────────────────────
    {
      const record = readBanRecord(d, appeal.ban_record_id, log, ids);
      Object.assign(ids, idsOf(appeal, { userId: record?.user_id }));
      const facts = outcomeFacts(appeal, record);
      if (!record) {
        logWith(log, "error", "deny granted over a MISSING ban record — DM impossible", ids, null);
      }

      // ── the denial DM (K2: failure logged with ids, never echoed) ────────
      let dmDelivered = false;
      let dmError = null;
      if (record) {
        const outbound = resolveOutbound(d);
        const sendDm = seam(d, "sendDm", outbound, "sendDm");
        const guild = await resolveOutcomeGuild(communityId, d);
        const guildName = optionalText(d.guildName) ?? optionalText(guild?.name);
        try {
          const res = await sendDm(
            String(record.user_id),
            buildDenyDm({
              guildName,
              expiresAtMs: record.expires_at,
              denialReason: note,
            }),
          );
          dmDelivered = res?.ok === true;
          if (!dmDelivered) dmError = res?.error || "sendDm returned no result";
        } catch (err) {
          dmError = err?.message || String(err);
        }
        if (!dmDelivered) {
          logWith(log, "error", "denial DM failed", ids, dmError);
        }
      } else {
        dmError = "no ban record behind the appeal — no user id to DM";
      }

      const warnings = [];

      // ── ticket close (shared flow, best-effort) ───────────────────────────
      const close = await closeAppealTicket({
        appeal,
        communityId,
        closedBy: optionalText(staffUserId),
        closeReason: "Ban appeal decided — appeal denied",
        deps: d,
        log,
        ids,
      });
      warnings.push(...close.warnings);

      // ── header buttons (best-effort) ──────────────────────────────────────
      const buttons = await disableOutcomeButtons({ deps: d, log, ids });
      if (buttons.note) warnings.push(buttons.note);

      // ── audit (reason BODY stays in the appeal row; audit carries shape) ──
      outcomeAudit(
        d,
        {
          action: AUDIT_ACTION_DENIED,
          communityId,
          targetType: "ban_appeal",
          targetId: String(appeal.id),
          actorUserId: optionalText(staffUserId),
          details: {
            ban_record_id: appeal.ban_record_id,
            ban_number: record?.ban_number ?? null,
            subject_user_id: record?.user_id ?? null,
            timed: record?.expires_at != null,
            has_denial_reason: note != null,
            dm_delivered: dmDelivered,
          },
        },
        log,
        ids,
      );

      await postTicketWarnings({ appeal, warnings, deps: d, log, ids });

      return {
        ok: true,
        code: CODE_DENIED,
        ...facts,
        timed: record?.expires_at != null,
        dmDelivered,
        dmError,
        ticketClosed: close.closed,
        ticketAlreadyClosed: close.alreadyClosed === true,
        closeWarnings: close.warnings,
        buttonsDisabled: buttons.disabled,
        warnings,
      };
    }
  } catch (err) {
    const error = `Could not record the denial (appeal ${numId ?? "?"}): ${err?.message || err}`;
    logWith(log, "error", "deny outcome errored", ids, err);
    return fail(CODE_INTERNAL, error, { appealId: numId });
  }
}

/* ══ 3. plainClose — the neutral ChannelDelete path ═════════════════════════ */

/**
 * Close an appeal WITHOUT a decision (#773 §4). Only ever runs while the
 * claim finds the row `open` — a granted/denied/closed appeal is a no-op
 * (decision rows are written BEFORE any close, so the ChannelDelete arm
 * meets decided rows constantly). The ban is untouched: zero ban_records
 * writes, no welcome spend, no unban, no invite. The DM is the neutral
 * "staff ended the conversation; the ban stands" notice.
 *
 * @param {object} params
 * @param {number|string} [params.appealId] direct path (strict: NO_APPEAL on miss)
 * @param {number} [params.communityId] required with ticketChannelId
 * @param {string} [params.ticketChannelId] ChannelDelete path (lenient skip)
 * @param {string|null} [params.staffUserId] optional attribution (a staff
 *   command closing without a decision); the event path leaves it null —
 *   the repo's attribution-free plain-close claim (decided_by NULL)
 * @param {object} [params.deps] same seam family
 * @returns {Promise<object>} never rejects
 */
async function plainClose({
  appealId = null,
  communityId = null,
  ticketChannelId = null,
  staffUserId = null,
  deps = {},
} = {}) {
  const d = deps || {};
  const log = pickLog(d);
  const ids = idsOf(null);

  try {
    let appeal = null;
    const byId = positiveIntOrNull(appealId);
    if (byId != null) {
      appeal = appealReader(d)(byId);
      if (!appeal) return fail(CODE_NO_APPEAL, "No such ban appeal.", { appealId: byId });
    } else {
      // ChannelDelete path: community + channel → row. A channel that binds
      // NO appeal (99.9% of deletions) skips silently — that is the norm,
      // not a failure for 07's listener to log.
      const channel = optionalText(ticketChannelId);
      const cid = positiveIntOrNull(communityId);
      if (channel == null || cid == null) {
        return fail(CODE_NO_TARGET, "plainClose needs appealId, or communityId + ticketChannelId.");
      }
      const read =
        d.getAppealByTicketChannel ||
        ((c, ch) => dbApi().getAppealByTicketChannel(c, ch));
      appeal = read(cid, channel) ?? null;
      if (!appeal) return { ok: true, skipped: true, code: CODE_NO_APPEAL };
    }
    Object.assign(ids, idsOf(appeal));
    const resolvedCommunity = Number(appeal.community_id);

    if (String(appeal.status) !== "open") {
      // Decided/filed rows are NO-OPS (never re-DM, never re-close).
      return {
        ok: true,
        skipped: true,
        code: CODE_NOT_OPEN,
        status: appeal.status,
        appealId: appeal.id,
        communityId: resolvedCommunity,
      };
    }

    // ── THE CLAIM (races the decision buttons; first-wins via the SAME CAS) ─
    const claimFn =
      d.claimAppealOutcome ||
      ((id, opts) => dbApi().claimAppealOutcome(id, opts));
    const claim = await claimFn(appeal.id, {
      status: "closed",
      decidedBy: optionalText(staffUserId), // null on the event path (repo law)
      nowMs: d.nowMs,
    });
    if (!claim || claim.ok !== true) {
      const error = claim?.error || "claimAppealOutcome returned no result";
      logWith(log, "error", "plain-close claim failed", ids, error);
      return fail(CODE_CLAIM_FAILED, error, {
        appealId: appeal.id,
        communityId: resolvedCommunity,
      });
    }
    if (claim.won !== true) {
      // A decision button won between the ChannelDelete check and this
      // claim: its DM is the user's answer — the neutral path says nothing.
      const liveStatus = claim.appeal?.status ?? "unknown";
      logWith(log, "info", `plain-close LOST the claim to a decision (live=${liveStatus})`, ids, null);
      return fail(CODE_ALREADY_DECIDED, alreadyDecidedError(liveStatus), {
        appealId: appeal.id,
        communityId: resolvedCommunity,
        liveStatus,
      });
    }
    logWith(log, "info", "plain-close claim WON — neutral notice only", ids, null);

    // ── the neutral DM (user id from the record; ban UNTOUCHED) ────────────
    const record = readBanRecord(d, appeal.ban_record_id, log, ids);
    Object.assign(ids, idsOf(appeal, { userId: record?.user_id }));
    const facts = outcomeFacts(appeal, record);

    let dmDelivered = false;
    let dmError = null;
    if (record) {
      const outbound = resolveOutbound(d);
      const sendDm = seam(d, "sendDm", outbound, "sendDm");
      const guild = await resolveOutcomeGuild(resolvedCommunity, d);
      const guildName = optionalText(d.guildName) ?? optionalText(guild?.name);
      try {
        const res = await sendDm(String(record.user_id), buildPlainCloseDm({ guildName }));
        dmDelivered = res?.ok === true;
        if (!dmDelivered) dmError = res?.error || "sendDm returned no result";
      } catch (err) {
        dmError = err?.message || String(err);
      }
      if (!dmDelivered) logWith(log, "error", "plain-close DM failed", ids, dmError);
    } else {
      dmError = "no ban record behind the appeal — no user id to DM";
      logWith(log, "error", "plain-close DM impossible (record missing)", ids, dmError);
    }

    const warnings = [];
    if (!record) warnings.push("The ban record is gone — the neutral DM could not go out.");

    // ── buttons (ChannelDelete: channel already gone → logged skip) ────────
    const buttons = await disableOutcomeButtons({ deps: d, log, ids });
    if (buttons.note) warnings.push(buttons.note);

    // ── ticket row (channel usually deleted already; close what remains) ───
    const close = await closeAppealTicket({
      appeal,
      communityId: resolvedCommunity,
      closedBy: optionalText(staffUserId),
      closeReason: "Ban appeal closed without a decision",
      deps: d,
      log,
      ids,
    });
    warnings.push(...close.warnings);

    // ── audit (attribution-free on the event path) ─────────────────────────
    outcomeAudit(
      d,
      {
        action: AUDIT_ACTION_CLOSED,
        communityId: resolvedCommunity,
        targetType: "ban_appeal",
        targetId: String(appeal.id),
        actorUserId: optionalText(staffUserId),
        details: {
          ban_record_id: appeal.ban_record_id,
          ban_number: record?.ban_number ?? null,
          subject_user_id: record?.user_id ?? null,
          ticket_channel_id: appeal.ticket_channel_id ?? null,
          dm_delivered: dmDelivered,
        },
      },
      log,
      ids,
    );

    return {
      ok: true,
      code: CODE_CLOSED,
      ...facts,
      dmDelivered,
      dmError,
      ticketClosed: close.closed,
      ticketAlreadyClosed: close.alreadyClosed === true,
      closeWarnings: close.warnings,
      buttonsDisabled: buttons.disabled,
      warnings,
    };
  } catch (err) {
    const error = `Could not plain-close the appeal: ${err?.message || err}`;
    logWith(log, "error", "plain-close errored", ids, err);
    return fail(CODE_INTERNAL, error, {});
  }
}

module.exports = {
  LOG_PREFIX,
  OUTCOME_CODES,
  // individual codes (callers/tests import any subset):
  CODE_GRANTED,
  CODE_DENIED,
  CODE_CLOSED,
  CODE_ALREADY_DECIDED,
  CODE_NO_APPEAL,
  CODE_NOT_OPEN,
  CODE_NO_RECORD,
  CODE_CLAIM_FAILED,
  CODE_UNBAN_FAILED,
  CODE_REASON_TOO_LONG,
  CODE_NO_TARGET,
  CODE_INTERNAL,
  // audit + copy surface (07 + docs quote these exactly):
  AUDIT_ACTION_CLEMENCY,
  AUDIT_ACTION_DENIED,
  AUDIT_ACTION_CLOSED,
  AUDIT_ACTION_INVITE,
  CLEMENCY_UNBAN_REASON,
  MODAL_DENY_TITLE,
  MODAL_LABEL_REASON,
  MODAL_FIELD_REASON,
  buildClemencyDm,
  buildDenyReasonModal,
  buildDenyDm,
  buildPlainCloseDm,
  alreadyDecidedError,
  // the outcome engine (07 wires every entry):
  grantClemency,
  deny,
  plainClose,
  // pure/white-box seams (units pin without Discord/db):
  internals: {
    pickInviteChannel,
    spendWelcomeClaim,
    settleRecordClemency,
    closeAppealTicket,
    disableOutcomeButtons,
    banRef,
    guildMention,
    positiveIntOrNull,
    TEXTISH_CHANNEL_TYPES,
    DECIDED_STATUSES,
  },
};
