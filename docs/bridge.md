# Channel bridges (Discord ↔ Fluxer)

A bridge pairs **one Discord text channel** with **one Fluxer text channel** in your deployment. New human messages on either side are copied to the other — text, files, source-side edits, and source-side deletes — rendered as normal webhook messages under the source author's name. Nothing is backfilled: only messages posted after the bridge connects are copied, and each direction carries only what the direction setting allows.

Feature design and locked decisions live in the repo roadmap ([`roadmap/bridge.md`](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/bridge.md) on `main`); this page is the operator guide.

## Getting started

1. **Both platforms are connected.** The Discord bot is in the server and the Fluxer instance is configured in `FLUXER_INSTANCES` (see [Fluxer instances](fluxer.md)). In the bridged Discord channel the bot needs **View Channel, Send Messages, Attach Files, Embed Links, Manage Webhooks** — a missing permission names itself: `I can't bridge this channel: the bot is missing …`.
2. **Set `BRIDGE_TOKEN_KEY`** in `.env` (see Environment). `create` works without it; `connect` refuses until it's set.
3. **Create on one side.** Staff run `/bridge create` in the Discord channel (Fluxer side: `!bridge create` in the Fluxer channel). The reply is a `BRG-…` connect credential, **shown once**, plus the bridge handle `b_…`.
4. **Connect from the far side.** A staff member of the *other* platform consumes the code: `/bridge connect <code> [channel]` on Discord, or a **DM to the bot** on Fluxer: `!bridge connect <code> <channel>`. The pairing is 1:1 — a channel already in a bridge is rejected. The connect reply spells out the privacy consequence: `People in the receiving channel will be able to read what the source side posts, including edits and deletions.` A short notice (handle + direction, never the far channel id) is posted in the bridged channel.
5. **Verify.** `/bridge status` (Fluxer: `!bridge status`, results come back by DM) shows state, direction, queue depth, and the last error.
6. **Tear down** with `… disconnect` — by handle `b_…` or from a local channel. Both channels are released for new bridges; copied messages are **not** deleted.

Pairing one direction, start to finish:

```
Discord staff, in #general:   /bridge create direction:to-fluxer
    → ephemeral reply: BRG-… credential (shown once) + handle b_…
Fluxer staff, DM to the bot:  !bridge connect BRG-… 123456789012345678
    → DM: "Connected bridge b_…. This channel is paired with …"
    → #general sees:  "Bridge b_… connected. Direction: Discord → Fluxer."
Both sides:  /bridge status  ·  !bridge status (reply arrives by DM)
```

## Commands

Staff-tier on Discord (Manage Server, or a configured staff role): the slash picker is visibility-only, the handler is the security source of truth.

| Subcommand | Description (as shipped) |
|------------|--------------------------|
| `/bridge create [channel] [direction]` | Create a pending bridge for a channel (default: this one). Direction: `both` (default), `to-fluxer`, `from-fluxer` |
| `/bridge connect <code> [channel]` | Consume a BRG- connect credential for a channel. Default channel: this one |
| `/bridge disconnect [bridge] [channel]` | Destroy a bridge by handle or by a local channel. Handle wins |
| `/bridge status [bridge] [channel]` | Bridge status: state, direction, queue depth |
| `/bridge list` | List every bridge touching this community |

Fluxer runs the same verbs with the text prefix (`!bridge create`, `!bridge connect`, …; prefix from `FLUXER_COMMAND_PREFIX`). Two Fluxer specifics:

- **DMs are connect-only.** The bot's DMs run exactly one command: `!bridge connect <code> <channel>`, where `<channel>` is the id (or `<#mention>`) of the Fluxer guild channel to pair. Every reply comes back in the DM; the bot then posts a short "connected" notice in the target channel. Non-bridge DMs are ignored.
- **Pasting connect into a guild channel burns the code.** A `!bridge connect CODE` posted in a channel is destroyed, never used — the reply says so: `That connect command was posted in the channel, so the pairing code is burned and was not used.` DM it instead.

A status row looks like: `Bridge b_… — state: active, direction: Discord → Fluxer.` with outbox depth per direction, spool bytes, the two ends, and `last error` when set.

## What crosses

| Source event | What the destination sees |
|--------------|---------------------------|
| Text message / reply | The text, mentions rendered to plain labels (`@name`, `#name`); `@everyone`/`@here` are de-pinged, never a ping. Long text splits into `(continued)` parts, same author name |
| Files | Re-uploaded as normal attachments — 50 MiB per file to Fluxer, 20 MiB to Discord; 10 files per send, more files ride extra sends. Oversized files are named: `Attachment not copied: … is over the destination limit …` |
| Source edit | The copy is updated in place (all parts of it) |
| Source delete | All copies of that message are deleted |
| Reply reference | A header line `↪ in reply to {name}: {snippet}` — no jump link across platforms |
| Voice message | The audio as a plain attachment, captioned `Voice message` |
| Sticker | A `Sticker: {name}` line |

**Not copied:** message history (no backfill, ever), polls, reactions, threads, DMs, voice channels, pin/unpin-only edits, scheduled events. Bot and webhook messages never cross — relay copies are filtered at the pipeline gate, so A→B→A loops cannot form.

**Direction modes** (chosen at create, from the creating side's view):

| Mode | Effect |
|------|--------|
| `both` (default) | Messages copy in both directions |
| `to-fluxer` | Discord → Fluxer only (`to-discord` when created on Fluxer) |
| `from-fluxer` | Fluxer → Discord only (`from-discord` when created on Fluxer) |

## How copies are posted

- **Attribution.** Each end relays through its own webhook, named `Boiler Snake Bridge`, with the **source author's name on every message** (per-message username override; guild nickname when present). Avatars are best-effort; Fluxer→Discord copies carry the name without an avatar.
- **Pace.** The worker wakes every 250 ms and keeps at most one send in flight per direction (message N+1 never passes message N) and four concurrent sends process-wide. A 429 or Fluxer slowmode parks the copy at the head of its queue for the declared `Retry-After` (capped at 60 s) — rate limits never consume the five retry attempts.
- **Files are spooled at enqueue** under `DATA_DIR/bridge-spool/`, so a restart during an outage doesn't lose attachments: queued work resumes from disk, and a message whose spool bytes are gone re-fetches the source once before giving up.
- **Delivery is at-least-once.** Fluxer copies dedupe by an idempotency nonce; a crash in the instant after Discord accepted a message but before the bot recorded it can duplicate that one message. Nothing is silently dropped: a copy that can't be delivered after five attempts leaves a named notice (below) and a visible `last error`.
- **Echoes can't loop.** Copies are webhook-authored, and the pipeline gate drops bot- and webhook-authored messages on both ends, so a copy is never re-copied. Bridge command lines, this bot's own messages, and every other bot/webhook post never cross either.

## Codes and handles

- The `create` reply is **private** (ephemeral on the Discord slash; on Fluxer, which has no ephemeral replies, it's a DM to the staff member). It tells the connector everything they need: `On Discord the other side runs /bridge connect with the credential. On Fluxer they DM the bot: !bridge connect <credential> <channel>. The credential is the capability. Do not post it in a channel. The handle is safe to post.`
- The `BRG-…` connect credential is that capability: **shown once**, lasts **30 minutes**, **works once**. It cannot be re-shown — a `create` on a channel with a live pending bridge replies `The pairing code cannot be shown again.`
- The handle `b_…` is **not a secret** — safe to post; it's what `disconnect`/`status` take. Pass a handle to `connect` and you get a specific refusal.
- Expired/used codes: `That bridge code is expired or unknown. Codes last 30 minutes, work once, and cannot be shown again. Create a new one with … create.` Re-pairing is just a fresh `create` + `connect`.
- Too many bad codes in one community locks `connect` for 10 minutes.

## Failures operators see

| Symptom | What it means |
|---------|---------------|
| `Bridges are turned off on this process (BRIDGE_ENABLED=0).` | The kill switch is on (see Environment) — every bridge subcommand replies this |
| `Bridge b_… is paused on this process (BRIDGE_ENABLED=0). Messages posted while it is paused are not copied.` | The one latched notice in the source channel when a running bridge's process gets switched off |
| `Bridge b_… could not copy message … after 5 attempts: … Later messages are still being copied.` | One message poisoned and parked after the retry ladder; the copy keeps its old text on a failed edit; visible as `last error` in `status` |
| `Bridge b_… could not remove the copy of message … after 5 attempts: …` | A delete relay parked the same way — the copy survives until retried or removed manually |
| `Disconnected bridge b_…, but the webhook on the … end could not be deleted: …` | The bridge is gone, a leftover relay webhook is not: `Delete the webhook named "Boiler Snake Bridge" in that channel's webhook settings.` |
| `Bridge b_… is not copying files in this direction: the spool is full (…). Messages' text continues to copy; …` | The media spool hit its cap; text keeps flowing. The notice fires **once per direction per incident**, and returns to normal once the spool drains |
| `The bridge webhook was refused: this channel is at its webhook limit (…). Remove a webhook and run … connect again. Bridge not connected.` | The end that refused has no free webhook slot — per-channel and per-community refusals get their own sentences. Free a slot and `connect` with the same code |
| `Fluxer refused to create the bridge webhook: TWO_FACTOR_REQUIRED. On an MFA-elevated community the bot was not exempt from Manage Webhooks. Bridge not connected.` | The instance requires 2FA on webhook creation and the bot isn't exempt — exempt the bot, then `connect` again with the same code |

Every webhook-side connect refusal leaves the code pending and says so: `No channels were paired and the code is still valid — fix the cause and run connect again.` One direction failing never blocks the other. The bridge stays `active` across restarts; queued copies resume from disk.

## Environment

| Variable | Meaning |
|----------|---------|
| `BRIDGE_ENABLED` | Kill switch for the whole process (not per community). **Unset = ON.** `0`, `false`, `off` = OFF: commands reject, nothing enqueues, the worker sends nothing. Read at command time, at enqueue, and every worker tick — flip it in `.env` and the next read obeys, no restart. Outbox rows queued before a pause send on re-enable; messages posted *while* paused are not copied |
| `BRIDGE_TOKEN_KEY` | 32 bytes of base64, `.env` only: `openssl rand -base64 32`. Encrypts the relay webhook tokens at rest (AES-256-GCM). Required at **connect**, not at create: a missing key fails with `Set BRIDGE_TOKEN_KEY (32 bytes, base64) before connecting a bridge. Webhook tokens are not stored in plaintext.` and the code stays pending. No rotation in v1 — to change the key, disconnect and reconnect each bridge |

```env
# Channel bridge (roadmap/bridge.md) — see docs/bridge.md
# Kill switch: unset = on; 0 / false / off = paused (no restart needed)
# BRIDGE_ENABLED=1
# 32 bytes base64 (openssl rand -base64 32). Connect-only requirement.
# BRIDGE_TOKEN_KEY=
```

Real values live only in `.env` (or your secret store) — never in tickets, screenshots, or chat. The `BRG-` code is a credential too: anyone with it can pair a channel while it's live.

## Moderation notes

- Destination moderators **can delete copies** — they are normal webhook messages. Destination-side edits and deletes are never copied back (bridges are forward-only: source edits the destination, never the reverse).
- A source-side delete removes the copies on the other side (subject to the failure ladder above).
- `disconnect` deletes both relay webhooks (`Boiler Snake Bridge`) and releases both channels. Copies already posted are **not** deleted — clean up with Discord/Fluxer purge tools if you need to.
- Relay copies earn **no XP** on the destination; the source human earns XP normally on their own platform. Copies also never reach Gork, activity stats, or message caches.

## Troubleshooting

- **`/bridge status` first**: state (`pending` until the far side connects, `active` once paired), direction, outbox depth per direction, spool bytes, and `last error` — the fastest way to see *which* end is failing. Fluxer: `!bridge status` — the result comes back by DM.
- **Bridge stuck `pending`** → the far side hasn't consumed the code. Codes expire in 30 minutes; if it expired, run `create` again on the source side and connect promptly from the other platform.
- **`Set BRIDGE_TOKEN_KEY …` on connect** → set the key in `.env`, then run `connect` again with the *same* code: the failed connect leaves the code pending (no webhook was created, nothing to clean up).
- **`This process has no Fluxer client for <instance>` / `no Discord client`** → the process running the command can't reach one of the two ends. Connect only completes where both platforms are live; the code stays pending until it does.
- **`The "create" verb runs in a guild channel…` in a DM** → DMs run `!bridge connect` only; run `create`/`status`/`list`/`disconnect` in a guild channel (there, `status` and `list` results come back by DM).
- **Restart is safe**: bridges, queued copies, and encrypted tokens survive; in-flight sends resume from the spool. No config, no re-pairing.
- **Logs**: every bridge event is prefixed `[bridge]` — webhook creates, poison parks, notices, and failures with the bridge id, so one log line identifies the bridge.
- **`This guild is not registered as a community in this process`** → the guild isn't a bot community (Fluxer guilds register via [Fluxer instances](fluxer.md)); there is nothing to bridge until it is.
