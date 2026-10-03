/**
 * Gork audit logging (roadmap/gork.md §7.7, design decision 14).
 *
 * Every completed Q&A posts a "Gork Q&A" embed to the guild's audit
 * channel (via logs/auditLog `sendAuditLog`): asker mention, question
 * (≤300 chars; "(keyword only)" when the trigger was just the keyword),
 * context mode (e.g. "reply chain (4 msgs)" / "10 prior messages"), the
 * channel the exchange happened in ("#general", §7.18),
 * search usage ("yes — 2 searches · 1 page read" / "no"), model + duration, the answer
 * (≤1000 chars), and jump links to the question and the gork reply.
 *
 * Failed / timed-out exchanges log a compact one-liner (asker + error
 * reason). When no audit channel is configured (or the send fails), a
 * one-line console log is the fallback.
 *
 * Community memory (§7.16.3, decision 25): the Q&A embed gains a
 * read-side-only "Memory" label (e.g. "bodies ×9 · 1 recalled") — the
 * write side (extraction) posts its own compact "Gork memory" entry
 * AFTER the Q&A embed, so the two audits mirror the two turns.
 *
 * `/gork summarize` (§7.21.5, decision 57) gets its own audit variant of
 * the Q&A embed (mode, resolved range, focus, lang, invoker, outcome) plus
 * a compact failure one-liner, and the interaction log records summarize
 * jobs through the same migration-027 envelope as Q&A rows (kind
 * "summarize") — see createSummarizeInteractionRecorder.
 *
 * Nothing in this module throws: audit failures must never break the
 * gork reply path.
 */

const { sendAuditLog } = require("../logs/auditLog");
const { getDiscordOutbound } = require("../../platform/discord/outbound");
const { buildMessageJumpUrl } = require("../../core/jumpUrl");
const { Color, baseEmbed, truncateField } = require("../../core/theme");
const { GORK_SUMMARIZE_FOCUS_MAX, GORK_SUMMARIZE_LANG_MAX } = require("./constants");
const {
  isInteractionLogEnabled,
  buildSettingsSnapshot,
  createInteractionRecorder,
} = require("./interactionLog");

/** Max chars for the Question field (spec §7.7). */
const QUESTION_MAX_CHARS = 300;
/** Max chars for the Answer field (spec §7.7). */
const ANSWER_MAX_CHARS = 1000;
/** Max chars of the question quoted in the failure one-liner. */
const FAILURE_QUESTION_MAX_CHARS = 200;
/** Max chars of the reason quoted in the failure one-liner. */
const FAILURE_REASON_MAX_CHARS = 200;

/* /gork summarize audit variant (roadmap/gork.md §7.21.5, decision 57) */
/** Display cap for the summarize audit "Focus" field — same bound as the
 * `focus:` command option (GORK_SUMMARIZE_FOCUS_MAX, §7.21.1), so the
 * audit shows at most what the builder accepted. */
const SUMMARIZE_FOCUS_DISPLAY_MAX = GORK_SUMMARIZE_FOCUS_MAX;
/** Display cap for the summarize audit "Language" field (same bound as
 * the `lang:` option, §7.21.1). */
const SUMMARIZE_LANG_DISPLAY_MAX = GORK_SUMMARIZE_LANG_MAX;
/** Audit excerpt cap for the posted rundown (mirrors ANSWER_MAX_CHARS). */
const SUMMARIZE_RUNDOWN_MAX_CHARS = 1000;
/**
 * Interaction-log `kind` column value identifying summarize jobs on the
 * migration-027 `gork_interactions` table (free-text column — same way
 * "qa" / "memory_turn" coexist; dashboards filter on it).
 */
const GORK_SUMMARIZE_INTERACTION_KIND = "summarize";

/**
 * Render the context mode for the audit "Context" field.
 *
 * @param {{ mode?: "reply-chain"|"prior", collected?: number }} ctx
 *   buildContext() result (or a subset of it)
 * @returns {string} e.g. "reply chain (4 msgs)" / "10 prior messages"
 */
function describeContext(ctx = {}) {
  const count = Math.max(0, Math.floor(Number(ctx.collected) || 0));
  if (ctx.mode === "reply-chain") return `reply chain (${count} msgs)`;
  return `${count} prior messages`;
}

/**
 * Render the audit "Search" field from the per-job tool counters.
 * Searches, page reads, and link reads (read_discord, §7.19 decision 48)
 * are counted separately (locked wording):
 * "yes — 2 searches · 1 page read · 1 link read"; "no" when no tool ran.
 *
 * @param {unknown} searchQueries web_search tool executions
 * @param {unknown} pageReads read_page tool executions
 * @param {unknown} [linkReads] read_discord tool executions
 * @returns {string}
 */
function formatToolUsage(searchQueries, pageReads, linkReads) {
  const queries = Math.max(0, Math.floor(Number(searchQueries) || 0));
  const pages = Math.max(0, Math.floor(Number(pageReads) || 0));
  const links = Math.max(0, Math.floor(Number(linkReads) || 0));
  const parts = [];
  if (queries > 0) {
    parts.push(queries === 1 ? "1 search" : `${queries} searches`);
  }
  if (pages > 0) {
    parts.push(pages === 1 ? "1 page read" : `${pages} page reads`);
  }
  if (links > 0) {
    parts.push(links === 1 ? "1 link read" : `${links} link reads`);
  }
  return parts.length ? `yes — ${parts.join(" · ")}` : "no";
}

/**
 * Compact read-side memory label for the Q&A audit "Memory" field
 * (roadmap §7.16.3): `${mode} ×${indexed}` — the block mode plus how
 * many memories were indexed into the prompt — with a recall tally
 * appended ONLY when the model actually fetched bodies via
 * recall_memories. The trigger omits the field entirely when memory is
 * OFF, so nothing here ever renders for the default config.
 *
 * @param {{ mode?: string, indexed?: number }|null|undefined} selection loadMemoryContext-shaped subset
 * @param {number} [recalled] memories fetched through recall_memories this job
 * @returns {string} e.g. "bodies ×9 · 1 recalled", "index ×14", "none ×0"
 */
function formatMemoryLabel(selection, recalled = 0) {
  const mode = String(selection?.mode || "none");
  const indexed = Math.max(0, Math.floor(Number(selection?.indexed) || 0));
  const fetched = Math.max(0, Math.floor(Number(recalled) || 0));
  return `${mode} ×${indexed}${fetched > 0 ? ` · ${fetched} recalled` : ""}`;
}

/**
 * EmbedBuilder → plain wire JSON. The audit builders are discord.js
 * EmbedBuilder instances: the Discord adapter serializes them natively,
 * the Fluxer OutboundClient expects NormalizedEmbed plain objects (same
 * rule as the reaction-roles service's toPlainEmbed, PR 9).
 *
 * @param {object} embed
 * @returns {object}
 */
function plainEmbed(embed) {
  return typeof embed?.toJSON === "function" ? embed.toJSON() : embed;
}

/**
 * Resolve the OutboundClient that posts audit embeds (gap #4, 2026-10-02):
 * - a Fluxer OutboundClient (duck-typed via `platform: "fluxer"` +
 *   `sendChannel`) is used as-is — Fluxer-only installs have no discord.js
 *   client, and `getDiscordOutbound` throws there (prod `.err`: "gork Q&A
 *   audit log failed: createDiscordOutbound requires a Discord client").
 * - a discord.js Client is wrapped with `getDiscordOutbound` (unchanged).
 * - null/undefined → null: audits degrade to the console one-liner, never throw.
 *
 * @param {import("discord.js").Client|object|null} client
 * @returns {{ sendChannel: Function, fetchChannel: Function }|null}
 */
function resolveAuditOutbound(client) {
  if (!client) return null;
  if (client.platform === "fluxer" && typeof client.sendChannel === "function") {
    return client;
  }
  return getDiscordOutbound(client);
}

/**
 * Settings-lookup key for the audit channel. Numeric community ids pass
 * through (Fluxer callers pass opts.communityId); strings are Discord
 * external guild ids, mapped at auditLog's edge. Fluxer call sites MUST
 * pass a numeric communityId — the Discord-only string mapping can never
 * resolve Fluxer external ids, and a null key degrades to console (safe).
 *
 * @param {object|null} client resolved audit client
 * @param {string|number} guildId
 * @param {{ communityId?: number }} opts
 * @returns {string|number|null}
 */
function auditSettingsKey(client, guildId, opts = {}) {
  if (client?.platform === "fluxer") {
    const cid = Number(opts.communityId);
    return Number.isSafeInteger(cid) ? cid : null;
  }
  return guildId;
}

/**
 * Jump options shared by the Q&A embed's jump fields (platform + webapp
 * base come from the resolved audit client; Discord keeps its fixed base).
 * @param {object|null} client
 * @returns {{ platform?: string, webappBaseUrl?: string|null }}
 */
function jumpOptsFor(client) {
  return {
    platform: client?.platform,
    webappBaseUrl: client?.platform === "fluxer" ? client.webappBaseUrl ?? null : null,
  };
}

/**
 * Build a "jump to message" URL for the audit client's platform, or null
 * when the message does not carry enough ids to construct one.
 *
 * @param {string} guildId
 * @param {object|null|undefined} message discord.js Message, Fluxer
 *   { id, channelId }-shaped subset, or the fluxerGorkAdapter view
 * @param {{ platform?: string, webappBaseUrl?: string|null }} [opts]
 * @returns {string|null}
 */
function messageJumpUrl(guildId, message, opts = {}) {
  if (!guildId || !message?.id) return null;
  const channelId = message.channelId || (message.channel && message.channel.id);
  if (!channelId) return null;
  return buildMessageJumpUrl({
    platform: opts.platform,
    guildId,
    channelId,
    messageId: message.id,
    webappBaseUrl: opts.webappBaseUrl,
  });
}

/**
 * Markdown link for a jump URL, or null when the URL is unavailable.
 * @param {string} label link text (e.g. "Question")
 * @param {string} guildId
 * @param {object} message
 * @param {object} [opts] messageJumpUrl options (platform/webapp base)
 * @returns {string|null}
 */
function jumpLink(label, guildId, message, opts = {}) {
  const url = messageJumpUrl(guildId, message, opts);
  return url ? `[${label}](${url})` : null;
}

/**
 * Post the "Gork Q&A" audit embed for a completed exchange.
 *
 * Never throws; a missing audit channel (or a failed send) degrades to a
 * one-line console log.
 *
 * @param {import("discord.js").Client|object|null} client  discord.js Client, a
 *   Fluxer OutboundClient (duck-typed via `platform: "fluxer"`, gap #4), or
 *   null (console-only audit)
 * @param {number} [opts.communityId]  numeric community id — required for
 *   audit-channel resolution on Fluxer (gap #4; a string guild id never
 *   resolves a Fluxer community)
 * @param {string} guildId
 * @param {object} opts
 * @param {import("discord.js").User} [opts.user] asker
 * @param {string} [opts.question] trigger question ("" = keyword alone)
 * @param {string} [opts.contextLabel] describeContext() output
 * @param {number} [opts.searchQueries] web_search tool executions (0 = none)
 * @param {number} [opts.pageReads] read_page tool executions (0 = none)
 * @param {number} [opts.linkReads] read_discord tool executions (0 = none, §7.19)
 * @param {string} [opts.model] AI model used
 * @param {number} [opts.durationMs] wall-clock ms of the LLM call
 * @param {string} [opts.answer] final answer text
 * @param {object} [opts.questionMessage] the keyword message (jump link)
 * @param {object} [opts.replyMessage] gork's reply message (jump link)
 * @param {string} [opts.memoryLabel] formatMemoryLabel() output; the
 *   inline "Memory" field is added only when this is a non-empty string
 *   (READ-SIDE only — extraction ran after this embed, §7.16.3)
 * @param {string} [opts.channelLabel] formatChannelLabel() output (e.g.
 *   "#general"); the inline "Channel" field is added only when this is a
 *   non-empty string (§7.18)
 * @param {string} [opts.budgetLabel] formatBudgetLabel() output (e.g.
 *   "3/5 in #general"); the inline "Budget" field is added only when this
 *   is a non-empty string — i.e. an effective cap >= 1 applied (§7.17.7,
 *   decision 37). Rejections never reach this embed (console-only).
 * @param {string} [opts.steLabel] "on"/"off" for the guild's STE answer
 *   style (§7.20, decision 52); the inline "STE" field is added only when
 *   this is a non-empty string. Q&A audits always set it.
 * @returns {Promise<void>}
 */
async function logGorkQa(client, guildId, opts = {}) {
  const {
    user,
    question,
    contextLabel,
    searchQueries,
    pageReads,
    linkReads,
    model,
    durationMs,
    answer,
    questionMessage,
    replyMessage,
    memoryLabel,
    channelLabel,
    budgetLabel,
    steLabel,
  } = opts;
  try {
    const embed = baseEmbed({ color: Color.brand, title: "Gork Q&A", timestamp: true });

    const askedBy = user?.id ? `<@${user.id}>` : "Unknown";
    const questionValue = question?.trim()
      ? truncateField(question, QUESTION_MAX_CHARS)
      : "(keyword only)";
    const searchValue = formatToolUsage(searchQueries, pageReads, linkReads);
    const durationSuffix =
      typeof durationMs === "number" && Number.isFinite(durationMs)
        ? ` / ${(durationMs / 1000).toFixed(1)}s`
        : "";
    const answerValue = answer?.trim()
      ? truncateField(answer, ANSWER_MAX_CHARS)
      : "(empty)";

    embed.addFields(
      { name: "Asked by", value: askedBy, inline: true },
      { name: "Question", value: questionValue, inline: false },
      { name: "Context", value: contextLabel || "—", inline: true },
      // §7.18: inline Channel field, only when the trigger supplied a
      // non-empty label (unknown channel → field absent entirely).
      ...(typeof channelLabel === "string" && channelLabel.trim()
        ? [{ name: "Channel", value: truncateField(channelLabel.trim(), 256), inline: true }]
        : []),
      { name: "Search", value: searchValue, inline: true },
      // §7.20 (decision 52): inline STE token, only when the trigger
      // supplied a non-empty label (Q&A audits always do).
      ...(typeof steLabel === "string" && steLabel.trim()
        ? [{ name: "STE", value: truncateField(steLabel.trim(), 16), inline: true }]
        : []),
      { name: "Model / duration", value: `${model || "unknown"}${durationSuffix}`, inline: true },
      { name: "Answer", value: answerValue, inline: false },
    );

    // §7.16.3: inline Memory field, only when the trigger supplied a
    // non-empty label (memory OFF → undefined → field absent entirely).
    if (typeof memoryLabel === "string" && memoryLabel.trim()) {
      embed.addFields({
        name: "Memory",
        value: truncateField(memoryLabel.trim(), 1024),
        inline: true,
      });
    }

    // §7.17.7: inline Budget field ("3/5 in #general"), only when an
    // effective cap >= 1 applied (unlimited/blocked → field absent).
    if (typeof budgetLabel === "string" && budgetLabel.trim()) {
      embed.addFields({
        name: "Budget",
        value: truncateField(budgetLabel.trim(), 1024),
        inline: true,
      });
    }

    // M2: Fluxer callers may pass a null jumpGuildId (no usable external
    // id) — the jump fields are then omitted, never built from the internal
    // community id (that would be a dead link).
    const jumpGid = opts.jumpGuildId === undefined ? guildId : opts.jumpGuildId;
    const links = [
      questionMessage ? jumpLink("Question", jumpGid, questionMessage, jumpOptsFor(client)) : null,
      replyMessage ? jumpLink("Reply", jumpGid, replyMessage, jumpOptsFor(client)) : null,
    ].filter(Boolean);
    if (links.length) {
      embed.addFields({ name: "Jump", value: links.join(" · ") });
    }

    const sent = await sendAuditLog(
      resolveAuditOutbound(client),
      auditSettingsKey(client, guildId, opts),
      { embeds: [plainEmbed(embed)] },
    );
    if (!sent) {
      console.log(
        `[gork] Q&A (no audit channel): ${askedBy} asked: ${truncateField(questionValue, 120)}`,
      );
    }
  } catch (err) {
    console.warn("[gork] Q&A audit log failed:", err?.message || err);
  }
}

/**
 * Post the compact one-liner audit for a failed / timed-out exchange.
 *
 * Never throws; a missing audit channel (or a failed send) degrades to a
 * one-line console log.
 *
 * @param {import("discord.js").Client|object|null} client  discord.js Client, a
 *   Fluxer OutboundClient (duck-typed via `platform: "fluxer"`, gap #4), or
 *   null (console-only audit)
 * @param {number} [opts.communityId]  numeric community id — required for
 *   audit-channel resolution on Fluxer (gap #4; a string guild id never
 *   resolves a Fluxer community)
 * @param {string} guildId
 * @param {object} opts
 * @param {import("discord.js").User} [opts.user] asker
 * @param {string} [opts.question] trigger question ("" = keyword alone)
 * @param {string} [opts.reason] failure reason (AI result error/reason)
 * @returns {Promise<void>}
 */
async function logGorkFailure(client, guildId, opts = {}) {
  const { user, question, reason } = opts;
  try {
    const askedBy = user?.id ? `<@${user.id}>` : "Unknown";
    const why = truncateField(reason || "unknown error", FAILURE_REASON_MAX_CHARS);
    const body = question?.trim()
      ? `${askedBy}: ${why} — question: ${truncateField(question, FAILURE_QUESTION_MAX_CHARS)}`
      : `${askedBy}: ${why}`;

    const embed = baseEmbed({
      color: Color.danger,
      title: "Gork Q&A",
      description: body,
      timestamp: true,
    });

    const sent = await sendAuditLog(
      resolveAuditOutbound(client),
      auditSettingsKey(client, guildId, opts),
      { embeds: [plainEmbed(embed)] },
    );
    if (!sent) {
      console.log(`[gork] failure (no audit channel): ${body}`);
    }
  } catch (err) {
    console.warn("[gork] failure audit log failed:", err?.message || err);
  }
}

/**
 * Post the compact "Gork memory" audit entry for the post-send
 * extraction turn (roadmap §7.16.3: memory writes get their own audit
 * entry — the Q&A embed above only carries the read-side label).
 *
 * Never throws; a missing audit channel (or a failed send) degrades to
 * a one-line console log, mirroring logGorkQa.
 *
 * @param {import("discord.js").Client|object|null} client  discord.js Client, a
 *   Fluxer OutboundClient (duck-typed via `platform: "fluxer"`, gap #4), or
 *   null (console-only audit)
 * @param {number} [opts.communityId]  numeric community id — required for
 *   audit-channel resolution on Fluxer (gap #4; a string guild id never
 *   resolves a Fluxer community)
 * @param {string} guildId
 * @param {object} stats
 * @param {number} [stats.indexed] memories indexed into the prompt
 * @param {number} [stats.stored] memories upserted by this turn
 * @param {number} [stats.skippedInvalid] extraction candidates dropped
 *   by the write-path validation (decision 25 counter)
 * @returns {Promise<void>}
 */
async function logGorkMemory(client, guildId, opts = {}) {
  const { indexed, stored, skippedInvalid } = opts;
  try {
    const count = (v) => Math.max(0, Math.floor(Number(v) || 0));
    const body = `Stored: +${count(stored)} · skipped_invalid: ${count(skippedInvalid)} · indexed: ${count(indexed)}`;
    const embed = baseEmbed({
      color: Color.brand,
      title: "Gork memory",
      description: body,
      timestamp: true,
    });

    const sent = await sendAuditLog(
      resolveAuditOutbound(client),
      auditSettingsKey(client, guildId, opts),
      { embeds: [plainEmbed(embed)] },
    );
    if (!sent) {
      console.log(`[gork] memory (no audit channel): ${body}`);
    }
  } catch (err) {
    console.warn("[gork] memory audit log failed:", err?.message || err);
  }
}

/**
 * Normalize a range anchor to a jump-link target: accepts a discord.js
 * Message, a { id, channelId } subset, or a bare message id (paired with
 * the resolved read channel). Returns null when nothing usable is given.
 *
 * @param {object|string|number|null|undefined} messageOrId
 * @param {string|null} [channelId] resolved read channel for bare ids
 * @returns {{ id: string, channelId: string|null }|null}
 */
function summarizeJumpTarget(messageOrId, channelId) {
  if (messageOrId && typeof messageOrId === "object") {
    return messageOrId.id ? messageOrId : null;
  }
  if (messageOrId != null && String(messageOrId).trim() !== "") {
    return { id: String(messageOrId).trim(), channelId: channelId ?? null };
  }
  return null;
}

/**
 * Render the `/gork summarize` mode for the audit "Mode" field
 * (roadmap §7.21.1's three discrete anchor modes, locked audit labels):
 * "from+to" (closed range) / "from->now" (anchor to newest) / "last:N".
 * Accepts the handler's canonical values ("from-to", "from-now", "last"
 * + count) leniently (punctuation/case-insensitive) so the audit never
 * records a label that isn't one of the three; unknown modes pass through
 * verbatim (never "—"-masked when a mode string exists).
 *
 * @param {unknown} mode raw mode value from the range reader/handler
 * @param {unknown} [lastCount] N for the `last:` mode
 * @returns {string} e.g. "from+to" / "from->now" / "last:250"
 */
function describeSummarizeMode(mode, lastCount) {
  const raw = typeof mode === "string" ? mode.trim() : mode != null ? String(mode) : "";
  if (!raw) return "—";
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key === "fromto" || key === "range" || key === "closed" || key === "closedrange") {
    return "from+to";
  }
  if (key === "fromnow" || key === "fromtonow" || key === "open" || key === "openrange") {
    return "from->now";
  }
  if (key.startsWith("last")) {
    const digits = /(\d+)/.exec(raw);
    const n = Math.floor(Number(lastCount)) || Number(digits?.[1]) || 0;
    return n > 0 ? `last:${n}` : raw;
  }
  return raw;
}

/**
 * Post the "Gork summarize" audit embed for a completed rundown (§7.21.5):
 * the summarize variant of the Q&A embed, recording the invocation mode
 * ("from+to" / "from->now" / "last:N"), the resolved range (read channel +
 * first/last message ids with jump links), the `focus:` steer (display-
 * capped), the `lang:` override, the invoker, and the outcome.
 *
 * Context-only signature: the handler (08) calls this AFTER the rundown
 * embed lands; this module never replies to Discord.
 *
 * Never throws; a missing audit channel (or a failed send) degrades to a
 * one-line console log, mirroring logGorkQa.
 *
 * @param {import("discord.js").Client|object|null} client  discord.js Client, a
 *   Fluxer OutboundClient (duck-typed via `platform: "fluxer"`, gap #4), or
 *   null (console-only audit)
 * @param {number} [opts.communityId]  numeric community id — required for
 *   audit-channel resolution on Fluxer (gap #4; a string guild id never
 *   resolves a Fluxer community)
 * @param {string} guildId
 * @param {object} opts
 * @param {import("discord.js").User} [opts.user] invoking staff member
 * @param {unknown} [opts.mode] range mode ("from-to" | "from-now" | "last", lenient)
 * @param {unknown} [opts.lastCount] N when mode is "last"
 * @param {string} [opts.channelLabel] formatChannelLabel() output of the READ channel
 * @param {string} [opts.channelId] resolved read channel id (fallback render)
 * @param {object|string} [opts.firstMessage] first message read (Message, {id, channelId} or bare id)
 * @param {object|string} [opts.lastMessage] last message read (same shapes)
 * @param {number} [opts.messageCount] messages actually read (disclosed clamp window)
 * @param {string} [opts.focus] `focus:` option text (display-capped)
 * @param {string} [opts.lang] `lang:` option text ("" → conversation language)
 * @param {string} [opts.model] AI model used; "Model / duration" field only when present
 * @param {number} [opts.durationMs] wall-clock ms of the generation call
 * @param {string} [opts.rundown] posted rundown text (excerpted); field omitted when absent
 * @param {object|string} [opts.replyMessage] posted rundown embed message (jump link)
 * @param {string} [opts.outcome] outcome label, default "posted"
 * @returns {Promise<void>}
 */
async function logGorkSummarize(client, guildId, opts = {}) {
  const {
    user,
    mode,
    lastCount,
    channelLabel,
    channelId,
    firstMessage,
    lastMessage,
    messageCount,
    focus,
    lang,
    model,
    durationMs,
    rundown,
    replyMessage,
    outcome,
  } = opts;
  try {
    const embed = baseEmbed({
      color: Color.brand,
      title: "Gork summarize",
      timestamp: true,
    });

    const requestedBy = user?.id ? `<@${user.id}>` : "Unknown";
    const modeLabel = describeSummarizeMode(mode, lastCount);
    const channelValue =
      typeof channelLabel === "string" && channelLabel.trim()
        ? truncateField(channelLabel.trim(), 256)
        : channelId
          ? `<#${channelId}>`
          : "—";

    // Resolved range: first → last with jump links (bare ids when the
    // target lacks channel info), plus the disclosed message count.
    const first = summarizeJumpTarget(firstMessage, channelId);
    const last = summarizeJumpTarget(lastMessage, channelId);
    const rangeParts = [];
    if (first?.id) {
      rangeParts.push(
        jumpLink(`first ${first.id}`, guildId, first) || `\`${first.id}\``,
      );
    }
    if (last?.id) {
      rangeParts.push(
        jumpLink(`last ${last.id}`, guildId, last) || `\`${last.id}\``,
      );
    }
    const count = Math.max(0, Math.floor(Number(messageCount) || 0));
    if (count > 0) rangeParts.push(`${count} msgs`);
    const rangeValue = rangeParts.length ? rangeParts.join(" → ") : "—";

    const focusValue =
      typeof focus === "string" && focus.trim()
        ? truncateField(focus.trim(), SUMMARIZE_FOCUS_DISPLAY_MAX)
        : "—";
    const langValue =
      typeof lang === "string" && lang.trim()
        ? truncateField(lang.trim(), SUMMARIZE_LANG_DISPLAY_MAX)
        : "(conversation language)";

    embed.addFields(
      { name: "Requested by", value: requestedBy, inline: true },
      { name: "Mode", value: truncateField(modeLabel, 256), inline: true },
      { name: "Channel", value: channelValue, inline: true },
      { name: "Range", value: truncateField(rangeValue, 1024), inline: false },
      { name: "Focus", value: focusValue, inline: true },
      { name: "Language", value: langValue, inline: true },
    );

    // Optional model/duration + rundown excerpt (same shape as the Q&A
    // embed's conditional fields — omitted entirely when not provided).
    if (typeof model === "string" && model.trim()) {
      const durationSuffix =
        typeof durationMs === "number" && Number.isFinite(durationMs)
          ? ` / ${(durationMs / 1000).toFixed(1)}s`
          : "";
      embed.addFields({
        name: "Model / duration",
        value: `${model.trim()}${durationSuffix}`,
        inline: true,
      });
    }
    if (typeof rundown === "string" && rundown.trim()) {
      embed.addFields({
        name: "Rundown",
        value: truncateField(rundown.trim(), SUMMARIZE_RUNDOWN_MAX_CHARS),
        inline: false,
      });
    }

    embed.addFields({
      name: "Outcome",
      value: truncateField(String(outcome || "posted").trim() || "posted", 256),
      inline: true,
    });

    const posted = summarizeJumpTarget(replyMessage, channelId);
    if (posted?.id) {
      const link = jumpLink("Rundown", guildId, posted);
      if (link) embed.addFields({ name: "Jump", value: link });
    }

    const sent = await sendAuditLog(
      resolveAuditOutbound(client),
      auditSettingsKey(client, guildId, opts),
      { embeds: [plainEmbed(embed)] },
    );
    if (!sent) {
      console.log(
        `[gork] summarize (no audit channel): ${requestedBy} ${modeLabel} in ${channelValue}`,
      );
    }
  } catch (err) {
    console.warn("[gork] summarize audit log failed:", err?.message || err);
  }
}

/**
 * Post the compact one-liner audit for a FAILED / never-posted `/gork
 * summarize` run — the summarize twin of logGorkFailure (§7.21.5): same
 * style, with the specific failure reason named (never a bare
 * "something failed"). The handler calls it for every failure branch it
 * surfaces to staff.
 *
 * Never throws; a missing audit channel (or a failed send) degrades to a
 * one-line console log.
 *
 * @param {import("discord.js").Client|object|null} client  discord.js Client, a
 *   Fluxer OutboundClient (duck-typed via `platform: "fluxer"`, gap #4), or
 *   null (console-only audit)
 * @param {number} [opts.communityId]  numeric community id — required for
 *   audit-channel resolution on Fluxer (gap #4; a string guild id never
 *   resolves a Fluxer community)
 * @param {string} guildId
 * @param {object} opts
 * @param {import("discord.js").User} [opts.user] invoking staff member
 * @param {unknown} [opts.mode] range mode (lenient, see describeSummarizeMode)
 * @param {unknown} [opts.lastCount] N when mode is "last"
 * @param {string} [opts.channelLabel] read-channel label (best effort)
 * @param {string} [opts.channelId] read channel id (fallback render)
 * @param {string} [opts.reason] specific failure reason to record
 * @returns {Promise<void>}
 */
async function logGorkSummarizeFailure(client, guildId, opts = {}) {
  const { user, mode, lastCount, channelLabel, channelId, reason } = opts;
  try {
    const requestedBy = user?.id ? `<@${user.id}>` : "Unknown";
    const why = truncateField(reason || "unknown error", FAILURE_REASON_MAX_CHARS);
    const modeLabel = describeSummarizeMode(mode, lastCount);
    const where =
      (typeof channelLabel === "string" && channelLabel.trim()) ||
      (channelId ? `#${channelId}` : "");
    const body = where
      ? `${requestedBy}: ${why} — mode: ${modeLabel} in ${where}`
      : `${requestedBy}: ${why} — mode: ${modeLabel}`;

    const embed = baseEmbed({
      color: Color.danger,
      title: "Gork summarize",
      description: body,
      timestamp: true,
    });

    const sent = await sendAuditLog(
      resolveAuditOutbound(client),
      auditSettingsKey(client, guildId, opts),
      { embeds: [plainEmbed(embed)] },
    );
    if (!sent) {
      console.log(`[gork] summarize failure (no audit channel): ${body}`);
    }
  } catch (err) {
    console.warn("[gork] summarize failure audit log failed:", err?.message || err);
  }
}

/**
 * Interaction-log row shape for `/gork summarize` jobs (§7.21.5, decision
 * 57): recorded on the migration-027 `gork_interactions` table through the
 * SAME createInteractionRecorder envelope the Q&A and memory-turn rows use
 * — no schema change, no new columns. The summarize marker is the `kind`
 * column (GORK_SUMMARIZE_INTERACTION_KIND) plus the `surface: "summarize"`
 * tag inside context_meta, so dashboards keep filtering by kind.
 *
 * Row contract (migration-027 columns only):
 * - kind: "summarize"; parent_uid: null (standalone job)
 * - guild/channel/user: from the slash invocation; message_id: the
 *   interaction id (summarize has no trigger message)
 * - trigger_content: "/gork summarize" (override with opts.triggerContent)
 * - context_meta: { surface, mode, last_count, resolved: { channel_id,
 *   first_message_id, last_message_id, collected, clamped }, focus, lang }
 * - settings: buildSettingsSnapshot(settings), same as Q&A rows
 *
 * Gated by the same isInteractionLogEnabled(settings) check as Q&A rows.
 * Returns null when disabled (or when the envelope fails to build — the
 * job must run regardless); never throws. The recorder itself stays
 * never-throw: the handler wires opts.onEvent into the one-shot AI call
 * and finalizes EXACTLY once per job (shipped / failure / error), like
 * trigger.js does for Q&A.
 *
 * @param {object} opts
 * @param {object|null} [opts.settings] getGuildSettings() result (drives the gate)
 * @param {number} [opts.communityId] internal communities id (row's `community_id`)
 * @param {string} [opts.channelId] invocation channel (fallback read channel)
 * @param {string} [opts.interactionId] slash interaction id → message_id column
 * @param {string} [opts.userId] invoking staff member
 * @param {unknown} [opts.mode] range mode (lenient, see describeSummarizeMode)
 * @param {unknown} [opts.lastCount] N when mode is "last"
 * @param {{ channelId?: string, firstMessageId?: string, lastMessageId?: string,
 *   collected?: number, clamped?: boolean }|null} [opts.range] resolved read window
 * @param {string} [opts.focus] `focus:` option text (bounded by the builder)
 * @param {string} [opts.lang] `lang:` option text
 * @param {string|null} [opts.model]
 * @param {object|null} [opts.params] sampling params as sent (JSON column)
 * @param {object[]|null} [opts.tools] tool schemas as sent — MVP null (no tool loop)
 * @param {string|null} [opts.system] exact system prompt as sent
 * @param {string|null} [opts.user] exact composed user content as sent
 * @param {string} [opts.triggerContent] invocation surface label, default "/gork summarize"
 * @param {number|null} [opts.startedAt] job start epoch-ms
 * @param {{ insertGorkInteraction: Function }} [opts.repo] db-facade override (tests)
 * @param {number} [opts.retentionDays] prune window override
 * @param {string} [opts.uid] recorder uid override (tests)
 * @param {Function} [opts.now] clock override
 * @returns {{ uid: string, onEvent: (evt: object) => void, finalize: (outcome: object) => {ok:boolean} }|null}
 *   null = logging disabled / build failed → skip recording entirely
 */
function createSummarizeInteractionRecorder(opts = {}) {
  const {
    settings = null,
    communityId = null,
    channelId = null,
    interactionId = null,
    userId = null,
    mode = null,
    lastCount = null,
    range = null,
    focus = null,
    lang = null,
    model = null,
    params = null,
    tools = null,
    system = null,
    user = null,
    triggerContent = null,
    startedAt = null,
    repo,
    retentionDays,
    uid,
    now,
  } = opts;
  try {
    if (!isInteractionLogEnabled(settings)) return null;
    const posInt = (v) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const resolvedChannelId =
      range?.channelId ?? range?.channel_id ?? channelId ?? null;
    const contextMeta = {
      surface: GORK_SUMMARIZE_INTERACTION_KIND,
      mode: describeSummarizeMode(mode, lastCount),
      last_count: posInt(lastCount),
      resolved: {
        channel_id: resolvedChannelId,
        first_message_id:
          range?.firstMessageId ?? range?.first_message_id ?? null,
        last_message_id:
          range?.lastMessageId ?? range?.last_message_id ?? null,
        collected: posInt(range?.collected ?? range?.messages_read) ?? 0,
        clamped: Boolean(range?.clamped),
      },
      focus:
        typeof focus === "string" && focus.trim()
          ? focus.trim().slice(0, SUMMARIZE_FOCUS_DISPLAY_MAX)
          : null,
      lang:
        typeof lang === "string" && lang.trim()
          ? lang.trim().slice(0, SUMMARIZE_LANG_DISPLAY_MAX)
          : null,
    };
    return createInteractionRecorder({
      kind: GORK_SUMMARIZE_INTERACTION_KIND,
      communityId,
      channelId: resolvedChannelId,
      messageId: interactionId,
      userId,
      triggerContent: triggerContent || "/gork summarize",
      model,
      params,
      tools,
      settings: buildSettingsSnapshot(settings),
      system,
      user,
      contextMeta,
      startedAt,
      repo,
      retentionDays,
      uid,
      now,
    });
  } catch (err) {
    console.warn(
      `[gork] summarize interaction log recorder build failed (community=${communityId ?? "none"} interaction=${interactionId ?? "none"}):`,
      err?.message || err,
    );
    return null;
  }
}

module.exports = {
  describeContext,
  formatToolUsage,
  formatMemoryLabel,
  logGorkQa,
  logGorkFailure,
  logGorkMemory,
  describeSummarizeMode,
  logGorkSummarize,
  logGorkSummarizeFailure,
  createSummarizeInteractionRecorder,
  GORK_SUMMARIZE_INTERACTION_KIND,
  SUMMARIZE_FOCUS_DISPLAY_MAX,
  SUMMARIZE_RUNDOWN_MAX_CHARS,
};
