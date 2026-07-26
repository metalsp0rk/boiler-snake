const { PermissionFlagsBits } = require("discord.js");

/** Stable default IDs for integration tests. Prefer unique guild IDs when isolation matters. */
const IDS = {
  guild: "guild-it-1",
  admin: "user-admin-1",
  member: "user-member-1",
  member2: "user-member-2",
  bot: "user-bot-1",
  channelGeneral: "channel-general-1",
  channelCmds: "channel-cmds-1",
  channelHoneypot: "channel-honey-1",
  channelLog: "channel-log-1",
  channelNotify: "channel-notify-1",
  channelVoice: "channel-voice-1",
  channelAfk: "channel-afk-1",
  roleLevel5: "role-level-5",
  roleExempt: "role-exempt-1",
  roleBan: "role-ban-1",
  roleRr: "role-rr-1",
};

const ADMIN_PERMS = PermissionFlagsBits.ManageGuild;

let _seq = 0;
/** @returns {string} unique-ish snowflake for isolating tests */
function uniqueId(prefix = "id") {
  _seq += 1;
  return `${prefix}-${Date.now()}-${_seq}`;
}

module.exports = {
  IDS,
  ADMIN_PERMS,
  uniqueId,
};
