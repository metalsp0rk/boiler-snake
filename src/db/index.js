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
const commandPermissionOauth = require("./repositories/commandPermissionOauth");
const twitch = require("./repositories/twitch");
const twitchEventsub = require("./repositories/twitchEventsub");
const githubWatches = require("./repositories/githubWatches");
const gorkAccess = require("./repositories/gorkAccess");
const gorkMemory = require("./repositories/gorkMemory");
const gorkBudget = require("./repositories/gorkBudget");
const gorkInteractions = require("./repositories/gorkInteractions");
const webSessions = require("./repositories/webSessions");
const adminAudit = require("./repositories/adminAudit");
const fluxerOAuthTransactions = require("./repositories/fluxerOAuthTransactions");
const bridges = require("./repositories/bridges");
const userLinks = require("./repositories/userLinks");

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
  getUser: users.getUser,
  searchUsers: users.searchUsers,
  USER_SEARCH_LIMIT: users.SEARCH_LIMIT,
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
  guildDailyMessageTotals: userChannelActivity.guildDailyMessageTotals,
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

  // Twitch
  normalizeTwitchLogin: twitch.normalizeTwitchLogin,
  getTwitchChannels: twitch.getTwitchChannels,
  getAllTwitchChannels: twitch.getAllTwitchChannels,
  getTwitchChannel: twitch.getTwitchChannel,
  getTwitchSubsByBroadcaster: twitch.getTwitchSubsByBroadcaster,
  addTwitchChannel: twitch.addTwitchChannel,
  removeTwitchChannel: twitch.removeTwitchChannel,
  updateTwitchChannelLiveState: twitch.updateTwitchChannelLiveState,
  claimTwitchStream: twitch.claimTwitchStream,
  claimTwitchOffline: twitch.claimTwitchOffline,
  setTwitchChannelMediaFlags: twitch.setTwitchChannelMediaFlags,
  updateTwitchChannelClipState: twitch.updateTwitchChannelClipState,
  updateTwitchChannelVideoState: twitch.updateTwitchChannelVideoState,
  // Twitch EventSub subscription state
  EVENTSUB_TYPES: twitchEventsub.EVENTSUB_TYPES,
  isValidEventsubType: twitchEventsub.isValidEventsubType,
  getTwitchEventsubSubs: twitchEventsub.getTwitchEventsubSubs,
  getTwitchEventsubSubsForBroadcaster:
    twitchEventsub.getTwitchEventsubSubsForBroadcaster,
  getTwitchEventsubSub: twitchEventsub.getTwitchEventsubSub,
  upsertTwitchEventsubSub: twitchEventsub.upsertTwitchEventsubSub,
  markTwitchEventsubSubStatus: twitchEventsub.markTwitchEventsubSubStatus,
  deleteTwitchEventsubSub: twitchEventsub.deleteTwitchEventsubSub,

  // GitHub releases
  normalizeGithubRepo: githubWatches.normalizeGithubRepo,
  getGithubWatches: githubWatches.getGithubWatches,
  getAllGithubWatches: githubWatches.getAllGithubWatches,
  getGithubWatch: githubWatches.getGithubWatch,
  addGithubWatch: githubWatches.addGithubWatch,
  removeGithubWatch: githubWatches.removeGithubWatch,
  updateGithubWatch: githubWatches.updateGithubWatch,
  updateGithubWatchReleaseState: githubWatches.updateGithubWatchReleaseState,

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

  // command permission OAuth (slash visibility sync)
  getCommandPermissionOauth: commandPermissionOauth.getCommandPermissionOauth,
  upsertCommandPermissionOauth:
    commandPermissionOauth.upsertCommandPermissionOauth,
  updateCommandPermissionAccessToken:
    commandPermissionOauth.updateCommandPermissionAccessToken,
  setCommandPermissionSyncResult:
    commandPermissionOauth.setCommandPermissionSyncResult,
  deleteCommandPermissionOauth:
    commandPermissionOauth.deleteCommandPermissionOauth,
  hasCommandPermissionOauth: commandPermissionOauth.hasCommandPermissionOauth,

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
  MAX_EVIDENCE_TEXT: warnings.MAX_EVIDENCE_TEXT,
  MAX_EXPIRY_DAYS: warnings.MAX_EXPIRY_DAYS,
  normalizeWarnReason: warnings.normalizeWarnReason,
  normalizeEvidenceText: warnings.normalizeEvidenceText,
  normalizeEvidenceMessageUrl: warnings.normalizeEvidenceMessageUrl,
  normalizeExpiryDays: warnings.normalizeExpiryDays,
  expiresAtFromDays: warnings.expiresAtFromDays,
  resolveExpiryDays: warnings.resolveExpiryDays,
  createWarning: warnings.createWarning,
  getWarningById: warnings.getWarningById,
  getWarning: warnings.getWarning,
  listWarnings: warnings.listWarnings,
  countWarnings: warnings.countWarnings,
  listGuildWarnings: warnings.listGuildWarnings,
  countGuildWarnings: warnings.countGuildWarnings,
  normalizeWarnState: warnings.normalizeWarnState,
  countActiveWarnings: warnings.countActiveWarnings,
  listExpiredActiveWarnings: warnings.listExpiredActiveWarnings,
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
  listArchivedTicketsForGuilds: tickets.listArchivedTicketsForGuilds,
  listArchivedTicketsForUser: tickets.listArchivedTicketsForUser,
  countArchivedTicketsForUser: tickets.countArchivedTicketsForUser,
  countArchivedTicketsForGuilds: tickets.countArchivedTicketsForGuilds,
  hasTicketMember: tickets.hasTicketMember,
  hasTicketStaff: tickets.hasTicketStaff,
  hasTicketMessageAuthor: tickets.hasTicketMessageAuthor,
  markTicketClosed: tickets.markTicketClosed,
  closeTicketSensitive: tickets.closeTicketSensitive,
  closeTicketArchived: tickets.closeTicketArchived,
  markTicketClosedByChannelDelete: tickets.markTicketClosedByChannelDelete,
  saveTicketMessages: tickets.saveTicketMessages,
  listTicketMessages: tickets.listTicketMessages,
  generateTranscriptToken: tickets.generateTranscriptToken,
  setTicketArchiveMessageId: tickets.setTicketArchiveMessageId,

  // gork access control (per-guild user blocks)
  addGorkBlock: gorkAccess.addGorkBlock,
  removeGorkBlock: gorkAccess.removeGorkBlock,
  isGorkBlocked: gorkAccess.isGorkBlocked,
  listGorkBlocks: gorkAccess.listGorkBlocks,

  // gork community memory (per-person memory rows, roadmap §7.16)
  gorkMemoryUpsert: gorkMemory.upsertMemory,
  gorkMemoryListForSubjects: gorkMemory.listForSubjects,
  gorkMemoryListForSubject: gorkMemory.listForSubject,
  gorkMemoryListForGuild: gorkMemory.listForGuild,
  gorkMemoryGetById: gorkMemory.getById,
  gorkMemoryDeleteById: gorkMemory.deleteById,
  gorkMemoryDeleteForSubject: gorkMemory.deleteForSubject,
  gorkMemoryDeleteForGuild: gorkMemory.deleteForGuild,
  gorkMemoryCountForGuild: gorkMemory.countForGuild,
  gorkMemoryTouch: gorkMemory.touchMemories,

  // gork daily usage budget (per-scope, roadmap §7.17)
  resolveGorkBudget: gorkBudget.resolveBudget,
  clampGorkDailyLimit: gorkBudget.clampDailyLimit,
  upsertGorkBudgetRule: gorkBudget.upsertGorkBudgetRule,
  deleteGorkBudgetRule: gorkBudget.deleteGorkBudgetRule,
  listGorkBudgetRules: gorkBudget.listGorkBudgetRules,
  getGorkUsage: gorkBudget.getGorkUsage,
  incrementGorkUsage: gorkBudget.incrementGorkUsage,

  // gork interaction logging (full request/response capture)
  insertGorkInteraction: gorkInteractions.insertGorkInteraction,
  listGorkInteractions: gorkInteractions.listGorkInteractions,
  getGorkInteractionByUid: gorkInteractions.getGorkInteractionByUid,
  countGorkInteractions: gorkInteractions.countGorkInteractions,
  pruneGorkInteractions: gorkInteractions.pruneGorkInteractions,
  deleteGorkInteractionsForGuild: gorkInteractions.deleteGorkInteractionsForGuild,

  // web admin sessions (roadmap/web-admin.md §8.3/§8.5)
  createWebSession: webSessions.createWebSession,
  getWebSession: webSessions.getWebSession,
  touchWebSession: webSessions.touchWebSession,
  destroyWebSession: webSessions.destroyWebSession,
  pruneWebSessions: webSessions.pruneWebSessions,
  setWebSessionAuth: webSessions.setWebSessionAuth,
  getWebSessionAuth: webSessions.getWebSessionAuth,
  MAX_SESSION_LIST_LIMIT: webSessions.MAX_SESSION_LIST_LIMIT,
  listWebSessionsByUser: webSessions.listWebSessionsByUser,
  listAllWebSessions: webSessions.listAllWebSessions,
  deleteWebSessionById: webSessions.deleteWebSessionById,

  // admin audit trail (roadmap/web-admin.md §8.5; consumed by phases 0b–3)
  AUDIT_ORIGINS: adminAudit.AUDIT_ORIGINS,
  MAX_AUDIT_LIST_LIMIT: adminAudit.MAX_AUDIT_LIST_LIMIT,
  MAX_AUDIT_DETAILS_JSON: adminAudit.MAX_AUDIT_DETAILS_JSON,
  normalizeAuditOrigin: adminAudit.normalizeAuditOrigin,
  serializeAuditDetails: adminAudit.serializeAuditDetails,
  insertAdminAudit: adminAudit.insertAdminAudit,
  getAdminAuditById: adminAudit.getAdminAuditById,
  listAdminAudit: adminAudit.listAdminAudit,
  countAdminAudit: adminAudit.countAdminAudit,

  // ticket panels (stored registry)
  createTicketPanel: tickets.createTicketPanel,
  getTicketPanel: tickets.getTicketPanel,
  listTicketPanels: tickets.listTicketPanels,
  updateTicketPanelText: tickets.updateTicketPanelText,
  deleteTicketPanel: tickets.deleteTicketPanel,

  // Fluxer web-login OAuth transactions (roadmap/fluxer.md § PKCE and state)
  createOAuthTransaction: fluxerOAuthTransactions.createOAuthTransaction,
  consumeOAuthTransaction: fluxerOAuthTransactions.consumeOAuthTransaction,

  // channel bridge (roadmap/bridge.md PR 2: schema + repo + credential helpers;
  // the service/relay/commands land in PRs 4-7)
  BRIDGE_STATES: bridges.BRIDGE_STATES,
  BRIDGE_DIRECTIONS: bridges.BRIDGE_DIRECTIONS,
  BRIDGE_RELAY_DIRECTIONS: bridges.BRIDGE_RELAY_DIRECTIONS,
  BRIDGE_OUTBOX_STATES: bridges.BRIDGE_OUTBOX_STATES,
  BRIDGE_CODE_LIFETIME_MS: bridges.BRIDGE_CODE_LIFETIME_MS,
  BRIDGE_CONNECT_MISS_LIMIT: bridges.BRIDGE_CONNECT_MISS_LIMIT,
  BRIDGE_CONNECT_WINDOW_MS: bridges.BRIDGE_CONNECT_WINDOW_MS,
  BRIDGE_OUTBOX_MAX_ATTEMPTS: bridges.BRIDGE_OUTBOX_MAX_ATTEMPTS,
  generateBridgeCode: bridges.generateConnectCode,
  generateBridgeHandle: bridges.generatePublicId,
  createBridge: bridges.createBridge,
  getBridgeById: bridges.getBridgeById,
  getBridgeByPublicId: bridges.getBridgeByPublicId,
  getBridgeByCodeHash: bridges.getBridgeByCodeHash,
  getBridgeForChannel: bridges.getBridgeForChannel,
  listBridgesForCommunity: bridges.listBridgesForCommunity,
  listBridgeEnds: bridges.listBridgeEnds,
  getBridgeEndForChannel: bridges.getBridgeEndForChannel,
  addBridgeEnd: bridges.addBridgeEnd,
  setBridgeEndWebhook: bridges.setBridgeEndWebhook,
  setBridgeEndFlags: bridges.setBridgeEndFlags,
  enqueueBridgeOutbox: bridges.enqueueBridgeOutbox,
  getBridgeOutboxById: bridges.getBridgeOutboxById,
  claimNextOutboxRow: bridges.claimNextOutboxRow,
  markOutboxDone: bridges.markOutboxDone,
  recordOutboxFailure: bridges.recordOutboxFailure,
  requeueStaleOutbox: bridges.requeueStaleOutbox,
  countOutboxDepth: bridges.countOutboxDepth,
  addBridgeMessageLink: bridges.addBridgeMessageLink,
  listBridgeMessageLinks: bridges.listBridgeMessageLinks,
  getBridgeLinkByDestination: bridges.getBridgeLinkByDestination,
  upsertBridgeSrcSnapshot: bridges.upsertBridgeSrcSnapshot,
  getBridgeSrcSnapshot: bridges.getBridgeSrcSnapshot,
  recordBridgeConnectMiss: bridges.recordBridgeConnectMiss,
  getBridgeConnectState: bridges.getBridgeConnectState,
  clearBridgeConnectAttempts: bridges.clearBridgeConnectAttempts,
  markBridgeBroken: bridges.markBridgeBroken,
  setBridgeLastError: bridges.setBridgeLastError,
  findExpiredPendingBridges: bridges.findExpiredPendingBridges,
  deleteBridgeCascade: bridges.deleteBridgeCascade,

  // account linking (roadmap/account-linking.md T1: user_links schema + repo;
  // the linking service/commands land in T2/T3)
  LINK_MIRROR_DIRECTIONS: userLinks.LINK_MIRROR_DIRECTIONS,
  USER_LINK_CODE_LIFETIME_MS: userLinks.LINK_CODE_LIFETIME_MS,
  createUserLink: userLinks.createLink,
  getUserLinkFor: userLinks.getLinkFor,
  getUserLinkById: userLinks.getLinkById,
  listUserLinksForCommunity: userLinks.listLinksForCommunity,
  removeUserLink: userLinks.removeLink,
  createLinkCode: userLinks.createLinkCode,
  getLinkCodeByHash: userLinks.getLinkCodeByHash,
  consumeLinkCode: userLinks.consumeLinkCode,
  purgeExpiredLinkCodes: userLinks.purgeExpiredLinkCodes,
  hasActiveBridgeBetween: userLinks.hasActiveBridgeBetween,
  setUserLinkMirrorPct: userLinks.setMirrorPct,
  setUserLinkMirrorMemory: userLinks.setMirrorMemory,
};
