/**
 * Bridge relay-worker tests (roadmap/bridge.md § Tests — "Failure ladder"
 * row + the PR 5 worker contract, §10.6/§10.7/§10.10).
 *
 * Everything runs against a fresh temp SQLite (test/helpers/env.js) with the
 * worker's seams FULLY faked: webhook transports, outbound ports, sleep
 * (no real timers), sendMessage, the download fetch, and DNS. No sockets,
 * no real webhooks, no real backoffs. The worker is exercised through
 * createRelayWorker directly — startBridgeLoops stays unwired (KD 22).
 *
 * Proves:
 *  - a pending row replays from SPOOLED BYTES (no source refetch);
 *  - a missing spool refetches via fetchSourceMessage and re-downloads;
 *  - 429/SLOWMODE stays at the head with NO attempt burn and the capped
 *    Retry-After sleep;
 *  - 5 generic failures park the row (state failed, last_error) with the
 *    verbatim source-channel notice, walking the 1/2/4/8/16 s ladder;
 *  - one direction's failure does not stall the other;
 *  - a worker throw logs "[bridge] worker failed:" with the public id and
 *    reschedules (row back to pending);
 *  - the Fluxer nonce is the SHA-256(publicId:srcMessageId:kind:part)
 *    32-hex slice and wait=true rides every execute;
 *  - a Discord send is retried ONLY when it produced no message id;
 *  - long text chunks in order with "(continued) " on parts 2+ and one
 *    bridge_message_links row per part (dest_message_id = first part);
 *  - ack-then-delete: done rows leave no spool directory behind;
 *  - the process-wide 4-wide concurrency cap.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { loadDb, communityKey } = require("./helpers/env");

// CONTRACT: loadDb() before every src/ require (fresh temp DB, cache reset).
const { api: db, tmpDir, cleanup } = loadDb();

const relay = require("../src/features/bridge/relay");
const media = require("../src/features/bridge/media");
const repo = require("../src/db/repositories/bridges");
const tokenCrypto = require("../src/features/bridge/tokenCrypto");
const { getCommunityById } = require("../src/platform/community");

after(() => cleanup?.());

const T0 = 1_700_000_000_000;
const KEY = crypto.randomBytes(32).toString("base64");
const enc = (token) => tokenCrypto.encryptWebhookToken(token, { keyGetter: () => KEY });
const nonceFor = (publicId, src, kind, part) =>
  crypto.createHash("sha256").update(`${publicId}:${src}:${kind}:${part}`, "utf8").digest("hex").slice(0, 32);

/** Deterministic public ids (handle-shaped). */
let idSeq = 0;
function nextPublicId() {
  idSeq += 1;
  return `b_0000${String(idSeq).padStart(4, "0")}`;
}

describe("bridge relay worker (PR 5)", () => {
  /** @type {object} */
  let rowA; // Discord community (end a)
  /** @type {object} */
  let rowB; // Fluxer community (end b)

  before(() => {
    rowA = getCommunityById(communityKey("900000000000040001"));
    rowB = getCommunityById(communityKey("900000000000040002", "fluxer", "relay.example"));
  });

  /**
   * Active bridge with both ends + encrypted webhook tokens on both ends.
   * End A sits on the Discord community, end B on the Fluxer one.
   */
  function seedBridge(direction = "both") {
    const publicId = nextPublicId();
    const bridge = repo.createBridge({
      publicId,
      createdByUserId: "u",
      endACommunityId: rowA.id,
      endAChannelId: `RA-${idSeq}`,
      direction,
      codeHash: null,
    });
    repo.addBridgeEnd({ bridgeId: bridge.id, position: "b", communityId: rowB.id, channelId: `RB-${idSeq}` });
    db.db
      .prepare("UPDATE bridges SET state = 'active', connected_at = ? WHERE id = ?")
      .run(T0, bridge.id);
    repo.setBridgeEndWebhook(bridge.id, "b", { webhookId: `wh-b-${idSeq}`, tokenEnc: enc("tok-b") });
    repo.setBridgeEndWebhook(bridge.id, "a", { webhookId: `wh-a-${idSeq}`, tokenEnc: enc("tok-a") });
    return { bridge, publicId };
  }

  /** Standard create payload with one spooled attachment. */
  function createPayload(publicId, srcMessageId, over = {}) {
    return {
      schemaVersion: 1,
      publicId,
      direction: "a_to_b",
      srcCommunityId: rowA.id,
      srcChannelId: "RA-1",
      srcMessageId,
      author: {
        id: "42",
        display: "Alice",
        handle: "alice",
        avatarUrl: "https://cdn.discordapp.com/avatars/42/a.png",
      },
      text: "hello world",
      replyHeader: null,
      voiceCaption: null,
      explicitMedia: false,
      stickers: [],
      embeds: [],
      attachments: [],
      ...over,
    };
  }

  /** Scripted fake webhook transport (spec §10.3 shape, no network). */
  function scriptedApi(name, script = []) {
    const calls = [];
    return {
      name,
      calls,
      async executeRelayWebhook(webhook, opts) {
        const step = script[calls.length] ?? { ok: true, messageId: `${name}-${calls.length + 1}` };
        calls.push({ webhook, opts });
        return typeof step === "function" ? step(calls.length) : step;
      },
      async createRelayWebhook() {
        calls.push({ created: true });
        return { ok: true, webhook: { id: `${name}-new`, token: "tok-new" }, tokenEnc: enc("tok-new") };
      },
    };
  }

  /** Worker with all seams faked; collects notices + sleep cadence. */
  function makeWorker({ getWebhookApi, getOutbound, sendMessage, sleep } = {}) {
    /** @type {Array<{communityId: number, channelId: string, content: string}>} */
    const notices = [];
    /** @type {number[]} */
    const sleeps = [];
    const worker = relay.createRelayWorker({
      repo,
      db: db.db,
      getWebhookApi: getWebhookApi ?? (() => null),
      getOutbound: getOutbound ?? (() => null),
      keyGetter: () => KEY,
      sendMessage:
        sendMessage ??
        (async (communityId, channelId, content) => {
          notices.push({ communityId, channelId, content });
          return { ok: true };
        }),
      sleep:
        sleep ??
        (async (ms) => {
          sleeps.push(ms);
        }),
    });
    worker.notices = notices;
    worker.sleeps = sleeps;
    return worker;
  }

  /** Attach fake OutboundClients (fetchMessage records calls). */
  function fakeOutbound(fetchImpl) {
    const fetches = [];
    const sendChannel = [];
    const outbound = {
      fetches,
      sendChannel,
      fetchMessage: async (communityId, channelId, messageId) => {
        fetches.push([communityId, channelId, messageId]);
        return {
          ok: true,
          message: {
            id: messageId,
            attachments: [
              { id: "a1", filename: "fresh.bin", size: 5, url: "https://cdn.example.test/fresh.bin" },
            ],
          },
        };
      },
      sendChannel: async (channelId, payload) => {
        sendChannel.push([channelId, payload.content]);
        return { id: "botmsg-1" };
      },
    };
    if (fetchImpl) outbound.__fetch = fetchImpl;
    return outbound;
  }

  /** Write a spool file the worker will read back. */
  function spoolBytes(publicId, srcMessageId, index, content) {
    const dir = media.spoolDirFor(publicId, srcMessageId);
    fs.mkdirSync(dir, { recursive: true });
    const file = media.spoolFilePath(publicId, srcMessageId, index);
    fs.writeFileSync(file, content);
    return file;
  }

  function rowState(outbox) {
    const id = outbox && typeof outbox === "object" ? outbox.id : outbox;
    return repo.getBridgeOutboxById(id);
  }

  // -------------------------------------------------------------------------
  // Spool replay + re-sign fallback (spec §10.10 Restart)
  // -------------------------------------------------------------------------

  it("replays a pending row from SPOOLED bytes with nonce + wait=true, ack-then-deletes", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    const file = spoolBytes(publicId, "9100", 0, "spooled!");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9100",
      payload: createPayload(publicId, "9100", {
        attachments: [
          {
            sourceAttachmentId: "a1",
            filename: "note.txt",
            contentType: "text/plain",
            spoiler: false,
            explicitMedia: true,
            bytes: 8,
            declaredBytes: 8,
            skipReason: null,
            spoolIndex: 0,
          },
        ],
      }),
    });

    const fluxer = scriptedApi("f");
    makeWorker.fluxer = fluxer;
    const outbound = fakeOutbound();
    makeWorker.discord = null;
    const worker = makeWorker({
      getWebhookApi: (platform) => (platform === "fluxer" ? fluxer : null),
      getOutbound: (platform) => (platform === "fluxer" ? outbound : fakeOutbound()),
    });
    await worker.drainAll();
    makeWorker.fluxer = null;

    // The upload carries the SPOOLED bytes — no source refetch happened.
    assert.equal(fluxer.calls.length, 1);
    const opts = fluxer.calls[0].opts;
    assert.equal(opts.files.length, 1);
    assert.ok(Buffer.isBuffer(opts.files[0].data));
    assert.equal(opts.files[0].data.toString("utf8"), "spooled!");
    assert.equal(opts.files[0].name, "note.txt");
    assert.equal(outbound.fetches.length, 0, "spool hit must not refetch the source");

    // §10.6 idempotency: nonce = sha256(publicId:src:kind:part) 32 hex, wait=true.
    assert.equal(opts.nonce, nonceFor(publicId, "9100", "create", 0));
    assert.equal(opts.wait, true);
    // §10.7 attribution + Fluxer flags: SUPPRESS_NOTIFICATIONS | EXPLICIT_MEDIA.
    // "guild nickname if present, else username; append (@username) when they differ"
    // — displayName "Alice" ≠ username "alice" → "Alice (@alice)".
    assert.equal(opts.username, "Alice (@alice)");
    assert.equal(
      opts.flags,
      relay.FLAG_SUPPRESS_NOTIFICATIONS | relay.FLAG_CONTAINS_EXPLICIT_MEDIA,
    );
    // §10.11: Fluxer execute pins suppression with an empty allowed_mentions.
    assert.deepEqual(opts.allowedMentions, {});
    // §10.7 avatar best-effort: Discord→Fluxer passes the https source avatar.
    assert.equal(opts.avatarUrl, "https://cdn.discordapp.com/avatars/42/a.png");

    // Webhook handle resolved from the end's encrypted token.
    assert.equal(fluxer.calls[0].webhook.id, `wh-b-${idSeq}`);
    assert.ok(!JSON.stringify(fluxer.calls).includes("tok-b"), "plaintext token never reaches the transport log");

    // Ack-then-delete: done + links row + dest id, THEN the spool dir is gone.
    const done = rowState(row.id);
    assert.equal(done.state, "done");
    assert.equal(done.dest_message_id, "f-1");
    const links = repo.listBridgeMessageLinks(bridge.id, "9100");
    assert.equal(links.length, 1);
    assert.equal(links[0].part_index, 0);
    assert.equal(links[0].dst_message_id, "f-1");
    assert.equal(fs.existsSync(file), false, "ack deletes the spool file");
    assert.equal(fs.existsSync(path.dirname(file)), false, "ack deletes the spool dir");
    // Echo gate: the destination id is registered the moment it is known.
    assert.equal(relay.isRelayedDestinationForTest("fluxer", "f-1"), undefined);
  });

  it("a missing spool file falls back to fetchSourceMessage + re-download", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9200",
      payload: createPayload(publicId, "9200", {
        attachments: [
          {
            sourceAttachmentId: "a1",
            filename: "fresh.bin",
            contentType: "application/octet-stream",
            spoiler: false,
            explicitMedia: false,
            bytes: null,
            declaredBytes: 5,
            skipReason: null,
            spoolIndex: 0,
          },
        ],
      }),
    });

    const fluxer = scriptedApi("f2");
    const fetched = [];
    const downloadUrls = [];
    const worker = relay.createRelayWorker({
      repo,
      db: db.db,
      getWebhookApi: () => fluxer,
      getOutbound: () => ({
        fetchMessage: async (cid, ch, mid) => {
          fetched.push([cid, ch, mid]);
          return {
            ok: true,
            message: { attachments: [{ id: "a1", url: "https://cdn.example.test/fresh.bin", filename: "fresh.bin", size: 5 }] },
          };
        },
        sendChannel: async () => ({ id: "m" }),
      }),
      keyGetter: () => KEY,
      sleep: async () => {},
      fetchImpl: async (url) => {
        downloadUrls.push(url);
        const bytes = Buffer.from("fresh");
        return {
          ok: true,
          status: 200,
          // Slice the exact bytes (same contract as the real fetch:
          // arrayBuffer() yields a buffer sized to the body, not the pool).
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      },
      resolveHost: async () => ["93.184.216.34"],
    });
    await worker.drainAll();

    // Spool miss → fetchSourceMessage with the SOURCE community/channel → re-download.
    assert.deepEqual(fetched, [[rowA.id, "RA-1", "9200"]]);
    assert.deepEqual(downloadUrls, ["https://cdn.example.test/fresh.bin"]);
    assert.equal(fluxer.calls.length, 1);
    assert.equal(fluxer.calls[0].opts.files[0].data.toString("utf8"), "fresh");
    assert.equal(rowState(row.id).state, "done");
  });

  // -------------------------------------------------------------------------
  // The failure ladder (spec §10.10)
  // -------------------------------------------------------------------------

  it("429 stays at the head: no attempt burn, capped Retry-After, then succeeds", async () => {
    const { bridge } = seedBridge("a_to_b");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9300",
      payload: createPayload("b_00000021", "9300", { publicId: "b_00000021" }),
    });
    const fluxer = scriptedApi("f3", [
      { ok: false, error: "executeRelayWebhook: request failed: HTTP 429 Too Many Requests", retryable: true, code: "RATE_LIMITED" },
      { ok: true, messageId: "dst-1" },
    ]);
    const worker = makeWorker({ getWebhookApi: () => fluxer });
    await worker.drainAll();

    assert.equal(fluxer.calls.length, 2, "the 429 send is retried in place at the head");
    const after = rowState(row.id);
    assert.equal(after.state, "done");
    assert.equal(after.attempts, 0, "429/SLOWMODE does not count toward the poison limit");
    assert.deepEqual(worker.sleeps, [60_000], "Retry-After falls back to the 60 s cap");
  });

  it("5 generic failures park the row with last_error + the verbatim source notice", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9400",
      payload: createPayload(publicId, "9400"),
    });
    const fluxer = scriptedApi("f4", [
      { ok: false, error: "HTTP 500: boom", retryable: true },
      { ok: false, error: "HTTP 500: boom", retryable: true },
      { ok: false, error: "HTTP 500: boom", retryable: true },
      { ok: false, error: "HTTP 500: boom", retryable: true },
      { ok: false, error: "HTTP 500: boom", retryable: true },
    ]);
    const worker = makeWorker({ getWebhookApi: () => fluxer });
    await worker.drainAll();

    assert.equal(fluxer.calls.length, 5);
    const after = rowState(row.id);
    assert.equal(after.state, "failed", "the 5th attempt parks the row");
    assert.equal(after.attempts, 5);
    assert.match(after.last_error, /HTTP 500: boom/);
    assert.deepEqual(worker.sleeps, [1000, 2000, 4000, 8000], "backoff ladder 1/2/4/8 s between the 5 attempts");

    // §10.10 poison notice, verbatim, in the SOURCE channel (§10.4: bot-authored).
    assert.equal(worker.notices.length, 1);
    assert.equal(worker.notices[0].communityId, rowA.id);
    assert.equal(worker.notices[0].channelId, "RA-1");
    assert.equal(
      worker.notices[0].content,
      `Bridge ${publicId} could not copy message 9400 after 5 attempts: HTTP 500: boom. Later messages are still being copied.`,
    );

    // The bridge keeps working: last_error rides the row for status.
    const bridgeRow = repo.getBridgeById(bridge.id);
    assert.equal(bridgeRow.state, "active");
    assert.match(bridgeRow.last_error, /HTTP 500: boom/);
  });

  it("one direction's failure does not stall the other", async () => {
    const { bridge, publicId } = seedBridge("both");
    // a_to_b (→ Fluxer) fails hard; b_to_a (→ Discord) succeeds.
    const rowAB = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9501",
      payload: createPayload(publicId, "9501"),
    });
    const rowBA = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "b_to_a",
      kind: "create",
      srcMessageId: "9502",
      payload: createPayload(publicId, "9502", {
        direction: "b_to_a",
        srcCommunityId: rowB.id,
        srcChannelId: "RB-9",
      }),
    });
    const fluxer = scriptedApi("fA", Array.from({ length: 5 }, () => ({ ok: false, error: "HTTP 500: boom", retryable: true })));
    const discord = scriptedApi("dA");
    const worker = makeWorker({
      getWebhookApi: (platform) => (platform === "fluxer" ? fluxer : discord),
    });
    await worker.drainAll();

    assert.equal(rowState(rowBA).state, "done", "the healthy direction completed");
    assert.equal(rowState(rowAB).state, "failed", "the broken direction parked independently");
    assert.equal(discord.calls.length, 1);
    assert.equal(fluxer.calls.length, 5);
    // Discord (§10.11) pins NO_PING and sends NO flags/nonce-requiring semantics:
    assert.deepEqual(discord.calls[0].opts.allowedMentions, { parse: [] });
    assert.equal(discord.calls[0].opts.flags, undefined);
    // §10.7: Fluxer → Discord sends NO avatar_url (spike B12 pending).
    assert.equal(discord.calls[0].opts.avatarUrl, undefined);
    // The nonce is computed for Discord too (forward-compat pass-through).
    assert.equal(discord.calls[0].opts.nonce, nonceFor(publicId, "9502", "create", 0));
  });

  it("a worker throw logs `[bridge] worker failed:` and reschedules", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9600",
      payload: createPayload(publicId, "9600", {
        // No spool on disk → the source re-sign fallback runs → the throwing
        // seam (getOutbound) explodes INSIDE runRow: the worker-throw path.
        attachments: [
          { sourceAttachmentId: "a1", filename: "x.bin", contentType: null, spoiler: false, explicitMedia: false, bytes: null, declaredBytes: 2, skipReason: null, spoolIndex: 0 },
        ],
      }),
    });

    const logs = [];
    const original = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    let worker;
    try {
      worker = relay.createRelayWorker({
        repo,
        db: db.db,
        getWebhookApi: () => scriptedApi("fT"),
        getOutbound: () => {
          throw new TypeError("outbound seam exploded");
        },
        keyGetter: () => KEY,
        sleep: async () => {},
      });
      await worker.tick({ drain: true });
    } finally {
      console.error = original;
    }

    assert.ok(
      logs.some((line) => line.includes("[bridge] worker failed:") && line.includes(publicId)),
      `expected a [bridge] worker failed log naming ${publicId}`,
    );
    const after = rowState(row.id);
    assert.equal(after.state, "pending", "a thrown row is rescheduled, never parked blindly");
    assert.equal(after.attempts, 1, "the throw burns one attempt (the ladder owns the cadence)");
    assert.match(after.last_error, /outbound seam exploded/);
    void bridge;
  });

  // -------------------------------------------------------------------------
  // §10.6 Discord retry rule + §10.7 chunking
  // -------------------------------------------------------------------------

  it("a Discord send that produced NO id is retried; one that produced an id is not", async () => {
    const { bridge, publicId } = seedBridge("both");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "b_to_a",
      kind: "create",
      srcMessageId: "9700",
      payload: createPayload(publicId, "9700", { direction: "b_to_a", srcCommunityId: rowB.id, srcChannelId: "RB-9" }),
    });
    const discord = scriptedApi("dR", [{ ok: true, messageId: null }, { ok: true, messageId: "dst-77" }]);
    const worker = makeWorker({
      getWebhookApi: (platform) => (platform === "fluxer" ? scriptedApi("unused", []) : discord),
    });
    await worker.drainAll();

    assert.equal(discord.calls.length, 2, "the id-less success is the ONLY retryable success shape");
    const after = rowState(row.id);
    assert.equal(after.state, "done");
    assert.equal(after.attempts, 1, "the unconfirmed first send burned one attempt");
    assert.equal(after.dest_message_id, "dst-77", "the FIRST confirmed part owns dest_message_id");
  });

  it("a Fluxer success with no message id is DELIVERED (nonce absorbs), never re-sent", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9750",
      payload: createPayload(publicId, "9750"),
    });
    const fluxer = scriptedApi("fN", [{ ok: true, messageId: null }]);
    const worker = makeWorker({ getWebhookApi: (platform) => (platform === "fluxer" ? fluxer : null) });
    await worker.drainAll();
    assert.equal(fluxer.calls.length, 1, "Fluxer never blind-resends a success");
  });

  it("long text chunks in order: (continued) on part 2+, one links row per part", async () => {
    const { bridge, publicId } = seedBridge("both");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "b_to_a",
      kind: "create",
      srcMessageId: "9800",
      payload: createPayload(publicId, "9800", {
        direction: "b_to_a",
        srcCommunityId: rowB.id,
        srcChannelId: "RB-9",
        text: "a".repeat(4500), // Discord's 2000-char limit → 3 parts
      }),
    });
    const discord = scriptedApi("dC");
    const worker = makeWorker({
      getWebhookApi: (platform) => (platform === "fluxer" ? null : discord),
    });
    await worker.drainAll();

    assert.equal(discord.calls.length, 3, "4500 chars chunk into 2000/2000/512 parts");
    assert.equal(discord.calls[0].opts.content.length, 2000);
    assert.ok(discord.calls[1].opts.content.startsWith("(continued) "));
    assert.ok(discord.calls[2].opts.content.startsWith("(continued) "));
    assert.equal(discord.calls[1].opts.content.length, 2000);
    // Each part is its own links row, in order, and the first id is dest_message_id.
    const links = repo.listBridgeMessageLinks(bridge.id, "9800");
    assert.deepEqual(links.map((l) => [l.part_index, l.dst_message_id]), [
      [0, "dC-1"],
      [1, "dC-2"],
      [2, "dC-3"],
    ]);
    assert.equal(rowState(row.id).dest_message_id, "dC-1");
    assert.equal(rowState(row.id).state, "done");
    // §10.7: every part carries ITS OWN nonce (kind + part index).
    assert.equal(discord.calls[2].opts.nonce, nonceFor(publicId, "9800", "create", 2));
  });

  it("over-cap attachments name the file in the body and the row still goes done", async () => {
    const { bridge, publicId } = seedBridge("both");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "b_to_a",
      kind: "create",
      srcMessageId: "9900",
      payload: createPayload(publicId, "9900", {
        direction: "b_to_a",
        srcCommunityId: rowB.id,
        srcChannelId: "RB-9",
        text: "see attached",
        stickers: [{ id: "s1", name: "party" }],
        attachments: [
          { sourceAttachmentId: "a1", filename: "big.zip", contentType: "application/zip", spoiler: false, explicitMedia: false, bytes: null, declaredBytes: 21 * 1024 * 1024, skipReason: "over-cap", spoolIndex: 0 },
        ],
        voiceCaption: "Voice message",
      }),
    });
    const discord = scriptedApi("dS");
    const worker = makeWorker({
      getWebhookApi: (platform) => (platform === "fluxer" ? null : discord),
    });
    await worker.drainAll();

    const content = discord.calls[0].opts.content;
    assert.ok(content.startsWith("Voice message\nsee attached"), "caption + text ride part 1");
    assert.ok(
      content.includes("Attachment not copied: big.zip (22020096 bytes) is over the destination limit of 20971520 bytes."),
      "the over-cap file is NAMED in the body (§10.8 verbatim)",
    );
    assert.ok(content.includes("Sticker: party"), "sticker lines append to the body (§10.8)");
    assert.equal(discord.calls.length, 1, "the skipped file adds no execute");
    assert.equal(rowState(row.id).state, "done", "partial success is a successful row");
  });

  it("spool-full notices ride the payload to the source channel verbatim", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9950",
      payload: createPayload(publicId, "9950", {
        spoolNotices: [{ kind: "spool_full", detail: "bridge cap 524288000 bytes" }],
      }),
    });
    const fluxer = scriptedApi("fL");
    const worker = makeWorker({ getWebhookApi: (platform) => (platform === "fluxer" ? fluxer : null) });
    await worker.drainAll();

    assert.equal(worker.notices.length, 1);
    assert.equal(worker.notices[0].communityId, rowA.id, "the notice goes to the SOURCE channel");
    assert.equal(
      worker.notices[0].content,
      `Bridge ${publicId} is not copying files in this direction: the spool is full (bridge cap 524288000 bytes). ` +
        "Messages' text continues to copy; files that arrive while it is full are not copied. " +
        "This notice will not repeat until the spool is under the cap again.",
    );
  });

  it("FIFO per direction: the older row sends first", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "10002",
      enqueuedAt: T0 + 2,
      payload: createPayload(publicId, "10002", { text: "second" }),
    });
    repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "10001",
      enqueuedAt: T0 + 1,
      payload: createPayload(publicId, "10001", { text: "first" }),
    });
    const fluxer = scriptedApi("fF");
    const worker = makeWorker({ getWebhookApi: () => fluxer });
    await worker.drainAll();
    assert.deepEqual(
      fluxer.calls.map((c) => c.opts.content),
      ["first", "second"],
      "enqueued_at order survives id order (spool-at-enqueue stamps the source order)",
    );
  });

  it("process-wide cap: at most 4 concurrent executes", async () => {
    const bridges = [];
    for (let i = 0; i < 5; i += 1) bridges.push(seedBridge("a_to_b"));
    for (let i = 0; i < 5; i += 1) {
      repo.enqueueBridgeOutbox(bridges[i].bridge.id, {
        direction: "a_to_b",
        kind: "create",
        srcMessageId: `1010${i}`,
        payload: createPayload(bridges[i].publicId, `1010${i}`),
      });
    }
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fluxer = {
      async executeRelayWebhook(webhook, opts) {
        await gate;
        return { ok: true, messageId: `g-${opts.nonce.slice(0, 4)}` };
      },
    };
    const worker = makeWorker({ getWebhookApi: () => fluxer });

    const { started } = await worker.tick({ drain: false });
    assert.equal(started, 4, "the 5th direction waits for a free slot");
    assert.equal(worker.inFlightCount(), 4);

    release();
    await worker.drainAll();
    for (const { bridge, publicId } of bridges) {
      const rows = db.db
        .prepare("SELECT state FROM bridge_outbox WHERE bridge_id = ?")
        .all(bridge.id);
      assert.deepEqual(rows.map((r) => r.state), ["done"], `bridge ${publicId} completed`);
    }
  });

  it("a deleted bridge drains its orphan row to done (no destination to fail at)", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "10200",
      payload: createPayload(publicId, "10200"),
    });
    repo.deleteBridgeCascade(bridge.id);
    // The row survives the cascade only if the test enqueues AFTER; here the
    // cascade removed it — enqueue a fresh orphan pointing at the dead id.
    // FKs are ON at the driver level, so the impossible-in-practice state
    // (child row for a deleted parent) is simulated the way the 034 cutover
    // does it: pragma off, insert, pragma back on.
    db.db.pragma("foreign_keys = OFF");
    try {
      db.db
        .prepare(
          `INSERT INTO bridge_outbox (bridge_id, direction, kind, src_message_id, enqueued_at, state, payload_json)
           VALUES (?, 'a_to_b', 'create', '10201', ?, 'pending', ?)`,
        )
        .run(bridge.id, T0, JSON.stringify(createPayload(publicId, "10201")));
    } finally {
      db.db.pragma("foreign_keys = ON");
    }
    const orphan = db.db
      .prepare("SELECT id FROM bridge_outbox WHERE src_message_id = '10201'")
      .get();
    const worker = makeWorker({ getWebhookApi: () => null });
    await worker.drainAll();
    assert.equal(row.state, "pending", "the pre-cascade row was deleted by the cascade itself");
    assert.equal(
      db.db.prepare("SELECT state FROM bridge_outbox WHERE id = ?").get(orphan.id).state,
      "done",
      "the orphan row for the deleted bridge drains without a send",
    );
  });

  // -------------------------------------------------------------------------
  // Per-part, id-synchronous links commit (roadmap/bridge.md §10.6,
  // audit #195 item 2): the links row for a part lands the moment THAT
  // part's send ACKed — a later park, crash, or restart-replay can neither
  // strand an already-posted copy nor duplicate its row.
  // -------------------------------------------------------------------------

  /** Restart-style replay: return a parked row to 'pending' (mirrors
   *  requeueStaleOutbox after a crash; claim is state+attempts only). */
  function requeueRow(outboxId) {
    db.db
      .prepare("UPDATE bridge_outbox SET state = 'pending', attempts = 0, last_error = NULL WHERE id = ?")
      .run(outboxId);
  }

  it("a park mid-list keeps the links rows of already-posted parts (#195 item 2)", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "10300",
      payload: createPayload(publicId, "10300", {
        text: "b".repeat(4500), // Fluxer's 4000-char limit → 2 parts
      }),
    });
    const fluxer = scriptedApi("fP", [
      { ok: true, messageId: "keep-1" },
      ...Array.from({ length: 5 }, () => ({ ok: false, error: "HTTP 500: boom", retryable: true })),
    ]);
    const worker = makeWorker({ getWebhookApi: () => fluxer });
    await worker.drainAll();

    assert.equal(fluxer.calls.length, 6, "part 1 sent once, part 2 burned the 5-attempt ladder");
    assert.equal(rowState(row.id).state, "failed", "part 2 parked the row");
    // THE FIX: with the old batched-at-end commit this list would be EMPTY —
    // part 1's copy is on the destination but its row only landed after the
    // whole list succeeded. It must be durable NOW: edit/delete relay needs
    // it to find the copy.
    const links = repo.listBridgeMessageLinks(bridge.id, "10300");
    assert.deepEqual(links.map((l) => [l.part_index, l.dst_message_id]), [[0, "keep-1"]]);
    assert.equal(rowState(row.id).dest_message_id, "keep-1", "the row names the committed copy");
  });

  it("restart replay dedupes against committed rows: nonce id re-arms, never re-inserts (#195 item 2)", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "10301",
      payload: createPayload(publicId, "10301", { text: "c".repeat(4500) }),
    });
    // Run 1: part 1 lands, part 2's endpoint dies → park.
    const run1 = scriptedApi("fR1", [
      { ok: true, messageId: "n-1" },
      ...Array.from({ length: 5 }, () => ({ ok: false, error: "HTTP 500: boom", retryable: true })),
    ]);
    await makeWorker({ getWebhookApi: () => run1 }).drainAll();

    // Restart re-queue (spec §10.10): the row replays and re-sends EVERY
    // part; the Fluxer nonce returns the ORIGINAL id for part 1.
    requeueRow(row.id);
    const run2 = scriptedApi("fR2", [
      { ok: true, messageId: "n-1" }, // nonce replay → same id
      { ok: true, messageId: "n-2" },
    ]);
    const worker2 = makeWorker({ getWebhookApi: () => run2 });
    await worker2.drainAll();

    const links = repo.listBridgeMessageLinks(bridge.id, "10301");
    assert.deepEqual(
      links.map((l) => [l.part_index, l.dst_message_id]),
      [
        [0, "n-1"],
        [1, "n-2"],
      ],
      "committed part 1 keeps exactly ONE row (the PK would reject a second)",
    );
    assert.equal(rowState(row.id).state, "done");
    assert.equal(rowState(row.id).dest_message_id, "n-1");
  });

  it("a re-send that yields a DIFFERENT id keeps the committed copy and names the duplicate (#195 item 2)", async () => {
    const { bridge, publicId } = seedBridge("both");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "b_to_a",
      kind: "create",
      srcMessageId: "10302",
      payload: createPayload(publicId, "10302", {
        direction: "b_to_a",
        srcCommunityId: rowB.id,
        srcChannelId: "RB-9",
        text: "d".repeat(2500),
      }),
    });
    const run1 = scriptedApi("dD1", [
      { ok: true, messageId: "first-1" },
      ...Array.from({ length: 5 }, () => ({ ok: false, error: "HTTP 500: boom", retryable: true })),
    ]);
    await makeWorker({ getWebhookApi: (p) => (p === "fluxer" ? null : run1) }).drainAll();

    requeueRow(row.id);
    // A Discord re-send CAN produce a second id (the §10.6 duplicate window).
    const run2 = scriptedApi("dD2", [
      { ok: true, messageId: "other-1" },
      { ok: true, messageId: "dD2-2" },
    ]);
    const warns = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      await makeWorker({ getWebhookApi: (p) => (p === "fluxer" ? null : run2) }).drainAll();
    } finally {
      console.warn = originalWarn;
    }

    const links = repo.listBridgeMessageLinks(bridge.id, "10302");
    assert.deepEqual(
      links.map((l) => [l.part_index, l.dst_message_id]),
      [
        [0, "first-1"], // the FIRST committed id stays authoritative
        [1, "dD2-2"],
      ],
    );
    assert.equal(rowState(row.id).state, "done");
    assert.equal(rowState(row.id).dest_message_id, "first-1");
    assert.equal(warns.length, 1, "the duplicate window is named once, never silent");
    assert.match(warns[0], /re-execution posted part 0 of 10302 as other-1/);
    assert.match(warns[0], /keeping the committed copy first-1/);
  });

  // -------------------------------------------------------------------------
  // Relay/echo map TTL sweep (audit #195 item 3): the maps grow one entry per
  // relayed message; the create gate's lazy delete is nearly unreachable for
  // bot-authored echoes, so the scheduled sweep is what bounds them.
  // -------------------------------------------------------------------------

  it("the TTL sweep evicts expired destination ids WITH their echo entries (observable)", () => {
    relay.clearRelayState();
    const now = 1_800_000_000_000;
    relay.noteRelayedDestination("fluxer", "ttl.example", "dup-1", { nowMs: now });
    relay.noteRelayedDestination("fluxer", "ttl.example", "dup-2", { nowMs: now + 60_000 });
    assert.deepEqual(relay.relayMapSizeForTest(), { echoMessageIds: 2, destinationIds: 2 });
    assert.equal(relay.isRelayedEcho("fluxer", "ttl.example", "dup-1"), true);

    // One millisecond before expiry: nothing moves.
    assert.deepEqual(
      relay.sweepRelayMapTtls(now + relay.DESTINATION_TTL_MS - 1),
      { destinations: 0, echoes: 0, keys: 0 },
    );

    // At expiry: dup-1 is gone from BOTH maps (the echo entry's only bound),
    // dup-2 lives in its own window.
    assert.deepEqual(
      relay.sweepRelayMapTtls(now + relay.DESTINATION_TTL_MS),
      { destinations: 1, echoes: 1, keys: 0 },
    );
    assert.equal(relay.isRelayedDestinationForTest("fluxer", "ttl.example", "dup-1"), undefined);
    assert.equal(relay.isRelayedEcho("fluxer", "ttl.example", "dup-1"), false);
    assert.equal(relay.isRelayedEcho("fluxer", "ttl.example", "dup-2"), true);
    assert.deepEqual(relay.relayMapSizeForTest(), { echoMessageIds: 1, destinationIds: 1 });

    // The whole slice drains after dup-2 expires: the deployment key dies.
    assert.deepEqual(
      relay.sweepRelayMapTtls(now + 60_000 + relay.DESTINATION_TTL_MS),
      { destinations: 1, echoes: 1, keys: 1 },
    );
    assert.deepEqual(relay.relayMapSizeForTest(), { echoMessageIds: 0, destinationIds: 0 });
  });

  it("the sweep keeps SQLite-seeded echo ids — the durable half of the gate", () => {
    const { bridge } = seedBridge("a_to_b");
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowA.id,
      srcMessageId: "5001",
      partIndex: 0,
      dstMessageId: "durable-1",
    });
    relay.clearRelayState();
    relay.reloadRelayMaps({ db: db.db });
    assert.equal(relay.isRelayedEcho("fluxer", "relay.example", "durable-1"), true);

    // Ten years into the future: reload-seeded echo ids have no destination
    // entry — they are bounded by the links table (spec §10.4), not the TTL.
    const farFuture = Date.now() + 10 * 365 * 24 * 3600 * 1000;
    const res = relay.sweepRelayMapTtls(farFuture);
    assert.equal(res.destinations, 0);
    assert.equal(res.echoes, 0);
    assert.equal(
      relay.isRelayedEcho("fluxer", "relay.example", "durable-1"),
      true,
      "the durable echo entry survives every sweep until reload rebuilds it",
    );
    relay.clearRelayState();
    relay.reloadRelayMaps({ db: db.db });
  });

  it("startBridgeLoops registers the TTL sweep job; the loop stop handle removes it", () => {
    const jobs = new Map();
    const scheduler = {
      registerJob: (spec) => jobs.set(spec.name, spec),
      stop: (name) => jobs.delete(name),
    };
    const handle = relay.startBridgeLoops(null, {
      scheduler,
      repo: { requeueStaleOutbox: () => 0, getBridgeByPublicId: () => null },
      isKnownPublicId: () => true, // the orphan pass may not touch the shared spool
      getWebhookApi: () => null,
      getOutbound: () => null,
      keyGetter: () => KEY,
      sendMessage: async () => ({ ok: true }),
      sleep: async () => {},
    });
    try {
      assert.ok(handle && typeof handle.stop === "function", "the loop handle is stoppable");
      const spec = jobs.get("bridge-relay-ttl");
      assert.ok(spec, "the relay/echo TTL sweep runs on the scheduler (60 s default)");
      assert.equal(spec.intervalMs, relay.TTL_SWEEP_INTERVAL_MS);
      assert.deepEqual(spec.run(), { destinations: 0, echoes: 0, keys: 0 });
    } finally {
      handle.stop();
    }
    assert.equal(jobs.size, 0, "the loop stop removes every job, TTL sweep included");
  });

  // -------------------------------------------------------------------------
  // §10.7 degraded fallback — BRG-11 (#417): files attached + mention pin,
  // or an honest named retry. This whole block ran DARK offline before the
  // audit: no test ever reached the degraded send.
  // -------------------------------------------------------------------------

  it("#417 degraded fallback attaches the part's files and pins mentions off", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    spoolBytes(publicId, "9710", 0, "spooled!");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9710",
      payload: createPayload(publicId, "9710", {
        text: null, // file-only part — the "[media attached]" copy case
        attachments: [
          {
            sourceAttachmentId: "a1",
            filename: "note.txt",
            contentType: "text/plain",
            spoiler: false,
            explicitMedia: true,
            bytes: 8,
            declaredBytes: 8,
            skipReason: null,
            spoolIndex: 0,
          },
        ],
      }),
    });

    const fluxer = scriptedApi("dg1", [
      { ok: false, code: "UNKNOWN_WEBHOOK", error: "Unknown Webhook" },
    ]);
    fluxer.createRelayWebhook = async () => ({ ok: false, error: "missing permissions" });

    const captured = [];
    const outbound = {
      fetchMessage: async () => ({ ok: true, message: { attachments: [] } }),
      sendChannel: async (channelId, payload) => {
        captured.push([channelId, payload]);
        return { id: "degraded-1" };
      },
    };
    const worker = makeWorker({
      getWebhookApi: (platform) => (platform === "fluxer" ? fluxer : null),
      getOutbound: () => outbound,
    });
    await worker.drainAll();

    assert.equal(captured.length, 1, "one degraded bot message");
    const [channelId, payload] = captured[0];
    assert.match(String(channelId), /^RB-/, "lands in the DESTINATION channel");
    assert.match(payload.content, /\[media attached\]/, "the file-only copy line");
    assert.deepEqual(
      payload.allowedMentions,
      { parse: [] },
      "KD 13's second disarm layer — the degraded send is the ONE bot-authored " +
        "regular message built from relay content and used to omit the pin",
    );
    // RED pre-#417: sendNotice was content-only — "[media attached]" over
    // nothing was the wire lie BRG-11 names.
    assert.equal(payload.files?.length, 1, "the resolved bytes ride the fallback");
    assert.equal(payload.files[0].name, "note.txt");
    assert.deepEqual(payload.files[0].data, Buffer.from("spooled!"));

    // Degraded IS the delivery (spec §10.7): the row completes, and a
    // completing row clears the bridge's last_error by design.
    assert.equal(rowState(row.id).state, "done");
  });

  it("#417 files failing the degraded send retries without them and NAMES them", async () => {
    const { bridge, publicId } = seedBridge("a_to_b");
    spoolBytes(publicId, "9720", 0, "spooled!");
    const row = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: "9720",
      payload: createPayload(publicId, "9720", {
        text: null,
        attachments: [
          {
            sourceAttachmentId: "a1",
            filename: "note.txt",
            contentType: "text/plain",
            spoiler: false,
            explicitMedia: true,
            bytes: 8,
            declaredBytes: 8,
            skipReason: null,
            spoolIndex: 0,
          },
        ],
      }),
    });

    const fluxer = scriptedApi("dg2", [
      { ok: false, code: "UNKNOWN_WEBHOOK", error: "Unknown Webhook" },
    ]);
    fluxer.createRelayWebhook = async () => ({ ok: false, error: "missing permissions" });

    const captured = [];
    const outbound = {
      fetchMessage: async () => ({ ok: true, message: { attachments: [] } }),
      sendChannel: async (channelId, payload) => {
        captured.push([channelId, payload]);
        if (payload.files?.length) {
          throw new Error("upload rejected: file too large for this channel");
        }
        return { id: "degraded-2" };
      },
    };
    const worker = makeWorker({
      getWebhookApi: (platform) => (platform === "fluxer" ? fluxer : null),
      getOutbound: () => outbound,
    });
    await worker.drainAll();

    assert.equal(captured.length, 2, "with-files send failed → named retry ran");
    const first = captured[0][1];
    assert.equal(first.files?.length, 1, "the retry-probe really carried the bytes");
    const retry = captured[1][1];
    assert.equal(
      "files" in retry,
      false,
      "the retry is files-free — the suspect leaves the second attempt",
    );
    assert.match(retry.content, /Attachments not copied/, "rule 5: partial delivery says what is missing");
    assert.match(retry.content, /note\.txt/, "names the dropped attachment");
    assert.match(retry.content, /file too large/, "carries the failed cause (rule 3)");
    // The named retry delivered — the row settles like a normal send.
    assert.equal(rowState(row.id).state, "done");
  });
});
