/**
 * K2 leak tests for `/warn export` on Fluxer (PR 8; roadmap/fluxer.md § K2,
 * matrix line 687: the export FILE is a DM attachment).
 *
 * The pinned behavior (bundle + AGENTS.md rule 3):
 * - Sensitive → DM. The markdown Buffer goes out as a plain
 *   { name, data } files entry through the single send adapter (no
 *   AttachmentBuilder on the Fluxer arm).
 * - DM failure → the CHANNEL reply carries the SPECIFIC ERROR ONLY. It must
 *   never contain the export body, the filename, the subject's name, or any
 *   warning reason — the whole point of the file being DM-only.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { api: dbApi, cleanup } = loadDb();

const { buildFluxerCommandContext } = require("../src/platform/fluxer/context");
const { handleExport } = require("../src/features/warnings/handlers");
const { ensureCommunity } = require("../src/platform/community");
const { makeFakeRest, makeFakeHandle, FluxerRestError } = require("./helpers/fluxer");

after(cleanup);

const INSTANCE = "https://fluxer.test";
const GUILD = "1554590611015729152";
const CHANNEL = "555000111";
const TARGET = "100000000000000042";
const AUTHOR = "100000000000000099";
const SECRET_REASON = "SECRET_WARNING_REASON_5231";

const COMMUNITY_ID = ensureCommunity({
  platform: "fluxer",
  instanceKey: INSTANCE,
  externalGuildId: GUILD,
});

function seedWarning() {
  return dbApi.createWarning({
    communityId: COMMUNITY_ID,
    userId: TARGET,
    issuerId: AUTHOR,
    reason: SECRET_REASON,
  });
}

/** The `!warn export user <id>` context, built exactly like dispatch step 6. */
function exportContext(outbound) {
  const parsed = {
    commandName: "warn",
    subcommandGroup: null,
    subcommand: "export",
    options: [{ name: "user", type: "user", value: TARGET }],
    help: null,
    usageError: null,
  };
  const resolved = new Map([["user", { id: TARGET, username: "zed", bot: false }]]);
  const message = {
    platform: "fluxer",
    instanceKey: INSTANCE,
    communityId: COMMUNITY_ID,
    externalGuildId: GUILD,
    channelId: CHANNEL,
    authorId: AUTHOR,
    authorBot: false,
    authorRaw: { id: AUTHOR, username: "mod-1", bot: false },
    memberRoleIds: [],
  };
  return buildFluxerCommandContext(parsed, message, { outbound, resolved });
}

describe("fluxer /warn export — K2: the export file rides the DM, never the channel", () => {
  it("DM success: multipart POST to the DM channel with the markdown file", async () => {
    seedWarning();
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": { id: "dm-1", type: 1 },
        "POST /v1/channels/dm-1/messages": { id: "m-1" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const ctx = exportContext(outbound);

    // Spy on FormData.append so the multipart PART NAME and filename are
    // observable (the encoding itself happens in the transport). Arity is
    // preserved: WHATWG append(name, value, undefined) counts as a FILE part
    // (filename ES-converted to "undefined") and rejects string values — the
    // 2-arg payload_json call must not gain a phantom third argument.
    const realAppend = FormData.prototype.append;
    const parts = [];
    FormData.prototype.append = function (name, value, filename) {
      parts.push({ name, filename });
      return arguments.length > 2
        ? realAppend.apply(this, arguments)
        : realAppend.call(this, name, value);
    };
    try {
      await handleExport(ctx, undefined);
    } finally {
      FormData.prototype.append = realAppend;
    }

    assert.equal(ctx.replied, true);
    // 1. DM channel opened first (Phase 0: POST /v1/users/@me/channels) — to
    // the COMMAND AUTHOR (the staff member), never the subject.
    assert.equal(rest.calls[0].path, "/v1/users/@me/channels");
    assert.deepEqual(rest.calls[0].body, { recipient_id: AUTHOR });
    // 2. The export posts to the DM channel — not the guild channel.
    const dmPost = rest.calls.find((c) => c.path === "/v1/channels/dm-1/messages");
    assert.ok(dmPost, "the export is sent to the DM channel");
    assert.ok(!rest.calls.some((c) => c.path === `/v1/channels/${CHANNEL}/messages`), "nothing in the channel");

    // 3. Wire shape: Phase 0 multipart — payload_json + files[0].
    assert.ok(dmPost.body instanceof FormData, "files send as multipart (Phase 0 PASS shape)");
    assert.deepEqual(
      parts.map((p) => p.name),
      ["payload_json", "files[0]"],
      "payload_json part plus one file part",
    );
    assert.match(
      parts[1].filename,
      new RegExp(`^staff-record-${TARGET}-\\d{4}-\\d{2}-\\d{2}\\.md$`),
      "exportFilename names the file",
    );

    const payload = JSON.parse(dmPost.body.get("payload_json"));
    assert.match(payload.content, /Staff record for <@100000000000000042>/);
    assert.match(payload.content, /Ephemeral — staff handoff only/);

    // 4. The markdown Buffer carries the staff record, secret included.
    const blob = dmPost.body.get("files[0]");
    assert.ok(blob instanceof Blob, "file data travels as a Blob (Node 18+ global)");
    const text = await blob.text();
    assert.match(text, /# Staff record export/);
    assert.ok(text.includes(SECRET_REASON), "the warning reason is inside the DM'd file");
    assert.match(text, /zed/, "subject label from the resolved user");
  });

  it("DM send failure: channel reply is the SPECIFIC error — never the export body", async () => {
    seedWarning();
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": { id: "dm-2", type: 1 },
        "POST /v1/channels/dm-2/messages": async () => {
          const err = new Error("403 CANNOT_SEND_TO_USER: cannot message user");
          err.status = 403;
          err.code = "CANNOT_SEND_TO_USER";
          throw err;
        },
        [`POST /v1/channels/${CHANNEL}/messages`]: { id: "m-2" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const ctx = exportContext(outbound);

    const orig = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(" "));
    try {
      await handleExport(ctx, undefined);
    } finally {
      console.error = orig;
    }

    // The DM was attempted first.
    assert.equal(rest.calls[0].path, "/v1/users/@me/channels");
    // K2 fallback: a channel reply exists and carries the SPECIFIC error.
    const fallback = rest.calls.find((c) => c.path === `/v1/channels/${CHANNEL}/messages`);
    assert.ok(fallback, "the channel fallback fires when the DM fails");
    assert.ok(
      fallback.body.content.startsWith("I could not DM you the result:"),
      `the pinned K2 copy, got: ${fallback.body.content}`,
    );
    assert.match(fallback.body.content, /CANNOT_SEND_TO_USER/, "the specific API code is surfaced");
    assert.match(fallback.body.content, /403/, "the response status rides along (spec 630)");

    // THE LEAK TEST: no export content of any kind reaches the channel.
    const channelPayloads = JSON.stringify(
      rest.calls.filter((c) => c.path === `/v1/channels/${CHANNEL}/messages`),
    );
    for (const secret of [SECRET_REASON, "Staff record export", "staff-record-", "zed", "Exported by"]) {
      assert.ok(
        !channelPayloads.includes(String(secret)),
        `K2: the channel payload must not contain "${secret}"`,
      );
    }
    assert.ok(!(fallback.body instanceof FormData), "the fallback is a JSON text reply — no file parts");
    assert.equal(fallback.body.files, undefined, "no files ride the fallback");

    // The failure is logged with the cause (AGENTS.md rule 2).
    assert.equal(
      logged.some((l) => l.includes(`[fluxer] DM to ${AUTHOR} failed:`) && l.includes("CANNOT_SEND_TO_USER")),
      true,
    );
  });

  it("DM channel-create failure also falls back with the specific status + code (Phase 0: create is not recipient proof)", async () => {
    seedWarning();
    const rest = makeFakeRest({
      routes: {
        "POST /v1/users/@me/channels": async () => {
          throw new FluxerRestError("403 CANNOT_SEND_TO_USER: DM channel create refused", {
            status: 403,
            code: "CANNOT_SEND_TO_USER",
          });
        },
        [`POST /v1/channels/${CHANNEL}/messages`]: { id: "m-3" },
      },
    });
    const { outbound } = makeFakeHandle({ rest });
    const ctx = exportContext(outbound);

    const orig = console.error;
    console.error = () => {};
    try {
      await handleExport(ctx, undefined);
    } finally {
      console.error = orig;
    }

    const fallback = rest.calls.find((c) => c.path === `/v1/channels/${CHANNEL}/messages`);
    assert.ok(fallback, "the channel fallback fires");
    assert.match(fallback.body.content, /^I could not DM you the result: /);
    assert.match(fallback.body.content, /CANNOT_SEND_TO_USER/);
    const channelPayloads = JSON.stringify(
      rest.calls.filter((c) => c.path === `/v1/channels/${CHANNEL}/messages`),
    );
    assert.ok(!channelPayloads.includes(SECRET_REASON), "K2: no export body in the channel");
  });
});
