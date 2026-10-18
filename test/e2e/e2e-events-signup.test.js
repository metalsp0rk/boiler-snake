const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { j, poll } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — importing anything that pulls in the db
// before createE2eEnv() sets the env vars silently binds the dev database.
// Lazily require src modules INSIDE tests instead (see the cross-post test).

/**
 * Tier-4 community-events coverage (issue #318, part 2/3). Namespace 12:
 * the SIGNUP / RSVP engine — ev:rs toggles (signed-up / waitlisted #N /
 * removed copies), multiple-off REPLACE semantics, capacity + FIFO waitlist
 * promotion (row flip, updated_by stamp, activity row, in-channel ✋ notice),
 * the LIVE announce-embed re-render (option columns with counts/waitlist/
 * attendee names), the attendee-role lifecycle (event-<slug> temp role
 * created at post, granted on reminders-on signups, revoked on withdrawal),
 * cutoff gating (closed copy vs organizer bypass), event-/option-level role
 * whitelists, the organizer `response add|remove|move` arms (gate copy,
 * force-add, promoted-suffix removes, not-on-option copies), the options
 * CLI (list table, add, the 10-option cap, remove), preset save/use, and
 * the cross-post destination signup path (whitelist gate, counts-on-the-
 * original replies, revoked pair).
 *
 * Several CURRENT-BUG pins are marked with the follow-up issue numbers —
 * flip them when the bugs are fixed. CRUD/lifecycle is ns 11; reminders and
 * /eventconfig are ns 13.
 */
describe(
  "e2e: event signups — RSVP toggles, capacity waitlist, organizer ops",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    let staffRole;
    let staffRole2;

    before(async () => {
      env = await createE2eEnv({ ns: 12 });
      staffRole = (await env.mock.createRole("E2E Signup Staff")).id;
      await env.mock.grantRole(env.ids.human, staffRole);
      env.dbmod.addStaffRole(env.communityId, String(staffRole), "junior");
      staffRole2 = (await env.mock.createRole("E2E Signup Staff 2")).id;
      await env.mock.grantRole(env.ids.target, staffRole2);
      env.dbmod.addStaffRole(env.communityId, String(staffRole2), "junior");
    });

    after(async () => {
      await env?.cleanup();
    });

    const sub = (name, options = []) => ({
      name,
      type: 1,
      ...(options.length && { options }),
    });
    const grp = (name, subName, options = []) => ({
      name,
      type: 2,
      options: [sub(subName, options)],
    });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const boolOpt = (name, value) => ({ name, type: 5, value });
    const userOpt = (name, id) => ({ name, type: 6, value: id });
    const roleOpt = (name, id) => ({ name, type: 8, value: id });

    const eventSlash = (options, userId) =>
      env.mock.slash({
        command: "event",
        options: [sub(...options)],
        ...(userId && { userId }),
      });
    const signupSlash = (group, subName, options, userId) =>
      env.mock.slash({
        command: "eventsignup",
        options: [grp(group, subName, options)],
        ...(userId && { userId }),
      });

    /** Create + post an event; threadless so notices land in #general. */
    const createPosted = async (title, extraOpts = []) => {
      const inter = await env.mock.slash({
        command: "event",
        options: [
          sub("create", [
            strOpt("title", title),
            strOpt("start", "in 2h"),
            boolOpt("thread", false),
            ...extraOpts,
          ]),
        ],
      });
      const preview = await env.mock.awaitReply(inter);
      const rows = env.dbmod.listUpcomingEvents(env.communityId, { limit: 50 });
      const draft = rows.find((r) => r.title === title);
      const click = await env.mock.click({
        customId: `ev:ok:${draft.id}`,
        messageId: preview.id,
      });
      const postReply = await env.mock.awaitSettledReply(click);
      assert.match(String(postReply.content), /^Posted ✅/, `post ${title}`);
      const row = await poll(async () => {
        const r = env.dbmod.getEventById(draft.id);
        return r && r.status === "posted" && r.message_id ? r : null;
      });
      const options = env.dbmod.listEventOptions(row.id);
      return {
        row,
        options,
        optionIds: Object.fromEntries(options.map((o) => [o.label, o.id])),
        announcement: String(row.message_id),
      };
    };

    /** Click an ev:rs button; returns the settled ephemeral copy. */
    const rsClick = async (event, optionId, userId, messageId) => {
      const click = await env.mock.click({
        customId: `ev:rs:${event.row.id}:${optionId}`,
        messageId: messageId ?? event.announcement,
        ...(userId && { userId }),
      });
      return String((await env.mock.awaitSettledReply(click)).content);
    };

    const signupRows = (eventId) => env.dbmod.listEventSignups(eventId);
    const rowFor = (eventId, userId, optionId) =>
      signupRows(eventId).find(
        (r) =>
          String(r.user_id) === String(userId) &&
          (optionId == null || Number(r.option_id) === Number(optionId)),
      ) ?? null;
    const activityRow = (eventId, action) =>
      env.dbmod.db
        .prepare(
          "SELECT * FROM event_activity WHERE event_id = ? AND action = ? ORDER BY id DESC LIMIT 1",
        )
        .get(eventId, action);
    const memberRoles = async (userId) => {
      const m = await j(
        `${env.mock.base}/api/guilds/${env.ids.guild}/members/${userId}`,
        { headers: env.mock.auth },
      );
      return (m.roles ?? []).map(String);
    };

    /** Shared: the capacity event (tests 1–3). */
    const dinner = { ev: null };

    it("signup_options spec drives capacities; malformed specs refuse", async () => {
      const bad = await env.mock.slash({
        command: "event",
        options: [
          sub("create", [
            strOpt("title", "Broken Spec"),
            strOpt("start", "in 2h"),
            strOpt("signup_options", "Dinner|x"),
          ]),
        ],
      });
      assert.match(
        String((await env.mock.awaitReply(bad)).content),
        /must be a whole number ≥ 0/,
      );

      dinner.ev = await createPosted("Guild Dinner", [
        strOpt("signup_options", "Dinner|1,Guildwide"),
      ]);
      const [first, second] = dinner.ev.options;
      assert.equal(first.label, "Dinner");
      assert.equal(Number(first.capacity), 1);
      assert.equal(Number(first.waitlist_on), 1);
      assert.equal(
        Number(first.reminders_on),
        1,
        "FIRST option gets the reminders/attendance bit (E6)",
      );
      assert.equal(second.label, "Guildwide");
      assert.equal(Number(second.capacity), 0, "0 = unlimited");
      assert.equal(Number(second.reminders_on), 0);
    });

    it("ev:rs toggles: sign-up, waitlist #N, replace on multiple-off, FIFO promotion + notice", async () => {
      const dinnerId = dinner.optionId = dinner.ev.optionIds.Dinner;

      assert.equal(
        await rsClick(dinner.ev, dinnerId),
        "You're signed up for **Dinner** (Guild Dinner).",
      );
      assert.equal(rowFor(dinner.ev.row.id, env.ids.human, dinnerId).state, "signed_up");
      assert.ok(activityRow(dinner.ev.row.id, "signup"), "signup activity");

      // Full → waitlist positions in click order.
      assert.equal(
        await rsClick(dinner.ev, dinnerId, env.ids.target),
        "You're on the waitlist for **Dinner** (Guild Dinner). You are **waitlist #1**.",
      );
      assert.equal(
        await rsClick(dinner.ev, dinnerId, env.ids.outsider),
        "You're on the waitlist for **Dinner** (Guild Dinner). You are **waitlist #2**.",
      );
      const counts = env.dbmod.countEventSignups(dinner.ev.row.id);
      assert.deepEqual(counts[dinnerId] ?? counts[String(dinnerId)], {
        signedUp: 1,
        waitlisted: 2,
      });

      // multiple OFF = REPLACE (no refusal copy): outsider swaps seats.
      assert.equal(
        await rsClick(dinner.ev, dinner.ev.optionIds.Guildwide, env.ids.outsider),
        "You're signed up for **Guildwide** (Guild Dinner).",
      );
      assert.equal(
        rowFor(dinner.ev.row.id, env.ids.outsider, dinner.optionId),
        null,
        "the Dinner waitlist row is gone (replaced by Guildwide)",
      );

      // Withdrawal frees the slot → FIFO promotion of #1 (target).
      assert.equal(
        await rsClick(dinner.ev, dinnerId),
        "You're off **Dinner** for **Guild Dinner**.",
      );
      const promoted = rowFor(dinner.ev.row.id, env.ids.target, dinnerId);
      assert.equal(promoted.state, "signed_up");
      assert.equal(promoted.updated_by, "waitlist-promotion");
      assert.ok(activityRow(dinner.ev.row.id, "promoted"), "promotion activity");

      // The ✋ notice lands in the event channel (threadless event).
      const msgs = await env.mock.messages(env.ids.general);
      assert.ok(
        msgs.some((m) =>
          String(m.content).startsWith(
            `✋ **Guild Dinner** — a spot opened up: <@${env.ids.target}> you're **signed up for Dinner** (no action needed).`,
          ),
        ),
        "promotion notice posted in #general",
      );

      // The withdrawn organizer re-signs — but the slot is gone: waitlist #1.
      assert.equal(
        await rsClick(dinner.ev, dinnerId),
        "You're on the waitlist for **Dinner** (Guild Dinner). You are **waitlist #1**.",
      );
    });

    it("the LIVE announcement re-renders option columns (counts, waitlist, attendee names)", async () => {
      const msg = await env.mock.message(dinner.ev.announcement);
      const json = JSON.stringify(msg.embeds[0].fields);
      // Dinner: 1 signed (target) of cap 1, one waiter (human).
      assert.match(json, /1\/1/, "signedUp/capacity column");
      assert.match(json, /waitlist 1/, "live waitlist count");
      // Attendee names render from the member cache (show_attendees default).
      assert.match(json, /E2ETarget/, "attendee display name in the column");
      // The button rows were re-persisted intact (type-2 secondary options).
      const buttons = await env.mock.buttons(dinner.ev.announcement);
      assert.ok(
        buttons.some((b) => String(b.custom_id) === `ev:rs:${dinner.ev.row.id}:${dinner.optionId}`),
      );
    });

    it("attendee role: event-<slug> created at post, granted on signup, revoked on withdrawal", async () => {
      const quiz = await createPosted("Quiz Night", [
        strOpt("signup_options", "Play"),
      ]);
      const role = await poll(async () => {
        const r = env.dbmod.getEventById(quiz.row.id);
        return r?.attendee_role_id ? String(r.attendee_role_id) : null;
      });
      // temp mode names it event-<slug>, NOT "Event: <title>".
      const roles = await j(`${env.mock.base}/api/guilds/${env.ids.guild}/roles`, {
        headers: env.mock.auth,
      });
      assert.ok(
        roles.some((r) => String(r.id) === role && r.name === "event-quiz-night"),
        `temp attendee role event-quiz-night exists (${roles.map((r) => r.name)})`,
      );

      const playId = quiz.optionIds.Play;
      assert.match(
        await rsClick(quiz, playId, env.ids.outsider),
        /You're signed up for \*\*Play\*\*/,
      );
      assert.ok(
        (await memberRoles(env.ids.outsider)).includes(role),
        "role granted on a reminders-on signup",
      );

      assert.match(
        await rsClick(quiz, playId, env.ids.outsider),
        /You're off \*\*Play\*\*/,
      );
      assert.ok(
        !(await memberRoles(env.ids.outsider)).includes(role),
        "role revoked on withdrawal",
      );
    });

    it("cutoff: closed copy names the time; the organizer still bypasses", async () => {
      // cutoff 3h before a 2h-out event → window already shut at post.
      const late = await createPosted("Late Window", [
        strOpt("signup_options", "Yes"),
        strOpt("cutoff", "3h before"),
      ]);
      const yes = late.optionIds.Yes;

      assert.match(
        await rsClick(late, yes, env.ids.outsider),
        /Signups for this event closed <t:\d+:F>/,
      );
      assert.match(
        await rsClick(late, yes),
        /You're signed up for \*\*Yes\*\*/,
        "organizer bypasses the cutoff",
      );
    });

    it("role whitelists (event + option level) gate non-holders with named-role copies", async () => {
      const ev = await createPosted("Members Only", [
        strOpt("signup_options", "Door"),
      ]);
      // Staff/organizers BYPASS whitelists — every gate click below is the
      // plain OUTSIDER. Seeded via the facade; the whitelist COMMAND's own
      // persistence is pinned fixed under #344 below.
      env.dbmod.updateEvent(ev.row.id, { role_whitelist: [staffRole2] });

      assert.equal(
        await rsClick(ev, ev.optionIds.Door, env.ids.outsider),
        `This event is restricted to: <@&${staffRole2}>.`,
      );
      // The role holder passes: target holds staffRole2, signs up, then
      // un-signs so later clicks RE-ATTEMPT (toggle semantics).
      assert.match(
        await rsClick(ev, ev.optionIds.Door, env.ids.target),
        /You're signed up for \*\*Door\*\*/,
        "role holder passes the event whitelist",
      );
      assert.match(
        await rsClick(ev, ev.optionIds.Door, env.ids.target),
        /You're off/,
      );

      // Option-level gate uses the bolded-label copy. Clear the event-level
      // list first so the outsider reaches the option check.
      env.dbmod.updateEvent(ev.row.id, { role_whitelist: [] });
      env.dbmod.updateEventOption(ev.optionIds.Door, { role_whitelist: [staffRole] });
      assert.equal(
        await rsClick(ev, ev.optionIds.Door, env.ids.outsider),
        `**Door** is restricted to: <@&${staffRole}>.`,
      );
      env.dbmod.updateEventOption(ev.optionIds.Door, { role_whitelist: [] });
      assert.match(
        await rsClick(ev, ev.optionIds.Door, env.ids.outsider),
        /signed up/,
        "clearing the option gate re-opens it",
      );
    });

    it("organizer response add/remove/move: gates, force-add, promoted suffix, not-on-option copies", async () => {
      const ev = await createPosted("Response Night", [
        strOpt("signup_options", "Solo|1,Mates"),
      ]);
      const solo = ev.optionIds.Solo;
      const mates = ev.optionIds.Mates;

      // Gate: outsider may not mutate rosters.
      assert.equal(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash(
                "response",
                "add",
                [intOpt("event", ev.row.id), userOpt("member", env.ids.target), intOpt("option", solo)],
                env.ids.outsider,
              ),
            )
          ).content,
        ),
        "Only the **organizer**, **staff**, or holders of the required role may options this event.",
      );

      // Organizer add (the engine's force arm — capacity is not consulted).
      assert.equal(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash("response", "add", [
                intOpt("event", ev.row.id),
                userOpt("member", env.ids.target),
                intOpt("option", solo),
              ]),
            )
          ).content,
        ),
        `Added <@${env.ids.target}> to **Solo**.`,
      );

      // Unknown option ref names the lookup surface.
      assert.match(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash("response", "add", [
                intOpt("event", ev.row.id),
                userOpt("member", env.ids.target),
                intOpt("option", 999999),
              ]),
            )
          ).content,
        ),
        new RegExp(
          "No option `999999` on that event \\(see `/eventsignup options list event:" +
            ev.row.id +
            "`\\)",
        ),
      );

      // not-on-the-option copies (remove + move).
      assert.equal(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash("response", "remove", [
                intOpt("event", ev.row.id),
                userOpt("member", env.ids.outsider),
                intOpt("option", solo),
              ]),
            )
          ).content,
        ),
        "That member is not on that option.",
      );
      assert.equal(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash("response", "move", [
                intOpt("event", ev.row.id),
                userOpt("member", env.ids.outsider),
                intOpt("from_option", solo),
                intOpt("to_option", mates),
              ]),
            )
          ).content,
        ),
        `<@${env.ids.outsider}> is not on **Solo**.`,
      );

      // Waitlist + organizer remove → Promoted: <@…> suffix.
      assert.match(
        await rsClick(ev, ev.optionIds.Mates, env.ids.outsider),
        /signed up/,
      );
      assert.match(
        await rsClick(ev, solo, env.ids.outsider),
        /You're on the waitlist for \*\*Solo\*\*/,
      );
      assert.equal(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash("response", "remove", [
                intOpt("event", ev.row.id),
                userOpt("member", env.ids.target),
                intOpt("option", solo),
              ]),
            )
          ).content,
        ),
        `Removed <@${env.ids.target}> from **Solo**. Promoted: <@${env.ids.outsider}>.`,
      );
      assert.equal(
        rowFor(ev.row.id, env.ids.outsider, solo).state,
        "signed_up",
        "waiter promoted by the organizer removal",
      );
    });

    it("move into a FULL option refuses; the mover's own target row is the only exclusion (#345)", async () => {
      const ev = await createPosted("Capacity Move Night", [
        strOpt("signup_options", "A|1,B|1,C,D|1"),
      ]);
      const move = async (member, from, to) =>
        env.mock.awaitReply(
          await signupSlash("response", "move", [
            intOpt("event", ev.row.id),
            userOpt("member", member),
            intOpt("from_option", from),
            intOpt("to_option", to),
          ]),
        );
      const addTo = async (member, optionId) =>
        env.mock.awaitReply(
          await signupSlash("response", "add", [
            intOpt("event", ev.row.id),
            userOpt("member", member),
            intOpt("option", optionId),
          ]),
        );
      const signedUp = (optionId) => {
        const counts = env.dbmod.countEventSignups(ev.row.id);
        return (counts[optionId] ?? counts[String(optionId)] ?? { signedUp: 0 }).signedUp;
      };

      // Seed: target fills A (cap 1), outsider fills B.
      assert.match(String((await addTo(env.ids.target, ev.optionIds.A)).content), /^Added <@\d+>/);
      assert.match(String((await addTo(env.ids.outsider, ev.optionIds.B)).content), /^Added <@\d+>/);

      // #345 FIXED: A is at cap 1 with a MOVER WHO DOES NOT HOLD it — the
      // guard's dead third condition (`userId !== held.user_id`, always
      // false) used to skip the refusal and force-add straight to 2/1.
      const refused = await move(env.ids.outsider, ev.optionIds.B, ev.optionIds.A);
      assert.equal(String(refused.content), `**A** is full (capacity 1).`);
      assert.equal(signedUp(ev.optionIds.A), 1, "the full option stays at capacity — refusal first, writes never started");
      assert.equal(signedUp(ev.optionIds.B), 1, "the mover kept the row it was moving FROM");

      // A non-full destination still moves normally.
      const moved = await move(env.ids.outsider, ev.optionIds.B, ev.optionIds.C);
      assert.equal(String(moved.content), `Moved <@${env.ids.outsider}>: **B** → **C**.`);
      assert.equal(signedUp(ev.optionIds.B), 0);
      assert.equal(signedUp(ev.optionIds.C), 1);

      // The exclusion that DOES exist: D (cap 1) holds ONLY the mover —
      // moving target A→D lands on a "full" option whose only occupant is
      // the mover THEMSELVES: adds nobody, so it passes (the dead guard's
      // intended exclusion, moved to the TARGET side where it belongs).
      assert.match(String((await addTo(env.ids.target, ev.optionIds.D)).content), /^Added <@\d+>/);
      assert.equal(signedUp(ev.optionIds.D), 1, "D is at cap — held by target alone");
      const betweenHeld = await move(env.ids.target, ev.optionIds.A, ev.optionIds.D);
      assert.equal(String(betweenHeld.content), `Moved <@${env.ids.target}>: **A** → **D**.`);
      assert.equal(signedUp(ev.optionIds.D), 1, "D never exceeded capacity — the held row was REUSED, not doubled");
      assert.equal(signedUp(ev.optionIds.A), 0);

      // Same-option moves are refused up front (the old code deleted the
      // held row — promoting a waiter — then re-added it a beat later).
      const selfMove = await move(env.ids.outsider, ev.optionIds.C, ev.optionIds.C);
      assert.match(String(selfMove.content), /different destination/i);
      assert.equal(signedUp(ev.optionIds.C), 1, "refusal changed nothing");
    });

    it("options CLI: list table, add + cap refusal, edit-missing copy, remove CASCADES signups (#346 pin)", async () => {
      const ev = dinner.ev;
      const list = await env.mock.awaitReply(
        await signupSlash("options", "list", [intOpt("event", ev.row.id)]),
      );
      const content = String(list.content);
      assert.match(content, /\*\*Options for Guild Dinner:\*\*/);
      assert.match(
        content,
        new RegExp(
          "\\*\\*0\\. Dinner\\*\\* — 1/1 \\(waitlist 1\\) · id `" +
            dinner.optionId +
            "`, pos 0, cap 1(?!, role-gated)",
        ),
        "table row (0-based positions); #344 FIXED: an EMPTY whitelist no longer renders 'role-gated' (parsed [] is length-checked, not truthy)",
      );

      const add = await env.mock.awaitReply(
        await signupSlash("options", "add", [
          intOpt("event", ev.row.id),
          strOpt("label", "Karaoke"),
        ]),
      );
      assert.match(
        String(add.content),
        /Option \*\*Karaoke\*\* added \(`\d+`\)/,
      );

      // Fill to 10 then refuse the 11th.
      const now = env.dbmod.listEventOptions(ev.row.id).length;
      for (let i = now; i < 10; i++) {
        const r = await env.mock.awaitReply(
          await signupSlash("options", "add", [
            intOpt("event", ev.row.id),
            strOpt("label", `Filler ${i + 1}`),
          ]),
        );
        assert.match(String(r.content), /added \(/, `filler ${i + 1}`);
      }
      assert.equal(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash("options", "add", [
                intOpt("event", ev.row.id),
                strOpt("label", "Impossible"),
              ]),
            )
          ).content,
        ),
        "At most 10 options per event.",
      );

      assert.equal(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash("options", "edit", [
                intOpt("event", ev.row.id),
                intOpt("option", 999999),
                strOpt("label", "x"),
              ]),
            )
          ).content,
        ),
        "That option isn't on this event (see `/eventsignup options list`).",
      );

      // BUG PIN (#346): the "has signups" guard checks counts.signed_up
      // (the repo returns signedUp) → never fires; removing a SIGNED-OPT-IN
      // option silently cascades its signup rows. Flip when fixed.
      await rsClick(ev, ev.optionIds.Guildwide, env.ids.target);
      assert.ok(rowFor(ev.row.id, env.ids.target, ev.optionIds.Guildwide));
      assert.match(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash("options", "remove", [
                intOpt("event", ev.row.id),
                intOpt("option", ev.optionIds.Guildwide),
              ]),
            )
          ).content,
        ),
        /Option \*\*Guildwide\*\* removed ✅/,
      );
      assert.equal(
        rowFor(ev.row.id, env.ids.target),
        null,
        "signups destroyed with the option (current behavior)",
      );
    });

    it("whitelist COMMAND persists the role — the gate is live and clear:yes closes the loop (#344)", async () => {
      const ev = await createPosted("Whitelist Command Night", [
        strOpt("signup_options", "Seat"),
      ]);
      const ok = await env.mock.awaitReply(
        await signupSlash("options", "whitelist", [
          intOpt("event", ev.row.id),
          roleOpt("role", staffRole2),
        ]),
      );
      assert.match(
        String(ok.content),
        // NOTE: the stored reply renders the role mention in the legacy
        // <&id> form (the send-path mention transform), unlike the
        // <@&id> the button-path gate copies persist.
        new RegExp(`\\*\\*Whitelist Command Night\\*\\* is now limited to <&${staffRole2}> and staff\\.`),
      );
      // #344 FIXED: the handler hands updateEvent a real ARRAY (toJsonArray
      // stringifies arrays; it flattened the pre-stringified value to "[]").
      assert.deepEqual(
        JSON.parse(env.dbmod.getEventById(ev.row.id).role_whitelist),
        [staffRole2],
        "the row stores the role the reply promised",
      );
      // The gate is now actually IN FORCE for a non-holder:
      assert.equal(
        await rsClick(ev, ev.optionIds.Seat, env.ids.outsider),
        `This event is restricted to: <@&${staffRole2}>.`,
        "the promise and the state finally agree",
      );
      // clear: yes clears for real (the string "[]" it used to send flattened
      // to "[]" by accident — same bytes, different honesty).
      const cleared = await env.mock.awaitReply(
        await signupSlash("options", "whitelist", [
          intOpt("event", ev.row.id),
          boolOpt("clear", true),
        ]),
      );
      assert.match(String(cleared.content), /whitelist cleared/i);
      assert.deepEqual(JSON.parse(env.dbmod.getEventById(ev.row.id).role_whitelist), []);
      assert.match(
        await rsClick(ev, ev.optionIds.Seat, env.ids.outsider),
        /signed up/,
        "after clear the outsider passes again",
      );
    });

    it("presets are staff-gated, save from an event, and drive /event create", async () => {
      assert.equal(
        String(
          (
            await env.mock.awaitReply(
              await signupSlash("preset", "list", [], env.ids.outsider),
            )
          ).content,
        ),
        "This needs Manage Server or a staff role (`/staff`).",
      );

      const solo = await createPosted("Preset Source", [
        strOpt("signup_options", "Show Up"),
      ]);
      const save = await env.mock.awaitReply(
        await signupSlash("preset", "save", [
          strOpt("name", "duo"),
          intOpt("event", solo.row.id),
        ]),
      );
      assert.equal(String(save.content), "Preset **duo** saved ✅ (1 options).");

      const list = await env.mock.awaitReply(
        await signupSlash("preset", "list", []),
      );
      assert.match(String(list.content), /• \*\*duo\*\* — Show Up/);

      const preview = await env.mock.awaitReply(
        await eventSlash([
          "create",
          [strOpt("title", "Preset Built"), strOpt("start", "in 6h"), strOpt("preset", "duo")],
        ]),
      );
      assert.match(String(preview.content), /Almost there/);
      const built = env.dbmod
        .listUpcomingEvents(env.communityId, { limit: 50 })
        .find((r) => r.title === "Preset Built");
      assert.deepEqual(
        env.dbmod.listEventOptions(built.id).map((o) => o.label),
        ["Show Up"],
        "preset drove the option set",
      );

      const ghost = await env.mock.slash({
        command: "event",
        options: [
          sub("create", [
            strOpt("title", "Ghost Preset"),
            strOpt("start", "in 6h"),
            strOpt("preset", "ghost"),
          ]),
        ],
      });
      assert.equal(
        String((await env.mock.awaitReply(ghost)).content),
        "No preset **ghost** — see `/eventsignup preset list`.",
      );

      const del = await env.mock.awaitReply(
        await signupSlash("preset", "delete", [strOpt("name", "duo")]),
      );
      assert.equal(String(del.content), "Preset **duo** deleted.");
    });

    it("cross-post DESTINATION signups: whitelist gate, counts-on-original replies, revoked pairs die", async () => {
      // LAZY (after boot): see the DB_PATH-at-require-time note up top.
      const { ensureCommunity } = require("../../src/platform/community");
      // Seed a foreign-community posted event + an approved pair (the
      // invite/approve slash flow needs two live guilds; the repos model it).
      const src = ensureCommunity({
        platform: "discord",
        instanceKey: "discord",
        externalGuildId: "999900001111222200",
      });
      const remote = env.dbmod.createEvent({
        communityId: src,
        creatorId: env.ids.human,
        title: "Remote Gala",
        status: "posted",
        startAt: Date.now() + 7200000,
        options: [{ label: "Feast", reminders_on: true }],
      }).event;
      const remoteOpt = env.dbmod.listEventOptions(remote.id)[0];
      const pair = env.dbmod
        .inviteEventCrosspost({
          sourceCommunityId: src,
          destCommunityId: env.communityId,
          createdBy: env.ids.human,
          roleWhitelist: [staffRole],
        })
        .crosspost;
      env.dbmod.approveEventCrosspost(pair.id, { approvedBy: env.ids.human });

      const clickRemote = async (userId) =>
        String(
          (
            await env.mock.awaitSettledReply(
              await env.mock.click({
                customId: `ev:rs:${remote.id}:${remoteOpt.id}`,
                messageId: dinner.ev.announcement,
                ...(userId && { userId }),
              }),
            )
          ).content,
        );

      // Destination whitelist (pair-level) rejects the un-roled member.
      assert.equal(
        await clickRemote(env.ids.outsider),
        `You need one of these roles to sign up in this server: <@&${staffRole}>.`,
      );

      // Human holds staffRole → write-through to the SOURCE event.
      assert.equal(
        await clickRemote(),
        "You're signed up for **Feast** on **Remote Gala** (cross-posted here — counts on the original).",
      );
      const remoteRow = rowFor(remote.id, env.ids.human, remoteOpt.id);
      assert.equal(remoteRow.state, "signed_up");
      const detail = env.dbmod.db
        .prepare(
          "SELECT * FROM event_activity WHERE event_id = ? AND action = 'signed_up' ORDER BY id DESC LIMIT 1",
        )
        .get(remote.id);
      assert.match(detail.detail, /Feast \(cross-post\)/);

      // Toggle OFF from the copy.
      assert.equal(
        await clickRemote(),
        "You're off **Feast** (original event: **Remote Gala**).",
      );

      env.dbmod.revokeEventCrosspost(pair.id);
      assert.equal(
        await clickRemote(),
        "This cross-post is no longer active.",
      );
    });

    it("RSVP on an unposted (pending) event refuses; ghost clicks never sign anyone up", async () => {
      const inter = await env.mock.slash({
        command: "event",
        options: [
          sub("create", [strOpt("title", "Unposted"), strOpt("start", "in 2h")]),
        ],
      });
      const preview = await env.mock.awaitReply(inter);
      const draft = env.dbmod
        .listUpcomingEvents(env.communityId, { limit: 50 })
        .find((r) => r.title === "Unposted");

      // No announce message exists yet — attach the preview reply instead.
      assert.equal(
        String(
          (
            await env.mock.awaitSettledReply(
              await env.mock.click({
                customId: `ev:rs:${draft.id}:${env.dbmod.listEventOptions(draft.id)[0].id}`,
                messageId: preview.id,
                userId: env.ids.target,
              }),
            )
          ).content,
        ),
        "This event is not posted yet.",
      );
    });
  },
);
