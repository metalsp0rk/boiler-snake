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
        → due rows: CAS claim → #809 RE-BAN GUARD: fetch the LIVE ban and
          compare its reason against the fingerprint captured at issue
          (`ban_identity_reason`):
            match (or pre-#809 row, marker NULL) → Discord unban
              ("Expired — auto-unban (banned <t:F> by <staff>)") → expired_unbanned
              → welcome-back DM (exactly one per ban cycle)
            MISMATCH (staff lifted + re-banned meanwhile) → HELD: the auto-unban
              is never executed, no welcome DM, row terminal `expired_held`
              + `banLifecycle.expiry_held` audit + caution embed on the audit
              channel — staff owns whatever ban is live now
            unreadable (not the 10026 "not banned") → FAIL CLOSED: nothing is
              unbanned, the row stays claimed ACTIVE and retries past the lease
        → #810 QUARANTINE VALVE: every REAL (claim-winning) failure counts one
          `expiry_attempts` — a pass that LOST the claim did no work and files
          nothing. After EXPIRY_MAX_ATTEMPTS (20 ≈ 3.3h of lease-paced retries)
          the row settles terminal `expiry_failed`: it LEAVES the sweep forever
          (chronically failing rows can no longer starve the oldest-first
          slice), nothing is lifted, no welcome is possible, and staff get the
          loud `banLifecycle.expiry_quarantined` audit + danger embed — a human
          must handle the live ban by hand

Any manual unban (other staff / another bot — GuildBanRemove)
        → record settles unbanned_manual (manual beats ticker) → same welcome DM

Welcome DM undeliverable (DMs closed, missed event) → record parks as pending_rejoin
        → rejoin within 30 days (GuildMemberAdd) → ONE retry → welcomed regardless

Bot downtime → boot: expired rows unban immediately on the first pass, then a
        bounded `guild.bans` reconciliation settles records whose ban vanished
        (log-only — no retroactive DMs). #810: the bounded community window
        ROTATES across boots — never-reconciled guilds first, then
        least-recently-reconciled (the `ban_reconcile_state` attempt stamp),
        so with more active-ban guilds than the cap, every guild is reached
        over successive boots instead of a static top-N owning every boot
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

## Ban Appeals (#773)

Every **tracked** ban earns an appeal path: the ban DM gains an **Appeal this ban** button, pressing it files a statement into a private **staff appeal ticket**, and the bot **ferries** the conversation between the banned user's DMs and that ticket (they cannot see the server — the bot is their only channel). Staff resolve with **Grant clemency** (unban + permanent re-join invite DM'd) or **Appeal denied**; a plain close ends the conversation neutrally. Filing is **one appeal per ban cycle**, enforced by schema.

**On Fluxer:** no. #773 records an explicit **NO-PARITY**: the ban-DM button, the statement modal, the header buttons, and the ferry relay are all Discord component mechanics with no Fluxer path; `/banappeals` on a Fluxer context answers `That command is not available on Fluxer yet.`, and a non-Discord community reaching the ticket opener is refused outright. See [Fluxer instances](fluxer.md).

### How the appeal flows

```
Banned user: "Appeal this ban" on the ban DM (customId appeal:<banRecordId>)
        → press battery: presser == the record's user · record `active` ·
          guild ban_appeals ON · no appeal filed for this cycle yet —
          every failure is an ephemeral naming its cause, ending
          "Nothing was filed."; OK opens the statement modal
        → modal (Appeal statement, required, cap 4000) — the FULL battery
          runs AGAIN on submit; UNIQUE(ban_record_id) is the one-shot belt
        → appeal row `filed` → staff-only appeal ticket (the SHARED ticket
          pipeline, staff-self branch — the banned user is NEVER a member)
          → header + 3 buttons → status `open`
        → confirmation DM (relay rules stated up-front) and the ban-DM
          button edits away to `**Appeal:** filed <timestamp>`

While `open` — the ferry, both directions (plain human messages only)
        → user DM → ticket as `**<username · id>:** text` + images/video
        → ticket → user DM as `**<staff display>:** text` + images/video
        → audio/sticker/poll/forwarded/component/embed-only → NOT shared:
          the SENDER gets the per-kind "not shared" notice, the other side
          stays silent

Staff decision (claim-row UPDATE … WHERE status='open' — first wins)
        → Grant clemency: spend the cycle's welcome FIRST → unban → record
          `clemency_granted` → mint permanent invite → ONE DM (lift + invite)
          → ticket close→archive
        → Appeal denied: optional-reason modal → denial DM (timed bans get
          eligibility restated) → ticket close→archive
        → plain close (ticket channel deleted while still `open`): neutral
          DM, the ban untouched, status `closed`

The ban ENDS with the appeal still pending (#811 — expiry auto-unban, staff
lift outside the bot, or boot reconciliation; never a HELD expiry, #809):
        → system auto-close (CAS 'filed'|'open' → `closed`, decided_by
          `system:ban-ended`) → staff-side system note in the ticket →
          shared ticket close → audit `banAppeals.closed_ban_ended`
        → NO user DM — the ban-end itself already speaks (welcome-back DM,
          or reconcile's log-only law); the ferry stops with the status
```

The DM lane (`appeal:`, `appeal:s:`) is guildless: banned users carry no guild context, so the feature binds its OWN `InteractionCreate` listener (the command router drops guildless interactions and stays untouched). The in-ticket family (`ap:clemency:` / `ap:deny:` / `ap:deny:m:` / `ap:pause:`) rides the registered router with the usual staff gate. Community resolution is through the ban record's own row — a guildless press never guesses a guild.

### Intake rules

| Rule | Detail |
|------|--------|
| **Press validation** | Presser must equal the record's banned user (`**Appeal:** this button belongs to a different member's ban — …`); a stale or forged press is refused AND logged with ids |
| Tracked record only | No record behind the id → `**Appeal:** this appeal link no longer points at a tracked ban record — the record was removed, or the ban happened outside the bot (honeypot and external bans carry no appeal path). Nothing was filed.` A cross-community forged id gets the SAME answer — a probe learns nothing |
| Ban must be `active` | Lifted / expired / decided cycles read `**Appeal:** that ban is no longer active — …its appeal window is closed. Nothing was filed.` |
| Guild toggle | `ban_appeals` off → `**Appeals:** are turned off in this server — an admin can open them with `/banappeals enable`. … Nothing was filed.` |
| **One per ban cycle** | `UNIQUE(ban_record_id)` (migration 075) is schema law; the refusal keys the LIVE status — granted / denied / closed / in-review each get their own sentence (the closed one: "…one appeal per ban is all this cycle gets.") |
| **Statement** | Required paragraph, cap **4000** chars (the modal clamps; validation belts). Goes into the ticket **verbatim** |
| Ticket failure = pending truth (#730) | Statement saved but no channel → the appeal row STAYS `filed` with NULL ticket; the user gets the specific cause (`**Appeal:** your statement was saved, but the private staff review channel could not be opened (…)`), never a "filed" claim. The row + the loud `[appeals]` log are the pending surface |
| Every refusal | Names its specific cause and ends **"Nothing was filed."** — no generic drop exists in the battery |

### The appeal ticket

Opened through the SHARED ticket pipeline (`openTicketChannel`, the #745 staff-self branch) — the banned user is never the creator, never an overwrite target, never DM'd from here. The ticket is owned by the ban's HUMAN moderator (the report-flow analogue), falling back to the GUILD OWNER for unattributed automod bans; both identities are re-checked so a planted id can never put the banned user or the bot into the overwrite set. The channel is best-effort renamed `appeal-B<n>-<userid>` (a failed rename keeps the functional `ticket-N` name).

Above the header embed, the relay law is stated in plain message content (the header **embed** is on the never-relayed list, so nothing user-relevant hides in it):

> **Relay:** everything typed in this channel is relayed to the appealing user **verbatim** — this ticket is their only window into the server.
> **Shared:** text, images, and video only.
> **Never shared:** reactions, embeds, audio, stickers, polls, forwarded messages, and button messages — anything un-sharable gets its sender a specific notice here.
> **Pause relaying** silences the ferry in both directions so staff can discuss internally; the relay is **on by default**.

The header embed (staff-only): escaped user card (code-wrapped inert `<@!id>` + id text — **no live ping**), the ban summary (B-n, banned/expiry stamps, reason, **moderator** — staff-side content, §6 only forbids *ferrying* it), active-warning / live-staff-note **refs** (bodies stay on their own pages), and the statement verbatim in a code fence. Footer: "Staff-only card — this header is NEVER relayed to the user. Everything typed in the channel is."

Three buttons: **Grant clemency** (`ap:clemency:`), **Appeal denied** (`ap:deny:`), and the ferry toggle **Pause relaying** ↔ **Resume relaying** (`ap:pause:` — the label flips on the live row; pause silences BOTH directions and the cursors stay behind, so nothing is lost).

### Ferry rules (the §3 matrix)

| Rule | Detail |
|------|--------|
| **Never ferry bots** | Bot-authored (including the bot's OWN relays — loop-proof), webhook, and self-authored messages never travel, silently. Two belts: the author check + a bounded relayed-id guard |
| **User → ticket** | `**<escaped username · id>:** <text>` + attachments — never a guild mention; sends belt with `allowedMentions { parse: [] }` |
| **Ticket → user** | `**<staff display name>:** <text>` — display name only, NO id, and never the ban's moderator metadata (§6) |
| **Payloads** | **Text, images, video ONLY.** Audio/voice, stickers, polls, forwarded messages, component/action messages, embed-only messages, and unsupported attachment kinds (a `.zip` is named per file) are NOT shared — the SENDER gets the specific per-kind notice (`**Not shared:** that poll is not ferried. …`), the other side stays silent. System/card messages and empty messages drop silently. Reactions/edits/deletes: the engine is **add-only** — those listeners do not exist by law |
| **Partial relay** | When a message mixes shareable and un-sharable parts, what survives STILL travels and the sender is told exactly what did not (a dropped part, an over-cap file, a failed fetch — "…it was not sent on; the rest of the message was"). Nothing vanishes silently |
| **Durability** | Attachments are RE-HOSTED (SSRF-guarded fetch → in-memory re-upload on the send) so relays survive original deletion. Documented deviation: `mirrorTicketAssets` serves web-transcript files; live relay needs buffers on the send — the FETCH discipline is reused, the destination differs |
| **Caps** | **8 MiB** per attachment (declared-size pre-skip, never downloaded to be refused; the refusal names size and cap — "…is over the 8 MiB relay limit…"), 10 files per message (platform mirror), relay chunks under the content cap. Over-cap bytes are NEVER truncated |
| **Ordering/resume** | One persisted `(message id, created_at)` cursor pair PER DIRECTION; the cursor advances ONLY after a successful send (half-sent relays replay, never silently skip). Boot catch-up replays strictly-after history bounded to **50** per direction per appeal — a catch-up that hit the bound is reported as such, never claimed |
| **Flooding** | User-side only: **10 s** spacing + **20** relays per rolling hour per appeal (`FERRY_USER_COOLDOWN_MS` / `FERRY_USER_HOURLY_CAP`, tuned post-launch). Drops are specific to the SENDER (throttled so the notice itself cannot storm) and silent to staff; staff-side rides existing channel cooldowns |
| **Privacy (§6)** | User-side content NEVER carries moderator ids, automod case ids, warning or staff-note bodies — the ferry relays plain authored messages only, reads no ban metadata into a payload, and escapes display names (no ping semantics in either direction) |

The filing confirmation DM states the same law up-front (`**Shared:** only text, images, and video are relayed to staff — …`, `**Replies:** staff may pause the relay…`, `**One per ban:** this ban gets exactly one appeal — staff decisions are final for this ban.`).

### Outcomes

The three staff decisions start with the SAME claim (`UPDATE … WHERE status='open'`): **first decision wins**, a losing click mutates nothing and answers with the LIVE row's truth (`**Appeal:** this appeal was already decided as \`…\` — first decision wins, so this click changed nothing.`). Once the status leaves `open` the ferry stops structurally — the status guard IS the relay stop. The fourth entry is a SYSTEM close, not a decision (see "When the ban ends" below): a different CAS over both pending shapes, and a staff decision racing it simply wins the row.

**Grant clemency** (locked order): claim `granted` → **spend the cycle's #772 welcome FIRST** (claim → belt stamp, `welcome_dm_sent=1` before any unban call, so a racing GuildBanRemove or the expiry ticker LOSES its welcome claim — exactly ONE DM per clemency, structurally) → unban ONLY against an ACTIVE record (a settled row means a newer cycle owns the ban — never unban against it; Discord 10026 NOT_BANNED is TRUTH, not failure: still granted) → record settles **`clemency_granted`** (CAS; the live row wins a race and is reported) → **permanent re-join invite** minted in `guild.systemChannel` ?? first visible text channel with the pinned policy `maxAge 0 / maxUses 0` (never expires, unlimited uses — policy + code audited as `banAppeals.invite_created`) → ONE DM → ticket close→archive (shared flow, warnings ledger) → header buttons disabled → audit. Clemency on an already-expired ban still sends the DM.

```
**Appeal:** granted — your ban in **Guild Name** has been lifted. You're welcome back.
**Invite:** https://discord.gg/… — it does not expire; use it any time to rejoin.
If you'd like to talk about what happened, any staff member is happy to help.
```

When the mint fails the DM says so specifically ("**Invite:** a re-join invite could not be created right now — a staff member can send you one directly.") — never a fake link. The guild-side unban reason is `Ban appeal — clemency granted by staff` (what, not who — attribution lives in the audit row).

**Appeal denied** — `ap:deny:` opens the optional-reason modal ("Deny this appeal", ≤ **1000** chars, stored on the appeal); the claim then lands `denied`. The ban is NEVER touched. The DM restates eligibility for timed bans and closes the conversation:

```
**Appeal:** denied — staff reviewed your appeal in **Guild Name** and the ban stands.
**Eligible again:** <t:1761984000:F> (<t:1761984000:R>) — you may rejoin after that.
**Staff note:** (optional — appended VERBATIM but markdown-escaped inert)
**Conversation:** this appeal's staff conversation is now closed — the relay has ended and no further messages will be carried for this ban.
```

Permanent bans answer `**Expiry:** none — this ban has no set end date; staff may lift it at their discretion.` instead of the eligibility line.

**Plain close** (staff delete the channel while the appeal is still `open`) — detected by the feature's own `ChannelDelete` listener matching `ban_appeal.ticket_channel_id`; zero tickets-core edits. Claims `closed` (attribution-free on the event path; a decided row is a NO-OP — the decision's own DM stands), then the neutral notice, ban untouched:

```
**Appeal:** staff ended the conversation about your ban appeal in **Guild Name** without a decision — the ban stands and the relay is closed.
The ban itself was not changed by this. If you want to raise anything, you can contact a staff member another way.
```

**When the ban ends (system auto-close, #811)** — if the ban behind a pending appeal ends by any path that ISN'T a clemency (the expiry sweep auto-unbans it, staff lift it outside the bot, or boot reconciliation detaches it), the appeal closes with it: a CAS over BOTH pending shapes (`filed` and `open` → `closed`, `decided_by = system:ban-ended`, the human cause riding `denial_reason`). Staff get a `📜 System — ban ended.` note in the ticket before the shared close flow converges it; a late button click answers the honest "already decided". There is deliberately **no user DM** — the ban-end itself already speaks (the welcome-back DM, or reconciliation's log-only law) and a second lifecycle DM would double-message the same fact. A **held** expiry (#809) is NOT a ban end: the live ban is still in force, so its appeal legitimately stays open for staff to decide.

### Appeals toggle (`/banappeals`)

| Command | Guild setting | Default | Effect |
|---------|---------------|---------|--------|
| `/banappeals enable` | `ban_appeals` | **on** | Tracked ban DMs carry the Appeal button; presses open staff appeal tickets |
| `/banappeals disable` | `ban_appeals` | — | New presses refused ("appeals are turned off here"), no tickets open. **Intake only** — appeals already in flight keep ferrying and stay decidable |
| `/banappeals status` | — | — | Read the toggle + the defaults note (ephemeral) |

Admin tier (Manage Server in the picker AND the handler), Discord-only like `/bannotify`. Every mutation lands a `banAppeals.toggle_set` audit row + the `/automodconfig`-style audit embed.

### Appeals data & audit

Migration `075_ban_appeals`: the `ban_appeals` table (one row per appealable cycle — `ban_record_id` UNIQUE, `ticket_channel_id` NULL until the ticket lands, status `filed` → `open` → exactly one of `granted|denied|closed` (a `closed` row is either the neutral plain-close, or — #811 — the system ban-ended auto-close, told apart by `decided_by = 'system:ban-ended'`), the statement, four plain ferry-cursor columns (id + timestamp per direction), `ferry_paused`, `decided_by/decided_at`, `denial_reason`) **plus** the `ban_records` status-CHECK rebuild adding `clemency_granted` (074 stays byte-frozen; ids and B-n numbers are preserved — the `appeal:<banRecordId>` customIds depend on that stability) and the `guild_settings.ban_appeals` toggle (`DEFAULT 1`).

| Action | Origin |
|--------|--------|
| `banAppeals.file` | Filing (per modal submit that reached the repository; status/ticket truth included) |
| `banAppeals.clemency_granted` / `banAppeals.denied` / `banAppeals.closed` | The three outcome claims (staff actor on the button paths; attribution-free on the ChannelDelete path) |
| `banAppeals.closed_ban_ended` (#811) | System auto-close when the BAN behind a pending appeal ends (expiry / external lift / reconciliation); details carry `prior_status`, the human `cause`, and `ticket_closed` |
| `banAppeals.invite_created` | Invite mint — channel + pinned policy (`max_age: 0`, `max_uses: 0`) + code, staff-side audit only |
| `banAppeals.toggle_set` | `/banappeals enable\|disable` (recordSlashAudit + audit embed) |

### Known gaps (appeals, accepted)

- **No ban DM = no appeal path.** Users whose DMs were closed never see the button (the post-record button attach is strictly best-effort) — a **web appeal form is explicitly OUT OF SCOPE**
- **Untracked bans have no button** — honeypot and outside-the-bot bans carry no record, so there is nothing to appeal against (#772 gap inherited)
- **Timeouts are not "bans" here** — the appeal surface is `ban_records` only
- A restart resets the in-memory flood ledger (the persisted cursors already prevent REPLAY — the worst reset case is a one-message-per-event cooldown miss, never a re-relay); boot catch-up past its bound awaits live traffic or the next boot — never claimed as replayed
- Fauxcord E2E still does not cover DM interactions — the offline integration suite carries that bar

## Record & status machine

One row per ban cycle in `ban_records`; human ref **B-{n}** is sequential per guild (sibling of W-n / A-n).

| Status | Meaning |
|--------|---------|
| `active` | Ban in force — the only row the per-(community, user) partial UNIQUE admits |
| `expired_unbanned` | The expiry ticker lifted the ban |
| `unbanned_manual` | Lifted outside this bot (staff unban event, another tool, or boot reconciliation) |
| `pending_rejoin` | Unbanned, welcome DM not delivered — retry parked for rejoin |
| `welcomed` | Rejoin welcome attempt made (regardless of delivery outcome) |
| `clemency_granted` | Ban lifted by a granted ban appeal (#773 — appended by migration 075) |
| `expired_held` | Term lapsed but the live ban does not match the record (#809 — appended by migration 076): the auto-unban was HELD, never executed, and no welcome DM is possible (the row was never lifted) |
| `expiry_failed` | The auto-unban could not complete after the attempt ceiling (#810 quarantine — appended by migration 077): terminal ON PURPOSE, the sweep never touches the row again, nothing was lifted, and **staff own the live ban by hand** |

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
    CHECK (status IN ('active','expired_unbanned','unbanned_manual','pending_rejoin',
                      'welcomed','clemency_granted','expired_held','expiry_failed')),
  ban_dm_sent INTEGER NOT NULL DEFAULT 0,
  welcome_dm_sent INTEGER NOT NULL DEFAULT 0,
  unban_claimed_at INTEGER,           -- CAS lease for the auto-unban claim
  unban_reason TEXT,
  ban_identity_reason TEXT,           -- #809: live ban reason captured at issue
                                      -- (the expiry guard's fingerprint;
                                      -- NULL = pre-#809 row / unreadable at issue)
  expiry_attempts INTEGER NOT NULL DEFAULT 0
                                      -- #810: REAL (winner-side) failed auto-unban
                                      -- attempts; crossing EXPIRY_MAX_ATTEMPTS (20)
                                      -- quarantines the row terminal `expiry_failed`
);

CREATE TABLE ban_reconcile_state (   -- #810: boot-reconciliation rotation stamps
  community_id INTEGER PRIMARY KEY REFERENCES communities(id) ON DELETE CASCADE,
  last_reconciled_at INTEGER NOT NULL -- last ATTEMPT (success or not) — broken
);                                    -- guilds rotate too
```

Migration `074_ban_lifecycle` (also adds `guild_settings.ban_dm` / `welcome_back_dm`, both `DEFAULT 1`). The record `id` is a stable handle by contract. All settles are first-writer-wins CAS (claim → act → finalize): a losing claimer performs zero outbound calls and reports the live row. Migration `075_ban_appeals` keeps 074 byte-frozen and *extends*: a table rebuild widens the status CHECK with `clemency_granted` (ids and B-n numbers preserved), and the migration adds `ban_appeals` + the `guild_settings.ban_appeals` toggle (above). Migration `076_ban_identity` (#809) extends the same way: the status CHECK gains `expired_held` and the table gains `ban_identity_reason` — the fingerprint the expiry sweep checks before it dares to unban. Migration `077_expiry_quarantine` (#810) extends it once more: the CHECK gains `expiry_failed`, the table gains `expiry_attempts`, and `ban_reconcile_state` lands (the boot-reconcile rotation stamps — one attempt timestamp per community, FK-cascaded so a departed guild stops being tracked).

## Audit

| Action | Origin |
|--------|--------|
| `banLifecycle.ban` | Staff command layer (per executed ban) + system row for automod-origin bans |
| `banLifecycle.ban_dm_set` / `banLifecycle.welcome_dm_set` | `/bannotify` mutations (recordSlashAudit + audit embed) |
| `banLifecycle.expiry_unban` / `banLifecycle.external_unban` / `banLifecycle.rejoin_welcome` | System (ticker / GuildBanRemove / rejoin); each auto-unban also posts a staff-log embed on the audit channel |
| `banLifecycle.expiry_held` (#809) | System (re-ban guard held an expiry: issued vs. live reason both recorded); posts a caution embed — never the unban embed |
| `banLifecycle.expiry_quarantined` (#810) | System (the auto-unban crossed the attempt ceiling and settled the row terminal `expiry_failed`: attempts + last error recorded); posts a **danger** embed — staff must handle the live ban by hand |

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

- [Commands reference](commands/index.md) — `/ban`, `/bannotify`, `/banappeals`, "Ban member"
- [Configuration](configuration.md) — `ban_dm` / `welcome_back_dm` / `ban_appeals` per-guild rows
- [Warnings](warnings.md) — the W-n record this mirrors as B-n; the warn-DM/ticker idioms reused
- [Tickets](tickets.md) — the shared ticket pipeline the #773 appeal tickets ride (cross-ref on that page)
- [Auto-moderation](automod.md) — the `ban` action tool routes through this service (#738)
- [Staff roles](staff-roles.md) — who the staff-subject guard protects
- [Audit Log](audit-log.md) — where the unban embeds post
- [Fluxer instances](fluxer.md) — platform matrix (ban lifecycle: Discord-only)
- GitHub issues: **#772** (this feature); **#773** (ban appeals — shipped on top of it; see the Ban Appeals section above, keyed off the stable record id via `appeal:<banRecordId>`)
