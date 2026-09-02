const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyQuery,
  resolveQuery,
  capTracks,
  parseTimestamp,
  formatDuration,
  PLAYLIST_CAP,
} = require("../src/features/music/resolve");

describe("music resolve", () => {
  describe("classifyQuery", () => {
    it("classifies empty input", () => {
      assert.equal(classifyQuery("").kind, "empty");
      assert.equal(classifyQuery("   ").kind, "empty");
    });

    it("classifies Spotify URLs and URIs", () => {
      const url = classifyQuery(
        "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc"
      );
      assert.equal(url.kind, "spotify");
      assert.equal(url.spotifyType, "track");
      assert.equal(url.spotifyId, "4cOdK2wGLETKBW3PvgPWqT");

      const intl = classifyQuery(
        "https://open.spotify.com/intl-en/playlist/37i9dQZF1DXcBWIGoYBM5M"
      );
      assert.equal(intl.kind, "spotify");
      assert.equal(intl.spotifyType, "playlist");

      const uri = classifyQuery("spotify:album:1DFixLWuPkv3KT3TnV35m3");
      assert.equal(uri.kind, "spotify");
      assert.equal(uri.spotifyType, "album");
      assert.equal(uri.spotifyId, "1DFixLWuPkv3KT3TnV35m3");
    });

    it("classifies YouTube and SoundCloud URLs", () => {
      assert.equal(
        classifyQuery("https://www.youtube.com/watch?v=dQw4w9WgXcQ").kind,
        "youtube"
      );
      assert.equal(
        classifyQuery("https://youtu.be/dQw4w9WgXcQ").kind,
        "youtube"
      );
      assert.equal(
        classifyQuery("https://music.youtube.com/watch?v=dQw4w9WgXcQ").kind,
        "youtube"
      );
      assert.equal(
        classifyQuery("https://soundcloud.com/artist/track").kind,
        "soundcloud"
      );
    });

    it("classifies other HTTP URLs and bare searches", () => {
      assert.equal(classifyQuery("https://example.com/audio.mp3").kind, "url");
      const s = classifyQuery("never gonna give you up");
      assert.equal(s.kind, "search");
      assert.equal(s.text, "never gonna give you up");
    });
  });

  describe("resolveQuery", () => {
    it("uses Spotify search when creds are enabled", () => {
      const r = resolveQuery("rick astley", { spotifyEnabled: true });
      assert.equal(r.ok, true);
      assert.equal(r.source, "spsearch");
      assert.equal(r.query, "rick astley");
    });

    it("falls back to YouTube Music search without Spotify creds", () => {
      const r = resolveQuery("rick astley", { spotifyEnabled: false });
      assert.equal(r.ok, true);
      assert.equal(r.source, "ytmsearch");
    });

    it("rejects Spotify URLs when unconfigured", () => {
      const r = resolveQuery("https://open.spotify.com/track/abc123xyz00", {
        spotifyEnabled: false,
      });
      assert.equal(r.ok, false);
      assert.equal(r.error, "spotify_unconfigured");
    });

    it("passes Spotify URLs through when configured", () => {
      const r = resolveQuery("spotify:track:4cOdK2wGLETKBW3PvgPWqT", {
        spotifyEnabled: true,
      });
      assert.equal(r.ok, true);
      assert.equal(r.query, "spotify:track:4cOdK2wGLETKBW3PvgPWqT");
      assert.equal(r.source, undefined);
    });
  });

  describe("capTracks", () => {
    it("caps at PLAYLIST_CAP and flags truncation", () => {
      const tracks = Array.from({ length: PLAYLIST_CAP + 1 }, (_, i) => i);
      const capped = capTracks(tracks);
      assert.equal(capped.tracks.length, PLAYLIST_CAP);
      assert.equal(capped.truncated, true);
      assert.equal(capped.total, PLAYLIST_CAP + 1);
    });

    it("does not truncate short lists", () => {
      const capped = capTracks([1, 2, 3]);
      assert.equal(capped.truncated, false);
      assert.deepEqual(capped.tracks, [1, 2, 3]);
    });
  });

  describe("parseTimestamp / formatDuration", () => {
    it("parses mm:ss, hh:mm:ss, and seconds", () => {
      assert.deepEqual(parseTimestamp("1:23"), { ok: true, ms: 83000 });
      assert.deepEqual(parseTimestamp("90"), { ok: true, ms: 90000 });
      assert.deepEqual(parseTimestamp("1:02:03"), { ok: true, ms: 3723000 });
    });

    it("rejects invalid timestamps", () => {
      assert.equal(parseTimestamp("").ok, false);
      assert.equal(parseTimestamp("1:99").ok, false);
      assert.equal(parseTimestamp("nope").ok, false);
    });

    it("formats durations", () => {
      assert.equal(formatDuration(83000), "1:23");
      assert.equal(formatDuration(3723000), "1:02:03");
      assert.equal(formatDuration(0), "0:00");
    });
  });
});

describe("music player guards", () => {
  let player;

  before(() => {
    player = require("../src/features/music/player");
  });

  after(() => {
    const { setManagerForTests } = require("../src/features/music/lavalink");
    setManagerForTests(null);
  });

  it("countHumans skips bots", () => {
    const humans = [
      { id: "u1", user: { bot: false } },
      { id: "u2", user: { bot: true } },
    ];
    const guild = {
      members: { cache: new Map(humans.map((m) => [m.id, m])) },
      voiceStates: {
        cache: new Map([
          ["u1", { channelId: "vc", member: humans[0] }],
          ["u2", { channelId: "vc", member: humans[1] }],
          ["u3", { channelId: "other", member: humans[0] }],
        ]),
      },
    };
    assert.equal(player.countHumans(guild, "vc"), 1);
  });
});
