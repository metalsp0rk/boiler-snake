/**
 * Signup-option helpers for community events (epic #218).
 *
 * Options are ordered rows (1..MAX_OPTIONS_PER_EVENT) per event. This module
 * is the CLI-facing glue: index/name resolution, bulk replace (create/edit/
 * preset apply), reorder, and the per-option count/attendee bundles the ui
 * builders expect. DB truth lives in src/db/repositories/events.js.
 */
const repo = require("../../db/repositories/events");

/**
 * Counts per option for one event: { [optionId]: {signedUp, waitlisted} }.
 * @param {number} eventId
 */
function countsFor(eventId) {
  const rows = repo.listEventSignups(eventId, {});
  const out = {};
  for (const row of rows) {
    const c = (out[row.option_id] ||= { signedUp: 0, waitlisted: 0 });
    if (row.state === "signed_up") c.signedUp += 1;
    else if (row.state === "waitlisted") c.waitlisted += 1;
  }
  return out;
}

/**
 * Options for an event with `_attendees` (ordered user ids, attending only)
 * preloaded — the shape `ui.buildEventMessage` renders.
 * @param {number} eventId
 */
function optionsWithAttendees(eventId) {
  const options = repo.listEventOptions(eventId);
  const rows = repo.listEventSignups(eventId, { state: "signed_up" });
  const byOption = new Map();
  for (const r of rows) {
    if (!byOption.has(r.option_id)) byOption.set(r.option_id, []);
    byOption.get(r.option_id).push(r.user_id);
  }
  for (const opt of options) opt._attendees = byOption.get(opt.id) || [];
  return options;
}

/** Resolve an option by `id` or 1-based position within one event. */
function resolveOption(eventId, ref) {
  if (ref == null) return null;
  const options = repo.listEventOptions(eventId);
  const asNum = Number(ref);
  if (Number.isInteger(asNum)) {
    const byId = options.find((o) => o.id === asNum);
    if (byId) return byId;
    const byPos = options.find((o) => o.position === asNum);
    if (byPos) return byPos;
  }
  const text = String(ref).trim().toLowerCase();
  return options.find((o) => o.label.toLowerCase() === text) || null;
}

/**
 * Replace every option of an event atomically (create/edit/preset apply).
 * Existing signups are refused on by the caller when signups exist; here we
 * just swap rows.
 * @param {number} eventId
 * @param {Array<{label:string, emoji?:string|null, capacity?:number,
 *   waitlist_on?:boolean, reminders_on?:boolean, role_whitelist?:string|null}>} specs
 */
function replaceOptions(eventId, specs) {
  const existing = repo.listEventOptions(eventId);
  const signups = repo.countEventSignups(eventId);
  // countEventSignups groups by option id with CAMELCASE counters — the
  // old snake_case read here made hasSignups structurally false, so the
  // "one at a time while people signed up" guard NEVER fired (found while
  // test-pinning #400/B2-8; the guard protects exactly the swap this fix
  // makes atomic). Accept both shapes so the gate is honest either way.
  const hasSignups = Object.values(signups).some(
    (g) => (g?.signedUp ?? g?.signed_up ?? 0) + (g?.waitlisted ?? 0) > 0
  );
  if (hasSignups && existing.length !== specs.length) {
    // Keep option ids stable for existing rows when the count matches;
    // changing the SET of options while people signed up needs a manual
    // remove/add (options remove/add), never a silent swap.
    return {
      ok: false,
      error:
        "This event already has signups — change options one at a time with `/eventsignup options add|edit|remove`.",
    };
  }
  if (specs.length > repo.MAX_OPTIONS_PER_EVENT) {
    return { ok: false, error: `At most ${repo.MAX_OPTIONS_PER_EVENT} options.` };
  }
  try {
    // #400 (B2-8): the swap is ONE repo transaction. The loop this replaces
    // committed each delete immediately, so a rejected/failed insert mid-way
    // returned AFTER the deletes were durable — a posted event with zero
    // signup options and a message full of dead buttons.
    return repo.replaceEventOptions(eventId, specs);
  } catch (err) {
    return { ok: false, error: `Could not replace options: ${err?.message || err}` };
  }
}

/**
 * Reorder options by the comma-separated ids/positions in `orderText`
 * (e.g. "3,1,2"). Anything unlisted keeps its relative order at the end.
 */
function reorder(eventId, orderText) {
  const options = repo.listEventOptions(eventId);
  const wanted = String(orderText || "")
    .split(/[,\s]+/)
    .map((t) => resolveOption(eventId, t))
    .filter(Boolean);
  const ordered = [...wanted];
  for (const opt of options) {
    if (!ordered.some((o) => o.id === opt.id)) ordered.push(opt);
  }
  try {
    const options = repo.reorderEventOptions(
      eventId,
      ordered.map((o) => o.id)
    );
    return { ok: true, options };
  } catch (err) {
    return { ok: false, error: `Could not reorder options: ${err?.message || err}` };
  }
}

/** Plain-text option table for /eventsignup options list. */
function renderOptionTable(eventId) {
  const options = repo.listEventOptions(eventId);
  if (!options.length) return "_No options yet._";
  const counts = countsFor(eventId);
  return options
    .map((o) => {
      const c = counts[o.id] || { signedUp: 0, waitlisted: 0 };
      const bits = [`id \`${o.id}\``, `pos ${o.position}`];
      if (o.capacity > 0) bits.push(`cap ${o.capacity}`);
      if (o.waitlist_on === 0) bits.push("no waitlist");
      if (o.reminders_on === 0) bits.push("no reminders");
      // #344: listEventOptions parses the JSON — [] (open) was TRUTHY and
      // every row claimed "role-gated". Length is the honest test.
      if (o.role_whitelist.length > 0) bits.push("role-gated");
      return `**${o.position}. ${o.emoji ? `${o.emoji} ` : ""}${o.label}** — ${c.signedUp}${
        o.capacity ? `/${o.capacity}` : ""
      }${c.waitlisted ? ` (waitlist ${c.waitlisted})` : ""} · ${bits.join(", ")}`;
    })
    .join("\n");
}

module.exports = {
  countsFor,
  optionsWithAttendees,
  resolveOption,
  replaceOptions,
  reorder,
  renderOptionTable,
};
