const { MessageFlags } = require("discord.js");
const { commandsAllowed } = require("../core/permissions");
const { safeErrorReply, replyEphemeral } = require("../core/interaction");
const { buildDiscordCommandContext } = require("../platform/discord/context");
const { assertCommandContext } = require("../platform/context");

/**
 * #391 (A2-5, error rule 2): the context line every router failure site
 * logs. When the router surfaces a failure the handler is already dead —
 * it never got the chance to log its own ids — so THIS log must be enough
 * to reproduce from logs alone (guild, user, command, customId). Reads
 * are defensive: interaction accessors vary by type and a dying path must
 * not die harder while formatting its own report. customId is
 * user-influenced and gets a length cap — a 10 KB button id must not
 * become a 10 KB log line.
 *
 * @param {import("discord.js").Interaction} interaction
 * @returns {string}
 */
function interactionLogContext(interaction) {
  const safe = (read, fallback = "?") => {
    try {
      const value = read();
      return value == null || value === "" ? fallback : String(value);
    } catch {
      return fallback;
    }
  };
  const kind = safe(
    () =>
      interaction.isAutocomplete?.()
        ? "autocomplete"
        : interaction.isModalSubmit?.()
          ? "modal"
          : interaction.isButton?.()
            ? "button"
            : interaction.isChatInputCommand?.()
              ? "chat"
              : "interaction",
    "interaction",
  );
  const bits = [
    `kind=${kind}`,
    `guild=${safe(() => interaction.guildId ?? interaction.guild?.id)}`,
    `user=${safe(() => interaction.user?.id ?? interaction.member?.user?.id)}`,
  ];
  const command = safe(() => interaction.commandName, "");
  if (command) bits.push(`command=/${command}`);
  const customId = safe(() => interaction.customId, "");
  if (customId) bits.push(`customId=${customId.slice(0, 120)}`);
  return bits.join(" ");
}

/**
 * Dispatch a Discord interaction through the command registry.
 *
 * @param {import("discord.js").Interaction} interaction
 * @param {object} ctx
 * @param {object} ctx.supervisor platform supervisor ({ discord, fluxer,
 *   clientForCommunity }) — PR 7 replaced the old ctx.client first slot.
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
      console.error(
        "[router] autocomplete handler failed:",
        interactionLogContext(interaction),
        err?.message || err,
      );
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
      console.error(
        "[router] modal submit handler failed:",
        interactionLogContext(interaction),
        err?.message || err,
      );
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
      console.error(
        "[router] button handler failed:",
        interactionLogContext(interaction),
        err?.message || err,
      );
      await safeErrorReply(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  try {
    if (!commandsAllowed(interaction)) {
      await replyEphemeral(
        interaction,
        "Commands aren't enabled in this channel.",
      );
      return;
    }

    const handler = registry.getHandler(interaction.commandName);
    if (!handler) {
      await replyEphemeral(
        interaction,
        `Unhandled command: \`/${interaction.commandName}\` (handler missing).`,
      );
      return;
    }

    // Context-arm handlers receive the platform-neutral CommandContext as
    // their first argument (spec § Handler migration rule). Everything around
    // this call — the command-channel gate, logging, safeErrorReply — keeps
    // operating on the raw interaction.
    const api = registry.getHandlerApi(interaction.commandName);
    if (api === "context") {
      const commandCtx = buildDiscordCommandContext(interaction, ctx);
      // #457 (A2-2/H1-9): the boundary guard — built, unit-tested, and
      // wired HERE at last. A builder field rename/omission fails HERE
      // with a named contract error (this router's log + safeErrorReply),
      // not as a confusing TypeError three frames deep inside a handler.
      assertCommandContext(commandCtx);
      await handler(commandCtx, ctx);
    } else {
      await handler(interaction, ctx);
    }
  } catch (err) {
    console.error(
      "[router] command handler failed:",
      interactionLogContext(interaction),
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
}

module.exports = { handleInteraction };
