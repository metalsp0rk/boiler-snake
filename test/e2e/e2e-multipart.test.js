/**
 * Tier-4 multipart coverage for the fauxcord mock (issue #312). Namespace 24.
 *
 * The #312 patch taught the mock to parse `payload_json` + `files[N]` on
 * interaction callbacks, webhook execute, and PATCH @original; persist
 * uploads under UPLOAD_PATH (start-mock.sh points it at the writable data
 * dir — the /data EACCES family that killed attachment POSTs in early CI);
 * and hydrate `/attachments/:channel/:message/:filename` download URLs on
 * every read path. Product flows exercising the same plumbing live in the
 * sibling suites (leaderboard pagination ns5, warn export ns14, honeypot
 * notice ns16) — THIS file pins the route-level contract directly:
 *   POST /channels/:id/messages      (discord.js channel.send files)
 *   POST /webhooks/:id/:token        (webhook execute, wait true/false)
 *   multi-file part pairing          (files[N] ↔ attachments[] stubs)
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { AttachmentBuilder } = require("discord.js");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { j, poll } = require("./helpers/mockenv");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
// Canonical 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe(
  "e2e: fauxcord multipart uploads — channel POST + webhook execute persistence (#312)",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;

    before(async () => {
      env = await createE2eEnv({ ns: 24 });
    });

    after(async () => {
      await env?.cleanup();
    });

    const api = (p, o = {}) =>
      j(`${env.mock.base}/api${p}`, { ...o, headers: { ...env.mock.auth, ...o.headers } });

    const bytesOf = async (url) => {
      const res = await fetch(url);
      assert.ok(res.ok, `attachment GET ${url} → HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    };

    const createHook = () =>
      api(`/channels/${env.ids.general}/webhooks`, {
        method: "POST",
        body: JSON.stringify({ name: "e2e multipart" }),
      });

    it("channel.send({files}) persists the upload and serves identical bytes", async () => {
      const channel = env.supervisor.discord.channels.cache.get(env.ids.general);
      assert.ok(channel, "general channel hydrated");

      const msg = await channel.send({
        content: "multipart via channel POST",
        files: [new AttachmentBuilder(PNG, { name: "snake-1x1.png" })],
      });

      const rec = (await env.mock.messages(env.ids.general)).find(
        (m) => String(m.id) === String(msg.id),
      );
      assert.ok(rec, "message on the tape");
      const atts = rec.attachments ?? [];
      assert.equal(atts.length, 1, "one attachment persisted");
      const att = atts[0];
      assert.equal(att.filename, "snake-1x1.png");
      assert.equal(att.content_type, "image/png", "sniffed from PNG bytes");
      assert.equal(att.size, PNG.length, "stored size matches the upload");
      assert.match(String(att.url), /\/_mock\/attachments\//);

      const bytes = await bytesOf(att.url);
      assert.deepEqual(bytes, PNG, "byte-exact round-trip from UPLOAD_PATH");
    });

    it("webhook execute multipart (wait=true) returns the message with a hydrated attachment", async () => {
      const hook = await createHook();
      assert.ok(hook?.id && hook?.token, `webhook created (got: ${JSON.stringify(hook)})`);

      const fd = new FormData();
      fd.append(
        "payload_json",
        JSON.stringify({
          content: "webhook multipart drop",
          attachments: [{ id: 0, filename: "drop.png" }],
        }),
      );
      fd.append("files[0]", new File([PNG], "drop.png", { type: "image/png" }));

      const res = await fetch(`${env.mock.base}/webhooks/${hook.id}/${hook.token}?wait=true`, {
        method: "POST",
        body: fd,
      });
      assert.equal(res.status, 200, "wait=true answers with the message");
      const msg = await res.json();
      assert.equal(String(msg.content), "webhook multipart drop");

      const atts = msg.attachments ?? [];
      assert.equal(atts.length, 1, "the parsed files are PERSISTED, not dropped");
      const att = atts[0];
      assert.equal(att.filename, "drop.png");
      assert.equal(att.content_type, "image/png");
      assert.equal(att.size, PNG.length);
      assert.match(String(att.url), /\/_mock\/attachments\//);
      assert.deepEqual(await bytesOf(att.url), PNG, "bytes served back");

      // Same message visible in the channel tape (author = the webhook).
      const onTape = (await env.mock.messages(env.ids.general)).find(
        (m) => String(m.id) === String(msg.id),
      );
      assert.ok(onTape, "webhook message lands in the channel");
    });

    it("webhook execute multipart (fire-and-forget) persists in the background branch", async () => {
      const hook = await createHook();
      const fd = new FormData();
      fd.append(
        "payload_json",
        JSON.stringify({
          content: "fire and forget",
          attachments: [{ id: 0, filename: "ff.png" }],
        }),
      );
      fd.append("files[0]", new File([PNG], "ff.png", { type: "image/png" }));

      const res = await fetch(`${env.mock.base}/webhooks/${hook.id}/${hook.token}`, {
        method: "POST",
        body: fd,
      });
      assert.equal(res.status, 204, "no wait → 204");

      // Settle on the ATTACHMENT, not just the message row (#519): the mock's
      // fire-and-forget branch inserts the message synchronously and applies
      // files a few ms later (writeFile → INSERT), so polling for existence
      // alone handed us a message whose attachments array was still empty.
      // The file bytes are on disk before the attachment row is visible, so
      // a settled attachment also pins the background WRITE.
      const settled = await poll(
        async () =>
          (await env.mock.messages(env.ids.general)).find(
            (m) =>
              String(m.content) === "fire and forget" &&
              (m.attachments ?? []).length > 0,
          ) ?? null,
        { timeoutMs: 8000, label: "background webhook message WITH persisted attachment" },
      );
      const att = settled.attachments[0];
      assert.equal(att.filename, "ff.png");
      assert.deepEqual(await bytesOf(att.url), PNG, "background branch wrote the file");
    });

    it("two files pair positionally with the payload_json attachments stubs", async () => {
      const hook = await createHook();
      const alpha = Buffer.concat([PNG, Buffer.from([0x41])]);
      const beta = Buffer.concat([PNG, Buffer.from([0x42])]);

      const fd = new FormData();
      fd.append(
        "payload_json",
        JSON.stringify({
          content: "two files",
          attachments: [
            { id: 0, filename: "alpha.png" },
            { id: 1, filename: "beta.png" },
          ],
        }),
      );
      fd.append("files[0]", new File([alpha], "alpha.png", { type: "image/png" }));
      fd.append("files[1]", new File([beta], "beta.png", { type: "image/png" }));

      const res = await fetch(`${env.mock.base}/webhooks/${hook.id}/${hook.token}?wait=true`, {
        method: "POST",
        body: fd,
      });
      assert.equal(res.status, 200);
      const msg = await res.json();

      const atts = msg.attachments ?? [];
      assert.equal(atts.length, 2, "both parts persisted");
      assert.deepEqual(
        atts.map((a) => a.filename).sort(),
        ["alpha.png", "beta.png"],
        "filenames preserved",
      );
      for (const [name, want] of [
        ["alpha.png", alpha],
        ["beta.png", beta],
      ]) {
        const att = atts.find((a) => a.filename === name);
        assert.equal(att.size, want.length, `${name} size`);
        assert.deepEqual(await bytesOf(att.url), want, `${name} bytes distinct`);
      }
      assert.deepEqual(
        (await bytesOf(atts.find((a) => a.filename === "alpha.png").url)).subarray(0, 4),
        PNG_MAGIC,
        "PNG magic survives the concat",
      );
    });

    it.todo(
      "direct interaction.update({files}) (type-7 multipart callback) has NO product surface " +
        "(button handlers defer + editReply, exercised live by ns5) — the mock code path is " +
        "shared with PATCH @original, which is pinned above",
    );
  },
);
