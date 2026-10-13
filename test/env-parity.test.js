/**
 * .env.example <-> code-read parity guard (issue #205 — audit §6 sweep).
 *
 * Every environment variable src/ READS must have an entry in .env.example
 * (the audit counted 15 missing; the #205 sweep re-derived 16 from main and
 * documented them all). A regex scan of the source is deliberate: this is a
 * drift guard, not a parser — it runs in milliseconds and fails by NAMING
 * the missing variables.
 *
 * How new variables are meant to evolve:
 *  - a new plain `process.env.NEW_VAR` / `env.NEW_VAR` read makes the scan
 *    find it; without an .env.example entry (or a deliberate EXCLUSIONS
 *    entry with a reason) the coverage test fails by name;
 *  - a new DYNAMIC read (`process.env[someName]`) is only allowed inside the
 *    audited DYNAMIC_READ_FILES allow-list — a new file there fails the test
 *    and forces the site to be audited + name-extracted by one of the
 *    targeted patterns (helper call site, `envVarName:` binding, *_ENV
 *    constant, or the per-file SCREAMING-literal pin);
 *  - EXPECTED_VARS is the pinned ground truth: if the scan no longer finds
 *    exactly this set, either the code changed (add the var everywhere) or a
 *    pattern silently stopped matching (fix the scan, don't relax the pin).
 *
 * Scope: src/ only. `npm run fluxer:spike` reads FLUXER_SPIKE_* from
 * scripts/, never from the bot runtime — they stay documented in the spike
 * section of .env.example, outside this guard.
 *
 * Deterministic: sorted recursive walk, no clocks, no env mutation.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, ".env.example");

/** Sorted recursive walk (deterministic across platforms/filesystems). */
function listSourceFiles(dir) {
  const out = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

/** Repo-relative, forward-slash display path. */
const rel = (file) =>
  path.relative(REPO_ROOT, file).split(path.sep).join("/");

/** Env-var NAME shape: SCREAMING_SNAKE with at least two segments. */
const NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";

/**
 * Direct and name-extractable dynamic read forms. Each pattern yields a
 * LITERAL env-var name in group 1 — anything computed falls through to the
 * process.env[...] dynamic-site guard below.
 */
const READ_PATTERNS = [
  new RegExp(`\\bprocess\\.env\\.(${NAME})\\b`, "g"),
  new RegExp(`\\bprocess\\.env\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
  // gork's per-call numeric knob helpers (trigger/summarize/images)
  new RegExp(`\\b(?:envPositiveInt|envNonNegInt)\\(\\s*["'](${NAME})["']`, "g"),
  // functions taking an injectable env source (`env.FOO` reads)
  new RegExp(`\\benv\\.(${NAME})\\b`, "g"),
  // src/core/tokenCrypto.js factory bindings (bridge + third-party tokens)
  new RegExp(`\\benvVarName:\\s*["'](${NAME})["']`, "g"),
  // key-name constants like `const KEY_ENV = "TOKEN_ENCRYPTION_KEY"`
  new RegExp(`\\bconst\\s+[A-Z0-9_]*ENV[A-Z0-9_]*\\s*=\\s*["'](${NAME})["']`, "g"),
  // object MAP VALUES keyed to a var name, e.g. the retention module's
  // `activityDays: "RETENTION_ACTIVITY_DAYS"` (looked up dynamically). Any
  // non-env SCREAMING value-literal would be flagged too — it is excluded via
  // NON_ENV_LITERALS, so a NEW such literal fails loudly rather than hiding.
  new RegExp(`:\\s*["'](${NAME})["']`, "g"),
];

/**
 * Every dotted `process.env.X` read regardless of shape. Anything outside
 * the SCREAMING_SNAKE NAME shape would silently bypass the NAME-shaped
 * patterns above, so the shape itself is pinned (see the first test).
 */
const LOOSE_DOTTED = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const STRICT_NAME = new RegExp(`^${NAME}$`);

/**
 * Files allowed to contain a DYNAMIC (non-literal) `process.env[...]` read,
 * with where their variable NAMES are extractable from. Adding a file here
 * is a deliberate act: the site must be audited and its names pinned (see
 * the header comment).
 */
const DYNAMIC_READ_FILES = new Map([
  [
    "src/config.js",
    "requireEnv(name) is generic by contract; callers pass literals and assertRuntimeEnv reads DISCORD_TOKEN directly",
  ],
  [
    "src/core/tokenCrypto.js",
    "createEnvelopeCrypto reads process.env[envVarName]; the names come from the envVarName:/KEY_ENV bindings at its two factories",
  ],
  [
    "src/db/migrations/039_encrypt_third_party_tokens.js",
    "reads process.env[KEY_ENV] (TOKEN_ENCRYPTION_KEY) imported from thirdPartyTokens",
  ],
  [
    "src/features/gork/summarize.js",
    "envPositiveInt(name) helper; names captured at the helper call sites",
  ],
  [
    "src/features/gork/images.js",
    "envPositiveInt/envNonNegInt(name) helpers; names captured at the call sites",
  ],
  [
    "src/features/gork/trigger.js",
    "envPositiveInt(name) helper; names captured at the call sites",
  ],
  [
    "src/features/retention/config.js",
    "process.env[ENV_BY_FIELD[field]]; the map values are SCREAMING literals pinned by the per-file literal check",
  ],
]);

/**
 * Quoted SCREAMING_SNAKE literals inside dynamic-read files that are NOT
 * env-var names (so a NEW name introduced as a helper argument, map entry or
 * constant in those files can never slip past the scan undetected).
 */
const NON_ENV_LITERALS = new Map([
  [
    "src/config.js",
    new Set([
      // placeholder VALUES inside the FLUXER_INSTANCES doc-comment example
      "YOUR_FLUXER_BOT_TOKEN",
      "YOUR_FLUXER_OAUTH_CLIENT_ID",
      "YOUR_FLUXER_OAUTH_CLIENT_SECRET",
    ]),
  ],
]);

/**
 * Deliberately excluded from the .env.example coverage requirement, with a
 * reason per entry (e.g. internal/test-only runtime vars). The #205 sweep
 * found NO legitimate exclusions — every read var belongs in .env.example —
 * so this map is intentionally EMPTY. If a future var truly must not be
 * operator-documented, add `NAME: "reason"` here and expect a reviewer to
 * push back.
 */
const EXCLUSIONS = new Map();

/**
 * Pinned ground truth: every variable src/ read at the #205 sweep.
 * Reconcile deliberately — new entries need an .env.example entry AND docs.
 * (`.sort()` keeps the pin itself order-insensitive; the SCAN output is
 * sorted the same way for the deepEqual.)
 */
const EXPECTED_VARS = [
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_SMALL_MODEL",
  "BRIDGE_ENABLED",
  "BRIDGE_TOKEN_KEY",
  "CLIENT_ID",
  "CLIENT_SECRET",
  "DATA_DIR",
  "DB_PATH",
  "DEV_GUILD_ID",
  "DISCORD_TOKEN",
  "FEATURE_GATE_WATCHDOG_MS",
  "FLUXER_ALLOW_INSECURE",
  "FLUXER_COMMAND_PREFIX",
  "FLUXER_INSTANCES",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GORK_DEBUG",
  "GORK_INTERACTION_LOG",
  "GORK_INTERACTION_LOG_MAX_JSON_CHARS",
  "GORK_INTERACTION_LOG_RETENTION_DAYS",
  "GORK_LLM_MAX_TOKENS",
  "GORK_LLM_MAX_TOOL_ROUNDS",
  "GORK_LLM_THINKING_TOKEN_BUDGET",
  "GORK_LLM_TIMEOUT_MS",
  "GORK_MAX_ANSWER_CHARS",
  "GORK_MEMORY_TURN_TIMEOUT_MS",
  "GORK_SUMMARIZE_TURN_TIMEOUT_MS",
  "GORK_VISION_DOWNLOAD_TIMEOUT_MS",
  "GORK_VISION_MAX_IMAGE_BYTES",
  "GORK_VISION_MAX_IMAGES",
  "GORK_VISION_MAX_TOTAL_BYTES",
  "GORK_VISION_MODEL",
  "LAVALINK_HOST",
  "LAVALINK_PASSWORD",
  "LAVALINK_PORT",
  "LAVALINK_SECURE",
  "OAUTH_REDIRECT_URI",
  "OAUTH_STATE_SECRET",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "PUBLIC_BASE_URL",
  "PUBLIC_HTTP_PORT",
  "RETENTION_ACTIVITY_DAYS",
  "RETENTION_ADMIN_AUDIT_DAYS",
  "RETENTION_DAILY_AGGREGATES_DAYS",
  "RETENTION_OAUTH_TX_SWEEP",
  "SEARXNG_URL",
  "SESSION_SECRET",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "TICKET_HTTP_PORT",
  "TICKET_MAX_ASSET_BYTES",
  "TICKET_MAX_ASSETS",
  "TICKET_PUBLIC_BASE_URL",
  "TICKET_SUMMARY_TIMEOUT_MS",
  "TOKEN_ENCRYPTION_KEY",
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_CALLBACK_URL",
  "TWITCH_EVENTSUB_MAX_CHANNELS",
  "TWITCH_EVENTSUB_SECRET",
  "WEB_DASHBOARD_CACHE_TTL_MS",
  "WEB_LOGIN_PROMPT",
  "WEB_LOGIN_REDIRECT_URI",
  "WEB_MAX_BODY_BYTES",
  "WEB_RATE_LIMIT_AUTH_MAX",
  "WEB_RATE_LIMIT_AUTH_USER_MAX",
  "WEB_RATE_LIMIT_MUTATION_MAX",
  "WEB_RATE_LIMIT_WINDOW_MS",
  "WEB_SESSION_TTL_HOURS",
  "WEB_TIER_CACHE_TTL_MS",
  "WEB_TRUST_PROXY",
  "YOUTUBE_API_KEY",
].sort();

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const sourceFiles = listSourceFiles(SRC_DIR);
const readsByVar = new Map(); // name → Set<display file>
const dynamicSites = []; // { file, expr }
const nonConformingDotted = new Set(); // dotted reads outside the NAME shape

for (const file of sourceFiles) {
  const text = fs.readFileSync(file, "utf8");
  const display = rel(file);
  for (const re of READ_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text))) {
      if (!readsByVar.has(match[1])) readsByVar.set(match[1], new Set());
      readsByVar.get(match[1]).add(display);
    }
  }
  // Dynamic (computed) reads: `process.env[anything-not-a-quoted-literal]`.
  const dynRe = /process\.env\[\s*(?!["'`])([^\]]+)\]/g;
  let dyn;
  while ((dyn = dynRe.exec(text))) {
    dynamicSites.push({ file: display, expr: dyn[1].trim() });
  }
  // Shape pin: a dotted read outside the SCREAMING NAME shape would evade
  // every NAME-shaped pattern above — record it so the shape test fails.
  LOOSE_DOTTED.lastIndex = 0;
  let loose;
  while ((loose = LOOSE_DOTTED.exec(text))) {
    if (!STRICT_NAME.test(loose[1])) {
      nonConformingDotted.add(`${display}: ${loose[1]}`);
    }
  }
}

// NON_ENV_LITERALS are placeholder VALUES (not var names) that the generic
// map-value pattern can match inside doc-comment JSON examples — pull them
// back out of the read set. (The literal tripwire test still requires every
// such value to be declared, so nothing slips through silently.)
for (const placeholders of NON_ENV_LITERALS.values()) {
  for (const name of placeholders) readsByVar.delete(name);
}

const scannedVars = [...readsByVar.keys()].sort();

/** Quoted SCREAMING_SNAKE string literals in a source file. */
function screamingLiterals(text) {
  const out = new Set();
  const re = new RegExp(`["'](${NAME})["']`, "g");
  let match;
  while ((match = re.exec(text))) out.add(match[1]);
  return out;
}

/** Variable names .env.example documents (# VAR= comments count). */
function documentedEnvVars() {
  const text = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");
  return new Set(
    [...text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("env-parity (issue #205)", () => {
  it("every dotted process.env read matches the pinned NAME shape", () => {
    assert.deepEqual(
      [...nonConformingDotted].sort(),
      [],
      `dotted env reads outside the SCREAMING_SNAKE shape (they would evade ` +
        `the NAME-shaped scan): ${[...nonConformingDotted].join(", ")} — rename ` +
        `the var or teach the scan its exact read site.`,
    );
  });

  it("the source scan finds exactly the pinned variable set", () => {
    assert.deepEqual(
      scannedVars,
      EXPECTED_VARS,
      `the env-read scan and EXPECTED_VARS diverged.\n` +
        `scan-only: ${scannedVars.filter((v) => !EXPECTED_VARS.includes(v)).join(", ") || "-"}\n` +
        `pin-only: ${EXPECTED_VARS.filter((v) => !scannedVars.includes(v)).join(", ") || "-"}\n` +
        `If src/ gained/lost a var: update .env.example, docs, and this pin together. ` +
        `If a pattern silently stopped matching, fix the scan.`,
    );
  });

  it("dynamic process.env[...] reads stay inside the audited allow-list", () => {
    const strays = dynamicSites.filter(
      (site) => !DYNAMIC_READ_FILES.has(site.file),
    );
    assert.deepEqual(
      strays,
      [],
      `new dynamic env reads outside the allow-list: ` +
        strays
          .map((s) => `${s.file} [process.env[${s.expr}]]`)
          .join(", ") +
        ` — audit the site, then add the file to DYNAMIC_READ_FILES WITH the ` +
        `pattern that extracts its variable names (and document the var in .env.example).`,
    );
    // Staleness the other way: an allow-listed file with no dynamic read left
    // must be pruned, or the list rots into a lie.
    const present = new Set(dynamicSites.map((s) => s.file));
    const stale = [...DYNAMIC_READ_FILES.keys()].filter((f) => !present.has(f));
    assert.deepEqual(
      stale,
      [],
      `DYNAMIC_READ_FILES entries no longer contain a dynamic read: ` +
        `${stale.join(", ")} — prune them.`,
    );
  });

  it("dynamic-read files contain only known env-name literals", () => {
    const problems = [];
    const allowed = new Set([
      ...readsByVar.keys(),
    ]);
    for (const file of DYNAMIC_READ_FILES.keys()) {
      const full = path.join(REPO_ROOT, file);
      const fileAllowed = new Set([
        ...allowed,
        ...(NON_ENV_LITERALS.get(file) ?? []),
      ]);
      for (const literal of screamingLiterals(fs.readFileSync(full, "utf8"))) {
        if (!fileAllowed.has(literal)) problems.push(`${file}: "${literal}"`);
      }
    }
    assert.deepEqual(
      problems,
      [],
      `SCREAMING_SNAKE literals in dynamic-read files that the scan does not ` +
        `treat as env names: ${problems.join(", ")} — if it is an env var, make the ` +
        `scan match its read site (helper/map/constant pattern) and document it; ` +
        `if not, add it to NON_ENV_LITERALS with a reason.`,
    );
  });

  it(".env.example documents every variable src/ reads", () => {
    const documented = documentedEnvVars();
    const missing = scannedVars.filter(
      (name) => !documented.has(name) && !EXCLUSIONS.has(name),
    );
    assert.deepEqual(
      missing,
      [],
      `.env.example is missing ${missing.length} var(s) that src/ reads: ` +
        `${missing.join(", ")} — add each with a comment naming default + ` +
        `consequence (see the sweep entries for style).`,
    );
  });

  it("EXCLUSIONS has no stale entries", () => {
    const scanned = new Set(scannedVars);
    const stale = [...EXCLUSIONS.keys()].filter((name) => !scanned.has(name));
    assert.deepEqual(
      stale,
      [],
      `EXCLUSIONS names nothing src/ reads anymore: ${stale.join(", ")} — prune.`,
    );
  });
});
