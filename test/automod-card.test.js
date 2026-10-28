/**
 * #730 (epic #723): automod CASE CARD — the render/rebuild layer.
 *
 * Pinned contract surface (issue #730):
 *  - the card renders from LEDGER ROWS alone: per-subject sections
 *    (`**Subject:** <@id> · **Staff note:** N-n`), one line per row, the
 *    suggested state shows **pending approval** (no_action shows
 *    **recorded decision**), and the outcome roll-up never claims total
 *    success when something refused/failed (AGENTS rule 5);
 *  - Approve/Dismiss buttons ride still-suggested row ids, clamped to
 *    AUTOMOD_CARD_MAX_BUTTON_ROWS rows with an honest overflow line;
 *    no_action never gets buttons;
 *  - the "**Seen, not considered:**" bystander line carries no note refs,
 *    replays from the persisted `_card_participants` meta entry, and never
 *    lists a considered subject;
 *  - rebuilds reflect CURRENT row states (an old card after a restart
 *    shows what the ledger says, buttons only for rows still suggested);
 *  - `recordCardPostError` leaves the structured `_card_post_error` record
 *    (the card was never claimed posted), and the #731 note-outcome UPDATE
 *    owns the 2000-char cap honestly (same note row, one outcome section).
 *
 * Real SQLite; no Discord needed at this layer (the button arms live in
 * automod-card-buttons.test.js, the harness integration in
 * automod-harness.test.js).
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();
after(cleanup);

const card = require("../src/features/automod/card");
const settingsService = require("../src/features/automod/settings");
const {
  CARD_APPROVE_PREFIX,
  CARD_DISMISS_PREFIX,
  AUTOMOD_CARD_MAX_BUTTON_ROWS,
  AUTOMOD_CARD_MAX_BUTTON_ROWS_QUEUED,
  AUTOMOD_CARD_NOT_CONSIDERED_MAX,
  AUTOMOD_NOTE_OUTCOME_HEADER,
  AUTOMOD_NOTE_TRUNCATION_MARKER,
} = require("../src/features/automod/constants");

const GUILD = "962000000000000001";
const AMOD_CH = "962000000000000002";
const MSG = "962000000000000003";
const REF = "862000000000000011";
const SUB = "862000000000000012";
const SUB2 = "862000000000000013";
const BOT = "762000000000000014";
const HUMAN = "862000000000000015";

let seq = 0;

/** Fresh community + recorded case (real repositories). */
function seededCase(label) {
  const cid = communityKey(`${GUILD}-730-${label}-${(seq += 1)}`);
  settingsService.setEnabled(cid, true);
  settingsService.setChannel(cid, AMOD_CH);
  settingsService.setRules(cid, "No harassment. No slurs. Be decent.");
  const created = db.createAutomodCase({
    communityId: cid,
    referrerUserId: REF,
    messageId: MSG,
    channelId: AMOD_CH,
    targetUserId: SUB,
    note: "card fixture referral",
  });
  assert.equal(created.ok, true, created.error);
  // A card only exists AFTER a run — seed the honest lifecycle state so
  // rebuild summaries take the 'review complete' branch (card.js maps
  // recorded/processing to 'run has not finished'; the failed arm is
  // covered by its own test below).
  db.db.prepare(`UPDATE automod_cases SET status='complete' WHERE id=?`).run(created.case.id);
  return { cid, caseRow: db.getAutomodCaseById(created.case.id) };
}

/** Record a suggestion row through the real repository. */
function suggest(cid, caseRow, action, subject = SUB, params = null) {
  const ins = db.insertAutomodActionSuggestion({
    communityId: cid,
    caseId: caseRow.id,
    guildId: GUILD,
    subjectUserId: subject,
    action,
    mode: "suggest",
    params,
  });
  assert.equal(ins.ok, true, ins.error || "insert refused");
  return ins.row;
}

/** Drive a row to a terminal state through the real state machine. */
function toExecuted(row, resultText) {
  const claim = db.claimAutomodSuggestion(row.id, "staff:test");
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const fin = db.recordAutomodActionResult(row.id, { state: "executed", resultText });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  return fin.row;
}

function toRefused(row, errorText, state = "refused") {
  const claim = db.claimAutomodSuggestion(row.id, "staff:test");
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const fin = db.recordAutomodActionResult(row.id, { state, errorText });
  assert.equal(fin.ok, true, JSON.stringify(fin));
  return fin.row;
}

const embed = (payload) => payload.embeds[0];
const decisionField = (payload) => payload.embeds[0].fields[0].value;
const buttonIds = (payload) =>
  (payload.components ?? []).flatMap((r) => (r.components ?? []).map((b) => b.custom_id));

// ── 1. the payload shape ─────────────────────────────────────────────────────

test("card payload: sections, note refs, pending approval word, footer, meta family - issue #730", () => {
  const { cid, caseRow } = seededCase("shape");
  const warn = db.getAutomodAction(suggest(cid, caseRow, "warn", SUB, { reason: "harassment" }).id);
  const judged = db.getAutomodAction(
    suggest(cid, caseRow, "no_action", SUB2, { reason: "already handled" }).id,
  );

  const payload = card.buildCardPayload({
    caseRow,
    rows: [warn, judged],
    meta: { model: "test-model", durationMs: 1234, rounds: 2, toolNames: ["warn"] },
    summaryText: `**Referred by:** <@${REF}> — review complete.`,
    noteRefs: { [SUB]: 1, [SUB2]: null },
  });

  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.match(embed(payload).title, new RegExp(`^Automod — case A-${caseRow.case_number} — decision$`));
  // #771 §4: the summary rides first, then the queue lines (jump link +
  // problem + the effective window; the fixture row predates the modal, so
  // the legacy 40/10 renders).
  assert.match(
    embed(payload).description,
    new RegExp(`^\\*\\*Referred by:\\*\\* <@${REF}> — review complete\\.\n`),
  );
  assert.match(
    embed(payload).description,
    new RegExp(`\\*\\*Reported message:\\*\\* \\[jump\\]\\(https://discord\\.com/channels/[^/]+/${AMOD_CH}/${MSG}\\)`),
  );
  assert.match(embed(payload).description, /\*\*Reported problem:\*\* card fixture referral/);
  assert.match(embed(payload).description, /\*\*Window:\*\* 40 before \/ 10 after/);
  assert.equal(embed(payload).fields[0].name, "Decision");
  assert.equal(embed(payload).footer.text, "Model test-model · 1234 ms · 2 round(s) · tools: warn");
  assert.equal(embed(payload).color, card.COLORS.complete);

  const field = decisionField(payload);
  assert.match(field, new RegExp(`\\*\\*Subject:\\*\\* <@${SUB}> · \\*\\*Staff note:\\*\\* N-1`));
  assert.match(field, new RegExp(`\\*\\*Subject:\\*\\* <@${SUB2}> · \\*\\*Staff note:\\*\\* no note recorded for this case`));
  assert.match(field, /`warn` — \*\*pending approval\*\* — a staff decision is due/);
  assert.match(
    field,
    /`no_action` — \*\*recorded decision\*\* — considered, no sanction warranted — already a recorded decision — "already handled"/,
  );

  // Buttons: warn row only — no_action NEVER gets buttons (recorded decision).
  // #771: the case-level queue row trails the row buttons (reveal + the
  // three mutually exclusive resolutions, carrying only the case id).
  assert.deepEqual(buttonIds(payload), [
    `${CARD_APPROVE_PREFIX}${warn.id}`,
    `${CARD_DISMISS_PREFIX}${warn.id}`,
    `am:case:reveal:${caseRow.id}`,
    `am:case:resolve:recommended:${caseRow.id}`,
    `am:case:resolve:manual:${caseRow.id}`,
    `am:case:resolve:none:${caseRow.id}`,
  ]);
});

test("a suggested warn row shows the member-visible record: proposed reason, evidence, and the expiry the warning will honour - issue #733", () => {
  const { cid, caseRow } = seededCase("warn-line");
  const anchorUrl = `https://discord.com/channels/${GUILD}/${AMOD_CH}/${MSG}`;

  // Row carrying its own proposal (what the #733 dispatcher records): the
  // explicit evidence link wins and the row's own expiry is shown as such.
  const proposed = db.getAutomodAction(suggest(cid, caseRow, "warn", SUB, {
    reason: "posted targeted harassment",
    evidenceMessageUrl: "https://discord.com/channels/1/2/3",
    expiresDays: 14,
  }).id);
  // Bare row: the case anchor is the evidence default; the CURRENT guild
  // setting (unset here → never) shows, labeled as the setting it is.
  const bare = db.getAutomodAction(suggest(cid, caseRow, "warn", SUB2, { reason: "second" }).id);

  let field = decisionField(card.buildCardPayload({ caseRow, rows: [proposed, bare], summaryText: "s" }));
  assert.match(
    field,
    /`warn` — \*\*pending approval\*\* — a staff decision is due — Approve records the formal warning and DMs the member per the server's warn settings\./,
  );
  assert.match(field, /Proposed reason: "posted targeted harassment"\./);
  assert.match(field, /Evidence: <https:\/\/discord\.com\/channels\/1\/2\/3>\./);
  assert.match(field, /Expiry: in 14 day\(s\) — as proposed on this row\./);
  assert.ok(field.includes(`Evidence: <${anchorUrl}>.`),
    "the suggested row falls back to the case anchor's jump link (#733 evidence default)");
  assert.match(field, /Expiry: never — current guild setting\./);

  // The SAME rows re-rendered after the staff change the setting show the
  // NEW expiry — the card never promises an older date than the record lands.
  db.updateGuildSettings(cid, { warn_expiry_days: 30 });
  field = decisionField(card.buildCardPayload({ caseRow, rows: [bare], summaryText: "s" }));
  assert.match(field, /Expiry: in 30 day\(s\) — current guild setting\./);

  // A case with no anchor message carries NO evidence — never a fabricated link.
  const orphan = { ...caseRow, channel_id: null, message_id: null };
  field = decisionField(card.buildCardPayload({ caseRow: orphan, rows: [bare], summaryText: "s" }));
  assert.match(field, /Evidence: none recorded\./);
});

test("a suggested delete row lists the targeted messages as jump links — Approve deletes, Dismiss leaves - issue #734", () => {
  const SUB3 = "862000000000000016";
  const { cid, caseRow } = seededCase("delete-links");

  // Canonical params (#734): two ids, TWO DIFFERENT channels — the links
  // resolve guild/channel/message straight from the recorded pairs.
  const targeted = db.getAutomodAction(suggest(cid, caseRow, "delete_message", SUB2, {
    reason: "targeted insult",
    messages: [
      { channelId: "963000000000000001", messageId: "963000000000000002" },
      { channelId: "963000000000000003", messageId: "963000000000000004" },
    ],
  }).id);
  const field = decisionField(card.buildCardPayload({ caseRow, rows: [targeted], summaryText: "s" }));
  assert.match(
    field,
    /`delete_message` — \*\*pending approval\*\* — Approve deletes 2 message\(s\) from this case — Dismiss leaves them untouched\./,
  );
  assert.ok(field.includes(`<https://discord.com/channels/${GUILD}/963000000000000001/963000000000000002>`));
  assert.ok(field.includes(`<https://discord.com/channels/${GUILD}/963000000000000003/963000000000000004>`));
  assert.match(field, new RegExp(`Author: <@${SUB2}>`), "the author context rides — one call, one user");
  assert.match(field, /Reason: "targeted insult"\./);

  // LEGACY single-pair rows (#728-era params) render the SAME links — the
  // card reads through the executor's fallback resolver.
  const legacy = db.getAutomodAction(suggest(cid, caseRow, "delete_message", SUB, {
    channelId: "963000000000000005",
    messageId: "963000000000000006",
  }).id);
  const legacyField = decisionField(card.buildCardPayload({ caseRow, rows: [legacy], summaryText: "s" }));
  assert.match(legacyField, /Approve deletes 1 message\(s\) from this case/);
  assert.ok(legacyField.includes(`<https://discord.com/channels/${GUILD}/963000000000000005/963000000000000006>`));

  // A row with NOTHING resolvable keeps the generic suggested line (the
  // card never renders an empty "Targeted:" and never invents links).
  const bare = db.getAutomodAction(suggest(cid, caseRow, "delete_message", SUB3).id);
  const bareField = decisionField(card.buildCardPayload({ caseRow, rows: [bare], summaryText: "s" }));
  assert.match(
    bareField,
    /`delete_message` — \*\*pending approval\*\* — a staff decision is due — Approve runs the shared executor, Dismiss declines\./,
  );

  // Executed/refused lines stay the existing verbatim-result machinery.
  const done = toExecuted(targeted, "Deleted 2 message(s) in this case.");
  const doneField = decisionField(card.buildCardPayload({ caseRow, rows: [done], summaryText: "s" }));
  assert.match(doneField, /`delete_message` — \*\*executed\*\* — Deleted 2 message\(s\) in this case\./);
});

test("suggested timeout shows the APPLIED duration and the clamp proof - issue #736", () => {
  const { cid, caseRow } = seededCase("timeout-clamp");
  db.updateGuildSettings(cid, { automod_timeout_cap: 120 });

  // Over the cap: the card projects the executor's clamp against the
  // CURRENT guild settings — the real value binds at Approve.
  const over = db.getAutomodAction(
    suggest(cid, caseRow, "timeout", SUB2, { durationSeconds: 99999, reason: "raid burst" }).id,
  );
  const field = decisionField(card.buildCardPayload({ caseRow, rows: [over], summaryText: "s" }));
  assert.match(
    field,
    /`timeout` — \*\*pending approval\*\* — a staff decision is due — Approve applies the clamped duration below; the real cap binds at Approve \(current guild settings\)\./,
  );
  assert.match(field, /Duration: 120s \(clamped from 99999s — floor 60s, cap 120s\)\./);
  assert.match(field, /Reason: "raid burst"\./);

  // Within the window: honest "unchanged", never a phantom clamp.
  const clean = db.getAutomodAction(
    suggest(cid, caseRow, "timeout", SUB, { durationSeconds: 60, reason: "slur" }).id,
  );
  const cleanField = decisionField(card.buildCardPayload({ caseRow, rows: [clean], summaryText: "s" }));
  assert.match(cleanField, /Duration: 60s \(unchanged — within the floor and cap\)\./);

  // A row with no duration falls back to the generic suggested line.
  const nobody = "862000000000000017";
  const bare = db.getAutomodAction(suggest(cid, caseRow, "timeout", nobody, {}).id);
  const bareField = decisionField(card.buildCardPayload({ caseRow, rows: [bare], summaryText: "s" }));
  assert.match(
    bareField,
    /`timeout` — \*\*pending approval\*\* — a staff decision is due — Approve runs the shared executor, Dismiss declines\./,
  );
});

test("suggested kick quotes the reason that will ride the Discord audit log - issue #737", () => {
  const { cid, caseRow } = seededCase("kick-suggested");
  const row = db.getAutomodAction(
    suggest(cid, caseRow, "kick", SUB2, { reason: "raid coordinator, second wave" }).id,
  );
  const field = decisionField(card.buildCardPayload({ caseRow, rows: [row], summaryText: "s" }));
  assert.match(
    field,
    /`kick` — \*\*pending approval\*\* — a staff decision is due — Approve removes the member from this server with the reason below on the audit log; Dismiss leaves them\./,
  );
  assert.match(field, /Reason: "raid coordinator, second wave"\./);

  // A legacy/direct row without a reason stays honest — never an empty quote.
  const bare = db.getAutomodAction(suggest(cid, caseRow, "kick", SUB, {}).id);
  const bareField = decisionField(card.buildCardPayload({ caseRow, rows: [bare], summaryText: "s" }));
  assert.match(bareField, /Reason: none recorded\./);
});

test("suggested ban quotes the audit reason and states the no-bulk-delete law - issue #738", () => {
  const { cid, caseRow } = seededCase("ban-suggested");
  const row = db.getAutomodAction(
    suggest(cid, caseRow, "ban", SUB2, { reason: "doxxing coordinator" }).id,
  );
  const field = decisionField(card.buildCardPayload({ caseRow, rows: [row], summaryText: "s" }));
  assert.match(
    field,
    /`ban` — \*\*pending approval\*\* — a staff decision is due — Approve bans the member from this server with the reason below on the audit log \(message history is untouched — deleting is the delete tool\); Dismiss leaves them\./,
  );
  assert.match(field, /Reason: "doxxing coordinator"\./);

  const bare = db.getAutomodAction(suggest(cid, caseRow, "ban", SUB, {}).id);
  const bareField = decisionField(card.buildCardPayload({ caseRow, rows: [bare], summaryText: "s" }));
  assert.match(bareField, /Reason: none recorded\./);
});

test("card buttons clamp honestly: 10 pending rows max, the overflow line names the rest - issue #730", () => {
  const { cid, caseRow } = seededCase("clamp");
  const acts = ["warn", "timeout", "kick", "ban", "delete_message", "ticket"];
  const rows = [];
  for (const subject of [SUB, SUB2]) {
    for (const action of acts) {
      rows.push(db.getAutomodAction(suggest(cid, caseRow, action, subject).id));
    }
  }
  assert.equal(rows.length, 12, "6 actions × 2 subjects — 2 MORE than the button clamp");

  const { components, overflow, pendingCount } = card.buildCardButtons(rows);
  assert.equal(pendingCount, 12);
  assert.equal(overflow, 12 - AUTOMOD_CARD_MAX_BUTTON_ROWS);
  // ≤ 25 buttons AND ≤ 25 components per message: four buttons per ActionRow,
  // five rows max — the clamp is the card constant (10 rows → 20 buttons).
  assert.equal(components.length, 5);
  const total = components.flatMap((r) => r.components).length;
  assert.equal(total, AUTOMOD_CARD_MAX_BUTTON_ROWS * 2);
  assert.ok(total <= 25 && components.length + total <= 25, "Discord's 25-component cap holds");

  // #771: once the card carries the QUEUE row, the row-button clamp drops to
  // AUTOMOD_CARD_MAX_BUTTON_ROWS_QUEUED (8) — 4 packed rows × 2 = 16 buttons
  // + 4 queue buttons = 20 across five ActionRows (Discord: ≤25, ≤5 rows).
  const payload = card.buildCardPayload({ caseRow, rows, summaryText: "s" });
  assert.match(
    decisionField(payload),
    /\*\*More pending rows:\*\* 4 pending row\(s\) have no buttons on this card — approve or dismiss the earlier ones and the rebuilt card carries them\./,
  );
  const ids = buttonIds(payload);
  assert.equal(
    ids.filter((id) => id.startsWith(CARD_APPROVE_PREFIX)).length,
    AUTOMOD_CARD_MAX_BUTTON_ROWS_QUEUED,
  );
  assert.deepEqual(ids.slice(-4), [
    `am:case:reveal:${caseRow.id}`,
    `am:case:resolve:recommended:${caseRow.id}`,
    `am:case:resolve:manual:${caseRow.id}`,
    `am:case:resolve:none:${caseRow.id}`,
  ]);
  const total2 = (payload.components ?? []).flatMap((r) => r.components ?? []).length;
  assert.ok(
    total2 <= 25 && (payload.components ?? []).length <= 5,
    "the QUEUED shape still fits Discord's caps: " +
      `${total2} buttons across ${(payload.components ?? []).length} rows`,
  );
});

// ── 2. partial-failure honesty (rule 5) ──────────────────────────────────────

test("partial auto failure: the roll-up names the split, never total success - issue #730", () => {
  const { cid, caseRow } = seededCase("partial");
  const ok = toExecuted(suggest(cid, caseRow, "warn", SUB), "Formal warning W-1 recorded.");
  const refused = toRefused(
    suggest(cid, caseRow, "kick", SUB2),
    "hierarchy guard: the bot cannot moderate this member",
  );
  const failed = toRefused(
    suggest(cid, caseRow, "delete_message", SUB2),
    "Discord said: Unknown Message",
    "failed",
  );

  const payload = card.buildCardPayload({ caseRow, rows: [ok, refused, failed], summaryText: "x" });
  const field = decisionField(payload);
  assert.match(
    field,
    /\*\*Outcome:\*\* 1 of 3 recorded actions ran — 1 refused, 1 failed, 0 pending approval, 0 dismissed\. Every line below names its own cause\./,
  );
  assert.match(field, new RegExp(`\`kick\` — \\*\\*refused\\*\\* — hierarchy guard: the bot cannot moderate this member`));
  assert.match(field, /`delete_message` — \*\*failed\*\* — Discord said: Unknown Message/);

  // All-clean run: NO roll-up line (no failure to report).
  const clean = card.buildCardPayload({ caseRow, rows: [ok], summaryText: "x" });
  assert.doesNotMatch(decisionField(clean), /\*\*Outcome:\*\*/);
});

// ── 3. the participants roundtrip ────────────────────────────────────────────

test("seen-not-considered: persisted meta entry replays, considered subjects are subtracted, cap holds - issue #730", () => {
  const { cid, caseRow } = seededCase("seen");
  const bystanders = Array.from({ length: 30 }, (_, i) => `8700000000000000${String(i).padStart(2, "0")}`);

  const entry = card.participantsLogEntry([SUB, ...bystanders]);
  assert.equal(entry.seq, 0);
  assert.equal(entry.state, "meta");
  assert.equal(entry.tool, card.CARD_PARTICIPANTS_TOOL);

  const withLog = { ...caseRow, decision_log: JSON.stringify([entry]) };
  assert.equal(card.readNotConsidered(withLog).length, bystanders.length + 1);

  // Render: the subject WITH a row never appears on the bystander line, and
  // the visible list clamps at 25 with an honest "+N more".
  const row = suggest(cid, caseRow, "warn", SUB);
  const payload = card.buildCardPayload({
    caseRow: withLog,
    rows: [db.getAutomodAction(row.id)],
    notConsidered: card.readNotConsidered(withLog).filter((id) => id !== String(SUB)),
    summaryText: "s",
  });
  const desc = embed(payload).description;
  assert.match(desc, /\*\*Seen, not considered:\*\* <@8700000000000000/);
  assert.ok(!desc.includes(`<@${SUB}>`), "a considered subject is never a bystander");
  assert.ok(desc.includes(`… +${bystanders.length - AUTOMOD_CARD_NOT_CONSIDERED_MAX} more`));

  // The rebuild path subtracts ledger subjects from the replayed entry too —
  // an OLD card rebuilt after SUB was considered must not list SUB.
  db.db
    .prepare(`UPDATE automod_cases SET decision_log=? WHERE id=?`)
    .run(JSON.stringify([entry]), caseRow.id);
  const rebuilt = card.buildCardFromCase({
    communityId: cid,
    caseId: db.getAutomodCaseById(caseRow.id).id,
    deps: { getCase: () => db.getAutomodCaseById(caseRow.id) },
  });
  assert.equal(rebuilt.ok, true, rebuilt.error);
  const rdesc = embed(rebuilt.payload).description;
  assert.match(rdesc, /\*\*Seen, not considered:\*\*/);
  assert.ok(!rdesc.includes(`<@${SUB}>`), "ledger subjects are subtracted at rebuild as well");
});

// ── 4. rebuild from the ledger (old card after restart) ──────────────────────

test("buildCardFromCase: current states, buttons only for rows still suggested, rebuild summary - issue #730", () => {
  const { cid, caseRow } = seededCase("rebuild");
  const ran = toExecuted(suggest(cid, caseRow, "warn", SUB), "Formal warning W-1 recorded.");
  const pending = suggest(cid, caseRow, "timeout", SUB2, { durationSeconds: 60 });

  const built = card.buildCardFromCase({ communityId: cid, caseId: caseRow.id, botUserId: BOT });
  assert.equal(built.ok, true, built.error);
  assert.match(embed(built.payload).title, /— decision$/);
  // #771 §3: an unrevealed rebuild leads with the anonymity line — the
  // state family behind the dash is unchanged.
  assert.match(
    embed(built.payload).description,
    /^\*\*Reporter:\*\* hidden — review complete\./,
    "rebuilds keep the state family — under reporter anonymity",
  );
  const field = decisionField(built.payload);
  assert.match(field, new RegExp(`\`warn\` — \\*\\*executed\\*\\* — Formal warning W-1 recorded\\.`));
  assert.match(field, /`timeout` — \*\*pending approval\*\*/);
  // The executed row's buttons are GONE; only the still-suggested row rides,
  // with the #771 queue row behind it (reveal enabled — the case is neither
  // revealed nor resolved).
  assert.deepEqual(buttonIds(built.payload), [
    `${CARD_APPROVE_PREFIX}${pending.id}`,
    `${CARD_DISMISS_PREFIX}${pending.id}`,
    `am:case:reveal:${caseRow.id}`,
    `am:case:resolve:recommended:${caseRow.id}`,
    `am:case:resolve:manual:${caseRow.id}`,
    `am:case:resolve:none:${caseRow.id}`,
  ]);

  // #771 §3: a REVEALED case restores the shipped `**Referred by:**` line
  // byte-for-byte and renders the Reveal button disabled.
  db.db
    .prepare(`UPDATE automod_cases SET revealed_at=1700000000000, revealed_by_user_id='u-staff-x' WHERE id=?`)
    .run(caseRow.id);
  const revealed = card.buildCardFromCase({ communityId: cid, caseId: caseRow.id });
  assert.match(
    embed(revealed.payload).description,
    new RegExp(`^\\*\\*Referred by:\\*\\* <@${REF}> — review complete\\.`),
  );
  const revealedButtons = (revealed.payload.components ?? []).flatMap((r) => r.components ?? []);
  assert.equal(
    revealedButtons.find((b) => b.custom_id === `am:case:reveal:${caseRow.id}`).disabled,
    true,
    "a revealed card cannot reveal twice",
  );

  // Footer meta rides the persisted 070 columns; rounds show "?" (run-time data).
  db.db
    .prepare(`UPDATE automod_cases SET last_model='m-9', last_duration_ms=4242, last_tool_names='["warn"]' WHERE id=?`)
    .run(caseRow.id);
  const rebuilt = card.buildCardFromCase({ communityId: cid, caseId: caseRow.id });
  assert.equal(rebuilt.ok, true, rebuilt.error);
  assert.equal(
    embed(rebuilt.payload).footer.text,
    "Model m-9 · 4242 ms · ? round(s) · tools: warn",
  );

  // Failed case → red family + the run's specific cause in the summary.
  db.db
    .prepare(`UPDATE automod_cases SET status='failed', last_run_error='provider error: HTTP 500 boom' WHERE id=?`)
    .run(caseRow.id);
  const failed = card.buildCardFromCase({ communityId: cid, caseId: caseRow.id });
  assert.match(embed(failed.payload).title, /— run failed$/);
  assert.equal(embed(failed.payload).color, card.COLORS.failed);
  assert.match(embed(failed.payload).description, /automod run failed: provider error: HTTP 500 boom/);

  // Cross-community rebuild is refused, specifically.
  const other = card.buildCardFromCase({ communityId: cid + 99999, caseId: caseRow.id });
  assert.equal(other.ok, false);
  assert.match(other.error, /refusing to rebuild a card across communities/);
});

test("rebuild when the ledger cannot be re-read: the card says so, never fakes calm - issue #730", () => {
  const { caseRow } = seededCase("rowread");
  const built = card.buildCardFromCase({
    communityId: caseRow.community_id,
    caseId: caseRow.id,
    deps: {
      getCase: () => db.getAutomodCaseById(caseRow.id),
      listActions: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    },
  });
  assert.equal(built.ok, true);
  assert.match(
    decisionField(built.payload),
    /\*\*Action rows:\*\* the ledger could not be re-read \(SQLITE_BUSY: database is locked\) — every row still lives in the database\./,
  );
});

// ── 5. the post-failure structured record ────────────────────────────────────

test("recordCardPostError: one structured entry appended to the persisted decision_log, never claims a post - issue #730", () => {
  const { cid, caseRow } = seededCase("posterr");
  const entry = card.participantsLogEntry([SUB]);
  db.db
    .prepare(`UPDATE automod_cases SET decision_log=? WHERE id=?`)
    .run(JSON.stringify([entry]), caseRow.id);

  card.recordCardPostError(caseRow.id, "card post failed: 404 Unknown Channel");

  const log = JSON.parse(db.getAutomodCaseById(caseRow.id).decision_log);
  assert.equal(log.length, 2);
  assert.equal(log[0].tool, card.CARD_PARTICIPANTS_TOOL, "the existing entries survive");
  assert.equal(log[1].tool, card.CARD_POST_ERROR_TOOL);
  assert.equal(log[1].state, "failed");
  assert.match(log[1].result_or_error, /404 Unknown Channel/);

  // Garbage log → replaced with a fresh single-entry log (never throws).
  db.db.prepare(`UPDATE automod_cases SET decision_log='not json' WHERE id=?`).run(caseRow.id);
  card.recordCardPostError(caseRow.id, "second failure");
  const after2 = JSON.parse(db.getAutomodCaseById(caseRow.id).decision_log);
  assert.equal(after2.length, 1);
  assert.equal(after2[0].tool, card.CARD_POST_ERROR_TOOL);

  // Missing case / bad id → silent no-op (there is nowhere to record).
  card.recordCardPostError(999999, "nowhere");
  card.recordCardPostError(null, "nowhere");
});

// ── 6. staff-note refs + outcome append ──────────────────────────────────────

test("findCaseNoteRow: replays the harness suffix, skips foreign authors - issue #730", () => {
  const { cid, caseRow } = seededCase("note");
  const suffix = `(automod case A-${caseRow.case_number})`;
  db.createStaffNote({
    communityId: cid,
    userId: SUB,
    authorId: HUMAN, // a human note quoting the case ref — FOREIGN
    content: `human said this ${suffix}`,
  });
  const mine = db.createStaffNote({
    communityId: cid,
    userId: SUB,
    authorId: BOT,
    content: `judge weighed it ${suffix}`,
  });

  const found = card.findCaseNoteRow({
    communityId: cid,
    userId: SUB,
    caseNumber: caseRow.case_number,
    botUserId: BOT,
  });
  assert.equal(found.note_number, mine.note_number, "the bot-authored note wins");

  // Bot id unknown → the shipped fallback author still matches.
  const fallback = card.findCaseNoteRow({
    communityId: cid,
    userId: SUB2,
    caseNumber: caseRow.case_number,
    deps: {
      listNotes: () => [
        { note_number: 77, author_id: "automod", content: `bot fallback ${suffix}`, deleted_at: null },
        { note_number: 78, author_id: HUMAN, content: `foreign ${suffix}`, deleted_at: null },
      ],
    },
  });
  assert.equal(fallback.note_number, 77);

  // No match at all → null (the card warns; it never invents a ref).
  assert.equal(
    card.findCaseNoteRow({ communityId: cid, userId: SUB, caseNumber: 424242, botUserId: BOT }),
    null,
  );
});

test("updateNoteOutcome: UPDATES the same note row with one outcome section — merge, idempotence, cap truncation, erased note - issue #730/#731", () => {
  const { cid, caseRow } = seededCase("update");
  const suffix = `(automod case A-${caseRow.case_number})`;
  const note = db.createStaffNote({
    communityId: cid,
    userId: SUB,
    authorId: BOT,
    content: `weighed the referral ${suffix}`,
  });
  const originalId = note.id;

  const line = card.outcomeLineFor({
    verb: "approve",
    staffUserId: REF,
    state: "executed",
    detail: "Formal warning W-1 recorded.",
  });
  assert.equal(line, `Outcome: approved by <@${REF}> — executed: Formal warning W-1 recorded.`);

  const recorded = card.updateNoteOutcome({
    communityId: cid,
    noteNumber: note.note_number,
    outcomeLine: line,
    editedBy: REF,
  });
  assert.equal(recorded.ok, true, recorded.error);
  assert.equal(recorded.noteNumber, note.note_number, "the SAME note row — never a second one");
  const fresh = db.getStaffNote(cid, note.note_number);
  assert.equal(fresh.id, originalId, "same row id — the note is updated in place");
  assert.equal(fresh.edited_by, REF, "edited_by is the clicking staff id");
  assert.ok(Number.isInteger(fresh.edited_at), "edited_at is stamped");
  const escapedHeader = AUTOMOD_NOTE_OUTCOME_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(fresh.content, new RegExp(`\\n\\n${escapedHeader}\\n`),
    "one outcome section after the base body");
  assert.match(
    fresh.content,
    new RegExp(`weighed the referral \\(automod case A-${caseRow.case_number}\\)\\n\\n\\*\\*Outcome:\\*\\*\\nOutcome: approved by <@${REF}> — executed:`),
    "base body keeps the discovery suffix; the entry rides under the section header",
  );

  const dismissed = card.outcomeLineFor({ verb: "dismiss", staffUserId: REF });
  assert.equal(dismissed, `Outcome: dismissed by <@${REF}> — the suggested action was not run.`);

  // MERGE: a further decision adds ONE entry under the SINGLE header.
  const second = card.updateNoteOutcome({
    communityId: cid,
    noteNumber: note.note_number,
    outcomeLine: dismissed,
    editedBy: REF,
  });
  assert.equal(second.ok, true, second.error);
  const merged = db.getStaffNote(cid, note.note_number).content;
  assert.equal(merged.split(`\n\n${AUTOMOD_NOTE_OUTCOME_HEADER}\n`).length - 1, 1, "exactly ONE outcome section");
  assert.ok(merged.includes(line) && merged.includes(dismissed), "both decisions listed");

  // IDEMPOTENCE: the identical line re-fired never duplicates and never
  // re-stamps the edit (a re-click after the terminal state changes nothing).
  const before = db.getStaffNote(cid, note.note_number);
  const repeat = card.updateNoteOutcome({
    communityId: cid,
    noteNumber: note.note_number,
    outcomeLine: dismissed,
    editedBy: "999999999999999999",
  });
  assert.equal(repeat.ok, true, repeat.error);
  assert.equal(repeat.unchanged, true);
  const after = db.getStaffNote(cid, note.note_number);
  assert.equal(after.content, before.content, "content untouched by the repeat");
  assert.equal(after.edited_by, before.edited_by, "no phantom editor on a no-op");
  assert.equal(after.content.split("Outcome: dismissed by").length - 1, 1, "the outcome appears once");

  // Cap: a 2000-char body still RECEIVES the outcome — the base body
  // truncates with the explicit marker, the note is rewritten, never failed.
  const fat = db.createStaffNote({
    communityId: cid,
    userId: SUB,
    authorId: BOT,
    content: `x ${suffix}`,
  });
  db.db
    .prepare(`UPDATE staff_notes SET content=? WHERE community_id=? AND note_number=?`)
    .run("y".repeat(db.MAX_NOTE_CONTENT - suffix.length) + suffix, cid, fat.note_number);
  const squeezed = card.updateNoteOutcome({
    communityId: cid,
    noteNumber: fat.note_number,
    outcomeLine: "Outcome: approved by <@r> — executed: done.",
    editedBy: REF,
  });
  assert.equal(squeezed.ok, true, squeezed.error);
  const fatFresh = db.getStaffNote(cid, fat.note_number);
  assert.ok(fatFresh.content.length <= db.MAX_NOTE_CONTENT, "the 2000-char cap holds after the rewrite");
  assert.match(fatFresh.content, new RegExp(AUTOMOD_NOTE_TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "truncation is EXPLICIT, never silent");
  assert.ok(fatFresh.content.includes("Outcome: approved by <@r> — executed: done."), "the outcome stays whole");

  // Erased/vanished note → specific failure.
  const gone = card.updateNoteOutcome({
    communityId: cid,
    noteNumber: 424242,
    outcomeLine: "whatever",
    editedBy: REF,
    deps: { getNote: () => null },
  });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /gone or was erased/);
});

// ── 7. the exported feature surface ──────────────────────────────────────────

test("customId parsing: malformed ids are refused before any lookup - issue #730", () => {
  const malformed = card.parseCardButtonId("am:card:approve:", `${CARD_APPROVE_PREFIX}`);
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /invalid row id/);
  const wrongPrefix = card.parseCardButtonId("am:other:5", `${CARD_APPROVE_PREFIX}`);
  assert.equal(wrongPrefix.ok, false);
  assert.match(wrongPrefix.error, /malformed/);
  const ok = card.parseCardButtonId(`${CARD_APPROVE_PREFIX}42`, `${CARD_APPROVE_PREFIX}`);
  assert.deepEqual(ok, { ok: true, rowId: 42 });
});

test("the feature exports both button arms behind the am:card prefixes (router wiring) - issue #730", () => {
  const feature = require("../src/features/automod");
  assert.equal(feature.buttonHandlers[CARD_APPROVE_PREFIX], card.handleCardApprove);
  assert.equal(feature.buttonHandlers[CARD_DISMISS_PREFIX], card.handleCardDismiss);
  assert.equal(feature.card, card, "the card module rides the feature export (#731+ read surfaces)");
});

// ── 8. #735: the ticket row arms ─────────────────────────────────────────────

test("suggested ticket row quotes the MEMBER-VISIBLE opening staff are approving - issue #735", () => {
  const { cid, caseRow } = seededCase("ticket-sug");
  const reason = "let's talk about last night's messages and the rules around them";
  const row = db.getAutomodAction(suggest(cid, caseRow, "ticket", SUB, { reason }).id);
  const field = decisionField(card.buildCardPayload({ caseRow, rows: [row], summaryText: "s" }));
  assert.match(field, /a staff decision is due — Approve opens the case's help ticket WITH the subject in it/);
  assert.match(field, /the quoted opening below is the member-visible text the subject will read in the ticket channel\./);
  assert.match(field, new RegExp(`Proposed opening: "${reason}"\\.`),
    "the QUOTED text is exactly what the subject will read on approval");

  // A row with no recorded reason says so honestly — the card never invents
  // an opening for a ticket whose text vanished.
  const bareRow = db.getAutomodAction(
    suggest(cid, caseRow, "ticket", SUB2, { reason: "   " }).id,
  );
  const bareField = decisionField(card.buildCardPayload({ caseRow, rows: [bareRow], summaryText: "s" }));
  assert.match(bareField, /Proposed opening: none recorded\./);
});

test("executed / refused / dismissed ticket rows render their recorded outcome verbatim - issue #735", () => {
  const { cid, caseRow } = seededCase("ticket-out");
  const done = toExecuted(
    suggest(cid, caseRow, "ticket", SUB, { reason: "talk it through" }),
    `Opened ticket T-7 with <@${SUB}>: <#901000000000000099> (case A-${caseRow.case_number}).`,
  );
  const field = decisionField(card.buildCardPayload({ caseRow, rows: [done], summaryText: "s" }));
  assert.ok(
    field.includes(`Opened ticket T-7 with <@${SUB}>: <#901000000000000099>`),
    "the success line rides the card EXACTLY as the executor wrote it — no paraphrase layer",
  );

  const denied = toRefused(
    suggest(cid, caseRow, "ticket", SUB2, { reason: "talk it through" }),
    `Could not open the case ticket: <@${SUB2}> already opened a ticket inside the rate window.`,
  );
  const deniedField = decisionField(card.buildCardPayload({ caseRow, rows: [denied], summaryText: "s" }));
  assert.ok(deniedField.includes("already opened a ticket inside the rate window"),
    "the rate-limit cause rides verbatim — the card never re-writes causes");
});
