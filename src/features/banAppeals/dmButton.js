/**
 * Ban-DM Appeal button (#773 subtask 07) — the DM-lane component builder plus
 * the post-record attach seam the COMMAND layer feeds.
 *
 * ── Why an EDIT-ATTACH seam and not `banService opts.components` ────────────
 * banService.banUser's order is LOCKED (guards → DM → ban → record): the ban
 * DM is sent BEFORE the ban_records row exists, so the customId
 * `appeal:<banRecordId>` cannot ride the original send — the id does not
 * exist yet, and `opts.components` (#772's plumbed pass-through) can only be
 * filled pre-record. The record id IS the durable appeal handle (075's
 * UNIQUE(ban_record_id) is the one-shot), so the button is attached AFTER
 * the record insert by EDITING the ban DM:
 *
 *   1. `captureBanDmRef(outbound, sink)` — a per-call wrapper around the
 *      caller's outbound whose sendDm records the delivered message id
 *      (outbound.sendDm returns {ok:true, id} — id only, no channel ref);
 *   2. `attachAppealButtonToBanDm(...)` — re-resolves the SAME DM channel
 *      (`users.fetch → createDM`, idempotent) and edits the captured message
 *      with the button row.
 *
 * Failure posture: the attach is STRICTLY best-effort. Every missing surface
 * (a mock client without `users`, a DM channel without `messages.fetch`, a
 * closed DM) degrades to a `[appeals]` skip line — the ban, its record and
 * its DM all stand exactly as #772 shipped them, and the user still has the
 * documented follow-up path (a staff member can always be messaged). The
 * button is the fast path, never the only path.
 *
 * #699 lazy-require law: banAppeals is required FROM banLifecycle/automod
 * only at call time (this module is the require target — it imports nothing
 * but discord.js + our own pure constants, so no cycle can close).
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const {
  LOG_PREFIX,
  APPEAL_BUTTON_LABEL,
  APPEAL_PREFIX,
} = require("./constants");

/**
 * The ban-DM intake button row: "Appeal this ban" → `appeal:<banRecordId>`.
 * One row, one button (issue §1); the guildless InteractionCreate arm in
 * events.js owns the press.
 *
 * @param {number|string} banRecordId the tracked ban record id (digits)
 * @returns {ActionRowBuilder[]} components payload for a DM send/edit
 */
function buildAppealButton(banRecordId) {
  const button = new ButtonBuilder()
    .setCustomId(`${APPEAL_PREFIX}${banRecordId}`)
    .setStyle(ButtonStyle.Primary)
    .setLabel(APPEAL_BUTTON_LABEL);
  return [new ActionRowBuilder().addComponents(button)];
}

/**
 * Wrap an outbound so ONE call site can see the message id its own sendDm
 * delivered (outbound.sendDm already returns {ok:true, id}; the wrapper just
 * catches what banService discards). The wrapper is a prototype child of the
 * original: every other surface (banMember, sendChannel, …) passes through
 * UNCHANGED, the captured sink is per-call, and a failed/absent sendDm
 * records nothing. Never throws.
 *
 * @param {object|null} outbound the caller's platform outbound
 * @param {object} [sink] object the captured id lands on (sink.messageId)
 * @returns {object|null} the wrapper (or the original when there is nothing
 *   to wrap — a null outbound or one without sendDm)
 */
function captureBanDmRef(outbound, sink = {}) {
  if (!outbound || typeof outbound.sendDm !== "function") return outbound;
  const wrapped = Object.create(outbound);
  wrapped.sendDm = async (userId, payload) => {
    const res = await outbound.sendDm(userId, payload);
    // First successful send wins (banUser sends exactly one ban DM; a belt
    // never overwrites a truth it already captured).
    if (
      res?.ok === true &&
      sink.messageId == null &&
      res.id != null &&
      String(res.id).trim() !== ""
    ) {
      sink.messageId = String(res.id).trim();
    }
    return res;
  };
  return wrapped;
}

/**
 * Edit the ban DM to carry the Appeal button AFTER the record exists (the
 * locked guards→DM→ban→record order makes this the ONLY correct moment).
 * Never throws and never rejects: every missing surface is a logged skip
 * (see the header), so the caller's ban result is never altered by it.
 *
 * @param {object} params
 * @param {object|null} params.client Discord client (users.fetch + createDM)
 * @param {string} params.userId the banned user (DM resolution)
 * @param {number|string} params.banRecordId the fresh record id (customId payload)
 * @param {string} params.banDmMessageId the captured ban-DM message id
 * @returns {Promise<{ok: true} | {ok: false, skipped?: boolean, reason?: string, error?: string}>}
 */
async function attachAppealButtonToBanDm({
  client = null,
  userId = null,
  banRecordId = null,
  banDmMessageId = null,
} = {}) {
  const ids = `record=${banRecordId ?? "?"} user=${userId ?? "?"} dmMessage=${banDmMessageId ?? "?"}`;
  const skip = (reason) => {
    console.warn(
      `${LOG_PREFIX} ban-DM appeal button skipped (${reason}) ${ids} — the ` +
        "ban and its DM stand; the button fast path is unavailable.",
    );
    return { ok: false, skipped: true, reason };
  };
  try {
    if (userId == null || banRecordId == null || banDmMessageId == null) {
      return skip("missing user/record/message id");
    }
    if (!client?.users?.fetch) return skip("no client.users surface");
    const user = await client.users.fetch(String(userId));
    if (!user) return skip("user did not resolve");
    // Same idiom as outbound.sendDm: createDM is idempotent, plain user-like
    // handles (tests, future adapters) are the DM channel themselves.
    const channel =
      typeof user.createDM === "function" ? await user.createDM() : user;
    if (!channel?.messages?.fetch) return skip("DM channel has no messages surface");
    const message = await channel.messages.fetch(String(banDmMessageId));
    if (!message) return skip("ban DM message no longer retrievable");
    if (typeof message.edit !== "function") return skip("ban DM message not editable");
    await message.edit({ components: buildAppealButton(banRecordId) });
    return { ok: true };
  } catch (err) {
    const error = err?.message || String(err);
    console.error(
      `${LOG_PREFIX} ban-DM appeal button attach failed ${ids}:`,
      error,
    );
    return { ok: false, error };
  }
}

module.exports = {
  buildAppealButton,
  captureBanDmRef,
  attachAppealButtonToBanDm,
};
