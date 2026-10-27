/**
 * Auto-moderation case-context LOOKUP tools (#727, epic #723).
 *
 * Two READ-ONLY service functions the harness (#728) exposes to the model as
 * `read_warnings(user)` and `read_staff_notes(user)` — they exist so the
 * judge can inspect someone it is STARTING to consider inside a message
 * window WITHOUT preloading every bystander's private record into the prompt
 * (epic decision 5: lookups for "another user the model is actually
 * considering"; decision 4: bystanders get nothing preloaded).
 *
 * Contract (issue #727, verbatim law):
 *  - Read-only and ALWAYS available: there is deliberately NO mode flag and
 *    no settings/pause/master-switch gate here. These functions never read
 *    automod settings at all — an off/paused executor is irrelevant to
 *    reading (test-pinned). The gate on WRITING is the executor (#729), not
 *    this module.
 *  - GUILD-ISOLATED: a user with no guild member row in THIS guild is
 *    refused with a specific cause. Warnings and staff notes are
 *    community-scoped records; answering for a non-member (or from a stale
 *    cross-server memory) is exactly what guild isolation forbids.
 *  - Services never throw and never reply to Discord (AGENTS.md rule 6):
 *    every failure is `{ ok: false, error }` with the specific cause,
 *    logged `[automod]` with community/guild/user/actor ids (rule 2).
 *  - Nothing here writes. `createWarning` / `createStaffNote` are not even
 *    imported (the tests pin zero rows in `warnings` / `staff_notes` after
 *    every path).
 *
 * What each lookup returns — the JUDGMENT-COMPLETE set, matching what the
 * staff surfaces read:
 *  - warnings: every NON-VOIDED warning (active AND expired-but-not-yet-
 *    voided — `listWarnings` default; "active" in this repository means
 *    voided-not, and the auto-void ticker eventually voids expired rows).
 *    Voided warnings are WITHDRAWN records (`/warn void` marks them; the
 *    default `/warn list` view hides them too), so they are excluded — but
 *    `total_including_voided` still discloses that they exist. Rows carry
 *    `expires_at` so the judge sees expiry on its own.
 *  - staff notes: every LIVE note (soft-deleted/erased notes excluded — the
 *    default `/note list` / userinfo view; erased bodies are destroyed
 *    anyway). `total_including_deleted` discloses the tombstones.
 *
 * Privacy: note bodies and full warning history stay in harness + staff
 * channels. Nothing here composes ticket or warning-DM text; #735 must scrub
 * member-visible ticket text before quoting anything this module returned.
 */

const {
  listWarnings,
  countWarnings,
  listStaffNotes,
  countStaffNotes,
} = require("../../db");
const { discordCommunityId } = require("../../platform/community");
const { AUTOMOD_CONTEXT_RECORDS_PAGE_MAX } = require("./constants");

/** Model-facing tool names #728 should register (contract: read_warnings /
 *  read_staff_notes). */
const LOOKUP_TOOL_NAMES = Object.freeze({
  warnings: "read_warnings",
  notes: "read_staff_notes",
});

// ── small readers ──────────────────────────────────────────────────────────

/** Empty/whitespace → null (same trim-to-null idiom as refer/automodCases). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/** Integer columns → number|null without NaN leaking into the bundle. */
function optionalInt(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * One `warnings` row → plain JSON-able judgment data (snake_case, ids as
 * strings — the shared projector #727's bundle and both lookups emit the
 * SAME row shape so the harness learns one vocabulary).
 * @param {object} w
 */
function projectWarningRow(w) {
  return {
    warning_number: Number(w.warning_number),
    warning_ref: `W-${w.warning_number}`,
    user_id: String(w.user_id),
    issuer_id: optionalText(w.issuer_id),
    reason: w.reason ?? "",
    created_at: optionalInt(w.created_at),
    expires_at: optionalInt(w.expires_at),
    voided_at: optionalInt(w.voided_at),
    voided_by: optionalText(w.voided_by),
    void_reason: optionalText(w.void_reason),
    related_note_id: optionalInt(w.related_note_id),
    evidence_message_url: optionalText(w.evidence_message_url),
    evidence_text: optionalText(w.evidence_text),
  };
}

/**
 * One `staff_notes` row → plain JSON-able judgment data (live rows only —
 * deleted_at is excluded upstream by the repository default).
 * @param {object} n
 */
function projectNoteRow(n) {
  return {
    note_number: Number(n.note_number),
    note_ref: `N-${n.note_number}`,
    user_id: String(n.user_id),
    author_id: optionalText(n.author_id),
    content: n.content ?? "",
    created_at: optionalInt(n.created_at),
  };
}

// ── deps seam ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} LookupsDeps
 * @property {(guildId: string, userId: string) => Promise<object|null|undefined>} getMember
 *   Guild member by id. MUST resolve null/undefined for a non-member
 *   (discord.js 10013 Unknown Member) and may REJECT on a genuine read
 *   failure — the service distinguishes the two (absence refuses with the
 *   guild-isolation cause; a rejection surfaces its own cause, never a lie
 *   about membership).
 */

/**
 * Production default behind the seam: cache read, then `guild.members.fetch`
 * with 10013 → null. Individual seams stay overridable (`deps.getMember`).
 * With no `deps.client` the default throws the specific "no Discord client"
 * error, which the service converts to `{ ok:false }` — fail closed.
 *
 * @param {object} [deps]
 * @returns {Required<{getMember: LookupsDeps["getMember"]}>}
 */
function buildLookupsDeps(deps = {}) {
  const base = {
    async getMember(guildId, userId) {
      const client = deps?.client;
      if (!client?.guilds?.cache?.get) {
        throw new Error(
          "no Discord client on deps — inject deps.client (or a getMember seam)",
        );
      }
      const guild = client.guilds.cache.get(String(guildId));
      if (!guild) throw new Error(`guild ${guildId} is not cached by this client`);
      const id = String(userId);
      try {
        const cached = guild.members?.cache?.get?.(id) ?? null;
        if (cached) return cached;
      } catch {
        // cache read drift — fall through to REST, the authoritative read
      }
      try {
        return (await guild.members?.fetch?.(id)) ?? null;
      } catch (err) {
        if (err?.code === 10013) return null; // Unknown Member = not a member
        throw err;
      }
    },
  };
  return { ...base, ...deps };
}

// ── logging + failure shape (AGENTS.md rules 2/3/6) ────────────────────────

function idTag({ communityId, guildId, userId, actorUserId }) {
  return (
    `(community ${communityId ?? "?"} guild ${guildId ?? "?"} user ${userId ?? "?"}` +
    `${actorUserId != null ? ` actor ${actorUserId}` : ""})`
  );
}

/** The ONE failure exit: log with ids, return the service shape. */
function fail(what, ids, error, cause = null) {
  console.error(
    `[automod] lookup ${what} failed ${idTag(ids)}:`,
    cause?.message || cause || error,
  );
  return { ok: false, error };
}

// ── shared preflight (guild isolation for BOTH tools) ──────────────────────

/**
 * Validate inputs, resolve the community (explicit id wins; default is the
 * guild's registered community row via `discordCommunityId`, which never
 * throws), and run the guild-isolation gate: the SUBJECT must have a member
 * row in this guild. Returns the resolved call or the service failure.
 */
async function guardLookup({ what, communityId, guildId, userId, actorUserId, deps }) {
  const ids = {
    communityId: communityId ?? null,
    guildId: optionalText(guildId),
    userId: optionalText(userId),
    actorUserId: optionalText(actorUserId),
  };
  try {
    const uid = ids.userId;
    if (!uid) {
      return fail(what, ids, "A user id is required — the lookup never answers for an anonymous subject.");
    }
    const gid = ids.guildId;
    if (!gid) {
      return fail(
        what,
        ids,
        `A guildId (Discord snowflake) is required — warnings and staff notes are per-server records and auto-moderation is Discord-only for this milestone (#723 decision 8).`,
      );
    }

    let cid = null;
    if (communityId != null && String(communityId).trim() !== "") {
      cid = Number(communityId);
      if (!Number.isInteger(cid) || cid < 1) {
        return fail(what, ids, `Invalid communityId \`${communityId}\` — expected a positive integer.`);
      }
    } else {
      cid = discordCommunityId(gid);
      if (cid == null) {
        return fail(
          what,
          ids,
          `This server has no community row yet — guild-scoped records cannot be read before the guild is registered (the bot must be in it and running).`,
        );
      }
      ids.communityId = cid;
    }

    const resolved = buildLookupsDeps(deps ?? {});
    let member = null;
    try {
      member = (await resolved.getMember(gid, uid)) ?? null;
    } catch (err) {
      return fail(
        what,
        ids,
        `Could not verify whether <@${uid}> is a member of this server (${err?.message || err}) — the read fails closed and nothing was returned.`,
        err,
      );
    }
    if (!member) {
      return fail(
        what,
        ids,
        `**Outside this server:** <@${uid}> is not a member of this server — warnings and staff notes are per-server records, ` +
          "and this lookup only answers for members of THIS server (guild isolation, #723). Nothing was returned.",
      );
    }
    return { ok: true, communityId: cid, guildId: gid, userId: uid, ids, deps: resolved };
  } catch (err) {
    return fail(
      what,
      ids,
      `Could not run the lookup: ${err?.message || err}`,
      err,
    );
  }
}

// ── the two lookup tools ───────────────────────────────────────────────────

/**
 * `read_warnings(user)` — the model's warning-history tool.
 *
 * Judgment-complete set (module header): ALL non-voided warnings for the
 * user in this guild (active AND expired), newest first; voided history is
 * disclosed as a count only. No mode/settings gate by design (contract:
 * "read-only, always available, no mode flag").
 *
 * @param {object} opts
 * @param {string} opts.guildId            Discord guild snowflake (isolation anchor)
 * @param {string} opts.userId             subject of the lookup
 * @param {number} [opts.communityId]      explicit community override (default: derived from guildId)
 * @param {string|null} [opts.actorUserId] requesting context for the LOG line only (no gate)
 * @param {Partial<LookupsDeps> & {client?: object}} [opts.deps]
 * @returns {Promise<
 *   | { ok: true, guild_id: string, user_id: string, actor_user_id: string|null,
 *       warnings: object[], count: number, total_including_voided: number,
 *       truncated: boolean, mode_gated: false }
 *   | { ok: false, error: string }
 * >}
 */
async function readWarningsForLookup({
  communityId = null,
  guildId = null,
  userId = null,
  actorUserId = null,
  deps = {},
} = {}) {
  const guard = await guardLookup({
    what: "read_warnings",
    communityId,
    guildId,
    userId,
    actorUserId,
    deps,
  });
  if (!guard.ok) return guard;
  const { ids } = guard;
  try {
    const rows = listWarnings(guard.communityId, guard.userId, {
      includeVoided: false,
      limit: AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
    });
    const total = countWarnings(guard.communityId, guard.userId, {
      includeVoided: true,
    });
    return {
      ok: true,
      guild_id: guard.guildId,
      user_id: guard.userId,
      actor_user_id: ids.actorUserId,
      warnings: rows.map(projectWarningRow),
      count: rows.length,
      total_including_voided: Number(total) || 0,
      truncated: rows.length >= AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
      mode_gated: false,
    };
  } catch (err) {
    return fail(
      "read_warnings",
      ids,
      `Could not read the warning history for <@${guard.userId}> (${err?.message || err}) — nothing was returned.`,
      err,
    );
  }
}

/**
 * `read_staff_notes(user)` — the model's staff-notes tool.
 *
 * ALL live notes for the user in this guild, newest first; erased (soft-
 * deleted) notes excluded with the count disclosed. Same always-available
 * contract as {@link readWarningsForLookup}.
 *
 * @param {object} opts @see readWarningsForLookup
 * @returns {Promise<
 *   | { ok: true, guild_id: string, user_id: string, actor_user_id: string|null,
 *       notes: object[], count: number, total_including_deleted: number,
 *       truncated: boolean, mode_gated: false }
 *   | { ok: false, error: string }
 * >}
 */
async function readStaffNotesForLookup({
  communityId = null,
  guildId = null,
  userId = null,
  actorUserId = null,
  deps = {},
} = {}) {
  const guard = await guardLookup({
    what: "read_staff_notes",
    communityId,
    guildId,
    userId,
    actorUserId,
    deps,
  });
  if (!guard.ok) return guard;
  const { ids } = guard;
  try {
    const rows = listStaffNotes(guard.communityId, guard.userId, {
      includeDeleted: false,
      limit: AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
    });
    const total = countStaffNotes(guard.communityId, guard.userId, {
      includeDeleted: true,
    });
    return {
      ok: true,
      guild_id: guard.guildId,
      user_id: guard.userId,
      actor_user_id: ids.actorUserId,
      notes: rows.map(projectNoteRow),
      count: rows.length,
      total_including_deleted: Number(total) || 0,
      truncated: rows.length >= AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
      mode_gated: false,
    };
  } catch (err) {
    return fail(
      "read_staff_notes",
      ids,
      `Could not read the staff notes for <@${guard.userId}> (${err?.message || err}) — nothing was returned.`,
      err,
    );
  }
}

module.exports = {
  LOOKUP_TOOL_NAMES,
  projectWarningRow,
  projectNoteRow,
  buildLookupsDeps,
  readWarningsForLookup,
  readStaffNotesForLookup,
};
