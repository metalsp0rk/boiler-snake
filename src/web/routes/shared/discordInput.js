/**
 * Tolerant parsing for human-typed Discord identifiers (§8.15 task 15.10).
 *
 * Console text fields ask for user ids / role ids, but operators paste
 * MENTIONS (<@123>, <@&123>, <@!123>) or type ROLE NAMES (the picker is an
 * enhancement, never a requirement — SSR-first §8.2). These helpers widen
 * what the SERVER accepts, with strict safety properties:
 *
 *  - ids stay pure digits before any repository/service sees them;
 *  - role NAMES resolve ONLY against the guild's role cache, case-
 *    insensitive, and ONLY on a unique hit — ambiguity never guesses;
 *  - nothing here throws: bad input always answers null/{error} so the
 *    caller keeps ownership of its own error slug.
 */

/** <@id> / <@!id> (nickname mention) / <@&id> (role mention). */
const MENTION_USER_RE = /^<@!?([0-9]{15,21})>$/;
const MENTION_ROLE_RE = /^<@&([0-9]{15,21})>$/;
/** Plain snowflake window (same width the route regexes accept). */
const SNOWFLAKE_RE = /^[0-9]{15,21}$/;

/**
 * Normalize a user field: plain snowflake or a user mention.
 * @param {unknown} raw
 * @returns {string|null} pure digits, or null when unparseable
 */
function normalizeUserId(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const mention = MENTION_USER_RE.exec(value);
  const id = mention ? mention[1] : value;
  return SNOWFLAKE_RE.test(id) ? id : null;
}

/**
 * Normalize a role field into either a resolved id or a NAME to look up.
 * @param {unknown} raw
 * @returns {{ kind: "id", value: string } | { kind: "name", value: string } | null}
 */
function normalizeRoleRef(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const mention = MENTION_ROLE_RE.exec(value);
  const candidate = mention ? mention[1] : value;
  if (SNOWFLAKE_RE.test(candidate)) return { kind: "id", value: candidate };
  if (candidate.length <= 100) return { kind: "name", value: candidate };
  return null;
}

/**
 * Case-insensitive exact role-NAME lookup against the guild role cache.
 * Unique hit required — "Mod" matching two roles is an error, never a coin
 * flip. No client/cache ⇒ null (callers treat it like an invalid id).
 * @param {(() => any)|null|undefined} getClient
 * @param {string} guildId
 * @param {string} name
 * @returns {string|null} the single matching role id
 */
function findRoleIdByName(getClient, guildId, name) {
  try {
    const client = typeof getClient === "function" ? getClient() : null;
    const roles =
      client?.guilds?.cache?.get?.(guildId)?.roles?.cache ?? null;
    if (!roles || typeof roles.values !== "function") return null;
    const needle = name.toLowerCase();
    let hit = null;
    for (const role of roles.values()) {
      if (typeof role?.name !== "string") continue;
      if (role.name.toLowerCase() !== needle) continue;
      if (hit && hit !== role.id) return null; // ambiguous → refuse
      hit = String(role.id);
    }
    return hit;
  } catch {
    return null;
  }
}

/**
 * Rank a {id,name} suggestion list against a lowercase query: name-prefix
 * beats name-substring beats id-substring; input order preserved per class.
 * Shared by the /lookups endpoints so users/roles rank identically.
 * @param {Array<{id: string, name?: string|null}>} items
 * @param {string} lowerQ
 */
function rankSuggestions(items, lowerQ) {
  const score = (it) => {
    const name = String(it.name || "").toLowerCase();
    if (name.startsWith(lowerQ)) return 0;
    if (name.includes(lowerQ)) return 1;
    if (String(it.id).includes(lowerQ)) return 2;
    return 3;
  };
  return items
    .map((it, i) => ({ it, i, s: score(it) }))
    .filter((x) => x.s < 3)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.it);
}

module.exports = {
  normalizeUserId,
  normalizeRoleRef,
  findRoleIdByName,
  rankSuggestions,
  SNOWFLAKE_RE,
};
