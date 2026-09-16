# Web Admin Console

A Discord-login-gated admin console served by the bot over the same process and port as ticket transcripts — a second transport for the **same** authorization model, service layer, and audit trail as the slash commands. Every staff-tier slash action has a web twin; the panel can never bypass a gate the bot enforces.

Feature design and locked decisions live in the repo roadmap (`roadmap/web-admin.md` on `main`); this page is the operator/user guide.

## Enabling it

The console is **dark by default** — nothing listens unless you set `PUBLIC_HTTP_PORT` (see [Configuration](configuration.md)). Minimum setup:

1. Set `PUBLIC_HTTP_PORT` and `PUBLIC_BASE_URL` in `.env` (production must be **https** — the bot warns on non-localhost `http://`; put TLS/reverse proxy in front).
2. Set `SESSION_SECRET` (falls back to `CLIENT_SECRET` with a warning).
3. In the Discord Developer Portal, add the OAuth redirect `{PUBLIC_BASE_URL}/auth/login/callback`.
4. Restart the bot and open `{PUBLIC_BASE_URL}/` — you'll be redirected to **Log in with Discord**.

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
| **Staff** | `ManageGuild` **or** any `staff_roles` level ([Staff Roles](staff-roles.md)) | Dashboard, users, leaderboard, moderation (warns/notes), settings, staff list, integrations, voice (read), system pages; ticket actions staff-tier slash commands allow |
| **Senior** | senior `staff_roles` rows | Everything staff sees **plus** sensitive-ticket summarize and senior-tier actions (mirrors `/userinfo` Activity / ticket-overwrite seniority) |
| **Admin** | `ManageGuild` only | ManageGuild-tier mutations only: grant XP, staff-role mutations, command-visibility sync, honeypot exempt |

Two deliberate deltas from slash (asserted by tests, not accidents):

- Ticket claim/close/summarize writes are **senior-tier on web** (slash allows staff) — the console is a tighter surface.
- Sensitive-ticket summarize answers **404** to non-senior users rather than "forbidden" — the console never confirms a sensitive ticket exists to someone who can't see it.

Not in v1 by design: gork administration, music queue control, public (non-staff) pages.

## Security model

- **Login is mandatory** on every console and transcript route (`/t/…` included — no anonymous transcript reads, no feature flag). Only `/health` and the OAuth endpoints are public.
- **Cross-guild isolation:** a session valid for guild A gets the same generic **404** on every guild-B route as a stranger would — you can't probe whether a guild uses the bot.
- **Same services, same validation:** mutations call the existing service layer (XP, warnings, staff roles, tickets, …) — never a parallel implementation.
- **Queryable audit trail:** web and slash mutations both write `admin_audit` rows with an `origin` column (`web` / `slash` / `system`); channel embeds remain best-effort mirrors. The audit viewer is a console page.
- Unregistered `POST` paths are rejected before CSRF checks; mutations follow Post/Redirect/Get with whitelisted flash states.

## Pages

- **`/`** — guild picker (your staff guilds)
- **`/g/{guildId}`** — dashboard (bot status, XP/voice/ticket/gork summary cards)
- **`/g/{guildId}/users`, `/leaderboard`** — member search, XP detail, leaderboard (same data as `/xp` / `/leaderboard`)
- **`/g/{guildId}/moderation`** — warnings (`/warn` twin), staff notes (`/note` twin), ticket moderation
- **`/g/{guildId}/tickets`** — ticket list + claim/close/summarize; archived transcript viewing
- **`/g/{guildId}/settings`** — read view of every guild setting + staff-tier writes (command channels, level roles, integrations, cooldowns, decay, …)
- **`/g/{guildId}/staff`** — staff roles + command-visibility panel (incl. `/staff syncpermissions` trigger)
- **`/g/{guildId}/integrations`** — YouTube / Twitch / GitHub Releases watches
- **`/g/{guildId}/voice`**, **`/g/{guildId}/system`** — voice state, DB/queue/health status
- **`/g/{guildId}/audit`** — the `admin_audit` trail, filtered by guild

## Troubleshooting

- **`/` shows "Log in with Discord" forever / redirect URI mismatch** → the Portal redirect must match `{PUBLIC_BASE_URL}/auth/login/callback` exactly (scheme, host, port, path).
- **Cookie rejected / sessions drop instantly** → production served over plain http (Secure cookies need TLS) or `SESSION_SECRET` changed between restarts.
- **A revoked staff member still sees pages for a few seconds** → expected; bounded by `WEB_TIER_CACHE_TTL_MS` (≤ 60 s).
- **Everything 404s for your guild** → you don't hold `ManageGuild` or a `staff_roles` role there (404, not 403, by design — see security model).
