# Auto-moderation (epic #723)

!!! abstract "Ship state — this page tracks the epic"
    **Shipped now (#725):** the guild settings and the Manage-Guild commands that edit them — `/automod status` and `/automodconfig` (channel, rules, master switch, per-action modes, timeout cap, daily case budget, breaker state + `safety resume`).
    **Landing in sibling issues:** staff referral `/automod refer` (#726), case context (#727), the LLM harness (#728), the per-action mode gate (#729), the case card (#730), and the individual action tools (#731–#738), plus the circuit breaker trip logic (#739). There is **no** `/automod refer` yet — the commands here configure state that the referral path will consume.

Auto-moderation is a staff-referred judgment pipeline: a staff member refers a message or a user, a separate LLM harness recommends staff actions against the guild's written rules, and each action type is gated `off` / `suggest` / `auto` by the guild. **Recommendations are the default** — enabling the master switch never starts kicking or banning by itself.

**Design record (authoritative):** the locked decisions live in
[`roadmap/automod.md`](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/automod.md)
on GitHub. This page documents the shipped surface; the design record wins on intent.

## Platform availability

**Discord only.** This milestone ships no Fluxer surface, and the docs state the
**explicit no-parity**: the automod commands are not registered for Fluxer's
prefix dispatcher, and a Fluxer dispatch reaching either command answers
`That command is not available on Fluxer yet.` (the standard Discord-only
refusal). No Fluxer implementation is planned in this epic (epic decision 8).
See [Fluxer instances](fluxer.md) for the platform matrix.

It is also **separate from Gork** by design: its own settings family
(`automod_*`), its own daily budget, its own prompts. A case never increments
Gork's budget and never enters Gork's queue (and vice versa). No new
environment variables: the provider env (`AI_API_KEY`, `AI_BASE_URL`,
`AI_MODEL`) arrives with the harness issue (#728).

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

## Modes (locked decision 2)

| Mode | Meaning |
|------|---------|
| `off` | The tool is not offered to the model and cannot run. The case card must not recommend it. |
| `suggest` | The model may select it; the case card in the automod channel shows it. Staff **Approve** runs the same executor auto mode uses; **Dismiss** records the decline. |
| `auto` | The executor runs it and the card reports the result. No approve button. |

## Daily case budget

One counter per community per **UTC day** (`automod_cases_today` +
`automod_cases_day` on `guild_settings`). A case counts **only when a
provider call is accepted** — a provider failure does not consume budget.
`/automod status` shows the real remaining count; the counter rolls at the
UTC day boundary with no ticker.

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

## Related

- [Commands reference](commands/index.md) · [Configuration](configuration.md)
- [Warnings](warnings.md) (the formal record the `warn` tool will issue) ·
  [Staff notes](staff-notes.md) (always-on note tool) ·
  [Help tickets](tickets.md) (the `ticket` tool's target) ·
  [Honeypot](honeypot.md) (the `safety resume` confirm idiom precedent)
