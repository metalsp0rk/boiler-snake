/**
 * §8.15 amendment — the themed transcript page (record-rendered /t/{uuid}):
 * staff get shell chrome (sidebar + switcher + linked people), participants
 * get the SAME content chrome-free (no /g/ links that would 404 for them),
 * the summary card renders from ai_summary_json, and the raw export link is
 * always present. Gates themselves are pinned by web-ticket-gating + the
 * phase gates; this suite covers the VIEW layer.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

const SESSION_SECRET = "test-tv1-…cret";

const GUILD_A = "770000000000000011";
const ROLE_JUNIOR = "tv-role-junior";

const USER_STAFF = "870000000000000022";
const USER_CREATOR = "870000000000000033"; // participant (ticket creator), NO staff
const CREATOR_NAME = "ThemedCreator";

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];

describe("themed transcript view (§8.15 amendment)", () => {
  let api;
  let tmpDir;
  let savedEnv;
  /** @type {import("http").Server} */
  let server;
  let base;
  const cookieOf = {};
  let token;

  const fakeDiscord = {
    async getUserGuilds(tokenStr) {
      const userId = String(tokenStr).replace(/^tok-/, "");
      if (userId === USER_STAFF) {
        return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: false, permissions: "0" }];
      }
      return []; // creator: NO guild access at all (§8.4 participant path)
    },
    async getUserGuildMember(tokenStr) {
      const userId = String(tokenStr).replace(/^tok-/, "");
      if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    },
  };

  const fakeClient = {
    guilds: {
      cache: new Map([
        [GUILD_A, { members: { cache: new Map([[USER_CREATOR, { displayName: CREATOR_NAME }]]) } }],
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
      guildSnapshot: JSON.stringify(
        userId === USER_STAFF
          ? [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: false, permissions: "104324673" }]
          : []
      ),
    });
    return s.id;
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
    cookieOf.staff = `web_session=${mkSession(USER_STAFF)}`;
    cookieOf.creator = `web_session=${mkSession(USER_CREATOR)}`;

    const mk = (msgs, summary, num) => {
      const tk = api.generateTranscriptToken();
      const t = api.createTicket({
        guildId: GUILD_A,
        creatorUserId: USER_CREATOR,
        channelId: `ch-theme-${num}`,
        reason: "themed view subject",
      });
      if (msgs.length) api.saveTicketMessages(t.id, msgs);
      api.markTicketClosed(t.id, { closedBy: USER_STAFF, closeReason: "closed ok" });
      api.closeTicketArchived(t.id, {
        closedBy: USER_STAFF,
        closeReason: "closed ok",
        transcriptToken: tk,
        transcriptPath: `tickets/${tk}/index.html`, // no file: raw 404s, view renders
        aiSummaryJson: summary ? JSON.stringify(summary) : null,
      });
      return tk;
    };

    token = mk(
      [
        {
          message_id: "tv-m1",
          author_id: USER_CREATOR,
          author_tag: "creator#0001",
          content: "line one\nline two",
          attachment_urls: null,
          sent_at: Date.now(),
        },
      ],
      {
        source: "ai",
        model: "test-model",
        subject: "lost keys",
        resolution: "found them",
        summary:
          "Member reported lost keys after Linux Weekly 21.\nStaff walked the checklist; keys found under the desk.",
      },
      1
    );
    mk([], null, 2); // empty-messages ticket (second token not exercised here)

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

  it("staff: shell chrome + sidebar + linked people + summary + raw link", async () => {
    const { res, body } = await req(`/t/${token}`, cookieOf.staff);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(body, /<aside class="shell-nav"/, "staff get the console sidebar");
    assert.ok(body.includes(CREATOR_NAME), "requester resolved from member cache");
    assert.ok(body.includes(`/g/${GUILD_A}/users/${USER_CREATOR}`), "staff: people are links");
    assert.ok(body.includes("line one<br/>line two"), "multi-line content preserved");
    assert.ok(body.includes("themed view subject"), "meta card shows the record");
    assert.match(body, /Summary/, "summary card renders");
    assert.ok(body.includes("lost keys") && body.includes("found them"));
    assert.ok(body.includes("test-model"), "summary provenance shown");
    // THE bug: the AI narrative (summary.summary) used to be dropped.
    assert.match(
      body,
      new RegExp('<p class="summary-prose">Member reported lost keys after Linux Weekly 21\\.<br/>'),
      "AI paragraph renders, newlines kept"
    );
    assert.match(body, /keys found under the desk/, "full narrative tail renders");
    assert.ok(body.includes(`/t/${token}/raw`), "raw export link present");
    // Active nav = the archive surface, never the dashboard (bug: empty
    // path used to highlight Dashboard on every transcript page).
    const active = [...body.matchAll(/<a[^>]*aria-current="page"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
    assert.deepEqual(active, ["Ticket archive"], "exactly one active nav item");
  });

  it("participant: SAME content, chrome-free — zero /g/ links", async () => {
    const { res, body } = await req(`/t/${token}`, cookieOf.creator);
    assert.equal(res.status, 200);
    assert.ok(body.includes("line one<br/>line two"), "content identical");
    assert.ok(body.includes(`/t/${token}/raw`), "their transcript, their raw export");
    assert.ok(!body.includes('<aside class="shell-nav"'), "no console nav for participants");
    assert.ok(!body.includes(`/g/${GUILD_A}`), "no dead-end console links (§8.6)");
    assert.ok(body.includes(CREATOR_NAME), "names still resolve for their own view");
    assert.ok(!/href="\/g\//.test(body));
  });

  it("missing export file: view still 200 from the record; raw 404", async () => {
    const view = await req(`/t/${token}`, cookieOf.staff);
    assert.equal(view.res.status, 200);
    const raw = await req(`/t/${token}/raw`, cookieOf.staff);
    assert.equal(raw.res.status, 404, "fixture never wrote the file");
    assert.equal(raw.body, "Transcript file missing");
  });

  it("staff-only chrome leak check: participant page has no tier badge or switcher", async () => {
    const { body } = await req(`/t/${token}`, cookieOf.creator);
    assert.ok(!body.includes("data-guild-switcher"), "no guild switcher for participants");
    assert.ok(!/badge-tier/i.test(body), "no tier badges leak");
  });
});
