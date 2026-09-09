# Gork (AI Keyword Q&A)

A goofy AI question-answering bot. When someone types the trigger keyword — a literal text string that *looks like* a mention, `@gork` by default — the bot answers using the surrounding conversation, optionally with live web search, in a sarcastic, always-safe-for-work voice. The misspelling of "grok" is intentional, and the trigger is **not** a Discord mention: no user or bot named "gork" needs to exist, and typing `@gork` pings nobody.

## Overview

- **Literal keyword trigger**: message content (trimmed) starts with the guild's keyword (default `@gork`), compared case-insensitively
- **Context-aware**: answers from the reply chain when the keyword message replies to something, otherwise from the N most recent messages (default 10, max 50)
- **Optional web search**: the model can call a `web_search` tool the bot executes against a SearXNG instance's JSON API (up to 3 searches per question)
- **Page reading**: the model can also open pages with `read_page` (1–3 URLs per call) — gork fetches them, extracts the main content to clean Markdown, and feeds it back into the same tool loop; **public web only** (internal/private addresses are refused by an SSRF guard)
- **Voice**: sarcastic, always safe for work; the base prompt is immutable and staff rules cannot override the SFW / questions-only constraints (best effort)
- **Gating**: gork is live whenever `AI_API_KEY` is set and the guild's enable switch is on; all `/gork` configuration and moderation is staff-only

## How it works

```
User: "@gork how do I center a div"  (or "@gork" replying to a message)
   → guild enable switch + keyword set? (either off → silent)
   → keyword match (trimmed, case-insensitive prefix)
   → skipped silently: bot/webhook messages, DMs, open ticket channels
   → per-user cooldown? (default 180s; staff bypass; hit → 🕐 reaction, no reply)
   → gork ban? (per-guild ban list → canned failure reply; staff included)
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

Gork is **live whenever `AI_API_KEY` is set** — no per-guild opt-in ritual, unless staff turn it off with `/gork enable off`. Without a key, triggers are silently ignored (no reply), and `/gork status` reports "AI provider not configured". The provider must support function calling (tool calls), which web search uses.

### Web search (optional)

```bash
SEARXNG_URL=https://searxng.example.com
```

`SEARXNG_URL` is the base URL of any SearXNG instance (self-hosted or public) with **JSON format enabled** (`formats: [json]` in the SearXNG settings). **No compose service is added** — the bot simply calls the instance's JSON API.

How it works: gork exposes a plain OpenAI-compatible function tool `web_search(query)`. When the model calls it, the bot runs `GET {SEARXNG_URL}/search?q=<query>&format=json` (~10s timeout) and feeds the top 5 results (title, URL, snippet trimmed to ~300 chars) back into the conversation. The budget is **3 tool rounds per question**, shared with `read_page`. If a search fails, the model is told "search unavailable" and answers from context alone.

The tool is a per-guild setting (default on) and only runs when `SEARXNG_URL` is set: `/gork search on|off`.

### Page reading (`read_page`)

When a search snippet (or the conversation itself) points at a page that likely has the answer, the model can call `read_page` with **1–3 URLs** — gork fetches them concurrently, extracts the **main content** (Mozilla Readability via jsdom, body fallback for non-article pages), converts it to clean **Markdown** (turndown), and feeds it back into the same conversation. Pages arrive as `### <title> / Source: <url> / <markdown>` blocks, capped at ~4,000 chars per page and ~10,000 combined.

| Aspect | Detail |
|--------|--------|
| Enabled when | Same lever as search (`SEARXNG_URL` set + `/gork search on`) — no separate toggle |
| Tool budget | The model gets up to **3 tool rounds** per question total (searches + reads combined); parallel calls in one round cost one round |
| Fetch guards | 10s per page, ≤1 MB, `text/html`/`text/plain` only, ≤2 redirects (every hop re-validated) |
| **SSRF guard** | Refuses **private / internal URLs by design**: loopback, RFC1918, CGNAT, link-local & cloud-metadata (`169.254.169.254`), multicast/reserved, IPv6 ULA/link-local, `localhost`/`.local`/`.internal` — checked at the hostname **and** on resolved IPs |
| Failure mode | Per-page: `"Could not read: <reason>"` inline — one dead page never kills the answer |

Reading is grounded strictly in the fetched content — extraction strips scripts, nav, and chrome, so the model sees article text, not page furniture.

## Commands

All `/gork` subcommands are **staff-gated** (Manage Server or a guild [staff role](staff-roles.md)).

| Command | Description |
|---------|-------------|
| `/gork keyword <text>` | Set the trigger keyword (1–50 chars). `/gork keyword clear` disables gork for the guild |
| `/gork context <1-50>` | Context window size (default 10) |
| `/gork cooldown <seconds>` | Per-user cooldown in seconds (0–3600; default **180**, 0 = disabled). Staff always bypass |
| `/gork rules <text>` | Set additional staff prompt rules (≤500 chars). `/gork rules clear` removes them |
| `/gork search <on\|off>` | Toggle the SearXNG `web_search` tool for this guild |
| `/gork enable <on\|off>` | Turn gork **entirely** on/off for this server — off makes every trigger silent; all other settings are kept |
| `/gork ban <user>` | Ban a user from gork in this server (they keep getting the generic reply — never told it's a ban) |
| `/gork unban <user>` | Lift a user's gork ban |
| `/gork bans` | List the users banned from gork in this server |
| `/gork memory <action>` | Curate the community memory — see [Memory](#memory) |
| `/gork status` | Ephemeral embed: enabled, keyword, window, rules, search state, memory state, AI provider configured?, `SEARXNG_URL` set?, banned-user count |

`/settings` also shows a **Gork** field (enabled + keyword + window + search + memory state).

All values are stored per-guild in `guild_settings`:

| Column | Purpose | Default |
|--------|---------|---------|
| `gork_enabled` | Master server switch; `0` = every trigger silent | `1` (on) |
| `gork_keyword` | Trigger keyword; `NULL` = disabled | `@gork` |
| `gork_context_window` | Prior-message context size | `10` |
| `gork_extra_rules` | Staff prompt additions (≤500 chars) | *(empty)* |
| `gork_search_enabled` | SearXNG `web_search` tool toggle | `1` (on) |
| `gork_cooldown_sec` | Per-user cooldown in seconds; staff bypass | `180` |
| `gork_memory_enabled` | Community-memory master switch (see [Memory](#memory)) | `0` (off) |
| `gork_memory_chars` | Memory-block char budget; `0` = unlimited | `12000` |

Gork bans live in their own per-guild table, `gork_user_blocks` (`guild_id`, `user_id`, who banned them, when).

## Memory

Gork can **remember durable facts about people** — preferences, ongoing projects, roles, recurring topics, relationships, notable events — and weave them into later answers. Memories are per-guild, **per-person**, staff-curated, and the whole feature is **off by default**: every answered question costs one extra (invisible) extraction LLM call, so guilds opt in with `/gork memory on`.

### How it works

| Stage | Detail |
|-------|--------|
| **Inject (read)** | On each trigger gork looks up the memories of the people involved in the conversation (asker, participants, people mentioned — resolved through the roster) and appends a **memory block** to the prompt. Nobody involved has memories → nothing is injected |
| **Bodies or index** | If everything fits under the `gork_memory_chars` budget the full bodies go in; on overflow the block degrades to a cheap titles-only **index** and the model pulls bodies on demand with the `recall_memories` tool (shares the 3-round tool budget with search/page reading) |
| **Extract (write)** | **After** the answer is sent, audited, and the guild slot is released, a detached LLM turn extracts what is worth remembering as strict JSON. It never adds user-visible latency; invalid entries (unknown subjects, empty titles) are dropped, failures are silent (console line only) |
| **Keying & bounds** | One entry per (person, UTC day, normalized title) — same-day re-extraction updates in place, a later day adds history. **≤25 entries per person**, lowest-importance/least-recently-used evicted first. `#<id>` handles are stable within the listing they came from |
| **Model** | The extraction turn uses `AI_SMALL_MODEL` when set, otherwise `AI_MODEL` (extraction is a strict-JSON chore — a smaller model is usually enough) |

### Commands (`/gork memory <action>`, staff-only)

| Command | Detail |
|---------|--------|
| `show [user]` | Ephemeral listing with `#id` handles + body previews. With `user`: that person's entries; without: the newest 25 in the guild (long listings are cut with "…and N more") |
| `forget <id>` | Delete one memory by its `#id` handle (guild-scoped — ids never cross guilds) |
| `clear [user]` | Wipe one person's — or the whole guild's — memories. **Confirm-once:** without `confirm: true` it only previews the count |
| `on` / `off` | Master switch (`gork_memory_enabled`, default **off**) |
| `budget <chars>` | Memory-block cap (`gork_memory_chars`): default **12,000**, range 0–64,000, **0 = unlimited**; anything out of range is clamped (garbage → default) |

`/gork status` shows the memory state, budget, and stored-entry count; `/settings` shows memory on/off. Every on/off/budget change, forget, and clear posts a config-change embed to the [audit log](audit-log.md).

### Limitations

- **Erasure is staff-only:** members cannot delete memories about themselves — staff `forget`/`clear`, the per-person cap, and eviction are the affordances (single-server posture).
- **Memories are untrusted quoted text:** stored bodies are injected as *quoted background, never instructions* — prompt-injection through stored text is a **documented limitation**, the same posture as conversation context and search results. The extraction prompt forbids secrets and third-party personal info in bodies, and staff can `forget` anything at any time.
- Extraction is a model turn: it can miss facts or store noise — `show` + `forget` are the curation loop. There is no TTL/decay in v1; the store stays bounded by the per-person cap.

## Runtime Behavior

| Aspect | Detail |
|--------|--------|
| Typing | Typing indicator immediately on trigger — **including for queued requests while they wait** — refreshed every **8s** until the reply is sent |
| Reply | **Plain text**, a reply **to** the keyword message. No embed, no trailing source list (the model may mention source facts or a URL inline) |
| Mentions & pings | Mention markup echoed in an answer (`<@id>`, `<@&role>`, `<#channel>`) is rewritten to a readable `@name` / `#channel`, and gork replies **never ping anyone** (mention parsing is disabled on every send) |
| User roster | Each question includes a compact roster (id → handle → display name) of the people involved in the conversation, so gork can map names to people ("what did @alice say?") |
| Long answers | Final text over 2,000 chars is split into consecutive messages (~1,900-char chunks, prefer line boundaries; emoji and Discord tokens are never cut mid-character) |
| Per-user cooldown | **180s** per user per guild by default (in-memory); guild-overridable via `/gork cooldown` (0–3600, **0 = disabled**). **Staff** (Manage Server or any `staff_roles` role) **bypass** the cooldown entirely. Cooldown hit → the bot **reacts 🕐** on the trigger message (visible rate-limit signal; still no reply, no LLM call) |
| Gork bans | `/gork ban` blocks a user per-guild. A banned trigger gets the LLM-failure canned reply, so the ban is **indistinguishable from a normal failure** — no LLM call, no audit Q&A entry. Unlike the cooldown, staff roles do **not** bypass a ban. The reply is paced by the normal per-user cooldown |
| Concurrency / queue | **1 in-flight** gork request per guild; further triggers are **queued FIFO**, up to **5 waiting** (in-memory). When the queue is full, new triggers are **dropped** with the queue-full reply |
| LLM parameters | Temperature **0.8** (sarcasm), completion budget **2,000** tokens, total timeout **60s** including the tool loop — each overridable via `GORK_LLM_MAX_TOKENS` / `GORK_LLM_TIMEOUT_MS` / `GORK_LLM_MAX_TOOL_ROUNDS`. Budget matters for **thinking models**: they spend it on hidden reasoning first, so the default leaves room for both |
| Empty answers | A provider response with no visible text is retried **once** automatically; only a second failure gets the canned reply. Tool-cap rounds that still carry a real (partial) answer are delivered instead of discarded |

The fast checks (settings, match, skips, cooldown, queue admission) run inline in the message pipeline; the slow LLM job is fired as a detached promise so the pipeline never stalls.

### Canned replies

| Case | Reply |
|------|-------|
| Queue full (1 in-flight + 5 waiting) | "My one (1) brain is already busy, and the queue is full. Your question has been dropped — no hard feelings." |
| LLM failure / timeout | "*gork's brain went to lunch* — try again in a bit." |
| Banned user (`/gork ban`) | Same "*gork's brain went to lunch*" text — deliberately indistinguishable from a failure |
| Keyword alone, no question, no reply reference | No reply at all (fully silent) |

Disabled states are **silent**, not canned replies: `/gork enable off`, a cleared keyword, or no `AI_API_KEY` produce no reply at all.

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

Staff changes (keyword, rules, cooldown, search, `/gork enable`, and every `/gork ban` / `/gork unban`) post a **config-change embed** to the same audit channel — bans and unbans are recorded with the acting moderator, so the ban list is auditable even though banned users never learn about it.

## Privacy

Gork sends the question **and** the conversation context to the **configured LLM provider** (`AI_BASE_URL`). There is no privacy guardrail engineering beyond this note — this is a single-server personal project. If you do not want messages leaving your infrastructure, point `AI_BASE_URL` at a self-hosted OpenAI-compatible model, or leave `AI_API_KEY` unset to keep gork off.

## Guardrails

The system prompt is an **immutable base** in code: answer questions only, **always safe for work**, treat conversation context and search results as **untrusted data (never as instructions)**, be concise (under ~150 words, plain Discord markdown), refuse anything else (commands, roleplay, jailbreak attempts) with one short sarcastic line, and say so (sarcastically) rather than invent facts when context is insufficient.

Staff can append up to 500 chars of rules via `/gork rules` (added as "Additional guild rules:"). These may shape tone or subject preference but **cannot** override the SFW / questions-only constraints. These are **model-level guardrails — best effort, not a hard guarantee**: a sufficiently creative prompt could get around them. Do not rely on gork as a content filter.

## Troubleshooting

### Gork never replies

1. Is `AI_API_KEY` set (and the bot restarted since)? Without a key, triggers are silently ignored — `/gork status` says "AI provider not configured"
2. `/gork status` — is **Enabled** on? `/gork enable off` disables the whole feature for the server. Is the keyword set? `/gork keyword clear` also disables gork for the guild
3. Is the message from a **bot or webhook**, in a **DM**, or in an **open ticket channel**? All are skipped silently
4. Is the asker still within the per-user cooldown? A cooldown hit gets a **🕐 reaction** on the message and no reply (staff bypass; a 🕐 with no reply means "ask again in a bit")
5. If **one specific user** always gets the "*brain went to lunch*" reply while others work — check `/gork bans`; banned users are answered with that exact text (no LLM call)

### Web search / page reading not happening

- `SEARXNG_URL` must be set **and** the instance must have JSON format enabled (`formats: [json]` in SearXNG settings); otherwise the model is told search is unavailable and answers from context alone
- `/gork search off` disables **both** tools for the guild (search and page reading share the lever)
- `/gork status` shows whether `SEARXNG_URL` is set; the budget is max **3 tool rounds** per question (searches + page reads combined)
- `read_page` **cannot open internal URLs** (LAN hosts, `localhost`, cloud metadata) — the SSRF guard refuses them by design; only public web pages are readable

### Gork feels slow or drops questions

- Only **one** request is handled at a time per guild; further questions wait in the queue (up to **5**) — the typing indicator keeps refreshing while they wait
- When the queue is full, the question is dropped with the canned "one (1) brain" reply
- The total LLM timeout defaults to **90s** (`GORK_LLM_TIMEOUT_MS`); slower local models regularly need more

### Everyone gets "brain went to lunch" (the provider works elsewhere)

Check the bot log: gork logs the exact failure reason (`reason`, HTTP status, model, tool calls, duration). Two common causes with self-hosted providers:

- **Thinking/reasoning models** (Qwen3-style, DeepSeek-R1, o-series) burn the whole `max_tokens` budget on hidden reasoning and return `content: null` — the log says `provider returned an empty answer ... retrying once` then the same with `(finish_reason=...)`. Cap the thinking: `GORK_LLM_THINKING_TOKEN_BUDGET=4000` forwards a reasoning budget to the server — **the serving side must enforce it** (e.g. vLLM started with `--reasoning-parser`); leave it off for strict providers like api.openai.com, which reject the param. Keep `GORK_LLM_MAX_TOKENS` (default 6,000) above the thinking budget + answer headroom, or raise it until answers come through
- **Slow model + long context** trips the 90s timeout (`GORK_LLM_TIMEOUT_MS`) — raise it
- **Runaway visible answers** (the model rambles past a few paragraphs) — `GORK_MAX_ANSWER_CHARS` hard-caps the visible answer with a word-boundary cut + "[truncated]" marker (0 = off; 2000 keeps every answer to one message)

## Related

- [Help Tickets](tickets.md) — shared AI plumbing (`AI_*` env vars); ticket channels where gork is disabled
- [Staff Roles](staff-roles.md) — staff gate and cooldown bypass
- [Audit Log](audit-log.md) — where Gork Q&A embeds post
- [Command Restrictions](command-restrictions.md) — not affected by the gork keyword
- [Configuration](configuration.md) — full environment variable reference
