/**
 * #772 §1: ban-duration parser unit suite (test/ban-lifecycle-duration.test.js).
 *
 * parseDuration is the pure gate of the ban surface — the #745
 * never-act-on-misread law lives here: every refused input answers with copy
 * that (a) names the exact field (**Duration:**), (b) gives the grammar
 * example (24h or 7d), and (c) states "Nothing was banned." — never a throw,
 * never a silent clamp.
 *
 * Pinned contract surface (duration.js header, issue §1 table):
 *  - permanent / "" / null / undefined  → { ok: true, expiresAtMs: null };
 *  - <n><s|m|h|d> → exact nowMs + span, case-insensitive, inner whitespace ok;
 *  - bounds: 60 s floor and 365 d cap are VALID exactly at the bound, refused
 *    one unit past it (floor/cap refusals name the bound AND the example);
 *  - every malformed shape refuses with the same field-named copy;
 *  - injectable clock: (raw, nowMs) is fully deterministic; the wall-clock
 *    default only exists at the call boundary.
 *
 * The module is the db-free/`discord.js`-free pure layer (constants.js
 * header), so this file stays pure too: no loadDb, no timers, fixed NOW.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseDuration } = require("../src/features/banLifecycle/duration");
const {
  DURATION_MIN_MS,
  DURATION_MAX_MS,
  DURATION_EXAMPLES,
  MODAL_LABEL_DURATION,
} = require("../src/features/banLifecycle/constants");

/** Fixed reference instant — the whole table is deterministic against it. */
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Every refusal must carry all three #745 elements. */
function assertRefusal(res, shown = null) {
  assert.equal(res.ok, false, `expected refusal, got ${JSON.stringify(res)}`);
  assert.equal(typeof res.error, "string");
  // (a) names the exact field the staffer has to fix…
  assert.ok(
    res.error.includes(`**${MODAL_LABEL_DURATION}:**`),
    `refusal must name "**Duration:**": ${res.error}`,
  );
  // (b) …with the grammar example (both example tokens)…
  assert.ok(res.error.includes(DURATION_EXAMPLES), `must include "${DURATION_EXAMPLES}": ${res.error}`);
  // (c) …and state that nothing happened (#745).
  assert.ok(res.error.includes("Nothing was banned."), `must say nothing was banned: ${res.error}`);
  if (shown !== null) {
    assert.ok(res.error.includes(`\`${shown}\``), `must quote the shown input: ${res.error}`);
  }
}

// ── permanent / empty → no expiry ───────────────────────────────────────────

test("permanent, empty, null and undefined all parse to a permanent ban (expiresAtMs null)", () => {
  for (const raw of ["permanent", "PERMANENT", "Permanent", " permanent ", "", "   ", null, undefined]) {
    assert.deepEqual(
      parseDuration(raw, NOW),
      { ok: true, expiresAtMs: null },
      `raw ${JSON.stringify(raw)} → permanent`,
    );
  }
});

// ── valid spans → exact ms against the injected clock ───────────────────────

// NOTE: 30s is NOT a valid case — the 60 s floor rejects it (issue §1);
// the seconds unit rides the matrix via 75s instead.
test("24h / 7d / 90m / 75s resolve to exact nowMs + span arithmetic", () => {
  const cases = [
    ["75s", 75 * SEC],
    ["90m", 90 * MIN],
    ["24h", 24 * HOUR],
    ["7d", 7 * DAY],
    ["1d", DAY],
    ["3650m", 3650 * MIN],
  ];
  for (const [raw, span] of cases) {
    assert.deepEqual(parseDuration(raw, NOW), { ok: true, expiresAtMs: NOW + span }, raw);
  }
});

test("unit letters are case-insensitive and inner whitespace is tolerated", () => {
  const shapes = [
    ["24H", 24 * HOUR],
    ["7D", 7 * DAY],
    ["90M", 90 * MIN],
    ["75S", 75 * SEC],
    [" 24h ", 24 * HOUR],
    ["24 h", 24 * HOUR],
    ["7\t d", 7 * DAY],
  ];
  for (const [raw, span] of shapes) {
    assert.deepEqual(parseDuration(raw, NOW), { ok: true, expiresAtMs: NOW + span }, JSON.stringify(raw));
  }
});

// ── bounds: EXACTLY at floor/cap is valid (never clamped, never refused) ────

test("bounds are inclusive: 60s (floor) and 365d (cap) parse exactly valid", () => {
  assert.equal(DURATION_MIN_MS, 60_000, "floor constant is 60 s");
  assert.equal(DURATION_MAX_MS, 365 * DAY, "cap constant is 365 d");
  assert.deepEqual(parseDuration("60s", NOW), { ok: true, expiresAtMs: NOW + 60_000 });
  assert.deepEqual(parseDuration("1m", NOW), { ok: true, expiresAtMs: NOW + 60_000 });
  assert.deepEqual(parseDuration("365d", NOW), {
    ok: true,
    expiresAtMs: NOW + DURATION_MAX_MS,
  });
});

// ── floor refusals: < 60 s rejected naming Duration + floor + example ───────

test("sub-floor durations (59s, 0s, 0d, 45s) refuse naming Duration, the 60s floor and the example", () => {
  for (const raw of ["59s", "0s", "0d", "45s", "1s"]) {
    const res = parseDuration(raw, NOW);
    assertRefusal(res, raw);
    assert.ok(res.error.includes("shorter than the 60s minimum"), `floor named: ${res.error}`);
    // Example tokens (acceptance criterion): both grammar examples present.
    assert.ok(res.error.includes("24h") && res.error.includes("7d"), `example tokens: ${res.error}`);
  }
});

// ── cap refusals: > 365 d rejected naming the cap + example ─────────────────

test("over-cap durations (366d, 400d, absurd digit overflow) refuse naming the 365d cap + example", () => {
  for (const raw of ["366d", "400d", "9999d", "8761h", "99999999999999999999d"]) {
    const res = parseDuration(raw, NOW);
    assertRefusal(res, raw);
    assert.ok(res.error.includes("longer than the 365d maximum"), `cap named: ${res.error}`);
    assert.ok(res.error.includes("24h") && res.error.includes("7d"), `example tokens: ${res.error}`);
  }
});

// ── malformed grammar: refuse, never throw, same three-element copy ─────────

test("malformed forms all refuse with the field-named example copy (no throw)", () => {
  const malformed = [
    "abc",
    "7",
    "h",
    "7x",
    "d7",
    "24hh",
    "1.5h",
    "-3d",
    "seven days",
    "7 days",
    "permanent-ish",
    "24 hours",
    "in 3 days",
    "7d 7d",
  ];
  for (const raw of malformed) {
    const res = parseDuration(raw, NOW);
    assertRefusal(res, raw);
    assert.ok(
      res.error.includes("isn’t a duration") || res.error.includes("isn't a duration"),
      `grammar named for ${JSON.stringify(raw)}: ${res.error}`,
    );
  }
});

test("odd inputs are coerced through String() honestly — never thrown", () => {
  // {} / Symbol stringify to grammar-free text → same field-named refusal.
  for (const raw of [{}, Symbol("x"), true]) {
    assert.doesNotThrow(() => {
      const res = parseDuration(raw, NOW);
      assert.equal(res.ok, false, `${String(raw)} refuses`);
      assertRefusal(res);
    });
  }
  // String([]) === "" — the empty-string permanent belt covers coercion too.
  assert.deepEqual(parseDuration([], NOW), { ok: true, expiresAtMs: null });
});

// ── injectable clock + purity ───────────────────────────────────────────────

test("the expiry anchors on the INJECTED clock: same input, different nowMs → different expiry", () => {
  const other = NOW + 123_456_789;
  assert.deepEqual(parseDuration("24h", NOW), { ok: true, expiresAtMs: NOW + DAY });
  assert.deepEqual(parseDuration("24h", other), { ok: true, expiresAtMs: other + DAY });
});

test("re-parsing the same input at the same instant is pure (identical result, no state)", () => {
  const a = parseDuration("7d", NOW);
  const b = parseDuration("7d", NOW);
  assert.deepEqual(a, b);
  const r1 = parseDuration("59s", NOW);
  const r2 = parseDuration("59s", NOW);
  assert.deepEqual(r1, r2, "refusals are stable too");
});

test("wall-clock default exists only at the call boundary (no injected now → ~now + span)", () => {
  const before = Date.now();
  const res = parseDuration("24h");
  const after = Date.now();
  assert.equal(res.ok, true);
  assert.ok(
    res.expiresAtMs >= before + DAY && res.expiresAtMs <= after + DAY,
    "uninjected call is bounded by the pre/post wall-clock reads",
  );
});

test("every result is the locked discriminated shape (ok plus expiresAtMs XOR error)", () => {
  for (const raw of ["7d", "nope", "permanent", "1s", "9999d"]) {
    const res = parseDuration(raw, NOW);
    assert.equal(typeof res.ok, "boolean");
    if (res.ok) {
      assert.ok(
        res.expiresAtMs === null || (Number.isInteger(res.expiresAtMs) && res.expiresAtMs > 0),
        "ok results carry null or a positive ms expiry",
      );
      assert.equal(res.error, undefined);
    } else {
      assert.equal(typeof res.error, "string");
      assert.ok(res.error.length > 0, "refusals are reply-ready copy, never empty");
    }
  }
});
