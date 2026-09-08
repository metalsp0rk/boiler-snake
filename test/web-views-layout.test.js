/**
 * Subtask 11 — view layer net (roadmap/web-admin.md §8.2 escaped-by-default
 * templates, §8.7 CSP/nonce/static, §8.8 Phase 0c guild-switcher shell).
 * FULLY OFFLINE: fake discordApi objects + real session rows on a temp
 * SQLite (the loadDb() pattern of the tier-middleware net), real
 * createGuildAccessResolver + createWebApp, ephemeral port + fetch,
 * node --test only.
 *
 * Suites:
 *  A. escape.js — the escaped-by-default contract under XSS probes
 *     (text + attribute positions, nesting, arrays, idempotence);
 *  B. layout components — shell renders user/guild payloads escaped, zero
 *     on* handlers, nonce on every <script>, logout _csrf, tier whitelist,
 *     no off-site URLs;
 *  C. HTTP net — anonymous /g/* redirect (oracle parity), Console shell
 *     200 + switcher = bot∩user exactly, tier badge, staff via real
 *     staff_roles, every 404/deny still the PLAIN "Not found" (decision:
 *     no divergence inside /g/*), CSP header matrix + per-response nonce
 *     uniqueness + nonce/script match, /static serving + immutable cache +
 *     traversal/dotfile gates, /t + /health untouched;
 *  D. guildAccess.listGuilds — switcher source (sorted, id-fallback names,
 *     degraded fallback keeps names, anon reauth flag);
 *  E. vendored htmx — version banner first bytes, size floor; app.js
 *     hx-headers wiring present.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const path = require("path");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// ---------------------------------------------------------------------------
// loadDb() FIRST: clears the src require cache and binds DB_PATH to a temp
// file, so every src module below binds the test DB (same doctrine as
// test/web-tier-middleware.test.js).
// ---------------------------------------------------------------------------
const { api, tmpDir } = loadDb();

const { html, raw, esc, escapeHtml, isSafe, SafeString } = require("../src/web/views/escape");
const { renderLayout, renderShellPage, renderShellError } = require("../src/web/views/layout");
const { tierBadge } = require("../src/web/views/components");
const { createWebApp } = require("../src/web/app");
const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const { deriveCsrfToken } = require("../src/web/middleware/csrf");

// Clearly-fake placeholder secret (AGENTS.md: never real-looking secrets).
const SESSION_SECRET = "test-vi…l-pq";

const USER_ADMIN = "428190222345678901"; // owner of A → admin fast path
const USER_STAFF = "428190222345678902"; // junior staff role in A
const USER_PLAIN = "428190222345678903"; // in A, no staff role → 404

const GUILD_A = "100000000000000011"; // bot + every test user
const GUILD_XSS = "400000000000000044"; // bot + admin, malicious NAME
const GUILD_B = "200000000000000022"; // nobody's (cross-guild probe target)
const GUILD_USER_ONLY = "300000000000000033"; // user's, bot NOT in it
const GUILD_BOT_ONLY = "500000000000000055"; // bot's, user NOT in it
const GUILD_NONAME = "600000000000000066"; // bot + admin, name missing

const ROLE_JUNIOR = "700000000000000077";

const XSS_TAG = `<script>alert('tag')</script>`;
const XSS_NAME = `<img src=x onerror="alert(1)">`;
const ATTRProbe = `" onmouseover="steal()`;

const ENV_KEYS = [
  "SESSION_SECRET",
  "CLIENT_SECRET",
  "PUBLIC_BASE_URL",
  "PUBLIC_HTTP_PORT",
  "TICKET_HTTP_PORT",
  "TICKET_PUBLIC_BASE_URL",
  "WEB_RATE_LIMIT_AUTH_MAX",
  "WEB_RATE_LIMIT_AUTH_USER_MAX",
  "WEB_RATE_LIMIT_MUTATION_MAX",
  "WEB_TIER_CACHE_TTL_MS",
];
let savedEnv;

const PUBLIC_DIR = path.join(__dirname, "..", "src", "web", "public");
const VENDOR_FILE = path.join(PUBLIC_DIR, "vendor", "htmx.2.0.10.min.js");

before(() => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.SESSION_SECRET = SESSION_SECRET;
  for (const k of ENV_KEYS.slice(1)) delete process.env[k];
  // This net fires far more requests/min than a human admin would; the
  // rate-limiter itself is pinned by the subtask-08 net, not here.
  process.env.WEB_RATE_LIMIT_AUTH_MAX = "100000";
  process.env.WEB_RATE_LIMIT_AUTH_USER_MAX = "100000";
  process.env.WEB_RATE_LIMIT_MUTATION_MAX = "100000";
  api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv?.[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ===========================================================================
// A. escape.js — escaped-by-default contract (§8.2)
// ===========================================================================
describe("escape.js (escaped-by-default helper)", () => {
  it("escapeHtml covers & < > \" ' exactly", () => {
    assert.equal(escapeHtml(`<a href="x">&'`), `&lt;a href=&quot;x&quot;&gt;&amp;&#39;`);
    // & first: the escape of & must never be double-encoded.
    assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  });

  it("interpolated user strings render escaped — <script> probe is inert", () => {
    const out = String(html`<p>${XSS_TAG}</p>`);
    assert.ok(out.includes("&lt;script&gt;"), "payload encoded, not live");
    assert.ok(!out.includes("<script>"), "no raw payload tag survives");
  });

  it("attribute-position payloads cannot break out of the quotes", () => {
    const evil = `x${ATTRProbe}`;
    const out = String(html`<input value="${evil}"/>`);
    assert.ok(!out.includes(ATTRProbe), "raw quote+handler sequence never appears");
    // Exactly one attribute: the payload rides INSIDE the quoted value as
    // entities — the browser sees no second attribute, so the "handler" is
    // inert text (the substring `onmouseover=` surviving in TEXT position
    // proves nothing; the quote encoding is the security property).
    assert.equal(out, `<input value="x&quot; onmouseover=&quot;steal()"/>`);
    assert.equal(out.match(/"/g).length, 2, "only the surrounding quotes remain");
  });

  it("null/undefined/false render as empty; 0 renders", () => {
    assert.equal(String(html`<i>${null}${undefined}${false}</i>`), "<i></i>");
    assert.equal(String(html`<i>${0}</i>`), "<i>0</i>");
  });

  it("arrays render escaped-by-element", () => {
    const out = String(html`<ul>${[XSS_TAG, "safe"]}</ul>`);
    assert.ok(out.includes("&lt;script&gt;alert(&#39;tag&#39;)&lt;/script&gt;safe"));
  });

  it("nested html`` fragments pass through WITHOUT double-escaping", () => {
    const row = html`<td>${`<b>`}</td>`;
    const table = String(html`<tr>${[row, row]}</tr>`);
    assert.equal(table, "<tr><td>&lt;b&gt;</td><td>&lt;b&gt;</td></tr>");
  });

  it("raw() marks trusted markup safe; esc() is idempotent; branding holds", () => {
    assert.equal(String(html`<b>${raw("<i>x</i>")}</b>`), "<b><i>x</i></b>");
    const once = esc(XSS_TAG);
    assert.equal(String(esc(once)), String(once), "esc(esc(x)) === esc(x)");
    assert.ok(once instanceof SafeString);
    assert.equal(isSafe("<escaped-looking-string>"), false, "plain strings are never safe");
    assert.equal(isSafe(html`x`), true);
  });
});

// ===========================================================================
// B. layout — shell chrome rendered under hostile data (§8.2/§8.7)
// ===========================================================================
/** Minimal Express-shaped req for the pure layout helpers. */
function fakeReq(overrides = {}) {
  return {
    user: { userId: USER_ADMIN, discordTag: "Nice#User" },
    guildAccess: { guildId: GUILD_A, tier: "admin", degraded: false },
    csrfToken: "a".repeat(64),
    res: { locals: { cspNonce: "TESTNONCE123" } },
    ...overrides,
  };
}

const SHELL_GUILDS = [
  { id: GUILD_A, name: `Alpha HQ ${ATTRProbe}` },
  { id: GUILD_XSS, name: XSS_NAME },
];

describe("layout (shell chrome)", () => {
  it("renders user tag + guild names escaped; zero live payload", () => {
    const doc = String(
      renderShellPage(
        fakeReq({ user: { userId: USER_ADMIN, discordTag: XSS_TAG } }),
        { title: "Console", content: html`<p>hi</p>`, guilds: SHELL_GUILDS }
      )
    );
    assert.ok(doc.includes("&lt;script&gt;alert(&#39;tag&#39;)&lt;/script&gt;"));
    assert.ok(doc.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(!doc.includes(`<script>alert('tag')`), "tag payload inert");
    assert.ok(!doc.includes(`<img src=x onerror="`), "name payload inert");
  });

  it("zero on* event-handler attributes anywhere in the shell", () => {
    const doc = String(
      renderShellPage(fakeReq(), { title: "Console", guilds: SHELL_GUILDS })
    );
    assert.equal(doc.match(/\son[a-z]+\s*=\s*["']/i), null, "no inline handlers (§8.7)");
  });

  it("every <script> tag carries the per-response nonce", () => {
    const doc = String(renderShellPage(fakeReq(), { title: "Console" }));
    const scripts = doc.match(/<script[^>]*>/g);
    assert.ok(scripts && scripts.length >= 2, "htmx + app.js");
    for (const tag of scripts) {
      assert.ok(tag.includes(`nonce="TESTNONCE123"`), tag);
      assert.ok(tag.includes('src="/static/'), "external files only");
    }
  });

  it("logout is a POST form with the _csrf field value", () => {
    const doc = String(renderShellPage(fakeReq(), { title: "Console" }));
    assert.match(doc, /<form method="post" action="\/auth\/logout"/);
    assert.ok(doc.includes(`name="_csrf" value="${"a".repeat(64)}"`));
  });

  it("switcher lists exactly the given guilds, marks the current, links /g/<id>", () => {
    const doc = String(
      renderShellPage(fakeReq(), { title: "Console", guilds: SHELL_GUILDS })
    );
    assert.ok(doc.includes(`value="/g/${GUILD_A}" selected`));
    assert.ok(doc.includes(`value="/g/${GUILD_XSS}"`));
    assert.ok(!doc.includes(`/g/${GUILD_B}`), "nothing outside the passed list");
    assert.ok(doc.includes("Alpha HQ"), "plain part of the name survives");
  });

  it("tier badge is whitelisted — junk tier renders no badge", () => {
    assert.ok(String(tierBadge("senior")).includes("badge-tier-senior"));
    for (const junk of ["root", `admin"${XSS_TAG}`, null, undefined, 7]) {
      assert.equal(String(tierBadge(junk)), "", `tier=${JSON.stringify(junk)} renders nothing`);
    }
  });

  it("no off-site URLs: src/href all resolve to this origin", () => {
    const doc = String(
      renderShellPage(fakeReq(), { title: "Console", guilds: SHELL_GUILDS })
    );
    const urls = [...doc.matchAll(/(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(urls.length >= 4, "sanity: shell has assets/links");
    for (const u of urls) {
      assert.ok(
        u.startsWith("/static/") || u.startsWith("/g/") || u === "/health" ||
          u.startsWith("/g/") || u === "/auth/logout" || u.startsWith("/auth/"),
        `unexpected external URL: ${u}`
      );
    }
  });

  it("renderShellError returns a shell page (opt-in Phase 1 helper)", () => {
    const doc = String(renderShellError(fakeReq(), { status: 404, guilds: SHELL_GUILDS }));
    assert.ok(doc.includes("shell-bar"), "shell chrome present");
    assert.ok(doc.includes("Not found"));
    assert.ok(doc.includes("error-body"));
  });

  it("degraded flag surfaces the §8.3 operator banner", () => {
    const doc = String(
      renderShellPage(
        fakeReq({ guildAccess: { guildId: GUILD_A, tier: "admin", degraded: true } }),
        { title: "Console" }
      )
    );
    assert.ok(doc.includes("banner-degraded"));
  });

  it("renderLayout with no session data still renders (defense-in-depth)", () => {
    const doc = String(renderLayout({ title: "T", content: "", nonce: "" }));
    assert.ok(!doc.includes("nonce="), "no nonce → no attribute");
    assert.ok(doc.includes("/health"), "footer present");
  });
});

// ===========================================================================
// C. HTTP net — real app + real session rows + fake Discord, ephemeral port
// ===========================================================================
describe("shell over HTTP (fake Discord, real sessions)", () => {
  /** @type {import("http").Server} */
  let server;
  let base;
  const cookieOf = {}; // role -> cookie header value

  const GUILD_ROWS = {
    [GUILD_A]: { id: GUILD_A, name: "Alpha HQ", icon: null },
    [GUILD_XSS]: { id: GUILD_XSS, name: XSS_NAME, icon: null },
    [GUILD_NONAME]: { id: GUILD_NONAME, name: null, icon: null },
    [GUILD_USER_ONLY]: { id: GUILD_USER_ONLY, name: "UserOnly NoBot", icon: null },
  };
  // The bot serves exactly these (GUILD_BOT_ONLY is bot-only noise):
  const BOT_GUILDS = [GUILD_A, GUILD_XSS, GUILD_NONAME, GUILD_BOT_ONLY];

  const guildsFor = (userId) => {
    if (userId === USER_ADMIN) {
      return [
        { ...GUILD_ROWS[GUILD_A], owner: true, permissions: "0" },
        { ...GUILD_ROWS[GUILD_XSS], owner: false, permissions: "104324673" },
        { ...GUILD_ROWS[GUILD_NONAME], owner: false, permissions: "104324673" },
        { ...GUILD_ROWS[GUILD_USER_ONLY], owner: false, permissions: "0" },
      ];
    }
    if (userId === USER_STAFF || userId === USER_PLAIN) {
      return [{ ...GUILD_ROWS[GUILD_A], owner: false, permissions: "104324673" }];
    }
    return [];
  };

  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      return guildsFor(userId).map((g) => ({ ...g }));
    },
    async getUserGuildMember(token, guildId) {
      const userId = String(token).replace(/^tok-/, "");
      if (guildId === GUILD_A && userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
      if (guildId === GUILD_A) return { roles: [] };
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    },
  };

  function mkSession(userId, discordTag = "Nice#User") {
    const s = sessionPolicy.createSession({ userId, discordTag });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: "[]",
    });
    return s.id;
  }

  before(async () => {
    const resolver = createGuildAccessResolver({
      discord: fakeDiscord,
      botGuilds: async () => BOT_GUILDS,
      now: Date.now,
      ttlMs: 60_000,
    });
    const app = createWebApp({ guildAccess: resolver });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    cookieOf.admin = `web_session=${mkSession(USER_ADMIN, XSS_TAG)}`;
    cookieOf.staff = `web_session=${mkSession(USER_STAFF)}`;
    cookieOf.plain = `web_session=${mkSession(USER_PLAIN)}`;
  });

  after(async () => {
    if (server) {
      server.close();
      await once(server, "close");
    }
  });

  async function get(urlPath, { cookie } = {}) {
    const res = await fetch(`${base}${urlPath}`, {
      redirect: "manual",
      headers: cookie ? { cookie } : undefined,
    });
    const body = await res.text();
    return { res, body, csp: res.headers.get("content-security-policy") || "" };
  }

  /** Raw-socket request (fetch normalizes dot-segments before the wire). */
  function rawGet(urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: server.address().port, method: "GET", path: urlPath },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            })
          );
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  // --- routing / access ------------------------------------------------

  it("anonymous /g/* keeps the byte-identical login redirect (oracle parity)", async () => {
    const { res, body } = await get(`/g/${GUILD_A}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(body, "");
  });

  it("Console page renders in the shell (200, html, no-store, nosniff)", async () => {
    const { res, body } = await get(`/g/${GUILD_A}`, { cookie: cookieOf.admin });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html; charset=utf-8/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.ok(body.includes("Boiler Snake"));
    assert.ok(body.includes("guild-switcher"));
    assert.ok(body.match(/badge-tier-admin/), "current tier badge for the owner");
    assert.ok(body.includes("/health"));
    assert.ok(body.includes("Console"));
  });

  it("switcher = bot∩user EXACTLY: no bot-only, no user-only guilds", async () => {
    const { body } = await get(`/g/${GUILD_A}`, { cookie: cookieOf.admin });
    assert.ok(body.includes(`value="/g/${GUILD_A}"`), "current guild");
    assert.ok(body.includes(`value="/g/${GUILD_XSS}"`), "bot∩user guild");
    assert.ok(body.includes(`value="/g/${GUILD_NONAME}"`), "nameless guild present");
    assert.ok(!body.includes(GUILD_BOT_ONLY), "bot-only guild hidden");
    assert.ok(!body.includes("BotOnlyGhost"), "bot-only guild name hidden");
    assert.ok(!body.includes(GUILD_USER_ONLY), "user-only (no bot) guild hidden");
    assert.ok(!body.includes("UserOnly NoBot"), "user-only guild name hidden");
  });

  it("XSS guild name + XSS user tag render ENCODED in the live page", async () => {
    const { body } = await get(`/g/${GUILD_A}`, { cookie: cookieOf.admin });
    assert.ok(
      body.includes(`&lt;img src=x onerror=&quot;alert(1)&quot;&gt;`),
      "guild name encoded in switcher"
    );
    assert.ok(
      body.includes("&lt;script&gt;alert(&#39;tag&#39;)&lt;/script&gt;"),
      "user tag encoded in header"
    );
    assert.ok(!body.includes(`<img src=x onerror="alert`), "no live img payload");
    assert.ok(!body.includes(`<script>alert`), "no live script payload");
    assert.equal(body.match(/\son[a-z]+\s*=\s*["']/i), null);
  });

  it("staff tier via REAL staff_roles row; logout form carries the session's _csrf", async () => {
    const { res, body } = await get(`/g/${GUILD_A}`, { cookie: cookieOf.staff });
    assert.equal(res.status, 200);
    assert.ok(body.includes("badge-tier-staff"));
    const sessionId = cookieOf.staff.replace("web_session=", "");
    assert.ok(
      body.includes(`name="_csrf" value="${deriveCsrfToken(sessionId, SESSION_SECRET)}"`),
      "logout token matches the middleware derivation"
    );
  });

  it("ALL misses stay the plain generic 404 — inside /g/* too (zero divergence)", async () => {
    const cases = [
      ["/g/oops", cookieOf.admin], // malformed id, live session
      [`/g/${GUILD_B}`, cookieOf.admin], // cross-guild probe
      [`/g/${GUILD_NONAME}`, cookieOf.staff], // not in this viewer's list
      [`/g/${GUILD_A}/tickets`, cookieOf.staff], // unmatched route, valid guild
      [`/g/${GUILD_A}`, cookieOf.plain], // member without any tier
    ];
    for (const [p, cookie] of cases) {
      const { res, body } = await get(p, { cookie });
      assert.equal(res.status, 404, `${p} status`);
      assert.equal(body, "Not found", `${p} body — plain, indistinguishable`);
      assert.match(res.headers.get("content-type"), /^text\/plain/, `${p} type`);
    }
  });

  // --- CSP (§8.7) -------------------------------------------------------

  it("CSP header matrix on the shell page + per-response nonce match", async () => {
    const first = await get(`/g/${GUILD_A}`, { cookie: cookieOf.admin });
    assert.match(first.csp, /default-src 'self'/);
    assert.match(first.csp, /script-src 'self' 'nonce-[A-Za-z0-9_-]{16,}'/);
    assert.match(first.csp, /style-src 'self' 'unsafe-inline'/); // documented concession
    assert.match(first.csp, /frame-ancestors 'none'/);
    assert.match(first.csp, /object-src 'none'/);
    assert.match(first.csp, /base-uri 'self'/);

    const nonce = /nonce-([^;']+)/.exec(first.csp)[1].trim();
    const scriptTags = first.body.match(/<script[^>]*>/g);
    assert.ok(scriptTags.length >= 2);
    for (const tag of scriptTags) {
      assert.ok(tag.includes(`nonce="${nonce}"`), `nonce on every script: ${tag}`);
    }

    const second = await get(`/g/${GUILD_A}`, { cookie: cookieOf.admin });
    const nonce2 = /nonce-([^;']+)/.exec(second.csp)[1].trim();
    assert.notEqual(nonce, nonce2, "fresh nonce per response");
  });

  it("CSP + nosniff also cover the public surface (headers, never bodies)", async () => {
    const health = await get("/health");
    assert.equal(health.res.status, 200);
    assert.equal(health.body, "ok", "legacy body untouched");
    assert.match(health.csp, /frame-ancestors 'none'/);

    const index = await get("/t");
    assert.equal(index.res.status, 200);
    assert.ok(index.body.includes("Archived tickets"), "/t bytes untouched");
    assert.match(index.csp, /default-src 'self'/);

    const auth = await get("/auth/login");
    assert.equal(
      auth.res.headers.get("referrer-policy"),
      "no-referrer",
      "auth pages: no-referrer (§8.7)"
    );
  });

  // --- /static serving ----------------------------------------------------

  describe("/static", () => {
    it("serves app.js + styles.css with immutable cache + nosniff", async () => {
      for (const [file, type] of [
        ["app.js", "text/javascript"],
        ["styles.css", "text/css"],
      ]) {
        const res = await fetch(`${base}/static/${file}`);
        assert.equal(res.status, 200, file);
        assert.match(res.headers.get("content-type"), new RegExp(type));
        assert.match(res.headers.get("cache-control"), /max-age=31536000.*immutable/);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff");
        const expected = fs.statSync(path.join(PUBLIC_DIR, file)).size;
        assert.equal(Number(res.headers.get("content-length")), expected, file);
      }
    });

    it("serves the vendored htmx (banner is the first byte, lib intact)", async () => {
      const res = await fetch(`${base}/static/vendor/htmx.2.0.10.min.js`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.startsWith("/*! htmx.org v2.0.10"), "version-stamped banner first");
      assert.ok(text.includes("var htmx=function", "library bytes follow verbatim"));
    });

    it("HEAD works; unknown paths answer the plain 404", async () => {
      const head = await fetch(`${base}/static/app.js`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      const gone = await get("/static/nope.js");
      assert.equal(gone.res.status, 404);
      assert.equal(gone.body, "Not found");
      const dir = await get("/static/");
      assert.equal(dir.res.status, 404, "directories are not served");
    });

    it("dotfiles are ignored, traversal never escapes the root", async () => {
      const dot = path.join(PUBLIC_DIR, ".subtask11-secret.txt");
      fs.writeFileSync(dot, "must-never-serve");
      try {
        const hidden = await get("/static/.subtask11-secret.txt");
        assert.equal(hidden.res.status, 404, "dotfile ignored even though it exists");
        const enc = await rawGet("/static/%2e%2e%2fpackage.json");
        assert.equal(enc.status, 404, "encoded ../ traversal → generic 404");
        const dbl = await rawGet("/static/%252e%252e%252fpackage.json");
        assert.equal(dbl.status, 404, "double-encoded traversal → generic 404");
        const direct = await rawGet("/static/../public/../package.json");
        assert.equal(direct.status, 404, "raw ../ path → generic 404");
      } finally {
        fs.rmSync(dot, { force: true });
      }
    });

    it("POST /static/* still 405s (methodGate precedes routing)", async () => {
      const res = await fetch(`${base}/static/app.js`, { method: "POST" });
      assert.equal(res.status, 405);
      assert.equal(await res.text(), "Method not allowed");
    });
  });

  // --- /g pages pull the shell onto EVERY Phase-1 route (§8.6): the one
  //     real /g page asserts the full chrome; deep unmatched routes 404 plain
  //     (documented decision above).
});

// ===========================================================================
// D. guildAccess.listGuilds — the switcher's data source (§8.3)
// ===========================================================================
describe("guildAccess.listGuilds", () => {
  const FAR = Date.now() + 3_600_000;

  function harness(cfg = {}) {
    const discord = {
      async getUserGuilds() {
        if (cfg.guildsFail) throw cfg.guildsFail;
        return cfg.userGuilds.map((g) => ({ ...g }));
      },
      async getUserGuildMember() {
        return { roles: [] };
      },
    };
    const store = {
      getWebSessionAuth: () => ({
        id: "sess-list",
        access_token_enc: cfg.token ?? "tok-u",
        token_expires_at: cfg.tokenExpiresAt ?? FAR,
        scopes: "identify guilds",
        guild_snapshot: cfg.snapshot ?? "[]",
      }),
    };
    const resolver = createGuildAccessResolver({
      discord,
      store,
      tokenApi: {
        decryptAccessToken: (env) => {
          if (typeof env === "string" && env.startsWith("tok-")) return env;
          throw new Error("envelope invalid");
        },
      },
      botGuilds: async () => cfg.botGuilds ?? ["100000000000000011", "400000000000000044"],
      now: Date.now,
      ttlMs: 60_000,
    });
    return { resolver, session: { id: "sess-list", userId: "u-list" } };
  }

  it("returns the bot∩user guilds sorted by name with id-fallback labels", async () => {
    const h = harness({
      userGuilds: [
        { id: "100000000000000011", name: "zeta", owner: false, permissions: "0" },
        { id: "400000000000000044", name: null, owner: false, permissions: "0" },
        { id: "300000000000000033", name: "Alpha (no bot)", owner: false, permissions: "0" },
      ],
    });
    const { guilds, degraded, reauth } = await h.resolver.listGuilds(h.session);
    assert.ok(!reauth);
    assert.equal(degraded, false);
    assert.deepEqual(guilds, [
      { id: "400000000000000044", name: "400000000000000044" }, // name → id fallback
      { id: "100000000000000011", name: "zeta" },
    ]);
  });

  it("degraded fallback (Discord down) still lists the SNAPSHOT guilds by name", async () => {
    const h = harness({
      userGuilds: [],
      guildsFail: Object.assign(new Error("down"), { status: 503 }),
      snapshot: JSON.stringify([
        { id: "100000000000000011", name: "Snapshot One", icon: null, owner: false, permissions: "0" },
      ]),
    });
    const { guilds, degraded } = await h.resolver.listGuilds(h.session);
    assert.equal(degraded, true);
    assert.deepEqual(guilds, [{ id: "100000000000000011", name: "Snapshot One" }]);
  });

  it("anonymous / unusable sessions get an empty switcher (never throws)", async () => {
    const h = harness({ userGuilds: [], token: "" });
    const anon = await h.resolver.listGuilds(null);
    assert.deepEqual(anon, { guilds: [], degraded: false, reauth: true });
    const dead = await h.resolver.listGuilds(h.session);
    assert.equal(dead.reauth, true);
    assert.deepEqual(dead.guilds, []);
  });

  it("resolver blow-up fails CLOSED to an empty list (router gate still decides)", async () => {
    const boom = createGuildAccessResolver({
      discord: {
        async getUserGuilds() {
          throw new Error("socket hang up");
        },
      },
      store: {
        getWebSessionAuth: () => {
          throw new Error("db gone");
        },
      },
      tokenApi: { decryptAccessToken: () => "tok-u" },
      botGuilds: async () => [],
      now: Date.now,
      ttlMs: 60_000,
    });
    const out = await boom.listGuilds({ id: "s", userId: "u" });
    assert.deepEqual(out.guilds, []);
    assert.equal(out.degraded, true);
  });
});

// ===========================================================================
// E. vendored assets on disk (§8.1-2)
// ===========================================================================
describe("vendored htmx + app.js wiring", () => {
  it("vendor file is version-stamped and intact (no CDN, no build step)", () => {
    const text = fs.readFileSync(VENDOR_FILE, "utf8");
    assert.match(text, /^\/\*! htmx\.org v2\.0\.10 /, "banner first bytes with version");
    assert.ok(text.includes("MIT"));
    assert.ok(text.includes("var htmx=function", "library follows the banner"));
    assert.ok(text.length > 50_000, "full minified build");
    const dir = fs.readdirSync(path.dirname(VENDOR_FILE));
    assert.deepEqual(dir, ["htmx.2.0.10.min.js"], "exactly the pinned version committed");
  });

  it("no build-step/framework artifacts under public/", () => {
    const walk = (d) =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
      );
    for (const file of walk(PUBLIC_DIR)) {
      assert.ok(
        !/\.(map|ts|tsx|jsx|vue|svelte|lock)$/i.test(file),
        `unexpected artifact: ${file}`
      );
      assert.ok(!/alpine|react|vue|svelte|tailwind/i.test(path.basename(file)), file);
    }
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, "styles.css")));
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, "app.js")));
  });

  it("app.js wires htmx's X-CSRF-Token header from the body's csrf attribute", () => {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
    assert.ok(src.includes("htmx:configRequest"), "hx-headers wiring via configRequest");
    assert.ok(src.includes("X-CSRF-Token"), "the header csrf.js reads");
    assert.ok(src.includes('getAttribute("data-csrf-token")'), "reads data-csrf-token");
    assert.ok(!/\son[a-z]+\s*=/.test(src), "no inline handlers in the shell JS either");
  });

  it("layout references resolve to files that exist under public/", () => {
    const { HTMX_SRC, APP_SRC, STYLES_SRC } = require("../src/web/views/layout");
    for (const srcPath of [HTMX_SRC, APP_SRC, STYLES_SRC]) {
      assert.ok(srcPath.startsWith("/static/"), srcPath);
      const abs = path.join(PUBLIC_DIR, srcPath.replace("/static/", ""));
      assert.ok(fs.existsSync(abs), `${srcPath} → ${abs} missing`);
    }
  });

  it("styles.css: dark-by-default palette + prefers-color-scheme light override", () => {
    const css = fs.readFileSync(path.join(PUBLIC_DIR, "styles.css"), "utf8");
    // Base (:root) palette must be the DARK one; light comes ONLY via media query.
    const rootBlock = css.slice(css.indexOf(":root"), css.indexOf("@media"));
    assert.match(rootBlock, /--bg:\s*#191b1f/, "dark base background");
    assert.match(css, /@media \(prefers-color-scheme: light\)/, "light override is opt-in");
    assert.match(css, /font-family:\s*system-ui/, "system-ui (transcript language)");
    // Responsive shell: viewport meta (layout) + wrap/fluid rules (CSS).
    const doc = String(renderLayout({ title: "T", content: "", nonce: "" }));
    assert.match(
      doc,
      /<meta name="viewport" content="width=device-width, initial-scale=1"\/>/
    );
    assert.match(css, /flex-wrap:\s*wrap/, "header wraps at narrow breakpoints");
    assert.match(css, /max-width:\s*1100px/, "fluid container");
    assert.match(css, /@media \(max-width: 480px\)/, "small-phone pass");
  });
});
