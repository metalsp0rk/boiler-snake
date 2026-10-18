/**
 * Unit tests: the events feature's terminal "gone" code set (#432).
 *
 * GONE_CODES used to include 10060 — per discord-api-types v10 that is
 * UnknownSticker. Events never post stickers, so a sticker-coded failure can
 * only mean API drift or a mock bug, yet every isGoneError consumer
 * (refresh skip, reminder RETIRE, crosspost copy drop) treated it as
 * terminal "gone" and discarded the work silently. The real message/channel
 * gone-family keeps working; 10060 never resolves as gone again.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();
const { isGoneError } = require("../src/features/events/service");

after(cleanup);

describe("events isGoneError — terminal gone code set (#432)", () => {
  it("accepts the real channel/message gone family", () => {
    assert.equal(isGoneError({ code: 10003 }), true, "UnknownChannel");
    assert.equal(isGoneError({ code: 10004 }), true, "UnknownGuildChannel");
    assert.equal(isGoneError({ code: 10008 }), true, "UnknownMessage");
    assert.equal(
      isGoneError({ rawError: { code: 10008 } }),
      true,
      "rawError unwrap kept",
    );
  });

  it("NEVER accepts the UnknownSticker code 10060 (#432)", () => {
    assert.equal(isGoneError({ code: 10060 }), false);
    assert.equal(isGoneError({ rawError: { code: 10060 } }), false);
  });

  it("rejects unrelated codes and codeless errors", () => {
    assert.equal(isGoneError({ code: 50035 }), false, "InvalidFormBody is NOT gone");
    assert.equal(isGoneError(new Error("boom")), false);
    assert.equal(isGoneError(undefined), false);
  });
});
