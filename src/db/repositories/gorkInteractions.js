/**
 * Gork interaction-log repository (E2E capture store): one row per Gork
 * agent call, written by the interaction recorder after every job. Rows
 * carry the full request/response capture (prompts, settings/context/
 * roster snapshots, per-round transcript with tool events, raw + shipped
 * answer) as already-stringified JSON — this layer never parses or builds
 * JSON, it only stores and reads.
 *
 * Synchronous better-sqlite3 throughout (same idiom as gorkBudget/gorkMemory):
 * reads return [] / null / 0 instead of throwing, and the write path is
 * `{ok:false, error}` on failure (never throws into the reply path).
 * Retention hygiene: every successful insert lazily prunes rows older than
 * `retentionDays` (default 30; 0 = forever) so the table stays bounded
 * without a ticker.
 */

const { db, now } = require("../connection");

/** Lazy-prune window applied on insert when the caller passes nothing. */
const DEFAULT_RETENTION_DAYS = 30;

const DAY_MS = 86400000;

/** Summary projection for list views — never the heavy JSON/blob columns. */
const SUMMARY_COLUMNS = `
  id, uid, kind, status, model, user_id, channel_id, message_id,
  duration_ms, tool_call_count, created_at, error
`;

/** undefined → null: better-sqlite3 cannot bind undefined, and every
 *  nullable column reads back as null. */
const toNullish = (v) => (v === undefined ? null : v);

/** Epoch-ms/integer coercion: null passes through, garbage becomes null
 *  instead of poisoning the bind (NaN/Infinity throw in better-sqlite3). */
const toIntOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** Row → positional bind list in INSERT_COLUMNS order (pure). */
const bindRow = (row) => [
  toNullish(row.uid),
  row.kind === undefined || row.kind === null || row.kind === "" ? "qa" : row.kind,
  toNullish(row.parent_uid),
  toNullish(row.guild_id),
  toNullish(row.channel_id),
  toNullish(row.message_id),
  toNullish(row.user_id),
  toNullish(row.status),
  toIntOrNull(row.started_at),
  toIntOrNull(row.duration_ms),
  toNullish(row.model),
  toNullish(row.params),
  toNullish(row.tools),
  toNullish(row.settings),
  toNullish(row.system_prompt),
  toNullish(row.user_prompt),
  toNullish(row.trigger_content),
  toNullish(row.reply_to_message_id),
  toNullish(row.context_meta),
  toNullish(row.context_messages),
  toNullish(row.roster_meta),
  toNullish(row.roster_block),
  toNullish(row.roster_entries),
  toNullish(row.memory_meta),
  toNullish(row.transcript),
  toNullish(row.answer_raw),
  toNullish(row.answer_shipped),
  toNullish(row.finish_reason),
  toNullish(row.usage),
  Number.isFinite(Number(row.tool_call_count))
    ? Math.trunc(Number(row.tool_call_count))
    : 0,
  toNullish(row.error),
  toIntOrNull(row.created_at) ?? now(),
];

const insertStmt = db.prepare(`
INSERT INTO gork_interactions (
  uid, kind, parent_uid, guild_id, channel_id, message_id, user_id, status,
  started_at, duration_ms, model, params, tools, settings, system_prompt,
  user_prompt, trigger_content, reply_to_message_id, context_meta,
  context_messages, roster_meta, roster_block, roster_entries, memory_meta,
  transcript, answer_raw, answer_shipped, finish_reason, usage,
  tool_call_count, error, created_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?
)
`);

/**
 * Insert one captured interaction and lazily prune the retention window.
 * JSON columns arrive as already-stringified strings (or null) from the
 * caller; `undefined` is normalized to `null`, `created_at` is stamped
 * server-side when the caller omits it. NEVER throws.
 *
 * @param {object} row column-keyed values (uid, kind, parent_uid, guild_id,
 *   channel_id, message_id, user_id, status, started_at, duration_ms, model,
 *   params, tools, settings, system_prompt, user_prompt, trigger_content,
 *   reply_to_message_id, context_meta, context_messages, roster_meta,
 *   roster_block, roster_entries, memory_meta, transcript, answer_raw,
 *   answer_shipped, finish_reason, usage, tool_call_count, error, created_at)
 * @param {{ retentionDays?: number }} [opts] prune window in days; 0 (or a
 *   negative/garbage value) disables the lazy prune (rows kept forever)
 * @returns {{ ok: true, id: number } | { ok: false, error: string }}
 */
function insertGorkInteraction(row, { retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  try {
    const result = insertStmt.run(...bindRow(row || {}));
    const id = Number(result.lastInsertRowid);
    // Lazy prune AFTER the committed insert (write-path hygiene, same
    // no-ticker pattern as gork_usage). pruneGorkInteractions never throws,
    // so hygiene failures can never flip a stored row into a failed insert.
    const days = Number(retentionDays);
    if (Number.isFinite(days) && days > 0) {
      pruneGorkInteractions(now() - days * DAY_MS);
    }
    return { ok: true, id };
  } catch (err) {
    // Ids ride along (AGENTS.md: enough to reproduce from logs alone).
    console.error(
      "[gork] interaction log insert failed:",
      err?.message || err,
      `(uid=${row?.uid ?? "none"} guild=${row?.guild_id ?? "none"} message=${row?.message_id ?? "none"})`,
    );
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Newest-first summary rows for a guild WITHOUT the heavy blobs
 * (prompts/transcript/snapshots stay out; use getGorkInteractionByUid for
 * the full row). Never throws.
 *
 * @param {{ guildId: string, kind?: string, limit?: number, beforeId?: number|string }} query
 *   `beforeId` (row id, exclusive) paginates older pages; `limit` defaults to 20
 * @returns {object[]} summary rows ordered by id DESC
 */
function listGorkInteractions({ guildId, kind, limit = 20, beforeId } = {}) {
  if (!guildId) return [];
  try {
    const raw = Number(limit);
    const lim = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 20;
    const clauses = ["guild_id=?"];
    const params = [String(guildId)];
    if (kind) {
      clauses.push("kind=?");
      params.push(String(kind));
    }
    const before = toIntOrNull(beforeId);
    if (before !== null) {
      clauses.push("id < ?");
      params.push(before);
    }
    params.push(lim);
    return db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM gork_interactions
       WHERE ${clauses.join(" AND ")}
       ORDER BY id DESC
       LIMIT ?`
      )
      .all(...params);
  } catch (err) {
    console.error("[gork] interaction log list failed:", err?.message || err);
    return [];
  }
}

/**
 * Full row (all columns incl. transcript and prompt blobs) by the uid handle.
 * Never throws.
 *
 * @param {string} uid
 * @returns {object|null} the stored row, or null when absent/garbage input
 */
function getGorkInteractionByUid(uid) {
  if (!uid) return null;
  try {
    const row = db
      .prepare(`SELECT * FROM gork_interactions WHERE uid=?`)
      .get(String(uid));
    return row ?? null;
  } catch (err) {
    console.error("[gork] interaction log get failed:", err?.message || err);
    return null;
  }
}

/**
 * Stored rows for a guild (staff `/gork status` / `/gork log` lines).
 * Never throws.
 *
 * @param {string} guildId
 * @param {{ kind?: string }} [opts] restrict to one kind (qa | memory_turn)
 * @returns {number} 0 for an empty/unknown guild or on read failure
 */
function countGorkInteractions(guildId, { kind } = {}) {
  if (!guildId) return 0;
  try {
    const row = kind
      ? db
          .prepare(
            `SELECT COUNT(*) AS n FROM gork_interactions WHERE guild_id=? AND kind=?`
          )
          .get(String(guildId), String(kind))
      : db
          .prepare(`SELECT COUNT(*) AS n FROM gork_interactions WHERE guild_id=?`)
          .get(String(guildId));
    return Number(row?.n) || 0;
  } catch (err) {
    console.error("[gork] interaction log count failed:", err?.message || err);
    return 0;
  }
}

/**
 * Delete every row created before `olderThanMs` (epoch-ms cutoff); the
 * insert path uses it for the lazy retention prune. Never throws.
 *
 * @param {number} olderThanMs epoch-ms cutoff; non-finite is a no-op
 * @returns {number} deleted row count
 */
function pruneGorkInteractions(olderThanMs) {
  const cutoff = Number(olderThanMs);
  if (!Number.isFinite(cutoff)) return 0;
  try {
    return db
      .prepare(`DELETE FROM gork_interactions WHERE created_at < ?`)
      .run(Math.trunc(cutoff)).changes;
  } catch (err) {
    console.error("[gork] interaction log prune failed:", err?.message || err);
    return 0;
  }
}

/**
 * Wipe one guild's whole interaction log. Never throws.
 *
 * @param {string} guildId
 * @returns {boolean} true when rows actually existed and were removed
 */
function deleteGorkInteractionsForGuild(guildId) {
  if (!guildId) return false;
  try {
    return (
      db.prepare(`DELETE FROM gork_interactions WHERE guild_id=?`).run(String(guildId))
        .changes > 0
    );
  } catch (err) {
    console.error("[gork] interaction log delete failed:", err?.message || err);
    return false;
  }
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  insertGorkInteraction,
  listGorkInteractions,
  getGorkInteractionByUid,
  countGorkInteractions,
  pruneGorkInteractions,
  deleteGorkInteractionsForGuild,
};
