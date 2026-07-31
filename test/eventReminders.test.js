const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  slugifyShortname,
  normalizeShortname,
  parseCustomOffsets,
  resolveOffsetMinutes,
  buildOffsetRows,
  formatOffsetMinutes,
  renderReminderMessage,
  formatEventLocation,
  canConfigureEventReminder,
} = require("../src/features/eventReminders/service");
const { PermissionFlagsBits } = require("discord.js");

describe("eventReminders service helpers", () => {
  it("slugifyShortname lowercases and strips junk", () => {
    assert.equal(slugifyShortname("Raid Friday!!!"), "raid-friday");
    assert.equal(slugifyShortname("  "), "event");
  });

  it("normalizeShortname validates", () => {
    assert.deepEqual(normalizeShortname("Raid-Night"), {
      ok: true,
      shortname: "raid-night",
    });
    assert.equal(normalizeShortname("event-foo").shortname, "foo");
    assert.equal(normalizeShortname("Bad Name!").ok, false);
    assert.equal(normalizeShortname("").ok, false);
  });

  it("parseCustomOffsets reads m/h/d", () => {
    assert.deepEqual(parseCustomOffsets("2h, 10m, 1d"), [120, 10, 1440]);
    assert.deepEqual(parseCustomOffsets(""), []);
  });

  it("resolveOffsetMinutes unions presets + custom and caps", () => {
    const ok = resolveOffsetMinutes([1440, 60], "15m, 60m");
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.minutes, [1440, 60, 15]);

    const empty = resolveOffsetMinutes([], "");
    assert.equal(empty.ok, false);

    const tooFar = resolveOffsetMinutes([31 * 24 * 60], "");
    assert.equal(tooFar.ok, false);
  });

  it("buildOffsetRows drops past fires", () => {
    const start = Date.now() + 2 * 60 * 60 * 1000; // 2h from now
    const { offsets, skippedPast } = buildOffsetRows(
      [1440, 60, 15],
      start,
      Date.now()
    );
    // 1 day offset is past relative to 2h start
    assert.equal(skippedPast, 1);
    assert.equal(offsets.length, 2);
    assert.ok(offsets.every((o) => o.fireAt > Date.now() - 1000));
  });

  it("formatOffsetMinutes is human-readable", () => {
    assert.equal(formatOffsetMinutes(1440), "1 day");
    assert.equal(formatOffsetMinutes(60), "1 hour");
    assert.equal(formatOffsetMinutes(15), "15 min");
  });

  it("renderReminderMessage substitutes placeholders", () => {
    const startMs = 1_700_000_000_000;
    const msg = renderReminderMessage(null, {
      eventName: "Raid",
      startMs,
      roleId: "99",
    });
    assert.match(msg, /Raid/);
    assert.match(msg, /<@&99>/);
    assert.match(msg, new RegExp(`<t:${Math.floor(startMs / 1000)}:R>`));
  });

  it("formatEventLocation mentions channel-hosted events", () => {
    assert.equal(
      formatEventLocation({ channelId: "111" }),
      "<#111>"
    );
    assert.equal(
      formatEventLocation({
        channelId: null,
        entityMetadata: { location: "Community Center" },
      }),
      "Community Center"
    );
    assert.equal(formatEventLocation({}), "");
  });

  it("renderReminderMessage substitutes {location}", () => {
    const msg = renderReminderMessage("Meet in {location} for {event}", {
      eventName: "Raid",
      startMs: Date.now(),
      roleId: "1",
      location: "<#555>",
    });
    assert.equal(msg, "Meet in <#555> for Raid");
  });

  it("canConfigureEventReminder allows ManageGuild or creator", () => {
    const admin = {
      id: "1",
      permissions: {
        has: (f) => f === PermissionFlagsBits.ManageGuild,
      },
    };
    const creator = {
      id: "creator",
      permissions: { has: () => false },
    };
    const other = {
      id: "x",
      permissions: { has: () => false },
    };
    assert.equal(canConfigureEventReminder(admin, { creatorId: "z" }), true);
    assert.equal(
      canConfigureEventReminder(creator, { creatorId: "creator" }),
      true
    );
    assert.equal(
      canConfigureEventReminder(other, { creatorId: "creator" }),
      false
    );
  });
});
