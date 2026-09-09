/**
 * Subtask 27 — PHASE 2 ACCEPTANCE GATE (roadmap/web-admin.md §8.8 Phase 2
 * exit: "Each mutation: CSRF-gated, tier-correct, service-layer call,
 * admin_audit row; parity checklist vs. slash command" + §8.6 cross-cutting
 * rules + §8.7 CSRF + §8.1-7 fail-closed).
 *
 * THE GATE IS DATA-DRIVEN AND ANTI-DRIFT BY CONSTRUCTION:
 *  - the GROUND TRUTH for "what is a Phase-2 mutation" is the RUNTIME
 *    registry app.locals.webMutations (populated by registerWebMutation at
 *    mount time — the same array the methodGate consults). Every registry
 *    entry MUST have a row in the PARITY table below and vice versa (suite
 *    A) — a new mutation without coverage, or a stale table row, fails;
 *  - the PARITY table below IS the §8.8 slash-parity checklist artifact. The
 *    describe/it names print each row (template · tier · helper · action) so
 *    the `npm test` output is the living checklist, and suite G prints the
 *    full markdown table to stderr (§8.8 evidence, same channel as the
 *    Phase-1 gate report).
 *
 * For EVERY registered mutation the gate asserts (per the §8.6 cross-cutting
 * rules + AGENTS.md §4 tiers), over a REAL Express 5 app on an ephemeral
 * port with REAL SQLite and the fake-Discord transport under the REAL
 * createGuildAccessResolver (same boot discipline as the Phase-1 gate — the
 * app is built SYNCHRONOUSLY at load so the describe tree can enumerate the
 * live registry at collection time):
 *  1. SECURITY LADDER — anon ⇒ 302 login (byte-exact); stranger AND
 *     cross-guild ⇒ the SAME generic 404 bytes (never 403, §8.6); in-guild
 *     member without a staff role ⇒ generic 404; wrong-tier (junior/senior
 *     on admin-tier routes per the row's own requireTier) ⇒ fixed 403 with
 *     zero side effects; missing _csrf ⇒ 403; tampered _csrf ⇒ 403; the
 *     SAME request body passes only with the valid token (positive path =
 *     "replayed request passes only with valid CSRF");
 *  2. SERVICE LAYER — a counting proxy installed on the shared src/db facade
 *     module object wraps every Phase-2 helper (methods resolve at CALL time
 *     in settingsWrite DI / staff routes / integrations module-level db ===
 *     this object), so the spies are what the handlers actually call. The
 *     positive path must record the EXACT slash helper name (table
 *     `helpers`, evidence refs to the slash call sites); every
 *     validation-rejection probe must record ZERO write-helper calls and
 *     ZERO audit rows;
 *  3. AUDIT — the positive path writes EXACTLY ONE admin_audit row (origin
 *     'web', guild/actor/target/action per the table, details deep-equal the
 *     slash-shape before/after) plus the mirror expectation (§8.1-7:
 *     settings + staff mutations mirror to the audit channel; integrations
 *     handlers carry no mirror descriptor). Audit-FAIL injection (facade
 *     insertAdminAudit throws) on EVERY mutation ⇒ generic 500 "Internal
 *     error", no Location (the outcome is never silently claimed —
 *     fail-closed §8.1-7), zero audit rows, and NO channel mirror scheduled;
 *  4. TIER CORRECTNESS vs AGENTS.md §4 — the expected tier is DERIVED from
 *     the template itself (staff-role mutations, command-channel add/remove
 *     and honeypot exempt ⇒ admin; every other Phase-2 surface ⇒ staff) and
 *     cross-checked against the table AND the recorded runtime ladder
 *     behavior (admin routes: junior AND senior 403; staff routes: junior
 *     passes the gate) — no source greps anywhere.
 *
 * KNOWN INTENTIONAL DELTAS (documented rows, proven in suite D):
 *  (a) event-reminder create/edit/clear/sync stay slash-only (the creator
 *      axis has no web notion) — web side is setchannel ONLY at staff tier;
 *      the gate proves no create/edit route is registered (byte 405);
 *  (b) youtube/add REFUSES without YOUTUBE_API_KEY where the slash silently
 *      stores an unresolved @-handle row — a web-only hardening gate, proven
 *      refusal with zero writes;
 *  (c) honeypot exempt writes map onto the staff.role_add / staff.role_remove
 *      slash vocabulary with details.via "honeypot.exempt" over the shared
 *      staff_roles table (same facade helpers, ADMIN tier).
 *
 * CROSS-CUTTING suites: 405 byte-parity for unregistered mutation-shaped
 * paths under /g/ and on the legacy surfaces (POST /auth/login, /t/*,
 * /static/*); methodGate registry ↔ mounted-POST-route integrity;
 * registerWebMutation refuses non-/g/:guildId surfaces (unit); the
 * getClient boot wiring: features/web start() → startWebServer({getClient})
 * (unit, via a require-cache stub) + createWebApp threading options.getClient
 * into the route options (the fake client's cached channel NAME renders on
 * the live settings page).
 *
 * Fully offline. Sessions minted directly (no OAuth round trip). Sentinel
 * secrets are clearly fake (AGENTS.md). Runtime budget ≪ 60 s.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// loadDb FIRST: fresh SQLite + src require-cache reset; every require below
// binds to that DB (Phase-1 gate boot discipline).
const { api, tmpDir } = loadDb();

const harness = require("./helpers/access-matrix");
// Shared mutation-gate harness (extracted VERBATIM from THIS file by
// subtask 32 so the Phase-3 program gate runs the identical ladder over the
// identical matrix — single source for fixtures, facade recorder, mirror
// spy, the 40-row PARITY table and the ladder steps. Semantics unchanged.)
const ladder = require("./helpers/mutation-ladder");
const guildAccessMod = require("../src/web/auth/guildAccess");
const { createWebApp, registerWebMutation } = require("../src/web/app");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");
const csrfMod = require("../src/web/middleware/csrf");
const { createSettingsData } = require("../src/web/data/settingsData");
const { bindAuditClient } = require("../src/web/middleware/audit");
const auditLogMod = require("../src/features/logs/auditLog");
const dbFacade = require("../src/db");
// Raw connection handle for the Phase-3 AUTOINCREMENT purges: warnings.id and
// staff_notes.id are `INTEGER PRIMARY KEY AUTOINCREMENT` (migrations 009/007),
// so deterministic audit target ids need the sqlite_sequence row reset too,
// not just DELETE. Same connection instance loadDb() bound to the temp DB.
const { db: rawDb } = require("../src/db/connection");
// The shared matrix's T3 row clears ticket_messages through this handle
// (identical behavior to the pre-extraction inline statement).
ladder.bindRawDelete((sql) => rawDb.prepare(sql).run());

const { FIX, ENV_KEYS } = ladder;
const {
  GUILD_A,
  GUILD_CROSS,
  USER_ADMIN,
  USER_STAFF,
  USER_SENIOR,
  USER_PLAIN,
  USER_STRANGER,
  ROLE_JUNIOR_TIER,
  ROLE_SENIOR_TIER,
  CH_AUDIT,
  CH_MESSAGE,
  CH_WARN,
  CH_CMD,
  CH_HONEY,
  ROLE_STAFF,
  ROLE_LEVEL,
  ROLE_UPLOAD,
  ROLE_TW,
  ROLE_BAN,
  ROLE_EXEMPT,
  PANEL_MSG,
  USER_GRANT,
  USER_WARN_SUBJECT,
  YT_ID,
  YT_URL,
  TW_ID,
  TW_LOGIN,
  GATE_CHANNEL_NAME,
  BOT_GUILDS,
} = FIX;

// Clearly-fake sentinels / placeholders ONLY (AGENTS.md: never realistic).
const SESSION_SECRET = "test-gate2-sentinel-session-secret-NOT-REAL-027";
const YT_KEY = "YOUR_YOUTUBE_API_KEY-placeholder-not-real";

// ---------------------------------------------------------------------------
// Fake Discord transport under the REAL resolver (Phase-1 gate pattern)
// ---------------------------------------------------------------------------

const fakeDiscord = ladder.makeFakeDiscord();

// ---------------------------------------------------------------------------
// Fake discord.js client — CACHE-ONLY seams (any network call in a request
// path would surface as an unstubbed-method throw). The same object doubles
// as the getClient-threading proof: CH_AUDIT carries a unique cached name.
// ---------------------------------------------------------------------------

function makeFakeChannel(id, name) {
  return {
    id,
    name,
    type: 0, // GUILD_TEXT — the /eventreminder picker types twin
    isTextBased: () => true,
    send: async () => ({ id: PANEL_MSG }),
    messages: {
      fetch: async () => ({ id: PANEL_MSG, delete: async () => true }),
    },
  };
}

const FAKE_CHANNELS = Object.fromEntries(
  [CH_AUDIT, CH_MESSAGE, CH_WARN, CH_CMD, CH_HONEY].map((id) => [
    id,
    makeFakeChannel(id, id === CH_AUDIT ? GATE_CHANNEL_NAME : `Gate ${id.slice(-3)}`),
  ])
);
const FAKE_ROLES = Object.fromEntries(
  [ROLE_STAFF, ROLE_LEVEL, ROLE_UPLOAD, ROLE_TW, ROLE_BAN, ROLE_EXEMPT].map((id) => [
    id,
    { id, name: `GateRole-${id.slice(-3)}`, position: 10 },
  ])
);

const FAKE_CLIENT = {
  guilds: {
    cache: {
      get: (gid) =>
        gid === GUILD_A
          ? {
              id: GUILD_A,
              roles: { cache: { get: (rid) => FAKE_ROLES[rid] } },
              channels: { cache: { get: (cid) => FAKE_CHANNELS[cid] } },
              emojis: { cache: { get: () => undefined } },
              me: { roles: { highest: { position: 100 } } }, // bot ABOVE all subjects
            }
          : undefined,
    },
  },
  channels: { cache: { get: (id) => FAKE_CHANNELS[id] } },
};

// ---------------------------------------------------------------------------
// SERVICE-LAYER counting proxy on the SHARED src/db facade object, the
// audit-channel MIRROR SPY (§8.1-7) and the ladder tick — all three now
// live in test/helpers/mutation-ladder.js (extracted VERBATIM from this
// file by subtask 32; semantics unchanged). The audit middleware captures
// db.insertAdminAudit at createWebApp time — the recorder is installed
// BEFORE the app is built; the throw-flag toggle then reaches the mounted
// middleware through the captured wrapper. The mirror spy swaps the two
// auditLog posters + binds a truthy fake so every row proves whether a
// mirror WAS scheduled (settings/staff) or was NOT (integrations,
// fail-closed).
// ---------------------------------------------------------------------------

const recorder = {
  active: false,
  log: [],
  auditThrow: false, // §8.1-7 fail-closed injection flag
};

const restoreFacadeRecorder = ladder.installFacadeRecorder(dbFacade, recorder);

const { writeCalls, WRITE_HELPERS } = ladder;

function startWindow() {
  recorder.log = [];
  recorder.active = true;
}
function stopWindow() {
  recorder.active = false;
  return recorder.log.slice();
}

const mirrorSpy = ladder.installMirrorSpy(auditLogMod, bindAuditClient);
function restoreMirrorSpy() {
  mirrorSpy.restore();
}
const tick = ladder.tick;


// ---------------------------------------------------------------------------
// PARITY TABLE — THE §8.8 PHASE-2 CHECKLIST ARTIFACT (living deliverable)
//
// One row per registered mutation. Columns:
//   template/method/tier .... route identity + required tier (AGENTS.md §4)
//   slash ................... the slash command this mirrors + the facade
//                             helper ITS handler calls (evidence: file:line)
//   helpers ................. the SAME helper name(s) the web path MUST
//                             record on the counting proxy (service-layer
//                             rule §8.6 — verified by intercepted calls)
//   action .................. EXACT admin_audit action string (slash
//                             vocabulary §8.6; features/*/index.js evidence)
//   mirror .................. channel-mirror expectation on success (§8.1-7)
//   okLocation .............. PRG target (fixed constants, nothing reflected)
//   fields/prepare/reject ... deterministic happy payload, state re-seed,
//                             and a validation-rejection probe (ZERO writes,
//                             ZERO audits)
// The rows are cross-checked against the RUNTIME registry in suite A both
// ways: the gate can never silently drift from the mounted routes.
// ---------------------------------------------------------------------------

// THE PARITY MATRIX — the §8.8 Phase-2 checklist artifact — lives in
// test/helpers/mutation-ladder.js (buildPhase2Rows), shared VERBATIM with
// the Phase-3 program gate. Row columns (full legend in the helper):
// template/method/tier (route identity + required tier per AGENTS.md §4),
// slash (the mirrored slash command + the facade helper ITS handler calls,
// file:line evidence), helpers (the SAME helper names the web path MUST
// record on the counting proxy — §8.6 service layer), action (EXACT
// admin_audit action string), mirror (§8.1-7 channel-mirror expectation),
// okLocation (fixed PRG target), fields/prepare/reject (deterministic happy
// payload, state re-seed, validation-rejection probe — ZERO writes, ZERO
// audits). Cross-checked against the RUNTIME registry in suite A BOTH ways.
const PARITY = ladder.buildPhase2Rows({ api, purgeAutoincrement });

// Rows flip to "PASS" only when the positive-path test completed (the full
// ladder ran for the row before it). Printed by the suite-G report.
for (const row of PARITY) row.status = "PENDING";

/**
 * AGENTS.md §4 tier classification DERIVED FROM THE TEMPLATE (no source
 * greps, no table lookup) — shared with the Phase-3 program gate via the
 * helper. Cross-checked against the table AND runtime ladder behavior.
 */
const expectedTierFor = ladder.expectedTierFor;

// ---------------------------------------------------------------------------
// Synchronous boot: env → tier rows → sessions → recorder+mirror spy → APP.
// The app must exist BEFORE the describe tree is collected so suite B can
// iterate the live registry (ground truth) at collection time.
// ---------------------------------------------------------------------------

const savedEnv = ENV_KEYS.reduce((acc, k) => {
  acc[k] = process.env[k];
  return acc;
}, {});
process.env.SESSION_SECRET = SESSION_SECRET;
for (const k of ENV_KEYS.slice(3)) delete process.env[k];
// The gate fires far more scripted mutations than a human admin would:
// lift the per-user mutation budget FOR THIS FILE (env knob, not code).
process.env.WEB_RATE_LIMIT_MUTATION_MAX = "1000000";
// Clearly-fake integration placeholders (never real-shaped values).
process.env.YOUTUBE_API_KEY = YT_KEY;
process.env.TWITCH_CLIENT_ID = "gate-client-id-not-real";
process.env.TWITCH_CLIENT_SECRET = "gate-client-secret-not-real";

// Tier-resolution roles ONLY (mutation subjects stay separate rows).
api.addStaffRole(GUILD_A, ROLE_JUNIOR_TIER, "junior");
api.addStaffRole(GUILD_A, ROLE_SENIOR_TIER, "senior");

const cookieOf = {};
const csrfOf = {};
const sessionIdOf = {};

function mkSession(userKey, userId) {
  const id = harness.createLoginSession({ api, sessionPolicy, tokens }, userId, {
    token: `tok-${userId}`,
  });
  cookieOf[userKey] = `web_session=${id}`;
  sessionIdOf[userKey] = id;
  csrfOf[userKey] = csrfMod.deriveCsrfToken(id, SESSION_SECRET);
}

mkSession("admin", USER_ADMIN);
mkSession("staff", USER_STAFF);
mkSession("senior", USER_SENIOR);
mkSession("plain", USER_PLAIN);
mkSession("stranger", USER_STRANGER);

// The mirror spy is ALREADY installed (module load, shared helper) — the
// two posters are swapped and a truthy fake audit client is bound BEFORE
// createWebApp runs below, same ordering guarantee as the pre-extraction
// boot sequence.

// Fresh REAL settings-data snapshot (cache starts cold; mutations invalidate).
const settingsData = createSettingsData();

const resolver = guildAccessMod.createGuildAccessResolver({
  discord: fakeDiscord,
  botGuilds: async () => BOT_GUILDS,
  now: Date.now,
  ttlMs: 3_600_000, // resolver caches never expire mid-run
});

const app = createWebApp({
  guildAccess: resolver,
  botGuilds: async () => BOT_GUILDS,
  getClient: () => FAKE_CLIENT,
  settingsData,
  // Integrations service seams — fully offline, deterministic results.
  resolveTwitchUser: async () => ({
    id: TW_ID,
    login: TW_LOGIN,
    display_name: "Gate Stream",
    profile_image_url: "",
  }),
  lookupYoutubeChannel: async () => null,
  fetchYoutubeChannelInfo: async () => null,
  ensureHoneypotWarning: async () => "sent",
  // Ticket summary seam (T3): deterministic offline fake for the slash's
  // OWN summarizeTicket service — no env AI key, no network. The route
  // STILL exercises every guard (parse → guild-scope → sensitive 404 →
  // archived → AI-configured → stored-messages) around the injected call;
  // only the AI/stats body itself is stubbed, exactly like the twitch/yt
  // seams stub ONLY the outbound HTTP.
  ticketActions: {
    isAiConfigured: () => true,
    summarizeTicket: async (ticket, messages) => ({
      source: "fallback",
      model: null,
      resolution: `gate summary for ${ticket.ticket_number}`,
      summary: `gate summary (${(messages || []).length} messages)`,
      message_count: (messages || []).length,
    }),
  },
  // Sync trigger seam (C1): offline fake for the SHARED sync core — ONLY the
  // outbound Discord leg is faked (exactly the twitch/yt seam doctrine).
  // The result shape mirrors applyGuildCommandPermissions' contract; the
  // REAL core's REST sequence + audit parity is proven offline in
  // test/web-visibility-sync.test.js.
  syncActions: {
    runCommandVisibilitySync: async () => ({
      status: "synced",
      result: {
        updated: ["cmd-1", "cmd-2", "cmd-3"],
        failed: [],
        missingCommands: [],
        roleCount: 2,
      },
    }),
  },
});

/** @type {http.Server} */
let server = null;
let base = "";

/** urlencoded POST (real form semantics, redirect:manual). */
async function post(path, { cookie, fields, headers } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      ...(headers || {}),
    },
    body: new URLSearchParams(fields || {}).toString(),
  });
  const body = await res.text();
  return { res, body, location: res.headers.get("location") };
}

/** The newest web-origin audit rows for GUILD_A (details parsed). */
function webAuditRows() {
  return api.listAdminAudit(GUILD_A, { origin: "web", limit: 100 }).map((r) => ({
    ...r,
    details: r.details_json ? JSON.parse(r.details_json) : null,
  }));
}
const webAuditCount = () => api.countAdminAudit(GUILD_A, { origin: "web" });

/**
 * Deterministic purge for the AUTOINCREMENT moderation tables (Phase-3 rows).
 * DELETE alone cannot restore rowids (warnings.id / staff_notes.id are
 * `INTEGER PRIMARY KEY AUTOINCREMENT`), so the sqlite_sequence row is reset
 * too — this keeps W1's warning id/number, W2's void target id and W3's note
 * id/number STATIC (1). Identifiers are this file's own frozen literals; the
 * table name is bound as a parameter to the sequence delete.
 */
function purgeAutoincrement(table) {
  rawDb.prepare(`DELETE FROM ${table}`).run();
  try {
    // sqlite_sequence only exists after the FIRST autoincrement insert.
    rawDb.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
  } catch {
    /* not created yet — nothing to reset */
  }
}

const concretePath = ladder.concretePath;

/** Per-row ladder evidence collector for the runtime tier classification. */
const observed = {}; // template -> { anon, stranger, plain, cross, junior, senior }
const evidence = (template) => (observed[template] ||= {});

// File-scope teardown (runs after every suite has completed).
after(() => {
  if (server) server.close();
  restoreMirrorSpy();
  restoreFacadeRecorder();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
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

// ---------------------------------------------------------------------------
// A. Registry ↔ table ↔ mounted routes integrity (anti-drift tripwire)
// ---------------------------------------------------------------------------

describe("A. mutation registry integrity + PARITY checklist coverage (§8.8/§8.6)", () => {
  before(async () => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  it("runtime registry covers EVERY Phase-2 mutation AND every table row exists (no drift either way)", () => {
    const registry = app.locals.webMutations;
    assert.ok(registry.length >= 30, "registry must enumerate the full Phase-2 surface");
    const regTemplates = new Set(registry.map((m) => m.path));
    const tableTemplates = new Set(PARITY.map((r) => r.template));
    const missingRows = [...regTemplates].filter((t) => !tableTemplates.has(t));
    const staleRows = [...tableTemplates].filter((t) => !regTemplates.has(t));
    assert.deepEqual(
      missingRows,
      [],
      "registered mutations WITHOUT a PARITY row: a new mutation shipped without gate coverage (§8.8)"
    );
    assert.deepEqual(staleRows, [], "PARITY rows without a registered route (stale checklist entry)");
    assert.equal(registry.length, PARITY.length, "1:1 registry ↔ checklist (no duplicate registrations)");
  });

  it("methodGate registry templates == EXACTLY the mounted POST route templates", () => {
    const router = app.router || app._router;
    const mountedPost = [];
    for (const layer of router.stack) {
      const route = layer && layer.route;
      if (!route || !route.methods || route.methods.post !== true) continue;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      for (const p of paths) mountedPost.push(p);
    }
    // /auth/logout is the ONLY POST route riding the methodGate exception
    // without a registry entry (app.js LOGOUT_POST_PATH) — everything else
    // must match the registry exactly, in both directions.
    const registry = app.locals.webMutations.map((m) => m.path).sort();
    const mounted = mountedPost.filter((p) => p !== "/auth/logout").sort();
    assert.deepEqual(mounted, registry, "mounted POST templates == registry templates");
    for (const m of app.locals.webMutations) {
      assert.equal(m.method, "POST", `registry entry ${m.path} is POST-only`);
      assert.match(m.path, /^\/g\/:guildId\//, `registry entry ${m.path} is /g/:guildId-scoped`);
    }
  });

  it("every PARITY tier equals the AGENTS.md §4 tier derived from the template", () => {
    for (const row of PARITY) {
      assert.equal(
        row.tier,
        expectedTierFor(row.template),
        `${row.template}: table tier must equal the §4-derived tier`
      );
    }
  });

  it("every expected helper exists on the src/db facade (renamed drift fails here)", () => {
    for (const row of PARITY) {
      for (const helper of row.helpers) {
        assert.equal(typeof dbFacade[helper], "function", `facade helper ${helper}`);
        assert.ok(
          WRITE_HELPERS.has(helper),
          `${row.template}: expected helper ${helper} must be a WRITE helper`
        );
      }
    }
  });

  it("malformed guild id with a live admin session ⇒ generic 404 on a registered template shape", async () => {
    const { res, body } = await post("/g/oops-not-a-snowflake/staff/role/add", {
      cookie: cookieOf.admin,
      fields: { role_id: ROLE_STAFF, level: "junior", _csrf: csrfOf.admin },
    });
    assert.equal(res.status, 404);
    assert.equal(body, "Not found");
  });
});

// ---------------------------------------------------------------------------
// B. The per-mutation gate — one describe per RUNTIME registry entry, so a
// newly registered mutation WITHOUT a table row fails here by name.
// ---------------------------------------------------------------------------

describe("B. per-mutation acceptance gate — ladder + service + audit + fail-closed (§8.8 Phase 2)", () => {
  // Iterate the RUNTIME registry (ground truth), not the table, so drift
  // produces a NAMED failing suite instead of silent coverage loss.
  for (const entry of app.locals.webMutations) {
    const row = PARITY.find((r) => r.template === entry.path);
    const label = row
      ? `${row.no} · POST ${row.template} · tier=${row.tier} · helpers=${row.helpers.join("+")} · action=${row.action} · mirror=${row.mirror ? 1 : 0}`
      : `!! UNREGISTERED-IN-TABLE · POST ${entry.path}`;

    describe(label, () => {
      if (!row) {
        it("FAIL: mutation registered at runtime with NO parity-table coverage (§8.8 gate)", () => {
          assert.fail(
            `POST ${entry.path} is in app.locals.webMutations without a PARITY row — the Phase-2 gate requires a row for every mutation`
          );
        });
        return;
      }

      // THE LADDER — the shared harness's steps (extracted VERBATIM from
      // this suite by subtask 32; step names + assertions unchanged). The
      // row status flips only AFTER the positive step completed (the row's
      // ladder ran fully before it, same ordering guarantee as before).
      const steps = ladder.buildLadderSteps(row, {
        get base() {
          return base; // ephemeral server URL bound in suite A's before()
        },
        post,
        harness,
        cookieOf,
        csrfOf,
        recorder,
        startWindow,
        stopWindow,
        writeCalls,
        webAuditCount,
        webAuditRows,
        mirrorLog: () => mirrorSpy.log,
        observe: (template, key, status) => {
          (observed[template] ||= {})[key] = status;
        },
        tick,
      });
      for (const step of steps) {
        it(step.name, async () => {
          await step.fn();
          if (step.kind === "positive") row.status = "PASS";
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// C. Runtime tier classification vs AGENTS.md §4 (derived, not grepped)
// ---------------------------------------------------------------------------

describe("C. tier correctness from runtime ladder evidence (AGENTS.md §4)", () => {
  it("admin-tier surfaces (staff-role mutations, command channels, honeypot exempt): junior AND senior were 403'd on every one", () => {
    const adminRows = PARITY.filter((r) => r.tier === "admin");
    assert.ok(adminRows.length >= 7, "admin set covers role×3 + channels×2 + exempt×2 minimum");
    for (const row of adminRows) {
      const ev = evidence(row.template);
      assert.equal(ev.junior, 403, `${row.template}: junior must have been 403 (admin tier)`);
      assert.equal(ev.senior, 403, `${row.template}: senior must have been 403 (admin tier)`);
    }
    // §4 set-equality: the runtime-admin rows are EXACTLY the templates the
    // derived classification marks admin.
    const derivedAdmin = PARITY.filter((r) => expectedTierFor(r.template) === "admin")
      .map((r) => r.template)
      .sort();
    assert.deepEqual(
      adminRows.map((r) => r.template).sort(),
      derivedAdmin,
      "the admin-tier set equals {staff/role/*, command-channels/*, honeypot/exempt/*, xp/grant, commands/sync} — §4 (grantxp + syncpermissions are ManageGuild-only)"
    );
  });

  it("staff-tier surfaces: junior passed the gate (302 PRG) on every one — staff ≥ staff in the ladder", () => {
    for (const row of PARITY.filter((r) => r.tier === "staff")) {
      assert.equal(
        evidence(row.template).junior,
        302,
        `${row.template}: junior (tier=staff) must pass the staff gate via the positive path`
      );
    }
  });

  it("senior-tier surfaces (ticket actions, subtask 30): junior 403'd on EVERY one while the senior viewer passed — the documented §8.6 tightening vs slash requireStaff", () => {
    const seniorRows = PARITY.filter((r) => r.tier === "senior");
    assert.equal(
      seniorRows.length,
      3,
      "the senior set is EXACTLY claim + close + summarize (§8.6 Tickets row)"
    );
    assert.deepEqual(
      seniorRows.map((r) => r.template).sort(),
      PARITY.filter((r) => expectedTierFor(r.template) === "senior")
        .map((r) => r.template)
        .sort(),
      "runtime-senior set equals the derived classification"
    );
    for (const row of seniorRows) {
      const ev = evidence(row.template);
      assert.equal(ev.junior, 403, `${row.template}: junior must have been 403 (senior tier)`);
      assert.equal(ev.senior, 302, `${row.template}: senior must have PASSED via the positive path`);
    }
  });

  it("cross-cutting ladder is uniform: anon 302 · stranger 404 · plain 404 · cross 404 on ALL rows", () => {
    for (const row of PARITY) {
      const ev = evidence(row.template);
      assert.equal(ev.anon, 302, row.template);
      assert.equal(ev.stranger, 404, row.template);
      assert.equal(ev.plain, 404, row.template);
      assert.equal(ev.cross, 404, row.template);
    }
  });
});

// ---------------------------------------------------------------------------
// D. Known intentional deltas (documented checklist rows, proven behavior)
// ---------------------------------------------------------------------------

describe("D. KNOWN INTENTIONAL DELTAS vs slash (documented rows)", () => {
  it("DELTA-A: event-reminder create/edit/clear/sync are slash-only — NO web routes registered (byte 405) and web owns setchannel ONLY", async () => {
    const erRoutes = app.locals.webMutations.filter((m) =>
      m.path.startsWith("/g/:guildId/integrations/event-reminders/")
    );
    assert.deepEqual(
      erRoutes.map((m) => m.path),
      ["/g/:guildId/integrations/event-reminders/channel"],
      "web side owns setchannel ONLY (creator axis has no web notion — integrations.js header)"
    );
    for (const sub of ["create", "edit", "clear", "sync"]) {
      await harness.runOutcome({
        base,
        url: `/g/${GUILD_A}/integrations/event-reminders/${sub}`,
        method: "POST",
        cookieId: cookieOf.admin,
        expect: harness.expectMethodNotAllowed(),
        label: `eventreminder ${sub}`,
      });
    }
  });

  it("DELTA-B: youtube/add REFUSES without YOUTUBE_API_KEY (slash silently stores — web hardening); zero writes, zero audits", async () => {
    // Clean any row the B-suites' fail-injection left behind, so the
    // absence assert below speaks ONLY about this refused request.
    api.removeYoutubeChannel(GUILD_A, YT_ID);
    const saved = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    const before = webAuditCount();
    startWindow();
    const { res, location } = await post("/g/" + GUILD_A + "/integrations/youtube/add", {
      cookie: cookieOf.staff,
      fields: { url: YT_URL, _csrf: csrfOf.staff },
    });
    const calls = stopWindow();
    if (saved !== undefined) process.env.YOUTUBE_API_KEY = saved;
    assert.equal(res.status, 302);
    assert.equal(location, `/g/${GUILD_A}/integrations?error=youtube_not_configured`);
    assert.deepEqual(
      writeCalls(calls),
      [],
      "the refusal wrote NOTHING (the slash's silent store is the delta)"
    );
    assert.equal(webAuditCount(), before, "the refusal audited NOTHING");
    assert.equal(
      api.getYoutubeChannels(GUILD_A).find((c) => c.id === YT_ID),
      undefined,
      "no silent unresolved store like the slash path"
    );
  });

  it("DELTA-C: honeypot exempt reuses the staff.role_add/remove vocabulary with via=honeypot.exempt over the shared staff_roles table", () => {
    // The positive paths of rows H1/H2 already pinned action + details +
    // helpers (addStaffRole/removeStaffRole — the same facade helpers
    // /staff role add uses and the slash exempt group uses). Here: no
    // INVENTED action strings exist anywhere under origin 'web'.
    const actions = new Set(webAuditRows().map((r) => r.action));
    for (const invented of ["honeypot.exempt_add", "honeypot.exempt_remove", "honeypot.exempt"]) {
      assert.ok(!actions.has(invented), `no invented action ${invented}`);
    }
    const exemptRow = webAuditRows().find(
      (r) => r.action === "staff.role_add" && r.target_id === ROLE_EXEMPT
    );
    assert.ok(exemptRow, "H1 positive wrote staff.role_add for the exempt role");
    assert.deepEqual(exemptRow.details, { via: "honeypot.exempt" });
  });

  it("the exempt pair is ADMIN-tier: junior AND senior were 403'd on both (runtime evidence)", () => {
    for (const t of [
      "/g/:guildId/integrations/honeypot/exempt/add",
      "/g/:guildId/integrations/honeypot/exempt/del",
    ]) {
      assert.equal(evidence(t).junior, 403, `${t}: junior 403`);
      assert.equal(evidence(t).senior, 403, `${t}: senior 403`);
    }
  });

  it("DELTA-D: ticket summarize web-hardens a SENSITIVE ticket to the generic 404 (slash summarizes it in-channel ephemeral); zero writes, zero audits (§8.4)", async () => {
    // The ONE web ticket refusal with no slash twin: sensitive content never
    // reaches the web transport (routes/ticketActions.js header delta (2)).
    purgeAutoincrement("tickets");
    rawDb.prepare("DELETE FROM ticket_messages").run();
    const t = api.createTicket({
      guildId: GUILD_A,
      creatorUserId: "560000000000000301",
      channelId: null,
      reason: "sensitive gate probe",
    });
    api.setTicketSensitive(t.id, USER_SENIOR);
    api.saveTicketMessages(t.id, [
      { message_id: "9101", author_id: "560000000000000301", content: "private content", sent_at: 1 },
    ]);
    const before = webAuditCount();
    startWindow();
    const { res, body } = await post(`/g/${GUILD_A}/tickets/summarize`, {
      cookie: cookieOf.senior,
      fields: { ticket_id: String(t.id), _csrf: csrfOf.senior },
    });
    const calls = stopWindow();
    assert.equal(res.status, 404, "sensitive ⇒ indistinguishable from unknown");
    assert.equal(body, "Not found");
    assert.deepEqual(writeCalls(calls), [], "the refusal wrote NOTHING");
    assert.equal(webAuditCount(), before, "the refusal audited NOTHING (no enumeration signal)");
  });
});

// ---------------------------------------------------------------------------
// E. Cross-cutting: methodGate byte-parity + legacy surfaces (unit)
// ---------------------------------------------------------------------------

describe("E. cross-cutting 405 parity + legacy-surface registration ban (§8.8 Phase 0a contract)", () => {
  it("junk subpaths under /g/ are byte-identical 405 (never reach CSRF/router)", async () => {
    for (const p of [
      "/settings/nonexistent",
      "/staff/role/unknown",
      "/staff/role/add/extra",
      "/integrations/youtube/unknown",
      "/integrations/honeypot/exempt/unknown",
      "/totally/unknown",
    ]) {
      await harness.runOutcome({
        base,
        url: `/g/${GUILD_A}${p}`,
        method: "POST",
        cookieId: cookieOf.admin,
        expect: harness.expectMethodNotAllowed(),
        label: `POST ${p}`,
      });
    }
  });

  it("non-POST verbs on registered templates ⇒ byte 405 (the gate whitelists POST only)", async () => {
    for (const row of PARITY) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        await harness.runOutcome({
          base,
          url: concretePath(row.template, GUILD_A),
          method,
          cookieId: cookieOf.admin,
          expect: harness.expectMethodNotAllowed(),
          label: `${method} ${row.template}`,
        });
      }
    }
  });

  it("legacy surfaces stay unmutatable: POST /auth/login, /t*, /static/* ⇒ byte 405", async () => {
    for (const url of [
      "/auth/login",
      "/t",
      "/t/00000000-0000-4000-8000-000000000000",
      "/static/app.js",
    ]) {
      await harness.runOutcome({
        base,
        url,
        method: "POST",
        cookieId: cookieOf.admin,
        expect: harness.expectMethodNotAllowed(),
        label: `POST ${url}`,
      });
    }
  });

  it("UNIT: registerWebMutation throws for every non /g/:guildId surface (legacy /t + /auth included)", () => {
    const fakeApp = { locals: { webMutations: [] } };
    for (const bad of [
      "/t/mutate",
      "/auth/login",
      "/auth/logout",
      "/g/mutate", // /g-prefixed but no :guildId token
      "/static/x",
      "/oauth/command-permissions/callback",
    ]) {
      assert.throws(
        () => registerWebMutation(fakeApp, "POST", bad),
        /must be \/g\/:guildId-scoped/,
        bad
      );
    }
    // Safe methods are refused too — mutations must never be GET/HEAD.
    assert.throws(() => registerWebMutation(fakeApp, "GET", "/g/:guildId/ok"), /mutations must not use GET/);
    assert.throws(() => registerWebMutation(fakeApp, "HEAD", "/g/:guildId/ok"), /mutations must not use HEAD/);
    // The one legal shape registers exactly once (verb normalizes).
    registerWebMutation(fakeApp, "post", "/g/:guildId/x/ok");
    assert.deepEqual(fakeApp.locals.webMutations, [{ method: "POST", path: "/g/:guildId/x/ok" }]);
  });
});

// ---------------------------------------------------------------------------
// F. getClient boot wiring (§8.6 cache-only seam): boot unit + threading
// ---------------------------------------------------------------------------

describe("F. getClient boot wiring (features/web start → startWebServer({getClient}) → route options)", () => {
  it("threading: createWebApp(options).getClient reaches the settings route (cached fake channel NAME renders on the live page)", async () => {
    api.updateGuildSettings(GUILD_A, { audit_log_channel_id: CH_AUDIT });
    api.updateGuildSettings(GUILD_A, { message_log_channel_id: null });
    settingsData.invalidate?.(GUILD_A); // force a cold read of the seeded id

    const res = await harness.request(base, `/g/${GUILD_A}/settings`, {
      cookieId: sessionIdOf.admin,
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("shell-bar"), "rendered inside the shell");
    assert.ok(
      res.body.includes(GATE_CHANNEL_NAME),
      "the FAKE client's cached channel name surfaced ⇒ options.getClient threaded through to routes/settings"
    );
    assert.ok(res.body.includes(CH_AUDIT), "the raw id stays rendered too");
  });

  it("boot unit: features/web start(client) calls startWebServer({ getClient }) bound to the live client", () => {
    const serverPath = require.resolve("../src/web/server");
    const featurePath = require.resolve("../src/features/web");
    const botGuildsMod = require("../src/web/auth/botGuilds");
    const captured = [];
    const prevServer = require.cache[serverPath];
    require.cache[serverPath] = {
      id: serverPath,
      filename: serverPath,
      loaded: true,
      exports: {
        startWebServer: (opts) => {
          captured.push(opts);
          return null;
        },
        stopWebServer: async () => {},
      },
    };
    const bootClient = { __gateBootClient: true, guilds: { cache: { keyArray: () => [GUILD_A] } } };
    try {
      delete require.cache[featurePath];
      const webFeature = require(featurePath);
      webFeature.start(bootClient);
    } finally {
      if (prevServer) require.cache[serverPath] = prevServer;
      else delete require.cache[serverPath];
      delete require.cache[featurePath];
      botGuildsMod.setBotGuildsProvider(null); // undo the feature's boot wiring
      bindAuditClient({ __gateFakeAuditClient: true }); // mirror spy owns the bind again
    }
    assert.equal(captured.length, 1, "startWebServer called exactly once by features/web start()");
    const opts = captured[0];
    assert.equal(typeof opts.getClient, "function", "startWebServer({ getClient }) threading (server.js → createWebApp)");
    assert.equal(opts.getClient(), bootClient, "the bound provider returns the boot client");
  });
});

// ---------------------------------------------------------------------------
// G. GATE REPORT — the §8.8 Phase-2 evidence artifact on stderr (same
// channel as the Phase-1 gate report) + checklist completeness assert.
// ---------------------------------------------------------------------------

describe("G. gate report — slash parity checklist (§8.8 artifact)", () => {
  it("every checklist area is covered by a PASSed row (settings, channels, logs, cooldowns, decay, staff+levels, level roles, integrations, exempt, moderation)", () => {
    const REQUIRED_AREAS = [
      "settings",
      "command channels",
      "staff roles",
      "level roles",
      "youtube",
      "twitch",
      "reaction roles",
      "event reminders",
      "honeypot",
      "honeypot exempt",
      // Phase 3 (subtask 29): the moderation surface is checklist-mandatory.
      "warnings",
      "staff notes",
      // Phase 3 (subtask 30): the ticket ACTIONS surface is mandatory too.
      "tickets",
    ];
    const passed = PARITY.filter((r) => r.status === "PASS");
    assert.equal(passed.length, PARITY.length, "every mutation row must have PASSed (a ladder failed earlier)");
    const areas = PARITY.map((r) => r.area.toLowerCase()).join(" | ");
    for (const area of REQUIRED_AREAS) {
      assert.ok(areas.includes(area.toLowerCase()), `checklist area missing: ${area} (§8.8 Phase 2 exit)`);
    }

    const lines = [
      "",
      "== PHASE-2 GATE — SLASH PARITY CHECKLIST (subtask 27, roadmap §8.8) ==",
      "template | method | tier | helpers | action | mirror | status",
    ];
    for (const row of PARITY) {
      lines.push(
        `${row.template} | ${row.method} | ${row.tier} | ${row.helpers.join("+")} | ${row.action} | ${row.mirror ? "yes" : "no"} | ${row.status}`
      );
    }
    lines.push(
      "DELTAS: (a) event-reminder create/edit slash-only · (b) youtube/add env-refusal hardening · (c) honeypot exempt → staff.role_add/remove via='honeypot.exempt' · (d) ticket actions SENIOR-only (slash requireStaff) + sensitive summarize ⇒ generic 404 + no-AI regen refused up front + staff_note add-on slash-only",
      `rows=${PARITY.length} passed=${passed.length}`,
      ""
    );
    console.error(lines.join("\n")); // gate evidence → stderr (house convention)
  });
});
