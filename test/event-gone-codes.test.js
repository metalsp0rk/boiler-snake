/**
 * Unit tests: the events feature's terminal "gone" code set (#432) and the
 * eventReminders ticker's event-gone set (#814).
 *
 * GONE_CODES used to include 10060 — per discord-api-types v10 that is
 * UnknownSticker. Events never post stickers, so a sticker-coded failure can
 * only mean API drift or a mock bug, yet every isGoneError consumer
 * (refresh skip, reminder RETIRE, crosspost copy drop) treated it as
 * terminal "gone" and discarded the work silently. The real message/channel
 * gone-family keeps working; 10060 never resolves as gone again.
 *
 * The second block (#814) pins GONE_EVENT_CODES against the discord-api-types
 * ENUM SYMBOLS (the transitive copy discord.js itself ships — production
 * reads codes through that same package), so a future SDK-constant drift or
 * a "fix" toward a lookalike code (the 10066 =
 * UnknownApplicationCommandPermissions impostor) fails here instead of
 * silently re-killing the reminder gone-flow.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();
const { isGoneError } = require("../src/features/events/service");
const {
  GONE_EVENT_CODES,
  isGoneError: tickerIsGoneError,
} = require("../src/features/eventReminders/ticker");
const { RESTJSONErrorCodes } = require("discord-api-types/v10");

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

describe("eventReminders ticker GONE_EVENT_CODES — pinned to SDK enum (#814)", () => {
  it("carries exactly the UnknownGuildScheduledEvent family", () => {
    assert.equal(
      GONE_EVENT_CODES.has(RESTJSONErrorCodes.UnknownGuildScheduledEvent),
      true,
      `UnknownGuildScheduledEvent (${RESTJSONErrorCodes.UnknownGuildScheduledEvent}) is gone`,
    );
    assert.equal(
      GONE_EVENT_CODES.has(RESTJSONErrorCodes.UnknownGuildScheduledEventUser),
      true,
      `UnknownGuildScheduledEventUser (${RESTJSONErrorCodes.UnknownGuildScheduledEventUser}) is gone`,
    );
    assert.equal(
      GONE_EVENT_CODES.size,
      2,
      "exactly the two scheduled-event gone codes — nothing else owns this seam",
    );
  });

  it("NEVER accepts the 10066 UnknownApplicationCommandPermissions impostor (#814 regression)", () => {
    assert.equal(
      RESTJSONErrorCodes.UnknownApplicationCommandPermissions,
      10066,
      "the impostor's real identity in the pinned SDK",
    );
    assert.equal(GONE_EVENT_CODES.has(10066), false);
    assert.equal(
      tickerIsGoneError({ code: 10066 }, GONE_EVENT_CODES),
      false,
      "a 10066 fetch failure stays TRANSIENT (retry), never retires a reminder",
    );
  });

  it("classifies a 10070 DiscordAPIError-shaped failure as gone", () => {
    assert.equal(
      tickerIsGoneError({ code: 10070 }, GONE_EVENT_CODES),
      true,
      "real deleted-event code resolves terminal",
    );
    assert.equal(
      tickerIsGoneError({ rawError: { code: 10070 } }, GONE_EVENT_CODES),
      true,
      "rawError unwrap kept",
    );
    assert.equal(
      tickerIsGoneError({ code: 10071 }, GONE_EVENT_CODES),
      true,
      "per-user gone code resolves terminal",
    );
    assert.equal(
      tickerIsGoneError({ code: 500 }, GONE_EVENT_CODES),
      false,
      "a 5xx stays transient",
    );
  });
});
