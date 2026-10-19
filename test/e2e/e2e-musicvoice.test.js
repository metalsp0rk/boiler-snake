const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { createE2eEnv } = require("./helpers/e2eEnv");
const { poll, namespaceIds } = require("./helpers/mockenv");

// NOTE: never require src/** at module top level here! src/db/connection.js
// resolves DB_PATH at REQUIRE time — see e2e-buttons/e2e-reactions headers.

/**
 * Tier-4 music/voice coverage (issue #323). Namespace 18.
 *
 * Part 1 — Lavalink-less degradation (the issue's today-shippable matrix):
 * every `/play` + `/music` subcommand and every `music:` button answers with
 * the actionable `no_config` copy (error-handling rule 3: never silent,
 * never a dead end), including for non-staff (public surface).
 *
 * Part 2 — the live-player half WITHOUT a Lavalink sidecar, via the
 * product's explicit test seam `setManagerForTests` (src/features/music/
 * lavalink.js): a duck-typed manager/player drives the REAL handler paths —
 * voice gates (not_in_voice / wrong_channel), the /play success + playlist +
 * no_tracks + search_failed arms, queue/nowplaying embeds, the full
 * pause/resume/volume-clamp/shuffle/remove/seek copy matrix, the three
 * `music:` buttons (update-type responses included), and player destroy —
 * none of which the issue text thought testable ("out of scope without a
 * Lavalink test-sidecar; document"). The voice state comes from the bot's
 * in-process gateway cache (the mock has no VOICE_STATE_UPDATE support).
 *
 * Voice XP rules stay todo (mock lacks voice-state transport entirely —
 * same gap family as #328 gaps 6/7; see the stubs at the bottom).
 */
describe(
  "e2e: music degradation + fake-manager player engine — /play, /music matrix, music: buttons, voice gates",
  { concurrency: 1 },
  () => {
    /** @type {Awaited<ReturnType<typeof createE2eEnv>>} */
    let env;
    let setManagerForTests;
    let guild;

    const NO_CONFIG =
      "Music isn't configured. Set `LAVALINK_HOST` (and run a Lavalink 4.2+ node).";
    const VC_A = "1561800000000000001";
    const VC_B = "1561800000000000002";

    /** @type {any} shared seam fake (test/helpers/lavalink.js) */
    let fake = null;
    let hostMsg = null; // existing message for button clicks

    before(async () => {
      const ids = namespaceIds(18);
      env = await createE2eEnv({
        ns: 18,
        channels: [{ id: ids.general, name: "general" }],
      });
      // src is lazy — DB_PATH binds at require time (and keep the seam
      // handle local to the booted env).
      setManagerForTests = require("../../src/features/music/lavalink").setManagerForTests;
      guild = env.supervisor.discord.guilds.cache.get(env.ids.guild);
      hostMsg = await env.mock.inject("music button host", env.ids.human, env.ids.general);
    });

    after(async () => {
      setManagerForTests(null);
      try {
        guild?.voiceStates?.cache?.delete(env.ids.human);
      } catch {
        /* cache may be gone after cleanup */
      }
      await env?.cleanup();
    });

    const slash = (command, options, who = env.ids.human) =>
      env.mock.slash({ command, options, userId: who });
    const sub = (name, options = []) => ({ name, type: 1, ...(options.length && { options }) });
    const strOpt = (name, value) => ({ name, type: 3, value });
    const intOpt = (name, value) => ({ name, type: 4, value });
    const contentOf = async (inter) => String((await env.mock.awaitSettledReply(inter)).content);

    const MUSIC_SUBS_WITH_ARGS = [
      ["skip", []],
      ["pause", []],
      ["resume", []],
      ["stop", []],
      ["leave", []],
      ["queue", []],
      ["nowplaying", []],
      ["volume", [intOpt("level", 50)]],
      ["shuffle", []],
      ["remove", [intOpt("position", 1)]],
      ["seek", [strOpt("timestamp", "1:23")]],
    ];

    const setVoice = (channelId) =>
      guild.voiceStates.cache.set(env.ids.human, {
        channelId,
        channel: null,
        member: { user: { bot: false } },
      });
    const clearVoice = () => guild.voiceStates.cache.delete(env.ids.human);

    /** Duck-typed lavalink player — THE shared seam fake (#470 G2-6: the
     * inline copy here re-implemented the player/queue shape twice and
     * drifted from the integration fake). Search answers ride the manager's
     * documented searchOverride seam. */
    const { makeTrack, createFakeLavalinkManager } = require("../helpers/lavalink");

    const e2eTrack = (title, extra = {}) =>
      makeTrack({
        title,
        author: "E2E Artist",
        duration: 210_000,
        uri: "https://example/track",
        sourceName: "youtube",
        requester: { id: env.ids.human },
        ...extra,
      });

    const installFakeManager = () => {
      fake = createFakeLavalinkManager();
      // Single-guild world: `_player` mirrors the old inline fake's slot.
      Object.defineProperty(fake, "_player", {
        get: () => fake.players.get(env.ids.guild) || null,
        configurable: true,
      });
      fake.searchOverride = (query) => {
        const q = typeof query === "string" ? query : (query?.query ?? "");
        if (/boom/.test(q)) throw new Error("node exploded");
        if (/none/i.test(q)) return { loadType: "empty", tracks: [] };
        if (/multi/i.test(q)) {
          return {
            loadType: "playlist",
            playlist: { name: "E2E Playlist" },
            tracks: [e2eTrack("Song One"), e2eTrack("Song Two"), e2eTrack("Song Three")],
          };
        }
        return { loadType: "tracks", tracks: [e2eTrack(q)] };
      };
      setManagerForTests(fake);
      return fake;
    };

    it("no Lavalink: /play and EVERY /music subcommand answer the actionable config copy (public surface)", async () => {
      const play = await contentOf(await slash("play", [strOpt("query", "never gonna give")]));
      assert.equal(play, NO_CONFIG);

      for (const [name, options] of MUSIC_SUBS_WITH_ARGS) {
        const copy = await contentOf(await slash("music", [sub(name, options)]));
        assert.equal(copy, NO_CONFIG, `/music ${name} degraded copy`);
      }

      // Public surface: an outsider gets the SAME degradation, not a denial.
      assert.equal(
        await contentOf(await slash("music", [sub("queue")], env.ids.outsider)),
        NO_CONFIG,
      );
    });

    it("no Lavalink: music: button clicks answer the config copy (never silent)", async () => {
      // Immediate (type-4) button callbacks materialize a message readable
      // via the interaction webhook; UPDATE (type-7) callbacks only persist
      // the interaction's response_json (see the live-buttons test).
      for (const id of ["music:pause", "music:skip", "music:stop"]) {
        const inter = await env.mock.click({ customId: id, messageId: String(hostMsg.id) });
        const msg = await env.mock.awaitSettledReply(inter);
        assert.equal(String(msg.content), NO_CONFIG, `${id} copy`);
      }
    });

    it("ready manager, no player: queue answers no_player (withPlayer gate ordering)", async () => {
      installFakeManager();
      assert.equal(
        await contentOf(await slash("music", [sub("queue")])),
        "I'm not playing anything in this server.",
      );
    });

    it("/play live: success embed+controls, playlist add, no_tracks + search_failed arms", async () => {
      setVoice(VC_A);

      const inter = await slash("play", [strOpt("query", "Test Song")]);
      const msg = await env.mock.awaitSettledReply(inter);
      assert.equal(msg.content, "Playing **Test Song** — E2E Artist");
      assert.equal(msg.embeds[0].title, "Test Song");
      assert.equal(msg.embeds[0].description, "by **E2E Artist**");
      const fields = Object.fromEntries(
        msg.embeds[0].fields.map((f) => [f.name, f.value]),
      );
      assert.equal(fields.Duration, "3:30");
      assert.equal(fields.Source, "YouTube");
      assert.equal(fields["Requested by"], `<@${env.ids.human}>`);
      const labels = msg.components[0].components.map((c) => c.label);
      assert.deepEqual(labels, ["Pause", "Skip", "Stop"]);

      // Player is live now: connected + current set through the fake.
      assert.equal(fake._player.connected, true);
      assert.equal(fake._player.queue.current.info.title, "Test Song");
      assert.equal(fake._player.voiceChannelId, VC_A);

      // Playlist while playing → queue-only summary (no started embed).
      const pl = await contentOf(await slash("play", [strOpt("query", "multi playlist")]));
      assert.equal(pl, "Queued **3** tracks from **E2E Playlist**.");

      assert.equal(
        await contentOf(await slash("play", [strOpt("query", "none here")])),
        "No tracks found for that query.",
      );
      assert.equal(
        await contentOf(await slash("play", [strOpt("query", "boom town")])),
        "Search failed. Try a different query.",
      );
    });

    it("queue + nowplaying render live state (now/current lines, footer, control row)", async () => {
      const qm = await env.mock.awaitSettledReply(await slash("music", [sub("queue")]));
      const e = qm.embeds[0];
      assert.equal(e.title, "Queue");
      assert.ok(e.description.startsWith("**Now:** Test Song — E2E Artist (3:30)"), e.description);
      assert.ok(e.description.includes("`1.` Song One — E2E Artist (3:30)"), e.description);
      assert.ok(e.description.includes("`3.` Song Three"), e.description);
      assert.equal(e.footer.text, "3 in queue · volume 80%");

      const np = await env.mock.awaitSettledReply(await slash("music", [sub("nowplaying")]));
      assert.equal(np.embeds[0].title, "Test Song");
      assert.ok(!np.embeds[0].footer, "not paused → no Paused footer");
      assert.deepEqual(
        np.components[0].components.map((c) => c.custom_id ?? c.customId),
        ["music:pause", "music:skip", "music:stop"],
      );
    });

    it("pause/resume copy matrix incl. already/idle arms", async () => {
      assert.equal(await contentOf(await slash("music", [sub("pause")])), "Paused.");
      assert.equal(
        await contentOf(await slash("music", [sub("pause")])),
        "Already paused. Use `/music resume`.",
      );
      const np = await env.mock.awaitSettledReply(await slash("music", [sub("nowplaying")]));
      assert.equal(np.embeds[0].footer.text, "Paused");

      assert.equal(await contentOf(await slash("music", [sub("resume")])), "Resumed.");
      assert.equal(await contentOf(await slash("music", [sub("resume")])), "I'm not paused.");
    });

    it("volume clamps + shuffle/remove position semantics", async () => {
      assert.equal(
        await contentOf(await slash("music", [sub("volume", [intOpt("level", 150)])])),
        "Volume set to **100%**.",
      );
      assert.equal(fake._player.volume, 100);

      assert.equal(
        await contentOf(await slash("music", [sub("remove", [intOpt("position", 99)])])),
        "There's no track at that queue position.",
      );
      assert.equal(
        await contentOf(await slash("music", [sub("remove", [intOpt("position", 1)])])),
        "Removed **Song One** from the queue.",
      );
      assert.equal(
        await contentOf(await slash("music", [sub("shuffle")])),
        "Shuffled **2** upcoming tracks.",
      );
    });

    it("seek: invalid input, livestream, past-end, and the valid arm", async () => {
      assert.equal(
        await contentOf(await slash("music", [sub("seek", [strOpt("timestamp", "abc")])])),
        "Use a timestamp like `1:23` or seconds (`90`).",
      );
      assert.equal(
        await contentOf(await slash("music", [sub("seek", [strOpt("timestamp", "4:00")])])),
        "That timestamp is past the end of the track.",
      );

      const live = e2eTrack("E2E Stream", { isStream: true, duration: 0 });
      const restore = fake._player.queue.current;
      fake._player.queue.current = live;
      assert.equal(
        await contentOf(await slash("music", [sub("seek", [strOpt("timestamp", "0:30")])])),
        "Can't seek on a livestream.",
      );
      fake._player.queue.current = restore;

      assert.equal(
        await contentOf(await slash("music", [sub("seek", [strOpt("timestamp", "1:23")])])),
        "Seeked to **1:23**.",
      );
      assert.equal(fake._player.lastSeek, 83_000, "player.seek hit through the slash");
    });

    it("voice gates: wrong_channel, not_in_voice (slash AND /play), restored after", async () => {
      const savedVc = fake._player.voiceChannelId;
      fake._player.voiceChannelId = VC_B;
      assert.equal(
        await contentOf(await slash("music", [sub("queue")])),
        "You're not in my voice channel.",
      );
      assert.equal(
        await contentOf(await slash("play", [strOpt("query", "Test Song")])),
        "You're not in my voice channel.",
        "/play honors the same gate against the live player",
      );
      fake._player.voiceChannelId = savedVc;

      clearVoice();
      assert.equal(
        await contentOf(await slash("music", [sub("queue")])),
        "Join a voice channel first.",
      );
      assert.equal(
        await contentOf(await slash("play", [strOpt("query", "Test Song")])),
        "Join a voice channel first.",
      );
      setVoice(VC_A);
      assert.ok(fake._player, "player untouched by the gate failures");
    });

    it("music: buttons live — pause update (Paused footer + Resume label), skip copy, stop destroys", async () => {
      // Mock fidelity: immediate (type-4) callbacks materialize a webhook
      // message; UPDATE (type-7) callbacks persist ONLY as the interaction's
      // parsed `response_json` — no message is materialized.
      const updateState = async (inter, pred, label) =>
        poll(async () => {
          const s = await env.mock.interactionState(inter.id);
          const data = s?.response_json?.data ?? null;
          return data && pred(data) ? data : null;
        }, { timeoutMs: 8000, label });

      const pauseData = await updateState(
        await env.mock.click({ customId: "music:pause", messageId: String(hostMsg.id) }),
        (d) => d.embeds?.[0]?.footer?.text === "Paused",
        "pause update embed",
      );
      assert.deepEqual(
        pauseData.components[0].components.map((c) => c.label),
        ["Resume", "Skip", "Stop"],
      );
      assert.equal(fake._player.paused, true, "player state flipped");

      const skipMsg = await env.mock.awaitSettledReply(
        await env.mock.click({ customId: "music:skip", messageId: String(hostMsg.id) }),
      );
      assert.equal(skipMsg.content, "Skipped.");
      assert.ok(
        fake._player.queue.previous.length >= 1,
        "player.skip hit through the button",
      );

      const preStopPlayer = fake._player;
      const stopData = await updateState(
        await env.mock.click({ customId: "music:stop", messageId: String(hostMsg.id) }),
        (d) => d.content === "Stopped playback.",
        "stop update payload",
      );
      assert.equal((stopData.components ?? []).length, 0, "controls cleared");
      assert.equal(preStopPlayer.destroyReason, "button_stop");
      assert.equal(fake._player, null, "manager.deletePlayer ran");

      assert.equal(
        await contentOf(await slash("music", [sub("queue")])),
        "I'm not playing anything in this server.",
        "post-stop state is truly gone",
      );
    });

    it("node-down manager answers the retry copy; removing the seam returns to config copy", async () => {
      setManagerForTests({ useable: false, getPlayer: () => null });
      assert.equal(
        await contentOf(await slash("music", [sub("queue")])),
        "Music isn't connected right now — the Lavalink node is down. Try again in a moment.",
      );

      setManagerForTests(null);
      fake = null;
      assert.equal(
        await contentOf(await slash("music", [sub("queue")])),
        NO_CONFIG,
      );
    });

    // ── Voice XP: mock has no VOICE_STATE_UPDATE transport at all (same
    // ── gap family as the #328 deferred list). The rules (AFK ignore,
    // ── ≥2 eligible humans, no XP muted/deafened) stay unit-only.
    it.todo("voice XP rules (AFK ignore, ≥2 humans, muted/deafened) — mock lacks voice-state transport");
    it.todo("music: AFK-channel gate (`afk` copy) — mock guild cannot set afk_channel_id");
  },
);
