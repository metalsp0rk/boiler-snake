/**
 * #466 (FLX-7): ctx.guildOwner on Fluxer must mean the SAME thing it means
 * on Discord — "this invoker IS the guild owner", computed from the guild
 * record's ownerId. The old derivation (`channelPermissions === ALL`) said
 * true for every ADMINISTRATOR (both collapse to ALL inside the pure
 * algorithm) and flipped with channel overwrites that never apply to ALL.
 * No consumer today — planted, so it ships correct BEFORE the first reader.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");
const { cleanup } = loadDb(); // CONTRACT: fresh DB before any src/ require

const { buildFluxerCommandContext } = require("../src/platform/fluxer/context");
const { ALL_PERMISSIONS } = require("../src/platform/fluxer/permissions");

const COMMUNITY_ID = 1;
const AUTHOR = "100000000000000099";

function buildCtx(permissions) {
  const parsed = {
    commandName: "xp",
    subcommandGroup: null,
    subcommand: null,
    options: [],
    help: null,
    usageError: null,
  };
  const message = {
    platform: "fluxer",
    instanceKey: "fluxer",
    communityId: COMMUNITY_ID,
    externalGuildId: "900000000000000001",
    channelId: "555000111",
    authorId: AUTHOR,
    authorBot: false,
    authorRaw: { id: AUTHOR, username: "mod-1", bot: false },
    memberRoleIds: [],
  };
  // The builder hard-requires an outbound for real commands (send paths);
  // nothing sends here — a shape stub is enough.
  return buildFluxerCommandContext(parsed, message, {
    outbound: { sendChannel: async () => ({ ok: true, id: "1" }) },
    permissions,
  });
}

describe("#466 (FLX-7): the resolved owner fact rides the ctx (no mask inference)", () => {
  it("AN ADMINISTRATOR whose mask is ALL but who is NOT the owner gets guildOwner=false", () => {
    // Pre-fix this was the contradiction: mask ALL ⇒ guildOwner true,
    // while Discord's builder (real ownerId compare) would say false.
    const ctx = buildCtx({
      channelPermissions: ALL_PERMISSIONS,
      memberRoleIds: [],
      guildOwner: false,
    });
    assert.equal(ctx.guildOwner, false);
    assert.equal(
      ctx.channelPermissions,
      ALL_PERMISSIONS,
      "the mask itself is untouched — only the ownership claim changes"
    );
  });

  it("the real owner gets guildOwner=true", () => {
    const ctx = buildCtx({
      channelPermissions: ALL_PERMISSIONS,
      memberRoleIds: [],
      guildOwner: true,
    });
    assert.equal(ctx.guildOwner, true);
  });

  it("no permissions resolved ⇒ guildOwner=false (never an inferred yes)", () => {
    const ctx = buildCtx(null);
    assert.equal(ctx.guildOwner, false);
  });
});

after(cleanup);
