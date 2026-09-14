# Gork Interaction Logging

Every Gork question/answer is captured **end to end** into the SQLite
[`gork_interactions`](database.md#gork-interactions) table: the exact system
and user prompts sent to the model, sampling params, tool schemas, the guild
settings snapshot, the collected conversation context, the people roster, the
memory block metadata, the full per-round wire transcript (including tool
calls and their outputs), the raw answer, and the answer actually shipped to
Discord. The purpose is reproducibility: a stored interaction can be
**exported as a JSON fixture** and **replayed** against the pipeline in tests,
so prompt/context-build regressions are caught as failing E2E tests rather
than vibes.

Data lives in the bot's own database. Use `/gork log off` for a guild or the
`GORK_INTERACTION_LOG=0` env kill-switch to stop capture entirely.

## What is captured

One row per **agent call** (rows are NOT written for triggers that never
reached the model — cooldown hits, queue bounces, budget rejections, or
keyword misses produce no rows; there is no request to record).

| Column group | Contents |
|---|---|
| Identity | `uid` (UUID handle), `kind` (`qa` or `memory_turn`), `parent_uid` (memory turn → its qa row), guild/channel/message/user ids |
| Outcome | `status` (`shipped`, `partial`, `failure`, `error`), `answer_raw`, `answer_shipped`, `finish_reason`, `usage`, `error`, `duration_ms` |
| Request | `model`, `params` (camelCase keys exactly as sent: `temperature`, `maxTokens`, `timeoutMs`, `maxToolRounds`, `thinkingTokenBudget` — NOT the wire snake_case names), `tools` (exact schemas sent), `system_prompt`, `user_prompt` (byte-exact composed content), `trigger_content` (raw trigger message), `reply_to_message_id` |
| Inputs snapshot | `settings` (guild settings at call time), `context_meta`/`context_messages` (what was collected, as collected), `roster_meta`/`roster_block`/`roster_entries` (people involved, replayable), `memory_meta` |
| Transcript | `transcript`: ordered `{events, truncated}` of `request` / `response` / `tool` events per round and attempt — the actual wire bodies |

A `memory_turn` companion row (written when gork memory is enabled) records
the extraction call with the same structure, linked via `parent_uid`. Its
`status` reflects the extraction honestly: `shipped` only when the extraction
LLM call produced at least one **successful** response (even if zero memories
were stored — the counts ride in `params` as camelCase `stored` /
`skippedInvalid`); `failure` when no successful LLM response came back (HTTP
error, timeout, unparseable turn), with the specific cause in `error`. qa
rows use `partial` when the tool-round cap was hit but real content still
shipped, `failure` for the canned LLM-failure reply, and `error` when the
job itself crashed mid-flight.

## Knobs

| Knob | Default | Effect |
|---|---|---|
| `/gork log on\|off` | on | per-guild switch (`gork_interaction_log_enabled`) |
| `GORK_INTERACTION_LOG` | unset | `0` = process-wide kill-switch (beats the guild setting; nothing is captured, answers unaffected) |
| `GORK_INTERACTION_LOG_RETENTION_DAYS` | `30` | rows older than this are pruned lazily on every insert; `0` keeps rows forever |
| `GORK_INTERACTION_LOG_MAX_JSON_CHARS` | `200000` | transcript JSON budget per row; oldest events are dropped (with `truncated: true`) to stay under it |

`/gork status` shows the current on/off state and the stored row count.

## Exporting fixtures

`scripts/export-gork-log.js` turns stored rows into replay fixtures
(portable JSON, shape `v:1`):

```bash
# recent qa rows of one guild → .tmp/gork-fixtures/<uid>.json
node scripts/export-gork-log.js --guild 123456789012345678 --limit 5

# one specific interaction
node scripts/export-gork-log.js --uid 3f2b9a0c-0000-4000-8000-a1b2c3d4e5f6

# every kind, another output dir (qa rows fold in the memory_turn
# companions that share the fetched set)
node scripts/export-gork-log.js --guild 123456789012345678 --kind all --out fixtures/
```

| Flag | Meaning |
|---|---|
| `--uid <uid>` | export one interaction by its uid (overrides the listing flags); on a **qa** row the memory_turn companions whose `parent_uid` matches are fetched and folded into the fixture (`memory.turns` + `memory.memoryTurns`) |
| `--guild <id>` | list the guild's rows newest-first and export each |
| `--kind qa\|memory_turn\|all` | listing filter (default `qa`; bogus values exit `2` in every mode). Chain folding (qa row + its memory_turn companions) only happens with `all`, where both kinds are fetched together; a `memory_turn` listing exports each row **standalone** — the qa parent is never fetched |
| `--limit <N>` | max rows per guild listing (default 20) |
| `--out <dir>` | output directory (default `.tmp/gork-fixtures/`) |

`DB_PATH` / `DATA_DIR` select the database (same rules as the bot; read from
the environment / `.env`). Exit codes: `0` success (a clear "no rows" message
is success), `1` database problems, `2` bad arguments.

### Fixture shape (v1)

```json
{
  "v": 1,
  "uid": "3f2b9a0c-0000-4000-8000-a1b2c3d4e5f6",
  "kind": "qa",
  "trigger": { "guildId": "...", "channelId": "...", "messageId": "...",
               "userId": "...", "content": "gork: why is the sky blue?",
               "replyToMessageId": null },
  "settings": { "gork_keyword": "gork", "gork_cooldown_sec": 0, "...": "..." },
  "contextMessages": [ { "id": "...", "authorId": "...", "content": "...", "timestamp": 0 } ],
  "rosterEntries": [ { "id": "...", "display": "...", "handle": "...", "nickname": null } ],
  "memory": { "enabled": false, "meta": null, "turns": [], "memoryTurns": [] },
  "expect": { "model": "gpt-4o-mini", "systemPrompt": "...", "userPrompt": "...",
              "tools": null, "params": {}, "status": "shipped",
              "shippedAnswer": "...", "transcript": [ "...events..." ] }
}
```

All ids in committed fixtures are synthetic; fixtures never contain the bot
token or API keys (only the model's prompts/answers as captured).

## Replay workflow (E2E regression testing)

`test/helpers/replay.js` feeds a fixture back through the FULL pipeline
(settings → channel history → trigger message → scripted provider answers)
with the interaction log ON, then asserts the NEW row the replay wrote:

- `system_prompt` / `user_prompt` byte-equal to `expect` — **this is the
  regression alarm**: any change to prompt assembly, context building, roster
  formatting, or settings defaults changes the bytes and fails the test;
- the visible reply equals `expect.shippedAnswer`;
- status/tool-round counts match.

The golden fixture + its replay test live at
`test/fixtures/gork-replay/single-round-prior-context.json` and
`test/integration/gork-replay.test.js` (plus a memory-enabled golden in
`single-round-prior-context-memory.json` /
`test/integration/gork-memory-replay.test.js`). The test file first RECORDS a
fresh fixture and compares it byte-for-byte against the checked-in file: if
you change prompt building on purpose, the drift test tells you — re-record
with `FIXTURE_UPDATE=1 node --test test/integration/gork-replay.test.js`
(and review the diff). A MISSING golden file is a hard failure: the tests
never silently re-seed it (without `FIXTURE_UPDATE=1` that would quietly
re-arm the regression net around whatever the current code emits).

Replaying a fixture against a live-ish env is also the fastest way to
reproduce a real-world prompt bug: export the row with `--uid`, then drive
`replayInteraction(env, fixture)` from a scratch test — the scripted
provider turns come from the row's own recorded transcript, so the model side
needs no network.

**v1 limitations:** multi-turn `memory.turns` conversation seeds and
`memory.memoryTurns` companion rows are exported but not replayed yet;
network-tool rounds (web_search/read_page) replay against graceful empty
bodies, so only round counts are asserted for tool-loop fixtures.
