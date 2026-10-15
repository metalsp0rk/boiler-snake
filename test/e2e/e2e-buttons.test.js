const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll } = require("./helpers/mockenv");

const MSG_DENIED = "You don't have permission to use this.";

/**
 * Tier-4 E2E buttons: the full component round-trip — slash command posts a
 * persisted button panel (type-4 persistence), a simulated MESSAGE_COMPONENT
 * click routes to the feature's button handler, and interaction.update()
 * edits the stored message (type-7 persistence). Namespace 2.
 *
 * Target feature: /userinfo (staff-gated panel, `ui:` custom-id family).
 */
describe("e2e: button interactions (/userinfo panel)", { concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
  let env;

  before(async () => {
    env = await createE2eEnv({ ns: 2 });
    // Staff via the staff_roles DB path (NOT ManageGuild — the mock's
    // member objects carry role ids but no permissions string, exactly
    // exercising requireStaff's staff_roles branch).
    const role = await env.mock.createRole("E2E Staff");
    await env.mock.grantRole(env.ids.human, role.id);
    env.dbmod.addStaffRole(env.communityId, String(role.id), "junior");
  });

  after(async () => {
    await env?.cleanup();
  });

  /** Open a /userinfo panel and return { messageId, buttons }. */
  async function openPanel(userId = env.ids.human) {
    const inter = await env.mock.slash({
      command: "userinfo",
      options: [{ name: "user", type: 6, value: env.ids.target }],
      userId,
    });
    const reply = await env.mock.awaitReply(inter);
    const buttons = await env.mock.buttons(reply.id);
    return { reply, messageId: reply.id, buttons };
  }

  it("/userinfo posts an ephemeral panel with persisted button components", async () => {
    const { reply, buttons } = await openPanel();
    assert.ok(reply.embeds?.length >= 1, "panel carries an embed");
    assert.equal(Number(reply.flags) & 64, 64, "panel is ephemeral");
    const ids = buttons.map((b) => b.custom_id);
    assert.ok(
      ids.some((id) => String(id).startsWith("ui:o:")),
      `overview button present (ids=${ids.join(",")})`,
    );
    assert.ok(
      ids.some((id) => String(id).startsWith("ui:n:")),
      "notes button present",
    );
  });

  it("clicking a panel button re-renders and persists the message edit", async () => {
    const { messageId, buttons } = await openPanel();
    assert.equal(
      (await env.mock.message(messageId)).edited_timestamp,
      null,
      "panel starts un-edited",
    );

    const notesBtn = buttons.find((b) => String(b.custom_id).startsWith("ui:n:"));
    const click = await env.mock.click({
      customId: notesBtn.custom_id,
      messageId,
    });
    assert.ok(click.message, "click simulation carries the attached message");

    const edited = await poll(
      async () => {
        const m = await env.mock.message(messageId);
        return m.edited_timestamp ? m : null;
      },
      { timeoutMs: 10_000, label: "panel edit persisted via interaction.update()" },
    );

    // The Notes view must have actually rendered: label change on the row.
    const after = (edited.components || []).flatMap((row) => row.components || []);
    const active = after.find((b) => b.disabled);
    assert.match(String(notesBtn.custom_id), /ui:n:/);
    assert.ok(active, "view switch re-rendered the row (one button disabled)");
    assert.match(String(active.custom_id), /^ui:n:/, "Notes view is now active");
  });

  it("junior staff clicking an activity view gets the senior-staff denial", async () => {
    const { messageId } = await openPanel();
    const click = await env.mock.click({
      customId: `ui:a:${env.ids.target}`,
      messageId,
    });
    const reply = await env.mock.awaitReply(click);
    assert.match(String(reply.content), /senior/i);
    assert.notEqual(String(reply.content).indexOf(MSG_DENIED), 0, "senior copy, not generic denial");
  });

  it("unknown ui: control from staff gets the unknown-control reply", async () => {
    const { messageId } = await openPanel();
    const click = await env.mock.click({
      customId: `ui:zz:${env.ids.target}`,
      messageId,
    });
    const reply = await env.mock.awaitReply(click);
    assert.match(String(reply.content), /unknown userinfo control/i);
  });

  it("non-staff click on the panel is denied and leaves the panel untouched", async () => {
    const { messageId } = await openPanel();
    const click = await env.mock.click({
      customId: `ui:n:${env.ids.target}`,
      messageId,
      userId: env.ids.outsider,
    });
    const reply = await env.mock.awaitReply(click);
    assert.equal(String(reply.content), MSG_DENIED);
    const msg = await env.mock.message(messageId);
    assert.equal(msg.edited_timestamp, null, "denied click did not edit the panel");
  });

  it("/userinfo from non-staff is denied at the slash gate", async () => {
    const inter = await env.mock.slash({
      command: "userinfo",
      options: [{ name: "user", type: 6, value: env.ids.target }],
      userId: env.ids.outsider,
    });
    const reply = await env.mock.awaitReply(inter);
    assert.equal(String(reply.content), MSG_DENIED);
  });
});
