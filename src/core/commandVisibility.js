/**
 * Discord slash command visibility tiers.
 *
 * Handlers remain the security source of truth (requireStaff / isAdminOrMod).
 * This map drives:
 *   - defaultMemberPermissions at registration
 *   - guild command permission overwrites after OAuth sync
 *
 * Tiers:
 *   public — visible to all members; no role overwrites
 *   staff  — ManageGuild default + allow overwrites for staff_roles
 *   admin  — ManageGuild default only (no staff role overwrites)
 */

const TIERS = Object.freeze({
  public: "public",
  staff: "staff",
  admin: "admin",
});

/**
 * Top-level command name → visibility tier.
 * Keep in sync with registered slash commands (see test/commandVisibility.test.js).
 */
const COMMAND_VISIBILITY = Object.freeze({
  // Public (mixed staff subcommands gated in handlers)
  xp: TIERS.public,
  leaderboard: TIERS.public,
  warn: TIERS.public,
  ticket: TIERS.public,
  eventreminder: TIERS.public,

  // Manage Server only (picker + handler)
  grantxp: TIERS.admin,
  staff: TIERS.admin,
  setcommandchannel: TIERS.admin,

  // Staff gate (picker: ManageGuild default + staff_roles overwrites after sync)
  settings: TIERS.staff,
  setxp: TIERS.staff,
  setdecay: TIERS.staff,
  setlog: TIERS.staff,
  leveltorole: TIERS.staff,
  youtube: TIERS.staff,
  setyoutube: TIERS.staff,
  testnotification: TIERS.staff,
  reactionrole: TIERS.staff,
  honeypot: TIERS.staff,
  note: TIERS.staff,
  userinfo: TIERS.staff,
  setwarn: TIERS.staff,
  activityconfig: TIERS.staff,
});

/**
 * @param {string} commandName
 * @returns {"public"|"staff"|"admin"}
 */
function visibilityTier(commandName) {
  const t = COMMAND_VISIBILITY[commandName];
  if (!t) {
    throw new Error(
      `commandVisibility: unknown command "${commandName}" — add it to COMMAND_VISIBILITY`
    );
  }
  return t;
}

/**
 * @param {string} commandName
 * @returns {boolean}
 */
function isStaffSyncCommand(commandName) {
  return COMMAND_VISIBILITY[commandName] === TIERS.staff;
}

/**
 * Command names that receive staff_roles allow overwrites on sync.
 * @returns {string[]}
 */
function staffSyncCommandNames() {
  return Object.entries(COMMAND_VISIBILITY)
    .filter(([, tier]) => tier === TIERS.staff)
    .map(([name]) => name)
    .sort();
}

/**
 * All known command names in the visibility map.
 * @returns {string[]}
 */
function allVisibilityCommandNames() {
  return Object.keys(COMMAND_VISIBILITY).sort();
}

/**
 * Assert every registered command name has a visibility tier.
 * @param {string[]} registeredNames
 * @throws {Error} if any name is missing or unknown extra (warn via extras)
 */
function assertVisibilityCoversCommands(registeredNames) {
  const registered = new Set(registeredNames);
  const mapped = new Set(Object.keys(COMMAND_VISIBILITY));
  const missing = [...registered].filter((n) => !mapped.has(n));
  const extras = [...mapped].filter((n) => !registered.has(n));
  if (missing.length) {
    throw new Error(
      `commandVisibility missing tiers for: ${missing.join(", ")}`
    );
  }
  if (extras.length) {
    throw new Error(
      `commandVisibility has unknown commands (not registered): ${extras.join(", ")}`
    );
  }
}

module.exports = {
  TIERS,
  COMMAND_VISIBILITY,
  visibilityTier,
  isStaffSyncCommand,
  staffSyncCommandNames,
  allVisibilityCommandNames,
  assertVisibilityCoversCommands,
};
