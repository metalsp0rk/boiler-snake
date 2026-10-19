/**
 * #466 (E2-11): the K8 deferred-grant resume.
 *
 * Pre-fix, a claim accepted while `elevated_permissions=0` kept its
 * reaction + durable row and the code promised "the grant resumes when the
 * flag flips to 1" — but NOTHING ever resumed it. `handleReactionRoleAdd-
 * Fluxer` only fires on a fresh reaction ADD, and `/reactionrole sync`
 * validates the panel message, never the claim holders. Every deferred
 * claim needed every user to re-react.
 *
 * The sweep runs over the DURABLE claims (no GET-reactions fan-out — Fluxer
 * REST has none; the claim rows ARE the recorded reactions), re-checks
 * qualification, and grants. Failures keep the claim for the next boot.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const service = require("../src/features/reactionRoles/service");
const { ensureCommunity } = require("../src/platform/community");
const { makeFakeRest, makeFakeHandle } = require("./helpers/fluxer");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "99";
const CH = "444";
const ROLE = "role-7";
const EMOJI = "👍";

const COMMUNITY_ID = ensureCommunity({
  platform: "fluxer",
  instanceKey: INSTANCE,
  externalGuildId: GUILD,
});

const rolePutPath = (u, r = ROLE) => `/v1/guilds/${GUILD}/members/${u}/roles/${r}`;
const memberGetPath = (u) => `/v1/guilds/${GUILD}/members/${u}`;

function setElevatedFlag(value) {
  dbApi.db
    .prepare("UPDATE communities SET elevated_permissions=? WHERE id=?")
    .run(value, COMMUNITY_ID);
}

function seedPanel(messageId, { emojiKey = EMOJI, roleId = ROLE, minLevel = 0 } = {}) {
  dbApi.createReactionRolePanel(COMMUNITY_ID, CH, messageId, "Roles", "React to get a role.");
  dbApi.upsertReactionRoleOption(COMMUNITY_ID, messageId, emojiKey, emojiKey, roleId, minLevel, 1);
}

function claim(userId, messageId, emojiKey = EMOJI) {
  dbApi.recordReactionRoleClaim(COMMUNITY_ID, userId, messageId, emojiKey);
}

function claimCount(userId, messageId) {
  return Number(
    dbApi.db
      .prepare(
        "SELECT COUNT(*) AS n FROM reaction_role_claims WHERE community_id=? AND user_id=? AND message_id=?",
      )
      .get(COMMUNITY_ID, userId, messageId).n,
  );
}

function clearAll() {
  dbApi.db.prepare("DELETE FROM reaction_role_claims WHERE community_id=?").run(COMMUNITY_ID);
  dbApi.db.prepare("DELETE FROM reaction_role_options WHERE community_id=?").run(COMMUNITY_ID);
  dbApi.db.prepare("DELETE FROM reaction_role_panels WHERE community_id=?").run(COMMUNITY_ID);
}

describe("#466 (E2-11): resumeDeferredRoleGrantsFluxer — the backlog the flag flip used to drop", () => {
  it("grants a qualified deferred claim (the E2-09 promise, kept)", async () => {
    clearAll();
    setElevatedFlag(1); // outbound self-gates addRole on K8 — the sweep leans on that gate
    const msg = "701";
    seedPanel(msg, { minLevel: 0 });
    claim("u-1", msg);
    dbApi.setXp(COMMUNITY_ID, "u-1", 900); // level 3 ≥ 0
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath("u-1")}`]: { id: "u-1", roles: [] },
        [`PUT ${rolePutPath("u-1")}`]: { ok: true },
      },
    });
    const { outbound } = makeFakeHandle({ rest });

    const summary = await service.resumeDeferredRoleGrantsFluxer(outbound, COMMUNITY_ID);

    assert.equal(summary.granted, 1);
    assert.ok(
      rest.calls.some((c) => c.method === "PUT" && c.path === rolePutPath("u-1")),
      "the deferred addRole finally runs — no re-reaction required",
    );
  });

  it("holds a below-min-level claim silently — no grant, no DM spam, claim stands", async () => {
    clearAll();
    setElevatedFlag(1); // outbound self-gates addRole on K8 — the sweep leans on that gate
    const msg = "702";
    seedPanel(msg, { minLevel: 5 }); // level from 100 xp = 1
    claim("u-2", msg);
    dbApi.setXp(COMMUNITY_ID, "u-2", 100);
    const rest = makeFakeRest({
      routes: { [`GET ${memberGetPath("u-2")}`]: { id: "u-2", roles: [] } },
    });
    const { outbound } = makeFakeHandle({ rest });

    const summary = await service.resumeDeferredRoleGrantsFluxer(outbound, COMMUNITY_ID);

    assert.equal(summary.belowLevel, 1);
    assert.equal(summary.granted, 0);
    assert.equal(
      rest.calls.filter((c) => c.method === "PUT" && c.path.includes("/roles/")).length,
      0,
      "no grant below the threshold",
    );
    assert.equal(claimCount("u-2", msg), 1, "the claim stands until the member levels (no re-reaction)");
  });

  it("skips a role the member already holds", async () => {
    clearAll();
    setElevatedFlag(1); // outbound self-gates addRole on K8 — the sweep leans on that gate
    const msg = "703";
    seedPanel(msg);
    claim("u-3", msg);
    dbApi.setXp(COMMUNITY_ID, "u-3", 900);
    const rest = makeFakeRest({
      routes: { [`GET ${memberGetPath("u-3")}`]: { id: "u-3", roles: [ROLE] } },
    });
    const { outbound } = makeFakeHandle({ rest });

    const summary = await service.resumeDeferredRoleGrantsFluxer(outbound, COMMUNITY_ID);

    assert.equal(summary.already, 1);
    assert.equal(summary.granted, 0);
  });

  it("claims whose option or panel was deleted drop out (JOINs are the reaper)", async () => {
    clearAll();
    setElevatedFlag(1); // outbound self-gates addRole on K8 — the sweep leans on that gate
    const msg = "704";
    seedPanel(msg);
    claim("u-4", msg);
    dbApi.deleteReactionRoleOption(COMMUNITY_ID, msg, EMOJI);
    const rest = makeFakeRest({ routes: {} });
    const { outbound } = makeFakeHandle({ rest });

    const summary = await service.resumeDeferredRoleGrantsFluxer(outbound, COMMUNITY_ID);

    assert.deepEqual(summary, { granted: 0, already: 0, belowLevel: 0, failed: 0 });
  });

  it("a failed grant KEEPS the claim and names the cause (retried next boot)", async () => {
    clearAll();
    setElevatedFlag(1); // outbound self-gates addRole on K8 — the sweep leans on that gate
    const msg = "705";
    seedPanel(msg);
    claim("u-5", msg);
    dbApi.setXp(COMMUNITY_ID, "u-5", 900);
    // NO addRole route ⇒ the fake transport refuses the PUT (instance-down class).
    const rest = makeFakeRest({ routes: { [`GET ${memberGetPath("u-5")}`]: { id: "u-5", roles: [] } } });
    const { outbound } = makeFakeHandle({ rest });

    const origWarn = console.warn;
    const warns = [];
    console.warn = (...a) => warns.push(a.join(" "));
    let summary;
    try {
      summary = await service.resumeDeferredRoleGrantsFluxer(outbound, COMMUNITY_ID);
    } finally {
      console.warn = origWarn;
    }

    assert.equal(summary.failed, 1);
    assert.equal(claimCount("u-5", msg), 1, "disk is the ledger — a transient failure must not erase the claim");
    assert.ok(
      warns.some((l) => l.includes("grant failed") && l.includes("role-7")),
      `specific cause logged (warns: ${JSON.stringify(warns)})`,
    );
  });
});

describe("#466 (E2-11): sweepDeferredRoleGrantsAll — boot pass over elevated fluxer communities only", () => {
  it("runs on an elevated community and never touches a flag-0 one", async () => {
    clearAll();
    const msg = "706";
    seedPanel(msg);
    claim("u-6", msg);
    dbApi.setXp(COMMUNITY_ID, "u-6", 900);
    const rest = makeFakeRest({
      routes: {
        [`GET ${memberGetPath("u-6")}`]: { id: "u-6", roles: [] },
        [`PUT ${rolePutPath("u-6")}`]: { ok: true },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const supervisor = { clientForCommunity: (id) => (id === COMMUNITY_ID ? outbound : null) };

    setElevatedFlag(0);
    await service.sweepDeferredRoleGrantsAll(supervisor);
    assert.equal(
      rest.calls.filter((c) => c.method === "PUT" && c.path.includes("/roles/")).length,
      0,
      "flag 0 ⇒ the sweep never runs (the K8 gate still means no bot role writes)",
    );

    setElevatedFlag(1);
    await service.sweepDeferredRoleGrantsAll(supervisor);
    assert.ok(
      rest.calls.some((c) => c.method === "PUT" && c.path === rolePutPath("u-6")),
      "the flag flip + restart resumes the grant — the promise the old code never kept",
    );
  });
});
