/**
 * #729 (epic #723): the per-action mode gate + execution guards, on the
 * callable executor core — Discord-free via the deps seam, real SQLite via
 * loadDb. Covers: the mode matrix (off refuses even when called; suggest
 * records with ZERO Discord calls; auto runs), the staff-role + hierarchy
 * guards per mutating action (and no_action naming staff), the timeout
 * clamp matrix, the atomic claim (concurrent execute / double Approve run
 * the mutation EXACTLY once), the #735 ticket refusal, and the real
 * createWarning write.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

const executor = require("../src/features/automod/executor");
const repo = require("../src/db/repositories/automodCaseActions");

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
    fetchMember: async () => ({
      timeout: async (ms, reason) => {
        calls.push(`timeout:${ms}`);
      },
      kick: async (reason) => {
        calls.push("kick");
      },
    }),
    createBan: async (guildId, userId, { reason } = {}) => {
      calls.push(`ban:${userId}`);
    },
    ...(overrides.deps ?? {}),
  };
  return { calls, deps };
}

/** The params each mutating action needs to reach its handler. */
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
  const { calls, deps } = makeRecorder(opts.recorderOverrides ?? {});
  return {
    calls,
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
      exec: { caseId: 10, params: { rationale: "close call, context explains it" } },
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
    const cid = freshCommunity();
    const deleted = { n: 0 };
    const banned = [];
    const member = {
      roles: {
        cache: { keys: () => ["r-everyone"] },
        highest: { position: 2 },
      },
      timeout: async () => { throw new Error("unused"); },
      kick: async () => { banned.push("kick"); },
    };
    const guild = {
      members: Object.assign(async () => member, {
        fetch: async () => member,
        me: { roles: { highest: { position: 9 } } },
      }),
      bans: { create: async (id, opts) => { banned.push({ id, reason: opts.reason }); } },
    };
    const client = {
      guilds: { cache: { get: (id) => (id === GUILD ? guild : undefined) } },
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async (id) => (id === "401"
              ? { id, delete: async () => { deleted.n += 1; } }
              : null),
          },
        }),
      },
    };

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
    assert.equal(del.ok, true);
    assert.equal(deleted.n, 1);

    // GONE message: the default fetchMessage resolves null → specific refusal.
    const gone = await executor.executeAutomodAction({
      communityId: cid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 162, params: { channelId: "301", messageId: "999" }, deps: { client },
    });
    assert.equal(gone.ok, false);
    assert.match(gone.error, /was not found in channel 301/);

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

// ── Action-specific surfaces ─────────────────────────────────────────────────

describe("action handlers — ticket seam, delete pre-flight, real warn", () => {
  it("ticket auto runs the guards then returns the SPECIFIC #735 refusal", async () => {
    const cid = freshCommunity();
    setMode(cid, "ticket", "auto");
    const { calls, promise } = run(cid, "ticket", { exec: { caseId: 40 } });
    const res = await promise;
    assert.equal(res.ok, false);
    assert.equal(res.state, "refused");
    assert.match(res.error, /the ticket action is not wired yet \(#735\)/);
    assert.ok(calls.includes("roles"), "the staff guard still ran — #735 plugs into the same seam");
    const row = rowsFor(cid, 40)[0];
    assert.equal(row.state, "refused");
    assert.equal(row.error_text, res.error);
  });

  it("delete_message: missing ids refuse; a gone message reports specifically", async () => {
    const missing = freshCommunity();
    setMode(missing, "delete_message", "auto");
    const noIds = await executor.executeAutomodAction({
      communityId: missing, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 41, params: { messageId: "only-message" }, deps: makeRecorder().deps,
    });
    assert.equal(noIds.ok, false);
    assert.match(noIds.error, /needs params\.channelId and params\.messageId/);

    const goneCid = freshCommunity();
    setMode(goneCid, "delete_message", "auto");
    const gone = await executor.executeAutomodAction({
      communityId: goneCid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 42, params: { channelId: "301", messageId: "999" },
      deps: makeRecorder({ message: null }).deps,
    });
    assert.equal(gone.ok, false);
    assert.match(gone.error, /was not found in channel 301 — nothing was deleted/);

    const okCid = freshCommunity();
    setMode(okCid, "delete_message", "auto");
    const { calls, deps } = makeRecorder();
    const ok = await executor.executeAutomodAction({
      communityId: okCid, guildId: GUILD, subjectUserId: SUBJECT, action: "delete_message",
      caseId: 43, params: { channelId: "301", messageId: "401" }, deps,
    });
    assert.equal(ok.ok, true);
    assert.ok(calls.some((c) => c.startsWith("delete:Auto-mod delete_message")), `delete ran with audit reason: ${calls}`);
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
