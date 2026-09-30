const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const {
  getGithubWatches,
  getAllGithubWatches,
  getGithubWatch,
  addGithubWatch,
  removeGithubWatch,
  updateGithubWatch,
  normalizeGithubRepo,
} = require("../../db");
const { requireStaffFromContext } = require("../../core/permissions");
const { logConfigChange } = require("../logs/auditLog");
const { discordCommunityId } = require("../../platform/community");
const { fetchRepo } = require("./github");
const { processWatch, startGithubReleaseTicker } = require("./ticker");

const staffPerms = PermissionFlagsBits.ManageGuild;

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
        )
        .addStringOption((opt) =>
          opt
            .setName("token")
            .setDescription(
              "Optional GitHub token (private repo / higher rate limit)",
            )
            .setRequired(false),
        ),
    )
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
    const token = commandCtx.options.getString("token", false);

    await commandCtx.defer({ sensitive: true });

    const existing = getGithubWatch(communityId, repo);
    const check = await fetchRepo(repo, token || null);
    if (!check.ok) {
      await commandCtx.editReply(
        `Could not track **${repo}**: ${check.error}`,
      );
      return;
    }

    const row = addGithubWatch(communityId, repo, check.fullName, {
      channelId: channel ? channel.id : null,
      token: token || null,
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
        token ? "Token: *updated*" : "Token: unchanged",
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
    await commandCtx.editReply(replyMsg);
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

function start(client) {
  startGithubReleaseTicker(client);
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
  start,
};
