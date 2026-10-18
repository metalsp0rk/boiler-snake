/**
 * #476 (F2-8): the /staff PICKER is admin-tier (most subcommands are
 * ManageGuild mutations), so the staff-gated list/settings subcommands are
 * admin-visible only. The old reply copy — "any role in /staff role list" —
 * sent staff members WITHOUT Manage Server to a command Discord hides from
 * them: the handler allows more than the picker exposes, and the copy
 * promised access that does not exist.
 *
 * The fix is honest copy, not a tier flip (handlers stay the security
 * truth; a staff-tier split needs live picker verification — follow-up
 * issue). This suite pins the alignment so a regression cannot silently
 * return:
 *  - /staff stays the admin tier (the picker truth the copy describes);
 *  - the dead-end pointer form ("any role in `/staff role list`") is gone
 *    from every user-facing copy string in src;
 *  - both staff-facing settings replies carry the honest qualifier;
 *  - the docs note exists where staff readers are pointed at the gate.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { visibilityTier } = require("../src/core/commandVisibility");

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
