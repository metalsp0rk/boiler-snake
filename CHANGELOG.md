# Changelog

## [1.12.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.11.1...v1.12.0) (2026-09-11)


### Features

* **github:** per-guild GitHub release notifications (hourly ticker) ([725c4a2](https://github.com/metalsp0rk/boiler-snake/commit/725c4a22a9d450d5b516f1d4e870c09cf906a6b7))
* **gork:** channel-aware answers (roadmap 7.18, locked decisions 38-41) ([6938084](https://github.com/metalsp0rk/boiler-snake/commit/6938084135cceab93e3d7ab831de08e0ae7ac8da))

## [1.11.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.11.0...v1.11.1) (2026-09-10)


### Bug Fixes

* **ci:** build docs on node 22 to match engines floor ([c745af5](https://github.com/metalsp0rk/boiler-snake/commit/c745af502a9571f8f2a2b8a56f0c3af1df9bde47))
* **docs:** add missing 016-019 and 021-024 rows to architecture.md migration table ([98fe1c9](https://github.com/metalsp0rk/boiler-snake/commit/98fe1c9a9dc3e06221bf56d0ca4bdd345a3c074e))
* **docs:** align gork LLM token budget and timeout docs with shipped defaults ([600cab1](https://github.com/metalsp0rk/boiler-snake/commit/600cab169d49d878fe52627fb34cf2ae41d3a9cf))
* **docs:** bump docs project-information version stamp to 1.11.0 ([a52e96c](https://github.com/metalsp0rk/boiler-snake/commit/a52e96c7cb5417243101cacd5cfaaae0b03f3646))
* **docs:** correct leaderboard constraint wording to paginated 1-20 rows ([26b7d74](https://github.com/metalsp0rk/boiler-snake/commit/26b7d74a3e1a404672ebe5cf2ba9a81ec9181081))
* **docs:** correct warnings post-MVP migration id from 017 to 018_warn_post_mvp ([d9920fe](https://github.com/metalsp0rk/boiler-snake/commit/d9920fe538dbb6908db49f7761ddfb39fed83821))
* **docs:** disambiguate duplicate Testing headings in architecture.md anchor space ([43704b4](https://github.com/metalsp0rk/boiler-snake/commit/43704b425516f5502c49eaccaae638f7ed676f1a))
* **docs:** document gork tables and settings columns in database.md ([33e3d8f](https://github.com/metalsp0rk/boiler-snake/commit/33e3d8fe5885af80d205cff83d973ce7b9d4645b))
* **docs:** document shipped /gork commands in commands index and permission matrix ([f99e2a1](https://github.com/metalsp0rk/boiler-snake/commit/f99e2a162aa90fa12158328ba8584110430fef0b))
* **docs:** drop dead Advanced Configuration TOC entry in configuration.md ([a5c3be7](https://github.com/metalsp0rk/boiler-snake/commit/a5c3be78cb8771514db9c6118dc623c7e15ca7c6))
* **docs:** drop unverifiable video claim from setup blurb ([6768aa0](https://github.com/metalsp0rk/boiler-snake/commit/6768aa079c968e90ebea4bec674dc32568e9a796))
* **docs:** enable VitePress lastUpdated so pages carry update stamps ([e9b3c50](https://github.com/metalsp0rk/boiler-snake/commit/e9b3c50ce2aa73dc5940692ab9a06b43b4f70d99))
* **docs:** list commandPermissions, twitch, and gork in AGENTS.md features ([7e9e8e3](https://github.com/metalsp0rk/boiler-snake/commit/7e9e8e3a5d18b38a0d70918b40214b7739be3ee5))
* **docs:** regenerate database.md migration table against shipped migrations ([7c5dd20](https://github.com/metalsp0rk/boiler-snake/commit/7c5dd20565390a9599304c568d3b5e9324f293de))
* **docs:** replace phantom /warn issue subcommand with /warn add ([d94e338](https://github.com/metalsp0rk/boiler-snake/commit/d94e338bac12394e4e76a30db1a459265b5b856b))
* **docs:** sync README command listings with shipped setxp, staff, and warn commands ([21fbacc](https://github.com/metalsp0rk/boiler-snake/commit/21fbacca85afb5c2f6352c215778b5b214b80b40))
* **env:** correct YOUTUBE_API_KEY comment now that notifications shipped ([2ae1409](https://github.com/metalsp0rk/boiler-snake/commit/2ae140965066fa388fccb9970b0b8cc260f0893d))
* **license:** add MIT license file backing the declared MIT licensing ([9976e76](https://github.com/metalsp0rk/boiler-snake/commit/9976e76c238193dc9973bd5e6fdcace9d1d42401))
* reconcile feature/command counts, warnings open items, and 018 migration log id ([d4a2740](https://github.com/metalsp0rk/boiler-snake/commit/d4a2740b8d5a6f793f5fa1e21b14d14cc85be78f))
* **roadmap:** align event-reminders paths and schema draft with shipped modules ([072e960](https://github.com/metalsp0rk/boiler-snake/commit/072e96033fefdcbc010de7731c1e81df91f847a7))
* **roadmap:** close two shipped ticket fixes in help-tickets and index ([1393fb3](https://github.com/metalsp0rk/boiler-snake/commit/1393fb338358a9d599ac70073828cc1efc534f5e))
* **roadmap:** decompose web-admin phases into estimated checkbox task breakdown ([4cbdf6d](https://github.com/metalsp0rk/boiler-snake/commit/4cbdf6dd6c89059f19e2b262fe68b81bbd727884))
* **roadmap:** document shipped staff-roles tiers, provenance, and OAuth visibility ([c793949](https://github.com/metalsp0rk/boiler-snake/commit/c793949064ceda227344428c72ed4ec4fba4cd2a))
* **roadmap:** index all shipped features and add 013/014/019 summary rows ([a070dc4](https://github.com/metalsp0rk/boiler-snake/commit/a070dc462607f13520accbb07b9320186281dc19))
* **roadmap:** make feature files single source for open items, index mirrors link ([16f3f90](https://github.com/metalsp0rk/boiler-snake/commit/16f3f90720801b69d63eb84ec2c6ff13369ed684))
* **roadmap:** match warnings status wording verbatim in index row ([ae91e13](https://github.com/metalsp0rk/boiler-snake/commit/ae91e13320caa43a839136d8f0b905246d4f0a9c))
* **roadmap:** prune shipped twitch polling-interval and embed open items ([f0ffcbe](https://github.com/metalsp0rk/boiler-snake/commit/f0ffcbe957ca96d21d8449ae79e1ce61a9dd2386))
* **roadmap:** reconcile help-tickets core sections with shipped ticket behavior ([9fd29ba](https://github.com/metalsp0rk/boiler-snake/commit/9fd29ba1c34d06302764a4e4050fed32f02c28fd))
* **roadmap:** record shipped guild-wide note list and modal cap ([12e8728](https://github.com/metalsp0rk/boiler-snake/commit/12e8728f6b4fa42d94c61e7670e81ed487b78cb8))
* **roadmap:** renumber planned web-admin migrations to 025/026 with reserve rule ([b78c9a0](https://github.com/metalsp0rk/boiler-snake/commit/b78c9a0acb81c7f4d5c305c6444be51f4b4bb99a))
* **roadmap:** sync warnings roadmap drafts with shipped export, expiry, and evidence ([aad7c08](https://github.com/metalsp0rk/boiler-snake/commit/aad7c0803cbc755836f52cd85c8dc47aefaa9021))
* **tests:** add boundary-exhaustive truth-table coverage for requireStaff tiers ([43268b1](https://github.com/metalsp0rk/boiler-snake/commit/43268b14b200016dd6a948c0c8a80f8fb89d96b2))
* **tests:** add test:coverage script with baseline-locked thresholds ([fa42d5e](https://github.com/metalsp0rk/boiler-snake/commit/fa42d5e813c39e883ee4716530f40cb7f4f83e8f))
* **tests:** close DB handles and remove temp dirs via integration harness cleanup ([f9d7048](https://github.com/metalsp0rk/boiler-snake/commit/f9d704832be52d94525e149604b0aded30a50732))
* **tests:** cover auditLog misconfig branches and music render builders ([80a9391](https://github.com/metalsp0rk/boiler-snake/commit/80a939122371efeb9afee1bae234874ef376df81))
* **tests:** cover OAuth token exchange and public callback handler paths ([3ab924b](https://github.com/metalsp0rk/boiler-snake/commit/3ab924b283017db6f9fe49b2623ae112eb2137ba))
* **tests:** cover src/config.js env parsing and required-var gating ([84ff4b0](https://github.com/metalsp0rk/boiler-snake/commit/84ff4b04992b23a7e85f720c54fe3ead3f2f8183))
* **tests:** list fixtures and lavalink helpers in test README ([cbd43f3](https://github.com/metalsp0rk/boiler-snake/commit/cbd43f3cf501d2139f5143b6f3a7b8253dd6991e))
* **tests:** rename camelCase unit-test files to kebab-case convention ([2eeee8c](https://github.com/metalsp0rk/boiler-snake/commit/2eeee8c1fe3cd5a0dcf2f406e3faa9ad6396d244))
* **tests:** replace wall-clock sleeps with settle seams in gork and user-activity suites ([ca1670c](https://github.com/metalsp0rk/boiler-snake/commit/ca1670c806bb3d9357dd6fe8a96f94d934d97a2d))
* **tests:** require cache-absence and recorded removal in assertRoleRemoved ([a8f4f88](https://github.com/metalsp0rk/boiler-snake/commit/a8f4f88913851218dc4813d6fbadc00219b2dc96))
* **tests:** route unit-test DB bootstrap through shared loadDb helper with cleanup ([6f4ca71](https://github.com/metalsp0rk/boiler-snake/commit/6f4ca7109e7795afceb77a0a602f7b097a1cb526))

## [1.11.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.10.0...v1.11.0) (2026-09-09)


### Features

* **staff-roles:** track added_by and test role-change audit embeds ([74684b2](https://github.com/metalsp0rk/boiler-snake/commit/74684b2695ab5cb450592dd8ce76e7d97f3142b2))
* **tickets:** DM requester the transcript link on archive (non-sensitive, best-effort) ([35901c2](https://github.com/metalsp0rk/boiler-snake/commit/35901c21d2eff9dedd5df2f66a386229ebeb7d3c))


### Bug Fixes

* surface specific error causes and isolate feature boot hooks ([dec6375](https://github.com/metalsp0rk/boiler-snake/commit/dec6375bb45984ff5cb09405d50183e7b2ee977d))
* **tickets:** only report staff roles actually denied channel access, with per-role reasons ([019f777](https://github.com/metalsp0rk/boiler-snake/commit/019f7779b2de74caf0b2dbac31042a5829814574))
* **twitch:** surface fetch error causes in Helix request logs ([e50b4dc](https://github.com/metalsp0rk/boiler-snake/commit/e50b4dc6ac3983dd929caa9eff0465cc1ef70a28))

## [1.10.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.9.0...v1.10.0) (2026-09-09)


### Features

* **gork:** community memory — per-person memories with post-send extraction (§7.16) ([e8f2e1c](https://github.com/metalsp0rk/boiler-snake/commit/e8f2e1cb271ee30bf24af87563f98c9ecfe7a73b))

## [1.9.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.8.0...v1.9.0) (2026-09-08)


### Features

* **gork:** thinking-token budget cap, visible-answer cap, provider diagnostics ([aa79898](https://github.com/metalsp0rk/boiler-snake/commit/aa79898a5d8614d3dc935f609ec387f90eeef0bd))

## [1.8.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.7.2...v1.8.0) (2026-09-08)


### Features

* **gork:** react with clock emoji on per-user cooldown hit ([3316031](https://github.com/metalsp0rk/boiler-snake/commit/33160313247a402923bcc4eb4323a226548cb7fc))


### Bug Fixes

* **gork:** LLM error handling — thinking-model empty answers, timeouts, opaque failures ([0d79be6](https://github.com/metalsp0rk/boiler-snake/commit/0d79be6e35ab4c8a716e03248f07f24f81e1d0bb))

## [1.7.2](https://github.com/metalsp0rk/boiler-snake/compare/v1.7.1...v1.7.2) (2026-09-08)


### Bug Fixes

* **gork:** §7.15 reported-issue fixes ([8d863f6](https://github.com/metalsp0rk/boiler-snake/commit/8d863f6e22c47dd0169a60de0b29e8db498a19e5))

## [1.7.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.7.0...v1.7.1) (2026-09-08)


### Bug Fixes

* **ci:** publish GHCR image from release workflow; isolate visibility tests' DB ([e5ffdbb](https://github.com/metalsp0rk/boiler-snake/commit/e5ffdbbd8298da46a31c751cb8849045e5c7fca8))
* **event-reminders:** keep create/edit modal within Discord's 5-component limit ([12a0d10](https://github.com/metalsp0rk/boiler-snake/commit/12a0d10e0586f131a5e089507764ed2f4f12d434))

## [1.7.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.6.0...v1.7.0) (2026-09-07)


### Features

* **gork:** AI keyword Q&A with context, web search, and per-guild queue ([1c4e4d9](https://github.com/metalsp0rk/boiler-snake/commit/1c4e4d9b70dd8c217bfa5a17b6d2af7f6384bb68))
* **gork:** read_page tool — browse search results with clean LLM-ready extraction ([57ab6c9](https://github.com/metalsp0rk/boiler-snake/commit/57ab6c9142d1297d47dc53e7769eec900b10adfc))
* **gork:** rename /setgork to /gork, add user bans and guild enable switch ([e007458](https://github.com/metalsp0rk/boiler-snake/commit/e00745880147fe22e0ffdaa38effa332e76a7416))


### Bug Fixes

* **ci:** raise Node floor to 22.22.2+ (jsdom 30 requirement) ([884e97c](https://github.com/metalsp0rk/boiler-snake/commit/884e97c568ed689cdce7a397f062321dbe40d805))

## [1.6.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.5.0...v1.6.0) (2026-09-03)


### Features

* **music:** add Lavalink player with Spotify catalog ([9e90d0f](https://github.com/metalsp0rk/boiler-snake/commit/9e90d0f8aac51cf68b9d0b98359ae27d7cef73b2))
* **tickets:** add /ticket summarize for on-demand AI summaries ([1b38786](https://github.com/metalsp0rk/boiler-snake/commit/1b38786a4fece9087f339cee8ea58f4b3e0ed642))
* **twitch:** multi-channel go-live notifications via Helix polling ([7c5d7d0](https://github.com/metalsp0rk/boiler-snake/commit/7c5d7d03986ebfc8ad643c95b77729f8a7eca6aa))
* **xp:** paginate /leaderboard with limit and prev/next buttons ([2110fd1](https://github.com/metalsp0rk/boiler-snake/commit/2110fd1d8186ea1643cbd5d2d00c493a66a51300))

## [1.5.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.4.0...v1.5.0) (2026-09-02)


### Features

* **eventReminders:** mute, always-embed delivery, shortname suggest ([344977d](https://github.com/metalsp0rk/boiler-snake/commit/344977d6dcfda1aaec12043eebd95e4185c56ad7))
* **expose level_xp_factor on /setxp:** add `factor` option ([37c4115](https://github.com/metalsp0rk/boiler-snake/commit/37c41159a32b42b1866e3c5d7a364fbca20ff1db))
* **permissions:** staff-gate tools and OAuth slash visibility sync ([6d9939b](https://github.com/metalsp0rk/boiler-snake/commit/6d9939b730acf9043e01efbbe75629cc7d133c14))
* stored ticket panel registry with list/edit/delete ([1493a55](https://github.com/metalsp0rk/boiler-snake/commit/1493a5552da52bd86441f222f3f5eb9eaa76d346))
* **warnings:** expiry, staff export, and evidence fields ([15dba90](https://github.com/metalsp0rk/boiler-snake/commit/15dba906d13b9ed938dbb14c216e46b980f43372))
* **xp:** add admin-only /grantxp command ([4cb888a](https://github.com/metalsp0rk/boiler-snake/commit/4cb888a479817f41bef28d7d0b83904b33237e5d))


### Bug Fixes

* persistent flag for event reminders to skip auto-cleanup ([52ca907](https://github.com/metalsp0rk/boiler-snake/commit/52ca907b331aaaf6e2332230dcbeea292eda64de))
* **userActivity:** window-aware posts/week and 90d option ([cbff383](https://github.com/metalsp0rk/boiler-snake/commit/cbff383d6916d4a73208ffb556d2c79c76936bf3))

## [1.4.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.3.0...v1.4.0) (2026-08-06)


### Features

* **staffNotes:** content modals and ticket-close note attach ([5233b90](https://github.com/metalsp0rk/boiler-snake/commit/5233b90bd32f4c391d3514dc8aee1b243c81370e))
* **staffNotes:** content modals and ticket-close note attach ([e60ed73](https://github.com/metalsp0rk/boiler-snake/commit/e60ed73917947b032d00379bcd8920a081e69099))
* **userActivity:** configurable max_pages and backfill cancel ([3505a1f](https://github.com/metalsp0rk/boiler-snake/commit/3505a1f6965f51ff931d9f19af1d59be53aca4b5))
* **userActivity:** guild-wide single-pass history backfill ([fdca80b](https://github.com/metalsp0rk/boiler-snake/commit/fdca80ba7ab0f62b4da1489f7a42a76649769a33))
* **userActivity:** guild-wide single-pass history backfill ([becdf07](https://github.com/metalsp0rk/boiler-snake/commit/becdf0728d037abe610e503c410f67766fc8f1d5))
* **userActivity:** staff channel/category activity summary ([e1894a0](https://github.com/metalsp0rk/boiler-snake/commit/e1894a0100599728099569dc2295706743f83800))
* **userActivity:** staff channel/category activity summary ([4e7ce23](https://github.com/metalsp0rk/boiler-snake/commit/4e7ce2333a07dd40d72fa5d418153ca9cfa7c583))

## [1.3.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.2.0...v1.3.0) (2026-08-06)


### Features

* **staffRoles:** junior and senior staff role levels ([fd92eaa](https://github.com/metalsp0rk/boiler-snake/commit/fd92eaaea9a2a0103b9ed70fad160c7fb2606c11))
* **tickets:** panel button opens modal for ticket create ([5684e7f](https://github.com/metalsp0rk/boiler-snake/commit/5684e7fd39b4e490aaefa2b956e3a884022399f5))
* **warnings:** dedicated warn log channel ([bb6b328](https://github.com/metalsp0rk/boiler-snake/commit/bb6b3280a4be3ba9fb0bd2014fd898d96e80f1e5))
* **warnings:** dedicated warn_log_channel_id for issue/void logs ([a17dfc2](https://github.com/metalsp0rk/boiler-snake/commit/a17dfc27c9436364ab454e50468b086d7ff17844))


### Bug Fixes

* **tickets:** auto-claim staff who open tickets for members ([5b51b41](https://github.com/metalsp0rk/boiler-snake/commit/5b51b418e61a09393dcb8472123551b2524cd79a))

## [1.2.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.1.0...v1.2.0) (2026-08-06)


### Features

* **tickets:** add help ticket system MVP ([74ad5d3](https://github.com/metalsp0rk/boiler-snake/commit/74ad5d3234c1b716101a8d9e031a14f2f98d11ac))
* **userinfo:** staff card with note and warning drill-down ([c97de28](https://github.com/metalsp0rk/boiler-snake/commit/c97de2869301f65b18a117b102ab89bdd37681c7))
* **warnings:** add permanent formal warning system ([0981b71](https://github.com/metalsp0rk/boiler-snake/commit/0981b71383f0209ac7e13b73157c8d1ff382ce0c))


### Bug Fixes

* **docs:** use GitHub URL for ROADMAP link in tickets.md ([667cf0a](https://github.com/metalsp0rk/boiler-snake/commit/667cf0aeef35fb398c9ff5f76839ef67a8411dcc))

## [1.1.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.0.0...v1.1.0) (2026-08-05)


### Features

* **eventReminders:** add {location} message placeholder ([c446b2c](https://github.com/metalsp0rk/boiler-snake/commit/c446b2ca482748cb63693897fa300613e6d4afce))
* **eventReminders:** include location in default reminder message ([cacbe13](https://github.com/metalsp0rk/boiler-snake/commit/cacbe1384c7f4672119b5ecfe47e08e8e471e4bd))
* **staffNotes:** add private staff notes (/note) ([c847388](https://github.com/metalsp0rk/boiler-snake/commit/c8473884903bfc3efbe2617a2d91892989bc7200))
* **staffRoles:** guild staff roles power isStaff gate ([65228cc](https://github.com/metalsp0rk/boiler-snake/commit/65228cc22f1bbcc5966a9a42748c4a49bb2f533a))


### Bug Fixes

* **db:** make staff_roles migration idempotent on re-run ([6e706ee](https://github.com/metalsp0rk/boiler-snake/commit/6e706ee65d9d0b901ea1511f2919f394afd3f2fc))
* **docs:** use GitHub URLs for ROADMAP links in staff-notes ([851990a](https://github.com/metalsp0rk/boiler-snake/commit/851990abb589b11566961303e579de8ce54deb8a))

## 1.0.0 (2026-07-31)


### Features

* add Docker packaging and release-please automation ([663c2e5](https://github.com/metalsp0rk/boiler-snake/commit/663c2e5a246254f4684f7dc5c3e757bd1b43f4c4))
* add scheduled event reminders ([986e9c8](https://github.com/metalsp0rk/boiler-snake/commit/986e9c85810342d9d61023967918a2f8bafb758f))
* **honeypot:** add dedicated staff audit embeds for bans ([9461ed7](https://github.com/metalsp0rk/boiler-snake/commit/9461ed70b737c6f5bc580676b5e4c7debb96ab3c))
