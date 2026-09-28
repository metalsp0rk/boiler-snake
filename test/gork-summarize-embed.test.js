/**
 * Unit tests for the `/gork summarize` embed renderer
 * (src/features/gork/summarizeEmbed.js — roadmap/gork.md §7.21.4, decision 56).
 *
 * Pure-renderer style (mirrors test/github-releases.test.js embed assertions):
 * feed text + metadata, inspect `toJSON()` output. No Discord, no DB, no clock.
 * Covers: single-embed render, footer range links + invoker, disclosed-window
 * field only-when-clamped, >budget text yields embed-only continuations
 * (all characters preserved, decision-32-friendly), Discord budget on every
 * embed (incl. the ~6,000-char practical budget), code-point-safe cuts, and
 * the NO_PING_MENTIONS wiring for the poster.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EmbedBuilder } = require("discord.js");

const SE = require("../src/features/gork/summarizeEmbed");
const { NO_PING_MENTIONS: SANITIZE_NPM } = require("../src/features/gork/sanitize");
const { Color } = require("../src/core/theme");

// ---------- helpers ----------

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const FIRST = "333333333333333333";
const LAST = "444444444444444444";

const msgUrl = (id) => `https://discord.com/channels/${GUILD}/${CHANNEL}/${id}`;

/** Full happy-path metadata for the footer tests. */
const meta = (over = {}) => ({
  guildId: GUILD,
  mode: "last:50",
  range: { firstId: FIRST, lastId: LAST, channelId: CHANNEL },
  invoker: { id: "555555555555555555", username: "modder" },
  ...over,
});

/** EmbedBuilder-or-plain → plain JSON payload. */
const json = (e) => (e && typeof e.toJSON === "function" ? e.toJSON() : e);

/** Field value by name, or "" when absent. */
function fieldValue(embed, name) {
  const f = (json(embed).fields ?? []).find((x) => x.name === name);
  return f ? f.value : "";
}

/** Total char weight of a payload: title + description + fields + footer. */
function totalChars(embed) {
  const j = json(embed);
  return (
    (j.title?.length ?? 0) +
    (j.description?.length ?? 0) +
    (j.footer?.text?.length ?? 0) +
    (j.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

/** Hard Discord limits + the §7.21.4 ~6,000-char practical embed budget. */
function assertDiscordBudget(embed) {
  const j = json(embed);
  assert.ok((j.title ?? "").length <= 256, "title <= 256");
  assert.ok((j.description ?? "").length <= 4096, "description <= 4096");
  assert.ok((j.fields ?? []).length <= 25, "fields <= 25");
  for (const f of j.fields ?? []) {
    assert.ok(f.name.length <= 256, "field name <= 256");
    assert.ok(f.value.length <= 1024, "field value <= 1024");
  }
  assert.ok((j.footer?.text ?? "").length <= 2048, "footer <= 2048");
  assert.ok(totalChars(embed) <= 6000, `embed total ${totalChars(embed)} <= 6000`);
}

/** True when s contains a lone (unpaired) surrogate code unit. */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** ~8,889 chars of newline-separated lines (safely past one embed). */
function longText() {
  return Array.from({ length: 225 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
}

// ---------- renderSummarizeEmbeds: normal render ----------

describe("renderSummarizeEmbeds — normal single-embed render", () => {
  it("renders one themed embed for a normal rundown", () => {
    const embeds = SE.renderSummarizeEmbeds("**Headline**\nstuff happened", meta());
    assert.equal(embeds.length, 1);
    const e = embeds[0];
    assert.ok(e instanceof EmbedBuilder);
    const j = json(e);
    assert.equal(j.title, SE.RUNDOWN_TITLE);
    assert.equal(j.description, "**Headline**\nstuff happened");
    assert.equal(j.color, Color.brand);
    assertDiscordBudget(e);
  });

  it("stamps no timestamp unless the caller asks (pure: no clock reads)", () => {
    const plain = SE.renderSummarizeEmbeds("a", meta())[0];
    assert.equal(json(plain).timestamp, undefined);
    const stamp = new Date(1_700_000_000_000);
    const stamped = SE.renderSummarizeEmbeds("a", meta({ timestamp: stamp }))[0];
    assert.equal(json(stamped).timestamp, stamp.toISOString());
  });

  it("shows the mode in an inline field when provided, omits it otherwise", () => {
    assert.equal(fieldValue(SE.renderSummarizeEmbeds("a", meta())[0], "Mode"), "last:50");
    assert.equal(fieldValue(SE.renderSummarizeEmbeds("a", {})[0], "Mode"), "");
  });

  it("truncates oversized mode field values to its 200-char cap", () => {
    const value = fieldValue(
      SE.renderSummarizeEmbeds("a", meta({ mode: "m".repeat(500) }))[0],
      "Mode",
    );
    assert.ok(value.length <= 201, "cap + ellipsis");
    assert.ok(value.endsWith("…"));
  });

  it("degrades to a minimal valid embed for empty/garbage input (never throws)", () => {
    for (const input of ["", "   ", null, undefined, 0, false, {}]) {
      const embeds = SE.renderSummarizeEmbeds(input, {});
      assert.equal(embeds.length, 1, `one embed for ${String(input)}`);
      const j = json(embeds[0]);
      assert.ok(j.title && (j.description || (j.fields ?? []).length), "valid embed payload");
      assertDiscordBudget(embeds[0]);
    }
  });

  it("degrades gracefully when even stringification explodes", () => {
    const embeds = SE.renderSummarizeEmbeds(Symbol("nope"), meta());
    assert.equal(embeds.length, 1);
    assert.equal(json(embeds[0]).title, SE.RUNDOWN_TITLE);
    assertDiscordBudget(embeds[0]);
  });

  it("tolerates garbage metadata without throwing", () => {
    const embeds = SE.renderSummarizeEmbeds(
      "fine",
      { guildId: null, range: "oops", invoker: 42, clamp: "nope", timestamp: "nope" },
    );
    assert.equal(embeds.length, 1);
    assertDiscordBudget(embeds[0]);
  });
});

// ---------- footer (decision 56) ----------

describe("renderSummarizeEmbeds — footer range links + invoker", () => {
  it("footer carries [firstUrl → lastUrl] and the invoking user", () => {
    const footer = json(SE.renderSummarizeEmbeds("a", meta())[0]).footer.text;
    assert.ok(footer.includes(`[${msgUrl(FIRST)} → ${msgUrl(LAST)}]`));
    assert.ok(footer.includes("Requested by @modder"));
  });

  it("prefers displayName over username for the invoker label", () => {
    const footer = json(
      SE.renderSummarizeEmbeds("a", meta({ invoker: { id: "1", username: "u", displayName: "Mod M" } }))[0],
    ).footer.text;
    assert.ok(footer.includes("Requested by @Mod M"));
  });

  it("falls back to @someone for an id-only invoker and omits nothing else", () => {
    const footer = json(SE.renderSummarizeEmbeds("a", meta({ invoker: { id: "9" } }))[0]).footer.text;
    assert.ok(footer.includes("@someone"));
    assert.ok(footer.includes(msgUrl(FIRST)));
  });

  it("bare ids when the channel leg is missing; degrades to no footer when nothing is known", () => {
    const bareEmbed = SE.renderSummarizeEmbeds("a", {
      range: { firstId: FIRST, lastId: LAST },
    })[0];
    assert.ok(json(bareEmbed).footer.text.includes(`[${FIRST} → ${LAST}]`));
    const none = json(SE.renderSummarizeEmbeds("a", {})[0]);
    assert.equal(none.footer, undefined);
  });
});

// ---------- disclosed window ----------

describe("renderSummarizeEmbeds — disclosed-window line", () => {
  it("includes the disclosed window only when the read was clamped", () => {
    const clamped = SE.renderSummarizeEmbeds("a", meta({
      clamp: { clamped: true, read: 850, requested: 1000, reason: "1,000-message cap" },
    }))[0];
    const value = fieldValue(clamped, "Disclosed window");
    assert.ok(value.includes("Cap hit — read"));
    assert.ok(value.includes("850 of 1000 messages"));
    assert.ok(value.includes("1,000-message cap"));
    assertDiscordBudget(clamped);

    assert.equal(fieldValue(SE.renderSummarizeEmbeds("a", meta())[0], "Disclosed window"), "");
    assert.equal(
      fieldValue(
        SE.renderSummarizeEmbeds("a", meta({ clamp: { clamped: false, read: 10 } }))[0],
        "Disclosed window",
      ),
      "",
    );
  });

  it("prefers the handler-supplied disclosure string byte-for-byte (embed and reply repeat the same line)", () => {
    const custom = "Reader said: oldest 3 messages fitted the transcript cap.";
    const embed = SE.renderSummarizeEmbeds("a", meta({
      disclosure: custom,
      clamp: { clamped: true, reason: "ignored because disclosure wins" },
    }))[0];
    assert.equal(fieldValue(embed, "Disclosed window"), custom);
  });

  it("truncates a runaway disclosure to its field cap and stays budget-valid", () => {
    const embed = SE.renderSummarizeEmbeds("a", meta({ disclosure: "d".repeat(5000) }))[0];
    assert.ok(fieldValue(embed, "Disclosed window").length <= 601);
    assertDiscordBudget(embed);
  });
});

describe("formatWindowDisclosure", () => {
  it("returns '' when nothing clamped", () => {
    assert.equal(SE.formatWindowDisclosure(undefined), "");
    assert.equal(SE.formatWindowDisclosure({ clamped: false }), "");
  });

  it("names label + counts + reason when all are present", () => {
    assert.equal(
      SE.formatWindowDisclosure({
        clamped: true,
        windowLabel: `${FIRST}→${LAST}`,
        read: 850,
        requested: 1000,
        reason: "over the 1,000-message cap",
      }),
      `Cap hit — read ${FIRST}→${LAST} (850 of 1000 messages): over the 1,000-message cap`,
    );
  });

  it("degrades to sane defaults from partial info", () => {
    assert.equal(
      SE.formatWindowDisclosure({ clamped: true, read: 1 }),
      "Cap hit — read 1 message",
    );
    assert.equal(
      SE.formatWindowDisclosure({ clamped: true, read: 42 }),
      "Cap hit — read 42 messages",
    );
    assert.equal(
      SE.formatWindowDisclosure({ clamped: true, reason: "12k transcript cap" }),
      "Cap hit — read the largest window the caps allow: 12k transcript cap",
    );
    assert.equal(SE.formatWindowDisclosure({ clamped: true }), "Cap hit — read the largest window the caps allow");
  });

  it("never lets numeric garbage produce NaN prose", () => {
    assert.equal(
      SE.formatWindowDisclosure({ clamped: true, read: "x", requested: null }),
      "Cap hit — read the largest window the caps allow",
    );
  });
});

// ---------- overflow → continuation embeds ----------

describe("renderSummarizeEmbeds — overflow continuation embeds", () => {
  it("splits >budget text into embed-only continuations (never plain text)", () => {
    const text = longText();
    assert.ok(text.length > 6000, "fixture must exceed the embed budget");
    const embeds = SE.renderSummarizeEmbeds(text, meta());
    assert.equal(embeds.length, 3, "line-aligned chunks under EMBED_BODY_MAX");
    for (const e of embeds) {
      assert.ok(e instanceof EmbedBuilder, "every continuation is an EMBED");
      const j = json(e);
      assert.equal(j.content, undefined, "no plain-text message content anywhere");
      assert.ok(j.description.length >= 1);
      assert.ok(j.description.length <= SE.EMBED_BODY_MAX);
      assertDiscordBudget(e);
    }
  });

  it("titles continuations (continued i/n) and keeps the footer on every embed", () => {
    const embeds = SE.renderSummarizeEmbeds(longText(), meta());
    const titles = embeds.map((e) => json(e).title);
    assert.deepEqual(titles, [
      "Gork rundown",
      "Gork rundown (continued 2/3)",
      "Gork rundown (continued 3/3)",
    ]);
    const footers = embeds.map((e) => json(e).footer.text);
    assert.ok(footers.every((f) => f === footers[0] && f.includes(msgUrl(LAST))));
  });

  it("preserves every character across chunks (all-chunks-land joinable input)", () => {
    const text = longText();
    const embeds = SE.renderSummarizeEmbeds(text, meta());
    assert.equal(embeds.map((e) => json(e).description).join(""), text);
  });

  it("puts meta fields only on the primary embed", () => {
    const embeds = SE.renderSummarizeEmbeds(longText(), meta({
      clamp: { clamped: true, read: 900, requested: 1000 },
    }));
    assert.ok(fieldValue(embeds[0], "Disclosed window").length > 0);
    assert.equal(fieldValue(embeds[1], "Disclosed window"), "");
    assert.equal(fieldValue(embeds[1], "Mode"), "");
  });

  it("cuts on newline boundaries and hard-cuts code-point-safe mid long lines", () => {
    // No newlines at all: forces the sliceSafe hard cut exactly across a
    // surrogate pair (high half at index 3999, low half at 4000).
    const text = "a".repeat(3999) + "😀" + "b".repeat(100);
    const embeds = SE.renderSummarizeEmbeds(text, meta());
    assert.equal(embeds.length, 2);
    const [a, b] = embeds.map((e) => json(e).description);
    assert.equal(a, "a".repeat(3999), "pair never split");
    assert.ok(b.startsWith("😀"));
    for (const d of [a, b]) assert.ok(!hasLoneSurrogate(d));
    assert.equal(a + b, text);
  });

  it("stays budget-valid for 50k-char oversized input", () => {
    const embeds = SE.renderSummarizeEmbeds(longText().repeat(6), meta());
    assert.ok(embeds.length > 10);
    for (const e of embeds) assertDiscordBudget(e);
    assert.equal(embeds.map((e) => json(e).description).join("").length, longText().repeat(6).length);
  });
});

// ---------- NO_PING_MENTIONS wiring (poster contract) ----------

describe("NO_PING_MENTIONS wiring", () => {
  it("re-exports the exact sanitize.js constant the poster must pass", () => {
    assert.equal(SE.NO_PING_MENTIONS, SANITIZE_NPM);
    assert.deepEqual(SE.NO_PING_MENTIONS, { parse: [] });
  });

  it("stamps allowedMentions on every payload, one embed per message, in order", () => {
    const embeds = SE.renderSummarizeEmbeds(longText(), meta());
    const payloads = SE.buildRundownPayloads(embeds);
    assert.equal(payloads.length, embeds.length);
    for (let i = 0; i < payloads.length; i += 1) {
      assert.equal(payloads[i].allowedMentions, SE.NO_PING_MENTIONS);
      assert.deepEqual(payloads[i].embeds, [embeds[i]], "same embed object, same order");
      assert.equal(payloads[i].content, undefined, "embed-only payload, never plain text");
    }
  });

  it("survives mention-token litter in the text (sanitize rewrote upstream; pings die via allowedMentions)", () => {
    const embeds = SE.renderSummarizeEmbeds("@everyone @here <@123> <@&456> stay loud", meta());
    assert.equal(embeds.length, 1);
    assert.ok(json(embeds[0]).description.includes("@everyone")); // text stays as given
    const [payload] = SE.buildRundownPayloads(embeds);
    assert.deepEqual(payload.allowedMentions, { parse: [] }); // ...and can never ping
  });

  it("buildRundownPayloads tolerates single-embed and empty input", () => {
    const single = SE.renderSummarizeEmbeds("a", {})[0];
    assert.equal(SE.buildRundownPayloads(single).length, 1);
    assert.deepEqual(SE.buildRundownPayloads([]), []);
    assert.deepEqual(SE.buildRundownPayloads(null), []);
  });
});

// ---------- small pure helpers ----------

describe("helpers", () => {
  it("messageJumpUrl needs all three id legs", () => {
    assert.equal(SE.messageJumpUrl(GUILD, CHANNEL, FIRST), msgUrl(FIRST));
    assert.equal(SE.messageJumpUrl(null, CHANNEL, FIRST), null);
    assert.equal(SE.messageJumpUrl(GUILD, undefined, FIRST), null);
    assert.equal(SE.messageJumpUrl(GUILD, CHANNEL, ""), null);
  });

  it("formatUserHandle handles strings, wrappers, and unknowns", () => {
    assert.equal(SE.formatUserHandle("@duo"), "@duo");
    assert.equal(SE.formatUserHandle("duo"), "@duo");
    assert.equal(SE.formatUserHandle({ user: { username: "wrapped" } }), "@wrapped");
    assert.equal(SE.formatUserHandle(null), "");
    assert.equal(SE.formatUserHandle({}), "");
  });

  it("formatRangeLabel renders half-known ranges instead of going silent", () => {
    const half = SE.formatRangeLabel({ lastId: LAST, channelId: CHANNEL }, GUILD);
    assert.ok(half.startsWith("[… → ") && half.includes(msgUrl(LAST)));
    assert.equal(SE.formatRangeLabel({}, GUILD), "");
    assert.equal(SE.formatRangeLabel(null, null), "");
  });
});
