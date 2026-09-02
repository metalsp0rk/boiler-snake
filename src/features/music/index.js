/**
 * Music player — Lavalink voice streaming with Spotify as a catalog.
 *
 * Slash: /play, /music skip|pause|resume|stop|leave|queue|nowplaying|volume|shuffle|remove|seek
 * Buttons: music:pause · music:skip · music:stop
 */

const { SlashCommandBuilder, Events } = require("discord.js");
const { replyOrFollowUpEphemeral } = require("../../core/interaction");
const {
  tryCreateManager,
  getManager,
  isNodeReady,
  setManagerForTests,
} = require("./lavalink");
const {
  requireReady,
  requireSameVoice,
  getPlayer,
  playQuery,
  skipCurrent,
  pauseToggle,
  setVolume,
  shuffleQueue,
  removeAt,
  seekTo,
  destroyPlayer,
  onVoiceStateUpdate,
  errorMessage,
  queuedSummary,
} = require("./player");
const { parseTimestamp, formatDuration } = require("./resolve");
const {
  nowPlayingEmbed,
  queueEmbed,
  controlRow,
  BTN,
} = require("./render");

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play a song (Spotify / YouTube / SoundCloud URL or search).")
    .addStringOption((opt) =>
      opt
        .setName("query")
        .setDescription("Song name, or a Spotify / YouTube / SoundCloud URL")
        .setRequired(true)
        .setMaxLength(500)
    ),

  new SlashCommandBuilder()
    .setName("music")
    .setDescription("Control the music player.")
    .addSubcommand((sc) => sc.setName("skip").setDescription("Skip the current track."))
    .addSubcommand((sc) => sc.setName("pause").setDescription("Pause playback."))
    .addSubcommand((sc) => sc.setName("resume").setDescription("Resume playback."))
    .addSubcommand((sc) => sc.setName("stop").setDescription("Stop playback, clear the queue, and leave."))
    .addSubcommand((sc) => sc.setName("leave").setDescription("Leave the voice channel."))
    .addSubcommand((sc) => sc.setName("queue").setDescription("Show the upcoming queue."))
    .addSubcommand((sc) =>
      sc.setName("nowplaying").setDescription("Show the currently playing track.")
    )
    .addSubcommand((sc) =>
      sc
        .setName("volume")
        .setDescription("Set playback volume (0–100).")
        .addIntegerOption((opt) =>
          opt
            .setName("level")
            .setDescription("Volume percent")
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(100)
        )
    )
    .addSubcommand((sc) => sc.setName("shuffle").setDescription("Shuffle the remaining queue."))
    .addSubcommand((sc) =>
      sc
        .setName("remove")
        .setDescription("Remove a track from the queue by position.")
        .addIntegerOption((opt) =>
          opt
            .setName("position")
            .setDescription("1-based queue position")
            .setRequired(true)
            .setMinValue(1)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("seek")
        .setDescription("Seek in the current track.")
        .addStringOption((opt) =>
          opt
            .setName("timestamp")
            .setDescription("Time like 1:23 or seconds (90)")
            .setRequired(true)
        )
    ),
];

async function replyEphemeral(interaction, contentOrOptions) {
  return replyOrFollowUpEphemeral(interaction, contentOrOptions);
}

async function replyPublic(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload);
  }
  return interaction.reply(payload);
}

function withPlayer(interaction, client, { mustHaveCurrent = false } = {}) {
  const ready = requireReady(client);
  if (!ready.ok) return ready;
  const player = getPlayer(ready.manager, interaction.guildId);
  if (!player || (mustHaveCurrent && !player.queue?.current && !player.playing)) {
    return { ok: false, error: "no_player" };
  }
  const voice = requireSameVoice(interaction, player);
  if (!voice.ok) return voice;
  return { ok: true, manager: ready.manager, player };
}

async function handlePlay(interaction, ctx) {
  const query = interaction.options.getString("query", true);
  const gate = requireReady(ctx.client);
  if (!gate.ok) {
    await replyEphemeral(interaction, errorMessage(gate.error));
    return;
  }
  const existing = getPlayer(gate.manager, interaction.guildId);
  const voice = requireSameVoice(interaction, existing);
  if (!voice.ok) {
    await replyEphemeral(interaction, errorMessage(voice.error));
    return;
  }

  await interaction.deferReply();
  const result = await playQuery(ctx.client, interaction, query);
  if (!result.ok) {
    await replyPublic(interaction, { content: errorMessage(result.error) });
    return;
  }

  if (result.started && result.player?.queue?.current) {
    await replyPublic(interaction, {
      content: queuedSummary(result),
      embeds: [nowPlayingEmbed(result.player)],
      components: [controlRow(!!result.player.paused)],
    });
    return;
  }
  await replyPublic(interaction, { content: queuedSummary(result) });
}

async function handleMusic(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  const client = ctx.client;

  if (sub === "skip") {
    const g = withPlayer(interaction, client, { mustHaveCurrent: true });
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    await skipCurrent(g.player);
    return replyEphemeral(interaction, "Skipped.");
  }

  if (sub === "pause") {
    const g = withPlayer(interaction, client, { mustHaveCurrent: true });
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    if (g.player.paused) {
      return replyEphemeral(interaction, "Already paused. Use `/music resume`.");
    }
    await pauseToggle(g.player);
    return replyEphemeral(interaction, "Paused.");
  }

  if (sub === "resume") {
    const g = withPlayer(interaction, client, { mustHaveCurrent: true });
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    if (!g.player.paused) {
      return replyEphemeral(interaction, "I'm not paused.");
    }
    await pauseToggle(g.player);
    return replyEphemeral(interaction, "Resumed.");
  }

  if (sub === "stop" || sub === "leave") {
    const g = withPlayer(interaction, client);
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    await destroyPlayer(g.manager, interaction.guildId, sub);
    return replyEphemeral(
      interaction,
      sub === "stop" ? "Stopped and left the channel." : "Left the voice channel."
    );
  }

  if (sub === "queue") {
    const g = withPlayer(interaction, client);
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    return replyEphemeral(interaction, {
      embeds: [queueEmbed(g.player)],
    });
  }

  if (sub === "nowplaying") {
    const g = withPlayer(interaction, client, { mustHaveCurrent: true });
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    return interaction.reply({
      embeds: [nowPlayingEmbed(g.player)],
      components: [controlRow(!!g.player.paused)],
    });
  }

  if (sub === "volume") {
    const g = withPlayer(interaction, client);
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    const level = interaction.options.getInteger("level", true);
    const r = await setVolume(g.player, level);
    return replyEphemeral(interaction, `Volume set to **${r.volume}%**.`);
  }

  if (sub === "shuffle") {
    const g = withPlayer(interaction, client);
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    const r = await shuffleQueue(g.player);
    if (!r.ok) return replyEphemeral(interaction, "Queue is empty — nothing to shuffle.");
    return replyEphemeral(interaction, `Shuffled **${r.count}** upcoming tracks.`);
  }

  if (sub === "remove") {
    const g = withPlayer(interaction, client);
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    const pos = interaction.options.getInteger("position", true);
    const r = await removeAt(g.player, pos);
    if (!r.ok) return replyEphemeral(interaction, errorMessage(r.error));
    const title = r.track?.info?.title || "track";
    return replyEphemeral(interaction, `Removed **${title}** from the queue.`);
  }

  if (sub === "seek") {
    const g = withPlayer(interaction, client, { mustHaveCurrent: true });
    if (!g.ok) return replyEphemeral(interaction, errorMessage(g.error));
    const raw = interaction.options.getString("timestamp", true);
    const parsed = parseTimestamp(raw);
    if (!parsed.ok) {
      return replyEphemeral(
        interaction,
        "Use a timestamp like `1:23` or seconds (`90`)."
      );
    }
    const r = await seekTo(g.player, parsed.ms);
    if (!r.ok) return replyEphemeral(interaction, errorMessage(r.error));
    return replyEphemeral(interaction, `Seeked to **${formatDuration(parsed.ms)}**.`);
  }

  await replyEphemeral(interaction, "Unknown music subcommand.");
}

async function handleMusicButton(interaction, ctx) {
  const g = withPlayer(interaction, ctx.client);
  if (!g.ok) {
    await replyEphemeral(interaction, errorMessage(g.error));
    return;
  }
  const id = interaction.customId;

  if (id === BTN.pause) {
    const r = await pauseToggle(g.player);
    if (typeof interaction.update === "function") {
      await interaction.update({
        embeds: [nowPlayingEmbed(g.player)],
        components: [controlRow(!!r.paused)],
      });
      return;
    }
    await replyEphemeral(interaction, r.paused ? "Paused." : "Resumed.");
    return;
  }

  if (id === BTN.skip) {
    await skipCurrent(g.player);
    await replyEphemeral(interaction, "Skipped.");
    return;
  }

  if (id === BTN.stop) {
    await destroyPlayer(g.manager, interaction.guildId, "button_stop");
    if (typeof interaction.update === "function") {
      await interaction.update({
        content: "Stopped playback.",
        embeds: [],
        components: [],
      });
      return;
    }
    await replyEphemeral(interaction, "Stopped and left the channel.");
  }
}

function wirePlayerEvents(client, manager) {
  if (!manager?.on || manager._eventsWired) return;
  manager._eventsWired = true;

  manager.on("trackStart", (player) => {
    if (player?._fromCommand) {
      player._fromCommand = false;
      return;
    }
    const channelId = player?.textChannelId;
    if (!channelId) return;
    const channel =
      client.channels?.cache?.get(channelId) ||
      player.guild?.channels?.cache?.get(channelId);
    if (!channel?.send) return;
    channel
      .send({
        embeds: [nowPlayingEmbed(player)],
        components: [controlRow(!!player.paused)],
      })
      .catch((err) => {
        console.error("[music] now-playing send failed:", err?.message || err);
      });
  });

  manager.on("trackError", (player, track, error) => {
    console.error(
      `[music] track error in ${player?.guildId}:`,
      error?.exception?.message || error?.message || error
    );
  });
}

function registerEvents(client) {
  client.on("raw", (d) => {
    const manager = getManager(client);
    if (manager && typeof manager.sendRawData === "function") {
      manager.sendRawData(d);
    }
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    onVoiceStateUpdate(client, oldState, newState);
  });
}

function start(client) {
  const manager = tryCreateManager(client);
  if (!manager) {
    console.log(
      "[music] Lavalink not configured (set LAVALINK_HOST). /play will report that until a node is connected."
    );
    return;
  }
  wirePlayerEvents(client, manager);
  if (manager._fake) {
    manager.useable = true;
    return;
  }
  const init = manager.init?.({
    id: client.user.id,
    username: client.user.username,
  });
  Promise.resolve(init)
    .then(() => {
      if (isNodeReady(client)) {
        console.log("[music] Lavalink node connected.");
      } else {
        console.warn(
          "[music] Lavalink init finished but no node is connected yet."
        );
      }
    })
    .catch((err) => {
      console.error("[music] Lavalink init failed:", err?.message || err);
    });
}

module.exports = {
  name: "music",
  commands,
  handlers: {
    play: handlePlay,
    music: handleMusic,
  },
  buttonHandlers: {
    "music:": handleMusicButton,
  },
  registerEvents,
  start,
  // test seams
  setManagerForTests,
};
