# Changelog

## [1.34.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.34.0...v1.34.1) (2026-10-18)


### Bug Fixes

* **e2e:** the multipart flake settles on the ATTACHMENT, not just the message row ([f88a9fa](https://github.com/metalsp0rk/boiler-snake/commit/f88a9fa92a9178e7f21415c9bffea4438ac17b51)), closes [#519](https://github.com/metalsp0rk/boiler-snake/issues/519)

## [1.34.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.33.0...v1.34.0) (2026-10-18)


### Features

* **honeypot:** mass-ban safety valve — cap the fan-out, persist the pause, admin-resume only ([8de4173](https://github.com/metalsp0rk/boiler-snake/commit/8de417308307b39156b0e6a247d16cbadf6ad907)), closes [#440](https://github.com/metalsp0rk/boiler-snake/issues/440)


### Bug Fixes

* **ai:** the tool loop has a CALL budget and the deadline finally owns it ([c072e6f](https://github.com/metalsp0rk/boiler-snake/commit/c072e6f86f48af414501fbf13d6f7f00e9f5168c)), closes [#434](https://github.com/metalsp0rk/boiler-snake/issues/434)
* **boot:** a stuck discord login stops holding a READY endpoint hostage ([fd11a31](https://github.com/metalsp0rk/boiler-snake/commit/fd11a31e11cb793f8626ee331facc81f511215ef)), closes [#392](https://github.com/metalsp0rk/boiler-snake/issues/392)
* **boot:** the terminal discord path opens the gate BEFORE touching the corpse ([804927d](https://github.com/metalsp0rk/boiler-snake/commit/804927d5a5365d72bca126acdceb189cf31f88e9)), closes [#388](https://github.com/metalsp0rk/boiler-snake/issues/388)
* **bridge:** a deleted destination channel BREAKS the bridge — once, honestly, loudly ([483bbdd](https://github.com/metalsp0rk/boiler-snake/commit/483bbdd8797f3510c1ad06e022f9ba81e9ad1f9a)), closes [#413](https://github.com/metalsp0rk/boiler-snake/issues/413)
* **bridge:** a parked row's spool bytes are reclaimed AT the park — the caps stop lying ([9db4569](https://github.com/metalsp0rk/boiler-snake/commit/9db4569d7bf7a9d57e051cb66d18ff86f5d5a514)), closes [#412](https://github.com/metalsp0rk/boiler-snake/issues/412)
* **bridge:** delete-relay drains PRUNE the links + snapshot rows they orphaned ([47b9ec5](https://github.com/metalsp0rk/boiler-snake/commit/47b9ec5b49cb15904073accd17398fdd5bb19334)), closes [#411](https://github.com/metalsp0rk/boiler-snake/issues/411)
* **bridge:** Fluxer's declared 429 wait is no longer parsed and thrown away ([536b12a](https://github.com/metalsp0rk/boiler-snake/commit/536b12a1515fa579acc8f465645b472f4bb0eba5)), closes [#387](https://github.com/metalsp0rk/boiler-snake/issues/387)
* **bridge:** parked rows become VISIBLE and RE-QUEUEABLE — /bridge retry ([f909337](https://github.com/metalsp0rk/boiler-snake/commit/f9093373e8686726e74f25b81b701bb1c81163b5)), closes [#416](https://github.com/metalsp0rk/boiler-snake/issues/416)
* **bridge:** relay embeds finally REACH the wire — §10.8 kept its promise ([82309a5](https://github.com/metalsp0rk/boiler-snake/commit/82309a54158b638c5169058938a0359642cb2b50)), closes [#383](https://github.com/metalsp0rk/boiler-snake/issues/383)
* **bridge:** shrunk edits DELETE the destination's stale tail parts ([b6adf11](https://github.com/metalsp0rk/boiler-snake/commit/b6adf114431ad433f1ca179d94175964c0ec87ff)), closes [#409](https://github.com/metalsp0rk/boiler-snake/issues/409)
* **bridge:** the degraded fallback stops lying about the files it dropped ([c1cee07](https://github.com/metalsp0rk/boiler-snake/commit/c1cee07eb96b809076945411a7aaa49095196d51)), closes [#417](https://github.com/metalsp0rk/boiler-snake/issues/417)
* **bridge:** the delete branch gets the SAME sendCtx the edit branch builds ([20591ff](https://github.com/metalsp0rk/boiler-snake/commit/20591fff67c2f304cd70826418a9847bd78429d9)), closes [#410](https://github.com/metalsp0rk/boiler-snake/issues/410)
* **bridge:** the repo owns the bridge tables again — relay.js does zero SQL ([b5566e1](https://github.com/metalsp0rk/boiler-snake/commit/b5566e15d86b94eabfa29da81a62cb733a74cc6c)), closes [#397](https://github.com/metalsp0rk/boiler-snake/issues/397)
* **bridge:** the takedown's spool wipe only touches bytes NOBODY owns anymore ([4cf6d4a](https://github.com/metalsp0rk/boiler-snake/commit/4cf6d4a0c9b4e95cacafaa1ddc9f9c231513bf4e)), closes [#398](https://github.com/metalsp0rk/boiler-snake/issues/398)
* **ci:** serialize ALL e2e runs behind one fauxcord-e2e concurrency group ([ea245ca](https://github.com/metalsp0rk/boiler-snake/commit/ea245cade182779ef3e76dddc89bb08abfcf2621)), closes [#450](https://github.com/metalsp0rk/boiler-snake/issues/450)
* **config:** remove every youshallnotpass default — the [#205](https://github.com/metalsp0rk/boiler-snake/issues/205) fail-fast must actually fire under compose ([2d8daa3](https://github.com/metalsp0rk/boiler-snake/commit/2d8daa38924a9e6b2e84822652ab8c9884033450)), closes [#455](https://github.com/metalsp0rk/boiler-snake/issues/455)
* **core:** every staff list surface caps itself — never Discord's 400 ([5ee3ec2](https://github.com/metalsp0rk/boiler-snake/commit/5ee3ec21866bd5b0848518f41ef295e2457a3b8c)), closes [#446](https://github.com/metalsp0rk/boiler-snake/issues/446)
* **core:** the download timeout covers the BODY, and size caps stop the STREAM (BRG-8/LT-7) ([dad6173](https://github.com/metalsp0rk/boiler-snake/commit/dad6173ff23cad68c4eaa68bd7e48c7ef73e07f6)), closes [#414](https://github.com/metalsp0rk/boiler-snake/issues/414)
* **core:** the router's failure logs become evidence, not riddles ([18222a4](https://github.com/metalsp0rk/boiler-snake/commit/18222a4c5947689bd4191f69f985da3946efbb80)), closes [#391](https://github.com/metalsp0rk/boiler-snake/issues/391)
* **core:** the SSRF guard connects to the address it just checked — DNS rebinding is closed ([fc2f382](https://github.com/metalsp0rk/boiler-snake/commit/fc2f382664fea203b0baddd0a6932be616f85b9d)), closes [#415](https://github.com/metalsp0rk/boiler-snake/issues/415)
* **db:** every gork answer stops paying for a full scan — day index lands ([381a293](https://github.com/metalsp0rk/boiler-snake/commit/381a2934240e9b9a2bc41bdc6b4ece2c3b562b1d)), closes [#395](https://github.com/metalsp0rk/boiler-snake/issues/395)
* **db:** retention finally sweeps the tables that grew forever — [#399](https://github.com/metalsp0rk/boiler-snake/issues/399) ([af6be9b](https://github.com/metalsp0rk/boiler-snake/commit/af6be9be746b564869fe184014cfcbac58c6d37a))
* **db:** settings reads READ — no more WAL churn or lying timestamps per message ([43d7772](https://github.com/metalsp0rk/boiler-snake/commit/43d77725b7d76dbf2659bb9df09e81963269b52a)), closes [#393](https://github.com/metalsp0rk/boiler-snake/issues/393)
* **db:** the daily-aggregate prune finally rides an INDEX — hourly, on the biggest table ([6163a84](https://github.com/metalsp0rk/boiler-snake/commit/6163a8436727b123ae76c01e962b9f3b7a2426c7)), closes [#396](https://github.com/metalsp0rk/boiler-snake/issues/396)
* **db:** the migration guard finally records WHAT ran, not just how many ([36918b6](https://github.com/metalsp0rk/boiler-snake/commit/36918b63eb05fe141ff2841b3a3ef41e48460687)), closes [#394](https://github.com/metalsp0rk/boiler-snake/issues/394)
* **events:** strike 10060 (UnknownSticker) from the terminal GONE_CODES set ([87fb755](https://github.com/metalsp0rk/boiler-snake/commit/87fb75551c217c3701904facab95e39e4cafedc3)), closes [#432](https://github.com/metalsp0rk/boiler-snake/issues/432)
* **events:** the 24h draft sweep must cover EVERY abandonable, not just previews ([c858b42](https://github.com/metalsp0rk/boiler-snake/commit/c858b42371537e8747d370739868ad450b243260)), closes [#454](https://github.com/metalsp0rk/boiler-snake/issues/454)
* **events:** the option swap is ONE transaction — and its signup guard actually fires ([367149e](https://github.com/metalsp0rk/boiler-snake/commit/367149eb0ac668e853e57455c79e50e99bede5b5)), closes [#400](https://github.com/metalsp0rk/boiler-snake/issues/400)
* **features:** a hook that throws after taking resources LEAVES them — fixed ([92e0d9e](https://github.com/metalsp0rk/boiler-snake/commit/92e0d9ebfd3562ccf42b5007e1291e5d0eaefb14)), closes [#390](https://github.com/metalsp0rk/boiler-snake/issues/390)
* **fluxer:** a community's adapter finally asks WHOSE channel it is ([00cf72d](https://github.com/metalsp0rk/boiler-snake/commit/00cf72da23f6a5679e30283a60087f945ffd5947)), closes [#386](https://github.com/metalsp0rk/boiler-snake/issues/386)
* **fluxer:** a half-finished presigned upload finally admits what it uploaded ([bed0a2e](https://github.com/metalsp0rk/boiler-snake/commit/bed0a2eec16314721f74967c04167962a44fab16)), closes [#384](https://github.com/metalsp0rk/boiler-snake/issues/384)
* **fluxer:** EVERY Fluxer request gets a deadline — wedged instances die loud ([c18f480](https://github.com/metalsp0rk/boiler-snake/commit/c18f48053f4e4c7e9b54ed5c102e4fdd3783339d)), closes [#436](https://github.com/metalsp0rk/boiler-snake/issues/436)
* **fluxer:** the permission fan-out stops paying per message (and the [@everyone](https://github.com/everyone) base was silently 0) ([d42e9ba](https://github.com/metalsp0rk/boiler-snake/commit/d42e9babd103041527214d4b1da1bd902749e3d3)), closes [#385](https://github.com/metalsp0rk/boiler-snake/issues/385)
* **githubReleases:** durable admin_audit row for EVERY mutating slash action ([a406271](https://github.com/metalsp0rk/boiler-snake/commit/a406271ae21f652f3d35c6ea70cd32b3ea896478)), closes [#443](https://github.com/metalsp0rk/boiler-snake/issues/443)
* **githubReleases:** PATs move to a private modal — the public slash option leaked them in-channel ([189a1d9](https://github.com/metalsp0rk/boiler-snake/commit/189a1d9308aef32d07d42138a04d3b7ebaf1f47f)), closes [#444](https://github.com/metalsp0rk/boiler-snake/issues/444)
* **gork:** memory mirror rows live in their own key space — never B's row ([031db10](https://github.com/metalsp0rk/boiler-snake/commit/031db1066d8758341f23c69e497428c1ffc61ac5)), closes [#427](https://github.com/metalsp0rk/boiler-snake/issues/427)
* **gork:** read_page MAX_BYTES becomes a REAL download cap (stream + cancel) ([6f91cd5](https://github.com/metalsp0rk/boiler-snake/commit/6f91cd5814848ebd58916c8f2c9d54e1a7ab8f68)), closes [#435](https://github.com/metalsp0rk/boiler-snake/issues/435)
* **gork:** summarize footer jump links go through core/jumpUrl (no discord.com on Fluxer) ([8338adb](https://github.com/metalsp0rk/boiler-snake/commit/8338adb10d61f7c36af2ae5e332d33c1b505dadd)), closes [#453](https://github.com/metalsp0rk/boiler-snake/issues/453)
* **gork:** the memory-mirror switch finally switches the READ leg too ([96357ae](https://github.com/metalsp0rk/boiler-snake/commit/96357aeb4dc840ce4daab08cf7a342a572e37b71)), closes [#425](https://github.com/metalsp0rk/boiler-snake/issues/425)
* **honeypot:** ban-role config says the truth on Fluxer — dark until events exist ([adb7b90](https://github.com/metalsp0rk/boiler-snake/commit/adb7b907eab0f461ce20bc6c1dc9a53be6118ca5)), closes [#439](https://github.com/metalsp0rk/boiler-snake/issues/439)
* **honeypot:** exempt-add never moves staff LEVEL — no silent junior→senior promotion ([0eb4252](https://github.com/metalsp0rk/boiler-snake/commit/0eb4252db136ca8f917e1b3b8e865799a7a2e95e))
* **levelRoles:** daily grace-drop sweeper — XP-frozen users no longer keep level roles forever ([41bbae1](https://github.com/metalsp0rk/boiler-snake/commit/41bbae1aadd4d89d2daab64cd2f399e9f20fc4a1)), closes [#428](https://github.com/metalsp0rk/boiler-snake/issues/428)
* **linking:** link codes stop being silent, stackable, and unrevocable ([8bd02fe](https://github.com/metalsp0rk/boiler-snake/commit/8bd02fea52084c35ffaf19c0a9687d6c0d65c3f8)), closes [#426](https://github.com/metalsp0rk/boiler-snake/issues/426)
* **logs:** /setlog VERIFIES delivery; log-stream failures name their cause ([dc33e25](https://github.com/metalsp0rk/boiler-snake/commit/dc33e25ce194633de5b91d1ab1eade0779c7cb1b)), closes [#445](https://github.com/metalsp0rk/boiler-snake/issues/445)
* **platform:** one chat message stops costing a write transaction + fsync ([e466640](https://github.com/metalsp0rk/boiler-snake/commit/e466640260d0db391fe8bdbf0f117c49954f2d25)), closes [#389](https://github.com/metalsp0rk/boiler-snake/issues/389)
* **reactionRoles:** cross-panel refcount before stripping a shared role ([a2d29c4](https://github.com/metalsp0rk/boiler-snake/commit/a2d29c4ddac180a64b42a3adfd23dd8999cca3b2)), closes [#433](https://github.com/metalsp0rk/boiler-snake/issues/433)
* **roles:** a failed role op is a REPORTED failure — replies and audit say so ([a1ec025](https://github.com/metalsp0rk/boiler-snake/commit/a1ec0254101feb5cb075c92063d0e7a1fc37f81e)), closes [#430](https://github.com/metalsp0rk/boiler-snake/issues/430)
* **tickets:** a capped or partially-fetched transcript now LOOKS partial ([a40585f](https://github.com/metalsp0rk/boiler-snake/commit/a40585fe914d7be8a112bd98393ea18ceee7c949)), closes [#423](https://github.com/metalsp0rk/boiler-snake/issues/423)
* **tickets:** a failed open-notice is a WARNING, not a fake failed create ([6860281](https://github.com/metalsp0rk/boiler-snake/commit/6860281a683931cea63e885bc52280566f879e35)), closes [#421](https://github.com/metalsp0rk/boiler-snake/issues/421)
* **tickets:** a failed transcript write ABORTS the archive — retryable, channel kept ([ec56eb1](https://github.com/metalsp0rk/boiler-snake/commit/ec56eb1124e027fe2e17593ba681fc4a290b2f9c)), closes [#418](https://github.com/metalsp0rk/boiler-snake/issues/418)
* **tickets:** swallowed overwrite failures surface in the reply — 8 handlers ([12c2487](https://github.com/metalsp0rk/boiler-snake/commit/12c2487f21c9bf3f31dd27c138a910b87968a72d)), closes [#422](https://github.com/metalsp0rk/boiler-snake/issues/422)
* **tickets:** the archive claim is a lease — a throw no longer wedges forever ([d1f4908](https://github.com/metalsp0rk/boiler-snake/commit/d1f4908a2c11770c2b495360e87cf4ec2221e399)), closes [#419](https://github.com/metalsp0rk/boiler-snake/issues/419)
* **tickets:** the create rate limit gets an atomic slot — double-submit opens ONE ([2ac3d9b](https://github.com/metalsp0rk/boiler-snake/commit/2ac3d9ba32ecc720539091827fe862be7aaaa924)), closes [#420](https://github.com/metalsp0rk/boiler-snake/issues/420)
* **tickets:** the transcript tree gets a byte budget and an orphan sweep ([e4f7417](https://github.com/metalsp0rk/boiler-snake/commit/e4f741753f2670ebc84bcea67e1387947e05e63d)), closes [#424](https://github.com/metalsp0rk/boiler-snake/issues/424)
* **twitch:** a failed go-live send no longer BURNS the stream — claim releases and retries ([7ee1628](https://github.com/metalsp0rk/boiler-snake/commit/7ee1628ea77f8226144ffb2047a4cc12eb47cf9b))
* **userActivity:** system lines excluded on BOTH live and backfill — one truth ([6671891](https://github.com/metalsp0rk/boiler-snake/commit/66718918d27746b552f150e2f77ce5ed8c5e12db)), closes [#437](https://github.com/metalsp0rk/boiler-snake/issues/437)
* **userinfo:** Activity drill ships only where buttons dispatch; dead ctx senior helpers deleted ([730cf55](https://github.com/metalsp0rk/boiler-snake/commit/730cf55a2aab54c5361ecadf9ece4b0b705ada2d))
* **web:** "Your sessions" is finally scoped to the platform it claims ([ad7771d](https://github.com/metalsp0rk/boiler-snake/commit/ad7771db5fbf50c90f5e1b077c283b52d2590266)), closes [#404](https://github.com/metalsp0rk/boiler-snake/issues/404)
* **web:** one Fluxer refresh per session per moment — joiners RIDE it, never burn the grant ([fb1a5d7](https://github.com/metalsp0rk/boiler-snake/commit/fb1a5d7e40b204571fbc11d2780522c80129f702)), closes [#402](https://github.com/metalsp0rk/boiler-snake/issues/402)
* **web:** the /oauth callbacks finally get the per-IP limiter their doctrine promised ([be28fc6](https://github.com/metalsp0rk/boiler-snake/commit/be28fc61846cc600d787d21f03fc4a004f42c5b0)), closes [#406](https://github.com/metalsp0rk/boiler-snake/issues/406)
* **web:** the archive index gains its missing People header (7 cells, 7 headers) ([fef3255](https://github.com/metalsp0rk/boiler-snake/commit/fef3255a893405ae65f4b78a43cc85af67cdc861)), closes [#408](https://github.com/metalsp0rk/boiler-snake/issues/408)
* **web:** the per-user login bucket wakes up — identities ADOPTED mid-exchange pay auth_user ([694919e](https://github.com/metalsp0rk/boiler-snake/commit/694919e1e5bb2e05c16f99b601ec9cd399d481fb)), closes [#403](https://github.com/metalsp0rk/boiler-snake/issues/403)
* **web:** the sliding session now SLIDES IN THE BROWSER TOO — touched cookies renew ([275e77a](https://github.com/metalsp0rk/boiler-snake/commit/275e77a3d46a1ebf8ea3959da4be5767b157102a)), closes [#401](https://github.com/metalsp0rk/boiler-snake/issues/401)
* **web:** the system-wide session console finally requires a system-wide key ([b1e5f05](https://github.com/metalsp0rk/boiler-snake/commit/b1e5f05b17deb7a525d3265801704260131d5e32)), closes [#405](https://github.com/metalsp0rk/boiler-snake/issues/405)
* **web:** the voice page's settings link stops minting /g/ urls from the snowflake ([253d41a](https://github.com/metalsp0rk/boiler-snake/commit/253d41a268468b7c2a72544e01ba6c02d94a0b33)), closes [#407](https://github.com/metalsp0rk/boiler-snake/issues/407)
* **xp:** cooldown windows can never exceed the sweep horizon — clamp at 24h ([87ee92b](https://github.com/metalsp0rk/boiler-snake/commit/87ee92b8938905e22035b4d672262b4344dda2ed)), closes [#429](https://github.com/metalsp0rk/boiler-snake/issues/429)
* **xp:** the communityId fallback resolves the message's OWN platform ([dd1ffa1](https://github.com/metalsp0rk/boiler-snake/commit/dd1ffa1ea45ba9d8d8e9c4406289a6f1bef0719f)), closes [#431](https://github.com/metalsp0rk/boiler-snake/issues/431)
* **youtube:** /testnotification failures carry the CAUSE (rule 3) ([e8b65b9](https://github.com/metalsp0rk/boiler-snake/commit/e8b65b93ac243da39ceb407253eb0279813f1ae7)), closes [#456](https://github.com/metalsp0rk/boiler-snake/issues/456)
* **youtube:** removeYoutubeChannel reports the DELETE honestly; both count-diff hacks die ([462222c](https://github.com/metalsp0rk/boiler-snake/commit/462222c7979252c3d8c5330718307c9213eb6352)), closes [#442](https://github.com/metalsp0rk/boiler-snake/issues/442)
* **youtube:** status-check EVERY Google API response — quota death names itself ([8d55b17](https://github.com/metalsp0rk/boiler-snake/commit/8d55b17418f8545ba0d1efb7b27ce2adf06bed70)), closes [#441](https://github.com/metalsp0rk/boiler-snake/issues/441)

## [1.33.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.32.0...v1.33.0) (2026-10-17)


### Features

* **gork:** raise summarize turn timeout to 15m and input budget max to 200k ([ff5716e](https://github.com/metalsp0rk/boiler-snake/commit/ff5716e1875a3a2c7382d6040a3f2b5c71765da6))
* **gork:** split the Q&A audit stream into a dedicated /gork logchannel ([33b9d97](https://github.com/metalsp0rk/boiler-snake/commit/33b9d9738717bdb61cefdb9840d0bbaeaa99e742))

## [1.32.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.31.0...v1.32.0) (2026-10-17)


### Features

* **bridge:** ingest Fluxer MESSAGE_UPDATE/MESSAGE_DELETE and relay edits/deletes to Discord ([3dc7f6a](https://github.com/metalsp0rk/boiler-snake/commit/3dc7f6a7c1c4de96cfab8b90d39c1704efdbd137))
* **decay:** DECAY_CRON env knob with fail-fast validation ([b4cf119](https://github.com/metalsp0rk/boiler-snake/commit/b4cf119df2d93f259b8a8ab656923751037a600e))
* Discord &lt;-&gt; Fluxer account linking with mirrored XP and gork memories ([0fba2e4](https://github.com/metalsp0rk/boiler-snake/commit/0fba2e44de21559be5c9a705fa6ed0fe9a4271bc))
* **e2e:** fauxcord spike — real boot + slash-command/pipeline E2E vs local Discord mock ([edeb10b](https://github.com/metalsp0rk/boiler-snake/commit/edeb10b91a370e972e7499ac6ea237c5b5dac25b))
* **eventReminders:** retire /eventreminder create with pointer to /event (E13, [#225](https://github.com/metalsp0rk/boiler-snake/issues/225)) ([301c0b0](https://github.com/metalsp0rk/boiler-snake/commit/301c0b0ff7b43164ccc318d75866588462a35cf8))
* **events:** Community Events core — /event, migrations 042-045, repository + feature modules ([#219](https://github.com/metalsp0rk/boiler-snake/issues/219) [#220](https://github.com/metalsp0rk/boiler-snake/issues/220) [#221](https://github.com/metalsp0rk/boiler-snake/issues/221) [#223](https://github.com/metalsp0rk/boiler-snake/issues/223) [#224](https://github.com/metalsp0rk/boiler-snake/issues/224)) ([166099f](https://github.com/metalsp0rk/boiler-snake/commit/166099f74de4178ea1f0db90f768827750400d46))
* **events:** render signup options as inline embed columns ([7c25792](https://github.com/metalsp0rk/boiler-snake/commit/7c257926d917d1b078a55301e923628e59a56f29))
* **fluxer:** enforce contracts for reactions, delete partials and DMs ([9e0cbef](https://github.com/metalsp0rk/boiler-snake/commit/9e0cbef50e45dabd9d612c310bf1944e775d8549))
* **fluxer:** loud memberRoleIds shape guard + SDK-shaped contract test suite (issue [#200](https://github.com/metalsp0rk/boiler-snake/issues/200)) ([53880cf](https://github.com/metalsp0rk/boiler-snake/commit/53880cf4e9d8e4af42024714207a1a9422b0eb7a))
* **gork:** vision — downscale images to max 1280x1280 (aspect kept) before LLM calls ([532f27f](https://github.com/metalsp0rk/boiler-snake/commit/532f27f076e855212f840bc2e7739078e21ae0eb))
* **platform:** enforce NormalizedMessage required-field contract at the pipeline boundary ([f6a2962](https://github.com/metalsp0rk/boiler-snake/commit/f6a29622638f220450bcb2bcbfd45975c6e0f289))
* Tier-4 E2E suite against fauxcord mock Discord (buttons included) ([9fea829](https://github.com/metalsp0rk/boiler-snake/commit/9fea829fd60a27aa7ef39387ab58e6d5703ba2dc))
* **web:** Community Events calendar — /g/:guildId/events* console + gate inventories to 47 mutations ([#222](https://github.com/metalsp0rk/boiler-snake/issues/222)) ([eb9cb2d](https://github.com/metalsp0rk/boiler-snake/commit/eb9cb2d74d8a5896f0cc6fe55af3f65c651c1f8e))


### Bug Fixes

* allow the ping each youtube notification builds (audit H11) ([316031c](https://github.com/metalsp0rk/boiler-snake/commit/316031c45f3b7f3f4afd15148f2a5e6555eedca7))
* **boot:** make discord login failure terminal and watchdog the feature gate (audit C7) ([c1a75c1](https://github.com/metalsp0rk/boiler-snake/commit/c1a75c12be352613cc9ffd69a9ba012e960ebd0f))
* **bridge:** bound the relay/echo maps with a scheduled TTL sweep ([663fb1a](https://github.com/metalsp0rk/boiler-snake/commit/663fb1a27c6fb3dc81362b8aa0c3ec49d75e4132))
* **bridge:** commit links rows per part, id-synchronous with each send ACK ([8488603](https://github.com/metalsp0rk/boiler-snake/commit/8488603afdc8e32905ecdaeeae735c3a401d026d))
* **bridge:** delete the bridge's spool directory on disconnect ([894e3fb](https://github.com/metalsp0rk/boiler-snake/commit/894e3fb7b4d7ce73b70c5273e0346b2d308ea315))
* **bridge:** edit PATCHes re-send create-era attachment bytes — data:null poison-park ends ([3fc8e7d](https://github.com/metalsp0rk/boiler-snake/commit/3fc8e7d6b9d3d18bfefc4a63bea9ef670097e889)), closes [#376](https://github.com/metalsp0rk/boiler-snake/issues/376)
* **bridge:** re-edits after a done/failed edit row re-queue — terminal rows pre-deleted ([26ab2fb](https://github.com/metalsp0rk/boiler-snake/commit/26ab2fb837d978284c12d8089603abc9847a1e03)), closes [#375](https://github.com/metalsp0rk/boiler-snake/issues/375)
* **bridge:** source handle + best-effort avatar read the REAL author shapes (audit [#200](https://github.com/metalsp0rk/boiler-snake/issues/200) avatar/attribution gaps) ([558aa89](https://github.com/metalsp0rk/boiler-snake/commit/558aa89aeca5377492e9eb48062ce9dbeffb59b9))
* **bridge:** unwind created webhooks when activation throws (audit [#195](https://github.com/metalsp0rk/boiler-snake/issues/195) item 1) ([11ac137](https://github.com/metalsp0rk/boiler-snake/commit/11ac137e0dda7e8c52ca1dba7a095fe3aca240c3))
* **bridge:** wire the Fluxer handle's discovered API origin into relay webhook URLs (audit C1) ([9c56f0e](https://github.com/metalsp0rk/boiler-snake/commit/9c56f0e0fda33c66143a3c4ec1de06c6494bca34))
* **ci:** fix [#203](https://github.com/metalsp0rk/boiler-snake/issues/203) workflow files GitHub rejected at runtime ([e34249f](https://github.com/metalsp0rk/boiler-snake/commit/e34249f67311ecf3cd40bb37362430cff5c886f8))
* **ci:** real upload-artifact SHA + vendored fauxcord lockfile for npm ci ([a7c2b47](https://github.com/metalsp0rk/boiler-snake/commit/a7c2b4748ad061a03381c66c669e19bea009564d))
* clamp leaderboard button page to LB_PAGE_MAX at the parse site ([e52522f](https://github.com/metalsp0rk/boiler-snake/commit/e52522f1b60e2a3ffd8bcbb35bcffb679bff7334)), closes [#187](https://github.com/metalsp0rk/boiler-snake/issues/187)
* **command-permissions:** check state purpose, single-flight refresh, keep grants on raced 400s (audit [#193](https://github.com/metalsp0rk/boiler-snake/issues/193)) ([397481f](https://github.com/metalsp0rk/boiler-snake/commit/397481f104b8e2cd21912cfa44fb13c83d6d3382))
* **config:** boot config sanity rules + .env.example parity sweep ([#205](https://github.com/metalsp0rk/boiler-snake/issues/205)) ([c5fd101](https://github.com/metalsp0rk/boiler-snake/commit/c5fd10168c6013090f65d1b80821a4da472b36c5))
* **core:** bounded retention sweeps for the four unbounded tables (audit [#192](https://github.com/metalsp0rk/boiler-snake/issues/192)) ([568aacc](https://github.com/metalsp0rk/boiler-snake/commit/568aacc14b0e2fa07cb6b3b2a9f7b2d929ed5b3d))
* **core:** encrypt OAuth + GitHub PAT tokens at rest (AES-GCM envelope, audit C6) ([e1d2db2](https://github.com/metalsp0rk/boiler-snake/commit/e1d2db2254bf5dfc6055c2d33bf734ef5f2ed7c6))
* **core:** one-time legacy-shim deprecation warnings; docs truth sweep + TZ=UTC decay clock (audit [#206](https://github.com/metalsp0rk/boiler-snake/issues/206)) ([9e1883e](https://github.com/metalsp0rk/boiler-snake/commit/9e1883e9fb626803e7c566cbfce860bed2faefc8))
* **db:** export migration 016 id and assert registry id integrity ([45d7a40](https://github.com/metalsp0rk/boiler-snake/commit/45d7a40076cba9a76751dd99a008f8b780969bc5))
* **db:** PRAGMA user_version migration guard, explicit pragmas, single-writer doc ([#202](https://github.com/metalsp0rk/boiler-snake/issues/202)) ([4717632](https://github.com/metalsp0rk/boiler-snake/commit/4717632871181864c27fd1779112486be327724e))
* **db:** schema hygiene — CHECK constraints, hot-path indexes, drop dead voice_sessions ([#204](https://github.com/metalsp0rk/boiler-snake/issues/204)) ([23ac4d4](https://github.com/metalsp0rk/boiler-snake/commit/23ac4d4484be234053b28da426761292a982e346))
* **db:** self-heal partial 034 community cutover (migration 041) ([7d5e281](https://github.com/metalsp0rk/boiler-snake/commit/7d5e281a1828bde571baad2f328aef70c9772f9e))
* **event-reminders:** atomic claim state, retry backoff, retire gone channels (audit H12 [#196](https://github.com/metalsp0rk/boiler-snake/issues/196)) ([d7313cd](https://github.com/metalsp0rk/boiler-snake/commit/d7313cd77c1fe563324141cebea40d9ad4b72a26))
* **events:** drop TextInput labels inside Label components in edit modal ([5ce78ae](https://github.com/metalsp0rk/boiler-snake/commit/5ce78aec8e1fda97616410a447a2d55bc7d7ad99))
* **events:** place required 'event' option before optional options ([ca7515a](https://github.com/metalsp0rk/boiler-snake/commit/ca7515a7e76e78e87cd7487d017b07ee1eea474d))
* **events:** post command/button must reach the service verification ([23c8d90](https://github.com/metalsp0rk/boiler-snake/commit/23c8d90b4239dd53acd996a11844a8671cf8a2c3))
* **events:** repair edit modal crash and adopt MessageFlags for ephemeral replies ([0ff42f1](https://github.com/metalsp0rk/boiler-snake/commit/0ff42f1cf6b92f2a4d2a23815e837004e1035cb0))
* **events:** snake_case the duplicateEvent patch keys — /event duplicate was dropping ~10 fields ([4dbb9b3](https://github.com/metalsp0rk/boiler-snake/commit/4dbb9b330b5504f334be5906038c6005ed879f0f)), closes [#374](https://github.com/metalsp0rk/boiler-snake/issues/374)
* **events:** split /event into four commands to fit Discord's 8000-char cap ([ef3a291](https://github.com/metalsp0rk/boiler-snake/commit/ef3a29124f3d9154b218e1f7bff9379abd9332e6))
* **events:** verify posted message exists before refusing to re-post ([1fcc1ff](https://github.com/metalsp0rk/boiler-snake/commit/1fcc1ff6a3bd9fb4fca68a7adfd98c10f5a4d618))
* **fluxer:** distinguish absent member from zero-role member ([934ae07](https://github.com/metalsp0rk/boiler-snake/commit/934ae07a130561b66dd4ebef44df66664d384542))
* **fluxer:** files send via the SDK form builder — global FormData was JSON.stringify'd to "{}" ([8372112](https://github.com/metalsp0rk/boiler-snake/commit/8372112bbac4a5aa784b17c0e33d551745ae101d)), closes [#373](https://github.com/metalsp0rk/boiler-snake/issues/373)
* **fluxer:** name the message id in the roleIds-drift throw; refresh contract extras note ([3451972](https://github.com/metalsp0rk/boiler-snake/commit/3451972b3c335e9c3669aae8fc49cb340fa2b687))
* **fluxer:** normalize passes embeds and message flags through (audit [#200](https://github.com/metalsp0rk/boiler-snake/issues/200) gaps) ([6b49fe9](https://github.com/metalsp0rk/boiler-snake/commit/6b49fe97fe4c5000eb1fa830f3757c28c6860cbc))
* **fluxer:** resolve member role ids from GuildMemberRoleManager (audit C2) ([15b3e5f](https://github.com/metalsp0rk/boiler-snake/commit/15b3e5fd540fe4e2f555480c3afebbc174dfed87))
* **honeypot:** never ban on unknown member state in the Fluxer twin ([#280](https://github.com/metalsp0rk/boiler-snake/issues/280)) ([1dd27f2](https://github.com/metalsp0rk/boiler-snake/commit/1dd27f284fa05c1588de204c6f6249768547f3b1))
* **honeypot:** only ban on known newly-added roles, never on unknown state (audit C3/C4) ([1fd5a60](https://github.com/metalsp0rk/boiler-snake/commit/1fd5a60058d073e9717de400ddf41e59090c53c7)), closes [#184](https://github.com/metalsp0rk/boiler-snake/issues/184)
* injectable lifecycle timer seam + wall-clock-free guard unit tests (CI) ([a9b54b3](https://github.com/metalsp0rk/boiler-snake/commit/a9b54b38ba2ae07011ccbc3df56c6f9c3201bf75))
* **linking:** Fluxer !link create by DM (K2); peer-free public conflict replies ([3c7254b](https://github.com/metalsp0rk/boiler-snake/commit/3c7254bf2979a089663f0d2cf730062e3d595ef9))
* **linking:** route Fluxer pairing replies DM-first — channel never publishes the pair ([#276](https://github.com/metalsp0rk/boiler-snake/issues/276)) ([ceba09a](https://github.com/metalsp0rk/boiler-snake/commit/ceba09a324a58ad9df7ec1ea728e2726408e4fd5))
* **logs:** message cache keys platform-neutral communityId so Fluxer messages cache (audit [#200](https://github.com/metalsp0rk/boiler-snake/issues/200) pipeline effects) ([9984fc0](https://github.com/metalsp0rk/boiler-snake/commit/9984fc027d638a25ff494b45353dc1142c90f688))
* **logs:** stop writing consumer-less Fluxer message-cache rows ([65481f0](https://github.com/metalsp0rk/boiler-snake/commit/65481f043764e66ec3d34c692e6576433e47975c))
* **notify:** strict role allow-list for role-ping arms (roles:[id] without parse) ([cd98486](https://github.com/metalsp0rk/boiler-snake/commit/cd984867e428c847aafba2a4d794182ab550b8b4))
* process crash net + graceful SIGTERM/SIGINT shutdown (audit C8/C9) ([3ccc5a0](https://github.com/metalsp0rk/boiler-snake/commit/3ccc5a001ce726946fe8387b3bb38be853e67cf4))
* **reactionRoles:** token-guard pending-emoji terminal ops — stale capture can no longer clear the next armed session ([#370](https://github.com/metalsp0rk/boiler-snake/issues/370)) ([db2cac2](https://github.com/metalsp0rk/boiler-snake/commit/db2cac2a1eb5a397100076a74ba93f6253b3ecab))
* retire dead facade exports and guard the facade export shape ([ccf86ed](https://github.com/metalsp0rk/boiler-snake/commit/ccf86ed71de498417bb020385722b60562081175)), closes [#207](https://github.com/metalsp0rk/boiler-snake/issues/207)
* **tickets:** CAS-claim the archive before work; deadline-bound the summary LLM call (audit [#197](https://github.com/metalsp0rk/boiler-snake/issues/197)) ([9384e51](https://github.com/metalsp0rk/boiler-snake/commit/9384e516b7f1147fa87010942fb11c8fe71cede6))
* **tickets:** route ticket-archive asset downloads through shared SSRF guard (audit C5) ([132099b](https://github.com/metalsp0rk/boiler-snake/commit/132099b5818d83bb5474129ddf961c3161f23e31))
* **userActivity:** live channel counting reads the normalized contract, so Fluxer messages count (audit [#200](https://github.com/metalsp0rk/boiler-snake/issues/200) pipeline effects) ([dcdc8aa](https://github.com/metalsp0rk/boiler-snake/commit/dcdc8aa7ce6cec872bf92b0397ebceb24917f026))
* **voice,twitch:** per-guild/per-row try/catch in voice + twitch tickers (audit [#198](https://github.com/metalsp0rk/boiler-snake/issues/198)) ([5d026be](https://github.com/metalsp0rk/boiler-snake/commit/5d026be6d5c78c619b1243ec4def99615fd7aaac))
* **youtube:** honor youtube_polling_interval_minutes — the setting was written but never read ([6ec783d](https://github.com/metalsp0rk/boiler-snake/commit/6ec783db4bd46013a22d9f4d5381377d9f23d4bc)), closes [#379](https://github.com/metalsp0rk/boiler-snake/issues/379)
* **youtube:** live alerts dedup on their own pointer — no more [@everyone](https://github.com/everyone) loop mid-stream ([7f35a22](https://github.com/metalsp0rk/boiler-snake/commit/7f35a224ecc3c5a664ec56570c06fe63f479f807)), closes [#378](https://github.com/metalsp0rk/boiler-snake/issues/378)
* **youtube:** scope the watermark UPDATE by community — cross-guild clobbering ends ([b8e707c](https://github.com/metalsp0rk/boiler-snake/commit/b8e707cdd6febe91d1cb4c946a68fa043588f360)), closes [#377](https://github.com/metalsp0rk/boiler-snake/issues/377)
* **youtube:** the watermark advances only past DELIVERED notifications ([a8f5c0f](https://github.com/metalsp0rk/boiler-snake/commit/a8f5c0fa4989adc65b10b3028088ded63a89b896)), closes [#380](https://github.com/metalsp0rk/boiler-snake/issues/380)

## [1.31.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.30.1...v1.31.0) (2026-10-03)


### Features

* **bridge:** edit and delete relay (PR 6) ([1e0d1c6](https://github.com/metalsp0rk/boiler-snake/commit/1e0d1c6c1fe9c5968bcd9846adfa4afd442a1aef))
* **bridge:** Fluxer prefix, DM connect, activation (PR 7) ([c762aee](https://github.com/metalsp0rk/boiler-snake/commit/c762aee7759c4d00ca61e304f5cba60b3ce5c7d9))
* **bridge:** media spool + at-least-once worker (PR 5) ([e05af98](https://github.com/metalsp0rk/boiler-snake/commit/e05af98ea609942e7b0d6f78ac8711b43a1f0243))
* **bridge:** schema, repository, codes, expiry (PR 2) ([84a38b9](https://github.com/metalsp0rk/boiler-snake/commit/84a38b911fc94f5c3033d5099cffb9c4969ffd45))
* **bridge:** service, Discord command, pipeline gates (PR 4) ([8ee509d](https://github.com/metalsp0rk/boiler-snake/commit/8ee509dd703b046f58c9d1bd9bd9f21766f12455))
* **fluxer:** convert reactionRoles pending-emoji flow to Fluxer (fluxer-pr5, gap [#1](https://github.com/metalsp0rk/boiler-snake/issues/1)) ([d45a7f3](https://github.com/metalsp0rk/boiler-snake/commit/d45a7f3c62c40a96607808823081f2d50bda0098))
* **platform:** normalized DM ingestion, fetchMessage, webhook lifecycle (PR 3) ([7e097bb](https://github.com/metalsp0rk/boiler-snake/commit/7e097bb9fdd5821c543ab7e1ad177fe405aa8bff))


### Bug Fixes

* **bridge:** spike script live-run fixes ([72a2474](https://github.com/metalsp0rk/boiler-snake/commit/72a2474f1aa0150072b32688ae3819cb77fd5e70))
* **fluxer:** adapt gateway/REST integration to the real SDK wire shapes ([785980b](https://github.com/metalsp0rk/boiler-snake/commit/785980bb4a8e9a9d0ec19793190f10263fb892b6))
* **fluxer:** award message XP and deliver AttachmentBuilder files ([1caf683](https://github.com/metalsp0rk/boiler-snake/commit/1caf6837071562b83756d0144319d7a1ecc60abd))
* **fluxer:** editReply anchors to the channel of the first send; name skip causes (review) ([201454a](https://github.com/metalsp0rk/boiler-snake/commit/201454ab9c7f15005340b703766a5802f59c6ce0))
* **fluxer:** first editReply after defer sends the reply; honeypot warning via outbound ([284acc6](https://github.com/metalsp0rk/boiler-snake/commit/284acc656bb0a4412ddb1becce45c473a60b237e))
* **fluxer:** platform-aware jump URLs and gork audit via Fluxer OutboundClient ([d0db6c1](https://github.com/metalsp0rk/boiler-snake/commit/d0db6c16c0def52b99bfa40466eec72bbd172fda))
* **fluxer:** presigned attachment flow against the live OpenAPI contract ([8123533](https://github.com/metalsp0rk/boiler-snake/commit/81235336b3906ad1c394347ec506b23a3064a378))
* **fluxer:** review fixes for PR [#168](https://github.com/metalsp0rk/boiler-snake/issues/168) — webapp-base import, jump guild id, audit pin ([323ad94](https://github.com/metalsp0rk/boiler-snake/commit/323ad947fd5dbb23dc1f7269e15874d62c2e23a6))
* gateway MESSAGE_UPDATE with string-shaped mentions crashed the process ([54c2e32](https://github.com/metalsp0rk/boiler-snake/commit/54c2e322f9c7438564126fbd57a47830f22954e2))
* **web:** Fluxer-only deployments can reach the console login ([c4c6f88](https://github.com/metalsp0rk/boiler-snake/commit/c4c6f886d795d10ded31a9d6f1df717a05a911c6))
* **web:** thread getFluxerWebInstances into the landing registrar ([33dc7a1](https://github.com/metalsp0rk/boiler-snake/commit/33dc7a12a340c629ea932d19f10c08c11b0b08aa))
* **xp:** empty !leaderboard replies in-channel on Fluxer (docs law) ([4ca8e3a](https://github.com/metalsp0rk/boiler-snake/commit/4ca8e3ae62c0ee9d063cedf5c06cf7a7b5e71bda))

## [1.30.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.30.0...v1.30.1) (2026-10-01)


### Bug Fixes

* 034 migration crashes on legacy DBs with quoted table DDL ([c4acb90](https://github.com/metalsp0rk/boiler-snake/commit/c4acb90c9049c46e74b48d598b699957449d91fd))
* ReferenceError in Fluxer connect path (buildRestFaçade typo) ([c751eb3](https://github.com/metalsp0rk/boiler-snake/commit/c751eb3920aaf297fcd27dd9efb415bb447e6acc))

## [1.30.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.29.0...v1.30.0) (2026-10-01)


### Features

* CommandContext seam with Discord context/normalize adapters ([1bf83d8](https://github.com/metalsp0rk/boiler-snake/commit/1bf83d8691b92363d12d259bad854e7af10076d1))
* context gate variants, commandsAllowedFromContext, showModal bridge ([1752f4a](https://github.com/metalsp0rk/boiler-snake/commit/1752f4a503237a3eb1bc0ca8e7bc56585d07b4b5))
* file sends through the Fluxer outbound adapter ([57919f5](https://github.com/metalsp0rk/boiler-snake/commit/57919f598df5de46cb05c1d995fd631e906170f3))
* Fluxer channel permission masks on dispatch ([97c0e51](https://github.com/metalsp0rk/boiler-snake/commit/97c0e512de8ab29809cf2371da6164d4c64fe2c6))
* Fluxer discovery, prefix config, SDK client, boot supervisor ([fa7d0ba](https://github.com/metalsp0rk/boiler-snake/commit/fa7d0ba44e5b988a06debe78df8b817cd54a4d21))
* Fluxer OAuth login handlers for the web admin ([9ca335f](https://github.com/metalsp0rk/boiler-snake/commit/9ca335f10425c2955448ca94d127803c2419f3b6))
* Fluxer prefix parser, normalizer, outbound, dispatcher ([3d83405](https://github.com/metalsp0rk/boiler-snake/commit/3d8340583dbe6e79665d57a79ca440093ccb11d7))
* Fluxer reaction-role panels and honeypot bans on the outbound ([58c91a0](https://github.com/metalsp0rk/boiler-snake/commit/58c91a017c02caf20d41e51453024b0a95a9a4c8))
* Fluxer staff text commands and gork read_history ([d9343e1](https://github.com/metalsp0rk/boiler-snake/commit/d9343e1883908fb498e512607bff11101cd60b98))
* Fluxer ticket create through the OutboundClient ([4288e7c](https://github.com/metalsp0rk/boiler-snake/commit/4288e7c9d0eaeab5d273ea03bf1b27016bf329ca))
* Fluxer web session split — dual cookies, community-matched auth, tier resolution ([02bb7e2](https://github.com/metalsp0rk/boiler-snake/commit/02bb7e23cafbc114d5103aa391c5927f523603f9))
* **gork:** STE anti-slop answer style (roadmap §7.20, decisions 49-52) ([f4c609e](https://github.com/metalsp0rk/boiler-snake/commit/f4c609ee52046a5e6880f44cc0fcdfdbbfa3d29e))
* migration 034 — communities table + guild-scoped rebuild (fluxer PR 2, subtask 01) ([0980d47](https://github.com/metalsp0rk/boiler-snake/commit/0980d475dd5d955f351d25195a946fc9c52e9aba))
* **roadmap:** Fluxer Phase 0 spike script (PR 1 prep) ([5ae4a90](https://github.com/metalsp0rk/boiler-snake/commit/5ae4a90db83296cb3421d0199a990472c8b84000))
* route notification tickers by community ([8d3202b](https://github.com/metalsp0rk/boiler-snake/commit/8d3202b86d5cbd8ff74b5c39c2587aba39ef0318))


### Bug Fixes

* **platform:** resolve integer community ids at feature, web, and CLI edges ([5cc94c4](https://github.com/metalsp0rk/boiler-snake/commit/5cc94c4f4b973b071a94e03634779b7d998b168e))

## [1.29.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.28.0...v1.29.0) (2026-09-29)


### Features

* **gork:** per-guild /gork summarize input token budget (default 80k) ([51b5348](https://github.com/metalsp0rk/boiler-snake/commit/51b53485c7cfa3e8d38a3d99b390a6f40ab231ee))

## [1.28.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.27.1...v1.28.0) (2026-09-29)


### Features

* **gork:** /gork summarize conversation rundown MVP (decisions 53-57 locked) ([0020ec6](https://github.com/metalsp0rk/boiler-snake/commit/0020ec6f646a40ce631b74f4fc91a02b3697f3ed))
* **web:** sign-in landing instead of instant OAuth redirect ([12a4d1a](https://github.com/metalsp0rk/boiler-snake/commit/12a4d1a5270b58cc27dac34b6901388dcda44fcc))

## [1.27.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.27.0...v1.27.1) (2026-09-27)


### Bug Fixes

* **gork:** fail closed when over-budget reply construction throws ([227ce73](https://github.com/metalsp0rk/boiler-snake/commit/227ce73b7f535da15aea4ca6644d86c41375baa8))
* **gork:** pin the DB-reopen integration test as last in file ([8712e9e](https://github.com/metalsp0rk/boiler-snake/commit/8712e9e0fe283c5629519c7d6f956a475e97cdad))
* **gork:** share the thread-type duck constant from budget.js ([8c725ad](https://github.com/metalsp0rk/boiler-snake/commit/8c725add82eb47950ccfaf98536e429c2555164b))

## [1.27.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.26.0...v1.27.0) (2026-09-27)


### Features

* **web:** client-side Chart.js dashboard charts fed by staff-tier JSON API endpoints ([31e11ac](https://github.com/metalsp0rk/boiler-snake/commit/31e11ac2dd48c46fcd4712c2a9b169a577e9b740))
* **web:** mobile pass - usable console at 360-430px (nav wrap, table scroll contract, stacked forms, chart resize) ([3f5c9d7](https://github.com/metalsp0rk/boiler-snake/commit/3f5c9d7c0b252636b8e13f9f435f0b630053d222))
* **web:** session admin - self-service Your-sessions + admin-tier global viewer with revoke ([876596c](https://github.com/metalsp0rk/boiler-snake/commit/876596ce2c2590872a372065b23a949e00f2f41c))
* **web:** wire scheduler job state into ticker-health registry (roadmap 15.6) ([9d2b18a](https://github.com/metalsp0rk/boiler-snake/commit/9d2b18ab27f85f64be92883dcd5b94ac8ac1c3c8))

## [1.26.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.25.0...v1.26.0) (2026-09-27)


### Features

* **twitch:** EventSub webhook fast path + clips/VOD notifications ([abdb2c4](https://github.com/metalsp0rk/boiler-snake/commit/abdb2c462b3e01b2e95e7ef6cd58aba386727d82))

## [1.25.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.24.1...v1.25.0) (2026-09-27)


### Features

* **gork:** add read_discord linked message/channel reader ([19ef51f](https://github.com/metalsp0rk/boiler-snake/commit/19ef51f9f887821c0bd0c29d5591080218f224d5))


### Bug Fixes

* **xp:** finalize leaderboard pagination with editReply after deferUpdate ([7b61702](https://github.com/metalsp0rk/boiler-snake/commit/7b61702395bf47838dd4cbe49dd68d5b3e1d47ed))

## [1.24.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.24.0...v1.24.1) (2026-09-17)


### Bug Fixes

* **web:** integrations dropdowns labeled '(undefined)' — label fns read row fields off flattened id strings ([4f22959](https://github.com/metalsp0rk/boiler-snake/commit/4f22959e6e37887d2f969e0204028c44de479011))

## [1.24.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.23.1...v1.24.0) (2026-09-17)


### Features

* **web:** participants return to their ticket after login and get a Your-tickets list ([cb98071](https://github.com/metalsp0rk/boiler-snake/commit/cb98071836cfb354f5475573f8b49612e6b6f4dc))

## [1.23.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.23.0...v1.23.1) (2026-09-17)


### Bug Fixes

* **web:** surface the close-time summary — the AI narrative was stored but never rendered ([e67ec90](https://github.com/metalsp0rk/boiler-snake/commit/e67ec90db3c3cc6dd3a640f076a1638f5b1757ea))

## [1.23.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.22.0...v1.23.0) (2026-09-17)


### Features

* **web:** hover profile cards, named audit actors, person-aware archive search ([c83edb5](https://github.com/metalsp0rk/boiler-snake/commit/c83edb5de308ca574ee012858cda5090d081ae1d))

## [1.22.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.21.0...v1.22.0) (2026-09-17)


### Features

* **web:** type-ahead names on every identifier field — pick people/roles, don't paste snowflakes ([aa1e6d7](https://github.com/metalsp0rk/boiler-snake/commit/aa1e6d72616d84179e43e5db8b822d38ab98e4b3))

## [1.21.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.20.0...v1.21.0) (2026-09-17)


### Features

* **web:** themed transcript view — record is the truth, /raw is the export ([263a59b](https://github.com/metalsp0rk/boiler-snake/commit/263a59b4d8f08c5dbe082e891c67fbee60125cd2))

## [1.20.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.19.0...v1.20.0) (2026-09-17)


### Features

* **web:** archive lives in the shell — /g/:guildId/t with sidebar ([c799aea](https://github.com/metalsp0rk/boiler-snake/commit/c799aeae31e40abbb6b18c1e53cf99858fec74f0))

## [1.19.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.18.0...v1.19.0) (2026-09-17)


### Features

* **web:** archive first-class — sidebar entry, search, people cells, console links ([3eb1182](https://github.com/metalsp0rk/boiler-snake/commit/3eb11820557b0ea2e94a22d1a2da50885f692314))

## [1.18.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.17.1...v1.18.0) (2026-09-17)


### Features

* **web:** lazy member-fetch queue — names resolve off the request path ([1c6345c](https://github.com/metalsp0rk/boiler-snake/commit/1c6345c4864fcf083af8030adc35301e9dbc4d95))

## [1.17.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.17.0...v1.17.1) (2026-09-17)


### Bug Fixes

* **web:** version shell asset URLs (immutable static cache pinned stale CSS) ([708157a](https://github.com/metalsp0rk/boiler-snake/commit/708157a574de8cdb0c11af98ddf00b83b527b3fc))

## [1.17.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.16.1...v1.17.0) (2026-09-17)


### Features

* **web:** UX v1.1 — root guild list, sidebar nav, member names, background jobs ([6cbeb46](https://github.com/metalsp0rk/boiler-snake/commit/6cbeb46b7becbc60fbfbb54462092cca21a74388))

## [1.16.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.16.0...v1.16.1) (2026-09-17)


### Bug Fixes

* **web:** bot-guild provider used removed Collection#keyArray ([975f9d2](https://github.com/metalsp0rk/boiler-snake/commit/975f9d2dae1b7a2c0bae2ae5acd5acbc6124e46a))

## [1.16.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.15.0...v1.16.0) (2026-09-16)


### Features

* **db:** web_sessions and admin_audit migrations with repository helpers ([6809383](https://github.com/metalsp0rk/boiler-snake/commit/6809383f89342fc33228fabedb3ce98fe1324b24))
* **web:** command-visibility sync trigger - shared sync core reused by slash and web (phase 3) ([99f6aeb](https://github.com/metalsp0rk/boiler-snake/commit/99f6aebe10209aa866ca27fca2bacaa2a9b3c57c))
* **web:** extract HTTP surface to src/web on Express 5 (byte-identical, dark-by-default) ([6dd2864](https://github.com/metalsp0rk/boiler-snake/commit/6dd28646016572fa801e396765b40ddc24a6d3f9))
* **web:** grant XP admin action via awardXp service - slash audit parity (phase 3) ([4544ee3](https://github.com/metalsp0rk/boiler-snake/commit/4544ee3d1585f5fbb2b88a6ef94abdf9ccf83ea6))
* **web:** leaderboard, moderation lists, settings views (read-only, query-budgeted) ([a575957](https://github.com/metalsp0rk/boiler-snake/commit/a575957da90b94dd5727d1f85749ea26e3625e53))
* **web:** login-mandatory tickets (staff-or-participant), dashboard data page, unified user profile ([f3c6204](https://github.com/metalsp0rk/boiler-snake/commit/f3c6204b39d4ee1f289f942235f065ef25f779fc))
* **web:** mutation registry gate + audit middleware mount (Phase 2 foundation) ([19961de](https://github.com/metalsp0rk/boiler-snake/commit/19961deb26077408385a3b050cb6a04abbab6470))
* **web:** phase 0b auth core - discord login, csrf/rate-limit middleware, audit writer, session tokens (025) ([fe94b0f](https://github.com/metalsp0rk/boiler-snake/commit/fe94b0ffe68e43449ca018eac3e9c00ff3775eae))
* **web:** phase 2 config writes - settings, staff CRUD, level-roles, integrations (CSRF+audit+PRG) ([18d7c06](https://github.com/metalsp0rk/boiler-snake/commit/18d7c06cc6e8b187b64b5736208a03d5dd4c7a51))
* **web:** session core with DB sessions, cookie hygiene, and secret/TTL config ([d11e2dc](https://github.com/metalsp0rk/boiler-snake/commit/d11e2dc00aa1f2b0c7afdfa3cb7ab5edc0bdddd2))
* **web:** shell layout with escaped templates, CSP nonce, vendored htmx, guild switcher ([f19f383](https://github.com/metalsp0rk/boiler-snake/commit/f19f383cc8b787fae99153a25432ea298789dbfa))
* **web:** staff roles + command-visibility view, integrations views, 0c exit suite (110-cell access matrix) ([0b3129c](https://github.com/metalsp0rk/boiler-snake/commit/0b3129c1dfb158d9d6fca8306993a1a8524f1bf6))
* **web:** ticket claim/close/summarize senior-tier actions reusing slash ticket flows (phase 3) ([8e76b71](https://github.com/metalsp0rk/boiler-snake/commit/8e76b7136b988fa08292393569c0932d3d3cffa0))
* **web:** tier resolution gate (guildAccess/requireTier/guildScope) + slash-side audit trail ([4813044](https://github.com/metalsp0rk/boiler-snake/commit/48130440ca7ebc82629c5d6d40f00bd5e0dcb217))
* **web:** voice/music view-only page, system page + admin audit viewer ([8a21678](https://github.com/metalsp0rk/boiler-snake/commit/8a216788969b1678d2198536ee9922af428a0d8f))
* **web:** warn issue/void + staff-note actions via slash-identical helpers (phase 3) ([c5eca32](https://github.com/metalsp0rk/boiler-snake/commit/c5eca32d661cbc2cdccf2ef9d881396aa0b93942))


### Bug Fixes

* **web:** audit-block placement + gork auditTrail import ([ff2f73b](https://github.com/metalsp0rk/boiler-snake/commit/ff2f73b0624fa497b152d8e7125a46795e79f365))
* **web:** re-wire slash audit trail into post-refactor modules (eventReminders/gork/tickets/warnings) ([17e0dd0](https://github.com/metalsp0rk/boiler-snake/commit/17e0dd08b44af5fac16c77a2c99ec6e3ea85daec))
* **web:** renumbered migration references (028-030) + registry feature count ([7503657](https://github.com/metalsp0rk/boiler-snake/commit/75036572c6bf0dfa32d9f6365b772d0962f5a9f4))

## [1.15.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.14.2...v1.15.0) (2026-09-16)


### Features

* **gork:** no-markdown-tables base prompt line (roadmap decision 43) ([e9da2e3](https://github.com/metalsp0rk/boiler-snake/commit/e9da2e3741d81c66b585ea9025481c423bf571b1))

## [1.14.2](https://github.com/metalsp0rk/boiler-snake/compare/v1.14.1...v1.14.2) (2026-09-16)


### Bug Fixes

* **twitch:** make go-live notifications actually reach Discord ([4b99aaf](https://github.com/metalsp0rk/boiler-snake/commit/4b99aafb8ed862bef6f229e74e8bf62b96cc431b))

## [1.14.1](https://github.com/metalsp0rk/boiler-snake/compare/v1.14.0...v1.14.1) (2026-09-15)


### Bug Fixes

* **gork:** env-configurable memory-turn timeout (GORK_MEMORY_TURN_TIMEOUT_MS) ([2f92d12](https://github.com/metalsp0rk/boiler-snake/commit/2f92d12e3344474e9029525f5fbe7589091516c1))

## [1.14.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.13.0...v1.14.0) (2026-09-14)


### Features

* **gork:** debug instrumentation for fast LLM failures ([4a252d9](https://github.com/metalsp0rk/boiler-snake/commit/4a252d986c9b1d9cb61fe85f7c7291cf413e97c8))

## [1.13.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.12.0...v1.13.0) (2026-09-14)


### Features

* **gork:** full interaction logging for E2E replay ([0315120](https://github.com/metalsp0rk/boiler-snake/commit/031512080d9d6498cabb521d4bd39bcdb15e73d3))
* **gork:** per-scope daily usage budget (roadmap 7.17, decisions 30-37) ([42bc640](https://github.com/metalsp0rk/boiler-snake/commit/42bc640695008dfbb5d029f57705900462997ecd))


### Bug Fixes

* **gork:** budget review nits — thread-binding docs, dequeue log scope, remove-side parity ([160814a](https://github.com/metalsp0rk/boiler-snake/commit/160814a5fb7116da5d13d26640484150ed9b707c))

## [1.12.0](https://github.com/metalsp0rk/boiler-snake/compare/v1.11.1...v1.12.0) (2026-09-13)


### Features

* **github:** per-guild GitHub release notifications (hourly ticker) ([725c4a2](https://github.com/metalsp0rk/boiler-snake/commit/725c4a22a9d450d5b516f1d4e870c09cf906a6b7))
* **gork:** channel-aware answers (roadmap 7.18, locked decisions 38-41) ([6938084](https://github.com/metalsp0rk/boiler-snake/commit/6938084135cceab93e3d7ab831de08e0ae7ac8da))


### Bug Fixes

* **gork:** attribute context lines and flag the triggering user (roadmap 7.15 Fix 7) ([e64429e](https://github.com/metalsp0rk/boiler-snake/commit/e64429e3d4e4a352538a95206c061e30916ebf3e))

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
