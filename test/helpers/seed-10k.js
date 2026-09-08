/**
 * Deterministic 10k-scale fixture for the Phase 1 acceptance gate
 * (roadmap/web-admin.md §8.8 Phase 1 exit: "query-budget checks pass on
 * seeded DB (10k users/messages)"; subtask 23).
 *
 * WHY A SEPARATE HELPER: the gate suite (test/web-phase1-gate.test.js) owns
 * the ACCESS/query-budget assertions; this module owns only FAST, DETERMINIS-
 * TIC bulk seeding. Every table is written through the shared better-sqlite3
 * handle exported by the db facade (`api.db`) using PREPARED statements
 * inside db.transaction() batches — the same write discipline the repos use
 * (src/db/repositories/users.js, tickets.js) — so ~45k rows seed in seconds
 * and the whole gate file stays far below the 60 s budget.
 *
 * DETERMINISM:
 *  - rng: fixed-seed mulberry32 (never Math.random);
 *  - ids: contiguous BigInt snowflake-shaped strings (never Number — ids
 *    beyond 2^53 must not lose precision);
 *  - transcript tokens: UUID-v4-SHAPED strings derived from the rng (the
 *    route gate only regex-checks the shape + resolves the row);
 *  - timestamps: every created/closed stamp is `base + offset` from the
 *    injected base clock — ordering is absolute and reproducible (the audit
 *    pagination test relies on exactly-this ordering).
 *
 * SHAPE NOTES (pinned against the migrations, NOT guessed):
 *  - tickets.channel_id is UNIQUE and archived rows clear it in production
 *    (closeTicketArchived) — bulk archived rows therefore carry a NULL
 *    channel; open rows carry unique ids;
 *  - archived rows carry transcript_token + transcript_path so the /t index
 *    COUNTs + lists them exactly like the real archive flow wrote them;
 *    transcript FILES are not written here — only the harness-seeded rich
 *    tickets (test/helpers/access-matrix.js seedArchivedTicket) are ever
 *    OPENED by the gate; the bulk rows exist to scale list/count pages.
 *  - warnings/staff_notes keep per-guild sequential numbers (UNIQUE
 *    (guild_id, warning_number|note_number)); the dedicated fixture user's
 *    rows continue the sequences so nothing special-cases them.
 */

/** ms per day — local constant to keep this helper dependency-free. */
const DAY_MS = 86_400_000;

/**
 * mulberry32 — tiny deterministic PRNG. Fixed seed ⇒ identical fixture on
 * every run / machine (the "deterministic seed" acceptance criterion).
 * @param {number} seed
 * @returns {() => number} floats in [0, 1)
 */
function createRng(seed = 0x5eed10) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * UUID v4-SHAPED deterministic token: 8-4-4-4-12 hex with the version nibble
 * `4` and a variant nibble in [89ab] so routes/transcripts.js UUID_RE
 * accepts it (the route then resolves the ROW — randomness is not security
 * here because the fixture is offline and every bulk token stays inside the
 * temp DB).
 * @param {() => number} rng
 * @returns {string}
 */
function detUuid(rng) {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const run = (n) => Array.from({ length: n }, hex).join("");
  const variant = (8 + Math.floor(rng() * 4)).toString(16); // 8|9|a|b
  return `${run(8)}-${run(4)}-4${run(3)}-${variant}${run(3)}-${run(12)}`;
}

/**
 * UTC calendar-day key (YYYY-MM-DD) from epoch ms — mirrors
 * src/db/repositories/userChannelActivity.js utcDayKey (PK `day` format).
 * @param {number} ms
 * @returns {string}
 */
function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Default scale (subtask 23 / design §8.8): ONE guild, ~10k tracked users,
 * ~5k warnings + ~5k staff notes, ~2k archived + a saturating number of
 * open tickets, ~2k admin_audit rows, and ≥10k message/activity rows split
 * across user_channel_message_daily + activity_log.
 */
const DEFAULT_SCALE = Object.freeze({
  users: 10_000,
  warnings: 5_000,
  notes: 5_000,
  ticketsArchived: 2_000,
  ticketsOpen: 60, // > the dashboard's 50-row cap ⇒ "50+" saturation
  audit: 2_000,
  dailyRows: 10_000, // user_channel_message_daily ("messages")
  activityLog: 10_000, // activity_log (XP/decay events)
  voiceSessions: 200,
});

/**
 * Seed the full scale fixture. MUST be called AFTER loadDb() and BEFORE the
 * per-request statement capture is exercised (writes count only while the
 * recorder is active — seeding with it inactive keeps budgets honest).
 *
 * @param {object} api src/db facade from test/helpers/env.js loadDb()
 * @param {object} spec
 * @param {string} spec.guildId primary (fully populated) guild
 * @param {string[]} spec.staffUserIds issuer/author identities for rows
 *   that should read as staff-created (e.g. [USER_ADMIN, USER_SENIOR])
 * @param {string} spec.trackedUserId dedicated profile fixture user (gets
 *   warnings + notes + tickets + activity footprint — the /g/users/:id page
 *   target); must NOT be part of the bulk id range
 * @param {string[]} [spec.participantUserIds] fixture users added as
 *   ticket_members / ticket_staff on the tracked user's tickets (§8.4)
 * @param {number} [spec.baseMs] absolute clock base for every timestamp
 *   (default Date.now()); determinism of ORDERING only depends on this base
 *   being constant within the run
 * @param {Partial<typeof DEFAULT_SCALE>} [spec.scale] per-table row counts
 * @param {number} [spec.seed] rng seed
 * @returns {{ scale: typeof DEFAULT_SCALE, userIds: string[],
 *   trackedTicketIds: { archived: number[], open: number[] },
 *   auditCountByOrigin: Record<string, number>, counts: Record<string, number> }}
 */
function seed10k(api, spec) {
  if (!api || !api.db || typeof api.db.prepare !== "function") {
    throw new TypeError("seed10k: expects the src/db facade (loadDb().api)");
  }
  const guildId = String(spec.guildId || "");
  if (!guildId) throw new TypeError("seed10k: spec.guildId is required");
  const trackedUserId = String(spec.trackedUserId || "");
  if (!trackedUserId) throw new TypeError("seed10k: spec.trackedUserId is required");
  const staff = (spec.staffUserIds || []).map(String);
  if (!staff.length) throw new TypeError("seed10k: spec.staffUserIds is required");
  const participants = (spec.participantUserIds || []).map(String);
  const base = Number(spec.baseMs) || Date.now();
  const scale = { ...DEFAULT_SCALE, ...(spec.scale || {}) };
  const rng = createRng(spec.seed == null ? 0x5eed10 : spec.seed);

  const db = api.db;

  // ------------------------------------------------------------------ users
  // Contiguous BigInt snowflake-shaped ids — no precision loss, no collision
  // with the 428…-shaped viewer ids the gate uses.
  const userIds = [];
  {
    const idBase = 9_000_000_000_000_000_000n;
    for (let i = 0; i < scale.users; i++) userIds.push(String(idBase + BigInt(1000 + i)));
    const ins = db.prepare(
      `INSERT INTO users (guild_id, user_id, xp, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    // XP spread pseudo-randomly so leaderboard/topUsers ORDER BY has real
    // work (and ties exist to keep the tie-break paths exercised).
    const tx = db.transaction(() => {
      for (let i = 0; i < userIds.length; i++) {
        const xp = Math.floor(rng() * 250_000) + (i % 97 === 0 ? 5_000_000 : 0);
        ins.run(guildId, userIds[i], xp, base, base);
      }
      ins.run(guildId, trackedUserId, 512_340, base, base);
    });
    tx();
  }
  const allTracked = [...userIds, trackedUserId];

  // --------------------------------------------------------- guild settings
  // Minimal row + a few non-default values so the settings page renders
  // "configured" states (getGuildSettings upserts on read; a real row makes
  // the request path read-only SELECT + upsert UPSERT with no first-touch
  // surprise for the statement pins).
  db.prepare(
    `INSERT INTO guild_settings (guild_id, updated_at, msg_xp, voice_xp_per_min,
        msg_cooldown_sec, level_xp_factor, decay_percent, warn_expiry_days,
        ticket_rate_limit_minutes, youtube_notification_channel_id,
        youtube_upload_role_id, event_reminder_channel_id,
        twitch_notification_channel_id, ticket_category_id, ticket_archive_channel_id)
     VALUES (?, ?, 7, 2, 30, 100, 0.15, 30, 60, '910000000000000001',
        '910000000000000002', '910000000000000003', '910000000000000004',
        '910000000000000005', '910000000000000006')
     ON CONFLICT(guild_id) DO UPDATE SET updated_at=excluded.updated_at`
  ).run(guildId, base);

  // ------------------------------------------------------- command channels
  {
    const ins = db.prepare(
      `INSERT INTO allowed_command_channels (guild_id, channel_id, created_at)
       VALUES (?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < 5; i++) ins.run(guildId, `92000000000000000${i}`, base);
    });
    tx();
  }

  // ----------------------------------------------------------- level roles
  {
    const ins = db.prepare(
      `INSERT INTO level_roles (guild_id, role_id, level_required, drop_grace_days,
          created_at, updated_at)
       VALUES (?, ?, ?, 3, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (let i = 1; i <= 6; i++) {
        ins.run(guildId, `93000000000000000${i}`, i * 3, base, base);
      }
    });
    tx();
  }

  // ------------------------------------------------------------- warnings
  // Sequential numbers 1..N (UNIQUE per guild); every 7th voided; subjects
  // pseudo-random bulk users. The tracked user's 12 warnings continue the
  // sequence (5001..) so nothing about them is special to the indexes.
  {
    const ins = db.prepare(
      `INSERT INTO warnings (guild_id, warning_number, user_id, issuer_id, reason,
          created_at, voided_at, voided_by, void_reason, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (let i = 1; i <= scale.warnings; i++) {
        const subject = userIds[Math.floor(rng() * userIds.length)];
        const voided = i % 7 === 0;
        ins.run(
          guildId,
          i,
          subject,
          staff[i % staff.length],
          `bulk warn ${i} — spam in <general>`,
          base + i * 1_000,
          voided ? base + i * 1_000 + 500 : null,
          voided ? staff[0] : null,
          voided ? "appeal upheld" : null,
          base + i * 1_000 + 90 * DAY_MS
        );
      }
      for (let j = 1; j <= 12; j++) {
        const voided = j === 12;
        ins.run(
          guildId,
          scale.warnings + j,
          trackedUserId,
          staff[0],
          `tracked warn ${j}`,
          base + (scale.warnings + j) * 1_000,
          voided ? base + (scale.warnings + j) * 1_000 + 1 : null,
          voided ? staff[0] : null,
          voided ? "voided on appeal" : null,
          null
        );
      }
    });
    tx();
  }

  // ----------------------------------------------------------- staff notes
  {
    const ins = db.prepare(
      `INSERT INTO staff_notes (guild_id, note_number, user_id, author_id, content,
          created_at, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (let i = 1; i <= scale.notes; i++) {
        const subject = userIds[Math.floor(rng() * userIds.length)];
        const deleted = i % 11 === 0;
        ins.run(
          guildId,
          i,
          subject,
          staff[i % staff.length],
          `bulk note ${i} — helper context`,
          base + i * 900,
          deleted ? base + i * 900 + 100 : null,
          deleted ? staff[1] : null
        );
      }
      for (let j = 1; j <= 8; j++) {
        const deleted = j === 8;
        ins.run(
          guildId,
          scale.notes + j,
          trackedUserId,
          staff[0],
          `tracked note ${j}`,
          base + (scale.notes + j) * 900,
          deleted ? base + (scale.notes + j) * 900 + 1 : null,
          deleted ? staff[0] : null
        );
      }
    });
    tx();
  }

  // --------------------------------------------------------------- tickets
  // Bulk archived (with token + path so /t COUNTs/LISTs them) + a saturating
  // batch of open ones (dashboard "50+"). The tracked user's own tickets and
  // the §8.4 participant fixtures ride the same sequences.
  const trackedTicketIds = { archived: [], open: [] };
  {
    const insArchived = db.prepare(
      `INSERT INTO tickets (guild_id, ticket_number, channel_id, creator_user_id,
          staff_owner_id, status, is_sensitive, reason, close_reason, created_at,
          closed_at, closed_by_user_id, transcript_token, transcript_path, archived)
       VALUES (?, ?, NULL, ?, ?, 'closed', 0, ?, 'closed by bulk fixture',
          ?, ?, ?, ?, ?, 1)`
    );
    const insOpen = db.prepare(
      `INSERT INTO tickets (guild_id, ticket_number, channel_id, creator_user_id,
          status, reason, created_at, archived)
       VALUES (?, ?, ?, ?, 'open', ?, ?, 0)`
    );
    const insMember = db.prepare(
      `INSERT OR IGNORE INTO ticket_members (ticket_id, user_id, added_at, added_by)
       VALUES (?, ?, ?, ?)`
    );
    const insStaff = db.prepare(
      `INSERT OR IGNORE INTO ticket_staff (ticket_id, user_id, is_owner, added_at, added_by)
       VALUES (?, ?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      let n = 0;
      for (let i = 1; i <= scale.ticketsArchived; i++) {
        const creator = userIds[Math.floor(rng() * userIds.length)];
        const created = base + i * 2_000;
        const token = detUuid(rng);
        const info = insArchived.run(
          guildId,
          ++n,
          creator,
          staff[i % staff.length],
          `bulk archived ticket ${i}`,
          created,
          created + 60_000,
          staff[0],
          token,
          `tickets/${token}/index.html`
        );
        void info;
      }
      for (let i = 1; i <= scale.ticketsOpen; i++) {
        const creator = userIds[Math.floor(rng() * userIds.length)];
        insOpen.run(
          guildId,
          ++n,
          `94${String(10000 + i)}0000000000000`,
          creator,
          `bulk open ticket ${i}`,
          base + scale.ticketsArchived * 2_000 + i * 1_000
        );
      }
      // --- tracked-user footprint (profile page: tickets section) ---------
      for (let j = 1; j <= 2; j++) {
        const token = detUuid(rng);
        const created = base + (scale.ticketsArchived + j) * 2_000;
        const info = insArchived.run(
          guildId,
          ++n,
          trackedUserId,
          staff[0],
          `tracked archived ticket ${j}`,
          created,
          created + 45_000,
          staff[0],
          token,
          `tickets/${token}/index.html`
        );
        trackedTicketIds.archived.push(Number(info.lastInsertRowid));
      }
      const openInfo = insOpen.run(
        guildId,
        ++n,
        "9499990000000000001",
        trackedUserId,
        "tracked open ticket",
        base + (scale.ticketsArchived + 10) * 2_000
      );
      trackedTicketIds.open.push(Number(openInfo.lastInsertRowid));
    });
    tx();

    // §8.4 membership on TWO of the tracked user's archived tickets: the
    // profile page and the participant transcript matrix share these rows.
    if (participants.length && trackedTicketIds.archived.length) {
      const tx2 = db.transaction(() => {
        participants.forEach((uid, i) => {
          insMember.run(trackedTicketIds.archived[i % trackedTicketIds.archived.length], uid, base, trackedUserId);
        });
        if (trackedTicketIds.open.length) {
          insStaff.run(trackedTicketIds.open[0], participants[participants.length - 1] || staff[0], 1, base, staff[0]);
        }
      });
      tx2();
    }
  }

  // ----------------------------------------------------------- admin_audit
  // Strictly increasing created_at (base + i) and strictly increasing ids ⇒
  // (created_at DESC, id DESC) ordering is total and reproducible; origins
  // cycle web/slash/system so the viewer's origin filter has >1 row of each;
  // the action names embed origin + zero-padded index so an HTML page can be
  // verified row-by-row by the gate (audit-id + audit-action cells).
  const auditIds = { web: [], slash: [], system: [] };
  {
    const ins = db.prepare(
      `INSERT INTO admin_audit (guild_id, actor_user_id, origin, action,
          target_type, target_id, details_json, created_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      const origins = ["web", "slash", "system"];
      for (let i = 1; i <= scale.audit; i++) {
        const origin = origins[i % 3];
        const action = `gate.${origin}-${String(i).padStart(5, "0")}`;
        const info = ins.run(
          guildId,
          staff[i % staff.length],
          origin,
          action,
          userIds[i % userIds.length],
          JSON.stringify({ i, note: "bulk audit row" }),
          base + i // strictly increasing ⇒ deterministic viewer order
        );
        auditIds[origin].push(Number(info.lastInsertRowid));
      }
      // tracked-user trail rows (audit viewer filters by nothing here — the
      // trail is guild-wide; these keep any actor-targeted look realistic)
      for (let j = 1; j <= 6; j++) {
        ins.run(guildId, staff[0], origins[j % 3], `gate.tracked-${String(j).padStart(5, "0")}`,
          trackedUserId, JSON.stringify({ j }), base + scale.audit + j);
      }
      // Guild-B audit rows: the gate's negative control — these must NEVER
      // render on guild A's audit viewer (cross-guild leak probe).
      for (let b = 1; b <= 200; b++) {
        ins.run(
          "200000000000000002",
          staff[0],
          origins[b % 3],
          `b-hidden-${String(b).padStart(5, "0")}`,
          "9000000000000000999",
          JSON.stringify({ b }),
          base + b
        );
      }
    });
    tx();
  }

  // ---------------------------------------------- user_channel_message_daily
  // ≥10k "message" day-rows spread across users/channels/days; the tracked
  // user gets a dense footprint (Activity tab ranking work at scale). The
  // upsert mirrors incrementDaily so PK conflicts accumulate, never throw.
  {
    const ins = db.prepare(
      `INSERT INTO user_channel_message_daily (guild_id, user_id, channel_id, day, count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, channel_id, day) DO UPDATE SET count = count + excluded.count`
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < scale.dailyRows; i++) {
        const uid = userIds[(i * 7919) % userIds.length]; // prime-stride spread
        const channel = `9600000000000000${String(i % 40).padStart(2, "0")}`;
        const day = dayKey(base - (i % 90) * DAY_MS);
        ins.run(guildId, uid, channel, day, 1 + Math.floor(rng() * 9));
      }
      // dense tracked footprint: 60 days × 20 channels = 1200 distinct rows
      for (let d = 0; d < 60; d++) {
        const day = dayKey(base - d * DAY_MS);
        for (let c = 0; c < 20; c++) {
          ins.run(guildId, trackedUserId, `9600000000000000${String(c).padStart(2, "0")}`, day, 1 + ((d + c) % 9));
        }
      }
    });
    tx();
  }

  // ------------------------------------------------------------ activity_log
  {
    const ins = db.prepare(
      `INSERT INTO activity_log (guild_id, user_id, kind, amount, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const kinds = ["message", "reaction", "voice_minute"];
    const tx = db.transaction(() => {
      for (let i = 0; i < scale.activityLog; i++) {
        ins.run(
          guildId,
          allTracked[(i * 104_729) % allTracked.length],
          kinds[i % 3],
          1 + (i % 4),
          base + i * 3_000
        );
      }
    });
    tx();
  }

  // --------------------------------------------------------- voice_sessions
  {
    const ins = db.prepare(
      `INSERT INTO voice_sessions (guild_id, user_id, channel_id, joined_at)
       VALUES (?, ?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < scale.voiceSessions; i++) {
        ins.run(guildId, userIds[i], `9700000000000000${String(i % 7).padStart(2, "0")}`, base - i * 60_000);
      }
    });
    tx();
  }

  // ------------------------------------------------- activity ignore + meta
  {
    const ign = db.prepare(
      `INSERT INTO activity_ignore (guild_id, target_id, kind, created_at)
       VALUES (?, ?, ?, ?)`
    );
    const meta = db.prepare(
      `INSERT INTO user_activity_meta (guild_id, user_id, tracking_since_ms,
          backfill_status, backfill_channels_done, backfill_channels_total)
       VALUES (?, ?, ?, 'done', 20, 20)`
    );
    const gs = db.prepare(
      `INSERT INTO guild_activity_settings (guild_id, collect_from_ms, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO NOTHING`
    );
    const gsb = db.prepare(
      `UPDATE guild_activity_settings
       SET guild_backfill_status='done', guild_backfill_channels_done=?, guild_backfill_channels_total=?
       WHERE guild_id=?`
    );
    const tx = db.transaction(() => {
      ign.run(guildId, "9800000000000000001", "channel", base);
      ign.run(guildId, "9800000000000000002", "channel", base);
      ign.run(guildId, "9800000000000000003", "category", base);
      meta.run(guildId, trackedUserId, base - 200 * DAY_MS);
      gs.run(guildId, base - 400 * DAY_MS, base);
      gsb.run(20, 20, guildId);
    });
    tx();
  }

  // ------------------------------------------------- integrations seed rows
  // Small, real-shaped config rows so the integrations page exercises its
  // per-cluster reads (including the per-panel option COUNT loop) at scale.
  {
    const yt = db.prepare(
      `INSERT INTO youtube_channels (guild_id, id, channel_name, channel_url,
          thumbnail_url, last_video_id, last_checked, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    );
    const tw = db.prepare(
      `INSERT INTO twitch_channels (guild_id, broadcaster_id, login, display_name,
          profile_image_url, is_live, last_stream_id, last_checked, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 0, NULL, NULL, ?, ?)`
    );
    const rrPanel = db.prepare(
      `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, title,
          description, created_at, updated_at)
       VALUES (?, ?, ?, 'Reaction Roles', 'bulk fixture panel', ?, ?)`
    );
    const rrOption = db.prepare(
      `INSERT INTO reaction_role_options (guild_id, message_id, emoji_key, emoji_display,
          role_id, min_level, removable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)`
    );
    const erCfg = db.prepare(
      `INSERT INTO event_reminder_configs (guild_id, scheduled_event_id, shortname,
          role_id, channel_id, message_template, active, created_at, created_by)
       VALUES (?, ?, ?, ?, '9900000000000000001', 'starting soon', ?, ?, ?)`
    );
    const erOff = db.prepare(
      `INSERT INTO event_reminder_offsets (config_id, offset_minutes, fire_at, sent_at, message_id)
       VALUES (?, ?, ?, NULL, NULL)`
    );
    const hpCh = db.prepare(
      `INSERT INTO honeypot_channels (guild_id, channel_id, warning_message_id, created_at)
       VALUES (?, ?, NULL, ?)`
    );
    const hpBan = db.prepare(
      `INSERT INTO honeypot_ban_roles (guild_id, role_id, created_at) VALUES (?, ?, ?)`
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < 4; i++) {
        yt.run(guildId, `UCytbulk${i}`, `yt-channel-${i}`, `https://youtube.com/@bulk${i}`, base, base);
      }
      for (let i = 0; i < 3; i++) {
        tw.run(guildId, `twb${i}`, `bulkstreamer${i}`, `BulkStreamer${i}`, base, base);
      }
      for (let p = 0; p < 3; p++) {
        const msgId = `99${p}00000000000000000`;
        rrPanel.run(guildId, `991000000000000000${p}`, msgId, base, base);
        for (let o = 0; o < 3; o++) {
          rrOption.run(guildId, msgId, `e${o}`, `:emoji${o}:`, `9300000000000000${o}${p}`, base, base);
        }
      }
      for (let c = 0; c < 2; c++) {
        const info = erCfg.run(
          guildId,
          `evt-bulk-${c}`,
          `er${c}`,
          `93000000000000001${c}`,
          c === 0 ? 1 : 0,
          base,
          staff[0]
        );
        const cfgId = Number(info.lastInsertRowid);
        for (let m = 0; m < 3; m++) {
          erOff.run(cfgId, 30 + m * 30, base + (m + 1) * 60 * 60_000);
        }
      }
      for (let h = 0; h < 2; h++) hpCh.run(guildId, `992000000000000000${h}`, base);
      hpBan.run(guildId, "930000000000000099", base);
    });
    tx();
  }

  const countOf = (sql, ...args) => Number(db.prepare(sql).get(...args)?.c || 0);
  const counts = {
    users: countOf(`SELECT COUNT(*) AS c FROM users WHERE guild_id=?`, guildId),
    warnings: countOf(`SELECT COUNT(*) AS c FROM warnings WHERE guild_id=?`, guildId),
    notes: countOf(`SELECT COUNT(*) AS c FROM staff_notes WHERE guild_id=?`, guildId),
    ticketsArchived: countOf(
      `SELECT COUNT(*) AS c FROM tickets WHERE guild_id=? AND archived=1 AND transcript_token IS NOT NULL`,
      guildId
    ),
    ticketsOpen: countOf(`SELECT COUNT(*) AS c FROM tickets WHERE guild_id=? AND status='open'`, guildId),
    audit: countOf(`SELECT COUNT(*) AS c FROM admin_audit WHERE guild_id=?`, guildId),
    dailyRows: countOf(`SELECT COUNT(*) AS c FROM user_channel_message_daily WHERE guild_id=?`, guildId),
    activityLog: countOf(`SELECT COUNT(*) AS c FROM activity_log WHERE guild_id=?`, guildId),
    voiceSessions: countOf(`SELECT COUNT(*) AS c FROM voice_sessions WHERE guild_id=?`, guildId),
  };

  return { scale, userIds, trackedTicketIds, auditIds, counts, base };
}

module.exports = {
  DAY_MS,
  DEFAULT_SCALE,
  createRng,
  detUuid,
  dayKey,
  seed10k,
};
