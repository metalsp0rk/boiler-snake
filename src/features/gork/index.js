/**
 * Gork feature module (roadmap/gork.md): a goofy AI keyword Q&A bot.
 *
 * - `/gork` (staff): configure the trigger keyword, context window,
 *   per-user cooldown, staff prompt rules, the SearXNG web_search toggle,
 *   and the guild master enable switch; ban/unban/list users blocked from
 *   using gork in this guild.
 * - `handleGorkMessage`: the onMessageCreate pipeline hook — answers
 *   keyword triggers using conversation context and optional web search.
 *
 * Gork is live whenever `AI_API_KEY` is set and the guild's `gork_enabled`
 * switch is on; triggers in open ticket channels are ignored
 * (roadmap/gork.md §7.1, decisions 7, 19).
 *
 * Banned users (guild `gork_user_blocks`) still see the locked
 * LLM-failure canned reply, so a ban is indistinguishable from a normal
 * failure; unlike the cooldown, staff status does NOT bypass a ban.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  getGuildSettings,
  updateGuildSettings,
  addGorkBlock,
  removeGorkBlock,
  listGorkBlocks,
} = require("../../db");
const { requireStaff } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { Color, baseEmbed } = require("../../core/theme");
const { getAiConfig } = require("../../core/ai");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const { handleGorkMessage, gorkQueue } = require("./trigger");

const staffPerms = PermissionFlagsBits.ManageGuild;

const KEYWORD_MAX = 50;
const CONTEXT_MIN = 1;
const CONTEXT_MAX = 50;
const COOLDOWN_MIN = 0;
const COOLDOWN_MAX = 3600;
const RULES_MAX = 500;
/** Max banned users listed by `/gork bans` (rest summarized). */
const BANS_LIST_MAX = 25;

const commands = [
  new SlashCommandBuilder()
    .setName("gork")
    .setDescription("Configure and moderate Gork, the AI keyword Q&A (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("keyword")
        .setDescription(
          "Set the trigger keyword (1-50 chars). Use `clear` to disable gork.",
        )
        .addStringOption((opt) =>
          opt
            .setName("keyword")
            .setDescription(
              "Trigger keyword (1-50 chars), or `clear` to disable gork",
            )
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(KEYWORD_MAX),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("context")
        .setDescription("Set the context window size (1-50 prior messages).")
        .addIntegerOption((opt) =>
          opt
            .setName("context")
            .setDescription("How many prior messages feed the prompt (1-50)")
            .setRequired(true)
            .setMinValue(CONTEXT_MIN)
            .setMaxValue(CONTEXT_MAX),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("cooldown")
        .setDescription(
          "Set the per-user cooldown in seconds (0-3600; 0 = disabled). Staff always bypass.",
        )
        .addIntegerOption((opt) =>
          opt
            .setName("cooldown")
            .setDescription(
              "Seconds between triggers per user (0-3600; 0 = disabled; staff always bypass)",
            )
            .setRequired(true)
            .setMinValue(COOLDOWN_MIN)
            .setMaxValue(COOLDOWN_MAX),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("rules")
        .setDescription(
          "Set additional staff prompt rules (max 500 chars). Use `clear` to remove them.",
        )
        .addStringOption((opt) =>
          opt
            .setName("rules")
            .setDescription(
              "Extra prompt rules appended for this guild (max 500 chars), or `clear` to remove",
            )
            .setRequired(true)
            .setMaxLength(RULES_MAX),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("search")
        .setDescription("Toggle the SearXNG web_search tool for this guild.")
        .addStringOption((opt) =>
          opt
            .setName("search")
            .setDescription("Enable (on) or disable (off) web search")
            .setRequired(true)
            .addChoices(
              { name: "on", value: "on" },
              { name: "off", value: "off" },
            ),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("enable")
        .setDescription(
          "Enable or disable gork entirely for this server (settings are kept).",
        )
        .addStringOption((opt) =>
          opt
            .setName("enable")
            .setDescription("Turn gork on or off for this server")
            .setRequired(true)
            .addChoices(
              { name: "on", value: "on" },
              { name: "off", value: "off" },
            ),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("ban")
        .setDescription(
          "Ban a user from using gork in this server (they get the generic failure reply).",
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("User to ban from gork")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("unban")
        .setDescription("Lift a user's gork ban in this server.")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("User to unban from gork")
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("bans")
        .setDescription("List the users banned from gork in this server."),
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription("Show the current gork configuration for this guild."),
    ),
];

/**
 * /gork keyword: set the trigger keyword, or `clear` to disable gork.
 */
async function setKeyword(client, interaction, guildId) {
  const raw = (interaction.options.getString("keyword") || "").trim();
  const clearing = raw === "clear";
  if (!clearing && (!raw || raw.length > KEYWORD_MAX)) {
    return replyEphemeral(
      interaction,
      `The keyword must be 1-${KEYWORD_MAX} characters (or \`clear\` to disable gork).`,
    );
  }
  const settings = updateGuildSettings(guildId, {
    gork_keyword: clearing ? null : raw,
  });
  recordSlashAudit({
    interaction,
    action: "gork.keyword_set",
    targetType: "guild",
    targetId: guildId,
    details: { keyword: settings.gork_keyword ?? null, cleared: clearing },
  });
  await logConfigChange(client, guildId, {
    title: clearing ? "Gork disabled" : "Gork keyword updated",
    command: "/gork keyword",
    actor: interaction.user,
    changes: [
      clearing
        ? "Keyword: cleared (gork disabled)"
        : `Keyword: \`${settings.gork_keyword}\``,
    ],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    clearing
      ? "Gork is now **disabled** for this server — triggers are ignored."
      : `Gork keyword set to \`${settings.gork_keyword}\`. Trigger it with \`${settings.gork_keyword} <question>\`, or \`${settings.gork_keyword}\` replying to a message.`,
  );
}

/**
 * /gork context: set the context window size (1-50).
 */
async function setContext(client, interaction, guildId) {
  const raw = interaction.options.getInteger("context");
  if (!Number.isFinite(raw) || raw < CONTEXT_MIN || raw > CONTEXT_MAX) {
    return replyEphemeral(
      interaction,
      `The context window must be ${CONTEXT_MIN}-${CONTEXT_MAX} messages.`,
    );
  }
  const settings = updateGuildSettings(guildId, {
    gork_context_window: raw,
  });
  recordSlashAudit({
    interaction,
    action: "gork.context_set",
    targetType: "guild",
    targetId: guildId,
    details: { context_window: settings.gork_context_window },
  });
  await logConfigChange(client, guildId, {
    title: "Gork context window updated",
    command: "/gork context",
    actor: interaction.user,
    changes: [`Context window: ${settings.gork_context_window} messages`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    `Gork context window set to **${settings.gork_context_window}** prior messages.`,
  );
}

/**
 * /gork cooldown: set the per-user cooldown in seconds (0-3600).
 */
async function setCooldown(client, interaction, guildId) {
  const raw = interaction.options.getInteger("cooldown");
  if (!Number.isFinite(raw) || raw < COOLDOWN_MIN || raw > COOLDOWN_MAX) {
    return replyEphemeral(
      interaction,
      `The cooldown must be ${COOLDOWN_MIN}-${COOLDOWN_MAX} seconds (0 = disabled).`,
    );
  }
  const settings = updateGuildSettings(guildId, {
    gork_cooldown_sec: raw,
  });
  const stored = settings.gork_cooldown_sec;
  recordSlashAudit({
    interaction,
    action: "gork.cooldown_set",
    targetType: "guild",
    targetId: guildId,
    details: { cooldown_sec: stored },
  });
  await logConfigChange(client, guildId, {
    title: "Gork cooldown updated",
    command: "/gork cooldown",
    actor: interaction.user,
    changes: [`Cooldown: ${stored}s (staff always bypass)`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    stored === 0
      ? "Gork cooldown is now **disabled** (0s). Staff always bypass."
      : `Gork cooldown set to **${stored}s** per user per server. Staff always bypass.`,
  );
}

/**
 * /gork rules: set the staff prompt rules, or `clear` to remove them.
 */
async function setRules(client, interaction, guildId) {
  const raw = (interaction.options.getString("rules") || "").trim();
  const clearing = raw === "clear";
  if (!clearing && !raw) {
    return replyEphemeral(
      interaction,
      "Rules cannot be empty — use `clear` to remove them.",
    );
  }
  if (raw.length > RULES_MAX) {
    return replyEphemeral(
      interaction,
      `Rules must be at most ${RULES_MAX} characters.`,
    );
  }
  const settings = updateGuildSettings(guildId, {
    gork_extra_rules: clearing ? "" : raw,
  });
  const stored = (settings.gork_extra_rules || "").trim();
  recordSlashAudit({
    interaction,
    action: "gork.rules_set",
    targetType: "guild",
    targetId: guildId,
    details: { rules: stored, cleared: clearing },
  });
  await logConfigChange(client, guildId, {
    title: stored ? "Gork staff rules updated" : "Gork staff rules removed",
    command: "/gork rules",
    actor: interaction.user,
    changes: [stored ? `Rules: \`${stored}\`` : "Rules: removed"],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    stored
      ? `Gork staff rules set to:\n\`${stored}\`\n\nThey are appended to the system prompt; the SFW / questions-only guardrails always apply.`
      : "Gork staff rules removed.",
  );
}

/**
 * /gork search: toggle the SearXNG web_search tool for the guild.
 */
async function setSearch(client, interaction, guildId) {
  const raw = (interaction.options.getString("search") || "").toLowerCase();
  if (raw !== "on" && raw !== "off") {
    return replyEphemeral(interaction, "Search must be `on` or `off`.");
  }
  const settings = updateGuildSettings(guildId, {
    gork_search_enabled: raw === "on" ? 1 : 0,
  });
  const on = Number(settings.gork_search_enabled) === 1;
  recordSlashAudit({
    interaction,
    action: "gork.search_set",
    targetType: "guild",
    targetId: guildId,
    details: { enabled: on ? 1 : 0 },
  });
  await logConfigChange(client, guildId, {
    title: `Gork web search ${on ? "enabled" : "disabled"}`,
    command: "/gork search",
    actor: interaction.user,
    changes: [`Web search: ${on ? "on" : "off"}`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    on
      ? "Gork web search is now **on** (runs against the bot's SearXNG instance — see `/gork status` for the URL state)."
      : "Gork web search is now **off** — answers come from conversation context only.",
  );
}

/**
 * /gork enable: master on/off switch for the whole gork feature in this
 * guild. Off makes triggers fully silent; every other gork setting
 * (keyword, rules, cooldown, bans, ...) is preserved for re-enable.
 */
async function setEnable(client, interaction, guildId) {
  const raw = (interaction.options.getString("enable") || "").toLowerCase();
  if (raw !== "on" && raw !== "off") {
    return replyEphemeral(interaction, "Enable must be `on` or `off`.");
  }
  const settings = updateGuildSettings(guildId, {
    gork_enabled: raw === "on" ? 1 : 0,
  });
  const on = Number(settings.gork_enabled ?? 1) === 1;
  recordSlashAudit({
    interaction,
    action: "gork.enabled_set",
    targetType: "guild",
    targetId: guildId,
    details: { enabled: on ? 1 : 0 },
  });
  await logConfigChange(client, guildId, {
    title: `Gork ${on ? "enabled" : "disabled"} for the server`,
    command: "/gork enable",
    actor: interaction.user,
    changes: [`Gork: ${on ? "enabled" : "disabled"}`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    on
      ? "Gork is now **enabled** for this server — keyword triggers are active again."
      : "Gork is now **disabled** for this server — all triggers are ignored. Every other gork setting is kept; re-enable with `/gork enable on`.",
  );
}

/**
 * /gork ban: block a user from gork in this guild. The banned user keeps
 * getting the locked generic replies (never told about the ban), and
 * staff roles do NOT bypass the ban.
 */
async function banUser(client, interaction, guildId) {
  const user = interaction.options.getUser("user");
  if (!user) {
    return replyEphemeral(interaction, "Pick a user to ban from gork.");
  }
  if (user.bot) {
    return replyEphemeral(
      interaction,
      "Bots can't be banned from gork (they never trigger it anyway).",
    );
  }
  addGorkBlock(guildId, user.id, interaction.user.id);
  recordSlashAudit({
    interaction,
    action: "gork.ban",
    targetType: "user",
    targetId: user.id,
  });
  await logConfigChange(client, guildId, {
    title: "Gork user banned",
    command: "/gork ban",
    actor: interaction.user,
    changes: [`Banned from gork: <@${user.id}> (\`${user.id}\`)`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    `<@${user.id}> is now **banned from gork** in this server — triggers get the generic "brain went to lunch" reply (they are not told it's a ban). Lift it with \`/gork unban\`.`,
  );
}

/**
 * /gork unban: lift a user's gork ban in this guild.
 */
async function unbanUser(client, interaction, guildId) {
  const user = interaction.options.getUser("user");
  if (!user) {
    return replyEphemeral(interaction, "Pick a user to unban from gork.");
  }
  const removed = removeGorkBlock(guildId, user.id);
  if (!removed) {
    return replyEphemeral(
      interaction,
      `<@${user.id}> is not banned from gork in this server.`,
    );
  }
  recordSlashAudit({
    interaction,
    action: "gork.unban",
    targetType: "user",
    targetId: user.id,
  });
  await logConfigChange(client, guildId, {
    title: "Gork user unbanned",
    command: "/gork unban",
    actor: interaction.user,
    changes: [`Unbanned from gork: <@${user.id}> (\`${user.id}\`)`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    `<@${user.id}> can use gork again in this server.`,
  );
}

/**
 * /gork bans: ephemeral list of users banned from gork in this guild.
 */
async function showBans(interaction, guildId) {
  const blocks = listGorkBlocks(guildId);
  if (!blocks.length) {
    return replyEphemeral(
      interaction,
      "No users are banned from gork in this server.",
    );
  }
  const shown = blocks.slice(0, BANS_LIST_MAX).map((b) => `- <@${b.user_id}>`);
  if (blocks.length > BANS_LIST_MAX) {
    shown.push(`…and ${blocks.length - BANS_LIST_MAX} more`);
  }
  await replyEphemeral(
    interaction,
    `**Gork bans (${blocks.length}):**\n${shown.join("\n")}`,
  );
}

/**
 * /gork status: ephemeral embed of the current configuration.
 */
async function showStatus(interaction, guildId) {
  const settings = getGuildSettings(guildId);
  const enabled = Number(settings.gork_enabled ?? 1) === 1;
  const keyword = (settings.gork_keyword || "").trim();
  const rules = (settings.gork_extra_rules || "").trim();
  const searchOn = Number(settings.gork_search_enabled) === 1;
  const cooldownSec = settings.gork_cooldown_sec;
  const banCount = listGorkBlocks(guildId).length;
  const ai = getAiConfig();
  const searxngSet = Boolean(
    typeof process.env.SEARXNG_URL === "string" && process.env.SEARXNG_URL.trim(),
  );

  const embed = baseEmbed({ color: Color.brand, title: "Gork status", timestamp: true });
  embed.addFields(
    { name: "Enabled", value: enabled ? "on" : "**off** (server disabled)", inline: true },
    { name: "Keyword", value: keyword ? `\`${keyword}\`` : "disabled", inline: true },
    { name: "Context window", value: `${settings.gork_context_window} messages`, inline: true },
    {
      name: "Cooldown",
      value: `${cooldownSec}s per user (staff bypass)`,
      inline: true,
    },
    { name: "Rules", value: rules || "none", inline: true },
    { name: "Search (SearXNG)", value: searchOn ? "on" : "off", inline: true },
    {
      name: "AI provider",
      value: ai.apiKey ? "configured" : "**not configured**",
      inline: true,
    },
    { name: "SearXNG URL", value: searxngSet ? "set" : "not set", inline: true },
    { name: "Banned users", value: String(banCount), inline: true },
  );
  await replyEphemeral(interaction, { embeds: [embed] });
}

/**
 * /gork handler (staff-gated via requireStaff).
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 * @param {import("discord.js").Client} ctx.client
 */
async function handleGork(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;
  const { client } = ctx || {};
  const guildId = interaction.guildId;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "keyword":
      return setKeyword(client, interaction, guildId);
    case "context":
      return setContext(client, interaction, guildId);
    case "cooldown":
      return setCooldown(client, interaction, guildId);
    case "rules":
      return setRules(client, interaction, guildId);
    case "search":
      return setSearch(client, interaction, guildId);
    case "enable":
      return setEnable(client, interaction, guildId);
    case "ban":
      return banUser(client, interaction, guildId);
    case "unban":
      return unbanUser(client, interaction, guildId);
    case "bans":
      return showBans(interaction, guildId);
    case "status":
      return showStatus(interaction, guildId);
    default:
      return replyEphemeral(interaction, `Unknown gork subcommand: \`${sub}\`.`);
  }
}

module.exports = {
  name: "gork",
  commands,
  handlers: {
    gork: handleGork,
  },
  handleGorkMessage,
  gorkQueue,
};
