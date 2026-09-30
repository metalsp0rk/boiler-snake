/**
 * Unit tests for the Phase 0b session core (roadmap/web-admin.md §8.3/§8.7):
 *
 *  - src/web/auth/sessions.js — real SQLite (temp DB via loadDb): create /
 *    get / sliding touch with the absolute 7 d cap / destroy / rotation /
 *    prune (boot + periodic) / cookie serialization hygiene;
 *  - src/web/middleware/session.js — cookie parsing edge cases, anonymous
 *    behavior, throttled sliding bumps, fail-closed lookup errors;
 *  - src/web/config.js — SESSION_SECRET fallback warning (once, no values),
 *    WEB_* resolution, Secure-cookie base rule, HTTPS boot validation;
 *  - mounted-app smoke: the session middleware is response-inert so the
 *    Phase 0a byte-parity surface (test/web-http-net.test.js) is untouched.
 *
 * node --test only; offline; no mocks of the DB layer itself.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { loadDb, communityKey } = require("./helpers/env");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Run `fn` with env patches (undefined deletes), restoring after.
 * @param {Record<string, string|undefined>} patches
 * @param {() => any} fn
 */
function withEnv(patches, fn) {
  const saved = {};
  for (const key of Object.keys(patches)) {
    saved[key] = process.env[key];
    if (patches[key] === undefined) delete process.env[key];
    else process.env[key] = patches[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(patches)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** Capture console.warn output while fn runs. */
function captureWarns(fn) {
  const seen = [];
  const original = console.warn;
  console.warn = (...args) => seen.push(args.map(String).join(" "));
  try {
    const result = fn();
    return { result, warns: seen };
  } finally {
    console.warn = original;
  }
}

describe("web session core (auth/sessions, middleware, config)", () => {
  /** @type {ReturnType<typeof loadDb>["api"]} */
  let api;
  /** @type {typeof import("../src/web/auth/sessions")} */
  let sessions;
  /** @type {typeof import("../src/web/middleware/session")} */
  let sessionMiddlewareMod;
  /** @type {typeof import("../src/web/config")} */
  let config;

  before(() => {
    const loaded = loadDb(); // fresh SQLite + src cache reset
    api = loaded.api;
    // Require AFTER loadDb so the web modules bind the fresh db facade.
    sessions = require("../src/web/auth/sessions");
    sessionMiddlewareMod = require("../src/web/middleware/session");
    config = require("../src/web/config");
  });

  after(() => {
    sessions.stopSessionPruneJob();
  });

  /** Raw repo row (no expiry filter). */
  const rawRow = (id) => api.getWebSession(id);

  /** Backdate/age a row directly (tests the policy layer, not the clock). */
  const setRowTimes = (id, { createdAt, lastSeenAt, expiresAt }) => {
    api.db
      .prepare(
        `UPDATE web_sessions SET created_at=?, last_seen_at=?, expires_at=? WHERE id=?`
      )
      .run(createdAt, lastSeenAt, expiresAt, id);
  };

  const expiredRowFixture = (userId) =>
    api.createWebSession({
      id: sessions.newSessionId(),
      userId,
      expiresAt: Date.now() - 10,
    });

  // -------------------------------------------------------------------------
  // auth/sessions.js — real SQLite
  // -------------------------------------------------------------------------

  describe("auth/sessions.js", () => {
    it("createSession issues a 64-hex id with default 12 h sliding expiry", () => {
      const s = sessions.createSession({ userId: "u-1", discordTag: "one#0001" });
      assert.match(s.id, /^[0-9a-f]{64}$/);
      assert.equal(s.userId, "u-1");
      assert.equal(s.discordTag, "one#0001");
      const row = rawRow(s.id);
      assert.ok(row, "row persisted");
      const age = s.expiresAt - s.createdAt;
      assert.ok(
        Math.abs(age - 12 * HOUR) < 5000,
        `expiry ≈ now+12h (got ${age}ms)`
      );
      assert.equal(row.user_id, "u-1");
    });

    it("WEB_SESSION_TTL_HOURS tunes the sliding window; invalid → default 12", () => {
      const short = withEnv({ WEB_SESSION_TTL_HOURS: "2" }, () =>
        sessions.createSession({ userId: "u-ttl-2" })
      );
      assert.ok(
        Math.abs(short.expiresAt - short.createdAt - 2 * HOUR) < 5000
      );

      for (const bad of ["abc", "0", "-3", ""]) {
        const s = withEnv({ WEB_SESSION_TTL_HOURS: bad }, () =>
          sessions.createSession({ userId: `u-ttl-${bad}` })
        );
        assert.ok(
          Math.abs(s.expiresAt - s.createdAt - 12 * HOUR) < 5000,
          `invalid "${bad}" falls back to 12h`
        );
      }
    });

    it("id shape gate rejects garbage/tampered values", () => {
      assert.equal(sessions.isSessionId(sessions.newSessionId()), true);
      assert.equal(sessions.isSessionId("nope"), false);
      assert.equal(sessions.isSessionId("a".repeat(32)), false);
      assert.equal(sessions.isSessionId("A".repeat(64)), false); // uppercase
      assert.equal(sessions.isSessionId(42), false);
      assert.equal(sessions.getSession("not-an-id"), null);
    });

    it("getSession: live row resolves; expired row == gone", () => {
      const s = sessions.createSession({ userId: "u-exp" });
      assert.equal(sessions.getSession(s.id)?.userId, "u-exp");

      setRowTimes(s.id, {
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: Date.now() - 1000,
      });
      assert.equal(sessions.getSession(s.id), null, "expired → null");
    });

    it("touchSession slides expiry by the TTL and never mutates the input", () => {
      const s = sessions.createSession({ userId: "u-slide" });
      const later = s.lastSeenAt + 60_000;
      const bumped = sessions.touchSession(s, later);
      assert.ok(bumped);
      assert.equal(bumped.lastSeenAt, later);
      assert.ok(
        Math.abs(bumped.expiresAt - (later + 12 * HOUR)) < 5,
        "slides to now+TTL"
      );
      assert.equal(s.expiresAt !== bumped.expiresAt, true, "input untouched");
      assert.equal(rawRow(s.id).last_seen_at, later, "row stamped");
    });

    it("touchSession clamps the slide at created_at + 7 days (absolute cap)", () => {
      const now = Date.now();
      const s = sessions.createSession({ userId: "u-cap" });
      // Aged to the very edge of the cap: created 7d ago minus 60 s, and the
      // row currently expires exactly AT the cap (60 s from `now`).
      const aged = now - sessions.ABSOLUTE_CAP_MS + 60_000;
      const capAt = aged + sessions.ABSOLUTE_CAP_MS; // == now + 60_000
      setRowTimes(s.id, {
        createdAt: aged,
        lastSeenAt: now - 10 * 60_000,
        expiresAt: capAt,
      });

      const live = sessions.getSession(s.id, now);
      assert.ok(live, "still live inside the cap");

      const bumped = sessions.touchSession(live, now + 1000);
      assert.ok(bumped);
      assert.equal(
        bumped.expiresAt,
        capAt,
        "min(now+12h, created+7d) == the cap, not now+12h"
      );
    });

    it("a TTL above the cap is clamped to created_at + 7d on creation", () => {
      // 200 h > the 168 h (7 d) absolute cap → creation must clamp to the cap
      const s = withEnv({ WEB_SESSION_TTL_HOURS: "200" }, () =>
        sessions.createSession({ userId: "u-cap-create" })
      );
      assert.ok(
        Math.abs(s.expiresAt - s.createdAt - sessions.ABSOLUTE_CAP_MS) < 5
      );
    });

    it("touchSession never revives an expired row", () => {
      const s = sessions.createSession({ userId: "u-dead" });
      const expiredAt = Date.now() - 5000;
      setRowTimes(s.id, {
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: expiredAt,
      });
      assert.equal(sessions.touchSession(s), null);
      assert.equal(rawRow(s.id).expires_at, expiredAt, "row untouched");
    });

    it("destroySession removes the row once", () => {
      const s = sessions.createSession({ userId: "u-destroy" });
      assert.equal(sessions.destroySession(s.id), true);
      assert.equal(rawRow(s.id), null);
      assert.equal(sessions.destroySession(s.id), false);
    });

    it("rotateSession regenerates the id, carries the user, kills the old id", () => {
      const oldS = sessions.createSession({ userId: "u-old", discordTag: "old#0001" });
      const fresh = sessions.rotateSession(oldS, {
        userId: "u-rot",
        discordTag: "rot#0002",
      });
      assert.notEqual(fresh.id, oldS.id);
      assert.equal(sessions.getSession(oldS.id), null, "old cookie dead");
      assert.equal(rawRow(oldS.id), null, "old row deleted, never revivable");
      assert.equal(fresh.userId, "u-rot");
      assert.equal(fresh.discordTag, "rot#0002");

      // Rotation with no prior session (fresh login) behaves like create.
      const anon = sessions.rotateSession(null, { userId: "u-fresh" });
      assert.match(anon.id, /^[0-9a-f]{64}$/);
      assert.equal(sessions.getSession(anon.id).userId, "u-fresh");
    });

    it("pruneExpiredSessions removes only expired rows", () => {
      const live = sessions.createSession({ userId: "u-live" });
      const expired = expiredRowFixture("u-pruned");

      const removed = sessions.pruneExpiredSessions(Date.now());
      assert.ok(removed >= 1);
      assert.equal(rawRow(expired.id), null, "expired pruned");
      assert.ok(rawRow(live.id), "live survived");

      // cutoff far in the past → nothing eligible
      assert.equal(sessions.pruneExpiredSessions(0), 0);

      // boundary: expires_at == cutoff is pruned (repo uses <=)
      const edge = expiredRowFixture("u-edge");
      setRowTimes(edge.id, {
        createdAt: 1,
        lastSeenAt: 1,
        expiresAt: 5000,
      });
      sessions.pruneExpiredSessions(5000);
      assert.equal(rawRow(edge.id), null);
      sessions.destroySession(live.id);
    });

    it("shouldTouch implements the >= interval throttle boundary", () => {
      const s = sessions.createSession({ userId: "u-th" });
      assert.equal(sessions.shouldTouch(s, s.lastSeenAt + 59_999), false);
      assert.equal(sessions.shouldTouch(s, s.lastSeenAt + 60_000), true);
      assert.equal(sessions.shouldTouch(null, s.lastSeenAt + 60_000), false);
      sessions.destroySession(s.id);
    });

    it("prune job sweeps on boot and periodically; stop halts it", async () => {
      const e1 = expiredRowFixture("e1");
      sessions.startSessionPruneJob({ intervalMs: 40 });
      assert.equal(rawRow(e1.id), null, "boot sweep ran immediately");

      const e2 = expiredRowFixture("e2");
      const live = sessions.createSession({ userId: "keep-me" });
      await new Promise((r) => setTimeout(r, 140));
      assert.equal(rawRow(e2.id), null, "periodic sweep ran");
      assert.ok(rawRow(live.id), "live row untouched by the job");

      sessions.stopSessionPruneJob();
      const e3 = expiredRowFixture("e3");
      await new Promise((r) => setTimeout(r, 140));
      assert.ok(rawRow(e3.id), "timer stopped — no sweeps after stop()");
      sessions.destroySession(e3.id);
      sessions.destroySession(live.id);
    });
  });

  // -------------------------------------------------------------------------
  // Cookie serialization hygiene (§8.3 / §8.7)
  // -------------------------------------------------------------------------

  describe("cookie serialization", () => {
    const validId = () => sessions.newSessionId();

    it("attributes: httpOnly, SameSite=Lax, Path=/, Max-Age=TTL seconds", () => {
      withEnv({ WEB_SESSION_TTL_HOURS: "6", PUBLIC_BASE_URL: undefined }, () => {
        const cookie = sessions.buildSessionCookie(validId());
        assert.match(cookie, /^web_session=[0-9a-f]{64}; /);
        assert.match(cookie, /Path=\//);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Lax/);
        assert.match(cookie, /Max-Age=21600$/);
        assert.doesNotMatch(cookie, /Secure/); // base URL unset → not https
      });
    });

    it("Secure iff resolved base URL is https", () => {
      const httpsCookie = withEnv({ PUBLIC_BASE_URL: "https://admin.example.com" }, () =>
        sessions.buildSessionCookie(validId())
      );
      assert.match(httpsCookie, /; Secure; Max-Age=43200$/);

      const httpCookie = withEnv({ PUBLIC_BASE_URL: "http://admin.example.com" }, () =>
        sessions.buildSessionCookie(validId())
      );
      assert.doesNotMatch(httpCookie, /Secure/);
    });

    it("cookie carries the opaque id ONLY — never user data", () => {
      const s = sessions.createSession({ userId: "u123456789", discordTag: "tagdata#42" });
      const cookie = sessions.buildSessionCookie(s.id);
      assert.ok(cookie.includes(s.id));
      assert.ok(!cookie.includes("u123456789"));
      assert.ok(!cookie.includes("tagdata"));
    });

    it("clear cookie empties the value with Max-Age=0 and same attrs", () => {
      const cleared = withEnv({ PUBLIC_BASE_URL: "https://admin.example.com" }, () =>
        sessions.buildClearSessionCookie()
      );
      assert.match(cleared, /^web_session=; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=0$/);
    });

    it("buildSessionCookie refuses malformed ids", () => {
      assert.throws(() => sessions.buildSessionCookie("zz"), TypeError);
    });
  });

  // -------------------------------------------------------------------------
  // middleware/session.js
  // -------------------------------------------------------------------------

  describe("middleware/session.js", () => {
    // Resolved lazily: the outer before() re-requires modules after loadDb
    // reset the src cache, and nested describe bodies run before hooks do.
    const mwMod = () => sessionMiddlewareMod;
    const createSessionMiddleware = (...args) =>
      mwMod().createSessionMiddleware(...args);
    const parseSessionCookie = (...args) =>
      mwMod().parseSessionCookie(...args);

    /** Drive the middleware with a synthetic req; returns the aftermath. */
    const invoke = (mw, cookieHeader) => {
      const req = { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } };
      const res = {};
      let nextCount = 0;
      mw(req, res, () => {
        nextCount += 1;
      });
      return { req, res, nextCount };
    };

    it("parseSessionCookie handles the cookie-header edge cases", () => {
      assert.equal(parseSessionCookie(undefined), null);
      assert.equal(parseSessionCookie(""), null);
      assert.equal(parseSessionCookie(["web_session=abc"]), null); // non-string
      assert.equal(parseSessionCookie("web_session=abc"), "abc");
      assert.equal(parseSessionCookie("a=1; web_session=abc ;b=2"), "abc");
      assert.equal(parseSessionCookie("web_session="), null, "empty value");
      assert.equal(parseSessionCookie("web_session_x=abc"), null, "near-miss name");
      assert.equal(parseSessionCookie("xweb_session=abc"), null, "prefix name");
      assert.equal(parseSessionCookie("novalue; web_session=deadbeef"), "deadbeef");
      assert.equal(
        parseSessionCookie("web_session=one; web_session=two"),
        "one",
        "first pair wins"
      );
      // oversized gate (>512 chars) — before any lookup
      assert.equal(parseSessionCookie(`web_session=${"f".repeat(513)}`), null);
      assert.equal(parseSessionCookie(`web_session=${"f".repeat(512)}`).length, 512);
    });

    it("no cookie → anonymous, next() exactly once, response untouched", () => {
      const mw = createSessionMiddleware();
      const { req, res, nextCount } = invoke(mw, undefined);
      assert.equal(nextCount, 1);
      assert.equal(req.webSession, null);
      assert.equal(req.user, null);
      assert.deepEqual(res, {}, "middleware must never write the response");
    });

    it("valid cookie attaches req.webSession + req.user (camelCase)", () => {
      const s = sessions.createSession({ userId: "u-mw", discordTag: "mw#0007" });
      const mw = createSessionMiddleware();
      const { req } = invoke(mw, `other=1; web_session=${s.id}; x=y`);
      assert.equal(req.webSession.id, s.id);
      assert.equal(req.user.userId, "u-mw");
      assert.equal(req.user.discordTag, "mw#0007");
    });

    it("tampered / garbage cookies never authenticate", () => {
      const s = sessions.createSession({ userId: "u-garbage" });
      const mw = createSessionMiddleware();
      for (const cookie of [
        "web_session=zz",
        `web_session=${s.id.slice(0, 63)}`, // truncated real id
        `web_session=${s.id.toUpperCase()}`, // case-tampered
        "web_session=<script>",
        `web_session=${"0".repeat(64)}`, // well-shaped but unknown
      ]) {
        const { req, nextCount } = invoke(mw, cookie);
        assert.equal(nextCount, 1, `next() ran for "${cookie}"`);
        assert.equal(req.user, null, `anon for "${cookie}"`);
        assert.equal(req.webSession, null);
      }
    });

    it("expired session cookie → anonymous", () => {
      const s = sessions.createSession({ userId: "u-mw-exp" });
      setRowTimes(s.id, {
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: Date.now() - 1,
      });
      const mw = createSessionMiddleware();
      const { req } = invoke(mw, `web_session=${s.id}`);
      assert.equal(req.user, null);
    });

    it("session row lost from the DB mid-cookies → anonymous", () => {
      const s = sessions.createSession({ userId: "u-mw-lost" });
      sessions.destroySession(s.id); // simulate revocation/prune
      const mw = createSessionMiddleware();
      const { req } = invoke(mw, `web_session=${s.id}`);
      assert.equal(req.user, null);
    });

    it("sliding bump through the middleware honors the throttle window", () => {
      const s = sessions.createSession({ userId: "u-mw-slide" });
      const t0 = Date.now();
      let clock = t0 + 61_000; // past the 60 s window
      const mw = createSessionMiddleware({ now: () => clock });

      const r1 = invoke(mw, `web_session=${s.id}`);
      assert.equal(r1.req.webSession.lastSeenAt, clock, "bumped");
      assert.equal(rawRow(s.id).last_seen_at, clock, "DB stamped");

      clock += 30_000; // inside the window again
      const r2 = invoke(mw, `web_session=${s.id}`);
      assert.equal(
        r2.req.webSession.lastSeenAt,
        clock - 30_000,
        "row snapshot — no fresh stamp inside the window"
      );
      assert.equal(rawRow(s.id).last_seen_at, clock - 30_000, "no second write");
    });

    it("throttle: DB writes happen at most once per window (stubbed API)", () => {
      const id = "a".repeat(64);
      let clock = 1_700_000_000_000;
      const live = {
        id,
        userId: "u-x",
        discordTag: null,
        createdAt: clock,
        lastSeenAt: clock,
        expiresAt: clock + 12 * HOUR,
      };
      let lookups = 0;
      let touches = 0;
      const stub = {
        getSession: () => {
          lookups += 1;
          return { ...live };
        },
        shouldTouch: (s, at, min) => at - s.lastSeenAt >= min,
        touchSession: (s, at) => {
          touches += 1;
          live.lastSeenAt = at;
          return { ...live };
        },
      };
      const mw = createSessionMiddleware({ now: () => clock, sessions: stub });
      const cookie = `web_session=${id}`;

      invoke(mw, cookie); // t0        → fresh, no touch
      clock += 30_000;
      invoke(mw, cookie); // +30 s     → inside window, no touch
      clock += 30_000; // +60 s        → exactly the boundary → touch
      invoke(mw, cookie);
      clock += 10_000; // +10 s after the touch → no touch
      invoke(mw, cookie);

      assert.equal(lookups, 4);
      assert.equal(touches, 1, "one bump for four requests");
    });

    it("oversized cookie value is rejected BEFORE any lookup", () => {
      let lookups = 0;
      const stub = {
        getSession: () => {
          lookups += 1;
          return null;
        },
        shouldTouch: () => false,
        touchSession: () => null,
      };
      const mw = createSessionMiddleware({ sessions: stub });
      const { req } = invoke(mw, `web_session=${"f".repeat(600)}`);
      assert.equal(req.user, null);
      assert.equal(lookups, 0, "never hits the DB");
    });

    it("lookup failure fails closed (anonymous) and still calls next()", () => {
      const id = "b".repeat(64);
      const stub = {
        getSession: () => {
          throw new Error("db exploded");
        },
        shouldTouch: () => false,
        touchSession: () => null,
      };
      const mw = createSessionMiddleware({ sessions: stub });
      const { result, warns } = captureWarns(() => invoke(mw, `web_session=${id}`));
      assert.equal(result.nextCount, 1, "chain continues exactly once");
      assert.equal(result.req.user, null);
      assert.equal(result.req.webSession, null);
      assert.equal(warns.length, 1);
      assert.ok(warns[0].includes("session lookup failed"));
    });
  });

  // -------------------------------------------------------------------------
  // web/config.js session knobs
  // -------------------------------------------------------------------------

  describe("web/config.js", () => {
    it("getSessionSecret prefers SESSION_SECRET silently", () => {
      const { result, warns } = withEnv(
        {
          SESSION_SECRET: "sess-placeholder-secret",
          CLIENT_SECRET: "client-placeholder-secret",
        },
        () => captureWarns(() => config.getSessionSecret())
      );
      assert.equal(result, "sess-placeholder-secret");
      assert.equal(warns.length, 0);
    });

    it("CLIENT_SECRET fallback warns exactly once and never logs values", () => {
      withEnv(
        { SESSION_SECRET: undefined, CLIENT_SECRET: "client-placeholder-secret" },
        () => {
          config._resetConfigWarningsForTests();
          const { result, warns } = captureWarns(() => [
            config.getSessionSecret(),
            config.getSessionSecret(),
            config.getSessionSecret(),
          ]);
          assert.deepEqual(result, Array(3).fill("client-placeholder-secret"));
          assert.equal(warns.length, 1, "warned once per boot");
          assert.ok(warns[0].includes("SESSION_SECRET"));
          assert.ok(
            warns.every((w) => !w.includes("client-placeholder-secret")),
            "secret value never logged (§8.7)"
          );
        }
      );
    });

    it("no secret configured → null without warning", () => {
      withEnv({ SESSION_SECRET: undefined, CLIENT_SECRET: undefined }, () => {
        config._resetConfigWarningsForTests();
        const { result, warns } = captureWarns(() => config.getSessionSecret());
        assert.equal(result, null);
        assert.equal(warns.length, 0);
      });
    });

    it("getSessionTtlMs defaults to 12 h and rejects garbage", () => {
      const cases = [
        [undefined, 12 * HOUR],
        ["12", 12 * HOUR],
        ["2", 2 * HOUR],
        ["0.5", 30 * 60_000],
        ["abc", 12 * HOUR],
        ["0", 12 * HOUR],
        ["-3", 12 * HOUR],
        ["", 12 * HOUR],
      ];
      for (const [raw, expected] of cases) {
        assert.equal(
          withEnv({ WEB_SESSION_TTL_HOURS: raw }, () => config.getSessionTtlMs()),
          expected,
          `WEB_SESSION_TTL_HOURS=${raw}`
        );
      }
      assert.equal(config.DEFAULT_SESSION_TTL_HOURS, 12);
    });

    it("getTierCacheTtlMs defaults to 60000 and rejects garbage", () => {
      const cases = [
        [undefined, 60_000],
        ["15000", 15_000],
        ["0", 0],
        ["abc", 60_000],
        ["-2", 60_000],
      ];
      for (const [raw, expected] of cases) {
        assert.equal(
          withEnv({ WEB_TIER_CACHE_TTL_MS: raw }, () => config.getTierCacheTtlMs()),
          expected,
          `WEB_TIER_CACHE_TTL_MS=${raw}`
        );
      }
      assert.equal(config.DEFAULT_TIER_CACHE_TTL_MS, 60_000);
    });

    it("isSecureBaseUrl mirrors the resolved base URL scheme", () => {
      const cases = [
        ["https://admin.example.com", true],
        ["HTTPS://admin.example.com", true],
        ["http://admin.example.com", false],
        ["ftp://admin.example.com", false],
        ["not a url", false],
        [undefined, false],
      ];
      for (const [raw, expected] of cases) {
        assert.equal(
          withEnv({ PUBLIC_BASE_URL: raw }, () => config.isSecureBaseUrl()),
          expected,
          `PUBLIC_BASE_URL=${raw}`
        );
      }
    });

    it("boot HTTPS validation: non-localhost http:// warns; dev/https/unset quiet", () => {
      const noisy = [
        ["http://admin.example.com", 1],
        ["http://bot.internal:8080", 1],
      ];
      for (const [raw, warnCount] of noisy) {
        const { result, warns } = withEnv({ PUBLIC_BASE_URL: raw }, () =>
          captureWarns(() => config.warnIfInsecurePublicBaseUrl())
        );
        assert.equal(result, true, `warns for ${raw}`);
        assert.equal(warns.length, warnCount);
        assert.ok(warns[0].includes("HTTP"));
      }

      const quiet = [
        "https://admin.example.com",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://127.9.9.9:1234",
        "http://[::1]:8080",
        "http://dev.localhost:3000",
        "not a url",
        undefined,
      ];
      for (const raw of quiet) {
        const { result } = withEnv({ PUBLIC_BASE_URL: raw }, () =>
          captureWarns(() => config.warnIfInsecurePublicBaseUrl())
        );
        assert.equal(result, false, `quiet for ${raw}`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Mounted-app smoke: middleware is response-inert (oracle net stays green)
  // -------------------------------------------------------------------------

  describe("mounted app integration (parity smoke)", () => {
    /** @type {import("http").Server} */
    let server;
    let baseUrl;

    before(async () => {
      const { createWebApp } = require("../src/web/app");
      server = http.createServer(createWebApp());
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => new Promise((r) => server.close(r)));

    it("GET /health is unchanged with and without a live session cookie", async () => {
      const anon = await fetch(`${baseUrl}/health`);
      assert.equal(anon.status, 200);
      assert.equal(await anon.text(), "ok");
      assert.equal(anon.headers.get("set-cookie"), null);

      const s = sessions.createSession({ userId: "u-http" });
      const authed = await fetch(`${baseUrl}/health`, {
        headers: { cookie: `web_session=${s.id}` },
      });
      assert.equal(authed.status, 200);
      assert.equal(await authed.text(), "ok");
      assert.equal(authed.headers.get("set-cookie"), null);
    });

    it("unknown path with a session cookie still gets the legacy 404 body", async () => {
      const res = await fetch(`${baseUrl}/nope`, {
        headers: { cookie: `web_session=${sessions.newSessionId()}` },
      });
      assert.equal(res.status, 404);
      assert.equal(await res.text(), "Not found");
    });
  });

  // ===========================================================================
  // Phase 4 session ADMINISTRATION — policy layer first (pure SQLite), then
  // the mounted self-service "Your sessions" lifecycle (Exit C of the
  // subtask: self list/revoke, revoke-other isolation, current-revoke ==
  // clean logout). roadmap/web-admin.md §8.3 + §8.7 secret hygiene.
  // ===========================================================================

  describe("session administration — policy layer (listLive*, revoke, pick)", () => {
    const liveFor = () => Date.now() + 3 * DAY;

    it("listLiveSessionsForUser: own rows only, live only, newest activity first", () => {
      const u = "u-admin-list";
      const other = sessions.createSession({ userId: "u-admin-other", discordTag: "other#9" });
      const a = sessions.createSession({ userId: u, discordTag: "a#1" });
      const b = sessions.createSession({ userId: u });
      setRowTimes(b.id, { createdAt: b.createdAt, lastSeenAt: Date.now() + 5_000_000, expiresAt: liveFor() });
      const dead = sessions.createSession({ userId: u });
      setRowTimes(dead.id, { createdAt: dead.createdAt, lastSeenAt: dead.lastSeenAt, expiresAt: Date.now() - 1 });

      const list = sessions.listLiveSessionsForUser(u);
      assert.deepEqual(list.map((s) => s.id).sort(), [a.id, b.id].sort(), "own live rows only");
      assert.equal(list[0].id, b.id, "newest last_seen first");
      assert.equal(sessions.listLiveSessionsForUser("u-who").length, 0);

      for (const s of [other, a, b, dead]) sessions.destroySession(s.id);
    });

    it("bounded reads: a 102-row user still answers at most MAX_SESSION_LIST_LIMIT", () => {
      const u = "u-admin-bound";
      const ids = [];
      for (let i = 0; i < 102; i += 1) {
        const id = sessions.newSessionId();
        api.createWebSession({ id, userId: u, expiresAt: Date.now() + DAY });
        ids.push(id);
      }
      assert.equal(sessions.MAX_SESSION_LIST_LIMIT, 100);
      assert.equal(sessions.listLiveSessionsForUser(u).length, 100, "repo LIMIT clamp holds");
      assert.equal(
        sessions.listLiveSessionsForUser(u, Date.now(), { limit: 999 }).length,
        100,
        "hostile limit clamped"
      );
      for (const id of ids) sessions.destroySession(id);
    });

    it("listLiveSessions: system-wide, multi-user, expired rows never listed", () => {
      const a = sessions.createSession({ userId: "u-all-1" });
      const b = sessions.createSession({ userId: "u-all-2" });
      const dead = expiredRowFixture("u-all-dead"); // already expired
      const ids = sessions.listLiveSessions().map((s) => s.id);
      assert.ok(ids.includes(a.id) && ids.includes(b.id), "both users listed");
      assert.ok(!ids.includes(dead.id), "expired row never listed");
      sessions.destroySession(a.id);
      sessions.destroySession(b.id);
    });

    it("revokeSessionById: honest outcome — the row hands back once, then not_found", () => {
      const s = sessions.createSession({ userId: "u-rev", discordTag: "rev#1" });
      const gone = sessions.revokeSessionById(s.id);
      assert.equal(gone.ok, true);
      assert.equal(gone.session.userId, "u-rev");
      assert.equal(gone.session.id, s.id, "removed row returned for the audit entry");
      assert.equal(rawRow(s.id), null);
      assert.equal(sessions.revokeSessionById(s.id).ok, false, "already gone ⇒ NOT a silent success");
      assert.equal(sessions.revokeSessionById(null).ok, false);
    });

    it("pickSessionByCreatedAt: exact selector match; current wins ties; junk selectors never match", () => {
      const now = Date.now();
      const mk = (lastOffset) => {
        const s = sessions.createSession({ userId: "u-pick" });
        setRowTimes(s.id, {
          createdAt: 1700000009999,
          lastSeenAt: now + lastOffset,
          expiresAt: now + DAY,
        });
        return s;
      };
      const first = mk(5000); // listed FIRST (newest activity)
      const second = mk(1000);
      const list = sessions.listLiveSessionsForUser("u-pick");
      assert.equal(list.length, 2);
      assert.equal(sessions.pickSessionByCreatedAt(list, 1700000009999, null).id, first.id);
      // The current-session snapshot a route holds is the FRESH row (its
      // created_at IS the selector value) — pick it out of the same list.
      const currentRow = list.find((s) => s.id === second.id);
      assert.equal(
        sessions.pickSessionByCreatedAt(list, 1700000009999, currentRow).id,
        second.id,
        "the CURRENT row wins a created_at collision"
      );
      assert.equal(sessions.pickSessionByCreatedAt(list, 999, null), null, "selector miss");
      assert.equal(sessions.pickSessionByCreatedAt(list, "1700000009999", null), null, "string junk");
      assert.equal(sessions.pickSessionByCreatedAt(list, Number.NaN, null), null);
      for (const s of [first, second]) sessions.destroySession(s.id);
    });

    it("deleteWebSessionById hands back the removed ROW (audit data); null for unknown ids", () => {
      const s = sessions.createSession({ userId: "u-del-row", discordTag: "del#1" });
      const row = api.deleteWebSessionById(s.id);
      assert.equal(row.id, s.id);
      assert.equal(row.user_id, "u-del-row");
      assert.equal(api.deleteWebSessionById(s.id), null, "second delete matches nothing");
      assert.equal(api.deleteWebSessionById(""), null);
    });
  });

  // ---------------------------------------------------------------------------
  // Mounted self-service "Your sessions" — the FULL lifecycle over the real
  // app stack (session → CSRF → guildScope → requireTier("staff") → route),
  // fake-Discord resolver + real SQLite, same pattern as the route suites.
  // ---------------------------------------------------------------------------

  describe("mounted self-service 'Your sessions' (list / revoke / current-revoke-logout)", () => {
    const GUILD_S = "770000000000000077";
    const GUILD_NO = "770000000000000099"; // bot is NOT here
    // Fluxer PR 2: INTEGER community ids for data + /g/<id> route identity.
    let CID_S = null;
    let CID_NO = null;
    const ROLE_JR_S = "880000000000000088";
    const U_STAFF = "771000000000000001";
    const U_SENIOR = "771000000000000002";
    const U_PLAIN = "771000000000000003";
    const SECRET_S = "test-self-sessions-secret-NOT-REAL-4242";

    /** @type {import("http").Server} */
    let serverS;
    let baseS = "";
    const cookieOf = {};
    const csrfOf = {};
    const loginIds = {}; // viewer key → their login session id (canary)
    let savedSecret;
    let savedBaseUrl;

    /** All session ids this suite knows — the §8.7 HTML canary set. */
    const allKnownIds = () => Object.values(loginIds);

    before(async () => {
      savedSecret = process.env.SESSION_SECRET;
      savedBaseUrl = process.env.PUBLIC_BASE_URL;
      process.env.SESSION_SECRET = SECRET_S;
      delete process.env.PUBLIC_BASE_URL;

      const { createWebApp } = require("../src/web/app");
      const { createGuildAccessResolver } = require("../src/web/auth/guildAccess");
      const tokens = require("../src/web/auth/tokens");
      const csrfMod = require("../src/web/middleware/csrf");

      CID_S = communityKey(GUILD_S);
      CID_NO = communityKey(GUILD_NO);
      api.addStaffRole(CID_S, ROLE_JR_S, "junior");

      const fakeDiscord = {
        async getUserGuilds(token) {
          const userId = String(token).replace(/^tok-/, "");
          if ([U_STAFF, U_SENIOR, U_PLAIN].includes(userId)) {
            return [
              {
                id: GUILD_S,
                name: "Self Guild",
                icon: null,
                owner: false,
                permissions: "104324673",
              },
            ];
          }
          return [];
        },
        async getUserGuildMember(token, guildId) {
          const userId = String(token).replace(/^tok-/, "");
          if (guildId === GUILD_S) {
            if (userId === U_STAFF) return { roles: [ROLE_JR_S] };
            if (userId === U_SENIOR) return { roles: [ROLE_JR_S] };
            return { roles: [] };
          }
          const err = new Error("Unknown Guild");
          err.status = 404;
          throw err;
        },
      };
      const resolver = createGuildAccessResolver({
        discord: fakeDiscord,
        botGuilds: async () => [GUILD_S],
        now: Date.now,
        ttlMs: 60_000,
      });
      const app = createWebApp({ guildAccess: resolver });
      serverS = http.createServer(app);
      serverS.listen(0, "127.0.0.1");
      await once(serverS, "listening");
      baseS = `http://127.0.0.1:${serverS.address().port}`;

      for (const [key, uid] of [
        ["staff", U_STAFF],
        ["senior", U_SENIOR],
        ["plain", U_PLAIN],
      ]) {
        const s = sessions.createSession({ userId: uid, discordTag: `${key}#0001` });
        api.setWebSessionAuth(s.id, {
          accessTokenEnc: tokens.encryptAccessToken(`tok-${uid}`),
          tokenExpiresAt: Date.now() + 3_600_000,
          scopes: "identify guilds guilds.members.read",
          guildSnapshot: JSON.stringify([
            { id: GUILD_S, name: "S", icon: null, owner: false, permissions: "104324673" },
          ]),
        });
        cookieOf[key] = `web_session=${s.id}`;
        loginIds[key] = s.id;
        csrfOf[key] = csrfMod.deriveCsrfToken(s.id, SECRET_S);
      }
    });

    after(async () => {
      if (serverS) {
        serverS.close();
        await once(serverS, "close");
      }
      if (savedSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = savedSecret;
      if (savedBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = savedBaseUrl;
    });

    const PAGE = () => `/g/${CID_S}/sessions`; // lazy: CID_S set in before()

    const getPage = async (key, path = PAGE()) => {
      const res = await fetch(baseS + path, {
        redirect: "manual",
        headers: key ? { cookie: cookieOf[key] } : undefined,
      });
      return { res, text: await res.text() };
    };

    const postRevoke = async (key, fields) => {
      const res = await fetch(`${baseS}${PAGE()}/revoke`, {
        method: "POST",
        redirect: "manual",
        headers: key
          ? { cookie: cookieOf[key], "content-type": "application/x-www-form-urlencoded" }
          : { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...(fields || {}) }).toString(),
      });
      return { res, text: await res.text(), location: res.headers.get("location") };
    };

    const revokeAuditRows = () =>
      api
        .listAdminAudit(CID_S, { limit: 100 })
        .filter((r) => r.action === "sessions.revoke");

    it("anon ⇒ 302 login; no-tier member ⇒ generic 404 (the shell floor applies)", async () => {
      const anon = await getPage(null);
      assert.equal(anon.res.status, 302);
      assert.equal(anon.res.headers.get("location"), "/auth/login", "integer route id ⇒ bare login redirect");
      const plain = await getPage("plain");
      assert.equal(plain.res.status, 404);
      assert.equal(plain.text, "Not found");
    });

    it("cross-guild probe ⇒ generic 404 (never 403)", async () => {
      const cross = await getPage("staff", `/g/${CID_NO}/sessions`);
      assert.equal(cross.res.status, 404);
      assert.equal(cross.text, "Not found");
    });

    it("staff sees ONLY their own session; no raw session id ever renders", async () => {
      const { res, text } = await getPage("staff");
      assert.equal(res.status, 200);
      assert.ok(text.includes("<h1>Your sessions"), "page heading");
      assert.ok(text.includes("staff#0001"), "own tag listed");
      assert.ok(!text.includes(U_SENIOR) && !text.includes(U_PLAIN), "no other users");
      for (const id of allKnownIds()) {
        assert.ok(!text.includes(id), "raw session id never rendered (§8.7)");
      }
      assert.ok(!text.includes('name="session_id"') && !text.includes('name="id"'), "no id selector field");
      assert.equal((text.match(/name="created_at"/g) || []).length, 1, "one own row, one selector");
    });

    it("revoke ANOTHER own session kills it while the current cookie keeps working", async () => {
      const extra = sessions.createSession({ userId: U_STAFF, discordTag: "staff#0001" });
      const { location } = await postRevoke("staff", {
        _csrf: csrfOf.staff,
        created_at: String(extra.createdAt),
      });
      assert.equal(location, `${PAGE()}?done=session_revoked`);
      assert.equal(rawRow(extra.id), null, "row destroyed immediately");

      // The CURRENT cookie survives: same visitor, same page, 200.
      const page = await getPage("staff");
      assert.equal(page.res.status, 200);

      // Exactly ONE audit row, correct shape, NO session id anywhere in it.
      const rows = revokeAuditRows();
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.origin, "web");
      assert.equal(row.actor_user_id, U_STAFF);
      assert.equal(row.target_type, "session");
      assert.equal(row.target_id, String(extra.createdAt), "targetId is the NON-SECRET selector");
      const details = JSON.parse(row.details_json);
      assert.deepEqual(details, {
        scope: "self",
        target_user_id: U_STAFF,
        created_at: extra.createdAt,
        current: false,
      });
      const raw = JSON.stringify(row);
      for (const id of [...allKnownIds(), extra.id]) {
        assert.ok(!raw.includes(id), "audit row carries NO session id (§8.7)");
      }
    });

    it("revoke a selector outside the viewer's own list ⇒ session_gone, zero writes", async () => {
      const seniorRowBefore = rawRow(loginIds.senior);
      const before = revokeAuditRows().length;
      // senior's login created_at — staff must NOT be able to address it:
      const seniorSession = sessions.getSession(loginIds.senior);
      const { location } = await postRevoke("staff", {
        _csrf: csrfOf.staff,
        created_at: String(seniorSession.createdAt),
      });
      assert.equal(location, `${PAGE()}?error=session_gone`);
      assert.ok(rawRow(loginIds.senior), "senior's session survived (Exit C isolation)");
      assert.ok(seniorRowBefore, "sanity: it was there");
      assert.equal(revokeAuditRows().length, before, "failed revoke audited NOTHING");
    });

    it("junk selector ⇒ invalid_selection with zero audit; missing _csrf ⇒ 403", async () => {
      const before = revokeAuditRows().length;
      const bad = await postRevoke("staff", { _csrf: csrfOf.staff, created_at: "x" });
      assert.equal(bad.location, `${PAGE()}?error=invalid_selection`);
      const noCsrf = await postRevoke("staff", { created_at: String(Date.now()) });
      assert.equal(noCsrf.res.status, 403);
      assert.equal(noCsrf.text, "Forbidden");
      assert.equal(revokeAuditRows().length, before, "refusals audited nothing");
    });

    it("REVOKING THE CURRENT SESSION == clean logout (row gone + cookie torn down + next request → login)", async () => {
      const me = sessions.getSession(loginIds.staff);
      const { res, location } = await postRevoke("staff", {
        _csrf: csrfOf.staff,
        created_at: String(me.createdAt),
      });
      assert.equal(res.status, 302);
      assert.equal(
        location,
        "/auth/login?signedout=1",
        "logout-shaped redirect (POST /auth/logout precedent: signed-out landing)"
      );
      const setCookie = res.headers.get("set-cookie") || "";
      assert.match(setCookie, /^web_session=;.*Max-Age=0/, "cookie torn down");
      assert.equal(rawRow(loginIds.staff), null, "session row destroyed");

      // Next request with the (now dead) cookie redirects to login:
      const next = await getPage("staff");
      assert.equal(next.res.status, 302);
      assert.equal(next.res.headers.get("location"), "/auth/login");

      const rows = revokeAuditRows();
      const currentRow = rows.find((r) => JSON.parse(r.details_json).current === true);
      assert.ok(currentRow, "current revoke audited with details.current=true");
      assert.equal(currentRow.target_id, String(me.createdAt));
    });

    it("the senior visitor is untouched: their own page lists only their own row", async () => {
      const { res, text } = await getPage("senior");
      assert.equal(res.status, 200);
      assert.ok(text.includes("senior#0001"));
      assert.ok(!text.includes(U_STAFF), "the ex-staff user is invisible here");
      assert.equal((text.match(/name="created_at"/g) || []).length, 1);
    });
  });
});
