/**
 * Now-playing / queue embeds and control buttons.
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { Color } = require("../../core/theme");
const { formatDuration } = require("./resolve");

/** Spotify green — catalog branding, not a claim of Spotify audio. */
const COLOR = Color.music;

const BTN = {
  pause: "music:pause",
  skip: "music:skip",
  stop: "music:stop",
};

/**
 * @param {object|null} track
 * @returns {string}
 */
function trackTitle(track) {
  return track?.info?.title || "Unknown track";
}

/**
 * @param {object|null} track
 * @returns {string}
 */
function trackAuthor(track) {
  return track?.info?.author || "Unknown";
}

/**
 * @param {object|null} track
 * @returns {string}
 */
function sourceBadge(track) {
  const src = String(track?.info?.sourceName || "").toLowerCase();
  if (src === "spotify") return "Spotify → YouTube Music";
  if (src === "youtube" || src === "youtubemusic") return "YouTube";
  if (src === "soundcloud") return "SoundCloud";
  if (src === "http" || src === "https") return "Direct URL";
  return src ? src : "Unknown source";
}

/**
 * @param {object} player
 * @returns {EmbedBuilder}
 */
function nowPlayingEmbed(player) {
  const track = player?.queue?.current;
  const embed = new EmbedBuilder().setColor(COLOR);
  if (!track) {
    return embed.setTitle("Nothing is playing").setDescription("Queue is empty.");
  }
  const requester = track.requester?.id
    ? `<@${track.requester.id}>`
    : "Unknown";
  embed
    .setTitle(trackTitle(track))
    .setURL(track.info?.uri || null)
    .setDescription(`by **${trackAuthor(track)}**`)
    .addFields(
      {
        name: "Duration",
        value: track.info?.isStream
          ? "Live"
          : formatDuration(track.info?.duration ?? 0),
        inline: true,
      },
      { name: "Source", value: sourceBadge(track), inline: true },
      { name: "Requested by", value: requester, inline: true }
    );
  if (track.info?.artworkUrl) {
    embed.setThumbnail(track.info.artworkUrl);
  }
  if (player.paused) embed.setFooter({ text: "Paused" });
  return embed;
}

/**
 * @param {object} player
 * @param {{ limit?: number }} [opts]
 * @returns {EmbedBuilder}
 */
function queueEmbed(player, opts = {}) {
  const limit = opts.limit || 10;
  const current = player?.queue?.current;
  const upcoming = player?.queue?.tracks || [];
  const embed = new EmbedBuilder().setColor(COLOR).setTitle("Queue");

  const lines = [];
  if (current) {
    lines.push(
      `**Now:** ${trackTitle(current)} — ${trackAuthor(current)} (${
        current.info?.isStream
          ? "live"
          : formatDuration(current.info?.duration ?? 0)
      })`
    );
  } else {
    lines.push("Nothing is playing.");
  }

  if (upcoming.length) {
    const slice = upcoming.slice(0, limit);
    slice.forEach((t, i) => {
      lines.push(
        `\`${i + 1}.\` ${trackTitle(t)} — ${trackAuthor(t)} (${formatDuration(
          t.info?.duration ?? 0
        )})`
      );
    });
    if (upcoming.length > limit) {
      lines.push(`…and **${upcoming.length - limit}** more`);
    }
  } else {
    lines.push("_No upcoming tracks._");
  }

  embed.setDescription(lines.join("\n"));
  embed.setFooter({
    text: `${upcoming.length} in queue · volume ${player?.volume ?? 80}%`,
  });
  return embed;
}

/**
 * @param {boolean} paused
 * @returns {ActionRowBuilder}
 */
function controlRow(paused) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN.pause)
      .setLabel(paused ? "Resume" : "Pause")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN.skip)
      .setLabel("Skip")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(BTN.stop)
      .setLabel("Stop")
      .setStyle(ButtonStyle.Danger)
  );
}

module.exports = {
  COLOR,
  BTN,
  trackTitle,
  trackAuthor,
  sourceBadge,
  nowPlayingEmbed,
  queueEmbed,
  controlRow,
};
