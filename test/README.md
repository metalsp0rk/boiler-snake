# Tests

## Unit tests (`test/*.test.js`)

Pure logic and small seams: XP math, cooldowns, command registry, DB migrations/API smoke.

```bash
npm run test:unit
```

## Integration tests (`test/integration/*.test.js`)

In-process full-stack validation:

- **Real:** SQLite (temp file), migrations, repositories, feature handlers, command router, message/reaction pipelines, jobs (voice, decay, YouTube with stubs)
- **Mocked:** Discord gateway, REST, interactions, members, channels

No `DISCORD_TOKEN` or network required.

```bash
npm run test:integration
# or everything:
npm test
```

### Harness

| Helper | Role |
|--------|------|
| `helpers/env.js` | Temp `DB_PATH` + clear `src/` require cache |
| `helpers/discord.js` | Plain-object Discord fakes |
| `helpers/harness.js` | `createIntegrationEnv()` — DB + registry + mock guild graph |
| `helpers/assert.js` | Reply / XP / ban / role assertions |
| `helpers/fixtures.js` | Stable default IDs (`IDS`), `ADMIN_PERMS`, `uniqueId()` for isolation |
| `helpers/lavalink.js` | In-memory Lavalink manager/player fake (`createFakeLavalinkManager`, `makeTrack`) injected via music's `setManagerForTests` |

### Adding a case

1. Prefer `createIntegrationEnv()` then `runCommand()` or `emitMessage()` / pipeline helpers.
2. Use unique user/guild IDs when in-memory cooldowns or honeypot ban sets could collide.
3. Mock only Discord side effects; assert on SQLite + captured `interaction.replies` / channel `sent` arrays.
4. Do not call `client.login` or feature `start()` timers in tests — invoke ticks (`runVoiceTick`, `runDecayForGuild`, `processChannel`) explicitly. Named jobs live in `src/core/scheduler.js`; unit-test the scheduler with `createScheduler({ setTimeoutFn, … })` rather than real clocks.
5. Never mix real-clock CONFIG with forced/injected EXECUTION clocks: if a test forces `nowMs` into a tick, every clock-derived setup value (hour_utc, weekday, day boundary…) MUST derive from that same forced instant — `test/e2e/helpers/time.js#forcedHourFor` (#382 failed only at UTC 20:00–23:59: schedule luck, not determinism; `test/test-determinism-scan.test.js` pins the rule).
6. A test file may not bind the ambient default `DB_PATH` at ANY point — `connection.js` opens (and migrates) `DB_PATH` at **require time**, so concurrent `node --test` files sharing an ambient path race mid-migration and the loser sees `database is locked` / `no such column` in an unrelated assertion (the #470 G2-6 gork flake class; #620 corrupted the shared dev sqlite this way). Three tiers, all pinned by `test/db-binding-discipline.test.js`:
   - **Containment + order** — a file whose load-time graph reaches `src/db` must *call* `loadDb()` (or use `createIntegrationEnv()` / `createE2eEnv()`) **before its first db-bound column-0 require**; a binder token buried in a late `before()` does not pass.
   - **Lazy reach** — a binder-less file may not lazy-`require` anything whose load graph reaches `src/db` (a require in a test body binds sqlite at CALL time); audited migration sandboxes may keep their own `process.env.DB_PATH =` mechanism instead.
   - **Collection time** — `describe()` callbacks execute at COLLECTION time, before every hook, so requires nested inside a `describe` are load-time regardless of indentation. No static rule sees this; the CI canary does (`test.yml` blocks the default path with a directory for the suite's duration — one ambient open fails CI loudly with the culprit's require stack).

### Production test seams

- `src/bot/pipelines.js` — `onMessageCreate`, `onMessageReactionAdd`, `onMessageReactionRemove`
- `src/features/voice` — `runVoiceTick`
- `src/features/youtube/ticker.js` — `processChannel` / `runYoutubeTick` accept optional network deps
- `src/features/music` — `setManagerForTests` injects an in-memory Lavalink fake (`helpers/lavalink.js`); do not run a real node in CI
