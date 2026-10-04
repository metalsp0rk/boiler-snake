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
  → "Linked: Discord user <name> ↔ Fluxer user <name>. XP mirrors 100% both ways."
Check: /link status  ·  !link status
```

**Direction 2 — create on Fluxer, connect on Discord:**

```
Fluxer:        !link create
  → in-channel reply: LNK-… code (Fluxer has no private replies — the code is
    single-use and expires in 15 minutes)
Discord:       /link connect LNK-…
  → ephemeral confirmation naming both accounts
Check: /link status  ·  !link status
```

A code is rejected with a specific reason if it is **expired, already used, malformed, posted on the same platform that created it, or redeemed in a community that has no active bridge to the creating community**. If either account is already linked, the reply names the side that's linked and the date its existing link was made — `!link remove` (or `/link remove`) on that side clears it first.

Fluxer has no private replies, so `!link create` posts the code **in the channel** with its expiry noted. Treat it like a temporary ticket: it can be redeemed once, it dies in 15 minutes, and it is worthless on the platform it was created on.

## Commands

Every verb exists on both platforms — `/link …` on Discord, `!link …` on Fluxer.

| Subcommand | What it does |
|------------|--------------|
| `/link create` · `!link create` | Mint a one-time link code for you. Shown once. |
| `/link connect <code>` · `!link connect <code>` | Redeem a code from the other platform's side. |
| `/link status` · `!link status` | Show your link: the peer account, the date it was created, mirror percentages, memory-mirror state. |
| `/link config <direction> <pct>` | Set one mirror direction. Direction is from the **source** side's point of view: `discord-to-fluxer` or `fluxer-to-discord`. Integer 0–100. |
| `/link config memory on\|off` | Turn gork memory mirroring on/off for the link. |
| `/link remove` · `!link remove` | Delete your link. Mirrored data already written stays (see Limitations). |

Fluxer uses named-style plain arguments (`!link connect LNK-…`, `!link config fluxer-to-discord 50`); the Discord slash command offers the same as options.

**Mirror configuration examples** — rates are per direction and per link:

```
/link config direction:discord-to-fluxer percent:50   → Discord XP flows to Fluxer at half rate
!link config fluxer-to-discord 50                     → Fluxer XP flows to Discord at half rate
!link config fluxer-to-discord 0                      → stop mirroring that direction
!link config memory off                               → stop copying gork memories
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
- **Reads expand.** When gork answers in one community, the memory set it reads for a linked user includes the memories stored on the far side. Answers stay inside gork's normal memory budget — mirrored entries compete with local ones by importance and recency, they don't grow the budget.
- **Staff tools stay local.** `/gork memory` (and `!gork memory`) shows and manages **this community's** rows only. Deleting or forgetting a memory on one side does **not** delete its mirror on the other (see Limitations).

## Limitations

- **Unlinking is not retroactive.** `/link remove` stops all future mirroring immediately. XP rows and memories that were already mirrored stay where they are — they've been counted into leaderboards, role grants, and gork answers. Removing mirrored *data* has to be done per community (XP: staff XP adjustments; memories: `/gork memory` in that community).
- **Memory deletes don't cross the link.** Forgetting a memory on one side leaves the far-side copy in place.
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
