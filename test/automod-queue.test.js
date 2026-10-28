/**
 * #771 (epic #723): the MODERATION QUEUE — case-level arms against real
 * SQLite with the card-buttons world's Discord fakes.
 *
 * Pinned contract surface (issue #771):
 *  - §3 reveal: first staff press wins (single-winner UPDATE), the audit
 *    trail (automod.reporter_revealed) + the card rebuild (Referred-by line
 *    restored, Reveal disabled); every later press says **Already revealed**
 *    and adds ZERO audit rows;
 *  - §5 resolution: the FIRST valid click on Reveal-recommended /
 *    Manual / None claims the case (`resolveAutomodCase` single-winner);
 *    the loser sees **already resolved** and runs NOTHING. `recommended`
 *    loops the pending set through the REAL executor with per-action
 *    report lines; `manual`/`none` supersede the pending rows with ZERO
 *    bot execution. The outcome lands on the decision_log
 *    (`_queue_resolution`), the audit trail (automod.case_resolve), and
 *    the subjects' SAME staff notes (#731 merge law);
 *  - a resolved case retires everything: queue buttons disabled on the
 *    rebuild, and the per-row Approve belt answers **Case resolved:**;
 *  - §1/§2 the pending referral store: one-shot tokens, TTL expiry, cap
 *    eviction; a submit for a dead token gets the honest **Modal expired:**
 *    refusal, mis-typed window fields name the EXACT field, over-cap
 *    windows clamp and SAY SO;
 *  - the repository belts: window clamp 0–500 at write, snippet truncation,
 *    context cap refusal, resolution vocabulary.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(() => {
  require("../src/features/automod/referModal").clearPendingReferrals();
  require("../src/features/automod/referModal").setPendingClock(null);
  cleanup();
});

const card = require("../src/features/automod/card");
const referModal = require("../src/features/automod/referModal");
const settingsService = require("../src/features/automod/settings");
const { MSG_DENIED } = require("../src/core/theme");
const {
  NOT_ON_FLUXER,
  CARD_APPROVE_PREFIX,
  AUTOMOD_REFER_PENDING_MAX,
  AUTOMOD_REFER_PENDING_TTL_MS,
} = require("../src/features/automod/constants");

// One REAL community for the arms (discordCommunityId must resolve), same
// posture as automod-card-buttons.test.js.
const GUILD = "982000000000000001";
const AMOD_CH = "982000000000000002";
const MSG = "982000000000000003";
const REF = "882000000000000011";
const STAFF = "882000000000000012";
const BOT = "782000000000000014";

const CID = communityKey(GUILD);
settingsService.setEnabled(CID, true);
settingsService.setChannel(CID, AMOD_CH);
settingsService.setRules(CID, "No harassment. No slurs. Be decent.");

// ── world + fakes (automod-card-buttons posture) ────────────────────────────

function makeWorld() {
  const mutations = { timeouts: [], kicks: [], bans: [], deletes: [], warns: 0 };

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
    id: "982000000000000009",
    edits: [],
    async edit(payload) {
      this.edits.push(payload);
      return this;
    },
  };

  const automodChannel = {
    id: AMOD_CH,
    posts: [],
    async send(payload) {
      this.posts.push(payload);
      return { id: "982000000000000010", edit: async () => {} };
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

  return { client, mutations, cardMessage, automodChannel, ctx: { supervisor: { discord: client } } };
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
function nextSubject() {
  caseSeq += 1;
  return `883000000000000000${caseSeq}`;
}

/** A recorded case (+ optional harness note) in the shared community. */
function seededCase(subject, { note = true, ...over } = {}) {
  const created = db.createAutomodCase({
    communityId: CID,
    referrerUserId: REF,
    messageId: MSG,
    channelId: AMOD_CH,
    targetUserId: subject,
    note: `queue fixture ${subject}`,
    ...over,
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

function suggestRow(caseRow, action = "warn", subject, params = { reason: "harassment" }) {
  const ins = db.insertAutomodActionSuggestion({
    communityId: CID,
    caseId: caseRow.id,
    guildId: GUILD,
    subjectUserId: subject ?? caseRow.target_user_id,
    action,
    mode: "suggest",
    params,
  });
  assert.equal(ins.ok, true, ins.error);
  return ins.row;
}

const embed = (payload) => payload.embeds[0];
const buttonIds = (payload) =>
  (payload.components ?? []).flatMap((r) => (r.components ?? []).map((b) => b.custom_id));
const content = (it) => String(it.replies[0]?.content ?? "");

// ── 1. repository belts (migration 071 columns) ─────────────────────────────

test("create belts: windows clamp 0–500, snippet truncates, context cap refuses", () => {
  const subj = nextSubject();
  const created = db.createAutomodCase({
    communityId: CID,
    referrerUserId: REF,
    messageId: MSG,
    channelId: AMOD_CH,
    targetUserId: subj,
    note: "problem",
    requiredContext: "what the reviewer needs",
    readBefore: 900, // above the 500 belt → clamped
    readAfter: -5, // below zero → clamped
    messageSnippet: "x".repeat(400), // above 300 → truncated
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.case.read_before, 500);
  assert.equal(created.case.read_after, 0);
  assert.equal(created.case.message_snippet.length, 300);
  assert.equal(created.case.required_context, "what the reviewer needs");

  const tooLong = db.createAutomodCase({
    communityId: CID,
    referrerUserId: REF,
    requiredContext: "y".repeat(1001),
  });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /Required context is 1001 characters — the cap is 1000/);
});

test("reveal is single-winner at the row level; resolve stores the vocabulary", () => {
  const subj = nextSubject();
  const caseRow = seededCase(subj, { note: false });

  const first = db.revealAutomodCaseReporter(caseRow.id, STAFF, { nowMs: 1700000000000 });
  assert.equal(first.ok, true);
  assert.equal(first.revealed, true);
  assert.equal(first.case.revealed_at, 1700000000000);

  const second = db.revealAutomodCaseReporter(caseRow.id, "u-other-staff");
  assert.equal(second.ok, true);
  assert.equal(second.revealed, false);
  assert.equal(second.alreadyRevealed, true);
  assert.equal(second.case.revealed_by_user_id, STAFF, "the FIRST reveal stands");

  const won = db.resolveAutomodCase(caseRow.id, "manual", STAFF, { nowMs: 1700000000500 });
  assert.equal(won.ok, true);
  assert.equal(won.won, true);

  const loser = db.resolveAutomodCase(caseRow.id, "none", "u-other-staff");
  assert.equal(loser.ok, true);
  assert.equal(loser.won, false);
  assert.equal(loser.existing.resolution, "manual");
  assert.equal(loser.existing.resolvedByUserId, STAFF);

  const garbage = db.resolveAutomodCase(caseRow.id, "vengeance", STAFF);
  assert.equal(garbage.ok, false);
  assert.match(garbage.error, /Unknown case resolution/);
});

// ── 2. Reveal reporter (#771 §3) ────────────────────────────────────────────

test("reveal: first press restores the Referred-by line, audits, disables the button", async () => {
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const w = makeWorld();

  const it = buttonInteraction(w, { customId: `am:case:reveal:${caseRow.id}` });
  await card.handleCaseReveal(it, w.ctx);

  assert.match(content(it), new RegExp(`\\*\\*Reporter revealed:\\*\\* <@${REF}> — case A-${caseRow.case_number}`));
  assert.match(content(it), /on the audit trail/);

  const row = db.getAutomodCaseById(caseRow.id);
  assert.ok(row.revealed_at != null, "the reveal is stamped");
  assert.equal(row.revealed_by_user_id, STAFF);

  const audits = db.listAdminAudit(CID, { limit: 50 }).filter((r) => r.action === "automod.reporter_revealed");
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(audits[0].details_json).reporter_user_id, REF);

  // Rebuilt card: the shipped lead is BACK and Reveal renders disabled.
  assert.equal(w.cardMessage.edits.length, 1);
  const edited = w.cardMessage.edits[0];
  assert.match(embed(edited).description, new RegExp(`^\\*\\*Referred by:\\*\\* <@${REF}>`));
  const revealBtn = (edited.components ?? [])
    .flatMap((r) => r.components ?? [])
    .find((b) => b.custom_id === `am:case:reveal:${caseRow.id}`);
  assert.equal(revealBtn.disabled, true);
});

test("reveal re-press: **Already revealed**, zero new audit rows", async () => {
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const w = makeWorld();

  await card.handleCaseReveal(buttonInteraction(w, { customId: `am:case:reveal:${caseRow.id}` }), w.ctx);
  const before = db.listAdminAudit(CID, { limit: 50 }).filter((r) => r.action === "automod.reporter_revealed").length;

  const it2 = buttonInteraction(w, { customId: `am:case:reveal:${caseRow.id}` });
  await card.handleCaseReveal(it2, w.ctx);
  assert.match(content(it2), /\*\*Already revealed:\*\* <@/);
  assert.match(content(it2), /no duplicate audit row/);
  const after = db.listAdminAudit(CID, { limit: 50 }).filter((r) => r.action === "automod.reporter_revealed").length;
  assert.equal(after, before, "the re-press audits NOTHING");
});

test("reveal gates: non-staff denial, malformed id, cross-community, Fluxer shape", async () => {
  const subj = nextSubject();
  const caseRow = seededCase(subj, { note: false });
  const w = makeWorld();

  const denied = buttonInteraction(w, { customId: `am:case:reveal:${caseRow.id}`, staff: false });
  await card.handleCaseReveal(denied, w.ctx);
  assert.equal(content(denied), MSG_DENIED);

  const malformed = buttonInteraction(w, { customId: "am:case:reveal:not-a-number" });
  await card.handleCaseReveal(malformed, w.ctx);
  assert.match(content(malformed), /invalid case id/);

  const foreign = buttonInteraction(w, { customId: `am:case:reveal:${caseRow.id}`, guildId: "999900000000000001" });
  await card.handleCaseReveal(foreign, w.ctx);
  assert.match(content(foreign), /no community row|No auto-mod case/);

  const fluxer = buttonInteraction(w, { customId: `am:case:reveal:${caseRow.id}`, buttonShape: false });
  await card.handleCaseReveal(fluxer, w.ctx);
  assert.equal(content(fluxer), NOT_ON_FLUXER);

  assert.equal(db.getAutomodCaseById(caseRow.id).revealed_at, null, "no gate ever revealed");
});

// ── 3. The three resolutions (#771 §5) ──────────────────────────────────────

test("manual: claims the case, supersedes pending rows, notes + decision_log + audit ride", async () => {
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "timeout", subj, { durationSeconds: 300 });
  const w = makeWorld();

  const it = buttonInteraction(w, { customId: `am:case:resolve:manual:${caseRow.id}` });
  await card.handleCaseResolveManual(it, w.ctx);

  assert.match(content(it), new RegExp(`\\*\\*Case:\\*\\* A-${caseRow.case_number} → \\*\\*resolved\\*\\* — \`manual\``));
  assert.match(content(it), /1 pending suggestion\(s\) marked superseded — no bot execution\./);
  assert.deepEqual(w.mutations.timeouts, [], "§5: manual executes NOTHING in the bot");

  const dismissed = db.getAutomodAction(row.id);
  assert.equal(dismissed.state, "dismissed");
  assert.match(dismissed.result_text, /Superseded — manual action taken by <@/);

  // The subject's SAME note carries the outcome (#731 merge law).
  const note = db
    .listStaffNotes(CID, subj)
    .find((n) => /automod case A-/.test(n.content) && n.author_id === BOT);
  assert.ok(note, "the case note exists");
  assert.match(note.content, new RegExp(`Outcome: case A-${caseRow.case_number} resolved as \`manual action taken\` by <@${STAFF}>`));

  // decision_log + audit.
  const rowAfter = db.getAutomodCaseById(caseRow.id);
  const log = JSON.parse(rowAfter.decision_log ?? "[]");
  const entry = log.find((e) => e.tool === "_queue_resolution");
  assert.ok(entry, `decision_log carries the resolution: ${JSON.stringify(log)}`);
  assert.match(entry.args_summary, new RegExp(`manual by staff:${STAFF}`));
  assert.ok(
    db.listAdminAudit(CID, { limit: 50 }).some((r) => r.action === "automod.case_resolve"),
    "automod.case_resolve audit row landed",
  );

  // Rebuilt card: resolved line + EVERY queue button disabled.
  const edited = w.cardMessage.edits.at(-1);
  assert.match(embed(edited).description, new RegExp(`\\*\\*Resolved:\\*\\* <@${STAFF}> — Manual action taken · `));
  const buttons = (edited.components ?? []).flatMap((r) => r.components ?? []);
  for (const b of buttons.filter((x) => x.custom_id.startsWith("am:case:"))) {
    assert.equal(b.disabled, true, `${b.custom_id} renders disabled once resolved`);
  }
});

test("resolution is single-winner: the loser sees **already resolved** and runs nothing", async () => {
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const pending = suggestRow(caseRow, "warn", subj);
  const w = makeWorld();

  const first = buttonInteraction(w, { customId: `am:case:resolve:none:${caseRow.id}` });
  await card.handleCaseResolveNone(first, w.ctx);
  assert.match(content(first), /\*\*resolved\*\* — `none`/);

  const second = buttonInteraction(w, { customId: `am:case:resolve:recommended:${caseRow.id}` });
  await card.handleCaseResolveRecommended(second, w.ctx);
  assert.match(content(second), /\*\*already resolved\*\*/);
  assert.match(content(second), /closed it as `No action taken`/);
  assert.match(content(second), /nothing was run/);

  // The warn row was SUPERSEDED by the none-claim — the loser found
  // nothing pending and could not have fired a warning.
  assert.equal(db.getAutomodAction(pending.id).state, "dismissed");
  const audits = db
    .listAdminAudit(CID, { limit: 50 })
    .filter((r) => r.action === "automod.case_resolve" && String(r.target_id) === String(caseRow.id));
  assert.equal(audits.length, 1, "exactly one case_resolve audit for the case");
});

test("recommended: the pending set runs through the REAL executor with per-action lines", async () => {
  const subj = nextSubject();
  const subj2 = nextSubject();
  const caseRow = seededCase(subj);
  const warnRow = suggestRow(caseRow, "warn", subj, { reason: "harassment" });
  const dismissible = suggestRow(caseRow, "warn", subj2, { reason: "second" });
  const w = makeWorld();

  const it = buttonInteraction(w, { customId: `am:case:resolve:recommended:${caseRow.id}` });
  await card.handleCaseResolveRecommended(it, w.ctx);

  const reply = content(it);
  assert.match(reply, /resolved\*\* — `recommended`/);
  assert.match(reply, new RegExp(`\`warn\` → \\*\\*executed\\*\\*`), `per-action report: ${reply}`);

  const ran = db.getAutomodAction(warnRow.id);
  assert.equal(ran.state, "executed", "the real executor ran the row");
  const other = db.getAutomodAction(dismissible.id);
  assert.equal(other.state, "executed", "BOTH pending rows ran");

  // The note outcome landed on the FIRST subject's same note.
  const note = db
    .listStaffNotes(CID, subj)
    .find((n) => /automod case A-/.test(n.content) && n.author_id === BOT);
  assert.match(note.content, /Outcome: approved by <@/);

  const rowAfter = db.getAutomodCaseById(caseRow.id);
  assert.ok(JSON.parse(rowAfter.decision_log ?? "[]").some((e) => e.tool === "_queue_resolution"));
});

test("recommended with the master switch off: resolved anyway, EVERY row reports its gate", async () => {
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "kick", subj, { reason: "harassment" });
  settingsService.setEnabled(CID, false);
  const w = makeWorld();
  try {
    const it = buttonInteraction(w, { customId: `am:case:resolve:recommended:${caseRow.id}` });
    await card.handleCaseResolveRecommended(it, w.ctx);

    const reply = content(it);
    assert.match(reply, /\*\*resolved\*\* — `recommended`/, "the staff decision IS recorded");
    assert.match(reply, /`kick` → \*\*Automod off:\*\*/, `the gate reports per row: ${reply}`);
    assert.equal(db.getAutomodAction(row.id).state, "suggested", "the refused row is untouched");
    assert.equal(w.mutations.kicks.length, 0);
  } finally {
    settingsService.setEnabled(CID, true);
  }
});

test("none on a quiet case: closed, zero execution, 'Nothing was pending.'", async () => {
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const w = makeWorld();

  const it = buttonInteraction(w, { customId: `am:case:resolve:none:${caseRow.id}` });
  await card.handleCaseResolveNone(it, w.ctx);
  assert.match(content(it), /Nothing was pending\./);
  assert.equal(db.getAutomodCaseById(caseRow.id).resolution, "none");

  const note = db
    .listStaffNotes(CID, subj)
    .find((n) => /automod case A-/.test(n.content) && n.author_id === BOT);
  assert.match(note.content, /closed without sanction/);
});

test("row Approve on a resolved case: the belt answers **Case resolved:**, nothing runs", async () => {
  const subj = nextSubject();
  const caseRow = seededCase(subj);
  const row = suggestRow(caseRow, "warn", subj);
  const w = makeWorld();

  // Resolve first (manual supersedes the row state machine — but the row
  // arm belt must answer on ANY pending row of a resolved case; drive a
  // fresh suggested row that the supersede loop never saw).
  const resolveIt = buttonInteraction(w, { customId: `am:case:resolve:none:${caseRow.id}` });
  await card.handleCaseResolveNone(resolveIt, w.ctx);
  assert.equal(db.getAutomodAction(row.id).state, "dismissed", "superseded by the none-claim");

  // An OLD card still carries the row buttons — the belt catches it: the
  // case is resolved even though this row somehow stayed suggested (drive
  // the state back like a race between claim arms).
  db.db.prepare(`UPDATE automod_case_actions SET state='suggested', claimed_at=NULL, claimed_by=NULL WHERE id=?`).run(row.id);
  const approve = buttonInteraction(w, { customId: `${CARD_APPROVE_PREFIX}${row.id}` });
  await card.handleCardApprove(approve, w.ctx);
  assert.match(content(approve), new RegExp(`\\*\\*Case resolved:\\*\\* A-${caseRow.case_number} was closed as`));
  assert.match(content(approve), /per-row Approve\/Dismiss are retired/);
  assert.equal(db.getAutomodAction(row.id).state, "suggested", "the retired row stays as-is — nothing ran");
});

// ── 4. the referral modal arm + pending store (#771 §1/§2) ──────────────────

function modalSubmit(customId, fields, { shape = true } = {}) {
  const replies = [];
  return {
    isModalSubmit: () => shape,
    customId,
    guildId: GUILD,
    guild: { id: GUILD },
    user: { id: STAFF },
    member: { id: STAFF, roles: { cache: new Map() } },
    memberPermissions: { has: () => true },
    fields: { getTextInputValue: (id) => fields[id] ?? "" },
    replies,
    async reply(payload) {
      replies.push(typeof payload === "string" ? { content: payload } : payload);
      return payload;
    },
  };
}

test("pending store: one-shot take, TTL expiry, cap eviction (oldest first)", () => {
  referModal.clearPendingReferrals();
  let t = 1_000_000;
  referModal.setPendingClock(() => t);
  try {
    const token = referModal.putPendingReferral({ communityId: CID, guildId: GUILD, referrerUserId: STAFF });
    assert.equal(referModal.takePendingReferral(token + "x"), null, "wrong token reads dead");
    assert.equal(referModal.takePendingReferral(token).referrerUserId, STAFF, "first take lives");
    assert.equal(referModal.takePendingReferral(token), null, "one-shot: the second take is dead");

    const ttlToken = referModal.putPendingReferral({ communityId: CID });
    t += AUTOMOD_REFER_PENDING_TTL_MS + 1;
    assert.equal(referModal.takePendingReferral(ttlToken), null, "an expired entry is dead on arrival");
    referModal.prunePendingReferrals();
    assert.equal(referModal.pendingReferralCount(), 0, "prune clears the expired store");

    const tokens = [];
    for (let i = 0; i < AUTOMOD_REFER_PENDING_MAX + 5; i++) {
      tokens.push(referModal.putPendingReferral({ communityId: CID, i }));
    }
    assert.equal(referModal.pendingReferralCount(), AUTOMOD_REFER_PENDING_MAX, "the cap holds");
    assert.equal(referModal.takePendingReferral(tokens[0]), null, "the OLDEST form was evicted");
    assert.ok(referModal.takePendingReferral(tokens.at(-1)), "the newest survives");
  } finally {
    referModal.setPendingClock(null);
    referModal.clearPendingReferrals();
  }
});

test("submit belts: shape refusal, expired token, missing problem, exact-field reject", async () => {
  const shape = modalSubmit("am:refer:abc", {}, { shape: false });
  await referModal.handleReferModal(shape, {});
  assert.equal(String(shape.replies[0]?.content ?? ""), NOT_ON_FLUXER);

  const expired = modalSubmit("am:refer:deadbeef", { problem: "x" });
  await referModal.handleReferModal(expired, {});
  assert.match(String(expired.replies[0]?.content ?? ""), /\*\*Modal expired:\*\*/);

  const token = referModal.putPendingReferral({ communityId: CID, guildId: GUILD, referrerUserId: STAFF });
  const noProblem = modalSubmit(`am:refer:${token}`, { problem: "   " });
  await referModal.handleReferModal(noProblem, {});
  assert.match(String(noProblem.replies[0]?.content ?? ""), /\*\*Problem:\*\* is required/);
  assert.equal(referModal.pendingReferralCount(), 0, "the consumed token never revives");

  const t2 = referModal.putPendingReferral({ communityId: CID, guildId: GUILD, referrerUserId: STAFF });
  const badWindow = modalSubmit(`am:refer:${t2}`, { problem: "slurs", read_after: "soon" });
  await referModal.handleReferModal(badWindow, {});
  assert.equal(
    String(badWindow.replies[0]?.content ?? ""),
    "`Messages after` wasn't a number — nothing was filed.",
  );
});

test("parseWindowField: default/reject/min-clamp/max-clamp/plain pass", () => {
  assert.deepEqual(referModal.parseWindowField("", "X"), { ok: true, value: null, clamped: null });
  assert.deepEqual(referModal.parseWindowField("250", "X"), { ok: true, value: 250, clamped: null });
  assert.equal(referModal.parseWindowField("4.5", "X").ok, false, "decimals are not integers");
  assert.deepEqual(referModal.parseWindowField("5000", "X"), { ok: true, value: 500, clamped: "max" });
  assert.deepEqual(referModal.parseWindowField("-3", "X"), { ok: true, value: 0, clamped: "min" });
});

// ── 5. card line derivations (#771 §2/§4) ───────────────────────────────────

test("queue tail lines: Window renders from the EFFECTIVE pair; Resolved stamps the label", () => {
  const lines = card.queueTailLinesFor({
    message_id: MSG,
    channel_id: AMOD_CH,
    community_id: CID,
    read_before: 250,
    read_after: 0,
  });
  assert.deepEqual(lines, ["**Window:** 250 before / 0 after"]);

  const resolved = card.queueTailLinesFor({
    resolved_at: 1700000000000,
    resolution: "recommended",
    resolved_by_user_id: STAFF,
  });
  assert.deepEqual(resolved, [
    `**Resolved:** <@${STAFF}> — Take recommended action · ${card.formatStamp(1700000000000)}`,
  ]);
  assert.equal(card.formatStamp(1700000000000), "2023-11-14 22:13 UTC");
});
