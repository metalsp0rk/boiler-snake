/**
 * Bridge-port notice sends (BRG-11 / #417).
 *
 * `sendNotice` is the ONLY bot-authored send of relay content into a real
 * channel (the §10.7 degraded fallback; plus the plain notices). Two
 * convention layers were silently missing there while every other bot send
 * pins them:
 *  • KD 13 / §10.11 mention disarm — empty allowed_mentions as the SECOND
 *    layer behind body-token neutralization;
 *  • the part's files — "[media attached]" over content-only bytes was a
 *    wire lie when the webhook ladder degraded.
 *
 * Both ports are exercised against a capturing fake outbound — the payload
 * handed to the platform sendChannel is the assertion surface (the wire
 * mapping `allowed_mentions`/multipart is covered by the platform-outbound
 * suites).
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();

const { createDiscordBridgeOutbound } = require("../src/features/bridge/discordOutbound");
const { createFluxerBridgeOutbound } = require("../src/features/bridge/fluxerOutbound");

after(() => cleanup?.());

function captureOutbound(sendChannel) {
  const calls = [];
  return {
    calls,
    fetchMessage: async () => ({ ok: false, error: "unused in these pins" }),
    sendChannel:
      sendChannel ||
      (async (channelId, payload) => {
        calls.push([channelId, payload]);
        return { id: "notice-1" };
      }),
  };
}

function makePort(factory, platform, outbound, sendChannel) {
  const real = outbound || captureOutbound(sendChannel);
  const port = factory({
    platform,
    instanceKey: "unit-417",
    getWebhookApi: () => null,
    getOutbound: () => real,
    keyGetter: () => "k",
  });
  return { port, outbound: real };
}

for (const [label, factory, platform] of [
  ["discord", createDiscordBridgeOutbound, "discord"],
  ["fluxer", createFluxerBridgeOutbound, "fluxer"],
]) {
  describe(`bridge-port sendNotice — ${label} (#417)`, () => {
    it("pins mentions off: allowedMentions NO_PING rides the payload", async () => {
      const { port, outbound } = makePort(factory, platform);
      const res = await port.sendNotice(7, "ch-1", "Bridge b_1 could not copy…");
      assert.equal(res.ok, true);
      const [channelId, payload] = outbound.calls[0];
      assert.equal(channelId, "ch-1");
      assert.deepEqual(
        payload.allowedMentions,
        { parse: [] },
        "KD 13 mandates the empty allowed_mentions layer on EVERY bot send " +
          "— the degraded/notice path was the last one without it",
      );
    });

    it("delivers opts.files to the platform send; omits the key when none", async () => {
      const { port, outbound } = makePort(factory, platform);
      const files = [
        { name: "note.txt", data: Buffer.from("spooled!"), contentType: "text/plain" },
      ];
      await port.sendNotice(7, "ch-1", "[media attached]", { files });
      const withFiles = outbound.calls[0][1];
      assert.equal(withFiles.files?.length, 1, "the resolved bytes must travel");
      assert.equal(withFiles.files[0].name, "note.txt");
      assert.deepEqual(withFiles.files[0].data, Buffer.from("spooled!"));

      await port.sendNotice(7, "ch-1", "plain notice");
      assert.equal(
        "files" in outbound.calls[1][1],
        false,
        "no files key when there are none (payload stays lean)",
      );
    });

    it("a throwing platform send resolves { ok:false } naming the cause (services never throw)", async () => {
      const { port } = makePort(factory, platform, null, async () => {
        throw new Error("50013 Missing Permissions");
      });
      const res = await port.sendNotice(7, "ch-1", "hi");
      assert.equal(res.ok, false);
      assert.match(res.error, /sendNotice: channel ch-1 send failed: 50013/);
    });
  });
}
