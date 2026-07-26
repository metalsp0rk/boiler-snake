const { MessageFlags } = require("discord.js");

/**
 * Ephemeral reply helper.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {string} content
 */
async function replyEphemeral(interaction, content) {
  return interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Best-effort error response after a handler throws.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {string} [content]
 */
async function safeErrorReply(
  interaction,
  content = "Something went wrong handling that command (check bot logs)."
) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch {
    // Discord may already have timed out; nothing else we can do.
  }
}

module.exports = {
  replyEphemeral,
  safeErrorReply,
};
