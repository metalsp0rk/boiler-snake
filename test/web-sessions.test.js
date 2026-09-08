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
const { loadDb } = require("./helpers/env");

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
});
