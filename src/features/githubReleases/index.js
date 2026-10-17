const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require("discord.js");
const {
  getGithubWatches,
  getAllGithubWatches,
  getGithubWatch,
  addGithubWatch,
  removeGithubWatch,
  updateGithubWatch,
  normalizeGithubRepo,
} = require("../../db");
const {
  requireStaffFromContext,
  requireStaff,
} = require("../../core/permissions");
const { showModalFromContext } = require("../../platform/context");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { replyEphemeral } = require("../../core/interaction");
const tokenKeys = require("../../core/thirdPartyTokens");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const { discordCommunityId } = require("../../platform/community");
const { fetchRepo } = require("./github");
const { processWatch, startGithubReleaseTicker } = require("./ticker");

const staffPerms = PermissionFlagsBits.ManageGuild;

// #444 (audit INT-9): PATs must never be entered as a chat-input option —
// Discord renders slash option values publicly in the channel (only the
// REPLY is ephemeral), so the option leaked the live token to everyone
// reading. Token entry moved to this modal: modal submissions are visible
// ONLY to the submitter. customId carries the normalized repo (safe charset:
// normalizeGithubRepo output).
const MODAL_PREFIX_TOKEN = "gh:token:";
const MODAL_FIELD_TOKEN = "token";

/**
 * @param {string} repo normalized owner/name
 * @returns {ModalBuilder}
 */
function buildGithubTokenModal(repo) {
  const input = new TextInputBuilder()
    .setCustomId(MODAL_FIELD_TOKEN)
    .setLabel("GitHub token for " + repo)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(255)
    .setPlaceholder("Fine-grained PAT (submit empty to clear)");

  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX_TOKEN}${repo}`)
    .setTitle(`GitHub token — ${repo}`)
    .addComponents(new ActionRowBuilder().addComponents(input));
}

const commands = [
  new SlashCommandBuilder()
    .setName("github")
    .setDescription("Track GitHub releases for this server (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("watch")
        .setDescription("Track releases from a GitHub repository.")
        .addStringOption((opt) =>
          opt
            .setName("repo")
            .setDescription("Repository, e.g. owner/name or a GitHub URL")
            .setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to post release notes to")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) => {
      // #444: token entry is MODAL-ONLY. A string option here would render
      // the PAT publicly in channel; the modal submission is ephemeral by
      // platform design.
      const sub = sc
        .setName("token")
        .setDescription(
          "Set/clear the GitHub token for a repository (opens a private prompt).",
        );
      sub.addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Repository (owner/name — creates the watch if new)")
          .setRequired(true)
          .setAutocomplete(true),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("remove")
        .setDescription("Stop tracking a repository.");
      sub.addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Repository to stop tracking")
          .setRequired(true)
          .setAutocomplete(true),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List tracked repositories and settings."),
    )
    .addSubcommand((sc) => {
      const sub = sc
        .setName("channel")
        .setDescription("Set the channel a repository posts to.");
      sub.addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Tracked repository")
          .setRequired(true)
          .setAutocomplete(true),
      );
      sub.addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel to post release notes to")
          .setRequired(true),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("role")
        .setDescription("Set the role mentioned on release posts.");
      sub.addStringOption((opt) =>
        opt
          .setName("repo")
          .setDescription("Tracked repository")
          .setRequired(true)
          .setAutocomplete(true),
      );
      sub.addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription("Role to mention (leave empty to disable pings)")
          .setRequired(false),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc
        .setName("check")
        .setDescription("Probe for new releases now (normally hourly).")
        .addStringOption((opt) =>
          opt
            .setName("repo")
            .setDescription("Only check this repository (default: all)")
            .setRequired(false)
            .setAutocomplete(true),
        ),
    ),
];

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleGithub(commandCtx, featureCtx) {
  void featureCtx;
  if (!(await requireStaffFromContext(commandCtx))) return;

  // Repository key: integer community id (resolved by the context builder).
  const communityId = commandCtx.communityId;
  // Display/audit key: the external (Discord) snowflake.
  const guildId = commandCtx.externalGuildId;

  const sub = commandCtx.subcommand;

  if (sub === "watch") {
    const raw = commandCtx.options.getString("repo", true);
    const repo = normalizeGithubRepo(raw);
    if (!repo) {
      await commandCtx.reply({
        content: `\`${raw}\` is not a repository reference. Use \`owner/name\` or a GitHub URL.`,
        sensitive: true,
      });
      return;
    }
    const channel = commandCtx.options.getChannel("channel", false);

    await commandCtx.defer({ sensitive: true });

    const existing = getGithubWatch(communityId, repo);
    const check = await fetchRepo(repo, null);
    if (!check.ok) {
      // #444: point at the PRIVATE token flow instead of the removed public
      // option; a private repo fails here precisely because no token exists.
      await commandCtx.editReply(
        `Could not track **${repo}**: ${check.error}` +
          `\n\nIf this repository is private, store a token first with ` +
          `\`/github token repo:${repo}\` — the prompt is visible only to you.`,
      );
      return;
    }

    let row;
    try {
      row = addGithubWatch(communityId, repo, check.fullName, {
        channelId: channel ? channel.id : null,
      });
    } catch (err) {
      // Specific cause — never let the handler die into the router's generic
      // fallback.
      await commandCtx.editReply(
        `Could not save the watch for **${repo}**: ${err?.message || err}`,
      );
      return;
    }

    // #443 (audit INT-8): durable admin_audit row for every mutating slash
    // action — the embed below only reaches the staff channel when one is
    // configured; this is the trail retention keeps 365 days.
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "github.watch_add",
      targetType: "github_watch",
      targetId: row.repo,
      details: {
        repo_display: row.repo_display,
        replaces: existing ? 1 : 0,
        channel_id: channel ? channel.id : null,
      },
    });

    await logConfigChange(commandCtx.outbound, guildId, {
      title: existing
        ? "GitHub watch updated"
        : "GitHub repository watched",
      command: "/github watch",
      actor: commandCtx.user,
      changes: [
        `Repository: **${check.fullName}**`,
        channel
          ? `Channel: <#${channel.id}>`
          : "Channel: unchanged / *not set*",
      ],
    }).catch(() => {});

    let replyMsg = existing
      ? `Updated watch for **${check.fullName}**.`
      : `Now tracking releases for **${check.fullName}**.`;
    if (!row.channel_id) {
      replyMsg +=
        "\n\nNote: no notification channel set yet — run `/github channel` (or re-run `/github watch` with a channel) to pick where release notes go.";
    } else {
      replyMsg += ` Release notes will be posted to <#${row.channel_id}>.`;
    }
    replyMsg +=
      "\nToken (optional, private): `/github token` — needed only for private repos or a higher rate limit.";
    await commandCtx.editReply(replyMsg);
    return;
  }

  if (sub === "token") {
    const raw = commandCtx.options.getString("repo", true);
    const repo = normalizeGithubRepo(raw);
    if (!repo) {
      await commandCtx.reply({
        content: `\`${raw}\` is not a repository reference. Use \`owner/name\`.`,
        sensitive: true,
      });
      return;
    }
    // PATs are envelope-encrypted at rest (audit C6); without a usable
    // TOKEN_ENCRYPTION_KEY no token could ever be stored — say so BEFORE
    // opening the modal, so the user never types a secret into a dead end.
    if (!tokenKeys.hasTokenKey()) {
      await commandCtx.reply({
        content: tokenKeys.keyMissingError("a GitHub token").message,
        sensitive: true,
      });
      return;
    }
    const shown = await showModalFromContext(
      commandCtx,
      buildGithubTokenModal(repo),
    );
    if (!shown) {
      await commandCtx.reply({
        content:
          "This platform can't open the private token prompt — GitHub tokens are configured from Discord for now.",
        sensitive: true,
      });
    }
    return;
  }

  if (sub === "remove") {
    const raw = commandCtx.options.getString("repo", true);
    const found = getGithubWatch(communityId, raw);
    if (!found) {
      await commandCtx.reply({
        content: `**${raw}** is not tracked in this server.`,
        sensitive: true,
      });
      return;
    }

    removeGithubWatch(communityId, found.repo);
    // #443 (audit INT-8): durable admin_audit trail.
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "github.watch_remove",
      targetType: "github_watch",
      targetId: found.repo,
      details: { repo_display: found.repo_display },
    });

    await logConfigChange(commandCtx.outbound, guildId, {
      title: "GitHub watch removed",
      command: "/github remove",
      actor: commandCtx.user,
      changes: [`Repository: **${found.repo_display}**`],
    }).catch(() => {});

    await commandCtx.reply({
      content: `Stopped tracking **${found.repo_display}**.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "list") {
    const watches = getGithubWatches(communityId);
    if (!watches.length) {
      await commandCtx.reply({
        content:
          "No GitHub repositories tracked. Add one with `/github watch`.",
        sensitive: true,
      });
      return;
    }

    const lines = watches.map((w) => {
      const ch = w.channel_id ? `<#${w.channel_id}>` : "**no channel**";
      const role = w.role_id ? ` · ping <@&${w.role_id}>` : "";
      const token = w.has_token ? " · token set" : "";
      const latest = w.last_release_id ? " · latest posted" : " · not yet posted";
      return `• **${w.repo_display}** → ${ch}${role}${token}${latest}`;
    });

    await commandCtx.reply({
      content: `**GitHub release watches** (${watches.length})\n${lines.join("\n")}`,
      sensitive: true,
    });
    return;
  }

  if (sub === "channel") {
    const raw = commandCtx.options.getString("repo", true);
    const found = getGithubWatch(communityId, raw);
    if (!found) {
      await commandCtx.reply({
        content: `**${raw}** is not tracked here. Add it with \`/github watch\` first.`,
        sensitive: true,
      });
      return;
    }
    const ch = commandCtx.options.getChannel("channel", true);
    updateGithubWatch(communityId, found.repo, { channelId: ch.id });
    // #443 (audit INT-8): durable admin_audit trail.
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "github.channel_set",
      targetType: "github_watch",
      targetId: found.repo,
      details: { repo_display: found.repo_display, channel_id: ch.id },
    });

    await logConfigChange(commandCtx.outbound, guildId, {
      title: "GitHub watch channel set",
      command: "/github channel",
      actor: commandCtx.user,
      changes: [
        `Repository: **${found.repo_display}**`,
        found.channel_id
          ? `Channel: <#${found.channel_id}> → <#${ch.id}>`
          : `Channel: *none* → <#${ch.id}>`,
      ],
    }).catch(() => {});

    await commandCtx.reply({
      content: `Release notes for **${found.repo_display}** will be sent to <#${ch.id}>.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "role") {
    const raw = commandCtx.options.getString("repo", true);
    const found = getGithubWatch(communityId, raw);
    if (!found) {
      await commandCtx.reply({
        content: `**${raw}** is not tracked here. Add it with \`/github watch\` first.`,
        sensitive: true,
      });
      return;
    }
    const role = commandCtx.options.getRole("role", false);
    updateGithubWatch(communityId, found.repo, {
      roleId: role ? role.id : null,
    });
    const beforeLabel = found.role_id ? `<@&${found.role_id}>` : "*none*";
    const afterLabel = role ? `<@&${role.id}>` : "*none*";
    // #443 (audit INT-8): durable admin_audit trail (role_id null = cleared).
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "github.role_set",
      targetType: "github_watch",
      targetId: found.repo,
      details: { repo_display: found.repo_display, role_id: role ? role.id : null },
    });

    await logConfigChange(commandCtx.outbound, guildId, {
      title: "GitHub watch ping role set",
      command: "/github role",
      actor: commandCtx.user,
      changes: [
        `Repository: **${found.repo_display}**`,
        `Role: ${beforeLabel} → ${afterLabel}`,
      ],
    }).catch(() => {});

    await commandCtx.reply({
      content: role
        ? `Release posts for **${found.repo_display}** will mention <@&${role.id}>.`
        : `Release posts for **${found.repo_display}** will no longer mention a role.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "check") {
    const repoRaw = commandCtx.options.getString("repo", false);
    let targets;
    if (repoRaw) {
      const found = getGithubWatch(communityId, repoRaw);
      if (!found) {
        await commandCtx.reply({
          content: `**${repoRaw}** is not tracked here. Add it with \`/github watch\` first.`,
          sensitive: true,
        });
        return;
      }
      targets = [found];
    } else {
      targets = getGithubWatches(communityId);
      if (!targets.length) {
        await commandCtx.reply({
          content: "No GitHub repositories tracked. Add one with `/github watch`.",
          sensitive: true,
        });
        return;
      }
    }

    // Discord-only subcommand (roadmap § What stays Discord-only): the probe
    // runs the untouched ticker service (processWatch posts release embeds to
    // Discord channels and resolves pings via client.users.fetch). It needs
    // the real Discord client — the documented rawInteraction escape hatch.
    // Fluxer contexts never carry it; the Fluxer arm gets the standard line.
    // The ticker-side cutover happens in a later PR.
    const client = commandCtx.rawInteraction?.client;
    if (!client) {
      await commandCtx.reply({
        content: "That command is not available on Fluxer yet.",
        sensitive: true,
      });
      return;
    }

    await commandCtx.defer({ sensitive: true });

    // Rows from getGithubWatches omit the token; use full rows for the probe.
    const full = new Map(
      getAllGithubWatches()
        .filter((w) => w.community_id === communityId)
        .map((w) => [w.repo, w]),
    );

    let announced = 0;
    const issues = [];
    for (const t of targets) {
      const watch = full.get(t.repo) || t;
      const result = await processWatch(client, watch).catch((err) => ({
        ok: false,
        error: err?.message || String(err),
      }));
      announced += result?.announced || 0;
      if (!result?.ok && (result?.error || result?.skipped)) {
        issues.push(
          `**${t.repo_display}**: ${result.error || result.skipped}`,
        );
      }
    }

    let msg = `Checked ${targets.length} watch(es). ${announced} release(s) announced.`;
    if (issues.length) {
      msg += `\nIssues:\n${issues.map((e) => `- ${e}`).join("\n")}`;
    }
    await commandCtx.editReply(msg);
    return;
  }
}

/**
 * #444 (audit INT-9): the ONLY token write path. A modal submission is
 * visible solely to its submitter — unlike the removed chat-input option.
 * The token is validated against GitHub BEFORE it is stored (a bad token
 * gets a specific, private error instead of a silent hourly failure), then
 * envelope-encrypted via the repository layer (C6). Nothing here ever
 * echoes the token value.
 *
 * Setting a token for a repo that is not yet watched CREATES the watch
 * (validation already proved repo+token work) — this is also the bootstrap
 * path for private repos, which cannot pass `/github watch` unauthenticated.
 * Submitting empty clears the token of an existing watch.
 *
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @param {object} [ctx]
 */
async function handleGithubTokenModal(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;

  const customId = interaction.customId || "";
  if (!customId.startsWith(MODAL_PREFIX_TOKEN)) return;
  const repo = normalizeGithubRepo(customId.slice(MODAL_PREFIX_TOKEN.length));
  if (!repo) {
    await replyEphemeral(interaction, {
      content: "Invalid modal state (missing repository).",
    });
    return;
  }

  let rawValue = "";
  try {
    rawValue = interaction.fields.getTextInputValue(MODAL_FIELD_TOKEN) || "";
  } catch {
    rawValue = "";
  }
  const token = String(rawValue).trim();

  const communityId = discordCommunityId(interaction.guildId);
  if (communityId == null) {
    await replyEphemeral(interaction, {
      content: "This server isn't initialized yet — try again in a moment.",
    });
    return;
  }

  const existing = getGithubWatch(communityId, repo);

  // Validation + storage take network time; the GitHub fetch can outrun the
  // 3s interaction window, so the whole branch runs behind an ephemeral defer.
  await interaction.deferReply({ ephemeral: true });

  if (!token) {
    if (!existing) {
      await interaction.editReply(
        `**${repo}** is not tracked here — nothing to clear.`,
      );
      return;
    }
    try {
      updateGithubWatch(communityId, repo, { token: null });
    } catch (err) {
      await interaction.editReply(
        `Could not clear the token for **${repo}**: ${err?.message || err}`,
      );
      return;
    }
    // #443 (audit INT-8): durable admin_audit trail — token actions are
    // recorded as EVENTS ONLY; no secret material ever enters the audit (#368).
    recordSlashAudit({
      communityId,
      actorUserId: interaction.user.id,
      action: "github.token_clear",
      targetType: "github_watch",
      targetId: existing.repo,
      details: { repo_display: existing.repo_display },
    });

    await logConfigChange(
      getDiscordOutbound(ctx?.client || interaction.client),
      interaction.guildId,
      {
        title: "GitHub token cleared",
        command: "/github token",
        actor: interaction.user,
        changes: [`Repository: **${existing.repo_display}**`, "Token: *cleared*"],
      },
    ).catch(() => {});
    await interaction.editReply(
      `Token cleared for **${repo}** — release checks fall back to unauthenticated lookups.`,
    );
    return;
  }

  // Key-gone-since-open race: the command pre-checked, the modal may outlive it.
  if (!tokenKeys.hasTokenKey()) {
    await interaction.editReply(
      tokenKeys.keyMissingError("a GitHub token").message,
    );
    return;
  }

  const check = await fetchRepo(repo, token);
  if (!check.ok) {
    await interaction.editReply(
      `GitHub did not accept that token for **${repo}**: ${check.error} — nothing was saved.`,
    );
    return;
  }

  try {
    if (existing) {
      updateGithubWatch(communityId, repo, { token });
    } else {
      addGithubWatch(communityId, repo, check.fullName, { token });
    }
  } catch (err) {
    await interaction.editReply(
      `Could not save the token for **${repo}**: ${err?.message || err}`,
    );
    return;
  }

  // #443 (audit INT-8): durable admin_audit trail; created_watch marks the
  // private-repo bootstrap (the modal minted the watch alongside the token).
  recordSlashAudit({
    communityId,
    actorUserId: interaction.user.id,
    action: "github.token_set",
    targetType: "github_watch",
    targetId: repo,
    details: { repo_display: check.fullName, created_watch: existing ? 0 : 1 },
  });

  await logConfigChange(
    getDiscordOutbound(ctx?.client || interaction.client),
    interaction.guildId,
    {
      title: existing ? "GitHub token updated" : "GitHub watch created with token",
      command: "/github token",
      actor: interaction.user,
      changes: [
        `Repository: **${check.fullName}**`,
        existing
          ? "Token: *updated* (validated)"
          : "Watch created — Token: *set* (validated)",
      ],
    },
  ).catch(() => {});

  let msg = `Token saved for **${check.fullName}** (encrypted at rest, validated against GitHub).`;
  const row = getGithubWatch(communityId, repo);
  if (row && !row.channel_id) {
    msg +=
      "\nThis watch has no notification channel yet — run `/github channel` to pick one.";
  }
  await interaction.editReply(msg);
}

async function handleGithubAutocomplete(interaction) {
  if (!interaction.guild) {
    await interaction.respond([]);
    return;
  }
  const communityId = discordCommunityId(interaction.guild.id);
  if (communityId == null) {
    await interaction.respond([]);
    return;
  }
  const watches = getGithubWatches(communityId);
  const focused = (interaction.options.getFocused() || "").toLowerCase();

  const filtered = watches
    .filter(
      (w) =>
        w.repo.includes(focused) ||
        (w.repo_display || "").toLowerCase().includes(focused),
    )
    .slice(0, 25);

  await interaction.respond(
    filtered.map((w) => ({
      name: w.repo_display,
      value: w.repo,
    })),
  );
}

/**
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {object} [featureCtx]
 */
function start(supervisor, featureCtx) {
  void featureCtx;
  startGithubReleaseTicker(supervisor);
}

module.exports = {
  name: "githubReleases",
  commands,
  handlers: {
    github: handleGithub,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): the slash
  // handler receives a CommandContext. Autocomplete stays on the interaction arm.
  handlerApi: {
    github: "context",
  },
  autocomplete: {
    github: handleGithubAutocomplete,
  },
  // #444: private (modal) token entry — router dispatches modal submits by
  // longest customId prefix.
  modalHandlers: {
    [MODAL_PREFIX_TOKEN]: handleGithubTokenModal,
  },
  // Exported for tests
  buildGithubTokenModal,
  MODAL_PREFIX_TOKEN,
  MODAL_FIELD_TOKEN,
  start,
};
