/**
 * Gork memory fan-out across linked Discord ↔ Fluxer accounts
 * (roadmap/account-linking.md T5 — full-stack, offline: mocked LLM, real SQLite).
 *
 * Pinned contracts (context bundle § Gork memory fan-out):
 *  1. WRITE: extraction in the Fluxer community mirrors each stored entry to
 *     the linked Discord (community, user) tuple with identical content fields.
 *  2. mirror_memory=0 on the link FULLY stops write fan-out (no target row) —
 *     and a link with XP pct 0 must still mirror memories (memory has its own
 *     switch; pct is irrelevant to the memory leg).
 *  3. READ: loadMemoryContext in the Discord community sees memories stored on
 *     the Fluxer side (read fan-out follows link EXISTENCE) and the
 *     budgetChars budget applies to the merged set.
 *  4. The recall_memories tool's list-by-subject path includes the linked
 *     counterpart's rows; gorkMemoryGetById (#id handles) stays community-local.
 *  5. A throwing mirror upsert degrades: the extraction turn still reports its
 *     stored count, `warnings` carries the specific failure, and nothing throws.
 *
 * Link resolution runs through src/features/linking/service.js (the ONE seam)
 * against the real user_links repository, so every fixture builds the pair the
 * documented way: communities + an ACTIVE bridge row (bridges gate, see
 * test/user-links-repo.test.js) + api.createUserLink.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

describe("gork memory fan-out across linked accounts (T5 integration)", () => {
  /** @type {{ [k: string]: Function }} */
  let api;
  let cleanup;
  let mem;
  let recallTool;

  let dcCid; // Discord community (link side a)
  let fxCid; // Fluxer community (link side b)

  const CHAT_RUST = {
    ok: true,
    content: JSON.stringify({
      memories: [
        {
          subject_user_id: "flux-1",
          title: "Loves Rust",
          body: "Codes in Rust daily.",
          kind: "preference",
          importance: 4,
        },
      ],
    }),
  };

  /** Extraction turn shaped like runMemoryTurn's production call site. */
  function turnOpts(over = {}) {
    return {
      question: "what does flux-1 like?",
      answer: "Rust, obviously.",
      allowList: ["flux-1"],
      memDate: "2026-10-01",
      sourceMessageIds: ["m1"],
      chatImpl: async () => CHAT_RUST,
      ...over,
    };
  }

  /** Mint an ACTIVE bridge between two communities (links require one). */
  const activeBridge = (cidA, cidB) => {
    const bridge = api.createBridge({
      publicId: api.generateBridgeHandle(),
      createdByUserId: "u-minter",
      endACommunityId: cidA,
      endAChannelId: "chan-a",
    });
    api.addBridgeEnd({ bridgeId: bridge.id, position: "b", communityId: cidB, channelId: "chan-b" });
    api.db.prepare(`UPDATE bridges SET state = 'active' WHERE id = ?`).run(bridge.id);
    return bridge;
  };

  before(() => {
    // Contract: loadDb() before any other src/ require in this file.
    ({ api, cleanup } = loadDb());
    mem = require("../src/features/gork/memory");
    recallTool = require("../src/features/gork/tools/recallMemories");

    dcCid = communityKey("111000000000000501");
    fxCid = communityKey("sub-fluxer-mem-room", "fluxer", "fluxer.example:8443");
    activeBridge(dcCid, fxCid);
    const made = api.createUserLink({
      communityIdA: dcCid,
      userIdA: "disc-1",
      communityIdB: fxCid,
      userIdB: "flux-1",
    });
    assert.equal(made.ok, true, made.error || "fixture link must succeed");
    assert.equal(made.link.mirror_memory, 1, "default link mirrors memory");
  });

  after(() => cleanup?.());

  it("extraction on Fluxer mirrors the memory row onto the linked Discord tuple with identical fields", async () => {
    const res = await mem.runMemoryTurn({ ...turnOpts(), communityId: fxCid });
    assert.equal(res.stored, 1);
    assert.equal(res.mode, "extracted");
    assert.equal(res.warnings, undefined, "clean mirror leg adds no warnings (additive shape)");

    const local = api.gorkMemoryListForSubject(fxCid, "flux-1");
    const mirror = api.gorkMemoryListForSubject(dcCid, "disc-1");
    assert.equal(local.length, 1, "primary row lands on the source side");
    assert.equal(mirror.length, 1, "mirror row lands on the linked (community, user) tuple");

    // Identical content fields (upsert stamps fresh created_at/updated_at).
    for (const key of ["mem_date", "title", "title_key", "body", "kind", "importance", "source_message_ids"]) {
      assert.equal(mirror[0][key], local[0][key], `${key} must ride over byte-identically`);
    }
    assert.equal(mirror[0].subject_user_id, "disc-1");
    assert.equal(mirror[0].community_id, dcCid);
    assert.notEqual(mirror[0].id, local[0].id, "mirror is a NEW row, not a re-key");
  });

  it("mirror_memory=0 stops write fan-out entirely (and pct 0 does NOT)", async () => {
    // A link with BOTH xp directions at 0% must still mirror memories:
    // memory mirroring has its own switch (design bundle § Gork fan-out).
    api.setUserLinkMirrorPct(fxCid, "flux-1", "b_to_a", 0);
    api.setUserLinkMirrorPct(fxCid, "flux-1", "a_to_b", 0);

    const second = {
      ok: true,
      content: JSON.stringify({
        memories: [
          { subject_user_id: "flux-1", title: "Ships Fridays", body: "Releases every Friday.", kind: "project", importance: 3 },
        ],
      }),
    };
    const res = await mem.runMemoryTurn({ ...turnOpts({ chatImpl: async () => second }), communityId: fxCid });
    assert.equal(res.stored, 1);
    assert.equal(
      api.gorkMemoryListForSubject(dcCid, "disc-1").length,
      2,
      "pct 0 does not gate the memory leg — the new row mirrors too",
    );
    assert.ok(
      api.gorkMemoryListForSubject(dcCid, "disc-1").some((r) => r.title === "Ships Fridays"),
      "the second memory mirrored with its own title",
    );

    // The memory switch itself: off = no write fan-out, ever.
    const off = api.setUserLinkMirrorMemory(dcCid, "disc-1", false);
    assert.equal(off.ok, true);
    assert.equal(off.link.mirror_memory, 0);

    const third = {
      ok: true,
      content: JSON.stringify({
        memories: [
          { subject_user_id: "flux-1", title: "Hates Meetings", body: "Skips standups when possible.", kind: "preference", importance: 2 },
        ],
      }),
    };
    const resOff = await mem.runMemoryTurn({ ...turnOpts({ chatImpl: async () => third }), communityId: fxCid });
    assert.equal(resOff.stored, 1, "the primary write still lands");
    assert.equal(resOff.warnings, undefined, "mirror_memory=0 is a clean no-op, not a failure");
    const still = api.gorkMemoryListForSubject(dcCid, "disc-1");
    assert.equal(still.length, 2, "mirror_memory=0 fully stops write fan-out");
    assert.ok(!still.some((r) => r.title === "Hates Meetings"), "no target row for the third memory");

    // Read fan-out is NOT gated by mirror_memory (existence rule): the
    // "Hates Meetings" row was written LOCALLY on the Fluxer side (primary
    // writes always land) and must still be visible to the Discord side.
    const roster = { entries: new Map([["disc-1", { id: "disc-1", handle: "alice", display: "Alice" }]]) };
    const out = mem.loadMemoryContext({ communityId: dcCid, roster, budgetChars: 12000, botId: null });
    assert.ok(out.block.includes('"Loves Rust"'), "read fan-out spans the link");
    assert.ok(out.block.includes("Hates Meetings"), "read fan-out ignores mirror_memory (existence, not the switch)");

    api.setUserLinkMirrorMemory(dcCid, "disc-1", true); // restore for later suites
  });

  it("loadMemoryContext in the Discord community reads the Fluxer-side memory (budget applies)", () => {
    const roster = {
      entries: new Map([
        ["disc-1", { id: "disc-1", handle: "alice", display: "Alice" }],
        ["bot1", { id: "bot1", handle: "gork", display: "Gork" }],
      ]),
    };
    const out = mem.loadMemoryContext({ communityId: dcCid, roster, budgetChars: 12000, botId: "bot1" });

    // Read fan-out: rows stored on the Fluxer side surface under the SOURCE
    // person's roster label (the person the conversation saw).
    assert.equal(out.mode, "bodies");
    assert.ok(out.block.includes('Alice — 2026-10-01 · "Loves Rust"'), out.block);
    assert.ok(out.block.includes("Codes in Rust daily."), out.block);
    assert.ok(out.allRows.some((r) => r.title === "Loves Rust"), "allRows feeds the extraction turn the mirror rows too");

    // budgetChars applies to the merged set: the single mirror line exceeds
    // a tiny budget, so the block empties (dropped, not silently included).
    const out2 = mem.loadMemoryContext({ communityId: dcCid, roster, budgetChars: 10, botId: "bot1" });
    assert.ok(out2.allRows.length > 0, "rows ARE loaded — the budget drops them, not the query");
    assert.ok(out2.mode === "index" && out2.block === "", `tiny budget must shed every line: ${out2.mode}/${JSON.stringify(out2.block)}`);
    assert.equal(out2.indexed, 0);
  });

  it("recall tool lists the linked counterpart's rows; #id lookups stay community-local", async () => {
    // A row that exists ONLY on the Fluxer side.
    const made = api.gorkMemoryUpsert(
      {
        communityId: fxCid,
        subjectUserId: "flux-1",
        memDate: "2026-10-02",
        titleKey: "ships fridays", // same key as test 2's row, different mem_date → new row
        title: "Ships Fridays",
        body: "Releases every Friday.",
        kind: "project",
        importance: 3,
        sourceMessageIds: ["m2"],
      },
      25,
    );

    const listed = [];
    const text = await recallTool.executeRecallMemory(
      { subject_user_id: "disc-1" },
      { communityId: dcCid, onRecall: (ids) => listed.push(...ids) },
    );
    assert.ok(!text.startsWith("Memory recall unavailable"), text);
    const localRows = api.gorkMemoryListForSubject(dcCid, "disc-1");
    const remoteRows = api.gorkMemoryListForSubject(fxCid, "flux-1");
    assert.ok(remoteRows.some((r) => r.title === "Ships Fridays"), "fixture row lives on the Fluxer side");
    for (const r of [...localRows, ...remoteRows]) {
      assert.ok(text.includes(`#${r.id} — `), `listing line for #${r.id} expected:\n${text}`);
    }
    assert.deepEqual(
      listed,
      [...localRows, ...remoteRows].map((r) => r.id),
      "found ids: local rows first, then the counterpart's (cap 15, shared)",
    );

    // getById path: a Fluxer-side row id is NOT fetchable from the Discord
    // community — #id handles stay community-scoped by design.
    assert.ok(made.id > 0);
    const miss = await recallTool.executeRecallMemory({ ids: [made.id] }, { communityId: dcCid });
    assert.ok(
      /^#\d+ — \(no such memory\)$/.test(miss),
      `cross-community #id handle must miss locally, got: ${miss}`,
    );
    // Sanity: the same id resolves on its OWN community.
    const hit = await recallTool.executeRecallMemory({ ids: [made.id] }, { communityId: fxCid });
    assert.ok(hit.includes("Ships Fridays"), hit);
  });

  it("a throwing mirror upsert degrades: extraction succeeds, warnings surface, never throws", async () => {
    const repo = {
      gorkMemoryUpsert: (entry, cap) => {
        if (Number(entry.communityId) === dcCid) throw new Error("mirror db exploded");
        return api.gorkMemoryUpsert(entry, cap);
      },
    };
    const res = await mem.runMemoryTurn({ ...turnOpts(), communityId: fxCid, repo });
    assert.equal(res.stored, 1, "the primary write still reports success (extraction answer already shipped)");
    assert.ok(Array.isArray(res.warnings) && res.warnings.length === 1, JSON.stringify(res));
    assert.match(res.warnings[0], /mirror db exploded/, "warning carries the specific cause");
    assert.ok(
      res.warnings[0].includes(String(dcCid)) && res.warnings[0].includes("disc-1"),
      "warning names the target community/user tuple",
    );
  });

  it("runMemoryTurn works with zero links configured (default seam, no fan-out)", async () => {
    const solo = communityKey("111000000000000599");
    const soloChat = {
      ok: true,
      content: JSON.stringify({
        memories: [
          { subject_user_id: "solo-user", title: "Solo Fact", body: "Lives unlinked.", kind: "profile", importance: 1 },
        ],
      }),
    };
    const res = await mem.runMemoryTurn({
      ...turnOpts({ allowList: ["solo-user"], chatImpl: async () => soloChat }),
      communityId: solo,
    });
    assert.equal(res.stored, 1, "unlinked communities store locally with zero fan-out");
    assert.equal(res.warnings, undefined);
    assert.equal(api.gorkMemoryListForSubject(solo, "solo-user").length, 1);
  });
});
