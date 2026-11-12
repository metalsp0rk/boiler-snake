/**
 * Ban lifecycle (#772) — offline full-stack integration suite.
 *
 * Boots createIntegrationEnv (temp SQLite + the REAL registry/ router: the
 * boot-wired banLifecycle feature contributes /ban, /bannotify, the
 * "Ban member" user menu and the `bl:ban:` modal through
 * buildDefaultRegistry → applyFeaturesToRegistry; the mock guild's
 * _bans/_unbans/bans.fetch surfaces from subtask 02 are the Discord-side
 * truth). The gateway listeners are the REAL feature binds — events.registerEvents
 * over the harness's PR 7 supervisor, exactly the shape load.js wires at boot —
 * so GuildBanRemove / GuildMemberAdd are dispatched through client.emit.
 *
 * Covers (issue #772 "Repo bar" integration bullet + subtask 12):
 *   1. happy full loop: /ban (member + reason + 24h) → ban DM BEFORE the ban
 *      executes (order proven from an interleaved mock call log) → expiry tick
 *      → one auto-unban with the §4 reason → exactly one welcome DM → row
 *      expired_unbanned; a second sweep is silent;
 *   2. the booted scheduler job 'ban-expiry' (ticker.start → runImmediately →
 *      runNow → stop) — driven through core/scheduler's own test hooks;
 *   3. modal flow: missing reason opens the shared modal; submit '7d' bans
 *      once; invalid Duration rejects naming the field with an example and
 *      bans NOTHING (slash-inline AND modal-submit arms — #745);
 *   4. "Ban member" context menu → modal → single ban; token replay refuses;
 *   5. duplicate /ban while active → refusal quoting B-1, zero outbound;
 *   6. failed ban DM surfaces staff-side but never blocks the ban (K2);
 *   7. manual-unban event path through the real GuildBanRemove listener +
 *      the CAS law in both directions (manual beats a claimed ticker lease;
 *      the event twin of the bot's OWN expiry unban stays silent) — exactly
 *      one unban outbound call and one welcome per cycle;
 *   8. rejoin fallback: failed welcome parks pending_rejoin; GuildMemberAdd
 *      inside the 30-day window retries exactly once → welcomed regardless
 *      of outcome; outside the window → untouched, silent;
 *   9. /bannotify toggles: ban off → bans land with zero DMs; welcome off →
 *      unbans are silent; status lists both;
 *  10. downtime reconciliation: an active row whose ban vanished outside the
 *      bot settles unbanned_manual LOG-ONLY — zero retroactive DMs.
 *
 * Hermetic notes:
 *  - every src require happens AFTER createIntegrationEnv() — loadDb() purges
 *    the project src require cache (helpers/env.js #699), so a top-of-file
 *    require would bind a stale module generation (warnings.test.js idiom);
 *  - one describe, one env; afterEach hard-clears ban_records, the guild's
 *    _bans/_unbans buffers, the two notice toggles, the pending-modal store
 *    and the scheduler job, so no test inherits another's state;
 *  - clocks are injected ONLY where the product exposes the seam
 *    (runBanExpiryTick's `now`); commands anchor at the real clock and the
 *    tick advances past them — no faked scheduler internals (tickers are
 *    driven directly exactly like test/integration/warnings.test.js).
 */
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { Events, PermissionFlagsBits } = require("discord.js");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  createUser,
  createMember,
  createModalSubmitInteraction,
  lastReplyContent,
  lastReplyEphemeral,
} = require("../helpers/discord");
const { IDS } = require("../helpers/fixtures");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * PR 7 fake supervisor (warnings.test.js exemplar): tickers resolve the
 * OutboundClient per community via clientForCommunity. The harness's own
 * env.supervisor has the same shape; this clone exists for the direct
 * runBanExpiryTick / runBootReconciliation calls.
 */
function fakeSupervisor(client) {
  const { getDiscordOutbound } = require("../../src/platform/discord/outbound");
  return {
    discord: client,
    fluxer: new Map(),
    clientForCommunity: () => getDiscordOutbound(client),
  };
}

describe("integration: ban lifecycle (#772)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  // Post-purge module captures (populated in before() — see hermetic notes):
  let banTicker; // src/features/banLifecycle/ticker
  let banEvents; // src/features/banLifecycle/events
  let banModal; // src/features/banLifecycle/banModal (pending-store test seams)
  let banConsts; // src/features/banLifecycle/constants
  let scheduler; // src/core/scheduler (default singleton — the boot one)

  before(async () => {
    env = await createIntegrationEnv();
    banTicker = require("../../src/features/banLifecycle/ticker");
    banEvents = require("../../src/features/banLifecycle/events");
    banModal = require("../../src/features/banLifecycle/banModal");
    banConsts = require("../../src/features/banLifecycle/constants");
    scheduler = require("../../src/core/scheduler");
    // REAL gateway binds — the exact call boot's load.js makes for this
    // feature (supervisor shape verified by core/outbound #462).
    banEvents.registerEvents(env.supervisor, {});
  });

  after(() => {
    env?.cleanup();
  });

  afterEach(() => {
    // Mock Discord-side buffers (helper law: clear with length = 0, the
    // array identity is asserted on across tests).
    env.guild._bans.length = 0;
    env.guild._unbans.length = 0;
    // DB truth: wipe the cycle rows so a later ticker sweep can never see an
    // earlier test's active/parked record. Audit rows stay (queries below
    // filter by per-test unique subject ids).
    env.db.db
      .prepare("DELETE FROM ban_records WHERE community_id=?")
      .run(env.communityId);
    env.db.updateGuildSettings(env.communityId, {
      ban_dm: 1,
      welcome_back_dm: 1,
    });
    banModal.clearPendingBans();
    banModal.setPendingClock(null);
    // Belt: no scheduler job ever survives a test (stop on an absent job is
    // a no-op by the scheduler's own contract).
    scheduler.stop(banTicker.JOB_NAME);
  });

  /* ── helpers ────────────────────────────────────────────────────────────── */

  /** Fresh unaffiliated guild member + users-cache identity (DM-assertable). */
  function addBanTarget(tag) {
    const user = createUser({ id: `ban772-${tag}`, username: `target-${tag}` });
    const member = createMember({ guild: env.guild, user, admin: false });
    env.guild.addMember(member);
    env.client.users.addUser(user);
    return user;
  }

  /** Drive `/ban <member> [reason] [duration]` through the REAL router. */
  function slashBan(user, { reason = "spam", duration = null } = {}) {
    const options = { member: user };
    if (reason !== null) options.reason = reason;
    if (duration !== null) options.duration = duration;
    return env.runCommand({ commandName: "ban", admin: true, options });
  }

  /** The user's ACTIVE record (the duplicate-guard read). */
  function activeRecord(user) {
    return env.db.findActiveBanRecord(env.communityId, user.id);
  }

  /** The user's newest record regardless of status. */
  function latestRecord(user) {
    return (
      env.db.db
        .prepare(
          `SELECT * FROM ban_records
            WHERE community_id=? AND user_id=?
            ORDER BY id DESC LIMIT 1`
        )
        .get(env.communityId, user.id) || null
    );
  }

  /** admin_audit rows for this community, newest first (facade read). */
  function auditRows(action) {
    const rows = env.db.listAdminAudit(env.communityId, { limit: 100 });
    return action ? rows.filter((r) => r.action === action) : rows;
  }

  /**
   * Rows for one action scoped to ONE subject: staff rows carry the user id
   * as target_id, system unban rows carry the record id there and the user
   * inside details.subject_user_id. Community-wide counts would leak across
   * tests (audit rows intentionally survive the per-test row wipe).
   */
  function auditRowsFor(action, user) {
    return auditRows(action).filter((r) => {
      if (r.target_id === user.id) return true;
      try {
        return JSON.parse(r.details_json || "null")?.subject_user_id === user.id;
      } catch {
        return false;
      }
    });
  }

  function banCountFor(user) {
    return env.guild._bans.filter((b) => String(b.userId) === user.id).length;
  }

  function welcomeDmsFor(user) {
    return user.sends.filter((p) => /unbanned from/i.test(String(p?.content || "")));
  }

  function banDmsFor(user) {
    return user.sends.filter((p) => /have been banned from/i.test(String(p?.content || "")));
  }

  /** customId of a captured ModalBuilder (tickets.test.js accessor law). */
  function modalCustomId(modal) {
    const json = typeof modal?.toJSON === "function" ? modal.toJSON() : modal;
    return json?.custom_id ?? json?.customId ?? "";
  }

  /** Modal submit through the REAL router (prefix dispatch `bl:ban:`). */
  async function submitBanModal(customId, fields) {
    const ix = createModalSubmitInteraction({
      customId,
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
      client: env.client,
      fields,
    });
    await env.handleInteraction(ix, env.ctx);
    return ix;
  }

  /**
   * User context-menu interaction for "Ban member" driving the REAL router
   * (house shape: test/integration/ticket-open-for-menu.test.js — the harness
   * runCommand only speaks chat-input; extended with showModal capture
   * because this menu always answers with the ban form).
   */
  function createBanMenuInteraction({ targetUser }) {
    const invoker = env.users.adminUser;
    const member = env.members.adminMember;
    const replies = [];
    const modals = [];
    const resolved = [];
    const interaction = {
      commandName: banConsts.BAN_CONTEXT_MENU_NAME,
      guild: env.guild,
      guildId: env.guildId,
      channelId: IDS.channelGeneral,
      client: env.client,
      user: invoker,
      member,
      memberPermissions: {
        has: (flag) => {
          if (flag === PermissionFlagsBits.ManageGuild) return true; // admin invoker
          return member?.permissions?.has?.(flag) ?? false;
        },
      },
      replied: false,
      deferred: false,
      replies,
      modals,
      resolved,
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isModalSubmit: () => false,
      isButton: () => false,
      isMessageContextMenuCommand: () => false,
      isUserContextMenuCommand: () => true,
      options: {
        getUser: (name) => {
          resolved.push(name);
          return targetUser ?? null;
        },
      },
      reply: async (payload) => {
        interaction.replied = true;
        replies.push(payload);
        return payload;
      },
      followUp: async (payload) => {
        replies.push(payload);
        return payload;
      },
      deferReply: async () => {
        interaction.deferred = true;
      },
      editReply: async (payload) => {
        const obj = typeof payload === "string" ? { content: payload } : payload;
        replies.push({ ...obj, _edited: true });
        return payload;
      },
      showModal: async (modal) => {
        modals.push(modal);
        interaction.replied = true;
        return modal;
      },
    };
    return interaction;
  }

  /** Flush the fire-and-forget listener chain (detached-async law): every
   * setImmediate macrotask runs AFTER all pending microtasks, and the whole
   * listener path (resolveOutbound → claim → sendDm) is microtask-only —
   * resolveUnbanModerator bails synchronously on the audit-log-less mock. */
  async function drain(turns = 40) {
    for (let i = 0; i < turns; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Emit the v14 GuildBanRemove shape ({ guild, user, reason }) for real. */
  async function emitGuildBanRemove(user, reason = "staff lifted the ban") {
    env.client.emit(Events.GuildBanRemove, { guild: env.guild, user, reason });
    await drain();
  }

  /** Emit GuildMemberAdd (the rejoin fact) for real. */
  async function emitGuildMemberAdd(user) {
    env.client.emit(Events.GuildMemberAdd, { id: user.id, user, guild: env.guild });
    await drain();
  }

  /** A staff unban OUTSIDE the bot: the real mock-REST unban (splices the
   * guild ban list and records the call in _unbans) + its gateway echo. */
  async function staffLiftsBanExternally(user, reason = "staff lifted the ban") {
    await env.guild.members.unban(user.id, reason);
    await emitGuildBanRemove(user, reason);
  }

  /** Poll a settled fact through macrotask turns (bounded, no wall timers). */
  async function waitFor(predicate, label, maxTurns = 2000) {
    for (let i = 0; i < maxTurns; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`timed out waiting for: ${label}`);
  }

  /* ── 1. happy full loop ─────────────────────────────────────────────────── */

  it("full loop: /ban 24h DMs BEFORE the ban, expiry sweep auto-unbans once with ONE welcome", async () => {
    const target = addBanTarget("loop");

    // Interleaved call log: prove the DM queued BEFORE guild.members.ban ran
    // (issue §3 — DM while the shared-guild path still exists).
    const order = [];
    const origSend = target.send;
    const origBan = env.guild.members.ban;
    target.send = async (payload) => {
      order.push("dm");
      return origSend(payload);
    };
    env.guild.members.ban = async (userId, banOpts) => {
      order.push("ban");
      return origBan(userId, banOpts);
    };

    let interaction;
    try {
      interaction = await slashBan(target, { reason: "spam", duration: "24h" });
    } finally {
      target.send = origSend;
      env.guild.members.ban = origBan;
    }

    assert.deepEqual(order, ["dm", "ban"], "ban DM is sent BEFORE the ban executes");

    // Staff reply: B-1, both timestamp flavours, DM-sent notice (context arm
    // defers ephemerally, so the copy rides the editReply).
    const reply = lastReplyContent(interaction);
    assert.match(reply, new RegExp(`\\*\\*Banned:\\*\\* <@${target.id}> \\(\\*\\*B-1\\*\\*\\)`));
    assert.match(reply, /\*\*Expires:\*\* <t:\d+:F> \(<t:\d+:R>\)/);
    assert.match(reply, /\*\*Ban DM:\*\* sent\./);

    // Discord side: exactly one ban with the record's reason.
    assert.equal(banCountFor(target), 1, "member banned once");
    assert.equal(env.guild._bans[0].reason, "spam");

    // Exactly ONE ban DM, carrying both :F and :R stamps and no moderator
    // name (issue §3).
    assert.equal(banDmsFor(target).length, 1, "exactly one ban DM");
    const dm = banDmsFor(target)[0];
    assert.match(dm.content, /<t:\d+:F> \(<t:\d+:R>\)/);
    assert.match(dm.content, new RegExp(`banned from \\*\\*${env.guild.name}\\*\\*`));
    assert.ok(!dm.content.includes(env.users.adminUser.username), "DM never names the moderator");

    // Record: active, source staff, correct expiry anchor, DM stamped, and
    // the staff-command audit row exists.
    const record = activeRecord(target);
    assert.ok(record, "active ban record exists");
    assert.equal(record.source, "staff");
    assert.equal(record.moderator_id, env.users.adminUser.id);
    assert.equal(record.status, "active");
    assert.equal(record.ban_dm_sent, 1);
    assert.equal(record.welcome_dm_sent, 0);
    assert.ok(
      Math.abs(record.expires_at - (record.banned_at + DAY)) < 60_000,
      "expires_at anchored ~24h after banned_at"
    );
    const slashAudits = auditRows("banLifecycle.ban").filter(
      (r) => r.target_id === target.id && r.origin === "slash"
    );
    assert.equal(slashAudits.length, 1, "one slash audit row per executed staff ban");

    // ── expiry: clock injected at the ticker seam, run the real sweep ──────
    const future = Date.now() + DAY + 60_000;
    const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
      now: future,
    });
    assert.deepEqual(
      { processed: out.processed, unbanned: out.unbanned, welcomed: out.welcomed, errors: out.errors },
      { processed: 1, unbanned: 1, welcomed: 1, errors: 0 }
    );

    // The §4 guild-side reason: "Expired — auto-unban (banned <t:F> by <staff>)"
    // (cache-first moderator label — the harness registered adminUser).
    assert.equal(env.guild._unbans.length, 1, "exactly one auto-unban call");
    assert.equal(env.guild._unbans[0].user.id, target.id);
    assert.match(
      env.guild._unbans[0].reason,
      new RegExp(`^Expired — auto-unban \\(banned <t:\\d+:F> by ${env.users.adminUser.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`)
    );

    const settled = latestRecord(target);
    assert.equal(settled.status, "expired_unbanned");
    assert.equal(settled.welcome_dm_sent, 1);

    // Exactly ONE welcome DM for the cycle.
    assert.equal(welcomeDmsFor(target).length, 1, "exactly one welcome DM");
    assert.match(welcomeDmsFor(target)[0].content, new RegExp(`unbanned from \\*\\*${env.guild.name}\\*\\*`));

    // System audit row for the expiry unban (banService writes it itself).
    assert.equal(
      auditRowsFor("banLifecycle.expiry_unban", target).filter((r) => r.origin === "system")
        .length,
      1
    );

    // Second sweep with the same clock: the row left 'active' → re-selected
    // NOWHERE. No second unban, no second welcome.
    const again = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
      now: Date.now() + DAY + 60_000,
    });
    assert.equal(again.processed, 0, "settled rows never re-enter the sweep");
    assert.equal(env.guild._unbans.length, 1, "no second unban");
    assert.equal(welcomeDmsFor(target).length, 1, "no second welcome DM");
  });

  /* ── 2. booted scheduler wiring ─────────────────────────────────────────── */

  it("booted scheduler job 'ban-expiry' sweeps a due ban on its immediate pass and a later runNow stays silent", async () => {
    const target = addBanTarget("sched");
    const bannedAt = Date.now() - 25 * HOUR;
    // A ban that expired while nobody was watching: REAL mock ban + a due
    // active record (the service wrote both, this just ages the clock).
    await env.guild.members.ban(target.id, { reason: "expired during downtime" });
    const created = env.db.createBanRecord({
      communityId: env.communityId,
      userId: target.id,
      moderatorId: env.users.adminUser.id,
      source: "staff",
      reason: "expired during downtime",
      bannedAt,
      expiresAt: bannedAt + DAY, // due an hour ago
    });
    assert.ok(created.ok);

    // Boot the ticker exactly like load.js' start hook does; runImmediately
    // fires the first pass (issue §4: expired rows unban on startup).
    const handle = banTicker.start(env.supervisor);
    try {
      assert.ok(
        scheduler.listNames().includes(banTicker.JOB_NAME),
        `job ${banTicker.JOB_NAME} registered on the default scheduler`
      );
      await waitFor(
        () => latestRecord(target)?.status !== "active",
        "immediate boot pass settled the due row"
      );
      assert.equal(latestRecord(target).status, "expired_unbanned");
      assert.equal(env.guild._unbans.length, 1, "one auto-unban on the boot pass");
      assert.equal(welcomeDmsFor(target).length, 1, "one welcome on the boot pass");

      // scheduler's own test hook: a later manual fire changes nothing
      // (real clock; the row left 'active' so the sweep selects nothing).
      // The job runs with overlap:'skip' — a runNow DURING the boot pass
      // would be silently discarded, so first wait for the boot pass to
      // fully finish (settle is visible before the pass ends: the embed
      // post + reconcile tail still run). getJob returns the LIVE job
      // object, so these polled fields mutate in place.
      const job = scheduler.getJob(banTicker.JOB_NAME);
      assert.ok(job, "job readable while registered");
      await waitFor(
        () => job.runCount >= 1 && !job.inFlight,
        "boot pass fully finished before the manual fire"
      );
      const bootedRuns = job.runCount;
      scheduler.runNow(banTicker.JOB_NAME);
      await waitFor(
        () => job.runCount >= bootedRuns + 1 && !job.inFlight,
        "runNow pass finished"
      );
      assert.equal(job.lastError, null, "no scheduler-side error");
      assert.equal(env.guild._unbans.length, 1, "second pass performed no unban");
      assert.equal(welcomeDmsFor(target).length, 1, "second pass sent no DM");
    } finally {
      handle.stop();
    }
    assert.ok(
      !scheduler.listNames().includes(banTicker.JOB_NAME),
      "stop() drains the job (graceful-shutdown handle)"
    );
  });

  /* ── 3. modal flow ──────────────────────────────────────────────────────── */

  it("/ban missing reason opens the modal; the '7d' submit bans exactly once", async () => {
    const target = addBanTarget("modal");

    const open = await env.runCommand({
      commandName: "ban",
      admin: true,
      options: { member: target }, // no reason, no duration
    });
    assert.equal(open.modals.length, 1, "missing reason funnels into the modal");
    const customId = modalCustomId(open.modals[0]);
    assert.ok(customId.startsWith(banConsts.MODAL_BAN_PREFIX), `token rides ${banConsts.MODAL_BAN_PREFIX}<token>`);

    const submitted = await submitBanModal(customId, {
      [banConsts.MODAL_FIELD_REASON]: "raid on #general",
      [banConsts.MODAL_FIELD_DURATION]: "7d",
    });
    const edited = submitted.replies.at(-1);
    assert.ok(edited?._edited, "success copy rides the deferred editReply");
    assert.match(String(edited.content), new RegExp(`\\*\\*Banned:\\*\\* <@${target.id}>`));
    assert.match(String(edited.content), /\*\*Ban DM:\*\* sent\./);

    assert.equal(banCountFor(target), 1, "exactly one ban executed");
    assert.equal(env.guild._bans[0].reason, "raid on #general", "modal reason is the Discord ban reason");
    assert.equal(banDmsFor(target).length, 1, "exactly one ban DM");

    const record = activeRecord(target);
    assert.ok(record);
    assert.equal(record.reason, "raid on #general");
    assert.ok(
      Math.abs(record.expires_at - (record.banned_at + 7 * DAY)) < 60_000,
      "modal '7d' anchors a ~7-day expiry"
    );
    assert.equal(
      auditRows("banLifecycle.ban").filter((r) => r.target_id === target.id && r.origin === "slash").length,
      1,
      "modal submit lands the same staff audit row"
    );
  });

  it("invalid Duration refuses with the field named + example and bans nothing (slash AND modal)", async () => {
    const target = addBanTarget("baddur");

    // Slash arm: an invalid duration rejects BEFORE any modal opens (#745 —
    // never build a form on top of a misread value).
    const inline = await slashBan(target, { reason: "spam", duration: "5 lightyears" });
    assert.equal(inline.modals.length, 0, "no modal opens over a misread duration");
    assert.equal(lastReplyEphemeral(inline), true);
    assert.match(lastReplyContent(inline), /\*\*Duration:\*\* `5 lightyears`/);
    assert.match(lastReplyContent(inline), /24h or 7d/);
    assert.match(lastReplyContent(inline), /Nothing was banned\./);

    // Modal arm: garbage duration → same refusal, ZERO outbound, ZERO rows.
    const open = await env.runCommand({
      commandName: "ban",
      admin: true,
      options: { member: target },
    });
    const submitted = await submitBanModal(modalCustomId(open.modals[0]), {
      [banConsts.MODAL_FIELD_REASON]: "spam",
      [banConsts.MODAL_FIELD_DURATION]: "5 lightyears",
    });
    assert.equal(lastReplyEphemeral(submitted), true);
    assert.match(lastReplyContent(submitted), /\*\*Duration:\*\*/);
    assert.match(lastReplyContent(submitted), /24h or 7d/);
    assert.match(lastReplyContent(submitted), /Nothing was banned\./);

    assert.equal(env.guild._bans.length, 0, "nothing was banned on either arm");
    assert.equal(latestRecord(target), null, "no record written on refuse");
    assert.equal(target.sends.length, 0, "no DM on refuse");
  });

  /* ── 4. context menu ────────────────────────────────────────────────────── */

  it("context menu 'Ban member' funnels into the modal and bans once; a replayed submit reads expired", async () => {
    const target = addBanTarget("menu");

    const menu = createBanMenuInteraction({ targetUser: target });
    await env.handleInteraction(menu, env.ctx);

    assert.deepEqual(menu.resolved, ["user"], "target read through discord.js' literal 'user'");
    assert.equal(menu.modals.length, 1, "the menu always answers with the ban form");
    const customId = modalCustomId(menu.modals[0]);
    assert.ok(customId.startsWith(banConsts.MODAL_BAN_PREFIX));

    const submitted = await submitBanModal(customId, {
      [banConsts.MODAL_FIELD_REASON]: "ban via right-click",
      [banConsts.MODAL_FIELD_DURATION]: "30m",
    });
    assert.match(String(submitted.replies.at(-1)?.content || ""), /Banned/);
    assert.equal(banCountFor(target), 1, "the menu path bans exactly once");
    assert.equal(banDmsFor(target).length, 1, "one ban DM");
    const record = activeRecord(target);
    assert.equal(record.reason, "ban via right-click");
    assert.ok(
      Math.abs(record.expires_at - (record.banned_at + 30 * 60_000)) < 60_000,
      "modal '30m' anchors a ~30-minute expiry"
    );

    // One-shot token: replaying the SAME submit must read expired and never
    // ban twice (pending-store law: a consumed token is deleted).
    const replay = await submitBanModal(customId, {
      [banConsts.MODAL_FIELD_REASON]: "replayed",
      [banConsts.MODAL_FIELD_DURATION]: "30m",
    });
    assert.match(lastReplyContent(replay), /Modal expired/i);
    assert.match(lastReplyContent(replay), /nothing was banned/i);
    assert.equal(banCountFor(target), 1, "replay banned nothing");
    assert.equal(banDmsFor(target).length, 1, "replay DM'd nothing");
    assert.equal(activeRecord(target).reason, "ban via right-click", "record untouched");
  });

  /* ── 5. duplicate refusal ───────────────────────────────────────────────── */

  it("duplicate /ban while active refuses quoting B-1 with zero outbound and zero DMs", async () => {
    const target = addBanTarget("dup");

    const first = await slashBan(target, { reason: "first spam", duration: "24h" });
    assert.match(lastReplyContent(first), /\*\*B-1\*\*/);

    const second = await slashBan(target, { reason: "again", duration: "24h" });
    const refusal = lastReplyContent(second);
    assert.match(refusal, /already banned — see records/i);
    assert.match(refusal, /B-1/);
    assert.match(refusal, /Nothing new was done\./);

    assert.equal(env.guild._bans.length, 1, "the second /ban performed no Discord ban");
    assert.equal(target.sends.length, 1, "the second /ban sent no DM (duplicate guard precedes the DM)");
    const record = activeRecord(target);
    assert.equal(record.reason, "first spam", "the original record stands");
  });

  /* ── 6. DM failure never blocks the ban ─────────────────────────────────── */

  it("a refused DM surfaces staff-side as '**Ban DM:** not delivered' but never blocks the ban (K2)", async () => {
    const target = addBanTarget("dmfail");
    target.dmsClosed = true; // mock's CANNOT_SEND_TO_USER (50007) shape

    const interaction = await slashBan(target, { reason: "spam", duration: "24h" });
    const reply = lastReplyContent(interaction);
    assert.match(reply, new RegExp(`\\*\\*Banned:\\*\\* <@${target.id}> \\(\\*\\*B-1\\*\\*\\)`));
    assert.match(
      reply,
      /\*\*Ban DM:\*\* not delivered — .*Cannot send messages to this user/,
      "staff sees the SPECIFIC cause, no apology copy"
    );

    assert.equal(banCountFor(target), 1, "the ban landed regardless of the DM");
    assert.equal(target.sends.length, 0, "no DM got through");
    const record = activeRecord(target);
    assert.ok(record, "record written despite the DM failure");
    assert.equal(record.ban_dm_sent, 0, "the stamp only records actual deliveries");
  });

  /* ── 7. manual-unban event path + CAS law ───────────────────────────────── */

  it("GuildBanRemove through the real listener settles unbanned_manual with ONE welcome; a repeat event is silent", async () => {
    const target = addBanTarget("manualevent");
    await slashBan(target, { reason: "spam", duration: "24h" });

    // Staff unbans outside the bot; the gateway echo lands on the REAL
    // GuildBanRemove bind registered in before().
    await staffLiftsBanExternally(target, "appeal upheld by staff");

    const row = latestRecord(target);
    assert.equal(row.status, "unbanned_manual");
    assert.equal(row.welcome_dm_sent, 1, "welcome claim stamped");
    assert.equal(welcomeDmsFor(target).length, 1, "exactly one welcome DM");
    assert.equal(
      auditRowsFor("banLifecycle.external_unban", target).filter((r) => r.origin === "system")
        .length,
      1,
      "system audit row for the event settle"
    );

    // The expiry row is gone from the ban buffer (staff's unban spliced it):
    // a duplicate event for the SAME unban must change nothing — no second
    // welcome, no row rewrite (claim law: welcome_dm_sent already flipped).
    await emitGuildBanRemove(target, "appeal upheld by staff");
    assert.equal(latestRecord(target).status, "unbanned_manual", "row untouched by the repeat");
    assert.equal(welcomeDmsFor(target).length, 1, "no second welcome DM");

    // And the later expiry pass never resurrects the settled row.
    const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
      now: Date.now() + DAY + 60_000,
    });
    assert.equal(out.processed, 0);
    assert.equal(env.guild._unbans.length, 1, "only the staff-side unban call exists");
    assert.equal(welcomeDmsFor(target).length, 1, "welcome stays exactly one per cycle");
  });

  it("CAS truth: a manual unban beats a claimed ticker lease — one welcome, zero bot-side unban calls", async () => {
    const target = addBanTarget("casmanual");
    await slashBan(target, { reason: "spam", duration: "24h" });
    const record = activeRecord(target);

    // A crashed/hung ticker pass holds the CLAIM but not the status.
    const claim = env.db.claimUnban(record.id);
    assert.equal(claim.ok, true);
    assert.equal(claim.won, true, "lease stamped BEFORE the race below");

    // Manual unban + event must win (markUnbannedManual CASes on status).
    await staffLiftsBanExternally(target);

    const row = latestRecord(target);
    assert.equal(row.status, "unbanned_manual", "manual beats the claimed lease");
    assert.equal(welcomeDmsFor(target).length, 1, "exactly one welcome (event path owns it)");

    // The expiry pass re-runs the due row it claimed: it can no longer select
    // the settled row, so the bot performs ZERO unban calls and ZERO DMs.
    const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
      now: Date.now() + DAY + 60_000,
    });
    assert.equal(out.processed, 0);
    assert.equal(env.guild._unbans.length, 1, "exactly one unban call TOTAL (the staff's)");
    assert.equal(welcomeDmsFor(target).length, 1, "exactly one welcome TOTAL");
  });

  it("expiry wins first: the GuildBanRemove twin of the bot's own auto-unban stays silent", async () => {
    const target = addBanTarget("exfirst");
    await slashBan(target, { reason: "spam", duration: "24h" });

    const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
      now: Date.now() + DAY + 60_000,
    });
    assert.equal(out.unbanned, 1);
    assert.equal(welcomeDmsFor(target).length, 1, "welcome delivered by the expiry pass");

    // Real Discord also emits GuildBanRemove for the bot's OWN unban. The
    // listener's active-record gate must bail silently — no second settle,
    // no second welcome, no audit churn.
    await emitGuildBanRemove(target);
    assert.equal(latestRecord(target).status, "expired_unbanned", "expiry settle stands");
    assert.equal(welcomeDmsFor(target).length, 1, "no second welcome");
    assert.equal(env.guild._unbans.length, 1, "no second unban call");
  });

  /* ── 8. rejoin fallback ─────────────────────────────────────────────────── */

  it("welcome failure parks pending_rejoin; a rejoin inside the window retries ONCE and welcomes regardless", async () => {
    const target = addBanTarget("rejoin");
    target.dmsClosed = true; // welcome DM cannot be delivered at unban time
    await slashBan(target, { reason: "spam", duration: "24h" });

    const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
      now: Date.now() + DAY + 60_000,
    });
    assert.equal(out.unbanned, 1, "the unban itself is never blocked by the DM");
    assert.equal(out.welcomed, 0);
    let row = latestRecord(target);
    assert.equal(row.status, "pending_rejoin", "failed welcome parked for rejoin");
    assert.equal(row.welcome_dm_sent, 1, "the claim IS the stamp (one-shot by schema)");
    assert.equal(welcomeDmsFor(target).length, 0);

    // Member rejoins within the 30-day window (unban_claimed_at ≈ now). Their
    // DM path works again this time.
    target.dmsClosed = false;
    await emitGuildMemberAdd(target);

    row = latestRecord(target);
    assert.equal(row.status, "welcomed", "one attempt → welcomed");
    assert.equal(welcomeDmsFor(target).length, 1, "exactly one welcome delivered on rejoin");

    // A second join event must find NO pending row — silence (event-once law).
    await emitGuildMemberAdd(target);
    assert.equal(welcomeDmsFor(target).length, 1, "no second welcome on a repeat join");
    assert.equal(latestRecord(target).status, "welcomed");
  });

  it("rejoin outside the 30-day window: the parked welcome stays parked, zero DMs", async () => {
    const target = addBanTarget("rejoinlate");
    const created = env.db.createBanRecord({
      communityId: env.communityId,
      userId: target.id,
      moderatorId: env.users.adminUser.id,
      source: "staff",
      reason: "old ban",
      bannedAt: Date.now() - 40 * DAY,
      expiresAt: Date.now() - 31 * DAY,
    });
    assert.ok(created.ok);
    // Settle it exactly the way the welcome-failure path does, then age the
    // anchor PAST the REJOIN_WELCOME_WINDOW_DAYS bound.
    env.db.claimUnban(created.record.id);
    env.db.finalizeUnban(created.record.id, "expired_unbanned", "Expired — auto-unban");
    env.db.markPendingRejoin(created.record.id);
    env.db.db
      .prepare("UPDATE ban_records SET unban_claimed_at=? WHERE id=?")
      .run(Date.now() - 31 * DAY, created.record.id);

    await emitGuildMemberAdd(target);

    assert.equal(latestRecord(target).status, "pending_rejoin", "outside the window → row stays parked");
    assert.equal(target.sends.length, 0, "out-of-window rejoin sends nothing");
  });

  /* ── 9. toggles ─────────────────────────────────────────────────────────── */

  it("/bannotify toggles: ban-off bans with silence, welcome-off unbans with silence, status lists both", async () => {
    // ban_dm OFF — the ban itself is unchanged, only the notice goes quiet.
    const offBan = await env.runCommand({
      commandName: "bannotify",
      subcommand: "ban",
      admin: true,
      options: { state: "off" },
    });
    assert.equal(lastReplyEphemeral(offBan), true);
    assert.match(lastReplyContent(offBan), /\*\*Ban DM:\*\* now \*\*off\*\*/);
    assert.equal(Number(env.db.getGuildSettings(env.communityId).ban_dm), 0);
    assert.equal(auditRows("banLifecycle.ban_dm_set").length, 1, "toggle lands its audit row");

    const silent = addBanTarget("togglesilent");
    const silentBan = await slashBan(silent, { reason: "raid", duration: "24h" });
    assert.match(lastReplyContent(silentBan), /\*\*B-1\*\*/);
    assert.match(lastReplyContent(silentBan), /\*\*Ban DM:\*\* off for this server/);
    assert.equal(banCountFor(silent), 1, "ban landed with the notice off");
    assert.equal(silent.sends.length, 0, "zero DMs with ban_dm off");
    assert.equal(activeRecord(silent).ban_dm_sent, 0);

    // welcome_back_dm OFF — the manual-unban path stays silent, row truthful.
    const offWelcome = await env.runCommand({
      commandName: "bannotify",
      subcommand: "welcome",
      admin: true,
      options: { state: "off" },
    });
    assert.match(lastReplyContent(offWelcome), /\*\*Welcome-back DM:\*\* now \*\*off\*\*/);

    await staffLiftsBanExternally(silent);
    const row = latestRecord(silent);
    assert.equal(row.status, "unbanned_manual", "unban still settles with the toggle off");
    assert.equal(row.welcome_dm_sent, 0, "silence means UNCLAIMED, not spent — the toggle check precedes the claim");
    assert.equal(silent.sends.length, 0, "zero welcome DMs with welcome_back_dm off");

    // status lists BOTH toggles in **Label:** value style.
    const status = await env.runCommand({
      commandName: "bannotify",
      subcommand: "status",
      admin: true,
    });
    assert.equal(lastReplyEphemeral(status), true);
    const statusText = lastReplyContent(status);
    assert.match(statusText, /\*\*Ban DM:\*\* off/);
    assert.match(statusText, /\*\*Welcome-back DM:\*\* off/);
    assert.equal(auditRows("banLifecycle.welcome_dm_set").length, 1);
  });

  /* ── 10. downtime reconciliation ────────────────────────────────────────── */

  it("boot reconciliation settles a vanished ban unbanned_manual log-only — zero retroactive DMs", async () => {
    const target = addBanTarget("recon");
    // An ACTIVE record whose ban was lifted during bot downtime: the ban
    // never touched (or vanished from) the mock guild's ban list.
    const created = env.db.createBanRecord({
      communityId: env.communityId,
      userId: target.id,
      moderatorId: env.users.adminUser.id,
      source: "staff",
      reason: "ban lost to downtime",
      bannedAt: Date.now() - 2 * DAY,
      expiresAt: null, // permanent — the sweep must key off guild.bans, not expiry
    });
    assert.ok(created.ok);

    const out = await banTicker.runBootReconciliation(fakeSupervisor(env.client));
    assert.equal(out.communities, 1, "the harness community swept");
    assert.equal(out.checked, 1);
    assert.equal(out.reconciled, 1, "the vanished ban settled through the external-unban CAS");
    assert.equal(out.errors, 0);

    const row = latestRecord(target);
    assert.equal(row.status, "unbanned_manual", "log-only settle (issue §2)");
    assert.match(String(row.unban_reason), /boot reconciliation/i);
    assert.equal(row.welcome_dm_sent, 0, "NO retroactive DM — silence is forced by the service law");
    assert.equal(target.sends.length, 0, "zero DMs for the missed unban");
    assert.equal(env.guild._unbans.length, 0, "reconciliation performs no unban call");
    assert.equal(
      auditRowsFor("banLifecycle.external_unban", target).filter((r) => r.origin === "system")
        .length,
      1,
      "the settle is audited (log-only ≠ log-less)"
    );

    // Second boot pass: nothing active remains → the pass is inert.
    const again = await banTicker.runBootReconciliation(fakeSupervisor(env.client));
    assert.equal(again.reconciled, 0);
    assert.equal(again.checked, 0, "settled rows never re-enter the sweep");
    assert.equal(target.sends.length, 0, "still zero DMs");
  });

  /* ── 11. #809 re-ban guard on the expiry sweep ────────────────────────── */

  /** The claim lease (repo constant) — retry becomes possible past it.
   * LAZY: env is minted in before(); describe-body evaluation is too early. */
  const leaseMs = () => env.db.UNBAN_CLAIM_LEASE_MS ?? 10 * 60 * 1000;

  /**
   * Simulate a moderator lifting our ban and issuing their OWN while the
   * bot never saw either event (downtime): the (guild,user)-keyed ban entry
   * is REPLACED with a fresh object + reason. The record stays ACTIVE —
   * exactly the state the expiry sweep faces in the wild.
   */
  function reissueBanExternally(user, newReason) {
    const idx = env.guild._bans.findIndex((b) => String(b.userId) === user.id);
    assert.ok(idx >= 0, "the bot-issued ban is live before the re-issue");
    env.guild._bans.splice(idx, 1, { userId: user.id, reason: newReason });
  }

  it("#809: ban issue fingerprints the live ban; a MATCHING identity still unbans normally", async () => {
    const target = addBanTarget("809match");
    await slashBan(target, { reason: "spam", duration: "24h" });

    const record = activeRecord(target);
    assert.equal(
      record.ban_identity_reason,
      "spam",
      "the record fingerprints the ban it owns (live reason read at issue)"
    );

    const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
      now: Date.now() + DAY + 60_000,
    });
    assert.deepEqual(
      { processed: out.processed, unbanned: out.unbanned, held: out.held, welcomed: out.welcomed, errors: out.errors },
      { processed: 1, unbanned: 1, held: 0, welcomed: 1, errors: 0 },
      "the guard is a no-op on its own ban"
    );
    assert.equal(latestRecord(target).status, "expired_unbanned");
    assert.equal(welcomeDmsFor(target).length, 1);
  });

  it("#809: a moderator re-ban makes expiry HELD — zero unban calls, zero welcome, terminal + audited", async () => {
    const target = addBanTarget("809held");
    await slashBan(target, { reason: "spam", duration: "24h" });
    assert.equal(activeRecord(target).ban_identity_reason, "spam");

    // Downtime story: staff lifted the bot's ban and re-banned the member
    // for a DIFFERENT reason; the bot missed both events.
    reissueBanExternally(target, "appeal denied — harassment continues");

    const future = Date.now() + DAY + 60_000;
    const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), { now: future });
    assert.deepEqual(
      { processed: out.processed, unbanned: out.unbanned, held: out.held, welcomed: out.welcomed, errors: out.errors, skipped: out.skipped },
      { processed: 1, unbanned: 0, held: 1, welcomed: 0, errors: 0, skipped: 0 },
      "the held row is its own honest bucket — never 'unbanned', never a CAS-loss 'skipped'"
    );

    // Nothing destructive happened: the moderator's ban is STILL live and
    // the bot performed ZERO unban calls; the member got NO welcome DM.
    assert.equal(env.guild._unbans.length, 0, "the auto-unban was HELD — zero unban calls");
    assert.equal(banCountFor(target), 1, "the live (re-issued) ban is untouched");
    assert.equal(
      env.guild._bans.find((b) => String(b.userId) === target.id).reason,
      "appeal denied — harassment continues",
      "staff's reason stands"
    );
    assert.equal(welcomeDmsFor(target).length, 0, "no welcome/invite to a member a human just re-banned");

    // Record: terminal held, the fingerprint preserved, cause recorded.
    const row = latestRecord(target);
    assert.equal(row.status, "expired_held");
    assert.equal(row.ban_identity_reason, "spam", "the fingerprint survives for staff forensics");
    assert.match(row.unban_reason, /HELD: the live ban does not match this record/);

    // Audited with BOTH reasons (the sweep's evidence trail).
    const held = auditRowsFor("banLifecycle.expiry_held", target);
    assert.equal(held.length, 1, "one held-expiry audit row");
    const details = JSON.parse(held[0].details_json);
    assert.equal(details.issued_reason, "spam");
    assert.equal(details.live_reason, "appeal denied — harassment continues");

    // Terminal means terminal: the next sweep never re-selects the row.
    const again = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), { now: future + 60_000 });
    assert.equal(again.processed, 0, "expired_held rides no future sweep");

    // And the welcome claim structurally cannot fire on a held row.
    const welcome = env.db.claimWelcome(row.id);
    assert.equal(welcome.ok, true);
    assert.equal(welcome.won, false, "claimWelcome admits only lifted rows");
  });

  it("#809: an unreadable live ban FAILS CLOSED — no unban, row stays claimed ACTIVE, later retry completes", async () => {
    const target = addBanTarget("809fail");
    await slashBan(target, { reason: "spam", duration: "24h" });

    // Unknown (a 5xx, not the 10026 "not banned") must NEVER settle or
    // unban — reconcile's law applied to the unban itself.
    const realFetch = env.guild.bans.fetch;
    env.guild.bans.fetch = async () => {
      throw Object.assign(new Error("DiscordAPIError[50001]: Internal error"), {
        code: 50001,
        status: 500,
      });
    };
    try {
      const t1 = Date.now() + DAY + 60_000;
      const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), { now: t1 });
      assert.equal(out.unbanned, 0);
      assert.equal(out.held, 0);
      assert.equal(out.errors, 1, "unverifiable = transient error accounting, never destructive");
      assert.equal(env.guild._unbans.length, 0, "zero unban calls while the truth is unknown");
      const row = latestRecord(target);
      assert.equal(row.status, "active", "the row stays active-claimed for a lease retry");
      assert.ok(row.unban_claimed_at, "the claim stamp records the attempt");

      // Recovery: once the read works again and the lease lapsed, the
      // matching identity lands the unban.
      env.guild.bans.fetch = realFetch;
      const out2 = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
        now: t1 + leaseMs() + 60_000,
      });
      assert.equal(out2.unbanned, 1, "the retry completes the auto-unban");
      assert.equal(latestRecord(target).status, "expired_unbanned");
    } finally {
      env.guild.bans.fetch = realFetch;
    }
  });

  it("#809: an external lift (10026) still rides the NOT_BANNED fall-through — never a false HELD", async () => {
    const target = addBanTarget("809gone");
    await slashBan(target, { reason: "spam", duration: "24h" });

    // Ban lifted outside the bot (no event seen): the guard's fetchBan
    // answers 10026 → fall THROUGH — the unban attempt's NOT_BANNED arm
    // owns the settle (one code path, one truth).
    const idx = env.guild._bans.findIndex((b) => String(b.userId) === target.id);
    env.guild._bans.splice(idx, 1);

    const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
      now: Date.now() + DAY + 60_000,
    });
    assert.equal(out.held, 0, "a vanished ban is not a re-ban");
    assert.equal(out.unbanned, 1);
    const row = latestRecord(target);
    assert.equal(row.status, "unbanned_manual", "the pre-existing 10026 settle stands");
    assert.match(row.unban_reason, /already lifted outside the bot/);
  });

  it("#809: a legacy NULL-marker record keeps the historical behavior — unbans on a different live reason", async () => {
    const target = addBanTarget("809legacy");
    await slashBan(target, { reason: "spam", duration: "24h" });

    // Pre-#809 row: no fingerprint. Fail-OPEN is the deliberate choice —
    // a marker-less record must not start HOLDING every expiry (the fleet
    // upgrades with thousands of these; only NEW re-bans get the guard).
    env.db.db
      .prepare("UPDATE ban_records SET ban_identity_reason=NULL WHERE community_id=? AND user_id=?")
      .run(env.communityId, target.id);
    reissueBanExternally(target, "someone else's reason");

    const out = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
      now: Date.now() + DAY + 60_000,
    });
    assert.equal(out.unbanned, 1, "the historical sweep behavior stands for unmarked rows");
    assert.equal(latestRecord(target).status, "expired_unbanned");
  });

  /* ── 12. #810 quarantine + reconcile rotation ───────────────────────────── */

  it("#810: a permanently failing expiry QUARANTINES its row — loud, terminal, and the sweep moves on", async () => {
    const healthy = addBanTarget("810healthy");
    const broken = addBanTarget("810broken");
    await slashBan(healthy, { reason: "spam", duration: "24h" });
    await slashBan(broken, { reason: "raiding", duration: "24h" });

    // Only the BROKEN user's ban entry turns PERMANENTLY unreadable: the
    // #809 fail-closed verify now feeds the quarantine valve (fail-closed
    // forever = the chronic-failure shape the ceiling exists to fire on).
    const realFetch = env.guild.bans.fetch;
    env.guild.bans.fetch = async (arg) => {
      if (String(arg) === broken.id) {
        throw Object.assign(new Error("DiscordAPIError[50013]: Missing Access"), {
          code: 50013,
          status: 403,
        });
      }
      return realFetch.call(env.guild.bans, arg);
    };
    try {
      const t1 = Date.now() + DAY + 60_000;
      const out1 = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
        now: t1,
        maxExpiryAttempts: 2,
      });
      assert.equal(out1.unbanned, 1, "the healthy expiry lands beside the failing one");
      assert.equal(out1.errors, 1, "attempt #1 counts as an error");
      let row = latestRecord(broken);
      assert.equal(row.status, "active");
      assert.equal(row.expiry_attempts, 1, "winner-side failure counted exactly once");

      // INSIDE the lease: the claim loser files NOTHING (anti-inflation).
      const outL = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
        now: t1 + 60_000,
        maxExpiryAttempts: 2,
      });
      assert.equal(outL.processed, 1);
      assert.equal(latestRecord(broken).expiry_attempts, 1, "a pass that did no work files no attempt");

      // PAST the lease: real attempt #2 crosses the ceiling → QUARANTINE.
      const out2 = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
        now: t1 + leaseMs() + 60_000,
        maxExpiryAttempts: 2,
      });
      assert.equal(out2.quarantined, 1, "the quarantine is its own honest bucket");
      assert.equal(out2.errors, 0, "giving up is a TERMINAL action, not an error line");

      row = latestRecord(broken);
      assert.equal(row.status, "expiry_failed");
      assert.equal(row.expiry_attempts, 2);
      assert.match(row.unban_reason, /QUARANTINED/);

      // Audit forensics.
      const q = auditRowsFor("banLifecycle.expiry_quarantined", broken);
      assert.equal(q.length, 1);
      const det = JSON.parse(q[0].details_json);
      assert.equal(det.attempts, 2);
      assert.match(det.last_error, /Missing Access/);

      // Nothing destructive ever landed: the broken ban is STILL live, the
      // healthy one was unbanned exactly once, nobody was welcomed twice.
      assert.equal(banCountFor(broken), 1, "quarantine never lifts a ban");
      assert.deepEqual(
        env.guild._unbans.map((u) => String(u.user.id)),
        [healthy.id],
        "exactly one unban call — for the healthy row"
      );
      assert.equal(welcomeDmsFor(broken).length, 0, "a quarantined row never welcomes");

      // Terminal means terminal — AND the starvation is gone: a later pass
      // selects NOTHING (the row no longer camps at the head of the slice).
      const out3 = await banTicker.runBanExpiryTick(fakeSupervisor(env.client), {
        now: t1 + 2 * leaseMs() + 120_000,
      });
      assert.equal(out3.processed, 0, "expiry_failed leaves the sweep forever");
    } finally {
      env.guild.bans.fetch = realFetch;
    }
  });

  it("#810: boot reconciliation ROTATES the community window — every guild converges over boots", async () => {
    const { ensureCommunity } = require("../../src/platform/community");
    const stampOf = (cid) =>
      env.db.db
        .prepare("SELECT last_reconciled_at FROM ban_reconcile_state WHERE community_id=?")
        .get(cid)?.last_reconciled_at ?? null;

    // Two unreachable discord communities (no guilds in the mock client),
    // each with ONE active permanent ban → both sit in the reconcile scope.
    // Neither pass can ever LIST its bans: the audit finding was that a
    // static top-N on ORDER BY banned_at let communities N+1… NEVER be
    // reached. The attempt stamp (written whether or not the guild was
    // reachable) must rotate the window.
    const B = ensureCommunity({ platform: "discord", instanceKey: "discord", externalGuildId: "8100000000000000001" });
    const C = ensureCommunity({ platform: "discord", instanceKey: "discord", externalGuildId: "8100000000000000002" });
    const T1 = Date.UTC(2026, 10, 20, 1, 0, 0);
    const mkRot = (cid, userId, bannedAt) => {
      const r = env.db.createBanRecord({
        communityId: cid,
        userId,
        moderatorId: env.users.adminUser.id,
        source: "staff",
        reason: "rotation probe",
        bannedAt,
        expiresAt: null,
      });
      assert.ok(r.ok, r.error);
    };
    env.db.db.prepare("DELETE FROM ban_reconcile_state").run(); // hermetic ordering
    try {
      mkRot(B, "810-rot-b", T1 - 2 * DAY); // OLDER ban
      mkRot(C, "810-rot-c", T1 - DAY); // NEWER ban: the OLD static scope picked C on EVERY boot, forever

      const boot1 = await banTicker.runBootReconciliation(fakeSupervisor(env.client), {
        maxCommunities: 1,
        now: T1,
      });
      assert.equal(boot1.communities, 1, "the LIMIT-N window held");
      assert.equal(stampOf(C), T1, "never-reconciled tie → newest-ban community first (tie-break survives)");
      assert.equal(stampOf(B), null, "exactly one community per capped boot");

      const boot2 = await banTicker.runBootReconciliation(fakeSupervisor(env.client), {
        maxCommunities: 1,
        now: T1 + 1000,
      });
      assert.equal(boot2.communities, 1);
      assert.equal(stampOf(B), T1 + 1000, "the NEVER-RECONCILED community jumps the stamped one — rotation, not status quo");
      assert.equal(stampOf(C), T1, "the recently-stamped community waits its turn");

      const T3 = T1 + 5000;
      const boot3 = await banTicker.runBootReconciliation(fakeSupervisor(env.client), {
        maxCommunities: 1,
        now: T3,
      });
      assert.equal(boot3.communities, 1);
      assert.equal(stampOf(C), T3, "least-recently-attempted next (C waited longest)");
      assert.equal(stampOf(B), T1 + 1000, "only the picked community is stamped");

      // The stamps recorded ATTEMPTS, not successes — neither fake external
      // id resolves to a mock guild, so no pass "succeeded"; a broken guild
      // rotates too (fairness over favoritism) instead of camping at the
      // head of every boot forever.
      assert.equal(
        boot1.reconciled,
        0,
        "unreachable guilds settle nothing"
      );
    } finally {
      env.db.db.prepare("DELETE FROM ban_records WHERE community_id IN (?,?)").run(B, C);
      env.db.db.prepare("DELETE FROM ban_reconcile_state WHERE community_id IN (?,?)").run(B, C);
      env.db.db.prepare("DELETE FROM communities WHERE id IN (?,?)").run(B, C);
    }
  });

  /* ── 13. Fluxer no-parity (documented skip) ─────────────────────────────── */

  it.skip("Fluxer NOT_ON_FLUXER refusal — unreachable through the offline Discord harness", () => {
    // createIntegrationEnv wires the DISCORD router (src/commands/router.js)
    // and a supervisor whose clientForCommunity answers null for fluxer rows
    // (harness.js, Fluxer PR 7 mirror). The Fluxer slash dispatcher is a
    // separate wire surface no integration test mints (message-relay tests
    // aside) — a NOT_ON_FLUXER drive here would fabricate a dispatcher shape
    // instead of exercising one. The refusal IS pinned against the SAME
    // shipped handler arms by the unit suite:
    // test/ban-lifecycle-commands.test.js ("/ban … answers NOT_ON_FLUXER with
    // zero mutation", "/bannotify Fluxer-shaped context … mutates NOTHING").
  });
});
