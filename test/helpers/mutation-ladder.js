/**
 * Shared mutation-gate harness (subtask 27 → 32).
 *
 * Extracted VERBATIM from test/web-phase2-gate.test.js so the Phase-3
 * program gate (test/web-phase3-gate.test.js) runs the EXACT same
 * per-mutation acceptance ladder over the same 40-mutation matrix without
 * a second copy of the table or the ladder logic. This is a TEST-ONLY
 * helper (test/helpers/, never required by src/): moving the code here is
 * the single-source guarantee — the Phase-2 gate stays the historical
 * phase gate, the Phase-3 gate is the final program gate, and a ladder
 * semantics change can only exist in ONE place.
 *
 * Contents:
 *  - FIX ................ the shared snowflake-ish fixture ids + ENV_KEYS
 *  - FACADE_METHODS / WRITE_HELPERS / installFacadeRecorder / tick
 *  - installMirrorSpy ... audit-channel mirror spy (optional delegation)
 *  - expectedTierFor .... AGENTS.md §4 tier derivation FROM THE TEMPLATE
 *  - concretePath / D / writeCalls
 *  - makeFakeChannel / makeFakeDiscord / buildFakeCacheClient — offline
 *    discord.js-cache fakes (cache-ONLY seams; any network call in a
 *    request path throws as an unstubbed-method error)
 *  - buildPhase2Rows .... the 40-row PARITY matrix (the §8.8 checklist
 *     artifact — runtime registry is the ground truth both gates assert
 *     against; this factory returns fresh row objects per call)
 *  - buildLadderSteps ... the per-mutation acceptance ladder (anon ⇒ 302,
 *     stranger/plain/cross ⇒ generic 404, wrong-tier ⇒ fixed 403 with zero
 *     writes/audits, CSRF missing/tampered ⇒ 403, POSITIVE ⇒ PRG + slash
 *     helper + exactly one 'web' audit row + mirror expectation, REJECT ⇒
 *     zero writes/audits, AUDIT-FAIL INJECTION ⇒ generic 500 fail-closed)
 *     returned as [{ name, kind, fn }] so each gate wraps them in its own
 *     it() blocks (and keeps its own row.status flip + evidence bookkeeping
 *     through the ctx hooks).
 */

const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Shared fixtures (values identical to the Phase-2 gate — same file loaded
// into a fresh process per gate, so the ids never collide at runtime).
// ---------------------------------------------------------------------------

const FIX = {
  GUILD_A: "310000000000000001", // bot + every test user
  GUILD_CROSS: "310000000000000002", // bot guild the users are NOT in

  USER_ADMIN: "448190112345678901", // owner snapshot ⇒ tier admin
  USER_STAFF: "448190112345678902", // junior staff role ⇒ tier staff
  USER_SENIOR: "448190112345678903", // senior staff role ⇒ tier senior
  USER_PLAIN: "448190112345678904", // guild-A member, no staff role
  USER_STRANGER: "448190112345678905", // member of NOTHING

  // Tier-resolution roles (deliberately NOT snowflake-shaped so they can
  // never be confused with mutation subject ids — subtask 25 trick).
  ROLE_JUNIOR_TIER: "role-junior-staff",
  ROLE_SENIOR_TIER: "role-senior-staff",

  // Mutation subject ids (all PRESENT in the fake client cache).
  CH_AUDIT: "600000000000000111", // settings logs/audit, yt notify, event reminders
  CH_MESSAGE: "600000000000000112", // settings message stream, twitch notify, RR panels
  CH_WARN: "600000000000000113", // settings warn-log
  CH_CMD: "600000000000000114", // command-channels add/remove
  CH_HONEY: "600000000000000115", // honeypot channel add/del
  ROLE_STAFF: "500000000000000211", // staff role add/remove/setlevel
  ROLE_LEVEL: "500000000000000212", // levelrole set/remove
  ROLE_UPLOAD: "500000000000000213", // youtube uploadrole
  ROLE_TW: "500000000000000214", // twitch notify role
  ROLE_BAN: "500000000000000215", // honeypot banrole
  ROLE_EXEMPT: "500000000000000216", // honeypot exempt
  PANEL_MSG: "930000000000000001", // fake channel send() message id
  USER_GRANT: "448190112345678906", // xp.grant subject — cache-absent:
  // the grant exercises the slash's member-miss path (awardXp resolves no
  // member → role sync skipped), like a slash whose members.fetch fails.
  USER_WARN_SUBJECT: "448190112345678907", // warn issue/void + note subject
  // — likewise cache-absent: the mutations exercise the cache-only DM
  // seam's graceful-skip path (never a fetch on a request path).
  YT_ID: "UC0123456789012345678901", // /channel/ URL form parses this
  TW_ID: "420000001",
  TW_LOGIN: "gatestream",
  GATE_CHANNEL_NAME: "GATE-LIVE-CH-NAME-4f7c", // getClient-threading marker
};
FIX.YT_URL = `https://www.youtube.com/channel/${FIX.YT_ID}`;
FIX.BOT_GUILDS = [FIX.GUILD_A, FIX.GUILD_CROSS];

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
// Tier derivation (AGENTS.md §4 — FROM THE TEMPLATE, never a source grep)
// ---------------------------------------------------------------------------

/**
 * staff-role mutations + command-channel add/remove + honeypot exempt + the
 * Phase-3 xp grant (ManageGuild-only /grantxp twin) are ADMIN; every ticket
 * mutation is SENIOR (§8.6 tightening vs slash requireStaff); every other
 * surface is STAFF.
 * @param {string} template
 * @returns {"admin"|"senior"|"staff"}
 */
function expectedTierFor(template) {
  if (
    template.startsWith("/g/:guildId/staff/role/") ||
    template.startsWith("/g/:guildId/settings/command-channels/") ||
    template.startsWith("/g/:guildId/integrations/honeypot/exempt/") ||
    template.startsWith("/g/:guildId/xp/grant") ||
    // /staff syncpermissions is ManageGuild-ONLY (AGENTS.md §4) — the web
    // twin (subtask 31) inherits ADMIN with zero delta.
    template.startsWith("/g/:guildId/commands/sync")
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

/** @param {string} template @param {string} guild */
function concretePath(template, guild) {
  return template.replace(":guildId", guild);
}

/** Audit-details expectation factory (static deep-equal target per row). */
const D = (obj) => () => obj;

/**
 * DB-mutating facade helpers — validation rejections must call ZERO of these.
 * @type {ReadonlySet<string>}
 */
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

/** Every facade helper the counting proxy wraps (reads + writes + audit). */
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
  // (warnings/index.js:458|747, staffNotes/index.js:277); getStaffNote is
  // the issue-form note-link READ (routes/moderation.js parseWarnIssueInput).
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

/**
 * Install the SERVICE-LAYER counting proxy on the SHARED src/db facade
 * object. Every web route/data module resolves facade METHODS AT CALL TIME
 * on this object (settingsWrite DI, staff routes facade, integrations
 * module-level db === this object), so the wrappers here are what the
 * handlers actually call. The audit middleware captures
 * db.insertAdminAudit at createWebApp time — install BEFORE the app is
 * built; the throw-flag toggle then reaches the mounted middleware through
 * the captured wrapper.
 * @param {object} F the src/db facade module object
 * @param {{active: boolean, log: unknown[], auditThrow: boolean}} recorder
 * @returns {() => void} restore
 */
function installFacadeRecorder(F, recorder) {
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

/** @param {unknown[]} log */
function writeCalls(log) {
  return log.filter((c) => WRITE_HELPERS.has(c.name));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// ---------------------------------------------------------------------------
// Mirror spy (§8.1-7): the audit middleware dispatches mirrors through the
// REAL features/logs/auditLog module object (property resolves at dispatch
// time) with the bound client (boundAuditClient read at dispatch time).
// Swapping the two posters + binding a truthy fake proves per row whether a
// mirror WAS scheduled (settings/staff) or was NOT (integrations,
// fail-closed). With { delegate: true } the spy ALSO runs the original
// poster — capturing the REAL channel payload the embed lands in (used by
// the Phase-3 program gate's two-transport parity runs; the Phase-2 gate
// keeps the record-only spy semantics it always had).
// ---------------------------------------------------------------------------

/**
 * @param {object} auditLogMod require("src/features/logs/auditLog")
 * @param {(c: any) => void} bindAuditClient require("src/web/middleware/audit").bindAuditClient
 * @param {{ client?: any, delegate?: boolean }} [opts]
 * @returns {{ log: {kind: string, args: unknown[]}[], restore: () => void }}
 */
function installMirrorSpy(auditLogMod, bindAuditClient, opts = {}) {
  const spy = { log: [] };
  const origAudit = auditLogMod.sendAuditLog;
  const origWarn = auditLogMod.sendWarnLog;
  auditLogMod.sendAuditLog = (...args) => {
    spy.log.push({ kind: "audit", args });
    return opts.delegate ? origAudit(...args) : Promise.resolve(true);
  };
  auditLogMod.sendWarnLog = (...args) => {
    spy.log.push({ kind: "warn", args });
    return opts.delegate ? origWarn(...args) : Promise.resolve(true);
  };
  bindAuditClient(opts.client || { __gateFakeAuditClient: true });
  spy.restore = () => {
    auditLogMod.sendAuditLog = origAudit;
    auditLogMod.sendWarnLog = origWarn;
    bindAuditClient(null);
  };
  return spy;
}

// ---------------------------------------------------------------------------
// Offline discord.js-cache fakes
// ---------------------------------------------------------------------------

/**
 * Fake guild text channel: send() CAPTURES payloads on `.sent` (the
 * two-transport parity evidence), messages.fetch() replays canned message
 * rows, permissionOverwrites.create/edit record their calls — every write
 * path visible, nothing networked.
 * @param {string} id
 * @param {string} name
 * @param {{ messages?: unknown[] }} [opts]
 */
function makeFakeChannel(id, name, opts = {}) {
  const ch = {
    id,
    name,
    type: 0, // GUILD_TEXT — the /eventreminder picker types twin
    isTextBased: () => true,
    sent: [],
    overwriteCalls: [],
    send: async (...args) => {
      ch.sent.push(args.length === 1 ? args[0] : args);
      return { id: FIX.PANEL_MSG };
    },
    messages: {
      fetch: async () => {
        const rows = opts.messages || [];
        return {
          size: rows.length,
          values: () => rows[Symbol.iterator](),
        };
      },
    },
    permissionOverwrites: {
      // applyTicketOverwrites PREFERS .set (replace-set); create/edit are
      // the fallback path. All three RECORD so the parity runs can
      // deep-equal the outbound overwrite sequence.
      set: async (...args) => {
        ch.overwriteCalls.push({ op: "set", args });
        return true;
      },
      create: async (...args) => {
        ch.overwriteCalls.push({ op: "create", args });
        return true;
      },
      edit: async (...args) => {
        ch.overwriteCalls.push({ op: "edit", args });
        return true;
      },
    },
    delete: async () => true,
  };
  return ch;
}

/**
 * Fake Discord transport under the REAL createGuildAccessResolver (Phase-1
 * gate pattern). `extra` may override/extend the guild + member tables.
 * @param {object} [fixture] FIX (defaults to the shared fixture ids)
 */
function makeFakeDiscord(fixture = FIX) {
  const { GUILD_A, GUILD_CROSS, USER_ADMIN, USER_STAFF, USER_SENIOR, USER_PLAIN } =
    fixture;
  function userOf(token) {
    return String(token).replace(/^tok-/, "");
  }
  return {
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
      if (userId === USER_STAFF) return { roles: [fixture.ROLE_JUNIOR_TIER] };
      if (userId === USER_SENIOR) return { roles: [fixture.ROLE_SENIOR_TIER] };
      return { roles: [] }; // plain member: in the guild, NO staff role
    },
  };
}

/**
 * Build a CACHE-ONLY fake discord.js client. Any network call in a request
 * path surfaces as an unstubbed-method throw. Maps are plain objects with
 * get(); `members` and `users` accept live Maps so tests can insert/remove
 * cache entries mid-run (boot-wiring probes).
 * @param {object} spec
 * @param {string} spec.guildId
 * @param {string} [spec.guildName]
 * @param {Record<string, any>} spec.channelMap
 * @param {Record<string, any>} spec.roleMap
 * @param {Map<string, any>} [spec.members]
 * @param {Map<string, any>} [spec.users]
 * @param {string} [spec.botUserId]
 * @param {number} [spec.botPosition]
 */
function buildFakeCacheClient(spec) {
  const {
    guildId,
    guildName = "Alpha HQ",
    channelMap,
    roleMap,
    members = new Map(),
    users = new Map(),
    botUserId = "100000000000000001",
    botPosition = 100,
  } = spec;
  const botMember = {
    id: botUserId,
    roles: { highest: { position: botPosition }, cache: new Map() },
  };
  members.set(botUserId, botMember);
  const fakeGuild = {
    id: guildId,
    name: guildName,
    roles: { cache: { get: (rid) => roleMap[rid] } },
    channels: { cache: { get: (cid) => channelMap[cid] } },
    emojis: { cache: { get: () => undefined } },
    members: {
      me: botMember,
      cache: { get: (id) => members.get(id) },
      // awardXp's level-role step resolves the subject through
      // guild.members.fetch (services/awardXp.js:46, .catch(()=>null)):
      // cache hit ⇒ member, miss ⇒ 404-shaped rejection (real discord.js
      // semantics). Additive: Phase-2 never exercises this path.
      fetch: async (id) => {
        const m = members.get(id);
        if (m) return m;
        const err = new Error("Unknown Member (gate cache-only fake)");
        err.code = err.status = 50035; // discord.js UnknownMember
        throw err;
      },
    },
    me: botMember, // guild.members.me shortcut (close.js resolveBotMember)
  };
  // channel.guild back-reference (overwrites.js: `opts.guild || channel
  // .guild`) — the fake channels live INSIDE this guild.
  for (const ch of Object.values(channelMap)) {
    if (ch && typeof ch === "object" && !ch.guild) ch.guild = fakeGuild;
  }
  return {
    user: { id: botUserId },
    guilds: { cache: { get: (gid) => (gid === guildId ? fakeGuild : undefined) } },
    channels: {
      cache: { get: (id) => channelMap[id] },
      // auditLog#resolveLogChannel resolves log streams via
      // channels.FETCH (not cache.get) — cache-only answers so the real
      // posters actually post in-gate; unknown ids ⇒ null (same outcome
      // as a cold-cache miss, never a network call).
      fetch: async (id) => channelMap[id] ?? null,
    },
    users: { cache: { get: (id) => users.get(id) } },
    __maps: { members, users },
    __guild: fakeGuild,
  };
}

// ---------------------------------------------------------------------------
// THE PARITY MATRIX — the §8.8 checklist artifact (extracted VERBATIM from
// the Phase-2 gate; runtime app.locals.webMutations is the ground truth
// BOTH gates cross-check against in both directions).
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {any} deps.api the loaded db facade (loadDb() return)
 * @param {(table: string) => void} deps.purgeAutoincrement deterministic
 *   AUTOINCREMENT reset (DELETE + sqlite_sequence row) — Phase-3 rows need
 *   the sequence reset, not just the delete
 * @returns {any[]} fresh row objects (mutate status/evidence locally per gate)
 */
function buildPhase2Rows({ api, purgeAutoincrement }) {
  const F = FIX;
  return [
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
      targetId: F.GUILD_A,
      mirror: true,
      // Form field name is "message" — buildXpPatch maps it to the msg_xp
      // COLUMN (settingsWrite.js:151), exactly like /setxp message <n>.
      fields: { message: "17" },
      prepare: () => api.updateGuildSettings(F.GUILD_A, { msg_xp: 11 }),
      details: D({ patch: { msg_xp: 17 } }),
      okLocation: `/g/${F.GUILD_A}/settings?ok=xp`,
      reject: { status: 302, location: `/g/${F.GUILD_A}/settings?err=xp`, fields: {} },
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
      targetId: F.GUILD_A,
      mirror: true,
      fields: { percent: "25" },
      prepare: () => api.updateGuildSettings(F.GUILD_A, { decay_percent: 0.5 }),
      details: D({ patch: { decay_percent: 0.25 } }),
      okLocation: `/g/${F.GUILD_A}/settings?ok=decay`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/settings?err=decay`,
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
      targetId: F.CH_AUDIT,
      mirror: true,
      fields: { stream: "audit", channel: F.CH_AUDIT },
      prepare: () => api.updateGuildSettings(F.GUILD_A, { audit_log_channel_id: null }),
      details: D({ stream: "audit", previous_channel_id: null }),
      okLocation: `/g/${F.GUILD_A}/settings?ok=logs`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/settings?err=logs`,
        fields: { stream: "bogus", channel: F.CH_AUDIT },
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
      targetId: F.CH_WARN,
      mirror: true,
      fields: { channel: F.CH_WARN },
      prepare: () => api.updateGuildSettings(F.GUILD_A, { warn_log_channel_id: null }),
      details: D({ previous_channel_id: null, channel_id: F.CH_WARN }),
      okLocation: `/g/${F.GUILD_A}/settings?ok=warn`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/settings?err=warn`,
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
      targetId: F.CH_CMD,
      mirror: true,
      fields: { channel: F.CH_CMD },
      prepare: () => api.removeAllowedCommandChannel(F.GUILD_A, F.CH_CMD),
      details: D({ channel_id: F.CH_CMD }),
      okLocation: `/g/${F.GUILD_A}/settings?ok=channels`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/settings?err=channels`,
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
      targetId: F.CH_CMD,
      mirror: true,
      fields: { channel: F.CH_CMD },
      prepare: () => api.addAllowedCommandChannel(F.GUILD_A, F.CH_CMD),
      details: D({ channel_id: F.CH_CMD }),
      okLocation: `/g/${F.GUILD_A}/settings?ok=channels`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/settings?err=channels`,
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
      targetId: F.ROLE_STAFF,
      mirror: true,
      fields: { role_id: F.ROLE_STAFF, level: "junior" },
      prepare: () => api.removeStaffRole(F.GUILD_A, F.ROLE_STAFF),
      details: D({ level: "junior", previous_level: null }),
      okLocation: `/g/${F.GUILD_A}/staff`,
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
      targetId: F.ROLE_STAFF,
      mirror: true,
      fields: { role_id: F.ROLE_STAFF },
      prepare: () => api.addStaffRole(F.GUILD_A, F.ROLE_STAFF, "senior"),
      details: D({ previous_level: "senior" }),
      okLocation: `/g/${F.GUILD_A}/staff`,
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
      targetId: F.ROLE_STAFF,
      mirror: true,
      fields: { role_id: F.ROLE_STAFF, level: "senior" },
      prepare: () => {
        api.removeStaffRole(F.GUILD_A, F.ROLE_STAFF);
        api.addStaffRole(F.GUILD_A, F.ROLE_STAFF, "junior");
      },
      details: D({ previous_level: "junior", level: "senior" }),
      okLocation: `/g/${F.GUILD_A}/staff`,
      reject: {
        status: 400,
        bodyMatch: /invalid staff level/i,
        fields: { role_id: F.ROLE_STAFF, level: "boss" },
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
      targetId: F.ROLE_LEVEL,
      mirror: true,
      fields: { role_id: F.ROLE_LEVEL, level: "5", drop_days: "2" },
      prepare: () => api.deleteLevelRole(F.GUILD_A, F.ROLE_LEVEL),
      details: D({ level_required: 5, drop_grace_days: 2 }),
      okLocation: `/g/${F.GUILD_A}/staff`,
      reject: {
        status: 400,
        bodyMatch: /invalid number/i,
        fields: { role_id: F.ROLE_LEVEL, level: "1.5", drop_days: "0" },
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
      targetId: F.ROLE_LEVEL,
      mirror: true,
      fields: { role_id: F.ROLE_LEVEL },
      prepare: () => api.upsertLevelRole(F.GUILD_A, F.ROLE_LEVEL, 3, 1),
      details: D(null), // slash /leveltorole remove writes NO details
      okLocation: `/g/${F.GUILD_A}/staff`,
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
      targetId: F.YT_ID,
      mirror: false,
      fields: { url: F.YT_URL },
      prepare: () => api.removeYoutubeChannel(F.GUILD_A, F.YT_ID),
      details: D({ channel_name: `Channel ID: ${F.YT_ID}`, url: F.YT_URL }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=yt_added`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=missing_field`,
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
      targetId: F.YT_ID,
      mirror: false,
      fields: { channel_id: F.YT_ID },
      prepare: () => {
        api.removeYoutubeChannel(F.GUILD_A, F.YT_ID);
        api.addYoutubeChannel(F.GUILD_A, F.YT_ID, "Gate Tube", "https://youtu.be/seed", "");
      },
      details: D({ channel_name: "Gate Tube" }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=yt_removed`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=missing_field`,
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
      targetId: F.CH_AUDIT,
      mirror: false,
      fields: { channel_id: F.CH_AUDIT },
      prepare: () => api.updateGuildSettings(F.GUILD_A, { youtube_notification_channel_id: null }),
      details: D({ previous_channel_id: null }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=yt_channel_set`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_channel_id`,
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
      targetId: F.GUILD_A,
      mirror: false,
      fields: { minutes: "15" },
      // Column is INTEGER NOT NULL DEFAULT 5 — seed the DEFAULT (web never
      // nulls an interval); details prove previous_minutes is the OLD value.
      prepare: () => api.updateGuildSettings(F.GUILD_A, { youtube_polling_interval_minutes: 5 }),
      details: D({ previous_minutes: 5, minutes: 15 }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=yt_interval_set`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_interval`,
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
      targetId: F.ROLE_UPLOAD,
      mirror: false,
      fields: { role_id: F.ROLE_UPLOAD },
      prepare: () => api.updateGuildSettings(F.GUILD_A, { youtube_upload_role_id: null }),
      details: D({ role_id: F.ROLE_UPLOAD, previous_role_id: null }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=yt_upload_role_set`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_role_id`,
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
      targetId: F.TW_ID,
      mirror: false,
      fields: { login: F.TW_LOGIN },
      prepare: () => api.removeTwitchChannel(F.GUILD_A, F.TW_LOGIN),
      details: D({ login: F.TW_LOGIN, display_name: "Gate Stream" }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=tw_added`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=missing_field`,
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
      targetId: F.TW_ID,
      mirror: false,
      fields: { channel: F.TW_LOGIN },
      prepare: () => api.addTwitchChannel(F.GUILD_A, F.TW_ID, F.TW_LOGIN, "Gate Stream", ""),
      details: D({ login: F.TW_LOGIN, display_name: "Gate Stream" }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=tw_removed`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=missing_field`,
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
      targetId: F.CH_MESSAGE,
      mirror: false,
      fields: { channel_id: F.CH_MESSAGE },
      prepare: () => api.updateGuildSettings(F.GUILD_A, { twitch_notification_channel_id: null }),
      details: D({ previous_channel_id: null }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=tw_channel_set`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_channel_id`,
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
      targetId: F.ROLE_TW,
      mirror: false,
      fields: { role_id: F.ROLE_TW },
      prepare: () => api.updateGuildSettings(F.GUILD_A, { twitch_notify_role_id: null }),
      details: D({ role_id: F.ROLE_TW, previous_role_id: null }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=tw_role_set`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_role_id`,
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
      targetId: F.GUILD_A,
      mirror: false,
      fields: { minutes: "20" },
      // Column is INTEGER NOT NULL DEFAULT 2 — seed the DEFAULT.
      prepare: () => api.updateGuildSettings(F.GUILD_A, { twitch_polling_interval_minutes: 2 }),
      details: D({ previous_minutes: 2, minutes: 20 }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=tw_interval_set`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_interval`,
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
      targetId: F.PANEL_MSG,
      mirror: false,
      fields: { channel_id: F.CH_MESSAGE, title: "Gate Panel", description: "react to get roles" },
      prepare: () => api.deleteReactionRolePanel(F.GUILD_A, F.PANEL_MSG),
      details: D({ channel_id: F.CH_MESSAGE, title: "Gate Panel" }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=rr_panel_created`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_channel_id`,
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
      targetId: F.PANEL_MSG,
      mirror: false,
      fields: { message_id: F.PANEL_MSG },
      prepare: () => {
        api.deleteReactionRolePanel(F.GUILD_A, F.PANEL_MSG);
        api.createReactionRolePanel(F.GUILD_A, F.CH_MESSAGE, F.PANEL_MSG, "Gate Panel", "d");
      },
      details: D({ channel_id: F.CH_MESSAGE }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=rr_panel_deleted`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_message_id`,
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
      targetId: F.PANEL_MSG,
      mirror: false,
      fields: { message_id: F.PANEL_MSG, role_id: F.ROLE_STAFF, emoji: "👍", level: "0" },
      prepare: () => {
        api.deleteReactionRolePanel(F.GUILD_A, F.PANEL_MSG);
        api.createReactionRolePanel(F.GUILD_A, F.CH_MESSAGE, F.PANEL_MSG, "Gate Panel", "d");
      },
      details: D({ role_id: F.ROLE_STAFF, emoji: "👍", min_level: 0, removable: 1 }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=rr_option_added`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=rr_emoji_invalid`,
        fields: { message_id: F.PANEL_MSG, role_id: F.ROLE_STAFF, emoji: "<broken>" },
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
      targetId: F.PANEL_MSG,
      mirror: false,
      fields: { message_id: F.PANEL_MSG, emoji: "👍" },
      prepare: () => {
        api.deleteReactionRolePanel(F.GUILD_A, F.PANEL_MSG);
        api.createReactionRolePanel(F.GUILD_A, F.CH_MESSAGE, F.PANEL_MSG, "Gate Panel", "d");
        api.upsertReactionRoleOption(F.GUILD_A, F.PANEL_MSG, "👍", "👍", F.ROLE_STAFF, 0, true);
      },
      details: D({ emoji: "👍" }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=rr_option_removed`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=rr_emoji_invalid`,
        fields: { message_id: F.PANEL_MSG, emoji: "<broken>" },
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
      targetId: F.GUILD_A,
      mirror: false,
      fields: { channel_id: F.CH_AUDIT },
      prepare: () => api.updateGuildSettings(F.GUILD_A, { event_reminder_channel_id: null }),
      details: D({ channel_id: F.CH_AUDIT }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=er_channel_set`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_channel_id`,
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
      targetId: F.CH_HONEY,
      mirror: false,
      fields: { channel_id: F.CH_HONEY },
      prepare: () => api.removeHoneypotChannel(F.GUILD_A, F.CH_HONEY),
      details: D(null),
      okLocation: `/g/${F.GUILD_A}/integrations?done=hp_channel_added`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_channel_id`,
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
      targetId: F.CH_HONEY,
      mirror: false,
      fields: { channel_id: F.CH_HONEY },
      prepare: () => api.addHoneypotChannel(F.GUILD_A, F.CH_HONEY),
      details: D(null),
      okLocation: `/g/${F.GUILD_A}/integrations?done=hp_channel_removed`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_channel_id`,
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
      targetId: F.ROLE_BAN,
      mirror: false,
      fields: { role_id: F.ROLE_BAN },
      prepare: () => api.removeHoneypotBanRole(F.GUILD_A, F.ROLE_BAN),
      details: D(null),
      okLocation: `/g/${F.GUILD_A}/integrations?done=hp_banrole_added`,
      reject: {
        // @everyone twin (role id === guild id) — arithmetic refusal, zero writes
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=hp_role_everyone`,
        fields: { role_id: F.GUILD_A },
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
      targetId: F.ROLE_BAN,
      mirror: false,
      fields: { role_id: F.ROLE_BAN },
      prepare: () => api.addHoneypotBanRole(F.GUILD_A, F.ROLE_BAN),
      details: D(null),
      okLocation: `/g/${F.GUILD_A}/integrations?done=hp_banrole_removed`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_role_id`,
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
      targetId: F.ROLE_EXEMPT,
      mirror: false,
      fields: { role_id: F.ROLE_EXEMPT },
      prepare: () => api.removeStaffRole(F.GUILD_A, F.ROLE_EXEMPT),
      details: D({ via: "honeypot.exempt" }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=hp_exempt_added`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_role_id`,
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
      targetId: F.ROLE_EXEMPT,
      mirror: false,
      fields: { role_id: F.ROLE_EXEMPT },
      prepare: () => api.addStaffRole(F.GUILD_A, F.ROLE_EXEMPT, "senior"),
      details: D({ via: "honeypot.exempt" }),
      okLocation: `/g/${F.GUILD_A}/integrations?done=hp_exempt_removed`,
      reject: {
        status: 302,
        location: `/g/${F.GUILD_A}/integrations?error=invalid_role_id`,
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
      targetId: F.USER_GRANT,
      mirror: true, // the slash posts logConfigChange "XP granted" (index.js:473)
      fields: { user_id: F.USER_GRANT, amount: "250", reason: "gate parity" },
      // Deterministic baseline: XP 0 → the audit's before/after is static.
      prepare: () => api.setXp(F.GUILD_A, F.USER_GRANT, 0),
      details: D({ amount: 250, before_xp: 0, after_xp: 250, reason: "gate parity" }),
      okLocation: `/g/${F.GUILD_A}/xp/grant?done=xp_granted`,
      reject: {
        // amount < 1 — the slash's explicit guard (index.js:439)
        status: 302,
        location: `/g/${F.GUILD_A}/xp/grant?error=invalid_amount`,
        fields: { user_id: F.USER_GRANT, amount: "0" },
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
      targetId: F.USER_WARN_SUBJECT,
      mirror: true, // kind "warn" — the slash's logWarnEvent (warn-log channel)
      fields: { user_id: F.USER_WARN_SUBJECT, reason: "gate warn reason" },
      // Deterministic details: AUTOINCREMENT reset ⇒ id/number 1; guild default
      // expiry 0 ⇒ expires_at NULL (the omitted-expires_days ≡ slash path).
      prepare: () => {
        purgeAutoincrement("warnings");
        api.updateGuildSettings(F.GUILD_A, { warn_expiry_days: 0 });
      },
      details: D({
        warning_id: 1,
        warning_number: 1,
        reason: "gate warn reason",
        expires_at: null,
        silent: false,
      }),
      okLocation: `/g/${F.GUILD_A}/warnings?done=warn_issued`,
      reject: {
        // malformed subject id — the route pre-validates, zero facade writes
        status: 302,
        location: `/g/${F.GUILD_A}/warnings?error=invalid_user`,
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
          guildId: F.GUILD_A,
          userId: F.USER_WARN_SUBJECT,
          issuerId: F.USER_ADMIN,
          reason: "seeded warning to void",
          expiresDays: 0,
        });
      },
      details: D({
        warning_number: 1,
        subject_user_id: F.USER_WARN_SUBJECT,
        void_reason: "gate void reason",
      }),
      okLocation: `/g/${F.GUILD_A}/warnings?done=warn_voided`,
      reject: {
        // warning_number must be a positive integer — pre-validated refusal
        status: 302,
        location: `/g/${F.GUILD_A}/warnings?error=invalid_warning_number`,
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
      fields: { user_id: F.USER_WARN_SUBJECT, content: "gate note text" },
      prepare: () => purgeAutoincrement("staff_notes"),
      // snippetNote(shortText, 500) is the identity here — slash detail shape
      // verbatim (features/staffNotes/index.js:348).
      details: D({
        note_number: 1,
        subject_user_id: F.USER_WARN_SUBJECT,
        content: "gate note text",
      }),
      okLocation: `/g/${F.GUILD_A}/notes?done=note_added`,
      reject: {
        // content > MAX_NOTE_CONTENT (2000) — the slash's maxLength option twin
        status: 302,
        location: `/g/${F.GUILD_A}/notes?error=content_too_long`,
        fields: { user_id: F.USER_WARN_SUBJECT, content: "x".repeat(2001) },
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
          guildId: F.GUILD_A,
          creatorUserId: "560000000000000301", // cache-absent requester (fake)
          channelId: null,
          reason: "gate claim seed",
        });
      },
      details: D({ ticket_number: 1, previous_owner: null, staff_owner_id: F.USER_SENIOR }),
      okLocation: `/g/${F.GUILD_A}/tickets?done=ticket_claimed`,
      reject: {
        // ticket_id field shape — refused BEFORE any facade call
        status: 302,
        location: `/g/${F.GUILD_A}/tickets?error=invalid_ticket_id`,
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
          guildId: F.GUILD_A,
          creatorUserId: "560000000000000301",
          channelId: null,
          reason: "gate close seed",
        });
      },
      details: D({ ticket_number: 1, close_reason: "gate close reason", status: "closed" }),
      okLocation: `/g/${F.GUILD_A}/tickets?done=ticket_closed`,
      reject: {
        // close-reason bound (MAX_TICKET_REASON = 1000) pre-validated — the
        // helper is NEVER invoked
        status: 302,
        location: `/g/${F.GUILD_A}/tickets?error=close_reason_too_long`,
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
        rawDelete("DELETE FROM ticket_messages"); // id 1 re-usable
        api.createTicket({
          guildId: F.GUILD_A,
          creatorUserId: "560000000000000301",
          channelId: null,
          reason: "gate regen seed",
        });
        api.saveTicketMessages(1, [
          { message_id: "9001", author_id: "560000000000000301", content: "one", sent_at: 1 },
          { message_id: "9002", author_id: F.USER_SENIOR, content: "two", sent_at: 2 },
        ]);
      },
      details: D({ ticket_number: 1, source: "fallback", message_count: 2 }),
      okLocation: `/g/${F.GUILD_A}/tickets?done=summary_fallback`,
      reject: {
        // leading-zero id shape — parse-level refusal, zero facade calls
        status: 302,
        location: `/g/${F.GUILD_A}/tickets?error=invalid_ticket_id`,
        fields: { ticket_id: "01" },
      },
    },
    // ---- Command visibility (subtask 31, Phase 3) — §8.6 "Command visibility:
    // sync status + trigger" row; the TRIGGER is ADMIN (slash /staff
    // syncpermissions is ManageGuild-ONLY per AGENTS.md §4 — no delta). The
    // sync itself runs behind the syncActions seam (the T3 doctrine): the gate
    // fakes ONLY the outbound Discord leg of the SHARED core
    // (runCommandVisibilitySync); every guard around it (tier ladder, CSRF,
    // return-target whitelist, fail-closed audit, PRG slugs) is REAL here. The
    // real core — real token store, real REST sequence, audit parity vs slash —
    // is pinned end-to-end in test/web-visibility-sync.test.js (patched
    // global.fetch, zero network).
    {
      no: "C1",
      area: "command visibility (sync trigger — Phase 3 action)",
      template: "/g/:guildId/commands/sync",
      method: "POST",
      tier: "admin",
      slash: "/staff syncpermissions → handleSyncPermissions → runCommandVisibilitySync → applyGuildCommandPermissions (src/features/staffRoles/index.js + features/commandPermissions/syncTrigger.js, audit via recordSlashAudit)",
      helpers: [], // the web twin touches NO facade helper besides the audit (seam replaces the Discord leg only; even the real core would list none)
      action: "staff.sync_permissions",
      targetType: "guild",
      targetId: F.GUILD_A,
      mirror: false, // the slash syncpermissions posts NO logConfigChange embed — parity = mirror nothing
      fields: { return: "staff" },
      prepare: () => {},
      details: D({ role_count: 2, commands_updated: 3 }),
      okLocation: `/g/${F.GUILD_A}/staff?done=sync_completed`,
      reject: {
        // `return` field whitelist — refused BEFORE the service runs, and the
        // redirect falls back to the DEFAULT surface (never the submitted value).
        status: 302,
        location: `/g/${F.GUILD_A}/commands?error=invalid_return`,
        fields: { return: "<bogus>" },
      },
    },
  ];
}

/**
 * Deterministic AUTOINCREMENT purge used by the Phase-3 rows' prepare().
 * DELETE alone cannot restore rowids (warnings.id / staff_notes.id are
 * `INTEGER PRIMARY KEY AUTOINCREMENT`), so the sqlite_sequence row is reset
 * too. Injected by the gate (raw connection access lives there); the T3 row
 * additionally clears ticket_messages through rawDelete.
 */

// ---------------------------------------------------------------------------
// The per-mutation acceptance ladder (extracted VERBATIM from the Phase-2
// gate's suite B — step names are part of the §8.8 living-doc contract).
// ---------------------------------------------------------------------------

/**
 * @param {any} row a PARITY row
 * @param {object} ctx gate-supplied mechanics:
 *   base, post(path, {cookie, fields}) → {res, body, location}, harness,
 *   cookieOf, csrfOf, startWindow, stopWindow, writeCalls, webAuditCount,
 *   webAuditRows, mirrorLog() → current spy log array, observe(template,
 *   key, status), tick, onSuccess({ row, kind }) (audit-row ledger hook —
 *   called once per SUCCESSFUL request whose audit row really landed),
 *   viewer + viewerUser MAY be overridden (defaults derive from tier)
 * @returns {{ name: string, kind: string, fn: () => Promise<void> }[]}
 */
function buildLadderSteps(row, ctx) {
  const {
    post,
    harness,
    cookieOf,
    csrfOf,
    startWindow,
    stopWindow,
    webAuditCount,
    webAuditRows,
    mirrorLog,
    observe = () => {},
    onSuccess = () => {},
    tick,
  } = ctx;
  // `base` is read AT STEP RUN TIME (ctx.base getter) — the gate's server
  // URL only exists after suite A's before() bound the ephemeral port.
  const path = concretePath(row.template, FIX.GUILD_A);
  const crossPath = concretePath(row.template, FIX.GUILD_CROSS);
  // Senior-tier rows (ticket actions, subtask 30) run the positive path
  // AS the senior user; below-staff tiers keep the junior viewer.
  const viewer =
    ctx.viewer || (row.tier === "admin" ? "admin" : row.tier === "senior" ? "senior" : "staff");
  const viewerUser =
    ctx.viewerUser ||
    (row.tier === "admin" ? FIX.USER_ADMIN : row.tier === "senior" ? FIX.USER_SENIOR : FIX.USER_STAFF);

  const steps = [];

  steps.push({
    name: "anon POST ⇒ 302 /auth/login?guild=<id> (guildScope answers before anything mutates)",
    kind: "anon",
    fn: async () => {
      await harness.runOutcome({
        base: ctx.base,
        url: path,
        method: "POST",
        cookieId: null,
        expect: harness.expectLoginRedirect(`/auth/login?guild=${FIX.GUILD_A}`),
      });
      observe(row.template, "anon", 302);
    },
  });

  steps.push({
    name: "stranger session + VALID csrf ⇒ generic 404 bytes (never 403, §8.6)",
    kind: "stranger",
    fn: async () => {
      const { res, body } = await post(path, {
        cookie: cookieOf.stranger,
        fields: { ...row.fields, _csrf: csrfOf.stranger },
      });
      assert404(res, body);
      observe(row.template, "stranger", 404);
    },
  });

  steps.push({
    name: "in-guild plain member + VALID csrf ⇒ generic 404 (no-enumeration doctrine)",
    kind: "plain",
    fn: async () => {
      const { res, body } = await post(path, {
        cookie: cookieOf.plain,
        fields: { ...row.fields, _csrf: csrfOf.plain },
      });
      assert404(res, body);
      observe(row.template, "plain", 404);
    },
  });

  steps.push({
    name: "cross-guild + VALID csrf ⇒ the SAME generic 404 bytes (never 403/302)",
    kind: "cross",
    fn: async () => {
      const { res, body } = await post(crossPath, {
        cookie: cookieOf[viewer],
        fields: { ...row.fields, _csrf: csrfOf[viewer] },
      });
      assert404(res, body);
      observe(row.template, "cross", 404);
    },
  });

  if (row.tier === "admin") {
    steps.push({
      name: "wrong-tier: junior AND senior get the FIXED 403, no write, no audit (AGENTS.md §4)",
      kind: "wrongTier",
      fn: async () => {
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
          observe(row.template, key === "staff" ? "junior" : "senior", 403);
        }
        assert.equal(webAuditCount(), before, "tier denial audited nothing");
      },
    });
  } else if (row.tier === "senior") {
    steps.push({
      name: "wrong-tier (senior surface): junior gets the FIXED 403 with ZERO writes/audits; admin is NOT tier-denied (§8.6 Tickets row)",
      kind: "wrongTier",
      fn: async () => {
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
        observe(row.template, "junior", 403);
        row.prepare(); // the admin pass-through below is a REAL run
        const admin = await post(path, {
          cookie: cookieOf.admin,
          fields: { ...row.fields, _csrf: csrfOf.admin },
        });
        assert.notEqual(
          admin.res.status,
          403,
          `admin must not be tier-denied on senior-tier ${row.template}`
        );
        if (admin.res.status === 302) {
          onSuccess({ row, kind: "admin-probe", actor: FIX.USER_ADMIN, origin: "web" });
        }
      },
    });
  } else {
    steps.push({
      name: "staff tier: senior is NOT tier-denied (403 ladder is vacuous below staff; §8.6)",
      kind: "wrongTier",
      fn: async () => {
        // junior's pass-through is proven by the positive path below
        // (junior is the viewer there); senior proves the full ladder.
        row.prepare(); // the senior pass-through below is a REAL run
        const { res } = await post(path, {
          cookie: cookieOf.senior,
          fields: { ...row.fields, _csrf: csrfOf.senior },
        });
        assert.notEqual(
          res.status,
          403,
          `senior must not be 403 on staff-tier ${row.template}`
        );
        observe(row.template, "senior", res.status);
        if (res.status === 302) {
          onSuccess({ row, kind: "senior-probe", actor: FIX.USER_SENIOR, origin: "web" });
        }
      },
    });
  }

  steps.push({
    name: "missing _csrf ⇒ 403 'Forbidden'; zero facade calls; zero audit",
    kind: "csrfMissing",
    fn: async () => {
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
    },
  });

  steps.push({
    name: "tampered _csrf ⇒ 403; zero facade calls; zero audit",
    kind: "csrfTampered",
    fn: async () => {
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
    },
  });

  steps.push({
    name: `POSITIVE (identical body, valid csrf ⇒ replay passes): 302 PRG + helpers [${row.helpers.join(", ")}] + exactly ONE audit row '${row.action}'`,
    kind: "positive",
    fn: async () => {
      row.prepare();
      const before = webAuditCount();
      mirrorLog().length = 0;
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
      assert.equal(mine.guild_id, FIX.GUILD_A);
      assert.equal(mine.actor_user_id, viewerUser);
      assert.equal(mine.target_type, row.targetType);
      assert.deepEqual(
        mine.details,
        row.details(),
        `${row.template}: before/after detail shape (slash vocabulary)`
      );

      // MIRROR expectation (§8.1-7: embeds are mirrors — the DB row is truth).
      assert.equal(
        mirrorLog().length,
        row.mirror ? 1 : 0,
        `${row.template}: mirror ${row.mirror ? "scheduled once" : "never scheduled"} (${JSON.stringify(mirrorLog().map((m) => m.kind))})`
      );

      if (row.tier === "staff") observe(row.template, "junior", res.status);
      if (row.tier === "senior") observe(row.template, "senior", res.status);
      onSuccess({ row, kind: "positive", actor: viewerUser, origin: "web" });
    },
  });

  steps.push({
    name: `REJECT (validation): ${row.reject.status === 400 ? "fixed 400 body" : "err-redirect slug"} · ZERO write-helper calls · ZERO audit`,
    kind: "reject",
    fn: async () => {
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
    },
  });

  steps.push({
    name: "AUDIT-FAIL INJECTION ⇒ generic 500, outcome NOT silently claimed, no audit row, NO mirror (§8.1-7 fail-closed)",
    kind: "failInject",
    fn: async () => {
      row.prepare();
      const before = webAuditCount();
      mirrorLog().length = 0;
      recorderThrow(true, ctx);
      const realError = console.error;
      console.error = () => {}; // the expected 500 logger is noise here
      let out;
      try {
        out = await post(path, {
          cookie: cookieOf[viewer],
          fields: { ...row.fields, _csrf: csrfOf[viewer] },
        });
        await tick();
      } finally {
        recorderThrow(false, ctx);
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
        mirrorLog().length,
        0,
        `${row.template}: a failed insert schedules NO channel mirror`
      );
    },
  });

  return steps;
}

// --- ladder internals -------------------------------------------------------

function assert404(res, body) {
  assert.equal(res.status, 404);
  assert.equal(body, "Not found");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
}

/** The auditThrow flag lives on the gate's recorder object (ctx.recorder). */
function recorderThrow(on, ctx) {
  if (!ctx.recorder) {
    throw new Error("ladder ctx must carry the recorder object for audit-fail injection");
  }
  ctx.recorder.auditThrow = on;
}

// rawDelete backs the T3 prepare's ticket_messages reset. Gates bind their
// raw sqlite handle once (bindRawDelete) right after loadDb(); the T3 row
// then behaves EXACTLY as the inline version did in the Phase-2 gate.
let rawDeleteFn = null;
/** Gates bind their raw sqlite handle once: bindRawDelete((sql) => rawDb.prepare(sql).run()). */
function bindRawDelete(fn) {
  rawDeleteFn = fn;
}
function rawDelete(sql) {
  if (!rawDeleteFn) {
    throw new Error("mutation-ladder: rawDelete not bound (gate must call bindRawDelete)");
  }
  rawDeleteFn(sql);
}

module.exports = {
  FIX,
  ENV_KEYS,
  expectedTierFor,
  concretePath,
  D,
  WRITE_HELPERS,
  FACADE_METHODS,
  installFacadeRecorder,
  writeCalls,
  tick,
  installMirrorSpy,
  makeFakeChannel,
  makeFakeDiscord,
  buildFakeCacheClient,
  buildPhase2Rows,
  buildLadderSteps,
  bindRawDelete,
};
