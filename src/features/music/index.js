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
  clearLeaveTimers,
  notePlayerActivity,
  onVoiceStateUpdate,
  onQueueEnd,
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
  // PR 7 (spec § Supervisor): the Lavalink-owning Discord client comes from
  // the supervisor; interaction.client stays the first choice so Discord
  // dispatch (and integration mocks that attach .client) keeps working.
  const client = interaction.client ?? ctx?.supervisor?.discord ?? null;
  const gate = requireReady(client);
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
  const result = await playQuery(client, interaction, query);
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
  // PR 7: Discord client from the supervisor (interaction.client first — the
  // router hands real interactions here, mocks attach .client).
  const client = interaction.client ?? ctx?.supervisor?.discord ?? null;

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
  // PR 7: Discord client from the supervisor (interaction.client first).
  const g = withPlayer(interaction, interaction.client ?? ctx?.supervisor?.discord ?? null);
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
    // #588: audio is playing again — a running queue-drain window is off.
    // BEFORE the _fromCommand early-return so the signal cannot be skipped
    // (the /play path also cancels at enqueue; this is the event-side sink).
    notePlayerActivity(player);
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

  // #588: queue drained → arm the idle-leave window (see player.js). The
  // handler itself is exception-guarded: a failed arm must never bubble
  // into the library's event loop.
  manager.on("queueEnd", (player) => {
    try {
      onQueueEnd(manager, player);
    } catch (err) {
      console.error(
        `[music] queueEnd handling failed (guild ${player?.guildId ?? "?"}):`,
        err?.message || err,
      );
    }
  });
}

/**
 * Gateway bindings (spec § Scheduler line 608): the raw/voiceState streams
 * exist on the Discord client only — bind to supervisor.discord, null → no-op.
 * @param {import("../../platform/boot").Supervisor} supervisor
 * @param {object} [ctx]
 */
function registerEvents(supervisor, ctx) {
  const client = supervisor?.discord ?? null;
  if (!client) return;
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

// #469 (E2-06): the node connect budget is FINITE (retryAmount: 10).
// A Lavalink outage longer than ~10 retries exhausts lavalink-client's
// internal reconnect loop and NOTHING else ever asked the node again:
// useable stayed false and every /play answered "not configured" until
// the BOT PROCESS restarted. A slow readiness re-probe replaces the
// one-shot budget with a permanent heartbeat — cheap (a useable check
// per tick) and only reaching for the network when the node really is
// down.
const REPROBE_TICK_MS = 60_000;
/** Give lavalink-client's OWN retry loop a couple of ticks first. */
const REPROBE_STREAK = 2;

/** @type {{ streak: number, timer: ReturnType<typeof setInterval>|null, client: object|null, manager: object|null }} */
const reprobe = { streak: 0, timer: null, client: null, manager: null };

/**
 * One readiness tick. Extracted (and state-injectable) so tests drive
 * the streak deterministically.
 * @param {object} client
 * @param {object} manager
 * @param {{streak: number}} [state]
 * @returns {Promise<"ready"|"waiting"|"attempted"|"connecting"|"no_node"|"failed">}
 */
async function reprobeLavalinkNode(client, manager, state = reprobe) {
  if (manager?.useable) {
    if (state.streak > 0) {
      console.log("[music] Lavalink node back ONLINE (readiness re-probe).");
    }
    state.streak = 0;
    return "ready";
  }
  state.streak += 1;
  if (state.streak < REPROBE_STREAK) return "waiting";

  let node = null;
  try {
    const nodes = manager?.nodeManager?.nodes ?? manager?.nodes ?? null;
    node = nodes?.get?.("main") ?? null;
    if (!node && nodes && typeof nodes.values === "function") {
      node = nodes.values().next().value ?? null;
    }
  } catch (err) {
    console.error("[music] re-probe node lookup failed:", err?.message || err);
    return "no_node";
  }
  if (!node) {
    console.warn("[music] Lavalink re-probe: no 'main' node exists to reconnect.");
    return "no_node";
  }
  // Observed BEFORE the connectability check: an in-flight connect needs no
  // second one, reconnectable or not.
  if (node.connecting === true || node.connected === true) return "connecting";
  if (typeof node.connect !== "function") {
    console.warn("[music] Lavalink re-probe: the node exposes no connect() to call.");
    return "no_node";
  }

  state.streak = 0;
  try {
    console.warn(
      `[music] Lavalink node has been down for ${REPROBE_STREAK}+ probe tick(s) - issuing node.connect() (#469 E2-06: the boot retry budget is finite, this heartbeat is not)`,
    );
    await node.connect();
    return "attempted";
  } catch (err) {
    console.error("[music] Lavalink re-probe connect failed:", err?.message || err);
    return "failed";
  }
}

/**
 * Arm the heartbeat (idempotent). tickMs is a test seam.
 */
function startLavalinkReprobe(client, manager, { tickMs = REPROBE_TICK_MS } = {}) {
  if (reprobe.timer) return reprobe.timer;
  if (!manager) return null;
  reprobe.client = client;
  reprobe.manager = manager;
  reprobe.streak = 0;
  reprobe.timer = setInterval(() => {
    // The timer callback MUST keep its own catch (rule 1): a rejecting
    // probe may never kill the interval or ride the process net.
    reprobeLavalinkNode(reprobe.client, reprobe.manager, reprobe).catch((err) =>
      console.error("[music] Lavalink re-probe tick failed:", err?.message || err),
    );
  }, tickMs);
  if (typeof reprobe.timer.unref === "function") reprobe.timer.unref();
  return reprobe.timer;
}

/** Disarm (shutdown + tests). */
function stopLavalinkReprobe() {
  if (reprobe.timer) {
    clearInterval(reprobe.timer);
    reprobe.timer = null;
  }
  reprobe.streak = 0;
}

/**
 * Music is Discord-only (spec § Scheduler line 584): the Lavalink manager
 * streams voice on Discord guilds, so it is built from supervisor.discord and
 * NEVER for a Fluxer community. No Discord client → the existing
 * "not configured" line and no player construction.
 * @param {import("../../platform/boot").Supervisor} supervisor
 * @param {object} [ctx]
 */
function start(supervisor, ctx) {
  const client = supervisor?.discord ?? null;
  const manager = client ? tryCreateManager(client) : null;
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
  // #469 (E2-06): permanent readiness heartbeat - the boot-time
  // retryAmount:10 budget used to be the END of reconnecting forever.
  startLavalinkReprobe(client, manager);

  // Graceful-shutdown handle (audit C9): destroy live players so Lavalink
  // sessions and voice connections close cleanly instead of being hard-cut
  // (the manager itself keeps no timers — players are the leak). Runs BEFORE
  // the Discord client destroy: player.destroy sends its leave via the shard.
  return {
    stop() {
      stopLavalinkReprobe(); // #469 (E2-06)
      const players = manager.players;
      if (!players || typeof players.values !== "function") return;
      const destroys = [];
      for (const player of players.values()) {
        if (player && typeof player.destroy === "function") {
          try {
            // #588: this loop bypasses destroyPlayer, so disarm both leave
            // windows explicitly — a dangling idle timer must not survive
            // the drain or fire mid-shutdown against a dead client.
            clearLeaveTimers(player.guildId);
            destroys.push(player.destroy("bot shutdown", true));
          } catch (err) {
            console.error(
              `[music] player destroy failed (guild ${player.guildId ?? "?"}):`,
              err?.message || err,
            );
          }
        }
      }
      return Promise.allSettled(destroys).then((results) => {
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed > 0) {
          console.error(
            `[music] ${failed}/${destroys.length} player(s) failed to destroy on shutdown`,
          );
        }
      });
    },
  };
}

module.exports = {
  reprobeLavalinkNode, // #469 (E2-06): readiness heartbeat
  startLavalinkReprobe,
  stopLavalinkReprobe,
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
