/**
 * /banappeals slash builder + handler (#773 §1).
 *
 * Picker posture (test/command-visibility.test.js pins it): the builder
 * carries the ManageGuild default_member_permissions and the command sits on
 * the TIERS.admin visibility tier — byte-identical to /ban + /bannotify
 * (automodconfig posture: admin = ManageGuild picker, NOT in the staffRoles
 * allow-sync). The handler stays the security source of truth: every arm
 * runs requireAdminFromContext FIRST, then the NOT_ON_FLUXER gate (#773
 * explicit Fluxer no-parity — the appeal surface is Discord-only by
 * decision).
 *
 * Arms (all ephemeral, `**Label:** value` copy per #471 H2-13):
 *  - `enable` / `disable` — the audited `ban_appeals` toggle via the
 *    settings seam (one recordSlashAudit row `banAppeals.toggle_set` + the
 *    logConfigChange embed; the toggle writes nothing else).
 *  - `status` — the current setting + the defaults note.
 *
 * Error law: settings-service failures reply with their SPECIFIC cause
 * (never a generic, never "check logs"); the router's wrap stays the last
 * resort. Boot wiring (src/features/index.js) lands with the feature
 * subtask — this module exports the exact shape applyFeaturesToRegistry
 * consumes.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { requireAdminFromContext } = require("../../core/permissions");
const {
  BANAPPEALS_COMMAND,
  NOT_ON_FLUXER,
} = require("./constants");
const settings = require("./settings");

/** Admin picker posture: ManageGuild on the builder (visibility map: admin). */
const adminPerms = PermissionFlagsBits.ManageGuild;

/* ── builder ──────────────────────────────────────────────────────────────── */

// Subcommands carry no options at all — the required-before-optional law
// (#291, test/command-option-order.test.js) is trivially clean, and the
// payload sits far under the 8000-char APPLICATION_COMMAND_TOO_LARGE cap.
const banappealsCommand = new SlashCommandBuilder()
  .setName(BANAPPEALS_COMMAND)
  .setDescription(
    "Ban appeals: the appeal-button intake toggle for tracked bans (admin).",
  )
  .setDefaultMemberPermissions(adminPerms)
  .addSubcommand((sc) =>
    sc
      .setName("enable")
      .setDescription(
        "Appeals on: tracked ban DMs carry an Appeal button (default).",
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("disable")
      .setDescription(
        "Appeals off: button presses get a refusal, no tickets open.",
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("status")
      .setDescription("Show the current ban-appeals setting."),
  );

/* ── arms ─────────────────────────────────────────────────────────────────── */

/** One-line consequence per state (what the admin just did, /bannotify tone). */
function toggleConsequence(enabled) {
  return enabled
    ? " Every tracked ban DM carries the Appeal button; presses open a staff appeal ticket."
    : " Ban DMs stop carrying the Appeal button; appeal tickets already in flight keep ferrying.";
}

/**
 * `enable` / `disable` — one arm body for both states (the audited mutation
 * + echo lives in the settings seam; automodconfig enable posture).
 */
async function setAppealsToggle(commandCtx, enabled) {
  const result = await settings.toggleAppeals({
    communityId: commandCtx.communityId,
    guildId: commandCtx.externalGuildId,
    enabled,
    actorUserId: commandCtx.userId,
    outbound: commandCtx.outbound ?? null,
    actor: commandCtx.user,
  });
  if (!result.ok) {
    await commandCtx.reply({ content: result.error, sensitive: true });
    return;
  }
  await commandCtx.reply({
    content:
      `**Ban appeals:** now **${enabled ? "on" : "off"}**.` +
      toggleConsequence(enabled),
    sensitive: true,
  });
}

/** `status` — the setting + the defaults note, `**Label:** value` style. */
async function handleAppealsStatus(commandCtx) {
  const read = settings.readSettings(commandCtx.communityId);
  if (!read.ok) {
    await commandCtx.reply({ content: read.error, sensitive: true });
    return;
  }
  const { appealsEnabled } = read.settings;
  await commandCtx.reply({
    content: [
      `**Ban appeals:** ${appealsEnabled ? "on" : "off"} — tracked bans ${appealsEnabled ? "carry" : "do not carry"} an Appeal button in the ban DM.`,
      "**One per ban:** every tracked ban cycle gets exactly one appeal; decided appeals do not re-open.",
      "**Defaults:** appeals ship **on** (non-destructive) — `/banappeals disable` turns the intake off; tickets already in flight keep ferrying until staff decide them.",
    ].join("\n"),
    sensitive: true,
  });
}

/**
 * `/banappeals <enable|disable|status>` — admin gate → NOT_ON_FLUXER →
 * dispatch (the /bannotify fall-through copy for unknown arms).
 *
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleBanAppeals(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireAdminFromContext(commandCtx))) return;

  // Discord-only surface (#773 explicit no-parity): the Fluxer dispatcher
  // never carries a rawInteraction and never reaches the appeal mechanics.
  if (!commandCtx.rawInteraction) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return;
  }

  const sub = commandCtx.subcommand;
  if (sub === "enable") return setAppealsToggle(commandCtx, true);
  if (sub === "disable") return setAppealsToggle(commandCtx, false);
  if (sub === "status") return handleAppealsStatus(commandCtx);

  await commandCtx.reply({
    content: `Unknown subcommand: \`${sub}\``,
    sensitive: true,
  });
}

/* ── feature-module exports (load.js contract; wiring: the feature subtask) ── */

module.exports = {
  // Slash builder only — no context menu, no modal/button handler keys yet:
  // the guildless DM lane never touches the router (feature-owned
  // InteractionCreate listener) and the in-ticket `ap:*` arms arrive with
  // the outcome buttons; registering their prefixes here without handlers
  // would break load.js claim() honesty.
  commands: [banappealsCommand],
  handlers: {
    [BANAPPEALS_COMMAND]: handleBanAppeals,
  },
  // The slash arms ride the CommandContext convention (bannotify twin).
  handlerApi: {
    [BANAPPEALS_COMMAND]: "context",
  },
  // Copy seams for tests:
  toggleConsequence,
  NOT_ON_FLUXER,
};
