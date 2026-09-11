const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() must stay above every `src/` require (temp DB bind).
const { cleanup } = loadDb();

const {
  pickNewReleases,
  truncateReleaseNotes,
  createReleaseEmbed,
} = require("../src/features/githubReleases/ticker");
const { normalizeGithubRepo } = require("../src/db");

after(cleanup);

function rel(id, opts = {}) {
  return {
    id,
    tag: `v1.0.${id}`,
    name: opts.name ?? `Release ${id}`,
    body: opts.body ?? `notes ${id}`,
    prerelease: !!opts.prerelease,
    htmlUrl: `https://github.com/acme/widgets/releases/tag/v1.0.${id}`,
    author: "acme-bot",
    publishedAtMs: 1_700_000_000_000 + id * 1000,
    ...opts,
  };
}

describe("normalizeGithubRepo", () => {
  it("accepts owner/name and URLs, lowercases the key", () => {
    assert.equal(normalizeGithubRepo("Acme/Widgets"), "acme/widgets");
    assert.equal(
      normalizeGithubRepo("https://github.com/acme/widgets"),
      "acme/widgets",
    );
    assert.equal(
      normalizeGithubRepo("https://www.github.com/Acme/Widgets/issues/5"),
      "acme/widgets",
    );
    assert.equal(
      normalizeGithubRepo("git@github.com:acme/widgets.git"),
      "acme/widgets",
    );
  });

  it("rejects non-repo strings", () => {
    assert.equal(normalizeGithubRepo(""), null);
    assert.equal(normalizeGithubRepo("justname"), null);
    assert.equal(normalizeGithubRepo("a/b/c"), null);
    assert.equal(normalizeGithubRepo("owner/"), null);
  });
});

describe("pickNewReleases", () => {
  // newest-first list as returned by fetchReleases
  const releases = [rel(5), rel(4), rel(3), rel(2), rel(1)];

  it("baselines a fresh watch to only the newest release", () => {
    const picked = pickNewReleases({ last_release_id: null }, releases);
    assert.deepEqual(
      picked.map((r) => r.id),
      [5],
    );
  });

  it("picks every release after the pointer, oldest-first", () => {
    const picked = pickNewReleases({ last_release_id: 3 }, releases);
    assert.deepEqual(
      picked.map((r) => r.id),
      [4, 5],
    );
  });

  it("picks nothing when the pointer is current", () => {
    assert.deepEqual(pickNewReleases({ last_release_id: 5 }, releases), []);
  });

  it("catches backdated releases via the id pointer", () => {
    // Release published "into the past" (older published_at than the pointer)
    const backdated = rel(6, { publishedAtMs: 1 });
    const picked = pickNewReleases(
      { last_release_id: 5 },
      [backdated, ...releases],
    );
    assert.deepEqual(
      picked.map((r) => r.id),
      [6],
    );
  });

  it("returns nothing for an empty release list", () => {
    assert.deepEqual(pickNewReleases({ last_release_id: null }, []), []);
  });
});

describe("truncateReleaseNotes", () => {
  const url = "https://github.com/acme/widgets/releases/tag/v2";

  it("keeps short bodies verbatim", () => {
    assert.equal(truncateReleaseNotes("small fix", url), "small fix");
  });

  it("fills in a placeholder for empty notes", () => {
    assert.equal(
      truncateReleaseNotes(null, url),
      "_No release notes were provided._",
    );
  });

  it("truncates long bodies with a read-more link under embed limits", () => {
    const body = "line of release notes\n".repeat(500);
    const out = truncateReleaseNotes(body, url);
    assert.ok(out.length < 4096, `length ${out.length} exceeds 4096`);
    assert.match(out, /Read the full release notes on GitHub/);
    assert.ok(url);
    assert.ok(out.includes(url));
  });
});

describe("createReleaseEmbed", () => {
  const watch = {
    guild_id: "g1",
    repo: "acme/widgets",
    repo_display: "Acme/Widgets",
  };

  it("includes tag, link, and notes", () => {
    const json = createReleaseEmbed(watch, rel(9, { body: "the notes" })).toJSON();
    assert.equal(json.title, "📦 Release 9");
    assert.equal(json.url, "https://github.com/acme/widgets/releases/tag/v1.0.9");
    assert.equal(json.description, "the notes");
    assert.equal(json.author.name, "Acme/Widgets");
    assert.ok(
      json.fields.some((f) => f.value === "`v1.0.9`"),
      "tag field present",
    );
  });

  it("marks pre-releases", () => {
    const json = createReleaseEmbed(watch, rel(10, { prerelease: true })).toJSON();
    assert.match(json.title, /^🧪 Pre-release:/);
  });

  it("truncates an overlong title", () => {
    const json = createReleaseEmbed(
      watch,
      rel(11, { name: "x".repeat(300) }),
    ).toJSON();
    assert.ok(json.title.length <= 256);
    assert.ok(json.title.endsWith("…"));
  });
});
