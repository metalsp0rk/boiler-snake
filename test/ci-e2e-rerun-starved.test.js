/**
 * #506 (option 2): the e2e auto-rerun decision core + wiring. No network:
 * fetch is injected; scenarios are built from synthetic run/PR fixtures in
 * the shapes the Actions REST endpoints return.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  main,
  selectStarvedRuns,
  E2E_WORKFLOW_FILE,
} = require("../scripts/ci/e2e-rerun-starved");

const run = (o) => ({
  id: o.id,
  run_number: o.n,
  head_sha: o.sha,
  head_branch: o.branch,
  head_repository: { full_name: o.repo || "metalsp0rk/boiler-snake" },
  status: o.status || "completed",
  conclusion: o.conclusion ?? null,
});

const prs = (...entries) =>
  new Map(
    entries.map(([key, number, sha, draft]) => [key, { number, sha, draft: !!draft }]),
  );

describe("#506 selectStarvedRuns: the starvation decision", () => {
  it("a cancelled latest run whose PR head still matches → rerun candidate", () => {
    const runs = [run({ id: 11, n: 5, sha: "aaa", branch: "fix/a", conclusion: "cancelled" })];
    const { rerun, skipped } = selectStarvedRuns(
      runs,
      prs(["metalsp0rk/boiler-snake:fix/a", 41, "aaa"]),
    );
    assert.deepEqual(rerun, [
      { runId: 11, pr: 41, sha: "aaa", branch: "fix/a" },
    ]);
    assert.equal(skipped.length, 0);
  });

  it("a PR whose head MOVED is NOT rerun (the newer sha owns the slot now)", () => {
    const runs = [run({ id: 12, n: 6, sha: "old", branch: "fix/b", conclusion: "cancelled" })];
    const { rerun, skipped } = selectStarvedRuns(
      runs,
      prs(["metalsp0rk/boiler-snake:fix/b", 42, "new"]),
    );
    assert.equal(rerun.length, 0);
    assert.match(skipped[0].reason, /head moved/);
  });

  it("a queued/running run for the same sha means the slot is already taken", () => {
    const runs = [
      run({ id: 13, n: 7, sha: "ccc", branch: "fix/c", conclusion: "cancelled" }),
      run({ id: 14, n: 8, sha: "ccc", branch: "fix/c", status: "queued" }),
    ];
    const { rerun, skipped } = selectStarvedRuns(
      runs,
      prs(["metalsp0rk/boiler-snake:fix/c", 43, "ccc"]),
    );
    assert.equal(rerun.length, 0);
    assert.match(skipped[0].reason, /still active/);
  });

  it("runs whose latest attempt is success/failure are none of our business", () => {
    const runs = [
      run({ id: 15, n: 9, sha: "ddd", branch: "fix/d", conclusion: "success" }),
      run({ id: 16, n: 10, sha: "eee", branch: "fix/e", conclusion: "failure" }),
    ];
    const { rerun, skipped } = selectStarvedRuns(
      runs,
      prs(
        ["metalsp0rk/boiler-snake:fix/d", 44, "ddd"],
        ["metalsp0rk/boiler-snake:fix/e", 45, "eee"],
      ),
    );
    assert.equal(rerun.length + skipped.length, 0, "healthy runs never appear");
  });

  it("a cancelled run for a CLOSED PR (no open head) is left dead", () => {
    const runs = [run({ id: 17, n: 11, sha: "fff", branch: "done/f", conclusion: "cancelled" })];
    const { rerun, skipped } = selectStarvedRuns(runs, prs());
    assert.equal(rerun.length, 0);
    assert.match(skipped[0].reason, /no open PR/);
  });

  it("the highest run_number is the 'latest' for a sha", () => {
    const runs = [
      run({ id: 18, n: 3, sha: "ggg", branch: "fix/g", conclusion: "cancelled" }),
      run({ id: 19, n: 9, sha: "ggg", branch: "fix/g", conclusion: "success" }),
    ];
    const { rerun } = selectStarvedRuns(
      runs,
      prs(["metalsp0rk/boiler-snake:fix/g", 47, "ggg"]),
    );
    assert.equal(rerun.length, 0, "the newest attempt passed — nothing starved");
  });
});

describe("#506 main: wiring", () => {
  const env = {
    E2E_RERUN_PAT: "tok",
    GITHUB_REPOSITORY: "metalsp0rk/boiler-snake",
    GITHUB_API_URL: "https://api.example.test",
  };

  function fakeFetch(routes) {
    const calls = [];
    const fn = async (url, opts = {}) => {
      calls.push({ url, method: opts.method || "GET" });
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) return { ok: false, status: 404, text: async () => "not routed" };
      const r = routes[key];
      return {
        ok: r.ok ?? true,
        status: r.status ?? 200,
        text: async () => JSON.stringify(r.body ?? null),
      };
    };
    fn.calls = calls;
    return fn;
  }

  it("missing PAT: honest disabled log, exit ok, zero API calls", async () => {
    const logs = [];
    const f = fakeFetch({});
    const r = await main({
      env: { GITHUB_REPOSITORY: "x/y" },
      fetchImpl: f,
      log: (m) => logs.push(m),
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, "disabled");
    assert.equal(f.calls.length, 0, "no network without a token");
    assert.ok(logs.some((l) => l.includes("E2E_RERUN_PAT")));
  });

  it("starved PR → exactly one rerun POST to its run id", async () => {
    const f = fakeFetch({
      [`actions/workflows/${E2E_WORKFLOW_FILE}/runs`]: {
        body: {
          workflow_runs: [
            run({ id: 900, n: 4, sha: "sha1", branch: "feat/x", conclusion: "cancelled" }),
          ],
        },
      },
      "pulls?state=open": {
        body: [
          {
            number: 60,
            head: {
              sha: "sha1",
              ref: "feat/x",
              repo: { full_name: "metalsp0rk/boiler-snake" },
            },
          },
        ],
      },
      "actions/runs/900/rerun": { body: null },
    });
    const r = await main({ env, fetchImpl: f, log: () => {} });
    assert.equal(r.ok, true);
    assert.deepEqual(r.reran.map((c) => c.runId), [900]);
    const post = f.calls.find((c) => c.method === "POST");
    assert.ok(post && post.url.endsWith("/actions/runs/900/rerun"));
  });

  it("rerun 403 is reported per-item, others continue (partial results)", async () => {
    const f = fakeFetch({
      [`actions/workflows/${E2E_WORKFLOW_FILE}/runs`]: {
        body: {
          workflow_runs: [
            run({ id: 901, n: 1, sha: "s1", branch: "a/one", conclusion: "cancelled" }),
            run({ id: 902, n: 2, sha: "s2", branch: "a/two", conclusion: "cancelled" }),
          ],
        },
      },
      "pulls?state=open": {
        body: [
          {
            number: 71,
            head: { sha: "s1", ref: "a/one", repo: { full_name: "metalsp0rk/boiler-snake" } },
          },
          {
            number: 72,
            head: { sha: "s2", ref: "a/two", repo: { full_name: "metalsp0rk/boiler-snake" } },
          },
        ],
      },
      "actions/runs/901/rerun": { ok: false, status: 403, body: { message: "Forbidden" } },
      "actions/runs/902/rerun": { body: null },
    });
    const r = await main({ env, fetchImpl: f, log: () => {} });
    assert.equal(r.ok, false, "a partial failure is not a silent success");
    assert.deepEqual(r.failed.map((x) => x.runId), [901]);
    assert.deepEqual(r.reran.map((x) => x.runId), [902], "the healthy item still landed");
    assert.match(r.failed[0].error, /403/);
  });

  it("inventory failure (runs list down) → ok:false with the specific error", async () => {
    const f = fakeFetch({
      [`actions/workflows/${E2E_WORKFLOW_FILE}/runs`]: {
        ok: false,
        status: 502,
        body: { message: "bad gateway" },
      },
    });
    const r = await main({ env, fetchImpl: f, log: () => {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 502/);
  });
});
