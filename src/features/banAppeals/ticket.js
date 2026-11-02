/**
 * The appeal ticket (#773 §2) — openAppealTicket + the header embed.
 *
 * The pattern is LOCKED (context-773 decision 2, report.js exemplar): the
 * appeal rides the EXISTING ticket pipeline (tickets/helpers.openTicketChannel
 * — no parallel ticket system), opened through the #745 staff-self branch so
 * the channel is staff-only. The banned user is NEVER a party to this call:
 * they are not the creator (the shared pipeline gives the creator a member
 * overwrite — `buildTicketOverwrites` adds `creator_user_id` unconditionally),
 * never an overwrite target, never DM'd from here. They cannot see the guild;
 * the ferry (./ferry.js) is their only channel.
 *
 * Ticket OWNERSHIP (the one design call this file makes): openTicketChannel
 * needs a `creatorUserId === openedByStaffId` staff identity. Banned user and
 * bot are both impossible (the user by law; the bot because its own BOT_ALLOW
 * entry would duplicate the creator overwrite at channel-create). So the
 * ticket is owned by the ban record's HUMAN moderator (they acted; the
 * appeal is about that act — the report-flow analogue is the reporter owning
 * their report), falling back to the GUILD OWNER when the record is
 * unattributed (automod bans carry `moderator_id = NULL` — executor.js
 * law). `pickTicketOwnerUserId` re-checks both identities so a planted or
 * degenerate id can never put the banned user or the bot into the overwrite
 * set — a refusal with a specific error instead, and the appeal stays
 * pending (truthful `filed`, never claimed filed).
 *
 * #730 law (issue §2): a channel-create OR header-send failure tells the
 * caller the SPECIFIC translated cause (formatChannelCreateError) and leaves
 * the appeal `filed` with NULL ticket — that pending truth is the retry
 * surface; nothing here claims the appeal is delivered. A header-send failure
 * can leave the fresh channel + ticket row orphaned (the channel exists, the
 * appeal record never references it) — logged LOUDLY with the channel id so
 * staff can delete it; the issue's "keep the appeal pending" rule wins over
 * the cleanup.
 *
 * Header (issue §2): the relay rules stated EXPLICITLY in the message content
 * (everything typed here reaches the user verbatim; text/images/video only;
 * no reactions; no embeds), the escaped user card (inert code-wrapped
 * `<@!id>` + id text — NO live ping, #745 convention), the ban record summary
 * (moderator included — the header is staff-side content, §6 only forbids
 * ferrying it), the warning/staff-note refs per the shipped staff-visibility
 * reads (active warnings / live notes, refs only — bodies stay on their own
 * pages), the statement VERBATIM inside a code fence, and exactly three
 * buttons: ap:clemency / ap:deny / ap:pause (pause label reflects the current
 * ferry_paused flag).
 *
 * Service contract (AGENTS.md rules 1/6): never replies to a platform, never
 * rejects — every failure is `{ ok: false, error }` with a specific sentence
 * and an `[appeals]` log line carrying community/guild/record/user/appeal
 * ids. Load posture (#699, intake contract): requiring this module opens NO
 * SQLite and no db-touching ticket module — every heavy access is a CALL-TIME
 * require (lazy seam, injectable via `deps`).
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  LOG_PREFIX,
  AP_CLEMENCY_PREFIX,
  AP_DENY_PREFIX,
  AP_PAUSE_PREFIX,
  BUTTON_LABEL_CLEMENCY,
  BUTTON_LABEL_DENY,
  BUTTON_LABEL_PAUSE,
  BUTTON_LABEL_RESUME,
} = require("./constants");
// core/theme and core/text are load-safe (discord.js + each other only).
const {
  Color,
  tsFull,
  tsRelative,
  formatTicketRef,
  formatWarnRef,
  formatNoteRef,
} = require("../../core/theme");
const { sliceSafe } = require("../../core/text");

/* ── Lazy module access (#699 law — banLifecycle/events.js posture) ─────────
 * tickets/helpers, tickets/overwrites, tickets/reportEvidence (→ assets →
 * db/connection!) and the db facade all reach SQLite at require time, so
 * every one of them is a CALL-TIME require. Tests inject plain doubles. */
const helpersApi = () => require("../tickets/helpers");
const overwritesApi = () => require("../tickets/overwrites");
const evidenceApi = () => require("../tickets/reportEvidence");
const escapeApi = () => require("./markdownEscape");
const dbApi = () => require("../../db");
const communityApi = () => require("../../platform/community");

/* ── shapes ────────────────────────────────────────────────────────────────── */

/** Snowflake shape test for the inert mention (report.js keeps its own copy
 * of this law; local to stay dependency-free). */
const SNOWFLAKE_RE = /^[0-9]{1,25}$/;

/** Channel-name cap — the shared pipeline slices `ticket-<n>` the same way. */
const CHANNEL_NAME_MAX = 100;

/** How many warning/note refs the header lists before the ellipsis. */
const REFS_SHOWN_MAX = 10;

/** Ban ref in display form (banService/ticker `B-n` sibling). */
function banRef(banRecord) {
  return `B-${banRecord?.ban_number ?? "?"}`;
}

/**
 * Mention rendered INSIDE inline code — the report.js decision-7 form: the
 * `<@!id>` is visible, inert, and can never ping. A non-snowflake id degrades
 * to the escaped id in the same code span (the escape closes nothing).
 * LAZY by design: inlineEscape lives behind evidenceApi() (SQLite at load).
 */
function codeMentionLazy(id) {
  const { inlineEscape } = evidenceApi();
  const raw = String(id ?? "");
  return SNOWFLAKE_RE.test(raw)
    ? `\`<@!${raw}>\``
    : `\`${inlineEscape(sliceSafe(raw, 64))}\``;
}

/**
 * Inert `ID: \`…\`` text — escape BEFORE slicing (report.js decision-7 law:
 * the escape closes nothing, so a planted payload can never leave the span).
 * LAZY like codeMentionLazy (inlineEscape sits behind the SQLite-heavy
 * reportEvidence require).
 */
function idTextLazy(id) {
  const { inlineEscape } = evidenceApi();
  return `ID: \`${inlineEscape(sliceSafe(String(id ?? ""), 64))}\``;
}

/** `<t:F> (<t:R>)` for timed bans; the DM's permanent-variant sentence
 * mirrored for staff reading the same record (#772 dmCopy copy law). */
function expiryField(expiresAt) {
  const e = Number(expiresAt);
  if (Number.isFinite(e) && e > 0) {
    return `${tsFull(e)} (${tsRelative(e)})`;
  }
  return "_permanent — staff may lift it at their discretion_";
}

/** Pause flag read (0/1 column; anything non-1 reads as running). */
function isFerryPaused(appeal) {
  return Number(appeal?.ferry_paused) === 1;
}

/**
 * The ticket-owner identity (see the header law). Human moderator when the
 * record carries one that is neither the bot nor the banned user; otherwise
 * the guild owner; `null` when NO valid human identity exists (refuse — the
 * appeal stays pending).
 */
function pickTicketOwnerUserId({ banRecord, guild, botUserId }) {
  const bannedUserId = String(banRecord?.user_id ?? "");
  const moderator = String(banRecord?.moderator_id ?? "").trim();
  if (
    moderator !== "" &&
    moderator !== botUserId &&
    moderator !== bannedUserId
  ) {
    return moderator;
  }
  const owner = String(guild?.ownerId ?? "").trim();
  if (owner !== "" && owner !== botUserId && owner !== bannedUserId) {
    return owner;
  }
  return null;
}

/* ── relay warning copy (issue §2 + §3 "Up-front notice") ────────────────────
 * The EXACT strings docs and the outcome flows quote; `**Label:** value` law
 * (#471 H2-13). Exported so 06/07 + docs consume one source. */

/**
 * The message-content block above the header embed: the relay law stated
 * explicitly (issue §2) plus the payload rules (§3). Keep it plain text —
 * the header EMBED is never relayed, so nothing user-relevant may hide in
 * the embed alone.
 *
 * @returns {string}
 */
function buildFerryWarning() {
  return [
    "**Relay:** everything typed in this channel is relayed to the appealing " +
      "user **verbatim** — this ticket is their only window into the server.",
    "**Shared:** text, images, and video only.",
    "**Never shared:** reactions, embeds, audio, stickers, polls, forwarded " +
      "messages, and button messages — anything un-sharable gets its sender a " +
      "specific notice here.",
    "**Pause relaying** silences the ferry in both directions so staff can " +
      "discuss internally; the relay is **on by default**.",
  ].join("\n");
}

/**
 * The three header buttons (issue §2, locked customId grammar). Labels come
 * from constants.js; the pause label reflects the CURRENT ferry_paused flag
 * on the row the header is built from (06 re-posts/edits after a toggle).
 *
 * @param {object} appeal ban_appeals row (needs .id; .ferry_paused keys the label)
 * @returns {ActionRowBuilder[]}
 */
function buildAppealButtons(appeal) {
  const appealId = String(appeal?.id ?? "");
  const clemency = new ButtonBuilder()
    .setCustomId(`${AP_CLEMENCY_PREFIX}${appealId}`)
    .setStyle(ButtonStyle.Success)
    .setLabel(BUTTON_LABEL_CLEMENCY);
  const deny = new ButtonBuilder()
    .setCustomId(`${AP_DENY_PREFIX}${appealId}`)
    .setStyle(ButtonStyle.Danger)
    .setLabel(BUTTON_LABEL_DENY);
  const pause = new ButtonBuilder()
    .setCustomId(`${AP_PAUSE_PREFIX}${appealId}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(isFerryPaused(appeal) ? BUTTON_LABEL_RESUME : BUTTON_LABEL_PAUSE);
  return [new ActionRowBuilder().addComponents(clemency, deny, pause)];
}

/**
 * Build the appeal header payload (pure — NO db, NO platform reads: warning/
 * note refs and the display name are the CALLER's reads).
 *
 * Privacy law (§6): the user card renders the mention inert (code-wrapped,
 * never a live ping) and the display name goes through the shipped escaper;
 * the moderator appears HERE because this is staff-side content — the whole
 * embed is on the never-relayed list.
 *
 * @param {object} input
 * @param {object} input.appeal the ban_appeals row (id, created_at, ferry_paused, appeal_statement fallback)
 * @param {object} input.banRecord the ban_records row
 * @param {string} [input.statement] verbatim statement (defaults to the row's)
 * @param {object} [input.ticket] the ticket row (for its #ref)
 * @param {string|null} [input.displayName] resolved display name (null → "_unknown_")
 * @param {string[]|null} [input.warningRefs] rendered active-warning refs (null → unavailable)
 * @param {string[]|null} [input.noteRefs] rendered live-note refs (null → unavailable)
 * @returns {{ content: string, embeds: EmbedBuilder[], components: ActionRowBuilder[], allowedMentions: { parse: string[] } }}
 */
function buildAppealHeader(input = {}) {
  const { appeal, banRecord, ticket, displayName, warningRefs, noteRefs } =
    input;
  const { fencedBlock } = evidenceApi();
  const { escapeDisplayName } = escapeApi();

  const statement = String(
    input.statement ?? appeal?.appeal_statement ?? "",
  ).trim();
  const userId = String(banRecord?.user_id ?? "?");

  const refLine = (refs) => {
    if (refs == null) return "_unavailable (read failed)_";
    const shown = refs.slice(0, REFS_SHOWN_MAX);
    if (shown.length === 0) return "_none_";
    const overflow = refs.length > REFS_SHOWN_MAX ? " …" : "";
    return shown.join(" · ") + overflow;
  };

  const moderator = String(banRecord?.moderator_id ?? "").trim();
  const moderatorValue =
    moderator === ""
      ? "_Automoderation (system)_"
      : `${codeMentionLazy(moderator)}\n${idTextLazy(moderator)}`;

  const embed = new EmbedBuilder()
    .setColor(Color.caution)
    .setTitle(`Ban appeal ${banRef(banRecord)}`)
    .setDescription(
      statement === ""
        ? "_No statement stored._"
        : fencedBlock(statement),
    )
    .addFields(
      {
        name: "Appealing user",
        value: `${codeMentionLazy(userId)}\n${idTextLazy(userId)}`,
      },
      {
        name: "Display name",
        value:
          String(displayName ?? "").trim() === ""
            ? "_unknown_"
            : escapeDisplayName(displayName),
      },
      { name: "Ban", value: banRef(banRecord), inline: true },
      ...(ticket?.ticket_number != null
        ? [
            {
              name: "Ticket",
              value: formatTicketRef(ticket.ticket_number),
              inline: true,
            },
          ]
        : []),
      { name: "Banned", value: tsFull(banRecord?.banned_at), inline: true },
      {
        name: "Expiry",
        value: expiryField(banRecord?.expires_at),
        inline: true,
      },
      { name: "Banned by (staff-only)", value: moderatorValue },
      {
        name: "Ban reason",
        value:
          String(banRecord?.reason ?? "").trim() === ""
            ? "_none recorded_"
            : sliceSafe(String(banRecord.reason), 1000),
      },
      { name: "Warnings (active)", value: refLine(warningRefs) },
      { name: "Staff notes", value: refLine(noteRefs) },
    )
    .setFooter({
      text:
        "Staff-only card — this header is NEVER relayed to the user. " +
        "Everything typed in the channel is.",
    });

  const created = Number(appeal?.created_at);
  if (Number.isFinite(created) && created > 0) {
    embed.setTimestamp(new Date(created));
  }

  // Nothing in this payload mentions anyone live → parse nothing (§2/§6: no
  // ping leakage in either direction; DM law's allowedMentions posture).
  return {
    content: buildFerryWarning(),
    embeds: [embed],
    components: buildAppealButtons(appeal),
    allowedMentions: { parse: [] },
  };
}

/* ── channel-create failure translation (report.js reportCreateFailureMessage twin) ── */

/**
 * openTicketChannel throws pre-translated sentences (BOT_PERMISSIONS,
 * CHANNEL_CREATE already through formatChannelCreateError, INVALID_REASON);
 * anything rawer gets the translated cause (error rule 3 — never a generic).
 *
 * @param {unknown} err
 * @returns {string}
 */
function appealCreateFailureMessage(err) {
  if (
    err?.code === "INVALID_REASON" ||
    err?.code === "BOT_PERMISSIONS" ||
    err?.code === "CHANNEL_CREATE"
  ) {
    return err.message;
  }
  return `Failed to open the appeal ticket: ${overwritesApi().formatChannelCreateError(err)}`;
}

/* ── the open flow ─────────────────────────────────────────────────────────── */

/**
 * Open the staff-only appeal ticket, post the header, attach the channel to
 * the appeal row and transition `filed → open` (all CAS through the shipped
 * primitives — attachAppealTicketChannel / openAppeal).
 *
 * Failure semantics (#730): any step that prevents a USABLE ticket returns
 * `{ ok:false, error }` with the specific cause and stores NO ticket
 * reference — the appeal stays `filed` with NULL ticket (the pending truth).
 * A lost attach/open race is NOT a failure: the LIVE row wins, the loser
 * logs loudly and reports the channel that is actually on the record.
 *
 * @param {object} params
 * @param {object} params.appeal the ban_appeals row (filed; id keys the buttons)
 * @param {object} params.banRecord the ban_records row
 * @param {number} params.communityId integer communities.id (from the ROW, never guessed)
 * @param {object} [params.client] Discord client (supervisor.discord at the edge)
 * @param {string} [params.statement] verbatim statement (defaults to the row's)
 * @param {object} [deps] test/edge seams:
 * @param {object} [deps.guild] pre-resolved guild (skips the community→guild lookup)
 * @param {Function} [deps.openTicketChannel]
 * @param {Function} [deps.attachAppealTicketChannel]
 * @param {Function} [deps.openAppeal]
 * @param {Function} [deps.listWarnings]
 * @param {Function} [deps.listStaffNotes]
 * @param {Function} [deps.fetchUser] (userId) => Promise<{username?, globalName?}|null>
 * @returns {Promise<{ ok: true, ticket: object, channel: object, channelOfRecordId: string, appeal: object, communityId: number, skippedStaffRoles: object[] }
 *   | { ok: false, error: string }>} never rejects
 */
async function openAppealTicket(params = {}) {
  const { appeal, banRecord, communityId, client, statement } = params;
  const deps = params.deps || {};

  const userId = String(banRecord?.user_id ?? "?");
  const appealId = appeal?.id ?? "?";
  const recordId = banRecord?.id ?? "?";
  const ids = () =>
    `community=${communityId ?? "?"} record=${recordId} user=${userId} appeal=${appealId}`;

  // Shape gates — a missing id never reaches the pipeline or the db.
  if (!Number.isSafeInteger(Number(appealId)) || Number(appealId) < 1) {
    return { ok: false, error: "An appeal ticket needs the stored appeal row." };
  }
  if (!banRecord?.id || String(banRecord.user_id ?? "").trim() === "") {
    return { ok: false, error: "An appeal ticket needs the ban record behind it." };
  }
  if (!Number.isSafeInteger(Number(communityId)) || Number(communityId) < 1) {
    return { ok: false, error: "An appeal ticket needs a valid community key." };
  }

  try {
    // ── Discord edges: community → guild, bot identity ──────────────────────
    const community = communityApi().getCommunityById(Number(communityId));
    if (!community) {
      return {
        ok: false,
        error: "This appeal's community is no longer registered — nothing was opened.",
      };
    }
    if (community.platform !== "discord") {
      // #773 explicit no-parity: ban appeals (and their tickets) are a
      // Discord-only surface; a Fluxer community must never reach here.
      return {
        ok: false,
        error: "Ban appeal tickets are Discord-only — this community is not Discord.",
      };
    }
    const guildId = community.externalGuildId;
    const guild =
      deps.guild ??
      client?.guilds?.cache?.get?.(guildId) ??
      (await client?.guilds?.fetch?.(guildId)) ??
      null;
    if (!guild) {
      return {
        ok: false,
        error: `I can't see the server this ban happened in (guild ${guildId}) — no ticket was opened.`,
      };
    }
    const botUserId = client?.user?.id;
    if (!botUserId) {
      return {
        ok: false,
        error: "Bot user not ready — the appeal ticket cannot be created yet.",
      };
    }

    // ── ticket ownership (NEVER the banned user, NEVER the bot — see header) ─
    const ownerUserId = pickTicketOwnerUserId({ banRecord, guild, botUserId });
    if (!ownerUserId) {
      console.error(
        `${LOG_PREFIX} appeal ticket refused — no valid staff owner ${ids()} guild=${guildId}`,
      );
      return {
        ok: false,
        error:
          "This server has no staff identity to attach the appeal ticket to " +
          "— no ticket was opened.",
      };
    }

    // ── the SHARED pipeline, staff-self branch (report.js decision-5 shape:
    // creator === openedByStaffId → STAFF_ALLOW on the named user + every
    // manageable senior staff role; @everyone denied; NO subject anywhere) ───
    const openTicketChannel =
      deps.openTicketChannel || helpersApi().openTicketChannel;
    const { ticket, channel, skippedStaffRoles } = await openTicketChannel({
      guild,
      client,
      communityId: Number(communityId),
      creatorUserId: ownerUserId,
      openedByStaffId: ownerUserId,
      reason: `Ban appeal ${banRef(banRecord)} for ${userId}`.slice(0, 500),
    });

    // Appeal-grammar name over the pipeline's `ticket-<n>` (best-effort — the
    // shared pipeline mints and renames to ticket-<n> itself; we mirror-rename
    // AFTER, never inside the pipeline). Failure keeps the ticket-N name:
    // cosmetic, loud in logs, ticket fully functional.
    const appealName =
      `appeal-B${banRecord.ban_number ?? "?"}-${userId}`.slice(
        0,
        CHANNEL_NAME_MAX,
      );
    if (typeof channel?.setName === "function") {
      try {
        await channel.setName(appealName);
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} appeal channel rename to ${appealName} failed ${ids()} channel=${channel?.id}:`,
          err?.message || err,
        );
      }
    }

    // ── header inputs: best-effort display name + staff-visibility refs ─────
    const fetchUser =
      deps.fetchUser ||
      (async (uid) => {
        try {
          return (await client?.users?.fetch?.(String(uid))) ?? null;
        } catch {
          return null; // banned user unresolvable — the card says "_unknown_"
        }
      });
    const user = await fetchUser(banRecord.user_id);
    const displayName =
      String(user?.globalName ?? user?.username ?? "").trim() || null;

    // Refs ride the SHIPPED staff-visibility reads (active warnings, live
    // notes — the repo defaults). A read failure degrades the FIELD to
    // "_unavailable_", never the whole ticket, and is logged.
    const listWarnings = deps.listWarnings ?? ((...a) => dbApi().listWarnings(...a));
    const listStaffNotes =
      deps.listStaffNotes ?? ((...a) => dbApi().listStaffNotes(...a));
    const readRefs = (listFn, format) => {
      try {
        const rows = listFn(Number(communityId), String(banRecord.user_id), {
          limit: REFS_SHOWN_MAX + 1,
        });
        return (Array.isArray(rows) ? rows : []).map(format);
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} appeal header ref read failed ${ids()} channel=${channel?.id}:`,
          err?.message || err,
        );
        return null;
      }
    };
    const warningRefs = readRefs(listWarnings, (w) =>
      formatWarnRef(w.warning_number),
    );
    const noteRefs = readRefs(listStaffNotes, (n) =>
      formatNoteRef(n.note_number),
    );

    // ── header post — #730: NO header, NO ticket (#773 §2: a send failure
    // keeps the appeal pending; the orphaned channel+row are logged loudly
    // for staff cleanup — the record never references them) ──────────────────
    const header = buildAppealHeader({
      appeal,
      banRecord,
      statement,
      ticket,
      displayName,
      warningRefs,
      noteRefs,
    });
    try {
      await channel.send(header);
    } catch (err) {
      const cause = err?.message || String(err);
      console.error(
        `${LOG_PREFIX} appeal header post failed ${ids()} guild=${guildId} ` +
          `ticket=${ticket?.id} channel=${channel?.id} — ORPHANED CHANNEL ` +
          `(delete ${channel?.name ?? channel?.id}); appeal stays pending:`,
        cause,
      );
      return {
        ok: false,
        error: `Could not post the appeal header into the new staff channel: ${cause}`,
      };
    }

    // ── attach + open (CAS; the LIVE row always wins a race) ────────────────
    const attachFn =
      deps.attachAppealTicketChannel ||
      ((id, channelArg) =>
        dbApi().attachAppealTicketChannel(id, channelArg));
    // await: the shipped primitives are synchronous; async test seams ride the same path.
    const attach = await attachFn(appealId, channel.id);
    if (!attach || attach.ok !== true) {
      console.error(
        `${LOG_PREFIX} appeal ticket attach failed ${ids()} channel=${channel.id}:`,
        attach?.error || "no result from attachAppealTicketChannel",
      );
      return {
        ok: false,
        error: `Could not record the appeal ticket: ${attach?.error || "attach returned no result"}`,
      };
    }
    let liveAppeal = attach.appeal ?? appeal;
    if (!attach.won) {
      const liveChannel = String(attach.appeal?.ticket_channel_id ?? "");
      console.error(
        `${LOG_PREFIX} appeal ticket attach RACE ${ids()} channel=${channel.id} ` +
          `— the record already holds channel=${liveChannel || "?"}; my channel ` +
          `${channel.name} is ORPHANED (delete it). Live row continues.`,
      );
      if (!liveChannel) {
        return {
          ok: false,
          error:
            "The appeal record lost its ticket race in an unreadable state — nothing was claimed.",
        };
      }
    }
    const channelOfRecordId = String(
      attach.won ? channel.id : attach.appeal?.ticket_channel_id,
    );

    const openFn =
      deps.openAppeal || ((id) => dbApi().openAppeal(id));
    const open = await openFn(appealId);
    if (!open || open.ok !== true) {
      console.error(
        `${LOG_PREFIX} appeal open transition failed ${ids()} channel=${channelOfRecordId}:`,
        open?.error || "no result from openAppeal",
      );
      return {
        ok: false,
        error: `Could not mark the appeal open: ${open?.error || "openAppeal returned no result"}`,
      };
    }
    liveAppeal = open.appeal ?? liveAppeal;
    if (!open.won && liveAppeal?.status !== "open") {
      // Status left `filed` behind our back mid-flow (a concurrent outcome
      // claim cannot target `filed` — this is a programmer/schema surprise).
      console.error(
        `${LOG_PREFIX} appeal open CAS lost ${ids()} live status=${liveAppeal?.status} — ` +
          "the relay guard reads status; reporting the live row honestly.",
      );
    }

    return {
      ok: true,
      ticket,
      channel,
      channelOfRecordId,
      appeal: liveAppeal,
      communityId: Number(communityId),
      skippedStaffRoles: skippedStaffRoles ?? [],
    };
  } catch (err) {
    // Rule 2: the translated sentence is returned (the caller replies it),
    // the raw cause is logged here once — never both surfaced and thrown.
    console.error(
      `${LOG_PREFIX} appeal ticket open failed ${ids()}:`,
      err?.message || err,
    );
    return { ok: false, error: appealCreateFailureMessage(err) };
  }
}

module.exports = {
  LOG_PREFIX,
  openAppealTicket,
  buildAppealHeader,
  buildAppealButtons,
  buildFerryWarning,
  // pure seams (tests pin the shape laws without Discord):
  banRef,
  expiryField,
  isFerryPaused,
  pickTicketOwnerUserId,
  appealCreateFailureMessage,
  codeMentionLazy,
  idTextLazy,
  // tuning constants:
  CHANNEL_NAME_MAX,
  REFS_SHOWN_MAX,
};
