const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Events } = require("discord.js");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertReplyContains,
  assertEphemeralReply,
} = require("../helpers/assert");
const { IDS } = require("../helpers/fixtures");
const {
  createMember,
  createUser,
  createTextChannel,
} = require("../helpers/discord");

describe("integration: tickets", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  /** @type {import("discord.js").Client | object} */
  let clientWithEvents;

  before(async () => {
    env = await createIntegrationEnv();
    process.env.DATA_DIR = env.tmpDir;
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "senior");
    env.db.updateGuildSettings(env.communityId, {
      ticket_archive_channel_id: IDS.channelLog,
      ticket_rate_limit_minutes: 60,
    });

    // Wire ticket ChannelDelete handler
    const ticketsFeature = require("../../src/features/tickets");
    ticketsFeature.registerEvents(env.supervisor, env.ctx);
    clientWithEvents = env.client;

    // Requester DMs (close + archive transcript link) resolve users through
    // client.users — give this env a mock collection so user.send is exercised.
    if (!env.client.users) {
      const userCache = new Map(
        [
          env.users.adminUser,
          env.users.memberUser,
          env.users.member2User,
          env.users.botUser,
        ].map((u) => [u.id, u])
      );
      env.client.users = {
        cache: userCache,
        fetch: async (id) => userCache.get(id) || null,
      };
    }
  });

  after(() => {
    // Close SQLite handles and remove the temp dir created for this env.
    env?.cleanup();
  });

  /**
   * Open a ticket via staff /for (bypasses rate limit).
   * @param {object} [opts]
   * @param {object} [opts.user]
   * @param {string} [opts.reason]
   */
  async function openViaStaff(opts = {}) {
    const user = opts.user || env.users.memberUser;
    const reason = opts.reason || `ticket-${Date.now()}`;
    const res = await env.runCommand({
      commandName: "ticket",
      subcommand: "for",
      admin: true,
      options: { user, reason },
    });
    const text = env.lastReplyContent(res);
    assert.match(text, /opened|Ticket/i);
    const open = env.db.listOpenTickets(env.communityId, {
      userId: user.id,
      limit: 10,
    });
    const ticket = open.find((t) => t.reason === reason) || open[0];
    assert.ok(ticket, "expected open ticket");
    return ticket;
  }

  it("/ticket settings is visible to members", async () => {
    const interaction = await env.runCommand({
      commandName: "ticket",
      subcommand: "settings",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction);
    assertReplyContains(interaction, /Ticket settings/i);
    assertReplyContains(interaction, /rate limit/i);
  });

  it("/ticket for denies non-staff", async () => {
    const interaction = await env.runCommand({
      commandName: "ticket",
      subcommand: "for",
      admin: false,
      user: env.users.memberUser,
      options: { user: env.users.member2User, reason: "hi" },
    });
    assertEphemeralReply(interaction, /permission/i);
  });

  it("/ticket create + claim + info + list + close (soft) + archive", async () => {
    // Ensure member can self-create (reset rate limit window for this user)
    env.db.updateGuildSettings(env.communityId, {
      ticket_rate_limit_minutes: 0,
    });

    const create = await env.runCommand({
      commandName: "ticket",
      subcommand: "create",
      admin: false,
      user: env.users.memberUser,
      options: { reason: "Cannot join voice" },
    });
    const createText = env.lastReplyContent(create);
    assert.match(createText, /Ticket\s*#?|#|opened/i);

    const open = env.db.listOpenTickets(env.communityId, {
      userId: IDS.member,
      limit: 5,
    });
    const row = open.find((t) => t.reason === "Cannot join voice");
    assert.ok(row);
    assert.equal(row.status, "open");
    assert.equal(row.creator_user_id, IDS.member);
    assert.ok(row.channel_id);

    const ticketChannel = env.guild.channels.cache.get(row.channel_id);
    assert.ok(ticketChannel);
    assert.match(ticketChannel.name, /ticket-/);

    ticketChannel.addMessage({
      id: "user-msg-1",
      content: "I cannot hear anyone",
      author: {
        id: IDS.member,
        username: "member",
        tag: "member#0000",
      },
      createdTimestamp: Date.now() - 5000,
    });

    const claim = await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: row.channel_id,
    });
    assertEphemeralReply(claim);
    assertReplyContains(claim, /claimed/i);
    assert.equal(env.db.getTicketById(row.id).staff_owner_id, IDS.admin);

    const info = await env.runCommand({
      commandName: "ticket",
      subcommand: "info",
      admin: true,
      channelId: row.channel_id,
    });
    assertEphemeralReply(info);
    assertReplyContains(info, /Ticket|#/);
    assertReplyContains(info, /Cannot join voice|voice/i);

    const list = await env.runCommand({
      commandName: "ticket",
      subcommand: "list",
      admin: true,
    });
    assertEphemeralReply(list);
    assertReplyContains(list, /Open tickets|#/i);

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: row.channel_id,
      options: { reason: "Restarted client" },
    });
    const closeText = env.lastReplyContent(close);
    assert.match(closeText, /closed/i);
    assert.match(closeText, /archive/i);

    const afterClose = env.db.getTicketById(row.id);
    assert.equal(afterClose.status, "closed");
    assert.equal(afterClose.archived, 0);
    assert.equal(afterClose.channel_id, row.channel_id); // channel kept
    assert.ok(env.guild.channels.cache.get(row.channel_id)); // not deleted

    // archive before close should fail — already closed path uses archive next
    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: row.channel_id,
    });
    const archiveText = env.lastReplyContent(archive);
    assert.match(archiveText, /archived|transcript/i);

    const after = env.db.getTicketById(row.id);
    assert.equal(after.status, "closed");
    assert.equal(after.archived, 1);
    assert.ok(after.transcript_token);
    assert.ok(after.transcript_path);
    assert.equal(after.channel_id, null);
    assert.ok(env.db.listTicketMessages(row.id).length >= 1);
    assert.ok(env.channels.log.sent.length >= 1);

    // restore rate limit for later tests
    env.db.updateGuildSettings(env.communityId, {
      ticket_rate_limit_minutes: 60,
    });
  });

  it("/ticket create rate limit after self-create", async () => {
    env.db.updateGuildSettings(env.communityId, {
      ticket_rate_limit_minutes: 60,
    });
    // member2 may already have a self-create from a previous run — force by creating
    const c1 = await env.runCommand({
      commandName: "ticket",
      subcommand: "create",
      admin: false,
      user: env.users.member2User,
      options: { reason: "rate-limit-first" },
    });
    const t1 = env.lastReplyContent(c1);
    // either opened or already rate-limited from prior test data
    if (/opened|Ticket/i.test(t1)) {
      const c2 = await env.runCommand({
        commandName: "ticket",
        subcommand: "create",
        admin: false,
        user: env.users.member2User,
        options: { reason: "second too soon" },
      });
      assertEphemeralReply(c2);
      assertReplyContains(c2, /too quickly|rate limit|minute/i);
    } else {
      assert.match(t1, /too quickly|rate limit|minute/i);
    }
  });

  // #421 (audit LT-4): the channel + row already exist when the open notice
  // sends — a transient send failure must NOT report a failed create.
  it("/ticket create still reports SUCCESS when the open-notice send fails", async () => {
    env.db.updateGuildSettings(env.communityId, { ticket_rate_limit_minutes: 0 });
    const origCreate = env.guild.channels.create;
    env.guild.channels.create = async (data) => {
      const ch = await origCreate.call(env.guild.channels, data);
      // Transient transport failure on the notice only (the channel opened).
      ch.send = async () => {
        throw new Error("global rate limit: retryable");
      };
      return ch;
    };
    try {
      const create = await env.runCommand({
        commandName: "ticket",
        subcommand: "create",
        admin: false,
        user: env.users.memberUser,
        options: { reason: "voice invite missing" },
      });
      const text = env.lastReplyContent(create);
      // RED on old code: "Failed to open ticket: global rate limit…" for a
      // ticket that DID open — the member retries into a false rate limit.
      assert.doesNotMatch(text, /failed to open ticket/i, `reply: ${text}`);
      assert.match(text, /Ticket|#|opened/i);

      const row = env.db
        .listOpenTickets(env.communityId, { userId: IDS.member, limit: 10 })
        .find((t) => t.reason === "voice invite missing");
      assert.ok(row, "the ticket row exists despite the notice failure");
      assert.ok(env.guild.channels.cache.get(row.channel_id), "channel exists");
    } finally {
      env.guild.channels.create = origCreate;
      env.db.updateGuildSettings(env.communityId, { ticket_rate_limit_minutes: 0 });
    }
  });

  // ── #420 (audit LT-3): the rate limit survives concurrent submits ─────────

  it("#420 concurrent /ticket create opens ONE ticket; the loser is rate-limited", async () => {
    env.db.updateGuildSettings(env.communityId, { ticket_rate_limit_minutes: 60 });
    // Fresh member: no prior self-create rows (the window pre-check stays a
    // green light — the CLAIM is what must decide the race).
    const racer = env.createUser({ id: "user-race-420", username: "racer" });
    const raceMem = env.createMember({ guild: env.guild, user: racer });
    env.guild.addMember(raceMem);
    const origCreate = env.guild.channels.create;
    let releaseHold;
    const gate = new Promise((r) => (releaseHold = r));
    env.guild.channels.create = async (data) => {
      const ch = await origCreate.call(env.guild.channels, data);
      await gate; // hold BOTH arms inside the channel-create phase — the
      // exact window the old check-then-act lost both submits through.
      return ch;
    };
    try {
      const p1 = env.runCommand({
        commandName: "ticket",
        subcommand: "create",
        admin: false,
        user: racer,
        options: { reason: "race-a-420" },
      });
      const p2 = env.runCommand({
        commandName: "ticket",
        subcommand: "create",
        admin: false,
        user: racer,
        options: { reason: "race-b-420" },
      });
      await new Promise((r) => setImmediate(r));
      releaseHold();
      const [i1, i2] = await Promise.all([p1, p2]);

      const t1 = env.lastReplyContent(i1);
      const t2 = env.lastReplyContent(i2);
      const opened = [t1, t2].filter((t) => /opened/i.test(t));
      const refused = [t1, t2].filter((t) => /too quickly|minute/i.test(t));
      // RED on old code: BOTH replies said "opened" and TWO rows existed.
      assert.equal(opened.length, 1, `exactly one opener: ${t1} || ${t2}`);
      assert.equal(refused.length, 1, `exactly one refusal: ${t1} || ${t2}`);

      const mine = env.db.listOpenTickets(env.communityId, {
        userId: "user-race-420",
        limit: 10,
      });
      assert.equal(
        mine.filter((t) => t.reason === "race-a-420" || t.reason === "race-b-420").length,
        1,
        "exactly one ticket ROW for the double submit",
      );
    } finally {
      env.guild.channels.create = origCreate;
      env.db.db.prepare("DELETE FROM ticket_create_reservations").run();
      env.db.db
        .prepare("DELETE FROM tickets WHERE creator_user_id = ?")
        .run("user-race-420");
      env.db.updateGuildSettings(env.communityId, { ticket_rate_limit_minutes: 0 });
    }
  });

  it("#420 a failed create releases the slot — immediate retry succeeds", async () => {
    env.db.updateGuildSettings(env.communityId, { ticket_rate_limit_minutes: 60 });
    const retryer = env.createUser({ id: "user-retry-420", username: "retryer" });
    const retryMem = env.createMember({ guild: env.guild, user: retryer });
    env.guild.addMember(retryMem);
    const origCreate = env.guild.channels.create;
    try {
      env.guild.channels.create = async () => {
        throw new Error("50013 Missing Permissions");
      };
      const failed = await env.runCommand({
        commandName: "ticket",
        subcommand: "create",
        admin: false,
        user: retryer,
        options: { reason: "fail-then-retry-420" },
      });
      assert.doesNotMatch(env.lastReplyContent(failed), /opened/i);

      env.guild.channels.create = origCreate;
      const retry = await env.runCommand({
        commandName: "ticket",
        subcommand: "create",
        admin: false,
        user: retryer,
        options: { reason: "fail-then-retry-420" },
      });
      // If the failed create kept the claimed slot, this reply is rate-limit.
      assert.match(env.lastReplyContent(retry), /opened/i, env.lastReplyContent(retry));
    } finally {
      env.guild.channels.create = origCreate;
      env.db.db.prepare("DELETE FROM ticket_create_reservations").run();
      env.db.db
        .prepare("DELETE FROM tickets WHERE creator_user_id = ?")
        .run("user-retry-420");
      env.db.updateGuildSettings(env.communityId, { ticket_rate_limit_minutes: 0 });
    }
  });

  it("/ticket for adds staff opener as exclusive named owner + bypasses rate limit", async () => {
    env.db.updateGuildSettings(env.communityId, { ticket_rate_limit_minutes: 60 });

    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "Staff pull-in sensitive",
    });
    const chId = ticket.channel_id;

    // Staff who opened on behalf of the member is claimed as staff owner
    // and listed as named staff (user overwrite access).
    const row = env.db.getTicketById(ticket.id);
    assert.equal(row.opened_by_staff_id, IDS.admin);
    assert.equal(row.staff_owner_id, IDS.admin);
    assert.ok(
      env.db.listTicketStaff(ticket.id).some(
        (s) => s.user_id === IDS.admin && s.is_owner === 1
      ),
      "opener must be named staff owner on the ticket"
    );

    const sens = await env.runCommand({
      commandName: "ticket",
      subcommand: "sensitive",
      admin: true,
      channelId: chId,
    });
    assertEphemeralReply(sens);
    assertReplyContains(sens, /sensitive/i);
    assert.equal(env.db.getTicketById(ticket.id).is_sensitive, 1);
    assert.ok(env.db.getTicketById(ticket.id).staff_owner_id);

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: chId,
      options: { reason: "resolved privately" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    const afterClose = env.db.getTicketById(ticket.id);
    assert.equal(afterClose.status, "closed");
    assert.equal(afterClose.archived, 0);
    assert.equal(afterClose.channel_id, chId);

    const logBefore = env.channels.log.sent.length;
    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: chId,
    });
    assert.match(env.lastReplyContent(archive), /archived|sensitive/i);

    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.status, "closed");
    assert.equal(after.archived, 0); // sensitive never content-archives
    assert.equal(after.transcript_token, null);
    assert.equal(after.channel_id, null);
    assert.equal(env.db.listTicketMessages(ticket.id).length, 0);
    assert.ok(env.channels.log.sent.length > logBefore); // stub post
  });

  // --- Fix 2 (spec §1.11): DM the requester the transcript link on archive ---

  /**
   * Run `fn` with TICKET_PUBLIC_BASE_URL temporarily set (env save/restore).
   * @param {string|null} base
   * @param {() => Promise<object>} fn
   */
  async function withBaseUrl(base, fn) {
    const prev = process.env.TICKET_PUBLIC_BASE_URL;
    if (base == null) delete process.env.TICKET_PUBLIC_BASE_URL;
    else process.env.TICKET_PUBLIC_BASE_URL = base;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.TICKET_PUBLIC_BASE_URL;
      else process.env.TICKET_PUBLIC_BASE_URL = prev;
    }
  }

  /**
   * Flatten captured DM payloads to searchable text.
   * @param {object[]} sends
   */
  function dmText(sends) {
    return sends.map((s) => JSON.stringify(s)).join("\n");
  }

  it("archive DMs the requester the transcript link (non-sensitive, base URL set)", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "dm transcript link",
    });
    const chId = ticket.channel_id;
    const ticketChannel = env.guild.channels.cache.get(chId);
    ticketChannel.addMessage({ id: "dm-msg-1", content: "help please" });

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: chId,
      options: { reason: "All set" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    // Only look at DMs raised by this flow from here on
    env.users.memberUser.sends.length = 0;
    env.users.adminUser.sends.length = 0;
    env.users.member2User.sends.length = 0;

    const archive = await withBaseUrl(
      "https://transcripts.example.test",
      () =>
        env.runCommand({
          commandName: "ticket",
          subcommand: "archive",
          admin: true,
          channelId: chId,
        })
    );

    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.archived, 1);
    assert.ok(after.transcript_token, "expected transcript token");

    const archiveText = env.lastReplyContent(archive);
    assert.match(archiveText, /archived/i);
    assert.doesNotMatch(archiveText, /Warnings/i); // DM succeeded → no warning

    const text = dmText(env.users.memberUser.sends);
    assert.match(text, new RegExp(`Ticket #${after.ticket_number} archived`));
    assert.match(text, /All set/); // close reason
    assert.ok(
      text.includes(
        `[View transcript](https://transcripts.example.test/t/${after.transcript_token})`
      ),
      `expected transcript link in requester DM, got: ${text}`
    );

    // Requester only — the link is never DM'd to non-creators
    for (const other of [env.users.adminUser, env.users.member2User]) {
      assert.doesNotMatch(dmText(other.sends), /View transcript/i);
    }
  });

  it("archive without public base URL DMs requester ref+reason but no URL", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "dm no base url",
    });
    const chId = ticket.channel_id;

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: chId,
      options: { reason: "wrapped up" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    env.users.memberUser.sends.length = 0;

    const archive = await withBaseUrl(null, () =>
      env.runCommand({
        commandName: "ticket",
        subcommand: "archive",
        admin: true,
        channelId: chId,
      })
    );

    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.archived, 1); // transcript still saved
    assert.doesNotMatch(env.lastReplyContent(archive), /Warnings/i);

    const text = dmText(env.users.memberUser.sends);
    assert.equal(env.users.memberUser.sends.length, 1); // one archive DM
    assert.match(text, new RegExp(`Ticket #${after.ticket_number} archived`));
    assert.match(text, /wrapped up/);
    assert.doesNotMatch(text, /View transcript/i);
    assert.doesNotMatch(text, /https?:\/\//i);
  });

  it("sensitive archive never DMs a transcript URL to the requester", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "sensitive dm no url",
    });
    const chId = ticket.channel_id;

    const sens = await env.runCommand({
      commandName: "ticket",
      subcommand: "sensitive",
      admin: true,
      channelId: chId,
    });
    assertEphemeralReply(sens);
    assert.equal(env.db.getTicketById(ticket.id).is_sensitive, 1);

    env.users.memberUser.sends.length = 0;

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: chId,
      options: { reason: "handled privately" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    const archive = await withBaseUrl(
      "https://transcripts.example.test",
      () =>
        env.runCommand({
          commandName: "ticket",
          subcommand: "archive",
          admin: true,
          channelId: chId,
        })
    );
    assert.match(env.lastReplyContent(archive), /archived|sensitive/i);

    const text = dmText(env.users.memberUser.sends);
    // Exactly one DM (the close notice); archive adds none; never a URL.
    assert.equal(env.users.memberUser.sends.length, 1);
    assert.match(text, /closed/i);
    assert.match(text, /handled privately/);
    assert.doesNotMatch(text, /View transcript/i);
    assert.doesNotMatch(text, /https?:\/\//i);
    assert.equal(env.db.getTicketById(ticket.id).transcript_token, null);
  });

  it("requester DM failure surfaces a warning and never fails the archive", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "dm rejected",
    });
    const chId = ticket.channel_id;

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: chId,
      options: { reason: "done" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    // Simulate closed DMs / blocked bot
    const origSend = env.users.memberUser.send;
    env.users.memberUser.send = async () => {
      throw new Error("Cannot send messages to this user");
    };

    let archive;
    try {
      archive = await withBaseUrl(
        "https://transcripts.example.test",
        () =>
          env.runCommand({
            commandName: "ticket",
            subcommand: "archive",
            admin: true,
            channelId: chId,
          })
      );
    } finally {
      env.users.memberUser.send = origSend;
    }

    const archiveText = env.lastReplyContent(archive);
    assert.match(archiveText, /archived/i);
    assert.match(archiveText, /Warnings/i);
    assert.match(archiveText, /Could not DM the requester the transcript link/);
    assert.match(archiveText, /Cannot send messages to this user/);

    // Archive itself succeeded despite the DM failure
    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.archived, 1);
    assert.equal(after.channel_id, null);
    assert.ok(after.transcript_token);
  });

  // #418 (audit LT-1): the transcript FILE is the archive. A write failure
  // must abort everything (no finalize, no channel delete, no success copy)
  // AND leave the archive retryable (claim released).
  it("transcript-write failure aborts the archive and the retry succeeds (#418)", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "418 write failure",
    });
    const chId = ticket.channel_id;
    const ticketChannel = env.guild.channels.cache.get(chId);
    ticketChannel.addMessage({ id: "418-msg-1", content: "keep me" });

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: chId,
      options: { reason: "resolved" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    // Force a REAL write failure at the fs boundary (production code
    // untouched): mkdir of the transcript's {community}/{token} directory
    // throws, exactly like ENOSPC/EROFS in the field. Scoped to the
    // transcripts path and restored before the retry runs.
    const realFs = require("node:fs");
    let intercepted = false;
    const realMkdir = realFs.mkdirSync;
    realFs.mkdirSync = function (p, ...rest) {
      const s = String(p);
      // Only the transcript write's own mkdir (…/ticket-transcripts/{id}/{token}),
      // not the mirror step's …/assets or the community dir — the pipeline
      // catches the mirror failure separately.
      if (!intercepted && /ticket-transcripts\/\d+\/[^/]+$/.test(s)) {
        intercepted = true;
        const err = new Error(`EACCES: permission denied, mkdir '${s}'`);
        err.code = "EACCES";
        err.path = s;
        throw err;
      }
      return realMkdir.call(this, p, ...rest);
    };
    let archiveText = "";
    try {
      const failed = await env.runCommand({
        commandName: "ticket",
        subcommand: "archive",
        admin: true,
        channelId: chId,
      });
      archiveText = env.lastReplyContent(failed);
    } finally {
      realFs.mkdirSync = realMkdir;
    }

    // The reply names the cause — never a success copy (AGENTS.md rule 3).
    assert.match(archiveText, /was NOT archived/i);
    assert.match(archiveText, /could not write the transcript file/i);

    // Nothing destructive happened: not finalized, channel kept, no phantom
    // token advertised or stored.
    const aborted = env.db.getTicketById(ticket.id);
    assert.equal(aborted.archived, 0, "abort leaves the ticket un-finalized");
    assert.equal(aborted.channel_id, chId, "the channel is kept");
    assert.equal(aborted.transcript_token, null, "no phantom token stored");
    assert.equal(aborted.transcript_path, null);
    assert.ok(
      env.guild.channels.cache.get(chId),
      "the ticket channel still exists after the abort",
    );

    // The claim was released — the retry archives for real (this is the
    // whole point: LT-1 stranded content with the only recovery path blocked).
    const retry = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: chId,
    });
    assert.match(env.lastReplyContent(retry), /archived/i);
    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.archived, 1);
    assert.ok(after.transcript_token);
    assert.ok(after.transcript_path);
    assert.equal(after.channel_id, null);
    const texts = env.db.listTicketMessages(ticket.id).map((m) => m.content);
    assert.ok(texts.includes("keep me"), "transcript content survived the abort");
  });

  it("/ticket adduser + removeuser + addstaff + removestaff + transfer", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "lifecycle people",
    });

    const addUser = await env.runCommand({
      commandName: "ticket",
      subcommand: "adduser",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(addUser);
    assertReplyContains(addUser, /Added|already/i);
    assert.ok(
      env.db
        .listTicketMembers(ticket.id)
        .some((m) => m.user_id === IDS.member2)
    );

    const removeUser = await env.runCommand({
      commandName: "ticket",
      subcommand: "removeuser",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(removeUser);
    assertReplyContains(removeUser, /Removed/i);
    assert.ok(
      !env.db
        .listTicketMembers(ticket.id)
        .some((m) => m.user_id === IDS.member2)
    );

    // cannot remove creator
    const removeCreator = await env.runCommand({
      commandName: "ticket",
      subcommand: "removeuser",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.memberUser },
    });
    assertEphemeralReply(removeCreator);
    assertReplyContains(removeCreator, /creator/i);

    await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: ticket.channel_id,
    });

    const addStaff = await env.runCommand({
      commandName: "ticket",
      subcommand: "addstaff",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(addStaff);
    assert.ok(
      env.db.listTicketStaff(ticket.id).some((s) => s.user_id === IDS.member2)
    );

    const removeStaff = await env.runCommand({
      commandName: "ticket",
      subcommand: "removestaff",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.member2User },
    });
    assertEphemeralReply(removeStaff);
    assertReplyContains(removeStaff, /Removed/i);

    // cannot remove owner without transfer
    const removeOwner = await env.runCommand({
      commandName: "ticket",
      subcommand: "removestaff",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.adminUser },
    });
    assertEphemeralReply(removeOwner);
    assertReplyContains(removeOwner, /owner|Transfer/i);

    const transfer = await env.runCommand({
      commandName: "ticket",
      subcommand: "transfer",
      admin: true,
      channelId: ticket.channel_id,
      options: { staff: env.users.member2User },
    });
    assertEphemeralReply(transfer);
    assertReplyContains(transfer, /Transferred|transfer/i);
    assert.equal(
      env.db.getTicketById(ticket.id).staff_owner_id,
      IDS.member2
    );
  });

  it("/ticket sensitive denied for non-owner staff; unsensitive works", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "sensitive gate",
    });

    // Admin claims as owner
    await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: ticket.channel_id,
    });

    // Staff member with staff role but not ManageGuild, not owner
    const staffUser = createUser({ id: "user-staff-mod", username: "staffmod" });
    const staffMember = createMember({
      guild: env.guild,
      user: staffUser,
      admin: false,
      roleIds: [IDS.roleExempt],
    });
    env.guild.addMember(staffMember);

    const denied = await env.runCommand({
      commandName: "ticket",
      subcommand: "sensitive",
      admin: false,
      user: staffUser,
      member: staffMember,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(denied);
    assertReplyContains(denied, /owner|admin|permission|sensitive/i);

    // Admin can still mark sensitive
    const ok = await env.runCommand({
      commandName: "ticket",
      subcommand: "sensitive",
      admin: true,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(ok);
    assert.equal(env.db.getTicketById(ticket.id).is_sensitive, 1);

    const un = await env.runCommand({
      commandName: "ticket",
      subcommand: "unsensitive",
      admin: true,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(un);
    assertReplyContains(un, /no longer sensitive|sensitive/i);
    assert.equal(env.db.getTicketById(ticket.id).is_sensitive, 0);
  });

  it("lifecycle commands fail outside ticket channel", async () => {
    const claim = await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: IDS.channelGeneral,
    });
    assertEphemeralReply(claim);
    assertReplyContains(claim, /open ticket|ticket channel/i);

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: IDS.channelGeneral,
    });
    assertEphemeralReply(close);
    assertReplyContains(close, /open ticket|ticket channel/i);

    const info = await env.runCommand({
      commandName: "ticket",
      subcommand: "info",
      admin: true,
      channelId: IDS.channelGeneral,
    });
    assertEphemeralReply(info);
    assertReplyContains(info, /ticket/i);
  });

  it("rejects bot targets on for / adduser", async () => {
    const forBot = await env.runCommand({
      commandName: "ticket",
      subcommand: "for",
      admin: true,
      options: { user: env.users.botUser, reason: "nope" },
    });
    assertEphemeralReply(forBot);
    assertReplyContains(forBot, /bot/i);

    const ticket = await openViaStaff({
      reason: "bot-add-test",
    });
    const addBot = await env.runCommand({
      commandName: "ticket",
      subcommand: "adduser",
      admin: true,
      channelId: ticket.channel_id,
      options: { user: env.users.botUser },
    });
    assertEphemeralReply(addBot);
    assertReplyContains(addBot, /bot/i);
  });

  it("/ticket setcategory / setarchive / setratelimit require staff", async () => {
    const denied = await env.runCommand({
      commandName: "ticket",
      subcommand: "setratelimit",
      admin: false,
      user: env.users.memberUser,
      options: { minutes: 30 },
    });
    assertEphemeralReply(denied, /permission/i);

    // Staff role (no ManageGuild) can configure
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "junior");
    const staffMember = env.createMember({
      guild: env.guild,
      user: env.users.memberUser,
      admin: false,
      roleIds: [IDS.roleExempt],
    });
    env.guild.addMember(staffMember);

    const okStaff = await env.runCommand({
      commandName: "ticket",
      subcommand: "setratelimit",
      admin: false,
      user: env.users.memberUser,
      member: staffMember,
      options: { minutes: 45 },
    });
    assertEphemeralReply(okStaff);
    assert.equal(
      env.db.getTicketSettings(env.communityId).ticket_rate_limit_minutes,
      45
    );

    const ok = await env.runCommand({
      commandName: "ticket",
      subcommand: "setratelimit",
      admin: true,
      options: { minutes: 30 },
    });
    assertEphemeralReply(ok);
    assert.equal(
      env.db.getTicketSettings(env.communityId).ticket_rate_limit_minutes,
      30
    );

    const cat = createTextChannel({
      id: "channel-ticket-cat",
      guild: env.guild,
      name: "Tickets",
      type: 4, // GuildCategory
    });
    env.guild.addChannel(cat);

    const setCat = await env.runCommand({
      commandName: "ticket",
      subcommand: "setcategory",
      admin: true,
      options: { category: cat },
    });
    assertEphemeralReply(setCat);
    assert.equal(
      env.db.getTicketSettings(env.communityId).ticket_category_id,
      cat.id
    );

    const setArch = await env.runCommand({
      commandName: "ticket",
      subcommand: "setarchive",
      admin: true,
      options: { channel: env.channels.log },
    });
    assertEphemeralReply(setArch);
    assert.equal(
      env.db.getTicketSettings(env.communityId).ticket_archive_channel_id,
      IDS.channelLog
    );

    // restore rate limit used by other tests
    env.db.updateGuildSettings(env.communityId, {
      ticket_rate_limit_minutes: 60,
    });
  });

  it("allows /ticket lifecycle inside ticket channel when command channels restricted", async () => {
    const ticket = await openViaStaff({
      reason: "cmd-channel-exception",
    });

    env.db.addAllowedCommandChannel(env.communityId, IDS.channelCmds);

    // XP blocked in general
    const xpBlocked = await env.runCommand({
      commandName: "xp",
      channelId: IDS.channelGeneral,
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(xpBlocked, /aren't enabled/);

    // ticket claim still works inside open ticket channel
    const claim = await env.runCommand({
      commandName: "ticket",
      subcommand: "claim",
      admin: true,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(claim);
    assertReplyContains(claim, /claimed/i);

    // ticket create outside allow-list is blocked
    const createBlocked = await env.runCommand({
      commandName: "ticket",
      subcommand: "create",
      admin: false,
      user: env.users.memberUser,
      channelId: IDS.channelGeneral,
      options: { reason: "should block" },
    });
    assertEphemeralReply(createBlocked, /aren't enabled/);

    // cleanup allow-list
    env.db.removeAllowedCommandChannel(env.communityId, IDS.channelCmds);
  });

  it("ChannelDelete marks open ticket closed without archive", async () => {
    const ticket = await openViaStaff({
      reason: "external-delete",
    });
    const channel = env.guild.channels.cache.get(ticket.channel_id);
    assert.ok(channel);

    // Simulate Discord channel delete event
    env.client.emit(Events.ChannelDelete, channel);

    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.status, "closed");
    assert.equal(after.archived, 0);
    assert.equal(after.channel_id, null);
    assert.match(after.close_reason || "", /deleted outside/i);
  });

  it("/ticket list can filter by user", async () => {
    await openViaStaff({
      user: env.users.memberUser,
      reason: "list-filter-a",
    });
    const list = await env.runCommand({
      commandName: "ticket",
      subcommand: "list",
      admin: true,
      options: { user: env.users.memberUser },
    });
    assertEphemeralReply(list);
    // either open tickets for user or empty if all closed — should not error
    const content = env.lastReplyContent(list);
    assert.ok(
      /Open tickets|No open tickets/i.test(content),
      `unexpected list reply: ${content}`
    );
  });

  it("/ticket close staff_note creates private note on requester", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "note-from-close",
    });
    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: ticket.channel_id,
      options: {
        reason: "Resolved in channel",
        staff_note: "Member had VPN issues; watch for repeat.",
      },
    });
    assertReplyContains(close, /closed/i);
    assertReplyContains(close, /Staff note|N-/i);

    // Button should still be present for additional notes
    const reply = close.replies.find((r) => r.components?.length) || close.replies[0];
    assert.ok(reply?.components?.length >= 1, "expected Add staff note button");

    const notes = env.db.listStaffNotes(env.communityId, IDS.member, { limit: 20 });
    const match = notes.find(
      (n) =>
        n.content.includes("Member had VPN issues") &&
        n.content.includes(`#${ticket.ticket_number}`)
    );
    assert.ok(match, "expected staff note with ticket ref and body");
  });

  it("post-close Add staff note button → modal creates note", async () => {
    const ticket = await openViaStaff({
      user: env.users.member2User,
      reason: "button-note-path",
    });
    await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: ticket.channel_id,
      options: { reason: "Done" },
    });
    const closed = env.db.getTicketById(ticket.id);

    const ticketsFeature = require("../../src/features/tickets");
    const { createModalSubmitInteraction } = require("../helpers/discord");

    const btn = await env.runButton({
      customId: `${ticketsFeature.BTN_STAFF_NOTE_PREFIX}${closed.id}`,
      admin: true,
    });
    assert.equal(btn.modals.length, 1);

    const body = `Button modal note ${Date.now()}`;
    const modalIx = createModalSubmitInteraction({
      customId: `${ticketsFeature.MODAL_STAFF_NOTE_PREFIX}${closed.id}`,
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
      client: env.client,
      fields: { staff_note: body },
    });
    await env.handleInteraction(modalIx, env.ctx);
    assertReplyContains(modalIx, /Staff note|N-/i);

    const notes = env.db.listStaffNotes(env.communityId, IDS.member2, {
      limit: 20,
    });
    assert.ok(notes.some((n) => n.content.includes(body)));
  });

  it("/ticket panel create posts embed + Open ticket button (staff)", async () => {
    const denied = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "create",
      admin: false,
      user: env.users.memberUser,
      options: { channel: env.channels.general },
    });
    assertEphemeralReply(denied, /permission/i);

    const beforeCount = env.channels.general.sent?.length || 0;
    const panel = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "create",
      admin: true,
      options: {
        channel: env.channels.general,
        title: "Need help?",
        description: "Press the button to open a ticket.",
      },
    });
    assertReplyContains(panel, /Created ticket panel/i);

    const afterCount = env.channels.general.sent?.length || 0;
    assert.ok(afterCount > beforeCount, "expected panel message in channel");
    const lastPayload = env.channels.general.sent[afterCount - 1];
    assert.ok(lastPayload.embeds?.length >= 1);
    assert.ok(lastPayload.components?.length >= 1);

    const ticketsFeature = require("../../src/features/tickets");
    const row = lastPayload.components[0];
    const rowJson = typeof row.toJSON === "function" ? row.toJSON() : row;
    const components = rowJson.components || row.components || [];
    const btn = components[0];
    const btnJson = typeof btn?.toJSON === "function" ? btn.toJSON() : btn;
    assert.equal(
      btnJson?.custom_id || btnJson?.customId || btn?.data?.custom_id,
      ticketsFeature.BTN_OPEN
    );
  });

  it("panel button shows modal; modal submit creates ticket", async () => {
    env.db.updateGuildSettings(env.communityId, {
      ticket_rate_limit_minutes: 0,
    });

    const ticketsFeature = require("../../src/features/tickets");
    const { createModalSubmitInteraction } = require("../helpers/discord");

    const btn = await env.runButton({
      customId: ticketsFeature.BTN_OPEN,
      admin: false,
      user: env.users.member2User,
    });
    assert.equal(btn.modals.length, 1);
    const modal = btn.modals[0];
    const modalJson =
      typeof modal.toJSON === "function" ? modal.toJSON() : modal;
    assert.equal(
      modalJson.custom_id || modalJson.customId,
      ticketsFeature.MODAL_CREATE
    );

    const reason = `panel-modal-${Date.now()}`;
    const modalIx = createModalSubmitInteraction({
      customId: ticketsFeature.MODAL_CREATE,
      guild: env.guild,
      user: env.users.member2User,
      member: env.members.member2,
      admin: false,
      client: env.client,
      fields: { reason },
    });
    await env.handleInteraction(modalIx, env.ctx);

    const content = env.lastReplyContent(modalIx);
    assert.match(content, /Ticket|opened/i);

    const open = env.db.listOpenTickets(env.communityId, {
      userId: IDS.member2,
      limit: 10,
    });
    const ticket = open.find((t) => t.reason === reason);
    assert.ok(ticket, "expected ticket from panel modal");
    assert.equal(ticket.opened_by_staff_id, null);
  });

  it("panel button respects self-create rate limit", async () => {
    env.db.updateGuildSettings(env.communityId, {
      ticket_rate_limit_minutes: 60,
    });
    // Seed a recent self-create for memberUser
    env.db.createTicket({
      communityId: env.communityId,
      creatorUserId: IDS.member,
      channelId: `ch-rl-panel-${Date.now()}`,
      reason: "seed for rate limit",
    });

    const ticketsFeature = require("../../src/features/tickets");
    const btn = await env.runButton({
      customId: ticketsFeature.BTN_OPEN,
      admin: false,
      user: env.users.memberUser,
    });
    assert.equal(btn.modals.length, 0);
    assertEphemeralReply(btn, /too quickly|rate limit/i);
  });

  it("/ticket summarize on open ticket (fallback without AI key)", async () => {
    const ticket = await openViaStaff({
      user: env.users.memberUser,
      reason: "summarize-test",
    });
    const channel = env.guild.channels.cache.get(ticket.channel_id);
    assert.ok(channel, "expected ticket channel");
    channel.addMessage({
      id: "sum-1",
      content: "My microphone is not working at all",
      author: { id: IDS.member, username: "member", tag: "member#0000" },
    });

    const res = await env.runCommand({
      commandName: "ticket",
      subcommand: "summarize",
      admin: true,
      channelId: ticket.channel_id,
    });
    const text = env.lastReplyContent(res);
    assert.match(text, /summarize|resolution|summary/i);
    // No AI key in test env → stats-only fallback
    assert.match(text, /stats-only/i);
    assert.match(text, /microphone/i);
  });

  it("/ticket summarize denies non-staff", async () => {
    const ticket = await openViaStaff({
      user: env.users.member2User,
      reason: "summarize-deny",
    });
    const res = await env.runCommand({
      commandName: "ticket",
      subcommand: "summarize",
      admin: false,
      user: env.users.memberUser,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(res, /permission|staff|denied/i);
  });

  it("close without archive channel still soft-closes; archive still works", async () => {
    const ticket = await openViaStaff({
      reason: "no-archive-channel",
    });
    env.db.updateGuildSettings(env.communityId, {
      ticket_archive_channel_id: null,
    });

    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: ticket.channel_id,
      options: { reason: "done anyway" },
    });
    const text = env.lastReplyContent(close);
    assert.match(text, /closed/i);

    const afterClose = env.db.getTicketById(ticket.id);
    assert.equal(afterClose.status, "closed");
    assert.equal(afterClose.channel_id, ticket.channel_id);

    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: ticket.channel_id,
    });
    const archText = env.lastReplyContent(archive);
    assert.match(archText, /archived|Warnings|transcript/i);

    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.status, "closed");
    assert.equal(after.channel_id, null);

    // restore archive channel
    env.db.updateGuildSettings(env.communityId, {
      ticket_archive_channel_id: IDS.channelLog,
    });
  });

  it("/ticket archive requires close first", async () => {
    const ticket = await openViaStaff({
      reason: "archive-before-close",
    });
    const archive = await env.runCommand({
      commandName: "ticket",
      subcommand: "archive",
      admin: true,
      channelId: ticket.channel_id,
    });
    assertEphemeralReply(archive);
    assertReplyContains(archive, /close/i);
    assert.equal(env.db.getTicketById(ticket.id).status, "open");
  });

  it("/ticket panel list shows registered panels after create", async () => {
    // Count existing panels first (prior tests may have left state)
    let panels = env.db.listTicketPanels(env.communityId);
    const beforeCount = panels.length;

    // Create a panel
    const create = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "create",
      admin: true,
      options: {
        channel: env.channels.general,
        title: "Test Panel List",
        description: "Panel for list test",
      },
    });
    assertReplyContains(create, /Created ticket panel/i);

    // List should show the new panel
    const list = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "list",
      admin: true,
    });
    assertEphemeralReply(list);
    assertReplyContains(list, /Test Panel List/i);

    // Verify DB count increased
    panels = env.db.listTicketPanels(env.communityId);
    assert.equal(panels.length, beforeCount + 1);
  });

  it("/ticket panel edit updates title/description and live message", async () => {
    // Get existing panels to find one with known state
    let panels = env.db.listTicketPanels(env.communityId);
    // Filter for our test panels (created during this suite)
    const editablePanel = panels.find((p) => p.title === "Test Panel List");

    if (!editablePanel) {
      // Create one if not found (isolated run)
      const create = await env.runCommand({
        commandName: "ticket",
        subcommandGroup: "panel",
        subcommand: "create",
        admin: true,
        options: {
          channel: env.channels.general,
          title: "Panel To Edit",
          description: "Original desc",
        },
      });
      assertReplyContains(create, /Created ticket panel/i);
      panels = env.db.listTicketPanels(env.communityId);
      const newPanels = panels.filter((p) => p.title === "Panel To Edit");
      assert.ok(newPanels.length > 0, "expected created panel in DB");
      editablePanel._panel = newPanels[0];
    }

    const panel = editablePanel._panel || editablePanel;
    const messageId = panel.message_id;

    // Edit the panel
    const edit = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "edit",
      admin: true,
      options: {
        message_id: messageId,
        title: "Updated Title",
      },
    });
    assertReplyContains(edit, /Updated ticket panel/i);

    // Verify DB was updated
    const updatedPanel = env.db.getTicketPanel(env.communityId, messageId);
    assert.equal(updatedPanel.title, "Updated Title");

    // Edit with missing message_id fails
    const editMissing = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "edit",
      admin: true,
      options: {
        message_id: "nonexistent-msg-id",
        title: "Won't happen",
      },
    });
    assertReplyContains(editMissing, /No ticket panel/i);
  });

  it("/ticket panel delete removes registration and Discord message", async () => {
    // Create a panel specifically for deletion
    const create = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "create",
      admin: true,
      options: {
        channel: env.channels.general,
        title: "Panel To Delete",
        description: "Will be removed",
      },
    });
    assertReplyContains(create, /Created ticket panel/i);

    // Find in DB by title (more reliable than parsing reply)
    let panels = env.db.listTicketPanels(env.communityId);
    const toDelete = panels.find((p) => p.title === "Panel To Delete");
    assert.ok(toDelete, "expected panel in DB");
    const messageId = toDelete.message_id;

    // Verify count before delete
    const beforeCount = panels.length;

    // Delete the panel
    const delete_ = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "delete",
      admin: true,
      options: {
        message_id: messageId,
      },
    });
    assertReplyContains(delete_, /Deleted ticket panel/i);

    // Verify it's gone from DB
    panels = env.db.listTicketPanels(env.communityId);
    assert.equal(panels.length, beforeCount - 1);

    // Delete nonexistent fails gracefully
    const deleteMissing = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "delete",
      admin: true,
      options: {
        message_id: "nonexistent-panel-id",
      },
    });
    assertReplyContains(deleteMissing, /No ticket panel/i);
  });

  it("/ticket panel requires staff gate for all operations", async () => {
    // panel create
    const createDeny = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "create",
      admin: false,
      user: env.users.memberUser,
      options: { channel: env.channels.general },
    });
    assertEphemeralReply(createDeny);
    assertReplyContains(createDeny, /permission/i);

    // panel list (non-staff gets denied)
    const list = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "list",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(list);
    assertReplyContains(list, /permission/i);

    // panel edit (non-staff gets denied)
    const editDeny = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "edit",
      admin: false,
      user: env.users.memberUser,
      options: { message_id: "x", title: "hack" },
    });
    assertEphemeralReply(editDeny);
    assertReplyContains(editDeny, /permission/i);

    // panel delete (non-staff gets denied)
    const delDeny = await env.runCommand({
      commandName: "ticket",
      subcommandGroup: "panel",
      subcommand: "delete",
      admin: false,
      user: env.users.memberUser,
      options: { message_id: "x" },
    });
    assertEphemeralReply(delDeny);
    assertReplyContains(delDeny, /permission/i);
  });

  // ── help-tickets §1.11 Fix 1 — bogus "staff role(s) could not get channel
  // access" note on ticket create ────────────────────────────────────────────

  /**
   * Open a ticket via staff /for and return the reply text + ticket row so
   * note-assembly behavior can be asserted directly.
   */
  async function openForCaptureText(reason) {
    const interaction = await env.runCommand({
      commandName: "ticket",
      subcommand: "for",
      admin: true,
      options: { user: env.users.memberUser, reason },
    });
    const text = env.lastReplyContent(interaction);
    assert.match(text, /opened/i, `expected opened reply, got: ${text}`);
    const open = env.db.listOpenTickets(env.communityId, {
      userId: IDS.member,
      limit: 20,
    });
    const ticket = open.find((t) => t.reason === reason);
    assert.ok(ticket, `expected open ticket for reason=${reason}`);
    return { interaction, text, ticket };
  }

  it("no staff-role access note when the bot role is above staff roles", async () => {
    // Prior tests may have flipped this role to junior — force senior.
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "senior");
    const staffRole = env.guild.roles.cache.get(IDS.roleExempt);
    assert.ok(staffRole, "staff role present in role cache");
    // Harness state: staff role position 1 < bot highest position 5.
    assert.ok(staffRole.position < 5);

    const { text, ticket } = await openForCaptureText(
      `note-above-bot-${Date.now()}`,
    );

    // The false-positive this guards against: count-only note despite the bot
    // being able to set the overwrite fine.
    assert.doesNotMatch(text, /could not get channel access/i);
    assert.doesNotMatch(text, /staff role/i);

    const channel = env.guild.channels.cache.get(ticket.channel_id);
    assert.ok(channel, "ticket channel exists");
    const roleOw = channel._overwrites.find((o) => o.id === IDS.roleExempt);
    assert.ok(roleOw?.allow, "senior staff role must get allow overwrite");
  });

  it("staff role missing from cache resolves via roles.fetch with no note", async () => {
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "senior");
    const staffRole = env.guild.roles.cache.get(IDS.roleExempt);
    assert.ok(staffRole);

    // Simulate a cache miss (newly created role / guild fetched without roles):
    // gone from cache but still resolvable via REST.
    env.guild.roles.cache.delete(IDS.roleExempt);
    const realFetch = env.guild.roles.fetch;
    const fetchCalls = [];
    env.guild.roles.fetch = async (roleId) => {
      fetchCalls.push(roleId);
      return roleId === IDS.roleExempt ? staffRole : null;
    };

    try {
      const { text, ticket } = await openForCaptureText(
        `note-cache-miss-${Date.now()}`,
      );
      assert.ok(
        fetchCalls.includes(IDS.roleExempt),
        "cache miss must trigger guild.roles.fetch",
      );
      assert.doesNotMatch(text, /could not get channel access/i);
      assert.doesNotMatch(text, /staff role/i);

      const channel = env.guild.channels.cache.get(ticket.channel_id);
      const roleOw = channel._overwrites.find((o) => o.id === IDS.roleExempt);
      assert.ok(roleOw?.allow, "fetched staff role must still get overwrite");
    } finally {
      env.guild.roles.fetch = realFetch;
      env.guild.roles.cache.set(IDS.roleExempt, staffRole);
    }
  });

  it("bot holding the staff role itself produces no access note", async () => {
    env.db.addStaffRole(env.communityId, IDS.roleExempt, "senior");
    const staffRole = env.guild.roles.cache.get(IDS.roleExempt);
    assert.ok(staffRole);
    const botMember = env.guild.members.me;

    // Bot's ONLY top role is the staff role itself (same position as highest):
    // the overwrite would grant nothing the bot does not already have — it must
    // not be reported as "could not get channel access".
    const origPos = staffRole.position;
    staffRole.position = 5;
    botMember.roles.cache.set(IDS.roleExempt, { id: IDS.roleExempt, position: 5 });

    try {
      const { text, ticket } = await openForCaptureText(
        `note-bot-held-${Date.now()}`,
      );
      assert.doesNotMatch(text, /could not get channel access/i);
      assert.doesNotMatch(text, /staff role/i);

      // Equal-position overwrite is unsafe for Discord → omitted, ticket still opens.
      const channel = env.guild.channels.cache.get(ticket.channel_id);
      assert.ok(channel, "ticket still created");
      assert.ok(
        !channel._overwrites.some((o) => o.id === IDS.roleExempt),
        "bot-held equal-position role must not get a channel overwrite",
      );
    } finally {
      staffRole.position = origPos;
      botMember.roles.cache.delete(IDS.roleExempt);
    }
  });

  // --- audit-2026-10 #197: archive pipeline CAS claim + summary deadline ---

  /** Title of the first embed in a captured channel.send payload, or "". */
  function embedTitleOf(payload) {
    const e = payload?.embeds?.[0];
    if (!e) return "";
    try {
      return String(
        typeof e.toJSON === "function" ? e.toJSON()?.title : e?.title
      );
    } catch {
      return "";
    }
  }

  /**
   * Soft-close a fresh staff-opened ticket and hand back the live channel
   * with a counting delete wrapper.
   */
  async function closedTicketForArchiveRace(reason) {
    const ticket = await openViaStaff({ reason });
    const channel = env.guild.channels.cache.get(ticket.channel_id);
    assert.ok(channel, "ticket channel present");
    channel.addMessage({
      content: "please help",
      author: { id: IDS.member, username: "member", tag: "member#0000" },
      createdTimestamp: Date.now() - 5000,
    });
    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: ticket.channel_id,
      options: { reason: "resolved" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    const state = { deletes: 0 };
    const realDelete = channel.delete.bind(channel);
    channel.delete = async (...args) => {
      state.deletes += 1;
      return realDelete(...args);
    };
    return { ticket, channel, state };
  }

  it("concurrent archive: CAS claim lets exactly one pipeline do the work (#197)", async () => {
    const { ticket, channel, state } = await closedTicketForArchiveRace(
      "double-archive-race"
    );
    const { archiveTicketPipeline } = require("../../src/features/tickets/close");
    const logBefore = env.channels.log.sent.length;

    // Two closes race with STALE pre-claim rows (both archived=0). The CAS
    // claim is a synchronous UPDATE, so exactly one caller wins regardless
    // of interleaving — no timing assumptions in the assertions.
    const run = () =>
      archiveTicketPipeline({
        client: env.client,
        channel,
        ticket: env.db.getTicketById(ticket.id),
        archivedBy: IDS.admin,
        guildName: env.guild.name,
      });
    const results = await Promise.all([run(), run()]);

    const losers = results.filter((r) => r.skipped);
    assert.equal(losers.length, 1, "exactly one close skipped");
    assert.match(
      losers[0].skipped,
      new RegExp(
        `Ticket #${ticket.ticket_number} is already being archived by another close`
      ),
      `loser message names the ticket + cause: ${losers[0].skipped}`
    );

    // Work done EXACTLY once: one delete, one archive embed, one archived row.
    assert.equal(state.deletes, 1, "channel deleted exactly once");
    const titles = env.channels.log
      .sent.slice(logBefore)
      .map(embedTitleOf)
      .filter((t) => /archived/i.test(t));
    assert.equal(titles.length, 1, "transcript archive embed posted once");

    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.archived, 1);
    assert.ok(after.transcript_token, "transcript finalized");
    assert.equal(after.channel_id, null);
    // Channel content saved once (open/close notices ride along — same
    // rows the single-winner archive fetched; the loser saved nothing).
    assert.ok(env.db.listTicketMessages(ticket.id).length >= 1);
  });

  it("sequential archive after a completed archive: loser says already archived (#197)", async () => {
    const { ticket, channel, state } = await closedTicketForArchiveRace(
      "archive-after-archive"
    );
    const { archiveTicketPipeline } = require("../../src/features/tickets/close");

    const first = await archiveTicketPipeline({
      client: env.client,
      channel,
      ticket: env.db.getTicketById(ticket.id),
      archivedBy: IDS.admin,
      guildName: env.guild.name,
    });
    assert.ok(!first.skipped, "first archive runs");
    assert.equal(first.ticket.archived, 1);
    assert.equal(state.deletes, 1);

    // A stale-row retry (e.g. an in-flight second command) must no-op and
    // name the REAL state ("already archived"), never re-do work.
    const stale = { ...ticket, archived: 0 };
    const second = await archiveTicketPipeline({
      client: env.client,
      channel,
      ticket: stale,
      archivedBy: IDS.admin,
      guildName: env.guild.name,
    });
    assert.match(second.skipped, new RegExp(`Ticket #${ticket.ticket_number} is already archived\\.`));
    assert.equal(state.deletes, 1, "no second delete");
  });

  it("concurrent sensitive archive: one stub embed, loser skips, archived stays 0 (#197)", async () => {
    const ticket = await openViaStaff({ reason: "sens-archive-race" });
    env.db.setTicketSensitive(ticket.id, IDS.admin);
    const channel = env.guild.channels.cache.get(ticket.channel_id);
    assert.ok(channel);
    const close = await env.runCommand({
      commandName: "ticket",
      subcommand: "close",
      admin: true,
      channelId: ticket.channel_id,
      options: { reason: "handled off-channel" },
    });
    assert.match(env.lastReplyContent(close), /closed/i);

    let deletes = 0;
    const realDelete = channel.delete.bind(channel);
    channel.delete = async (...args) => {
      deletes += 1;
      return realDelete(...args);
    };

    const { archiveTicketPipeline } = require("../../src/features/tickets/close");
    const logBefore = env.channels.log.sent.length;
    const run = () =>
      archiveTicketPipeline({
        client: env.client,
        channel,
        ticket: env.db.getTicketById(ticket.id),
        archivedBy: IDS.admin,
        guildName: env.guild.name,
      });
    const results = await Promise.all([run(), run()]);

    const losers = results.filter((r) => r.skipped);
    assert.equal(losers.length, 1, "exactly one sensitive close skipped");
    assert.match(
      losers[0].skipped,
      /is already being archived by another close/
    );
    assert.equal(deletes, 1, "channel deleted once");
    const stubs = env.channels.log
      .sent.slice(logBefore)
      .map(embedTitleOf)
      .filter((t) => /archived \(sensitive/.test(t));
    assert.equal(stubs.length, 1, "sensitive stub posted exactly once");

    // Sensitive invariant preserved through the claim flow: archived stays 0.
    const after = env.db.getTicketById(ticket.id);
    assert.equal(after.archived, 0);
    assert.equal(after.channel_id, null);
  });

  it("archive with a hung summary completion aborts at the deadline and surfaces the timeout (fake timer, #197)", async () => {
    const { ticket, channel } = await closedTicketForArchiveRace(
      "summary-hang-archive"
    );
    const { archiveTicketPipeline } = require("../../src/features/tickets/close");

    process.env.AI_API_KEY = "test-key-not-real";
    try {
      // Completion that only EVER settles via the deadline's abort signal
      // (wedged provider socket). Driven by fake timers — zero wall clock.
      const hangFetch = (_url, { signal } = {}) =>
        new Promise((_res, rej) => {
          if (signal?.aborted) {
            rej(new Error("This operation was aborted"));
            return;
          }
          signal.addEventListener("abort", () =>
            rej(new Error("This operation was aborted"))
          );
        });

      let armDeadline;
      const armed = new Promise((resolve) => {
        armDeadline = resolve;
      });
      const run = archiveTicketPipeline({
        client: env.client,
        channel,
        ticket: env.db.getTicketById(ticket.id),
        archivedBy: IDS.admin,
        guildName: env.guild.name,
        summaryOpts: {
          timeoutMs: 15000,
          fetchImpl: hangFetch,
          setTimer: (fn) => {
            armDeadline(fn); // hand the abort callback to the test
            return { fake: true };
          },
          clearTimer: () => {},
        },
      });

      const fireDeadline = await armed; // pipeline reached the bounded summary call
      fireDeadline(); // deadline expires NOW — deterministically
      const result = await run;

      assert.ok(!result.skipped, "this run owned the archive claim");
      assert.match(
        result.warnings.join("\n"),
        new RegExp(
          `Ticket #${ticket.ticket_number} summary generation timed out after 15s`
        ),
        `archive reply surfaces the specific cause: ${result.warnings}`
      );

      // Partial-failure contract: the archive COMPLETES with the stats
      // fallback summary — the transcript is archived and the channel gone.
      const after = env.db.getTicketById(ticket.id);
      assert.equal(after.archived, 1);
      assert.ok(after.transcript_token);
      const stored = JSON.parse(after.ai_summary_json);
      assert.equal(stored.source, "fallback");
    } finally {
      delete process.env.AI_API_KEY;
    }
  });
});
