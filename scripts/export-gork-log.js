#!/usr/bin/env node
/**
 * CLI: export Gork interaction-log rows as replay fixtures.
 *
 * Every Gork agent call is captured in `gork_interactions` (migration 027):
 * the exact prompts, params, tools, settings/context/roster snapshots, the
 * full wire transcript, and the shipped answer. This command turns stored
 * rows into portable JSON fixtures (locked shape `v:1`) so a recorded
 * interaction can be REPLAYED against the pipeline by
 * `test/helpers/replay.js` — the E2E regression net for prompt/context-build
 * changes (session 2026-09-13-gork-interaction-log, spec §7).
 *
 * Usage:
 *   node scripts/export-gork-log.js --guild <id> [--kind qa|memory_turn|all]
 *       [--limit N] [--out <dir>]
 *   node scripts/export-gork-log.js --uid <uid> [--out <dir>]
 *
 * Flags:
 *   --uid <uid>     export ONE interaction by its uid handle (overrides
 *                   --guild/--kind/--limit; missing row → specific error;
 *                   on a qa row the memory_turn companions pointing at it
 *                   are fetched and folded into the fixture)
 *   --guild <id>    list the guild's rows (newest first) and export each
 *   --kind <kind>   qa (default) | memory_turn | all — filter for --guild;
 *                   only `all` fetches both kinds at once, so chain folding
 *                   (qa row + its memory_turn companions) happens there;
 *                   `memory_turn` listings export rows standalone (the qa
 *                   parent is NOT fetched)
 *   --limit <N>     max rows per guild listing (default 20)
 *   --out <dir>     output directory (default .tmp/gork-fixtures/)
 *   --help          usage (exit 0; unknown flags exit 1)
 *
 * One file per fixture: <out>/<uid>.json (the uid is filename-sanitized).
 * Chain truth: `--kind all` listings fold each qa row together with the
 * memory_turn companions found in the SAME fetched set; `--uid` on a qa row
 * fetches that row's companions directly (memory.turns + memory.memoryTurns).
 * A `--kind memory_turn` listing (or `--uid` on a memory_turn row) exports
 * that row standalone — the qa parent is never fetched.
 * JSON columns are parsed when valid; a parse failure NEVER crashes the
 * export — the raw string is preserved and reported per file.
 *
 * Exit codes: 0 success (incl. "no rows" — a clear message, not an error),
 * 1 DB unavailable / unexpected failure, 2 bad arguments.
 */
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const DEFAULT_OUT = path.join(".tmp", "gork-fixtures");
const DEFAULT_LIMIT = 20;
const KINDS = ["qa", "memory_turn", "all"];

const USAGE = [
  "Usage: node scripts/export-gork-log.js [flags]",
  "",
  "  --uid <uid>        export one interaction by uid",
  "  --guild <id>       export a guild's recent interactions",
  `  --kind <kind>      ${KINDS.join(" | ")} (default: qa; with --guild)`,
  `  --limit <N>        max rows per guild listing (default: ${DEFAULT_LIMIT})`,
  `  --out <dir>        output directory (default: ${DEFAULT_OUT})`,
  "  --help             show this help",
].join("\n");

function parseArgs(argv) {
  const opts = { uid: null, guild: null, kind: "qa", limit: DEFAULT_LIMIT, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    const take = () => {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for ${arg} (see --help)`);
      }
      return value;
    };
    if (arg === "--uid") opts.uid = take();
    else if (arg === "--guild") opts.guild = take();
    else if (arg === "--kind") opts.kind = take();
    else if (arg === "--limit") opts.limit = Number(take());
    else if (arg === "--out") opts.out = take();
    else throw new Error(`unknown flag: ${arg} (see --help)`);
  }
  if (opts.help) return opts; // --help needs no selector
  // --kind is validated in EVERY mode (a bogus value in --uid mode is a
  // caller typo just as much as in --guild mode — fail fast, exit 2).
  if (!KINDS.includes(opts.kind)) {
    throw new Error(`--kind must be one of: ${KINDS.join(", ")}`);
  }
  if (opts.uid) return opts; // single-row export wins over the listing filters
  if (!opts.guild) throw new Error("one of --uid or --guild is required (see --help)");
  if (!Number.isFinite(opts.limit) || opts.limit < 1) {
    throw new Error(`--limit must be a positive integer, got: ${opts.limit}`);
  }
  return opts;
}

/** JSON column → parsed value, raw string on failure (NEVER throws). */
function parseJsonColumn(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // broken column kept verbatim; export never crashes on it
  }
}

const asJsonArray = (value) => (Array.isArray(value) ? value : []);
const asJsonObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

/**
 * Response events store `data` = the raw provider body; the replay helper
 * serves it back verbatim. Fall back to the summary fields for rows written
 * before the response payload was captured.
 */
function providerBody(event) {
  if (event && event.data && typeof event.data === "object") return event.data;
  const message = {
    role: "assistant",
    content: event && event.content != null ? event.content : null,
  };
  return {
    choices: [
      {
        index: 0,
        message,
        finish_reason: (event && event.finishReason) || "stop",
      },
    ],
    usage: asJsonObject(event && event.usage),
  };
}

/** Transcript events of one row (parsed); [] when absent/unparseable. */
function transcriptEvents(row) {
  const transcript = parseJsonColumn(row.transcript);
  return asJsonArray(asJsonObject(transcript).events);
}

/**
 * Build the v1 replay fixture for one full `gork_interactions` row
 * (getGorkInteractionByUid shape). Exported so tests (and the replay
 * recorder) reuse the EXACT on-disk contract without spawning this script.
 *
 * @param {object} row full row
 * @param {{ chainRows?: object[], chainTurns?: object[] }} [opts] `chainRows`
 *   = rows of a memory_turn chain (root first), assembled by the CLI via
 *   parent_uid; `chainTurns` = children of THIS row (list assemblies where
 *   the qa trigger row carries the memory_turn companions).
 * @returns {object} v1 fixture
 */
function buildFixture(row, opts = {}) {
  const { chainRows, chainTurns } = opts;
  const settings = parseJsonColumn(row.settings);
  const params = parseJsonColumn(row.params);
  const tools = parseJsonColumn(row.tools);
  const contextMessages = parseJsonColumn(row.context_messages);
  const rosterEntries = parseJsonColumn(row.roster_entries);

  const transcript = transcriptEvents(row);
  const responseEvents = transcript.filter((e) => e && e.type === "response");

  // Companion rows: an explicit chronological chain (CLI) or, for list
  // assemblies where children point AT this row, every child row found.
  const chainRowsAll = asJsonArray(chainRows).length
    ? asJsonArray(chainRows)
    : asJsonArray(chainTurns).filter(
        (r) => r && String(r.parent_uid ?? "") === String(row.uid),
      );
  // v1 chain convention: the qa trigger row carries the chain companions.
  const chain =
    row.kind === "memory_turn"
      ? [row, ...chainRowsAll.filter((r) => r && r.uid !== row.uid)]
      : [row, ...chainRowsAll.filter((r) => r && r.uid !== row.uid)];

  // memory.turns feeds the conversation-mode history (chronological):
  // the chain ROOT (turn 1) is the last row in a newest-first listing, so
  // callers pass the chain root first. The qa trigger row is the chain
  // END — appended after its companions (children never lead their parent).
  const turns = [];
  if (chain.length) {
    // Chronological seed: every DISTINCT message in the chain contributes
    // one turn line — chain rows are passed root-first (oldest), and the
    // qa trigger row leads its own chain. A memory_turn companion recorded
    // for the trigger message adds no second line.
    const seenTurnIds = new Set();
    for (const r of chain) {
      const content = r.trigger_content;
      if (typeof content !== "string" || !content.trim()) continue;
      const messageId = String(r.message_id);
      if (seenTurnIds.has(messageId)) continue;
      seenTurnIds.add(messageId);
      turns.push({
        messageId: r.message_id,
        userId: r.user_id,
        content,
        replyToMessageId: r.reply_to_message_id ?? null,
      });
    }
  } else if (typeof row.trigger_content === "string" && row.trigger_content.trim()) {
    // solo fixture: the trigger turn itself, so a memory fixture derived
    // from a qa row still carries its conversation seed.
    turns.push({
      messageId: row.message_id,
      userId: row.user_id,
      content: row.trigger_content,
      replyToMessageId: row.reply_to_message_id ?? null,
    });
  }

  // Recorded companion rows for chain members (chronological, root first).
  const memoryTurns = chain
    .filter((r) => r.kind === "memory_turn")
    .map((r) => {
      const events = transcriptEvents(r);
      return {
        uid: r.uid,
        parentUid: r.parent_uid ?? null,
        status: r.status,
        model: r.model ?? null,
        answerRaw: r.answer_raw ?? null,
        usage: parseJsonColumn(r.usage),
        transcript: {
          request: (events.find((e) => e && e.type === "request") || {}).payload ?? null,
          responses: events.filter((e) => e && e.type === "response").map(providerBody),
        },
      };
    });

  return {
    v: 1,
    uid: row.uid,
    kind: row.kind,
    generatedAt: new Date().toISOString(),
    _note:
      "Replay fixture v1. All ids are synthetic; the file contains no " +
      "secrets. Re-record with scripts/export-gork-log.js after intentional " +
      "prompt-shape changes.",
    trigger: {
      guildId: String(row.guild_id),
      channelId: String(row.channel_id),
      messageId: String(row.message_id),
      userId: String(row.user_id),
      content: row.trigger_content ?? "",
      replyToMessageId: row.reply_to_message_id ?? null,
    },
    settings: asJsonObject(settings),
    contextMessages: asJsonArray(contextMessages),
    rosterEntries: asJsonArray(rosterEntries),
    memory: {
      enabled: Number(asJsonObject(settings).gork_memory_enabled ?? 0) === 1,
      meta: parseJsonColumn(row.memory_meta),
      // conversation-mode seed: recorded turns, oldest first (the replay
      // driver feeds them through the pipeline BEFORE the trigger turn)
      turns,
      // every chain member captured as a memory_turn (chronological)
      memoryTurns,
    },
    expect: {
      model: row.model ?? null,
      systemPrompt: row.system_prompt ?? null,
      userPrompt: row.user_prompt ?? null,
      tools: Array.isArray(tools) ? tools : null,
      params: asJsonObject(params),
      status: row.status,
      shippedAnswer: row.answer_shipped ?? null,
      finishReason: row.finish_reason ?? null,
      usage: parseJsonColumn(row.usage),
      toolCallCount: Number(row.tool_call_count) || 0,
      error: row.error ?? null,
      transcript,
    },
    parsedFailures: [
      ["settings", settings],
      ["params", params],
      ["tools", tools],
      ["contextMessages", contextMessages],
      ["rosterEntries", rosterEntries],
      ["memory.meta", parseJsonColumn(row.memory_meta)],
      ["usage", parseJsonColumn(row.usage)],
      ["transcript", parseJsonColumn(row.transcript)],
    ]
      .filter(([, value]) => typeof value === "string")
      .map(([name]) => name),
  };
}

/**
 * Group listed FULL rows into fixtures. qa rows export one-per-row;
 * memory_turn rows are aggregated per parent_uid chain (chain assembled
 * root-first) when the fetched set covers the chain — otherwise the row
 * exports standalone with the turns/memory blocks it can prove.
 *
 * @param {object[]} rows full rows (any order)
 * @returns {object[]} fixtures
 */
function buildFixturesFromRows(rows) {
  const byUid = new Map();
  for (const row of rows || []) {
    if (row && row.uid) byUid.set(row.uid, row);
  }
  // v1 chain convention: the qa trigger row carries the memory_turn
  // companions (children point at it via parent_uid).
  const childrenOf = new Map();
  for (const r of rows || []) {
    if (r && r.parent_uid) {
      if (!childrenOf.has(r.parent_uid)) childrenOf.set(r.parent_uid, []);
      childrenOf.get(r.parent_uid).push(r);
    }
  }
  const fixtures = [];
  const visited = new Set();
  for (const row of rows || []) {
    if (!row || visited.has(row.uid)) continue;
    const kids = childrenOf.get(row.uid) || [];
    visited.add(row.uid);
    if (row.kind !== "memory_turn" || !kids.length) {
      // qa/summary roots carry their children; a lone memory_turn exports
      // standalone.
      fixtures.push(buildFixture(row, { chainTurns: kids }));
      continue;
    }
    // Walk UP the chain to the root (legacy parent-links-to-root shape).
    const upChain = [row];
    const seen = new Set([row.uid]);
    let cur = row;
    while (cur.parent_uid && byUid.has(cur.parent_uid) && !seen.has(cur.parent_uid)) {
      cur = byUid.get(cur.parent_uid);
      upChain.push(cur);
      seen.add(cur.uid);
    }
    const root = upChain[upChain.length - 1];
    if (root.kind !== "memory_turn" || visited.has(root.uid)) {
      // Not a memory root (parent outside the fetched set) or already
      // emitted as part of another chain — export this row standalone.
      visited.add(row.uid);
      fixtures.push(buildFixture(row));
      continue;
    }
    // Walk DOWN from the root to assemble the whole chain (root first).
    const chain = [root];
    visited.add(root.uid);
    let node = root;
    while ((childrenOf.get(node.uid) || []).some((k) => !visited.has(k.uid))) {
      node = childrenOf.get(node.uid).find((k) => !visited.has(k.uid));
      chain.push(node);
      visited.add(node.uid);
    }
    fixtures.push(buildFixture(node, { chainRows: chain }));
  }
  return fixtures;
}

/**
 * Direct children (memory_turn rows whose parent_uid is this row's uid),
 * oldest first — the chain companions a trigger row carries.
 *
 * @param {object} db open db facade
 * @param {object} row parent row
 * @returns {object[]}
 */
function findChainTurns(db, row) {
  if (!row || !row.uid) return [];
  try {
    const listed = db.listGorkInteractions({
      guildId: row.guild_id,
      kind: "memory_turn",
      limit: 200,
    });
    // listGorkInteractions returns SUMMARY rows WITHOUT parent_uid — the
    // full row must be hydrated FIRST, or the chain filter is always false.
    return listed
      .map((r) => db.getGorkInteractionByUid(r.uid))
      .filter(Boolean)
      .filter((r) => String(r.parent_uid ?? "") === String(row.uid))
      .sort((a, b) => Number(a.created_at) - Number(b.created_at));
  } catch {
    return []; // best-effort: a missing companion never fails the export
  }
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[export-gork-log] ${err?.message || err}`);
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  let db;
  try {
    // DB_PATH / DATA_DIR come from the environment (same rules as the bot).
    db = require("../src/db");
  } catch (err) {
    console.error(
      "[export-gork-log] failed to open the database — set DB_PATH (or DATA_DIR) " +
        "to the bot's SQLite file:",
      err?.message || err,
    );
    return 1;
  }

  try {
    if (opts.uid) {
      const row = db.getGorkInteractionByUid(opts.uid);
      if (!row) {
        console.error(
          `[export-gork-log] no gork_interaction with uid "${opts.uid}" in ` +
            `${db.dbPath || "the open database"} — list ids with --guild <id> --kind all`,
        );
        return 1;
      }
      return writeFixtures(
        [buildFixture(row, { chainTurns: findChainTurns(db, row) })],
        opts.out,
      );
    }

    const kind = opts.kind === "all" ? undefined : opts.kind;
    const listed = db.listGorkInteractions({
      guildId: opts.guild,
      kind,
      limit: opts.limit,
    });
    if (!listed.length) {
      const kindLabel = opts.kind === "all" ? "any kind" : `kind "${opts.kind}"`;
      console.log(
        `[export-gork-log] no ${kindLabel} rows stored for guild ${opts.guild} ` +
          `(nothing to export — logging off, empty guild, or rows pruned by retention).`,
      );
      return 0;
    }
    // Fetch FULL rows (listGorkInteractions returns summaries only).
    const full = listed
      .map((row) => db.getGorkInteractionByUid(row.uid))
      .filter(Boolean);
    return writeFixtures(buildFixturesFromRows(full), opts.out);
  } catch (err) {
    console.error(`[export-gork-log] export failed: ${err?.message || err}`);
    return 1;
  }
}

function writeFixtures(fixtures, outDir) {
  let written = 0;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const fixture of fixtures) {
      // uid comes from the DB (UUIDs in practice) — never let a row's uid
      // escape the output directory through path separators or "..".
      const safeUid = String(fixture.uid).replace(/[^A-Za-z0-9._-]/g, "_");
      const file = path.join(outDir, `${safeUid}.json`);
      fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
      written += 1;
      const note = fixture.parsedFailures.length
        ? ` (raw strings kept for: ${fixture.parsedFailures.join(", ")})`
        : "";
      console.log(`wrote ${file}${note}`);
    }
  } catch (err) {
    console.error(
      `[export-gork-log] failed writing into ${outDir}: ${err?.message || err}`,
    );
    return 1;
  }
  console.log(
    `[export-gork-log] ${written} fixture(s) → ${path.resolve(outDir)}`,
  );
  return 0;
}

module.exports = { buildFixture, buildFixturesFromRows, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
