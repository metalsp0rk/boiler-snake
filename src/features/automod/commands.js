/**
 * /automod + /automodconfig slash builders (#725 + #726, epic #723).
 *
 * Picker posture (test/command-visibility.test.js pins it): both commands
 * carry the ManageGuild defaultMemberPermissions; the TIERS differ in
 * src/core/commandVisibility.js — `automod` is staff (staff_roles get allow
 * overwrites after `/staff syncpermissions`), `automodconfig` is admin
 * (ManageGuild only, no staff-role overwrites). Handlers stay the security
 * source of truth: /automod gate = requireStaff, /automodconfig =
 * isAdminOrMod (ManageGuild), per the epic.
 *
 * #726 adds `/automod refer` beside `status`; #771 retires its free-text
 * `note:` option (the referral MODAL captures problem + context + window
 * instead — design-record §13.1) and adds the `/set-moderation-queue` admin
 * alias over the same automod-channel setting.
 * The "Refer to automod" context-menu builder lives in ./contextMenu.js and
 * is wired through the feature's commands export.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const {
  AUTOMOD_RULES_MAX_LEN,
  AUTOMOD_TIMEOUT_CAP_MIN,
  AUTOMOD_TIMEOUT_CAP_MAX,
  AUTOMOD_BUDGET_MIN,
  AUTOMOD_BUDGET_MAX,
  MODE_CHOICES,
  ACTION_CHOICES,
} = require("./constants");

const staffPerms = PermissionFlagsBits.ManageGuild;

const commands = [
  new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Auto-moderation: refer a case, check status (staff).")
    .setDefaultMemberPermissions(staffPerms)
    // #726: the ONLY way a case starts (besides the "Refer to automod"
    // message context menu). Discord cannot cross-enforce "at least one of
    // message|user" — the handler replies with the specific cause.
    // #771: with a target given this opens the REFERRAL MODAL (problem +
    // required context + read window) — the old free-text `note:` option is
    // retired (design-record §13.1): the case intake shape is the modal.
    .addSubcommand((sc) =>
      sc
        .setName("refer")
        .setDescription(
          "Refer a message and/or a member to auto-moderation (opens the referral form).",
        )
        .addStringOption((opt) =>
          opt
            .setName("message")
            .setDescription(
              "Full message link in THIS server (right-click → Copy Link)",
            )
            .setRequired(false),
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("Member the referral is about")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("status")
        .setDescription(
          "Show auto-mod config: switch, channel, rules, modes, timeout cap, budget, breaker.",
        ),
    ),

  new SlashCommandBuilder()
    .setName("automodconfig")
    .setDescription("Configure auto-moderation: channel, rules, modes, budget, safety (admin).")
    .setDefaultMemberPermissions(staffPerms)
    // channel set|clear
    .addSubcommandGroup((group) =>
      group
        .setName("channel")
        .setDescription("Set or clear the automod case-card channel (admin).")
        .addSubcommand((sc) =>
          sc
            .setName("set")
            .setDescription("Post auto-mod case cards to this channel.")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Text channel for case cards (restrict it to staff!)")
                .addChannelTypes(
                  ChannelType.GuildText,
                  ChannelType.GuildAnnouncement,
                )
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("clear")
            .setDescription(
              "Unset the case-card channel (cases then refuse until it is set).",
            ),
        ),
    )
    // rules set|clear
    .addSubcommandGroup((group) =>
      group
        .setName("rules")
        .setDescription("Set or clear the guild rules text the judge applies (admin).")
        .addSubcommand((sc) =>
          sc
            .setName("set")
            .setDescription(
              `Set the rules text (max ${AUTOMOD_RULES_MAX_LEN}; omit to open a modal).`,
            )
            .addStringOption((opt) =>
              opt
                .setName("text")
                .setDescription(
                  `Rules text (omit to open a modal for longer text)`,
                )
                .setRequired(false)
                .setMaxLength(AUTOMOD_RULES_MAX_LEN),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("clear")
            .setDescription("Clear the rules text (cases refuse until it is set)."),
        ),
    )
    // enable on|off
    .addSubcommand((sc) =>
      sc
        .setName("enable")
        .setDescription("Master switch (default off; referrals name this cause while off).")
        .addStringOption((opt) =>
          opt
            .setName("state")
            .setDescription("Turn auto-moderation on or off")
            .setRequired(true)
            .addChoices(
              { name: "on", value: "on" },
              { name: "off", value: "off" },
            ),
        ),
    )
    // mode <action> <off|suggest|auto>
    .addSubcommand((sc) =>
      sc
        .setName("mode")
        .setDescription(
          "Per-action mode: off / suggest / auto (default suggest; staff notes are always on).",
        )
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("Which action's mode to change")
            .setRequired(true)
            .addChoices(...ACTION_CHOICES),
        )
        .addStringOption((opt) =>
          opt
            .setName("mode")
            .setDescription("off = unavailable, suggest = staff approves, auto = runs alone")
            .setRequired(true)
            .addChoices(...MODE_CHOICES),
        ),
    )
    // timeout-cap <seconds>
    .addSubcommand((sc) =>
      sc
        .setName("timeout-cap")
        .setDescription(`Max automod timeout in seconds (${AUTOMOD_TIMEOUT_CAP_MIN}–${AUTOMOD_TIMEOUT_CAP_MAX}, 28 days).`)
        .addIntegerOption((opt) =>
          opt
            .setName("seconds")
            .setDescription(
              `Seconds ${AUTOMOD_TIMEOUT_CAP_MIN}–${AUTOMOD_TIMEOUT_CAP_MAX} (default 3600 = 1 hour)`,
            )
            .setRequired(true)
            .setMinValue(AUTOMOD_TIMEOUT_CAP_MIN)
            .setMaxValue(AUTOMOD_TIMEOUT_CAP_MAX),
        ),
    )
    // budget <limit>
    .addSubcommand((sc) =>
      sc
        .setName("budget")
        .setDescription("Daily case budget per server: -1 blocked, 0 unlimited, N capped.")
        .addIntegerOption((opt) =>
          opt
            .setName("limit")
            .setDescription(
              `Cases per UTC day: ${AUTOMOD_BUDGET_MIN} blocked, 0 unlimited, 1-${AUTOMOD_BUDGET_MAX} (default 50)`,
            )
            .setRequired(true)
            .setMinValue(AUTOMOD_BUDGET_MIN)
            .setMaxValue(AUTOMOD_BUDGET_MAX),
        ),
    )
    // safety resume (confirm:) — H2-15: re-arming auto kick/ban/timeout previews first
    .addSubcommandGroup((group) =>
      group
        .setName("safety")
        .setDescription("Circuit-breaker controls (admin).")
        .addSubcommand((sc) =>
          sc
            .setName("resume")
            .setDescription(
              "Re-arm auto kick/ban/timeout after the breaker paused them (two-step confirm).",
            )
            .addBooleanOption((opt) =>
              opt
                .setName("confirm")
                .setDescription(
                  "Set true to actually re-arm (without it this only previews)",
                ),
            ),
        ),
    ),

  // #771 §6: a THIN admin alias over the already-shipped automod-channel
  // setting (`/automodconfig channel`, #725) — one queue, one source of
  // truth. It writes the SAME column, keeps the @everyone-visibility
  // warning, and lands its own audit rows.
  new SlashCommandBuilder()
    .setName("set-moderation-queue")
    .setDescription("Point the auto-mod queue at a channel (alias of /automodconfig channel; admin).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("set")
        .setDescription("Post auto-mod case cards (the queue) to this channel.")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Text channel for the queue (restrict it to staff!)")
            .addChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            )
            .setRequired(true),
        ),
    )
    .addSubcommand((sc) =>
      sc
        .setName("clear")
        .setDescription(
          "Unset the queue channel (referrals then refuse until it is set).",
        ),
    ),
];

module.exports = { commands };
