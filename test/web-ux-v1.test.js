/**
 * UX v1.1 (roadmap/web-admin.md §8.15):
 *  - GET / = ROOT GUILD LIST (anon ⇒ login redirect; staff ⇒ own guild rows
 *    with tier badges; no staff guilds ⇒ honest empty state). The legacy
 *    "/" transcript-archive alias is GONE (archive lives on /t — pinned by
 *    test/web-http-net.test.js).
 *  - Sidebar nav in the guild shell: tier-gated items + active highlight.
 *  - Cache-only member NAMES on dashboard / ticket actions pages (hit ⇒
 *    display name, miss ⇒ raw id — never a fetch on a request path).
 *
 * Harness mirrors test/web-routes-dashboard.test.js: real Express app on an
 * ephemeral port, real SQLite, fake Discord via the injected resolver.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fsx = require("node:fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

const SESSION_SECRET = "test-ux11-…cret";

const GUILD_A = "700000000000000011"; // bot + all users
const GUILD_USER_ONLY = "700000000000000013"; // user guild WITHOUT the bot
const ROLE_JUNIOR = "ux11-role-junior";
const ROLE_SENIOR = "ux11-role-senior";

const USER_ADMIN = "800000000000000021"; // owner ⇒ admin
// #405 (C1-6): the system-wide Web-sessions console is gated by a GLOBAL
// allow-list; this harness's admin is the deployment operator.
process.env.WEB_GLOBAL_ADMIN_IDS = USER_ADMIN;

const USER_STAFF = "800000000000000022"; // junior staff ⇒ staff
const USER_SENIOR = "800000000000000023"; // senior staff ⇒ senior
const USER_NOWHERE = "800000000000000024"; // in NO bot guild ⇒ empty state

const CREATOR_ID = "800000000000000090"; // ticket creator (cached in fake client)
const CREATOR_NAME = "CachedDisplayName";

const ENV_KEYS = ["SESSION_SECRET", "DB_PATH", "DATA_DIR"];

describe("web UX v1.1 (root guild list, sidebar nav, member names)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  let tmpDir;
  let savedEnv;
  let CID_A; // internal community id for GUILD_A (assigned in before() after loadDb)
  /** @type {import("http").Server} */
  let server;
  let base;
  const cookieOf = {};

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if (userId === USER_ADMIN) {
        return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" }];
      }
      if (userId === USER_STAFF || userId === USER_SENIOR) {
        return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: false, permissions: "0" }];
      }
      // USER_NOWHERE: only a guild the bot is NOT in.
      return [{ id: GUILD_USER_ONLY, name: "UserOnly", icon: null, owner: false, permissions: "0" }];
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

  /** Cache-only fake bot client (Map-backed like discord.js v14 Collection). */
  const fakeClient = {
    guilds: {
      cache: new Map([
        [
          GUILD_A,
          { members: { cache: new Map([[CREATOR_ID, { displayName: CREATOR_NAME }]]) } },
        ],
      ]),
    },
  };

  let appMod;
  let sessionPolicy;
  let tokens;

  function mkSession(userId) {
    const s = sessionPolicy.createSession({ userId, discordTag: `${userId}#0001` });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: JSON.stringify([
        { id: GUILD_A, name: "Alpha HQ", icon: null, owner: userId === USER_ADMIN, permissions: userId === USER_ADMIN ? "0" : "104324673" },
      ]),
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
      botGuilds: async () => [GUILD_A],
      now: Date.now,
      ttlMs: 60_000,
    });
    const app = appMod.createWebApp({
      guildAccess: resolver,
      botGuilds: async () => [GUILD_A],
      getClient: () => fakeClient,
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
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
    CID_A = require("./helpers/env").communityKey(GUILD_A);
    process.env.SESSION_SECRET = SESSION_SECRET;

    appMod = require("../src/web/app");
    sessionPolicy = require("../src/web/auth/sessions");
    tokens = require("../src/web/auth/tokens");

    api.addStaffRole(CID_A, ROLE_JUNIOR, "junior");
    api.addStaffRole(CID_A, ROLE_SENIOR, "senior");

    cookieOf.admin = `web_session=${mkSession(USER_ADMIN)}`;
    cookieOf.staff = `web_session=${mkSession(USER_STAFF)}`;
    cookieOf.senior = `web_session=${mkSession(USER_SENIOR)}`;
    cookieOf.nowhere = `web_session=${mkSession(USER_NOWHERE)}`;

    api.createTicket({
      communityId: CID_A,
      creatorUserId: CREATOR_ID,
      channelId: "ch-ux11-1",
      reason: "ux11 seeded ticket",
    });

    await mountApp();
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (tmpDir) {
      try {
        fsx.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // -- root page ---------------------------------------------------------

  it("anon GET / ⇒ same login redirect framing as the ticket surface", async () => {
    const { res, body } = await req("/");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/auth/login");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(body, "");
  });

  it("staff GET / ⇒ 200 guild list with guild name + console link", async () => {
    const { res, body } = await req("/", cookieOf.staff);
    assert.equal(res.status, 200);
    assert.match(body, /Your guilds/);
    assert.match(body, /Alpha HQ/);
    assert.ok(body.includes(`/g/${CID_A}`), "console link present");
    assert.ok(!body.includes("Ticket archive"), "no archive index on /");
  });

  it("root rows carry tier badges (admin sees admin badge on own row)", async () => {
    const { body } = await req("/", cookieOf.admin);
    assert.match(body, /badge-tier-admin/);
    const { body: staffBody } = await req("/", cookieOf.staff);
    assert.match(staffBody, /badge-tier-staff/);
  });

  it("no staff guilds ⇒ 200 honest empty state, never 404", async () => {
    const { res, body } = await req("/", cookieOf.nowhere);
    assert.equal(res.status, 200);
    assert.match(body, /empty-state/);
    assert.match(body, /do not manage any guild/i);
  });

  // -- sidebar nav ---------------------------------------------------------

  it("staff shell nav: common pages only — no system/audit/grant/ticket-actions", async () => {
    const { body } = await req(`/g/${CID_A}`, cookieOf.staff);
    assert.ok(body.includes('class="bs-nav"'), "sidebar rendered");
    assert.ok(body.includes(`/g/${CID_A}/settings`), "settings link");
    assert.ok(body.includes(`/g/${CID_A}/users`), "users link");
    assert.ok(!body.includes(`/g/${CID_A}/system"`), "system hidden for staff");
    assert.ok(!body.includes(`/g/${CID_A}/audit"`), "audit hidden for staff");
    assert.ok(!body.includes(`/g/${CID_A}/xp/grant"`), "grant xp hidden for staff");
    assert.ok(!body.includes(`/g/${CID_A}/tickets"`), "ticket actions hidden for staff");
  });

  it("admin shell nav: everything including admin-only items", async () => {
    const { body } = await req(`/g/${CID_A}`, cookieOf.admin);
    for (const suffix of ["/system", "/audit", "/xp/grant", "/settings", "/integrations"]) {
      assert.ok(body.includes(`/g/${CID_A}${suffix}"`), `admin sees ${suffix}`);
    }
  });

  it("senior shell nav: ticket actions visible, admin items still hidden", async () => {
    const { body } = await req(`/g/${CID_A}`, cookieOf.senior);
    assert.ok(body.includes(`/g/${CID_A}/tickets"`), "senior sees ticket actions");
    assert.ok(!body.includes(`/g/${CID_A}/system"`), "system still admin-only");
  });

  it("active item highlighted by request path", async () => {
    const { body } = await req(`/g/${CID_A}/settings`, cookieOf.staff);
    assert.match(
      body,
      new RegExp(`href="/g/${CID_A}/settings" class="active" aria-current="page"`)
    );
  });

  it("root page renders NO sidebar (no guild context)", async () => {
    const { body } = await req("/", cookieOf.staff);
    assert.ok(!body.includes('class="bs-nav"'), "no nav on the lobby page");
    assert.ok(!body.includes('data-guild-switcher'), "no switcher on the lobby page");
  });

  // -- member names (cache-only) --------------------------------------------

  it("dashboard: cached creator id renders the display name (miss ⇒ raw id)", async () => {
    const { body } = await req(`/g/${CID_A}`, cookieOf.staff);
    assert.ok(body.includes(CREATOR_NAME), "cached member shows display name");
    assert.ok(body.includes(`title="${CREATOR_ID}"`), "id stays discoverable via title");
  });

  it("ticket actions page: cached ids render names for creator/claimant", async () => {
    const { body } = await req(`/g/${CID_A}/tickets`, cookieOf.senior);
    assert.equal((await fetch(`${base}/g/${CID_A}/tickets`, { headers: { cookie: cookieOf.senior } })).status, 200);
    assert.ok(body.includes(CREATOR_NAME), "creator display name on actions page");
  });

  it("dashboard without a live client still renders raw ids (dark-boot honesty)", async () => {
    // Reboot WITHOUT getClient — miss ⇒ raw ids, no crash.
    const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
    const resolver = createGuildAccessResolver({
      discord: fakeDiscord,
      botGuilds: async () => [GUILD_A],
      now: Date.now,
      ttlMs: 60_000,
    });
    const app = appMod.createWebApp({
      guildAccess: resolver,
      botGuilds: async () => [GUILD_A],
    });
    const dark = http.createServer(app);
    dark.listen(0, "127.0.0.1");
    await once(dark, "listening");
    try {
      const darkBase = `http://127.0.0.1:${dark.address().port}`;
      const res = await fetch(`${darkBase}/g/${CID_A}`, {
        headers: { cookie: cookieOf.staff },
        redirect: "manual",
      });
      const body = await res.text();
      assert.equal(res.status, 200);
      assert.ok(body.includes(CREATOR_ID), "uncached ⇒ raw id rendered");
      assert.ok(!body.includes(CREATOR_NAME), "no name without a client cache");
    } finally {
      dark.close();
      await once(dark, "close");
    }
  });

  it("#642 staff shell HTML: Menu button, skip link, breadcrumb — no nav-collapsed", async () => {
    const { res, body } = await req(`/g/${CID_A}/settings`, cookieOf.staff);
    assert.equal(res.status, 200);
    assert.ok(body.includes('class="skip-link" href="#content"'), "skip link first focusable");
    assert.ok(body.includes("data-nav-toggle"), "Menu button rendered");
    assert.ok(body.includes('aria-controls="shell-nav"'), "Menu wired to the nav id");
    assert.ok(body.includes('id="shell-nav"'), "sidebar carries the aria-controls target id");
    assert.ok(body.includes('class="breadcrumb"'), "breadcrumb in the content column");
    assert.ok(body.includes('id="content"'), "main is the skip-link target");
    assert.ok(!body.includes("nav-collapsed"), "server HTML never contains nav-collapsed");
    assert.ok(!body.includes("<noscript"), "no <noscript> block (JS-is-on console, #642)");
    assert.ok(!body.includes("noscript-hint"), "no .noscript-hint left");
  });

  // -- mobile pass (Phase 4 §8.8, 360–430px) ---------------------------------
  // Render-assertion style like every suite above: pin the class/markup
  // hooks the phone CSS attaches to, plus the responsive Chart.js container
  // contract as authored. #642 rebuilt the phone shell: the nav COLLAPSES
  // behind a Menu button at ≤719px (the old ≤880px horizontal strip is
  // gone) and the shell grid queries are 719 / 720–1099 / 1100+.

  const STYLES_PATH = require("node:path").join(
    __dirname,
    "../src/web/assets/page.css"
  );
  const PRIMITIVES_PATH = require("node:path").join(
    __dirname,
    "../src/web/assets/primitives.css"
  );
  const APP_PATH = require("node:path").join(__dirname, "../src/web/public/app.js");

  /** Full text of every @media block whose prelude matches `re`. */
  function mediaBlocks(css, re) {
    const out = [];
    const rx = /@media\s+([^{]+)\{/g;
    let m;
    while ((m = rx.exec(css)) !== null) {
      if (!re.test(m[1])) continue;
      let depth = 1;
      let i = rx.lastIndex;
      while (i < css.length && depth > 0) {
        const c = css[i];
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        i += 1;
      }
      out.push(css.slice(rx.lastIndex, i));
    }
    return out;
  }

  it("mobile nav strip: session pages are reachable for staff + admin", async () => {
    // The collapsed phone nav must carry the NEW destinations — otherwise
    // a phone user cannot reach them at all.
    const { body: staffBody } = await req(`/g/${CID_A}`, cookieOf.staff);
    assert.ok(staffBody.includes(`/g/${CID_A}/sessions"`), "Your sessions link (staff)");
    assert.ok(staffBody.includes("Your sessions"), "Your sessions label");
    const { body: adminBody } = await req(`/g/${CID_A}`, cookieOf.admin);
    assert.ok(adminBody.includes(`/g/${CID_A}/system/sessions"`), "Web sessions link (admin)");
    assert.ok(adminBody.includes("Web sessions"), "Web sessions label");
  });

  it("mobile: dashboard chart canvases sit in their own position:relative boxes", async () => {
    // Chart.js responsive contract (vendored 4.5.1 docs): container is
    // dedicated to the canvas only — the phone pass relies on this box for
    // width:100% + explicit height re-rendering.
    const { body } = await req(`/g/${CID_A}`, cookieOf.staff);
    const boxes = body.match(/<div class="chart-box"/g) || [];
    assert.equal(boxes.length, 2, "both chart containers rendered");
    assert.equal(
      (body.match(/<div class="chart-box"[^>]*>\s*<canvas/g) || []).length,
      2,
      "each .chart-box wraps ONLY its canvas"
    );
  });

  it("mobile: your-sessions page renders its table panel + revoke controls", async () => {
    const { res, body } = await req(`/g/${CID_A}/sessions`, cookieOf.staff);
    assert.equal(res.status, 200);
    assert.ok(body.includes("sessions-panel"), "panel wrapper (mobile scroll hook)");
    assert.ok(body.includes("bs-table sessions-table"), "compact table class");
    assert.ok(body.includes('data-density="compact"'), "sessions use the compact row");
    assert.ok(body.includes("ticket-inline-form"), "inline PRG revoke form");
    assert.ok(body.includes("Revoke"), "revoke control present");
  });

  it("mobile: admin web-sessions page renders its table panel + revoke controls", async () => {
    const { res, body } = await req(`/g/${CID_A}/system/sessions`, cookieOf.admin);
    assert.equal(res.status, 200);
    assert.ok(body.includes("system-sessions-panel"), "panel wrapper (mobile scroll hook)");
    assert.ok(body.includes("bs-table system-sessions-table"), "compact table class");
    assert.ok(body.includes("Revoke"), "revoke control present");
  });

  it("mobile: in-shell archive wraps the table in the scroll box", async () => {
    const { res, body } = await req(`/g/${CID_A}/t`, cookieOf.staff);
    assert.equal(res.status, 200);
    assert.ok(body.includes('class="table-scroll"'), "archive table inside .table-scroll");
  });

  it("mobile: page.css carries the phone-pass rules (#642 contract)", () => {
    const css = fsx.readFileSync(STYLES_PATH, "utf8");
    const primitives = fsx.readFileSync(PRIMITIVES_PATH, "utf8");

    // #642 INVERTS the old ≤880px nav strip: the phone sidebar COLLAPSES
    // behind the Menu button instead of turning into a horizontal strip.
    // #711 moved the shell grid into primitives.css. Neither sheet may
    // put the nav in a row under a max-width query.
    for (const sheet of [css, primitives]) {
      assert.doesNotMatch(
        sheet,
        /@media \(max-width: 880px\)[\s\S]*?\.bs-nav\s*\{[^}]*flex-direction:\s*row/,
        "nav is not a horizontal strip ≤880px (block deleted, #642)"
      );
      assert.equal(
        mediaBlocks(sheet, /max-width:\s*880px/).filter((b) =>
          /\.(shell-nav|bs-nav)[^{]*flex-direction:\s*row/.test(b)
        ).length,
        0,
        "no nav flex-direction:row inside any max-width:880px query"
      );
      assert.equal(
        mediaBlocks(sheet, /max-width:\s*720px/).filter((b) =>
          /\.(shell-nav|bs-nav)[^{]*flex-direction:\s*row/.test(b)
        ).length,
        0,
        "no nav flex-direction:row inside any max-width:720px query"
      );
    }
    assert.doesNotMatch(css, /\.shell-(body|nav|bar|main|footer)\b/, "legacy shell chrome stays out of page.css");

    // Phone contract (max-width: 719px) now lives on the forge shell:
    // Menu shows, one-column grid, the nav hides ONLY under
    // body.nav-collapsed, and stays a column.
    const phoneShell = mediaBlocks(primitives, /max-width:\s*719px/).join("\n");
    assert.match(phoneShell, /\.nav-toggle\s*\{[^}]*display:\s*inline-flex/, "Menu button shown on phones");
    assert.match(phoneShell, /\.bs-shell\s*\{[^}]*grid-template-columns:\s*1fr/, "one-column shell on phones");
    assert.match(
      phoneShell,
      /body\.nav-collapsed\s+\.bs-nav\s*\{[^}]*display:\s*none/,
      "CSS hides .bs-nav only under body.nav-collapsed"
    );
    assert.match(phoneShell, /\.bs-nav\s*\{[^}]*flex-direction:\s*column/, "phone nav is a column");
    const phone = mediaBlocks(css, /max-width:\s*719px/).join("\n");
    // .table-stack phone block: thead is CLIPPED (never display:none) and
    // cells carry fixed-column titles via td::before content:attr(data-label).
    assert.match(
      phone,
      /\.table-stack[^{]*thead\s*\{[^}]*(clip:|clip-path:)/,
      "stacked tables clip the thead instead of display:none"
    );
    assert.doesNotMatch(phone, /\.table-stack[^{]*thead\s*\{[^}]*display:\s*none/, "thead never display:none");
    assert.match(
      phone,
      /\.table-stack[^{]*td::before\s*\{[^}]*content:\s*attr\(data-label\)/,
      "stacked cells labelled by fixed data-label titles"
    );

    // The nav is never unconditionally hidden: every display:none rule
    // targeting .bs-nav (at line start) must be body.nav-collapsed-gated.
    assert.doesNotMatch(
      primitives,
      /(^|[,{}])\s*\.bs-nav\b[^{}\n]*\{[^}]*display:\s*none/,
      ".bs-nav visible unless body.nav-collapsed"
    );

    // Tablet (720–1099): 13rem rail + sticky COLUMN.
    const tablet = mediaBlocks(primitives, /max-width:\s*1099px/).join("\n");
    assert.match(tablet, /\.bs-shell\s*\{[^}]*grid-template-columns:\s*13rem/, "tablet rail is 13rem");
    assert.match(tablet, /\.bs-nav\s*\{[^}]*flex-direction:\s*column/, "tablet nav is a sticky column");

    // Desktop (1100+): 15.5rem rail.
    const desktop = mediaBlocks(primitives, /min-width:\s*1100px/).join("\n");
    assert.match(desktop, /\.bs-shell\s*\{[^}]*grid-template-columns:\s*15\.5rem/, "desktop rail is 15.5rem");

    // .table-scroll scrolls at ALL widths (outside every media query). The
    // old ≤480 ".panel, .moderation, .table-scroll" scroller list is GONE:
    // .panel is a card, not a scroller.
    const topLevel = css.replace(/@media[^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
    assert.match(topLevel, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto/, "table scroller at all widths");
    assert.doesNotMatch(topLevel, /(^|[^-\w.])\.panel\s*\{[^}]*overflow-x/, ".panel is not a scroller");
    assert.doesNotMatch(
      css,
      /\.panel,\s*\.moderation,\s*\.table-scroll\s*\{[^}]*overflow-x/,
      "the old mobile scroller selector list is deleted"
    );

    // Table cells still wrap aggressively; pager bars still wrap.
    assert.match(
      css,
      /\.list-table th,\s*\.list-table td\s*\{[^}]*overflow-wrap:\s*anywhere/,
      "table cells wrap aggressively at phone width"
    );
    assert.match(css, /\.leaderboard-pager\s*\{[^}]*flex-wrap:\s*wrap/, "pager bars wrap on phones");

    // PRG write forms (plus the shared .form-row) stack INSIDE the 719px
    // query — spec moved them out of the old ≤480 block.
    const stack = phone.match(
      /\.settings-form,\s*\.staff-mutate-form,\s*\.integ-write-form,\s*\.integ-write-fields,\s*\.form-row\s*\{[^}]*\}/
    );
    assert.ok(stack, "write-form stack carries all migrated selectors");
    assert.match(stack[0], /flex-direction:\s*column/, "write forms stack at phone width (every control reachable)");
    const legacy480 = mediaBlocks(css, /max-width:\s*480px/).join("\n");
    assert.doesNotMatch(legacy480, /flex-direction:\s*column/, "the form stack no longer lives in a ≤480px block");
  });

  it("mobile: page.css keeps the Chart.js container contract (canvas unstyled)", () => {
    const css = fsx.readFileSync(STYLES_PATH, "utf8");
    assert.match(
      css,
      /\.dashboard-charts \.chart-box\s*\{[^}]*position:\s*relative/,
      "chart container is the positioned box Chart.js watches"
    );
    assert.match(
      css,
      /\.dashboard-charts \.chart-box\s*\{[^}]*width:\s*100%/,
      "chart fills the panel width at any viewport"
    );
    assert.match(
      css,
      /\.dashboard-charts \.chart-box\s*\{[^}]*height:\s*\d+px/,
      "explicit container height (predictable vertical space)"
    );
    assert.ok(!/canvas\s*\{/.test(css), "canvas stays UNSIZED/UNSTYLED (library-managed)");
    assert.ok(!/\.chart-box\s+canvas/.test(css), "no canvas-level styling smuggled in");
  });

  it("mobile: app.js keeps the responsive chart options + resize debounce", () => {
    const src = fsx.readFileSync(APP_PATH, "utf8");
    assert.ok(src.includes("responsive: true"), "charts track the container");
    assert.ok(src.includes("maintainAspectRatio: false"), "container CSS owns the height");
    assert.equal(
      (src.match(/resizeDelay:\s*150/g) || []).length,
      2,
      "both charts debounce mobile URL-bar resize storms"
    );
  });
});
