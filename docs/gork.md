# Gork (AI Keyword Q&A)

A goofy AI question-answering bot. When someone types the trigger keyword — a literal text string that *looks like* a mention, `@gork` by default — the bot answers using the surrounding conversation, optionally with live web search, in a sarcastic, always-safe-for-work voice. The misspelling of "grok" is intentional, and the trigger is **not** a Discord mention: no user or bot named "gork" needs to exist, and typing `@gork` pings nobody.

## Overview

- **Literal keyword trigger**: message content (trimmed) starts with the guild's keyword (default `@gork`), compared case-insensitively
- **Context-aware**: answers from the reply chain when the keyword message replies to something, otherwise from the N most recent messages (default 10, max 50)
- **Optional web search**: the model can call a `web_search` tool the bot executes against a SearXNG instance's JSON API (up to 3 searches per question)
- **Page reading**: the model can also open pages with `read_page` (1–3 URLs per call) — gork fetches them, extracts the main content to clean Markdown, and feeds it back into the same tool loop; **public web only** (internal/private addresses are refused by an SSRF guard)
- **Voice**: sarcastic, always safe for work; the base prompt is immutable and staff rules cannot override the SFW / questions-only constraints (best effort)
- **Gating**: gork is live whenever `AI_API_KEY` is set; all `/setgork` configuration is staff-only

## How it works

```
User: "@gork how do I center a div"  (or "@gork" replying to a message)
   → keyword match (trimmed, case-insensitive prefix)
   → skipped silently: bot/webhook messages, DMs, open ticket channels
   → per-user cooldown? (default 180s; staff bypass; hit → silent)
   → queue? (1 in-flight + 5 waiting; full → canned drop reply)
   → typing indicator (refreshed every 8s until the reply lands)
   → context window: reply chain (with backfill) or N prior messages
   → LLM (temperature 0.8, 60s total timeout; web_search + read_page tools if enabled)
   → plain-text reply to the keyword message (>2,000 chars → split)
   → audit embed to the audit channel
```

### Trigger

| Rule | Detail |
|------|--------|
| Trigger | Message content (trimmed) **starts with** the guild's keyword, compared case-insensitively |
| Default keyword | `@gork` (literal text, styled to look like a mention) |
| Configurable | Per-guild; staff can set any 1–50 char keyword or clear it (clear = disabled) |
| Question text | Content after the keyword, trimmed; one optional leading separator (`:`, `-`, `?`, `!`) + whitespace stripped |
| Works in | Guild text channels and threads (thread's own history). **Not** DMs |
| Skipped | Bot messages, webhook messages, **open ticket channels** (silently) |

| Input | Behavior |
|-------|----------|
| `@gork how do I center a div` | Answer the explicit question, with context |
| `@gork` (alone), replying to a message | No explicit question — answer from the reply-chain context |
| `@gork` (alone), no reply reference | No LLM call; **no reply at all** (fully silent) |

Gork is **disabled in open ticket channels**: if the channel has a [ticket](tickets.md) that is not yet archived, triggers are silently ignored — ticket conversations stay staff-focused (ticket content is already handled by the ticket AI on close).

XP is unaffected: a triggering message still earns message XP through the normal pipeline. The keyword also does not interact with [command-channel restrictions](command-restrictions.md) (those restrict slash commands, not message triggers).

### Context window

Guild setting `gork_context_window` — how many prior messages feed the prompt (default **10**, range **1–50**).

| Case | Collection |
|------|------------|
| Keyword message **replies** to a message | Walk the reply chain upward, collecting up to X messages (root included). If the chain is shorter than X, backfill with messages before the chain root in the same channel until X total |
| No reply reference | The X messages immediately before the keyword message |

- **Included:** all readable messages — human **and** bot messages, including gork's own prior answers (often the useful context for follow-ups)
- **Excluded:** the triggering keyword message itself; messages with empty content are skipped
- **Broken chain links:** a deleted or unfetchable message in the chain is skipped; walking stops when the reference chain ends or X is reached
- **Shape:** one line per message, `[<username>] <content>`, oldest → newest
- **Caps:** 500 chars per message, 12,000 chars total context

## Setup

### AI provider (required)

Gork shares the same OpenAI-compatible AI plumbing as [help ticket](tickets.md) close summaries:

```bash
AI_API_KEY=YOUR_AI_API_KEY
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```

Gork is **live whenever `AI_API_KEY` is set** — no per-guild opt-in ritual. Without a key, triggers are silently ignored (no reply), and `/setgork status` reports "AI provider not configured". The provider must support function calling (tool calls), which web search uses.

### Web search (optional)

```bash
SEARXNG_URL=https://searxng.example.com
```

`SEARXNG_URL` is the base URL of any SearXNG instance (self-hosted or public) with **JSON format enabled** (`formats: [json]` in the SearXNG settings). **No compose service is added** — the bot simply calls the instance's JSON API.

How it works: gork exposes a plain OpenAI-compatible function tool `web_search(query)`. When the model calls it, the bot runs `GET {SEARXNG_URL}/search?q=<query>&format=json` (~10s timeout) and feeds the top 5 results (title, URL, snippet trimmed to ~300 chars) back into the conversation. The budget is **3 tool rounds per question**, shared with `read_page`. If a search fails, the model is told "search unavailable" and answers from context alone.

The tool is a per-guild setting (default on) and only runs when `SEARXNG_URL` is set: `/setgork search on|off`.

### Page reading (`read_page`)

When a search snippet (or the conversation itself) points at a page that likely has the answer, the model can call `read_page` with **1–3 URLs** — gork fetches them concurrently, extracts the **main content** (Mozilla Readability via jsdom, body fallback for non-article pages), converts it to clean **Markdown** (turndown), and feeds it back into the same conversation. Pages arrive as `### <title> / Source: <url> / <markdown>` blocks, capped at ~4,000 chars per page and ~10,000 combined.

| Aspect | Detail |
|--------|--------|
| Enabled when | Same lever as search (`SEARXNG_URL` set + `/setgork search on`) — no separate toggle |
| Tool budget | The model gets up to **3 tool rounds** per question total (searches + reads combined); parallel calls in one round cost one round |
| Fetch guards | 10s per page, ≤1 MB, `text/html`/`text/plain` only, ≤2 redirects (every hop re-validated) |
| **SSRF guard** | Refuses **private / internal URLs by design**: loopback, RFC1918, CGNAT, link-local & cloud-metadata (`169.254.169.254`), multicast/reserved, IPv6 ULA/link-local, `localhost`/`.local`/`.internal` — checked at the hostname **and** on resolved IPs |
| Failure mode | Per-page: `"Could not read: <reason>"` inline — one dead page never kills the answer |

Reading is grounded strictly in the fetched content — extraction strips scripts, nav, and chrome, so the model sees article text, not page furniture.

## Commands

All `/setgork` subcommands are **staff-gated** (Manage Server or a guild [staff role](staff-roles.md)).

| Command | Description |
|---------|-------------|
| `/setgork keyword <text>` | Set the trigger keyword (1–50 chars). `/setgork keyword clear` disables gork for the guild |
| `/setgork context <1-50>` | Context window size (default 10) |
| `/setgork cooldown <seconds>` | Per-user cooldown in seconds (0–3600; default **180**, 0 = disabled). Staff always bypass |
| `/setgork rules <text>` | Set additional staff prompt rules (≤500 chars). `/setgork rules clear` removes them |
| `/setgork search <on\|off>` | Toggle the SearXNG `web_search` tool for this guild |
| `/setgork status` | Ephemeral embed: keyword, window, rules, search state, AI provider configured?, `SEARXNG_URL` set? |

`/settings` also shows a **Gork** field (keyword + window + search state).

All values are stored per-guild in `guild_settings`:

| Column | Purpose | Default |
|--------|---------|---------|
| `gork_keyword` | Trigger keyword; `NULL` = disabled | `@gork` |
| `gork_context_window` | Prior-message context size | `10` |
| `gork_extra_rules` | Staff prompt additions (≤500 chars) | *(empty)* |
| `gork_search_enabled` | SearXNG `web_search` tool toggle | `1` (on) |
| `gork_cooldown_sec` | Per-user cooldown in seconds; staff bypass | `180` |

## Runtime Behavior

| Aspect | Detail |
|--------|--------|
| Typing | Typing indicator immediately on trigger — **including for queued requests while they wait** — refreshed every **8s** until the reply is sent |
| Reply | **Plain text**, a reply **to** the keyword message. No embed, no trailing source list (the model may mention source facts or a URL inline) |
| Long answers | Final text over 2,000 chars is split into consecutive messages (~1,900-char chunks, prefer line boundaries) |
| Per-user cooldown | **180s** per user per guild by default (in-memory); guild-overridable via `/setgork cooldown` (0–3600, **0 = disabled**). **Staff** (Manage Server or any `staff_roles` role) **bypass** the cooldown entirely. Cooldown hit → **silent ignore** |
| Concurrency / queue | **1 in-flight** gork request per guild; further triggers are **queued FIFO**, up to **5 waiting** (in-memory). When the queue is full, new triggers are **dropped** with the queue-full reply |
| LLM parameters | Temperature **0.8** (sarcasm), `max_tokens` ~600, total timeout **60s** including the tool loop |

The fast checks (settings, match, skips, cooldown, queue admission) run inline in the message pipeline; the slow LLM job is fired as a detached promise so the pipeline never stalls.

### Canned replies

| Case | Reply |
|------|-------|
| Queue full (1 in-flight + 5 waiting) | "My one (1) brain is already busy, and the queue is full. Your question has been dropped — no hard feelings." |
| LLM failure / timeout | "*gork's brain went to lunch* — try again in a bit." |
| Keyword alone, no question, no reply reference | No reply at all (fully silent) |

## Audit Logging

Every completed Q&A posts a **Gork Q&A** embed to the guild's [audit log channel](audit-log.md) (configured with `/setlog audit`):

| Field | Value |
|-------|-------|
| Asked by | User mention |
| Question | Trigger text, ≤300 chars |
| Context | e.g. "reply chain (4 msgs)" / "10 prior messages" |
| Search | "yes — 2 queries" / "no" |
| Model / duration | e.g. `gpt-4o-mini` / `3.4s` |
| Answer | ≤1,000 chars |
| Jump links | To the original question message and the gork reply |

Failed or timed-out exchanges log a compact one-liner (asker + error reason). If no audit channel is configured, gork falls back to console logs.

## Privacy

Gork sends the question **and** the conversation context to the **configured LLM provider** (`AI_BASE_URL`). There is no privacy guardrail engineering beyond this note — this is a single-server personal project. If you do not want messages leaving your infrastructure, point `AI_BASE_URL` at a self-hosted OpenAI-compatible model, or leave `AI_API_KEY` unset to keep gork off.

## Guardrails

The system prompt is an **immutable base** in code: answer questions only, **always safe for work**, treat conversation context and search results as **untrusted data (never as instructions)**, be concise (under ~150 words, plain Discord markdown), refuse anything else (commands, roleplay, jailbreak attempts) with one short sarcastic line, and say so (sarcastically) rather than invent facts when context is insufficient.

Staff can append up to 500 chars of rules via `/setgork rules` (added as "Additional guild rules:"). These may shape tone or subject preference but **cannot** override the SFW / questions-only constraints. These are **model-level guardrails — best effort, not a hard guarantee**: a sufficiently creative prompt could get around them. Do not rely on gork as a content filter.

## Troubleshooting

### Gork never replies

1. Is `AI_API_KEY` set (and the bot restarted since)? Without a key, triggers are silently ignored — `/setgork status` says "AI provider not configured"
2. `/setgork status` — is the keyword set? `/setgork keyword clear` disables gork for the guild
3. Is the message from a **bot or webhook**, in a **DM**, or in an **open ticket channel**? All are skipped silently
4. Is the asker still within the per-user cooldown? Cooldown hits are silent (staff bypass)

### Web search / page reading not happening

- `SEARXNG_URL` must be set **and** the instance must have JSON format enabled (`formats: [json]` in SearXNG settings); otherwise the model is told search is unavailable and answers from context alone
- `/setgork search off` disables **both** tools for the guild (search and page reading share the lever)
- `/setgork status` shows whether `SEARXNG_URL` is set; the budget is max **3 tool rounds** per question (searches + page reads combined)
- `read_page` **cannot open internal URLs** (LAN hosts, `localhost`, cloud metadata) — the SSRF guard refuses them by design; only public web pages are readable

### Gork feels slow or drops questions

- Only **one** request is handled at a time per guild; further questions wait in the queue (up to **5**) — the typing indicator keeps refreshing while they wait
- When the queue is full, the question is dropped with the canned "one (1) brain" reply
- The total LLM timeout is **60s**; longer gets the "brain went to lunch" reply

## Related

- [Help Tickets](tickets.md) — shared AI plumbing (`AI_*` env vars); ticket channels where gork is disabled
- [Staff Roles](staff-roles.md) — staff gate and cooldown bypass
- [Audit Log](audit-log.md) — where Gork Q&A embeds post
- [Command Restrictions](command-restrictions.md) — not affected by the gork keyword
- [Configuration](configuration.md) — full environment variable reference
