/**
 * Access-matrix harness for the web admin console security suites
 * (roadmap/web-admin.md §8.11 "Access matrix suite + cross-guild probe";
 * subtask 13 — Phase 0c exit gate, reused by the Phase 1/2/3 suites).
 *
 * MECHANISM ONLY — deliberately ZERO coupling:
 *  - no route hardcoding: suites enumerate the LIVE Express 5 router
 *    (app.router.stack), so Phase 1/2/3 suites pick up every newly mounted
 *    GET route automatically — adding a row never means editing this file;
 *  - no src/ requires: the SQLite facade, session policy, token vault and
 *    transcript writer are all INJECTED as arguments, so a loadDb() require
 *    -cache reset can never leave this helper holding stale module bindings;
 *  - no expectations: the (viewer × target) outcomes live in the suite; this
 *    module only provides byte-exact assertion primitives to declare/run them.
 *
 * Byte-exact contracts asserted (mirroring the live src/web responses):
 *  - generic 404: body exactly "Not found" (text/plain) — never 403, never
 *    an echo of ids/tokens/names (§8.6 cross-cutting, §8.13-10);
 *  - login redirect: 302 + exact Location + `Cache-Control: no-store` +
 *    `Referrer-Policy: no-referrer` + EMPTY body (§8.1-3, §8.7);
 *  - legacy 405: body exactly "Method not allowed" (§8.8 Phase 0a parity);
 *  - allowed transcript: 200 HTML carrying the unique fixture marker;
 *  - allowed asset: 200 with byte-identical fixture bytes.
 */

const assert = require("node:assert/strict");

/**
 * Stable structural marker of the authenticated guild shell (src/web/views/
 * layout.js `<header class="shell-bar">`). Used by the shellOk outcome —
 * a denied/plain page can never contain it.
 */
const SHELL_MARKER = "shell-bar";

// ---------------------------------------------------------------------------
// Live-app route enumeration (Express 5: `app.router` lazy getter → Router
// instance with `.stack`; route layers carry `route.path` + `route.methods`).
// ---------------------------------------------------------------------------

/**
 * Enumerate every GET route currently mounted on the app, deduped by path.
 * Middleware layers (app.use) have no `route` and are skipped — the suites
 * care about the RESPONSE surface, and every /g/:guildId middleware mount is
 * exercised transitively by the routes behind it.
 *
 * @param {import("express").Express} app
 * @returns {Array<{path: string, params: string[]}>}
 */
function listGetRoutes(app) {
  const router = app.router || app._router;
  if (!router || !Array.isArray(router.stack)) {
    throw new TypeError("listGetRoutes: expected an Express app exposing router.stack");
  }
  const routes = [];
  const seen = new Set();
  for (const layer of router.stack) {
    const route = layer && layer.route;
    if (!route || !route.methods || route.methods.get !== true) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    for (const p of paths) {
      if (typeof p !== "string" || seen.has(p)) continue;
      seen.add(p);
      routes.push({ path: p, params: extractRouteParams(p) });
    }
  }
  return routes;
}

/**
 * Named `:param` segments of a route path (order of appearance, deduped).
 * @param {string} routePath
 * @returns {string[]}
 */
function extractRouteParams(routePath) {
  const params = [];
  const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(routePath)) !== null) {
    if (!params.includes(m[1])) params.push(m[1]);
  }
  return params;
}

/**
 * Concrete URL for a route path with every `:param` replaced from `subs`.
 * Throws on a missing substitution or an unsupported `{*wildcard}` token so
 * a suite can NEVER silently sweep a route it failed to instantiate (raw
 * legacy-regex surfaces like /t/{*splat} are enumerated by hand instead).
 * @param {string} routePath
 * @param {Record<string, string|number>} subs
 * @returns {string}
 */
function buildConcretePath(routePath, subs) {
  if (/\{[^}]*\}/.test(routePath)) {
    throw new Error(
      `buildConcretePath: wildcard token in "${routePath}" is not auto-instantiable — enumerate that surface manually`
    );
  }
  return routePath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_full, name) => {
    const value = subs[name];
    if (value == null || value === "") {
      throw new Error(`buildConcretePath: no substitution for ":${name}" in "${routePath}"`);
    }
    return encodeURIComponent(String(value));
  });
}

// ---------------------------------------------------------------------------
// HTTP client (ephemeral-port fetch, manual redirects, byte-safe bodies)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} HttpResult
 * @property {number} status
 * @property {Headers} headers
 * @property {Buffer} raw response bytes (assets compare byte-exactly)
 * @property {string} body utf8 view (leak scans are ASCII markers — safe)
 * @property {string|null} location
 */

/**
 * GET/HEAD/POST … with redirect:manual and the opaque web_session cookie.
 * @param {string} base e.g. http://127.0.0.1:PORT
 * @param {string} urlPath starts with "/"
 * @param {{method?: string, cookieId?: string|null}} [opts]
 * @returns {Promise<HttpResult>}
 */
async function request(base, urlPath, opts = {}) {
  const res = await fetch(`${base}${urlPath}`, {
    method: opts.method || "GET",
    redirect: "manual",
    headers: opts.cookieId ? { cookie: `web_session=${opts.cookieId}` } : undefined,
  });
  const raw = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: res.headers,
    raw,
    body: raw.toString("utf8"),
    location: res.headers.get("location"),
  };
}

// ---------------------------------------------------------------------------
// Outcome specs + one call-site runner ("one call-site per route" — §8.11)
// ---------------------------------------------------------------------------

/** @param {string} location exact Location header expected */
function expectLoginRedirect(location) {
  return { kind: "login", location };
}
/** @param {{forbid?: string[]}} [opts] substrings that must NEVER appear */
function expectGenericNotFound(opts = {}) {
  return { kind: "notFound", forbid: opts.forbid || [] };
}
/** @param {string} marker unique fixture string inside the transcript */
function expectTranscriptOk(marker) {
  return { kind: "transcript", marker };
}
/** @param {Buffer} bytes exact asset bytes */
function expectAssetOk(bytes) {
  return { kind: "asset", bytes };
}
function expectMethodNotAllowed() {
  return { kind: "methodNotAllowed" };
}
/**
 * Allowed page INSIDE the guild shell: 200 HTML, contains the shell markers
 * AND the page-specific heading marker (unique per page), Cache-Control
 * no-store (console pages are session-scoped — §8.7). Phase 1+ gate suites
 * (subtask 23) use this for the tier-permitted cells.
 * @param {string} marker unique heading string rendered by the page
 */
function expectShellOk(marker) {
  return { kind: "shellOk", marker };
}
/**
 * Right-guild, wrong-tier denial: the FIXED generic 403 (body exactly
 * "Forbidden") from src/web/middleware/requireTier.js — generic 404 would be
 * wrong here (viewer IS in the guild) and anything richer would leak.
 */
function expectForbidden() {
  return { kind: "forbidden" };
}

/**
 * Run ONE matrix cell: fetch (base+url as viewer cookieId) and assert the
 * declared outcome byte-exactly. Denials NEVER get an escape hatch: bodies
 * are compared with strict equality, so no title/snippet/uuid echo survives.
 *
 * @param {object} cell
 * @param {string} cell.base
 * @param {string} cell.url
 * @param {string|null} [cell.cookieId]
 * @param {string} [cell.method]
 * @param {ReturnType<typeof expectGenericNotFound>} cell.expect
 * @param {string} [cell.label]
 * @returns {Promise<HttpResult>}
 */
async function runOutcome(cell) {
  const res = await request(cell.base, cell.url, {
    method: cell.method,
    cookieId: cell.cookieId ?? null,
  });
  const label = cell.label ? `${cell.label} ` : "";
  const e = cell.expect;
  if (e.kind === "login") {
    assert.equal(res.status, 302, `${label}${cell.url}: status`);
    assert.equal(res.location, e.location, `${label}${cell.url}: Location`);
    assert.equal(res.headers.get("cache-control"), "no-store", `${label}${cell.url}: no-store`);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer", `${label}${cell.url}: no-referrer`);
    assert.equal(res.body, "", `${label}${cell.url}: body must be empty pre-login (§8.1-3)`);
  } else if (e.kind === "notFound") {
    assert.equal(res.status, 404, `${label}${cell.url}: status must be 404 (never 403/302, §8.6)`);
    assert.equal(res.body, "Not found", `${label}${cell.url}: body must be the generic 404`);
    assert.equal(
      res.headers.get("content-type"),
      "text/plain; charset=utf-8",
      `${label}${cell.url}: content-type`
    );
    assertNoEcho(res, e.forbid);
  } else if (e.kind === "transcript") {
    assert.equal(res.status, 200, `${label}${cell.url}: status`);
    assert.match(res.headers.get("content-type") || "", /^text\/html/, `${label}${cell.url}: content-type`);
    assert.ok(
      res.body.includes(e.marker),
      `${label}${cell.url}: transcript body must contain the fixture marker`
    );
    assert.equal(
      res.headers.get("cache-control"),
      "private, max-age=300",
      `${label}${cell.url}: transcript cache framing`
    );
  } else if (e.kind === "asset") {
    assert.equal(res.status, 200, `${label}${cell.url}: status`);
    assert.equal(res.raw.length, e.bytes.length, `${label}${cell.url}: asset byte length`);
    assert.ok(res.raw.equals(e.bytes), `${label}${cell.url}: asset bytes must match the fixture`);
    assert.equal(
      res.headers.get("cache-control"),
      "private, max-age=86400",
      `${label}${cell.url}: asset cache framing`
    );
  } else if (e.kind === "shellOk") {
    assert.equal(res.status, 200, `${label}${cell.url}: status`);
    assert.match(res.headers.get("content-type") || "", /^text\/html/, `${label}${cell.url}: content-type`);
    assert.ok(
      res.body.includes(SHELL_MARKER),
      `${label}${cell.url}: page must render inside the guild shell`
    );
    assert.ok(
      res.body.includes(e.marker),
      `${label}${cell.url}: page body must contain its heading marker`
    );
    assert.equal(
      res.headers.get("cache-control"),
      "no-store",
      `${label}${cell.url}: console pages must be no-store`
    );
  } else if (e.kind === "forbidden") {
    assert.equal(res.status, 403, `${label}${cell.url}: in-guild wrong-tier must be 403 (§8.6 tier table)`);
    assert.equal(res.body, "Forbidden", `${label}${cell.url}: body must be the fixed generic 403`);
    assert.equal(
      res.headers.get("content-type"),
      "text/plain; charset=utf-8",
      `${label}${cell.url}: content-type`
    );
    assert.equal(res.headers.get("cache-control"), "no-store", `${label}${cell.url}: no-store`);
  } else if (e.kind === "methodNotAllowed") {
    assert.equal(res.status, 405, `${label}${cell.url}: status must be the legacy 405 (§8.8 0a parity)`);
    assert.equal(res.body, "Method not allowed", `${label}${cell.url}: body`);
    assert.equal(
      res.headers.get("content-type"),
      "text/plain; charset=utf-8",
      `${label}${cell.url}: content-type`
    );
    assert.equal(res.location, null, `${label}${cell.url}: 405 must not redirect (fires BEFORE auth)`);
  } else {
    throw new Error(`runOutcome: unknown expectation kind ${e && e.kind}`);
  }
  return res;
}

/**
 * Shared leak gate: the raw bytes must contain NONE of the forbidden
 * markers (uuid tokens, unique transcript markers, guild names).
 * @param {HttpResult} res
 * @param {string[]} forbid
 */
function assertNoEcho(res, forbid) {
  for (const needle of forbid) {
    if (!needle) continue;
    assert.ok(
      !res.body.includes(needle),
      `denied response echoed "${needle}" (§8.4/§8.6 leak gate)`
    );
  }
}

// ---------------------------------------------------------------------------
// Seeding helpers (everything src-facing is injected — see file header)
// ---------------------------------------------------------------------------

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * Real session row + encrypted AT + guild snapshot (the offline-login
 * pattern established by test/web-ticket-gating.test.js /
 * test/web-tier-middleware.test.js — sessions are minted directly, no OAuth
 * round trip).
 *
 * @param {{api: object, sessionPolicy: object, tokens: object}} deps injected src modules
 * @param {string} userId
 * @param {{snapshotEntries?: Array<object>, corrupt?: boolean, token?: string}} [opts]
 * @returns {string} the session id (cookie value)
 */
function createLoginSession(deps, userId, opts = {}) {
  const { api, sessionPolicy, tokens } = deps;
  const s = sessionPolicy.createSession({ userId });
  api.setWebSessionAuth(s.id, {
    accessTokenEnc: opts.corrupt
      ? "v1.junk.junk.junk"
      : tokens.encryptAccessToken(opts.token || `tok-${userId}`),
    tokenExpiresAt: Date.now() + 3_600_000,
    scopes: "identify guilds guilds.members.read",
    guildSnapshot: JSON.stringify(opts.snapshotEntries || []),
  });
  return s.id;
}

/**
 * Create + archive a ticket with a REAL transcript file (unique marker) and
 * an optional real asset under DATA_DIR — the same repository path the
 * production close flow writes (tickets/transcript.js).
 *
 * @param {object} deps {api, writeTranscriptFile, absoluteAssetsDir, fs, path, png}
 * @param {object} spec {guildId, creatorUserId, channelId, reason, marker, assetName, withAsset}
 * @returns {{token: string, ticket: object, assetName: string}}
 */
function seedArchivedTicket(deps, spec) {
  const { api, writeTranscriptFile, absoluteAssetsDir, fs, path } = deps;
  const assetName = spec.assetName || "001_photo.png";
  const token = api.generateTranscriptToken();
  const ticket = api.createTicket({
    guildId: spec.guildId,
    creatorUserId: spec.creatorUserId,
    channelId: spec.channelId,
    reason: spec.reason,
  });
  const written = writeTranscriptFile(
    { ...ticket, close_reason: spec.reason, closed_at: Date.now() },
    token,
    [
      {
        message_id: `msg-${token.slice(0, 8)}`,
        author_id: spec.creatorUserId,
        author_tag: "exit-fixture",
        content: spec.marker,
        attachment_urls: spec.withAsset
          ? [{ href: `/t/${token}/assets/${assetName}`, name: assetName, kind: "image" }]
          : [],
        sent_at: Date.now(),
      },
    ]
  );
  if (spec.withAsset) {
    const dir = absoluteAssetsDir(spec.guildId, token);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, assetName), deps.png || PNG);
  }
  api.markTicketClosed(ticket.id, { closedBy: "mod", closeReason: spec.reason });
  api.closeTicketArchived(ticket.id, {
    closedBy: "mod",
    closeReason: spec.reason,
    transcriptToken: token,
    transcriptPath: written.relativePath,
  });
  return { token, ticket: api.getTicketById(ticket.id), assetName };
}

/**
 * Enumerate GET routes whose path starts with a prefix (suites filter to
 * "/g/" for the guild-scoped surfaces).
 * @param {import("express").Express} app
 * @param {string} prefix
 * @returns {Array<{path: string, params: string[]}>}
 */
function listGetRoutesUnder(app, prefix) {
  return listGetRoutes(app).filter((r) => r.path === prefix || r.path.startsWith(prefix));
}

module.exports = {
  listGetRoutes,
  listGetRoutesUnder,
  extractRouteParams,
  buildConcretePath,
  request,
  runOutcome,
  assertNoEcho,
  expectLoginRedirect,
  expectGenericNotFound,
  expectTranscriptOk,
  expectAssetOk,
  expectMethodNotAllowed,
  expectShellOk,
  expectForbidden,
  SHELL_MARKER,
  createLoginSession,
  seedArchivedTicket,
  PNG,
};
