# 13. Auto-Moderation (Staff Referral + Gated Action Harness)

> **Tracking lives in GitHub Issues.** Open work for this feature lives in [GitHub issues labeled `automod`](https://github.com/metalsp0rk/boiler-snake/issues/labels/automod), ordered by [milestones](https://github.com/metalsp0rk/boiler-snake/milestones) — the `Auto-moderation v1` milestone (epic #723; children #725–#740, including #740 the live-verification record). This file is the **design record**: the locked decisions below stay authoritative. Do not add tracking items or checklists here; open an issue instead (see [index.md](index.md)).

| | |
|---|---|
| Author | Boiler Snake |
| Date | 2026-10-27 |
| Status | **Planned.** Not started. Decisions 1–9 ([13.11](#1311-design-decisions-locked)) are locked from epic #723; the sections below expand them. No feature is "Shipped" without a dated Discord live-verification record. |
| Roadmap feature | 13 |
| Migration id | Reserve the **next free id at implementation time** — read `src/db/migrations/` at PR time (reservation rule: [index.md](index.md)). No id is claimed by this draft. |
| Depends on | Shipped staff notes ([staff-notes.md](staff-notes.md)), warnings (`createWarning`, [warnings.md](warnings.md)), the help-ticket system ([help-tickets.md](help-tickets.md)), the guild staff gate ([staff-roles.md](staff-roles.md)), command-visibility tiers (`src/core/commandVisibility.js`), and the shared `AI_*` provider env that Gork uses ([gork.md](gork.md)). |

## Purpose

Staff refer a message or a user. A **separate** LLM harness reads the case and recommends the moderation action — if any — and can later perform it. The long-term goal is that disciplinary decisions are made by this harness.

This milestone ships **recommendations as the default** plus the framework that turns individual actions on: every action has its own `off` / `suggest` / `auto` mode, and the whole feature starts switched off. Staff opt in action by action; a guild that enables the master switch kicks and bans nobody.

Case flow (locked shape):

```
Staff refers a message or a user (/automod refer, or the message context menu;
optional short explanation from the referrer)
        → master switch off        → the referral reply names that specific cause
        → rules text + automod channel required before a case runs
        → assemble: guild rules, referral, bounded message window,
                    that user's warnings, that user's staff notes
        → harness runs (own prompt, tools, daily budget — never Gork's queue)
        → only actions whose mode is not `off` are offered to the model
        → commit time: harness enforces one staff note per considered user
        → case card posts to the automod channel
             suggest → Approve runs the auto executor · Dismiss records the decline
             auto    → the executor already ran; the card reports the result
```

---

### 13.1 Intake — staff referral only

| Rule | Detail |
|------|--------|
| Surfaces | `/automod refer` **and** a message context menu |
| Explanation | A referrer **may** attach a short explanation; it is part of the case |
| No passive scan | The bot does **not** scan ordinary chat. Nothing runs on message content by itself |
| No member reports | Members cannot file a case. Referral is a staff action |

---

### 13.2 Modes — `off` / `suggest` / `auto` per action

Three modes **per action**, each `off`, `suggest`, or `auto`. Default **suggest** for every action. The master switch defaults **off**.

| Mode | Semantics |
|------|-----------|
| `off` | The tool is **not offered** to the model and **cannot run**. The case card must not recommend it |
| `suggest` | The model may select it and the automod channel shows it. Staff **Approve** runs the **same executor** auto mode uses. **Dismiss** records the decline and does not run it |
| `auto` | The executor runs it and the card reports the result. **No approve button** |

Suggest-mode Approve is how staff carry out a recommendation without redoing it by hand. Setting a mode to `auto` is the step that removes that decision.

---

### 13.3 Action set

The model may **combine** actions in one case — e.g. delete the message **and** open a ticket.

| Action | Contract |
|--------|----------|
| No action | The user **was considered and is not being sanctioned** (they came close, or a sanction is not warranted). It is **not** for bystanders |
| Warning | The **formal permanent record** (`createWarning`), distinct from a staff note. See [warnings.md](warnings.md) |
| Delete message | Removes specific messages only |
| Ticket | The existing help-ticket system ([help-tickets.md](help-tickets.md)). The subject is in the ticket. Purpose: discuss what happened or explain the rules. Ticket text is **member-visible** and must **not** contain staff-note bodies or other staff-only history |
| Timeout | Subject to [13.6](#136-staff-as-subjects-and-execution-guards) + the circuit breaker before `auto` is usable |
| Kick | Subject to [13.6](#136-staff-as-subjects-and-execution-guards) + the circuit breaker before `auto` is usable |
| Ban | Subject to [13.6](#136-staff-as-subjects-and-execution-guards) + the circuit breaker before `auto` is usable |

---

### 13.4 Staff note tool — always on

The staff-note tool is **always on**. It has **no mode flag** and cannot be disabled.

- Write **one** staff note per user per case when that user is considered or acted on — including no-action, a suggestion, a refusal, or an execution.
- A person who only appears in the message context, and whom the model does not consider because they did not come close to a rule violation, gets **no** note and **no** action tool call.
- The harness **enforces this at commit time**. It does not rely on the prompt alone.

---

### 13.5 Judgment inputs

| Input | Note |
|-------|------|
| Guild's written rules | Required before a case runs |
| The referral | Including the referrer's optional explanation |
| Message window | Bounded |
| Warnings | That user's warnings |
| Staff notes | That user's staff notes |

Lookup tools exist for **another user the model is actually considering** — not for browsing the guild.

---

### 13.6 Staff as subjects and execution guards

The card **may recommend** an action against a staff member. Execution refuses:

| Stage | Behavior against a staff-role subject, or anyone the bot's role cannot moderate |
|-------|----------------------------------------------------------------------------------|
| Recommendation | **Allowed** — the card may show it |
| Warn / delete / ticket / timeout / kick / ban | **Refuse** to execute |
| Staff note | Still records the consideration **and** the refusal |

---

### 13.7 Harness — separate from Gork

| Aspect | Decision |
|--------|----------|
| Feature | Own feature, own prompt, own tools, own **daily budget** — separate from Gork's per-scope budget ([gork.md](gork.md)) |
| Provider env | **Shared:** `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` — same as Gork and the ticket summaries |
| Isolation | A case must **not** increment Gork's budget or enter Gork's queue |

---

### 13.8 Platform — Discord only

Discord only for this milestone. **Fluxer is explicit no-parity**, stated in the docs in the same change as the feature. No Fluxer tools; see [13.10](#1310-out-of-scope).

---

### 13.9 Defaults that keep auto off until staff opt in

- Master enable is **off**. Referrals reply with that specific cause.
- Rules text **and** an automod channel are required before a case runs.
- Action modes default to **suggest**, so enabling the master switch does not start kicking or banning.
- Suggest-mode Approve is how staff carry out a recommendation without redoing it by hand. Setting a mode to `auto` is the step that removes that decision.
- Both the mode change and the master switch are **Manage Guild**.

---

### 13.10 Out of scope

- Passive scanning of chat.
- Member-filed reports.
- Appeals.
- The web admin console.
- Fluxer tools (explicit no-parity, [13.8](#138-platform--discord-only)).
- Banning as a way to bulk-delete history — the delete tool removes specific messages only.

---

### 13.11 Design decisions (locked)

Numbered to match epic #723. The sections above are the detail; they are not a second policy.

| # | Decision |
|---|----------|
| 1 | **Intake is staff referral only** — `/automod refer` + a message context menu, optional short explanation. No passive scan; members cannot file a case. ([13.1](#131-intake--staff-referral-only)) |
| 2 | **Three modes per action** (`off` / `suggest` / `auto`), default **suggest**; master switch default **off**. `off` = unoffered and unrunnable and never recommended on the card; `suggest` = staff Approve runs the auto executor, Dismiss records the decline; `auto` = executes and the card reports, no approve button. ([13.2](#132-modes--off--suggest--auto-per-action)) |
| 3 | **Combinable action set:** no action, warning, delete message, open ticket, timeout, kick, ban. No-action = considered and not sanctioned (never bystanders); warning = the formal permanent record via `createWarning`; ticket = existing help tickets, subject included, member-visible text never carries staff-note bodies or staff-only history. ([13.3](#133-action-set)) |
| 4 | **Staff note tool always on**, no mode flag, cannot be disabled. One note per considered user per case (no-action, suggestion, refusal, or execution); context-only participants get no note and no action tool call; enforced **at commit time**, not by prompt alone. ([13.4](#134-staff-note-tool--always-on)) |
| 5 | **Judgment inputs:** guild rules, the referral, a bounded message window, that user's warnings, that user's staff notes. Lookup tools for another user the model is actually considering. ([13.5](#135-judgment-inputs)) |
| 6 | **Staff as subjects:** recommendations against staff are allowed; warn, delete, ticket, timeout, kick, and ban **refuse** to execute against a staff role or anyone the bot's role cannot moderate; the staff note records the consideration and the refusal. ([13.6](#136-staff-as-subjects-and-execution-guards)) |
| 7 | **Separate from Gork:** own feature, prompt, tools, and daily budget; shared provider env (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`); a case never increments Gork's budget or enters Gork's queue. ([13.7](#137-harness--separate-from-gork)) |
| 8 | **Discord only** for this milestone; Fluxer is explicit no-parity in the docs. ([13.8](#138-platform--discord-only)) |
| 9 | **Out of scope:** passive scanning, member reports, appeals, the web console, Fluxer tools, banning as bulk history deletion. ([13.10](#1310-out-of-scope)) |

---

### 13.12 Implementation order (design context)

The dependency order the decisions force — it is context for the milestone, not a checklist; the work is the milestone's issues.

Settings and the pure mode/note rules can land first. Referral, context assembly, and the harness come next. The case card comes before any sanction tool. No-action and staff notes come before warn / delete / ticket / timeout / kick / ban. The circuit breaker lands before `auto` kick, ban, or timeout is usable. Live verification stays open until the dated Discord record exists.
