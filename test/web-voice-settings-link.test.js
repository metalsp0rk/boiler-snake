/**
 * Voice-page settings link (#407, audit C2-3): /g/:id carries the INTEGER
 * communities.id — the view used to mint its cross-link from the snapshot's
 * EXTERNAL snowflake, so the only cross-page link on the Voice & Music page
 * 404'd 100% of the time (§8.6 zero-dead-links doctrine, dead on arrival).
 * The shell nav link kept the old route test green — this file pins the
 * VIEW's own link directly, where the bug lived.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

// #609: this file LOADS src modules whose require chain reaches src/db —
// connection.js opens DB_PATH at REQUIRE time, so bind a private temp DB
// BEFORE anything else loads. Concurrent node --test files sharing one
// ambient DB_PATH race mid-migration (the #470 G2-6 gork flake class).
const { loadDb } = require("./helpers/env");
const { cleanup: cleanupTempDb } = loadDb();
test.after(cleanupTempDb);


const { renderVoiceBody } = require("../src/web/views/voice");

const CONFIG = { available: true, voiceXpPerMin: 3 };

test("the settings cross-link uses the snapshot's integer communityId (#407)", () => {
  const out = String(
    renderVoiceBody({
      snapshot: {
        guildId: "730000000000000001", // display/providers — NOT a route id
        communityId: 42,
        config: CONFIG,
      },
      resolveChannelName: null,
    }),
  );
  assert.ok(out.includes(`href="/g/42/settings"`), "the link carries the integer route id");
  assert.ok(
    !out.includes("/g/730000000000000001/settings"),
    "the snowflake never reaches a /g/ href — parseCommunityIdParam would 404 it",
  );
});

test("no integer id means NO anchor, not a dead one (#407)", () => {
  const out = String(
    renderVoiceBody({
      snapshot: { guildId: "730000000000000001", config: CONFIG },
      resolveChannelName: null,
    }),
  );
  assert.match(out, /Full settings live on the settings page\./, "the sentence stays honest");
  assert.ok(
    !/Full settings live on the <a[^>]*\/g\/730/.test(out),
    "an unregistered guild renders no href — zero dead links (§8.6) beats decoration",
  );
});
