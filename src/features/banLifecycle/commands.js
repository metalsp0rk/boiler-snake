/**
 * /ban + /bannotify slash builders + handlers and the "Ban member" user
 * context-menu builder (#772 §1 + §6).
 *
 * Picker posture (test/command-visibility.test.js pins it): all three
 * surfaces carry the ManageGuild default_member_permissions and sit on the
 * TIERS.admin visibility tier (automodconfig posture — admin = ManageGuild
 * picker, NOT in the staffRoles allow-sync). Handlers stay the security
 * source of truth: every slash arm runs requireAdminFromContext FIRST, then
 * the NOT_ON_FLUXER gate (#772 explicit Fluxer no-parity — the ban surface,
 * its modals, and the notice DMs are Discord-only by decision).
 *
 * The ban flow (issue §1, contract locked in ./banService.js):
 *  - `/ban <member> [reason] [duration]` — reason AND duration present →
 *    run inline; either missing → the shared Reason/Duration modal
 *    (./banModal.js). A slash-provided duration is validated BEFORE the
 *    modal opens (an invalid one rejects with the field-named #745 refusal
 *    and never shows a form built on a misread).
 *  - "Ban member" context menu → always the same modal (the menu carries
 *    no options). Its builder lives HERE (not a sibling file) because the
 *    ban surface is one module's command identity; the display name key is
 *    BAN_CONTEXT_MENU_NAME from ./constants.js, byte-identical across
 *    builder, visibility map, handlers key, and router dispatch.
 *  - BOTH surfaces funnel into runTrackedBan — the ONE banService.banUser
 *    call (guards → DM-first → ban → record), never a second path.
 *
 * /bannotify (§6): per-guild `ban_dm` / `welcome_back_dm` toggles (both
 * default ON). Reads via getGuildSettings, writes via updateGuildSettings
 * through the settings seam below (automod/settings.js contract shape:
 * { ok:true, ... } | { ok:false, error }, never throws, never replies);
 * every toggle mutation lands one recordSlashAudit row (`banLifecycle.*`
 * vocabulary) plus the /automodconfig-style logConfigChange embed.
 *
 * Error law: handlers wrapped (raw arms self-wrap; the router wraps the
 * context arm at its boundary); user-facing replies carry banService's
 * SPECIFIC cause (duplicate ban, staff-subject guard, Missing Access 50013
 * translation, …); a ban-DM failure surfaces as a staff-side `**Ban DM:**`
 * notice WITHOUT blocking the ban and without apology copy (K2).
 *
 * Boot wiring (src/features/index.js + the thin banLifecycle/index.js) is
 * subtask 09's — this module exports the exact shape applyFeaturesToRegistry
 * consumes; nothing here is registered until then.
 */

const {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  PermissionFlagsBits,
} = require("discord.js");
const {
  requireAdmin,
  requireAdminFromContext,
} = require("../../core/permissions");
const { replyEphemeral, safeErrorReply } = require("../../core/interaction");
const { recordSlashAudit } = require("../../core/auditTrail");
const { logConfigChange } = require("../logs/auditLog");
const { ensureCommunity } = require("../../platform/community");
const { showModalFromContext } = require("../../platform/context");
const { getGuildSettings, updateGuildSettings } = require("../../db");
const { sliceSafe } = require("../../core/text");
const {
  BAN_COMMAND,
  BANNOTIFY_COMMAND,
  BAN_CONTEXT_MENU_NAME,
  MODAL_BAN_PREFIX,
  DURATION_EXAMPLES,
} = require("./constants");
const { parseDuration } = require("./duration");
const banService = require("./banService");
const { buildBanModal, handleBanModal, putPendingBan } = require("./banModal");

/** Same logger prefix as the service — one grep for the whole feature. */
const LOG_PREFIX = banService.LOG_PREFIX;

/**
 * Discord-only surface (#772 explicit Fluxer no-parity). Same sentence as
 * the automod gate (automod/constants.js NOT_ON_FLUXER) so every refused
 * Fluxer context reads identically; hoisted, never re-implemented inline.
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";

/** Admin picker posture: ManageGuild on every builder (visibility map: admin). */
const adminPerms = PermissionFlagsBits.ManageGuild;

/** Reply-length cap shared with the referModal exemplar. */
const REPLY_MAX_CHARS = 3900;

/* ── builders ─────────────────────────────────────────────────────────────── */

// Required `member` FIRST, then the two optional strings — a required
// option after an optional one fails the whole guild PUT (#291 law,
// test/command-option-order.test.js).
const banCommand = new SlashCommandBuilder()
  .setName(BAN_COMMAND)
  .setDescription(
    "Ban a member — optional duration auto-expires; they get a DM first (admin).",
  )
  .setDefaultMemberPermissions(adminPerms)
  .addUserOption((opt) =>
    opt
      .setName("member")
      .setDescription("Member to ban")
      .setRequired(true),
  )
  .addStringOption((opt) =>
    opt
      .setName("reason")
      .setDescription("Why — goes to the ban record AND the Discord ban reason")
      .setRequired(false),
  )
  .addStringOption((opt) =>
    opt
      .setName("duration")
      .setDescription(
        `How long — ${DURATION_EXAMPLES}, or permanent (blank asks in a form)`,
      )
      .setRequired(false),
  );

const bannotifyCommand = new SlashCommandBuilder()
  .setName(BANNOTIFY_COMMAND)
  .setDescription("Ban-notice DMs: ban-time and welcome-back toggles (admin).")
  .setDefaultMemberPermissions(adminPerms)
  .addSubcommand((sc) =>
    sc
      .setName("ban")
      .setDescription("DM members when they are banned (default on).")
      .addStringOption((opt) =>
        opt
          .setName("state")
          .setDescription("on = send the ban DM, off = never DM")
          .setRequired(true)
          .addChoices(
            { name: "on", value: "on" },
            { name: "off", value: "off" },
          ),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("welcome")
      .setDescription("DM members when they are unbanned (default on).")
      .addStringOption((opt) =>
        opt
          .setName("state")
          .setDescription("on = send the welcome DM, off = never DM")
          .setRequired(true)
          .addChoices(
            { name: "on", value: "on" },
            { name: "off", value: "off" },
          ),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("status")
      .setDescription("Show the current ban-notice toggles."),
  );

// User context menu (right-click member → Apps). The display name is the
// registry + dispatch + visibility key (router.js dispatches context menus
// by interaction.commandName) — exact caps + space, from ./constants.js.
// The handler stays on the RAW interaction arm: the menu target only exists
// there (registry.test.js pins the context-menu posture).
const banContextMenu = new ContextMenuCommandBuilder()
  .setName(BAN_CONTEXT_MENU_NAME)
  .setType(ApplicationCommandType.User)
  .setDefaultMemberPermissions(adminPerms);

/* ── shared ban core (slash-inline + modal submit call runTrackedBan) ────── */

/**
 * The ONE banService.banUser call for every staff surface (#772: staff
 * commands, and through the same service the automod seam in subtask 08).
 * On success the STAFF layer owns its own recordSlashAudit row (the service
 * only writes the system-origin row for automod bans).
 *
 * @param {object} facts
 * @param {number} facts.communityId
 * @param {string} facts.userId target
 * @param {string} facts.moderatorId acting staff (slash invoker / modal submitter)
 * @param {string} facts.reason
 * @param {number|null} facts.expiresAtMs absolute expiry (null = permanent)
 * @param {object|null} facts.outbound platform outbound
 * @param {string|null} [facts.guildId]
 * @param {string|null} [facts.guildName]
 * @param {object|null} [facts.client] Discord client (guard-seam reads)
 * @returns {Promise<object>} banService.banUser's result verbatim
 */
async function runTrackedBan(facts) {
  const result = await banService.banUser({
    communityId: facts.communityId,
    userId: facts.userId,
    moderatorId: facts.moderatorId,
    reason: facts.reason,
    source: "staff",
    expiresAtMs: facts.expiresAtMs ?? null,
    outbound: facts.outbound ?? null,
    guildId: facts.guildId ?? null,
    guildName: facts.guildName ?? null,
    client: facts.client ?? null,
  });
  if (result.ok) auditStaffBan(facts, result);
  return result;
}

/** One audit row per executed staff ban (the mutation is the fact). */
function auditStaffBan(facts, result) {
  recordSlashAudit({
    communityId: facts.communityId,
    actorUserId: facts.moderatorId,
    action: "banLifecycle.ban",
    targetType: "user",
    targetId: String(facts.userId),
    details: {
      ban_record_id: result.banRecordId,
      ban_number: result.record?.ban_number ?? null,
      source: "staff",
      expires_at: result.expiresAtMs,
      ban_dm_sent: result.banDmSent ? 1 : 0,
      dm_warnings: (result.warnings ?? []).length,
      reason: facts.reason,
    },
  });
}

/**
 * Ban-DM status lines (`**Label:** value`, #471 H2-13). Service warning
 * strings are TRANSLATED, not echoed raw: the ban already executed (DM
 * first, K2), so this is a staff-side notice — never an apology, never
 * user-facing.
 */
function banNoticeLines(result) {
  const lines = [];
  if (result.banDmSent) {
    lines.push("**Ban DM:** sent.");
  } else if (result.banDmSkipped) {
    lines.push(
      "**Ban DM:** off for this server — `/bannotify ban on` turns it back on.",
    );
  }
  for (const warning of result.warnings ?? []) {
    if (warning.startsWith("Ban DM not delivered: ")) {
      lines.push(`**Ban DM:** not delivered — ${warning.slice("Ban DM not delivered: ".length)}`);
    } else if (warning.startsWith("Ban DM not sent: ")) {
      lines.push(`**Ban DM:** not sent — ${warning.slice("Ban DM not sent: ".length)}`);
    } else {
      lines.push(`**Notice:** ${warning}`);
    }
  }
  return lines;
}

/**
 * Ephemeral success copy shared by the inline slash arm and the modal
 * submit: ban number (B-n), `**Expires:** <t:F> (<t:R>)` or permanent,
 * and the ban-DM notice lines.
 */
function formatBanResult(result, userId) {
  const lines = [`**Banned:** <@${userId}> (**${result.banNumber}**).`];
  if (result.expiresAtMs != null) {
    const sec = Math.floor(Number(result.expiresAtMs) / 1000);
    lines.push(`**Expires:** <t:${sec}:F> (<t:${sec}:R>)`);
  } else {
    lines.push("**Duration:** permanent — no auto-expiry; staff lift it manually.");
  }
  lines.push(...banNoticeLines(result));
  return sliceSafe(lines.join("\n"), REPLY_MAX_CHARS);
}

/* ── /ban — staff ban surface (§1) ────────────────────────────────────────── */

/**
 * `/ban <member> [reason] [duration]` — admin gate → NOT_ON_FLUXER →
 * pre-modal duration validation (#745: an invalid slash duration rejects
 * with the field-named refusal and NO form opens) → inline run when both
 * fields are present, otherwise the shared modal. One modal, one service
 * call, ever.
 *
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleBan(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireAdminFromContext(commandCtx))) return;

  // Discord-only surface (#772 explicit no-parity): Fluxer contexts never
  // carry rawInteraction and never reach the modal path.
  if (!commandCtx.rawInteraction) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  const member = commandCtx.options.getUser("member");
  if (!member || !member.id) {
    await commandCtx.reply({
      content:
        "Could not resolve the member — they may have left the server. " +
        "Nothing was banned.",
      sensitive: true,
    });
    return;
  }

  const reason = String(commandCtx.options.getString("reason") ?? "").trim();
  const durationRaw = String(commandCtx.options.getString("duration") ?? "").trim();

  // Validate a slash-provided duration BEFORE anything else: invalid →
  // the parseDuration refusal (names "Duration", gives the example, says
  // nothing was banned). Never open a modal on top of a misread value.
  let parsed = null;
  if (durationRaw !== "") {
    parsed = parseDuration(durationRaw);
    if (!parsed.ok) {
      await commandCtx.reply({ content: parsed.error, sensitive: true });
      return;
    }
  }

  if (reason !== "" && parsed) {
    // Both fields present → inline run (defer first: guard reads + DM +
    // ban + record comfortably pass the 3 s interaction window).
    await commandCtx.defer({ sensitive: true });
    const result = await runTrackedBan({
      communityId: commandCtx.communityId,
      userId: String(member.id),
      moderatorId: commandCtx.userId,
      reason,
      expiresAtMs: parsed.expiresAtMs,
      outbound: commandCtx.outbound ?? null,
      guildId: commandCtx.externalGuildId,
      guildName: commandCtx.rawInteraction?.guild?.name ?? null,
      client: commandCtx.rawInteraction?.client ?? null,
    });
    if (!result.ok) {
      await commandCtx.editReply({ content: result.error });
      return;
    }
    await commandCtx.editReply({ content: formatBanResult(result, member.id) });
    return;
  }

  // Missing reason and/or duration → the ONE shared modal. The slash
  // intents ride the one-shot pending entry (validated duration included).
  const token = putPendingBan({
    communityId: commandCtx.communityId,
    guildId: commandCtx.externalGuildId,
    guildName: commandCtx.rawInteraction?.guild?.name ?? null,
    targetUserId: String(member.id),
    reason: reason || null,
    durationRaw: durationRaw || null,
  });
  const shown = await showModalFromContext(commandCtx, buildBanModal(token));
  if (!shown) {
    // Belt: the rawInteraction gate above makes this Fluxer-shaped by
    // construction; refuse specifically, never run a half-collected ban.
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
  }
}

/* ── "Ban member" context menu — always the modal ─────────────────────────── */

/**
 * Right-click member → Apps → Ban member (admin gate first, per the picker
 * tier). Same pending entry + same modal as the slash arm, therefore the
 * same single service call on submit. Wrapped on the raw arm (router wraps
 * context menus too, but the ids in OUR log line are what make the failure
 * reproducible).
 *
 * @param {import("discord.js").UserContextMenuCommandInteraction} interaction
 * @param {object} [ctx] router feature context
 */
async function handleBanContextMenu(interaction, ctx) {
  void ctx; // the modal needs no supervisor here — the submit resolves it
  try {
    if (!(await requireAdmin(interaction))) return;

    // Literal registered target-option name "user" — same verification as
    // the #745/#794 user menus (UserContextMenuCommandInteraction reads the
    // target off the raw interaction; there is no context arm for menus).
    const target = interaction.options?.getUser?.("user") ?? null;
    if (!target || target.id == null) {
      await replyEphemeral(interaction, {
        content:
          "Could not resolve the member — they may have left the server. " +
          "Nothing was banned.",
        allowedMentions: { parse: [] },
      });
      return;
    }

    const externalGuildId = String(interaction.guildId);
    const communityId = ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId,
    });
    const token = putPendingBan({
      communityId,
      guildId: externalGuildId,
      guildName: interaction.guild?.name ?? null,
      targetUserId: String(target.id),
      reason: null,
      durationRaw: null,
    });
    // showModal straight from the un-deferred interaction (a deferred
    // interaction cannot open a modal — banModal.js answers the submit).
    await interaction.showModal(buildBanModal(token));
  } catch (err) {
    console.error(
      `${LOG_PREFIX} Ban member menu failed:`,
      `guild=${interaction?.guildId ?? "?"}`,
      `user=${interaction?.user?.id ?? "?"}`,
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

/* ── /bannotify — notice toggles (§6) ─────────────────────────────────────── */

/** Subcommand → guild_settings column (the DM-toggle family, migration 074). */
const NOTICE_COLUMNS = Object.freeze({
  ban: "ban_dm",
  welcome: "welcome_back_dm",
});

/**
 * Settings seam (automod/settings.js contract shape): { ok:true, ... } |
 * { ok:false, error }, never throws, never replies to a platform. Defaults
 * are ON — `Number(x ?? 1) !== 0`, the reader idiom the repository pins.
 *
 * @param {number} communityId
 * @returns {{ ok: true, settings: { banDm: boolean, welcomeBackDm: boolean } }
 *          | { ok: false, error: string }}
 */
function readNoticeSettings(communityId) {
  try {
    const s = getGuildSettings(communityId) || {};
    return {
      ok: true,
      settings: {
        banDm: Number(s.ban_dm ?? 1) !== 0,
        welcomeBackDm: Number(s.welcome_back_dm ?? 1) !== 0,
      },
    };
  } catch (err) {
    console.error(
      `${LOG_PREFIX} notice settings read failed community=${communityId}:`,
      err?.message || err,
    );
    return {
      ok: false,
      error: `Could not read the ban-notice settings: ${err?.message || "database error"}`,
    };
  }
}

/**
 * Persist one toggle (the repository write-belt normalizes 0/1).
 * @param {number} communityId
 * @param {"ban"|"welcome"} which
 * @param {boolean} enabled
 * @returns {{ ok: true, column: string, enabled: boolean }
 *          | { ok: false, error: string }}
 */
function setNoticeSetting(communityId, which, enabled) {
  const column = NOTICE_COLUMNS[which];
  if (!column) {
    return {
      ok: false,
      error: `Unknown notice toggle \`${which}\` — choose \`ban\` or \`welcome\`.`,
    };
  }
  try {
    updateGuildSettings(communityId, { [column]: enabled ? 1 : 0 });
    return { ok: true, column, enabled };
  } catch (err) {
    console.error(
      `${LOG_PREFIX} ${column} write failed community=${communityId}:`,
      err?.message || err,
    );
    return {
      ok: false,
      error: `Could not save the ban-notice setting (${column}): ${err?.message || "database error"}`,
    };
  }
}

/** Human label per toggle (reply + embed copy). */
function noticeLabel(which) {
  return which === "ban" ? "Ban DM" : "Welcome-back DM";
}

/** One-line consequence per toggle state (what the staff member just did). */
function noticeConsequence(which, enabled) {
  if (which === "ban") {
    return enabled
      ? " Every tracked ban DMs the member first (a failed DM never blocks the ban)."
      : " Bans skip the DM — the ban itself is unchanged.";
  }
  return enabled
    ? " Any unban (auto-expiry or manual) sends exactly one welcome DM."
    : " Unbans skip the welcome DM; parked rejoin retries stay parked.";
}

/**
 * `ban on|off` / `welcome on|off` — one arm body for both toggles (audited
 * mutation + embed + echo, /automodconfig enable posture).
 */
async function setNoticeToggle(commandCtx, which) {
  const state = String(commandCtx.options.getString("state", true) || "")
    .trim()
    .toLowerCase();
  if (state !== "on" && state !== "off") {
    await commandCtx.reply({
      content: `\`state\` must be \`on\` or \`off\` (got \`${state}\`).`,
      sensitive: true,
    });
    return;
  }
  const enabled = state === "on";
  const result = setNoticeSetting(commandCtx.communityId, which, enabled);
  if (!result.ok) {
    await commandCtx.reply({ content: result.error, sensitive: true });
    return;
  }

  recordSlashAudit({
    communityId: commandCtx.communityId,
    actorUserId: commandCtx.userId,
    action:
      which === "ban"
        ? "banLifecycle.ban_dm_set"
        : "banLifecycle.welcome_dm_set",
    targetType: "guild",
    targetId: String(commandCtx.externalGuildId),
    details: { [result.column]: enabled ? 1 : 0 },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: `${noticeLabel(which)} notices changed`,
    command: `/bannotify ${which}`,
    actor: commandCtx.user,
    changes: [`${noticeLabel(which)}: ${enabled ? "on" : "off"}`],
  }).catch(() => {});

  await commandCtx.reply({
    content:
      `**${noticeLabel(which)}:** now **${state}**.` +
      noticeConsequence(which, enabled),
    sensitive: true,
  });
}

/** `status` — both toggles in `**Label:** value` style + the defaults note. */
async function handleBanNotifyStatus(commandCtx) {
  const read = readNoticeSettings(commandCtx.communityId);
  if (!read.ok) {
    await commandCtx.reply({ content: read.error, sensitive: true });
    return;
  }
  const { banDm, welcomeBackDm } = read.settings;
  await commandCtx.reply({
    content: [
      `**Ban DM:** ${banDm ? "on" : "off"} — members get a DM before the ban runs.`,
      `**Welcome-back DM:** ${welcomeBackDm ? "on" : "off"} — exactly one DM per unban cycle (auto-expiry or manual).`,
      "**Defaults:** both notices ship **on** (non-destructive) — flip either at any time with `/bannotify ban` or `/bannotify welcome`.",
    ].join("\n"),
    sensitive: true,
  });
}

/**
 * `/bannotify <ban|welcome|status>` — admin gate → NOT_ON_FLUXER → dispatch
 * (automodconfig fall-through copy for unknown arms).
 *
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleBanNotify(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireAdminFromContext(commandCtx))) return;

  if (!commandCtx.rawInteraction) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  const sub = commandCtx.subcommand;
  if (sub === "ban") return setNoticeToggle(commandCtx, "ban");
  if (sub === "welcome") return setNoticeToggle(commandCtx, "welcome");
  if (sub === "status") return handleBanNotifyStatus(commandCtx);

  await commandCtx.reply({
    content: `Unknown subcommand: \`${sub}\``,
    sensitive: true,
  });
}

/* ── feature-module exports (load.js contract; boot wiring: subtask 09) ──── */

module.exports = {
  // Slash builders + the "Ban member" user context menu (tickets'
  // commands.js exports all three builder kinds from one module).
  commands: [banCommand, bannotifyCommand, banContextMenu],
  handlers: {
    [BAN_COMMAND]: handleBan,
    [BANNOTIFY_COMMAND]: handleBanNotify,
    // Context-menu key is the exact registered display name (the router
    // dispatches menus by interaction.commandName).
    [BAN_CONTEXT_MENU_NAME]: handleBanContextMenu,
  },
  // "Ban member" is deliberately absent: context menus ride the raw
  // interaction arm (the target only exists there — registry.test.js law).
  handlerApi: {
    [BAN_COMMAND]: "context",
    [BANNOTIFY_COMMAND]: "context",
  },
  modalHandlers: {
    // Ban intake form (`bl:ban:<token>`, longest-prefix dispatch).
    [MODAL_BAN_PREFIX]: handleBanModal,
  },
  // Shared ban core (modal submit + future automod-seam tests).
  runTrackedBan,
  formatBanResult,
  auditStaffBan,
  // Settings seam (tests + integration; automod/settings.js shape).
  settings: {
    readNoticeSettings,
    setNoticeSetting,
  },
  NOT_ON_FLUXER,
  // Copy/builder seams for tests:
  banNoticeLines,
  NOTICE_COLUMNS,
};
