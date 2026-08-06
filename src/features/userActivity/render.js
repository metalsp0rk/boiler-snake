/**
 * Activity embeds and button rows for /userinfo Activity views.
 *
 * Custom IDs must be unique across the whole message (including disabled
 * buttons). Roles:
 *   ui:o|n|w:<userId>              primary Overview / Notes / Warnings
 *   ui:a:<userId>                  primary Activity (open channels / all-time)
 *   ui:aw:<win>:<page>:<userId>    window toggle (a|7|30, page ch|ca)
 *   ui:ap:<page>:<win>:<userId>    page toggle (ch|ca)
 *   ui:b:<userId>                  backfill
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  formatWeeklyRate,
  normalizeWindow,
  windowLabel,
} = require("./service");

const COLOR_ACTIVITY = 0x1abc9c;
const BTN_PREFIX = "ui:";

/**
 * Map internal page token to view letter used by buildViewPayload.
 * @param {"ch"|"ca"|string} page
 * @returns {"a"|"c"}
 */
function pageToView(page) {
  return page === "ca" ? "c" : "a";
}

/**
 * @param {"a"|"c"|string} view
 * @returns {"ch"|"ca"}
 */
function viewToPage(view) {
  return view === "c" ? "ca" : "ch";
}

/**
 * Build a button custom id.
 * @param {"o"|"n"|"w"|"a"|"b"|"aw"|"ap"} kind
 * @param {string} userId
 * @param {{ win?: string, page?: "ch"|"ca"|"a"|"c" }} [extra]
 * @returns {string}
 */
function activityButtonCustomId(kind, userId, extra = {}) {
  if (kind === "o" || kind === "n" || kind === "w") {
    return `${BTN_PREFIX}${kind}:${userId}`;
  }
  if (kind === "a") {
    // Primary Activity tab — always unique; opens channels / all-time
    return `${BTN_PREFIX}a:${userId}`;
  }
  if (kind === "b") {
    return `${BTN_PREFIX}b:${userId}`;
  }
  if (kind === "aw") {
    const win = normalizeWindow(extra.win);
    const page =
      extra.page === "ca" || extra.page === "c" ? "ca" : "ch";
    return `${BTN_PREFIX}aw:${win}:${page}:${userId}`;
  }
  if (kind === "ap") {
    const win = normalizeWindow(extra.win);
    const page =
      extra.page === "ca" || extra.page === "c" ? "ca" : "ch";
    return `${BTN_PREFIX}ap:${page}:${win}:${userId}`;
  }
  return `${BTN_PREFIX}${kind}:${userId}`;
}

/**
 * @param {string} customId
 * @returns {{ view: string, userId: string, win?: string }|null}
 */
function parseActivityButtonCustomId(customId) {
  if (!customId || !customId.startsWith(BTN_PREFIX)) return null;
  const rest = customId.slice(BTN_PREFIX.length);
  const parts = rest.split(":");
  if (parts.length < 2) return null;

  const kind = parts[0];

  // Overview / Notes / Warnings
  if (kind === "o" || kind === "n" || kind === "w") {
    if (parts.length !== 2 || !parts[1]) return null;
    return { view: kind, userId: parts[1] };
  }

  // Primary Activity entry → channels, all-time
  // Legacy: ui:a:<userId>:<win> (3 parts) still accepted
  if (kind === "a") {
    if (parts.length === 2 && parts[1]) {
      return { view: "a", userId: parts[1], win: "a" };
    }
    if (parts.length === 3 && parts[1]) {
      return {
        view: "a",
        userId: parts[1],
        win: normalizeWindow(parts[2]),
      };
    }
    return null;
  }

  // Legacy categories: ui:c:<userId>:<win>
  if (kind === "c") {
    if (parts.length === 3 && parts[1]) {
      return {
        view: "c",
        userId: parts[1],
        win: normalizeWindow(parts[2]),
      };
    }
    return null;
  }

  // Backfill
  if (kind === "b") {
    if (parts.length !== 2 || !parts[1]) return null;
    return { view: "b", userId: parts[1] };
  }

  // Window toggle: aw:<win>:<page>:<userId>
  if (kind === "aw") {
    if (parts.length !== 4 || !parts[3]) return null;
    const win = normalizeWindow(parts[1]);
    const view = pageToView(parts[2]);
    return { view, userId: parts[3], win };
  }

  // Page toggle: ap:<page>:<win>:<userId>
  if (kind === "ap") {
    if (parts.length !== 4 || !parts[3]) return null;
    const view = pageToView(parts[1]);
    const win = normalizeWindow(parts[2]);
    return { view, userId: parts[3], win };
  }

  return null;
}

/**
 * Primary nav row shared with userinfo overview/notes/warnings.
 * @param {object} counts
 * @param {string} activeView o|n|w|a|c
 * @param {string} userId
 * @param {string} [win] unused for primary Activity id (kept for API compat)
 */
function buildPrimaryButtons(counts, activeView, userId, win = "a") {
  void win;
  const notesLabel =
    counts.notesActive === counts.notesTotal
      ? `Notes (${counts.notesActive})`
      : `Notes (${counts.notesActive}/${counts.notesTotal})`;
  const warnsLabel =
    counts.warnsActive === counts.warnsTotal
      ? `Warnings (${counts.warnsActive})`
      : `Warnings (${counts.warnsActive} active)`;

  const isActivity = activeView === "a" || activeView === "c";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(activityButtonCustomId("o", userId))
      .setLabel("Overview")
      .setStyle(
        activeView === "o" ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      .setDisabled(activeView === "o"),
    new ButtonBuilder()
      .setCustomId(activityButtonCustomId("n", userId))
      .setLabel(notesLabel.slice(0, 80))
      .setStyle(
        activeView === "n" ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      .setDisabled(activeView === "n"),
    new ButtonBuilder()
      .setCustomId(activityButtonCustomId("w", userId))
      .setLabel(warnsLabel.slice(0, 80))
      .setStyle(
        activeView === "w" ? ButtonStyle.Primary : ButtonStyle.Secondary
      )
      .setDisabled(activeView === "w"),
    new ButtonBuilder()
      .setCustomId(activityButtonCustomId("a", userId))
      .setLabel("Activity")
      .setStyle(isActivity ? ButtonStyle.Primary : ButtonStyle.Secondary)
      // Keep enabled on categories so staff can jump back to channels/all;
      // only disable when already on default channels view is awkward — disable
      // whenever any activity page is open so primary never duplicates control row.
      .setDisabled(isActivity)
  );
}

/**
 * Window + page toggles for activity.
 * @param {string} userId
 * @param {string} win
 * @param {"a"|"c"} page a=channels c=categories
 * @param {object} [meta]
 */
function buildActivityControlRows(userId, win, page, meta = null) {
  const w = normalizeWindow(win);
  const pageTok = viewToPage(page);
  const running =
    meta?.backfill_status === "running" || meta?.backfill_status === "queued";

  const windowRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(
        activityButtonCustomId("aw", userId, { win: "a", page: pageTok })
      )
      .setLabel("All")
      .setStyle(w === "a" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(w === "a"),
    new ButtonBuilder()
      .setCustomId(
        activityButtonCustomId("aw", userId, { win: "7", page: pageTok })
      )
      .setLabel("7d")
      .setStyle(w === "7" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(w === "7"),
    new ButtonBuilder()
      .setCustomId(
        activityButtonCustomId("aw", userId, { win: "30", page: pageTok })
      )
      .setLabel("30d")
      .setStyle(w === "30" ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(w === "30"),
    new ButtonBuilder()
      .setCustomId(
        activityButtonCustomId("ap", userId, { page: "ch", win: w })
      )
      .setLabel("Channels")
      .setStyle(page === "a" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(page === "a"),
    new ButtonBuilder()
      .setCustomId(
        activityButtonCustomId("ap", userId, { page: "ca", win: w })
      )
      .setLabel("Categories")
      .setStyle(page === "c" ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(page === "c")
  );

  const backfillLabel = running
    ? `Backfill… ${meta.backfill_channels_done || 0}/${meta.backfill_channels_total || "?"}`
    : meta?.backfill_status === "done"
      ? "Backfill ✓"
      : meta?.backfill_status === "partial"
        ? "Backfill (partial)"
        : meta?.backfill_status === "failed"
          ? "Retry backfill"
          : "Backfill history";

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(activityButtonCustomId("b", userId))
      .setLabel(backfillLabel.slice(0, 80))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(running)
  );

  return [windowRow, actionRow];
}

/**
 * @param {object[]} ranked
 * @returns {string}
 */
function formatRankLines(ranked) {
  if (!ranked.length) {
    return "No tracked messages yet. Use **Backfill history** or wait for new posts.";
  }
  return ranked
    .map((r, i) => {
      const pct = r.pct.toFixed(1);
      const rate = formatWeeklyRate(r.weekly);
      const label =
        r.label.length > 28 ? `${r.label.slice(0, 27)}…` : r.label;
      return `**${i + 1}.** ${label} · **${r.count}** · ${pct}% · ${rate}`;
    })
    .join("\n")
    .slice(0, 1024);
}

/**
 * @param {object} user
 * @param {object} ranking from buildChannelRanking / buildCategoryRanking
 * @param {"channels"|"categories"} page
 * @param {number|null|undefined} joinedMs
 * @returns {EmbedBuilder}
 */
function buildActivityEmbed(user, ranking, page, joinedMs) {
  const pageTitle = page === "categories" ? "Categories" : "Channels";
  const embed = new EmbedBuilder()
    .setColor(COLOR_ACTIVITY)
    .setTitle(`Activity · ${pageTitle} · ${ranking.windowLabel}`)
    .setDescription(
      `Subject: <@${user.id}> · \`${user.id}\`\n` +
        `**Window total:** ${ranking.windowTotal} · **Lifetime:** ${ranking.lifetimeTotal} · ` +
        `**~${formatWeeklyRate(ranking.lifetimeWeekly)}** since join`
    );

  embed.addFields({
    name: page === "categories" ? "Top categories" : "Top channels",
    value: formatRankLines(ranking.ranked),
  });

  const footerParts = [];
  if (ranking.trackingDay) {
    footerParts.push(`Tracking data from ${ranking.trackingDay}`);
  } else {
    footerParts.push("No counters yet · forward tracking + optional backfill");
  }
  if (joinedMs == null) {
    footerParts.push("join date unknown · rate uses min 1 week");
  }
  const st = ranking.meta?.backfill_status;
  if (st && st !== "none") {
    footerParts.push(`backfill: ${st}`);
  }
  footerParts.push("Senior staff · posts/wk = lifetime ÷ weeks since join");
  embed.setFooter({ text: footerParts.join(" · ").slice(0, 2048) });

  return embed;
}

/**
 * Assert all custom ids in component rows are unique (tests / debug).
 * @param {import("discord.js").ActionRowBuilder[]} rows
 * @returns {string[]}
 */
function collectCustomIds(rows) {
  const ids = [];
  for (const row of rows || []) {
    const comps = row.components || row.data?.components || [];
    for (const c of comps) {
      const id = c.data?.custom_id || c.customId || c.custom_id;
      if (id) ids.push(id);
    }
  }
  return ids;
}

module.exports = {
  COLOR_ACTIVITY,
  BTN_PREFIX,
  activityButtonCustomId,
  parseActivityButtonCustomId,
  buildPrimaryButtons,
  buildActivityControlRows,
  buildActivityEmbed,
  formatRankLines,
  pageToView,
  viewToPage,
  collectCustomIds,
};
