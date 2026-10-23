const { db, now } = require("../connection");
const tokens = require("../../core/thirdPartyTokens");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

/**
 * AT REST (audit-2026-10 C6, #189): `github_watches.token` holds ONLY the
 * `v1.<iv>.<tag>.<ciphertext>` AES-256-GCM envelope (src/core/
 * thirdPartyTokens.js, TOKEN_ENCRYPTION_KEY). Writes encrypt (a missing key
 * throws the actionable key-missing error — a provided PAT is NEVER stored
 * in plaintext); getAllGithubWatches decrypts per row for the ticker. The
 * user-facing getters keep `(token IS NOT NULL) AS has_token` and never
 * select the column itself.
 */

/**
 * Encrypt a provided PAT for storage. null/undefined/"" stays NULL; a real
 * token with a missing/invalid key throws (caller's handler surfaces the
 * cause — AGENTS.md 3).
 *
 * @param {string|null|undefined} token
 * @returns {string|null} envelope or NULL
 */
function encryptTokenColumn(token) {
  if (token == null || token === "") return null;
  const envelope = tokens.encryptToken(token);
  if (envelope == null) throw tokens.keyMissingError("the GitHub token");
  return envelope;
}

/**
 * Normalize a GitHub repository reference to "owner/name".
 * Accepts "Owner/Repo", "https://github.com/owner/repo",
 * "github.com/owner/repo/issues", or "git@github.com:owner/repo(.git)".
 * GitHub lookups are case-insensitive; keys are stored lowercase.
 * @param {string} repo
 * @returns {string|null} normalized "owner/name", or null if not parseable
 */
function normalizeGithubRepo(repo) {
  let s = String(repo || "").trim();
  if (!s) return null;
  s = s.replace(/^git\+https:\/\//i, "");
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^ssh:\/\//i, "");
  s = s.replace(/^www\./i, "");
  let hadHost = false;
  if (s.startsWith("git@github.com:")) {
    s = s.slice("git@github.com:".length);
    hadHost = true;
  } else if (/^github\.com\//i.test(s)) {
    s = s.replace(/^github\.com\//i, "");
    hadHost = true;
  }
  s = s.replace(/\.git$/i, "");
  // Strip any path/query segments after owner/name (e.g. /issues/5).
  const segs = s.split(/[/?#]/).filter(Boolean);
  if (segs.length < 2) return null;
  if (segs.length > 2 && !hadHost) return null;
  const owner = segs[0].trim().toLowerCase();
  const name = segs[1].trim().toLowerCase();
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

function getGithubWatches(communityId) {
  assertCommunityId(communityId);
  return db.prepare(`
  SELECT community_id, repo, repo_display, channel_id, role_id,
         last_release_id, last_release_published_at, last_checked,
         (token IS NOT NULL) AS has_token
  FROM github_watches
  WHERE community_id=?
  ORDER BY created_at ASC
  `).all(communityId);
}

/**
 * Rows for the ticker — includes the per-repo token DECRYPTED (columns hold
 * envelopes at rest). Never surface to users.
 *
 * Per-row fault tolerance (AGENTS.md 5, same posture as the voice/twitch
 * tickers): a row whose envelope cannot be decrypted (foreign/rotated key,
 * tampered bytes) is logged with its ids and dropped from the result instead
 * of failing the whole read — one broken row must not stop every other
 * watch's notifications. With migration 039 + a stable key this path only
 * fires on misconfiguration or tampering.
 */
function getAllGithubWatches() {
  const rows = db.prepare(`
  SELECT community_id, repo, repo_display, channel_id, role_id, token,
         last_release_id, last_release_published_at, last_checked
  FROM github_watches
  ORDER BY created_at ASC
  `).all();
  const usable = [];
  for (const row of rows) {
    try {
      const plaintext =
        row.token == null || row.token === ""
          ? row.token
          : tokens.decryptToken(row.token);
      // #281 lazy forward-migration: a v1 row (or v2 sealed by a retired
      // key) converges to a v2/current-key envelope on the next successful
      // read. A failed re-seal write NEVER loses the row — the decrypted
      // read stands, the write is best-effort.
      if (
        typeof plaintext === "string" &&
        plaintext !== "" &&
        tokens.needsTokenReencrypt(row.token)
      ) {
        try {
          const resealed = tokens.encryptToken(plaintext);
          if (resealed != null) {
            db.prepare(
              `UPDATE github_watches SET token=? WHERE community_id=? AND repo=?`
            ).run(resealed, row.community_id, row.repo);
          }
        } catch (err) {
          console.error(
            `[github] Watch ${row.repo} (community ${row.community_id}): token ` +
              `re-encrypt write failed (key rotation #281, row still usable): ` +
              `${err?.message || err}`,
          );
        }
      }
      usable.push({ ...row, token: plaintext });
    } catch (err) {
      console.error(
        `[github] Skipping watch ${row.repo} (community ${row.community_id}): ` +
          `stored token could not be decrypted: ${err?.message || err}`,
      );
    }
  }
  return usable;
}

function getGithubWatch(communityId, repo) {
  assertCommunityId(communityId);
  const normalized = normalizeGithubRepo(repo);
  if (!normalized) return null;
  const row = db
    .prepare(`
  SELECT community_id, repo, repo_display, channel_id, role_id,
         last_release_id, last_release_published_at, last_checked,
         (token IS NOT NULL) AS has_token
  FROM github_watches
  WHERE community_id=? AND repo=?
  `)
    .get(communityId, normalized);
  return row || null;
}

/**
 * Watch a repository for a community (upsert by community+repo).
 * Preserves channel/role/pointer state on re-add; sets token when provided.
 * @param {number} communityId
 * @returns {object} the stored row (without token)
 */
function addGithubWatch(communityId, repo, repoDisplay, { channelId = null, token = null } = {}) {
  assertCommunityId(communityId);
  const normalized = normalizeGithubRepo(repo);
  if (!normalized) throw new Error(`Invalid repository: ${repo}`);
  const tokenEnc = encryptTokenColumn(token);
  const t = now();
  db.prepare(`
  INSERT INTO github_watches
    (community_id, repo, repo_display, channel_id, role_id, token, created_at, updated_at)
  VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
  ON CONFLICT(community_id, repo) DO UPDATE SET
    repo_display=excluded.repo_display,
    channel_id=COALESCE(excluded.channel_id, github_watches.channel_id),
    token=COALESCE(excluded.token, github_watches.token),
    updated_at=excluded.updated_at
  `).run(
    communityId,
    normalized,
    repoDisplay || normalized,
    channelId,
    tokenEnc,
    t,
    t,
  );
  return getGithubWatch(communityId, normalized);
}

/**
 * @param {number} communityId
 * @returns {boolean} true if a row was deleted
 */
function removeGithubWatch(communityId, repo) {
  assertCommunityId(communityId);
  const normalized = normalizeGithubRepo(repo);
  if (!normalized) return false;
  const res = db
    .prepare("DELETE FROM github_watches WHERE community_id=? AND repo=?")
    .run(communityId, normalized);
  return res.changes > 0;
}

/**
 * Update routing fields. Undefined values are left unchanged; explicit null
 * clears the field (roleId=null removes the ping, channelId=null unsets it).
 * `token` follows undefined=keep, null=clear, string=set semantics.
 * @param {number} communityId
 */
function updateGithubWatch(
  communityId,
  repo,
  { channelId, roleId, token } = {},
) {
  assertCommunityId(communityId);
  const normalized = normalizeGithubRepo(repo);
  if (!normalized) return null;
  const fields = ["updated_at=?"];
  const params = [now()];
  if (channelId !== undefined) {
    fields.push("channel_id=?");
    params.push(channelId);
  }
  if (roleId !== undefined) {
    fields.push("role_id=?");
    params.push(roleId);
  }
  if (token !== undefined) {
    fields.push("token=?");
    // undefined keeps, null clears, a string stores as a fresh envelope
    // (missing key → throws; the previous envelope stays untouched).
    params.push(encryptTokenColumn(token));
  }
  params.push(communityId, normalized);
  db.prepare(
    `UPDATE github_watches SET ${fields.join(", ")} WHERE community_id=? AND repo=?`,
  ).run(...params);
  return getGithubWatch(communityId, normalized);
}

/**
 * Record the newest release we have notified about (release pointer moves
 * forward only; the ticker sends one message per release in between).
 * @param {number} communityId
 */
function updateGithubWatchReleaseState(
  communityId,
  repo,
  { lastReleaseId, lastReleasePublishedAt, lastChecked },
) {
  assertCommunityId(communityId);
  const t = now();
  db.prepare(`
  UPDATE github_watches
  SET last_release_id=?, last_release_published_at=?, last_checked=?, updated_at=?
  WHERE community_id=? AND repo=?
  `).run(
    lastReleaseId ?? null,
    lastReleasePublishedAt ?? null,
    lastChecked ?? null,
    t,
    communityId,
    repo,
  );
}

module.exports = {
  normalizeGithubRepo,
  getGithubWatches,
  getAllGithubWatches,
  getGithubWatch,
  addGithubWatch,
  removeGithubWatch,
  updateGithubWatch,
  updateGithubWatchReleaseState,
};
