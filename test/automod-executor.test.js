/**
 * #729 (epic #723): the per-action mode gate + execution guards, on the
 * callable executor core — Discord-free via the deps seam, real SQLite via
 * loadDb. Covers: the mode matrix (off refuses even when called; suggest
 * records with ZERO Discord calls; auto runs), the staff-role + hierarchy
 * guards per mutating action (and no_action naming staff), the timeout
 * clamp matrix, the atomic claim (concurrent execute / double Approve run
 * the mutation EXACTLY once), the #735 ticket tool (real ticket seams: the
 * member-visible law, the #420 rate-slot idiom, the commit-time note
 * scrub), and the real
 * createWarning write.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

const executor = require("../src/features/automod/executor");
const repo = require("../src/db/repositories/automodCaseActions");
const { PermissionFlagsBits } = require("discord.js");

after(() => cleanup());

let seq = 0;
const freshCommunity = () => communityKey(`automod-729-exec-${++seq}`);
const GUILD = "700000000000000202";
const SUBJECT = "200000000000000002";

/** Set one action's mode through the shipped settings belt. */
const setMode = (cid, action, mode) =>
  db.updateGuildSettings(cid, { [`automod_mode_${action}`]: mode });

/** Deps recorder — every Discord seam counted; overrides replace seams. */
function makeRecorder(overrides = {}) {
  const calls = [];
  // Last Discord timeout reason — #736 pins that the STATED reason rides
  // the audit entry (calls stay id-only so existing pins never churn).
  const record = { lastTimeoutReason: null, lastKickReason: null, lastBanReason: null };
  const deps = {
    fetchMemberRoleIds: async () => {
      calls.push("roles");
      return overrides.roleIds ?? ["r-everyone"];
    },
    fetchMemberTopRolePosition: async () => {
      calls.push("pos:subject");
      return overrides.subjectPos ?? 1;
    },
    fetchBotTopRolePosition: async () => {
      calls.push("pos:bot");
      return overrides.botPos ?? 10;
    },
    fetchMessage: async (ch, msg) => {
      calls.push(`fetch:${ch}:${msg}`);
      if (overrides.message === null) return null;
      return {
        delete: async (reason) => {
          calls.push(`delete:${reason ?? "-"}`);
        },
      };
    },
    // #734 Manage Messages seam — ALLOW by default (the recorder COUNTS the
    // check). canManageChannels lists the channels the bot CAN manage;
    // canManage=false refuses all; canManageError throws (channel gone /
    // bot not in guild — the handler reports that cause verbatim).
    channelCanManageMessages: async (_gid, chId) => {
      calls.push(`perm:${chId}`);
      if (overrides.canManageError) throw new Error(overrides.canManageError);
      if (Array.isArray(overrides.canManageChannels)) {
        return overrides.canManageChannels.map(String).includes(String(chId));
      }
      return overrides.canManage !== false;
    },
    fetchMember: async () => ({
      timeout: async (ms, reason) => {
        calls.push(`timeout:${ms}`);
        record.lastTimeoutReason = reason ?? null;
      },
      kick: async (reason) => {
        calls.push("kick");
      },
    }),
    // #737: the kick rides the outbound helper through this seam (the
    // fake KICK_SCRIPT below scripts successes and Discord causes).
    createKick: async (_cid, userId, { reason } = {}) => {
      calls.push("kick");
      record.lastKickReason = reason ?? null;
      if (overrides.kickError) {
        return { ok: false, error: overrides.kickError, code: overrides.kickCode };
      }
      return { ok: true };
    },
    createBan: async (_cid, userId, { reason } = {}) => {
      // #738: ban rides the outbound banMember through this seam — the
      // shape matches createKick ({ok:false,error,code} scripts a failure;
      // the seam NEVER throws).
      calls.push(`ban:${userId}`);
      record.lastBanReason = reason ?? null;
      if (overrides.banError) {
        return { ok: false, error: overrides.banError, code: overrides.banCode };
      }
      return { ok: true };
    },
    ...(overrides.deps ?? {}),
  };
  return { calls, deps, record };
}

/** The params each mutating action needs to reach its handler.
 *  delete_message deliberately keeps the LEGACY single-pair shape: the
 *  #734 fallback law says rows recorded before params.messages still
 *  execute — every recorder-driven delete below pins that arm. */
const paramsFor = {
  warn: { reason: "posted targeted harassment" },
  delete_message: { channelId: "301", messageId: "401" },
  ticket: {},
  timeout: { durationSeconds: 600 },
  kick: {},
  ban: {},
};

/** Execute with every seam answered; opts merge last. */
function run(cid, action, opts = {}) {
  const { calls, deps, record } = makeRecorder(opts.recorderOverrides ?? {});
  return {
    calls,
    record,
    promise: executor.executeAutomodAction({
      communityId: cid,
      guildId: GUILD,
      subjectUserId: SUBJECT,
      action,
      params: paramsFor[action] ?? {},
      deps,
      ...opts.exec,
    }),
  };
}

const rowsFor = (cid, caseId) => repo.listAutomodActionsForCase(cid, caseId);

// ── Mode matrix ─────────────────────────────────────────────────────────────

describe("mode gate — one executor, three modes (kick probe)", () => {
  it("off: refuses even when called anyway — refused row, ZERO Discord calls", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "off");
    const { calls, promise } = run(cid, "kick", { exec: { caseId: 1 } });
    const res = await promise;
    assert.equal(res.ok, false);
    assert.equal(res.state, "refused");
    assert.match(res.error, /kick.* is off for this guild/);
    assert.deepEqual(calls, [], "the off gate precedes every Discord read");
    const rows = rowsFor(cid, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "refused");
    assert.equal(rows[0].mode, "off", "the row records the mode AT record time");
    assert.equal(rows[0].error_text, res.error, "the specific reason is recorded");
  });

  it("suggest: records a pending suggestion — zero Discord calls", async () => {
    const cid = freshCommunity();
    const caseId = 2;
    const { calls, promise } = run(cid, "kick", { exec: { caseId } });
    const res = await promise;
    assert.equal(res.ok, true);
    assert.equal(res.state, "recorded_suggestion");
    assert.deepEqual(calls, []);
    const rows = rowsFor(cid, caseId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "suggested");
    assert.equal(rows[0].mode, "suggest");
    assert.equal(rows[0].claimed_by, null);
    assert.equal(res.actionRowId, rows[0].id);
  });

  it("auto: runs the mutation and records executed with the claim stamped", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "auto");
    const { calls, promise } = run(cid, "kick", { exec: { caseId: 3, claimant: "auto:harness" } });
    const res = await promise;
    assert.equal(res.ok, true);
    assert.equal(res.state, "executed");
    assert.ok(calls.includes("kick"), `kick ran: ${calls}`);
    const row = rowsFor(cid, 3)[0];
    assert.equal(row.state, "executed");
    assert.equal(row.claimed_by, "auto:harness");
    assert.ok(Number.isInteger(row.claimed_at), "the slot stamps WHEN it was claimed");
    assert.match(row.result_text, /Kicked/);
  });

  it("an explicit mode override is honoured (validated), the setting still gates without it", async () => {
    const cid = freshCommunity(); // stored mode: suggest (epic default)
    const over = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT,
      action: "ban", params: {}, caseId: 4, mode: "auto",
      deps: makeRecorder().deps,
    });
    assert.equal(over.ok, true, "override 'auto' ran despite the suggest setting");
    const junk = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT,
      action: "ban", caseId: 4, mode: "yolo",
    });
    assert.equal(junk.ok, false);
    assert.match(junk.error, /Unknown auto-mod mode `yolo`/);
  });

  it("re-approval honours the CURRENT mode: off lands after the suggestion ⇒ refused", async () => {
    const cid = freshCommunity();
    const { promise } = run(cid, "kick", { exec: { caseId: 5 } });
    const sug = await promise; // suggest mode default
    setMode(cid, "kick", "off"); // staff flip it off before the click lands
    const res = await executor.approveSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-1" });
    assert.equal(res.ok, false);
    assert.equal(res.state, "refused");
    assert.match(res.error, /is off for this guild now/);
    assert.equal(repo.getAutomodAction(sug.actionRowId).state, "refused");
  });
});

// ── Subject guards ───────────────────────────────────────────────────────────

describe("subject guards — staff roles + role hierarchy (decision 6)", () => {
  const MUTATORS = ["warn", "delete_message", "ticket", "timeout", "kick", "ban"];

  it("every mutating action REFUSES a staff-role subject and records the row", async () => {
    for (const action of MUTATORS) {
      const cid = freshCommunity();
      const caseId = 900 + MUTATORS.indexOf(action);
      db.addStaffRole(cid, "role-mod", "senior", "tester");
      setMode(cid, action, "auto");
      const { calls, promise } = run(cid, action, {
        recorderOverrides: { roleIds: ["r-everyone", "role-mod"] },
        exec: { caseId },
      });
      const res = await promise;
      assert.equal(res.ok, false, `${action} must refuse a staff subject`);
      assert.equal(res.state, "refused");
      assert.match(res.error, /staff role <@&role-mod>/, `${action}: ${res.error}`);
      assert.match(res.error, /#723 decision 6/);
      assert.equal(calls.filter((c) => c !== "roles").length, 0, `${action}: no mutation after the guard`);
      const rows = rowsFor(cid, caseId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, "refused", `${action}: the refusal still counts the subject as considered`);
      assert.equal(rows[0].subject_user_id, SUBJECT);
    }
  });

  it("no_action may name a staff member — guards bypassed, still 'considered'", async () => {
    const cid = freshCommunity();
    db.addStaffRole(cid, "role-mod", "junior", "tester");
    setMode(cid, "no_action", "auto");
    const { calls, promise } = run(cid, "no_action", {
      recorderOverrides: { roleIds: ["role-mod"] },
      exec: { caseId: 10, params: { reason: "close call, context explains it" } },
    });
    const res = await promise;
    assert.equal(res.ok, true);
    assert.equal(res.state, "executed", "no_action IS the outcome — nothing to refuse");
    assert.deepEqual(calls, [], "no mutation ⇒ no guards to consult");
    const row = rowsFor(cid, 10)[0];
    assert.equal(row.state, "executed");
    assert.match(row.result_text, /No action — <@200000000000000002> considered: close call/);
  });

  it("hierarchy: refuses at equal position, runs when the bot sits strictly above", async () => {
    const equal = freshCommunity();
    setMode(equal, "kick", "auto");
    const eq = await executor.executeAutomodAction({
      communityId: equal, guildId: GUILD, subjectUserId: SUBJECT, action: "kick",
      caseId: 11,
      deps: makeRecorder({ subjectPos: 7, botPos: 7 }).deps,
    });
    assert.equal(eq.ok, false);
    assert.equal(eq.state, "refused");
    assert.match(eq.error, /not below the bot's highest role/);
    assert.match(eq.error, /move the bot's role up/);
    assert.equal(repo.getAutomodActionBySlot({ communityId: equal, caseId: 11, subjectUserId: SUBJECT, action: "kick" }).state, "refused");

    const above = freshCommunity();
    setMode(above, "kick", "auto");
    const { calls, deps } = makeRecorder({ subjectPos: 7, botPos: 8 });
    const ok = await executor.executeAutomodAction({
      communityId: above, guildId: GUILD, subjectUserId: SUBJECT, action: "kick", caseId: 12, deps,
    });
    assert.equal(ok.ok, true);
    assert.ok(calls.includes("kick"));
  });

  it("UNVERIFIABLE guards fail closed: null positions / throwing role read ⇒ failed row, no mutation", async () => {
    const cid = freshCommunity();
    setMode(cid, "ban", "auto");
    const nullPos = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "ban", caseId: 13,
      deps: makeRecorder({ deps: { fetchBotTopRolePosition: async () => null } }).deps,
    });
    assert.equal(nullPos.ok, false);
    assert.equal(nullPos.state, "failed");
    assert.match(nullPos.error, /Could not resolve the role hierarchy/);
    assert.equal(
      repo.getAutomodActionBySlot({ communityId: cid, caseId: 13, subjectUserId: SUBJECT, action: "ban" }).state,
      "failed",
      "a verification failure is recorded too — the user is still considered",
    );

    const boom = freshCommunity();
    setMode(boom, "ban", "auto");
    const bad = await executor.executeAutomodAction({
      communityId: boom, guildId: GUILD, subjectUserId: SUBJECT, action: "ban", caseId: 14,
      deps: makeRecorder({
        deps: { fetchMemberRoleIds: async () => { throw new Error("REST 500"); } },
      }).deps,
    });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Could not check the subject's roles: REST 500/);
  });

  it("auto with NO deps (no client, no seams) fails with the specific cause — never throws", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "auto");
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "kick", caseId: 15, deps: {},
    });
    assert.equal(res.ok, false);
    assert.equal(res.state, "failed");
    assert.match(res.error, /no Discord client/);
    assert.equal(
      repo.getAutomodActionBySlot({ communityId: cid, caseId: 15, subjectUserId: SUBJECT, action: "kick" }).state,
      "failed",
    );
  });

  it("production default deps drive a (fake) discord.js v14 client surface", async () => {
    // #738: ban AND kick now ride the REAL platform-outbound helpers
    // (lookupGuild → guild.members.ban/kick), so this test's community is
    // keyed to the fake guild's own id — the production wiring itself is
    // what's under test here.
    const cid = communityKey(GUILD);
    const deleted = { n: 0 };
    const banned = [];
    const kicked = [];
    const member = {
      roles: {
        cache: { keys: () => ["r-everyone"] },
        highest: { position: 2 },
      },
      timeout: async () => { throw new Error("unused"); },
    };
    const guild = {
      id: GUILD,
      members: Object.assign(async () => member, {
        fetch: async () => member,
        me: { roles: { highest: { position: 9 } } },
        // What createDiscordOutbound().banMember/kickMember actually call:
        ban: async (id, opts) => { banned.push({ id, reason: opts?.reason }); },
        kick: async (id, opts) => { kicked.push({ id, reason: opts?.reason }); },
      }),
    };
    const client = {
      guilds: { cache: { get: (id) => (id === GUILD ? guild : undefined) } },
      channels: {
        fetch: async () => ({
          // #734: the production Manage Messages pre-flight reads this —
          // the fake grants the permission (the seam-specific refusals are
          // pinned directly through the injectable seam below).
          permissionsFor: () => ({ has: (flag) => flag === PermissionFlagsBits.ManageMessages }),
          messages: {
            fetch: async (id) => (id === "401"
              ? { id, delete: async () => { deleted.n += 1; } }
              : null),
          },
        }),
      },
    };

    setMode(cid, "kick", "auto");
    const kick = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "kick",
      caseId: 159, deps: { client },
    });
    assert.equal(kick.ok, true, `client-driven kick ran through the outbound: ${kick.error ?? "ok"}`);
    assert.deepEqual(kicked[0].id, SUBJECT);
    assert.match(kicked[0].reason, /^Auto-mod kick \(case #159\)/, "the belt audit line reaches the API (#737)");

    setMode(cid, "ban", "auto");
    const ban = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "ban",
      caseId: 160, deps: { client },
    });
    assert.equal(ban.ok, true, `client-driven guards + ban ran: ${ban.error ?? "ok"}`);
    assert.deepEqual(banned[0].id, SUBJECT);
    assert.match(banned[0].reason, /^Auto-mod ban \(case #160\)/, "audit reason reaches the API");
    assert.equal(banned[0].reason.includes("delete_message"), false, "no bulk-delete on ban (decision 9)");

    setMode(cid, "delete_message", "auto");
    const del = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 161, params: { channelId: "301", messageId: "401" }, deps: { client },
    });
    assert.equal(del.ok, true, del.error ?? "ok");
    assert.equal(del.result, "Deleted 1 message(s) in this case.",
      "the LEGACY single-pair row still executes (fallback law) with the new honest line");
    assert.equal(deleted.n, 1);

    // GONE message: the default fetchMessage resolves null → that id's
    // 10003 failure; the ONLY id failed → the failed row names it.
    const gone = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 162, params: { channelId: "301", messageId: "999" }, deps: { client },
    });
    assert.equal(gone.ok, false);
    assert.equal(gone.state, "failed");
    assert.match(gone.error, /^Deleted 0 of 1 — failed: 999 \(Discord 10003 — message not found, already gone\)\.$/);

    // Uncached guild: the adapter names the guild — guard fails closed.
    const lost = await executor.executeAutomodAction({
      communityId: cid, guildId: "999000", subjectUserId: SUBJECT, action: "ban",
      deps: { client },
    });
    assert.equal(lost.ok, false);
    assert.match(lost.error, /guild 999000 is not cached by this client/);
  });
});

// ── Timeout clamp ────────────────────────────────────────────────────────────

describe("timeout clamp — [60 s, min(guild cap, 28 days)]", () => {
  it("pure matrix: floors at 60, caps at the guild cap, never past 28 days; garbage refuses", () => {
    const c = executor.clampTimeoutDuration;
    assert.deepEqual(
      { d: c({ requestedSeconds: 5, guildCapSeconds: 3600 }).durationSeconds, from: c({ requestedSeconds: 5, guildCapSeconds: 3600 }).clampedFrom },
      { d: 60, from: 5 },
    );
    assert.equal(c({ requestedSeconds: 0, guildCapSeconds: 3600 }).durationSeconds, 60);
    assert.equal(c({ requestedSeconds: 60, guildCapSeconds: 3600 }).clampedFrom, null, "in range ⇒ untouched");
    assert.equal(c({ requestedSeconds: 3600, guildCapSeconds: 3600 }).clampedFrom, null);
    assert.equal(c({ requestedSeconds: 7200, guildCapSeconds: 3600 }).durationSeconds, 3600);
    // A cap ABOVE Discord's ceiling is itself clamped by the shipped max.
    const wild = c({ requestedSeconds: 2_419_201, guildCapSeconds: 99_999_999 });
    assert.equal(wild.durationSeconds, 2_419_200, "cap>28d is impossible via shipped clamps — executor re-clamps anyway");
    assert.equal(wild.clampedFrom, 2_419_201);
    assert.equal(c({ requestedSeconds: 120.9, guildCapSeconds: 3600 }).durationSeconds, 120, "floored");
    for (const junk of [undefined, null, "", "abc", NaN]) {
      assert.equal(c({ requestedSeconds: junk, guildCapSeconds: 3600 }).ok, false, `junk ${String(junk)} refuses`);
    }
    assert.equal(c({ requestedSeconds: 90, guildCapSeconds: 0 }).durationSeconds, 90, "garbage cap ⇒ shipped default ceiling (3600)");
  });

  it("over the guild cap end-to-end: row + Discord call echo the EFFECTIVE duration", async () => {
    const cid = freshCommunity();
    setMode(cid, "timeout", "auto");
    db.updateGuildSettings(cid, { automod_timeout_cap: 120 });
    const { calls, promise } = run(cid, "timeout", {
      exec: { caseId: 20, params: { durationSeconds: 600, reason: "spam burst" } },
    });
    const res = await promise;
    assert.equal(res.ok, true);
    assert.ok(calls.includes("timeout:120000"), `effective 120 s applied: ${calls}`);
    assert.equal(res.params.durationSeconds, 120);
    assert.equal(res.params.requestedDurationSeconds, 600, "the requested value is kept beside it");
    assert.equal(res.params.clamped, true);
    const row = rowsFor(cid, 20)[0];
    assert.match(row.params_json, /"durationSeconds":120/);
    assert.match(row.result_text, /for 120s \(clamped from 600s\)/, "the recorded result notes the clamp");
  });

  it("under the floor end-to-end: 5 s lands as 60 s", async () => {
    const cid = freshCommunity();
    setMode(cid, "timeout", "auto");
    const { calls, promise } = run(cid, "timeout", { exec: { caseId: 21, params: { durationSeconds: 5 } } });
    const res = await promise;
    assert.equal(res.ok, true);
    assert.ok(calls.includes("timeout:60000"));
    assert.equal(res.params.requestedDurationSeconds, 5);
    assert.equal(res.params.durationSeconds, 60);
  });

  it("missing durationSeconds refuses with a specific error AFTER the guards pass", async () => {
    const cid = freshCommunity();
    setMode(cid, "timeout", "auto");
    const { calls, promise } = run(cid, "timeout", { exec: { caseId: 22, params: {} } });
    const res = await promise;
    assert.equal(res.ok, false);
    assert.match(res.error, /needs params\.durationSeconds/);
    assert.ok(calls.includes("roles"), "guards ran first, then the param pre-flight refused");
    assert.equal(repo.getAutomodActionBySlot({ communityId: cid, caseId: 22, subjectUserId: SUBJECT, action: "timeout" }).state, "refused");
  });

  // ── #736: reason rides Discord; breaker pause gates BOTH paths ──────────

  it("the stated reason becomes the Discord timeout reason (case-tagged) - issue #736", async () => {
    const cid = freshCommunity();
    setMode(cid, "timeout", "auto");
    const { record, promise } = run(cid, "timeout", {
      exec: { caseId: 230, params: { durationSeconds: 300, reason: "slur burst in #general" } },
    });
    const res = await promise;
    assert.equal(res.ok, true);
    assert.equal(
      record.lastTimeoutReason,
      "slur burst in #general (automod case #230)",
      "the reason the subject's client surfaces is the STATED one",
    );
  });

  it("a legacy row without a reason still times out on the generic audit line - issue #736 belt", async () => {
    const cid = freshCommunity();
    setMode(cid, "timeout", "auto");
    const { record, promise } = run(cid, "timeout", {
      exec: { caseId: 231, params: { durationSeconds: 120 } },
    });
    const res = await promise;
    assert.equal(res.ok, true, "the dispatcher requires reason — the executor belt must not dead-end legacy rows");
    assert.equal(record.lastTimeoutReason, "Auto-mod timeout (case #231)");
  });

  it("breaker pause refuses the AUTO run naming the reason + resume command, timing out nobody - issue #736", async () => {
    const cid = freshCommunity();
    setMode(cid, "timeout", "auto");
    db.setAutomodPause(cid, { reason: "five timeouts inside five minutes" });
    try {
      const { calls, promise } = run(cid, "timeout", {
        exec: { caseId: 232, params: { durationSeconds: 300, reason: "raid" } },
      });
      const res = await promise;
      assert.equal(res.ok, false);
      assert.match(res.error, /^\*\*Safety paused:\*\* the auto-moderation circuit breaker is tripped/);
      assert.match(res.error, /`timeout` runs stay dark/);
      assert.match(res.error, /\/automodconfig safety resume` \(confirm:true\)/);
      assert.match(res.error, /\*\*Pause reason:\*\* five timeouts inside five minutes/);
      assert.ok(!calls.some((c) => c.startsWith("timeout:")), "the mutation is never reached while paused");
      assert.equal(
        repo.getAutomodActionBySlot({ communityId: cid, caseId: 232, subjectUserId: SUBJECT, action: "timeout" }).state,
        "refused",
      );
    } finally {
      db.clearAutomodPause(cid);
    }
  });

  it("breaker pause refuses an APPROVE click through the same choke point - issue #736", async () => {
    const cid = freshCommunity();
    setMode(cid, "timeout", "suggest");
    const sug = run(cid, "timeout", {
      exec: { caseId: 233, params: { durationSeconds: 600, reason: "raid" } },
    });
    await sug.promise; // records the suggestion (suggest mode is dark-free)
    const row = rowsFor(cid, 233)[0];
    db.setAutomodPause(cid, { reason: "kick storm" });
    try {
      const res = await executor.approveSuggestion({
        actionRowId: row.id,
        claimant: "staff-9",
        deps: makeRecorder().deps,
      });
      assert.equal(res.ok, false);
      assert.match(res.error, /circuit breaker is tripped/);
      assert.match(res.error, /\*\*Pause reason:\*\* kick storm/);
      const fresh = repo.getAutomodAction(row.id);
      assert.notEqual(fresh.state, "executed", "Approve never applies a timeout while paused");
    } finally {
      db.clearAutomodPause(cid);
    }
  });

  it("the pause leaves the ungated actions running (warn is outside the breaker scope) - issue #736", async () => {
    const cid = freshCommunity();
    setMode(cid, "warn", "auto");
    db.setAutomodPause(cid, { reason: "raid" });
    try {
      const { promise } = run(cid, "warn", { exec: { caseId: 234 } });
      const res = await promise;
      assert.equal(res.ok, true, "warn is NOT a breaker-gated action — it runs while paused");
    } finally {
      db.clearAutomodPause(cid);
    }
  });
});

// ── #737: the kick tool — outbound helper, audit reason, honest failures ───

describe("kick tool — required reason rides the audit log through the outbound kick helper", () => {
  it("the stated reason becomes the audit reason (case-tagged) on the outbound call - issue #737", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "auto");
    const { record, promise } = run(cid, "kick", {
      exec: { caseId: 240, params: { reason: "raid leader, second wave" } },
    });
    const res = await promise;
    assert.equal(res.ok, true);
    assert.equal(res.result, "Kicked <@200000000000000002>.");
    assert.equal(
      record.lastKickReason,
      "raid leader, second wave (automod case #240)",
      "the audit-log sentence is the STATED reason, case-tagged",
    );
  });

  it("a legacy row without a reason rides the generic audit line (belt) - issue #737", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "auto");
    const { record, promise } = run(cid, "kick", { exec: { caseId: 241 } });
    const res = await promise;
    assert.equal(res.ok, true, "the reason law lives at dispatch — the executor belt must not dead-end");
    assert.equal(record.lastKickReason, "Auto-mod kick (case #241)");
  });

  it("a Discord failure refuses with the outbound cause verbatim, nobody kicked twice - issue #737", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "auto");
    const { calls, promise } = run(cid, "kick", {
      recorderOverrides: { kickError: "Missing Permissions", kickCode: 50013 },
      exec: { caseId: 242, params: { reason: "hierarchy problem case" } },
    });
    const res = await promise;
    assert.equal(res.ok, false);
    assert.match(
      res.error,
      /kickMember: user .* failed: Missing Permissions — nobody was kicked\.|Missing Permissions — nobody was kicked\./,
    );
    assert.equal(calls.filter((c) => c === "kick").length, 1, "exactly one kick ATTEMPT (the breaker counts it)");
    assert.equal(
      repo.getAutomodActionBySlot({ communityId: cid, caseId: 242, subjectUserId: SUBJECT, action: "kick" }).state,
      "refused",
    );
  });

  it("breaker pause refuses the auto kick and the outbound is never called - issue #737", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "auto");
    db.setAutomodPause(cid, { reason: "ban storm" });
    try {
      const { calls, promise } = run(cid, "kick", {
        exec: { caseId: 243, params: { reason: "raid" } },
      });
      const res = await promise;
      assert.equal(res.ok, false);
      assert.match(res.error, /circuit breaker is tripped/);
      assert.match(res.error, /`kick` runs stay dark/);
      assert.ok(!calls.includes("kick"), "a paused kick never reaches the outbound");
    } finally {
      db.clearAutomodPause(cid);
    }
  });

  it("idempotent Approve: a second click reports the first kick, never a second attempt - issue #737", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "suggest");
    const first = run(cid, "kick", {
      exec: { caseId: 244, params: { reason: "raid" } },
    });
    const recorded = await first.promise;
    assert.equal(recorded.ok, true, "suggest mode records the pending row");
    const row = rowsFor(cid, 244)[0];

    const rec = makeRecorder();
    const a1 = await executor.approveSuggestion({ actionRowId: row.id, claimant: "staff-1", deps: rec.deps });
    assert.equal(a1.ok, true);
    const a2 = await executor.approveSuggestion({ actionRowId: row.id, claimant: "staff-1", deps: rec.deps });
    assert.equal(rec.calls.filter((c) => c === "kick").length, 1, "ONE outbound kick across two clicks");
    assert.equal(a2.ok, true);
    assert.match(String(a2.result ?? ""), /Kicked <@200000000000000002>\./, "the second click reports the existing result");
    assert.equal(a2.deduped, true);
  });
});

// ── #738: the ban tool — outbound banMember, audit reason, honest failures ─

describe("ban tool — required reason rides the audit log through the outbound ban helper", () => {
  it("the stated reason becomes the audit reason (case-tagged) on the outbound call - issue #738", async () => {
    const cid = freshCommunity();
    setMode(cid, "ban", "auto");
    const { record, promise } = run(cid, "ban", {
      exec: { caseId: 250, params: { reason: "doxxing coordinator" } },
    });
    const res = await promise;
    assert.equal(res.ok, true);
    assert.equal(res.result, "Banned <@200000000000000002>.");
    assert.equal(
      record.lastBanReason,
      "doxxing coordinator (automod case #250)",
      "the audit-log sentence is the STATED reason, case-tagged",
    );
  });

  it("a legacy row without a reason rides the generic audit line (belt) - issue #738", async () => {
    const cid = freshCommunity();
    setMode(cid, "ban", "auto");
    const { record, promise } = run(cid, "ban", { exec: { caseId: 251 } });
    const res = await promise;
    assert.equal(res.ok, true, "the reason law lives at dispatch — the executor belt must not dead-end");
    assert.equal(record.lastBanReason, "Auto-mod ban (case #251)");
  });

  it("the outbound never receives a delete-message window (decision 9) - issue #738", async () => {
    const cid = freshCommunity();
    setMode(cid, "ban", "auto");
    const seen = [];
    const { promise } = run(cid, "ban", {
      exec: { caseId: 252, params: { reason: "raid" } },
      recorderOverrides: {
        deps: {
          createBan: async (_cid, userId, opts = {}) => {
            seen.push(opts);
            return { ok: true };
          },
        },
      },
    });
    const res = await promise;
    assert.equal(res.ok, true);
    assert.deepEqual(Object.keys(seen[0]), ["reason"],
      "only a reason rides the ban — no delete_message_days anywhere (decision 9)");
  });

  it("an outbound refusal comes back {ok:false} and the row quotes the cause verbatim - issue #738", async () => {
    const cid = freshCommunity();
    setMode(cid, "ban", "auto");
    const cause = "banMember: user 200000000000000002 in community 1 failed: Missing Permissions";
    const { calls, promise } = run(cid, "ban", {
      recorderOverrides: { banError: cause, banCode: "50013" },
      exec: { caseId: 253, params: { reason: "hierarchy problem case" } },
    });
    const res = await promise;
    assert.equal(res.ok, false);
    assert.equal(
      res.error,
      `${cause} — nobody was banned.`,
      "the typed outbound cause rides VERBATIM + the outcome sentence (rules 3+6)",
    );
    assert.equal(calls.filter((c) => c.startsWith("ban:")).length, 1, "exactly one ban ATTEMPT (the breaker counts it)");
    assert.equal(
      repo.getAutomodActionBySlot({ communityId: cid, caseId: 253, subjectUserId: SUBJECT, action: "ban" }).state,
      "refused",
    );
  });

  it("breaker pause refuses the auto ban and the outbound is never called - issue #738", async () => {
    const cid = freshCommunity();
    setMode(cid, "ban", "auto");
    db.setAutomodPause(cid, { reason: "ban storm" });
    try {
      const { calls, promise } = run(cid, "ban", {
        exec: { caseId: 254, params: { reason: "raid" } },
      });
      const res = await promise;
      assert.equal(res.ok, false);
      assert.match(res.error, /circuit breaker is tripped/);
      assert.match(res.error, /`ban` runs stay dark/);
      assert.ok(!calls.some((c) => c.startsWith("ban:")), "a paused ban never reaches banMember (#738 pin)");
    } finally {
      db.clearAutomodPause(cid);
    }
  });

  it("idempotent Approve: a second click reports the first ban, never a second attempt - issue #738", async () => {
    const cid = freshCommunity();
    setMode(cid, "ban", "suggest");
    const first = run(cid, "ban", {
      exec: { caseId: 255, params: { reason: "raid" } },
    });
    const recorded = await first.promise;
    assert.equal(recorded.ok, true, "suggest mode records the pending row");
    const row = rowsFor(cid, 255)[0];

    const rec = makeRecorder();
    const a1 = await executor.approveSuggestion({ actionRowId: row.id, claimant: "staff-1", deps: rec.deps });
    assert.equal(a1.ok, true);
    const a2 = await executor.approveSuggestion({ actionRowId: row.id, claimant: "staff-1", deps: rec.deps });
    assert.equal(rec.calls.filter((c) => c.startsWith("ban:")).length, 1, "ONE outbound ban across two clicks");
    assert.equal(a2.ok, true);
    assert.match(String(a2.result ?? ""), /Banned <@200000000000000002>\./, "the second click reports the existing result");
    assert.equal(a2.deduped, true);
  });
});

// ── Claim / commit shape ─────────────────────────────────────────────────────

describe("claim-before-commit — mutations run EXACTLY once", () => {
  it("two concurrent auto executes: one mutation, the loser reports the in-flight row", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "auto");
    let release;
    const gate = new Promise((res) => {
      release = res;
    });
    const slow = makeRecorder({
      deps: {
        actions: {
          kick: async () => { slow.calls.push("kick"); await gate; return { ok: true, result: "slow kick" }; },
        },
      },
    });
    const args = (rec) => ({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "kick", caseId: 30, deps: rec.deps,
    });
    const p1 = executor.executeAutomodAction(args(slow));
    const p2 = await executor.executeAutomodAction({ ...args(slow), deps: makeRecorder().deps });
    // p2 claimed the slot second — the UNIQUE slot handed it p1's row back.
    assert.equal(p2.ok, true);
    assert.equal(p2.deduped, true);
    assert.equal(p2.state, "approved");
    assert.equal(p2.inFlight, true, "the winner still owns the run");
    release();
    const p1res = await p1;
    assert.equal(p1res.ok, true);
    assert.equal(p1res.state, "executed");
    assert.equal(slow.calls.filter((c) => c === "kick").length, 1);
    assert.equal(rowsFor(cid, 30).length, 1, "one row per (case, action, subject)");

    // A third run AFTER completion returns the existing RESULT.
    const later = await executor.executeAutomodAction({ ...args(slow), deps: makeRecorder().deps });
    assert.equal(later.deduped, true);
    assert.equal(later.state, "executed");
    assert.equal(later.result, "slow kick");
    assert.equal(slow.calls.filter((c) => c === "kick").length, 1);
  });

  it("without a case the auto slot cannot dedupe — every call is its own row (contract)", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "auto");
    const { calls, deps } = makeRecorder();
    const a = await executor.executeAutomodAction({ communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "kick", deps });
    const b = await executor.executeAutomodAction({ communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "kick", deps });
    assert.equal(a.ok && b.ok, true);
    assert.notEqual(a.actionRowId, b.actionRowId);
    assert.equal(calls.filter((c) => c === "kick").length, 2, "callers that want dedupe MUST pass the caseId");
  });

  it("double Approve click: claims run the mutation once; the loser gets the in-flight row", async () => {
    const cid = freshCommunity();
    let release;
    const gate = new Promise((res) => {
      release = res;
    });
    const slow = makeRecorder({
      deps: { actions: { kick: async () => { slow.calls.push("kick"); await gate; return { ok: true, result: "approved once" }; } } },
    });
    const sug = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "kick", caseId: 31, deps: makeRecorder().deps,
    });
    assert.equal(sug.state, "recorded_suggestion");

    const p1 = executor.approveSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-A", deps: slow.deps });
    const p2 = await executor.approveSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-B", deps: makeRecorder().deps });
    assert.equal(p2.deduped, true);
    assert.equal(p2.state, "approved");
    assert.equal(p2.inFlight, true);
    release();
    const res = await p1;
    assert.equal(res.ok, true);
    assert.equal(res.state, "executed");
    assert.equal(slow.calls.filter((c) => c === "kick").length, 1);
    assert.equal(repo.getAutomodAction(sug.actionRowId).claimed_by, "staff-A", "first click wins the slot");

    // A late third click returns the recorded RESULT (not another run).
    const late = await executor.approveSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-C", deps: makeRecorder().deps });
    assert.equal(late.deduped, true);
    assert.equal(late.state, "executed");
    assert.equal(late.result, "approved once");
  });

  it("dismiss claims the suggestion away from execution and records the decline", async () => {
    const cid = freshCommunity();
    const { calls, deps } = makeRecorder();
    const sug = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "ban", caseId: 32, deps,
    });
    const gone = await executor.dismissSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-X", note: "misidentified" });
    assert.equal(gone.ok, true);
    assert.equal(gone.state, "dismissed");
    assert.deepEqual(calls, [], "dismiss never touches Discord");
    const row = repo.getAutomodAction(sug.actionRowId);
    assert.equal(row.state, "dismissed");
    assert.equal(row.result_text, "misidentified");

    const again = await executor.dismissSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-Y" });
    assert.equal(again.deduped, true);
    assert.equal(again.state, "dismissed");

    // An Approve can NEVER revive a dismissed row.
    const revive = await executor.approveSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-Z", deps });
    assert.equal(revive.deduped, true);
    assert.equal(revive.state, "dismissed");
    assert.deepEqual(calls, []);
  });
});

// ── #735: the ticket tool — the case ticket through the shipped seams ───────

/**
 * #735 ticket seams over the buildDefaultDeps surface — every call recorded,
 * every arm scriptable:
 *  - `claim` scripts the rate-slot answer, `claimError` makes the claim
 *    throw (a claim refused takes NO stamp → the handler must not release);
 *  - `openThrows` makes the open die with the typed cause the REAL
 *    openTicketChannel throws (BOT_PERMISSIONS / CHANNEL_CREATE ride
 *    formatChannelCreateError — the refusal must carry them verbatim);
 *  - `opened` scripts the success shape; `releaseError` makes the release
 *    itself die (logged only — the OPEN cause is what staff must see).
 */
function ticketSeams(over = {}) {
  const claims = [];
  const releases = [];
  const opens = [];
  const deps = {
    claimTicketRateSlot: (communityId, userId) => {
      claims.push({ communityId, userId });
      if (over.claimError) throw over.claimError;
      return over.claim ?? { ok: true, stamp: 1712345678901 };
    },
    releaseTicketRateSlot: (communityId, userId, stamp) => {
      releases.push({ communityId, userId, stamp });
      if (over.releaseError) throw over.releaseError;
      return 1;
    },
    openCaseTicket: async (args) => {
      opens.push(args);
      if (over.openThrows) throw over.openThrows;
      return over.opened ?? {
        ticket: { id: 70, ticket_number: 7 },
        channel: { id: "901000000000000099", name: "ticket-7" },
        skippedStaffRoles: [],
      };
    },
  };
  return { claims, releases, opens, deps };
}

/** Auto-run one ticket intent through recorder guards + recorded seams. */
async function runTicket(cid, caseId, {
  params = { reason: "let's review the channel rules together" },
  referrer = "staff-77",
  narrative = undefined,
  seamOver = {},
  recorderOverrides = {},
} = {}) {
  const seams = ticketSeams(seamOver);
  const { calls, deps } = makeRecorder({ ...recorderOverrides, deps: seams.deps });
  const res = await executor.executeAutomodAction({
    communityId: cid,
    guildId: GUILD,
    subjectUserId: SUBJECT,
    action: "ticket",
    caseId,
    params,
    referrerUserId: referrer,
    ...(narrative !== undefined ? { queuedNoteNarrative: narrative } : {}),
    deps,
  });
  return { res, calls, ...seams };
}

describe("ticket tool (#735) — the member-visible case ticket through the real ticket seams", () => {
  it("auto opens the case ticket: creator = subject (the shipped member-add path), referrer as openedByStaffId, reservation KEPT", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const c = db.createAutomodCase({
      communityId: cid, referrerUserId: "staff-77", messageId: "401", channelId: "301",
      targetUserId: SUBJECT, note: "ticket referral",
    });
    assert.equal(c.ok, true, c.error);
    const { res, claims, releases, opens } = await runTicket(cid, c.case.id);
    assert.equal(res.ok, true, res.error);
    assert.equal(res.state, "executed");
    assert.deepEqual(claims, [{ communityId: cid, userId: SUBJECT }],
      "the SUBJECT is the rate-limited creator — the self-create limit applies to THEM");
    assert.equal(opens.length, 1, "exactly one open attempt");
    assert.equal(opens[0].subjectUserId, SUBJECT, "the subject joins the ticket — creator = the existing member-add path");
    assert.equal(opens[0].openedByStaffId, "staff-77", "the referring staff member is the ticket's staff participant");
    assert.equal(opens[0].reason, "let's review the channel rules together");
    assert.equal(opens[0].communityId, cid);
    assert.equal(opens[0].guildId, GUILD);
    assert.equal(
      res.result,
      `Opened ticket T-7 with <@${SUBJECT}>: <#901000000000000099> (case A-${c.case.case_number}).`,
      "the shipped result-line idiom — the channel MENTION is the card's channel link",
    );
    assert.deepEqual(releases, [], "SUCCESS keeps the reservation — it ages out (#420 law)");
    const row = repo.getAutomodAction(res.actionRowId);
    assert.equal(row.state, "executed");
    assert.equal(row.result_text, res.result, "the card renders this line verbatim");
  });

  it("belt: auto without params.reason refuses with the member-visible cause — zero claims, zero opens", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const { res, claims, opens } = await runTicket(cid, 60, { params: {} });
    assert.equal(res.ok, false);
    assert.equal(res.state, "refused");
    assert.match(res.error, /needs params\.reason — the member-visible opening/);
    assert.match(res.error, /Nothing was opened/);
    assert.deepEqual(claims, []);
    assert.deepEqual(opens, []);
    assert.equal(rowsFor(cid, 60)[0].state, "refused");
  });

  it("commit-time overlap scrub: a reason reproducing the queued note (≥ 40 normalized chars) refuses naming the duplication — BEFORE any slot is taken", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const note = "posted repeated slurs at a member in general chat after two verbal asks to stop";
    const { res, claims, releases, opens } = await runTicket(cid, 62, {
      params: { reason: `${note.slice(0, 40)}— we should talk it through in here` },
      narrative: note,
    });
    assert.equal(res.ok, false, "the member-visible opening would reproduce the private note");
    assert.equal(res.state, "refused");
    assert.match(res.error, new RegExp(`reproduces <@${SUBJECT}>'s queued staff-note narrative`));
    assert.match(res.error, /staff note stands; the ticket was not opened/);
    assert.deepEqual(claims, [], "the scrub precedes the rate slot — a refused row never spends the subject's window");
    assert.deepEqual(opens, []);
    assert.deepEqual(releases, []);
    assert.equal(rowsFor(cid, 62)[0].state, "refused");
  });

  it("scrub floor: a narrative below 40 normalized chars never refuses; a whitespace-collapsed ≥ 40 one does", async () => {
    const short = freshCommunity();
    setMode(short, "ticket", "auto");
    const s = await runTicket(short, 63, {
      params: { reason: "spam incident — let's talk about it" },
      narrative: "spam incident",
    });
    assert.equal(s.res.ok, true, s.res.error);
    assert.equal(s.opens.length, 1, "a short quoted phrase is coincidence, not a reproduction");

    const spaced = freshCommunity();
    setMode(spaced, "ticket", "auto");
    const raw = "spam   from   alt   accounts   in   general   and   off   topic   chat";
    const collapsed = raw.replace(/\s+/g, " ");
    assert.ok(collapsed.length >= 40 && collapsed.length < raw.length, "the fixture collapses past the floor");
    const l = await runTicket(spaced, 64, {
      params: { reason: `${collapsed} — explain the rules` },
      narrative: raw,
    });
    assert.equal(l.res.ok, false, "normalization is part of the law — padding never dodges the floor");
    assert.match(l.res.error, /queued staff-note narrative/);
  });

  it("the queued narrative NEVER persists: stored params stay exactly {reason}", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const { res } = await runTicket(cid, 61, {
      narrative: "weighed the referral; warned verbally already last week and the member apologized.",
    });
    assert.equal(res.ok, true, res.error);
    const row = repo.getAutomodAction(res.actionRowId);
    assert.deepEqual(
      JSON.parse(row.params_json),
      { reason: "let's review the channel rules together" },
      "queuedNoteNarrative is a transient commit input — never params_json",
    );
  });

  it("rate-limit refusal names BOTH minute counts and states the staff note stands; ZERO opens, no release (no stamp was taken)", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const { res, claims, releases, opens } = await runTicket(cid, 65, {
      seamOver: { claim: { ok: false, retryAfterMs: 156_000, minutes: 60 } },
    });
    assert.equal(res.ok, false);
    assert.equal(res.state, "refused");
    assert.match(res.error, /one self-created ticket per 60 minute\(s\)/, "the rate-limit minutes are named");
    assert.match(res.error, /in about 3 minute\(s\)/, "the retry minutes are named");
    assert.match(res.error, /The staff note for this case stands — the ticket was not opened/,
      "contract verbatim: a rate-limit refusal does not delete the staff note");
    assert.equal(claims.length, 1);
    assert.deepEqual(opens, [], "the loser of the slot never reaches the ticket pipeline");
    assert.deepEqual(releases, [], "a REFUSED claim took nothing — nothing to hand back (#420)");
  });

  it("a throwing rate-slot claim refuses with the checked-limit cause — zero opens", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const { res, opens } = await runTicket(cid, 69, {
      seamOver: { claimError: new Error("SQLITE_BUSY: database is locked") },
    });
    assert.equal(res.ok, false);
    assert.equal(res.state, "refused");
    assert.match(res.error, /Could not check the subject's ticket-create rate limit: SQLITE_BUSY/);
    assert.deepEqual(opens, []);
  });

  it("BOT_PERMISSIONS from openTicketChannel: refused with the thrown message VERBATIM + release called with the EXACT stamp", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const err = new Error("I am missing **Create Channels** in the ticket category — fix my permissions.");
    err.code = "BOT_PERMISSIONS";
    const { res, releases } = await runTicket(cid, 66, { seamOver: { openThrows: err } });
    assert.equal(res.ok, false);
    assert.equal(res.state, "refused");
    assert.equal(res.error, err.message, "the typed cause rides VERBATIM — staff can act on it (rule 3)");
    assert.deepEqual(releases, [{ communityId: cid, userId: SUBJECT, stamp: 1712345678901 }],
      "a failed open hands the slot straight back — with the EXACT stamp (#420)");
    assert.equal(rowsFor(cid, 66)[0].error_text, err.message);
  });

  it("CHANNEL_CREATE refuses verbatim too; a FAILING release is logged only — the refusal still carries the open cause", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const err = new Error("Missing Permissions (Discord 50013) — I could not create the ticket channel.");
    err.code = "CHANNEL_CREATE";
    const { res, releases } = await runTicket(cid, 67, {
      seamOver: { openThrows: err, releaseError: new Error("SQLITE_BUSY: database is locked") },
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, err.message, "the release failure never replaces the cause staff must fix");
    assert.equal(releases.length, 1, "the release was still attempted with the exact stamp");
    assert.equal(releases[0].stamp, 1712345678901);
  });

  it("skipped staff-role overwrites append the shipped honest access note (never hidden)", async () => {
    const { formatStaffRoleAccessNote } = require("../src/features/tickets/overwrites");
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const skipped = [{ id: "role-mod", name: "Moderators", reason: "above bot role in hierarchy" }];
    const { res } = await runTicket(cid, 70, {
      seamOver: {
        opened: {
          ticket: { id: 71, ticket_number: 8 },
          channel: { id: "902000000000000098", name: "ticket-8" },
          skippedStaffRoles: skipped,
        },
      },
    });
    assert.equal(res.ok, true, res.error);
    assert.match(res.result, new RegExp(`^Opened ticket T-8 with <@${SUBJECT}>: <#902000000000000098>`));
    assert.ok(
      res.result.endsWith(formatStaffRoleAccessNote(skipped)),
      `the honest access note is appended via the shipped formatter: ${res.result}`,
    );
  });

  it("staff-role subject: the SUGGESTION records at dispatch; Approve AND auto both refuse via the shipped decision-6 guard", async () => {
    const cid = freshCommunity();
    db.addStaffRole(cid, "role-mod", "senior", "tester");

    // Recording a suggestion stays guard-dark (the card may still recommend).
    const sug = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "ticket",
      caseId: 71, params: { reason: "let's talk it through" }, deps: makeRecorder().deps,
    });
    assert.equal(sug.state, "recorded_suggestion");

    // Approve refuses — the guard set was NOT changed for #735.
    const aSeams = ticketSeams();
    const approved = await executor.approveSuggestion({
      actionRowId: sug.actionRowId, claimant: "staff-1",
      deps: makeRecorder({ roleIds: ["role-mod"], deps: aSeams.deps }).deps,
    });
    assert.equal(approved.ok, false);
    assert.equal(approved.state, "refused");
    assert.match(approved.error, /staff role <@&role-mod>/);
    assert.match(approved.error, /#723 decision 6/);
    assert.deepEqual(aSeams.claims, [], "Approve never reaches the rate slot or the pipeline");
    assert.deepEqual(aSeams.opens, []);

    // Auto refuses too (the ticket seam's own pin of the MUTATORS matrix).
    setMode(cid, "ticket", "auto");
    const auto = await runTicket(cid, 72, {
      recorderOverrides: { roleIds: ["role-mod"] },
    });
    assert.equal(auto.res.ok, false);
    assert.equal(auto.res.state, "refused");
    assert.match(auto.res.error, /staff role <@&role-mod>/);
    assert.deepEqual(auto.opens, []);
    assert.deepEqual(auto.claims, []);
  });

  it("double Approve opens exactly ONE ticket — the loser reports the existing outcome (#735 claim law)", async () => {
    const cid = freshCommunity();
    const sug = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "ticket",
      caseId: 73, params: { reason: "talk it through" }, deps: makeRecorder().deps,
    });
    assert.equal(sug.state, "recorded_suggestion");

    // The first click holds the open mid-flight; the second must NOT open again.
    let release;
    const gate = new Promise((res) => { release = res; });
    const seams = ticketSeams();
    const gated = {
      ...seams.deps,
      openCaseTicket: async (args) => {
        const out = await seams.deps.openCaseTicket(args);
        await gate;
        return out;
      },
    };
    const p1 = executor.approveSuggestion({
      actionRowId: sug.actionRowId, claimant: "staff-A", deps: makeRecorder({ deps: gated }).deps,
    });
    const p2 = await executor.approveSuggestion({
      actionRowId: sug.actionRowId, claimant: "staff-B", deps: makeRecorder({ deps: seams.deps }).deps,
    });
    assert.equal(p2.deduped, true, "the second click loses the claim and reports the existing outcome");
    assert.equal(p2.inFlight, true);
    release();
    const res = await p1;
    assert.equal(res.ok, true, res.error);
    assert.equal(res.state, "executed");
    assert.equal(seams.opens.length, 1, "ONE ticket opened for two clicks");
    assert.equal(seams.claims.length, 1);

    const late = await executor.approveSuggestion({
      actionRowId: sug.actionRowId, claimant: "staff-C", deps: makeRecorder({ deps: seams.deps }).deps,
    });
    assert.equal(late.deduped, true);
    assert.equal(late.state, "executed");
    assert.equal(seams.opens.length, 1, "a late third click never re-opens");
  });

  it("a null referrer still opens (subject + staff-role overwrites) — the ticket is never orphaned", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const { res, opens } = await runTicket(cid, 74, { referrer: null });
    assert.equal(res.ok, true, res.error);
    assert.equal(opens[0].openedByStaffId, null, "the belt passes null through — openTicketChannel grants subject + staff-role access");
    assert.match(res.result, /^Opened ticket T-7 with <@200000000000000002>: <#901000000000000099>\./,
      "no case row here — the line states the ticket + channel without inventing a case ref");
  });
});

// ── Action-specific surfaces ─────────────────────────────────────────────────

describe("action handlers — delete pre-flight, real warn", () => {

  it("delete_message: unresolvable params refuse naming both shapes; the legacy pair still deletes (#734)", async () => {
    const missing = freshCommunity();
    setMode(missing, "delete_message", "auto");
    const noIds = await executor.executeAutomodAction({
      communityId: missing, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 41, params: { messageId: "only-message" }, deps: makeRecorder().deps,
    });
    assert.equal(noIds.ok, false);
    assert.match(noIds.error, /needs params\.messages \(\[\{channelId, messageId\}, …\]\)/);
    assert.match(noIds.error, /legacy params\.channelId and params\.messageId/);

    const goneCid = freshCommunity();
    setMode(goneCid, "delete_message", "auto");
    const gone = await executor.executeAutomodAction({
      communityId: goneCid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 42, params: { channelId: "301", messageId: "999" },
      deps: makeRecorder({ message: null }).deps,
    });
    assert.equal(gone.ok, false);
    // Vanished message = that id's 10003 failure, not a crash; the only id
    // failed → the failed row carries the per-id list (#734 honesty).
    assert.equal(gone.state, "failed");
    assert.match(gone.error, /^Deleted 0 of 1 — failed: 999 \(Discord 10003 — message not found, already gone\)\.$/);

    const okCid = freshCommunity();
    setMode(okCid, "delete_message", "auto");
    const { calls, deps } = makeRecorder();
    const ok = await executor.executeAutomodAction({
      communityId: okCid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 43, params: { channelId: "301", messageId: "401" }, deps,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.result, "Deleted 1 message(s) in this case.");
    assert.ok(calls.some((c) => c.startsWith("delete:Auto-mod delete_message")), `delete ran with audit reason: ${calls}`);
    assert.ok(calls.includes("perm:301"), "the Manage Messages pre-flight ran on the target channel");
  });

  // ── #734: the delete tool's own law (perm pre-flight, per-id honesty) ─────

  it("delete_message: Manage Messages missing on ANY channel refuses naming it — ZERO deletes (#734)", async () => {
    const cid = freshCommunity();
    setMode(cid, "delete_message", "auto");
    const { calls, deps } = makeRecorder({ canManageChannels: ["301"] }); // 302 lacks it
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 411,
      params: { messages: [
        { channelId: "301", messageId: "401" },
        { channelId: "302", messageId: "402" },
        { channelId: "301", messageId: "403" }, // second id in the MANAGED channel too
      ] },
      deps,
    });
    assert.equal(res.ok, false);
    assert.equal(res.state, "refused");
    assert.match(res.error, /missing \*\*Manage Messages\*\* in channel\(s\) <#302>/);
    assert.match(res.error, /nothing was deleted/);
    assert.ok(calls.includes("perm:301") && calls.includes("perm:302"), `each DISTINCT channel checked once: ${calls}`);
    assert.equal(calls.filter((c) => c.startsWith("fetch:")).length, 0,
      "the check runs BEFORE any message fetch — zero deletions guaranteed");
    assert.equal(rowsFor(cid, 411)[0].state, "refused");
    assert.equal(rowsFor(cid, 411)[0].error_text, res.error, "the card shows this cause verbatim");
  });

  it("delete_message: a vanished channel / bot-not-in-guild refuses with THAT cause (#734)", async () => {
    const cid = freshCommunity();
    setMode(cid, "delete_message", "auto");
    const { calls, deps } = makeRecorder({ canManageError: "channel 301 no longer exists" });
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 412, params: { messages: [{ channelId: "301", messageId: "401" }] }, deps,
    });
    assert.equal(res.ok, false);
    assert.equal(res.state, "refused");
    assert.match(
      res.error,
      /Could not verify the bot's Manage Messages permission in channel 301: channel 301 no longer exists — nothing was deleted\./,
    );
    assert.equal(calls.filter((c) => c.startsWith("delete:")).length, 0);
  });

  it("delete_message: all-success multi-channel line names the count (#734)", async () => {
    const cid = freshCommunity();
    setMode(cid, "delete_message", "auto");
    const { calls, deps } = makeRecorder();
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 413,
      params: { messages: [
        { channelId: "301", messageId: "401" },
        { channelId: "302", messageId: "402" },
      ] },
      deps,
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.state, "executed");
    assert.equal(res.result, "Deleted 2 message(s) in this case.");
    assert.ok(calls.includes("fetch:301:401") && calls.includes("fetch:302:402"));
    assert.equal(calls.filter((c) => c.startsWith("delete:")).length, 2);
  });

  it("delete_message: a partial failure lists the failed id + Discord cause — never a clean success (#734)", async () => {
    const cid = freshCommunity();
    setMode(cid, "delete_message", "auto");
    const recorder = makeRecorder({
      deps: {
        fetchMessage: async (_ch, msg) => {
          if (msg === "402") throw new Error("Missing Permissions");
          return { delete: async () => {} };
        },
      },
    });
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 414,
      params: { messages: [
        { channelId: "301", messageId: "401" },
        { channelId: "301", messageId: "402" },
        { channelId: "301", messageId: "403" },
      ] },
      deps: recorder.deps,
    });
    // EXECUTED with the honest line as the report (#733 partial idiom):
    assert.equal(res.ok, true, res.error);
    assert.equal(res.state, "executed");
    assert.equal(res.result, "Deleted 2 of 3 — failed: 402 (Missing Permissions).");
    assert.doesNotMatch(res.result, /all succeeded|success/i, "never a clean-success claim on a partial");
    assert.equal(
      repo.getAutomodActionBySlot({ communityId: cid, caseId: 414, subjectUserId: SUBJECT, action: "delete_message" }).result_text,
      "Deleted 2 of 3 — failed: 402 (Missing Permissions).",
    );
  });

  it("delete_message: ALL failed is the failed row carrying the same per-id list (#734)", async () => {
    const cid = freshCommunity();
    setMode(cid, "delete_message", "auto");
    const recorder = makeRecorder({
      deps: {
        fetchMessage: async () => { throw new Error("REST 403: Missing Permissions"); },
      },
    });
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 415,
      params: { messages: [
        { channelId: "301", messageId: "401" },
        { channelId: "301", messageId: "402" },
      ] },
      deps: recorder.deps,
    });
    assert.equal(res.ok, false);
    assert.equal(res.state, "failed");
    assert.equal(
      res.error,
      "Deleted 0 of 2 — failed: 401 (REST 403: Missing Permissions), 402 (REST 403: Missing Permissions).",
    );
    assert.equal(repo.getAutomodActionBySlot({ communityId: cid, caseId: 415, subjectUserId: SUBJECT, action: "delete_message" }).state, "failed");
  });

  it("delete_message: a message vanished MID-LOOP is that id's 10003 failure, not a crash (#734)", async () => {
    const cid = freshCommunity();
    setMode(cid, "delete_message", "auto");
    const recorder = makeRecorder({
      deps: {
        fetchMessage: async (_ch, msg) => (msg === "402" ? null : { delete: async () => {} }),
      },
    });
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 416,
      params: { messages: [
        { channelId: "301", messageId: "401" },
        { channelId: "301", messageId: "402" },
      ] },
      deps: recorder.deps,
    });
    assert.equal(res.ok, true, res.error);
    assert.match(res.result, /^Deleted 1 of 2 — failed: 402 \(Discord 10003 — message not found, already gone\)\.$/);
  });

  it("delete_message: a staff author's SUGGESTION records; Approve refuses (#734 + decision 6)", async () => {
    const cid = freshCommunity();
    db.addStaffRole(cid, "role-mod", "senior", "tester");
    const { calls: suggestCalls, deps: suggestDeps } = makeRecorder({ roleIds: ["role-mod"] });
    const sug = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 417,
      params: { messages: [{ channelId: "301", messageId: "401" }] },
      deps: suggestDeps,
    });
    assert.equal(sug.ok, true, sug.error);
    assert.equal(sug.state, "recorded_suggestion",
      "recording a SUGGESTION still succeeds for a staff author (contract: the recommendation may still appear)");
    assert.deepEqual(suggestCalls, [], "suggest makes zero Discord calls — no guard to consult yet");

    const { calls, deps } = makeRecorder({ roleIds: ["role-mod"] });
    const approved = await executor.approveSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-1", deps });
    assert.equal(approved.ok, false);
    assert.equal(approved.state, "refused");
    assert.match(approved.error, /staff role <@&role-mod>/);
    assert.match(approved.error, /#723 decision 6/);
    assert.equal(calls.filter((c) => c !== "roles").length, 0, "Approve never reaches the perm check or the deletes");
    // (The AUTO arm of the same guard is pinned by the MUTATORS matrix above.)
  });

  it("delete_message: double Approve runs exactly ONE deletion pass (#734 claim-before-commit)", async () => {
    const cid = freshCommunity();
    const deletions = [];
    const shared = makeRecorder({
      deps: {
        fetchMessage: async (_ch, msg) => ({
          delete: async (reason) => { deletions.push({ msg, reason }); },
        }),
      },
    });
    const sug = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 418,
      params: { messages: [
        { channelId: "301", messageId: "401" },
        { channelId: "301", messageId: "402" },
      ] },
      deps: makeRecorder().deps,
    });
    assert.equal(sug.state, "recorded_suggestion");
    const p1 = executor.approveSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-A", deps: shared.deps });
    const p2 = await executor.approveSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-B", deps: makeRecorder().deps });
    assert.equal(p2.deduped, true, "the second click loses the claim and reports the existing outcome");
    const res = await p1;
    assert.equal(res.ok, true, res.error);
    assert.equal(res.result, "Deleted 2 message(s) in this case.");
    assert.equal(deletions.length, 2, "ONE pass deleted its two ids");
    assert.equal(new Set(deletions.map((d) => d.msg)).size, 2);

    const late = await executor.approveSuggestion({ actionRowId: sug.actionRowId, claimant: "staff-C", deps: makeRecorder().deps });
    assert.equal(late.deduped, true);
    assert.equal(late.state, "executed");
    assert.equal(deletions.length, 2, "a late third click never re-deletes");
  });

  it("warn auto REALLY writes a formal warning via createWarning, issuer = referrer", async () => {
    const cid = freshCommunity();
    setMode(cid, "warn", "auto");
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "warn", caseId: 44,
      referrerUserId: "staff-77",
      params: { reason: "posted targeted harassment after a warning" },
      deps: makeRecorder().deps,
    });
    assert.equal(res.ok, true);
    assert.equal(res.state, "executed");
    assert.match(res.result, /Formal warning W-1 recorded/);

    const warns = db.db.prepare(`SELECT * FROM warnings WHERE community_id=?`).all(cid);
    assert.equal(warns.length, 1);
    assert.equal(warns[0].user_id, SUBJECT);
    assert.equal(warns[0].issuer_id, "staff-77", "the referring staff member is the actor");
    assert.equal(warns[0].reason, "posted targeted harassment after a warning");

    // Auto re-entry dedupes to the existing outcome — still ONE warning.
    const again = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "warn", caseId: 44,
      referrerUserId: "staff-77", params: { reason: "posted targeted harassment after a warning" },
      deps: makeRecorder().deps,
    });
    assert.equal(again.deduped, true);
    assert.equal(again.state, "executed");
    assert.equal(db.db.prepare(`SELECT COUNT(*) n FROM warnings WHERE community_id=?`).get(cid).n, 1);
  });

  it("warn with no params.reason synthesizes a case-referencing reason (createWarning needs one)", async () => {
    const cid = freshCommunity();
    setMode(cid, "warn", "auto");
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "warn", caseId: 45,
      deps: makeRecorder().deps,
    });
    assert.equal(res.ok, true);
    const warn = db.db.prepare(`SELECT reason FROM warnings WHERE community_id=?`).get(cid);
    assert.equal(warn.reason, "Auto-moderation sanction from case #45");
  });

  // ── #733: the member-facing warn law (DM setting, framing, partials) ──────

  it("warn honours the guild's warn-DM setting: disabled ⇒ ZERO sends, the skip is reported (#733 — same gate as /warn add)", async () => {
    const cid = freshCommunity();
    setMode(cid, "warn", "auto");
    db.updateGuildSettings(cid, { warn_dm_members: 0 });
    const dms = [];
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "warn", caseId: 47,
      referrerUserId: "staff-77",
      params: { reason: "posted targeted harassment" },
      deps: makeRecorder({ deps: { sendWarnDm: async (userId, payload) => { dms.push({ userId, payload }); } } }).deps,
    });
    assert.equal(res.ok, true);
    assert.equal(res.state, "executed");
    assert.deepEqual(dms, [], "member DMs are off for this server — nothing is DM'd (no automod-specific setting)");
    assert.match(
      res.result,
      /Member DM skipped — member DMs are disabled for this server \(`\/setwarn dm`\)/,
    );
    assert.equal(db.countActiveWarnings(cid, SUBJECT), 1, "the warning itself is recorded regardless");
  });

  it("warn DMs the member the standard /warn add framing — reason rides, staff-only artifacts NEVER do (#733)", async () => {
    const cid = freshCommunity();
    setMode(cid, "warn", "auto");
    const dms = [];
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "warn", caseId: 48,
      referrerUserId: "872000000000000099",
      params: {
        reason: "posted targeted harassment",
        evidenceMessageUrl: `https://discord.com/channels/${GUILD}/301/special-evidence-id-98765`,
      },
      deps: makeRecorder({ deps: {
        fetchGuildName: async () => "Test Guild",
        sendWarnDm: async (userId, payload) => { dms.push({ userId, payload }); },
      } }).deps,
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.state, "executed");
    assert.match(res.result, /Member notified by DM\./);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].userId, SUBJECT);
    const dm = dms[0].payload.embeds[0];
    assert.equal(dm.title, "Warning issued in Test Guild");
    const fields = Object.fromEntries(dm.fields.map((f) => [f.name, f.value]));
    assert.equal(fields.Reason, "posted targeted harassment", "the member reads the formal reason");
    assert.equal(fields["Issued by"], "<@872000000000000099>", "a snowflake issuer renders as a mention");
    assert.equal(fields["Active warnings"], "1");
    assert.match(dm.footer.text, /\/warn mine/);
    const wire = JSON.stringify(dms[0].payload);
    assert.ok(!wire.includes("automod case"), "no note refs / case grammar in the member DM");
    assert.ok(!wire.includes("special-evidence-id-98765"), "the evidence permalink stays staff-only — never in the member DM");
  });

  it("a failing member DM NEVER costs the warning — the executed line reports the partial success (#733, rule 5)", async () => {
    const cid = freshCommunity();
    setMode(cid, "warn", "auto");
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "warn", caseId: 49,
      referrerUserId: "staff-77",
      params: { reason: "posted targeted harassment" },
      deps: makeRecorder({ deps: {
        sendWarnDm: async () => { throw new Error("Cannot send messages to this user"); },
      } }).deps,
    });
    assert.equal(res.ok, true, "the record exists — the DM names its own cause (never a silent drop)");
    assert.equal(res.state, "executed");
    assert.match(res.result, /Formal warning W-1 recorded/);
    assert.match(res.result, /warning recorded, member DM failed: Cannot send messages to this user/);
    assert.equal(db.countActiveWarnings(cid, SUBJECT), 1, "the warning stayed recorded");
  });

  it("warn links the case's ONE automod note as relatedNoteId — injected from params or discovered (#733)", async () => {
    const cid = freshCommunity();
    setMode(cid, "warn", "auto");

    // Injected (what the harness two-phase commit records on the intent):
    const c1 = db.createAutomodCase({
      communityId: cid, referrerUserId: "staff-77", messageId: "401", channelId: "301",
      targetUserId: SUBJECT, note: "harassment referral",
    });
    assert.equal(c1.ok, true, c1.error);
    const note1 = db.createStaffNote({
      communityId: cid, userId: SUBJECT, authorId: "automod",
      content: `weighed the referral (automod case A-${c1.case.case_number})`,
    });
    const injected = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "warn", caseId: c1.case.id,
      referrerUserId: "staff-77",
      params: { reason: "harassment", relatedNoteId: note1.id },
      deps: makeRecorder({ deps: { sendWarnDm: async () => {} } }).deps,
    });
    assert.equal(injected.ok, true, injected.error);
    assert.equal(
      db.db.prepare(`SELECT related_note_id FROM warnings WHERE community_id=?`).get(cid).related_note_id,
      note1.id,
      "the pre-pass note rides the row params into createWarning",
    );

    // Replay fallback (older rows / direct calls): discovery through the
    // shared caseNote.js law — author "automod" + the case suffix.
    const c2 = db.createAutomodCase({
      communityId: cid, referrerUserId: "staff-77", messageId: "402", channelId: "301",
      targetUserId: SUBJECT, note: "repeat referral",
    });
    assert.equal(c2.ok, true, c2.error);
    const note2 = db.createStaffNote({
      communityId: cid, userId: SUBJECT, authorId: "automod",
      content: `second pass (automod case A-${c2.case.case_number})`,
    });
    const replay = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "warn", caseId: c2.case.id,
      referrerUserId: "staff-77",
      params: { reason: "harassment (repeat)" },
      deps: makeRecorder({ deps: { sendWarnDm: async () => {} } }).deps,
    });
    assert.equal(replay.ok, true, replay.error);
    assert.equal(
      db.db.prepare(`SELECT related_note_id FROM warnings WHERE community_id=? ORDER BY warning_number DESC LIMIT 1`)
        .get(cid).related_note_id,
      note2.id,
      "the replay discovers the case's own note — never the older case's",
    );
  });

  it("double Approve on a warn records exactly ONE warning (Approving twice never doubles it, #733)", async () => {
    const cid = freshCommunity();
    const sug = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "warn", caseId: 50,
      referrerUserId: "staff-77", params: { reason: "harassment" },
      deps: makeRecorder().deps,
    });
    assert.equal(sug.state, "recorded_suggestion");
    const p1 = executor.approveSuggestion({
      actionRowId: sug.actionRowId, claimant: "staff-A",
      deps: makeRecorder({ deps: { sendWarnDm: async () => {} } }).deps,
    });
    const p2 = await executor.approveSuggestion({
      actionRowId: sug.actionRowId, claimant: "staff-B", deps: makeRecorder().deps,
    });
    assert.equal(p2.deduped, true, "the second click loses the claim and reports the existing outcome");
    const res = await p1;
    assert.equal(res.ok, true, res.error);
    assert.equal(res.state, "executed");
    assert.equal(db.countActiveWarnings(cid, SUBJECT), 1, "approving twice does NOT create two warnings");
  });

  it("a handler that THROWS is recorded as failed with the cause — never propagates", async () => {
    const cid = freshCommunity();
    setMode(cid, "kick", "auto");
    const res = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "kick", caseId: 46,
      deps: makeRecorder({ deps: { actions: { kick: async () => { throw new Error("REST 403 Missing Permissions"); } } } }).deps,
    });
    assert.equal(res.ok, false);
    assert.equal(res.state, "failed");
    assert.match(res.error, /could not run: REST 403 Missing Permissions/);
    assert.equal(repo.getAutomodActionBySlot({ communityId: cid, caseId: 46, subjectUserId: SUBJECT, action: "kick" }).state, "failed");
  });
});

// ── Never throws: input misuse ───────────────────────────────────────────────

describe("service contract — {ok:false,error} everywhere, no throws, no bogus rows", () => {
  it("invalid inputs refuse specifically and record NOTHING", async () => {
    const cid = freshCommunity();
    const bad = [
      [{ action: "inspect", communityId: cid, guildId: GUILD, subjectUserId: SUBJECT }, /Unknown auto-mod action/],
      [{ action: "kick", communityId: 0, guildId: GUILD, subjectUserId: SUBJECT }, /integer communityId/],
      [{ action: "kick", communityId: cid, guildId: "  ", subjectUserId: SUBJECT }, /guildId/],
      [{ action: "kick", communityId: cid, guildId: GUILD, subjectUserId: "" }, /requires a subjectUserId/],
    ];
    for (const [input, re] of bad) {
      const res = await executor.executeAutomodAction(input);
      assert.equal(res.ok, false, `${JSON.stringify(input)} must refuse`);
      assert.match(res.error, re);
      assert.equal(res.actionRowId, undefined, "a refusal without a valid row cannot fabricate one");
    }
  });

  it("approve/dismiss on unknown rows report instead of exploding", async () => {
    const missing = await executor.approveSuggestion({ actionRowId: 987654 });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /No auto-mod suggestion row #987654/);
    const dismissed = await executor.dismissSuggestion({ actionRowId: 987654 });
    assert.equal(dismissed.ok, false);
    assert.match(dismissed.error, /No auto-mod action row/);
    const junk = await executor.approveSuggestion({});
    assert.equal(junk.ok, false);
  });
});
