/**
 * Community events feature (epic #218, roadmap/community-events.md).
 *
 * Slash: /event, /eventsignup, /eventconfig, /eventchannels (public tier;
 * per-subcommand gates in handlers.js — the /event split keeps every command
 * under Discord's 8000-char payload cap, all four route to handleEvent)
 * Buttons: ev:* (signups, confirm, edit, delete, calendar, wizard)
 * Modals:  evm:edit:<eventId>
 * Gateway: MessageCreate for DM wizard answers (E15)
 * Ticker:  one `events` job — postDue→reminders→series→autoArchive→digest→…
 */
const { Events } = require("discord.js");
const { startEventsTicker } = require("./ticker");
const {
  buildCommandEvent,
  buildEventSignupCommand,
  buildEventConfigCommand,
  buildEventChannelsCommand,
} = require("./ui");
const { handleEvent } = require("./handlers");
const { autocompleteEvent } = require("./autocomplete");
const { handleEventButton } = require("./buttons");
const { handleEventModal } = require("./modals");
const wizard = require("./wizard");

/**
 * Supervisor → Discord client (same shape as feature 2; a legacy raw client
 * is honored). Null ⇒ Discord unconfigured ⇒ no ticker, no gateway binds.
 */
function discordClient(supervisor) {
  if (supervisor && typeof supervisor.clientForCommunity === "function") {
    return supervisor.discord ?? null;
  }
  if (supervisor && (supervisor.guilds || supervisor.on)) return supervisor;
  return null;
}

/**
 * DM consumption for the wizard (E15): DMs have no guild, so the router's
 * guild gate never sees them — bind MessageCreate directly and hand DMs to
 * the wizard state machine. Everything is fail-soft: a broken wizard answer
 * logs and never bubbles into the gateway pipeline.
 */
function registerEvents(supervisor) {
  const client = discordClient(supervisor);
  if (!client || typeof client.on !== "function") return;
  client.on(Events.MessageCreate, (message) => {
    if (message.guild) return; // DMs only; server chatter belongs to pipelines
    const pending = wizard.handleDmMessage(client, message);
    Promise.resolve(pending).catch((err) => {
      console.error(
        `[events] DM wizard message=${message.id} failed:`,
        err?.message || err
      );
    });
  });

  // Wizard buttons live in DM messages. The command router drops guild-less
  // interactions (buttons/modals need a guild), so DM `ev:w:` clicks are
  // consumed here — everything else stays the router's.
  client.on(Events.InteractionCreate, (interaction) => {
    try {
      if (interaction.guild) return;
      if (!interaction.isButton?.()) return;
      if (!interaction.customId?.startsWith("ev:w:")) return;
      Promise.resolve(wizard.handleButton(interaction, { supervisor })).catch((err) => {
        console.error(
          `[events] DM wizard button=${interaction.customId} failed:`,
          err?.message || err
        );
      });
    } catch (err) {
      console.error("[events] DM interaction bind:", err?.message || err);
    }
  });
}

function start(supervisor) {
  const client = discordClient(supervisor);
  if (!client) {
    console.log("[events] Discord client not configured — events ticker not armed");
    return;
  }
  startEventsTicker(client);
}

module.exports = {
  name: "events",
  // /event is split in four: one command serialized to 21,136 chars and
  // Discord refused it (APPLICATION_COMMAND_TOO_LARGE, max 8000). The
  // DISPATCH keys in handlers.js are group-sub/sub, never the top-level
  // name, so all four commands share handleEvent + autocompleteEvent.
  // test/command-size.test.js guards every registry command < 8000 chars.
  commands: [
    buildCommandEvent(),
    buildEventSignupCommand(),
    buildEventConfigCommand(),
    buildEventChannelsCommand(),
  ],
  handlers: {
    event: handleEvent,
    eventsignup: handleEvent,
    eventconfig: handleEvent,
    eventchannels: handleEvent,
  },
  autocomplete: {
    event: autocompleteEvent,
    eventsignup: autocompleteEvent,
    eventconfig: autocompleteEvent,
    eventchannels: autocompleteEvent,
  },
  buttonHandlers: {
    "ev:": handleEventButton,
  },
  modalHandlers: {
    "evm:": handleEventModal,
  },
  registerEvents,
  start,
};
