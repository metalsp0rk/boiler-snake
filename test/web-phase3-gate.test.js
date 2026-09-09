/**
 * Subtask 32 — FINAL PROGRAM GATE (roadmap/web-admin.md §8.8 Phase 3 exit:
 * "Full slash↔web equivalence matrix …, audit origin verified on all
 * mutations, tier conformance sweep" — the whole web-admin program, one
 * file).
 *
 * WHAT THIS GATE IS:
 *  THE MATRIX (A): the ground truth for "what is a mutation" is the RUNTIME
 *  registry app.locals.webMutations (40 templates). Every template has a
 *  row in the shared PARITY matrix (test/helpers/mutation-ladder.js —
 *  extracted VERBATIM from the Phase-2 gate, so the ladder a row walks here
 *  is BIT-IDENTICAL to the ladder the Phase-2 gate walks); the four §8.6
 *  rules (auth ladder, CSRF, tier ladder, PRG) + service-layer helper +
 *  one-audit-row + mirror expectation + fail-closed injection run per row
 *  against a REAL Express 5 app, REAL SQLite and the fake-Discord
 *  transport under the REAL createGuildAccessResolver.
 *
 *  AUDIT-ORIGIN VERIFICATION (B): origin is minted by the MIDDLEWARE, never
 *  by the client. (1) static: the middleware file cannot read origin from
 *  body/query, the default is the constant 'web', recordSlashAudit defaults
 *  'slash', recordSystemAudit is 'system' by construction, and the
 *  repository whitelist is EXACTLY ['web','slash','system'] (unknown
 *  values normalize — pinned at runtime); (2) forgery: EVERY one of the 40
 *  mutations is POSTed with forged origin / audit_origin / actor_user_id /
 *  guild_id / target fields — the mutation still succeeds writing ITS OWN
 *  origin 'web' row with ITS OWN actor/guild/target; (3) fail-closed probes
 *  on the Phase-3 surfaces (audit insert throws ⇒ generic 500, zero rows,
 *  zero mirrors); (4) a REAL system-origin write runs (the warn-expiry
 *  ticker) so all three origins exist and are distinguishable.
 *
 *  TIER CONFORMANCE (C): the final GET surface map is enumerated LIVE from
 *  the router and swept for every viewer class (anon ⇒ 302, stranger /
 *  plain / cross-guild ⇒ generic 404, junior/senior/admin ⇒ 200 vs the
 *  fixed 403 exactly per tier), then reconciled with the MUTATION ladder's
 *  runtime evidence — the mutation tiers equal the AGENTS.md §4 template
 *  derivation, and the pages answer per their own requireTier.
 *
 *  REGISTRY INTEGRITY (D): registry == mounted POST routes (both
 *  directions, on ALL THREE app instances), registerWebMutation refuses
 *  every non-/g/:guildId surface, every unregistered mutation-shaped path
 *  and legacy surface answers the byte-identical 405 — including the
 *  INTENTIONALLY unregistered POST /g/:guildId/staff/sync-permissions pin
 *  (subtask 31: the legacy slash-name path must stay inert while the web
 *  trigger lives at /commands/sync).
 *
 *  BOOT WIRING (E): startWebServer threads options into createWebApp
 *  verbatim; features/web start(client) binds it; and the live client
 *  resolves names through the cache-only seams of the three Phase-3
 *  consumer areas (users profile ⇐ member cache, staff page ⇐ role-name
 *  cache, warn DM ⇐ guild-name cache, ticket claim ⇐ channel cache).
 *
 *  TWO-TRANSPORT PARITY (F): the five Phase-3 areas run the SLASH handler
 *  and the WEB route SIDE BY SIDE in one process with the shared fakes,
 *  and every observable is deep-equal — DB end-state, admin_audit columns
 *  (everything except the origin, which is asserted separately), Discord
 *  outbound SEQUENCES (channel sends, DM payloads, permission-overwrite
 *  calls, the real sync REST/PUT sequence with headers + bodies), and every
 *  refusal class. Only wall-clock timestamps, AUTOINCREMENT ids the two
 *  runs cannot share (normalized to refs), and the origin itself differ —
 *  each normalization is a named, documented map. The documented deltas
 *  (senior-tier ticket writes, sensitive-summarize 404, ai_not_configured,
 *  staff-only event-reminder create, youtube key hardening, honeypot
 *  exempt→role vocabulary, sync-no-audit-on-hard-fail) are ASSERTED as
 *  their own rows, never hidden.
 *
 *  PROGRAM INVARIANT (G): every audit row the program can mint is LEDGERED
 *  the moment it is produced; at the end, a raw SQL GROUP BY over
 *  admin_audit must equal the ledger EXACTLY — same keys, same counts, no
 *  stray action string, no forged origin, no foreign guild. Then the full
 *  matrix prints to stderr (the §8.8 artifact, template|method|tier|
 *  helpers|action|parity-status|delta-ref).
 *
 * Fully offline (the sync parity run replaces global.fetch AND
 * discord.js REST.prototype.get for the duration of its suite; every
 * off-mock URL THROWS). Sessions minted directly; secrets are clearly
 * fake sentinels (AGENTS.md). Zero real network.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("fs");
const { once } = require("node:events");
const { loadDb } = require("./helpers/env");

// loadDb FIRST: fresh SQLite + src require-cache reset; every require below
// binds to that DB (gate boot discipline — phase 1/2 lineage).
const { api, tmpDir } = loadDb();

const harness = require("./helpers/access-matrix");
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
const { db: rawDb } = require("../src/db/connection");
ladder.bindRawDelete((sql) => rawDb.prepare(sql).run());

// The slash-handler requires are DELIBERATELY deferred to AFTER
// installFacadeRecorder below: awardXp/close.js DESTRUCTURE their facade
// helpers at module-load time (`const { addXp } = require("../db")`), so
// first-load must happen AFTER the recorder wraps the exports — otherwise
// those modules capture the raw functions and the ladder's "web path must
// call the slash helper" evidence would be blind (same boot order the
// Phase-2 gate relies on, where features lazy-load after the recorder).
const { PermissionFlagsBits } = require("discord.js");
const { REST } = require("discord.js");

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
const SESSION_SECRET = "test-gate3-sentinel-session-secret-NOT-REAL-032";
const YT_KEY = "YOUR_YOUTUBE_API_KEY-placeholder-not-real";
const FAKE_CLIENT_ID = "902000000000000002";
const FAKE_CLIENT_SECRET = "test-gate3-oauth-sentinel-secret-NOT-REAL";
const SYNC_PORT_STUB = "59231"; // env-only (nothing binds it)
const SYNC_BASE_URL = "http://localhost:59231";
// The STORED slash-OAuth access token (decision 9: the sync PUTs carry
// THIS, never a web session token — the web session tokens are tok-<id>).
const STORED_AT = "stored-at-sentinel-NOT-REAL-GATE3";
const STORED_RT = "stored-rt-sentinel-NOT-REAL-GATE3";

// Phase-3 gate-local fixtures.
const BOT_ID = "100000000000000009";
const GATE_GUILD_NAME = "GATE-GUILD-NAME-7b3d"; // warn DM title threading marker
const GATE_ROLE_NAME = "GATE-ROLE-NAME-9c1e"; // staff page name threading marker
const ROLE_NAME_PROBE = "500000000000000299";
const CH_TICKET = "600000000000000116"; // ticket parity channel (cache)
const USER_P_SUB = "448190112345678911"; // xp parity subject (cache-absent)
const USER_W_SUB = "448190112345678912"; // warn/note parity subject (DM target)
const USER_W_E_probe = "448190112345678913"; // E moderation probe subject
const USER_T_CREATOR = "560000000000000301"; // ticket requester (DM target)
const USER_UNKNOWN = "900000000000000555"; // users-page member-cache probe
const USER_EXPIRE = "448190112345678914"; // system-origin expiry probe

const ENV_KEYS2 = ENV_KEYS.concat(["AI_API_KEY", "OPENAI_API_KEY", "OAUTH_REDIRECT_URI"]);

// The REAL fetch, captured BEFORE any suite may replace global.fetch
// (the sync parity suite). Every web POST/GET in this file uses it, so the
// sync mock can never capture or break a normal probe.
const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Fake Discord transport under the REAL resolver (gate1/gate2 pattern)
// ---------------------------------------------------------------------------

const fakeDiscord = ladder.makeFakeDiscord();

// ---------------------------------------------------------------------------
// Fake discord.js client — CACHE-ONLY seams with FULL OUTBOUND CAPTURE.
// Every channel records sent[] + overwriteCalls[]; DM targets record sent[].
// The same object doubles as the getClient-threading proof (channel NAME,
// role NAME, guild NAME) for suite E.
// ---------------------------------------------------------------------------

const FAKE_CHANNELS = Object.fromEntries(
  [CH_AUDIT, CH_MESSAGE, CH_WARN, CH_CMD, CH_HONEY, CH_TICKET].map((id) => [
    id,
    ladder.makeFakeChannel(id, id === CH_AUDIT ? GATE_CHANNEL_NAME : `Gate ${id.slice(-3)}`),
  ])
);
const FAKE_ROLES = Object.fromEntries(
  [ROLE_STAFF, ROLE_LEVEL, ROLE_UPLOAD, ROLE_TW, ROLE_BAN, ROLE_EXEMPT].map((id) => [
    id,
    { id, name: `GateRole-${id.slice(-3)}`, position: 10, managed: false },
  ])
);
// Tier-resolution roles live in the guild role cache too (ticket
// overwrites resolve the SENIOR staff role from it — deterministic on both
// transports).
FAKE_ROLES[ROLE_JUNIOR_TIER] = { id: ROLE_JUNIOR_TIER, name: "Gate Junior Staff", position: 10, managed: false };
FAKE_ROLES[ROLE_SENIOR_TIER] = { id: ROLE_SENIOR_TIER, name: "Gate Senior Staff", position: 10, managed: false };

function makeDmUser(id, username) {
  return {
    id,
    username,
    tag: null,
    bot: false,
    sent: [],
    async send(payload) {
      this.sent.push(payload);
      return { id: "dm-1" };
    },
  };
}

const DM_USERS = {
  [USER_T_CREATOR]: makeDmUser(USER_T_CREATOR, "gate-creator"),
  [USER_W_SUB]: makeDmUser(USER_W_SUB, "gate-warn-subject"),
  [USER_W_E_probe]: makeDmUser(USER_W_E_probe, "gate-e-warn-subject"),
};

const FAKE_CLIENT = ladder.buildFakeCacheClient({
  guildId: GUILD_A,
  guildName: GATE_GUILD_NAME,
  channelMap: FAKE_CHANNELS,
  roleMap: FAKE_ROLES,
  users: new Map(Object.entries(DM_USERS)),
  members: new Map(),
  botUserId: BOT_ID,
  botPosition: 100,
});

// ---------------------------------------------------------------------------
// SERVICE-LAYER counting proxy + mirror spy (DELEGATING — the real poster
// runs, so mirror payloads land in the same channel send[] capture the
// slash path uses; two transports, one capture point per channel).
// ---------------------------------------------------------------------------

const recorder = {
  active: false,
  log: [],
  auditThrow: false, // §8.1-7 fail-closed injection flag
};
const restoreFacadeRecorder = ladder.installFacadeRecorder(dbFacade, recorder);

// slash handlers — loaded ONLY AFTER the recorder exists (see note up top):
// awardXp/close.js bind their db helpers by destructure at first load.
const xpFeature = require("../src/features/xp");
const warningsFeature = require("../src/features/warnings");
const warningsTicker = require("../src/features/warnings/ticker");
const staffNotesFeature = require("../src/features/staffNotes");
const ticketsFeature = require("../src/features/tickets");
const staffRolesFeature = require("../src/features/staffRoles");

function startWindow() {
  recorder.log = [];
  recorder.active = true;
}
function stopWindow() {
  recorder.active = false;
  return recorder.log.slice();
}

const { writeCalls } = ladder;
const tick = ladder.tick;

const mirrorSpy = ladder.installMirrorSpy(auditLogMod, bindAuditClient, {
  delegate: true,
  client: FAKE_CLIENT,
});

// ---------------------------------------------------------------------------
// Boot: env → tier rows → sessions → audit-channel seeds → THREE apps →
// ledger. (appMain: the subtask-30/31 seams (deterministic fake summarizer
// + fake sync leg) so the 40-row ladder stays offline and static;
// appReal: NO sync seam + AI-guardrail-only seam → the REAL sync core and
// the REAL summarize service run on it; appNoAi: isAiConfigured=false →
// the ai_not_configured refusal delta.)
// ---------------------------------------------------------------------------

const savedEnv = ENV_KEYS2.reduce((acc, k) => {
  acc[k] = process.env[k];
  return acc;
}, {});
process.env.SESSION_SECRET = SESSION_SECRET;
for (const k of ENV_KEYS2.slice(3)) delete process.env[k];
process.env.WEB_RATE_LIMIT_MUTATION_MAX = "1000000";
process.env.YOUTUBE_API_KEY = YT_KEY;
process.env.TWITCH_CLIENT_ID = "gate3-client-id-not-real";
process.env.TWITCH_CLIENT_SECRET = "gate3-client-secret-not-real";
// (AI_API_KEY / OPENAI_API_KEY are deleted above — the REAL summarizer must
// take its offline fallback path on both transports.)

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

// Deterministic AUTOINCREMENT purge (shared matrix rows depend on it).
function purgeAutoincrement(table) {
  rawDb.prepare(`DELETE FROM ${table}`).run();
  try {
    rawDb.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
  } catch {
    /* sqlite_sequence not created yet */
  }
}

// Mirror/log-channel seeds (both transports resolve the SAME channels).
api.updateGuildSettings(GUILD_A, { audit_log_channel_id: CH_AUDIT });
api.updateGuildSettings(GUILD_A, { warn_log_channel_id: CH_WARN });

// The leaderboard USER page 404s for users WITHOUT data (unknown-user
// doctrine, not a tier signal) — the C sweep's :userId subject needs a
// seeded XP row (phase-1 precedent: the tracked-user fixture).
api.setXp(GUILD_A, USER_WARN_SUBJECT, 1234);

const settingsData = createSettingsData();
const resolver = guildAccessMod.createGuildAccessResolver({
  discord: fakeDiscord,
  botGuilds: async () => BOT_GUILDS,
  now: Date.now,
  ttlMs: 3_600_000,
});

const BASE_APP_OPTS = {
  guildAccess: resolver,
  botGuilds: async () => BOT_GUILDS,
  getClient: () => FAKE_CLIENT,
  settingsData,
  resolveTwitchUser: async () => ({
    id: TW_ID,
    login: TW_LOGIN,
    display_name: "Gate Stream",
    profile_image_url: "",
  }),
  lookupYoutubeChannel: async () => null,
  fetchYoutubeChannelInfo: async () => null,
  ensureHoneypotWarning: async () => "sent",
};

const appMain = createWebApp({
  ...BASE_APP_OPTS,
  // The ladder's T3/C1 rows stay static + offline (identical seams to the
  // Phase-2 gate — the shared row expectations depend on them).
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

// Real-core twin: NO sync seam; summarize uses the REAL service behind an
// AI-guardrail-true seam (offline env ⇒ the service itself falls back).
const appReal = createWebApp({
  ...BASE_APP_OPTS,
  ticketActions: { isAiConfigured: () => true },
});

// AI-off twin: the web refuses regen up front (documented delta (3)).
const appNoAi = createWebApp({
  ...BASE_APP_OPTS,
  ticketActions: { isAiConfigured: () => false },
});

/** @type {http.Server[]} */
const servers = [];
let baseMain = "";
let baseReal = "";
let baseNoAi = "";

// ---------------------------------------------------------------------------
// HTTP helpers — ALL bound to realFetch (never the sync-suite mock).
// ---------------------------------------------------------------------------

async function postRaw(base, path, { cookie, fields, headers } = {}) {
  const res = await realFetch(`${base}${path}`, {
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
function post(path, opts) {
  return postRaw(baseMain, path, opts);
}

// ---------------------------------------------------------------------------
// Audit access + THE LEDGER (every produced audit row is booked the moment
// it is produced; suite G reconciles admin_audit against it with raw SQL).
// ---------------------------------------------------------------------------

function auditRows(origin, limit = 100) {
  return api
    .listAdminAudit(GUILD_A, { origin, limit })
    .map((r) => ({ ...r, details: r.details_json ? JSON.parse(r.details_json) : null }));
}
const auditCount = (origin) => api.countAdminAudit(GUILD_A, { origin });

function sqlAuditGroups() {
  return rawDb
    .prepare(
      "SELECT origin, action, COUNT(*) AS n FROM admin_audit GROUP BY origin, action ORDER BY origin, action"
    )
    .all();
}
function sqlAuditGuilds() {
  return rawDb.prepare("SELECT DISTINCT guild_id FROM admin_audit ORDER BY guild_id").all();
}

const ledger = new Map(); // "origin|action" -> expected count
function bump(origin, action, n = 1) {
  const key = `${origin}|${action}`;
  ledger.set(key, (ledger.get(key) || 0) + n);
}

/** Newest audit row matching a filter (listAdminAudit is created_at DESC). */
function lastAudit(origin, filter = {}) {
  const rows = auditRows(origin, 100).filter(
    (r) =>
      (filter.action == null || r.action === filter.action) &&
      (filter.actor == null || r.actor_user_id === filter.actor) &&
      (filter.targetId == null || r.target_id === filter.targetId)
  );
  return rows[0] || null;
}

/** The comparable semantic columns of an audit row (origin EXCLUDED — the
 *  parity claim is "everything except the origin, plus the origin
 *  asserted"). id/created_at are per-insert bookkeeping, never semantic. */
function auditCmp(r) {
  return {
    guild_id: r.guild_id,
    actor_user_id: r.actor_user_id,
    action: r.action,
    target_type: r.target_type,
    target_id: r.target_id,
    details: r.details,
  };
}

// ---------------------------------------------------------------------------
// Slash-fake interactions (the same fake-interaction doctrine the feature
// suites use; actor label fields stay UNSET so userLabel() resolves the
// web twin's "Unknown (`id`)" mirror actor label byte-identically).
// ---------------------------------------------------------------------------

function slashInteraction({
  userId,
  sub,
  group = null,
  channel = null,
  memberRoleIds = [ROLE_SENIOR_TIER],
  manageGuild = false,
  strings = {},
  ints = {},
  bools = {},
  users = {},
}) {
  return {
    guildId: GUILD_A,
    channelId: channel ? channel.id : "700000000000000701",
    user: { id: userId, bot: false },
    member: { roles: { cache: new Map(memberRoleIds.map((r) => [r, { id: r }])) } },
    guild: FAKE_CLIENT.__guild,
    channel,
    client: FAKE_CLIENT,
    commandName: sub,
    memberPermissions: {
      has: (bit) => manageGuild && bit === PermissionFlagsBits.ManageGuild,
    },
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => group,
      getString: (n) => (strings[n] == null ? null : strings[n]),
      getInteger: (n) => (ints[n] == null ? null : ints[n]),
      getBoolean: (n) => (bools[n] == null ? null : bools[n]),
      getUser: (n) => (users[n] == null ? null : users[n]),
      getRole: () => null,
      getChannel: () => null,
    },
    replies: [],
    deferred: false,
    async deferReply(o) {
      this.deferred = true;
      this.replies.push({ defer: true, o });
    },
    async reply(o) {
      this.replies.push({ reply: o });
    },
    async editReply(o) {
      this.replies.push({ edit: o });
    },
    async followUp(o) {
      this.replies.push({ followUp: o });
    },
    async showModal(m) {
      this.replies.push({ modal: m });
    },
  };
}

/** Deep-normalizer for cross-transport payload/audit comparison.
 *  Every substitution is a NAMED, DOCUMENTED normalization:
 *   - <SUBJ> <ACTOR> <CH> ... : the fixture ids the two runs may differ on
 *     (parity runs use the SAME ids where the row can, so the maps are
 *     usually identity — they exist for the ids that CANNOT match, e.g.
 *     per-run AUTOINCREMENT numbers).
 *   - W-1 → W-N / N-1 → N-N / T-1 → T-N : per-run warning/note/ticket refs.
 *   - <T> : Discord <t:…> timestamps, raw ms, AND embed .timestamp ISO
 *     strings — the two runs cannot share wall-clock time. */
function deepNormalize(value, idMap = {}) {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    (_k, v) => {
      if (typeof v !== "string") return v;
      let s = v;
      s = s.replace(/W-\d+/g, "W-N").replace(/N-\d+/g, "N-N").replace(/T-\d+/g, "T-N");
      s = s.replace(/<t:\d+:[A-Za-z]+>/g, "<T>");
      s = s.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/, "<T>");
      s = s.replace(/\d{10,}\b/g, (m) => (idMap[m] != null ? idMap[m] : m));
      for (const [id, label] of Object.entries(idMap)) s = s.split(id).join(label);
      return s;
    }
  );
}

function embedsOf(payload) {
  const embeds = payload?.embeds;
  if (!Array.isArray(embeds)) return payload;
  return embeds.map((e) => (e && typeof e.toJSON === "function" ? e.toJSON() : e));
}

/** Outbound call recorder → comparable JSON-safe sequence (bigint bitfields
 *  and entity objects collapse to ids). */
function outSig(entries) {
  return JSON.parse(
    JSON.stringify(entries, (_k, v) => {
      if (typeof v === "bigint") return String(v);
      if (v && typeof v === "object" && v.id != null && (v.name != null || v.user || v.roles)) {
        return { __entity: String(v.id) };
      }
      if (v && typeof v === "object" && v.id != null && typeof v.ticket_number === "number") {
        return { __ticket: v.ticket_number };
      }
      return v;
    })
  );
}

function resetChannelCapture() {
  for (const ch of Object.values(FAKE_CHANNELS)) {
    ch.sent.length = 0;
    ch.overwriteCalls.length = 0;
  }
  for (const u of Object.values(DM_USERS)) u.sent.length = 0;
}

/** Everything a channel + DM user captured since the reset. */
function capture() {
  const out = { channelSends: {}, overwriteCalls: {}, dms: {} };
  for (const [id, ch] of Object.entries(FAKE_CHANNELS)) {
    if (ch.sent.length) out.channelSends[id] = ch.sent.map((p) => embedsOf(p));
    if (ch.overwriteCalls.length) out.overwriteCalls[id] = outSig(ch.overwriteCalls);
  }
  for (const [id, u] of Object.entries(DM_USERS)) {
    if (u.sent.length) out.dms[id] = u.sent.map((p) => embedsOf(p));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The matrix (shared factory) + the observed-evidence map + teardown.
// ---------------------------------------------------------------------------

const PARITY = ladder.buildPhase2Rows({ api, purgeAutoincrement });
for (const row of PARITY) {
  row.status = "PENDING";
  row.parity = null; // "BOTH" | "LADDER" — set by the F suites / matrix print
}

const observed = {}; // template -> { anon, stranger, plain, cross, junior, senior }

/** Rows whose parity runs execute IN THIS FILE (Phase-3 areas). */
const PARITY_RUN_ROWS = new Set(["X1", "W1", "W2", "W3", "T1", "T2", "T3", "C1"]);

const DELTA_REFS = {
  "/g/:guildId/integrations/event-reminders/channel": "DELTA-A (create/edit slash-only)",
  "/g/:guildId/integrations/youtube/add": "DELTA-B (env-key hardening)",
  "/g/:guildId/integrations/honeypot/exempt/add": "DELTA-C (→staff.role_add)",
  "/g/:guildId/integrations/honeypot/exempt/del": "DELTA-C (→staff.role_remove)",
  "/g/:guildId/tickets/claim": "D1 senior-tier tightening (web SENIOR vs slash requireStaff)",
  "/g/:guildId/tickets/close": "D1 senior-tier tightening",
  "/g/:guildId/tickets/summarize": "D1 + D2 sensitive→404 + D3 ai_not_configured + D4 staff-note add-on slash-only",
  "/g/:guildId/commands/sync": "D5 no-audit-on-hard-fail (both transports) + stored-token-only (decision 9)",
};

after(() => {
  for (const s of servers) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  mirrorSpy.restore();
  restoreFacadeRecorder();
  for (const key of ENV_KEYS2) {
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

// ===========================================================================
// A1. Registry ↔ matrix integrity (the matrix is the checklist; the RUNTIME
// registry is the ground truth — both directions or the gate fails by name).
// ===========================================================================

describe("A1. registry ↔ matrix integrity — 40 mutations, no drift (§8.8)", () => {
  before(async () => {
    for (const [app, setter] of [
      [appMain, (b) => (baseMain = b)],
      [appReal, (b) => (baseReal = b)],
      [appNoAi, (b) => (baseNoAi = b)],
    ]) {
      const server = http.createServer(app);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      servers.push(server);
      setter(`http://127.0.0.1:${server.address().port}`);
    }
  });

  it("runtime registry covers EVERY mutation AND every matrix row exists (no drift either way)", () => {
    const registry = appMain.locals.webMutations;
    assert.equal(registry.length, 40, "the final surface is 40 mutations (31 + the 9 Phase-3 templates… verified 1:1 below)");
    const regTemplates = new Set(registry.map((m) => m.path));
    const tableTemplates = new Set(PARITY.map((r) => r.template));
    assert.deepEqual(
      [...regTemplates].filter((t) => !tableTemplates.has(t)),
      [],
      "registered mutations WITHOUT a matrix row: a new mutation shipped without gate coverage (§8.8)"
    );
    assert.deepEqual(
      [...tableTemplates].filter((t) => !regTemplates.has(t)),
      [],
      "matrix rows without a registered route (stale checklist entry)"
    );
    assert.equal(registry.length, PARITY.length, "1:1 registry ↔ matrix (no duplicate registrations)");
  });

  it("every matrix tier equals the AGENTS.md §4 tier derived from the template", () => {
    for (const row of PARITY) {
      assert.equal(row.tier, ladder.expectedTierFor(row.template), `${row.template}: matrix tier must equal the §4-derived tier`);
    }
  });

  it("every expected helper exists on the src/db facade (renamed drift fails here)", () => {
    for (const row of PARITY) {
      for (const helper of row.helpers) {
        assert.equal(typeof dbFacade[helper], "function", `facade helper ${helper}`);
        assert.ok(ladder.WRITE_HELPERS.has(helper), `${row.template}: expected helper ${helper} must be a WRITE helper`);
      }
    }
  });

  it("the three app instances mount the SAME mutation registry (seams never add/remove routes)", () => {
    const norm = (app) => app.locals.webMutations.map((m) => `${m.method} ${m.path}`).sort();
    assert.deepEqual(norm(appReal), norm(appMain), "appReal registry == appMain");
    assert.deepEqual(norm(appNoAi), norm(appMain), "appNoAi registry == appMain");
  });
});

// ===========================================================================
// A2. THE per-mutation acceptance ladder over ALL 40 — the shared ladder
// (extracted VERBATIM from the Phase-2 gate). Ledger books every success.
// ===========================================================================

describe("A2. per-mutation acceptance ladder — all 40 mutations (four §8.6 rules + service + audit + fail-closed)", () => {
  for (const entry of appMain.locals.webMutations) {
    const row = PARITY.find((r) => r.template === entry.path);
    const label = row
      ? `${row.no} · POST ${row.template} · tier=${row.tier} · helpers=${row.helpers.join("+")} · action=${row.action} · mirror=${row.mirror ? 1 : 0}`
      : `!! UNREGISTERED-IN-MATRIX · POST ${entry.path}`;

    describe(label, () => {
      if (!row) {
        it("FAIL: mutation registered at runtime with NO matrix coverage (§8.8 gate)", () => {
          assert.fail(`POST ${entry.path} is in app.locals.webMutations without a matrix row`);
        });
        return;
      }

      const steps = ladder.buildLadderSteps(row, {
        get base() {
          return baseMain;
        },
        post,
        harness,
        cookieOf,
        csrfOf,
        recorder,
        startWindow,
        stopWindow,
        writeCalls,
        webAuditCount: () => auditCount("web"),
        webAuditRows: () => auditRows("web"),
        mirrorLog: () => mirrorSpy.log,
        observe: (template, key, status) => {
          (observed[template] ||= {})[key] = status;
        },
        onSuccess: ({ row: r, origin, actor }) => {
          bump(origin, r.action);
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

// ===========================================================================
// B. AUDIT-ORIGIN VERIFICATION (§8.8 "audit origin verified on all
// mutations").
// ===========================================================================

describe("B. audit-origin verification — origin is minted by the code, never by the client (§8.8)", () => {
  const auditMwSrc = fs.readFileSync(
    require.resolve("../src/web/middleware/audit.js"),
    "utf8"
  );
  const auditTrailSrc = fs.readFileSync(require.resolve("../src/core/auditTrail.js"), "utf8");
  const auditRepoSrc = fs.readFileSync(
    require.resolve("../src/db/repositories/adminAudit.js"),
    "utf8"
  );

  it("static: middleware mints origin from the DEFAULT_AUDIT_ORIGIN constant — and CANNOT read it from the request", () => {
    assert.match(auditMwSrc, /DEFAULT_AUDIT_ORIGIN\s*=\s*"web"/, "origin default is the 'web' constant");
    assert.ok(
      !/body\??\.(origin|audit_origin)/.test(auditMwSrc),
      "the middleware never reads origin/audit_origin from a parsed body"
    );
    assert.ok(
      !/query\??\.(origin|audit_origin)/.test(auditMwSrc),
      "the middleware never reads origin/audit_origin from a query string"
    );
    assert.ok(
      /entry\.origin\s*\?\?\s*DEFAULT_AUDIT_ORIGIN|normalizeAuditOrigin\(entry\.origin\s*\?\?/.test(auditMwSrc),
      "the stored origin flows entry.origin ?? DEFAULT_AUDIT_ORIGIN through the repository normalizer"
    );
  });

  it("static: the slash helper defaults origin 'slash'; the system helper is 'system' by construction; the repo whitelist is EXACTLY web/slash/system", () => {
    assert.match(auditTrailSrc, /entry\.origin\s*\?\?\s*"slash"/, "recordSlashAudit defaults origin 'slash'");
    assert.match(auditTrailSrc, /origin:\s*"system"/, "recordSystemAudit hardcodes origin 'system'");
    assert.match(auditRepoSrc, /AUDIT_ORIGINS\s*=\s*Object\.freeze\(\[[^\]]*"web"[^\]]*"slash"[^\]]*"system"/, "the whitelist is exactly the three known origins");
    // runtime pin of the normalization (unknown origin values NEVER pass
    // through — they normalize to the caller-class default or reject):
    assert.equal(dbFacade.normalizeAuditOrigin("web").ok, true);
    assert.equal(dbFacade.normalizeAuditOrigin("evil-origin").ok, false, "an unknown origin is REJECTED by the repository, not stored");
  });

  it("forgery on EVERY mutation: forged origin/actor/guild/target fields change NOTHING — the row stays origin 'web' with the real actor/guild/target", async () => {
    for (const row of PARITY) {
      const viewer = row.tier === "admin" ? "admin" : row.tier === "senior" ? "senior" : "staff";
      const viewerUser = row.tier === "admin" ? USER_ADMIN : row.tier === "senior" ? USER_SENIOR : USER_STAFF;
      row.prepare();
      const before = auditCount("web");
      startWindow();
      const { res, location } = await post(ladder.concretePath(row.template, GUILD_A), {
        cookie: cookieOf[viewer],
        fields: {
          ...row.fields,
          _csrf: csrfOf[viewer],
          // THE FORGERY — every identity field a client could wish for:
          origin: "slash",
          audit_origin: "system",
          actor_user_id: USER_STRANGER,
          user_id_fallback: USER_STRANGER,
          guild_id: GUILD_CROSS,
          target_id: "0",
          target_type: "forged",
        },
      });
      const calls = stopWindow();
      await tick();
      assert.equal(res.status, 302, `${row.template}: forged probe must still run the mutation (loc ${location})`);
      assert.equal(location, row.okLocation, row.template);
      assert.equal(auditCount("web"), before + 1, `${row.template}: forged probe wrote EXACTLY one 'web' row`);
      const mine = lastAudit("web", { action: row.action, actor: viewerUser, targetId: row.targetId });
      assert.ok(mine, `${row.template}: forged probe audit row carries the REAL actor + target`);
      assert.equal(mine.origin, "web", `${row.template}: forged origin ignored`);
      assert.equal(mine.guild_id, GUILD_A, `${row.template}: forged guild_id ignored`);
      assert.notEqual(mine.actor_user_id, USER_STRANGER, `${row.template}: forged actor_user_id ignored`);
      assert.notEqual(mine.target_type, "forged", `${row.template}: forged target_type ignored`);
      bump("web", row.action);
    }
  });

  it("fail-closed on the Phase-3 surfaces: audit INSERT throws ⇒ generic 500, zero rows, zero mirrors (≥5 probes)", async () => {
    const targets = ["X1", "W1", "W2", "W3", "T1", "T2", "C1"];
    for (const no of targets) {
      const row = PARITY.find((r) => r.no === no);
      assert.ok(row, `row ${no} exists`);
      row.prepare();
      const before = auditCount("web");
      mirrorSpy.log.length = 0;
      recorder.auditThrow = true;
      const realError = console.error;
      console.error = () => {};
      let out;
      try {
        out = await post(ladder.concretePath(row.template, GUILD_A), {
          cookie: cookieOf[row.tier === "admin" ? "admin" : row.tier === "senior" ? "senior" : "staff"],
          fields: { ...row.fields, _csrf: csrfOf[row.tier === "admin" ? "admin" : row.tier === "senior" ? "senior" : "staff"] },
        });
        await tick();
      } finally {
        recorder.auditThrow = false;
        console.error = realError;
      }
      assert.equal(out.res.status, 500, `${row.template}: injected audit failure must 500`);
      assert.equal(out.body, "Internal error");
      assert.equal(out.location, null, `${row.template}: the outcome is never silently claimed`);
      assert.equal(auditCount("web"), before, `${row.template}: the failed insert wrote no audit row`);
      assert.equal(mirrorSpy.log.length, 0, `${row.template}: a failed insert schedules NO channel mirror`);
    }
  });

  it("system origin is REAL and distinguishable: the warn-expiry ticker writes origin 'system' (never 'web', never 'slash')", async () => {
    purgeAutoincrement("warnings");
    const warn = api.createWarning({
      guildId: GUILD_A,
      userId: USER_EXPIRE,
      issuerId: USER_ADMIN,
      reason: "gate expiry probe (must expire)",
      expiresDays: 30,
    });
    // Force-expire it on the raw handle (deterministic; no clock games).
    rawDb.prepare("UPDATE warnings SET expires_at = ? WHERE id = ?").run(Date.now() - 5000, warn.id);
    const before = auditCount("system");
    const res = await warningsTicker.runWarnExpiryTick(null, { now: Date.now(), limit: 200 });
    const after = auditCount("system");
    assert.ok(after > before, `the tick wrote system-origin audit rows (${JSON.stringify(res)})`);
    bump("system", "warnings.expire", after - before);
    const row = lastAudit("system", { action: "warnings.expire" });
    assert.ok(row, "the expiry row exists under origin 'system'");
    assert.equal(row.origin, "system");
    assert.equal(row.guild_id, GUILD_A);
    assert.equal(row.target_type, "warning");
    assert.equal(row.details.subject_user_id, USER_EXPIRE);
    assert.notEqual(row.actor_user_id, USER_ADMIN, "system rows never impersonate a human actor");
    // …and the same action vocabulary family is origin-distinguishable:
    const asSlash = api.listAdminAudit(GUILD_A, { origin: "slash", limit: 100 }).find(
      (r) => r.action === "warnings.expire"
    );
    assert.equal(asSlash, undefined, "the system tick did NOT land under origin 'slash'");
  });
});

// ===========================================================================
// C. TIER CONFORMANCE — final GET surface map (live enumeration) + ladder
// reconciliation.
// ===========================================================================

const PAGES = [
  { path: "/g/:guildId", tier: "staff", marker: "<h1>Dashboard" },
  { path: "/g/:guildId/users", tier: "staff", marker: "<h1>Users" },
  { path: "/g/:guildId/users/:userId", tier: "staff", marker: "<h1>User profile" },
  { path: "/g/:guildId/users/:userId/activity", tier: "senior", marker: "<h1>User profile" },
  { path: "/g/:guildId/warnings", tier: "staff", marker: "<h1>Warnings" },
  { path: "/g/:guildId/notes", tier: "staff", marker: "<h1>Staff notes" },
  { path: "/g/:guildId/settings", tier: "staff", marker: "<h1>Settings" },
  { path: "/g/:guildId/leaderboard", tier: "staff", marker: "<h1>XP leaderboard" },
  { path: "/g/:guildId/leaderboard/user/:userId", tier: "staff", marker: "<h1>User XP" },
  { path: "/g/:guildId/staff", tier: "staff", marker: "<h1>Staff roles" },
  { path: "/g/:guildId/commands", tier: "staff", marker: "<h1>Command visibility" },
  { path: "/g/:guildId/integrations", tier: "staff", marker: "<h1>Integrations" },
  { path: "/g/:guildId/voice", tier: "staff", marker: "<h1>Voice" },
  { path: "/g/:guildId/system", tier: "admin", marker: "<h1>System" },
  { path: "/g/:guildId/audit", tier: "admin", marker: "<h1>Audit log" },
  { path: "/g/:guildId/xp/grant", tier: "admin", marker: "<h1>Grant XP" },
  { path: "/g/:guildId/tickets", tier: "senior", marker: "<h1>Ticket actions" },
];

const RANK = { staff: 0, senior: 1, admin: 2 };
// keys match sessionIdOf/csrfOf/cookieOf (mkSession used "staff" for the
// junior-tier role holder — USER_STAFF carries ROLE_JUNIOR_TIER).
const VIEWERS = [
  ["staff", USER_STAFF],
  ["senior", USER_SENIOR],
  ["admin", USER_ADMIN],
];

describe("C. tier conformance sweep — final GET surface + mutation ladder evidence (§8.6/§8.8)", () => {
  it("the live router GET enumeration under /g/ EQUALS the PAGES map (drift is loud)", () => {
    const live = harness.listGetRoutesUnder(appMain, "/g/").map((r) => r.path).sort();
    assert.deepEqual(live, PAGES.map((p) => p.path).sort(), "PAGES == live /g/ GET surface (final program state)");
  });

  it("every page answers every viewer class exactly per its tier: anon 302 · stranger/plain/cross 404 · 200 vs fixed 403", async () => {
    for (const page of PAGES) {
      const url = page.path.replace(":guildId", GUILD_A).replace(":userId", USER_WARN_SUBJECT);
      await harness.runOutcome({
        base: baseMain,
        url,
        cookieId: null,
        expect: harness.expectLoginRedirect(`/auth/login?guild=${GUILD_A}`),
        label: `anon ${page.path}`,
      });
      await harness.runOutcome({
        base: baseMain,
        url,
        cookieId: sessionIdOf.stranger,
        expect: harness.expectGenericNotFound(),
        label: `stranger ${page.path}`,
      });
      await harness.runOutcome({
        base: baseMain,
        url,
        cookieId: sessionIdOf.plain,
        expect: harness.expectGenericNotFound(),
        label: `plain ${page.path}`,
      });
      const crossUrl = page.path.replace(":guildId", GUILD_CROSS).replace(":userId", USER_WARN_SUBJECT);
      await harness.runOutcome({
        base: baseMain,
        url: crossUrl,
        cookieId: sessionIdOf.admin,
        expect: harness.expectGenericNotFound(),
        label: `cross ${page.path}`,
      });
      for (const [key, uid] of VIEWERS) {
        const allowed = RANK[key === "junior" ? "staff" : key] >= RANK[page.tier];
        await harness.runOutcome({
          base: baseMain,
          url,
          cookieId: sessionIdOf[key],
          expect: allowed
            ? harness.expectShellOk(page.marker)
            : harness.expectForbidden(),
          label: `${key} ${page.path}`,
        });
        assert.ok(uid, "viewer id sanity");
      }
    }
  });

  it("mutation ladder evidence reconciles with the §4 derivation: admin rows 403'd junior AND senior; senior rows 403'd junior; staff rows passed junior", () => {
    for (const row of PARITY) {
      const ev = observed[row.template] || {};
      const tier = ladder.expectedTierFor(row.template);
      assert.equal(ev.anon, 302, `${row.template}: anon ladder`);
      assert.equal(ev.stranger, 404, `${row.template}: stranger ladder`);
      assert.equal(ev.plain, 404, `${row.template}: plain ladder`);
      assert.equal(ev.cross, 404, `${row.template}: cross ladder`);
      if (tier === "admin") {
        assert.equal(ev.junior, 403, `${row.template}: junior must be 403 (admin tier)`);
        assert.equal(ev.senior, 403, `${row.template}: senior must be 403 (admin tier)`);
      } else if (tier === "senior") {
        assert.equal(ev.junior, 403, `${row.template}: junior must be 403 (senior tier)`);
        assert.equal(ev.senior, 302, `${row.template}: senior passed via the positive path`);
      } else {
        assert.equal(ev.junior, 302, `${row.template}: junior (tier=staff) passed the staff gate`);
      }
    }
    // the derived sets equal the runtime sets (the §4 vocabulary is exact)
    const derived = (t) => PARITY.filter((r) => ladder.expectedTierFor(r.template) === t).length;
    assert.equal(derived("admin"), 9, "9 admin mutations (role×3, channels×2, exempt×2, grant, sync)");
    assert.equal(derived("senior"), 3, "3 senior mutations (claim/close/summarize — §8.6 Tickets row)");
    assert.equal(derived("staff"), 28, "28 staff mutations");
  });
});

// ===========================================================================
// D. REGISTRY / METHOD-GATE INTEGRITY + 405 byte-parity (final state).
// ===========================================================================

describe("D. registry integrity — mounted routes, legacy ban, byte-parity 405 (§8.8 Phase-0a contract)", () => {
  it("methodGate registry templates == EXACTLY the mounted POST route templates (all three apps)", () => {
    const mountedPosts = (app) => {
      const router = app.router || app._router;
      const out = [];
      for (const layer of router.stack) {
        const route = layer && layer.route;
        if (!route || !route.methods || route.methods.post !== true) continue;
        const paths = Array.isArray(route.path) ? route.path : [route.path];
        for (const p of paths) out.push(p);
      }
      return out.filter((p) => p !== "/auth/logout").sort(); // the ONE exception
    };
    for (const app of [appMain, appReal, appNoAi]) {
      assert.deepEqual(
        mountedPosts(app),
        app.locals.webMutations.map((m) => m.path).sort(),
        "mounted POST templates == registry templates"
      );
      for (const m of app.locals.webMutations) {
        assert.equal(m.method, "POST", `registry entry ${m.path} is POST-only`);
        assert.match(m.path, /^\/g\/:guildId\//, `registry entry ${m.path} is /g/:guildId-scoped`);
      }
    }
  });

  it("UNIT: registerWebMutation throws for every non /g/:guildId surface + refuses GET/HEAD", () => {
    const fakeApp = { locals: { webMutations: [] } };
    for (const bad of [
      "/t/mutate",
      "/auth/login",
      "/auth/logout",
      "/g/mutate",
      "/static/x",
      "/oauth/command-permissions/callback",
    ]) {
      assert.throws(() => registerWebMutation(fakeApp, "POST", bad), /must be \/g\/:guildId-scoped/, bad);
    }
    assert.throws(() => registerWebMutation(fakeApp, "GET", "/g/:guildId/ok"), /mutations must not use GET/);
    assert.throws(() => registerWebMutation(fakeApp, "HEAD", "/g/:guildId/ok"), /mutations must not use HEAD/);
    registerWebMutation(fakeApp, "post", "/g/:guildId/x/ok");
    assert.deepEqual(fakeApp.locals.webMutations, [{ method: "POST", path: "/g/:guildId/x/ok" }]);
  });

  it("junk subpaths, non-POST verbs on registered templates, legacy surfaces, and the INTENTIONALLY unregistered /staff/sync-permissions pin ⇒ byte-identical 405", async () => {
    for (const p of [
      "/settings/nonexistent",
      "/staff/role/unknown",
      "/staff/role/add/extra",
      "/integrations/youtube/unknown",
      "/totally/unknown",
      // subtask-31 pin: the LEGACY slash-name path stays inert (the web
      // trigger lives at /commands/sync; this pin fails the moment anyone
      // re-registers the legacy surface):
      "/staff/sync-permissions",
    ]) {
      await harness.runOutcome({
        base: baseMain,
        url: `/g/${GUILD_A}${p}`,
        method: "POST",
        cookieId: sessionIdOf.admin,
        expect: harness.expectMethodNotAllowed(),
        label: `POST ${p}`,
      });
    }
    for (const row of PARITY) {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        await harness.runOutcome({
          base: baseMain,
          url: ladder.concretePath(row.template, GUILD_A),
          method,
          cookieId: sessionIdOf.admin,
          expect: harness.expectMethodNotAllowed(),
          label: `${method} ${row.template}`,
        });
      }
    }
    for (const url of [
      "/auth/login",
      "/t",
      "/t/00000000-0000-4000-8000-000000000000",
      "/static/app.js",
      "/oauth/command-permissions/callback",
    ]) {
      await harness.runOutcome({
        base: baseMain,
        url,
        method: "POST",
        cookieId: sessionIdOf.admin,
        expect: harness.expectMethodNotAllowed(),
        label: `POST ${url}`,
      });
    }
    // /auth/logout is the documented methodGate exception — POST must NOT be 405:
    const out = await harness.request(baseMain, "/auth/logout", {
      method: "POST",
      cookieId: sessionIdOf.staff,
    });
    assert.notEqual(out.status, 405, "POST /auth/logout rides the methodGate exception (never 405)");
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

// ===========================================================================
// E. BOOT WIRING (§8.6 cache-only seam): server option threading + the
// live-client name resolution through the Phase-3 consumer seams.
// ===========================================================================

describe("E. boot wiring + getClient threading — server options, feature boot, live-client name resolution (§8.6)", () => {
  it("startWebServer threads options into createWebApp VERBATIM (unit, stubbed app module)", async () => {
    const appPath = require.resolve("../src/web/app");
    const serverPath = require.resolve("../src/web/server");
    const realAppModule = require.cache[appPath];
    const realServerModule = require.cache[serverPath];
    const captured = [];
    const stubApp = { createWebApp: (opts) => { captured.push(opts); return () => {}; } };
    require.cache[appPath] = {
      id: appPath, filename: appPath, loaded: true, exports: stubApp,
    };
    delete require.cache[serverPath];
    const PORT = String(40000 + (process.pid % 20000));
    process.env.PUBLIC_HTTP_PORT = PORT;
    let server;
    try {
      const serverMod = require(serverPath);
      const opts = { __gate3OptionsProbe: true, getClient: () => FAKE_CLIENT };
      server = serverMod.startWebServer(opts);
      assert.equal(captured.length, 1, "createWebApp called exactly once with the boot options");
      assert.equal(captured[0], opts, "options pass-through is IDENTITY — nothing dropped or rebuilt");
      await serverMod.stopWebServer();
      server = null;
    } finally {
      delete process.env.PUBLIC_HTTP_PORT;
      if (realAppModule) require.cache[appPath] = realAppModule;
      if (realServerModule) require.cache[serverPath] = realServerModule;
      else delete require.cache[serverPath];
    }
    assert.ok(true);
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
    const bootClient = { __gate3BootClient: true, guilds: { cache: { keyArray: () => [GUILD_A] } } };
    try {
      delete require.cache[featurePath];
      const webFeature = require(featurePath);
      webFeature.start(bootClient);
    } finally {
      if (prevServer) require.cache[serverPath] = prevServer;
      else delete require.cache[serverPath];
      delete require.cache[featurePath];
      botGuildsMod.setBotGuildsProvider(null);
      bindAuditClient(FAKE_CLIENT); // the delegating mirror spy owns the bind again
    }
    assert.equal(captured.length, 1, "startWebServer called exactly once by features/web start()");
    assert.equal(typeof captured[0].getClient, "function", "startWebServer({ getClient }) threading");
    assert.equal(captured[0].getClient(), bootClient, "the bound provider returns the boot client");
  });

  it("users area seam: an unknown id renders only once the FAKE member cache knows them (resolveDiscordContext threading)", async () => {
    const url = `/g/${GUILD_A}/users/${USER_UNKNOWN}`;
    const before = await harness.request(baseMain, url, { cookieId: sessionIdOf.staff });
    assert.equal(before.status, 404, "no client member + no data ⇒ 404");
    FAKE_CLIENT.__maps.members.set(USER_UNKNOWN, { joinedTimestamp: Date.now() });
    try {
      const after = await harness.request(baseMain, url, { cookieId: sessionIdOf.staff });
      assert.equal(after.status, 200, "member-cache hit ⇒ the profile renders (client threaded into routes/users)");
      assert.ok(after.body.includes("<h1>User profile"), "the profile heading rendered");
    } finally {
      FAKE_CLIENT.__maps.members.delete(USER_UNKNOWN);
    }
  });

  it("staff area seam: the role-name resolver switches the /staff page from raw-id fallback to the cached role NAME", async () => {
    api.addStaffRole(GUILD_A, ROLE_NAME_PROBE, "junior");
    try {
      const fallback = await harness.request(baseMain, `/g/${GUILD_A}/staff`, { cookieId: sessionIdOf.staff });
      assert.equal(fallback.status, 200);
      assert.ok(fallback.body.includes(ROLE_NAME_PROBE), "uncached role id still renders (slash-identical fallback)");
      assert.ok(!fallback.body.includes(GATE_ROLE_NAME), "the name CANNOT appear before the cache knows it");
      FAKE_ROLES[ROLE_NAME_PROBE] = { id: ROLE_NAME_PROBE, name: GATE_ROLE_NAME, position: 10, managed: false };
      const named = await harness.request(baseMain, `/g/${GUILD_A}/staff`, { cookieId: sessionIdOf.staff });
      assert.ok(
        named.body.includes(GATE_ROLE_NAME),
        "the FAKE client's cached role name surfaced ⇒ options.getClient threaded into routes/staff"
      );
    } finally {
      api.removeStaffRole(GUILD_A, ROLE_NAME_PROBE);
      delete FAKE_ROLES[ROLE_NAME_PROBE];
    }
  });

  it("moderation seam: the warn DM title resolves the GUILD NAME through the live-client seam (name-resolution proof + ledgered audit)", async () => {
    purgeAutoincrement("warnings");
    api.updateGuildSettings(GUILD_A, { warn_expiry_days: 0 });
    DM_USERS[USER_W_E_probe].sent.length = 0;
    const { res, location } = await post(`/g/${GUILD_A}/moderation/warnings/issue`, {
      cookie: cookieOf.staff,
      fields: { user_id: USER_W_E_probe, reason: "gate E moderation probe", _csrf: csrfOf.staff },
    });
    assert.equal(res.status, 302);
    assert.equal(location, `/g/${GUILD_A}/warnings?done=warn_issued`);
    bump("web", "warnings.add");
    await tick();
    assert.equal(DM_USERS[USER_W_E_probe].sent.length, 1, "the member DM went out through the client seam");
    const embed = embedsOf(DM_USERS[USER_W_E_probe].sent[0])[0];
    assert.equal(embed.title, `Warning issued in ${GATE_GUILD_NAME}`, "guild name resolved via getClient (not a fetch)");
  });

  it("tickets seam: claim posts its notice to the ticket channel resolved through the live-client cache", async () => {
    purgeAutoincrement("tickets");
    const t = api.createTicket({
      guildId: GUILD_A,
      creatorUserId: USER_T_CREATOR,
      channelId: CH_TICKET,
      reason: "gate E claim probe",
    });
    FAKE_CHANNELS[CH_TICKET].sent.length = 0;
    const { res, location } = await post(`/g/${GUILD_A}/tickets/claim`, {
      cookie: cookieOf.senior,
      fields: { ticket_id: String(t.id), _csrf: csrfOf.senior },
    });
    assert.equal(res.status, 302);
    assert.equal(location, `/g/${GUILD_A}/tickets?done=ticket_claimed`);
    bump("web", "tickets.claim");
    await tick();
    assert.ok(
      FAKE_CHANNELS[CH_TICKET].sent.includes(`<@${USER_SENIOR}> claimed this ticket.`),
      "the channel notice ran through the client-seam channel (getClient threaded into routes/tickets)"
    );
    FAKE_CHANNELS[CH_TICKET].sent.length = 0;
  });
});

// ===========================================================================
// F. TWO-TRANSPORT PARITY — the five Phase-3 areas run SIDE BY SIDE.
// ===========================================================================

describe("F. slash↔web two-transport parity — same inputs, same DB end-state, same audit, same Discord behavior (§8.11/§8.8)", () => {
  // -------------------------------------------------------------------------
  // X1 — xp grant
  // -------------------------------------------------------------------------
  describe("F-X1 /grantxp ⇆ POST xp/grant", () => {
    let xSlash; // captured run
    it("slash run: grant 250 through the REAL awardXp service", async () => {
      api.setXp(GUILD_A, USER_P_SUB, 0);
      resetChannelCapture();
      const before = auditCount("slash");
      const interaction = slashInteraction({
        userId: USER_ADMIN,
        sub: "grantxp",
        manageGuild: true,
        users: { user: { id: USER_P_SUB, bot: false } },
        ints: { amount: 250 },
        strings: { reason: "gate parity" },
      });
      await xpFeature.handlers.grantxp(interaction, { client: FAKE_CLIENT });
      assert.equal(auditCount("slash"), before + 1, "exactly one slash-origin row");
      bump("slash", "xp.grant");
      xSlash = {
        audit: lastAudit("slash", { action: "xp.grant", targetId: USER_P_SUB }),
        xp: api.getXp(GUILD_A, USER_P_SUB),
        sends: capture().channelSends,
      };
      assert.equal(xSlash.xp, 250);
      assert.equal(xSlash.audit.origin, "slash");
      assert.deepEqual(xSlash.audit.details, { amount: 250, before_xp: 0, after_xp: 250, reason: "gate parity" });
      assert.ok(xSlash.sends[CH_AUDIT], "the slash posted the logConfigChange embed to the audit channel");
    });

    it("web twin run: identical DB end-state, identical audit (origin aside), identical channel embed (timestamp aside)", async () => {
      api.setXp(GUILD_A, USER_P_SUB, 0); // same baseline as the slash run
      resetChannelCapture();
      const before = auditCount("web");
      const { res, location } = await post(`/g/${GUILD_A}/xp/grant`, {
        cookie: cookieOf.admin,
        fields: { user_id: USER_P_SUB, amount: "250", reason: "gate parity", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `/g/${GUILD_A}/xp/grant?done=xp_granted`);
      assert.equal(auditCount("web"), before + 1);
      bump("web", "xp.grant");
      const webAudit = lastAudit("web", { action: "xp.grant", targetId: USER_P_SUB });
      const cap = capture();

      // DB end-state parity:
      assert.equal(api.getXp(GUILD_A, USER_P_SUB), xSlash.xp, "xp total identical");
      // Audit parity — EVERY semantic column, origin asserted separately:
      assert.equal(webAudit.origin, "web");
      assert.deepEqual(auditCmp(webAudit), auditCmp(xSlash.audit), "audit rows equal except the (asserted) origin");
      // Discord behavior parity — same channel, same embed, byte-equal after
      // the timestamp normalization (the mirror's plain-number lines are
      // equal to the slash's toLocaleString output for gate-sized numbers):
      const slashEmbeds = deepNormalize(xSlash.sends[CH_AUDIT]);
      const webEmbeds = deepNormalize(cap.channelSends[CH_AUDIT]);
      assert.equal(webEmbeds.length, slashEmbeds.length, "same number of channel messages");
      assert.deepEqual(
        webEmbeds.map((p) => deepNormalize(embedsOf({ embeds: p }).map((e) => ({ ...e, timestamp: "<T>" }))))
          .flat(),
        slashEmbeds.map((p) => deepNormalize(embedsOf({ embeds: p }).map((e) => ({ ...e, timestamp: "<T>" }))))
          .flat(),
        "the audit-channel embeds are the same message (title/command/Changed-by/Changes lines) modulo wall-clock"
      );
      // zero DMs on both transports:
      assert.deepEqual(capture().dms, {}, "the grant DMs nobody (slash parity)");
      PARITY.find((r) => r.no === "X1").parity = "BOTH";
    });

    it("rejection-class parity: amount < 1 ⇒ slash reply refusal / web invalid_amount slug — zero writes, zero audits on BOTH", async () => {
      api.setXp(GUILD_A, USER_P_SUB, 0);
      const before = { s: auditCount("slash"), w: auditCount("web") };
      const interaction = slashInteraction({
        userId: USER_ADMIN,
        sub: "grantxp",
        manageGuild: true,
        users: { user: { id: USER_P_SUB, bot: false } },
        ints: { amount: 0 },
      });
      await xpFeature.handlers.grantxp(interaction, { client: FAKE_CLIENT });
      const refusal = interaction.replies.map((r) => JSON.stringify(r)).join(" ");
      assert.match(refusal, /at least 1/, "slash refusal reply");
      const { res, location } = await post(`/g/${GUILD_A}/xp/grant`, {
        cookie: cookieOf.admin,
        fields: { user_id: USER_P_SUB, amount: "0", _csrf: csrfOf.admin },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `/g/${GUILD_A}/xp/grant?error=invalid_amount`);
      assert.equal(auditCount("slash"), before.s, "rejections audit NOTHING on the slash transport");
      assert.equal(auditCount("web"), before.w, "rejections audit NOTHING on the web transport");
      assert.equal(api.getXp(GUILD_A, USER_P_SUB), 0, "zero XP writes");
    });
  });

  // -------------------------------------------------------------------------
  // W1/W2/W3 — warnings + notes
  // -------------------------------------------------------------------------
  describe("F-W /warn add+void ⇆ moderation, /note add ⇆ notes (single parity subject)", () => {
    let wIssueSlash, wVoidSlash, wNoteSlash;

    it("slash /warn add on the parity subject: row + audit + warn-log embed + member DM captured", async () => {
      purgeAutoincrement("warnings");
      api.updateGuildSettings(GUILD_A, { warn_expiry_days: 0, warn_dm_members: 1 });
      resetChannelCapture();
      const before = auditCount("slash");
      const target = {
        id: USER_W_SUB,
        bot: false,
        sent: [],
        async send(p) {
          this.sent.push(p);
          return { id: "dm-w" };
        },
      };
      const interaction = slashInteraction({
        userId: USER_STAFF,
        sub: "add",
        memberRoleIds: [ROLE_JUNIOR_TIER],
        users: { user: target },
        strings: { reason: "gate parity reason" },
      });
      await warningsFeature.handlers.warn(interaction, { client: FAKE_CLIENT });
      assert.equal(auditCount("slash"), before + 1);
      bump("slash", "warnings.add");
      wIssueSlash = {
        audit: lastAudit("slash", { action: "warnings.add", targetId: USER_W_SUB }),
        warn: api.listWarnings ? null : null,
        channelSends: capture().channelSends,
        dm: target.sent,
      };
      assert.equal(wIssueSlash.audit.origin, "slash");
      assert.equal(wIssueSlash.audit.details.reason, "gate parity reason");
      assert.equal(wIssueSlash.dm.length, 1, "slash issued the member DM");
    });

    it("web warn issue on the SAME subject + payload: identical audit (origin aside), identical DM + warn-log embed (refs/ts normalized)", async () => {
      purgeAutoincrement("warnings"); // same AUTOINCREMENT baseline
      resetChannelCapture();
      DM_USERS[USER_W_SUB].sent.length = 0;
      const before = auditCount("web");
      const { res, location } = await post(`/g/${GUILD_A}/moderation/warnings/issue`, {
        cookie: cookieOf.staff,
        fields: { user_id: USER_W_SUB, reason: "gate parity reason", _csrf: csrfOf.staff },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `/g/${GUILD_A}/warnings?done=warn_issued`);
      assert.equal(auditCount("web"), before + 1);
      bump("web", "warnings.add");
      const webAudit = lastAudit("web", { action: "warnings.add", targetId: USER_W_SUB });
      await tick();
      const cap = capture();

      assert.equal(webAudit.origin, "web");
      // both runs created warning id/number 1 under the SAME subject ⇒
      // EVERY semantic column is deep-equal with no id map at all:
      assert.deepEqual(auditCmp(webAudit), auditCmp(wIssueSlash.audit));

      // member DM — byte-equal after <T>/ref normalization:
      assert.equal(DM_USERS[USER_W_SUB].sent.length, 1, "web issued the member DM (cache-only seam hit)");
      assert.deepEqual(
        deepNormalize(embedsOf(DM_USERS[USER_W_SUB].sent[0])),
        deepNormalize(embedsOf(wIssueSlash.dm[0])),
        "the member DM embed is the same message on both transports (Issued-by 'staff', guild name, fields)"
      );
      // warn-log channel mirror embed:
      assert.deepEqual(
        deepNormalize(cap.channelSends[CH_WARN] || []),
        deepNormalize(wIssueSlash.channelSends[CH_WARN] || []),
        "the warn-log embed (logWarnEvent ⇆ kind-warn mirror) is the same message modulo ts/ref"
      );
      PARITY.find((r) => r.no === "W1").parity = "BOTH";
    });

    it("/warn void ⇆ warnings/void: slash voids its own seeded W-1, web voids the re-seeded W-1 — equal end-state + audit + DM", async () => {
      // slash run
      purgeAutoincrement("warnings");
      const seed1 = api.createWarning({
        guildId: GUILD_A,
        userId: USER_W_SUB,
        issuerId: USER_ADMIN,
        reason: "seed to void (slash)",
        expiresDays: 0,
      });
      resetChannelCapture();
      DM_USERS[USER_W_SUB].sent.length = 0;
      let before = auditCount("slash");
      await warningsFeature.handlers.warn(
        slashInteraction({
          userId: USER_STAFF,
          sub: "void",
          memberRoleIds: [ROLE_JUNIOR_TIER],
          ints: { id: seed1.warning_number },
          strings: { reason: "gate parity void" },
        }),
        { client: FAKE_CLIENT }
      );
      assert.equal(auditCount("slash"), before + 1);
      bump("slash", "warnings.void");
      wVoidSlash = {
        audit: lastAudit("slash", { action: "warnings.void", targetId: String(seed1.id) }),
        row: api.getWarning ? api.getWarning(GUILD_A, seed1.warning_number) : null,
        dm: [...DM_USERS[USER_W_SUB].sent],
        channelSends: capture().channelSends,
      };
      // web run — identical seeded baseline
      purgeAutoincrement("warnings");
      const seed2 = api.createWarning({
        guildId: GUILD_A,
        userId: USER_W_SUB,
        issuerId: USER_ADMIN,
        reason: "seed to void (slash)",
        expiresDays: 0,
      });
      resetChannelCapture();
      DM_USERS[USER_W_SUB].sent.length = 0;
      before = auditCount("web");
      const { res, location } = await post(`/g/${GUILD_A}/moderation/warnings/void`, {
        cookie: cookieOf.staff,
        fields: { warning_number: String(seed2.warning_number), reason: "gate parity void", _csrf: csrfOf.staff },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `/g/${GUILD_A}/warnings?done=warn_voided`);
      assert.equal(auditCount("web"), before + 1);
      bump("web", "warnings.void");
      await tick();
      const webAudit = lastAudit("web", { action: "warnings.void", targetId: String(seed2.id) });
      const cap = capture();

      // AUTOINCREMENT baselines are identical ⇒ id/number/target all 1 on
      // both transports — full semantic equality with no maps:
      assert.equal(String(seed1.id), String(seed2.id));
      assert.equal(webAudit.origin, "web");
      assert.deepEqual(auditCmp(webAudit), auditCmp(wVoidSlash.audit), "void audit rows equal (origin aside)");
      assert.deepEqual(
        deepNormalize(cap.channelSends[CH_WARN] || []),
        deepNormalize(wVoidSlash.channelSends[CH_WARN] || []),
        "void warn-log embed equal (kind warn parity)"
      );
      // Both sides normalized the SAME way: capture().dms is already
      // send-record-mapped through embedsOf (array of embed arrays);
      // the raw slash sends need the identical per-record unwrap first.
      assert.deepEqual(
        deepNormalize((cap.dms[USER_W_SUB] || []).flat()),
        deepNormalize(wVoidSlash.dm.map((p) => embedsOf(p)).flat()),
        "void DM parity: same embed to the subject"
      );
      PARITY.find((r) => r.no === "W2").parity = "BOTH";
    });

    it("/note add ⇆ moderation/notes: equal note row, equal audit, equal audit-channel embed", async () => {
      purgeAutoincrement("staff_notes");
      resetChannelCapture();
      let before = auditCount("slash");
      await staffNotesFeature.handlers.note(
        slashInteraction({
          userId: USER_STAFF,
          sub: "add",
          memberRoleIds: [ROLE_JUNIOR_TIER],
          users: { user: { id: USER_W_SUB, bot: false } },
          strings: { content: "gate parity note" },
        }),
        { client: FAKE_CLIENT }
      );
      assert.equal(auditCount("slash"), before + 1);
      bump("slash", "notes.add");
      wNoteSlash = {
        audit: lastAudit("slash", { action: "notes.add", targetId: "1" }),
        channelSends: capture().channelSends,
      };
      purgeAutoincrement("staff_notes");
      resetChannelCapture();
      before = auditCount("web");
      const { res, location } = await post(`/g/${GUILD_A}/moderation/notes`, {
        cookie: cookieOf.staff,
        fields: { user_id: USER_W_SUB, content: "gate parity note", _csrf: csrfOf.staff },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `/g/${GUILD_A}/notes?done=note_added`);
      assert.equal(auditCount("web"), before + 1);
      bump("web", "notes.add");
      await tick();
      const webAudit = lastAudit("web", { action: "notes.add", targetId: "1" });
      const cap = capture();
      assert.equal(webAudit.origin, "web");
      assert.deepEqual(auditCmp(webAudit), auditCmp(wNoteSlash.audit), "note audit rows equal (origin aside)");
      assert.deepEqual(
        deepNormalize(cap.channelSends[CH_AUDIT] || []),
        deepNormalize(wNoteSlash.channelSends[CH_AUDIT] || []),
        "the note audit-channel embed matches the slash logConfigChange byte-for-byte (after ts normalization)"
      );
      PARITY.find((r) => r.no === "W3").parity = "BOTH";
    });

    it("refusal-class row: over-long note content ⇒ web slug refusal with ZERO writes/audits (the slash's maxLength guard is Discord-side — documented)", async () => {
      purgeAutoincrement("staff_notes");
      const before = { w: auditCount("web"), n: rawDb.prepare("SELECT COUNT(*) c FROM staff_notes").get().c };
      const { res, location } = await post(`/g/${GUILD_A}/moderation/notes`, {
        cookie: cookieOf.staff,
        fields: { user_id: USER_W_SUB, content: "x".repeat(2001), _csrf: csrfOf.staff },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `/g/${GUILD_A}/notes?error=content_too_long`);
      assert.equal(auditCount("web"), before.w);
      assert.equal(rawDb.prepare("SELECT COUNT(*) c FROM staff_notes").get().c, before.n);
    });
  });

  // -------------------------------------------------------------------------
  // T1/T2/T3 — tickets (claim / close / summarize) + the ticket deltas
  // -------------------------------------------------------------------------
  describe("F-T /ticket claim+close+summarize ⇆ ticket actions (senior parity + documented deltas)", () => {
    let tClaimSlash, tCloseSlash, tSumSlash;

    function seedLiveTicket(reason) {
      purgeAutoincrement("tickets");
      rawDeleteMessages();
      return api.createTicket({
        guildId: GUILD_A,
        creatorUserId: USER_T_CREATOR,
        channelId: CH_TICKET, // live cached channel: BOTH transports run
        reason,
      });
    }

    function rawDeleteMessages() {
      try {
        rawDb.prepare("DELETE FROM ticket_messages").run();
      } catch {
        /* table may not exist yet — it does (migrations) */
      }
    }

    it("slash /ticket claim (senior staff) on the live-channel ticket: row + audit + channel notice + overwrites captured", async () => {
      const t = seedLiveTicket("gate parity claim");
      resetChannelCapture();
      const before = auditCount("slash");
      await ticketsFeature.handlers.ticket(
        slashInteraction({
          userId: USER_SENIOR,
          sub: "claim",
          channel: FAKE_CHANNELS[CH_TICKET],
          memberRoleIds: [ROLE_SENIOR_TIER],
        }),
        { client: FAKE_CLIENT }
      );
      assert.equal(auditCount("slash"), before + 1);
      bump("slash", "tickets.claim");
      tClaimSlash = { audit: lastAudit("slash", { action: "tickets.claim", targetId: String(t.id) }), cap: capture() };
      assert.equal(tClaimSlash.audit.origin, "slash");
      assert.equal(tClaimSlash.audit.details.staff_owner_id, USER_SENIOR);
    });

    it("web claim on the re-seeded identical ticket: equal notice string, equal overwrite sequence, equal audit (origin aside)", async () => {
      const t = seedLiveTicket("gate parity claim");
      resetChannelCapture();
      const before = auditCount("web");
      const { res, location } = await post(`/g/${GUILD_A}/tickets/claim`, {
        cookie: cookieOf.senior,
        fields: { ticket_id: String(t.id), _csrf: csrfOf.senior },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `/g/${GUILD_A}/tickets?done=ticket_claimed`);
      assert.equal(auditCount("web"), before + 1);
      bump("web", "tickets.claim");
      await tick();
      const cap = capture();
      const webAudit = lastAudit("web", { action: "tickets.claim", targetId: String(t.id) });
      assert.equal(webAudit.origin, "web");
      assert.deepEqual(auditCmp(webAudit), auditCmp(tClaimSlash.audit), "claim audit rows equal (origin aside)");
      // the channel notice is a PLAIN STRING on both transports ⇒ true
      // byte equality, no normalization:
      assert.deepEqual(
        cap.channelSends[CH_TICKET],
        tClaimSlash.cap.channelSends[CH_TICKET],
        "the claim notice messages are byte-identical (same actor id, same string)"
      );
      assert.deepEqual(
        cap.overwriteCalls[CH_TICKET],
        tClaimSlash.cap.overwriteCalls[CH_TICKET],
        "the permission-overwrite CALL SEQUENCE is identical (same ids, same bitfields, same order)"
      );
      PARITY.find((r) => r.no === "T1").parity = "BOTH";
    });

    it("TIER DELTA D1 proven both directions: junior SUCCEEDS on slash claim (requireStaff) while the WEB claim is the fixed 403 (§8.6 senior tightening)", async () => {
      const t = seedLiveTicket("gate parity junior claim");
      resetChannelCapture();
      const before = { s: auditCount("slash"), w: auditCount("web") };
      await ticketsFeature.handlers.ticket(
        slashInteraction({
          userId: USER_STAFF,
          sub: "claim",
          channel: FAKE_CHANNELS[CH_TICKET],
          memberRoleIds: [ROLE_JUNIOR_TIER],
        }),
        { client: FAKE_CLIENT }
      );
      assert.equal(auditCount("slash"), before.s + 1, "slash: junior staff CLAIMS (vocabulary tickets.claim)");
      bump("slash", "tickets.claim");
      const web = await post(`/g/${GUILD_A}/tickets/claim`, {
        cookie: cookieOf.staff,
        fields: { ticket_id: String(t.id), _csrf: csrfOf.staff },
      });
      assert.equal(web.res.status, 403, "web: the SAME actor is 403'd (the documented STRICTENING, never loosening)");
      assert.equal(auditCount("web"), before.w, "the 403 wrote nothing to the web ledger");
    });

    it("slash /ticket close ⇆ web close on identical live-channel tickets: equal channel embed + requester DM + overwrites + audit", async () => {
      const t1 = seedLiveTicket("gate parity close");
      resetChannelCapture();
      DM_USERS[USER_T_CREATOR].sent.length = 0;
      let before = auditCount("slash");
      await ticketsFeature.handlers.ticket(
        slashInteraction({
          userId: USER_SENIOR,
          sub: "close",
          channel: FAKE_CHANNELS[CH_TICKET],
          memberRoleIds: [ROLE_SENIOR_TIER],
          strings: { reason: "gate parity close", staff_note: null },
        }),
        { client: FAKE_CLIENT }
      );
      assert.equal(auditCount("slash"), before + 1);
      bump("slash", "tickets.close");
      tCloseSlash = {
        audit: lastAudit("slash", { action: "tickets.close", targetId: String(t1.id) }),
        cap: capture(),
        row: api.getTicketById(t1.id),
      };
      const t2 = seedLiveTicket("gate parity close");
      resetChannelCapture();
      DM_USERS[USER_T_CREATOR].sent.length = 0;
      before = auditCount("web");
      const { res, location } = await post(`/g/${GUILD_A}/tickets/close`, {
        cookie: cookieOf.senior,
        fields: { ticket_id: String(t2.id), reason: "gate parity close", _csrf: csrfOf.senior },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `/g/${GUILD_A}/tickets?done=ticket_closed`);
      assert.equal(auditCount("web"), before + 1);
      bump("web", "tickets.close");
      await tick();
      const cap = capture();
      const webAudit = lastAudit("web", { action: "tickets.close", targetId: String(t2.id) });

      // DB end-state (status/reason — timestamps excluded as wall clock):
      assert.equal(cap && api.getTicketById(t2.id).status, tCloseSlash.row.status);
      assert.equal(api.getTicketById(t2.id).close_reason, tCloseSlash.row.close_reason);
      assert.equal(api.getTicketById(t2.id).closed_by_user_id, tCloseSlash.row.closed_by_user_id);
      assert.equal(webAudit.origin, "web");
      assert.deepEqual(auditCmp(webAudit), auditCmp(tCloseSlash.audit), "close audit rows equal (origin aside)");
      // the channel close embed carries NO timestamp ⇒ deep-equal with only
      // the ref-normalization pass (both tickets are #1 after the purge):
      assert.deepEqual(
        deepNormalize(cap.channelSends[CH_TICKET] || []),
        deepNormalize(tCloseSlash.cap.channelSends[CH_TICKET] || []),
        "the close notice embed is the same message on both transports"
      );
      assert.deepEqual(
        deepNormalize(cap.dms[USER_T_CREATOR] || []),
        deepNormalize(tCloseSlash.cap.dms[USER_T_CREATOR] || []),
        "the requester close-DM is the same message on both transports"
      );
      assert.deepEqual(
        cap.overwriteCalls[CH_TICKET],
        tCloseSlash.cap.overwriteCalls[CH_TICKET],
        "soft-close overwrites: identical call sequence (senior staff role, member deny, bot, everyone)"
      );
      PARITY.find((r) => r.no === "T2").parity = "BOTH";
    });

    it("summarize ⇆ REAL summarizeTicket: identical fallback summary + audit, zero writes, zero Discord (same real service under both)", async () => {
      // slash run (REAL service, offline env ⇒ stats fallback)
      const t1 = seedLiveTicket("gate parity summarize");
      api.saveTicketMessages(t1.id, [
        { message_id: "9501", author_id: USER_T_CREATOR, content: "hello", sent_at: 1 },
        { message_id: "9502", author_id: USER_SENIOR, content: "help", sent_at: 2 },
      ]);
      resetChannelCapture();
      let before = auditCount("slash");
      await ticketsFeature.handlers.ticket(
        slashInteraction({
          userId: USER_SENIOR,
          sub: "summarize",
          channel: FAKE_CHANNELS[CH_TICKET],
          memberRoleIds: [ROLE_SENIOR_TIER],
        }),
        { client: FAKE_CLIENT }
      );
      assert.equal(auditCount("slash"), before + 1);
      bump("slash", "tickets.summarize");
      tSumSlash = { audit: lastAudit("slash", { action: "tickets.summarize", targetId: String(t1.id) }), cap: capture() };
      assert.deepEqual(tSumSlash.audit.details, { ticket_number: 1, source: "fallback", message_count: 2 });

      // web run on appReal (guardrail seam true; the REAL service runs)
      const t2 = seedLiveTicket("gate parity summarize");
      api.saveTicketMessages(t2.id, [
        { message_id: "9501", author_id: USER_T_CREATOR, content: "hello", sent_at: 1 },
        { message_id: "9502", author_id: USER_SENIOR, content: "help", sent_at: 2 },
      ]);
      resetChannelCapture();
      before = auditCount("web");
      const rowBefore = { ...api.getTicketById(t2.id) };
      const { res, location } = await postRaw(baseReal, `/g/${GUILD_A}/tickets/summarize`, {
        cookie: cookieOf.senior,
        fields: { ticket_id: String(t2.id), _csrf: csrfOf.senior },
      });
      assert.equal(res.status, 302);
      assert.equal(location, `/g/${GUILD_A}/tickets?done=summary_fallback`);
      assert.equal(auditCount("web"), before + 1);
      bump("web", "tickets.summarize");
      const webAudit = lastAudit("web", { action: "tickets.summarize", targetId: String(t2.id) });
      assert.equal(webAudit.origin, "web");
      assert.deepEqual(auditCmp(webAudit), auditCmp(tSumSlash.audit), "summarize audit rows equal (origin aside) — same real service, same fallback");
      // zero Discord behavior on both transports (slash embed is the EPHEMERAL
      // reply — not a channel send; the web sends nothing):
      assert.deepEqual(tSumSlash.cap.channelSends, {}, "slash summarize posts NO channel embed");
      assert.deepEqual(capture().channelSends, {}, "web summarize posts NO channel embed");
      // no persistence surprise (neither transport writes the summary
      // back onto the ticket row — the DB row is byte-identical across
      // the web summarize):
      assert.deepEqual(
        { ...api.getTicketById(t2.id) },
        rowBefore,
        "web summarize wrote NOTHING back to the ticket row"
      );
      PARITY.find((r) => r.no === "T3").parity = "BOTH";
    });

    it("DELTA D2+D3 asserted: sensitive summarize — slash answers (ephemeral, audited), the WEB 404s; AI-off regen — the WEB refuses up front (zero Discord, zero audit)", async () => {
      // sensitive: slash works (in-channel ephemeral danger embed), web 404s
      const t1 = seedLiveTicket("gate parity sensitive");
      api.setTicketSensitive(t1.id, USER_SENIOR);
      api.saveTicketMessages(t1.id, [
        { message_id: "9601", author_id: USER_T_CREATOR, content: "private", sent_at: 1 },
      ]);
      resetChannelCapture();
      let before = { s: auditCount("slash"), w: auditCount("web") };
      const inter = slashInteraction({
        userId: USER_SENIOR,
        sub: "summarize",
        channel: FAKE_CHANNELS[CH_TICKET],
        memberRoleIds: [ROLE_SENIOR_TIER],
      });
      await ticketsFeature.handlers.ticket(inter, { client: FAKE_CLIENT });
      assert.equal(auditCount("slash"), before.s + 1, "the slash summarizes sensitive tickets (audited, ephemeral)");
      bump("slash", "tickets.summarize");
      assert.deepEqual(capture().channelSends, {}, "even the slash answer leaves nothing in a channel (ephemeral only)");

      const t2 = seedLiveTicket("gate parity sensitive");
      api.setTicketSensitive(t2.id, USER_SENIOR);
      api.saveTicketMessages(t2.id, [
        { message_id: "9601", author_id: USER_T_CREATOR, content: "private", sent_at: 1 },
      ]);
      const { res, body } = await post(`/g/${GUILD_A}/tickets/summarize`, {
        cookie: cookieOf.senior,
        fields: { ticket_id: String(t2.id), _csrf: csrfOf.senior },
      });
      assert.equal(res.status, 404, "web hardening delta (2): sensitive ⇒ indistinguishable from unknown");
      assert.equal(body, "Not found");
      assert.equal(auditCount("web"), before.w, "the 404 audited NOTHING (no enumeration signal)");

      // AI-off web refusal (delta (3)) on appNoAi:
      const t3 = seedLiveTicket("gate parity ai-off");
      api.saveTicketMessages(t3.id, [
        { message_id: "9701", author_id: USER_T_CREATOR, content: "hi", sent_at: 1 },
      ]);
      before = { s: auditCount("slash"), w: auditCount("web") };
      const off = await postRaw(baseNoAi, `/g/${GUILD_A}/tickets/summarize`, {
        cookie: cookieOf.senior,
        fields: { ticket_id: String(t3.id), _csrf: csrfOf.senior },
      });
      assert.equal(off.res.status, 302);
      assert.equal(off.location, `/g/${GUILD_A}/tickets?error=ai_not_configured`);
      assert.equal(auditCount("web"), before.w, "the refusal wrote zero audit rows (named-var refusal)");
    });
  });

  // -------------------------------------------------------------------------
  // C1 — command visibility sync (REAL shared core, captured transport)
  // -------------------------------------------------------------------------
  describe("F-C1 /staff syncpermissions ⇆ POST commands/sync — REAL sync core on the REAL stored token", () => {
    const savedSyncEnv = {};
    const realRestGet = REST.prototype.get;
    const discord = { log: [], guildCommands: [
      { name: "activityconfig", id: "930000000000000001" },
      { name: "gork", id: "930000000000000002" },
      { name: "note", id: "930000000000000003" },
    ], restGetThrows: false };

    function mockRes(status, bodyObj) {
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => bodyObj,
        text: async () => JSON.stringify(bodyObj),
      };
    }

    function installMocks() {
      REST.prototype.get = async function spiedRestGet(path) {
        if (discord.restGetThrows) {
          const err = new Error("synthetic transport outage (gate3)");
          err.name = "Gate3Outage";
          throw err;
        }
        discord.log.push({ kind: "rest-get", path: String(path) });
        return discord.guildCommands.map((c) => ({ id: c.id, name: c.name }));
      };
      globalThis.fetch = async function mockedFetch(url, opts = {}) {
        const u = String(url);
        const method = String(opts.method || "GET").toUpperCase();
        if (u.includes("/oauth2/token")) {
          discord.log.push({ kind: "token-post", auth: String(opts?.headers?.Authorization || "") });
          return mockRes(400, { error: "invalid_grant (gate3: refresh must never run)" });
        }
        const putMatch = u.match(/\/commands\/([^/]+)\/permissions$/);
        if (method === "PUT" && putMatch) {
          const entry = {
            kind: "put",
            commandId: putMatch[1],
            url: u,
            auth: String(opts?.headers?.Authorization || ""),
            body: String(opts?.body || ""),
            headers: JSON.stringify(opts?.headers || {}),
          };
          discord.log.push(entry);
          return mockRes(200, { id: putMatch[1] });
        }
        throw new Error(`UNEXPECTED OFF-TEST HTTP (gate3 sync suite): ${method} ${u}`);
      };
    }
    function restoreMocks() {
      globalThis.fetch = realFetch;
      REST.prototype.get = realRestGet;
    }

    before(() => {
      for (const k of ["DISCORD_TOKEN", "CLIENT_ID", "CLIENT_SECRET", "PUBLIC_HTTP_PORT", "PUBLIC_BASE_URL", "TICKET_HTTP_PORT", "TICKET_PUBLIC_BASE_URL", "OAUTH_REDIRECT_URI"]) {
        savedSyncEnv[k] = process.env[k];
      }
      // sync.js#fetchGuildCommandIdMap REQUIRES the bot token (the GET rides
      // it; every PUT rides the STORED OAuth token — decision 9 split).
      process.env.DISCORD_TOKEN = "gate3-bot-token-not-real";
      process.env.CLIENT_ID = FAKE_CLIENT_ID;
      process.env.CLIENT_SECRET = FAKE_CLIENT_SECRET;
      process.env.PUBLIC_HTTP_PORT = SYNC_PORT_STUB;
      process.env.PUBLIC_BASE_URL = SYNC_BASE_URL;
    });
    after(() => {
      restoreMocks();
      for (const k of Object.keys(savedSyncEnv)) {
        if (savedSyncEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedSyncEnv[k];
      }
      api.deleteCommandPermissionOauth(GUILD_A);
    });

    function oauthSeedFresh() {
      // KEY NAMES follow the real repository contract
      // (repositories/commandPermissionOauth.js: accessExpiresAt, unix ms —
      // oauthTokens#getValidAccessToken short-circuits refresh only while
      // access_expires_at > now + 60 s skew).
      api.upsertCommandPermissionOauth(GUILD_A, {
        accessToken: STORED_AT,
        refreshToken: STORED_RT,
        accessExpiresAt: Date.now() + 3_600_000,
        authorizedByUserId: USER_ADMIN,
      });
    }

    it("slash run: real core ⇒ one GET + 3 PUTs with the STORED token; audit via recordSlashAudit", async () => {
      oauthSeedFresh();
      rawDb.prepare("UPDATE guild_command_permission_oauth SET last_sync_at = NULL, last_sync_error = NULL WHERE guild_id = ?").run(GUILD_A);
      discord.log.length = 0;
      discord.restGetThrows = false;
      installMocks();
      try {
        const before = auditCount("slash");
        await staffRolesFeature.handlers.staff(
          slashInteraction({ userId: USER_ADMIN, sub: "syncpermissions", manageGuild: true, bools: { force_reauth: false } }),
          { client: FAKE_CLIENT }
        );
        assert.equal(auditCount("slash"), before + 1, "slash synced + audited");
        bump("slash", "staff.sync_permissions");
        global.__gate3SlashSyncLog = discord.log.slice();
        global.__gate3SlashSyncAudit = lastAudit("slash", { action: "staff.sync_permissions", targetId: GUILD_A });
      } finally {
        restoreMocks();
      }
      const log = global.__gate3SlashSyncLog;
      assert.equal(log.filter((e) => e.kind === "rest-get").length, 1, "one guild-command list GET");
      assert.equal(log.filter((e) => e.kind === "put").length, 3, "three permission PUTs (the 3 registered targets)");
      assert.equal(log.filter((e) => e.kind === "token-post").length, 0, "a fresh stored token ⇒ NO refresh round-trip");
    });

    it("web twin run on appReal (NO sync seam — the REAL core): byte-identical outbound sequence + equal audit (origin aside); no session token ever leaves", async () => {
      oauthSeedFresh();
      rawDb.prepare("UPDATE guild_command_permission_oauth SET last_sync_at = NULL, last_sync_error = NULL WHERE guild_id = ?").run(GUILD_A);
      discord.log.length = 0;
      installMocks();
      let webAudit;
      try {
        const before = auditCount("web");
        const { res, location } = await postRaw(baseReal, `/g/${GUILD_A}/commands/sync`, {
          cookie: cookieOf.admin,
          fields: { return: "staff", _csrf: csrfOf.admin },
        });
        assert.equal(res.status, 302, `web sync must complete (loc ${location})`);
        assert.equal(location, `/g/${GUILD_A}/staff?done=sync_completed`);
        assert.equal(auditCount("web"), before + 1);
        bump("web", "staff.sync_permissions");
        webAudit = lastAudit("web", { action: "staff.sync_permissions", targetId: GUILD_A });
        global.__gate3WebSyncLog = discord.log.slice();
      } finally {
        restoreMocks();
      }

      // THE outbound Discord sequences are identical (order, endpoints,
      // bodies, Authorization headers):
      assert.deepEqual(global.__gate3WebSyncLog, global.__gate3SlashSyncLog, "same REST/PUT sequence on both transports");
      // every PUT carried the STORED token — and NOTHING resembling a
      // web session token (decision 9 re-pinned at the transport):
      for (const e of global.__gate3WebSyncLog.filter((x) => x.kind === "put")) {
        assert.equal(e.auth, `Bearer ${STORED_AT}`, "the sync always rides the stored slash-OAuth token");
        assert.ok(!e.auth.includes("tok-"), "session token NEVER outbound");
        assert.ok(!e.headers.includes(sessionIdOf.admin), "the web session id NEVER leaves the process");
      }
      // audit parity:
      assert.equal(webAudit.origin, "web");
      assert.deepEqual(auditCmp(webAudit), auditCmp(global.__gate3SlashSyncAudit), "sync audit rows equal (origin aside) — role_count 2 / commands_updated 3");
      // the shared core stamped its bookkeeping identically:
      const row = api.getCommandPermissionOauth ? api.getCommandPermissionOauth(GUILD_A) : null;
      if (row) {
        assert.ok(row.last_sync_at != null, "last_sync_at stamped by the web run");
        assert.equal(row.last_sync_error, null, "clean sync cleared the error");
      }
      PARITY.find((r) => r.no === "C1").parity = "BOTH";
    });

    it("delta D5 rows: no stored authorization ⇒ slash returns the authorize link / web returns its slug — ZERO Discord calls, ZERO audit on both; hard-fail sync ⇒ NO audit on either transport (fail-safe vs fail-closed, both unaudited)", async () => {
      api.deleteCommandPermissionOauth(GUILD_A);
      discord.log.length = 0;
      installMocks();
      try {
        let before = { s: auditCount("slash"), w: auditCount("web") };
        const inter = slashInteraction({ userId: USER_ADMIN, sub: "syncpermissions", manageGuild: true, bools: {} });
        await staffRolesFeature.handlers.staff(inter, { client: FAKE_CLIENT });
        assert.deepEqual(discord.log, [], "slash made ZERO Discord calls without authorization");
        const replyText = inter.replies.map((r) => JSON.stringify(r)).join(" ");
        assert.match(replyText, /authorize|oauth/i, "slash answers with its authorize-link UX");
        assert.equal(auditCount("slash"), before.s, "no-audit on the slash precondition refusal");

        const { res, location } = await postRaw(baseReal, `/g/${GUILD_A}/commands/sync`, {
          cookie: cookieOf.admin,
          fields: { return: "staff", _csrf: csrfOf.admin },
        });
        assert.equal(res.status, 302);
        assert.match(String(location), /error=not_authorized_run_slash/, "web slug advice (decision 9: authorize stays slash-only)");
        assert.deepEqual(discord.log, [], "web made ZERO Discord calls without authorization");
        assert.equal(auditCount("web"), before.w, "no-audit on the web precondition refusal");

        // hard-fail (transport outage) — DELTA D5: neither transport writes
        // an audit row for a FAILED sync (slash fail-safe + web fail-closed
        // converge on "no fabricated success trail"):
        oauthSeedFresh();
        discord.log.length = 0;
        discord.restGetThrows = true;
        before = { s: auditCount("slash"), w: auditCount("web") };
        const inter2 = slashInteraction({ userId: USER_ADMIN, sub: "syncpermissions", manageGuild: true, bools: {} });
        await staffRolesFeature.handlers.staff(inter2, { client: FAKE_CLIENT });
        assert.equal(auditCount("slash"), before.s, "hard-failed slash sync audited NOTHING");
        const fail = await postRaw(baseReal, `/g/${GUILD_A}/commands/sync`, {
          cookie: cookieOf.admin,
          fields: { return: "staff", _csrf: csrfOf.admin },
        });
        assert.equal(fail.res.status, 302);
        assert.match(String(fail.location), /error=sync_failed/, "web maps the failure to a frozen slug (never a fake success)");
        assert.equal(auditCount("web"), before.w, "hard-failed web sync audited NOTHING (fail-closed: no row, no claim)");
        discord.restGetThrows = false;
      } finally {
        restoreMocks();
      }
    });
  });
});

// ===========================================================================
// G. PROGRAM INVARIANT — the ledger vs admin_audit reconciliation + the
// matrix artifact.
// ===========================================================================

describe("G. program invariant — every audit row ever written is accounted for (§8.8 exit)", () => {
  it("admin_audit GROUP BY (origin, action) EQUALS the ledger exactly — no stray rows, no forged origins, one guild", () => {
    const dbGroups = sqlAuditGroups();
    const dbKeys = new Map();
    for (const g of dbGroups) dbKeys.set(`${g.origin}|${g.action}`, g.n);

    const extra = [...dbKeys.keys()].filter((k) => !ledger.has(k));
    const missing = [...ledger.keys()].filter((k) => !dbKeys.has(k));
    assert.deepEqual(extra, [], "admin_audit rows the gate never produced (hidden audit writes?)");
    assert.deepEqual(missing, [], "the ledger promised audit rows that are not in the DB");
    const mismatches = [...ledger.entries()].filter(
      ([k, n]) => dbKeys.get(k) !== n
    );
    assert.deepEqual(
      mismatches.map(([k, n]) => `${k}: ledger=${n} db=${dbKeys.get(k)}`),
      [],
      "per-action audit counts equal the ledger EXACTLY (every success booked at its source)"
    );

    // origins + guilds: the whole vocabulary is the frozen whitelist and
    // every row lives in GUILD_A (the forged guild_id never stored anywhere):
    const origins = new Set(dbGroups.map((g) => g.origin));
    for (const o of origins) {
      assert.ok(["web", "slash", "system"].includes(o), `origin ${o} must be whitelisted`);
    }
    assert.ok(origins.has("web") && origins.has("slash") && origins.has("system"), "all three origins genuinely exist in the trail");
    assert.deepEqual(
      sqlAuditGuilds().map((r) => r.guild_id),
      [GUILD_A],
      "no audit row exists for any other guild (cross-guild + forged-guild probes wrote nothing)"
    );
    // the web-origin ledger total equals the web row count (belt):
    const webLedger = [...ledger.entries()].filter(([k]) => k.startsWith("web|")).reduce((s, [, n]) => s + n, 0);
    assert.equal(auditCount("web"), webLedger);
  });

  it("every matrix row PASSed its ladder AND the checklist covers every Phase-3 area; parity rows ran BOTH transports", () => {
    const passed = PARITY.filter((r) => r.status === "PASS");
    assert.equal(passed.length, PARITY.length, "every mutation row must have PASSed (a ladder failed earlier)");
    for (const no of PARITY_RUN_ROWS) {
      const row = PARITY.find((r) => r.no === no);
      assert.equal(row.parity, "BOTH", `${row.no}: the two-transport parity run must have executed for every Phase-3 row`);
    }
    const areas = PARITY.map((r) => r.area.toLowerCase()).join(" | ");
    for (const area of [
      "settings", "command channels", "staff roles", "level roles", "youtube", "twitch",
      "reaction roles", "event reminders", "honeypot", "honeypot exempt",
      "xp", "warnings", "staff notes", "tickets", "command visibility",
    ]) {
      assert.ok(areas.includes(area), `checklist area missing: ${area} (§8.8 program exit)`);
    }
  });

  it("PROGRAM GATE REPORT — the full equivalence matrix (template|method|tier|helpers|action|parity|delta) to stderr", () => {
    const lines = [
      "",
      "== PHASE-3 PROGRAM GATE — FULL SLASH↔WEB EQUIVALENCE MATRIX (subtask 32, roadmap §8.8) ==",
      "template | method | tier | helpers | action | parity-status | delta-ref",
    ];
    for (const row of PARITY) {
      lines.push(
        `${row.template} | ${row.method} | ${row.tier} | ${row.helpers.join("+")} | ${row.action} | ` +
          `${row.parity === "BOTH" ? "BOTH-TRANSPORTS (executed here)" : "LADDER + phase2 slash-parity"} | ` +
          `${DELTA_REFS[row.template] || "—"}`
      );
    }
    const counts = {};
    for (const g of sqlAuditGroups()) {
      counts[g.origin] = (counts[g.origin] || 0) + g.n;
    }
    lines.push(
      `ledger: web=${counts.web || 0} slash=${counts.slash || 0} system=${counts.system || 0} (all accounted for)`,
      `parity-ran: ${[...PARITY_RUN_ROWS].join(",")} · mutations=${PARITY.length} · all rows PASS`,
      ""
    );
    console.error(lines.join("\n")); // the §8.8 artifact (house stderr convention)
  });
});
