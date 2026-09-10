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
  formatEventDescription,
  eventUrl,
  buildReminderEmbed,
  buildReminderDelivery,
  canConfigureEventReminder,
  DEFAULT_EMBED_DESCRIPTION,
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
    const msg = renderReminderMessage(
      "Meet in {location} for {event} · {offset} · {url}",
      {
        eventName: "Raid",
        startMs,
        roleId: "99",
        location: "<#42>",
        url: "https://discord.com/events/1/2",
        description: "Bring snacks",
        offset: "1 hour",
      }
    );
    assert.match(msg, /Raid/);
    assert.match(msg, /<#42>/);
    assert.match(msg, /1 hour/);
    assert.match(msg, /discord\.com\/events\/1\/2/);
  });

  it("default template omits empty location clause", () => {
    const startMs = 1_700_000_000_000;
    const msg = renderReminderMessage(
      "Starts {starts_in} ({starts_at}) in {location}.",
      {
        eventName: "Raid",
        startMs,
        roleId: "99",
        location: "",
      }
    );
    assert.equal(
      msg,
      `Starts <t:${Math.floor(startMs / 1000)}:R> (<t:${Math.floor(startMs / 1000)}:F>).`
    );
    assert.doesNotMatch(msg, /\bin\b/);
  });

  it("renderReminderMessage substitutes {description} and {role}", () => {
    const msg = renderReminderMessage("{description} {role}", {
      eventName: "Raid",
      startMs: Date.now(),
      roleId: "1",
      description: "Hello world",
    });
    assert.equal(msg, "Hello world <@&1>");
  });

  it("formatEventLocation mentions channel-hosted events", () => {
    assert.equal(formatEventLocation({ channelId: "111" }), "<#111>");
    assert.equal(
      formatEventLocation({
        channelId: null,
        entityMetadata: { location: "Community Center" },
      }),
      "Community Center"
    );
    assert.equal(formatEventLocation({}), "");
  });

  it("formatEventDescription truncates", () => {
    assert.equal(formatEventDescription({ description: "  hi  " }), "hi");
    const long = "x".repeat(400);
    const out = formatEventDescription({ description: long }, 50);
    assert.ok(out.length <= 50);
    assert.ok(out.endsWith("…"));
  });

  it("eventUrl builds discord events link", () => {
    assert.equal(
      eventUrl("g1", "e1"),
      "https://discord.com/events/g1/e1"
    );
    assert.equal(eventUrl("", "e1"), "");
  });

  it("buildReminderEmbed has title fields and uses default description", () => {
    const startMs = Date.now() + 3_600_000;
    const embed = buildReminderEmbed({
      scheduledEvent: {
        id: "e1",
        name: "Boss Night",
        channelId: "ch1",
        description: "Bring pots",
      },
      guildId: "g1",
      roleId: "r1",
      offsetMinutes: 60,
      template: null,
      startMs,
    });
    const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed.data;
    assert.equal(data.title, "Boss Night");
    assert.equal(data.url, "https://discord.com/events/g1/e1");
    assert.match(data.description || "", /Starts/);
    assert.ok(Array.isArray(data.fields));
    assert.ok(data.fields.some((f) => f.name === "Starts"));
    assert.ok(data.fields.some((f) => f.name === "Location"));
    assert.ok(data.fields.some((f) => /Reminder/i.test(f.name)));
  });

  it("buildReminderDelivery pings role in content with embed", () => {
    const payload = buildReminderDelivery({
      scheduledEvent: { id: "e1", name: "Raid" },
      guildId: "g1",
      roleId: "role99",
      offsetMinutes: 15,
      template: "Custom {event}",
      startMs: Date.now() + 60_000,
    });
    assert.equal(payload.content, "<@&role99>");
    assert.equal(payload.embeds.length, 1);
    assert.deepEqual(payload.allowedMentions, { roles: ["role99"] });
    const data =
      typeof payload.embeds[0].toJSON === "function"
        ? payload.embeds[0].toJSON()
        : payload.embeds[0].data;
    assert.match(data.description || "", /Custom Raid/);
  });

  it("DEFAULT_EMBED_DESCRIPTION is the empty-template body", () => {
    assert.match(DEFAULT_EMBED_DESCRIPTION, /starts_in/);
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
