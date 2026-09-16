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
const { replyEphemeral } = require("../../core/interaction");
const { Color, baseEmbed } = require("../../core/theme");
const { sliceSafe } = require("../../core/text");
const { getAiConfig } = require("../../core/ai");
const { logConfigChange } = require("../logs/auditLog");
const { formatDailyLimit } = require("./budget");
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
  const isThread =
    typeof target.isThread === "function"
      ? Boolean(target.isThread())
      : [10, 11, 12].includes(Number(target.type));
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
    const isThread =
      typeof target.isThread === "function"
        ? Boolean(target.isThread())
        : [10, 11, 12].includes(Number(target.type));
    if (isThread) {
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
};
