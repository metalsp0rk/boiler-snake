/**
 * #475 (F1-5): every audit-channel send carries USER-AUTHORED text (gork
 * Q&A, warnings, note bodies). Pre-fix the payloads carried no mention
 * control at all: Discord-inert only by platform accident (embeds don't
 * notify), while the Fluxer send path parses mention markup with DEFAULT
 * rules when the field is absent — the staff channel sat one hostile
 * question away from becoming a ping cannon.
 *
 * The fix stamps `allowedMentions: { parse: [] }` at the ONE choke every
 * log send passes (logs/auditLog.js sendToLogChannel): nothing to forget
 * at future call sites, and an explicit caller value is respected.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");
const { api, cleanup } = loadDb(); // CONTRACT: fresh DB before any src/ require

const auditLog = require("../src/features/logs/auditLog");

after(cleanup);

const GUILD_SNOW = "780000000000000001";
const AUDIT_CH = "780000000000000002";

describe("audit-log sends are mention-neutral at the choke (#475 F1-5)", () => {
  let cid;

  before(() => {
    cid = communityKey(GUILD_SNOW);
    api.updateGuildSettings(cid, { audit_log_channel_id: AUDIT_CH });
  });

  /** Outbound fake: resolves the audit channel + records every payload. */
  function fakeOutbound() {
    const sent = [];
    return {
      sent,
      async fetchChannel(communityId, channelId) {
        return channelId === AUDIT_CH ? { id: channelId, isTextBased: () => true } : null;
      },
      async sendChannel(channelId, payload) {
        sent.push({ channelId, payload });
        return { ok: true };
      },
    };
  }

  it("sendAuditLog stamps parse-off when the caller said nothing", async () => {
    const ob = fakeOutbound();
    const ok = await auditLog.sendAuditLog(ob, cid, {
      embeds: [{ description: "question: can everyone @here see this?" }],
    });
    assert.equal(ok, true);
    assert.equal(ob.sent.length, 1);
    assert.deepEqual(ob.sent[0].payload.allowedMentions, { parse: [] });
    assert.ok(ob.sent[0].payload.embeds, "the payload itself rides untouched");
  });

  it("the gork stream (fallback to the audit channel) is stamped too", async () => {
    const ob = fakeOutbound();
    const ok = await auditLog.sendGorkLog(ob, cid, "plain string payload survives");
    assert.equal(ok, true);
    // Strings carry no field surface — they pass through untouched (the
    // Fluxer adapter receives what the caller wrote; object payloads are
    // where the stamp lives).
    assert.equal(ob.sent[0].payload, "plain string payload survives");
  });

  it("an explicit allowedMentions is RESPECTED, never widened or replaced", async () => {
    const ob = fakeOutbound();
    await auditLog.sendAuditLog(ob, cid, {
      content: "explicit",
      allowedMentions: { parse: ["users"], repliedUser: false },
    });
    assert.deepEqual(ob.sent[0].payload.allowedMentions, {
      parse: ["users"],
      repliedUser: false,
    });
  });

  it("no second spelling: the stamp lives ONCE, in sendToLogChannel", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "features", "logs", "auditLog.js"),
      "utf8"
    );
    const stamps = src.match(/allowedMentions: \{ parse: \[\] \}/g) || [];
    assert.equal(stamps.length, 1, "one choke — per-call-site stamps are how #368-class drift starts");
    assert.match(
      src,
      /deliverLogPayload\(\s*outbound,\s*guildId,\s*kind,\s*stampNoMentions\(payload\)\s*\)/,
      "EVERY send (audit/message/warn/gork) passes the stamp"
    );
  });
});
