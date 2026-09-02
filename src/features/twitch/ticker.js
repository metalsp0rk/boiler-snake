const { EmbedBuilder } = require("discord.js");
const { Color } = require("../../core/theme");
const {
  getAllTwitchChannels,
  getGuildSettings,
  addTwitchChannel,
  removeTwitchChannel,
  updateTwitchChannelLiveState,
} = require("../../db");
const { resolveTwitchUser, fetchStreams } = require("./helix");

/** @type {{ resolveUser: Function, fetchStreams: Function }} */
const defaultDeps = { resolveUser: resolveTwitchUser, fetchStreams };

/**
 * Build the go-live embed for a Twitch stream.
 * @param {object} sub stored twitch_channels row
 * @param {object} stream Helix stream object
 */
function createGoLiveEmbed(sub, stream) {
  const displayName = sub.display_name || sub.login;
  const embed = new EmbedBuilder()
    .setColor(Color.twitchLive)
    .setAuthor({
      name: `${displayName} is live!`,
      url: `https://twitch.tv/${sub.login}`,
      iconURL: sub.profile_image_url || undefined,
    })
    .setTitle(stream.title || "Untitled stream")
    .setDescription(`[Watch on Twitch](https://twitch.tv/${sub.login})`)
    .setThumbnail(stream.thumbnail_url || sub.profile_image_url || undefined)
    .setTimestamp(new Date(stream.started_at || Date.now()));

  const fields = [];
  if (stream.game_name) {
    fields.push({ name: "Playing", value: stream.game_name, inline: true });
  }
  if (Number.isFinite(stream.viewer_count)) {
    fields.push({
      name: "Viewers",
      value: String(stream.viewer_count),
      inline: true,
    });
  }
  if (fields.length) embed.addFields(fields);

  embed.setFooter({
    text: "Twitch",
    iconURL: "https://upload.wikimedia.org/wikipedia/commons/9/95/Twitch_logo.png",
  });

  return embed;
}

/**
 * Send the go-live notification for one subscription.
 * @param {import("discord.js").Client} client
 * @param {string} guildId
 * @param {object} sub stored twitch_channels row
 * @param {object} stream Helix stream object
 */
async function sendGoLiveNotification(client, guildId, sub, stream) {
  const settings = getGuildSettings(guildId);
  const notifyChannelId = settings.twitch_notification_channel_id;
  if (!notifyChannelId) {
    console.log(
      `[twitch] No notification channel configured for guild ${guildId}`,
    );
    return;
  }

  const channel = await client.channels.fetch(notifyChannelId).catch(() => null);
  if (!channel) {
    console.error(
      `[twitch] Could not find notification channel ${notifyChannelId}`,
    );
    return;
  }

  const roleName = sub.display_name || sub.login;
  const roleId = settings.twitch_notify_role_id;
  const content = roleId
    ? `<@&${roleId}> **${roleName}** is live!`
    : `**${roleName}** is live!`;

  try {
    await channel.send({
      content,
      embeds: [createGoLiveEmbed(sub, stream)],
      // Only allow the configured role to be pinged (never @everyone/@here).
      allowedMentions: roleId
        ? { parse: ["roles"], roles: [roleId] }
        : { parse: [] },
    });
    console.log(
      `[twitch] Sent go-live notification for ${sub.login} in guild ${guildId}`,
    );
  } catch (err) {
    console.error(
      `[twitch] Failed to send go-live notification for ${sub.login}:`,
      err?.message || err,
    );
  }
}

/**
 * Process one subscription against a stream lookup.
 * @param {import("discord.js").Client} client
 * @param {string} guildId
 * @param {object} sub stored twitch_channels row
 * @param {object|undefined} stream matching Helix stream (if any)
 */
async function processSubscription(client, guildId, sub, stream) {
  const nowMs = Date.now();

  if (stream) {
    const isNewStream =
      !sub.last_stream_id || sub.last_stream_id !== stream.id;
    if (isNewStream) {
      await sendGoLiveNotification(client, guildId, sub, stream);
      updateTwitchChannelLiveState(guildId, sub.broadcaster_id, {
        isLive: true,
        lastStreamId: stream.id,
        lastChecked: nowMs,
      });
    } else {
      updateTwitchChannelLiveState(guildId, sub.broadcaster_id, {
        isLive: true,
        lastStreamId: sub.last_stream_id,
        lastChecked: nowMs,
      });
    }
  } else {
    if (sub.is_live) {
      console.log(`[twitch] ${sub.login} went offline`);
    }
    updateTwitchChannelLiveState(guildId, sub.broadcaster_id, {
      isLive: false,
      lastStreamId: sub.last_stream_id,
      lastChecked: nowMs,
    });
  }
}

/**
 * Resolve any subscriptions that still lack a numeric broadcaster id.
 * Also heals rows created before a broadcaster renamed their login
 * (the unique (guild_id, login) constraint would otherwise leave a
 * stale duplicate row for the same broadcaster).
 * @param {object} [deps]
 */
async function resolvePendingSubscriptions(deps = defaultDeps) {
  const resolveUser = deps.resolveUser || resolveTwitchUser;
  const subs = getAllTwitchChannels();

  for (const sub of subs) {
    if (!/^\d+$/.test(sub.broadcaster_id)) {
      const user = await resolveUser(sub.login);
      if (!user) {
        console.log(`[twitch] Could not resolve login ${sub.login}, skipping`);
        continue;
      }
      addTwitchChannel(
        sub.guild_id,
        user.id,
        user.login,
        user.display_name,
        user.profile_image_url,
      );
      if (sub.login !== user.login) {
        removeTwitchChannel(sub.guild_id, sub.login);
      }
    }
  }

  // Heal renamed logins: same broadcaster_id, different login than stored.
  const all = getAllTwitchChannels();
  const seen = new Map(); // broadcaster_id -> row
  for (const row of all) {
    if (!/^\d+$/.test(row.broadcaster_id)) continue;
    const existing = seen.get(row.broadcaster_id);
    if (existing && existing.login !== row.login) {
      // Keep the row with the current (most recently written) login.
      removeTwitchChannel(row.guild_id, existing.login);
      seen.set(row.broadcaster_id, row);
    } else if (!existing) {
      seen.set(row.broadcaster_id, row);
    }
  }
}

/**
 * One polling pass across all guilds/subscriptions.
 * @param {import("discord.js").Client} client
 * @param {object} [deps]
 */
async function runTwitchTick(client, deps = defaultDeps) {
  const resolveUser = deps.resolveUser || resolveTwitchUser;
  const fetch = deps.fetchStreams || fetchStreams;

  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    return;
  }

  await resolvePendingSubscriptions(deps);

  // Honor each guild's polling interval: skip subscriptions that were
  // checked more recently than the guild's configured interval.
  const nowMs = Date.now();
  const all = getAllTwitchChannels().filter((s) => {
    if (!/^\d+$/.test(s.broadcaster_id)) return false;
    const settings = getGuildSettings(s.guild_id);
    const intervalMs =
      (Number(settings.twitch_polling_interval_minutes) || 2) * 60_000;
    // Never re-check a row that was checked less than a minute ago
    // (the base poll cadence), and honor the guild interval on top.
    if (s.last_checked && nowMs - s.last_checked < Math.max(60_000, intervalMs)) {
      return false;
    }
    return true;
  });
  if (!all.length) return;
  const uniqueIds = [...new Set(all.map((s) => s.broadcaster_id))];

  // Batched Helix /streams lookup (max 100 ids per request).
  const streams = [];
  let fetchOk = true;
  for (let i = 0; i < uniqueIds.length; i += 100) {
    const batch = uniqueIds.slice(i, i + 100);
    const result = await fetch(batch);
    if (result == null) {
      fetchOk = false;
      break;
    }
    streams.push(...result);
  }

  // On a failed/aborted fetch, keep prior live state so a transient API
  // error does not clear is_live and cause a duplicate go-live next tick.
  const fetchFailed = !fetchOk;
  const byUserId = fetchFailed
    ? null
    : new Map(streams.map((s) => [s.user_id, s]));

  for (const sub of all) {
    try {
      if (fetchFailed) {
        console.log(
          `[twitch] Stream fetch failed; skipping state updates for ${sub.login}`,
        );
        continue;
      }
      await processSubscription(
        client,
        sub.guild_id,
        sub,
        byUserId.get(sub.broadcaster_id),
      );
    } catch (err) {
      console.error(
        `[twitch] Error processing ${sub.login} (guild ${sub.guild_id}):`,
        err?.message || err,
      );
    }
  }
}

let ticking = false;

/**
 * Start the Twitch polling ticker (aligned to minute boundaries).
 * @param {import("discord.js").Client} client
 */
function startTwitchTicker(client) {
  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    console.log(
      "[twitch] Skipping ticker startup - TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not configured",
    );
    return;
  }

  const tick = () => {
    if (ticking) {
      console.log("[twitch] Previous tick still running; skipping");
      return;
    }
    ticking = true;
    runTwitchTick(client)
      .catch((err) =>
        console.error("[twitch] Tick failed:", err?.message || err),
      )
      .finally(() => {
        ticking = false;
      });
  };

  const msToNextMinute = 60_000 - (Date.now() % 60_000);

  tick();

  setTimeout(() => {
    tick();
    setInterval(tick, 60_000);
  }, msToNextMinute);
}

module.exports = {
  startTwitchTicker,
  runTwitchTick,
  resolvePendingSubscriptions,
  processSubscription,
  sendGoLiveNotification,
  createGoLiveEmbed,
  defaultDeps,
};
