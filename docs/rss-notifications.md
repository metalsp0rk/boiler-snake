# RSS Feed Notifications

Subscribe to any number of RSS/Atom feeds per community and have **new entries** announced to your notification channel — optionally mentioning one configured role. No API keys, no external services: the bot polls the feeds itself.

## Overview

- **New-entry announcements only**: one message per new feed entry (feed edits/deletions are not detected in v1)
- **Any number of feeds per community** — the same URL in several communities is fine; default cap **20 per community** (`RSS_MAX_FEEDS_PER_COMMUNITY` override)
- **Its own routing**: per-community `rss_notification_channel_id`, independent of the YouTube/Twitch channel and role pairs — no cross-feature fallback
- **Strict role ping**: only the role configured with `/setrss role`, never `@everyone`, never a fallback
- **Polling**: a fixed 5-minute aligned scheduler tick, gated per community on `rss_polling_interval_minutes` (1–60, default **15**) — see [Poll behavior](#poll-behavior)
- **Polite + cheap**: conditional GET (`ETag` / `Last-Modified`) makes an unchanged feed a free `304` poll; failing feeds back off exponentially (cap 6 h)
- **SSRF-guarded**: only public web addresses are ever fetched — validated at `/rss add` **and** on every single poll (see [Fetch security](#fetch-security-ssrf-posture))

## Setup

No required environment variables — the feature is live as soon as the bot runs. Both command families are **staff tier**: the handlers require Manage Server **or** any configured [staff role](staff-roles.md), and the slash picker hides the commands from members without Manage Guild until staff roles are synced via `/staff syncpermissions`. Every `/rss` and `/setrss` reply is **ephemeral** (staff-only).

### Complete Setup Workflow

1. **Set the notification channel**:
   ```bash
   /setrss channel channel:#feed-alerts
   ```

2. **(Optional) Ping role**:
   ```bash
   /setrss role role:@NewsAlerts
   ```

3. **Subscribe to feeds** (validated immediately — see `/rss add` below):
   ```bash
   /rss add url:https://feeds.example.com/blog.xml
   /rss add url:https://example.com/news/feed name:Example News
   ```

4. **Verify configuration**:
   ```bash
   /rss list
   /setrss settings
   ```

5. **(Optional) Dry-run a notification** — posts the latest entry without touching poll state:
   ```bash
   /rss test
   ```

6. **(Optional) Force a poll now** — the live-verification aid (real poll, real state):
   ```bash
   /rss check
   ```

## Commands

### `/rss add`

Subscribe to an RSS/Atom feed. The URL is proven subscribable **now**: scheme + security validation, a guarded fetch, an rss-parser parse, and a **≥ 1 item** requirement — the resolved feed title is stored with the subscription.

```bash
/rss add url:https://feeds.example.com/blog.xml
/rss add url:https://example.com/news/feed name:Example News
```

| Option | Required | Description |
|--------|----------|-------------|
| `url` | Yes | Feed URL (http/https, must parse and have items) |
| `name` | No | Display label for this feed (used in the content line, footer, and autocomplete) |

**Reply** on success:

```
Subscribed to **Example News**.
**Feed:** <https://example.com/news/feed>
**Feed title:** Example News — Blog
**Notify channel:** <#feed-alerts>
```

(If the feed publishes no title, the label line reads `**Feed title:** _not provided by the feed_`.)

**Refusals name the cause** — `Could not add feed: <cause>` — with the cause always actionable. The shipped causes include:

- `no RSS notification channel is set — set one with /setrss channel first` (the standing config gate runs **before** anything else)
- `this community already has 20 RSS feeds and the cap is 20 (RSS_MAX_FEEDS_PER_COMMUNITY) — remove one with /rss remove first` (the cap check runs **before** the network)
- `invalid url`, `non-http(s) url (…)`, `url contains userinfo (possible host spoof)`, `ip-literal hostnames not allowed (…)`
- the SSRF guard's refusal naming the blocked host/address (see [Fetch security](#fetch-security-ssrf-posture))
- `could not fetch the feed: <reason>`, `could not parse the feed: <cause>`
- `the feed has no items yet — refusing to subscribe to an empty feed`
- `already subscribed to this feed — /rss remove it first to re-subscribe`

### `/rss remove`

Unsubscribe from a feed. The `feed:` option has **autocomplete** over the community's subscriptions (name = display name, feed title, or the URL; value = the stored URL) — pick from the picker instead of pasting.

```bash
/rss remove feed:https://example.com/news/feed
```

**Replies**: `Unsubscribed from **<label>**.` on success; `Could not remove feed: no subscription found for that feed — check /rss list` when nothing matches. Removing a feed also clears its seen-set rows.

### `/rss list`

```bash
/rss list
```

Shows the subscription count against the cap, the notification settings block, then every feed (`display_name`/label plus the resolved feed title in parentheses when they differ, and the URL). The empty-list reply is ``No feeds subscribed — add one with `/rss add`.`` Long lists are capped at the 2000-character message limit with an honest hidden-remaining count.

### `/rss test`

Fetch **now** and post the latest entry to the notify channel as a one-off diagnostic (mirrors `/testnotification`).

```bash
/rss test                                   # most recent subscription
/rss test feed:https://example.com/news/feed
```

- **Side-effect-free by design**: no seen-set claim, no watermark advance, no failure-counter bump — a test never silences the ticker's real announcement of that entry
- With no `feed:` given, the **most recent subscription** is used and the reply says so: `Posted a test notification to <#feed-alerts>.` + `**Feed:** <url> *(most recent subscription)*` + `**Entry:** <title>`
- Unknown URL: ``Could not test feed: `<url>` is no longer subscribed — check `/rss list`.``; no subscriptions at all: ``No RSS feeds subscribed — add one with `/rss add` first.``
- Failures reply `Test notification failed: <cause>` with the specific reason (fetch, parse, unannounceable entry, send)

### `/rss check`

Force a **real** poll now — the live-verification analogue of the tick. Skips only the interval/backoff clock gate; the config gate stays enforced. With no `feed:` option it polls **every** subscription of the community, per-feed, so one failure never hides the others' results.

```bash
/rss check                                  # every feed
/rss check feed:https://example.com/news/feed
```

**Reply shape** (per-feed failures are listed by name with their cause):

```
**Forced poll** — 3 feed(s)
**Polled:** 3
**Posted:** 1
**Not modified:** 2
```

## Configuration Commands

### `/setrss channel`

Set where new-entry notifications are posted (independent of the YouTube/Twitch channels):

```bash
/setrss channel channel:#feed-alerts
```

Replies `RSS notifications will be sent to <#feed-alerts>.`

### `/setrss role`

Set (or clear) the role mentioned on new-entry posts:

```bash
/setrss role role:@NewsAlerts
/setrss role
# omit role → stop mentioning a role
```

Replies `RSS notifications will mention <@NewsAlerts>.` / `RSS notifications will no longer mention a role.` Unset means **no mention at all** — there is no fallback to any other feature's role and never to `@everyone`.

### `/setrss interval`

Per-community polling interval, 1–60 minutes (Discord clamps the picker; the handler re-checks):

```bash
/setrss interval minutes:15
```

Replies `RSS polling interval set to **15** minute(s).`; an out-of-range value (reachable on non-picker surfaces) answers `Polling interval must be between 1 and 60 minutes.` Lower = faster alerts and more requests to the feed hosts.

### `/setrss settings`

```bash
/setrss settings
```

Shows the same status block `/rss list` heads with:

```
**Notify channel:** <#feed-alerts>     (or _Not configured_ — set one with `/setrss channel`)
**Notify role:** <@NewsAlerts>         (or *none*)
**Poll interval:** 15 minute(s)
**Feeds:** 3/20
```

## Notification format

One message per new entry — no batching. **Content line:**

```
<@NewsAlerts> **Example News** — new post
```

The `<@&role> ` prefix appears **only** when `/setrss role` is configured. The feed name resolves in precedence `display_name → feed title → URL hostname → "RSS feed"`.

**Embed:** the entry title (linked to the entry permalink, falling back to the feed home link), an HTML-stripped snippet of up to **300 characters**, a thumbnail when the feed carries one (`media:thumbnail`, image `media:content`, an image enclosure, or the iTunes art), footer = feed display name (` · {feed title}` when a distinct title exists), timestamp = the entry's real `pubDate` (omitted when the feed provides none — a timestamp would claim when the post happened, so it is never fabricated).

An entry with **neither a title nor a permalink** has no headline and is not announceable — it is counted as skipped, never posted as an empty shell.

**Feed content is attacker-controlled, so it is neutralized before it can render**: HTML stripped, entities decoded exactly once, Discord mention tokens (`<@…>`, `<@&…>`, `<#…>`) stripped even through single-encoding, `@everyone`/`@here` broken with a zero-width space, whitespace collapsed. A feed cannot make your bot ping anyone or fake formatting.

## Role mention semantics

Strict allow-list (#272), the same posture as event reminders and Twitch go-lives:

- Role configured → the send pins `allowedMentions` to exactly `{ roles: [that id] }`
- Not configured (or a stored value that isn't a bare snowflake) → `{ parse: [] }`: **nothing** in the message can mention anyone
- `@everyone` / `@here` parsing is never enabled on any send path — not on the tick, not on `/rss test`

## Poll behavior

- **Cadence**: a scheduler job named `rss` runs every **5 minutes**, aligned to wall-clock minutes. A tick is not a check: each feed row is polled only when **due**.
- **Due-gate**: a row is due when `last_checked + rss_polling_interval_minutes ≤ now` (default **15**). Never-checked rows (a fresh `/rss add`) are due immediately — the next tick picks them up, worst case ≈ interval + 5-minute cadence for the first scheduled check.
- **First-poll window** (the YouTube rule): on a feed's first poll only entries published within the **last hour** are announced; everything older is seeded into the seen-set **silently**, so subscribing to a busy feed never blasts its archive. A date-less entry counts as fresh and posts once — the seen-set bounds that to exactly once per entry.
- **Later polls**: an unseen entry is announced iff it was published **after** the row's `last_checked`; unseen-but-stale entries seed silently (a feed reorder can't resurface pruned archive entries).
- **Flood cap ≤5 per feed per tick**: the oldest five due entries are sent; the newer overflow is marked seen **without posting** (flood control wins over completeness — the Twitch media precedent) and logged once.
- **Conditional GET**: stored `etag`/`last_modified` ride out as `If-None-Match`/`If-Modified-Since`. A **304** is a free poll: `last_checked` advances and nothing else changes (validators untouched).
- **Backoff**: consecutive failures grow the retry window `interval × 2^failure_count`, capped at **6 hours**; any successful poll resets the counter, dropping the window back to the plain interval. Each failure logs exactly one line.
- **Dedup**: per-feed bounded **seen-set** of entry keys — `guid` → Atom `id` → permalink link (a `sha256:` digest past 2048 chars). Keys depend on nothing but those fields, so missing dates and reordering don't break dedup. The set is bounded at **~100 keys per feed**, pruned oldest-first after each poll.
- **Delivery**: each announced entry is **claimed in the seen-set before sending** (INSERT OR IGNORE) — a tick and a concurrent `/rss check` can never double-announce the same entry. A failed send logs the cause and **stops that feed's tick** (later entries stay unclaimed for a later pass); the claimed entry stays seen, so nothing ever double-posts. One v1 boundary to know: a failure stamps the poll clock, so entries that were visible-but-unclaimed around a failure window are seeded silently instead of announced late — bounded, logged, and deliberate (rss_feeds carries one clock column; splitting cadence from watermark is a migration).
- **Unconfigured communities cost nothing**: rows whose community has no notify channel are skipped with **zero fetches**, and the skip re-logs at most once per 6 hours per community.

## Fetch security (SSRF posture)

Feed URLs are staff-supplied but resolve wherever DNS says, so the guard treats them as hostile **every time**:

- **http(s) only**; URL userinfo and **all IP-literal hostnames** are refused outright
- Every hostname is resolved and **every returned address** is class-checked by the shared SSRF guard: loopback, RFC1918 (10/8, 172.16/12, 192.168/16), link-local **including the 169.254.169.254 cloud-metadata IP**, CGNAT 100.64/10, IANA/TEST-NET, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6 — private/metadata targets are refused **at add AND on every poll**
- **DNS-rebinding defense**: the addresses the check cleared are **pinned into the connection** (SNI/Host keep the original name), so the validated resolution and the connected socket are one and the same lookup
- **Redirects** are followed manually, capped at **3 hops**, and the full policy (scheme, userinfo, IP literals, address classes) **re-runs on every hop** — a redirect chain that lands on a private address is refused before that hop is ever connected to. Cross-host redirects are allowed (feeds legitimately move to CDNs); per-hop re-validation is the control
- **One transport**: `rss-parser` only ever sees text the guard already fetched (`parseString`) — its own requester is never wired, so no second, unguarded path exists
- Stored conditional-GET validators are printable-ASCII-checked before going back on the wire; a poisoned value is dropped (the poll degrades to an unconditional GET), never sent

## Limits

| Knob | Value | Controlled by |
|------|-------|---------------|
| Feeds per community | `RSS_MAX_FEEDS_PER_COMMUNITY`, default **20** | `/rss add` only (rows already above the cap keep polling) |
| Scheduler cadence | **5 minutes**, aligned | fixed job (`rss`) |
| Per-community interval | **15** min (1–60) | `/setrss interval` |
| First-poll backfill window | last **60 minutes** | fixed |
| Flood cap | **≤5 posts per feed per tick** (overflow seen, not posted) | fixed |
| Backoff | interval × 2^failures, capped at **6 h**, reset on success | automatic (`failure_count`) |
| Seen-set size | **~100 entry keys per feed**, pruned oldest-first | fixed |
| Response cap | **1 MiB** per fetch, enforced while streaming | fixed |
| Fetch timeout | **10 s** per attempt | fixed |
| Redirect hops | **≤3**, full re-validation per hop | fixed |
| User-Agent | `BoilerSnakeRSS/1.0 (+https://github.com/metalsp0rk/boiler-snake)`; `RSS_USER_AGENT` overrides, re-read per poll — no restart needed | env |

## State

- `rss_feeds` — one row per (community, feed URL): labels, resolved feed title/link, conditional-GET validators (`etag`, `last_modified`), the watermark pair (`last_entry_key`, `last_checked`), `failure_count` (backoff driver), `added_by` (migration `062`)
- `rss_seen` — the bounded per-feed seen-set `(community_id, feed_url, entry_key)`; the PRIMARY KEY *is* the set semantics, which makes the pre-send claim a one-row race every poller can trust (migration `063`)
- `guild_settings` — `rss_notification_channel_id`, `rss_notify_role_id`, `rss_polling_interval_minutes` (default 15) (migration `064`)

Both tables cascade with their community row (and removing a feed explicitly deletes its seen rows). Full DDL: [Database](database.md) — §8e/§8f for the tables, §4 for the settings trio.

## Fluxer parity

Delivery is dual-platform by construction: like every notification feature, announcements route per community through the shared outbound client (`clientForCommunity` → `sendChannel`) — on a Fluxer community the same plain-JSON payload lands as a normal embed message, and a community whose client isn't ready is logged and skipped rather than falling back to a raw Discord client (see the capability matrix in [Fluxer Instances](fluxer.md)). Slash commands are Discord-side; Fluxer uses the text-command prefix. No Fluxer-side formatting experiments are in scope for v1.

## Privacy note

Feeds are fetched **from your bot host**, over the open internet: each feed host sees your host's IP address and the configured User-Agent on every poll (every ~interval per feed, far less on `304` responses). What gets posted into the notify channel is the **feed's own content** — title, snippet, thumbnail URL, timestamp — neutralized for mentions but not rewritten. Subscribing to a feed also tells that feed host, via repeated polls, that your community reads it.

## Troubleshooting

### "The feed was refused"

`/rss add` names its own cause (see the list above). The usual suspects: a **private/metadata address** (the guard's refusal names the host/class — the feed must be on the public web), an **IP-literal URL** (`https://203.0.113.7/feed.xml` is refused even when public — use the hostname), a page that isn't a feed (`could not parse the feed: …`), or a **feed with zero items** (`the feed has no items yet — refusing to subscribe to an empty feed`).

### "No notifications are arriving"

1. `/setrss settings` — is the notify channel set? (Unset means zero fetches for the whole community — the tick logs the skip, it does not post.)
2. `/rss list` — is the feed subscribed? Is its community's client online? (Not-ready clients are logged and skipped.)
3. `/rss check` — forces a real poll now and answers **per feed**: `**Polled:** / **Posted:** / **Not modified:** / **Failures:**` with each failure named and its cause.
4. Timing: with the default 15-minute interval and 5-minute cadence, the first scheduled check of a fresh feed can legitimately take up to ~15–20 minutes.
5. A feed that has been failing repeatedly is on **backoff** (interval × 2^failures, up to 6 h) — `/rss check` bypasses the clock gate so you can probe it immediately.
6. A very busy feed's overflow past 5 posts per tick is intentionally **dropped** (seen without posting) — the log names it.

### What the `[rss]` log lines mean

| Line | Meaning |
|------|---------|
| `[rss] tick: 3/10 feed(s) polled — 2 posted, 5 not-modified, 0 failure(s), 1 skipped` | The once-per-tick aggregate; only logged when real work happened (all-not-due ticks stay quiet) |
| `[rss] feed poll failed (community=… url=…): <reason>` | One fetch failure; starts/extends that feed's backoff window |
| `[rss] feed parse failed (community=… url=…): <cause>` | Fetched fine, wasn't parseable XML/JSON a feed should be |
| `[rss] notification send failed (community=… url=… key=…): <cause> — stopping this feed's tick; …` | Platform send failed (deleted channel, perms, rate-limit); this feed's tick stops, the burned key is named |
| `[rss] community <id> has no rss_notification_channel_id — skipping <url> (re-logs at most every 6h)` | Standing config gap — set the channel with `/setrss channel` |
| `[rss] no ready client for community <id> — skipping <url>` | The community's platform client isn't connected yet; the row retries on later ticks |
| `[rss] <url> (community=…): 7 new entries, announced 5, skipped 2 (cap 5/poll)` | Flood-cap overflow: the newest entries past the cap were marked seen without posting |
| `[rss] tick sweep failed: <cause>` | The sweep itself died (logged — never an unhandled rejection) |

## Out of scope (v1)

Per-feed channel/role overrides (routing is per community), custom message templates, media handling beyond the simple thumbnail, Atom edge cases beyond `rss-parser` defaults, PubSubHubbub/WebSub push, feed **edit** detection (new entries only), and Fluxer-side formatting experiments (posts ride the shared outbound payload like everything else).
