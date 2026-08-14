/**
 * Help tickets — open channels, sensitive lock-down, archive on close.
 */

const { db, now } = require("../connection");
const { getGuildSettings } = require("./guildSettings");
const crypto = require("crypto");

/** Max reason / close_reason length */
const MAX_TICKET_REASON = 1000;

/**
 * @param {string|null|undefined} reason
 * @param {string} [label]
 * @param {object} [opts]
 * @param {boolean} [opts.allowEmpty=false]
 * @returns {{ ok: true, reason: string|null } | { ok: false, error: string }}
 */
function normalizeTicketReason(reason, label = "Reason", opts = {}) {
  const allowEmpty = !!opts.allowEmpty;
  if (reason == null || String(reason).trim() === "") {
    if (allowEmpty) return { ok: true, reason: null };
    return { ok: false, error: `${label} cannot be empty.` };
  }
  const text = String(reason).trim();
  if (text.length > MAX_TICKET_REASON) {
    return {
      ok: false,
      error: `${label} is too long (max ${MAX_TICKET_REASON} characters).`,
    };
  }
  return { ok: true, reason: text };
}

/**
 * @param {string} guildId
 * @returns {number}
 */
function nextTicketNumber(guildId) {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(ticket_number), 0) AS max_n FROM tickets WHERE guild_id=?`
    )
    .get(guildId);
  return Number(row?.max_n || 0) + 1;
}

/**
 * @param {string} guildId
 * @returns {{ ticket_category_id: string|null, ticket_archive_channel_id: string|null, ticket_rate_limit_minutes: number }}
 */
function getTicketSettings(guildId) {
  const s = getGuildSettings(guildId);
  return {
    ticket_category_id: s.ticket_category_id ?? null,
    ticket_archive_channel_id: s.ticket_archive_channel_id ?? null,
    ticket_rate_limit_minutes:
      s.ticket_rate_limit_minutes != null
        ? Number(s.ticket_rate_limit_minutes)
        : 60,
  };
}

/**
 * Last self-created ticket for rate limiting (opened_by_staff_id IS NULL).
 * @param {string} guildId
 * @param {string} userId
 * @returns {object|null}
 */
function getLastSelfCreatedTicket(guildId, userId) {
  return (
    db
      .prepare(
        `
      SELECT * FROM tickets
      WHERE guild_id=? AND creator_user_id=? AND opened_by_staff_id IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `
      )
      .get(guildId, userId) || null
  );
}

/**
 * Rate-limit check for member self-create.
 * @param {string} guildId
 * @param {string} userId
 * @returns {{ ok: true } | { ok: false, retryAfterMs: number, minutes: number }}
 */
function canUserCreateTicket(guildId, userId) {
  const settings = getTicketSettings(guildId);
  const minutes = Number(settings.ticket_rate_limit_minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: true };
  }

  const last = getLastSelfCreatedTicket(guildId, userId);
  if (!last) return { ok: true };

  const windowMs = minutes * 60 * 1000;
  const elapsed = now() - Number(last.created_at);
  if (elapsed >= windowMs) return { ok: true };

  return {
    ok: false,
    retryAfterMs: windowMs - elapsed,
    minutes,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.guildId
 * @param {string} opts.creatorUserId
 * @param {string} opts.channelId
 * @param {string|null} [opts.reason]
 * @param {string|null} [opts.openedByStaffId] staff who opened on behalf of creator;
 *   when set, that user becomes staff owner + named staff (user overwrite access)
 * @returns {object}
 */
function createTicket(opts) {
  const reasonNorm = normalizeTicketReason(opts.reason, "Reason", {
    allowEmpty: true,
  });
  if (!reasonNorm.ok) {
    const err = new Error(reasonNorm.error);
    err.code = "INVALID_REASON";
    throw err;
  }

  const t = now();
  const openedByStaffId = opts.openedByStaffId
    ? String(opts.openedByStaffId)
    : null;
  const insert = db.prepare(`
    INSERT INTO tickets (
      guild_id, ticket_number, channel_id, creator_user_id, status,
      is_sensitive, reason, created_at, opened_by_staff_id, staff_owner_id, archived
    ) VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?, 0)
  `);
  const insertMember = db.prepare(`
    INSERT OR IGNORE INTO ticket_members (ticket_id, user_id, added_at, added_by)
    VALUES (?, ?, ?, ?)
  `);
  const insertStaff = db.prepare(`
    INSERT INTO ticket_staff (ticket_id, user_id, is_owner, added_at, added_by)
    VALUES (?, ?, 1, ?, ?)
  `);

  const tx = db.transaction(() => {
    const ticketNumber = nextTicketNumber(opts.guildId);
    const info = insert.run(
      opts.guildId,
      ticketNumber,
      opts.channelId,
      opts.creatorUserId,
      reasonNorm.reason,
      t,
      openedByStaffId,
      openedByStaffId // auto-claim opener as staff owner when staff-initiated
    );
    const id = Number(info.lastInsertRowid);
    insertMember.run(
      id,
      opts.creatorUserId,
      t,
      openedByStaffId || opts.creatorUserId
    );
    // Staff-opened tickets: opener is named staff exclusively (user overwrite),
    // so junior staff / ManageGuild-only openers can see the channel.
    if (openedByStaffId) {
      insertStaff.run(id, openedByStaffId, t, openedByStaffId);
    }
    return id;
  });

  return getTicketById(tx());
}

/**
 * @param {number} id
 * @returns {object|null}
 */
function getTicketById(id) {
  if (id == null) return null;
  return (
    db.prepare(`SELECT * FROM tickets WHERE id=?`).get(Number(id)) || null
  );
}

/**
 * @param {string} channelId
 * @returns {object|null}
 */
function getTicketByChannel(channelId) {
  if (!channelId) return null;
  return (
    db.prepare(`SELECT * FROM tickets WHERE channel_id=?`).get(channelId) ||
    null
  );
}

/**
 * @param {string} guildId
 * @param {number} ticketNumber
 * @returns {object|null}
 */
function getTicketByNumber(guildId, ticketNumber) {
  if (!guildId || ticketNumber == null) return null;
  return (
    db
      .prepare(
        `SELECT * FROM tickets WHERE guild_id=? AND ticket_number=?`
      )
      .get(guildId, Number(ticketNumber)) || null
  );
}

/**
 * @param {string} token
 * @returns {object|null}
 */
function getTicketByTranscriptToken(token) {
  if (!token) return null;
  return (
    db
      .prepare(`SELECT * FROM tickets WHERE transcript_token=?`)
      .get(token) || null
  );
}

/**
 * @param {number} ticketId
 * @param {string} userId
 * @returns {object}
 */
function claimTicket(ticketId, userId) {
  const t = now();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE tickets SET staff_owner_id=? WHERE id=? AND status='open'`
    ).run(userId, ticketId);
    db.prepare(`
      INSERT INTO ticket_staff (ticket_id, user_id, is_owner, added_at, added_by)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(ticket_id, user_id) DO UPDATE SET is_owner=1
    `).run(ticketId, userId, t, userId);
    // Clear is_owner on others
    db.prepare(
      `UPDATE ticket_staff SET is_owner=0 WHERE ticket_id=? AND user_id!=?`
    ).run(ticketId, userId);
  });
  tx();
  return getTicketById(ticketId);
}

/**
 * @param {number} ticketId
 * @param {string} newOwnerId
 * @param {string} byUserId
 * @returns {object}
 */
function transferTicket(ticketId, newOwnerId, byUserId) {
  const t = now();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE tickets SET staff_owner_id=? WHERE id=? AND status='open'`
    ).run(newOwnerId, ticketId);
    db.prepare(`
      INSERT INTO ticket_staff (ticket_id, user_id, is_owner, added_at, added_by)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(ticket_id, user_id) DO UPDATE SET is_owner=1
    `).run(ticketId, newOwnerId, t, byUserId);
    db.prepare(
      `UPDATE ticket_staff SET is_owner=0 WHERE ticket_id=? AND user_id!=?`
    ).run(ticketId, newOwnerId);
  });
  tx();
  return getTicketById(ticketId);
}

/**
 * @param {number} ticketId
 * @param {string} userId
 * @param {string} addedBy
 * @returns {boolean} true if inserted
 */
function addTicketStaff(ticketId, userId, addedBy) {
  const t = now();
  const info = db
    .prepare(
      `
    INSERT OR IGNORE INTO ticket_staff (ticket_id, user_id, is_owner, added_at, added_by)
    VALUES (?, ?, 0, ?, ?)
  `
    )
    .run(ticketId, userId, t, addedBy);
  return info.changes > 0;
}

/**
 * @param {number} ticketId
 * @param {string} userId
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function removeTicketStaff(ticketId, userId) {
  const ticket = getTicketById(ticketId);
  if (!ticket) return { ok: false, error: "Ticket not found." };
  if (ticket.staff_owner_id === userId) {
    return {
      ok: false,
      error: "Cannot remove the staff owner. Transfer ownership first.",
    };
  }
  const info = db
    .prepare(`DELETE FROM ticket_staff WHERE ticket_id=? AND user_id=?`)
    .run(ticketId, userId);
  if (info.changes === 0) {
    return { ok: false, error: "That user is not on the staff allow-list." };
  }
  return { ok: true };
}

/**
 * @param {number} ticketId
 * @param {string} [ownerId] optional auto-claim owner
 * @returns {object}
 */
function setTicketSensitive(ticketId, ownerId) {
  if (ownerId) {
    claimTicket(ticketId, ownerId);
  }
  db.prepare(`UPDATE tickets SET is_sensitive=1 WHERE id=? AND status='open'`).run(
    ticketId
  );
  return getTicketById(ticketId);
}

/**
 * @param {number} ticketId
 * @returns {object}
 */
function setTicketUnsensitive(ticketId) {
  db.prepare(`UPDATE tickets SET is_sensitive=0 WHERE id=? AND status='open'`).run(
    ticketId
  );
  return getTicketById(ticketId);
}

/**
 * @param {number} ticketId
 * @param {string} userId
 * @param {string} addedBy
 * @returns {boolean}
 */
function addTicketMember(ticketId, userId, addedBy) {
  const t = now();
  const info = db
    .prepare(
      `
    INSERT OR IGNORE INTO ticket_members (ticket_id, user_id, added_at, added_by)
    VALUES (?, ?, ?, ?)
  `
    )
    .run(ticketId, userId, t, addedBy);
  return info.changes > 0;
}

/**
 * @param {number} ticketId
 * @param {string} userId
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function removeTicketMember(ticketId, userId) {
  const ticket = getTicketById(ticketId);
  if (!ticket) return { ok: false, error: "Ticket not found." };
  if (ticket.creator_user_id === userId) {
    return {
      ok: false,
      error: "Cannot remove the ticket creator. Close the ticket instead.",
    };
  }
  const info = db
    .prepare(`DELETE FROM ticket_members WHERE ticket_id=? AND user_id=?`)
    .run(ticketId, userId);
  if (info.changes === 0) {
    return { ok: false, error: "That user is not a ticket member." };
  }
  return { ok: true };
}

/**
 * @param {number} ticketId
 * @returns {object[]}
 */
function listTicketMembers(ticketId) {
  return db
    .prepare(
      `SELECT * FROM ticket_members WHERE ticket_id=? ORDER BY added_at ASC`
    )
    .all(ticketId);
}

/**
 * @param {number} ticketId
 * @returns {object[]}
 */
function listTicketStaff(ticketId) {
  return db
    .prepare(
      `SELECT * FROM ticket_staff WHERE ticket_id=? ORDER BY is_owner DESC, added_at ASC`
    )
    .all(ticketId);
}

/**
 * @param {string} guildId
 * @param {object} [opts]
 * @param {string} [opts.userId] filter by creator or member
 * @param {number} [opts.limit]
 * @returns {object[]}
 */
function listOpenTickets(guildId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 25, 1), 50);
  if (opts.userId) {
    return db
      .prepare(
        `
      SELECT DISTINCT t.* FROM tickets t
      LEFT JOIN ticket_members m ON m.ticket_id = t.id
      WHERE t.guild_id=? AND t.status='open'
        AND (t.creator_user_id=? OR m.user_id=?)
      ORDER BY t.ticket_number DESC
      LIMIT ?
    `
      )
      .all(guildId, opts.userId, opts.userId, limit);
  }
  return db
    .prepare(
      `
    SELECT * FROM tickets
    WHERE guild_id=? AND status='open'
    ORDER BY ticket_number DESC
    LIMIT ?
  `
    )
    .all(guildId, limit);
}

/**
 * Soft-close: mark closed, keep channel for staff until /ticket archive.
 * Does not clear channel_id and does not set archived.
 * @param {number} ticketId
 * @param {object} opts
 * @param {string} opts.closedBy
 * @param {string|null} [opts.closeReason]
 * @returns {object|null}
 */
function markTicketClosed(ticketId, opts) {
  const reasonNorm = normalizeTicketReason(opts.closeReason, "Close reason", {
    allowEmpty: true,
  });
  if (!reasonNorm.ok) {
    const err = new Error(reasonNorm.error);
    err.code = "INVALID_REASON";
    throw err;
  }

  const t = now();
  const info = db
    .prepare(
      `
    UPDATE tickets SET
      status='closed',
      closed_at=?,
      closed_by_user_id=?,
      close_reason=?,
      archived=0
    WHERE id=? AND status='open'
  `
    )
    .run(t, opts.closedBy, reasonNorm.reason, ticketId);
  if (info.changes === 0) return getTicketById(ticketId);
  return getTicketById(ticketId);
}

/**
 * Finalize sensitive archive: metadata only, drop channel_id, never content-archive.
 * Works on open or soft-closed tickets that still have a channel.
 * @param {number} ticketId
 * @param {object} opts
 * @param {string} opts.closedBy
 * @param {string|null} [opts.closeReason]
 * @returns {object|null}
 */
function closeTicketSensitive(ticketId, opts) {
  const reasonNorm = normalizeTicketReason(opts.closeReason, "Close reason", {
    allowEmpty: true,
  });
  if (!reasonNorm.ok) {
    const err = new Error(reasonNorm.error);
    err.code = "INVALID_REASON";
    throw err;
  }

  const existing = getTicketById(ticketId);
  if (!existing || Number(existing.archived) === 1) return existing;

  const t = now();
  const closedAt = existing.closed_at || t;
  const closedBy = existing.closed_by_user_id || opts.closedBy;
  const closeReason =
    reasonNorm.reason != null
      ? reasonNorm.reason
      : existing.close_reason;

  db.prepare(
    `
    UPDATE tickets SET
      status='closed',
      closed_at=?,
      closed_by_user_id=?,
      close_reason=?,
      archived=0,
      transcript_token=NULL,
      transcript_path=NULL,
      channel_id=NULL
    WHERE id=? AND archived=0
  `
  ).run(closedAt, closedBy, closeReason, ticketId);
  return getTicketById(ticketId);
}

/**
 * Finalize full archive: transcript metadata + clear channel_id.
 * Works on open or soft-closed tickets that are not yet archived.
 * @param {number} ticketId
 * @param {object} opts
 * @param {string} opts.closedBy
 * @param {string|null} [opts.closeReason]
 * @param {string|null} opts.transcriptToken
 * @param {string|null} opts.transcriptPath
 * @param {string|null} [opts.aiSummaryJson]
 * @param {string|null} [opts.archiveMessageId]
 * @returns {object|null}
 */
function closeTicketArchived(ticketId, opts) {
  const reasonNorm = normalizeTicketReason(opts.closeReason, "Close reason", {
    allowEmpty: true,
  });
  if (!reasonNorm.ok) {
    const err = new Error(reasonNorm.error);
    err.code = "INVALID_REASON";
    throw err;
  }

  const existing = getTicketById(ticketId);
  if (!existing || Number(existing.archived) === 1) return existing;

  const hasTranscript = !!(opts.transcriptToken && opts.transcriptPath);
  const t = now();
  const closedAt = existing.closed_at || t;
  const closedBy = existing.closed_by_user_id || opts.closedBy;
  const closeReason =
    reasonNorm.reason != null
      ? reasonNorm.reason
      : existing.close_reason;

  db.prepare(
    `
    UPDATE tickets SET
      status='closed',
      closed_at=?,
      closed_by_user_id=?,
      close_reason=?,
      transcript_token=?,
      transcript_path=?,
      ai_summary_json=?,
      archive_message_id=?,
      archived=?,
      channel_id=NULL
    WHERE id=? AND archived=0
  `
  ).run(
    closedAt,
    closedBy,
    closeReason,
    opts.transcriptToken || null,
    opts.transcriptPath || null,
    opts.aiSummaryJson || null,
    opts.archiveMessageId || null,
    hasTranscript ? 1 : 0,
    ticketId
  );
  return getTicketById(ticketId);
}

/**
 * External channel delete: mark closed/disposed, no content archive.
 * @param {string} channelId
 * @returns {object|null} updated ticket or null
 */
function markTicketClosedByChannelDelete(channelId) {
  const ticket = getTicketByChannel(channelId);
  if (!ticket) return null;
  if (Number(ticket.archived) === 1) return ticket;
  const t = now();
  db.prepare(
    `
    UPDATE tickets SET
      status='closed',
      closed_at=COALESCE(closed_at, ?),
      closed_by_user_id=COALESCE(closed_by_user_id, NULL),
      close_reason=COALESCE(close_reason, 'Channel deleted outside /ticket close'),
      archived=0,
      channel_id=NULL
    WHERE id=?
  `
  ).run(t, ticket.id);
  return getTicketById(ticket.id);
}

/**
 * @param {number} ticketId
 * @param {object[]} messages
 */
function saveTicketMessages(ticketId, messages) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ticket_messages (
      ticket_id, message_id, author_id, author_tag, content,
      attachment_urls, embeds_json, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    for (const m of rows) {
      insert.run(
        ticketId,
        m.message_id,
        m.author_id,
        m.author_tag || "unknown",
        m.content ?? null,
        m.attachment_urls != null
          ? typeof m.attachment_urls === "string"
            ? m.attachment_urls
            : JSON.stringify(m.attachment_urls)
          : null, // may be string[] or {url,name,href,...}[]
        m.embeds_json != null
          ? typeof m.embeds_json === "string"
            ? m.embeds_json
            : JSON.stringify(m.embeds_json)
          : null,
        m.sent_at
      );
    }
  });
  tx(messages);
}

/**
 * @param {number} ticketId
 * @returns {object[]}
 */
function listTicketMessages(ticketId) {
  return db
    .prepare(
      `SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY sent_at ASC, id ASC`
    )
    .all(ticketId);
}

/**
 * Content-archived tickets (non-sensitive full archive with transcript).
 * @param {object} [opts]
 * @param {string} [opts.guildId] filter to one guild
 * @param {number} [opts.limit=50]
 * @param {number} [opts.offset=0]
 * @returns {object[]}
 */
function listArchivedTickets(opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  if (opts.guildId) {
    return db
      .prepare(
        `
      SELECT * FROM tickets
      WHERE guild_id=? AND archived=1 AND transcript_token IS NOT NULL
      ORDER BY closed_at DESC, ticket_number DESC
      LIMIT ? OFFSET ?
    `
      )
      .all(opts.guildId, limit, offset);
  }

  return db
    .prepare(
      `
    SELECT * FROM tickets
    WHERE archived=1 AND transcript_token IS NOT NULL
    ORDER BY closed_at DESC, guild_id ASC, ticket_number DESC
    LIMIT ? OFFSET ?
  `
    )
    .all(limit, offset);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.guildId]
 * @returns {number}
 */
function countArchivedTickets(opts = {}) {
  if (opts.guildId) {
    const row = db
      .prepare(
        `
      SELECT COUNT(*) AS n FROM tickets
      WHERE guild_id=? AND archived=1 AND transcript_token IS NOT NULL
    `
      )
      .get(opts.guildId);
    return Number(row?.n || 0);
  }
  const row = db
    .prepare(
      `
    SELECT COUNT(*) AS n FROM tickets
    WHERE archived=1 AND transcript_token IS NOT NULL
  `
    )
    .get();
  return Number(row?.n || 0);
}

/**
 * @returns {string} UUID v4
 */
function generateTranscriptToken() {
  return crypto.randomUUID();
}

/**
 * Update archive_message_id after posting.
 * @param {number} ticketId
 * @param {string} messageId
 */
function setTicketArchiveMessageId(ticketId, messageId) {
  db.prepare(`UPDATE tickets SET archive_message_id=? WHERE id=?`).run(
    messageId,
    ticketId
  );
}

// ---------------------------------------------------------------------------
// Ticket panel registry — stored panels for list / edit / delete
// ---------------------------------------------------------------------------

/**
 * Register a posted panel message.
 * @param {string} guildId
 * @param {string} channelId
 * @param {string} messageId
 * @param {string} [title]
 * @param {string} [description]
 */
function createTicketPanel(guildId, channelId, messageId, title, description) {
  const t = now();
  db.prepare(`
    INSERT INTO ticket_panels (guild_id, channel_id, message_id, title, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    guildId,
    channelId,
    messageId,
    title || "Support Tickets",
    description || "Click **Open a ticket** below to start a private conversation with staff. You'll be asked to describe what you need help with.",
    t,
    t,
  );
}

/**
 * @param {string} guildId
 * @param {string} messageId
 * @returns {object|null}
 */
function getTicketPanel(guildId, messageId) {
  return (
    db.prepare(`
      SELECT guild_id, channel_id, message_id, title, description, created_at, updated_at
      FROM ticket_panels
      WHERE guild_id=? AND message_id=?
    `).get(guildId, messageId) || null
  );
}

/**
 * @param {string} guildId
 * @returns {object[]}
 */
function listTicketPanels(guildId) {
  return db.prepare(`
    SELECT guild_id, channel_id, message_id, title, description, created_at, updated_at
    FROM ticket_panels
    WHERE guild_id=?
    ORDER BY created_at ASC
  `).all(guildId);
}

/**
 * Update a panel's title and/or description.
 * @param {string} guildId
 * @param {string} messageId
 * @param {string|null} [title]
 * @param {string|null} [description]
 * @returns {boolean} true if panel existed and was updated
 */
function updateTicketPanelText(guildId, messageId, title, description) {
  const existing = getTicketPanel(guildId, messageId);
  if (!existing) return false;
  const t = now();
  db.prepare(`
    UPDATE ticket_panels
    SET title=?, description=?, updated_at=?
    WHERE guild_id=? AND message_id=?
  `).run(
    title != null ? title : existing.title,
    description != null ? description : existing.description,
    t,
    guildId,
    messageId,
  );
  return true;
}

/**
 * Remove a panel from the registry.
 * @param {string} guildId
 * @param {string} messageId
 * @returns {{ removed: boolean, channel_id: string|null }}
 */
function deleteTicketPanel(guildId, messageId) {
  const existing = getTicketPanel(guildId, messageId);
  if (!existing) {
    return { removed: false, channel_id: null };
  }
  const result = db.prepare(`
    DELETE FROM ticket_panels
    WHERE guild_id=? AND message_id=?
  `).run(guildId, messageId);
  return {
    removed: result.changes > 0,
    channel_id: existing.channel_id,
  };
}

module.exports = {
  MAX_TICKET_REASON,
  normalizeTicketReason,
  nextTicketNumber,
  getTicketSettings,
  getLastSelfCreatedTicket,
  canUserCreateTicket,
  createTicket,
  getTicketById,
  getTicketByChannel,
  getTicketByNumber,
  getTicketByTranscriptToken,
  claimTicket,
  transferTicket,
  addTicketStaff,
  removeTicketStaff,
  setTicketSensitive,
  setTicketUnsensitive,
  addTicketMember,
  removeTicketMember,
  listTicketMembers,
  listTicketStaff,
  listOpenTickets,
  listArchivedTickets,
  countArchivedTickets,
  markTicketClosed,
  closeTicketSensitive,
  closeTicketArchived,
  markTicketClosedByChannelDelete,
  saveTicketMessages,
  listTicketMessages,
  generateTranscriptToken,
  setTicketArchiveMessageId,

  // panel registry
  createTicketPanel,
  getTicketPanel,
  listTicketPanels,
  updateTicketPanelText,
  deleteTicketPanel,
};
