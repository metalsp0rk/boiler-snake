/**
 * #472 (XE-11 + XE-13): award-path failures must be HONEST.
 *
 *  - awardXp used to throw (assertCommunityId, better-sqlite3 errors) and
 *    every caller kept its own net; /grantxp answered those failures with
 *    the router's GENERIC fallback while the specific cause sat in the
 *    throw (AGENTS rule 6 violation waiting for an unwrapped caller).
 *  - The leaderboard button handler used to `return` on a malformed/stale
 *    lb: customId with zero reply and zero log (rule 1: silent drop — the
 *    press hung in Discord's spinner forever).
 *
 * Both RED against the pre-#472 tree: the old awardXp rejected (this file
 * awaits a plain {ok:false} result), the old button branch replied nothing.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { api: dbApi, cleanup } = loadDb();

// The service module FIRST (xp/index.js destructures awardXp at load — the
// grantxp test below patches this module object and only THEN requires the
// feature, so the feature's binding IS the stub).
const awardMod = require("../src/services/awardXp");
const { ensureCommunity } = require("../src/platform/community");

after(cleanup);

/** Minimal OutboundClient stand-in: role sync needs fetchMember at most. */
const fakeOutbound = {
  async fetchMember() {
    return null;
  },
};

function fakeGrantCtx(overrides = {}) {
  const replies = [];
  return {
    replies,
    communityId: 1,
    externalGuildId: "900",
    outbound: fakeOutbound,
    // ManageGuild bit (discord.js PermissionFlagsBits.ManageGuild = 32) —
    // passes requireAdminFromContext.
    channelPermissions: 32n,
    user: { id: "u-admin", bot: false },
    options: {
      getUser: () => ({ id: "u-target", bot: false }),
      getInteger: () => 5,
      getString: () => null,
    },
    async reply(payload) {
      replies.push(payload);
    },
    ...overrides,
  };
}

describe("awardXp result contract — #472 (XE-11)", () => {
  it("returns {ok:false,error} instead of rejecting on a malformed community", async () => {
    // assertCommunityId threw straight through the service pre-#472; an
    // unwrapped caller would have crashed on contact. Rule 6: services
    // RETURN their failure.
    const log = [];
    const origErr = console.error;
    console.error = (...a) => log.push(a.join(" "));
    let result;
    try {
      result = await awardMod.awardXp(fakeOutbound, {
        communityId: "not-an-int",
        userId: "u1",
        delta: 5,
        activityKind: "message",
      });
    } finally {
      console.error = origErr;
    }
    assert.equal(result.ok, false, "a failed award is a RESULT, never a rejection");
    assert.ok(
      typeof result.error === "string" && result.error.length > 0,
      `error names the cause, got: ${JSON.stringify(result.error)}`,
    );
    assert.ok(
      log.some(
        (l) =>
          l.includes("[xp] award failed") &&
          l.includes("not-an-int") &&
          l.includes("u1"),
      ),
      `rule 2: the cause is logged with ids even when the caller stays quiet, got: ${JSON.stringify(log)}`,
    );
  });

  it("success results carry ok:true (additive shape)", async () => {
    const cid = ensureCommunity({
      platform: "discord",
      instanceKey: "https://xp-failure-honesty.test",
      externalGuildId: "900",
    });
    const res = await awardMod.awardXp(fakeOutbound, {
      communityId: cid,
      externalGuildId: "900",
      userId: "u-ok",
      delta: 5,
      activityKind: "message",
    });
    assert.equal(res.ok, true);
    assert.equal(res.newXp, 5, "the pre-existing success shape survives");
    assert.equal(
      dbApi.getXp(cid, "u-ok"),
      5,
      "the award itself still lands through the wrapper",
    );
  });
});

describe("/grantxp surfaces the specific award failure — #472 (XE-11)", () => {
  it("replies with the cause instead of the router's generic fallback", async () => {
    const original = awardMod.awardXp;
    // The service's REPORTED failure (test 1 pins the throw→result conversion
    // above) — what must change here is the HANDLER: pre-#472 it destructured
    // the result blindly and this exact reply never existed.
    awardMod.awardXp = async () => ({ ok: false, error: "sqlite disk i/o scream" });
    try {
      // First require of the feature AFTER the patch: xp/index.js binds
      // `awardXp` at load, so it destructures THE STUB.
      const xpFeature = require("../src/features/xp");
      const grantxp = xpFeature.handlers.grantxp;
      const ctx = fakeGrantCtx();
      await grantxp(ctx, {});
      assert.equal(ctx.replies.length, 1, `one reply, got: ${JSON.stringify(ctx.replies)}`);
      const content = String(ctx.replies[0].content);
      assert.ok(
        content.includes("Failed to grant XP"),
        `specific grant-failure copy expected, got: ${content}`,
      );
      assert.ok(
        content.includes("sqlite disk i/o scream"),
        `rule 3: the user can act on the CAUSE, got: ${content}`,
      );
      assert.equal(ctx.replies[0].sensitive, true, "the reply is ephemeral");
    } finally {
      awardMod.awardXp = original;
    }
  });
});

describe("stale leaderboard button answers — #472 (XE-13)", () => {
  it("a malformed lb: customId gets a stale-page reply, not silence", async () => {
    const xpFeature = require("../src/features/xp");
    const buttonKey = Object.keys(xpFeature.buttonHandlers)[0];
    const handler = xpFeature.buttonHandlers[buttonKey];

    const interaction = {
      customId: "lb:garbage-not-a-page-id",
      user: { id: "u-clicker" },
      replies: [],
      async reply(payload) {
        this.replies.push(payload);
      },
      async deferReply() {},
      async editReply(payload) {
        this.replies.push(payload);
      },
    };

    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    try {
      await handler(interaction, {});
    } finally {
      console.warn = origWarn;
    }

    assert.equal(
      interaction.replies.length,
      1,
      "the press is ANSWERED (rule 1: no silent drop, no dead spinner)",
    );
    const content = String(interaction.replies[0].content);
    assert.match(
      content,
      /stale/i,
      `stale-page copy expected, got: ${content}`,
    );
    assert.ok(interaction.replies[0].flags, "the answer carries ephemeral flags");
    assert.equal(
      Number(interaction.replies[0].flags) & 64,
      64,
      `MessageFlags.Ephemeral (64) expected, got: ${interaction.replies[0].flags}`,
    );
    assert.ok(
      warns.some((w) => w.includes("malformed leaderboard button")),
      `rule 2: a trace lands in the logs too, got: ${JSON.stringify(warns)}`,
    );
  });
});
