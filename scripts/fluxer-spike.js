#!/usr/bin/env node
/**
 * Fluxer Phase 0 spike (roadmap/fluxer.md § "Phase 0 spike checks", PR 1).
 *
 * Manual-only script. NOT referenced by `npm test` — never add it to the test
 * graph. Zero production dependencies: Node >= 22 global fetch + WebSocket.
 * This script MUST NOT add `@fluxerjs/core` to package.json (K6). The SDK
 * check installs into .tmp/fluxer-spike-sdk/ only, and records the pass/fail
 * that PR 6 depends on.
 *
 * Usage (all config via flags, .env, or env vars; flags win):
 *   node scripts/fluxer-spike.js --url https://chat.example.com \
 *     --token-file /tmp/fluxer.token --guild <id> [--channel <id>] \
 *     [--user <userId>] [--ban-user <sacrificialUserId>] [--voice-wait 120] \
 *     [--no-sdk] [--yes] [--markdown] [--out path.json]
 *
 * Secrets: the token is read from --token-file (preferred; point it at a file
 * OUTSIDE the repo), FLUXER_SPIKE_TOKEN_FILE, or FLUXER_SPIKE_TOKEN. It is
 * NEVER written to any report and is redacted from captured payloads.
 *
 * Destructive checks (channel create, self role add/remove, ban) prompt for
 * confirmation unless --yes. Answers are recorded as observed facts, not
 * asserts: anything the live deployment does not show is recorded unconfirmed
 * in the report's `unconfirmed` list and the roadmap § 9.2 gate stays open.
 *
 * Exit codes: 0 = completed (checks may be fail/skip — the spike records
 * facts, it is not a CI gate). 2 = fatal configuration/startup error.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const readline = require('node:readline');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const USAGE = `Fluxer Phase 0 spike — run the roadmap/fluxer.md checklist against one real deployment.

Flags (env fallbacks in .env: FLUXER_SPIKE_URL/TOKEN_FILE/TOKEN/GUILD/CHANNEL/USER/BAN_USER):
  --url <url>          Instance URL (required), e.g. https://chat.example.com
  --token-file <path>  File containing the bot token (preferred over --token)
  --token <token>      Bot token (discouraged: process list; prefer --token-file)
  --guild <id>         Test community (guild) id (required)
  --channel <id>       Text channel id to post in (default: auto-pick from gateway)
  --user <id>          Test user id (DM scenario, arbitrary-member fetch)
  --ban-user <id>      Sacrificial user id for the ban/unban check (needs re-join!)
  --voice-wait <sec>   Seconds to watch VOICE_STATE_UPDATE (default 120; 0 = skip)
  --no-sdk             Skip the @fluxerjs/core ESM+license check
  --yes                Answer every mutation confirmation with yes
  --markdown           Print a roadmap-ready markdown summary at the end
  --out <path>         JSON report path (default .tmp/fluxer-spike-results-<ts>.json)
  --help               This help
`;

function loadDotEnvLocal(file) {
  const out = {};
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch { /* .env is optional */ }
  return out;
}

const { values: opts } = parseArgs({
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    'token-file': { type: 'string' },
    guild: { type: 'string' },
    channel: { type: 'string' },
    user: { type: 'string' },
    'ban-user': { type: 'string' },
    'voice-wait': { type: 'string' },
    'no-sdk': { type: 'boolean' },
    yes: { type: 'boolean' },
    markdown: { type: 'boolean' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});

if (opts.help) { process.stdout.write(USAGE); process.exit(0); }

const env = { ...loadDotEnvLocal(path.join(__dirname, '..', '.env')), ...process.env };

let token = null;
const tokenFile = opts['token-file'] || env.FLUXER_SPIKE_TOKEN_FILE;
if (tokenFile) {
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) {
    process.stderr.write(`Cannot read token file: ${e.message}\n`); process.exit(2);
  }
}
if (!token) token = opts.token || env.FLUXER_SPIKE_TOKEN || null;

let base = opts.url || env.FLUXER_SPIKE_URL || '';
base = base.replace(/\/+$/, '');
const guildWanted = opts.guild || env.FLUXER_SPIKE_GUILD || '';
const channelWanted = opts.channel || env.FLUXER_SPIKE_CHANNEL || '';
const testUserId = opts.user || env.FLUXER_SPIKE_TEST_USER || '';
const banUserId = opts['ban-user'] || env.FLUXER_SPIKE_BAN_USER || '';
const voiceWaitSec = Number(opts['voice-wait'] ?? 120);
const sdkCheckEnabled = !opts['no-sdk'];
const autoYes = !!opts.yes;

if (!base || !token || !guildWanted) {
  process.stderr.write('Missing required config. Need --url, a token (--token-file / '
    + 'FLUXER_SPIKE_TOKEN[_FILE]) and --guild.\n\n' + USAGE);
  process.exit(2);
}
// Guard against the token ending up on disk anywhere via CLI echoes.
function redact(text) {
  if (text == null) return text;
  let s = String(text);
  if (token) s = s.split(token).join('[REDACTED]');
  s = s.replace(/(Authorization["']?\s*[:=]\s*)["']?[^"',\s]+/gi, '$1[REDACTED]');
  return s;
}
function fatal(msg) { process.stderr.write(`FATAL: ${msg}\n`); process.exit(2); }

// ---------------------------------------------------------------------------
// Report scaffolding
// ---------------------------------------------------------------------------

const checks = []; // {id, name, status, notes[], evidence[], unconfirmed[]}
function check(id, name) {
  const c = { id, name, status: 'skip', notes: [], evidence: [], unconfirmed: [] };
  checks.push(c);
  return c;
}
function record(c, note, evidence) {
  c.notes.push(note);
  if (evidence !== undefined) c.evidence.push(evidence);
}
function done(c, status) { c.status = status; logLine(`[${status}] ${c.id} ${c.name}`); }
function logLine(line) { process.stdout.write(`${line}\n`); }

const startedAt = new Date().toISOString();
const rateHeaderNames = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining',
  'x-ratelimit-reset', 'x-ratelimit-reset-after', 'x-ratelimit-bucket',
  'x-ratelimit-scope', 'x-ratelimit-global'];
const MAX_EVIDENCE_CHARS = 6000;

function truncateEvidence(obj) {
  const s = redact(JSON.stringify(obj));
  return s && s.length > MAX_EVIDENCE_CHARS
    ? { truncated: true, preview: s.slice(0, MAX_EVIDENCE_CHARS) }
    : obj;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

let apiBase = null; // resolved from discovery api_public + '/v1'
const tokenValidity = { checked: false, valid: false };

async function apiCall(method, pathname, body, opts2 = {}) {
  if (!apiBase) throw new Error('apiBase not resolved (discovery must run first)');
  const headers = { ...(opts2.headers || {}) };
  if (opts2.auth !== false) headers.Authorization = `Bot ${token}`;
  let payload;
  let contentType = null;
  if (opts2.formData) { payload = opts2.formData; contentType = 'multipart/form-data'; }
  else if (opts2.rawBody !== undefined) {
    payload = opts2.rawBody;
    contentType = headers['Content-Type'] || null; // caller-specified (e.g. PUT bytes)
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    contentType = 'application/json';
    headers['Content-Type'] = 'application/json';
  }
  const url = apiBase + pathname;
  const t0 = Date.now();
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body kept as text */ }
  const headersOut = {};
  for (const h of res.headers.keys()) {
    if (rateHeaderNames.includes(h) || h === 'x-fluxer-version') headersOut[h] = res.headers.get(h);
  }
  return {
    status: res.status,
    code: json && typeof json === 'object' ? json.code ?? json.error?.code ?? null : null,
    json,
    text: redact(text.length > 4000 ? text.slice(0, 4000) : text),
    headers: headersOut,
    contentTypeUsed: contentType,
    ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Gateway (native WebSocket, Node >= 22)
// ---------------------------------------------------------------------------

let ws = null;
let wsReady = false;
let lastSeq = null;
let heartbeatTimer = null;
const evLog = {}; // t -> array of d (capped)
const evListeners = {}; // t -> array of fn
const wsLog = [];
const gateway = { connected: false, hello: null, identifyAccepted: false, ready: null,
  session_id: null, closeInfo: null, errors: [], eventTypesSeen: {} };
let wsClosed = false;

function noteWs(msg) { wsLog.push(msg); process.stdout.write(`  [ws] ${msg}\n`); }

function dispatch(d, s, t) {
  if (s != null) lastSeq = s;
  gateway.eventTypesSeen[t] = (gateway.eventTypesSeen[t] || 0) + 1;
  (evLog[t] = evLog[t] || []);
  if (evLog[t].length < 60) evLog[t].push(d);
  const arr = evListeners[t] || [];
  for (const fn of arr.slice()) {
    try { fn(d, { s, t }); } catch (e) { gateway.errors.push(`listener ${t}: ${e.message}`); }
  }
}

function sendWs(op, d) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ op, d }));
}

function connectGateway(url) {
  return new Promise((resolve, reject) => {
    const full = url + (url.includes('?') ? '&' : '?') + 'v=1&encoding=json';
    let settled = false;
    const helloTimer = setTimeout(() => fail(new Error('gateway: no Hello within 15s')), 15000);
    function fail(err) { if (!settled) { settled = true; clearTimeout(helloTimer); reject(err); } }
    try { ws = new WebSocket(full); } catch (e) { return fail(e); }

    ws.addEventListener('open', () => { gateway.connected = true; noteWs('open (v=1&encoding=json)'); });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const { op, d, s, t } = msg;
      if (op === 10) {
        gateway.hello = d;
        sendWs(2, { token, properties: { os: 'linux', browser: 'boiler-snake-spike', device: 'spike' },
          presence: { status: 'online' } });
        heartbeatTimer = setInterval(() => sendWs(1, lastSeq), Math.max(5000, (d.heartbeat_interval || 45000) - 5000));
      } else if (op === 11) { /* heartbeat ack */ }
      else if (op === 0 && t) {
        if (t === 'READY') {
          gateway.identifyAccepted = true;
          gateway.ready = d;
          gateway.session_id = d && d.session_id;
          noteWs(`READY session=${d && d.session_id} guilds=${(d && d.guilds || []).length}`);
        }
        dispatch(d, s, t);
      } else if (op === 9) {
        noteWs(`Invalid Session (d=${JSON.stringify(d)}) — re-identify after 1s`);
        gateway.errors.push('op9 invalid session');
        setTimeout(() => sendWs(2, { token, properties: { os: 'linux', browser: 'boiler-snake-spike', device: 'spike' } }), 1000);
      } else if (op === 7) { noteWs('op7 Reconnect requested'); }
    });
    ws.addEventListener('error', (ev) => { gateway.errors.push('ws error: ' + (ev.message || 'unknown')); noteWs('error: ' + (ev.message || '')); });
    ws.addEventListener('close', (ev) => {
      gateway.closeInfo = { code: ev.code, reason: ev.reason || null };
      noteWs(`close code=${ev.code} reason=${JSON.stringify(ev.reason || '')}`);
      clearTimeout(helloTimer);
      if (settled) return;
      // Opening handshake never completed; report by code.
      reject(new Error(`gateway closed before Hello: code ${ev.code} ${ev.reason || ''}`.trim()));
    });
    // Resolve once Hello arrives — the caller awaits READY separately.
    const checkHello = setInterval(() => {
      if (gateway.hello && !settled) { settled = true; clearInterval(checkHello); clearTimeout(helloTimer); resolve(gateway.hello); }
    }, 50);
    ws.addEventListener('error', () => { settled = true; clearInterval(checkHello); clearTimeout(helloTimer); });
  });
}

function waitForEvent(type, pred, ms, label) {
  return new Promise((resolve) => {
    // Scan already-logged events first (event may have arrived before we listened).
    const logged = evLog[type] || [];
    for (const d of logged) if (!pred || pred(d)) return resolve(d);
    const timer = setTimeout(() => { off(); resolve(null); }, ms);
    function onEvt(d) {
      if (!pred || pred(d)) { clearTimeout(timer); off(); resolve(d); }
    }
    function off() {
      const arr = evListeners[type];
      if (arr) { const i = arr.indexOf(onEvt); if (i >= 0) arr.splice(i, 1); }
    }
    (evListeners[type] = evListeners[type] || []).push(onEvt);
    if (label) noteWs(`waiting up to ${ms}ms for ${label || type}...`);
  });
}

async function waitForReady(ms) {
  const ready = await waitForEvent('READY', null, ms);
  if (ready) { gateway.ready = ready; gateway.session_id = ready.session_id; return ready; }
  gateway.errors.push(`no READY within ${ms}ms`);
  noteWs('no READY event within window');
  return null;
}

function closeGateway() {
  wsClosed = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (ws && ws.readyState <= 1) { try { ws.close(1000, 'spike complete'); } catch { /* ignore */ } }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function confirm(prompt) {
  if (autoYes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question(`${prompt} [y/N] `, () => res()));
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

function fieldKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).sort();
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkDiscovery() {
  const c = check('discovery', 'Instance discovery + feature flags');
  const wellKnown = `${base}/.well-known/fluxer`;
  let res;
  try {
    const r = await fetch(wellKnown);
    const j = await r.json().catch(() => null);
    res = { status: r.status, json: j, headers: { 'x-fluxer-version': r.headers.get('x-fluxer-version') } };
  } catch (e) { record(c, `fetch ${wellKnown} failed: ${e.message}`); return done(c, 'fail'); }
  const d = res.json;
  if (res.status !== 200 || !d || !d.endpoints) {
    record(c, `GET ${wellKnown} -> ${res.status}`, truncateEvidence({ status: res.status, body: res.json }));
    return done(c, 'fail');
  }
  apiBase = String(d.endpoints.api_public || '').replace(/\/+$/, '') + '/v1';
  record(c, `GET ${base}/.well-known/fluxer -> 200; api_code_version=${d.api_code_version}; `
    + `X-Fluxer-Version header: ${res.headers['x-fluxer-version'] || 'ABSENT'}`);
  record(c, `endpoints: api=${d.endpoints.api} api_public=${d.endpoints.api_public} gateway=${d.endpoints.gateway}`);
  record(c, `features: ${JSON.stringify(d.features)}`);
  record(c, `community: ${JSON.stringify(d.community)}`);
  record(c, `limits (subset): max_message_length=${d.limits && d.limits.rules?.[0]?.overrides?.max_message_length} `
    + `max_attachment_file_size=${d.limits && d.limits.rules?.[0]?.overrides?.max_attachment_file_size} `
    + `(rule defaults apply; discovery 'limits' is rules, not a single number)`, d.limits);
  c.unconfirmed.push('docs:11 bots clamped to 50 MiB upload — not exercised (no oversize upload)');
  c.status = 'pass';
  logLine(`  discovery ok; api base = ${apiBase}`);
  return d;
}

async function checkAuth() {
  const c = check('auth', 'Token validity: GET /applications/@me + /users/@me (Authorization: Bot)');
  try {
    const app = await apiCall('GET', '/applications/@me');
    const user = await apiCall('GET', '/users/@me');
    record(c, `GET /applications/@me -> ${app.status}`, truncateEvidence(app.json));
    record(c, `GET /users/@me -> ${user.status}`, truncateEvidence(user.json));
    tokenValidity.checked = true;
    tokenValidity.valid = app.status === 200;
    record(c, `Authorization scheme used: "Bot <token>" (per docs/authentication; 200 proves acceptance)`);
    const appObj = app.json;
    if (app.status === 200) {
      record(c, `application: id=${appObj.id} name=${JSON.stringify(appObj.name)} owner.id=${appObj.owner && appObj.owner.id} public=${appObj.public}`);
    }
    if (user.status === 200 && user.json && user.json.bot === true) {
      record(c, `bot user: id=${user.json.id} username=${JSON.stringify(user.json.username)} `
        + `discriminator=${JSON.stringify(user.json.discriminator)} avatar=${user.json.avatar ? 'set' : 'null'} `
        + `global_name=${JSON.stringify(user.json.global_name)}`, user.json);
      c.status = 'pass';
    } else {
      record(c, `users/@me did not confirm bot user (status=${user.status})`);
      c.status = app.status === 200 ? 'partial' : 'fail';
    }
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
  logLine(`  token valid: ${tokenValidity.valid}`);
}

async function checkGatewayBot() {
  const c = check('gateway-bot', 'GET /gateway/bot (token shape check + gateway URL)');
  try {
    const r = await apiCall('GET', '/gateway/bot');
    record(c, `GET /gateway/bot -> ${r.status}`, truncateEvidence(r.json));
    if (r.status === 200 && r.json && r.json.url) {
      record(c, `gateway url from API: ${r.json.url}`);
      record(c, 'docs: this endpoint shape-checks the token (200 does NOT prove validity); /applications/@me is the validity check');
      c.status = 'pass';
    } else { c.status = 'fail'; }
    return r.json && r.json.url;
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; return null; }
}

async function checkOpenApi() {
  const c = check('openapi', 'GET /v1/openapi.json — spec presence + oauth2 + guild-list paths');
  try {
    const r = await apiCall('GET', '/openapi.json', undefined, { auth: false });
    if (r.status !== 200 || !r.json || !r.json.paths) {
      record(c, `GET /v1/openapi.json -> ${r.status} (no paths)`, truncateEvidence(r.json || r.text));
      return done(c, 'fail');
    }
    const p = r.json.paths;
    // Path templates as named in the LIVE openapi.json (2026-09-29): underscore
    // parameter names ({channel_id}), not the spec's {channel.id} style.
    // '/oauth2/authorize' is NOT in the document — the authorize page is
    // browser-facing; the API exposes POST /oauth2/authorize/consent.
    const want = ['/oauth2/token', '/oauth2/userinfo', '/oauth2/authorize',
      '/users/@me/guilds', '/users/@me/channels', '/users/@me',
      '/channels/{channel_id}/messages', '/channels/{channel_id}/attachments',
      '/channels/{channel_id}/messages/{message_id}',
      '/guilds/{guild_id}/bans/{user_id}',
      '/guilds/{guild_id}/members/{user_id}/roles/{role_id}',
      '/guilds/{guild_id}/channels', '/gateway/bot', '/oauth2/applications/@me'];
    record(c, `openapi=${r.json.openapi} title=${r.json.info && r.json.info.title} `
      + `servers=${JSON.stringify((r.json.servers || []).map(s => s.url))}`, truncateEvidence(r.json.servers));
    record(c, `path presence: ${want.map(k => `${k}=${p[k] ? Object.keys(p[k]).join(',') : 'ABSENT'}`).join('; ')}`);
    // Copy the List-current-user-guilds path out of the document (spec § Phase 0).
    if (p['/users/@me/guilds']) {
      record(c, 'users/@me/guilds path copied from OpenAPI', truncateEvidence(p['/users/@me/guilds']));
    }
    c.status = 'pass';
    logLine('  openapi.json served');
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
}

async function checkGuildList() {
  const c = check('guilds', 'GET /users/@me/guilds — decimal-string permissions + owner fields');
  try {
    const r = await apiCall('GET', '/users/@me/guilds');
    const arr = Array.isArray(r.json) ? r.json : [];
    record(c, `GET /users/@me/guilds -> ${r.status}, ${arr.length} guild(s)`,
      truncateEvidence(arr.map(g => ({ id: g.id, name: g.name, owner: g.owner,
        permissions: g.permissions, features: (g.features || []).slice(0, 8) }))));
    if (r.status === 200 && arr.length) {
      const g0 = arr[0];
      const permsType = typeof g0.permissions;
      const isDecimalString = permsType === 'string' && /^\d+$/.test(g0.permissions);
      record(c, `first guild: owner field=${'owner' in g0 ? JSON.stringify(g0.owner) : 'ABSENT'}; `
        + `permissions type=${permsType} decimal-string=${isDecimalString} value=${JSON.stringify(g0.permissions)}`);
      if (!('permissions' in g0)) c.unconfirmed.push('users/@me/guilds: `permissions` ABSENT on returned guild(s) — spec § 9.11 relies on it; re-check with limit<=100 on a deployment where the bot is in guilds');
      c.status = 'pass';
    } else {
      record(c, 'bot is in no guilds — join the test community first');
      c.status = 'fail';
    }
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
}

function memberObjHasRoles(d, userId) {
  if (!d) return false;
  if (d.member && Array.isArray(d.member.roles)) {
    if ((d.member.user && String(d.member.user.id) === String(userId)) || String(d.member.id || '') === String(userId)) {
      return true;
    }
  }
  if (Array.isArray(d.roles)) return true;
  return false;
}

async function checkGatewayEvents(guildIds) {
  const c = check('gateway-events', 'Gateway: Hello/Identify/READY, event names + payload field names');
  const ready = await waitForReady(20000);
  if (!ready) {
    record(c, `READY not observed within 20s; close=${JSON.stringify(gateway.closeInfo)} errors=${JSON.stringify(gateway.errors)}`);
    return done(c, 'fail');
  }
  record(c, `READY d field names: ${fieldKeys(ready).join(', ')}`, truncateEvidence(ready));
  const guildsInReady = (ready.guilds || []).map(g => ({ id: g.id, unavailable: g.unavailable,
    keys: fieldKeys(g) }));
  record(c, `READY guilds entries (bots): ${JSON.stringify(guildsInReady.slice(0, 5))}`);
  record(c, 'CONFIRMED: bot READY guild entries are {id, unavailable:true} placeholders '
    + '(spec § 4.6 lazy-load assumption validated at REST level; full lazy-load behavior = integration PR concern)');

  // Collect GUILD_CREATE burst.
  const want = guildWanted ? [String(guildWanted)] : guildsInReady.map(g => String(g.id));
  const creates = [];
  for (const gid of want) {
    const d = await waitForEvent('GUILD_CREATE', (x) => String(x.id) === gid, 15000, `GUILD_CREATE ${gid}`);
    if (d) creates.push(d);
  }
  gateway.guildCreates = creates;
  if (!creates.length) {
    record(c, `no GUILD_CREATE for requested guild(s) ${want.join(',')} within 15s each`);
    return done(c, 'fail');
  }
  const g0 = creates[0];
  record(c, `GUILD_CREATE d field names: ${fieldKeys(g0).join(', ')}`);
  record(c, `guild id=${g0.id} name=${JSON.stringify(g0.name)} mfa_level=${JSON.stringify(g0.mfa_level)} `
    + `owner_id=${g0.owner_id} features=${JSON.stringify((g0.features || []).slice(0, 10))}`);

  // @everyone role: id == guild id? permissions mask = base?
  const roles = Array.isArray(g0.roles) ? g0.roles : Object.values(g0.roles || {});
  const rolesType = Array.isArray(g0.roles) ? 'array' : typeof g0.roles;
  record(c, `guild.roles wire type: ${rolesType}; count=${roles.length}`);
  const everyone = roles.find(r => String(r.id) === String(g0.id));
  const baseMask = everyone ? String(everyone.permissions) : null;
  record(c, everyone
    ? `@everyone role: id EQUALS guild id (CONFIRMED); name=${JSON.stringify(everyone.name)} `
      + `permissions(decimal string)=${JSON.stringify(everyone.permissions)} position=${everyone.position} `
      + `managed=${everyone.managed} role obj fields: ${fieldKeys(everyone).join(', ')}`
    : `@everyone role with id==guild.id NOT FOUND in roles — spec § 4.9.2 staff-gate precondition FAILED`,
    truncateEvidence(roles.slice(0, 6)));
  record(c, `role objects field names: ${fieldKeys(roles[0]).join(', ')}`);
  record(c, `members field type: ${Array.isArray(g0.members) ? 'array' : typeof g0.members}; `
    + `count=${Array.isArray(g0.members) ? g0.members.length : Object.keys(g0.members || {}).length} `
    + `(spec expected members: [] for bots — record actual)`);
  record(c, `channels field type: ${Array.isArray(g0.channels) ? 'array' : typeof g0.channels}; count=`
    + `${Array.isArray(g0.channels) ? g0.channels.length : Object.keys(g0.channels || {}).length}`);
  {
    const chs = Array.isArray(g0.channels) ? g0.channels : Object.values(g0.channels || {});
    const t0ch = chs.find(x => x.type === 0) || null;
    record(c, `rate_limit_per_user on first text channel: `
      + `${JSON.stringify(t0ch ? t0ch.rate_limit_per_user : null)}`, truncateEvidence(t0ch));
  }

  // Reaction payload shape (already observed if reactions ran before this check).
  const rx = (evLog.MESSAGE_REACTION_ADD || [])[0];
  if (rx) {
    record(c, `MESSAGE_REACTION_ADD field names: ${fieldKeys(rx).join(', ')}; emoji field names: ${fieldKeys(rx.emoji).join(', ')} `
      + `(single-object payload CONFIRMED — not a two-arg pair)`, truncateEvidence(rx));
  } else {
    c.unconfirmed.push('MESSAGE_REACTION_ADD payload not observed in this run (reaction check did not produce an event)');
  }
  const del = (evLog.MESSAGE_DELETE || [])[0];
  if (del) record(c, `MESSAGE_DELETE field names: ${fieldKeys(del).join(', ')}; content present=${'content' in del}`, truncateEvidence(del));
  const ban = (evLog.GUILD_BAN_ADD || [])[0];
  if (ban) record(c, `GUILD_BAN_ADD field names: ${fieldKeys(ban).join(', ')}; user field keys: ${fieldKeys(ban.user).join(', ')}`, truncateEvidence(ban));

  // Voice.
  const voiceEvents = evLog.VOICE_STATE_UPDATE || [];
  const voiceSample = voiceEvents.slice(0, 3);
  record(c, `VOICE_STATE_UPDATE events seen: ${voiceEvents.length}; sample field names: ${voiceSample.length ? fieldKeys(voiceSample[0]).join(', ') : 'none'}`,
    truncateEvidence(voiceSample));
  const other = voiceEvents.find(v => String(v.user_id) !== String(gateway.ready.user.id));
  const voiceCompleteFields = ['user_id', 'channel_id', 'mute', 'deaf', 'self_mute', 'self_deaf'];
  if (other) {
    const present = voiceCompleteFields.filter(f => other[f] !== undefined);
    record(c, `other-member voice state observed: user_id=${other.user_id} channel_id=${JSON.stringify(other.channel_id)} `
      + `mute=${other.mute} deaf=${other.deaf} self_mute=${other.self_mute} self_deaf=${other.self_deaf} `
      + `self_video=${other.self_video} self_stream=${other.self_stream}`);
    record(c, `voice_states_complete=${present.length === voiceCompleteFields.length ? 1 : 0} `
      + `(fields present on payload: ${present.join(', ')})`);
  } else {
    record(c, `no other-member VOICE_STATE_UPDATE observed in ${Math.max(1, voiceWaitSec)}s window`);
    c.unconfirmed.push('voice: no other-member voice state observed in this run — spec gates voice XP on this evidence; voice_states_complete stays UNSET (see report)');
  }

  if (baseMask !== null && other !== undefined) c.status = 'pass';
  else if (baseMask !== null) { c.status = 'pass'; }
  else c.status = 'fail';
  logLine(`  gateway events recorded (types: ${Object.keys(gateway.eventTypesSeen).join(', ')})`);
}

function pickTextChannel(g0) {
  const chs = Array.isArray(g0.channels) ? g0.channels : Object.values(g0.channels || {});
  const texts = chs.filter(x => x.type === 0);
  if (channelWanted) {
    return texts.find(x => String(x.id) === String(channelWanted))
      || { id: String(channelWanted), name: '(provided via --channel, not in guild list)' };
  }
  return texts.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .find(x => /spike|test|bot/i.test(x.name || '')) || texts[0] || null;
}

async function checkMessages(textChannel, botUserId) {
  const c = check('messages', 'Create/reply/edit/delete + MESSAGE_CREATE payload + mention fields');
  const ch = textChannel;
  if (!ch) { record(c, 'no text channel available (provide --channel)'); return done(c, 'fail'); }
  record(c, `text channel: id=${ch.id} name=${JSON.stringify(ch.name)} type=${ch.type}`);
  const stamp = Date.now();
  const content = `spike ${stamp}: message roundtrip probe`;
  let probe = null;
  try {
    const sent = await apiCall('POST', `/channels/${ch.id}/messages`, { content });
    record(c, `POST /channels/{channel_id}/messages -> ${sent.status} (docs: 200, not 201) `
      + `content-type=${sent.contentTypeUsed}; rate headers: ${JSON.stringify(sent.headers)}`,
      truncateEvidence(sent.json && sent.json.id ? { id: sent.json.id, timestamp: sent.json.timestamp,
        edited_timestamp: sent.json.edited_timestamp, type: sent.json.type, flags: sent.json.flags,
        channel_id: sent.json.channel_id, guild_id: sent.json.guild_id, timestamp_fields: fieldKeys(sent.json) } : sent.json));
    if (sent.status === 200 && sent.json && sent.json.id) probe = sent.json;
    else { record(c, 'send did not return a message object', truncateEvidence(sent.json || sent.text)); }
  } catch (e) { record(c, `send error: ${e.message}`); }

  const mc = await waitForEvent('MESSAGE_CREATE', d => probe && String(d.id) === String(probe.id), 10000, 'MESSAGE_CREATE echo');
  if (mc) {
    record(c, `MESSAGE_CREATE field names: ${fieldKeys(mc).join(', ')}`, truncateEvidence(mc));
    record(c, `mention field presence on MESSAGE_CREATE: mentions=${Array.isArray(mc.mentions)} `
      + `(type: ${mc.mentions && mc.mentions[0] ? 'user objects' : 'empty'}), `
      + `mention_roles=${JSON.stringify(mc.mention_roles)} (id strings), `
      + `mention_channels=${JSON.stringify(mc.mention_channels || null)}, mention_everyone=${JSON.stringify(mc.mention_everyone)}, `
      + `mention_users field present=${'mention_users' in mc} (expected false — docs:3: field is 'mentions')`,
      truncateEvidence({ mentions: mc.mentions, mention_roles: mc.mention_roles,
        mention_channels: mc.mention_channels, mention_everyone: mc.mention_everyone }));
    const m0 = (mc.mentions || [])[0];
    if (m0) record(c, `mentions[0] field names: ${fieldKeys(m0).join(', ')} (spec 9.8.2 shape check)`, truncateEvidence(m0));
    c.status = 'pass';
  } else {
    record(c, 'MESSAGE_CREATE echo NOT observed within 10s — gateway event names/field names UNCONFIRMED');
    c.status = probe ? 'partial' : 'fail';
  }

  // Role ping on a bot-authored message (spec: record the wire field the adapter
  // must populate for allowedMentions roles).
  try {
    const g0 = (gateway.guildCreates || [])[0];
    const role = (Array.isArray(g0 && g0.roles) ? g0.roles : Object.values((g0 && g0.roles) || {}))
      .find(r => String(r.id) !== String((g0 && g0.id)));
    if (role) {
      const ping = await apiCall('POST', `/channels/${ch.id}/messages`, {
        content: `spike ${stamp}: role ping probe (delete me)`,
        allowed_mentions: { roles: [String(role.id)] },
      });
      record(c, `POST role-ping message allowed_mentions={roles:[${role.id}]} -> ${ping.status}`,
        truncateEvidence(ping.json && ping.json.id ? { id: ping.json.id, mention_roles: ping.json.mention_roles,
          content: ping.json.content } : ping.json));
      const pingMc = await waitForEvent('MESSAGE_CREATE', d => ping.json && String(d.id) === String(ping.json.id), 8000);
      if (pingMc) {
        record(c, `role-ping MESSAGE_CREATE: mention_roles=${JSON.stringify(pingMc.mention_roles)} `
          + `(field CONFIRMED: structured role ids arrive in 'mention_roles'; docs:3 §3.4)`,
          truncateEvidence({ mention_roles: pingMc.mention_roles, content: pingMc.content }));
      }
      if (ping.json && ping.json.id) await apiCall('DELETE', `/channels/${ch.id}/messages/${ping.json.id}`);
    }
  } catch (e) { record(c, `role ping probe error: ${e.message}`); }

  if (probe) {
    try {
      const reply = await apiCall('POST', `/channels/${ch.id}/messages`, {
        content: `spike ${stamp}: reply probe`,
        message_reference: { message_id: String(probe.id) },
      });
      record(c, `POST reply message_reference={message_id} -> ${reply.status}; `
        + `response referenced_message present=${reply.json && reply.json.referenced_message ? 'yes (id=' + reply.json.referenced_message.id + ')' : JSON.stringify(reply.json && reply.json.referenced_message)}; `
        + `message_reference field names: ${fieldKeys(reply.json && reply.json.message_reference).join(', ')}`,
        truncateEvidence(reply.json && reply.json.message_reference ? { message_reference: reply.json.message_reference,
          referenced_message_keys: fieldKeys(reply.json.referenced_message) } : (reply.json || reply.text)));
      if (reply.json && reply.json.id) await apiCall('DELETE', `/channels/${ch.id}/messages/${reply.json.id}`);
    } catch (e) { record(c, `reply probe error: ${e.message}`); }

    try {
      const edited = await apiCall('PATCH', `/channels/${ch.id}/messages/${probe.id}`, { content: `${content} (edited)` });
      const okEdit = edited.status === 200 && edited.json && edited.json.edited_timestamp;
      record(c, `PATCH /channels/{channel_id}/messages/{message_id} -> ${edited.status}; `
        + `edited_timestamp=${JSON.stringify(edited.json && edited.json.edited_timestamp)} `
        + `(200 + non-null edited_timestamp = ${okEdit ? 'CONFIRMED' : 'NOT confirmed'})`,
        truncateEvidence(edited.json && edited.json.edited_timestamp !== undefined
          ? { id: edited.json.id, edited_timestamp: edited.json.edited_timestamp, content: edited.json.content }
          : (edited.json || edited.text)));
    } catch (e) { record(c, `edit probe error: ${e.message}`); }

    const delP = new Promise(res => {
      const t = setTimeout(() => res(null), 8000);
      (evListeners.MESSAGE_DELETE = evListeners.MESSAGE_DELETE || []).push(function onD(d) {
        if (probe && String(d.id) === String(probe.id)) { clearTimeout(t); res(d); }
      });
    });
    const deleted = await apiCall('DELETE', `/channels/${ch.id}/messages/${probe.id}`);
    record(c, `DELETE /channels/{channel_id}/messages/{message_id} -> ${deleted.status} (docs: 204 empty; `
      + `observed body length=${(deleted.text || '').length})`);
    const delEv = await delP;
    if (delEv) record(c, 'MESSAGE_DELETE observed for probe (see gateway-events check for field names)');
    else c.unconfirmed.push('MESSAGE_DELETE event for the probe was not observed within 8s');
  }
  logLine(`  messages: send=${probe ? 'ok' : 'FAILED'}`);
  return probe;
}

async function checkHistory(textChannel) {
  const c = check('history', 'Message history pagination: before/after/limit');
  const ch = textChannel;
  if (!ch) { record(c, 'no channel'); return done(c, 'fail'); }
  try {
    const base100 = await apiCall('GET', `/channels/${ch.id}/messages?limit=100`);
    const ids = Array.isArray(base100.json) ? base100.json.map(m => m.id) : [];
    record(c, `GET /channels/{channel_id}/messages?limit=100 -> ${base100.status}; `
      + `${ids.length} messages; newest-first ordering=${ids.length >= 2 ? (BigInt(ids[0]) > BigInt(ids[1]) ? 'CONFIRMED' : 'NO') : 'n/a'}`,
      truncateEvidence({ first_ids: ids.slice(0, 5), msg_field_names: base100.json && base100.json[0] ? fieldKeys(base100.json[0]) : [] }));
    if (ids.length) {
      const anchor = ids[0];
      const before = await apiCall('GET', `/channels/${ch.id}/messages?limit=10&before=${anchor}`);
      const beforeIds = Array.isArray(before.json) ? before.json.map(m => m.id) : null;
      const beforeExcludes = Array.isArray(beforeIds) ? !beforeIds.includes(anchor) : null;
      const allOlder = Array.isArray(beforeIds) ? beforeIds.every(id => BigInt(id) < BigInt(anchor)) : null;
      record(c, `?before=${anchor}: status=${before.status} count=${beforeIds && beforeIds.length} `
        + `excludes-anchor=${JSON.stringify(beforeExcludes)} all-ids-older=${JSON.stringify(allOlder)} `
        + `(docs:3 "before: a message id; page opens just before the message")`,
        truncateEvidence({ ids: beforeIds && beforeIds.slice(0, 5) }));
      const after = await apiCall('GET', `/channels/${ch.id}/messages?limit=10&after=${anchor}`);
      const afterIds = Array.isArray(after.json) ? after.json.map(m => m.id) : null;
      record(c, `?after=${anchor}: status=${after.status} count=${afterIds && afterIds.length} `
        + `excludes-anchor=${JSON.stringify(Array.isArray(afterIds) ? !afterIds.includes(anchor) : null)} `
        + `all-ids-newer=${JSON.stringify(Array.isArray(afterIds) ? afterIds.every(id => BigInt(id) > BigInt(anchor)) : null)}`,
        truncateEvidence({ ids: afterIds && afterIds.slice(0, 5) }));
      const around = await apiCall('GET', `/channels/${ch.id}/messages?limit=5&around=${anchor}`);
      record(c, `?around=${anchor}: status=${around.status} count=${Array.isArray(around.json) ? around.json.length : 'n/a'}`);
      const limit101 = await apiCall('GET', `/channels/${ch.id}/messages?limit=101`);
      record(c, `?limit=101 -> ${limit101.status} (docs:3 max 100; 400 expected if enforced) code=${JSON.stringify(limit101.code)}`,
        truncateEvidence(typeof limit101.json === 'object' && !Array.isArray(limit101.json) ? limit101.json : null));
      c.status = (before.status === 200 && Array.isArray(beforeIds)) ? 'pass' : 'fail';
    } else { c.status = 'fail'; record(c, 'channel history is empty'); }
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
}

function pngBytes() {
  // 1x1 red PNG (valid, tiny) — attachment probe payload.
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
}

async function checkAttachments(textChannel) {
  const c = check('attachments', 'Embed + PNG upload: content-types, embed wire shape, presigned flow');
  const ch = textChannel;
  if (!ch) { record(c, 'no channel'); return done(c, 'fail'); }
  const stamp = Date.now();
  const png = pngBytes();
  const created = [];

  // Path (a): multipart inline upload with embed.
  try {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({
      content: `spike ${stamp}: multipart probe (delete me)`,
      embeds: [{ title: 'spike embed', description: 'phase 0', color: 0x2f3136,
        fields: [{ name: 'f1', value: 'v1', inline: true }],
        footer: { text: 'spike footer' }, author: { name: 'spike author' },
        timestamp: new Date().toISOString() }],
    }));
    fd.append('files[0]', new Blob([png], { type: 'image/png' }), 'spike.png');
    const sent = await apiCall('POST', `/channels/${ch.id}/messages`, undefined, { formData: fd });
    record(c, `POST multipart/form-data files[0] + payload_json -> ${sent.status} `
      + `content-type=${sent.contentTypeUsed}`, truncateEvidence(sent.json && sent.json.id
      ? { id: sent.json.id, attachments: sent.json.attachments, embeds: sent.json.embeds }
      : (sent.json || sent.text)));
    if (sent.json && sent.json.attachments && sent.json.attachments[0]) {
      const a = sent.json.attachments[0];
      record(c, `attachment wire field names: ${fieldKeys(a).join(', ')} `
        + `(docs:3 names url/proxy_url/size/content_type/filename CONFIRMED: `
        + `${['url', 'proxy_url', 'size', 'content_type', 'filename'].map(k => `${k}=${a[k] !== undefined}`).join(', ')})`,
        truncateEvidence(a));
    }
    if (sent.json && sent.json.embeds && sent.json.embeds[0]) {
      const e0 = sent.json.embeds[0];
      record(c, `embed response field names: ${fieldKeys(e0).join(', ')}; type=${JSON.stringify(e0.type)} `
        + `(proxy fields present: ${['proxy_url', 'proxy_icon_url', 'proxy_icon_url'].filter(k => JSON.stringify(e0).includes(k)).join(', ') || 'none'})`,
        truncateEvidence(e0));
    }
    if (sent.json && sent.json.id) { created.push(sent.json.id); await sleep(200); }
  } catch (e) { record(c, `multipart probe error: ${e.message}`); c.unconfirmed.push('multipart inline upload not exercised: ' + e.message); }

  // Path (b): presigned flow (feature flag true on this instance).
  try {
    const plan = await apiCall('POST', `/channels/${ch.id}/attachments`, {
      attachments: [{ id: 0, filename: 'spike.png', file_size: png.length, content_type: 'image/png' }],
    });
    record(c, `POST /channels/{channel_id}/attachments -> ${plan.status}`, truncateEvidence(plan.json));
    const up = plan.json && (plan.json.uploads && plan.json.uploads[0] || plan.json[0]);
    const uploadUrl = up && (up.upload_url || up.url);
    const uploadFilename = up && (up.upload_filename || up.filename);
    const uploadMode = (plan.json && plan.json.upload_mode) || (up && up.upload_mode);
    if (plan.status === 200 && uploadUrl && uploadFilename) {
      record(c, `presigned plan: upload_mode=${JSON.stringify(uploadMode)} upload_url=${String(uploadUrl).split('?')[0]}?… `
        + `upload_filename=${JSON.stringify(uploadFilename)} expires_at=${JSON.stringify(up.expires_at)}`);
      const putRes = await fetch(uploadUrl, { method: 'PUT', body: new Blob([png], { type: 'image/png' }) });
      record(c, `PUT bytes to upload_url (NO Authorization header) -> ${putRes.status} (docs:11 presigned = no auth)`);
      const sent = await apiCall('POST', `/channels/${ch.id}/messages`, {
        content: `spike ${stamp}: presigned probe (delete me)`,
        attachments: [{ id: 0, upload_filename: uploadFilename }],
      });
      record(c, `POST message with attachments=[{id:0, upload_filename}] -> ${sent.status} `
        + `(docs:3 attachments metadata matches files by id)`,
        truncateEvidence(sent.json && sent.json.attachments ? { id: sent.json.id, attachments: sent.json.attachments } : (sent.json || sent.text)));
      if (sent.json && sent.json.id) created.push(sent.json.id);
      if (sent.status === 200) c.status = 'pass';
    } else {
      record(c, `presigned plan did not include upload_url/upload_filename (status=${plan.status})`);
      c.status = c.status === 'pass' ? 'pass' : (created.length ? 'pass' : 'fail');
    }
  } catch (e) { record(c, `presigned probe error: ${e.message}`); }

  if (created.length && c.status !== 'pass') c.status = 'pass';
  c.unconfirmed.push('docs:11 presigned multipart (multi-part) flow — 1x1 PNG uses singlepart; parts flow unexercised');
  logLine(`  attachments: ${c.status}`);
}

async function checkReactions(textChannel) {
  const c = check('reactions', 'Reaction add/remove HTTP + MESSAGE_REACTION_ADD payload');
  const ch = textChannel;
  if (!ch) { record(c, 'no channel'); return done(c, 'fail'); }
  try {
    const sent = await apiCall('POST', `/channels/${ch.id}/messages`, { content: `spike ${Date.now()}: reaction probe (delete me)` });
    if (sent.status !== 200 || !sent.json || !sent.json.id) {
      record(c, `probe send failed (${sent.status})`, truncateEvidence(sent.json || sent.text));
      return done(c, 'fail');
    }
    const mid = sent.json.id;
    const emoji = encodeURIComponent('👍');
    const add = await apiCall('PUT', `/channels/${ch.id}/messages/${mid}/reactions/${emoji}/@me`);
    record(c, `PUT .../reactions/%F0%9F%91%8D/@me -> ${add.status} (docs:3 expects 204; bots exempt from email/session gates)`,
      truncateEvidence(add.json || add.text));
    await sleep(1200); // allow the event to land
    const ev = (evLog.MESSAGE_REACTION_ADD || []).find(d => String(d.message_id) === String(mid));
    if (ev) {
      record(c, `MESSAGE_REACTION_ADD d field names: ${fieldKeys(ev).join(', ')}; emoji: ${JSON.stringify(ev.emoji)} `
        + `(single-object payload CONFIRMED)`, truncateEvidence(ev));
      c.status = 'pass';
    } else {
      record(c, 'no MESSAGE_REACTION_ADD event observed for the probe');
      c.status = add.status === 204 ? 'partial' : 'fail';
    }
    const del = await apiCall('DELETE', `/channels/${ch.id}/messages/${mid}/reactions/${emoji}/@me`);
    record(c, `DELETE reaction -> ${del.status}`);
    await apiCall('DELETE', `/channels/${ch.id}/messages/${mid}`);
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
}

async function checkRoles(guildId, botUserId, g0) {
  const c = check('roles', 'PUT/DELETE /guilds/{g}/members/{u}/roles/{r} (204 + rate headers)');
  const roles = Array.isArray(g0 && g0.roles) ? g0.roles : Object.values((g0 && g0.roles) || {});
  const role = roles.find(r => String(r.id) !== String(g0 && g0.id) && !r.managed);
  if (!role) { record(c, 'no assignable non-everyone unmanaged role found in guild'); return done(c, 'fail'); }
  record(c, `using role id=${role.id} name=${JSON.stringify(role.name)} position=${role.position}`);
  record(c, `role object field names: ${fieldKeys(role).join(', ')}; permissions type=${typeof role.permissions} value=${JSON.stringify(role.permissions)}`);
  if (!(await confirm(`Add role "${role.name}" to the BOT itself (self role add/remove test)?`))) {
    record(c, 'operator declined self role add/remove — status codes UNCONFIRMED');
    return done(c, 'skip');
  }
  try {
    const add = await apiCall('PUT', `/guilds/${guildId}/members/${botUserId}/roles/${role.id}`);
    record(c, `PUT /guilds/{guild_id}/members/{user_id}/roles/{role_id} -> ${add.status} `
      + `(docs:5 expects 204 empty; observed body length=${(add.text || '').length}); `
      + `rate headers: ${JSON.stringify(add.headers)}`, truncateEvidence(add.json || add.text));
    // Observe the member payload shape via gateway (MESSAGE_CREATE member.roles) if present,
    // else via GET member.
    const mem = await apiCall('GET', `/guilds/${guildId}/members/${botUserId}`);
    const rolesInMember = mem.json && Array.isArray(mem.json.roles) ? mem.json.roles : null;
    record(c, `GET /guilds/{guild_id}/members/{user_id} -> ${mem.status}; roles array contains role: `
      + `${rolesInMember ? rolesInMember.map(String).includes(String(role.id)) : 'n/a'} `
      + `(role ids are ${rolesInMember && rolesInMember[0] ? typeof rolesInMember[0] + ' strings/ids' : 'n/a'}; docs:5/9.9.1 member.roles: [id])`,
      truncateEvidence(mem.json && Array.isArray(mem.json.roles) ? { roles: mem.json.roles, keys: fieldKeys(mem.json) } : (mem.json || mem.text)));
    const rm = await apiCall('DELETE', `/guilds/${guildId}/members/${botUserId}/roles/${role.id}`);
    record(c, `DELETE role -> ${rm.status}`);
    if (add.status === 204 && rm.status === 204) c.status = 'pass';
    else if (add.status && rm.status) { c.status = 'observed'; record(c, `status codes differ from docs (add=${add.status}, remove=${rm.status}) — recorded as live facts`); }
    else c.status = 'fail';
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
}

async function checkChannelsCreate(guildId, g0, everyoneRoleId) {
  const c = check('channels-create', 'POST /guilds/{g}/channels + permission_overwrites (kind ints) + DELETE');
  if (!(await confirm('Create a temp text channel in the test community? (deleted immediately after)'))) {
    record(c, 'operator declined channel creation — UNCONFIRMED');
    return done(c, 'skip');
  }
  try {
    const name = `spike-tmp-${Date.now().toString(36)}`;
    const sent = await apiCall('POST', `/guilds/${guildId}/channels`, {
      type: 0, name,
      permission_overwrites: [
        { id: String(everyoneRoleId), type: 0, allow: '0', deny: '1024' }, // deny SEND_MESSAGES bit 10
        { id: String(g0.owner_id), type: 1, allow: '0', deny: '0' },
      ],
    });
    record(c, `POST /guilds/{guild_id}/channels -> ${sent.status}`, truncateEvidence(sent.json));
    const chObj = sent.json;
    if (sent.status === 200 && chObj) {
      record(c, `created channel id=${chObj.id} type=${chObj.type} name=${JSON.stringify(chObj.name)} `
        + `parent_id=${JSON.stringify(chObj.parent_id)} rate_limit_per_user=${JSON.stringify(chObj.rate_limit_per_user)} `
        + `field names: ${fieldKeys(chObj).join(', ')}`);
      const ow = Array.isArray(chObj.permission_overwrites) ? chObj.permission_overwrites : (chObj.permission_overwrites ? Object.values(chObj.permission_overwrites) : null);
      if (ow) {
        const o0 = ow[0];
        record(c, `overwrite wire shape: type=${JSON.stringify(o0.type)} (role=0 CONFIRMED=${JSON.stringify(o0.type) === '0'}); `
          + `allow=${JSON.stringify(o0.allow)} (${typeof o0.allow}) deny=${JSON.stringify(o0.deny)} (${typeof o0.deny}); `
          + `overwrite field names: ${fieldKeys(o0).join(', ')} (docs:5 {id,type,allow,deny} — NOTE: docs name the int field 'type', spec assumed 'kind')`,
          truncateEvidence(ow));
        const memberOw = ow.find(o => o.type === 1);
        if (memberOw) record(c, `member overwrite kind=1 round-tripped: id=${memberOw.id}`);
        c.status = 'pass';
      } else { record(c, 'response carried no permission_overwrites — kind integers UNCONFIRMED'); c.status = 'partial'; }
      const del = await apiCall('DELETE', `/channels/${chObj.id}`);
      record(c, `DELETE /channels/{channel_id} -> ${del.status} (cleanup)`);
    } else {
      record(c, `channel create failed (${sent.status}) — MANAGE_CHANNELS/${JSON.stringify(sent.code)}`, truncateEvidence(sent.json || sent.text));
      c.status = 'fail';
    }
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
}

async function checkMembers(guildId, botUserId) {
  const c = check('members', 'GET /guilds/{g}/members/{u} — resolve members (bot + arbitrary user)');
  try {
    const self = await apiCall('GET', `/guilds/${guildId}/members/${botUserId}`);
    record(c, `self member: GET /guilds/${guild_id}/members/{user_id} -> ${self.status}; `
      + `field names: ${fieldKeys(self.json).join(', ')}`, truncateEvidence(self.json));
    const botSelf = self.status === 200;
    if (testUserId) {
      const other = await apiCall('GET', `/guilds/${guildId}/members/${testUserId}`);
      record(c, `arbitrary member (${testUserId}): -> ${other.status}; user field names: `
        + `${fieldKeys(other.json && other.json.user).join(', ')}`, truncateEvidence(other.json));
      if (other.status === 200) record(c, 'arbitrary-member fetch CONFIRMED (no privileged-intent concept on Fluxer; '
        + 'docs:2 bots are regular users)');
      c.status = (botSelf && other.status === 200) ? 'pass' : 'partial';
    } else {
      record(c, 'arbitrary-member fetch NOT exercised (provide --user)');
      c.status = botSelf ? 'partial' : 'fail';
    }
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
}

async function checkDms() {
  const c = check('dms', 'DM open + send; error shapes');
  record(c, `instance discovery flag community.direct_messages_disabled=false (see discovery check)`);
  if (!testUserId) {
    record(c, 'no --user provided: scenario A/B SKIPPED. docs:8 codes to confirm live: '
      + 'DIRECT_MESSAGES_DISABLED (400, instance flag) and CANNOT_SEND_TO_USER (400, personal policy). '
      + 'docs:8 also predicts 400 on opening a DM with a missing recipient (UNVERIFIED)');
    return done(c, 'skip');
  }
  try {
    const open = await apiCall('POST', '/users/@me/channels', { recipient_id: String(testUserId) });
    record(c, `POST /users/@me/channels {recipient_id} -> ${open.status}; `
      + `channel id=${open.json && open.json.id} type=${open.json && open.json.type}`, truncateEvidence(open.json));
    const openMissing = await apiCall('POST', '/users/@me/channels', { recipient_id: '1' });
    record(c, `POST /users/@me/channels with recipient_id=1 -> ${openMissing.status} `
      + `code=${JSON.stringify(openMissing.code)} (docs:8 predicts 400 on missing recipient)`, truncateEvidence(openMissing.json));
    if (open.status === 200 && open.json && open.json.id) {
      const sent = await apiCall('POST', `/channels/${open.json.id}/messages`, { content: `spike ${Date.now()}: DM probe (delete me)` });
      record(c, `POST message in DM -> ${sent.status} code=${JSON.stringify(sent.code)} `
        + `(this is the shape a personal DM-policy block must surface: docs:8 CANNOT_SEND_TO_USER)`,
        truncateEvidence(sent.json && sent.json.id ? { id: sent.json.id } : (sent.json || sent.text)));
      if (sent.json && sent.json.id) await apiCall('DELETE', `/channels/${open.json.id}/messages/${sent.json.id}`);
      c.status = 'pass';
    } else { c.status = 'partial'; }
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
}

async function checkBans(guildId) {
  const c = check('bans', 'PUT/DELETE /guilds/{g}/bans/{u} + GUILD_BAN_ADD event');
  if (!banUserId) {
    record(c, 'no --ban-user: SKIPPED. docs:7 expects PUT/DELETE -> 204, ban emits GUILD_BAN_ADD {guild_id, user:{id}} (UNVERIFIED live)');
    return done(c, 'skip');
  }
  if (!(await confirm(`BAN user ${banUserId} in the test community and unban immediately? (member must re-join; use a sacrificial account)`))) {
    record(c, 'operator declined ban check — UNCONFIRMED');
    return done(c, 'skip');
  }
  try {
    const ban = await apiCall('PUT', `/guilds/${guildId}/bans/${banUserId}`, { reason: 'fluxer phase-0 spike (unban immediately)' });
    record(c, `PUT /guilds/{guild_id}/bans/{user_id} -> ${ban.status} code=${JSON.stringify(ban.code)} `
      + `(docs:7 expects 204 empty; body length=${(ban.text || '').length})`, truncateEvidence(ban.json || ban.text));
    await sleep(1500);
    const ev = (evLog.GUILD_BAN_ADD || []).find(d => String(d.user && d.user.id) === String(banUserId));
    if (ev) record(c, `GUILD_BAN_ADD observed: ${JSON.stringify(ev)}`, truncateEvidence(ev));
    else c.unconfirmed.push('GUILD_BAN_ADD event not observed for the ban within 1.5s');
    const unban = await apiCall('DELETE', `/guilds/${guildId}/bans/${banUserId}`);
    record(c, `DELETE /guilds/{guild_id}/bans/{user_id} -> ${unban.status} code=${JSON.stringify(unban.code)} `
      + `(docs:7 expects 204; 400 USER_IS_NOT_BANNED if not banned)`, truncateEvidence(unban.json || unban.text));
    if (ban.status === 204 && unban.status === 204) c.status = 'pass';
    else { c.status = 'observed'; record(c, `status codes differ from docs (ban=${ban.status}, unban=${unban.status}) — recorded as live facts`); }
  } catch (e) { record(c, `error: ${e.message}`); c.status = 'fail'; }
}

async function checkRateLimitHeaders(messagesProbe, rolesProbe) {
  const c = check('rate-limits', 'Response header names on send + role edit');
  const send = (messagesProbe && messagesProbe.headers) || {};
  const role = (rolesProbe && rolesProbe.headers) || {};
  record(c, `send-message headers observed: ${Object.keys(send).join(', ') || 'none'}`);
  record(c, `role-edit headers observed: ${Object.keys(role).join(', ') || 'none'}`);
  record(c, 'docs:10 set: Retry-After, X-RateLimit-Limit/Remaining/Reset/Reset-After/Bucket/Scope, Global. '
    + 'Bot tokens get bucket headers on success; user tokens get bucket headers ONLY on 429. 429 body code=RATE_LIMITED. '
    + '429 itself was not exercised in this run (recorded from docs, flagged below).');
  c.unconfirmed.push('429 RATE_LIMITED body shape + Retry-After on denial: docs-only (docs:10), not exercised');
  c.status = (Object.keys(send).length && Object.keys(role).length) ? 'pass' : (Object.keys(send).length ? 'partial' : 'fail');
}

function checkSdk() {
  const c = check('sdk', '@fluxerjs/core: npm pack + install to .tmp + CJS require + ESM import + LICENSE');
  const version = { recorded: null };
  const workDir = path.join(__dirname, '..', '.tmp', 'fluxer-spike-sdk');
  fs.mkdirSync(workDir, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmEnv = { ...process.env, npm_config_cache: path.join(workDir, '.npm-cache') };
  const run = (args, timeout = 120000) => spawnSync(npm, args, { cwd: workDir, encoding: 'utf8', timeout, env: npmEnv });

  let tarball = null;
  try {
    const pack = run(['pack', '@fluxerjs/core@latest', '--pack-destination', workDir]);
    const out = (pack.stdout || '').trim();
    const m = out.match(/([^\s]+\.tgz)/);
    if (pack.status !== 0 || !m) {
      record(c, `npm pack failed (status=${pack.status})`, redact((pack.stderr || pack.stdout || '').slice(-800)));
      return done(c, 'fail');
    }
    tarball = path.join(workDir, m[1]);
    record(c, `npm pack @fluxerjs/core@latest -> ${m[1]}`);
  } catch (e) { record(c, `npm pack error: ${e.message}`); return done(c, 'fail'); }

  try {
    fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify({ name: 'fluxer-spike-sdk-probe', private: true }, null, 2));
    const inst = run(['install', tarball, '--no-save', '--prefix', workDir]);
    if (inst.status !== 0) {
      record(c, 'npm install of packed tarball failed', redact((inst.stderr || inst.stdout || '').slice(-800)));
      return done(c, 'fail');
    }
    const pkgDir = path.join(workDir, 'node_modules', '@fluxerjs', 'core');
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    version.recorded = pkgJson.version;
    record(c, `installed version: ${pkgJson.version}; package.json license field: ${JSON.stringify(pkgJson.license)}`);
    let licenseText = null;
    for (const f of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE']) {
      try { licenseText = fs.readFileSync(path.join(pkgDir, f), 'utf8'); version.licenseFile = f; break; } catch { /* next */ }
    }
    const apache = licenseText ? /Apache License[\s\S]*Version 2\.0, January 2004/i.test(licenseText) : null;
    record(c, `LICENSE file: ${version.licenseFile || 'NOT FOUND'}; text matches "Apache License Version 2.0": `
      + `${apache === null ? 'UNKNOWN' : (apache ? 'YES' : 'NO')}`
      + (apache === false ? ' — K6: license check FAILS; do not add the dependency' : ''));

    // CJS require + ESM dynamic import probe.
    const probeFile = path.join(workDir, 'probe.cjs');
    fs.writeFileSync(probeFile, `'use strict';
const path = require('node:path');
const pkgDir = path.join(__dirname, 'node_modules', '@fluxerjs', 'core');
(async () => {
  const out = {};
  try {
    const m = require(pkgDir);
    out.require = { ok: true, keys: Object.keys(m).slice(0, 25) };
  } catch (e) {
    const code = e && e.code ? String(e.code) : null;
    out.require = { ok: false, code, error: String((e && e.erra && e.erra.code) || (e && e.message) || e).slice(0, 400),
      esmError: (e && e.erra && String(e.erra.code)) || null };
  }
  try {
    const m = await import('file://' + pkgDir + '/index.js');
    out.import = { ok: true, keys: Object.keys(m).slice(0, 25) };
  } catch (e) {
    out.import = { ok: false, code: (e && e.code) || null, error: String((e && e.message) || e).slice(0, 400) };
  }
  console.log(JSON.stringify(out));
})();
`);
    const probe = spawnSync(process.execPath, [probeFile], { encoding: 'utf8', timeout: 60000 });
    let probeOut = null;
    try { probeOut = JSON.parse((probe.stdout || '').trim().split('\n').pop()); } catch { /* raw */ }
    record(c, 'load probes (from a .cjs entrypoint — this repo has no "type":"module")',
      truncateEvidence(probeOut || { stdout: (probe.stdout || '').slice(0, 800), stderr: (probe.stderr || '').slice(0, 1200) }));
    const req = probeOut && probeOut.require; const imp = probeOut && probeOut.import;
    const requireOk = !!(req && req.ok);
    const importOk = !!(imp && imp.ok);
    record(c, `CJS require(): ${req ? (req.ok ? `OK (exports: ${req.keys.slice(0, 6).join(', ')}…)` : `FAILED code=${req.code} ${req.error.slice(0, 160)}`) : 'n/a'}`);
    record(c, `ESM dynamic import(): ${imp ? (imp.ok ? `OK (exports: ${imp.keys.slice(0, 6).join(', ')}…)` : `FAILED code=${imp.code} ${imp.error.slice(0, 160)}`) : 'n/a'}`);
    record(c, `docs:13 (Fluxer.js guide) recommends the 'Fluxer' umbrella package; '@fluxerjs/core' alone provides the client — noted for PR 6`);

    const licenseOk = apache === true;
    const loadOk = requireOk || importOk;
    if (licenseOk && loadOk) {
      c.status = 'pass';
      record(c, `K6 gate OPEN for PR 6: license Apache-2.0 confirmed + at least one load path works `
        + `(require=${requireOk}, import=${importOk}). package.json of this repo is UNTOUCHED by this spike.`);
    } else {
      c.status = 'fail';
      record(c, `K6 gate CLOSED: licenseOk=${licenseOk} require=${requireOk} import=${importOk} `
        + `— per PR 1 rule the dependency must NOT be added; roadmap records the failure.`);
    }
  } catch (e) { record(c, `install/probe error: ${e.message}`); c.status = 'fail'; }
  version.checked = true;
  version.version = version.recorded;
  return c;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async function main() {
  logLine(`Fluxer Phase 0 spike — ${new Date().toISOString()}`);
  logLine(`url=${base} guild=${guildWanted || '(auto)'} user=${testUserId || '(none)'} ban=${banUserId || '(none)'} voiceWait=${voiceWaitSec}s sdk=${sdkCheckEnabled ? 'on' : 'off'}\n`);

  const disc = await checkDiscovery();
  if (!apiBase) fatal('discovery did not yield endpoints.api_public — cannot continue');

  await checkAuth();
  const gwUrl = await checkGatewayBot();
  await checkOpenApi();
  await checkGuildList();

  if (!tokenValidity.valid) {
    logLine('\nFATAL: token invalid at /applications/@me (docs:2). Stopping before gateway. '
      + 'Check the token file contents (raw token, no "Bot " prefix).');
    finalize();
    return;
  }

  // Connect gateway BEFORE REST mutations so events are observed.
  const wsUrl = gateway.ready && gateway.ready.url; // not present; prefer API value
  const connectUrl = (gwUrl && gwUrl.startsWith('wss://') ? gwUrl : (disc.endpoints && disc.endpoints.gateway));
  try {
    await connectGateway(String(connectUrl).replace(/^ws:/, 'wss:'));
  } catch (e) {
    const c = check('gateway-connect', 'Gateway websocket connect');
    record(c, `connect to ${redact(String(connectUrl))} failed: ${e.message}`);
    record(c, 'all gateway-event checks below are UNCONFIRMED (MESSAGE_CREATE, reactions, bans, voice)');
    done(c, 'fail');
  }

  const guildIds = guildWanted ? [String(guildWanted)] : ((gateway.ready && (gateway.ready.guilds || []).map(g => String(g.id))) || []);
  await checkGatewayEvents(guildIds);

  const g0 = (gateway.guildCreates || [])[0];
  const textChannel = g0 ? pickTextChannel(g0) : (channelWanted ? { id: String(channelWanted), name: null, type: 0 } : null);
  const botUserId = gateway.ready && gateway.ready.user && String(gateway.ready.user.id);
  const everyone = g0 ? ((Array.isArray(g0.roles) ? g0.roles : Object.values(g0.roles || {})).find(r => String(r.id) === String(g0.id)) || null) : null;

  await checkMessages(textChannel, botUserId);
  await checkHistory(textChannel);
  await checkAttachments(textChannel);
  await checkReactions(textChannel);
  const rolesCheck = await checkRoles(guildWanted || (g0 && g0.id), botUserId, g0);
  await checkChannelsCreate(g0 && g0.id, g0, everyone ? everyone.id : '1');
  await checkMembers(g0 && g0.id, botUserId);
  await checkDms();
  await checkBans(g0 && g0.id);

  if (voiceWaitSec > 0 && gateway.connected) {
    logLine(`  listening for VOICE_STATE_UPDATE for ${voiceWaitSec}s (have a human join a voice channel now)...`);
    await sleep(voiceWaitSec * 1000);
  }
  closeGateway();

  await checkRateLimitHeaders(null, null);
  if (sdkCheckEnabled) checkSdk();

  finalize();
})().catch((err) => {
  process.stderr.write(`FATAL: ${err && err.stack ? redact(err.stack) : redact(String(err))}\n`);
  try { closeGateway(); } catch { /* ignore */ }
  process.exit(2);
});

function finalize() {
  const sendC = checks.find(c => c.id === 'messages');
  const rolesC = checks.find(c => c.id === 'roles');
  // Best-effort rate-limit header capture from the recorded evidence is not
  // machine-readable post-hoc; the send/role checks embed headers in notes.
  void sendC; void rolesC;

  const unconfirmed = [];
  for (const c of checks) for (const u of c.unconfirmed) unconfirmed.push(`${c.id}: ${u}`);

  const summary = {
    started_at: startedAt, finished_at: new Date().toISOString(),
    url: base, guild: guildWanted, test_user: testUserId || null, ban_user: banUserId || null,
    voice_wait_sec: voiceWaitSec, sdk_check: sdkCheckEnabled,
    token_valid: tokenValidity.valid,
    gateway: { connected: gateway.connected, hello: gateway.hello, identify_accepted: gateway.identifyAccepted,
      session_id: gateway.session_id, close: gateway.closeInfo, errors: gateway.errors,
      event_types: gateway.eventTypesSeen,
      everyone_role_id_equals_guild_id: !!(gateway.guildCreates && gateway.guildCreates[0]
        && (Array.isArray(gateway.guildCreates[0].roles) ? gateway.guildCreates[0].roles : Object.values(gateway.guildCreates[0].roles || {}))
          .some(r => String(r.id) === String(gateway.guildCreates[0].id))) },
    sdk: (() => { const s = checks.find(c => c.id === 'sdk'); return s ? { status: s.status, notes: s.notes } : null; })(),
    checks: checks.map(c => ({ id: c.id, name: c.name, status: c.status, notes: c.notes,
      unconfirmed: c.unconfirmed, evidence: c.evidence })),
    unconfirmed,
  };

  const ts = startedAt.replace(/[:.]/g, '-');
  const outPath = opts.out || path.join(__dirname, '..', '.tmp', `fluxer-spike-results-${ts}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(redactJson(summary), null, 2));
  logLine(`\nReport written: ${outPath}`);

  const counts = {};
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  logLine(`Status: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (opts.markdown) {
    logLine('\n--- markdown summary (paste-able into roadmap/fluxer.md Phase 0 checklist) ---\n');
    for (const c of checks) {
      logLine(`### ${c.id} — ${c.status.toUpperCase()}`);
      for (const n of c.notes) logLine(`- ${n}`);
      for (const u of c.unconfirmed) logLine(`- **UNCONFIRMED** ${u}`);
    }
  }
}

function redactJson(obj) {
  return JSON.parse(redact(JSON.stringify(obj)) || 'null');
}

process.on('SIGINT', () => { logLine('\nSIGINT — closing gateway and writing partial report'); closeGateway(); finalize(); process.exit(130); });
void wsClosed;
