/**
 * #469 (E2-07): the queue has a TOTAL bound.
 *
 * PLAYLIST_CAP=100 capped one playlist batch; NOTHING bounded the
 * aggregate — every `/play` by any member of the voice channel grew
 * lavalink-client's in-process queue forever (the embed even rendered
 * "…and N more" with unbounded N). Now a bounded 500 with a specific,
 * actionable refusal.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const player = require("../src/features/music/player");

const { MAX_QUEUE_TOTAL, queueDepth, errorMessage, playQuery } = player;

const mkTrack = (n) => ({ info: { title: `t${n}`, author: "a", length: 1000 } });

/**
 * Fake lavalink player behind the documented client._lavalinkManager seam.
 */
function fakePlayer({ current = null, tracks = [] }) {
  const p = {
    connected: true,
    voiceChannelId: "vc-1",
    textChannelId: "ch-1",
    playing: !!current,
    paused: false,
    searches: 0,
    connect: async () => {},
    play: async () => {},
    queue: {
      current,
      tracks,
      add: async (t) => {
        const arr = Array.isArray(t) ? t : [t];
        tracks.push(...arr);
      },
    },
    search: async () => {
      p.searches += 1;
      return fakePlayer.nextResult;
    },
  };
  return p;
}

function fakeClient(p) {
  return {
    _lavalinkManager: {
      useable: true,
      getPlayer: () => p,
      createPlayer: () => p,
    },
  };
}

const interaction = {
  guildId: "770000000000000001",
  user: { id: "870000000000000001" },
  channel: null,
  member: { voice: null },
  guild: {
    voiceStates: { cache: { get: () => ({ channelId: "vc-1", channel: null }) } },
    channels: { cache: { get: () => null } },
    afkChannelId: null,
    members: { me: null },
  },
};

describe("#469 (E2-07): queueDepth is the one bound oracle", () => {
  it("current + waiting, null-safe", () => {
    assert.equal(queueDepth(null), 0);
    assert.equal(queueDepth({ queue: {} }), 0);
    assert.equal(queueDepth({ queue: { current: mkTrack(0), tracks: [mkTrack(1)] } }), 2);
  });
});

describe("#469 (E2-07): /play refuses past the total bound", () => {
  it("a full queue never even pays for the search", async () => {
    const p = fakePlayer({
      current: mkTrack("now"),
      tracks: Array.from({ length: MAX_QUEUE_TOTAL - 1 }, (_, i) => mkTrack(i)),
    });
    fakePlayer.nextResult = { loadType: "track", tracks: [mkTrack("new")] };

    const res = await playQuery(fakeClient(p), interaction, "some song");
    assert.equal(res.ok, false);
    assert.equal(res.error, "queue_full");
    assert.equal(p.searches, 0, "a refusal at the bound must not hit the resolver");
    assert.equal(p.queue.tracks.length, MAX_QUEUE_TOTAL - 1, "nothing was added");
  });

  it("the room left still works: depth 499 + 1 lands at exactly the bound", async () => {
    const p = fakePlayer({
      current: null,
      tracks: Array.from({ length: MAX_QUEUE_TOTAL - 1 }, (_, i) => mkTrack(i)),
    });
    fakePlayer.nextResult = { loadType: "track", tracks: [mkTrack("last")] };

    const res = await playQuery(fakeClient(p), interaction, "one more");
    assert.equal(res.ok, true, "the bound is INCLUSIVE at 500, not one early");
    assert.equal(queueDepth(p), MAX_QUEUE_TOTAL);
  });

  it("a playlist batch crossing the bound is refused WHOLE (no half playlist)", async () => {
    const p = fakePlayer({
      current: mkTrack("now"),
      tracks: Array.from({ length: 449 }, (_, i) => mkTrack(i)), // depth 450
    });
    fakePlayer.nextResult = {
      loadType: "playlist",
      playlist: { name: "mix" },
      tracks: Array.from({ length: 100 }, (_, i) => mkTrack(`p${i}`)),
    };

    const res = await playQuery(fakeClient(p), interaction, "rainy lofi mix");
    assert.equal(res.ok, false);
    assert.equal(res.error, "queue_full");
    assert.equal(p.queue.tracks.length, 449, "old code happily added all 100 → 550 deep");
  });

  it("a batch that FITS still enqueues (parity)", async () => {
    const p = fakePlayer({
      current: mkTrack("now"),
      tracks: Array.from({ length: 449 }, (_, i) => mkTrack(i)),
    });
    fakePlayer.nextResult = {
      loadType: "playlist",
      playlist: { name: "mix" },
      tracks: Array.from({ length: 40 }, (_, i) => mkTrack(`p${i}`)),
    };

    const res = await playQuery(fakeClient(p), interaction, "sunny lofi mix");
    assert.equal(res.ok, true);
    assert.equal(queueDepth(p), 490);
  });
});

describe("#469 (E2-07): the refusal copy is actionable (rule 3)", () => {
  it("queue_full names the bound and the remedy — never the generic fallback", () => {
    const msg = errorMessage("queue_full");
    assert.match(msg, /500/, "the number makes it actionable");
    assert.match(msg, /music remove|wait/i, "and so does the remedy");
    assert.ok(
      !/something went wrong/i.test(msg),
      "the ERRORS map had no entry pre-fix → banned generic reply",
    );
  });
});
