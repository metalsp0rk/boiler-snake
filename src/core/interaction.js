const { MessageFlags } = require("discord.js");
const { MSG_DENIED, MSG_GENERIC_ERROR } = require("./theme");

/**
 * Normalize a content string or payload object into an ephemeral reply payload.
 * @param {string|object} contentOrOptions
 * @returns {object}
 */
function ephemeralPayload(contentOrOptions) {
  if (typeof contentOrOptions === "string") {
    return { content: contentOrOptions, flags: MessageFlags.Ephemeral };
  }
  return { ...contentOrOptions, flags: MessageFlags.Ephemeral };
}

/**
 * Ephemeral reply helper (string content or full payload with embeds).
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {string|object} contentOrOptions
 */
async function replyEphemeral(interaction, contentOrOptions) {
  return interaction.reply(ephemeralPayload(contentOrOptions));
}

/**
 * Ephemeral editReply (after defer).
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {string|object} contentOrOptions
 */
async function editEphemeral(interaction, contentOrOptions) {
  const payload =
    typeof contentOrOptions === "string"
      ? { content: contentOrOptions }
      : { ...contentOrOptions };
  // editReply inherits ephemeral from the original deferred/ephemeral reply
  delete payload.flags;
  return interaction.editReply(payload);
}

/**
 * Reply or followUp with ephemeral payload depending on interaction state.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {string|object} contentOrOptions
 */
async function replyOrFollowUpEphemeral(interaction, contentOrOptions) {
  const payload = ephemeralPayload(contentOrOptions);
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

/**
 * Standard permission denial.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 */
async function replyDenied(interaction) {
  return replyOrFollowUpEphemeral(interaction, MSG_DENIED);
}

/**
 * Best-effort error response after a handler throws.
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @param {string} [content]
 */
async function safeErrorReply(interaction, content = MSG_GENERIC_ERROR) {
  try {
    await replyOrFollowUpEphemeral(interaction, content);
  } catch {
    // Discord may already have timed out; nothing else we can do.
  }
}

module.exports = {
  ephemeralPayload,
  replyEphemeral,
  editEphemeral,
  replyOrFollowUpEphemeral,
  replyDenied,
  safeErrorReply,
  MSG_DENIED,
  MSG_GENERIC_ERROR,
};
