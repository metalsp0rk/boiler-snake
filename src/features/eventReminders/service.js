/**
 * Pure helpers + Discord-facing role sync / cleanup for event reminders.
 */

const {
  PermissionFlagsBits,
  GuildScheduledEventStatus,
  EmbedBuilder,
} = require("discord.js");
const { Color, tsRelativeFull } = require("../../core/theme");
const {
  getConfigByScheduledEventId,
  getEventReminderConfigById,
  getConfigByShortname,
  clearEventReminderConfig,
  clearEventReminderConfigById,
  isUserBlockedFromEventReminders,
  listEventReminderConfigs,
  setOffsetFireTimes,
  getGuildSettings,
} = require("../../db");

const MAX_OFFSETS = 8;
const MAX_OFFSET_MINUTES = 30 * 24 * 60; // 30 days
const ROLE_PREFIX = "event-";
/** Used when a custom template is set (embed description body). */
const DEFAULT_MESSAGE = "Starts {starts_in} ({starts_at}) in {location}.";
/** Embed description when message_template is empty. */
const DEFAULT_EMBED_DESCRIPTION = "Starts {starts_in}";
const EMBED_COLOR = Color.brand;
const DESCRIPTION_MAX = 300;

/** Preset offset options for the create/edit modal (minutes → label). */
const OFFSET_PRESETS = [
  { minutes: 10080, label: "1 week" },
  { minutes: 1440, label: "1 day" },
  { minutes: 60, label: "1 hour" },
  { minutes: 30, label: "30 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 5, label: "5 min" },
];

const DEFAULT_PRESET_MINUTES = new Set([1440, 60, 15]);

/**
 * @param {string} title
 * @returns {string}
 */
function slugifyShortname(title) {
  const raw = String(title || "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return raw || "event";
}

/**
 * Prefill shortname from event title; append -2, -3, … if already taken.
 * @param {string} guildId
 * @param {string} eventName
 * @returns {string}
 */
function suggestShortname(guildId, eventName) {
  const base = slugifyShortname(eventName);
  if (!getConfigByShortname(guildId, base)) return base;

  for (let n = 2; n <= 99; n++) {
    const suffix = `-${n}`;
    const maxBase = Math.max(1, 80 - suffix.length);
    const candidate = `${base.slice(0, maxBase)}${suffix}`;
    if (!getConfigByShortname(guildId, candidate)) return candidate;
  }
  return base;
}

/**
 * @param {string} input
 * @returns {{ ok: true, shortname: string } | { ok: false, error: string }}
 */
function normalizeShortname(input) {
  const s = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/^event-/, "");
  if (!s) return { ok: false, error: "Shortname is required." };
  if (!/^[a-z0-9-]+$/.test(s)) {
    return {
      ok: false,
      error: "Shortname must be lowercase letters, numbers, and hyphens only.",
    };
  }
  if (s.length > 80) {
    return { ok: false, error: "Shortname is too long (max 80)." };
  }
  return { ok: true, shortname: s };
}

/**
 * Parse freeform offsets like `2h, 10m, 1d`.
 * @param {string} text
 * @returns {number[]} minutes
 */
function parseCustomOffsets(text) {
  if (!text || !String(text).trim()) return [];
  const out = [];
  const re = /(\d+)\s*([mhd])/gi;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = m[2].toLowerCase();
    let minutes = n;
    if (unit === "h") minutes = n * 60;
    if (unit === "d") minutes = n * 24 * 60;
    out.push(minutes);
  }
  return out;
}

/**
 * Union presets + custom, dedupe, cap, validate lookback.
 * @param {number[]} presetMinutes
 * @param {string} customText
 * @returns {{ ok: true, minutes: number[] } | { ok: false, error: string }}
 */
function resolveOffsetMinutes(presetMinutes, customText) {
  const set = new Set();
  for (const m of presetMinutes || []) {
    const n = Number(m);
    if (Number.isFinite(n) && n > 0) set.add(Math.floor(n));
  }
  for (const m of parseCustomOffsets(customText)) {
    set.add(m);
  }

  const minutes = [...set].sort((a, b) => b - a);
  if (!minutes.length) {
    return {
      ok: false,
      error: "Select or enter at least one reminder offset.",
    };
  }
  if (minutes.length > MAX_OFFSETS) {
    return {
      ok: false,
      error: `Too many offsets (max ${MAX_OFFSETS}). Remove some presets or custom times.`,
    };
  }
  for (const m of minutes) {
    if (m > MAX_OFFSET_MINUTES) {
      return {
        ok: false,
        error: `Offset of ${formatOffsetMinutes(m)} exceeds the 30-day maximum.`,
      };
    }
  }
  return { ok: true, minutes };
}

/**
 * Build offset rows from minutes + event start; drops past fires.
 * @param {number[]} minutes
 * @param {number} eventStartMs
 * @param {number} [nowMs]
 * @returns {{ offsets: { offsetMinutes: number, fireAt: number }[], skippedPast: number }}
 */
function buildOffsetRows(minutes, eventStartMs, nowMs = Date.now()) {
  const offsets = [];
  let skippedPast = 0;
  for (const offsetMinutes of minutes) {
    const fireAt = eventStartMs - offsetMinutes * 60_000;
    if (fireAt <= nowMs) {
      skippedPast += 1;
      continue;
    }
    offsets.push({ offsetMinutes, fireAt });
  }
  return { offsets, skippedPast };
}

/**
 * @param {number} minutes
 */
function formatOffsetMinutes(minutes) {
  const m = Number(minutes) || 0;
  if (m % (24 * 60) === 0) {
    const d = m / (24 * 60);
    return d === 1 ? "1 day" : `${d} days`;
  }
  if (m % 60 === 0) {
    const h = m / 60;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return m === 1 ? "1 min" : `${m} min`;
}

/**
 * Resolve a display string for an event's location.
 * - Voice/stage (channel-hosted): channel mention `<#id>`
 * - External: plain `entityMetadata.location` text
 * - Unknown / unset: empty string (so templates can omit awkwardly empty spots)
 *
 * @param {{ channelId?: string|null, entityMetadata?: { location?: string|null }|null }|null} scheduledEvent
 * @returns {string}
 */
function formatEventLocation(scheduledEvent) {
  if (!scheduledEvent) return "";
  const channelId =
    scheduledEvent.channelId ?? scheduledEvent.channel_id ?? null;
  if (channelId) return `<#${channelId}>`;
  const external =
    scheduledEvent.entityMetadata?.location ??
    scheduledEvent.entity_metadata?.location ??
    null;
  if (external && String(external).trim()) return String(external).trim();
  return "";
}

/**
 * @param {string} guildId
 * @param {string} eventId
 * @returns {string}
 */
function eventUrl(guildId, eventId) {
  if (!guildId || !eventId) return "";
  return `https://discord.com/events/${guildId}/${eventId}`;
}

/**
 * Truncate event description for embed/template use.
 * @param {{ description?: string|null }|null} scheduledEvent
 * @param {number} [maxLen]
 * @returns {string}
 */
function formatEventDescription(scheduledEvent, maxLen = DESCRIPTION_MAX) {
  const raw = scheduledEvent?.description;
  if (!raw || !String(raw).trim()) return "";
  const text = String(raw).trim().replace(/\s+/g, " ");
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Cover image URL if Discord provides one.
 * @param {{ coverImageURL?: Function, image?: string|null }|null} scheduledEvent
 * @returns {string|null}
 */
function eventCoverImageUrl(scheduledEvent) {
  if (!scheduledEvent) return null;
  try {
    if (typeof scheduledEvent.coverImageURL === "function") {
      const url = scheduledEvent.coverImageURL({ size: 1024 });
      if (url) return url;
    }
  } catch {
    // ignore
  }
  if (scheduledEvent.image && String(scheduledEvent.image).trim()) {
    return String(scheduledEvent.image).trim();
  }
  return null;
}

/**
 * @param {string|null|undefined} template
 * @param {{
 *   eventName: string,
 *   startMs: number,
 *   roleId: string,
 *   location?: string,
 *   url?: string,
 *   description?: string,
 *   offset?: string,
 * }} ctx
 * @param {{ defaultBody?: string }} [opts]
 */
function renderReminderMessage(template, ctx, opts = {}) {
  const startUnix = Math.floor(ctx.startMs / 1000);
  const fallback = opts.defaultBody ?? DEFAULT_MESSAGE;
  const body = (template && String(template).trim()) || fallback;
  let out = body
    .replaceAll("{event}", ctx.eventName || "Event")
    .replaceAll("{starts_in}", `<t:${startUnix}:R>`)
    .replaceAll("{starts_at}", `<t:${startUnix}:F>`)
    .replaceAll("{role}", ctx.roleId ? `<@&${ctx.roleId}>` : "")
    .replaceAll("{location}", ctx.location ?? "")
    .replaceAll("{url}", ctx.url ?? "")
    .replaceAll("{description}", ctx.description ?? "")
    .replaceAll("{offset}", ctx.offset ?? "");

  // Drop awkward " in " when location is empty (default template and similar).
  out = out
    .replace(/\s+in\s+(?=[.!?])/g, "")
    .replace(/\s+in\s+$/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return out;
}

/**
 * Build the always-on embed for a reminder delivery.
 * Role ping must stay in message content (mentions in embeds do not notify).
 *
 * @param {object} opts
 * @param {object|null} opts.scheduledEvent
 * @param {string} opts.guildId
 * @param {string} opts.roleId
 * @param {number} opts.offsetMinutes
 * @param {string|null|undefined} opts.template
 * @param {number} opts.startMs
 * @returns {import("discord.js").EmbedBuilder}
 */
function buildReminderEmbed(opts) {
  const { scheduledEvent, guildId, roleId, offsetMinutes, template, startMs } =
    opts;

  const eventName = scheduledEvent?.name || "Event";
  const eventId = scheduledEvent?.id || null;
  const location = formatEventLocation(scheduledEvent);
  const url = eventUrl(guildId, eventId);
  const descriptionText = formatEventDescription(scheduledEvent);
  const offsetLabel = formatOffsetMinutes(offsetMinutes);
  const startUnix = Math.floor(startMs / 1000);

  const ctx = {
    eventName,
    startMs,
    roleId,
    location,
    url,
    description: descriptionText,
    offset: offsetLabel,
  };

  const hasCustom = !!(template && String(template).trim());
  const body = renderReminderMessage(template, ctx, {
    defaultBody: hasCustom ? DEFAULT_MESSAGE : DEFAULT_EMBED_DESCRIPTION,
  });

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(String(eventName).slice(0, 256))
    .setFooter({ text: "Event reminder" });

  if (url) embed.setURL(url);
  if (body) embed.setDescription(body.slice(0, 4096));

  const fields = [];
  fields.push({
    name: "Starts",
    value: tsRelativeFull(startMs),
    inline: false,
  });
  if (location) {
    fields.push({
      name: "Location",
      value: location.slice(0, 1024),
      inline: true,
    });
  }
  if (offsetLabel) {
    fields.push({
      name: "Reminder",
      value: `${offsetLabel} before start`,
      inline: true,
    });
  }
  if (fields.length) embed.addFields(fields);

  const cover = eventCoverImageUrl(scheduledEvent);
  if (cover) embed.setImage(cover);

  return embed;
}

/**
 * Payload for channel.send — content pings the role; embed carries details.
 * @param {object} opts
 * @returns {{ content: string, embeds: import("discord.js").EmbedBuilder[], allowedMentions: object }}
 */
function buildReminderDelivery(opts) {
  const embed = buildReminderEmbed(opts);
  return {
    content: `<@&${opts.roleId}>`,
    embeds: [embed],
    allowedMentions: { roles: [opts.roleId] },
  };
}

/**
 * ManageGuild or scheduled event creator.
 * @param {import("discord.js").GuildMember | { permissions?: { has: Function }, id?: string }} member
 * @param {{ creatorId?: string|null }|null} scheduledEvent
 * @returns {boolean}
 */
function canConfigureEventReminder(member, scheduledEvent) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  if (
    scheduledEvent?.creatorId &&
    member.id &&
    member.id === scheduledEvent.creatorId
  ) {
    return true;
  }
  return false;
}

/**
 * Resolve notify channel id for a config.
 * @param {string} guildId
 * @param {string|null} configChannelId
 */
function resolveNotifyChannelId(guildId, configChannelId) {
  if (configChannelId) return configChannelId;
  const settings = getGuildSettings(guildId);
  return settings.event_reminder_channel_id || null;
}

/**
 * @param {import("discord.js").Guild} guild
 * @param {string} shortname
 * @param {string} [reason]
 */
function findRoleByName(guild, name) {
  const cache = guild?.roles?.cache;
  if (!cache) return null;
  if (typeof cache.find === "function") {
    return cache.find((r) => r.name === name) || null;
  }
  for (const role of cache.values()) {
    if (role.name === name) return role;
  }
  return null;
}

async function createReminderRole(guild, shortname, reason) {
  const name = `${ROLE_PREFIX}${shortname}`;
  const existing = findRoleByName(guild, name);
  if (existing) {
    // Only reuse if we already track this role id in DB (caller should check).
    // Otherwise refuse — orphaned name collision.
    const err = new Error(`ROLE_NAME_IN_USE:${name}`);
    err.code = "ROLE_NAME_IN_USE";
    err.roleName = name;
    throw err;
  }
  return guild.roles.create({
    name,
    mentionable: false,
    hoist: false,
    reason: reason || "Event reminder role",
  });
}

/**
 * @param {import("discord.js").Guild} guild
 * @param {string} roleId
 */
async function deleteReminderRole(guild, roleId) {
  if (!guild || !roleId) return;
  try {
    const role =
      guild.roles.cache.get(roleId) ||
      (await guild.roles.fetch(roleId).catch(() => null));
    if (role) await role.delete("Event reminder cleanup");
  } catch (err) {
    console.error(
      `[eventReminders] Failed deleting role ${roleId} in guild ${guild.id}:`,
      err?.message || err,
    );
  }
}

/**
 * Fetch interested user IDs for a scheduled event.
 * @param {import("discord.js").GuildScheduledEvent} scheduledEvent
 * @returns {Promise<string[]>}
 */
async function fetchInterestedUserIds(scheduledEvent) {
  if (!scheduledEvent?.fetchSubscribers) return [];
  const ids = new Set();
  let after;
  // Paginate until empty (Discord returns up to 100 per page).
  for (let i = 0; i < 50; i++) {
    const page = await scheduledEvent.fetchSubscribers({
      limit: 100,
      ...(after ? { after } : {}),
    });
    if (!page?.size) break;
    for (const [userId] of page) {
      ids.add(userId);
      after = userId;
    }
    if (page.size < 100) break;
  }
  return [...ids];
}

/**
 * Grant/remove role so members match interested ∩ ¬blocked (guild opt-out or mute).
 * @param {import("discord.js").Guild} guild
 * @param {import("discord.js").GuildScheduledEvent} scheduledEvent
 * @param {string} roleId
 */
async function syncEventReminderRole(guild, scheduledEvent, roleId) {
  if (!guild || !roleId) return { granted: 0, removed: 0 };

  const eventId = scheduledEvent?.id;
  if (!eventId) return { granted: 0, removed: 0 };

  const interested = new Set(await fetchInterestedUserIds(scheduledEvent));
  const shouldHave = new Set();
  for (const userId of interested) {
    if (isUserBlockedFromEventReminders(guild.id, userId, eventId)) continue;
    shouldHave.add(userId);
  }

  let granted = 0;
  let removed = 0;

  // Grant
  for (const userId of shouldHave) {
    try {
      const member =
        guild.members.cache.get(userId) ||
        (await guild.members.fetch(userId).catch(() => null));
      if (!member || member.user?.bot) continue;
      if (!member.roles.cache.has(roleId)) {
        await member.roles.add(roleId, "Event reminder interest sync");
        granted += 1;
      }
    } catch (err) {
      console.error(
        `[eventReminders] grant role failed guild=${guild.id} user=${userId}:`,
        err?.message || err,
      );
    }
  }

  // Remove from members who hold the role but shouldn't
  try {
    const role =
      guild.roles.cache.get(roleId) ||
      (await guild.roles.fetch(roleId).catch(() => null));
    const holders = role?.members;
    if (holders) {
      for (const [userId, member] of holders) {
        if (shouldHave.has(userId)) continue;
        try {
          await member.roles.remove(roleId, "Event reminder interest sync");
          removed += 1;
        } catch (err) {
          console.error(
            `[eventReminders] remove role failed guild=${guild.id} user=${userId}:`,
            err?.message || err,
          );
        }
      }
    } else {
      // Fallback: scan guild member cache
      for (const member of guild.members.cache.values()) {
        if (!member.roles.cache.has(roleId)) continue;
        if (shouldHave.has(member.id)) continue;
        try {
          await member.roles.remove(roleId, "Event reminder interest sync");
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    console.error(
      `[eventReminders] role holder scan failed guild=${guild.id}:`,
      err?.message || err,
    );
  }

  return { granted, removed };
}

/**
 * Grant role for a single user if eligible (not guild-opted-out, not muted for event).
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 * @param {string} roleId
 * @param {string} scheduledEventId
 */
async function grantRoleIfEligible(guild, userId, roleId, scheduledEventId) {
  if (
    scheduledEventId &&
    isUserBlockedFromEventReminders(guild.id, userId, scheduledEventId)
  ) {
    return false;
  }
  try {
    const member =
      guild.members.cache.get(userId) ||
      (await guild.members.fetch(userId).catch(() => null));
    if (!member || member.user?.bot) return false;
    if (member.roles.cache.has(roleId)) return false;
    await member.roles.add(roleId, "Event reminder interest");
    return true;
  } catch (err) {
    console.error(
      `[eventReminders] grant failed guild=${guild.id} user=${userId}:`,
      err?.message || err,
    );
    return false;
  }
}

/**
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 * @param {string} roleId
 */
async function removeRoleSafe(guild, userId, roleId) {
  try {
    const member =
      guild.members.cache.get(userId) ||
      (await guild.members.fetch(userId).catch(() => null));
    if (!member) return;
    if (!member.roles.cache.has(roleId)) return;
    await member.roles.remove(roleId, "Event reminder interest removed");
  } catch (err) {
    console.error(
      `[eventReminders] remove failed guild=${guild.id} user=${userId}:`,
      err?.message || err,
    );
  }
}

/**
 * Strip all bot-managed event reminder roles from a member (opt-out).
 * @param {import("discord.js").Guild} guild
 * @param {string} userId
 */
async function stripAllEventReminderRoles(guild, userId) {
  const roleIds = listEventReminderConfigs(guild.id, { activeOnly: true }).map(
    (c) => c.role_id,
  );
  for (const roleId of roleIds) {
    await removeRoleSafe(guild, userId, roleId);
  }
}

/**
 * Full cleanup: delete Discord role + DB config.
 * @param {import("discord.js").Guild} guild
 * @param {string} scheduledEventId
 * @param {{ force?: boolean }} [opts] if persistent and not forced, skips cleanup
 */
async function cleanupEventReminder(guild, scheduledEventId, opts = {}) {
  if (!guild || !scheduledEventId) return null;
  const config = getConfigByScheduledEventId(guild.id, scheduledEventId);
  if (config?.persistent && !opts.force) return null;
  const cleared = clearEventReminderConfig(guild.id, scheduledEventId);
  if (!cleared) return null;
  await deleteReminderRole(guild, cleared.role_id);
  return cleared;
}

/**
 * @param {import("discord.js").Guild} guild
 * @param {number} configId
 * @param {{ force?: boolean }} [opts] if persistent and not forced, skips cleanup
 */
async function cleanupEventReminderByConfigId(guild, configId, opts = {}) {
  const config = getEventReminderConfigById(configId);
  if (config?.persistent && !opts.force) return null;
  const cleared = clearEventReminderConfigById(configId);
  if (!cleared) return null;
  if (guild) await deleteReminderRole(guild, cleared.role_id);
  return cleared;
}

/**
 * @param {import("discord.js").GuildScheduledEvent} event
 */
function isEventTerminal(event) {
  if (!event) return true;
  const status = event.status;
  return (
    status === GuildScheduledEventStatus.Completed ||
    status === GuildScheduledEventStatus.Canceled
  );
}

/**
 * @param {import("discord.js").GuildScheduledEvent} event
 * @returns {number|null} start ms
 */
function eventStartMs(event) {
  if (!event) return null;
  const ts = event.scheduledStartTimestamp;
  if (ts != null) return Number(ts);
  if (event.scheduledStartAt) return new Date(event.scheduledStartAt).getTime();
  return null;
}

/**
 * Recompute unsent fire times after event reschedule.
 * @param {string} guildId
 * @param {string} scheduledEventId
 * @param {number} startMs
 */
function rescheduleUnsentOffsets(guildId, scheduledEventId, startMs) {
  const config = getConfigByScheduledEventId(guildId, scheduledEventId);
  if (!config) return;
  setOffsetFireTimes(config.id, startMs);
}

module.exports = {
  MAX_OFFSETS,
  MAX_OFFSET_MINUTES,
  ROLE_PREFIX,
  DEFAULT_MESSAGE,
  DEFAULT_EMBED_DESCRIPTION,
  EMBED_COLOR,
  OFFSET_PRESETS,
  DEFAULT_PRESET_MINUTES,
  slugifyShortname,
  suggestShortname,
  normalizeShortname,
  parseCustomOffsets,
  resolveOffsetMinutes,
  buildOffsetRows,
  formatOffsetMinutes,
  formatEventLocation,
  formatEventDescription,
  eventUrl,
  eventCoverImageUrl,
  renderReminderMessage,
  buildReminderEmbed,
  buildReminderDelivery,
  canConfigureEventReminder,
  resolveNotifyChannelId,
  createReminderRole,
  deleteReminderRole,
  fetchInterestedUserIds,
  syncEventReminderRole,
  grantRoleIfEligible,
  removeRoleSafe,
  stripAllEventReminderRoles,
  cleanupEventReminder,
  cleanupEventReminderByConfigId,
  isEventTerminal,
  eventStartMs,
  rescheduleUnsentOffsets,
};
