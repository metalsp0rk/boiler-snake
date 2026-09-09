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

// Clearly-fake sentinels / placeholders ONLY (AGENTS.md: never realistic).
const SESSION_SECRET = "test-gate2-sentinel-session-secret-NOT-REAL-027";
const YT_KEY = "YOUR_YOUTUBE_API_KEY-placeholder-not-real";

const GUILD_A = "310000000000000001"; // bot + every test user
const GUILD_CROSS = "310000000000000002"; // bot guild the users are NOT in

const USER_ADMIN = "448190112345678901"; // owner snapshot ⇒ tier admin
const USER_STAFF = "448190112345678902"; // junior staff role ⇒ tier staff
const USER_SENIOR = "448190112345678903"; // senior staff role ⇒ tier senior
const USER_PLAIN = "448190112345678904"; // guild-A member, no staff role
const USER_STRANGER = "448190112345678905"; // member of NOTHING

// Tier-resolution roles (deliberately NOT snowflake-shaped so they can never
// be confused with mutation subject ids — same trick as subtask 25).
const ROLE_JUNIOR_TIER = "role-junior-staff";
const ROLE_SENIOR_TIER = "role-senior-staff";

// Mutation subject ids (all PRESENT in the fake client cache below).
const CH_AUDIT = "600000000000000111"; // settings logs/audit, yt notify, event reminders
const CH_MESSAGE = "600000000000000112"; // settings message stream, twitch notify, RR panels
const CH_WARN = "600000000000000113"; // settings warn-log
const CH_CMD = "600000000000000114"; // command-channels add/remove
const CH_HONEY = "600000000000000115"; // honeypot channel add/del
const ROLE_STAFF = "500000000000000211"; // staff role add/remove/setlevel
const ROLE_LEVEL = "500000000000000212"; // levelrole set/remove
const ROLE_UPLOAD = "500000000000000213"; // youtube uploadrole
const ROLE_TW = "500000000000000214"; // twitch notify role
const ROLE_BAN = "500000000000000215"; // honeypot banrole
const ROLE_EXEMPT = "500000000000000216"; // honeypot exempt
const PANEL_MSG = "930000000000000001"; // fake channel send() message id
const USER_GRANT = "448190112345678906"; // xp.grant subject (subtask 28) —
// DELIBERATELY absent from the fake client cache: the grant exercises the
// slash's member-miss path (awardXp resolves no member → role sync skipped),
// exactly like a slash whose members.fetch fails (src/services/awardXp.js:46).
const USER_WARN_SUBJECT = "448190112345678907"; // warn issue/void + note
// subject (subtask 29) — likewise cache-absent: the mutations exercise the
// cache-only DM seam's graceful-skip path (never a fetch on a request path).
const YT_ID = "UC0123456789012345678901"; // /channel/ URL form parses this
const YT_URL = `https://www.youtube.com/channel/${YT_ID}`;
const TW_ID = "420000001";
const TW_LOGIN = "gatestream";
const GATE_CHANNEL_NAME = "GATE-LIVE-CH-NAME-4f7c"; // getClient-threading marker

const BOT_GUILDS = [GUILD_A, GUILD_CROSS];

const ENV_KEYS = [
  "SESSION_SECRET",
  "DB_PATH",
  "DATA_DIR",
  "CLIENT_ID",
  "CLIENT_SECRET",
  "PUBLIC_HTTP_PORT",
  "TICKET_HTTP_PORT",
  "PUBLIC_BASE_URL",
  "TICKET_PUBLIC_BASE_URL",
  "WEB_RATE_LIMIT_MUTATION_MAX",
  "YOUTUBE_API_KEY",
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
];

// ---------------------------------------------------------------------------
// Fake Discord transport under the REAL resolver (Phase-1 gate pattern)
// ---------------------------------------------------------------------------

function userOf(token) {
  return String(token).replace(/^tok-/, "");
}

const fakeDiscord = {
  async getUserGuilds(token) {
    const userId = userOf(token);
    if (userId === USER_ADMIN) {
      return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: true, permissions: "0" }];
    }
    if (userId === USER_STAFF || userId === USER_SENIOR || userId === USER_PLAIN) {
      return [{ id: GUILD_A, name: "Alpha HQ", icon: null, owner: false, permissions: "0" }];
    }
    return []; // stranger: member of NOTHING ⇒ cross-guild doctrine ⇒ 404
  },
  async getUserGuildMember(token, guildId) {
    const userId = userOf(token);
    if (guildId !== GUILD_A) {
      const err = new Error("Unknown Guild");
      err.status = 404;
      throw err;
    }
    if (userId === USER_STAFF) return { roles: [ROLE_JUNIOR_TIER] };
    if (userId === USER_SENIOR) return { roles: [ROLE_SENIOR_TIER] };
    return { roles: [] }; // plain member: in the guild, NO staff role
  },
};

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
// SERVICE-LAYER counting proxy on the SHARED src/db facade object. Every web
// route/data module resolves facade METHODS AT CALL TIME on this object
// (settingsWrite DI, staff routes facade, integrations module-level db ===
// this object), so the wrappers here are what the handlers actually call.
// The audit middleware captures db.insertAdminAudit at createWebApp time —
// installed BEFORE the app is built; the throw-flag toggle then reaches the
// mounted middleware through the captured wrapper.
// ---------------------------------------------------------------------------

const FACADE_METHODS = [
  "getGuildSettings",
  "updateGuildSettings",
  "addAllowedCommandChannel",
  "removeAllowedCommandChannel",
  "getStaffRole",
  "addStaffRole",
  "setStaffRoleLevel",
  "removeStaffRole",
  "listLevelRoles",
  "upsertLevelRole",
  "deleteLevelRole",
  "getYoutubeChannels",
  "addYoutubeChannel",
  "removeYoutubeChannel",
  "getTwitchChannels",
  "getTwitchChannel",
  "addTwitchChannel",
  "removeTwitchChannel",
  "getReactionRolePanel",
  "createReactionRolePanel",
  "deleteReactionRolePanel",
  "getReactionRoleOption",
  "upsertReactionRoleOption",
  "deleteReactionRoleOption",
  "countReactionRoleOptions",
  "listReactionRoleOptions",
  "isHoneypotChannel",
  "addHoneypotChannel",
  "removeHoneypotChannel",
  "isHoneypotBanRole",
  "addHoneypotBanRole",
  "removeHoneypotBanRole",
  // Phase 3 (subtask 28) XP-grant surface: addXp/logActivity are the write
  // helpers the awardXp SERVICE (the slash's own path) calls; getXp is the
  // slash-parity before/after read (features/xp/index.js:446).
  "addXp",
  "logActivity",
  "getXp",
  // Phase 3 (subtask 29) moderation surface: the slash's OWN write helpers
  // (warnings/index.js:458|747, staffNotes/index.js:277); getStaffNote is the
  // issue-form note-link READ (routes/moderation.js parseWarnIssueInput).
  "createWarning",
  "voidWarning",
  "createStaffNote",
  "getStaffNote",
  // Phase 3 (subtask 30) ticket surface: claimTicket is the slash's OWN
  // write (features/tickets/index.js:1650); markTicketClosed runs INSIDE
  // the slash's OWN softCloseTicket (features/tickets/close.js) — the
  // gate lazy-loads close.js on the first web close (route seam), AFTER
  // this install, so the feature's load-time destructure binds THE
  // WRAPPER (recorded from inside = deep service-layer proof §8.6).
  "claimTicket",
  "markTicketClosed",
];

/** DB-mutating facade helpers — validation rejections must call ZERO of these. */
const WRITE_HELPERS = new Set([
  "updateGuildSettings",
  "addAllowedCommandChannel",
  "removeAllowedCommandChannel",
  "addStaffRole",
  "setStaffRoleLevel",
  "removeStaffRole",
  "upsertLevelRole",
  "deleteLevelRole",
  "addYoutubeChannel",
  "removeYoutubeChannel",
  "addTwitchChannel",
  "removeTwitchChannel",
  "createReactionRolePanel",
  "deleteReactionRolePanel",
  "upsertReactionRoleOption",
  "deleteReactionRoleOption",
  "addHoneypotChannel",
  "removeHoneypotChannel",
  "addHoneypotBanRole",
  "removeHoneypotBanRole",
  "addXp",
  "logActivity",
  "createWarning",
  "voidWarning",
  "createStaffNote",
  "claimTicket",
  "markTicketClosed",
]);

const recorder = {
  active: false,
  log: [],
  auditThrow: false, // §8.1-7 fail-closed injection flag
};

function installFacadeRecorder(F) {
  const originals = {};
  for (const name of FACADE_METHODS) {
    if (typeof F[name] !== "function") {
      throw new Error(`gate precondition: facade helper "${name}" missing (renamed?)`);
    }
    originals[name] = F[name];
    F[name] = function recorded(...args) {
      if (recorder.active) recorder.log.push({ name, args });
      return originals[name].apply(this, args);
    };
  }
  const origInsert = F.insertAdminAudit;
  F.insertAdminAudit = function recordedInsert(entry) {
    if (recorder.active) recorder.log.push({ name: "insertAdminAudit", entry });
    if (recorder.auditThrow) {
      const err = new Error("admin_audit insert failed (gate injection)");
      err.code = "GATE_AUDIT_INJECT";
      throw err;
    }
    return origInsert.apply(this, arguments);
  };
  return function restore() {
    for (const name of FACADE_METHODS) F[name] = originals[name];
    F.insertAdminAudit = origInsert;
  };
}

// Install BEFORE createWebApp so the audit middleware captures the wrapper
// (createAuditDeps() snapshots insertAdminAudit — §8.1-7).
const restoreFacadeRecorder = installFacadeRecorder(dbFacade);

function startWindow() {
  recorder.log = [];
  recorder.active = true;
}
function stopWindow() {
  recorder.active = false;
  return recorder.log.slice();
}

// ---------------------------------------------------------------------------
// Mirror spy (§8.1-7): the audit middleware dispatches mirrors through the
// REAL features/logs/auditLog module object (property resolves at dispatch
// time) with the bound client (boundAuditClient read at dispatch time).
// Swapping the two posters + binding a truthy fake proves per row whether a
// mirror WAS scheduled (settings/staff) or was NOT (integrations, fail-closed).
// ---------------------------------------------------------------------------

const mirrorSpy = { log: [], sendAudit: null, sendWarn: null };

function installMirrorSpy() {
  mirrorSpy.sendAudit = auditLogMod.sendAuditLog;
  mirrorSpy.sendWarn = auditLogMod.sendWarnLog;
  auditLogMod.sendAuditLog = (...args) => {
    mirrorSpy.log.push({ kind: "audit", args });
    return Promise.resolve(true);
  };
  auditLogMod.sendWarnLog = (...args) => {
    mirrorSpy.log.push({ kind: "warn", args });
    return Promise.resolve(true);
  };
  bindAuditClient({ __gateFakeAuditClient: true });
}
function restoreMirrorSpy() {
  auditLogMod.sendAuditLog = mirrorSpy.sendAudit;
  auditLogMod.sendWarnLog = mirrorSpy.sendWarn;
  bindAuditClient(null);
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

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

/** Audit-details expectation factory (static deep-equal target per row). */
const D = (obj) => () => obj;

const PARITY = [
  // ---- Settings surface (subtask 24) — §8.6 "Settings" row ------------------
  {
    no: "S1",
    area: "settings (xp, cooldowns, level curve)",
    template: "/g/:guildId/settings/xp",
    method: "POST",
    tier: "staff",
    slash: "/setxp → updateGuildSettings (src/features/xp/index.js:365)",
    helpers: ["updateGuildSettings"],
    action: "xp.settings_update",
    targetType: "guild",
    targetId: GUILD_A,
    mirror: true,
    // Form field name is "message" — buildXpPatch maps it to the msg_xp
    // COLUMN (settingsWrite.js:151), exactly like /setxp message <n>.
    fields: { message: "17" },
    prepare: () => api.updateGuildSettings(GUILD_A, { msg_xp: 11 }),
    details: D({ patch: { msg_xp: 17 } }),
    okLocation: `/g/${GUILD_A}/settings?ok=xp`,
    reject: { status: 302, location: `/g/${GUILD_A}/settings?err=xp`, fields: {} },
  },
  {
    no: "S2",
    area: "settings (decay)",
    template: "/g/:guildId/settings/decay",
    method: "POST",
    tier: "staff",
    slash: "/setdecay → updateGuildSettings (src/features/decay/index.js:94 audit)",
    helpers: ["updateGuildSettings"],
    action: "decay.settings_update",
    targetType: "guild",
    targetId: GUILD_A,
    mirror: true,
    fields: { percent: "25" },
    prepare: () => api.updateGuildSettings(GUILD_A, { decay_percent: 0.5 }),
    details: D({ patch: { decay_percent: 0.25 } }),
    okLocation: `/g/${GUILD_A}/settings?ok=decay`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/settings?err=decay`,
      fields: { percent: "900" },
    },
  },
  {
    no: "S3",
    area: "settings (log channels)",
    template: "/g/:guildId/settings/logs",
    method: "POST",
    tier: "staff",
    slash: "/setlog → updateGuildSettings (src/features/logs/index.js:146)",
    helpers: ["updateGuildSettings"],
    action: "logs.channel_set",
    targetType: "channel",
    targetId: CH_AUDIT,
    mirror: true,
    fields: { stream: "audit", channel: CH_AUDIT },
    prepare: () => api.updateGuildSettings(GUILD_A, { audit_log_channel_id: null }),
    details: D({ stream: "audit", previous_channel_id: null }),
    okLocation: `/g/${GUILD_A}/settings?ok=logs`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/settings?err=logs`,
      fields: { stream: "bogus", channel: CH_AUDIT },
    },
  },
  {
    no: "S4",
    area: "settings (warn log channel)",
    template: "/g/:guildId/settings/warn-log",
    method: "POST",
    tier: "staff",
    slash: "/setwarn log → updateGuildSettings (src/features/warnings/index.js:1166)",
    helpers: ["updateGuildSettings"],
    action: "warnings.log_channel_set",
    targetType: "channel",
    targetId: CH_WARN,
    mirror: true,
    fields: { channel: CH_WARN },
    prepare: () => api.updateGuildSettings(GUILD_A, { warn_log_channel_id: null }),
    details: D({ previous_channel_id: null, channel_id: CH_WARN }),
    okLocation: `/g/${GUILD_A}/settings?ok=warn`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/settings?err=warn`,
      fields: { channel: "not-a-snowflake" },
    },
  },
  {
    no: "S5",
    area: "command channels (allow-list add)",
    template: "/g/:guildId/settings/command-channels/add",
    method: "POST",
    tier: "admin",
    slash: "/setcommandchannel add → addAllowedCommandChannel (src/features/commandChannels/index.js:65)",
    helpers: ["addAllowedCommandChannel"],
    action: "command_channels.add",
    targetType: "channel",
    targetId: CH_CMD,
    mirror: true,
    fields: { channel: CH_CMD },
    prepare: () => api.removeAllowedCommandChannel(GUILD_A, CH_CMD),
    details: D({ channel_id: CH_CMD }),
    okLocation: `/g/${GUILD_A}/settings?ok=channels`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/settings?err=channels`,
      fields: { channel: "nope" },
    },
  },
  {
    no: "S6",
    area: "command channels (allow-list remove)",
    template: "/g/:guildId/settings/command-channels/remove",
    method: "POST",
    tier: "admin",
    slash: "/setcommandchannel remove → removeAllowedCommandChannel (src/features/commandChannels/index.js:87)",
    helpers: ["removeAllowedCommandChannel"],
    action: "command_channels.remove",
    targetType: "channel",
    targetId: CH_CMD,
    mirror: true,
    fields: { channel: CH_CMD },
    prepare: () => api.addAllowedCommandChannel(GUILD_A, CH_CMD),
    details: D({ channel_id: CH_CMD }),
    okLocation: `/g/${GUILD_A}/settings?ok=channels`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/settings?err=channels`,
      fields: { channel: "nope" },
    },
  },

  // ---- Staff & roles (subtask 25) — §8.6 "Staff & roles" row = Admin -------
  {
    no: "R1",
    area: "staff roles (add)",
    template: "/g/:guildId/staff/role/add",
    method: "POST",
    tier: "admin",
    slash: "/staff role add → addStaffRole (src/features/staffRoles/index.js:185)",
    helpers: ["addStaffRole"],
    action: "staff.role_add",
    targetType: "role",
    targetId: ROLE_STAFF,
    mirror: true,
    fields: { role_id: ROLE_STAFF, level: "junior" },
    prepare: () => api.removeStaffRole(GUILD_A, ROLE_STAFF),
    details: D({ level: "junior", previous_level: null }),
    okLocation: `/g/${GUILD_A}/staff`,
    reject: {
      status: 400,
      bodyMatch: /invalid role id/i,
      fields: { role_id: "not-a-snowflake", level: "junior" },
    },
  },
  {
    no: "R2",
    area: "staff roles (remove)",
    template: "/g/:guildId/staff/role/remove",
    method: "POST",
    tier: "admin",
    slash: "/staff role remove → removeStaffRole (src/features/staffRoles/index.js:243)",
    helpers: ["removeStaffRole"],
    action: "staff.role_remove",
    targetType: "role",
    targetId: ROLE_STAFF,
    mirror: true,
    fields: { role_id: ROLE_STAFF },
    prepare: () => api.addStaffRole(GUILD_A, ROLE_STAFF, "senior"),
    details: D({ previous_level: "senior" }),
    okLocation: `/g/${GUILD_A}/staff`,
    reject: { status: 400, bodyMatch: /invalid role id/i, fields: {} },
  },
  {
    no: "R3",
    area: "staff roles (level change)",
    template: "/g/:guildId/staff/role/setlevel",
    method: "POST",
    tier: "admin",
    slash: "/staff role setlevel → setStaffRoleLevel (src/features/staffRoles/index.js:306)",
    helpers: ["setStaffRoleLevel"],
    action: "staff.role_setlevel",
    targetType: "role",
    targetId: ROLE_STAFF,
    mirror: true,
    fields: { role_id: ROLE_STAFF, level: "senior" },
    prepare: () => {
      api.removeStaffRole(GUILD_A, ROLE_STAFF);
      api.addStaffRole(GUILD_A, ROLE_STAFF, "junior");
    },
    details: D({ previous_level: "junior", level: "senior" }),
    okLocation: `/g/${GUILD_A}/staff`,
    reject: {
      status: 400,
      bodyMatch: /invalid staff level/i,
      fields: { role_id: ROLE_STAFF, level: "boss" },
    },
  },
  {
    no: "R4",
    area: "level roles (set)",
    template: "/g/:guildId/staff/levelrole/set",
    method: "POST",
    tier: "staff",
    slash: "/leveltorole set → upsertLevelRole (src/features/levelRoles/index.js:77)",
    helpers: ["upsertLevelRole"],
    action: "level_roles.set",
    targetType: "role",
    targetId: ROLE_LEVEL,
    mirror: true,
    fields: { role_id: ROLE_LEVEL, level: "5", drop_days: "2" },
    prepare: () => api.deleteLevelRole(GUILD_A, ROLE_LEVEL),
    details: D({ level_required: 5, drop_grace_days: 2 }),
    okLocation: `/g/${GUILD_A}/staff`,
    reject: {
      status: 400,
      bodyMatch: /invalid number/i,
      fields: { role_id: ROLE_LEVEL, level: "1.5", drop_days: "0" },
    },
  },
  {
    no: "R5",
    area: "level roles (remove)",
    template: "/g/:guildId/staff/levelrole/remove",
    method: "POST",
    tier: "staff",
    slash: "/leveltorole remove → deleteLevelRole (src/features/levelRoles/index.js:113)",
    helpers: ["deleteLevelRole"],
    action: "level_roles.remove",
    targetType: "role",
    targetId: ROLE_LEVEL,
    mirror: true,
    fields: { role_id: ROLE_LEVEL },
    prepare: () => api.upsertLevelRole(GUILD_A, ROLE_LEVEL, 3, 1),
    details: D(null), // slash /leveltorole remove writes NO details
    okLocation: `/g/${GUILD_A}/staff`,
    reject: { status: 400, bodyMatch: /invalid role id/i, fields: { role_id: "junk" } },
  },

  // ---- Integrations (subtask 26) — §8.6 "Integrations" row, per-command ----
  {
    no: "I1",
    area: "youtube (channel add)",
    template: "/g/:guildId/integrations/youtube/add",
    method: "POST",
    tier: "staff",
    slash: "/youtube add → addYoutubeChannel (src/features/youtube/index.js:211|559)",
    helpers: ["addYoutubeChannel"],
    action: "youtube.channel_add",
    targetType: "youtube_channel",
    targetId: YT_ID,
    mirror: false,
    fields: { url: YT_URL },
    prepare: () => api.removeYoutubeChannel(GUILD_A, YT_ID),
    details: D({ channel_name: `Channel ID: ${YT_ID}`, url: YT_URL }),
    okLocation: `/g/${GUILD_A}/integrations?done=yt_added`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=missing_field`,
      fields: {},
    },
  },
  {
    no: "I2",
    area: "youtube (channel remove)",
    template: "/g/:guildId/integrations/youtube/remove",
    method: "POST",
    tier: "staff",
    slash: "/youtube remove → removeYoutubeChannel (src/features/youtube/index.js:283)",
    helpers: ["removeYoutubeChannel"],
    action: "youtube.channel_remove",
    targetType: "youtube_channel",
    targetId: YT_ID,
    mirror: false,
    fields: { channel_id: YT_ID },
    prepare: () => {
      api.removeYoutubeChannel(GUILD_A, YT_ID);
      api.addYoutubeChannel(GUILD_A, YT_ID, "Gate Tube", "https://youtu.be/seed", "");
    },
    details: D({ channel_name: "Gate Tube" }),
    okLocation: `/g/${GUILD_A}/integrations?done=yt_removed`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=missing_field`,
      fields: {},
    },
  },
  {
    no: "I3",
    area: "youtube (notify channel)",
    template: "/g/:guildId/integrations/youtube/channel",
    method: "POST",
    tier: "staff",
    slash: "/setyoutube channel → updateGuildSettings (src/features/youtube/index.js:384)",
    helpers: ["updateGuildSettings"],
    action: "youtube.notify_channel_set",
    targetType: "channel",
    targetId: CH_AUDIT,
    mirror: false,
    fields: { channel_id: CH_AUDIT },
    prepare: () => api.updateGuildSettings(GUILD_A, { youtube_notification_channel_id: null }),
    details: D({ previous_channel_id: null }),
    okLocation: `/g/${GUILD_A}/integrations?done=yt_channel_set`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_channel_id`,
      fields: { channel_id: "x" },
    },
  },
  {
    no: "I4",
    area: "youtube (polling interval)",
    template: "/g/:guildId/integrations/youtube/interval",
    method: "POST",
    tier: "staff",
    slash: "/setyoutube interval → updateGuildSettings (src/features/youtube/index.js:418)",
    helpers: ["updateGuildSettings"],
    action: "youtube.polling_interval_set",
    targetType: "guild",
    targetId: GUILD_A,
    mirror: false,
    fields: { minutes: "15" },
    // Column is INTEGER NOT NULL DEFAULT 5 — seed the DEFAULT (web never
    // nulls an interval); details prove previous_minutes is the OLD value.
    prepare: () => api.updateGuildSettings(GUILD_A, { youtube_polling_interval_minutes: 5 }),
    details: D({ previous_minutes: 5, minutes: 15 }),
    okLocation: `/g/${GUILD_A}/integrations?done=yt_interval_set`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_interval`,
      fields: { minutes: "999" },
    },
  },
  {
    no: "I5",
    area: "youtube (upload role)",
    template: "/g/:guildId/integrations/youtube/uploadrole",
    method: "POST",
    tier: "staff",
    slash: "/setyoutube uploadrole → updateGuildSettings (src/features/youtube/index.js:442)",
    helpers: ["updateGuildSettings"],
    action: "youtube.upload_role_set",
    targetType: "role",
    targetId: ROLE_UPLOAD,
    mirror: false,
    fields: { role_id: ROLE_UPLOAD },
    prepare: () => api.updateGuildSettings(GUILD_A, { youtube_upload_role_id: null }),
    details: D({ role_id: ROLE_UPLOAD, previous_role_id: null }),
    okLocation: `/g/${GUILD_A}/integrations?done=yt_upload_role_set`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_role_id`,
      fields: { role_id: "x" },
    },
  },
  {
    no: "I6",
    area: "twitch (channel add)",
    template: "/g/:guildId/integrations/twitch/add",
    method: "POST",
    tier: "staff",
    slash: "/twitch add → addTwitchChannel (src/features/twitch/index.js:142)",
    helpers: ["addTwitchChannel"],
    action: "twitch.channel_add",
    targetType: "twitch_channel",
    targetId: TW_ID,
    mirror: false,
    fields: { login: TW_LOGIN },
    prepare: () => api.removeTwitchChannel(GUILD_A, TW_LOGIN),
    details: D({ login: TW_LOGIN, display_name: "Gate Stream" }),
    okLocation: `/g/${GUILD_A}/integrations?done=tw_added`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=missing_field`,
      fields: {},
    },
  },
  {
    no: "I7",
    area: "twitch (channel remove)",
    template: "/g/:guildId/integrations/twitch/remove",
    method: "POST",
    tier: "staff",
    slash: "/twitch remove → removeTwitchChannel (src/features/twitch/index.js:189)",
    helpers: ["removeTwitchChannel"],
    action: "twitch.channel_remove",
    targetType: "twitch_channel",
    targetId: TW_ID,
    mirror: false,
    fields: { channel: TW_LOGIN },
    prepare: () => api.addTwitchChannel(GUILD_A, TW_ID, TW_LOGIN, "Gate Stream", ""),
    details: D({ login: TW_LOGIN, display_name: "Gate Stream" }),
    okLocation: `/g/${GUILD_A}/integrations?done=tw_removed`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=missing_field`,
      fields: {},
    },
  },
  {
    no: "I8",
    area: "twitch (notify channel)",
    template: "/g/:guildId/integrations/twitch/channel",
    method: "POST",
    tier: "staff",
    slash: "/settwitch channel → updateGuildSettings (src/features/twitch/index.js:261)",
    helpers: ["updateGuildSettings"],
    action: "twitch.notify_channel_set",
    targetType: "channel",
    targetId: CH_MESSAGE,
    mirror: false,
    fields: { channel_id: CH_MESSAGE },
    prepare: () => api.updateGuildSettings(GUILD_A, { twitch_notification_channel_id: null }),
    details: D({ previous_channel_id: null }),
    okLocation: `/g/${GUILD_A}/integrations?done=tw_channel_set`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_channel_id`,
      fields: { channel_id: "x" },
    },
  },
  {
    no: "I9",
    area: "twitch (notify role)",
    template: "/g/:guildId/integrations/twitch/role",
    method: "POST",
    tier: "staff",
    slash: "/settwitch role → updateGuildSettings (src/features/twitch/index.js:289)",
    helpers: ["updateGuildSettings"],
    action: "twitch.notify_role_set",
    targetType: "role",
    targetId: ROLE_TW,
    mirror: false,
    fields: { role_id: ROLE_TW },
    prepare: () => api.updateGuildSettings(GUILD_A, { twitch_notify_role_id: null }),
    details: D({ role_id: ROLE_TW, previous_role_id: null }),
    okLocation: `/g/${GUILD_A}/integrations?done=tw_role_set`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_role_id`,
      fields: { role_id: "x" },
    },
  },
  {
    no: "I10",
    area: "twitch (polling interval)",
    template: "/g/:guildId/integrations/twitch/interval",
    method: "POST",
    tier: "staff",
    slash: "/settwitch interval → updateGuildSettings (src/features/twitch/index.js:319)",
    helpers: ["updateGuildSettings"],
    action: "twitch.polling_interval_set",
    targetType: "guild",
    targetId: GUILD_A,
    mirror: false,
    fields: { minutes: "20" },
    // Column is INTEGER NOT NULL DEFAULT 2 — seed the DEFAULT.
    prepare: () => api.updateGuildSettings(GUILD_A, { twitch_polling_interval_minutes: 2 }),
    details: D({ previous_minutes: 2, minutes: 20 }),
    okLocation: `/g/${GUILD_A}/integrations?done=tw_interval_set`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_interval`,
      fields: { minutes: "0" },
    },
  },
  {
    no: "I11",
    area: "reaction roles (panel create)",
    template: "/g/:guildId/integrations/reaction-roles/panel/create",
    method: "POST",
    tier: "staff",
    slash: "/reactionrole panel create → createReactionRolePanel (src/features/reactionRoles/index.js:268)",
    helpers: ["createReactionRolePanel"],
    action: "reaction_roles.panel_create",
    targetType: "reaction_role_panel",
    targetId: PANEL_MSG,
    mirror: false,
    fields: { channel_id: CH_MESSAGE, title: "Gate Panel", description: "react to get roles" },
    prepare: () => api.deleteReactionRolePanel(GUILD_A, PANEL_MSG),
    details: D({ channel_id: CH_MESSAGE, title: "Gate Panel" }),
    okLocation: `/g/${GUILD_A}/integrations?done=rr_panel_created`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_channel_id`,
      fields: { title: "x" },
    },
  },
  {
    no: "I12",
    area: "reaction roles (panel delete)",
    template: "/g/:guildId/integrations/reaction-roles/panel/delete",
    method: "POST",
    tier: "staff",
    slash: "/reactionrole panel delete → deleteReactionRolePanel (src/features/reactionRoles/index.js:427)",
    helpers: ["deleteReactionRolePanel"],
    action: "reaction_roles.panel_delete",
    targetType: "reaction_role_panel",
    targetId: PANEL_MSG,
    mirror: false,
    fields: { message_id: PANEL_MSG },
    prepare: () => {
      api.deleteReactionRolePanel(GUILD_A, PANEL_MSG);
      api.createReactionRolePanel(GUILD_A, CH_MESSAGE, PANEL_MSG, "Gate Panel", "d");
    },
    details: D({ channel_id: CH_MESSAGE }),
    okLocation: `/g/${GUILD_A}/integrations?done=rr_panel_deleted`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_message_id`,
      fields: { message_id: "x".repeat(21) },
    },
  },
  {
    no: "I13",
    area: "reaction roles (option add)",
    template: "/g/:guildId/integrations/reaction-roles/option/add",
    method: "POST",
    tier: "staff",
    slash: "/reactionrole option add → upsertReactionRoleOption (src/features/reactionRoles/service.js:434|942)",
    helpers: ["upsertReactionRoleOption"],
    action: "reaction_roles.option_add",
    targetType: "reaction_role_panel",
    targetId: PANEL_MSG,
    mirror: false,
    fields: { message_id: PANEL_MSG, role_id: ROLE_STAFF, emoji: "👍", level: "0" },
    prepare: () => {
      api.deleteReactionRolePanel(GUILD_A, PANEL_MSG);
      api.createReactionRolePanel(GUILD_A, CH_MESSAGE, PANEL_MSG, "Gate Panel", "d");
    },
    details: D({ role_id: ROLE_STAFF, emoji: "👍", min_level: 0, removable: 1 }),
    okLocation: `/g/${GUILD_A}/integrations?done=rr_option_added`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=rr_emoji_invalid`,
      fields: { message_id: PANEL_MSG, role_id: ROLE_STAFF, emoji: "<broken>" },
    },
  },
  {
    no: "I14",
    area: "reaction roles (option remove)",
    template: "/g/:guildId/integrations/reaction-roles/option/remove",
    method: "POST",
    tier: "staff",
    slash: "/reactionrole option remove → deleteReactionRoleOption (src/features/reactionRoles/service.js:981)",
    helpers: ["deleteReactionRoleOption"],
    action: "reaction_roles.option_remove",
    targetType: "reaction_role_panel",
    targetId: PANEL_MSG,
    mirror: false,
    fields: { message_id: PANEL_MSG, emoji: "👍" },
    prepare: () => {
      api.deleteReactionRolePanel(GUILD_A, PANEL_MSG);
      api.createReactionRolePanel(GUILD_A, CH_MESSAGE, PANEL_MSG, "Gate Panel", "d");
      api.upsertReactionRoleOption(GUILD_A, PANEL_MSG, "👍", "👍", ROLE_STAFF, 0, true);
    },
    details: D({ emoji: "👍" }),
    okLocation: `/g/${GUILD_A}/integrations?done=rr_option_removed`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=rr_emoji_invalid`,
      fields: { message_id: PANEL_MSG, emoji: "<broken>" },
    },
  },
  {
    no: "I15",
    area: "event reminders (channel set — DELTA-A: setchannel ONLY)",
    template: "/g/:guildId/integrations/event-reminders/channel",
    method: "POST",
    tier: "staff",
    slash: "/eventreminder setchannel → updateGuildSettings (src/features/eventReminders/index.js:376)",
    helpers: ["updateGuildSettings"],
    action: "event_reminders.channel_set",
    targetType: "guild",
    targetId: GUILD_A,
    mirror: false,
    fields: { channel_id: CH_AUDIT },
    prepare: () => api.updateGuildSettings(GUILD_A, { event_reminder_channel_id: null }),
    details: D({ channel_id: CH_AUDIT }),
    okLocation: `/g/${GUILD_A}/integrations?done=er_channel_set`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_channel_id`,
      fields: { channel_id: "x" },
    },
  },
  {
    no: "I16",
    area: "honeypot (channel add)",
    template: "/g/:guildId/integrations/honeypot/channel/add",
    method: "POST",
    tier: "staff",
    slash: "/honeypot channel add → addHoneypotChannel (src/features/honeypot/index.js:568)",
    helpers: ["addHoneypotChannel"],
    action: "honeypot.channel_add",
    targetType: "channel",
    targetId: CH_HONEY,
    mirror: false,
    fields: { channel_id: CH_HONEY },
    prepare: () => api.removeHoneypotChannel(GUILD_A, CH_HONEY),
    details: D(null),
    okLocation: `/g/${GUILD_A}/integrations?done=hp_channel_added`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_channel_id`,
      fields: { channel_id: "x" },
    },
  },
  {
    no: "I17",
    area: "honeypot (channel del)",
    template: "/g/:guildId/integrations/honeypot/channel/del",
    method: "POST",
    tier: "staff",
    slash: "/honeypot channel del → removeHoneypotChannel (src/features/honeypot/index.js:598)",
    helpers: ["removeHoneypotChannel"],
    action: "honeypot.channel_del",
    targetType: "channel",
    targetId: CH_HONEY,
    mirror: false,
    fields: { channel_id: CH_HONEY },
    prepare: () => api.addHoneypotChannel(GUILD_A, CH_HONEY),
    details: D(null),
    okLocation: `/g/${GUILD_A}/integrations?done=hp_channel_removed`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_channel_id`,
      fields: { channel_id: "x" },
    },
  },
  {
    no: "I18",
    area: "honeypot (ban role add)",
    template: "/g/:guildId/integrations/honeypot/banrole/add",
    method: "POST",
    tier: "staff",
    slash: "/honeypot banrole add → addHoneypotBanRole (src/features/honeypot/index.js:689)",
    helpers: ["addHoneypotBanRole"],
    action: "honeypot.ban_role_add",
    targetType: "role",
    targetId: ROLE_BAN,
    mirror: false,
    fields: { role_id: ROLE_BAN },
    prepare: () => api.removeHoneypotBanRole(GUILD_A, ROLE_BAN),
    details: D(null),
    okLocation: `/g/${GUILD_A}/integrations?done=hp_banrole_added`,
    reject: {
      // @everyone twin (role id === guild id) — arithmetic refusal, zero writes
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=hp_role_everyone`,
      fields: { role_id: GUILD_A },
    },
  },
  {
    no: "I19",
    area: "honeypot (ban role del)",
    template: "/g/:guildId/integrations/honeypot/banrole/del",
    method: "POST",
    tier: "staff",
    slash: "/honeypot banrole del → removeHoneypotBanRole (src/features/honeypot/index.js:715)",
    helpers: ["removeHoneypotBanRole"],
    action: "honeypot.ban_role_del",
    targetType: "role",
    targetId: ROLE_BAN,
    mirror: false,
    fields: { role_id: ROLE_BAN },
    prepare: () => api.addHoneypotBanRole(GUILD_A, ROLE_BAN),
    details: D(null),
    okLocation: `/g/${GUILD_A}/integrations?done=hp_banrole_removed`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_role_id`,
      fields: { role_id: "x" },
    },
  },
  {
    no: "H1",
    area: "honeypot exempt add — DELTA-C (maps onto staff.role_add, via=honeypot.exempt)",
    template: "/g/:guildId/integrations/honeypot/exempt/add",
    method: "POST",
    tier: "admin",
    slash: "/honeypot exempt add → addStaffRole alias (src/features/honeypot/index.js:758)",
    helpers: ["addStaffRole"],
    action: "staff.role_add",
    targetType: "role",
    targetId: ROLE_EXEMPT,
    mirror: false,
    fields: { role_id: ROLE_EXEMPT },
    prepare: () => api.removeStaffRole(GUILD_A, ROLE_EXEMPT),
    details: D({ via: "honeypot.exempt" }),
    okLocation: `/g/${GUILD_A}/integrations?done=hp_exempt_added`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_role_id`,
      fields: { role_id: "x" },
    },
  },
  {
    no: "H2",
    area: "honeypot exempt del — DELTA-C (maps onto staff.role_remove, via=honeypot.exempt)",
    template: "/g/:guildId/integrations/honeypot/exempt/del",
    method: "POST",
    tier: "admin",
    slash: "/honeypot exempt del → removeStaffRole alias (src/features/honeypot/index.js:783)",
    helpers: ["removeStaffRole"],
    action: "staff.role_remove",
    targetType: "role",
    targetId: ROLE_EXEMPT,
    mirror: false,
    fields: { role_id: ROLE_EXEMPT },
    prepare: () => api.addStaffRole(GUILD_A, ROLE_EXEMPT, "senior"),
    details: D({ via: "honeypot.exempt" }),
    okLocation: `/g/${GUILD_A}/integrations?done=hp_exempt_removed`,
    reject: {
      status: 302,
      location: `/g/${GUILD_A}/integrations?error=invalid_role_id`,
      fields: { role_id: "x" },
    },
  },
  // ---- XP grant (subtask 28, Phase 3) — §8.6 "XP" row ADMIN mutate --------
  {
    no: "X1",
    area: "xp (grant — Phase 3 action)",
    template: "/g/:guildId/xp/grant",
    method: "POST",
    tier: "admin",
    slash: "/grantxp → awardXp → addXp+logActivity (src/features/xp/index.js:448, src/services/awardXp.js:35-36)",
    // addXp is the slash's OWN write, executed INSIDE the shared awardXp
    // service — recording it here proves the web path runs THROUGH the
    // service (the route never touches the DB write helpers itself).
    helpers: ["addXp"],
    action: "xp.grant",
    targetType: "user",
    targetId: USER_GRANT,
    mirror: true, // the slash posts logConfigChange "XP granted" (index.js:473)
    fields: { user_id: USER_GRANT, amount: "250", reason: "gate parity" },
    // Deterministic baseline: XP 0 → the audit's before/after is static.
    prepare: () => api.setXp(GUILD_A, USER_GRANT, 0),
    details: D({ amount: 250, before_xp: 0, after_xp: 250, reason: "gate parity" }),
    okLocation: `/g/${GUILD_A}/xp/grant?done=xp_granted`,
    reject: {
      // amount < 1 — the slash's explicit guard (index.js:439)
      status: 302,
      location: `/g/${GUILD_A}/xp/grant?error=invalid_amount`,
      fields: { user_id: USER_GRANT, amount: "0" },
    },
  },
  // ---- Moderation (subtask 29, Phase 3) — §8.6 "Moderation" rows, STAFF ----
  // Routing DELTA (documented in routes/moderation.js): the void mutation
  // carries the warning number on the BODY (`warning_number`), not a `:id`
  // path segment — the methodGate matches mutation templates with :guildId
  // as the ONLY param (app.js matchesMutationPath). Same contract.
  {
    no: "W1",
    area: "warnings (issue — Phase 3 action)",
    template: "/g/:guildId/moderation/warnings/issue",
    method: "POST",
    tier: "staff",
    slash: "/warn add → createWarning (src/features/warnings/index.js:458, audit :492)",
    helpers: ["createWarning"],
    action: "warnings.add",
    targetType: "user",
    targetId: USER_WARN_SUBJECT,
    mirror: true, // kind "warn" — the slash's logWarnEvent (warn-log channel)
    fields: { user_id: USER_WARN_SUBJECT, reason: "gate warn reason" },
    // Deterministic details: AUTOINCREMENT reset ⇒ id/number 1; guild default
    // expiry 0 ⇒ expires_at NULL (the omitted-expires_days ≡ slash path).
    prepare: () => {
      purgeAutoincrement("warnings");
      api.updateGuildSettings(GUILD_A, { warn_expiry_days: 0 });
    },
    details: D({
      warning_id: 1,
      warning_number: 1,
      reason: "gate warn reason",
      expires_at: null,
      silent: false,
    }),
    okLocation: `/g/${GUILD_A}/warnings?done=warn_issued`,
    reject: {
      // malformed subject id — the route pre-validates, zero facade writes
      status: 302,
      location: `/g/${GUILD_A}/warnings?error=invalid_user`,
      fields: { user_id: "x", reason: "gate warn reason" },
    },
  },
  {
    no: "W2",
    area: "warnings (void — Phase 3 action)",
    template: "/g/:guildId/moderation/warnings/void",
    method: "POST",
    tier: "staff",
    slash: "/warn void → voidWarning (src/features/warnings/index.js:747, audit :781)",
    helpers: ["voidWarning"],
    action: "warnings.void",
    targetType: "warning",
    targetId: "1", // seeded W-1 rowid — static via purgeAutoincrement reset
    mirror: true, // kind "warn" — the slash's logWarnEvent again
    fields: { warning_number: "1", reason: "gate void reason" },
    // Re-seed EXACTLY one active warning (number 1, id 1) under the subject.
    prepare: () => {
      purgeAutoincrement("warnings");
      api.createWarning({
        guildId: GUILD_A,
        userId: USER_WARN_SUBJECT,
        issuerId: USER_ADMIN,
        reason: "seeded warning to void",
        expiresDays: 0,
      });
    },
    details: D({
      warning_number: 1,
      subject_user_id: USER_WARN_SUBJECT,
      void_reason: "gate void reason",
    }),
    okLocation: `/g/${GUILD_A}/warnings?done=warn_voided`,
    reject: {
      // warning_number must be a positive integer — pre-validated refusal
      status: 302,
      location: `/g/${GUILD_A}/warnings?error=invalid_warning_number`,
      fields: { warning_number: "x", reason: "gate void reason" },
    },
  },
  {
    no: "W3",
    area: "staff notes (add — Phase 3 action)",
    template: "/g/:guildId/moderation/notes",
    method: "POST",
    tier: "staff",
    slash: "/note add → createStaffNote (src/features/staffNotes/index.js:277, audit :348)",
    helpers: ["createStaffNote"],
    action: "notes.add",
    targetType: "note",
    targetId: "1", // seeded note_number/id 1 via purgeAutoincrement reset
    mirror: true, // default kind — the slash's logConfigChange audit channel
    fields: { user_id: USER_WARN_SUBJECT, content: "gate note text" },
    prepare: () => purgeAutoincrement("staff_notes"),
    // snippetNote(shortText, 500) is the identity here — slash detail shape
    // verbatim (features/staffNotes/index.js:348).
    details: D({
      note_number: 1,
      subject_user_id: USER_WARN_SUBJECT,
      content: "gate note text",
    }),
    okLocation: `/g/${GUILD_A}/notes?done=note_added`,
    reject: {
      // content > MAX_NOTE_CONTENT (2000) — the slash's maxLength option twin
      status: 302,
      location: `/g/${GUILD_A}/notes?error=content_too_long`,
      fields: { user_id: USER_WARN_SUBJECT, content: "x".repeat(2001) },
    },
  },
  // ---- Tickets (subtask 30, Phase 3) — §8.6 "Tickets" row, SENIOR only -----
  // Documented TIER delta (routes/ticketActions.js header delta (1)): the
  // slash gates claim/close/summarize behind requireStaff (staff suffices);
  // §8.6 assigns the WEB surface "Senior: claim/close/summary regen" — the
  // rows below carry tier "senior" and the senior wrong-tier branch proves
  // junior is 403'd (STRICTENING only; junior read/transcript access is
  // untouched — Phase 0c surfaces are unmutated by this module).
  // Ticket identity is the DB row id on the BODY (channel-less seed rows:
  // slash resolves tickets by CHANNEL, the web id rides the form — the
  // audit targetId is String(ticket.id) on BOTH transports).
  {
    no: "T1",
    area: "tickets (claim — Phase 3 action)",
    template: "/g/:guildId/tickets/claim",
    method: "POST",
    tier: "senior",
    slash: "/ticket claim → claimTicket (src/features/tickets/index.js:1650, audit :1651)",
    helpers: ["claimTicket"],
    action: "tickets.claim",
    targetType: "ticket",
    targetId: "1", // re-seeded ticket id 1 via purgeAutoincrement
    mirror: false, // the slash claim handler posts NO channel embed
    fields: { ticket_id: "1" },
    prepare: () => {
      purgeAutoincrement("tickets");
      api.createTicket({
        guildId: GUILD_A,
        creatorUserId: "560000000000000301", // cache-absent requester (fake)
        channelId: null,
        reason: "gate claim seed",
      });
    },
    details: D({ ticket_number: 1, previous_owner: null, staff_owner_id: USER_SENIOR }),
    okLocation: `/g/${GUILD_A}/tickets?done=ticket_claimed`,
    reject: {
      // ticket_id field shape — refused BEFORE any facade call
      status: 302,
      location: `/g/${GUILD_A}/tickets?error=invalid_ticket_id`,
      fields: { ticket_id: "x" },
    },
  },
  {
    no: "T2",
    area: "tickets (close — Phase 3 action)",
    template: "/g/:guildId/tickets/close",
    method: "POST",
    tier: "senior",
    slash: "/ticket close → softCloseTicket → markTicketClosed (src/features/tickets/index.js:1401, features/tickets/close.js, audit :1410)",
    // markTicketClosed is recorded from INSIDE the slash's OWN close helper
    // — the deep-parity evidence. The seed row has NO channel: the cache-only
    // seam hands the helper a null channel = the slash service's OWN
    // degraded path (DB transition first, permission/notice skipped as
    // warnings) — the flash claims only the transition, which truly ran.
    helpers: ["markTicketClosed"],
    action: "tickets.close",
    targetType: "ticket",
    targetId: "1",
    mirror: false, // the slash close posts NO logConfigChange (its staff-note
    // add-on is NOT part of the web surface — documented delta (4))
    fields: { ticket_id: "1", reason: "gate close reason" },
    prepare: () => {
      purgeAutoincrement("tickets");
      api.createTicket({
        guildId: GUILD_A,
        creatorUserId: "560000000000000301",
        channelId: null,
        reason: "gate close seed",
      });
    },
    details: D({ ticket_number: 1, close_reason: "gate close reason", status: "closed" }),
    okLocation: `/g/${GUILD_A}/tickets?done=ticket_closed`,
    reject: {
      // close-reason bound (MAX_TICKET_REASON = 1000) pre-validated — the
      // helper is NEVER invoked
      status: 302,
      location: `/g/${GUILD_A}/tickets?error=close_reason_too_long`,
      fields: { ticket_id: "1", reason: "x".repeat(1001) },
    },
  },
  {
    no: "T3",
    area: "tickets (summary regen — Phase 3 action)",
    template: "/g/:guildId/tickets/summarize",
    method: "POST",
    tier: "senior",
    slash: "/ticket summarize → summarizeTicket (src/features/tickets/index.js:2143, audit :2145)",
    // summarizeTicket sits ABOVE the facade (service seam, like awardXp /
    // softCloseTicket) — the gate mounts a deterministic offline fake via
    // createWebApp's ticketActions option below; on-demand regen persists
    // NOTHING on either transport, so the only recorded write is the audit.
    helpers: [],
    action: "tickets.summarize",
    targetType: "ticket",
    targetId: "1",
    mirror: false, // the slash summarize posts NO channel embed
    fields: { ticket_id: "1" },
    prepare: () => {
      purgeAutoincrement("tickets");
      rawDb.prepare("DELETE FROM ticket_messages").run(); // id 1 re-usable
      api.createTicket({
        guildId: GUILD_A,
        creatorUserId: "560000000000000301",
        channelId: null,
        reason: "gate regen seed",
      });
      api.saveTicketMessages(1, [
        { message_id: "9001", author_id: "560000000000000301", content: "one", sent_at: 1 },
        { message_id: "9002", author_id: USER_SENIOR, content: "two", sent_at: 2 },
      ]);
    },
    details: D({ ticket_number: 1, source: "fallback", message_count: 2 }),
    okLocation: `/g/${GUILD_A}/tickets?done=summary_fallback`,
    reject: {
      // leading-zero id shape — parse-level refusal, zero facade calls
      status: 302,
      location: `/g/${GUILD_A}/tickets?error=invalid_ticket_id`,
      fields: { ticket_id: "01" },
    },
  },
];

// Rows flip to "PASS" only when the positive-path test completed (the full
// ladder ran for the row before it). Printed by the suite-G report.
for (const row of PARITY) row.status = "PENDING";

/**
 * AGENTS.md §4 tier classification DERIVED FROM THE TEMPLATE (no source
 * greps, no table lookup): staff-role mutations + command-channel add/remove
 * + honeypot exempt + the Phase-3 xp grant (ManageGuild-only /grantxp twin)
 * are admin; every other Phase-2 surface is staff. Cross-checked against the
 * table AND runtime behavior.
 */
function expectedTierFor(template) {
  if (
    template.startsWith("/g/:guildId/staff/role/") ||
    template.startsWith("/g/:guildId/settings/command-channels/") ||
    template.startsWith("/g/:guildId/integrations/honeypot/exempt/") ||
    template.startsWith("/g/:guildId/xp/grant")
  ) {
    return "admin";
  }
  // §8.6 "Tickets | Senior: claim/close/summary regen" (subtask 30) — the
  // web ticket mutations are SENIOR (a documented tightening vs the slash's
  // requireStaff gate; see routes/ticketActions.js header delta (1)).
  if (template.startsWith("/g/:guildId/tickets/")) {
    return "senior";
  }
  return "staff";
}

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

installMirrorSpy();

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

function writeCalls(log) {
  return log.filter((c) => WRITE_HELPERS.has(c.name));
}

const concretePath = (template, guild) => template.replace(":guildId", guild);

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

      const path = concretePath(row.template, GUILD_A);
      const crossPath = concretePath(row.template, GUILD_CROSS);
      // Senior-tier rows (ticket actions, subtask 30) run the positive path
      // AS the senior user; below-staff tiers keep the junior viewer.
      const viewer =
        row.tier === "admin" ? "admin" : row.tier === "senior" ? "senior" : "staff";
      const viewerUser =
        row.tier === "admin"
          ? USER_ADMIN
          : row.tier === "senior"
            ? USER_SENIOR
            : USER_STAFF;

      it("anon POST ⇒ 302 /auth/login?guild=<id> (guildScope answers before anything mutates)", async () => {
        await harness.runOutcome({
          base,
          url: path,
          method: "POST",
          cookieId: null,
          expect: harness.expectLoginRedirect(`/auth/login?guild=${GUILD_A}`),
        });
        evidence(row.template).anon = 302;
      });

      it("stranger session + VALID csrf ⇒ generic 404 bytes (never 403, §8.6)", async () => {
        const { res, body } = await post(path, {
          cookie: cookieOf.stranger,
          fields: { ...row.fields, _csrf: csrfOf.stranger },
        });
        assert.equal(res.status, 404);
        assert.equal(body, "Not found");
        assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
        evidence(row.template).stranger = 404;
      });

      it("in-guild plain member + VALID csrf ⇒ generic 404 (no-enumeration doctrine)", async () => {
        const { res, body } = await post(path, {
          cookie: cookieOf.plain,
          fields: { ...row.fields, _csrf: csrfOf.plain },
        });
        assert.equal(res.status, 404);
        assert.equal(body, "Not found");
        evidence(row.template).plain = 404;
      });

      it("cross-guild + VALID csrf ⇒ the SAME generic 404 bytes (never 403/302)", async () => {
        const { res, body } = await post(crossPath, {
          cookie: cookieOf[viewer],
          fields: { ...row.fields, _csrf: csrfOf[viewer] },
        });
        assert.equal(res.status, 404);
        assert.equal(body, "Not found");
        evidence(row.template).cross = 404;
      });

      if (row.tier === "admin") {
        it("wrong-tier: junior AND senior get the FIXED 403, no write, no audit (AGENTS.md §4)", async () => {
          const before = webAuditCount();
          for (const key of ["staff", "senior"]) {
            startWindow();
            const { res, body } = await post(path, {
              cookie: cookieOf[key],
              fields: { ...row.fields, _csrf: csrfOf[key] },
            });
            const calls = stopWindow();
            assert.equal(res.status, 403, `${key} on admin-tier ${row.template}`);
            assert.equal(body, "Forbidden");
            assert.equal(res.headers.get("cache-control"), "no-store");
            assert.deepEqual(writeCalls(calls), [], `${key} denial wrote nothing`);
            evidence(row.template)[key === "staff" ? "junior" : "senior"] = 403;
          }
          assert.equal(webAuditCount(), before, "tier denial audited nothing");
        });
      } else if (row.tier === "senior") {
        it("wrong-tier (senior surface): junior gets the FIXED 403 with ZERO writes/audits; admin is NOT tier-denied (§8.6 Tickets row)", async () => {
          // The documented tightening vs slash requireStaff: the WEB ticket
          // mutations are senior-only; junior keeps the read surfaces and
          // loses these writes (asserted HERE, per mutation).
          const before = webAuditCount();
          startWindow();
          const { res, body } = await post(path, {
            cookie: cookieOf.staff,
            fields: { ...row.fields, _csrf: csrfOf.staff },
          });
          const calls = stopWindow();
          assert.equal(res.status, 403, `junior on senior-tier ${row.template}`);
          assert.equal(body, "Forbidden");
          assert.equal(res.headers.get("cache-control"), "no-store");
          assert.deepEqual(writeCalls(calls), [], "junior denial wrote nothing");
          assert.equal(webAuditCount(), before, "junior denial audited nothing");
          evidence(row.template).junior = 403;
          const admin = await post(path, {
            cookie: cookieOf.admin,
            fields: { ...row.fields, _csrf: csrfOf.admin },
          });
          assert.notEqual(
            admin.res.status,
            403,
            `admin must not be tier-denied on senior-tier ${row.template}`
          );
        });
      } else {
        it("staff tier: senior is NOT tier-denied (403 ladder is vacuous below staff; §8.6)", async () => {
          // junior's pass-through is proven by the positive path below
          // (junior is the viewer there); senior proves the full ladder.
          const { res } = await post(path, {
            cookie: cookieOf.senior,
            fields: { ...row.fields, _csrf: csrfOf.senior },
          });
          assert.notEqual(
            res.status,
            403,
            `senior must not be 403 on staff-tier ${row.template}`
          );
          evidence(row.template).senior = res.status;
        });
      }

      it("missing _csrf ⇒ 403 'Forbidden'; zero facade calls; zero audit", async () => {
        const before = webAuditCount();
        startWindow();
        const { res, body } = await post(path, {
          cookie: cookieOf[viewer],
          fields: { ...row.fields },
        });
        const calls = stopWindow();
        assert.equal(res.status, 403);
        assert.equal(body, "Forbidden");
        assert.equal(webAuditCount(), before);
        assert.deepEqual(calls, [], "CSRF denial never reached the service layer");
      });

      it("tampered _csrf ⇒ 403; zero facade calls; zero audit", async () => {
        const before = webAuditCount();
        startWindow();
        const { res } = await post(path, {
          cookie: cookieOf[viewer],
          fields: { ...row.fields, _csrf: "f".repeat(64) },
        });
        const calls = stopWindow();
        assert.equal(res.status, 403);
        assert.equal(webAuditCount(), before);
        assert.deepEqual(calls, []);
      });

      it(`POSITIVE (identical body, valid csrf ⇒ replay passes): 302 PRG + helpers [${row.helpers.join(", ")}] + exactly ONE audit row '${row.action}'`, async () => {
        row.prepare();
        const before = webAuditCount();
        mirrorSpy.log.length = 0;
        startWindow();
        const { res, body, location } = await post(path, {
          cookie: cookieOf[viewer],
          fields: { ...row.fields, _csrf: csrfOf[viewer] },
        });
        const calls = stopWindow();
        await tick(); // let the fire-and-forget mirror dispatch run (§8.1-7)

        // PRG: success is a redirect to a FIXED Location, empty body.
        assert.equal(res.status, 302, `positive ${row.template}: status (body: ${body})`);
        assert.equal(location, row.okLocation);
        assert.equal(body, "");
        assert.equal(res.headers.get("cache-control"), "no-store");

        // SERVICE LAYER: the EXACT slash helper ran through the facade proxy.
        const names = calls.map((c) => c.name);
        for (const helper of row.helpers) {
          assert.ok(
            names.includes(helper),
            `${row.template}: web path must call the slash helper ${helper} (slash evidence: ${row.slash})`
          );
        }
        assert.ok(
          names.includes("insertAdminAudit"),
          `${row.template}: audit write happened through the facade`
        );

        // AUDIT: exactly one row, correct origin/action/guild/actor/target.
        assert.equal(webAuditCount(), before + 1, `${row.template}: exactly one admin_audit row`);
        const rows = webAuditRows().filter(
          (r) => r.action === row.action && r.target_id === row.targetId
        );
        const mine = rows.find((r) => r.actor_user_id === viewerUser);
        assert.ok(mine, `${row.template}: audit row '${row.action}' by the viewer`);
        assert.equal(mine.origin, "web");
        assert.equal(mine.guild_id, GUILD_A);
        assert.equal(mine.actor_user_id, viewerUser);
        assert.equal(mine.target_type, row.targetType);
        assert.deepEqual(
          mine.details,
          row.details(),
          `${row.template}: before/after detail shape (slash vocabulary)`
        );

        // MIRROR expectation (§8.1-7: embeds are mirrors — the DB row is truth).
        assert.equal(
          mirrorSpy.log.length,
          row.mirror ? 1 : 0,
          `${row.template}: mirror ${row.mirror ? "scheduled once" : "never scheduled"} (${JSON.stringify(mirrorSpy.log.map((m) => m.kind))})`
        );

        if (row.tier === "staff") evidence(row.template).junior = res.status;
        if (row.tier === "senior") evidence(row.template).senior = res.status;
        row.status = "PASS";
      });

      it(`REJECT (validation): ${row.reject.status === 400 ? "fixed 400 body" : "err-redirect slug"} · ZERO write-helper calls · ZERO audit`, async () => {
        row.prepare();
        const before = webAuditCount();
        startWindow();
        const { res, body, location } = await post(path, {
          cookie: cookieOf[viewer],
          fields: { ...row.reject.fields, _csrf: csrfOf[viewer] },
        });
        const calls = stopWindow();
        assert.equal(res.status, row.reject.status, `reject ${row.template}: ${body}`);
        if (row.reject.bodyMatch) {
          // Fixed 400 body rejections (staff routes) carry text/plain.
          assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
          assert.match(body, row.reject.bodyMatch);
        } else {
          // Err-redirect rejections are bodyless 302s — no content-type,
          // the SLUG is the contract (never a silent ok=).
          assert.equal(res.headers.get("content-type"), null);
          assert.equal(location, row.reject.location);
          assert.equal(body, "");
        }
        assert.deepEqual(
          writeCalls(calls),
          [],
          `${row.template}: validation rejection wrote via ZERO facade helpers (recorded: ${calls.map((c) => c.name).join(",")})`
        );
        assert.equal(webAuditCount(), before, `${row.template}: validation rejection audited NOTHING`);
      });

      it("AUDIT-FAIL INJECTION ⇒ generic 500, outcome NOT silently claimed, no audit row, NO mirror (§8.1-7 fail-closed)", async () => {
        row.prepare();
        const before = webAuditCount();
        mirrorSpy.log.length = 0;
        recorder.auditThrow = true;
        const realError = console.error;
        console.error = () => {}; // the expected 500 logger ×32 is noise here
        let out;
        try {
          out = await post(path, {
            cookie: cookieOf[viewer],
            fields: { ...row.fields, _csrf: csrfOf[viewer] },
          });
          await tick();
        } finally {
          recorder.auditThrow = false;
          console.error = realError;
        }
        assert.equal(out.res.status, 500, `${row.template}: audit failure must 500`);
        assert.equal(out.body, "Internal error");
        assert.equal(
          out.location,
          null,
          `${row.template}: fail-closed ⇒ NO success redirect; the outcome is never silently claimed`
        );
        assert.equal(webAuditCount(), before, "the injected failure wrote no audit row");
        assert.equal(
          mirrorSpy.log.length,
          0,
          `${row.template}: a failed insert schedules NO channel mirror`
        );
      });
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
      "the admin-tier set equals {staff/role/*, command-channels/*, honeypot/exempt/*, xp/grant} — §4 (grantxp is ManageGuild-only)"
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
