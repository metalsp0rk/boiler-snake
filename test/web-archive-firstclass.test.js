/**
 * §8.15 "Archive first-class" (v1.19): the /t archive gains search (q),
 * people cells (cache-only names), tier-checked links back into the
 * console, sidebar + dashboard + actions cross-links. Transcript
 * byte-parity is untouched (oracle suite covers it); THIS suite covers the
 * index/console layer around it.
 *
 * Harness = test/web-ux-v1.test.js (real app + SQLite, fake Discord
 * transport, cache-only fake bot client).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

const SESSION_SECRET = "test-arch1-…cret";

const GUILD_A = "730000000000000011"; // the ONLY bot guild
const GUILD_B = "730000000000000012"; // seeded tickets live here too (unreachable)
const ROLE_JUNIOR = "arch1-role-junior";
const ROLE_SENIOR = "arch1-role-senior";

const USER_ADMIN = "830000000000000021";
const USER_STAFF = "830000000000000022";
const USER_SENIOR = "830000000000000023";
const USER_PLAIN = "830000000000000025"; // in the guild, NO staff role ⇒ no tier

const CREATOR_ID = "830000000000000090";
const CREATOR_NAME = "ArchiveCreator";
const OWNER_ID = "830000000000000091";
const OWNER_NAME = "ArchiveOwner";

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];

describe("web archive first-class (§8.15)", () => {
  let api;
  let tmpDir;
  let savedEnv;
  /** @type {import("http").Server} */
  let server;
  let base;
  const cookieOf = {};
  let tSpoon; // reason "spoon shortage"          (guild A)
  let tRules; // reason "discord rules question"  (guild A)
  let tForeign; // reason "spoon orbit"           (guild B — out of scope)

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_NOWHERE) return [];
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
      const userId = String(token).replace(/^tok-/, "");
      if (guildId !== GUILD_A) {
        const err = new Error("Unknown Guild");
        err.status = 404;
        throw err;
      }
      if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
      if (userId === USER_SENIOR) return { roles: [ROLE_SENIOR] };
      return { roles: [] };
    },
  };
  const USER_NOWHERE = "830000000000000024";

  const fakeClient = {
    guilds: {
      cache: new Map([
        [
          GUILD_A,
          {
            members: {
              cache: new Map([
                [CREATOR_ID, { displayName: CREATOR_NAME }],
                [OWNER_ID, { displayName: OWNER_NAME }],
              ]),
            },
          },
        ],
      ]),
    },
  };

  let sessionPolicy;
  let tokens;

  function mkSession(userId) {
    const s = sessionPolicy.createSession({ userId, discordTag: `${userId}#0001` });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: JSON.stringify([
        {
          id: GUILD_A,
          name: "Alpha HQ",
          icon: null,
          owner: userId === USER_ADMIN,
          permissions: userId === USER_ADMIN ? "0" : "104324673",
        },
      ]),
    });
    return s.id;
  }

  function seedArchived(guildId, { reason, closeReason, creator, owner }) {
    const token = api.generateTranscriptToken();
    const t = api.createTicket({
      guildId,
      creatorUserId: creator || USER_STAFF,
      channelId: `ch-${token}`,
      reason,
    });
    // owner column comes from claim (staff_owner_id), not the participant table
    if (owner) api.claimTicket(t.id, owner);
    api.markTicketClosed(t.id, { closedBy: USER_ADMIN, closeReason });
    api.closeTicketArchived(t.id, {
      closedBy: USER_ADMIN,
      closeReason,
      transcriptToken: token,
      // archived=1 requires token AND path (repo contract) — the index
      // only lists; transcript files are never touched by these tests.
      transcriptPath: `tickets/${token}/index.html`,
    });
    return t;
  }

  async function req(urlPath, cookie) {
    const res = await fetch(`${base}${urlPath}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    return { res, body: await res.text() };
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.SESSION_SECRET = SESSION_SECRET;

    const appMod = require("../src/web/app");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");

    api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
    api.addStaffRole(GUILD_A, ROLE_SENIOR, "senior");

    cookieOf.admin = `web_session=${mkSession(USER_ADMIN)}`;
    cookieOf.staff = `web_session=${mkSession(USER_STAFF)}`;
    cookieOf.senior = `web_session=${mkSession(USER_SENIOR)}`;
    cookieOf.nowhere = `web_session=${mkSession(USER_NOWHERE)}`;
    cookieOf.plain = `web_session=${mkSession(USER_PLAIN)}`;

    tSpoon = seedArchived(GUILD_A, {
      reason: "spoon shortage",
      closeReason: "resolved — spork found",
      creator: CREATOR_ID,
      owner: OWNER_ID,
    });
    tRules = seedArchived(GUILD_A, {
      reason: "discord rules question",
      closeReason: "answered in DMs",
    });
    tForeign = seedArchived(GUILD_B, {
      reason: "spoon orbit",
      closeReason: "not our guild",
    });
    // Pagination bulk: 49 more matches in A (1-arg reasons, no digits).
    for (let i = 0; i < 51; i++) {
      seedArchived(GUILD_A, { reason: "matchme alpha", closeReason: "bulk" });
    }

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

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    for (const key of ENV_KEYS) {
      if (savedEnv?.[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv?.[key];
    }
    if (tmpDir) {
      try {
        require("node:fs").rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // ---- sidebar / cross links ------------------------------------------------

  it("sidebar: staff dashboard shows 'Ticket archive' at the in-shell path", async () => {
    const { body } = await req(`/g/${GUILD_A}`, cookieOf.staff);
    assert.match(body, /Ticket archive/);
    assert.ok(body.includes(`/g/${GUILD_A}/t`), "nav + footer use the shell route");
    // dashboard footer link too
    assert.match(body, /Ticket archive →/);
  });

  it("ticket actions page (senior) links to the guild archive", async () => {
    const { res, body } = await req(`/g/${GUILD_A}/tickets`, cookieOf.senior);
    assert.equal(res.status, 200);
    assert.match(body, /Archived tickets →/);
    assert.ok(body.includes(`/g/${GUILD_A}/t`), "link points at the shell archive");
  });

  // ---- console links out of the archive -------------------------------------

  it("staff on guild-filtered archive gets 'Guild dashboard →' (never a 404 link)", async () => {
    const { body } = await req(`/t?guild=${GUILD_A}`, cookieOf.staff);
    assert.ok(body.includes("Guild dashboard →"));
    assert.ok(body.includes(`/g/${GUILD_A}"`));
    assert.ok(!body.includes(`/g/${GUILD_A}/tickets"`), "staff must not get the senior actions link");
  });

  it("senior on guild-filtered archive gets 'Open tickets →'", async () => {
    const { body } = await req(`/t?guild=${GUILD_A}`, cookieOf.senior);
    assert.ok(body.includes("Open tickets →"));
    assert.ok(body.includes(`/g/${GUILD_A}/tickets"`));
  });

  // ---- search ---------------------------------------------------------------

  it("q=spoon narrows to matching rows only", async () => {
    const { body } = await req(`/t?q=spoon`, cookieOf.staff);
    assert.ok(body.includes(`>#${tSpoon.ticket_number}<`), "match present");
    assert.ok(!body.includes(`>#${tRules.ticket_number}<`), "non-match absent");
    assert.ok(body.includes("matching <code>spoon</code>"));
  });

  it("numeric q also matches the ticket NUMBER itself", async () => {
    const { body } = await req(`/t?guild=${GUILD_A}&q=${tRules.ticket_number}`, cookieOf.staff);
    assert.ok(body.includes(`>#${tRules.ticket_number}<`));
    assert.ok(!body.includes(`>#${tSpoon.ticket_number}<`), "spoon row excluded");
  });

  it("q can NEVER widen scope: guild-B-only match stays invisible to guild-A staff", async () => {
    const { body } = await req(`/t?q=orbit`, cookieOf.staff);
    // "orbit" alone appears as the echoed search term — check the row's
    // actual subject text instead.
    assert.ok(!body.includes("spoon orbit"), "foreign row leaked");
    assert.match(body, /No archived transcripts match that search/);
  });

  it("injection-ish q is treated as literal text (escaped, 200, no crash)", async () => {
    const q = encodeURIComponent("' or 1=1 --");
    const { res, body } = await req(`/t?q=${q}`, cookieOf.staff);
    assert.equal(res.status, 200);
    assert.match(body, /No archived transcripts match that search/);
    const xss = encodeURIComponent("<img src=x onerror=1>");
    const r2 = await req(`/t?q=${xss}`, cookieOf.staff);
    assert.equal(r2.res.status, 200);
    assert.ok(!r2.body.includes("<img"), "q is escaped, never live markup");
    assert.ok(r2.body.includes("&lt;img"));
  });

  it("q rides pagination links across both pages (50/page)", async () => {
    const { body } = await req(`/t?q=matchme`, cookieOf.staff);
    assert.ok(body.includes("q=matchme&page=2"), "pager carries q");
    const page2 = await req(`/t?q=matchme&page=2`, cookieOf.staff);
    assert.match(page2.body, /Page 2 \/ 2/);
    // 50 A-side "matchme" seeds total (49) + none elsewhere → exactly 2 pages
    assert.ok(!page2.body.includes("q=matchme&page=3"), "no phantom page 3");
  });

  it("empty q keeps the classic copy; form always present", async () => {
    const { body } = await req(`/t`, cookieOf.staff);
    assert.match(body, /<form class="archive-search"/);
    assert.match(body, /name="q"/);
    assert.ok(!/No archived transcripts match/.test(body), "no search active");
    // guild-filtered form round-trips the guild
    const filtered = await req(`/t?guild=${GUILD_A}`, cookieOf.staff);
    assert.ok(filtered.body.includes(`name="guild" value="${GUILD_A}"`));
  });

  // ---- people cells (cache-only names) ---------------------------------------

  it("people cell: cached creator/owner render display names", async () => {
    const { body } = await req(`/t?q=spoon`, cookieOf.staff);
    assert.ok(body.includes(CREATOR_NAME), "cached creator named");
    assert.ok(body.includes(OWNER_NAME), "cached owner named");
    assert.ok(body.includes(`title="${CREATOR_ID}"`), "id still available as hover text");
  });

  it("dark-ish boot honesty: uncached people render raw ids, row intact", async () => {
    // tRules creator = USER_STAFF — NOT in the fake member cache.
    const { body } = await req(`/t?q=rules`, cookieOf.staff);
    assert.ok(body.includes(USER_STAFF), "raw id shown for uncached creator");
  });

  // ---- in-shell archive: /g/:guildId/t -----------------------------------------

  it("in-shell archive: staff gets 200 WITH sidebar + active nav + rows", async () => {
    const { res, body } = await req(`/g/${GUILD_A}/t`, cookieOf.staff);
    assert.equal(res.status, 200);
    assert.match(body, /<aside class="shell-nav"/, "sidebar renders (the regression)");
    assert.match(body, /aria-current="page"[^>]*>Ticket archive</, "nav marks archive active");
    assert.ok(body.includes("This guild's archive"));
    assert.match(body, /Page 1 \/ 2/, "the guild's rows paginate");
    assert.ok(body.includes(`action="/g/${GUILD_A}/t"`), "search posts to the shell route");
    assert.ok(!body.includes("Guild filter:"), "no redundant filter chrome in-shell");
  });

  it("in-shell search: narrows, escapes, and never crosses guilds", async () => {
    const { body } = await req(`/g/${GUILD_A}/t?q=spoon`, cookieOf.staff);
    assert.ok(body.includes("matching <code>spoon</code>"));
    assert.ok(!body.includes(`>#${tRules.ticket_number}<`), "non-match excluded");
    // ticket numbers are PER GUILD (guild B's first ticket is also #1) —
    // scope must be proven on content, not on the number.
    assert.ok(!body.includes("orbit"), "guild-B row leaked into guild-A archive");
    const inj = await req(
      `/g/${GUILD_A}/t?q=${encodeURIComponent("' or 1=1 --")}`,
      cookieOf.staff
    );
    assert.equal(inj.res.status, 200);
    assert.match(inj.body, /No archived transcripts match that search/);
    const xss = await req(
      `/g/${GUILD_A}/t?q=${encodeURIComponent("<img src=x onerror=1>")}`,
      cookieOf.staff
    );
    assert.ok(!xss.body.includes("<img"), "escaped, never live markup");
  });

  it("in-shell people cells: cached names with ids as hover text", async () => {
    const { body } = await req(`/g/${GUILD_A}/t?q=spoon`, cookieOf.staff);
    assert.ok(body.includes(CREATOR_NAME));
    assert.ok(body.includes(OWNER_NAME));
    assert.ok(body.includes(`title="${CREATOR_ID}"`));
  });

  it("in-shell pagination rides q (50/page)", async () => {
    const { body } = await req(`/g/${GUILD_A}/t?q=matchme`, cookieOf.staff);
    assert.ok(body.includes("q=matchme&page=2"));
    const p2 = await req(`/g/${GUILD_A}/t?q=matchme&page=2`, cookieOf.staff);
    assert.match(p2.body, /Page 2 \/ 2/);
  });

  it("in-shell gates: plain user 404 (no tier), anon 302 to login", async () => {
    const anon = await fetch(`${base}/g/${GUILD_A}/t`, { redirect: "manual" });
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get("location") || "", /^\/auth\/login/);
    const plain = await req(`/g/${GUILD_A}/t`, cookieOf.plain);
    assert.equal(plain.res.status, 404);
    assert.equal(plain.body, "Not found");
  });

  // ---- untouched gates --------------------------------------------------------

  it("anon archive still 302s to login (gate unchanged)", async () => {
    const { res } = await req(`/t?q=spoon`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/auth/login");
  });

  it("no-staff session: archive index renders empty, scoped, 200", async () => {
    const { res, body } = await req(`/t`, cookieOf.nowhere);
    assert.equal(res.status, 200);
    assert.match(body, /No archived transcripts yet\./);
    assert.ok(!body.includes(`>#${tSpoon.ticket_number}<`));
  });
});
