# Lavalink sidecar

Boiler Snake plays audio through **Lavalink 4.2+** (required for Discord DAVE / E2EE voice). The Node process never encodes opus; it forwards voice state to this node.

## Docker Compose

From the repo root (with `.env` filled in):

```bash
docker compose up -d --build
```

The `lavalink` service reads `deploy/lavalink/application.yml` and downloads plugins into the `lavalink-plugins` volume.

## Local (no Compose)

1. Run [Lavalink 4](https://github.com/lavalink-devs/Lavalink/releases) with this `application.yml`.
2. Set in `.env`:

```env
LAVALINK_HOST=127.0.0.1
LAVALINK_PORT=2333
LAVALINK_PASSWORD=youshallnotpass
SPOTIFY_CLIENT_ID=YOUR_SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET=YOUR_SPOTIFY_CLIENT_SECRET
```

Spotify credentials are **client credentials** (catalog search + playlist resolve). They do not stream Spotify audio.

## Bumping plugins

When YouTube extraction breaks, bump **only** the plugin versions in `application.yml` (and recreate the Lavalink container). You usually do not need a bot release.

| Plugin | Maven coordinates | Releases |
|--------|-------------------|----------|
| YouTube | `dev.lavalink.youtube:youtube-plugin` | https://github.com/lavalink-devs/youtube-source/releases |
| LavaSrc | `com.github.topi314.lavasrc:lavasrc-plugin` | https://github.com/topi314/LavaSrc/releases |

After editing versions:

```bash
docker compose up -d --force-recreate lavalink
```

Delete the `lavalink-plugins` volume if the node still loads old JARs.
