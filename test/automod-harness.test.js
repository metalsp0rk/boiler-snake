/**
 * #728 (epic #723): automod LLM harness — THE case runner, end to end against
 * real SQLite with every Discord/provider seam scripted.
 *
 * Pinned contract surface (issue #728 + locked decisions 2/4/7):
 *  - lifecycle: `recorded → processing (atomic claim) → complete|failed`; one
 *    referral = one run (the second pass refuses); a restart-stuck
 *    `processing` row is terminalized by the boot sweep;
 *  - the budget PRE-GATE refuses before the claim (case stays `recorded`);
 *    `consumeAutomodCase` fires EXACTLY ONCE at provider acceptance — an
 *    unaccepted call (HTTP error, throwing seam, no key) consumes NOTHING;
 *  - zero mutation during tool rounds; COMMIT after the loop through the
 *    real executor (actions → notes → the #731 reconcileNotes hook); the
 *    round cap STILL commits and finishes `complete` naming
 *    "tool-round cap (12) reached" in last_run_error;
 *  - the referrer-visible lines carry the specific cause —
 *    `**Referred by:** <@id> — provider error: …`, never "something failed"
 *    (card header copy convention, #730);
 *  - run metadata (070): last_model / last_duration_ms / last_tool_names /
 *    decision_log / last_run_error;
 *  - isolation: the runner never throws, a failed post never kills the run,
 *    and the Gork counter/tables are untouched (spied + row-count pinned).
 *
 * Real intake rides the real `referToAutomod` slash path; Discord is fakes.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(() => {
  // Belt: never leave the boot-installed run hook wired past this file.
  require("../src/features/automod/refer").setRunCaseHook(null);
  cleanup();
});

const harness = require("../src/features/automod/harness");
const refer = require("../src/features/automod/refer");
const settingsService = require("../src/features/automod/settings");
const automodFeature = require("../src/features/automod");
const {
  AUTOMOD_MAX_TOOL_ROUNDS,
  AUTOMOD_RUN_TIMEOUT_MS,
} = require("../src/features/automod/constants");

const GUILD = "952000000000000001";
const SRC_CH = "952000000000000002";
const AMOD_CH = "952000000000000003";
const MSG = "952000000000000004";
const REF = "852000000000000011";
const SUB = "852000000000000012";
const BYS = "852000000000000013";
const BOT = "752000000000000014";
const KNOWN = new Set([REF, SUB, BYS, BOT]);

const AI = () => ({
  apiKey: "sk-fake-728-not-a-secret",
  baseUrl: "https://ai.invalid.invalid/v1",
  model: "test-model",
});

let seq = 0;

// ── Discord fakes (refer.js / caseContext.js / executor seam shapes) ────────

function member(id) {
  return {
    id,
    roles: { cache: new Map(), highest: { position: id === BOT ? 10 : 1 } },
    timeout: async () => {},
  };
}

const permsAllow = () => ({ permissionsFor: () => ({ has: () => true }) });

function makeWorld() {
  const posts = [];
  const edits = [];

  const anchor = {
    id: MSG,
    author: { id: SUB },
    content: "you are the worst person who ever lived",
    createdTimestamp: 1764000000000,
    attachments: [],
  };

  const fetchMessages = async (opts) => {
    if (typeof opts === "string") {
      if (opts === MSG) return anchor;
      const err = new Error("Unknown Message");
      err.code = 10003;
      throw err;
    }
    return []; // empty neighbourhood around the anchor
  };

  const srcChannel = {
    id: SRC_CH,
    name: "general",
    guildId: GUILD,
    isTextBased: () => true,
    ...permsAllow(),
    messages: { fetch: fetchMessages },
  };
  const reviewChannel = {
    id: AMOD_CH,
    name: "automod",
    guildId: GUILD,
    isTextBased: () => true,
    ...permsAllow(),
    send: async (payload) => {
      posts.push(payload);
      return {
        id: "952000000000000005",
        edit: async (payload2) => {
          edits.push(payload2);
        },
      };
    },
  };
  const channels = new Map([[SRC_CH, srcChannel], [AMOD_CH, reviewChannel]]);
  const members = new Map([[REF, member(REF)], [SUB, member(SUB)], [BYS, member(BYS)]]);
  const guild = {
    id: GUILD,
    channels: { cache: channels },
    members: { me: member(BOT), cache: members },
  };
  const client = {
    user: { id: BOT },
    guilds: { cache: { get: (id) => (id === GUILD ? guild : null) } },
    channels: {
      fetch: async (id) => {
        const ch = channels.get(String(id));
        if (!ch) throw new Error(`404: channel ${id} not found`);
        return ch;
      },
    },
  };

  const w = {
    posts,
    edits,
    client,
    referDeps: {
      getGuildChannel: (_gid, id) => channels.get(String(id)) ?? null,
      getBotMember: () => member(BOT),
      getMember: (_gid, id) => (KNOWN.has(String(id)) ? member(String(id)) : null),
      fetchMessage: async (_gid, chId, mId) => {
        const ch = channels.get(String(chId));
        try {
          return (await ch?.messages.fetch(String(mId))) ?? null;
        } catch (err) {
          if (err?.code === 10003) return null;
          throw err;
        }
      },
    },
    contextDeps: {
      getGuildChannel: (_gid, id) => channels.get(String(id)) ?? null,
      getMember: (_gid, id) => (KNOWN.has(String(id)) ? member(String(id)) : null),
      getBotMember: () => member(BOT),
      listTextChannels: () => [...channels.values()],
      fetchChannelMessages: (channel, opts) => channel.messages.fetch(opts),
      getTicketByChannel: async () => null,
    },
    lookupDeps: {
      getMember: async (_gid, id) => (KNOWN.has(String(id)) ? member(String(id)) : null),
    },
    // Executor seams: non-staff subject, bot above them, offline member.
    actionDeps: {
      fetchMemberRoleIds: async () => [],
      fetchMemberTopRolePosition: async () => 1,
      fetchBotTopRolePosition: async () => 10,
      fetchMember: async () => member(SUB),
    },
    deps(over = {}) {
      return {
        client,
        chat: async () => {
          throw new Error("chat seam was not scripted for this run");
        },
        aiConfig: AI,
        contextDeps: w.contextDeps,
        lookupDeps: w.lookupDeps,
        actionDeps: w.actionDeps,
        ...over,
      };
    },
  };
  return w;
}

/** Configure through the SHIPPED settings service and refer a real case. */
async function seededCommunity(label, { referOpts = {}, settings: cfg = {} } = {}) {
  const cid = communityKey(`${GUILD}-728-${label}-${(seq += 1)}`);
  settingsService.setEnabled(cid, true);
  settingsService.setChannel(cid, AMOD_CH);
  settingsService.setRules(cid, "No harassment. No slurs. Be decent.");
  for (const [action, mode] of Object.entries(cfg.modes ?? {})) {
    const set = settingsService.setMode(cid, action, mode);
    assert.equal(set.ok, true, set.error);
  }
  if (cfg.timeoutCap != null) {
    const set = settingsService.setTimeoutCap(cid, cfg.timeoutCap);
    assert.equal(set.ok, true, set.error);
  }
  const w = makeWorld();
  const res = await refer.referToAutomod({
    communityId: cid,
    guildId: GUILD,
    referrerUserId: REF,
    messageLink: `https://discord.com/channels/${GUILD}/${SRC_CH}/${MSG}`,
    targetUserId: null,
    note: "same pattern as yesterday",
    deps: w.referDeps,
    ...referOpts,
  });
  assert.equal(res.ok, true, res.error);
  return { cid, caseRow: res.case, w };
}

/**
 * Scripted provider loop. `rounds` entries may carry `probe()` (mid-run DB
 * peeks) and `tools` ([{name, args}] → executed through the REAL dispatcher,
 * captured into `out`). `final` deep-overrides the returned AiResult twin.
 */
function scripted(rounds = [], final = null) {
  const seen = [];
  const chat = async (cfg, opts) => {
    seen.push({ cfg, opts });
    let toolCalls = 0;
    for (const round of rounds) {
      if (round.probe) round.probe();
      round.out = [];
      for (const call of round.tools ?? []) {
        round.out.push(await opts.executeTool(call.name, call.args));
        toolCalls += 1;
      }
    }
    const base = {
      ok: true,
      content: "decision summary text",
      reason: null,
      status: null,
      error: null,
      finishReason: "stop",
      rounds: rounds.length,
    };
    return { ...base, ...(final ?? {}), toolCalls };
  };
  chat.seen = seen;
  return chat;
}

const rowCount = (sql, params = []) => Number(db.db.prepare(sql).get(...params).n);
const actionRows = (cid, caseId) => db.listAutomodActionsForCase(cid, caseId);
const decisionField = (payload) => payload.embeds[0].fields[0].value;
const embed = (payload) => payload.embeds[0];

function captureConsole() {
  const orig = { error: console.error, log: console.log };
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  console.log = (...args) => lines.push(args.map(String).join(" "));
  return {
    lines,
    restore() {
      console.error = orig.error;
      console.log = orig.log;
    },
  };
}

async function waitFor(predicate, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

// ── 1. the accepted happy path ───────────────────────────────────────────────

test("accepted run: lifecycle, zero-mutation rounds, commit via the real executor, consume once - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("main");
  const budgetBefore = db.getAutomodBudget(cid);

  const probe = {};
  const chat = scripted([
    {
      tools: [
        { name: "warn", args: { user_id: SUB, reason: "targeted harassment" } },
        { name: "write_staff_note", args: { user_id: SUB, content: "weighed the referral; a formal warning fits" } },
        { name: "read_warnings", args: { user_id: BYS } }, // bystander read is allowed
      ],
      probe: () => {
        // MID-RUN: the claim is visible, NOTHING has mutated yet.
        probe.status = db.getAutomodCaseById(caseRow.id).status;
        probe.actions = actionRows(cid, caseRow.id).length;
        probe.notes = db.listStaffNotes(cid, SUB).length;
      },
    },
  ]);

  const res = await harness.runAutomodCase({
    communityId: cid,
    guildId: GUILD,
    caseId: caseRow.id,
    deps: w.deps({ chat }),
  });

  // ── service shape + lifecycle
  assert.equal(res.ok, true, res.error);
  assert.equal(res.state, "complete");
  assert.equal(res.caseRef, `A-${caseRow.case_number}`);
  assert.deepEqual(probe, { status: "processing", actions: 0, notes: 0 },
    "processing mid-run; actions/notes land only at commit");

  // ── provider seam contract
  const call = chat.seen[0];
  assert.equal(call.opts.maxToolRounds, AUTOMOD_MAX_TOOL_ROUNDS);
  assert.equal(call.opts.timeoutMs, AUTOMOD_RUN_TIMEOUT_MS);
  assert.equal(AUTOMOD_MAX_TOOL_ROUNDS, 12);
  assert.equal(AUTOMOD_RUN_TIMEOUT_MS, 120_000);
  const offered = call.opts.tools.map((t) => t.function.name);
  assert.ok(offered.includes("warn") && offered.includes("timeout") && offered.includes("write_staff_note"));
  assert.ok(!offered.includes("message_user") && !offered.includes("approve_case"),
    "the toolset is exactly the mode-gated action tools + the trio");
  assert.match(call.opts.messages[0].content, /No harassment\. No slurs\./, "the rules ride as the policy");
  assert.match(call.opts.messages[1].content, /automod-case-context\/1|"case_ref"/);

  // ── budget: exactly one consumption for an accepted call
  const budgetAfter = db.getAutomodBudget(cid);
  assert.equal(budgetAfter.used, budgetBefore.used + 1);

  // ── commit ran THROUGH the real executor (suggest default → pending rows)
  const actions = actionRows(cid, caseRow.id);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, "warn");
  assert.equal(actions[0].state, "suggested", "the row state machine (#729): a pending suggestion row is `suggested`; the executor RESULT calls it recorded_suggestion");
  assert.equal(actions[0].subject_user_id, SUB);
  assert.equal(db.parseAutomodActionParams(actions[0]).params.reason, "targeted harassment");

  const notes = db.listStaffNotes(cid, SUB);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].author_id, BOT, "the note author is the bot (client user id)");
  assert.match(notes[0].content, /weighed the referral/);
  assert.match(notes[0].content, new RegExp(`\\(automod case A-${caseRow.case_number}\\)$`));

  // commit order is ACTIONS → NOTES (documented for #730/#731)
  const warnLine = res.commit.lines.findIndex((l) => l.startsWith("- `warn`"));
  const noteLine = res.commit.lines.findIndex((l) => l.startsWith("- staff note"));
  assert.ok(warnLine >= 0 && noteLine > warnLine, `order: ${res.commit.lines.join(" | ")}`);

  // ── posts: placeholder first, then the EDITED case card (#730)
  assert.equal(w.posts.length, 1, "one send — the outcome EDITS the placeholder");
  assert.match(embed(w.posts[0]).title, new RegExp(`case A-${caseRow.case_number} — reviewing`));
  const decision = w.edits[0];
  assert.ok(decision, "the outcome edited the placeholder");
  assert.match(embed(decision).title, new RegExp(`case A-${caseRow.case_number} — decision$`));
  assert.equal(embed(decision).description, `**Referred by:** <@${REF}> — review complete.`);
  const field = decisionField(decision);
  // #730: the Decision field renders from the LEDGER ROWS — per-subject
  // section header with the note ref + one line per row.
  assert.match(field, new RegExp(`\\*\\*Subject:\\*\\* <@${SUB}> · \\*\\*Staff note:\\*\\* N-\\d+`));
  assert.match(field, /`warn` — \*\*pending approval\*\*/);
  assert.match(embed(decision).footer.text, /Model test-model · \d+ ms · 1 round\(s\) · tools: warn, write_staff_note, read_warnings/);
  assert.deepEqual(decision.allowedMentions, { parse: [] });
  const buttons = (decision.components ?? []).flatMap((r) => r.components ?? []);
  assert.deepEqual(
    buttons.map((b) => b.custom_id),
    [`am:card:approve:${actions[0].id}`, `am:card:dismiss:${actions[0].id}`],
    "#730: Approve/Dismiss ride the pending row's id",
  );

  // ── 070 metadata
  const row = db.getAutomodCaseById(caseRow.id);
  assert.equal(row.status, "complete");
  assert.equal(row.last_model, "test-model");
  assert.ok(Number.isInteger(row.last_duration_ms) && row.last_duration_ms >= 0);
  assert.deepEqual(JSON.parse(row.last_tool_names), ["warn", "write_staff_note", "read_warnings"]);
  const log = JSON.parse(row.decision_log);
  assert.equal(log[0].tool, "warn");
  assert.equal(log[0].state, "recorded");
  // #730: the run persists ONE trailing `meta` entry (window participants for
  // card rebuilds) — the tool-call log keeps its own tail.
  const toolLog = log.filter((e) => e.state !== "meta");
  assert.equal(toolLog.at(-1).tool, "read_warnings");
  assert.equal(log.at(-1).tool, "_card_participants");
  assert.equal(log.at(-1).args_summary, SUB, "the anchor author was seen; the considered side is subtracted at render");
  assert.ok(row.last_run_error == null);
});

// ── 2. acceptance accounting (consume NOTHING without acceptance) ────────────

test("HTTP 500 before acceptance: failed case, zero budget, the provider's own words - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("http500");
  const chat = scripted([], {
    ok: false,
    status: 500,
    error: "HTTP 500 upstream exploded",
    reason: "http",
    errorBody: '{"error":{"message":"upstream oom"}}',
  });

  const res = await harness.runAutomodCase({
    communityId: cid,
    guildId: GUILD,
    caseId: caseRow.id,
    deps: w.deps({ chat }),
  });

  assert.equal(res.ok, false);
  assert.equal(res.state, "failed");
  assert.equal(db.getAutomodBudget(cid).used, 0, "a call that never got accepted consumes NOTHING");
  assert.deepEqual(actionRows(cid, caseRow.id), []);

  const decision = w.edits[0];
  assert.match(embed(decision).title, /run failed/);
  assert.match(embed(decision).description, new RegExp(`\\*\\*Referred by:\\*\\* <@${REF}> — provider error: HTTP 500 upstream exploded`));
  assert.match(embed(decision).description, /provider said: \{"error"/, "the provider's body names the real cause");
  assert.match(decisionField(decision), /No action calls were recorded this run/);

  const row = db.getAutomodCaseById(caseRow.id);
  assert.equal(row.status, "failed");
  assert.match(row.last_run_error, /provider error: HTTP 500 upstream exploded/);
});

test("a throwing provider seam is 'the provider failed': specific cause, no consumption, no throw - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("throw");
  const chat = async () => {
    throw new Error("socket died mid-handshake");
  };
  chat.seen = [];
  const cap = captureConsole();
  let res;
  try {
    res = await harness.runAutomodCase({
      communityId: cid,
      guildId: GUILD,
      caseId: caseRow.id,
      deps: w.deps({ chat }),
    });
  } finally {
    cap.restore();
  }
  assert.equal(res.state, "failed");
  assert.match(w.edits[0].embeds[0].description, /provider call threw: socket died mid-handshake/);
  assert.equal(db.getAutomodBudget(cid).used, 0);
  assert.ok(cap.lines.some((l) => l.includes("[automod] harness provider call threw")
    && l.includes(`community ${cid}`) && l.includes(`case A-${caseRow.case_number}`)),
  `log names ids: ${cap.lines.join(" | ")}`);
});

test("no AI key: failed after the claim, zero consumption, the operator cause names itself - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("nokey");
  const chat = scripted([]);
  const res = await harness.runAutomodCase({
    communityId: cid,
    guildId: GUILD,
    caseId: caseRow.id,
    deps: w.deps({ chat, aiConfig: () => ({ apiKey: null, baseUrl: null, model: null }) }),
  });
  assert.equal(res.state, "failed");
  assert.equal(chat.seen.length, 0, "no provider call without a key");
  assert.equal(db.getAutomodBudget(cid).used, 0);
  const row = db.getAutomodCaseById(caseRow.id);
  assert.equal(row.status, "failed");
  assert.match(row.last_run_error, /AI not configured — no AI_API_KEY/);
  assert.ok(row.last_model == null);
  assert.match(w.edits[0].embeds[0].description, /automod run failed: AI not configured/);
});

// ── 3. the budget pre-gate lives BEFORE the claim ────────────────────────────

test("blocked / exhausted budgets refuse BEFORE claiming — the case stays re-runnable - issue #728", async () => {
  const blocked = await seededCommunity("blocked");
  settingsService.setDailyBudget(blocked.cid, -1);
  const chatBlocked = scripted([]);
  const r1 = await harness.runAutomodCase({
    communityId: blocked.cid,
    guildId: GUILD,
    caseId: blocked.caseRow.id,
    deps: blocked.w.deps({ chat: chatBlocked }),
  });
  assert.equal(r1.state, "refused");
  assert.match(r1.error, /blocked \(`-1`\)/);
  assert.equal(chatBlocked.seen.length, 0);
  assert.equal(db.getAutomodCaseById(blocked.caseRow.id).status, "recorded");

  const spent = await seededCommunity("spent", {});
  settingsService.setDailyBudget(spent.cid, 1);
  assert.equal(db.consumeAutomodCase(spent.cid).ok, true);
  const chatSpent = scripted([]);
  const r2 = await harness.runAutomodCase({
    communityId: spent.cid,
    guildId: GUILD,
    caseId: spent.caseRow.id,
    deps: spent.w.deps({ chat: chatSpent }),
  });
  assert.equal(r2.state, "refused");
  assert.match(r2.error, /exhausted — 1 of 1 cases counted today/);
  assert.equal(db.getAutomodCaseById(spent.caseRow.id).status, "recorded",
    "the pre-gate refused BEFORE the atomic claim — nothing moved");
  assert.equal(chatSpent.seen.length, 0);
});

test("input + routing refusals: garbage ids and cross-community runs never claim - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("routing");
  const other = communityKey(`${GUILD}-728-other-${(seq += 1)}`);

  const r1 = await harness.runAutomodCase({ communityId: "nope", guildId: GUILD, caseId: caseRow.id, deps: w.deps() });
  assert.equal(r1.state, "refused");
  assert.match(r1.error, /valid integer communityId/);

  const r2 = await harness.runAutomodCase({ communityId: cid, guildId: "", caseId: caseRow.id, deps: w.deps() });
  assert.match(r2.error, /guildId \(Discord snowflake\) is required/);

  const r3 = await harness.runAutomodCase({ communityId: other, guildId: GUILD, caseId: caseRow.id, deps: w.deps() });
  assert.equal(r3.state, "refused");
  assert.match(r3.error, /refusing to run a case across communities/);

  const r4 = await harness.runAutomodCase({ communityId: cid, guildId: GUILD, caseId: 999999, deps: w.deps() });
  assert.match(r4.error, /No auto-mod case row #999999/);

  assert.equal(db.getAutomodCaseById(caseRow.id).status, "recorded", "every refusal left the row untouched");
});

// ── 4. one referral, one run (the atomic claim) ──────────────────────────────

test("a second run for the same case refuses; exactly one provider call and one consumption ever - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("twice");
  const chat = scripted([]);
  const deps = w.deps({ chat });

  const first = await harness.runAutomodCase({ communityId: cid, guildId: GUILD, caseId: caseRow.id, deps });
  assert.equal(first.ok, true);

  const second = await harness.runAutomodCase({ communityId: cid, guildId: GUILD, caseId: caseRow.id, deps });
  assert.equal(second.state, "refused");
  assert.match(second.error, /is not runnable \(status `complete`\) — one referral starts exactly one run/);
  assert.equal(chat.seen.length, 1, "the second pass never reaches the provider");
  assert.equal(db.getAutomodBudget(cid).used, 1);
});

// ── 5. the round cap commits what it recorded ────────────────────────────────

test("round cap: the partial decision commits, the cause names the cap, the case completes - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("cap");
  const chat = scripted(
    [
      { tools: [{ name: "timeout", args: { user_id: SUB, duration_seconds: 300, reason: "harassment" } }] },
    ],
    { ok: false, reason: "cap", error: "max tool rounds reached" },
  );

  const res = await harness.runAutomodCase({
    communityId: cid,
    guildId: GUILD,
    caseId: caseRow.id,
    deps: w.deps({ chat }),
  });

  assert.equal(res.state, "complete", "it committed what it had — the run finished, it just ran out of rounds");
  assert.match(res.error, /tool-round cap \(12\) reached/);
  assert.equal(db.getAutomodBudget(cid).used, 1, "cap is ACCEPTANCE");

  const actions = actionRows(cid, caseRow.id);
  assert.equal(actions.length, 1, "the recorded intent committed anyway");
  assert.equal(actions[0].state, "suggested", "the row state machine (#729): a pending suggestion row is `suggested`; the executor RESULT calls it recorded_suggestion");

  const row = db.getAutomodCaseById(caseRow.id);
  assert.equal(row.status, "complete");
  assert.match(row.last_run_error, /tool-round cap \(12\) reached — the run committed what it had recorded/);

  const decision = w.edits[0];
  assert.match(embed(decision).title, /— decision$/);
  assert.match(embed(decision).description, /partial decision: the run hit the tool-round cap \(12\) reached/);
  assert.match(decisionField(decision), /`timeout` — \*\*pending approval\*\*/);
});

// ── 6. the commit owns clamping, the harness passes through ──────────────────

test("auto-mode timeout: the harness passes the duration UNCLAMPED; the executor clamps and records both - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("clamp", {
    settings: { modes: { timeout: "auto" }, timeoutCap: 120 },
  });
  const chat = scripted([
    { tools: [{ name: "timeout", args: { user_id: SUB, duration_seconds: 99999, reason: "harassment" } }] },
  ]);

  const res = await harness.runAutomodCase({
    communityId: cid,
    guildId: GUILD,
    caseId: caseRow.id,
    deps: w.deps({ chat }),
  });
  assert.equal(res.state, "complete");

  const [row] = actionRows(cid, caseRow.id);
  assert.equal(row.action, "timeout");
  assert.equal(row.state, "executed", "auto mode ran through the guards (faked) to the member.timeout seam");
  const params = db.parseAutomodActionParams(row).params;
  assert.equal(params.durationSeconds, 120, "the guild cap owns the clamp — applied by the EXECUTOR");
  assert.equal(params.requestedDurationSeconds, 99999, "the row keeps what the model asked for");
  assert.equal(params.clamped, true);
  assert.match(row.result_text, /clamped from 99999s/);
  assert.match(decisionField(w.edits[0]), /`timeout` — \*\*executed\*\*/);
});

// ── 7. note enforcement + the #731 reconciler hook ──────────────────────────

test("bystander notes are refused; the #731 reconciler hook runs after notes and cannot break the commit - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("recon");
  let hookArgs = null;
  const round1 = {
    tools: [
      { name: "write_staff_note", args: { user_id: BYS, content: "also note this random member" } },
      { name: "no_action", args: { user_id: SUB, rationale: "single remark, no pattern" } },
      { name: "write_staff_note", args: { user_id: SUB, content: "weighed it; no sanction" } },
    ],
  };
  const chat = scripted([round1]);

  const res = await harness.runAutomodCase({
    communityId: cid,
    guildId: GUILD,
    caseId: caseRow.id,
    deps: w.deps({
      chat,
      reconcileNotes: async (args) => {
        hookArgs = args;
        return { lines: ["- reconciler: consideration audited"] };
      },
    }),
  });

  // The bystander refusal came back as a TOOL RESULT (the model can react),
  // while the considered subject's note recorded normally:
  assert.match(round1.out[0], /not a considered user/);
  assert.match(round1.out[2], /^Staff note recorded for <@852000000000000012>/);
  assert.match(decisionField(w.edits[0]), /reconciler: consideration audited/);

  assert.equal(db.listStaffNotes(cid, BYS).length, 0, "bystanders get NO note (decision 4)");
  assert.equal(db.listStaffNotes(cid, SUB).length, 1);

  assert.ok(hookArgs, "commitRunIntents calls the #731 hook after notes");
  assert.deepEqual(hookArgs.consideredUserIds, [SUB]);
  assert.deepEqual(hookArgs.notedUserIds, [SUB]);
  assert.equal(hookArgs.caseRow.id, caseRow.id);
  assert.equal(res.state, "complete");

  // A BROKEN reconciler is a partial-failure line on a SECOND case — never a
  // dead run (its own failure never cancels the commit that already landed):
  const w2 = makeWorld();
  const second = await refer.referToAutomod({
    communityId: cid,
    guildId: GUILD,
    referrerUserId: REF,
    messageLink: `https://discord.com/channels/${GUILD}/${SRC_CH}/${MSG}`,
    deps: w2.referDeps,
  });
  assert.equal(second.ok, true, second.error);

  const cap = captureConsole();
  let r2;
  try {
    r2 = await harness.runAutomodCase({
      communityId: cid,
      guildId: GUILD,
      caseId: second.case.id,
      deps: w2.deps({
        chat: scripted([]),
        reconcileNotes: () => {
          throw new Error("reconciler exploded");
        },
      }),
    });
  } finally {
    cap.restore();
  }
  assert.equal(r2.state, "complete", "a dead reconciler never kills the run");
  assert.match(decisionField(w2.edits[0]), /note reconciliation: \*\*failed\*\* — reconciler exploded/);
  assert.ok(cap.lines.some((l) => l.includes("note reconciliation") && l.includes("reconciler exploded")));
});

// ── 8. degraded posts never kill the run ─────────────────────────────────────

test("posting failures degrade to logs — the decision still runs and records - issue #728", async () => {
  const cleared = await seededCommunity("nochannelpost");
  settingsService.clearChannel(cleared.cid); // cleared AFTER intake
  const cap = captureConsole();
  let res;
  try {
    res = await harness.runAutomodCase({
      communityId: cleared.cid,
      guildId: GUILD,
      caseId: cleared.caseRow.id,
      deps: cleared.w.deps({ chat: scripted([]) }),
    });
  } finally {
    cap.restore();
  }
  assert.equal(res.state, "complete");
  assert.equal(cleared.w.posts.length, 0);
  assert.ok(cap.lines.some((l) => l.includes("automod channel unset")), "the degraded surface is logged, not silent");

  // Channel set but unreachable: placeholder + outcome posts both fail, loudly.
  const gone = await seededCommunity("gonechannel");
  const brokenClient = {
    user: { id: BOT },
    guilds: gone.w.client.guilds,
    channels: { fetch: async () => { throw new Error("404 Unknown Channel"); } },
  };
  const cap2 = captureConsole();
  let res2;
  try {
    res2 = await harness.runAutomodCase({
      communityId: gone.cid,
      guildId: GUILD,
      caseId: gone.caseRow.id,
      deps: gone.w.deps({ chat: scripted([]), client: brokenClient }),
    });
  } finally {
    cap2.restore();
  }
  assert.equal(res2.state, "complete", "a dead channel never fails the JUDGMENT");
  assert.equal(db.getAutomodCaseById(gone.caseRow.id).status, "complete");
  assert.ok(cap2.lines.some((l) => l.includes("placeholder post (continuing without it)")));
  assert.ok(cap2.lines.some((l) => l.includes("outcome post")));
  // #730 send-failure law: never claim the card posted — the failure is
  // logged WITH ids and the case row carries the structured record.
  assert.ok(cap2.lines.some((l) => l.includes("card post failed")));
  const postLog = JSON.parse(db.getAutomodCaseById(gone.caseRow.id).decision_log);
  assert.ok(
    postLog.some((e) => e.tool === "_card_post_error" && e.state === "failed"),
    "the case row says the card did not post",
  );
});

// ── 9. boot sweep + the refer→harness trigger (index.js wiring) ──────────────

test("boot sweep terminalizes stuck processing rows and posts the interrupted notice - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("sweep");
  db.db.prepare(`UPDATE automod_cases SET status='processing' WHERE id=?`).run(caseRow.id);

  const cap = captureConsole();
  let out;
  try {
    out = automodFeature.start({ discord: w.client });
  } finally {
    refer.setRunCaseHook(null); // start() wired the production hook — inert after this test
    cap.restore();
  }
  assert.deepEqual(out, { checked: 1, flipped: 1 });

  const row = db.getAutomodCaseById(caseRow.id);
  assert.equal(row.status, "failed");
  assert.equal(row.last_run_error, harness.INTERRUPTED_ERROR);
  assert.ok(cap.lines.some((l) => l.includes("[automod] boot sweep: 1/1 case run(s) interrupted by restart marked failed")));

  const delivered = await waitFor(() => w.posts.length >= 1);
  assert.ok(delivered, "the detached sweep notice lands in the automod channel");
  assert.match(embed(w.posts[0]).title, /— interrupted$/);
  assert.match(embed(w.posts[0]).description, new RegExp(`Referred by <@${REF}>`));
  assert.match(embed(w.posts[0]).description, /run interrupted by restart/);
});

test("the sweep survives a dead channel (best-effort notice, the flip is what matters) - issue #728", async () => {
  const cid = communityKey(`${GUILD}-728-sweepdead-${(seq += 1)}`);
  settingsService.setChannel(cid, AMOD_CH);
  const created = db.createAutomodCase({
    communityId: cid,
    referrerUserId: REF,
    messageId: null,
    channelId: null,
    targetUserId: SUB,
    note: null,
  });
  assert.equal(created.ok, true, created.error);
  db.db.prepare(`UPDATE automod_cases SET status='processing' WHERE id=?`).run(created.case.id);

  const brokenClient = {
    channels: { fetch: async () => { throw new Error("404 Unknown Channel"); } },
  };
  const cap = captureConsole();
  let sweep;
  try {
    sweep = harness.sweepInterruptedRuns({ client: brokenClient });
    assert.deepEqual({ checked: sweep.checked, flipped: sweep.flipped }, { checked: 1, flipped: 1 });
    await Promise.allSettled(sweep.posts); // detached posts settle INSIDE the capture window
  } finally {
    cap.restore();
  }
  const row = db.getAutomodCaseById(created.case.id);
  assert.equal(row.status, "failed");
  assert.ok(
    cap.lines.some((l) => l.includes("boot sweep notice (best effort)")),
    `the dead notice is logged, never silent: ${cap.lines.join(" | ")}`,
  );
});

// ── 10. refer trigger (the real slash arm) + its crash guard ─────────────────

test("the refer handler fires the harness detached after the ack - issue #728", async () => {
  const cid = communityKey(`${GUILD}-728-trigger-${(seq += 1)}`);
  settingsService.setEnabled(cid, true);
  settingsService.setChannel(cid, AMOD_CH);
  settingsService.setRules(cid, "No harassment.");

  const w = makeWorld();
  const chat = scripted([]);
  refer.setRunCaseHook(
    harness.makeReferRunHook({
      client: w.client,
      deps: {
        chat,
        aiConfig: AI,
        contextDeps: w.contextDeps,
        lookupDeps: w.lookupDeps,
        actionDeps: w.actionDeps,
      },
    }),
  );

  const replies = [];
  const commandCtx = {
    communityId: cid,
    externalGuildId: GUILD,
    userId: REF,
    subcommand: "refer",
    options: {
      getString: (name) => (name === "message" ? `https://discord.com/channels/${GUILD}/${SRC_CH}/${MSG}` : null),
      getUser: () => null,
    },
    rawInteraction: {
      guild: {
        id: GUILD,
        channels: { cache: new Map(Object.entries({ [SRC_CH]: w.referDeps.getGuildChannel(GUILD, SRC_CH), [AMOD_CH]: w.referDeps.getGuildChannel(GUILD, AMOD_CH) })) },
        members: { me: member(BOT), cache: new Map([[REF, member(REF)]]) },
      },
      user: { id: REF },
      member: member(REF),
    },
    reply: async (payload) => replies.push(payload),
  };

  try {
    await refer.handleReferCommand(commandCtx);
    // The ack ships FIRST — the run is detached behind it.
    assert.match(replies[0].content, /Case: \*\*A-1\*\* — recorded\./);
    assert.equal(replies[0].sensitive, true);

    const ran = await waitFor(() => {
      const row = db.db
        .prepare(`SELECT status FROM automod_cases WHERE community_id=? ORDER BY id DESC LIMIT 1`)
        .get(cid);
      return row && row.status === "complete";
    });
    assert.ok(ran, "the detached run completed the case");
    assert.equal(chat.seen.length, 1);
  } finally {
    refer.setRunCaseHook(null);
  }
});

test("a crashing harness run is logged with ids and never surfaces as an unhandled rejection - issue #728", async () => {
  const cid = communityKey(`${GUILD}-728-crash-${(seq += 1)}`);
  settingsService.setEnabled(cid, true);
  settingsService.setChannel(cid, AMOD_CH);
  settingsService.setRules(cid, "No harassment.");
  const w = makeWorld();

  refer.setRunCaseHook(async () => {
    throw new Error("harness exploded");
  });

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason));
  process.on("unhandledRejection", onUnhandled);
  const cap = captureConsole();
  try {
    await refer.handleReferCommand({
      communityId: cid,
      externalGuildId: GUILD,
      userId: REF,
      subcommand: "refer",
      options: {
        getString: (n) => (n === "message" ? `https://discord.com/channels/${GUILD}/${SRC_CH}/${MSG}` : null),
        getUser: () => null,
      },
      rawInteraction: {
        guild: {
          id: GUILD,
          channels: {
            cache: new Map(
              [SRC_CH, AMOD_CH].map((id) => [id, w.referDeps.getGuildChannel(GUILD, id)]),
            ),
          },
          members: { me: member(BOT), cache: new Map([[REF, member(REF)]]) },
        },
        user: { id: REF },
        member: member(REF),
      },
      reply: async () => {},
    });

    const logged = await waitFor(() =>
      cap.lines.some(
        (l) =>
          l.includes("[automod] automod run crashed") &&
          l.includes(`community ${cid}`) &&
          l.includes("harness exploded"),
      ),
    );
    assert.ok(logged, `crash logged: ${cap.lines.join(" | ")}`);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], "the detached fire owns its rejection (rule 1)");

    const stuck = db.db
      .prepare(`SELECT status FROM automod_cases WHERE community_id=? ORDER BY id DESC LIMIT 1`)
      .get(cid);
    assert.equal(stuck.status, "recorded", "a crashed hook leaves the case re-runnable");
  } finally {
    cap.restore();
    process.off("unhandledRejection", onUnhandled);
    refer.setRunCaseHook(null);
  }
});

// ── 11. Gork isolation (contract: "A test spies on the Gork counter") ────────

test("a full run touches NOTHING Gork: counter spied, tables pinned, sources clean - issue #728", async () => {
  const gorkBudget = require("../src/features/gork/budget");
  const calls = {};
  const restores = [];
  for (const [name, fn] of Object.entries(gorkBudget)) {
    if (typeof fn !== "function") continue;
    calls[name] = 0;
    gorkBudget[name] = (...args) => {
      calls[name] += 1;
      return fn(...args);
    };
    restores.push([name, fn]);
  }

  const usageBefore = rowCount(`SELECT COUNT(*) AS n FROM gork_usage`);
  const interactionsBefore = rowCount(`SELECT COUNT(*) AS n FROM gork_interactions`);

  const { cid, caseRow, w } = await seededCommunity("gorkisolation");
  const res = await harness.runAutomodCase({
    communityId: cid,
    guildId: GUILD,
    caseId: caseRow.id,
    deps: w.deps({ chat: scripted([{ tools: [{ name: "warn", args: { user_id: SUB, reason: "harassment" } }] }]) }),
  });
  assert.equal(res.state, "complete", "the run genuinely ran");

  for (const [name, fn] of restores) gorkBudget[name] = fn;
  assert.deepEqual(
    Object.entries(calls).filter(([, n]) => n > 0),
    [],
    `Gork counter functions called: ${JSON.stringify(calls)}`,
  );
  assert.equal(rowCount(`SELECT COUNT(*) AS n FROM gork_usage`), usageBefore);
  assert.equal(rowCount(`SELECT COUNT(*) AS n FROM gork_interactions`), interactionsBefore);

  // Source tripwire: the harness modules import NOTHING from ../gork/** —
  // the shared surface is the AI_* env trio via core/ai.js only (decision 7).
  const fs = require("node:fs");
  const path = require("node:path");
  const featureDir = path.join(__dirname, "..", "src", "features", "automod");
  for (const file of ["harness.js", "harnessTools.js", "prompt.js", "refer.js", "index.js"]) {
    const source = fs.readFileSync(path.join(featureDir, file), "utf8");
    assert.doesNotMatch(
      source,
      /require\((["'])[^'"]*gork[^'"]*\1\)/,
      `${file} must never require Gork code (locked decision 7)`,
    );
  }
});

// ── 12. the runner never throws (rule 6, belt path) ──────────────────────────

test("a throwing injected seam still returns the service shape with the cause - issue #728", async () => {
  const { cid, caseRow, w } = await seededCommunity("belt");
  const cap = captureConsole();
  let res;
  try {
    res = await harness.runAutomodCase({
      communityId: cid,
      guildId: GUILD,
      caseId: caseRow.id,
      deps: w.deps({
        chat: scripted([{ tools: [{ name: "warn", args: { user_id: SUB, reason: "harassment" } }] }]),
        getBudget: () => {
          throw new Error("budget table missing");
        },
      }),
    });
  } finally {
    cap.restore();
  }
  assert.equal(res.ok, false);
  assert.equal(res.state, "refused");
  assert.match(res.error, /daily case budget \(database error\)/);
  assert.ok(cap.lines.some((l) => l.includes("budget read") && l.includes("budget table missing")));
});
