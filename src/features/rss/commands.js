/**
 * `/rss` + `/setrss` slash surface (issue #305, subtask 07) — the command
 * arm of the RSS feature. SHAPE mirrors src/features/youtube/index.js
 * (the merged command/registration precedent): SlashCommandBuilders with the
 * ManageGuild defaultMemberPermissions posture, context-arm handlers gated by
 * requireStaffFromContext, a community-scoped autocomplete, and the
 * { commands, handlers, handlerApi, autocomplete } export contract
 * src/features/load.js consumes — subtask 08's src/features/rss/index.js
 * spreads these keys into the registered feature module.
 * src/commands/definitions.js is the deprecated collection stub (#461): the
 * registry collects builders from feature modules, so NOTHING is added there.
 *
 * Error law (AGENTS.md): the service returns { ok:false, error } with the
 * specific cause; every reply embeds it ("Could not add feed: <cause>"), the
 * handlers add the ids and log refused operations, and all multi-feed work
 * reports partial results. Detached audit posts carry their own .catch.
 * Reply copy follows the **Label:** value convention (#471 H2-13).
 *
 * DI seam: `featureCtx.rss` may carry
 * `{ db, env, now, fetchImpl, resolveHost, parser }` — the exact seams the
 * subscriptions service and the poller already expose. Production never sets
 * it (the router passes no rss key); unit tests hand in fakes so no command
 * path ever needs a network or a wall clock.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
// Module facade (youtube precedent). loadDb() test harnesses rebind it via
// the require-cache reset contract; per-call db overrides ride the
// featureCtx.rss DI seam below.
const facadeDb = require("../../db");
const { getGuildSettings, updateGuildSettings } = facadeDb;
const { requireStaffFromContext } = require("../../core/permissions");
const { discordCommunityId } = require("../../platform/community");
const { joinCapped } = require("../../core/text");
const { recordSlashAudit } = require("../../core/auditTrail");
const { logConfigChange } = require("../logs/auditLog");
const { resolveFeedDisplayName } = require("./format");
const subscriptions = require("./subscriptions");
const {
  DEFAULT_RSS_POLL_INTERVAL_MINUTES,
  NO_CHANNEL_ERROR,
} = subscriptions;
const staffPerms = PermissionFlagsBits.ManageGuild;

/** Autocomplete choice names are capped by Discord at 100 chars. */
const AUTOCOMPLETE_NAME_MAX = 100;

const commands = [
  new SlashCommandBuilder()
    .setName("rss")
    .setDescription("Manage RSS feed notifications (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) =>
      sc
        .setName("add")
        .setDescription("Subscribe to an RSS/Atom feed (validated now).")
        .addStringOption((opt) =>
          opt
            .setName("url")
            .setDescription("Feed URL (http/https, must parse and have items)")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Display label for this feed (optional)")
            .setRequired(false),
        ),
    )
    .addSubcommand((sc) => {
      const sub = sc
        .setName("remove")
        .setDescription("Unsubscribe from a feed.");
      sub.addStringOption((opt) =>
        opt
          .setName("feed")
          .setDescription("Feed URL to unsubscribe from")
          .setRequired(true)
          .setAutocomplete(true),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc
        .setName("list")
        .setDescription("List feeds plus notify channel/role/interval status."),
    )
    .addSubcommand((sc) => {
      const sub = sc
        .setName("test")
        .setDescription(
          "Fetch now and post the latest entry to the notify channel.",
        );
      sub.addStringOption((opt) =>
        opt
          .setName("feed")
          .setDescription("Feed URL to test (default: most recent subscription)")
          .setRequired(false)
          .setAutocomplete(true),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("check")
        .setDescription("Force a poll now (live-verification aid).");
      sub.addStringOption((opt) =>
        opt
          .setName("feed")
          .setDescription("Feed URL to poll now (default: every subscription)")
          .setRequired(false)
          .setAutocomplete(true),
      );
      return sub;
    }),

  new SlashCommandBuilder()
    .setName("setrss")
    .setDescription("Configure RSS notification settings (staff).")
    .setDefaultMemberPermissions(staffPerms)
    .addSubcommand((sc) => {
      const sub = sc
        .setName("channel")
        .setDescription("Set channel for RSS feed notifications.");
      sub.addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Channel to send new-entry notifications to")
          .setRequired(true),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("role")
        .setDescription("Set role to mention on new-entry posts.");
      sub.addRoleOption((opt) =>
        opt
          .setName("role")
          .setDescription(
            "Role to mention (leave empty to stop mentioning a role)",
          )
          .setRequired(false),
      );
      return sub;
    })
    .addSubcommand((sc) => {
      const sub = sc
        .setName("interval")
        .setDescription("Set feed polling interval.");
      sub.addIntegerOption((opt) =>
        opt
          .setName("minutes")
          .setDescription("Polling interval in minutes (1-60)")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(60),
      );
      return sub;
    })
    .addSubcommand((sc) =>
      sc
        .setName("settings")
        .setDescription("Show notify channel, role, interval, subscriptions."),
    ),
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * featureCtx.rss DI seam (unit tests hand in { db, env, now, fetchImpl,
 * resolveHost, parser }; production ships no rss key → empty deps → every
 * service call falls back to its defaults).
 */
function rssDeps(featureCtx) {
  const di = featureCtx && featureCtx.rss;
  return di && typeof di === "object" ? di : {};
}

/** Deps-aware db accessor: the injected test facade or the module facade. */
function depsDb(di) {
  return di.db ?? facadeDb;
}

/** Effective interval for display: the stored value or the schema default.
 * (rss_polling_interval_minutes is NOT NULL with schema DEFAULT 15; the
 * fallback also covers a null a raw write could have left behind — it must
 * never print as "undefined minute(s)".) */
function effectiveIntervalMinutes(settings) {
  const n = Number(settings?.rss_polling_interval_minutes);
  return Number.isFinite(n) && n >= 1 && n <= 60
    ? n
    : DEFAULT_RSS_POLL_INTERVAL_MINUTES;
}

/** The status block /rss list and /setrss settings share (**Label:** value). */
function renderSettingsBlock(settings, feedCount, cap) {
  const channel = settings?.rss_notification_channel_id
    ? `<#${settings.rss_notification_channel_id}>`
    : "_Not configured_ — set one with `/setrss channel`";
  const role = settings?.rss_notify_role_id
    ? `<@&${settings.rss_notify_role_id}>`
    : "*none*";
  return [
    `**Notify channel:** ${channel}`,
    `**Notify role:** ${role}`,
    `**Poll interval:** ${effectiveIntervalMinutes(settings)} minute(s)`,
    `**Feeds:** ${feedCount}/${cap}`,
  ].join("\n");
}

/**
 * Resolve the `[feed]` option into stored rows: one named feed (unknown URL
 * → honest error reply, handled by the caller) or the whole community list.
 * @returns {{ rows: object[], missing: string|null, empty: boolean }}
 */
function resolveFeedRows(db, communityId, feedOpt) {
  const wanted = String(feedOpt ?? "").trim();
  if (wanted) {
    const row = db.getRssFeed(communityId, wanted);
    return { rows: row ? [row] : [], missing: row ? null : wanted, empty: false };
  }
  const rows = db.listRssFeedsForCommunity(communityId);
  return { rows, missing: null, empty: rows.length === 0 };
}

const NO_FEEDS_HINT =
  "No RSS feeds subscribed — add one with `/rss add` first.";

// ---------------------------------------------------------------------------
// /rss
// ---------------------------------------------------------------------------

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleRss(commandCtx, featureCtx) {
  if (!(await requireStaffFromContext(commandCtx))) return;

  const communityId = commandCtx.communityId;
  const guildId = commandCtx.externalGuildId;
  const di = rssDeps(featureCtx);
  const db = depsDb(di);
  const sub = commandCtx.subcommand;

  if (sub === "add") {
    const rawUrl = commandCtx.options.getString("url", true);
    const displayName = commandCtx.options.getString("name");

    const res = await subscriptions.addFeed({
      communityId,
      rawUrl,
      displayName,
      addedBy: commandCtx.userId,
      db,
      env: di.env,
      fetchImpl: di.fetchImpl,
      resolveHost: di.resolveHost,
      parser: di.parser,
    });
    if (!res.ok) {
      // Rule 2+3: logged with ids, and the reply carries the CAUSE.
      console.error(
        `[rss] /rss add refused (community=${communityId} url=${rawUrl}): ${res.error}`,
      );
      await commandCtx.reply({
        content: `Could not add feed: ${res.error}`,
        sensitive: true,
      });
      return;
    }

    const feed = res.feed;
    const label = resolveFeedDisplayName(feed);
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "rss.feed_add",
      targetType: "rss_feed",
      targetId: feed.url,
      details: {
        url: feed.url,
        display_name: feed.display_name,
        feed_title: feed.feed_title,
      },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "RSS feed subscribed",
      command: "/rss add",
      actor: commandCtx.user,
      changes: [`Feed: **${label}**`, `URL: <${feed.url}>`],
    }).catch(() => {});

    const lines = [
      `Subscribed to **${label}**.`,
      `**Feed:** <${feed.url}>`,
      `**Feed title:** ${feed.feed_title || "_not provided by the feed_"}`,
      `**Notify channel:** <#${res.settings.rss_notification_channel_id}>`,
    ];
    await commandCtx.reply({ content: lines.join("\n"), sensitive: true });
    return;
  }

  if (sub === "remove") {
    const url = commandCtx.options.getString("feed", true);
    const res = await subscriptions.removeFeed({ communityId, url, db });
    if (!res.ok) {
      console.error(
        `[rss] /rss remove refused (community=${communityId} url=${url}): ${res.error}`,
      );
      await commandCtx.reply({
        content: `Could not remove feed: ${res.error}`,
        sensitive: true,
      });
      return;
    }

    const label = resolveFeedDisplayName(res.feed);
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "rss.feed_remove",
      targetType: "rss_feed",
      targetId: res.feed.url,
      details: { url: res.feed.url, display_name: res.feed.display_name },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "RSS feed unsubscribed",
      command: "/rss remove",
      actor: commandCtx.user,
      changes: [`Feed: **${label}**`, `URL: <${res.feed.url}>`],
    }).catch(() => {});
    await commandCtx.reply({
      content: `Unsubscribed from **${label}**.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "list") {
    const res = await subscriptions.listFeeds({ communityId, db, env: di.env });
    if (!res.ok) {
      console.error(
        `[rss] /rss list failed (community=${communityId}): ${res.error}`,
      );
      await commandCtx.reply({
        content: `Could not list feeds: ${res.error}`,
        sensitive: true,
      });
      return;
    }

    const header =
      `**RSS subscriptions** (${res.feeds.length}/${res.cap})\n` +
      renderSettingsBlock(res.settings, res.feeds.length, res.cap) +
      "\n\n";
    if (!res.feeds.length) {
      await commandCtx.reply({
        content: `${header}No feeds subscribed — add one with \`/rss add\`.`,
        sensitive: true,
      });
      return;
    }

    // 2000-char message cap with an honest hidden count (#446 shape).
    const lines = res.feeds.map((f) => {
      const label = resolveFeedDisplayName(f);
      const suffix = f.display_name && f.feed_title && f.display_name !== f.feed_title
        ? ` (*${f.feed_title}*)`
        : "";
      return `• **${label}**${suffix}\n  URL: <${f.url}>`;
    });
    await commandCtx.reply({
      content: header + joinCapped(lines, 2000 - header.length, "\n"),
      sensitive: true,
    });
    return;
  }

  if (sub === "test") {
    const feedOpt = commandCtx.options.getString("feed");
    const { rows, missing, empty } = resolveFeedRows(db, communityId, feedOpt);
    if (missing) {
      await commandCtx.reply({
        content:
          `Could not test feed: \`${missing}\` is no longer subscribed — ` +
          `check \`/rss list\`.`,
        sensitive: true,
      });
      return;
    }
    if (empty) {
      await commandCtx.reply({ content: NO_FEEDS_HINT, sensitive: true });
      return;
    }
    // No feed: named → the most recent subscription (list is created_at ASC).
    const feed = rows[rows.length - 1];
    const usedNote = feedOpt ? "" : " *(most recent subscription)*";

    const res = await subscriptions.testPostLatest({
      communityId,
      feed,
      outbound: commandCtx.outbound,
      db,
      parser: di.parser,
      fetchImpl: di.fetchImpl,
      resolveHost: di.resolveHost,
      now: di.now,
    });
    if (!res.ok) {
      console.error(
        `[rss] /rss test failed (community=${communityId} url=${feed.url}): ${res.error}`,
      );
      await commandCtx.reply({
        content: `Test notification failed: ${res.error}`,
        sensitive: true,
      });
      return;
    }
    await commandCtx.reply({
      content:
        `Posted a test notification to <#${res.channelId}>.\n` +
        `**Feed:** <${feed.url}>${usedNote}\n` +
        `**Entry:** ${res.entryLabel}`,
      sensitive: true,
    });
    return;
  }

  if (sub === "check") {
    const feedOpt = commandCtx.options.getString("feed");
    const { rows, missing, empty } = resolveFeedRows(db, communityId, feedOpt);
    if (missing) {
      await commandCtx.reply({
        content:
          `Could not poll feed: \`${missing}\` is no longer subscribed — ` +
          `check \`/rss list\`.`,
        sensitive: true,
      });
      return;
    }
    if (empty) {
      await commandCtx.reply({ content: NO_FEEDS_HINT, sensitive: true });
      return;
    }

    // Community-wide config gate (settings are per community: one honest
    // error instead of N refused-config rows).
    const settings = db.getGuildSettings(communityId);
    if (!settings?.rss_notification_channel_id) {
      await commandCtx.reply({
        content: `Could not poll: ${NO_CHANNEL_ERROR}.`,
        sensitive: true,
      });
      return;
    }

    // Per-row loop (rule 5): one feed's failure never hides the others'
    // results; every failure line names its feed and carries the cause.
    const agg = { polled: 0, posted: 0, notModified: 0, backoff: 0, failures: [] };
    for (const row of rows) {
      const res = await subscriptions.forcePoll({
        feed: row,
        settings,
        outbound: commandCtx.outbound,
        db,
        parser: di.parser,
        fetchImpl: di.fetchImpl,
        resolveHost: di.resolveHost,
        now: di.now,
      });
      if (res.outcome === "posted" || res.outcome === "no-change") {
        agg.polled += 1;
        agg.posted += res.posted ?? 0;
      } else if (res.outcome === "not-modified") {
        agg.polled += 1;
        agg.notModified += 1;
      } else if (res.outcome === "backoff") {
        agg.backoff += 1; // defensive: force:true cannot hit the clock gate
      } else {
        agg.failures.push(
          `• **${resolveFeedDisplayName(row)}:** ${res.error || res.outcome}`,
        );
      }
    }

    const summary = [
      `**Forced poll** — ${rows.length} feed(s)`,
      `**Polled:** ${agg.polled}`,
      `**Posted:** ${agg.posted}`,
    ];
    if (agg.notModified) summary.push(`**Not modified:** ${agg.notModified}`);
    if (agg.backoff) summary.push(`**Backoff-gated:** ${agg.backoff}`);
    if (agg.failures.length) {
      summary.push(
        `**Failures:**\n${joinCapped(agg.failures, 1500, "\n")}`,
      );
    }
    await commandCtx.reply({ content: summary.join("\n"), sensitive: true });
    return;
  }
}

// ---------------------------------------------------------------------------
// /setrss
// ---------------------------------------------------------------------------

/**
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSetRss(commandCtx, featureCtx) {
  const di = rssDeps(featureCtx);
  if (!(await requireStaffFromContext(commandCtx))) return;

  const communityId = commandCtx.communityId;
  const guildId = commandCtx.externalGuildId;
  const settings = getGuildSettings(communityId);
  const sub = commandCtx.subcommand;

  if (sub === "channel") {
    const ch = commandCtx.options.getChannel("channel", true);
    const before = settings.rss_notification_channel_id;
    updateGuildSettings(communityId, { rss_notification_channel_id: ch.id });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "rss.notify_channel_set",
      targetType: "channel",
      targetId: ch.id,
      details: { previous_channel_id: before ?? null },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "RSS notification channel set",
      command: "/setrss channel",
      actor: commandCtx.user,
      changes: [
        before
          ? `Channel: <#${before}> → <#${ch.id}>`
          : `Channel: *none* → <#${ch.id}>`,
      ],
    }).catch(() => {});

    await commandCtx.reply({
      content: `RSS notifications will be sent to <#${ch.id}>.`,
      sensitive: true,
    });
    return;
  }

  if (sub === "role") {
    const role = commandCtx.options.getRole("role", false);
    const before = settings.rss_notify_role_id;
    updateGuildSettings(communityId, {
      rss_notify_role_id: role ? role.id : null,
    });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "rss.notify_role_set",
      targetType: "role",
      targetId: role ? role.id : guildId,
      details: { role_id: role ? role.id : null, previous_role_id: before ?? null },
    });
    const afterLabel = role ? `<@&${role.id}>` : "*none*";
    const beforeLabel = before ? `<@&${before}>` : "*none*";
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "RSS mention role set",
      command: "/setrss role",
      actor: commandCtx.user,
      changes: [`Role: ${beforeLabel} → ${afterLabel}`],
    }).catch(() => {});

    await commandCtx.reply({
      content: role
        ? `RSS notifications will mention <@&${role.id}>.`
        : "RSS notifications will no longer mention a role.",
      sensitive: true,
    });
    return;
  }

  if (sub === "interval") {
    const minutes = commandCtx.options.getInteger("minutes", true);
    // Re-check (Discord clamps the picker; the Fluxer arm has no picker).
    // The schema column is NOT NULL — a non-finite value must NEVER reach
    // the write; the reply states the correction instead (the /setyoutube
    // interval copy twin).
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < 1 || n > 60) {
      await commandCtx.reply({
        content: "Polling interval must be between 1 and 60 minutes.",
        sensitive: true,
      });
      return;
    }
    const before = settings.rss_polling_interval_minutes;
    updateGuildSettings(communityId, { rss_polling_interval_minutes: n });
    recordSlashAudit({
      communityId,
      actorUserId: commandCtx.userId,
      action: "rss.polling_interval_set",
      targetType: "guild",
      targetId: guildId,
      details: { previous_minutes: before ?? null, minutes: n },
    });
    await logConfigChange(commandCtx.outbound, guildId, {
      title: "RSS polling interval set",
      command: "/setrss interval",
      actor: commandCtx.user,
      changes: [`Interval: ${before} → **${n}** minute(s)`],
    }).catch(() => {});

    await commandCtx.reply({
      content: `RSS polling interval set to **${n}** minute(s).`,
      sensitive: true,
    });
    return;
  }

  if (sub === "settings") {
    const res = await subscriptions.listFeeds({
      communityId,
      db: di.db,
      env: di.env,
    });
    if (!res.ok) {
      console.error(
        `[rss] /setrss settings failed (community=${communityId}): ${res.error}`,
      );
      await commandCtx.reply({
        content: `Could not read RSS settings: ${res.error}`,
        sensitive: true,
      });
      return;
    }
    await commandCtx.reply({
      content: `**RSS settings**\n${renderSettingsBlock(res.settings, res.feeds.length, res.cap)}`,
      sensitive: true,
    });
    return;
  }
}

// ---------------------------------------------------------------------------
// feed: autocomplete (community-scoped, value = stored url)
// ---------------------------------------------------------------------------

/** Choice name: display_name || feed_title || url-truncated (spec #305). */
function autocompleteName(feed) {
  const raw = feed.display_name || feed.feed_title;
  if (raw) return String(raw).slice(0, AUTOCOMPLETE_NAME_MAX);
  const url = String(feed.url ?? "");
  // -1: room for the ellipsis inside Discord's 100-char name cap.
  return url.length > AUTOCOMPLETE_NAME_MAX
    ? `${url.slice(0, AUTOCOMPLETE_NAME_MAX - 1)}…`
    : url;
}

async function handleRssAutocomplete(interaction) {
  try {
    if (!interaction.guild) {
      await interaction.respond([]);
      return;
    }
    const communityId = discordCommunityId(interaction.guild.id);
    if (communityId == null) {
      // No community row registered yet — nothing to suggest.
      await interaction.respond([]);
      return;
    }
    const feeds = facadeDb.listRssFeedsForCommunity(communityId);
    const focusedValue = String(interaction.options.getFocused() ?? "").toLowerCase();

    const choices = [];
    for (const feed of feeds) {
      const name = autocompleteName(feed);
      const haystack = `${name} ${String(feed.url ?? "")}`.toLowerCase();
      if (focusedValue && !haystack.includes(focusedValue)) continue;
      choices.push({ name, value: feed.url });
      if (choices.length === 25) break; // Discord choice cap
    }
    await interaction.respond(choices);
  } catch (err) {
    // Autocomplete is an entry point (error law #1): a failing read answers
    // "no suggestions" with a logged cause — never a rejected interaction.
    console.error("[rss] feed autocomplete failed:", err?.message || err);
    try {
      await interaction.respond([]);
    } catch {
      /* the interaction was already answered — nothing left to do */
    }
  }
}

// ---------------------------------------------------------------------------
// Feature-module export contract (consumed by src/features/rss/index.js,
// subtask 08, which spreads these into the module src/features/load.js reads)
// ---------------------------------------------------------------------------

module.exports = {
  commands,
  handlers: {
    rss: handleRss,
    setrss: handleSetRss,
  },
  // Router API flag (roadmap/fluxer.md § Handler migration rule): these
  // slash handlers receive a CommandContext. Autocomplete stays on the
  // interaction arm.
  handlerApi: {
    rss: "context",
    setrss: "context",
  },
  autocomplete: {
    rss: handleRssAutocomplete,
  },
};
