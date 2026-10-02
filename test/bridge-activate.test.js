/**
 * Bridge service unit tests (roadmap/bridge.md § Tests — "Pairing",
 * "Pairing-code UX", "Direction", "Media" (payload), "Disconnect",
 * "Permissions", "Command channels", audit rows).
 *
 * Everything runs against a fresh temp SQLite via loadDb() with the service's
 * seams fully faked (resolveChannel / webhook APIs / keyGetter / audit /
 * sendMessage), so no Discord, no Fluxer, no sockets, no real webhooks.
 *
 * PR 4 posture (KD 22): with NO `activateBridge` injected, `connectBridge`
 * refuses with the relay-not-wired sentence BEFORE any webhook create. Every
 * test that exercises the success path injects the real §10.7 step-8 CAS via
 * `service.activateBridgeTx` — the seam the activation PR will wire for real.
 *
 * All §10.2 sentences are asserted as LITERALS (not through BRIDGE_MESSAGES)
 * so a copy edit that drifts from the spec fails here.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { loadDb, communityKey } = require("./helpers/env");

// CONTRACT: loadDb() before every src/ require (fresh temp DB, cache reset).
const { api: db, cleanup } = loadDb();

const service = require("../src/features/bridge/service");
const tokenCrypto = require("../src/features/bridge/tokenCrypto");
const codes = require("../src/features/bridge/codes");
const relay = require("../src/features/bridge/relay");
const repo = require("../src/db/repositories/bridges");
const { getCommunityById } = require("../src/platform/community");

after(() => cleanup?.());

const T0 = 1_700_000_000_000; // fixed epoch ms for clock-injected tests
const KEY = crypto.randomBytes(32).toString("base64"); // valid 32-byte BRIDGE_TOKEN_KEY

const STAFF = { hasManageGuild: true, memberRoleIds: [] };
const NOT_STAFF = { hasManageGuild: false, memberRoleIds: [] };

// Every permission the bridge needs, as a BigInt mask (spec §10.2 probe list).
const FULL_PERMS =
  (1n << 3n) | // Administrator (implies all)
  (1n << 5n) | // Manage Guild
  (1n << 10n) | // View Channel
  (1n << 11n) | // Send Messages
  (1n << 14n) | // Embed Links
  (1n << 15n) | // Attach Files
  1n << 28n; // Manage Webhooks

describe("bridge service (PR 4)", () => {
  /** @type {{ id: number, platform: string, instanceKey: string, externalGuildId: string }} */
  let rowA; // Discord guild community
  /** @type {object} */
  let rowB; // Fluxer community (connect side)
  /** @type {Map<string, object>} "communityId:channelId" → channel facts */
  let channels;
  /** @type {Map<string, object>} "platform:instanceKey" → fake webhook api */
  let webhookApis;
  /** @type {object[]} */
  let audits;
  /** @type {Array<[number, string, string]>} */
  let sent;

  const FULL = () => ({
    type: 0,
    nsfw: false,
    everyoneDeniedView: false,
    invokerPermissions: FULL_PERMS,
    botPermissions: FULL_PERMS,
  });

  /** Register channel facts on both communities (ids are free-form strings). */
  function seedChannels(ids, facts = FULL()) {
    for (const id of ids) {
      channels.set(`${rowA.id}:${id}`, { ...facts });
      channels.set(`${rowB.id}:${id}`, { ...facts });
    }
  }

  /** Record create/delete calls per fake webhook api. */
  function fakeWebhookApi(name, behavior = {}) {
    const created = [];
    const deleted = [];
    return {
      name,
      created,
      deleted,
      async createRelayWebhook(communityId, channelId, opts) {
        created.push({ communityId, channelId, name: opts?.name });
        if (behavior.failCreate) return { ok: false, ...behavior.failCreate };
        const n = created.length;
        return {
          ok: true,
          webhook: { id: `wh-${name}-${n}`, token: `tok-${name}-${n}` },
        };
      },
      async deleteRelayWebhook(webhook) {
        deleted.push(webhook.id);
        if (behavior.failDelete) return { ok: false, error: behavior.failDelete };
        return { ok: true };
      },
    };
  }

  /**
   * Baseline deps: every service seam faked, capture audit + notices.
   * @param {object} [over] deps overrides (keyGetter, activateBridge, …)
   */
  function baseDeps(over = {}) {
    const auditRows = [];
    const sentRows = [];
    audits = auditRows;
    sent = sentRows;
    return {
      resolveChannel: async (community, channelId) => {
        const key = `${community.id}:${String(channelId)}`;
        if (!channels.has(key)) {
          return {
            ok: false,
            error: `channel ${channelId} not found in guild ${community.externalGuildId}`,
          };
        }
        const facts = channels.get(key);
        if (facts && facts.ok === false) return facts;
        return { ok: true, channel: facts };
      },
      sendMessage: async (communityId, channelId, content) => {
        sentRows.push([communityId, String(channelId), content]);
        return { ok: true };
      },
      webhookApiFor: (platform, instanceKey) =>
        webhookApis.get(`${platform}:${instanceKey}`) ?? null,
      keyGetter: () => KEY,
      audit: (entry) => auditRows.push(entry),
      ...over,
    };
  }

  /** The real §10.7 step-8 activator (the seam PR 7 wires in production). */
  const activate = (dbHandle, args) => service.activateBridgeTx(dbHandle, args);

  /**
   * Mint a pairing credential + a pending bridge whose end A sits on the
   * given channel of community A. Every test allocates its OWN channel ids
   * (UNIQUE (community_id, channel_id) makes 1:1 real).
   */
  function mintPending(endAChannelId, overrides = {}) {
    const minted = codes.generateConnectCode();
    const publicId = codes.generatePublicId();
    const bridge = repo.createBridge({
      publicId,
      createdByUserId: overrides.createdByUserId ?? "user-creator",
      endACommunityId: overrides.endACommunityId ?? rowA.id,
      endAChannelId,
      direction: overrides.direction ?? "both",
      expiresAt: overrides.expiresAt ?? T0 + repo.BRIDGE_CODE_LIFETIME_MS,
      codeHash: minted.digest,
    });
    return { bridge, minted, publicId };
  }

  before(() => {
    const communityA = communityKey("900000000000010001");
    const communityB = communityKey("900000000000010002", "fluxer", "fluxer.example:8443");
    rowA = getCommunityById(communityA);
    rowB = getCommunityById(communityB);
    assert.equal(rowA.platform, "discord");
    assert.equal(rowB.platform, "fluxer");

    channels = new Map();
    seedChannels([
      "A-01", "A-02", "A-03", "A-04", "A-05", "A-06", "A-07", "A-08",
      "A-09", "A-10", "A-11", "A-12", "A-13", "A-14", "A-15", "A-16",
      "A-17", "A-18", "A-19", "A-20", "A-21", "A-22", "A-23",
      "B-03", "B-05", "B-06", "B-07", "B-08", "B-11", "B-12", "B-13",
      "B-14", "B-15", "B-16", "B-17", "B-18", "E-01",
      "CH-VOICE", "CH-INVOKER", "CH-BOTPERM", "CH-HP",
    ]);
    channels.set(`${rowA.id}:CH-VOICE`, { ...FULL(), type: 2 });
    channels.set(`${rowA.id}:CH-INVOKER`, { ...FULL(), invokerPermissions: 0n });
    channels.set(`${rowA.id}:CH-BOTPERM`, { ...FULL(), botPermissions: 1n << 10n });
    channels.set(`${rowA.id}:A-06`, { ...FULL(), botPermissions: 1n << 10n });
    channels.set(`${rowA.id}:A-12`, { ...FULL(), nsfw: true });
    channels.set(`${rowB.id}:B-13`, { ...FULL(), everyoneDeniedView: true });

    webhookApis = new Map();
  });

  // -------------------------------------------------------------------------
  // createBridge
  // -------------------------------------------------------------------------

  it("create returns the handle, credential, expiry, and a bridge.create audit row", async () => {
    const deps = baseDeps();
    const res = await service.createBridge({
      community: rowA,
      invocationChannelId: "900",
      targetChannelId: "A-01",
      direction: "to-fluxer",
      actorUserId: "user-creator",
      clock: () => T0,
      staff: STAFF,
      deps,
    });
    assert.equal(res.ok, true, res.error);
    assert.match(res.publicId, /^b_[0123456789acdefghjklmnpqrstuvwxyz]{8}$/);
    assert.match(res.code, /^BRG-/);
    assert.equal(res.expiresAt, T0 + repo.BRIDGE_CODE_LIFETIME_MS);
    assert.equal(res.direction, "a_to_b"); // to-fluxer from Discord = a_to_b (KD 19)

    const stored = repo.getBridgeByPublicId(res.publicId);
    assert.equal(stored.state, "pending");
    assert.equal(stored.direction, "a_to_b");
    assert.equal(stored.created_by_user_id, "user-creator");
    // Only the SHA-256 digest is stored — never the plaintext code.
    assert.equal(stored.code_hash.length, 32);
    assert.ok(repo.getBridgeByCodeHash(codes.hashConnectCode(res.code)));

    const ends = repo.listBridgeEnds(stored.id);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].position, "a");
    assert.equal(ends[0].community_id, rowA.id);
    assert.equal(ends[0].channel_id, "A-01");

    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, "bridge.create");
    assert.equal(audits[0].communityId, rowA.id);
    assert.equal(audits[0].targetType, "channel");
    assert.deepEqual(audits[0].details, {
      publicId: res.publicId,
      channel: "A-01",
      direction: "a_to_b",
      communityIdB: null,
    });
  });

  it("create denies non-staff with the §10.2 sentence", async () => {
    const res = await service.createBridge({
      community: rowA,
      invocationChannelId: "900",
      targetChannelId: "A-02",
      actorUserId: "user-x",
      staff: NOT_STAFF,
      deps: baseDeps(),
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "You don't have permission to use this.");
  });

  it("create rejects an invalid direction token (verbatim, no write)", async () => {
    const res = await service.createBridge({
      community: rowA,
      invocationChannelId: "900",
      targetChannelId: "A-02",
      direction: "sideways",
      actorUserId: "user-x",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(res.ok, false);
    assert.equal(
      res.error,
      "That is not a bridge direction. Use both, to-fluxer, from-fluxer, or leave it out for both.",
    );
  });

  it("create refuses non-text channels, invisible targets, honeypots", async () => {
    const voice = await service.createBridge({
      community: rowA,
      invocationChannelId: "900",
      targetChannelId: "CH-VOICE",
      actorUserId: "u",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      voice.error,
      "Bridges only support a guild text channel. Threads, voice, forums, categories, DMs, and Fluxer voice channels can't be bridged.",
    );

    const invisible = await service.createBridge({
      community: rowA,
      invocationChannelId: "900",
      targetChannelId: "CH-INVOKER",
      actorUserId: "u",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(invisible.error, "You can't view that channel, so you can't bridge it.");

    db.addHoneypotChannel(rowA.id, "CH-HP");
    const hp = await service.createBridge({
      community: rowA,
      invocationChannelId: "900",
      targetChannelId: "CH-HP",
      actorUserId: "u",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      hp.error,
      "That channel is a honeypot. Honeypot channels can't be bridged.",
    );
    db.removeHoneypotChannel(rowA.id, "CH-HP");
  });

  it("create reports an unresolvable channel with a specific cause", async () => {
    const res = await service.createBridge({
      community: rowA,
      invocationChannelId: "900",
      targetChannelId: "9999-not-here",
      actorUserId: "u",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /^I couldn't load channel 9999-not-here: /);
    assert.match(res.error, /Pick a channel the bot can read and try again\.$/);
  });

  it("create distinguishes pending from connected occupants (1:1)", async () => {
    const { publicId } = mintPending("A-02");
    // A pending occupant: pendingExists with the ISO expiry of the stored row.
    const pending = await service.createBridge({
      community: rowA,
      invocationChannelId: "900",
      targetChannelId: "A-02",
      actorUserId: "u",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(pending.ok, false);
    assert.match(
      pending.error,
      new RegExp(
        `^This channel already has a pending bridge \\(${publicId}\\) that expires at \\d{4}-\\d{2}-\\d{2}T.* UTC\\. ` +
          "The pairing code cannot be shown again\\. " +
          `Disconnect it with /bridge disconnect, or wait until it expires\\.$`,
      ),
    );

    // An ACTIVE occupant: channelTaken names the bridge handle.
    const taken = repo.getBridgeEndForChannel(rowA.id, "A-02");
    db.db.prepare(`UPDATE bridges SET state = 'active' WHERE id = ?`).run(taken.bridge_id);
    const connected = await service.createBridge({
      community: rowA,
      invocationChannelId: "900",
      targetChannelId: "A-02",
      actorUserId: "u",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      connected.error,
      `This channel is already in bridge ${publicId}. Disconnect it with /bridge disconnect before creating another.`,
    );
  });

  // -------------------------------------------------------------------------
  // connectBridge — rejection sentences (all leave the row pending)
  // -------------------------------------------------------------------------

  it("connect rejects a handle, alphabet garbage, and empty input", async () => {
    const { publicId } = mintPending("A-03");

    const asHandle = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-03",
      rawCode: publicId,
      actorUserId: "u",
      via: "slash",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      asHandle.error,
      `That is the bridge handle ${publicId}, not the connect credential. Connect will not accept it. Use the BRG- code from create.`,
    );

    const garbage = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-03",
      rawCode: "BRG-OOOO-OOOO-OOOO-OOOO", // O is not in Crockford's alphabet
      actorUserId: "u",
      via: "slash",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      garbage.error,
      "That bridge code has characters a code can't contain. Paste the BRG- code again, with or without the dashes.",
    );

    const empty = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-03",
      rawCode: "   ",
      actorUserId: "u",
      via: "slash",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      empty.error,
      "That bridge code is expired or unknown. Codes last 30 minutes, work once, and cannot be shown again. Create a new one with /bridge create.",
    );
  });

  it("connect: unknown, expired, and already-used codes are terminal for the input", async () => {
    const unknown = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-03",
      rawCode: codes.generateConnectCode().displayCode,
      actorUserId: "u",
      via: "slash",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      unknown.error,
      "That bridge code is expired or unknown. Codes last 30 minutes, work once, and cannot be shown again. Create a new one with /bridge create.",
    );

    const expired = mintPending("A-04", { expiresAt: T0 - 1 }); // already expired
    const expiredRes = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-03",
      rawCode: expired.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      expiredRes.error,
      "That bridge code is expired or unknown. Codes last 30 minutes, work once, and cannot be shown again. Create a new one with /bridge create.",
    );

    // Spend a fresh code, then replay it.
    const pair = mintPending("A-05");
    channels.set(`${rowB.id}:B-11`, FULL());
    webhookApis.set("discord:discord", fakeWebhookApi("TA"));
    webhookApis.set(`fluxer:${rowB.instanceKey}`, fakeWebhookApi("F1"));
    const first = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-11",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(first.ok, true, first.error);
    const replay = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-11",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(
      replay.error,
      `That bridge code was already used to connect bridge ${pair.publicId}.`,
    );
  });

  it("connect on the same platform is a specific refusal (code survives)", async () => {
    const pair = mintPending("A-06");
    const res = await service.connectBridge({
      community: rowA, // Discord code, Discord connect
      invocationChannelId: "900",
      targetChannelId: "A-06",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      res.error,
      "A bridge is one Discord channel and one Fluxer channel. This code was created on Discord; run /bridge connect on the other platform.",
    );
    // Not consumed: the row is still pending.
    assert.equal(repo.getBridgeById(pair.bridge.id).state, "pending");
  });

  it("connect onto a taken destination is refused (code survives)", async () => {
    const pair = mintPending("A-07");
    // Occupy rowB:B-05 with a second bridge (its end A on community B).
    const other = codes.generatePublicId();
    repo.createBridge({
      publicId: other,
      createdByUserId: "u2",
      endACommunityId: rowB.id,
      endAChannelId: "B-05",
      codeHash: codes.generateConnectCode().digest,
    });
    const res = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-05",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(
      res.error,
      `That channel is already in bridge ${other}. Pick a different channel, or disconnect that bridge first.`,
    );
    assert.equal(repo.getBridgeById(pair.bridge.id).state, "pending");
  });

  it("connect: bot permission probe reports missing names in spec order", async () => {
    const pair = mintPending("A-08");
    channels.set(`${rowB.id}:B-06`, { ...FULL(), botPermissions: 1n << 10n }); // View Channel only
    webhookApis.set("discord:discord", fakeWebhookApi("PA"));
    webhookApis.set(`fluxer:${rowB.instanceKey}`, fakeWebhookApi("PB"));
    const res = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-06", // bot sees View Channel only (seeded)
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(
      res.error,
      "I can't bridge this channel: the bot is missing Send Messages, Attach Files, Embed Links, Manage Webhooks. Grant them on the bot role and try again.",
    );
    // A channel whose facts carry NO readable bot mask gets the specific
    // bot-perms-unreadable sentence (BigInt(sentinel) throws in the service).
    channels.set(`${rowB.id}:B-07`, { ...FULL(), botPermissions: "unreadable" });
    const unreadable = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-07",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(
      unreadable.error,
      "I couldn't read my own permissions in channel B-07: the platform returned no permission data. Grant the bot View Channel and try again.",
    );
  });

  it("connect without BRIDGE_TOKEN_KEY fails closed with zero webhook creates", async () => {
    const pair = mintPending("A-09");
    const apiA = fakeWebhookApi("D2");
    const apiB = fakeWebhookApi("F2");
    webhookApis.set("discord:discord", apiA);
    webhookApis.set(`fluxer:${rowB.instanceKey}`, apiB);
    const res = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-08",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ keyGetter: () => undefined, activateBridge: activate }),
    });
    assert.equal(
      res.error,
      "Set BRIDGE_TOKEN_KEY (32 bytes, base64) before connecting a bridge. Webhook tokens are not stored in plaintext.",
    );
    // §10.7: the key check happens BEFORE any webhook create.
    assert.equal(apiA.created.length, 0);
    assert.equal(apiB.created.length, 0);
    // The code stays valid: row still pending with its digest intact.
    const stored = repo.getBridgeById(pair.bridge.id);
    assert.equal(stored.state, "pending");
    assert.ok(stored.code_hash);
  });

  it("connect refuses with the relay-not-wired sentence (PR 4) before any webhook create", async () => {
    const pair = mintPending("A-10");
    const apiA = fakeWebhookApi("D3");
    const apiB = fakeWebhookApi("F3");
    webhookApis.set("discord:discord", apiA);
    webhookApis.set(`fluxer:${rowB.instanceKey}`, apiB);
    const res = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-14",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps(), // NO activateBridge → PR 4 production posture
    });
    assert.equal(
      res.error,
      "Connecting runs through a relay build that is not wired in this process (the activation PR wires it). No channels were paired and the code is still valid.",
    );
    assert.equal(apiA.created.length + apiB.created.length, 0);
    assert.equal(repo.getBridgeById(pair.bridge.id).state, "pending");
  });

  it("connect enforces the per-community failure counter (5 in 10 minutes)", async () => {
    const communityD = communityKey("900000000000010004", "fluxer", "inst4");
    const rowD = getCommunityById(communityD);
    for (let i = 0; i < 5; i += 1) {
      repo.recordBridgeConnectMiss(communityD, { nowMs: T0 });
    }
    const pair = mintPending("A-11");
    const res = await service.connectBridge({
      community: rowD,
      invocationChannelId: "900",
      targetChannelId: "D-01", // facts never needed: the lock gate is FIRST
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0 + 1000, // same 10-minute window
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(
      res.error,
      "Too many failed bridge connect attempts in this community. Wait 10 minutes and try again.",
    );
    // Well-formed misses count; success clears the counter (§10.1).
    const communityE = communityKey("900000000000010005", "fluxer", "inst5");
    const rowE = getCommunityById(communityE);
    channels.set(`${rowE.id}:E-01`, FULL());
    webhookApis.set(`fluxer:${rowE.instanceKey}`, fakeWebhookApi("F4"));
    repo.recordBridgeConnectMiss(communityE, { nowMs: T0 });
    repo.recordBridgeConnectMiss(communityE, { nowMs: T0 });
    assert.equal(repo.getBridgeConnectState(communityE, { nowMs: T0 }).failures, 2);
    const pairE = mintPending("A-19");
    const ok = await service.connectBridge({
      community: rowE,
      invocationChannelId: "900",
      targetChannelId: "E-01",
      rawCode: pairE.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(repo.getBridgeConnectState(communityE, { nowMs: T0 }).failures, 0);
  });

  // -------------------------------------------------------------------------
  // connectBridge — success (pairing matrix) + token crypto + audit
  // -------------------------------------------------------------------------

  it("connect pairs a Fluxer end, encrypts both tokens, and audits both communities", async () => {
    const pair = mintPending("A-20", { direction: "a_to_b" });
    const apiA = fakeWebhookApi("DA");
    const apiB = fakeWebhookApi("FA");
    webhookApis.set("discord:discord", apiA);
    webhookApis.set(`fluxer:${rowB.instanceKey}`, apiB);

    const res = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-15",
      rawCode: pair.minted.displayCode,
      actorUserId: "user-connector",
      via: "slash",
      clock: () => T0 + 60_000,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.publicId, pair.publicId);
    assert.equal(res.direction, "a_to_b");
    assert.equal(res.directionLabel, "Discord → Fluxer");
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(res.peer, {
      platform: "discord",
      platformLabel: "Discord",
      instanceKey: "discord",
      channelId: "A-20",
    });

    // CAS won: active, connected_at from the injected clock.
    const stored = repo.getBridgeById(pair.bridge.id);
    assert.equal(stored.state, "active");
    assert.equal(Number(stored.connected_at), T0 + 60_000);

    // Both ends exist; webhooks named per spec; B created first (§10.7 step 6).
    const ends = repo.listBridgeEnds(pair.bridge.id);
    assert.deepEqual(ends.map((e) => e.position), ["a", "b"]);
    const endB = ends.find((e) => e.position === "b");
    assert.equal(endB.community_id, rowB.id);
    assert.equal(endB.channel_id, "B-15");
    assert.equal(endB.webhook_id, "wh-FA-1");
    const endA = ends.find((e) => e.position === "a");
    assert.equal(endA.webhook_id, "wh-DA-1");
    assert.equal(apiB.created[0].name, "Boiler Snake Bridge");
    assert.equal(apiB.created[0].channelId, "B-15");
    assert.equal(apiA.created[0].name, "Boiler Snake Bridge");
    assert.equal(apiA.created[0].channelId, "A-20");

    // Tokens are AES-256-GCM envelopes at rest; plaintext is nowhere stored.
    for (const end of ends) {
      assert.ok(String(end.webhook_token_enc).startsWith("v1."), "envelope prefix");
      assert.ok(!String(end.webhook_token_enc).includes("tok-"));
    }
    assert.equal(
      tokenCrypto.decryptWebhookToken(endB.webhook_token_enc, { keyGetter: () => KEY }),
      "tok-FA-1",
    );
    assert.equal(
      tokenCrypto.decryptWebhookToken(endA.webhook_token_enc, { keyGetter: () => KEY }),
      "tok-DA-1",
    );

    // Audit (KD 23): one row per community, details exactly {publicId,
    // channel, direction, communityIdB} — no credential, hash, token, body.
    const connectRows = audits.filter((a) => a.action === "bridge.connect");
    assert.equal(connectRows.length, 2);
    const byCommunity = new Map(connectRows.map((a) => [a.communityId, a]));
    assert.deepEqual(byCommunity.get(rowB.id).details, {
      publicId: pair.publicId,
      channel: "B-15",
      direction: "a_to_b",
      communityIdB: rowA.id,
    });
    assert.deepEqual(byCommunity.get(rowA.id).details, {
      publicId: pair.publicId,
      channel: "A-20",
      direction: "a_to_b",
      communityIdB: rowB.id,
    });
    assert.equal(
      JSON.stringify(audits).includes("tok-"),
      false,
      "audit rows must never carry a webhook token",
    );
  });

  it("connect records NSFW and private-channel warnings (§10.7 step 2)", async () => {
    // End A NSFW (A-12), end B not (B-12): asymmetry warns, connect proceeds.
    const pair = mintPending("A-12");
    webhookApis.set(`fluxer:${rowB.instanceKey}`, fakeWebhookApi("F5"));
    const res = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-12",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.warnings, [
      "Warning: one end is age-restricted or NSFW and the other is not. Messages and files will be copied into the less restricted channel.",
    ]);
    // End flags persisted on both ends (A takes its create-side facts, B its own).
    const ends = repo.listBridgeEnds(pair.bridge.id);
    assert.equal(ends.find((e) => e.position === "a").nsfw, 1);
    assert.equal(ends.find((e) => e.position === "b").nsfw, 0);
  });

  it("connect warns when one end is hidden from @everyone", async () => {
    const pair = mintPending("A-13");
    webhookApis.set(`fluxer:${rowB.instanceKey}`, fakeWebhookApi("F6"));
    const res = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-13", // everyoneDeniedView: true (seeded)
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.warnings, [
      "Warning: one end is hidden from @everyone and the other is not. People in the more open channel will be able to read messages from the restricted one.",
    ]);
    const ends = repo.listBridgeEnds(pair.bridge.id);
    assert.equal(ends.find((e) => e.position === "b").everyone_denied_view, 1);
    assert.equal(ends.find((e) => e.position === "a").everyone_denied_view, 0);
  });

  it("tokenCrypto round-trips, rejects the wrong key, and names the missing key", () => {
    const envelope = tokenCrypto.encryptWebhookToken("s3cret-token", {
      keyGetter: () => KEY,
    });
    assert.ok(envelope.startsWith("v1."));
    assert.ok(!envelope.includes("s3cret"));
    assert.equal(
      tokenCrypto.decryptWebhookToken(envelope, { keyGetter: () => KEY }),
      "s3cret-token",
    );

    const otherKey = crypto.randomBytes(32).toString("base64");
    assert.throws(
      () => tokenCrypto.decryptWebhookToken(envelope, { keyGetter: () => otherKey }),
      (err) => err.code === "bridge_token_envelope_invalid",
    );
    assert.throws(
      () => tokenCrypto.decryptWebhookToken(envelope, { keyGetter: () => undefined }),
      (err) => err.code === "bridge_token_key_missing",
    );
    assert.equal(
      tokenCrypto.encryptWebhookToken("x", { keyGetter: () => "not-base64-32-bytes" }),
      null,
    );
    assert.equal(tokenCrypto.hasBridgeTokenKey({ keyGetter: () => KEY }), true);
    assert.equal(tokenCrypto.hasBridgeTokenKey({ keyGetter: () => undefined }), false);
  });

  // -------------------------------------------------------------------------
  // The guild-paste burn path (spec §10.1, retained fallback)
  // -------------------------------------------------------------------------

  it("a guild-channel paste burns the pending row; the code can never activate", async () => {
    const pair = mintPending("A-14");
    const apiA = fakeWebhookApi("D7");
    const apiB = fakeWebhookApi("F7");
    webhookApis.set("discord:discord", apiA);
    webhookApis.set(`fluxer:${rowB.instanceKey}`, apiB);

    // Burn (via "guild" — anyone's paste burns it; not staff-gated).
    const burn = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-16",
      rawCode: pair.minted.displayCode,
      actorUserId: "random-paster",
      via: "guild",
      clock: () => T0,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(burn.ok, true, burn.error);
    assert.equal(burn.burned, true);
    assert.equal(burn.publicId, pair.publicId);
    assert.equal(
      burn.message,
      "That connect command was posted in the channel, so the pairing code is burned and was not used. Create a new one with /bridge create, then DM me /bridge connect <code> <channel>.",
    );
    assert.equal(repo.getBridgeById(pair.bridge.id), null, "burn deletes the row");
    assert.equal(repo.listBridgeEnds(pair.bridge.id).length, 0);
    assert.equal(apiA.created.length + apiB.created.length, 0, "burn creates no webhooks");

    // A post-burn slash connect of the same code: nothing to activate.
    const after = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-16",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(
      after.error,
      "That bridge code is expired or unknown. Codes last 30 minutes, work once, and cannot be shown again. Create a new one with /bridge create.",
    );
  });

  it("a paste racing activation reports already-used, never a half-connect", async () => {
    const pair = mintPending("A-15");
    webhookApis.set(`fluxer:${rowB.instanceKey}`, fakeWebhookApi("F8"));
    const connected = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-17",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(connected.ok, true, connected.error);

    const paste = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-17",
      rawCode: pair.minted.displayCode,
      actorUserId: "late-paster",
      via: "guild",
      clock: () => T0,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(paste.ok, false);
    assert.equal(
      paste.error,
      `That bridge code was already used to connect bridge ${pair.publicId}.`,
    );
    // The active bridge survived the losing paste intact.
    assert.equal(repo.getBridgeById(pair.bridge.id).state, "active");
    assert.equal(repo.listBridgeEnds(pair.bridge.id).length, 2);
  });

  // -------------------------------------------------------------------------
  // disconnectBridge
  // -------------------------------------------------------------------------

  it("disconnect destroys the bridge, notices both ends, and audits both communities", async () => {
    const pair = mintPending("A-16");
    const apiA = fakeWebhookApi("D9");
    const apiB = fakeWebhookApi("F9");
    webhookApis.set("discord:discord", apiA);
    webhookApis.set(`fluxer:${rowB.instanceKey}`, apiB);
    const connected = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-16",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(connected.ok, true, connected.error);

    const res = await service.disconnectBridge({
      community: rowA, // Discord-side staff disconnects by handle
      invocationChannelId: "900",
      publicId: pair.publicId,
      actorUserId: "user-disconnector",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.publicId, pair.publicId);
    assert.deepEqual(res.warnings, []);

    // Row + children gone (the 034 lesson: no orphan ends).
    assert.equal(repo.getBridgeById(pair.bridge.id), null);
    assert.equal(repo.getBridgeEndForChannel(rowA.id, "A-16"), null);
    assert.equal(repo.getBridgeEndForChannel(rowB.id, "B-16"), null);

    // In-channel notice per end: handle + state only (§10.10).
    const expected = `Bridge ${pair.publicId} disconnected. Messages are no longer copied.`;
    assert.deepEqual(sent, [
      [rowA.id, "A-16", expected],
      [rowB.id, "B-16", expected],
    ]);

    // Webhooks deleted on both ends.
    assert.deepEqual(apiA.deleted, ["wh-D9-1"]);
    assert.deepEqual(apiB.deleted, ["wh-F9-1"]);

    // Audit: one bridge.disconnect row per community.
    const rows = audits.filter((a) => a.action === "bridge.disconnect");
    assert.equal(rows.length, 2);
    const byCommunity = new Map(rows.map((a) => [a.communityId, a]));
    assert.deepEqual(byCommunity.get(rowA.id).details, {
      publicId: pair.publicId,
      channel: "A-16",
      direction: "both",
      communityIdB: rowB.id,
    });
    assert.deepEqual(byCommunity.get(rowB.id).details, {
      publicId: pair.publicId,
      channel: "B-16",
      direction: "both",
      communityIdB: rowA.id,
    });
  });

  it("disconnect reports webhook-cleanup failure WITHOUT restoring the row", async () => {
    const pair = mintPending("A-21");
    const apiBFail = fakeWebhookApi("F10", { failDelete: "HTTP 500: server error" });
    webhookApis.set("discord:discord", fakeWebhookApi("D10"));
    webhookApis.set(`fluxer:${rowB.instanceKey}`, apiBFail);
    const connected = await service.connectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-18",
      rawCode: pair.minted.displayCode,
      actorUserId: "u",
      via: "slash",
      clock: () => T0,
      staff: STAFF,
      deps: baseDeps({ activateBridge: activate }),
    });
    assert.equal(connected.ok, true, connected.error);

    const res = await service.disconnectBridge({
      community: rowB,
      invocationChannelId: "900",
      targetChannelId: "B-18", // by channel, no handle
      actorUserId: "u",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0], /^Disconnected bridge /);
    assert.match(
      res.warnings[0],
      /the webhook on the Fluxer end could not be deleted: HTTP 500: server error/,
    );
    assert.match(
      res.warnings[0],
      /Delete the webhook named "Boiler Snake Bridge" in that channel's webhook settings\.$/,
    );
    // The row is gone for good (spec: a failed delete never restores it).
    assert.equal(repo.getBridgeById(pair.bridge.id), null);
  });

  it("disconnect on a bridge that is not mine is refused", async () => {
    // Handle scoped to a community the invoker is not part of.
    const communityF = communityKey("900000000000010006", "fluxer", "inst6");
    const rowF = getCommunityById(communityF);
    const pair = mintPending("A-18");
    const res = await service.disconnectBridge({
      community: rowF,
      invocationChannelId: "900",
      publicId: pair.publicId,
      actorUserId: "u",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      res.error,
      "This channel isn't in a bridge. Use /bridge list to see bridges in this community.",
    );
    assert.ok(repo.getBridgeById(pair.bridge.id), "untouched");
  });

  // -------------------------------------------------------------------------
  // statusBridge / listBridges
  // -------------------------------------------------------------------------

  it("status shows pending state with zero queues; list and empty copy work", async () => {
    const pair = mintPending("A-22");
    const status = service.statusBridge({
      community: rowA,
      invocationChannelId: "900",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(status.ok, true);
    const item = status.items.find((i) => i.publicId === pair.publicId);
    assert.ok(item, "the pending bridge is listed for its create community");
    assert.equal(item.state, "pending");
    assert.equal(item.direction, "both");
    assert.equal(item.directionLabel, "both directions");
    assert.deepEqual(item.outboxDepth, { a_to_b: 0, b_to_a: 0 });
    assert.equal(item.spoolBytes, 0);
    assert.equal(item.ends.length, 1);
    assert.equal(item.ends[0].platform, "discord");

    const list = service.listBridges({
      community: rowA,
      invocationChannelId: "900",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(list.ok, true);
    assert.ok(list.items.some((i) => i.publicId === pair.publicId));
    assert.equal(list.emptyMessage, "This community has no bridges.");

    const communityG = communityKey("900000000000010007", "fluxer", "inst7");
    const empty = service.listBridges({
      community: getCommunityById(communityG),
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.deepEqual(empty.items, []);
  });

  it("status by an unknown handle is specific; non-staff is denied", () => {
    const unknown = service.statusBridge({
      community: rowA,
      publicId: "b_zzzzzzzz",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(
      unknown.error,
      "No bridge b_zzzzzzzz found in this community. Use /bridge list to see the bridges here.",
    );
    const denied = service.statusBridge({
      community: rowA,
      staff: NOT_STAFF,
      deps: baseDeps(),
    });
    assert.equal(denied.error, "You don't have permission to use this.");
  });

  // -------------------------------------------------------------------------
  // Command-channel allow-list: invocation only (§10.2 "Command channels")
  // -------------------------------------------------------------------------

  it("the allow-list gates the invocation channel only", async () => {
    db.addAllowedCommandChannel(rowA.id, "CH-ALLOWED");
    const blocked = await service.createBridge({
      community: rowA,
      invocationChannelId: "CH-NOT-LISTED",
      targetChannelId: "A-01",
      actorUserId: "u",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(blocked.error, "Commands aren't enabled in this channel.");

    // Invocation in the allow-listed channel; TARGET need not be listed.
    const ok = await service.createBridge({
      community: rowA,
      invocationChannelId: "CH-ALLOWED",
      targetChannelId: "A-23",
      actorUserId: "u",
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(ok.ok, true, ok.error);

    // A null invocation channel (Fluxer DM connect) skips the gate.
    const dm = service.listBridges({
      community: rowA,
      invocationChannelId: null,
      staff: STAFF,
      deps: baseDeps(),
    });
    assert.equal(dm.ok, true);

    db.removeAllowedCommandChannel(rowA.id, "CH-ALLOWED");
  });

  // -------------------------------------------------------------------------
  // Direction normalization (KD 19) + relay payload (enqueue content, §10.8)
  // -------------------------------------------------------------------------

  it("direction tokens normalize from each create side", () => {
    assert.deepEqual(service.normalizeCreateDirection("discord", "both"), { ok: true, direction: "both" });
    assert.deepEqual(service.normalizeCreateDirection("discord", "to-fluxer"), { ok: true, direction: "a_to_b" });
    assert.deepEqual(service.normalizeCreateDirection("discord", "from-fluxer"), { ok: true, direction: "b_to_a" });
    assert.deepEqual(service.normalizeCreateDirection("fluxer", "to-discord"), { ok: true, direction: "a_to_b" });
    assert.deepEqual(service.normalizeCreateDirection("fluxer", "from-discord"), { ok: true, direction: "b_to_a" });
    assert.deepEqual(service.normalizeCreateDirection("discord", "to-discord"), { ok: false });
    assert.deepEqual(service.normalizeCreateDirection("fluxer", "to-fluxer"), { ok: false });
    assert.deepEqual(service.normalizeCreateDirection("discord", null), { ok: true, direction: "both" });
    assert.equal(service.directionLabel("a_to_b", "discord", "fluxer"), "Discord → Fluxer");
    assert.equal(service.directionLabel("b_to_a", "discord", "fluxer"), "Fluxer → Discord");
    assert.equal(service.directionLabel("both", "discord", "fluxer"), "both directions");
    assert.equal(service.hasBit(FULL_PERMS, 1n << 28n), true);
    assert.equal(service.missingBotPermNames(1n << 10n).join(", "),
      "Send Messages, Attach Files, Embed Links, Manage Webhooks");
    assert.equal(relay.relayDirectionForEnd("a", "a_to_b"), "a_to_b");
    assert.equal(relay.relayDirectionForEnd("b", "a_to_b"), null);
    assert.equal(relay.relayDirectionForEnd("b", "b_to_a"), "b_to_a");
    assert.equal(relay.relayDirectionForEnd("a", "both"), "a_to_b");
  });

  it("the relay payload neutralizes every mention and flags spoilers", () => {
    const message = {
      id: "1700000000000000001",
      channelId: "A-01",
      authorId: "42",
      author: { id: "42", username: "alice" },
      authorDisplayName: "Alice",
      content: "ping <@42> <@&55> <#77> @everyone @here <@88>",
      mentions: { users: ["42", "88"], roles: ["55"], channels: ["77"], everyone: true },
      mentionUsersRaw: [{ id: "42", username: "alice" }],
      attachments: [{ id: "a1", name: "plan.pdf", size: 10, contentType: "application/pdf", flags: 8 }],
      stickers: [{ id: "s1", name: "party" }],
      embeds: [{ title: "T", description: "D", fields: [{ name: "n", value: "v" }] }],
      type: 0,
    };
    const payload = relay.buildRelayPayload(message, {
      bridge: { id: 1, public_id: "b_test1234", direction: "both" },
      direction: "a_to_b",
      srcCommunityId: 1,
      lookup: relay.mentionLookupFromMessage(message),
    });
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.publicId, "b_test1234");
    assert.equal(payload.srcMessageId, "1700000000000000001");
    assert.equal(payload.author.display, "Alice");
    // Every mention form is neutralized (spec §10.8 / Security): no raw
    // mention tokens, no @everyone/@here, known names rendered.
    assert.ok(!payload.text.includes("<@"));
    assert.ok(!payload.text.includes("<#"));
    assert.ok(!payload.text.includes("@everyone"));
    assert.ok(!payload.text.includes("@here"));
    assert.ok(payload.text.includes("alice")); // resolved user display
    assert.ok(payload.text.includes("#channel")); // id-only fallback
    assert.equal(payload.attachments[0].spoiler, true); // flags bit 1<<3
    assert.equal(payload.attachments[0].skipReason, "spool-not-wired");
    assert.deepEqual(payload.stickers, [{ id: "s1", name: "party" }]);
    assert.equal(payload.embeds[0].title, "T");
  });

  it("the loop gate drops relay webhooks, bot authors, echoes, and !bridge lines", () => {
    relay.clearRelayState();
    const base = { id: "m1", channelId: "A-01", authorId: "5", author: { id: "5" } };

    // Relay-webhook author (per-deployment slice; the Fluxer author.id case).
    relay.registerRelayWebhookId("fluxer", "inst-x", "999999");
    assert.equal(
      relay.createLoopGate({
        ...base,
        platform: "fluxer",
        instanceKey: "inst-x",
        author: { id: "999999", bot: true },
      }),
      true,
    );
    // The same id on ANOTHER deployment is a human there (per-deployment rule).
    assert.equal(
      relay.createLoopGate({ ...base, platform: "discord", instanceKey: "discord", author: { id: "999999" } }),
      false,
    );
    // Bot authors and the deployment's own bot user.
    assert.equal(relay.createLoopGate({ ...base, platform: "discord", authorBot: true }), true);
    relay.setBotUserId("discord", "discord", "777");
    assert.equal(
      relay.createLoopGate({ ...base, platform: "discord", instanceKey: "discord", authorId: "777", author: { id: "777" } }),
      true,
    );
    // Destination-id map (echo of a just-relayed copy).
    relay.noteRelayedDestination("discord", "discord", "5000");
    assert.equal(
      relay.createLoopGate({ ...base, id: "5000", platform: "discord", instanceKey: "discord" }),
      true,
    );
    // The update/delete echo gate shares the durable echo set.
    assert.equal(relay.isRelayedEcho("discord", "discord", "5000"), true);
    assert.equal(relay.isRelayedEcho("fluxer", "other", "5000"), false);
    // A Fluxer guild line that parses as a bridge command is command traffic
    // (KD 17): the gate does NOT swallow the dispatch (the shipped dispatcher
    // is the single entry); isBridgeCommandLine marks it for the pipeline.
    const bridgeLine = {
      ...base,
      platform: "fluxer",
      instanceKey: "inst-x",
      externalGuildId: "900000000000010002",
      content: "!bridge list",
    };
    assert.equal(relay.isBridgeCommandLine(bridgeLine), true);
    assert.equal(relay.createLoopGate(bridgeLine), false);
    // A BOT-authored bridge line is relay/bot traffic: dropped by the gate.
    assert.equal(
      relay.createLoopGate({ ...bridgeLine, authorBot: true, author: { id: "5", bot: true } }),
      true,
    );
    // Not a bridge command: not command traffic.
    assert.equal(
      relay.isBridgeCommandLine({
        ...base,
        platform: "fluxer",
        instanceKey: "inst-x",
        externalGuildId: "900000000000010002",
        content: "!xp show",
      }),
      false,
    );
    // A human chat line on its own deployment passes.
    assert.equal(
      relay.createLoopGate({ ...base, platform: "discord", instanceKey: "discord", content: "hello" }),
      false,
    );
    relay.clearRelayState();
  });
});
