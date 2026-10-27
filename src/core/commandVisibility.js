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
 * Keys are exact command names — context-menu commands (#745) key by their
 * display names verbatim, caps and spaces included.
 * Keep in sync with registered commands (see test/command-visibility.test.js).
 */
const COMMAND_VISIBILITY = Object.freeze({
  // Public (mixed staff subcommands gated in handlers)
  xp: TIERS.public,
  leaderboard: TIERS.public,
  warn: TIERS.public,
  ticket: TIERS.public,
  eventreminder: TIERS.public,
  // /event split (8000-char payload cap): signup/config/channels siblings,
  // same public tier — per-subcommand staff gates stay in handlers.js.
  event: TIERS.public,
  eventsignup: TIERS.public,
  eventconfig: TIERS.public,
  eventchannels: TIERS.public,
  play: TIERS.public,
  music: TIERS.public,
  link: TIERS.public,

  // Manage Server only (picker + handler)
  grantxp: TIERS.admin,
  // #476 (F2-8): /staff's PICKER is admin-tier because most subcommands
  // (role add/remove/setlevel, syncpermissions) are ManageGuild-gated; the
  // list/settings subcommands UNDER /staff are therefore admin-visible only
  // — user-facing copy must not promise staff members a command Discord
  // hides from them (test/staff-visibility-copy.test.js pins that
  // alignment; handlers stay the security truth).
  // #599 split the READ path out: `/staffsettings` (roles | overview) is a
  // STAFF-tier twin of `/staff role list` + `/staff settings`, so the honest
  // pointer for staff readers is that command — not anything under /staff.
  // /staff itself stays admin (mutations remain ManageGuild-only); the live
  // picker check of /staffsettings' overwrites is owed separately.
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
  twitch: TIERS.staff,
  settwitch: TIERS.staff,
  // #305: RSS feed notifications — same posture as the youtube/twitch twins
  // (ManageGuild picker default + staff_roles allow overwrites after sync;
  // requireStaffFromContext stays the security source of truth).
  rss: TIERS.staff,
  setrss: TIERS.staff,
  github: TIERS.staff,
  reactionrole: TIERS.staff,
  honeypot: TIERS.staff,
  note: TIERS.staff,
  userinfo: TIERS.staff,
  setwarn: TIERS.staff,
  activityconfig: TIERS.staff,
  gork: TIERS.staff,
  bridge: TIERS.staff,
  // #599: read-only twin of `/staff role list` + `/staff settings` (roles |
  // overview) so junior/senior staff can check their own staff-role status
  // and the staff settings without Manage Server. Handler gate is the staff
  // gate (requireStaff) — the picker tier here is what makes the command
  // reachable: ManageGuild default + staff_roles allow overwrites after
  // `/staff syncpermissions`.
  staffsettings: TIERS.staff,
  // #745: context-menu report commands (right-click → Apps). Keys are the
  // EXACT context-menu display names — unlike slash names they carry caps +
  // spaces, and they are the registry/dispatch keys verbatim (must match the
  // builders in src/features/tickets/commands.js character-for-character).
  // Same staff picker posture as the slash staff surface; handlers stay the
  // security source of truth.
  "Report Post": TIERS.staff,
  "Report User": TIERS.staff,
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
  visibilityTier,
  isStaffSyncCommand,
  staffSyncCommandNames,
  assertVisibilityCoversCommands,
};
