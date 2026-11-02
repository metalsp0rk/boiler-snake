# Ban Lifecycle (#772)

Discord bans have no native duration. This feature adds the bot-side **lifecycle** around every ban the bot executes: one durable ban record (**B-n**) per ban cycle, a **ban-time DM** showing when the ban ends, an **auto-unban** when it expires, a **welcome-back DM** on any unban (auto or manual), and a **rejoin fallback** when a DM could not be delivered. Bans from `/ban`, the **Ban member** menu, and automod's `ban` tool all execute through ONE ban service, so every ban gets the same guards, the same record, and the same notifications.

**On Fluxer:** no. #772 records an explicit **NO-PARITY**: the ban lifecycle is Discord-only — `/ban`, `/bannotify`, the **Ban member** user context menu, the Reason/Duration modal, and both notice DMs have no path through Fluxer's prefix dispatcher, and none is planned in this feature. A Fluxer dispatch reaching the ban surface answers the standard Discord-only refusal: `That command is not available on Fluxer yet.` See [Fluxer instances](fluxer.md).

## How it works

```
Staff: /ban <member> [reason] [duration]   or   right-click → Apps → Ban member
        → admin gate (Manage Guild) → shared Reason/Duration modal when a field is missing
        → guards: duplicate active ban · self-ban · staff-subject (#729) · role hierarchy
        → ban DM FIRST (while the shared-guild DM path still exists; a DM failure
          never blocks the ban — logged with ids and surfaced staff-side)
        → Discord ban executes → record row B-n (expires_at NULL = permanent)

Expiry ticker `ban-expiry` (minute-aligned, immediate pass on boot)
        → due rows: CAS claim → Discord unban
          ("Expired — auto-unban (banned <t:F> by <staff>)") → expired_unbanned
        → welcome-back DM (exactly one per ban cycle)

Any manual unban (other staff / another bot — GuildBanRemove)
        → record settles unbanned_manual (manual beats ticker) → same welcome DM

Welcome DM undeliverable (DMs closed, missed event) → record parks as pending_rejoin
        → rejoin within 30 days (GuildMemberAdd) → ONE retry → welcomed regardless

Bot downtime → boot: expired rows unban immediately on the first pass, then a
        bounded `guild.bans` reconciliation settles records whose ban vanished
        (log-only — no retroactive DMs)
```

## `/ban` + modal rules

`/ban <member> [reason] [duration]` runs inline only when **both** fields are present; either one missing opens the shared Reason/Duration modal (the **Ban member** context menu always opens it — the menu carries no options). A slash-provided duration is validated BEFORE any form opens.

| Rule | Detail |
|------|--------|
| **Reason** | Required (paragraph). Goes to the ban record AND the Discord ban reason. Cap 1000 chars |
| **Duration** | Optional (short text). `<n><s/m/h/d>` — `90m`, `24h`, `7d` (case-insensitive, inner whitespace ok) |
| Permanent | `permanent` or blank → no expiry (`expires_at` NULL); staff lift it manually |
| Bounds | Floor **60 s**, cap **365 d**. Exactly at a bound is valid; beyond it is refused — never silently clamped |
| Never act on a misread (#745) | An unparseable Duration answers with an ephemeral refusal naming the exact field + example, and **nothing is banned** — zero outbound, zero DB writes |
| Modal token | One-shot form (TTL 10 min). A double submit or replay reads "expired" — never bans twice |

Reject example (input `3x`):

```
**Duration:** `3x` isn't a duration (a number followed by `s`, `m`, `h`, or `d`). Use 24h or 7d (seconds, minutes, hours, or days), or type `permanent`. Nothing was banned.
```

Expired-form refusal: `**Modal expired:** the ban form closed — nothing was banned. Open it again with `/ban` or the **Ban member** menu.`

Staff confirmation (ephemeral):

```
**Banned:** <@USER_ID> (**B-12**).
**Expires:** <t:1761984000:F> (<t:1761984000:R>)
**Ban DM:** sent.
```

Permanent bans answer `**Duration:** permanent — no auto-expiry; staff lift it manually.` instead of the expiry line; a disabled toggle answers `**Ban DM:** off for this server — \`/bannotify ban on\` turns it back on.`

## Guards

Every refusal is specific and says **"Nothing was banned."** — no generic failures.

| Guard | Behavior |
|-------|----------|
| Duplicate active ban | Refused: `This member is already banned — see records (**B-12**, …). Nothing new was done.` A partial-unique index admits only ONE active row per (community, user), so a race can never double-active |
| Self-ban | Moderator and target are the same member → refused |
| Staff subject (#729) | Holders of any `staff_roles` role — and any holder of the **Manage Guild** permission — are never banned: "Bans never execute against guild staff" |
| Role hierarchy | Subject's top role ≥ bot's highest role → refused naming both positions ("move the bot's role up"). Unresolvable hierarchy REFUSES — never a silent pass |
| Discord API causes | Translated specifically, e.g. **Missing Access 50013** → checklist: bot holds **Ban Members**, bot role above the target, no higher role protecting them |

## Ban-time DM (before the ban executes)

Sent while the shared-guild DM path still exists (DM law K2); **the ban runs regardless of DM outcome** — a failure is logged `[banlifecycle]` with ids and surfaced as a staff-side notice, never an apology. Expiring bans render BOTH Discord-localized stamps (`:F` calendar + `:R` relative):

> You have been banned from **Guild Name**. This ban **expires:** <t:1761984000:F> (<t:1761984000:R>). You're welcome back after that — if you'd like to discuss the situation, any staff member is happy to help.

Permanent variant:

> You have been banned from **Guild Name**. This ban **has no set expiry:** staff may lift it at their discretion. If you'd like to discuss the situation, any staff member is happy to help.

The DM **never** names the moderator, automod case ids, staff notes, or warning history. Payloads carry `allowedMentions: { parse: [] }`.

## Welcome-back DM + rejoin fallback

On ANY unban of a tracked ban (auto-expiry or manual by any staff/other bot), one welcome DM — exactly once per ban cycle (claim-row law, no double-DMs):

> You've been unbanned from **Guild Name**. You're welcome back — we hope to see you around again. If you'd like to talk about what happened, any staff member is happy to help.

The copy deliberately never says WHO unbanned. If delivery fails or the event is missed, the record parks as `pending_rejoin`; on `GuildMemberAdd` with an unban within the last **30 days** (`REJOIN_WELCOME_WINDOW_DAYS`), one retry runs and the record goes `welcomed` regardless of the outcome.

The guild-side (audit-visible) expiry unban reason may name the moderator: `Expired — auto-unban (banned <t:UNIX:F> by <staff>)` — never in user DMs.

## Notice toggles (`/bannotify`)

| Command | Guild setting | Default | Effect when on |
|---------|---------------|---------|----------------|
| `/bannotify ban on\|off` | `ban_dm` | **on** | Every tracked ban DMs the member first (a failed DM never blocks the ban) |
| `/bannotify welcome on\|off` | `welcome_back_dm` | **on** | Any unban (auto-expiry or manual) sends exactly one welcome DM |
| `/bannotify status` | — | — | Read both toggles (ephemeral) |

Both notices ship **on** (non-destructive) — flip either at any time. Off means total silence; parked rejoin retries stay parked. Every toggle mutation lands an audit row + the `/automodconfig`-style audit-embed.

## Automod `ban` tool (#738 seam)

The automod executor's ban arm executes through the SAME ban service with `source: automod` — same guards, DM-first law, B-n record, and expiry tracking; the record is unattributed (system actor) and earns a system-origin audit row. Ban-DM failures are logged by the service with ids and deliberately never echoed into case-channel copy. (Honeypot's Discord arm still uses its raw ban path — deliberately NOT re-routed, due to the #440 mass-ban breaker entanglement.)

## Record & status machine

One row per ban cycle in `ban_records`; human ref **B-{n}** is sequential per guild (sibling of W-n / A-n).

| Status | Meaning |
|--------|---------|
| `active` | Ban in force — the only row the per-(community, user) partial UNIQUE admits |
| `expired_unbanned` | The expiry ticker lifted the ban |
| `unbanned_manual` | Lifted outside this bot (staff unban event, another tool, or boot reconciliation) |
| `pending_rejoin` | Unbanned, welcome DM not delivered — retry parked for rejoin |
| `welcomed` | Rejoin welcome attempt made (regardless of delivery outcome) |

```sql
CREATE TABLE ban_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  ban_number INTEGER NOT NULL,        -- sequential per guild (B-12)
  user_id TEXT NOT NULL,
  moderator_id TEXT,                  -- NULL = automod / system actor
  source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','automod')),
  reason TEXT NOT NULL,
  banned_at INTEGER NOT NULL,
  expires_at INTEGER,                 -- NULL = permanent
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','expired_unbanned','unbanned_manual','pending_rejoin','welcomed')),
  ban_dm_sent INTEGER NOT NULL DEFAULT 0,
  welcome_dm_sent INTEGER NOT NULL DEFAULT 0,
  unban_claimed_at INTEGER,           -- CAS lease for the auto-unban claim
  unban_reason TEXT
);
```

Migration `074_ban_lifecycle` (also adds `guild_settings.ban_dm` / `welcome_back_dm`, both `DEFAULT 1`). The record `id` is a stable handle by contract. All settles are first-writer-wins CAS (claim → act → finalize): a losing claimer performs zero outbound calls and reports the live row.

## Audit

| Action | Origin |
|--------|--------|
| `banLifecycle.ban` | Staff command layer (per executed ban) + system row for automod-origin bans |
| `banLifecycle.ban_dm_set` / `banLifecycle.welcome_dm_set` | `/bannotify` mutations (recordSlashAudit + audit embed) |
| `banLifecycle.expiry_unban` / `banLifecycle.external_unban` / `banLifecycle.rejoin_welcome` | System (ticker / GuildBanRemove / rejoin); each auto-unban also posts a staff-log embed on the audit channel |

## Known gaps

- Members with **DMs closed** get no ban/welcome DM — the failure is logged as a warning with ids and surfaced staff-side; the ban/unban executes regardless
- **Honeypot bans are not tracked** here (raw path, #440 breaker) — no record, no expiry, no notices
- Bans made **outside the bot** never get a record — the lifecycle tracks only bans it executes (the unban event path only settles already-tracked bans)
- Downtime reconciliation is **log-only**: vanished bans settle `unbanned_manual` with no retroactive DMs
- Fauxcord E2E does not cover DM interactions — the offline integration suite carries that bar

## Design decisions

1. **One service, one record** — the staff command/menu surfaces and the automod harness all share `banService.banUser`; no parallel ban stores
2. **DM before the ban** (K2): the shared-guild DM path is the only reliable route; the ban never depends on delivery
3. **Expiring bans show `:F` AND `:R`** — Discord localizes both client-side
4. **Claim-row idempotence** — one ban DM, one auto-unban, one welcome per cycle, even across restarts and duplicate events
5. **Manual beats ticker** — a staff unban settling the record wins the CAS; the expiry pass reports the truth instead of overwriting
6. **Never act on a misread (#745)** — refusals name the exact field, give an example, and ban nothing
7. **Staff-subject guard (#729) mirrored** — staff roles and Manage Guild carriers are unbannable by this bot; unresolvable reads refuse closed
8. **Both toggles default on** — non-destructive notices; every DM outcome lands in the audit trail
9. **#773 seams locked** — the ban DM builder accepts a future `components` (Appeal button) with no copy change; the record `id` is the stable appeal handle (`appeal:<banRecordId>`); the status machine is append-only (773 adds `clemency_granted` via a new migration)

## Related

- [Commands reference](commands/index.md) — `/ban`, `/bannotify`, "Ban member"
- [Configuration](configuration.md) — `ban_dm` / `welcome_back_dm` per-guild rows
- [Warnings](warnings.md) — the W-n record this mirrors as B-n; the warn-DM/ticker idioms reused
- [Auto-moderation](automod.md) — the `ban` action tool routes through this service (#738)
- [Staff roles](staff-roles.md) — who the staff-subject guard protects
- [Audit Log](audit-log.md) — where the unban embeds post
- [Fluxer instances](fluxer.md) — platform matrix (ban lifecycle: Discord-only)
- GitHub issues: **#772** (this feature); **#773** previews on it — ban appeals will key off the stable record id (`appeal:<banRecordId>`) and add an Appeal button to the ban DM
