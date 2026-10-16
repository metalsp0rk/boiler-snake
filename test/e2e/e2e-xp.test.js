const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll, j } = require("./helpers/mockenv");

const MSG_DENIED = "You don't have permission to use this.";

/**
 * Tier-4 XP & leaderboard coverage (issue #314). Namespace 5.
 *
 * Already covered elsewhere (not repeated here):
 *  - ns1 e2e-core: /xp self + USER option, /leaderboard empty state,
 *    MESSAGE_CREATE award + cooldown SUPPRESSION
 *  - ns3 e2e-gates: /grantxp denial (junior staff) + ManageGuild
 *    grant→revoke arc
 *  - ns23 e2e-mockgaps: reaction XP award + user cooldown via injected
 *    REACTION_ADD
 * This file: the /setxp settings surface, slash-origin audit rows,
 * non-member /xp rendering, and the cooldown-EXPIRY re-award (window
 * shortened through /setxp itself, so the slow test stays fast).
 */
describe("e2e: XP settings, audit & leaderboard", { concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
  let env;

  const xpOf = (userId) =>
    env.dbmod.db
      .prepare("SELECT xp FROM users WHERE community_id = ? AND user_id = ?")
      .get(env.communityId, userId)?.xp ?? 0;

  before(async () => {
    env = await createE2eEnv({ ns: 5 });
    // human carries both tiers: staff_roles row (/setxp) and a role with
    // the ManageGuild bit (/grantxp) — aggregation per #311.
    const staffRole = await env.mock.createRole("E2E XP Staff");
    await env.mock.grantRole(env.ids.human, staffRole.id);
    env.dbmod.addStaffRole(env.communityId, String(staffRole.id), "junior");
    const adminRole = await env.mock.createRole("E2E XP Admin", {
      permissions: String(PermissionFlagsBits.ManageGuild),
    });
    await env.mock.grantRole(env.ids.human, adminRole.id);
  });

  after(async () => {
    await env?.cleanup();
  });

  it("/leaderboard clamps out-of-bounds limit/page into the empty state", async () => {
    const inter = await env.mock.slash({
      command: "leaderboard",
      options: [
        { name: "limit", type: 4, value: 999 },
        { name: "page", type: 4, value: 5 },
      ],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /no leaderboard data/i);
  });

  it.todo("Voice XP rules (AFK ignore, ≥2 eligible humans, muted/deafened) — blocked on #328 gap 6 (mock voice-state support)");

  // ── #312 DELIVERED — the old "blocked on #312 (mock multipart interaction
  // callbacks)" todo became these three arms. fauxcord now parses
  // payload_json + files[N] on interaction callbacks and webhook PATCHes,
  // persists uploads under UPLOAD_PATH, and hydrates /_mock/attachments URLs
  // (leaderboard PNG pagination is the marquee product flow; the route-level
  // multipart arms live in e2e-multipart.test.js, ns 24).
  const lb = {};
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  const originalOf = (token) =>
    j(`${env.mock.base}/webhooks/${env.ids.app}/${token}/messages/@original`).catch(
      () => null,
    );

  const pollOriginal = (token, needle, label) =>
    poll(
      async () => {
        const m = await originalOf(token);
        return m && String(m.content ?? "").includes(needle) ? m : null;
      },
      { timeoutMs: 10_000, label },
    );

  const attachmentBytes = async (url) => {
    const res = await fetch(url);
    assert.ok(res.ok, `attachment GET ${url} → HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  it("/leaderboard limit:5 replies with the PNG page + lb: Prev/Next buttons (#312 multipart reply)", async () => {
    // 12 users, XP strictly descending → deterministic ranks 1..12.
    for (let i = 0; i < 12; i++) {
      env.dbmod.addXp(
        env.communityId,
        String(7700000000000000000n + BigInt(i)),
        (12 - i) * 100,
      );
    }

    const inter = await env.mock.slash({
      command: "leaderboard",
      options: [{ name: "limit", type: 4, value: 5 }],
    });
    const reply = await env.mock.awaitSettledReply(inter);

    assert.equal(String(reply.content), "**Leaderboard — ranks 1–5**");
    const atts = reply.attachments ?? [];
    assert.equal(atts.length, 1, "exactly one PNG attachment");
    const att = atts[0];
    assert.equal(att.filename, "boiler-snake-leaderboard.png");
    assert.equal(att.content_type, "image/png", "content-type sniffed from bytes");
    assert.ok(att.size > 0, "non-empty upload");
    assert.match(String(att.url), /\/_mock\/attachments\//, "mock serves the bytes");

    const bytes = await attachmentBytes(att.url);
    assert.deepEqual(bytes.subarray(0, 4), PNG_MAGIC, "PNG magic bytes round-trip");
    assert.equal(bytes.length, att.size, "served bytes match the stored size");

    const row = reply.components[0].components;
    assert.equal(row[0].custom_id, `lb:${env.ids.human}:5:0`);
    assert.equal(row[0].label, "◀ Prev");
    assert.equal(row[0].disabled, true, "Prev disabled on page 1");
    assert.equal(row[1].custom_id, `lb:${env.ids.human}:5:2`);
    assert.equal(row[1].label, "Next ▶");
    assert.equal(row[1].disabled, false, "Next enabled (12 ranked users)");

    lb.msgId = String(reply.id);
    lb.att1 = String(att.id);
  });

  it("Next button re-renders ranks 6–10 and REPLACES the PNG (deferUpdate + editReply multipart)", async () => {
    const click = await env.mock.click({
      customId: `lb:${env.ids.human}:5:2`,
      messageId: lb.msgId,
    });
    // The click's @original resolves to the HOST message (component-interaction
    // fallback): poll until the edit lands with page-2 content.
    const edited = await pollOriginal(click.token, "ranks 6–10", "leaderboard page-2 edit");

    const atts = edited.attachments ?? [];
    assert.equal(atts.length, 1, "edit REPLACED the attachment (exactly one)");
    const att = atts[0];
    assert.notEqual(String(att.id), lb.att1, "page-1 attachment row pruned, fresh row saved");
    assert.equal(att.filename, "boiler-snake-leaderboard.png");
    const bytes = await attachmentBytes(att.url);
    assert.deepEqual(bytes.subarray(0, 4), PNG_MAGIC, "page-2 PNG bytes served");
    assert.equal(bytes.length, att.size);

    const row = edited.components[0].components;
    assert.equal(row[0].custom_id, `lb:${env.ids.human}:5:1`);
    assert.equal(row[0].disabled, false, "Prev live on page 2");
    assert.equal(row[1].custom_id, `lb:${env.ids.human}:5:3`);
    assert.equal(row[1].disabled, false, "page 3 exists (ranks 11–12)");
    lb.att2 = String(att.id);
  });

  it("outsiders can't page; a deep page edit lands the empty copy and omission preserves the attachment", async () => {
    const denied = await env.mock.click({
      customId: `lb:${env.ids.human}:5:3`,
      messageId: lb.msgId,
      userId: env.ids.outsider,
    });
    // Content-match poll (not awaitReply): with the component-interaction
    // @original fallback, the host message answers 200 immediately — the
    // denial lands when initial_response_message_id starts winning.
    const denial = await pollOriginal(
      denied.token,
      "Only the person who ran /leaderboard can page it.",
      "pagination denial",
    );
    assert.equal(
      String(denial.content),
      "Only the person who ran /leaderboard can page it.",
    );

    // The denial is its own reply — the host message never moved to page 3.
    const host = (await env.mock.messages(env.ids.general)).find(
      (m) => String(m.id) === lb.msgId,
    );
    assert.match(String(host.content), /ranks 6–10/, "denial did not page the host");
    assert.equal(String(host.attachments[0].id), lb.att2, "host still carries the page-2 PNG");

    // Crafted deep page: page 4 of 12 users is the empty state (no real
    // button needed — the mock click accepts any customId on a live message).
    const deep = await env.mock.click({
      customId: `lb:${env.ids.human}:5:4`,
      messageId: lb.msgId,
    });
    const empty = await pollOriginal(
      deep.token,
      "No leaderboard data yet.",
      "leaderboard empty-page edit",
    );

    const row = empty.components[0].components;
    assert.equal(row[0].custom_id, `lb:${env.ids.human}:5:3`);
    assert.equal(row[0].disabled, false, "Prev offers a way back from the empty page");
    assert.equal(row[1].custom_id, `lb:${env.ids.human}:5:5`);
    assert.equal(row[1].disabled, true, "nothing beyond the empty page");
    // MOCK-SEMANTICS PIN: the empty-page editReply OMITS `attachments`, and
    // fauxcord (like the Discord docs' omitted = unchanged) preserves the
    // message's attachment in that case — the page-2 PNG row survives.
    assert.equal((empty.attachments ?? []).length, 1, "omission preserves attachments (mock)");
    assert.equal(String(empty.attachments[0].id), lb.att2, "still the page-2 upload");
  });

  it("/setxp persists each provided field and echoes the change (staff)", async () => {
    const inter = await env.mock.slash({
      command: "setxp",
      options: [
        { name: "message", type: 4, value: 25 },
        { name: "reaction", type: 4, value: 3 },
      ],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.match(
      String(reply.embeds?.[0]?.title),
      /Updated XP settings/i,
      "echo embed returned",
    );
    const settings = env.dbmod.getGuildSettings(env.communityId);
    assert.equal(settings.msg_xp, 25);
    assert.equal(settings.reaction_xp, 3);
  });

  it("/setxp validation: over-cap and negative values reply specifically and change nothing", async () => {
    const tooBig = await env.mock.slash({
      command: "setxp",
      options: [{ name: "message", type: 4, value: 2_000_000_000 }],
    });
    assert.match(
      String((await env.mock.awaitReply(tooBig)).content),
      /XP value too large\. Maximum value per message is 1,000,000,000\./,
    );

    const negative = await env.mock.slash({
      command: "setxp",
      options: [{ name: "reaction", type: 4, value: -5 }],
    });
    assert.match(
      String((await env.mock.awaitReply(negative)).content),
      /Reaction XP must be a finite non-negative number\./,
    );

    const settings = env.dbmod.getGuildSettings(env.communityId);
    assert.equal(settings.msg_xp, 25, "rejected update changed nothing");
    assert.equal(settings.reaction_xp, 3, "rejected update changed nothing");
  });

  it("/setxp with no fields replies with guidance instead of a silent no-op", async () => {
    const inter = await env.mock.slash({ command: "setxp" });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /No XP settings provided/i);
  });

  it("/setxp denies a non-staff member", async () => {
    const inter = await env.mock.slash({
      command: "setxp",
      userId: env.ids.outsider,
      options: [{ name: "message", type: 4, value: 1 }],
    });
    assert.equal(String((await env.mock.awaitReply(inter)).content), MSG_DENIED);
  });

  it("/grantxp with a reason writes a slash-origin audit row with before/after details", async () => {
    const inter = await env.mock.slash({
      command: "grantxp",
      options: [
        { name: "user", type: 6, value: env.ids.target },
        { name: "amount", type: 4, value: 500 },
        { name: "reason", type: 3, value: "e2e audit proof" },
      ],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /Granted \*\*500\*\* XP to \*\*E2ETarget\*\*/);
    assert.match(String(reply.content), /Reason: e2e audit proof/);
    assert.equal(xpOf(env.ids.target), 500, "DB total reflects the grant");

    const audit = env.dbmod.db
      .prepare(
        "SELECT * FROM admin_audit WHERE community_id = ? AND action = 'xp.grant' ORDER BY id DESC LIMIT 1",
      )
      .get(env.communityId);
    assert.ok(audit, "xp.grant audit row recorded");
    assert.equal(audit.origin, "slash", "slash-origin metadata on the audit row");
    assert.equal(audit.actor_user_id, env.ids.human);
    assert.equal(audit.target_id, env.ids.target);
    const details = JSON.parse(audit.details_json);
    assert.equal(details.amount, 500);
    assert.equal(details.before_xp, 0);
    assert.equal(details.after_xp, 500);
    assert.equal(details.reason, "e2e audit proof");
  });

  it("/xp renders a clean zero-state for a resolved user with no guild membership", async () => {
    // Ghost has a users row but never appeared in the guild (no member
    // row, no DB xp row) — resolution must not crash or leak an error.
    await env.mock.createUser("E2EGhost", env.ids.ghost);
    const inter = await env.mock.slash({
      command: "xp",
      options: [{ name: "user", type: 6, value: env.ids.ghost }],
    });
    const reply = await env.mock.awaitReply(inter);
    assert.match(String(reply.content), /\*\*E2EGhost\*\*: \*\*0 XP\*\* · Level \*\*0\*\*/);
  });

  it("message XP is awarded again once the cooldown window expires", async () => {
    // Shrink the window through the command surface itself (the same path
    // production uses), keeping this expiry proof fast.
    const set = await env.mock.slash({
      command: "setxp",
      options: [{ name: "msgcooldown", type: 4, value: 1 }],
    });
    await env.mock.awaitReply(set);

    await env.mock.inject("xp expiry msg 1", env.ids.human);
    await poll(() => (xpOf(env.ids.human) >= 25 ? xpOf(env.ids.human) : null), {
      label: "first message award (25 XP)",
    });
    assert.equal(xpOf(env.ids.human), 25);

    await env.mock.inject("xp expiry msg 2 (inside window)", env.ids.human);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(xpOf(env.ids.human), 25, "cooldown suppresses the second award");

    await new Promise((r) => setTimeout(r, 900));
    await env.mock.inject("xp expiry msg 3 (after window)", env.ids.human);
    await poll(() => (xpOf(env.ids.human) >= 50 ? xpOf(env.ids.human) : null), {
      label: "re-award after cooldown expiry",
    });
    assert.equal(xpOf(env.ids.human), 50, "one award per window, none lost");
  });
});
