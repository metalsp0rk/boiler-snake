#!/usr/bin/env node
"use strict";

/**
 * Visual regression for the Forged Instrument console (#711 shell and
 * dashboard, #712 data surfaces, #713 transcript viewer and export,
 * #714 landing, sign-in, and the guild list).
 *
 * Screenshots real view HTML inside renderLayout at 3 desktop and 2 phone
 * widths. A diff fails the process. VISUAL_UPDATE=1 writes a baseline only
 * when it is missing or the pixels differ, so a matching shot stays
 * byte-for-byte.
 *
 * The server is the console's real CSP middleware plus the real static
 * middleware, and it stubs the two same-origin chart JSON routes so
 * Chart.js paints. A passing run is the CSP evidence: Shoelace renders
 * in shadow DOM via adoptedStyleSheets under that exact policy.
 *
 * Record baselines with VISUAL_UPDATE=1. Raw ids use self-hosted JetBrains
 * Mono. The left arrow, the right arrow, ≤, and ≥ are self-hosted Inter
 * glyphs. Sample timestamps that go through formatWhen sit in year 2100
 * so the relative clause stays "now" and the shots do not age.
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
// transcript.js opens SQLite when the viewer module loads. Point that at
// an empty directory so a screenshot run does not touch the bot database.
if (!process.env.DATA_DIR && !process.env.DB_PATH) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forge-visual-"));
}
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch");
const puppeteer = require("puppeteer");
const { createCspMiddleware, contentSecurityPolicy } = require("../../src/web/middleware/csp");
const { createStaticMiddleware } = require("../../src/web/middleware/static");
const { readBuildManifest, forgePublicPaths } = require("../../src/web/assets/stamp");
const { renderLayout } = require("../../src/web/views/layout");
const { renderDashboardContent } = require("../../src/web/views/dashboard/dashboardPage");
const { renderUserSearchPage } = require("../../src/web/views/users");
const { renderTicketIndexContent } = require("../../src/web/views/tickets/indexPage");
const { renderTicketActionsBody } = require("../../src/web/views/ticketActions");
const { renderWarningsBody, renderNotesBody } = require("../../src/web/views/moderation");
const { renderStaffBody } = require("../../src/web/views/staff");
const { renderSettingsBody } = require("../../src/web/views/settings");
const { renderYourSessionsBody, renderSystemSessionsBody } = require("../../src/web/views/sessions");
const { renderSystemBody, renderAuditBody } = require("../../src/web/views/system");
const { renderVoiceBody } = require("../../src/web/views/voice");
const { renderEventsMonth } = require("../../src/web/views/events");
const { renderTranscriptPage } = require("../../src/web/views/transcripts/transcriptPage");
const { renderTranscriptHtml } = require("../../src/features/tickets/transcript");
const { renderSignInPage } = require("../../src/web/views/landing");
const { renderGuildListBody } = require("../../src/web/views/root");
const { html } = require("../../src/web/views/escape");

const REPO_ROOT = path.join(__dirname, "..", "..");
const BASELINE_DIR = path.join(REPO_ROOT, "test/visual/baselines");
const ACTUAL_DIR = path.join(REPO_ROOT, "test/visual/actual");
const DIFF_DIR = path.join(REPO_ROOT, "test/visual/diff");
const EVIDENCE_PATH = path.join(REPO_ROOT, "test/visual/csp-evidence.json");

const PAGES = [
  "shell",
  "dashboard",
  "users",
  "ticket-actions",
  "archive",
  "warnings",
  "notes",
  "staff",
  "settings",
  "sessions",
  "system-sessions",
  "system",
  "audit",
  "voice",
  "events",
  "transcript",
  "transcript-export",
  "landing",
  "signin",
  "root",
];
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

/** Year 2100: formatWhen's relative half stays "now" on every machine. */
const WHEN_MS = Date.UTC(2100, 0, 1);
const CLOSED_MS = Date.UTC(2026, 5, 6, 20, 0, 0);
const ADA = "100000000000000042";
const BEA = "100000000000000043";
const ROLE = "100000000000000099";
const CHANNEL = "100000000000000077";
const NAMES = new Map([
  [ADA, "Ada"],
  [BEA, "Bea"],
]);

function visualReq() {
  return { guildAccess: { communityId: "100", guildId: "100", tier: "staff" } };
}

function warnPage(row) {
  return {
    userId: null,
    state: "active",
    invalidUser: false,
    pageSize: 25,
    offset: 0,
    total: 1,
    rows: [row],
  };
}

function pageContent(name) {
  if (name === "users") {
    return renderUserSearchPage(visualReq(), {
      search: {
        query: "Ada",
        searched: true,
        results: [{ user_id: ADA, xp: 4200, level: 12 }],
      },
      names: NAMES,
      queryKind: "name",
    }).content;
  }
  if (name === "ticket-actions") {
    return renderTicketActionsBody({
      guildId: "100",
      csrfToken: "csrf-visual",
      flash: null,
      maxReason: 200,
      names: NAMES,
      tickets: [
        {
          id: 4,
          ticket_number: 12,
          creator_user_id: ADA,
          staff_owner_id: BEA,
          reason: "Refund question",
        },
      ],
    });
  }
  if (name === "archive") {
    return renderTicketIndexContent({
      tickets: [
        {
          transcript_token: "tok-visual",
          community_id: "100",
          ticket_number: 12,
          creator_user_id: ADA,
          staff_owner_id: BEA,
          closed_at: CLOSED_MS,
          reason: "Refund question",
          close_reason: "Resolved",
          ai_summary_json: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      guildId: "100",
      namesByGuild: new Map([["100", NAMES]]),
      inShell: true,
      viewerMode: "staff",
      baseUrl: "/g/100/t",
    });
  }
  if (name === "warnings") {
    return renderWarningsBody(visualReq(), {
      page: warnPage({
        warning_number: 12,
        user_id: ADA,
        issuer_id: BEA,
        created_at: WHEN_MS,
        voided_at: null,
        reason: "Posted a scam link",
      }),
      csrfToken: "csrf-visual",
      names: NAMES,
    });
  }
  if (name === "notes") {
    return renderNotesBody(visualReq(), {
      page: warnPage({
        note_number: 3,
        user_id: ADA,
        author_id: BEA,
        created_at: WHEN_MS,
        deleted_at: null,
        content: "Asked for a refund last week.",
      }),
      csrfToken: "csrf-visual",
      names: NAMES,
    });
  }
  if (name === "staff") {
    return renderStaffBody({
      view: {
        roles: {
          available: true,
          rows: [{ roleId: ROLE, level: "senior", addedAt: WHEN_MS }],
          seniors: 1,
          juniors: 0,
        },
        levelRoles: {
          available: true,
          rows: [{ roleId: ROLE, levelRequired: 10, dropGraceDays: 7 }],
        },
        oauth: { available: false },
      },
      resolveRoleName: () => "Mods",
      envConfig: { available: true, ready: false, missing: ["CLIENT_SECRET"] },
      guildId: "100",
      tier: "staff",
      csrfToken: "csrf-visual",
      flash: null,
    });
  }
  if (name === "settings") {
    return renderSettingsBody({
      snapshot: {
        guildSettings: {
          available: true,
          msgXp: 15,
          reactionXp: 5,
          voiceXpPerMin: 2,
          levelXpFactor: 100,
          msgCooldownSec: 20,
          reactionCooldownSec: 10,
          decayEnabled: true,
          decayMinMessages: 1,
          decayWindowDays: 30,
          decayPercent: 0.1,
          auditLogChannelId: CHANNEL,
        },
        commandChannels: { available: true, ids: [CHANNEL], everywhere: false },
        levelRoles: {
          available: true,
          rows: [{ roleId: ROLE, levelRequired: 10, dropGraceDays: 7 }],
        },
        freshness: { ageMs: 12000, fromCache: true },
      },
      resolveChannelName: () => "audit-log",
      csrfToken: "csrf-visual",
      guildId: "100",
    });
  }
  if (name === "sessions") {
    return renderYourSessionsBody({
      guildId: "100",
      currentId: "visual-current",
      csrfToken: "csrf-visual",
      sessions: [
        {
          id: "visual-current",
          discordTag: "ada",
          createdAt: WHEN_MS,
          lastSeenAt: WHEN_MS,
          expiresAt: WHEN_MS,
        },
      ],
    });
  }
  if (name === "system-sessions") {
    return renderSystemSessionsBody({
      guildId: "100",
      currentId: "visual-current",
      csrfToken: "csrf-visual",
      names: NAMES,
      sessions: [
        {
          id: "visual-current",
          userId: ADA,
          discordTag: "ada",
          createdAt: WHEN_MS,
          lastSeenAt: WHEN_MS,
          expiresAt: WHEN_MS,
        },
      ],
    });
  }
  if (name === "system") {
    return renderSystemBody({
      status: {
        process: {
          available: true,
          uptimeMs: 3661000,
          startedAt: WHEN_MS,
          nodeVersion: "v22.23.4",
          pid: 1000,
        },
        sqlite: { path: "/data/xpbot.sqlite" },
        sessionPrune: { state: "ok", detail: "idle", intervalMs: 3600000 },
        tickers: {
          available: true,
          rows: [{ name: "voice", status: "ok", lastTickAt: WHEN_MS, detail: "on minute" }],
        },
        webSurface: {
          publicHttpPortConfigured: true,
          publicHttpPort: 8080,
          publicBaseUrl: "https://example.invalid",
          secureCookies: true,
          insecureHttpWarning: false,
          sessionSecret: { configured: true, source: "SESSION_SECRET" },
        },
        oauth: { available: false },
        oauthEnv: { available: true, ready: false, missing: ["CLIENT_SECRET"] },
      },
    });
  }
  if (name === "audit") {
    return renderAuditBody(visualReq(), {
      names: NAMES,
      page: {
        origin: null,
        invalidOrigin: false,
        pageSize: 25,
        offset: 0,
        total: 1,
        rows: [
          {
            id: 9,
            created_at: WHEN_MS,
            actor_user_id: ADA,
            origin: "web",
            action: "warnings.add",
            target_type: "user",
            target_id: BEA,
            details_json: '{"warning":12}',
          },
        ],
      },
    });
  }
  if (name === "voice") {
    return renderVoiceBody({
      resolveChannelName: () => "General",
      snapshot: {
        communityId: "100",
        freshness: { ageMs: 12000, fromCache: true },
        config: { available: true, voiceXpPerMin: 5 },
        music: {
          status: "playing",
          nowPlaying: {
            title: "Night Drive",
            author: "Ada",
            positionMs: 83000,
            durationMs: 180000,
            paused: false,
            requesterId: ADA,
            isStream: false,
          },
          queue: {
            rows: [
              {
                position: 1,
                title: "Second song",
                author: "Bea",
                durationMs: 200000,
                requesterId: BEA,
                isStream: false,
              },
            ],
            truncated: false,
            total: 1,
            volume: 80,
            voiceChannelId: CHANNEL,
          },
        },
        live: {
          available: true,
          channels: [
            {
              channelId: CHANNEL,
              humans: 3,
              afk: 0,
              mutedOrDeaf: 1,
              eligible: 2,
              earning: true,
            },
          ],
          totals: { humans: 3, eligible: 2 },
          truncated: false,
          afkChannelId: null,
        },
      },
    });
  }
  if (name === "events") {
    return renderEventsMonth({
      cid: "100",
      year: 2026,
      month: 6,
      zone: "UTC",
      nowMs: Date.UTC(2026, 5, 6, 15, 0, 0),
      csrfToken: "csrf-visual",
      drafts: [],
      scheduled: [],
      events: [
        {
          community_id: "100",
          id: 7,
          title: "Friday raid",
          status: "posted",
          start_at: CLOSED_MS,
          end_at: Date.UTC(2026, 5, 6, 22, 0, 0),
        },
      ],
    });
  }
  return null;
}

const PAGE_META = {
  shell: {
    title: "Settings",
    heading: "Settings",
    lede: "Guild settings for this community.",
    path: "/g/100/settings",
    tier: "staff",
  },
  dashboard: {
    title: "Dashboard",
    heading: "Dashboard",
    lede: "Guild health at a glance.",
    path: "/g/100",
    tier: "staff",
  },
  users: { title: "Users", heading: "Users", lede: "Search tracked members.", path: "/g/100/users", tier: "staff" },
  "ticket-actions": {
    title: "Ticket actions",
    heading: "Ticket actions",
    lede: "Open tickets in this server.",
    path: "/g/100/tickets",
    tier: "senior",
  },
  archive: {
    title: "Ticket archive",
    heading: "Ticket archive",
    lede: "Archived transcripts for this guild.",
    path: "/g/100/t",
    tier: "staff",
  },
  warnings: {
    title: "Warnings",
    heading: "Warnings",
    lede: "Warnings for this guild.",
    path: "/g/100/warnings",
    tier: "staff",
  },
  notes: {
    title: "Staff notes",
    heading: "Staff notes",
    lede: "Staff notes for this guild.",
    path: "/g/100/notes",
    tier: "staff",
  },
  staff: {
    title: "Staff roles",
    heading: "Staff roles",
    lede: "Who can use staff commands.",
    path: "/g/100/staff",
    tier: "staff",
  },
  settings: {
    title: "Settings",
    heading: "Settings",
    lede: "Guild settings for this community.",
    path: "/g/100/settings",
    tier: "staff",
  },
  sessions: {
    title: "Your sessions",
    heading: "Your sessions",
    lede: "Browsers signed in on your account.",
    path: "/g/100/sessions",
    tier: "staff",
  },
  "system-sessions": {
    title: "Web sessions",
    heading: "Web sessions",
    lede: "Every live console session.",
    path: "/g/100/system/sessions",
    tier: "admin",
  },
  system: {
    title: "System",
    heading: "System",
    lede: "Process, storage, and jobs.",
    path: "/g/100/system",
    tier: "admin",
  },
  audit: {
    title: "Audit trail",
    heading: "Audit trail",
    lede: "admin_audit rows for this guild.",
    path: "/g/100/audit",
    tier: "admin",
  },
  voice: {
    title: "Voice",
    heading: "Voice",
    lede: "Now playing and live voice.",
    path: "/g/100/voice",
    tier: "staff",
  },
  events: {
    title: "Events",
    heading: "Events",
    lede: "This month in the guild zone.",
    path: "/g/100/events",
    tier: "staff",
  },
};

const TRANSCRIPT_TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TRANSCRIPT_TICKET = {
  community_id: "100",
  ticket_number: 12,
  transcript_token: TRANSCRIPT_TOKEN,
  creator_user_id: ADA,
  staff_owner_id: BEA,
  closed_by_user_id: BEA,
  created_at: CLOSED_MS - 3600000,
  closed_at: CLOSED_MS,
  reason: "Refund question",
  close_reason: "Refunded",
  is_sensitive: 0,
};
const TRANSCRIPT_MESSAGES = [
  {
    message_id: "100000000000000088",
    author_id: ADA,
    author_tag: "Ada",
    content: "Can I get a refund for the June show?",
    attachment_urls: JSON.stringify([
      { name: "receipt.txt", href: "javascript:alert(1)" },
      { name: "photo.png" },
    ]),
    sent_at: CLOSED_MS - 1800000,
  },
];

function transcriptDocument(name, nonce) {
  if (name === "transcript-export") {
    // Full export document. Do not wrap it in renderLayout: it must stay
    // free of /static, Shoelace, and the AI summary.
    return renderTranscriptHtml(TRANSCRIPT_TICKET, TRANSCRIPT_MESSAGES, {
      guildName: "Forge Guild",
      requesterLabel: "Ada",
      staffOwnerLabel: "Bea",
      closedByLabel: "Bea",
    });
  }
  // renderTranscriptPage already calls renderLayout.
  return renderTranscriptPage({
    req: { user: { userId: "42", discordTag: "ada" }, csrfToken: "csrf-visual" },
    res: { locals: { cspNonce: nonce } },
    ticket: TRANSCRIPT_TICKET,
    messages: TRANSCRIPT_MESSAGES,
    summary: {
      source: "fallback",
      summary: "Member asked about a refund.",
      subject: "Refund",
      message_count: 1,
    },
    staff: true,
    tier: "staff",
    names: NAMES,
    guilds: VISUAL_GUILDS,
  });
}

function pageDocument(name, nonce) {
  if (name === "transcript" || name === "transcript-export") {
    return transcriptDocument(name, nonce);
  }
  if (name === "landing" || name === "signin") {
    // The public page. No shell, no script. `signin` is the same document
    // with the signed-out notice and the ticket-return banner.
    return renderSignInPage({
      notice: name === "signin" ? "signedout" : null,
      context: name === "signin" ? "ticket" : null,
      continueHref: "/auth/login?continue=1",
    });
  }
  if (name === "root") {
    return renderLayout({
      title: "Guilds",
      heading: "Your guilds",
      lede: "Pick a guild to open its console.",
      content: renderGuildListBody({
        rows: [
          { id: "100", name: "Forge Guild", tier: "admin" },
          { id: "101", name: "Second Guild", tier: "staff" },
        ],
      }),
      guilds: [],
      currentGuildId: null,
      tier: null,
      user: { userId: "42", discordTag: "ada" },
      csrfToken: "csrf-visual",
      nonce,
    });
  }
  const meta = PAGE_META[name];
  const shared = {
    guilds: VISUAL_GUILDS,
    currentGuildId: "100",
    tier: meta.tier,
    user: { userId: "42", discordTag: "ada" },
    csrfToken: "csrf-visual",
    nonce,
  };
  let content;
  if (name === "dashboard") {
    content = renderDashboardContent(DASHBOARD_SAMPLE, { guildId: "100" });
  } else if (name === "shell") {
    content = html`<p class="subheading">Command channels, XP, and decay live on this page.</p>`;
  } else {
    content = pageContent(name);
  }
  return renderLayout({
    ...shared,
    title: meta.title,
    heading: meta.heading,
    lede: meta.lede,
    path: meta.path,
    content,
  });
}

function startServer() {
  const csp = createCspMiddleware();
  const staticMw = createStaticMiddleware();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const fixture = url.pathname.match(/^\/fixture\/([a-z0-9-]+)$/);
    if (fixture && PAGES.includes(fixture[1])) {
      csp(req, res, () => {
        const name = fixture[1];
        const document = pageDocument(name, res.locals.cspNonce || "");
        const headers = {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        };
        // The export inlines woff2 as data: URIs. The console policy blocks
        // those, so this one fixture response allows them. Other pages do not.
        if (name === "transcript-export") {
          headers["Content-Security-Policy"] = contentSecurityPolicy(
            res.locals.cspNonce || "",
            { embedFonts: true }
          );
        }
        res.writeHead(200, headers);
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
  // The export and the sign-in page ship no Shoelace and no app.js.
  // Waiting for sl-button there hangs until the timeout.
  if (name !== "transcript-export" && name !== "landing" && name !== "signin") {
    await page.waitForFunction(() => customElements.get("sl-button"));
    // app.js sets role=combobox only after the first keystroke (ensureList).
    // A resting lookup is still a plain input with data-lookup wiring.
    await page.waitForFunction(() => {
      const copies = [...document.querySelectorAll("sl-copy-button")];
      if (!copies.length) return true;
      if (!customElements.get("sl-copy-button")) return false;
      return copies.every((el) => el.shadowRoot && el.shadowRoot.querySelector("button"));
    });
  }
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
          if (fs.existsSync(baselinePath)) {
            const kept = comparePng(actualPath, baselinePath, path.join(DIFF_DIR, file));
            if (kept.ok) {
              console.log(`[visual] ${file} match (kept)`);
              continue;
            }
          }
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
