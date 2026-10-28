#!/usr/bin/env node
"use strict";

/**
 * Visual regression for the Forged Instrument shell and dashboard (#711).
 *
 * Screenshots real renderLayout / renderDashboardContent HTML (staff nav,
 * one sample guild) at 3 desktop and 2 phone widths. A diff fails the
 * process. VISUAL_UPDATE=1 rewrites test/visual/baselines.
 *
 * The server is the console's real CSP middleware plus the real static
 * middleware, and it stubs the two same-origin chart JSON routes so
 * Chart.js paints. A passing run is the CSP evidence: Shoelace renders
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
const { readBuildManifest, forgePublicPaths } = require("../../src/web/assets/stamp");
const { renderLayout } = require("../../src/web/views/layout");
const { renderDashboardContent } = require("../../src/web/views/dashboard/dashboardPage");
const { html } = require("../../src/web/views/escape");

const REPO_ROOT = path.join(__dirname, "..", "..");
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

const VISUAL_GUILDS = [
  { id: "900", communityId: "100", name: "Forge Guild" },
  { id: "901", communityId: "101", name: "Second Guild" },
];

const DASHBOARD_SAMPLE = {
  tickets: {
    available: true,
    openCount: 3,
    openCountSaturated: false,
    newest: [
      {
        ticketNumber: 12,
        reason: "Refund question",
        creatorUserId: "1001",
        createdAt: "2026-10-20T15:04:00.000Z",
      },
      {
        ticketNumber: 11,
        reason: "Role request",
        creatorUserId: "1002",
        createdAt: "2026-10-19T11:00:00.000Z",
      },
    ],
  },
  activity: {
    messageTracking: {
      trackedMessages: 12840,
      dayRows: 30,
      ignoreCount: 2,
      backfillStatus: "idle",
      backfillActive: false,
    },
    xpLeaders: [
      { userId: "1001", xp: 4200 },
      { userId: "1002", xp: 3100 },
    ],
  },
  tickers: [
    {
      name: "voice",
      status: "ok",
      lastTickAt: "2026-10-27T12:00:00.000Z",
      ageMs: 5000,
      detail: "",
    },
    {
      name: "decay",
      status: "stale",
      lastTickAt: "2026-10-26T12:00:00.000Z",
      ageMs: 86400000,
      detail: "overdue",
    },
  ],
  nowPlaying: {
    status: "playing",
    paused: false,
    title: "Night Drive",
    author: "Ada",
    positionMs: 83000,
    upcoming: 2,
  },
  freshness: {
    generatedAt: "2026-10-27T12:00:30.000Z",
    fromCache: true,
    ageMs: 12000,
  },
};

const ACTIVITY_JSON = {
  points: [
    { day: "2026-10-01", messages: 12 },
    { day: "2026-10-08", messages: 40 },
    { day: "2026-10-15", messages: 18 },
    { day: "2026-10-22", messages: 27 },
  ],
};

const LEADERS_JSON = {
  leaders: [
    { userId: "1001", name: "Ada", xp: 4200 },
    { userId: "1002", name: "Bea", xp: 3100 },
    { userId: "1003", name: "Cam", xp: 900 },
  ],
};

function pageDocument(name, nonce) {
  const shared = {
    guilds: VISUAL_GUILDS,
    currentGuildId: "100",
    tier: "staff",
    user: { userId: "42", discordTag: "ada" },
    csrfToken: "csrf-visual",
    nonce,
  };
  if (name === "dashboard") {
    return renderLayout({
      ...shared,
      title: "Dashboard",
      heading: "Dashboard",
      lede: "Guild health at a glance.",
      path: "/g/100",
      content: renderDashboardContent(DASHBOARD_SAMPLE, { guildId: "100" }),
    });
  }
  return renderLayout({
    ...shared,
    title: "Settings",
    heading: "Settings",
    lede: "Guild settings for this community.",
    path: "/g/100/settings",
    content: html`<p class="subheading">Command channels, XP, and decay live on this page.</p>`,
  });
}

function startServer() {
  const csp = createCspMiddleware();
  const staticMw = createStaticMiddleware();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const fixture = url.pathname.match(/^\/fixture\/(shell|dashboard)$/);
    if (fixture) {
      csp(req, res, () => {
        const document = pageDocument(fixture[1], res.locals.cspNonce || "");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(String(document));
      });
      return;
    }
    if (url.pathname === "/g/100/api/dashboard/activity.json") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(ACTIVITY_JSON));
      return;
    }
    if (url.pathname === "/g/100/api/dashboard/xp-leaders.json") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(LEADERS_JSON));
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
  if (name === "dashboard") {
    await page.waitForFunction(() => {
      const boxes = [...document.querySelectorAll("[data-chart-src]")];
      if (boxes.length < 2) return false;
      return boxes.every((box) => {
        const canvas = box.querySelector("canvas");
        return Boolean(canvas && window.Chart && window.Chart.getChart(canvas));
      });
    });
  }
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
      hasLookup: Boolean(lookup),
      hasIcon: Boolean(icon),
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

  const { server, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--font-render-hinting=none",
      "--disable-font-subpixel-positioning",
      "--force-color-profile=srgb",
      "--hide-scrollbars",
      "--disable-dev-shm-usage",
      // The self-hosted runner is a container; Chrome's user-namespace
      // sandbox is blocked there. Local runs keep the sandbox.
      ...(process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : []),
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
          if (shot.proof.hasLookup && shot.proof.lookupRole !== "combobox") {
            failures.push(`${file}: lookup input role is ${shot.proof.lookupRole}`);
          }
          if (shot.proof.hasIcon && !shot.proof.iconReady) {
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
