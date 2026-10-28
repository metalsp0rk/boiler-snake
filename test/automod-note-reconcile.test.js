/**
 * #731 (epic #723): AUTO-MOD STAFF NOTES FOR CONSIDERED USERS ONLY — the
 * commit-time reconciliation law, end to end against real SQLite with every
 * Discord/provider seam scripted (the harness world) plus the card arm for
 * the staff-role refusal (the recommendation stays recorded).
 *
 * Pinned contract surface (issue #731 + locked decisions 4/6):
 *  - WHO GETS A NOTE: every user the model selects with ANY action tool,
 *    no_action INCLUDED — whether the mode then suggests, executes, refuses,
 *    or waits for Approve. Exactly ONE note per subject per case; several
 *    actions against one user = ONE note whose body lists each action.
 *  - WHO DOES NOT: a context-window speaker the model did not consider; the
 *    REFERRER unless they are also a subject (filing alone is not
 *    consideration); a `read_staff_notes` / `read_warnings` lookup writes
 *    NOTHING (zero-write pin).
 *  - COMMIT-TIME RECONCILIATION (prompt text is not enough): a subject with
 *    action intent and NO note call gets ONE harness-filled note (marker
 *    present, built from the structured decision); a note call for a user
 *    with NO intent is DROPPED (zero staff_notes rows) and the case card
 *    carries the honest `**Staff note dropped:**` line; the decision log
 *    still records the queued call.
 *  - NOTE SHAPE: author = the bot, normal N-n ids, body within the 2000-char
 *    cap carrying case A-n, what was weighed (narrative or the marker), the
 *    action list with the commit states (auto mode's executed/refused at
 *    birth), and the evidence message link; the narrative truncates with the
 *    explicit marker rather than failing the case with no note.
 *  - OUTCOME: Approve/Dismiss UPDATE the same note row (card.js, pinned in
 *    automod-card-buttons.test.js) — a staff-role subject who is only
 *    recommended still gets the note and the executor still refuses.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(() => {
  require("../src/features/automod/refer").setRunCaseHook(null);
  cleanup();
});

const harness = require("../src/features/automod/harness");
const refer = require("../src/features/automod/refer");
const card = require("../src/features/automod/card");
const settingsService = require("../src/features/automod/settings");
const {
  CARD_APPROVE_PREFIX,
  AUTOMOD_NOTE_HARNESS_FILLED,
  AUTOMOD_NOTE_DROPPED_LABEL,
  AUTOMOD_NOTE_OUTCOME_HEADER,
  AUTOMOD_NOTE_ACTIONS_HEADER,
  AUTOMOD_NOTE_EVIDENCE_LABEL,
  AUTOMOD_NOTE_TRUNCATION_MARKER,
} = require("../src/features/automod/constants");

const GUILD = "953000000000000001";
const SRC_CH = "953000000000000002";
const AMOD_CH = "953000000000000003";
const MSG = "953000000000000004";
const REF = "853000000000000011";
const SUB = "853000000000000012";
const BYS = "853000000000000013";
const BOT = "753000000000000014";
const STAFF_ROLE = "653000000000000015";
const KNOWN = new Set([REF, SUB, BYS, BOT]);

const AI = () => ({
  apiKey: "sk-fake-731-not-a-secret",
  baseUrl: "https://ai.invalid.invalid/v1",
  model: "test-model",
});

let seq = 0;

// ── Discord fakes (same shapes as test/automod-harness.test.js) ──────────────

function member(id, roleIds = []) {
  return {
    id,
    roles: {
      cache: new Map(roleIds.map((r) => [r, {}])),
      highest: { position: id === BOT ? 10 : 1 },
    },
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
    return [];
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
        id: "953000000000000005",
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

/** Configure through the shipped settings service and refer a real case. */
async function seededCommunity(label, { referOpts = {}, settings: cfg = {} } = {}) {
  const cid = communityKey(`${GUILD}-731-${label}-${(seq += 1)}`);
  settingsService.setEnabled(cid, true);
  settingsService.setChannel(cid, AMOD_CH);
  settingsService.setRules(cid, "No harassment. No slurs. Be decent.");
  for (const [action, mode] of Object.entries(cfg.modes ?? {})) {
    const set = settingsService.setMode(cid, action, mode);
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

/** Scripted provider loop (same harness-test idiom): tool calls run through
 *  the REAL dispatcher; `out` captures the tool results. */
function scripted(rounds = [], final = null) {
  const seen = [];
  const chat = async (cfg, opts) => {
    seen.push({ cfg, opts });
    let toolCalls = 0;
    for (const round of rounds) {
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

const actionRows = (cid, caseId) => db.listAutomodActionsForCase(cid, caseId);
const decisionField = (payload) => payload.embeds[0].fields[0].value;
const rowCount = (sql, params = []) => Number(db.db.prepare(sql).get(...params).n);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Run one case with scripted rounds; returns { res, notes... } conveniences. */
async function runCase({ cid, caseRow, w, tools, over = {} }) {
  const chat = scripted([tools ? { tools } : {}]);
  const res = await harness.runAutomodCase({
    communityId: cid,
    guildId: GUILD,
    caseId: caseRow.id,
    deps: w.deps({ chat, ...over }),
  });
  return { res, chat };
}

// ── 1. WHO GETS A NOTE — consideration via ANY action, no_action included ────

test("no_action is consideration: narrative note written once with the actions list and the evidence link - issue #731", async () => {
  const { cid, caseRow, w } = await seededCommunity("no-action-note");
  const { res } = await runCase({
    cid,
    caseRow,
    w,
    tools: [
      { name: "no_action", args: { user_id: SUB, rationale: "single remark, no pattern" } },
      { name: "write_staff_note", args: { user_id: SUB, content: "weighed the window; came close but the rules do not reach them" } },
    ],
  });
  assert.equal(res.state, "complete", res.error);

  const notes = db.listStaffNotes(cid, SUB);
  assert.equal(notes.length, 1, "considered-via-no_action → exactly one note");
  const body = notes[0].content;
  assert.equal(notes[0].author_id, BOT, "author = the bot");
  assert.match(body, /weighed the window; came close/);
  assert.doesNotMatch(body, /harness-filled/, "the model's narrative rides — no marker");
  assert.match(
    body,
    new RegExp(`${esc(AUTOMOD_NOTE_ACTIONS_HEADER)}\\n {2}- \`no_action\` — recorded decision — reason: "single remark, no pattern"`),
  );
  assert.match(body, new RegExp(`${esc(AUTOMOD_NOTE_EVIDENCE_LABEL)} <https://discord\\.com/channels/${GUILD}/${SRC_CH}/${MSG}>`));
  assert.match(body, new RegExp(`\\(automod case A-${caseRow.case_number}\\)$`), "discovery suffix pinned at the end");
});

test("two actions against one user produce ONE note whose body lists each action - issue #731", async () => {
  const { cid, caseRow, w } = await seededCommunity("two-actions");
  const { res } = await runCase({
    cid,
    caseRow,
    w,
    tools: [
      { name: "warn", args: { user_id: SUB, reason: "targeted harassment" } },
      { name: "delete_message", args: { user_id: SUB, reason: "the insult itself" } },
      { name: "write_staff_note", args: { user_id: SUB, content: "text and message both crossed the line" } },
    ],
  });
  assert.equal(res.state, "complete", res.error);
  assert.equal(actionRows(cid, caseRow.id).length, 2, "two ledger rows…");

  const notes = db.listStaffNotes(cid, SUB);
  assert.equal(notes.length, 1, "…but exactly ONE note (contract 3c)");
  assert.match(notes[0].content, /- `warn` — pending approval/);
  assert.match(notes[0].content, /- `delete_message` — pending approval/);
});

test("note call BEFORE the action still reconciles — call order does not matter - issue #731", async () => {
  const { cid, caseRow, w } = await seededCommunity("order-independent");
  const round = {
    tools: [
      { name: "write_staff_note", args: { user_id: SUB, content: "narrative written first" } },
      { name: "warn", args: { user_id: SUB, reason: "harassment" } },
    ],
  };
  const { res } = await runCase({ cid, caseRow, w, tools: round.tools });
  assert.equal(res.state, "complete", res.error);
  const notes = db.listStaffNotes(cid, SUB);
  assert.equal(notes.length, 1);
  assert.match(notes[0].content, /narrative written first/);
  assert.doesNotMatch(notes[0].content, /harness-filled/);
});

// ── 2. WHO DOES NOT — bystanders, the referrer, lookups ──────────────────────

test("note called for a user with NO action intent → zero rows and an honest dropped-note card line - issue #731", async () => {
  const { cid, caseRow, w } = await seededCommunity("dropped");
  const round = {
    tools: [
      { name: "warn", args: { user_id: SUB, reason: "harassment" } },
      { name: "write_staff_note", args: { user_id: BYS, content: "this window author was never selected" } },
    ],
  };
  const { res } = await runCase({ cid, caseRow, w, tools: round.tools });
  assert.equal(res.state, "complete", res.error);

  assert.equal(db.listStaffNotes(cid, BYS).length, 0, "a dropped note writes ZERO staff_notes rows");
  assert.equal(db.listStaffNotes(cid, SUB).length, 1, "the subject still gets the note");

  const field = decisionField(w.edits[0]);
  assert.ok(
    field.includes(`${AUTOMOD_NOTE_DROPPED_LABEL} <@${BYS}>`) &&
      field.includes("the model recorded no action (not considered), so no staff note was written"),
    `the card carries the honest dropped line: ${field}`,
  );

  // The decision log stays honest about the queued (then dropped) call:
  const log = JSON.parse(db.getAutomodCaseById(caseRow.id).decision_log);
  const droppedEntry = log.find((e) => e.tool === "write_staff_note");
  assert.ok(droppedEntry, "the queued note call is in the persisted decision_log");
  assert.equal(droppedEntry.state, "queued");
});

test("the referrer is not a subject by filing: a note queued for them is dropped, zero rows - issue #731", async () => {
  const { cid, caseRow, w } = await seededCommunity("referrer");
  const { res } = await runCase({
    cid,
    caseRow,
    w,
    tools: [
      { name: "warn", args: { user_id: SUB, reason: "harassment" } },
      { name: "write_staff_note", args: { user_id: REF, content: "the referrer was frustrated too" } },
    ],
  });
  assert.equal(res.state, "complete", res.error);
  assert.equal(db.listStaffNotes(cid, REF).length, 0, "filing alone is not consideration");
  assert.ok(
    decisionField(w.edits[0]).includes(`${AUTOMOD_NOTE_DROPPED_LABEL} <@${REF}>`),
    "the drop of the referrer's note is on the card too",
  );
});

test("read_warnings / read_staff_notes are zero-write: no note, no row, no mutation - issue #731", async () => {
  const { cid, caseRow, w } = await seededCommunity("lookup-zero-write");
  const notesBefore = rowCount(`SELECT COUNT(*) AS n FROM staff_notes WHERE community_id=?`, [cid]);
  const { res } = await runCase({
    cid,
    caseRow,
    w,
    tools: [
      { name: "read_warnings", args: { user_id: BYS } },
      { name: "read_staff_notes", args: { user_id: BYS } },
    ],
  });
  assert.equal(res.state, "complete", res.error);
  assert.equal(actionRows(cid, caseRow.id).length, 0, "a lookup is not consideration — no action row");
  assert.equal(
    rowCount(`SELECT COUNT(*) AS n FROM staff_notes WHERE community_id=?`, [cid]),
    notesBefore,
    "lookups write NOTHING",
  );
});

// ── 3. harness-filled notes + the auto-mode outcome at birth ─────────────────

test("sanction with the note call OMITTED still produces one harness-filled note - issue #731", async () => {
  const { cid, caseRow, w } = await seededCommunity("harness-filled");
  const { res } = await runCase({
    cid,
    caseRow,
    w,
    tools: [{ name: "warn", args: { user_id: SUB, reason: "targeted harassment" } }],
  });
  assert.equal(res.state, "complete", res.error);

  const notes = db.listStaffNotes(cid, SUB);
  assert.equal(notes.length, 1, "prompt text is not enough — the harness enforces the note");
  assert.ok(notes[0].content.includes(AUTOMOD_NOTE_HARNESS_FILLED), "harness-filled marker present");
  assert.match(notes[0].content, /- `warn` — pending approval — reason: "targeted harassment"/);
  assert.match(
    res.commit.lines.join("\n"),
    /staff note → <@853000000000000012>: recorded \(N-\d+\) — harness-filled/,
    "the commit report names the harness-filled write",
  );
});

test("auto mode: the note is created ALREADY carrying the executed result (outcome at birth) - issue #731", async () => {
  const { cid, caseRow, w } = await seededCommunity("auto-birth", {
    settings: { modes: { timeout: "auto" } },
  });
  const { res } = await runCase({
    cid,
    caseRow,
    w,
    tools: [{ name: "timeout", args: { user_id: SUB, duration_seconds: 300, reason: "raid" } }],
  });
  assert.equal(res.state, "complete", res.error);
  const [row] = actionRows(cid, caseRow.id);
  assert.equal(row.state, "executed");

  const notes = db.listStaffNotes(cid, SUB);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].content.includes(AUTOMOD_NOTE_HARNESS_FILLED), "no narrative → marker");
  assert.match(notes[0].content, /- `timeout` — executed — Timed out <@853000000000000012> for 300s/);
});

test("a 2000-character narrative still yields the note: explicit truncation, never a failed case - issue #731", async () => {
  const { cid, caseRow, w } = await seededCommunity("cap");
  const long = "n".repeat(db.MAX_NOTE_CONTENT);
  const { res } = await runCase({
    cid,
    caseRow,
    w,
    tools: [
      { name: "warn", args: { user_id: SUB, reason: "harassment" } },
      { name: "write_staff_note", args: { user_id: SUB, content: long } },
    ],
  });
  assert.equal(res.state, "complete", res.error);

  const notes = db.listStaffNotes(cid, SUB);
  assert.equal(notes.length, 1, "the cap never costs the subject their note");
  const body = notes[0].content;
  assert.ok(body.length <= db.MAX_NOTE_CONTENT, "within the 2000-char cap");
  assert.ok(body.includes(AUTOMOD_NOTE_TRUNCATION_MARKER), "truncation is EXPLICIT");
  assert.match(body, /- `warn` — pending approval/);
  assert.match(body, new RegExp(`\\(automod case A-${caseRow.case_number}\\)$`));
});

// ── 4. staff-role subject: recommended ≠ executed, but the note ALWAYS lands ─

test("staff-role subject: the note records the recommendation; Approve REFUSES and updates that SAME note - issue #731 (decision 6)", async () => {
  // The card arm needs the guild to map to a real community (discordCommunityId).
  const cid = communityKey(GUILD);
  settingsService.setEnabled(cid, true);
  settingsService.setChannel(cid, AMOD_CH);
  settingsService.setRules(cid, "No harassment.");
  db.addStaffRole(cid, STAFF_ROLE, "senior", REF);

  const subj = `8540000000000000${String(++seq).padStart(2, "0")}`;
  const created = db.createAutomodCase({
    communityId: cid,
    referrerUserId: REF,
    messageId: MSG,
    channelId: SRC_CH,
    targetUserId: subj,
    note: "staff member escalated in general",
  });
  assert.equal(created.ok, true, created.error);
  const caseRow = created.case;

  // The harness note exists exactly as for anyone else (the recommendation is
  // the record — decision 6): written by a scripted harness run.
  const note = db.createStaffNote({
    communityId: cid,
    userId: subj,
    authorId: BOT,
    content: `recommended a warning for review (automod case A-${caseRow.case_number})`,
  });
  const ins = db.insertAutomodActionSuggestion({
    communityId: cid,
    caseId: caseRow.id,
    guildId: GUILD,
    subjectUserId: subj,
    action: "warn",
    mode: "suggest",
    params: { reason: "escalation" },
  });
  assert.equal(ins.ok, true, ins.error);
  const row = ins.row;

  // The clicking world: the subject DOES hold the staff role (the guard's
  // Discord half reads roles.cache through members.fetch).
  const cardMessage = { id: "953000000000000006", edits: [], async edit(p) { this.edits.push(p); return this; } };
  const automodChannel = {
    id: AMOD_CH,
    posts: [],
    async send(p) { this.posts.push(p); return { id: "x", edit: async () => {} }; },
  };
  const memberOf = (id) =>
    member(String(id), String(id) === String(subj) ? [STAFF_ROLE] : []);
  const guild = {
    id: GUILD,
    members: { me: member(BOT), fetch: async (id) => memberOf(id) },
    channels: { cache: new Map([[AMOD_CH, automodChannel]]) },
    bans: { create: async () => {} },
  };
  const client = {
    user: { id: BOT },
    guilds: { cache: { get: (id) => (String(id) === GUILD ? guild : null) } },
    channels: { fetch: async (id) => automodChannel },
  };
  const it = {
    isButton: () => true,
    customId: `${CARD_APPROVE_PREFIX}${row.id}`,
    guildId: GUILD,
    guild: { id: GUILD },
    user: { id: REF },
    client,
    message: cardMessage,
    memberPermissions: { has: () => true },
    member: { roles: { cache: new Map() } },
    replies: [],
    async reply(p) { this.replies.push(p); },
    async followUp(p) { this.replies.push(p); },
  };

  await card.handleCardApprove(it, { supervisor: { discord: client } });

  // No mutation: the staff-role guard refused the executor run…
  const final = db.getAutomodAction(row.id);
  assert.equal(final.state, "refused");
  assert.match(final.error_text, /they hold staff role/);
  assert.equal(db.countWarnings(cid, subj), 0, "the sanction executor never ran against staff");

  // …and the refusal lands on the SAME note row (recommendation record, no
  // second note, edited_by = the clicker):
  const notes = db.listStaffNotes(cid, subj);
  assert.equal(notes.length, 1, "the staff-role subject keeps its ONE note");
  assert.equal(notes[0].id, note.id, "the same row — updated, not re-created");
  assert.equal(notes[0].edited_by, REF);
  assert.ok(Number.isInteger(notes[0].edited_at));
  assert.ok(notes[0].content.includes(`\n\n${AUTOMOD_NOTE_OUTCOME_HEADER}\n`));
  assert.match(
    notes[0].content,
    new RegExp(`Outcome: approved by <@${REF}> — refused: Refusing to run \`warn\` against <@${subj}>`),
  );
});

// ── 5. the pure pieces (the note-shape law, pinned directly) ─────────────────

test("evidenceLink + assembler: link only with a full anchor; marker/truncation/cap invariants - issue #731", () => {
  assert.equal(
    harness.evidenceLink("1", { channel_id: "2", message_id: "3" }),
    "https://discord.com/channels/1/2/3",
  );
  assert.equal(harness.evidenceLink("1", { channel_id: "2", message_id: null }), null);
  assert.equal(harness.evidenceLink(null, { channel_id: "2", message_id: "3" }), null);

  const suffix = harness.automodNoteSuffix({ case_number: 9 });
  const full = harness.assembleAutomodNoteBody({
    narrative: "weighed everything",
    entryLines: [harness.noteActionEntry({ intent: { action: "warn", params: { reason: "x" } }, out: { ok: true, state: "recorded_suggestion" } })],
    evidenceUrl: "https://discord.com/channels/1/2/3",
    suffix,
  });
  assert.ok(full.startsWith("weighed everything"));
  assert.ok(full.endsWith(suffix), "discovery suffix pinned last for findCaseNoteRow");
  assert.ok(full.includes(AUTOMOD_NOTE_ACTIONS_HEADER));

  const squeezed = harness.assembleAutomodNoteBody({
    narrative: "z".repeat(4000),
    entryLines: [],
    evidenceUrl: null,
    suffix,
  });
  assert.ok(squeezed.length <= db.MAX_NOTE_CONTENT, "the cap ALWAYS holds");
  assert.ok(squeezed.includes(AUTOMOD_NOTE_TRUNCATION_MARKER), "truncation is explicit");

  const filled = harness.assembleAutomodNoteBody({ harnessFilled: true, suffix });
  assert.ok(filled.startsWith(AUTOMOD_NOTE_HARNESS_FILLED), "marker leads a harness-filled body");
});

test("reconcileCaseNotes (unit): one note per subject, intentless notes dropped, noteResults honest - issue #731", async () => {
  const written = [];
  const out = await harness.reconcileCaseNotes({
    communityId: 7,
    guildId: GUILD,
    caseRow: { id: 1, case_number: 77 },
    consideredUserIds: ["u1"],
    notedUserIds: ["u2", "u1"],
    noteIntents: [
      { userId: "u2", content: "no intent for this one" },
      { userId: "u1", content: "the subject's narrative" },
    ],
    actionIntents: [{ action: "warn", subjectUserId: "u1", params: { reason: "harassment" } }],
    actionResults: [
      { intent: { action: "warn", subjectUserId: "u1", params: { reason: "harassment" } }, out: { ok: true, state: "recorded_suggestion" } },
    ],
    deps: {
      createNote: (args) => {
        written.push(args);
        return { note_number: 5 };
      },
      botUserId: BOT,
    },
  });
  assert.equal(written.length, 1, "ONLY the considered subject gets a note");
  assert.equal(written[0].userId, "u1");
  assert.equal(written[0].authorId, BOT);
  assert.ok(written[0].content.includes("the subject's narrative"));
  assert.ok(written[0].content.includes("(automod case A-77)"));
  assert.equal(out.noteResults.filter((r) => r.dropped).length, 1, "u2 dropped");
  assert.ok(out.extraLines.some((l) => l.includes(AUTOMOD_NOTE_DROPPED_LABEL) && l.includes("<@u2>")));
  assert.ok(out.lines.some((l) => l.includes("staff note → <@u1>: recorded (N-5)")));
});
