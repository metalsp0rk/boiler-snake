/**
 * Web admin calendar for Community Events (#222) — HTTP-level suite:
 * REAL Express app on an ephemeral port, REAL SQLite (loadDb temp DB,
 * REAL staff_roles + web_sessions rows), FAKE Discord through the
 * createGuildAccessResolver seam + an optional fake bot client via
 * options.getClient. Mirrors test/web-routes-dashboard.test.js harness
 * style. CSRF computed via the real deriveCsrfToken (same as
 * test/web-integrations-writes.test.js).
 *
 * Covers:
 *  - tier matrix (anon ⇒ 302, stranger ⇒ generic 404, staff ⇒ 200);
 *  - month view renders seeded events incl. the in-progress marker and the
 *    draft badge; drafts/queued lists;
 *  - event page: options, attendee names, waitlist rows, reminders,
 *    activity, Discord message link;
 *  - POST create lands a draft + admin_audit row; CSRF rejection;
 *  - edit writes sync path (degraded no-client path flags "not in bot
 *    cache"; with a fake client the service path runs);
 *  - duplicate, archive/unarchive, permanent delete (DELETE confirm gate);
 *  - organizer signup add/remove through the service; reminders add/remove;
 *  - presets CRUD; series list + skip/stop; scheduled-posts list;
 *  - publish without a live client ⇒ honest specific error, not silence.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const { once } = require("node:events");
const { loadDb, communityKey } = require("./helpers/env");

const SESSION_SECRET = "test-evt-cal…cret";

const GUILD_A = "720000000000000001";
const GUILD_CROSS = "720000000000000002";
const ROLE_JUNIOR = "role-junior-staff";

const USER_ADMIN = "830000000000000001"; // owner ⇒ admin
const USER_STAFF = "830000000000000002"; // junior staff
const USER_PLAIN = "830000000000000003"; // no staff role
const USER_GUEST = "830000000000000004"; // signed-up member (attendee fakes)

const BOT_GUILDS = [GUILD_A, GUILD_CROSS];
const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];

let CID_A;

describe("web events calendar (routes/events.js)", () => {
  let api;
  let tmpDir;
  let savedEnv;
  let server;
  let base;
  let appMod;
  let sessionPolicy;
  let tokens;
  let csrfMod;

  const cookieOf = {};
  const sessionIdOf = {};

  /** Mutable fake bot client (mounted per-test via getClient seam). */
  let fakeClient = null;

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_ADMIN)
        return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" }];
      if (userId === USER_STAFF || userId === USER_PLAIN || userId === USER_GUEST)
        return [
          {
            id: GUILD_A,
            name: "Alpha HQ",
            icon: null,
            owner: false,
            permissions: "104324673", // no ManageGuild
          },
        ];
      return [];
    },
    async getUserGuildMember(token, guildId) {
      const userId = String(token).replace(/^tok-/, "");
      if (guildId !== GUILD_A) {
        const err = new Error("Unknown Guild");
        err.status = 404;
        throw err;
      }
      if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
      return { roles: [] };
    },
  };

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

  async function mountApp() {
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
      getClient: () => fakeClient,
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }

  async function req(urlPath, { cookie, method = "GET" } = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    const body = await res.text();
    return { res, body };
  }

  /** POST a urlencoded form with the CSRF field (302 ⇒ no follow).
   *  Accepts REST-style paths for readability and translates them to the
   *  literal action endpoints the route contract requires. */
  const ACTION_ALIAS = {
    "options/add": "option-add",
    "options/remove": "option-remove",
    "signups/add": "signup-add",
    "signups/remove": "signup-remove",
    "reminders/add": "reminder-add",
    "reminders/remove": "reminder-remove",
  };
  async function post(restPath, who, fields) {
    let path = restPath;
    let f = { ...fields };
    let m = /^\/g\/(\d+)\/events\/(\d+)\/([a-z-]+(?:\/[a-z-]+)?)$/.exec(restPath);
    if (m) {
      path = `/g/${m[1]}/events/action`;
      f = { action: ACTION_ALIAS[m[3]] || m[3], event_id: m[2], ...f };
    } else if ((m = /^\/g\/(\d+)\/events\/series\/(\d+)\/(skip|stop)$/.exec(restPath))) {
      path = `/g/${m[1]}/events/series`;
      f = { action: m[3], series_id: m[2], ...f };
    } else if ((m = /^\/g\/(\d+)\/events\/presets\/(\d+)\/delete$/.exec(restPath))) {
      path = `/g/${m[1]}/events/presets/delete`;
      f = { preset_id: m[2], ...f };
    }
    const form = new URLSearchParams({ ...f, _csrf: csrfMod.deriveCsrfToken(sessionIdOf[who], SESSION_SECRET) });
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: cookieOf[who],
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const body = await res.text();
    return { res, body, location: res.headers.get("location") || "" };
  }

  const qsOf = (loc) => {
    try {
      const u = new URL(loc, base);
      return Object.fromEntries(u.searchParams.entries());
    } catch {
      return {};
    }
  };

  const H = () => Date.now();

  function seedEvent(over = {}) {
    const start = over.startAt ?? H() + 3 * 3_600_000;
    const created = api.createEvent({
      communityId: CID_A,
      creatorId: USER_STAFF,
      title: over.title ?? "Movie Night",
      status: over.status ?? "draft",
      startAt: start,
      channelId: over.channelId ?? "710000000000000011",
      thread_enabled: 0,
      end_at: over.end_at ?? start + 2 * 3_600_000,
      description: over.description ?? "popcorn provided",
      location: over.location ?? "Lounge",
      attendee_role_existing: over.attendee_role_existing ?? 0,
      attendee_role_id: over.attendee_role_id ?? null,
      options:
        over.options ??
        [
          { label: "Yes", reminders_on: 1 },
          { label: "No" },
          { label: "Maybe" },
        ],
    });
    assert.ok(created.ok, `seed failed: ${created.error}`);
    if (over.messageId) {
      api.updateEvent(created.event.id, { message_id: over.messageId });
      created.event.message_id = over.messageId;
    }
    return created.event;
  }

  function seedOption(ev, label, extra = {}) {
    const out = api.createEventOption(ev.id, { label, ...extra });
    assert.ok(out.ok, out.error);
    return out.option;
  }

  before(async () => {
    savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
    const loaded = loadDb();
    api = loaded.api;
    tmpDir = loaded.tmpDir;
    process.env.SESSION_SECRET = SESSION_SECRET;

    appMod = require("../src/web/app");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");
    csrfMod = require("../src/web/middleware/csrf");

    CID_A = communityKey(GUILD_A);
    api.addStaffRole(CID_A, ROLE_JUNIOR, "junior");

    for (const [k, u] of Object.entries({
      admin: USER_ADMIN,
      staff: USER_STAFF,
      plain: USER_PLAIN,
      guest: USER_GUEST,
    })) {
      sessionIdOf[k] = mkSession(u);
      cookieOf[k] = `web_session=${sessionIdOf[k]}`;
    }
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
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── tier matrix ───────────────────────────────────────────────────────────

  it("anon ⇒ 302 to login; stranger ⇒ generic 404; staff ⇒ 200", async () => {
    const anon = await req(`/g/${CID_A}/events`);
    assert.equal(anon.res.status, 302);

    const stranger = await req(`/g/${CID_A}/events`, { cookie: cookieOf.plain });
    assert.equal(stranger.res.status, 404);
    assert.equal(stranger.body, "Not found");

    const staff = await req(`/g/${CID_A}/events`, { cookie: cookieOf.staff });
    assert.equal(staff.res.status, 200);
    assert.match(staff.body, /Event calendar/);
  });

  // ── month view ────────────────────────────────────────────────────────────

  it("month grid shows events with status badges + live marker", async () => {
    const now = H();
    seedEvent({
      title: "InProgress Show",
      status: "posted",
      startAt: now - 3_600_000,
      end_at: now + 3_600_000,
      messageId: "710000000000009001",
    });
    seedEvent({ title: "Draft Dream", status: "draft" });
    const { res, body } = await req(`/g/${CID_A}/events`, { cookie: cookieOf.staff });
    assert.equal(res.status, 200);
    assert.match(body, /InProgress Show/);
    assert.match(body, /badge--live/); // in-progress marker
    assert.match(body, /Draft Dream/);
    assert.match(body, /badge--draft/);
    assert.match(body, /Unposted drafts/);
  });

  // ── event page ────────────────────────────────────────────────────────────

  it("event page renders options, names, waitlist, reminders, activity, link", async () => {
    const ev = seedEvent({
      title: "Raid Night",
      status: "posted",
      messageId: "710000000000009002",
    });
    const yes = api.listEventOptions(ev.id).find((o) => o.label === "Yes");
    api.createEventReminders(ev.id, [
      { offsetMinutes: 30, fireAt: Number(ev.start_at) - 30 * 60_000, target: "attendees" },
    ]);
    api.forceEventSignup({ eventId: ev.id, optionId: yes.id, userId: USER_GUEST, actorId: USER_STAFF });
    // Put someone on the waitlist via a capacity option.
    const capped = seedOption(ev, "Signed", { capacity: 1, waitlist_on: 1 });
    api.forceEventSignup({ eventId: ev.id, optionId: capped.id, userId: USER_STAFF, actorId: USER_STAFF });
    const second = api.applyEventSignupChoice({
      eventId: ev.id,
      optionId: capped.id,
      userId: USER_PLAIN,
      actorId: USER_PLAIN,
    });
    assert.equal(second.state || "waitlisted", "waitlisted");

    const { res, body } = await req(`/g/${CID_A}/events/${ev.id}`, { cookie: cookieOf.staff });
    assert.equal(res.status, 200);
    assert.match(body, /Raid Night/);
    assert.match(body, /Signed/);
    assert.match(body, new RegExp(USER_GUEST)); // attendee name shown
    assert.match(body, /waiting/i);
    assert.match(body, /discord\.com\/channels/); // message link
    assert.match(body, /Activity/);
    assert.match(body, /created_by|signed_up|option_added|post/); // activity rows exist
    assert.match(body, /Manage a signup/); // staff gets the manage forms
  });

  it("unknown event id ⇒ generic 404", async () => {
    const { res } = await req(`/g/${CID_A}/events/999999`, { cookie: cookieOf.staff });
    assert.equal(res.status, 404);
  });

  // ── create + csrf ─────────────────────────────────────────────────────────

  it("POST create lands a draft with an audit row; CSRF-less POST rejected", async () => {
    const before = new Date().toISOString().slice(0, 4);
    const r = await post(`/g/${CID_A}/events`, "staff", {
      title: "Web Created",
      start: "in 2 days",
    });
    assert.equal(r.res.status, 302);
    assert.match(r.location, new RegExp(`/g/${CID_A}/events/\\d+`));
    const q = qsOf(r.location);
    assert.ok(q.ok, `expected ok flash: ${r.location}`);

    const listed = api
      .listEvents(CID_A, { statuses: ["draft"], limit: 50 })
      .find((e) => e.title === "Web Created");
    assert.ok(listed, "draft row exists");
    assert.ok(before); // noop

    const audits = api.listAdminAudit(CID_A, { limit: 30 });
    assert.ok(
      audits.some((a) => a.action === "events.create"),
      "admin_audit mirrors the create",
    );

    const noCsrf = await fetch(`${base}/g/${CID_A}/events`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookieOf.staff, "content-type": "application/x-www-form-urlencoded" },
      body: "title=Evil&start=in+1+day",
    });
    assert.ok(noCsrf.status >= 400, `csrf-less POST must fail, got ${noCsrf.status}`);
  });

  // ── degraded edit (no client) ────────────────────────────────────────────

  it("edit without a live client persists the change and flags the sync gap", async () => {
    fakeClient = null;
    const ev = seedEvent({ title: "Degraded Edit", status: "posted", messageId: "710000000000009003" });
    const r = await post(`/g/${CID_A}/events/${ev.id}/edit`, "staff", {
      description: "edited on the web",
      location: "Back room",
    });
    assert.equal(r.res.status, 302);
    const q = qsOf(r.location);
    assert.ok(q.ok, `expected ok flash: ${r.location}`);
    assert.match(q.ok, /not in bot cache/); // honest degraded notice
    const fresh = api.getEventById(ev.id);
    assert.equal(fresh.description, "edited on the web");
    assert.equal(fresh.location, "Back room");
  });

  it("publish without a live client fails loudly with a specific error", async () => {
    fakeClient = null;
    const ev = seedEvent({ title: "Cannot Post Yet", status: "draft" });
    const r = await post(`/g/${CID_A}/events/${ev.id}/publish`, "staff", {});
    const q = qsOf(r.location);
    assert.ok(q.err, "expected err flash");
    assert.match(q.err, /Discord connection unavailable/i);
    assert.equal(api.getEventById(ev.id).status, "draft");
  });

  // ── duplicate / archive / delete ─────────────────────────────────────────

  it("duplicate creates a draft copy; archive ⇄ unarchive; delete needs DELETE", async () => {
    const ev = seedEvent({ title: "Dup Target", status: "posted", messageId: "710000000000009004" });
    const dup = await post(`/g/${CID_A}/events/${ev.id}/duplicate`, "staff", {});
    assert.match(dup.location, new RegExp(`/g/${CID_A}/events/\\d+\\?ok=`));

    const arch = await post(`/g/${CID_A}/events/${ev.id}/archive`, "staff", {});
    assert.ok(qsOf(arch.location).ok, arch.location);
    assert.equal(api.getEventById(ev.id).status, "archived");

    const unarch = await post(`/g/${CID_A}/events/${ev.id}/unarchive`, "staff", {});
    assert.ok(qsOf(unarch.location).ok, unarch.location);
    // archive detached the Discord message (E8), so the row unarchives to a
    // DRAFT that needs a fresh publish — it cannot silently claim a dead id.
    assert.equal(api.getEventById(ev.id).status, "draft");

    const weak = await post(`/g/${CID_A}/events/${ev.id}/delete`, "staff", { confirm: "yes" });
    assert.ok(qsOf(weak.location).err, "must refuse without DELETE");

    const gone = await post(`/g/${CID_A}/events/${ev.id}/delete`, "staff", { confirm: "DELETE" });
    assert.ok(qsOf(gone.location).ok, gone.location);
    assert.equal(api.getEventById(ev.id), null);
  });

  // ── options / reminders management ────────────────────────────────────────

  it("option add/remove + reminder add/remove via web forms", async () => {
    const ev = seedEvent({ title: "Options Page", status: "draft" });
    const add = await post(`/g/${CID_A}/events/${ev.id}/options/add`, "staff", {
      label: "Pizza",
      capacity: "5",
      waitlist: "1",
    });
    assert.ok(qsOf(add.location).ok, add.location);
    const pizza = api.listEventOptions(ev.id).find((o) => o.label === "Pizza");
    assert.ok(pizza);

    const rm = await post(`/g/${CID_A}/events/${ev.id}/options/remove`, "staff", {
      option_id: String(pizza.id),
    });
    assert.ok(qsOf(rm.location).ok, rm.location);
    assert.ok(!api.listEventOptions(ev.id).some((o) => o.id === pizza.id));

    const remAdd = await post(`/g/${CID_A}/events/${ev.id}/reminders/add`, "staff", {
      minutes: "45",
    });
    assert.ok(qsOf(remAdd.location).ok, remAdd.location);
    const rems = api.listEventReminders(ev.id);
    assert.equal(rems.length, 1);

    const remRm = await post(`/g/${CID_A}/events/${ev.id}/reminders/remove`, "staff", {
      reminder_id: String(rems[0].id),
    });
    assert.ok(qsOf(remRm.location).ok, remRm.location);
    assert.equal(api.listEventReminders(ev.id).length, 0);
  });

  // ── presets ───────────────────────────────────────────────────────────────

  it("presets page: save + delete with option parsing", async () => {
    const save = await post(`/g/${CID_A}/events/presets`, "staff", {
      name: "Potluck",
      spec: "Pizza|10, Salad, Cakes|2",
    });
    assert.ok(qsOf(save.location).ok, save.location);
    const presets = api.listEventPresets(CID_A);
    const p = presets.find((x) => x.name === "Potluck");
    assert.ok(p, "preset row");
    assert.equal(p.options.length, 3);
    assert.equal(p.options[0].capacity, 10);

    const page = await req(`/g/${CID_A}/events/presets`, { cookie: cookieOf.staff });
    assert.match(page.body, /Potluck/);

    const del = await post(`/g/${CID_A}/events/presets/${p.id}/delete`, "staff", {});
    assert.ok(qsOf(del.location).ok, del.location);
    assert.ok(!api.listEventPresets(CID_A).some((x) => x.id === p.id));
  });

  // ── series + scheduled pages ─────────────────────────────────────────────

  it("series page lists a seeded series; skip advances the cursor; stop ends it", async () => {
    const ev = seedEvent({ title: "Weekly Recur", status: "posted", messageId: "720000000000009005" });
    const series = api.createEventSeries({
      communityId: CID_A,
      templateEventId: ev.id,
      cadence: "weekly",
      weekdays: [2],
      timeOfDayMin: 1200,
      endMode: "never",
      nextOccurrenceAt: Number(ev.start_at) + 7 * 86_400_000,
      createdBy: USER_STAFF,
    });
    assert.ok(series.ok !== false, JSON.stringify(series));
    const id = series.series.id;
    api.updateEvent(ev.id, { series_id: id });

    const page = await req(`/g/${CID_A}/events/series`, { cookie: cookieOf.staff });
    assert.match(page.body, /template #/);
    assert.match(page.body, new RegExp(String(id)));

    // the next unposted OCCURRENCE sitting at the cursor is what skip drops
    const occ = seedEvent({
      title: "Weekly Recur #2",
      status: "draft",
      startAt: Number(ev.start_at) + 7 * 86_400_000,
    });
    api.updateEvent(occ.id, { series_id: id });

    const before = api.getEventSeries(id);
    const skip = await post(`/g/${CID_A}/events/series/${id}/skip`, "staff", {});
    assert.ok(qsOf(skip.location).ok, skip.location);
    const after = api.getEventSeries(id);
    assert.ok(Number(after.next_occurrence_at) > Number(before.next_occurrence_at));
    assert.equal(api.getEventById(occ.id).status, "skipped", "occurrence parked");

    const stop = await post(`/g/${CID_A}/events/series/${id}/stop`, "staff", {});
    assert.ok(qsOf(stop.location).ok, stop.location);
    assert.equal(api.getEventSeries(id).status, "stopped");
  });

  it("scheduled-posts page lists queued drafts and failed-post drafts", async () => {
    const s1 = seedEvent({ title: "Queued Post", status: "draft" });
    api.updateEvent(s1.id, { post_at: H() + 60_000 });
    const { res, body } = await req(`/g/${CID_A}/events/scheduled`, { cookie: cookieOf.staff });
    assert.equal(res.status, 200);
    assert.match(body, /Queued Post/);
    assert.match(body, /Post now/);
  });

  // ── fake-client flows ─────────────────────────────────────────────────────

  it("with a fake client: publish posts, edit runs the service path, organizer add grants the role", async () => {
    const sent = [];
    const grants = [];
    const attendeeRoleId = "725000000000000055";
    const edits = [];

    const fakeChannel = {
      id: "710000000000000011",
      guild: null,
      send: async (payload) => {
        sent.push(payload);
        return {
          id: "900000000000000001",
          edit: async (p) => {
            edits.push(p);
            return { id: "900000000000000001", content: null };
          },
        };
      },
      messages: {
        fetch: async (id) => ({
          id,
          content: null,
          author: { id: "BOT" },
          edit: async (p) => {
            edits.push(p);
            return { id, content: null };
          },
        }),
      },
      permissionsFor: () => ({ has: () => true }),
    };

    const mkMember = (userId, roleIds) => {
      const cache = new Map([["@everyone", {}], ...roleIds.map((r) => [r, {}])]);
      return {
        id: userId,
        roles: {
          cache,
          add: async (r) => {
            grants.push([userId, r]);
            cache.set(r, {});
          },
          remove: async (r) => {
            grants.push([userId, `-${r}`]);
            cache.delete(r);
          },
        },
      };
    };

    const staffMember = mkMember(USER_STAFF, [ROLE_JUNIOR]);
    const adminMember = mkMember(USER_ADMIN, []);
    adminMember.permissions = { has: () => true }; // simulate ManageGuild member
    const guestMember = mkMember(USER_GUEST, []);

    const guild = {
      id: GUILD_A,
      members: {
        cache: new Map([
          ["BOT", { id: "BOT", roles: { cache: new Map(), highest: { position: 9 } } }],
          [USER_STAFF, staffMember],
          [USER_ADMIN, adminMember],
          [USER_GUEST, guestMember],
        ]),
        me: { id: "BOT", roles: { cache: new Map(), highest: { position: 9 } } },
        fetch: async (id) => guild.members.cache.get(id) ?? null,
      },
      channels: { cache: new Map([[fakeChannel.id, fakeChannel]]) },
      roles: {
        cache: new Map([[attendeeRoleId, { id: attendeeRoleId, name: "Raiders", position: 3 }]]),
        fetch: async (id) => guild.roles.cache.get(id) ?? null,
        create: async () => ({ id: attendeeRoleId, name: "temp", position: 3 }),
      },
    };
    fakeChannel.guild = guild;

    fakeClient = {
      user: { id: "BOT" },
      guilds: { cache: new Map([[GUILD_A, guild]]) },
      channels: { cache: new Map([[fakeChannel.id, fakeChannel]]) },
    };

    // draft with an EXISTING attendee role so no role-creation surface is needed
    const ev = seedEvent({
      title: "Fake Client Post",
      status: "draft",
      attendee_role_existing: 1,
      attendee_role_id: attendeeRoleId,
    });

    const pub = await post(`/g/${CID_A}/events/${ev.id}/publish`, "staff", {});
    if (pub.res.status !== 302)
      throw new Error(`publish status=${pub.res.status} body=${pub.body.slice(0, 400)} loc=${pub.location}`);
    const pq = qsOf(pub.location);
    assert.ok(pq.ok, `publish should succeed: ${pub.location}`);
    assert.equal(sent.length, 1);
    const fresh = api.getEventById(ev.id);
    assert.equal(fresh.status, "posted");
    assert.equal(fresh.message_id, "900000000000000001");

    // edit via service path (member resolved from cache): description sync
    const ed = await post(`/g/${CID_A}/events/${ev.id}/edit`, "staff", {
      description: "synced from the console",
    });
    const eq = qsOf(ed.location);
    assert.ok(eq.ok, `edit flash: ${ed.location}`);
    assert.equal(api.getEventById(ev.id).description, "synced from the console");
    assert.ok(edits.length >= 1, "Discord message edit() was called by refresh");

    // organizer add: signup + role grant through the fake member
    const yes = api.listEventOptions(ev.id).find((o) => o.label === "Yes");
    const add = await post(`/g/${CID_A}/events/${ev.id}/signups/add`, "staff", {
      user_id: USER_GUEST,
      option_id: String(yes.id),
    });
    const aq = qsOf(add.location);
    assert.ok(aq.ok, `organizer add flash: ${add.location}`);
    assert.ok(
      grants.some(([u, r]) => u === USER_GUEST && r === attendeeRoleId),
      `role granted: ${JSON.stringify(grants)}`,
    );

    // remove again
    const rem = await post(`/g/${CID_A}/events/${ev.id}/signups/remove`, "staff", {
      user_id: USER_GUEST,
      option_id: String(yes.id),
    });
    assert.ok(qsOf(rem.location).ok, rem.location);
    assert.ok(grants.some(([u, r]) => u === USER_GUEST && r === `-${attendeeRoleId}`));

    // retry-sync hits refreshEventMessages through the fake
    const sync = await post(`/g/${CID_A}/events/${ev.id}/retry-sync`, "staff", {});
    const sq = qsOf(sync.location);
    assert.ok(sq.ok, `retry-sync flash: ${sync.location}`);

    fakeClient = null;
  });

  // ── activity + audit mirror ───────────────────────────────────────────────

  it("staff mutations write event activity AND admin_audit", async () => {
    const ev = seedEvent({ title: "Audit Trail", status: "draft" });
    await post(`/g/${CID_A}/events/${ev.id}/reminders/add`, "staff", { minutes: "20" });
    await post(`/g/${CID_A}/events/${ev.id}/archive`, "staff", {});

    const activity = api.listEventActivity(ev.id, 50);
    assert.ok(
      activity.some((a) => a.action === "reminder_added" || a.action === "reminder_armed" || /reminder/.test(a.action)),
      `reminder activity present: ${activity.map((a) => a.action).join(",")}`,
    );

    const audits = api.listAdminAudit(CID_A, { limit: 40 });
    const actions = audits.map((a) => a.action);
    assert.ok(actions.includes("events.reminder_add"), actions.join(","));
    assert.ok(actions.includes("events.archive"), actions.join(","));
  });
});
