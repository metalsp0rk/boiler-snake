#!/usr/bin/env node
/**
 * E2E SPIKE — boot the REAL bot against a local fauxcord mock Discord.
 *
 * Proves the Tier-4 idea end-to-end: the real src/platform/boot() pipeline,
 * a real discord.js gateway handshake (HELLO → IDENTIFY → READY), a real
 * register.js command PUT, and simulated real-Discord INTERACTION_CREATE /
 * MESSAGE_CREATE dispatches — everything below the wire is production code.
 *
 * Prereq: fauxcord running locally.
 *   from source: git clone https://github.com/tomacheese/fauxcord
 *                npm install
 *                PORT=3100 HOST=127.0.0.1 BASE_URL=http://127.0.0.1:3100 npm start
 *   docker:      docker run -p 127.0.0.1:3100:3000 \
 *                  -e BASE_URL=http://127.0.0.1:3100 ghcr.io/tomacheese/fauxcord:latest
 *
 * Usage: node scripts/e2e/fauxcord-spike.js
 *        FAUXCORD_URL=http://127.0.0.1:3100 (default)
 *
 * Scenarios (current fauxcord simulation surface):
 *   S1  slash /xp          → INTERACTION_CREATE → router → callback reply
 *   S2  slash /leaderboard → (deferred) response materialises on the mock
 *   S3  injected human MESSAGE_CREATE → real gateway → real XP pipeline
 *
 * NOTE: button/modal simulation is NOT supported by fauxcord v1's
 * /_test/interactions (command-name-only builder). That gap is the spike's
 * main documented limitation — see the run summary.
 *
 * Exit code 0 = every scenario passed.
 */

"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..", "..");
const BASE = (process.env.FAUXCORD_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");

// Fixed fake ids (not real snowflakes on purpose — this process must never
// be able to talk to real Discord: every base URL is overridden).
const TOKEN = "e2e-fauxcord-token";
const APP_ID = "440000000000000001";
const HUMAN_ID = "440000000000000099";
const GUILD_ID = "440000000000000100";
const GENERAL_ID = "440000000000000101";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function j(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} on ${opts.method || "GET"} ${url}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function poll(fn, { timeoutMs = 8000, everyMs = 250, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      const e = new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
      e.lastErr = lastErr ? lastErr.message : undefined;
      throw e;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function main() {
  console.log(`\n=== boiler-snake × fauxcord E2E spike ===`);
  console.log(`mock base: ${BASE}\n`);

  // 0. fauxcord reachable?
  const health = await poll(() => j(`${BASE}/_mock/health`), {
    timeoutMs: 5000,
    label: "fauxcord /_mock/health",
  }).catch((err) => {
    console.error(
      "fauxcord is not reachable at " + BASE + " — start it first (see this file's header).\n" +
      `last error: ${err.lastErr || err.message}`,
    );
    process.exit(2);
  });
  record("fauxcord reachable", health?.status === "ok", JSON.stringify(health));

  // 1. Clean slate (idempotent reruns)
  await fetch(`${BASE}/_test/setup/${encodeURIComponent(`Bot ${TOKEN}`)}`, { method: "DELETE" }).catch(() => {});
  await j(`${BASE}/_test/reset`, { method: "POST", body: "{}" }).catch(() => {});

  // 2. Test environment on the mock
  await j(`${BASE}/_test/setup`, {
    method: "POST",
    body: JSON.stringify({
      token: `Bot ${TOKEN}`,
      user: { id: APP_ID, username: "E2ESnake" },
      guilds: [{
        id: GUILD_ID,
        name: "E2E Spike Guild",
        channels: [{ id: GENERAL_ID, name: "general", type: 0 }],
      }],
    }),
  });
  let human = null;
  try {
    human = await j(`${BASE}/_test/users`, {
      method: "POST",
      body: JSON.stringify({ id: HUMAN_ID, username: "TestHuman" }),
    });
  } catch (err) {
    // Test users survive /_test/setup deletion — reuse the existing row.
    if (/409|500|CONFLICT/i.test(`${err.status} ${err.body?.message ?? ""} ${err.message}`)) {
      human = { id: HUMAN_ID, note: "pre-existing" };
    } else {
      throw err;
    }
  }
  record("mock environment provisioned", human?.id === HUMAN_ID, `human=${human?.id}${human?.note ? ` (${human.note})` : ""}`);

  // Member bootstrap: fauxcord's /_test/interactions embeds `member` (which
  // discord.js REQUIRES for guild interactions, exactly like real Discord)
  // only when the invoking user has a guild_members row. injectTestMessage
  // upserts membership for the author — so inject one message as the
  // scenario human NOW (bot not booted yet ⇒ no XP side effects) to create
  // the member row before any interaction is simulated.
  const warm = await j(`${BASE}/_test/channels/${GENERAL_ID}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "member-bootstrap (warmup)", author: { id: HUMAN_ID } }),
  });
  record("scenario human joined guild via message injection", !!warm?.id, `msg=${warm?.id ?? "?"}`);

  // 3. Production env BEFORE requiring anything that opens the DB
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-e2e-"));
  Object.assign(process.env, {
    DB_PATH: path.join(dataDir, "e2e.sqlite"),
    DATA_DIR: dataDir,
    DISCORD_TOKEN: TOKEN,
    CLIENT_ID: APP_ID,
    DEV_GUILD_ID: GUILD_ID,
    DISCORD_API_BASE: BASE,
    FEATURE_GATE_WATCHDOG_MS: "8000",
  });
  delete process.env.FLUXER_INSTANCES;

  // 4. Community row via PRODUCTION code, plus DB handle for assertions
  const { ensureCommunity } = require("../../src/platform/community");
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: GUILD_ID,
  });
  const { db } = require("../../src/db");
  record("community row (ensureCommunity)", Number.isInteger(communityId), `communityId=${communityId}`);

  // 5. Real boot — real gateway handshake against the mock
  const { boot } = require("../../src/platform/boot");
  const started = await boot({ featureGateWatchdogMs: 8000 });
  record("boot(): discord endpoint came up (real HELLO/IDENTIFY/READY)", started.ok, `ok=${started.ok}`);
  if (!started.ok) {
    record("aborting — discord endpoint never came up", false);
    return finish();
  }

  // Gateway cache sanity: the router gates guild interactions on interaction.guild
  const guildSeen = await poll(
    () => started.supervisor.discord?.guilds?.cache?.get(GUILD_ID) ?? null,
    { timeoutMs: 5000, label: "GUILD_CREATE cached" },
  ).catch(() => null);
  record(
    "guild hydrated from gateway GUILD_CREATE",
    !!guildSeen,
    `guild=${guildSeen?.id ?? "∅"}${guildSeen?.name ? ` name="${guildSeen.name}"` : ""}`,
  );

  // 6. Command registration through the REAL register CLI (child process)
  const reg = spawnSync(process.execPath, [path.join(REPO_ROOT, "src", "commands", "register.js")], {
    env: process.env,
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  const regTail = String(reg.stdout || reg.stderr || "").trim().split("\n").pop() || `exit ${reg.status}`;
  record("register.js: real command PUT accepted by mock", reg.status === 0, regTail.slice(0, 160));

  // 7. S1 — slash /xp via simulated INTERACTION_CREATE
  try {
    const inter = await j(`${BASE}/_test/interactions`, {
      method: "POST",
      body: JSON.stringify({
        application_id: APP_ID,
        command_name: "xp",
        guild_id: GUILD_ID,
        channel_id: GENERAL_ID,
        user_id: HUMAN_ID,
      }),
    });
    record("S1: mock accepted /xp simulation", !!inter?.id && !!inter?.token, `interaction=${inter?.id}`);
    const reply = await poll(
      () => j(`${BASE}/webhooks/${APP_ID}/${inter.token}/messages/@original`).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
      { timeoutMs: 10_000, label: "/xp response materialised" },
    );
    const summary = `content="${String(reply?.content ?? "").slice(0, 40)}" embeds=${reply?.embeds?.length ?? 0} flags=${reply?.flags ?? 0}`;
    record("S1: /xp INTERACTION_CREATE → router → reply on mock", true, summary);
  } catch (err) {
    record("S1: /xp E2E", false, err.lastErr || err.message);
  }

  // 8. S2 — slash /leaderboard (exercises the deferred reply path if used)
  try {
    const inter2 = await j(`${BASE}/_test/interactions`, {
      method: "POST",
      body: JSON.stringify({
        application_id: APP_ID,
        command_name: "leaderboard",
        guild_id: GUILD_ID,
        channel_id: GENERAL_ID,
        user_id: HUMAN_ID,
      }),
    });
    const reply2 = await poll(
      () => j(`${BASE}/webhooks/${APP_ID}/${inter2.token}/messages/@original`).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
      { timeoutMs: 15_000, label: "/leaderboard response materialised" },
    );
    const summary2 = `content="${String(reply2?.content ?? "").slice(0, 40)}" embeds=${reply2?.embeds?.length ?? 0} attachments=${reply2?.attachments?.length ?? 0}`;
    record("S2: /leaderboard E2E (defer/edit surface)", true, summary2);
  } catch (err) {
    record("S2: /leaderboard E2E", false, err.lastErr || err.message);
  }

  // 9. S3 — injected human MESSAGE_CREATE → gateway → real XP pipeline
  try {
    await j(`${BASE}/_test/channels/${GENERAL_ID}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: `e2e hello ${Date.now()}`, author: { id: HUMAN_ID } }),
    });
    const row = await poll(() => {
      const r = db
        .prepare("SELECT xp FROM users WHERE community_id = ? AND user_id = ?")
        .get(communityId, HUMAN_ID);
      return r && Number(r.xp) > 0 ? r : null;
    }, { timeoutMs: 10_000, label: "XP row for injected human" });
    record("S3: gateway MESSAGE_CREATE → XP pipeline → users.xp", true, `xp=${row.xp}`);
  } catch (err) {
    record("S3: MESSAGE_CREATE → XP E2E", false, err.lastErr || err.message);
  }

  // 10. Channel tape (informational)
  try {
    const tape = await j(`${BASE}/_test/messages/${GENERAL_ID}`);
    const msgs = Array.isArray(tape?.messages) ? tape.messages : [];
    const botMsgs = msgs.filter((m) => m.author_token === `Bot ${TOKEN}`);
    console.log(`\nchannel tape: ${msgs.length} message(s), ${botMsgs.length} bot-authored`);
  } catch (err) {
    console.log(`channel tape unavailable: ${err.message}`);
  }

  await started.supervisor.discord?.destroy?.().catch?.(() => {});
  return finish(dataDir);
}

function finish(dataDir) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (dataDir) console.log(`temp data dir kept for inspection: ${dataDir}`);
  // Feature tickers/schedulers may hold the loop open — the verdict is in,
  // exit deterministically with it.
  process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[e2e-spike] uncaught:", err?.stack || err);
  process.exitCode = 1;
});
