const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  createEventsubSubscription,
  deleteEventsubSubscription,
  listEventsubSubscriptions,
  fetchClips,
  fetchArchives,
  parseTwitchTimestamp,
  clearAppTokenCache,
} = require("../src/features/twitch/helix");

/**
 * Stub global fetch with a route table; records every request (url + init).
 * Mirrors test/twitch-helix.test.js's helper (kept local so both files stay
 * independent).
 */
async function withFetchStub(routes, env = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => r.match(String(url), init));
    if (!route) throw new Error(`unstubbed fetch: ${url}`);
    return route.respond(String(url), init);
  };
  const prev = {
    id: process.env.TWITCH_CLIENT_ID,
    secret: process.env.TWITCH_CLIENT_SECRET,
  };
  process.env.TWITCH_CLIENT_ID = env.id ?? "test-client-id";
  process.env.TWITCH_CLIENT_SECRET = env.secret ?? "test-client-secret";
  clearAppTokenCache();
  const restore = () => {
    globalThis.fetch = original;
    if (prev.id == null) delete process.env.TWITCH_CLIENT_ID;
    else process.env.TWITCH_CLIENT_ID = prev.id;
    if (prev.secret == null) delete process.env.TWITCH_CLIENT_SECRET;
    else process.env.TWITCH_CLIENT_SECRET = prev.secret;
    clearAppTokenCache();
  };
  return { calls, restore };
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const noContentResponse = (status = 204) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    throw new Error("no body");
  },
});

const tokenRoute = {
  match: (u) => u.includes("id.twitch.tv/oauth2/token"),
  respond: () => jsonResponse({ access_token: "tok-1", expires_in: 3600 }),
};

describe("createEventsubSubscription", () => {
  it("POSTs the webhook transport and maps 202 to ok", async () => {
    const created = {
      data: [
        {
          id: "sub-uuid-1",
          status: "webhook_callback_verification_pending",
          type: "stream.online",
        },
      ],
    };
    const { calls, restore } = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/eventsub/subscriptions"),
        respond: () => jsonResponse(created, 202),
      },
    ]);
    try {
      const res = await createEventsubSubscription({
        type: "stream.online",
        condition: { broadcaster_user_id: "1234" },
        callback: "https://bot.example.com/hooks/twitch",
        secret: "s3cret-least-10-chars",
      });
      assert.equal(res.ok, true);
      assert.equal(res.subscription.id, "sub-uuid-1");
      assert.equal(res.status, 202);
      const post = calls.find((c) => c.url.includes("/helix/eventsub/subscriptions"));
      assert.equal(post.init.method, "POST");
      const body = JSON.parse(post.init.body);
      assert.equal(body.type, "stream.online");
      assert.equal(body.version, "1");
      assert.deepEqual(body.condition, { broadcaster_user_id: "1234" });
      assert.deepEqual(body.transport, {
        method: "webhook",
        callback: "https://bot.example.com/hooks/twitch",
        secret: "s3cret-least-10-chars",
      });
    } finally {
      restore();
    }
  });

  it("maps 409 to ok+conflict (duplicate type+condition)", async () => {
    const { restore } = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/eventsub/subscriptions"),
        respond: () =>
          jsonResponse(
            { error: "Conflict", message: "already exists", data: [{ id: "sub-existing" }] },
            409,
          ),
      },
    ]);
    try {
      const res = await createEventsubSubscription({
        type: "stream.offline",
        condition: { broadcaster_user_id: "1234" },
        callback: "https://bot.example.com/hooks/twitch",
        secret: "s3cret-least-10-chars",
      });
      assert.equal(res.ok, true);
      assert.equal(res.conflict, true);
      assert.equal(res.subscription.id, "sub-existing");
    } finally {
      restore();
    }
  });

  it("maps 422 (quota/auth) to a specific error", async () => {
    const { restore } = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/eventsub/subscriptions"),
        respond: () =>
          jsonResponse({ error: "Unprocessable Entity", message: "quota exceeded" }, 422),
      },
    ]);
    try {
      const res = await createEventsubSubscription({
        type: "stream.online",
        condition: { broadcaster_user_id: "1234" },
        callback: "https://bot.example.com/hooks/twitch",
        secret: "s3cret-least-10-chars",
      });
      assert.equal(res.ok, false);
      assert.equal(res.status, 422);
      assert.match(res.error, /quota exceeded/);
    } finally {
      restore();
    }
  });

  it("network failure yields ok:false with network error", async () => {
    const { restore } = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/eventsub/subscriptions"),
        respond: () => {
          throw Object.assign(new TypeError("fetch failed"), {
            cause: new Error("socket hang up"),
          });
        },
      },
    ]);
    try {
      const res = await createEventsubSubscription({
        type: "stream.online",
        condition: { broadcaster_user_id: "1234" },
        callback: "https://bot.example.com/hooks/twitch",
        secret: "s3cret-least-10-chars",
      });
      assert.equal(res.ok, false);
      assert.equal(res.status, 0);
      assert.equal(res.error, "network error");
    } finally {
      restore();
    }
  });

  it("401 refreshes the app token and retries once", async () => {
    let tokenRequests = 0;
    let postRequests = 0;
    const { calls, restore } = await withFetchStub([
      {
        match: (u) => u.includes("id.twitch.tv/oauth2/token"),
        respond: () =>
          jsonResponse({ access_token: `tok-${++tokenRequests}`, expires_in: 3600 }),
      },
      {
        match: (u) => u.includes("/helix/eventsub/subscriptions"),
        respond: () =>
          postRequests++ === 0
            ? jsonResponse({ error: "Unauthorized" }, 401)
            : jsonResponse({ data: [{ id: "sub-new", status: "webhook_callback_verification_pending" }] }, 202),
      },
    ]);
    try {
      const res = await createEventsubSubscription({
        type: "stream.online",
        condition: { broadcaster_user_id: "7" },
        callback: "https://bot.example.com/hooks/twitch",
        secret: "s3cret-least-10-chars",
      });
      assert.equal(res.ok, true);
      assert.equal(tokenRequests, 2);
      const auths = calls
        .filter((c) => c.url.includes("/helix/eventsub/subscriptions"))
        .map((c) => c.init.headers.Authorization);
      assert.deepEqual(auths, ["Bearer tok-1", "Bearer tok-2"]);
    } finally {
      restore();
    }
  });
});

describe("deleteEventsubSubscription", () => {
  it("204 → ok; 404 → ok+gone; network → not ok", async () => {
    const okStub = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/eventsub/subscriptions"),
        respond: () => noContentResponse(204),
      },
    ]);
    try {
      const res = await deleteEventsubSubscription("sub-1");
      assert.equal(res.ok, true);
      assert.equal(res.status, 204);
    } finally {
      okStub.restore();
    }

    const goneStub = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/eventsub/subscriptions"),
        respond: () => jsonResponse({ error: "Not Found" }, 404),
      },
    ]);
    try {
      const res = await deleteEventsubSubscription("sub-2");
      assert.equal(res.ok, true);
      assert.equal(res.gone, true);
    } finally {
      goneStub.restore();
    }

    assert.equal((await deleteEventsubSubscription("")).ok, false);
  });
});

describe("listEventsubSubscriptions", () => {
  it("pages with the cursor and forwards the status filter", async () => {
    let helixCalls = 0;
    const { calls, restore } = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/eventsub/subscriptions"),
        respond: () =>
          jsonResponse(
            helixCalls++ === 0
              ? { data: [{ id: "a", type: "stream.online" }], pagination: { cursor: "p2" } }
              : { data: [{ id: "b", type: "stream.offline" }] },
          ),
      },
    ]);
    try {
      const subs = await listEventsubSubscriptions({ status: "enabled" });
      assert.deepEqual(subs.map((s) => s.id), ["a", "b"]);
      const urls = calls
        .map((c) => c.url)
        .filter((u) => u.includes("/helix/eventsub/subscriptions"));
      assert.equal(urls.length, 2);
      assert.match(urls[0], /status=enabled/);
      assert.match(urls[0], /first=100/);
      assert.match(urls[1], /cursor=p2/);
    } finally {
      restore();
    }
  });

  it("failure with nothing collected returns null (unknown), not []", async () => {
    const { restore } = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/eventsub/subscriptions"),
        respond: () => jsonResponse({ error: "Server Error" }, 500),
      },
    ]);
    try {
      assert.equal(await listEventsubSubscriptions(), null);
    } finally {
      restore();
    }
  });
});

describe("fetchClips / fetchArchives", () => {
  it("fetchClips sends broadcaster_id + started_at window", async () => {
    const { calls, restore } = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/clips"),
        respond: () => jsonResponse({ data: [{ id: "clip-1", created_at: "2026-09-27T10:00:00Z" }] }),
      },
    ]);
    try {
      const clips = await fetchClips("1234", {
        startedAt: "2026-09-27T09:00:00.000Z",
      });
      assert.equal(clips.length, 1);
      const url = calls.find((c) => c.url.includes("/helix/clips")).url;
      assert.match(url, /broadcaster_id=1234/);
      assert.match(url, /started_at=2026-09-27T09/);
      assert.match(url, /first=100/);
    } finally {
      restore();
    }
  });

  it("fetchClips distinguishes [] (confirmed none) from null (failed)", async () => {
    const okStub = await withFetchStub([
      tokenRoute,
      { match: (u) => u.includes("/helix/clips"), respond: () => jsonResponse({ data: [] }) },
    ]);
    try {
      assert.deepEqual(await fetchClips("1"), []);
    } finally {
      okStub.restore();
    }
    const failStub = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/clips"),
        respond: () => jsonResponse({ error: "Server Error" }, 500),
      },
    ]);
    try {
      assert.equal(await fetchClips("1"), null);
    } finally {
      failStub.restore();
    }
  });

  it("fetchArchives uses user_id + type=archive + sort=time (Helix quirk)", async () => {
    const { calls, restore } = await withFetchStub([
      tokenRoute,
      {
        match: (u) => u.includes("/helix/videos"),
        respond: () => jsonResponse({ data: [{ id: "v1", created_at: "2026-09-27T08:00:00Z" }] }),
      },
    ]);
    try {
      const vids = await fetchArchives("1234", { first: 5 });
      assert.equal(vids.length, 1);
      const url = calls.find((c) => c.url.includes("/helix/videos")).url;
      assert.match(url, /user_id=1234/);
      assert.match(url, /type=archive/);
      assert.match(url, /sort=time/);
      assert.match(url, /first=5/);
      assert.ok(!url.includes("broadcaster_id="), "videos endpoint uses user_id");
    } finally {
      restore();
    }
  });
});

describe("parseTwitchTimestamp", () => {
  it("parses RFC3339 with nanoseconds (truncated)", () => {
    const ms = parseTwitchTimestamp("2026-09-27T10:11:12.123456789Z");
    assert.equal(ms, Date.parse("2026-09-27T10:11:12.123Z"));
  });

  it("passes finite numbers and rejects garbage/empty", () => {
    assert.equal(parseTwitchTimestamp(1700000000000), 1700000000000);
    assert.equal(parseTwitchTimestamp(""), null);
    assert.equal(parseTwitchTimestamp(null), null);
    assert.equal(parseTwitchTimestamp("not-a-date"), null);
  });
});
