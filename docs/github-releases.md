# GitHub Release Notifications

Track one or more GitHub repositories per server and post release notes to a configured channel whenever a new release is cut.

## Overview

- **Multiple repositories per server**: each watch has its own notification channel and optional ping role
- **Hourly polling**: the bot probes the GitHub API on an hour-aligned cadence
- **One message per release**: if several releases land between two polls, each is announced (oldest first) — nothing is skipped or merged
- **Baseline on add**: the first check of a new watch posts the current latest release once; later polls only announce newer releases
- **Pre-releases included** (marked as such); drafts are never posted
- **Long changelogs are truncated** with a "Read the full release notes on GitHub" link
- **Optional per-repo token**: for private repositories or to raise the API rate limit (unauthenticated lookups share 60 requests/hour per IP) — entered **privately** via `/github token`

## Commands (staff)

All commands require **Manage Guild** (or a configured staff role).

### Track a repository

```bash
/github watch repo:metalsp0rk/boiler-snake channel:#releases
/github watch repo:https://github.com/owner/repo channel:#releases
/github token repo:owner/private-repo
```

Accepts `owner/name`, a GitHub URL, or an SSH remote (`git@github.com:owner/repo.git`). Re-running `watch` updates the channel without resetting release state.

### Set a repository token

`/github token repo:owner/name` opens a **private prompt** (a Discord modal): what you type is visible **only to you**, never in the channel. The token is validated against GitHub before it is stored, and the watch is created if it doesn't exist yet — this is also how you start tracking a **private** repository. Submitting the prompt empty clears the stored token.

### Configure a watch

```bash
/github channel repo:owner/repo channel:#releases   # where release notes post
/github role repo:owner/repo role:@Announcements    # ping on release (omit role to clear)
/github list                                         # all watches + configuration
/github remove repo:owner/repo                       # stop tracking
/github check [repo:owner/repo]                      # probe now instead of waiting for the hourly tick
```

## How notifications look

Each release produces a message with an embed containing:

- repository (links to the repo) and release title (📦 stable / 🧪 pre-release)
- tag, author, publish date
- the release body (truncated at ~3,800 characters with a link to the full notes on GitHub)

If a ping role is configured, the message mentions that role only — never `@everyone`.

## Reliability behavior

- **Pointer per watch**: the bot stores the newest announced release id. Releases are announced in publish order; if a message can't be delivered (deleted channel, missing permissions), the pointer does **not** advance and the bot retries on the next hourly tick.
- **API failures never lose releases**: rate limits, outages, or a rejected token are logged and retried next hour — the pointer only moves after a successful lookup.
- **`/github check`** reports specific problems per repository (e.g. missing channel, rate limit, invalid token) instead of failing silently.

## Tokens & privacy

- **Token entry is modal-only.** Discord renders slash-command option values publicly in the channel, so the old `token:` option on `/github watch` leaked entered PATs to everyone reading (audit INT-9). `/github token` uses a modal instead — submissions are visible only to the submitter.
- A token entered via `/github token` is validated against GitHub first (a rejected token is refused with the specific cause, nothing stored), then written to the bot's local SQLite database — **encrypted at rest** (AES-256-GCM envelope, `TOKEN_ENCRYPTION_KEY`; see [Configuration](configuration.md#third-party-token-encryption-optional)) — and used **only** as the `Authorization` header for GitHub API calls to that repository. It is never displayed by `/github list` (which only shows "token set") and never logged or echoed.
- Tokens are optional: public repositories work unauthenticated, subject to GitHub's 60 req/hour per-IP rate limit. A read-only fine-grained token scoped to the single target repository is the safest choice; private repos need a token with `repo` read access.
- `/github token` rejects up-front (before the prompt even opens) when `TOKEN_ENCRYPTION_KEY` is unset — tokens are never stored in plaintext. Watches without a token work regardless. On platforms without modal support the command says so instead of faking the prompt; token configuration is currently Discord-only.

## Requirements

- No environment variables required for unauthenticated watching — the GitHub REST API is public. Storing a per-repo token requires `TOKEN_ENCRYPTION_KEY` (see [Configuration](configuration.md#third-party-token-encryption-optional)).
- The bot needs **View Channel** + **Send Messages** in the target channel.
