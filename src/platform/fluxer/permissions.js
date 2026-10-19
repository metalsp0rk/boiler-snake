/**
 * Fluxer permission masks (roadmap/fluxer.md § Permissions, 507–566 — THE
 * contract). Discord hands the handler `interaction.memberPermissions` (the
 * CHANNEL bitset, admin short-circuit already expanded); Fluxer does not, so
 * this module computes the same number from the Phase 0 wire facts.
 *
 * Pinned law (Phase 0 record, 2026-09-29):
 * - Masks are decimal STRINGS on the wire. Parse ONLY through
 *   {@link parsePermissionsBits} — the closed `/^\d{1,20}$/` rule mirrored
 *   from src/web/auth/guildAccess.js. Never Number() a mask; never compare
 *   masks with `===` on the string (leading zeros, bit 54).
 * - `everyoneRoleId(g) = String(g.id)` (Phase 0 answer: YES, recorded).
 * - Overwrite wire field is `type` (NOT `kind`): `{id, type, allow, deny}`
 *   with `type: 0 = role, 1 = member`, allow/deny decimal strings.
 * - `ALL = (1n << 64n) - 1n` is a CONCRETE uint64 mask: the guild owner and
 *   the ADMINISTRATOR short-circuit both return it; `hasBit(ALL, MANAGE_GUILD)`
 *   is true because every bit is set. There is no second sentinel.
 *
 * `computeChannelPermissions` is PURE — no I/O, no cache. It may console.warn
 * the § Permissions rule-3 line; that is logging, not I/O. All network lives
 * in {@link resolveFluxerPermissions}, which follows the fail-closed sequence
 * (spec 559–564, rules 1–3) and surfaces specific user-facing copies. Since
 * #385 (FLX-4) that network is TUNNELED, not removed: guild/roles/channel
 * reads ride ./permCache (FLUXER_PERMISSION_CACHE_MS, default 5000, 0
 * disables) — successes only, so a failure is retried by the next call.
 */

/** Unsigned decimal string only: rejects "", "1e10", "-32" (two's-complement
 *  BigInt &-tricks), garbage, and absurd lengths. Anything else ⇒ 0 bits.
 *  Same closed rule as src/web/auth/guildAccess.js (spec 516). */
const permCache = require("./permCache");

const PERMISSIONS_DECIMAL_RE = /^\d{1,20}$/;

/** Concrete uint64 mask (spec 519): every bit of the 64-bit space set. */
const ALL_PERMISSIONS = (1n << 64n) - 1n;
/** ADMINISTRATOR — the role-level bit the union short-circuits on (spec 513). */
const ADMINISTRATOR = 1n << 3n;
/** MANAGE_GUILD — the bit `isAdminOrMod` checks (spec 514). */
const MANAGE_GUILD = 1n << 5n;

/**
 * Bit test over BigInt masks (spec 521–523): BOTH arguments are bigints and
 * `bit` is a single-bit mask, never a bit index. A string mask is a programmer
 * error — parse it first with {@link parsePermissionsBits}.
 *
 * @param {bigint} perms
 * @param {bigint} bit
 * @returns {boolean}
 * @throws {TypeError} when either argument is not a bigint
 */
function hasBit(perms, bit) {
  if (typeof perms !== "bigint" || typeof bit !== "bigint") {
    throw new TypeError(
      `hasBit: both arguments must be bigint, got ${typeof perms} and ${typeof bit} ` +
        `(decimal-string masks go through parsePermissionsBits; bit is a mask like MANAGE_GUILD, never an index)`,
    );
  }
  return (perms & bit) === bit;
}

/**
 * Parse a permission bitset to BigInt, failing CLOSED to 0n (a malformed mask
 * must never mint permissions). Mirrors the guildAccess.js closed rule; adds
 * the spec 516 "a bad mask is logged" requirement. The log NEVER echoes more
 * than 20 characters of the offending value (spec: masks are ≤20 chars; longer
 * strings are credential-shaped and stay out of the logs).
 *
 * @param {unknown} value decimal string from the wire (fetchRoles / overwrites)
 * @returns {bigint}
 */
function parsePermissionsBits(value) {
  if (typeof value === "string" && PERMISSIONS_DECIMAL_RE.test(value)) {
    try {
      return BigInt(value);
    } catch {
      // Fall through to the closed 0n (BigInt on a 20-digit string cannot
      // throw, but the closed rule is a no-throw promise, not a happy path).
    }
  }
  const redacted =
    typeof value === "string"
      ? JSON.stringify(value.slice(0, 20)) + (value.length > 20 ? `…(len ${value.length})` : "")
      : typeof value;
  console.warn("[fluxer] invalid permissions mask, using 0:", redacted);
  return 0n;
}

/**
 * Phase 0 ANSWER (2026-09-29, recorded): the ready guild carries a role whose
 * id equals the guild id, name "@everyone", position 0. The staff-gate block
 * is lifted; `everyoneRoleId(g) = String(g.id)`.
 *
 * @param {{ id: unknown }} guild
 * @returns {string}
 */
function everyoneRoleId(guild) {
  return String(guild.id);
}

/**
 * Apply one overwrite entry's deny then allow, in that order (spec 532/538:
 * "deny then allow" — a bit in both lands denied-then-allowed, i.e. allowed).
 * @param {bigint} perms
 * @param {{ allow?: unknown, deny?: unknown }} ow
 * @returns {bigint}
 */
function applyOverwrite(perms, ow) {
  const deny = parsePermissionsBits(ow.deny);
  const allow = parsePermissionsBits(ow.allow);
  return (perms & ~deny) | allow;
}

/**
 * THE algorithm (spec § Permissions pseudocode, lines 525–539), implemented
 * verbatim. PURE: takes everything as arguments and performs no I/O.
 *
 *   owner → ALL; everyone base; union member role masks; ADMINISTRATOR → ALL
 *   (overwrites never apply); everyone overwrite (deny then allow); union of
 *   the member's ROLE overwrites: perms = (perms & ~deny) | allow; member
 *   overwrite (deny then allow).
 *
 * @param {object} inputs
 * @param {{ id: string, roleIds?: string[] }|null} [inputs.member] resolved member (id + role ids)
 * @param {{ id: string, ownerId?: string|null }|null} [inputs.guild] guild record (REST shape: owner_id mapped to ownerId)
 * @param {{ permissionOverwrites: Array<{id:string,type:number,allow:string,deny:string}>|null }|null} [inputs.channel] channel record
 * @param {Array<{ id: string, permissions: string }>|null} [inputs.roles] fetchRoles RoleHandle list
 * @param {string} [instanceKey] logging identity for the rule-3 line
 * @returns {bigint}
 */
function computeChannelPermissions(
  { member = null, guild = null, channel = null, roles = null } = {},
  instanceKey = "fluxer",
) {
  const memberId = member && member.id != null ? String(member.id) : null;

  // Owner → ALL. The owner check needs the guild record; without one (fetch
  // failed) nobody is the owner — fail closed.
  if (memberId != null && guild && guild.ownerId != null && String(guild.ownerId) === memberId) {
    return ALL_PERMISSIONS;
  }

  const roleList = Array.isArray(roles) ? roles : [];
  const roleById = new Map();
  for (const r of roleList) {
    if (r && typeof r === "object" && r.id != null) roleById.set(String(r.id), r);
  }

  // Everyone base mask. Phase 0: the @everyone role id equals the guild id.
  // Rule 3 (spec 563): everyone missing from a POPULATED role list → base 0n,
  // log, continue — never invent permissions. An EMPTY list means the caller
  // supplied no role data at all (cache miss); "role list" has nothing to be
  // missing from, so no log noise on the zero-role hot path.
  const everyoneId = guild && guild.id != null ? everyoneRoleId(guild) : null;
  const everyone = everyoneId == null ? null : roleById.get(everyoneId) ?? null;
  if (roleList.length > 0 && everyoneId != null && !everyone) {
    console.warn(
      `[fluxer] ${instanceKey} everyone role missing guild=${guild ? String(guild.id) : "?"}`,
    );
  }
  let perms = everyone ? parsePermissionsBits(everyone.permissions) : 0n;

  const memberRoleIds =
    member && Array.isArray(member.roleIds) ? member.roleIds.map((id) => String(id)) : [];

  // Union the member's role masks on top of the everyone base (spec: the
  // everyone mask is unioned BEFORE member roles).
  for (const roleId of memberRoleIds) {
    const role = roleById.get(roleId);
    if (role) perms |= parsePermissionsBits(role.permissions);
  }

  // ADMINISTRATOR short-circuit (spec 531): overwrites do NOT apply to an
  // administrator — return ALL before any overwrite handling.
  if (hasBit(perms, ADMINISTRATOR)) return ALL_PERMISSIONS;

  const overwrites =
    channel && Array.isArray(channel.permissionOverwrites) ? channel.permissionOverwrites : [];

  // Everyone overwrite: id equals the everyone role id (spec applies it by id
  // match), deny then allow.
  if (everyoneId != null) {
    for (const ow of overwrites) {
      if (ow && String(ow.id) === everyoneId) perms = applyOverwrite(perms, ow);
    }
  }

  // Union of the member's role overwrites (wire `type: 0 = role`), applied as
  // one combined step: perms = (perms & ~deny) | allow.
  let allow = 0n;
  let deny = 0n;
  for (const roleId of memberRoleIds) {
    for (const ow of overwrites) {
      if (ow && Number(ow.type) === 0 && String(ow.id) === roleId) {
        allow |= parsePermissionsBits(ow.allow);
        deny |= parsePermissionsBits(ow.deny);
      }
    }
  }
  perms = (perms & ~deny) | allow;

  // Member overwrite (wire `type: 1 = member`), last, deny then allow.
  if (memberId != null) {
    for (const ow of overwrites) {
      if (ow && Number(ow.type) === 1 && String(ow.id) === memberId) {
        perms = applyOverwrite(perms, ow);
      }
    }
  }

  return perms;
}

/**
 * Fail-closed member/role/channel resolution (spec § Permissions "Cache
 * misses, fail closed", rules 1–3). The gateway's `member` payload IS the
 * instance cache for the member record; the optional `member` argument carries
 * it from dispatch (contract 2). Everything resolved from it costs zero
 * requests — a MESSAGE_CREATE for a roleless author must not fan out.
 *
 * Rule 1: member not resolvable (no payload member AND fetchMember fails) →
 *   { ok:false } with `Could not resolve your member record: …` — the handler
 *   is NOT called.
 * Rule 2: member present with role ids → fetchRoles on demand; a failed role
 *   fetch leaves channelPermissions computed from an empty role list (0n base
 *   — not admin) while memberRoleIds still flow to the staff_roles table.
 *   Role ids with no member record at all → `Could not resolve your roles: …`.
 * Rule 3: everyone role missing from a populated role list → base 0n + the
 *   `[fluxer] <instanceKey> everyone role missing guild=…` log (inside
 *   computeChannelPermissions), never a guessed mask.
 *
 * @param {object} args
 * @param {object} args.outbound OutboundClient (fetchMember/fetchRoles/fetchChannel/fetchGuild)
 * @param {number} args.communityId
 * @param {string} args.userId
 * @param {string} args.channelId
 * @param {string} [args.instanceKey]
 * @param {{ roleIds: string[], bot?: boolean, username?: string|null }|null} [args.member]
 *   gateway-supplied member payload (the instance cache view)
 * @returns {Promise<{ ok: true, channelPermissions: bigint, memberRoleIds: string[], memberBot: boolean, author: {id: string, username: string|null, bot: boolean} }|{ ok: false, code: string, error: string }>}
 */
async function resolveFluxerPermissions({
  outbound,
  communityId,
  userId,
  channelId,
  instanceKey = "fluxer",
  member = null,
}) {
  const id = String(userId);
  let memberRoleIds = null;
  let memberBot = false;
  let author = null;

  // Rule 1: member record — the message payload first (that IS the instance
  // cache), fetchMember only when the payload carries no member.
  if (member && Array.isArray(member.roleIds)) {
    memberRoleIds = member.roleIds.map((rid) => String(rid));
    memberBot = member.bot === true;
    author = {
      id,
      username: member.username != null ? String(member.username) : null,
      bot: memberBot,
    };
  } else {
    let fetched = null;
    try {
      fetched = await outbound.fetchMember(communityId, id);
    } catch (err) {
      fetched = null;
      console.error(
        `[fluxer] ${instanceKey} fetchMember user ${id} community ${communityId} threw: ${err?.message || err}`,
      );
    }
    if (!fetched) {
      return {
        ok: false,
        code: "member_unresolvable",
        error:
          `Could not resolve your member record: the Fluxer instance returned no member ` +
          `record for user ${id} in community ${communityId}. Ask an admin to confirm the bot can read members.`,
      };
    }
    if (!Array.isArray(fetched.roleIds)) {
      // Rule 2 tail: role ids are also missing — deny with the roles copy.
      return {
        ok: false,
        code: "roles_unresolvable",
        error:
          `Could not resolve your roles: the member record for user ${id} carried no role id list, ` +
          `and no role data is cached for community ${communityId}.`,
      };
    }
    memberRoleIds = fetched.roleIds.map((rid) => String(rid));
    memberBot = Boolean(fetched.bot);
    author = {
      id: String(fetched.id ?? id),
      username: fetched.username ?? null,
      bot: memberBot,
    };
  }

  // #385 (FLX-4): the fan-out below runs through ./permCache — successes
  // only, FLUXER_PERMISSION_CACHE_MS (default 5 s, 0 disables) — so the
  // per-message guild/roles/channel GET storm collapses to ~one set per
  // community per window. #386 keeps every read guild-scoped regardless.
  //
  // Rule 2 + the everyone base, always fetched: the spec pins
  // "everyone base; union member role masks", and the @everyone role IS a
  // role a zero-role member carries. The pre-#385 skip for
  // memberRoleIds.length === 0 silently zeroed the base and lost genuine
  // @everyone channel grants (the audit's spec-deviation tail) — the base
  // is resolved from the role list for EVERY member now.
  let roles = [];
  const rolesKey = `roles:${communityId}`;
  const rolesHit = permCache.read(outbound, rolesKey);
  if (rolesHit) {
    roles = rolesHit.value;
  } else {
    try {
      const fetched = (await outbound.fetchRoles(communityId)) ?? [];
      roles = fetched;
      // A Fluxer guild always has @everyone: an empty list is the
      // adapter's failure shape — honest for this call, never cacheable.
      if (fetched.length > 0) permCache.store(outbound, rolesKey, fetched);
    } catch (err) {
      roles = [];
      console.error(
        `[fluxer] ${instanceKey} fetchRoles community ${communityId} threw: ${err?.message || err}`,
      );
    }
    // Outbound swallows fetch failures to [] (spec: that is the failure
    // shape); the empty list then yields the 0n fail-closed base, and the
    // staff_roles table is still consulted from memberRoleIds by the gates.
  }

  let guild = null;
  const guildKey = `guild:${communityId}`;
  const guildHit = permCache.read(outbound, guildKey);
  if (guildHit) {
    guild = guildHit.value;
  } else {
    try {
      guild = (await outbound.fetchGuild(communityId)) ?? null;
      if (guild) permCache.store(outbound, guildKey, guild);
    } catch (err) {
      guild = null;
      console.error(
        `[fluxer] ${instanceKey} fetchGuild community ${communityId} threw: ${err?.message || err}`,
      );
    }
  }

  // Overwrites modify the (everyone ⊕ roles) mask — and with the everyone
  // base now real for ZERO-role members too (above), the channel is read
  // for EVERY member, not only members carrying role ids.
  let channel = null;
  const channelKey = `channel:${communityId}:${String(channelId)}`;
  const channelHit = permCache.read(outbound, channelKey);
  if (channelHit) {
    channel = channelHit.value;
  } else {
    try {
      channel = (await outbound.fetchChannel(communityId, channelId)) ?? null;
      if (channel) permCache.store(outbound, channelKey, channel);
    } catch (err) {
      channel = null;
      console.error(
        `[fluxer] ${instanceKey} fetchChannel ${channelId} threw: ${err?.message || err}`,
      );
    }
  }

  const channelPermissions = computeChannelPermissions(
    { member: { id, roleIds: memberRoleIds }, guild, channel, roles },
    instanceKey,
  );

  // #466 (FLX-7): REAL ownership, next to the mask it must stop proxying.
  // ctx.guildOwner used to be (mask === ALL) — true for every ADMINISTRATOR
  // and flipped by channel overwrites that never apply to ALL. Owner is the
  // guild record's ownerId vs this member; no record ⇒ not provable ⇒ false
  // (fail closed, matching every other fluxer permission default).
  const guildOwner =
    guild != null && guild.ownerId != null && String(guild.ownerId) === String(id);

  return { ok: true, channelPermissions, memberRoleIds, memberBot, author, guildOwner };
}

module.exports = {
  ALL_PERMISSIONS,
  ADMINISTRATOR,
  MANAGE_GUILD,
  hasBit,
  parsePermissionsBits,
  everyoneRoleId,
  computeChannelPermissions,
  resolveFluxerPermissions,
};
