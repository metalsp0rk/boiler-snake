const { URL } = require("url");

const API_BASE = "https://api.github.com";
const FETCH_TIMEOUT_MS = 15_000;

/**
 * One-line error description for logging (fetch hides the real cause in
 * err.cause — same failure mode as the Twitch Helix client).
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  if (!err) return String(err);
  const name = err.name || "Error";
  const message = err.message || String(err);
  const ownCode = err.code && !message.includes(err.code) ? ` (${err.code})` : "";
  let text = `${name}${ownCode}: ${message}`;
  const cause = err.cause;
  if (cause) {
    let causeText = cause.message || "";
    if (cause.code && !causeText.includes(cause.code)) {
      causeText = `${cause.code} ${causeText}`.trim();
    }
    text += ` | cause: ${causeText || String(cause)}`;
  }
  return text;
}

/**
 * GET a GitHub REST endpoint. Returns the parsed JSON body on success, or
 * `{ ok:false, status, error }` — never throws, never includes secrets.
 * @param {string} path e.g. "/repos/owner/repo/releases?per_page=15"
 * @param {string|null} [token] optional per-repo GitHub token
 * @returns {Promise<{ok:true, data:any}|{ok:false, status:number|null, error:string}>}
 */
async function githubGet(path, token) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, API_BASE);
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "boiler-snake-discord-bot",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: null, error: describeError(err) };
  }

  if (res.status === 404) {
    return {
      ok: false,
      status: 404,
      error:
        "repository not found (deleted, renamed, or private — a private repo needs a valid token with `repo` scope)",
    };
  }
  if (res.status === 401) {
    return {
      ok: false,
      status: 401,
      error: "GitHub rejected the configured token (invalid or expired)",
    };
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    return {
      ok: false,
      status: res.status,
      error:
        `GitHub rate limit reached${remaining != null ? ` (remaining: ${remaining})` : ""}` +
        (token ? "" : " — configure a token on this watch to raise the limit"),
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body);
      if (parsed?.message) detail = parsed.message;
    } catch {
      /* keep raw snippet */
    }
    return {
      ok: false,
      status: res.status,
      error: `GitHub API error ${res.status}${detail ? `: ${detail}` : ""}`,
    };
  }

  const data = await res.json().catch(() => null);
  if (data == null) {
    return { ok: false, status: res.status, error: "GitHub returned an unreadable response" };
  }
  return { ok: true, data };
}

/**
 * Validate that a repository exists / is accessible.
 * @param {string} repo "owner/name" (normalized)
 * @param {string|null} [token]
 * @returns {Promise<{ok:true, fullName:string}|{ok:false, error:string}>}
 */
async function fetchRepo(repo, token = null) {
  const result = await githubGet(`/repos/${repo}`, token);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, fullName: result.data?.full_name || repo };
}

/**
 * List a repository's releases, newest first, drafts excluded.
 * @param {string} repo "owner/name" (normalized)
 * @param {string|null} [token]
 * @returns {Promise<{ok:true, releases:object[]}|{ok:false, error:string}>}
 */
async function fetchReleases(repo, token = null) {
  const result = await githubGet(
    `/repos/${repo}/releases?per_page=15`,
    token,
  );
  if (!result.ok) return { ok: false, error: result.error };
  if (!Array.isArray(result.data)) {
    return { ok: false, error: "GitHub returned an unexpected releases payload" };
  }
  const releases = result.data
    .filter((r) => r && !r.draft && r.id != null && r.published_at)
    .map((r) => ({
      id: Number(r.id),
      tag: r.tag_name || "",
      name: r.name || r.tag_name || "",
      body: r.body || "",
      prerelease: !!r.prerelease,
      htmlUrl: r.html_url || `https://github.com/${repo}/releases/tag/${encodeURIComponent(r.tag_name || "")}`,
      author: r.author?.login || "",
      publishedAtMs: Date.parse(r.published_at) || 0,
    }))
    .sort((a, b) => b.publishedAtMs - a.publishedAtMs || b.id - a.id);
  return { ok: true, releases };
}

module.exports = {
  describeError,
  githubGet,
  fetchRepo,
  fetchReleases,
};
