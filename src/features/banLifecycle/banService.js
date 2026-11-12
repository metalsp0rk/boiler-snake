/**
 * Ban lifecycle service (#772) — the ONE path every tracked ban/unban takes.
 *
 * Staff commands (subtask 05), the automod executor seam (subtask 08) and the
 * event/ticker layer (subtasks 06/07) all funnel through the four entries
 * exported here. The service imports NEITHER discord.js NOR the Fluxer SDK
 * and NEVER writes to a channel or replies to a platform: every entry point
 * returns { ok: true, ...facts } | { ok: false, error, code? } (AGENTS.md
 * error law, rule 6 — expected failures are values, never thrown; the
 * callers surface `error` verbatim). Only assertCommunityId keeps its
 * programmer-error throw, exactly like every community-scoped repository.
 *
 * ── Locked flow (the ORDER is law, #772 §1–§5) ────────────────────────────
 *  banUser               guards (duplicate active → self-ban → staff-subject
 *                        mirror of the #729 guardSubject) → ban-time DM FIRST
 *                        (while the shared-guild DM path still exists, K2:
 *                        failure is logged `[banlifecycle]` with ids and
 *                        returned in `warnings[]`, NEVER blocks the ban and
 *                        NEVER apologizes) → outbound.banMember(reason) →
 *                        createBanRecord AFTER the successful ban.
 *  finalizeExpiry        claimUnban CAS → outbound.unbanMember
 *                        ("Expired — auto-unban (banned <t:F> by <staff>)" —
 *                        the moderator may be named in the GUILD-side reason,
 *                        never in user DMs) → finalizeUnban('expired_unbanned')
 *                        → welcome path. NOT_BANNED (10026) is tolerated: the
 *                        ban vanished outside the bot, so the repo machine
 *                        settles the row `unbanned_manual` — not an error.
 *  handleExternalUnban   GuildBanRemove truth: markUnbannedManual CAS wins
 *                        over a claimed-but-unfinalized ticker lease (manual
 *                        beats ticker — events keep the record truthful),
 *                        then the welcome path.
 *  handleRejoin          latest pending_rejoin row + unban within
 *                        REJOIN_WELCOME_WINDOW_DAYS → exactly ONE attempt →
 *                        `welcomed` REGARDLESS of the DM outcome.
 *
 * ── CAS law (banRecords is the schema truth) ───────────────────────────────
 * Every settle goes through the repository's first-writer-wins primitives
 * (claimUnban / finalizeUnban / markUnbannedManual / claimWelcome /
 * markWelcomed). A LOSING claimer performs ZERO outbound calls, re-reads the
 * live row the claim returned and reports that truth with { ok: false, error }
 * — it never guesses, never overwrites, and never re-claims (welcome
 * claims are one-shot: the pending_rejoin handoff is the retry path).
 *
 * ── Injected deps (every entry takes a flat options object) ────────────────
 *   communityId  integer communities.id (asserted at entry)
 *   outbound     platform outbound ({ sendDm, banMember, unbanMember,
 *                fetchGuild }) — null-tolerant: every path that needs it
 *                returns/reports a SPECIFIC cause, never crashes
 *   guildId      Discord guild snowflake (staff-subject guard reads; belt:
 *                reverse-resolved from the communities row when absent)
 *   guildName    display name for DM copy (belt: outbound.fetchGuild, then
 *                the dmCopy "the server" belt)
 *   settings     pre-read guild_settings row (belt: getGuildSettings)
 *   db           db facade (default require('../../db')) — `db.db` is the
 *                better-sqlite3 handle the rejoin lookup needs
 *   client       discord.js client (default guard-seam reads only)
 *   log          console-like logger (default console)
 *   now          injectable ms clock (tests)
 * Guard seams (mirror the automod executor's individually-overridable law,
 * executor.js buildDefaultDeps): fetchMemberRoleIds(guildId, userId),
 * fetchMemberTopRolePosition(guildId, userId),
 * fetchBotTopRolePosition(guildId), fetchMemberHasManageGuild(guildId, userId).
 * Welcome-reason staff label: moderatorName (string) or
 * resolveModeratorName(moderatorId) → string|null (decorative; falls back to
 * the id, never blocks the unban).
 *
 * ── #773 seams (locked) ────────────────────────────────────────────────────
 *  - banUser passes `components` straight through to buildBanDm (plumbed,
 *    unused today) — the appeals button needs no signature change.
 *  - The returned record's `id` (also mirrored as banRecordId) is the stable
 *    appeal handle (`appeal:<id>`); the status machine is append-only.
 *
 * ── Audit (src/core/auditTrail.js) ─────────────────────────────────────────
 * System-origin rows: banLifecycle.ban (automod-origin bans only — the staff
 * command layer owns its own recordSlashAudit), banLifecycle.expiry_unban,
 * banLifecycle.external_unban, banLifecycle.rejoin_welcome. The staff-log
 * EMBED is the ticker/event layer's job (subtasks 06/07 build it from the
 * facts returned here — record, status, banNumber, unbanReason, welcome).
 */

const {
  DURATION_MIN_MS,
  DURATION_MAX_MS,
  REJOIN_WELCOME_WINDOW_DAYS,
  DURATION_EXAMPLES,
} = require("./constants");
const { buildBanDm, buildWelcomeDm } = require("./dmCopy");

/** Machine code outbound.unbanMember assigns for Discord 10026 (assigned,
 * never written as a `code:` object literal — the banRecords env-parity
 * scan law). */
const CODE_NOT_BANNED = "NOT_BANNED";

/** Log prefix; every failure line carries community/user ids (rule 2). */
const LOG_PREFIX = "[banlifecycle]";

const DAY_MS = 86_400_000;

/** Discord MANAGE_GUILD permission bit (numeric on purpose: this service
 * imports no discord.js — #772 keeps the platform surface in outbound). */
const MANAGE_GUILD_BIT = 0x20;

/* ── Lazy module access ─────────────────────────────────────────────────────
 * Every db/audit/community require is call-time: the subtask-04 export probe
 * runs `node -e require(banService)` with NO database bound, and
 * connection.js opens SQLite at require time (#699 law). Pure ./constants and
 * ./dmCopy stay top-level. */
const dbFacade = () => require("../../db");
const communityApi = () => require("../../platform/community");
const staffRolesRepo = () => require("../../db/repositories/staffRoles");
const auditTrail = () => require("../../core/auditTrail");

/* ── Tiny helpers ─────────────────────────────────────────────────────────── */

/** Trim-to-null ("" is absent, never stored/quoted). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Finite positive number (timestamps, durations, clocks). */
function positiveFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Console-like logger selection (never assumes warn/info exist). */
function pickLog(opts) {
  const given = opts && typeof opts.log === "object" ? opts.log : null;
  return {
    info: (...args) =>
      (given?.info ?? given?.log ?? given?.warn ?? console.info.bind(console))(
        ...args
      ),
    warn: (...args) =>
      (given?.warn ?? given?.error ?? given?.log ?? console.warn.bind(console))(
        ...args
      ),
    error: (...args) =>
      (given?.error ?? given?.log ?? console.error.bind(console))(...args),
  };
}

/** Clock seam (injectable for deterministic tests). */
function clockOf(opts) {
  const n = Number(opts?.now);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Date.now();
}

/** `<t:UNIX:F>` for audit copy; unknown times render honestly. */
function tsTag(ms) {
  const n = positiveFinite(ms);
  return n ? `<t:${Math.floor(n / 1000)}:F>` : "an unknown time";
}

/** Human ban ref (display form of ban_number, sibling of W-n / A-n / T-n). */
function banRef(record) {
  return `B-${record?.ban_number ?? "?"}`;
}

/**
 * #809: does the LIVE ban reason still match the reason captured when this
 * record issued its ban? Normalized equality (trim, collapse internal
 * whitespace, case-fold) — Discord itself does not re-wrap reasons, but the
 * audit trail around a re-ban often differs by punctuation, and the guard
 * only fires on a real narrative change, not cosmetic drift. Both sides
 * ride the SAME platform read path (fetchBan at issue vs. fetchBan at
 * expiry), so truncation/normalization Discord applies is shared, not a
 * false mismatch.
 */
function identityReasonMatches(issued, live) {
  const norm = (v) =>
    String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return norm(issued) === norm(live);
}

/** { ok:false, error } result with an optional machine code. */
function fail(error, code) {
  const out = { ok: false, error };
  if (code !== undefined && code !== null) out.code = code;
  return out;
}

/** Refusal/failure with the mandatory `[banlifecycle]` ids line. */
function failLogged(log, reason, communityId, userId, error, code) {
  log.warn(`${LOG_PREFIX} ${reason} community=${communityId} user=${userId}: ${error}`);
  return fail(error, code);
}

/** Pre-read settings or a fresh (never-fatal) read; defaults are ON. */
function readSettings(communityId, opts) {
  if (opts && opts.settings && typeof opts.settings === "object") {
    return opts.settings;
  }
  try {
    return dbFacade().getGuildSettings(communityId) || {};
  } catch (err) {
    // A settings read must not kill a ban/unban — defaults (both DMs on)
    // are the safe, issue-blessed fallback and the cause stays in the log.
    console.warn(
      `${LOG_PREFIX} guild settings read failed community=${communityId}:`,
      err?.message || err
    );
    return {};
  }
}

const banDmEnabled = (settings) => Number(settings?.ban_dm ?? 1) !== 0;
const welcomeDmEnabled = (settings) =>
  Number(settings?.welcome_back_dm ?? 1) !== 0;

/** Guild display name for DM copy: explicit → fetchGuild → dmCopy belt. */
async function resolveGuildName(opts, outbound, communityId) {
  const given =
    optionalText(opts?.guildName) ?? optionalText(opts?.guild?.name);
  if (given) return given;
  if (typeof outbound?.fetchGuild === "function") {
    try {
      const handle = await outbound.fetchGuild(communityId);
      const name = optionalText(handle?.name);
      if (name) return name;
    } catch {
      // Decorative read only — dmCopy falls back to "the server".
    }
  }
  return null;
}

/** Better-sqlite3 handle from the injected db (facade or raw), law-checked. */
function connOf(dbLike) {
  const mod = dbLike ?? dbFacade();
  const conn =
    mod && typeof mod.prepare === "function" ? mod : mod?.db ?? null;
  if (!conn || typeof conn.prepare !== "function") {
    throw new Error(
      "banService needs the db facade (or a better-sqlite3 handle) for community-scoped reads"
    );
  }
  return conn;
}

/** System-origin audit row (auditTrail is itself fail-safe; the lazy require
 * is the only throw risk here, and an audit loss never breaks the flow). */
function systemAudit(log, entry) {
  try {
    return auditTrail().recordSystemAudit(entry) || null;
  } catch (err) {
    log.warn(
      `${LOG_PREFIX} audit row failed (action=${entry?.action} community=${entry?.communityId}):`,
      err?.message || err
    );
    return null;
  }
}

/**
 * #811: a cycle just ENDED on our side (expiry auto-unban, external lift,
 * reconciliation) — close any appeal still riding it. Delegates to
 * banAppeals' system-close outcome: its one-winner CAS owns the appeal row
 * (a staff decision landing mid-flight wins and this reports the live
 * status), and closing STRUCTURALLY stops the DM ferry + converges the
 * ticket. Best-effort by construction: an appeal-close failure is logged
 * with ids and NEVER rewrites the ban settle that already shipped — the
 * ban's truth is durable before this line runs.
 *
 * NEVER call for `expired_held` (#809): a held ban is still in force — its
 * appeal legitimately stays open for staff to decide.
 */
async function settleEndedBanAppeals(record, cause, opts, log) {
  try {
    // CALL-TIME require (#699 + direction law): banAppeals is required FROM
    // banLifecycle by design (dmButton.js header pins it) — never the reverse.
    const appealsOutcomes = require("../banAppeals/outcomes");
    const res = await appealsOutcomes.closeOnBanEnd({
      communityId: Number(record.community_id),
      banRecordId: Number(record.id),
      cause,
      deps: {
        client: opts?.client ?? null,
        outbound: opts?.outbound ?? null,
        log,
        ...(positiveFinite(opts?.now) ? { nowMs: Number(opts.now) } : {}),
      },
    });
    if (res && res.ok !== true) {
      log.error(
        `${LOG_PREFIX} appeal auto-close failed community=${record.community_id} ` +
          `user=${record.user_id} ${banRef(record)}: ` +
          (res?.error || "closeOnBanEnd reported no cause")
      );
    }
    return res;
  } catch (err) {
    log.error(
      `${LOG_PREFIX} appeal auto-close errored community=${record.community_id} ` +
        `user=${record.user_id} ${banRef(record)}:`,
      err?.message || err
    );
    return null;
  }
}

/* ── Staff-subject guard — mirror of automod executor guardSubject (#729) ───
 * executor.js guardSubject is NOT exported; this is the ban-surface twin with
 * the same semantics: staff_roles membership blocks outright, an UNRESOLVABLE
 * role read or hierarchy REFUSES (never a silent pass), and the hierarchy
 * comparison names both positions. Adds the ManageGuild permission belt the
 * ban service locks in. Every read is an overridable seam (test doubles
 * inject the same names the automod executor tests already script). */

function buildGuardSeams(opts, guildId) {
  const guildOf = () => {
    const client = opts?.client;
    if (!client) {
      throw new Error(
        "no Discord client (and no injected guard seam) — the subject cannot be inspected"
      );
    }
    if (guildId == null || String(guildId) === "") {
      throw new Error("no guild id to read the subject in");
    }
    const guild = client.guilds?.cache?.get(String(guildId));
    if (!guild) throw new Error(`guild ${guildId} is not cached by this client`);
    return guild;
  };
  const memberOf = async () => {
    const member = await guildOf().members.fetch(String(opts.userId));
    if (!member) throw new Error(`member ${opts.userId} could not be fetched`);
    return member;
  };
  return {
    fetchMemberRoleIds: async () => {
      const member = await memberOf();
      return [...(member?.roles?.cache?.keys() ?? [])];
    },
    fetchMemberTopRolePosition: async () => {
      const member = await memberOf();
      return member?.roles?.highest?.position ?? null;
    },
    fetchBotTopRolePosition: async () => {
      const me = guildOf().members?.me;
      return me?.roles?.highest?.position ?? null;
    },
    fetchMemberHasManageGuild: async () => {
      const member = await memberOf();
      const perms = member?.permissions;
      if (!perms || typeof perms.has !== "function") {
        throw new Error("the subject's permission bits are unreadable");
      }
      return perms.has(MANAGE_GUILD_BIT) === true;
    },
  };
}

function seamOf(opts, name, defaults) {
  const injected = opts?.[name];
  return typeof injected === "function" ? () => injected(guildArgOf(opts), String(opts.userId)) : defaults[name];
}

function guildArgOf(opts) {
  if (opts.guildId != null && String(opts.guildId) !== "") {
    return String(opts.guildId);
  }
  try {
    // Belt: ticker/event callers may only carry the integer community id.
    const ext = communityApi().getCommunityById(opts.communityId)
      ?.externalGuildId;
    return optionalText(ext);
  } catch {
    return null;
  }
}

async function guardBanSubject(opts) {
  const { communityId, userId } = opts;
  const guildId = guildArgOf(opts);
  const defaults = buildGuardSeams({ ...opts, userId }, guildId);
  const readRoles = seamOf(opts, "fetchMemberRoleIds", defaults);
  const readSubjectTop = seamOf(
    opts,
    "fetchMemberTopRolePosition",
    defaults
  );
  const readBotTop = seamOf(opts, "fetchBotTopRolePosition", defaults);
  const readManageGuild = seamOf(
    opts,
    "fetchMemberHasManageGuild",
    defaults
  );

  let staffRoleIds;
  try {
    staffRoleIds = new Set(
      staffRolesRepo()
        .listStaffRoles(communityId)
        .map((r) => String(r.role_id))
    );
  } catch (err) {
    return fail(
      `Could not read this community's staff-role list: ${err?.message || err} — refusing to ban <@${userId}> without knowing whether they are staff.`
    );
  }

  let subjectRoleIds;
  try {
    subjectRoleIds = await readRoles();
  } catch (err) {
    return fail(
      `Could not check the subject's roles: ${err?.message || err} — refusing to ban <@${userId}> without knowing whether they are staff.`
    );
  }
  const held = (subjectRoleIds ?? [])
    .map(String)
    .find((r) => staffRoleIds.has(r));
  if (held) {
    return fail(
      `Refusing to ban <@${userId}> — they hold staff role <@&${held}>. Bans never execute against guild staff (the #729 staff-subject guard). Nothing was banned.`
    );
  }

  // ManageGuild belt: a permission carrier of ManageGuild IS guild staff,
  // whether or not their role sits in staff_roles (#772 §1 translated guard).
  // Belt ONLY: the mirrored #729 law above (staff_roles + hierarchy) still
  // fails closed hard. When the subject has no readable permission surface
  // at all (no client AND no injected fetchMemberHasManageGuild seam — the
  // shape of a caller driving the guard from its own doubles), the belt logs
  // the gap and defers to the mirrored checks instead of refusing everything.
  if (
    typeof opts?.fetchMemberHasManageGuild !== "function" &&
    !opts?.client
  ) {
    pickLog(opts).warn(
      `${LOG_PREFIX} ManageGuild staff-subject belt skipped community=${communityId} user=${userId}: no client and no fetchMemberHasManageGuild seam — staff_roles + hierarchy law still enforced`
    );
  } else {
    let holdsManageGuild = false;
    try {
      holdsManageGuild = (await readManageGuild()) === true;
    } catch (err) {
      return fail(
        `Could not check the subject's guild permissions: ${err?.message || err} — refusing to ban <@${userId}> without knowing whether they are staff.`
      );
    }
    if (holdsManageGuild) {
      return fail(
        `Refusing to ban <@${userId}> — they hold the **Manage Guild** permission, which marks them as guild staff (the #729 staff-subject guard). Nothing was banned.`
      );
    }
  }

  let subjectTop = null;
  let botTop = null;
  try {
    [subjectTop, botTop] = await Promise.all([readSubjectTop(), readBotTop()]);
  } catch (err) {
    return fail(
      `Could not check the role hierarchy: ${err?.message || err} — refusing to ban <@${userId}> rather than guess whether the bot can moderate them.`
    );
  }
  if (subjectTop == null || botTop == null) {
    return fail(
      `Could not resolve the role hierarchy for <@${userId}> (subject role position ${subjectTop ?? "unknown"}, bot role position ${botTop ?? "unknown"}) — refusing to ban rather than guess whether the bot can moderate them.`
    );
  }
  if (subjectTop >= botTop) {
    return fail(
      `Refusing to ban <@${userId}> — their top role (position ${subjectTop}) is not below the bot's highest role (position ${botTop}). Discord only lets a higher role moderate a lower one; move the bot's role up. Nothing was banned.`
    );
  }
  return { ok: true };
}

/* ── Discord-cause translation (formatChannelCreateError idiom) ─────────────
 * outbound.banMember already carries the raw cause; the service pins the
 * hierarchy failure (50013) into actionable copy before it reaches staff. */

function translateBanMemberError(res, userId) {
  const cause = res?.error || "banMember returned no result";
  const codeNum = Number(res?.code);
  if (codeNum === 50013 || /50013|Missing Access|Missing Permissions/i.test(String(cause))) {
    return (
      `Discord refused the ban (**Missing Access 50013**). Check:\n` +
      `1. The bot holds **Ban Members**\n` +
      `2. The bot's highest role is **above** <@${userId}>'s top role\n` +
      `3. No higher role protects the target\n` +
      `Nothing was banned.`
    );
  }
  const codeNote = res?.code != null ? ` (Discord code ${res.code})` : "";
  return `Could not ban <@${userId}>: ${cause}${codeNote} — nothing was banned.`;
}

/* ── Guild-side unban reason (#772 §4 — staff name allowed HERE, never in DMs) */

async function staffLabel(record, opts) {
  const given = optionalText(opts?.moderatorName);
  if (given) return given;
  if (record.moderator_id && typeof opts?.resolveModeratorName === "function") {
    try {
      const name = optionalText(await opts.resolveModeratorName(record.moderator_id));
      if (name) return name;
    } catch {
      // Decorative label only — the id fallback below stays honest, and a
      // vanished user must never block an expiry unban.
    }
  }
  if (record.moderator_id) return `moderator ${record.moderator_id}`;
  return record.source === "automod" ? "automod harness" : "unknown staff";
}

async function buildExpiryUnbanReason(record, opts) {
  const staff = await staffLabel(record, opts);
  return `Expired — auto-unban (banned ${tsTag(record.banned_at)} by ${staff})`;
}

/* ── Shared welcome path (claim once → DM → park on failure) ────────────────
 * The claim IS the stamp (welcome_dm_sent 0→1, 074 decision): a lost claim
 * means the cycle's one welcome was already attempted — never re-claim; the
 * pending_rejoin handoff is the ONLY retry path. Toggle off → total silence,
 * row untouched, claim unspent (issue: disabled toggle → silence). */

function attemptWelcome(communityId, userId, record, opts, log, guildName) {
  return attemptWelcomeInner(communityId, userId, record, opts, log, guildName).catch(
    (err) => {
      // attemptWelcome never throws at its caller; this belt keeps even a
      // broken repo handle from killing the unban flow's return.
      const cause = err?.message || err;
      log.warn(
        `${LOG_PREFIX} welcome DM path errored community=${communityId} user=${userId}: ${cause}`
      );
      return { attempted: false, error: String(cause) };
    }
  );
}

async function attemptWelcomeInner(communityId, userId, record, opts, log, guildName) {
  const settings = readSettings(communityId, opts);
  if (!welcomeDmEnabled(settings)) {
    return { attempted: false, skipped: "welcome_back_dm is off" };
  }
  const claim = dbFacade().claimWelcome(record.id);
  if (!claim.ok) {
    log.warn(
      `${LOG_PREFIX} welcome claim failed community=${communityId} user=${userId}: ${claim.error}`
    );
    return { attempted: false, error: claim.error };
  }
  if (!claim.won) {
    // One welcome per cycle: claim lost = already claimed (delivered) or
    // already parked for rejoin. The row (claim.record) is the truth.
    return {
      attempted: false,
      skipped:
        claim.record?.status === "pending_rejoin"
          ? "welcome already attempted — parked for rejoin"
          : "welcome DM already claimed this cycle",
      record: claim.record ?? null,
    };
  }

  const outbound = opts?.outbound;
  if (typeof outbound?.sendDm !== "function") {
    // Claim spent: park honestly so a later rejoin can retry.
    dbFacade().markPendingRejoin(record.id);
    log.warn(
      `${LOG_PREFIX} welcome DM skipped community=${communityId} user=${userId}: the outbound has no sendDm surface — parked for rejoin`
    );
    return {
      attempted: false,
      parked: "pending_rejoin",
      error: "the outbound has no sendDm surface",
    };
  }

  const name = guildName ?? (await resolveGuildName(opts, outbound, communityId));
  let delivered = false;
  let cause = null;
  try {
    const res = await outbound.sendDm(userId, buildWelcomeDm({ guildName: name }));
    delivered = res?.ok === true;
    if (!delivered) cause = res?.error || "sendDm returned no result";
  } catch (err) {
    cause = err?.message || err;
  }
  if (delivered) return { attempted: true, delivered: true };

  // K2: log the specific cause with ids; never echo it anywhere else.
  log.warn(
    `${LOG_PREFIX} welcome DM failed community=${communityId} user=${userId}: ${cause}`
  );
  dbFacade().markPendingRejoin(record.id);
  return {
    attempted: true,
    delivered: false,
    parked: "pending_rejoin",
    error: String(cause),
  };
}

/* ═══ 1. banUser — guards → DM-first → ban → record ═══════════════════════ */

/**
 * The ONE ban entry (staff commands, automod seam).
 *
 * @param {object} opts
 * @param {number} opts.communityId integer communities.id (asserted)
 * @param {string} opts.userId target snowflake
 * @param {string|null} [opts.moderatorId] acting staff id (null = automod)
 * @param {string} opts.reason required, ≤ MAX_BAN_REASON — audit AND Discord
 * @param {"staff"|"automod"} [opts.source='staff']
 * @param {number|null} [opts.durationMs] expiring ban; null/absent → permanent
 * @param {number|null} [opts.expiresAtMs] absolute alternative to durationMs
 * @param {*} [opts.components] #773 pass-through to buildBanDm (plumbed)
 * @param {object} [opts.outbound] platform outbound ({sendDm, banMember, …})
 * @param {object} [opts.settings] pre-read guild_settings row
 * @param {object} [opts.db] db facade override
 * @param {number} [opts.now] injectable clock
 * @param {object} [opts.log] console-like logger
 * @returns {Promise<{ ok: true, record, banRecordId, banNumber, expiresAtMs,
 *   banDmSent, warnings, status } | { ok: false, error, code? }>}
 */
async function banUser(opts = {}) {
  const { communityId } = opts;
  communityApi().assertCommunityId(communityId); // programmer-error posture
  const log = pickLog(opts);
  const userIdLabel = String(opts?.userId ?? "unknown");
  try {
    const userId = optionalText(opts.userId);
    if (!userId) return fail("banUser needs the target user id — nothing was banned.");
    const moderatorId = optionalText(opts.moderatorId);
    const source = opts.source ?? "staff";
    const sources = dbFacade().BAN_SOURCES;
    if (!sources.includes(source)) {
      return fail(
        `Unknown ban source \`${source}\` — choose one of: ${sources.join(", ")}. Nothing was banned.`
      );
    }
    const reason = optionalText(opts.reason);
    if (!reason) return fail("A ban needs a reason — nothing was banned.");
    const maxReason = dbFacade().MAX_BAN_REASON;
    if (reason.length > maxReason) {
      return fail(`Ban reason is too long (max ${maxReason} characters). Nothing was banned.`);
    }

    const nowMs = clockOf(opts);
    let expiresAtMs = null;
    if (opts.expiresAtMs != null) {
      expiresAtMs = positiveFinite(opts.expiresAtMs);
      if (!expiresAtMs) {
        return fail(
          `expiresAtMs must be a positive ms timestamp (or pass durationMs/null) — got \`${opts.expiresAtMs}\`. Nothing was banned.`
        );
      }
    } else if (opts.durationMs != null) {
      const durationMs = Number(opts.durationMs);
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return fail(
          `Ban duration must be a positive number of milliseconds (null for permanent) — got \`${opts.durationMs}\`. Nothing was banned.`
        );
      }
      if (durationMs < DURATION_MIN_MS) {
        return fail(
          `**Duration:** ${Math.round(durationMs / 1000)}s is shorter than the ${Math.round(DURATION_MIN_MS / 1000)}s minimum. Use ${DURATION_EXAMPLES} upstream (parseDuration). Nothing was banned.`
        );
      }
      if (durationMs > DURATION_MAX_MS) {
        return fail(
          `**Duration:** ${Math.round(durationMs / DAY_MS)}d is longer than the ${Math.round(DURATION_MAX_MS / DAY_MS)}d maximum. Use ${DURATION_EXAMPLES} upstream (parseDuration). Nothing was banned.`
        );
      }
      expiresAtMs = nowMs + Math.floor(durationMs);
    }

    const facade = dbFacade();
    const outbound = opts.outbound ?? null;

    // ── Guard 1: duplicate active record ("already banned — see records") ──
    const dup = facade.findActiveBanRecord(communityId, userId);
    if (dup) {
      return failLogged(
        log,
        "ban refused (duplicate active)",
        communityId,
        userId,
        `This member is already banned — see records (**${banRef(dup)}**, active since ${tsTag(dup.banned_at)}${dup.expires_at ? `, expires ${tsTag(dup.expires_at)}` : ""}). Nothing new was done.`
      );
    }

    // ── Guard 2: self-ban ──────────────────────────────────────────────────
    if (moderatorId && moderatorId === userId) {
      return failLogged(
        log,
        "ban refused (self-ban)",
        communityId,
        userId,
        "Refusing to ban yourself — the moderator and the target are the same member. Nothing was banned."
      );
    }

    // ── Guard 3: staff-subject mirror (#729) — never a silent pass ─────────
    const subject = await guardBanSubject({ ...opts, userId });
    if (!subject.ok) {
      return failLogged(log, "ban refused (staff-subject guard)", communityId, userId, subject.error);
    }

    // ── Ban-time DM FIRST (K2: while the shared-guild DM path exists) ──────
    const settings = readSettings(communityId, opts);
    const warnings = [];
    let banDmSent = false;
    let banDmSkipped = false;
    if (!banDmEnabled(settings)) {
      banDmSkipped = true;
    } else if (typeof outbound?.sendDm !== "function") {
      warnings.push("Ban DM not sent: the outbound has no sendDm surface.");
    } else {
      const guildName = await resolveGuildName(opts, outbound, communityId);
      try {
        // #773 seam: opts.components rides into buildBanDm untouched.
        const payload = buildBanDm({
          guildName,
          expiresAtMs,
          components: opts.components,
        });
        const dm = await outbound.sendDm(userId, payload);
        banDmSent = dm?.ok === true;
        if (!banDmSent) {
          const cause = dm?.error || "sendDm returned no result";
          log.warn(
            `${LOG_PREFIX} ban DM failed community=${communityId} user=${userId}: ${cause}`
          );
          warnings.push(`Ban DM not delivered: ${cause}`);
        }
      } catch (err) {
        const cause = err?.message || err;
        log.warn(
          `${LOG_PREFIX} ban DM failed community=${communityId} user=${userId}: ${cause}`
        );
        warnings.push(`Ban DM not delivered: ${cause}`);
      }
    }

    // ── The ban itself (DM outcome irrelevant) ─────────────────────────────
    if (typeof outbound?.banMember !== "function") {
      return fail(
        `Could not ban <@${userId}>: the outbound has no banMember surface — nothing was banned.`
      );
    }
    const banned = await outbound.banMember(communityId, userId, reason);
    if (!banned || banned.ok !== true) {
      const error = translateBanMemberError(banned, userId);
      return failLogged(log, "ban failed", communityId, userId, error, banned?.code);
    }

    // ── #809: fingerprint the ban we now own BEFORE storing the record. ───
    // Discord bans are (guild,user)-keyed with no ban id and the v10 Ban
    // payload carries no creation date / moderator — the LIVE reason read
    // back from the platform is the identity the expiry sweep can check.
    // Best-effort: a failed read leaves the marker NULL and expiry falls
    // back to the historical behavior (never a ban refused, never a lie).
    let banIdentityReason = null;
    if (typeof outbound?.fetchBan === "function") {
      try {
        const live = await outbound.fetchBan(communityId, userId);
        if (live?.ok === true) banIdentityReason = live.ban?.reason ?? null;
      } catch {
        // Post-ban bookkeeping never rewrites the outcome (rule 5); the
        // record simply carries no identity until a future read.
      }
    }

    // ── Record AFTER the successful ban ────────────────────────────────────
    const created = facade.createBanRecord({
      communityId,
      userId,
      moderatorId,
      source,
      reason,
      bannedAt: nowMs,
      expiresAt: expiresAtMs,
      banIdentityReason,
    });
    if (!created.ok) {
      const partial =
        `The ban EXECUTED on Discord but its lifecycle record could not be saved: ${created.error} ` +
        `— settle **${userId}**'s record manually (the member IS banned; no expiry or welcome tracking exists).`;
      return failLogged(log, "ban record insert failed", communityId, userId, partial, created.code);
    }
    const record = created.record;

    // Post-success bookkeeping NEVER rewrites the outcome (rule 5: partial
    // facts, not a false total failure).
    try {
      if (banDmSent) facade.recordBanDmSent(record.id);
      if (source === "automod") {
        // System-origin audit; the STAFF command layer owns its own
        // recordSlashAudit for source 'staff'.
        systemAudit(log, {
          communityId,
          action: "banLifecycle.ban",
          targetType: "ban_record",
          targetId: String(record.id),
          actorUserId: null,
          details: {
            ban_number: record.ban_number,
            subject_user_id: userId,
            source,
            expires_at: expiresAtMs,
          },
        });
      }
    } catch (err) {
      warnings.push(
        `Post-ban bookkeeping (record stamps/audit) failed: ${err?.message || err} — the ban and record are in place.`
      );
    }

    return {
      ok: true,
      record,
      banRecordId: record.id, // #773 stable handle (appeal:<id>)
      banNumber: banRef(record),
      expiresAtMs,
      banDmSent,
      banDmSkipped,
      warnings,
      status: "active",
    };
  } catch (err) {
    const cause = err?.message || err;
    log.error(
      `${LOG_PREFIX} banUser errored community=${communityId} user=${userIdLabel}:`,
      cause
    );
    return fail(`Could not run the ban: ${cause}`);
  }
}

/* ═══ 2. finalizeExpiry — CAS auto-unban on an expired active record ══════ */

/**
 * Settle ONE expired ban (the ticker's per-row call, #772 §4).
 * CAS law: claimUnban first — a loser performs ZERO outbound calls; NOT_BANNED
 * means the ban vanished outside the bot and the row settles
 * `unbanned_manual` (repo machine truth), NOT an error.
 *
 * @param {object|number} recordOrId ban_records row or its id
 * @param {object} [deps] shared injected deps ({ outbound, guildName,
 *   settings, db, log, now, moderatorName, resolveModeratorName })
 * @returns {Promise<{ ok: true, acted: true, record, status,
 *   externallyUnbanned, unbanReason, banNumber, welcome }
 *  | { ok: false, error, code?, record? }>}
 */
async function finalizeExpiry(recordOrId, deps = {}) {
  const opts = deps && typeof deps === "object" ? deps : {};
  const id =
    recordOrId && typeof recordOrId === "object"
      ? Number(recordOrId.id)
      : Number(recordOrId);
  const log = pickLog(opts);
  const facade = dbFacade();
  let row = null;
  try {
    row = facade.getBanRecord(id);
  } catch (err) {
    return fail(`Could not read ban record ${id}: ${err?.message || err}`);
  }
  if (!row) return fail(`No such ban record (id ${recordOrId ?? "none"}).`);
  const communityId = Number(opts.communityId ?? row.community_id);
  communityApi().assertCommunityId(communityId);
  const userId = String(row.user_id);
  try {
    const nowMs = clockOf(opts);

    // ── CAS claim BEFORE any await / outbound (first-writer-wins) ──────────
    const claim = facade.claimUnban(id, nowMs);
    if (!claim.ok) {
      return failLogged(log, "expiry claim failed", communityId, userId, claim.error);
    }
    if (!claim.won) {
      const live = claim.record ?? null; // the claim re-read IS the truth
      if (live?.status === "active") {
        const heldForSec = Math.max(
          0,
          Math.round((nowMs - Number(live.unban_claimed_at || nowMs)) / 1000)
        );
        return failLogged(
          log,
          "expiry skipped (claim in flight)",
          communityId,
          userId,
          `Another auto-unban claim for **${banRef(live)}** is already in flight (claimed ${heldForSec}s ago) — this pass performed no Discord call and changed nothing.`
        );
      }
      return failLogged(
        log,
        "expiry skipped (already settled)",
        communityId,
        userId,
        `Ban record **${banRef(live)}** is already settled as \`${live?.status ?? "unknown"}\` — the record is the truth; this pass changed nothing.`
      );
    }

    // ── #810: the quarantine valve ──────────────────────────────────────────
    // REAL winner-side attempts are the only ones counted — a claim loser
    // performed no work and must never inflate the counter (the 10-minute
    // lease would otherwise multiply every true failure ~10×). The bump (and
    // the terminal settle at the ceiling) rides facade.noteExpiryAttempt;
    // crossing returns a quarantined RESULT (ok:true — this pass settled
    // something terminal), while below-ceiling failures keep answering the
    // honest {ok:false} with the attempt count annotated.
    const maxAttempts =
      Number.isInteger(opts.maxExpiryAttempts) && opts.maxExpiryAttempts >= 1
        ? opts.maxExpiryAttempts
        : null;
    const noteAttempt = (stage, error, code) => {
      const cause = String(error ?? "unknown error");
      let note = null;
      try {
        note = facade.noteExpiryAttempt(id, {
          ...(maxAttempts != null ? { maxAttempts } : {}),
          reason:
            `expiry QUARANTINED after repeated failed auto-unban attempts — last error: ${cause.slice(0, 300)}`,
          nowMs,
        });
      } catch (err) {
        log.warn(
          `${LOG_PREFIX} expiry attempt-count failed community=${communityId} user=${userId} ${banRef(row)}:`,
          err?.message || err
        );
      }
      if (note?.ok === true && note.quarantined === true) {
        systemAudit(log, {
          communityId,
          action: "banLifecycle.expiry_quarantined",
          targetType: "ban_record",
          targetId: String(id),
          actorUserId: null,
          details: {
            ban_number: row.ban_number,
            subject_user_id: userId,
            expires_at: row.expires_at,
            source: row.source,
            attempts: note.attempts,
            last_error: cause.slice(0, 300),
          },
        });
        log.error(
          `${LOG_PREFIX} expiry QUARANTINED community=${communityId} user=${userId} ${banRef(row)}: ` +
            `${note.attempts} failed auto-unban attempts (last: ${cause.slice(0, 200)}) — the row left the ` +
            "sweep as expiry_failed; nothing was unbanned and no further passes will touch it. A staff member " +
            "must handle the live ban by hand."
        );
        return {
          ok: true,
          acted: false,
          quarantined: true,
          record: note.record ?? facade.getBanRecord(id),
          banNumber: banRef(row),
          status: "expiry_failed",
          attempts: note.attempts,
          lastError: cause,
          welcome: null,
        };
      }
      const annotated =
        note?.ok === true
          ? `${cause} (expiry attempt ${note.attempts}${
              maxAttempts != null ? `/${maxAttempts}` : ""
            })`
          : cause;
      log.warn(`${LOG_PREFIX} ${stage} community=${communityId} user=${userId}: ${annotated}`);
      return fail(annotated, code);
    };

    // ── Winner: Discord unban with the §4 guild-side reason ────────────────
    const unbanReason = await buildExpiryUnbanReason(row, opts);
    const outbound = opts.outbound ?? null;
    if (typeof outbound?.unbanMember !== "function") {
      return noteAttempt(
        "auto-unban impossible",
        `Could not auto-unban: the outbound has no unbanMember surface — **${banRef(row)}** stays claimed for a lease retry.`
      );
    }
    // ── #809 RE-BAN GUARD: the live ban must still BE the ban this record
    // issued. Any unban→re-issue outside the bot (moderator re-ban during
    // downtime) leaves this record pointing at a human's newer ban — and
    // Discord bans have no id: the v10 Ban payload's only identity beyond
    // the user is its reason, fingerprinted at issue time
    // (`ban_identity_reason`). The three answers:
    //   MATCH (or nothing fingerprinted) → proceed — historical behavior.
    //   MISMATCH → staff owns whatever is live now: the auto-unban is HELD
    //     (never executed — lifting a moderator's ban against their intent
    //     is the destructive act this guard exists to stop) and NO welcome
    //     DM/invite goes to a member a human just (re-)banned. Terminal.
    //   UNREADABLE (any failure that is not the 10026 "not banned") → FAIL
    //     CLOSED: unknown never executes a destructive unban — reconcile's
    //     law ("unknown never settles a record"), applied to the unban
    //     itself. The row stays claimed; the lease frees it for a retry.
    // A 10026 answer falls THROUGH to the unban attempt: its NOT_BANNED arm
    // already owns the external-lift settle (one code path, one truth).
    if (typeof outbound?.fetchBan === "function") {
      const live = await outbound.fetchBan(communityId, userId);
      if (
        live?.ok === true &&
        row.ban_identity_reason != null &&
        !identityReasonMatches(row.ban_identity_reason, live.ban?.reason)
      ) {
        const heldReason =
          `${unbanReason} — HELD: the live ban does not match this record ` +
          `(live reason differs from the reason captured at issue — a staff re-ban is assumed; nothing was lifted)`;
        const held = facade.markExpiryHeld(id, heldReason, { nowMs });
        if (!held.ok) {
          return failLogged(log, "expiry held-settle failed", communityId, userId, held.error);
        }
        if (!held.won) {
          return failLogged(
            log,
            "expiry held-settle lost",
            communityId,
            userId,
            `Ban record **${banRef(held.record)}** was concurrently settled as \`${held.record?.status ?? "unknown"}\` — nothing overwritten.`
          );
        }
        systemAudit(log, {
          communityId,
          action: "banLifecycle.expiry_held",
          targetType: "ban_record",
          targetId: String(id),
          actorUserId: null,
          details: {
            ban_number: row.ban_number,
            subject_user_id: userId,
            expires_at: row.expires_at,
            source: row.source,
            issued_reason: row.ban_identity_reason,
            live_reason: live.ban?.reason ?? null,
          },
        });
        log.warn(
          `${LOG_PREFIX} expiry HELD community=${communityId} user=${userId} ${banRef(row)}: the live ban does not match the record ` +
            `(issued \`${String(row.ban_identity_reason).slice(0, 160)}\` vs live \`${String(live.ban?.reason ?? "").slice(0, 160)}\`) — auto-unban skipped, no welcome DM`
        );
        return {
          ok: true,
          acted: false,
          held: true,
          record: facade.getBanRecord(id),
          banNumber: banRef(row),
          status: "expired_held",
          unbanReason: heldReason,
          issuedReason: row.ban_identity_reason,
          liveReason: live.ban?.reason ?? null,
          welcome: null,
        };
      }
      if (live && live.ok !== true && live.code !== CODE_NOT_BANNED) {
        return noteAttempt(
          "expiry verification unavailable",
          `${live?.error || "fetchBan returned no result"} — refusing to unban a ban that cannot be verified (retrying on a later tick)`
        );
      }
    }

    const res = await outbound.unbanMember(communityId, userId, unbanReason);

    let status = null;
    let externallyUnbanned = false;
    if (res?.ok === true) {
      const fin = facade.finalizeUnban(id, "expired_unbanned", unbanReason, {
        nowMs,
      });
      if (!fin.ok) {
        return failLogged(log, "expiry finalize failed", communityId, userId, fin.error);
      }
      if (!fin.won) {
        // A manual unban landed between claim and finalize — it wins; the
        // event path owns the welcome. Stop with the live truth.
        return failLogged(
          log,
          "expiry finalized by others",
          communityId,
          userId,
          `A concurrent unban already settled **${banRef(fin.record)}** as \`${fin.record?.status ?? "unknown"}\` — the expiry pass kept the record truthful and sent no welcome DM.`
        );
      }
      status = "expired_unbanned";
    } else if (res?.code === CODE_NOT_BANNED) {
      // 10026: lifted outside the bot — the repo machine settles manual,
      // NOT an error out (issue §4 "events keep the record truthful").
      const settleReason = `${unbanReason} — ban was already lifted outside the bot`;
      const settle = facade.markUnbannedManual(id, settleReason);
      if (!settle.ok) {
        return failLogged(log, "expiry manual settle failed", communityId, userId, settle.error);
      }
      if (!settle.won) {
        return failLogged(
          log,
          "expiry manual settle lost",
          communityId,
          userId,
          `Ban record **${banRef(settle.record)}** was concurrently settled as \`${settle.record?.status ?? "unknown"}\` before this pass could mark it — nothing overwritten.`
        );
      }
      externallyUnbanned = true;
      status = "unbanned_manual";
    } else {
      const error = res?.error || "unbanMember returned no result";
      // #810: a real Discord unban failure (MissingAccess, 50013, guild gone)
      // is the canonical chronic failure — count it toward the quarantine.
      return noteAttempt("auto-unban failed", error, res?.code);
    }

    // ── Facts out: audit + appeal close + welcome (embeds are the caller's layer) ──
    systemAudit(log, {
      communityId,
      action: externallyUnbanned
        ? "banLifecycle.external_unban"
        : "banLifecycle.expiry_unban",
      targetType: "ban_record",
      targetId: String(id),
      actorUserId: null,
      details: {
        ban_number: row.ban_number,
        subject_user_id: userId,
        expires_at: row.expires_at,
        source: row.source,
        not_banned: externallyUnbanned,
      },
    });
    // #811: the cycle is over — an appeal still riding it closes now (the
    // ferry stops structurally, the ticket converges). Best-effort; never
    // rewrites the settle above.
    await settleEndedBanAppeals(
      row,
      externallyUnbanned
        ? "the ban was lifted outside the bot"
        : "the ban expired and was auto-unbanned",
      opts,
      log
    );
    const guildName = await resolveGuildName(opts, outbound, communityId);
    const welcome = await attemptWelcome(
      communityId,
      userId,
      row,
      opts,
      log,
      guildName
    );

    return {
      ok: true,
      acted: true,
      record: facade.getBanRecord(id),
      banNumber: banRef(row),
      status,
      externallyUnbanned,
      unbanReason,
      welcome,
    };
  } catch (err) {
    const cause = err?.message || err;
    log.error(
      `${LOG_PREFIX} finalizeExpiry errored community=${communityId} user=${userId} record=${id}:`,
      cause
    );
    return fail(`Could not finalize the ban expiry (record ${id}): ${cause}`);
  }
}

/* ═══ 3. handleExternalUnban — GuildBanRemove truth ═══════════════════════ */

/**
 * Settle the ACTIVE record behind an unban executed outside the expiry ticker
 * (GuildBanRemove, manual staff unban; #772 §2/§5). MANUAL BEATS TICKER:
 * markUnbannedManual CASes on status='active', so a claimed-but-unfinalized
 * ticker lease never blocks it — the ticker's later finalize loses that CAS
 * and reports this outcome instead of overwriting it.
 *
 * @param {object} opts { communityId, userId, unbanReason?, moderatorId?,
 *   outbound, guildName, settings, db, log, now }
 * @returns {Promise<{ ok: true, acted: true, record, banNumber, status,
 *   welcome } | { ok: false, error, record? }>}
 */
async function handleExternalUnban(opts = {}) {
  const { communityId } = opts;
  communityApi().assertCommunityId(communityId);
  const log = pickLog(opts);
  const userIdLabel = String(opts?.userId ?? "unknown");
  try {
    const userId = optionalText(opts.userId);
    if (!userId) return fail("handleExternalUnban needs the user id.");
    const facade = dbFacade();

    const active = facade.findActiveBanRecord(communityId, userId);
    if (!active) {
      // Untracked ban (never recorded, or already settled). The event layer
      // decides whether that's silence; the service names the fact.
      return fail(
        `No active ban record for <@${userId}> in this community — nothing to settle (untracked ban).`
      );
    }

    // CAS active → unbanned_manual (first event for one unban wins; a fresh
    // ticker CLAIM does not hold the status, so manual wins the race).
    const settle = facade.markUnbannedManual(
      active.id,
      optionalText(opts.unbanReason)
    );
    if (!settle.ok) {
      return failLogged(
        log,
        "external unban settle failed",
        communityId,
        userId,
        `Could not settle ban record ${banRef(active)} as unbanned_manual: ${settle.error}`
      );
    }
    if (!settle.won) {
      // CAS lost ⇒ the row already left 'active'. Re-read (settle.record IS
      // the fresh row) and exit { ok:false } with that truth — never loop,
      // never force, no outbound calls here.
      const live = settle.record ?? null;
      return failLogged(
        log,
        "external unban lost the CAS",
        communityId,
        userId,
        `Ban record **${banRef(live ?? active)}** was already settled as \`${live?.status ?? "unknown"}\` (a concurrent ticker finalize or a duplicate event won) — this event changed nothing.`
      );
    }

    systemAudit(log, {
      communityId,
      action: "banLifecycle.external_unban",
      targetType: "ban_record",
      targetId: String(active.id),
      actorUserId: optionalText(opts.moderatorId),
      details: {
        ban_number: active.ban_number,
        subject_user_id: userId,
        expires_at: active.expires_at,
        source: active.source,
        unban_reason: optionalText(opts.unbanReason),
      },
    });

    // #811: the ban is gone — close any appeal still riding it (event path
    // AND the boot reconciliation, which funnels through this entry with its
    // own cause). Best-effort; never rewrites the settle above.
    await settleEndedBanAppeals(
      active,
      optionalText(opts.banEndCause) ?? "the ban was lifted outside the bot",
      opts,
      log
    );

    const outbound = opts.outbound ?? null;
    const guildName = await resolveGuildName(opts, outbound, communityId);
    const welcome = await attemptWelcome(
      communityId,
      userId,
      active,
      opts,
      log,
      guildName
    );

    return {
      ok: true,
      acted: true,
      record: facade.getBanRecord(active.id),
      banNumber: banRef(active),
      status: "unbanned_manual",
      welcome,
    };
  } catch (err) {
    const cause = err?.message || err;
    log.error(
      `${LOG_PREFIX} handleExternalUnban errored community=${communityId} user=${userIdLabel}:`,
      cause
    );
    return fail(`Could not settle the external unban: ${cause}`);
  }
}

/* ═══ 4. handleRejoin — the ONE rejoin welcome retry ══════════════════════ */

/**
 * GuildMemberAdd retry for a parked welcome (#772 §5): the LATEST
 * pending_rejoin cycle, unban within REJOIN_WELCOME_WINDOW_DAYS, exactly one
 * attempt, `welcomed` REGARDLESS of the DM outcome.
 *
 * The claim is markWelcomed's own status CAS ('pending_rejoin' → 'welcomed',
 * banRecords' event-once law: pending rows carry welcome_dm_sent=1 already,
 * so claimWelcome structurally cannot re-open them). Read → window check →
 * markWelcomed run in ONE synchronous block (better-sqlite3 is synchronous)
 * so a double GuildMemberAdd cannot both pass the claim.
 *
 * @param {object} opts { communityId, userId, outbound, guildName, settings,
 *   db (facade), log, now }
 * @returns {Promise<{ ok: true, acted: boolean, record?, reason?, delivered? }
 *   | { ok: false, error }>}
 */
async function handleRejoin(opts = {}) {
  const { communityId } = opts;
  communityApi().assertCommunityId(communityId);
  const log = pickLog(opts);
  const userIdLabel = String(opts?.userId ?? "unknown");
  try {
    const userId = optionalText(opts.userId);
    if (!userId) return fail("handleRejoin needs the user id.");
    const facade = dbFacade();
    const nowMs = clockOf(opts);

    // Toggle-off silence BEFORE touching the row (integration bar: disabled
    // toggle → silence; the pending welcome stays parked).
    const settings = readSettings(communityId, opts);
    if (!welcomeDmEnabled(settings)) {
      return {
        ok: true,
        acted: false,
        reason: "welcome_back_dm is off — the pending welcome stays parked",
      };
    }

    // ── Sync claim block: lookup → window → markWelcomed, NO awaits ────────
    const conn = connOf(opts.db);
    const row = conn
      .prepare(
        `SELECT * FROM ban_records
          WHERE community_id=? AND user_id=? AND status='pending_rejoin'
          ORDER BY COALESCE(unban_claimed_at, banned_at) DESC, id DESC
          LIMIT 1`
      )
      .get(communityId, userId);
    if (!row) {
      return {
        ok: true,
        acted: false,
        reason: "no pending welcome-back record for this user",
      };
    }
    const anchor = Number(row.unban_claimed_at ?? row.banned_at);
    const windowMs = REJOIN_WELCOME_WINDOW_DAYS * DAY_MS;
    if (!(anchor > 0) || nowMs - anchor > windowMs) {
      // Outside window: log-only per subtask 06; the row stays parked truth.
      log.info(
        `${LOG_PREFIX} rejoin welcome skipped (outside the ${REJOIN_WELCOME_WINDOW_DAYS}-day window) community=${communityId} user=${userId} record=${row.id} (unbanned ${tsTag(anchor)})`
      );
      return {
        ok: true,
        acted: false,
        record: row,
        reason: `unban settled ${tsTag(anchor)} is outside the ${REJOIN_WELCOME_WINDOW_DAYS}-day rejoin welcome window`,
      };
    }
    const claimedRow = facade.markWelcomed(row.id); // the claim (status CAS)
    if (!claimedRow || claimedRow.status !== "welcomed") {
      return {
        ok: true,
        acted: false,
        record: claimedRow ?? null,
        reason: "another rejoin pass already claimed this record",
      };
    }
    // ── end of the atomic claim block; awaits start here ────────────────────

    const outbound = opts.outbound ?? null;
    const guildName = await resolveGuildName(opts, outbound, communityId);
    let delivered = false;
    let cause = null;
    if (typeof outbound?.sendDm === "function") {
      try {
        const dm = await outbound.sendDm(
          userId,
          buildWelcomeDm({ guildName })
        );
        delivered = dm?.ok === true;
        if (!delivered) cause = dm?.error || "sendDm returned no result";
      } catch (err) {
        cause = err?.message || err;
      }
    } else {
      cause = "the outbound has no sendDm surface";
    }

    if (delivered) {
      // Explicit recorder for the rejoin retry (claimWelcome's stamp was
      // consumed at unban time; banRecords law: success must land anyway).
      try {
        facade.recordWelcomeDmSent(row.id);
      } catch (err) {
        log.warn(
          `${LOG_PREFIX} rejoin welcome stamp failed community=${communityId} user=${userId}:`,
          err?.message || err
        );
      }
    } else {
      // One attempt made, welcomed stands (§5 regardless-of-outcome law);
      // K2: the cause lives in the log with ids, nowhere else.
      log.warn(
        `${LOG_PREFIX} rejoin welcome DM failed community=${communityId} user=${userId}: ${cause}`
      );
    }

    systemAudit(log, {
      communityId,
      action: "banLifecycle.rejoin_welcome",
      targetType: "ban_record",
      targetId: String(row.id),
      actorUserId: null,
      details: {
        ban_number: row.ban_number,
        subject_user_id: userId,
        delivered,
      },
    });

    return {
      ok: true,
      acted: true,
      delivered,
      record: facade.getBanRecord(row.id),
      banNumber: banRef(row),
      ...(delivered ? {} : { note: `welcome attempt made, delivery failed: ${cause} — record stays welcomed (one-attempt law)` }),
    };
  } catch (err) {
    const cause = err?.message || err;
    log.error(
      `${LOG_PREFIX} handleRejoin errored community=${communityId} user=${userIdLabel}:`,
      cause
    );
    return fail(`Could not run the rejoin welcome: ${cause}`);
  }
}

module.exports = {
  banUser,
  finalizeExpiry,
  handleExternalUnban,
  handleRejoin,
  // Shared vocabulary for the ticker/event layers (subtasks 06/07) and tests.
  LOG_PREFIX,
  CODE_NOT_BANNED,
  // Guarded seams for white-box tests (the public entries above are the law).
  internals: {
    guardBanSubject,
    buildExpiryUnbanReason,
    translateBanMemberError,
    attemptWelcome,
    identityReasonMatches,
  },
};
