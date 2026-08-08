const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  assertEphemeralReply,
  assertReplyContains,
} = require("../helpers/assert");

describe("integration: /staff syncpermissions", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;

  before(async () => {
    env = await createIntegrationEnv();
  });

  it("denies non-admin", async () => {
    const interaction = await env.runCommand({
      commandName: "staff",
      subcommand: "syncpermissions",
      admin: false,
      user: env.users.memberUser,
    });
    assertEphemeralReply(interaction, /administrators|Manage Server/i);
  });

  it("explains missing OAuth config", async () => {
    const prevSecret = process.env.CLIENT_SECRET;
    const prevPort = process.env.TICKET_HTTP_PORT;
    const prevBase = process.env.TICKET_PUBLIC_BASE_URL;
    delete process.env.CLIENT_SECRET;
    delete process.env.TICKET_HTTP_PORT;
    delete process.env.TICKET_PUBLIC_BASE_URL;
    delete process.env.PUBLIC_HTTP_PORT;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.OAUTH_REDIRECT_URI;

    try {
      const interaction = await env.runCommand({
        commandName: "staff",
        subcommand: "syncpermissions",
        admin: true,
      });
      assertEphemeralReply(interaction);
      assertReplyContains(interaction, /not configured|CLIENT_SECRET|HTTP/i);
    } finally {
      if (prevSecret != null) process.env.CLIENT_SECRET = prevSecret;
      if (prevPort != null) process.env.TICKET_HTTP_PORT = prevPort;
      if (prevBase != null) process.env.TICKET_PUBLIC_BASE_URL = prevBase;
    }
  });
});
