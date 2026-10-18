/**
 * #439 (audit F2-3): the honeypot BAN-ROLE arm is dead on Fluxer (no
 * member-role-update dispatch exists in the Fluxer gateway surface), so the
 * configuration replies must say so instead of promising "banned
 * immediately". Unit-level with a hand-built CommandContext (the
 * /staff syncpermissions fluxer-reply pattern) — no harness, no network.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb } = require("./helpers/env");
const { api: dbApi, cleanup } = loadDb();

const { ensureCommunity } = require("../src/platform/community");
const honeypot = require("../src/features/honeypot");

after(() => cleanup());

const MANAGE_GUILD = String(1n << 5n);

const FLUXER = ensureCommunity({
  platform: "fluxer",
  instanceKey: "honeypot-439",
  externalGuildId: "900",
});
const DISCORD = ensureCommunity({
  platform: "discord",
  instanceKey: "discord",
  externalGuildId: "901",
});

function makeCtx({ platform, communityId, sub, roleId }) {
  const replies = [];
  const ctx = {
    platform,
    communityId,
    externalGuildId: platform === "fluxer" ? "900" : "901",
    outbound: null, // audit poster: #445 made every leg receipt-based, never throws
    channelPermissions: MANAGE_GUILD, // staff gate: ManageGuild
    memberRoleIds: [],
    userId: "u-439",
    user: { id: "u-439", username: "admin" },
    rawInteraction: undefined, // Fluxer contexts never carry raw
    subcommandGroup: "banrole",
    subcommand: sub,
    options: { getRole: () => ({ id: roleId, name: "BanTrap" }) },
    reply: async (payload) => {
      replies.push(payload);
      return { ok: true };
    },
  };
  return { ctx, replies };
}

describe("honeypot banrole — Fluxer honesty (#439)", () => {
  it("add on Fluxer saves the row but NEVER promises an immediate ban", async () => {
    const { ctx, replies } = makeCtx({
      platform: "fluxer",
      communityId: FLUXER,
      sub: "add",
      roleId: "role-439-f1",
    });
    await honeypot.handlers.honeypot(ctx, {});

    assert.equal(replies.length, 1);
    const content = replies[0].content;
    assert.match(content, /honeypot ban role/i, "confirms the configuration");
    assert.match(content, /not enforced on fluxer/i, "names the dark arm");
    assert.doesNotMatch(
      content,
      /will be banned immediately/,
      "RED on old code: Fluxer was promised Discord gateway mechanics",
    );

    // The configuration itself still saves (arms when dispatch lands).
    assert.equal(dbApi.isHoneypotBanRole(FLUXER, "role-439-f1"), true);
  });

  it("add on Discord keeps the original full promise", async () => {
    const { ctx, replies } = makeCtx({
      platform: "discord",
      communityId: DISCORD,
      sub: "add",
      roleId: "role-439-d1",
    });
    await honeypot.handlers.honeypot(ctx, {});

    assert.equal(replies.length, 1);
    assert.match(replies[0].content, /banned immediately/);
    assert.match(replies[0].content, /GuildMemberUpdate|granted/i);
    assert.doesNotMatch(replies[0].content, /not enforced on fluxer/i);
    assert.equal(dbApi.isHoneypotBanRole(DISCORD, "role-439-d1"), true);
  });

  it("list on Fluxer flags the dark arm; Discord list does not", async () => {
    const flux = makeCtx({
      platform: "fluxer",
      communityId: FLUXER,
      sub: "list",
      roleId: "unused",
    });
    await honeypot.handlers.honeypot(flux.ctx, {});
    assert.match(flux.replies[0].content, /role-439-f1|<@&role-439-f1>/);
    assert.match(
      flux.replies[0].content,
      /not enforced on fluxer/i,
      "RED on old code: the list implied bans happen",
    );

    const disc = makeCtx({
      platform: "discord",
      communityId: DISCORD,
      sub: "list",
      roleId: "unused",
    });
    await honeypot.handlers.honeypot(disc.ctx, {});
    assert.match(disc.replies[0].content, /role-439-d1/);
    assert.doesNotMatch(disc.replies[0].content, /not enforced/i);
  });

  it("del on Fluxer behaves normally (config hygiene works everywhere)", async () => {
    const { ctx, replies } = makeCtx({
      platform: "fluxer",
      communityId: FLUXER,
      sub: "del",
      roleId: "role-439-f1",
    });
    await honeypot.handlers.honeypot(ctx, {});
    assert.match(replies[0].content, /removed/i);
    assert.equal(dbApi.isHoneypotBanRole(FLUXER, "role-439-f1"), false);
  });
});
