# Music player

Play music in a Discord voice channel. Anyone in the **same voice channel** as the bot can control playback.

## How it actually works

The Spotify Web API **cannot stream full tracks** into Discord. Spotify is a **catalog**: search, track/album/playlist URLs, artwork, and ISRC. [LavaSrc](https://github.com/topi314/LavaSrc) on the Lavalink node then resolves a matching stream from **YouTube Music / YouTube / SoundCloud**.

Audio is **not** a Spotify stream. Matches can be wrong (covers, lyrics videos, region blocks). YouTube extraction also violates YouTube’s terms and breaks when Google changes InnerTube — that risk lives in the Lavalink YouTube plugin, not in the Node bot.

## Queue bound & node resilience

The queue has a **total bound of 500 tracks** (#469 E2-07): a `/play` whose tracks
would cross it is refused whole (no half playlist), with the number and the remedy
in the refusal - wait it out, or trim with `/music remove position:`. Playlists
were always capped per batch (100); the aggregate never was.

A Lavalink node has a finite boot connect budget (10 retries). If the node stays
down past it, a **readiness heartbeat** now keeps asking (#469 E2-06): every tick a
ready node costs one check, a sustained outage re-issues `node.connect()` until the
node answers again — no bot restart required.

## Why older bots were silent

Discord requires **DAVE** (end-to-end encrypted voice) for guild voice. Lavalink added DAVE in 4.2.0, but **the supported minimum is 4.2.2** — 4.2.0/4.2.1 builds still produce the silent-join symptom. A bot that joins, looks connected, and produces no sound is almost always on a pre-DAVE (or sub-4.2.2) stack. Boiler Snake pins **Lavalink 4.2.2+** (docker-compose says the same).

The Node process never encodes Opus. It forwards Discord voice state to Lavalink; Lavalink talks UDP to Discord.

## Setup

### 1. Discord permissions

The bot needs **Connect** and **Speak** (and **View Channel**) on voice channels, plus **Send Messages** and **Embed Links** in the text channel you use for `/play`.

### 2. Lavalink node (required)

**Docker Compose** (recommended): `docker compose up -d --build` starts a `lavalink` sidecar next to the bot. The bot gets `LAVALINK_HOST=lavalink` automatically. **`LAVALINK_PASSWORD` must be set in `.env`** (any strong secret — compose forwards it to both sides and **aborts** when it is missing; the public `youshallnotpass` default was removed in #455 so the boot fail-fast actually fires). Do not publish port 2333 on the host.

**Local Node**: run [Lavalink 4.2+](https://github.com/lavalink-devs/Lavalink/releases) with the repo `application.yml`, then:

```env
LAVALINK_HOST=127.0.0.1
LAVALINK_PORT=2333
LAVALINK_PASSWORD=YOUR_LAVALINK_PASSWORD
```

Sidecar notes and plugin-bump steps: [deploy/lavalink/README.md](https://github.com/metalsp0rk/boiler-snake/blob/main/deploy/lavalink/README.md).

### 3. Spotify catalog (optional, recommended)

Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard). Use **Client Credentials** only (no redirect URI, no user OAuth).

```env
SPOTIFY_CLIENT_ID=YOUR_SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET=YOUR_SPOTIFY_CLIENT_SECRET
```

Pass the same values into the Lavalink container (Compose already forwards them). Without these, `/play` still works for YouTube/SoundCloud URLs and YouTube Music search, but **Spotify URLs fail** with an explicit error.

Never commit real credentials. Use the placeholders above in docs and `.env.example`.

## Commands

Public. Caller must be in a non-AFK voice channel. If the bot is already playing, caller must be in **that** channel. Command-channel restrictions still apply (same as `/xp`).

| Command | Effect |
|---------|--------|
| `/play query:` | Join caller’s VC if needed, resolve query, enqueue, start if idle |
| `/music skip` | Skip current track |
| `/music pause` / `resume` | Pause / resume |
| `/music stop` | Clear queue and leave |
| `/music leave` | Leave voice |
| `/music queue` | Upcoming tracks |
| `/music nowplaying` | Current track + Pause/Skip/Stop buttons |
| `/music volume` | 0–100 (default 80) |
| `/music shuffle` | Shuffle remaining queue |
| `/music remove position:` | Remove one queued item (1-based) |
| `/music seek timestamp:` | `1:23` or seconds (`90`) |

`/play` accepts:

- Spotify track / album / playlist / artist URL or `spotify:` URI
- YouTube / YouTube Music / youtu.be
- SoundCloud
- Other HTTP audio URLs
- Free-text search (`spsearch` if Spotify creds are set, else `ytmsearch`)

Playlists/albums enqueue up to **100** tracks.

Queues are **in memory**. A bot restart empties them.

## Idle leave

- The voice channel has no humans (only the bot): leave after **60 seconds**.
- Queue drained (last track finished, nothing enqueued): leave after
  **5 minutes**. Playing anything (`/play`) cancels the window.
  (#588 — a timer is now implemented in code; the earlier #463 correction
  stood because the library-side config it replaced was unverified, could not
  be cancelled on enqueue, and left the channel inside an unlogged timer.)
- The bot only ever leaves via these timers, `/music stop`, or `/music leave`.

Voice XP is unchanged: the ticker already ignores bots; humans still earn XP while music plays (two eligible humans in the channel).

## Troubleshooting

### Joined but no audio

1. Lavalink **4.2.2+** (DAVE). Recreate the sidecar: `docker compose up -d --force-recreate lavalink`
2. Bot role has **Speak** (not server-deafened, not muted)
3. Lavalink container can make **outbound UDP** to Discord (default Docker NAT is enough; no inbound 2333 publish required)
4. Check bot logs for `[music] Lavalink node connected` vs node-down errors

### Spotify URL fails

Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` on **both** the bot and Lavalink, then recreate the Lavalink container.

### Search finds nothing / YouTube 403

Bump `dev.lavalink.youtube:youtube-plugin` in `application.yml` and recreate Lavalink. You usually do **not** need a bot release. See the sidecar README linked above.

### `/play` says commands aren't enabled

You restricted slash commands with `/setcommandchannel`. Run `/play` from an allowed text channel (being in voice is not enough).
