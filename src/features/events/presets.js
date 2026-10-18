/**
 * Signup presets for community events (epic #218, phase 3).
 *
 * A preset is a named, reusable SET of signup options per community
 * (Apollo's "signup templates"). Applying a preset replaces an event's
 * option set — refused while signups exist (options.replaceOptions guards).
 */
const repo = require("../../db/repositories/events");
const options = require("./options");
const { DEFAULT_OPTIONS } = require("./ui");

/**
 * #344 (same class as the handlers' options arms): the repo's toJsonArray
 * stringifies ARRAYS but maps non-arrays — including pre-stringified JSON —
 * to "[]". A stringified whitelist here therefore silently DELETED every
 * gate when a preset was applied or used at create time. Specs carry real
 * arrays; strings (legacy blobs / stored column form) are parsed, junk is [].
 */
function normalizeWhitelist(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const v = JSON.parse(value);
      if (Array.isArray(v)) return v.map(String);
    } catch {
      // fall through — a non-JSON string carries no whitelist
    }
  }
  return [];
}

/** Preset options (DB rows 0/1 or ui DEFAULT_OPTIONS booleans) → specs. */
function toSpecs(presetOptions = []) {
  return presetOptions.map((o) => ({
    label: o.label,
    emoji: o.emoji ?? null,
    capacity: o.capacity ?? 0,
    waitlist_on: o.waitlist_on !== 0 && o.waitlist_on !== false,
    reminders_on: o.reminders_on === 1 || o.reminders_on === true,
    role_whitelist: normalizeWhitelist(o.role_whitelist),
  }));
}

/**
 * Save an event's current options as a preset (replaces an existing preset
 * of the same name — Apollo does the same and it keeps the list tidy).
 */
function save(communityId, name, eventId, createdBy = null) {
  const clean = String(name || "").trim();
  if (!clean) return { ok: false, error: "A preset name is required." };
  const event = repo.getEventById(eventId);
  if (!event || event.community_id !== communityId) {
    return { ok: false, error: `No event **${eventId}** in this server.` };
  }
  const opts = repo.listEventOptions(eventId);
  if (!opts.length) return { ok: false, error: "That event has no options to save." };
  const specs = opts.map((o) => ({
    label: o.label,
    emoji: o.emoji,
    capacity: o.capacity,
    waitlist_on: o.waitlist_on !== 0,
    reminders_on: o.reminders_on === 1,
    role_whitelist: o.role_whitelist,
  }));
  const existing = repo.getEventPresetByName(communityId, clean);
  if (existing) repo.deleteEventPreset(existing.id);
  return repo.createEventPreset(communityId, clean, specs, createdBy);
}

/** Apply a preset to an event (replace options). */
function applyToEvent(communityId, name, eventId) {
  const preset = repo.getEventPresetByName(communityId, String(name || "").trim());
  if (!preset) {
    return {
      ok: false,
      error: `No preset **${name}** here. See \`/eventsignup preset list\`.`,
    };
  }
  return options.replaceOptions(eventId, toSpecs(preset.options));
}

/** Default Yes/No/Maybe specs used when no preset is given on create. */
function defaultSpecs() {
  return toSpecs(DEFAULT_OPTIONS);
}

function list(communityId) {
  return repo.listEventPresets(communityId);
}

function remove(communityId, name) {
  const preset = repo.getEventPresetByName(communityId, String(name || "").trim());
  if (!preset) return { ok: false, error: `No preset **${name}** here.` };
  return repo.deleteEventPreset(preset.id);
}

module.exports = { save, applyToEvent, defaultSpecs, list, remove, toSpecs };
