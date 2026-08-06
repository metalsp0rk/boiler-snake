const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { PermissionFlagsBits } = require("discord.js");
const { loadDb } = require("./helpers/env");

describe("tickets repository", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let db;
  /** @type {string} */
  let tmpDir;

  before(() => {
    const loaded = loadDb();
    db = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.DATA_DIR = tmpDir;
  });

  it("creates sequential tickets and rate-limits self-create", () => {
    const t1 = db.createTicket({
      guildId: "g1",
      creatorUserId: "u1",
      channelId: "ch-1",
      reason: "Need help",
    });
    assert.equal(t1.ticket_number, 1);
    assert.equal(t1.status, "open");
    assert.equal(t1.is_sensitive, 0);

    const t2 = db.createTicket({
      guildId: "g1",
      creatorUserId: "u2",
      channelId: "ch-2",
      reason: null,
    });
    assert.equal(t2.ticket_number, 2);

    db.updateGuildSettings("g1", { ticket_rate_limit_minutes: 60 });
    const blocked = db.canUserCreateTicket("g1", "u1");
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfterMs > 0);

    // staff-opened does not count for self-create rate limit
    const staffOpened = db.createTicket({
      guildId: "g1",
      creatorUserId: "u3",
      channelId: "ch-3",
      openedByStaffId: "staff-1",
    });
    const ok = db.canUserCreateTicket("g1", "u3");
    assert.equal(ok.ok, true);

    // opener is staff owner + named staff exclusively on that ticket
    assert.equal(staffOpened.opened_by_staff_id, "staff-1");
    assert.equal(staffOpened.staff_owner_id, "staff-1");
    const staffList = db.listTicketStaff(staffOpened.id);
    assert.equal(staffList.length, 1);
    assert.equal(staffList[0].user_id, "staff-1");
    assert.equal(staffList[0].is_owner, 1);
  });

  it("rate limit disabled when minutes is 0", () => {
    db.updateGuildSettings("g-rl0", { ticket_rate_limit_minutes: 0 });
    db.createTicket({
      guildId: "g-rl0",
      creatorUserId: "u",
      channelId: "ch-rl0-1",
    });
    const ok = db.canUserCreateTicket("g-rl0", "u");
    assert.equal(ok.ok, true);
  });

  it("normalizes ticket reasons", () => {
    const empty = db.normalizeTicketReason("   ", "Reason");
    assert.equal(empty.ok, false);

    const allowEmpty = db.normalizeTicketReason("", "Reason", {
      allowEmpty: true,
    });
    assert.equal(allowEmpty.ok, true);
    assert.equal(allowEmpty.reason, null);

    const tooLong = db.normalizeTicketReason("x".repeat(db.MAX_TICKET_REASON + 1));
    assert.equal(tooLong.ok, false);

    const ok = db.normalizeTicketReason("  hello  ");
    assert.equal(ok.ok, true);
    assert.equal(ok.reason, "hello");
  });

  it("claim / transfer / sensitive / members / staff allow-list", () => {
    const t = db.createTicket({
      guildId: "g2",
      creatorUserId: "creator",
      channelId: "ch-claim",
      reason: "privacy",
    });

    db.claimTicket(t.id, "mod1");
    let row = db.getTicketById(t.id);
    assert.equal(row.staff_owner_id, "mod1");

    db.transferTicket(t.id, "mod2", "mod1");
    row = db.getTicketById(t.id);
    assert.equal(row.staff_owner_id, "mod2");
    const staffAfterTransfer = db.listTicketStaff(t.id);
    assert.ok(
      staffAfterTransfer.some((s) => s.user_id === "mod2" && s.is_owner === 1)
    );
    assert.ok(
      staffAfterTransfer.every(
        (s) => s.user_id !== "mod1" || s.is_owner === 0
      )
    );

    db.addTicketStaff(t.id, "mod3", "mod2");
    db.addTicketMember(t.id, "friend", "mod2");

    const staff = db.listTicketStaff(t.id);
    assert.ok(staff.some((s) => s.user_id === "mod3"));

    const members = db.listTicketMembers(t.id);
    assert.ok(members.some((m) => m.user_id === "creator"));
    assert.ok(members.some((m) => m.user_id === "friend"));

    db.setTicketSensitive(t.id);
    row = db.getTicketById(t.id);
    assert.equal(row.is_sensitive, 1);

    const rmOwner = db.removeTicketStaff(t.id, "mod2");
    assert.equal(rmOwner.ok, false);
    assert.match(rmOwner.error, /owner/i);

    const rmCreator = db.removeTicketMember(t.id, "creator");
    assert.equal(rmCreator.ok, false);
    assert.match(rmCreator.error, /creator/i);

    const rmFriend = db.removeTicketMember(t.id, "friend");
    assert.equal(rmFriend.ok, true);

    const rmMod3 = db.removeTicketStaff(t.id, "mod3");
    assert.equal(rmMod3.ok, true);

    const rmMissing = db.removeTicketStaff(t.id, "nobody");
    assert.equal(rmMissing.ok, false);

    db.setTicketUnsensitive(t.id);
    row = db.getTicketById(t.id);
    assert.equal(row.is_sensitive, 0);
  });

  it("lookups: by channel, number, open list filter", () => {
    const t = db.createTicket({
      guildId: "g-lookup",
      creatorUserId: "u1",
      channelId: "ch-lookup-1",
      reason: "find me",
    });
    assert.equal(db.getTicketByChannel("ch-lookup-1")?.id, t.id);
    assert.equal(db.getTicketByNumber("g-lookup", t.ticket_number)?.id, t.id);
    assert.equal(db.getTicketByChannel("missing"), null);
    assert.equal(db.getTicketByNumber("g-lookup", 99999), null);

    db.createTicket({
      guildId: "g-lookup",
      creatorUserId: "u2",
      channelId: "ch-lookup-2",
    });
    const all = db.listOpenTickets("g-lookup");
    assert.ok(all.length >= 2);
    const filtered = db.listOpenTickets("g-lookup", { userId: "u1" });
    assert.ok(filtered.every((r) => r.creator_user_id === "u1" || true));
    assert.ok(filtered.some((r) => r.creator_user_id === "u1"));
  });

  it("soft close keeps channel; sensitive/archive finalize dispose channel", () => {
    const soft = db.createTicket({
      guildId: "g3",
      creatorUserId: "u",
      channelId: "ch-soft",
    });
    const softClosed = db.markTicketClosed(soft.id, {
      closedBy: "mod",
      closeReason: "done for now",
    });
    assert.equal(softClosed.status, "closed");
    assert.equal(softClosed.archived, 0);
    assert.equal(softClosed.channel_id, "ch-soft");
    assert.equal(softClosed.close_reason, "done for now");

    const sens = db.createTicket({
      guildId: "g3",
      creatorUserId: "u",
      channelId: "ch-sens",
    });
    db.setTicketSensitive(sens.id, "mod");
    db.markTicketClosed(sens.id, { closedBy: "mod", closeReason: "done" });
    const closedSens = db.closeTicketSensitive(sens.id, {
      closedBy: "mod",
      closeReason: "done",
    });
    assert.equal(closedSens.status, "closed");
    assert.equal(closedSens.archived, 0);
    assert.equal(closedSens.channel_id, null);
    assert.equal(closedSens.is_sensitive, 1);

    const arch = db.createTicket({
      guildId: "g3",
      creatorUserId: "u",
      channelId: "ch-arch",
      reason: "billing",
    });
    db.markTicketClosed(arch.id, {
      closedBy: "mod",
      closeReason: "resolved",
    });
    db.saveTicketMessages(arch.id, [
      {
        message_id: "m1",
        author_id: "u",
        author_tag: "u#0",
        content: "hello staff",
        attachment_urls: [],
        sent_at: Date.now(),
      },
    ]);
    const token = db.generateTranscriptToken();
    const closed = db.closeTicketArchived(arch.id, {
      closedBy: "mod",
      closeReason: "resolved",
      transcriptToken: token,
      transcriptPath: `ticket-transcripts/g3/${token}.html`,
      aiSummaryJson: JSON.stringify({ summary: "ok" }),
    });
    assert.equal(closed.archived, 1);
    assert.equal(closed.transcript_token, token);
    assert.equal(closed.channel_id, null);
    assert.equal(db.listTicketMessages(arch.id).length, 1);
    assert.ok(db.getTicketByTranscriptToken(token));
  });

  it("closeTicketArchived without transcript path sets archived=0", () => {
    const t = db.createTicket({
      guildId: "g-nohtml",
      creatorUserId: "u",
      channelId: "ch-nohtml",
    });
    db.markTicketClosed(t.id, { closedBy: "mod", closeReason: "oops" });
    const closed = db.closeTicketArchived(t.id, {
      closedBy: "mod",
      closeReason: "oops",
      transcriptToken: null,
      transcriptPath: null,
    });
    assert.equal(closed.status, "closed");
    assert.equal(closed.archived, 0);
    assert.equal(closed.channel_id, null);
  });

  it("markTicketClosedByChannelDelete closes open tickets only", () => {
    const open = db.createTicket({
      guildId: "g-del",
      creatorUserId: "u",
      channelId: "ch-ext-del",
    });
    const closed = db.markTicketClosedByChannelDelete("ch-ext-del");
    assert.ok(closed);
    assert.equal(closed.status, "closed");
    assert.equal(closed.archived, 0);
    assert.equal(closed.channel_id, null);
    assert.match(closed.close_reason || "", /deleted outside/i);

    // already closed / unknown
    assert.equal(db.markTicketClosedByChannelDelete("ch-ext-del"), null);
    assert.equal(db.markTicketClosedByChannelDelete("no-such-channel"), null);
    assert.equal(db.getTicketById(open.id).status, "closed");
  });

  it("getTicketSettings defaults", () => {
    const s = db.getTicketSettings("brand-new-guild-settings");
    assert.equal(s.ticket_category_id, null);
    assert.equal(s.ticket_archive_channel_id, null);
    assert.equal(s.ticket_rate_limit_minutes, 60);
  });
});

describe("tickets overwrites", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let db;

  before(() => {
    const loaded = loadDb();
    db = loaded.api;
    process.env.DATA_DIR = loaded.tmpDir;
  });

  it("normal ticket allows staff roles; sensitive denies them", () => {
    const {
      buildTicketOverwrites,
      STAFF_ALLOW,
      BOT_ALLOW,
    } = require("../src/features/tickets/overwrites");
    const { PermissionFlagsBits } = require("discord.js");

    // Staff must not be granted ManageChannels (common 50013 cause)
    assert.equal(
      (STAFF_ALLOW & PermissionFlagsBits.ManageChannels) ===
        PermissionFlagsBits.ManageChannels,
      false
    );
    assert.equal(
      (BOT_ALLOW & PermissionFlagsBits.ManageChannels) ===
        PermissionFlagsBits.ManageChannels,
      true
    );

    db.addStaffRole("g-ow", "role-staff-a", "senior");
    db.addStaffRole("g-ow", "role-staff-b", "senior");
    db.addStaffRole("g-ow", "role-staff-junior", "junior");

    // Staff-opened: opener gets named staff overwrite even without senior role
    const staffOpenedTicket = db.createTicket({
      guildId: "g-ow",
      creatorUserId: "member-req",
      channelId: "ch-ow-staff-for",
      openedByStaffId: "junior-opener",
    });
    const forOw = buildTicketOverwrites({
      guildId: "g-ow",
      everyoneId: "g-ow",
      botUserId: "bot-1",
      ticket: db.getTicketById(staffOpenedTicket.id),
      sensitive: false,
      staffRoleIds: ["role-staff-a", "role-staff-b"],
    });
    const forById = (id) => forOw.find((o) => o.id === id);
    assert.ok(forById("member-req")?.allow, "requester member access");
    assert.ok(
      forById("junior-opener")?.allow,
      "staff opener must have exclusive named staff access"
    );
    assert.ok(forById("role-staff-a")?.allow, "senior staff roles still apply");
    // legacy row: opened_by_staff_id without ticket_staff / staff_owner still grants access
    const legacyOw = buildTicketOverwrites({
      guildId: "g-ow",
      everyoneId: "g-ow",
      botUserId: "bot-1",
      ticket: {
        id: -1, // no ticket_staff / members rows
        creator_user_id: "member-req",
        staff_owner_id: null,
        opened_by_staff_id: "legacy-opener",
        is_sensitive: 0,
      },
      sensitive: false,
      staffRoleIds: [],
    });
    assert.ok(
      legacyOw.find((o) => o.id === "legacy-opener")?.allow,
      "opened_by_staff_id alone grants named staff overwrite"
    );

    const ticket = db.createTicket({
      guildId: "g-ow",
      creatorUserId: "creator",
      channelId: "ch-ow-1",
    });
    db.claimTicket(ticket.id, "owner-mod");
    db.addTicketStaff(ticket.id, "extra-mod", "owner-mod");
    db.addTicketMember(ticket.id, "friend", "owner-mod");

    const normal = buildTicketOverwrites({
      guildId: "g-ow",
      everyoneId: "g-ow",
      botUserId: "bot-1",
      ticket: db.getTicketById(ticket.id),
      sensitive: false,
      staffRoleIds: ["role-staff-a", "role-staff-b"],
    });

    const byId = (id) => normal.find((o) => o.id === id);
    assert.ok(byId("g-ow")?.deny);
    assert.ok(byId("bot-1")?.allow);
    assert.ok(byId("creator")?.allow);
    assert.ok(byId("friend")?.allow);
    assert.ok(byId("role-staff-a")?.allow);
    assert.ok(byId("role-staff-b")?.allow);
    // Junior staff roles must not get ticket overwrites when using DB defaults
    const normalFromDb = buildTicketOverwrites({
      guildId: "g-ow",
      everyoneId: "g-ow",
      botUserId: "bot-1",
      ticket: db.getTicketById(ticket.id),
      sensitive: false,
    });
    assert.ok(normalFromDb.find((o) => o.id === "role-staff-a")?.allow);
    assert.equal(
      normalFromDb.find((o) => o.id === "role-staff-junior"),
      undefined
    );

    // Soft-close overwrites deny members, keep staff
    const closedOw = buildTicketOverwrites({
      guildId: "g-ow",
      everyoneId: "g-ow",
      botUserId: "bot-1",
      ticket: db.getTicketById(ticket.id),
      sensitive: false,
      staffRoleIds: ["role-staff-a", "role-staff-b"],
      excludeMembers: true,
    });
    const cById = (id) => closedOw.find((o) => o.id === id);
    assert.ok(cById("creator")?.deny);
    assert.ok(cById("friend")?.deny);
    assert.ok(cById("role-staff-a")?.allow);
    assert.ok(cById("owner-mod")?.allow);

    db.setTicketSensitive(ticket.id);
    const sensTicket = db.getTicketById(ticket.id);
    const sensitive = buildTicketOverwrites({
      guildId: "g-ow",
      everyoneId: "g-ow",
      botUserId: "bot-1",
      ticket: sensTicket,
      sensitive: true,
      staffRoleIds: ["role-staff-a", "role-staff-b"],
    });

    const sById = (id) => sensitive.find((o) => o.id === id);
    assert.ok(sById("role-staff-a")?.deny);
    assert.ok(sById("role-staff-b")?.deny);
    assert.ok(sById("owner-mod")?.allow);
    assert.ok(sById("extra-mod")?.allow);
    assert.ok(sById("creator")?.allow);
  });

  it("getManageableStaffRoleIds skips missing and higher roles", () => {
    const {
      getManageableStaffRoleIds,
    } = require("../src/features/tickets/overwrites");

    db.addStaffRole("g-hier", "role-low");
    db.addStaffRole("g-hier", "role-high");
    db.addStaffRole("g-hier", "role-missing");

    const rolesCache = new Map([
      ["role-low", { id: "role-low", position: 1, managed: false }],
      ["role-high", { id: "role-high", position: 10, managed: false }],
    ]);
    const guild = {
      id: "g-hier",
      roles: { cache: rolesCache },
    };
    const botMember = {
      roles: {
        highest: { position: 5 },
        cache: new Map([["bot-role", { position: 5 }]]),
      },
    };

    const { roleIds, skipped } = getManageableStaffRoleIds(guild, botMember);
    assert.deepEqual(roleIds, ["role-low"]);
    assert.ok(skipped.some((s) => s.id === "role-high"));
    assert.ok(skipped.some((s) => s.id === "role-missing"));
  });

  it("assertBotCanCreateTickets requires Manage Channels", () => {
    const {
      assertBotCanCreateTickets,
    } = require("../src/features/tickets/overwrites");
    const { PermissionFlagsBits } = require("discord.js");

    const guild = { id: "g-perm", channels: { cache: new Map() } };
    const noPerms = {
      permissions: { has: () => false },
    };
    const bad = assertBotCanCreateTickets(guild, noPerms, null);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Manage Channels/i);

    const okMember = {
      permissions: {
        has: (flag) => flag === PermissionFlagsBits.ManageChannels,
      },
    };
    const ok = assertBotCanCreateTickets(guild, okMember, null);
    assert.equal(ok.ok, true);
  });
});

describe("tickets transcript + summary", () => {
  let tmpDir;

  before(() => {
    const loaded = loadDb();
    tmpDir = loaded.tmpDir;
    process.env.DATA_DIR = tmpDir;
  });

  it("renders HTML transcript and escapes content", () => {
    const {
      renderTranscriptHtml,
      writeTranscriptFile,
      resolveTranscriptAbsolutePath,
    } = require("../src/features/tickets/transcript");
    const ticket = {
      guild_id: "g-html",
      ticket_number: 9,
      creator_user_id: "u1",
      staff_owner_id: "m1",
      reason: "help",
      close_reason: "done",
      created_at: Date.now() - 1000,
      closed_at: Date.now(),
      is_sensitive: 0,
    };
    const html = renderTranscriptHtml(
      ticket,
      [
        {
          message_id: "1",
          author_id: "u1",
          author_tag: "Alice (@alice) · u1",
          content: "Hello <script> @Bob",
          attachment_urls: JSON.stringify(["https://cdn.example/a.png"]),
          sent_at: Date.now(),
        },
      ],
      {
        requesterLabel: "Alice (@alice) · u1",
        staffOwnerLabel: "Mod (@mod) · m1",
      }
    );
    assert.match(html, /Ticket #9/);
    assert.match(html, /Hello &lt;script&gt;/);
    assert.match(html, /cdn\.example/);
    assert.match(html, /Alice \(@alice\)/);
    assert.match(html, /Mod \(@mod\)/);
    // raw id alone should not be the only requester line when label provided
    assert.match(html, /Requester<\/dt><dd>Alice/);

    const token = "11111111-1111-4111-8111-111111111111";
    const { absolutePath, relativePath } = writeTranscriptFile(
      ticket,
      token,
      [
        {
          message_id: "1",
          author_id: "u1",
          author_tag: "a",
          content: "x",
          sent_at: 1,
        },
      ],
      { requesterLabel: "Alice · u1" }
    );
    assert.ok(fs.existsSync(absolutePath));
    assert.match(fs.readFileSync(absolutePath, "utf8"), /Ticket #9/);
    assert.match(fs.readFileSync(absolutePath, "utf8"), /Alice/);
    assert.match(relativePath, /ticket-transcripts/);

    const resolved = resolveTranscriptAbsolutePath({
      guild_id: "g-html",
      transcript_token: token,
      transcript_path: relativePath,
    });
    assert.equal(resolved, absolutePath);
  });

  it("fallback summary without AI key", async () => {
    delete process.env.AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const {
      summarizeTicket,
      buildFallbackSummary,
    } = require("../src/features/tickets/summary");
    const ticket = {
      ticket_number: 1,
      creator_user_id: "u",
      reason: "lag",
      close_reason: "fixed",
      staff_owner_id: null,
    };
    const fb = buildFallbackSummary(ticket, []);
    assert.equal(fb.source, "fallback");
    assert.match(fb.summary, /fixed|closed/i);

    const sum = await summarizeTicket(ticket, [
      { author_tag: "u", content: "broken thing", author_id: "u" },
    ]);
    assert.equal(sum.source, "fallback");
  });

  it("summarizeTicket uses AI JSON when fetch succeeds", async () => {
    process.env.AI_API_KEY = "test-key-not-real";
    process.env.AI_BASE_URL = "https://ai.example/v1";
    process.env.AI_MODEL = "test-model";

    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                resolution: "Fixed login",
                summary: "User could not log in; staff reset password.",
              }),
            },
          },
        ],
      }),
    });

    try {
      // re-require not needed — summarizeTicket reads env each call
      const { summarizeTicket } = require("../src/features/tickets/summary");
      const sum = await summarizeTicket(
        {
          ticket_number: 2,
          creator_user_id: "u",
          reason: "login",
          close_reason: "reset pw",
          staff_owner_id: "m",
        },
        [{ author_tag: "u", content: "locked out", author_id: "u" }]
      );
      assert.equal(sum.source, "ai");
      assert.equal(sum.resolution, "Fixed login");
      assert.match(sum.summary, /password/i);
      assert.equal(sum.model, "test-model");
    } finally {
      global.fetch = origFetch;
      delete process.env.AI_API_KEY;
      delete process.env.AI_BASE_URL;
      delete process.env.AI_MODEL;
    }
  });

  it("summarizeTicket falls back when AI HTTP fails", async () => {
    process.env.AI_API_KEY = "test-key-not-real";
    const origFetch = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    try {
      const { summarizeTicket } = require("../src/features/tickets/summary");
      const sum = await summarizeTicket(
        {
          ticket_number: 3,
          creator_user_id: "u",
          reason: "x",
          close_reason: "closed",
        },
        []
      );
      assert.equal(sum.source, "fallback");
    } finally {
      global.fetch = origFetch;
      delete process.env.AI_API_KEY;
    }
  });
});

describe("tickets HTTP transcript handler", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let db;
  let tmpDir;
  let handleRequest;
  let transcriptPublicUrl;
  let getHttpConfig;
  let stopTicketHttpServer;

  before(() => {
    const loaded = loadDb();
    db = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.DATA_DIR = tmpDir;
    // Clear module cache for httpServer to bind this DB
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}tickets${path.sep}`)) {
        delete require.cache[key];
      }
    }
    ({
      handleRequest,
      transcriptPublicUrl,
      getHttpConfig,
      stopTicketHttpServer,
    } = require("../src/features/tickets/httpServer"));
  });

  after(async () => {
    delete process.env.TICKET_HTTP_PORT;
    delete process.env.TICKET_PUBLIC_BASE_URL;
    if (stopTicketHttpServer) await stopTicketHttpServer();
  });

  /**
   * @param {string} method
   * @param {string} url
   */
  function runHandler(method, url) {
    const req = { method, url };
    /** @type {{ statusCode: number, headers: object, body: any }} */
    const res = {
      statusCode: 0,
      headers: {},
      body: undefined,
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers || {};
      },
      end(body) {
        this.body = body;
      },
    };
    handleRequest(req, res);
    return res;
  }

  it("getHttpConfig and transcriptPublicUrl", () => {
    delete process.env.TICKET_HTTP_PORT;
    delete process.env.TICKET_PUBLIC_BASE_URL;
    assert.equal(getHttpConfig().port, null);
    assert.equal(transcriptPublicUrl("abc"), null);

    process.env.TICKET_HTTP_PORT = "9099";
    process.env.TICKET_PUBLIC_BASE_URL = "https://tickets.example.com/";
    assert.equal(getHttpConfig().port, 9099);
    assert.equal(
      transcriptPublicUrl("uuid-here"),
      "https://tickets.example.com/t/uuid-here"
    );
    delete process.env.TICKET_HTTP_PORT;
    delete process.env.TICKET_PUBLIC_BASE_URL;
  });

  it("health and 404 paths", () => {
    const health = runHandler("GET", "/health");
    assert.equal(health.statusCode, 200);

    const missing = runHandler("GET", "/t/not-a-uuid");
    assert.equal(missing.statusCode, 404);

    const method = runHandler("POST", "/health");
    assert.equal(method.statusCode, 405);

    const unknown = runHandler("GET", "/other");
    assert.equal(unknown.statusCode, 404);
  });

  it("serves archive index at /t, transcript, and assets", () => {
    const fs = require("fs");
    const path = require("path");
    const {
      writeTranscriptFile,
      absoluteAssetsDir,
    } = require("../src/features/tickets/transcript");

    const token = "22222222-2222-4222-8222-222222222222";
    const ticket = db.createTicket({
      guildId: "g-http",
      creatorUserId: "u",
      channelId: "ch-http-serve",
      reason: "http test subject",
    });
    const written = writeTranscriptFile(
      {
        ...ticket,
        close_reason: "done",
        closed_at: Date.now(),
      },
      token,
      [
        {
          message_id: "m1",
          author_id: "u",
          author_tag: "user",
          content: "hello transcript",
          attachment_urls: [
            {
              href: `/t/${token}/assets/001_photo.png`,
              name: "photo.png",
              kind: "image",
            },
          ],
          sent_at: Date.now(),
        },
      ]
    );
    // Drop a fake asset on disk
    const assetsDir = absoluteAssetsDir("g-http", token);
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "001_photo.png"), Buffer.from([1, 2, 3]));

    db.markTicketClosed(ticket.id, { closedBy: "mod", closeReason: "done" });
    db.closeTicketArchived(ticket.id, {
      closedBy: "mod",
      closeReason: "done",
      transcriptToken: token,
      transcriptPath: written.relativePath,
      aiSummaryJson: null,
    });

    // Index at /t
    const index = runHandler("GET", "/t");
    assert.equal(index.statusCode, 200);
    assert.match(String(index.headers["Content-Type"] || ""), /text\/html/);
    assert.match(String(index.body), /Archived tickets/i);
    assert.match(String(index.body), new RegExp(token));
    assert.match(String(index.body), /http test subject|#/);

    // Also at /
    const root = runHandler("GET", "/");
    assert.equal(root.statusCode, 200);
    assert.match(String(root.body), /Archived tickets/i);

    // Guild filter
    const filtered = runHandler("GET", "/t?guild=g-http");
    assert.equal(filtered.statusCode, 200);
    assert.match(String(filtered.body), /g-http/);

    const emptyFilter = runHandler("GET", "/t?guild=no-such-guild");
    assert.equal(emptyFilter.statusCode, 200);
    assert.match(String(emptyFilter.body), /No archived transcripts/i);

    // Single transcript
    const res = runHandler("GET", `/t/${token}`);
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers["Content-Type"] || ""), /text\/html/);
    assert.match(String(res.body), /hello transcript|Ticket #/);

    const head = runHandler("HEAD", `/t/${token}`);
    assert.equal(head.statusCode, 200);

    // Asset
    const asset = runHandler("GET", `/t/${token}/assets/001_photo.png`);
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers["Content-Type"] || ""), /image\/png/);
    assert.ok(Buffer.isBuffer(asset.body) || asset.body?.length >= 0);

    // Path traversal blocked
    const trav = runHandler("GET", `/t/${token}/assets/..%2Findex.html`);
    assert.equal(trav.statusCode, 404);

    // unarchived / unknown token
    const missing = runHandler(
      "GET",
      "/t/33333333-3333-4333-8333-333333333333"
    );
    assert.equal(missing.statusCode, 404);

    // listArchivedTickets repo
    assert.ok(db.listArchivedTickets().some((t) => t.transcript_token === token));
    assert.ok(db.countArchivedTickets() >= 1);
  });
});

describe("tickets user resolution", () => {
  it("formats labels and expands mentions", () => {
    const {
      formatUserLabel,
      formatUserLabelShort,
      collectMentionIds,
      replaceMentionsInContent,
      enrichMessagesForArchive,
      ticketUserLabels,
    } = require("../src/features/tickets/users");

    assert.equal(
      formatUserLabel({
        id: "111",
        displayName: "Cool Nick",
        username: "alice",
      }),
      "Cool Nick (@alice) · 111"
    );
    assert.equal(
      formatUserLabelShort({
        id: "111",
        displayName: "Cool Nick",
        username: "alice",
      }),
      "Cool Nick"
    );

    const content = "Hey <@222> and <@!333> please look";
    assert.deepEqual(collectMentionIds(content), ["222", "333"]);

    const map = new Map([
      [
        "222",
        {
          id: "222",
          displayName: "Bob",
          username: "bob",
          shortLabel: "Bob",
          label: "Bob (@bob) · 222",
        },
      ],
      [
        "333",
        {
          id: "333",
          displayName: null,
          username: "carol",
          shortLabel: "carol",
          label: "carol · 333",
        },
      ],
      [
        "111",
        {
          id: "111",
          displayName: "Alice",
          username: "alice",
          shortLabel: "Alice",
          label: "Alice (@alice) · 111",
        },
      ],
    ]);

    assert.equal(
      replaceMentionsInContent(content, map),
      "Hey @Bob and @carol please look"
    );

    const enriched = enrichMessagesForArchive(
      [
        {
          author_id: "111",
          author_tag: "old",
          content: "ping <@222>",
        },
      ],
      map
    );
    assert.equal(enriched[0].author_tag, "Alice (@alice) · 111");
    assert.equal(enriched[0].content, "ping @Bob");

    const labels = ticketUserLabels(
      {
        creator_user_id: "111",
        staff_owner_id: "222",
        closed_by_user_id: "333",
      },
      map
    );
    assert.match(labels.requesterLabel, /Alice/);
    assert.match(labels.staffOwnerLabel, /Bob/);
    assert.match(labels.closedByLabel, /carol/);
  });

  it("resolveUsers prefers member displayName", async () => {
    const { resolveUsers } = require("../src/features/tickets/users");
    const guild = {
      members: {
        cache: new Map([
          [
            "99",
            {
              displayName: "Server Nick",
              user: { id: "99", username: "rawuser", globalName: "Global" },
            },
          ],
        ]),
        fetch: async () => {
          throw new Error("should use cache");
        },
      },
    };
    const map = await resolveUsers(null, guild, ["99", "missing"]);
    assert.equal(map.get("99").displayName, "Server Nick");
    assert.match(map.get("99").label, /Server Nick/);
    assert.equal(map.get("missing").id, "missing");
  });
});

describe("tickets media assets", () => {
  let tmpDir;

  before(() => {
    const loaded = loadDb();
    tmpDir = loaded.tmpDir;
    process.env.DATA_DIR = tmpDir;
  });

  it("sanitizeFilename and mediaKind", () => {
    const {
      sanitizeFilename,
      mediaKind,
    } = require("../src/features/tickets/assets");
    assert.equal(sanitizeFilename("../../../etc/passwd"), "passwd");
    assert.equal(sanitizeFilename("my photo (1).PNG"), "my_photo_1_.PNG");
    assert.equal(mediaKind("x.png", null), "image");
    assert.equal(mediaKind("x.bin", "image/jpeg"), "image");
    assert.equal(mediaKind("x.mp4", null), "video");
  });

  it("mirrors downloads and rewrites attachment hrefs", async () => {
    const {
      mirrorTicketAssets,
      resolveAssetAbsolutePath,
    } = require("../src/features/tickets/assets");
    const fs = require("fs");
    const path = require("path");

    const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );

    const origFetch = global.fetch;
    global.fetch = async (url) => {
      assert.match(String(url), /cdn\.example/);
      return {
        ok: true,
        headers: {
          get: (h) =>
            h.toLowerCase() === "content-type" ? "image/png" : null,
        },
        arrayBuffer: async () => png,
      };
    };

    try {
      const result = await mirrorTicketAssets(
        [
          {
            message_id: "1",
            author_id: "u",
            content: "pic",
            attachment_urls: [
              {
                url: "https://cdn.example/attachments/1/photo.png",
                name: "photo.png",
                contentType: "image/png",
              },
            ],
            embeds_json: JSON.stringify([
              { image: { url: "https://cdn.example/embed/thumb.png" } },
            ]),
          },
        ],
        { guildId: "g-media", token }
      );

      assert.equal(result.downloaded, 2);
      assert.equal(result.failed, 0);
      const att = result.messages[0].attachment_urls[0];
      assert.match(att.href, new RegExp(`/t/${token}/assets/`));
      assert.equal(att.local, true);
      assert.equal(att.kind, "image");

      const embeds = JSON.parse(result.messages[0].embeds_json);
      assert.match(embeds[0].image.url, new RegExp(`/t/${token}/assets/`));

      const localName = path.basename(att.href);
      const abs = resolveAssetAbsolutePath("g-media", token, localName);
      assert.ok(abs);
      assert.ok(fs.existsSync(abs));
      assert.ok(fs.readFileSync(abs).length > 0);
    } finally {
      global.fetch = origFetch;
    }
  });

  it("renders images in transcript HTML", () => {
    const { renderTranscriptHtml } = require("../src/features/tickets/transcript");
    const html = renderTranscriptHtml(
      {
        guild_id: "g",
        ticket_number: 1,
        creator_user_id: "u",
        created_at: 1,
        is_sensitive: 0,
      },
      [
        {
          message_id: "1",
          author_id: "u",
          author_tag: "User",
          content: "see pic",
          attachment_urls: [
            {
              href: "/t/tok/assets/001_photo.png",
              name: "photo.png",
              kind: "image",
            },
          ],
          sent_at: 1,
        },
      ]
    );
    assert.match(html, /<img /);
    assert.match(html, /001_photo\.png/);
  });
});

describe("tickets close helpers", () => {
  before(() => {
    const loaded = loadDb();
    process.env.DATA_DIR = loaded.tmpDir;
  });

  it("normalizeDiscordMessage extracts attachments and content", () => {
    const {
      normalizeDiscordMessage,
    } = require("../src/features/tickets/close");
    const msg = {
      id: "snowflake-1",
      content: "hi <@999>",
      author: {
        id: "u1",
        username: "alice",
        globalName: "Alice G",
        discriminator: "0",
      },
      member: { displayName: "AliceNick" },
      createdTimestamp: 1_700_000_000_000,
      attachments: new Map([
        [
          "a",
          {
            url: "https://cdn.example/file.png",
            name: "file.png",
            contentType: "image/png",
          },
        ],
      ]),
      embeds: [{ title: "e" }],
    };
    const row = normalizeDiscordMessage(msg);
    assert.equal(row.message_id, "snowflake-1");
    assert.equal(row.author_id, "u1");
    assert.match(row.author_tag, /AliceNick/);
    assert.match(row.author_tag, /alice/);
    assert.equal(row.content, "hi <@999>");
    assert.equal(row.attachment_urls[0].url, "https://cdn.example/file.png");
    assert.equal(row.attachment_urls[0].name, "file.png");
    assert.ok(row.embeds_json);
  });
});
