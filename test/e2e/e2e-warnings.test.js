const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { createE2eEnv } = require("./helpers/e2eEnv");

const MSG_DENIED = "You don't have permission to use this.";

/**
 * Tier-4 E2E warnings: exercises the SUB-COMMAND option nesting shape
 * (type-1 sub-commands with a nested USER option → the mock's resolved
 * builder) plus staff gates on a real multi-step feature. Namespace 4.
 */
describe("e2e: /warn staff flows", { concurrency: 1 }, () => {
  /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
  let env;

  before(async () => {
    env = await createE2eEnv({ ns: 4 });
    const role = await env.mock.createRole("E2E Staff");
    await env.mock.grantRole(env.ids.human, role.id);
    env.dbmod.addStaffRole(env.communityId, String(role.id), "senior");
  });

  after(async () => {
    await env?.cleanup();
  });

  const warnOption = (name, type, value) => ({ name, type, value });
  const sub = (name, options) => [{ name, type: 1, options }];

  it("/warn add (staff) records a warning via nested USER option resolution", async () => {
    const inter = await env.mock.slash({
      command: "warn",
      options: sub("add", [
        warnOption("user", 6, env.ids.target),
        warnOption("reason", 3, "E2E verification warning"),
      ]),
    });
    const reply = await env.mock.awaitReply(inter);
    assert.notEqual(String(reply.content), MSG_DENIED, "staff may warn");
    assert.doesNotMatch(String(reply.content), /unknown|missing|invalid user/i,
      `warn add replied: "${reply.content}"`);

    assert.equal(
      env.dbmod.countWarnings(env.communityId, env.ids.target),
      1,
      "warning persisted for the target",
    );
  });

  it("/warn list (staff) is not denied", async () => {
    const inter = await env.mock.slash({
      command: "warn",
      options: sub("list", [warnOption("user", 6, env.ids.target)]),
    });
    const reply = await env.mock.awaitReply(inter);
    assert.notEqual(String(reply.content), MSG_DENIED);
  });

  it("/warn mine is public self-service (non-staff allowed)", async () => {
    const inter = await env.mock.slash({
      command: "warn",
      options: sub("mine", []),
      userId: env.ids.outsider,
    });
    const reply = await env.mock.awaitReply(inter);
    assert.notEqual(String(reply.content), MSG_DENIED);
  });

  it("/warn list from non-staff is denied", async () => {
    const inter = await env.mock.slash({
      command: "warn",
      options: sub("list", [warnOption("user", 6, env.ids.target)]),
      userId: env.ids.outsider,
    });
    const reply = await env.mock.awaitReply(inter);
    assert.equal(String(reply.content), MSG_DENIED);
  });

  it("/warn add from non-staff is denied and records nothing", async () => {
    const inter = await env.mock.slash({
      command: "warn",
      options: sub("add", [
        warnOption("user", 6, env.ids.outsider),
        warnOption("reason", 3, "should never exist"),
      ]),
      userId: env.ids.outsider,
    });
    const reply = await env.mock.awaitReply(inter);
    assert.equal(String(reply.content), MSG_DENIED);
    assert.equal(env.dbmod.countWarnings(env.communityId, env.ids.outsider), 0);
  });
});
