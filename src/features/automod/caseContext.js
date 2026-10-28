/**
 * Auto-moderation case-context collector (#727, epic #723).
 *
 * Builds the evidence bundle the LLM harness (#728) reads for one recorded
 * case. PURE GATHERING ONLY (issue #727, verbatim law):
 *  - No sanctions. `createWarning` / `createStaffNote` are not even imported
 *    — nothing on any path of this module can write them (the tests pin zero
 *    rows after every path; #731 owns notes, the executor #729 owns
 *    warnings).
 *  - No mode/settings/pause/master-switch gate here: intake already refused
 *    the broken configs, and the harness owns run gating. The ONE settings
 *    fact this collector requires is the RULES TEXT (a case that was recorded
 *    before an admin cleared the rules has nothing to judge against →
 *    specific error).
 *
 * Always included (contract): the guild rules text; the referral block
 * (referrer id, explanation, message link, named user — read from the
 * `automod_cases` row through the db facade); the bounded message window;
 * and the referred user's existing warnings + existing staff notes.
 *
 * Window math mirrors Gork `read_discord` (roadmap/gork.md §7.19.2,
 * decisions 45/46 — gork stays READ-ONLY, everything is imported):
 *  - Anchor (message) referral: the anchor plus up to
 *    READ_DISCORD_BEFORE_WINDOW (40) older / READ_DISCORD_AFTER_WINDOW (10)
 *    newer. The caps are enforced AGAIN after merging (a nearest-40 /
 *    nearest-10 re-cap), so an over-delivering producer can never bloat the
 *    prompt past the contract cap.
 *  - User-only referral: the subject's recent messages across channels the
 *    REFERRER can view — asker parity, decision-46 mechanics. Channels the
 *    referrer cannot view are NEVER fetched (fail-closed permission reads,
 *    same #475 posture as readDiscord.permsAllow) and counted into
 *    `window.channels_skipped_not_visible`. The scan is bounded by the
 *    AUTOMOD_CONTEXT_USER_SCAN_* constants (≤15 fetched channels × ≤25
 *    messages per fetch, ≤100 collected messages) — never a whole-server
 *    promise. Open help tickets are excluded from the scan (decision-46's
 *    ticket blackout, carried over: the judge reads what the referrer could
 *    read in ordinary channels, not someone's open ticket conversation).
 *
 * Participants vs subjects (locked decisions 4/5):
 *  - Every window author id lands in `participant_user_ids` (deduped) —
 *    context for the case card ("who was seen and not considered").
 *  - EXACTLY ONE subject gets records preloaded: the explicitly referred
 *    user (named target), else the anchor message's author. Bystanders get
 *    nothing preloaded; the model pulls them via the read_warnings /
 *    read_staff_notes lookup tools (`./lookups.js`) when it actually
 *    considers them.
 *
 * Privacy: this collector NEVER composes ticket or warning-DM text. Staff
 * notes and full warning history stay in harness + staff-channel scope —
 * #735 must scrub member-visible ticket text before anything returned here
 * could ever reach it, and #730's card lives in the (staff-only) automod
 * channel. Window message content is RAW DATA, not rendered copy: any
 * renderer quoting it must escape markdown/mentions first (the #745
 * fenced-code-block / inlineEscape convention in
 * `src/features/tickets/reportEvidence.js` is the reference — that module
 * builds embeds, this one builds data).
 *
 * Error contract (AGENTS.md rules 2/3/6): never throws, never replies to
 * Discord. Every failure is `{ ok: false, error }` with a specific cause and
 * a `[automod]` log line carrying community/guild/case ids (every read is
 * try/catch'd — a rejection surfaces its own cause, never "something
 * failed"). Production Discord reads default to `deps.client` (discord.js
 * v14); tests inject fakes through the same seam (refer.js `ReferDeps`
 * style).
 *
 * Thread messages are OUT OF SCOPE for v1: a window contains channel-level
 * messages only (no thread walk) — documented in docs/automod.md.
 */

const { PermissionFlagsBits } = require("discord.js");
const { sliceSafe } = require("../../core/text");
const {
  getAutomodCase,
  listWarnings,
  listStaffNotes,
  getTicketByChannel,
} = require("../../db");
const {
  AUTOMOD_CONTEXT_USER_SCAN_MAX_CHANNELS,
  AUTOMOD_CONTEXT_USER_SCAN_PER_CHANNEL,
  AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES,
  AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
  AUTOMOD_REFER_READ_MAX,
} = require("./constants");
const { readSettings } = require("./settings");
const { projectWarningRow, projectNoteRow } = require("./lookups");
const {
  READ_DISCORD_BEFORE_WINDOW,
  READ_DISCORD_AFTER_WINDOW,
  READ_DISCORD_MESSAGE_CHAR_CAP,
} = require("../gork/constants");
const { sortOldestFirst } = require("../gork/tools/readDiscord");

/**
 * Bundle schema tag so #728/#730 can pin the shape they were built for.
 * /2 (#771): `referral.required_context` joins the bundle and the window
 * counts become PER-CASE (the modal decides; `meta.caps` reports what this
 * case actually used).
 */
const CONTEXT_SCHEMA = "automod-case-context/2";

/**
 * The window ONE case reads (#771 §2): the per-case `read_before` /
 * `read_after` captured by the referral modal (each clamped 0–500),
 * falling back to the historical Gork-owned 40/10 for rows written before
 * #771 — legacy cases keep the window they were filed under, new cases get
 * the modal's 100/20 defaults. The CARD renders this same effective pair
 * (`**Window:**` line) — one reader, no drift.
 *
 * @param {object|null} caseRow the automod_cases row
 * @returns {{ before: number, after: number }}
 */
function effectiveReadWindow(caseRow) {
  const clamp = (v, fallback) => {
    if (v == null || v === "") return fallback;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(AUTOMOD_REFER_READ_MAX, Math.max(0, n));
  };
  return {
    before: clamp(caseRow?.read_before, READ_DISCORD_BEFORE_WINDOW),
    after: clamp(caseRow?.read_after, READ_DISCORD_AFTER_WINDOW),
  };
}

/**
 * Fetch ONE window direction with multi-pass pagination (#771 §2: a
 * 500-back read is five Discord pages). Discord caps ONE fetch at 100
 * messages, so past that the cursor walks away from the anchor. A throw
 * anywhere (rate limit, dead channel, mid-pagination API error)
 * PROPAGATES: the caller's fail-closed law refuses to judge a case on a
 * half-read window — never analyze a silently truncated read.
 *
 * @param {{ fetchChannelMessages: Function }} d context deps
 * @param {object} channel guild channel holding the anchor
 * @param {string|number} anchorId anchor message id (the cursor seed)
 * @param {"before"|"after"} key which side of the anchor
 * @param {number} want how many messages this direction wants
 * @returns {Promise<object[]>} deduped, anchor excluded
 */
async function fetchWindowDirection(d, channel, anchorId, key, want) {
  const limit = Math.max(0, Math.floor(Number(want) || 0));
  if (limit <= 0) return [];
  const PAGE_MAX = 100; // Discord's per-fetch cap — the reason this paginates
  const out = [];
  const seen = new Set([String(anchorId)]);
  let cursor = String(anchorId);
  for (;;) {
    const pageWant = Math.min(PAGE_MAX, limit - out.length);
    if (pageWant <= 0) break;
    const page = toMessageArray(
      await d.fetchChannelMessages(channel, { limit: pageWant, [key]: cursor }),
    );
    if (page.length === 0) break;
    const ids = [];
    for (const m of page) {
      if (m?.id == null) continue;
      const id = String(m.id);
      ids.push(id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(m);
    }
    if (ids.length === 0) break;
    // Walk the cursor AWAY from the anchor: oldest id for `before`, newest
    // for `after` (snowflakes are time-ordered digit strings — compare as
    // BigInt, never lexicographically).
    cursor = ids.reduce((a, b) =>
      key === "before" ? (BigInt(b) < BigInt(a) ? b : a) : BigInt(b) > BigInt(a) ? b : a,
    );
    if (page.length < pageWant) break; // channel edge reached on this side
    if (out.length >= limit) break;
  }
  return out;
}

// ── small readers ──────────────────────────────────────────────────────────

/** Empty/whitespace → null (refer/automodCases idiom). */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * Collection/array/single-object tolerance — same duck-typing contract as
 * readDiscord.toMessageArray (kept local; gork does not export it).
 * @param {unknown} result
 * @returns {object[]}
 */
function toMessageArray(result) {
  if (Array.isArray(result)) return result.filter(Boolean);
  if (result && typeof result.values === "function") {
    return [...result.values()].filter(Boolean);
  }
  if (result && typeof result === "object" && result.id) return [result];
  return [];
}

/** Iterable/array of channels → array (Collection from cache tolerated). */
function toChannelArray(result) {
  if (Array.isArray(result)) return result.filter(Boolean);
  if (result && typeof result.values === "function") {
    return [...result.values()].filter(Boolean);
  }
  if (result && typeof result[Symbol.iterator] === "function") {
    return [...result].filter(Boolean);
  }
  return [];
}

/** The guild a duck-typed channel belongs to (null when the fake hides it). */
function channelGuildId(channel) {
  const raw = channel?.guildId ?? channel?.guild?.id ?? null;
  return raw == null ? null : String(raw);
}

/** ISO timestamp for a window message; null when it carries none (readDiscord's lineTimestamp data-twin). */
function messageTimestamp(message) {
  try {
    const created =
      message?.createdTimestamp ??
      (message?.createdAt instanceof Date
        ? message.createdAt.getTime()
        : Date.parse(message?.createdAt || "") || 0);
    return created ? new Date(created).toISOString() : null;
  } catch {
    return null;
  }
}

/** Attachment file NAMES only (metadata per contract; no URLs/binary leak). */
function attachmentNames(message) {
  const attachments = message?.attachments;
  if (!attachments) return [];
  const list = Array.isArray(attachments)
    ? attachments
    : typeof attachments.values === "function"
      ? [...attachments.values()]
      : [];
  return list
    .map((a) => optionalText(a?.name))
    .filter((name) => name != null);
}

/** Author id of a duck-typed message (string|null). */
function authorIdOf(message) {
  return optionalText(message?.author?.id ?? message?.authorId);
}

/**
 * One fetched message → the bundle's window-message shape: plain JSON-able,
 * ids as strings, content capped at Gork's READ_DISCORD_MESSAGE_CHAR_CAP
 * (500, code-point-safe) with an honest `content_truncated` flag so the
 * harness knows the judge saw an excerpt, never silently.
 */
function projectWindowMessage(message, { channelId, isAnchor = false }) {
  const raw = String(message?.content ?? "");
  const content = sliceSafe(raw, READ_DISCORD_MESSAGE_CHAR_CAP);
  return {
    id: String(message?.id ?? ""),
    channel_id: channelId == null ? null : String(channelId),
    author_id: authorIdOf(message),
    content,
    content_truncated: content.length < raw.length,
    timestamp: messageTimestamp(message),
    attachments: attachmentNames(message),
    is_anchor: isAnchor === true,
  };
}

// ── permission checks (fail CLOSED — #475 posture, readDiscord.permsAllow) ─

function permsHas(perms, flag) {
  if (!perms || typeof perms.has !== "function") return false;
  try {
    return perms.has(flag) === true;
  } catch {
    return false; // a throwing perm surface fails closed
  }
}

/**
 * ViewChannel for a concrete member on a concrete channel. Missing/garbage
 * permission surface = FALSE: the collector reads only what the referrer
 * could read themselves (asker parity, decision 46), so an unverifiable
 * read is refused rather than trusted.
 */
function memberCanView(channel, member, flag = PermissionFlagsBits.ViewChannel) {
  try {
    if (!channel || !member) return false;
    if (typeof channel.permissionsFor !== "function") return false;
    return permsHas(channel.permissionsFor(member), flag);
  } catch (err) {
    console.error(
      `[automod] case-context channel permission read failed (channel ${channel?.id ?? "?"}):`,
      err?.message || err,
    );
    return false;
  }
}

// ── logging + failure shape (AGENTS.md rules 2/3/6) ────────────────────────

function idTag({ communityId, guildId, caseNumber }) {
  return `(community ${communityId ?? "?"} guild ${guildId ?? "?"} case A-${caseNumber ?? "?"})`;
}

/** The ONE failure exit: log with ids, return the service shape. */
function fail(what, ids, error, cause = null) {
  console.error(
    `[automod] case-context ${what} failed ${idTag(ids)}:`,
    cause?.message || cause || error,
  );
  return { ok: false, error };
}

// ── production deps (discord.js v14 behind the seam, executor posture) ─────

/**
 * @typedef {object} ContextDeps
 * @property {(guildId: string, channelId: string) => Promise<object|null|undefined>|object|null} getGuildChannel
 *   Guild channel by id; null for deleted/unknown.
 * @property {(guildId: string, userId: string) => Promise<object|null|undefined>|object|null} getMember
 *   Guild member; MUST resolve null for a non-member (10013), may reject on
 *   a real read failure (absence and failure get different, honest errors).
 * @property {(guildId: string) => Promise<object|null|undefined>|object|null} getBotMember
 *   Bot member (optional bot-side readability pre-check; null skips it).
 * @property {(guildId: string) => Promise<Iterable<object>|object[]>|Iterable<object>|object[]} listTextChannels
 *   The guild's text-bearing channels (production: the channel cache — the
 *   scan is bounded and cache-scoped by design, never a channel-list crawl).
 * @property {(channel: object, opts: object|string) => Promise<unknown>} fetchChannelMessages
 *   `channel.messages.fetch(opts)`: a message id (single) or
 *   `{ limit, before?|after? }` (window) — the exact readDiscord fetcher
 *   contract. May reject with code 10003 (unknown message / gone edge).
 * @property {(communityId: number, channelId: string) => Promise<object|null|undefined>|object|null} getTicketByChannel
 *   `tickets` row for a channel (open-ticket blackout); null = not a ticket.
 */

/**
 * Default deps over `deps.client` (discord.js v14 Client). Each seam is
 * individually overridable (shallow merge, explicit wins — executor
 * `buildDefaultDeps` pattern). Without a client the Discord seams throw the
 * specific "no Discord client" error, which every call site converts to
 * `{ ok:false }` — fail closed, never a silent empty window.
 *
 * `getBotMember` is the one lenient default (resolves null without a
 * client): it backs an OPTIONAL courtesy pre-check; the real fetch stays the
 * gate either way.
 *
 * @param {Partial<ContextDeps> & {client?: object}} [deps]
 * @returns {ContextDeps}
 */
function buildDefaultDeps(deps = {}) {
  const guildOf = (guildId) => {
    const client = deps?.client;
    if (!client?.guilds?.cache?.get) {
      throw new Error(
        "no Discord client on deps — inject deps.client (or explicit deps seams) for the Discord-backed reads",
      );
    }
    const guild = client.guilds.cache.get(String(guildId));
    if (!guild) throw new Error(`guild ${guildId} is not cached by this client`);
    return guild;
  };

  const base = {
    async getGuildChannel(guildId, channelId) {
      const guild = guildOf(guildId);
      const id = String(channelId);
      const cached = guild.channels?.cache?.get?.(id) ?? null;
      if (cached) return cached;
      try {
        return (await guild.channels?.fetch?.(id)) ?? null;
      } catch {
        return null; // deleted / unknown / no access — "gone" reads honestly as null
      }
    },
    async getMember(guildId, userId) {
      const guild = guildOf(guildId);
      const id = String(userId);
      const cached = guild.members?.cache?.get?.(id) ?? null;
      if (cached) return cached;
      try {
        return (await guild.members?.fetch?.(id)) ?? null;
      } catch (err) {
        if (err?.code === 10013) return null; // Unknown Member = not a member
        throw err;
      }
    },
    async getBotMember(guildId) {
      try {
        const guild = guildOf(guildId);
        return guild.members?.me ?? null;
      } catch {
        return null; // optional pre-check only — skip silently
      }
    },
    listTextChannels(guildId) {
      const guild = guildOf(guildId);
      const cache = guild.channels?.cache;
      const all = Array.isArray(cache) ? cache : cache?.values ? [...cache.values()] : [];
      return all.filter((ch) => {
        try {
          return ch != null && typeof ch.isTextBased === "function" && ch.isTextBased() === true;
        } catch {
          return false;
        }
      });
    },
    fetchChannelMessages(channel, opts) {
      return channel?.messages?.fetch?.(opts);
    },
    async getTicketByChannel(communityId, channelId) {
      return getTicketByChannel(Number(communityId), String(channelId)) ?? null;
    },
  };

  return { ...base, ...deps };
}

// ── anchor window math ─────────────────────────────────────────────────────

/**
 * Re-apply the contract caps on ALREADY-MERGED, oldest→newest messages:
 * the anchor plus the nearest `beforeCap` older and nearest `afterCap`
 * newer. Snowflake ids are fixed-width, so lexicographic comparison is
 * chronological (readDiscord's sortOldestFirst contract). An honest
 * producer never exceeds the caps (the fetches ask for exactly that many)
 * — this is the belt so an over-delivering one cannot bloat the prompt.
 *
 * @param {object[]} messagesOldestFirst
 * @param {string} anchorId
 * @param {number} beforeCap
 * @param {number} afterCap
 * @returns {object[]} oldest→newest, anchor included — empty when the set
 *   carries no anchor (never an orphaned surround)
 */
function capAroundAnchor(messagesOldestFirst, anchorId, beforeCap, afterCap) {
  const anchor = String(anchorId);
  const before = [];
  const after = [];
  let anchorMessage = null;
  for (const m of messagesOldestFirst) {
    const id = String(m?.id ?? "");
    if (id === anchor) {
      anchorMessage = m;
      continue;
    }
    if (id < anchor) before.push(m);
    else if (id > anchor) after.push(m);
  }
  // No anchor in the set = no anchored window (never orphan the surround).
  if (!anchorMessage) return [];
  const kept = before.slice(-beforeCap);
  kept.push(anchorMessage);
  kept.push(...after.slice(0, afterCap));
  return kept;
}

// ── the collector ──────────────────────────────────────────────────────────

/**
 * Assemble the evidence bundle for one recorded case.
 *
 * @param {object} opts
 * @param {number} opts.communityId
 * @param {string} opts.guildId                 Discord guild snowflake (Discord-only feature)
 * @param {number|string|null} [opts.caseNumber] A-n number (looked up via the facade)…
 * @param {object|null} [opts.case]              …or the already-loaded case row (harness hot path)
 * @param {string|null} [opts.referrerUserId]    optional cross-check — must MATCH the row's referrer
 * @param {Partial<ContextDeps> & {client?: object}} [opts.deps]
 * @param {number} [opts.nowMs]                  injectable clock for meta.collected_at
 * @returns {Promise<
 *   | { ok: true, context: object }
 *   | { ok: false, error: string }
 * >}
 */
async function buildCaseContext({
  communityId = null,
  guildId = null,
  caseNumber = null,
  case: caseInput = null,
  referrerUserId = null,
  deps = {},
  nowMs = Date.now(),
} = {}) {
  const cid = Number(communityId);
  const gid = optionalText(guildId);
  const ids = {
    communityId: Number.isInteger(cid) ? cid : null,
    guildId: gid,
    caseNumber: caseInput?.case_number ?? caseNumber,
  };

  try {
    // ── input validation (specific, logged; nothing read yet) ─────────────
    if (!Number.isInteger(cid) || cid < 1) {
      return fail("input", ids, "A valid integer communityId is required — the case context cannot be assembled without it.");
    }
    if (!gid) {
      return fail("input", ids, "A guildId (Discord snowflake) is required — auto-moderation is Discord-only for this milestone (#723 decision 8).");
    }
    if (caseInput != null && Number(caseInput.community_id) !== cid) {
      return fail(
        "case lookup",
        ids,
        `The supplied case row belongs to community ${caseInput.community_id}, not ${cid} — refusing to mix communities.`,
      );
    }

    // ── the case row (facade; the same rows intake wrote in #726) ─────────
    let row = caseInput;
    if (row == null) {
      row = getAutomodCase(cid, caseNumber);
    }
    if (!row) {
      return fail("case lookup", ids, `No auto-mod case A-${caseNumber ?? "?"} in this community — there is nothing to gather.`);
    }
    ids.caseNumber = row.case_number;

    // ── the referrer (visibility principal; the row is the truth) ─────────
    const rowReferrer = optionalText(row.referrer_user_id);
    const paramReferrer = optionalText(referrerUserId);
    if (rowReferrer == null) {
      return fail("referrer", ids, `Case A-${row.case_number} has no referrer user id — the referral's view cannot be re-verified, so no Discord reads are performed.`);
    }
    if (paramReferrer != null && paramReferrer !== rowReferrer) {
      return fail(
        "referrer",
        ids,
        `Referrer mismatch: case A-${row.case_number} was filed by ${rowReferrer}, not ${paramReferrer} — context is gathered under the REFERRER's view only (asker parity), never a borrowed one.`,
      );
    }
    const referrer = rowReferrer;

    // ── the rules text (the one settings fact a judgment needs) ───────────
    const read = readSettings(cid);
    if (!read.ok) return read; // settings service is already specific + logged
    const rules = read.settings.rules;
    if (!rules) {
      return fail(
        "rules",
        ids,
        `**Automod rules:** the guild rules text is empty — it was cleared (or never set) after case A-${row.case_number} was recorded. ` +
          "The judge has nothing to judge against; an admin must run `/automodconfig rules set` before this case can run.",
      );
    }

    const d = buildDefaultDeps(deps ?? {});

    // ── the referrer's member row (asker-parity anchor for every read) ────
    let referrerMember = null;
    try {
      referrerMember = (await d.getMember(gid, referrer)) ?? null;
    } catch (err) {
      return fail(
        "referrer read",
        ids,
        `Could not check the referring staff member's access (${err?.message || err}) — reads fail closed and nothing was gathered.`,
        err,
      );
    }
    if (!referrerMember) {
      return fail(
        "referrer read",
        ids,
        `**Referrer gone:** <@${referrer}> is no longer a member of this server — referrals are judged with the referrer's view ` +
          `(asker parity, the Gork decision-46 rule), so case A-${row.case_number} cannot be gathered.`,
      );
    }

    const anchorChannelId = optionalText(row.channel_id);
    const anchorMessageId = optionalText(row.message_id);
    const namedTarget = optionalText(row.target_user_id);

    let windowBlock;
    let anchorMessage = null;

    if (anchorMessageId != null || anchorChannelId != null) {
      // ── MESSAGE window: anchor + bounded surround (decision-45 math) ────
      if (anchorMessageId == null || anchorChannelId == null) {
        return fail(
          "anchor consistency",
          ids,
          `Case A-${row.case_number} has a referred message id and channel half-set (message ${anchorMessageId ?? "none"}, channel ${anchorChannelId ?? "none"}) — intake never stores that shape, so the row is inconsistent and no window was read.`,
        );
      }

      let channel = null;
      try {
        channel = (await d.getGuildChannel(gid, anchorChannelId)) ?? null;
      } catch (err) {
        return fail("anchor channel read", ids, `Could not read the source channel <#${anchorChannelId}> (${err?.message || err}) — nothing was gathered.`, err);
      }
      if (!channel) {
        return fail(
          "anchor channel read",
          ids,
          `**Channel gone:** <#${anchorChannelId}> that holds the referred message no longer exists — the anchor cannot be read, so case A-${row.case_number} has no message window.`,
        );
      }
      const chGuild = channelGuildId(channel);
      if (chGuild != null && chGuild !== gid) {
        return fail(
          "anchor channel guild",
          ids,
          `Channel ${anchorChannelId} belongs to guild ${chGuild}, not ${gid} — cross-guild reads are refused (guild isolation, the decision-46 rule).`,
        );
      }
      // Honest RE-CHECK of intake's viewability gate (the referrer may have
      // lost access since the referral was filed).
      if (!memberCanView(channel, referrerMember)) {
        return fail(
          "anchor viewability",
          ids,
          `**Channel not visible:** the referring staff member (<@${referrer}>) cannot view <#${anchorChannelId}> anymore — its messages cannot be read into the case context.`,
        );
      }
      // Optional bot-side courtesy pre-check (readDiscord posture): only
      // refuses when the bot member is actually resolvable and definitely
      // cannot read; otherwise the real fetch below names the true cause.
      let botMember = null;
      try {
        botMember = (await d.getBotMember(gid)) ?? null;
      } catch {
        botMember = null; // optional check — a dead seam must not add a failure
      }
      if (botMember && !memberCanView(channel, botMember)) {
        return fail(
          "anchor bot access",
          ids,
          `**Bot access:** I cannot view <#${anchorChannelId}> — grant View Channel (and Read Message History) so the anchor can be read, or the case has no message window.`,
        );
      }
      if (
        botMember &&
        !memberCanView(channel, botMember, PermissionFlagsBits.ReadMessageHistory)
      ) {
        return fail(
          "anchor bot access",
          ids,
          `**Bot access:** I cannot read message history in <#${anchorChannelId}> — grant Read Message History so the anchor window can be read.`,
        );
      }

      const singleErrIsGone = (err) => err?.code === 10003;
      let anchor = null;
      try {
        anchor = (await d.fetchChannelMessages(channel, String(anchorMessageId))) ?? null;
      } catch (err) {
        if (!singleErrIsGone(err)) {
          return fail(
            "anchor fetch",
            ids,
            `Could not read the referred message (${err?.message || err}) — refusing to judge case A-${row.case_number} on a half-read window.`,
            err,
          );
        }
        anchor = null;
      }
      if (!anchor || anchor.id == null) {
        return fail(
          "anchor fetch",
          ids,
          `**Message gone:** the referred message (${anchorMessageId}) no longer exists (deleted or unknown id) — case A-${row.case_number} has no anchor to gather around.`,
        );
      }

      // #771 §2: the PER-CASE window (modal values, clamped; legacy rows
      // keep 40/10). Each side paginates past Discord's 100-per-fetch cap;
      // a mid-pagination throw lands in the fail-closed catch below — a
      // half-read window is NEVER analyzed.
      const { before: wantBefore, after: wantAfter } = effectiveReadWindow(row);
      let before = [];
      let after = [];
      try {
        [before, after] = await Promise.all([
          fetchWindowDirection(d, channel, anchor.id, "before", wantBefore),
          fetchWindowDirection(d, channel, anchor.id, "after", wantAfter),
        ]);
      } catch (err) {
        // A GONE window edge (10003 on a bulk page — never in practice) is
        // as unreadable as any other rejection: surface the cause honestly.
        return fail(
          "window fetch",
          ids,
          `Could not read the messages around the anchor (${err?.message || err}) — refusing to judge case A-${row.case_number} on a half-read window.`,
          err,
        );
      }

      const merged = new Map([[String(anchor.id), anchor]]);
      for (const m of [...toMessageArray(before), ...toMessageArray(after)]) {
        if (m?.id != null) merged.set(String(m.id), m);
      }
      const capped = capAroundAnchor(
        sortOldestFirst([...merged.values()]),
        String(anchor.id),
        wantBefore,
        wantAfter,
      );
      anchorMessage = anchor;
      windowBlock = {
        kind: "message_anchor",
        channel_id: String(anchorChannelId),
        anchor_message_id: String(anchor.id),
        messages: capped.map((m) =>
          projectWindowMessage(m, {
            channelId: anchorChannelId,
            isAnchor: String(m?.id) === String(anchor.id),
          }),
        ),
        truncated: false,
        channels_scanned: 1,
        channels_skipped_not_visible: 0,
        channels_skipped_ticket: 0,
        channels_skipped_error: 0,
      };
    } else {
      // ── USER-ONLY window: bounded scan with asker parity ────────────────
      if (namedTarget == null) {
        return fail(
          "target",
          ids,
          `Case A-${row.case_number} has neither a referred message nor a named user — intake guarantees at least one, so the row is inconsistent and nothing was gathered.`,
        );
      }
      let channels;
      try {
        channels = toChannelArray(await d.listTextChannels(gid));
      } catch (err) {
        return fail(
          "channel scan",
          ids,
          `Could not list the guild's channels for the user scan (${err?.message || err}) — nothing was gathered.`,
          err,
        );
      }

      const collected = []; // { message, channelId }
      let scanned = 0;
      let skippedNotVisible = 0;
      let skippedTicket = 0;
      let skippedError = 0;
      let truncated = false;

      for (const channel of channels) {
        if (
          channel?.id == null ||
          typeof channel?.messages?.fetch !== "function"
        ) {
          continue; // not a readable text-bearing channel — never counted as "private"
        }
        const chGuild = channelGuildId(channel);
        if (chGuild != null && chGuild !== gid) continue; // foreign guild — not ours to scan
        if (!memberCanView(channel, referrerMember)) {
          skippedNotVisible++; // referrer cannot see it → NEVER fetched (decision-46 parity)
          continue;
        }
        let ticket = null;
        try {
          ticket = (await d.getTicketByChannel(cid, String(channel.id))) ?? null;
        } catch (err) {
          console.error(
            `[automod] case-context ticket blackout read failed ${idTag({ communityId: cid, guildId: gid, caseNumber: row.case_number })} channel ${channel.id}:`,
            err?.message || err,
          );
          skippedTicket++; // fail CLOSED: an unclassifiable channel is not scanned
          continue;
        }
        if (ticket && !ticket.archived) {
          skippedTicket++; // open help ticket — decision-46 blackout
          continue;
        }
        if (scanned >= AUTOMOD_CONTEXT_USER_SCAN_MAX_CHANNELS) {
          truncated = true; // more scannable channels exist — bounded, disclosed
          break;
        }
        const remaining = AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES - collected.length;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        let page = [];
        try {
          page = toMessageArray(
            await d.fetchChannelMessages(channel, {
              limit: Math.min(AUTOMOD_CONTEXT_USER_SCAN_PER_CHANNEL, remaining),
            }),
          );
        } catch (err) {
          // Partial failure (rule 5): one dead channel does not kill the
          // scan — it is counted and logged with the case ids.
          console.error(
            `[automod] case-context user-scan channel fetch failed ${idTag({ communityId: cid, guildId: gid, caseNumber: row.case_number })} channel ${channel.id}:`,
            err?.message || err,
          );
          skippedError++;
          continue;
        }
        scanned++;
        if (
          page.length >=
          Math.min(AUTOMOD_CONTEXT_USER_SCAN_PER_CHANNEL, remaining)
        ) {
          // A full page means MORE subject history may sit beyond the fetch
          // cap — disclose the possibility instead of hiding it (the honest
          // `truncated` flag may over-report on an exactly-full last page).
          truncated = true;
        }
        for (const m of page) {
          if (authorIdOf(m) === namedTarget) {
            collected.push({ message: m, channelId: String(channel.id) });
          }
        }
      }

      // Newest-first selection (contract), then chronological display —
      // same reading order as the anchor window.
      collected.sort((a, b) => {
        const left = String(a?.message?.id ?? "");
        const right = String(b?.message?.id ?? "");
        if (left === right) return 0;
        return left < right ? 1 : -1; // newest first
      });
      let kept = collected;
      if (kept.length > AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES) {
        kept = kept.slice(0, AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES);
        truncated = true;
      }
      kept.reverse(); // oldest → newest for the bundle

      windowBlock = {
        kind: "user_recent",
        channel_id: null,
        anchor_message_id: null,
        messages: kept.map(({ message, channelId }) =>
          projectWindowMessage(message, { channelId, isAnchor: false }),
        ),
        truncated,
        channels_scanned: scanned,
        channels_skipped_not_visible: skippedNotVisible,
        channels_skipped_ticket: skippedTicket,
        channels_skipped_error: skippedError,
      };
    }

    // ── the SUBJECT: named target, else the anchor author — and ONLY this
    //    user gets records preloaded (locked decision 4: bystanders get
    //    nothing; the lookups tools serve real consideration) ──────────────
    const anchorAuthor = anchorMessage ? authorIdOf(anchorMessage) : null;
    const subject = namedTarget ?? anchorAuthor;
    const subjectBasis = namedTarget != null ? "named_target" : "anchor_author";
    if (subject == null) {
      return fail(
        "subject",
        ids,
        `Case A-${row.case_number} yields no judgment subject (no named user and the anchor carries no author id) — refusing to guess.`,
      );
    }

    // ── participants: every window author, deduped, INCLUDING the subject ─
    const participantUserIds = [];
    const seenAuthors = new Set();
    for (const m of windowBlock.messages) {
      const author = m.author_id;
      if (author != null && !seenAuthors.has(author)) {
        seenAuthors.add(author);
        participantUserIds.push(author);
      }
    }

    // ── preloaded judgment records (subject only) ─────────────────────────
    let warningRows = [];
    let noteRows = [];
    try {
      warningRows = listWarnings(cid, subject, {
        includeVoided: false, // judgment-complete = active + expired, voided excluded (module header)
        limit: AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
      });
    } catch (err) {
      return fail(
        "warnings read",
        ids,
        `Could not read the subject's warning history (${err?.message || err}) — refusing to judge case A-${row.case_number} half-informed.`,
        err,
      );
    }
    try {
      noteRows = listStaffNotes(cid, subject, {
        includeDeleted: false,
        limit: AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
      });
    } catch (err) {
      return fail(
        "notes read",
        ids,
        `Could not read the subject's staff notes (${err?.message || err}) — refusing to judge case A-${row.case_number} half-informed.`,
        err,
      );
    }

    // ── the bundle (plain JSON-able objects; ids as strings; no discord.js
    //    class instances leak — every window message is projected) ─────────
    const context = {
      schema: CONTEXT_SCHEMA,
      case: {
        id: Number(row.id),
        community_id: Number(row.community_id),
        guild_id: gid,
        case_number: Number(row.case_number),
        case_ref: `A-${row.case_number}`,
        status: row.status ?? null,
        created_at: Number(row.created_at) || null,
      },
      rules,
      referral: {
        referrer_user_id: String(referrer),
        // #771 §1: `note` now carries the modal's REQUIRED problem
        // statement; `required_context` is the optional "what the reviewer
        // needs to see or know" text, verbatim.
        note: optionalText(row.note),
        required_context: optionalText(row.required_context),
        channel_id: anchorChannelId,
        message_id: anchorMessageId,
        message_url:
          anchorMessageId != null && anchorChannelId != null
            ? `https://discord.com/channels/${gid}/${anchorChannelId}/${anchorMessageId}`
            : null,
        target_user_id: namedTarget,
      },
      subject: { user_id: String(subject), basis: subjectBasis },
      window: windowBlock,
      participant_user_ids: participantUserIds,
      subject_user_ids: [String(subject)],
      records: {
        subject_user_id: String(subject),
        warnings: warningRows.map(projectWarningRow),
        notes: noteRows.map(projectNoteRow),
        warnings_truncated: warningRows.length >= AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
        notes_truncated: noteRows.length >= AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
      },
      meta: {
        collected_at: Number(nowMs) || Date.now(),
        caps: {
          // What THIS case actually read: the per-case modal window for
          // anchor cases (#771 §2); the historical constants for the
          // user-only scan (its bound is the user_scan_* family below).
          before_window:
            windowBlock.kind === "message_anchor"
              ? effectiveReadWindow(row).before
              : READ_DISCORD_BEFORE_WINDOW,
          after_window:
            windowBlock.kind === "message_anchor"
              ? effectiveReadWindow(row).after
              : READ_DISCORD_AFTER_WINDOW,
          message_char_cap: READ_DISCORD_MESSAGE_CHAR_CAP,
          user_scan_max_channels: AUTOMOD_CONTEXT_USER_SCAN_MAX_CHANNELS,
          user_scan_per_channel: AUTOMOD_CONTEXT_USER_SCAN_PER_CHANNEL,
          user_scan_max_messages: AUTOMOD_CONTEXT_USER_SCAN_MAX_MESSAGES,
          records_page_max: AUTOMOD_CONTEXT_RECORDS_PAGE_MAX,
        },
      },
    };

    return { ok: true, context };
  } catch (err) {
    // Belt (rule 6): every known failure already returned {ok:false};
    // anything escaping to here is a bug — name the cause, still never throw.
    return fail(
      "unexpected",
      ids,
      `Could not assemble the case context: ${err?.message || err}`,
      err,
    );
  }
}

module.exports = {
  CONTEXT_SCHEMA,
  buildCaseContext,
  // Pure/testable pieces:
  buildDefaultDeps,
  capAroundAnchor,
  projectWindowMessage,
  // #771: the per-case effective window (the card renders it too) and the
  // multi-pass page walker (Discord's 100-per-fetch cap lives here).
  effectiveReadWindow,
  fetchWindowDirection,
};
