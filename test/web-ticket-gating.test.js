/**
 * Subtask 12 — §8.4 ticket transcript access matrix (Phase 0c).
 * FULLY OFFLINE: real SQLite (temp DB), fake Discord for the REAL
 * createGuildAccessResolver (no shortcuts around the tier math), real
 * createWebApp + fetch on an ephemeral port, node --test only (§8.11).
 *
 * Coverage (design §8.4 / §8.8 "Staff, each participant class, and stranger
 * all tested per transcript; index guild-scoped; sensitive tickets 404"):
 *  A. pure isTicketParticipant unit (creator short-circuit, each table,
 *     junk guards, lookup failure surfaces to the caller);
 *  B. createTicketAccessResolver composition unit (staff hit skips
 *     participant reads; re-auth pass-through; deny→participant fallback;
 *     lookup throw fails CLOSED);
 *  C. HTTP matrix over the real stack:
 *     - anonymous (index aliases, transcript, asset) → 302 /auth/login;
 *     - staff tier via a real staff_roles row → 200;
 *     - admin SNAPSHOT FAST PATH (owner, member fetch 404s) → 200 with
 *       ZERO member calls;
 *     - every §8.4 participant class (creator / ticket_members /
 *       ticket_staff / message author) → 200 WITHOUT any guild access;
 *     - stranger with a valid session → generic 404 (never 403, §8.6);
 *     - in-guild member without a staff role → generic 404;
 *     - cross-guild probe: guild-A session + guild-B transcript with a
 *       VALID uuid → 404; ?guild=B ignored by the index (§8.4 rule 3);
 *     - index guild-scoped: only staffed-guild rows; ?guild=A honored;
 *     - logged-in non-staff → EMPTY index (deliberate choice: the scoped
 *       default, not a redirect);
 *     - re-auth session (corrupt AT) → login redirect, not 404/200;
 *     - sensitive tickets: archived=0 w/ token → 404 even for staff;
 *       closeTicketSensitive → token cleared → 404 for the creator;
 *       neither ever appears in the index;
 *     - assets inherit the transcript's gate exactly (§8.4).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const path = require("path");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// loadDb FIRST: fresh SQLite + reset of the src require cache, then every
// require below binds to that DB (same pattern as web-tier-middleware.test.js).
const { api, tmpDir } = loadDb();

const {
  createGuildAccessResolver,
} = require("../src/web/auth/guildAccess");
const {
  isTicketParticipant,
  createTicketAccessResolver,
} = require("../src/web/auth/participants");
const { createWebApp } = require("../src/web/app");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const {
  writeTranscriptFile,
  absoluteAssetsDir,
} = require("../src/features/tickets/transcript");

// Clearly-fake placeholders only (AGENTS.md: never real-looking secrets).
const SESSION_SECRET = "test-gat…l-xyz";

const GUILD_A = "100000000000000001"; // served by the bot; staff fixtures here
const GUILD_B = "200000000000000002"; // exists in fixtures, NEVER in A-users' lists
const ROLE_STAFF_A = "500000000000000011";

const USER_ADMIN = "428190112345678901"; // owner snapshot ⇒ admin fast path
const USER_STAFF = "428190112345678903"; // staff via staff_roles row (guild A)
const USER_PLAIN = "428190112345678904"; // guild A member, no staff role
const USER_CREATOR = "428190112345678905"; // ticket creator (no guild access)
const USER_MEMBER = "428190112345678906"; // ticket_members row
const USER_TSTAFF = "428190112345678907"; // ticket_staff row
const USER_AUTHOR = "428190112345678908"; // ticket_messages.author_id
const USER_STRANGER = "428190112345678909"; // valid session, no part, no guild
const USER_BROKEN = "428190112345678910"; // corrupt AT ⇒ re-auth

const ENV_KEYS = [
  "SESSION_SECRET",
  "CLIENT_SECRET",
  "PUBLIC_BASE_URL",
  "PUBLIC_HTTP_PORT",
  "TICKET_HTTP_PORT",
  "TICKET_PUBLIC_BASE_URL",
  "WEB_TIER_CACHE_TTL_MS",
];
let savedEnv;

/**
 * Fixture state: the fake Discord counts member fetches so the admin
 * snapshot fast path is PROVABLY member-read-free (§8.3 fast path).
 */
const discordState = { memberCalls: 0, guildsCalls: 0 };

const fakeDiscord = {
  async getUserGuilds(token) {
    discordState.guildsCalls += 1;
    const userId = String(token).replace(/^tok-/, "");
    if (userId === USER_ADMIN) {
      return [{ id: GUILD_A, name: "A", icon: null, owner: true, permissions: "0" }];
    }
    if (userId === USER_STAFF || userId === USER_PLAIN) {
      return [{ id: GUILD_A, name: "A", icon: null, owner: false, permissions: "0" }];
    }
    return []; // participants & stranger: member of NOTHING (still §8.4 readers)
  },
  async getUserGuildMember(token, guildId) {
    discordState.memberCalls += 1;
    const userId = String(token).replace(/^tok-/, "");
    if (guildId === GUILD_A && userId === USER_STAFF) {
      return { roles: [ROLE_STAFF_A] };
    }
    if (guildId === GUILD_A && userId === USER_PLAIN) {
      return { roles: [] };
    }
    const err = new Error("Unknown Guild");
    err.status = 404;
    throw err;
  },
};

before(() => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.SESSION_SECRET = SESSION_SECRET;
  delete process.env.CLIENT_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_HTTP_PORT;
  delete process.env.TICKET_HTTP_PORT;
  delete process.env.TICKET_PUBLIC_BASE_URL;
  delete process.env.WEB_TIER_CACHE_TTL_MS;
  // REAL staff_roles row: the staff-tier leg of §8.4 resolves through the
  // same memberHasStaffRole predicate the slash gates use (§8.1-5).
  api.addStaffRole(GUILD_A, ROLE_STAFF_A, "junior");
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv?.[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try {
    api.removeStaffRole(GUILD_A, ROLE_STAFF_A);
  } catch {
    /* db may be gone already */
  }
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// Fixture helpers (shared by the HTTP suite)
// ---------------------------------------------------------------------------

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Real session row + encrypted AT + guild snapshot (tier-test pattern). */
function mkSession(userId, { corrupt = false } = {}) {
  const s = sessionPolicy.createSession({ userId });
  api.setWebSessionAuth(s.id, {
    accessTokenEnc: corrupt
      ? "v1.junk.junk.junk"
      : tokens.encryptAccessToken(`tok-${userId}`),
    tokenExpiresAt: Date.now() + 3_600_000,
    scopes: "identify guilds guilds.members.read",
    guildSnapshot: JSON.stringify([
      {
        id: GUILD_A,
        name: "A",
        icon: null,
        owner: userId === USER_ADMIN,
        permissions: "0",
      },
    ]),
  });
  return s.id;
}

/** Create + archive a ticket with a real transcript file (and asset). */
function archiveTicket({ guildId, creatorUserId, channelId, reason, withAsset }) {
  const token = api.generateTranscriptToken();
  const ticket = api.createTicket({ guildId, creatorUserId, channelId, reason });
  const written = writeTranscriptFile(
    { ...ticket, close_reason: "done", closed_at: Date.now() },
    token,
    [
      {
        message_id: "m-fix",
        author_id: creatorUserId,
        author_tag: "fixture",
        content: "hello participant net",
        attachment_urls: withAsset
          ? [{ href: `/t/${token}/assets/001_photo.png`, name: "photo.png", kind: "image" }]
          : [],
        sent_at: Date.now(),
      },
    ]
  );
  if (withAsset) {
    const dir = absoluteAssetsDir(guildId, token);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "001_photo.png"), PNG);
  }
  api.markTicketClosed(ticket.id, { closedBy: "mod", closeReason: "done" });
  api.closeTicketArchived(ticket.id, {
    closedBy: "mod",
    closeReason: "done",
    transcriptToken: token,
    transcriptPath: written.relativePath,
  });
  return { token, ticket: api.getTicketById(ticket.id) };
}

// ===========================================================================
// A. isTicketParticipant — pure §8.4 participant decision
// ===========================================================================
describe("isTicketParticipant (pure)", () => {
  const calls = [];
  const lookups = (over = {}) => ({
    hasTicketMember: (id, u) => (calls.push("member"), over.member === true),
    hasTicketStaff: (id, u) => (calls.push("staff"), over.staff === true),
    hasTicketMessageAuthor: (id, u) =>
      (calls.push("author"), over.author === true),
    ...over.extra,
  });

  it("creator_user_id matches WITHOUT touching any lookup", () => {
    calls.length = 0;
    assert.equal(
      isTicketParticipant({ id: 1, creator_user_id: "u1" }, "u1", lookups()),
      true
    );
    assert.deepEqual(calls, [], "creator hit must short-circuit before queries");
  });

  it("each table class matches with §8.4 short-circuit order", () => {
    calls.length = 0;
    assert.equal(
      isTicketParticipant({ id: 2, creator_user_id: "x" }, "u2", lookups({ member: true })),
      true
    );
    assert.deepEqual(calls, ["member"]);

    calls.length = 0;
    assert.equal(
      isTicketParticipant({ id: 3, creator_user_id: "x" }, "u3", lookups({ staff: true })),
      true
    );
    assert.deepEqual(calls, ["member", "staff"]);

    calls.length = 0;
    assert.equal(
      isTicketParticipant({ id: 4, creator_user_id: "x" }, "u4", lookups({ author: true })),
      true
    );
    assert.deepEqual(calls, ["member", "staff", "author"]);
  });

  it("none of the four ⇒ false after consulting all tables", () => {
    calls.length = 0;
    assert.equal(
      isTicketParticipant({ id: 5, creator_user_id: "x" }, "u5", lookups()),
      false
    );
    assert.deepEqual(calls, ["member", "staff", "author"]);
  });

  it("junk guards: null row, no user id, non-numeric row id ⇒ false, no queries", () => {
    calls.length = 0;
    assert.equal(isTicketParticipant(null, "u", lookups()), false);
    assert.equal(isTicketParticipant({ id: 9, creator_user_id: "c" }, null, lookups()), false);
    assert.equal(isTicketParticipant({ id: 9, creator_user_id: "c" }, "", lookups()), false);
    assert.equal(isTicketParticipant({ creator_user_id: "c" }, "u", lookups()), false);
    assert.deepEqual(calls, []);
    // String row ids normalize (rows come back INTEGERs, but never assume).
    assert.equal(
      isTicketParticipant({ id: "7", creator_user_id: "x" }, "u7", lookups({ member: true })),
      true
    );
  });
});

// ===========================================================================
// B. createTicketAccessResolver — §8.4 staff-OR-participant composition
// ===========================================================================
describe("createTicketAccessResolver (composition)", () => {
  const row = (over = {}) => ({
    id: 42,
    guild_id: GUILD_A,
    creator_user_id: "creator-1",
    ...over,
  });

  it("staff+ tier wins immediately — participant tables never consulted", async () => {
    let participantQueries = 0;
    const ra = createTicketAccessResolver({
      guildAccess: { resolve: async () => ({ status: "ok", tier: "senior" }) },
      lookups: {
        hasTicketMember: () => (participantQueries += 1),
        hasTicketStaff: () => (participantQueries += 1),
        hasTicketMessageAuthor: () => (participantQueries += 1),
      },
    });
    const d = await ra.resolveTicketAccess({ id: "s", userId: "anyone" }, row());
    assert.deepEqual(
      { allowed: d.allowed, via: d.via, tier: d.tier },
      { allowed: true, via: "staff", tier: "senior" }
    );
    assert.equal(participantQueries, 0, "staff hit must not query participant tables");
  });

  it("re-auth from the guild resolver passes through (route redirects)", async () => {
    for (const status of ["reauth", "anon"]) {
      const ra = createTicketAccessResolver({
        guildAccess: { resolve: async () => ({ status }) },
      });
      const d = await ra.resolveTicketAccess({ id: "s", userId: "u" }, row());
      assert.deepEqual(
        { allowed: d.allowed, via: d.via, staffStatus: d.staffStatus },
        { allowed: false, via: null, staffStatus: status }
      );
    }
  });

  it("staff deny still consults §8.4 participants (leave-the-guild reader)", async () => {
    const ra = createTicketAccessResolver({
      guildAccess: { resolve: async () => ({ status: "deny", reason: "not_in_access_list" }) },
      lookups: {
        hasTicketMember: () => true,
        hasTicketStaff: () => false,
        hasTicketMessageAuthor: () => false,
      },
    });
    const d = await ra.resolveTicketAccess({ id: "s", userId: "u" }, row());
    assert.deepEqual({ allowed: d.allowed, via: d.via }, { allowed: true, via: "participant" });
  });

  it("resolver throw ⇒ staff deny + participant still checked; lookup throw fails CLOSED", async () => {
    const ra1 = createTicketAccessResolver({
      guildAccess: {
        resolve: async () => {
          throw new Error("store exploded");
        },
      },
      lookups: {
        hasTicketMember: () => true,
        hasTicketStaff: () => false,
        hasTicketMessageAuthor: () => false,
      },
    });
    const d1 = await ra1.resolveTicketAccess({ id: "s", userId: "u" }, row());
    assert.equal(d1.allowed, true, "even a broken staff leg cannot revoke §8.4 rights");

    const ra2 = createTicketAccessResolver({
      guildAccess: { resolve: async () => ({ status: "deny", reason: "no_tier" }) },
      lookups: {
        hasTicketMember: () => {
          throw new Error("db exploded");
        },
        hasTicketStaff: () => false,
        hasTicketMessageAuthor: () => false,
      },
    });
    const d2 = await ra2.resolveTicketAccess({ id: "s", userId: "u" }, row());
    assert.equal(d2.allowed, false, "lookup outage must fail CLOSED (§8.7)");
  });

  it("no session ⇒ anon; factory rejects a missing guildAccess", async () => {
    const ra = createTicketAccessResolver({
      guildAccess: { resolve: async () => ({ status: "ok", tier: "staff" }) },
    });
    const d = await ra.resolveTicketAccess(null, row());
    assert.deepEqual({ allowed: d.allowed, staffStatus: d.staffStatus }, { allowed: false, staffStatus: "anon" });
    assert.throws(() => createTicketAccessResolver({}), TypeError);
  });
});

// ===========================================================================
// C. HTTP matrix over the real stack (§8.11 access-matrix suite)
// ===========================================================================
describe("ticket routes over HTTP (§8.4 matrix)", () => {
  /** @type {import("http").Server} */
  let server;
  /** @type {string} */
  let base;

  const cookies = {};
  let tokenA; // guild A, participants wired
  let tokenB; // guild B — cross-guild probe target
  let tokenSens; // token kept but archived=0 + is_sensitive=1
  let sensClosedTokenWas; // sensitive ticket closed via closeTicketSensitive

  before(async () => {
    // REAL resolver, fake Discord transport, bot serves ONLY guild A (§8.3
    // row 1 — guild B can never enter any A-session's access list).
    const resolver = createGuildAccessResolver({
      discord: fakeDiscord,
      botGuilds: async () => [GUILD_A],
      ttlMs: 60_000,
    });
    const app = createWebApp({ guildAccess: resolver });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    for (const [key, userId] of Object.entries({
      admin: USER_ADMIN,
      staff: USER_STAFF,
      plain: USER_PLAIN,
      creator: USER_CREATOR,
      member: USER_MEMBER,
      tstaff: USER_TSTAFF,
      author: USER_AUTHOR,
      stranger: USER_STRANGER,
      broken: USER_BROKEN,
    })) {
      cookies[key] = `web_session=${mkSession(userId, { corrupt: key === "broken" })}`;
    }

    // --- guild A ticket with every §8.4 participant class -----------------
    const a = archiveTicket({
      guildId: GUILD_A,
      creatorUserId: USER_CREATOR,
      channelId: "ch-gate-a",
      reason: "participant matrix",
      withAsset: true,
    });
    tokenA = a.token;
    api.addTicketMember(a.ticket.id, USER_MEMBER, USER_ADMIN);
    api.addTicketStaff(a.ticket.id, USER_TSTAFF, USER_ADMIN);
    api.saveTicketMessages(a.ticket.id, [
      {
        message_id: "msg-author-1",
        author_id: USER_AUTHOR,
        author_tag: "speaker",
        content: "I only spoke here",
        sent_at: Date.now(),
      },
    ]);

    // --- guild B ticket (foreign guild for every fixture session) ---------
    tokenB = archiveTicket({
      guildId: GUILD_B,
      creatorUserId: "u-b-creator",
      channelId: "ch-gate-b",
      reason: "cross-guild probe",
      withAsset: false,
    }).token;

    // --- sensitive fixtures ------------------------------------------------
    // (a) token present but archived=0 (never content-archived — the route
    //     archive gate 404s it BEFORE any access decision, §8.4 unchanged).
    const sens = archiveTicket({
      guildId: GUILD_A,
      creatorUserId: "u-sens",
      channelId: "ch-gate-sens",
      reason: "sensitive metadata-only",
      withAsset: false,
    });
    tokenSens = sens.token;
    api.db
      .prepare(`UPDATE tickets SET archived=0, is_sensitive=1 WHERE id=?`)
      .run(sens.ticket.id);

    // (b) the REAL sensitive close path: transcript token is CLEARED by
    //     closeTicketSensitive ⇒ the token URL cannot resolve at all.
    const sens2 = api.createTicket({
      guildId: GUILD_A,
      creatorUserId: USER_CREATOR, // creator cookie must STILL get 404
      channelId: "ch-gate-sens2",
      reason: "sensitive closed",
    });
    sensClosedTokenWas = (() => {
      api.db
        .prepare(`UPDATE tickets SET transcript_token=? WHERE id=?`)
        .run(api.generateTranscriptToken(), sens2.id);
      const t = api.getTicketById(sens2.id);
      api.markTicketClosed(sens2.id, { closedBy: "mod" });
      api.closeTicketSensitive(sens2.id, { closedBy: "mod" });
      return t.transcript_token;
    })();
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
  });

  /** @param {string} pathName @param {{cookie?: string, method?: string}} [opts] */
  async function req(pathName, opts = {}) {
    const res = await fetch(`${base}${pathName}`, {
      method: opts.method || "GET",
      redirect: "manual",
      headers: opts.cookie ? { cookie: opts.cookie } : undefined,
    });
    const body = await res.text();
    return { res, body };
  }
  const cookieFor = (key) => ({ cookie: cookies[key] });

  // -- anonymous (§8.1-3 login-mandatory) -----------------------------------

  it("anonymous: index aliases, transcript and asset all 302 to /auth/login", async () => {
    for (const pathName of [
      "/",
      "/t",
      "/t/",
      `/t/${tokenA}`,
      `/t/${tokenA}/assets/001_photo.png`,
    ]) {
      const { res, body } = await req(pathName);
      assert.equal(res.status, 302, `${pathName}`);
      assert.equal(res.headers.get("location"), "/auth/login");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(body, "", "no content leaks pre-login (§8.4)");
    }
  });

  it("broken session (corrupt AT): transcript AND index redirect to re-auth", async () => {
    for (const pathName of [`/t/${tokenA}`, "/t", "/"]) {
      const { res } = await req(pathName, cookieFor("broken"));
      assert.equal(res.status, 302, `${pathName} re-auth redirect`);
      assert.equal(res.headers.get("location"), "/auth/login");
    }
  });

  // -- staff+ tier ------------------------------------------------------------

  it("staff tier via a real staff_roles row → 200 with the transcript bytes", async () => {
    const { res, body } = await req(`/t/${tokenA}`, cookieFor("staff"));
    assert.equal(res.status, 200);
    assert.match(body, /hello participant net/);
    assert.equal(res.headers.get("cache-control"), "private, max-age=300");
  });

  it("admin snapshot FAST PATH → 200 with ZERO member fetches (§8.3)", async () => {
    const before = discordState.memberCalls;
    const { res, body } = await req(`/t/${tokenA}`, cookieFor("admin"));
    assert.equal(res.status, 200);
    assert.match(body, /Ticket #/);
    assert.equal(
      discordState.memberCalls,
      before,
      "owner snapshot resolves staff without guilds.members.read"
    );
  });

  // -- §8.4 participant classes (NO guild access at all) ---------------------

  for (const [label, key] of [
    ["creator (tickets.creator_user_id)", "creator"],
    ["ticket_members member", "member"],
    ["ticket_staff named staff", "tstaff"],
    ["ticket_messages author", "author"],
  ]) {
    it(`participant class ${label} → 200 without any guild access`, async () => {
      const { res, body } = await req(`/t/${tokenA}`, cookieFor(key));
      assert.equal(res.status, 200, `${label}: UUID + session is enough (§8.4)`);
      assert.match(body, /hello participant net/);
    });
  }

  it("participants also get the transcript's ASSETS (gate inherited, §8.4)", async () => {
    const { res } = await req(`/t/${tokenA}/assets/001_photo.png`, cookieFor("member"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "private, max-age=86400");
  });

  it("HEAD by a participant: 200, framing headers, empty body", async () => {
    const { res, body } = await req(`/t/${tokenA}`, { ...cookieFor("creator"), method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(body, "");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  // -- denials: the generic 404, never 403 (§8.6 cross-cutting) ---------------

  it("stranger WITH a valid session → generic 404 (UUID knowledge is not a key)", async () => {
    const { res, body } = await req(`/t/${tokenA}`, cookieFor("stranger"));
    assert.equal(res.status, 404);
    assert.equal(body, "Not found");
  });

  it("in-guild member WITHOUT a staff role → generic 404 (index-tier rule)", async () => {
    const { res, body } = await req(`/t/${tokenA}`, cookieFor("plain"));
    assert.equal(res.status, 404);
    assert.equal(body, "Not found", "indistinguishable from unknown tokens");
  });

  it("asset route for a stranger → 404; assets cannot bypass the transcript gate", async () => {
    const { res } = await req(`/t/${tokenA}/assets/001_photo.png`, cookieFor("stranger"));
    assert.equal(res.status, 404);
  });

  // -- cross-guild probe (§8.6, §8.13-10) ------------------------------------

  it("cross-guild: guild-A sessions hit guild-B transcript with a VALID uuid → 404, never 403/302", async () => {
    for (const key of ["admin", "staff", "plain", "creator", "stranger"]) {
      const { res, body } = await req(`/t/${tokenB}`, cookieFor(key));
      assert.equal(res.status, 404, `${key} cross-guild must 404`);
      assert.equal(body, "Not found", `${key} body`);
    }
  });

  // -- /t index guild scoping --------------------------------------------------

  it("index is guild-scoped to staffed guilds; ?guild=<staffed> honored", async () => {
    const { res, body } = await req("/t", cookieFor("admin"));
    assert.equal(res.status, 200);
    assert.match(body, new RegExp(tokenA), "staffed-guild row renders");
    assert.doesNotMatch(body, new RegExp(tokenB), "foreign-guild row NEVER renders");
    assert.doesNotMatch(body, new RegExp(tokenSens), "sensitive row never renders");

    const scoped = await req(`/t?guild=${GUILD_A}`, cookieFor("staff"));
    assert.equal(scoped.res.status, 200);
    assert.match(scoped.body, /Guild filter/);
    assert.match(scoped.body, new RegExp(tokenA));
  });

  it("?guild=<foreign> is IGNORED (never filtered to the foreign guild, §8.4)", async () => {
    const { res, body } = await req(`/t?guild=${GUILD_B}`, cookieFor("admin"));
    assert.equal(res.status, 200);
    assert.doesNotMatch(body, /Guild filter/, "foreign param must not filter");
    assert.doesNotMatch(body, new RegExp(tokenB), "never the foreign rows");
    assert.match(body, new RegExp(tokenA), "viewer's own scope still renders");
  });

  it("logged-in non-staff sees the EMPTY scoped index (choice: empty, not redirect)", async () => {
    const { res, body } = await req("/t", cookieFor("stranger"));
    assert.equal(res.status, 200, "scoped default — deliberate §8.4 choice");
    assert.match(body, /No archived transcripts/i);
  });

  // -- sensitive tickets (never content-archived ⇒ 404 unchanged, §8.4) -------

  it("sensitive row (token kept, archived=0): 404 even for staff; absent from index", async () => {
    for (const key of ["admin", "staff"]) {
      const { res, body } = await req(`/t/${tokenSens}`, cookieFor(key));
      assert.equal(res.status, 404, `${key} sensitive must 404`);
      assert.equal(body, "Not found");
    }
    const { body: index } = await req("/t", cookieFor("admin"));
    assert.doesNotMatch(index, new RegExp(tokenSens));
  });

  it("closed via closeTicketSensitive: transcript token cleared ⇒ even the creator 404s", async () => {
    assert.ok(sensClosedTokenWas, "fixture had a token before the sensitive close");
    const { res, body } = await req(`/t/${sensClosedTokenWas}`, cookieFor("creator"));
    assert.equal(res.status, 404, "sensitive transcripts never resolve (§8.4)");
    assert.equal(body, "Not found");
  });
});
