/**
 * Subtask 17 — web moderation lists (roadmap/web-admin.md §8.6 "Moderation:
 * warnings list … notes | Staff | 1 read", Phase 1 read-only). FULLY OFFLINE
 * integration net over the REAL createWebApp() mount (guildScope →
 * requireTier → moderation routes): real SQLite (loadDb), real session rows,
 * fake Discord resolver. node --test only.
 *
 * Suites:
 *  A. Access matrix (both routes): anon 302 · plain-member 404 · staff/
 *     senior/admin 200 · cross-guild B probe ⇒ generic 404 with ZERO
 *     guild-B data anywhere (§8.6 cross-cutting 404);
 *  B. Warnings filters vs slash: default hides voided (slash /warn list
 *     default) · state=all reveals voided BADGED with full void metadata
 *     (voided_by + void_reason + ts) · state=voided = voided-only (web
 *     extra) · u= exact subject filter · invalid u ⇒ escaped notice +
 *     unfiltered page (never 404/500, never raw echo) · expiry state
 *     (active-expiring vs expired-pending-auto-void) · evidence + raw
 *     related-note id rendered from row-carried fields only;
 *  C. Pagination bounds (§8.6 query budget): 105-row subject ⇒ default 25,
 *     ?n=500 clamps to EXACTLY 100 rows, ?n=5, offset tail page, absurd
 *     offset clamps (bounded, 200, empty state);
 *  D. Notes vs /note list parity: default hides soft-deleted · state=all
 *     reveals BADGED with deleted_by metadata · u filter · guild-wide
 *     ordering newest-first;
 *  E. XSS: note content + warn reason + junk filter values can never
 *     escape via html`` (attribute and text positions);
 *  F. Read-only (§8.8 Phase 1): POST 405s, unknown subpaths generic 404.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// ---------------------------------------------------------------------------
// loadDb() FIRST (cache clear + DB_PATH bind), then require src modules.
// ---------------------------------------------------------------------------
const { api, tmpDir } = loadDb();

const { createWebApp } = require("../src/web/app");
const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");

// Clearly-fake placeholder secret (AGENTS.md: never real-looking secrets).
const SESSION_SECRET = "test-m…-xyz";

const USER_ADMIN = "428190112345678901";
const USER_SENIOR = "428190112345678902";
const USER_STAFF = "428190112345678903";
const USER_PLAIN = "428190112345678904";

const GUILD_A = "100000000000000001";
const GUILD_B = "200000000000000002";

const ROLE_JUNIOR = "500000000000000011";
const ROLE_SENIOR = "500000000000000012";

/** Warning subjects (guild A). */
const WARN_1 = "440000000000000001";
const WARN_2 = "440000000000000002";
const WARN_P = "440000000000000003"; // pagination subject (105 warnings)
/** Note subjects (guild A) + a guild-B-only subject (cross-guild probe). */
const NOTE_1 = "440000000000000011";
const NOTE_2 = "440000000000000012";
const NOTE_3 = "440000000000000013";
const B_SUBJECT = "440000000000000099";

/** Guild-B-only rows — must NEVER surface under guild A. */
const B_REASON = "guild B secret warning";
const B_NOTE = "guild B private note";

/** XSS probes (clearly inert probes, not real exploits). */
const XSS_NOTE = `<script>alert("note-xss")</script>`;
const XSS_WARN_HEAD = `<script>alert("warn-xss")</script>`;
const XSS_ATTR = `"><svg onload=EVILPROBE>`;

/** Pagination seed counts (mirror the users-test pressure pattern). */
const BULK = 105;
const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;

/** Count non-overlapping occurrences (cheap DOM-free row counting). */
function count(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

const ENV_KEYS = ["SESSION_SECRET", "CLIENT_SECRET", "PUBLIC_BASE_URL", "WEB_TIER_CACHE_TTL_MS", "DB_PATH", "DATA_DIR"];
let savedEnv;

/** Mutable harness state. */
const suite = { server: null, base: "", cookies: {} };

before(async () => {
  savedEnv = ENV_KEYS.reduce((acc, k) => ((acc[k] = process.env[k]), acc), {});
  process.env.SESSION_SECRET = SESSION_SECRET;
  delete process.env.CLIENT_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.WEB_TIER_CACHE_TTL_MS;

  // ---- staff roles (guild A) ----------------------------------------------
  api.addStaffRole(GUILD_A, ROLE_JUNIOR, "junior");
  api.addStaffRole(GUILD_A, ROLE_SENIOR, "senior");

  // ---- notes (seeded FIRST: a warning links one) ---------------------------
  const nAlpha = api.createStaffNote({
    guildId: GUILD_A,
    userId: NOTE_1,
    authorId: USER_SENIOR,
    content: "pattern note alpha",
  });
  api.updateStaffNote(GUILD_A, nAlpha.note_number, {
    content: "pattern note alpha (edited body)",
    editedBy: USER_SENIOR,
  });
  api.createStaffNote({
    guildId: GUILD_A,
    userId: NOTE_1,
    authorId: USER_STAFF,
    content: "deleted note body alpha",
  });
  const n1 = nAlpha.note_number; // N-1
  const nDeleted = 2; // N-2 (soft-deleted below)
  api.createStaffNote({
    guildId: GUILD_A,
    userId: NOTE_2,
    authorId: USER_ADMIN,
    content: "context note beta",
  });
  api.createStaffNote({
    guildId: GUILD_A,
    userId: NOTE_2,
    authorId: USER_ADMIN,
    content: `${XSS_NOTE}${XSS_ATTR}`,
  });
  api.createStaffNote({
    guildId: GUILD_B,
    userId: B_SUBJECT,
    authorId: USER_ADMIN,
    content: B_NOTE,
  });
  api.createStaffNote({
    guildId: GUILD_A,
    userId: NOTE_3,
    authorId: USER_ADMIN,
    content: "freshest guild note",
  });
  api.softDeleteStaffNote(GUILD_A, nDeleted, USER_SENIOR);

  // ---- warnings (guild A) ---------------------------------------------------
  api.createWarning({
    guildId: GUILD_A,
    userId: WARN_1,
    issuerId: USER_SENIOR,
    reason: "spam incident evidence probe",
    relatedNoteId: nAlpha.id,
    evidenceText: "staff-only evidence probe",
    evidenceMessageUrl: `https://discord.com/channels/${GUILD_A}/770000000000000001/770000000000000555`,
  }); // W-1
  api.createWarning({
    guildId: GUILD_A,
    userId: WARN_1,
    issuerId: USER_ADMIN,
    reason: "future expiry probe",
    expiresAt: Date.now() + 10 * 86_400_000,
  }); // W-2 active, expiring
  api.createWarning({
    guildId: GUILD_A,
    userId: WARN_1,
    issuerId: USER_ADMIN,
    reason: "voided incident",
  }); // W-3 voided below
  api.voidWarning(GUILD_A, 3, {
    voidedBy: USER_SENIOR,
    voidReason: "appeal upheld — void meta probe",
  });
  api.createWarning({
    guildId: GUILD_A,
    userId: WARN_1,
    issuerId: USER_ADMIN,
    reason: "expired pending probe",
    expiresAt: Date.now() - 86_400_000,
  }); // W-4 active but expired (auto-void pending)
  api.createWarning({
    guildId: GUILD_A,
    userId: WARN_2,
    issuerId: USER_ADMIN,
    reason: "clean record two",
  }); // W-5
  api.createWarning({
    guildId: GUILD_A,
    userId: WARN_2,
    issuerId: USER_ADMIN,
    reason: `${XSS_WARN_HEAD}${XSS_ATTR}`,
  }); // W-6 XSS reason
  for (let i = 0; i < BULK; i += 1) {
    api.createWarning({
      guildId: GUILD_A,
      userId: WARN_P,
      issuerId: USER_ADMIN,
      reason: `bulk paginate probe ${i}`,
    }); // W-7 … W-111
  }
  // ---- warnings (guild B ONLY — cross-guild probe) ---------------------------
  api.createWarning({
    guildId: GUILD_B,
    userId: B_SUBJECT,
    issuerId: USER_ADMIN,
    reason: B_REASON,
  });

  // ---- fake Discord (resolver) -----------------------------------------------
  const fakeDiscord = {
    async getUserGuilds(token) {
      const userId = String(token).replace(/^tok-/, "");
      if ([USER_ADMIN, USER_SENIOR, USER_STAFF, USER_PLAIN].includes(userId)) {
        return [
          {
            id: GUILD_A,
            name: "Guild A",
            icon: null,
            owner: userId === USER_ADMIN,
            permissions: userId === USER_ADMIN ? "0" : "104324673",
          },
        ];
      }
      return [];
    },
    async getUserGuildMember(token, guildId) {
      const userId = String(token).replace(/^tok-/, "");
      if (guildId === GUILD_A) {
        if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR] };
        if (userId === USER_SENIOR) return { roles: [ROLE_SENIOR] };
        return { roles: [] };
      }
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    },
  };

  const resolver = createGuildAccessResolver({
    discord: fakeDiscord,
    botGuilds: async () => [GUILD_A], // bot ONLY in guild A
    now: Date.now,
    ttlMs: 60_000,
  });

  // ---- real app + mount order (guildScope → moderation routes) ---------------
  const app = createWebApp({ guildAccess: resolver });
  suite.server = http.createServer(app);
  suite.server.listen(0, "127.0.0.1");
  await once(suite.server, "listening");
  suite.base = `http://127.0.0.1:${suite.server.address().port}`;

  suite.cookies = {};
  for (const [key, userId] of [
    ["admin", USER_ADMIN],
    ["senior", USER_SENIOR],
    ["staff", USER_STAFF],
    ["plain", USER_PLAIN],
  ]) {
    const s = sessionPolicy.createSession({ userId });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken(`tok-${userId}`),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: JSON.stringify([
        {
          id: GUILD_A,
          name: "A",
          icon: null,
          owner: userId === USER_ADMIN,
          permissions: userId === USER_ADMIN ? "0" : "104324673",
        },
      ]),
    });
    suite.cookies[key] = s.id;
  }
});

after(async () => {
  if (suite.server) {
    suite.server.close();
    await once(suite.server, "close");
  }
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

/** @param {string} path @param {{key?: string, method?: string}} [opts] */
async function hit(path, opts = {}) {
  const res = await fetch(`${suite.base}${path}`, {
    method: opts.method || "GET",
    redirect: "manual",
    headers: opts.key ? { cookie: `web_session=${suite.cookies[opts.key]}` } : undefined,
  });
  const body = await res.text();
  return { res, body };
}

const W = `/g/${GUILD_A}/warnings`;
const N = `/g/${GUILD_A}/notes`;

// ===========================================================================
// A. Access matrix — both routes (§8.6 tier row + cross-cutting 404)
// ===========================================================================
describe("access matrix — GET /g/:guildId/warnings and /notes (staff tier)", () => {
  for (const [label, url] of [
    ["warnings", W],
    ["notes", N],
  ]) {
    it(`${label}: anonymous → 302 login redirect (guildScope)`, async () => {
      const { res } = await hit(url);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), `/auth/login?guild=${GUILD_A}`);
    });

    it(`${label}: in-guild member WITHOUT staff role → generic 404 (never 403)`, async () => {
      const { res, body } = await hit(url, { key: "plain" });
      assert.equal(res.status, 404);
      assert.equal(body, "Not found");
    });

    it(`${label}: cross-guild probe → generic 404, zero guild-B data`, async () => {
      for (const key of ["staff", "senior", "admin"]) {
        const { res, body } = await hit(`/g/${GUILD_B}/warnings`, { key });
        assert.equal(res.status, 404, key);
        assert.equal(body, "Not found");
        assert.ok(!body.includes(B_REASON));
      }
      const notes = await hit(`/g/${GUILD_B}/notes`, { key: "staff" });
      assert.equal(notes.res.status, 404);
      assert.equal(notes.body, "Not found");
    });

    it(`${label}: staff / senior / admin → 200 shell`, async () => {
      for (const key of ["staff", "senior", "admin"]) {
        const { res, body } = await hit(url, { key });
        assert.equal(res.status, 200, `${label} via ${key}`);
        assert.match(body, /<!DOCTYPE html>/);
      }
    });
  }

  it("guild-A pages never leak guild-B rows (reason + note probes absent)", async () => {
    const w = await hit(W, { key: "staff" });
    assert.ok(!w.body.includes(B_REASON), "guild-B warning never renders under guild A");
    assert.ok(!w.body.includes(B_SUBJECT), "guild-B subject never renders under guild A");
    const n = await hit(N, { key: "admin" });
    assert.ok(!n.body.includes(B_NOTE), "guild-B note never renders under guild A");
  });
});

// ===========================================================================
// B. Warnings list — filters mirror slash /warn list + real void metadata
// ===========================================================================
describe("GET /g/:guildId/warnings — filters + void/expiry states", () => {
  it("default = ACTIVE only (slash include_voided:false): voided row hidden, states badged", async () => {
    const { res, body } = await hit(`${W}?u=${WARN_1}`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-warn'), 3, "3 active warnings for WARN_1");
    assert.ok(body.includes("spam incident evidence probe"));
    assert.ok(!body.includes("voided incident"), "voided warning hidden by default");
    assert.ok(body.includes("W-1"), "warning ref shown");
    assert.ok(body.includes("expires"), "expiring warning carries expiry text (slash parity)");
    assert.ok(body.includes("expired (auto-void pending)"), "past expiry shown as pending auto-void");
  });

  it("state=all reveals voided BADGED with full void metadata (voided_by + void_reason)", async () => {
    const { res, body } = await hit(`${W}?u=${WARN_1}&state=all`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-warn'), 4);
    assert.ok(body.includes("voided incident"));
    assert.ok(body.includes("appeal upheld — void meta probe"), "void reason rendered");
    assert.match(
      body,
      /voided [^<]*by 428190112345678902/,
      "voided_by id rendered next to the void timestamp"
    );
    assert.ok(body.includes("state-pill-voided"), "voided badge class");
    assert.ok(
      body.includes("<strong>4</strong>") && body.includes("warnings match this filter"),
      "honest filtered total (4 = incl. voided)"
    );
  });

  it("state=voided = voided-only (web-only refinement)", async () => {
    const { res, body } = await hit(`${W}?state=voided`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-warn'), 1, "exactly the one voided row");
    assert.ok(body.includes("voided incident"));
    assert.ok(!body.includes("clean record two"), "active rows absent from voided view");
  });

  it("junk state falls back to active (whitelist, never 500, never echoed)", async () => {
    const { res, body } = await hit(`${W}?state=%3Cscript%3Ezz`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(!body.includes("<script>zz"), "junk state never echoed raw");
    assert.ok(!body.includes("voided incident"), "fell back to active-only");
  });

  it("guild-wide view (no u) is newest-first and shows subject + issuer ids", async () => {
    const { res, body } = await hit(W, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(
      body.indexOf("bulk paginate probe 104") < body.indexOf("bulk paginate probe 103"),
      "newest-first (warning_number DESC) ordering within the rendered page"
    );
    assert.ok(body.includes(WARN_P) && body.includes(USER_ADMIN), "subject + issuer ids shown");
    assert.equal(count(body, 'class="row-warn'), PAGE_DEFAULT, "default page size 25");
    assert.ok(body.includes(`showing 1–${PAGE_DEFAULT} of ${3 + 2 + BULK}`), "honest guild-wide total (110 active of 111)");
  });

  it("invalid u → escaped notice + UNFILTERED page (200, banner, no raw echo)", async () => {
    const { res, body } = await hit(`${W}?u=abc`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("Invalid user filter ignored"), "notice shown");
    assert.equal(count(body, 'class="row-warn'), PAGE_DEFAULT, "page stays unfiltered");

    const xss = await hit(`${W}?u=${encodeURIComponent("<script>alert(1)</script>")}`, { key: "staff" });
    assert.equal(xss.res.status, 200);
    assert.ok(!xss.body.includes("<script>alert(1)"), "junk filter never echoes raw");
    assert.ok(xss.body.includes("Invalid user filter ignored"));
  });

  it("evidence + related-note render from row-carried fields only", async () => {
    const { body } = await hit(`${W}?u=${WARN_1}&state=all`, { key: "senior" });
    assert.ok(body.includes("staff-only evidence probe"), "evidence text shown (staff surface)");
    assert.ok(body.includes("message evidence"), "evidence link label");
    assert.ok(/related note #\d+/.test(body), "raw related-note id ref, no cross-table lookup");
  });

  it("u filter with a valid snowflake that has no guild-A rows → honest empty", async () => {
    const { res, body } = await hit(`${W}?u=${B_SUBJECT}`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("No active warnings match this filter."));
    assert.ok(!body.includes(B_REASON));
  });
});

// ===========================================================================
// C. Pagination bounds (§8.6 query budget: LIMIT ≤100 + offset clamp)
// ===========================================================================
describe("GET /g/:guildId/warnings — pagination bounds on a 105-row subject", () => {
  it("?n=5 renders five rows and the prev/next pager preserves the filters", async () => {
    const { res, body } = await hit(`${W}?u=${WARN_P}&n=5`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-warn'), 5);
    assert.ok(body.includes("showing 1–5 of 105"));
    assert.ok(body.includes(`u=${WARN_P}`) && body.includes("state=active"), "pager preserves filters");
    assert.ok(body.includes("o=5"), "next link sets offset");
  });

  it("?n=500 CLAMPS to 100 rows (hard §8.6 cap)", async () => {
    const { res, body } = await hit(`${W}?u=${WARN_P}&n=500`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-warn'), PAGE_MAX, "exactly the 100-row cap");
  });

  it("offset tail page", async () => {
    const { res, body } = await hit(`${W}?u=${WARN_P}&o=100`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-warn'), 5);
    assert.ok(body.includes("showing 101–105 of 105"));
    assert.ok(body.includes("prev"), "prev link appears past the first page");
  });

  it("absurd offset clamps (200, bounded, empty state) — never deep-scans", async () => {
    const { res, body } = await hit(`${W}?u=${WARN_P}&o=999999999`, { key: "admin" });
    assert.equal(res.status, 200);
    assert.equal(count(body, 'class="row-warn'), 0);
    assert.ok(body.includes("No active warnings match this filter."));
  });
});

// ===========================================================================
// D. Notes list — /note list parity (soft-delete visibility, filters, order)
// ===========================================================================
describe("GET /g/:guildId/notes — soft-delete visibility mirrors /note list", () => {
  it("default HIDES soft-deleted (slash include_deleted:false default)", async () => {
    const { res, body } = await hit(N, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(!body.includes("deleted note body alpha"), "soft-deleted content never shows by default");
    assert.ok(body.includes("pattern note alpha (edited body)"));
    assert.ok(body.includes("freshest guild note"));
    assert.ok(body.includes("edited"), "edited metadata line (slash /note info parity field)");
    assert.ok(
      body.indexOf("freshest guild note") < body.indexOf("pattern note alpha"),
      "guild-wide newest-first ordering"
    );
  });

  it("state=all reveals deleted notes BADGED with deleted_by (mirror include_deleted:true)", async () => {
    const { res, body } = await hit(`${N}?state=all`, { key: "senior" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("deleted note body alpha"));
    assert.ok(body.includes("state-pill-deleted"), "deleted badge class");
    assert.ok(body.includes(USER_SENIOR), "deleted_by id rendered");
    assert.ok(
      body.includes("<strong>5</strong>") && body.includes("notes match this filter"),
      "guild-A totals: 4 active + 1 deleted"
    );
  });

  it("u filter narrows per subject (and counts honestly)", async () => {
    const def = await hit(`${N}?u=${NOTE_1}`, { key: "staff" });
    assert.equal(def.res.status, 200);
    assert.equal(count(def.body, 'class="row-note'), 1, "only the active note of NOTE_1");
    assert.ok(def.body.includes("note matches this filter · subject"));

    const all = await hit(`${N}?u=${NOTE_1}&state=all`, { key: "staff" });
    assert.equal(count(all.body, 'class="row-note'), 2, "deleted revealed for this subject");
    assert.ok(all.body.includes("<strong>2</strong>") && all.body.includes("notes match this filter"));

    const none = await hit(`${N}?u=${NOTE_3}&state=all`, { key: "staff" });
    assert.ok(none.body.includes("note matches this filter"));
  });

  it("invalid u on notes degrades like warnings (banner + unfiltered)", async () => {
    const { res, body } = await hit(`${N}?u=not-a-snowflake`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(body.includes("Invalid user filter ignored"));
    assert.ok(body.includes("freshest guild note"), "guild-wide list still renders");
  });
});

// ===========================================================================
// E. XSS — note content + warn reason can never escape html`` (§8.7)
// ===========================================================================
describe("XSS probes through stored content", () => {
  it("stored note content is escaped in every position", async () => {
    const { res, body } = await hit(`${N}?u=${NOTE_2}`, { key: "staff" });
    assert.equal(res.status, 200);
    assert.ok(!body.includes(`<script>alert("note-xss")`), "no raw script from note content");
    assert.ok(!body.includes("<svg onload=EVILPROBE>"), "no raw svg breakout");
    assert.ok(body.includes("&lt;script&gt;alert(&quot;note-xss&quot;)"), "escaped echo instead");
  });

  it("stored warning reason is escaped in every position", async () => {
    const { res, body } = await hit(`${W}?u=${WARN_2}`, { key: "admin" });
    assert.equal(res.status, 200);
    assert.ok(!body.includes(`<script>alert("warn-xss")`), "no raw script from warn reason");
    assert.ok(!body.includes('"><svg onload=EVILPROBE>'), "no attribute-position breakout");
    assert.ok(body.includes("&lt;script&gt;alert(&quot;warn-xss&quot;)"), "escaped echo instead");
  });
});

// ===========================================================================
// F. Read-only surface (§8.8 Phase 1 — no mutation routes exist)
// ===========================================================================
describe("read-only: no mutating verbs, no mutation routes", async () => {
  for (const [label, path] of [
    ["warnings", W],
    ["notes", N],
  ]) {
    it(`POST ${label} → 405 Method not allowed (methodGate)`, async () => {
      const { res, body } = await hit(path, { key: "admin", method: "POST" });
      assert.equal(res.status, 405);
      assert.equal(body, "Method not allowed");
    });

    it(`POST ${label} even for staff → 405 (gate runs pre-auth)`, async () => {
      const { res } = await hit(path, { key: "staff", method: "POST" });
      assert.equal(res.status, 405);
    });

    it(`unknown ${label} subpath → generic 404 (no /void, /add, /delete routes)`, async () => {
      for (const junk of ["void", "add", "delete"]) {
        const { res, body } = await hit(`${path}/${junk}`, { key: "admin" });
        assert.equal(res.status, 404, junk);
        assert.equal(body, "Not found", `${path}/${junk} must be the plain catch-all`);
      }
    });
  }
});
