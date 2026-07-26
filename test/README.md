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

### Adding a case

1. Prefer `createIntegrationEnv()` then `runCommand()` or `emitMessage()` / pipeline helpers.
2. Use unique user/guild IDs when in-memory cooldowns or honeypot ban sets could collide.
3. Mock only Discord side effects; assert on SQLite + captured `interaction.replies` / channel `sent` arrays.
4. Do not call `client.login` or feature `start()` timers in tests — invoke ticks (`runVoiceTick`, `runDecayForGuild`, `processChannel`) explicitly.

### Production test seams

- `src/bot/pipelines.js` — `onMessageCreate`, `onMessageReactionAdd`, `onMessageReactionRemove`
- `src/features/voice` — `runVoiceTick`
- `src/features/youtube/ticker.js` — `processChannel` / `runYoutubeTick` accept optional network deps
