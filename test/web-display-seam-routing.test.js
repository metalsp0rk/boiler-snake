/**
 * #899 (audit r4 F7): the display seams take the INTEGER community id, and
 * the ROUTES must pass it. Post Fluxer PR 2/10 the seams
 * (resolveMemberNames / isProvenBot) route per platform from the cid
 * (Fluxer display-name cache / Discord member cache via the communities
 * row), but ~15 route call sites kept threading req.guildAccess.guildId —
 * the external snowflake. toCommunityId(snowflake) is null, so the routing
 * NEVER RAN in production: Fluxer communities rendered raw ids forever
 * (names + bot-presence proof could not come from the right platform), and
 * every Fluxer page silently hit the Discord-cache branch with a key that
 * can never exist there.
 *
 * The seam-level cid behavior was pinned at PR 10 (fluxer-web-session);
 * nothing pinned what the ROUTES actually pass. This file drives REAL
 * routes over HTTP and reads what the seam received.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");

const { loadDb, communityKey } = require("./helpers/env");

process.env.SESSION_SECRET = "test-f7-fake-secret"; // clearly-fake placeholder

const { api, cleanup } = loadDb(); // CONTRACT: temp DB before any src/ require

const appMod = require("../src/web/app");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");

after(cleanup);

const FX_INSTANCE = "f7-instance";
const FX_COMMUNITY = "930000000000000001"; // Fluxer community (external id)
const DISC_COMMUNITY = "700000000000000009"; // Discord community (snowflake)
const FX_TARGET = "111000000000000001"; // looked-up Fluxer user
const DISC_TARGET = "222000000000000002"; // looked-up Discord member
const FX_NAME = "Pixel-Puck";
const DISC_NAME = "DiscordDan";
const LEAK_NAME = "cross-platform-leak"; // planted under FX_TARGET in the DISCORD cache

let CID_FX;
let CID_DISC;
let server;
let base;
let cookieFx;
let cookieDisc;

const fxWarmCalls = [];
const fxOutbound = {
  botUserId: "939999999999999999",
  async fetchUser(_cid, userId) {
    fxWarmCalls.push(userId);
    return { id: userId, username: FX_NAME, bot: false };
  },
};

/** Fake discord.js client: one guild keyed by the EXTERNAL snowflake. */
function makeFakeDiscordClient() {
  const members = new Map([
    // FX_TARGET is planted HERE on purpose: a Fluxer route that misroutes
    // to this cache would render LEAK_NAME instead of the Fluxer name.
    [DISC_TARGET, { displayName: DISC_NAME, user: { username: DISC_NAME, bot: false } }],
    [FX_TARGET, { displayName: LEAK_NAME, user: { username: LEAK_NAME, bot: false } }],
  ]);
  const guild = { id: DISC_COMMUNITY, members: { cache: members }, name: "Disc Guild" };
  const guilds = new Map([[DISC_COMMUNITY, guild]]);
  return {
    guilds: { cache: { get: (k) => guilds.get(String(k)) ?? null } },
    users: { cache: { get: () => null } },
  };
}

const resolverStub = {
  async resolve() {
    return { status: "ok", tier: "admin" };
  },
  async listGuilds() {
    return { reauth: false, guilds: [], degraded: false };
  },
};

async function lookupName(cid, cookie, q) {
  const res = await fetch(`${base}/g/${cid}/lookups/users?q=${q}`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200, `lookup must answer 200 (got ${res.status})`);
  const body = await res.json();
  assert.equal(body.exact, true, "exact-id answer expected");
  return body.users[0]?.name ?? null;
}

/** Poll a lookup until the background Fluxer warm lands (or budget dies). */
async function lookupNameSettled(cid, cookie, q, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const name = await lookupName(cid, cookie, q);
    if (name !== null || Date.now() > deadline) return name;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("#899: routes feed the display seam the INTEGER cid (real HTTP)", () => {
  before(async () => {
    CID_FX = communityKey(FX_COMMUNITY, "fluxer", FX_INSTANCE);
    CID_DISC = communityKey(DISC_COMMUNITY);

    const app = appMod.createWebApp({
      guildAccess: resolverStub,
      botGuilds: async () => [],
      getClient: makeFakeDiscordClient,
      getCommunityClient: (cid) => (cid === CID_FX ? fxOutbound : null),
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    const fx = sessionPolicy.createSession({
      userId: "111000000000000009",
      platform: "fluxer",
      instanceKey: FX_INSTANCE,
    });
    api.setWebSessionAuth(fx.id, {
      accessTokenEnc: tokens.encryptAccessToken("tok-f7-fx"),
      tokenExpiresAt: Date.now() + 2 * 3_600_000,
      scopes: "identify guilds",
      guildSnapshot: JSON.stringify([
        { id: FX_COMMUNITY, name: "FX", icon: null, owner: true, permissions: "0" },
      ]),
    });
    const disc = sessionPolicy.createSession({ userId: "222000000000000009" });
    api.setWebSessionAuth(disc.id, {
      accessTokenEnc: tokens.encryptAccessToken("tok-f7-disc"),
      tokenExpiresAt: Date.now() + 2 * 3_600_000,
      scopes: "identify guilds",
      guildSnapshot: JSON.stringify([
        { id: DISC_COMMUNITY, name: "Disc", icon: null, owner: true, permissions: "0" },
      ]),
    });
    cookieFx = `web_session_fx=${fx.id}`;
    cookieDisc = `web_session=${disc.id}`;
  });

  after(() => {
    if (server) server.close();
  });

  it("Fluxer community: the name resolves from the FLUXER cache, never the Discord cache", async () => {
    // Pre-fix the route passed the snowflake → toCommunityId null → the
    // Discord branch with a key that never exists → name stayed NULL
    // FOREVER (no warm, no routing). Post-fix the first miss warms via
    // outbound.fetchUser and the next render carries the real name.
    assert.equal(fxWarmCalls.length, 0);
    const name = await lookupNameSettled(CID_FX, cookieFx, FX_TARGET);
    assert.equal(
      name,
      FX_NAME,
      "the Fluxer display name must reach the route (pre-fix: null forever — the F7 repro)",
    );
    assert.notEqual(name, LEAK_NAME, "the Fluxer surface never reads the Discord cache");
    assert.ok(fxWarmCalls.includes(FX_TARGET), "the warm went through the Fluxer outbound");
  });

  it("Discord community: the cid maps through the registry to the member cache", async () => {
    // The seam now receives the cid and resolves the EXTERNAL snowflake
    // itself — the hit must land with zero warm (member is cached).
    const name = await lookupName(CID_DISC, cookieDisc, DISC_TARGET);
    assert.equal(name, DISC_NAME, "the Discord member name renders through the cid→snowflake map");
  });
});

describe("#899 guardrail: no route may re-feed the seams the snowflake", () => {
  const ROUTES_DIR = path.join(__dirname, "..", "src", "web", "routes");

  /** Extract the 2nd argument of every seam call at paren depth zero. */
  function secondArgs(src) {
    const out = [];
    const re = /(resolveMemberNames|isProvenBot)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      let i = m.index + m[0].length;
      let depth = 1;
      let commas = 0;
      let arg2 = "";
      for (; i < src.length && depth > 0; i++) {
        const c = src[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          depth--;
          if (depth === 0) break;
        } else if (c === "," && depth === 1) {
          commas++;
          continue;
        }
        if (commas === 1) arg2 += c;
      }
      out.push(arg2.trim());
    }
    return out;
  }

  it("every seam call in src/web/routes passes a communityId expression (never guildId/ext)", () => {
    const files = fs
      .readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".js"))
      .map((f) => path.join(ROUTES_DIR, f));
    let checked = 0;
    for (const file of files) {
      if (path.basename(file) === "discord-cache.js") continue; // the seam itself lives in shared/
      const src = fs.readFileSync(file, "utf8");
      for (const arg of secondArgs(src)) {
        checked++;
        assert.doesNotMatch(
          arg,
          /guildId|\bext\b|external/i,
          `${path.basename(file)}: seam 2nd arg is "${arg}" — pass the INTEGER community id (#899)`,
        );
        assert.match(
          arg,
          /communityId|^cid$/, // `cid` is transcripts.js' scoped community-id alias
          `${path.basename(file)}: seam 2nd arg "${arg}" must be a communityId expression (#899)`,
        );
      }
    }
    assert.ok(checked >= 15, `the census found ${checked} seam calls — the scan silently broke (was ~20)`);
  });
});
