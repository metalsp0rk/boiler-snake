/**
 * Ban lifecycle gateway listeners (#772 §5) — the two events nothing consumed
 * before this feature: GuildBanRemove (a manual unban by any staff member or
 * another bot) and GuildMemberAdd (the missed-welcome rejoin retry).
 *
 * THIN LISTENER LAW: no ban business logic lives here. Every decision — the
 * CAS settle, the welcome claim, the DM copy, the 30-day rejoin window, the
 * per-guild toggles, the audit rows — belongs to banService.js (read its
 * contract header first). This file only turns a gateway event into ONE
 * service call and reports the outcome:
 *
 *   GuildBanRemove → banService.handleExternalUnban
 *                    (CAS active → 'unbanned_manual', manual beats a claimed
 *                    ticker lease, then the welcome path)
 *   GuildMemberAdd → banService.handleRejoin
 *                    (latest 'pending_rejoin' row inside the window → exactly
 *                    one attempt → 'welcomed' regardless of the DM outcome)
 *
 * ── Edge decisions (why they belong in this file) ──────────────────────────
 *  - Community: the gateway hands us a snowflake, so this IS the edge — the
 *    snowflake becomes the internal integer through ensureCommunity
 *    (platform/community.js § "edges call ensureCommunity"; the #389
 *    first-sight memo makes a guild we already know a zero-statement read).
 *    A ban we never tracked bails SILENTLY at the active-record gate below —
 *    no service call, no audit-log read, no log line.
 *  - Outbound: the per-community OutboundClient through core/outbound —
 *    #462's ONE resolver, i.e. boot.js's clientForCommunity — so a Discord
 *    event can never be answered through the wrong platform's client. null
 *    (a degraded Discord hold) is a supported fact: the service parks the
 *    welcome as 'pending_rejoin' with a specific cause instead of crashing.
 *  - Moderator: GUILD_BAN_REMOVE carries no executor and its `reason` is the
 *    stored ban reason, so the STAFF-side audit actor comes from the guild's
 *    own audit log through logs/auditLog.fetchRecentAuditEntry
 *    (MemberBanRemove inside a bounded lookback — the idiom logBan uses) and
 *    rides into the service as `moderatorId`, which lands as
 *    recordSystemAudit's actorUserId on banLifecycle.external_unban. No
 *    View Audit Log → a null actor, never a guess (#772 §5 keeps the
 *    moderator out of user-facing DM copy either way).
 *  - Staff-log EMBED: logs/auditLog.js has NO unban embed today (grep:
 *    logUnban / buildUnbanEmbed → none), and this file does not edit logs/.
 *    §4's audit row is therefore banService's own recordSystemAudit plus the
 *    `[banlifecycle]` fact lines below. Whoever lands the embed (the expiry
 *    ticker task, #772 §4) builds it from the facts reported here: record id,
 *    banNumber, status, source, subject user, moderatorId, unbanReason and
 *    the welcome outcome — all four unban entries (this listener, the
 *    ticker, a re-ban) should post the same shape.
 *
 * ── Detached-async law (AGENTS.md § Error Handling 1) ──────────────────────
 * Both listeners are fire-and-forget: the promise carries a whole-body
 * try/catch AND a `.catch()` belt, so a DB or DM blowup logs
 * `[banlifecycle] … failed: …` with the guild/user ids and can never reach
 * the emitter, kill the gateway loop, or surface as an unhandled rejection.
 */

const { Events, AuditLogEvent } = require("discord.js");
const {
  resolveDiscordClient,
  resolveOutbound,
} = require("../../core/outbound");
const {
  handleExternalUnban,
  handleRejoin,
  LOG_PREFIX,
} = require("./banService");

/** Label for core/outbound's own lines ([banlifecycle] clientForCommunity…). */
const LOG_TAG = "banlifecycle";

/**
 * Executor-lookup horizon for the unban audit read. Same order as logBan's
 * (10 s): an older MemberBanRemove entry belongs to a different unban and
 * naming the wrong staffer is worse than naming nobody.
 */
const UNBAN_AUDIT_MAX_AGE_MS = 10_000;
const UNBAN_AUDIT_DELAY_MS = 400;

/* ── Lazy module access (#699 law) ──────────────────────────────────────────
 * platform/community.js, db/index.js and logs/auditLog.js reach SQLite at
 * require time, so all three are CALL-TIME requires — this module must stay
 * loadable with no database bound (banService.js defers the same requires for
 * the same reason). Pure discord.js, core/outbound and banService (whose own
 * db access is lazy) are the only top-level requires. */
const dbFacade = () => require("../../db");
const communityApi = () => require("../../platform/community");
const auditLogApi = () => require("../logs/auditLog");

/* ── Tiny readers ─────────────────────────────────────────────────────────── */

/** Trim-to-null: "" and null are the same absent fact. */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * Snowflake reader tolerant of entities ({ id }), wrapper objects
 * ({ guildId }) and bare string/number ids, so no caller shape slips a
 * non-snowflake past assertCommunityId unnoticed.
 */
function idOf(value, altKey = null) {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") {
    return optionalText(String(value));
  }
  if (typeof value !== "object") return null;
  return optionalText(altKey ? value.id ?? value[altKey] : value.id);
}

/**
 * One reader for both GuildBanRemove shapes: discord.js v14 emits a GuildBan
 * ({ guild, user, reason } — client/actions/GuildBanRemove.js), the pre-v14
 * signature passed (guild, user). Facts stay platform objects + ids.
 */
function readUnbanFacts(banLike, legacyUser) {
  const isGuildBan =
    banLike != null &&
    typeof banLike === "object" &&
    (banLike.user != null || banLike.guild != null);
  const guild = isGuildBan ? banLike.guild ?? null : banLike ?? null;
  const user = isGuildBan ? banLike.user ?? null : legacyUser ?? banLike ?? null;
  return {
    guild,
    guildId: idOf(guild, "guildId"),
    guildName: optionalText(guild?.name),
    userId: idOf(user),
    reason: optionalText(banLike?.reason),
  };
}

/**
 * Edge resolution: the guild snowflake → the internal integer community id.
 * Idempotent insert-on-first-sight (the community registry's edge law).
 * @returns {number|null} null only when there is no snowflake to resolve.
 */
function communityIdForGuild(guildId) {
  const externalGuildId = idOf(guildId);
  if (!externalGuildId) return null;
  return communityApi().ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId,
  });
}

/** Compact welcome-path summary for the fact line (never a raw object dump). */
function describeWelcome(welcome) {
  if (welcome == null || typeof welcome !== "object") return "not reported";
  if (welcome.delivered) return "delivered";
  if (welcome.skipped) return `skipped (${welcome.skipped})`;
  if (welcome.parked) {
    return `failed → ${welcome.parked} (${welcome.error ?? "no cause"})`;
  }
  if (welcome.attempted) return `failed (${welcome.error ?? "no cause"})`;
  if (welcome.error) return `not attempted (${welcome.error})`;
  return "not attempted";
}

/** The single failure shape for both listeners (rule 2: ids + specific cause). */
function reportFailure(what, ids, err) {
  console.error(
    `${LOG_PREFIX} ${what} failed guild=${ids?.guildId ?? "?"} ` +
      `user=${ids?.userId ?? "?"} community=${ids?.communityId ?? "?"}:`,
    err?.message || err,
  );
}

/* ── Staff attribution (guild-side only) ──────────────────────────────────── */

/**
 * Who lifted the ban, from the guild's own audit log. Decorative-but-audited:
 * every failure path (no View Audit Log, no matching entry, a mock guild
 * without the surface) yields null and the flow continues with an unnamed
 * moderator.
 *
 * @returns {Promise<{ moderatorId: string|null, reason: string|null }|null>}
 */
async function resolveUnbanModerator(guild, userId) {
  if (!guild || typeof guild.fetchAuditLogs !== "function") return null;
  const action = AuditLogEvent?.MemberBanRemove;
  if (action == null) {
    // Never fetch an untyped audit page: the newest entry of ANY action
    // would misattribute the unban to whoever did something else last.
    return null;
  }
  try {
    const entry = await auditLogApi().fetchRecentAuditEntry(
      guild,
      action,
      userId,
      { maxAgeMs: UNBAN_AUDIT_MAX_AGE_MS, delayMs: UNBAN_AUDIT_DELAY_MS },
    );
    if (!entry) return null;
    return {
      moderatorId: idOf(entry.executorId ?? entry.executor),
      reason: optionalText(entry.reason),
    };
  } catch (err) {
    // Rule 2 with ids; the unban settles regardless of this read.
    console.warn(
      `${LOG_PREFIX} unban executor read failed guild=${idOf(guild, "id")} ` +
        `user=${userId}:`,
      err?.message || err,
    );
    return null;
  }
}

/* ══ GuildBanRemove — a manual unban keeps the record truthful ══════════════ */

/**
 * Any unban of a tracked ban (staff, another bot, an external tool) settles
 * the active record as 'unbanned_manual' and runs the welcome path through
 * the service. Never throws; reports through the logger.
 */
async function onGuildBanRemove(supervisor, client, banLike, legacyUser) {
  const ids = { guildId: null, userId: null, communityId: null };
  try {
    const facts = readUnbanFacts(banLike, legacyUser);
    ids.guildId = facts.guildId;
    ids.userId = facts.userId;
    if (!facts.guildId || !facts.userId) return; // nothing to key the fact on

    const communityId = communityIdForGuild(facts.guildId);
    if (communityId == null) return; // no snowflake → nothing to resolve
    ids.communityId = communityId;

    // Untracked ban (never recorded, or already settled): silent and cheap —
    // no service call, no audit-log read. The service re-reads the same row
    // as its own truth, so this gate is a fast path, never a decision.
    if (!dbFacade().findActiveBanRecord(communityId, facts.userId)) return;

    const moderator = await resolveUnbanModerator(facts.guild, facts.userId);
    const result = await handleExternalUnban({
      communityId,
      userId: facts.userId,
      outbound: resolveOutbound(supervisor, communityId, { label: LOG_TAG }),
      guildId: facts.guildId,
      guildName: facts.guildName,
      // Belt: banService reads `client` only through its guard seams, which
      // this path does not run. Injected anyway so the entry never has to
      // reach around the caller for the client that produced the event.
      client,
      db: dbFacade(),
      moderatorId: moderator?.moderatorId ?? null,
      unbanReason: moderator?.reason ?? facts.reason,
    });

    if (result?.ok === true) {
      // §4's staff-facing fact line (the audit row itself is the service's
      // recordSystemAudit). Facts an unban embed will need are listed here.
      console.log(
        `${LOG_PREFIX} manual unban settled community=${communityId} ` +
          `guild=${facts.guildId} user=${facts.userId} ` +
          `record=${result.banNumber ?? result.record?.id ?? "?"} ` +
          `status=${result.status ?? "unbanned_manual"} ` +
          `moderator=${moderator?.moderatorId ?? "unknown"} ` +
          `reason=${result.record?.unban_reason ?? facts.reason ?? "none"} ` +
          `welcome=${describeWelcome(result.welcome)}`,
      );
      return;
    }

    // { ok:false } is an EXPECTED outcome on this path: the CAS was lost (the
    // expiry ticker or a duplicate event won — "manual wins vs ticker" is
    // settled by whichever writer got there first) or the record left 'active'
    // between the gate and the settle. Info line, not an error; banService
    // already logs at warn/error the failures it owns, with the same ids.
    console.log(
      `${LOG_PREFIX} external unban changed nothing community=${communityId} ` +
        `guild=${facts.guildId} user=${facts.userId}: ` +
        `${result?.error || "the service reported no reason"}`,
    );
  } catch (err) {
    reportFailure("GuildBanRemove", ids, err);
  }
}

/* ══ GuildMemberAdd — the ONE rejoin welcome retry ══════════════════════════ */

/**
 * A member joined: hand the fact to the service, which decides everything
 * (a 'pending_rejoin' row exists? inside REJOIN_WELCOME_WINDOW_DAYS? the
 * toggle on? the claim won?). Never throws; reports through the logger.
 */
async function onGuildMemberAdd(supervisor, client, member) {
  const ids = { guildId: null, userId: null, communityId: null };
  try {
    const guild = member?.guild ?? null;
    const guildId = idOf(guild, "guildId") ?? idOf(member, "guildId");
    // GuildMember#id IS the user id; read the user object first when present.
    const userId = idOf(member?.user) ?? idOf(member);
    ids.guildId = guildId;
    ids.userId = userId;
    if (!guildId || !userId) return;

    const communityId = communityIdForGuild(guildId);
    if (communityId == null) return;
    ids.communityId = communityId;

    const result = await handleRejoin({
      communityId,
      userId,
      outbound: resolveOutbound(supervisor, communityId, { label: LOG_TAG }),
      guildId,
      guildName: optionalText(guild?.name),
      client,
      db: dbFacade(),
    });

    if (result?.ok === true) {
      // acted=false is the ordinary join (no parked welcome for this user) —
      // the service logs the interesting skips itself (window, toggle-off),
      // so silence here keeps every honest join off the log.
      if (result.acted) {
        console.log(
          `${LOG_PREFIX} rejoin welcome community=${communityId} ` +
            `guild=${guildId} user=${userId} ` +
            `record=${result.banNumber ?? result.record?.id ?? "?"} ` +
            `delivered=${result.delivered === true}` +
            (result.note ? ` note=${result.note}` : ""),
        );
      }
      return;
    }

    // Unlike the unban path, handleRejoin reports { ok:false } ONLY when it
    // threw (its expected refusals are { ok:true, acted:false }) — an
    // anomaly worth the error level, with the guild id the service cannot see.
    console.error(
      `${LOG_PREFIX} rejoin welcome failed community=${communityId} ` +
        `guild=${guildId} user=${userId}: ` +
        `${result?.error || "the service reported no reason"}`,
    );
  } catch (err) {
    reportFailure("GuildMemberAdd", ids, err);
  }
}

/* ══ Bindings ═══════════════════════════════════════════════════════════════ */

/**
 * Bind the ban-lifecycle gateway hooks (feature-events idiom: the first
 * argument is the PR 7 supervisor and binds attach to supervisor.discord
 * only — #772 is Discord-only by design, explicit Fluxer no-parity).
 *
 * The intents this needs (GuildModeration, GuildMembers) are already declared
 * in src/client.js; nothing here changes them.
 *
 * @param {object|null} supervisor { discord, fluxer, clientForCommunity };
 *        null (a Discord-less boot) is a no-op bind, and a raw/foreign object
 *        throws by design (#462: the pre-PR-7 raw-client leg is gone —
 *        src/features/load.js logs it per feature)
 * @param {object} [featureCtx]
 */
function registerEvents(supervisor, featureCtx) {
  void featureCtx;
  const client = resolveDiscordClient(supervisor, { label: LOG_TAG });
  if (!client) return; // Discord unconfigured → no-op binds

  client.on(Events.GuildBanRemove, (ban, legacyUser) => {
    // Detached async: the .catch is the outer belt under the handler's own
    // try/catch, so nothing reaches the emitter in any shape.
    onGuildBanRemove(supervisor, client, ban, legacyUser).catch((err) =>
      reportFailure(
        "GuildBanRemove",
        { guildId: idOf(ban?.guild ?? ban, "guildId"), userId: idOf(ban?.user ?? legacyUser ?? ban) },
        err,
      ),
    );
  });

  client.on(Events.GuildMemberAdd, (member) => {
    onGuildMemberAdd(supervisor, client, member).catch((err) =>
      reportFailure(
        "GuildMemberAdd",
        {
          guildId: idOf(member?.guild ?? member, "guildId"),
          userId: idOf(member?.user ?? member),
        },
        err,
      ),
    );
  });
}

module.exports = {
  registerEvents,
  // Guarded seams for white-box tests (the gateway binding above is the law).
  internals: {
    onGuildBanRemove,
    onGuildMemberAdd,
    readUnbanFacts,
    communityIdForGuild,
    resolveUnbanModerator,
    describeWelcome,
  },
};
