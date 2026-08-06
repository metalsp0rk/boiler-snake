/**
 * User channel activity — ranking, ignore checks, weekly rates, category rollup.
 */

const {
  utcDayKey,
  utcDayKeyDaysAgo,
  ensureGuildActivitySettings,
  incrementDaily,
  getActivityIgnoreSets,
  sumByChannel,
  totalPosts,
  earliestTrackedDay,
  getUserActivityMeta,
  isHoneypotChannel,
} = require("../../db");

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const TOP_CHANNELS = 15;
const TOP_CATEGORIES = 15;

/** Fixed window lengths in days (token → days). All-time uses join age instead. */
const WINDOW_DAYS = { "7": 7, "30": 30, "90": 90 };

/** @typedef {"a"|"7"|"30"|"90"} ActivityWindow */
/** @typedef {"channels"|"categories"} ActivityPage */

/**
 * @param {string|undefined|null} win
 * @returns {ActivityWindow}
 */
function normalizeWindow(win) {
  if (win === "7" || win === "30" || win === "90") return win;
  return "a";
}

/**
 * @param {ActivityWindow} win
 * @returns {string|null} sinceDay inclusive, or null for all-time
 */
function sinceDayForWindow(win) {
  const w = normalizeWindow(win);
  if (w in WINDOW_DAYS) return utcDayKeyDaysAgo(WINDOW_DAYS[w]);
  return null;
}

/**
 * @param {ActivityWindow} win
 * @returns {string}
 */
function windowLabel(win) {
  const w = normalizeWindow(win);
  if (w === "7") return "Last 7 days";
  if (w === "30") return "Last 30 days";
  if (w === "90") return "Last 90 days";
  return "All time";
}

/**
 * Weeks since guild join (min 1).
 * @param {number|null|undefined} joinedMs
 * @param {number} [nowMs]
 * @returns {number}
 */
function weeksSinceJoin(joinedMs, nowMs = Date.now()) {
  if (joinedMs == null || !Number.isFinite(Number(joinedMs))) return 1;
  const elapsed = Math.max(0, Number(nowMs) - Number(joinedMs));
  return Math.max(1, elapsed / MS_PER_WEEK);
}

/**
 * Denominator for posts/week in the selected window.
 * Fixed windows use window length in weeks; all-time uses weeks since join.
 * @param {string|undefined|null} win
 * @param {number|null|undefined} joinedMs
 * @param {number} [nowMs]
 * @returns {number}
 */
function weeksForWindow(win, joinedMs, nowMs = Date.now()) {
  const w = normalizeWindow(win);
  if (w in WINDOW_DAYS) return WINDOW_DAYS[w] / 7;
  return weeksSinceJoin(joinedMs, nowMs);
}

/**
 * @param {number} posts
 * @param {number} weeks
 * @returns {number}
 */
function weeklyRate(posts, weeks) {
  const w = Math.max(1, Number(weeks) || 1);
  return (Number(posts) || 0) / w;
}

/**
 * @param {number} rate
 * @returns {string}
 */
function formatWeeklyRate(rate) {
  const n = Number(rate) || 0;
  if (n >= 100) return `${Math.round(n)}/wk`;
  return `${n.toFixed(1)}/wk`;
}

/**
 * Resolve category id for a channel (threads → parent text → category).
 * @param {import("discord.js").Guild|null|undefined} guild
 * @param {string} channelId
 * @returns {{ categoryId: string|null, parentChannelId: string|null, name: string|null }}
 */
function resolveChannelMeta(guild, channelId) {
  if (!guild?.channels?.cache) {
    return { categoryId: null, parentChannelId: null, name: null };
  }
  const ch = guild.channels.cache.get(channelId) || null;
  if (!ch) {
    return { categoryId: null, parentChannelId: null, name: null };
  }

  const name = ch.name || null;
  let parentChannelId = null;
  let categoryId = null;

  if (typeof ch.isThread === "function" && ch.isThread()) {
    parentChannelId = ch.parentId || null;
    const parent = parentChannelId
      ? guild.channels.cache.get(parentChannelId)
      : null;
    categoryId = parent?.parentId || null;
  } else if (ch.type === 4 /* GuildCategory */) {
    categoryId = ch.id;
  } else {
    categoryId = ch.parentId || null;
  }

  return { categoryId, parentChannelId, name };
}

/**
 * Should we skip counting this channel (ignore + honeypot)?
 * @param {string} guildId
 * @param {string} channelId
 * @param {string|null|undefined} categoryId
 * @returns {boolean}
 */
function shouldSkipChannel(guildId, channelId, categoryId) {
  if (isHoneypotChannel(guildId, channelId)) return true;
  const { channels, categories } = getActivityIgnoreSets(guildId);
  if (channels.has(channelId)) return true;
  if (categoryId && categories.has(categoryId)) return true;
  return false;
}

/**
 * Record one human guild message into daily counters.
 * @param {import("discord.js").Message} message
 * @returns {boolean} true if counted
 */
function recordUserChannelMessage(message) {
  try {
    if (!message?.guild || !message.author) return false;
    if (message.author.bot) return false;
    if (message.system) return false;

    const guildId = message.guild.id;
    const userId = message.author.id;
    const channelId = message.channelId || message.channel?.id || null;
    if (!channelId) return false;

    const createdMs = message.createdTimestamp || Date.now();
    // Seed watermark from this message's timestamp so it is not dropped
    const settings = ensureGuildActivitySettings(guildId, {
      collectFromMs: createdMs,
    });

    // Live path only counts at/after watermark; backfill fills before it
    if (createdMs < settings.collect_from_ms) return false;

    let categoryId = null;
    const ch = message.channel;
    if (ch) {
      if (typeof ch.isThread === "function" && ch.isThread()) {
        categoryId = ch.parent?.parentId || null;
      } else if (ch.parentId) {
        categoryId = ch.parentId;
      }
    }
    if (categoryId == null) {
      categoryId = resolveChannelMeta(message.guild, channelId).categoryId;
    }

    if (shouldSkipChannel(guildId, channelId, categoryId)) return false;

    const day = utcDayKey(createdMs);
    incrementDaily(guildId, userId, channelId, day, 1);
    return true;
  } catch (e) {
    console.error("[userActivity] record failed:", e?.message || e);
    return false;
  }
}

/**
 * Filter channel sums by ignore/honeypot using current guild channel parents.
 * @param {string} guildId
 * @param {import("discord.js").Guild|null|undefined} guild
 * @param {{ channel_id: string, count: number }[]} rows
 * @returns {{ channel_id: string, count: number }[]}
 */
function filterCountedChannels(guildId, guild, rows) {
  return rows.filter((r) => {
    const { categoryId } = resolveChannelMeta(guild, r.channel_id);
    return !shouldSkipChannel(guildId, r.channel_id, categoryId);
  });
}

/**
 * Build channel ranking for a window.
 * Posts/week uses the selected window's counts and length (all-time: join age).
 * @param {object} opts
 * @returns {object}
 */
function buildChannelRanking(opts) {
  const { guildId, userId, guild, window: win, joinedMs } = opts;
  const sinceDay = sinceDayForWindow(win);
  const weeks = weeksForWindow(win, joinedMs);
  const joinWeeks = weeksSinceJoin(joinedMs);

  const windowRows = filterCountedChannels(
    guildId,
    guild,
    sumByChannel(guildId, userId, { sinceDay })
  );
  const allTimeRows = filterCountedChannels(
    guildId,
    guild,
    sumByChannel(guildId, userId, { sinceDay: null })
  );

  const windowTotal = windowRows.reduce((s, r) => s + r.count, 0);
  const lifetimeTotal = allTimeRows.reduce((s, r) => s + r.count, 0);

  const labelFn = (id) => {
    const meta = resolveChannelMeta(guild, id);
    if (meta.name) return `#${meta.name}`;
    return `#${id}`;
  };

  const ranked = windowRows.slice(0, TOP_CHANNELS).map((r) => {
    return {
      id: r.channel_id,
      label: labelFn(r.channel_id),
      count: r.count,
      pct: windowTotal > 0 ? (r.count / windowTotal) * 100 : 0,
      weekly: weeklyRate(r.count, weeks),
    };
  });

  return {
    window: normalizeWindow(win),
    windowLabel: windowLabel(win),
    weeks,
    windowTotal,
    lifetimeTotal,
    /** Posts/week for the selected window (same as lifetime when win is all-time). */
    windowWeekly: weeklyRate(windowTotal, weeks),
    /** Lifetime posts ÷ weeks since join (always all-time). */
    lifetimeWeekly: weeklyRate(lifetimeTotal, joinWeeks),
    ranked,
    trackingDay: earliestTrackedDay(guildId, userId),
    meta: getUserActivityMeta(guildId, userId),
  };
}

/**
 * Roll up filtered channel rows into categories using current parents.
 * @param {object} opts
 * @returns {object}
 */
function buildCategoryRanking(opts) {
  const { guildId, userId, guild, window: win, joinedMs } = opts;
  const sinceDay = sinceDayForWindow(win);
  const weeks = weeksForWindow(win, joinedMs);
  const joinWeeks = weeksSinceJoin(joinedMs);

  const windowRows = filterCountedChannels(
    guildId,
    guild,
    sumByChannel(guildId, userId, { sinceDay })
  );
  const allTimeRows = filterCountedChannels(
    guildId,
    guild,
    sumByChannel(guildId, userId, { sinceDay: null })
  );

  /** @type {Map<string, number>} */
  const windowByCat = new Map();
  /** @type {Map<string, number>} */
  const lifeByCat = new Map();

  const add = (map, key, n) => map.set(key, (map.get(key) || 0) + n);

  for (const r of windowRows) {
    const { categoryId } = resolveChannelMeta(guild, r.channel_id);
    add(windowByCat, categoryId || "__uncategorized__", r.count);
  }
  for (const r of allTimeRows) {
    const { categoryId } = resolveChannelMeta(guild, r.channel_id);
    add(lifeByCat, categoryId || "__uncategorized__", r.count);
  }

  const windowTotal = [...windowByCat.values()].reduce((s, n) => s + n, 0);
  const lifetimeTotal = [...lifeByCat.values()].reduce((s, n) => s + n, 0);

  const ranked = [...windowByCat.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_CATEGORIES)
    .map((r) => {
      let label = "Uncategorized";
      if (r.id !== "__uncategorized__") {
        const ch = guild?.channels?.cache?.get?.(r.id);
        label = ch?.name ? ch.name : `category:${r.id}`;
      }
      return {
        id: r.id,
        label,
        count: r.count,
        pct: windowTotal > 0 ? (r.count / windowTotal) * 100 : 0,
        weekly: weeklyRate(r.count, weeks),
      };
    });

  return {
    window: normalizeWindow(win),
    windowLabel: windowLabel(win),
    weeks,
    windowTotal,
    lifetimeTotal,
    windowWeekly: weeklyRate(windowTotal, weeks),
    lifetimeWeekly: weeklyRate(lifetimeTotal, joinWeeks),
    ranked,
    trackingDay: earliestTrackedDay(guildId, userId),
    meta: getUserActivityMeta(guildId, userId),
  };
}

module.exports = {
  MS_PER_WEEK,
  TOP_CHANNELS,
  TOP_CATEGORIES,
  WINDOW_DAYS,
  normalizeWindow,
  sinceDayForWindow,
  windowLabel,
  weeksSinceJoin,
  weeksForWindow,
  weeklyRate,
  formatWeeklyRate,
  resolveChannelMeta,
  shouldSkipChannel,
  recordUserChannelMessage,
  filterCountedChannels,
  buildChannelRanking,
  buildCategoryRanking,
  totalPosts,
  utcDayKey,
  utcDayKeyDaysAgo,
};
