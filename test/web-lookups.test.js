/**
 * §8.15 task 15.10 — identifier type-ahead + tolerant parsers.
 *
 * Covers three layers:
 *  1. shared/discordInput unit rules (mentions, unique role names, ranking);
 *  2. the read-only JSON lookups (gates = every other /g page; cache-only
 *     sources; exact-id answers even cold; everyone never suggested);
 *  3. end-to-end WRITE tolerance through the real routes: grant accepts a
 *     pasted <@…> mention (digits hit awardXp), staff role add accepts a
 *     unique NAME or <@&…> mention, ambiguous names/everyone refused.
 * Plus: /users name search (cache ids → tracked rows only) and the app.js
 * enhancement pins (no innerHTML — suggestions are textContent-built).
 *
 * Harness: same as web-archive-firstclass (real app + SQLite, fake Discord
 * transport, fake bot client with member/role caches).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

const SESSION_SECRET = "test-lkp-10-averylongtestsecret";

const GUILD_A = "940000000000000001"; // the only bot guild
const GUILD_CROSS = "940000000000000002";

const USER_ADMIN = "940000000000000011";
const USER_STAFF = "940000000000000012";
const USER_PLAIN = "940000000000000013";

const USER_KING = "940000000000000031"; // cached member "King Dead"
const USER_SPORE = "940000000000000032"; // cached member "sporky" (tracked)
const USER_UNTRACKED = "940000000000000033"; // cached member "Ghosty" (NOT tracked)

const ROLE_JUNIOR = "lkp10-role-junior";
const ROLE_SARAH = "940000000000000041"; // role "Mod Sarah"
const ROLE_DUP1 = "940000000000000042"; // role "Duplicate"
const ROLE_DUP2 = "940000000000000043"; // role "Duplicate" (ambiguity)

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];

// ---------------------------------------------------------------------------
// 1. Unit layer: shared parsers (pure, no boot)
// ---------------------------------------------------------------------------

describe("discordInput parsers (§8.15-15.10)", () => {
  const {
    normalizeUserId,
    normalizeRoleRef,
    findRoleIdByName,
    rankSuggestions,
  } = require("../src/web/routes/shared/discordInput");

  it("user fields: plain id passes, mentions unwrap, junk refused", () => {
    assert.equal(normalizeUserId(USER_KING), USER_KING);
    assert.equal(normalizeUserId(` <@${USER_KING}> `), USER_KING);
    assert.equal(normalizeUserId(`<@!${USER_KING}>`), USER_KING);
    assert.equal(normalizeUserId("not-an-id"), null);
    assert.equal(normalizeUserId("<@&940000000000000041>"), null); // role mention ≠ user
    assert.equal(normalizeUserId(""), null);
    assert.equal(normalizeUserId(null), null);
  });

  it("role refs split into id vs name before any lookup", () => {
    assert.deepEqual(normalizeRoleRef(ROLE_SARAH), { kind: "id", value: ROLE_SARAH });
    assert.deepEqual(normalizeRoleRef(`<@&${ROLE_SARAH}>`), { kind: "id", value: ROLE_SARAH });
    assert.deepEqual(normalizeRoleRef(" Mod Sarah "), { kind: "name", value: "Mod Sarah" });
    assert.equal(normalizeRoleRef(""), null);
  });

  it("role NAME resolution: cache-only, case-insensitive, unique-hit-only", () => {
    const roles = new Map([
      [ROLE_SARAH, { id: ROLE_SARAH, name: "Mod Sarah" }],
      [ROLE_DUP1, { id: ROLE_DUP1, name: "Duplicate" }],
      [ROLE_DUP2, { id: ROLE_DUP2, name: "Duplicate" }],
    ]);
    const getClient = () => ({ guilds: { cache: new Map([["9", { roles: { cache: roles } }]]) } });
    assert.equal(findRoleIdByName(getClient, "9", "mod sarah"), ROLE_SARAH);
    assert.equal(findRoleIdByName(getClient, "9", "Duplicate"), null); // ambiguous
    assert.equal(findRoleIdByName(getClient, "9", "Nope"), null);
    assert.equal(findRoleIdByName(null, "9", "Mod Sarah"), null); // no client
    assert.equal(findRoleIdByName(() => { throw new Error("dead"); }, "9", "x"), null);
  });

  it("suggestions rank exact > prefix > substring; id-only junk drops", () => {
    const items = [
      { id: "1", name: "Mod Sarah" },
      { id: "2", name: "moderator" },
      { id: "3", name: "Admin" },
    ];
    const ranked = rankSuggestions(items, "mod");
    assert.deepEqual(ranked.map((r) => r.id), ["1", "2"]);
    assert.deepEqual(rankSuggestions(items, "zzz"), []);
  });
});

// ---------------------------------------------------------------------------
// 2+3. HTTP integration
// ---------------------------------------------------------------------------

describe("web identifier lookups + tolerant writes (§8.15-15.10)", () => {
  let api;
  let tmpDir;
  let savedEnv;
  let cleanup;
  /** @type {import("http").Server} */
  let server;
  let base;
  const cookieOf = {};
  const csrfOf = {};
  /** @type {Array<object>} awardXp spy calls */
  const grantCalls = [];

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

  const fakeClient = {
    guilds: {
      cache: new Map([
        [
          GUILD_A,
          {
            members: {
              cache: new Map([
                [USER_KING, { id: USER_KING, displayName: "King Dead" }],
                [USER_SPORE, { id: USER_SPORE, displayName: "sporky" }],
                [USER_UNTRACKED, { id: USER_UNTRACKED, displayName: "Ghosty" }],
              ]),
            },
            roles: {
              cache: new Map([
                [GUILD_A, { id: GUILD_A, name: "@everyone" }],
                [ROLE_SARAH, { id: ROLE_SARAH, name: "Mod Sarah" }],
                [ROLE_DUP1, { id: ROLE_DUP1, name: "Duplicate" }],
                [ROLE_DUP2, { id: ROLE_DUP2, name: "Duplicate" }],
              ]),
            },
          },
        ],
      ]),
    },
  };

  let sessionPolicy;
  let tokens;
  let csrfMod;

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
    csrfOf[userId] = csrfMod.deriveCsrfToken(s.id, SESSION_SECRET);
    return `web_session=${s.id}`;
    // (owner flag lives in the LIVE fake, not the snapshot — tier is
    // resolved against discord; the snapshot is the cold-start fallback.)
  }

  async function req(urlPath, cookie) {
    const res = await fetch(`${base}${urlPath}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    return { res, body: await res.text() };
  }

  async function getJson(urlPath, cookie) {
    const { res, body } = await req(urlPath, cookie);
    return { res, json: JSON.parse(body) };
  }

  async function post(urlPath, { cookie, csrf, fields }) {
    const res = await fetch(`${base}${urlPath}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams({ ...fields, _csrf: csrf }).toString(),
    });
    return { res, location: res.headers.get("location") || "", body: await res.text() };
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;
    cleanup = loaded.cleanup;
    process.env.SESSION_SECRET = SESSION_SECRET;

    const appMod = require("../src/web/app");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");
    csrfMod = require("../src/web/middleware/csrf");

    api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");

    // tracked members: King + sporky have XP rows; Ghosty does NOT.
    api.addXp(GUILD_A, USER_KING, 100);
    api.addXp(GUILD_A, USER_SPORE, 50);

    cookieOf.admin = mkSession(USER_ADMIN, { owner: true });
    cookieOf.staff = mkSession(USER_STAFF);
    cookieOf.plain = mkSession(USER_PLAIN, { perms: "0" });

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
        services: {
          async awardXp(_client, opts) {
            grantCalls.push(opts);
            return { newXp: opts.delta, level: 1 };
          },
        },
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
    void tmpDir;
  });

  // ---- lookups: data shape --------------------------------------------------

  it("roles lookup: substring, case-insensitive, ranked, @everyone excluded", async () => {
    const { res, json } = await getJson(`/g/${GUILD_A}/lookups/roles?q=mod`, cookieOf.staff);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(json.roles, [{ id: ROLE_SARAH, name: "Mod Sarah" }]);

    const dup = await getJson(`/g/${GUILD_A}/lookups/roles?q=duplicate`, cookieOf.staff);
    assert.deepEqual(dup.json.roles.map((r) => r.id), [ROLE_DUP1, ROLE_DUP2]);

    const every = await getJson(`/g/${GUILD_A}/lookups/roles?q=everyone`, cookieOf.staff);
    assert.deepEqual(every.json.roles, []); // @everyone never suggested
  });

  it("users lookup: name from cache; exact id/mention answers even cold", async () => {
    const byName = await getJson(`/g/${GUILD_A}/lookups/users?q=king`, cookieOf.staff);
    assert.equal(byName.res.status, 200);
    assert.deepEqual(byName.json.users, [{ id: USER_KING, name: "King Dead" }]);

    const mention = encodeURIComponent(`<@${USER_UNTRACKED}>`);
    const cold = await getJson(`/g/${GUILD_A}/lookups/users?q=${mention}`, cookieOf.staff);
    assert.equal(cold.json.exact, true);
    assert.deepEqual(cold.json.users, [{ id: USER_UNTRACKED, name: "Ghosty" }]);

    const unknown = await getJson(`/g/${GUILD_A}/lookups/users?q=zzznope`, cookieOf.staff);
    assert.deepEqual(unknown.json.users, []);
    const empty = await getJson(`/g/${GUILD_A}/lookups/users`, cookieOf.staff);
    assert.deepEqual(empty.json.users, []);
  });

  it("lookups gates like every other /g surface: anon 302, plain 404, cross-guild 404", async () => {
    const anon = await req(`/g/${GUILD_A}/lookups/roles?q=mod`);
    assert.equal(anon.res.status, 302);
    assert.match(anon.res.headers.get("location") || "", /\/login/);

    const plain = await req(`/g/${GUILD_A}/lookups/roles?q=mod`, cookieOf.plain);
    assert.equal(plain.res.status, 404);

    const cross = await req(`/g/${GUILD_CROSS}/lookups/roles?q=mod`, cookieOf.staff);
    assert.equal(cross.res.status, 404);
  });

  // ---- tolerant writes ------------------------------------------------------

  it("grant accepts a pasted <@…> mention — digits reach awardXp", async () => {
    const { location } = await post(`/g/${GUILD_A}/xp/grant`, {
      cookie: cookieOf.admin,
      csrf: csrfOf[USER_ADMIN],
      fields: { user_id: `<@${USER_KING}>`, amount: "25", reason: "typed a mention" },
    });
    assert.match(location, /done=/);
    assert.equal(grantCalls.length, 1);
    assert.equal(grantCalls[0].userId, USER_KING);
  });

  it("grant still refuses junk the same way (no mention laundering)", async () => {
    const { location } = await post(`/g/${GUILD_A}/xp/grant`, {
      cookie: cookieOf.admin,
      csrf: csrfOf[USER_ADMIN],
      fields: { user_id: "<@not-a-snowflake>", amount: "25" },
    });
    assert.match(location, /error=invalid_user/);
    assert.equal(grantCalls.length, 1);
  });

  const staffRoleRow = (roleId) =>
    api.db
      .prepare("SELECT * FROM staff_roles WHERE guild_id = ? AND role_id = ?")
      .get(GUILD_A, roleId);

  it("staff role add by unique NAME resolves via cache (case-insensitive)", async () => {
    const { location } = await post(`/g/${GUILD_A}/staff/role/add`, {
      cookie: cookieOf.admin,
      csrf: csrfOf[USER_ADMIN],
      fields: { role_id: "mod sarah", level: "junior" },
    });
    assert.equal(location, `/g/${GUILD_A}/staff`);
    const row = staffRoleRow(ROLE_SARAH);
    assert.ok(row, "row stored under the RESOLVED id");
    assert.equal(row.level, "junior");
  });

  it("staff role add by <@&mention> + refusal cases (ambiguous name, everyone)", async () => {
    await post(`/g/${GUILD_A}/staff/role/add`, {
      cookie: cookieOf.admin,
      csrf: csrfOf[USER_ADMIN],
      fields: { role_id: `<@&${ROLE_DUP1}>`, level: "senior" },
    });
    assert.ok(staffRoleRow(ROLE_DUP1), "mention path stored exact id");

    const dup = await post(`/g/${GUILD_A}/staff/role/add`, {
      cookie: cookieOf.admin,
      csrf: csrfOf[USER_ADMIN],
      fields: { role_id: "duplicate", level: "junior" },
    });
    assert.equal(dup.res.status, 400);
    assert.ok(!staffRoleRow(ROLE_DUP2), "ambiguous name NEVER guesses");

    const everyone = await post(`/g/${GUILD_A}/staff/role/add`, {
      cookie: cookieOf.admin,
      csrf: csrfOf[USER_ADMIN],
      fields: { role_id: `<@&${GUILD_A}>`, level: "junior" },
    });
    assert.equal(everyone.res.status, 400);
    assert.ok(!staffRoleRow(GUILD_A));
  });

  // ---- /users name search ---------------------------------------------------

  it("/users?q=name finds TRACKED members via cache; untracked stay hidden", async () => {
    const hit = await req(`/g/${GUILD_A}/users?q=sporky`, cookieOf.staff);
    assert.equal(hit.res.status, 200);
    assert.match(hit.body, new RegExp(USER_SPORE));

    const ghost = await req(`/g/${GUILD_A}/users?q=ghosty`, cookieOf.staff);
    assert.equal(ghost.res.status, 200);
    assert.doesNotMatch(ghost.body, new RegExp(USER_UNTRACKED)); // not tracked → not listed

    const keep = await req(`/g/${GUILD_A}/users?q=${USER_KING}`, cookieOf.staff);
    assert.match(keep.body, new RegExp(USER_KING)); // numeric path untouched
  });

  // ---- app.js enhancement pins ---------------------------------------------

  it("app.js picker is SSR-safe and XSS-safe by construction", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "../src/web/public/app.js"),
      "utf8"
    );
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(src, /data-lookup-url/); // wired to the endpoint
    assert.match(src, /textContent/); // suggestions are text-only
  });
});
