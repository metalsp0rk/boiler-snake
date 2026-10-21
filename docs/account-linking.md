# Account linking (Discord ↔ Fluxer)

Account linking lets a member tie their **Discord account** to their **Fluxer account** so the bot treats them as the same person in exactly two ways: **XP earned on one side is mirrored to the other side** at a percentage you choose, and **gork memories written about them on one side are visible to gork on the other side**. Each side keeps its own totals, levels, roles, leaderboard rows, and memories — linking mirrors, it never merges.

Feature design and locked decisions live in the repo roadmap ([`roadmap/account-linking.md`](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/account-linking.md) on `main`); this page is the user/operator guide.

## What linking does

- **XP mirror.** When a linked user earns XP in one community (chat, reactions, voice, `/grantxp`, web grants), the linked account on the other side earns `round(delta × pct / 100)` XP in **its** community. The rate is configurable per direction, 0–100%, default 100.
- **Memory mirror.** Gork memories stored about a linked user in one community are copied to their linked account in the other, and gork's answers on both sides can draw on the merged set. Can be switched off per link.
- **Nothing else crosses.** No merged identity, no shared XP total, no cross-community staff view. Each community's XP row, level, roles, and leaderboard entry stay local — the mirror just adds ordinary rows on the far side.

Linking is **self-service**: no staff approval is needed, and users can only ever link their own accounts.

## Before you start: the bridge requirement

Linking is scoped to **bridge-paired communities**. The Discord server and the Fluxer community must have an **active channel bridge** between them (see [Channel bridges](bridge.md)) — links cannot be created between communities the deployment doesn't connect, and a code can't be redeemed on the same platform it was created on. This keeps mirrored XP and memories out of unrelated servers.

Both platforms must be running: see [Fluxer instances](fluxer.md) if the Fluxer side isn't set up yet.

## Linking: the code exchange

Linking works like bridge pairing: one side mints a **one-time code**, the other side redeems it. The code is the whole capability — shown once, works once, **expires in 15 minutes**. Codes look like `LNK-…` and are typed without spaces (spaces and the `LNK-` prefix are tolerated when you redeem).

**Direction 1 — create on Discord, connect on Fluxer:**

```
Discord, in #general:        /link create
  → ephemeral reply: LNK-… code (shown once, expires in 15 minutes)
Fluxer, in the paired community:
  !link connect LNK-…
  → channel ack: linked, code spent, details sent by DM (issue #276 — the
    pairing itself is private); the DM carries
    "Linked: Discord user <name> ↔ Fluxer user <name>. XP mirrors 100% both ways."
Check: /link status  ·  !link status
```

**Direction 2 — create on Fluxer, connect on Discord:**

```
Fluxer:        !link create
  → the LNK-… code arrives in your DM with the bot (shown once, 15 minutes);
    the channel only gets an ack that the code was sent by DM
Discord:       /link connect LNK-…
  → ephemeral confirmation naming both accounts
Check: /link status  ·  !link status
```

A code is rejected with a specific reason if it is **expired, already used, malformed, posted on the same platform that created it, or redeemed in a community that has no active bridge to the creating community**. If either account is already linked, the private reply (ephemeral on Discord, DM on Fluxer) names the side that's linked and the date its existing link was made — `!link remove` (or `/link remove`) on that side clears it first. The channel-visible reply on Fluxer for those conflict cases only says the link already exists: it never names who holds it and never echoes the code.

Fluxer has no ephemeral replies, so anything private rides the **DM path**: `!link create` sends the code to your DM (the channel never shows one), conflict details go by DM (the channel only says a link already exists), and the replies that name your linked peer — successful `connect`, `status`, `remove` — are **DM-first too** (issue #276): the channel gets a scrubbed ack that says what happened without publishing *your* pairing to everyone watching. If a DM can't be delivered the channel reply is just that delivery error (plus the bare outcome, e.g. "linked, code spent") — never the private body. Treat a minted code like a temporary ticket: it can be redeemed once, it dies in 15 minutes, and it is worthless on the platform it was created on. Codes also never stack up (#426): minting a new code **voids your previous unspent one** (one live code at a time), and `/link remove` voids any unspent codes on **both** sides. When someone redeems your code, the bot **DMs you** that it happened — naming the new peer and the defaults that start (XP mirroring 100% both ways, memory mirroring on). If that notice arrives as a surprise, run `/link remove` / `!link remove` and check your XP.

## Commands

Every verb exists on both platforms — `/link …` on Discord, `!link …` on Fluxer.

| Subcommand | What it does |
|------------|--------------|
| `/link create` · `!link create` | Mint a one-time link code for you. Shown once — ephemeral on Discord, by DM on Fluxer. Replaces any unspent code you minted earlier (one live code at a time, #426). |
| `/link connect <code>` · `!link connect <code>` | Redeem a code from the other platform's side. |
| `/link status` · `!link status` | Show your link: the peer account, the date it was created, mirror percentages, memory-mirror state. On Fluxer the pairing is delivered by DM; the channel only gets an ack. |
| `/link config <direction> <pct>` · `!link config <direction> <pct>` | Set the XP mirror rate. `direction` choices: `to-fluxer`, `from-fluxer`, `to-discord`, `from-discord`, `both`, plus the raw storage keys `a_to_b` (Discord → Fluxer) / `b_to_a` (Fluxer → Discord) — resolved against the **caller's** platform: a Discord caller uses `to-fluxer` / `from-fluxer`, a Fluxer caller `to-discord` / `from-discord`. `pct` is an integer 0–100 and must accompany a direction. |
| `/link config memory on\|off` | Turn gork memory mirroring on/off for the link. Off = no new mirrored writes and neither side's gork reads the other's memories (#425); already-mirrored rows stay until pruned. |
| `/link remove` · `!link remove` | Delete your link. Mirrored data already written stays (see Limitations). Unspent link codes on both sides are voided (#426). |

Fluxer uses named-style plain arguments (`!link connect LNK-…`, `!link config to-discord 50`); the Discord slash command offers the same as options (`direction:`, `pct:`).

**Mirror configuration examples** — rates are per direction and per link:

```
/link config direction:to-fluxer pct:50       → Discord XP flows to Fluxer at half rate
/link config direction:both pct:100           → both directions at full rate
!link config to-discord 50                    → Fluxer XP flows to Discord at half rate
!link config to-discord 0                     → stop mirroring that direction
/link config memory:off                       → stop copying gork memories
```

## How the XP mirror behaves

- **It's a fan-out, not a share.** A local award always lands in full on the earning side. The mirror writes a **separate** XP row on the far side at the configured rate. With 50%, earning 10 XP in the Discord server adds 5 XP to the user's row in the linked Fluxer community — their Discord total is untouched by it.
- **Levels, roles, and leaderboards follow.** The mirrored award runs the target community's normal award path, so the user's level, level-up role grants, and leaderboard position update there — displayed with their name on that platform.
- **One hop, always.** A mirrored award never mirrors back. There is no XP ping-pong, and rates above 50% can't compound.
- **Rounding.** Each mirrored award is rounded to a whole XP (`round(delta × pct / 100)`), per award, not accumulated. At rates like 33%, a mirrored total can sit a point or two away from the exact ratio.
- **Negative deltas mirror as negatives.** An XP adjustment of −20 at 50% mirrors as −10.
- **Decay is local.** [Decay](decay.md) acts on each community's own total. Because the mirror keeps earning activity symmetric at the configured rate, totals stay in proportion for activity — a decay tick on one side is not copied to the other.
- **A `pct` of 0 is a true off switch:** no mirror row, no audit row.

## How memory mirroring works

Gork's memory extraction writes what it learns about a person into that community's memory ([Gork](gork.md)). With memory mirroring on:

- **Writes fan out.** Each memory stored about a linked user is also stored for their linked account in the paired community, with the same content, date, and importance.
- **Mirror rows are separate rows.** They are keyed under an internal `lnk:` namespace, so a mirrored memory can never overwrite — or merge provenance with — a memory the linked account recorded for itself under the same title and date (#427). If both exist, both rows are simply visible. (Rows mirrored before that fix can share the local key space; they read fine, but their source-message provenance may be shared — prune via `/gork memory` in the target community if it matters.)
- **Reads expand.** When gork answers in one community, the memory set it reads for a linked user includes the memories stored on the far side. Answers stay inside gork's normal memory budget — mirrored entries compete with local ones by importance and recency, they don't grow the budget.
- **The switch governs both legs.** `/link config memory off` stops new mirrored writes AND stops either side's gork from reading the other's memories (#425). Rows already mirrored stay stored as history — `/link remove` plus pruning via `/gork memory` clears them. (Before that fix, "off" only stopped writes while reads quietly kept crossing whenever any link existed.)
- **Staff tools stay local.** `/gork memory` (and `!gork memory`) shows and manages **this community's** rows only. Deleting or forgetting a memory on one side does **not** delete its mirror on the other (see Limitations).

## Limitations

- **Unlinking is not retroactive.** `/link remove` stops all future mirroring immediately. XP rows and memories that were already mirrored stay where they are — they've been counted into leaderboards, role grants, and gork answers. Removing mirrored *data* has to be done per community (XP: staff XP adjustments; memories: `/gork memory` in that community).
- **Memory deletes don't cross the link.** Forgetting a memory on one side leaves the far-side copy in place.
- **The redemption notice is best-effort (#426).** If the bot cannot DM the code's creator (DMs closed, other side unreachable), the link still completes and the failure is only visible in the bot log — a missing notice does not prove nothing was redeemed. When in doubt, `/link status`.
- **One link per account per community, Discord↔Fluxer only.** No Discord↔Discord or Fluxer↔Fluxer links, and a user can't have two links in the same community.
- **Bridge teardown doesn't auto-revoke links.** The bridge is verified when the link is created. If the bridge is later disconnected, existing links keep mirroring until the users on both sides run `link remove`.
- **Rounding drift** at non-round percentages, as above.

## See also

- [Fluxer instances](fluxer.md) — running the Fluxer side of the pair
- [Channel bridges](bridge.md) — pairing the communities that linking requires
- [XP & leveling](xp-and-leveling.md) — how awards, levels, and cooldowns work
- [Decay](decay.md) — the local (unmirrored) XP decay
- [Leaderboard](leaderboard.md) — per-community standings
- [Gork](gork.md) — memories and memory budgets
- Design record: [`roadmap/account-linking.md`](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/account-linking.md) on GitHub
