/**
 * GET /g/:guildId/voice — the Phase 1 staff voice & music view (subtask 21,
 * roadmap web-admin.md §8.6 "Voice & Music: now-playing, queue VIEW only |
 * Staff | none (control out of scope)" + §8.9 + cross-cutting 404 rule +
 * query budget). HTTP-level net test: real Express app on an ephemeral
 * port, REAL SQLite (temp DB, real staff_roles rows, seeded voice_sessions
 * rows via the facade), FAKE Discord through the injected
 * createGuildAccessResolver seam — same harness style as
 * test/web-routes-integrations.test.js.
 *
 * Covers:
 *  - tier matrix: anonymous ⇒ login redirect, stranger ⇒ generic 404,
 *    cross-guild ⇒ the SAME 404 bytes, malformed id ⇒ generic 404,
 *    junior/senior/admin ⇒ 200 (all four sections render);
 *  - seeded voice_sessions rows render user/channel/joined UTC + exact
 *    elapsed minutes (fake clock), guild-scoped (other guild's rows never
 *    leak), voice-XP config row rendered with the /setxp voice govern badge;
 *  - music: NO player ⇒ honest "unavailable" render (never a throw, never a
 *    connection); fake client w/o manager ⇒ "lavalink not configured"; node
 *    down ⇒ "no lavalink node connected"; fake PLAYER OBJECT ⇒ now-playing +
 *    queue rows rendered + escaped + slash-parity truncation; a THROWING
 *    client seam degrades instead of 500ing (§8.9: zero control paths);
 *  - live voice: cache-only snapshot unit checks (AFK/muted/eligible/≥2
 *    earning rules — voice ticker parity), absent client ⇒ "live state
 *    unavailable" on the page;
 *  - XSS probes through session ids + hostile track metadata;
 *  - §8.6 cache budget: uncached build = exactly 2 bounded facade reads + 1
 *    call per runtime provider, ZERO inside the cached window (request path
 *    never fans out per hit), fresh again after expiry;
 *  - read-only (§8.9): POST/PUT/PATCH/DELETE on the path are the app-wide
 *    405; no control GET/POST sub-path exists (404); zero <form>/<button>
 *    inside <main>.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// Clearly-fake placeholders only (AGENTS.md: never realistic secrets).
const SESSION_SECRET = "test-voice…cret";

const GUILD_A = "730000000000000001"; // bot + every test user
const GUILD_CROSS = "730000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "830000000000000001"; // owner:true ⇒ tier admin
const USER_STAFF = "830000000000000002"; // junior staff role ⇒ tier staff
const USER_SENIOR = "830000000000000003"; // senior staff role ⇒ tier senior
const USER_PLAIN = "830000000000000004"; // member, no staff role ⇒ no tier

const VOICE_USER_1 = "835000000000000101"; // seeded current session (12 min)
const VOICE_USER_2 = "835000000000000102"; // seeded current session (0 min)
const CROSS_MARKER = "999900000000009999"; // session in the OTHER guild only
const VOICE_CHANNEL_1 = "731000000000000201";
const VOICE_CHANNEL_2 = "731000000000000202";

// Fixed clock for the deterministic minutes/UTC checks.
const FIXED_NOW = 1759000000000;
const JOINED_1 = FIXED_NOW - (12 * 60_000 + 30_000); // ⇒ 12 whole minutes
const JOINED_2 = FIXED_NOW - 45_000; // ⇒ 0 minutes

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];
const BOT_GUILDS = [GUILD_A, GUILD_CROSS];

/** Deterministic UTC display string the view renders for an epoch-ms. */
function utcLabel(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Minimal fake voiceStates cache (Map-backed, discord.js-shaped). */
function fakeVoiceStates(entries) {
  const map = new Map(entries);
  map.values = Map.prototype.values.bind(map);
  return map;
}

describe("web voice & music page (GET /g/:guildId/voice, staff tier, view-only)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let tmpDir;
  let savedEnv;

  /** @type {import("http").Server} */
  let server;
  let base;

  const cookieOf = {};

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_ADMIN) {
        return [
          { id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" },
        ];
      }
      if (userId === USER_PLAIN || userId === USER_STAFF || userId === USER_SENIOR) {
        return [
          {
            id: GUILD_A,
            name: "Alpha HQ",
            icon: null,
            owner: false,
            permissions: "104324673", // no ManageGuild/Administrator bits
          },
        ];
      }
      return [];
    },
    async getUserGuildMember(token, guildId) {
      const userId = String(token).replace(/^tok-/, "");
      if (guildId !== GUILD_A) {
        const err = new Error("Unknown Guild");
        err.status = 404;
        throw err;
      }
      if (userId === USER_STAFF) return { roles: ["role-junior-staff"] };
      if (userId === USER_SENIOR) return { roles: ["role-senior-staff"] };
      return { roles: [] };
    },
  };

  let appMod;
  let voiceDataMod;
  let sessionPolicy;
  let tokens;

  /** Live sessions with encrypted ATs the real resolver can decrypt. */
  function mkSession(userId) {
    const s = sessionPolicy.createSession({ userId, discordTag: `${userId}#0001` });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: "[]",
    });
    return s.id;
  }

  /**
   * Boot an app with a FRESH resolver on an ephemeral port. Pass
   * `voiceData`/`getClient`/`getPlayerState`/`getLiveVoice` in extraOptions
   * to steer the runtime seams per test.
   * @param {Record<string, unknown>} [extraOptions]
   */
  async function mountApp(extraOptions = {}) {
    if (server) {
      server.close();
      await once(server, "close");
    }
    const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
    const resolver = createGuildAccessResolver({
      discord: fakeDiscord,
      botGuilds: async () => BOT_GUILDS,
      now: Date.now,
      ttlMs: 60_000,
    });
    const app = appMod.createWebApp({
      guildAccess: resolver,
      botGuilds: async () => BOT_GUILDS,
      ...extraOptions,
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }

  /**
   * @param {string} urlPath
   * @param {{ cookie?: string, method?: string }} [opts]
   */
  async function req(urlPath, { cookie, method = "GET" } = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    const body = await res.text();
    return { res, body };
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => {
      acc[k] = process.env[k];
      return acc;
    }, {});
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.SESSION_SECRET = SESSION_SECRET;

    appMod = require("../src/web/app");
    voiceDataMod = require("../src/web/data/voiceData");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");

    api.addStaffRole(GUILD_A, "role-junior-staff", "junior");
    api.addStaffRole(GUILD_A, "role-senior-staff", "senior");

    cookieOf.admin = `web_session=${mkSession(USER_ADMIN)}`;
    cookieOf.staff = `web_session=${mkSession(USER_STAFF)}`;
    cookieOf.senior = `web_session=${mkSession(USER_SENIOR)}`;
    cookieOf.plain = `web_session=${mkSession(USER_PLAIN)}`;

    // Voice-XP config override (slash parity: /setxp voice).
    api.updateGuildSettings(GUILD_A, { voice_xp_per_min: 3 });

    // Seed CURRENT voice sessions (voice_sessions = upsert-on-join,
    // delete-on-leave): two users in GUILD_A, one marker row in GUILD_CROSS
    // that must NEVER surface on the GUILD_A page.
    api.upsertVoiceSession(GUILD_A, VOICE_USER_1, VOICE_CHANNEL_1, JOINED_1);
    api.upsertVoiceSession(GUILD_A, VOICE_USER_2, VOICE_CHANNEL_2, JOINED_2);
    api.upsertVoiceSession(GUILD_CROSS, CROSS_MARKER, VOICE_CHANNEL_1, JOINED_1);

    await mountApp();
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
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // -------------------------------------------------------------------------
  // Tier matrix (§8.6) + cross-cutting 404 rule
  // -------------------------------------------------------------------------

  describe("tier matrix", () => {
    it("anonymous ⇒ 302 to /auth/login?guild=…", async () => {
      const { res, body } = await req(`/g/${GUILD_A}/voice`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(body, "");
    });

    it("stranger (live member, no staff role) ⇒ generic 404, never 403", async () => {
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.plain });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
      assert.match(res.headers.get("content-type"), /^text\/plain/);
    });

    it("cross-guild probe ⇒ the SAME plain 404 bytes (§8.6)", async () => {
      const stranger = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.plain });
      const cross = await req(`/g/${GUILD_CROSS}/voice`, { cookie: cookieOf.staff });
      assert.equal(cross.res.status, 404);
      assert.equal(cross.body, stranger.body);
    });

    it("malformed guild id with a live session ⇒ generic 404 (not echoed)", async () => {
      const { res, body } = await req("/g/oops-not-a-snowflake/voice", {
        cookie: cookieOf.admin,
      });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
    });

    for (const [label, cookie] of [
      ["junior staff", () => cookieOf.staff],
      ["senior staff", () => cookieOf.senior],
      ["guild owner (admin)", () => cookieOf.admin],
    ]) {
      it(`${label} ⇒ 200 with all four sections`, async () => {
        const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookie() });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8/);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.ok(body.includes("Now playing · queue (view-only)"), "music section");
        assert.ok(body.includes("<h2>Live voice</h2>"), "live voice section");
        assert.ok(body.includes("<h2>Voice sessions</h2>"), "sessions section");
        assert.ok(body.includes("<h2>Voice XP config</h2>"), "config section");
        assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null, "no on* attribute anywhere");
      });
    }
  });

  // -------------------------------------------------------------------------
  // Seeded voice_sessions rows + voice-XP config (exact values, guild-scoped)
  // -------------------------------------------------------------------------

  describe("seeded rows render exact values", () => {
    /** Fresh data instance on a FROZEN clock ⇒ deterministic minutes. */
    function frozenClockData() {
      return voiceDataMod.createVoiceData({ now: () => FIXED_NOW });
    }

    it("session rows render user/channel/joined UTC + whole minutes", async () => {
      await mountApp({ voiceData: frozenClockData() });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes(`<code class="user-id">${VOICE_USER_1}</code>`), "user 1 id");
      assert.ok(body.includes(`<code class="user-id">${VOICE_USER_2}</code>`), "user 2 id");
      assert.ok(body.includes(`<code class="channel-id">${VOICE_CHANNEL_1}</code>`), "channel 1");
      assert.ok(body.includes(`<code class="channel-id">${VOICE_CHANNEL_2}</code>`), "channel 2");
      assert.ok(body.includes(utcLabel(JOINED_1)), "joined stamp 1 (UTC)");
      assert.ok(body.includes(utcLabel(JOINED_2)), "joined stamp 2 (UTC)");
      // Whole-minute math on the frozen clock: 12.5 → 12, 45 s → 0.
      const row1 = body.slice(
        body.indexOf(VOICE_USER_1),
        body.indexOf(VOICE_USER_1) + 600
      );
      assert.match(row1, /<td class="voice-minutes">12<\/td>/, "12 minutes rendered");
      const row2 = body.slice(
        body.indexOf(VOICE_USER_2),
        body.indexOf(VOICE_USER_2) + 600
      );
      assert.match(row2, /<td class="voice-minutes">0<\/td>/, "0 minutes rendered");
    });

    it("other guild's session rows NEVER surface (guild-scoped read)", async () => {
      await mountApp({ voiceData: frozenClockData() });
      const { body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.ok(body.includes(VOICE_USER_1), "own rows present");
      assert.ok(!body.includes(CROSS_MARKER), "cross-guild marker never rendered");
    });

    it("voice-XP config renders the stored value with the /setxp govern badge", async () => {
      await mountApp({ voiceData: frozenClockData() });
      const { body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.senior });
      const row = api.getGuildSettings(GUILD_A);
      assert.equal(row.voice_xp_per_min, 3);
      assert.ok(
        body.includes(
          `<span class="setting-value">3</span>`
        ),
        "stored voice_xp_per_min exact"
      );
      assert.ok(body.includes("default 1"), "schema default displayed");
      assert.ok(body.includes("/setxp voice"), "govern badge names the slash command");
      assert.ok(body.includes('badge-tier-staff">staff'), "staff write-tier badge");
      assert.ok(body.includes("ignores AFK"), "AFK-ignoring rule noted");
      assert.ok(body.includes(`href="/g/${GUILD_A}/settings"`), "settings cross-link");
    });
  });

  // -------------------------------------------------------------------------
  // Music runtime seam — degradation ladder + fake player rendering
  // -------------------------------------------------------------------------

  describe("music state (never a throw, never a connection)", () => {
    it("no client seam at all ⇒ honest unwired render + live state unavailable, 200", async () => {
      await mountApp(); // no getClient, no providers → default data, unwired
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200, "unwired seams never 500");
      // dashboardData's exact unwired ladder step (never a fabricated state):
      assert.ok(body.includes("Player state <strong>unknown</strong>"), "unknown status");
      assert.ok(body.includes("no client wired"), "honest unwired detail");
      assert.ok(body.includes("live state unavailable"), "live voice degradation");
    });

    it("injected data module with NO providers ⇒ 'unavailable — not wired'", async () => {
      await mountApp({ voiceData: voiceDataMod.createVoiceData({ now: () => FIXED_NOW }) });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("Player state is <strong>unavailable</strong>"), "unavailable");
      assert.ok(body.includes("not wired"), "honest not-wired detail");
    });

    it("client without a lavalink manager ⇒ 'lavalink not configured' (env-gate string)", async () => {
      await mountApp({ getClient: () => ({}) }); // no _lavalinkManager
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("lavalink not configured"), "matches the feature's gate");
    });

    it("manager present but node down ⇒ 'no lavalink node connected'", async () => {
      await mountApp({
        getClient: () => ({ _lavalinkManager: { useable: false, getPlayer: () => null } }),
      });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("no lavalink node connected"), "node-down ladder step");
    });

    it("node ready but no player ⇒ 'no active player in this guild' (graceful)", async () => {
      await mountApp({
        getClient: () => ({
          _lavalinkManager: {
            useable: true,
            getPlayer: (gid) => (gid === GUILD_A ? null : null),
          },
        }),
      });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.admin });
      assert.equal(res.status, 200);
      assert.ok(body.includes("Nothing is playing — no active player in this guild."), "idle ladder step");
    });

    it("fake player object ⇒ now-playing + escaped queue rows (slash parity)", async () => {
      const mkTrack = (i, title, author) => ({
        info: {
          title,
          author,
          duration: 60_000 + i * 1000,
          isStream: false,
        },
        requester: { id: `83500000000000${200 + i}` },
      });
      const upcoming = [
        mkTrack(1, "Second <img src=x onerror=alert(1)> Track", "Plain Author"),
        ...Array.from({ length: 11 }, (_, i) =>
          mkTrack(i + 2, `Bulk ${i + 2}`, `Author ${i + 2}`)
        ),
      ];
      const hostilePlayer = {
        paused: false,
        position: 65_000,
        volume: 70,
        connected: true,
        voiceChannelId: "732000000000000301",
        queue: {
          current: {
            info: {
              title: '<script>alert("np")</script>',
              author: "B <b>Beast</b> & Co",
              duration: 240_000,
              isStream: false,
            },
            requester: { id: "835000000000000111" },
          },
          tracks: upcoming,
        },
      };
      const fakeClient = {
        _lavalinkManager: {
          useable: true,
          getPlayer: (gid) => (gid === GUILD_A ? hostilePlayer : null),
        },
        channels: {
          cache: {
            get: (id) => (id === "732000000000000301" ? { name: "Gym <i>live</i>" } : undefined),
          },
        },
      };
      await mountApp({ getClient: () => fakeClient });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      // now-playing rendered + ESCAPED (§8.7)
      assert.ok(body.includes("&lt;script&gt;alert(&quot;np&quot;)&lt;/script&gt;"), "np title escaped");
      assert.ok(!body.includes('<script>alert("np")'), "no live script");
      assert.ok(body.includes("B &lt;b&gt;Beast&lt;/b&gt; &amp; Co"), "np author escaped");
      assert.ok(body.includes("1:05 / 4:00"), "position/duration m:ss parity");
      assert.ok(body.includes("requested by <code>835000000000000111</code>"), "requester id");
      // queue rows: 10 shown of 12 (slash /music queue parity), hostile row escaped
      assert.ok(body.includes("Second &lt;img src=x onerror=alert(1)&gt; Track"), "queue title escaped");
      assert.ok(!body.includes("<img src=x onerror="), "no live img probe");
      assert.ok(body.includes("Showing the first 10 of 12 queued tracks"), "truncation honesty");
      assert.ok(body.includes("12 in queue"), "queue total");
      assert.ok(body.includes("volume 70%"), "volume line");
      assert.ok(body.includes("(Gym &lt;i&gt;live&lt;/i&gt;)"), "player channel (cache-only name)");
      assert.ok(body.includes("/play · music queue|nowplaying"), "govern line: slash only");
      assert.ok(body.includes("no web control exists (§8.9)"), "explicit §8.9 note");
    });

    it("THROWING client seam degrades — never 500, internals never leak", async () => {
      await mountApp({
        getClient: () => {
          throw new Error("client exploded boom-secret");
        },
      });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200, "throwing seam must degrade");
      assert.ok(body.includes("Player state <strong>unknown</strong>"), "music degraded");
      assert.ok(body.includes("player read failed"), "fixed detail");
      assert.ok(body.includes("live state unavailable"), "live degraded");
      assert.ok(!body.includes("boom-secret"), "error internals never rendered");
    });

    it("junk provider SHAPES normalize to unknown/unavailable, never crash", async () => {
      await mountApp({
        voiceData: voiceDataMod.createVoiceData({
          now: () => FIXED_NOW,
          getMusicState: () => ({ status: "weird", detail: {}, queue: "garbage" }),
          getLiveVoice: () => ({ available: true, channels: "nope" }),
        }),
      });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("Player state <strong>unknown</strong>"), "bad status → unknown");
      assert.ok(body.includes("<h2>Live voice</h2>"), "live section still renders");
      assert.ok(body.includes("No humans are connected"), "junk channels → empty list");
    });

    it("a throwing data module degrades to the generic 500 (no leak)", async () => {
      await mountApp({
        voiceData: {
          getVoice: async () => {
            throw new Error("data exploded internal-detail");
          },
        },
      });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 500);
      assert.equal(body, "Internal error");
    });
  });

  // -------------------------------------------------------------------------
  // Live voice snapshot (cache-only rules; unit checks on the pure reader)
  // -------------------------------------------------------------------------

  describe("live voice snapshot (cache-only, ticker-rule parity)", () => {
    it("absent client / missing caches ⇒ {available:false, 'live state unavailable'}", () => {
      assert.deepEqual(voiceDataMod.snapshotLiveVoice(null, GUILD_A), {
        available: false,
        detail: "live state unavailable",
      });
      assert.equal(
        voiceDataMod.snapshotLiveVoice({ guilds: { cache: { get: () => undefined } } }, GUILD_A)
          .available,
        false
      );
    });

    it("humans/AFK/muted/eligible + ≥2-earning rules mirror the voice ticker", () => {
      const human = (id, channelId, extra = {}) => [
        id,
        { id, channelId, member: { user: { bot: false } }, ...extra },
      ];
      const guild = {
        afkChannelId: "chan-afk",
        voiceStates: {
          cache: fakeVoiceStates([
            human("u1", "chan-v1"),
            human("u2", "chan-v1"),
            ["boty", { id: "boty", channelId: "chan-v1", member: { user: { bot: true } } }],
            human("u3", "chan-afk"),
            human("u4", "chan-v2", { selfDeaf: true }),
            human("u5", "chan-v2"),
          ]),
        },
        members: { cache: new Map() },
      };
      const client = { guilds: { cache: { get: () => guild } } };
      const snap = voiceDataMod.snapshotLiveVoice(client, GUILD_A);
      assert.equal(snap.available, true);
      const byId = Object.fromEntries(snap.channels.map((c) => [c.channelId, c]));
      assert.equal(byId["chan-v1"].humans, 2, "bots excluded");
      assert.equal(byId["chan-v1"].eligible, 2);
      assert.equal(byId["chan-v1"].earning, true, "2 eligible ⇒ channel earns");
      assert.equal(byId["chan-afk"].afk, 1);
      assert.equal(byId["chan-afk"].earning, false, "AFK channel never earns");
      assert.equal(byId["chan-v2"].mutedOrDeaf, 1, "deafened counted");
      assert.equal(byId["chan-v2"].eligible, 1, "1 eligible < 2");
      assert.equal(byId["chan-v2"].earning, false, "solo listener earns nothing");
      assert.equal(snap.totals.humans, 5);
      assert.equal(snap.totals.eligible, 3);
      assert.equal(snap.afkChannelId, "chan-afk");
    });

    it("throwing voiceStates cache degrades to the fixed unavailable detail", () => {
      const client = {
        guilds: {
          cache: {
            get: () => ({
              voiceStates: {
                cache: {
                  values() {
                    throw new Error("intent data missing boom");
                  },
                },
              },
            }),
          },
        },
      };
      const snap = voiceDataMod.snapshotLiveVoice(client, GUILD_A);
      assert.equal(snap.available, false);
      assert.equal(snap.detail, "live state unavailable", "fixed detail only");
    });

    it("connected humans via the client seam render on the page (escaped names)", async () => {
      const human = (id, channelId) => [id, { id, channelId, member: { user: { bot: false } } }];
      const guild = {
        afkChannelId: null,
        voiceStates: { cache: fakeVoiceStates([human("u1", "733000000000000401"), human("u2", "733000000000000401")]) },
        members: { cache: new Map() },
      };
      const fakeClient = {
        guilds: { cache: { get: (gid) => (gid === GUILD_A ? guild : undefined) } },
        channels: { cache: { get: (id) => (id === "733000000000000401" ? { name: "Lounge <b>&</b>" } : undefined) } },
      };
      await mountApp({ getClient: () => fakeClient });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("<code class=\"channel-id\">733000000000000401</code>"), "channel row");
      assert.ok(body.includes("(Lounge &lt;b&gt;&amp;&lt;/b&gt;)"), "cache-only name escaped");
      assert.ok(body.includes("2 humans connected · 2 XP-eligible"), "totals honest");
      assert.ok(body.includes("Cache-only read"), "cache-only disclosure");
    });
  });

  // -------------------------------------------------------------------------
  // XSS probes through stored session values
  // -------------------------------------------------------------------------

  describe("XSS probes via session-shaped values", () => {
    before(() => {
      api.upsertVoiceSession(GUILD_A, "835000000000009999", '<script>alert("ch")</script>', 1759100000000);
    });

    it("hostile channel id renders ESCAPED, never live", async () => {
      await mountApp({ voiceData: voiceDataMod.createVoiceData({ now: () => FIXED_NOW }) });
      const { res, body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("&lt;script&gt;alert(&quot;ch&quot;)&lt;/script&gt;"), "channel id escaped");
      assert.ok(!body.includes('<script>alert("ch")'), "no live script");
      assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null, "no on* attribute anywhere");
    });
  });

  // -------------------------------------------------------------------------
  // §8.9 — ZERO control surface
  // -------------------------------------------------------------------------

  describe("no music control paths exist (§8.9)", () => {
    it("POST/PUT/PATCH/DELETE on the voice path hit the app-wide 405 gate", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`${base}/g/${GUILD_A}/voice`, {
          method,
          headers: { cookie: cookieOf.staff },
        });
        assert.equal(res.status, 405, `${method} must hit the app-wide 405 gate`);
        assert.equal(await res.text(), "Method not allowed");
      }
    });

    it("no control sub-path resolves — skip/pause/stop are 404 for every verb", async () => {
      for (const sub of ["skip", "pause", "stop", "seek", "volume", "queue/remove"]) {
        const get = await fetch(`${base}/g/${GUILD_A}/voice/${sub}`, {
          headers: { cookie: cookieOf.staff },
        });
        assert.equal(get.status, 404, `GET voice/${sub} must 404 (no route registered)`);
        const post = await fetch(`${base}/g/${GUILD_A}/voice/${sub}`, {
          method: "POST",
          headers: { cookie: cookieOf.staff },
        });
        assert.equal(post.status, 405, `POST voice/${sub} must 405 (no mutation route)`);
      }
    });

    it("the rendered page contains no <form> and no <button> inside <main>", async () => {
      const { body } = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      const main = body.slice(body.indexOf("<main"), body.indexOf("</main>"));
      assert.ok(main.length > 0, "main content present");
      assert.ok(!main.includes("<form"), "no forms in page body");
      assert.ok(!main.includes("<button"), "no buttons in page body");
      assert.ok(!main.includes("htmx:post"), "no htmx mutation verbs");
    });
  });

  // -------------------------------------------------------------------------
  // Cache TTL + query/provider budget (§8.6 + subtask ≥5 s cache acceptance)
  // -------------------------------------------------------------------------

  describe("cache budget: no per-hit fan-out", () => {
    it("uncached build = 1 settings read + 1 bounded session statement + 1 call per provider; cache hit = ZERO; expiry re-reads", async () => {
      let fakeNow = FIXED_NOW;
      const calls = [];
      const sqlArgs = [];
      // Counting proxy: counts facade method reads AND every prepared SQL.
      const proxy = Object.create(api);
      proxy.getGuildSettings = (...args) => {
        calls.push("getGuildSettings");
        return api.getGuildSettings(...args);
      };
      proxy.db = {
        prepare(sql) {
          calls.push("prepare");
          const stmt = api.db.prepare(sql);
          return {
            all: (...args) => {
              sqlArgs.push(args);
              return stmt.all(...args);
            },
            get: (...args) => stmt.get(...args),
          };
        },
      };
      let musicCalls = 0;
      let liveCalls = 0;
      await mountApp({
        voiceData: voiceDataMod.createVoiceData({
          db: proxy,
          now: () => fakeNow,
          ttlMs: 30_000,
          getMusicState: () => {
            musicCalls += 1;
            return { status: "idle", detail: "no active player in this guild" };
          },
          getLiveVoice: () => {
            liveCalls += 1;
            return { available: false, detail: "live state unavailable" };
          },
        }),
      });

      const first = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(first.res.status, 200);
      assert.deepEqual(
        calls.slice().sort(),
        ["getGuildSettings", "prepare"],
        "exactly ONE settings read + ONE session statement per uncached build"
      );
      assert.equal(musicCalls, 1, "player provider ran once");
      assert.equal(liveCalls, 1, "live provider ran once");

      const sessionCall = sqlArgs.find((args) => args[0] === GUILD_A);
      assert.ok(sessionCall, "session statement is guild-scoped (bound ?)");
      assert.ok(
        sqlArgs.every((args) => args[0] === GUILD_A),
        "no cross-guild parameter ever passed"
      );

      fakeNow += 10_000; // inside the (≥5 s subtask floor, 30 s actual) window
      const second = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(second.res.status, 200);
      assert.equal(calls.length, 2, "cache hit must not touch the facade (§8.6)");
      assert.equal(musicCalls, 1, "cache hit must not re-read the player (§8.6)");
      assert.equal(liveCalls, 1, "cache hit must not re-read voice states");
      assert.ok(second.body.includes("(cached)"), "freshness rendered honestly");

      fakeNow += 25_000; // past the 30 s window
      const third = await req(`/g/${GUILD_A}/voice`, { cookie: cookieOf.staff });
      assert.equal(third.res.status, 200);
      assert.ok(calls.length > 2, "expired cache re-reads the facade");
      assert.equal(musicCalls, 2, "expiry re-runs the provider exactly once");
    });

    it("junk ?query params cannot move anything or leak", async () => {
      const junk = await req(
        `/g/${GUILD_A}/voice?page=999&guild=${GUILD_CROSS}&x=<script>`,
        { cookie: cookieOf.staff }
      );
      assert.equal(junk.res.status, 200, "junk params never 500/404 the page");
      assert.ok(junk.body.includes("Voice XP config"));
      assert.ok(!junk.body.includes(GUILD_CROSS), "other guild's id never echoed");
      assert.ok(!junk.body.includes("<script>"), "raw param never echoed");
    });
  });
});
