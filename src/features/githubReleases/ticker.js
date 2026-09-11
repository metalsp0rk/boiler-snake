const { EmbedBuilder } = require("discord.js");
const { Color } = require("../../core/theme");
const {
  getAllGithubWatches,
  updateGithubWatchReleaseState,
} = require("../../db");
const { fetchReleases } = require("./github");

/** @type {{ fetchReleases: Function }} */
const defaultDeps = { fetchReleases };

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
 * @param {import("discord.js").Client} client
 * @param {object} watch stored github_watches row
 * @param {object} release normalized release
 */
async function sendReleaseNotification(client, watch, release) {
  const channel = await client.channels
    .fetch(watch.channel_id)
    .catch(() => null);
  if (!channel) {
    console.error(
      `[github] Could not find release channel ${watch.channel_id} for ${watch.repo} (guild ${watch.guild_id})`,
    );
    return false;
  }

  const roleId = watch.role_id;
  const label = watch.repo_display || watch.repo;
  const content = roleId
    ? `<@&${roleId}> **${label}** released **${release.name || release.tag}**`
    : null;

  try {
    await channel.send({
      content,
      embeds: [createReleaseEmbed(watch, release)],
      // Only allow the configured role to be pinged (never @everyone/@here).
      allowedMentions: roleId
        ? { parse: ["roles"], roles: [roleId] }
        : { parse: [] },
    });
    console.log(
      `[github] Sent release notification for ${watch.repo} ${release.tag} in guild ${watch.guild_id}`,
    );
    return true;
  } catch (err) {
    console.error(
      `[github] Failed to send release notification for ${watch.repo} ${release.tag} (guild ${watch.guild_id}):`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * Process one watch: probe GitHub, announce anything newer than the stored
 * pointer (oldest-first), advance the pointer only past delivered releases.
 * @param {import("discord.js").Client} client
 * @param {object} watch stored github_watches row
 * @param {object} [deps]
 * @returns {Promise<{ok:boolean, announced?:number, skipped?:string, error?:string}>}
 */
async function processWatch(client, watch, deps = defaultDeps) {
  if (!watch.channel_id) {
    console.log(
      `[github] Watch ${watch.repo} in guild ${watch.guild_id} has no channel configured; run /github channel`,
    );
    return { ok: false, skipped: "no channel configured (use /github channel)" };
  }

  const fetch = deps.fetchReleases || fetchReleases;
  const result = await fetch(watch.repo, watch.token || null);
  if (!result.ok) {
    console.error(
      `[github] Release lookup failed for ${watch.repo} (guild ${watch.guild_id}): ${result.error}`,
    );
    return { ok: false, error: result.error };
  }

  const pending = pickNewReleases(watch, result.releases);
  let newest = null;
  let announced = 0;
  let sendFailed = false;
  for (const release of pending) {
    const sent = await sendReleaseNotification(client, watch, release);
    if (!sent) {
      sendFailed = true;
      break; // keep the pointer; retry the rest next hour
    }
    newest = release;
    announced += 1;
  }

  updateGithubWatchReleaseState(watch.guild_id, watch.repo, {
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
 * @param {import("discord.js").Client} client
 * @param {object} [deps]
 */
async function runGithubReleaseTick(client, deps = defaultDeps) {
  const watches = getAllGithubWatches();
  for (const watch of watches) {
    try {
      await processWatch(client, watch, deps);
    } catch (err) {
      console.error(
        `[github] Error processing watch ${watch.repo} (guild ${watch.guild_id}):`,
        err?.message || err,
      );
    }
  }
}

let ticking = false;

/**
 * Start the hourly GitHub release ticker (aligned to hour boundaries).
 * @param {import("discord.js").Client} client
 */
function startGithubReleaseTicker(client) {
  const tick = () => {
    if (ticking) {
      console.log("[github] Previous tick still running; skipping");
      return;
    }
    ticking = true;
    runGithubReleaseTick(client)
      .catch((err) =>
        console.error("[github] Tick failed:", err?.message || err),
      )
      .finally(() => {
        ticking = false;
      });
  };

  const msToNextHour = 3_600_000 - (Date.now() % 3_600_000);

  tick();

  setTimeout(() => {
    tick();
    setInterval(tick, 3_600_000);
  }, msToNextHour);
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
