# User Activity Summary

Staff tooling to see **where a member posts most**, by **channel** and **Discord category**, with absolute counts, share of total, and a simple **posts/week since join** rate.

This is **independent of XP**. Cooldowns do not apply; every human guild message can be counted.

## Access

| Surface | Who |
|---------|-----|
| `/userinfo` Overview / Notes / Warnings | Any **[staff](staff-roles.md)** (`Manage Server` or any `staff_roles` level) |
| `/userinfo` → **Activity** tab | **Senior** staff only (`Manage Server` or a **senior** staff role) — see [staff roles](staff-roles.md) |
| `/activityconfig` | **Manage Server** only |

Junior staff see the Activity button but get a clear denial if they click it.

## Viewing activity

1. Run `/userinfo user:@member`
2. Click **Activity** (senior staff)
3. Use controls:
   - **All / 7d / 30d** — time window for the ranking list
   - **Channels** — top **15** channels (default)
   - **Categories** — roll-up by current Discord category (secondary page)
   - **Backfill history** — optional best-effort history scan for that user

Each ranked line shows:

```
#channel · count · % of window total · X.X/wk
```

**`X.X/wk`** is the **lifetime** rate for that channel (or category):

```
weekly_rate = lifetime_posts / max(1, weeks_since_guild_join)
```

The selected window only filters **which posts appear in the ranking counts**; the weekly rate always uses lifetime totals ÷ weeks since join.

Channels with **zero** counted posts are omitted. Deleted channels show as `` #channel_id `` when the name is unknown.

### Threads

Thread messages count against the **thread channel id** (threads appear as their own rows). Category roll-up uses the parent text channel’s category when known.

### Categories

Category rankings use the **current** parent category of each channel (or **Uncategorized** if missing/deleted). Moving a channel later changes future roll-ups, not historical channel rows.

## What is counted

| Included | Excluded |
|----------|----------|
| Non-bot human messages in the guild | Bots |
| Text, announcement, forum posts (as Discord delivers MessageCreate) | System messages |
| Threads (as their own channel) | Honeypot channels (always) |
| | Channels/categories on the **ignore list** |
| | Messages older than the live watermark unless backfilled |

Live tracking starts when the guild first records activity (watermark stored in `guild_activity_settings.collect_from_ms`). **All-time is not “since the user joined Discord”** unless you run backfill.

## Ignore list

```bash
/activityconfig ignore add kind:channel target:#spam
/activityconfig ignore add kind:category target:Category
/activityconfig ignore remove target:#spam
/activityconfig ignore list
/activityconfig status
```

- **channel** — that channel is never counted or shown
- **category** — channels currently under that category are skipped at ingest and filtered at display

Honeypot channels are always skipped even without an ignore entry.

## Backfill

Discord bots cannot “search the guild for one user’s messages.” History must be read **per channel**. Prefer a **single pass that attributes every human author** over running one user at a time.

### Guild-wide (recommended): all users

```bash
/activityconfig backfill all
/activityconfig backfill all max_pages:100
```

**Manage Server** only.

| Option | Default | Range | Meaning |
|--------|---------|-------|---------|
| `max_pages` | **50** | 1–500 | Max history pages **per channel** (100 messages/page → default ≈ **5,000** msgs/channel; max ≈ **50,000**) |

- Walks each eligible text/announcement channel **once**
- Counts **all** non-bot messages older than the live watermark into daily counters
- Rate limit: ~1 page / 1.1s (independent of `max_pages`)
- Progress: `/activityconfig status` (`guild_backfill_*` fields)
- One backfill job per guild at a time (blocks concurrent per-user jobs)
- Guild channel cursors: **complete** channels are skipped on re-run; **partial** channels resume from the cursor — raise `max_pages` and re-run to dig deeper

### Cancel

```bash
/activityconfig backfill cancel
```

Stops the **in-process** guild-wide or per-user backfill for this server (cooperative: finishes the current page, usually within ~1–2s). Final status becomes **`cancelled`**. Cursors and counts already written are kept — re-run to continue.

If the bot restarted while a job was marked `running`, cancel clears that **stale** status so a new backfill can start.

### Per-user: Activity button

Senior staff can click **Backfill history** on `/userinfo` → Activity for **one user**.

- Same channel list and rate limits
- Only increments counters for that user
- Skips channels already **guild-complete**
- Prefer **backfill all** after deploy if you want full historical depth for everyone

Discord history is incomplete for very old channels; treat backfill as **best-effort**.

## Data storage

Daily aggregates (not per-message logs):

| Table | Role |
|-------|------|
| `user_channel_message_daily` | `(guild, user, channel, UTC day) → count` |
| `activity_ignore` | Ignore channel/category ids |
| `guild_activity_settings` | Live collect watermark |
| `user_activity_meta` | Per-user backfill status |
| `user_channel_backfill_cursor` | Per-channel scan progress |

See [Database Schema](database.md).

## Related

- [Staff userinfo](staff-notes.md) (notes) and [Warnings](warnings.md)
- [Staff roles](staff-roles.md) — junior vs senior; Activity requires senior
- [Honeypot](honeypot.md) — always excluded from activity
