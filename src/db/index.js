/**
 * Database facade — opens SQLite, runs migrations, re-exports repositories.
 *
 * Callers may continue to `require("../db")` or `require("./db")`; the root
 * `src/db.js` re-exports this module for a stable public path.
 */

const { db, now, dbPath } = require("./connection");
const { runMigrations } = require("./migrate");
const { MAX_SAFE_XP } = require("../core/xpMath");

// Apply schema + migrations once on load (same timing as legacy db.js).
runMigrations();

const users = require("./repositories/users");
const guildSettings = require("./repositories/guildSettings");
const activity = require("./repositories/activity");
const voiceSessions = require("./repositories/voiceSessions");
const levelRoles = require("./repositories/levelRoles");
const commandChannels = require("./repositories/commandChannels");
const youtube = require("./repositories/youtube");
const honeypot = require("./repositories/honeypot");
const reactionRoles = require("./repositories/reactionRoles");
const eventReminders = require("./repositories/eventReminders");
const staffRoles = require("./repositories/staffRoles");
const staffNotes = require("./repositories/staffNotes");
const warnings = require("./repositories/warnings");
const tickets = require("./repositories/tickets");
const userChannelActivity = require("./repositories/userChannelActivity");

module.exports = {
  db,
  now,
  dbPath,
  MAX_SAFE_XP,

  // guild settings
  getGuildSettings: guildSettings.getGuildSettings,
  updateGuildSettings: guildSettings.updateGuildSettings,

  // users / XP
  addXp: users.addXp,
  setXp: users.setXp,
  getXp: users.getXp,
  topUsers: users.topUsers,
  allUsersInGuild: users.allUsersInGuild,

  // activity (XP / decay)
  logActivity: activity.logActivity,
  countMessagesInWindow: activity.countMessagesInWindow,

  // user channel activity (staff analytics — not XP-gated)
  IGNORE_KINDS: userChannelActivity.IGNORE_KINDS,
  BACKFILL_STATUSES: userChannelActivity.BACKFILL_STATUSES,
  utcDayKey: userChannelActivity.utcDayKey,
  utcDayKeyDaysAgo: userChannelActivity.utcDayKeyDaysAgo,
  normalizeIgnoreKind: userChannelActivity.normalizeIgnoreKind,
  ensureGuildActivitySettings: userChannelActivity.ensureGuildActivitySettings,
  getGuildActivitySettings: userChannelActivity.getGuildActivitySettings,
  patchGuildActivitySettings: userChannelActivity.patchGuildActivitySettings,
  incrementDaily: userChannelActivity.incrementDaily,
  addActivityIgnore: userChannelActivity.addActivityIgnore,
  removeActivityIgnore: userChannelActivity.removeActivityIgnore,
  listActivityIgnore: userChannelActivity.listActivityIgnore,
  isActivityIgnored: userChannelActivity.isActivityIgnored,
  getActivityIgnoreSets: userChannelActivity.getActivityIgnoreSets,
  sumByChannel: userChannelActivity.sumByChannel,
  totalPosts: userChannelActivity.totalPosts,
  totalChannelPosts: userChannelActivity.totalPosts,
  earliestTrackedDay: userChannelActivity.earliestTrackedDay,
  guildActivityStats: userChannelActivity.guildActivityStats,
  getUserActivityMeta: userChannelActivity.getUserActivityMeta,
  upsertUserActivityMeta: userChannelActivity.upsertUserActivityMeta,
  getBackfillCursor: userChannelActivity.getBackfillCursor,
  upsertBackfillCursor: userChannelActivity.upsertBackfillCursor,
  guildHasActiveBackfill: userChannelActivity.guildHasActiveBackfill,
  getGuildChannelBackfillCursor: userChannelActivity.getGuildChannelBackfillCursor,
  upsertGuildChannelBackfillCursor:
    userChannelActivity.upsertGuildChannelBackfillCursor,
  guildChannelBackfillProgress: userChannelActivity.guildChannelBackfillProgress,

  // voice sessions
  upsertVoiceSession: voiceSessions.upsertVoiceSession,
  getVoiceSession: voiceSessions.getVoiceSession,
  deleteVoiceSession: voiceSessions.deleteVoiceSession,

  // level roles
  upsertLevelRole: levelRoles.upsertLevelRole,
  deleteLevelRole: levelRoles.deleteLevelRole,
  listLevelRoles: levelRoles.listLevelRoles,
  getRoleDropState: levelRoles.getRoleDropState,
  setRoleBelowSince: levelRoles.setRoleBelowSince,

  // command channel restriction
  addAllowedCommandChannel: commandChannels.addAllowedCommandChannel,
  removeAllowedCommandChannel: commandChannels.removeAllowedCommandChannel,
  listAllowedCommandChannels: commandChannels.listAllowedCommandChannels,

  // YouTube
  normalizeYoutubeName: youtube.normalizeYoutubeName,
  getYoutubeChannels: youtube.getYoutubeChannels,
  getAllYoutubeChannels: youtube.getAllYoutubeChannels,
  getYoutubeChannelById: youtube.getYoutubeChannelById,
  addYoutubeChannel: youtube.addYoutubeChannel,
  removeYoutubeChannel: youtube.removeYoutubeChannel,
  updateYoutubeChannelLastChecked: youtube.updateYoutubeChannelLastChecked,
  cleanupOldNotifications: youtube.cleanupOldNotifications,
  cleanupMalformedYoutubeChannels: youtube.cleanupMalformedYoutubeChannels,

  // staff roles (generalized from honeypot_exempt_roles; junior | senior)
  STAFF_LEVELS: staffRoles.STAFF_LEVELS,
  normalizeStaffLevel: staffRoles.normalizeStaffLevel,
  addStaffRole: staffRoles.addStaffRole,
  setStaffRoleLevel: staffRoles.setStaffRoleLevel,
  removeStaffRole: staffRoles.removeStaffRole,
  listStaffRoles: staffRoles.listStaffRoles,
  listSeniorStaffRoles: staffRoles.listSeniorStaffRoles,
  memberHasStaffRole: staffRoles.memberHasStaffRole,
  memberHasSeniorStaffRole: staffRoles.memberHasSeniorStaffRole,
  getStaffRole: staffRoles.getStaffRole,

  // honeypot (exempt-role aliases → same table as staff_roles)
  addHoneypotChannel: honeypot.addHoneypotChannel,
  getHoneypotChannel: honeypot.getHoneypotChannel,
  setHoneypotWarningMessage: honeypot.setHoneypotWarningMessage,
  removeHoneypotChannel: honeypot.removeHoneypotChannel,
  listHoneypotChannels: honeypot.listHoneypotChannels,
  isHoneypotChannel: honeypot.isHoneypotChannel,
  isHoneypotWarningMessage: honeypot.isHoneypotWarningMessage,
  listAllHoneypotWarnings: honeypot.listAllHoneypotWarnings,
  addHoneypotExemptRole: staffRoles.addStaffRole,
  removeHoneypotExemptRole: staffRoles.removeStaffRole,
  listHoneypotExemptRoles: staffRoles.listStaffRoles,
  memberHasHoneypotExemptRole: staffRoles.memberHasStaffRole,
  addHoneypotBanRole: honeypot.addHoneypotBanRole,
  removeHoneypotBanRole: honeypot.removeHoneypotBanRole,
  listHoneypotBanRoles: honeypot.listHoneypotBanRoles,
  isHoneypotBanRole: honeypot.isHoneypotBanRole,
  findHoneypotBanRolesAmong: honeypot.findHoneypotBanRolesAmong,

  // reaction roles
  createReactionRolePanel: reactionRoles.createReactionRolePanel,
  getReactionRolePanel: reactionRoles.getReactionRolePanel,
  listReactionRolePanels: reactionRoles.listReactionRolePanels,
  updateReactionRolePanelText: reactionRoles.updateReactionRolePanelText,
  deleteReactionRolePanel: reactionRoles.deleteReactionRolePanel,
  isReactionRolePanel: reactionRoles.isReactionRolePanel,
  upsertReactionRoleOption: reactionRoles.upsertReactionRoleOption,
  deleteReactionRoleOption: reactionRoles.deleteReactionRoleOption,
  listReactionRoleOptions: reactionRoles.listReactionRoleOptions,
  getReactionRoleOption: reactionRoles.getReactionRoleOption,
  countReactionRoleOptions: reactionRoles.countReactionRoleOptions,
  listReactionRoleLevelRequirements: reactionRoles.listReactionRoleLevelRequirements,

  // scheduled event reminders
  getEventReminderSettings: eventReminders.getEventReminderSettings,
  createEventReminderConfig: eventReminders.createEventReminderConfig,
  getEventReminderConfigById: eventReminders.getEventReminderConfigById,
  getConfigByScheduledEventId: eventReminders.getConfigByScheduledEventId,
  getAnyConfigByScheduledEventId: eventReminders.getAnyConfigByScheduledEventId,
  getConfigByShortname: eventReminders.getConfigByShortname,
  listEventReminderConfigs: eventReminders.listEventReminderConfigs,
  listAllActiveEventReminderConfigs: eventReminders.listAllActiveEventReminderConfigs,
  updateEventReminderConfig: eventReminders.updateEventReminderConfig,
  clearEventReminderConfig: eventReminders.clearEventReminderConfig,
  clearEventReminderConfigById: eventReminders.clearEventReminderConfigById,
  setOffsetFireTimes: eventReminders.setOffsetFireTimes,
  claimDueReminders: eventReminders.claimDueReminders,
  markReminderSent: eventReminders.markReminderSent,
  isEventReminderOptedOut: eventReminders.isEventReminderOptedOut,
  setEventReminderOptOut: eventReminders.setEventReminderOptOut,
  clearEventReminderOptOut: eventReminders.clearEventReminderOptOut,
  isEventReminderMuted: eventReminders.isEventReminderMuted,
  setEventReminderMute: eventReminders.setEventReminderMute,
  clearEventReminderMute: eventReminders.clearEventReminderMute,
  listEventReminderMutes: eventReminders.listEventReminderMutes,
  clearEventReminderMutesForEvent: eventReminders.clearEventReminderMutesForEvent,
  isUserBlockedFromEventReminders: eventReminders.isUserBlockedFromEventReminders,
  listActiveEventReminderRoleIds: eventReminders.listActiveEventReminderRoleIds,

  // staff notes
  MAX_NOTE_CONTENT: staffNotes.MAX_NOTE_CONTENT,
  normalizeNoteContent: staffNotes.normalizeNoteContent,
  createStaffNote: staffNotes.createStaffNote,
  getStaffNoteById: staffNotes.getStaffNoteById,
  getStaffNote: staffNotes.getStaffNote,
  listStaffNotes: staffNotes.listStaffNotes,
  listRecentStaffNotes: staffNotes.listRecentStaffNotes,
  countStaffNotes: staffNotes.countStaffNotes,
  updateStaffNote: staffNotes.updateStaffNote,
  softDeleteStaffNote: staffNotes.softDeleteStaffNote,

  // warnings
  MAX_WARN_REASON: warnings.MAX_WARN_REASON,
  normalizeWarnReason: warnings.normalizeWarnReason,
  createWarning: warnings.createWarning,
  getWarningById: warnings.getWarningById,
  getWarning: warnings.getWarning,
  listWarnings: warnings.listWarnings,
  countWarnings: warnings.countWarnings,
  countActiveWarnings: warnings.countActiveWarnings,
  voidWarning: warnings.voidWarning,

  // tickets
  MAX_TICKET_REASON: tickets.MAX_TICKET_REASON,
  normalizeTicketReason: tickets.normalizeTicketReason,
  getTicketSettings: tickets.getTicketSettings,
  canUserCreateTicket: tickets.canUserCreateTicket,
  createTicket: tickets.createTicket,
  getTicketById: tickets.getTicketById,
  getTicketByChannel: tickets.getTicketByChannel,
  getTicketByNumber: tickets.getTicketByNumber,
  getTicketByTranscriptToken: tickets.getTicketByTranscriptToken,
  claimTicket: tickets.claimTicket,
  transferTicket: tickets.transferTicket,
  addTicketStaff: tickets.addTicketStaff,
  removeTicketStaff: tickets.removeTicketStaff,
  setTicketSensitive: tickets.setTicketSensitive,
  setTicketUnsensitive: tickets.setTicketUnsensitive,
  addTicketMember: tickets.addTicketMember,
  removeTicketMember: tickets.removeTicketMember,
  listTicketMembers: tickets.listTicketMembers,
  listTicketStaff: tickets.listTicketStaff,
  listOpenTickets: tickets.listOpenTickets,
  listArchivedTickets: tickets.listArchivedTickets,
  countArchivedTickets: tickets.countArchivedTickets,
  markTicketClosed: tickets.markTicketClosed,
  closeTicketSensitive: tickets.closeTicketSensitive,
  closeTicketArchived: tickets.closeTicketArchived,
  markTicketClosedByChannelDelete: tickets.markTicketClosedByChannelDelete,
  saveTicketMessages: tickets.saveTicketMessages,
  listTicketMessages: tickets.listTicketMessages,
  generateTranscriptToken: tickets.generateTranscriptToken,
  setTicketArchiveMessageId: tickets.setTicketArchiveMessageId,
};
