const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { namespaceIds, poll } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — importing anything that pulls in the db
// before createE2eEnv() sets the env vars silently binds the dev database.

/**
 * Tier-4 ban-appeals FERRY coverage — issue #851.
 *
 * The inbound lane (the banned user's DM → appeal-ticket relay) rides
 * guild-less MESSAGE_CREATE. Production never received it: src/client.js
 * did not subscribe to DirectMessages, and real Discord only dispatches
 * DMs to subscribers — while fauxcord gated DM dispatch on GuildMessages,
 * so the mock happily delivered and every suite stayed green. This suite
 * drives BOTH relay directions end to end through the real gateway:
 *
 *  1. inbound: seed an active ban record + an OPEN appeal bound to a
 *     provisioned ticket channel (the intake/button machinery that creates
 *     this state is integration-suite territory; here the seed isolates the
 *     DELIVERY lane), open the DM, inject the prisoner's message, and prove
 *     the signed relay copy lands in the ticket channel;
 *  2. outbound: inject a staff reply into the ticket channel and prove the
 *     copy lands in the prisoner's DM (REST-side, belt for the same lane).
 *
 * With the fauxcord patch's #851 fidelity fix the mock gates DM
 * MESSAGE_CREATE on DirectMessages (like Discord), so dropping the intent
 * turns row 1 RED — the regression pin #851 demands.
 */
describe(
  "e2e: ban-appeals ferry — inbound DM relay + outbound DM relay (#851)",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    const ids = namespaceIds(23);
    const ticket = () => ids.channel2; // provisioned "appeal-ticket" channel

    before(async () => {
      env = await createE2eEnv({
        ns: 23,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "appeal-ticket" },
        ],
      });
    });

    after(async () => {
      await env?.cleanup();
    });

    /**
     * Seed a ban record + OPEN appeal whose ticket channel is the
     * provisioned appeal-ticket channel (same rows intake/ticket.js would
     * have created; the ferry engine only reads them).
     */
    function seedOpenAppeal(userId) {
      const rec = env.dbmod.createBanRecord({
        communityId: env.communityId,
        userId,
        moderatorId: ids.app,
        source: "staff",
        reason: "e2e: ferry delivery lane",
      });
      assert.equal(rec.ok, true, `ban record seed failed: ${rec.error}`);
      const filed = env.dbmod.fileAppeal({
        communityId: env.communityId,
        banRecordId: rec.record.id,
        appealStatement: "I take responsibility and would like to return.",
      });
      assert.equal(filed.ok, true, `appeal seed failed: ${filed.error}`);
      const attach = env.dbmod.attachAppealTicketChannel(filed.appeal.id, ticket());
      assert.equal(attach.ok, true, `ticket attach failed: ${attach.error}`);
      const opened = env.dbmod.openAppeal(filed.appeal.id);
      assert.equal(opened.ok, true, `appeal open failed: ${opened.error}`);
      assert.equal(opened.appeal.status, "open");
      return filed.appeal;
    }

    const tapeOf = async (channelId) =>
      (await env.mock.messages(channelId)).map((m) => String(m.content ?? ""));

    it("inbound lane: the prisoner's DM relays into the appeal ticket (#851)", async () => {
      seedOpenAppeal(ids.target);

      // The prisoner writes into their DM with the bot (a real user just
      // types — POST /users/@me/channels is idempotent, mirroring Discord).
      const dm = await env.mock.openDmChannel(ids.target);
      assert.ok(dm?.id, "mock opened the prisoner DM channel");
      const sent = await env.mock.inject(
        "i never stole that meme — can i explain",
        ids.target,
        dm.id,
      );
      assert.ok(sent?.id, "mock injected the prisoner DM message");

      // The gateway (not any test hook) must carry the DM MESSAGE_CREATE to
      // the bot: DirectMessages-gated since the #851 patch. The signed copy
      // lands in the ticket channel.
      const relayed = await poll(
        async () =>
          (await env.mock.messages(ticket())).find(
            (m) =>
              String(m.author?.bot) === "true" &&
              String(m.content ?? "").includes("never stole that meme"),
          ) ?? null,
        { timeoutMs: 10_000, label: "ferry relay copy in the ticket channel" },
      );
      assert.ok(relayed, "prisoner DM never reached the ticket channel — the #851 dead-lane symptom");
      assert.match(String(relayed.content), new RegExp(String(ids.target)),
        "the relay copy must carry the signed author id");

      // Belt: the same text must NOT also appear as a plain user message.
      const plain = (await tapeOf(ticket())).filter((c) => c.includes("never stole that meme"));
      assert.equal(plain.length, 1, "exactly one copy (the relay) lands in the ticket");
    });

    it("inbound lane stays dark for users with no open appeal", async () => {
      const dm = await env.mock.openDmChannel(ids.outsider);
      await env.mock.inject("hello? anyone there?", ids.outsider, dm.id);
      // Give any (incorrect) relay a chance to race in before declaring dark.
      await new Promise((resolve) => setTimeout(resolve, 750));
      const leaks = (await tapeOf(ticket())).filter((c) => c.includes("anyone there?"));
      assert.equal(leaks.length, 0, "a DM from an appeal-less user must relay nothing");
    });

    it("outbound lane: a staff reply in the ticket lands in the prisoner DM (#851)", async () => {
      const staffMsg = "review board meets friday — say your piece";
      await env.mock.inject(staffMsg, ids.human, ticket());

      const dms = await poll(
        async () => {
          const list = await env.mock.dmMessages(ids.target);
          return list.some((m) => String(m.content ?? "").includes(staffMsg)) ? list : null;
        },
        { timeoutMs: 10_000, label: "staff relay copy in the prisoner DM" },
      );
      assert.ok(dms, "staff ticket reply never reached the prisoner DM");
      // §6/§3: the DM copy signs WHO spoke (name) and never leaks the staff id.
      const copy = dms.find((m) => String(m.content ?? "").includes(staffMsg));
      assert.ok(
        String(copy.content).includes("E2EOperator") || String(copy.content).match(/\*\*/),
        "the outbound copy carries the staff signature",
      );
    });
  },
);
