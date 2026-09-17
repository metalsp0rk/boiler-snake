# Web Admin Console

A Discord-login-gated admin console served by the bot over the same process and port as ticket transcripts — a second transport for the **same** authorization model, service layer, and audit trail as the slash commands. Every staff-tier slash action has a web twin; the panel can never bypass a gate the bot enforces.

Feature design and locked decisions live in the repo roadmap (`roadmap/web-admin.md` on `main`); this page is the operator/user guide.

## Enabling it

The console is **dark by default** — nothing listens unless you set `PUBLIC_HTTP_PORT` (see [Configuration](configuration.md)). Minimum setup:

1. Set `PUBLIC_HTTP_PORT` and `PUBLIC_BASE_URL` in `.env` (production must be **https** — the bot warns on non-localhost `http://`; put TLS/reverse proxy in front).
2. Set `SESSION_SECRET` (falls back to `CLIENT_SECRET` with a warning).
3. In the Discord Developer Portal, add the OAuth redirect `{PUBLIC_BASE_URL}/auth/login/callback`.
4. Restart the bot and open `{PUBLIC_BASE_URL}/` — you'll be redirected to **Log in with Discord**, then land on the **guild list**: pick a guild to open its console.

| Variable | Meaning |
|----------|---------|
| `SESSION_SECRET` | Signs session cookies (recommended) |
| `WEB_SESSION_TTL_HOURS` | Session lifetime (default `12`, hard cap 7 days) |
| `WEB_TIER_CACHE_TTL_MS` | Tier-cache TTL (default `60000`) — bounds how long a revoked role can linger to ≤ 60 s |

Sessions are stored in the database; the cookie carries only an opaque session id. Destroying a session (logout, expiry, DB delete) takes effect within the tier-cache window.

## Who sees what

Tiers mirror the bot's gates exactly — the same staff roles apply:

| Tier | Who (same as slash) | Console access |
|------|---------------------|----------------|
| **Staff** | `ManageGuild` **or** any `staff_roles` level ([Staff Roles](staff-roles.md)) | Dashboard, users, leaderboard, moderation (warns/notes pages + issue/void), settings reads + staff-tier writes (XP rate, decay, log channels, level roles), staff list, integrations (YouTube/Twitch/reaction-roles/event-reminders/honeypot), voice (read), ticket transcripts (`/t`) |
| **Senior** | senior `staff_roles` rows | Everything staff sees **plus** the ticket actions page (list, claim/close/summarize) and the user Activity tab (mirrors `/userinfo` Activity / ticket-overwrite seniority) |
| **Admin** | `ManageGuild` only | Everything above **plus** system + audit-trail pages and ManageGuild-tier mutations: grant XP, staff-role add/remove/setlevel, command-channel edits, command-visibility sync, honeypot exempt |

Two deliberate deltas from slash (asserted by tests, not accidents):

- Ticket claim/close/summarize writes are **senior-tier on web** (slash allows staff) — the console is a tighter surface.
- Sensitive-ticket summarize answers **404** to non-senior users rather than "forbidden" — the console never confirms a sensitive ticket exists to someone who can't see it.

Not in v1 by design: gork administration, music queue control, public (non-staff) pages — and anything merged after the console was designed (GitHub Releases watches, gork daily budget/memory knobs) has slash-only config for now.

## Security model

- **Login is mandatory** on every console and transcript route (`/t/…` included — no anonymous transcript reads, no feature flag). Only `/health` and the OAuth endpoints are public.
- **Cross-guild isolation:** a session valid for guild A gets the same generic **404** on every guild-B route as a stranger would — you can't probe whether a guild uses the bot.
- **Same services, same validation:** mutations call the existing service layer (XP, warnings, staff roles, tickets, …) — never a parallel implementation.
- **Queryable audit trail:** web and slash mutations both write `admin_audit` rows with an `origin` column (`web` / `slash` / `system`); channel embeds remain best-effort mirrors. The audit viewer is a console page.
- Unregistered `POST` paths are rejected before CSRF checks; mutations follow Post/Redirect/Get with whitelisted flash states.

## Pages

Every `/g/{guildId}` page carries a **sidebar** (Overview / Moderation / Configuration) to the
different areas — items you don't have tier for are hidden. Pages:
- **`/`** — guild list: your staff guilds with tier badges, links into each console (transcripts live at `/t`)
- **`/g/{guildId}`** — dashboard (bot status, XP/voice/ticket/gork summary cards)
- **`/g/{guildId}/users`, `/leaderboard`** — member search, XP detail, leaderboard (same data as `/xp` / `/leaderboard`)
- **`/g/{guildId}/moderation`** — warnings (`/warn` twin), staff notes (`/note` twin), ticket moderation
- **`/g/{guildId}/tickets`** — ticket actions page (**senior**): open-ticket list with claim/close/summarize (transcripts: `/t`)
- **`/g/{guildId}/t`** — the **archive for that guild** (staff), inside the console shell with the sidebar; search by ticket number or reason text, see creator/owner names.
- **`/t`** — the **cross-guild archive** (staff+): every content-archived transcript from your staffed guilds (canonical URL — links posted in tickets always point here). Filter by guild (`/t?guild=…`) and jump back into the console. Transcripts render the immutable record with the summary AI generated at close; every page links its raw archived document (`…/raw`)
- **`/g/{guildId}/settings`** — read view of every guild setting + staff-tier writes (command channels, level roles, integrations, cooldowns, decay, …)
- **`/g/{guildId}/staff`** — staff roles + command-visibility panel (incl. `/staff syncpermissions` trigger)
- **`/g/{guildId}/integrations`** — YouTube / Twitch watches, reaction roles, event reminders, honeypot
- **`/g/{guildId}/voice`** — live voice state (read-only; no queue control)
- **`/g/{guildId}/system`**, **`/g/{guildId}/audit`** — process/DB/queue health and the `admin_audit` trail, filtered by guild (both **admin-only**)

**Display names vs raw ids:** pages read names from the bot's in-memory member
cache only — a page never waits on Discord. Cache misses show the raw id (as
hover-text/label), and a quiet background fetcher resolves those misses right
after; reloading the page usually fills the names in. A member who **left the
guild** keeps their raw id permanently — that's honest, not a bug.

## Type-ahead & friendly identifiers

Staff fields that name a person or a role (grant XP, issue warning, add
note, staff-role management, the user search) accept **names, pasted
mentions, or raw IDs** — typing suggests real names from the bot's cache
(arrow keys + Enter to pick). The role list is always complete; member
names fill in as the bot's cache warms (browsing people pages and granting
XP speeds this up, and unknown IDs are looked up in the background
automatically). Name search finds *tracked* members; IDs always find exact
rows. Everything works with JavaScript disabled too — the suggestions are
an enhancement, and the server accepts names, `<@…>` / `<@&…>` mentions,
and plain IDs alike.

## People everywhere

Every user chip in the console (audit trail, warnings, notes, archives,
transcripts) **pops a profile card on hover** — avatar, name, ID and role
chips. Cards load lazily from the bot's local cache: the first hover of a
brand-new member may show just the ID while details fill themselves in a
moment later. The archive search bar understands people too: type a name,
pick it, and you get that person's tickets (as creator, handler, or
participant); role names are suggested as well.

## Troubleshooting

- **`/` shows "Log in with Discord" forever / redirect URI mismatch** → the Portal redirect must match `{PUBLIC_BASE_URL}/auth/login/callback` exactly (scheme, host, port, path).
- **Cookie rejected / sessions drop instantly** → production served over plain http (Secure cookies need TLS) or `SESSION_SECRET` changed between restarts.
- **A revoked staff member still sees pages for a few seconds** → expected; bounded by `WEB_TIER_CACHE_TTL_MS` (≤ 60 s).
- **Everything 404s for your guild** → you don't hold `ManageGuild` or a `staff_roles` role there (404, not 403, by design — see security model).
- **Lots of raw ids on a page** → the bot's member cache is cold (fresh restart, or you don't subscribe to the members intent). The background fetcher fills names as it goes; reload once or twice. Ids that never resolve are ex-members.
