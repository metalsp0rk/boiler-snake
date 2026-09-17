/**
 * §8.15 task 15.11 — profile hover cards, audit actor names, archive
 * person search + mixed search-bar suggestions (view layer).
 *
 *  1. /g/:guildId/users/:userId/card JSON — known member (name/avatar/role
 *     chips, @everyone excluded), unknown member (known:false + default
 *     avatar + queue warm-up), malformed id 404, anon 302, plain 404.
 *  2. The audit trail renders actor ids as resolved name chips (§8.15-15.11
 *     "actor is not a real username") with data-user-card hooks.
 *  3. Archive search: pure-digit q matches PEOPLE (creator / handling staff
 *     / linked member), and the search bar gains mixed user+role
 *     type-ahead wherever ONE guild is resolved (shell page / guild-filtered
 *     canonical /t — never the cross-guild view).
 *
 * Harness = web-lookups.test.js (real app + SQLite, fake Discord transport).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

const SESSION_SECRET = "test-ucard-11-verylongsecret";

const GUILD_A = "950000000000000001";

const USER_ADMIN = "950000000000000011";
const USER_STAFF = "950000000000000012";
const USER_PLAIN = "950000000000000013";

const USER_KING = "950000000000000031"; // cached: "King Dead"
const USER_OWNER = "950000000000000032"; // cached: "sporky"
const USER_UNKNOWN = "950000000000000033"; // NOT cached → warm-up path

const ROLE_JUNIOR = "ucard-role-junior";
const ROLE_SARAH = "950000000000000041"; // "Mod Sarah"

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];

describe("web profile cards + actor names + person search (§8.15-15.11)", () => {
  let api;
  let cleanup;
  let savedEnv;
  /** @type {import("http").Server} */
  let server;
  let base;
  const cookieOf = {};
  let fetched = []; // ids the background member-fetch tried

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      return [
        {
          id: GUILD_A,
          name: "Alpha HQ",
          icon: null,
          owner: userId === USER_ADMIN,
          permissions: "0",
        },
      ];
    },
    async getUserGuildMember(token, guildId) {
      if (guildId !== GUILD_A) {
        const err = new Error("Unknown Guild");
        err.status = 404;
        throw err;
      }
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
      return { roles: [] };
    },
  };

  const membersCache = new Map([
    [
      USER_KING,
      {
        id: USER_KING,
        displayName: "King Dead",
        user: {
          username: "kingdead",
          tag: "kingdead#0001",
          displayAvatarURL: () => "https://cdn.discordapp.com/avatars/95/kingdead_64.png",
        },
        roles: {
          cache: new Map([
            [GUILD_A, { id: GUILD_A }], // @everyone — must be excluded
            [ROLE_SARAH, { id: ROLE_SARAH }],
          ]),
        },
      },
    ],
    [USER_OWNER, { id: USER_OWNER, displayName: "sporky", roles: { cache: new Map() } }],
  ]);

  const fakeClient = {
    guilds: {
      cache: new Map([
        [
          GUILD_A,
          {
            members: {
              cache: membersCache,
              fetch: async ({ user }) => {
                fetched.push(String(user?.id ?? user));
                const err = new Error("Unknown User");
                err.code = 10007;
                throw err;
              },
            },
            roles: {
              cache: new Map([
                [GUILD_A, { id: GUILD_A, name: "@everyone" }],
                [ROLE_SARAH, { id: ROLE_SARAH, name: "Mod Sarah", hexColor: "#ff5500" }],
              ]),
            },
          },
        ],
      ]),
    },
  };

  let sessionPolicy;
  let tokens;

  function mkSession(userId, { owner = false, perms = "104324673" } = {}) {
    const s = sessionPolicy.createSession({ userId, discordTag: `${userId}#0001` });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: JSON.stringify([
        { id: GUILD_A, name: "Alpha HQ", icon: null, owner, permissions: perms },
      ]),
    });
    return `web_session=${s.id}`;
  }

  async function req(urlPath, cookie) {
    const res = await fetch(`${base}${urlPath}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    return { res, body: await res.text() };
  }

  function seedArchived({ reason, closeReason, creator, owner }) {
    const token = api.generateTranscriptToken();
    const t = api.createTicket({
      guildId: GUILD_A,
      creatorUserId: creator,
      channelId: `ch-${token}`,
      reason,
    });
    if (owner) api.claimTicket(t.id, owner);
    api.markTicketClosed(t.id, { closedBy: USER_ADMIN, closeReason });
    api.closeTicketArchived(t.id, {
      closedBy: USER_ADMIN,
      closeReason,
      transcriptToken: token,
      transcriptPath: `tickets/${token}/index.html`,
    });
    return t;
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
    const loaded = loadDb();
    api = loaded.api;
    cleanup = loaded.cleanup;
    process.env.SESSION_SECRET = SESSION_SECRET;

    const appMod = require("../src/web/app");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");

    api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
    cookieOf.admin = mkSession(USER_ADMIN, { owner: true });
    cookieOf.staff = mkSession(USER_STAFF);
    cookieOf.plain = mkSession(USER_PLAIN, { perms: "0" });

    // audit rows: one human actor (cached), one system origin (no actor)
    api.insertAdminAudit({
      guildId: GUILD_A,
      actorUserId: USER_KING,
      origin: "web",
      action: "xp.grant",
      targetType: "user",
      targetId: USER_OWNER,
      details: { amount: 1 },
    });
    api.insertAdminAudit({
      guildId: GUILD_A,
      actorUserId: null,
      origin: "system",
      action: "decay.tick",
      targetType: "guild",
      targetId: GUILD_A,
      details: {},
    });

    seedArchived({
      reason: "spoon shortage",
      closeReason: "resolved",
      creator: USER_KING,
      owner: USER_OWNER,
    });
    seedArchived({
      reason: "unrelated matter",
      closeReason: "answered",
      creator: USER_PLAIN,
    });

    const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
    const resolver = createGuildAccessResolver({
      discord: fakeDiscord,
      botGuilds: async () => [GUILD_A],
      now: Date.now,
      ttlMs: 60_000,
    });
    server = http.createServer(
      appMod.createWebApp({
        guildAccess: resolver,
        botGuilds: async () => [GUILD_A],
        getClient: () => fakeClient,
      })
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.closeAllConnections?.();
    server?.close();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    cleanup?.();
  });

  // ---- card endpoint --------------------------------------------------------

  it("card: known member → name, avatar, role chips (@everyone excluded)", async () => {
    const { res, body } = await req(`/g/${GUILD_A}/users/${USER_KING}/card`, cookieOf.staff);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const card = JSON.parse(body);
    assert.equal(card.known, true);
    assert.equal(card.name, "King Dead");
    assert.equal(card.tag, "kingdead#0001");
    assert.equal(card.avatar, "https://cdn.discordapp.com/avatars/95/kingdead_64.png");
    assert.deepEqual(card.roles, [{ name: "Mod Sarah", color: "#ff5500" }]);
  });

  it("card: unknown member → known:false + default avatar + warm-up queued", async () => {
    const { res, body } = await req(`/g/${GUILD_A}/users/${USER_UNKNOWN}/card`, cookieOf.staff);
    assert.equal(res.status, 200);
    const card = JSON.parse(body);
    assert.equal(card.known, false);
    const idx = Number((BigInt(USER_UNKNOWN) >> 22n) % 6n);
    assert.equal(card.avatar, `https://cdn.discordapp.com/embed/avatars/${idx}.png`);
    assert.deepEqual(card.roles, []);
    // background queue got the id (lazy-load self-heal, zero fetch here)
    const { queueStats } = require("../src/web/services/memberFetchQueue");
    const pending = queueStats();
    assert.ok(
      (pending[GUILD_A] ?? 0) >= 0, // stats shape sanity
      "queueStats readable"
    );
    // give the 2 s ticker one tick to attempt the fetch
    await new Promise((r) => setTimeout(r, 2600));
    assert.ok(fetched.includes(USER_UNKNOWN), "memberFetchQueue attempted the id");
  });

  it("card: gates — malformed 404, anon 302, no-tier 404", async () => {
    const bad = await req(`/g/${GUILD_A}/users/not-a-snowflake/card`, cookieOf.staff);
    assert.equal(bad.res.status, 404);
    const anon = await req(`/g/${GUILD_A}/users/${USER_KING}/card`);
    assert.equal(anon.res.status, 302);
    const plain = await req(`/g/${GUILD_A}/users/${USER_KING}/card`, cookieOf.plain);
    assert.equal(plain.res.status, 404);
  });

  // ---- audit actor names ----------------------------------------------------

  it("audit trail names the actor (cache-only) and hooks the hover card", async () => {
    const { body } = await req(`/g/${GUILD_A}/audit`, cookieOf.admin);
    assert.match(body, /King Dead/, "actor id resolved to the cached name");
    assert.ok(
      body.includes(`data-user-card="/g/${GUILD_A}/users/${USER_KING}/card"`),
      "actor chip carries the lazy card hook"
    );
    assert.match(body, /—/, "system row (no actor) still renders the em dash");
  });

  // ---- archive person search ------------------------------------------------

  it("archive q: pure digits match creator AND handling staff", async () => {
    const byCreator = await req(`/g/${GUILD_A}/t?q=${USER_KING}`, cookieOf.staff);
    assert.match(byCreator.body, /spoon shortage/, "creator id finds their ticket");

    const byOwner = await req(`/g/${GUILD_A}/t?q=${USER_OWNER}`, cookieOf.staff);
    assert.match(byOwner.body, /spoon shortage/, "staff-owner id finds the handled ticket");

    const miss = await req(`/g/${GUILD_A}/t?q=${USER_UNKNOWN}`, cookieOf.staff);
    assert.doesNotMatch(miss.body, /spoon shortage/, "unrelated id does NOT match");

    const text = await req(`/g/${GUILD_A}/t?q=unrelated`, cookieOf.staff);
    assert.match(text.body, /unrelated matter/, "text search unchanged");
  });

  it("search bar suggestions: shell archive offers mixed users+roles; plain /t does not", async () => {
    const shell = await req(`/g/${GUILD_A}/t`, cookieOf.staff);
    assert.ok(
      shell.body.includes(`data-lookup-roles="/g/${GUILD_A}/lookups/roles"`),
      "in-shell bar gets role suggestions"
    );
    assert.ok(
      shell.body.includes(`data-lookup-users="/g/${GUILD_A}/lookups/users"`),
      "in-shell bar gets people suggestions"
    );

    const filtered = await req(`/t?guild=${GUILD_A}`, cookieOf.admin);
    assert.ok(
      filtered.body.includes(`data-lookup-users="/g/${GUILD_A}/lookups/users"`),
      "guild-filtered canonical /t also suggests"
    );

    const cross = await req(`/t`, cookieOf.admin);
    assert.ok(
      !cross.body.includes("data-lookup-users="),
      "cross-guild /t has NO single-guild suggestions (nothing to resolve against)"
    );
  });

  it("every userRef chip now carries the lazy card hook", () => {
    const { userRef } = require("../src/web/views/components");
    const out = String(userRef(GUILD_A, USER_KING, new Map([[USER_KING, "King Dead"]])));
    assert.ok(out.includes(`href="/g/${GUILD_A}/users/${USER_KING}"`), "profile link kept");
    assert.ok(out.includes(`data-user-card="/g/${GUILD_A}/users/${USER_KING}/card"`));
  });
});
