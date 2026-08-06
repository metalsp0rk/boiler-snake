/**
 * Ordered feature modules. Commands/handlers/events are collected at boot.
 */
module.exports = [
  require("./settings"),
  require("./commandChannels"),
  require("./xp"),
  require("./decay"),
  require("./voice"),
  require("./levelRoles"),
  require("./logs"),
  require("./youtube"),
  require("./honeypot"),
  require("./reactionRoles"),
  require("./eventReminders"),
  require("./staffRoles"),
  require("./staffNotes"),
  require("./warnings"),
];
