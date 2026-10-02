/**
 * Bridge media spool unit tests (roadmap/bridge.md § Tests — "Media" row,
 * KD 8 / KD 14). Everything runs against a fresh temp SQLite + temp DATA_DIR
 * (test/helpers/env.js): NO real network (the download fetch, the DNS
 * resolver, and the timers are injected), NO real sockets.
 *
 * Proves:
 *  - the spool file is written AT ENQUEUE under the generated index path;
 *  - `../` filenames and traversal ids are refused (paths are generated,
 *    remote names are never path segments);
 *  - an over-cap file records skipReason "over-cap" and the named line
 *    (verbatim sentence builder);
 *  - the spool-full latch emits exactly one notice per (direction, kind)
 *    incident and re-arms when usage drops under the cap;
 *  - download security: https-only, private/loopback address refusal,
 *    redirect budget + same-host rule, abort→timeout mapping;
 *  - spoiler mapping + 120-char filename cap;
 *  - 12 files spool to indices 0..11 (overflow = more executes, same slot);
 *  - the enqueue payload carries bytes/skipReason/spoolIndex + the §10.7
 *    attribution fields (handle, https-only avatar) + voice caption.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadDb, communityKey } = require("./helpers/env");

// CONTRACT: loadDb() before every src/ require (fresh temp DB, cache reset).
const { api: db, tmpDir, cleanup } = loadDb();

const relay = require("../src/features/bridge/relay");
const media = require("../src/features/bridge/media");
const repo = require("../src/db/repositories/bridges");
const { getCommunityById } = require("../src/platform/community");

after(() => cleanup?.());

const T0 = 1_700_000_000_000;
const PUBKEY_HOST = "93.184.216.34"; // public example address (no traffic)

/** Fake fetch returning one fixed byte payload; records every requested URL. */
function recordingFetch(body = "data") {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const bytes = Buffer.from(body, "utf8");
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  fetchImpl.urls = urls;
  return fetchImpl;
}

const publicResolve = async () => [PUBKEY_HOST];

describe("bridge media (PR 5)", () => {
  /** @type {{ id: number, platform: string, instanceKey: string }} */
  let rowA;
  /** @type {{ id: number, platform: string, instanceKey: string }} */
  let rowB;

  before(() => {
    const communityA = communityKey("900000000000030001");
    const communityB = communityKey("900000000000030002", "fluxer", "media.example");
    rowA = getCommunityById(communityA);
    rowB = getCommunityById(communityB);
  });

  // -------------------------------------------------------------------------
  // Paths, containment, filename sanitization
  // -------------------------------------------------------------------------

  it("refuses traversal ids and keeps every spool path inside the message dir", () => {
    assert.equal(media.isSafeSpoolId("b_ok12345"), true);
    assert.equal(media.isSafeSpoolId("../escape"), false);
    assert.equal(media.isSafeSpoolId("with/slash"), false);
    assert.equal(media.isSafeSpoolId(""), false);
    assert.equal(media.isSafeSpoolId(12345), false);

    assert.equal(media.spoolDirFor("../escape", "1"), null);
    assert.equal(media.spoolDirFor("b_ok12345", "../1"), null);
    assert.equal(media.spoolFilePath("b_ok12345", "1", -1), null);
    assert.equal(media.spoolFilePath("b_ok12345", "1", 1.5), null);

    const file = media.spoolFilePath("b_ok12345", "1700000000000000001", 7);
    const root = media.spoolRootDir();
    assert.ok(file.startsWith(path.resolve(root, "b_ok12345", "1700000000000000001") + path.sep));
    assert.ok(file.startsWith(root));
  });

  it("sanitizes remote filenames for the wire (path segments stripped, 120 cap)", () => {
    assert.equal(media.sanitizeOutboundFilename("../../etc/passwd"), "passwd");
    assert.equal(media.sanitizeOutboundFilename("a/b/c.png"), "c.png");
    assert.equal(media.sanitizeOutboundFilename(""), "file");
    assert.equal(media.sanitizeOutboundFilename(".."), "file");
    const long = media.sanitizeRemoteFilename(`${"x".repeat(300)}.png`);
    assert.ok(long.length <= media.FILENAME_MAX_LEN);
    assert.ok(long.endsWith(".png"));
  });

  // -------------------------------------------------------------------------
  // Spoiler mapping (spec §10.8)
  // -------------------------------------------------------------------------

  it("maps spoilers per destination: prefix set for Discord, stripped for Fluxer", () => {
    assert.equal(media.applySpoilerForDestination("pic.png", true, "discord"), "SPOILER_pic.png");
    assert.equal(media.applySpoilerForDestination("pic.png", false, "discord"), "pic.png");
    assert.equal(
      media.applySpoilerForDestination("SPOILER_pic.png", true, "fluxer"),
      "pic.png",
    );
    assert.equal(media.applySpoilerForDestination("pic.png", false, "fluxer"), "pic.png");
  });

  it("names skip lines with the verbatim §10.8 sentences", () => {
    assert.equal(
      media.buildOverCapLine("big.zip", 22020096, 20971520),
      "Attachment not copied: big.zip (22020096 bytes) is over the destination limit of 20971520 bytes.",
    );
    assert.equal(
      media.buildSkipLine("clip.mp4", "fetch-failed: HTTP 404"),
      "Attachment not copied: clip.mp4: fetch-failed: HTTP 404.",
    );
    assert.equal(
      media.buildSpoolFullNotice("b_abc12345", "bridge cap 524288000 bytes"),
      "Bridge b_abc12345 is not copying files in this direction: the spool is full (bridge cap 524288000 bytes). " +
        "Messages' text continues to copy; files that arrive while it is full are not copied. " +
        "This notice will not repeat until the spool is under the cap again.",
    );
  });

  // -------------------------------------------------------------------------
  // spoolAttachments: ceilings, caps, downloads
  // -------------------------------------------------------------------------

  it("spools bytes to the generated index path and reports descriptors", async () => {
    const fetchImpl = recordingFetch("bytes-42");
    const result = await media.spoolAttachments({
      publicId: "b_spool001",
      srcMessageId: "5001",
      attachments: [
        { id: "a1", filename: "one.bin", size: 7, contentType: "application/octet-stream", url: "https://cdn.example.test/one.bin", flags: 0 },
        { id: "a2", filename: "SPOILER_two.png", size: 7, contentType: "image/png", url: "https://cdn.example.test/two.png", flags: 8 | 16 },
      ],
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts: { fetchImpl, resolveHost: publicResolve },
    });
    assert.equal(result.notices.length, 0);
    assert.equal(result.descriptors.length, 2);
    assert.deepEqual(
      result.descriptors.map((d) => [d.spoolIndex, d.bytes, d.skipReason, d.spoiler, d.explicitMedia]),
      [
        [0, 7, null, false, false],
        [1, 7, null, true, true],
      ],
    );
    const base = path.join(tmpDir, "bridge-spool", "b_spool001", "5001");
    assert.equal(fs.readFileSync(path.join(base, "0"), "utf8"), "bytes-42");
    assert.equal(fs.readFileSync(path.join(base, "1"), "utf8"), "bytes-42");
    assert.deepEqual(fetchImpl.urls, [
      "https://cdn.example.test/one.bin",
      "https://cdn.example.test/two.png",
    ]);
    assert.equal(media.spoolUsageSnapshot("b_spool001").bridgeBytes, 14);
  });

  it("over-ceiling files skip with over-cap and never touch the network", async () => {
    const fetchImpl = recordingFetch();
    const result = await media.spoolAttachments({
      publicId: "b_cap00001",
      srcMessageId: "5002",
      attachments: [
        { id: "a1", filename: "big.zip", size: 21 * 1024 * 1024, url: "https://cdn.example.test/big.zip" },
        { id: "a2", filename: "big50.zip", size: 51 * 1024 * 1024, url: "https://cdn.example.test/big50.zip" },
      ],
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts: { fetchImpl, resolveHost: publicResolve },
    });
    // 21 MiB exceeds Discord's 20 MiB; 51 MiB exceeds Fluxer's 50 MiB.
    assert.equal(result.descriptors[0].skipReason, "over-cap");
    assert.equal(result.descriptors[0].declaredBytes, 21 * 1024 * 1024);
    assert.equal(result.descriptors[1].skipReason, "over-cap");
    assert.deepEqual(fetchImpl.urls, [], "over-cap files must not be downloaded");
    assert.equal(fs.existsSync(path.join(tmpDir, "bridge-spool", "b_cap00001")), false);
  });

  it("per-bridge spool cap: over-capacity files skip with spool-full, once-latched notice", async () => {
    const fetchImpl = recordingFetch("12345678"); // 8 bytes each
    const opts = {
      fetchImpl,
      resolveHost: publicResolve,
      bridgeSpoolCapBytes: 10,
      processSpoolCapBytes: 10_000,
    };
    const att = (id) => [{ id, filename: `${id}.bin`, size: 8, url: `https://cdn.test/${id}.bin` }];

    const first = await media.spoolAttachments({
      publicId: "b_full0001",
      srcMessageId: "6001",
      attachments: [...att("a1"), ...att("a2")],
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts,
    });
    assert.equal(first.descriptors[0].skipReason, null);
    assert.equal(first.descriptors[1].skipReason, "spool-full");
    // The first incident fires ONE notice, naming the bridge cap.
    assert.equal(first.notices.length, 1);
    assert.equal(first.notices[0].kind, "spool_full");
    assert.match(first.notices[0].detail, /bridge cap 10 bytes/);

    // Second incident, same (publicId, direction): LATCHED — no second notice.
    const second = await media.spoolAttachments({
      publicId: "b_full0001",
      srcMessageId: "6002",
      attachments: att("a3"),
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts,
    });
    assert.equal(second.descriptors[0].skipReason, "spool-full");
    assert.equal(second.notices.length, 0, "spool-full latches once per incident");

    // Ack-then-delete frees the bridge: usage under the cap releases the
    // latch, so the NEXT incident fires again (spec: "not repeat until ...
    // under the cap again" — the inverse edge).
    assert.equal(media.deleteSpoolDir("b_full0001", "6001"), true);
    const third = await media.spoolAttachments({
      publicId: "b_full0001",
      srcMessageId: "6003",
      attachments: [...att("a4"), ...att("a5")],
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts,
    });
    assert.equal(third.descriptors[0].skipReason, null);
    assert.equal(third.descriptors[1].skipReason, "spool-full");
    assert.equal(third.notices.length, 1, "a fresh incident after clearing re-notices");
  });

  it("download security: https-only, private-address refusal, redirect budget, timeouts", async () => {
    // Non-https is refused BEFORE any resolver/fetch runs.
    const noFetch = recordingFetch();
    const insecure = await media.downloadSignedUrl("http://cdn.example.test/x.bin", {
      fetchImpl: noFetch,
      resolveHost: publicResolve,
    });
    assert.equal(insecure.ok, false);
    assert.match(insecure.reason, /non-https url \(http:\)/);
    assert.equal(noFetch.urls.length, 0);

    // Loopback / link-local / RFC1918 literals are refused.
    for (const host of ["127.0.0.1", "169.254.1.1", "10.1.2.3", "172.16.5.6", "192.168.0.9", "[::1]", "[fe80::1]"]) {
      const res = await media.downloadSignedUrl(`https://${host}/x.bin`, {
        fetchImpl: noFetch,
        resolveHost: publicResolve,
      });
      assert.equal(res.ok, false, `must refuse ${host}`);
      assert.match(res.reason, /refused address range/);
    }
    assert.equal(noFetch.urls.length, 0, "refused addresses never reach fetch");

    // A name resolving to a private address is refused too.
    const resolved = await media.downloadSignedUrl("https://intranet.example/x.bin", {
      fetchImpl: noFetch,
      resolveHost: async () => ["10.0.0.5"],
    });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /refused address range for 10.0.0.5/);

    // Unresolvable names are refused.
    const dead = await media.downloadSignedUrl("https://nope.example/x.bin", {
      fetchImpl: noFetch,
      resolveHost: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    assert.equal(dead.ok, false);
    assert.match(dead.reason, /dns lookup failed/);

    // Same-host redirects: 3 hops land; the 4th is refused (spec: ≤ 3).
    function chain(redirects) {
      let calls = 0;
      return async (url) => {
        calls += 1;
        if (calls <= redirects) {
          return {
            ok: false,
            status: 301,
            headers: { get: (n) => (n === "location" ? `https://cdn.example.test/hop${calls}` : null) },
          };
        }
        const bytes = Buffer.from("final");
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      };
    }
    const threeHops = await media.downloadSignedUrl("https://cdn.example.test/start", {
      fetchImpl: chain(3),
      resolveHost: publicResolve,
    });
    assert.equal(threeHops.ok, true);
    const fourHops = await media.downloadSignedUrl("https://cdn.example.test/start", {
      fetchImpl: chain(4),
      resolveHost: publicResolve,
    });
    assert.equal(fourHops.ok, false);
    assert.match(fourHops.reason, /too many redirects/);

    // Cross-host redirects are refused (spec: same-host redirects only).
    const offHost = await media.downloadSignedUrl("https://cdn.example.test/x", {
      fetchImpl: async () => ({
        ok: false,
        status: 302,
        headers: { get: () => "https://evil.example/x" },
      }),
      resolveHost: publicResolve,
    });
    assert.equal(offHost.ok, false);
    assert.match(offHost.reason, /redirect left the original host/);

    // An aborted (timed-out) fetch surfaces as a named timeout reason.
    const timedOut = await media.downloadSignedUrl("https://cdn.example/test", {
      fetchImpl: async () => {
        throw new Error("This operation was aborted");
      },
      resolveHost: publicResolve,
    });
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.reason, /download timed out/);
  });

  it("records per-file download failures as fetch-failed skipReasons", async () => {
    const result = await media.spoolAttachments({
      publicId: "b_fail0001",
      srcMessageId: "6100",
      attachments: [
        { id: "a1", filename: "gone.bin", size: 4, url: "http://insecure.test/gone" },
        { id: "a2", filename: "nourl.bin", size: 4 },
      ],
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts: { fetchImpl: recordingFetch(), resolveHost: publicResolve },
    });
    assert.equal(result.descriptors[0].skipReason, "fetch-failed: non-https url (http:)");
    assert.equal(result.descriptors[1].skipReason, "no source url on the attachment");
    assert.equal(result.descriptors[0].bytes, null);
  });

  it("spools 12 files to indices 0..11 (10-file overflow is an execute concern)", async () => {
    const attachments = Array.from({ length: 12 }, (_, i) => ({
      id: `x${i}`,
      filename: `f${i}.bin`,
      size: 2,
      url: `https://cdn.test/f${i}.bin`,
    }));
    const result = await media.spoolAttachments({
      publicId: "b_many0001",
      srcMessageId: "6200",
      attachments,
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts: { fetchImpl: recordingFetch("ok"), resolveHost: publicResolve },
    });
    assert.equal(result.descriptors.length, 12);
    assert.equal(result.descriptors.every((d) => d.skipReason === null), true);
    const base = path.join(tmpDir, "bridge-spool", "b_many0001", "6200");
    for (let i = 0; i < 12; i += 1) {
      assert.ok(fs.existsSync(path.join(base, String(i))), `index ${i} spooled`);
    }
  });

  it("refuses to write when the message ids are unsafe (path traversal)", async () => {
    const result = await media.spoolAttachments({
      publicId: "../escape",
      srcMessageId: "700",
      attachments: [{ id: "a1", filename: "evil.txt", size: 3, url: "https://cdn.test/evil" }],
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts: { fetchImpl: recordingFetch(), resolveHost: publicResolve },
    });
    assert.equal(result.descriptors[0].skipReason, "refused: unsafe spool id");
    assert.equal(fs.existsSync(path.join(tmpDir, "..", "escape")), false);
  });

  // -------------------------------------------------------------------------
  // The orphan-spool pass (spec §10.10 / Data Model)
  // -------------------------------------------------------------------------

  it("the orphan pass deletes spool dirs with no bridges row", () => {
    const root = media.spoolRootDir();
    // Isolate the assertion from dirs created by earlier tests in this file:
    // the sweep scans the whole spool root, and this suite proves exactly one
    // thing — dirs with no bridges row are deleted.
    for (const prior of media.listSpoolPublicIds()) {
      fs.rmSync(path.join(root, prior), { recursive: true, force: true });
    }
    const orphan = path.join(root, "b_ghost1", "900");
    const keeper = path.join(root, "b_real0001", "900");
    fs.mkdirSync(orphan, { recursive: true });
    fs.mkdirSync(keeper, { recursive: true });
    fs.writeFileSync(path.join(orphan, "0"), "x");
    fs.writeFileSync(path.join(keeper, "0"), "x");

    const { removed } = media.sweepOrphanSpools({
      isKnownPublicId: (id) => id === "b_real0001",
    });
    assert.deepEqual(removed, ["b_ghost1"]);
    assert.equal(fs.existsSync(path.join(root, "b_ghost1")), false);
    assert.ok(fs.existsSync(path.join(keeper, "0")), "known bridges keep their spool");
  });

  // -------------------------------------------------------------------------
  // Enqueue integration: the spool + payload land on the durable row
  // -------------------------------------------------------------------------

  it("enqueue spools the attachment at the index path and records the descriptor", async () => {
    const publicId = "b_enq00001";
    const bridge = repo.createBridge({
      publicId,
      createdByUserId: "u",
      endACommunityId: rowA.id,
      endAChannelId: "M-A1",
      direction: "both",
      codeHash: null,
    });
    repo.addBridgeEnd({ bridgeId: bridge.id, position: "b", communityId: rowB.id, channelId: "M-B1" });
    db.db.prepare(`UPDATE bridges SET state = 'active', connected_at = ? WHERE id = ?`).run(T0, bridge.id);

    const fetchImpl = recordingFetch("file!");
    const message = {
      id: "1700000000000000002",
      platform: "discord",
      instanceKey: "discord",
      communityId: rowA.id,
      channelId: "M-A1",
      authorId: "42",
      author: { id: "42", username: "alice", avatarURL: "https://cdn.discordapp.com/avatars/42/a.png" },
      authorDisplayName: "Alice",
      content: "look",
      type: 0,
      attachments: [{ id: "a1", name: "note.txt", size: 5, contentType: "text/plain", flags: 8, url: "https://cdn.example.test/note.txt" }],
      mentions: { users: [], roles: [], channels: [] },
    };
    const res = await relay.enqueueBridgeMessage(message, {
      media: { fetchImpl, resolveHost: publicResolve },
    });
    assert.equal(res.enqueued, true);

    const row = db.db
      .prepare("SELECT * FROM bridge_outbox WHERE id = ?")
      .get(res.outboxId);
    assert.equal(row.state, "pending");
    assert.equal(row.kind, "create");
    const payload = JSON.parse(row.payload_json);
    // §10.7 attribution + §10.8 descriptor fields land in payload_json.
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.publicId, publicId);
    assert.deepEqual(payload.author, {
      id: "42",
      display: "Alice",
      handle: "alice",
      avatarUrl: "https://cdn.discordapp.com/avatars/42/a.png",
    });
    assert.equal(payload.voiceCaption, null);
    assert.equal(payload.attachments.length, 1);
    assert.equal(payload.attachments[0].filename, "note.txt");
    assert.equal(payload.attachments[0].bytes, 5);
    assert.equal(payload.attachments[0].skipReason, null);
    assert.equal(payload.attachments[0].spoolIndex, 0);
    assert.equal(payload.attachments[0].spoiler, true); // flags 1<<3
    // The bytes are on disk under the generated index path.
    assert.equal(
      fs.readFileSync(path.join(tmpDir, "bridge-spool", publicId, "1700000000000000002", "0"), "utf8"),
      "file!",
    );
    assert.equal(fetchImpl.urls[0], "https://cdn.example.test/note.txt");

    // A second enqueue of the same source message is the idempotent replay:
    // the UNIQUE constraint maps to a silent skip (no duplicate row).
    const again = await relay.enqueueBridgeMessage(message, {
      media: { fetchImpl, resolveHost: publicResolve },
    });
    assert.equal(again, null);
  });

  it("a Fluxer voice message enqueues with the `Voice message` caption", async () => {
    const publicId = "b_0v01ce01";
    const bridge = repo.createBridge({
      publicId,
      createdByUserId: "u",
      endACommunityId: rowB.id, // Fluxer end is the create side (a)
      endAChannelId: "M-B2",
      direction: "a_to_b",
      codeHash: null,
    });
    repo.addBridgeEnd({ bridgeId: bridge.id, position: "b", communityId: rowA.id, channelId: "M-A2" });
    db.db.prepare(`UPDATE bridges SET state = 'active', connected_at = ? WHERE id = ?`).run(T0, bridge.id);

    const message = {
      id: "1700000000000000003",
      platform: "fluxer",
      instanceKey: "media.example",
      communityId: rowB.id,
      channelId: "M-B2",
      authorId: "7",
      author: { id: "7", username: "bob" },
      authorDisplayName: "Bob",
      content: "",
      type: 6, // Fluxer voice message
      attachments: [{ id: "v1", name: "voice.ogg", size: 9, contentType: "audio/ogg", url: "https://cdn.example.test/v.ogg" }],
      mentions: { users: [], roles: [], channels: [] },
    };
    const res = await relay.enqueueBridgeMessage(message, {
      media: {
        fetchImpl: recordingFetch("audio!!"),
        resolveHost: publicResolve,
      },
    });
    assert.equal(res.enqueued, true);
    const row = db.db.prepare("SELECT * FROM bridge_outbox WHERE id = ?").get(res.outboxId);
    const payload = JSON.parse(row.payload_json);
    assert.equal(payload.voiceCaption, "Voice message");
    assert.equal(payload.attachments[0].skipReason, null);
    assert.equal(
      fs.readFileSync(path.join(tmpDir, "bridge-spool", publicId, "1700000000000000003", "0"), "utf8"),
      "audio!!",
    );
  });

  it("the 2 GiB process-wide cap refuses a bridge beyond the process budget", async () => {
    // Two bridges; the process budget fits exactly one 10-byte file.
    // (Fresh accounting: the counter is process-global by design.)
    media.resetSpoolAccounting();
    const fetchImpl = recordingFetch("0123456789");
    const opts = {
      fetchImpl,
      resolveHost: publicResolve,
      bridgeSpoolCapBytes: 1000,
      processSpoolCapBytes: 10,
    };
    const first = await media.spoolAttachments({
      publicId: "b_proc0001",
      srcMessageId: "8001",
      attachments: [{ id: "p1", filename: "one.bin", size: 10, url: "https://cdn.test/one.bin" }],
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts,
    });
    assert.equal(first.descriptors[0].skipReason, null);
    const second = await media.spoolAttachments({
      publicId: "b_proc0002",
      srcMessageId: "8001",
      attachments: [{ id: "p2", filename: "two.bin", size: 1, url: "https://cdn.test/two.bin" }],
      destinationPlatform: "discord",
      direction: "a_to_b",
      opts,
    });
    assert.equal(second.descriptors[0].skipReason, "spool-full");
    assert.match(second.notices[0].detail, /process cap 10 bytes/);
  });
});
