/**
 * #476 (F2-8) + #599: the /staff PICKER is admin-tier (most subcommands are
 * ManageGuild mutations), so the list/settings subcommands UNDER /staff are
 * admin-visible only. The old reply copy — "any role in /staff role list" —
 * sent staff members WITHOUT Manage Server to a command Discord hides from
 * them: the handler allows more than the picker exposes, and the copy
 * promised access that does not exist.
 *
 * #476 paid honest copy, not a tier flip. #599 then made a REAL staff-visible
 * read path: `/staffsettings` (roles | overview) registers at TIERS.staff, so
 * the existing staff-tier machinery (ManageGuild default + staff_roles allow
 * overwrites via `/staff syncpermissions`, #356) reaches the read views
 * without exposing any /staff mutation. Handlers stay the security truth.
 * This suite pins the combined reality so neither half can regress silently:
 *  - /staff stays the admin tier (the picker truth the copy describes);
 *  - /staffsettings is REALLY staff tier: registered, tier-mapped, synced,
 *    and its builder carries the staff-tier ManageGuild default posture —
 *    the honest target for staff-facing pointers;
 *  - the dead-end pointer form ("any role in `/staff role list`") is gone
 *    from every user-facing copy string in src;
 *  - both staff-facing settings replies carry the honest qualifier AND the
 *    pointer to the staff-visible read view;
 *  - the docs note exists where staff readers are pointed at the gate.
 *
 * What stays owed OUTSIDE this suite: the live Discord check that a synced
 * staff role actually SEES /staffsettings in its picker (the issue records
 * it) — these tests pin the registration truth, not Discord's UI.
 */
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadDb } = require("./helpers/env");

// The registry require inside the tier-wiring test opens SQLite at load time
// (feature modules import the db facade). CONTRACT: loadDb() must stay above
// every `src/` require in this file — it points this process at a private
// temp DB (fresh DB_PATH + src require-cache reset) before those requires
// load, so this process never races the project-root default (xpbot.sqlite)
// against the other test files that node --test runs in parallel.
const { cleanup } = loadDb();

const {
  visibilityTier,
  isStaffSyncCommand,
  staffSyncCommandNames,
} = require("../src/core/commandVisibility");

// Closes the tracked DB handles and removes the temp dir (idempotent,
// never throws).
after(cleanup);

const SRC = path.join(__dirname, "..", "src");

function*walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith(".js")) yield p;
  }
}

describe("/staff picker truth vs the copy that points at it (#476)", () => {
  it("the picker tier the copy describes is the REAL tier", () => {
    // #599 did NOT flip /staff: its mutations (role add/remove/setlevel,
    // syncpermissions) are ManageGuild-gated, so the admin-tier picker —
    // and the copy describing it — stay.
    assert.equal(visibilityTier("staff"), "admin");
  });

  it("no user-facing copy sends readers to a command the admin picker hides", () => {
    const DEAD_END = /any role in \\?`\/staff role list\\?`/;
    const offenders = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      if (DEAD_END.test(text)) offenders.push(path.relative(SRC, file));
    }
    assert.deepEqual(
      offenders,
      [],
      "staff-gate copy may not promise `/staff role list` to non-admins — #476"
    );
  });

  it("the two staff-facing settings replies carry the honest qualifier", () => {
    for (const rel of ["features/warnings/handlers.js", "features/staffNotes/index.js"]) {
      const text = fs.readFileSync(path.join(SRC, rel), "utf8");
      assert.ok(
        text.includes("**Access:** staff gate — Manage Server, or a staff role chosen by a Manage Server holder"),
        `${rel}: the re-pointed copy`,
      );
      assert.ok(
        text.includes("is only shown to Manage Server holders"),
        `${rel}: the picker truth rides the same line`,
      );
    }
  });

  it("the staff-notes doc tells staff readers about the picker reality", () => {
    const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "staff-notes.md"), "utf8");
    assert.match(doc, /shown only to `Manage Server` holders/);
  });
});

describe("/staffsettings is the REAL staff-visible read path (#599)", () => {
  it("tier-mapped staff, synced, and NOT a copy dead-end under /staff", () => {
    // Staff tier ⇒ picker: ManageGuild default + staff_roles allow overwrites
    // after `/staff syncpermissions` (the #356 machinery).
    assert.equal(visibilityTier("staffsettings"), "staff");
    assert.equal(isStaffSyncCommand("staffsettings"), true);
    assert.ok(staffSyncCommandNames().includes("staffsettings"));
    // /staffsettings REPLACES dead-end pointers; it does not license promising
    // /staff's admin-tier subcommands to staff.
    assert.equal(visibilityTier("staff"), "admin");
  });

  it("the registered builder carries the staff-tier posture", () => {
    const { buildDefaultRegistry } = require("../src/commands/registry");
    const registry = buildDefaultRegistry();
    const cmd = registry.commands.find((c) => c.name === "staffsettings");
    assert.ok(cmd, "/staffsettings is registered");
    // Same posture command-visibility.test.js asserts for every staff/admin
    // tier: a non-null ManageGuild default_member_permissions.
    assert.ok(
      cmd.default_member_permissions != null &&
        cmd.default_member_permissions !== "0",
      "staff-tier builders set ManageGuild defaultMemberPermissions",
    );
    assert.equal(
      registry.getHandlerApi("staffsettings"),
      "context",
      "the handler rides the CommandContext arm (parity with /staff)",
    );
    assert.equal(typeof registry.getHandler("staffsettings"), "function");
  });

  it("staff-facing copy points at the staff-visible read view", () => {
    // The #476 qualifier lines stay (see the suite above); #599 adds the
    // honest counter-weight: readers learn a staff-tier view EXISTS.
    // Asserted against source text, so match the human words only — the
    // backticks around the command name are template-literal-escaped there.
    for (const rel of ["features/warnings/handlers.js", "features/staffNotes/index.js"]) {
      const text = fs.readFileSync(path.join(SRC, rel), "utf8");
      assert.ok(
        text.includes("staff-visible read view") && text.includes("/staffsettings"),
        `${rel}: the /staffsettings pointer (#599)`,
      );
    }
    const doc = fs.readFileSync(path.join(__dirname, "..", "docs", "staff-notes.md"), "utf8");
    assert.ok(
      doc.includes("/staffsettings"),
      "docs/staff-notes.md: staff readers get the same pointer",
    );
  });
});
