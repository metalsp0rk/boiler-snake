/**
 * /automodconfig — admin mutation arms (#725 + rules-channel extraction,
 * epic #723).
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
 *
 * The rules arms never write rules text directly: `source` stores the rules
 * channel and runs the one-time batch extraction (./rulesExtract.js),
 * `extract` re-runs it, `clear` resets both. The extraction is long-running
 * (bounded channel read + one provider call) — its arms defer and editReply.
 */

const { PermissionsBitField } = require("discord.js");
const { recordSlashAudit } = require("../../core/auditTrail");
const { logConfigChange } = require("../logs/auditLog");
const { ensureCommunity } = require("../../platform/community");
const { AUTOMOD_ACTIONS, AUTOMOD_RULES_MAX_LEN } = require("./constants");
const service = require("./settings");
const rulesExtract = require("./rulesExtract");
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

/**
 * ONE set-arm body for BOTH surfaces (#771 §6: `/set-moderation-queue set`
 * is a thin alias over `/automodconfig channel set` — one queue, one source
 * of truth). They differ only in the audit verb, the embed label, and the
 * reply head; the store write, the @everyone probe, and the warning copy
 * are shared by construction.
 */
async function setChannelCore(commandCtx, { auditAction, embedTitle, commandLabel, head }) {
  const channel = commandCtx.options.getChannel("channel", true);
  const result = service.setChannel(commandCtx.communityId, channel.id);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, auditAction, { channel_id: channel.id });
  await auditEmbed(commandCtx, embedTitle, commandLabel, [
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
    content: head(channel.id) + warning,
    sensitive: true,
  });
}

async function clearChannelCore(commandCtx, { auditAction, embedTitle, commandLabel, content }) {
  const result = service.clearChannel(commandCtx.communityId);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, auditAction);
  await auditEmbed(commandCtx, embedTitle, commandLabel, [
    "Case-card channel unset — referrals refuse until it is set again.",
  ]);

  await commandCtx.reply({ content, sensitive: true });
}

async function handleChannelSet(commandCtx) {
  return setChannelCore(commandCtx, {
    auditAction: "automod.channel_set",
    embedTitle: "Automod channel set",
    commandLabel: "/automodconfig channel set",
    head: (id) =>
      `**Automod channel set:** <#${id}>.\n` +
      "Case cards post here once the feature is enabled.",
  });
}

async function handleChannelClear(commandCtx) {
  return clearChannelCore(commandCtx, {
    auditAction: "automod.channel_clear",
    embedTitle: "Automod channel cleared",
    commandLabel: "/automodconfig channel clear",
    content:
      "**Automod channel cleared.** Cases will refuse naming the missing channel " +
      "until `/automodconfig channel set` runs again — the master switch was left as it was.",
  });
}

// ── /set-moderation-queue set|clear (#771 §6 — alias surface) ──────────────

async function handleQueueSet(commandCtx) {
  return setChannelCore(commandCtx, {
    auditAction: "automod.queue_set",
    embedTitle: "Moderation queue channel set",
    commandLabel: "/set-moderation-queue set",
    head: (id) =>
      `**Moderation queue set:** <#${id}>.\n` +
      "Automod case cards post here — the same queue `/automodconfig channel` sets.",
  });
}

async function handleQueueClear(commandCtx) {
  return clearChannelCore(commandCtx, {
    auditAction: "automod.queue_clear",
    embedTitle: "Moderation queue channel cleared",
    commandLabel: "/set-moderation-queue clear",
    content:
      "**Moderation queue cleared.** Cases will refuse naming the missing channel " +
      "until `/set-moderation-queue set` (or `/automodconfig channel set`) runs " +
      "again — the master switch was left as it was.",
  });
}

// ── rules source|extract|clear ─────────────────────────────────────────────

/**
 * Success copy shared by both extraction arms. Every honest tail rides in
 * the ONE reply: what was read, whether the corpus was trimmed (never a
 * silent cut), and any partial read that degraded the batch.
 */
function rulesExtractContent(result) {
  const lines = [
    `**Automod rules extracted** (**${result.rulesChars}** of ${AUTOMOD_RULES_MAX_LEN} chars) ` +
      `from <#${result.channelId}> — ${result.kept} post(s) distilled` +
      `${result.pinsKept > 0 ? ` (${result.pinsKept} pinned)` : ""}.`,
    "Cases judge against this text. Refresh after channel edits with " +
      "`/automodconfig rules extract`.",
  ];
  if (result.truncated) {
    lines.push(
      `**Note:** the channel held more than the extraction input cap — the oldest ` +
        `${result.dropped} post(s) were left out of the batch. Re-run after trimming the channel ` +
        "if you expect those to matter.",
    );
  }
  if (result.pinsFailed) {
    lines.push("**Note:** the pins read failed — only recent history was distilled.");
  }
  if (result.historyFailed) {
    lines.push("**Note:** the history read stopped early (see logs) — older posts may be missing.");
  }
  return lines.join("\n");
}

/**
 * ONE extraction body for BOTH arms (`source` stores then extracts,
 * `extract` re-runs the stored source). Long-running by design — a bounded
 * channel read + one provider call — so the arm defers ephemerally and
 * edits the result in. Failures store NOTHING (the service refuses over
 * cap) and reply with the specific cause verbatim.
 */
async function runRulesExtraction(commandCtx, channelId, { auditAction, commandLabel }) {
  await commandCtx.defer({ sensitive: true });
  const result = await rulesExtract.extractRules({
    communityId: commandCtx.communityId,
    guildId: commandCtx.externalGuildId,
    channelId,
    deps: { guild: commandCtx.rawInteraction?.guild ?? null },
  });
  if (!result.ok) {
    await commandCtx.editReply({ content: result.error });
    return;
  }

  auditMutation(commandCtx, auditAction, {
    rules_chars: result.rulesChars,
    rules_channel_id: result.channelId,
    posts_kept: result.kept,
    posts_dropped: result.dropped,
    pins_kept: result.pinsKept,
    truncated: result.truncated ? 1 : 0,
  });
  await auditEmbed(commandCtx, "Automod rules extracted", commandLabel, [
    `Rules text replaced (${result.rulesChars} chars) — distilled from <#${result.channelId}>.`,
  ]);
  await commandCtx.editReply({ content: rulesExtractContent(result) });
}

async function handleRulesSource(commandCtx) {
  const channel = commandCtx.options.getChannel("channel", true);
  const result = service.setRulesChannel(commandCtx.communityId, channel.id);
  if (!result.ok) return replyError(commandCtx, result.error);

  auditMutation(commandCtx, "automod.rules_source_set", { rules_channel_id: channel.id });
  await auditEmbed(commandCtx, "Automod rules source set", "/automodconfig rules source", [
    `Rules channel: <#${channel.id}> (${channel.id}) — extraction runs now.`,
  ]);

  // The one-time batch operation fires immediately on set: the operator
  // sees the distilled result in the SAME interaction. If it fails the
  // SOURCE stays stored (config hygiene first) and the reply names the
  // specific cause plus the refresh path.
  return runRulesExtraction(commandCtx, channel.id, {
    auditAction: "automod.rules_extracted",
    commandLabel: "/automodconfig rules source",
  });
}

async function handleRulesExtract(commandCtx) {
  const read = service.readSettings(commandCtx.communityId);
  if (!read.ok) return replyError(commandCtx, read.error);
  const channelId = read.settings.rulesChannelId;
  if (!channelId) {
    return replyError(
      commandCtx,
      "No rules channel is set — `/automodconfig rules source <channel>` stores it and runs " +
        "the first extraction.",
    );
  }
  return runRulesExtraction(commandCtx, channelId, {
    auditAction: "automod.rules_extracted",
    commandLabel: "/automodconfig rules extract",
  });
}

async function handleRulesClear(commandCtx) {
  const text = service.clearRules(commandCtx.communityId);
  if (!text.ok) return replyError(commandCtx, text.error);
  auditMutation(commandCtx, "automod.rules_clear");

  const source = service.clearRulesChannel(commandCtx.communityId);
  if (source.ok) auditMutation(commandCtx, "automod.rules_channel_clear");

  await auditEmbed(commandCtx, "Automod rules cleared", "/automodconfig rules clear", [
    "Rules text cleared — referrals refuse until the next extraction.",
    source.ok
      ? "Rules-channel source cleared too."
      : `Rules-channel source NOT cleared: ${source.error}`,
  ]);

  // Partial failure reports PARTIAL success (error rule 5), never a lie
  // about the whole setting being gone.
  await commandCtx.reply({
    content: source.ok
      ? "**Automod rules cleared** (text + rules-channel source). Cases will refuse naming " +
        "the missing rules until `/automodconfig rules source` runs again — the master switch " +
        "was left as it was."
      : `**Automod rules text cleared**, but the rules-channel source could NOT be unset: ` +
        `${source.error}`,
    sensitive: true,
  });
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
          (s.rules ? "" : " rules (`/automodconfig rules source`)")
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
  // #771 §6 — /set-moderation-queue alias arms (same core, own audit verbs).
  handleQueueSet,
  handleQueueClear,
  // Rules-channel extraction arms (source = store + batch extract, extract =
  // re-run the stored source, clear = text + source).
  handleRulesSource,
  handleRulesExtract,
  handleRulesClear,
  handleEnable,
  handleMode,
  handleTimeoutCap,
  handleBudget,
  handleSafetyResume,
  everyoneCanView,
  resolveCommunityId,
};
