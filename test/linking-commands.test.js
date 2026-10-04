/**
 * Command-surface tests for src/features/linking/commands.js (T3 seam —
 * subtask account-linking-06).
 *
 * handleLink is the ONE context-API handler serving BOTH the Discord slash
 * `/link …` and the Fluxer prefix `!link …`. Each surface is exercised through
 * its REAL production shape:
 *  - Discord: a fake ChatInputCommandInteraction (test/helpers/discord) run
 *    through the REAL buildDiscordCommandContext adapter, then handleLink —
 *    so the `sensitive → MessageFlags.Ephemeral` mapping is the production one.
 *  - Fluxer: a gateway MESSAGE_CREATE through the REAL normalizer + parsePrefix
 *    (registry tree built FROM the slash JSON — the single-source contract) +
 *    dispatchPrefixCommand, asserting the recorded POST bodies.
 *
 * Pinned contracts:
 *  (a) /link create replies EPHEMERAL with the minted LNK- code; only the
 *      SHA-256 digest lands in user_link_codes (the plaintext is shown once).
 *  (b) `!link connect <code>` redeems a Discord-minted code: success reply +
 *      the user_links row readable via api.getUserLinkFrom BOTH sides, with
 *      Discord stored as side `a` (canonical orientation).
 *  (c) mirrored mint direction: `!link create` → `/link connect` works too.
 *  (d) /link status names the peer (resolved display name + ids) and every
 *      mirror rate; a caller with no link gets the specific create-guidance.
 *  (e) remove deletes the row and quotes the service's non-retroactive note
 *      VERBATIM; a second remove is the repo's specific no-op sentence.
 *  (f) config: Discord caller "to-fluxer 50" → a_to_b=50 (status shows it);
 *      Fluxer caller "to-discord 30" → b_to_a=30 (caller-relative mapping).
 *  (g) EVERY service refusal is replied VERBATIM (AGENTS.md rule 3 — never a
 *      generic): invalid alphabet, missing code, unknown code, expired code,
 *      already-used code, same-platform redemption, unpaired communities,
 *      caller already linked, target already linked (code NOT burned).
 *  (h) unknown subcommand: the handler names the valid set; the prefix parser
 *      turns it into a usage reply naming the same set.
 *
 * Expiry clock: the command layer calls redeemLinkCode WITHOUT a clock seam
 * (only surfaceCmd), so the expired case mints through the service and moves
 * the stored expires_at in the real DB — testing at the service boundary per
 * the subtask brief, no production seams invented.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");
// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api, cleanup } = loadDb();

const service = require("../src/features/linking/service");
const { handleLink } = require("../src/features/linking/commands");
const { buildDiscordCommandContext } = require("../src/platform/discord/context");
const { buildDefaultRegistry } = require("../src/commands/registry");
const { parsePrefix } = require("../src/platform/fluxer/commands");
const { dispatchPrefixCommand } = require("../src/platform/fluxer/dispatch");
const { normalizeFluxerMessage } = require("../src/platform/fluxer/normalize");
const {
  createClient,
  createGuild,
  createUser,
  createChatInputInteraction,
  lastReplyContent,
  lastReplyEphemeral,
  MessageFlags,
} = require("./helpers/discord");
const { makeFakeRest, makeFakeHandle, gatewayMessage } = require("./helpers/fluxer");

after(cleanup);

// Fake ids only (AGENTS.md secret rule): synthetic snowflakes, fake instance.
const FX_INSTANCE = "https://fluxer.link-cmd.test";
const DC_GUILD = "1700000000000020001";
const DC2_GUILD = "1700000000000020002"; // bridge-less partner for the noBridge case
const FX_GUILD = "9900000000000020001";
const FX2_GUILD = "9900000000000020002"; // bridge-less partner (Fluxer side)
const CHANNEL = "555000222";

const registry = buildDefaultRegistry();
const P = { registryCommands: registry.commands, prefix: "!" };

const DISC_1 = "disc-cmd-1";
const DISC_2 = "disc-cmd-2";
const DISC_5 = "disc-cmd-5";
const DISC_6 = "disc-cmd-6";
const DISC_7 = "disc-cmd-7";
const DISC_8 = "disc-cmd-8";
const DISC_9 = "disc-cmd-9";
const FX_1 = "flux-cmd-1";
const FX_2 = "flux-cmd-2";
const FX_5 = "flux-cmd-5";
const FX_6 = "flux-cmd-6";
const FX_7 = "flux-cmd-7";

/** Service sentences — handlers must reply these VERBATIM. */
const M = service.LINK_MESSAGES;

/** Display code shape: LNK-XXXX-XXXX-XXXX-XXXX-XXXX-XX (Crockford base32). */
const CODE_RE = /LNK-[0-9A-HJ-KM-NP-TV-Z]{4}(?:-[0-9A-HJ-KM-NP-TV-Z]{4}){4}-[0-9A-HJ-KM-NP-TV-Z]{2}/;

/** @type {number} */ let dcId;
/** @type {number} */ let dc2Id;
/** @type {number} */ let fxId;
/** @type {number} */ let fx2Id;

/** Carries state across the ordered narrative (mint in one test, redeem in the next). */
const state = {};

const isoOf = (ms) => new Date(Number(ms)).toISOString();
const isoNoZ = (ms) => isoOf(ms).replace(/Z$/, "");
const canonicalOf = (displayCode) => displayCode.replace(/^LNK-/, "").replace(/-/g, "");

const discordClient = createClient();

/**
 * Peer NAME resolution: features/linking/commands.js resolves display names
 * through supervisor.clientForCommunity(peerCommunityId).fetchMember — the
 * same accessor bridge/handlers use. Fakes supply names for both platforms.
 */
const nameSupervisor = {
  clientForCommunity(id) {
    if (id === fxId) {
      return {
        platform: "fluxer",
        async fetchMember() {
          return { user: { username: "flux-name" } };
        },
      };
    }
    if (id === dcId) {
      return {
        platform: "discord",
        async fetchMember() {
          return { user: { username: "disc-name" } };
        },
      };
    }
    return null;
  },
};

/** featureCtx shaped like the router's (client) + the dispatch-built one (supervisor). */
const discordFeatureCtx = { client: discordClient, supervisor: nameSupervisor };

/**
 * Discord slash shape: the REAL adapter (buildDiscordCommandContext) over a
 * fake interaction — what the router's chat-input arm hands a "context" handler.
 */
function makeDiscordCtx({ userId, subcommand, options = {}, guildExternalId = DC_GUILD }) {
  const guild = createGuild({ id: guildExternalId });
  discordClient.addGuild(guild);
  const user = createUser({ id: String(userId) });
  const interaction = createChatInputInteraction({
    commandName: "link",
    subcommand,
    guild,
    user,
    client: discordClient,
    options,
  });
  const ctx = buildDiscordCommandContext(interaction, discordFeatureCtx);
  return { interaction, ctx };
}

/** One `!link …` through the REAL parser + dispatcher; returns the channel POSTs. */
async function runFluxer(
  content,
  authorId,
  { guildExternalId = FX_GUILD, allowUsageError = false } = {},
) {
  const routes = { [`POST /v1/channels/${CHANNEL}/messages`]: { id: "r-1" } };
  if (guildExternalId !== FX_GUILD) routes[`GET /v1/guilds/${guildExternalId}/roles`] = [];
  const rest = makeFakeRest({ routes });
  const { outbound } = makeFakeHandle({ instanceKey: FX_INSTANCE, rest });
  const normalized = normalizeFluxerMessage(
    {
      t: "MESSAGE_CREATE",
      d: gatewayMessage({
        content,
        channel_id: CHANNEL,
        guild_id: guildExternalId,
        author: { id: String(authorId), username: `fx-${authorId}`, bot: false },
        member: { roles: [] },
      }),
    },
    { instanceKey: FX_INSTANCE },
  );
  normalized.communityId = guildExternalId === FX_GUILD ? fxId : fx2Id;

  const parsed = parsePrefix(content, P);
  assert.ok(parsed, `prefix parser must recognize: ${content}`);
  if (allowUsageError) {
    assert.ok(parsed.usageError, `expected a usage error for: ${content}`);
  } else {
    assert.equal(parsed.usageError, null, `unexpected usage error: ${parsed.usageError?.reason}`);
  }

  await dispatchPrefixCommand(outbound, normalized, parsed, { registry, supervisor: nameSupervisor });
  const posts = rest.calls.filter((c) => c.method === "POST" && c.path === `/v1/channels/${CHANNEL}/messages`);
  return { rest, posts, body: posts[posts.length - 1]?.body };
}

function codeRowFor(userLabel) {
  const row = api.db
    .prepare("SELECT * FROM user_link_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .get(userLabel);
  assert.ok(row, `user_link_codes row for ${userLabel}`);
  return row;
}

describe("linking command surface (account-linking T3/T6)", () => {
  before(() => {
    dcId = communityKey(DC_GUILD);
    dc2Id = communityKey(DC2_GUILD);
    fxId = communityKey(FX_GUILD, "fluxer", FX_INSTANCE);
    fx2Id = communityKey(FX2_GUILD, "fluxer", FX_INSTANCE);

    // Locked decision 3: links live ONLY between bridge-paired communities.
    // dcId↔fxId gets an ACTIVE bridge; dc2Id/fx2Id stay unpaired on purpose.
    const bridge = api.createBridge({
      publicId: api.generateBridgeHandle(),
      createdByUserId: "u-minter",
      endACommunityId: dcId,
      endAChannelId: "chan-a",
    });
    api.addBridgeEnd({ bridgeId: bridge.id, position: "b", communityId: fxId, channelId: "chan-b" });
    api.db.prepare(`UPDATE bridges SET state = 'active' WHERE id = ?`).run(bridge.id);
  });

  // (a) ---------------------------------------------------------------------
  it("Discord /link create replies EPHEMERAL with an LNK- code; only the digest is stored", async () => {
    const { interaction, ctx } = makeDiscordCtx({ userId: DISC_1, subcommand: "create" });
    await handleLink(ctx, discordFeatureCtx);

    assert.equal(interaction.replies.length, 1, "one reply, sent as the interaction response");
    assert.ok(lastReplyEphemeral(interaction), "Discord create reply is ephemeral (sensitive → flag)");
    assert.equal(interaction.replies[0].flags, MessageFlags.Ephemeral);
    assert.deepEqual(interaction.replies[0].allowedMentions, { parse: [] }, "never pings");

    const content = lastReplyContent(interaction);
    const match = content.match(CODE_RE);
    assert.ok(match, `expected a LNK- code in: ${content}`);
    state.discCode = match[0];

    // Service success copy: shown once, ~15 minutes, and the OPPOSITE-platform
    // hint (Fluxer spellings for a Discord caller).
    assert.match(content, /^Link code, shown once: LNK-/);
    assert.match(content, /about 15 minutes/);
    assert.match(content, /!link connect/);
    assert.match(content, /\/link status/);

    const rows = api.db
      .prepare("SELECT * FROM user_link_codes WHERE community_id = ? AND user_id = ?")
      .all(dcId, DISC_1);
    assert.equal(rows.length, 1, "exactly one code row minted for (community, user)");
    state.codeRowId = rows[0].id;
    assert.equal(rows[0].used_at, null, "a fresh code is unconsumed");
    assert.match(String(rows[0].code_hash), /^[0-9a-f]{64}$/, "storage keeps the SHA-256 digest only");
    assert.ok(
      !String(rows[0].code_hash).includes(canonicalOf(state.discCode)),
      "the plaintext credential is never stored",
    );
  });

  // (b) ---------------------------------------------------------------------
  it("Fluxer !link connect redeems the Discord-minted code; the link row reads back from BOTH sides", async () => {
    const out = await runFluxer(`!link connect code ${state.discCode}`, FX_1);

    assert.equal(out.posts.length, 1, "Fluxer replies in-channel — exactly one POST");
    assert.deepEqual(out.body.allowed_mentions, { parse: [] }, "replies never ping");
    // Peer descriptor carries the supervisor-resolved display name + ids.
    assert.ok(
      out.body.content.startsWith(
        `Linked to disc-name — user ${DISC_1} on Discord (instance discord, community ${dcId}).`,
      ),
      `connect reply names the peer: ${out.body.content}`,
    );
    assert.match(out.body.content, /XP and gork memories now mirror/);
    // surfaceCmd is the CALLER's platform spelling: "!link", never "/link".
    assert.match(out.body.content, /!link config/);
    assert.match(out.body.content, /!link status/);
    assert.match(out.body.content, /That link code is spent\.$/);

    const linkFromDc = api.getUserLinkFor(dcId, DISC_1);
    const linkFromFx = api.getUserLinkFor(fxId, FX_1);
    assert.ok(linkFromDc && linkFromFx, "both sides resolve a link row in real SQLite");
    assert.deepEqual(linkFromDc, linkFromFx, "both sides resolve the SAME row");
    assert.equal(linkFromDc.community_id_a, dcId, "canonical orientation: the Discord side is `a`");
    assert.equal(linkFromDc.user_id_a, DISC_1);
    assert.equal(linkFromDc.community_id_b, fxId);
    assert.equal(linkFromDc.user_id_b, FX_1);
    assert.equal(linkFromDc.mirror_a_to_b_pct, 100, "fresh links start at 100% a→b");
    assert.equal(linkFromDc.mirror_b_to_a_pct, 100, "fresh links start at 100% b→a");
    assert.equal(Number(linkFromDc.mirror_memory), 1, "fresh links mirror gork memory");

    const used = api.db.prepare("SELECT used_at FROM user_link_codes WHERE id = ?").get(state.codeRowId);
    assert.ok(Number.isInteger(used.used_at), "the code row is atomically marked used");
  });

  // (c) ---------------------------------------------------------------------
  it("mirrored direction: Fluxer !link create mints in-channel; Discord /link connect redeems it", async () => {
    const out = await runFluxer("!link create", FX_2);
    assert.equal(out.posts.length, 1, "Fluxer create replies in-channel (no ephemeral concept)");
    const match = out.body.content.match(CODE_RE);
    assert.ok(match, `expected a LNK- code in: ${out.body.content}`);
    assert.match(out.body.content, /^Link code, shown once: LNK-/);
    // Opposite-side hint for a Fluxer caller uses the DISCORD spelling.
    assert.ok(out.body.content.includes("/link connect"), out.body.content);

    const { interaction, ctx } = makeDiscordCtx({
      userId: DISC_2,
      subcommand: "connect",
      options: { code: match[0] },
    });
    await handleLink(ctx, discordFeatureCtx);
    const content = lastReplyContent(interaction);
    assert.ok(
      content.startsWith(
        `Linked to flux-name — user ${FX_2} on Fluxer (instance ${FX_INSTANCE}, community ${fxId}).`,
      ),
      `connect reply names the peer: ${content}`,
    );
    assert.match(content, /\/link config/); // surfaceCmd for a Discord caller

    const link = api.getUserLinkFor(fxId, FX_2);
    assert.ok(link, "the mirrored mint direction also writes the link row");
    assert.equal(link.user_id_a, DISC_2, "Discord side stays `a` even when Fluxer minted the code");
    assert.equal(link.community_id_a, dcId);
    assert.equal(link.user_id_b, FX_2);
    assert.ok(Number.isInteger(codeRowFor(FX_2).used_at), "the Fluxer-minted code is spent");
  });

  // (d) ---------------------------------------------------------------------
  it("/link status shows the peer, the linked date, and the mirror config — from both sides", async () => {
    const link = api.getUserLinkFor(dcId, DISC_1);
    assert.ok(link);

    const dc = makeDiscordCtx({ userId: DISC_1, subcommand: "status" });
    await handleLink(dc.ctx, discordFeatureCtx);
    const dcContent = lastReplyContent(dc.interaction);
    assert.ok(
      dcContent.includes(
        `Linked: you (Discord user ${DISC_1} in community ${dcId}) ↔ flux-name — user ${FX_1} on Fluxer (instance ${FX_INSTANCE}, community ${fxId}).`,
      ),
      `status names the peer with its display name: ${dcContent}`,
    );
    assert.ok(dcContent.includes(`Linked since: ${isoNoZ(link.created_at)} UTC.`));
    assert.ok(dcContent.includes("XP mirror: Discord → Fluxer 100%, Fluxer → Discord 100%."));
    assert.ok(dcContent.includes("gork memory mirroring: on."));

    const fx = await runFluxer("!link status", FX_1);
    assert.ok(
      fx.body.content.includes(
        `Linked: you (Fluxer user ${FX_1} in community ${fxId}) ↔ disc-name — user ${DISC_1} on Discord (instance discord, community ${dcId}).`,
      ),
      `Fluxer-side status is caller-relative: ${fx.body.content}`,
    );

    // Negative: a caller with no link gets the specific create-guidance sentence.
    const none = await runFluxer("!link status", "flux-cmd-9");
    assert.ok(none.body.content.includes(`You (user flux-cmd-9 in community ${fxId}) have no account link here.`));
    assert.ok(none.body.content.includes("!link create mints a code"));
    assert.ok(none.body.content.includes("/link connect"));
  });

  // (e) ---------------------------------------------------------------------
  it("!link remove deletes the row and quotes the service's non-retroactive note verbatim", async () => {
    const out = await runFluxer("!link remove", FX_1);
    assert.ok(
      out.body.content.includes(`Unlinked from user ${DISC_1} on Discord (community ${dcId}).`),
      out.body.content,
    );
    assert.ok(
      out.body.content.includes(
        "XP and memories already mirrored on the other platform stay in place; mirroring stops from now on.",
      ),
      "the service note (mirror is not retroactive) rides along verbatim",
    );
    assert.equal(api.getUserLinkFor(dcId, DISC_1), null, "row gone from the Discord side");
    assert.equal(api.getUserLinkFor(fxId, FX_1), null, "row gone from the Fluxer side");
  });

  it("removing with no link is the repository's specific sentence — never a generic", async () => {
    const out = await runFluxer("!link remove", FX_1);
    assert.match(out.body.content, /has no account link to remove/);
    assert.ok(out.body.content.includes(`user ${FX_1} in community ${fxId}`), out.body.content);
  });

  // (f) ---------------------------------------------------------------------
  it("Discord /link config to-fluxer 50 sets a_to_b and /link status shows 50", async () => {
    // Re-link DISC_1↔FX_1 (removed in (e)) through the service seam.
    const minted = await service.createLinkCode(dcId, DISC_1);
    assert.equal(minted.ok, true, minted.error || "re-mint must succeed");
    const made = await service.redeemLinkCode(fxId, FX_1, minted.code);
    assert.equal(made.ok, true, made.error || "re-redeem must succeed");

    const cfg = makeDiscordCtx({
      userId: DISC_1,
      subcommand: "config",
      options: { direction: "to-fluxer", pct: 50 },
    });
    await handleLink(cfg.ctx, discordFeatureCtx);
    const content = lastReplyContent(cfg.interaction);
    assert.ok(content.includes("Applied: a_to_b=50"), content);
    assert.ok(content.includes("Discord → Fluxer 50%"), content);
    assert.equal(api.getUserLinkFor(dcId, DISC_1).mirror_a_to_b_pct, 50);

    const dc = makeDiscordCtx({ userId: DISC_1, subcommand: "status" });
    await handleLink(dc.ctx, discordFeatureCtx);
    assert.ok(
      lastReplyContent(dc.interaction).includes("XP mirror: Discord → Fluxer 50%, Fluxer → Discord 100%."),
      "status reflects the new rate, other direction untouched",
    );
  });

  it("Fluxer !link config direction to-discord pct 30 sets b_to_a; memory off flips the switch", async () => {
    const out = await runFluxer("!link config direction to-discord pct 30", FX_1);
    assert.ok(out.body.content.includes("Applied: b_to_a=30"), out.body.content);
    assert.ok(out.body.content.includes("Fluxer → Discord 30%"), out.body.content);
    assert.equal(api.getUserLinkFor(fxId, FX_1).mirror_b_to_a_pct, 30, "caller-relative to-discord = b→a");

    const mem = await runFluxer("!link config memory off", FX_1);
    assert.ok(mem.body.content.includes("Applied: mirror_memory=0"), mem.body.content);
    assert.ok(mem.body.content.includes("memory off"), mem.body.content);
    assert.equal(Number(api.getUserLinkFor(fxId, FX_1).mirror_memory), 0);

    const status = await runFluxer("!link status", FX_1);
    assert.ok(status.body.content.includes("gork memory mirroring: off."), status.body.content);
  });

  it("config refusals are the service's own sentences (nothing-to-set, pct-without-direction, no-link)", async () => {
    const none = await runFluxer("!link config", FX_1);
    assert.equal(none.body.content, M.mirrorNothingToSet("!link"));

    const needsPct = await runFluxer("!link config direction to-discord", FX_1);
    assert.equal(needsPct.body.content, M.mirrorNeedsPct("!link"));

    const noLink = await runFluxer("!link config direction to-discord pct 50", "flux-cmd-9");
    assert.equal(noLink.body.content, M.mirrorNoLink("flux-cmd-9", fxId, "!link"));
  });

  // (g) ---------------------------------------------------------------------
  it("invalid code format → the alphabet sentence verbatim (Discord surface, /link naming)", async () => {
    const { interaction, ctx } = makeDiscordCtx({
      userId: DISC_1,
      subcommand: "connect",
      options: { code: "!!!definitely-not-a-code!!!" },
    });
    await handleLink(ctx, discordFeatureCtx);
    assert.equal(lastReplyContent(interaction), M.alphabetGarbage);
  });

  it("connect with NO code option → the 'code is required' sentence", async () => {
    const { interaction, ctx } = makeDiscordCtx({ userId: DISC_1, subcommand: "connect" });
    await handleLink(ctx, discordFeatureCtx);
    assert.equal(lastReplyContent(interaction), M.missingCode("/link"));
  });

  it("well-formed code that was never minted → the 'never created' sentence, named for the caller's command", async () => {
    const out = await runFluxer(`!link connect code AAAA-AAAA-AAAA-AAAA-AAAA-AA`, FX_5);
    assert.equal(out.body.content, M.unknownCode("!link"));
  });

  it("expired code → the service's expiry sentence naming the stored expiry instant", async () => {
    const minted = await service.createLinkCode(dcId, DISC_5);
    assert.equal(minted.ok, true, minted.error || "mint must succeed");
    const expiredAt = 1_700_000_000_000;
    api.db
      .prepare("UPDATE user_link_codes SET expires_at = ? WHERE id = ?")
      .run(expiredAt, minted.linkCode.id);

    const out = await runFluxer(`!link connect code ${minted.code}`, FX_5);
    assert.equal(out.body.content, M.expired(isoOf(expiredAt), "!link"));
  });

  it("a spent code → the 'already redeemed on <iso>' sentence (single use is permanent)", async () => {
    const minted = await service.createLinkCode(dcId, DISC_6);
    assert.equal(minted.ok, true, minted.error || "");
    const first = await runFluxer(`!link connect code ${minted.code}`, FX_6);
    assert.ok(
      first.body.content.startsWith(`Linked to disc-name — user ${DISC_6} on Discord`),
      `first redeem succeeds: ${first.body.content}`,
    );
    const row = api.db.prepare("SELECT used_at FROM user_link_codes WHERE id = ?").get(minted.linkCode.id);
    assert.ok(Number.isInteger(row.used_at), "used_at stamped by the first redeem");

    const second = await runFluxer(`!link connect code ${minted.code}`, FX_6);
    assert.equal(second.body.content, M.alreadyUsed(isoOf(row.used_at), "!link"));
  });

  it("redeeming a Discord-minted code FROM Discord → the same-platform sentence", async () => {
    const minted = await service.createLinkCode(dcId, DISC_7);
    assert.equal(minted.ok, true, minted.error || "");
    const { interaction, ctx } = makeDiscordCtx({
      userId: DISC_8,
      subcommand: "connect",
      options: { code: minted.code },
    });
    await handleLink(ctx, discordFeatureCtx);
    assert.equal(lastReplyContent(interaction), M.samePlatform("Discord", "/link"));
  });

  it("communities with no active bridge → the no-bridge sentence naming both community ids", async () => {
    const minted = await service.createLinkCode(dc2Id, DISC_9); // dc2 has no bridge
    assert.equal(minted.ok, true, minted.error || "");
    const out = await runFluxer(`!link connect code ${minted.code}`, FX_7, { guildExternalId: FX2_GUILD });
    assert.equal(out.body.content, M.noBridge(dc2Id, fx2Id, "!link"));
  });

  it("caller already linked → the callerLinked sentence naming the existing peer and date", async () => {
    // DISC_2 is linked to FX_2 from the mirrored-direction test (c).
    const existing = api.getUserLinkFor(dcId, DISC_2);
    assert.ok(existing, "fixture link from test (c)");
    const minted = await service.createLinkCode(fxId, FX_5); // fresh, unlinked counterpart
    assert.equal(minted.ok, true, minted.error || "");

    const { interaction, ctx } = makeDiscordCtx({
      userId: DISC_2,
      subcommand: "connect",
      options: { code: minted.code },
    });
    await handleLink(ctx, discordFeatureCtx);
    assert.equal(
      lastReplyContent(interaction),
      M.callerLinked(DISC_2, dcId, FX_2, fxId, isoOf(existing.created_at), "/link"),
    );
  });

  it("code owner already linked → the targetLinked sentence, and the code is NOT burned", async () => {
    const existing = api.getUserLinkFor(fxId, FX_2);
    assert.ok(existing, "fixture link from test (c)");
    const minted = await service.createLinkCode(fxId, FX_2); // FX_2 is already linked
    assert.equal(minted.ok, true, minted.error || "");

    const { interaction, ctx } = makeDiscordCtx({
      userId: DISC_8, // DISC_8 is unlinked (its earlier attempt was refused pre-consume)
      subcommand: "connect",
      options: { code: minted.code },
    });
    await handleLink(ctx, discordFeatureCtx);
    assert.equal(
      lastReplyContent(interaction),
      M.targetLinked(FX_2, fxId, DISC_2, dcId, isoOf(existing.created_at), "/link"),
    );
    const row = api.db.prepare("SELECT used_at FROM user_link_codes WHERE id = ?").get(minted.linkCode.id);
    assert.equal(row.used_at, null, "fail-closed ordering: a fixable refusal never burns the code");
  });

  // (h) ---------------------------------------------------------------------
  it("unknown subcommand: the handler names the valid set; the prefix parser answers with the same list", async () => {
    const { interaction, ctx } = makeDiscordCtx({ userId: DISC_1, subcommand: "teleport" });
    await handleLink(ctx, discordFeatureCtx);
    assert.equal(
      lastReplyContent(interaction),
      "Unknown subcommand: teleport. Valid subcommands: create, connect, status, remove, config.",
    );

    const out = await runFluxer("!link teleport", DISC_1, { allowUsageError: true });
    assert.equal(out.posts.length, 1, "usage error is a plain channel reply");
    assert.ok(
      out.body.content.startsWith(
        'Unknown subcommand "teleport" for "link". Expected one of: create, connect, status, remove, config.',
      ),
      out.body.content,
    );
  });
});
