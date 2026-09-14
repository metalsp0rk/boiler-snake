/**
 * Gork interaction logging (E2E replay): one row per Gork agent call
 * capturing the ENTIRE request (exact system/user prompts, tool schemas,
 * sampling params, settings/context/roster/memory inputs, raw trigger
 * message) and the ENTIRE response (raw + shipped answer + per-round wire
 * transcript with tool events). Exportable as replay fixtures so
 * prompt/context-build regressions are caught by E2E tests.
 *
 * - `gork_interactions`: one interaction per row; `uid` is the external
 *   handle (crypto.randomUUID from the recorder) so rows survive id churn.
 *   JSON columns (`params`, `tools`, `settings`, `context_*`, `roster_*`,
 *   `memory_meta`, `transcript`, `usage`) carry already-stringified JSON
 *   written by the recorder; rows are pruned lazily on the write path
 *   (retention window, no ticker).
 * - `parent_uid` links a `memory_turn` row to the `qa` row that spawned it.
 * - `guild_settings.gork_interaction_log_enabled`: per-guild switch,
 *   default ON (1) — the user decision was capture-by-default; staff can
 *   turn it off per guild (`/gork log off`, phase 4) and the env
 *   kill-switch (recorder config) overrides everything.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ addColumnIfMissing: Function }} helpers
 */
function up(db, { addColumnIfMissing }) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS gork_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'qa',          -- qa | memory_turn
    parent_uid TEXT,                          -- memory_turn → qa uid
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,                 -- trigger message
    user_id TEXT NOT NULL,                    -- asker
    status TEXT NOT NULL,                     -- shipped | partial | failure | error
    started_at INTEGER NOT NULL,
    duration_ms INTEGER,
    model TEXT,
    params TEXT,                              -- JSON: temperature,max_tokens,thinking_token_budget,max_tool_rounds,timeout_ms
    tools TEXT,                               -- JSON: tool schemas array actually sent (or null)
    settings TEXT,                            -- JSON: relevant guild_settings snapshot (keyword, context_window, cooldown, rules present?, search/memory flags)
    system_prompt TEXT,
    user_prompt TEXT,                         -- exact composed user content as sent
    trigger_content TEXT,                     -- RAW trigger message content (with keyword) for replay
    reply_to_message_id TEXT,                 -- message.reference?.messageId ?? null
    context_meta TEXT,                        -- JSON: {mode, collected, chars}
    context_messages TEXT,                    -- JSON: [{id,authorId,content,timestamp}] as buildContext collected
    roster_meta TEXT,                         -- JSON: {entries:n, truncated:n}
    roster_block TEXT,                        -- formatRosterBlock output as sent
    roster_entries TEXT,                      -- JSON: [{id,display,handle,nickname,roles?}] for replay member stubs
    memory_meta TEXT,                         -- JSON: {mode,indexed,selectedIds,blockChars} or null
    transcript TEXT,                          -- JSON: {events:[...], truncated:bool} — see event contract
    answer_raw TEXT,
    answer_shipped TEXT,                      -- post sanitize+cap, exactly what was posted
    finish_reason TEXT,
    usage TEXT,                               -- JSON provider usage
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_gork_interactions_guild ON gork_interactions (guild_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_gork_interactions_msg ON gork_interactions (guild_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_gork_interactions_kind ON gork_interactions (kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_gork_interactions_uid ON gork_interactions (uid);
  CREATE INDEX IF NOT EXISTS idx_gork_interactions_created ON gork_interactions (created_at);
  `);

  addColumnIfMissing(
    "guild_settings",
    "gork_interaction_log_enabled",
    "gork_interaction_log_enabled INTEGER NOT NULL DEFAULT 1"
  );
}

module.exports = { id: "027_gork_interaction_log", up };
