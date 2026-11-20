const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadDb } = require("./helpers/env");

// Registry + feature requires open SQLite at load time.
// CONTRACT: loadDb() stays above every `src/` require (see
// test/command-visibility.test.js for the full rationale).
const { cleanup } = loadDb();

const { visibilityTier, TIERS } = require("../src/core/commandVisibility");

after(cleanup);

/**
 * #841 — AGENTS.md is the convention spec every contributor and audit
 * enforces against; when its enumerations drift from shipped code the next
 * tier refactor can "legitimately" re-open an admin surface believing AGENTS
 * defines it as ordinary staff. These pins make that drift CI-red instead of
 * audit-found: the two lists AGENTS.md states as fact (the boot Features
 * line, and the ManageGuild-only admin gate) must equal the code that
 * actually ships.
 */

const AGENTS_PATH = path.join(__dirname, "..", "AGENTS.md");
const agents = fs.readFileSync(AGENTS_PATH, "utf8");

describe("AGENTS.md truth: Features line == booted feature modules", () => {
  /** The comma list on the `**Features:**` line. */
  function agentsFeatures() {
    const m = agents.match(/^\*\*Features:\*\*\s*(.+)\s*$\r?$/m);
    assert.ok(m, "AGENTS.md must carry the **Features:** line");
    return m[1]
      .replace(/\.$/, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  it("lists exactly the modules src/features/index.js boots", () => {
    const bootOrder = require("../src/features/index.js");
    const booted = bootOrder.map((f) => f.name);
    assert.ok(booted.length >= 30, `expected the full boot list, got ${booted.length}`);

    const listed = agentsFeatures();
    const missing = booted.filter((n) => !listed.includes(n));
    const extra = listed.filter((n) => !booted.includes(n));
    assert.deepEqual(
      { missing, extra },
      { missing: [], extra: [] },
      "AGENTS.md Features line drifted from the boot list — sync the line " +
        "(missing = modules that boot but are unlisted; extra = retired names)",
    );
  });
});

describe("AGENTS.md truth: ManageGuild-only list == admin picker tier", () => {
  /** The admin-gate enumeration between its two bold labels. */
  function manageGuildOnlySegment() {
    const m = agents.match(
      /\*\*ManageGuild-only:\*\*\s*(.+?)\s*\*\*Slash picker visibility/,
    );
    assert.ok(m, "AGENTS.md must carry the **ManageGuild-only:** segment");
    return m[1];
  }

  let registeredNames;
  before(() => {
    const { buildDefaultRegistry } = require("../src/commands/registry");
    registeredNames = buildDefaultRegistry()
      .commands.map((c) => (typeof c.toJSON === "function" ? c.toJSON() : c))
      .map((c) => c.name);
  });

  it("names every admin-tier command AND context menu (audit r3, #841)", () => {
    const adminNames = registeredNames.filter((n) => visibilityTier(n) === TIERS.admin);
    assert.ok(adminNames.length >= 8, `sanity: expected the admin surface, got ${adminNames}`);

    const segment = manageGuildOnlySegment();
    const uncovered = adminNames.filter((name) => {
      if (/^[a-z]/.test(name)) {
        // slash command: must appear as /name with a word boundary (so
        // `/ban` is not satisfied by `/bannotify`)
        const re = new RegExp(`/${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![a-z0-9-])`);
        return !re.test(segment);
      }
      // context menu (caps/spaces): literal display name
      return !segment.includes(name);
    });
    assert.deepEqual(
      uncovered,
      [],
      "every admin picker-tier command must be enumerated in the AGENTS.md " +
        "ManageGuild-only list (picker + handler ManageGuild): " +
        uncovered.join(", "),
    );
  });

  it("does not list a command whose picker tier is not admin", () => {
    // Opportunistic reverse guard for the top-level slash names the segment
    // claims verbatim: a name that later LEFT the admin tier must drop out.
    // Subcommand-scoped claims are legitimately staff-tier at the PICKER
    // while being ManageGuild in the handler for specific subcommands:
    // `/honeypot exempt` + `/honeypot safety resume` (top level rides staff).
    const SUBCOMMAND_ONLY_CLAIMS = new Set(["honeypot"]);
    const segment = manageGuildOnlySegment();
    const claims = [...segment.matchAll(/\/([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    const known = new Set(registeredNames);
    const stale = claims.filter(
      (n) =>
        known.has(n) &&
        !SUBCOMMAND_ONLY_CLAIMS.has(n) &&
        visibilityTier(n) !== TIERS.admin,
    );
    assert.deepEqual(
      stale,
      [],
      `AGENTS.md lists ${stale.join(", ")} as ManageGuild-only but the picker tier says otherwise — reconcile`,
    );
  });
});
