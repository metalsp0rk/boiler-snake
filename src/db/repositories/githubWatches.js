const { db, now } = require("../connection");

// src/platform/community.js requires the db facade (src/db/index.js), so a
// top-level require here would be a load-time cycle (partial exports). The
// lazy require resolves after boot; assertCommunityId stays single-source.
const assertCommunityId = (id) => require("../../platform/community").assertCommunityId(id);

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

/** Rows for the ticker — includes the per-repo token. Never surface to users. */
function getAllGithubWatches() {
  return db.prepare(`
  SELECT community_id, repo, repo_display, channel_id, role_id, token,
         last_release_id, last_release_published_at, last_checked
  FROM github_watches
  ORDER BY created_at ASC
  `).all();
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
    token || null,
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
    params.push(token);
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
