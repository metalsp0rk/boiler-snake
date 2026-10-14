/**
 * NormalizedMessage required-field contract (issue #201, audit §6 P2).
 *
 * The shared cross-platform pipeline shape ("contract 1" in
 * src/platform/fluxer/normalize.js, typedef in roadmap/fluxer.md
 * § Normalized gateway events) was duck-typed: features asked
 * `!message.guild` and half-shaped adapter output flowed into the pipeline
 * silently (audit §5 "duck-field deaths"). This module makes the contract
 * EXPLICIT and ENFORCED: `assertNormalizedMessage` runs at the single
 * boundary where both adapters' normalized MESSAGE_CREATE output enters the
 * shared pipeline (`src/bot/pipelines.js` onMessageCreate), and a violation
 * THROWS — naming the missing field and the platform — so an adapter can
 * never ship a half-shaped message downstream. The boundary catch in
 * onMessageCreate logs it distinctly from downstream feature errors and
 * skips the message (never crashes the pipeline).
 *
 * The field list below is the INTERSECTION of what BOTH adapters always
 * produce (src/platform/discord/normalize.js, src/platform/fluxer/normalize.js)
 * and what the pipeline steps actually consume (pipelines.js gates, the
 * bridge relay gates/enqueue, honeypot, XP, prefix dispatch). Rules are
 * shallow on purpose: ids must be non-empty strings, collections must be
 * arrays — deep optional structures are NOT validated here.
 *
 * REQUIRED fields and nullability (all keys MUST be present):
 *   platform          "discord" | "fluxer"                     never null
 *   instanceKey       non-empty string ("discord" / instance)   never null
 *   communityId       safe integer | null                       null until the
 *                   pipeline resolves externalGuildId → communities.id
 *                   (contract 4); Discord resolves inline in the normalizer
 *   externalGuildId   non-empty string | null                   null = guild-less
 *                   (Discord DM). Fluxer's normalizer gates guild-less
 *                   payloads into the separate DM contract, so it is never
 *                   null there. The pipeline's guild gate keys off THIS
 *                   field, not the Discord `guild` duck object.
 *   id                non-empty string                          never null
 *   channelId         non-empty string                          never null
 *   authorId          non-empty string                          never null
 *   authorBot         boolean                                   never null
 *   content           string ("" is valid)                      never null
 *   mentions          { users, roles, channels } of string[]    Fluxer omits
 *                   (Discord's `everyone` flag is not part of the contract)
 *   attachments       array                                     never null
 *   createdAt         valid Date | null                         null = unparseable
 *   webhookId         non-empty string | null                   null = not a webhook
 *   authorDisplayName string ("" tolerated — cosmetic)          never null
 *   type              finite number | null                      null = payload carried none
 *   messageSnapshots  array                                     never null
 *   stickers          array                                     never null
 *   parsePrefix       string | null                             null = not a parsed
 *                   prefix line (always null from both adapters today;
 *                   roadmap/fluxer.md: Discord NEVER enters the prefix branch)
 *
 * NOT required (deliberately): the Discord duck fields (guild, author,
 * channel, member, …) that unmigrated features keep reading; and the extras
 * whose consumers type-guard with Array.isArray / Map / numeric checks:
 * memberRoleIds, channelTypes, mentionBots, authorRaw, memberRaw,
 * mentionUsersRaw are Fluxer-only — Discord's normalizer never produces
 * them — while embeds and flags ride on BOTH adapters (since issue #200 the
 * Fluxer normalizer always emits `embeds` (array) plus a numeric-or-null
 * `flags`; Discord's are untouched duck fields). Still optional extras,
 * never contract-guaranteed. memberRoleIds is validated NEITHER as required
 * nor as array on purpose: issue #274 pins null = member absent (REST
 * fallback allowed) vs [] = member present with zero roles (authoritative),
 * and its consumers type-guard (Array.isArray) — never tighten this extra
 * to a plain-array rule.
 * Separate contracts (NOT validated here — see the issue #201 PR):
 * NormalizedReaction, the MESSAGE_DELETE identity partial
 * (normalizeFluxerMessageDelete / partial Discord deletes), and
 * NormalizedDmMessage (§10.3 delta 1).
 */

/**
 * Thrown when an adapter hands the pipeline a normalized message that
 * violates the required-field contract. `field` and `platform` are attached
 * so the boundary log (and tests) can name them without parsing the text.
 */
class NormalizedMessageContractError extends Error {
  /**
   * @param {string} message pre-formatted, already names field + platform
   * @param {{ field: string, platform: string }} info
   */
  constructor(message, { field, platform }) {
    super(message);
    this.name = "NormalizedMessageContractError";
    this.code = "NORMALIZED_MESSAGE_CONTRACT";
    this.field = field;
    this.platform = platform;
  }
}

/** @param {unknown} v @returns {boolean} */
function isIdString(v) {
  return typeof v === "string" && v !== "";
}

/** @param {unknown} v @returns {boolean} */
function isString(v) {
  return typeof v === "string";
}

/** @param {unknown} v @returns {boolean} */
function isIdOrNull(v) {
  return v === null || isIdString(v);
}

/** @param {unknown} v @returns {boolean} */
function isSafeIntOrNull(v) {
  return v === null || Number.isSafeInteger(v);
}

/** @param {unknown} v @returns {boolean} */
function isFiniteOrNull(v) {
  return v === null || (typeof v === "number" && Number.isFinite(v));
}

/** @param {unknown} v @returns {boolean} */
function isArray(v) {
  return Array.isArray(v);
}

/** @param {unknown} v @returns {boolean} */
function isValidDateOrNull(v) {
  return v === null || (v instanceof Date && !Number.isNaN(v.getTime()));
}

/** @param {unknown} v @returns {boolean} */
function isMentionsShape(v) {
  return (
    !!v &&
    typeof v === "object" &&
    isArray(v.users) &&
    isArray(v.roles) &&
    isArray(v.channels)
  );
}

/**
 * The contract table, checked IN ORDER (the first violation throws, so
 * `platform` is checked first and per-field tests see their own field).
 * Each rule: expected type description + predicate + nullability note.
 */
const CONTRACT_FIELDS = Object.freeze(
  Object.freeze([
    Object.freeze({
      field: "platform",
      expect: 'the platform tag "discord" or "fluxer"',
      nullable: false,
      check: (v) => v === "discord" || v === "fluxer",
    }),
    Object.freeze({
      field: "instanceKey",
      expect: "a non-empty string id",
      nullable: false,
      check: isIdString,
    }),
    Object.freeze({
      field: "communityId",
      expect: "a safe integer or null (resolved communities.id)",
      nullable: true,
      check: isSafeIntOrNull,
    }),
    Object.freeze({
      field: "externalGuildId",
      expect: 'a non-empty string id or null (null = guild-less, e.g. a Discord DM)',
      nullable: true,
      check: isIdOrNull,
    }),
    Object.freeze({
      field: "id",
      expect: "a non-empty string id",
      nullable: false,
      check: isIdString,
    }),
    Object.freeze({
      field: "channelId",
      expect: "a non-empty string id",
      nullable: false,
      check: isIdString,
    }),
    Object.freeze({
      field: "authorId",
      expect: "a non-empty string id",
      nullable: false,
      check: isIdString,
    }),
    Object.freeze({
      field: "authorBot",
      expect: "a boolean",
      nullable: false,
      check: (v) => typeof v === "boolean",
    }),
    Object.freeze({
      field: "content",
      expect: "a string ('' allowed)",
      nullable: false,
      check: isString,
    }),
    Object.freeze({
      field: "mentions",
      expect: "an object with users/roles/channels arrays",
      nullable: false,
      check: isMentionsShape,
    }),
    Object.freeze({
      field: "attachments",
      expect: "an array",
      nullable: false,
      check: isArray,
    }),
    Object.freeze({
      field: "createdAt",
      expect: "a valid Date or null",
      nullable: true,
      check: isValidDateOrNull,
    }),
    Object.freeze({
      field: "webhookId",
      expect: "a non-empty string id or null",
      nullable: true,
      check: isIdOrNull,
    }),
    Object.freeze({
      field: "authorDisplayName",
      expect: "a string ('' allowed — cosmetic)",
      nullable: false,
      check: isString,
    }),
    Object.freeze({
      field: "type",
      expect: "a finite number or null",
      nullable: true,
      check: isFiniteOrNull,
    }),
    Object.freeze({
      field: "messageSnapshots",
      expect: "an array",
      nullable: false,
      check: isArray,
    }),
    Object.freeze({
      field: "stickers",
      expect: "an array",
      nullable: false,
      check: isArray,
    }),
    Object.freeze({
      field: "parsePrefix",
      expect: "a string or null",
      nullable: true,
      check: (v) => v === null || isString(v),
    }),
  ]),
);

/** Just the required field names, in contract-check order (tests iterate). */
const REQUIRED_NORMALIZED_FIELDS = Object.freeze(
  CONTRACT_FIELDS.map((rule) => rule.field),
);

/**
 * Describe a value for the error text without dumping payloads: types and
 * short scalars only (ids/short strings quoted, long strings truncated).
 * @param {unknown} v
 * @returns {string}
 */
function describeValue(v) {
  if (v === undefined) return "undefined (key absent)";
  if (v === null) return "null";
  if (typeof v === "string") {
    return v.length > 40 ? `"${v.slice(0, 40)}…"` : JSON.stringify(v);
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return `${typeof v} ${String(v)}`;
  }
  if (Array.isArray(v)) return "an array";
  if (v instanceof Date) return "a Date";
  if (typeof v === "object") return "an object";
  return typeof v;
}

/**
 * Assert that `message` satisfies the NormalizedMessage required-field
 * contract and return it (usable inline at the boundary).
 *
 * @param {unknown} message the adapter's normalized MESSAGE_CREATE output
 * @param {{ boundary?: string }} [opts] `boundary` names the entry point in
 *   the failure text (default "onMessageCreate")
 * @returns {object} the same message, contract-checked
 * @throws {NormalizedMessageContractError} naming the FIRST violated field and
 *   the platform ("unknown" when the platform tag itself is the violation)
 */
function assertNormalizedMessage(message, { boundary = "onMessageCreate" } = {}) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new NormalizedMessageContractError(
      `[normalized-message-contract] ${boundary}: message is not an object ` +
        `(got ${describeValue(message)}, platform "unknown") — every required ` +
        "field is missing",
      { field: "(whole message)", platform: "unknown" },
    );
  }

  for (const rule of CONTRACT_FIELDS) {
    const value = message[rule.field];
    if (rule.check(value)) continue;

    // Name the platform the ADAPTER claimed when it is trustworthy; the
    // violation may be the platform tag itself.
    const rawPlatform = message.platform;
    const platform =
      rawPlatform === "discord" || rawPlatform === "fluxer"
        ? rawPlatform
        : "unknown";
    throw new NormalizedMessageContractError(
      `[normalized-message-contract] ${boundary}: platform "${platform}" ` +
        `normalized message fails required field "${rule.field}" — expected ` +
        `${rule.expect}${rule.nullable ? "" : " (null is NOT allowed)"}, got ` +
        `${describeValue(value)} (message ${isIdString(message.id) ? message.id : "<no valid id>"})`,
      { field: rule.field, platform },
    );
  }
  return message;
}

module.exports = {
  assertNormalizedMessage,
  NormalizedMessageContractError,
  REQUIRED_NORMALIZED_FIELDS,
};
