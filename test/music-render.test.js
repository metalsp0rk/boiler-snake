// Unit tests for src/features/music/render.js embed builders (wishlist T11,
// Part B). These are pure/near-pure builders — pinned directly with plain
// fake player/track objects, no Discord mocks and no DB.
//
// Pinned structures (the renderer's shipped cosmetic contract):
// - nowPlayingEmbed: empty state, title/URL/description, field set & order
//   (Duration / Source / Requested by), stream label, duration formatting,
//   requester mention, thumbnail, "Paused" footer.
// - queueEmbed: "Now:" line vs empty text, numbered upcoming list, default
//   limit of 10 + "…and N more" overflow line, custom limit, empty-queue
//   text, footer "N in queue · volume V%" (default 80).
// - controlRow: three buttons, ids, labels (Pause/Resume toggle), styles.
// - trackTitle / trackAuthor / sourceBadge fallbacks.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  COLOR,
  BTN,
  trackTitle,
  trackAuthor,
  sourceBadge,
  nowPlayingEmbed,
  queueEmbed,
  controlRow,
} = require("../src/features/music/render");

// ── Fixtures (plain objects shaped like Lavalink tracks) ───────────────────

function makeTrack(overrides = {}) {
  const { info: infoOverrides, ...rest } = overrides;
  return {
    info: {
      title: "Song Title",
      author: "Song Author",
      duration: 83000, // 1:23
      uri: "https://example.test/song",
      sourceName: "youtube",
      ...infoOverrides,
    },
    requester: { id: "u-42" },
    ...rest,
  };
}

function makePlayer({ current = null, tracks = [], paused = false, volume } = {}) {
  const player = { queue: { current, tracks }, paused };
  if (volume !== undefined) player.volume = volume;
  return player;
}

// ── trackTitle / trackAuthor / sourceBadge ─────────────────────────────────

describe("music render · track accessors", () => {
  it("trackTitle/trackAuthor return info values when present and fallbacks otherwise", () => {
    // Objective: every accessor is total — a missing track/info never breaks
    // embed building, it degrades to fixed placeholder text.
    // Arrange
    const track = makeTrack();

    // Act / Assert
    assert.equal(trackTitle(track), "Song Title");
    assert.equal(trackAuthor(track), "Song Author");
    assert.equal(trackTitle(null), "Unknown track");
    assert.equal(trackTitle({}), "Unknown track");
    assert.equal(trackAuthor(undefined), "Unknown");
    assert.equal(trackAuthor({ info: { author: "" } }), "Unknown");
  });

  it("sourceBadge maps known sources and is case-insensitive", () => {
    // Objective: pinned source → human label mapping.
    // Arrange / Act / Assert
    const badge = (sourceName) => sourceBadge({ info: { sourceName } });
    assert.equal(badge("spotify"), "Spotify → YouTube Music");
    assert.equal(badge("youtube"), "YouTube");
    assert.equal(badge("youtubemusic"), "YouTube");
    assert.equal(badge("soundcloud"), "SoundCloud");
    assert.equal(badge("http"), "Direct URL");
    assert.equal(badge("https"), "Direct URL");
    assert.equal(badge("Spotify"), "Spotify → YouTube Music"); // lowercased
  });

  it("sourceBadge passes unknown sources through and labels missing sources", () => {
    // Objective: unseen sourceName is shown verbatim (lowercased); no source
    // at all becomes "Unknown source".
    // Arrange / Act / Assert
    assert.equal(sourceBadge({ info: { sourceName: "VIMEO" } }), "vimeo");
    assert.equal(sourceBadge({ info: {} }), "Unknown source");
    assert.equal(sourceBadge(null), "Unknown source");
  });
});

// ── nowPlayingEmbed ─────────────────────────────────────────────────────────

describe("music render · nowPlayingEmbed", () => {
  it("empty state: no current track yields the nothing-playing embed", () => {
    // Objective: queued-empty players render a stable empty state (and a
    // player without a queue object must not crash).
    // Arrange
    const player = makePlayer();

    // Act
    const data = nowPlayingEmbed(player).toJSON();

    // Assert
    assert.equal(data.color, COLOR);
    assert.equal(data.title, "Nothing is playing");
    assert.equal(data.description, "Queue is empty.");
    assert.equal(data.fields, undefined);
    const data2 = nowPlayingEmbed({}).toJSON();
    assert.equal(data2.title, "Nothing is playing");
  });

  it("playing state: title, URL, description and the three inline fields", () => {
    // Objective: pinned field set, order, values and inline layout for the
    // main state — Duration / Source / Requested by.
    // Arrange
    const player = makePlayer({ current: makeTrack() });

    // Act
    const data = nowPlayingEmbed(player).toJSON();

    // Assert
    assert.equal(data.color, COLOR);
    assert.equal(data.title, "Song Title");
    assert.equal(data.url, "https://example.test/song");
    assert.equal(data.description, "by **Song Author**");
    assert.deepEqual(
      data.fields.map((f) => [f.name, f.value, f.inline]),
      [
        ["Duration", "1:23", true],
        ["Source", "YouTube", true],
        ["Requested by", "<@u-42>", true],
      ]
    );
    assert.equal(data.thumbnail, undefined, "no artwork → no thumbnail");
    assert.equal(data.footer, undefined, "not paused → no footer");
  });

  it("live streams show 'Live' instead of a duration", () => {
    // Objective: isStream short-circuits duration formatting.
    // Arrange
    const player = makePlayer({
      current: makeTrack({ info: { isStream: true, duration: 0 } }),
    });

    // Act
    const data = nowPlayingEmbed(player).toJSON();

    // Assert
    assert.equal(data.fields[0].value, "Live");
  });

  it("missing requester and missing duration degrade to 'Unknown' and 0:00", () => {
    // Objective: partial track metadata never breaks the embed — requester
    // falls back to text, absent duration formats as 0:00.
    // Arrange
    const player = makePlayer({
      current: { info: { title: "Bare", sourceName: "spotify" } },
    });

    // Act
    const data = nowPlayingEmbed(player).toJSON();

    // Assert
    assert.deepEqual(
      data.fields.map((f) => [f.name, f.value]),
      [
        ["Duration", "0:00"],
        ["Source", "Spotify → YouTube Music"],
        ["Requested by", "Unknown"],
      ]
    );
    // discord.js normalizes setURL(null) → url left unset in the payload.
    assert.equal(data.url, undefined, "no uri → url unset");
  });

  it("artwork sets the thumbnail and pausing sets the 'Paused' footer", () => {
    // Objective: the two optional decorations of the now-playing embed.
    // Arrange
    const player = makePlayer({
      current: makeTrack({ info: { artworkUrl: "https://example.test/a.png" } }),
      paused: true,
    });

    // Act
    const data = nowPlayingEmbed(player).toJSON();

    // Assert
    assert.equal(data.thumbnail.url, "https://example.test/a.png");
    assert.equal(data.footer.text, "Paused");
  });
});

// ── queueEmbed ──────────────────────────────────────────────────────────────

describe("music render · queueEmbed", () => {
  it("empty queue: 'Nothing is playing.' body and empty-upcoming line", () => {
    // Objective: pinned empty-state text and footer defaults (0 tracks,
    // volume defaults to 80 when the player doesn't carry one).
    // Arrange
    const player = makePlayer();

    // Act
    const data = queueEmbed(player).toJSON();

    // Assert
    assert.equal(data.color, COLOR);
    assert.equal(data.title, "Queue");
    assert.equal(data.description, "Nothing is playing.\n_No upcoming tracks._");
    assert.equal(data.footer.text, "0 in queue · volume 80%");
  });

  it("shows the current track header line with formatted duration", () => {
    // Objective: '**Now:** title — author (m:ss)' header pinned, with stream
    // rendering as lowercase '(live)'.
    // Arrange
    const player = makePlayer({ current: makeTrack() });

    // Act
    const data = queueEmbed(player).toJSON();

    // Assert
    assert.equal(
      data.description.split("\n")[0],
      "**Now:** Song Title — Song Author (1:23)"
    );
    const streamPlayer = makePlayer({
      current: makeTrack({ info: { isStream: true } }),
    });
    assert.equal(
      queueEmbed(streamPlayer).toJSON().description.split("\n")[0],
      "**Now:** Song Title — Song Author (live)"
    );
  });

  it("numbers upcoming tracks and counts them in the footer", () => {
    // Objective: upcoming list is 1-indexed `n. title — author (m:ss)` lines
    // with full metadata fallbacks for bare tracks.
    // Arrange
    const player = makePlayer({
      tracks: [
        makeTrack({ info: { title: "First", author: "A1", duration: 5000 } }),
        makeTrack({ info: { title: "Second", author: "A2", duration: 65000 } }),
        { info: { title: "Bare" } },
      ],
      volume: 40,
    });

    // Act
    const data = queueEmbed(player).toJSON();

    // Assert
    assert.deepEqual(data.description.split("\n"), [
      "Nothing is playing.",
      "`1.` First — A1 (0:05)",
      "`2.` Second — A2 (1:05)",
      "`3.` Bare — Unknown (0:00)",
    ]);
    assert.equal(data.footer.text, "3 in queue · volume 40%");
  });

  it("truncates the list at the default limit of 10 and reports the overflow", () => {
    // Objective: pinned truncation behavior — only the first 10 upcoming
    // tracks are listed, remainder collapsed into '…and **N** more'.
    // Arrange
    const tracks = Array.from({ length: 13 }, (_, i) =>
      makeTrack({ info: { title: `T${i + 1}` } })
    );

    // Act
    const data = queueEmbed(makePlayer({ tracks })).toJSON();
    const lines = data.description.split("\n");

    // Assert — 1 empty-now line + 10 numbered + 1 overflow line.
    assert.equal(lines.length, 12);
    assert.equal(lines[1], "`1.` T1 — Song Author (1:23)");
    assert.equal(lines[10], "`10.` T10 — Song Author (1:23)");
    assert.ok(!data.description.includes("T11"), "list stops at limit");
    assert.ok(!data.description.includes("`11.`"));
    assert.equal(lines[11], "…and **3** more");
    // Footer counts ALL upcoming, not just displayed ones.
    assert.equal(data.footer.text, "13 in queue · volume 80%");
  });

  it("honors a custom limit and omits the overflow line at exactly-limit queues", () => {
    // Objective: opts.limit controls the slice; exactly `limit` upcoming
    // tracks shows no '…and N more' line (boundary).
    // Arrange
    const three = Array.from({ length: 3 }, (_, i) =>
      makeTrack({ info: { title: `T${i + 1}` } })
    );

    // Act
    const limited = queueEmbed(makePlayer({ tracks: three }), { limit: 2 })
      .toJSON()
      .description.split("\n");
    const exact = queueEmbed(makePlayer({ tracks: three }), { limit: 3 })
      .toJSON()
      .description;

    // Assert
    assert.deepEqual(limited, [
      "Nothing is playing.",
      "`1.` T1 — Song Author (1:23)",
      "`2.` T2 — Song Author (1:23)",
      "…and **1** more",
    ]);
    assert.ok(!exact.includes("…and"), "exactly at limit → no overflow line");
    assert.equal(exact.split("\n").length, 4);
  });

  it("lists upcoming tracks even when nothing is currently playing", () => {
    // Objective: current and upcoming are independent — queued tracks still
    // render below the 'Nothing is playing.' header.
    // Arrange
    const player = makePlayer({ tracks: [makeTrack()] });

    // Act
    const data = queueEmbed(player).toJSON();

    // Assert
    assert.deepEqual(data.description.split("\n"), [
      "Nothing is playing.",
      "`1.` Song Title — Song Author (1:23)",
    ]);
  });
});

// ── controlRow ──────────────────────────────────────────────────────────────

describe("music render · controlRow", () => {
  it("pins the BTN custom-id contract", () => {
    // Objective: button ids are the interaction router's dispatch keys —
    // changing them silently breaks buttons, so pin the exact values.
    // Arrange / Act / Assert
    assert.deepEqual(BTN, {
      pause: "music:pause",
      skip: "music:skip",
      stop: "music:stop",
    });
  });

  it("builds pause/skip/stop buttons with labels and styles (playing)", () => {
    // Objective: pinned row layout — order, labels, styles
    // (Secondary=2 / Primary=1 / Danger=4).
    // Act
    const row = controlRow(false).toJSON();

    // Assert
    assert.equal(row.type, 1); // ActionRow
    assert.deepEqual(
      row.components.map((c) => [c.custom_id, c.label, c.style]),
      [
        ["music:pause", "Pause", 2],
        ["music:skip", "Skip", 1],
        ["music:stop", "Stop", 4],
      ]
    );
  });

  it('shows "Resume" label when paused', () => {
    // Objective: the pause button doubles as resume — label toggles on state.
    // Act
    const row = controlRow(true).toJSON();

    // Assert
    assert.equal(row.components[0].label, "Resume");
    assert.equal(row.components[0].custom_id, "music:pause");
    assert.equal(row.components[1].label, "Skip");
    assert.equal(row.components[2].label, "Stop");
  });
});
