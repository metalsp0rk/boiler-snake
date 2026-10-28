/**
 * #727 (epic #723): case-context collector — the evidence bundle the #728
 * harness reads. Pure gathering, no sanctions.
 *
 * Pinned contract surface:
 *  - anchor window: exactly 40 before / 10 after (nearest-keep), oldest→
 *    newest, enforced by the COLLECTOR even when the producer over-delivers;
 *  - referrer-view parity (decision 46): an anchor channel the referrer
 *    cannot view → specific error; user-only scan NEVER fetches invisible
 *    channels and counts them (channels_skipped_not_visible); open tickets
 *    are blacked out of the scan;
 *  - user-only caps bound the work (channels scanned ≤ 15, collected ≤ 100,
 *    truncated disclosed, newest-first selection);
 *  - participants deduped INCLUDING the subject; records preloaded for the
 *    referred user ONLY (named target, else anchor author) — bystanders
 *    never;
 *  - specific errors: deleted anchor (10003), rules cleared since intake,
 *    referrer gone, gone channel, inconsistent row;
 *  - NO path ever writes warnings or staff_notes (row-count pins —
 *    createWarning/createStaffNote are not even imported by caseContext.js);
 *  - no throw escapes: a throwing dep → { ok:false } + `[automod]` log line
 *    with community/guild/case ids (AGENTS.md rule 2/6).
 *
 * Real SQLite via loadDb (house style), Discord only through deps fakes
 * (automod-refer.test.js posture).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(() => cleanup());

const { PermissionFlagsBits } = require("discord.js");
const caseContext = require("../src/features/automod/caseContext");
const settingsService = require("../src/features/automod/settings");
const {
  AUTOMOD_CONTEXT_USER_SCAN_MAX_CHANNELS,
  AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES,
} = require("../src/features/automod/constants");
const {
  READ_DISCORD_BEFORE_WINDOW,
  READ_DISCORD_AFTER_WINDOW,
  READ_DISCORD_MESSAGE_CHAR_CAP,
} = require("../src/features/gork/constants");

const GUILD = "930000000000000001";
const AMOD_CH = "700000000000000101";
const SRC_CH = "700000000000000102";
const REFERRER = "u-referrer-727";
const BOT = "u-bot-727";
const ANCHOR_AUTHOR = "u-anchor-author-727";
const TARGET = "u-target-727";
const BYSTANDER = "u-bystander-727";
const BASE_TS = 1764000000000;

// Fixed-width snowflake-shaped ids: lexicographic order == chronological.
const mid = (n) => "8" + String(n).padStart(18, "0");

let seq = 0;
const freshCommunity = () => communityKey(`${GUILD}-727-${++seq}`);

/** Configure a community through the SHIPPED service (rules/channel matter). */
function readyCommunity(rules = "No spam. No hate speech. Be kind.") {
  const communityId = freshCommunity();
  settingsService.setEnabled(communityId, true);
  settingsService.setChannel(communityId, AMOD_CH);
  if (rules) settingsService.setRules(communityId, rules);
  return communityId;
}

function makeCase(communityId, over = {}) {
  const created = db.createAutomodCase({
    communityId,
    referrerUserId: REFERRER,
    messageId: null,
    channelId: null,
    targetUserId: null,
    note: "seen this?",
    ...over,
  });
  assert.equal(created.ok, true, created.error);
  return created.case;
}

const rowCount = (table) =>
  Number(db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

/** Capture console.error for one call; returns { res, lines }. */
async function withCapturedLogs(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const res = await fn();
    return { res, lines };
  } finally {
    console.error = orig;
  }
}

// ── deps fakes ─────────────────────────────────────────────────────────────

function msgAt(n, authorId, content, attachments = []) {
  return {
    id: mid(n),
    author: { id: authorId },
    content: content ?? `msg ${n}`,
    createdTimestamp: BASE_TS + n * 1000,
    attachments,
  };
}

/**
 * Message channel fake. `deliver` controls honesty:
 *  - "dishonest": window fetches ignore limit/before/after and return
 *    EVERYTHING (proves the collector's own 40/10 recap);
 *  - "honest":   Discord-REST-ish selection (nearest `limit` around cursor);
 *  - "empty":    no messages at all.
 * Single-id fetch throws code 10003 for unknown ids (deleted posture).
 */
function fakeMessageChannel({
  id = SRC_CH,
  view = true,
  botView = true,
  messages = [],
  deliver = "dishonest",
} = {}) {
  const otherThanCursor = (list, opts) =>
    list.filter((m) => m.id !== String(opts.before ?? opts.after ?? ""));
  return {
    id,
    guildId: GUILD,
    isTextBased: () => true,
    permissionsFor: (member) => ({
      has: (flag) => {
        if (flag === PermissionFlagsBits.ViewChannel) {
          return member?.id === BOT ? botView === true : view === true;
        }
        if (flag === PermissionFlagsBits.ReadMessageHistory) return true;
        return false;
      },
    }),
    messages: {
      fetch: async (opts) => {
        if (typeof opts === "string") {
          const found = messages.find((m) => m.id === opts);
          if (!found) {
            const err = new Error("Unknown Message");
            err.code = 10003;
            throw err;
          }
          return found;
        }
        if (deliver === "empty") return [];
        if (deliver === "dishonest") {
          return otherThanCursor(messages, opts);
        }
        let list = otherThanCursor(messages, opts);
        if (opts.before) {
          list = list
            .filter((m) => m.id < String(opts.before))
            .sort((a, b) => (a.id < b.id ? 1 : -1))
            .slice(0, opts.limit);
        } else if (opts.after) {
          list = list
            .filter((m) => m.id > String(opts.after))
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .slice(0, opts.limit);
        } else {
          list = list.slice(0, opts.limit);
        }
        return list;
      },
    },
  };
}

/**
 * ContextDeps fake. `throwOn` names one seam to explode (no-throw fuzz);
 * `tickets` maps channelId → fake ticket row.
 */
function makeCtxDeps({
  channel = null,
  channels = [],
  referrerPresent = true,
  botPresent = true,
  throwOn = {},
  tickets = {},
} = {}) {
  const findChannel = (id) =>
    (channel && String(id) === channel.id ? channel : null) ??
    channels.find((c) => String(c.id) === String(id)) ??
    null;
  return {
    async getGuildChannel(_g, id) {
      if (throwOn.getGuildChannel) throw new Error("boom getGuildChannel");
      return findChannel(id);
    },
    async getMember(_g, userId) {
      if (throwOn.getMember) throw new Error("boom getMember");
      return referrerPresent && String(userId) === REFERRER
        ? { id: REFERRER }
        : null;
    },
    async getBotMember() {
      if (throwOn.getBotMember) throw new Error("boom getBotMember");
      return botPresent ? { id: BOT } : null;
    },
    async listTextChannels() {
      if (throwOn.listTextChannels) throw new Error("boom listTextChannels");
      return channels;
    },
    async fetchChannelMessages(ch, opts) {
      if (throwOn.fetch) throw new Error("boom fetch");
      return ch.messages.fetch(opts);
    },
    async getTicketByChannel(_cid, channelId) {
      if (throwOn.getTicketByChannel) throw new Error("boom ticket read");
      return tickets[String(channelId)] ?? null;
    },
  };
}

// ── anchor window ──────────────────────────────────────────────────────────

const ANCHOR_N = 500; // surround lives at 301..360 (before) and 601..620 (after)

function anchorSeed() {
  const before = [];
  for (let i = 1; i <= 60; i++) before.push(msgAt(300 + i, `u-bystander-${i % 4}`));
  const after = [];
  for (let i = 1; i <= 20; i++) after.push(msgAt(600 + i, `u-after-${i % 2}`));
  const anchor = msgAt(ANCHOR_N, ANCHOR_AUTHOR, "the offense", [
    { name: "evidence.png" },
  ]);
  return { before, after, anchor, all: [...before, anchor, ...after] };
}

describe("case context — message window (anchor)", () => {
  it("caps at 40 before / 10 after (nearest kept), oldest→newest, honest shape", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
    });
    const seed = anchorSeed();
    const channel = fakeMessageChannel({ messages: seed.all });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, true, res.error);
    const w = res.context.window;
    assert.equal(w.kind, "message_anchor");
    assert.equal(w.channel_id, SRC_CH);
    assert.equal(w.anchor_message_id, mid(ANCHOR_N));
    // The DISHONEST fake returned all 80 neighbors — the collector capped:
    assert.equal(
      w.messages.length,
      1 + READ_DISCORD_BEFORE_WINDOW + READ_DISCORD_AFTER_WINDOW,
    );
    const ids = w.messages.map((m) => m.id);
    assert.equal(ids[0], mid(321)); // nearest 40 before = 321..360
    assert.equal(ids[READ_DISCORD_BEFORE_WINDOW], mid(ANCHOR_N)); // anchor at index 40
    assert.equal(ids[ids.length - 1], mid(610)); // nearest 10 after = 601..610
    // strictly ascending (chronological)
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1] < ids[i]);
    const anchorMsg = w.messages[READ_DISCORD_BEFORE_WINDOW];
    assert.equal(anchorMsg.is_anchor, true);
    assert.equal(anchorMsg.author_id, ANCHOR_AUTHOR);
    assert.equal(anchorMsg.content, "the offense");
    assert.deepEqual(anchorMsg.attachments, ["evidence.png"]);
    assert.equal(
      anchorMsg.timestamp,
      new Date(BASE_TS + ANCHOR_N * 1000).toISOString(),
    );
    // referral block + message link
    assert.equal(res.context.referral.message_url,
      `https://discord.com/channels/${GUILD}/${SRC_CH}/${mid(ANCHOR_N)}`);
    assert.equal(res.context.referral.referrer_user_id, REFERRER);
    assert.equal(res.context.referral.note, "seen this?");
    assert.equal(w.channels_scanned, 1);
  });

  it("an honest producer lands within the same caps", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
    });
    const seed = anchorSeed();
    const channel = fakeMessageChannel({ messages: seed.all, deliver: "honest" });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(
      res.context.window.messages.length,
      1 + READ_DISCORD_BEFORE_WINDOW + READ_DISCORD_AFTER_WINDOW,
    );
  });

  it("long content is capped at gork's per-message cap with an honest flag", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
    });
    const anchor = msgAt(ANCHOR_N, ANCHOR_AUTHOR, "x".repeat(READ_DISCORD_MESSAGE_CHAR_CAP + 120));
    const channel = fakeMessageChannel({ messages: [anchor] });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, true, res.error);
    const m = res.context.window.messages[0];
    assert.equal(m.content.length, READ_DISCORD_MESSAGE_CHAR_CAP);
    assert.equal(m.content_truncated, true);
  });

  it("deleted anchor (10003) → specific error", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
    });
    const channel = fakeMessageChannel({ messages: [] }); // single fetch throws 10003
    const { res, lines } = await withCapturedLogs(() =>
      caseContext.buildCaseContext({
        communityId,
        guildId: GUILD,
        caseNumber: row.case_number,
        deps: makeCtxDeps({ channel }),
      }),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /\*\*Message gone:\*\*/);
    assert.match(res.error, /no longer exists/);
    assert.ok(lines.some((l) => l.includes("[automod]") && l.includes(String(communityId))));
  });

  it("anchor channel the REFERRER cannot view → specific error", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
    });
    const channel = fakeMessageChannel({ view: false, messages: anchorSeed().all });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /\*\*Channel not visible:\*\*/);
  });

  it("anchor channel gone → specific error", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
    });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel: null }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /\*\*Channel gone:\*\*/);
  });

  it("bot cannot view the anchor channel → specific error", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
    });
    const channel = fakeMessageChannel({ botView: false, messages: anchorSeed().all });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /\*\*Bot access:\*\*/);
  });
});

// ── user-only window ───────────────────────────────────────────────────────

function scanChannel(id, { view = true, msgs = [], deliver = "honest" } = {}) {
  return fakeMessageChannel({ id, view, messages: msgs, deliver });
}

describe("case context — user-only window (asker parity + caps)", () => {
  it("collects only the subject's messages from referrer-visible channels", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const chA = scanChannel("700000000000000201", {
      msgs: [msgAt(21, TARGET), msgAt(22, BYSTANDER)],
    });
    const chB = scanChannel("700000000000000202", {
      msgs: [msgAt(10, TARGET)],
    });
    const secret = scanChannel("700000000000000203", {
      view: false,
      msgs: [msgAt(99, TARGET)],
    });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channels: [chA, chB, secret] }),
    });
    assert.equal(res.ok, true, res.error);
    const w = res.context.window;
    assert.equal(w.kind, "user_recent");
    assert.deepEqual(
      w.messages.map((m) => m.id),
      [mid(10), mid(21)], // chronological across channels
    );
    assert.ok(w.messages.every((m) => m.author_id === TARGET));
    assert.equal(w.channels_skipped_not_visible, 1);
    assert.equal(w.channels_scanned, 2);
    assert.equal(w.truncated, false);
    assert.equal(rowCount("staff_notes"), 0); // reading gathered data writes nothing
  });

  it("never fetches invisible channels (parity): a throwing fetch on one proves it is untouched", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const visible = scanChannel("700000000000000201", { msgs: [msgAt(5, TARGET)] });
    const invisible = scanChannel("700000000000000203", { view: false });
    const fetchedIds = []; // assert AFTER the call — an assert INSIDE the seam would land in the collector's partial-failure catch
    const deps = makeCtxDeps({ channels: [visible, invisible] });
    deps.fetchChannelMessages = async (ch, opts) => {
      fetchedIds.push(String(ch.id));
      return ch.messages.fetch(opts);
    };
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps,
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(fetchedIds, [visible.id], "invisible channel must NEVER be fetched");
    assert.equal(res.context.window.channels_skipped_not_visible, 1);
  });

  it("open-ticket blackout: unarchived ticket channels are skipped and counted", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const chA = scanChannel("700000000000000201", { msgs: [msgAt(3, TARGET)] });
    const ticketCh = scanChannel("700000000000000209", {
      msgs: [msgAt(4, TARGET)],
    });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({
        channels: [chA, ticketCh],
        tickets: { [ticketCh.id]: { archived: 0 } },
      }),
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(
      res.context.window.messages.map((m) => m.id),
      [mid(3)],
    );
    assert.equal(res.context.window.channels_skipped_ticket, 1);
  });

  it("ticket-read failure fails CLOSED: the channel is not scanned, counted", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const chA = scanChannel("700000000000000201", { msgs: [msgAt(3, TARGET)] });
    const res = await withCapturedLogs(() =>
      caseContext.buildCaseContext({
        communityId,
        guildId: GUILD,
        caseNumber: row.case_number,
        deps: makeCtxDeps({ channels: [chA], throwOn: { getTicketByChannel: true } }),
      }),
    );
    assert.equal(res.res.ok, true, res.res.error); // partial failure, not a kill
    assert.equal(res.res.context.window.channels_skipped_ticket, 1);
    assert.deepEqual(res.res.context.window.messages, []); // never scanned blind
    assert.ok(res.lines.some((l) => l.includes("[automod]") && l.includes("201")));
  });

  it("channel cap: ≤15 scanned, more candidates → truncated disclosed", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const channels = [];
    for (let i = 0; i < 20; i++) {
      const msgs = [];
      for (let k = 0; k < 6; k++) msgs.push(msgAt(i * 100 + k, TARGET));
      channels.push(scanChannel(`70000000000000${300 + i}`, { msgs }));
    }
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channels }),
    });
    assert.equal(res.ok, true, res.error);
    const w = res.context.window;
    assert.equal(w.channels_scanned, AUTOMOD_CONTEXT_USER_SCAN_MAX_CHANNELS);
    assert.equal(w.messages.length, 6 * AUTOMOD_CONTEXT_USER_SCAN_MAX_CHANNELS);
    assert.equal(w.truncated, true);
    // channels 16..20 were NOT scanned
    assert.ok(
      w.messages.every((m) => Number(m.id.slice(1)) < 15 * 100 + 6),
    );
  });

  it("message cap: over-delivered page trimmed to the newest 100, chronological display", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const msgs = [];
    for (let n = 1; n <= 150; n++) msgs.push(msgAt(n, TARGET));
    // deliver:"dishonest" — the fake IGNORES limit/before/after (over-delivers
    // all 150); the COLLECTOR must still land exactly on the 100 cap.
    const greedy = scanChannel("700000000000000400", { msgs, deliver: "dishonest" });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channels: [greedy] }),
    });
    assert.equal(res.ok, true, res.error);
    const w = res.context.window;
    // honest limit is min(25, remaining) — the greedy fake ignores it; the
    // collector still lands exactly on the cap:
    assert.equal(w.messages.length, AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES);
    assert.equal(w.truncated, true);
    const ids = w.messages.map((m) => m.id);
    assert.equal(ids[0], mid(51)); // the NEWEST 100 selected…
    assert.equal(ids[ids.length - 1], mid(150)); // …displayed oldest→newest
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1] < ids[i]);
  });

  it("one dead channel does not kill the scan (partial failure counted)", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const good = scanChannel("700000000000000201", { msgs: [msgAt(7, TARGET)] });
    const dead = scanChannel("700000000000000202");
    dead.messages.fetch = async () => {
      throw new Error("500 internal server error");
    };
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channels: [good, dead] }),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.context.window.channels_skipped_error, 1);
    assert.equal(res.context.window.messages.length, 1);
  });

  it("no viewable channels at all → empty window, still ok (bounded, honest)", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channels: [] }),
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.context.window.messages, []);
    assert.deepEqual(res.context.participant_user_ids, []);
    assert.deepEqual(res.context.subject_user_ids, [TARGET]);
  });
});

// ── subject resolution + records ───────────────────────────────────────────

function seedRecords(communityId, userId, { warnings = 1, expired = 0, voidOne = false, notes = 1, deleteLastNote = false } = {}) {
  let last = null;
  for (let i = 0; i < warnings; i++) {
    last = db.createWarning({
      communityId,
      externalGuildId: GUILD,
      userId,
      issuerId: REFERRER,
      reason: `spam ${i}`,
      expiresAt: Date.now() + 86400000,
    });
  }
  for (let i = 0; i < expired; i++) {
    last = db.createWarning({
      communityId,
      externalGuildId: GUILD,
      userId,
      issuerId: REFERRER,
      reason: `old spam ${i}`,
      expiresAt: Date.now() - 86400000, // expired but NOT yet auto-voided
    });
  }
  if (voidOne) {
    db.voidWarning(communityId, last.warning_number, {
      voidedBy: REFERRER,
      voidReason: "appeal upheld — withdrawn",
    });
  }
  let note = null;
  for (let i = 0; i < notes; i++) {
    note = db.createStaffNote({
      communityId,
      userId,
      authorId: REFERRER,
      content: `note ${i}`,
    });
  }
  if (deleteLastNote && note) {
    db.softDeleteStaffNote(communityId, note.note_number, REFERRER);
  }
}

describe("case context — subjects, participants, records", () => {
  it("named target wins as subject; anchor author is the fallback; records preload ONLY for the subject", async () => {
    const communityId = readyCommunity();
    seedRecords(communityId, TARGET, { warnings: 1, expired: 1, notes: 2, deleteLastNote: true });
    seedRecords(communityId, ANCHOR_AUTHOR, { warnings: 1 });
    seedRecords(communityId, BYSTANDER, { warnings: 1, notes: 1 });
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
      targetUserId: TARGET,
    });
    const seed = anchorSeed();
    // bystander authors inside the window:
    const anchor = msgAt(ANCHOR_N, ANCHOR_AUTHOR);
    const byStd = msgAt(450, BYSTANDER);
    const target = msgAt(451, TARGET);
    const byStdAgain = msgAt(452, BYSTANDER);
    const channel = fakeMessageChannel({
      messages: [anchor, byStd, target, byStdAgain],
    });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, true, res.error);
    const ctx = res.context;
    assert.equal(ctx.subject.user_id, TARGET);
    assert.equal(ctx.subject.basis, "named_target");
    // participants: deduped, INCLUDING the subject and the anchor author
    assert.deepEqual(
      [...ctx.participant_user_ids].sort(),
      [ANCHOR_AUTHOR, BYSTANDER, TARGET].sort(),
    );
    // subjects separate:
    assert.deepEqual(ctx.subject_user_ids, [TARGET]);
    // records: TARGET only — 2 non-voided warnings (1 active + 1 expired),
    // the erased note excluded; the bystander's record is NOT present.
    assert.equal(ctx.records.subject_user_id, TARGET);
    assert.equal(ctx.records.warnings.length, 2);
    assert.ok(ctx.records.warnings.every((w) => w.user_id === TARGET));
    assert.ok(ctx.records.warnings.every((w) => w.voided_at === null));
    assert.equal(ctx.records.notes.length, 1);
    assert.ok(ctx.records.notes.every((n) => n.user_id === TARGET));
  });

  it("anchor-author fallback when no user was named", async () => {
    const communityId = readyCommunity();
    seedRecords(communityId, ANCHOR_AUTHOR, { warnings: 2 });
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
    });
    const channel = fakeMessageChannel({ messages: anchorSeed().all });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.context.subject.user_id, ANCHOR_AUTHOR);
    assert.equal(res.context.subject.basis, "anchor_author");
    assert.equal(res.context.records.warnings.length, 2);
  });

  it("zero collector paths write warnings or staff notes (row-count pin)", async () => {
    const communityId = readyCommunity();
    const beforeW = rowCount("warnings");
    const beforeN = rowCount("staff_notes");
    const row = makeCase(communityId, { targetUserId: TARGET });
    const chA = scanChannel("700000000000000201", { msgs: [msgAt(2, TARGET)] });
    const okPath = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channels: [chA] }),
    });
    assert.equal(okPath.ok, true, okPath.error);
    const anchorRow = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
    });
    await withCapturedLogs(() =>
      caseContext.buildCaseContext({
        communityId,
        guildId: GUILD,
        caseNumber: anchorRow.case_number,
        deps: makeCtxDeps({ channel: fakeMessageChannel({ messages: [] }) }), // error path
      }),
    );
    assert.equal(rowCount("warnings"), beforeW);
    assert.equal(rowCount("staff_notes"), beforeN);
  });
});

// ── specific errors ────────────────────────────────────────────────────────

describe("case context — specific failures (never a silent drop)", () => {
  it("rules cleared since intake → specific rules error", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    settingsService.clearRules(communityId);
    const { res, lines } = await withCapturedLogs(() =>
      caseContext.buildCaseContext({
        communityId,
        guildId: GUILD,
        caseNumber: row.case_number,
        deps: makeCtxDeps({ channels: [] }),
      }),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /\*\*Automod rules:\*\*/);
    assert.match(res.error, /cleared \(or never set\) after case/);
    assert.ok(lines.some((l) => l.includes("[automod]")));
  });

  it("referrer no longer a member → specific error, nothing read", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ referrerPresent: false, channels: [] }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /\*\*Referrer gone:\*\*/);
  });

  it("referrerUserId param that MISMATCHES the row's referrer is refused", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      referrerUserId: "u-somebody-else",
      deps: makeCtxDeps({ channels: [] }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /Referrer mismatch/);
  });

  it("case row with neither anchor nor named user → inconsistent-row error", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {}); // no message, no channel, no target
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channels: [] }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /neither a referred message nor a named user/);
  });

  it("half-set anchor (channel without message) → inconsistent-row error", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { channelId: SRC_CH });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel: fakeMessageChannel({ messages: [] }) }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /half-set/);
  });

  it("unknown case number → specific error", async () => {
    const communityId = readyCommunity();
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: 77,
      deps: makeCtxDeps({}),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /No auto-mod case A-77/);
  });

  it("a case row from ANOTHER community is refused", async () => {
    const communityId = readyCommunity();
    const other = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const res = await caseContext.buildCaseContext({
      communityId: other,
      guildId: GUILD,
      case: row,
      deps: makeCtxDeps({ channels: [] }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /refusing to mix communities/);
  });
});

// ── no-throw fuzz + bundle contract ────────────────────────────────────────

describe("case context — never throws (rule 6) + bundle shape (for #728)", () => {
  const seams = [
    "getMember",
    "getGuildChannel",
    "listTextChannels",
    "fetch",
    "getTicketByChannel",
    "getBotMember",
  ];

  for (const seam of seams) {
    it(`a throwing ${seam} seam cannot escape as a throw`, async () => {
      const anchorCommunity = readyCommunity();
      const anchorRow = makeCase(anchorCommunity, {
        messageId: mid(ANCHOR_N),
        channelId: SRC_CH,
      });
      const userCommunity = readyCommunity();
      const userRow = makeCase(userCommunity, { targetUserId: TARGET });
      const channel = fakeMessageChannel({ messages: anchorSeed().all });
      for (const row of [
        { communityId: anchorCommunity, row: anchorRow, channel },
        { communityId: userCommunity, row: userRow, channel: null },
      ]) {
        const { res, lines } = await withCapturedLogs(() =>
          caseContext.buildCaseContext({
            communityId: row.communityId,
            guildId: GUILD,
            caseNumber: row.row.case_number,
            deps: makeCtxDeps({ channel: row.channel, throwOn: { [seam]: true } }),
          }),
        );
        assert.ok(res && typeof res === "object", `${seam}: returned nothing`);
        if (!res.ok) {
          assert.match(res.error, /\S/); // specific-ish, never empty
          // every failure logged [automod] with the community id (rule 2)
          assert.ok(
            lines.some(
              (l) => l.includes("[automod]") && l.includes(String(row.communityId)),
            ),
            `${seam}: no [automod] log line with the community id`,
          );
        }
        // getTicketByChannel + getBotMember failures are handled locally
        // (fail-closed skip / optional pre-check) — ok:true is legal there.
      }
    });
  }

  it("no deps at all (no client) → specific fail-closed error, not a throw", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const { res } = await withCapturedLogs(() =>
      caseContext.buildCaseContext({
        communityId,
        guildId: GUILD,
        caseNumber: row.case_number,
        // no deps: production defaults demand deps.client
      }),
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /Discord client|member/i);
  });

  it("bundle is the pinned JSON-able shape for the #728 harness", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
      targetUserId: TARGET,
    });
    const channel = fakeMessageChannel({ messages: anchorSeed().all });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      nowMs: 1765000000000,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, true, res.error);
    const ctx = res.context;
    assert.deepEqual(
      Object.keys(ctx).sort(),
      [
        "case",
        "meta",
        "participant_user_ids",
        "records",
        "referral",
        "rules",
        "schema",
        "subject",
        "subject_user_ids",
        "window",
      ].sort(),
    );
    // #771 /2: `referral.required_context` joins the bundle and the window
    // counts become PER-CASE (modal values; legacy rows keep 40/10).
    assert.equal(ctx.schema, "automod-case-context/2");
    assert.equal("required_context" in ctx.referral, true, "#771 referral block carries the context field");
    assert.equal(ctx.case.case_ref, `A-${row.case_number}`);
    assert.equal(ctx.meta.collected_at, 1765000000000);
    assert.equal(ctx.meta.caps.before_window, READ_DISCORD_BEFORE_WINDOW);
    assert.equal(ctx.meta.caps.after_window, READ_DISCORD_AFTER_WINDOW);
    assert.deepEqual(
      Object.keys(ctx.window.messages[0]).sort(),
      [
        "attachments",
        "author_id",
        "channel_id",
        "content",
        "content_truncated",
        "id",
        "is_anchor",
        "timestamp",
      ].sort(),
    );
    // plain JSON-able: round-trip identity proves no class instances leaked
    assert.deepEqual(JSON.parse(JSON.stringify(ctx)), ctx);
    // ids are strings everywhere
    assert.equal(typeof ctx.referral.referrer_user_id, "string");
    assert.ok(ctx.participant_user_ids.every((id) => typeof id === "string"));
  });

  it("accepts the already-loaded case row (harness hot path)", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, { targetUserId: TARGET });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      case: row,
      deps: makeCtxDeps({ channels: [] }),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.context.case.id, row.id);
  });
});

// ── #771: the PER-CASE read window ─────────────────────────────────────────

describe("#771 per-case read window", () => {
  it("effectiveReadWindow: modal values clamp; legacy NULL rows keep 40/10", () => {
    assert.deepEqual(
      caseContext.effectiveReadWindow({ read_before: 250, read_after: 5 }),
      { before: 250, after: 5 },
    );
    assert.deepEqual(caseContext.effectiveReadWindow({}), {
      before: READ_DISCORD_BEFORE_WINDOW,
      after: READ_DISCORD_AFTER_WINDOW,
    });
    assert.deepEqual(
      caseContext.effectiveReadWindow({ read_before: "900", read_after: "-3" }),
      { before: 500, after: 0 },
      "the repository belt again at read time: 0–500, never beyond",
    );
    assert.deepEqual(
      caseContext.effectiveReadWindow({ read_before: "abc", read_after: "" }),
      { before: READ_DISCORD_BEFORE_WINDOW, after: READ_DISCORD_AFTER_WINDOW },
      "garbage falls back to the historical pair",
    );
  });

  it("the bundle reports what THIS case reads (caps + real window = modal values)", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
      targetUserId: TARGET,
      readBefore: 30,
      readAfter: 4,
      requiredContext: "the thread that started this",
    });
    const channel = fakeMessageChannel({ messages: anchorSeed().all, deliver: "honest" });
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.context.meta.caps.before_window, 30);
    assert.equal(res.context.meta.caps.after_window, 4);
    assert.equal(res.context.window.messages.length, 1 + 30 + 4);
    assert.equal(res.context.referral.required_context, "the thread that started this");
  });

  it("a 250-message read PAGINATES past the 100-per-fetch cap (three pages)", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
      targetUserId: TARGET,
      readBefore: 250,
      readAfter: 0,
    });
    const seed = [];
    for (let n = 200; n < ANCHOR_N; n++) seed.push(msgAt(n, `u-b-${n % 4}`));
    seed.push(msgAt(ANCHOR_N, ANCHOR_AUTHOR, "the offense"));
    const channel = fakeMessageChannel({ messages: seed, deliver: "honest" });
    const pageLimits = [];
    const origFetch = channel.messages.fetch;
    channel.messages.fetch = async (opts) => {
      if (typeof opts !== "string") pageLimits.push(opts.limit);
      return origFetch(opts);
    };
    const res = await caseContext.buildCaseContext({
      communityId,
      guildId: GUILD,
      caseNumber: row.case_number,
      deps: makeCtxDeps({ channel }),
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(pageLimits, [100, 100, 50], "100-per-page cursor walk, exact remainder last");
    assert.equal(res.context.window.messages.length, 251, "250 before + the anchor (0 after)");
    assert.equal(res.context.window.messages[250].is_anchor, true);
  });

  it("a mid-pagination throw stays FAIL-CLOSED (a half-read window is never judged)", async () => {
    const communityId = readyCommunity();
    const row = makeCase(communityId, {
      messageId: mid(ANCHOR_N),
      channelId: SRC_CH,
      targetUserId: TARGET,
      readBefore: 250,
      readAfter: 0,
    });
    const seed = [];
    for (let n = 200; n < ANCHOR_N; n++) seed.push(msgAt(n, ANCHOR_AUTHOR));
    seed.push(msgAt(ANCHOR_N, ANCHOR_AUTHOR, "the offense"));
    const channel = fakeMessageChannel({ messages: seed, deliver: "honest" });
    let windowFetches = 0;
    const origFetch = channel.messages.fetch;
    channel.messages.fetch = async (opts) => {
      if (typeof opts !== "string") {
        windowFetches += 1;
        if (windowFetches === 2) throw Object.assign(new Error("429 rate limited"), { code: 429 });
      }
      return origFetch(opts);
    };
    const { res, lines } = await withCapturedLogs(() =>
      caseContext.buildCaseContext({
        communityId,
        guildId: GUILD,
        caseNumber: row.case_number,
        deps: makeCtxDeps({ channel }),
      }),
    );
    assert.equal(res.ok, false, "page 2 dying must not yield a 100-message 'complete' window");
    assert.match(
      res.error,
      /half-read window/,
      `the refusal names the law: ${res.error}`,
    );
    assert.ok(
      lines.some((l) => l.includes("429 rate limited")),
      "the real cause is logged, not just named around",
    );
  });
});

// ── pure anchor capping (unit) ─────────────────────────────────────────────

describe("capAroundAnchor (pure)", () => {
  it("keeps the anchor + nearest before/after, order preserved", () => {
    const mk = (n) => ({ id: mid(n) });
    const all = sort(mk, [1, 2, 3, 4, 5, 10, 11]);
    const capped = caseContext.capAroundAnchor(all, mid(4), 2, 1);
    assert.deepEqual(capped.map((m) => m.id), [mid(2), mid(3), mid(4), mid(5)]);
  });

  it("tolerates a missing anchor (returns nothing anchored)", () => {
    const mk = (n) => ({ id: mid(n) });
    const capped = caseContext.capAroundAnchor([mk(1)], mid(9), 2, 2);
    assert.deepEqual(capped.map((m) => m.id), []);
  });
});

function sort(mk, nums) {
  return nums.map(mk); // already ascending by construction
}
