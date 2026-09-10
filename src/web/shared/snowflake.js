/**
 * Canonical snowflake regexes — TWO classes, one rule each. Forks of these
 * (six `/^[0-9]{5,20}$/` copies + one `/^\d{17,20}$/`) had quietly drifted
 * into "which gates are strict" ambiguity. The classes:
 *
 *  1. URL_ID_RE — route GATES (`/g/:guildId`, `/users/:userId`, redirect
 *     `?guild=` targets). These only reject junk into the generic 404; the
 *     identity decision is made by DB/cache lookups, never here. Kept loose
 *     (5–20 digits) deliberately: slash-side precedent
 *     (features/tickets/users.js — "`\d+` also covers short test ids") and
 *     every web test fixture uses ids that must keep routing.
 *
 *  2. STRICT_SNOWFLAKE_RE — WRITE-side form fields whose value is persisted
 *     and later handed to Discord (channel/role ids for overwrites, log
 *     channels, integrations). Discord snowflakes are
 *     `(ms − 2015-epoch) << 22`, so every REAL id is 17–19 digits
 *     (2^63−1 = 19 digits). The write twins already enforce this
 *     (features/reactionRoles/service.js SNOWFLAKE_RE, routes/integrations);
 *     this is that rule, centralized — no real id is admitted that
 *     shouldn't be, and no junk id can be stored for Discord to 404 on.
 */

/** Route-gate id shape: reject junk → generic 404. Identity is DB-decided. */
const URL_ID_RE = /^[0-9]{5,20}$/;

/** Persisted Discord snowflake (write-side): 17–20 digits, real ids only. */
const STRICT_SNOWFLAKE_RE = /^\d{17,20}$/;

module.exports = { URL_ID_RE, STRICT_SNOWFLAKE_RE };
