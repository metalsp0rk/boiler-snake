/**
 * #773 §3/§6: ferry-engine unit suite (test/ban-appeals-ferry.test.js).
 *
 * Pins the LOCKED relay law from ferry.js's §3 table (subtask 10):
 *  Classification:   text / image / video relay BOTH directions; audio
 *                    (attachment or voice-memo flag), sticker, poll (field or
 *                    type 21), forwarded (FieldRefs flag or snapshot),
 *                    component, embed-only, unsupported file → the SPECIFIC
 *                    FERRY_COPY refusal to the SENDER and TOTAL SILENCE on
 *                    the far side (both sides asserted, every row); empty and
 *                    system messages drop silently with zero sends.
 *  Loop-proofing:    bot-authored, webhook (raw + camel), the bot's own id,
 *                    and author-less messages never ferry; the relayed-id
 *                    guard (belt #2) is exercised independently of the
 *                    author check; noteRelayedMessageId is a bounded FIFO.
 *  Formats:          user→ticket `**<escaped username · id>:**`, ticket→user
 *                    `**<staff display>:**` (NO id); planted markdown /
 *                    <@id> / @everyone render inert; ban-record metadata
 *                    (moderator id, case id, warning/staff-note bodies) never
 *                    appears user-side; every send carries allowedMentions.
 *  Cursors:          the pair saves ONLY after a successful send (order
 *                    asserted); send failure holds the cursor; blocked
 *                    messages never advance; a throwing cursor save degrades
 *                    (the send already happened); real-DB tests drive the
 *                    shipped saveAppealCursor/loadAppealCursor pair law, and
 *                    the restart test re-requires the engine against the same
 *                    SQLite file (literal restart, nothing replayed/skipped).
 *  Catch-up:         STRICTLY after the (id, ts) pair; created_at THEN id
 *                    order (id monotonicity not assumed); bound
 *                    FERRY_CATCHUP_MAX with truthful unprocessed; a single
 *                    failure STOPS there and reports stoppedAt; the flood
 *                    gate is relaxed for bounded history replay.
 *  Flood:            per-appeal (sender) cooldown + hourly cap built from the
 *                    constants.js values; drops are specific to the sender
 *                    (throttled notice) and silent to staff; the staff side
 *                    runs NO second ledger.
 *  Re-upload:        shareable bytes re-ride the send as {name,data}; the
 *                    declared-size over-cap refusal names the size AND the
 *                    cap and NEVER DOWNLOADS (fetchImpl spy proves it);
 *                    per-file failures relay what survived + one specific
 *                    notice per dropped part.
 *  Never-throws:     exploding sendChannel/sendDm/repo/fetchImpl all answer
 *                    { ok:false|partial } with a specific cause — never a
 *                    thrown event-loop kill.
 *
 * Method (ban-lifecycle-service idiom): pure-deps doubles — recording
 * sendChannel/sendDm/repo/fetch/resolveHost sharing ONE calls array (order
 * asserted, not hoped at), an injected clock (no wall clock, no timers), and
 * per-test floodLedger/relayedIds so module defaults never bleed. The real
 * repo is used ONLY in the cursor-pair persistence section (loadDb header law
 * observed: loadDb() runs above every src/ require).
 *
 * Law-vs-ship note: MIXED-PARTIAL ("the sender learns exactly what did not
 * travel", ferry.js header lines 34 and 494) is pinned as the LAW: the
 * relay path must notice a dropped audio part. The current relayMessageCore
 * seeds `notices` only from rehostAttachments (cls.refusal is read only in
 * the !cls.relay branch), so that ONE test is the evidence pin for the
 * engine fix — it must turn green when ferry.js delivers the classification
 * drop notice on relay rows.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey, resetSrcModules } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

after(cleanup);

const ferry = require("../src/features/banAppeals/ferry");
const {
  classifyOutbound,
  relayUserToTicket,
  relayTicketToUser,
  catchUpOnBoot,
  noteRelayedMessageId,
  isLoopAuthored,
  FERRY_COPY,
  internals,
} = ferry;
const {
  FERRY_ATTACHMENT_MAX_BYTES,
  FERRY_USER_COOLDOWN_MS,
  FERRY_USER_HOURLY_CAP,
  FERRY_CATCHUP_MAX,
} = require("../src/features/banAppeals/constants");

// ── deterministic fixtures ───────────────────────────────────────────────────

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const BOT = "900100000000000001";
const USER = "880100000000000002"; // banned appellant (sender user→ticket, target ticket→user)
const STAFF = "880100000000000003";
const TICKET = "770100000000000004";
const PUBLIC_IP = "93.184.216.34"; // any public unicast address satisfies the SSRF guard

let idN = 5000;
const nid = () => String(++idN);

/** Appeal-row duck (what 07 loads by id / ticket channel). */
const appeal = (over = {}) => ({
  id: 701,
  status: "open",
  ferry_paused: 0,
  ticket_channel_id: TICKET,
  user_id: USER,
  ...over,
});

/** User DM duck (plain human message unless overridden). */
const dmMsg = (id, over = {}) => ({
  id,
  type: 0,
  timestamp: T0,
  content: "hello staff",
  author: { id: USER, username: "appealer" },
  attachments: [],
  embeds: [],
  ...over,
});

/** Ticket staff-message duck. */
const ticketMsg = (id, over = {}) => ({
  id,
  type: 0,
  timestamp: T0,
  content: "staff reply",
  author: { id: STAFF, username: "modbob" },
  member: { displayName: "Mod Alice" },
  attachments: [],
  embeds: [],
  ...over,
});

const att = (name, over = {}) => ({
  id: `att-${name}`,
  name,
  url: `https://cdn.example.com/${name}`,
  size: 1024,
  ...over,
});
const imgAtt = (name = "photo.png", over = {}) => att(name, over);
const vidAtt = (name = "clip.mp4", over = {}) => att(name, over);
const audioAtt = (name = "voice.ogg", over = {}) => att(name, over);
const fileAtt = (name = "notes.zip", over = {}) => att(name, over);

// ── recording world (single calls array: ORDER is asserted, not hoped at) ───

function makeWorld() {
  const w = {
    calls: [],
    fetchCalls: [],
    resolveCalls: [],
    cursors: new Map(), // `${appealId}:${direction}` → {messageId, timestampMs} — PAIR only
    ledger: new Map(),
    ids: new Set(),
    order: [],
    nowMs: T0,
    channelResult: undefined, // value | fn | array-queue ({ok:true} default)
    dmResult: undefined,
    channelThrows: null,
    dmThrows: null,
    saveCursorThrows: null,
    loadCursorOverride: null, // when set, loadAppealCursor answers with it verbatim
    fetchBytes: Buffer.from("deterministic-image-bytes"),
    fetchStatus: 200,
    fetchThrows: null,
    fetcherSeen: null,
    sentSeq: 9000,
  };

  const nextResult = (spec) => {
    let base = spec;
    if (Array.isArray(base)) base = base.length > 0 ? base.shift() : { ok: true };
    if (typeof base === "function") base = base();
    if (base === undefined) base = { ok: true };
    if (base && base.ok === true && base.id == null) base = { ok: true, id: String(++w.sentSeq) };
    return base;
  };

  w.now = () => w.nowMs;

  w.sendChannel = async (channelId, payload) => {
    w.calls.push({ op: "sendChannel", channelId, payload });
    if (w.channelThrows) throw w.channelThrows;
    return nextResult(w.channelResult);
  };
  w.sendDm = async (userId, payload) => {
    w.calls.push({ op: "sendDm", userId, payload });
    if (w.dmThrows) throw w.dmThrows;
    return nextResult(w.dmResult);
  };

  // Fake repo mirroring the shipped cursor PAIR law (both halves or nothing).
  w.repo = {
    saveAppealCursor(appealId, direction, cursor = {}) {
      w.calls.push({
        op: "saveCursor",
        appealId,
        direction,
        messageId: cursor.messageId,
        timestampMs: cursor.timestampMs,
      });
      if (w.saveCursorThrows) throw w.saveCursorThrows;
      const messageId = cursor.messageId == null ? null : String(cursor.messageId);
      const ts = Number(cursor.timestampMs);
      if (!messageId || !Number.isFinite(ts) || ts <= 0) {
        return { ok: false, error: "A ferry cursor needs both the message id and a positive timestamp." };
      }
      w.cursors.set(`${appealId}:${direction}`, { messageId, timestampMs: Math.floor(ts) });
      return { ok: true, won: true };
    },
    loadAppealCursor(appealId, direction) {
      w.calls.push({ op: "loadCursor", appealId, direction });
      if (w.loadCursorOverride) return w.loadCursorOverride;
      return { ok: true, cursor: w.cursors.get(`${appealId}:${direction}`) ?? null };
    },
  };

  // Guarded-download seams: SSRF-clean host, deterministic bytes, spy counts.
  w.resolveHost = async (host) => {
    w.resolveCalls.push(host);
    return [PUBLIC_IP];
  };
  w.fetchImpl = async (url) => {
    w.fetchCalls.push(url);
    if (w.fetchThrows) throw w.fetchThrows;
    const bytes = w.fetchBytes;
    return {
      ok: w.fetchStatus === 200,
      status: w.fetchStatus,
      headers: {
        get: (name) => (String(name).toLowerCase() === "content-type" ? "image/png" : null),
      },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };

  w.deps = (extra = {}) => ({
    sendChannel: w.sendChannel,
    sendDm: w.sendDm,
    clientUserId: BOT,
    repo: w.repo,
    now: w.now,
    floodLedger: w.ledger,
    relayedIds: w.ids,
    relayedOrder: w.order,
    fetchImpl: w.fetchImpl,
    resolveHost: w.resolveHost,
    ...extra,
  });

  /** messagesFetcher double: newest-first like discord.js; args recorded. */
  w.fetcher = (list) => ({
    fn: async (args) => {
      w.fetcherSeen = args;
      return list;
    },
  });

  return w;
}

const sends = (w) => w.calls.filter((c) => c.op === "sendChannel");
const dms = (w) => w.calls.filter((c) => c.op === "sendDm");
const cursorSaves = (w) => w.calls.filter((c) => c.op === "saveCursor");
const ops = (w) => w.calls.map((c) => c.op);

// ════════════════════════════════════════════════════════════════════════════
// 1. Classification matrix (pure §3 rows; units inspect drops/shareable)
// ════════════════════════════════════════════════════════════════════════════

describe("classification matrix: relay kinds classify shareable in both directions", () => {
  const cases = [
    {
      label: "plain text",
      kind: "text",
      msg: () => dmMsg(nid()),
    },
    {
      label: "image attachment",
      kind: "image",
      msg: () => dmMsg(nid(), { content: "", attachments: [imgAtt()] }),
    },
    {
      label: "video attachment",
      kind: "video",
      msg: () => dmMsg(nid(), { content: "", attachments: [vidAtt()] }),
    },
    {
      label: "legacy reply type 19 is plain (relays)",
      kind: "text",
      msg: () => dmMsg(nid(), { type: 19 }),
    },
    {
      label: "video outranks image (deterministic tie-break)",
      kind: "video",
      msg: () =>
        dmMsg(nid(), { content: "", attachments: [imgAtt(), vidAtt()] }),
    },
  ];
  for (const c of cases) {
    it(`classify[${c.label}] → relay:true kind:${c.kind}`, () => {
      const cls = classifyOutbound(c.msg(), { clientUserId: BOT });
      assert.equal(cls.relay, true, JSON.stringify(cls));
      assert.equal(cls.kind, c.kind);
      assert.equal(cls.silent, false);
    });
  }
});

describe("classification matrix: blocked kinds are specific; empty/system silent", () => {
  const blocked = [
    {
      label: "audio attachment",
      msg: () => dmMsg(nid(), { content: "", attachments: [audioAtt()] }),
      kind: "audio",
      refusal: FERRY_COPY.audio,
    },
    {
      // Voice memo: an ordinary file attachment wearing the IsVoiceMessage flag
      // (bit 13, platform mirror) classifies as audio.
      label: "voice-message flag on a file attachment",
      msg: () =>
        dmMsg(nid(), {
          content: "",
          attachments: [att("voice.opus", { flags: 1 << 13 })],
        }),
      kind: "audio",
      refusal: FERRY_COPY.audio,
    },
    {
      label: "sticker-only message",
      msg: () => dmMsg(nid(), { content: "", stickers: [{ id: "s1" }] }),
      kind: "sticker",
      refusal: FERRY_COPY.sticker,
    },
    {
      label: "poll field message",
      msg: () => dmMsg(nid(), { content: "", poll: { question: "??" } }),
      kind: "poll",
      refusal: FERRY_COPY.poll,
    },
    {
      label: "poll by type 21 (typed-non-zero outranks the system bucket)",
      msg: () => dmMsg(nid(), { content: "", type: 21 }),
      kind: "poll",
      refusal: FERRY_COPY.poll,
    },
    {
      label: "forwarded via FieldRefs flag",
      msg: () => dmMsg(nid(), { content: "", flags: internals.FLAG_FIELD_REFS }),
      kind: "forwarded",
      refusal: FERRY_COPY.forwarded,
    },
    {
      label: "forwarded via message_snapshots",
      msg: () => dmMsg(nid(), { content: "", message_snapshots: [{}] }),
      kind: "forwarded",
      refusal: FERRY_COPY.forwarded,
    },
    {
      label: "component/action message",
      msg: () => dmMsg(nid(), { content: "", components: [{ type: 1 }] }),
      kind: "component",
      refusal: FERRY_COPY.component,
    },
    {
      label: "embed-only message",
      msg: () => dmMsg(nid(), { content: "", embeds: [{ description: "card" }] }),
      kind: "embed_only",
      refusal: FERRY_COPY.embedOnly,
    },
    {
      label: "unsupported file attachment (names the file)",
      msg: () => dmMsg(nid(), { content: "", attachments: [fileAtt()] }),
      kind: "file",
      refusal: FERRY_COPY.fileKind("notes.zip"),
    },
    {
      label: "empty message (text-less, attachment-less) is SILENT",
      msg: () => dmMsg(nid(), { content: "   " }),
      kind: "empty",
      refusal: null,
      silent: true,
    },
    {
      label: "system message (type ≠ 0/19) is SILENT",
      msg: () => dmMsg(nid(), { type: 6 }),
      kind: "system",
      refusal: null,
      silent: true,
    },
    {
      label: "bot author classifies loop_proof (silent)",
      msg: () => dmMsg(nid(), { author: { id: BOT, bot: true } }),
      kind: "loop_proof",
      refusal: null,
      silent: true,
    },
  ];
  for (const c of blocked) {
    it(`classify[${c.label}] → kind:${c.kind}, refusal ${c.refusal ? "specific" : "null/silent"}`, () => {
      const cls = classifyOutbound(c.msg(), { clientUserId: BOT });
      assert.equal(cls.relay, false, JSON.stringify(cls));
      assert.equal(cls.kind, c.kind);
      assert.equal(cls.silent, Boolean(c.silent));
      if (c.refusal) {
        assert.equal(cls.refusal, c.refusal, "the exact per-kind FERRY_COPY sentence");
      } else {
        assert.equal(cls.refusal, null, "silent buckets carry no notice");
      }
    });
  }

  it("mixed partial (text + image + audio): classifier marks it RELAY with kind:image and drops the audio named", () => {
    const cls = classifyOutbound(
      dmMsg(nid(), { content: "look at both", attachments: [imgAtt(), audioAtt()] }),
      { clientUserId: BOT },
    );
    assert.equal(cls.relay, true, JSON.stringify(cls));
    assert.equal(cls.kind, "image");
    assert.equal(cls.shareable.length, 1);
    assert.equal(cls.shareable[0].name, "photo.png");
    assert.equal(cls.drops.length, 1, "the audio part is a recorded drop");
    assert.equal(cls.drops[0].name, "voice.ogg", "the drop names the exact file");
    assert.equal(cls.drops[0].copy, FERRY_COPY.audio, "the drop carries the audio refusal sentence");
    assert.ok(cls.refusal.includes(FERRY_COPY.audio), "refusal is the aggregated sender notice");
  });

  it("whole-message blocks outrank their text/payload parts (poll+text and forwarded+image refuse whole)", () => {
    const poll = classifyOutbound(
      dmMsg(nid(), { content: "vote!", poll: { question: "yes/no" } }),
      { clientUserId: BOT },
    );
    assert.equal(poll.relay, false);
    assert.equal(poll.refusal, FERRY_COPY.poll);

    const fwd = classifyOutbound(
      dmMsg(nid(), { content: "see above", flags: internals.FLAG_FIELD_REFS, attachments: [imgAtt()] }),
      { clientUserId: BOT },
    );
    assert.equal(fwd.relay, false);
    assert.equal(fwd.refusal, FERRY_COPY.forwarded);
  });

  it("sticker sharing relayable text relays the text (shipped: the sticker itself is simply not a payload)", () => {
    // Pinned as SHIPPED behaviour, not asserted as law: classification carries
    // no sticker drop sentence (flagged to the orchestrator alongside the
    // relay-path notice gap pinned under mixed-partial relay below).
    const cls = classifyOutbound(
      dmMsg(nid(), { content: "look at this sticker", stickers: [{ id: "s1" }] }),
      { clientUserId: BOT },
    );
    assert.equal(cls.relay, true);
    assert.equal(cls.kind, "text");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Engine matrix — blocked kinds: specific refusal to SENDER, SILENCE far side
// ════════════════════════════════════════════════════════════════════════════

describe("engine matrix: blocked kinds refuse specifically user→ticket and stay ticket-silent", () => {
  const rows = [
    {
      label: "audio",
      skipped: "audio",
      extra: () => ({ content: "", attachments: [audioAtt()] }),
      copy: FERRY_COPY.audio,
    },
    {
      label: "sticker",
      skipped: "sticker",
      extra: () => ({ content: "", stickers: [{ id: "s1" }] }),
      copy: FERRY_COPY.sticker,
    },
    {
      label: "poll",
      skipped: "poll",
      extra: () => ({ content: "", poll: { question: "??" } }),
      copy: FERRY_COPY.poll,
    },
    {
      label: "forwarded",
      skipped: "forwarded",
      extra: () => ({ content: "", flags: internals.FLAG_FIELD_REFS }),
      copy: FERRY_COPY.forwarded,
    },
    {
      label: "component",
      skipped: "component",
      extra: () => ({ content: "", components: [{ type: 1 }] }),
      copy: FERRY_COPY.component,
    },
    {
      label: "embed-only",
      skipped: "embed_only",
      extra: () => ({ content: "", embeds: [{ description: "card" }] }),
      copy: FERRY_COPY.embedOnly,
    },
    {
      label: "unsupported file (refusal names the file)",
      skipped: "file",
      extra: () => ({ content: "", attachments: [fileAtt()] }),
      copy: FERRY_COPY.fileKind("notes.zip"),
    },
  ];
  for (const r of rows) {
    it(`blocked[${r.label}] user→ticket: DM refusal = FERRY_COPY sentence, ticket silent, cursor held`, async () => {
      const w = makeWorld();
      const res = await relayUserToTicket({
        appeal: appeal(),
        message: dmMsg(nid(), r.extra()),
        deps: w.deps(),
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.relayed, false);
      assert.equal(res.skipped, r.skipped);
      assert.equal(res.refusalSent, true, "the sender WAS told specifically");
      const notes = dms(w);
      assert.equal(notes.length, 1, "exactly one sender notice");
      assert.equal(notes[0].userId, USER, "the notice goes to the appealing user's DM");
      assert.equal(notes[0].payload.content, r.copy, "the refusal names the exact payload kind");
      assert.deepEqual(notes[0].payload.allowedMentions, { parse: [] });
      assert.equal(sends(w).length, 0, "the staff side is SILENT — nothing lands in the ticket");
      assert.equal(cursorSaves(w).length, 0, "a blocked message never advances the cursor");
    });
  }
});

describe("engine matrix: blocked kinds refuse specifically ticket→user and stay DM-silent", () => {
  const rows = [
    {
      label: "audio",
      skipped: "audio",
      extra: () => ({ content: "", attachments: [audioAtt()] }),
      copy: FERRY_COPY.audio,
    },
    {
      label: "sticker",
      skipped: "sticker",
      extra: () => ({ content: "", stickers: [{ id: "s1" }] }),
      copy: FERRY_COPY.sticker,
    },
    {
      label: "poll",
      skipped: "poll",
      extra: () => ({ content: "", poll: { question: "??" } }),
      copy: FERRY_COPY.poll,
    },
    {
      label: "forwarded",
      skipped: "forwarded",
      extra: () => ({ content: "", flags: internals.FLAG_FIELD_REFS }),
      copy: FERRY_COPY.forwarded,
    },
    {
      label: "component",
      skipped: "component",
      extra: () => ({ content: "", components: [{ type: 1 }] }),
      copy: FERRY_COPY.component,
    },
    {
      label: "embed-only (staff link-preview message)",
      skipped: "embed_only",
      extra: () => ({ content: "", embeds: [{ description: "preview" }] }),
      copy: FERRY_COPY.embedOnly,
    },
    {
      label: "unsupported file (refusal names the file)",
      skipped: "file",
      extra: () => ({ content: "", attachments: [fileAtt()] }),
      copy: FERRY_COPY.fileKind("notes.zip"),
    },
  ];
  for (const r of rows) {
    it(`blocked[${r.label}] ticket→user: in-ticket refusal to the author, the user's DM silent, cursor held`, async () => {
      const w = makeWorld();
      const res = await relayTicketToUser({
        appeal: appeal(),
        message: ticketMsg(nid(), r.extra()),
        deps: w.deps(),
        userId: USER,
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.relayed, false);
      assert.equal(res.skipped, r.skipped);
      assert.equal(res.refusalSent, true, "the staff author WAS told specifically, IN the ticket");
      const notes = sends(w);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].channelId, TICKET, "the refusal is delivered to the ticket, not the DM");
      assert.equal(notes[0].payload.content, r.copy, "the refusal names the exact payload kind");
      assert.equal(dms(w).length, 0, "the banned user's DM receives NOTHING (far side silent)");
      assert.equal(cursorSaves(w).length, 0, "a blocked message never advances the cursor");
    });
  }
});

describe("engine matrix: empty and system messages drop SILENTLY both ways", () => {
  for (const [label, extra] of [
    ["empty (no text, no attachments)", () => ({ content: "" })],
    ["system message (type 6)", () => ({ type: 6, content: "pinned something" })],
  ]) {
    it(`silent[${label}] user→ticket: zero sends, zero notices, cursor held`, async () => {
      const w = makeWorld();
      const res = await relayUserToTicket({
        appeal: appeal(),
        message: dmMsg(nid(), extra()),
        deps: w.deps(),
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.relayed, false);
      assert.equal(w.calls.length, 0, "total silence — nobody authored anything worth relaying");
    });
    it(`silent[${label}] ticket→user: zero sends, zero notices, cursor held`, async () => {
      const w = makeWorld();
      const res = await relayTicketToUser({
        appeal: appeal(),
        message: ticketMsg(nid(), extra()),
        deps: w.deps(),
        userId: USER,
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.relayed, false);
      assert.equal(w.calls.length, 0);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Engine matrix — relay kinds in both directions (format law rides here too)
// ════════════════════════════════════════════════════════════════════════════

describe("engine matrix: relay kinds ship BOTH directions with cursor-after-send order", () => {
  const rows = [
    { label: "plain text", extra: () => ({ content: "plain hello" }), wantsFiles: false },
    { label: "image", extra: () => ({ content: "", attachments: [imgAtt()] }), wantsFiles: true, fileName: "photo.png" },
    { label: "video", extra: () => ({ content: "", attachments: [vidAtt()] }), wantsFiles: true, fileName: "clip.mp4" },
  ];
  for (const r of rows) {
    it(`relay[${r.label}] user→ticket: signed payload into the ticket, guarded download once, cursor pair AFTER the send`, async () => {
      const w = makeWorld();
      const message = dmMsg("5321", r.extra());
      const res = await relayUserToTicket({ appeal: appeal(), message, deps: w.deps() });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.relayed, true);
      assert.equal(res.cursorSaved, true);

      const posts = sends(w);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].channelId, TICKET, "the relay lands in the staff ticket");
      const header = internals.signatureFor("user", message);
      assert.ok(posts[0].payload.content.startsWith(header), `header rides first: ${posts[0].payload.content}`);
      assert.deepEqual(posts[0].payload.allowedMentions, { parse: [] });
      assert.ok(!("embeds" in posts[0].payload), "embeds NEVER ride a relay payload");
      if (r.wantsFiles) {
        assert.deepEqual(w.resolveCalls, ["cdn.example.com"], "the download rides the SSRF-guarded host check");
        assert.equal(w.fetchCalls.length, 1, "exactly one guarded download");
        assert.equal(posts[0].payload.files.length, 1);
        assert.equal(posts[0].payload.files[0].name, r.fileName);
        assert.deepEqual(posts[0].payload.files[0].data, w.fetchBytes, "bytes re-ride as an in-memory buffer");
      } else {
        assert.equal(posts[0].payload.files, undefined);
        assert.equal(w.fetchCalls.length, 0);
      }

      // Cursor law: save AFTER the successful send, with the full pair.
      const saveOps = ops(w);
      assert.ok(
        saveOps.indexOf("sendChannel") < saveOps.indexOf("saveCursor"),
        `cursor advances only after the send: ${saveOps}`,
      );
      assert.deepEqual(w.cursors.get("701:user"), { messageId: "5321", timestampMs: T0 });
    });

    it(`relay[${r.label}] ticket→user: display-name payload into the DM, no in-ticket echo, cursor pair AFTER the send`, async () => {
      const w = makeWorld();
      const message = ticketMsg("5322", r.extra());
      const res = await relayTicketToUser({ appeal: appeal(), message, deps: w.deps(), userId: USER });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.relayed, true);

      const posts = dms(w);
      assert.equal(posts.length, 1, "the relay is the ONLY DM (no extra notice)");
      assert.equal(posts[0].userId, USER);
      const header = internals.signatureFor("ticket", message);
      assert.ok(posts[0].payload.content.startsWith(header));
      if (r.wantsFiles) {
        assert.equal(posts[0].payload.files[0].name, r.fileName);
        assert.deepEqual(posts[0].payload.files[0].data, w.fetchBytes);
      }
      assert.equal(sends(w).length, 0, "nothing echoes back into the ticket");
      assert.ok(
        ops(w).indexOf("sendDm") < ops(w).indexOf("saveCursor"),
        "cursor advances only after the send",
      );
      assert.deepEqual(w.cursors.get("701:ticket"), { messageId: "5322", timestampMs: T0 });
    });
  }
});

describe("formats: signatures, escaping, and §6 privacy", () => {
  it("user→ticket header is the literal `**<username · id>:** text`", async () => {
    const w = makeWorld();
    await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid(), { content: "hello staff" }),
      deps: w.deps(),
    });
    assert.equal(
      sends(w)[0].payload.content,
      `**appealer · ${USER}:** hello staff`,
      "exact locked copy (colon inside the bold, id after the middot)",
    );
  });

  it("ticket→user header is the literal `**<staff display>:** text` with NO author id", async () => {
    const w = makeWorld();
    await relayTicketToUser({
      appeal: appeal(),
      message: ticketMsg(nid(), { content: "staff reply" }),
      deps: w.deps(),
      userId: USER,
    });
    const dm = dms(w)[0].payload.content;
    assert.equal(dm, "**Mod Alice:** staff reply", "display name ONLY (issue §3 copy)");
    assert.ok(!dm.includes(STAFF), "the staff account id never rides user-side");
    assert.ok(!dm.includes("·"), "the ticket→user signature carries no middot-id half at all");
  });

  it("a planted markdown / <@id> / @everyone username renders INERT user-side", async () => {
    const w = makeWorld();
    const planted = "`evil` _under_ *star* ~tilde~ |pipe| >quote <@2004> @everyone <@&3005>";
    const message = dmMsg(nid(), {
      content: "I am not really a ping",
      author: { id: USER, username: planted },
    });
    await relayUserToTicket({ appeal: appeal(), message, deps: w.deps() });
    const content = sends(w)[0].payload.content;
    // No raw mention survives…
    assert.ok(!content.includes("<@2004>"), "the fake mention renders inert");
    assert.ok(!/<(?![\\])@/.test(content), "no raw <@ opener anywhere");
    assert.ok(!/(?<!\\)@everyone/.test(content), "@everyone is escaped out of ping range");
    assert.ok(!content.includes("<@&3005>"), "the fake role mention renders inert");
    // …and the escaped forms are visible as plain text (acceptance chars _ * ~ ` | >).
    assert.ok(content.includes("\\<\\@2004\\>"), `escaped mention survives visibly: ${content}`);
    assert.ok(content.includes("\\@everyone"), "escaped @everyone survives visibly");
    assert.ok(content.includes("\\`evil\\`"), "backticks escaped");
    assert.ok(content.includes("\\_under\\_"), "underscores escaped");
    assert.ok(content.includes("\\*star\\*"), "asterisks escaped");
    assert.ok(content.includes("\\~tilde\\~"), "tildes escaped");
    assert.ok(content.includes("\\|pipe\\|"), "pipes escaped");
    assert.ok(content.includes("\\>quote"), "block-quote marker escaped");
    assert.deepEqual(sends(w)[0].payload.allowedMentions, { parse: [] }, "the send-side ping belt rides too");
  });

  it("staff display names ride the SAME escape law ticket→user", async () => {
    const w = makeWorld();
    await relayTicketToUser({
      appeal: appeal(),
      message: ticketMsg(nid(), { member: { displayName: "@everyone <@1337>" } }),
      deps: w.deps(),
      userId: USER,
    });
    const content = dms(w)[0].payload.content;
    assert.ok(!content.includes("<@1337>"));
    assert.ok(!content.includes("**@everyone**"));
    assert.ok(content.includes("\\@everyone \\<\\@1337\\>"), `escaped visibly: ${content}`);
  });

  it("ban-record metadata (moderator id, automod case id, warning/staff-note bodies) NEVER rides user-side", async () => {
    // §6 privacy is structural: ferry does not read the ban record. The duck
    // carries the metadata the 07 resolver may have hung next to the row —
    // none of it may leak into anything the banned user can see.
    const SECRET_MOD = "777000111222333444";
    const SECRET_CASE = "automod-case-9";
    const SECRET_WARN = "SECRET-WARNING-BODY";
    const SECRET_NOTE = "SECRET-NOTE-BODY";
    const row = appeal({
      moderator_id: SECRET_MOD,
      case_id: SECRET_CASE,
      warning_body: SECRET_WARN,
      staff_note: SECRET_NOTE,
    });
    const w = makeWorld();
    await relayTicketToUser({
      appeal: row,
      message: ticketMsg(nid(), { content: "we reviewed your case" }),
      deps: w.deps(),
      userId: USER,
    });
    await relayUserToTicket({
      appeal: row,
      message: dmMsg(nid(), { content: "thank you" }),
      deps: w.deps(),
    });
    for (const call of [...dms(w), ...sends(w)]) {
      const json = JSON.stringify(call.payload);
      for (const secret of [SECRET_MOD, SECRET_CASE, SECRET_WARN, SECRET_NOTE]) {
        assert.ok(!json.includes(secret), `${secret} leaked into a relay payload`);
      }
    }
  });

  it("long bodies chunk under RELAY_CHUNK_CHARS: header rides part 1 only, files stay adjacent, text reassembles lossless", async () => {
    const w = makeWorld();
    const message = dmMsg(nid(), {
      content: "x".repeat(internals.RELAY_CHUNK_CHARS + 1200),
      attachments: [imgAtt()],
    });
    const header = internals.signatureFor("user", message);
    const res = await relayUserToTicket({ appeal: appeal(), message, deps: w.deps() });
    assert.equal(res.relayed, true);
    const posts = sends(w);
    assert.ok(posts.length >= 2, "a long relay ships multiple parts");
    assert.ok(posts[0].payload.content.startsWith(`${header} `), "part 1 carries the signature");
    for (const p of posts.slice(1)) {
      assert.ok(!p.payload.content.includes("**"), "later parts carry no signature");
      assert.ok(!("files" in p.payload), "files ride the FIRST payload only");
    }
    const body =
      posts[0].payload.content.slice(header.length + 1) +
      posts
        .slice(1)
        .map((p) => p.payload.content)
        .join("");
    assert.equal(body, message.content, "no bytes lost between the parts");
    for (const p of posts) assert.deepEqual(p.payload.allowedMentions, { parse: [] });
  });

  it("staff content with an embed carries the TEXT only — embeds never enter the relay", async () => {
    const w = makeWorld();
    await relayTicketToUser({
      appeal: appeal(),
      message: ticketMsg(nid(), { content: "read the header above", embeds: [{ description: "HEADER CARD" }] }),
      deps: w.deps(),
      userId: USER,
    });
    const payload = dms(w)[0].payload;
    assert.ok(payload.content.includes("read the header above"));
    assert.ok(!("embeds" in payload), "the embed never rides (header/card law)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Loop-proofing (belts #1 + #2)
// ════════════════════════════════════════════════════════════════════════════

describe("loop-proofing: bots, webhooks, self, and echoes never ferry", () => {
  const loopCases = [
    ["bot-authored message", () => ({ author: { id: "8001", username: "otherbot", bot: true } })],
    ["webhook (raw API shape)", () => ({ webhook_id: "6001" })],
    ["webhook (camel shape)", () => ({ webhookId: "6002" })],
    ["the bot's own id as author", () => ({ author: { id: BOT, username: "self" } })],
    ["author-less message (no authorship may be claimed)", () => ({ author: null })],
  ];
  for (const [label, extra] of loopCases) {
    it(`loop[${label}] user→ticket: silent skip, zero sends, cursor held`, async () => {
      const w = makeWorld();
      const res = await relayUserToTicket({
        appeal: appeal(),
        message: dmMsg(nid(), extra()),
        deps: w.deps(),
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.skipped, "loop_proof");
      assert.equal(w.calls.length, 0);
    });
    it(`loop[${label}] ticket→user (the header/card embed belt): silent skip, zero sends`, async () => {
      const w = makeWorld();
      const res = await relayTicketToUser({
        appeal: appeal(),
        message: ticketMsg(nid(), { author: { id: BOT, bot: true }, content: "APPEAL HEADER CARD" }),
        deps: w.deps(),
        userId: USER,
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.skipped, "loop_proof");
      assert.equal(w.calls.length, 0, "the appeal header card can never ferry into the DM");
    });
  }

  it("belt #2 (relayed-id guard) fires INDEPENDENTLY of the author check", async () => {
    const w = makeWorld();
    // First relay: the engine records its own outbound ids in the injected guard.
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg("5444", { content: "echo me" }),
      deps: w.deps(),
    });
    assert.equal(res.relayed, true);
    const sentId = res.sentIds[0];
    assert.ok(w.ids.has(sentId), "outbound ids enter the echo guard");

    // Discord re-delivers the relay (raw event) with a NON-bot author shape
    // (worst case): the id guard alone must stop the loop.
    const again = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(sentId, { content: "echo me" }),
      deps: w.deps(),
    });
    assert.equal(again.relayed, false);
    assert.equal(again.skipped, "relay_echo");
    assert.equal(sends(w).length, 1, "the echo produced NO second relay");
  });

  it("noteRelayedMessageId seeds the guard for out-of-band relays and is a bounded FIFO", () => {
    const w = makeWorld();
    noteRelayedMessageId("5555", w.ids, w.order);
    const msg = dmMsg("5555");
    // Belt exercised through the engine path:
    return relayUserToTicket({ appeal: appeal(), message: msg, deps: w.deps() }).then((res) => {
      assert.equal(res.skipped, "relay_echo");
      assert.equal(w.calls.length, 0);

      const guard = new Set();
      const order = [];
      for (let i = 0; i < internals.RELAYED_ID_GUARD_MAX + 5; i += 1) {
        noteRelayedMessageId(`9${i}`, guard, order);
      }
      assert.equal(guard.size, internals.RELAYED_ID_GUARD_MAX, "the guard stays bounded");
      assert.equal(order.length, internals.RELAYED_ID_GUARD_MAX);
      assert.ok(!guard.has("90"), "the oldest id was evicted (FIFO)");
      assert.ok(guard.has(`9${internals.RELAYED_ID_GUARD_MAX + 4}`), "the newest id is held");
    });
  });

  it("isLoopAuthored (exported belt) answers the pure author law", () => {
    assert.equal(isLoopAuthored({ author: { id: "1", bot: true } }, null), true);
    assert.equal(isLoopAuthored({ author: { id: "1" }, webhook_id: "9" }, null), true);
    assert.equal(isLoopAuthored({ author: { id: "9" } }, "9"), true, "self id");
    assert.equal(isLoopAuthored({}, null), true, "absent author never relays");
    assert.equal(isLoopAuthored({ author: { id: "1" } }, "9"), false);
  });

  it("a message whose author carries NO id refuses to sign the relay (never misattributed)", async () => {
    const w = makeWorld();
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid(), { author: {} }),
      deps: w.deps(),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /needs an author id/);
    assert.equal(w.calls.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Flood caps (constants.js law; user side only; sender-specific notices)
// ════════════════════════════════════════════════════════════════════════════

describe("flood caps: cooldown + hourly ceiling, per sender, silent to staff", () => {
  it("cooldown drop: specific notice to the sender naming the cadence; ticket silent; cursor held; later message relays", async () => {
    const w = makeWorld();
    const first = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    assert.equal(first.relayed, true);

    w.nowMs = T0 + 1_000; // mid-cooldown
    const second = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    assert.equal(second.ok, true);
    assert.equal(second.skipped, "flood_cooldown");
    assert.equal(second.refusalSent, true);
    const notes = dms(w).filter((c) => c.payload.content.includes("**Ferry cooldown:**"));
    assert.equal(notes.length, 1, "the SENDER is told the drop specifically");
    assert.equal(
      notes[0].payload.content,
      FERRY_COPY.floodCooldown(FERRY_USER_COOLDOWN_MS - 1_000),
      "exact cooldown copy built from the constants (no invented numbers)",
    );
    assert.equal(sends(w).length, 1, "the staff side sees NOTHING of the flood drop");
    assert.equal(cursorSaves(w).length, 1, "only the relayed message moved the cursor");

    w.nowMs = T0 + FERRY_USER_COOLDOWN_MS;
    const third = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    assert.equal(third.relayed, true, "spacing elapsed → the next message relays");
  });

  it("the cooldown notice itself is throttled — a paste wall cannot storm it", async () => {
    const w = makeWorld();
    await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    w.nowMs = T0 + 1_000;
    const a = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    w.nowMs = T0 + 2_000;
    const b = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    assert.equal(a.skipped, "flood_cooldown");
    assert.equal(a.refusalSent, true, "first drop notices");
    assert.equal(b.skipped, "flood_cooldown");
    assert.equal(b.refusalSent, false, "second drop inside the notice window stays quiet to ALL sides");
    assert.equal(dms(w).length, 1, "exactly one notice across both drops");
  });

  it("hourly-cap drop: specific notice naming the cap; ticket silent; cursor held", async () => {
    const w = makeWorld();
    // Pre-fill the ledger the way FERRY_USER_HOURLY_CAP shipped relays would:
    // last send OUTSIDE the cooldown (so the cooldown gate passes first),
    // the whole hour window spent.
    w.ledger.set(String(appeal().id), {
      lastSentAt: w.nowMs - FERRY_USER_COOLDOWN_MS - 1,
      sentTimes: Array.from({ length: FERRY_USER_HOURLY_CAP }, (_, i) => w.nowMs - 60_000 - i * 1_000),
      lastNoticeAt: null,
    });
    const res = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    assert.equal(res.skipped, "flood_hourly");
    assert.equal(res.refusalSent, true);
    const notes = dms(w);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].payload.content, FERRY_COPY.floodHourly(), "exact hourly copy names the cap from constants.js");
    assert.ok(notes[0].payload.content.includes(String(FERRY_USER_HOURLY_CAP)));
    assert.equal(sends(w).length, 0, "staff never learn about the flood drop");
    assert.equal(cursorSaves(w).length, 0);
  });

  it("the hourly window ROLLS: spent sentTimes older than an hour no longer count", async () => {
    const w = makeWorld();
    w.ledger.set(String(appeal().id), {
      lastSentAt: w.nowMs - FERRY_USER_COOLDOWN_MS - 1,
      sentTimes: Array.from({ length: FERRY_USER_HOURLY_CAP }, (_, i) =>
        w.nowMs - internals.HOURLY_MS - 60_000 - i * 1_000,
      ),
      lastNoticeAt: null,
    });
    const res = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    assert.equal(res.relayed, true, "history beyond the rolling hour expired out of the ledger");
    const entry = w.ledger.get("701");
    assert.equal(entry.lastSentAt, w.nowMs, "the flood window advances ONLY on a shipped relay");
    assert.equal(entry.sentTimes.length, 1, "stale timestamps were pruned on the way through");
  });

  it("flood state is per SENDER (per appeal): one flooded appeal cannot mute another", async () => {
    const w = makeWorld();
    await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    const dropped = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    assert.equal(dropped.skipped, "flood_cooldown", "same appeal, same instant → cooldown drop");

    const other = appeal({ id: 702 });
    const relayed = await relayUserToTicket({ appeal: other, message: dmMsg(nid()), deps: w.deps() });
    assert.equal(relayed.relayed, true, "a different sender's ledger key is untouched");
    assert.equal(sends(w).length, 2, "only the two REAL relays reached the ticket");
  });

  it("the staff side runs NO second ledger: rapid ticket→user relays all ship at one instant", async () => {
    const w = makeWorld();
    for (let i = 0; i < FERRY_USER_HOURLY_CAP + 5; i += 1) {
      const res = await relayTicketToUser({
        appeal: appeal(),
        message: ticketMsg(nid(), { content: `update ${i}` }),
        deps: w.deps(),
        userId: USER,
      });
      assert.equal(res.relayed, true, `staff message ${i} never meets a flood gate`);
    }
    assert.equal(w.ledger.size, 0, "no second ledger exists on the ticket side (channel cooldowns own it)");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Attachment re-host: the 8 MiB law, partial failure, file caps
// ════════════════════════════════════════════════════════════════════════════

describe("re-upload: declared-size 8 MiB law refuses by NAME without ever downloading", () => {
  it("attachment-only over-cap message: refusal names size AND cap, fetch NEVER runs, nothing ships ticket-side, cursor held", async () => {
    const w = makeWorld();
    const declared = FERRY_ATTACHMENT_MAX_BYTES + 1024 * 1024; // 9 MiB
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid(), {
        content: "",
        attachments: [att("evidence.mp4", { size: declared })],
      }),
      deps: w.deps(),
    });
    assert.equal(res.ok, false, "an attachment-only message that cannot travel is a named failure");
    assert.match(res.error, /every relayed attachment failed to re-host/);
    assert.equal(w.fetchCalls.length, 0, "THE FETCH NEVER RAN — the declared-size pre-skip is the 8 MiB download law");
    assert.equal(sends(w).length, 0, "nothing shipped on the ticket side");
    const notes = dms(w);
    assert.equal(notes.length, 1);
    assert.equal(
      notes[0].payload.content,
      FERRY_COPY.attachmentTooLarge("evidence.mp4", declared),
      "the refusal is the exact size-and-cap sentence",
    );
    assert.ok(notes[0].payload.content.includes("9 MiB"), "the declared size is named");
    assert.ok(
      notes[0].payload.content.includes(`${Math.round(FERRY_ATTACHMENT_MAX_BYTES / (1024 * 1024))} MiB`),
      "the cap is named",
    );
    assert.equal(cursorSaves(w).length, 0, "the cursor holds — a boot catch-up can retry the relay");
  });

  it("mixed text + small image + over-cap image: what fits ships, the over-cap file is refused BY NAME, only the fitting file downloads", async () => {
    const w = makeWorld();
    const declared = FERRY_ATTACHMENT_MAX_BYTES + 1024 * 1024;
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid(), {
        content: "proof attached",
        attachments: [imgAtt("small.png"), att("big.png", { size: declared })],
      }),
      deps: w.deps(),
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.relayed, true, "the message is not held hostage by its oversized part");
    assert.equal(w.fetchCalls.length, 1, "the over-cap file was never downloaded (spy proof)");
    assert.equal(w.fetchCalls[0], "https://cdn.example.com/small.png");
    const posts = sends(w);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].payload.files.length, 1);
    assert.equal(posts[0].payload.files[0].name, "small.png");
    const notes = dms(w);
    assert.equal(notes.length, 1, "the sender learns exactly what did not travel");
    assert.ok(notes[0].payload.content.includes("`big.png`"), "the refusal names the file");
    assert.ok(notes[0].payload.content.includes("9 MiB"));
    assert.equal(cursorSaves(w).length, 1, "the relayed message advanced the cursor");
  });

  it("per-file FETCH failure: the specific downloadGuarded reason rides the notice; the rest of the message travels", async () => {
    const w = makeWorld();
    w.fetchStatus = 404;
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid(), {
        content: "photo of the log",
        attachments: [imgAtt()],
      }),
      deps: w.deps(),
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.relayed, true, "the text still relays — partial failure ships what survived");
    const posts = sends(w);
    assert.ok(!("files" in posts[0].payload), "the failed file never rides a payload");
    const notes = dms(w);
    assert.equal(notes.length, 1);
    assert.ok(notes[0].payload.content.includes("`photo.png`"), "the refusal names the file");
    assert.ok(notes[0].payload.content.includes("HTTP 404"), "the specific download cause rides the notice");
    assert.ok(!/unknown error/i.test(notes[0].payload.content), "no generic error string reaches the user");
  });

  it("an exploding fetchImpl never throws: the cause rides the notice, the relay continues", async () => {
    const w = makeWorld();
    w.fetchThrows = new Error("socket exploded mid-tls");
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid(), { content: "still relays", attachments: [imgAtt()] }),
      deps: w.deps(),
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.relayed, true);
    assert.ok(dms(w)[0].payload.content.includes("socket exploded mid-tls"), "cause surfaced specifically");
  });

  it("Discord's 10-file platform cap: the 11th attachment is refused with the exact count; names dedupe collision-free", async () => {
    const w = makeWorld();
    const eleven = Array.from({ length: 11 }, () => imgAtt("photo.png"));
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid(), { content: "wall of photos", attachments: eleven }),
      deps: w.deps(),
    });
    assert.equal(res.relayed, true);
    const posts = sends(w);
    assert.equal(posts[0].payload.files.length, internals.RELAY_MAX_FILES);
    assert.equal(w.fetchCalls.length, internals.RELAY_MAX_FILES, "the overflow file was never fetched either");
    assert.equal(
      posts[0].payload.files[1].name,
      "photo-2.png",
      "identical names collide-proof (uniqueRelayName law)",
    );
    const notes = dms(w);
    assert.equal(
      notes[0].payload.content,
      FERRY_COPY.attachmentFileCap(eleven.length - internals.RELAY_MAX_FILES),
      "the file-cap notice states the exact platform limit",
    );
    assert.ok(notes[0].payload.content.includes(String(internals.RELAY_MAX_FILES)));
  });

  it("MIXED PARTIAL LAW (audio dropped from a relay row): the sender learns the audio part by name", async () => {
    // §3 law (ferry.js header lines 34/494: "the text/allowed media still
    // travels; THE SENDER LEARNS EXACTLY WHAT DID NOT"). Classification hands
    // the engine cls.refusal for exactly this (§3 matrix test above proves it).
    // KNOWN GAP at writing time: relayMessageCore seeds `notices` only from
    // rehostAttachments — the relay path never delivers the classification drop
    // notice, so today this test is the RED evidence pin for the src fix
    // (deliver cls.refusal alongside the re-host notices on relay rows).
    const w = makeWorld();
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid(), {
        content: "look at both",
        attachments: [imgAtt(), audioAtt()],
      }),
      deps: w.deps(),
    });
    assert.equal(res.relayed, true, "the text + image travel regardless");
    const posts = sends(w);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].payload.files.length, 1, "the image traveled");
    const notes = dms(w);
    assert.equal(notes.length, 1, "the sender is told the audio part was not shared");
    assert.equal(notes[0].payload.content, FERRY_COPY.audio, "the notice is the exact audio sentence");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Cursor law (fake repo; the real save/load pair law rides section 9)
// ════════════════════════════════════════════════════════════════════════════

describe("cursor law: the pair advances ONLY on a successful send", () => {
  it("multi-part relay whose PART 2 fails: cursor held (resume-skip law), sent part echo-guarded, nothing is silently skipped", async () => {
    const w = makeWorld();
    w.channelResult = [
      { ok: true }, // chunk 1 ships (auto id)
      { ok: false, error: "discord said no" }, // chunk 2 fails
    ];
    const message = dmMsg("5777", { content: "y".repeat(internals.RELAY_CHUNK_CHARS + 500) });
    const res = await relayUserToTicket({ appeal: appeal(), message, deps: w.deps() });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.equal(res.relayed, false);
    assert.equal(res.sentParts, 1);
    assert.match(res.error, /relay send failed on part 2\//);
    assert.match(res.error, /discord said no/, "the specific cause rides the error");
    assert.deepEqual([...w.cursors.keys()], [], "THE CURSOR HELD — the whole message replays after a restart");
    assert.equal(w.ids.size, 1, "the half-sent part was echo-guarded (it exists on Discord)");
  });

  it("a THROWING cursor save never un-sends the relay: ok:true + specific cursorError", async () => {
    const w = makeWorld();
    w.saveCursorThrows = new Error("SQLITE_BUSY: database is locked");
    const res = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    assert.equal(res.ok, true, "the send DID happen — a cursor failure degrades, never claims a miss");
    assert.equal(res.relayed, true);
    assert.equal(res.cursorSaved, false);
    assert.match(res.cursorError, /the cursor did not save/);
    assert.match(res.cursorError, /SQLITE_BUSY/, "the specific cursor cause is reported");
  });

  it("a relayed message without an id degrades to a named cursorError (restart may replay it)", async () => {
    const w = makeWorld();
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(undefined, { content: "id-less duck" }),
      deps: w.deps(),
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.relayed, true);
    assert.equal(res.cursorSaved, false);
    assert.match(res.cursorError, /carried no id/);
    assert.deepEqual([...w.cursors.keys()], []);
  });

  it("the saved pair mirrors the message: id + its created_at through ONE save", async () => {
    const w = makeWorld();
    const message = dmMsg("5888", { content: "pair me", timestamp: T0 + 4_567 });
    await relayUserToTicket({ appeal: appeal(), message, deps: w.deps() });
    assert.deepEqual(cursorSaves(w), [
      {
        op: "saveCursor",
        appealId: 701,
        direction: "user",
        messageId: "5888",
        timestampMs: T0 + 4_567,
      },
    ]);
    assert.deepEqual(w.cursors.get("701:user"), { messageId: "5888", timestampMs: T0 + 4_567 });
  });

  it("the two directions keep INDEPENDENT cursors", async () => {
    const w = makeWorld();
    await relayUserToTicket({ appeal: appeal(), message: dmMsg("5901"), deps: w.deps() });
    await relayTicketToUser({ appeal: appeal(), message: ticketMsg("5902"), deps: w.deps(), userId: USER });
    assert.deepEqual(w.cursors.get("701:user"), { messageId: "5901", timestampMs: T0 });
    assert.deepEqual(w.cursors.get("701:ticket"), { messageId: "5902", timestampMs: T0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Boot catch-up: strict after-cursor, created_at→id order, bound, stop-at-first-failure
// ════════════════════════════════════════════════════════════════════════════

describe("catch-up: strict after-cursor replay, created_at-then-id order, bound, truthful stop", () => {
  it("nothing before/equal the (id, ts) pair replays; ts dominates id both ways", async () => {
    const w = makeWorld();
    w.cursors.set("701:user", { messageId: "100", timestampMs: 5_000 });
    const list = [
      dmMsg("100", { timestamp: 5_000, content: "AT the cursor — never again" }),
      dmMsg("099", { timestamp: 5_000, content: "same ts, earlier id — never" }),
      dmMsg("101", { timestamp: 4_999, content: "earlier ts, later id — never (ts dominates)" }),
      dmMsg("101", { timestamp: 5_000, content: "same ts, later id — AFTER the pair" }),
      dmMsg("099b", { timestamp: 5_001, content: "later ts wins over its small id" }),
    ];
    const f = w.fetcher(list);
    const res = await catchUpOnBoot({ appeal: appeal(), direction: "user", messagesFetcher: f.fn, deps: w.deps() });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.relayed, 2, "exactly the two STRICTLY-after messages");
    const bodies = sends(w).map((c) => c.payload.content);
    assert.ok(bodies.every((b) => !b.includes("never")), `nothing at/before the cursor replayed: ${bodies}`);
    assert.ok(bodies.some((b) => b.includes("AFTER the pair")));
    assert.ok(bodies.some((b) => b.includes("later ts wins")));
    assert.deepEqual(w.fetcherSeen, {
      limit: Math.min(100, FERRY_CATCHUP_MAX * 2),
      after: "100",
      direction: "user",
    }, "the persisted cursor id is handed to the history fetcher");
  });

  it("replay order is created_at THEN id — id monotonicity is NOT assumed", async () => {
    const w = makeWorld();
    const m1 = dmMsg("600", { timestamp: T0 + 100, content: "oldest-by-ts" });
    const m2 = dmMsg("500", { timestamp: T0 + 200, content: "middle" });
    const m3 = dmMsg("450", { timestamp: T0 + 300, content: "newest-by-ts-smallest-id" });
    const f = w.fetcher([m3, m2, m1]); // newest-first, ids non-monotone with time
    const res = await catchUpOnBoot({ appeal: appeal(), direction: "user", messagesFetcher: f.fn, deps: w.deps() });
    assert.equal(res.ok, true, JSON.stringify(res));
    const bodies = sends(w).map((c) => c.payload.content);
    assert.deepEqual(
      [bodies[0].includes("oldest-by-ts"), bodies[1].includes("middle"), bodies[2].includes("newest-by-ts")],
      [true, true, true],
      `strict created_at-then-id order: ${bodies}`,
    );
    assert.deepEqual(w.cursors.get("701:user"), { messageId: "450", timestampMs: T0 + 300 });
  });

  it("the bound is FERRY_CATCHUP_MAX: history beyond it is counted, never claimed or relayed", async () => {
    const w = makeWorld();
    const list = Array.from({ length: FERRY_CATCHUP_MAX + 5 }, (_, i) =>
      dmMsg(String(7000 + i), { timestamp: T0 + i, content: `flood history ${i}` }),
    );
    const f = w.fetcher(list);
    const logged = [];
    const origLog = console.log;
    console.log = (...a) => logged.push(a.map(String).join(" "));
    let res;
    try {
      res = await catchUpOnBoot({ appeal: appeal(), direction: "user", messagesFetcher: f.fn, deps: w.deps() });
    } finally {
      console.log = origLog;
    }
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.relayed, FERRY_CATCHUP_MAX, "the engine-law bound caps one boot");
    assert.equal(res.unprocessed, 5, "the overflow is reported, never silently dropped");
    assert.equal(sends(w).length, FERRY_CATCHUP_MAX);
    assert.ok(
      logged.some((l) => l.includes("bound reached") && l.includes("unprocessed=5")),
      "the bound is logged so a partial catch-up is never claimed as complete",
    );
    // The cursor truthfully stopped at the LAST relayed message.
    assert.deepEqual(w.cursors.get("701:user"), {
      messageId: String(7000 + FERRY_CATCHUP_MAX - 1),
      timestampMs: T0 + FERRY_CATCHUP_MAX - 1,
    });
  });

  it("a single failure STOPS the catch-up there: stoppedAt + relayed + unprocessed reported, no skip-ahead", async () => {
    const w = makeWorld();
    const a = dmMsg("8001", { timestamp: T0 + 1, content: "ships" });
    const b = dmMsg("8002", { timestamp: T0 + 2, content: "fails" });
    const c = dmMsg("8003", { timestamp: T0 + 3, content: "never reached" });
    w.channelResult = [{ ok: true }, { ok: false, error: "channel gone" }];
    const f = w.fetcher([c, b, a]);
    const res = await catchUpOnBoot({ appeal: appeal(), direction: "user", messagesFetcher: f.fn, deps: w.deps() });
    assert.equal(res.ok, false);
    assert.equal(res.relayed, 1);
    assert.equal(res.stoppedAt, "8002", "the failure point is named");
    assert.equal(res.unprocessed, 2, "failed + never-reached counted honestly");
    assert.match(res.error, /catch-up stopped at message 8002/);
    assert.match(res.error, /channel gone/, "the specific cause rides the report");
    assert.equal(sends(w).length, 2, "message c was NEVER attempted (stop-at-first-failure, no skip-ahead)");
    assert.ok(!sends(w).some((s2) => s2.payload.content.includes("never reached")));
    assert.deepEqual(w.cursors.get("701:user"), { messageId: "8001", timestampMs: T0 + 1 });
  });

  it("failed live sends RETRY on the next catch-up (cursor held the message)", async () => {
    const w = makeWorld();
    const m = dmMsg("8100", { timestamp: T0 + 1, content: "retry me" });
    w.channelResult = { ok: false, error: "transient down" };
    const live = await relayUserToTicket({ appeal: appeal(), message: m, deps: w.deps() });
    assert.equal(live.ok, false);
    assert.deepEqual([...w.cursors.keys()], [], "the cursor held through the send failure");

    w.channelResult = { ok: true }; // Discord recovered before the next boot
    const f = w.fetcher([m]);
    const res = await catchUpOnBoot({ appeal: appeal(), direction: "user", messagesFetcher: f.fn, deps: w.deps() });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.relayed, 1, "the half-lost relay replayed — never silently skipped");
    assert.equal(sends(w).length, 2, "the failed live attempt + the boot replay both shipped to the ticket");
    assert.ok(sends(w)[1].payload.content.includes("retry me"), "the replayed payload is the held message");
  });

  it("catch-up relaxes the flood gate (bounded HISTORY replay) without storming the notice path", async () => {
    const w = makeWorld();
    w.ledger.set("701", {
      lastSentAt: w.nowMs,
      sentTimes: Array.from({ length: FERRY_USER_HOURLY_CAP }, (_, i) => w.nowMs - i * 1_000),
      lastNoticeAt: null,
    });
    const list = [dmMsg("8201", { timestamp: T0 + 1 }), dmMsg("8202", { timestamp: T0 + 2 })];
    const f = w.fetcher(list);
    const res = await catchUpOnBoot({ appeal: appeal(), direction: "user", messagesFetcher: f.fn, deps: w.deps() });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.relayed, 2, "history replay is not flood-gated (the bound is its cap)");
    assert.equal(dms(w).length, 0, "no flood notices during replay");
  });

  it("catch-up guards: unknown direction, missing fetcher, structural skips stay silent, cursor read failure is specific", async () => {
    const w = makeWorld();
    const noDir = await catchUpOnBoot({
      appeal: appeal(),
      direction: "sideways",
      messagesFetcher: async () => [],
      deps: w.deps(),
    });
    assert.equal(noDir.ok, false);
    assert.match(noDir.error, /unknown ferry direction `sideways`/);

    const noFetcher = await catchUpOnBoot({ appeal: appeal(), direction: "user", deps: w.deps() });
    assert.equal(noFetcher.ok, false);
    assert.match(noFetcher.error, /needs a messagesFetcher/);

    let fetched = 0;
    const counting = async () => {
      fetched += 1;
      return [];
    };
    const paused = await catchUpOnBoot({
      appeal: appeal({ ferry_paused: 1 }),
      direction: "user",
      messagesFetcher: counting,
      deps: w.deps(),
    });
    assert.deepEqual(paused, { ok: true, relayed: 0, skipped: "paused", direction: "user" });

    const filed = await catchUpOnBoot({
      appeal: appeal({ status: "filed" }),
      direction: "ticket",
      messagesFetcher: counting,
      deps: w.deps(),
    });
    assert.equal(filed.skipped, "status_filed");
    assert.equal(fetched, 0, "a structurally skipped appeal never reads history");

    w.loadCursorOverride = { ok: false, error: "table vanished" };
    const broken = await catchUpOnBoot({
      appeal: appeal(),
      direction: "user",
      messagesFetcher: counting,
      deps: w.deps(),
    });
    assert.equal(broken.ok, false);
    assert.match(broken.error, /could not read the user ferry cursor/);
    assert.match(broken.error, /table vanished/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Structural guards + the never-throws belt
// ════════════════════════════════════════════════════════════════════════════

describe("guards: paused / non-open / unwired seams / add-only surface", () => {
  it("a paused ferry is SILENT in BOTH directions (zero sends, cursor untouched)", async () => {
    const row = appeal({ ferry_paused: 1 });
    const w = makeWorld();
    const u = await relayUserToTicket({ appeal: row, message: dmMsg(nid()), deps: w.deps() });
    const t = await relayTicketToUser({ appeal: row, message: ticketMsg(nid()), deps: w.deps(), userId: USER });
    assert.equal(u.skipped, "paused");
    assert.equal(t.skipped, "paused");
    assert.equal(w.calls.length, 0, "pause silences notices AND relays both ways");
  });

  for (const status of ["filed", "granted", "denied", "closed"]) {
    it(`non-open status ${status}: silent both ways, skipped status_${status}, zero sends`, async () => {
      const row = appeal({ status });
      const w = makeWorld();
      const u = await relayUserToTicket({ appeal: row, message: dmMsg(nid()), deps: w.deps() });
      const t = await relayTicketToUser({ appeal: row, message: ticketMsg(nid()), deps: w.deps(), userId: USER });
      assert.deepEqual(u, { ok: true, relayed: false, skipped: `status_${status}`, direction: "user" });
      assert.deepEqual(t, { ok: true, relayed: false, skipped: `status_${status}`, direction: "ticket" });
      assert.equal(w.calls.length, 0);
    });
  }

  it("open appeal without a ticket channel: specific error, nothing sent", async () => {
    const w = makeWorld();
    const res = await relayUserToTicket({
      appeal: appeal({ ticket_channel_id: null }),
      message: dmMsg(nid()),
      deps: w.deps(),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /carries no ticket channel/);
    assert.equal(w.calls.length, 0);
  });

  it("unwired send seams produce the specific wiring error (07's contract), never a throw", async () => {
    const w = makeWorld();
    const noChan = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid()),
      deps: w.deps({ sendChannel: undefined }),
    });
    assert.equal(noChan.ok, false);
    assert.match(noChan.error, /needs deps\.sendChannel/);

    const noDm = await relayTicketToUser({
      appeal: appeal(),
      message: ticketMsg(nid()),
      deps: w.deps({ sendDm: undefined }),
      userId: USER,
    });
    assert.equal(noDm.ok, false);
    assert.match(noDm.error, /needs deps\.sendDm/);

    const noUser = await relayTicketToUser({
      appeal: appeal({ user_id: null, ban_user_id: null }), // no carrier at all
      message: ticketMsg(nid()),
      deps: w.deps(),
    });
    assert.equal(noUser.ok, false);
    assert.match(noUser.error, /needs deps\.sendDm and the appeal's user id/);
    assert.equal(sends(w).length, 0);
    assert.equal(dms(w).length, 0);
  });

  it("never-throws belt: exploding sendChannel answers {ok:false} with the thrown cause", async () => {
    const w = makeWorld();
    w.channelThrows = new Error("discord.js exploded");
    const res = await relayUserToTicket({ appeal: appeal(), message: dmMsg(nid()), deps: w.deps() });
    assert.equal(res.ok, false);
    assert.match(res.error, /relay send failed on part 1\/1/);
    assert.match(res.error, /discord\.js exploded/);
  });

  it("never-throws belt: an exploding notice seam degrades the NOTICE only (the drop already happened)", async () => {
    const w = makeWorld();
    w.dmThrows = new Error("DM closed");
    const res = await relayUserToTicket({
      appeal: appeal(),
      message: dmMsg(nid(), { content: "", stickers: [{ id: "s1" }] }),
      deps: w.deps(),
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.skipped, "sticker");
    assert.equal(res.refusalSent, false, "the undeliverable notice is honestly reported, not fatal");
  });

  it("never-throws belt: a throwing repo cursor READ inside catch-up is caught with the cause", async () => {
    const w = makeWorld();
    const angryRepo = {
      loadAppealCursor() {
        throw new Error("db exploded on read");
      },
    };
    const res = await catchUpOnBoot({
      appeal: appeal(),
      direction: "user",
      messagesFetcher: async () => [],
      deps: w.deps({ repo: angryRepo }),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /db exploded on read/, "the cause rides the {ok:false}");
  });

  it("entry points survive garbage input (appeal-less calls never throw)", async () => {
    const noRow = await relayUserToTicket();
    assert.equal(noRow.ok, false);
    assert.match(noRow.error, /needs the appeal row/);

    const noRow2 = await relayTicketToUser({ message: dmMsg(nid()) });
    assert.equal(noRow2.ok, false);

    const bare = await catchUpOnBoot();
    assert.equal(bare.ok, false);
    assert.match(bare.error, /unknown ferry direction/);
  });

  it("add-only law: the engine exposes NO update/delete/reaction entry point at all", () => {
    const names = [...Object.keys(ferry), ...Object.keys(internals)];
    const offender = names.find((n) => /updat|delet|reaction/i.test(n));
    assert.equal(offender, undefined, `ferry must be add-only: found ${offender}`);
    // A reaction-shaped / edited-shaped event is NOT a plain message: silent.
    const reactionLike = classifyOutbound(
      { id: "9999", author: { id: USER }, type: 0, content: "", reactions: [{ emoji: "👍" }], editedTimestamp: T0 },
      { clientUserId: BOT },
    );
    assert.equal(reactionLike.relay, false);
    assert.equal(reactionLike.silent, true, "edits and reactions are simply not messages here");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. REAL DB cursor-pair law (the shipped saveAppealCursor/loadAppealCursor)
// ════════════════════════════════════════════════════════════════════════════

let realSeq = 0;
function seedOpenAppeal(channel) {
  const cid = communityKey(`9781000000000009${String(++realSeq).padStart(3, "0")}`);
  const rec = db.createBanRecord({
    communityId: cid,
    userId: USER,
    moderatorId: STAFF,
    source: "staff",
    reason: "raid",
    bannedAt: T0,
  });
  assert.equal(rec.ok, true, `ban seed failed: ${rec.error}`);
  const filed = db.fileAppeal({
    communityId: cid,
    banRecordId: rec.record.id,
    appealStatement: "I would like to appeal this ban",
    createdAt: T0,
  });
  assert.equal(filed.ok, true, `appeal seed failed: ${filed.error}`);
  const attached = db.attachAppealTicketChannel(filed.appeal.id, channel);
  assert.equal(attached.ok, true, attached.error);
  const opened = db.openAppeal(filed.appeal.id);
  assert.equal(opened.won, true, `open seed failed: ${opened.error}`);
  return opened.appeal;
}

describe("real repo cursor pair: the persisted (message id, created_at) resume law", () => {
  it("a successful relay persists BOTH cursor halves; loadAppealCursor reads the exact pair back", async () => {
    const row = seedOpenAppeal("770200000000000010");
    const w = makeWorld();
    const res = await relayUserToTicket({
      appeal: row,
      message: dmMsg("6101", { timestamp: T0 + 10_000 }),
      deps: w.deps({ repo: db }),
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.cursorSaved, true);

    const loaded = db.loadAppealCursor(row.id, "user");
    assert.equal(loaded.ok, true, loaded.error);
    assert.deepEqual(loaded.cursor, { messageId: "6101", timestampMs: T0 + 10_000 });
    const raw = db.getAppealById(row.id);
    assert.ok(raw.ferry_user_msg_id != null && raw.ferry_user_ts != null, "the PAIR persisted — never half of it");
    assert.equal(raw.ferry_ticket_msg_id, null, "the other direction is untouched");
  });

  it("a FAILED send holds the real cursor (pair stays NULL) and the next catch-up replays the message", async () => {
    const row = seedOpenAppeal("770200000000000011");
    const w = makeWorld();
    w.channelResult = { ok: false, error: "missing permissions" };
    const failed = await relayUserToTicket({
      appeal: row,
      message: dmMsg("6201", { timestamp: T0 + 1 }),
      deps: w.deps({ repo: db }),
    });
    assert.equal(failed.ok, false);
    assert.equal(db.loadAppealCursor(row.id, "user").cursor, null, "send failure holds the cursor at the DB law level");

    w.channelResult = { ok: true };
    const f = w.fetcher([dmMsg("6201", { timestamp: T0 + 1 })]);
    const res = await catchUpOnBoot({
      appeal: db.getAppealById(row.id),
      direction: "user",
      messagesFetcher: f.fn,
      deps: w.deps({ repo: db }),
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.relayed, 1, "the held message retried on the next boot");
    assert.deepEqual(db.loadAppealCursor(row.id, "user").cursor, {
      messageId: "6201",
      timestampMs: T0 + 1,
    });
  });

  it("a BLOCKED message never advances the real cursor (it was never relayed — nothing to resume past)", async () => {
    const row = seedOpenAppeal("770200000000000012");
    const w = makeWorld();
    const res = await relayUserToTicket({
      appeal: row,
      message: dmMsg("6301", { content: "", stickers: [{ id: "s1" }] }),
      deps: w.deps({ repo: db }),
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.skipped, "sticker");
    assert.equal(db.loadAppealCursor(row.id, "user").cursor, null);
  });
});

// MUST STAY LAST in this file (gork-budget §5 law): the literal-restart case
// calls resetSrcModules(), which wipes the src/ require cache mid-file — any
// test appended below would run against a torn-down module graph (fresh db
// connections, empty in-memory state). Each file is its own `node --test`
// process, so being last keeps the wipe contained. If this grows a sibling,
// move the reopen case to its own file instead of appending here.
describe("real repo cursor pair: a literal engine RESTART resumes with nothing replayed and nothing skipped", () => {
  it("relay on engine #1 → fresh require of ferry+db over the SAME SQLite file → catch-up replays zero, ships the gap", async () => {
    const row = seedOpenAppeal("770200000000000013");
    const w = makeWorld();

    // Engine instance #1 relays m1 (send ok → cursor pair persisted to SQLite).
    const m1 = dmMsg("7001", { timestamp: T0 + 1_000, content: "before the crash" });
    const first = await relayUserToTicket({ appeal: row, message: m1, deps: w.deps({ repo: db }) });
    assert.equal(first.relayed, true);
    assert.equal(first.cursorSaved, true);

    // Literal restart: drop every src/ module (fresh engine state, fresh db
    // connection) and re-open the SAME file.
    resetSrcModules();
    const freshDb = require("../src/db");
    const freshFerry = require("../src/features/banAppeals/ferry");
    try {
      // The cursor survived the process-level restart (it lives in SQLite).
      const carried = freshDb.loadAppealCursor(row.id, "user");
      assert.deepEqual(carried.cursor, { messageId: "7001", timestampMs: T0 + 1_000 });

      // The engine's OWN in-memory relay guard died with instance #1 — resume
      // is carried by the persisted pair alone. History holds the relayed m1
      // PLUS a missed m2 (newest-first, like discord.js fetches).
      const m2 = dmMsg("7002", { timestamp: T0 + 2_000, content: "sent while offline" });
      const w2 = makeWorld();
      const f = w2.fetcher([m2, m1]);
      const res = await freshFerry.catchUpOnBoot({
        appeal: freshDb.getAppealById(row.id),
        direction: "user",
        messagesFetcher: f.fn,
        deps: w2.deps({ repo: freshDb }),
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.relayed, 1, "nothing replayed: exactly the gap was shipped");
      assert.equal(sends(w2).length, 1, "m1 was NOT re-relayed");
      assert.ok(sends(w2)[0].payload.content.includes("sent while offline"), "nothing was skipped either");

      const after = freshDb.loadAppealCursor(row.id, "user");
      assert.deepEqual(after.cursor, { messageId: "7002", timestampMs: T0 + 2_000 });
    } finally {
      try {
        freshDb.db?.close();
      } catch {
        /* best effort */
      }
    }
  });
});
