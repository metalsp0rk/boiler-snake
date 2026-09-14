/**
 * Unit tests for the replay harness (test/helpers/replay.js) — Phase C of
 * the gork interaction-logging work. Fast, no DB: the harness plumbing
 * (env arming, fetch scripting, fixture loading) must be trustworthy
 * before anyone trusts a replay test.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  AI_ENV_KEYS,
  IL_ENV_KEYS,
  loadFixture,
  saveEnv,
  restoreEnv,
  armEnv,
  scriptFetch,
  jsonResponse,
} = require("./helpers/replay");

describe("replay harness: env save/restore", () => {
  it("restoreEnv puts every managed key back byte-exactly", () => {
    const probe = AI_ENV_KEYS[0];
    const original = Object.prototype.hasOwnProperty.call(process.env, probe)
      ? process.env[probe]
      : undefined;
    const saved = saveEnv();
    try {
      armEnv();
      assert.equal(process.env.OPENAI_API_KEY, "replay-test-key");
      assert.equal(process.env.GORK_INTERACTION_LOG, "1");
    } finally {
      restoreEnv(saved);
    }
    if (original === undefined) assert.equal(process.env[probe], undefined);
    else assert.equal(process.env[probe], original);
  });

  it("armEnv clears every AI + interaction-log key before setting its own", () => {
    const saved = saveEnv();
    try {
      for (const key of [...AI_ENV_KEYS, ...IL_ENV_KEYS]) {
        if (key !== "OPENAI_API_KEY" && key !== "GORK_INTERACTION_LOG") {
          process.env[key] = "polluted";
        }
      }
      armEnv();
      for (const key of [...AI_ENV_KEYS, ...IL_ENV_KEYS]) {
        if (key === "OPENAI_API_KEY" || key === "GORK_INTERACTION_LOG") continue;
        assert.equal(process.env[key], undefined, `${key} should be cleared`);
      }
    } finally {
      restoreEnv(saved);
    }
  });
});

describe("replay harness: scriptFetch", () => {
  it("serves scripted bodies in order and records the calls", async () => {
    const saved = saveEnv();
    const mock = scriptFetch([
      { urlIncludes: "chat/completions", body: { ok: 1 } },
      { urlIncludes: "chat/completions", body: { ok: 2 } },
    ]);
    try {
      const a = await globalThis.fetch("https://api.example/v1/chat/completions", {
        body: "first",
      });
      const b = await globalThis.fetch("https://api.example/v1/chat/completions", {
        body: "second",
      });
      assert.deepEqual(await a.json(), { ok: 1 });
      assert.deepEqual(await b.json(), { ok: 2 });
      assert.equal(mock.calls.length, 2);
      assert.equal(mock.calls[0].body, "first");
    } finally {
      mock.restore();
      restoreEnv(saved);
    }
  });

  it("rejects a call with no matching pending turn (no silent network)", async () => {
    const mock = scriptFetch([{ urlIncludes: "giphy", body: {} }]);
    try {
      await assert.rejects(
        () => globalThis.fetch("https://api.example/v1/chat/completions"),
        /unexpected call/,
      );
    } finally {
      mock.restore();
    }
  });

  it("urlMatch filler serves non-chat URLs but never eats a chat call", async () => {
    // The exact filler shape replayInteraction scripts for network tools:
    // an unexpected EXTRA chat/completions call must hit the loud guard,
    // not silently consume the filler body (an old "http" substring match
    // matched every URL, chat included — the silent-sink hole).
    const mock = scriptFetch([
      { urlIncludes: "chat/completions", body: { ok: 1 } },
      { urlMatch: (u) => !u.includes("chat/completions"), body: { filler: true } },
    ]);
    try {
      const chat = await globalThis.fetch("https://api.example/v1/chat/completions");
      assert.deepEqual(await chat.json(), { ok: 1 });
      const tool = await globalThis.fetch("https://example.com/page");
      assert.deepEqual(await tool.json(), { filler: true });
      await assert.rejects(
        () => globalThis.fetch("https://api.example/v1/chat/completions"),
        /unexpected call/,
        "an extra chat call still throws after the filler is scripted",
      );
      assert.equal(mock.calls.length, 3, "the rejected call was still recorded");
    } finally {
      mock.restore();
    }
  });

  it("jsonResponse mirrors fetch Response shape for status gates", () => {
    assert.equal(jsonResponse({}, 500).ok, false);
    assert.equal(jsonResponse({}, 200).ok, true);
  });
});

describe("replay harness: loadFixture", () => {
  it("accepts v1 fixtures", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "replay-unit-")),
      "f.json",
    );
    fs.writeFileSync(file, JSON.stringify({ v: 1, kind: "qa" }));
    assert.equal(loadFixture(file).kind, "qa");
  });

  it("rejects unsupported fixture versions", () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "replay-unit-")),
      "f.json",
    );
    fs.writeFileSync(file, JSON.stringify({ v: 2 }));
    assert.throws(() => loadFixture(file), /unsupported fixture version/);
  });
});
