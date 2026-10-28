"use strict";

/**
 * Forged Instrument foundation (#710): stamp fail-closed, /static/forge
 * serving, and the lookup/avatar contracts the bundle ports.
 * The Vite build is produced by `npm run assets:build` (npm test runs it).
 */

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createStaticMiddleware } = require("../src/web/middleware/static");
const {
  hashInputs,
  readStamp,
  assertForgeAssets,
  forgePublicPaths,
  listOutputs,
  resolveOutput,
  readBuildManifest,
  DIST_DIR,
} = require("../src/web/assets/stamp");


function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "forge-"));
}

function invoke(mw, url, method = "GET") {
  const req = { url, method };
  const out = { status: 0, headers: null, body: undefined };
  const res = {
    writeHead(code, headers) {
      out.status = code;
      out.headers = headers;
    },
    end(buf) {
      out.body = buf;
    },
  };
  mw(req, res);
  return out;
}

test("hashInputs is stable and changes with source bytes", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.css"), "body{}\n");
  const first = hashInputs(dir);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(hashInputs(dir), first);
  fs.writeFileSync(path.join(dir, "a.css"), "body{color:red}\n");
  assert.notEqual(hashInputs(dir), first);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("assertForgeAssets refuses a missing, stale, escaped, or incomplete stamp", () => {
  const missing = assert.throws(
    () => assertForgeAssets({ stampPath: path.join(tmpDir(), "nope.json") }),
    (err) => err.code === "FORGE_ASSETS_MISSING" && /half-styled/.test(err.message)
  );
  assert.equal(missing, undefined);

  const root = tmpDir();
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "app.js"), "console.log(1)\n");
  const stampPath = path.join(root, "stamp.json");
  fs.writeFileSync(
    stampPath,
    JSON.stringify({ inputsHash: "abc", outputs: ["app.js"] })
  );
  assert.equal(
    assertForgeAssets({ stampPath, distDir: dist, hashInputs: () => "abc" }).inputsHash,
    "abc"
  );
  assert.throws(
    () => assertForgeAssets({ stampPath, distDir: dist, hashInputs: () => "def" }),
    (err) => err.code === "FORGE_ASSETS_STALE" && /npm run assets:build/.test(err.message)
  );
  fs.writeFileSync(
    stampPath,
    JSON.stringify({ inputsHash: "abc", outputs: ["../package.json"] })
  );
  assert.throws(
    () => assertForgeAssets({ stampPath, distDir: dist, hashInputs: () => "abc" }),
    (err) => err.code === "FORGE_ASSETS_MISSING" && /outside/.test(err.message)
  );
  fs.writeFileSync(
    stampPath,
    JSON.stringify({ inputsHash: "abc", outputs: ["missing.js"] })
  );
  assert.throws(
    () => assertForgeAssets({ stampPath, distDir: dist, hashInputs: () => "abc" }),
    (err) => err.code === "FORGE_ASSETS_MISSING" && /incomplete/.test(err.message)
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("readStamp returns null when absent and throws on corrupt JSON", () => {
  assert.equal(readStamp(path.join(tmpDir(), "absent.json")), null);
  const file = path.join(tmpDir(), "bad.json");
  fs.writeFileSync(file, "{");
  assert.throws(() => readStamp(file), SyntaxError);
});

test("resolveOutput and forgePublicPaths reject bad shapes", () => {
  const dist = tmpDir();
  assert.equal(resolveOutput(dist, ""), null);
  assert.equal(resolveOutput(dist, "a/\0b"), null);
  assert.equal(resolveOutput(dist, "../secret"), null);
  const inside = resolveOutput(dist, "assets/app.js");
  assert.equal(inside, path.resolve(dist, "assets/app.js"));
  assert.throws(
    () => forgePublicPaths({}),
    /no entry chunk/
  );
  assert.deepEqual(
    forgePublicPaths({
      "src/web/assets/forge.js": { file: "assets/forge-abc.js", css: ["assets/forge-abc.css"], isEntry: true },
      "style.css": { file: "assets/style-def.css" },
    }),
    {
      js: "/static/forge/assets/forge-abc.js",
      css: ["/static/forge/assets/forge-abc.css", "/static/forge/assets/style-def.css"],
    }
  );
  fs.writeFileSync(path.join(dist, "one.js"), "");
  assert.deepEqual(listOutputs(dist), ["one.js"]);
  fs.rmSync(dist, { recursive: true, force: true });
});

test("the shipped build matches its stamp and carries the teal token", () => {
  const stamp = assertForgeAssets();
  assert.ok(stamp.outputs.includes(".vite/manifest.json"));
  const paths = forgePublicPaths(readBuildManifest());
  const cssRel = paths.css[0].replace(/^\/static\/forge\//, "");
  const css = fs.readFileSync(path.join(DIST_DIR, cssRel), "utf8");
  assert.match(css, /#29a8bd/i);
  assert.match(css, /Inter/);
  assert.match(css, /JetBrains Mono/);
  assert.equal(fs.existsSync(path.join(DIST_DIR, paths.js.replace(/^\/static\/forge\//, ""))), true);
});

test("/static/forge is the build root and legacy files stay in public/", () => {
  const root = tmpDir();
  const forge = tmpDir();
  fs.mkdirSync(path.join(forge, "assets"));
  fs.writeFileSync(path.join(root, "app.js"), "legacy");
  fs.writeFileSync(path.join(forge, "assets", "forge.js"), "forged");
  fs.writeFileSync(path.join(forge, "assets", "font.woff2"), "font");
  fs.writeFileSync(path.join(forge, ".secret"), "nope");
  const mw = createStaticMiddleware({ root, forgeRoot: forge });

  const hit = invoke(mw, "/assets/forge.js".replace("/assets/", "/forge/assets/"));
  assert.equal(hit.status, 200);
  assert.equal(String(hit.body), "forged");
  assert.match(hit.headers["Content-Type"], /javascript/);
  assert.match(hit.headers["Cache-Control"], /immutable/);
  assert.equal(hit.headers["X-Content-Type-Options"], "nosniff");

  const font = invoke(mw, "/forge/assets/font.woff2");
  assert.equal(font.status, 200);
  assert.match(font.headers["Content-Type"], /font\/woff2/);

  const head = invoke(mw, "/forge/assets/forge.js", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, undefined);

  const legacy = invoke(mw, "/app.js");
  assert.equal(String(legacy.body), "legacy");

  for (const url of ["/forge/missing.js", "/forge", "/forge/.secret", "/forge/../app.js", "/forge/%2e%2e/app.js"]) {
    const res = invoke(mw, url);
    assert.equal(res.status, 404, url);
    assert.equal(String(res.body), "Not found");
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(forge, { recursive: true, force: true });
});

test("lookup rank and avatar guard keep the console contract", async () => {
  const { lookupInputActive, lookupKind, pickedValue, rankItems } = await import(
    "../src/web/assets/lookup-rank.mjs"
  );
  const { isDiscordCdnAvatar } = await import("../src/web/assets/avatar-url.mjs");
  const items = [
    { name: "Grace Hopper", id: "2" },
    { name: "Ada", id: "1" },
    { name: "Adamant", id: "3" },
    { name: "Katherine", id: "4" },
  ];
  assert.deepEqual(
    rankItems(items, "ada").map((it) => it.id),
    ["1", "3"]
  );
  assert.deepEqual(rankItems([{ name: "King Dead" }, { name: "nope" }], "kd").map((it) => it.name), [
    "King Dead",
  ]);
  assert.deepEqual(rankItems([{ name: "zzz" }], "nope"), []);
  assert.equal(lookupKind("roles"), "roles");
  assert.equal(lookupKind("channels"), "channels");
  assert.equal(lookupKind("users"), "users");
  assert.equal(lookupKind(null), "users");
  assert.equal(pickedValue({ id: "9", name: "Mod", kind: "roles" }, "mixed"), "Mod");
  assert.equal(pickedValue({ id: "9", name: "Mod", kind: "roles" }, "roles"), "9");
  assert.equal(pickedValue({ id: "9" }, "channels"), "9");

  const attr = (map) => ({ getAttribute: (name) => map[name] || null });
  assert.equal(lookupInputActive(null), false);
  assert.equal(lookupInputActive(attr({})), false);
  assert.equal(lookupInputActive(attr({ "data-lookup": "mixed" })), false);
  assert.equal(
    lookupInputActive(attr({ "data-lookup": "mixed", "data-lookup-users": "/u" })),
    true
  );
  assert.equal(lookupInputActive(attr({ "data-lookup": "channels" })), false);
  assert.equal(
    lookupInputActive(attr({ "data-lookup": "channels", "data-lookup-url": "/c" })),
    true
  );

  assert.equal(isDiscordCdnAvatar("https://cdn.discordapp.com/avatars/1/a.png"), true);
  assert.equal(isDiscordCdnAvatar("https://evil.example/cdn.discordapp.com/a.png"), false);
  assert.equal(isDiscordCdnAvatar("http://cdn.discordapp.com/a.png"), false);
  assert.equal(isDiscordCdnAvatar(null), false);
});
