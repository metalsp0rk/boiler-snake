const { MessageFlags } = require("discord.js");
const { commandsAllowed } = require("../core/permissions");
const { safeErrorReply } = require("../core/interaction");

/**
 * Dispatch a Discord interaction through the command registry.
 *
 * @param {import("discord.js").Interaction} interaction
 * @param {object} ctx
 * @param {import("discord.js").Client} ctx.client
 * @param {import("./registry").CommandRegistry} ctx.registry
 * @param {Function} [ctx.ensureHoneypotWarning]
 */
async function handleInteraction(interaction, ctx) {
  const { registry } = ctx;

  if (interaction.isAutocomplete()) {
    try {
      const fn = registry.getAutocomplete(interaction.commandName);
      if (!fn) {
        await interaction.respond([]);
        return;
      }
      await fn(interaction, ctx);
    } catch (err) {
      console.error("Autocomplete handler error:", err);
      try {
        await interaction.respond([]);
      } catch {
        // ignore
      }
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (!interaction.guild) return;
    try {
      const fn = registry.getModalHandler(interaction.customId);
      if (!fn) return;
      await fn(interaction, ctx);
    } catch (err) {
      console.error("Modal submit handler error:", err);
      await safeErrorReply(interaction);
    }
    return;
  }

  if (interaction.isButton()) {
    if (!interaction.guild) return;
    try {
      const fn = registry.getButtonHandler(interaction.customId);
      if (!fn) return;
      await fn(interaction, ctx);
    } catch (err) {
      console.error("Button handler error:", err);
      await safeErrorReply(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  try {
    if (!commandsAllowed(interaction)) {
      await interaction.reply({
        content: "Commands aren't enabled in this channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const handler = registry.getHandler(interaction.commandName);
    if (!handler) {
      await interaction.reply({
        content: `Unhandled command: \`/${interaction.commandName}\` (handler missing).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await handler(interaction, ctx);
  } catch (err) {
    console.error("Interaction handler error:", err);
    await safeErrorReply(interaction);
  }
}

module.exports = { handleInteraction };
