/**
 * #360 (DB-3): cleanupMalformedYoutubeChannels used to run at the tail of
 * EVERY updateGuildSettings call (cross-feature, invisible) and delete every
 * youtube_channels row whose id was not UC/HC-shaped — exactly the by-design
 * shape of a PENDING @handle subscription created by `/youtube add` when the
 * API cannot resolve (the ticker resolves those at runtime). A
 * /setcommandchannel quietly unsubscribed users. Two contracts pinned here:
 *   1) updateGuildSettings NEVER touches youtube_channels;
 *   2) the cleanup is INERT — no row shape in the current model is debris:
 *      youtube_channels holds one row per (community, channel_name), so a
 *      superseded twin of the same name cannot exist, and unresolvable
 *      pending rows are the ticker's job, not the bin's.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb, communityKey } = require("./helpers/env");

describe("youtube malformed cleanup is no longer a settings side effect (#360)", () => {
  /** @type {object} */
  let api;
  let cleanup;
  const CID = communityKey("790000000000000060");

  before(() => {
    ({ api, cleanup } = loadDb());
  });
  after(() => cleanup?.());

  const ids = () => api.getYoutubeChannels(CID).map((r) => r.id).sort();

  it("updateGuildSettings (any key, any feature) never deletes a pending @handle row", () => {
    api.addYoutubeChannel(CID, "pendinghandle", "pendinghandle", "https://www.youtube.com/@pendinghandle", "");
    assert.deepEqual(ids(), ["pendinghandle"]);

    // The exact command that used to bury it: an unrelated settings write.
    api.updateGuildSettings(CID, { youtube_polling_interval_minutes: 9 });
    api.updateGuildSettings(CID, { warn_threshold: 3 });
    assert.deepEqual(
      ids(),
      ["pendinghandle"],
      "#360: the settings write must not reach into another feature's subscriptions",
    );
  });

  it("the INERT cleanup leaves every shape alone: pending, UC, HC, junk-id", () => {
    api.addYoutubeChannel(CID, "UCrealid0000000000000001", "CoolChannel", "https://www.youtube.com/channel/UCrealid0000000000000001", "");
    api.addYoutubeChannel(CID, "HClegacy0000000000000001", "Legacy", "https://www.youtube.com/channel/HClegacy0000000000000001", "");
    api.addYoutubeChannel(CID, "junk-not-a-channel", "@junk", "https://www.youtube.com/@junk", "");
    const before = ids();
    assert.equal(before.length, 4, "mixed shapes seeded");

    api.cleanupMalformedYoutubeChannels();

    assert.deepEqual(
      ids(),
      before,
      "#360: with one row per (community, name) enforced by REPLACE, ANY name-based sweep can only kill LIVE pending subs — so it kills nothing",
    );
  });

  it("same normalized name in ANOTHER community is its own subscription", () => {
    const other = communityKey("790000000000000061");
    api.addYoutubeChannel(other, "elsewherehandle", "pendinghandle", "https://www.youtube.com/@elsewherehandle", "");
    api.cleanupMalformedYoutubeChannels();
    assert.ok(
      api.getYoutubeChannels(other).some((r) => r.id === "elsewherehandle"),
      "cross-community name collision condemns nothing",
    );
  });

  it("intra-community re-add of the same name REPLACES (no twins can exist for any sweep to hunt)", () => {
    api.addYoutubeChannel(CID, "UCfinal00000000000000001", "TwinTest", "u", "");
    api.addYoutubeChannel(CID, "twinhandle", "TwinTest", "u2", ""); // same (community, name)
    const rows = api.db
      .prepare("SELECT id FROM youtube_channels WHERE community_id=? AND channel_name=?")
      .all(CID, "TwinTest");
    assert.equal(rows.length, 1, "REPLACE semantics: one row per name — a pending twin never coexists");
    assert.equal(rows[0].id, "twinhandle");
  });
});
