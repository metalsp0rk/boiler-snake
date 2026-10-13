/**
 * Attendee-role management for bot-owned events (E6/E14, phases 1+3).
 *
 * Modes (events.role_mode):
 *   temp     — a per-event `event-<slug>` role created at post; membership is
 *              the reminder audience, and the reminder ping is that ONE role
 *              mention (feature-2 parity row: "ping a role, not user lists").
 *   existing — the organizer picked a guild role; membership is reconciled
 *              with a refcount: remove only when the member holds no
 *              remaining attending signup on ANY event mapping to that role.
 *   none     — no role; reminders fall back to an un-mentioned message.
 *
 * Every Discord failure names the role and the Discord error (AGENTS.md);
 * the event stays posted — roles degrade, they never block RSVP.
 */
const { EVENT_ROLE_PREFIX } = require("../../db/repositories/events");
const { getCommunityById } = require("../../platform/community");

function logWarn(event, what, err) {
  console.warn(
    `[events] ${what} guild=${event.community_id} event=${event.id}:`,
    err?.message || err,
  );
}

function slugify(title) {
  return String(title || "event")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "event";
}

/** A free `event-<slug>[-N]` name in this guild. */
function uniqueRoleName(guild, title) {
  const base = `${EVENT_ROLE_PREFIX}${slugify(title)}`.slice(0, 90);
  if (!guild.roles.cache.some((r) => r.name.toLowerCase() === base.toLowerCase()))
    return base;
  for (let i = 2; i <= 99; i++) {
    const name = `${base}-${i}`;
    if (!guild.roles.cache.some((r) => r.name.toLowerCase() === name.toLowerCase()))
      return name;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

async function findRole(guild, roleId) {
  if (!roleId) return null;
  const cached = guild.roles.cache.get(String(roleId));
  if (cached) return cached;
  try {
    return await guild.roles.fetch(String(roleId));
  } catch (err) {
    logWarn({ community_id: guild.id, id: 0 }, `role fetch ${roleId}`, err);
    return null;
  }
}

/**
 * Ensure the event has its attendee role. Never throws.
 * @returns {Promise<{ok:true, role: object|null}|{ok:false, error: string}>}
 */
async function ensureEventAttendeeRole(guild, event, reason = "Community event") {
  if (event.role_mode === "none") return { ok: true, role: null };

  if (event.role_mode === "existing") {
    const role = await findRole(guild, event.attendee_role_id);
    if (!role) {
      return {
        ok: false,
        error: `the existing attendee role <@&${event.attendee_role_id}> was not found — pick another with \`/event edit\`.`,
      };
    }
    if (!role.editable) {
      // grant still works if we hold Assign Roles for non-managed roles;
      // position is validated at grant time per member.
    }
    return { ok: true, role };
  }

  // temp mode: reuse the stored role when it still exists
  const existing = await findRole(guild, event.attendee_role_id);
  if (existing) return { ok: true, role: existing };

  try {
    const role = await guild.roles.create({
      name: uniqueRoleName(guild, event.title),
      reason,
      hoist: false,
      mentionable: false,
      permissions: [],
    });
    return { ok: true, role };
  } catch (err) {
    const msg = err?.message || String(err);
    return {
      ok: false,
      error:
        `could not create the attendee role (bot needs **Manage Roles** and a role position above what it manages): \`${msg}\``,
    };
  }
}

/** Delete a TEMP role (existing roles are only de-synced, never deleted). */
async function deleteEventRoleSafe(guild, event) {
  if (event.role_mode !== "temp" || !event.attendee_role_id) return;
  const role = await findRole(guild, event.attendee_role_id);
  if (!role) return;
  try {
    await role.delete(`event removed: ${event.title}`);
  } catch (err) {
    logWarn(event, `role delete ${role.name} (${role.id})`, err);
  }
}

async function memberOrNull(guild, userId) {
  const id = String(userId);
  const cached = guild.members.cache.get(id);
  if (cached) return cached;
  try {
    return await guild.members.fetch(id);
  } catch {
    return null; // left the guild — nothing to sync
  }
}

/**
 * Add/remove one member from the event's attendee role according to whether
 * their CURRENT signup state qualifies (E6) and they are not blocked.
 *
 * @param {object} args
 * @param {boolean} args.qualifies  service-computed: attending AND not opted
 *        out AND not muted (AND, for existing roles, refcount kept by caller)
 */
async function syncMemberRole(guild, event, userId, qualifies, reason = "Event signup") {
  const roleId = event.attendee_role_id;
  if (!roleId) return { ok: true };
  const role = await findRole(guild, roleId);
  if (!role) {
    const error = `attendee role <@&${roleId}> missing`;
    logWarn(event, "sync role", error);
    return { ok: false, error };
  }
  const member = await memberOrNull(guild, userId);
  if (!member) return { ok: true };
  const has = member.roles.cache.has(String(roleId));
  try {
    if (qualifies && !has) await member.roles.add(String(roleId), reason);
    else if (!qualifies && has) await member.roles.remove(String(roleId), reason);
    return { ok: true };
  } catch (err) {
    const error = `role **${role.name}**: ${err?.message || err}`;
    logWarn(event, `role sync user=${userId}`, err);
    return { ok: false, error };
  }
}

/**
 * Full audience sync for an event (post / mute / opt-out / setting changes).
 * @param {(userId: string) => boolean} isBlocked
 */
async function syncAudienceRole(guild, event, isBlocked) {
  const db = require("../../db");
  const roleId = event.attendee_role_id;
  if (!roleId) return { granted: 0, removed: 0, errors: [] };
  const role = await findRole(guild, roleId);
  if (!role)
    return { granted: 0, removed: 0, errors: [`attendee role <@&${roleId}> missing`] };

  const audience = new Set(
    db
      .listEventAttendingUserIds(event.id)
      .filter((uid) => !isBlocked(uid))
      .map(String),
  );
  const errors = [];
  let granted = 0;
  let removed = 0;

  // grant audience members missing the role
  for (const uid of audience) {
    const member = await memberOrNull(guild, uid);
    if (!member) continue;
    if (member.roles.cache.has(String(roleId))) continue;
    try {
      await member.roles.add(String(roleId), "Event attendee");
      granted += 1;
    } catch (err) {
      errors.push(`grant <@${uid}> role **${role.name}**: ${err?.message || err}`);
      console.warn(
        `[events] role grant failed guild=${event.community_id} event=${event.id} user=${uid} role=${role.name}:`,
        err?.message || err,
      );
    }
  }

  // remove the role from holders no longer in the audience — for EXISTING
  // roles honour the refcount: keep if another event still qualifies them.
  const communityId = event.community_id;
  for (const [memberId] of role.members || []) {
    if (audience.has(String(memberId))) continue;
    let keep = false;
    if (event.role_mode === "existing") {
      try {
        const stillHeld = db
          .listEventRoleIdsUserStillHolds(communityId, memberId)
          .map(String)
          .includes(String(roleId));
        keep = stillHeld;
      } catch {
        keep = true; // uncertain → keep (safer than a wrongful removal)
      }
    }
    if (keep) continue;
    try {
      let member = role.members.get?.(memberId) ?? null;
      if (!member) member = await memberOrNull(guild, memberId);
      if (member?.roles?.cache?.has(String(roleId))) {
        await member.roles.remove(String(roleId), "Event attendee removed");
        removed += 1;
      }
    } catch (err) {
      errors.push(`remove <@${memberId}> role **${role.name}**: ${err?.message || err}`);
      console.warn(
        `[events] role removal failed guild=${event.community_id} event=${event.id} user=${memberId} role=${role.name}:`,
        err?.message || err,
      );
    }
  }
  return { granted, removed, errors };
}

/** Remove the member from ALL event attendee roles of this community they no
 *  longer qualify for (opt-out switch, leaving, role-mode change). */
async function reconcileForMember(guild, communityId, userId) {
  const db = require("../../db");
  const still = new Set(
    db.listEventRoleIdsUserStillHolds(communityId, userId).map(String),
  );
  const blocked = db.isEventReminderOptedOut(communityId, String(userId));
  const errors = [];
  for (const row of db.listEvents(communityId, { statuses: ["posted"] })) {
    const roleId = row.attendee_role_id;
    if (!roleId) continue;
    const shouldHave =
      !blocked &&
      still.has(String(roleId)) &&
      db.listEventUserSignups(row.id, String(userId)).some(
        (s) =>
          s.state === "signed_up" &&
          db.getEventOptionById(s.option_id)?.reminders_on === 1 &&
          !db.isEventMuted(communityId, row.id, String(userId)),
      );
    const res = await syncMemberRole(guild, row, userId, shouldHave, "Event role reconcile");
    if (!res.ok) errors.push(res.error);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  slugify,
  uniqueRoleName,
  findRole,
  ensureEventAttendeeRole,
  deleteEventRoleSafe,
  syncMemberRole,
  syncAudienceRole,
  reconcileForMember,
  memberOrNull,
  getCommunityById,
};
