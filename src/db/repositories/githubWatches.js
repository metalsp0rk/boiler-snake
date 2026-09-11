const { db, now } = require("../connection");

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

function getGithubWatches(guildId) {
  return db.prepare(`
  SELECT guild_id, repo, repo_display, channel_id, role_id,
         last_release_id, last_release_published_at, last_checked,
         (token IS NOT NULL) AS has_token
  FROM github_watches
  WHERE guild_id=?
  ORDER BY created_at ASC
  `).all(guildId);
}

/** Rows for the ticker — includes the per-repo token. Never surface to users. */
function getAllGithubWatches() {
  return db.prepare(`
  SELECT guild_id, repo, repo_display, channel_id, role_id, token,
         last_release_id, last_release_published_at, last_checked
  FROM github_watches
  ORDER BY created_at ASC
  `).all();
}

function getGithubWatch(guildId, repo) {
  const normalized = normalizeGithubRepo(repo);
  if (!normalized) return null;
  const row = db.prepare(`
  SELECT guild_id, repo, repo_display, channel_id, role_id,
         last_release_id, last_release_published_at, last_checked,
         (token IS NOT NULL) AS has_token
  FROM github_watches
  WHERE guild_id=? AND repo=?
  `).get(guildId, normalized);
  return row || null;
}

/**
 * Watch a repository for a guild (upsert by guild+repo).
 * Preserves channel/role/pointer state on re-add; sets token when provided.
 * @returns {object} the stored row (without token)
 */
function addGithubWatch(guildId, repo, repoDisplay, { channelId = null, token = null } = {}) {
  const normalized = normalizeGithubRepo(repo);
  if (!normalized) throw new Error(`Invalid repository: ${repo}`);
  const t = now();
  db.prepare(`
  INSERT INTO github_watches
    (guild_id, repo, repo_display, channel_id, role_id, token, created_at, updated_at)
  VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
  ON CONFLICT(guild_id, repo) DO UPDATE SET
    repo_display=excluded.repo_display,
    channel_id=COALESCE(excluded.channel_id, github_watches.channel_id),
    token=COALESCE(excluded.token, github_watches.token),
    updated_at=excluded.updated_at
  `).run(
    guildId,
    normalized,
    repoDisplay || normalized,
    channelId,
    token || null,
    t,
    t,
  );
  return getGithubWatch(guildId, normalized);
}

/**
 * @returns {boolean} true if a row was deleted
 */
function removeGithubWatch(guildId, repo) {
  const normalized = normalizeGithubRepo(repo);
  if (!normalized) return false;
  const res = db
    .prepare("DELETE FROM github_watches WHERE guild_id=? AND repo=?")
    .run(guildId, normalized);
  return res.changes > 0;
}

/**
 * Update routing fields. Undefined values are left unchanged; explicit null
 * clears the field (roleId=null removes the ping, channelId=null unsets it).
 * `token` follows undefined=keep, null=clear, string=set semantics.
 */
function updateGithubWatch(
  guildId,
  repo,
  { channelId, roleId, token } = {},
) {
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
  params.push(guildId, normalized);
  db.prepare(
    `UPDATE github_watches SET ${fields.join(", ")} WHERE guild_id=? AND repo=?`,
  ).run(...params);
  return getGithubWatch(guildId, normalized);
}

/**
 * Record the newest release we have notified about (release pointer moves
 * forward only; the ticker sends one message per release in between).
 */
function updateGithubWatchReleaseState(
  guildId,
  repo,
  { lastReleaseId, lastReleasePublishedAt, lastChecked },
) {
  const t = now();
  db.prepare(`
  UPDATE github_watches
  SET last_release_id=?, last_release_published_at=?, last_checked=?, updated_at=?
  WHERE guild_id=? AND repo=?
  `).run(
    lastReleaseId ?? null,
    lastReleasePublishedAt ?? null,
    lastChecked ?? null,
    t,
    guildId,
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
