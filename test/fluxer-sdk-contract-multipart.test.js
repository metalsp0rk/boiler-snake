/**
 * Issue #381 (audit G2-2): the multipart seam must be asserted against the
 * REAL serialization module — never a fake. FLX-1 (#373: every Fluxer file
 * send without the presigned flag shipped `"{}"`) hid behind three mock
 * layers that skipped serialization entirely; the suite's own reflexive
 * `body instanceof FormData` (global) assertion verified nothing about the
 * only class check that decides what is on the wire: the SDK's own
 * `options.body instanceof <bundled-undici>.FormData`.
 *
 * The REST module is loaded ONLY through client.js's single guarded load
 * site (loadFluxerRest) — the package name never appears in this file
 * (enforced by fluxer-sdk-import-guard.test.js) — and resolves to null when
 * the package is not installed, so these tests SKIP and `npm test` stays
 * green (roadmap/fluxer.md § Tests).
 *
 * buildBody/buildHeaders below are transcribed VERBATIM from the pinned
 * REST dist (3.3.0, dist/index.js lines 469-477 and 495-497 — ranges
 * re-verified on the 3.1.0→3.3.0 bump, both still exact) — cited to their
 * lines, not paraphrased. SdkFormData is the SDK's own form class,
 * recovered from buildFormData's output (the class is not exported):
 * exactly what buildBody's instanceof gates against.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
// client.js pulls in src/bot/pipelines (→ features → db), so it needs it.
const { cleanup } = loadDb();

const { loadFluxerRest } = require("../src/platform/fluxer/client");
const { createFluxerOutbound } = require("../src/platform/fluxer/outbound");

after(cleanup);

// Guarded load (null when the package is absent → tests skip).
const restPromise = loadFluxerRest("unit-test/sdk-contract-multipart");

async function sdkOrSkip(t) {
  const restMod = await restPromise;
  if (!restMod) return t.skip("REST module not installed — guarded loader resolved to null");
  // Drift guard FIRST (never skip silently on a renamed export): these are
  // the two SDK surfaces this file pins.
  assert.equal(typeof restMod.buildFormData, "function", "REST module must export buildFormData");
  // The SDK's own multipart class — what buildBody's instanceof gates
  // against (dist line 475). buildFormData returns a fresh instance of it.
  const SdkFormData = restMod.buildFormData({}, []).constructor;
  assert.equal(typeof SdkFormData, "function");
  // Sanity that this seam is really about a DIFFERENT class than the Node
  // global (the FLX-1 mechanism): if an undici/Node merge ever unifies them
  // this assertion fails and the suite re-reads the SDK, loudly.
  assert.equal(
    new globalThis.FormData() instanceof SdkFormData,
    false,
    "the global FormData must remain NOT-an-instance-of the SDK form class (FLX-1 gate)",
  );
  return { restMod, SdkFormData };
}

/**
 * dist/index.js:469-477 verbatim (import_undici3.FormData ≡ SdkFormData):
 *   buildBody(options) {
 *     if (options.files?.length) {
 *       const payload = options.body !== void 0 && typeof options.body ===
 *         "object" && options.body !== null &&
 *         !(options.body instanceof import_undici3.FormData)
 *           ? options.body : {};
 *       return buildFormData(payload, options.files);
 *     }
 *     if (options.body === void 0) return void 0;
 *     if (options.body instanceof import_undici3.FormData) return options.body;
 *     return JSON.stringify(options.body);   // ← the FLX-1 shredder
 *   }
 */
function sdkBuildBody(restMod, SdkFormData, options) {
  if (options.files?.length) {
    const payload =
      options.body !== void 0 &&
      typeof options.body === "object" &&
      options.body !== null &&
      !(options.body instanceof SdkFormData)
        ? options.body
        : {};
    return restMod.buildFormData(payload, options.files);
  }
  if (options.body === void 0) return void 0;
  if (options.body instanceof SdkFormData) return options.body;
  return JSON.stringify(options.body);
}

/**
 * dist/index.js:495-497 verbatim: Content-Type: application/json is stamped
 * for every defined body that is NOT an SDK form.
 */
function sdkStampsJson(SdkFormData, body) {
  return body !== void 0 && !(body instanceof SdkFormData);
}

describe("fluxer REST SDK — multipart contract (real module, no fake serialization)", () => {
  it("bug pin: a hand-built GLOBAL FormData fails the SDK gate and stringifies to \"{}\" (FLX-1 mechanism)", async (t) => {
    const ctx = await sdkOrSkip(t);
    if (!ctx) return;
    const { SdkFormData } = ctx;

    // The exact old-code shape (#373): hand-built form pushed as options.body.
    const handBuilt = new globalThis.FormData();
    handBuilt.append("payload_json", JSON.stringify({ content: "see attached" }));
    handBuilt.append("files[0]", new globalThis.Blob([Buffer.from("PNGBYTES")]), "board.png");

    assert.equal(handBuilt instanceof SdkFormData, false, "the SDK gate rejects the global class");

    // ...so buildBody takes the JSON.stringify branch, and a FormData
    // stringifies to "{}": content and every file are shredded. The header
    // rule then stamps application/json on top of the empty object.
    const wire = sdkBuildBody(await restPromise, SdkFormData, { body: handBuilt });
    assert.equal(wire, "{}", "the hand-built form is shredded to the empty JSON object");
    assert.equal(sdkStampsJson(SdkFormData, wire), true, "and Content-Type: application/json is stamped");
  });

  it("contract pin: an outbound file send survives the REAL buildBody as multipart with bound file parts", async (t) => {
    const ctx = await sdkOrSkip(t);
    if (!ctx) return;
    const { restMod, SdkFormData } = ctx;

    // The fake transport performs NO bespoke serialization: it runs the
    // dist-transcribed buildBody. Whatever outbound builds must survive the
    // SDK's own class gate — this is the check #373 removed from the product
    // path and this test now keeps pinned at the seam.
    const calls = [];
    const rest = {
      async request(method, path, options = {}) {
        const body = sdkBuildBody(restMod, SdkFormData, options);
        calls.push({ method, path, body, contentTypeJson: sdkStampsJson(SdkFormData, body) });
        if (method === "POST" && path === "/v1/channels/444/messages") return { id: "m-1" };
        throw new Error(`404 FAKE_NO_ROUTE: ${method} ${path}`);
      },
    };
    const handle = {
      instanceKey: "https://fluxer.test",
      userId: "bot-1",
      rest,
      apiOrigin: null,
      fetchGuild: async () => null,
      ready: true,
      destroy() {},
    };
    const outbound = createFluxerOutbound(handle);

    const res = await outbound.sendChannel("444", {
      content: "see attached",
      files: [{ name: "board.png", data: Buffer.from("PNGBYTES") }],
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(calls.length, 1);

    const body = calls[0].body;
    // THE assertion the old suite could not make: what the SDK serializes is
    // its OWN form class — the server receives multipart, not "{}".
    assert.ok(body instanceof SdkFormData, "the wire body is the SDK's own multipart form");
    assert.ok(!(body instanceof globalThis.FormData), "not the global class the SDK discards");
    assert.equal(calls[0].contentTypeJson, false, "no JSON content-type over multipart (dist 495-497)");

    const payload = JSON.parse(body.get("payload_json"));
    assert.equal(payload.content, "see attached", "payload_json carries the message payload");
    assert.deepEqual(
      payload.attachments,
      [{ id: 0, filename: "board.png" }],
      "the SDK appends the numeric attachments claims that bind files[i] parts",
    );

    const filePart = body.getAll("files[0]");
    assert.equal(filePart.length, 1, "exactly one files[0] part");
    assert.equal(await filePart[0].text(), "PNGBYTES", "the bytes survive on the file part");
    assert.equal(filePart[0].name ?? body.get("files[0]").name, "board.png", "the filename claim rides the part");
  });

  it("JSON sends (no files) stay on the stringify branch — multipart never leaks", async (t) => {
    const ctx = await sdkOrSkip(t);
    if (!ctx) return;
    const { restMod, SdkFormData } = ctx;

    const wire = sdkBuildBody(restMod, SdkFormData, { body: { content: "plain" } });
    assert.equal(typeof wire, "string", "a files-less send is a JSON string body");
    assert.deepEqual(JSON.parse(wire), { content: "plain" });
    assert.equal(sdkStampsJson(SdkFormData, wire), true, "JSON sends keep application/json");
  });
});
