/**
 * #466 (C2-8): the root guild list fans the tier resolves out CONCURRENTLY.
 *
 * Pre-fix, GET "/" looped `await resolver.resolve(...)` per guild — cold
 * cache (the first load right after login, exactly when the user waits),
 * that serialized up to MAX_ROOT_GUILDS networked member-reads. The rows
 * are independent; Promise.all keeps the cap and the order.
 *
 * The stub resolver counts CONCURRENCY directly (peak overlapping calls)
 * rather than timing — deterministic: sequential code can never exceed 1.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");

const { loadDb, communityKey } = require("./helpers/env");

// Clearly-fake placeholder only (AGENTS.md: never realistic secrets).
process.env.SESSION_SECRET = "test-c28-fake-secret";

const { api, cleanup } = loadDb(); // CONTRACT: temp DB before any src/ require

const appMod = require("../src/web/app");
const sessionPolicy = require("../src/web/auth/sessions");
const tokens = require("../src/web/auth/tokens");

after(cleanup);

const GUILDS = Array.from({ length: 5 }, (_, i) => `70000000000000000${i + 1}`);
const CIDS = [];

describe("#466 (C2-8): root guild list resolves tiers concurrently", () => {
  let server;
  let base;
  let cookie;

  before(async () => {
    for (const g of GUILDS) CIDS.push(communityKey(g));
    const s = sessionPolicy.createSession({ userId: "800000000000000009", discordTag: "c28#0001" });
    api.setWebSessionAuth(s.id, {
      accessTokenEnc: tokens.encryptAccessToken("tok-c28"),
      tokenExpiresAt: Date.now() + 3_600_000,
      scopes: "identify guilds guilds.members.read",
      guildSnapshot: "[]",
    });
    cookie = `web_session=${s.id}`;

    const delay = () => new Promise((r) => setTimeout(r, 25));
    const fan = { active: 0, peak: 0, calls: 0 };
    const resolver = {
      async listGuilds() {
        return {
          reauth: false,
          guilds: GUILDS.map((id, i) => ({
            id,
            communityId: CIDS[i],
            name: `Guild ${i + 1}`,
            icon: null,
          })),
        };
      },
      async resolve() {
        fan.calls += 1;
        fan.active += 1;
        fan.peak = Math.max(fan.peak, fan.active);
        await delay();
        fan.active -= 1;
        return { status: "ok", tier: "staff" };
      },
    };

    const app = appMod.createWebApp({
      guildAccess: resolver,
      botGuilds: async () => [],
    });
    server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    globalThis.__c28fan = fan;
  });

  after(() => {
    if (server) server.close();
  });

  it("paints every guild and never stacks the resolves one-deep", async () => {
    const res = await fetch(`${base}/`, { headers: { cookie } });
    const body = await res.text();
    assert.equal(res.status, 200, body.slice(0, 300));
    for (let i = 0; i < GUILDS.length; i++) {
      assert.ok(body.includes(`Guild ${i + 1}`), `guild ${i + 1} listed`);
    }
    const fan = globalThis.__c28fan;
    assert.equal(fan.calls, GUILDS.length, "every listed guild got its resolve");
    assert.ok(
      fan.peak >= 3,
      `tier resolves ran CONCURRENTLY (peak overlap ${fan.peak}; sequential code pins it at 1 — the cold-cache root page paid every read back-to-back)`,
    );
  });
});
