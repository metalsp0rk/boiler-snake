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
6. A test file may not LOAD `src/db`-bound code before binding its OWN temp DB: call `loadDb()` / `createIntegrationEnv()` / `createE2eEnv()` **before the first `src/**` require** — `connection.js` opens (and migrates) `DB_PATH` at REQUIRE time, so two concurrent `node --test` files sharing an ambient `DB_PATH` race mid-migration and the loser sees `database is locked` / `no such column` in an unrelated assertion (the #470 G2-6 gork flake class; `test/db-binding-discipline.test.js` pins the corpus — a file either uses a sanctioned binder or its load-time graph never resolves `src/db`).

### Production test seams

- `src/bot/pipelines.js` — `onMessageCreate`, `onMessageReactionAdd`, `onMessageReactionRemove`
- `src/features/voice` — `runVoiceTick`
- `src/features/youtube/ticker.js` — `processChannel` / `runYoutubeTick` accept optional network deps
- `src/features/music` — `setManagerForTests` injects an in-memory Lavalink fake (`helpers/lavalink.js`); do not run a real node in CI
