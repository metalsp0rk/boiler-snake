/**
 * #730 (epic #723): automod case-card BUTTON ARMS — Approve/Dismiss on raw
 * button interactions against real SQLite + the REAL executor.
 *
 * Pinned contract surface (issue #730):
 *  - staff gate FIRST (any staff member may press; the denial is the shipped
 *    MSG_DENIED and nothing else happens);
 *  - approve pre-gates in contract order — master switch, mode (off is
 *    unrunnable), the #739 breaker pause for kick/ban/timeout naming the
 *    pause reason — each refusal is specific, mutates NOTHING, and leaves
 *    the row suggested;
 *  - the executor owns claims: a double click returns **already handled**
 *    with the existing outcome and NEVER re-runs the mutation;
 *  - a terminal click records the outcome on the subject's harness staff
 *    note — the SAME note row, updated (#731), never a second note; a
 *    missing note is a reported warning, not a dead end;
 *  - the card after every decision rebuilds from FRESH rows (edit in place,
 *    buttons drop off); a card that cannot post/edit follows the send-failure
 *    law: the ephemeral says so, the log names it, and the case row carries
 *    the `_card_post_error` record;
 *  - cross-community rows and unregistered guilds are refused before any
 *    read of Discord; the Fluxer/belt shape check answers NOT_ON_FLUXER.
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

const card = require("../src/features/automod/card");
const settingsService = require("../src/features/automod/settings");
const { MSG_DENIED } = require("../src/core/theme");
const {
  NOT_ON_FLUXER,
  CARD_APPROVE_PREFIX,
  CARD_DISMISS_PREFIX,
  AUTOMOD_NOTE_OUTCOME_HEADER,
} = require("../src/features/automod/constants");

// The guild maps to a REAL community: discordCommunityId(guildId) must
// resolve inside the arms (the harness tests' synthetic externals map to
// null, so this file registers the snowflake itself — one shared community;
// tests keep their own cases/subjects and always restore what they flip).
const GUILD = "972000000000000001";
const AMOD_CH = "972000000000000002";
const MSG = "972000000000000003";
const REF = "872000000000000011";
const STAFF = "872000000000000012";
const SUB = "872000000000000013";
const BOT = "772000000000000014";

const CID = communityKey(GUILD);
settingsService.setEnabled(CID, true);
settingsService.setChannel(CID, AMOD_CH);
settingsService.setRules(CID, "No harassment. No slurs. Be decent.");

// ── fakes ─────────────────────────────────────────────────────────────────────

function makeWorld() {
  const mutations = { timeouts: [], kicks: [], bans: [] };

  const memberOf = (id) => ({
    id,
    roles: { cache: new Map(), highest: { position: 1 } },
    timeout: async (ms, reason) => {
      mutations.timeouts.push({ id: String(id), ms, reason });
    },
    kick: async (reason) => {
      mutations.kicks.push({ id: String(id), reason });
    },
  });

  const cardMessage = {
    id: "972000000000000009",
    edits: [],
    throwOnEdit: false,
    async edit(payload) {
      if (this.throwOnEdit) throw new Error("Unknown Message 10008");
      this.edits.push(payload);
      return this;
    },
  };

  const automodChannel = {
    id: AMOD_CH,
    posts: [],
    failing: false,
    async send(payload) {
      if (this.failing) throw new Error("Missing Permissions");
      this.posts.push(payload);
      return { id: "972000000000000010", edit: async () => {} };
    },
  };

  const guild = {
    id: GUILD,
    members: {
      me: { roles: { cache: new Map(), highest: { position: 10 } } },
      fetch: async (id) => memberOf(String(id)),
    },
    bans: {
      create: async (userId, { reason } = {}) => {
        mutations.bans.push({ userId: String(userId), reason });
      },
    },
  };

  const client = {
    user: { id: BOT },
    guilds: { cache: { get: (id) => (String(id) === GUILD ? guild : null) } },
    channels: {
      fetch: async (id) => {
        if (String(id) === AMOD_CH) return automodChannel;
        throw new Error(`404: channel ${id} not found`);
      },
    },
  };

  return {
    client,
    mutations,
    cardMessage,
    automodChannel,
    ctx: { supervisor: { discord: client } },
  };
}

function buttonInteraction(w, { customId, staff = true, guildId = GUILD, buttonShape = true }) {
  return {
    isButton: () => buttonShape,
    customId,
    guildId,
    guild: { id: guildId },
    user: { id: STAFF },
    client: w.client,
    message: w.cardMessage,
    memberPermissions: { has: () => staff },
    member: { roles: { cache: new Map() } },
    deferred: false,
    replied: false,
    replies: [],
    async reply(payload) {
      this.replies.push(payload);
      this.replied = true;
    },
    async followUp(payload) {
      this.replies.push(payload);
    },
  };
}

let caseSeq = 0;

/** Unique subject per test: the shared community must not leak warning
 *  counts / note state between tests. */
function nextSubject() {
  caseSeq += 1;
  return `873000000000000000${caseSeq}`;
}

/** A recorded case (+ the subject's harness note) in the shared community. */
function seededCase(subject, { note = true } = {}) {
  const created = db.createAutomodCase({
    communityId: CID,
    referrerUserId: REF,
    messageId: MSG,
    channelId: AMOD_CH,
    targetUserId: subject,
    note: `arm fixture ${subject}`,
  });
  assert.equal(created.ok, true, created.error);
  const caseRow = created.case;
  if (note) {
    db.createStaffNote({
      communityId: CID,
      userId: subject,
      authorId: BOT,
      content: `weighed the referral (automod case A-${caseRow.case_number})`,
    });
  }
  return caseRow;
}

function suggestRow(caseRow, action = "warn", subject = SUB, params = { reason: "harassment" }) {
  const ins = db.insertAutomodActionSuggestion({
    communityId: CID,
    caseId: caseRow.id,
    guildId: GUILD,
    subjectUserId: subject,
    action,
    mode: "suggest",
    params,
  });
  assert.equal(ins.ok, true, ins.error);
  return ins.row;
}

const decisionField = (payload) => payload.embeds[0].fields[0].value;
const buttonIds = (payload) =>
  (payload.components ?? []).flatMap((r) => (r.components ?? []).map((b) => b.custom_id));

function captureConsole() {
  const orig = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  return { lines, restore: () => { console.error = orig; } };
}

// ── 1. Approve happy path (real executor, real warning, note UPDATED) ────────

test("Approve runs the shared executor: warning recorded, the SAME note updated, card rebuilt from fresh rows - issue #730/#731", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "warn", subj);
  const noteBefore = db.listStaffNotes(CID, subj)[0];
  assert.ok(noteBefore, "the fixture note exists");

  const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
  await card.handleCardApprove(it, w.ctx);

  const final = db.getAutomodAction(row.id);
  assert.equal(final.state, "executed");
  assert.match(final.result_text, /Formal warning W-\d+ recorded/);
  assert.equal(db.countWarnings(CID, subj), 1, "the real warning landed");

  // #731: the outcome UPDATES the same harness note row — never a second note.
  const notes = db.listStaffNotes(CID, subj);
  assert.equal(notes.length, 1, "one note — the update never inserts a second row");
  const note = notes[0];
  assert.equal(note.id, noteBefore.id, "the SAME row id was updated");
  assert.equal(note.edited_by, STAFF, "edited_by is the clicking staff id");
  assert.ok(Number.isInteger(note.edited_at), "edited_at is stamped");
  assert.ok(note.content.includes(`\n\n${AUTOMOD_NOTE_OUTCOME_HEADER}\n`), "one outcome section");
  assert.match(
    note.content,
    new RegExp(`\\nOutcome: approved by <@${STAFF}> — executed: Formal warning W-\\d+ recorded`),
  );

  // Card edit: fresh rows — executed line, buttons gone (nothing pending).
  assert.equal(w.cardMessage.edits.length, 1);
  const edited = w.cardMessage.edits[0];
  assert.match(decisionField(edited), /`warn` — \*\*executed\*\*/);
  assert.deepEqual(buttonIds(edited), [], "a decided row never keeps buttons");

  // Ephemeral: specific outcome, not a generic thank-you.
  assert.equal(it.replies.length, 1);
  assert.match(
    it.replies[0].content,
    new RegExp(`\\*\\*Case:\\*\\* A-${caseRow.case_number} · \`warn\` → \\*\\*executed\\*\\*`),
  );
});

test("double click: the second click says already handled and the mutation count stays 1 - issue #730", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "warn", subj);

  const first = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
  await card.handleCardApprove(first, w.ctx);
  assert.equal(db.getAutomodAction(row.id).state, "executed");

  // Second click on the SAME (stale) card: early path — the row is terminal,
  // show the existing outcome, refresh the card, run nothing again.
  const second = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
  await card.handleCardApprove(second, w.ctx);
  assert.match(second.replies[0].content, /\*\*already handled\*\*/);
  assert.match(second.replies[0].content, /state `executed`/);
  assert.equal(db.countWarnings(CID, subj), 1, "one warning — the claim did its job");
  assert.equal(w.cardMessage.edits.length, 2, "the stale card was refreshed, not left lying");

  // And the outcome was recorded on the note EXACTLY once (first click only):
  // the terminal-state re-click never duplicates the outcome section.
  const note = db.listStaffNotes(CID, subj)[0];
  const outcomeLines = note.content.split("\n").filter((l) => l.startsWith("Outcome:"));
  assert.equal(outcomeLines.length, 1);
  assert.equal(
    note.content.split(`\n\n${AUTOMOD_NOTE_OUTCOME_HEADER}\n`).length - 1,
    1,
    "exactly ONE outcome section after a double click",
  );
});

// ── 2. pre-gates: specific refusals, ZERO mutation ────────────────────────────

test("mode-now-off approval is refused with the exact cause and mutates nothing - issue #730", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "warn", subj);
  settingsService.setMode(CID, "warn", "off");
  try {
    const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
    await card.handleCardApprove(it, w.ctx);
    assert.match(it.replies[0].content, /\*\*Mode off:\*\* the `warn` action is now off/);
    assert.equal(db.getAutomodAction(row.id).state, "suggested", "the row stays re-approvable");
    assert.equal(db.countWarnings(CID, subj), 0);
    assert.equal(w.cardMessage.edits.length, 0, "a pre-gate refusal does not touch the card");
  } finally {
    settingsService.setMode(CID, "warn", "suggest");
  }
});

test("master-switch-off approval is refused, row untouched - issue #730", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "warn", subj);
  settingsService.setEnabled(CID, false);
  try {
    const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
    await card.handleCardApprove(it, w.ctx);
    assert.match(it.replies[0].content, /\*\*Automod off:\*\* the master switch is off/);
    assert.equal(db.getAutomodAction(row.id).state, "suggested");
  } finally {
    settingsService.setEnabled(CID, true);
  }
});

test("breaker-paused kick approval names the pause reason and kicks/bans nobody (#739 gate) - issue #730", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "kick", subj, { reason: "raid" });
  db.setAutomodPause(CID, { reason: "three bans inside twenty minutes" });
  try {
    const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
    await card.handleCardApprove(it, w.ctx);
    assert.match(it.replies[0].content, /\*\*Safety paused:\*\* the auto-moderation circuit breaker is tripped/);
    assert.match(it.replies[0].content, /`kick` approvals stay dark/);
    assert.match(it.replies[0].content, /\*\*Pause reason:\*\* three bans inside twenty minutes/);
    assert.equal(db.getAutomodAction(row.id).state, "suggested");
    assert.deepEqual(w.mutations.kicks, []);
    assert.deepEqual(w.mutations.bans, []);
  } finally {
    db.clearAutomodPause(CID);
  }
});

// ── 3. the gates that refuse everything ───────────────────────────────────────

test("non-staff click: shipped denial, zero side-effects - issue #730", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "warn", subj);
  const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}`, staff: false });
  await card.handleCardApprove(it, w.ctx);
  assert.equal(it.replies[0].content, MSG_DENIED);
  assert.equal(db.getAutomodAction(row.id).state, "suggested");
  assert.equal(w.cardMessage.edits.length, 0);
});

test("non-button shape answers NOT_ON_FLUXER (Fluxer has no component path) - issue #730", async () => {
  const w = makeWorld();
  const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}1`, buttonShape: false });
  await card.handleCardApprove(it, w.ctx);
  assert.equal(it.replies[0].content, NOT_ON_FLUXER);
});

test("cross-community row and unregistered guild are refused before anything reads Discord - issue #730", async () => {
  const w = makeWorld();
  const otherCid = communityKey("972000000000000099-730-other");
  const other = db.createAutomodCase({
    communityId: otherCid,
    referrerUserId: REF,
    messageId: MSG,
    channelId: AMOD_CH,
    targetUserId: SUB,
    note: "foreign case",
  });
  assert.equal(other.ok, true, other.error);
  const ins = db.insertAutomodActionSuggestion({
    communityId: otherCid,
    caseId: other.case.id,
    guildId: "972000000000000099",
    subjectUserId: SUB,
    action: "warn",
    mode: "suggest",
    params: { reason: "foreign" },
  });
  assert.equal(ins.ok, true, ins.error);

  const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${ins.row.id}` });
  await card.handleCardApprove(it, w.ctx);
  assert.match(it.replies[0].content, /\*\*Cross-community:\*\* auto-mod row #\d+ belongs to another community/);
  assert.equal(db.getAutomodAction(ins.row.id).state, "suggested");

  const stranger = buttonInteraction(w, {
    customId: `${CARD_APPROVE_PREFIX}${ins.row.id}`,
    guildId: "972000000000000077", // no community row at all
  });
  await card.handleCardApprove(stranger, w.ctx);
  assert.match(stranger.replies[0].content, /\*\*Server not registered:\*\*/);
});

test("no_action rows refuse both arms: already a recorded decision - issue #730", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "no_action", subj, { rationale: "de-escalated" });

  const a = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
  await card.handleCardApprove(a, w.ctx);
  assert.match(a.replies[0].content, /\*\*No action:\*\* this row records a judgment, not a pending sanction/);

  const d = buttonInteraction(w, { customId: `${CARD_DISMISS_PREFIX}${row.id}` });
  await card.handleCardDismiss(d, w.ctx);
  assert.match(d.replies[0].content, /\*\*No action:\*\*/);
  assert.equal(db.getAutomodAction(row.id).state, "suggested");
});

// ── 4. Dismiss ────────────────────────────────────────────────────────────────

test("Dismiss declines without running anything and records the dismissal on the note - issue #730/#731", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "timeout", subj, { durationSeconds: 300, reason: "spam" });

  const it = buttonInteraction(w, { customId: `${CARD_DISMISS_PREFIX}${row.id}` });
  await card.handleCardDismiss(it, w.ctx);

  const final = db.getAutomodAction(row.id);
  assert.equal(final.state, "dismissed");
  assert.match(final.result_text, new RegExp(`Dismissed by <@${STAFF}>`));
  assert.deepEqual(w.mutations.timeouts, [], "a dismissal runs nothing against Discord");

  const note = db.listStaffNotes(CID, subj)[0];
  assert.match(
    note.content,
    new RegExp(`\\nOutcome: dismissed by <@${STAFF}> — the suggested action was not run\\.`),
  );

  const edited = w.cardMessage.edits[0];
  assert.ok(edited, "the card was edited from fresh rows");
  assert.match(decisionField(edited), /`timeout` — \*\*dismissed\*\*/);
  assert.deepEqual(buttonIds(edited), []);
  assert.match(it.replies[0].content, /\*\*dismissed\*\*/);
});

test("approve without a staff note: the action still runs, the missing append is a reported warning - issue #730", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj, { note: false });
  const row = suggestRow(caseRow, "warn", subj);

  const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
  await card.handleCardApprove(it, w.ctx);

  assert.equal(db.getAutomodAction(row.id).state, "executed", "the sanction ran anyway");
  assert.match(
    it.replies[0].content,
    /\*\*Staff note:\*\* no automod note for this subject — the outcome could not be recorded \(the card was updated anyway\)\./,
  );
  assert.equal(w.cardMessage.edits.length, 1, "the card still updated");
});

// ── 5. the send-failure law ───────────────────────────────────────────────────

test("card that cannot post: never claimed posted — warned ephemeral, logged, structured record on the case - issue #730", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "warn", subj);
  w.cardMessage.throwOnEdit = true;
  w.automodChannel.failing = true; // the fresh-post fallback also dies

  const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
  const cap = captureConsole();
  try {
    await card.handleCardApprove(it, w.ctx);
  } finally {
    cap.restore();
  }

  // The sanction ran (executor owns that), but the card says it did not land.
  assert.equal(db.getAutomodAction(row.id).state, "executed");
  const reply = it.replies[0].content;
  assert.match(reply, /\*\*executed\*\*/, "the decision itself is still reported");
  assert.match(reply, /\*\*Card:\*\* the case card could not be updated/);

  assert.ok(
    cap.lines.some((l) => l.includes(`case A-${caseRow.case_number} card post failed`)),
    `expected the card-post-failure log line, saw: ${cap.lines.join(" | ")}`,
  );
  const log = JSON.parse(db.getAutomodCaseById(caseRow.id).decision_log);
  assert.ok(
    log.some((e) => e.tool === card.CARD_POST_ERROR_TOOL && e.state === "failed"),
    "the case row carries the structured post-failure record",
  );
});

test("approve on a row that vanished (old card): specific refusal, nothing claimed - issue #730", async () => {
  const w = makeWorld();
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "warn", subj);
  db.db.prepare(`DELETE FROM automod_case_actions WHERE id=?`).run(row.id);

  const it = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
  await card.handleCardApprove(it, w.ctx);
  assert.match(
    it.replies[0].content,
    /No auto-mod action row #\d+ — this card is from an older build or the row is gone\. Nothing was run\./,
  );
});
