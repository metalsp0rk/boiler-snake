"use strict";

/**
 * Drift gate (#712): every identifier or type="search" input in src/web/views
 * carries a live data-lookup wiring. The pre-rework pattern (a bare search
 * box) fails this check — that fixture stays in the test so the gate cannot
 * be "fixed" by deleting the assertion.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const VIEWS = path.join(__dirname, "..", "src/web/views");

/** Inputs that name a person, role, or channel, or that are search boxes. */
const IDENTIFIER_NAME = /name="(?:user_id|role_id|channel_id|attendee_role_id)"/;

function inputTags(source) {
  return source.match(/<input\b[\s\S]*?>/g) || [];
}

/**
 * @param {string} source view source (templates, not rendered HTML)
 * @returns {string[]} tags that should be lookups but are not wired
 */
function unwiredLookups(source) {
  // The lookup wiring is emitted by views/_helpers#lookupAttrs(Mixed); a view
  // may hold the bundle in a local (e.g. tickets' `${lookupAttrs}` const), so
  // interpolation counts as wiring when the file imports the helpers module.
  const fileHasHelper = /require\("[^"]*_helpers[^"]*"\)/.test(source);
  const problems = [];
  for (const tag of inputTags(source)) {
    if (/type="hidden"/.test(tag) || /type="number"/.test(tag) || /type="checkbox"/.test(tag)) continue;
    const search = /type="search"/.test(tag);
    const identifier = IDENTIFIER_NAME.test(tag);
    const lookup = /data-lookup\s*=/.test(tag);
    if (!search && !identifier && !lookup) continue;
    // Wired markup comes from either the local `${lookupAttrs}` variable or
    // the single-source bundle emitter views/_helpers.js#lookupAttrs(Mixed).
    const interpolated =
      (/\$\{lookupAttrs\}/.test(tag) && fileHasHelper) ||
      /\$\{lookupAttrs(?:Mixed)?\s*\(/.test(tag);
    if (interpolated) continue;
    if (!lookup) {
      problems.push(tag.replace(/\s+/g, " ").slice(0, 180));
      continue;
    }
    const mode = /data-lookup="([^"]+)"/.exec(tag);
    const kind = mode ? mode[1] : "";
    if (kind === "mixed") {
      if (!/data-lookup-users=/.test(tag) && !/data-lookup-roles=/.test(tag)) {
        problems.push(tag.replace(/\s+/g, " ").slice(0, 180));
      }
      continue;
    }
    if (!/data-lookup-url=/.test(tag)) {
      problems.push(tag.replace(/\s+/g, " ").slice(0, 180));
    }
  }
  return problems;
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("pre-rework search markup fails the lookup drift gate", () => {
  const legacy = `<form><input type="search" name="q" placeholder="search"></form>`;
  const problems = unwiredLookups(legacy);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /type="search"/);
});

test("pre-rework identifier field fails the lookup drift gate", () => {
  const legacy = `<label>User id <input name="user_id" maxlength="20"></label>`;
  assert.equal(unwiredLookups(legacy).length, 1);
});

test("a wired lookup with its url passes", () => {
  const ok = `<input type="search" name="q" data-lookup="users" data-lookup-url="/g/1/lookups/users">`;
  assert.deepEqual(unwiredLookups(ok), []);
});

test("every search and identifier input in src/web/views is wired", () => {
  const failures = [];
  for (const file of walk(VIEWS)) {
    const problems = unwiredLookups(fs.readFileSync(file, "utf8"));
    for (const problem of problems) {
      failures.push(`${path.relative(VIEWS, file)}: ${problem}`);
    }
  }
  assert.deepEqual(failures, []);
});
