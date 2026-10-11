const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

/**
 * Grep gate (audit-2026-10 C6, issue #189): the two third-party token
 * columns (`guild_command_permission_oauth.refresh_token` / `.access_token`,
 * `github_watches.token`) are envelope-encrypted at rest, and the ONLY code
 * allowed to touch those tables in SQL is the pair of encrypting
 * repositories (plus the migrations that create/re-key/migrate them).
 *
 * Any new SQL anywhere else that selects, inserts, or updates these tables
 * would silently reintroduce "raw token column reads" — e.g. a feature
 * copying the column into memory, a report joining it out, or a fix writing
 * plaintext back. The repositories must also keep routing their token columns
 * through src/core/thirdPartyTokens.js (structural pin: the require), so a
 * refactor cannot quietly drop the encryption step.
 */

const SRC_DIR = path.join(__dirname, "..", "src");
const MIGRATIONS_DIR = path.join(SRC_DIR, "db", "migrations") + path.sep;

/** Files permitted to reference the token tables in SQL (outside migrations). */
const REPO_ALLOWLIST = new Set([
  path.join(SRC_DIR, "db", "repositories", "githubWatches.js"),
  path.join(SRC_DIR, "db", "repositories", "commandPermissionOauth.js"),
]);

const TOKEN_TABLES = ["guild_command_permission_oauth", "github_watches"];

/**
 * SQL-shaped reference: a DML keyword immediately followed by the table
 * name. Comments that merely TALK about the tables (several modules do) do
 * not match — none of them put FROM/UPDATE/INSERT INTO in front of the name
 * outside a code fence, and a comment pretending to be SQL is exactly what
 * this gate should nag about anyway.
 */
const dmlRegex = (table) =>
  new RegExp(`\\b(from|update|insert\\s+into|replace\\s+into|join)\\s+\`?${table}\`?\\b`, "i");

function* jsFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith(".js")) yield full;
  }
}

/**
 * Drop whole-line comments (JSDoc `*`/`/*`/`//` openers) before matching.
 * Doc prose about the tables ("row from guild_command_permission_oauth") is
 * documentation, not SQL; code lines (including trailing comments) stay.
 */
function stripWholeLineComments(source) {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("*") || t.startsWith("/*") || t.startsWith("//"));
    })
    .join("\n");
}

describe("third-party token storage architecture gate (#189)", () => {
  it("no SQL touches the token tables outside the encrypting repositories + migrations", () => {
    const offenders = [];
    for (const file of jsFiles(SRC_DIR)) {
      if (file.startsWith(MIGRATIONS_DIR)) continue; // schema + re-key + 039
      if (REPO_ALLOWLIST.has(file)) continue;
      const source = stripWholeLineComments(fs.readFileSync(file, "utf8"));
      for (const table of TOKEN_TABLES) {
        if (dmlRegex(table).test(source)) {
          offenders.push(`${path.relative(SRC_DIR, file)} → ${table}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "only src/db/repositories/{githubWatches,commandPermissionOauth}.js may write SQL " +
        "against the third-party token tables — everything else must go through those " +
        "encrypting repositories (see issue #189)."
    );
  });

  it("the repositories + migration 039 require the envelope module (encryption cannot be refactor-dropped)", () => {
    const mustRequire = [
      "db/repositories/githubWatches.js",
      "db/repositories/commandPermissionOauth.js",
      "db/migrations/039_encrypt_third_party_tokens.js",
      "features/commandPermissions/oauthTokens.js",
    ];
    for (const rel of mustRequire) {
      const source = fs.readFileSync(path.join(SRC_DIR, rel), "utf8");
      assert.match(
        source,
        /require\([^)]*thirdPartyTokens[^)]*\)/,
        `${rel} must keep requiring src/core/thirdPartyTokens (the at-rest envelope)`
      );
    }
  });

  it("the envelope module binds the generic core codec (one envelope implementation repo-wide)", () => {
    const core = fs.readFileSync(path.join(SRC_DIR, "core", "thirdPartyTokens.js"), "utf8");
    assert.match(core, /require\("\.\/tokenCrypto"\)/);
    assert.match(core, /createEnvelopeCrypto/);
    assert.match(core, /TOKEN_ENCRYPTION_KEY/);
  });

  it("the bridge token store delegates to the same core codec (no envelope fork)", () => {
    const bridge = fs.readFileSync(
      path.join(SRC_DIR, "features", "bridge", "tokenCrypto.js"),
      "utf8"
    );
    assert.match(bridge, /require\("\.\.\/\.\.\/core\/tokenCrypto"\)/);
    assert.match(bridge, /createEnvelopeCrypto/);
    assert.match(bridge, /BRIDGE_TOKEN_KEY/);
  });

  it("the token columns are not SELECTed in the user-facing watch getters", () => {
    // Behavioural companion of the allowlist: getGithubWatch(es) may only
    // observe the token column through `(token IS NOT NULL) AS has_token`.
    const source = fs.readFileSync(
      path.join(SRC_DIR, "db", "repositories", "githubWatches.js"),
      "utf8"
    );
    const selectBlocks = source.match(/SELECT[\s\S]*?FROM github_watches/g) || [];
    assert.ok(selectBlocks.length >= 2, "expected the watch getters to still exist");
    for (const block of selectBlocks) {
      // The ticker query (getAllGithubWatches) is the one query allowed to
      // read the column (it decrypts); identify it, everything else must use
      // the has_token projection.
      if (block.includes("token,")) {
        assert.ok(
          block.includes("last_checked"),
          "only getAllGithubWatches may select the raw token column (per-row decryption)"
        );
      } else {
        assert.match(block, /IS NOT NULL\) AS has_token/);
      }
    }
  });
});
