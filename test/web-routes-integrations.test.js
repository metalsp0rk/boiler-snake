/**
 * GET /g/:guildId/integrations — the Phase 1 staff integrations view
 * (subtask 20, roadmap web-admin.md §8.6 Integrations row + cross-cutting
 * 404 rule + query budget). HTTP-level net test: real Express app on an
 * ephemeral port, REAL SQLite (temp DB, real staff_roles rows, seeded
 * youtube_channels / twitch_channels / reaction_role_panels(+options) /
 * event_reminder_configs(+offsets) / honeypot_* rows), FAKE Discord through
 * the injected createGuildAccessResolver seam — same harness style as
 * test/web-routes-settings.test.js.
 *
 * Covers:
 *  - tier matrix: anonymous ⇒ login redirect, stranger ⇒ generic 404,
 *    cross-guild ⇒ the SAME 404 bytes, malformed id ⇒ generic 404,
 *    junior/senior/admin ⇒ 200 (all five sections render);
 *  - seeded exact values per section (guild_settings config fields, YouTube
 *    channel rows, Twitch rows incl. the LIVE pill, panel titles + option
 *    counts, reminder shortname / next-fire derived from stored offsets,
 *    honeypot channels + ban roles + exempt list);
 *  - configured-vs-effective env gates: set/unset YOUTUBE_API_KEY +
 *    TWITCH_CLIENT_ID/SECRET IN-TEST (restored after) — disabled-with-reason
 *    names ONLY the missing variables, sentinel VALUES never render (§8.7);
 *  - XSS probes through every free-text-shaped integration value
 *    (channel names, display names, panel titles, reminder shortnames);
 *  - §8.6 caps: uncached assembly = 8 fixed guild-scoped facade reads + one
 *    indexed option COUNT per displayed panel, ZERO inside the cached
 *    window, fresh again after; junk query params cannot move an offset;
 *  - channel/role name seam: cache-only names, escaped, graceful id-only
 *    fallback when the client is absent/broken;
 *  - read-only Phase 1: every non-GET on the path is 405 (writes land in
 *    Phase 2 subtask 26).
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// Clearly-fake placeholders only (AGENTS.md: never realistic secrets).
const SESSION_SECRET = "test-integ…cret";
const SENTINEL_YT_KEY = "SENTIN…-key";
const SENTINEL_TW_ID = "SENTINEL-TWITCH-ID-clearly-fake";
const SENTINEL_TW_SECRET = "SENTINEL-TWITCH-SECRET-clearly-fake";

const GUILD_A = "720000000000000001"; // bot + every test user
const GUILD_CROSS = "720000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "820000000000000001"; // owner:true ⇒ tier admin
const USER_STAFF = "820000000000000002"; // junior staff role ⇒ tier staff
const USER_SENIOR = "820000000000000003"; // senior staff role ⇒ tier senior
const USER_PLAIN = "820000000000000004"; // member, no staff role ⇒ no tier

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];
const INTEG_ENV_KEYS = ["YOUTUBE_API_KEY", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET"];
const BOT_GUILDS = [GUILD_A, GUILD_CROSS];

/** Fixed facade reads the integrations page is allowed to make. */
const FIXED_READS = [
  "getGuildSettings",
  "getYoutubeChannels",
  "getTwitchChannels",
  "listReactionRolePanels",
  "listEventReminderConfigs",
  "listHoneypotChannels",
  "listHoneypotBanRoles",
  "listHoneypotExemptRoles",
];
/** Per-panel read (capped by the data module's PANEL_CAP). */
const OPTION_COUNT_READ = "countReactionRoleOptions";

const ALL_READS = [...FIXED_READS, OPTION_COUNT_READ];

/** Deterministic UTC display string the view renders for an epoch-ms. */
function utcLabel(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

describe("web integrations page (GET /g/:guildId/integrations, staff tier, read-only)", () => {
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
  let integrationsDataMod;
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
   * Boot an app with a FRESH resolver on an ephemeral port. Every call gets
   * a fresh integrationsData UNLESS the test passes one — this also makes
   * env changes (set/unset per test) visible to the fresh snapshot build.
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
      integrationsData: integrationsDataMod.createIntegrationsData({}),
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

  /**
   * Facade proxy that COUNTS the integration reads while delegating to the
   * real facade (the data module looks methods up per call, so this proxy
   * object IS what runs).
   */
  function startReadCounter() {
    const calls = [];
    const proxy = Object.create(api);
    for (const name of ALL_READS) {
      proxy[name] = (...args) => {
        calls.push({ name, args });
        return api[name](...args);
      };
    }
    return { calls, proxy };
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => {
      acc[k] = process.env[k];
      return acc;
    }, {});
    for (const key of INTEG_ENV_KEYS) savedEnv[key] = process.env[key];
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.SESSION_SECRET = SESSION_SECRET;

    appMod = require("../src/web/app");
    integrationsDataMod = require("../src/web/data/integrationsData");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");

    api.addStaffRole(GUILD_A, "role-junior-staff", "junior");
    api.addStaffRole(GUILD_A, "role-senior-staff", "senior");

    cookieOf.admin = `web_session=${mkSession(USER_ADMIN)}`;
    cookieOf.staff = `web_session=${mkSession(USER_STAFF)}`;
    cookieOf.senior = `web_session=${mkSession(USER_SENIOR)}`;
    cookieOf.plain = `web_session=${mkSession(USER_PLAIN)}`;

    await mountApp();
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    for (const key of [...ENV_KEYS, ...INTEG_ENV_KEYS]) {
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
      const { res, body } = await req(`/g/${GUILD_A}/integrations`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(body, "");
    });

    it("stranger (live member, no staff role) ⇒ generic 404, never 403", async () => {
      const { res, body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.plain });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
      assert.match(res.headers.get("content-type"), /^text\/plain/);
    });

    it("cross-guild probe ⇒ the SAME plain 404 bytes (§8.6)", async () => {
      const stranger = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.plain });
      const cross = await req(`/g/${GUILD_CROSS}/integrations`, { cookie: cookieOf.staff });
      assert.equal(cross.res.status, 404);
      assert.equal(cross.body, stranger.body);
    });

    it("malformed guild id with a live session ⇒ generic 404 (not echoed)", async () => {
      const { res, body } = await req("/g/oops-not-a-snowflake/integrations", {
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
      it(`${label} ⇒ 200 with all five sections`, async () => {
        const { res, body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookie() });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8/);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.ok(body.includes("<h2>YouTube</h2>"), "youtube section");
        assert.ok(body.includes("<h2>Twitch</h2>"), "twitch section");
        assert.ok(body.includes("Reaction roles"), "reaction roles section");
        assert.ok(body.includes("Event reminders"), "event reminders section");
        assert.ok(body.includes("<h2>Honeypot</h2>"), "honeypot section");
        assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null, "no on* attribute anywhere");
      });
    }
  });

  // -------------------------------------------------------------------------
  // Env-gated degradation (configured vs effective). Runs BEFORE seeding so
  // the reason lines are the only section content changes it depends on.
  // -------------------------------------------------------------------------

  describe("env-missing degradation (names only, never values)", () => {
    after(() => {
      for (const key of INTEG_ENV_KEYS) delete process.env[key];
    });

    it("no credentials in env ⇒ both sections disabled with the features' own messages", async () => {
      for (const key of INTEG_ENV_KEYS) delete process.env[key];
      await mountApp();
      const { res, body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      // Mirrors src/features/youtube/ticker.js ("YOUTUBE_API_KEY not
      // configured - live notifications disabled"):
      assert.ok(
        body.includes("YOUTUBE_API_KEY not configured"),
        "youtube reason names YOUTUBE_API_KEY"
      );
      // Mirrors src/features/twitch/index.js ("…Set `TWITCH_CLIENT_ID` and
      // `TWITCH_CLIENT_SECRET` first.") — both missing, both named:
      assert.ok(
        body.includes("Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` first."),
        "twitch reason names both missing variables"
      );
      assert.ok(body.includes("Disabled"), "youtube shows the disabled state");
    });

    it("credentials present ⇒ sections show configured (sentinel VALUES never render)", async () => {
      process.env.YOUTUBE_API_KEY = SENTINEL_YT_KEY;
      process.env.TWITCH_CLIENT_ID = SENTINEL_TW_ID;
      process.env.TWITCH_CLIENT_SECRET = SENTINEL_TW_SECRET;
      await mountApp();
      const { res, body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(!body.includes("YOUTUBE_API_KEY not configured"), "reason gone");
      assert.ok(!body.includes("not configured on this bot"), "twitch reason gone");
      assert.ok(body.includes("Bot credentials"), "twitch credential line present");
      assert.ok(body.includes("configured"), "credential state renders");
      // §8.7: the VALUE of any integration env var never reaches the page.
      assert.ok(!body.includes(SENTINEL_YT_KEY), "youtube key value never rendered");
      assert.ok(!body.includes(SENTINEL_TW_ID), "twitch client id value never rendered");
      assert.ok(!body.includes(SENTINEL_TW_SECRET), "twitch secret value never rendered");
    });

    it("PARTIAL twitch env ⇒ reason names ONLY the missing variable", async () => {
      process.env.YOUTUBE_API_KEY = SENTINEL_YT_KEY;
      process.env.TWITCH_CLIENT_ID = SENTINEL_TW_ID;
      delete process.env.TWITCH_CLIENT_SECRET;
      await mountApp();
      const { body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.ok(
        body.includes("Set `TWITCH_CLIENT_SECRET` first."),
        "missing variable named"
      );
      assert.ok(
        !body.includes("`TWITCH_CLIENT_ID` and"),
        "the PRESENT variable is not demanded"
      );
      assert.ok(!body.includes(SENTINEL_TW_ID), "present value still never rendered");
    });
  });

  // -------------------------------------------------------------------------
  // Seeded exact values per section (acceptance: each panel reads its
  // feature's tables and renders what the slash list commands show)
  // -------------------------------------------------------------------------

  describe("seeded rows render exact values", () => {
    const YT_LAST_CHECKED = 1727000000000; // fixed epoch-ms, deterministic UTC
    const TW_LAST_CHECKED = 1727100000000;
    const FIRE_EARLY = 1759000000000; // sent first
    const FIRE_LATE = 1760000000000; // the remaining "next fire"

    before(() => {
      api.updateGuildSettings(GUILD_A, {
        youtube_notification_channel_id: "721000000000000101",
        youtube_polling_interval_minutes: 7,
        youtube_upload_role_id: "621000000000000102",
        twitch_notification_channel_id: "721000000000000103",
        twitch_notify_role_id: "621000000000000104",
        twitch_polling_interval_minutes: 3,
        event_reminder_channel_id: "721000000000000105",
      });
      api.addYoutubeChannel(
        GUILD_A,
        "UCytseed001",
        "Daily Uploads",
        "https://www.youtube.com/@daily-uploads",
        null
      );
      api.updateYoutubeChannelLastChecked("UCytseed001", YT_LAST_CHECKED, "vid-9001");
      api.addTwitchChannel(GUILD_A, "btv-seed-1", "coolstreamer", "Cool Streamer", null);
      api.updateTwitchChannelLiveState(GUILD_A, "btv-seed-1", {
        isLive: true,
        lastStreamId: "stream-4242",
        lastChecked: TW_LAST_CHECKED,
      });
      api.createReactionRolePanel(GUILD_A, "722000000000000201", "922000000000000201", "Grab your roles", "React to pick up roles");
      for (const [emojiKey, roleId] of [
        ["one", "622000000000000301"],
        ["two", "622000000000000302"],
        ["three", "622000000000000303"],
      ]) {
        api.upsertReactionRoleOption(
          GUILD_A,
          "922000000000000201",
          emojiKey,
          `:${emojiKey}:`,
          roleId,
          0,
          1
        );
      }
      api.createReactionRolePanel(GUILD_A, "722000000000000202", "922000000000000202", "Empty panel", "no options yet");
      const config = api.createEventReminderConfig({
        guildId: GUILD_A,
        scheduledEventId: "723000000000000301",
        shortname: "game-night",
        roleId: "623000000000000302",
        channelId: null,
        messageTemplate: null,
        persistent: true,
        offsets: [
          { offsetMinutes: 60, fireAt: FIRE_EARLY },
          { offsetMinutes: 10, fireAt: FIRE_LATE },
        ],
        createdBy: "820000000000000002",
      });
      assert.ok(config && config.offsets.length === 2);
      api.markReminderSent(config.offsets[0].id, "923000000000000999");
      api.addHoneypotChannel(GUILD_A, "724000000000000401");
      api.setHoneypotWarningMessage(GUILD_A, "724000000000000401", "924000000000000402");
      api.addHoneypotBanRole(GUILD_A, "624000000000000403");
      api.addHoneypotExemptRole(GUILD_A, "624000000000000404", "senior");
    });

    it("youtube config + row render the stored values exactly", async () => {
      await mountApp();
      const row = api.getGuildSettings(GUILD_A); // slash source of truth
      const yt = api.getYoutubeChannels(GUILD_A).find((r) => r.id === "UCytseed001");
      const { body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.ok(body.includes(`<code class="channel-id">${row.youtube_notification_channel_id}</code>`), "notify channel id");
      assert.ok(body.includes(`<code class="role-id">${row.youtube_upload_role_id}</code>`), "upload role id");
      assert.ok(body.includes(`${row.youtube_polling_interval_minutes} min`), "poll interval exact");
      assert.ok(body.includes("Daily Uploads"), "channel name");
      assert.ok(body.includes("https://www.youtube.com/@daily-uploads"), "channel url as escaped text");
      assert.ok(body.includes("<code>UCytseed001</code>"), "channel id");
      assert.ok(body.includes("<code>vid-9001</code>"), "last video id");
      assert.ok(body.includes(utcLabel(yt.last_checked)), "last checked UTC stamp");
      assert.ok(body.includes("/setyoutube channel|interval|uploadrole"), "slash cross-reference");
      assert.ok(body.includes("/youtube add|remove"), "subscription govern badge");
    });

    it("twitch config + live row render the stored values exactly", async () => {
      const { body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.senior });
      const row = api.getGuildSettings(GUILD_A);
      const tw = api.getTwitchChannels(GUILD_A).find((r) => r.login === "coolstreamer");
      assert.ok(body.includes(`<code class="channel-id">${row.twitch_notification_channel_id}</code>`), "notify channel id");
      assert.ok(body.includes(`<code class="role-id">${row.twitch_notify_role_id}</code>`), "notify role id");
      assert.ok(body.includes(`${row.twitch_polling_interval_minutes} min`), "poll interval exact");
      assert.ok(body.includes("Cool Streamer"), "display name");
      assert.ok(body.includes("<code>coolstreamer</code>"), "login");
      assert.ok(body.includes('<span class="integ-pill integ-pill-live">LIVE</span>'), "live pill");
      assert.ok(body.includes("<code>stream-4242</code>"), "last stream id");
      assert.ok(body.includes(utcLabel(tw.last_checked)), "last checked UTC stamp");
      assert.ok(body.includes("/settwitch channel|role|interval"), "slash cross-reference");
      assert.ok(body.includes("Bot credentials"), "credential state line");
    });

    it("reaction-role panels render titles + stored option counts", async () => {
      const { body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.admin });
      assert.ok(body.includes("Grab your roles"), "panel title");
      assert.ok(body.includes("React to pick up roles"), "panel description");
      assert.ok(body.includes("<code>922000000000000201</code>"), "panel message id");
      assert.ok(body.includes("<code>922000000000000202</code>"), "second panel id");
      assert.ok(body.includes("Empty panel"), "second panel title");
      // Option counts: 3 for the seeded panel, 0 for the empty one (the
      // facade counts are the source of truth):
      assert.equal(api.countReactionRoleOptions(GUILD_A, "922000000000000201"), 3);
      const panelRow = (msgId) =>
        body.slice(body.indexOf(`<code>${msgId}</code>`), body.indexOf(`<code>${msgId}</code>`) + 260);
      assert.match(panelRow("922000000000000201"), /<td>3<\/td>/, "3 options rendered");
      assert.match(panelRow("922000000000000202"), /<td>0<\/td>/, "0 options rendered");
      assert.ok(body.includes("/reactionrole panel|option"), "slash cross-reference");
    });

    it("event reminders render config + next-fire derived from stored offsets", async () => {
      const { body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      const row = api.getGuildSettings(GUILD_A);
      assert.ok(body.includes(`<code class="channel-id">${row.event_reminder_channel_id}</code>`), "default channel id");
      assert.ok(body.includes("game-night"), "shortname exact");
      assert.ok(body.includes("<code>723000000000000301</code>"), "scheduled event id");
      assert.ok(body.includes(`<code class="role-id">623000000000000302</code>`), "ping role id");
      assert.ok(body.includes("persistent"), "persistent flag");
      assert.ok(body.includes(utcLabel(FIRE_LATE)), "next fire = earliest UNSENT stored offset");
      assert.ok(!body.includes(utcLabel(FIRE_EARLY)), "sent offset not shown as next fire");
      assert.ok(body.includes("<td>1 / 1</td>"), "sent/unsent counts exact");
      assert.ok(body.includes("/eventreminder setchannel"), "channel govern badge");
      assert.ok(body.includes("/eventreminder create|edit|clear"), "config govern badge");
    });

    it("honeypot channels + ban roles + exempt list render, admin-tier exempt badge", async () => {
      const { body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.ok(body.includes(`<code class="channel-id">724000000000000401</code>`), "trap channel id");
      assert.ok(body.includes("<code>924000000000000402</code>"), "warning message id");
      assert.ok(body.includes(`<code class="role-id">624000000000000403</code>`), "ban role id");
      assert.ok(body.includes(`<code class="role-id">624000000000000404</code>`), "exempt role id");
      assert.ok(body.includes("(senior)"), "exempt staff level shown");
      // §8.6: /honeypot exempt = Admin write tier + cross-link to /staff.
      assert.ok(body.includes("/honeypot exempt add|del"), "exempt govern badge");
      assert.ok(body.includes('badge-tier-admin">admin'), "admin badge on the exempt row");
      assert.ok(body.includes(`href="/g/${GUILD_A}/staff"`), "cross-link to the staff page");
      assert.ok(body.includes("/honeypot channel add|del"), "channel govern badge (staff)");
      assert.ok(body.includes("/honeypot banrole add|del"), "ban-role govern badge (staff)");
      assert.ok(
        body.includes("requires Manage Server"),
        "admin-tier write hint visible (§8.6 per-command tier)"
      );
    });
  });

  // -------------------------------------------------------------------------
  // XSS probes through every free-text-shaped integration value
  // -------------------------------------------------------------------------

  describe("XSS probes via integration-shaped values", () => {
    before(() => {
      api.addYoutubeChannel(
        GUILD_A,
        "UCxss001",
        '<script>alert("yt")</script>',
        'https://evil.example/?x=<img src=y onerror="alert(9)">',
        null
      );
      api.addTwitchChannel(GUILD_A, "btv-xss", "xsslogin", '<img src=x onerror="alert(1)">', null);
      api.createReactionRolePanel(
        GUILD_A,
        "725000000000000501",
        "925000000000000501",
        '<svg onload="alert(2)">panel</svg>',
        "desc with <b>markup</b> & entities"
      );
      api.createEventReminderConfig({
        guildId: GUILD_A,
        scheduledEventId: "725000000000000502",
        shortname: '<script>alert("er")</script>',
        roleId: "625000000000000503",
        channelId: '<b>chan</b>',
        messageTemplate: null,
        persistent: false,
        offsets: [{ offsetMinutes: 5, fireAt: 1760100000000 }],
        createdBy: "820000000000000002",
      });
    });

    it("every hostile value renders ESCAPED, never live", async () => {
      await mountApp();
      const { res, body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("&lt;script&gt;alert(&quot;yt&quot;)&lt;/script&gt;"), "youtube channel name escaped");
      assert.ok(body.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), "twitch display name escaped");
      assert.ok(body.includes("&lt;svg onload=&quot;alert(2)&quot;&gt;panel&lt;/svg&gt;"), "panel title escaped");
      assert.ok(body.includes("&lt;script&gt;alert(&quot;er&quot;)&lt;/script&gt;"), "reminder shortname escaped");
      assert.ok(body.includes("&lt;b&gt;chan&lt;/b&gt;"), "reminder channel override escaped");
      assert.ok(!body.includes(`<script>alert("yt")`), "no live youtube script");
      assert.ok(!body.includes(`<script>alert("er")`), "no live reminder script");
      assert.ok(!body.includes(`<svg onload=`), "no live svg");
      assert.ok(!body.includes(`<img src=x onerror=`), "no live img probe");
      assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null, "no on* attribute anywhere");
    });
  });

  // -------------------------------------------------------------------------
  // §8.6 caps: list cap + bounded per-panel option-count loop + junk params
  // -------------------------------------------------------------------------

  describe("list caps + junk query tolerance", () => {
    it("101 seeded youtube rows ⇒ page shows the §8.6 cap note, never more", async () => {
      for (let i = 0; i < 100; i += 1) {
        api.addYoutubeChannel(GUILD_A, `UCflood${i}`, `Flood ${i}`, `https://yt.example/@f${i}`, null);
      }
      await mountApp();
      const { res, body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      // 2 earlier rows + 100 flood rows = 102 > LIST_CAP(100): the last
      // rendered row is flood97, flood98/flood99 stay behind the cap note.
      assert.ok(body.includes("(§8.6 list cap — more exist)"), "truncation noted honestly");
      assert.ok(body.includes(">Flood 97<"), "boundary row inside cap shown");
      assert.ok(!body.includes(">Flood 98<"), "row beyond the cap not rendered");
      assert.ok(!body.includes(">Flood 99<"), "second hidden row not rendered either");
      assert.ok(body.includes("<code>UCflood0</code>"), "first flood row rendered");
    });

    it("junk ?o/?n/?guild params cannot move a page or leak (no query surface)", async () => {
      const plain = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      const junk = await req(
        `/g/${GUILD_A}/integrations?o=999999999&n=99999&guild=${GUILD_CROSS}&x=<script>`,
        { cookie: cookieOf.staff }
      );
      assert.equal(junk.res.status, 200, "junk params never 500/404 the page");
      assert.ok(junk.body.includes("<h2>YouTube</h2>"));
      assert.ok(!junk.body.includes(GUILD_CROSS), "other guild's id never echoed");
      assert.ok(!junk.body.includes("<script>"), "raw param never echoed");
      assert.equal(plain.body.includes("<h2>YouTube</h2>"), true);
    });
  });

  // -------------------------------------------------------------------------
  // Cache TTL + query budget (§8.6, review-blocking)
  // -------------------------------------------------------------------------

  describe("cache TTL + query budget", () => {
    it("uncached build = 8 fixed guild-scoped reads + one COUNT per panel; cache hit = zero; expiry re-reads", async () => {
      let fakeNow = Date.now();
      const { calls, proxy } = startReadCounter();
      const panelCount = api.listReactionRolePanels(GUILD_A).length; // all seeded panels < PANEL_CAP
      assert.ok(panelCount > 0 && panelCount <= 30, "fixture stays inside the panel cap");
      await mountApp({
        integrationsData: integrationsDataMod.createIntegrationsData({
          db: proxy,
          now: () => fakeNow,
          ttlMs: 30_000,
        }),
      });

      const first = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.equal(first.res.status, 200);
      const afterFirst = calls.length;
      assert.equal(
        afterFirst,
        FIXED_READS.length + panelCount,
        `exactly ${FIXED_READS.length} fixed reads + ${panelCount} panel option counts`
      );
      const fixedNames = [...new Set(calls.map((c) => c.name).filter((n) => n !== OPTION_COUNT_READ))].sort();
      assert.deepEqual(fixedNames, [...FIXED_READS].sort(), "each fixed helper ran exactly once");
      const countCalls = calls.filter((c) => c.name === OPTION_COUNT_READ);
      assert.equal(countCalls.length, panelCount, "one indexed option COUNT per displayed panel");
      assert.deepEqual(
        calls.map((c) => c.args[0]).filter((a) => a !== GUILD_A),
        [],
        "every read is guild-scoped to the viewed guild — no cross-guild leakage"
      );

      fakeNow += 10_000; // inside the window
      const second = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.equal(second.res.status, 200);
      assert.equal(calls.length, afterFirst, "cache hit must not touch the facade (§8.6)");
      assert.ok(second.body.includes("(cached)"), "freshness rendered honestly");

      fakeNow += 25_000; // past 30 s
      const third = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.equal(third.res.status, 200);
      assert.ok(calls.length > afterFirst, "expired cache re-reads the facade");
    });
  });

  // -------------------------------------------------------------------------
  // Channel/role name seam (cache-only, escaped, graceful fallback)
  // -------------------------------------------------------------------------

  describe("name seam via getClient", () => {
    const fakeClient = {
      channels: {
        cache: {
          get: (id) =>
            id === "721000000000000101" ? { name: "yt<b>&alerts</b>" } : undefined,
        },
      },
      roles: {
        cache: {
          get: (id) => (id === "621000000000000102" ? { name: "Ping <crew>" } : undefined),
        },
      },
    };

    it("cached names decorate ids (escaped); unknown ids stay bare", async () => {
      await mountApp({ getClient: () => fakeClient });
      const { res, body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
      assert.equal(res.status, 200);
      assert.ok(body.includes("(yt&lt;b&gt;&amp;alerts&lt;/b&gt;)"), "escaped cached channel name");
      assert.ok(body.includes("(Ping &lt;crew&gt;)"), "escaped cached role name");
      assert.ok(!body.includes("yt<b>"), "name never live");
      assert.ok(
        body.includes(`<code class="channel-id">721000000000000103</code>`),
        "unknown channel renders id-only"
      );
    });

    it("absent / THROWING getClient degrade to ids — never a 500, never a fetch", async () => {
      for (const getClient of [null, () => { throw new Error("client exploded"); }]) {
        await mountApp({ getClient });
        const { res, body } = await req(`/g/${GUILD_A}/integrations`, { cookie: cookieOf.staff });
        assert.equal(res.status, 200);
        assert.ok(body.includes(`721000000000000101`), "id still rendered");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Read-only Phase 1 (§8.8): no mutation routes on this path
  // -------------------------------------------------------------------------

  it("no POST/PUT/PATCH/DELETE routes — app-wide 405 on the integrations path", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(`${base}/g/${GUILD_A}/integrations`, {
        method,
        headers: { cookie: cookieOf.staff },
      });
      assert.equal(res.status, 405, `${method} must hit the app-wide 405 gate`);
      assert.equal(await res.text(), "Method not allowed");
    }
  });
});
