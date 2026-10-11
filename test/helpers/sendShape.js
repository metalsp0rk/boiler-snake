const assert = require("node:assert/strict");

/**
 * Send-shape contract assertions for notification tickers (audit #199,
 * roadmap/audit-2026-10.md §6 P1 "docs at-risk surfaces").
 *
 * H11 hid behind green tests because the production ticker suppressed the
 * pings the operator docs advertise while /testnotification (plain reply, no
 * override) pinged fine. The H11 fix (#186, 316031c) pinned the per-ticker
 * contract inline in test/integration/youtube.test.js; these helpers extend
 * those assertions so EVERY notification ticker test drives the real
 * production send path (mocked transport at the channel.send boundary) and
 * pins both sides of the contract:
 *
 *   content mention token built   →  exact allowedMentions payload
 *   @everyone                     →  { parse: ["everyone"] }
 *   <@&roleId> (configured role)  →  { parse: ["roles"], roles: [roleId] }
 *   none                          →  { parse: [] }
 *
 * The assertions are two-sided on purpose: flipping parse back to [] fails
 * the exact-payload check, and suppressing/multiplying the content token the
 * payload allows fails the token check. A suppressed-ping regression can
 * never be green again, and "everything pings" can never be green either —
 * silent/system sends must keep { parse: [] } with no tokens.
 *
 * Note the token checks run on bot-built message content only. Discord pings
 * resolve from content, not embed bodies, so embeds (release notes etc.) are
 * intentionally out of scope here.
 */

const EVERYONE_TOKEN_RE = /@(everyone|here)\b/;
const ROLE_TOKEN_RE = /<@&[\w-]+>/g;
const USER_TOKEN_RE = /<@!?[\w-]+>/g;

/** Content as string; tickers may legitimately send `content: null`. */
function sendText(payload) {
  return typeof payload?.content === "string" ? payload.content : "";
}

function roleTokens(text) {
  return text.match(ROLE_TOKEN_RE) || [];
}

function userTokens(text) {
  return text.match(USER_TOKEN_RE) || [];
}

function describeSend(payload) {
  return (
    `content=${JSON.stringify(payload?.content ?? null)} ` +
    `allowedMentions=${JSON.stringify(payload?.allowedMentions)}`
  );
}

/** Assert a one-event trigger produced exactly one send; return its payload. */
function exactlyOneSend(sent, what = "notification") {
  assert.equal(
    sent.length,
    1,
    `expected exactly one ${what} send, got ${sent.length}: ` +
      JSON.stringify(sent.map((p) => p?.content ?? null))
  );
  return sent[0];
}

/**
 * @everyone contract (YouTube live alerts, docs/youtube-notifications.md
 * "Live Stream Alerts — Mention: @everyone in the message content (ticker)"):
 * content opens with @everyone and the payload allows exactly
 * { parse: ["everyone"] } — nothing else is mentioned.
 */
function assertPingsEveryone(payload, { label = "live alert" } = {}) {
  assert.ok(payload, `${label}: expected a send payload`);
  const text = sendText(payload);
  assert.ok(
    text.startsWith("@everyone"),
    `${label}: content must open with the @everyone ping (${describeSend(payload)})`
  );
  assert.deepEqual(
    payload.allowedMentions,
    { parse: ["everyone"] },
    `${label}: allowedMentions must be exactly { parse: ["everyone"] } (${describeSend(payload)})`
  );
  assert.deepEqual(
    roleTokens(text),
    [],
    `${label}: content must not mention roles (${describeSend(payload)})`
  );
  assert.deepEqual(
    userTokens(text),
    [],
    `${label}: content must not mention users (${describeSend(payload)})`
  );
}

/**
 * Role-only ping contract (YouTube upload role, Twitch go-live, GitHub
 * releases — "the message mentions that role only — never @everyone"):
 * content opens with the configured role token and the payload allows
 * exactly { parse: ["roles"], roles: [roleId] }.
 */
function assertPingsRoleOnly(payload, roleId, { label = "role alert" } = {}) {
  assert.ok(payload, `${label}: expected a send payload`);
  const text = sendText(payload);
  assert.ok(
    text.startsWith(`<@&${roleId}>`),
    `${label}: content must open with <@&${roleId}> (${describeSend(payload)})`
  );
  assert.deepEqual(
    payload.allowedMentions,
    { parse: ["roles"], roles: [roleId] },
    `${label}: allowedMentions must be exactly { parse: ["roles"], roles: ["${roleId}"] } (${describeSend(payload)})`
  );
  assert.ok(
    !EVERYONE_TOKEN_RE.test(text),
    `${label}: content must never ping @everyone/@here (${describeSend(payload)})`
  );
  assert.deepEqual(
    roleTokens(text),
    [`<@&${roleId}>`],
    `${label}: content must mention the configured role and nothing else (${describeSend(payload)})`
  );
  assert.deepEqual(
    userTokens(text),
    [],
    `${label}: content must not mention users (${describeSend(payload)})`
  );
}

/**
 * Silent-send contract (Twitch clip/VOD alerts "never ping the role"; any
 * ticker send that builds no mention token): content carries NO mention
 * tokens and the payload allows exactly { parse: [] }.
 */
function assertPingsNobody(payload, { label = "silent send" } = {}) {
  assert.ok(payload, `${label}: expected a send payload`);
  const text = sendText(payload);
  assert.ok(
    !EVERYONE_TOKEN_RE.test(text),
    `${label}: content must not ping @everyone/@here (${describeSend(payload)})`
  );
  assert.deepEqual(
    roleTokens(text),
    [],
    `${label}: content must not mention roles (${describeSend(payload)})`
  );
  assert.deepEqual(
    userTokens(text),
    [],
    `${label}: content must not mention users (${describeSend(payload)})`
  );
  assert.deepEqual(
    payload.allowedMentions,
    { parse: [] },
    `${label}: allowedMentions must be exactly { parse: [] } (${describeSend(payload)})`
  );
}

module.exports = {
  exactlyOneSend,
  assertPingsEveryone,
  assertPingsRoleOnly,
  assertPingsNobody,
};
