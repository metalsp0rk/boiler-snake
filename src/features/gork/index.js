/**
 * Gork feature module (roadmap/gork.md): a goofy AI keyword Q&A bot.
 *
 * - `/setgork` (staff): configure the trigger keyword, context window,
 *   per-user cooldown, staff prompt rules, and the SearXNG web_search
 *   toggle for the guild.
 * - `handleGorkMessage`: the onMessageCreate pipeline hook — answers
 *   keyword triggers using conversation context and optional web search.
 *
 * Gork is live whenever `AI_API_KEY` is set; triggers in open ticket
 * channels are ignored (roadmap/gork.md §7.1, decisions 7, 19).
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { getGuildSettings, updateGuildSettings } = require("../../db");
const { requireStaff } = require("../../core/permissions");
const { replyEphemeral } = require("../../core/interaction");
const { Color, baseEmbed } = require("../../core/theme");
const { getAiConfig } = require("../../core/ai");
const { logConfigChange } = require("../logs/auditLog");
const { handleGorkMessage, gorkQueue } = require("./trigger");

const staffPerms = PermissionFlagsBits.ManageGuild;

const KEYWORD_MAX = 50;
const CONTEXT_MIN = 1;
const CONTEXT_MAX = 50;
const COOLDOWN_MIN = 0;
const COOLDOWN_MAX = 3600;
const RULES_MAX = 500;

const commands = [
  new SlashCommandBuilder()
    .setName("setgork")
    .setDescription("Configure Gork, the AI keyword Q&A (staff).")
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
        .setName("status")
        .setDescription("Show the current gork configuration for this guild."),
    ),
];

/**
 * /setgork keyword: set the trigger keyword, or `clear` to disable gork.
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
  await logConfigChange(client, guildId, {
    title: clearing ? "Gork disabled" : "Gork keyword updated",
    command: "/setgork keyword",
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
 * /setgork context: set the context window size (1-50).
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
  await logConfigChange(client, guildId, {
    title: "Gork context window updated",
    command: "/setgork context",
    actor: interaction.user,
    changes: [`Context window: ${settings.gork_context_window} messages`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    `Gork context window set to **${settings.gork_context_window}** prior messages.`,
  );
}

/**
 * /setgork cooldown: set the per-user cooldown in seconds (0-3600).
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
  await logConfigChange(client, guildId, {
    title: "Gork cooldown updated",
    command: "/setgork cooldown",
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
 * /setgork rules: set the staff prompt rules, or `clear` to remove them.
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
  await logConfigChange(client, guildId, {
    title: stored ? "Gork staff rules updated" : "Gork staff rules removed",
    command: "/setgork rules",
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
 * /setgork search: toggle the SearXNG web_search tool for the guild.
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
  await logConfigChange(client, guildId, {
    title: `Gork web search ${on ? "enabled" : "disabled"}`,
    command: "/setgork search",
    actor: interaction.user,
    changes: [`Web search: ${on ? "on" : "off"}`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    on
      ? "Gork web search is now **on** (runs against the bot's SearXNG instance — see `/setgork status` for the URL state)."
      : "Gork web search is now **off** — answers come from conversation context only.",
  );
}

/**
 * /setgork status: ephemeral embed of the current configuration.
 */
async function showStatus(interaction, guildId) {
  const settings = getGuildSettings(guildId);
  const keyword = (settings.gork_keyword || "").trim();
  const rules = (settings.gork_extra_rules || "").trim();
  const searchOn = Number(settings.gork_search_enabled) === 1;
  const cooldownSec = settings.gork_cooldown_sec;
  const ai = getAiConfig();
  const searxngSet = Boolean(
    typeof process.env.SEARXNG_URL === "string" && process.env.SEARXNG_URL.trim(),
  );

  const embed = baseEmbed({ color: Color.brand, title: "Gork status", timestamp: true });
  embed.addFields(
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
  );
  await replyEphemeral(interaction, { embeds: [embed] });
}

/**
 * /setgork handler (staff-gated via requireStaff).
 *
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {object} ctx
 * @param {import("discord.js").Client} ctx.client
 */
async function handleSetGork(interaction, ctx) {
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
    setgork: handleSetGork,
  },
  handleGorkMessage,
  gorkQueue,
};
