/**
 * Ban appeals gateway wiring (#773 subtask 07) — every platform listener and
 * every interaction arm the feature owns. The business logic lives in
 * intake.js (press/modal battery + filing), outcomes.js (clemency/deny/
 * plain-close claims) and ferry.js (the two-way relay engine); this file
 * turns gateway events into ONE service call per event and reports the
 * outcome — the banLifecycle/events.js thin-listener law.
 *
 * ── The lanes (locked customId grammar, constants.js header) ────────────────
 *  1. GUILDESS InteractionCreate (THIS file, own listener): the ban-DM
 *     `appeal:<recordId>` press and the `appeal:s:<recordId>` statement modal.
 *     src/commands/router.js silently drops guild-less interactions
 *     (:74/:142/:174 — READ-ONLY anchor, the router stays untouched), so the
 *     feature consumes exactly its two prefixes here and nothing else
 *     (events/index.js wizard precedent).
 *  2. IN-GUILD `ap:` family (registered router arms, index.js registry keys):
 *     clemency / deny-press / deny-modal / pause on the ticket header,
 *     staff-gated (requireStaff owns the denial reply) + the cross-community
 *     row-vs-guild belt (automod/card.js idiom).
 *  3. MessageCreate ferry: the banned user's DM → their open appeal's ticket
 *     (`listOpenAppealsByUser` — a DM carries no guild; the user id scopes
 *     it); staff ticket messages → the banned user's DM (channel → appeal
 *     row). The engine re-checks status/pause/cursors/loop-proofing itself —
 *     the guards here are cheap belts, never decisions.
 *  4. ChannelDelete: an appeal ticket destroyed → outcomes.plainClose (the
 *     neutral "staff ended the conversation" notice; the ban is untouched).
 *  5. Boot catch-up (runBootCatchUp, called by index.js start()): bounded
 *     per-direction history replay for every OPEN appeal (ferry.catchUpOnBoot
 *     enforces FERRY_CATCHUP_MAX; cursors stay truthful for what was skipped).
 *
 * ── Detached-async law (AGENTS.md Error Handling 1) ─────────────────────────
 * Every listener body is sync-safe (shape checks + dispatch), every async
 * continuation carries try/catch AND a `.catch()` belt, and every failure
 * logs `[appeals] …` with community/record/appeal/user ids — one grep
 * reproduces the event. A broken appeal never reaches the emitter.
 *
 * ── Double-boot idempotence ─────────────────────────────────────────────────
 * registerEvents binds at most once per client (WeakSet guard): a second
 * boot pass on the same client cannot double-bind (and double-relay) a lane.
 * Relay safety does NOT depend on this — the ferry engine's cursors and
 * relayed-id ledger are the truth — this is the cheap belt.
 *
 * #699 lazy-require law: platform/community and the db facade reach SQLite at
 * require time, so both are CALL-TIME requires (banLifecycle/events.js
 * exemplar). discord.js, core/outbound (pure) and the feature's own logic
 * modules (their own db access is lazy) are the only top-level requires.
 */

const { Events, MessageFlags } = require("discord.js");
const {
  resolveDiscordClient,
  resolveOutbound,
} = require("../../core/outbound");
const { requireStaff } = require("../../core/permissions");
const constants = require("./constants");
const intake = require("./intake");
const outcomes = require("./outcomes");
const ferry = require("./ferry");
const ticket = require("./ticket");

const {
  LOG_PREFIX,
  APPEAL_PREFIX,
  MODAL_APPEAL_PREFIX,
  AP_TICKET_PREFIX,
  AP_CLEMENCY_PREFIX,
  AP_DENY_PREFIX,
  AP_DENY_MODAL_PREFIX,
  AP_PAUSE_PREFIX,
  parseAppealPressRecordId,
  parseModalAppealRecordId,
  parseTicketAppealId,
} = constants;

const dbFacade = () => require("../../db");
const communityApi = () => require("../../platform/community");

/* ── Tiny readers / shared edge helpers ───────────────────────────────────── */

/** Trim-to-null: "" and null are the same absent fact. */
function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * Edge resolution: guild snowflake → internal integer community id
 * (platform/community.js edge law; the #389 first-sight memo makes a known
 * guild a zero-statement read).
 * @returns {number|null} null only when there is no snowflake to resolve.
 */
function communityIdForGuild(guildId) {
  const externalGuildId = optionalText(guildId);
  if (!externalGuildId) return null;
  return communityApi().ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId,
  });
}

/**
 * The four ferry deps for ONE appeal's community (ferry.js contract):
 * sendChannel + sendDm through the community's OutboundClient (#462's ONE
 * resolver) + the bot's own id (self-echo belt). A degraded Discord hold
 * (null outbound) leaves the send seams absent — the ENGINE then reports
 * every relay as a specific `{ok:false}` failure (rule 6), never a crash.
 */
function ferryDepsFor(supervisor, client, communityId) {
  const deps = { clientUserId: client?.user?.id ?? null };
  const outbound = resolveOutbound(supervisor, communityId, {
    label: "appeals",
  });
  if (outbound) {
    if (typeof outbound.sendChannel === "function") {
      deps.sendChannel = (channelId, payload) =>
        outbound.sendChannel(channelId, payload);
    }
    if (typeof outbound.sendDm === "function") {
      deps.sendDm = (userId, payload) => outbound.sendDm(userId, payload);
    }
  }
  return deps;
}

/** Ephemeral reply that survives "already deferred/replied" (followUp arm). */
async function replyEphemeral(interaction, content) {
  const payload = {
    content: String(content ?? ""),
    allowedMentions: { parse: [] },
  };
  if (interaction?.replied || interaction?.deferred) {
    await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

/** Rule-2 failure line: [appeals] + what + ids + cause. Never throws. */
function reportFailure(what, ids, err) {
  console.error(
    `${LOG_PREFIX} ${what} failed ${ids ?? ""}`.trimEnd() + ":",
    err?.message || err,
  );
}

/* ══ 1. Guildless intake lane — ban-DM press + statement modal ══════════════ */

/**
 * `appeal:<recordId>` press (the banned member's DM only — the router never
 * sees guild-less interactions). validateAppealPress answers EVERY shape
 * (forged id, wrong presser, dead ban, appeals off, already filed) with its
 * own specific refusal; OK opens the statement modal.
 */
async function onAppealButtonPress(supervisor, client, interaction) {
  void supervisor;
  void client;
  const banRecordId = parseAppealPressRecordId(interaction.customId ?? "");
  const pressingUserId = interaction.user?.id ?? null;
  try {
    const result = intake.validateAppealPress({ banRecordId, pressingUserId });
    if (result.ok) {
      await interaction.showModal(
        intake.buildAppealModal(result.banRecordId),
      );
      return;
    }
    // Locked decision 6: stale/forged presses get NAMED, logged refusals.
    console.warn(
      `${LOG_PREFIX} appeal press refused code=${result.code} ` +
        `record=${banRecordId ?? "?"} user=${pressingUserId ?? "?"} ` +
        `community=${result.communityId ?? "?"}`,
    );
    await replyEphemeral(interaction, result.error);
  } catch (err) {
    reportFailure(
      "appeal press refusal",
      `record=${banRecordId ?? "?"} user=${pressingUserId ?? "?"}`,
      err,
    );
  }
}

/**
 * `appeal:s:<recordId>` modal submit — the FULL battery runs AGAIN inside
 * handleAppealModalSubmit (settings may have flipped between press and
 * submit; the 075 UNIQUE is the race-proof one-shot). The filing + ticket +
 * confirmation DM is slow → defer ephemerally first; the ack carries the
 * decision truth (FILED / TICKET_FAILED pending truth / the validator's
 * specific refusal — never a generic).
 */
async function onAppealModalSubmit(supervisor, client, interaction) {
  void supervisor;
  const pressingUserId = interaction.user?.id ?? null;
  const recordId = parseModalAppealRecordId(interaction.customId ?? "");
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const decision = await intake.handleAppealModalSubmit({
      interaction,
      client,
      banRecordId: recordId,
      pressingUserId,
    });
    if (decision.ok && decision.code === intake.CODE_FILED) {
      await replyEphemeral(
        interaction,
        "**Appeal:** filed — your statement is with staff now. Staff " +
          "replies land in this DM while the conversation is open.",
      );
      return;
    }
    // Every non-filed decision already carries its SPECIFIC sentence
    // (validator refusals, refusalTicketFailed's pending truth, the repo's
    // filing failure) — quote it, never a generic.
    console.warn(
      `${LOG_PREFIX} appeal filing refused code=${decision.code ?? "?"} ` +
        `record=${decision.banRecordId ?? recordId ?? "?"} ` +
        `user=${decision.userId ?? pressingUserId ?? "?"} ` +
        `community=${decision.communityId ?? "?"}`,
    );
    await replyEphemeral(interaction, decision.error);
  } catch (err) {
    reportFailure(
      "appeal modal submit",
      `record=${recordId ?? "?"} user=${pressingUserId ?? "?"}`,
      err,
    );
    await replyEphemeral(
      interaction,
      `Could not process the appeal: ${err?.message || err} Nothing was filed.`,
    ).catch(() => {});
  }
}

/* ══ 2. Ferry MessageCreate lanes ═══════════════════════════════════════════ */

/**
 * The banned user typed in the bot's DM: relay into EVERY open appeal they
 * own (cross-community by construction — the user id is the lane's proof,
 * each row relays only into ITS OWN ticket; intake.js repo doc). No open
 * rows (the overwhelming majority of DMs) is one cheap indexed read and
 * silence.
 */
async function onUserDmMessage(supervisor, client, message) {
  const userId = message.author?.id ?? null;
  if (userId == null) return;
  const rows = dbFacade().listOpenAppealsByUser(String(userId));
  for (const appeal of rows) {
    try {
      const res = await ferry.relayUserToTicket({
        appeal,
        message,
        deps: ferryDepsFor(supervisor, client, appeal.community_id),
      });
      if (!res.ok) {
        reportFailure(
          "ferry user→ticket relay",
          `community=${appeal.community_id} appeal=${appeal.id} ` +
            `record=${appeal.ban_record_id} user=${userId} ` +
            `message=${message.id}`,
          res.error,
        );
      }
    } catch (err) {
      reportFailure(
        "ferry user→ticket relay",
        `community=${appeal.community_id} appeal=${appeal.id} ` +
          `message=${message.id}`,
        err,
      );
    }
  }
}

/**
 * A staff message in an appeal ticket: relay to the banned user's DM. The
 * userId comes from the ban record (ferry.js law: the relay never reads ban
 * metadata into the payload, it only needs the destination). status/pause/
 * loop-proofing are the ENGINE's guards; these reads are cheap belts.
 */
async function onTicketMessage(supervisor, client, message) {
  const guildId = message.guild?.id ?? null;
  const channelId = message.channel?.id ?? null;
  if (!guildId || !channelId) return;
  const communityId = communityIdForGuild(guildId);
  if (communityId == null) return;
  const appeal = dbFacade().getAppealByTicketChannel(communityId, channelId);
  if (!appeal || String(appeal.status) !== "open") return;
  const record = dbFacade().getBanRecord(appeal.ban_record_id) ?? null;
  const userId = record?.user_id ?? null;
  if (userId == null) {
    console.warn(
      `${LOG_PREFIX} ferry ticket→user skipped — ban record ` +
        `${appeal.ban_record_id} is gone (community=${communityId} ` +
        `appeal=${appeal.id} message=${message.id})`,
    );
    return;
  }
  const res = await ferry.relayTicketToUser({
    appeal,
    message,
    deps: ferryDepsFor(supervisor, client, appeal.community_id),
    userId: String(userId),
  });
  if (!res.ok) {
    reportFailure(
      "ferry ticket→user relay",
      `community=${communityId} appeal=${appeal.id} user=${userId} ` +
        `message=${message.id}`,
      res.error,
    );
  }
}

/* ══ 3. ChannelDelete — ticket destroyed → neutral plain-close ═══════════════ */

/**
 * A guild channel was deleted. plainClose re-reads the row itself (the
 * ChannelDelete path is LENIENT by contract: no appeal bound to this channel
 * skips silently — the norm, not a failure). staffUserId stays null: the
 * repo's attribution-free plain-close claim is the event path's law.
 */
async function onAppealTicketDeleted(supervisor, client, channel) {
  const guildId = channel?.guild?.id ?? null;
  const channelId = channel?.id ?? null;
  if (!guildId || !channelId) return; // DM-channel deletions carry no guild
  const communityId = communityIdForGuild(guildId);
  if (communityId == null) return;
  const row =
    dbFacade().getAppealByTicketChannel(communityId, channelId) ?? null;
  if (!row || String(row.status) !== "open") return; // cheap pre-gate
  const res = await outcomes.plainClose({
    communityId,
    ticketChannelId: channelId,
    deps: {
      client,
      outbound: resolveOutbound(supervisor, communityId, { label: "appeals" }),
    },
  });
  if (!res.ok) {
    reportFailure(
      "plain-close after ticket delete",
      `community=${communityId} appeal=${row.id} channel=${channelId}`,
      res.error,
    );
  }
  // ok:true is the closed truth (plainClose logged its own fact line) or the
  // benign decided/lost-the-claim skip — both silent by design.
}

/* ══ 4. In-ticket `ap:` arms (registered router handlers) ═══════════════════ */

/** Row reads shared by all three button families + the deny modal submit. */
function readAppealRow(appealId) {
  try {
    return dbFacade().getAppealById(Number(appealId)) ?? null;
  } catch (err) {
    reportFailure(
      "appeal row read",
      `appeal=${appealId} guild=? user=?`,
      err,
    );
    return null;
  }
}

/**
 * Cross-community belt: the header row must belong to THIS guild's community
 * (automod/card.js law). Returns the refusal copy or null when the row is
 * clean. The mismatch itself logs — it means a forged id or a community
 * registry drift, both worth a staff-side grep.
 */
function communityBeltRefusal(appeal, communityId, ids) {
  if (communityId == null) {
    return (
      "**Server not registered:** this guild has no community row — the bot " +
      "cannot map the appeal it belongs to. Nothing was run."
    );
  }
  if (Number(appeal.community_id) !== Number(communityId)) {
    console.error(
      `${LOG_PREFIX} in-ticket appeal refused (${ids}): the row belongs to ` +
        `community ${appeal.community_id}, not ${communityId}`,
    );
    return (
      "That appeal does not belong to this server — nothing was run."
    );
  }
  return null;
}

/**
 * The single `ap:` button arm (registry longest-prefix routes the whole
 * family here; parseTicketAppealId's digits-only law means the three
 * families can never cross-handle each other's ids).
 *
 * Flow law: staff gate first (requireStaff owns the MSG_DENIED reply), then
 * the payload audit, then the row + community belt, then the family arm.
 * Outcome arms deferUpdate (the flow is slow: claims, unban, DMs, ticket
 * close) and pass the header as deps.headerMessage — after an ack the
 * engine-side `interaction.update` window is gone, a direct message edit is
 * the correct strip path (outcomes.disableOutcomeButtons honors the duck).
 */
async function handleAppealTicketButton(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;
  const customId = interaction.customId ?? "";
  const supervisor = ctx?.supervisor ?? null;
  const staffUserId = interaction.user?.id != null
    ? String(interaction.user.id)
    : null;

  // Family dispatch — clemency / deny-press / pause (the deny MODAL submit
  // is `ap:deny:m:`, dispatched to the registry modal arm, never here).
  let family = null;
  let appealId = null;
  for (const [prefix, name] of [
    [AP_CLEMENCY_PREFIX, "clemency"],
    [AP_DENY_PREFIX, "deny"],
    [AP_PAUSE_PREFIX, "pause"],
  ]) {
    const id = parseTicketAppealId(customId, prefix);
    if (id != null) {
      family = name;
      appealId = id;
      break;
    }
  }
  if (family == null) {
    await replyEphemeral(
      interaction,
      "This appeal control is malformed or from an older build — nothing " +
        "was run.",
    );
    return;
  }

  const guildId = interaction.guildId ?? null;
  const communityId = communityIdForGuild(guildId);
  const ids = `guild=${guildId ?? "?"} user=${staffUserId ?? "?"} appeal=${appealId}`;
  const appeal = readAppealRow(appealId);
  if (!appeal) {
    await replyEphemeral(interaction, "No such ban appeal.");
    return;
  }
  const belt = communityBeltRefusal(appeal, communityId, ids);
  if (belt) {
    await replyEphemeral(interaction, belt);
    return;
  }

  const client = resolveDiscordClient(supervisor, { label: "appeals" });
  const outbound = resolveOutbound(supervisor, appeal.community_id, {
    label: "appeals",
  });
  const outcomeDeps = {
    client,
    outbound,
    guild: interaction.guild ?? null,
    guildName: interaction.guild?.name ?? null,
    // Post-ack header strip path (disableOutcomeButtons reads the duck).
    headerMessage: interaction.message ?? null,
  };

  /* ── clemency ── */
  if (family === "clemency") {
    await interaction.deferUpdate();
    const facts = await outcomes.grantClemency({
      appealId: Number(appealId),
      staffUserId,
      deps: outcomeDeps,
    });
    await replyEphemeral(
      interaction,
      facts.ok
        ? `**Clemency:** granted — appeal #${appealId}. The ban was lifted ` +
            "and the member was notified by DM."
        : facts.error,
    ).catch((err) =>
      reportFailure("clemency ack", ids, err),
    );
    return;
  }

  /* ── deny PRESS → the optional-reason modal (the decision lands on the
     modal submit, so the press only opens it; a decided row never re-opens) ── */
  if (family === "deny") {
    if (String(appeal.status) !== "open") {
      await replyEphemeral(
        interaction,
        outcomes.alreadyDecidedError(appeal.status),
      );
      return;
    }
    await interaction.showModal(
      outcomes.buildDenyReasonModal(Number(appealId)),
    );
    return;
  }

  /* ── pause / resume toggle (labels flip on the LIVE row) ── */
  const res = dbFacade().setAppealFerryPaused(
    Number(appealId),
    !ticket.isFerryPaused(appeal),
  );
  if (!res.ok) {
    await replyEphemeral(interaction, res.error);
    return;
  }
  const live = res.appeal ?? readAppealRow(appealId);
  if (!live) {
    // Saved then vanished (deletion race): the pause ran, the labels cannot
    // refresh — the specific truth, not a false failure.
    await replyEphemeral(
      interaction,
      `**Ferry:** pause state saved, but the appeal row is gone — the ` +
        "header could not be refreshed.",
    );
    return;
  }
  try {
    await interaction.update({ components: ticket.buildAppealButtons(live) });
  } catch (err) {
    // The toggle SAVED; only the label patch failed (interaction expired).
    reportFailure(
      "pause label refresh (toggle itself saved)",
      ids,
      err,
    );
    await replyEphemeral(
      interaction,
      `**Ferry:** relaying is now ${
        ticket.isFerryPaused(live) ? "**paused**" : "**active**"
      } — the header button could not refresh in place, a reload shows the ` +
        "current label.",
    ).catch(() => {});
  }
}

/**
 * `ap:deny:m:<appealId>` — the denial-reason modal submit (registry modal
 * arm). Same gate + belt + fresh-row law as the press (status can have
 * flipped between press and submit); the reason is optional (Discord's
 * field is optional; the repo caps it, deny() belts).
 */
async function handleDenyReasonModal(interaction, ctx) {
  if (!(await requireStaff(interaction))) return;
  const supervisor = ctx?.supervisor ?? null;
  const staffUserId = interaction.user?.id != null
    ? String(interaction.user.id)
    : null;
  const appealId = parseTicketAppealId(
    interaction.customId ?? "",
    AP_DENY_MODAL_PREFIX,
  );
  if (appealId == null) {
    await replyEphemeral(
      interaction,
      "This denial form is malformed or from an older build — nothing was " +
        "denied.",
    );
    return;
  }

  const guildId = interaction.guildId ?? null;
  const communityId = communityIdForGuild(guildId);
  const ids = `guild=${guildId ?? "?"} user=${staffUserId ?? "?"} appeal=${appealId}`;
  const appeal = readAppealRow(appealId);
  if (!appeal) {
    await replyEphemeral(interaction, "No such ban appeal.");
    return;
  }
  const belt = communityBeltRefusal(appeal, communityId, ids);
  if (belt) {
    await replyEphemeral(interaction, belt);
    return;
  }
  if (String(appeal.status) !== "open") {
    await replyEphemeral(
      interaction,
      outcomes.alreadyDecidedError(appeal.status),
    );
    return;
  }

  const reason =
    intake.readModalText(interaction, outcomes.MODAL_FIELD_REASON) || null;
  await interaction.deferUpdate();
  const facts = await outcomes.deny({
    appealId: Number(appealId),
    staffUserId,
    reason,
    deps: {
      client: resolveDiscordClient(supervisor, { label: "appeals" }),
      outbound: resolveOutbound(supervisor, appeal.community_id, {
        label: "appeals",
      }),
      guild: interaction.guild ?? null,
      guildName: interaction.guild?.name ?? null,
      headerMessage: interaction.message ?? null,
    },
  });
  await replyEphemeral(
    interaction,
    facts.ok
      ? `**Denied:** appeal #${appealId} denied — the ban stands and the ` +
          "member was notified by DM."
      : facts.error,
  ).catch((err) => reportFailure("deny ack", ids, err));
}

/* ══ 5. Boot ferry catch-up (index.js start(), fire-and-forget) ═════════════ */

/** discord.js messages.fetch options (after=null means "from the start"). */
function fetchOptions({ limit, after }) {
  const opts = { limit: Number(limit) > 0 ? Number(limit) : 50 };
  if (after != null && String(after).trim() !== "") opts.after = String(after);
  return opts;
}

/** The USER side of one appeal: their DM with the bot (createDM idempotent). */
function dmMessagesFetcher(client, userId) {
  return async ({ limit, after }) => {
    const user = await client.users.fetch(String(userId));
    if (!user) return [];
    const dm =
      typeof user.createDM === "function" ? await user.createDM() : user;
    if (!dm?.messages?.fetch) return [];
    return dm.messages.fetch(fetchOptions({ limit, after }));
  };
}

/** The TICKET side of one appeal: its staff channel history. */
function channelMessagesFetcher(client, channelId) {
  return async ({ limit, after }) => {
    const channel = await client.channels.fetch(String(channelId));
    if (!channel?.messages?.fetch) return [];
    return channel.messages.fetch(fetchOptions({ limit, after }));
  };
}

/**
 * Replay per-direction history for every OPEN appeal after a restart
 * (#773 §3 durability). Bounded by the engine (FERRY_CATCHUP_MAX per appeal
 * per direction) and by listOpenAppeals (oldest-first scan cap) — a long
 * outage never storms the tickets or the DMs, and the cursors stay truthful
 * for whatever did not replay (it awaits live traffic or the next boot).
 * One appeal's failure never stops the sweep (rule 5: partial results).
 *
 * @param {object|null} supervisor
 * @returns {Promise<{ran: boolean, appeals: number, relayed: number}>}
 */
async function runBootCatchUp(supervisor) {
  const client = resolveDiscordClient(supervisor, { label: "appeals" });
  if (!client) {
    console.log(
      `${LOG_PREFIX} Discord client not configured — ferry boot catch-up skipped`,
    );
    return { ran: false, appeals: 0, relayed: 0 };
  }
  const appeals = dbFacade().listOpenAppeals();
  let relayed = 0;
  for (const appeal of appeals) {
    const ids =
      `community=${appeal.community_id} appeal=${appeal.id} ` +
      `record=${appeal.ban_record_id}`;
    try {
      const deps = ferryDepsFor(supervisor, client, appeal.community_id);
      const record =
        dbFacade().getBanRecord(appeal.ban_record_id) ?? null;
      const userId = record?.user_id != null ? String(record.user_id) : null;

      // user→ticket side: the user's DM history is the message SOURCE.
      if (userId != null && typeof client.users?.fetch === "function") {
        const res = await ferry.catchUpOnBoot({
          appeal,
          direction: "user",
          userId,
          deps,
          messagesFetcher: dmMessagesFetcher(client, userId),
        });
        relayed += res.relayed ?? 0;
        if (!res.ok) {
          reportFailure(`ferry boot catch-up (user side)`, ids, res.error);
        }
      } else if (userId == null) {
        console.warn(
          `${LOG_PREFIX} ferry boot catch-up skipped user side — ban record ` +
            `gone ${ids}`,
        );
      }

      // ticket→user side: the ticket history is the SOURCE; needs the
      // destination user (same record read).
      if (appeal.ticket_channel_id && userId != null) {
        const res = await ferry.catchUpOnBoot({
          appeal,
          direction: "ticket",
          userId,
          deps,
          messagesFetcher: channelMessagesFetcher(
            client,
            appeal.ticket_channel_id,
          ),
        });
        relayed += res.relayed ?? 0;
        if (!res.ok) {
          reportFailure(`ferry boot catch-up (ticket side)`, ids, res.error);
        }
      }
    } catch (err) {
      reportFailure("ferry boot catch-up", ids, err);
    }
  }
  if (appeals.length > 0) {
    console.log(
      `${LOG_PREFIX} ferry boot catch-up done appeals=${appeals.length} ` +
        `relayed=${relayed}`,
    );
  }
  return { ran: true, appeals: appeals.length, relayed };
}

/* ══ Bindings ═══════════════════════════════════════════════════════════════ */

/** Clients already bound this process (double-boot idempotence belt). */
const boundClients = new WeakSet();

/**
 * Bind the feature's gateway hooks (the load.js contract: first argument is
 * the PR 7 supervisor; a raw/foreign object throws by design and load.js
 * logs it per feature — never a crash; null = Discord-less boot = no-op).
 *
 * @param {import("../../platform/boot").Supervisor|null} supervisor
 * @param {object} [featureCtx]
 */
function registerEvents(supervisor, featureCtx) {
  void featureCtx;
  const client = resolveDiscordClient(supervisor, { label: "appeals" });
  if (!client) return; // Discord unconfigured → no-op binds
  if (boundClients.has(client)) return; // double-boot: bind exactly once
  boundClients.add(client);

  // Guildless intake lane — ONLY the two appeal prefixes; everything else
  // guild-less stays nobody's (the router's guild guard already drops it).
  client.on(Events.InteractionCreate, (interaction) => {
    try {
      if (interaction.guild) return; // guild-scoped interactions = the router
      const customId = interaction.customId ?? "";
      // ORDER LAW (constants.js): `appeal:s:` is a strict extension of
      // `appeal:` — the modal arm must be checked FIRST.
      if (interaction.isModalSubmit?.() === true) {
        if (!customId.startsWith(MODAL_APPEAL_PREFIX)) return;
        onAppealModalSubmit(supervisor, client, interaction).catch((err) =>
          reportFailure(
            "guildless modal lane",
            `customId=${customId.slice(0, 120)}`,
            err,
          ),
        );
        return;
      }
      if (interaction.isButton?.() === true) {
        if (!customId.startsWith(APPEAL_PREFIX)) return;
        onAppealButtonPress(supervisor, client, interaction).catch((err) =>
          reportFailure(
            "guildless press lane",
            `customId=${customId.slice(0, 120)}`,
            err,
          ),
        );
      }
    } catch (err) {
      reportFailure("guildless interaction bind", "", err);
    }
  });

  // Ferry lanes. author.bot is every relayed copy (both directions) plus all
  // bot chatter — skipping it is the loop-proof listener belt (the engine
  // re-checks clientUserId + the relayed-id ledger as its own truth).
  client.on(Events.MessageCreate, (message) => {
    try {
      if (message.author?.bot === true) return;
      if (message.author?.id == null) return;
      if (message.guild) {
        onTicketMessage(supervisor, client, message).catch((err) =>
          reportFailure(
            "ticket lane",
            `guild=${message.guild?.id ?? "?"} channel=${message.channel?.id ?? "?"} ` +
              `message=${message.id ?? "?"}`,
            err,
          ),
        );
      } else {
        onUserDmMessage(supervisor, client, message).catch((err) =>
          reportFailure(
            "DM lane",
            `user=${message.author?.id ?? "?"} message=${message.id ?? "?"}`,
            err,
          ),
        );
      }
    } catch (err) {
      reportFailure(
        "ferry MessageCreate bind",
        `message=${message?.id ?? "?"}`,
        err,
      );
    }
  });

  // Ticket destroyed → neutral plain-close (plainClose owns the skip law).
  client.on(Events.ChannelDelete, (channel) => {
    if (!channel?.guild?.id) return; // guild channels only
    onAppealTicketDeleted(supervisor, client, channel).catch((err) =>
      reportFailure(
        "ChannelDelete plain-close",
        `channel=${channel?.id ?? "?"}`,
        err,
      ),
    );
  });
}

module.exports = {
  registerEvents,
  runBootCatchUp,
  // Registry arms (index.js claims `ap:` + `ap:deny:m:` under banAppeals).
  handleAppealTicketButton,
  handleDenyReasonModal,
  // Guarded seams for white-box tests (the bindings above are the law).
  internals: {
    communityIdForGuild,
    ferryDepsFor,
    onAppealButtonPress,
    onAppealModalSubmit,
    onUserDmMessage,
    onTicketMessage,
    onAppealTicketDeleted,
    dmMessagesFetcher,
    channelMessagesFetcher,
    AP_TICKET_PREFIX,
  },
};
