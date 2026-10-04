/**
 * /gork subcommand handlers (staff). Dispatcher lives in index.js.
 *
 * Migrated to the CommandContext seam (roadmap/fluxer.md § CommandContext):
 * every exported handler receives a CommandContext and speaks only the
 * platform-neutral vocabulary — `communityId` (integer) for repositories,
 * `externalGuildId` for display/audit, `options.getX` for options, `reply`
 * with `sensitive: true` for ephemerals, and `outbound` for platform I/O.
 * The one Discord-only capability the seam cannot model (/gork summarize's
 * deep guild/client plumbing) uses the documented `rawInteraction` escape
 * hatch, guarded for Fluxer.
 */
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
const { Color } = require("../../core/theme");
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
  GORK_SUMMARIZE_INPUT_TOKENS_DEFAULT,
  GORK_SUMMARIZE_INPUT_TOKENS_MIN,
  GORK_SUMMARIZE_INPUT_TOKENS_MAX,
  clampSummarizeInputTokens,
} = require("./constants");

/**
 * ChannelType.GuildCategory as a plain number (roadmap § Outbound client:
 * ChannelHandle.type is a numeric channel type — same duck-typed idiom as
 * budget.js CATEGORY_TYPE, keeping discord.js out of this module).
 */
const CATEGORY_TYPE = 4;

/**
 * Standard reply for Fluxer dispatches reaching Discord-only surfaces
 * (roadmap/fluxer.md § What stays Discord-only): /gork summarize's range
 * reader, generator, and audit poster take real discord.js Guild/Client
 * objects until the OutboundClient cutover in PR 7.
 */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";

/**
 * /gork keyword: set the trigger keyword, or `clear` to disable gork.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setKeyword(commandCtx) {
  const communityId = commandCtx.communityId;
  const raw = (commandCtx.options.getString("keyword") || "").trim();
  const clearing = raw === "clear";
  if (!clearing && (!raw || raw.length > KEYWORD_MAX)) {
    return commandCtx.reply({
      content: `The keyword must be 1-${KEYWORD_MAX} characters (or \`clear\` to disable gork).`,
      sensitive: true,
    });
  }
  const settings = updateGuildSettings(communityId, {
    gork_keyword: clearing ? null : raw,
  });
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.keyword_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { keyword: settings.gork_keyword ?? null, cleared: clearing },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: clearing ? "Gork disabled" : "Gork keyword updated",
    command: "/gork keyword",
    actor: commandCtx.user,
    changes: [
      clearing
        ? "Keyword: cleared (gork disabled)"
        : `Keyword: \`${settings.gork_keyword}\``,
    ],
  }).catch(() => {});
  await commandCtx.reply({
    content: clearing
      ? "Gork is now **disabled** for this server — triggers are ignored."
      : `Gork keyword set to \`${settings.gork_keyword}\`. Trigger it with \`${settings.gork_keyword} <question>\`, or \`${settings.gork_keyword}\` replying to a message.`,
    sensitive: true,
  });
}

/**
 * /gork context: set the context window size (1-50).
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setContext(commandCtx) {
  const communityId = commandCtx.communityId;
  const raw = commandCtx.options.getInteger("context");
  if (!Number.isFinite(raw) || raw < CONTEXT_MIN || raw > CONTEXT_MAX) {
    return commandCtx.reply({
      content: `The context window must be ${CONTEXT_MIN}-${CONTEXT_MAX} messages.`,
      sensitive: true,
    });
  }
  const settings = updateGuildSettings(communityId, {
    gork_context_window: raw,
  });
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.context_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { context_window: settings.gork_context_window },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Gork context window updated",
    command: "/gork context",
    actor: commandCtx.user,
    changes: [`Context window: ${settings.gork_context_window} messages`],
  }).catch(() => {});
  await commandCtx.reply({
    content: `Gork context window set to **${settings.gork_context_window}** prior messages.`,
    sensitive: true,
  });
}

/**
 * /gork cooldown: set the per-user cooldown in seconds (0-3600).
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setCooldown(commandCtx) {
  const communityId = commandCtx.communityId;
  const raw = commandCtx.options.getInteger("cooldown");
  if (!Number.isFinite(raw) || raw < COOLDOWN_MIN || raw > COOLDOWN_MAX) {
    return commandCtx.reply({
      content: `The cooldown must be ${COOLDOWN_MIN}-${COOLDOWN_MAX} seconds (0 = disabled).`,
      sensitive: true,
    });
  }
  const settings = updateGuildSettings(communityId, {
    gork_cooldown_sec: raw,
  });
  const stored = settings.gork_cooldown_sec;
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.cooldown_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { cooldown_sec: stored },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Gork cooldown updated",
    command: "/gork cooldown",
    actor: commandCtx.user,
    changes: [`Cooldown: ${stored}s (staff always bypass)`],
  }).catch(() => {});
  await commandCtx.reply({
    content: stored === 0
      ? "Gork cooldown is now **disabled** (0s). Staff always bypass."
      : `Gork cooldown set to **${stored}s** per user per server. Staff always bypass.`,
    sensitive: true,
  });
}

/**
 * /gork rules: set the staff prompt rules, or `clear` to remove them.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setRules(commandCtx) {
  const communityId = commandCtx.communityId;
  const raw = (commandCtx.options.getString("rules") || "").trim();
  const clearing = raw === "clear";
  if (!clearing && !raw) {
    return commandCtx.reply({
      content: "Rules cannot be empty — use `clear` to remove them.",
      sensitive: true,
    });
  }
  if (raw.length > RULES_MAX) {
    return commandCtx.reply({
      content: `Rules must be at most ${RULES_MAX} characters.`,
      sensitive: true,
    });
  }
  const settings = updateGuildSettings(communityId, {
    gork_extra_rules: clearing ? "" : raw,
  });
  const stored = (settings.gork_extra_rules || "").trim();
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.rules_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { rules: stored, cleared: clearing },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: stored ? "Gork staff rules updated" : "Gork staff rules removed",
    command: "/gork rules",
    actor: commandCtx.user,
    changes: [stored ? `Rules: \`${stored}\`` : "Rules: removed"],
  }).catch(() => {});
  await commandCtx.reply({
    content: stored
      ? `Gork staff rules set to:\n\`${stored}\`\n\nThey are appended to the system prompt; the SFW / questions-only guardrails always apply.`
      : "Gork staff rules removed.",
    sensitive: true,
  });
}

/**
 * /gork search: toggle the SearXNG web_search tool for the guild.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setSearch(commandCtx) {
  const communityId = commandCtx.communityId;
  const raw = (commandCtx.options.getString("search") || "").toLowerCase();
  if (raw !== "on" && raw !== "off") {
    return commandCtx.reply({
      content: "Search must be `on` or `off`.",
      sensitive: true,
    });
  }
  const settings = updateGuildSettings(communityId, {
    gork_search_enabled: raw === "on" ? 1 : 0,
  });
  const on = Number(settings.gork_search_enabled) === 1;
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.search_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { enabled: on ? 1 : 0 },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: `Gork web search ${on ? "enabled" : "disabled"}`,
    command: "/gork search",
    actor: commandCtx.user,
    changes: [`Web search: ${on ? "on" : "off"}`],
  }).catch(() => {});
  await commandCtx.reply({
    content: on
      ? "Gork web search is now **on** (runs against the bot's SearXNG instance — see `/gork status` for the URL state)."
      : "Gork web search is now **off** — answers come from conversation context only.",
    sensitive: true,
  });
}

/**
 * /gork ste: toggle the STE answer style (roadmap §7.20, decision 50).
 * On = the byte-locked anti-slop card rides between the base prompt and
 * staff rules for every Q&A job in this guild. Off (default) = answers
 * are generated with exactly the pre-7.20 prompt. Re-read per job.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setSte(commandCtx) {
  const communityId = commandCtx.communityId;
  const raw = (commandCtx.options.getString("ste") || "").toLowerCase();
  if (raw !== "on" && raw !== "off") {
    return commandCtx.reply({
      content: "STE must be `on` or `off`.",
      sensitive: true,
    });
  }
  const settings = updateGuildSettings(communityId, {
    gork_ste_enabled: raw === "on" ? 1 : 0,
  });
  const on = Number(settings.gork_ste_enabled) === 1;
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.ste_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { enabled: on ? 1 : 0 },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: `Gork STE answer style ${on ? "enabled" : "disabled"}`,
    command: "/gork ste",
    actor: commandCtx.user,
    changes: [`STE answer style: ${on ? "on" : "off"}`],
  }).catch(() => {});
  await commandCtx.reply({
    content: on
      ? "Gork STE answer style is now **on** — answers follow the anti-slop writing rules (short active sentences, answer first, no padding). The sarcasm stays."
      : "Gork STE answer style is now **off** — answers are written with the standard prompt again.",
    sensitive: true,
  });
}

/**
 * /gork enable: master on/off switch for the whole gork feature in this
 * guild. Off makes triggers fully silent; every other gork setting
 * (keyword, rules, cooldown, bans, ...) is preserved for re-enable.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setEnable(commandCtx) {
  const communityId = commandCtx.communityId;
  const raw = (commandCtx.options.getString("enable") || "").toLowerCase();
  if (raw !== "on" && raw !== "off") {
    return commandCtx.reply({
      content: "Enable must be `on` or `off`.",
      sensitive: true,
    });
  }
  const settings = updateGuildSettings(communityId, {
    gork_enabled: raw === "on" ? 1 : 0,
  });
  const on = Number(settings.gork_enabled ?? 1) === 1;
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.enabled_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { enabled: on ? 1 : 0 },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: `Gork ${on ? "enabled" : "disabled"} for the server`,
    command: "/gork enable",
    actor: commandCtx.user,
    changes: [`Gork: ${on ? "enabled" : "disabled"}`],
  }).catch(() => {});
  await commandCtx.reply({
    content: on
      ? "Gork is now **enabled** for this server — keyword triggers are active again."
      : "Gork is now **disabled** for this server — all triggers are ignored. Every other gork setting is kept; re-enable with `/gork enable on`.",
    sensitive: true,
  });
}

/**
 * /gork ban: block a user from gork in this guild. The banned user keeps
 * getting the locked generic replies (never told about the ban), and
 * staff roles do NOT bypass the ban.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function banUser(commandCtx) {
  const communityId = commandCtx.communityId;
  const user = commandCtx.options.getUser("user");
  if (!user) {
    return commandCtx.reply({
      content: "Pick a user to ban from gork.",
      sensitive: true,
    });
  }
  if (user.bot) {
    return commandCtx.reply({
      content: "Bots can't be banned from gork (they never trigger it anyway).",
      sensitive: true,
    });
  }
  addGorkBlock(communityId, user.id, commandCtx.userId);
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.ban",
    targetType: "user",
    targetId: user.id,
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Gork user banned",
    command: "/gork ban",
    actor: commandCtx.user,
    changes: [`Banned from gork: <@${user.id}> (\`${user.id}\`)`],
  }).catch(() => {});
  await commandCtx.reply({
    content: `<@${user.id}> is now **banned from gork** in this server — triggers get the generic "brain went to lunch" reply (they are not told it's a ban). Lift it with \`/gork unban\`.`,
    sensitive: true,
  });
}

/**
 * /gork unban: lift a user's gork ban in this guild.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function unbanUser(commandCtx) {
  const communityId = commandCtx.communityId;
  const user = commandCtx.options.getUser("user");
  if (!user) {
    return commandCtx.reply({
      content: "Pick a user to unban from gork.",
      sensitive: true,
    });
  }
  const removed = removeGorkBlock(communityId, user.id);
  if (!removed) {
    return commandCtx.reply({
      content: `<@${user.id}> is not banned from gork in this server.`,
      sensitive: true,
    });
  }
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.unban",
    targetType: "user",
    targetId: user.id,
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Gork user unbanned",
    command: "/gork unban",
    actor: commandCtx.user,
    changes: [`Unbanned from gork: <@${user.id}> (\`${user.id}\`)`],
  }).catch(() => {});
  await commandCtx.reply({
    content: `<@${user.id}> can use gork again in this server.`,
    sensitive: true,
  });
}

/**
 * /gork bans: ephemeral list of users banned from gork in this guild.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function showBans(commandCtx) {
  const blocks = listGorkBlocks(commandCtx.communityId);
  if (!blocks.length) {
    return commandCtx.reply({
      content: "No users are banned from gork in this server.",
      sensitive: true,
    });
  }
  const shown = blocks.slice(0, BANS_LIST_MAX).map((b) => `- <@${b.user_id}>`);
  if (blocks.length > BANS_LIST_MAX) {
    shown.push(`…and ${blocks.length - BANS_LIST_MAX} more`);
  }
  await commandCtx.reply({
    content: `**Gork bans (${blocks.length}):**\n${shown.join("\n")}`,
    sensitive: true,
  });
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
 * Staff memory commands below (show / forget / clear) are COMMUNITY-LOCAL
 * by design in v1 (account-linking, roadmap/account-linking.md § Staff
 * parity): they read and delete THIS community's gork_memories rows only.
 * A memory mirrored to a linked account lives as a SEPARATE row in the
 * counterpart community, so `/gork memory forget` and `clear` do NOT
 * cascade to the mirrored rows on the linked platform (and `show` lists
 * local rows only). Cross-platform cascading deletes are a documented v1
 * limitation — see roadmap/account-linking.md (known limitations). Gork's
 * own read paths (loadMemoryContext, recall_memories) DO fan out through
 * the link; these staff listings deliberately do not.
 */

/**
 * /gork memory show [user]: ephemeral listing with `#id` handles — one
 * person's memories when `user` is given, otherwise the newest guild rows.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function showMemory(commandCtx) {
  const communityId = commandCtx.communityId;
  const target = commandCtx.options.getUser("user");
  const rows = target
    ? gorkMemoryListForSubject(communityId, target.id)
    : gorkMemoryListForGuild(communityId, MEMORIES_LIST_MAX);
  if (!rows.length) {
    return commandCtx.reply({
      content: target
        ? `No memories stored for <@${target.id}> in this server.`
        : "No memories stored in this server yet.",
      sensitive: true,
    });
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
  await commandCtx.reply({
    content: `${heading}\n${lines.join("\n")}`,
    sensitive: true,
  });
}

/**
 * /gork memory forget <id>: delete one memory by its `#id` handle.
 * Guild-scoped — a miss never hints whether the id exists elsewhere.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function forgetMemory(commandCtx) {
  const communityId = commandCtx.communityId;
  const rawId = commandCtx.options.getInteger("id");
  if (!Number.isInteger(rawId) || rawId <= 0) {
    return commandCtx.reply({
      content: "`id` must be a positive whole number — the `#id` handle from `/gork memory show`.",
      sensitive: true,
    });
  }
  const row = gorkMemoryGetById(communityId, rawId);
  if (!row) {
    return commandCtx.reply({
      content: `No memory #${rawId} in this guild.`,
      sensitive: true,
    });
  }
  gorkMemoryDeleteById(communityId, rawId);
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Gork memory forgotten",
    command: "/gork memory",
    actor: commandCtx.user,
    changes: [
      `Forgot memory #${row.id}: \`${row.title}\` (about <@${row.subject_user_id}>)`,
    ],
  }).catch(() => {});
  await commandCtx.reply({
    content: `Forgot memory **#${row.id}** — \`${row.title}\` (about <@${row.subject_user_id}>).`,
    sensitive: true,
  });
}

/**
 * /gork memory clear [user]: wipe one person's (with `user`) or the whole
 * guild's memories. Confirm-once: without `confirm: true` this only shows
 * the damage preview.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function clearMemory(commandCtx) {
  const communityId = commandCtx.communityId;
  const target = commandCtx.options.getUser("user");
  const confirmed = commandCtx.options.getBoolean("confirm") === true;
  const scope = target
    ? {
        count: gorkMemoryListForSubject(communityId, target.id).length,
        subject: target,
        noun: `memories for <@${target.id}>`,
        run: () => gorkMemoryDeleteForSubject(communityId, target.id),
      }
    : {
        count: gorkMemoryCountForGuild(communityId),
        subject: null,
        noun: "memories across this server",
        run: () => gorkMemoryDeleteForGuild(communityId),
      };

  if (scope.count === 0) {
    return commandCtx.reply({
      content: target
        ? `No memories stored for <@${target.id}> — nothing to erase.`
        : "No memories stored in this server — nothing to erase.",
      sensitive: true,
    });
  }
  if (!confirmed) {
    return commandCtx.reply({
      content: `This will erase **${scope.count}** ${scope.noun}. Re-run with \`confirm: true\` to actually erase.`,
      sensitive: true,
    });
  }

  const deleted = scope.run();
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Gork memory cleared",
    command: "/gork memory",
    actor: commandCtx.user,
    changes: [
      target
        ? `Erased ${deleted} memories for <@${target.id}> (\`${target.id}\`)`
        : `Erased ${deleted} memories (whole guild)`,
    ],
  }).catch(() => {});
  await commandCtx.reply({
    content: `Erased **${deleted}** ${scope.noun}.`,
    sensitive: true,
  });
}

/**
 * /gork memory on|off: master switch for community memory (default off —
 * every answered question costs an extra extraction LLM call).
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {string} action "on" | "off" from the dispatcher
 */
async function setMemoryEnabled(commandCtx, action) {
  const settings = updateGuildSettings(commandCtx.communityId, {
    gork_memory_enabled: action === "on" ? 1 : 0,
  });
  const on = Number(settings.gork_memory_enabled) === 1;
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: `Gork memory ${on ? "enabled" : "disabled"}`,
    command: "/gork memory",
    actor: commandCtx.user,
    changes: [`Memory: ${on ? "on" : "off"}`],
  }).catch(() => {});
  await commandCtx.reply({
    content: on
      ? "Gork memory is now **on** — gork extracts durable facts about people after each answer and remembers them. Turn it off again with `/gork memory off`."
      : "Gork memory is now **off** — nothing new is stored and no memory block is injected. Stored memories stay until staff erase them (`/gork memory show` / `forget` / `clear`).",
    sensitive: true,
  });
}

/**
 * /gork log <enabled>: per-guild switch for the interaction log (E2E
 * capture). ON stores one gork_interactions row per agent call (exact
 * prompts, transcript, outcome) for replay/debug; rows age out on the
 * env-configured retention window. Mirrors the memory toggle's shape.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setInteractionLog(commandCtx) {
  const communityId = commandCtx.communityId;
  const enabled = commandCtx.options.getBoolean("enabled") === true;
  let settings;
  try {
    settings = updateGuildSettings(communityId, {
      gork_interaction_log_enabled: enabled ? 1 : 0,
    });
  } catch (err) {
    // Surface the specific cause (AGENTS.md): never a bare generic failure.
    return commandCtx.reply({
      content: `Could not update the interaction log setting: ${err?.message || err}`,
      sensitive: true,
    });
  }
  const on = Number(settings.gork_interaction_log_enabled ?? 1) === 1;
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: `Gork interaction log ${on ? "enabled" : "disabled"}`,
    command: "/gork log",
    actor: commandCtx.user,
    changes: [`Interaction log: ${on ? "on" : "off"}`],
  }).catch(() => {});
  const rows = countGorkInteractions(communityId);
  await commandCtx.reply({
    content: on
      ? `Gork interaction log is now **on** — every gork agent call in this server is recorded (\`${rows}\` row${rows === 1 ? "" : "s"} stored so far).`
      : `Gork interaction log is now **off** — agent calls are no longer recorded (\`${rows}\` row${rows === 1 ? "" : "s"} remain; they age out with retention).`,
    sensitive: true,
  });
}

/**
 * /gork memory budget <chars>: cap for the injected memory block
 * (0–64,000; 0 = unlimited; garbage → default 12,000).
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setMemoryBudget(commandCtx) {
  const communityId = commandCtx.communityId;
  const raw = commandCtx.options.getInteger("chars");
  if (raw === null) {
    return commandCtx.reply({
      content: "Provide `chars` — the memory-block budget in characters (0–64000; 0 = unlimited).",
      sensitive: true,
    });
  }
  // Lazy require: the memory module owns the clamp, and the command surface
  // must load fine without it (same pattern as the trigger's memory hooks).
  const { clampMemoryChars } = require("./memory");
  const value = clampMemoryChars(raw);
  const settings = updateGuildSettings(communityId, {
    gork_memory_chars: value,
  });
  const stored = Number(settings.gork_memory_chars);
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Gork memory budget updated",
    command: "/gork memory",
    actor: commandCtx.user,
    changes: [`Memory budget: ${stored} chars${stored === 0 ? " (unlimited)" : ""}`],
  }).catch(() => {});
  await commandCtx.reply({
    content: stored === 0
      ? "Gork memory budget set to **0** — the memory block is **unlimited** (0 = unlimited)."
      : `Gork memory budget set to **${stored}** chars. \`0\` = unlimited.`,
    sensitive: true,
  });
}

/**
 * /gork memory dispatcher (action option → verb).
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function handleMemory(commandCtx) {
  const action = (commandCtx.options.getString("action") || "").toLowerCase();
  switch (action) {
    case "show":
      return showMemory(commandCtx);
    case "forget":
      return forgetMemory(commandCtx);
    case "clear":
      return clearMemory(commandCtx);
    case "on":
    case "off":
      return setMemoryEnabled(commandCtx, action);
    case "budget":
      return setMemoryBudget(commandCtx);
    default:
      return commandCtx.reply({
        content: `Unknown memory action: \`${action}\`.`,
        sensitive: true,
      });
  }
}

/**
 * `/gork budget default <limit>`: guild-default tri-state limit
 * (-1 blocked, 0 unlimited, 1–1000 successful answers per user per UTC
 * day; clamped by the settings layer — roadmap §7.17.2).
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setBudgetDefault(commandCtx) {
  const communityId = commandCtx.communityId;
  const limit = commandCtx.options.getInteger("limit");
  if (limit === null) {
    return commandCtx.reply({
      content: `Provide \`limit\`: \`-1\` blocked · \`0\` unlimited · \`1–${BUDGET_MAX}\` successful answers per user per UTC day.`,
      sensitive: true,
    });
  }
  const settings = updateGuildSettings(communityId, { gork_daily_limit: limit });
  const stored = settings.gork_daily_limit;
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Gork budget default updated",
    command: "/gork budget",
    actor: commandCtx.user,
    changes: [`Guild-default daily budget: ${formatDailyLimit(stored)} (\`${stored}\`)`],
  }).catch(() => {});
  return commandCtx.reply({
    content: `Guild-default daily budget set to **${formatDailyLimit(stored)}** (\`${stored}\`).`,
    sensitive: true,
  });
}

/**
 * `/gork budget channel|category <target> <limit>`: add/replace a per-scope
 * rule. The most specific scope wins (channel → category → guild default);
 * a category rule pools every channel inside it (decision 30).
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {"channel"|"category"} scopeKind
 */
async function setBudgetScope(commandCtx, scopeKind) {
  const communityId = commandCtx.communityId;
  const limit = commandCtx.options.getInteger("limit");
  if (limit === null) {
    return commandCtx.reply({
      content: `Provide \`limit\`: \`-1\` blocked · \`0\` unlimited · \`1–${BUDGET_MAX}\` successful answers per user per UTC day.`,
      sensitive: true,
    });
  }
  const picked = commandCtx.options.getChannel("target");
  if (!picked?.id) {
    return commandCtx.reply({
      content: `Pick the ${scopeKind} in \`target\` (or use \`/gork budget default\` for the guild-wide limit).`,
      sensitive: true,
    });
  }
  // Channel resolution prefers the RESOLVED picker object from the transport
  // (discord.js supplies the full channel; the pre-seam code read exactly
  // this). OutboundClient.fetchChannel is the fallback for transports that
  // only expose the seam's { id, type } handle — validating kind + binding a
  // thread to its parent needs more than the handle carries (roadmap
  // § Outbound client; ticker-side cutover is PR 7).
  const raw = commandCtx.rawInteraction;
  const target =
    (typeof raw?.options?.getChannel === "function"
      ? raw.options.getChannel("target")
      : null) ??
    (await commandCtx.outbound.fetchChannel(communityId, String(picked.id)));
  if (!target) {
    return commandCtx.reply({
      content: `Could not find <#${picked.id}> in this server — the bot must be able to see the ${scopeKind} to set a rule on it.`,
      sensitive: true,
    });
  }
  // Guard the picker against kind mismatches: a category rule on a text
  // channel id (or vice versa) could never match a trigger — reject rather
  // than store a dead rule.
  const isCategory = Number(target.type) === CATEGORY_TYPE;
  if (scopeKind === "category" && !isCategory) {
    return commandCtx.reply({
      content: "`target` must be a **category** for `category` rules (a rule on a text channel belongs to `channel`).",
      sensitive: true,
    });
  }
  if (scopeKind === "channel" && isCategory) {
    return commandCtx.reply({
      content: "`target` must be a **channel/thread** for `channel` rules (use `category` for categories).",
      sensitive: true,
    });
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
      return commandCtx.reply({
        content: "Could not resolve that thread's parent channel — pick the parent channel directly instead.",
        sensitive: true,
      });
    }
    targetId = String(target.parent.id);
    boundToThreadParent = true;
  }
  const stored = clampGorkDailyLimit(limit);
  if (!upsertGorkBudgetRule(communityId, scopeKind, targetId, stored, commandCtx.userId)) {
    return commandCtx.reply({
      content: `Could not store the ${scopeKind} rule for \`${targetId}\` — invalid target.`,
      sensitive: true,
    });
  }
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: `Gork budget ${scopeKind} rule updated`,
    command: "/gork budget",
    actor: commandCtx.user,
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
  return commandCtx.reply({
    content: `Daily gork budget for ${scopeKind} ${ref} is now **${formatDailyLimit(stored)}** (\`${stored}\`)${threadNote}.`,
    sensitive: true,
  });
}

/**
 * `/gork budget remove_channel|remove_category <id>`: drop a rule so the
 * scope falls back to category → guild default. Accepts the picker or a raw
 * id (deleted channels the picker cannot offer).
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {"channel"|"category"} scopeKind
 */
async function removeBudgetScope(commandCtx, scopeKind) {
  const communityId = commandCtx.communityId;
  const picked = commandCtx.options.getChannel("target");
  const rawId = (commandCtx.options.getString("id") || "").trim();
  let targetId = picked?.id ? String(picked.id) : rawId;
  if (!targetId) {
    return commandCtx.reply({
      content: `Pick \`target\` or type the raw \`id\` of the ${scopeKind} rule to remove.`,
      sensitive: true,
    });
  }
  // Mirror the set-side normalization: thread targets address the PARENT
  // channel's rule (thread-id rules are never stored, so deleting by thread
  // id would falsely report "no rule"). The full channel is taken from the
  // transport's RESOLVED picker object (discord.js/mocks supply the full
  // shape, pre-seam behavior); OutboundClient.fetchChannel is the fallback
  // for transports exposing only the { id, type } handle. A null resolution
  // (deleted / invisible channel) keeps the picked id, which is exactly
  // what the remove-by-id path targets.
  if (scopeKind === "channel" && picked?.id) {
    const raw = commandCtx.rawInteraction;
    const target =
      (typeof raw?.options?.getChannel === "function"
        ? raw.options.getChannel("target")
        : null) ??
      (await commandCtx.outbound.fetchChannel(communityId, String(picked.id)));
    if (target && isThreadLike(target)) {
      if (!target.parent?.id) {
        return commandCtx.reply({
          content: "Could not resolve that thread's parent channel — remove the rule by the parent channel or its raw `id`.",
          sensitive: true,
        });
      }
      targetId = String(target.parent.id);
    }
  }
  const removed = deleteGorkBudgetRule(communityId, scopeKind, targetId);
  if (!removed) {
    return commandCtx.reply({
      content: `No \`${scopeKind}\` budget rule for \`${targetId}\` in this server.`,
      sensitive: true,
    });
  }
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: `Gork budget ${scopeKind} rule removed`,
    command: "/gork budget",
    actor: commandCtx.user,
    changes: [`Removed ${scopeKind} budget rule \`${targetId}\``],
  }).catch(() => {});
  const ref = scopeKind === "channel" ? `<#${targetId}>` : `\`${targetId}\``;
  const fallback = scopeKind === "channel" ? "its category → the guild default" : "the guild default";
  return commandCtx.reply({
    content: `Removed the ${scopeKind} budget rule for ${ref} — it falls back to ${fallback}.`,
    sensitive: true,
  });
}

/**
 * `/gork budget list`: guild default + every rule with `created_by`
 * provenance (decision 37).
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function listBudget(commandCtx) {
  const communityId = commandCtx.communityId;
  const settings = getGuildSettings(communityId);
  const rules = listGorkBudgetRules(communityId);
  const lines = rules.slice(0, BUDGET_RULES_LIST_MAX).map((r) => {
    const ref = r.scope_kind === "channel" ? `<#${r.target_id}>` : `\`${r.target_id}\``;
    const by = r.created_by ? ` · by <@${r.created_by}>` : "";
    return `${r.scope_kind === "channel" ? "Channel" : "Category"} ${ref} — **${formatDailyLimit(r.daily_limit)}**${by}`;
  });
  if (rules.length > lines.length) {
    lines.push(`…and ${rules.length - lines.length} more`);
  }
  // Plain NormalizedEmbed — same visible text as the previous baseEmbed.
  const embed = {
    title: "Gork daily budgets",
    color: Color.brand,
    fields: [
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
    ],
    timestamp: new Date(),
  };
  await commandCtx.reply({ embeds: [embed], sensitive: true });
}

/**
 * /gork budget dispatcher (action option → verb).
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function handleBudget(commandCtx) {
  const action = (commandCtx.options.getString("action") || "").toLowerCase();
  switch (action) {
    case "default":
      return setBudgetDefault(commandCtx);
    case "channel":
    case "category":
      return setBudgetScope(commandCtx, action);
    case "remove_channel":
      return removeBudgetScope(commandCtx, "channel");
    case "remove_category":
      return removeBudgetScope(commandCtx, "category");
    case "list":
      return listBudget(commandCtx);
    default:
      return commandCtx.reply({
        content: `Unknown budget action: \`${action}\`.`,
        sensitive: true,
      });
  }
}

/**
 * /gork status: ephemeral embed of the current configuration.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function showStatus(commandCtx) {
  const communityId = commandCtx.communityId;
  const settings = getGuildSettings(communityId);
  const enabled = Number(settings.gork_enabled ?? 1) === 1;
  const keyword = (settings.gork_keyword || "").trim();
  const rules = (settings.gork_extra_rules || "").trim();
  const searchOn = Number(settings.gork_search_enabled) === 1;
  const cooldownSec = settings.gork_cooldown_sec;
  const banCount = listGorkBlocks(communityId).length;
  const memoryOn = Number(settings.gork_memory_enabled ?? 0) === 1;
  const memoryCount = gorkMemoryCountForGuild(communityId);
  const interactionLogOn =
    Number(settings.gork_interaction_log_enabled ?? 1) === 1;
  const interactionLogRows = countGorkInteractions(communityId);
  const budgetRules = listGorkBudgetRules(communityId);
  const ai = getAiConfig();
  const searxngSet = Boolean(
    typeof process.env.SEARXNG_URL === "string" && process.env.SEARXNG_URL.trim(),
  );

  // Plain NormalizedEmbed — same visible text as the previous baseEmbed.
  const embed = {
    title: "Gork status",
    color: Color.brand,
    timestamp: new Date(),
    fields: [
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
        // §7.20: STE anti-slop answer style (decision 50 surface).
        name: "STE answer style",
        value: Number(settings.gork_ste_enabled ?? 0) === 1 ? "on" : "off",
        inline: true,
      },
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
      {
        // §7.21: per-guild /gork summarize INPUT token budget (8k–120k, default 80k).
        name: "Summarize budget",
        value: `${clampSummarizeInputTokens(settings.gork_summarize_input_tokens)} input tokens`,
        inline: true,
      },
    ],
  };
  await commandCtx.reply({ embeds: [embed], sensitive: true });
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
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
function summarizeChannelArg(commandCtx) {
  const raw = commandCtx.options.getChannel("channel");
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
 * nothing). The first payload resolves the deferred reply (editReply),
 * continuations follow as channel messages (followUp).
 *
 * @param {{ editReply: Function, followUp: Function }} poster
 *   anything exposing the reply trio (a CommandContext — and the test seam's
 *   interaction-shaped fake — both satisfy this)
 * @param {object[]} payloads
 * @returns {Promise<{ ok: boolean, posted: object[], error?: string }>}
 */
async function postRundownPayloads(poster, payloads) {
  const posted = [];
  try {
    for (let i = 0; i < payloads.length; i += 1) {
      const msg =
        i === 0
          ? await poster.editReply(payloads[i])
          : await poster.followUp(payloads[i]);
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
 *
 * Discord-only body: `raw`/`client` supply the real discord.js guild/channel/
 * interaction-id plumbing the range reader, generator, and audit poster need
 * until the OutboundClient cutover (PR 7). Fluxer never reaches this function
 * — summarizeMain guards it with the standard Discord-only line.
 *
 * @param {object} job
 * @param {import("../../platform/context").CommandContext} job.commandCtx
 * @param {object} job.raw the Discord rawInteraction (guaranteed by summarizeMain)
 * @param {object} job.client the discord.js client (raw.client)
 * @param {string} job.guildId external (Discord) guild id for display/audit
 * @param {number} job.communityId integer repository key
 * @param {string|null} job.userId invoker id
 * @param {string} job.day UTC day key
 * @param {object} job.opts reader options (from/to/last/channel/focus/lang)
 * @param {object} job.mode validated summarize mode from validateSummarizeMode
 * @param {object} job.settings guild settings snapshot
 */
async function runSummarizeJob({
  commandCtx,
  raw,
  client,
  guildId,
  communityId,
  userId,
  day,
  opts,
  mode,
  settings,
}) {
  const guild = raw.guild;
  const startedAt = Date.now();
  const channelBase = {
    user: commandCtx.user,
    channelId: commandCtx.channelId,
    channelLabel: formatChannelLabel(raw.channel),
  };

  // §7.17.4 dequeue re-check (mirrors trigger.js): queued work can arrive
  // after the budget spent itself — bounce WITHOUT the LLM call, WITHOUT a
  // count, and WITHOUT arming the guild cooldown.
  const budgetChannel = raw.channel ?? { id: commandCtx.channelId };
  const gate = checkGorkBudget({ communityId, userId, channel: budgetChannel, day });
  if (!gate.allowed) {
    if (gate.kind === "error") {
      console.error(
        `[gork] summarize budget gate error at dequeue in ${guildId}: user=${userId} day=${day} — failing closed`,
      );
      return commandCtx.editReply(
        "Could not re-check your gork daily budget when the rundown job started (database error, logged) — nothing was generated or counted.",
      );
    }
    console.log(
      `[gork] summarize budget ${gate.kind} at dequeue in ${guildId}: user=${userId} scope=${
        gate.scope ? `${gate.scope.scopeKind}/${gate.scope.scopeId}` : "?"
      } day=${day} — bounced, no LLM call`,
    );
    return commandCtx.editReply(gate.reply);
  }

  // Range read (§7.21.2). A bare anchor / `last:` defaults to the channel
  // the command ran in. The guild's per-guild input token budget
  // (gork_summarize_input_tokens, default 80,000) clamps the transcript.
  const tokenBudget = clampSummarizeInputTokens(settings?.gork_summarize_input_tokens);
  const read = await readSummarizeRange(
    { from: opts.from, to: opts.to, last: opts.last, channel: opts.channel },
    {
      guildId,
      guild,
      invokerId: userId,
      fallbackChannelId: commandCtx.channelId,
      tokenBudget,
    },
  );
  if (!read.ok) {
    console.error(
      `[gork] summarize read failed in ${guildId}: user=${userId} channel=${commandCtx.channelId} mode=${mode.mode} cmd=/gork summarize code=${read.code} — ${read.error}`,
    );
    await summarizeFailureAudit(client, guildId, channelBase, `range read failed (${read.code}): ${read.error}`);
    let text = read.error;
    if (read.code === "fetch" && read.partial) {
      // Partial-results rule (repo standard): disclose the window that WAS
      // read and why no rundown came out of it.
      text += `\nPartial window actually read: **${read.partial.count}** message(s) (${read.partial.firstId} → ${read.partial.lastId}) — discarded; the rundown needs the complete range, so nothing was produced or counted.`;
    }
    return commandCtx.editReply(text);
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
      communityId,
      channelId: commandCtx.channelId,
      interactionId: raw.id ?? null,
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
        inputTokenBudget: tokenBudget,
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
    return commandCtx.editReply(
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
    invoker: commandCtx.user,
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
  const post = await postRundownPayloads(commandCtx, payloads);
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
      await commandCtx.followUp({
        content: note,
        allowedMentions: NO_PING_MENTIONS,
      });
    } catch (reportErr) {
      console.error(
        `[gork] summarize post-failure followUp failed in ${guildId}:`,
        reportErr?.message || reportErr,
      );
      // Channel post goes through the OutboundClient (spec: features never
      // call channel.send directly).
      await commandCtx.outbound
        .sendChannel(commandCtx.channelId, {
          content: note,
          allowedMentions: NO_PING_MENTIONS,
        })
        .catch(() => {});
    }
    return undefined;
  }

  // ---- Full success (every embed landed): arm, count, record, audit ----

  // Decision 57: the guild cooldown arms the moment the rundown lands —
  // and NOWHERE else (usage/empty/security/fetch/generation failures never
  // lock the guild out of an immediate retry).
  armSummarizeGuildCooldown(communityId);

  // Decision 32: count the invoker's daily budget exactly once, only now.
  // A failed increment is logged, not fatal (the rundown already shipped).
  try {
    recordGorkBudgetUsage({ communityId, userId, scope: gate.scope, day });
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
    user: commandCtx.user,
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
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function summarizeMain(commandCtx) {
  // Deep rundown plumbing (readSummarizeRange / generateSummarize / the audit
  // posters) consumes real discord.js Guild/Client objects the CommandContext
  // cannot supply. Roadmap § CommandContext documents `rawInteraction` as the
  // escape hatch for exactly this; the OutboundClient cutover for these call
  // targets is PR 7. Fluxer contexts never carry rawInteraction.
  const raw = commandCtx.rawInteraction;
  if (!raw) {
    await commandCtx.reply({ content: NOT_ON_FLUXER, sensitive: true });
    return undefined;
  }
  const client = raw.client;
  const guildId = commandCtx.externalGuildId;
  const communityId = commandCtx.communityId;
  const userId = commandCtx.userId ?? null;
  const opts = {
    from: (commandCtx.options.getString("from") || "").trim() || null,
    to: (commandCtx.options.getString("to") || "").trim() || null,
    last: commandCtx.options.getInteger("last"),
    channel: summarizeChannelArg(commandCtx),
    focus: (commandCtx.options.getString("focus") || "").trim() || null,
    lang: (commandCtx.options.getString("lang") || "").trim() || null,
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
    return commandCtx.reply({ content: mode.error, sensitive: true });
  }

  // 2. Per-guild summarize cooldown (§7.21.5, decision 57): while armed,
  //    whole minutes remaining — the range is NOT read, nothing generates.
  const cooldownMs = checkSummarizeGuildCooldown(communityId);
  if (cooldownMs > 0) {
    const mins = summarizeCooldownMinutesRemaining(cooldownMs);
    console.log(
      `[gork] summarize guild cooldown hit in ${guildId}: user=${userId} mode=${mode.mode} cmd=/gork summarize remainingMin=${mins} — rejected without read or LLM call`,
    );
    return commandCtx.reply({
      content: `One rundown per server per ${SUMMARIZE_WINDOW_MINUTES} minutes — this server already posted one. Try again in **${mins} minute${mins === 1 ? "" : "s"}**. Nothing was read or generated.`,
      sensitive: true,
    });
  }

  // 3. Daily budget at enqueue (§7.17, decisions 33/35): same gate, same
  //    locked reply, same 1×/user/scope/hour throttle as the Q&A trigger —
  //    staff are NOT exempt. One UTC day key for the whole invocation.
  const day = summarizeBudgetDay();
  const budgetChannel = raw.channel ?? { id: commandCtx.channelId };
  const budgetGate = checkGorkBudget({ communityId, userId, channel: budgetChannel, day });
  if (!budgetGate.allowed) {
    if (budgetGate.kind === "error") {
      // checkGorkBudget already console.error'd the DB cause. Fail CLOSED.
      // (The keyword path answers this with the locked "brain went to
      // lunch" mask — that disguise exists only to hide bans from the
      // trigger UX; a staff-invoked rundown carries the real cause.)
      console.error(
        `[gork] summarize budget gate error in ${guildId}: user=${userId} day=${day} cmd=/gork summarize — failing closed`,
      );
      return commandCtx.reply({
        content: "Could not check your gork daily budget — the server's daily-limit settings lookup failed (logged). Nothing was read or generated; try again in a moment.",
        sensitive: true,
      });
    }
    console.log(
      `[gork] summarize budget ${budgetGate.kind} in ${guildId}: user=${userId} scope=${
        budgetGate.scope ? `${budgetGate.scope.scopeKind}/${budgetGate.scope.scopeId}` : "?"
      } day=${day}`,
    );
    if (shouldSendBudgetRejection({ communityId, userId, scope: budgetGate.scope })) {
      return commandCtx.reply({ content: budgetGate.reply, sensitive: true });
    }
    // Throttled (decision 34): the full rejection already went out this
    // hour — resolve the command with a terse echo; never leave the
    // invoker staring at nothing.
    return commandCtx.reply({
      content: budgetGate.kind === "blocked"
        ? "gork is blocked for this channel/category/server scope (see the full notice you already received) — the rundown did not run."
        : "You are still over your daily gork budget (full notice above from the last attempt) — it resets 00:00 UTC.",
      sensitive: true,
    });
  }

  // 4. Deferred BEFORE any range read or generation (reads paginate up to
  //    1,000 messages; generation runs to a 60s deadline).
  await commandCtx.defer();

  const settings = getGuildSettings(communityId);

  // 5. The job runs on the SHARED per-guild gork queue (decision 34) — a
  //    rundown never stampedes a Q&A answer. runExclusive admits, waits the
  //    FIFO turn, runs the body, and releases exactly once in a finally; a
  //    rejecting body resolves to {error} — the slot (and the login) always
  //    survive.
  const slot = await gorkQueue.runExclusive(communityId, () =>
    runSummarizeJob({
      commandCtx,
      raw,
      client,
      guildId,
      communityId,
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
    return commandCtx.editReply(
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
    return commandCtx.editReply(
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
 * @param {import("../../platform/context").CommandContext} commandCtx
 * @param {object} [featureCtx]
 */
async function handleSummarize(commandCtx, featureCtx) {
  void featureCtx;
  try {
    return await summarizeMain(commandCtx);
  } catch (err) {
    // Last-resort net for a bug in the paths above: logged with ids and
    // surfaced verbatim — never a silent deferred spinner (AGENTS.md).
    console.error(
      `[gork] summarize crashed in ${commandCtx.externalGuildId}: user=${commandCtx.userId ?? "?"} cmd=/gork summarize id=${commandCtx.rawInteraction?.id ?? "-"}`,
      err?.message || err,
    );
    const text = `Could not run /gork summarize: ${err?.message || err}`;
    if (commandCtx.deferred || commandCtx.replied) {
      // Mirror editEphemeral's semantics: an EDIT on a deferred (public)
      // reply stays in the channel — no sensitive flag here (the original
      // defer was not ephemeral).
      return commandCtx.editReply(text).catch(() => {});
    }
    return commandCtx.reply({ content: text, sensitive: true }).catch(() => {});
  }
}

/**
 * /gork summarize-budget: set the per-guild INPUT token budget for
 * /gork summarize (8,000–120,000; default 80,000). The range reader
 * converts it to a transcript char cap (4 chars/token minus the prompt-zone
 * reserve), so the LLM input stays inside the configured budget.
 * @param {import("../../platform/context").CommandContext} commandCtx
 */
async function setSummarizeBudget(commandCtx) {
  const communityId = commandCtx.communityId;
  const raw = commandCtx.options.getInteger("tokens");
  if (
    !Number.isFinite(raw) ||
    raw < GORK_SUMMARIZE_INPUT_TOKENS_MIN ||
    raw > GORK_SUMMARIZE_INPUT_TOKENS_MAX
  ) {
    return commandCtx.reply({
      content: `The summarize input token budget must be ${GORK_SUMMARIZE_INPUT_TOKENS_MIN}-${GORK_SUMMARIZE_INPUT_TOKENS_MAX} tokens.`,
      sensitive: true,
    });
  }
  const settings = updateGuildSettings(communityId, {
    gork_summarize_input_tokens: raw,
  });
  const stored = clampSummarizeInputTokens(settings.gork_summarize_input_tokens);
  recordSlashAudit({
    communityId,
    actorUserId: commandCtx.userId,
    action: "gork.summarize_budget_set",
    targetType: "guild",
    targetId: commandCtx.externalGuildId,
    details: { summarize_input_tokens: stored },
  });
  await logConfigChange(commandCtx.outbound, commandCtx.externalGuildId, {
    title: "Gork summarize budget updated",
    command: "/gork summarize-budget",
    actor: commandCtx.user,
    changes: [`Summarize input token budget: ${stored} tokens`],
  }).catch(() => {});
  await commandCtx.reply({
    content: `Gork summarize input budget set to **${stored}** tokens (default ${GORK_SUMMARIZE_INPUT_TOKENS_DEFAULT}).`,
    sensitive: true,
  });
}

module.exports = {
  setKeyword,
  setContext,
  setCooldown,
  setRules,
  setSearch,
  setSte,
  setEnable,
  banUser,
  unbanUser,
  showBans,
  handleMemory,
  handleBudget,
  setInteractionLog,
  showStatus,
  handleSummarize,
  setSummarizeBudget,
  /** TEST SEAM: ordered rundown poster with all-chunks-land accounting. */
  postRundownPayloads,
};
