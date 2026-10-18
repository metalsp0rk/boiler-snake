/**
 * SDK availability tripwire (#448, audit G2-1).
 *
 * The whole #200 SDK-contract corpus (18 arms across
 * fluxer-sdk-contract-normalize / fluxer-sdk-pipeline /
 * fluxer-normalize-sdk-member) gates on `loadFluxerSdk(...)` resolving null
 * and responds with `t.skip(...)` — a shape invisible to CI: if the core SDK
 * package ever left `dependencies` (dep reshuffle, "move it to dev-only",
 * broken install) or the ESM interop broke at load time, the repo's single
 * highest-leverage fidelity defense would evaporate into green skips while
 * `npm test` and the coverage gate stayed satisfied — the exact C1/C2
 * epistemic state the corpus exists to prevent.
 *
 * These pins make that state LOUD. The package name is read from the client
 * factory's own constant (the single load site fluxer-sdk-import-guard
 * enforces — this file must not carry the literal), so a rename there
 * re-targets this guard automatically.
 */
const { it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { cleanup } = loadDb();

const {
  loadFluxerSdk,
  SDK_PACKAGE_NAME,
} = require("../src/platform/fluxer/client");
const pkg = require("../package.json");

after(() => cleanup?.());

it("the SDK package is pinned in PRODUCTION dependencies (#448)", () => {
  assert.ok(
    typeof SDK_PACKAGE_NAME === "string" && SDK_PACKAGE_NAME.length > 0,
    "the client factory must keep exporting the guarded package name",
  );
  const inDeps = (pkg.dependencies || {})[SDK_PACKAGE_NAME];
  assert.ok(
    inDeps,
    `${SDK_PACKAGE_NAME} must stay in \`dependencies\`, not devDependencies: ` +
      "the SDK-contract arms (18 across three files) gate on loadFluxerSdk " +
      "and green-SKIP when it resolves null — a dev-only reshuffle silently " +
      "disarms the entire corpus on any install without dev deps",
  );
  assert.equal(
    (pkg.devDependencies || {})[SDK_PACKAGE_NAME],
    undefined,
    "declared in BOTH dependency maps — production wins at install, but the " +
      "duplicate signals a reshuffle that forgot the corpus",
  );
});

it("the guarded SDK loader RESOLVES the package — the corpus runs, never silently skips (#448)", async () => {
  const sdk = await loadFluxerSdk("tripwire/448");
  assert.ok(
    sdk,
    "loadFluxerSdk resolved null: every SDK-contract arm in " +
      "fluxer-sdk-contract-normalize / fluxer-sdk-pipeline / " +
      "fluxer-normalize-sdk-member is green-SKIPPING right now (audit G2-1). " +
      "Fix the install/load (see the [fluxer] SDK load failed line above) — " +
      "do not mark this test skip/todo",
  );
  assert.equal(typeof sdk, "object");
  // The arms consume the named exports the SDK surface promises — a module
  // that resolves but lost its shapes is the same blindness in disguise.
  assert.ok(
    Object.keys(sdk).length > 0,
    "SDK module namespace resolved EMPTY — arms would run against nothing",
  );
});
