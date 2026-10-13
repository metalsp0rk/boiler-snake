/**
 * Cross-community event posting (epic #218, phase 5, E12/E13-adjacent).
 *
 * A pair (source → destination) is created by `/event crosspost invite`
 * (source staff) and completed by `/event crosspost approve <code>` (dest
 * staff). On post, the event fans out to every ACTIVE destination as a
 * read-only copy: the buttons still write to the SOURCE event, gated by the
 * pair's `role_whitelist` (destination-side roles). Edits sync the copy
 * body; deletes remove it.
 *
 * `post_offset_minutes` delays the destination copy — scheduled via the
 * `event_crosspost_messages` row with an empty `dest_message_id` sentinel,
 * delivered by the ticker when due (survives restarts; delivery re-renders
 * current content, so an edit before delivery wins).
 */
const repo = require("../../db/repositories/events");
const { baseEmbed, truncateField, tsFull, tsRelative, Color } = require("../../core/theme");
const { getCommunityById } = require("../../platform/community");
const service = require("./service");

const PENDING_SENTINEL = "";

function heldRoleIds(member) {
  const cache = member?.roles?.cache;
  if (!cache || typeof cache.keys !== "function") return [];
  return [...cache.keys()].map(String);
}

/** Banner explaining where a copy came from (never leaks member lists). */
function sourceBanner(sourceEvent, sourceCommunityRow) {
  const name = sourceCommunityRow?.label || sourceCommunityRow?.name || `community ${sourceEvent.community_id}`;
  return `📡 Copied from **${name}** — signups count toward the original event${
    service.messageLink(sourceEvent) ? `: ${service.messageLink(sourceEvent)}` : ""
  }`;
}

/** Render + send one destination copy. */
async function sendCopy(client, pair, event) {
  const destCommunity = getCommunityById(pair.dest_community_id);
  const guild = await service.guildFor(client, pair.dest_community_id);
  if (!guild) return { ok: false, error: `destination guild for pair ${pair.id} is not reachable` };
  const channelId = pair.dest_channel_id || event.channel_id;
  const channel =
    guild.channels?.cache?.get(String(channelId)) ??
    (await guild.channels?.fetch?.(String(channelId)).catch(() => null));
  if (!channel || typeof channel.send !== "function") {
    return { ok: false, error: `destination channel <#${channelId}> for pair ${pair.id} not found or unsendable` };
  }
  const payload = service.renderEventPayload(event, { guild });
  const banner = sourceBanner(event, destCommunity);
  const mentionIds = (pair.mentions || [])
    .map(String)
    .filter((r) => guild.roles?.cache?.has(r));
  try {
    const sent = await channel.send({
      ...payload,
      content: mentionIds.length ? mentionIds.map((r) => `<@&${r}>`).join(" ") : null,
      embeds: [baseEmbed({ description: truncateField(banner), color: Color.brand }), ...(payload.embeds || [])],
      allowedMentions: { roles: mentionIds, users: [], parse: [] },
    });
    repo.recordEventCrosspostMessage({
      crosspostId: pair.id,
      eventId: event.id,
      destCommunityId: pair.dest_community_id,
      destChannelId: channel.id,
      destMessageId: sent.id,
    });
    return { ok: true, messageId: sent.id };
  } catch (err) {
    return { ok: false, error: `destination send failed for pair ${pair.id}: ${err?.message || err}` };
  }
}

/**
 * Fan out a freshly posted event. Called from service.postEventNow; every
 * failure degrades to a warning string.
 */
async function fanoutOnPost(client, event) {
  const warnings = [];
  if (event.crosspost_source_id) return { warnings: [], skipped: "copy of another event" };
  let pairs = [];
  try {
    pairs = repo.listActiveCrosspostsForSource(event.community_id);
  } catch (err) {
    return { warnings: [`cross-post lookup failed: ${err?.message || err}`] };
  }
  for (const pair of pairs) {
    try {
      const offset = Math.max(0, Number(pair.post_offset_minutes) || 0);
      if (offset > 0) {
        // Schedule instead of send: row with the sentinel id; the ticker
        // delivers when created_at + offset has passed.
        repo.recordEventCrosspostMessage({
          crosspostId: pair.id,
          eventId: event.id,
          destCommunityId: pair.dest_community_id,
          destChannelId: pair.dest_channel_id || event.channel_id,
          destMessageId: PENDING_SENTINEL,
        });
        continue;
      }
      const res = await sendCopy(client, pair, event);
      if (!res.ok) warnings.push(res.error);
    } catch (err) {
      warnings.push(`cross-post fan-out failed for pair ${pair.id}: ${err?.message || err}`);
    }
  }
  return { warnings };
}

/**
 * Sync every destination copy after an edit/refresh. Pending (offset) rows
 * are left alone — delivery re-renders current content anyway.
 */
async function syncEventMessages(client, event) {
  let updated = 0;
  const warnings = [];
  const rows = repo.listEventCrosspostMessagesForEvent(event.id);
  for (const row of rows) {
    if (row.dest_message_id === PENDING_SENTINEL) continue;
    try {
      const destGuild = await service.guildFor(client, row.dest_community_id);
      const channel = destGuild?.channels?.cache?.get(String(row.dest_channel_id))
        ?? (await destGuild?.channels?.fetch?.(String(row.dest_channel_id)).catch(() => null));
      const msg = channel?.messages?.cache?.get(String(row.dest_message_id))
        ?? (await channel?.messages?.fetch?.(String(row.dest_message_id)).catch(() => null));
      if (!msg) {
        warnings.push(`destination copy ${row.dest_message_id} in <#${row.dest_channel_id}> is gone`);
        continue;
      }
      const payload = service.renderEventPayload(event, { guild: destGuild });
      await msg.edit(payload);
      updated += 1;
    } catch (err) {
      if (service.isGoneError(err)) continue;
      warnings.push(`could not sync destination copy ${row.dest_message_id}: ${err?.message || err}`);
    }
  }
  return { updated, warnings };
}

/** Delete destination copies (event deleted). */
async function deleteEventMessages(client, event) {
  const warnings = [];
  const rows = repo.listEventCrosspostMessagesForEvent(event.id);
  for (const row of rows) {
    if (row.dest_message_id === PENDING_SENTINEL) continue;
    try {
      const destGuild = await service.guildFor(client, row.dest_community_id);
      const channel = destGuild?.channels?.cache?.get(String(row.dest_channel_id))
        ?? (await destGuild?.channels?.fetch?.(String(row.dest_channel_id)).catch(() => null));
      const msg = channel?.messages?.cache?.get(String(row.dest_message_id))
        ?? (await channel?.messages?.fetch?.(String(row.dest_message_id)).catch(() => null));
      if (msg && typeof msg.delete === "function") await msg.delete();
    } catch (err) {
      if (!service.isGoneError(err)) {
        warnings.push(`could not delete destination copy ${row.dest_message_id}: ${err?.message || err}`);
      }
    }
  }
  repo.deleteEventCrosspostMessagesForEvent(event.id);
  return { warnings };
}

/**
 * Ticker step: deliver offset-pending destination copies whose due passed.
 */
async function deliverPending(client, nowMs = Date.now()) {
  let delivered = 0;
  let warnings = 0;
  for (const eventId of pendingEventIds()) {
    const event = repo.getEventById(eventId);
    if (!event || event.status !== "posted") {
      repo.deleteEventCrosspostMessagesForEvent(eventId);
      continue;
    }
    for (const row of repo.listEventCrosspostMessagesForEvent(eventId)) {
      if (row.dest_message_id !== PENDING_SENTINEL) continue;
      const pair = repo.getEventCrosspostById(row.crosspost_id);
      if (!pair || pair.state !== "active") {
        dropPendingRow(row);
        continue;
      }
      const dueAt = row.created_at + Math.max(0, Number(pair.post_offset_minutes) || 0) * 60_000;
      if (dueAt > nowMs) continue;
      dropPendingRow(row); // claim: remove before sending (at-most-once)
      const res = await sendCopy(client, pair, event);
      if (res.ok) delivered += 1;
      else {
        warnings += 1;
        console.error(`[events] pending crosspost event=${eventId} pair=${pair.id}: ${res.error}`);
      }
    }
  }
  return { delivered, warnings };
}

function raw() {
  return require("../../db").db;
}

/** Event ids that have pending destination copies (sentinel rows). */
function pendingEventIds() {
  return raw()
    .prepare(
      `SELECT DISTINCT event_id FROM event_crosspost_messages WHERE dest_message_id = ''`
    )
    .all()
    .map((r) => r.event_id);
}

function dropPendingRow(row) {
  raw().prepare(
    `DELETE FROM event_crosspost_messages
      WHERE crosspost_id = ? AND event_id = ? AND dest_message_id = ''`
  ).run(row.crosspost_id, row.event_id);
}

/**
 * Is this user allowed to sign up through a destination copy? Active pair +
 * (empty whitelist OR holds one of the destination-side whitelist roles).
 */
function canSignupFromDestination(pair, member) {
  if (!pair || pair.state !== "active") return { ok: false, error: "This cross-post is no longer active." };
  const whitelist = (pair.role_whitelist || []).map(String);
  if (!whitelist.length) return { ok: true };
  const held = heldRoleIds(member).map(String);
  if (whitelist.some((r) => held.includes(r))) return { ok: true };
  return {
    ok: false,
    error: `You need one of these roles to sign up in this server: ${whitelist.map((r) => `<@&${r}>`).join(" ")}.`,
  };
}

/** Find the active pair whose destination is `destCommunityId` for a source event. */
function pairForCopy(sourceCommunityId, destCommunityId) {
  return repo.getEventCrosspostByPair(sourceCommunityId, destCommunityId);
}

module.exports = {
  PENDING_SENTINEL,
  fanoutOnPost,
  syncEventMessages,
  deleteEventMessages,
  deliverPending,
  sendCopy,
  canSignupFromDestination,
  pairForCopy,
};
