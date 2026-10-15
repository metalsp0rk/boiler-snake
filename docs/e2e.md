# End-to-End Tests (Tier 4)

Beyond the unit suite (`test/*.test.js`) and the offline integration suite
(`test/integration/*.test.js` — mocked Discord objects, real SQLite), the E2E
suite boots the **real bot** — real gateway handshake, real `Client`, real
router, real SQLite — against a **local mock Discord** ([fauxcord]) that
speaks the REST + gateway protocol. Nothing talks to Discord; the suite is
safe to run from CI and dev machines with no network access to `discord.com`.

```
┌────────────┐   ws (HELLO/IDENTIFY/READY)   ┌──────────────────────┐
│ real bot    │ ───────────────────────────▶ │ fauxcord mock server  │
│ (src/, real │   REST /api/* (register,     │ pinned commit +       │
│ discord.js) │   replies, message reads)    │ scripts/e2e/          │
└────────────┘ ◀──────────────────────────── │ fauxcord-e2e.patch    │
      ▲        INTERACTION_CREATE /          └──────────────────────┘
      └────────── MESSAGE_CREATE dispatch    POST /_test/interactions
                                             (slash + button clicks)
```

## Running locally

```bash
scripts/e2e/start-mock.sh        # clone pinned fauxcord + apply patch + start :3100
npm run test:e2e                 # 4 suites, one namespace (bot/guild/ids) each
scripts/e2e/stop-mock.sh         # stop the mock
```

`start-mock.sh` is idempotent (reuses a healthy mock; `FRESH=1` forces a
restart). A healthy mock is only reused when it was booted from the same
patch, pin, and installer version (marker file in the data dir) — a stale
mock from a parallel checkout or shared CI volume can never mask a patch
change; the mismatch restarts the mock automatically. Overrides: `PORT`,
`FAUXCORD_DIR`, `FAUXCORD_DATA_DIR`, `FAUXCORD_URL`, `FAUXCORD_PIN`.

## What the suite covers

| Suite | Namespace | Covers |
|---|---|---|
| `test/e2e/e2e-core.test.js` | 1 | gateway handshake + GUILD_CREATE hydration, command registration through the real `register.js`, `/xp` (+ USER-option resolution), `/leaderboard` empty state, injected `MESSAGE_CREATE` → XP pipeline → cooldown |
| `test/e2e/e2e-buttons.test.js` | 2 | the **button round-trip**: staff-gated `/userinfo` panel with persisted components → simulated button click → handler → persisted message edit; senior/junior/unprivileged staff tiers |
| `test/e2e/e2e-gates.test.js` | 3 | command-channel allow-list (deny outside / allow inside), the admin/staff tier split (`/grantxp` denies a `staff_roles`-only member), and the ManageGuild-positive arc (grant a role carrying the bit → `/grantxp` succeeds + DB write; drop the bit → denial again) |
| `test/e2e/e2e-warnings.test.js` | 4 | `/warn` sub-commands: nested USER-option resolution, staff gate on `add`/`list`, public `mine`, DB-side effects |
| `test/e2e/e2e-xp.test.js` | 5 | `/setxp` persist + validation copies, `/grantxp` slash-origin audit rows (before/after/reason), `/xp` non-member zero-state, message-XP **cooldown expiry** re-award (window shortened via `/setxp`) |
| `test/e2e/e2e-settings.test.js` | 6 | `/setcommandchannel` add/list/remove via CHANNEL-option resolution + gate flips, gate-before-permission ordering, admin lockout exemption, `/settings` staff view, `/staff syncpermissions` dark config, register PUT fidelity (tier `defaultMemberPermissions` on the mock) |
| `test/e2e/e2e-staffroles.test.js` | 7 | `/staff role add/list/setlevel/remove` via ROLE-option resolution, `@everyone` guard, admin-only denials, and seniority TRANSITIONS: the same senior-only `/userinfo` Activity click flips junior-denial → served on `/staff role setlevel`, back to denial on remove |
| `test/e2e/e2e-tickets-config.test.js` | 8 | `/ticket settings` (public) + staff-gated `setcategory/setarchive/setratelimit` persistence & audits, panel create→list→edit→delete round-trip (deferred editReply, embed+`tk:open` persisted, embed edited in place, message deleted) |
| `test/e2e/e2e-tickets-member.test.js` | 9 | member ticket open: modal display+submit → channel/row/notice/overwrites (creator bits, junior-role NOT auto-granted, @everyone deny), default 60-min self-create rate limit + disable, direct create-with-reason path, `parent_id` under the configured category, deleted-category error copy, and the `/ticket` channel-gate exception inside open ticket channels |
| `test/e2e/e2e-tickets-staff.test.js` | 10 | staff lifecycle: `/ticket for` (auto-claim, rate-limit bypass), claim/transfer (rows + notices + audits), addstaff/removestaff (every repo branch + overwrite sets), `sensitive` owner-gate with the senior-role deny-flip (+unsensitive), close (row transition, creator lock-out, notice embed, staff-note option + `tk:sn`→`tk:snm` modal button), summarize (stats fallback), archive (transcript rows/flags + archive-channel embed + channel delete) and the SENSITIVE archive stub path, open-vs-closed archive gate, external channel-delete hook, empty `/ticket list` — confirmation replies on archive are pinned by side effects only (issue #341) |
| `test/e2e/e2e-mockgaps.test.js` | 23 | patch proofs for the interaction gaps: note-**modal** display/submit/validation round-trip, **autocomplete** choices over seeded rows, **human reaction** injection → reaction XP + cooldown + remove, **deferred editReply** + persisted panel components (ticket panel), and **ticket-channel overwrite fidelity** (creation-time set + PATCH replace via `/ticket adduser`) |

Each file gets its own **namespace** (`test/e2e/helpers/mockenv.js` →
`namespaceIds(ns)`): unique bot token, app id, guild, channels, and users, so
files are independent even though they share the mock's SQLite database.
Re-provisioning cascades (deleting a bot setup removes its guild, channels,
messages, commands, and interactions).

## The mock: fauxcord + vendored patch

The suite pins fauxcord to one commit (`FAUXCORD_PIN` in
`scripts/e2e/start-mock.sh`) and applies `scripts/e2e/fauxcord-e2e.patch`, a
patch series without which the bot's handlers crash or silently no-op:

- **Payload fidelity** — `entitlements`, `attachment_size_limit`,
  `authorizing_integration_owners`, nested `channel` on interactions
  (discord.js v14 hard-requires these; real Discord always sends them).
- **Components persistence** — messages store/serve `components` (real
  Discord does); without it every button panel vanishes.
- **Type-7 `UPDATE_MESSAGE`** — `interaction.update()` edits the attached
  message instead of silently marking the interaction responded.
- **Component simulation** — `POST /_test/interactions` accepts
  `type: 3` + `custom_id` + `message_id` so button clicks can be simulated.
- **`data.resolved`** — entity-typed options — USER, CHANNEL (type 7), ROLE
  (type 8), including nested sub-command options — resolve into
  `resolved.users`/`members`/`channels`/`roles` the way real Discord fills
  them, so `interaction.options.getUser()/getChannel()/getRole()` work
  (`/setcommandchannel`, `/staff role …` and every other entity-option
  command depend on it).
- **Member `permissions`** — member objects (including the interaction-
  embedded `member`) aggregate the assigned roles' permission bitfields
  into a decimal string, so `interaction.memberPermissions` reflects real
  role bits and ManageGuild-positive paths are testable (#311).
- **Modal simulation** — `POST /_test/interactions` accepts `type: 5` +
  `custom_id` + a `fields` map; the mock builds real Discord's
  `data.components` (TEXT_INPUT rows) so `interaction.fields.getTextInputValue()`
  reads the submitted values (#328, gap 1).
- **Autocomplete simulation + stored callbacks** — `type: 4` INTERACTION_CREATE
  with a focused option drives `interaction.options.getFocused()`; the bot's
  choices response is handled and persisted. Every callback payload (modal
  display = type 9, autocomplete = type 8, …) is stored on the interaction
  row and read back via `GET /_test/interactions/:id` (#328, gap 2).
- **Human reaction injection** — `POST`/`DELETE /_test/reactions` persists a
  reaction from an arbitrary user and dispatches `MESSAGE_REACTION_ADD`/
  `_REMOVE`, so the reaction pipeline (XP, reaction roles, honeypot) runs
  end-to-end (the REST `@me` routes only ever react as the bot) (#328, gap 3).
- **Deferred replies behave like real Discord** — a type-5 defer creates the
  placeholder message (id = interaction id, flags honored), and the webhook
  message routes resolve the URL-encoded `@original` literal (`%40original`,
  which hono cannot match as a static segment). Without both halves, every
  `deferReply → editReply` flow (ticket create/panel/close …) lost its final
  reply to a 10008 in the mock. Read those replies with
  `env.mock.awaitSettledReply(inter)` (waits past the blank placeholder).
- **Permission-overwrite fidelity** — `POST /guilds/:id/channels` persists
  creation-time `permission_overwrites`, and a channel `PATCH` carrying
  `permission_overwrites` REPLACES the stored set (discord.js
  `permissionOverwrites.set()` semantics). Ticket channels (open, adduser,
  sensitive, close) are now auditable through `GET /channels/:id`.
- **`channel.send` persists components** — plain REST message creation keeps
  button rows (only interaction-callback replies used to), so panel messages
  round-trip with their `tk:open` buttons intact.

Still open in the patch series (issue #328): **voice states** (gap 6 — needs
upstream design) and **DMs / guild-less interactions** (gap 7 — pairs with a
router decision). Dependent feature rows stay `it.todo` citing the gap.

The patch is intended to be upstreamed; until then CI and local runs apply
it on the pinned base. fauxcord is pnpm-based upstream (committed
`pnpm-lock.yaml`), so `start-mock.sh` provisions the mock with
`npx pnpm@$PNPM_VERSION install --frozen-lockfile` against that lockfile —
the mock never sees upstream dependency drift. (npm was dropped entirely:
re-resolving fauxcord's dev tree from the registry crashes npm 10.9.9's
arborist, npm/cli#7672.)

When bumping `FAUXCORD_PIN`, regenerate the patch against the new base,
align `PNPM_VERSION` in `start-mock.sh` with the pin's `packageManager`
line if it moved, and rerun the suite:

```bash
cd <clone at new pin>
git apply <repo>/scripts/e2e/fauxcord-e2e.patch   # re-derive as needed
git diff > <repo>/scripts/e2e/fauxcord-e2e.patch
```

## Mock quirks worth knowing

- **Ephemerals are visible to the mock's `@original` reads for any caller.**
  Real Discord returns them only to the invoker — assertions written against
  the mock must keep working under that assumption (read your own replies
  via the interaction token, never a second bot's view).
- `GET /_test/messages/:channelId` is a **simplified tape** (no
  components/flags). For fidelity use `MockEnv#message()`
  (`GET /api/channels/:cid/messages/:mid`).
- Guild membership bootstraps via injected messages (`provision()` does
  this) — the mock embeds `member` on interactions only when a member row
  exists.
- Member objects carry role ids **and** an aggregated `permissions`
  string (OR of the member's roles' bitfields, computed live): create a
  role with the bit and grant it to exercise ManageGuild-positive paths
  (see the `/grantxp` grant→revoke arc in `e2e-gates`).
- The READY payload embeds an `unavailable` guild stub; the channel cache
  only fills when GUILD_CREATE lands (the harness waits for it).

## CI

`.github/workflows/e2e.yml` runs the suite on every PR and `main` push:
`start-mock.sh` (clone pinned commit → apply patch → locked `pnpm install` →
health-check) then `npm run test:e2e`, uploading the mock log as an artifact
on failure.

## Adding scenarios

1. Pick a free namespace number (grep for `ns:` in `test/e2e/`).
2. `createE2eEnv({ ns })` in a `before()` hook, `env.cleanup()` in
   `after()` — it health-checks the mock (with a start-mock hint on miss),
   provisions, sets production env (`DISCORD_API_BASE` seam), boots via
   `src/platform/boot`, and registers commands.
3. Drive interactions through `env.mock.slash()` / `click()` / `modal()` /
   `autocomplete()` / `react()` and assert with `awaitReply()` /
   `message()` plus `env.dbmod` / `env.communityId` for DB-side effects.
   `env.mock.interactionState(id)` reads a stored callback payload (modal
   display, autocomplete choices) for responses that create no message.
4. Suites that mutate shared guild state must use
   `describe(..., { concurrency: 1 }, ...)`.

See [Architecture](/architecture) for the boot sequence the harness reuses.

[fauxcord]: https://github.com/tomacheese/fauxcord
