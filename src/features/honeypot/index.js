const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
  Events,
} = require("discord.js");
const {
  isHoneypotChannel,
  isHoneypotWarningMessage,
  listAllHoneypotWarnings,
  memberHasStaffRole,
  findHoneypotBanRolesAmong,
  getHoneypotChannel,
  setHoneypotWarningMessage,
  addHoneypotChannel,
  removeHoneypotChannel,
  listHoneypotChannels,
  insertStaffRoleIfMissing,
  removeStaffRole,
  listStaffRoles,
  addHoneypotBanRole,
  removeHoneypotBanRole,
  listHoneypotBanRoles,
  isHoneypotBanRole,
  getGuildSettings,
  updateGuildSettings,
} = require("../../db");
const { key } = require("../../core/cooldowns");
const {
  isAdminOrModFromContext,
  requireStaffFromContext,
} = require("../../core/permissions");
const { logConfigChange, logHoneypotTrigger } = require("../logs/auditLog");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { ensureCommunity, getCommunityById } = require("../../platform/community");

/**
 * Fluxer PR 2 Discord edge: external snowflake → internal INTEGER community id
 * (create-on-sight). The honeypot repos are community-keyed.
 * @param {string} externalGuildId Discord guild id
 * @returns {number} communities.id
 */
function communityIdFor(externalGuildId) {
  return ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: String(externalGuildId),
  });
}
const { registerJob } = require("../../core/scheduler");
const {
  recordSlashAudit,
  recordSystemAudit,
} = require("../../core/auditTrail");
const { renderHoneypotWarningPng } = require("./renderWarning");

const staffPerms = PermissionFlagsBits.ManageGuild;

// In-flight honeypot bans to avoid double-processing rapid messages
const honeypotBanning = new Set(); // key: guildId:userId

// ── Mass-ban safety valve (#440, audit F2-4) ────────────────────────────────
// The ban is honeypot's ONLY irreversible action, yet nothing bounded its
// fan-out: arming a busy channel instantly bans every later poster (any
// staff-tier member can arm it), and undo is a manual per-user unban AFTER
// the DM already said "you have been banned". Count ban ATTEMPTS per
// community in a rolling window; over the cap trip a PERSISTED pause —
// a restart never silently re-arms enforcement — until an admin confirms
// the situation with /honeypot safety resume. Suppression stays ON while
// paused (channels keep draining, evidence keeps accumulating); only the
// irreversible step waits.
const BAN_WINDOW_MS = 5 * 60 * 1000;
const BAN_WINDOW_MAX = 10;

/** communityId → number[] attempt timestamps inside the rolling window. */
const banAttempts = new Map();

function noteBanAttempt(communityId, nowMs = Date.now()) {
  const kept = (banAttempts.get(communityId) || []).filter(
    (t) => nowMs - t < BAN_WINDOW_MS,
  );
  kept.push(nowMs);
  banAttempts.set(communityId, kept);
  return kept.length;
}

function clearBanWindow(communityId) {
  banAttempts.delete(communityId);
}

function isEnforcementPaused(communityId) {
  try {
    return Number(getGuildSettings(communityId).honeypot_paused_at) > 0;
  } catch (err) {
    // Fail-safe: a settings read error must not clear the brake on the
    // irreversible path — stay suppressed until state is readable again.
    console.error(
      `[honeypot] could not read the pause state for community ${communityId}: ${err?.message || err} — treating enforcement as PAUSED`,
    );
    return true;
  }
}

/**
 * Persist the pause, audit it, scream into the logs, and alert the staff
 * audit channel (Discord arm only — the Fluxer community has no Discord
 * staff channel; the system-audit row + logs are its record).
 */
async function tripBanBreaker(communityId, { cause, client = null, guild = null }) {
  const pausedAt = Date.now();
  clearBanWindow(communityId); // the pause is the control now; window resets
  try {
    updateGuildSettings(communityId, {
      honeypot_paused_at: pausedAt,
      honeypot_pause_reason: cause,
    });
  } catch (err) {
    console.error(
      `[honeypot] COULD NOT PERSIST the mass-ban pause for community ${communityId}: ${err?.message || err} — a restart WILL re-arm enforcement!`,
    );
  }
  try {
    recordSystemAudit({
      communityId,
      action: "honeypot.breaker_trip",
      targetType: "guild",
      targetId: String(guild?.id ?? communityId),
      details: {
        cause,
        window_ms: BAN_WINDOW_MS,
        max_bans: BAN_WINDOW_MAX,
        paused_at: pausedAt,
      },
    });
  } catch (err) {
    console.error(
      `[honeypot] breaker_trip audit write failed for community ${communityId}: ${err?.message || err}`,
    );
  }
  console.error(
    `[honeypot] MASS-BAN SAFETY VALVE tripped in community ${communityId}: ${cause} — enforcement PAUSED until an admin runs /honeypot safety resume`,
  );
  if (client && guild?.id) {
    await logConfigChange(getDiscordOutbound(client), guild.id, {
      title: "Honeypot enforcement PAUSED (mass-ban safety valve)",
      command: "/honeypot safety resume",
      actor: { tag: "Honeypot safety valve", id: null },
      changes: [
        cause,
        "No further bans will be issued — messages in honeypot channels are still deleted/suppressed.",
        "An admin must review the bans/arm and run `/honeypot safety resume` to re-arm enforcement.",
      ],
    }).catch((err) =>
      console.warn(
        `[honeypot] breaker alert to the staff channel failed for community ${communityId}: ${err?.message || err}`,
      ),
    );
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("honeypot")
    .setDescription("Configure honeypot channels and ban roles (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommandGroup((group) =>
      group
        .setName("channel")
        .setDescription("Manage honeypot channels.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription(
              "Mark a channel as a honeypot (anyone who posts is banned).",
            )
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Channel to mark as a honeypot")
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List configured honeypot channels."),
        )
        .addSubcommand((sc) =>
          sc
            .setName("del")
            .setDescription("Remove a channel from the honeypot list.")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("Channel to remove from honeypot list")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("banrole")
        .setDescription("Manage roles that ban a user when assigned.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription(
              "Mark a role as a honeypot ban role (assigning it bans the member).",
            )
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription(
                  "Role that triggers an automatic ban when granted",
                )
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc.setName("list").setDescription("List honeypot ban roles."),
        )
        .addSubcommand((sc) =>
          sc
            .setName("del")
            .setDescription("Remove a role from the honeypot ban-role list.")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to remove from the ban-role list")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("exempt")
        .setDescription("Manage roles exempt from honeypot bans.")
        .addSubcommand((sc) =>
          sc
            .setName("add")
            .setDescription(
              "Exempt a role from honeypot bans (new staff roles join as junior; existing levels kept).",
            )
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to exempt (e.g. staff)")
                .setRequired(true),
            ),
        )
        .addSubcommand((sc) =>
          sc
            .setName("list")
            .setDescription("List roles exempt from honeypot bans."),
        )
        .addSubcommand((sc) =>
          sc
            .setName("del")
            .setDescription("Remove a role from the honeypot exempt list.")
            .addRoleOption((opt) =>
              opt
                .setName("role")
                .setDescription("Role to remove from exempt list")
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("safety")
        .setDescription("Mass-ban safety valve controls (admin).")
        .addSubcommand((sc) =>
          sc
            .setName("resume")
            .setDescription(
              "Resume honeypot bans after the mass-ban safety valve paused enforcement (#440).",
            ),
        ),
    ),
];

/**
 * Post a human-facing honeypot warning (embed + modal-style image).
 * No plain-text content — simplistic bots that only scrape `content` see nothing useful.
 * Pins the message when possible and returns the sent Message.
 */
async function postHoneypotWarning(channel) {
  const png = renderHoneypotWarningPng();
  const file = new AttachmentBuilder(png, { name: "honeypot-warning.png" });

  // Image only — no content/embed text for scrapers to parse.
  // All human-facing copy is baked into the PNG.
  const msg = await channel.send({
    files: [file],
  });

  try {
    await msg.pin().catch(() => null);
  } catch {
    // Pin is best-effort (needs Manage Messages)
  }

  return msg;
}

/**
 * Ensure a honeypot channel has a bot warning message. Reuses existing one if still present.
 * Returns a short status string for the admin reply.
 *
 * `guild` is the discord.js Guild used for channel access; `communityId` is
 * the INTEGER repository key (roadmap § Repository boundary). Legacy callers
 * that only pass the guild get the id resolved at the edge — a snowflake
 * string must never reach the community-keyed repos (assertCommunityId
 * throws on it, which silently broke `/honeypot channel add` before this fix).
 * When `guild` is null (Fluxer command contexts never carry one), the warning
 * PNG is posted via `outbound` (the OutboundClient on the command context).
 */
async function ensureHoneypotWarning(guild, channelId, communityId, outbound) {
  const communityKey =
    communityId ??
    (guild?.id != null ? communityIdFor(String(guild.id)) : undefined);

  if (!guild) {
    // Fluxer arm of the PR 7 service cutover: Fluxer contexts never carry a
    // discord.js Guild (Contract 6), so the warning image goes through the
    // OutboundClient. Pinning is not part of the outbound surface; the
    // warning-notice reaction strip has a Fluxer twin
    // (handleHoneypotFluxerWarningReaction), so the flow stays complete.
    if (communityKey == null) {
      return "Warning notice skipped (no community id for this invocation).";
    }
    if (!outbound) {
      return "Warning notice skipped (no OutboundClient on this command context).";
    }
    try {
      const png = renderHoneypotWarningPng();
      const file = new AttachmentBuilder(png, {
        name: "honeypot-warning.png",
      });
      const res = await outbound.sendChannel(channelId, { files: [file] });
      if (!res?.ok) {
        return `Could not post warning notice: ${res?.error || "unknown sendChannel failure"}`;
      }
      if (res.id) {
        setHoneypotWarningMessage(communityKey, channelId, res.id);
      } else {
        // The notice is live but the reaction strip (handleHoneypotFluxerWarningReaction)
        // matches on the stored message id — name the silent gap in the log.
        console.warn(
          `[honeypot] Warning notice posted to channel ${channelId} (community ${communityKey}) with no message id in the API response — reaction strip will not recognize it.`,
        );
      }
      return "Warning notice posted (pinning is Discord-only).";
    } catch (e) {
      console.error(
        `[honeypot] Failed to post warning in ${communityKey}/${channelId}:`,
        e?.message || e,
      );
      return `Could not post warning notice: ${e?.message || e}`;
    }
  }

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (
    !channel ||
    typeof channel.isTextBased !== "function" ||
    !channel.isTextBased()
  ) {
    return "Channel cannot receive messages — warning not posted.";
  }
  if (typeof channel.send !== "function") {
    return "Channel cannot receive messages — warning not posted.";
  }

  const existing = getHoneypotChannel(communityKey, channelId);
  if (existing?.warning_message_id) {
    const old = await channel.messages
      .fetch(existing.warning_message_id)
      .catch(() => null);
    if (old) {
      return "Warning notice already present (left in place).";
    }
  }

  try {
    const msg = await postHoneypotWarning(channel);
    setHoneypotWarningMessage(communityKey, channelId, msg.id);
    return "Warning notice posted and pinned (image only — no plain text).";
  } catch (e) {
    console.error(
      `[honeypot] Failed to post warning in ${guild.id}/${channelId}:`,
      e?.message || e,
    );
    return `Could not post warning notice: ${e?.message || e}`;
  }
}

/**
 * Shared honeypot ban: DM (optional copy) then guild ban.
 * Uses honeypotBanning to avoid double-processing.
 * Posts a staff audit-log embed via logHoneypotTrigger (richer than the generic ban log).
 * @returns {Promise<boolean>} true if a ban was attempted (or already in flight)
 */
async function executeHoneypotBan(
  guild,
  user,
  {
    reason,
    dmText,
    deleteMessage = null,
    trigger = "channel",
    channelId = null,
    roleIds = null,
  } = {},
) {
  if (!guild || !user?.id) return false;
  if (user.bot) return false;

  // Enforcement edges resolve the integer community id (spec § In-memory maps:
  // the banning set is keyed `${communityId}:${userId}`, not by snowflake).
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: guild.id,
  });

  // #440 breaker: while paused, bans are REFUSED. Message suppression stays
  // on (the channel keeps draining and evidence survives); only the
  // irreversible step waits for admin confirmation.
  if (isEnforcementPaused(communityId)) {
    if (deleteMessage) {
      try {
        if (deleteMessage.deletable) await deleteMessage.delete();
      } catch (e) {
        console.warn(
          `[honeypot] Could not delete message while enforcement is paused in ${guild.id}:`,
          e?.message || e,
        );
      }
    }
    console.warn(
      `[honeypot] Enforcement paused in community ${communityId} (mass-ban breaker) — ban suppressed for ${user.id}`,
    );
    return false;
  }

  const banKey = key(communityId, user.id);
  if (honeypotBanning.has(banKey)) return true;
  honeypotBanning.add(banKey);

  let dmSent = null;
  let banned = false;
  let banError = null;
  const shortReason = reason || "Honeypot trigger";

  try {
    // Count the ATTEMPT, not the success: the fan-out itself is the storm.
    // Over the cap this ban is NOT executed — at most BAN_WINDOW_MAX bans
    // ever land per window, then the pause holds (persisted, #440).
    const attempts = noteBanAttempt(communityId);
    if (attempts > BAN_WINDOW_MAX) {
      // Suppression stays on even here: the message is deleted, only the
      // irreversible step is withheld.
      if (deleteMessage) {
        try {
          if (deleteMessage.deletable) await deleteMessage.delete();
        } catch (e) {
          console.warn(
            `[honeypot] Could not delete message while tripping the breaker in ${guild.id}:`,
            e?.message || e,
          );
        }
      }
      await tripBanBreaker(communityId, {
        cause:
          `${BAN_WINDOW_MAX} honeypot bans within ` +
          `${Math.round(BAN_WINDOW_MS / 60000)} minutes ` +
          `(last trigger: ${trigger}${channelId ? ` in channel ${channelId}` : ""})`,
        client: guild.client,
        guild,
      });
      return false;
    }

    const guildName = guild.name;

    // DM first — ban can prevent later contact via the guild
    try {
      await user.send(
        dmText ||
          `You have been **banned** from **${guildName}**.\n\n` +
            `**Reason:** ${shortReason}. ` +
            `If you believe this was a mistake, contact the server staff through another channel.`,
      );
      dmSent = true;
    } catch (e) {
      dmSent = false;
      console.warn(
        `[honeypot] Could not DM ${user.id} in ${guild.id}:`,
        e?.message || e,
      );
    }

    if (deleteMessage) {
      try {
        if (deleteMessage.deletable) await deleteMessage.delete();
      } catch (e) {
        console.warn(
          `[honeypot] Could not delete message in ${guild.id}:`,
          e?.message || e,
        );
      }
    }

    try {
      await guild.members.ban(user.id, {
        reason: `Honeypot: ${shortReason}`,
        deleteMessageSeconds: 0,
      });
      banned = true;
      console.log(
        `[honeypot] Banned ${user.tag || user.username} (${user.id}) in ${guildName} (${guild.id}): ${shortReason}`,
      );
    } catch (e) {
      banError = e?.message || String(e);
      console.error(
        `[honeypot] Failed to ban ${user.id} in ${guild.id}:`,
        banError,
      );
    }

    recordSystemAudit({
      communityId,
      action: "honeypot.enforce",
      targetType: "user",
      targetId: user.id,
      details: {
        trigger,
        channel_id:
          channelId ||
          deleteMessage?.channel?.id ||
          deleteMessage?.channelId ||
          null,
        role_ids: roleIds || null,
        banned: banned ? 1 : 0,
        error: banError,
      },
    });

    // Staff audit channel (if configured) — dedicated honeypot embed
    try {
      const client = guild.client;
      if (client) {
        await logHoneypotTrigger(getDiscordOutbound(client), guild, {
          user,
          trigger,
          channelId:
            channelId ||
            deleteMessage?.channel?.id ||
            deleteMessage?.channelId ||
            null,
          roleIds: roleIds || null,
          reason: shortReason,
          banned,
          dmSent,
          error: banError,
        });
      }
    } catch (e) {
      console.warn(
        `[honeypot] Audit log failed for ${user.id} in ${guild.id}:`,
        e?.message || e,
      );
    }
  } finally {
    setTimeout(() => honeypotBanning.delete(banKey), 10_000);
  }

  return true;
}

/**
 * Strip one reaction emoji from a honeypot warning notice (full wipe when possible).
 */
async function stripHoneypotWarningReaction(reaction) {
  if (!reaction) return false;
  try {
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        /* continue with best effort */
      }
    }
    await reaction.remove();
    return true;
  } catch (err) {
    // Fall back to removing individual reactors (still needs Manage Messages for others)
    try {
      if (reaction.users?.cache?.size) {
        for (const userId of reaction.users.cache.keys()) {
          await reaction.users.remove(userId).catch(() => null);
        }
        return true;
      }
    } catch {
      /* ignore */
    }
    console.warn(
      `[honeypot] Could not strip reaction on warning notice:`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * If the reaction is on a honeypot warning notice, remove it and return true.
 * Runs for any user (including bots) so the notice stays reaction-free.
 */
async function handleHoneypotWarningReaction(reaction) {
  const message = reaction?.message;
  if (!message) return false;

  const messageId = message.id;
  // Fluxer PR 2: repo is community-keyed — resolve the integer at this edge.
  const communityId = communityIdFor(message.guildId || message.guild?.id);
  if (!isHoneypotWarningMessage(communityId, messageId)) return false;

  await stripHoneypotWarningReaction(reaction);
  return true;
}

/**
 * Fluxer twin of handleHoneypotWarningReaction for NormalizedReaction events
 * (PR 9). The warning-notice store is the honeypot_channels warning_message_id
 * column — isHoneypotWarningMessage(communityId, messageId) resolves from the
 * normalized ids alone, so the lookup works off the gateway payload with NO
 * Discord message state. The strip uses removeEmojiReaction (full wipe of the
 * emoji — the OutboundClient twin of reaction.remove()). Runs for any user,
 * including bots, so the notice stays reaction-free (Discord parity).
 *
 * @param {object} outbound OutboundClient (Fluxer)
 * @param {object} normalizedReaction normalizeFluxerReaction output
 * @returns {Promise<boolean>} true when the reaction sat on a warning notice
 */
async function handleHoneypotFluxerWarningReaction(outbound, normalizedReaction) {
  if (!normalizedReaction) return false;
  const messageId = normalizedReaction.messageId;
  const channelId = normalizedReaction.channelId;
  const emojiKey = normalizedReaction.emojiKey;
  if (!messageId || !channelId || !emojiKey) return false;

  // Defensive resolve (the pipeline resolves first; direct callers may not).
  let communityId = normalizedReaction.communityId;
  if (!Number.isSafeInteger(communityId)) {
    if (normalizedReaction.externalGuildId == null) return false;
    try {
      communityId = ensureCommunity({
        platform: "fluxer",
        instanceKey: normalizedReaction.instanceKey ?? "fluxer",
        externalGuildId: String(normalizedReaction.externalGuildId),
      });
      normalizedReaction.communityId = communityId;
    } catch (e) {
      console.warn(
        `[fluxer] honeypot warning reaction community resolve failed (message ${messageId}):`,
        e?.message || e,
      );
      return false;
    }
  }

  if (!isHoneypotWarningMessage(communityId, messageId)) return false;

  // Full wipe; the OutboundClient resolves on HTTP outcomes (never throws for
  // platform failures), so a non-ok result is a logged warning, not a throw.
  try {
    const res = await outbound.removeEmojiReaction(channelId, messageId, emojiKey);
    if (res && res.ok === false) {
      console.warn(
        `[fluxer] honeypot Could not strip reaction on warning notice: ${res.error} ` +
          `(message ${messageId}, emoji ${emojiKey})`,
      );
    }
  } catch (e) {
    console.warn(
      "[fluxer] honeypot Could not strip reaction on warning notice:",
      e?.message || e,
    );
  }
  return true;
}

/**
 * Sweep all honeypot warning notices and clear any leftover reactions
 * (e.g. added while the bot was offline, or missed by the live handler).
 */
async function sweepHoneypotWarningReactions(client) {
  const rows = listAllHoneypotWarnings();
  if (!rows.length) return;

  for (const row of rows) {
    try {
      // Rows key by community id; the Discord cache needs the external id.
      const externalGuildId = getCommunityById(row.community_id)?.externalGuildId;
      if (!externalGuildId) continue;
      const guild =
        client.guilds.cache.get(externalGuildId) ||
        (await client.guilds.fetch(externalGuildId).catch(() => null));
      if (!guild) continue;

      const channel = await guild.channels
        .fetch(row.channel_id)
        .catch(() => null);
      if (
        !channel ||
        typeof channel.isTextBased !== "function" ||
        !channel.isTextBased()
      ) {
        continue;
      }

      const msg = await channel.messages
        .fetch(row.warning_message_id)
        .catch(() => null);
      if (!msg) continue;

      const count = msg.reactions?.cache?.size || 0;
      if (count === 0) continue;

      try {
        await msg.reactions.removeAll();
      } catch {
        for (const reaction of msg.reactions.cache.values()) {
          await reaction.remove().catch(() => null);
        }
      }
    } catch (e) {
      console.warn(
        `[honeypot] Warning reaction sweep failed for ${row.community_id}/${row.channel_id}:`,
        e?.message || e,
      );
    }
  }
}

/**
 * Delete a honeypot-channel message without banning, logging the failure if
 * the delete itself fails (channel stays empty like the exempt path).
 */
async function deleteMessageWithoutBan(message, cause) {
  console.error(
    `[honeypot] Honeypot hit in guild ${message.guild.id} from user ${message.author.id} ` +
      `but exemption state is UNKNOWN (${cause}) — message deleted, NO ban issued.`,
  );
  try {
    if (message.deletable) await message.delete();
  } catch (e) {
    console.warn(
      `[honeypot] Could not delete message from ${message.author.id} in ${message.guild.id}:`,
      e?.message || e,
    );
  }
}

/**
 * If the message is in a honeypot channel, delete it and ban the author (unless exempt).
 * Exempt users still have their message deleted, but are not banned.
 * When the author's member state cannot be resolved (uncached member + failed
 * `members.fetch`, audit C4) the message is deleted and the failure logged —
 * never banned: a ban is irreversible and the docs promise staff are exempt,
 * so one flaky 5xx must not ban a moderator.
 * Returns true when the message was handled as honeypot traffic (caller should not award XP).
 */
async function handleHoneypotMessage(message) {
  // Fluxer PR 2: the honeypot repository is community-keyed — resolve the
  // integer community id at this Discord edge.
  const communityId = communityIdFor(message.guild.id);
  if (!isHoneypotChannel(communityId, message.channel.id)) return false;

  let member = message.member;
  if (!member) {
    let fetchCause = null;
    try {
      member = await message.guild.members.fetch(message.author.id);
    } catch (e) {
      fetchCause = `members.fetch failed: ${e?.message || e}`;
    }
    if (!member) {
      // C4 fail-safe: a rejected fetch OR a fetch that resolves to no member
      // leaves the exemption state unverifiable — delete-and-log, do NOT ban.
      await deleteMessageWithoutBan(
        message,
        fetchCause || "members.fetch returned no member",
      );
      return true;
    }
  }

  // Exempt roles (staff, etc.) — no ban, but still delete the message so the channel stays empty
  const roleIds = [...member.roles.cache.keys()];
  // staffRoles repo is community-keyed (PR 2): reuse the resolved id.
  if (memberHasStaffRole(communityId, roleIds)) {
    try {
      if (message.deletable) await message.delete();
    } catch (e) {
      console.warn(
        `[honeypot] Could not delete exempt message in ${message.guild.id}:`,
        e?.message || e,
      );
    }
    return true;
  }

  await executeHoneypotBan(message.guild, message.author, {
    reason: "Posted in a honeypot channel",
    dmText:
      `You have been **banned** from **${message.guild.name}**.\n\n` +
      `**Reason:** You posted in a restricted channel that is used to catch spam accounts and raids. ` +
      `If you believe this was a mistake, contact the server staff through another channel.`,
    deleteMessage: message,
    trigger: "channel",
    channelId: message.channel?.id || message.channelId,
  });

  return true;
}

/**
 * Fluxer honeypot check for a NormalizedMessage (PR 6 scope, spec
 * § Normalized gateway events: "a prefix line in a honeypot channel is a
 * honeypot hit"). Resolves the configured channel by the message's INTEGER
 * community id (the pipeline resolves it before calling this).
 *
 * PR 9: the ban leg calls `outbound.banMember` whenever the author's role
 * state is KNOWN (issue #280: never on unknown state) — the K8 self-gate
 * answers flag 0 with code "elevated_disabled" and a specific reason (no
 * network; logged), flag 1 performs the real ban. A hit CONSUMES the message
 * (no XP, no gork, no dispatch). Message deletion stays out of scope (no
 * OutboundClient.deleteMessage — the suppression line remains).
 * Staff-exempt authors keep their message (no delete surface) and are never
 * banned, and so does every author whose exemption state cannot be verified:
 * the same fail-safe posture as the Discord twin (audit C4, PR #237).
 *
 * Role-state authority (#280) — the exemption check may only run on roles we
 * can trust, in this order:
 *   1. `fetchMember` resolves a member carrying a role array → AUTHORITATIVE
 *      (it overrides a stale payload in both directions).
 *   2. Fetch rejected/null but the payload carried NON-EMPTY role ids →
 *      authoritative-POSITIVE: the #183 member-manager path only yields real
 *      ids for a member it actually carried, so staff stay exempt under a
 *      transient failure and a known non-staff set bans exactly as before.
 *   3. Fetch rejected/null AND the payload set is empty/absent → UNKNOWN.
 *      `[]` stays ambiguous here by design: issue #274 fixed the NORMALIZER
 *      (an absent member now normalizes to memberRoleIds null, not []), but
 *      a hand-built or legacy [] payload still cannot be trusted as
 *      "known-empty", so the empty case keeps its UNKNOWN posture. A ban is
 *      irreversible and the docs promise staff are exempt →
 *      consume the hit, log user + community + cause, NEVER ban. Accepted
 *      tradeoff (same as #237): a real hit during a transient Fluxer failure
 *      goes unbanned — a false negative beats banning a moderator.
 *
 * @param {object} outbound OutboundClient (Fluxer adapter)
 * @param {object} message NormalizedMessage (communityId resolved)
 * @returns {Promise<boolean>} true when the message is honeypot traffic
 */
async function handleHoneypotFluxerMessage(outbound, message) {
  const communityId = message.communityId;
  if (!Number.isSafeInteger(communityId)) return false;
  if (!isHoneypotChannel(communityId, message.channelId)) return false;

  // Honeypot hit: the line is consumed as a hit, never as a command/XP.
  const payloadRoleIds = Array.isArray(message.memberRoleIds) ? message.memberRoleIds : [];
  let roleIds = null; // null = the REST leg did not resolve a member record
  let fetchCause = null;
  try {
    const member = await outbound.fetchMember(communityId, message.authorId);
    if (member && Array.isArray(member.roleIds)) {
      roleIds = member.roleIds; // authority rule 1
    } else {
      // OutboundClient.fetchMember never rejects — it logs the REST cause and
      // resolves null (src/platform/fluxer/outbound.js), so the specific
      // network cause is already in the log beside this line.
      fetchCause = "fetchMember returned no member";
    }
  } catch (e) {
    fetchCause = `fetchMember failed: ${e?.message || e}`;
  }

  if (roleIds === null && payloadRoleIds.length > 0) {
    roleIds = payloadRoleIds; // authority rule 2 (non-empty payload = positive state)
  }
  if (roleIds === null) {
    // Authority rule 3: member state UNKNOWN. Consumption semantics match the
    // staff-exempt branch below — the hit is recorded, the message stands (no
    // delete surface), and NO ban is issued. Never ban on unknown state.
    console.error(
      `[fluxer] honeypot member state unknown for ${message.authorId} in community ${communityId} ` +
        `channel ${message.channelId}: ${fetchCause} — no ban, message stands ` +
        `(no delete surface in PR 6)`,
    );
    return true;
  }

  if (memberHasStaffRole(communityId, roleIds)) {
    console.log(
      `[fluxer] honeypot hit by exempt member ${message.authorId} in community ${communityId} channel ${message.channelId}: message stands (no delete surface in PR 6), no ban`,
    );
    return true;
  }

  // Ban through the outbound (PR 9). K8 self-gates: flag 0 → elevated_disabled
  // with the specific reason and NO network; flag 1 issues the real PUT. The
  // in-flight dedupe mirrors executeHoneypotBan (rapid message storms ban once).
  // #440 breaker (Fluxer twin): paused → no ban, the hit is still consumed
  // exactly like the elevated_disabled arm; attempts count the same window.
  if (isEnforcementPaused(communityId)) {
    console.log(
      `[fluxer] honeypot ban suppressed: enforcement paused (mass-ban breaker) for user ${message.authorId} in community ${communityId}`,
    );
    return true;
  }

  const banKey = key(communityId, String(message.authorId));
  if (honeypotBanning.has(banKey)) {
    console.log(
      `[fluxer] honeypot ban already in flight for user ${message.authorId} in community ${communityId} — skipping duplicate`,
    );
    console.log(
      `[fluxer] honeypot message delete suppressed: no OutboundClient.deleteMessage before PR 9 (message ${message.id})`,
    );
    return true;
  }
  honeypotBanning.add(banKey);

  const shortReason = "Posted in a honeypot channel";
  let banned = false;
  let banError = null;
  try {
    // #440 breaker count (shared window with the Discord arm's cap; over the
    // cap the ban is NOT executed and the persisted pause takes hold).
    const attempts = noteBanAttempt(communityId);
    if (attempts > BAN_WINDOW_MAX) {
      await tripBanBreaker(communityId, {
        cause:
          `${BAN_WINDOW_MAX} honeypot bans within ` +
          `${Math.round(BAN_WINDOW_MS / 60000)} minutes (last trigger: fluxer channel hit)`,
      });
      return true; // hit still consumed — suppression unaffected by the pause
    }

    let res;
    try {
      res = await outbound.banMember(
        communityId,
        String(message.authorId),
        `Honeypot: ${shortReason}`,
      );
    } catch (e) {
      res = { ok: false, error: String(e?.message || e) };
    }

    if (res.ok) {
      banned = true;
      console.log(
        `[fluxer] honeypot Banned user ${message.authorId} in community ${communityId}: ${shortReason}`,
      );
    } else if (res.code === "elevated_disabled") {
      banError = res.error;
      // The gate's own text names elevated_permissions — the specific cause
      // lands in the log (AGENTS.md rule 3), never a generic string. The
      // message stays consumed as a hit.
      console.log(
        `[fluxer] honeypot ban suppressed: ${res.error} (user ${message.authorId})`,
      );
    } else {
      banError = res.error;
      console.error(
        `[fluxer] honeypot ban failed for user ${message.authorId} in community ${communityId}: ${res.error}`,
      );
    }

    recordSystemAudit({
      communityId,
      action: "honeypot.enforce",
      targetType: "user",
      targetId: String(message.authorId),
      details: {
        trigger: "channel",
        channel_id: message.channelId ?? null,
        role_ids: null,
        banned: banned ? 1 : 0,
        error: banError,
      },
    });
  } finally {
    setTimeout(() => honeypotBanning.delete(banKey), 10_000);
  }

  // Message deletion stays out of scope (no deleteMethod in PR 9) — the
  // PR 6 suppression line remains.
  console.log(
    `[fluxer] honeypot message delete suppressed: no OutboundClient.deleteMessage before PR 9 (message ${message.id})`,
  );
  return true;
}

/**
 * If the member was granted a honeypot ban role, ban them (unless exempt).
 * The ban only fires when the *previous* role state is known (audit C3):
 * after a gateway resume/restart discord.js can emit GuildMemberUpdate with
 * an uncached `oldMember`; treating the current roles as "all newly added"
 * would instantly ban members who already held a ban role (irreversible
 * action fired by a cache artifact). Unknown diff → logged skip, no ban.
 */
async function handleHoneypotBanRole(oldMember, newMember) {
  if (!newMember?.guild) return;
  if (newMember.user?.bot) return;

  const guildId = newMember.guild.id;

  // C3: only proceed when the old role cache is a real cache we can diff
  // against (an empty-but-known cache is fine — that is a genuine first
  // grant). A missing/uncached oldMember means the diff is UNKNOWN.
  const oldRoles = oldMember?.roles?.cache;
  if (!oldRoles || typeof oldRoles.has !== "function") {
    console.warn(
      `[honeypot] GuildMemberUpdate for member ${newMember.id ?? "?"} in guild ${guildId} ` +
        `arrived without cached previous member state (gateway resume/restart?) — ` +
        `role diff unknown, skipping ban-role check (no ban).`,
    );
    return;
  }

  const newRoles = newMember.roles?.cache ?? new Map();

  const addedRoleIds = [];
  for (const roleId of newRoles.keys()) {
    if (roleId === guildId) continue; // @everyone
    if (!oldRoles.has(roleId)) addedRoleIds.push(roleId);
  }
  if (!addedRoleIds.length) return;

  const matched = findHoneypotBanRolesAmong(
    communityIdFor(guildId),
    addedRoleIds,
  );
  if (!matched.length) return;

  // staffRoles repo is community-keyed; resolve the integer at this edge.
  const communityId = ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: guildId,
  });

  const allRoleIds = [...newRoles.keys()];
  if (memberHasStaffRole(communityId, allRoleIds)) {
    console.log(
      `[honeypot] Skip ban-role for exempt member ${newMember.id} in ${guildId} ` +
        `(roles: ${matched.join(", ")})`,
    );
    return;
  }

  const roleMentions = matched.map((id) => `<@&${id}>`).join(", ");
  await executeHoneypotBan(newMember.guild, newMember.user, {
    reason: `Received honeypot ban role (${matched.join(", ")})`,
    dmText:
      `You have been **banned** from **${newMember.guild.name}**.\n\n` +
      `**Reason:** You were assigned a restricted role that is used to catch spam accounts and raids. ` +
      `If you believe this was a mistake, contact the server staff through another channel.`,
    trigger: "ban_role",
    roleIds: matched,
  });

  console.log(
    `[honeypot] Ban-role trigger for ${newMember.id} in ${guildId}: ${roleMentions}`,
  );
}

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleHoneypot(commandCtx, featureCtx) {
  void featureCtx;
  // The context builder resolves the integer community id at the Discord edge
  // (roadmap/fluxer.md § CommandContext); repositories use it directly.
  const { communityId, outbound } = commandCtx;
  // Display/audit key keeps the external (Discord) snowflake.
  const guildId = commandCtx.externalGuildId;

  // Discord-only escape hatch (roadmap § What stays Discord-only): the warning
  // notice poster and the warning-message cleanup need real discord.js
  // Guild/Message objects — the service-side cutover to the OutboundClient is
  // PR 7. Fluxer contexts never carry rawInteraction.
  const raw = commandCtx.rawInteraction;

  const group = commandCtx.subcommandGroup;
  const sub = commandCtx.subcommand;

  // /honeypot safety resume — the persisted pause IS the mass-ban incident
  // brake (#440); clearing it re-arms the irreversible path, so it is
  // ManageGuild-only (same tier as the exempt arm). Nothing else lives in
  // this group.
  if (group === "safety") {
    if (!isAdminOrModFromContext(commandCtx)) {
      await commandCtx.reply({
        content:
          "Only server administrators can resume honeypot enforcement.",
        sensitive: true,
      });
      return;
    }
    if (sub === "resume") {
      const settings = getGuildSettings(communityId);
      const pausedAt = Number(settings.honeypot_paused_at) || 0;
      if (!pausedAt) {
        await commandCtx.reply({
          content: "Honeypot enforcement is not paused — nothing to resume.",
          sensitive: true,
        });
        return;
      }
      updateGuildSettings(communityId, {
        honeypot_paused_at: null,
        honeypot_pause_reason: null,
      });
      clearBanWindow(communityId);
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "honeypot.safety_resume",
        targetType: "guild",
        targetId: String(guildId),
      });
      await logConfigChange(outbound, guildId, {
        title: "Honeypot enforcement resumed",
        command: "/honeypot safety resume",
        actor: commandCtx.user,
        changes: [
          settings.honeypot_pause_reason
            ? `Was paused: ${settings.honeypot_pause_reason}`
            : `Was paused since ${new Date(pausedAt).toISOString()}`,
          "Honeypot bans are live again.",
        ],
      }).catch(() => {});
      await commandCtx.reply({
        content:
          "Honeypot enforcement resumed — bans are live again and the ban window was reset.",
        sensitive: true,
      });
      return;
    }
    await commandCtx.reply({
      content: `Unknown safety subcommand \`${sub}\`.`,
      sensitive: true,
    });
    return;
  }

  // exempt mutates staff_roles — ManageGuild only (same as /staff role)
  if (group === "exempt") {
    if (!isAdminOrModFromContext(commandCtx)) {
      await commandCtx.reply({
        content: "Only server administrators can manage honeypot exempt roles.",
        sensitive: true,
      });
      return;
    }
  } else if (!(await requireStaffFromContext(commandCtx))) {
    return;
  }

  // /honeypot channel [add|list|del]
  if (group === "channel") {
    if (sub === "add") {
      const ch = commandCtx.options.getChannel("channel", true);

      // Channel existence via outbound (roadmap § Outbound client): the
      // Discord adapter returns the discord.js channel, null when the bot
      // cannot see it.
      const channelHandle = await outbound.fetchChannel(communityId, ch.id);
      if (!channelHandle) {
        await commandCtx.reply({
          content: `Could not find <#${ch.id}> in this server — the bot must be able to view a channel to mark it as a honeypot.`,
          sensitive: true,
        });
        return;
      }

      if (isHoneypotChannel(communityId, ch.id)) {
        await commandCtx.reply({
          content: `<#${ch.id}> is already set up as a honeypot channel.`,
          sensitive: true,
        });
        return;
      }

      addHoneypotChannel(communityId, ch.id);
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "honeypot.channel_add",
        targetType: "channel",
        targetId: ch.id,
      });
      // Warning-notice poster: Discord uses the raw interaction's guild; the
      // Fluxer arm posts the same PNG via the OutboundClient (see
      // ensureHoneypotWarning). The repo key is the INTEGER community id
      // (never the guild snowflake).
      const warningStatus = await ensureHoneypotWarning(
        raw?.guild,
        ch.id,
        communityId,
        commandCtx.outbound,
      );
      await logConfigChange(outbound, guildId, {
        title: "Honeypot channel added",
        command: "/honeypot channel add",
        actor: commandCtx.user,
        changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
        details: warningStatus,
      }).catch(() => {});
      await commandCtx.reply({
        content:
          `Marked <#${ch.id}> as a **honeypot** channel.\n` +
          `Anyone who posts there will be banned immediately (except members with exempt roles).\n` +
          `${warningStatus}\n` +
          `Tip: use \`/staff role add\` (or \`/honeypot exempt add\`) to configure staff roles so they are not banned by mistake.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "del") {
      const ch = commandCtx.options.getChannel("channel", true);
      const { removed, warning_message_id } = removeHoneypotChannel(
        communityId,
        ch.id,
      );

      let warningNote = "";
      if (removed && warning_message_id) {
        // Deleting the warning notice is Discord-only: OutboundClient has no
        // message-delete surface yet (service cutover PR 7). The Discord arm
        // uses the raw interaction's guild.
        try {
          const channel = raw?.guild
            ? await raw.guild.channels.fetch(ch.id).catch(() => null)
            : null;
          if (channel?.messages) {
            const msg = await channel.messages
              .fetch(warning_message_id)
              .catch(() => null);
            if (msg) {
              await msg.delete().catch(() => null);
              warningNote = " Warning notice removed.";
            }
          }
        } catch {
          warningNote =
            " (Could not delete warning notice — remove it manually if needed.)";
        }
      }

      if (removed) {
        recordSlashAudit({
          communityId,
          actorUserId: commandCtx.userId,
          action: "honeypot.channel_del",
          targetType: "channel",
          targetId: ch.id,
        });
        await logConfigChange(outbound, guildId, {
          title: "Honeypot channel removed",
          command: "/honeypot channel del",
          actor: commandCtx.user,
          changes: [`Channel: <#${ch.id}> (\`${ch.id}\`)`],
          details: warningNote.trim() || undefined,
        }).catch(() => {});
      }

      await commandCtx.reply({
        content: removed
          ? `Removed <#${ch.id}> from the honeypot list.${warningNote}`
          : `<#${ch.id}> was not a honeypot channel.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "list") {
      const rows = listHoneypotChannels(communityId);
      if (!rows.length) {
        await commandCtx.reply({
          content: "No honeypot channels configured.",
          sensitive: true,
        });
        return;
      }
      const lines = rows.map((r) => `- <#${r.channel_id}>`);
      await commandCtx.reply({
        content: `**Honeypot channels:**\n${lines.join("\n")}`,
        sensitive: true,
      });
      return;
    }
  }

  // /honeypot banrole [add|list|del]
  if (group === "banrole") {
    if (sub === "add") {
      const role = commandCtx.options.getRole("role", true);

      if (role.id === guildId) {
        await commandCtx.reply({
          content: "You cannot use @everyone as a honeypot ban role.",
          sensitive: true,
        });
        return;
      }
      // Spec RoleHandle carries no `managed` flag — graft the Discord-side
      // role object from the documented rawInteraction escape hatch (userinfo
      // precedent). Fluxer contexts carry no raw, so integration-managed roles
      // are not detectable there until the Fluxer role surface lands (PR 9).
      const rawRole = raw?.guild?.roles?.cache?.get?.(role.id) ?? null;
      if (rawRole?.managed) {
        await commandCtx.reply({
          content:
            "That role is managed by an integration. Prefer a normal server role for ban-role honeypots.",
          sensitive: true,
        });
        return;
      }
      if (isHoneypotBanRole(communityId, role.id)) {
        await commandCtx.reply({
          content: `<@&${role.id}> is already a honeypot ban role.`,
          sensitive: true,
        });
        return;
      }

      addHoneypotBanRole(communityId, role.id);
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "honeypot.ban_role_add",
        targetType: "role",
        targetId: role.id,
      });
      await logConfigChange(outbound, guildId, {
        title: "Honeypot ban role added",
        command: "/honeypot banrole add",
        actor: commandCtx.user,
        changes: [`Role: <@&${role.id}> (\`${role.id}\`)`],
      }).catch(() => {});
      await commandCtx.reply({
        content:
          `Marked <@&${role.id}> as a **honeypot ban role**.\n` +
          `Anyone who is **granted** this role will be banned immediately ` +
          `(except members with honeypot exempt roles).\n` +
          `Tip: configure \`/staff role add\` (or \`/honeypot exempt add\`) for staff first. ` +
          `Members who already have the role are not retroactively banned.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "del") {
      const role = commandCtx.options.getRole("role", true);
      const removed = removeHoneypotBanRole(communityId, role.id);
      if (removed) {
        recordSlashAudit({
          communityId,
          actorUserId: commandCtx.userId,
          action: "honeypot.ban_role_del",
          targetType: "role",
          targetId: role.id,
        });
        await logConfigChange(outbound, guildId, {
          title: "Honeypot ban role removed",
          command: "/honeypot banrole del",
          actor: commandCtx.user,
          changes: [`Role: <@&${role.id}> (\`${role.id}\`)`],
        }).catch(() => {});
      }
      await commandCtx.reply({
        content: removed
          ? `Removed <@&${role.id}> from the honeypot ban-role list.`
          : `<@&${role.id}> was not a honeypot ban role.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "list") {
      const rows = listHoneypotBanRoles(communityId);
      if (!rows.length) {
        await commandCtx.reply({
          content: "No honeypot ban roles configured.",
          sensitive: true,
        });
        return;
      }
      const lines = rows.map((r) => `- <@&${r.role_id}>`);
      await commandCtx.reply({
        content: `**Honeypot ban roles** (granting these bans the member):\n${lines.join("\n")}`,
        sensitive: true,
      });
      return;
    }
  }

  // /honeypot exempt [add|list|del]
  if (group === "exempt") {
    if (sub === "add") {
      const role = commandCtx.options.getRole("role", true);
      // #438 (audit F2-2): a ban-exemption toggle must NOT change staff
      // POWER. addStaffRole() used to run without a level, silently
      // PROMOTING an existing junior staff role to senior (ticket-channel
      // visibility + senior-only surfaces widen as a side effect). Existing
      // rows now keep their level; new exemptions are created JUNIOR —
      // exemption needs membership in staff_roles, not elevation. An admin
      // promotes deliberately with /staff role setlevel.
      const { created, row } = insertStaffRoleIfMissing(
        communityId,
        role.id,
        "junior",
        commandCtx.userId,
      );
      // Same underlying table as /staff role add — keep the action vocabulary
      // AND its level-forensics (previous_level), per #438.
      recordSlashAudit({
        communityId,
        actorUserId: commandCtx.userId,
        action: "staff.role_add",
        targetType: "role",
        targetId: role.id,
        details: {
          via: "honeypot.exempt",
          level: row?.level ?? "junior",
          previous_level: created ? null : row?.level ?? null,
        },
      });
      await logConfigChange(outbound, guildId, {
        title: created
          ? "Honeypot exempt role added (junior staff)"
          : "Honeypot exemption confirmed (level unchanged)",
        command: "/honeypot exempt add",
        actor: commandCtx.user,
        changes: [
          `Role: <@&${role.id}> (\`${role.id}\`)`,
          created
            ? "Staff level: **junior** (use /staff role setlevel to promote)"
            : `Staff level: **${row?.level ?? "unknown"}** — unchanged`,
        ],
      }).catch(() => {});
      await commandCtx.reply({
        content: created
          ? `Added <@&${role.id}> as a **junior** staff role (honeypot-exempt). ` +
            `Members with this role will not be banned for posting in honeypot channels or receiving honeypot ban roles. ` +
            `Change staff level with \`/staff role setlevel\`.`
          : `<@&${role.id}> was already a staff role (**${row?.level ?? "unknown"}**, kept as-is) — it is now honeypot-exempt. ` +
            `Exemption never changes a role's staff level (#438).`,
        sensitive: true,
      });
      return;
    }

    if (sub === "del") {
      const role = commandCtx.options.getRole("role", true);
      const removed = removeStaffRole(communityId, role.id);
      if (removed) {
        recordSlashAudit({
          communityId,
          actorUserId: commandCtx.userId,
          action: "staff.role_remove",
          targetType: "role",
          targetId: role.id,
          details: { via: "honeypot.exempt" },
        });
        await logConfigChange(outbound, guildId, {
          title: "Honeypot exempt role removed",
          command: "/honeypot exempt del",
          actor: commandCtx.user,
          changes: [`Role: <@&${role.id}> (\`${role.id}\`)`],
        }).catch(() => {});
      }
      await commandCtx.reply({
        content: removed
          ? `Removed <@&${role.id}> from staff roles (also removes honeypot exemption).`
          : `<@&${role.id}> is not a configured staff role.`,
        sensitive: true,
      });
      return;
    }

    if (sub === "list") {
      const rows = listStaffRoles(communityId);
      if (!rows.length) {
        await commandCtx.reply({
          content:
            "No staff roles configured. Staff who hit honeypots will be banned.",
          sensitive: true,
        });
        return;
      }
      const lines = rows.map((r) => `- <@&${r.role_id}>`);
      await commandCtx.reply({
        content: `**Staff roles (also used for honeypot exemption):**\n${lines.join("\n")}`,
        sensitive: true,
      });
      return;
    }
  }

  // Always answer /honeypot so we never fall through as "handler missing"
  await commandCtx.reply({
    content:
      `Unknown honeypot subcommand: \`/${commandCtx.commandName}` +
      `${group ? ` ${group}` : ""} ${sub || ""}\`.\n` +
      `Use \`/honeypot channel add|list|del\`, \`/honeypot banrole add|list|del\`, or \`/honeypot exempt add|list|del\`.`,
    sensitive: true,
  });
  return;
}

/**
 * PR 7: the first argument is the supervisor. Gateway binds attach to
 * supervisor.discord only (Fluxer gateway events are wired in the
 * elevated-permissions PR; spec § Scheduler jobs).
 * @param {object|null} supervisor
 * @param {object} [featureCtx]
 */
function registerEvents(supervisor, featureCtx) {
  void featureCtx;
  const client =
    supervisor && typeof supervisor.clientForCommunity === "function"
      ? supervisor.discord ?? null
      : supervisor && supervisor.on
        ? supervisor // legacy raw discord.js client
        : null;
  if (!client) return; // Discord unconfigured → no-op binds

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    try {
      await handleHoneypotBanRole(oldMember, newMember);
    } catch (e) {
      console.error(
        "[GuildMemberUpdate] honeypot banrole error:",
        e?.message || e,
      );
    }
  });
}

/**
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {object} [featureCtx]
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  // The sweep walks Discord guilds from the client cache (spec 581: per client
  // that has the guild in cache). Fluxer rows in the warnings table resolve to
  // no Discord guild and are skipped inside the sweep loop.
  const client =
    supervisor && typeof supervisor.clientForCommunity === "function"
      ? supervisor.discord ?? null
      : supervisor && supervisor.guilds
        ? supervisor // legacy raw discord.js client
        : null;

  registerJob({
    name: "honeypotSweep",
    intervalMs: 10 * 60 * 1000,
    runImmediately: true,
    run: () => {
      if (!client) {
        // Discord unconfigured → the sweep has no guild cache to walk.
        console.log(
          "[honeypot] Discord client not configured — warning-reaction sweep skipped",
        );
        return;
      }
      return sweepHoneypotWarningReactions(client);
    },
  });
}

module.exports = {
  name: "honeypot",
  commands,
  handlers: {
    honeypot: handleHoneypot,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext. Pipeline/registration hooks stay on the
  // raw gateway event (untouched until PR 7).
  handlerApi: {
    honeypot: "context",
  },
  registerEvents,
  start,
  ensureHoneypotWarning,
  handleHoneypotMessage,
  handleHoneypotFluxerMessage,
  handleHoneypotWarningReaction,
  handleHoneypotFluxerWarningReaction,
  handleHoneypotBanRole,
  // #440 mass-ban breaker surface (window reset doubles as incident tooling;
  // the constants are pinned by the tests).
  clearBanWindow,
  isEnforcementPaused,
  BAN_WINDOW_MAX,
  BAN_WINDOW_MS,
  postHoneypotWarning,
  executeHoneypotBan,
  sweepHoneypotWarningReactions,
};
