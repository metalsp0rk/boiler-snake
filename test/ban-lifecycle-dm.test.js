/**
 * #772 §3 + §5: ban-lifecycle DM copy unit suite (test/ban-lifecycle-dm.test.js).
 *
 * dmCopy.js is the locked user-facing surface — the issue pins the exact
 * sentences, so most tests here assert BYTE-EXACT content, not vibes:
 *  - expiring ban DM renders BOTH <t:UNIX:F> and <t:UNIX:R> at the correct
 *    floored unix seconds (§3 "both required");
 *  - the permanent variant names no stamp and carries the
 *    "staff may lift it at their discretion" sentence;
 *  - the welcome DM copy is §5's exact sentence and never says WHO unbanned;
 *  - every payload carries allowedMentions { parse: [] } (guild names can
 *    never ping);
 *  - #773 seam: `components` is an untouched pass-through — attached
 *    verbatim when provided, absent when not (undefined);
 *  - hard rule: NOTHING in the copy names a moderator, an automod case id,
 *    staff notes or warning history — the builders take no such input and
 *    the payloads are asserted token-free.
 *
 * Pure module — no DB binding needed (dmCopy imports nothing).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBanDm,
  buildWelcomeDm,
  expiryStamps,
} = require("../src/features/banLifecycle/dmCopy");

/** Fixed expiry instant (issue example uses 1761984000 — same shape here). */
const EXPIRES_MS = 1_761_984_000_000;
const EXPIRES_UNIX = 1_761_984_000;

const GUILD = "Boiler Room";

// ── expiring ban DM: locked copy + BOTH timestamp tags ──────────────────────

test("expiring ban DM renders the locked §3 copy with <t:UNIX:F> AND <t:UNIX:R> at the right unix", () => {
  const { content } = buildBanDm({ guildName: GUILD, expiresAtMs: EXPIRES_MS });
  // Acceptance criterion: both substrings, exact unix seconds (floor of ms).
  assert.ok(content.includes(`<t:${EXPIRES_UNIX}:F>`), `:F stamp required: ${content}`);
  assert.ok(content.includes(`<t:${EXPIRES_UNIX}:R>`), `:R stamp required: ${content}`);
  assert.equal(
    content,
      "You have been banned from **Boiler Room**. This ban **expires:** " +
      `<t:${EXPIRES_UNIX}:F> (<t:${EXPIRES_UNIX}:R>). You're welcome back ` +
      "after that — if you'd like to discuss the situation, any staff " +
      "member is happy to help.",
  );
});

test("the label follows the #471 H2-13 idiom: **expires:** with the colon inside the bold", () => {
  const { content } = buildBanDm({ guildName: GUILD, expiresAtMs: EXPIRES_MS });
  assert.ok(content.includes("**expires:** <t:"), `bold label with inner colon: ${content}`);
  assert.ok(!content.includes("expires: **"), "the retired Label: **value** style never appears");
});

test("sub-second expiry milliseconds floor to whole unix seconds in both stamps", () => {
  const ms = EXPIRES_MS + 999;
  const { content } = buildBanDm({ guildName: GUILD, expiresAtMs: ms });
  assert.ok(content.includes(`<t:${EXPIRES_UNIX}:F>`), "floored :F");
  assert.ok(content.includes(`<t:${EXPIRES_UNIX}:R>`), "floored :R");
});

test("expiryStamps is the shared renderer: '<t:U:F> (<t:U:R>)' verbatim", () => {
  assert.equal(expiryStamps(EXPIRES_MS), `<t:${EXPIRES_UNIX}:F> (<t:${EXPIRES_UNIX}:R>)`);
});

// ── permanent variant: no stamp, discretion sentence ────────────────────────

test("permanent ban DM omits every expiry stamp and carries the discretion sentence (exact copy)", () => {
  const expected =
    `You have been banned from **${GUILD}**. This ban **has no set expiry:** ` +
    "staff may lift it at their discretion. If you'd like to discuss the " +
    "situation, any staff member is happy to help.";
  for (const expiresAtMs of [null, undefined, NaN, Infinity, "soon"]) {
    const { content } = buildBanDm({ guildName: GUILD, expiresAtMs });
    assert.equal(content, expected, `permanent variant for expiresAtMs=${String(expiresAtMs)}`);
    assert.ok(!content.includes("<t:"), "no timestamp tag on a permanent ban");
    assert.ok(content.includes("has no set expiry"), "discretion phrasing present");
  }
});

// ── welcome DM (§5): exact copy, never names the unbanner ───────────────────

test("welcome DM is the exact §5 sentence and names nobody who unbanned", () => {
  const payload = buildWelcomeDm({ guildName: GUILD });
  assert.equal(
    payload.content,
    "You've been unbanned from **Boiler Room**. You're welcome back — we " +
    "hope to see you around again. If you'd like to talk about what " +
    "happened, any staff member is happy to help.",
  );
  assert.ok(!/ by /i.test(payload.content), "no 'by <someone>' attribution anywhere");
  assert.ok(!payload.content.includes("<t:"), "welcome copy carries no stamps");
});

// ── allowedMentions: belt on every payload ──────────────────────────────────

test("every payload pins allowedMentions { parse: [] } — a guild named @everyone can never ping", () => {
  const hostile = "@everyone @here";
  const payloads = [
    buildBanDm({ guildName: hostile, expiresAtMs: EXPIRES_MS }),
    buildBanDm({ guildName: hostile }),
    buildWelcomeDm({ guildName: hostile }),
  ];
  for (const p of payloads) {
    assert.deepEqual(p.allowedMentions, { parse: [] });
    // The name rides as literal bold text only — no mention objects exist
    // anywhere a parse list could be ignored.
    assert.ok(p.content.includes("**@everyone @here**"), "hostile name renders as inert text");
  }
});

// ── #773 components pass-through seam ───────────────────────────────────────

test("#773 seam: components rides into the ban payload VERBATIM (identity), untouched", () => {
  const rows = [
    { type: 1, components: [{ type: 2, style: 5, label: "Appeal", custom_id: "bl:appeal:1" }] },
  ];
  const payload = buildBanDm({ guildName: GUILD, expiresAtMs: EXPIRES_MS, components: rows });
  assert.equal(payload.components, rows, "same reference — the appeals button needs no copy change");
});

test("components absent → no components key at all (component-free payload today)", () => {
  const payload = buildBanDm({ guildName: GUILD, expiresAtMs: EXPIRES_MS });
  assert.ok(!("components" in payload), "undefined components never materialise");
});

test("components pass-through is verbatim even for falsy non-undefined values (locked untouched law)", () => {
  assert.deepEqual(buildBanDm({ guildName: GUILD, components: null }).components, null);
  assert.deepEqual(buildBanDm({ guildName: GUILD, components: [] }).components, []);
});

// ── guild-name belt ─────────────────────────────────────────────────────────

test("missing/blank guild names belt to '**the server**' — never an empty bold run", () => {
  for (const name of [null, undefined, "", "   "]) {
    const ban = buildBanDm({ guildName: name, expiresAtMs: EXPIRES_MS });
    const welcome = buildWelcomeDm({ guildName: name });
    assert.ok(ban.content.includes("**the server**"), `ban belt for ${JSON.stringify(name)}`);
    assert.ok(welcome.content.includes("**the server**"), `welcome belt for ${JSON.stringify(name)}`);
    assert.ok(!ban.content.includes("**.**"), "no hollow bold artefacts");
  }
});

// ── privacy law: no moderator / case / warning leakage anywhere ─────────────

test("NO ban/welcome variant ever names a moderator id, an automod case, or a warning", () => {
  const variants = [
    buildBanDm({ guildName: GUILD, expiresAtMs: EXPIRES_MS }).content,
    buildBanDm({ guildName: GUILD }).content,
    buildWelcomeDm({ guildName: GUILD }).content,
    buildBanDm({}).content,
  ];
  for (const content of variants) {
    // Snowflake-SIZED numbers (17-19 digits) would name a user; the expiry
    // stamps are 10-digit unix seconds and are explicitly allowed.
    assert.ok(!/\d{17,}/.test(content), `no snowflake-shaped ids: ${content}`);
    assert.ok(!/\bwarning\b/i.test(content), "warnings history never appears");
    assert.ok(!/\bcase\b/i.test(content), "no automod case wording");
    assert.ok(!/\bA-\d+\b/.test(content), "no automod case refs (A-n)");
    assert.ok(!/\bB-\d+\b/.test(content), "no ban-record refs (B-n) either");
    assert.ok(!/\bW-\d+\b/.test(content), "no warning refs (W-n) either");
    assert.ok(!/@here\b|<@\d/.test(content), "no user pings of any kind");
    assert.ok(!/staff note|staffnotes|harness/i.test(content), "staff-notes/harness vocabulary never leaks");
  }
});

test("the builders take no moderator/case/warning inputs at all (structural privacy belt)", () => {
  // Extra keys are simply not read: adding moderator/case-shaped input
  // cannot make the copy name them — nothing destructures those names.
  const payload = buildBanDm({
    guildName: GUILD,
    expiresAtMs: EXPIRES_MS,
    moderatorId: "123456789012345678",
    moderatorName: "RudeMod",
    caseRef: "A-9",
    warningCount: 4,
  });
  assert.ok(!payload.content.includes("RudeMod"), "moderator name ignored");
  assert.ok(!payload.content.includes("123456789012345678"), "moderator id ignored");
  assert.ok(!payload.content.includes("A-9"), "case ref ignored");
});
