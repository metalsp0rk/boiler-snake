/**
 * Ban lifecycle ticker (#772 §4 + §2) — the `ban-expiry` sweep and the ONE
 * boot-time reconciliation pass.
 *
 * ── What this file owns ────────────────────────────────────────────────────
 *  The SCHEDULE and the DISCOVERY of due work, nothing else. Every settle —
 *  the CAS claim, the Discord unban, the welcome claim/DM, the audit row —
 *  belongs to banService.js (read its contract header first; the service
 *  writes `banLifecycle.expiry_unban` / `banLifecycle.external_unban` through
 *  recordSystemAudit itself). This layer adds only:
 *
 *   1. runBanExpiryTick — listDueExpiredBans(now) is CROSS-community by
 *      design (the row carries its own community_id — same posture as the
 *      warnings expiry ticker), per-row try/catch → banService.finalizeExpiry.
 *      A second tick re-selecting a row the first tick already settled is
 *      structurally impossible (status leaves 'active'); a row whose unban
 *      FAILED stays active and re-claims only after the repo's lease expires
 *      — the { ok:false } "claim in flight" line is the service's truth.
 *   2. The staff-log EMBED (logs/auditLog.js has no unban embed and this
 *      task does not edit logs/) — built here in buildBanEmbed's shape
 *      (title + User/Reason fields + timestamp, EmbedBuilder) and posted on
 *      the AUDIT stream via the exported sendAuditLog, exactly the idiom
 *      logBan uses for bans (ban embeds ride the audit channel; logWarnEvent
 *      is the warn-stream twin).
 *   3. runBootReconciliation — the bounded `guild.bans` sweep for events
 *      missed during downtime (#772 §2). One listBans per guild (outbound
 *      clamps to Discord's 1000-per-page hard cap, single request). Records
 *      whose ban NO LONGER EXISTS settle through banService
 *      .handleExternalUnban — MANUAL-BEATS-TICKER CAS + audit — with the
 *      welcome DM suppressed by the service's own toggle-off silence law
 *      (§2: log-only reconciliation, NO retroactive DMs; the normal
 *      welcome/rejoin law is untouched for every future cycle).
 *
 * ── Never-throw law (AGENTS.md Error Handling) ─────────────────────────────
 * The tick returns counters, never a rejection: every row, embed, community
 * and the reconciliation pass as a whole sit inside try/catch with
 * `[banlifecycle] …` lines carrying community/user ids (rule 2). One bad
 * row never stops the batch; the scheduler's own belt stays as the last
 * resort, not the design.
 *
 * ── Idempotence ────────────────────────────────────────────────────────────
 * claimUnban stamps the lease BEFORE any await; a loser performs ZERO
 * outbound calls (manual unban / re-ban / the other pass wins — the service
 * re-reads the live row and reports it). A record the GuildBanRemove
 * listener already settled is never re-selected (not 'active'), never
 * re-unbanned, and its welcome claim stays spent.
 */

const { EmbedBuilder } = require("discord.js");
const { registerJob, stop: stopScheduledJob } = require("../../core/scheduler");
const {
  resolveDiscordClient: coreResolveDiscordClient,
  resolveOutbound: coreResolveOutbound,
} = require("../../core/outbound");
const { Color } = require("../../core/theme");
const {
  finalizeExpiry,
  handleExternalUnban,
  LOG_PREFIX,
  CODE_NOT_BANNED,
} = require("./banService");

/* ── Lazy module access (#699 law, same posture as banService/events) ──────
 * ../../db, ../../platform/community and ../logs/auditLog reach SQLite at
 * require time, so all three are CALL-TIME requires — `node -e
 * require(banLifecycle/ticker)` must stay loadable with no database bound. */
const dbFacade = () => require("../../db");
const communityApi = () => require("../../platform/community");
const auditLogApi = () => require("../logs/auditLog");

/** Scheduler job name (also the tests' scheduler.runNow handle). */
const JOB_NAME = "ban-expiry";

/** Minute cadence, aligned to wall-clock boundaries (voice-ticker idiom). */
const TICK_INTERVAL_MS = 60_000;

/** Rows settled per tick (the warnings ticker's 50-row bound; the rest ride
 * the next minute — nothing is lost, `expires_at <= now` keeps matching). */
const TICK_ROW_LIMIT = 50;

/* Boot-sweep bounds (issue §2 "BOUNDED guild.bans sweep"). The repo exposes
 * per-community active lists only, so the community set comes from ONE
 * capped grouped read below; a bot back from downtime with thousands of
 * guilds full of active bans settles newest-first across boots instead of
 * pinning the event loop on start. */
const RECONCILE_MAX_COMMUNITIES = 25;
const RECONCILE_MAX_ROWS_PER_COMMUNITY = 200;

/** Discord's hard per-page ban-list cap. outbound.listBans clamps to this
 * and sends exactly ONE request (bounded single-read contract, #772); a
 * FULL page means absence proves nothing → per-row fetchBan instead. */
const BAN_PAGE_LIMIT = 1000;

/** Audit-stream color for unban embeds: Color.muted is the token's declared
 * "voided, closed, removed" meaning (core/theme.js). */
const COLOR_UNBAN = Color.muted;

/** Guild-side settle reason for reconciliation-detached bans. Staff-facing
 * audit copy only — no user DM ever carries it (§2 log-only law). */
const RECONCILE_UNBAN_REASON =
  "Ban no longer exists on Discord — settled by ban-lifecycle boot reconciliation";

const FIELD_TRUNCATE = 900;

/* ── Tiny readers ─────────────────────────────────────────────────────────── */

/** Positive finite int or null (limits, injected clocks). */
function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** `<t:UNIX:F>` for embed/audit copy; unknown times render honestly. */
function tsTag(ms) {
  const n = positiveInt(ms);
  return n ? `<t:${Math.floor(n / 1000)}:F>` : "an unknown time";
}

/** `<t:UNIX:R>` relative twin (Discord renders client-side). */
function tsRelative(ms) {
  const n = positiveInt(ms);
  return n ? `<t:${Math.floor(n / 1000)}:R>` : "an unknown time";
}

/** Human ban ref (display form of ban_number, sibling of W-n / B-n). */
function banRef(row) {
  return `B-${row?.ban_number ?? "?"}`;
}

/** Field-length-safe embed text. */
function truncate(str, max = FIELD_TRUNCATE) {
  if (str == null) return "";
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/* ── Supervisor plumbing (the warnings ticker's label-bind posture) ──────── */

function resolveDiscordClient(supervisor) {
  return coreResolveDiscordClient(supervisor, { label: "banlifecycle" });
}

function resolveOutbound(supervisor, communityId) {
  return coreResolveOutbound(supervisor, communityId, { label: "banlifecycle" });
}

/** Client read that can never kill a sweep (only a non-supervisor object
 * throws in core/outbound — a programmer error worth naming, then null). */
function safeDiscordClient(supervisor) {
  try {
    return resolveDiscordClient(supervisor);
  } catch (err) {
    console.error(`${LOG_PREFIX} discord client resolution failed:`, err?.message || err);
    return null;
  }
}

function safeOutbound(supervisor, communityId) {
  try {
    return resolveOutbound(supervisor, communityId);
  } catch (err) {
    console.error(
      `${LOG_PREFIX} outbound resolution failed community=${communityId}:`,
      err?.message || err,
    );
    return null;
  }
}

/** Cache-first decorative moderator label for the §4 unban reason
 * ("… by <staff>"). No REST storm from a tick: a cache miss honestly
 * falls back to the id via banService.staffLabel. */
function moderatorNameResolver(client) {
  return (moderatorId) => {
    const user = client?.users?.cache?.get?.(String(moderatorId));
    return user?.tag ?? user?.username ?? null;
  };
}

/** Compact welcome-outcome copy for the embed field (the events listener
 * keeps the log-line twin; embeds are this layer's job). */
function describeWelcomeOutcome(welcome) {
  if (welcome == null || typeof welcome !== "object") return "Not attempted";
  if (welcome.delivered) return "Welcome DM delivered";
  if (welcome.skipped) return `Welcome DM skipped — ${welcome.skipped}`;
  if (welcome.parked) return `Welcome DM failed → parked for rejoin (${truncate(welcome.error ?? "no cause", 120)})`;
  if (welcome.attempted) return `Welcome DM failed (${truncate(welcome.error ?? "no cause", 120)})`;
  if (welcome.error) return `Welcome DM not attempted (${truncate(welcome.error, 120)})`;
  return "Not attempted";
}

/* ── Staff-log embed (#772 §4: one embed per auto-unban) ───────────────────
 * Shape sibling of logs/auditLog.js buildBanEmbed (title + User + Reason +
 * timestamp) — unbans simply carry the lifecycle facts the events.js header
 * contract pins: record id, banNumber, status, source, subject, reason and
 * the welcome outcome. Posted on the AUDIT stream via the exported
 * sendAuditLog; allowedMentions parse-off is stamped by auditLog's send
 * choke (#475), so `<@id>` fields can never ping. */

function buildUnbanEmbed({ row, result }) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_UNBAN)
    .setTitle(
      result?.externallyUnbanned
        ? "Expired ban lifted outside the bot — record settled"
        : "Temporary ban expired — member unbanned"
    )
    .setTimestamp(new Date())
    .addFields(
      { name: "User", value: `<@${row.user_id}> (\`${row.user_id}\`)`, inline: true },
      {
        name: "Ban",
        value: `${banRef(row)} (record ${row.id})`,
        inline: true,
      },
      { name: "Source", value: row.source === "automod" ? "Automod harness" : "Staff", inline: true },
      { name: "Status", value: String(result?.status ?? row.status ?? "unknown"), inline: true },
      { name: "Banned", value: tsTag(row.banned_at), inline: true },
      {
        name: "Expired",
        value: row.expires_at ? `${tsTag(row.expires_at)} (${tsRelative(row.expires_at)})` : "—",
        inline: true,
      },
    );

  embed.addFields({
    name: "Unban reason",
    value: truncate(result?.unbanReason) || "*No reason recorded*",
  });
  embed.addFields({
    name: "Welcome DM",
    value: describeWelcomeOutcome(result?.welcome),
  });
  return embed;
}

/** Best-effort staff-log post: embed-build or send failures log with ids
 * and change nothing else (the record + audit row are already durable). */
async function postUnbanEmbed(outbound, guildId, row, result) {
  if (!outbound || !guildId) return; // no route — the audit row stays the record
  try {
    const { sendAuditLog } = auditLogApi();
    const embed = buildUnbanEmbed({ row, result });
    await sendAuditLog(outbound, guildId, { embeds: [embed] });
    // sendAuditLog resolves false only on stream-off/failed sends, every
    // cause already console.warn'ed inside auditLog with context (#445) —
    // a second generic line here would be the noise AGENTS.md bans.
  } catch (err) {
    console.error(
      `${LOG_PREFIX} unban embed failed community=${row.community_id} user=${row.user_id} ${banRef(row)}:`,
      err?.message || err,
    );
  }
}

/* ═══ 1. The minute tick — due-row expiry sweep (#772 §4) ═══════════════════ */

/**
 * One expiry sweep across every guild (per-row scope comes from the rows).
 * Never rejects; reports counters. The toggles, the CAS law, the DM copy and
 * the audit rows all live in banService.finalizeExpiry.
 *
 * @param {object|null} supervisor PR 7 supervisor ({ discord, fluxer,
 *        clientForCommunity }); null tolerated (rows then settle-claim and
 *        the service reports "no unbanMember surface" honestly — nothing crashes)
 * @param {{ now?: number, limit?: number, reconcile?: boolean }} [opts]
 *        injectable clock + row bound (tests); `reconcile: true` runs the
 *        boot reconciliation after the sweep (start() does exactly that on
 *        the immediate first fire)
 * @returns {Promise<{ processed: number, unbanned: number, welcomed: number,
 *          skipped: number, errors: number, reconciliation?: object }>}
 */
async function runBanExpiryTick(supervisor, opts = {}) {
  const nowMs = positiveInt(opts.now) ?? Date.now();
  const limit = positiveInt(opts.limit) ?? TICK_ROW_LIMIT;
  const out = { processed: 0, unbanned: 0, welcomed: 0, skipped: 0, errors: 0 };

  try {
    const facade = dbFacade();
    const due = facade.listDueExpiredBans(nowMs).slice(0, limit);
    out.processed = due.length;

    // One client read per tick: the cache-first moderator-name belt below.
    const client = safeDiscordClient(supervisor);

    for (const row of due) {
      try {
        const communityId = row.community_id;
        const community = communityApi().getCommunityById(communityId);
        const guildId = community?.externalGuildId ?? null;
        if (!guildId) {
          console.error(
            `${LOG_PREFIX} no communities row for community ${communityId}; ` +
              `skipping Discord-side logging for ${banRef(row)}`,
          );
        }
        const outbound = safeOutbound(supervisor, communityId);

        const result = await finalizeExpiry(row, {
          communityId,
          outbound,
          guildId,
          resolveModeratorName: moderatorNameResolver(client),
          ...(positiveInt(opts.now) ? { now: nowMs } : {}),
        });

        if (result?.ok === true && result.acted === true) {
          out.unbanned += 1;
          if (result.welcome?.delivered === true) out.welcomed += 1;
          // One embed per ACTED row (§4); failures earn only their log lines.
          await postUnbanEmbed(outbound, guildId, row, result);
        } else {
          // { ok:false } — the service already logged the line it owns with
          // ids. The live status decides the bucket: a row that left
          // 'active' (manual unban / re-ban / the other pass won) is the
          // CAS-loss SKIP this sweep is designed around; a row still
          // 'active' needed work it did not get → error accounting.
          let live = null;
          try {
            live = facade.getBanRecord(row.id);
          } catch {
            live = null; // unreadable truth stays honestly null below
          }
          if (live && live.status !== "active") {
            out.skipped += 1;
            console.log(
              `${LOG_PREFIX} expiry changed nothing community=${communityId} ` +
                `user=${row.user_id} ${banRef(row)}: already settled as \`${live.status}\` — ` +
                `${result?.error || "the service reported no reason"}`,
            );
          } else {
            out.errors += 1;
          }
        }
      } catch (err) {
        out.errors += 1;
        console.error(
          `${LOG_PREFIX} expiry tick row failed community=${row?.community_id} ` +
            `user=${row?.user_id} record=${row?.id}:`,
          err?.message || err,
        );
      }
    }
  } catch (err) {
    // The sweep plumbing itself blew (db read, supervisor shape) — the rows
    // never ran; say so with the cause, still without rejecting.
    out.errors += 1;
    console.error(`${LOG_PREFIX} expiry tick failed:`, err?.message || err);
  }

  if (opts.reconcile === true) {
    out.reconciliation = await runBootReconciliation(supervisor, opts);
  }
  return out;
}

/* ═══ 2. Boot reconciliation — events missed while the bot was down (§2) ════
 * For every Discord community that still carries ACTIVE ban rows: ONE
 * bounded listBans per guild; an active record whose user is NOT on a
 * COMPLETE ban page has had its ban lifted outside the bot → settle through
 * banService.handleExternalUnban (the same CAS + audit path the GuildBanRemove
 * listener uses — "handleExternalUnban-equivalent") with the welcome path
 * silenced by the service's own toggle-off law: reconciliation is LOG-ONLY,
 * no retroactive DM for an unban whose moment we cannot date (§2; the normal
 * welcome/rejoin law rides every future cycle untouched).
 * A FULL page (== the 1000 cap) proves nothing by absence → exact per-row
 * fetchBan instead, still bounded by RECONCILE_MAX_ROWS_PER_COMMUNITY.
 * Missing guild/client/list permission → log + skip; one community never
 * cancels the rest of the sweep. */

const reconcileScopeSql = () =>
  dbFacade()
    .db.prepare(
      `SELECT b.community_id AS communityId
         FROM ban_records b
         JOIN communities c ON c.id = b.community_id
        WHERE b.status='active' AND c.platform='discord'
        GROUP BY b.community_id
        ORDER BY MAX(b.banned_at) DESC
        LIMIT ?`
    );

async function reconcileCommunity(supervisor, communityId, facade, opts, out) {
  const community = communityApi().getCommunityById(communityId);
  const guildId = community?.externalGuildId ?? null;
  if (!guildId) {
    console.warn(
      `${LOG_PREFIX} reconciliation skipped community=${communityId}: no communities row to list bans in`,
    );
    out.skipped += 1;
    return;
  }
  const outbound = safeOutbound(supervisor, communityId);
  if (!outbound || typeof outbound.listBans !== "function") {
    console.warn(
      `${LOG_PREFIX} reconciliation skipped community=${communityId} guild=${guildId}: no outbound with a listBans surface`,
    );
    out.skipped += 1;
    return;
  }

  const active = facade
    .listReconcilableActiveBans(communityId)
    .slice(0, positiveInt(opts.maxRowsPerCommunity) ?? RECONCILE_MAX_ROWS_PER_COMMUNITY);
  if (active.length === 0) return;

  const page = await outbound.listBans(communityId, { limit: BAN_PAGE_LIMIT });
  if (!page || page.ok !== true) {
    // Missing guild / permissions / dead client — log the cause and move on
    // to the next community (§2: reconcile tolerates missing guilds).
    console.warn(
      `${LOG_PREFIX} reconciliation skipped community=${communityId} guild=${guildId}: ` +
        `listBans failed: ${page?.error || "listBans returned no result"}`,
    );
    out.skipped += 1;
    return;
  }

  const banned = new Set((page.data ?? []).map((b) => String(b.userId)));
  const pageComplete = (page.data?.length ?? 0) < BAN_PAGE_LIMIT;
  if (!pageComplete && typeof outbound.fetchBan !== "function") {
    console.warn(
      `${LOG_PREFIX} reconciliation skipped community=${communityId} guild=${guildId}: ` +
        `ban page hit the ${BAN_PAGE_LIMIT}-entry cap and the outbound has no fetchBan to confirm against`,
    );
    out.skipped += 1;
    return;
  }

  for (const row of active) {
    out.checked += 1;
    try {
      let vanished;
      if (pageComplete) {
        vanished = !banned.has(String(row.user_id));
      } else {
        // Truncated page: absence from the page is NOT the fact — fetch the
        // exact ban. NOT_BANNED (10026) is; any other error is unknown, and
        // unknown never settles a record.
        const ban = await outbound.fetchBan(communityId, String(row.user_id));
        if (ban?.ok === true) vanished = false;
        else if (ban?.code === CODE_NOT_BANNED) vanished = true;
        else {
          out.errors += 1;
          console.error(
            `${LOG_PREFIX} reconciliation fetch failed community=${communityId} ` +
              `user=${row.user_id} ${banRef(row)}: ${ban?.error || "fetchBan returned no result"}`,
          );
          continue;
        }
      }
      if (!vanished) continue;

      // Log-only settle: settings override forces the service's
      // welcome-path silence law (claim unspent, row untouched by the DM
      // layer) so §2's "no retroactive DMs" is structural, not a convention.
      const settled = await handleExternalUnban({
        communityId,
        userId: String(row.user_id),
        outbound,
        guildId,
        unbanReason: RECONCILE_UNBAN_REASON,
        settings: { welcome_back_dm: 0 },
        ...(positiveInt(opts.now) ? { now: positiveInt(opts.now) } : {}),
      });
      if (settled?.ok === true && settled.acted === true) {
        out.reconciled += 1;
        console.log(
          `${LOG_PREFIX} reconciled vanished ban community=${communityId} ` +
            `guild=${guildId} user=${row.user_id} ${settled.banNumber ?? banRef(row)} → ${settled.status}`,
        );
      } else {
        // CAS lost / concurrent settle — the service logged its reason with
        // ids; an info line adds the guild the service cannot see.
        out.skipped += 1;
        console.log(
          `${LOG_PREFIX} reconciliation changed nothing community=${communityId} ` +
            `guild=${guildId} user=${row.user_id}: ${settled?.error || "the service reported no reason"}`,
        );
      }
    } catch (err) {
      out.errors += 1;
      console.error(
        `${LOG_PREFIX} reconciliation row failed community=${communityId} ` +
          `user=${row.user_id} record=${row.id}:`,
        err?.message || err,
      );
    }
  }
}

/**
 * The ONE boot reconciliation pass (called from start()'s immediate first
 * fire; exported so tests and the orchestrator can drive it directly).
 * Never rejects.
 *
 * @param {object|null} supervisor PR 7 supervisor
 * @param {{ now?: number, maxCommunities?: number, maxRowsPerCommunity?: number }} [opts]
 * @returns {Promise<{ communities: number, checked: number, reconciled: number,
 *          skipped: number, errors: number }>}
 */
async function runBootReconciliation(supervisor, opts = {}) {
  const out = { communities: 0, checked: 0, reconciled: 0, skipped: 0, errors: 0 };
  try {
    const facade = dbFacade();
    const scope = reconcileScopeSql().all(
      positiveInt(opts.maxCommunities) ?? RECONCILE_MAX_COMMUNITIES,
    );
    if (scope.length === 0) return out;
    console.log(
      `${LOG_PREFIX} boot reconciliation: sweeping ${scope.length} communit${scope.length === 1 ? "y" : "ies"} with active ban records`,
    );
    for (const { communityId } of scope) {
      out.communities += 1;
      try {
        await reconcileCommunity(supervisor, Number(communityId), facade, opts, out);
      } catch (err) {
        out.errors += 1;
        console.error(
          `${LOG_PREFIX} reconciliation sweep failed community=${communityId}:`,
          err?.message || err,
        );
      }
    }
  } catch (err) {
    out.errors += 1;
    console.error(`${LOG_PREFIX} boot reconciliation failed:`, err?.message || err);
  }
  return out;
}

/* ═══ 3. start / stop (subtask 09's index.js returns this handle) ═══════════ */

/**
 * Register the minute-aligned `ban-expiry` job. No raw wall-clock timer here
 * — core/scheduler owns the timers (#462 ticker law): aligned to minute
 * boundaries, overlap 'skip' (a slow Discord must not stack sweeps), and
 * runImmediately so rows that expired during downtime unban on boot
 * (§4: "on startup, expired rows unban immediately"). The same immediate
 * first fire carries the ONE reconciliation pass (§2); every later tick is
 * the pure expiry sweep.
 *
 * @param {object|null} supervisor PR 7 supervisor
 * @param {object} [featureCtx] load.js feature context (unused)
 * @returns {{ stop: () => void }} loop handle for the boot drain
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  let reconciled = false; // one boot pass per process, even if it fails
  registerJob({
    name: JOB_NAME,
    intervalMs: TICK_INTERVAL_MS,
    align: true,
    overlap: "skip",
    runImmediately: true,
    run: () => {
      if (reconciled) return runBanExpiryTick(supervisor);
      reconciled = true;
      return runBanExpiryTick(supervisor, { reconcile: true });
    },
  });
  console.log("[banlifecycle] ban-expiry ticker started (every minute, immediate first pass)");
  return { stop: () => stopScheduledJob(JOB_NAME) };
}

module.exports = {
  JOB_NAME,
  TICK_ROW_LIMIT,
  RECONCILE_MAX_COMMUNITIES,
  RECONCILE_MAX_ROWS_PER_COMMUNITY,
  start,
  runBanExpiryTick,
  runBootReconciliation,
  // Guarded seams for white-box tests (the scheduler job above is the law).
  internals: {
    buildUnbanEmbed,
    describeWelcomeOutcome,
    reconcileCommunity,
  },
};
