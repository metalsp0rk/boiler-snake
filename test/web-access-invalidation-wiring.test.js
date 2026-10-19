/**
 * #467 (C1-7): the web access invalidators were DESIGNED but DEAD —
 * `invalidateUserGuild`/`invalidateSession` existed on the resolver handle,
 * nothing ever called them, so a revoked Discord role kept serving the old
 * tier until the cache TTL expired. Now GuildMemberUpdate (Discord) calls
 * both at boot via features/web `wireAccessInvalidation`.
 *
 * (Fluxer delivers NO member-role gateway dispatch — #439 — so Fluxer
 * revocation stays TTL-bounded; that asymmetry is documented, not tested.)
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

// #609: this file LOADS src modules whose require chain reaches src/db —
// connection.js opens DB_PATH at REQUIRE time, so bind a private temp DB
// BEFORE anything else loads. Concurrent node --test files sharing one
// ambient DB_PATH race mid-migration (the #470 G2-6 gork flake class).
const { loadDb } = require("./helpers/env");
const { cleanup: cleanupTempDb } = loadDb();
after(cleanupTempDb);

const { EventEmitter } = require("node:events");

const {
  createGuildAccessResolver,
  getActiveGuildAccessResolver,
} = require("../src/web/auth/guildAccess");
const { wireAccessInvalidation } = require("../src/features/web");
const sessionsAuth = require("../src/web/auth/sessions");
const { Events } = require("discord.js");

describe("web access invalidation wiring (#467 C1-7)", () => {
  it("the factory captures the LATEST resolver (the one the app gates with)", () => {
    const r1 = createGuildAccessResolver({});
    assert.equal(getActiveGuildAccessResolver(), r1);
    const r2 = createGuildAccessResolver({});
    assert.equal(getActiveGuildAccessResolver(), r2, "latest build wins — production builds one app");
    assert.notEqual(r1, r2);
  });

  it("wireAccessInvalidation refuses non-clients", () => {
    assert.equal(wireAccessInvalidation(null), false);
    assert.equal(wireAccessInvalidation({}), false);
  });

  describe("GuildMemberUpdate → both caches drop", () => {
    let client;
    let calls;
    let origList;
    let origResolver;

    before(() => {
      // A resolver built now IS the active one (factory capture).
      const resolver = createGuildAccessResolver({});
      calls = { userGuild: [], session: [] };
      resolver.invalidateUserGuild = (userId, guildId) => calls.userGuild.push([userId, guildId]);
      resolver.invalidateSession = (id) => calls.session.push(id);

      origList = sessionsAuth.listLiveSessionsForUser;
      sessionsAuth.listLiveSessionsForUser = (userId) =>
        userId === "777000000000000077" ? [{ id: "sess-a" }, { id: "sess-b" }] : [];

      client = new EventEmitter();
      assert.equal(wireAccessInvalidation(client), true);
    });

    after(() => {
      sessionsAuth.listLiveSessionsForUser = origList;
    });

    it("member role change drops the role cache + every live session's access list", () => {
      client.emit(
        Events.GuildMemberUpdate,
        { id: "777000000000000077", guild: { id: "123000000000000000" } },
        { id: "777000000000000077", guild: { id: "123000000000000000" } }
      );
      assert.deepEqual(calls.userGuild, [["777000000000000077", "123000000000000000"]]);
      assert.deepEqual(calls.session, ["sess-a", "sess-b"]);
    });

    it("id-less events are ignored, and a throwing invalidator never escapes", () => {
      const n = calls.userGuild.length;
      client.emit(Events.GuildMemberUpdate, {}, {});
      client.emit(Events.GuildMemberUpdate, null, undefined);
      assert.equal(calls.userGuild.length, n, "no ids ⇒ no calls");

      const resolver = getActiveGuildAccessResolver();
      const orig = resolver.invalidateUserGuild;
      resolver.invalidateUserGuild = () => {
        throw new Error("boom");
      };
      const errs = [];
      const origErr = console.error;
      console.error = (...a) => errs.push(a.join(" "));
      try {
        client.emit(Events.GuildMemberUpdate, null, {
          id: "777000000000000077",
          guild: { id: "123000000000000000" },
        });
      } finally {
        console.error = origErr;
        resolver.invalidateUserGuild = orig;
      }
      assert.ok(
        errs.some((l) => l.includes("GuildMemberUpdate") && l.includes("boom")),
        "rule 2: logged with context, never a silent swallow"
      );
    });
  });
});
