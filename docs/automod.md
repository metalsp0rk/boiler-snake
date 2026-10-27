# Auto-moderation (epic #723)

!!! abstract "Ship state — this page tracks the epic"
    **Shipped now:** the guild settings and their Manage-Guild commands — `/automod status` and `/automodconfig` (channel, rules, master switch, per-action modes, timeout cap, daily case budget, breaker state + `safety resume`) (#725) — plus **staff referral intake**: `/automod refer` and the **Refer to automod** message context menu, which record a case (**A-n**) and ack where recommendations will post (#726), the **case-context collector** + lookup tools the judge reads (#727 — no user-facing surface of its own; see [Case context](#case-context)), and the **LLM harness**: the case runner that judges a recorded case, records intent through mode-gated tools, and commits every action through the executor (#728 — see [Harness](#harness)).
    **Landing in sibling issues:** the case card (#730), the individual action tools' surfaces (#731–#738), plus the circuit breaker trip logic (#739). The intake ack never claims a recommendation was produced — the **harness posts its outcome separately**, after the ack. The mode gate itself (off/suggest/auto, guards, atomic claims) is already shipped in the executor (#729) — until #730 lands, a suggest-mode decision is recorded as a pending row and reported in the harness post.

Auto-moderation is a staff-referred judgment pipeline: a staff member refers a message or a user, a separate LLM harness recommends staff actions against the guild's written rules, and each action type is gated `off` / `suggest` / `auto` by the guild. **Recommendations are the default** — enabling the master switch never starts kicking or banning by itself.

**Design record (authoritative):** the locked decisions live in
[`roadmap/automod.md`](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/automod.md)
on GitHub. This page documents the shipped surface; the design record wins on intent.

## Platform availability

**Discord only.** This milestone ships no Fluxer surface, and the docs state the
**explicit no-parity**: the automod commands are not registered for Fluxer's
prefix dispatcher and the **Refer to automod** message context menu exists on
Discord only; a Fluxer dispatch reaching `/automod` or `/automodconfig` answers
`That command is not available on Fluxer yet.` (the standard Discord-only
refusal). This applies to **both** referral arms — no Fluxer implementation is
planned in this epic (epic decision 8).
See [Fluxer instances](fluxer.md) for the platform matrix.

It is also **separate from Gork** by design: its own settings family
(`automod_*`), its own daily budget, its own prompts. A case never increments
Gork's budget and never enters Gork's queue (and vice versa — the only shared
surface is the provider env: `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` via
`src/core/ai.js`; **no new environment variables** ship with the harness, and
there is no automod-specific provider knob).

## Setup

1. **Restrict a staff channel** for the case cards (they contain staff-only
   judgment text). `/automodconfig channel set` warns when `@everyone` can
   currently view the picked channel — it never rewrites the channel's
   permissions itself.
2. **Set the rules text** the judge applies: `/automodconfig rules set`
   (omit the text option to write longer text in a modal). Cap 4000
   characters, enforced with an error (never truncated).
3. **Enable**: `/automodconfig enable on`. Until then every referral refuses,
   naming the master switch as the specific cause.
4. **Turn actions on deliberately.** Every mode starts at `suggest` — the
   model may recommend it and a staff **Approve** on the case card runs it.
   Setting a mode to `auto` removes that decision and is itself a Manage
   Server change. `off` hides the tool from the model entirely.

Rules and a channel are **required to run a case**; clearing either while the
master switch stays on is allowed — referrals then refuse naming the missing
piece.

## Commands

### `/automod status` (staff)

Read-only view: **Enabled**, **Channel**, **Rules** (set/not set + length),
all seven **Modes** (staff notes are shown as *always on* — they have no
mode by design), **Timeout cap**, **Daily budget** (real remaining count
today, `0` → unlimited, `-1` → blocked), and **Safety** (breaker state incl.
the pause reason). Ephemeral; no secrets.

### `/automod refer` (staff)

Files a **staff referral** into the automod queue as a numbered case
(**A-1**, **A-2**, … per guild — the same human-ref idea as **N-n** notes and
**T-n** tickets). This is THE intake seam (locked decision 1): members have no
command for this and nothing in message-create opens a case.

| Option | Meaning |
|--------|---------|
| `message:` | **Full message link** of the offending message (right-click → *Copy Link*). Bare message ids are refused — the full link is what lets the bot cross-check the guild. |
| `user:` | The member the referral is about. |
| `note:` | Your explanation — stored as **case input** for the harness (max **1000** characters). |

At least one of `message:` / `user:` is required. A successful referral stores
one `automod_cases` row (status `recorded`), lands one `automod.refer` row in
the admin audit trail, and acks ephemerally:

```text
Case: **A-3** — recorded.
Recommendations will post in <#1234567890123456789>.
```

The ack promises only WHERE recommendations will post — nothing at intake
calls a model or claims a recommendation was produced (the harness, #728, may
not even be merged yet). Every refusal names its specific cause; see
[Staff referral intake and refusals](#staff-referral-intake-and-refusals).

### "Refer to automod" (message context menu, staff)

Right-click a message → **Apps → Refer to automod** — the context-menu twin of
`/automod refer` (#726). The right-clicked message IS the referral: no link to
paste, no note option, no separately named user. Same battery, same refusal
copy, same ack. Discord additionally resolves the target, so the platform
already guarantees the guild and the invoker's view of the channel — and
bot/system messages are refused here before anything runs
(`Cannot refer a bot or system message to automod — nothing was recorded.`).

### `/automodconfig` (admin — Manage Server in the picker AND the handler)

| Subcommand | What it does |
|------------|--------------|
| `channel set channel:` | Set the case-card channel. **Warns in the reply when `@everyone` can view it** (overwrite read only — never rewritten). |
| `channel clear` | Unset the channel (cases refuse until set; allowed while enabled). |
| `rules set [text]` | Set the rules text (max 4000 chars — over-length refuses with the count). **Omit `text` to open a modal**, same idea as `/note add`. |
| `rules clear` | Clear the rules text (allowed while enabled). |
| `enable on\|off` | Master switch (default **off**). |
| `mode action:… mode:off\|suggest\|auto` | Per-action mode for `no_action`, `warn`, `delete_message`, `ticket`, `timeout`, `kick`, `ban`. Default **suggest**. There is no mode for the staff-note tool — it is always on. |
| `timeout-cap seconds:` | Max automod-run timeout: **60 s … 2,419,200 s (28 days = Discord's maximum)**, default 3600. Out of range refuses with the offending value; it is never silently clamped. |
| `budget limit:` | Daily case budget per server: **`-1` blocked, `0` unlimited, `1–100000` capped** (default 50). Separate from Gork's `gork_daily_limit`. |
| `safety resume [confirm:]` | Clear the persisted circuit-breaker pause. Run WITHOUT `confirm` first: it previews exactly which auto kick/ban/timeout actions re-arm (two-step `confirm:` idiom, #471 H2-15). |

Every `/automodconfig` mutation lands an `automod.*` row in the admin audit
trail and a config-change embed on the audit log channel (best-effort
mirror).

## Staff referral intake and refusals

A referral is **intake only**: no model call, no enforcement, no budget
consumption. BEFORE anything is stored, the full refusal battery runs — every
gate has its OWN specific ephemeral cause (staff-facing copy always names the
cause; never "check logs"), and nothing is recorded without the fix. Gate
order:

1. master switch · 2. automod channel unset · 3. channel not postable ·
4. rules not set · 5. budget blocked · 6. budget exhausted · 7. no target ·
8. note over cap · 9. link format · 10. cross-guild link · 11. source channel
gone · 12. referrer cannot view the source channel · 13. message no longer
exists.

The exact replies (tests pin them byte-for-byte):

**Automod off** (gate 1)

```text
**Automod off:** the master switch is off here — an admin must run `/automodconfig enable` before referrals can record cases.
```

**Automod channel unset / unpostable** (gates 2–3; `<#…>` is the configured channel)

```text
**Automod channel:** not set — an admin must pick the case-card channel with `/automodconfig channel set` before referrals can record cases.
```

```text
**Automod channel:** <#CHANNEL_ID> is not postable right now — it is deleted, or I lack View Channel / Send Messages there. An admin must fix it or re-set it with `/automodconfig channel set`.
```

**Automod rules empty** (gate 4)

```text
**Automod rules:** not set — the judge needs the guild rules text. An admin must run `/automodconfig rules set` first.
```

**Daily budget blocked / exhausted** (gates 5–6)

```text
**Daily budget:** blocked (`-1`) — every referral is refused until an admin opens the budget with `/automodconfig budget`.
```

```text
**Daily budget:** exhausted — 50 of 50 cases used today (UTC day). Nothing was recorded — try again after the day rolls or raise the cap with `/automodconfig budget`.
```

**No target** (gate 7 — slash only; the menu always carries a message)

```text
**Target required:** include at least one of `message:` (a message link) or `user:` (the member) — nothing was recorded.
```

**Note over cap** (gate 8 — also enforced by the slash option's max length)

```text
**Note too long:** the referral note is 1200 characters — the cap is 1000. Shorten it — nothing was recorded.
```

**Link format / cross-guild / gone / invisible** (gates 9–13, slash `message:`
arm). A bare message id is NOT accepted — the strict grammar is
`https://discord.com/channels/<guild>/<channel>/<message>` (the legacy
`discordapp.com` host is also accepted), and the echo of a bad link is
length-clipped:

```text
**Message link:** `1234567890123456789` is not a full message link — right-click → Copy Link gives `https://discord.com/channels/<guild>/<channel>/<message>` (a bare message id is not accepted). Nothing was recorded.
```

```text
**Message link:** that message is from another server (`999999999999999999`) — referrals must point at messages in this server. Nothing was recorded.
```

```text
**Message not found:** that message no longer exists — nothing was recorded.
```

(Also used when the source channel itself is gone — a deleted channel holds no
referable message.)

```text
**Channel not visible:** you cannot view <#CHANNEL_ID>, so its messages cannot be referred. Refer only what you can see — nothing was recorded.
```

A Discord read failure OTHER than "unknown message" surfaces its own cause
(`Could not read that message (…cause…) — nothing was recorded.`) instead of
claiming deletion.

**Context-menu only**

```text
Could not resolve the referred message — it may have been deleted. Nothing was recorded.
```

```text
Cannot refer a bot or system message to automod — nothing was recorded.
```

### What a recorded case is (and is not)

- One `automod_cases` row: per-community `A-n` number, referrer, referred
  message + its channel, target user, note, `status = recorded`. At least one
  of message/user is set; the other pair stays NULL.
- The **referrer is not a subject** merely because they filed, and the note is
  case input, NOT a staff note — intake writes **zero** `staff_notes` rows.
  The harness owns notes for considered users (locked decision 4).
- **Budget is read, never consumed here.** A case counts against the daily
  budget only when the harness's provider call is accepted (#728); a recorded
  case that never reaches a provider does not count.
- **A breaker pause never refuses a referral.** The pause darkens auto
  kick/ban/timeout only; a paused guild keeps recording cases.
- `status` vocabulary: `recorded` (only #726 writes this) → `processing` →
  `complete` / `failed` — transitions are owned by the harness (#728), which
  CLAIMS a case with an atomic conditional UPDATE (`SET status='processing'
  WHERE status='recorded'`), so a second run for the same case can never
  start. Executor action state lives in the sibling case-actions table, not
  in this column; per-run provider metadata lives on the case row itself
  (migration `070`, see [Harness](#harness)).

## Case context

Every recorded case needs an **evidence bundle** before anything can judge it.
The collector (`src/features/automod/caseContext.js`, #727) assembles it on
demand: **pure gathering, no sanctions** — it never warns, deletes, tickets,
times out, kicks or bans, and it cannot write staff notes (those are the
harness's, #731). It is internal: there is **no user-facing command** for it,
no setting and no env var. The harness (#728) calls
`buildCaseContext({ communityId, guildId, caseNumber, deps })` and receives
`{ ok: true, context }` or `{ ok: false, error }` naming the specific cause.

**Always in the bundle**

- **Guild rules text** — from the current settings. Intake already refused an
  empty rules text; if an admin clears it *after* recording, the case cannot
  be judged and the collector refuses naming that cause.
- **Referral block** — referrer id, their explanation note, the message link
  (channel + message ids when the case has one), and the named user — read
  from the `automod_cases` row.
- **Message window**
  - *Message referral:* the anchor message plus a bounded surround — up to
    **40 older / 10 newer**, capped by Gork's own `read_discord` window
    constants (single source, decision 45). Per message: id, author id,
    content (capped at 500 chars with an honest `content_truncated` flag),
    timestamp, attachment **names** only. The anchor channel is re-checked
    against the **referrer's** current View Channel access (intake checked
    once; the collector checks honestly); a deleted/unknown anchor is a
    specific error, never a partial window. **Threads are out of scope** —
    a window contains channel-level messages only (no thread walk) in v1.
  - *User-only referral:* the referred user's recent messages in channels the
    **referrer can view** — asker parity, the Gork decision-46 rule. Channels
    the referrer cannot view are **never fetched** and are counted as
    `channels_skipped_not_visible`; open help tickets are excluded too (the
    decision-46 ticket blackout). The scan is bounded by constants — at most
    **15 fetched channels**, **25 messages per fetch**, **100 collected
    messages** (newest kept, `truncated` disclosed) — never a whole-server
    crawl.
- **Existing warnings + existing staff notes for the referred user only** —
  the named user, or the anchor message's author when no user was named.
  Warnings are the judgment-complete set the staff surfaces read: **active +
  expired-but-not-yet-voided** (voided = formally withdrawn by
  `/warn void`, hidden from the default staff view). Notes are **live**
  notes (erased tombstones excluded).

**Participants vs subjects** (locked decisions 4/5)

- Every author id seen in the window lands in `participant_user_ids`
  (deduped, including the subject) — context so the case card can later show
  **who was seen and not considered**.
- Authors are **context, not subjects**: exactly one subject (`subject_user_ids`)
  gets any private record preloaded. A bystander who merely appears in the
  window gets **no** preloaded notes or warnings.

**Lookup tools** (`src/features/automod/lookups.js`) — read-only, always
available, **no mode flag** (an off/paused executor never gates a read):

- `read_warnings(user)` — that user's non-voided warnings in **this guild**
  (voided history disclosed as a count only).
- `read_staff_notes(user)` — that user's live notes in **this guild**.

These exist so the judge can inspect someone in the window it is **starting
to consider** without preloading every bystander's private record into the
prompt. Both are **guild-isolated**: a user with no member row in this guild
is refused with the specific cause.

**Privacy** — staff notes and full warning history stay in the harness and
the staff channel. The collector never composes ticket or warning-DM text;
the ticket tool (#735) must scrub member-visible ticket text before anything
from a bundle could reach it, and window message content is raw data — any
renderer quoting it escapes markdown/mentions first (the #745 report-evidence
escaping convention).

Failures always log `[automod]` with community, guild and case ids and always
carry a specific cause (never "check logs"). The bundle itself is plain
JSON-able data shaped for the harness — ids as strings, no Discord library
objects.

**Fluxer: explicit no-parity** (epic decision 8). The collector and both
lookup tools are Discord-only; there is no Fluxer window read and none is
planned in this epic.

## Harness

The harness (`src/features/automod/harness.js` + `harnessTools.js` +
`prompt.js`, #728) is the **case runner**: one recorded referral starts
exactly one judged run. It is NOT a Gork tool — separate prompt, separate
tools, separate daily budget, no queue. The only shared surface is the
provider env (`AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL`, function calling
required, read through the shared `src/core/ai.js` client).

**Trigger.** Both referral arms fire the run **after the ack reply has
resolved**, detached with its own catch (a crashing run logs
`[automod] automod run crashed …` and can never produce an unhandled
rejection or kill the interaction handler). The ack copy itself is
unchanged — it still only says where recommendations will post.

**Run lifecycle:**

1. Budget **pre-gate** (blocked/exhausted refuses before anything mutates —
   the case stays `recorded` and is re-runnable after the UTC day rolls).
2. **Atomic claim** `recorded → processing` (a conditional UPDATE — one
   referral, one run; a second attempt refuses naming the current status).
3. A **reviewing placeholder** posts to the automod channel naming the
   referrer. A post failure is logged and the run continues — the
   referrer-visible surface degrades to the completion message only.
4. The case context (#727) is built; its specific failure fails the run.
5. **Tool rounds** run against the model. Tool schemas are built FROM the
   mode gate: `off` actions are not offered at all; the staff-note tool
   (`write_staff_note`) and both read tools (`read_warnings`,
   `read_staff_notes`) are always present. Reads execute immediately;
   **action tools and the note tool only record intent** during the loop —
   nothing mutates until commit, and each tool result tells the model so
   (`applied at commit`; suggest-mode lines read
   `**Status:** awaiting staff approval`).
6. When the model stops (or the round cap hits), the harness **commits**:
   every recorded action goes through the executor (`executeAutomodAction`
   with `claimant: "harness"`) — the executor owns the mode gate, staff /
   hierarchy guards, atomic claims, and the timeout clamp; the harness
   clamps nothing itself. Recorded staff notes then write through the real
   `createStaffNote` (author = the bot acting for the harness, content =
   the model's note + an `A-n` case reference).
7. The outcome **edits the placeholder** (or posts fresh when the
   placeholder never landed): per-intent lines straight from the executor
   results + a meta line (`Model X · ms · rounds · tools`). Plain embed, no
   buttons — the Approve/Dismiss card is #730's.
8. Provider metadata persists on the case row (migration `070`):
   `last_model`, `last_duration_ms`, `last_tool_names` (JSON),
   `decision_log` — a **short structured log**
   (`[{seq, tool, args_summary, state, result_or_error}]`, explicitly not a
   transcript copy; the staff notes hold the human record) — and
   `last_run_error`.

**Enforcement in the tool layer** (locked decision 4 — not prompt-only): a
staff note is required for every user considered, and consideration is
mechanical — a user becomes considered by a recorded action for them
(including `no_action`); a note for anyone else is refused naming the
**bystander rule**, and a second note for the same user is refused
(one per user per case). Action tools dedupe per (action, user) per run,
`off` actions cannot run even if hallucinated, and `timeout` durations pass
through UNCLAMPED (the executor clamps and the row records the duration
actually used).

**Round cap.** Tool rounds are capped at a fixed **12**
(`AUTOMOD_MAX_TOOL_ROUNDS` — the harness's own constant, sibling of Gork's
per-guild knob but not a setting; the loop deadline is the constant
`AUTOMOD_RUN_TIMEOUT_MS`, 120 s). A run that hits the cap posts the partial
decision naming the specific cause (`tool-round cap (12) reached`), **still
commits** what it recorded, and finishes `complete` with that cause kept in
`last_run_error`.

**Budget.** The provider call is **accepted** exactly when a parsed
provider response came back at some point (a clean result, any executed
tool call, the cap, or an empty-but-returned body). Only then
`consumeAutomodCase` runs — **exactly once per run**. An HTTP 4xx/5xx, a
network/timeout failure, or an AI-not-configured provider consumes
**nothing** (test-pinned) and the post names the provider's own words:
`Referred by <@staff> — provider error: <cause>`.

**Isolation.** A broken provider, garbage tool arguments, or a repo failure
can never kill the client: the runner never throws, detached work owns its
catch, and every failure logs `[automod]` with community/guild/case ids and
staff-facing copy names the specific cause. The **boot sweep** (feature
`start` hook) fails any case stuck in `processing` from a previous boot
(`last_run_error = run interrupted by restart`) with a best-effort channel
notice.

**Fluxer: explicit no-parity** (epic decision 8). The harness is Discord-only.

## Modes (locked decision 2)

| Mode | Meaning |
|------|---------|
| `off` | The tool is not offered to the model and cannot run. The case card must not recommend it. |
| `suggest` | The model may select it; the case card in the automod channel shows it. Staff **Approve** runs the same executor auto mode uses; **Dismiss** records the decline. |
| `auto` | The executor runs it and the card reports the result. No approve button. |

## Daily case budget

One counter per community per **UTC day** (`automod_cases_today` +
`automod_cases_day` on `guild_settings`). A case counts **only when a
provider call is accepted** (see [Harness](#harness) for the exact
acceptance rule) — a provider failure does not consume budget, and the run
consumes exactly once per accepted run. A run that starts against a
blocked/exhausted budget refuses BEFORE mutating anything, so the recorded
case survives to run after the day rolls. `/automod status` shows the real
remaining count; the counter rolls at the UTC day boundary with no ticker.

## Circuit breaker (state shipped in #725)

The persisted pause (`automod_paused_at` / `automod_pause_reason`) means
auto kick / ban / timeout are dark until an admin runs
`/automodconfig safety resume` with `confirm: true`. The trip rules (when the
breaker fires) ship with #739; a process restart never silently re-arms it.

## Storage

All settings live as the `automod_*` column family on `guild_settings`
(migration `067_automod_guild_settings`) — see
[Database](database.md#4-guild-settings). Repository:
`src/db/repositories/automodSettings.js`; service:
`src/features/automod/settings.js` (returns `{ ok:false, error }` — handlers
surface the specific cause).

Cases are real rows: `automod_cases` (migration `068_automod_cases`,
community-scoped with `ON DELETE CASCADE`, `UNIQUE (community_id,
case_number)` — see [Database](database.md#database-migrations)). Repository:
`src/db/repositories/automodCases.js` — `createAutomodCase` (allocates the
next `A-n` as MAX+1 in a transaction), `nextCaseNumber`,
`getAutomodCase(ById)`, `listAutomodCases(communityId, { status, limit,
offset })`,
`setAutomodCaseStatus`, plus the `AUTOMOD_CASE_STATUSES` enum and the
`AUTOMOD_REFER_NOTE_MAX_LEN` cap (1000), re-exported via
`src/features/automod/constants.js` and the `src/db` facade. Intake:
`src/features/automod/refer.js` (both command arms over one service); the
context-menu builder is `src/features/automod/contextMenu.js`. Case-context
gathering (no table of its own — it reads the case row + the guild settings +
the referrer's live Discord view): `src/features/automod/caseContext.js` and
the lookup tools `src/features/automod/lookups.js` (#727, see
[Case context](#case-context)). The harness runner, its mode-gated tool
layer, and its system-prompt builder are `harness.js` / `harnessTools.js` /
`prompt.js` (#728, see [Harness](#harness)); the run-metadata columns
(`last_model`, `last_duration_ms`, `last_tool_names`, `decision_log`,
`last_run_error`) ship in migration `070_automod_case_run_metadata` and are
written only by the runner and its boot sweep.

## Related

- [Commands reference](commands/index.md) · [Configuration](configuration.md)
- [Warnings](warnings.md) (the formal record the `warn` tool will issue) ·
  [Staff notes](staff-notes.md) (always-on note tool) ·
  [Help tickets](tickets.md) (the `ticket` tool's target) ·
  [Honeypot](honeypot.md) (the `safety resume` confirm idiom precedent)
