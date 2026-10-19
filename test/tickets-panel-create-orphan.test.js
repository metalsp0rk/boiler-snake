/**
 * #472 (LT-16.6): panel-create orphan compensation.
 *
 * The panel message used to post BEFORE the registry insert; a rejected
 * insert left a fully functional but UNREGISTERED panel message live (the
 * catch still said "Failed to post panel"), invisible to `/ticket panel
 * list|edit` — and every retry stacked another orphan.
 *
 * Contract now: registry failure ⇒ best-effort delete the posted message and
 * reply with the honest partial-failure copy naming the residue when the
 * cleanup itself fails.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { loadDb, communityKey } = require("./helpers/env");
const {
  createChatInputInteraction,
  createClient,
  createGuild,
  createUser,
  createMember,
  lastReplyContent,
} = require("./helpers/discord");

describe("tickets panel create — registry-failure orphan compensation", () => {
  /** @type {ReturnType<typeof loadDb>} */
  let loaded;
  let db;
  let panel;

  before(() => {
    // Contract: loadDb() before every src/ require (fresh temp DB_PATH).
    loaded = loadDb();
    db = loaded.api;
    panel = require("../src/features/tickets/panel");
  });

  after(() => {
    if (loaded?.tmpDir) {
      try {
        require("fs").rmSync(loaded.tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  const MSG_ID = "222222222222222222";

  function makeEnv(guildId) {
    const deleted = [];
    const guild = createGuild({ id: guildId });
    const client = createClient();
    client.addGuild(guild);
    const user = createUser({ id: `staff-${guildId}` });
    const member = createMember({ guild, user, admin: true });
    guild.addMember(member);
    // Deterministic fake: every send() returns the SAME message id, so the
    // second create hits the (guild_id, message_id) primary key — the real
    // way to fail the insert without patching the db layer.
    const panelChannel = {
      id: "900000000000000101",
      type: null, // "mocks may omit type" is an accepted arm
      send: async () => ({
        id: MSG_ID,
        delete: async () => {
          deleted.push(MSG_ID);
        },
      }),
    };
    return { guild, client, user, member, panelChannel, deleted };
  }

  async function runPanelCreate(env) {
    const interaction = createChatInputInteraction({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "create",
      guild: env.guild,
      user: env.user,
      member: env.member,
      options: { channel: env.panelChannel },
      client: env.client,
    });
    await panel.handlePanelCreate(interaction, { client: env.client });
    return interaction;
  }

  it("a rejected registry insert removes the posted message and says so", async () => {
    const env = makeEnv("400000000000000041");

    const first = await runPanelCreate(env);
    assert.match(lastReplyContent(first), /Created ticket panel/i);
    const cid = communityKey("400000000000000041");
    assert.equal(
      db.listTicketPanels(cid).length,
      1,
      "first create registers exactly one panel",
    );
    assert.deepEqual(env.deleted, [], "success path deletes nothing");

    // Second create: same fake message id → PK violation inside
    // createTicketPanel AFTER the message post.
    const second = await runPanelCreate(env);
    const copy = lastReplyContent(second);
    assert.match(copy, /Failed to post panel:/, "specific-failure reply (rule 3)");
    assert.match(copy, /registry insert failed/, "names the real cause");
    assert.match(
      copy,
      /the unposted panel message was removed/,
      "cleanup outcome is part of the reply",
    );
    assert.deepEqual(
      env.deleted,
      [MSG_ID],
      "the orphaned panel message was deleted (compensating cleanup)",
    );
    assert.equal(
      db.listTicketPanels(cid).length,
      1,
      "the registry still holds exactly the first panel — no stack-up",
    );
  });

  it("when even the cleanup fails, the reply names the live orphan", async () => {
    const env = makeEnv("400000000000000042");
    await runPanelCreate(env); // register MSG_ID
    // Break the cleanup: delete() now throws.
    const origSend = env.panelChannel.send;
    env.panelChannel.send = async () => ({
      id: MSG_ID,
      delete: async () => {
        throw new Error("Missing Permissions");
      },
    });
    const third = await runPanelCreate(env);
    env.panelChannel.send = origSend;
    const copy = lastReplyContent(third);
    assert.match(copy, /registry insert failed/);
    assert.match(
      copy,
      new RegExp(`panel message ${MSG_ID} IS LEFT LIVE`),
      "the user is told exactly what residue remains and where",
    );
    assert.match(copy, /Missing Permissions/, "the cleanup cause rides along");
  });
});
