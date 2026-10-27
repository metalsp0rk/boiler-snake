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
              : interaction.isMessageContextMenuCommand?.()
                ? "message-context"
                : interaction.isUserContextMenuCommand?.()
                  ? "user-context"
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
 * Shared command dispatch for the chat-input and context-menu arms (#745,
 * decision 9): guild guard, command-channel gate, registry lookup by
 * interaction.commandName, the explicit "unhandled" ephemeral on a missing
 * handler, and the catch contract — one specific [router] log line plus
 * safeErrorReply (error rules 1–2: never a silent drop). `invoke` receives
 * the found handler and performs the arm-specific call. The statement order
 * is the chat arm's original, so both arms keep its observable behavior —
 * including gate/denial-reply failures flowing into the same catch.
 *
 * @param {import("discord.js").Interaction} interaction
 * @param {object} ctx router ctx ({ registry, … })
 * @param {(handler: Function, interaction: object, ctx: object) => Promise<void>} invoke
 */
async function runCommandArm(interaction, ctx, invoke) {
  const { registry } = ctx;
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

    await invoke(handler, interaction, ctx);
  } catch (err) {
    console.error(
      "[router] command handler failed:",
      interactionLogContext(interaction),
      err?.message || err,
    );
    await safeErrorReply(interaction);
  }
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
      if (!fn) {
        // #467 (A2-6): an unmatched customId used to be a SILENT drop —
        // eternal client spinner, zero server trace (e.g. a button on an
        // old panel message after a deploy renamed it). Log the identity
        // and answer ephemerally; rule 4's invented-generic ban does not
        // apply — this is not an error reply, it is the truth.
        console.warn(
          "[router] no modal handler for customId:",
          interactionLogContext(interaction),
        );
        await replyEphemeral(
          interaction,
          "This control is from an older version and is no longer supported.",
        ).catch(() => {});
        return;
      }
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
      if (!fn) {
        // #467 (A2-6): see the modal arm — same silent-drop closure.
        console.warn(
          "[router] no button handler for customId:",
          interactionLogContext(interaction),
        );
        await replyEphemeral(
          interaction,
          "This control is from an older version and is no longer supported.",
        ).catch(() => {});
        return;
      }
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

  // #745 (decision 9): context-menu commands (right-click → Apps on a
  // message / member) — before this branch existed, the chat-input early
  // return below silently dropped them. Same registry (lookup by
  // interaction.commandName), same gates and failure semantics as the chat
  // arm, but context-menu handlers are api "interaction" ONLY: the target
  // rides the raw interaction (options.getMessage()/getUser()) and
  // buildDiscordCommandContext/assertCommandContext stay chat-input-only.
  // Predicates are optional-called: discord.js defines them on every
  // Interaction (BaseInteraction), but leaner duck-typed interaction shapes
  // must not die on a missing method in a dispatch path.
  if (
    interaction.isMessageContextMenuCommand?.() ||
    interaction.isUserContextMenuCommand?.()
  ) {
    await runCommandArm(interaction, ctx, async (handler) => {
      await handler(interaction, ctx);
    });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // Chat-input arm: same runCommandArm gates; the only difference is the
  // api "context" migration rule below. Context-arm handlers receive the
  // platform-neutral CommandContext as their first argument (spec § Handler
  // migration rule). Everything around this call — the command-channel
  // gate, logging, safeErrorReply — keeps operating on the raw interaction.
  await runCommandArm(interaction, ctx, async (handler) => {
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
  });
}

module.exports = { handleInteraction };
