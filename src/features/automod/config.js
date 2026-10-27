/**
 * /automodconfig — admin mutation arms (#725, epic #723).
 *
 * Every arm: ManageGuild in the HANDLER as well as the picker (issue text),
 * the service returns { ok:false, error } with the specific cause (never a
 * generic "something failed"), every real mutation lands one recordSlashAudit
 * row (`automod.<verb>` vocabulary) plus the best-effort config-change embed.
 *
 * Two durable postures:
 *  - Clearing channel/rules while ENABLED stays ALLOWED — referrals then
 *    refuse naming the missing piece (referral issue #726). Config hygiene
 *    must never be blocked by the switch.
 *  - `safety resume` follows the gork/H2-15 confirm: idiom — without
 *    confirm it previews exactly what re-arms (the actions currently set to
 *    auto), because re-arming auto kick/ban/timeout is the irreversible path.
 */

const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
} = require("discord.js");
const { requireAdmin } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { recordSlashAudit } = require("../../core/auditTrail");
const { logConfigChange } = require("../logs/auditLog");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { ensureCommunity } = require("../../platform/community");
const { showModalFromContext } = require("../../platform/context");
const {
  MODAL_RULES,
  MODAL_FIELD_RULES,
  AUTOMOD_ACTIONS,
  AUTOMOD_RULES_MAX_LEN,
} = require("./constants");
const service = require("./settings");
const { formatBudgetLine } = require("./status");

/**
 * Edge resolution (mirrors staffNotes): the interaction arm maps the Discord
 * guild snowflake to the integer community key the repositories take.
 * @param {import("discord.js").GuildInteraction} interaction
 * @returns {number}
 */
function resolveCommunityId(interaction) {
  return ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: interaction.guildId,
  });
}

/** One audit row per /automodconfig mutation (slash origin, guild target). */
function auditMutation(commandCtx, action, details = null) {
  recordSlashAudit({
    communityId: commandCtx.communityId,
    actorUserId: commandCtx.userId,
    action,
    targetType: "guild",
    targetId: String(commandCtx.externalGuildId),
    details,
  });
}

function auditEmbed(commandCtx, title, command, changes) {
  return logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title,
    command,
    actor: commandCtx.user,
    changes,
  }).catch(() => {});
}

/** Reply with a service error verbatim (specific by construction). */
async function replyError(commandCtx, error) {
  await commandCtx.reply({ content: error, sensitive: true });
}

// ── channel set|clear ───────────────────────────────────────────────────────

/**
 * Read-only @everyone ViewChannel probe over the real discord.js channel
 * (issue: WARN, never rewrite overwrites). Returns true/false when the
 * overwrite state is readable, null when it cannot be determined (channel
 * not cached / unknown API shape) — the caller then says so honestly.
 *
 * @param {import("discord.js").BaseInteraction} raw
 * @param {string} channelId
 * @returns {boolean|null}
 */
function everyoneCanView(raw, channelId) {
  try {
    const guild = raw?.guild;
    const channel = guild?.channels?.cache?.get?.(channelId) ?? null;
    if (!channel || typeof channel.permissionsFor !== "function") return null;
    const everyone = guild.roles?.everyone ?? guild.roles?.cache?.get?.(guild.id) ?? null;
    if (!everyone) return null;
    const perms = channel.permissionsFor(everyone);
    if (!perms || typeof perms.has !== "function") return null;
    return perms.has(PermissionsBitField.Flags.ViewChannel);
  } catch (err) {
    console.error(
      `[automod] @everyone view check failed for channel ${channelId}:`,
      err?.message || err,
    );
    return null;
  }
}

async function handleChannelSet(commandCtx) {
  const channel = commandCtx.options.getChannel("channel", true);
  const result = service.setChannel(commandCtx.communityId, channel.id);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.channel_set", { channel_id: channel.id });
  await auditEmbed(commandCtx, "Automod channel set", "/automodconfig channel set", [
    `Case cards: <#${channel.id}> (${channel.id})`,
  ]);

  const visibility = everyoneCanView(commandCtx.rawInteraction, channel.id);
  const warning =
    visibility === true
      ? "\n**Warning:** `@everyone` can currently view this channel — case cards would be " +
        "public. Restrict it to staff in Discord channel permissions (this command never " +
        "rewrites channel overwrites)."
      : visibility === false
        ? ""
        : "\n**Note:** I could not read this channel's overwrites — verify `@everyone` cannot view it.";

  await commandCtx.reply({
    content:
      `**Automod channel set:** <#${channel.id}>.\n` +
      `Case cards post here once the feature is enabled.` +
      warning,
    sensitive: true,
  });
}

async function handleChannelClear(commandCtx) {
  const result = service.clearChannel(commandCtx.communityId);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.channel_clear");
  await auditEmbed(commandCtx, "Automod channel cleared", "/automodconfig channel clear", [
    "Case-card channel unset — referrals refuse until it is set again.",
  ]);

  await commandCtx.reply({
    content:
      "**Automod channel cleared.** Cases will refuse naming the missing channel " +
      "until `/automodconfig channel set` runs again — the master switch was left as it was.",
    sensitive: true,
  });
}

// ── rules set|clear ─────────────────────────────────────────────────────────

/**
 * Modal to write the guild rules text (same idea as `/note add`'s modal —
 * long text does not belong in a slash option).
 * @param {string} [existing] prefill (edit-in-place)
 * @returns {ModalBuilder}
 */
function buildRulesModal(existing = "") {
  const input = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_RULES)
    .setLabel("Guild rules text (judge input)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(AUTOMOD_RULES_MAX_LEN)
    .setPlaceholder("The written rules the auto-judge applies to each case");
  if (existing) {
    input.setValue(String(existing).slice(0, AUTOMOD_RULES_MAX_LEN));
  }

  return new ModalBuilder()
    .setCustomId(MODAL_RULES)
    .setTitle("Set automod rules text")
    .addComponents(new ActionRowBuilder().addComponents(input));
}

/** Shared success tail for slash + modal rules submits. */
function rulesSuccessContent(result) {
  return (
    `**Automod rules set** (**${result.rulesChars}** of ${AUTOMOD_RULES_MAX_LEN} chars). ` +
    "Cases judge against this text."
  );
}

async function handleRulesSet(commandCtx) {
  const text = commandCtx.options.getString("text");

  // Omit the string → modal (sanctioned showModalFromContext path; Fluxer
  // never gets here — the whole automod surface is Discord-only).
  if (text == null) {
    const read = service.readSettings(commandCtx.communityId);
    if (!read.ok) return replyError(commandCtx, read.error);
    const shown = await showModalFromContext(
      commandCtx,
      buildRulesModal(read.settings.rules),
    );
    if (!shown) {
      await commandCtx.reply({
        content:
          "Pass the rules with the `text` option — this platform can't open the rules modal.",
        sensitive: true,
      });
    }
    return;
  }

  const result = service.setRules(commandCtx.communityId, text);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.rules_set", { rules_chars: result.rulesChars });
  await auditEmbed(commandCtx, "Automod rules set", "/automodconfig rules set", [
    `Rules text replaced (${result.rulesChars} chars).`,
  ]);
  await commandCtx.reply({ content: rulesSuccessContent(result), sensitive: true });
}

async function handleRulesClear(commandCtx) {
  const result = service.clearRules(commandCtx.communityId);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.rules_clear");
  await auditEmbed(commandCtx, "Automod rules cleared", "/automodconfig rules clear", [
    "Rules text cleared — referrals refuse until it is set again.",
  ]);

  await commandCtx.reply({
    content:
      "**Automod rules cleared.** Cases will refuse naming the missing rules until " +
      "`/automodconfig rules set` runs again — the master switch was left as it was.",
    sensitive: true,
  });
}

/**
 * Modal submit: persist the rules text (`am:rules`, `/automodconfig rules set`
 * without the option). Interaction arm — mirrors the staffNotes modal shape:
 * gate → resolve community → service → audit → replyEphemeral.
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx]
 */
async function handleRulesModal(interaction, ctx) {
  if (!(await requireAdmin(interaction))) return;

  let text = "";
  try {
    text = interaction.fields.getTextInputValue(MODAL_FIELD_RULES);
  } catch {
    text = "";
  }

  const communityId = resolveCommunityId(interaction);
  const result = service.setRules(communityId, text);
  if (!result.ok) {
    await replyEphemeral(interaction, { content: result.error });
    return;
  }

  recordSlashAudit({
    interaction,
    communityId,
    action: "automod.rules_set",
    targetType: "guild",
    targetId: String(interaction.guildId),
    details: { rules_chars: result.rulesChars, source: "modal" },
  });
  await logConfigChange(
    getDiscordOutbound(ctx?.client || interaction.client),
    interaction.guildId,
    {
      title: "Automod rules set",
      command: "/automodconfig rules set (modal)",
      actor: interaction.user,
      changes: [`Rules text replaced (${result.rulesChars} chars).`],
    },
  ).catch(() => {});

  await replyEphemeral(interaction, { content: rulesSuccessContent(result) });
}

// ── enable on|off ───────────────────────────────────────────────────────────

async function handleEnable(commandCtx) {
  const state = String(commandCtx.options.getString("state", true) || "")
    .trim()
    .toLowerCase();
  if (state !== "on" && state !== "off") {
    return replyError(
      commandCtx,
      `\`state\` must be \`on\` or \`off\` (got \`${state}\`).`,
    );
  }

  const result = service.setEnabled(commandCtx.communityId, state === "on");
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.enabled_set", { enabled: result.enabled });
  await auditEmbed(commandCtx, "Automod master switch", "/automodconfig enable", [
    `Auto-moderation: ${result.enabled ? "ENABLED" : "disabled"}`,
  ]);

  const read = service.readSettings(commandCtx.communityId);
  const s = read.ok ? read.settings : null;
  const autoNote =
    result.enabled &&
    s &&
    AUTOMOD_ACTIONS.filter((a) => s.modes[a] === "auto").length > 0
      ? "\n**Heads-up:** actions are already on **auto** — cases can execute them without an approve click."
      : "\nAction modes stay **suggest** until you change them (`/automodconfig mode`) — enabling alone never kicks, times out, or bans.";

  await commandCtx.reply({
    content:
      `**Automod enabled:** ${result.enabled ? "**yes**" : "**off**"}.` +
      autoNote +
      (result.enabled && s && (!s.channelId || !s.rules)
        ? "\n**Missing for cases:**" +
          (s.channelId ? "" : " channel (`/automodconfig channel set`)") +
          (s.channelId && !s.rules ? " ·" : "") +
          (s.rules ? "" : " rules (`/automodconfig rules set`)")
        : ""),
    sensitive: true,
  });
}

// ── mode <action> <mode> ────────────────────────────────────────────────────

async function handleMode(commandCtx) {
  const action = commandCtx.options.getString("action", true);
  const mode = commandCtx.options.getString("mode", true);

  const result = service.setMode(commandCtx.communityId, action, mode);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.mode_set", {
    action: result.action,
    mode: result.mode,
  });
  await auditEmbed(commandCtx, "Automod action mode set", "/automodconfig mode", [
    `${result.action}: ${result.mode}`,
  ]);

  const consequence =
    result.mode === "auto"
      ? result.action === "kick" || result.action === "ban" || result.action === "timeout"
        ? "The harness can now execute this WITHOUT a staff approve click (breaker + timeout cap still apply)."
        : "The harness executes this without a staff approve click."
      : result.mode === "suggest"
        ? "Recommendations show on the case card; a staff Approve runs it."
        : "The tool is not offered to the model and cannot run.";

  await commandCtx.reply({
    content:
      `**Mode set:** \`${result.action}\` → **${result.mode}**.\n` + consequence,
    sensitive: true,
  });
}

// ── timeout-cap / budget ────────────────────────────────────────────────────

async function handleTimeoutCap(commandCtx) {
  const seconds = commandCtx.options.getInteger("seconds", true);
  const result = service.setTimeoutCap(commandCtx.communityId, seconds);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.timeout_cap_set", { seconds: result.timeoutCap });
  await auditEmbed(commandCtx, "Automod timeout cap set", "/automodconfig timeout-cap", [
    `Timeout cap: ${result.timeoutCap} seconds`,
  ]);

  await commandCtx.reply({
    content:
      `**Automod timeout cap set:** **${result.timeoutCap}** seconds. ` +
      "No automod-run timeout may exceed it (floor 60 s, Discord ceiling 28 days).",
    sensitive: true,
  });
}

async function handleBudget(commandCtx) {
  const limit = commandCtx.options.getInteger("limit", true);
  const result = service.setDailyBudget(commandCtx.communityId, limit);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.budget_set", { daily_case_limit: result.dailyCaseLimit });
  await auditEmbed(commandCtx, "Automod daily case budget set", "/automodconfig budget", [
    `Daily case budget: ${result.dailyCaseLimit}`,
  ]);

  const read = service.readSettings(commandCtx.communityId);
  const budgetLine = read.ok ? formatBudgetLine(read.settings) : `\`${limit}\``;
  await commandCtx.reply({
    content:
      `**Automod daily budget set:** \`${limit}\`.\n` +
      `**Today:** ${budgetLine}.\n` +
      "Separate from Gork's budget — a case never touches the other.",
    sensitive: true,
  });
}

// ── safety resume (H2-15 confirm:) ──────────────────────────────────────────

async function handleSafetyResume(commandCtx) {
  const read = service.readSettings(commandCtx.communityId);
  if (!read.ok) return replyError(commandCtx, read.error);
  const s = read.settings;

  if (!s.paused) {
    await commandCtx.reply({
      content: "Auto-mod safety is not paused — nothing to resume.",
      sensitive: true,
    });
    return;
  }

  const armed = AUTOMOD_ACTIONS.filter(
    (a) => s.modes[a] === "auto" && ["timeout", "kick", "ban"].includes(a),
  );
  if (commandCtx.options.getBoolean("confirm") !== true) {
    await commandCtx.reply({
      content:
        `Auto-mod is **paused** (${s.pauseReason ? `reason: \`${s.pauseReason}\`` : "no reason recorded"}).\n` +
        `Resuming re-arms **every action currently on auto**: ${
          armed.length ? armed.map((a) => `\`${a}\``).join(", ") : "none right now"
        }` +
        (armed.includes("kick") || armed.includes("ban")
          ? " — kick and ban are irreversible."
          : "") +
        "\n\nRe-run with `confirm: true` to actually re-arm.",
      sensitive: true,
    });
    return;
  }

  const result = service.resumeSafety(commandCtx.communityId);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.safety_resume", {
    was_paused_at: result.wasPausedAt,
    was_reason: result.wasReason,
    re_armed: armed,
  });
  await auditEmbed(commandCtx, "Automod safety resumed", "/automodconfig safety resume", [
    result.wasReason ? `Was paused: ${result.wasReason}` : "Was paused (no reason recorded).",
    `Re-armed auto actions: ${armed.length ? armed.join(", ") : "none"}`,
  ]);

  await commandCtx.reply({
    content:
      "**Automod safety resumed** — the breaker pause is cleared and actions on **auto** " +
      `(${armed.length ? armed.map((a) => `\`${a}\``).join(", ") : "none currently"}) can execute again.`,
    sensitive: true,
  });
}

module.exports = {
  handleChannelSet,
  handleChannelClear,
  handleRulesSet,
  handleRulesClear,
  handleRulesModal,
  handleEnable,
  handleMode,
  handleTimeoutCap,
  handleBudget,
  handleSafetyResume,
  buildRulesModal,
  everyoneCanView,
  resolveCommunityId,
};
