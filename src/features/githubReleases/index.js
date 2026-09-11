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
const { isStaff } = require("../../core/permissions");
const { replyDenied, replyEphemeral } = require("../../core/interaction");
const { logConfigChange } = require("../logs/auditLog");
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

async function handleGithub(interaction, ctx) {
  const { client } = ctx;
  const guildId = interaction.guildId;

  if (!isStaff(interaction)) {
    await replyDenied(interaction);
    return;
  }

  const sub = interaction.options.getSubcommand();

  if (sub === "watch") {
    const raw = interaction.options.getString("repo", true);
    const repo = normalizeGithubRepo(raw);
    if (!repo) {
      await replyEphemeral(interaction, {
        content: `\`${raw}\` is not a repository reference. Use \`owner/name\` or a GitHub URL.`,
      });
      return;
    }
    const channel = interaction.options.getChannel("channel", false);
    const token = interaction.options.getString("token", false);

    await interaction.deferReply({ flags: 64 });

    const existing = getGithubWatch(guildId, repo);
    const check = await fetchRepo(repo, token || null);
    if (!check.ok) {
      await interaction.editReply(
        `Could not track **${repo}**: ${check.error}`,
      );
      return;
    }

    const row = addGithubWatch(guildId, repo, check.fullName, {
      channelId: channel ? channel.id : null,
      token: token || null,
    });

    await logConfigChange(client, guildId, {
      title: existing
        ? "GitHub watch updated"
        : "GitHub repository watched",
      command: "/github watch",
      actor: interaction.user,
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
    await interaction.editReply(replyMsg);
    return;
  }

  if (sub === "remove") {
    const raw = interaction.options.getString("repo", true);
    const found = getGithubWatch(guildId, raw);
    if (!found) {
      await replyEphemeral(interaction, {
        content: `**${raw}** is not tracked in this server.`,
      });
      return;
    }

    removeGithubWatch(guildId, found.repo);
    await logConfigChange(client, guildId, {
      title: "GitHub watch removed",
      command: "/github remove",
      actor: interaction.user,
      changes: [`Repository: **${found.repo_display}**`],
    }).catch(() => {});

    await replyEphemeral(interaction, {
      content: `Stopped tracking **${found.repo_display}**.`,
    });
    return;
  }

  if (sub === "list") {
    const watches = getGithubWatches(guildId);
    if (!watches.length) {
      await replyEphemeral(interaction, {
        content:
          "No GitHub repositories tracked. Add one with `/github watch`.",
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

    await replyEphemeral(interaction, {
      content: `**GitHub release watches** (${watches.length})\n${lines.join("\n")}`,
    });
    return;
  }

  if (sub === "channel") {
    const raw = interaction.options.getString("repo", true);
    const found = getGithubWatch(guildId, raw);
    if (!found) {
      await replyEphemeral(interaction, {
        content: `**${raw}** is not tracked here. Add it with \`/github watch\` first.`,
      });
      return;
    }
    const ch = interaction.options.getChannel("channel", true);
    updateGithubWatch(guildId, found.repo, { channelId: ch.id });
    await logConfigChange(client, guildId, {
      title: "GitHub watch channel set",
      command: "/github channel",
      actor: interaction.user,
      changes: [
        `Repository: **${found.repo_display}**`,
        found.channel_id
          ? `Channel: <#${found.channel_id}> → <#${ch.id}>`
          : `Channel: *none* → <#${ch.id}>`,
      ],
    }).catch(() => {});

    await replyEphemeral(interaction, {
      content: `Release notes for **${found.repo_display}** will be sent to <#${ch.id}>.`,
    });
    return;
  }

  if (sub === "role") {
    const raw = interaction.options.getString("repo", true);
    const found = getGithubWatch(guildId, raw);
    if (!found) {
      await replyEphemeral(interaction, {
        content: `**${raw}** is not tracked here. Add it with \`/github watch\` first.`,
      });
      return;
    }
    const role = interaction.options.getRole("role", false);
    updateGithubWatch(guildId, found.repo, {
      roleId: role ? role.id : null,
    });
    const beforeLabel = found.role_id ? `<@&${found.role_id}>` : "*none*";
    const afterLabel = role ? `<@&${role.id}>` : "*none*";
    await logConfigChange(client, guildId, {
      title: "GitHub watch ping role set",
      command: "/github role",
      actor: interaction.user,
      changes: [
        `Repository: **${found.repo_display}**`,
        `Role: ${beforeLabel} → ${afterLabel}`,
      ],
    }).catch(() => {});

    await replyEphemeral(interaction, {
      content: role
        ? `Release posts for **${found.repo_display}** will mention <@&${role.id}>.`
        : `Release posts for **${found.repo_display}** will no longer mention a role.`,
    });
    return;
  }

  if (sub === "check") {
    const raw = interaction.options.getString("repo", false);
    let targets;
    if (raw) {
      const found = getGithubWatch(guildId, raw);
      if (!found) {
        await replyEphemeral(interaction, {
          content: `**${raw}** is not tracked here. Add it with \`/github watch\` first.`,
        });
        return;
      }
      targets = [found];
    } else {
      targets = getGithubWatches(guildId);
      if (!targets.length) {
        await replyEphemeral(interaction, {
          content: "No GitHub repositories tracked. Add one with `/github watch`.",
        });
        return;
      }
    }

    await interaction.deferReply({ flags: 64 });

    // Rows from getGithubWatches omit the token; use full rows for the probe.
    const full = new Map(
      getAllGithubWatches()
        .filter((w) => w.guild_id === guildId)
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
    await interaction.editReply(msg);
    return;
  }
}

async function handleGithubAutocomplete(interaction) {
  if (!interaction.guild) {
    await interaction.respond([]);
    return;
  }
  const watches = getGithubWatches(interaction.guild.id);
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
  autocomplete: {
    github: handleGithubAutocomplete,
  },
  start,
};
