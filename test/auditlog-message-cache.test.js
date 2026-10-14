/**
 * Issue #200 (audit §6 P2): the message-content cache (pipeline step 3) must
 * key platform-neutrally. Before #200 cacheMessage duck-typed `message.guild`
 * — a Discord-only field — so a NORMALIZED FLUXER MESSAGE (the shape the
 * shared pipeline actually carries, with the integer communityId on it)
 * reached the step and silently cached NOTHING: the pipeline-effect test's
 * "message cache row" was unobservable for the new platform, the exact
 * duck-field death class the audit named. Discord duck/raw behavior stays
 * byte-identical (guild-id resolve, tag, createdTimestamp).
 *
 * Issue #277 REVERSAL (sanctioned "drop" alternative): with #200 fixed, the
 * Fluxer write became observable but stayed CONSUMER-LESS — the cache's only
 * readers are the Discord delete-audit paths, and the Fluxer edit/delete
 * intake resolves link rows, never the cache. The write is therefore dropped
 * at the cacheMessage seam (gate on the contract's platform field), so the
 * modern Fluxer assertion is ZERO rows, not a keyed row. Re-enabling the
 * write requires the consumer + a read-path test; until then the platform-
 * neutral keying below stays exercised by the READ path and Discord shapes.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();
const auditLog = require("../src/features/logs/auditLog");

after(cleanup);

describe("logs message cache — platform-neutral keys (issue #200) + Fluxer write drop (issue #277)", () => {
  it("writes ZERO cache rows for a normalized Fluxer message (issue #277 drop)", () => {
    const fluxerCommunity = communityKey("1554590611015729888", "fluxer", "https://cache.test");
    const msg = {
      platform: "fluxer",
      instanceKey: "https://cache.test",
      // The integer community id IS resolved (the pipeline resolves it at
      // step 2b before step 3 runs): the drop must come from the platform
      // gate, never from an unresolved-community side effect.
      communityId: fluxerCommunity,
      id: "500",
      channelId: "700",
      authorId: "42",
      authorBot: false,
      authorDisplayName: "Talker G",
      content: "cache me not",
      // The real SDK User instance rides as authorRaw (username is what the
      // surfaces read — see the issue #200 User contract pins).
      authorRaw: { username: "talker" },
      createdAt: new Date("2026-10-11T12:00:00.000Z"),
      attachments: [{ name: "a.png", url: "https://media.test/a.png" }],
      embeds: [{ title: "E", description: "D" }],
    };
    auditLog.cacheMessage(msg);

    assert.equal(
      auditLog.getCachedMessage(msg),
      null,
      "#277 drop: normalized Fluxer messages write NO cache row (the #200 write had no consumer)",
    );
    assert.equal(
      auditLog.takeCachedMessage(msg),
      null,
      "and nothing to take — no Fluxer row ever lands",
    );
  });

  it("still caches nothing for bot authors or community-less messages", () => {
    const fluxerCommunity = communityKey("1554590611015729888", "fluxer", "https://cache.test");
    auditLog.cacheMessage({ id: "501", communityId: fluxerCommunity, authorBot: true, content: "bot" });
    assert.equal(auditLog.getCachedMessage({ id: "501", communityId: fluxerCommunity }), null);

    auditLog.cacheMessage({ id: "502", content: "community resolve failed — fail closed" });
    assert.equal(auditLog.getCachedMessage({ id: "502" }), null);
  });

  it("Discord duck-shape behavior is unchanged (guild-id resolve, tag, raw timestamp)", () => {
    communityKey("900000000000000101"); // discord community row
    const msg = {
      id: "503",
      guild: { id: "900000000000000101" },
      author: { id: "7", tag: "u#0001", username: "u" },
      channel: { id: "9" },
      content: "d",
      createdTimestamp: 123,
    };
    auditLog.cacheMessage(msg);

    const entry = auditLog.getCachedMessage(msg);
    assert.ok(entry, "raw discord messages keep caching through the guild id");
    assert.equal(entry.authorTag, "u#0001", "the discord tag wins over every fallback");
    assert.equal(entry.channelId, "9");
    assert.equal(entry.createdTimestamp, 123, "createdTimestamp keeps raw precedence");

    // Community scoping stays strict: without a resolvable community the
    // lookup uses the bare-id key and must NOT hit the community-scoped entry.
    assert.equal(auditLog.getCachedMessage({ id: "503" }), null);
    assert.ok(auditLog.takeCachedMessage(msg), "takeCachedMessage resolves the same key");
    assert.equal(auditLog.getCachedMessage(msg), null, "take removed it");
  });
});
