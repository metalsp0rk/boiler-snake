const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll } = require("./helpers/mockenv");

/**
 * Tier-4 community-events coverage (issue #318, part 1/3). Namespace 11:
 * the `/event` CRUD + lifecycle half — list empty/populated, create → E3
 * preview (row + options + Post/Discard buttons), post via ev:ok (announce
 * embed + RSVP/utility buttons + activity row), already-posted gates, the
 * ev:ed → evm:edit modal round-trip (invalid time refuses; valid edits
 * refresh the LIVE announcement message in place), duplicate → draft → post,
 * discard ownership branches, recurrence series wiring, the two-step delete
 * (command AND button paths, requester-bound confirm, announcement removal),
 * autocomplete on the integer `event` picker, and the /event wizard DM
 * handshake (seeded walkthrough row; the mock cannot enumerate DM
 * channels, so the in-channel half is what is pinned).
 *
 * Signup/RSVP (ns 12) and reminders/config (ns 13) are sibling suites.
 */
describe(
  "e2e: community events CRUD + lifecycle (create → post → edit → delete)",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;

    before(async () => {
      env = await createE2eEnv({ ns: 11 });
      const staffRole = await env.mock.createRole("E2E Events Staff");
      await env.mock.grantRole(env.ids.human, staffRole.id);
      env.dbmod.addStaffRole(env.communityId, String(staffRole.id), "junior");
    });

    after(async () => {
      await env?.cleanup();
    });

    const sub = (name, options = []) => ({
      name,
      type: 1,
      ...(options.length && { options }),
    });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const eventCmd = (name, eventId, userId) =>
      env.mock.slash({
        command: "event",
        options: [sub(name, [intOpt("event", eventId)])],
        ...(userId && { userId }),
      });
    const activityRow = (eventId, action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM event_activity WHERE event_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(eventId, action);
    const btns = (messageId) => env.mock.buttons(messageId, env.ids.general);

    /** Shared state: the primary event + its preview reply + announcement. */
    const ev1 = { id: null, previewMsg: null, announcement: null };
    /** The duplicated+posted copy (delete-flow target). */
    const dupIds = { id: null, announcement: null };

    /** Create → E3 preview reply; returns { inter, reply, row }. */
    const createEvent = async (title, extraOpts = [], userId) => {
      const inter = await env.mock.slash({
        command: "event",
        options: [
          sub("create", [
            strOpt("title", title),
            strOpt("start", "in 2h"),
            ...extraOpts,
          ]),
        ],
        ...(userId && { userId }),
      });
      const reply = await env.mock.awaitReply(inter);
      return { inter, reply };
    };

    it("/event list is PUBLIC and shows the empty state", async () => {
      const inter = await env.mock.slash({
        command: "event",
        options: [sub("list")],
        userId: env.ids.outsider, // public tier — outsider is served
      });
      const reply = await env.mock.awaitReply(inter);
      const embed = reply.embeds?.[0];
      assert.ok(embed, "list embed reply");
      assert.equal(embed.title, "📆 Upcoming events");
      assert.equal(
        embed.description,
        "No upcoming events. Create one with `/event create` or the `/event wizard`.",
      );
    });

    it("/event create builds the E3 preview (row, options, Post/Discard)", async () => {
      const { reply } = await createEvent("Lantern Night");
      assert.equal(
        String(reply.content),
        "Almost there — does the time look right?",
      );
      const embed = reply.embeds?.[0];
      assert.equal(embed.title, "Preview — Lantern Night");
      const details = embed.fields.find((f) => f.name === "Details").value;
      assert.match(details, /\*\*Starts:\*\* <t:\d+:F>/);
      assert.match(
        details,
        new RegExp(`\\*\\*Channel:\\*\\* <#${env.ids.general}>`),
        "post channel defaults to the interaction channel",
      );
      assert.match(details, /\*\*Options:\*\* Yes \/ No \/ Maybe/);
      assert.match(
        embed.fields.find((f) => f.name === "Confirm the time").value,
        /Does <t:\d+:F> look right\?/,
      );

      const buttons = await btns(reply.id);
      ev1.previewMsg = reply.id;

      // Row lands as pending_confirm with three options and cutoff == start.
      const row = await poll(async () => {
        const rows = env.dbmod.listUpcomingEvents(env.communityId, {
          limit: 50,
        });
        return rows.find((r) => r.title === "Lantern Night") || null;
      });
      ev1.id = row.id;
      assert.equal(row.status, "pending_confirm");
      assert.equal(String(row.creator_id), env.ids.human);
      assert.equal(String(row.channel_id), env.ids.general);
      assert.equal(Number(row.cutoff_at), Number(row.start_at));
      assert.equal(env.dbmod.listEventOptions(row.id).length, 3);

      const ids = buttons.map((b) => String(b.custom_id));
      assert.ok(ids.includes(`ev:ok:${ev1.id}`), `ev:ok button (${ids})`);
      assert.ok(ids.includes(`ev:rm:${ev1.id}`), `ev:rm button (${ids})`);
      assert.equal(
        buttons.find((b) => String(b.custom_id) === `ev:ok:${ev1.id}`).label,
        "✅ Post it",
      );

      // Wrong-person ev:rm is refused by name.
      const denied = await env.mock.click({
        customId: `ev:rm:${ev1.id}`,
        messageId: ev1.previewMsg,
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        "Only the organizer or staff can discard this draft.",
      );
    });

    it("ev:ok posts the announcement (embed, RSVP+utility buttons, activity)", async () => {
      // Organizer gate first: outsider cannot post someone's event.
      const denied = await env.mock.click({
        customId: `ev:ok:${ev1.id}`,
        messageId: ev1.previewMsg,
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        "Only the organizer or staff can post this event.",
      );

      const click = await env.mock.click({
        customId: `ev:ok:${ev1.id}`,
        messageId: ev1.previewMsg,
      });
      const reply = await env.mock.awaitSettledReply(click);
      // Thread/role/cross-post hiccups append notes — the ✅ itself is fixed.
      assert.match(String(reply.content), /^Posted ✅/);

      const row = await poll(async () => {
        const r = env.dbmod.getEventById(ev1.id);
        return r && r.status === "posted" && r.message_id ? r : null;
      });
      ev1.announcement = String(row.message_id);
      assert.equal(String(row.channel_id), env.ids.general);

      const msg = await env.mock.message(ev1.announcement);
      const embed = msg.embeds[0];
      assert.equal(embed.title, "Lantern Night");
      assert.match(
        String(embed.description),
        /React-less signups! Pick an option below/,
        "default body copy when no description given",
      );
      const when = embed.fields.find((f) => f.name === "📅 When").value;
      assert.match(when, /<t:\d+:F> \(<t:\d+:R>\)/);
      assert.equal(
        embed.fields.find((f) => f.name === "📍 Where").value,
        `<#${env.ids.general}>`,
      );
      assert.match(
        embed.fields.find((f) => f.name === "ℹ️").value,
        new RegExp(
          "Organizer <@" + env.ids.human + "> · Event `" + ev1.id + "`",
        ),
      );

      const buttons = await btns(ev1.announcement);
      const options = env.dbmod.listEventOptions(ev1.id);
      for (const o of options) {
        assert.ok(
          buttons.some(
            (b) => String(b.custom_id) === `ev:rs:${ev1.id}:${o.id}`,
          ),
          `RSVP button for ${o.label}`,
        );
      }
      const util = buttons
        .map((b) => String(b.custom_id))
        .filter((id) => /^ev:(ed|dl|gc):/.test(id));
      assert.deepEqual(util.sort(), [
        `ev:dl:${ev1.id}`,
        `ev:ed:${ev1.id}`,
        `ev:gc:${ev1.id}`,
      ]);

      assert.ok(activityRow(ev1.id, "posted"), "posted activity row");
    });

    it("already-posted gates: ev:ok no-ops, /event post refuses, bad ids name themselves", async () => {
      const click = await env.mock.click({
        customId: `ev:ok:${ev1.id}`,
        messageId: ev1.previewMsg,
      });
      assert.equal(
        String((await env.mock.awaitSettledReply(click)).content),
        "Already posted ✅",
      );

      const cmd = await env.mock.awaitReply(await eventCmd("post", ev1.id));
      assert.equal(String(cmd.content), "That event is already posted.");

      const ghost = await env.mock.awaitReply(
        await eventCmd("post", 999999999),
      );
      assert.equal(
        String(ghost.content),
        "No event **999999999** in this server.",
      );

      const noOpt = await env.mock.awaitReply(
        await env.mock.slash({ command: "event", options: [sub("delete")] }),
      );
      assert.equal(
        String(noOpt.content),
        "Which event? Pass `event:` (see `/event list`).",
      );
    });

    it("ev:ed → evm:edit modal: refusal copy, invalid time keeps state, valid edit refreshes the live post", async () => {
      const denied = await env.mock.click({
        customId: `ev:ed:${ev1.id}`,
        messageId: ev1.announcement,
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        "Only the **organizer**, **staff**, or holders of the required role may edit this event.",
      );

      const click = await env.mock.click({
        customId: `ev:ed:${ev1.id}`,
        messageId: ev1.announcement,
      });
      const state = await poll(
        async () => {
          const st = await env.mock.interactionState(click.id);
          return st.response_json?.type === 9 ? st : null;
        },
        { timeoutMs: 8000, label: "evm:edit modal display" },
      );
      const modal = state.response_json;
      assert.equal(modal.data.custom_id, `evm:edit:${ev1.id}`);
      assert.equal(modal.data.title, "Edit: Lantern Night");

      // Invalid time refuses loudly and changes nothing.
      const bad = await env.mock.modal({
        customId: `evm:edit:${ev1.id}`,
        fields: {
          title: "Lantern Night",
          start: "not a time",
          description: "should not persist",
          location: "",
        },
      });
      assert.match(
        String((await env.mock.awaitReply(bad)).content),
        /I couldn't read the start time: `Could not understand `not a time`\./,
      );
      assert.notEqual(
        env.dbmod.getEventById(ev1.id).description,
        "should not persist",
      );

      const submit = await env.mock.modal({
        customId: `evm:edit:${ev1.id}`,
        fields: {
          title: "Lantern Night",
          start: "",
          description: "Updated ns11 desc",
          location: "-",
        },
      });
      assert.match(
        String((await env.mock.awaitSettledReply(submit)).content),
        /Updated \*\*Lantern Night\*\* ✅/,
      );
      assert.equal(env.dbmod.getEventById(ev1.id).description, "Updated ns11 desc");

      // The LIVE announcement was re-edited in place (PATCH, no new message).
      const msg = await env.mock.message(ev1.announcement);
      assert.equal(msg.embeds[0].description, "Updated ns11 desc");
    });

    it("/event duplicate copies to a draft, /event post publishes it", async () => {
      const dup = await env.mock.awaitReply(await eventCmd("duplicate", ev1.id));
      const m = /Copied as draft \*\*Copy of Lantern Night\*\* \(`(\d+)`\)/.exec(
        String(dup.content),
      );
      assert.ok(m, `duplicate copy (got: ${dup.content})`);
      const dupId = Number(m[1]);

      let row = env.dbmod.getEventById(dupId);
      assert.equal(row.status, "draft");
      assert.equal(row.title, "Copy of Lantern Night");
      assert.equal(
        env.dbmod.listEventOptions(dupId).length,
        3,
        "options copied",
      );

      const post = await env.mock.awaitReply(await eventCmd("post", dupId));
      assert.match(String(post.content), /^Posted ✅/);

      row = await poll(async () => {
        const r = env.dbmod.getEventById(dupId);
        return r && r.status === "posted" && r.message_id ? r : null;
      });
      assert.ok(
        String(row.message_id) !== ev1.announcement,
        "second announcement message",
      );
      assert.ok(activityRow(dupId, "created"), "duplicate activity trail");
      dupIds.id = dupId;
      dupIds.announcement = String(row.message_id);
    });

    it("/event list shows both events with signup counts", async () => {
      const list = await env.mock.awaitReply(
        await env.mock.slash({ command: "event", options: [sub("list")] }),
      );
      const desc = list.embeds[0].description;
      assert.match(
        desc,
        new RegExp(`\\*\\*${ev1.id}\\*\\* · Lantern Night · <t:\\d+:R>`),
      );
      assert.match(desc, /· Copy of Lantern Night · <t:/);
      assert.match(desc, / · 0 signed up/);
    });

    it("discard: organizer-gated, deletes the draft and updates the preview", async () => {
      const { reply } = await createEvent("Throwaway");
      const row = env.dbmod
        .listUpcomingEvents(env.communityId, { limit: 50 })
        .find((r) => r.title === "Throwaway");
      assert.ok(row, "throwaway row exists");

      const denied = await env.mock.click({
        customId: `ev:rm:${row.id}`,
        messageId: reply.id,
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        "Only the organizer or staff can discard this draft.",
      );

      const click = await env.mock.click({
        customId: `ev:rm:${row.id}`,
        messageId: reply.id,
      });
      // interaction.update rewrites the ORIGINAL preview message.
      const updated = await poll(
        async () => {
          const msg = await env.mock
            .message(reply.id)
            .catch(() => null);
          return msg && /Draft discarded/.test(String(msg.content))
            ? msg
            : null;
        },
        { timeoutMs: 8000, label: "preview updated to Draft discarded" },
      );
      assert.equal(updated.content, "Draft discarded 🗑️");
      assert.equal(env.dbmod.getEventById(row.id), null, "draft row deleted");
    });

    it("recurrence attaches a series (weekly needs weekdays; count end-mode echoes)", async () => {
      const missing = await env.mock.slash({
        command: "event",
        options: [
          sub("create", [
            strOpt("title", "Orphan Series"),
            strOpt("start", "in 3d"),
            strOpt("recurrence", "weekly"),
          ]),
        ],
      });
      assert.equal(
        String((await env.mock.awaitReply(missing)).content),
        "Weekly series need weekdays, e.g. `tue,thu`.",
      );

      const { reply } = await createEvent("Weekly Sync", [
        strOpt("start", "in 3d"),
        strOpt("recurrence", "weekly"),
        strOpt("weekdays", "sat"),
        strOpt("end_mode", "count"),
        intOpt("end_count", 2),
      ]);
      assert.equal(
        String(reply.content),
        "Almost there — does the time look right? — repeating **weekly** (count ×2).",
      );
      const row = env.dbmod
        .listUpcomingEvents(env.communityId, { limit: 50 })
        .find((r) => r.title === "Weekly Sync");
      assert.ok(row?.series_id, "event row linked to its series");
      const series = env.dbmod.db
        .prepare("SELECT * FROM event_series WHERE id = ?")
        .get(row.series_id);
      assert.equal(series.cadence, "weekly");
      assert.equal(series.end_mode, "count");
      assert.equal(series.end_count, 2);
    });

    it("/event delete: two-step, requester-bound confirm, cascade removes the row", async () => {
      await createEvent("Doomed");
      const row = env.dbmod
        .listUpcomingEvents(env.communityId, { limit: 50 })
        .find((r) => r.title === "Doomed");

      const ask = await env.mock.awaitReply(await eventCmd("delete", row.id));
      assert.equal(
        String(ask.content),
        `Really delete **Doomed** (${row.id}) with all signups?`,
      );
      const buttons = await btns(ask.id);
      const btn = buttons.find((b) =>
        String(b.custom_id).startsWith(`ev:dlc:${row.id}:`),
      );
      assert.ok(btn, "Confirm delete button on the ask reply");
      assert.equal(btn.label, "Confirm delete");
      assert.equal(
        String(btn.custom_id),
        `ev:dlc:${row.id}:${env.ids.human}`,
        "confirm is bound to the requester",
      );

      const wrong = await env.mock.click({
        customId: String(btn.custom_id),
        messageId: ask.id,
        userId: env.ids.target,
      });
      assert.equal(
        String((await env.mock.awaitReply(wrong)).content),
        "Only the person who pressed Delete can confirm this.",
      );

      const ok = await env.mock.click({
        customId: String(btn.custom_id),
        messageId: ask.id,
      });
      const updated = await poll(
        async () => {
          const msg = await env.mock.message(ask.id).catch(() => null);
          return msg && /Deleted \*\*Doomed\*\*/.test(String(msg.content))
            ? msg
            : null;
        },
        { timeoutMs: 8000, label: "delete confirm rewrote the ask reply" },
      );
      assert.equal(
        updated.content,
        `Deleted **Doomed** (${row.id}).`,
      );
      assert.equal(env.dbmod.getEventById(row.id), null);
    });

    it("ev:dl on the posted copy: gate, confirm, announcement message deleted, row gone", async () => {
      const denied = await env.mock.click({
        customId: `ev:dl:${dupIds.id}`,
        messageId: dupIds.announcement,
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(denied)).content),
        "Only the **organizer**, **staff**, or holders of the required role may delete this event.",
      );

      const ask = await env.mock.click({
        customId: `ev:dl:${dupIds.id}`,
        messageId: dupIds.announcement,
      });
      const askMsg = await env.mock.awaitReply(ask);
      assert.match(
        String(askMsg.content),
        new RegExp(
          `Really delete \\*\\*Copy of Lantern Night\\*\\* \\(${dupIds.id}\\) with all signups\\?`,
        ),
      );

      const ok = await env.mock.click({
        customId: `ev:dlc:${dupIds.id}:${env.ids.human}`,
        messageId: askMsg.id,
      });
      const updated = await poll(
        async () => {
          const msg = await env.mock.message(askMsg.id).catch(() => null);
          return msg && /Deleted \*\*/.test(String(msg.content)) ? msg : null;
        },
        { timeoutMs: 8000, label: "button delete confirmed" },
      );
      assert.equal(
        updated.content,
        `Deleted **Copy of Lantern Night** (${dupIds.id}).`,
      );
      assert.equal(env.dbmod.getEventById(dupIds.id), null, "row cascaded");

      const gone = await env.mock
        .message(dupIds.announcement)
        .then(() => false)
        .catch((err) => err.status === 404);
      assert.ok(gone, "announcement message deleted from the channel");
    });

    it("event picker autocomplete + unknown/greenfield component copies", async () => {
      const inter = await env.mock.autocomplete({
        command: "event",
        options: [
          sub("delete", [
            { name: "event", type: 4, value: 0, focused: true },
          ]),
        ],
      });
      const state = await poll(
        async () => {
          const st = await env.mock.interactionState(inter.id);
          return st.response_json?.type === 8 ? st : null;
        },
        { timeoutMs: 8000, label: "event autocomplete choices" },
      );
      const choices = state.response_json?.data?.choices ?? [];
      assert.ok(
        choices.some(
          (c) => c.value === ev1.id && c.name === `${ev1.id} · Lantern Night`,
        ),
        `live event surfaced (${JSON.stringify(choices)})`,
      );

      // Component clicks always ATTACH to a message (mock enforces the
      // real-Discord invariant) — the custom_ids below decide the handler.
      const unknown = await env.mock.click({
        customId: "ev:nope:1",
        messageId: ev1.announcement,
        userId: env.ids.human,
      });
      assert.equal(
        String((await env.mock.awaitReply(unknown)).content),
        "Unknown event button.",
      );

      const gone = await env.mock.click({
        customId: "ev:rs:999999:1",
        messageId: ev1.announcement,
        userId: env.ids.human,
      });
      assert.equal(
        String((await env.mock.awaitReply(gone)).content),
        "That event no longer exists.",
      );

      // 📅 My calendar with no Google link names the fix (AGENTS error rule).
      const gcal = await env.mock.click({
        customId: `ev:gc:${ev1.id}`,
        messageId: ev1.announcement,
        userId: env.ids.outsider,
      });
      assert.equal(
        String((await env.mock.awaitReply(gcal)).content),
        "Google Calendar: No connected Google Calendar (use /eventconfig google connect).",
      );
    });

    it("/event wizard seeds the DM walkthrough and confirms it in-channel", async () => {
      const inter = await env.mock.slash({
        command: "event",
        options: [sub("wizard")],
      });
      const content = String((await env.mock.awaitReply(inter)).content);
      // The mock supports the DM handshake (channel-create + first ask
      // land); the in-channel copy + seeded title-step row are observable.
      // (The DM-side ev:w: walkthrough itself is DM-channel-unenumerable
      // on the mock, so it is not asserted here.)
      assert.equal(
        content,
        "Check your DMs — I'll walk you through it, one question at a time.",
      );
      const row = env.dbmod.db
        .prepare(
          "SELECT * FROM event_wizards WHERE community_id = ? AND user_id = ?",
        )
        .get(env.communityId, env.ids.human);
      assert.ok(row, "wizard walkthrough row seeded");
      assert.equal(row.step, "title");
      assert.equal(row.event_id, null, "fresh create walkthrough (not a resume)");
    });
  },
);
