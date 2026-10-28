#!/usr/bin/env node
"use strict";

/**
 * Visual regression for the Forged Instrument foundation (#710).
 *
 * Screenshots the shell and dashboard fixtures (the pages Phase 2 will
 * replace with live routes) at 3 desktop and 2 phone widths. A diff fails
 * the process. VISUAL_UPDATE=1 rewrites test/visual/baselines.
 *
 * The fixture server is the console's real CSP middleware plus the real
 * static middleware, so a passing run is the CSP evidence: Shoelace renders
 * in shadow DOM via adoptedStyleSheets under that exact policy.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch");
const puppeteer = require("puppeteer");
const { createCspMiddleware } = require("../../src/web/middleware/csp");
const { createStaticMiddleware } = require("../../src/web/middleware/static");
const {
  readBuildManifest,
  forgePublicPaths,
} = require("../../src/web/assets/stamp");

const REPO_ROOT = path.join(__dirname, "..", "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "src/web/assets/fixtures");
const BASELINE_DIR = path.join(REPO_ROOT, "test/visual/baselines");
const ACTUAL_DIR = path.join(REPO_ROOT, "test/visual/actual");
const DIFF_DIR = path.join(REPO_ROOT, "test/visual/diff");
const EVIDENCE_PATH = path.join(REPO_ROOT, "test/visual/csp-evidence.json");

const PAGES = ["shell", "dashboard"];
const WIDTHS = [
  { name: "desktop-1280", width: 1280, height: 800 },
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-1920", width: 1920, height: 1080 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "phone-430", width: 430, height: 932 },
];

function startServer(assetPaths) {
  const csp = createCspMiddleware();
  const staticMw = createStaticMiddleware();
  const css = assetPaths.css
    .map((href) => `<link rel="stylesheet" href="${href}" />`)
    .join("\n    ");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const fixture = url.pathname.match(/^\/fixture\/(shell|dashboard)$/);
    if (fixture) {
      csp(req, res, () => {
        const template = fs.readFileSync(path.join(FIXTURE_DIR, `${fixture[1]}.html`), "utf8");
        const html = template
          .replaceAll("{{CSS}}", css)
          .replaceAll("{{JS}}", assetPaths.js)
          .replaceAll("{{NONCE}}", res.locals.cspNonce);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
      });
      return;
    }
    if (url.pathname.startsWith("/static/")) {
      req.url = url.pathname.slice("/static".length) || "/";
      csp(req, res, () => staticMw(req, res));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function comparePng(actualPath, baselinePath, diffPath) {
  const actual = PNG.sync.read(fs.readFileSync(actualPath));
  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return {
      ok: false,
      reason: `size ${actual.width}x${actual.height} vs baseline ${baseline.width}x${baseline.height}`,
    };
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const mismatched = pixelmatch(actual.data, baseline.data, diff.data, actual.width, actual.height, {
    threshold: 0.1,
  });
  if (mismatched > 0) {
    fs.mkdirSync(path.dirname(diffPath), { recursive: true });
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    return { ok: false, reason: `${mismatched} pixels differ` };
  }
  return { ok: true, reason: "match" };
}

async function shoot(page, origin, name) {
  const response = await page.goto(`${origin}/fixture/${name}`, {
    waitUntil: "networkidle0",
  });
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  });
  await page.waitForFunction(() => customElements.get("sl-button"));
  const proof = await page.evaluate(() => {
    const button = document.querySelector("sl-button");
    const root = button && button.shadowRoot;
    const lookup = document.querySelector("[data-lookup]");
    const icon = document.querySelector("sl-icon");
    return {
      sheets: root && root.adoptedStyleSheets ? root.adoptedStyleSheets.length : 0,
      styleTags: root ? root.querySelectorAll("style").length : -1,
      buttonText: root ? (root.textContent || "").trim().slice(0, 40) : "",
      lookupRole: lookup ? lookup.getAttribute("role") : null,
      iconReady: Boolean(icon && icon.shadowRoot && icon.shadowRoot.querySelector("svg")),
    };
  });
  const header = response.headers()["content-security-policy"] || "";
  return { proof, csp: header };
}

async function main() {
  const update = process.env.VISUAL_UPDATE === "1";
  const paths = forgePublicPaths(readBuildManifest());
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  fs.mkdirSync(ACTUAL_DIR, { recursive: true });
  fs.mkdirSync(DIFF_DIR, { recursive: true });

  const { server, port } = await startServer(paths);
  const origin = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--font-render-hinting=none",
      "--disable-font-subpixel-positioning",
      "--force-color-profile=srgb",
      "--hide-scrollbars",
      "--disable-dev-shm-usage",
    ],
  });

  const failures = [];
  let evidence = null;
  try {
    const page = await browser.newPage();
    const violations = [];
    await page.exposeFunction("__forgeCsp", (entry) => violations.push(entry));
    await page.evaluateOnNewDocument(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        const report = {
          directive: event.violatedDirective,
          blocked: event.blockedURI,
          sample: event.sample,
        };
        if (typeof window.__forgeCsp === "function") window.__forgeCsp(report);
      });
    });
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: "dark" },
    ]);

    for (const name of PAGES) {
      for (const width of WIDTHS) {
        violations.length = 0;
        await page.setViewport({
          width: width.width,
          height: width.height,
          deviceScaleFactor: 1,
        });
        const shot = await shoot(page, origin, name);
        const file = `${name}-${width.name}.png`;
        const actualPath = path.join(ACTUAL_DIR, file);
        await page.screenshot({ path: actualPath, fullPage: true });

        if (!evidence && name === "shell") {
          evidence = {
            url: `${origin}/fixture/shell`,
            csp: shot.csp,
            proof: shot.proof,
            violations: violations.slice(),
            js: paths.js,
            css: paths.css,
          };
        }
        if (violations.length) {
          failures.push(`${file}: CSP violations ${JSON.stringify(violations)}`);
        }
        if (name === "shell" && width.name === "desktop-1280") {
          if (!shot.csp.includes("script-src 'self'") || !shot.csp.includes("style-src 'self' 'unsafe-inline'")) {
            failures.push(`${file}: CSP header is not the console policy (${shot.csp})`);
          }
          if (shot.csp.includes("unsafe-eval") || shot.csp.includes("unsafe-hashes")) {
            failures.push(`${file}: CSP loosened (${shot.csp})`);
          }
          if (shot.proof.sheets < 1 || shot.proof.styleTags !== 0) {
            failures.push(
              `${file}: expected adoptedStyleSheets and no shadow <style>, got ${JSON.stringify(shot.proof)}`
            );
          }
          if (shot.proof.lookupRole !== "combobox") {
            failures.push(`${file}: lookup input role is ${shot.proof.lookupRole}`);
          }
          if (!shot.proof.iconReady) {
            failures.push(`${file}: sl-icon did not render an SVG from the self-hosted set`);
          }
        }

        const baselinePath = path.join(BASELINE_DIR, file);
        if (update) {
          fs.copyFileSync(actualPath, baselinePath);
          console.log(`[visual] updated ${file}`);
          continue;
        }
        if (!fs.existsSync(baselinePath)) {
          failures.push(`${file}: no baseline (set VISUAL_UPDATE=1 to write one)`);
          continue;
        }
        const result = comparePng(actualPath, baselinePath, path.join(DIFF_DIR, file));
        if (!result.ok) failures.push(`${file}: ${result.reason}`);
        else console.log(`[visual] ${file} match`);
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  if (evidence) {
    fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`[visual] CSP evidence written to ${path.relative(REPO_ROOT, EVIDENCE_PATH)}`);
  }
  if (failures.length) {
    console.error("[visual] failed:");
    for (const line of failures) console.error(`  ${line}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[visual] forge regression failed:", err?.message || err);
  process.exit(1);
});
