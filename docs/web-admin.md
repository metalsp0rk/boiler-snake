# Web Admin Console

A staff-login-gated admin console (Discord **or** Fluxer sign-in) served by the bot over the same process and port as ticket transcripts — a second transport for the **same** authorization model, service layer, and audit trail as the slash commands. Every staff-tier slash action has a web twin; the panel can never bypass a gate the bot enforces.

Feature design and locked decisions live in the repo roadmap ([`roadmap/web-admin.md`](https://github.com/metalsp0rk/boiler-snake/blob/main/roadmap/web-admin.md) on `main`); this page is the operator/user guide.

## Enabling it

The console is **dark only** — one dark palette ships, and nothing listens unless you set `PUBLIC_HTTP_PORT`[^1] (see [Configuration](configuration.md)). Minimum setup:

1. Set `PUBLIC_HTTP_PORT` and `PUBLIC_BASE_URL` in `.env` (production must be **https** — the bot warns on non-localhost `http://`; put TLS/reverse proxy in front).
2. Set `SESSION_SECRET` (falls back to `CLIENT_SECRET` with a warning). **Fluxer-only installs** (no Discord `CLIENT_ID`/`CLIENT_SECRET`): set `SESSION_SECRET` **and** `OAUTH_STATE_SECRET` explicitly — both default to the Discord `CLIENT_SECRET`, which doesn't exist there, so a Fluxer login can't complete its OAuth state check (see [Fluxer](fluxer.md)).
3. In the Discord Developer Portal, add the OAuth redirect `{PUBLIC_BASE_URL}/auth/login/callback`.
4. Restart the bot and open `{PUBLIC_BASE_URL}/` — the public **sign-in landing** greets you with **Continue with Discord**; after sign-in you land on the **guild list**: pick a guild to open its console.

[^1]: The legacy alias `TICKET_HTTP_PORT` equally gates the HTTP server — either variable starts it (see the server log: "set PUBLIC_HTTP_PORT or TICKET_HTTP_PORT to enable"). `PUBLIC_HTTP_PORT` is the name to use.

| Variable | Meaning |
|----------|---------|
| `SESSION_SECRET` | Signs session cookies (recommended; required on Fluxer-only installs) |
| `OAUTH_STATE_SECRET` | Signs the OAuth login state (falls back to `CLIENT_SECRET`; required on Fluxer-only installs) |
| `WEB_SESSION_TTL_HOURS` | Session lifetime (default `12`, hard cap 7 days) |
| `WEB_TIER_CACHE_TTL_MS` | Tier-cache TTL (default `60000`) — the **fallback** bound for tier changes. Discord role changes are invalidated event-driven (see [Security model](#security-model)); this TTL is what actually bounds **Fluxer** staff-role changes (no member-update events exist there) |
| `WEB_GLOBAL_ADMIN_IDS` | Comma-separated user ids allowed to open the **system-wide** sessions page (`/g/{guildId}/system/sessions`). Unset ⇒ that page stays **closed** for everyone, guild admins included (fail-closed) |

Sessions are stored in the database; the cookie carries only an opaque session id. Destroying a session (logout, expiry, DB delete) takes effect within the tier-cache window.

## Sign-in providers

Two identity providers, one cookie each — a Fluxer sign-in **never touches** the Discord cookie:

- **Discord OAuth** — the classic path; the session lives in the `web_session` cookie.
- **Per-instance Fluxer OAuth** (`/auth/fluxer/<instance>/login` → callback) — each Fluxer instance the bot knows gets its own sign-in; the session lives in a separate `web_session_fx` cookie. Tier resolution is **community-matched**: your access is evaluated against communities on that instance, and a hostile/buggy instance handing out ids that collide with Discord snowflakes can only ever see its own platform's rows.

See [Fluxer](fluxer.md) for the platform-side setup.

## Who sees what

Tiers mirror the bot's gates exactly — the same staff roles apply:

| Tier | Who (same as slash) | Console access |
|------|---------------------|----------------|
| **Staff** | `ManageGuild` **or** any `staff_roles` level ([Staff Roles](staff-roles.md)) | Dashboard, users, leaderboard, moderation (warns/notes pages + issue/void), settings reads + staff-tier writes (XP rate, decay, log channels, level roles), staff list, integrations (YouTube/Twitch/reaction-roles/event-reminders/honeypot), **events** (calendar + all Community Events twin writes: `/event`, `/eventsignup`, `/eventconfig`, `/eventchannels`), voice (read), ticket transcripts (`/t`) |
| **Senior** | senior `staff_roles` rows | Everything staff sees **plus** the ticket actions page (list, claim/close/summarize) and the user Activity tab (mirrors `/userinfo` Activity / ticket-overwrite seniority) |
| **Admin** | `ManageGuild` only | Everything above **plus** system + audit-trail pages and ManageGuild-tier mutations: grant XP, staff-role add/remove/setlevel, command-channel edits, command-visibility sync, honeypot exempt |

Two deliberate deltas from slash (asserted by tests, not accidents):

- Ticket claim/close/summarize writes are **senior-tier on web** (slash allows staff) — the console is a tighter surface.
- Sensitive tickets answer a generic **404** to a summarize request at **every tier — senior and admin included**: the web NEVER renders or regenerates a sensitive-ticket summary (§8.4). The refusal happens before any message or AI read, so it is indistinguishable from an unknown or foreign ticket.

Not in v1 by design: gork administration, music queue control, and **anonymous** pages — every HTML surface requires sign-in. The only non-staff concession is `/t` degrading to **Your tickets** (exactly the archived transcripts your links open) for a signed-in user with no staff tier anywhere — and anything merged after the console was designed (GitHub Releases watches, gork daily budget/memory knobs) has slash-only config for now.

## Security model

- **Login is mandatory** on every console and transcript route (`/t/…` included — no anonymous transcript reads, no feature flag). The public surface is exactly: `/health`, `/static` assets, the OAuth endpoints (login/logout, both platforms), and the signature-authed **`POST /hooks/twitch`** — the Twitch **EventSub push receiver**: Twitch servers post callback/challenge traffic there, so it can never be login-gated; the HMAC-SHA256 signature check inside the handler *is* the authentication (see [Twitch notifications](twitch-notifications.md)).
- **Login surfaces are rate-limited.** Both `/auth/*` and `/oauth/*` carry a per-IP limiter (default **30 requests/minute**) **plus** a per-account login bucket (`auth_user`, default 10/minute) — scripted probing is throttled before Discord is ever contacted. Tunables: `WEB_RATE_LIMIT_WINDOW_MS` / `WEB_RATE_LIMIT_AUTH_MAX` / `WEB_RATE_LIMIT_AUTH_USER_MAX` (see [Configuration](configuration.md)).
- **Sign-in is opt-in, not a redirect trap.** Opening the site or any gated page while signed out lands on a public **sign-in landing** (`/auth/login`) that explains what the console is and what signing in grants (identity + guild list + member info, then scoped to guilds where the bot is present *and* you have staff access). Nothing contacts Discord until you press **Continue with Discord** (`/auth/login?continue=1`); denying on Discord just returns you here.
- **Logout ends at a signed-out landing.** Signing out destroys the session and shows the same landing with a "you're signed out" note — it no longer bounces straight back into the Discord consent screen.
- **Ticket links round-trip through login:** opening a ticket URL while signed out takes you through the sign-in landing to Discord and brings you back to **that exact ticket** (the return path travels inside the signed OAuth state and is whitelisted to ticket URLs — it can never redirect you elsewhere). Staff return links and the guild switcher are unchanged.
- **Cross-guild isolation:** a session valid for guild A gets the same generic **404** on every guild-B route as a stranger would — you can't probe whether a guild uses the bot.
- **Same services, same validation:** mutations call the existing service layer (XP, warnings, staff roles, tickets, …) — never a parallel implementation.
- **Queryable audit trail:** web and slash mutations both write `admin_audit` rows with an `origin` column (`web` / `slash` / `system`); channel embeds remain best-effort mirrors. The audit viewer is a console page.
- Unregistered `POST` paths are rejected before CSRF checks; mutations follow Post/Redirect/Get with whitelisted flash states.
- **Tier caches are invalidated by events where events exist:** a revoked/changed Discord role (`GuildMemberUpdate`) drops the member's cached role ids and cached guild-access lists, so the new tier applies on their **next request** — no TTL wait. Fluxer delivers no member-role updates, so Fluxer staff-role changes stay **TTL-bounded** by `WEB_TIER_CACHE_TTL_MS` (default 60 s).

## Pages

Every `/g/{guildId}` page carries a **sidebar** with the groups **Overview** (Dashboard,
Voice), **People** (Users, Leaderboard, Grant XP — admin), **Moderation** (Warnings,
Staff notes, Ticket actions — senior, Ticket archive), **Community** (Events),
**Configuration** (Settings, Staff roles, Command visibility, Integrations),
**Account** (Your sessions) and **Admin** (System, Web sessions, Audit trail) —
items you don't have tier for are hidden. The Events children (Archive, Presets, Series,
Scheduled posts) show only while the path is under `/events`. Settings and integrations
options are **in-page anchors** within those two pages, not separate routes. On a phone
the sidebar collapses behind the Menu button (719px and below). From 720px the rail is
13rem wide, and from 1100px it is 15.5rem. The signed-in chrome is graphite with teal
for the current page and for actions, and steel for secondary information. Dashboard
counts are stat cards. The messages chart is teal and the XP chart is steel. Other
pages share this chrome; their page contents keep the previous styles until those
surfaces move over. The path id is the bot's internal
**community id** (a small integer — Discord servers and Fluxer communities share the namespace),
not a Discord snowflake; bookmarks from before the communities migration (`/g/<snowflake>`)
return 404. Pages:
- **`/`** — guild list: your staff guilds with tier badges, links into each console (transcripts live at `/t`)
- **`/g/{guildId}`** — dashboard (at-a-glance stat row, bot status, XP/voice/ticket/gork summary cards, **activity & XP charts**, background jobs)
- **`/g/{guildId}/users`, `/leaderboard`** — member search, XP detail, leaderboard (same data as `/xp` / `/leaderboard`)
- **`/g/{guildId}/warnings`** — warnings list + issue/void (the `/warn` twin, staff tier)
- **`/g/{guildId}/notes`** — staff notes list + add (the `/note` twin, staff tier)
- **`/g/{guildId}/tickets`** — ticket actions page (**senior**): open-ticket list with claim/close/summarize (transcripts: `/t`)
- **`/g/{guildId}/t`** — the **archive for that guild** (staff), inside the console shell with the sidebar; search by ticket number or reason text, see creator/owner names.
- **`/t`** — the **cross-guild archive** (staff+): every content-archived transcript from your staffed guilds (canonical URL — links posted in tickets always point here). Filter by guild (`/t?guild=…`) and jump back into the console. Transcripts render the immutable record with the summary AI generated at close; every page links its raw archived document (`…/raw`)
- **`/t` for non-staff** — if you hold no staff tier anywhere, `/t` becomes **Your tickets**: exactly the archived transcripts your links open (as creator, handler, or participant), never anyone else's and never staff rows. `?guild=` narrows that list, never widens it.
- **`/g/{guildId}/settings`** — read view of every guild setting + staff-tier writes (command channels, level roles, integrations, cooldowns, decay, …)
- **`/g/{guildId}/staff`** — staff roles (list + junior/senior set, level→role mappings) **and** the admin trigger for the command-visibility sync (the web twin of `/staff syncpermissions`)
- **`/g/{guildId}/commands`** — **Command visibility**: read-only OAuth authorization + last permission-sync state for the staff-tier slash commands (staff tier; the admin trigger lives on the staff page)
- **`/g/{guildId}/xp/grant`** — grant XP (the `/grantxp` twin, **admin**)
- **`/g/{guildId}/integrations`** — YouTube / Twitch watches, reaction roles, event reminders, honeypot
- **`/g/{guildId}/events`** — the **Community Events** calendar (staff): month grid of posted events + drafts/scheduled queues (phones get an agenda list of the same data), a create form, and per-event detail with the full action set grouped Post / Signups / Edit / Danger (publish / edit / duplicate / options / signups / reminders / archive / delete + Retry-sync). Siblings: `/events/archive` (kept history), `/events/scheduled` (due-queue + failures), `/events/series` (skip/stop), `/events/presets` (signup presets CRUD — **removing a preset requires typing `DELETE`**, the same typed confirm as permanent event delete). Every mutation is audited (`events.*`, origin `web`); event visibility follows channel visibility where the bot can see it (fail-open otherwise). See [Community Events](community-events.md).
- **`/g/{guildId}/voice`** — live voice state (read-only; no queue control)
- **`/g/{guildId}/sessions`** — **Your sessions**: every live sign-in on *your own* account **on the current session's platform** (Discord sign-ins list Discord sessions; a Fluxer instance's sessions are visible only from that instance's sign-in — cross-platform id collisions can't leak), with browser, sign-in/last-seen/expiry times and a **Revoke session** button per row (**Sign out this browser** on the row marked *current* — revoking it is a clean logout, and it's still one click). You can never see or touch anyone else's sessions from here.
- **`/g/{guildId}/system`**, **`/g/{guildId}/audit`** — process/DB/queue health and the `admin_audit` trail, filtered by guild (both **admin-only**)
- **`/g/{guildId}/system/sessions`** — **admin + global allow-list**: every live web session in the console (sessions are account-level, not per-guild — the page says so plainly), with revoke for any of them — kill a stale or stolen sign-in without restarting the bot. Because the surface has no guild axis, a **second, global key** guards it: your user id must be listed in **`WEB_GLOBAL_ADMIN_IDS`**. Unset (or missing you) ⇒ fail-closed — you hold admin yet get an actionable refusal naming the knob; your own sessions stay on the self-service Sessions page. Revokes are audited (`sessions.revoke`); session ids are never shown.

**Dashboard charts** render client-side (vendored Chart.js — pinned file, no CDN) in teal (messages) and steel (XP) from small JSON endpoints at `/g/{guildId}/api/dashboard/…` (staff tier, unauthenticated callers get the same generic 404 as the pages). **The signed-in console requires JavaScript**: the charts, name/channel typeahead, the archive find box, and the phone sidebar collapse are how the console behaves — they are not optional extras with a no-JS equivalent. The signed-out **sign-in landing stays a static page** (no scripts at all). A single chart failure still says so in its corner instead of breaking the page, and the same numbers always live in the page's tables. These endpoints are the first slice of the console's long-term API surface.

**Background jobs** (dashboard) reflects real ticker state: every scheduler job reports honest `ok` / `stale` / `unknown` from its last completed tick — a stalled loop goes `stale`, cron-scheduled jobs never fake a status. The rows follow the scheduler **live**: loops owned by subsystems that start after the console (bridge, linking) get their own rows without a restart, and a stopped loop shows as `unknown` ("not wired") instead of vanishing. The bridge contributes one extra aggregate row, **`bridge-relay-backlog`** (relay queue/park depth — see [bridge.md](bridge.md#troubleshooting)).

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
rows. **Channel id fields** (settings log/post channels, event channels)
get the same treatment: staff-only, cache-only name suggestions — type a
channel name and pick it, or keep pasting raw ids, which always works.
Typeahead rides the console's JavaScript; the server accepts names,
`<@…>` / `<@&…>` mentions, and plain IDs regardless.

## People everywhere

Every user chip in the console (audit trail, warnings, notes, archives,
transcripts) **pops a profile card on hover** — avatar, name, ID and role
chips. Cards load lazily from the bot's local cache: the first hover of a
brand-new member may show just the ID while details fill themselves in a
moment later. The archive search bar understands people too: type a name,
pick it, and you get that person's tickets (as creator, handler, or
participant); role names are suggested as well.

## Ticket summaries

Archived tickets carry the summary generated at close time (AI if the
bot has a model configured, otherwise an automatic recap — each labeled).
The full text shows on the transcript page under **Summary**; the archive
lists a one-line recap with its provenance badge under each ticket's
reason. Sensitive tickets never get a web summary at any tier — summarize
requests for them 404 (see the deltas above).

## Troubleshooting

- **`/` keeps bouncing you back to the sign-in landing / redirect URI mismatch** → the Portal redirect must match `{PUBLIC_BASE_URL}/auth/login/callback` exactly (scheme, host, port, path).
- **Cookie rejected / sessions drop instantly** → production served over plain http (Secure cookies need TLS) or `SESSION_SECRET` changed between restarts.
- **A revoked staff member still sees pages** → on **Discord** this is momentary at most: role changes invalidate the tier caches on the member's next request (`GuildMemberUpdate`-driven). On **Fluxer** there are no member-role events, so revocations stay bounded by `WEB_TIER_CACHE_TTL_MS` (≤ 60 s by default) — expected.
- **`/g/{guildId}/system/sessions` refuses you with "global operators"** → the page is system-wide and needs your user id in `WEB_GLOBAL_ADMIN_IDS` (fail-closed by design); guild admin alone no longer unlocks it.
- **Everything 404s for your guild** → you don't hold `ManageGuild` or a `staff_roles` role there (404, not 403, by design — see security model).
- **Lots of raw ids on a page** → the bot's member cache is cold (fresh restart, or you don't subscribe to the members intent). The background fetcher fills names as it goes; reload once or twice. Ids that never resolve are ex-members.
