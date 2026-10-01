const { EmbedBuilder } = require("discord.js");
const { Color } = require("../../core/theme");
const { registerJob } = require("../../core/scheduler");
const {
  getAllGithubWatches,
  updateGithubWatchReleaseState,
} = require("../../db");
const { fetchReleases } = require("./github");
const { getDiscordOutbound } = require("../../platform/discord/outbound");

/** @type {{ fetchReleases: Function }} */
const defaultDeps = { fetchReleases };

/**
 * Resolve the OutboundClient for one watch row (roadmap/fluxer.md § Scheduler
 * jobs: watch row's clientForCommunity). Accepts the PR 7 supervisor, a raw
 * OutboundClient, or a legacy raw discord.js client. Null = no ready client.
 *
 * @param {object|null} supervisor
 * @param {number} communityId
 * @returns {object|null} OutboundClient
 */
function resolveOutbound(supervisor, communityId) {
  if (!supervisor) return null;
  if (typeof supervisor.clientForCommunity === "function") {
    try {
      return supervisor.clientForCommunity(communityId) ?? null;
    } catch (err) {
      console.error(
        `[github] clientForCommunity(${communityId}) threw: ${err?.message || err}`,
      );
      return null;
    }
  }
  if (typeof supervisor.sendChannel === "function") return supervisor;
  if (supervisor.guilds || supervisor.channels || supervisor.users) {
    // Legacy raw discord.js client (pre-PR 7 call site).
    try {
      return getDiscordOutbound(supervisor);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * NormalizedEmbed plain JSON at the send boundary (spec § Embeds and
 * attachments). EmbedBuilder instances flatten via toJSON(); visible content
 * is byte-identical.
 * @param {object} embed
 * @returns {object}
 */
function toPlainEmbed(embed) {
  return embed && typeof embed.toJSON === "function" ? embed.toJSON() : embed;
}

const EMBED_DESCRIPTION_LIMIT = 4096;
const DESCRIPTION_BUDGET = 3800;
const TITLE_LIMIT = 256;
const TITLE_BUDGET = 240;

/**
 * Pick the releases to announce, oldest-first (send order).
 * - First check for a watch (no pointer yet): announce only the newest
 *   release so a fresh watch shows the current release, not the whole history.
 * - Otherwise: every release with an id greater than the stored pointer
 *   (release ids are globally auto-incremented, so this also catches releases
 *   published for older tags), newest ones last.
 * @param {object} watch stored github_watches row
 * @param {object[]} releases newest-first (from fetchReleases)
 * @returns {object[]} releases to send, oldest-first
 */
function pickNewReleases(watch, releases) {
  if (!releases.length) return [];
  if (watch.last_release_id == null) {
    return [releases[0]];
  }
  const sinceId = Number(watch.last_release_id);
  return releases
    .filter((r) => Number(r.id) > sinceId)
    .slice()
    .reverse();
}

/**
 * Truncate long text for embed fields with a "read more" link.
 * @param {string|null|undefined} text
 * @param {string} url
 */
function truncateReleaseNotes(text, url) {
  const body = String(text || "").trim();
  if (!body) return "_No release notes were provided._";
  if (body.length <= DESCRIPTION_BUDGET) return body;
  const cut = body.slice(0, DESCRIPTION_BUDGET);
  const boundary = Math.max(
    cut.lastIndexOf("\n"),
    cut.lastIndexOf(". "),
  );
  const clean = boundary > DESCRIPTION_BUDGET * 0.8 ? cut.slice(0, boundary + 1) : cut;
  return `${clean.trimEnd()}\n\n[Read the full release notes on GitHub](${url})`;
}

function truncateTitle(title) {
  const t = String(title || "").trim() || "Untitled release";
  return t.length <= TITLE_LIMIT ? t : `${t.slice(0, TITLE_BUDGET).trimEnd()}…`;
}

/**
 * Build the release announcement embed.
 * @param {object} watch stored github_watches row
 * @param {object} release normalized release (from fetchReleases)
 */
function createReleaseEmbed(watch, release) {
  const repoLabel = watch.repo_display || watch.repo;
  const embed = new EmbedBuilder()
    .setColor(Color.githubRelease)
    .setAuthor({
      name: repoLabel,
      url: `https://github.com/${watch.repo}`,
    })
    .setTitle(
      `${release.prerelease ? "🧪 Pre-release: " : "📦 "}${truncateTitle(release.name || release.tag)}`,
    )
    .setURL(release.htmlUrl)
    .setDescription(truncateReleaseNotes(release.body, release.htmlUrl))
    .setFooter({ text: "GitHub" });

  const fields = [];
  if (release.tag) {
    fields.push({ name: "Tag", value: `\`${release.tag}\``, inline: true });
  }
  if (release.author) {
    fields.push({ name: "Published by", value: release.author, inline: true });
  }
  if (fields.length) embed.addFields(fields);
  if (release.publishedAtMs) embed.setTimestamp(new Date(release.publishedAtMs));

  return embed;
}

/**
 * Send one release announcement. Returns false when the message could not
 * be delivered (the release pointer is only advanced on delivery success).
 * @param {object} outbound OutboundClient for the watch's community (spec 578)
 * @param {object} watch stored github_watches row
 * @param {object} release normalized release
 */
async function sendReleaseNotification(outbound, watch, release) {
  const roleId = watch.role_id;
  const label = watch.repo_display || watch.repo;
  const content = roleId
    ? `<@&${roleId}> **${label}** released **${release.name || release.tag}**`
    : null;

  try {
    // OutboundClient.sendChannel replaces client.channels.fetch + channel.send.
    const result = await outbound.sendChannel(watch.channel_id, {
      content,
      embeds: [toPlainEmbed(createReleaseEmbed(watch, release))],
      // Only allow the configured role to be pinged (never @everyone/@here).
      allowedMentions: roleId
        ? { parse: ["roles"], roles: [roleId] }
        : { parse: [] },
    });
    if (!result || result.ok !== true) {
      console.error(
        `[github] Failed to send release notification for ${watch.repo} ${release.tag} (community ${watch.community_id}): ${
          result?.error || "no ready client"
        }`,
      );
      return false;
    }
    console.log(
      `[github] Sent release notification for ${watch.repo} ${release.tag} in community ${watch.community_id}`,
    );
    return true;
  } catch (err) {
    console.error(
      `[github] Failed to send release notification for ${watch.repo} ${release.tag} (community ${watch.community_id}):`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * Process one watch: probe GitHub, announce anything newer than the stored
 * pointer (oldest-first), advance the pointer only past delivered releases.
 * @param {object|null} supervisor PR 7 supervisor (raw client accepted)
 * @param {object} watch stored github_watches row
 * @param {object} [deps]
 * @returns {Promise<{ok:boolean, announced?:number, skipped?:string, error?:string}>}
 */
async function processWatch(supervisor, watch, deps = defaultDeps) {
  if (!watch.channel_id) {
    console.log(
      `[github] Watch ${watch.repo} in community ${watch.community_id} has no channel configured; run /github channel`,
    );
    return { ok: false, skipped: "no channel configured (use /github channel)" };
  }

  // Per-row routing (spec 578): missing client → log and skip the row.
  const outbound = resolveOutbound(supervisor, watch.community_id);
  if (!outbound) {
    console.warn(
      `[github] no ready client for community ${watch.community_id} — skipping ${watch.repo}`,
    );
    return {
      ok: false,
      skipped: `no ready client for community ${watch.community_id}`,
    };
  }

  const fetch = deps.fetchReleases || fetchReleases;
  const result = await fetch(watch.repo, watch.token || null);
  if (!result.ok) {
    console.error(
      `[github] Release lookup failed for ${watch.repo} (community ${watch.community_id}): ${result.error}`,
    );
    return { ok: false, error: result.error };
  }

  const pending = pickNewReleases(watch, result.releases);
  let newest = null;
  let announced = 0;
  let sendFailed = false;
  for (const release of pending) {
    const sent = await sendReleaseNotification(outbound, watch, release);
    if (!sent) {
      sendFailed = true;
      break; // keep the pointer; retry the rest next hour
    }
    newest = release;
    announced += 1;
  }

  updateGithubWatchReleaseState(watch.community_id, watch.repo, {
    lastReleaseId: newest ? newest.id : watch.last_release_id,
    lastReleasePublishedAt: newest
      ? newest.publishedAtMs
      : watch.last_release_published_at,
    lastChecked: Date.now(),
  });

  return {
    ok: !sendFailed,
    announced,
    ...(sendFailed
      ? { error: "could not deliver one release post (see bot logs)" }
      : {}),
  };
}

/**
 * One polling pass across all guilds/watches.
 * @param {object|null} supervisor PR 7 supervisor ({discord, fluxer, clientForCommunity})
 * @param {object} [deps]
 */
async function runGithubReleaseTick(supervisor, deps = defaultDeps) {
  const watches = getAllGithubWatches();
  for (const watch of watches) {
    try {
      // processWatch resolves supervisor.clientForCommunity(watch.community_id)
      // per row and logs-and-skips rows whose client is not ready (spec 578).
      await processWatch(supervisor, watch, deps);
    } catch (err) {
      console.error(
        `[github] Error processing watch ${watch.repo} (community ${watch.community_id}):`,
        err?.message || err,
      );
    }
  }
}

/**
 * Start the hourly GitHub release ticker (aligned to hour boundaries).
 * @param {object|null} supervisor PR 7 supervisor
 */
function startGithubReleaseTicker(supervisor) {
  registerJob({
    name: "githubReleases",
    intervalMs: 3_600_000,
    align: true,
    runImmediately: true,
    run: () => runGithubReleaseTick(supervisor),
  });
}

module.exports = {
  startGithubReleaseTicker,
  runGithubReleaseTick,
  processWatch,
  pickNewReleases,
  sendReleaseNotification,
  createReleaseEmbed,
  truncateReleaseNotes,
  defaultDeps,
};
