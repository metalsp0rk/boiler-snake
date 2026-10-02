#!/usr/bin/env node
/**
 * Fluxer Bridge Phase 0 spike (roadmap/bridge.md §10.14, PR 1).
 *
 * Manual-only script. NOT referenced by `npm test` — never add it to the test
 * graph. Zero production dependencies: Node >= 22 global fetch only (no
 * gateway: read-backs go through GET /channels/{id}/messages, §10.14).
 * This script MUST NOT import @fluxerjs/core or any file under src/ —
 * it probes the raw wire, exactly like scripts/fluxer-spike.js (K6 posture).
 *
 * Usage (all config via flags, .env, or env vars; flags win):
 *   node scripts/fluxer-bridge-spike.js --url https://chat.example.com \
 *     --token-file /tmp/fluxer.token --guild <id> --channel <webhookChannelId> \
 *     [--nsfw-channel <id>] [--user <userId>] [--upload-clamp] [--yes] \
 *     [--markdown] [--dry-run] [--out path.json]
 *
 * Secrets: the token is read from --token-file (preferred; point it at a file
 * OUTSIDE the repo), FLUXER_SPIKE_TOKEN_FILE, or FLUXER_SPIKE_TOKEN. It is
 * NEVER written to any report. Webhook tokens (which are part of the execute
 * URL) are registered as secrets the moment create returns them and redacted
 * from every note, evidence payload, and error string. `BRG-` pairing-code
 * values are redacted by pattern. Authorization headers are redacted.
 *
 * Destructive checks (webhook create, large uploads, NSFW-channel probe)
 * prompt for confirmation unless --yes. Answers are recorded as observed
 * facts, not asserts: anything the live deployment does not show is recorded
 * in the probe's notes as unconfirmed and stays PENDING in the roadmap table.
 *
 * Every webhook and message this script creates is deleted in a finally path
 * (messages first, then webhooks); a cleanup summary prints at the end.
 *
 * Exit codes: 0 = completed (probes may be fail/doc/skip — the spike records
 * facts, it is not a CI gate). 2 = fatal configuration/startup error.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const readline = require('node:readline');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const USAGE = `Fluxer Bridge Phase 0 spike — run the roadmap/bridge.md §10.14 probes B1-B14 against one real deployment.

Flags (env fallbacks in .env: FLUXER_SPIKE_URL/TOKEN_FILE/TOKEN/GUILD/WEBHOOK_CHANNEL/NSFW_CHANNEL/TEST_USER):
  --url <url>            Instance URL (required), e.g. https://chat.example.com
  --token-file <path>    File containing the bot token (preferred over --token)
  --token <token>        Bot token (discouraged: process list; prefer --token-file)
  --guild <id>           Test community (guild) id (required; B1 reads its mfa_level)
  --channel <id>         Text channel id to create the probe webhook in (required;
                         env FLUXER_SPIKE_WEBHOOK_CHANNEL). The bot needs Manage Webhooks there.
  --nsfw-channel <id>    Age-restricted channel id for probe B9 (optional; skipped if unset)
  --user <id>            Test user id for the B12 member-fetch avatar probe (optional)
  --upload-clamp         Run B11: 25 MiB / 50 MiB / 50 MiB+1 multipart uploads (slow, heavy)
  --yes                  Answer every mutation confirmation with yes
  --dry-run              Print the probe plan and exit (no network, no env needed)
  --markdown             Print a roadmap-ready markdown summary at the end
  --out <path>           JSON report path (default .tmp/fluxer-bridge-spike-results-<ts>.json)
  --help                 This help
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
    'nsfw-channel': { type: 'string' },
    user: { type: 'string' },
    'upload-clamp': { type: 'boolean' },
    yes: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    markdown: { type: 'boolean' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
});

if (opts.help) { process.stdout.write(USAGE); process.exit(0); }

// Probe plan — printed verbatim by --dry-run (works with ZERO env, offline-safe).
const PROBE_PLAN = [
  { id: 'B1', name: 'Bot MFA on webhook create', asserts: 'POST /channels/{id}/webhooks in the target guild; records GET /guilds/{id} mfa_level and whether TWO_FACTOR_REQUIRED is returned (KD 20 / docs truthfulness).' },
  { id: 'B2', name: 'Per-message username override', asserts: 'Execute webhook with username override, read the posted message back via GET /channels/{id}/messages: rendered author = override or stored webhook name? (KD 7 attribution branch).' },
  { id: 'B3', name: 'avatar_url on execute', asserts: 'Execute with a public https avatar URL; read back author.avatar. Accepted? Reflected? (Discord->Fluxer avatar best-effort, §10.7).' },
  { id: 'B4', name: 'Multipart execute attaches bytes', asserts: 'Webhook execute as multipart/form-data (payload_json + files[0], 1x1 PNG); read back attachments wire field names.' },
  { id: 'B5', name: 'Webhook PATCH message', asserts: 'PATCH /webhooks/{id}/{token}/messages/{mid} on a message the webhook created; read back content + edited_timestamp (edit relay gate).' },
  { id: 'B6', name: 'Webhook DELETE message', asserts: 'DELETE /webhooks/{id}/{token}/messages/{mid}; read back expecting 404 (delete relay gate, moderation story).' },
  { id: 'B7', name: 'Rate-limit headers on webhook routes', asserts: 'Header names captured on successful webhook create + execute responses. 429 body shape stays DOC (not exercised).' },
  { id: 'B8', name: 'Nonce idempotency on execute', asserts: 'Two executes with the same nonce (wait=true) return the SAME message id (5-minute window per docs; §10.6 retry policy).' },
  { id: 'B9', name: 'Bot vs NSFW_CONTENT_AGE_RESTRICTED', asserts: 'Execute into an age-restricted channel; record the channel nsfw flag and any refusal code (§10.9 bot exemption).' },
  { id: 'B10', name: 'Mention suppression on webhook execute', asserts: 'Execute with @everyone/@here/<@id>/<@&id>/<#id> in content + allowed_mentions:{}; read back mention_everyone/mentions/mention_roles/mention_channels all empty? (§10.11 layer 1).' },
  { id: 'B11', name: 'Upload size clamp boundary', asserts: 'Opt-in (--upload-clamp): multipart uploads at 25 MiB / 50 MiB / 50 MiB+1; record accept/reject boundary (media ceiling constant).' },
  { id: 'B12', name: 'Fluxer avatar URL template (DOC)', asserts: 'Print avatar-related fields from GET /users/@me (+ --user member fetch) and the URL template candidates to record. Needs human CDN verification.' },
  { id: 'B13', name: 'No-Origin fetch to webhook execute', asserts: 'Every token-endpoint call in this run goes through Node global fetch with NO Origin header; PASSes when all returned non-403 (no INVALID_API_ORIGIN). Re-confirm on the current build.' },
  { id: 'B14', name: 'Channel mention syntax (DOC)', asserts: 'Post a <#snowflake> message, read back mention_channels[].mention_string. Forms beyond <#snowflake> need client-side observation (instructions printed).' },
];

if (opts['dry-run']) {
  process.stdout.write('Fluxer Bridge Phase 0 spike — probe plan (dry run; nothing executed, no network)\n\n');
  for (const p of PROBE_PLAN) process.stdout.write(`${p.id}  ${p.name}\n    ${p.asserts}\n`);
  process.stdout.write(`\nRequired config for a live run: set FLUXER_SPIKE_URL, FLUXER_SPIKE_TOKEN_FILE (or FLUXER_SPIKE_TOKEN),\nFLUXER_SPIKE_GUILD and FLUXER_SPIKE_WEBHOOK_CHANNEL (see the spike section in .env.example).\nB11 runs only with --upload-clamp. B9 runs only with --nsfw-channel / FLUXER_SPIKE_NSFW_CHANNEL.\n`);
  process.exit(0);
}

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
const webhookChannelWanted = opts.channel || env.FLUXER_SPIKE_WEBHOOK_CHANNEL || '';
const nsfwChannelWanted = opts['nsfw-channel'] || env.FLUXER_SPIKE_NSFW_CHANNEL || '';
const testUserId = opts.user || env.FLUXER_SPIKE_TEST_USER || '';
const uploadClampEnabled = !!opts['upload-clamp'];
const autoYes = !!opts.yes;

if (!base || !token || !guildWanted || !webhookChannelWanted) {
  process.stderr.write(
    'Missing required config: set FLUXER_SPIKE_URL, a token (FLUXER_SPIKE_TOKEN_FILE / FLUXER_SPIKE_TOKEN),\n'
    + 'FLUXER_SPIKE_GUILD and FLUXER_SPIKE_WEBHOOK_CHANNEL (the spike section of .env.example),\n'
    + 'or pass --url / --token-file / --guild / --channel. Use --dry-run to print the probe plan offline.\n\n' + USAGE);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Redaction (AGENTS.md: never print tokens, Authorization, or BRG- codes)
// ---------------------------------------------------------------------------

const secretStrings = new Set(); // bot token + every webhook token ever returned
if (token) secretStrings.add(token);

function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secretStrings.add(value);
}
function redact(text) {
  if (text == null) return text;
  let s = String(text);
  for (const sec of secretStrings) if (sec) s = s.split(sec).join('[REDACTED]');
  // Belt and braces for payloads that embed webhook URLs / bearer lines.
  s = s.replace(/(\/webhooks\/[^/\s"'?]+)\/[A-Za-z0-9_.\-]{16,}/g, '$1/[REDACTED]');
  s = s.replace(/(Authorization["']?\s*[:=]\s*)["']?[^"',\s]+/gi, '$1[REDACTED]');
  s = s.replace(/\bBRG-[A-Za-z0-9_-]+/g, 'BRG-[REDACTED]');
  return s;
}
function fatal(msg) { process.stderr.write(`FATAL: ${msg}\n`); process.exit(2); }
function redactJson(obj) {
  try { return JSON.parse(redact(JSON.stringify(obj)) || 'null'); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Report scaffolding
// ---------------------------------------------------------------------------

const probes = []; // {id, name, status, notes[], evidence[], unconfirmed[]}
function probe(id, name) {
  const c = { id, name, status: 'skip', notes: [], evidence: [], unconfirmed: [] };
  probes.push(c);
  return c;
}
function record(c, note, evidence) {
  c.notes.push(redact(note));
  if (evidence !== undefined) c.evidence.push(truncateEvidence(evidence));
}
function done(c, status) { c.status = status; logLine(`[${status.toUpperCase()}] ${c.id} ${c.name}`); }
function logLine(line) { process.stdout.write(`${redact(line)}\n`); }

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

function fieldKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).sort();
}

/** 2xx success test — webhook routes may answer 200 (Fluxer messages) or 201 (Discord-style). */
function isOk(status) { return status >= 200 && status < 300; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function confirm(promptText) {
  if (autoYes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question(`${redact(promptText)} [y/N] `, () => res()));
  rl.close();
  return /^y(es)?$/i.test(String(answer).trim());
}

// ---------------------------------------------------------------------------
// HTTP helpers (same posture as scripts/fluxer-spike.js)
// ---------------------------------------------------------------------------

let apiBase = null; // resolved from discovery api_public + '/v1'
const headerProbes = []; // {method, path, status, headers} for successful calls
const tokenCallProbes = []; // {method, path, status, code, headerNames} for B13
const createdMessages = []; // {channelId, id} — deleted in cleanup
const createdWebhooks = []; // {id, token} — deleted in cleanup
const cleanupFailures = [];
let cleanupDone = false;

function collectRateHeaders(res) {
  const headersOut = {};
  for (const h of res.headers.keys()) {
    if (rateHeaderNames.includes(h) || h === 'x-fluxer-version') headersOut[h] = res.headers.get(h);
  }
  return headersOut;
}

function noteProbe(id, note, evidence) {
  const c = probes.find(x => x.id === id);
  if (c) record(c, note, evidence);
}

async function apiCall(method, pathname, body, opts2 = {}) {
  if (!apiBase) throw new Error('apiBase not resolved (discovery must run first)');
  const headers = { ...(opts2.headers || {}) };
  if (opts2.auth !== false) headers.Authorization = `Bot ${token}`;
  let payload;
  let contentType = null;
  if (opts2.formData) { payload = opts2.formData; contentType = 'multipart/form-data'; }
  else if (body !== undefined) {
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
  const headersOut = collectRateHeaders(res);
  if (res.status < 400) headerProbes.push({ method, path: pathname, status: res.status, headers: { ...headersOut } });
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

/**
 * Webhook TOKEN endpoint call (execute/patch/delete). The token travels in the
 * URL path — it is registered as a secret before the request so no response
 * echo can leak it, and the path is never used as a label. Per spike B13 and
 * src/platform/fluxer/webhooks.js: NO Origin header is ever set here.
 */
async function tokenCall(method, id, secret, suffix, body, contentType) {
  registerSecret(secret);
  const safeLabel = `${method} /webhooks/{id}/[REDACTED]${suffix.split('?')[0].replace(/\/[0-9]+(?=\/|$)/g, '/{id}')}`;
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  const url = `${apiBase}/webhooks/${encodeURIComponent(String(id))}/${encodeURIComponent(String(secret))}${suffix}`;
  const t0 = Date.now();
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  // B13 record: this function never sets Origin; fetch() from Node never adds one.
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body kept as text */ }
  const entry = {
    method, label: safeLabel, status: res.status,
    code: json && typeof json === 'object' ? json.code ?? null : null,
    headerNames: [...res.headers.keys()].filter(h => rateHeaderNames.includes(h)),
    originHeaderSent: 'origin' in init.headers,
  };
  tokenCallProbes.push(entry);
  if (res.status < 400) headerProbes.push({ method, path: safeLabel, status: res.status, headers: collectRateHeaders(res) });
  return {
    status: res.status,
    code: json && typeof json === 'object' ? json.code ?? null : null,
    json,
    text: redact(text.length > 4000 ? text.slice(0, 4000) : text),
    headers: collectRateHeaders(res),
    ms: Date.now() - t0,
  };
}

/**
 * Execute the relay webhook with wait=true (the spike needs the message id
 * back synchronously; §10.6 pins wait=true on every relay send).
 */
async function executeWebhook(webhook, payload, files) {
  if (files && files.length) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(payload));
    files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: f.contentType }), f.name));
    return tokenCall('POST', webhook.id, webhook.token, '?wait=true', form, undefined);
  }
  return tokenCall('POST', webhook.id, webhook.token, '?wait=true', JSON.stringify(payload), 'application/json');
}

/** Read a posted message back over REST (bot token) — B2/B3/B4/B5/B8/B10/B14. */
async function readBack(channelId, messageId) {
  const r = await apiCall('GET', `/channels/${encodeURIComponent(String(channelId))}/messages?limit=10`);
  if (!isOk(r.status) || !Array.isArray(r.json)) {
    return { ok: false, status: r.status, code: r.code, body: r.json ?? r.text };
  }
  const msg = r.json.find(m => String(m.id) === String(messageId)) || null;
  return { ok: msg !== null, message: msg, listStatus: r.status };
}

/**
 * Delete-verification read-back (B6): a 204 on DELETE is not proof, and the
 * newest-first list page is eventually-consistent — polling the single-message
 * GET (404 = gone) is the race-safe read. Returns { present, attempts }.
 */
async function readBackGone(channelId, messageId) {
  const path = `/channels/${encodeURIComponent(String(channelId))}/messages/${encodeURIComponent(String(messageId))}`;
  for (let i = 0; i < 4; i += 1) {
    const r = await apiCall('GET', path);
    if (r.status === 404) return { present: false, attempts: i + 1 };
    if (i < 3) await new Promise((res) => setTimeout(res, 300));
  }
  return { present: true, attempts: 4 };
}

// ---------------------------------------------------------------------------
// Cleanup — every webhook/message the script creates is deleted here (finally)
// ---------------------------------------------------------------------------

async function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  const msgs = createdMessages.splice(0);
  const hooks = createdWebhooks.splice(0);
  let msgOk = 0;
  for (const m of msgs) {
    try {
      let r = await apiCall('DELETE', `/channels/${encodeURIComponent(String(m.channelId))}/messages/${encodeURIComponent(String(m.id))}`);
      if (!isOk(r.status)) {
        // The channel route is a MODERATION route: a bot without the guild
        // Manage Messages permission gets 403 MISSING_PERMISSIONS there.
        // The webhook token route deletes messages created by that webhook,
        // so fall back to it for webhook-authored probe messages.
        const wh = String(m.channelId) === String(nsfwChannelWanted) ? probeWebhook.nsfw : probeWebhook.main;
        if (wh) {
          const via = await tokenCall('DELETE', wh.id, wh.token, `/messages/${encodeURIComponent(String(m.id))}`, undefined, undefined);
          if (isOk(via.status) || via.status === 404) r = via;
        }
      }
      if (isOk(r.status) || r.status === 404) msgOk += 1;
      else cleanupFailures.push(`message ${m.id}: HTTP ${r.status} code=${JSON.stringify(r.code)}`);
    } catch (e) { cleanupFailures.push(`message ${m.id}: ${e.message}`); }
  }
  let hookOk = 0;
  for (const w of hooks) {
    try {
      const r = await tokenCall('DELETE', w.id, w.token, '', undefined, undefined);
      if (isOk(r.status) || r.status === 404) hookOk += 1;
      else cleanupFailures.push(`webhook ${w.id}: HTTP ${r.status} code=${JSON.stringify(r.code)}`);
    } catch (e) { cleanupFailures.push(`webhook ${w.id}: ${e.message}`); }
  }
  const msgLeft = msgs.length - msgOk;
  const hookLeft = hooks.length - hookOk;
  logLine(`\ncleanup: ${msgOk}/${msgs.length} probe message(s) deleted, ${hookOk}/${hooks.length} probe webhook(s) deleted`
    + (cleanupFailures.length ? ` — ${cleanupFailures.length} FAILURE(S) listed in the report` : '') + '.');
  if (msgLeft || hookLeft) {
    logLine(`cleanup: LEFTOVER ${msgLeft} message(s) / ${hookLeft} webhook(s) — remove the webhook named "${WEBHOOK_NAME}" manually in the channel settings.`);
  }
}

// ---------------------------------------------------------------------------
// Discovery + auth (same as fluxer-spike: /.well-known/fluxer → api_public/v1)
// ---------------------------------------------------------------------------

async function setup() {
  const wellKnown = `${base}/.well-known/fluxer`;
  try {
    const r = await fetch(wellKnown);
    const j = await r.json().catch(() => null);
    if (isOk(r.status) && j && j.endpoints) {
      apiBase = String(j.endpoints.api_public || '').replace(/\/+$/, '') + '/v1';
      noteProbe('setup', `GET ${wellKnown} -> 200; api base = ${apiBase}`);
    }
  } catch (e) {
    noteProbe('setup', `fetch ${wellKnown} failed: ${e.message}`);
  }
  if (!apiBase) fatal('discovery did not yield endpoints.api_public — cannot continue');

  const me = await apiCall('GET', '/users/@me');
  if (!isOk(me.status) || !me.json || me.json.bot !== true) {
    noteProbe('setup', `GET /users/@me -> ${me.status}; bot field=${JSON.stringify(me.json && me.json.bot)} — token not confirmed as a bot user (recorded; probes continue)`, me.json ?? me.text);
  } else {
    noteProbe('setup', `bot user: id=${me.json.id} username=${JSON.stringify(me.json.username)} avatar=${me.json.avatar ? 'set' : 'null'}`);
  }
  return { me: me.json, botUserId: me.json && me.json.id ? String(me.json.id) : null };
}

// ---------------------------------------------------------------------------
// Probes (roadmap/bridge.md §10.14 — one function per row of the table)
// ---------------------------------------------------------------------------

const probeWebhook = { main: null, nsfw: null }; // {id, token} once created
const WEBHOOK_NAME = 'Boiler Snake Bridge Spike';
const probeTargets = { b2: null }; // message id created by B2 (B5/B6 patch/delete it)
let b2MessageId = null;

async function probeB1() {
  const c = probe('B1', 'Bot MFA on webhook create (TWO_FACTOR_REQUIRED?)');
  try {
    const g = await apiCall('GET', `/guilds/${encodeURIComponent(String(guildWanted))}`);
    const mfaLevel = isOk(g.status) && g.json ? g.json.mfa_level : undefined;
    record(c, `GET /guilds/{guild_id} -> ${g.status}; mfa_level=${JSON.stringify(mfaLevel)} (1 = elevated actions require an enrolled authenticator)`);
    if (!/^\d{5,20}$/.test(String(guildWanted))) record(c, 'guild id did not look like a snowflake (recorded)');
    if (!(await confirm(`Create a probe webhook named "${WEBHOOK_NAME}" in channel ${webhookChannelWanted}? (deleted in cleanup)`))) {
      record(c, 'operator declined webhook creation — B1 UNCONFIRMED and B2-B11 need the webhook');
      return done(c, 'skip');
    }
    const mk = await apiCall('POST', `/channels/${encodeURIComponent(String(webhookChannelWanted))}/webhooks`, { name: WEBHOOK_NAME });
    record(c, `POST /channels/{channel_id}/webhooks -> ${mk.status}${mk.code ? ` code=${JSON.stringify(mk.code)}` : ''}`,
      mk.json && mk.json.id ? { id: mk.json.id, name: mk.json.name, channel_id: mk.json.channel_id, type: mk.json.type, token: mk.json.token ? '[present, registered as secret]' : null, keys: fieldKeys(mk.json) } : (mk.json ?? mk.text));
    if (isOk(mk.status) && mk.json && mk.json.id) {
      if (typeof mk.json.token !== 'string' || mk.json.token === '') {
        record(c, 'create returned 200 WITHOUT a token field — token endpoints unusable; B2-B11 SKIPPED');
        return done(c, 'fail');
      }
      registerSecret(mk.json.token);
      probeWebhook.main = { id: String(mk.json.id), token: mk.json.token };
      createdWebhooks.push(probeWebhook.main);
      record(c, `webhook created: id=${probeWebhook.main.id} name=${JSON.stringify(mk.json.name)} (token registered as a secret; never printed)`);
      if (mfaLevel === 1) {
        record(c, 'OBSERVED: webhook create succeeded in an mfa_level:1 community — bots are NOT gated by MFA on this route (KD 20 confirmed live)');
        return done(c, 'pass');
      }
      record(c, `OBSERVED: webhook create accepted on this community (mfa_level=${JSON.stringify(mfaLevel)}). The TWO_FACTOR_REQUIRED question is only observable in an mfa_level:1 community — re-run with --guild <that community> to close it (KD 20: webhook create is NOT gated by the K8 elevated set, so a 200 here is expected either way).`);
      return done(c, 'doc');
    }
    if (mk.code === 'TWO_FACTOR_REQUIRED') {
      record(c, 'OBSERVED: TWO_FACTOR_REQUIRED on webhook create — bots are NOT exempt on MFA-elevated communities; connect fails with the KD 20 sentence');
      return done(c, 'pass'); // the probe's question is answered affirmatively
    }
    record(c, `webhook create refused: HTTP ${mk.status} code=${JSON.stringify(mk.code)} — B2-B11 need a webhook; recorded as a live fact`, mk.json ?? mk.text);
    return done(c, 'fail');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB2() {
  const c = probe('B2', 'Per-message username override (read-back via GET messages)');
  const w = probeWebhook.main;
  if (!w) { record(c, 'no webhook available (B1 did not create one) — UNCONFIRMED'); return done(c, 'skip'); }
  const stamp = Date.now();
  const override = `Bridged Tester ${stamp.toString(36)}`;
  const content = `bridge spike B2 ${stamp}: username override probe`;
  let sent = null;
  try {
    sent = await executeWebhook(w, { username: override, content, allowed_mentions: {} });
    record(c, `POST /webhooks/{id}/{token}?wait=true username=${JSON.stringify(override)} -> ${sent.status}${sent.code ? ` code=${JSON.stringify(sent.code)}` : ''} (rate headers: ${JSON.stringify(sent.headers)})`,
      sent.json && sent.json.id ? { id: sent.json.id, author_keys: fieldKeys(sent.json.author), author_username: sent.json.author && sent.json.author.username } : (sent.json ?? sent.text));
    if (!(isOk(sent.status) && sent.json && sent.json.id)) {
      record(c, `execute did not return a message object — attribution UNCONFIRMED`, sent.json ?? sent.text);
      return done(c, 'fail');
    }
    const mid = String(sent.json.id);
    b2MessageId = mid; // B5/B6 patch/delete this same copy
    createdMessages.push({ channelId: webhookChannelWanted, id: mid });
    const back = await readBack(webhookChannelWanted, mid);
    if (!back.ok) {
      record(c, `read-back GET /channels/{id}/messages did not include the message (ok=${back.ok}, listStatus=${back.listStatus})`);
      return done(c, 'fail');
    }
    const a = back.message.author || {};
    record(c, `read-back author: username=${JSON.stringify(a.username)} global_name=${JSON.stringify(a.global_name)} discriminator=${JSON.stringify(a.discriminator)} bot=${JSON.stringify(a.bot)} author keys: ${fieldKeys(a).join(', ')}`,
      { id: back.message.id, author: a, content: back.message.content, webhook_id: back.message.webhook_id });
    const rendered = String(a.username || '');
    if (rendered === override) {
      record(c, `OBSERVED: rendered author.username == per-message override (${JSON.stringify(override)}) — per-message attribution WORKS (KD 7 success path)`);
      return done(c, 'pass');
    }
    record(c, `OBSERVED: author.username=${JSON.stringify(rendered)} != override ${JSON.stringify(override)} — stored webhook name rendered; KD 7 switches to quote-prefix attribution and §10.7 is revised`);
    return done(c, 'fail'); // "if it comes back false" — the override did not render
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB3() {
  const c = probe('B3', 'avatar_url on execute (accepted? rendered?)');
  const w = probeWebhook.main;
  if (!w) { record(c, 'no webhook available — UNCONFIRMED'); return done(c, 'skip'); }
  const stamp = Date.now();
  // Public, content-free placeholder avatar from Discord's own CDN (no user data, no secret).
  const avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
  try {
    const sent = await executeWebhook(w, { username: `Avatar Probe ${stamp.toString(36)}`, avatar_url: avatarUrl, content: `bridge spike B3 ${stamp}: avatar_url probe`, allowed_mentions: {} });
    record(c, `POST execute with avatar_url=${avatarUrl} -> ${sent.status}${sent.code ? ` code=${JSON.stringify(sent.code)}` : ''}`,
      sent.json && sent.json.id ? { id: sent.json.id, author: sent.json.author } : (sent.json ?? sent.text));
    if (!(isOk(sent.status) && sent.json && sent.json.id)) return done(c, 'fail');
    const mid = String(sent.json.id);
    createdMessages.push({ channelId: webhookChannelWanted, id: mid });
    const back = await readBack(webhookChannelWanted, mid);
    const av = back.ok && back.message.author ? back.message.author.avatar : undefined;
    record(c, `read-back author.avatar=${JSON.stringify(av)} (raw-hash vs URL vs proxy: recorded as observed; visual rendering is a human check)`,
      back.ok ? { id: back.message.id, avatar: av, author: back.message.author } : { listStatus: back.listStatus });
    const accepted = isOk(sent.status) && av != null;
    record(c, accepted
      ? 'OBSERVED: avatar_url accepted (200) and reflected on author.avatar — Discord→Fluxer avatar override is wire-usable; RENDERED check is DOC (human eyeball)'
      : 'OBSERVED: avatar_url not accepted/reflected — omit avatar_url Discord→Fluxer (best-effort avatars, §10.7)');
    return done(c, accepted ? 'pass' : 'fail');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

function pngBytes() {
  // 1x1 red PNG (valid, tiny) — same attachment payload as fluxer-spike.
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
}

async function probeB4() {
  const c = probe('B4', 'Multipart webhook execute attaches bytes');
  const w = probeWebhook.main;
  if (!w) { record(c, 'no webhook available — UNCONFIRMED'); return done(c, 'skip'); }
  const stamp = Date.now();
  try {
    const sent = await executeWebhook(w, { content: `bridge spike B4 ${stamp}: multipart probe`, allowed_mentions: {} },
      [{ name: 'spike.png', data: pngBytes(), contentType: 'image/png' }]);
    record(c, `POST execute multipart/form-data (payload_json + files[0]) -> ${sent.status}${sent.code ? ` code=${JSON.stringify(sent.code)}` : ''}`,
      sent.json && sent.json.attachments ? { id: sent.json.id, attachments: sent.json.attachments } : (sent.json ?? sent.text));
    const att = sent.json && Array.isArray(sent.json.attachments) ? sent.json.attachments[0] : null;
    if (isOk(sent.status) && att && Number(att.size) > 0) {
      record(c, `attachment attached: id=${att.id} filename=${JSON.stringify(att.filename)} size=${att.size} content_type=${JSON.stringify(att.content_type)}; wire field names: ${fieldKeys(att).join(', ')}`);
      createdMessages.push({ channelId: webhookChannelWanted, id: String(sent.json.id) });
      return done(c, 'pass');
    }
    record(c, `no non-empty attachment in the response (status=${sent.status}) — media relay to Fluxer degrades to named skip lines until solved`, sent.json ?? sent.text);
    return done(c, 'fail');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB5() {
  const c = probe('B5', 'Webhook PATCH /webhooks/{id}/{token}/messages/{mid}');
  const w = probeWebhook.main;
  const target = probeTargets.b2;
  if (!w || !target) { record(c, 'no webhook/message to patch (B2 did not run) — UNCONFIRMED'); return done(c, 'skip'); }
  const stamp = Date.now();
  const newContent = `bridge spike B5 ${stamp}: edited via webhook PATCH`;
  try {
    const patch = await tokenCall('PATCH', w.id, w.token, `/messages/${encodeURIComponent(String(target))}`,
      JSON.stringify({ content: newContent }), 'application/json');
    record(c, `PATCH /webhooks/{id}/{token}/messages/{mid} -> ${patch.status}${patch.code ? ` code=${JSON.stringify(patch.code)}` : ''} (edit relay gate)`,
      patch.json ?? patch.text);
    const back = await readBack(webhookChannelWanted, target);
    const edited = back.ok && back.message ? back.message : null;
    record(c, `read-back: content=${JSON.stringify(edited && edited.content)} edited_timestamp=${JSON.stringify(edited && edited.edited_timestamp)}`,
      edited ? { id: edited.id, content: edited.content, edited_timestamp: edited.edited_timestamp } : { listStatus: back.listStatus });
    const ok = isOk(patch.status) && edited && String(edited.content) === newContent;
    record(c, ok
      ? 'OBSERVED: webhook PATCH edits a message the webhook created, content changed on read-back — edit relay supported on this build'
      : `OBSERVED: PATCH status=${patch.status} code=${JSON.stringify(patch.code)} — edit relay to Fluxer is SKIPPED + logged (KD 9 per-platform fallback)`);
    return done(c, ok ? 'pass' : 'fail');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB6() {
  const c = probe('B6', 'Webhook DELETE /webhooks/{id}/{token}/messages/{mid}');
  const w = probeWebhook.main;
  const target = probeTargets.b2;
  if (!w || !target) { record(c, 'no webhook/message to delete (B2 did not run) — UNCONFIRMED'); return done(c, 'skip'); }
  try {
    const del = await tokenCall('DELETE', w.id, w.token, `/messages/${encodeURIComponent(String(target))}`, undefined, undefined);
    record(c, `DELETE /webhooks/{id}/{token}/messages/{mid} -> ${del.status}${del.code ? ` code=${JSON.stringify(del.code)}` : ''} (body length=${(del.text || '').length})`, del.json ?? del.text);
    const back = await readBackGone(webhookChannelWanted, target);
    record(c, `read-back after delete: ${back.present ? 'message STILL PRESENT' : `message gone (direct GET 404 after ${back.attempts} attempt(s)) — expected`} (race-safe single-message GET)`,
      { present: back.present, attempts: back.attempts });
    const ok = (isOk(del.status) || del.status === 404) && !back.present;
    record(c, ok
      ? 'OBSERVED: webhook DELETE removes the copy (204 + direct GET 404) — delete relay supported; moderation story intact'
      : `OBSERVED: DELETE status=${del.status} code=${JSON.stringify(del.code)}, message present after polling — delete relay to Fluxer is SKIPPED + logged; docs must carry the moderation caveat`);
    if (ok) { // remove the pending cleanup entry — the message is already gone
      const i = createdMessages.findIndex(m => String(m.id) === String(target));
      if (i >= 0) createdMessages.splice(i, 1);
    }
    return done(c, ok ? 'pass' : 'fail');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB8() {
  const c = probe('B8', 'Nonce idempotency on webhook execute (5-minute window)');
  const w = probeWebhook.main;
  if (!w) { record(c, 'no webhook available — UNCONFIRMED'); return done(c, 'skip'); }
  const stamp = Date.now();
  const nonce = `brg-spike-${stamp}`;
  try {
    const first = await executeWebhook(w, { content: `bridge spike B8 ${stamp}: nonce probe (delete me)`, nonce, allowed_mentions: {} });
    const second = await executeWebhook(w, { content: `bridge spike B8 ${stamp}: nonce probe (delete me)`, nonce, allowed_mentions: {} });
    record(c, `execute#1 nonce=${nonce} -> ${first.status} id=${first.json && first.json.id}`, first.json && first.json.id ? { id: first.json.id, nonce: first.json.nonce ?? null } : (first.json ?? first.text));
    record(c, `execute#2 same nonce -> ${second.status} id=${second.json && second.json.id} code=${JSON.stringify(second.code)}`, second.json && second.json.id ? { id: second.json.id, nonce: second.json.nonce ?? null } : (second.json ?? second.text));
    const id1 = first.json && first.json.id ? String(first.json.id) : null;
    const id2 = second.json && second.json.id ? String(second.json.id) : null;
    if (id1) createdMessages.push({ channelId: webhookChannelWanted, id: id1 });
    if (id2 && id2 !== id1) createdMessages.push({ channelId: webhookChannelWanted, id: id2 });
    if (id1 && id1 === id2) {
      record(c, 'OBSERVED: same nonce returned the SAME message id — timeout retries inside the nonce window cannot double-post (§10.6 retry policy holds on this build)');
      return done(c, 'pass');
    }
    record(c, `OBSERVED: ids differ (${id1} vs ${id2}) — nonce NOT deduplicating; retry policy must avoid blind post-timeout retries on this platform`);
    return done(c, 'fail');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB10() {
  const c = probe('B10', 'allowed_mentions:{} suppresses a literal @everyone on webhook execute');
  const w = probeWebhook.main;
  if (!w) { record(c, 'no webhook available — UNCONFIRMED'); return done(c, 'skip'); }
  const stamp = Date.now();
  const mentionTarget = botUserId || String(guildWanted);
  const content = `bridge spike B10 ${stamp}: @everyone @here <@${mentionTarget}> <@&${guildWanted}> <#${webhookChannelWanted}> (suppression probe)`;
  try {
    const sent = await executeWebhook(w, { content, allowed_mentions: {} });
    record(c, `POST execute content with literal @everyone/@here/<@id>/<@&id>/<#id>, allowed_mentions={} -> ${sent.status}`,
      sent.json && sent.json.id ? { id: sent.json.id, mention_everyone: sent.json.mention_everyone, mentions: sent.json.mentions, mention_roles: sent.json.mention_roles, mention_channels: sent.json.mention_channels } : (sent.json ?? sent.text));
    if (!(isOk(sent.status) && sent.json && sent.json.id)) return done(c, 'fail');
    const mid = String(sent.json.id);
    createdMessages.push({ channelId: webhookChannelWanted, id: mid });
    const back = await readBack(webhookChannelWanted, mid);
    if (!back.ok) { record(c, 'read-back did not find the message — suppression UNCONFIRMED'); return done(c, 'fail'); }
    const m = back.message;
    const sup = {
      mention_everyone: m.mention_everyone,
      mentions_len: Array.isArray(m.mentions) ? m.mentions.length : typeof m.mentions,
      mention_roles_len: Array.isArray(m.mention_roles) ? m.mention_roles.length : typeof m.mention_roles,
      mention_channels_len: Array.isArray(m.mention_channels) ? m.mention_channels.length : typeof m.mention_channels,
    };
    record(c, `read-back suppression fields: ${JSON.stringify(sup)}`,
      { mention_everyone: m.mention_everyone, mentions: m.mentions, mention_roles: m.mention_roles, mention_channels: m.mention_channels });
    // The §10.11 layer-1 gate is PING suppression: mention_everyone false +
    // empty mentions/mention_roles. mention_channels is a RENDERING field —
    // Fluxer resolves literal <#id> text into display metadata (B14 documents
    // that syntax); an entry there is not a ping and does not fail the probe.
    const clean = m.mention_everyone === false
      && Array.isArray(m.mentions) && m.mentions.length === 0
      && Array.isArray(m.mention_roles) && m.mention_roles.length === 0;
    const channelsNote = Array.isArray(m.mention_channels) && m.mention_channels.length > 0
      ? ` NOTE: mention_channels is non-empty (Fluxer resolves literal <#id> text to display metadata, not a ping — see B14). Relay body-rewrite still neutralizes channel mentions to plain text (§10.11 layer 2).`
      : '';
    record(c, clean
      ? 'OBSERVED: webhook execute with allowed_mentions={} suppresses ALL pings (mention_everyone=false, mentions=[], mention_roles=[]) — layer 1 confirmed on this build. Body-rewrite stays REQUIRED as layer 2 regardless (§10.11: defaults differ per platform and can change).' + channelsNote
      : 'OBSERVED: some PING fields populated despite allowed_mentions={} — webhook execute does NOT fully suppress; body-rewrite becomes load-bearing and must be tested');
    return done(c, clean ? 'pass' : 'fail');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB9() {
  const c = probe('B9', 'Bot account vs NSFW_CONTENT_AGE_RESTRICTED');
  if (!nsfwChannelWanted) {
    record(c, 'no --nsfw-channel / FLUXER_SPIKE_NSFW_CHANNEL: SKIPPED. docs: NSFW_CONTENT_AGE_RESTRICTED is a hard failure for the bot account (§10.9). Re-run with an age-restricted channel id to record bot exemption.');
    return done(c, 'skip');
  }
  try {
    const ch = await apiCall('GET', `/channels/${encodeURIComponent(String(nsfwChannelWanted))}`);
    const nsfwFlag = isOk(ch.status) && ch.json ? ch.json.nsfw : undefined;
    record(c, `GET /channels/{id} -> ${ch.status}; nsfw=${JSON.stringify(nsfwFlag)} type=${JSON.stringify(ch.json && ch.json.type)} (type 0 expected)`);
    if (!(await confirm(`Create the spike webhook in the age-restricted channel ${nsfwChannelWanted} and execute into it? (deleted in cleanup)`))) {
      record(c, 'operator declined the NSFW probe — UNCONFIRMED');
      return done(c, 'skip');
    }
    const mk = await apiCall('POST', `/channels/${encodeURIComponent(String(nsfwChannelWanted))}/webhooks`, { name: WEBHOOK_NAME });
    record(c, `POST /channels/{nsfw_channel}/webhooks -> ${mk.status}${mk.code ? ` code=${JSON.stringify(mk.code)}` : ''}`,
      mk.json && mk.json.id ? { id: mk.json.id, keys: fieldKeys(mk.json) } : (mk.json ?? mk.text));
    if (isOk(mk.status) && mk.json && mk.json.id && typeof mk.json.token === 'string') {
      registerSecret(mk.json.token);
      probeWebhook.nsfw = { id: String(mk.json.id), token: mk.json.token };
      createdWebhooks.push(probeWebhook.nsfw);
      const sent = await executeWebhook(probeWebhook.nsfw, { content: `bridge spike B9 ${Date.now()}: NSFW execute probe`, allowed_mentions: {} });
      record(c, `execute into the age-restricted channel -> ${sent.status}${sent.code ? ` code=${JSON.stringify(sent.code)}` : ''}`, sent.json ?? sent.text);
      if (sent.json && sent.json.id) createdMessages.push({ channelId: nsfwChannelWanted, id: String(sent.json.id) });
      if (sent.code === 'NSFW_CONTENT_AGE_RESTRICTED') {
        record(c, 'OBSERVED: bot/webhook send refused with NSFW_CONTENT_AGE_RESTRICTED — §10.9 hard-failure sentence carries the code');
        return done(c, 'pass');
      }
      record(c, 'OBSERVED: webhook send into the age-restricted channel NOT refused (webhook token path is not age-gated) — the §10.9 restriction binds the bot token path only; recorded for docs');
      return done(c, 'pass');
    }
    if (mk.code === 'NSFW_CONTENT_AGE_RESTRICTED') {
      record(c, 'OBSERVED: webhook CREATE into the age-restricted channel refused with NSFW_CONTENT_AGE_RESTRICTED — bot account is bound by the age restriction (§10.9 hard failure)');
      return done(c, 'pass');
    }
    record(c, `webhook create in NSFW channel failed: HTTP ${mk.status} code=${JSON.stringify(mk.code)} — recorded as a live fact`, mk.json ?? mk.text);
    return done(c, 'fail');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB11() {
  const c = probe('B11', 'Upload size clamp boundary (25 MiB / 50 MiB / 50 MiB+1)');
  const w = probeWebhook.main;
  if (!uploadClampEnabled) {
    record(c, 'SKIPPED by default (heavy uploads). Re-run with --upload-clamp. docs:11 predicts bots clamped to 50 MiB (25 MiB non-premium); the §10.8 constant is 52428800 — this probe fixes the exact boundary.');
    return done(c, 'skip');
  }
  if (!w) { record(c, 'no webhook available — UNCONFIRMED'); return done(c, 'skip'); }
  if (!(await confirm('Run the size-clamp uploads: ~25 MiB + 50 MiB + 50 MiB multipart uploads (slow, uses bandwidth)?'))) {
    record(c, 'operator declined the clamp uploads — UNCONFIRMED');
    return done(c, 'skip');
  }
  const MiB = 1024 * 1024;
  const sizes = [25 * MiB, 50 * MiB, 50 * MiB + 1];
  let attempted = 0;
  try {
    for (const size of sizes) {
      const stamp = Date.now();
      const data = Buffer.alloc(size, 0x61); // opaque filler bytes
      const sent = await executeWebhook(w, { content: `bridge spike B11 ${stamp}: ${size}-byte clamp probe`, allowed_mentions: {} },
        [{ name: `clamp-${size}.bin`, data, contentType: 'application/octet-stream' }]);
      attempted += 1;
      const accepted = isOk(sent.status) && sent.json && Array.isArray(sent.json.attachments) && sent.json.attachments.length > 0;
      if (sent.json && sent.json.id) createdMessages.push({ channelId: webhookChannelWanted, id: String(sent.json.id) });
      record(c, `upload ${size} bytes (multipart, application/octet-stream) -> HTTP ${sent.status} code=${JSON.stringify(sent.code)} attached=${accepted}`,
        sent.json && sent.json.id ? { id: sent.json.id, attachment_sizes: (sent.json.attachments || []).map(a => a.size) } : (sent.json ?? sent.text));
      await sleep(1500); // be gentle on the per-minute webhook rate bucket
    }
    record(c, `boundary recorded above: find the largest accepted size = the live clamp. docs:11 predicts 50 MiB for bots (docs ceiling 52428800). Adjust the §10.8 constant to the observed boundary.`);
    return done(c, attempted === sizes.length ? 'pass' : 'fail');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB12() {
  const c = probe('B12', 'Fluxer avatar URL template (DOC)');
  try {
    const me = await apiCall('GET', '/users/@me');
    if (isOk(me.status) && me.json) {
      record(c, `GET /users/@me -> 200; user field names: ${fieldKeys(me.json).join(', ')}`);
      record(c, `avatar-relevant fields: id=${me.json.id} username=${JSON.stringify(me.json.username)} discriminator=${JSON.stringify(me.json.discriminator)} avatar=${JSON.stringify(me.json.avatar)} global_name=${JSON.stringify(me.json.global_name)} accent_color=${JSON.stringify(me.json.accent_color)}`,
        { id: me.json.id, username: me.json.username, discriminator: me.json.discriminator, avatar: me.json.avatar, global_name: me.json.global_name, accent_color: me.json.accent_color });
    } else {
      record(c, `GET /users/@me -> ${me.status} (recorded)`, me.json ?? me.text);
    }
    if (testUserId) {
      const mem = await apiCall('GET', `/guilds/${encodeURIComponent(String(guildWanted))}/members/${encodeURIComponent(String(testUserId))}`);
      const u = mem.json && mem.json.user ? mem.json.user : null;
      record(c, `GET /guilds/{g}/members/{u} -> ${mem.status}; member user fields: ${u ? fieldKeys(u).join(', ') : 'n/a'}`);
      if (u) record(c, `member user: id=${u.id} username=${JSON.stringify(u.username)} avatar=${JSON.stringify(u.avatar)} (avatar is the hash/id segment the template plugs into)`,
        { id: u.id, username: u.username, discriminator: u.discriminator, avatar: u.avatar });
    } else {
      record(c, 'no --user: member-side avatar fields not sampled (self user sampled). Re-run with --user for the full field set.');
    }
    record(c, 'DOC task for the operator: open any avatar URL the client renders for a user (browser devtools) and record the template here, e.g. {instance}/cdn/avatars/{user_id}/{hash}.png?size=... — record the cdn host, path pattern, extension for animated (a_ prefix), and size parameter support. Until recorded, Fluxer→Discord relay OMITS avatar_url (§10.7).');
    return done(c, 'doc');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB13() {
  const c = probe('B13', 'Webhook POST from Node fetch with NO Origin header');
  const calls = tokenCallProbes.filter(p => p.method === 'POST');
  if (!calls.length) {
    record(c, 'no token-endpoint POST executed in this run (B1/B2 path did not reach execute) — UNCONFIRMED. docs: verified 2026-09-25; re-confirm on the current build.');
    return done(c, 'skip');
  }
  const originSent = calls.filter(p => p.originHeaderSent);
  const rejected = calls.filter(p => p.status === 403 || p.code === 'INVALID_API_ORIGIN');
  record(c, `${calls.length} token-endpoint POST(s) executed via Node global fetch with no Origin header set (this script never sets one). Statuses: ${calls.map(p => `${p.label.split(' ')[0]}:${p.status}${p.code ? '/' + p.code : ''}`).join(', ')}`);
  if (originSent.length) record(c, `NOTE: ${originSent.length} call(s) recorded Origin as explicitly set — script bug, investigate`);
  if (!rejected.length) {
    record(c, 'OBSERVED: all webhook token POSTs accepted with no Origin header (no INVALID_API_ORIGIN) — adapter sends no Origin; adapter docs carry the header-allow-list note (§10.3)');
    return done(c, 'pass');
  }
  record(c, `OBSERVED: ${rejected.length} token POST(s) rejected with 403/INVALID_API_ORIGIN — the endpoint refuses missing/first-party Origin; add the header allow-list note to the adapter`);
  return done(c, 'fail');
}

async function probeB14() {
  const c = probe('B14', 'Channel-mention syntax beyond <#snowflake> (DOC)');
  const stamp = Date.now();
  try {
    // A normal bot-authored message (not a webhook) — the parser/normalizer question.
    // No allowed_mentions sent: <#id> is a parse artifact, not a ping, and an
    // unknown body shape must not 400 the probe.
    const sent = await apiCall('POST', `/channels/${encodeURIComponent(String(webhookChannelWanted))}/messages`, {
      content: `bridge spike B14 ${stamp}: <#${webhookChannelWanted}> plus plain #general text`,
    });
    record(c, `POST /channels/{id}/messages with <#snowflake> + '#general' text -> ${sent.status}`,
      sent.json && sent.json.id ? { id: sent.json.id, mention_channels: sent.json.mention_channels } : (sent.json ?? sent.text));
    if (isOk(sent.status) && sent.json && sent.json.id) {
      const mid = String(sent.json.id);
      createdMessages.push({ channelId: webhookChannelWanted, id: mid });
      const back = await readBack(webhookChannelWanted, mid);
      const mc = back.ok && Array.isArray(back.message.mention_channels) ? back.message.mention_channels : null;
      record(c, `read-back mention_channels: ${mc ? JSON.stringify(mc.map(x => ({ id: x.id, name: x.name, mention_string: x.mention_string, type: x.type }))) : 'n/a'}`,
        back.ok ? { mention_channels: back.message.mention_channels } : { listStatus: back.listStatus });
      const plainHit = mc && mc.some(x => typeof x.mention_string === 'string' && x.mention_string.includes('general'));
      record(c, plainHit
        ? 'OBSERVED: plain #name text produced a mention_channels entry — the parser accepts forms beyond <#snowflake>; the §10.2 channel-arg parser gains the pattern (service unchanged)'
        : 'OBSERVED (this run): only the <#snowflake> token yielded mention_channels — the snowflake form is the canonical pattern. DOC: client UI renderings (e.g. #name autocomplete chips) send <#id> under the hood on this build — confirm with a human client capture before adding a parser pattern.');
    } else {
      record(c, `probe message not created (HTTP ${sent.status}) — syntax probe UNCONFIRMED`, sent.json ?? sent.text);
    }
    return done(c, 'doc');
  } catch (e) { record(c, `error: ${e.message}`); return done(c, 'fail'); }
}

async function probeB7() {
  const c = probe('B7', 'Rate-limit headers on webhook create + execute routes');
  const createProbes = headerProbes.filter(p => String(p.path).endsWith('/webhooks') && p.method === 'POST');
  const webhookPathProbes = headerProbes.filter(p => String(p.path).includes('/webhooks'));
  const names = new Set();
  for (const p of webhookPathProbes) for (const h of Object.keys(p.headers)) names.add(h);
  record(c, `header names observed on ${webhookPathProbes.length} successful webhook-route response(s): ${[...names].sort().join(', ') || 'none'}`);
  for (const p of createProbes.slice(0, 2)) record(c, `${p.method} ${p.path}: ${JSON.stringify(p.headers)}`);
  const exec = webhookPathProbes.find(p => String(p.path).startsWith('POST /webhooks'));
  if (exec) record(c, `first webhook execute headers: ${JSON.stringify(exec.headers)}`);
  record(c, '429 body shape (RATE_LIMITED, retry_after, bucket headers): DOC (docs:10) — not exercised; worker waits at head per §10.10. Rate-limit notes for webhook create: 10/minute/channel; execute: ~60/minute/webhook (docs) — update §10.10 with anything observed.');
  c.unconfirmed.push('429 body shape + Retry-After on the webhook routes: docs-only, not exercised (same open item as the fluxer spike)');
  return done(c, names.size ? 'pass' : 'fail');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let botUserId = null; // set in setup(), used by B10

(async function main() {
  logLine(`Fluxer Bridge Phase 0 spike — ${new Date().toISOString()}`);
  logLine(`url=${base} guild=${guildWanted} webhook_channel=${webhookChannelWanted} nsfw=${nsfwChannelWanted || '(none)'} user=${testUserId || '(none)'} upload_clamp=${uploadClampEnabled ? 'on' : 'off'}\n`);

  // Placeholder setup probe so discovery/auth notes land in the report.
  probe('setup', 'Instance discovery + bot token validity');
  const s = await setup();
  botUserId = s.botUserId;
  done(probes.find(p => p.id === 'setup'), 'pass');

  try {
    await probeB1();
    await probeB2();
    // B5/B6 mutate the copy B2 created; that probe owns its id.
    probeTargets.b2 = b2MessageId;
    await probeB3();
    await probeB4();
    await probeB5();
    await probeB6();
    await probeB8();
    await probeB10();
    await probeB9();
    await probeB11();
    await probeB12();
    await probeB14();
    await probeB7();
    await probeB13();
  } finally {
    await cleanup();
  }

  finalize();
})().catch((err) => {
  process.stderr.write(`FATAL: ${err && err.stack ? redact(err.stack) : redact(String(err))}\n`);
  cleanup().catch(() => { /* best effort */ }).finally(() => process.exit(2));
});

function finalize() {
  const unconfirmed = [];
  for (const c of probes) for (const u of c.unconfirmed) unconfirmed.push(`${c.id}: ${u}`);

  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    url: base,
    guild: guildWanted,
    webhook_channel: webhookChannelWanted,
    nsfw_channel: nsfwChannelWanted || null,
    user: testUserId || null,
    upload_clamp: uploadClampEnabled,
    bot_user_id: botUserId,
    webhook_created: probeWebhook.main ? probeWebhook.main.id : null,
    probes: probes.map(c => ({ id: c.id, name: c.name, status: c.status, notes: c.notes, unconfirmed: c.unconfirmed, evidence: c.evidence })),
    cleanup_failures: cleanupFailures,
    unconfirmed,
  };

  const ts = startedAt.replace(/[:.]/g, '-');
  const outPath = opts.out || path.join(__dirname, '..', '.tmp', `fluxer-bridge-spike-results-${ts}.json`);
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(redactJson(summary), null, 2));
    logLine(`\nReport written: ${outPath}`);
  } catch (e) { logLine(`\nReport write failed: ${e.message}`); }

  const counts = {};
  for (const c of probes) counts[c.status] = (counts[c.status] || 0) + 1;
  logLine(`Status: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  if (opts.markdown) {
    logLine('\n--- markdown summary (paste-able into roadmap/bridge.md §10.14 results table) ---\n');
    logLine('| # | Probe | Status | Observed |');
    logLine('|---|-------|--------|----------|');
    for (const c of probes) {
      if (c.id === 'setup') continue;
      const obs = c.notes.slice(0, 2).join(' ').replace(/\|/g, '\\|').slice(0, 300);
      logLine(`| ${c.id} | ${c.name} | ${c.status.toUpperCase()} | ${obs} |`);
    }
  }
}

process.on('SIGINT', () => {
  logLine('\nSIGINT — running cleanup and writing partial report');
  cleanup().catch(() => { /* best effort */ }).finally(() => { finalize(); process.exit(130); });
});
