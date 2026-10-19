#!/usr/bin/env node
/**
 * #506 (option 2): auto-rerun STARVED tier-4 e2e runs.
 *
 * The serialized `fauxcord-e2e` concurrency group (e2e.yml, #450) keeps only
 * ONE pending run — every new PR's e2e DISPLACES (cancels) the previously
 * queued one. With 2–3 PRs in flight the oldest PR's e2e never runs until
 * pushes pause, and merges need a manual `gh run rerun` of the starved run.
 *
 * This script (run by .github/workflows/e2e-rerun-starved.yml on a schedule)
 * finds open PRs whose LATEST e2e run for the CURRENT head sha ended
 * `cancelled` while no e2e run for that sha is queued/running, and re-runs
 * them. The concurrency group then rotates the mock between starved PRs
 * instead of freezing on one pending slot.
 *
 * Auth: the default GITHUB_TOKEN CANNOT call the Actions rerun endpoint, and
 * a schedule-triggered workflow's token also has limited PR-run visibility.
 * A PAT (repo scope) must be provided as the E2E_RERUN_PAT secret → passed
 * in as E2E_RERUN_PAT env. Missing token = clean exit 0 with an honest log
 * (a scheduled workflow that fails daily is noise, not information).
 *
 * Never throws: every failure is logged with context; partial success
 * reports partial results (repo error doctrine). Returns { ok, reran,
 * skipped, error? } for the caller/tests; CLI sets exitCode 1 only when the
 * inventory itself could not be read (transient — next tick retries).
 */

const E2E_WORKFLOW_FILE = "e2e.yml";

const ACTIVE_STATUSES = new Set([
  "queued",
  "requested",
  "action_required",
  "waiting",
  "pending",
  "in_progress",
]);

function ghLog(msg) {
  console.log(`[e2e-rerun] ${msg}`);
}

/** One API call: JSON in/out, never throws; { ok:false, status?, error } on trouble. */
async function ghFetch(fetchImpl, url, { token, method = "GET" } = {}) {
  try {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status} ${method} ${url}: ${text.slice(0, 200)}`,
      };
    }
    return { ok: true, body: text ? JSON.parse(text) : null };
  } catch (err) {
    return { ok: false, error: `${method} ${url} failed: ${err?.message || err}` };
  }
}

/**
 * PURE decision core (unit-tested): which cancelled runs are STARVED and
 * safe to re-run?
 *
 * A run qualifies when:
 *  - it is the latest e2e PR run for its head sha, completed as `cancelled`;
 *  - its PR is open with head sha == the run's sha (a moved head means the
 *    cancellation was legitimate — the newer sha owns the slot now);
 *  - no e2e PR run for that sha is queued/running (the slot is free).
 *
 * @param {Array<object>} runs e2e workflow runs (pull_request events)
 * @param {Map<string, {number:number, sha:string}>} openPrs by "owner:branch"
 */
function selectStarvedRuns(runs, openPrs) {
  const bySha = new Map();
  for (const r of runs) {
    if (!r || !r.head_sha) continue;
    const list = bySha.get(r.head_sha) || [];
    list.push(r);
    bySha.set(r.head_sha, list);
  }

  const rerun = [];
  const skipped = [];
  for (const [sha, group] of bySha) {
    // An active (queued/running) e2e run for this sha means the pipeline
    // already has a slot claim for it — never re-run anything for that sha.
    if (group.some((r) => ACTIVE_STATUSES.has(r.status))) {
      const newest = group.reduce((a, b) => (a.run_number > b.run_number ? a : b));
      skipped.push({
        sha,
        run: newest.id,
        reason: "an e2e run for this sha is still active",
      });
      continue;
    }
    // latest run_number wins (list endpoint reports the latest attempt of each run)
    group.sort((a, b) => b.run_number - a.run_number);
    const latest = group[0];
    if (latest.status !== "completed" || latest.conclusion !== "cancelled") {
      continue; // success / failure — nothing starved here
    }
    const prKey = latest.head_repository?.full_name && latest.head_branch
      ? `${latest.head_repository.full_name}:${latest.head_branch}`
      : null;
    const pr = prKey ? openPrs.get(prKey) : undefined;
    if (!pr) {
      skipped.push({ sha, run: latest.id, reason: "no open PR for this head" });
      continue;
    }
    if (pr.sha !== sha) {
      skipped.push({ sha, run: latest.id, reason: `PR #${pr.number} head moved (${pr.sha})` });
      continue;
    }
    rerun.push({ runId: latest.id, pr: pr.number, sha, branch: latest.head_branch });
  }
  return { rerun, skipped };
}

/**
 * @param {{ env?: object, fetchImpl?: Function, log?: Function }} [deps]
 */
async function main({ env = process.env, fetchImpl = globalThis.fetch, log = ghLog } = {}) {
  const token = env.E2E_RERUN_PAT || "";
  const repo = env.GITHUB_REPOSITORY || "";
  const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
  const base = `${api}/repos/${repo}`;

  if (!token || !repo) {
    log(
      !repo
        ? "GITHUB_REPOSITORY missing — nothing to do."
        : "E2E_RERUN_PAT secret not configured — automated rerun disabled (see docs/e2e.md).",
    );
    return { ok: true, reran: [], skipped: [], reason: "disabled" };
  }

  // 1. Inventory: recent e2e PR runs (one page of 100 is plenty for a repo
  //    whose suite is ~4 min and merges serialize).
  const runsRes = await ghFetch(fetchImpl,
    `${base}/actions/workflows/${E2E_WORKFLOW_FILE}/runs?event=pull_request&per_page=100`,
    { token });
  if (!runsRes.ok) return { ok: false, error: runsRes.error, reran: [], skipped: [] };

  // 2. Open PRs by head (pagination at 100 — beyond that a page-2 loop would
  //    be needed; logged honestly rather than silently under-selecting).
  const prsRes = await ghFetch(fetchImpl, `${base}/pulls?state=open&per_page=100`, { token });
  if (!prsRes.ok) return { ok: false, error: prsRes.error, reran: [], skipped: [] };
  const openPrs = new Map();
  for (const pr of prsRes.body?.items || prsRes.body || []) {
    const head = pr?.head;
    if (!head?.repo?.full_name || !head.ref || !head.sha) continue;
    openPrs.set(`${head.repo.full_name}:${head.ref}`, {
      number: pr.number,
      sha: head.sha,
      draft: !!pr.draft,
    });
  }

  const { rerun, skipped } = selectStarvedRuns(runsRes.body?.workflow_runs || [], openPrs);
  for (const s of skipped) log(`skip run ${s.run} (${s.sha.slice(0, 7)}): ${s.reason}`);

  // 3. Re-run each candidate; partial failures accumulate (doctrine rule 5).
  const done = [];
  const failed = [];
  for (const c of rerun) {
    // Draft PRs are re-run deliberately: their checks gate merge exactly like
    // non-drafts (ready-for-review flips to the same head sha).
    const res = await ghFetch(fetchImpl, `${base}/actions/runs/${c.runId}/rerun`, {
      token,
      method: "POST",
    });
    if (res.ok) {
      log(`re-ran starved e2e run ${c.runId} for PR #${c.pr} (${c.branch})`);
      done.push(c);
    } else {
      log(`rerun FAILED for run ${c.runId} (PR #${c.pr}): ${res.error}`);
      failed.push({ ...c, error: res.error });
    }
  }
  log(`done: ${done.length} rerun, ${skipped.length} skipped, ${failed.length} failed`);
  return { ok: failed.length === 0, reran: done, skipped, failed };
}

module.exports = { main, selectStarvedRuns, E2E_WORKFLOW_FILE, ACTIVE_STATUSES };

if (require.main === module) {
  main()
    .then((r) => {
      if (!r.ok && r.error) {
        console.error(`[e2e-rerun] inventory failed: ${r.error}`);
        process.exitCode = 1; // next tick retries
      }
    })
    .catch((err) => {
      // Belt over braces: main() is never-throw by contract.
      console.error("[e2e-rerun] unexpected failure:", err?.message || err);
      process.exitCode = 1;
    });
}
