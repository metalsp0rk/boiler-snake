# Auto-moderation (epic #723)

!!! abstract "Ship state — this page tracks the epic"
    **Shipped now:** the guild settings and their Manage-Guild commands — `/automod status` and `/automodconfig` (channel, rules, master switch, per-action modes, timeout cap, daily case budget, breaker state + `safety resume`) (#725) — plus **staff referral intake**: `/automod refer` and the **Refer to automod** message context menu, which record a case (**A-n**) and ack where recommendations will post (#726), the **case-context collector** + lookup tools the judge reads (#727 — no user-facing surface of its own; see [Case context](#case-context)), the **LLM harness**: the case runner that judges a recorded case, records intent through mode-gated tools, and commits every action through the executor (#728 — see [Harness](#harness)), and the **case card**: the interactive one-post-per-case outcome post whose Approve/Dismiss buttons execute suggested actions straight from the ledger (#730 — see [Case card](#case-card)), and the **staff-note reconciler**: one note per considered subject (narrative or harness-filled), dropped notes for non-subjects, outcomes merged into the same note (#731 — see [Staff notes](#staff-notes)).
    **Landing in sibling issues:** the individual action tools' surfaces (#732–#738), plus the circuit breaker trip logic (#739). The intake ack never claims a recommendation was produced — the **harness posts its outcome separately**, after the ack. The mode gate itself (off/suggest/auto, guards, atomic claims) is already shipped in the executor (#729) — a suggest-mode decision is recorded as a pending ledger row and surfaces on the case card for staff approval.

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
planned in this epic (epic decision 8). The case card's Approve/Dismiss
buttons are Discord message components with no path through the Fluxer
dispatcher at all (#730, [Case card](#case-card)) — also explicit no-parity.
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
   clamps nothing itself. Then the **staff-note reconciler** (#731,
   [Staff notes](#staff-notes)) writes through the real `createStaffNote`
   (author = the bot's user id): exactly one note per considered subject,
   narrative or harness-filled, and queued note calls for users with no
   action intent are DROPPED — zero rows plus one honest card line.
7. The outcome **edits the placeholder** (or posts fresh when the
   placeholder never landed) into the interactive **case card** (#730,
   [Case card](#case-card)): the Decision field renders from a FRESH re-read
   of the action ledger (per-subject sections + one line per row), the meta
   line carries model · duration · rounds · tools, and every still-suggested
   row rides Approve/Dismiss buttons. A card that cannot post is never
   claimed posted (see the send-failure law below).
8. Provider metadata persists on the case row (migration `070`):
   `last_model`, `last_duration_ms`, `last_tool_names` (JSON),
   `decision_log` — a **short structured log**
   (`[{seq, tool, args_summary, state, result_or_error}]`, explicitly not a
   transcript copy; the staff notes hold the human record) — and
   `last_run_error`. Entries whose `decision_log` `tool` starts with `_` are
   structured card meta (`_card_participants` powers the rebuild's bystander
   line, `_card_post_error` records a card that never posted) — never model
   calls.

**Enforcement in the tool layer** (locked decision 4 — not prompt-only):
consideration is mechanical — a user becomes considered by a RECORDED ACTION
for them (including `no_action`). The note tool is order-independent: a call
at any point is validated (`user_id`, non-empty `content`) and QUEUED — one
per user per run — with the tool result naming the commit-time law;
reconciliation at COMMIT decides what is actually written (see
[Staff notes](#staff-notes)). Action tools dedupe per (action, user) per run,
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
`**Referred by:** <@staff> — provider error: <cause>` (card header line —
same copy convention as the case card, [Case card](#case-card)).

**Isolation.** A broken provider, garbage tool arguments, or a repo failure
can never kill the client: the runner never throws, detached work owns its
catch, and every failure logs `[automod]` with community/guild/case ids and
staff-facing copy names the specific cause. The **boot sweep** (feature
`start` hook) fails any case stuck in `processing` from a previous boot
(`last_run_error = run interrupted by restart`) with a best-effort channel
notice.

**Fluxer: explicit no-parity** (epic decision 8). The harness is Discord-only.

## Case card

The harness outcome post IS the **case card** (#730, `src/features/automod/card.js`):
one post per case — the reviewing placeholder is EDITED into it, and every
staff decision re-edits that same message from fresh ledger rows.

**Embed shape.** Title `Automod — case A-n — decision` (green) or
`— run failed` (red, the run died — the description names the specific
cause). Description: the referrer-visible line (`**Referred by:** <@staff> —
review complete.` etc.) plus, when the judge saw window participants it did
not consider, a `**Seen, not considered:** <@id> …` line (bystanders only,
**never** with note refs; clamped to 25 names with an honest `… +N more`).
Field `Decision`: per-subject sections —

```text
**Subject:** <@user> · **Staff note:** N-7
  - `warn` — **pending approval** — a staff decision is due — Approve runs the shared executor, Dismiss declines.
  - `timeout` — **executed** — Timed out <@user> for 120s (clamped from 99999s) — …
```

— followed by any non-ledger lines the run produced (note-write failures, the
#731 reconciler report). A suggested `no_action` row renders
`**recorded decision**` (it is a judgment, not a pending sanction — it never
gets buttons). When anything refused or failed, a roll-up line leads the
field (`**Outcome:** 1 of 3 recorded actions ran — …`) — partial failure is
never reported as total success (AGENTS rule 5). Footer:
`Model X · N ms · R round(s) · tools: …` (a rebuild reads the persisted 070
columns; rounds are run-time data and show `?`).

**Buttons (Discord components).** Every still-`suggested` row rides
`Approve <action>` / `Dismiss <action>` with customIds
`am:card:approve:<actionRowId>` / `am:card:dismiss:<actionRowId>` — the row
id is all a click needs; the case, community, and current states are re-read
from the ledger at click time. Buttons are clamped to
**10 pending rows per card** (`AUTOMOD_CARD_MAX_BUTTON_ROWS`; 20 buttons in
five ActionRows — inside Discord's 25-button/25-component message cap, which
is why the clamp counts rows and not the 25 suggested in review). Overflow is
honest: a `**More pending rows:** N pending row(s) have no buttons on this
card — …` line names the count, and the buttons **regenerate after earlier
decisions** — approve or dismiss the front of the queue and the rebuilt card
carries the tail.

**Who may press.** Any staff member (the shipped `requireStaff` gate —
ManageGuild or any `staff_roles` level; denial is the standard
`MSG_DENIED`). Not referrer-scoped: the executor's guards, not the clicker,
bound what a click can do.

**Approve** re-checks, in order, BEFORE anything runs — a refusal is always
specific and mutates nothing (the row stays suggested and re-approvable):

1. the master switch:

   ```text
   **Automod off:** the master switch is off for this server — a suggestion cannot be approved until an admin runs `/automodconfig enable on`.
   ```

2. the action's mode — off is unrunnable (locked decision 2), so a mode
   flipped after the suggestion refuses:

   ```text
   **Mode off:** the `<action>` action is now off for this server — approving cannot run it (locked decision 2: off is unrunnable). Set its mode with `/automodconfig mode` or Dismiss the suggestion.
   ```

3. the **circuit breaker** for `kick`/`ban`/`timeout` — a paused guild
   refuses naming why:

   ```text
   **Safety paused:** the auto-moderation circuit breaker is tripped — `<action>` approvals stay dark until an admin runs `/automodconfig safety resume` (confirm:true). **Pause reason:** <reason>
   ```

   (The trip rules and the auto-path gate are #739; the card-side gate is
   test-pinned here.)

Then it calls the SHARED executor (`approveSuggestion` → the same atomic
claim, guards, and clamp auto mode uses — the card runs nothing itself). A
double click loses the claim and is **never an error and never a second
mutation**: the ephemeral reads `**already handled**` and carries the
existing outcome; a stale card's click on an already-terminal row shows the
same outcome and refreshes the card.

**Dismiss** records the decline (ledger `dismissed`, `Dismissed by <@staff>`)
and runs nothing — so it needs NO master/mode/breaker gates: even a paused or
mis-set guild must be able to say no.

**Staff-note outcome (#731).** A terminal click updates the subject's SAME
automod note — never a second one (discovery: the `(automod case A-n)`
content suffix AND the bot as author; a human note quoting the case is never
touched). The note gains/maintains one `**Outcome:**` section whose entries
merge under a cap that always keeps the newest decision:

```text
Outcome: approved by <@staff> — executed: <result>
Outcome: approved by <@staff> — refused: <cause>
Outcome: dismissed by <@staff> — the suggested action was not run.
```

The identical line never duplicates (a re-click leaves the note byte-identical,
no edit stamp); the narrative is cut only with the explicit
`…[narrative truncated to fit the note cap]` marker; and a note that vanished
or was erased is a reported warning with the card still updated — never a
dead end. Auto mode writes its outcome into the note at birth (the note is
created already carrying `executed` / `refused` state).

**Rebuild law.** Card updates render ONLY from a fresh read of
`automod_case_actions` for the case — never from the old embed. An hour-old
card after a restart still works: the customId's row id alone identifies
everything, states shown are CURRENT, and buttons appear only for rows still
suggested. Cross-community rows, unregistered guilds, and vanished rows are
refused with a specific sentence and zero side-effects.

**Send-failure law.** A card that cannot post/edit is never claimed posted:
the failure logs `[automod] … case A-n card post failed …` with the ids, the
case's `decision_log` gets a structured `_card_post_error` entry, and the
clicker's ephemeral says
`**Card:** the case card could not be updated (<cause>) — the row states
above are the ledger's truth.` The ledger rows stay the operational truth.

**Fluxer: explicit no-parity.** Approve/Dismiss are Discord message
components; the Fluxer dispatcher has no component/customId path at all, so
`am:card:*` is structurally unreachable there (the arms keep a shape belt
answering the shipped Discord-only sentence anyway).

## Staff notes (locked decision 4)

Every case leaves its human record in the existing
[staff notes](staff-notes.md) system — no parallel table, no new commands, no
special delete path (`/note delete`'s confirm step stays the ONLY way to
remove one). Reconciliation runs at COMMIT (enforcement, not prompt hope):

**Who gets exactly one note:**

- Any user the model selected with ANY action tool, **including `no_action`**
  — whether the mode then suggests, executes, refuses, or waits for Approve.
  A REFUSED recommendation (staff-role subject, hierarchy) is still a
  considered record.
- Outcomes of Approve/Dismiss/auto land in that SAME note via the
  `**Outcome:**` section ([Case card](#case-card)) — never a second note.

**Who never gets one:**

- A context-window speaker the model did not act on — even when the model
  called the note tool for them. The queued note is dropped at commit:
  zero `staff_notes` rows, and the card's Decision field carries the honest
  line:

  ```text
  - **Staff note dropped:** <@user> — the note tool named them but the model recorded no action (not considered), so no staff note was written (locked decision 4).
  ```

- The referrer who only filed — filing is not consideration (a queued note
  for them is dropped the same way).
- `read_warnings` / `read_staff_notes` lookups are zero-write.

**The note body** (`createStaffNote`, author = the bot's user id, normal
**N-n** numbering):

- The model's narrative when it wrote one; otherwise the marker
  `**Narrative:** harness-filled — the model recorded no narrative for this user; this note is rebuilt from the structured decision.`
- `**Actions:**` lines listing each recorded action for that user with its
  outcome — several actions against one user still share ONE note.
- `**Evidence:** <message link>` when the case carries an anchor message.
- The discovery suffix `(automod case A-n)` at the end — together with the
  bot author it is how the card and later decisions find THIS case's note;
  a human note merely quoting the case number is never matched.
- Always inside the 2000-char cap with EXPLICIT truncation
  (`…[narrative truncated to fit the note cap]`) and a narrative floor —
  a long story still produces the note; a case never fails because of one.

**Never:** the note is never DM'd and its text never enters ticket openings or
warning DMs (member-visible copy is scrubbed by design — the ticket tool
issue restates the rule). Notes and warning history stay in staff-channel
scope.

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
auto kick / ban / timeout are dark — and case-card **Approve** clicks for
those three actions are refused naming the pause reason (#730,
[Case card](#case-card)) — until an admin runs
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
