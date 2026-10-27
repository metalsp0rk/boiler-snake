/**
 * Staff referral into auto-moderation (#726, epic #723) — THE case-intake
 * seam. `/automod refer` (slash) and "Refer to automod" (message context
 * menu) are thin arms over {@link referToAutomod}; members have no command
 * for this and nothing in message-create opens a case (locked decision 1).
 *
 * Contract (issue #726, verbatim law):
 *  - BEFORE any state change the full refusal battery runs, each gate with
 *    its OWN specific ephemeral cause (`**Label:** value`, AGENTS.md error
 *    rule 3 — staff-facing text always names the cause, never "check logs").
 *  - The breaker pause is NOT a referral failure: this module never reads
 *    `isAutomodPaused`. A paused guild still records cases (contract-explicit;
 *    test-pinned). Only auto kick/ban/timeout enforcement is paused.
 *  - The daily budget is READ via getAutomodBudget and NOT consumed here.
 *    Consumption is "exactly once per ACCEPTED provider call" — that is the
 *    harness (#728) calling consumeAutomodCase when its provider call is
 *    accepted (repository contract, automodSettings.js). A recorded case that
 *    never reaches a provider does not count.
 *  - The referrer's note is CASE INPUT on the automod_cases row. It is not a
 *    staff_notes row, and the referrer is not a subject merely because they
 *    filed — nothing here writes staff notes (harness #731 owns notes for
 *    considered users, locked decision 4).
 *  - This issue stops at a stored case + the ack: the ack says the case is
 *    RECORDED and where recommendations will post — it never claims a
 *    recommendation was produced (the harness may not exist yet).
 *
 * #728 ADDITION (additive only — the ack copy stays byte-identical; tests
 * pin it): once the ack reply has RESOLVED, both command arms fire the
 * harness run DETACHED through an installable hook (`setRunCaseHook`,
 * wired by the feature's boot hook — index.js). No hook installed (unit
 * tests, degraded boot) → nothing fires. The fire carries its own
 * `.catch`: one referral can never produce an unhandled rejection nor
 * kill the interaction handler (AGENTS.md rule 1: detached async gets
 * its own catch, logged with the ids).
 *
 * Services never reply to Discord themselves and never throw: every failure
 * is `{ ok: false, error }` with a specific message, logged `[automod]` with
 * community/user ids (error rules 2 + 6); the command arms decide how to
 * surface it. Handler-side throws are caught, logged with ids, and answered
 * (error rule 1) — the routers already wrap, the context-menu arm wraps too
 * like the #745 report invokes do.
 */

const { PermissionFlagsBits } = require("discord.js");
const { requireStaff } = require("../../core/permissions");
const { replyEphemeral, safeErrorReply } = require("../../core/interaction");
const { recordSlashAudit } = require("../../core/auditTrail");
const { ensureCommunity } = require("../../platform/community");
const { sliceSafe } = require("../../core/text");
const { getAutomodBudget, createAutomodCase } = require("../../db");
const { AUTOMOD_REFER_NOTE_MAX_LEN } = require("./constants");
const { readSettings } = require("./settings");

/**
 * Strict message-link grammar: https, the production `discord.com` host or
 * the legacy `discordapp.com` host, `/channels/<guild>/<channel>/<message>`
 * with snowflake digit runs, nothing else attached. A BARE MESSAGE ID IS NOT
 * ACCEPTED — the contract requires the full link ("right-click → Copy Link");
 * the bare form carries no guild/channel to cross-check, so there is no
 * lenient mode (docs quote this).
 */
const MESSAGE_LINK_RE =
  /^https:\/\/(?:discord|discordapp)\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})$/;

// ── Specific refusal copy (each gate owns its string; docs/automod.md
//    quotes these byte-for-byte — grep before renaming) ────────────────────

const REFUSAL_SWITCH_OFF =
  "**Automod off:** the master switch is off here — an admin must run " +
  "`/automodconfig enable` before referrals can record cases.";

const REFUSAL_CHANNEL_UNSET =
  "**Automod channel:** not set — an admin must pick the case-card channel " +
  "with `/automodconfig channel set` before referrals can record cases.";

/** @param {string} channelId */
function refusalChannelUnpostable(channelId) {
  return (
    `**Automod channel:** <#${channelId}> is not postable right now — it is ` +
    "deleted, or I lack View Channel / Send Messages there. An admin must fix " +
    "it or re-set it with `/automodconfig channel set`."
  );
}

const REFUSAL_RULES_EMPTY =
  "**Automod rules:** not set — the judge needs the guild rules text. An " +
  "admin must run `/automodconfig rules set` first.";

const REFUSAL_BUDGET_BLOCKED =
  "**Daily budget:** blocked (`-1`) — every referral is refused until an " +
  "admin opens the budget with `/automodconfig budget`.";

/** @param {number} used @param {number} limit */
function refusalBudgetExhausted(used, limit) {
  return (
    `**Daily budget:** exhausted — ${used} of ${limit} cases used today ` +
    "(UTC day). Nothing was recorded — try again after the day rolls or " +
    "raise the cap with `/automodconfig budget`."
  );
}

const REFUSAL_TARGET_REQUIRED =
  "**Target required:** include at least one of `message:` (a message link) " +
  "or `user:` (the member) — nothing was recorded.";

/** @param {string} link raw option text (echo is length-clipped, rule 3) */
function refusalLinkFormat(link) {
  const shown = sliceSafe(String(link), 100);
  return (
    `**Message link:** \`${shown}\` is not a full message link — right-click ` +
    "→ Copy Link gives `https://discord.com/channels/<guild>/<channel>/" +
    "<message>` (a bare message id is not accepted). Nothing was recorded."
  );
}

/** @param {string} linkGuildId */
function refusalCrossGuild(linkGuildId) {
  return (
    `**Message link:** that message is from another server (` +
    `\`${linkGuildId}\`) — referrals must point at messages in this server. ` +
    "Nothing was recorded."
  );
}

const REFUSAL_MESSAGE_GONE =
  "**Message not found:** that message no longer exists — nothing was " +
  "recorded.";

/** @param {string} channelId */
function refusalChannelInvisible(channelId) {
  return (
    `**Channel not visible:** you cannot view <#${channelId}>, so its ` +
    "messages cannot be referred. Refer only what you can see — nothing was " +
    "recorded."
  );
}

/** @param {number} length @param {number} cap */
function refusalNoteTooLong(length, cap) {
  return (
    `**Note too long:** the referral note is ${length} characters — the cap ` +
    `is ${cap}. Shorten it — nothing was recorded.`
  );
}

/** Context-menu target the resolver could not deliver (reports idiom). */
const REFUSAL_TARGET_UNRESOLVED =
  "Could not resolve the referred message — it may have been deleted. " +
  "Nothing was recorded.";

/** Context-menu target authored by a bot or a system event. */
const REFUSAL_BOT_TARGET =
  "Cannot refer a bot or system message to automod — nothing was recorded.";

// ── small readers ──────────────────────────────────────────────────────────

/** Empty/whitespace → null; never store "" where "absent" is meant. */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * `channel.permissionsFor(member).has(flag)` behind a never-throw shell.
 * Anything unreadable (missing channel/member, dead fake, API shape) is
 * FALSE: postability and viewability are hard gates, so verification failure
 * fails CLOSED (refusing with the named cause beats posting into a void).
 *
 * @param {object|null} channel discord.js GuildChannel (or test fake)
 * @param {object|null} member  discord.js GuildMember (or test fake)
 * @param {Array<bigint>} flags PermissionFlagsBits values
 * @returns {boolean}
 */
function channelAllows(channel, member, flags) {
  try {
    if (!channel || !member) return false;
    if (typeof channel.permissionsFor !== "function") return false;
    const bits = channel.permissionsFor(member);
    if (!bits || typeof bits.has !== "function") return false;
    return flags.every((flag) => bits.has(flag) === true);
  } catch (err) {
    console.error(
      `[automod] refer channel permission read failed (channel ${channel?.id ?? "?"}):`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * Strict split of a message link into its three snowflake parts.
 * @param {string} link
 * @returns {{ guildId: string, channelId: string, messageId: string }|null}
 */
function parseMessageLink(link) {
  const match = MESSAGE_LINK_RE.exec(String(link ?? "").trim());
  if (!match) return null;
  return { guildId: match[1], channelId: match[2], messageId: match[3] };
}

/**
 * Build the referral ack — the ONE place the intake copy lives, so both
 * command arms and the docs stay byte-identical. The contract shape:
 * **Case:** A-n + recorded + where recommendations will post. It deliberately
 * says nothing was produced yet (the harness may not be merged, #728).
 *
 * @param {number} caseNumber
 * @param {string} automodChannelId
 * @returns {string}
 */
function buildReferAck(caseNumber, automodChannelId) {
  return (
    `Case: **A-${caseNumber}** — recorded.\n` +
    `Recommendations will post in <#${automodChannelId}>.`
  );
}

/**
 * Deps seam for everything Discord-shaped, so the service tests inject fakes
 * (ticket-reports-invoke posture). Production builds these from the raw
 * interaction via {@link makeDiscordDeps}.
 *
 * @typedef {object} ReferDeps
 * @property {(guildId: string, channelId: string) => object|null} getGuildChannel
 *   Guild channel from cache — null when missing/deleted/uncached.
 * @property {(guildId: string) => object|null} getBotMember
 *   The bot's GuildMember (permissions anchor for postability).
 * @property {(guildId: string, userId: string) => object|null} getMember
 *   Guild member by id (referrer anchor for viewability).
 * @property {(guildId: string, channelId: string, messageId: string) => Promise<object|null>} fetchMessage
 *   Resolves null for an unknown message (10003/404 or uncached channel);
 *   may REJECT with err.code 10003 too — both read as "no longer exists".
 *   Any other rejection is surfaced by the service with its cause.
 */

/**
 * Production deps over a raw Discord interaction's guild. Both command arms
 * run in a guild interaction, so `guild` is present; the referrer is always
 * the invoker, so `interaction.member` answers getMember for their own id.
 *
 * @param {import("discord.js").BaseInteraction} interaction
 * @returns {ReferDeps}
 */
function makeDiscordDeps(interaction) {
  const guild = interaction?.guild ?? null;
  const readChannel = (channelId) => {
    try {
      return guild?.channels?.cache?.get?.(channelId) ?? null;
    } catch {
      return null;
    }
  };
  return {
    getGuildChannel(_guildId, channelId) {
      return readChannel(channelId);
    },
    getBotMember(_guildId) {
      try {
        return guild?.members?.me ?? null;
      } catch {
        return null;
      }
    },
    getMember(_guildId, userId) {
      try {
        if (
          interaction?.user?.id != null &&
          String(interaction.user.id) === String(userId) &&
          interaction.member
        ) {
          return interaction.member;
        }
        return guild?.members?.cache?.get?.(userId) ?? null;
      } catch {
        return null;
      }
    },
    async fetchMessage(_guildId, channelId, messageId) {
      const channel = readChannel(channelId);
      if (!channel?.messages?.fetch) return null; // uncached channel = unreadable message
      try {
        return (await channel.messages.fetch(messageId)) ?? null;
      } catch (err) {
        // Discord 10003 Unknown Message — deleted (or never here). Any other
        // code re-throws so the caller surfaces the real cause, not a lie.
        if (err?.code === 10003) return null;
        throw err;
      }
    },
  };
}

// ── the service ────────────────────────────────────────────────────────────

/**
 * Refer a message and/or a user into auto-moderation: run the whole refusal
 * battery FIRST (each gate its own specific cause), then store one
 * `automod_cases` row (status `recorded`, per-community A-n) and hand back
 * the ack. NO provider call, NO budget consumption, NO staff notes, NO
 * breaker-pause read — all deliberately absent (see module header).
 *
 * Gate order (contract order; every gate is tested alone):
 *   master switch → channel unset → channel not postable → rules empty →
 *   budget blocked → budget exhausted → target presence → note cap →
 *   link format → cross-guild → channel gone → referrer viewability →
 *   message existence.
 *
 * @param {object} input
 * @param {number} input.communityId
 * @param {string} input.guildId           Discord guild the case lives in
 * @param {string} input.referrerUserId    staff member filing the case
 * @param {string|null} [input.messageLink] slash `message:` — full link, strict-parsed
 * @param {{messageId?:string, channelId?:string}|null} [input.message]
 *   context-menu target (already resolved by Discord — no link parse/fetch)
 * @param {string|null} [input.targetUserId] slash `user:` option
 * @param {string|null} [input.note]       slash `note:` option (case input)
 * @param {ReferDeps} input.deps
 * @param {number} [input.nowMs]           injectable UTC clock (budget view)
 * @returns {Promise<
 *   | { ok: true, case: object, caseRef: string, automodChannelId: string, ack: string }
 *   | { ok: false, error: string }
 * >}
 */
async function referToAutomod(input = {}) {
  const {
    communityId,
    guildId,
    referrerUserId,
    messageLink = null,
    message = null,
    targetUserId = null,
    note = null,
    deps,
    nowMs,
  } = input;
  const ids = `community ${communityId} user ${referrerUserId ?? "?"}`;

  try {
    if (!deps || typeof deps.getGuildChannel !== "function") {
      return { ok: false, error: "Internal referral error: no channel deps supplied." };
    }

    // ── Battery, part 1: the config gates (contract order) ────────────────
    const read = readSettings(communityId, nowMs);
    if (!read.ok) return read; // settings read failure is already specific
    const s = read.settings;

    if (!s.enabled) return { ok: false, error: REFUSAL_SWITCH_OFF };
    if (!s.channelId) return { ok: false, error: REFUSAL_CHANNEL_UNSET };

    const caseChannel = deps.getGuildChannel(guildId, s.channelId);
    const botMember = deps.getBotMember(guildId);
    if (
      !channelAllows(caseChannel, botMember, [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ])
    ) {
      return { ok: false, error: refusalChannelUnpostable(s.channelId) };
    }

    if (!s.rules) return { ok: false, error: REFUSAL_RULES_EMPTY };

    // Budget WITHOUT consuming (module header: #728 consumes on acceptance).
    const budget = getAutomodBudget(communityId, nowMs);
    if (budget.remaining === -1 || budget.limit <= -1) {
      return { ok: false, error: REFUSAL_BUDGET_BLOCKED };
    }
    if (budget.limit > 0 && budget.remaining === 0) {
      return {
        ok: false,
        error: refusalBudgetExhausted(budget.used, budget.limit),
      };
    }

    // ── Battery, part 2: the referral inputs ──────────────────────────────
    const namedUser = optionalText(targetUserId);
    const hasLink = optionalText(messageLink) != null;
    const hasResolved = message != null;
    if (!hasLink && !hasResolved && !namedUser) {
      return { ok: false, error: REFUSAL_TARGET_REQUIRED };
    }

    const noteText = optionalText(note);
    if (noteText && noteText.length > AUTOMOD_REFER_NOTE_MAX_LEN) {
      return {
        ok: false,
        error: refusalNoteTooLong(noteText.length, AUTOMOD_REFER_NOTE_MAX_LEN),
      };
    }

    let messageId = null;
    let sourceChannelId = null;

    if (hasResolved) {
      // Context-menu target: Discord delivered it — guild and the invoker's
      // view of the channel are guaranteed by the platform itself.
      const mid = optionalText(message?.messageId);
      const cid = optionalText(message?.channelId);
      if (!mid || !cid) return { ok: false, error: REFUSAL_TARGET_UNRESOLVED };
      messageId = mid;
      sourceChannelId = cid;
    } else if (hasLink) {
      const parsed = parseMessageLink(messageLink);
      if (!parsed) {
        return { ok: false, error: refusalLinkFormat(messageLink) };
      }
      if (guildId != null && parsed.guildId !== String(guildId)) {
        return { ok: false, error: refusalCrossGuild(parsed.guildId) };
      }
      const source = deps.getGuildChannel(guildId, parsed.channelId);
      if (!source) {
        // Gone-channel cannot hold a referable message.
        return { ok: false, error: REFUSAL_MESSAGE_GONE };
      }
      const referrer = deps.getMember(guildId, referrerUserId);
      if (!channelAllows(source, referrer, [PermissionFlagsBits.ViewChannel])) {
        return { ok: false, error: refusalChannelInvisible(parsed.channelId) };
      }
      let fetched = null;
      try {
        fetched = await deps.fetchMessage(guildId, parsed.channelId, parsed.messageId);
      } catch (err) {
        if (err?.code === 10003) fetched = null;
        else {
          console.error(`[automod] refer message fetch failed (${ids}):`, err?.message || err);
          return {
            ok: false,
            error: `Could not read that message (${err?.message || "Discord read failed"}) — nothing was recorded.`,
          };
        }
      }
      if (!fetched) return { ok: false, error: REFUSAL_MESSAGE_GONE };
      messageId = parsed.messageId;
      sourceChannelId = parsed.channelId;
    }

    // ── Intake: the case row. Referrer is NOT a subject (no staff note). ──
    const created = createAutomodCase({
      communityId,
      referrerUserId,
      messageId,
      channelId: sourceChannelId,
      targetUserId: namedUser,
      note: noteText,
    });
    if (!created.ok) {
      console.error(`[automod] refer case write failed (${ids}):`, created.error);
      return created;
    }

    return {
      ok: true,
      case: created.case,
      caseRef: `A-${created.case.case_number}`,
      automodChannelId: s.channelId,
      ack: buildReferAck(created.case.case_number, s.channelId),
    };
  } catch (err) {
    // Last-resort, still SPECIFIC + logged (error rules 2/3/6): the battery
    // never throws, so this is a real bug or a db catastrophe — name the cause.
    console.error(`[automod] refer failed (${ids}):`, err?.message || err);
    return {
      ok: false,
      error: `Could not record the referral: ${err?.message || "database error"}`,
    };
  }
}

// ── harness run trigger (#728, additive) ──────────────────────────────────
//
// The feature's boot hook installs the hook (index.js → harness.
// makeReferRunHook). Until it does — unit tests, or a boot where the
// harness wiring failed — recorded cases simply stay `recorded`: the ack
// already says recommendations will post THERE, and a missing hook is a
// degraded surface, never an intake failure.

/** @type {null | ((input: {communityId: number, guildId: string|null, case: object, referrerUserId: string|null}) => Promise<unknown>)} */
let runCaseHook = null;

/**
 * Install (or clear, with null) the post-ack harness trigger. One
 * referral = one run: the RUN itself refuses a second pass via its atomic
 * status claim (harness.js) — this seam never double-fires the same ack.
 *
 * @param {Function|null} hook
 */
function setRunCaseHook(hook) {
  if (hook != null && typeof hook !== "function") {
    throw new TypeError("setRunCaseHook: hook must be a function or null");
  }
  runCaseHook = hook;
}

/**
 * Fire the installed hook DETACHED (never awaited by the handler — the
 * ack already shipped). Its own `.catch` names the ids (rule 1). Sync
 * throws from the hook installation path are caught too.
 */
function scheduleAutomodRun({ communityId, guildId, caseRow, referrerUserId }) {
  const hook = runCaseHook;
  if (typeof hook !== "function") return;
  if (caseRow?.id == null) return; // nothing to run without the row id
  const ids =
    `(community ${communityId ?? "?"} guild ${guildId ?? "?"} case ${caseRow?.id ?? "?"})`;
  try {
    const p = Promise.resolve().then(() =>
      hook({ communityId, guildId, case: caseRow, referrerUserId }),
    );
    p.catch((err) =>
      console.error(`[automod] automod run crashed ${ids}:`, err?.message || err),
    );
  } catch (err) {
    console.error(`[automod] automod run crashed ${ids}:`, err?.message || err);
  }
}

// ── audit + command arms ───────────────────────────────────────────────────

/**
 * One `automod.refer` audit row per recorded case — staff action creating a
 * tracked case is auditable (the #725 `automod.<verb>` vocabulary, mirroring
 * what the tickets report handlers do with `tickets.report_*`).
 * recordSlashAudit is fail-safe by contract; it never throws.
 */
function auditRefer(communityId, actorUserId, result) {
  recordSlashAudit({
    communityId,
    actorUserId,
    action: "automod.refer",
    targetType: "case",
    targetId: String(result.case.id),
    details: {
      case_number: result.case.case_number,
      channel_id: result.case.channel_id,
      message_id: result.case.message_id,
      target_user_id: result.case.target_user_id,
      automod_channel_id: result.automodChannelId,
    },
  });
}

/**
 * `/automod refer` — the slash arm. Gates (requireStaff, NOT_ON_FLUXER) run
 * upstream in the feature handler exactly like `status`; this reads the
 * options, cross-enforces "at least one of message|user" (Discord cannot),
 * and surfaces the service verbatim.
 *
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function handleReferCommand(commandCtx) {
  const messageLink = commandCtx.options.getString("message");
  const targetUser = commandCtx.options.getUser("user");
  const note = commandCtx.options.getString("note");

  if (!messageLink && !targetUser) {
    await commandCtx.reply({ content: REFUSAL_TARGET_REQUIRED, sensitive: true });
    return;
  }

  const result = await referToAutomod({
    communityId: commandCtx.communityId,
    guildId: commandCtx.externalGuildId,
    referrerUserId: commandCtx.userId,
    messageLink,
    targetUserId: targetUser?.id ?? null,
    note,
    deps: makeDiscordDeps(commandCtx.rawInteraction),
  });
  if (!result.ok) {
    await commandCtx.reply({ content: result.error, sensitive: true });
    return;
  }

  auditRefer(commandCtx.communityId, commandCtx.userId, result);
  await commandCtx.reply({ content: result.ack, sensitive: true });

  // #728: trigger AFTER the ack reply resolves — detached, its own catch.
  scheduleAutomodRun({
    communityId: commandCtx.communityId,
    guildId: commandCtx.externalGuildId,
    caseRow: result.case,
    referrerUserId: commandCtx.userId,
  });
}

/**
 * "Refer to automod" — the context-menu arm (router dispatches by
 * interaction.commandName; api "interaction": the target message only exists
 * on the raw interaction — same posture as the #745 report invokes).
 * Staff gate FIRST: a denied invoke records nothing. Bot/system targets are
 * refused before the service runs (nothing to moderate). No note, no user
 * option — the target message IS the referral.
 *
 * @param {import("discord.js").MessageContextMenuCommandInteraction} interaction
 * @param {object} [ctx] router context (unused)
 */
async function handleReferContextMenu(interaction, ctx) {
  void ctx;
  try {
    if (!(await requireStaff(interaction))) return;

    // Literal registered target-option name "message" (lowercase) — verified
    // in node_modules: MessageContextMenuCommandInteraction.targetMessage →
    // options.getMessage('message') (same getter the #745 report invoke pins).
    const message = interaction.options?.getMessage?.("message") ?? null;
    if (!message) {
      await replyEphemeral(interaction, REFUSAL_TARGET_UNRESOLVED);
      return;
    }

    if (message.author?.bot || message.system || (message.type ?? 0) !== 0) {
      await replyEphemeral(interaction, REFUSAL_BOT_TARGET);
      return;
    }

    const communityId = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: interaction.guildId,
    });

    const result = await referToAutomod({
      communityId,
      guildId: interaction.guildId,
      referrerUserId: interaction.user?.id ?? null,
      message: {
        messageId: message.id ?? null,
        channelId: message.channelId ?? message.channel?.id ?? null,
      },
      deps: makeDiscordDeps(interaction),
    });
    if (!result.ok) {
      await replyEphemeral(interaction, result.error);
      return;
    }

    auditRefer(communityId, interaction.user?.id, result);
    await replyEphemeral(interaction, result.ack);

    // #728: trigger AFTER the ack reply resolves — detached, its own catch.
    scheduleAutomodRun({
      communityId,
      guildId: interaction.guildId ?? null,
      caseRow: result.case,
      referrerUserId: interaction.user?.id ?? null,
    });
  } catch (err) {
    console.error(
      "[automod] refer context-menu failed:",
      `guild=${interaction?.guildId ?? "?"}`,
      `user=${interaction?.user?.id ?? "?"}`,
      `command=${interaction?.commandName ?? "?"}`,
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

module.exports = {
  MESSAGE_LINK_RE,
  REFUSAL_SWITCH_OFF,
  REFUSAL_CHANNEL_UNSET,
  REFUSAL_RULES_EMPTY,
  REFUSAL_BUDGET_BLOCKED,
  REFUSAL_TARGET_REQUIRED,
  REFUSAL_MESSAGE_GONE,
  REFUSAL_TARGET_UNRESOLVED,
  REFUSAL_BOT_TARGET,
  refusalChannelUnpostable,
  refusalBudgetExhausted,
  refusalLinkFormat,
  refusalCrossGuild,
  refusalChannelInvisible,
  refusalNoteTooLong,
  parseMessageLink,
  buildReferAck,
  makeDiscordDeps,
  referToAutomod,
  handleReferCommand,
  handleReferContextMenu,
  // #728 harness trigger seam (wired by the feature boot hook):
  setRunCaseHook,
};
