const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { namespaceIds } = require("./helpers/mockenv");

const MSG_DENIED = "You don't have permission to use this.";

/**
 * Tier-4 tickets config + panel coverage (issue #317, part 1/3).
 * Namespace 8.
 *
 * Gate truth (from src/features/tickets/index.js — the issue matrix asked
 * to "check senior per AGENTS"): setcategory/setarchive/setratelimit and
 * the panel group run behind requireStaff (junior passes). Seniority only
 * drives ticket-CHANNEL overwrites (covered in ns 23 + ns 10).
 *
 * Not covered here by design: invalid channel-type picks for
 * setcategory/setarchive are picker-side (Discord channel_types) — the
 * mock resolves any channel id and the handler has no type check, so the
 * row is not E2E-reproducible.
 */
describe(
  "e2e: ticket config & panel lifecycle",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    /** junior staff member (proves the gate is staff, not admin/senior) */
    let staffRoleId;

    const ids = namespaceIds(8);

    before(async () => {
      env = await createE2eEnv({
        ns: 8,
        channels: [
          { id: ids.general, name: "general" },
          { id: ids.channel2, name: "e2e-two" },
          { id: ids.category, name: "E2E Cats", type: 4 },
        ],
      });
      staffRoleId = (await env.mock.createRole("E2E Ticket Staff")).id;
      await env.mock.grantRole(env.ids.human, staffRoleId);
      env.dbmod.addStaffRole(env.communityId, String(staffRoleId), "junior");
    });

    after(async () => {
      await env?.cleanup();
    });

    const sub = (name, options = []) => ({
      name,
      type: 1,
      ...(options.length && { options }),
    });
    const group = (group, ...subs) => ({
      name: group,
      type: 2,
      options: subs,
    });
    const chanOpt = (name, id) => ({ name, type: 7, value: id });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const auditRow = (action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM admin_audit WHERE community_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(env.communityId, action);
    const settings = () => env.dbmod.getTicketSettings(env.communityId);

    it("/ticket settings is PUBLIC and shows the pristine defaults", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [sub("settings")],
        userId: env.ids.outsider,
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      assert.match(content, /\*\*Ticket settings\*\*/);
      assert.match(content, /Category: _not set_/);
      assert.match(content, /Self-create rate limit: \*\*60 min\*\*/);
      assert.match(
        content,
        new RegExp(String(staffRoleId)),
        "junior staff role listed in settings",
      );
    });

    it("config commands are staff-gated (non-staff denied)", async () => {
      for (const [name, options] of [
        ["setcategory", [chanOpt("category", ids.category)]],
        ["setarchive", [chanOpt("channel", ids.channel2)]],
        ["setratelimit", [{ name: "minutes", type: 4, value: 30 }]],
      ]) {
        const inter = await env.mock.slash({
          command: "ticket",
          options: [sub(name, options)],
          userId: env.ids.outsider,
        });
        assert.equal(
          String((await env.mock.awaitReply(inter)).content),
          MSG_DENIED,
          `${name} denial copy`,
        );
      }
    });

    it("/ticket setcategory persists the category (junior staff passes)", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [sub("setcategory", [chanOpt("category", ids.category)])],
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      assert.equal(content, "New tickets will be created under **E2E Cats**.");
      assert.equal(settings().ticket_category_id, ids.category);

      const audit = auditRow("tickets.category_set");
      assert.ok(audit, "tickets.category_set audit row");
      assert.equal(audit.actor_user_id, env.ids.human);
    });

    it("/ticket setarchive persists the transcript channel", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [sub("setarchive", [chanOpt("channel", ids.channel2)])],
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      assert.match(
        content,
        new RegExp(
          `Close summaries and transcript links will post to <#${ids.channel2}>\\.`
        ),
      );
      assert.equal(settings().ticket_archive_channel_id, ids.channel2);
      assert.ok(auditRow("tickets.archive_channel_set"));
    });

    it("/ticket setratelimit: zero disables, positive persists, settings echo shows it", async () => {
      const off = await env.mock.slash({
        command: "ticket",
        options: [sub("setratelimit", [{ name: "minutes", type: 4, value: 0 }])],
      });
      assert.equal(
        String((await env.mock.awaitReply(off)).content),
        "Member self-create rate limit **disabled**.",
      );
      assert.equal(settings().ticket_rate_limit_minutes, 0);

      const on = await env.mock.slash({
        command: "ticket",
        options: [sub("setratelimit", [{ name: "minutes", type: 4, value: 30 }])],
      });
      assert.match(
        String((await env.mock.awaitReply(on)).content),
        /at most one ticket every \*\*30\*\* minute\(s\)\. Staff `\/ticket for` is not rate-limited\./,
      );
      assert.equal(settings().ticket_rate_limit_minutes, 30);
      assert.ok(auditRow("tickets.rate_limit_set"));

      const view = await env.mock.slash({
        command: "ticket",
        options: [sub("settings")],
        userId: env.ids.outsider,
      });
      const content = String((await env.mock.awaitReply(view)).content);
      assert.match(content, new RegExp(`Category: <#${ids.category}>`));
      assert.match(content, /Self-create rate limit: \*\*30 min\*\*/);
    });

    it("panel create rejects a non-text target channel", async () => {
      // The category arrives as the resolved `channel:` option (real
      // pickers restrict types; the mock does not — the handler's own
      // type guard must answer).
      const inter = await env.mock.slash({
        command: "ticket",
        options: [
          group(
            "panel",
            sub("create", [chanOpt("channel", ids.category)]),
          ),
        ],
      });
      // Categories resolve but carry no send() → the resolver guard fires
      // first (the type-mismatch copy below it is only reachable for
      // sendable non-text channels, e.g. threads, which the mock does not
      // deliver via GUILD_CREATE).
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        "Could not resolve a text channel to post the panel. Pass `channel:` or run this in a text channel.",
      );
      assert.deepEqual(env.dbmod.listTicketPanels(env.communityId), []);
    });

    let panelMessageId = null;

    it("/ticket panel create posts the panel, defers, and editReplies the jump", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [group("panel", sub("create"))],
      });
      const reply = await env.mock.awaitSettledReply(inter);
      assert.match(
        String(reply.content),
        new RegExp(`Created ticket panel in <#${ids.general}>\\.`),
      );

      const panel = env.dbmod.listTicketPanels(env.communityId)[0];
      assert.ok(panel, "ticket_panels row");
      panelMessageId = String(panel.message_id);
      assert.match(String(reply.content), new RegExp(panelMessageId));

      const msg = await env.mock.message(panelMessageId, ids.general);
      assert.equal(msg.embeds?.[0]?.title, "Support Tickets");
      const buttons = await env.mock.buttons(panelMessageId, ids.general);
      assert.ok(
        buttons.some((b) => b.custom_id === "tk:open"),
        "tk:open button persisted on the panel",
      );

      const audit = auditRow("tickets.panel_create");
      assert.equal(audit.target_id, panelMessageId);
    });

    it("/ticket panel list shows the stored panel", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [group("panel", sub("list"))],
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      assert.match(content, /\*\*Ticket panels:\*\*/);
      assert.match(content, new RegExp(panelMessageId));
    });

    it("/ticket panel edit validates, updates the row AND the Discord embed", async () => {
      const bare = await env.mock.slash({
        command: "ticket",
        options: [
          group(
            "panel",
            sub("edit", [strOpt("message_id", panelMessageId)]),
          ),
        ],
      });
      assert.equal(
        String((await env.mock.awaitSettledReply(bare)).content),
        "Provide at least one of `title` or `description` to update.",
      );

      const edit = await env.mock.slash({
        command: "ticket",
        options: [
          group(
            "panel",
            sub("edit", [
              strOpt("message_id", panelMessageId),
              strOpt("title", "Help Desk"),
            ]),
          ),
        ],
      });
      assert.match(
        String((await env.mock.awaitSettledReply(edit)).content),
        new RegExp(`Updated ticket panel \\\`${panelMessageId}\\\`.`),
      );

      assert.equal(
        env.dbmod.getTicketPanel(env.communityId, panelMessageId).title,
        "Help Desk",
        "row title updated",
      );
      const msg = await env.mock.message(panelMessageId, ids.general);
      assert.equal(msg.embeds?.[0]?.title, "Help Desk", "embed updated in place");
      assert.ok(auditRow("tickets.panel_update"));
    });

    it("/ticket panel delete removes row + Discord message", async () => {
      const del = await env.mock.slash({
        command: "ticket",
        options: [
          group(
            "panel",
            sub("delete", [strOpt("message_id", panelMessageId)]),
          ),
        ],
      });
      assert.match(
        String((await env.mock.awaitSettledReply(del)).content),
        new RegExp(`Deleted ticket panel \\\`${panelMessageId}\\\`.`),
      );
      assert.ok(!env.dbmod.getTicketPanel(env.communityId, panelMessageId));

      const gone = await env.mock
        .message(panelMessageId, ids.general)
        .then(() => false)
        .catch((err) => err.status === 404);
      assert.ok(gone, "panel message deleted from the channel");
      assert.ok(auditRow("tickets.panel_delete"));

      const unknown = await env.mock.slash({
        command: "ticket",
        options: [
          group("panel", sub("delete", [strOpt("message_id", panelMessageId)])),
        ],
      });
      assert.match(
        String((await env.mock.awaitSettledReply(unknown)).content),
        /No ticket panel with message ID/,
      );
    });

    it("panel commands are staff-gated", async () => {
      const inter = await env.mock.slash({
        command: "ticket",
        options: [group("panel", sub("list"))],
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(inter)).content),
        MSG_DENIED,
      );
    });
  },
);
