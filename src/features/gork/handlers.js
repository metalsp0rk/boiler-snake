/**
 * /gork subcommand handlers (staff). Dispatcher lives in index.js.
 */
const { ChannelType } = require("discord.js");
const {
  getGuildSettings,
  updateGuildSettings,
  addGorkBlock,
  removeGorkBlock,
  listGorkBlocks,
  gorkMemoryListForSubject,
  gorkMemoryListForGuild,
  gorkMemoryGetById,
  gorkMemoryDeleteById,
  gorkMemoryDeleteForSubject,
  gorkMemoryDeleteForGuild,
  gorkMemoryCountForGuild,
  countGorkInteractions,
  upsertGorkBudgetRule,
  deleteGorkBudgetRule,
  listGorkBudgetRules,
  clampGorkDailyLimit,
} = require("../../db");
const { replyEphemeral, editEphemeral } = require("../../core/interaction");
const { Color, baseEmbed } = require("../../core/theme");
const { sliceSafe } = require("../../core/text");
const { getAiConfig } = require("../../core/ai");
const { logConfigChange } = require("../logs/auditLog");
const { recordSlashAudit } = require("../../core/auditTrail");
const {
  formatDailyLimit,
  isThreadLike,
  checkGorkBudget,
  shouldSendBudgetRejection,
  recordGorkBudgetUsage,
} = require("./budget");
const { gorkQueue, QUEUE_FULL_REPLY } = require("./trigger");
const { validateSummarizeMode, readSummarizeRange } = require("./summarizeRange");
const {
  generateSummarize,
  SUMMARIZE_TEMPERATURE,
  SUMMARIZE_MAX_TOKENS,
} = require("./summarize");
const {
  renderSummarizeEmbeds,
  buildRundownPayloads,
} = require("./summarizeEmbed");
const {
  checkSummarizeGuildCooldown,
  armSummarizeGuildCooldown,
  summarizeCooldownMinutesRemaining,
} = require("./summarizeCooldown");
const {
  logGorkSummarize,
  logGorkSummarizeFailure,
  createSummarizeInteractionRecorder,
} = require("./audit");
const { NO_PING_MENTIONS } = require("./sanitize");
const { formatChannelLabel } = require("./channel");
const {
  KEYWORD_MAX,
  CONTEXT_MIN,
  CONTEXT_MAX,
  COOLDOWN_MIN,
  COOLDOWN_MAX,
  RULES_MAX,
  BANS_LIST_MAX,
  MEMORIES_LIST_MAX,
  MEMORY_BODY_MAX,
  MEMORY_LIST_TOTAL_MAX,
  BUDGET_MIN,
  BUDGET_MAX,
  BUDGET_RULES_LIST_MAX,
  GORK_SUMMARIZE_GUILD_COOLDOWN_MS,
} = require("./constants");

/**
 * /gork keyword: set the trigger keyword, or `clear` to disable gork.
 */
async function setKeyword(client, interaction, guildId) {
  const raw = (interaction.options.getString("keyword") || "").trim();
  const clearing = raw === "clear";
  if (!clearing && (!raw || raw.length > KEYWORD_MAX)) {
    return replyEphemeral(
      interaction,
      `The keyword must be 1-${KEYWORD_MAX} characters (or \`clear\` to disable gork).`,
    );
  }
  const settings = updateGuildSettings(guildId, {
    gork_keyword: clearing ? null : raw,
  });
  recordSlashAudit({
    interaction,
    action: "gork.keyword_set",
    targetType: "guild",
    targetId: guildId,
    details: { keyword: settings.gork_keyword ?? null, cleared: clearing },
  });
  await logConfigChange(client, guildId, {
    title: clearing ? "Gork disabled" : "Gork keyword updated",
    command: "/gork keyword",
    actor: interaction.user,
    changes: [
      clearing
        ? "Keyword: cleared (gork disabled)"
        : `Keyword: \`${settings.gork_keyword}\``,
    ],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    clearing
      ? "Gork is now **disabled** for this server — triggers are ignored."
      : `Gork keyword set to \`${settings.gork_keyword}\`. Trigger it with \`${settings.gork_keyword} <question>\`, or \`${settings.gork_keyword}\` replying to a message.`,
  );
}

/**
 * /gork context: set the context window size (1-50).
 */
async function setContext(client, interaction, guildId) {
  const raw = interaction.options.getInteger("context");
  if (!Number.isFinite(raw) || raw < CONTEXT_MIN || raw > CONTEXT_MAX) {
    return replyEphemeral(
      interaction,
      `The context window must be ${CONTEXT_MIN}-${CONTEXT_MAX} messages.`,
    );
  }
  const settings = updateGuildSettings(guildId, {
    gork_context_window: raw,
  });
  recordSlashAudit({
    interaction,
    action: "gork.context_set",
    targetType: "guild",
    targetId: guildId,
    details: { context_window: settings.gork_context_window },
  });
  await logConfigChange(client, guildId, {
    title: "Gork context window updated",
    command: "/gork context",
    actor: interaction.user,
    changes: [`Context window: ${settings.gork_context_window} messages`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    `Gork context window set to **${settings.gork_context_window}** prior messages.`,
  );
}

/**
 * /gork cooldown: set the per-user cooldown in seconds (0-3600).
 */
async function setCooldown(client, interaction, guildId) {
  const raw = interaction.options.getInteger("cooldown");
  if (!Number.isFinite(raw) || raw < COOLDOWN_MIN || raw > COOLDOWN_MAX) {
    return replyEphemeral(
      interaction,
      `The cooldown must be ${COOLDOWN_MIN}-${COOLDOWN_MAX} seconds (0 = disabled).`,
    );
  }
  const settings = updateGuildSettings(guildId, {
    gork_cooldown_sec: raw,
  });
  const stored = settings.gork_cooldown_sec;
  recordSlashAudit({
    interaction,
    action: "gork.cooldown_set",
    targetType: "guild",
    targetId: guildId,
    details: { cooldown_sec: stored },
  });
  await logConfigChange(client, guildId, {
    title: "Gork cooldown updated",
    command: "/gork cooldown",
    actor: interaction.user,
    changes: [`Cooldown: ${stored}s (staff always bypass)`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    stored === 0
      ? "Gork cooldown is now **disabled** (0s). Staff always bypass."
      : `Gork cooldown set to **${stored}s** per user per server. Staff always bypass.`,
  );
}

/**
 * /gork rules: set the staff prompt rules, or `clear` to remove them.
 */
async function setRules(client, interaction, guildId) {
  const raw = (interaction.options.getString("rules") || "").trim();
  const clearing = raw === "clear";
  if (!clearing && !raw) {
    return replyEphemeral(
      interaction,
      "Rules cannot be empty — use `clear` to remove them.",
    );
  }
  if (raw.length > RULES_MAX) {
    return replyEphemeral(
      interaction,
      `Rules must be at most ${RULES_MAX} characters.`,
    );
  }
  const settings = updateGuildSettings(guildId, {
    gork_extra_rules: clearing ? "" : raw,
  });
  const stored = (settings.gork_extra_rules || "").trim();
  recordSlashAudit({
    interaction,
    action: "gork.rules_set",
    targetType: "guild",
    targetId: guildId,
    details: { rules: stored, cleared: clearing },
  });
  await logConfigChange(client, guildId, {
    title: stored ? "Gork staff rules updated" : "Gork staff rules removed",
    command: "/gork rules",
    actor: interaction.user,
    changes: [stored ? `Rules: \`${stored}\`` : "Rules: removed"],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    stored
      ? `Gork staff rules set to:\n\`${stored}\`\n\nThey are appended to the system prompt; the SFW / questions-only guardrails always apply.`
      : "Gork staff rules removed.",
  );
}

/**
 * /gork search: toggle the SearXNG web_search tool for the guild.
 */
async function setSearch(client, interaction, guildId) {
  const raw = (interaction.options.getString("search") || "").toLowerCase();
  if (raw !== "on" && raw !== "off") {
    return replyEphemeral(interaction, "Search must be `on` or `off`.");
  }
  const settings = updateGuildSettings(guildId, {
    gork_search_enabled: raw === "on" ? 1 : 0,
  });
  const on = Number(settings.gork_search_enabled) === 1;
  recordSlashAudit({
    interaction,
    action: "gork.search_set",
    targetType: "guild",
    targetId: guildId,
    details: { enabled: on ? 1 : 0 },
  });
  await logConfigChange(client, guildId, {
    title: `Gork web search ${on ? "enabled" : "disabled"}`,
    command: "/gork search",
    actor: interaction.user,
    changes: [`Web search: ${on ? "on" : "off"}`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    on
      ? "Gork web search is now **on** (runs against the bot's SearXNG instance — see `/gork status` for the URL state)."
      : "Gork web search is now **off** — answers come from conversation context only.",
  );
}

/**
 * /gork enable: master on/off switch for the whole gork feature in this
 * guild. Off makes triggers fully silent; every other gork setting
 * (keyword, rules, cooldown, bans, ...) is preserved for re-enable.
 */
async function setEnable(client, interaction, guildId) {
  const raw = (interaction.options.getString("enable") || "").toLowerCase();
  if (raw !== "on" && raw !== "off") {
    return replyEphemeral(interaction, "Enable must be `on` or `off`.");
  }
  const settings = updateGuildSettings(guildId, {
    gork_enabled: raw === "on" ? 1 : 0,
  });
  const on = Number(settings.gork_enabled ?? 1) === 1;
  recordSlashAudit({
    interaction,
    action: "gork.enabled_set",
    targetType: "guild",
    targetId: guildId,
    details: { enabled: on ? 1 : 0 },
  });
  await logConfigChange(client, guildId, {
    title: `Gork ${on ? "enabled" : "disabled"} for the server`,
    command: "/gork enable",
    actor: interaction.user,
    changes: [`Gork: ${on ? "enabled" : "disabled"}`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    on
      ? "Gork is now **enabled** for this server — keyword triggers are active again."
      : "Gork is now **disabled** for this server — all triggers are ignored. Every other gork setting is kept; re-enable with `/gork enable on`.",
  );
}

/**
 * /gork ban: block a user from gork in this guild. The banned user keeps
 * getting the locked generic replies (never told about the ban), and
 * staff roles do NOT bypass the ban.
 */
async function banUser(client, interaction, guildId) {
  const user = interaction.options.getUser("user");
  if (!user) {
    return replyEphemeral(interaction, "Pick a user to ban from gork.");
  }
  if (user.bot) {
    return replyEphemeral(
      interaction,
      "Bots can't be banned from gork (they never trigger it anyway).",
    );
  }
  addGorkBlock(guildId, user.id, interaction.user.id);
  recordSlashAudit({
    interaction,
    action: "gork.ban",
    targetType: "user",
    targetId: user.id,
  });
  await logConfigChange(client, guildId, {
    title: "Gork user banned",
    command: "/gork ban",
    actor: interaction.user,
    changes: [`Banned from gork: <@${user.id}> (\`${user.id}\`)`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    `<@${user.id}> is now **banned from gork** in this server — triggers get the generic "brain went to lunch" reply (they are not told it's a ban). Lift it with \`/gork unban\`.`,
  );
}

/**
 * /gork unban: lift a user's gork ban in this guild.
 */
async function unbanUser(client, interaction, guildId) {
  const user = interaction.options.getUser("user");
  if (!user) {
    return replyEphemeral(interaction, "Pick a user to unban from gork.");
  }
  const removed = removeGorkBlock(guildId, user.id);
  if (!removed) {
    return replyEphemeral(
      interaction,
      `<@${user.id}> is not banned from gork in this server.`,
    );
  }
  recordSlashAudit({
    interaction,
    action: "gork.unban",
    targetType: "user",
    targetId: user.id,
  });
  await logConfigChange(client, guildId, {
    title: "Gork user unbanned",
    command: "/gork unban",
    actor: interaction.user,
    changes: [`Unbanned from gork: <@${user.id}> (\`${user.id}\`)`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    `<@${user.id}> can use gork again in this server.`,
  );
}

/**
 * /gork bans: ephemeral list of users banned from gork in this guild.
 */
async function showBans(interaction, guildId) {
  const blocks = listGorkBlocks(guildId);
  if (!blocks.length) {
    return replyEphemeral(
      interaction,
      "No users are banned from gork in this server.",
    );
  }
  const shown = blocks.slice(0, BANS_LIST_MAX).map((b) => `- <@${b.user_id}>`);
  if (blocks.length > BANS_LIST_MAX) {
    shown.push(`…and ${blocks.length - BANS_LIST_MAX} more`);
  }
  await replyEphemeral(
    interaction,
    `**Gork bans (${blocks.length}):**\n${shown.join("\n")}`,
  );
}

/**
 * One `/gork memory show` line:
 * `#id — <@userid> — YYYY-MM-DD · title: body(≤120 chars…)`.
 */
function formatMemoryShowLine(row) {
  const body = String(row.body || "")
    .replace(/\s+/g, " ")
    .trim();
  const shown =
    body.length > MEMORY_BODY_MAX
      ? `${sliceSafe(body, MEMORY_BODY_MAX)}…`
      : body;
  return `#${row.id} — <@${row.subject_user_id}> — ${row.mem_date} · ${row.title}: ${shown}`;
}

/**
 * Pure total-budget cut: keep whole lines while the joined listing stays
 * within `totalMax`; everything past the cut is reported as hidden.
 */
function capMemoryLines(lines, totalMax) {
  let total = 0;
  const shown = [];
  for (const line of lines) {
    const cost = shown.length ? line.length + 1 : line.length;
    if (total + cost > totalMax) break;
    shown.push(line);
    total += cost;
  }
  return { shown, hidden: lines.length - shown.length };
}

/**
 * /gork memory show [user]: ephemeral listing with `#id` handles — one
 * person's memories when `user` is given, otherwise the newest guild rows.
 */
async function showMemory(interaction, guildId) {
  const target = interaction.options.getUser("user");
  const rows = target
    ? gorkMemoryListForSubject(guildId, target.id)
    : gorkMemoryListForGuild(guildId, MEMORIES_LIST_MAX);
  if (!rows.length) {
    return replyEphemeral(
      interaction,
      target
        ? `No memories stored for <@${target.id}> in this server.`
        : "No memories stored in this server yet.",
    );
  }
  const heading = target
    ? `**Gork memories for <@${target.id}> (${rows.length}):**`
    : `**Gork memories (newest ${rows.length}):**`;
  const { shown, hidden } = capMemoryLines(
    rows.map(formatMemoryShowLine),
    MEMORY_LIST_TOTAL_MAX,
  );
  const lines = [...shown];
  if (hidden > 0) lines.push(`…and ${hidden} more`);
  await replyEphemeral(interaction, `${heading}\n${lines.join("\n")}`);
}

/**
 * /gork memory forget <id>: delete one memory by its `#id` handle.
 * Guild-scoped — a miss never hints whether the id exists elsewhere.
 */
async function forgetMemory(client, interaction, guildId) {
  const rawId = interaction.options.getInteger("id");
  if (!Number.isInteger(rawId) || rawId <= 0) {
    return replyEphemeral(
      interaction,
      "`id` must be a positive whole number — the `#id` handle from `/gork memory show`.",
    );
  }
  const row = gorkMemoryGetById(guildId, rawId);
  if (!row) {
    return replyEphemeral(interaction, `No memory #${rawId} in this guild.`);
  }
  gorkMemoryDeleteById(guildId, rawId);
  await logConfigChange(client, guildId, {
    title: "Gork memory forgotten",
    command: "/gork memory",
    actor: interaction.user,
    changes: [
      `Forgot memory #${row.id}: \`${row.title}\` (about <@${row.subject_user_id}>)`,
    ],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    `Forgot memory **#${row.id}** — \`${row.title}\` (about <@${row.subject_user_id}>).`,
  );
}

/**
 * /gork memory clear [user]: wipe one person's (with `user`) or the whole
 * guild's memories. Confirm-once: without `confirm: true` this only shows
 * the damage preview.
 */
async function clearMemory(client, interaction, guildId) {
  const target = interaction.options.getUser("user");
  const confirmed = interaction.options.getBoolean("confirm") === true;
  const scope = target
    ? {
        count: gorkMemoryListForSubject(guildId, target.id).length,
        subject: target,
        noun: `memories for <@${target.id}>`,
        run: () => gorkMemoryDeleteForSubject(guildId, target.id),
      }
    : {
        count: gorkMemoryCountForGuild(guildId),
        subject: null,
        noun: "memories across this server",
        run: () => gorkMemoryDeleteForGuild(guildId),
      };

  if (scope.count === 0) {
    return replyEphemeral(
      interaction,
      target
        ? `No memories stored for <@${target.id}> — nothing to erase.`
        : "No memories stored in this server — nothing to erase.",
    );
  }
  if (!confirmed) {
    return replyEphemeral(
      interaction,
      `This will erase **${scope.count}** ${scope.noun}. Re-run with \`confirm: true\` to actually erase.`,
    );
  }

  const deleted = scope.run();
  await logConfigChange(client, guildId, {
    title: "Gork memory cleared",
    command: "/gork memory",
    actor: interaction.user,
    changes: [
      target
        ? `Erased ${deleted} memories for <@${target.id}> (\`${target.id}\`)`
        : `Erased ${deleted} memories (whole guild)`,
    ],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    `Erased **${deleted}** ${scope.noun}.`,
  );
}

/**
 * /gork memory on|off: master switch for community memory (default off —
 * every answered question costs an extra extraction LLM call).
 */
async function setMemoryEnabled(client, interaction, guildId, action) {
  const settings = updateGuildSettings(guildId, {
    gork_memory_enabled: action === "on" ? 1 : 0,
  });
  const on = Number(settings.gork_memory_enabled) === 1;
  await logConfigChange(client, guildId, {
    title: `Gork memory ${on ? "enabled" : "disabled"}`,
    command: "/gork memory",
    actor: interaction.user,
    changes: [`Memory: ${on ? "on" : "off"}`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    on
      ? "Gork memory is now **on** — gork extracts durable facts about people after each answer and remembers them. Turn it off again with `/gork memory off`."
      : "Gork memory is now **off** — nothing new is stored and no memory block is injected. Stored memories stay until staff erase them (`/gork memory show` / `forget` / `clear`).",
  );
}

/**
 * /gork log <enabled>: per-guild switch for the interaction log (E2E
 * capture). ON stores one gork_interactions row per agent call (exact
 * prompts, transcript, outcome) for replay/debug; rows age out on the
 * env-configured retention window. Mirrors the memory toggle's shape.
 */
async function setInteractionLog(client, interaction, guildId) {
  const enabled = interaction.options.getBoolean("enabled") === true;
  let settings;
  try {
    settings = updateGuildSettings(guildId, {
      gork_interaction_log_enabled: enabled ? 1 : 0,
    });
  } catch (err) {
    // Surface the specific cause (AGENTS.md): never a bare generic failure.
    return replyEphemeral(
      interaction,
      `Could not update the interaction log setting: ${err?.message || err}`,
    );
  }
  const on = Number(settings.gork_interaction_log_enabled ?? 1) === 1;
  await logConfigChange(client, guildId, {
    title: `Gork interaction log ${on ? "enabled" : "disabled"}`,
    command: "/gork log",
    actor: interaction.user,
    changes: [`Interaction log: ${on ? "on" : "off"}`],
  }).catch(() => {});
  const rows = countGorkInteractions(guildId);
  await replyEphemeral(
    interaction,
    on
      ? `Gork interaction log is now **on** — every gork agent call in this server is recorded (\`${rows}\` row${rows === 1 ? "" : "s"} stored so far).`
      : `Gork interaction log is now **off** — agent calls are no longer recorded (\`${rows}\` row${rows === 1 ? "" : "s"} remain; they age out with retention).`,
  );
}

/**
 * /gork memory budget <chars>: cap for the injected memory block
 * (0–64,000; 0 = unlimited; garbage → default 12,000).
 */
async function setMemoryBudget(client, interaction, guildId) {
  const raw = interaction.options.getInteger("chars");
  if (raw === null) {
    return replyEphemeral(
      interaction,
      "Provide `chars` — the memory-block budget in characters (0–64000; 0 = unlimited).",
    );
  }
  // Lazy require: the memory module owns the clamp, and the command surface
  // must load fine without it (same pattern as the trigger's memory hooks).
  const { clampMemoryChars } = require("./memory");
  const value = clampMemoryChars(raw);
  const settings = updateGuildSettings(guildId, {
    gork_memory_chars: value,
  });
  const stored = Number(settings.gork_memory_chars);
  await logConfigChange(client, guildId, {
    title: "Gork memory budget updated",
    command: "/gork memory",
    actor: interaction.user,
    changes: [`Memory budget: ${stored} chars${stored === 0 ? " (unlimited)" : ""}`],
  }).catch(() => {});
  await replyEphemeral(
    interaction,
    stored === 0
      ? "Gork memory budget set to **0** — the memory block is **unlimited** (0 = unlimited)."
      : `Gork memory budget set to **${stored}** chars. \`0\` = unlimited.`,
  );
}

/**
 * /gork memory dispatcher (action option → verb).
 */
async function handleMemory(client, interaction, guildId) {
  const action = (interaction.options.getString("action") || "").toLowerCase();
  switch (action) {
    case "show":
      return showMemory(interaction, guildId);
    case "forget":
      return forgetMemory(client, interaction, guildId);
    case "clear":
      return clearMemory(client, interaction, guildId);
    case "on":
    case "off":
      return setMemoryEnabled(client, interaction, guildId, action);
    case "budget":
      return setMemoryBudget(client, interaction, guildId);
    default:
      return replyEphemeral(
        interaction,
        `Unknown memory action: \`${action}\`.`,
      );
  }
}

/**
 * `/gork budget default <limit>`: guild-default tri-state limit
 * (-1 blocked, 0 unlimited, 1–1000 successful answers per user per UTC
 * day; clamped by the settings layer — roadmap §7.17.2).
 */
async function setBudgetDefault(client, interaction, guildId) {
  const limit = interaction.options.getInteger("limit");
  if (limit === null) {
    return replyEphemeral(
      interaction,
      `Provide \`limit\`: \`-1\` blocked · \`0\` unlimited · \`1–${BUDGET_MAX}\` successful answers per user per UTC day.`,
    );
  }
  const settings = updateGuildSettings(guildId, { gork_daily_limit: limit });
  const stored = settings.gork_daily_limit;
  await logConfigChange(client, guildId, {
    title: "Gork budget default updated",
    command: "/gork budget",
    actor: interaction.user,
    changes: [`Guild-default daily budget: ${formatDailyLimit(stored)} (\`${stored}\`)`],
  }).catch(() => {});
  return replyEphemeral(
    interaction,
    `Guild-default daily budget set to **${formatDailyLimit(stored)}** (\`${stored}\`).`,
  );
}

/**
 * `/gork budget channel|category <target> <limit>`: add/replace a per-scope
 * rule. The most specific scope wins (channel → category → guild default);
 * a category rule pools every channel inside it (decision 30).
 */
async function setBudgetScope(client, interaction, guildId, scopeKind) {
  const limit = interaction.options.getInteger("limit");
  if (limit === null) {
    return replyEphemeral(
      interaction,
      `Provide \`limit\`: \`-1\` blocked · \`0\` unlimited · \`1–${BUDGET_MAX}\` successful answers per user per UTC day.`,
    );
  }
  const target = interaction.options.getChannel("target");
  if (!target?.id) {
    return replyEphemeral(
      interaction,
      `Pick the ${scopeKind} in \`target\` (or use \`/gork budget default\` for the guild-wide limit).`,
    );
  }
  // Guard the picker against kind mismatches: a category rule on a text
  // channel id (or vice versa) could never match a trigger — reject rather
  // than store a dead rule.
  const isCategory = Number(target.type) === ChannelType.GuildCategory;
  if (scopeKind === "category" && !isCategory) {
    return replyEphemeral(
      interaction,
      "`target` must be a **category** for `category` rules (a rule on a text channel belongs to `channel`).",
    );
  }
  if (scopeKind === "channel" && isCategory) {
    return replyEphemeral(
      interaction,
      "`target` must be a **channel/thread** for `channel` rules (use `category` for categories).",
    );
  }
  // Threads bind their PARENT channel (mirrors the trigger-side resolution
  // in budget.js `channelScopeIdFor`): a rule stored on a thread id could
  // never match (thread triggers resolve to the parent), so normalize here
  // instead of leaving a silent dead rule.
  const isThread = isThreadLike(target);
  let targetId = String(target.id);
  let boundToThreadParent = false;
  if (scopeKind === "channel" && isThread) {
    if (!target.parent?.id) {
      return replyEphemeral(
        interaction,
        "Could not resolve that thread's parent channel — pick the parent channel directly instead.",
      );
    }
    targetId = String(target.parent.id);
    boundToThreadParent = true;
  }
  const stored = clampGorkDailyLimit(limit);
  if (!upsertGorkBudgetRule(guildId, scopeKind, targetId, stored, interaction.user.id)) {
    return replyEphemeral(
      interaction,
      `Could not store the ${scopeKind} rule for \`${targetId}\` — invalid target.`,
    );
  }
  await logConfigChange(client, guildId, {
    title: `Gork budget ${scopeKind} rule updated`,
    command: "/gork budget",
    actor: interaction.user,
    changes: [
      `${scopeKind} ${target.name || targetId} (\`${targetId}\`): ${formatDailyLimit(stored)} (\`${stored}\`)${
        boundToThreadParent ? " — bound from thread target to its parent channel" : ""
      }`,
    ],
  }).catch(() => {});
  // Categories don't render as <#id> mentions on Discord — backtick them
  // (same convention as `/gork budget list` and the remove replies).
  const ref = scopeKind === "channel" ? `<#${targetId}>` : `\`${target.id}\` (\`${target.name ?? targetId}\`)`;
  const threadNote = boundToThreadParent
    ? " — thread target bound to its **parent channel** (threads share their parent's rule)"
    : "";
  return replyEphemeral(
    interaction,
    `Daily gork budget for ${scopeKind} ${ref} is now **${formatDailyLimit(stored)}** (\`${stored}\`)${threadNote}.`,
  );
}

/**
 * `/gork budget remove_channel|remove_category <id>`: drop a rule so the
 * scope falls back to category → guild default. Accepts the picker or a raw
 * id (deleted channels the picker cannot offer).
 */
async function removeBudgetScope(client, interaction, guildId, scopeKind) {
  const target = interaction.options.getChannel("target");
  const rawId = (interaction.options.getString("id") || "").trim();
  let targetId = target?.id ? String(target.id) : rawId;
  if (!targetId) {
    return replyEphemeral(
      interaction,
      `Pick \`target\` or type the raw \`id\` of the ${scopeKind} rule to remove.`,
    );
  }
  // Mirror the set-side normalization: thread targets address the PARENT
  // channel's rule (thread-id rules are never stored, so deleting by thread
  // id would falsely report "no rule").
  if (scopeKind === "channel" && target) {
    if (isThreadLike(target)) {
      if (!target.parent?.id) {
        return replyEphemeral(
          interaction,
          "Could not resolve that thread's parent channel — remove the rule by the parent channel or its raw `id`.",
        );
      }
      targetId = String(target.parent.id);
    }
  }
  const removed = deleteGorkBudgetRule(guildId, scopeKind, targetId);
  if (!removed) {
    return replyEphemeral(
      interaction,
      `No \`${scopeKind}\` budget rule for \`${targetId}\` in this server.`,
    );
  }
  await logConfigChange(client, guildId, {
    title: `Gork budget ${scopeKind} rule removed`,
    command: "/gork budget",
    actor: interaction.user,
    changes: [`Removed ${scopeKind} budget rule \`${targetId}\``],
  }).catch(() => {});
  const ref = scopeKind === "channel" ? `<#${targetId}>` : `\`${targetId}\``;
  const fallback = scopeKind === "channel" ? "its category → the guild default" : "the guild default";
  return replyEphemeral(
    interaction,
    `Removed the ${scopeKind} budget rule for ${ref} — it falls back to ${fallback}.`,
  );
}

/**
 * `/gork budget list`: guild default + every rule with `created_by`
 * provenance (decision 37).
 */
async function listBudget(interaction, guildId) {
  const settings = getGuildSettings(guildId);
  const rules = listGorkBudgetRules(guildId);
  const lines = rules.slice(0, BUDGET_RULES_LIST_MAX).map((r) => {
    const ref = r.scope_kind === "channel" ? `<#${r.target_id}>` : `\`${r.target_id}\``;
    const by = r.created_by ? ` · by <@${r.created_by}>` : "";
    return `${r.scope_kind === "channel" ? "Channel" : "Category"} ${ref} — **${formatDailyLimit(r.daily_limit)}**${by}`;
  });
  if (rules.length > lines.length) {
    lines.push(`…and ${rules.length - lines.length} more`);
  }
  const embed = baseEmbed({
    color: Color.brand,
    title: "Gork daily budgets",
    timestamp: true,
  });
  embed.addFields(
    {
      name: "Guild default",
      value: formatDailyLimit(settings.gork_daily_limit ?? 0),
      inline: true,
    },
    {
      name: "Rules",
      value: lines.length
        ? lines.join("\n")
        : "none — the guild default applies everywhere",
      inline: false,
    },
  );
  await replyEphemeral(interaction, { embeds: [embed] });
}

/**
 * /gork budget dispatcher (action option → verb).
 */
async function handleBudget(client, interaction, guildId) {
  const action = (interaction.options.getString("action") || "").toLowerCase();
  switch (action) {
    case "default":
      return setBudgetDefault(client, interaction, guildId);
    case "channel":
    case "category":
      return setBudgetScope(client, interaction, guildId, action);
    case "remove_channel":
      return removeBudgetScope(client, interaction, guildId, "channel");
    case "remove_category":
      return removeBudgetScope(client, interaction, guildId, "category");
    case "list":
      return listBudget(interaction, guildId);
    default:
      return replyEphemeral(
        interaction,
        `Unknown budget action: \`${action}\`.`,
      );
  }
}

/**
 * /gork status: ephemeral embed of the current configuration.
 */
async function showStatus(interaction, guildId) {
  const settings = getGuildSettings(guildId);
  const enabled = Number(settings.gork_enabled ?? 1) === 1;
  const keyword = (settings.gork_keyword || "").trim();
  const rules = (settings.gork_extra_rules || "").trim();
  const searchOn = Number(settings.gork_search_enabled) === 1;
  const cooldownSec = settings.gork_cooldown_sec;
  const banCount = listGorkBlocks(guildId).length;
  const memoryOn = Number(settings.gork_memory_enabled ?? 0) === 1;
  const memoryCount = gorkMemoryCountForGuild(guildId);
  const interactionLogOn =
    Number(settings.gork_interaction_log_enabled ?? 1) === 1;
  const interactionLogRows = countGorkInteractions(guildId);
  const budgetRules = listGorkBudgetRules(guildId);
  const ai = getAiConfig();
  const searxngSet = Boolean(
    typeof process.env.SEARXNG_URL === "string" && process.env.SEARXNG_URL.trim(),
  );

  const embed = baseEmbed({ color: Color.brand, title: "Gork status", timestamp: true });
  embed.addFields(
    { name: "Enabled", value: enabled ? "on" : "**off** (server disabled)", inline: true },
    { name: "Keyword", value: keyword ? `\`${keyword}\`` : "disabled", inline: true },
    { name: "Context window", value: `${settings.gork_context_window} messages`, inline: true },
    {
      name: "Cooldown",
      value: `${cooldownSec}s per user (staff bypass)`,
      inline: true,
    },
    { name: "Rules", value: rules || "none", inline: true },
    { name: "Search (SearXNG)", value: searchOn ? "on" : "off", inline: true },
    {
      name: "AI provider",
      value: ai.apiKey ? "configured" : "**not configured**",
      inline: true,
    },
    { name: "SearXNG URL", value: searxngSet ? "set" : "not set", inline: true },
    { name: "Banned users", value: String(banCount), inline: true },
    {
      name: "Memory",
      value: memoryOn
        ? `on · ${Number(settings.gork_memory_chars ?? 12000)} chars · ${memoryCount} stored`
        : "off",
      inline: true,
    },
    {
      // E2E capture switch; the count is every row stored for this guild.
      name: "Interaction Log",
      value: interactionLogOn ? `On (${interactionLogRows} rows)` : "Off",
      inline: true,
    },
    {
      // §7.17.7: `default 5 · 3 rules` (tri-state rendered via formatDailyLimit).
      name: "Budget",
      value: `default ${formatDailyLimit(settings.gork_daily_limit ?? 0)} · ${budgetRules.length} rule${
        budgetRules.length === 1 ? "" : "s"
      }`,
      inline: true,
    },
  );
  await replyEphemeral(interaction, { embeds: [embed] });
}

/* ---------------------- /gork summarize (§7.21) ---------------------- */

/** Guild-cooldown window in whole minutes (constant is minutes-exact). */
const SUMMARIZE_WINDOW_MINUTES = Math.max(
  1,
  Math.round(GORK_SUMMARIZE_GUILD_COOLDOWN_MS / 60000),
);

/** UTC day key (YYYY-MM-DD) for the invoker's daily budget (§7.17). */
function summarizeBudgetDay() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The `channel:` option is a channel PICKER (object) on the slash surface;
 * the range reader wants its id string (bare ids parse fine — decision 54).
 */
function summarizeChannelArg(interaction) {
  const raw = interaction.options.getChannel("channel");
  if (raw == null) return null;
  const id =
    typeof raw === "string"
      ? raw.trim()
      : raw?.id != null
        ? String(raw.id)
        : String(raw).trim();
  return id || null;
}

/**
 * Post the rendered payloads IN ORDER, one embed per message, every payload
 * already carrying `allowedMentions: NO_PING_MENTIONS` (buildRundownPayloads).
 * All-chunks-land semantics (decision 32): the caller bookkeeps success ONLY
 * when `ok:true`; a mid-sequence failure reports exactly how many landed and
 * the cause (repo partial-results rule — the poster arms nothing, counts
 * nothing). The first payload resolves the deferred interaction (editReply),
 * continuations follow as channel messages (followUp).
 *
 * @returns {Promise<{ ok: boolean, posted: object[], error?: string }>}
 */
async function postRundownPayloads(interaction, payloads) {
  const posted = [];
  try {
    for (let i = 0; i < payloads.length; i += 1) {
      const msg =
        i === 0
          ? await interaction.editReply(payloads[i])
          : await interaction.followUp(payloads[i]);
      posted.push(msg ?? {});
    }
    return { ok: true, posted };
  } catch (err) {
    return { ok: false, posted, error: err?.message || String(err) };
  }
}

/**
 * Compact failure-audit call (the audit variant never throws; the wrapper is
 * belt-and-suspenders so an audit can never derail the reply path).
 */
async function summarizeFailureAudit(client, guildId, base, reason) {
  try {
    await logGorkSummarizeFailure(client, guildId, { ...base, reason });
  } catch (err) {
    console.error(
      `[gork] summarize failure audit threw in ${guildId}:`,
      err?.message || err,
    );
  }
}

/**
 * The queued job body (roadmap §7.21.5, decision 34): dequeue-time budget
 * re-check → range read → one-shot generation → embed post → success
 * bookkeeping. Runs INSIDE the shared per-guild gork queue slot; every
 * branch replies with its specific cause (AGENTS.md) and bookkeeps success
 * (cooldown arm + budget count) ONLY when every embed landed. Never throws.
 */
async function runSummarizeJob({
  client,
  interaction,
  guildId,
  userId,
  day,
  opts,
  mode,
  settings,
}) {
  const guild = interaction.guild;
  const startedAt = Date.now();
  const channelBase = {
    user: interaction.user,
    channelId: interaction.channelId,
    channelLabel: formatChannelLabel(interaction.channel),
  };

  // §7.17.4 dequeue re-check (mirrors trigger.js): queued work can arrive
  // after the budget spent itself — bounce WITHOUT the LLM call, WITHOUT a
  // count, and WITHOUT arming the guild cooldown.
  const budgetChannel = interaction.channel ?? { id: interaction.channelId };
  const gate = checkGorkBudget({ guildId, userId, channel: budgetChannel, day });
  if (!gate.allowed) {
    if (gate.kind === "error") {
      console.error(
        `[gork] summarize budget gate error at dequeue in ${guildId}: user=${userId} day=${day} — failing closed`,
      );
      return interaction.editReply(
        "Could not re-check your gork daily budget when the rundown job started (database error, logged) — nothing was generated or counted.",
      );
    }
    console.log(
      `[gork] summarize budget ${gate.kind} at dequeue in ${guildId}: user=${userId} scope=${
        gate.scope ? `${gate.scope.scopeKind}/${gate.scope.scopeId}` : "?"
      } day=${day} — bounced, no LLM call`,
    );
    return interaction.editReply(gate.reply);
  }

  // Range read (§7.21.2). A bare anchor / `last:` defaults to the channel
  // the command ran in.
  const read = await readSummarizeRange(
    { from: opts.from, to: opts.to, last: opts.last, channel: opts.channel },
    {
      guildId,
      guild,
      invokerId: userId,
      fallbackChannelId: interaction.channelId,
    },
  );
  if (!read.ok) {
    console.error(
      `[gork] summarize read failed in ${guildId}: user=${userId} channel=${interaction.channelId} mode=${mode.mode} cmd=/gork summarize code=${read.code} — ${read.error}`,
    );
    await summarizeFailureAudit(client, guildId, channelBase, `range read failed (${read.code}): ${read.error}`);
    let text = read.error;
    if (read.code === "fetch" && read.partial) {
      // Partial-results rule (repo standard): disclose the window that WAS
      // read and why no rundown came out of it.
      text += `\nPartial window actually read: **${read.partial.count}** message(s) (${read.partial.firstId} → ${read.partial.lastId}) — discarded; the rundown needs the complete range, so nothing was produced or counted.`;
    }
    return interaction.editReply(text);
  }

  // Interaction log (migration 027, §7.21.5): one summarize row per agent
  // call, built right before the call so onEvent captures the exact wire
  // payload (decision 9's quote discipline is auditable byte-for-byte).
  // null = logging off / build failure — creation may never alter the reply
  // path, and finalize is idempotent on EVERY terminal path below.
  let recorder = null;
  try {
    recorder = createSummarizeInteractionRecorder({
      settings,
      guildId,
      channelId: interaction.channelId,
      interactionId: interaction.id ?? null,
      userId,
      mode: read.mode,
      lastCount: read.requestedLast,
      range: {
        channelId: read.channelId,
        firstMessageId: read.firstId,
        lastMessageId: read.lastId,
        collected: read.count,
        clamped: read.clamped,
      },
      focus: opts.focus,
      lang: opts.lang,
      model: getAiConfig().model,
      params: {
        temperature: SUMMARIZE_TEMPERATURE,
        maxTokens: SUMMARIZE_MAX_TOKENS,
      },
      tools: null, // no tool loop (decision 55)
      startedAt,
    });
  } catch (err) {
    console.warn(
      `[gork] summarize interaction log recorder build failed in ${guildId}:`,
      err?.message || err,
    );
    recorder = null;
  }

  // Generation (§7.21.3): one-shot, dedicated card, queue/budget-blind.
  const gen = await generateSummarize(read, {
    guildId,
    guild,
    client,
    focus: opts.focus,
    lang: opts.lang,
    ...(recorder ? { onEvent: (evt) => recorder.onEvent(evt) } : {}),
  });
  if (!gen.ok) {
    console.error(
      `[gork] summarize generation failed in ${guildId}: user=${userId} mode=${read.mode} cmd=/gork summarize code=${gen.code} — ${gen.error}`,
    );
    recorder?.finalize({
      status: "failure",
      error: gen.error,
      durationMs: Date.now() - startedAt,
    });
    await summarizeFailureAudit(client, guildId, channelBase, `generation failed (${gen.code}): ${gen.error}`);
    return interaction.editReply(
      `${gen.error}\nNothing was posted, no cooldown was armed, and your budget was not counted — you can retry.`,
    );
  }

  // Render + post (§7.21.4). More than one embed is the emergency
  // continuation path (model overflowed the one-embed budget) — log it.
  const embeds = renderSummarizeEmbeds(gen.text, {
    guildId,
    mode: read.mode,
    range: {
      firstId: read.firstId,
      lastId: read.lastId,
      channelId: read.channelId,
    },
    invoker: interaction.user,
    // Reader's clamp wording verbatim — decision 54's disclosed window.
    ...(read.clampNote ? { disclosure: read.clampNote } : {}),
    timestamp: true,
  });
  if (embeds.length > 1) {
    console.log(
      `[gork] summarize overflow in ${guildId}: user=${userId} ${embeds.length} continuation embeds (model exceeded the one-embed budget)`,
    );
  }
  const payloads = buildRundownPayloads(embeds).map((payload, i) =>
    // §7.21.2: the disclosed window repeats as the reply text itself, not
    // only inside the embed's "Disclosed window" field.
    i === 0 && read.clampNote ? { ...payload, content: read.clampNote } : payload,
  );
  const post = await postRundownPayloads(interaction, payloads);
  if (!post.ok) {
    console.error(
      `[gork] summarize embed post failed in ${guildId}: user=${userId} mode=${read.mode} cmd=/gork summarize — posted ${post.posted.length}/${payloads.length}: ${post.error}`,
    );
    recorder?.finalize({
      status: "error",
      error: `embed post failed after ${post.posted.length}/${payloads.length} embeds: ${post.error}`,
      answerShipped: gen.text,
      durationMs: Date.now() - startedAt,
    });
    await summarizeFailureAudit(
      client,
      guildId,
      channelBase,
      `embed post failed after ${post.posted.length}/${payloads.length}: ${post.error}`,
    );
    // Report posted count + cause; arm nothing, count nothing (decision 32).
    const note = `⚠️ Could not finish posting the rundown: ${post.error} — **${post.posted.length}** of ${payloads.length} embed${payloads.length === 1 ? "" : "s"} landed. No cooldown was armed and your budget was not counted; you can retry.`;
    try {
      await interaction.followUp({ content: note, allowedMentions: NO_PING_MENTIONS });
    } catch (reportErr) {
      console.error(
        `[gork] summarize post-failure followUp failed in ${guildId}:`,
        reportErr?.message || reportErr,
      );
      await interaction.channel
        ?.send({ content: note, allowedMentions: NO_PING_MENTIONS })
        .catch(() => {});
    }
    return undefined;
  }

  // ---- Full success (every embed landed): arm, count, record, audit ----

  // Decision 57: the guild cooldown arms the moment the rundown lands —
  // and NOWHERE else (usage/empty/security/fetch/generation failures never
  // lock the guild out of an immediate retry).
  armSummarizeGuildCooldown(guildId);

  // Decision 32: count the invoker's daily budget exactly once, only now.
  // A failed increment is logged, not fatal (the rundown already shipped).
  try {
    recordGorkBudgetUsage({ guildId, userId, scope: gate.scope, day });
  } catch (err) {
    console.error(
      `[gork] summarize budget increment failed in ${guildId}:`,
      err?.message || err,
    );
  }

  recorder?.finalize({
    status: "shipped",
    answerShipped: gen.text,
    finishReason: gen.meta?.finishReason ?? null,
    usage: gen.meta?.usage ?? null,
    toolCallCount: 0,
    durationMs:
      gen.meta?.durationMs ?? Date.now() - startedAt,
  });

  const readChannel = guild?.channels?.cache?.get(read.channelId) ?? null;
  await logGorkSummarize(client, guildId, {
    user: interaction.user,
    mode: read.mode,
    lastCount: read.requestedLast,
    channelLabel: formatChannelLabel(readChannel) || undefined,
    channelId: read.channelId,
    firstMessage: read.firstId,
    lastMessage: read.lastId,
    messageCount: read.count,
    focus: opts.focus,
    lang: opts.lang,
    model: gen.meta?.model ?? null,
    durationMs: gen.meta?.durationMs ?? null,
    rundown: gen.text,
    replyMessage: post.posted[0] ?? null,
    outcome:
      payloads.length > 1
        ? `posted (${payloads.length} embeds — output overflow)`
        : "posted",
  }).catch((err) =>
    console.error(
      `[gork] summarize audit failed in ${guildId}:`,
      err?.message || err,
    ),
  );
  return undefined;
}

/**
 * /gork summarize body — gate order per §7.21.5 / subtask 08:
 * mode gate → guild cooldown → budget (enqueue) → defer → shared queue slot
 * → (dequeue re-check) → read → generate → post → success bookkeeping.
 */
async function summarizeMain(client, interaction, guildId) {
  const userId = interaction.user?.id ?? null;
  const opts = {
    from: (interaction.options.getString("from") || "").trim() || null,
    to: (interaction.options.getString("to") || "").trim() || null,
    last: interaction.options.getInteger("last"),
    channel: summarizeChannelArg(interaction),
    focus: (interaction.options.getString("focus") || "").trim() || null,
    lang: (interaction.options.getString("lang") || "").trim() || null,
  };

  // 1. Mode exclusivity (decision 53) BEFORE deferring: invalid combos get
  //    an instant EPHEMERAL usage error quoting the reader's own sentence
  //    naming the three modes (identical strings, one source of truth).
  const mode = validateSummarizeMode({
    from: opts.from,
    to: opts.to,
    last: opts.last,
  });
  if (!mode.ok) {
    console.log(
      `[gork] summarize usage error in ${guildId}: user=${userId} cmd=/gork summarize — ${mode.error}`,
    );
    return replyEphemeral(interaction, mode.error);
  }

  // 2. Per-guild summarize cooldown (§7.21.5, decision 57): while armed,
  //    whole minutes remaining — the range is NOT read, nothing generates.
  const cooldownMs = checkSummarizeGuildCooldown(guildId);
  if (cooldownMs > 0) {
    const mins = summarizeCooldownMinutesRemaining(cooldownMs);
    console.log(
      `[gork] summarize guild cooldown hit in ${guildId}: user=${userId} mode=${mode.mode} cmd=/gork summarize remainingMin=${mins} — rejected without read or LLM call`,
    );
    return replyEphemeral(
      interaction,
      `One rundown per server per ${SUMMARIZE_WINDOW_MINUTES} minutes — this server already posted one. Try again in **${mins} minute${mins === 1 ? "" : "s"}**. Nothing was read or generated.`,
    );
  }

  // 3. Daily budget at enqueue (§7.17, decisions 33/35): same gate, same
  //    locked reply, same 1×/user/scope/hour throttle as the Q&A trigger —
  //    staff are NOT exempt. One UTC day key for the whole invocation.
  const day = summarizeBudgetDay();
  const budgetChannel = interaction.channel ?? { id: interaction.channelId };
  const budgetGate = checkGorkBudget({ guildId, userId, channel: budgetChannel, day });
  if (!budgetGate.allowed) {
    if (budgetGate.kind === "error") {
      // checkGorkBudget already console.error'd the DB cause. Fail CLOSED.
      // (The keyword path answers this with the locked "brain went to
      // lunch" mask — that disguise exists only to hide bans from the
      // trigger UX; a staff-invoked rundown carries the real cause.)
      console.error(
        `[gork] summarize budget gate error in ${guildId}: user=${userId} day=${day} cmd=/gork summarize — failing closed`,
      );
      return replyEphemeral(
        interaction,
        "Could not check your gork daily budget — the server's daily-limit settings lookup failed (logged). Nothing was read or generated; try again in a moment.",
      );
    }
    console.log(
      `[gork] summarize budget ${budgetGate.kind} in ${guildId}: user=${userId} scope=${
        budgetGate.scope ? `${budgetGate.scope.scopeKind}/${budgetGate.scope.scopeId}` : "?"
      } day=${day}`,
    );
    if (shouldSendBudgetRejection({ guildId, userId, scope: budgetGate.scope })) {
      return replyEphemeral(interaction, budgetGate.reply);
    }
    // Throttled (decision 34): the full rejection already went out this
    // hour — resolve the command with a terse echo; never leave the
    // invoker staring at nothing.
    return replyEphemeral(
      interaction,
      budgetGate.kind === "blocked"
        ? "gork is blocked for this channel/category/server scope (see the full notice you already received) — the rundown did not run."
        : "You are still over your daily gork budget (full notice above from the last attempt) — it resets 00:00 UTC.",
    );
  }

  // 4. Deferred BEFORE any range read or generation (reads paginate up to
  //    1,000 messages; generation runs to a 60s deadline).
  await interaction.deferReply();

  const settings = getGuildSettings(guildId);

  // 5. The job runs on the SHARED per-guild gork queue (decision 34) — a
  //    rundown never stampedes a Q&A answer. runExclusive admits, waits the
  //    FIFO turn, runs the body, and releases exactly once in a finally; a
  //    rejecting body resolves to {error} — the slot (and the login) always
  //    survive.
  const slot = await gorkQueue.runExclusive(guildId, () =>
    runSummarizeJob({
      client,
      interaction,
      guildId,
      userId,
      day,
      opts,
      mode,
      settings,
    }),
  );

  if (slot.dropped) {
    // Queue full: locked gork voice + the explicit nothing-ran clause.
    console.log(
      `[gork] summarize queue full in ${guildId}: user=${userId} mode=${mode.mode} cmd=/gork summarize — dropped, nothing was read or generated`,
    );
    return interaction.editReply(
      `${QUEUE_FULL_REPLY} Nothing was read or generated for this rundown.`,
    );
  }
  if (slot.error) {
    // runSummarizeJob holds its own net; this guards against a silent drop
    // if that contract is ever broken (AGENTS.md: never a silent failure).
    console.error(
      `[gork] summarize queue job threw in ${guildId}: user=${userId} mode=${mode.mode} cmd=/gork summarize:`,
      slot.error?.message || slot.error,
    );
    return interaction.editReply(
      `The rundown job crashed: ${slot.error?.message || slot.error} — no cooldown was armed and no budget was counted.`,
    );
  }
  return undefined;
}

/**
 * /gork summarize: staff conversation rundown (roadmap/gork.md §7.21,
 * decisions 53–57). Dispatcher (index.js) already gated requireStaff. The
 * rundown is a themed embed posted to the invoking channel; usage errors,
 * cooldown/budget bounces, and every failure branch reply with the specific
 * cause. Success bookkeeping (guild cooldown arm + one budget unit + audit +
 * interaction-log row) happens ONLY when every embed landed.
 */
async function handleSummarize(client, interaction, guildId) {
  try {
    return await summarizeMain(client, interaction, guildId);
  } catch (err) {
    // Last-resort net for a bug in the paths above: logged with ids and
    // surfaced verbatim — never a silent deferred spinner (AGENTS.md).
    console.error(
      `[gork] summarize crashed in ${guildId}: user=${interaction.user?.id ?? "?"} cmd=/gork summarize id=${interaction.id ?? "-"}`,
      err?.message || err,
    );
    const text = `Could not run /gork summarize: ${err?.message || err}`;
    if (interaction.deferred || interaction.replied) {
      return editEphemeral(interaction, text).catch(() => {});
    }
    return replyEphemeral(interaction, text).catch(() => {});
  }
}

module.exports = {
  setKeyword,
  setContext,
  setCooldown,
  setRules,
  setSearch,
  setEnable,
  banUser,
  unbanUser,
  showBans,
  handleMemory,
  handleBudget,
  setInteractionLog,
  showStatus,
  handleSummarize,
  /** TEST SEAM: ordered rundown poster with all-chunks-land accounting. */
  postRundownPayloads,
};
