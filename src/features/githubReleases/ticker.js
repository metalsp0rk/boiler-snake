const { EmbedBuilder } = require("discord.js");
const { toPlainEmbed } = require("../../core/embeds"); // #470 (H1-7): shared copy
const { Color } = require("../../core/theme");
const { registerJob } = require("../../core/scheduler");
const {
  getAllGithubWatches,
  updateGithubWatchReleaseState,
  updateGithubWatch,
  bumpGithubNotifyFailures,
  resetGithubNotifyFailures,
} = require("../../db");
const { recordSystemAudit } = require("../../core/auditTrail");
const {
  isGoneDeliveryError,
  describeGoneDeliveryError,
} = require("../../core/goneDelivery");
const { fetchReleases } = require("./github");

/**
 * #827 — mirror of the youtube valve: consecutive-failure ceiling per
 * WATCH ROW. After this many consecutive failed deliveries of the same
 * head release, the poison release is skipped (pointer advanced past it,
 * named warning + audit row) so one rejected release cannot freeze the
 * watch forever.
 */
const MAX_NOTIFY_DELIVERY_FAILURES = 10;

const {
  resolveOutbound: coreResolveOutbound,
} = require("../../core/outbound");

function resolveOutbound(supervisor, communityId) {
  return coreResolveOutbound(supervisor, communityId, { label: "github" });
}

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
      // Strict role allow-list (#272, docs-verified): `{ roles: [id] }`
      // WITHOUT `parse` pins the ping to the configured role — smuggled role
      // tokens in release names/bodies stay plain text. `{parse:["roles"],
      // roles:…}` is invalid per the live Discord docs (parse is mutually
      // exclusive with the id lists). Precedent: eventReminders/service.js.
      allowedMentions: roleId ? { roles: [roleId] } : { parse: [] },
    });
    if (!result || result.ok !== true) {
      const error = result?.error || "no ready client";
      console.error(
        `[github] Failed to send release notification for ${watch.repo} ${release.tag} (community ${watch.community_id}): ${error}`,
      );
      return { ok: false, error };
    }
    console.log(
      `[github] Sent release notification for ${watch.repo} ${release.tag} in community ${watch.community_id}`,
    );
    return { ok: true };
  } catch (err) {
    const error = err?.message || String(err);
    console.error(
      `[github] Failed to send release notification for ${watch.repo} ${release.tag} (community ${watch.community_id}):`,
      error,
    );
    return { ok: false, error };
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
  let lastError = null;
  for (const release of pending) {
    const sent = await sendReleaseNotification(outbound, watch, release);
    if (!sent || sent.ok !== true) {
      const cause = sent?.error || "no ready client";
      sendFailed = true;
      lastError = cause;

      // VALVE B — GONE destination (10003/10004): the announcement channel
      // is gone (or the bot lost the guild). Clear THIS ROW's channel_id
      // (loud, audited), keep the release pointer: pending releases stay
      // queued and resume when staff reconfigure via /github (#827).
      if (isGoneDeliveryError(cause)) {
        const named = describeGoneDeliveryError(cause);
        updateGithubWatch(watch.community_id, watch.repo, { channelId: null });
        console.error(
          `[github] ${watch.repo} (community ${watch.community_id}): announcement channel is GONE (${named}) — row channel cleared; releases stay queued until /github sets a channel again`,
        );
        try {
          recordSystemAudit({
            communityId: watch.community_id,
            action: "github.notify_channel_cleared",
            targetType: "repo",
            targetId: watch.repo,
            details: {
              reason: named,
              failed_release_tag: release.tag,
            },
          });
        } catch (err) {
          console.error(
            `[github] gone-clear audit failed (${watch.repo}, community ${watch.community_id}): ${err?.message || err}`,
          );
        }
        break;
      }

      // VALVE A — attempt cap (mirror of the youtube ticker): at the
      // ceiling skip the poison release (pointer advances past it) with a
      // named warning + audit, and KEEP GOING so the line moves.
      const fails = bumpGithubNotifyFailures(
        watch.community_id,
        watch.repo,
      );
      if (fails >= MAX_NOTIFY_DELIVERY_FAILURES) {
        console.error(
          `[github] POISON SKIP ${watch.repo} (community ${watch.community_id}): release ${release.tag} failed ${fails} consecutive attempts (${cause}) — advancing pointer past it`,
        );
        try {
          recordSystemAudit({
            communityId: watch.community_id,
            action: "github.notify_poison_skip",
            targetType: "repo",
            targetId: watch.repo,
            details: {
              release_tag: release.tag,
              attempts: fails,
              last_error: cause,
            },
          });
        } catch (err) {
          console.error(
            `[github] poison-skip audit failed (${watch.repo}, community ${watch.community_id}): ${err?.message || err}`,
          );
        }
        newest = release; // pointer moves past the skipped poison item
        resetGithubNotifyFailures(watch.community_id, watch.repo);
        continue;
      }

      console.error(
        `[github] ${watch.repo}: release notification failed (attempt ${fails}/${MAX_NOTIFY_DELIVERY_FAILURES}) — pointer kept, pending releases retry next hour`,
      );
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

  // A delivered announcement ends the consecutive-failure streak (#827).
  if (announced > 0) {
    resetGithubNotifyFailures(watch.community_id, watch.repo);
  }

  return {
    ok: !sendFailed,
    announced,
    ...(sendFailed
      ? {
          error: lastError
            ? `could not deliver one release post: ${lastError}`
            : "could not deliver one release post (see bot logs)",
        }
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
  MAX_NOTIFY_DELIVERY_FAILURES,
};
