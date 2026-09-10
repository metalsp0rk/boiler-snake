const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { describeError } = require("../src/features/twitch/helix");

describe("describeError", () => {
  it("surfaces the undici DNS cause instead of a bare TypeError", () => {
    // Node wraps network failures as TypeError: fetch failed with the
    // real reason in err.cause — the prod "Helix /streams failed: TypeError"
    // bug was this cause never being logged.
    const cause = Object.assign(
      new Error("getaddrinfo ENOTFOUND api.twitch.tv"),
      { code: "ENOTFOUND" },
    );
    const err = Object.assign(new TypeError("fetch failed"), { cause });

    const text = describeError(err);

    assert.match(text, /^TypeError: fetch failed/);
    assert.match(text, /\| cause: getaddrinfo ENOTFOUND api\.twitch\.tv$/);
    assert.ok(!text.includes("ENOTFOUND ENOTFOUND"), "should not repeat the code");
  });

  it("prefixes the cause code when the cause message omits it", () => {
    const cause = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause });

    assert.match(describeError(err), /\| cause: ECONNRESET socket hang up$/);
  });

  it("keeps plain errors on one line without a cause section", () => {
    assert.equal(describeError(new Error("boom")), "Error: boom");
  });

  it("keeps legacy code-on-error errors informative without duplication", () => {
    const err = Object.assign(
      new Error("getaddrinfo EAI_AGAIN api.twitch.tv"),
      { code: "EAI_AGAIN" },
    );

    assert.equal(describeError(err), "Error: getaddrinfo EAI_AGAIN api.twitch.tv");
  });

  it("adds a code suffix when the top-level message lacks it", () => {
    const err = Object.assign(new Error("request timed out"), {
      code: "ETIMEDOUT",
    });

    assert.equal(describeError(err), "Error (ETIMEDOUT): request timed out");
  });

  it("handles string causes", () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: "boom" });

    assert.match(describeError(err), /\| cause: boom$/);
  });

  it("stringifies nullish errors", () => {
    assert.equal(describeError(null), "null");
    assert.equal(describeError(undefined), "undefined");
  });
});
