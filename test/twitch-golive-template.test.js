const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_GOLIVE_TEMPLATE_LEN,
  DEFAULT_GOLIVE_TEMPLATE,
  GOLIVE_PLACEHOLDER_TOKENS,
  formatStreamUptime,
  goLiveTemplateContext,
  renderGoLiveTemplate,
  buildGoLiveContent,
  validateGoLiveTemplate,
} = require("../src/features/twitch/templates");

/**
 * Issue #178 — pure unit layer for the per-guild go-live message template.
 * The renderer/context/composition/validation here must never throw and
 * never emit "undefined"/"null" (doctrine), whatever the payload shape.
 * Storage + command + ticker-wire behaviour lives in
 * test/integration/twitch.test.js (issue #178 suite).
 */

const SUB = {
  login: "coolgamer",
  display_name: "CoolGamer",
  profile_image_url: null,
};
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const STREAM = {
  id: "s-1",
  user_id: "42",
  user_login: "coolgamer",
  user_name: "CoolGamer",
  game_name: "Just Chatting",
  title: "Building a bot",
  started_at: new Date(NOW - 90 * 60_000).toISOString(), // 1h 30m ago
  viewer_count: 1234,
};

describe("twitch go-live templates: context builder", () => {
  it("carries every documented placeholder with a non-empty string", () => {
    const ctx = goLiveTemplateContext(SUB, STREAM, NOW);
    assert.deepEqual(Object.keys(ctx).sort(), [...GOLIVE_PLACEHOLDER_TOKENS]
      .map((t) => t.slice(1, -1))
      .sort());
    for (const value of Object.values(ctx)) {
      assert.equal(typeof value, "string");
      assert.ok(value.length > 0, "placeholder values are never empty");
      assert.ok(!/undefined|null/i.test(value), value);
    }
    assert.equal(ctx.streamer, "CoolGamer");
    assert.equal(ctx.login, "coolgamer");
    assert.equal(ctx.title, "Building a bot");
    assert.equal(ctx.game, "Just Chatting");
    assert.equal(ctx.url, "https://twitch.tv/coolgamer");
    assert.equal(ctx.viewers, "1234");
    assert.equal(ctx.uptime, "1h 30m");
  });

  it("streamer/login fall through display_name → login → stream user_name", () => {
    assert.equal(
      goLiveTemplateContext({ login: "fallback", display_name: "" }, null, NOW).streamer,
      "fallback",
    );
    const onlyStream = goLiveTemplateContext(null, { user_name: "SomeName" }, NOW);
    assert.equal(onlyStream.streamer, "SomeName");
    assert.equal(onlyStream.login, "somename", "login derived lowercased");
    assert.equal(onlyStream.url, "https://twitch.tv/somename");
    // Nothing at all: still a placeholder-safe context, never "undefined".
    const empty = goLiveTemplateContext({}, {}, NOW);
    assert.equal(empty.streamer, "a streamer");
    assert.equal(empty.login, "unknown");
    assert.ok(!/undefined|null/.test(JSON.stringify(empty)));
  });

  it("missing stream fields substitute the documented fallbacks", () => {
    const ctx = goLiveTemplateContext(SUB, { id: "x", user_id: "42" }, NOW);
    assert.equal(ctx.title, "Untitled stream");
    assert.equal(ctx.game, "Unknown");
    assert.equal(ctx.viewers, "0");
    assert.equal(ctx.uptime, "just went live");
    // viewer_count 0 is a REAL value, not a missing one.
    assert.equal(
      goLiveTemplateContext(SUB, { viewer_count: 0 }, NOW).viewers,
      "0",
    );
  });

  it("whitespace-only title/game count as missing (trimmed values otherwise)", () => {
    const ctx = goLiveTemplateContext(SUB, { title: "   ", game_name: "" }, NOW);
    assert.equal(ctx.title, "Untitled stream");
    assert.equal(ctx.game, "Unknown");
    assert.equal(
      goLiveTemplateContext(SUB, { title: "  Hi  " }, NOW).title,
      "Hi",
    );
  });
});

describe("twitch go-live templates: uptime formatting", () => {
  it("under a minute, absent, invalid, or future reads 'just went live'", () => {
    assert.equal(formatStreamUptime(new Date(NOW - 30_000).toISOString(), NOW), "just went live");
    assert.equal(formatStreamUptime(null, NOW), "just went live");
    assert.equal(formatStreamUptime(undefined, NOW), "just went live");
    assert.equal(formatStreamUptime("not-a-date", NOW), "just went live");
    assert.equal(formatStreamUptime(new Date(NOW + 600_000).toISOString(), NOW), "just went live");
  });

  it("minutes and h+m buckets, numeric ms accepted", () => {
    assert.equal(formatStreamUptime(NOW - 45 * 60_000, NOW), "45m");
    assert.equal(formatStreamUptime(NOW - 83 * 60_000, NOW), "1h 23m");
    assert.equal(formatStreamUptime(NOW - 59 * 60_000 - 30_000, NOW), "59m");
  });
});

describe("twitch go-live templates: renderer", () => {
  it("substitutes every placeholder (case-insensitive keys)", () => {
    const ctx = goLiveTemplateContext(SUB, STREAM, NOW);
    assert.equal(
      renderGoLiveTemplate(
        "{streamer}|{login}|{title}|{game}|{url}|{viewers}|{uptime}",
        ctx,
      ),
      "CoolGamer|coolgamer|Building a bot|Just Chatting|https://twitch.tv/coolgamer|1234|1h 30m",
    );
    assert.equal(renderGoLiveTemplate("{TITLE} — {Game}", ctx), "Building a bot — Just Chatting");
  });

  it("unknown placeholders stay LITERAL (documented choice: typos stay visible)", () => {
    const ctx = goLiveTemplateContext(SUB, STREAM, NOW);
    assert.equal(renderGoLiveTemplate("Hi {nope} {streamer}", ctx), "Hi {nope} CoolGamer");
    // Prototype keys are not context keys — never resolved, never crash.
    assert.equal(
      renderGoLiveTemplate("{constructor} {__proto__} {toString}", ctx),
      "{constructor} {__proto__} {toString}",
    );
  });

  it("malformed braces are plain text, not placeholders", () => {
    const ctx = goLiveTemplateContext(SUB, STREAM, NOW);
    assert.equal(renderGoLiveTemplate("{ } { streamer } {a-b} {} {1}", ctx), "{ } { streamer } {a-b} {} {1}");
    // "{{streamer}}" = literal brace + rendered token + literal brace; no crash.
    assert.equal(renderGoLiveTemplate("{{streamer}}", ctx), "{CoolGamer}");
  });

  it("values are inserted verbatim — $-patterns and braces in data are inert", () => {
    const title = "Deal: $& + $' off, mentions {streamer} & <@&123> @everyone";
    const out = renderGoLiveTemplate("{title}", { title });
    assert.equal(out, title, "replacement patterns and embedded braces are not reprocessed");
  });

  it("total function: odd inputs never throw", () => {
    assert.equal(renderGoLiveTemplate(null, null), "");
    assert.equal(renderGoLiveTemplate(undefined), "");
    assert.equal(renderGoLiveTemplate("{streamer}", null), "{streamer}", "no context → literal");
    assert.equal(renderGoLiveTemplate("{title}", { title: null }), "", "null value renders empty");
    assert.equal(renderGoLiveTemplate("{title}", { title: 42 }), "42");
    assert.equal(renderGoLiveTemplate(12345, {}), "12345", "non-string template coerced");
  });
});

describe("twitch go-live templates: content composition", () => {
  const oldStyle = (sub, roleId) =>
    roleId ? `<@&${roleId}> **${sub.display_name || sub.login}** is live!` : `**${sub.display_name || sub.login}** is live!`;

  it("unset template is BYTE-IDENTICAL to the pre-#178 content line", () => {
    const ctx = goLiveTemplateContext(SUB, STREAM, NOW);
    assert.equal(
      buildGoLiveContent({ template: null, roleId: null, ctx }),
      oldStyle(SUB, null),
    );
    assert.equal(
      buildGoLiveContent({ template: null, roleId: "r1", ctx }),
      oldStyle(SUB, "r1"),
    );
    assert.equal(
      buildGoLiveContent({ template: "   ", roleId: "r1", ctx }),
      oldStyle(SUB, "r1"),
      "whitespace-only stored template = default",
    );
    assert.equal(
      buildGoLiveContent({ roleId: null, ctx }),
      "**CoolGamer** is live!",
    );
  });

  it("the role mention composes BEFORE the rendered custom template", () => {
    const ctx = goLiveTemplateContext(SUB, STREAM, NOW);
    const out = buildGoLiveContent({
      template: "🔴 {game}: {title}",
      roleId: "r7",
      ctx,
    });
    assert.equal(out, "<@&r7> 🔴 Just Chatting: Building a bot");
    assert.match(out, new RegExp(`^<@&r7> `));
  });

  it("a template with no placeholders renders statically", () => {
    assert.equal(
      buildGoLiveContent({ template: "We are live on Twitch!", roleId: null, ctx: {} }),
      "We are live on Twitch!",
    );
  });

  it("over-long renders clamp to Discord's 2000-char cap, keeping the mention", () => {
    const longTitle = "t".repeat(2500);
    const ctx = goLiveTemplateContext(SUB, { ...STREAM, title: longTitle }, NOW);
    const noRole = buildGoLiveContent({ template: "{title}", roleId: null, ctx });
    assert.equal(noRole.length, MAX_GOLIVE_TEMPLATE_LEN);
    assert.ok(noRole.endsWith("…"));

    const withRole = buildGoLiveContent({ template: "{title}", roleId: "r1", ctx });
    assert.ok(withRole.length <= MAX_GOLIVE_TEMPLATE_LEN, `got ${withRole.length}`);
    assert.ok(withRole.startsWith("<@&r1> "), "the ping never gets truncated away");
    assert.ok(withRole.endsWith("…"));
  });
});

describe("twitch go-live templates: validation service", () => {
  it("trims stored text; accepts exactly the cap", () => {
    assert.deepEqual(validateGoLiveTemplate("  hi {streamer}  "), {
      ok: true,
      template: "hi {streamer}",
    });
    const atCap = "x".repeat(MAX_GOLIVE_TEMPLATE_LEN);
    assert.deepEqual(validateGoLiveTemplate(atCap), { ok: true, template: atCap });
  });

  it("empty / blank / null restore the default (template: null)", () => {
    for (const raw of ["", "   ", "\n\t ", null, undefined]) {
      assert.deepEqual(validateGoLiveTemplate(raw), { ok: true, template: null }, String(raw));
    }
  });

  it("over-length is refused with the specific cause (both lengths named)", () => {
    const tooLong = "x".repeat(MAX_GOLIVE_TEMPLATE_LEN + 1);
    const res = validateGoLiveTemplate(tooLong);
    assert.equal(res.ok, false);
    assert.match(res.error, /2001 characters/);
    assert.match(res.error, /maximum is 2000/);
  });

  it("the default template itself validates and documents every placeholder", () => {
    assert.equal(validateGoLiveTemplate(DEFAULT_GOLIVE_TEMPLATE).ok, true);
    assert.deepEqual(GOLIVE_PLACEHOLDER_TOKENS, [
      "{streamer}",
      "{login}",
      "{title}",
      "{game}",
      "{url}",
      "{viewers}",
      "{uptime}",
    ]);
  });
});
