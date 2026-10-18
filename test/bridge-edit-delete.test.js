/**
 * Bridge edit/delete relay tests (roadmap/bridge.md § Tests — the "Edit
 * relay" and "Delete relay" rows, PR 6).
 *
 * Everything runs against a fresh temp SQLite (test/helpers/env.js) with the
 * worker's seams FULLY faked: webhook transports (execute/PATCH/DELETE),
 * outbound ports (fetchSourceMessage), sendMessage, sleep. No sockets, no
 * real webhooks, no real backoffs. The pipelines' source-side intake
 * (onMessageUpdate / onMessageDelete) is exercised through the shipped
 * pipeline functions; the worker stays unwired to boot (KD 22).
 *
 * Proves:
 *  1. a rapid double edit coalesces to ONE pending edit row (payload
 *     replaced, FIFO slot kept — enqueued_at preserved);
 *  2. a content-unchanged update (pin/flag shape: editedTimestamp set,
 *     content + attachments identical) enqueues NOTHING (hash coalescing),
 *     through the shipped pipeline intake;
 *  3. the PATCH payload carries NEUTRALIZED content (no raw <@, <#,
 *     @everyone tokens);
 *  4. every changed part is PATCHed with its OWN chunk, links rows per part;
 *  5. a new attachment id on edit → spool files written at the new index at
 *     enqueue, re-uploaded on the PATCH part, spool cleaned at ack;
 *  6. a PATCH failing 5 times parks the row (state failed, last_error) with
 *     the verbatim source-channel poison notice;
 *  7. a MESSAGE_DELETE_BULK-shaped input yields ONE kind-`delete` row per
 *     LINKED source id (unlinked ids enqueue nothing; pending deletes are
 *     never stacked);
 *  8. delete supersession removes pending create/edit rows AND their spool
 *     files;
 *  9. a second delete after `done` enqueues cleanly (idempotent, 404 = ok);
 * 10. an edit for a source id with a pending delete enqueues NOTHING;
 * 11. destination-side (echo) update/delete enqueues NOTHING (KD 10);
 * 12. a non-bridge channel and a bot-authored source update enqueue nothing.
 */
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { loadDb, communityKey } = require("./helpers/env");

// CONTRACT: loadDb() before every src/ require (fresh temp DB, cache reset).
const { api: db, cleanup } = loadDb();

const relay = require("../src/features/bridge/relay");
const media = require("../src/features/bridge/media");
const repo = require("../src/db/repositories/bridges");
const tokenCrypto = require("../src/features/bridge/tokenCrypto");
const pipelines = require("../src/bot/pipelines");
const {
  normalizeFluxerMessage,
  normalizeFluxerMessageDelete,
} = require("../src/platform/fluxer/normalize");
const { getCommunityById } = require("../src/platform/community");

after(() => cleanup?.());

const T0 = 1_700_000_000_000;
const KEY = crypto.randomBytes(32).toString("base64");
const enc = (token) => tokenCrypto.encryptWebhookToken(token, { keyGetter: () => KEY });

/** Deterministic public ids (handle-shaped). */
let idSeq = 0;
function nextPublicId() {
  idSeq += 1;
  return `b_1e00${String(idSeq).padStart(4, "0")}`;
}

/** A digit-string snowflake decoding to ~now (connected_at window, §10.5).
 *  Monotonic: a same-millisecond test suite must never reuse an id. */
let _sfSeq = 0n;
function snowflakeNow() {
  _sfSeq += 1n;
  return String(((BigInt(Date.now()) - 1420070400000n) << 22n) + _sfSeq);
}

describe("bridge edit/delete relay (PR 6)", () => {
  /** @type {object} */
  let rowA; // Discord community (end a)
  /** @type {object} */
  let rowB; // Fluxer community (end b)

  before(() => {
    rowA = getCommunityById(communityKey("900000000000060001"));
    rowB = getCommunityById(communityKey("900000000000060002", "fluxer", "ed.example"));
  });

  // The suite shares ONE loadDb() database, so each test must start from an
  // empty bridge state: a pending row left by an earlier test would be drained
  // by a later test's worker (phantom fetches/executes) and collide on the
  // outbox/links UNIQUE constraints.
  afterEach(() => {
    for (const sql of [
      "DELETE FROM bridge_message_links",
      "DELETE FROM bridge_src_snapshots",
      "DELETE FROM bridge_outbox",
      "DELETE FROM bridge_ends",
      "DELETE FROM bridge_connect_attempts",
      "DELETE FROM bridges",
    ]) {
      db.db.prepare(sql).run();
    }
    relay.clearRelayState();
  });

  /**
   * Active bridge with both ends + encrypted webhook tokens on both ends.
   * End A sits on the Discord community, end B on the Fluxer one. Returns
   * the per-bridge channel ids so intake messages can target a real end.
   * @param {string} [direction]
   */
  function seedBridge(direction = "both") {
    const publicId = nextPublicId();
    const n = idSeq;
    const bridge = repo.createBridge({
      publicId,
      createdByUserId: "u",
      endACommunityId: rowA.id,
      endAChannelId: `EA-${n}`,
      direction,
      codeHash: null,
    });
    repo.addBridgeEnd({
      bridgeId: bridge.id,
      position: "b",
      communityId: rowB.id,
      channelId: `EB-${n}`,
    });
    db.db
      .prepare("UPDATE bridges SET state = 'active', connected_at = ? WHERE id = ?")
      .run(T0, bridge.id);
    repo.setBridgeEndWebhook(bridge.id, "a", {
      webhookId: `wha-${n}`,
      tokenEnc: enc("tok-a"),
    });
    repo.setBridgeEndWebhook(bridge.id, "b", {
      webhookId: `whb-${n}`,
      tokenEnc: enc("tok-b"),
    });
    return { bridge, publicId, channelA: `EA-${n}`, channelB: `EB-${n}` };
  }

  /** Standard create payload (text-only) — the shape PR 5 ships. */
  function createPayload(publicId, srcMessageId, over = {}) {
    return {
      schemaVersion: 1,
      publicId,
      direction: "a_to_b",
      srcCommunityId: rowA.id,
      srcChannelId: "EA-1",
      srcMessageId,
      author: {
        name: "alice",
        discrim: "0",
        avatarUrl: "https://cdn.example.test/a.png",
        roleNames: [],
      },
      text: "hello world",
      replyHeader: null,
      voiceCaption: null,
      stickers: [],
      embeds: [],
      attachments: [],
      explicitMedia: false,
      enqueuedAt: T0,
      ...over,
    };
  }

  /** Minimal Discord-shaped source message for the pipeline/enqueue intake. */
  function srcMessage(id, over = {}) {
    const {
      channelId = "EA-1",
      content = "hello world",
      authorBot = false,
      ...rest
    } = over;
    return {
      id,
      channelId,
      guildId: rowA.externalGuildId,
      communityId: rowA.id,
      platform: "discord",
      instanceKey: "discord",
      content,
      authorId: "111111111111111111",
      authorBot,
      author: { id: "111111111111111111", username: "alice", bot: authorBot },
      editedTimestamp: T0 + 60_000,
      attachments: [],
      embeds: [],
      stickers: [],
      mentions: [],
      roleMentions: [],
      channelMentions: [],
      ...rest,
    };
  }

  /** All outbox rows of one kind for a bridge, oldest first. */
  function outboxRows(bridgeId, kind) {
    return db.db
      .prepare(
        "SELECT * FROM bridge_outbox WHERE bridge_id = ? AND kind = ? ORDER BY id ASC",
      )
      .all(bridgeId, kind);
  }

  function outboxCount(bridgeId, kind) {
    return db.db
      .prepare(
        "SELECT COUNT(*) AS c FROM bridge_outbox WHERE bridge_id = ? AND kind = ?",
      )
      .get(bridgeId, kind).c;
  }

  /**
   * Scripted fake webhook transport (spec §10.3 shape, no network) extended
   * with the PR 6 verbs: patchRelayMessage / deleteRelayMessage, each with
   * its own scripted response list.
   */
  function scriptedApi(name, script = {}) {
    const patchCalls = [];
    const deleteCalls = [];
    const execCalls = [];
    return {
      name,
      execCalls,
      patchCalls,
      deleteCalls,
      async executeRelayWebhook(webhook, opts) {
        execCalls.push({ webhook, opts });
        return { ok: true, messageId: `${name}-x${execCalls.length}` };
      },
      async patchRelayMessage(webhook, dstMessageId, patch, ctx) {
        const step = script.patch
          ? script.patch[patchCalls.length] ?? { ok: true }
          : { ok: true };
        patchCalls.push({ webhook, dstMessageId, patch, ctx });
        return typeof step === "function" ? step(patchCalls.length) : step;
      },
      async deleteRelayMessage(webhook, dstMessageId, ctx) {
        const step = script.del
          ? script.del[deleteCalls.length] ?? { ok: true }
          : { ok: true };
        deleteCalls.push({ webhook, dstMessageId, ctx });
        return typeof step === "function" ? step(deleteCalls.length) : step;
      },
      async createRelayWebhook() {
        return { ok: true, webhook: { id: `${name}-new`, token: "tok-new" }, tokenEnc: enc("tok-new") };
      },
    };
  }

  /** Worker with all seams faked; collects notices + sleep cadence. */
  function makeWorker({ getWebhookApi, getOutbound, sendMessage, sleep, fetchImpl, resolveHost, downloadTimeoutMs } = {}) {
    const notices = [];
    const sleeps = [];
    const worker = relay.createRelayWorker({
      repo,
      db: db.db,
      getWebhookApi: getWebhookApi ?? (() => null),
      getOutbound: getOutbound ?? (() => null),
      keyGetter: () => KEY,
      // Worker-side media downloads (spool-miss re-fetch, #376) ride the
      // same faked transport as the enqueue-side spool.
      fetchImpl,
      resolveHost,
      downloadTimeoutMs,
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

  /** Fake SOURCE-side outbound client: the adapter's fetchSourceMessage rides
   *  this client's `fetchMessage` (spec §10.3 seam). Records re-reads. */
  function fakeSource(message) {
    const fetches = [];
    return {
      fetches,
      async fetchMessage(communityId, channelId, messageId) {
        fetches.push([communityId, channelId, messageId]);
        return { ok: true, message: { id: messageId, ...message } };
      },
    };
  }

  /** The links rows for a source message, ordered by part_index. */
  function linkRows(bridgeId, srcMessageId) {
    return repo.listBridgeMessageLinks(bridgeId, srcMessageId);
  }

  /** Write a spool file (index 0..n) for the given message. */
  function spoolBytes(publicId, srcMessageId, index, content) {
    const dir = media.spoolDirFor(publicId, srcMessageId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, String(index));
    fs.writeFileSync(file, Buffer.from(content, "utf8"));
    return file;
  }

  // -------------------------------------------------------------------------
  // 1. Rapid double edit coalescing (spec §10.10: ONE pending edit row)
  // -------------------------------------------------------------------------

  it("two rapid edits coalesce into ONE pending row (payload replaced, slot kept)", async () => {
    const { bridge, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowA.id,
      srcMessageId: msgId,
      partIndex: 0,
      dstMessageId: "dst-1",
    });

    const first = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "first edit" }),
    );
    assert.ok(first?.enqueued, "the first edit enqueues");
    const rowId = first.outboxId;
    const enqueuedAt1 = outboxRows(bridge.id, "edit")[0].enqueued_at;
    const snap1 = repo.getBridgeSrcSnapshot(bridge.id, msgId);
    assert.match(snap1.content_hash, /^[0-9a-f]{64}$/, "snapshot stores a 64-hex hash");

    const second = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "second edit" }),
    );
    assert.ok(second?.enqueued, "the second edit is accepted");
    assert.equal(second.outboxId, rowId, "it replaces the SAME outbox row (one queue slot)");

    const rows = outboxRows(bridge.id, "edit");
    assert.equal(rows.length, 1, "exactly ONE pending edit row exists");
    assert.equal(rows[0].state, "pending");
    assert.equal(rows[0].enqueued_at, enqueuedAt1, "the FIFO slot (enqueued_at) is kept");
    assert.equal(JSON.parse(rows[0].payload_json).text, "second edit", "payload replaced");

    const snap2 = repo.getBridgeSrcSnapshot(bridge.id, msgId);
    assert.equal(
      snap2.content_hash,
      relay.relayPayloadHash(JSON.parse(rows[0].payload_json)),
      "the snapshot hash matches the coalesced payload (the coalescing key)",
    );

    // A THIRD update with content identical to the second: hash-identical,
    // nothing enqueues (the coalescing gate, §10.10).
    const third = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "second edit" }),
    );
    assert.equal(third, null, "a content-identical follow-up enqueues NOTHING");
    assert.equal(outboxCount(bridge.id, "edit"), 1, "still exactly one queued edit");
  });

  // -------------------------------------------------------------------------
  // 1b. Edits AFTER a `done` edit row keep queuing (#375 / BRG-1):
  // UNIQUE(bridge, direction, src, kind) SPANS terminal states — without a
  // terminal-row pre-delete (the delete path's §10.10 precedent), every
  // edit after the first done row violated the constraint, got swallowed
  // as a routine duplicate, and the destination copy froze forever.
  // -------------------------------------------------------------------------

  it("edits after an edit row reaches `done` keep queuing and keep landing (#375)", async () => {
    const { bridge, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowA.id,
      srcMessageId: msgId,
      partIndex: 0,
      dstMessageId: "dst-1b",
    });

    // Edit #1 enqueues and drains to `done` — the state that used to poison
    // every future edit of this message.
    const first = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "edit one" }),
    );
    assert.ok(first?.enqueued, "the first edit enqueues");
    const f1b = scriptedApi("f1b");
    const src1b = fakeSource({ content: "irrelevant-re-read" });
    const workerDeps = {
      getWebhookApi: (p) => (p === "fluxer" ? f1b : null),
      getOutbound: (p) => (p === "discord" ? src1b : null),
    };
    let worker = makeWorker(workerDeps);
    await worker.drainAll();
    assert.equal(repo.getBridgeOutboxById(first.outboxId).state, "done");

    // Edit #2 — the audit's lost-forever case. OLD CODE: returned null, the
    // UNIQUE collision was caught as a routine duplicate, and the snapshot
    // hash had already moved so NOTHING ever queued again.
    const second = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "edit two" }),
    );
    assert.ok(second?.enqueued, "an edit AFTER a done edit row still queues (#375)");
    assert.equal(outboxCount(bridge.id, "edit"), 1, "the terminal row is replaced, never stacked");
    const pending = outboxRows(bridge.id, "edit")[0];
    assert.equal(pending.state, "pending", "fresh row starts pending");
    assert.equal(JSON.parse(pending.payload_json).text, "edit two", "carries the new content");

    worker = makeWorker(workerDeps);
    await worker.drainAll();
    assert.equal(repo.getBridgeOutboxById(second.outboxId).state, "done");

    // It stays fixed, not once-only: edit #3 queues after edit #2's done row.
    const third = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "edit three" }),
    );
    assert.ok(third?.enqueued, "the Nth edit after N-1 done edits still queues");
    worker = makeWorker(workerDeps);
    await worker.drainAll();
    assert.equal(
      f1b.patchCalls.length,
      3,
      "all three edits reached the destination copy (it does not freeze at edit #1)",
    );
  });

  // -------------------------------------------------------------------------
  // 2. Pin/flag noise: content-identical update enqueues NOTHING
  // -------------------------------------------------------------------------

  it("a content-identical update (pin/flag shape) enqueues NOTHING, via the pipeline", async () => {
    const { bridge, publicId, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowA.id,
      srcMessageId: msgId,
      partIndex: 0,
      dstMessageId: "dst-2",
    });
    // The create's canonical snapshot (what the worker recorded at relay time).
    repo.upsertBridgeSrcSnapshot(
      bridge.id,
      msgId,
      relay.relayPayloadHash(createPayload(publicId, msgId, { srcChannelId: channelA })),
    );

    // A MESSAGE_UPDATE with an editedTimestamp set, IDENTICAL content and
    // attachments (Discord sends this shape for pins/flags): hash-identical.
    await pipelines.onMessageUpdate(
      {},
      srcMessage(msgId, { channelId: channelA, content: "hello world", editedTimestamp: T0 + 90_000 }),
    );
    assert.equal(
      outboxCount(bridge.id, "edit"),
      0,
      "an unchanged-content update never enqueues (§10.10)",
    );
    assert.equal(repo.getBridgeById(bridge.id).last_error, null);
  });

  // -------------------------------------------------------------------------
  // 3. PATCH body is neutralized (no raw mention/ping tokens)
  // -------------------------------------------------------------------------

  it("the PATCH body is neutralized: no raw <@/<#/role tokens, empty allow-pings", async () => {
    const { bridge, publicId, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowA.id,
      srcMessageId: msgId,
      partIndex: 0,
      dstMessageId: "dst-3",
    });
    const src = fakeSource({
      content: "hey <@111111111111111111> ping @everyone see <#123456789012345678> role <@&999999999999999999>",
    });
    const f3 = scriptedApi("f3");
    const worker = makeWorker({
      getWebhookApi: (p) => (p === "fluxer" ? f3 : null),
      getOutbound: (p) => (p === "discord" ? src : null),
    });

    const enq = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "raw <@111111111111111111> @everyone" }),
    );
    assert.ok(enq?.enqueued);
    await worker.drainAll();

    assert.equal(src.fetches.length, 1, "the worker RE-READS the source (fetchSourceMessage)");
    assert.deepEqual(src.fetches[0], [rowA.id, channelA, msgId]);
    assert.equal(f3.patchCalls.length, 1, "ONE PATCH on the linked part");
    const call = f3.patchCalls[0];
    assert.equal(call.dstMessageId, "dst-3", "the PATCH targets the linked destination id");
    const c = call.patch.content;
    assert.ok(!c.includes("<@"), "no raw user/role mention tokens in the body");
    assert.ok(!c.includes("<#"), "no raw channel mention tokens in the body");
    assert.ok(c.includes("@user"), "unresolved user id becomes the @user label");
    assert.ok(c.includes("#channel"), "unresolved channel becomes #channel");
    assert.ok(c.includes("@role"), "unresolved role becomes @role");
    assert.ok(!/@everyone/.test(c), "the @everyone token is neutralized (ZWSP-broken)");
    assert.ok(!/@here/.test(c), "the @here token is neutralized");
    assert.deepEqual(
      call.patch.allowedMentions,
      {},
      "Fluxer destinations get the empty allow-list (§10.11)",
    );
    assert.equal(call.patch.username, "alice", "the attribution override rides the PATCH");
    assert.ok(!("avatarUrl" in call.patch), "Fluxer PATCH sends NO avatar (§10.7)");
    assert.equal(
      call.patch.flags,
      1 << 12,
      "SUPPRESS_NOTIFICATIONS rides every Fluxer send (§10.11)",
    );
    assert.equal(
      call.patch.nonce,
      relay.relayNonce(publicId, msgId, "edit", 0),
      "the §10.6 nonce (kind edit) rides the PATCH",
    );
    // Drain MARKS the outbox row done — the outbox is an audit trail, rows
    // are never deleted by success (§10.10 keeps rows for state inspection).
    const drained = outboxRows(bridge.id, "edit");
    assert.equal(drained.length, 1, "the edit row is kept as history");
    assert.equal(drained[0].state, "done", "the edit row is drained (done)");
    assert.equal(repo.getBridgeById(bridge.id).last_error, null);
  });

  // -------------------------------------------------------------------------
  // 4a. Every changed part is PATCHed with its own chunk
  // -------------------------------------------------------------------------

  it("every changed part gets its OWN chunk PATCH (per-part filtering)", async () => {
    const { bridge, publicId, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    // The create the destination already has: 6500 chars → 2 Fluxer parts.
    const createRow = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: msgId,
      payload: createPayload(publicId, msgId, { srcChannelId: channelA, text: "a".repeat(6500) }),
    });
    // Delivered history: the copy already lives on the destination, so the
    // create row is DONE (a pending one would be a queue item to send).
    db.db.prepare("UPDATE bridge_outbox SET state = 'done' WHERE id = ?").run(createRow.id);
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 0, dstMessageId: "dst-4a" });
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 1, dstMessageId: "dst-4b" });

    const src = fakeSource({ content: "b".repeat(6500) });
    const f4 = scriptedApi("f4");
    const worker = makeWorker({
      getWebhookApi: (p) => (p === "fluxer" ? f4 : null),
      getOutbound: (p) => (p === "discord" ? src : null),
    });

    const enq = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "b".repeat(6500) }),
    );
    assert.ok(enq?.enqueued);
    await worker.drainAll();

    assert.equal(src.fetches.length, 1, "the worker RE-READS the source (fetchSourceMessage)");
    assert.equal(f4.execCalls.length, 0, "an edit NEVER re-posts the message");
    assert.equal(f4.patchCalls.length, 2, "BOTH chunks changed: one PATCH per changed part");
    assert.equal(f4.patchCalls[0].dstMessageId, "dst-4a");
    assert.equal(f4.patchCalls[1].dstMessageId, "dst-4b");
    assert.ok(f4.patchCalls[0].patch.content.startsWith("b".repeat(100)), "part 0 carries the new chunk");
    assert.equal(
      f4.patchCalls[0].patch.content.length,
      4000,
      "sliceSafe: the Fluxer 4000-char budget caps part 0",
    );
    assert.ok(
      f4.patchCalls[1].patch.content.startsWith(`(continued) ${"b".repeat(100)}`),
      "part 1 carries the (continued) chunk",
    );
    // Drain marks done; the row stays as history (see test 3).
    assert.deepEqual(
      outboxRows(bridge.id, "edit").map((r) => r.state),
      ["done"],
      "the edit row drained",
    );
    assert.equal(repo.getBridgeById(bridge.id).last_error, null);
  });

  // -------------------------------------------------------------------------
  // 4b. Unchanged parts are NOT patched (content-change filter)
  // -------------------------------------------------------------------------

  it("parts whose content is UNCHANGED are not patched (§10.7 change filter)", async () => {
    const { bridge, publicId, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    // Create: 8500 x's → parts: x*4000, x*4000, "(continued) " + x*500.
    const createRow = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: msgId,
      payload: createPayload(publicId, msgId, { srcChannelId: channelA, text: "x".repeat(8500) }),
    });
    // Delivered history — done, not a pending queue item (see test 4a).
    db.db.prepare("UPDATE bridge_outbox SET state = 'done' WHERE id = ?").run(createRow.id);
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 0, dstMessageId: "dst-5a" });
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 1, dstMessageId: "dst-5b" });
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 2, dstMessageId: "dst-5c" });

    // Edit: first 8000 chars IDENTICAL; only the tail part changes.
    const src = fakeSource({ content: "x".repeat(8000) + "y".repeat(500) });
    const f5 = scriptedApi("f5");
    const worker = makeWorker({
      getWebhookApi: (p) => (p === "fluxer" ? f5 : null),
      getOutbound: (p) => (p === "discord" ? src : null),
    });

    const enq = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "x".repeat(8000) + "y".repeat(500) }),
    );
    assert.ok(enq?.enqueued);
    await worker.drainAll();

    assert.equal(f5.patchCalls.length, 1, "only the CHANGED part gets a PATCH");
    assert.equal(f5.patchCalls[0].dstMessageId, "dst-5c", "the tail part is the one patched");
    assert.equal(
      f5.patchCalls[0].patch.nonce,
      relay.relayNonce(publicId, msgId, "edit", 2),
      "the nonce carries part_index 2 (§10.6)",
    );
    // Shipped chunker (PR 5, §10.7): the "(continued) " prefix counts toward
    // the destination limit, so part budgets are 4000 / 3988 / 3988 … and the
    // tail starts at offset 4000+3988=7988: x*12 (the 12 x's left over from
    // 8000) followed by the 500 y's.
    assert.equal(
      f5.patchCalls[0].patch.content,
      `(continued) ${"x".repeat(12)}${"y".repeat(500)}`,
      "the new tail chunk content",
    );
    assert.deepEqual(
      outboxRows(bridge.id, "edit").map((r) => r.state),
      ["done"],
    );
  });

  // -------------------------------------------------------------------------
  // 4c. An edit that GROWS the chunking POSTs the new part (+ links row)
  // -------------------------------------------------------------------------

  it("an edit that grows the chunking POSTs the new part and links it", async () => {
    const { bridge, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 0, dstMessageId: "dst-6a" });

    const src = fakeSource({ content: "c".repeat(6500) });
    const f6 = scriptedApi("f6");
    const worker = makeWorker({
      getWebhookApi: (p) => (p === "fluxer" ? f6 : null),
      getOutbound: (p) => (p === "discord" ? src : null),
    });

    const enq = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "c".repeat(6500) }),
    );
    assert.ok(enq?.enqueued);
    await worker.drainAll();

    assert.equal(f6.patchCalls.length, 1, "the linked part 0 is PATCHed");
    assert.equal(f6.execCalls.length, 1, "the NEW part 1 (no link) is POSTed");
    assert.ok(f6.execCalls[0].opts.content.startsWith(`(continued) ${"c".repeat(100)}`));
    const links = linkRows(bridge.id, msgId);
    assert.equal(links.length, 2, "the POSTed part recorded its OWN links row");
    assert.equal(Number(links[1].part_index), 1, "part_index 1");
    assert.equal(links[1].dst_message_id, "f6-x1");
    assert.ok(
      relay.isRelayedDestinationForTest("fluxer", "ed.example", "f6-x1"),
      "the new part id joins the echo set (KD 10)",
    );
    assert.deepEqual(
      outboxRows(bridge.id, "edit").map((r) => r.state),
      ["done"],
    );
  });

  // -------------------------------------------------------------------------
  // 5. New attachment id on edit → spooled at enqueue, PATCHed, spool cleaned
  // -------------------------------------------------------------------------

  it("a new attachment id on edit is spooled at enqueue, re-uploaded on its PATCH part, and the spool is cleaned at ack", async () => {
    const { bridge, publicId, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 0, dstMessageId: "dst-7" });

    const attachment = {
      id: "att-9",
      name: "new.png",
      size: 6,
      url: "https://cdn.example.test/new.png",
      contentType: "image/png",
    };
    const mediaSeam = {
      fetchImpl: async (url) => ({ urls: url, ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6]).buffer }),
      resolveHost: async () => ["93.184.216.34"],
    };
    const enq = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "look", attachments: [attachment] }),
      { media: mediaSeam },
    );
    assert.ok(enq?.enqueued);

    // Spooled AT ENQUEUE at the new index (spec §10.7: new attachment ids
    // get new part files — spooled exactly like a create).
    const file = media.spoolFilePath(publicId, msgId, 0);
    assert.ok(file && fs.existsSync(file), "the new attachment is spooled at enqueue");
    const payload = JSON.parse(repo.getBridgeOutboxById(enq.outboxId).payload_json);
    assert.equal(payload.attachments.length, 1, "the payload carries the new descriptor");
    assert.equal(payload.attachments[0].sourceAttachmentId, "att-9");
    assert.equal(payload.attachments[0].spoolIndex, 0, "the descriptor carries the spool index");
    assert.equal(payload.attachments[0].skipReason, null, "the spool succeeded (bytes on disk)");

    const src = fakeSource({
      content: "look",
      attachments: [{ id: "att-9", filename: "new.png", size: 6, url: "https://cdn.example.test/new.png" }],
    });
    const f7 = scriptedApi("f7");
    const worker = makeWorker({
      getWebhookApi: (p) => (p === "fluxer" ? f7 : null),
      getOutbound: (p) => (p === "discord" ? src : null),
    });
    await worker.drainAll();

    assert.equal(f7.patchCalls.length, 1, "ONE PATCH carries the new file batch");
    const files = f7.patchCalls[0].patch.files;
    assert.equal(files.length, 1, "the NEW attachment rides the PATCH part (re-upload, §10.7)");
    assert.equal(files[0].name, "new.png");
    assert.equal(files[0].contentType, "image/png");
    assert.equal(
      Buffer.compare(files[0].data, Buffer.from([1, 2, 3, 4, 5, 6])),
      0,
      "the bytes come from the spool file",
    );
    assert.equal(
      fs.existsSync(path.dirname(file)),
      false,
      "ack-then-delete: the spool directory is cleaned after the PATCH",
    );
    assert.equal(repo.getBridgeOutboxById(enq.outboxId).state, "done");
  });

  // -------------------------------------------------------------------------
  // 5b. #376 / BRG-2: a TEXT edit of a message that had attachments at
  // create used to ALWAYS poison-park — the create-era descriptors rode
  // the PATCH with data:null (their spool died at create-ack, bytes were
  // only ever resolved for NEW ids), and the adapters refuse data:null
  // deterministically: attempts 1-5 burned, park + notice.
  // -------------------------------------------------------------------------

  it("a text edit of a message with create-era attachments re-sends REAL bytes (#376)", async () => {
    const { bridge, publicId, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();

    const attachment = {
      id: "att-old",
      name: "chart.png",
      size: 6,
      url: "https://cdn.example.test/chart.png",
      contentType: "image/png",
    };
    const mediaSeam = {
      fetchImpl: async (url) => ({
        urls: url,
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6]).buffer,
      }),
      resolveHost: async () => ["93.184.216.34"],
    };

    // CREATE with the attachment, executed and acked: links exist, the
    // spool dir is deleted at ack — production shape for every later edit.
    const enqCreate = await relay.enqueueBridgeMessage(
      srcMessage(msgId, { channelId: channelA, content: "with file", attachments: [attachment] }),
      { media: mediaSeam },
    );
    assert.ok(enqCreate?.enqueued, "create with attachment enqueues");

    const srcAttach = { id: "att-old", filename: "chart.png", size: 6, url: "https://cdn.example.test/chart.png" };
    const f12 = scriptedApi("f12");
    // The worker RE-READS the source (§10.7) — the fake must return the
    // message AS IT IS NOW: the edited text plus the still-present
    // attachment (Discord reports existing attachments on edited messages).
    const src12 = fakeSource({ content: "text only edit", attachments: [srcAttach] });
    const workerDeps = {
      getWebhookApi: (p) => (p === "fluxer" ? f12 : null),
      getOutbound: (p) => (p === "discord" ? src12 : null),
      fetchImpl: mediaSeam.fetchImpl,
      resolveHost: mediaSeam.resolveHost,
    };
    let worker = makeWorker(workerDeps);
    await worker.drainAll();
    assert.ok(repo.listBridgeMessageLinks(bridge.id, msgId).length >= 1, "create landed + linked");
    assert.equal(
      fs.existsSync(media.spoolDirFor(publicId, msgId)),
      false,
      "create ack deleted the spool dir (edits can only re-download)",
    );

    // TEXT-only edit. Discord still reports the existing attachment on the
    // edited message, and the enqueue correctly filters it as seen — so the
    // edit payload carries ZERO new ids while the PATCH must still resend
    // the create-era file with real bytes.
    const enqEdit = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "text only edit", attachments: [attachment] }),
    );
    assert.ok(enqEdit?.enqueued, "the text edit enqueues");
    const editPayload = JSON.parse(repo.getBridgeOutboxById(enqEdit.outboxId).payload_json);
    assert.equal(editPayload.attachments.length, 0, "no NEW attachment ids on the edit");

    worker = makeWorker(workerDeps);
    await worker.drainAll();

    assert.equal(f12.patchCalls.length, 1, "exactly one PATCH — no ladder burn (#376)");
    const files = f12.patchCalls[0].patch.files;
    assert.equal(files.length, 1, "the create-era attachment rides the PATCH");
    assert.equal(files[0].name, "chart.png");
    assert.ok(
      files[0].data != null && files[0].data.length === 6,
      "descriptor carries REAL bytes (pre-fix: null — adapters reject data:null, park + notice)",
    );
    assert.equal(
      Buffer.compare(Buffer.from(files[0].data), Buffer.from([1, 2, 3, 4, 5, 6])),
      0,
      "bytes re-downloaded from the fetched source url",
    );
    assert.equal(repo.getBridgeOutboxById(enqEdit.outboxId).state, "done", "the edit lands (no poison-park)");
    assert.equal(repo.getBridgeById(bridge.id).last_error, null, "nothing poisoned");
  });

  // -------------------------------------------------------------------------
  // 6. PATCH failing 5 times → park: state failed, last_error, verbatim notice
  // -------------------------------------------------------------------------

  it("a PATCH failing 5 times parks the row (state failed, last_error) with the verbatim §10.10 notice", async () => {
    const { bridge, publicId, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 0, dstMessageId: "dst-8" });

    const src = fakeSource({ content: "edited five times over" });
    const f8 = scriptedApi("f8", {
      patch: Array.from({ length: 8 }, () => ({ ok: false, error: "HTTP 500: server exploded", retryable: true })),
    });
    const worker = makeWorker({
      getWebhookApi: (p) => (p === "fluxer" ? f8 : null),
      getOutbound: (p) => (p === "discord" ? src : null),
    });

    const enq = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "edited five times over" }),
    );
    assert.ok(enq?.enqueued);
    await worker.drainAll();

    assert.equal(f8.patchCalls.length, 5, "the 5-attempt ladder: exactly 5 PATCHes, then park (§10.10)");
    assert.deepEqual(
      worker.sleeps,
      [1000, 2000, 4000, 8000],
      "the 1s/2s/4s/8s backoff rides between the five attempts",
    );
    const rows = outboxRows(bridge.id, "edit");
    assert.equal(rows.length, 1, "the parked row stays in the outbox (poison, not dropped)");
    assert.equal(rows[0].state, "failed");
    const b = repo.getBridgeById(bridge.id);
    assert.equal(b.state, "active", "parking ONE message never PAUSEs the bridge (§10.10)");
    assert.equal(b.last_error, "HTTP 500: server exploded", "last_error records the platform cause");
    assert.equal(worker.notices.length, 1, "the SOURCE channel gets exactly one notice");
    assert.equal(worker.notices[0].communityId, rowA.id);
    assert.equal(worker.notices[0].channelId, channelA);
    assert.equal(
      worker.notices[0].content,
      `Bridge ${publicId} could not copy message ${msgId} after 5 attempts: HTTP 500: server exploded. Later messages are still being copied.`,
      "the §10.10 poison sentence, verbatim",
    );

    // A parked row never re-enters the ladder (state failed is terminal).
    await worker.drainAll();
    assert.equal(f8.patchCalls.length, 5, "a parked row is not retried");
  });

  // -------------------------------------------------------------------------
  // 7. BULK: one kind-`delete` row per LINKED id
  // -------------------------------------------------------------------------

  it("a BULK-shaped input yields one kind-`delete` row per linked src id", () => {
    const { bridge, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const ids = [snowflakeNow(), snowflakeNow(), snowflakeNow()];
    // Only the first two ids were relayed (have links rows).
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: ids[0], partIndex: 0, dstMessageId: "bulk-1" });
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: ids[1], partIndex: 0, dstMessageId: "bulk-2" });
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: ids[1], partIndex: 1, dstMessageId: "bulk-2b" });

    const res = relay.enqueueBridgeBulkDelete(rowA.id, channelA, ids);
    assert.equal(res.enqueued, 2, "one delete row per LINKED id (the unlinked id enqueues nothing)");
    const rows = db.db
      .prepare("SELECT src_message_id FROM bridge_outbox WHERE bridge_id = ? AND kind = 'delete'")
      .all(bridge.id)
      .map((r) => r.src_message_id)
      .sort();
    assert.deepEqual(rows, [...ids.slice(0, 2)].sort());

    // A purge-shaped redelivery: a PENDING delete for the same id is never
    // stacked (the UNIQUE one-queue-slot rule); unlinked ids stay inert.
    const again = relay.enqueueBridgeBulkDelete(rowA.id, channelA, [...ids, "not-a-snowflake"]);
    assert.equal(again.enqueued, 0, "redelivered ids with a PENDING delete enqueue nothing");
    assert.equal(
      db.db
        .prepare("SELECT COUNT(*) AS c FROM bridge_outbox WHERE bridge_id = ? AND kind = 'delete'")
        .get(bridge.id).c,
      2,
      "still exactly one queued delete per linked id",
    );
  });

  // -------------------------------------------------------------------------
  // 8. Delete supersession (spec §10.10: takedown supersedes in flight)
  // -------------------------------------------------------------------------

  it("delete supersession drops pending create/edit rows AND their spool files", () => {
    const { bridge, publicId, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 0, dstMessageId: "dst-9" });

    // A pending create row WITH spooled bytes (mid-outage queue).
    const file = spoolBytes(publicId, msgId, 0, "bytes!");
    repo.enqueueBridgeOutbox(bridge.id, {
      direction: "a_to_b",
      kind: "create",
      srcMessageId: msgId,
      payload: createPayload(publicId, msgId, { srcChannelId: channelA }),
    });
    assert.ok(fs.existsSync(file));

    const res = relay.enqueueBridgeDelete(srcMessage(msgId, { channelId: channelA }));
    assert.ok(res?.enqueued, "the delete row lands");

    assert.equal(
      outboxCount(bridge.id, "create"),
      0,
      "the pending create row is DROPPED by supersession",
    );
    assert.equal(fs.existsSync(path.dirname(file)), false, "the superseded row's spool directory is deleted");
    const delRows = outboxRows(bridge.id, "delete");
    assert.equal(delRows.length, 1);
    assert.equal(delRows[0].state, "pending");
    assert.equal(JSON.parse(delRows[0].payload_json).srcMessageId, msgId);
  });

  // -------------------------------------------------------------------------
  // 9. A second delete after `done` enqueues cleanly (idempotent 404 = ok)
  // -------------------------------------------------------------------------

  it("a second delete after `done` enqueues cleanly and re-runs idempotently", async () => {
    const { bridge, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 0, dstMessageId: "dst-10" });

    const first = relay.enqueueBridgeDelete(srcMessage(msgId, { channelId: channelA }));
    assert.ok(first?.enqueued);
    // The transport: first delete lands; the second hits a 404 (already
    // gone) — the §10.7 rule maps that to SUCCESS.
    const f10 = scriptedApi("f10", {
      del: [{ ok: true }, { ok: false, error: "HTTP 404: Not Found", code: "UNKNOWN_MESSAGE" }],
    });
    let worker = makeWorker({ getWebhookApi: (p) => (p === "fluxer" ? f10 : null) });
    await worker.drainAll();
    assert.equal(repo.getBridgeOutboxById(first.outboxId).state, "done");
    assert.equal(f10.deleteCalls.length, 1);
    assert.equal(repo.getBridgeById(bridge.id).last_error, null, "a clean delete clears last_error");

    // The source deletes the (already-removed) message again: enqueues cleanly.
    const second = relay.enqueueBridgeDelete(srcMessage(msgId, { channelId: channelA }));
    assert.ok(second?.enqueued, "a repeat delete after done enqueues cleanly");
    // The terminal row is replaced in place: UNIQUE(bridge, direction, src,
    // kind) allows exactly ONE delete row per source id, and SQLite reuses
    // the freed rowid (no AUTOINCREMENT), so the id may repeat — the count
    // is what must not grow.
    assert.equal(
      outboxCount(bridge.id, "delete"),
      1,
      "the re-queue replaces the done row, it never stacks a second one",
    );
    worker = makeWorker({ getWebhookApi: (p) => (p === "fluxer" ? f10 : null) });
    await worker.drainAll();
    assert.equal(repo.getBridgeOutboxById(second.outboxId).state, "done", "404 on a part is success");
    assert.equal(f10.deleteCalls.length, 2, "the copy is re-targeted by id (idempotent)");
    assert.equal(
      outboxCount(bridge.id, "delete"),
      1,
      "the terminal (done) row is replaced by the fresh one — one row per queued delete",
    );
  });

  // -------------------------------------------------------------------------
  // 10. An edit under a pending delete is dropped (delete supersedes)
  // -------------------------------------------------------------------------

  it("an edit for a src id with a pending delete enqueues NOTHING", async () => {
    const { bridge, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({ bridgeId: bridge.id, srcCommunityId: rowA.id, srcMessageId: msgId, partIndex: 0, dstMessageId: "dst-11" });

    assert.ok(relay.enqueueBridgeDelete(srcMessage(msgId, { channelId: channelA }))?.enqueued);
    const res = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "edited after takedown" }),
    );
    assert.equal(res, null, "the delete supersedes: the edit is dropped (§10.7)");
    assert.equal(outboxCount(bridge.id, "edit"), 0);
    assert.equal(outboxCount(bridge.id, "delete"), 1);
  });

  // -------------------------------------------------------------------------
  // 11–12. Pipeline intake gates (echo, non-bridge, bot author)
  // -------------------------------------------------------------------------

  it("destination-side (echo) update/delete enqueues NOTHING", async () => {
    relay.clearRelayState();
    const msgId = snowflakeNow();
    // The id is a DESTINATION copy of this process (echo set, KD 10).
    relay.noteRelayedDestination("discord", "discord", msgId);

    await pipelines.onMessageUpdate({}, srcMessage(msgId, { content: "moderation edit on the copy" }));
    await pipelines.onMessageDelete({}, srcMessage(msgId));

    assert.equal(
      db.db.prepare("SELECT COUNT(*) AS c FROM bridge_outbox WHERE src_message_id = ?").get(msgId).c,
      0,
      "echoed updates/deletes never re-enter as source relay",
    );
    relay.clearRelayState();
  });

  it("a non-bridge channel update/delete enqueues nothing", async () => {
    relay.clearRelayState();
    const msgId = snowflakeNow();
    await pipelines.onMessageUpdate({}, srcMessage(msgId, { channelId: "999-not-bridged", content: "hi" }));
    await pipelines.onMessageDelete({}, srcMessage(msgId, { channelId: "999-not-bridged" }));
    assert.equal(
      db.db.prepare("SELECT COUNT(*) AS c FROM bridge_outbox WHERE src_message_id = ?").get(msgId).c,
      0,
      "channels that are not bridge ends are inert",
    );
  });

  it("a bot-authored source update enqueues nothing (echo case, defense in depth)", async () => {
    const { channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    await pipelines.onMessageUpdate(
      {},
      srcMessage(msgId, { channelId: channelA, content: "webhook edit", authorBot: true }),
    );
    assert.equal(
      db.db.prepare("SELECT COUNT(*) AS c FROM bridge_outbox WHERE src_message_id = ?").get(msgId).c,
      0,
      "bot/webhook authors on the source side never enqueue (§10.4)",
    );
  });

  // -------------------------------------------------------------------------
  // #195 item 5 — FLUXER-side update/delete intake (Fluxer → Discord relay).
  // The mirror of every gate above, driven through the shipped pipeline
  // entries with Fluxer-normalized messages (source end b → destination end
  // a = Discord): the edit relays as a PATCH of the discord copy, the delete
  // as a DELETE, and the protections (echo, bot author, hash coalescing,
  // non-bridge channels) enqueue NOTHING.
  // -------------------------------------------------------------------------

  /** A Fluxer-normalized source message (wire snake shape through the REAL
   *  gateway normalizer — the same object client.js hands the pipeline). */
  function fluxerSrcMessage(id, channelB, over = {}) {
    const { content = "edited on fluxer", authorBot = false, authorId = "77", ...rest } = over;
    return normalizeFluxerMessage(
      {
        id,
        channel_id: channelB,
        guild_id: rowB.externalGuildId,
        author: { id: authorId, username: "flora", bot: authorBot },
        content,
        timestamp: new Date().toISOString(),
        attachments: [],
        mentions: [],
        ...rest,
      },
      { instanceKey: rowB.instanceKey },
    );
  }

  it("a Fluxer-side edit relays to Discord: pipeline intake → ONE PATCH of the discord copy", async () => {
    const { bridge, publicId, channelB } = seedBridge("both");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    // The delivered create: a FLUXER source message copied to Discord (b_to_a).
    const createRow = repo.enqueueBridgeOutbox(bridge.id, {
      direction: "b_to_a",
      kind: "create",
      srcMessageId: msgId,
      payload: createPayload(publicId, msgId, {
        direction: "b_to_a",
        srcCommunityId: rowB.id,
        srcChannelId: channelB,
        text: "hello from fluxer",
      }),
    });
    db.db.prepare("UPDATE bridge_outbox SET state = 'done' WHERE id = ?").run(createRow.id);
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowB.id,
      srcMessageId: msgId,
      partIndex: 0,
      dstMessageId: "dc-copy",
    });

    // Worker: the SOURCE re-read rides the fluxer outbound, the PATCH rides
    // the DISCORD webhook transport (the reverse of every shipped test).
    const src = fakeSource({ content: "edited on fluxer" });
    const dF = scriptedApi("dF");
    const worker = makeWorker({
      getWebhookApi: (p) => (p === "discord" ? dF : null),
      getOutbound: (p) => (p === "fluxer" ? src : null),
    });

    await pipelines.onFluxerMessageUpdate(
      {},
      fluxerSrcMessage(msgId, channelB, { content: "edited on fluxer" }),
    );
    const rows = outboxRows(bridge.id, "edit");
    assert.equal(rows.length, 1, "the fluxer MESSAGE_UPDATE enqueued kind-edit");
    assert.equal(rows[0].direction, "b_to_a");
    assert.equal(JSON.parse(rows[0].payload_json).text, "edited on fluxer");

    await worker.drainAll();
    assert.equal(src.fetches.length, 1, "the worker RE-READS the fluxer source");
    assert.equal(dF.execCalls.length, 0, "an edit NEVER re-posts the discord copy");
    assert.equal(dF.patchCalls.length, 1, "ONE PATCH of the discord copy");
    assert.equal(dF.patchCalls[0].dstMessageId, "dc-copy");
    assert.equal(dF.patchCalls[0].patch.content, "edited on fluxer");
    assert.deepEqual(dF.patchCalls[0].patch.allowedMentions, { parse: [] }, "NO_PING on Discord (§10.11)");
    assert.equal(outboxRows(bridge.id, "edit")[0].state, "done");
  });

  it("a Fluxer-side delete relays to Discord: pipeline intake → DELETE of the discord copy", async () => {
    const { bridge, publicId, channelB } = seedBridge("both");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowB.id,
      srcMessageId: msgId,
      partIndex: 0,
      dstMessageId: "dc-copy2",
    });
    void publicId;
    const dG = scriptedApi("dG");
    const worker = makeWorker({ getWebhookApi: (p) => (p === "discord" ? dG : null) });

    // The SDK's MESSAGE_DELETE partial (payload-shaped, NO author) through
    // the real delete normalizer.
    await pipelines.onFluxerMessageDelete(
      {},
      normalizeFluxerMessageDelete(
        { id: msgId, channel_id: channelB, guild_id: rowB.externalGuildId },
        { instanceKey: rowB.instanceKey },
      ),
    );
    const rows = outboxRows(bridge.id, "delete");
    assert.equal(rows.length, 1, "the fluxer MESSAGE_DELETE enqueued kind-delete");
    assert.equal(rows[0].direction, "b_to_a");

    await worker.drainAll();
    assert.deepEqual(dG.deleteCalls.map((c) => c.dstMessageId), ["dc-copy2"]);
    assert.equal(outboxRows(bridge.id, "delete")[0].state, "done");
    // The 404-is-success ladder and supersession are the SAME code the
    // Discord-side tests above already cover (platform-neutral executor).
  });

  it("the fluxer-side gates mirror the Discord protections: nothing enqueues", async () => {
    seedBridge("both");
    relay.clearRelayState();

    // (a) Echo (KD 10): the id is a copy THIS process relayed to fluxer —
    // our own PATCH/takedown echo must never re-enter as a source edit.
    const copyId = snowflakeNow();
    relay.noteRelayedDestination("fluxer", rowB.instanceKey, copyId);
    await pipelines.onFluxerMessageUpdate(
      {},
      fluxerSrcMessage(copyId, "EB-echo", { content: "our own patch echo" }),
    );
    await pipelines.onFluxerMessageDelete(
      {},
      normalizeFluxerMessageDelete(
        { id: copyId, channel_id: "EB-echo", guild_id: rowB.externalGuildId },
        { instanceKey: rowB.instanceKey },
      ),
    );

    // (b) Bot/webhook author (the copy author case).
    const botMsgId = snowflakeNow();
    await pipelines.onFluxerMessageUpdate(
      {},
      fluxerSrcMessage(botMsgId, "EB-gate", { content: "webhook copy edited", authorBot: true }),
    );

    // (c) Non-bridge channel.
    const offBridgeId = snowflakeNow();
    await pipelines.onFluxerMessageUpdate(
      {},
      fluxerSrcMessage(offBridgeId, "999-not-bridged", { content: "hi" }),
    );
    await pipelines.onFluxerMessageDelete(
      {},
      normalizeFluxerMessageDelete(
        { id: offBridgeId, channel_id: "999-not-bridged", guild_id: rowB.externalGuildId },
        { instanceKey: rowB.instanceKey },
      ),
    );

    for (const id of [copyId, botMsgId, offBridgeId]) {
      assert.equal(
        db.db.prepare("SELECT COUNT(*) AS c FROM bridge_outbox WHERE src_message_id = ?").get(id).c,
        0,
        `message ${id}: echoed/bot/off-bridge fluxer updates and deletes never enqueue`,
      );
    }
  });

  it("a fluxer pin/flag-noise update coalesces against the snapshot (§10.10 mirror)", async () => {
    const { bridge, channelB } = seedBridge("both");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowB.id,
      srcMessageId: msgId,
      partIndex: 0,
      dstMessageId: "dc-noise",
    });

    // First real edit enqueues (and writes the snapshot)…
    await pipelines.onFluxerMessageUpdate(
      {},
      fluxerSrcMessage(msgId, channelB, { content: "content v2" }),
    );
    assert.equal(outboxCount(bridge.id, "edit"), 1);

    // …a pin-noise MESSAGE_UPDATE carrying the SAME content hashes
    // identically: the coalescing rule is platform-neutral (§10.10).
    await pipelines.onFluxerMessageUpdate(
      {},
      fluxerSrcMessage(msgId, channelB, { content: "content v2" }),
    );
    assert.equal(outboxCount(bridge.id, "edit"), 1, "unchanged content enqueues NOTHING");
  });

  // -------------------------------------------------------------------------
  // #413 (BRG-7): gone-destination handling on the PR 6 verbs.
  // -------------------------------------------------------------------------

  it("#413 deleting a copy in an already-gone channel is still SUCCESS — no break", async () => {
    const { bridge, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowA.id,
      srcMessageId: msgId,
      partIndex: 0,
      dstMessageId: "dst-9003",
    });
    const del = relay.enqueueBridgeDelete(srcMessage(msgId, { channelId: channelA }));
    assert.ok(del?.enqueued);
    const api = scriptedApi("f9003", {
      del: [{ ok: false, error: "deleteRelayMessage: request failed: HTTP 404", code: "10003" }],
    });
    const worker = makeWorker({ getWebhookApi: (p) => (p === "fluxer" ? api : null) });
    await worker.drainAll();
    assert.equal(repo.getBridgeOutboxById(del.outboxId).state, "done", "channel gone = the desired end state for a DELETE");
    assert.equal(repo.getBridgeById(bridge.id).state, "active", "a delete is never broken by the gone — its work is already done");
    assert.equal(worker.notices.length, 0);
  });

  it("#413 an edit into a gone channel breaks the bridge with the once notice", async () => {
    const { bridge, channelA } = seedBridge("a_to_b");
    relay.clearRelayState();
    const msgId = snowflakeNow();
    repo.addBridgeMessageLink({
      bridgeId: bridge.id,
      srcCommunityId: rowA.id,
      srcMessageId: msgId,
      partIndex: 0,
      dstMessageId: "dst-9004",
    });
    const edit = await relay.enqueueBridgeEdit(
      srcMessage(msgId, { channelId: channelA, content: "edited while gone" }),
    );
    assert.ok(edit?.enqueued);
    const api = scriptedApi("f9004", {
      patch: [
        {
          ok: false,
          error: "patchRelayMessage: Unknown Channel (status 404, code 10003)",
          code: "10003",
        },
      ],
    });
    const src = fakeSource({ content: "edited while gone" });
    const worker = makeWorker({
      getWebhookApi: (p) => (p === "fluxer" ? api : null),
      getOutbound: (p) => (p === "discord" ? src : null),
    });
    await worker.drainAll();
    const b = repo.getBridgeById(bridge.id);
    assert.equal(b.state, "broken", "§10.10: the edit ladder names the gone channel → the bridge breaks");
    assert.match(b.broken_reason, /destination channel gone/);
    assert.equal(repo.getBridgeOutboxById(edit.outboxId).state, "failed");
    assert.equal(worker.notices.length, 1, "the ONCE notice replaces the per-message poison noise");
    assert.match(worker.notices[0].content, /the other channel is gone/);
    assert.match(worker.notices[0].content, /\/bridge disconnect/);
  });
});