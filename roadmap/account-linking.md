# 11. Discord ↔ Fluxer account linking (mirror sync)

| | |
|---|---|
| Author | Boiler Snake |
| Date | 2026-10-03 |
| Status | **Design approved (v1)** — supersedes the "no account linking" non-goals in [fluxer.md](fluxer.md) and [bridge.md](bridge.md) (annotated in place, history preserved). Written against the shipped code: `communities` (migration 034), `bridges` + `bridge_ends` (migration 035), `src/features/awardXp.js`, gork memory (`src/features/gork/memory.js`, migration 023). |
| Roadmap feature | 11 |
| Migration id | **036** — `src/db/migrations/036_user_links.js`. Highest shipped is 035 (`bridges`); 031 stays reserved by gork STE ([fluxer.md](fluxer.md) header, [index.md](index.md) §7). Do not hardcode a lower id. |
| Depends on | Shipped: `communities` + `assertCommunityId` (`src/platform/community.js`), the bridge pairing pattern (`src/features/bridge/`), `awardXp` as the single XP choke point (`src/services/awardXp.js`), gork memory upsert/list (`src/db/repositories/gorkMemory.js`), prefix dispatch with `handlerApi: "context"` (KD 17 in [fluxer.md](fluxer.md)). **No new env vars, no new secrets** (`.env.example` unchanged). |

This document is the implementation record for user-driven linking of a Discord account to a Fluxer account, scoped to bridge-paired communities, with **mirror fan-out** of XP and gork memories. Decisions in [Key Decisions](#key-decisions) are locked for v1.

---

## Overview

Users optionally link their Discord account to their Fluxer account. Once linked, the two identities cooperate in exactly two ways: **XP earned on one side is mirrored to the other side** at a configurable percentage, and **gork memories written about the user on one side are visible to gork on the other side**. Both effects are *mirror fan-out*: each side keeps its own rows — XP totals, levels, roles, leaderboard entries, memory rows — and nothing is merged into a single cross-platform identity.

Linking is **scoped to bridge-paired communities**. Creating a link verifies that an **active bridge** exists between the two communities (the pair that [bridge.md](bridge.md) connects). A user cannot link a Discord guild to a Fluxer community the deployment never talks to — that would inject phantom leaderboard rows and gork memories into unrelated communities.

The linking UX is the **in-chat one-time code exchange**, mirroring the bridge pairing pattern: one side runs `link create`, gets a short-lived single-use code, and the other side runs `link connect <code>`. The code is the capability; there is no web page and no admin approval.

The feature is self-service: **no staff requirement** on any of the five verbs. Callers always act on their *own* identity.

## Background & Motivation

The shipped platform model is deliberately firewall-hardened: [fluxer.md](fluxer.md) lists "One Boiler Snake user identity that spans platforms. No account linking." as a non-goal, and [bridge.md](bridge.md) rejects "any linking of Discord and Fluxer user accounts". That was right for the adapter and the bridge — neither may *imply* cross-platform identity — and the rejections stay true as history. This feature is the product decision that follows: operators running both platforms want a member's XP and gork memories to follow the *person*, not the deployment.

Why not a canonical merged identity? A merged total (one `users` row spanning platforms) breaks the community-scoped schema (034 lesson: every repository key is `communities.id`), breaks per-community leaderboards, and makes every XP read a cross-platform join. The user requirement is **separate XP rewards** with a known relationship between them — that is a mirror, not a merge.

Why mirror (fan-out), not share? Because each community's XP row stays the authority for that community: leaderboards, level→role grants, decay, and staff tools keep working community-locally with zero changes. The link only adds a write at the existing choke point.

Why require a bridge between the communities? Links are user-created; without a scope gate, any user could graft their Discord identity onto any Fluxer community the bot serves and start writing rows there. Requiring an active bridge between the pair reuses the operator's existing trust decision (staff connected these two communities) as the linking scope — no new allow-list table, no new config surface.

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| K1 | **Linking UX = in-chat one-time code exchange, both directions.** `link create` on Discord (`/link create`, ephemeral) + `link connect <code>` on Fluxer (`!link connect …`), and the reverse: `!link create` on Fluxer (in-channel reply, expiry noted) + `/link connect <code>` on Discord. Codes are minted for `(community_id, caller user id)`. | Mirrors the proven bridge pairing pattern (`src/features/bridge/`): the code *is* the capability, delivered in-chat, no components (Fluxer has none), no web UI, no staff approval. Both directions are symmetric in code; neither platform is privileged. |
| K2 | **XP sync = mirror fan-out, not a canonical merge.** Awarding XP to one linked account writes `round(delta × pct / 100)` to the linked account's XP row on the other side, through the normal award machinery. Per-direction rates are stored on the link: `mirror_a_to_b_pct`, `mirror_b_to_a_pct` (integers 0–100, default 100). | The user-facing contract is "separate XP rewards". A merged identity breaks per-community leaderboards and the 034 community keying. `pct = 0` turns one direction off. |
| K3 | **Scope = bridge-paired communities only.** Link creation verifies an **active** bridge connects the two communities. Redemption additionally requires the redemption community to be on the **opposite platform** of the code's creation community. | Prevents phantom leaderboard rows and gork memories in unrelated communities. Reuses the staff-operated bridge as the existing trust boundary. The opposite-platform rule is what makes a link genuinely cross-platform. |
| K4 | **Canonical orientation + identity firewall.** A link row stores the **Discord side as `a`** and the **Fluxer side as `b`** (by `communities.platform`); the service layer enforces `platform(a) !== platform(b)`. Every repository function takes the INTEGER `community_id` and calls `assertCommunityId` (`src/platform/community.js`) first, like every repo under `src/db/repositories/`. The link row is the **only** structure allowed to relate a Discord snowflake to a Fluxer `sub`. Raw id strings are never joined across platforms. | Same firewall as the shipped platform layer. Cross-platform joins that bypass the link row are untyped string equality between two unrelated id spaces — exactly the bug class 034 exists to kill. |
| K5 | **Code handling mirrors `src/features/bridge/codes.js`.** Crockford base32, single-sourced format logic, display form `LNK-XXXX-…` (mirrors the bridge's `BRG-` grouping). Only the SHA-256 digest is stored (like `bridges.code_hash`, 035); the plaintext exists once, in the create reply. Codes live **15 minutes**, are **single-use**, and are consumed atomically: `UPDATE user_link_codes SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?` checked via `changes` (the `consumeOAuthTransaction` pattern, `src/db/repositories/fluxerOAuthTransactions.js`). | Proven pattern, proven failure modes. Timing-safe digest comparison. A race between two concurrent `connect`s resolves to exactly one winner because the loser's `changes` is 0. |
| K6 | **Mirror is one hop (loop guard).** `awardXp` gains a `fanOut` option (default `true`); the mirrored award passes `fanOut: false`. A mirror award never fans out again. | Without the guard, a 100% link A→B re-mirrors B→A forever (and every intermediate rounding compounds). One hop is the semantics: earned on one side, appears on the other, stops there. |
| K7 | **Mirrored delta = `Math.round(delta × pct / 100)`, sign-preserving.** Negative deltas (e.g. admin adjustments) mirror as negative. `pct = 0` is a no-op (no row written, no audit row). | Integer XP everywhere; rounding at the fan-out seam, per award, never accumulated. Sign preservation keeps mirrors from turning a punishment into a reward. |
| K8 | **Mirrors go through the existing award machinery.** The fan-out resolves the target community's outbound client (`getCommunityClient(communityId)`), fetches the target member, and calls `awardXp` with the target `(community_id, user_id)`, the mirrored delta, `activityKind` **unchanged**, `source: "link_mirror"`, `fanOut: false`. Activity kinds are not renamed so decay and activity stats treat mirrored awards symmetrically. | Level/role math, cooldown-adjacent bookkeeping, and leaderboard visibility must run on the target community exactly as for a local award. A raw `addXp` would silently skip level→role grants. |
| K9 | **Memory mirroring = write fan-out + read fan-out.** Write: in `runMemoryTurn` (`src/features/gork/memory.js`), after each validated memory upserts for `(communityId, subject)`, if that user is linked and `mirror_memory = 1`, upsert the same entry (title/body/kind/importance/source-message ids) for the linked target `(community_id, user_id)`. Read: `loadMemoryContext` expands each involved id to its linked counterpart tuple and merges the results into the memory block inside the existing `budgetChars` budget (mirror rows compete by importance/recency via `selectMemories`). The gork `recall_memories` tool expands subject lookups the same way. `gorkMemoryGetById` stays community-local (handles are community-scoped). | Extraction results and answers are already generated; fan-out rides the same tables with zero schema change on the gork side. Budget competition (not budget growth) keeps prompt size bounded. |
| K10 | **Staff surfaces stay community-local; deletes never cascade.** `/gork memory` show/clear and gork forget act on the caller's community only. `link remove` deletes the **link row** — mirrored XP rows and memories already written are **not** retroactively removed. | Mirrored rows have been consumed by leaderboards, role grants, and answers. Retroactive deletion is a data-retention feature, not a linking feature, and pretending otherwise (silent cascade) breaks auditability. Documented as limitations, not bugs. |
| K11 | **One implementation, two surfaces.** `src/features/linking/` registers a `handlerApi: "context"` handler (the KD 17 pattern used by `xp` and `gork`) so Discord slash and Fluxer prefix share the code. Discord registers `/link` via the standard registry (`src/commands/registry.js`, `src/features/xp/commands.js` pattern); Fluxer routes through the shipped prefix parser/dispatcher (`src/platform/fluxer/commands.js`, `dispatch.js`). | One handler tree means one set of error messages, one service, one test surface. Divergence between platforms is the maintenance bug this pattern exists to prevent. |

## Command surface (v1)

Self-service on both platforms — no staff gate. Discord replies that are private use ephemeral; Fluxer has no ephemerals, so private-shaped replies there are in-channel messages that carry the code with an explicit expiry note (the code is single-use and 15-minute-lived).

| Subcommand | Discord | Fluxer | Behavior |
|---|---|---|---|
| `link create` | `/link create` | `!link create` | Mint a one-time `LNK-…` code for `(community, caller)`. Ephemeral reply on Discord; in-channel reply on Fluxer noting the expiry. Shown once. |
| `link connect <code>` | `/link connect` | `!link connect <code>` | Redeem. Code must exist, be unexpired, be unused, have been created on the **opposite platform**, and the two communities must be bridge-paired (K3). Creates the link; marks the code used atomically. If either side already has a link: refused, naming the side that is linked and its existing link date. |
| `link status` | `/link status` | `!link status` | Caller's link: peer display name/id (via the peer community's `fetchMember`), created date, both mirror percentages, memory-mirror state. Not linked → specific "no link" reply. |
| `link remove` | `/link remove` | `!link remove` | Caller must be a party of the link. Deletes the link row. Mirrored XP/memories already written stay (K10). |
| `link config <direction> <pct>` | `/link config` | `!link config <direction> <pct>` | Caller must be a party. `direction` is `discord-to-fluxer` (maps to `mirror_a_to_b_pct`) or `fluxer-to-discord` (`mirror_b_to_a_pct`). Integer 0–100; out-of-range is a specific refusal. |
| `link config memory <on\|off>` | `/link config memory …` | `!link config memory <on\|off>` | Caller must be a party. Sets `mirror_memory`. |

Example pairing, start to finish (Discord creates, Fluxer connects):

```
Discord user, in #general:   /link create
    → ephemeral reply: LNK-… code (shown once, expires in 15 minutes)
Fluxer user, in the paired community:
    !link connect LNK-…
    → "Linked: Discord user <name> ↔ Fluxer user <name>. XP mirrors 100% both ways."
Both sides:  /link status  ·  !link status
```

The reverse direction (`!link create` on Fluxer, `/link connect` on Discord) is the same exchange with the sides swapped.

## Data model (migration 036)

Style follows `src/db/migrations/035_bridges.js` (`IF NOT EXISTS`, index conventions, `up` refuses to run without `communities`).

```sql
CREATE TABLE IF NOT EXISTS user_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id_a INTEGER NOT NULL,          -- Discord side (canonical, K4)
  user_id_a      TEXT NOT NULL,             -- external user id in that community's platform
  community_id_b INTEGER NOT NULL,          -- Fluxer side (canonical, K4)
  user_id_b      TEXT NOT NULL,
  mirror_a_to_b_pct INTEGER NOT NULL DEFAULT 100,  -- XP earned in A → mirrored to B
  mirror_b_to_a_pct INTEGER NOT NULL DEFAULT 100,
  mirror_memory INTEGER NOT NULL DEFAULT 1,       -- gork memory mirroring on/off
  created_at INTEGER NOT NULL,
  UNIQUE (community_id_a, user_id_a),
  UNIQUE (community_id_b, user_id_b)
);

CREATE TABLE IF NOT EXISTS user_link_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,           -- SHA-256 of the plaintext code
  community_id INTEGER NOT NULL,            -- community where the code was CREATED
  user_id TEXT NOT NULL,                    -- external user id at creation side
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,              -- now + 15 min
  used_at INTEGER                           -- NULL until redeemed (single use)
);

CREATE INDEX IF NOT EXISTS idx_user_links_a ON user_links(user_id_a, community_id_a);
CREATE INDEX IF NOT EXISTS idx_user_links_b ON user_links(user_id_b, community_id_b);
CREATE INDEX IF NOT EXISTS idx_user_link_codes_expires ON user_link_codes(expires_at);
```

The two UNIQUE pairs make the link **1:1 per community**: a user has at most one link per community, and a `(community, user)` tuple appears on at most one side of one link. The reverse-lookup indexes serve the hot paths: fan-out resolves `a→b` and `b→a` by `(user_id, community_id)`; the sweeper GCs expired codes by `expires_at`.

**Bridge-pair check** (against the shipped 035 schema — bridges carry no community columns; the ends do):

```sql
SELECT 1 FROM bridges b
  JOIN bridge_ends ea ON ea.bridge_id = b.id AND ea.community_id = :a
  JOIN bridge_ends eb ON eb.bridge_id = b.id AND eb.community_id = :b
 WHERE b.state = 'active'
 LIMIT 1;
```

Note the design-bundle draft sketched this as `bridges.end_a_community_id`-style columns; the shipped schema puts communities on `bridge_ends` (`position a/b`, `035_bridges.js:47-61`). The check above is the corrected, shipped-schema form.

## Sync semantics

### XP mirror (the fan-out seam)

`awardXp(outbound, { communityId, externalGuildId, userId, delta, activityKind, member, levelXpFactor, source })` in `src/services/awardXp.js` is the single choke point — voice XP, `/grantxp`, message/reaction XP, and web grants all flow through it and all inherit the mirror.

1. The **primary award** completes first (`addXp` + activity log). The mirror never blocks, delays, or reverses a local award.
2. `fanOutLinkedXp(communityId, userId, delta, activityKind)` resolves the link for the **source** side. No link, `mirror_memory`-independent → done. `pct === 0` for this direction → no-op.
3. Mirrored delta = `Math.round(delta * pct / 100)` (K7). The target side is the opposite end of the link row.
4. The mirrored award is a **real `awardXp` call** against the target community: target outbound via `getCommunityClient`, `member` fetched through the target outbound, `source: "link_mirror"`, `fanOut: false` (K6 loop guard). Level thresholds, role grants, and leaderboard rows on the target side are computed by the existing machinery.
5. **Partial failure is never fatal to the caller.** Every fan-out failure (no target client, member fetch fails, role sync fails) is collected as a `{ target, error }` warning and returned on the award result (`{ ok: true, …, linkMirror: { awarded, warnings } }` — additive, back-compatible) and logged as `[linking] …` with `(community_id, user_id, delta)` ids. The local award always stands.
6. **No recursion by construction.** The mirror call's `fanOut: false` ends the chain at one hop.

*Example:* Discord `mirror_a_to_b_pct = 50`. A user earns 10 XP in the Discord guild → Discord row +10, mirrored `round(10×50/100) = 5` on the Fluxer side. A decay tick of −40 on Discord is **not** mirrored (decay writes `setXp` directly in `src/features/decay/index.js` — untouched, out of scope for the seam).

### Memory mirror

- **Write fan-out** lives inside `runMemoryTurn`'s validated-upsert loop (`src/features/gork/memory.js`): each stored memory for a linked subject with `mirror_memory = 1` fans out to `gorkMemoryUpsert` at the target `(community_id, user_id)`, same date/title/body/kind/importance/source-message ids, subject to the same per-person cap. Upsert failures accumulate warnings (surfaced to gork debug/interaction logs, never to the answer path — the extraction answer has already been sent).
- **Read fan-out** extends `loadMemoryContext`: for each involved roster id with an active link, `gorkMemoryListForSubjects` also runs for the target tuple, and the merged set competes for `budgetChars` via `selectMemories` (importance, recency). Gork in community B can therefore answer with what it learned about the user in community A.
- **Recall tool**: `executeRecallMemory` subject-listing expands to the linked counterpart tuple. By-id get stays community-local.

### Staff surfaces

`/gork memory` show/clear, gork forget, XP admin views, and leaderboards stay **community-local**: they show and mutate the rows of the community they run in. Mirrored rows are ordinary local rows on the target side. There is no cross-community staff view in v1.

## Known limitations (v1)

1. **Unlinking is not retroactive.** `link remove` stops future mirroring; XP rows and memories already mirrored stay. They have been consumed by leaderboards, role grants, and gork answers. Removing a user's mirrored *data* is a data-retention operation, out of scope for v1.
2. **Memory deletes do not cascade.** Deleting/forgetting a memory in one community never deletes its mirror on the other side. Staff tooling stays community-local (K10); cross-community purge is a follow-up candidate.
3. **Mirror rounding drift.** `Math.round` is applied per award, never accumulated, so at percentages like 33% the mirrored total can sit up to 1 XP per award away from the ideal ratio. This is the accepted cost of integer-per-award mirrors.
4. **The bridge is checked at link creation, not per mirror.** If the bridge between the pair is later disconnected, existing links keep mirroring until someone runs `link remove` (the fan-out resolves only link rows). There is no automatic revocation on bridge teardown in v1; removing links after teardown is an operator/user action.
5. **Fluxer has no ephemeral replies.** The `!link create` code is posted in-channel with an expiry note. The mitigation is the credential's shape: single-use, 15-minute lifetime, and useless on the same platform (K3 rejects same-platform redemption).
6. **No multi-linking.** One link per user per community, Discord↔Fluxer only (K4). Discord↔Discord and Fluxer↔Fluxer links are not a v1 concept.

## Rollout notes

- **T1** migration 036 + `src/db/repositories/userLinks.js` + facade aliases (isolated; migration tests follow the existing "reopen" pattern).
- **T2** linking service + codes (`src/features/linking/service.js`, `codes.js`) — mint/redeem/status/config/remove.
- **T3** command surfaces: Discord slash JSON + registration, Fluxer prefix registry entries, one context-API handler (K11).
- **T4** XP fan-out in `src/services/awardXp.js` (K2/K6/K7/K8) — the only touch to shipped non-linking code in the XP path.
- **T5** gork memory write/read fan-out (K9) — touches `src/features/gork/`; independent of T4.
- **T6** tests: unit (service: mint/redeem happy, expired, double-use race, invalid format, same-platform reject, unpaired-community reject, unique conflicts, pct math incl. negative deltas) and integration (offline full-stack: linked pair over a real bridge row, Discord message → mirrored Fluxer total, `!xp` shows it, `pct 0` no-op, no recursion, memory visible across the pair).
- **T7** docs: `docs/account-linking.md` (operator/user guide), VitePress nav, `docs/fluxer.md` cross-link, `AGENTS.md` features list. Docs ship last so the tone matches the landed command surface. `npm run docs:build` must pass with zero dead links; docs pages link to `roadmap/` only via absolute GitHub URLs.

No new env vars and no new secrets: `.env.example` is unchanged by this feature.

## See also

- Feature spec (platform adapter): [fluxer.md](fluxer.md)
- Feature spec (channel bridge, pairing pattern): [bridge.md](bridge.md)
- User guide: `docs/account-linking.md` (repo `docs/` tree)
