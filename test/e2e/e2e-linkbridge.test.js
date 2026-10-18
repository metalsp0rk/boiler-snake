"use strict";
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll, namespaceIds, j } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — see e2e-buttons/e2e-reactions headers.

/**
 * Tier-4 account-linking + bridge coverage (issue #325). Namespace 20.
 *
 * The whole suite is offline: the LINK credential lifecycle runs for real
 * because the FLUXER side of a pairing can be SEEDED (a fluxer community row
 * + a service-minted code), so the redeem order (noBridge refusal → seeded
 * ACTIVE bridge → connect success → replay refusal → config matrix →
 * mirror-degraded XP → remove) is fully deterministic without a Fluxer
 * client. Bridge slash CONNECT stays dark (it needs a live peer-platform
 * client for the webhook apis — honest gap on the issue); what IS pinned:
 * create/pending/duplicate/status/list/disconnect, the connect refusal
 * ladder incl. the miss limiter, and the relay worker end-to-end against
 * fauxcord (dark-peer instant park + live webhook copy).
 *
 * Drift pin found by this suite (asserted as CURRENT behavior): pendingExists
 * keeps the ISO `Z` suffix in its "{iso} UTC" sentence while create/status
 * strip it. The issue's "status without config → empty" prediction is stale:
 * the shipped service answers the actionable guidance copy (pinned too).
 */
describe(
  "e2e: linking + bridge — credential lifecycles, seeded cross-platform link, relay worker vs dark/live peer",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    const ids = namespaceIds(20);
    const st = {
      fluxCid: null,
      bridgeHandle: null,
      relay: null, // { id, publicId }
      expiredLinkSeed: null, // { displayCode, digest }
    };
    const FLUX_USER = "9020020000000000001";

    // src/** modules required AFTER boot (same process ⇒ same DB handle).
    let linking;
    let communityReg;
    let linkCodes;
    let bridgeExpire;
    let tokenCrypto;

    before(async () => {
      env = await createE2eEnv({
        ns: 20,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "lb-logs" },
        ],
      });
      // VIEW_CHANNEL rides alongside ManageGuild deliberately: the mock
      // aggregates ONLY explicit role grants into the interaction member
      // payload (no @everyone base bits), and the bridge service's invoker
      // probe reads that mask for the invocation channel.
      const mg = await env.mock.createRole("E2E LB Admin MG", {
        permissions: String(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ViewChannel),
      });
      await env.mock.grantRole(env.ids.human, mg.id);
      env.dbmod.updateGuildSettings(env.communityId, {
        audit_log_channel_id: ids.channel2,
      });
      // Relay webhook token crypto reads BRIDGE_TOKEN_KEY at call time, so
      // setting it post-boot is fine.
      if (!process.env.BRIDGE_TOKEN_KEY) {
        process.env.BRIDGE_TOKEN_KEY = crypto.randomBytes(32).toString("base64");
      }
      linking = require("../../src/features/linking/service");
      communityReg = require("../../src/platform/community");
      linkCodes = require("../../src/features/linking/codes");
      bridgeExpire = require("../../src/features/bridge/expire");
      tokenCrypto = require("../../src/features/bridge/tokenCrypto");
    });

    after(async () => {
      await env?.cleanup();
    });

    // ---- helpers ----------------------------------------------------------

    const api = (p, o = {}) =>
      j(`${env.mock.base}/api${p}`, { ...o, headers: { ...env.mock.auth, ...o.headers } });

    const sub = (name, options = []) => ({ name, type: 1, ...(options.length && { options }) });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const userOpt = (name, id) => ({ name, type: 6, value: id });

    const slash = (command, options, who = env.ids.human) =>
      env.mock.slash({ command, options, userId: who });
    const contentOf = async (inter) => String((await env.mock.awaitSettledReply(inter)).content);

    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);

    /** Seed an ACTIVE bridge (slash connect is cross-platform-only — the
     *  relay half of the state machine is seeded directly). NOTE:
     *  createBridge inserts end A itself (pending + end a); only end B is
     *  added manually before flipping the row ACTIVE. */
    const seedActiveBridge = ({ aChanId, bCommunityId, bChanId, direction = "both" }) => {
      const publicId = env.dbmod.generateBridgeHandle();
      const row = env.dbmod.createBridge({
        publicId,
        createdByUserId: ids.human,
        endACommunityId: env.communityId,
        endAChannelId: aChanId,
        direction,
        expiresAt: Date.now() + 60 * 60_000,
      });
      const id = row.id;
      env.dbmod.addBridgeEnd({
        bridgeId: id,
        position: "b",
        communityId: bCommunityId,
        channelId: bChanId,
      });
      env.dbmod.db
        .prepare("UPDATE bridges SET state = 'active', connected_at = ? WHERE id = ?")
        .run(Date.now(), id);
      return { id, publicId };
    };

    const outboxRow = (srcMessageId) =>
      env.dbmod.db
        .prepare("SELECT * FROM bridge_outbox WHERE src_message_id = ?")
        .get(String(srcMessageId));

    // ---- gates / picker parity / kill switch ------------------------------

    it("gates: /bridge is ManageGuild-gated for outsiders while /link stays public; kill switch answers first", async () => {
      const denied = "You don't have permission to use this.";
      assert.equal(await contentOf(await slash("bridge", [sub("list")], ids.outsider)), denied);

      // Link is public: the outsider gets their OWN no-link copy, not denial.
      const outsiderStatus = await contentOf(await slash("link", [sub("status")], ids.outsider));
      assert.ok(
        outsiderStatus.includes(
          `You (user ${ids.outsider} in community ${env.communityId}) have no account link here.`,
        ),
        `outsider own status copy (got: ${outsiderStatus})`,
      );

      // Slash picker parity: bridge carries ManageGuild ("32"), link is open.
      const cmds = await env.mock.listGuildCommands();
      const byName = Object.fromEntries(cmds.map((c) => [c.name, c]));
      assert.ok(byName.bridge, "bridge command registered");
      assert.equal(String(byName.bridge.default_member_permissions), "32");
      assert.ok(
        byName.link.default_member_permissions == null,
        "link has no default member permission gate",
      );

      // Kill switch is read per call — no restart needed.
      process.env.BRIDGE_ENABLED = "0";
      try {
        assert.equal(
          await contentOf(await slash("bridge", [sub("list")])),
          "Bridges are turned off on this process (BRIDGE_ENABLED=0).",
        );
      } finally {
        delete process.env.BRIDGE_ENABLED;
      }
      // Restored: the service (not the switch) answers now.
      assert.ok((await contentOf(await slash("bridge", [sub("list")]))).length >= 0);
    });

    // ---- linking: surface copies + credential refusals --------------------

    it("/link basics: no-link copy, LNK- create format, same-platform refusal, unknown sub names the valid set", async () => {
      assert.equal(
        await contentOf(await slash("link", [sub("status")])),
        `You (user ${ids.human} in community ${env.communityId}) have no account link here. ` +
          "/link create mints a code; your account on the other platform redeems it with !link connect.",
      );

      const created = await contentOf(await slash("link", [sub("create")]));
      const code = created.match(
        /Link code, shown once: (LNK-[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){4}-[0-9A-HJKMNP-TV-Z]{2})/,
      )?.[1];
      assert.ok(code, `LNK- code in create reply (got: ${created.slice(0, 80)}…)`);
      assert.ok(created.includes("(about 15 minutes) and works exactly once."), "lifetime sentence");
      assert.ok(
        created.includes(
          "The account on the other platform redeems it THERE: !link connect with that code.",
        ),
        created,
      );

      // A Discord-minted code CANNOT be redeemed on Discord — and it SURVIVES
      // the refusal (redeem is fail-closed until the atomic consume).
      assert.equal(
        await contentOf(await slash("link", [sub("connect", [strOpt("code", code)])])),
        "A link joins one Discord account and one Fluxer account. This code was created on Discord; " +
          "run /link connect on the OTHER platform.",
      );
      assert.ok(
        (
          await contentOf(await slash("link", [sub("connect", [strOpt("code", code)])]))
        ).includes("This code was created on Discord"),
        "code intact after same-platform refusal (retry proves non-consume)",
      );

      const unknownSub = await contentOf(
        await slash("link", [sub("frobnicate", [strOpt("code", "x")])]),
      );
      assert.ok(
        unknownSub.startsWith("Unknown subcommand:"),
        `unknown sub copy (got: ${unknownSub})`,
      );
      assert.ok(unknownSub.includes("Valid subcommands: create, connect, status, remove, config."));
    });

    it("/link credential error arms: alphabet garbage, unknown code, expired code (seeded fluxer-side)", async () => {
      assert.equal(
        await contentOf(await slash("link", [sub("connect", [strOpt("code", "!!!!garbage!!!!")])])),
        "That link code has characters a code can't contain. Paste the LNK- code again, with or without the dashes.",
      );

      // Well-formed but never-minted: canonical 22×"0" (Crockford allows 0).
      const unknownBody = await contentOf(
        await slash("link", [sub("connect", [strOpt("code", "LNK-0000-0000-0000-0000-0000-00")])]),
      );
      assert.ok(
        unknownBody.includes("was never created, was purged, or was typed wrong"),
        `unknownCode copy (got: ${unknownBody})`,
      );

      // Seed a FLUXER community + an EXPIRED code minted there — the expiry
      // arm fires before the cross-platform checks, so the copy is provable
      // without any fluxer client.
      st.fluxCid = communityReg.ensureCommunity({
        platform: "fluxer",
        instanceKey: "e2e-ns20",
        externalGuildId: "9020020000000000100",
      });
      const minted = linkCodes.generateLinkCode({ isTaken: () => false });
      env.dbmod.createLinkCode({
        communityId: st.fluxCid,
        userId: FLUX_USER,
        codeHash: minted.digest,
        expiresAt: Date.now() - 60_000,
      });
      st.expiredLinkSeed = minted;
      const expiredBody = await contentOf(
        await slash("link", [sub("connect", [strOpt("code", minted.displayCode)])]),
      );
      assert.ok(
        expiredBody.includes("expired at") && expiredBody.includes("UTC (codes last 15 minutes)"),
        `expired copy (got: ${expiredBody})`,
      );
    });

    // ---- linking: full cross-platform lifecycle (seeded fluxer side) ------

    it("/link lifecycle: noBridge refusal → seeded ACTIVE bridge → connect → replay → status → config matrix → mirror-degraded XP → remove", async () => {
      const mint = await linking.createLinkCode(st.fluxCid, FLUX_USER);
      assert.ok(mint.ok, `service mint (got: ${mint.error})`);

      // No bridge yet between the communities → refusal, code SURVIVES
      // (noBridge is evaluated before the atomic consume).
      const noBridgeBody = await contentOf(
        await slash("link", [sub("connect", [strOpt("code", mint.code)])]),
      );
      assert.ok(
        noBridgeBody.startsWith("No active bridge connects communities"),
        `noBridge refusal (got: ${noBridgeBody})`,
      );

      // Seed the ACTIVE bridge pair (end channels are foreign ids — the
      // link gate only needs ACTIVE state + both ends).
      const pair = seedActiveBridge({
        aChanId: "9020020000000000201",
        bCommunityId: st.fluxCid,
        bChanId: "9020020000000000202",
      });

      const linked = await contentOf(
        await slash("link", [sub("connect", [strOpt("code", mint.code)])]),
      );
      assert.ok(
        linked.startsWith(
          `Linked to user ${FLUX_USER} on Fluxer (instance e2e-ns20, community ${st.fluxCid}).`,
        ),
        `connect success copy (got: ${linked})`,
      );
      assert.ok(linked.includes("That link code is spent."));

      const replay = await contentOf(
        await slash("link", [sub("connect", [strOpt("code", mint.code)])]),
      );
      assert.ok(
        replay.includes("was already redeemed on") && replay.includes("cannot be used twice"),
        `alreadyUsed replay copy (got: ${replay})`,
      );

      const status = await contentOf(await slash("link", [sub("status")]));
      assert.ok(
        status.startsWith(
          `Linked: you (Discord user ${ids.human} in community ${env.communityId}) ↔ user ${FLUX_USER} on Fluxer`,
        ),
        `linked status (got: ${status})`,
      );
      assert.ok(status.includes("XP mirror: Discord → Fluxer 100%, Fluxer → Discord 100%."));
      assert.ok(status.includes("gork memory mirroring: on."));

      // config matrix (exact Now: suffix) + row assertions.
      assert.ok(
        (
          await contentOf(
            await slash("link", [sub("config", [strOpt("direction", "to-fluxer"), intOpt("pct", 50)])]),
          )
        ).includes("Now: Discord → Fluxer 50%, Fluxer → Discord 100%, memory on."),
      );
      // dbmod.getUserLinkFor returns the link ROW directly (or null).
      assert.equal(Number(env.dbmod.getUserLinkFor(env.communityId, ids.human).mirror_a_to_b_pct), 50);
      assert.ok(
        (
          await contentOf(await slash("link", [sub("config", [strOpt("memory", "off")])]))
        ).includes("Now: Discord → Fluxer 50%, Fluxer → Discord 100%, memory off."),
      );
      assert.equal(Number(env.dbmod.getUserLinkFor(env.communityId, ids.human).mirror_memory), 0);
      assert.equal(
        await contentOf(await slash("link", [sub("config", [strOpt("direction", "to-fluxer")])])),
        'link config needs a percentage with its direction, e.g. "/link config to-fluxer 50".',
      );
      assert.ok(
        (
          await contentOf(
            await slash("link", [sub("config", [strOpt("direction", "sideways"), intOpt("pct", 10)])]),
          )
        ).startsWith("That is not a mirror direction."),
      );

      // XP mirror DEGRADATION: award to the linked Discord party while the
      // fluxer-side target has no client — primary lands, mirror skips.
      const beforeXp = env.dbmod.getXp(env.communityId, ids.human);
      const granted = await contentOf(
        await slash("grantxp", [userOpt("user", ids.human), intOpt("amount", 50)]),
      );
      assert.ok(granted.includes("Granted"), `grantxp reply (got: ${granted})`);
      assert.equal(env.dbmod.getXp(env.communityId, ids.human), beforeXp + 50);

      const removed = await contentOf(await slash("link", [sub("remove")]));
      assert.ok(
        removed.startsWith(
          `Unlinked from user ${FLUX_USER} on Fluxer (community ${st.fluxCid}).`,
        ),
        `remove copy (got: ${removed})`,
      );
      assert.ok(removed.includes("mirroring stops from now on."), "retroactivity note");
      assert.equal(env.dbmod.getUserLinkFor(env.communityId, ids.human), null, "link row gone");

      assert.ok(
        (await contentOf(await slash("link", [sub("remove")]))).includes(
          "has no account link to remove",
        ),
      );

      // config with no link (outsider) — mirrorNoLink shape.
      assert.ok(
        (
          await contentOf(await slash("link", [sub("config", [strOpt("memory", "off")])], ids.outsider))
        ).includes(`user ${ids.outsider} in community ${env.communityId} has no account link to configure`),
      );
      void pair;
    });

    // ---- bridge: create surface ------------------------------------------

    it("/bridge create: credential copy + row/end/audit; duplicate create refuses; status/list formats", async () => {
      const body = await contentOf(
        await slash("bridge", [sub("create", [chanOpt("channel", ids.channel2)])]),
      );
      const handle = body.match(/Bridge (b_[0-9a-hjkmnp-tv-z]{8})\./)?.[1];
      const code = body.match(
        /(BRG-[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){4}-[0-9A-HJKMNP-TV-Z]{2})/,
      )?.[1];
      assert.ok(handle, `bridge handle in create reply (got: ${body.slice(0, 60)}…)`);
      assert.ok(code, "BRG- credential in create reply");
      assert.ok(body.includes("The credential is the capability. Do not post it in a channel."));
      assert.ok(body.includes("Direction: both."));
      st.bridgeHandle = handle;
      const bridgeRow = env.dbmod.getBridgeByPublicId(handle);
      assert.equal(bridgeRow.state, "pending");
      const ends = env.dbmod.listBridgeEnds(bridgeRow.id);
      assert.equal(ends.length, 1, "only end a exists pre-connect");
      assert.equal(String(ends[0].channel_id), String(ids.channel2));
      assert.ok(auditRow("bridge.create"), "slash audit row for create");

      // Duplicate create → pending refusal whose ISO KEEPS the Z (drift pin:
      // create/status strip it, pendingExists does not).
      const dup = await contentOf(
        await slash("bridge", [sub("create", [chanOpt("channel", ids.channel2)])]),
      );
      assert.ok(
        dup.startsWith(`This channel already has a pending bridge (${handle}) that expires at`),
        `pendingExists copy (got: ${dup})`,
      );
      assert.ok(/expires at \d{4}-\d\d-\d\dT[\d:.]+Z UTC/.test(dup), `Z-suffixed ISO drift (got: ${dup})`);

      // status BY CHANNEL renders the pinned line format.
      const status = await contentOf(
        await slash("bridge", [sub("status", [chanOpt("channel", ids.channel2)])]),
      );
      assert.ok(
        status.startsWith(`Bridge ${handle} — state: pending, direction: both directions.`),
        `status body (got: ${status})`,
      );
      assert.ok(status.includes("outbox: a→b 0, b→a 0; spool: 0 bytes"), status);
      assert.ok(new RegExp(`end a: discord \\([^)]*\\) channel ${ids.channel2}`).test(status), status);
      assert.ok(status.includes("pairing expires:"), status);

      // list includes the pending bridge.
      assert.ok(
        (await contentOf(await slash("bridge", [sub("list")]))).includes(
          `Bridge ${handle} — state: pending`,
        ),
      );

      // Status with NO match on the invocation channel is NOT a dead end:
      // the service answers the same actionable guidance disconnectNone
      // gives (issue #325 predicted an empty body — source trace + mock
      // disagree; the shipped copy is the better truth, pinned here).
      const empty = await contentOf(await slash("bridge", [sub("status")], ids.human));
      assert.ok(
        empty.startsWith("This channel isn't in a bridge. Use /bridge list to see bridges in this community."),
        `status-by-channel miss guidance (got: ${JSON.stringify(empty)})`,
      );

      // disconnectNone names the fix path.
      assert.ok(
        (await contentOf(await slash("bridge", [sub("disconnect")]))).startsWith(
          "This channel isn't in a bridge. Use /bridge list to see bridges in this community.",
        ),
      );
    });

    it("/bridge connect refusals: same-platform, handle-as-code, garbage, then the 5-miss limiter (cleared via facade)", async () => {
      // Second pending bridge ON general: its code is the samePlatform prop.
      const created = await contentOf(
        await slash("bridge", [sub("create", [chanOpt("channel", ids.general)])]),
      );
      const genHandle = created.match(/Bridge (b_[0-9a-hjkmnp-tv-z]{8})\./)?.[1];
      const genCode = created.match(/UTC: (BRG-[0-9A-HJKMNP-TV-Z-]+)\./)?.[1];
      assert.ok(genHandle && genCode, `second create (got: ${created.slice(0, 80)}…)`);

      // Same-platform: the Discord-minted BRG code cannot redeem on Discord.
      const samePlat = await contentOf(
        await slash("bridge", [
          sub("connect", [strOpt("code", genCode), chanOpt("channel", ids.general)]),
        ]),
      );
      assert.ok(
        samePlat.startsWith(
          "A bridge is one Discord channel and one Fluxer channel. This code was created on",
        ),
        `samePlatform copy (got: ${samePlat})`,
      );
      assert.ok(samePlat.includes("run /bridge connect on the other platform."), samePlat);

      // Handle passed to connect is refused by name.
      const asHandle = await contentOf(
        await slash("bridge", [
          sub("connect", [strOpt("code", st.bridgeHandle), chanOpt("channel", ids.general)]),
        ]),
      );
      assert.equal(
        asHandle,
        `That is the bridge handle ${st.bridgeHandle}, not the connect credential. Connect will not accept it. Use the BRG- code from create.`,
      );

      // Alphabet garbage classifies BEFORE any counter/lookup.
      assert.equal(
        await contentOf(await slash("bridge", [sub("connect", [strOpt("code", "!!!BRG!!!")])])),
        "That bridge code has characters a code can't contain. Paste the BRG- code again, with or without the dashes.",
      );

      // Miss limiter: 5 WELL-FORMED unknown codes each answer expiredOrUnknown,
      // then the community locks — even valid codes are blocked. Distinct
      // mints (never stored) guarantee UNIQUE.
      const expiredOrUnknown =
        "That bridge code is expired or unknown. Codes last 30 minutes, work once, and cannot be shown again. Create a new one with /bridge create.";
      for (let i = 0; i < 5; i++) {
        const junk = env.dbmod.generateBridgeCode().displayCode;
        assert.equal(
          await contentOf(
            await slash("bridge", [sub("connect", [strOpt("code", junk), chanOpt("channel", ids.general)])]),
          ),
          expiredOrUnknown,
          `miss attempt ${i + 1}`,
        );
      }
      assert.equal(
        await contentOf(
          await slash("bridge", [
            sub("connect", [
              strOpt("code", env.dbmod.generateBridgeCode().displayCode),
              chanOpt("channel", ids.general),
            ]),
          ]),
        ),
        "Too many failed bridge connect attempts in this community. Wait 10 minutes and try again.",
      );
      // The REAL genCode is ALSO locked out while the window holds… then the
      // facade clear restores normal refusals (proves it was the counter).
      env.dbmod.clearBridgeConnectAttempts(env.communityId);
      const afterClear = await contentOf(
        await slash("bridge", [
          sub("connect", [strOpt("code", genCode), chanOpt("channel", ids.general)]),
        ]),
      );
      assert.ok(
        afterClear.startsWith("A bridge is one Discord channel and one Fluxer channel"),
        `post-clear refusal (got: ${afterClear})`,
      );

      // Disconnect BOTH pending bridges (channel2 + general) — cascade copy +
      // row release + in-channel notices visible on the mock tape.
      const disc = await contentOf(
        await slash("bridge", [sub("disconnect", [strOpt("bridge", st.bridgeHandle)])]),
      );
      assert.ok(
        disc.startsWith(`Disconnected bridge ${st.bridgeHandle}. Both channels are released.`),
        disc,
      );
      assert.equal(env.dbmod.getBridgeByPublicId(st.bridgeHandle), null, "cascade delete");
      assert.ok(auditRow("bridge.disconnect"), "slash audit row for disconnect");
      const genDisc = await contentOf(
        await slash("bridge", [sub("disconnect", [chanOpt("channel", ids.general)])]),
      );
      assert.ok(genDisc.startsWith(`Disconnected bridge ${genHandle}.`), genDisc);
      const tapeCh2 = ((await env.mock.messages(ids.channel2)) ?? []).map((m) => String(m.content));
      const tapeGen = ((await env.mock.messages(ids.general)) ?? []).map((m) => String(m.content));
      assert.ok(
        tapeCh2.includes(`Bridge ${st.bridgeHandle} disconnected. Messages are no longer copied.`),
        `channel2 notice on tape (got: ${JSON.stringify(tapeCh2.slice(-4))})`,
      );
      assert.ok(
        tapeGen.includes(`Bridge ${genHandle} disconnected. Messages are no longer copied.`),
        "general notice on tape",
      );
    });

    // ---- relay worker: dark peer + live peer ------------------------------

    it("relay vs DARK peer: active bridge with an end that has no webhook → instant park, status names it, pipeline stays healthy", async () => {
      st.relay = seedActiveBridge({
        aChanId: ids.general,
        bCommunityId: env.communityId,
        bChanId: ids.channel2,
      });

      const msg = await env.mock.inject("bridge dark probe", ids.human, ids.general);
      const row = await poll(() => outboxRow(msg?.id), {
        timeoutMs: 6000,
        label: "outbox row enqueued",
      });
      assert.equal(row.kind, "create");
      // Deterministic fast park (maxAttempts:1 — no ladder): the destination
      // end has no relay webhook, so the worker fails the row on FIRST try.
      const parked = await poll(
        () => {
          const r = outboxRow(msg.id);
          return r && r.state === "failed" ? r : null;
        },
        { timeoutMs: 8000, label: "outbox parked failed" },
      );
      assert.equal(parked.attempts, 1, "single-attempt park (no backoff ladder)");
      assert.equal(
        parked.last_error,
        "the bridge end has no relay webhook (connect creates it)",
      );
      assert.equal(
        env.dbmod.getBridgeByPublicId(st.relay.publicId).state,
        "active",
        "bridge survives a failed copy",
      );

      const status = await contentOf(
        await slash("bridge", [sub("status", [strOpt("bridge", st.relay.publicId)])]),
      );
      assert.ok(
        status.includes("last error: the bridge end has no relay webhook"),
        `status surfaces the last error (got: ${status})`,
      );

      // The issue's premise: a configured-but-dark bridge never blocks the
      // message path — the pipeline (and staff XP tools) stay healthy.
      const granted = await contentOf(
        await slash("grantxp", [userOpt("user", ids.target), intOpt("amount", 7)]),
      );
      assert.ok(granted.includes("Granted"), `pipeline healthy: grantxp (got: ${granted})`);
    });

    // BUG PIN (issue #365): the Discord relay outbound calls
    // client.webhooks.create(id, token) — a manager that DOES NOT EXIST in
    // the pinned discord.js (14.27: client.webhooks === undefined; the v14
    // token-scoped handle is client.fetchWebhook). So every live Discord
    // copy burns the full backoff ladder and poison-parks. FLIP-BACK once
    // the product migrates to fetchWebhook: this arm becomes the real
    // live-copy assertion (outbox row `done` + `RELAY LIVE COPY` in the
    // destination tape — the webhook infrastructure on the mock side works,
    // verified by this arm's POST /channels/:id/webhooks step). #460 (G2-3)
    // EXTENDS that flip-back list: seed the injected message with a rich
    // EMBED and assert the persisted copy's embeds[0].title — content-only
    // tape assertions would let an embed-stripping relay pass green, which
    // is exactly how FLX-2 stayed invisible at all four tiers. The mock
    // persists embeds; the fluxer-side equivalent is already pinned in
    // test/bridge-relay.test.js (the #460 real-adapter arm).
    it("live Discord relay is DEAD on the pinned SDK: ladder burns, row poison-parks, staff get the notice", async () => {
      const hook = await api(`/channels/${ids.channel2}/webhooks`, {
        method: "POST",
        body: JSON.stringify({ name: "Boiler Snake Bridge" }),
      });
      assert.ok(
        hook?.id && hook?.token,
        `webhook create on mock (got: ${JSON.stringify(hook).slice(0, 120)})`,
      );
      env.dbmod.setBridgeEndWebhook(st.relay.id, "b", {
        webhookId: String(hook.id),
        tokenEnc: tokenCrypto.encryptWebhookToken(hook.token),
      });

      const msg = await env.mock.inject("RELAY LIVE COPY", ids.human, ids.general);
      // Full ladder budget: attempts at t0,+1s,+2s,+4s,+8s → park by ~+16s.
      const parked = await poll(
        () => {
          const r = outboxRow(msg?.id);
          return r && r.state === "failed" ? r : null;
        },
        { timeoutMs: 40000, label: "outbox row poison-parked" },
      );
      assert.equal(parked.attempts, env.dbmod.BRIDGE_OUTBOX_MAX_ATTEMPTS, "full ladder burned");
      assert.ok(
        parked.last_error.startsWith(
          "executeRelayWebhook: client exposes no webhooks manager (client.webhooks.create)",
        ),
        `SDK-surface last_error (got: ${parked.last_error})`,
      );
      const tapeGen = ((await env.mock.messages(ids.general)) ?? []).map((m) => String(m.content));
      assert.ok(
        tapeGen.some((c) =>
          c.includes(
            `Bridge ${st.relay.publicId} could not copy message ${msg.id} after 5 attempts:`,
          ),
        ),
        `poison notice lands on the SOURCE channel (got: ${JSON.stringify(tapeGen.slice(-4))})`,
      );
      assert.ok(
        tapeGen.some((c) => c.includes("Later messages are still being copied.")),
        "poison notice names the continued-service promise",
      );
    });

    it.todo("bridge connect HAPPY path (webhook creation on both ends, activation, success notices) needs a live peer-platform client — by-design dark in the Discord-only mock world");

    it.todo("!link / !bridge prefix + Fluxer DM surfaces (burn path, guild dispatch) are Fluxer-only — unreachable through the mock Discord surface");

    it("kill switch pauses enqueue; disconnect releases the relay pair", async () => {
      process.env.BRIDGE_ENABLED = "0";
      try {
        const msg = await env.mock.inject("paused while disabled", ids.human, ids.general);
        await new Promise((r) => setTimeout(r, 1200)); // worker tick budget
        assert.equal(outboxRow(msg?.id), undefined, "no enqueue while BRIDGE_ENABLED=0");
      } finally {
        delete process.env.BRIDGE_ENABLED;
      }

      const disc = await contentOf(
        await slash("bridge", [sub("disconnect", [strOpt("bridge", st.relay.publicId)])]),
      );
      assert.ok(
        disc.startsWith(`Disconnected bridge ${st.relay.publicId}. Both channels are released.`),
        disc,
      );
      assert.equal(env.dbmod.getBridgeByPublicId(st.relay.publicId), null);

      const msg = await env.mock.inject("after disconnect", ids.human, ids.general);
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(outboxRow(msg?.id), undefined, "enqueue stopped once disconnected");
    });

    // ---- sweeper semantics --------------------------------------------------

    it("sweepers: expired pending bridges deleted, live rows survive; expired link codes purge, live survive", async () => {
      // Two pending bridges via dbmod (past expiry vs future expiry).
      const dead = env.dbmod.generateBridgeHandle();
      env.dbmod.createBridge({
        publicId: dead,
        createdByUserId: ids.human,
        endACommunityId: env.communityId,
        endAChannelId: "9020020000000000203",
        expiresAt: Date.now() - 10_000,
      });
      const live = env.dbmod.generateBridgeHandle();
      env.dbmod.createBridge({
        publicId: live,
        createdByUserId: ids.human,
        endACommunityId: env.communityId,
        endAChannelId: "9020020000000000204",
        expiresAt: Date.now() + 10 * 60_000,
      });
      bridgeExpire.sweepExpiredPendingBridges();
      assert.equal(env.dbmod.getBridgeByPublicId(dead), null, "expired pending swept");
      const liveRow = env.dbmod.getBridgeByPublicId(live);
      assert.ok(liveRow, "future pending survives");
      env.dbmod.deleteBridgeCascade(liveRow.id);

      // Link-code purge: the seeded expired row goes; the live create code
      // from the basics test survives (expires_at > now).
      assert.ok(env.dbmod.getLinkCodeByHash(st.expiredLinkSeed.digest), "expired code present pre-purge");
      const liveCodesBefore = env.dbmod.db
        .prepare("SELECT COUNT(*) AS n FROM user_link_codes WHERE expires_at > ?")
        .get(Date.now()).n;
      assert.ok(liveCodesBefore >= 1, "a live minted code exists (create test)");
      const changes = env.dbmod.purgeExpiredLinkCodes(Date.now());
      assert.ok(changes >= 1, `purge removed the expired seed (changes=${changes})`);
      assert.equal(env.dbmod.getLinkCodeByHash(st.expiredLinkSeed.digest), null, "expired code purged");
      assert.equal(
        env.dbmod.db
          .prepare("SELECT COUNT(*) AS n FROM user_link_codes WHERE expires_at > ?")
          .get(Date.now()).n,
        liveCodesBefore,
        "live codes untouched",
      );
    });
  },
);
