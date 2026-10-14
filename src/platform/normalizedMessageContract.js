/**
 * Normalized cross-platform payload contracts (issue #201 messages, audit
 * §6 P2; issue #279 reactions / delete-identity partials / DMs).
 *
 * The shared cross-platform pipeline shape ("contract 1" in
 * src/platform/fluxer/normalize.js, typedef in roadmap/fluxer.md
 * § Normalized gateway events) was duck-typed: features asked
 * `!message.guild` and half-shaped adapter output flowed into the pipeline
 * silently (audit §5 "duck-field deaths"). This module makes the contracts
 * EXPLICIT and ENFORCED: each `assertNormalized*` runs at the boundary
 * where the adapter's normalized payload enters the shared pipeline, and a
 * violation THROWS — naming the missing field and the platform — so an
 * adapter can never ship half-shaped traffic downstream. The boundary catch
 * logs it distinctly from downstream feature errors and skips the payload
 * (never crashes the pipeline).
 *
 * The message field list below is the INTERSECTION of what BOTH adapters
 * always produce (src/platform/discord/normalize.js,
 * src/platform/fluxer/normalize.js) and what the pipeline steps actually
 * consume (pipelines.js gates, the bridge relay gates/enqueue, honeypot, XP,
 * prefix dispatch). Rules are shallow on purpose: ids must be non-empty
 * strings, collections must be arrays — deep optional structures are NOT
 * validated here. The three #279 tables follow the same discipline: shallow
 * rules over exactly what the FLUXER normalizers guarantee on every non-null
 * return (they are fluxer-side contracts; the Discord duck-shape paths stay
 * untouched, not normalized).
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
 *
 * ── Issue #279: the three adjacent shapes ─────────────────────────────────
 * #201 scoped the validator to MESSAGES at onMessageCreate. These shapes
 * were left duck-typed (they can NOT share the message validator — e.g.
 * validating a legitimate partial delete against the full message shape
 * would reject every real MESSAGE_DELETE), so each gets its own minimal
 * table, validated at the boundary where the fluxer-normalized payload
 * enters shared code:
 *
 * NORMALIZED REACTION (assertNormalizedReaction, entry:
 * pipelines.onFluxerReactionAdd / onFluxerReactionRemove):
 *   normalizeFluxerReaction's single return object (the tail of
 *   normalize.js normalizeFluxerReaction) is what BOTH
 *   producer paths (raw snake_case wire `{user_id, channel_id, message_id,
 *   emoji}` and the SDK's hydrated camelCase emit with
 *   `reaction.emoji`/`reaction.guildId`) converge into, so the guaranteed
 *   set is identical on each:
 *   messageId/channelId/userId  non-empty strings — the normalizer's own
 *                   per-field gate returns null (already logged) on any
 *                   missing/empty identity id, so a non-null output always
 *                   carries all three.
 *   emojiKey        non-empty string — same gate (custom id or unicode
 *                   name; a payload with no key normalizes to null).
 *   platform/instanceKey  tag + non-empty string, like the message contract.
 *   communityId     safe integer | null           null at entry (contract 4
 *                   — the pipeline resolves and writes it back).
 *   externalGuildId non-empty string | null       NULLABLE: unlike the
 *                   message path (guild gate), a reaction payload may
 *                   legitimately arrive guild-less — the normalizer maps
 *                   the absent guild to null and the pipeline has its own
 *                   explicit "no guild — no XP" log. The contract models
 *                   that, it does not newly reject it.
 *   userBot         boolean                       never null (Boolean()).
 *
 * DELETE-IDENTITY PARTIAL (assertNormalizedDelete, entry:
 * pipelines.onFluxerMessageDelete):
 *   normalizeFluxerMessageDelete dual-shape (raw wire snake_case vs SDK
 *   PartialMessage camelCase) always yields the identity partial — NO
 *   author, content, mentions, timestamps. Full-message rules would reject
 *   every legitimate partial delete (issue #279's core semantic).
 *   platform/instanceKey  tag + non-empty string.
 *   communityId     safe integer | null           null at entry — same
 *                   contract-4 nullability as the message table;
 *                   resolveFluxerCommunity fills it AFTER validation.
 *   externalGuildId non-empty string              NOT null here (the one
 *                   deliberate divergence from the message table's
 *                   id-or-null): the normalizer's guild gate drops
 *                   guild-less deletes to null BEFORE any output exists,
 *                   so every surviving partial carries the
 *                   community-resolvable anchor. A null would resolve no
 *                   community and dead-end the bridge intake silently —
 *                   AGENTS.md rule 1 forbids exactly that.
 *   id / channelId  non-empty strings             the identity triple's
 *                   other legs (gated by the normalizer).
 *
 * NORMALIZED DM (assertNormalizedDm, entry: the DM fan-out in
 * client.js createDmDispatcher.emit — the single point where
 * normalizeFluxerDmMessage output reaches shared consumers):
 *   The NormalizedDmMessage typedef (normalize.js typedef above
 *   normalizeFluxerDmMessage; roadmap/bridge.md §10.3 delta 1, KD 24) —
 *   identity + content/mentions/attachments/createdAt, and deliberately NO
 *   communityId/externalGuildId (a DM has no community; consumers key by
 *   platform/instanceKey/authorId). A validator that required the guild
 *   fields would reject the shape BY CONSTRUCTION, so they stay out.
 *   platform/instanceKey/channelId/id/authorId  non-empty strings (the id,
 *                   channel and author legs are gated by the normalizer;
 *                   instanceKey is the adapter's own label).
 *   content         string ("" allowed)           never null.
 *   mentions        { users, roles, channels }    same shape rule as the
 *                   message table.
 *   attachments     array                         the typedef pins the
 *                   {name,url} pair; shallow rule, like everywhere else.
 *   createdAt       valid Date | null             null = unparseable
 *                   timestamp, identical to the message contract.
 */

/**
 * Thrown when an adapter hands a boundary a normalized payload that
 * violates its shape's required-field contract. `field` and `platform` are
 * attached so the boundary log (and tests) can name them without parsing
 * the text. ONE class serves all four shapes (#201 + #279) so every
 * boundary catch uses the same `instanceof` idiom.
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
function isBoolean(v) {
  return typeof v === "boolean";
}

/** @param {unknown} v @returns {boolean} */
function isPlatformTag(v) {
  return v === "discord" || v === "fluxer";
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
 * The message contract table, checked IN ORDER (the first violation throws,
 * so `platform` is checked first and per-field tests see their own field).
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
 * The NormalizedReaction contract table (issue #279). Field order = the
 * pipeline's read order (platform/instanceKey for the community resolve,
 * then the identity ids the reaction steps consume first). Guarantees
 * cited in the module header; the normalizer is
 * src/platform/fluxer/normalize.js normalizeFluxerReaction.
 */
const REACTION_CONTRACT_FIELDS = Object.freeze(
  Object.freeze([
    Object.freeze({
      field: "platform",
      expect: 'the platform tag "discord" or "fluxer"',
      nullable: false,
      check: isPlatformTag,
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
      expect:
        "a non-empty string id or null (null = guild-less reaction payload — the pipeline logs it and skips XP)",
      nullable: true,
      check: isIdOrNull,
    }),
    Object.freeze({
      field: "messageId",
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
      field: "userId",
      expect: "a non-empty string id",
      nullable: false,
      check: isIdString,
    }),
    Object.freeze({
      field: "userBot",
      expect: "a boolean",
      nullable: false,
      check: isBoolean,
    }),
    Object.freeze({
      field: "emojiKey",
      expect: "a non-empty string id (custom emoji id or unicode name)",
      nullable: false,
      check: isIdString,
    }),
  ]),
);

/** Required reaction fields, in check order (drift-lock tests iterate). */
const REQUIRED_REACTION_FIELDS = Object.freeze(
  REACTION_CONTRACT_FIELDS.map((rule) => rule.field),
);

/**
 * The MESSAGE_DELETE identity-partial contract table (issue #279): what
 * normalizeFluxerMessageDelete guarantees from BOTH source shapes (raw
 * wire snake_case, SDK PartialMessage camelCase). Deliberately NOT the
 * message table — a delete partial has no author/content by design, and
 * requiring those would reject legitimate deletes (see the header's
 * DELETE-IDENTITY PARTIAL block for the per-field rationale).
 */
const DELETE_CONTRACT_FIELDS = Object.freeze(
  Object.freeze([
    Object.freeze({
      field: "platform",
      expect: 'the platform tag "discord" or "fluxer"',
      nullable: false,
      check: isPlatformTag,
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
      expect:
        "a non-empty string id (the community-resolvable guild anchor — guild-less deletes never normalize)",
      nullable: false,
      check: isIdString,
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
  ]),
);

/** Required delete-partial fields, in check order (drift-lock tests). */
const REQUIRED_DELETE_FIELDS = Object.freeze(
  DELETE_CONTRACT_FIELDS.map((rule) => rule.field),
);

/**
 * The NormalizedDmMessage contract table (issue #279): exactly the
 * §10.3-delta-1 typedef normalizeFluxerDmMessage emits — no community
 * fields by construction (a DM has no community).
 */
const DM_CONTRACT_FIELDS = Object.freeze(
  Object.freeze([
    Object.freeze({
      field: "platform",
      expect: 'the platform tag "discord" or "fluxer"',
      nullable: false,
      check: isPlatformTag,
    }),
    Object.freeze({
      field: "instanceKey",
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
      field: "id",
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
  ]),
);

/** Required DM fields, in check order (drift-lock tests iterate). */
const REQUIRED_DM_FIELDS = Object.freeze(
  DM_CONTRACT_FIELDS.map((rule) => rule.field),
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
 * Shape descriptors: the ONLY per-shape variation the shared runner needs
 * to keep every error line self-identifying (log tag + subject naming +
 * which id field the "reproducible from logs alone" suffix prints).
 */
const MESSAGE_SHAPE = Object.freeze({
  logTag: "normalized-message-contract",
  subject: "message",
  label: "normalized message",
  idField: "id",
  idLabel: "message",
  noId: "<no valid id>",
});
const REACTION_SHAPE = Object.freeze({
  logTag: "normalized-reaction-contract",
  subject: "reaction",
  label: "normalized reaction",
  idField: "messageId",
  idLabel: "message",
  noId: "<no valid message id>",
});
const DELETE_SHAPE = Object.freeze({
  logTag: "normalized-delete-contract",
  subject: "delete",
  label: "normalized delete partial",
  idField: "id",
  idLabel: "message",
  noId: "<no valid id>",
});
const DM_SHAPE = Object.freeze({
  logTag: "normalized-dm-contract",
  subject: "DM",
  label: "normalized DM",
  idField: "id",
  idLabel: "message",
  noId: "<no valid id>",
});

/**
 * The shared check loop for every shape (issue #201 idiom, reused by
 * #279): walk the field table IN ORDER, throw on the FIRST violation
 * naming field + platform + the identifying id. Returns the payload for
 * inline use at the boundary (identity pass-through — never copies or
 * mutates).
 *
 * @param {{ logTag: string, subject: string, label: string, idField: string, idLabel: string, noId: string }} shape
 * @param {ReadonlyArray<{ field: string, expect: string, nullable: boolean, check: (v: unknown) => boolean }>} fields
 * @param {unknown} value the adapter's normalized payload
 * @param {string} boundary names the entry point in the failure text
 * @returns {object} the same payload, contract-checked
 * @throws {NormalizedMessageContractError} naming the FIRST violated field
 *   and the platform ("unknown" when the platform tag itself is the violation)
 */
function assertShapeContract(shape, fields, value, boundary) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NormalizedMessageContractError(
      `[${shape.logTag}] ${boundary}: ${shape.subject} is not an object ` +
        `(got ${describeValue(value)}, platform "unknown") — every required ` +
        "field is missing",
      { field: `(whole ${shape.subject})`, platform: "unknown" },
    );
  }

  for (const rule of fields) {
    const fieldValue = value[rule.field];
    if (rule.check(fieldValue)) continue;

    // Name the platform the ADAPTER claimed when it is trustworthy; the
    // violation may be the platform tag itself.
    const rawPlatform = value.platform;
    const platform = isPlatformTag(rawPlatform) ? rawPlatform : "unknown";
    const idValue = value[shape.idField];
    throw new NormalizedMessageContractError(
      `[${shape.logTag}] ${boundary}: platform "${platform}" ${shape.label} fails required field "${rule.field}" — expected ` +
        `${rule.expect}${rule.nullable ? "" : " (null is NOT allowed)"}, got ` +
        `${describeValue(fieldValue)} (${shape.idLabel} ${isIdString(idValue) ? idValue : shape.noId})`,
      { field: rule.field, platform },
    );
  }
  return value;
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
  return assertShapeContract(MESSAGE_SHAPE, CONTRACT_FIELDS, message, boundary);
}

/**
 * Assert the NormalizedReaction contract (issue #279) — the shape
 * normalizeFluxerReaction guarantees on BOTH producer paths — and return
 * the reaction (identity pass-through).
 *
 * @param {unknown} reaction the normalizer's output entering the reaction pipeline
 * @param {{ boundary?: string }} [opts] entry-point name in the failure text
 * @returns {object} the same reaction, contract-checked
 * @throws {NormalizedMessageContractError}
 */
function assertNormalizedReaction(reaction, { boundary = "onFluxerReactionAdd" } = {}) {
  return assertShapeContract(REACTION_SHAPE, REACTION_CONTRACT_FIELDS, reaction, boundary);
}

/**
 * Assert the MESSAGE_DELETE identity-partial contract (issue #279) — the
 * six keys normalizeFluxerMessageDelete emits from either source shape.
 * NEVER validate delete partials with assertNormalizedMessage: the intake
 * consumes identity only, and full-message rules would reject every
 * legitimate partial delete.
 *
 * @param {unknown} partial the delete normalizer's output entering the pipeline
 * @param {{ boundary?: string }} [opts] entry-point name in the failure text
 * @returns {object} the same partial, contract-checked
 * @throws {NormalizedMessageContractError}
 */
function assertNormalizedDelete(partial, { boundary = "onFluxerMessageDelete" } = {}) {
  return assertShapeContract(DELETE_SHAPE, DELETE_CONTRACT_FIELDS, partial, boundary);
}

/**
 * Assert the NormalizedDmMessage contract (issue #279) — the §10.3 delta 1
 * typedef, which by construction carries NO community fields — and return
 * the DM (identity pass-through).
 *
 * @param {unknown} dm normalizeFluxerDmMessage output entering the DM fan-out
 * @param {{ boundary?: string }} [opts] entry-point name in the failure text
 * @returns {object} the same DM, contract-checked
 * @throws {NormalizedMessageContractError}
 */
function assertNormalizedDm(dm, { boundary = "onDmMessage" } = {}) {
  return assertShapeContract(DM_SHAPE, DM_CONTRACT_FIELDS, dm, boundary);
}

module.exports = {
  assertNormalizedMessage,
  assertNormalizedReaction,
  assertNormalizedDelete,
  assertNormalizedDm,
  NormalizedMessageContractError,
  REQUIRED_NORMALIZED_FIELDS,
  REQUIRED_REACTION_FIELDS,
  REQUIRED_DELETE_FIELDS,
  REQUIRED_DM_FIELDS,
};
