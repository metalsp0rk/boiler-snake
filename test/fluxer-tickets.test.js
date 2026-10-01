/**
 * PR 9 — Fluxer ticket create through the OutboundClient (roadmap/fluxer.md
 * § Outbound client + PR 9 entry). Driven END-TO-END through the real parser
 * (parsePrefix + buildDefaultRegistry) and dispatchPrefixCommand, so the
 * assertions pin the shipped wire: createChannel's exact POST body (decimal
 * STRING overwrites, `type` integers, parent id, type 0), the K8 flag-0 gate
 * (no network to the channels endpoint; the gate's own reason reaches the
 * user verbatim), and the staff-role position skip.
 *
 * REST runs over the SDK-free fake transport (test/helpers/fluxer.js,
 * contract 5). No token material can appear: the handle carries none.
 */
const { describe, it, after, before } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const { parsePrefix } = require("../src/platform/fluxer/commands");
const { dispatchPrefixCommand } = require("../src/platform/fluxer/dispatch");
const { buildDefaultRegistry } = require("../src/commands/registry");
const { ensureCommunity } = require("../src/platform/community");
const {
  makeFakeRest,
  makeFakeHandle,
  gatewayMessage,
} = require("./helpers/fluxer");
const { normalizeFluxerMessage } = require("../src/platform/fluxer/normalize");
const {
  getTicketByChannel,
  listOpenTickets,
  updateGuildSettings,
  addStaffRole,
} = require("../src/db");
const {
  BOT_ALLOW,
  MEMBER_ALLOW,
  MEMBER_DENY,
  STAFF_ALLOW,
} = require("../src/features/tickets/overwrites");
const {
  getManageableStaffRoleIdsFluxer,
} = require("../src/features/tickets/helpers");
const { PermissionFlagsBits } = require("discord.js");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "1554590611015729152";
const CHANNEL = "555000111";
const AUTHOR = "5";
const BOT = "bot-1";

const registry = buildDefaultRegistry();
const P = { registryCommands: registry.commands, prefix: "!" };
const COMMUNITY_ID = ensureCommunity({
  platform: "fluxer",
  instanceKey: INSTANCE,
  externalGuildId: GUILD,
});

// Staff roster fixtures: 555 "Support" (pos 4) sits BELOW the bot's top role
// (500 "Bot Role", pos 10) → manageable. 777 "Overlord" (pos 40) sits above
// → skipped "above bot role in hierarchy". 999 is in staff_roles but NOT on
// the guild role list → skipped "role not found in guild". 600 carries the
// MANAGE_GUILD bit (1<<5 = 32) so a staff author can reach staff-gated arms.
const ROLES_FIXTURE = [
  { id: GUILD, name: "@everyone", position: 0, permissions: "104324160" },
  { id: "500", name: "Bot Role", position: 10, permissions: "8" },
  { id: "555", name: "Support", position: 4, permissions: "104324160" },
  { id: "777", name: "Overlord", position: 40, permissions: "104324160" },
  { id: "600", name: "Moderator", position: 3, permissions: "32" },
];
const BOT_MEMBER_FIXTURE = {
  user: { id: BOT, username: "boiler", bot: true },
  roles: ["500"],
};

function setElevatedFlag(value) {
  dbApi.db
    .prepare("UPDATE communities SET elevated_permissions=? WHERE id=?")
    .run(value, COMMUNITY_ID);
}

/** A NormalizedMessage through the REAL normalizer (dispatch-faithful shape). */
function fluxerMessage(overrides = {}) {
  const normalized = normalizeFluxerMessage(
    {
      t: "MESSAGE_CREATE",
      d: gatewayMessage({ content: "", channel_id: CHANNEL, guild_id: GUILD, ...overrides }),
    },
    { instanceKey: INSTANCE },
  );
  normalized.communityId = COMMUNITY_ID;
  return normalized;
}

function postCalls(rest) {
  return rest.calls.filter((c) => c.method === "POST");
}

function findPost(rest, path) {
  return postCalls(rest).find((c) => c.path === path);
}

/** Run the shared member/roles reads every fluxer ticket create performs. */
function roleReads() {
  return {
    [`GET /v1/guilds/${GUILD}/members/${BOT}`]: BOT_MEMBER_FIXTURE,
    [`GET /v1/guilds/${GUILD}/roles`]: ROLES_FIXTURE,
  };
}

describe("fluxer/tickets — !ticket create over the OutboundClient (PR 9)", () => {
  before(() => {
    // No rate-limit noise between the cases sharing this community.
    updateGuildSettings(COMMUNITY_ID, { ticket_rate_limit_minutes: 0 });
  });

  it("flag 1: creates the channel with decimal-string overwrites, the ticket row, and the open notice", async () => {
    setElevatedFlag(1);
    updateGuildSettings(COMMUNITY_ID, { ticket_category_id: "6001" });
    addStaffRole(COMMUNITY_ID, "555", "senior");
    addStaffRole(COMMUNITY_ID, "777", "senior");

    const rest = makeFakeRest({
      routes: {
        ...roleReads(),
        [`POST /v1/guilds/${GUILD}/channels`]: { id: "tc-42" },
        "POST /v1/channels/tc-42/messages": { id: "open-1" },
        "POST /v1/users/@me/channels": { id: "dm-1" },
        "POST /v1/channels/dm-1/messages": { id: "reply-1" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const supervisor = { discord: null, fluxer: new Map(), clientForCommunity: () => outbound };

    const content = '!ticket create reason "Voice chat broken"';
    const parsed = parsePrefix(content, P);
    assert.equal(parsed.usageError, null, "the parser resolves the create arm");

    // Capture console.warn: the skip log is part of the warnings pattern.
    const origWarn = console.warn;
    const warns = [];
    console.warn = (...args) => warns.push(args.join(" "));
    try {
      await dispatchPrefixCommand(outbound, fluxerMessage({ content }), parsed, {
        registry,
        supervisor,
      });
    } finally {
      console.warn = origWarn;
    }

    // --- the shipped createChannel wire (outbound.js POST body shape) ---
    const chCalls = rest.calls.filter(
      (c) => c.method === "POST" && c.path === `/v1/guilds/${GUILD}/channels`,
    );
    assert.equal(chCalls.length, 1, "exactly one channel create");
    const body = chCalls[0].body;
    assert.equal(body.type, 0, "Fluxer text channel is type 0");
    assert.equal(
      body.parent_id,
      "6001",
      "settings.ticket_category_id rides as parent_id",
    );
    assert.equal(body.name, "ticket-1", "ticket-<n> naming (first ticket here)");

    const ows = body.permission_overwrites;
    assert.ok(Array.isArray(ows) && ows.length >= 4, "base + staff overwrites");

    // @everyone = the EXTERNAL GUILD id (Phase 0), ViewChannel denied as a
    // DECIMAL STRING (BigInt→String — never a JS number on the wire).
    const everyone = ows.find((ow) => ow.id === String(GUILD));
    assert.deepEqual(
      everyone,
      {
        id: String(GUILD),
        type: 0,
        allow: "0",
        deny: BigInt(PermissionFlagsBits.ViewChannel).toString(),
      },
      "@everyone overwrite: kind role → type 0, deny ViewChannel decimal",
    );
    assert.equal(everyone.deny, "1024", "ViewChannel is 1<<10 decimal-stringed");

    const botOw = ows.find((ow) => ow.id === BOT);
    assert.deepEqual(botOw, {
      id: BOT,
      type: 1,
      allow: BigInt(BOT_ALLOW).toString(),
      deny: "0",
    });

    // Public self-create (openedByStaffId: null — mirrors Discord's
    // completeSelfCreate; the bundle's ctx.userId pin was wrong, A flagged):
    // the creator gets MEMBER access, not staff access.
    const creatorOw = ows.find((ow) => ow.id === AUTHOR);
    assert.deepEqual(creatorOw, {
      id: AUTHOR,
      type: 1,
      allow: BigInt(MEMBER_ALLOW).toString(),
      deny: BigInt(MEMBER_DENY).toString(),
    });

    const supportOw = ows.find((ow) => ow.id === "555");
    assert.deepEqual(
      supportOw,
      { id: "555", type: 0, allow: BigInt(STAFF_ALLOW).toString(), deny: "0" },
      "manageable senior staff role (position 4 < bot 10) gets STAFF_ALLOW",
    );
    assert.ok(
      !ows.some((ow) => ow.id === "777"),
      "Overlord (position 40 ≥ bot) is SKIPPED — no overwrite for it",
    );

    // BigInt discipline at the boundary: every mask is a decimal STRING.
    for (const ow of ows) {
      assert.equal(typeof ow.allow, "string", `${ow.id}: allow is a string`);
      assert.equal(typeof ow.deny, "string", `${ow.id}: deny is a string`);
      assert.match(ow.allow, /^\d+$/, `${ow.id}: allow is decimal`);
      assert.match(ow.deny, /^\d+$/, `${ow.id}: deny is decimal`);
      assert.equal(ow.kind, undefined, "wire converts kind → numeric type");
      assert.ok(ow.type === 0 || ow.type === 1, "type is the Phase 0 integer");
    }
    assert.ok(
      ows.some((ow) => ow.id === BOT && ow.allow === BigInt(MEMBER_ALLOW).toString()) === false,
      "the bot overwrite uses BOT_ALLOW, not MEMBER_ALLOW",
    );

    // --- ticket row in the real DB ---
    const row = getTicketByChannel(COMMUNITY_ID, "tc-42");
    assert.ok(row, "ticket row keyed by the created channel id");
    assert.equal(row.status, "open");
    assert.equal(row.reason, "Voice chat broken");
    assert.equal(row.creator_user_id, AUTHOR);
    assert.equal(
      row.opened_by_staff_id,
      null,
      "public self-create mirrors Discord completeSelfCreate (openedByStaffId: null)",
    );

    // --- open notice posted into the ticket channel (plain JSON embed) ---
    const notice = findPost(rest, "/v1/channels/tc-42/messages");
    assert.ok(notice, "open notice posted via sendChannel");
    assert.match(notice.body.content, /— staff will be with you shortly\./);
    assert.equal(notice.body.embeds.length, 1);
    assert.equal(notice.body.embeds[0].title, `Ticket #${row.ticket_number}`);
    assert.equal(notice.body.embeds[0].description, "Voice chat broken");
    assert.equal(
      notice.body.embeds[0].footer.text,
      "Staff: /ticket claim · close · sensitive · adduser",
      "embed text mirrors the Discord open notice (minus components)",
    );

    // --- K2 success reply via DM (deferred sensitive) ---
    const dm = findPost(rest, "/v1/channels/dm-1/messages");
    assert.ok(dm, "the create confirmation is private (K2)");
    assert.ok(
      dm.body.content.startsWith(`Ticket **#${row.ticket_number}** opened: <#tc-42>`),
      `reply names the ticket and channel, got: ${dm.body.content}`,
    );
    assert.match(
      dm.body.content,
      /Overlord\*{0,2} — above bot role in hierarchy/,
      "skipped staff roles surface in the access note (warnings pattern)",
    );

    // Skip log (AGENTS.md: specific cause with ids, never a silent drop).
    assert.ok(
      warns.some(
        (w) =>
          w.includes("[tickets] Skipping 1 staff role overwrite(s):") &&
          w.includes("Overlord (777): above bot role in hierarchy"),
      ),
      `skip warning logged with name + id + reason, got: ${JSON.stringify(warns)}`,
    );

    // --- audit row (community-keyed, no Discord interaction) ---
    const audit = dbApi.db
      .prepare(
        "SELECT * FROM admin_audit WHERE community_id=? AND action='tickets.create'",
      )
      .all(COMMUNITY_ID);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, AUTHOR);
    assert.equal(audit[0].target_type, "ticket");
    assert.equal(audit[0].target_id, String(row.id));

    // No deleteChannel surface exists (PR 9 scope): zero DELETEs.
    assert.equal(rest.calls.filter((c) => c.method === "DELETE").length, 0);
  });

  it("flag 0: NO channel-endpoint network; the gate's own reason is the reply", async () => {
    setElevatedFlag(0);
    const ticketsBefore = listOpenTickets(COMMUNITY_ID, { userId: AUTHOR, limit: 50 }).length;

    const rest = makeFakeRest({
      routes: {
        ...roleReads(),
        // Deliberately NO POST /v1/guilds/.../channels route: a leaked create
        // would surface as a 404 FAKE_NO_ROUTE failure, not the gate reason.
        "POST /v1/users/@me/channels": { id: "dm-2" },
        "POST /v1/channels/dm-2/messages": { id: "reply-2" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const supervisor = { discord: null, fluxer: new Map(), clientForCommunity: () => outbound };

    const content = '!ticket create reason "MFA locked"';
    const parsed = parsePrefix(content, P);
    await dispatchPrefixCommand(outbound, fluxerMessage({ content }), parsed, {
      registry,
      supervisor,
    });

    const paths = rest.calls.map((c) => `${c.method} ${c.path}`);
    assert.ok(
      !paths.includes(`POST /v1/guilds/${GUILD}/channels`),
      `K8 short-circuit: no channel POST with flag 0, got ${JSON.stringify(paths)}`,
    );

    const dm = findPost(rest, "/v1/channels/dm-2/messages");
    assert.ok(dm, "the refusal reaches the user via DM (K2)");
    // The gate's own reason, VERBATIM (AGENTS.md rule 3 — user-actionable).
    assert.match(dm.body.content, /createChannel: elevated Fluxer actions are disabled/);
    assert.match(dm.body.content, /elevated_permissions=0/);
    assert.match(
      dm.body.content,
      /They unlock when Phase 0 records the MFA\/2FA result for instance/,
    );

    const ticketsAfter = listOpenTickets(COMMUNITY_ID, { userId: AUTHOR, limit: 50 }).length;
    assert.equal(ticketsAfter, ticketsBefore, "no ticket row when the gate blocks");
  });

  it("no live connection replies the specific no-connection line (not NOT_ON_FLUXER)", async () => {
    setElevatedFlag(1);
    const rest = makeFakeRest({
      routes: { [`POST /v1/channels/${CHANNEL}/messages`]: { id: "c-1" } },
    });
    const { outbound } = makeFakeHandle({ rest });

    const content = '!ticket create reason "offline guild"';
    const parsed = parsePrefix(content, P);
    await dispatchPrefixCommand(outbound, fluxerMessage({ content }), parsed, {
      registry,
      supervisor: null, // no supervisor → clientForCommunity resolves null
    });

    const channelPost = findPost(rest, `/v1/channels/${CHANNEL}/messages`);
    assert.ok(channelPost, "the no-connection reply is a channel message (not sensitive)");
    assert.equal(
      channelPost.body.content,
      "This Fluxer community has no live bot connection — the command cannot run.",
    );
    assert.ok(
      !rest.calls.some((c) => c.path === `/v1/guilds/${GUILD}/members/${BOT}`),
      "the pipeline stops before touching the ticket path",
    );
  });

  it("the panel arm keeps the standard not-available line (staff author)", async () => {
    const rest = makeFakeRest({
      routes: {
        ...roleReads(),
        [`GET /v1/channels/${CHANNEL}`]: { id: CHANNEL, type: 0, permission_overwrites: [] },
        "POST /v1/users/@me/channels": { id: "dm-3" },
        "POST /v1/channels/dm-3/messages": { id: "reply-3" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    // Staff author (role 600 carries MANAGE_GUILD) so the staff gate opens
    // and the panel arm itself is reached.
    const content = "!ticket panel list";
    const parsed = parsePrefix(content, P);
    await dispatchPrefixCommand(
      outbound,
      fluxerMessage({ content, member: { roles: ["600"] } }),
      parsed,
      { registry, supervisor: null },
    );

    // Panel arms post discord.js components; they stay Discord-only (index.js
    // rawInteraction guard). The staff author's answer is the NOT_ON_FLUXER
    // copy, DM'd (sensitive), and no ticket-create machinery runs.
    const dm = findPost(rest, "/v1/channels/dm-3/messages");
    assert.ok(dm, "staff denial/panel answer arrives by DM (K2 sensitive)");
    assert.equal(dm.body.content, "That command is not available on Fluxer yet.");
    assert.ok(
      !rest.calls.some((c) => c.method === "POST" && c.path === `/v1/guilds/${GUILD}/channels`),
      "the panel arm never reaches the ticket-create path",
    );
  });
});

describe("fluxer/tickets — getManageableStaffRoleIdsFluxer", () => {
  async function silent(fn) {
    const origError = console.error;
    const origWarn = console.warn;
    const logs = [];
    console.error = (...args) => logs.push(args.join(" "));
    console.warn = (...args) => logs.push(args.join(" "));
    try {
      const out = await fn();
      return { out, logs };
    } finally {
      console.error = origError;
      console.warn = origWarn;
    }
  }

  it("skips roles at/above the bot and roles missing from the guild", async () => {
    addStaffRole(COMMUNITY_ID, "555", "senior");
    addStaffRole(COMMUNITY_ID, "777", "senior");
    addStaffRole(COMMUNITY_ID, "999", "senior"); // not in ROLES_FIXTURE

    const rest = makeFakeRest({ routes: roleReads() });
    const { outbound } = makeFakeHandle({ rest });

    const { out, logs } = await silent(() =>
      getManageableStaffRoleIdsFluxer(outbound, COMMUNITY_ID),
    );

    assert.deepEqual(out.roleIds, ["555"], "only the position-below-bot role is manageable");
    const above = out.skipped.find((s) => s.id === "777");
    assert.deepEqual(
      above,
      { id: "777", name: "Overlord", reason: "above bot role in hierarchy" },
      "skip carries name + specific reason (Discord-shape)",
    );
    const missing = out.skipped.find((s) => s.id === "999");
    assert.deepEqual(
      missing,
      { id: "999", name: null, reason: "role not found in guild" },
      "staff row with no guild role is skipped, not minted",
    );
    assert.equal(logs.length, 0, "the repo function itself stays quiet (the CALLER logs skips)");
  });

  it("missing bot member → every staff role skipped with 'bot member roles unknown'", async () => {
    const rest = makeFakeRest({ routes: {} }); // GET member → 404 → null
    const { outbound } = makeFakeHandle({ rest });

    const { out, logs } = await silent(() =>
      getManageableStaffRoleIdsFluxer(outbound, COMMUNITY_ID),
    );

    assert.deepEqual(out.roleIds, [], "no hierarchy data → no staff overwrites");
    const ids = out.skipped.map((s) => s.id).sort();
    assert.deepEqual(ids, ["555", "777", "999"]);
    for (const s of out.skipped) {
      assert.equal(s.reason, "bot member roles unknown");
    }
    assert.ok(
      logs.some((l) => l.includes("[fluxer] fetchMember")),
      "the outbound's fetch failure is logged by the transport",
    );
  });
});
