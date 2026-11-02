/**
 * Ban appeals (#773) — offline full-stack integration suite (subtask 12):
 * the FULL appeal loop on the harness EventEmitter client —
 *   /ban → ban-DM Appeal button (edit-attach) → guildless press → statement
 *   modal → staff ticket (header + 3 buttons) → two-way ferry (text/image
 *   re-host/staff reply/audio refusal/flood belt) → pause/resume → clemency
 *   (welcome-spend → unban → invite → ONE DM → close → strip → audit) →
 *   deny (press → modal → denial DM with eligibility) → plain-close
 *   (ChannelDelete → neutral notice).
 *
 * ── Fauxcord gap 7 (TIER-4 STAND-IN — the locked in-file documentation) ─────
 * The live E2E tier (npm run test:e2e against scripts/fauxcord, mockFidelity
 * #449) cannot deliver DM-carried component interactions: fauxcord does not
 * support interactions in DM channels at all (gap 7 of the E2E gap list).
 * Guild-scoped interactions (slash commands, the in-ticket `ap:` family) DO
 * ride the real router there; the guildless `appeal:<recordId>` press and the
 * `appeal:s:<recordId>` modal submit cannot. THIS FILE IS THE SANCTIONED
 * STAND-IN for that leg: guildless interactions are delivered as plain-object
 * doubles straight onto the feature's own InteractionCreate listener — the
 * exact runtime path the shipped code takes (src/commands/router.js drops
 * guild-less interactions at its guild guard, so the router is untouched
 * here and everywhere in this file). Every guild-scoped click/modal DOES ride
 * the real router (registry.buildDefaultRegistry → applyFeaturesToRegistry →
 * banAppeals' `ap:` + `ap:deny:m:` claims).
 *
 * ── Mock gap-fill (in-file, helper untouched) ───────────────────────────────
 * attachAppealButtonToBanDm re-opens the ban DM through users.fetch →
 * (no createDM) → user.messages.fetch(banDmMessageId). The shared user double
 * (test/helpers/discord.js attachDmSurface) records sends + returns fake
 * messages but carries no messages surface, so the file-local
 * withDmMessageStore(user) adds the DM-channel message store (the last
 * returned fake message per id, plus a REST-shaped collection fetch for the
 * boot catch-up) WITHOUT touching the shared helper.
 *
 * ── Hermetic notes ──────────────────────────────────────────────────────────
 *  - every src require happens AFTER createIntegrationEnv() — loadDb() purges
 *    the project src require cache (helpers/env.js #699);
 *  - one describe, one env; afterEach clears the mock guild buffers, every
 *    ban record (ban_appeals cascades via the 075 FK), every ticket row, and
 *    the three ban/appeal toggles;
 *  - no wall-clock waits and no faked timers: flood-cooldown and cursor
 *    determinism come from ONE user-side relay per appeal per test (the 10 s
 *    ferry cooldown makes a second live relay on the SAME appeal within the
 *    test non-deterministic, so relay legs that must pass ride a fresh
 *    appeal — the fresh appeal id is a fresh flood-ledger entry);
 *  - attachment re-host rides the byte server on globalThis.fetch keyed by
 *    an IPv4-literal URL (the ssrfGuard's no-DNS literal hop, same pattern as
 *    test/integration/ticket-reports.test.js) — dns.promises.lookup is an
 *    armed tripwire; zero network I/O ever.
 */
const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns");
const { Events } = require("discord.js");
const { createIntegrationEnv } = require("../helpers/harness");
const {
  createUser,
  createMember,
  createButtonInteraction,
  createModalSubmitInteraction,
  lastReplyContent,
  lastReplyEphemeral,
} = require("../helpers/discord");

const DAY = 24 * 60 * 60 * 1000;

describe("integration: ban appeals full loop (#773)", () => {
  /** @type {Awaited<ReturnType<typeof createIntegrationEnv>>} */
  let env;
  // Post-purge module captures (populated in before() — see hermetic notes):
  let appealsEvents; // src/features/banAppeals/events (registerEvents + catch-up)
  let C; // src/features/banAppeals/constants (customId grammar + refusal copy)
  let ferry; // src/features/banAppeals/ferry (FERRY_COPY exact strings)
  let outcomes; // src/features/banAppeals/outcomes (unban reason + modal field)
  let banEvents; // src/features/banLifecycle/events (the GuildBanRemove twin)

  /* ── offline transport (byte server + DNS tripwire, ticket-reports law) ─── */
  const PUBLIC_IP = "93.184.216.34"; // public example address (no traffic)
  const cdnUrl = (name) => `https://${PUBLIC_IP}/mock-cdn/${name}`;
  /** @type {Map<string, { bytes: Buffer, contentType: string }>} */
  const served = new Map();
  const attempted = { fetch: [], dns: [] };
  let origFetch;
  let origLookup;

  function serveFile(name, bytes, contentType) {
    const url = cdnUrl(name);
    served.set(url, { bytes, contentType });
    return url;
  }

  /* ── lifecycle ──────────────────────────────────────────────────────────── */

  before(async () => {
    env = await createIntegrationEnv();
    appealsEvents = require("../../src/features/banAppeals/events");
    C = require("../../src/features/banAppeals/constants");
    ferry = require("../../src/features/banAppeals/ferry");
    outcomes = require("../../src/features/banAppeals/outcomes");
    banEvents = require("../../src/features/banLifecycle/events");
    // REAL gateway binds, exactly the two calls boot's load.js makes for the
    // feature pair: the guildless intake lane + ferry lanes + ChannelDelete
    // (banAppeals) and the GuildBanRemove settle listener (banLifecycle, for
    // the clemency twin-event silence proof).
    appealsEvents.registerEvents(env.supervisor, {});
    banEvents.registerEvents(env.supervisor, {});

    origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const key = String(url);
      attempted.fetch.push(key);
      const hit = served.get(key);
      if (!hit) {
        throw new Error(`TRIPOWIRE: unexpected fetch for ${key}`);
      }
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name) => {
            const n = String(name).toLowerCase();
            if (n === "content-type") return hit.contentType;
            if (n === "content-length") return String(hit.bytes.length);
            return null;
          },
        },
        arrayBuffer: async () => hit.bytes,
      };
    };
    origLookup = dns.promises.lookup;
    dns.promises.lookup = async (host) => {
      attempted.dns.push(String(host));
      throw new Error(`TRIPOWIRE: DNS lookup attempted for ${host}`);
    };
  });

  after(() => {
    globalThis.fetch = origFetch;
    dns.promises.lookup = origLookup;
    env?.cleanup();
  });

  afterEach(() => {
    // Mock Discord-side buffers (helper law: clear with length = 0).
    env.guild._bans.length = 0;
    env.guild._unbans.length = 0;
    env.guild._invites.length = 0;
    // Cycle rows: the 075 FK cascades ban_appeals off ban_records (FKs are
    // ON — src/db/connection.js); tickets opened by the appeal pipeline are
    // wiped beside them. Audit rows survive (queries filter per-test ids).
    env.db.db.prepare("DELETE FROM ban_records").run();
    env.db.db.prepare("DELETE FROM tickets").run();
    env.db.updateGuildSettings(env.communityId, {
      ban_appeals: 1,
      ban_dm: 1,
      welcome_back_dm: 1,
    });
    served.clear();
    attempted.fetch.length = 0;
    attempted.dns.length = 0;
  });

  /* ── helpers ────────────────────────────────────────────────────────────── */

  /**
   * The file-local DM-channel message store (see the file header). Records
   * every fake message user.send() returns (ban DMs, confirmation DMs,
   * ferry relays) and exposes the messages.fetch surface
   * attachAppealButtonToBanDm and the boot catch-up drive. Idempotent.
   */
  function withDmMessageStore(user) {
    if (user._dmStoreInstalled === true) return user;
    user._dmStoreInstalled = true;
    const store = new Map();
    user._dmStore = store;
    const origSend = user.send;
    user.send = async (payload) => {
      const msg = await origSend.call(user, payload);
      store.set(msg.id, msg);
      return msg;
    };
    user.messages = {
      fetch: async (arg) => {
        if (typeof arg === "string") {
          const msg = store.get(arg);
          if (msg) return msg;
          throw Object.assign(
            new Error("DiscordAPIError[10008]: Unknown Message"),
            { code: 10008 },
          );
        }
        // REST-shaped collection form ({limit, after|before}) for catch-up.
        const limit = arg?.limit || 100;
        const ascending = Boolean(arg?.after) && !arg?.before;
        let all = [...store.values()].sort((a, b) =>
          ascending
            ? String(a.id).localeCompare(String(b.id))
            : String(b.id).localeCompare(String(a.id)),
        );
        if (arg?.before) {
          all = all.filter((m) => String(m.id) < String(arg.before));
        }
        if (arg?.after) {
          all = all.filter((m) => String(m.id) > String(arg.after));
        }
        return all.slice(0, limit);
      },
    };
    return user;
  }

  const dmMessageId = (user) => `dm-${user.id}`;

  /**
   * Fresh guild member with a DIGITS id (the header's inert `<@!id>` mention
   * renders in snowflake form), registered in the users cache and wearing the
   * DM message store.
   */
  let targetSeq = 773000;
  function addAppealTarget(tag) {
    targetSeq += 1;
    const user = createUser({ id: String(targetSeq), username: `appeal-${tag}` });
    const member = createMember({ guild: env.guild, user, admin: false });
    env.guild.addMember(member);
    env.client.users.addUser(user);
    return withDmMessageStore(user);
  }

  /** Flush the fire-and-forget listener chain (ban-lifecycle drain law). */
  async function drain(turns = 40) {
    for (let i = 0; i < turns; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Drive `/ban <member> <reason> 24h` through the REAL router. */
  function slashBan(user, { reason = "spam", duration = "24h" } = {}) {
    return env.runCommand({
      commandName: "ban",
      admin: true,
      options: { member: user, reason, duration },
    });
  }

  function activeRecord(user) {
    return env.db.findActiveBanRecord(env.communityId, user.id);
  }

  function appealRowFor(record) {
    return env.db.getAppealByBanRecord(env.communityId, record.id);
  }

  function auditRows(action) {
    const rows = env.db.listAdminAudit(env.communityId, { limit: 200 });
    return action ? rows.filter((r) => r.action === action) : rows;
  }

  function auditRowsFor(action, subject) {
    return auditRows(action).filter((r) => {
      if (r.target_id === String(subject)) return true;
      try {
        return (
          JSON.parse(r.details_json || "null")?.subject_user_id === String(subject)
        );
      } catch {
        return false;
      }
    });
  }

  /** customId of a captured builder (ban-lifecycle accessor law). */
  function builderJson(b) {
    return typeof b?.toJSON === "function" ? b.toJSON() : b;
  }

  const ticketChannel = (appeal) =>
    env.guild.channels.cache.get(appeal.ticket_channel_id);

  /** The appeal header fake message living in the ticket channel. */
  const headerMessage = (appeal) => {
    const ch = ticketChannel(appeal);
    return ch.messages.cache.get(`msg-sent-2-${ch.id}`);
  };

  /**
   * Plain-object GUILDESS doubles (fauxcord gap 7 stand-in — see the header):
   * no guild anywhere on them; they ride the feature's own InteractionCreate
   * listener, never the router.
   */
  function guildlessPress({ user, customId, message = null }) {
    const ix = {
      customId,
      guild: null,
      guildId: null,
      channel: null,
      channelId: null,
      client: env.client,
      user,
      member: null,
      message,
      replied: false,
      deferred: false,
      replies: [],
      modals: [],
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isModalSubmit: () => false,
      isButton: () => true,
      reply: async (payload) => {
        ix.replied = true;
        ix.replies.push(payload);
        return payload;
      },
      followUp: async (payload) => {
        ix.replies.push(payload);
        return payload;
      },
      deferReply: async (payload) => {
        ix.deferred = true;
        return payload;
      },
      showModal: async (modal) => {
        ix.modals.push(modal);
        ix.replied = true;
        return modal;
      },
    };
    return ix;
  }

  function guildlessModalSubmit({ user, customId, statement, message = null }) {
    const ix = {
      customId,
      guild: null,
      guildId: null,
      channel: null,
      channelId: null,
      client: env.client,
      user,
      member: null,
      message,
      replied: false,
      deferred: false,
      replies: [],
      fields: {
        getTextInputValue: (id) => {
          if (id !== C.MODAL_FIELD_STATEMENT) {
            throw new Error(`Missing text field ${id}`);
          }
          return statement;
        },
      },
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isModalSubmit: () => true,
      isButton: () => false,
      reply: async (payload) => {
        ix.replied = true;
        ix.replies.push(payload);
        return payload;
      },
      followUp: async (payload) => {
        ix.replies.push(payload);
        return payload;
      },
      deferReply: async (payload) => {
        ix.deferred = true;
        return payload;
      },
    };
    return ix;
  }

  async function emitGuildless(ix) {
    env.client.emit(Events.InteractionCreate, ix);
    await drain();
    return ix;
  }

  /** Guild-scoped `ap:` BUTTON click through the REAL router + registry. */
  async function ticketClick(customId, { message = null } = {}) {
    const ix = createButtonInteraction({
      customId,
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
      client: env.client,
      message,
    });
    await env.handleInteraction(ix, env.ctx);
    return ix;
  }

  /**
   * Guild-scoped `ap:deny:m:` MODAL SUBMIT through the REAL router. The
   * shared modal double lacks deferUpdate/followUp (the shipped handler
   * defers the update and follow-ups the ack) — extended in-file.
   */
  async function ticketModalSubmit(customId, fields, { message = null } = {}) {
    const ix = createModalSubmitInteraction({
      customId,
      guild: env.guild,
      user: env.users.adminUser,
      member: env.members.adminMember,
      admin: true,
      client: env.client,
      fields,
      message,
    });
    ix.deferred = false;
    ix.deferUpdate = async () => {
      if (ix.deferred || ix.replied) {
        throw Object.assign(new Error("already acknowledged"), {
          code: "InteractionAlreadyReplied",
        });
      }
      ix.deferred = true;
    };
    ix.followUps = [];
    ix.followUp = async (payload) => {
      ix.followUps.push(payload);
      ix.replies.push(payload);
      return payload;
    };
    await env.handleInteraction(ix, env.ctx);
    return ix;
  }

  /** Plain-duck MessageCreate on the user's DM lane (guild: null). */
  async function emitUserDm(
    target,
    { id, content = "", attachments = [], embeds = [] },
  ) {
    env.client.emit(Events.MessageCreate, {
      id,
      content,
      author: target,
      guild: null,
      channel: { id: `dm-channel-${target.id}`, type: 1 },
      attachments,
      embeds,
      type: 0,
    });
    await drain();
  }

  /** Plain-duck MessageCreate on the staff-ticket lane. */
  async function emitTicketMessage(
    appeal,
    author,
    { id, content = "", displayName = null, member = null, bot = false },
  ) {
    const authorDuck = bot
      ? { id: author.id ?? env.client.user.id, username: author.username ?? "bot", bot: true }
      : author;
    env.client.emit(Events.MessageCreate, {
      id,
      content,
      author: authorDuck,
      member: member ?? (displayName != null ? { displayName } : null),
      guild: env.guild,
      channel: ticketChannel(appeal),
      attachments: [],
      embeds: [],
      type: 0,
    });
    await drain();
  }

  /**
   * The full opening cycle: /ban → captured ban DM → guildless press →
   * statement modal → guildless modal submit → OPEN appeal + ticket.
   * Returns every handle the assertions need.
   */
  async function openAppealCycle(tag, { statement = "I was away — that ban was a mistake." } = {}) {
    const target = addAppealTarget(tag);
    const banIx = await slashBan(target);
    assert.match(
      lastReplyContent(banIx),
      /\*\*Banned:\*\*/,
      "the /ban arm ran before the appeal cycle",
    );
    const record = activeRecord(target);
    assert.ok(record, "active ban record behind the cycle");

    const banDmMsg = target._dmStore.get(dmMessageId(target));
    assert.ok(banDmMsg, "ban DM message captured through the DM store");

    const press = await emitGuildless(
      guildlessPress({
        user: target,
        customId: `${C.APPEAL_PREFIX}${record.id}`,
        message: banDmMsg,
      }),
    );
    assert.equal(press.modals.length, 1, "press presents the statement modal");

    const modal = await emitGuildless(
      guildlessModalSubmit({
        user: target,
        customId: `${C.MODAL_APPEAL_PREFIX}${record.id}`,
        statement,
        message: banDmMsg,
      }),
    );
    const appeal = appealRowFor(record);
    assert.ok(appeal, "appeal row exists after the modal submit");
    const ch = ticketChannel(appeal);
    assert.ok(ch, "ticket channel exists for the open appeal");
    return { target, record, banDmMsg, press, modal, appeal, ch };
  }

  /* ══ 1. ban DM → Appeal button (edit-attach after the record) ══════════════ */

  it("/ban with appeals ON edits the ban DM to carry the Appeal button keyed to the record", async () => {
    const target = addAppealTarget("attach");
    const interaction = await slashBan(target, { reason: "spam", duration: "24h" });

    assert.match(lastReplyContent(interaction), /\*\*Banned:\*\*/, "/ban landed");
    const record = activeRecord(target);
    assert.ok(record);
    assert.equal(record.ban_dm_sent, 1, "the ban DM was delivered");

    const banDmMsg = target._dmStore.get(dmMessageId(target));
    assert.ok(banDmMsg, "ban DM exists");
    // The #772 DM copy stands untouched; the button rides an EDIT (the
    // record id did not exist when the DM was sent — locked order law).
    assert.match(banDmMsg.content, /have been banned from/, "original ban copy kept");
    assert.equal(banDmMsg.edits.length, 1, "exactly one edit: the button attach");
    const row = builderJson(banDmMsg.edits[0].components[0]);
    assert.equal(row.components.length, 1);
    assert.equal(row.components[0].custom_id, `appeal:${record.id}`);
    assert.equal(row.components[0].label, C.APPEAL_BUTTON_LABEL);
    assert.ok(banDmMsg.components, "the live DM now carries the components");
  });

  /* ══ 2. guildless press → modal; forged presser → specific refusal ═════════ */

  it("guildless press presents the statement modal; a forged presser gets the named refusal with no ticket", async () => {
    const target = addAppealTarget("press");
    await slashBan(target);
    const record = activeRecord(target);
    const banDmMsg = target._dmStore.get(dmMessageId(target));
    const createdBefore = env.guild.channels.created.length;

    const press = await emitGuildless(
      guildlessPress({
        user: target,
        customId: `${C.APPEAL_PREFIX}${record.id}`,
        message: banDmMsg,
      }),
    );
    assert.equal(press.modals.length, 1, "the modal was presented");
    const modal = builderJson(press.modals[0]);
    assert.equal(modal.custom_id, `appeal:s:${record.id}`);
    assert.equal(modal.title, C.APPEAL_MODAL_TITLE);

    // Forged presser: a different member presses the same DM button.
    const forger = env.users.memberUser;
    const forged = await emitGuildless(
      guildlessPress({
        user: forger,
        customId: `${C.APPEAL_PREFIX}${record.id}`,
        message: banDmMsg,
      }),
    );
    assert.equal(forged.modals.length, 0, "the forged press gets NO modal");
    assert.equal(lastReplyEphemeral(forged), true, "the refusal is ephemeral");
    assert.equal(lastReplyContent(forged), C.refusalNotYou());
    assert.equal(
      env.guild.channels.created.length,
      createdBefore,
      "the forged press opened no ticket",
    );
    assert.equal(appealRowFor(record), null, "nothing was filed");

    // LANE SEPARATION: a GUILD-scoped interaction on the same customId rides
    // neither lane — the feature listener bails on guild-truthy interactions
    // and the router never sees a raw client.emit. Nothing happens.
    const guildScoped = createButtonInteraction({
      customId: `${C.APPEAL_PREFIX}${record.id}`,
      guild: env.guild,
      user: target,
      member: createMember({ guild: env.guild, user: target, admin: false }),
      admin: false,
      client: env.client,
      message: banDmMsg,
    });
    env.client.emit(Events.InteractionCreate, guildScoped);
    await drain();
    assert.equal(guildScoped.modals.length, 0, "the guild-scoped press was ignored");
    assert.equal(guildScoped.replies.length, 0, "no reply on the ignored press");
    assert.equal(appealRowFor(record), null, "still nothing filed");
  });

  /* ══ 3. the refusal battery names its cause ═══════════════════════════════ */

  it("press refusals name their cause: unknown record, closed window, appeals off, already filed", async () => {
    const createdBefore = env.guild.channels.created.length;

    // Unknown/garbage record id → NO_RECORD (forged probes learn nothing).
    const nobody = await emitGuildless(
      guildlessPress({ user: env.users.memberUser, customId: "appeal:999999999" }),
    );
    assert.equal(lastReplyContent(nobody), C.refusalNoRecord());
    assert.equal(lastReplyEphemeral(nobody), true);

    // Record exists but the ban was lifted → NOT_ACTIVE.
    const target = addAppealTarget("inactive");
    await slashBan(target);
    const record = activeRecord(target);
    await env.guild.members.unban(target.id, "staff lifted it");
    env.db.finalizeUnban(record.id, "unbanned_manual", "lifted");
    const lifted = await emitGuildless(
      guildlessPress({ user: target, customId: `${C.APPEAL_PREFIX}${record.id}` }),
    );
    assert.equal(lastReplyContent(lifted), C.refusalNotActive());

    // Appeals OFF: `/banappeals disable` through the REAL router, then a fresh
    // ban ships WITHOUT the button and a press refuses by name.
    const off = await env.runCommand({
      commandName: "banappeals",
      subcommand: "disable",
      admin: true,
    });
    assert.equal(lastReplyEphemeral(off), true);
    assert.match(lastReplyContent(off), /\*\*Ban appeals:\*\* now \*\*off\*\*\./);
    assert.equal(Number(env.db.getGuildSettings(env.communityId).ban_appeals), 0);
    assert.equal(
      auditRows("banAppeals.toggle_set").length,
      1,
      "the toggle lands its audit row",
    );

    const offTarget = addAppealTarget("offcycle");
    await slashBan(offTarget);
    const offRecord = activeRecord(offTarget);
    const offBanDm = offTarget._dmStore.get(dmMessageId(offTarget));
    assert.equal(offBanDm.edits.length, 0, "no button attach with appeals off");
    assert.equal(offBanDm.components, undefined, "the ban DM ships component-less");
    const offPress = await emitGuildless(
      guildlessPress({
        user: offTarget,
        customId: `${C.APPEAL_PREFIX}${offRecord.id}`,
        message: offBanDm,
      }),
    );
    assert.equal(lastReplyContent(offPress), C.refusalAppealsOff());
    assert.equal(appealRowFor(offRecord), null, "no appeal filed with appeals off");

    // ALREADY_FILED: reopen appeals, file one, press again.
    await env.runCommand({ commandName: "banappeals", subcommand: "enable", admin: true });
    const cycle = await openAppealCycle("filed");
    const again = await emitGuildless(
      guildlessPress({
        user: cycle.target,
        customId: `${C.APPEAL_PREFIX}${cycle.record.id}`,
        message: cycle.banDmMsg,
      }),
    );
    assert.equal(lastReplyContent(again), C.refusalAlreadyFiled("open"));
    assert.equal(
      env.guild.channels.created.length,
      createdBefore + 1,
      "exactly one ticket for the cycle (the second press filed nothing)",
    );
  });

  /* ══ 4. statement modal → staff ticket + open appeal (deliverable 3) ═══════ */

  it("modal submit opens the staff ticket: relay-law header, three ap: buttons, open row, audit, confirmation DM, button edit-away", async () => {
    const statement = "I was away from my keyboard — the raid was not me.";
    const { target, record, banDmMsg, modal, appeal, ch } =
      await openAppealCycle("ticket", { statement });

    // The ack carries the filing truth (guildless listener copy).
    assert.match(
      lastReplyContent(modal),
      /\*\*Appeal:\*\* filed — your statement is with staff now/,
    );

    // Row truth: open, ticket bound, statement stored verbatim.
    assert.equal(appeal.status, "open");
    assert.equal(appeal.ticket_channel_id, ch.id);
    assert.equal(appeal.appeal_statement, statement);

    // Channel: the appeal-grammar rename over the pipeline's ticket-N name.
    assert.equal(ch.name, `appeal-B${record.ban_number}-${target.id}`);
    // Staff-only overwrites: @everyone denied, the owning moderator named.
    const overwrites = ch._overwrites;
    const everyone = overwrites.find((o) => String(o.id) === String(env.guildId));
    assert.ok(everyone, "an @everyone overwrite exists");
    assert.ok(
      (BigInt(everyone.deny ?? 0) & 1024n) === 1024n,
      "@everyone is denied ViewChannel",
    );
    assert.ok(
      overwrites.some((o) => String(o.id) === String(env.users.adminUser.id)),
      "the ban moderator owns the channel overwrite (never the banned user)",
    );
    assert.ok(
      !overwrites.some((o) => String(o.id) === String(target.id)),
      "the banned user is NEVER an overwrite target",
    );

    // Sends: [0] the pipeline's open notice, [1] the appeal header.
    assert.match(String(ch.sent[0].content ?? ch.sent[0]), /Opened for </);
    const header = ch.sent[1];
    assert.match(header.content, /\*\*Relay:\*\* everything typed in this channel/);
    assert.match(header.content, /\*\*Never shared:\*\* reactions, embeds, audio/);
    assert.deepEqual(header.allowedMentions, { parse: [] });

    const embed = builderJson(header.embeds[0]);
    assert.equal(embed.title, `Ban appeal B-${record.ban_number}`);
    assert.ok(embed.description.includes(statement), "statement rides verbatim in the fence");
    const field = (name) => embed.fields.find((f) => f.name === name)?.value ?? "";
    assert.ok(
      field("Appealing user").includes(`\`<@!${target.id}>\``),
      "inert code-wrapped mention — never a live ping",
    );
    assert.ok(field("Appealing user").includes(`ID: \`${target.id}\``));
    assert.equal(field("Ban"), `B-${record.ban_number}`);
    assert.ok(field("Banned by (staff-only)").includes(env.users.adminUser.id));
    assert.equal(field("Ban reason"), "spam");
    assert.match(
      embed.footer.text,
      /this header is NEVER relayed to the user/,
    );

    // Exactly three buttons on the locked grammar.
    const buttonRow = builderJson(header.components[0]);
    assert.deepEqual(
      buttonRow.components.map((b) => [b.custom_id, b.label]),
      [
        [`ap:clemency:${appeal.id}`, C.BUTTON_LABEL_CLEMENCY],
        [`ap:deny:${appeal.id}`, C.BUTTON_LABEL_DENY],
        [`ap:pause:${appeal.id}`, C.BUTTON_LABEL_PAUSE],
      ],
    );

    // The shared ticket row (creator = the owning moderator, not the user).
    const ticket = env.db.getTicketByChannel(env.communityId, ch.id);
    assert.ok(ticket, "ticket row exists");
    assert.equal(String(ticket.status), "open");
    assert.equal(String(ticket.creator_user_id), env.users.adminUser.id);

    // §5 audit row for the filing.
    const fileAudit = auditRows("banAppeals.file");
    assert.ok(
      fileAudit.some((r) => r.target_id === String(appeal.id)),
      "banAppeals.file audit row exists",
    );

    // Confirmation DM: filed truth + the up-front relay law (§3).
    const confirmation = target.sends.at(-1);
    assert.match(confirmation.content, /\*\*Appeal:\*\* filed — staff have your statement/);
    assert.match(confirmation.content, /\*\*Shared:\*\* only text, images, and video/);
    assert.match(confirmation.content, /\*\*One per ban:\*\*/);
    assert.deepEqual(confirmation.allowedMentions, { parse: [] });

    // Ban-DM button edit-away (issue §1): copy kept, button gone, filed stamp.
    assert.match(banDmMsg.content, /\n\n\*\*Appeal:\*\* filed <t:\d+:F>$/);
    assert.deepEqual(banDmMsg.components, [], "the button was edited away");
    assert.equal(banDmMsg.edits.length, 2, "attach edit + edit-away");
  });

  /* ══ 5. ferry user→ticket: signed relay + the flood belt ═══════════════════ */

  it("a user text DM relays into the ticket signed and mention-safe; a second inside the cooldown gets the specific notice", async () => {
    const { target, appeal, ch } = await openAppealCycle("relay");
    const sentBefore = ch.sent.length;

    await emitUserDm(target, { id: "ferry-in-1", content: "I was away from my keyboard" });

    const relay = ch.sent[sentBefore];
    assert.ok(relay, "the DM was relayed into the ticket");
    assert.equal(
      relay.content,
      `**${target.username} · ${target.id}:** I was away from my keyboard`,
      "signed `**<user · id>:** <text>` (escape + id, colon inside the bold)",
    );
    assert.deepEqual(relay.allowedMentions, { parse: [] }, "never a guild mention");

    // Cursor advanced AFTER the successful send.
    const row = env.db.getAppealById(appeal.id);
    assert.equal(row.ferry_user_msg_id, "ferry-in-1");
    assert.ok(Number(row.ferry_user_ts) > 0, "cursor pair persisted with the timestamp");

    // Flood belt: a second user message lands inside the 10 s spacing → the
    // SENDER learns the rule, the ticket stays silent (silent to staff).
    const sendsBefore = target.sends.length;
    await emitUserDm(target, { id: "ferry-in-2", content: "and again and again" });
    assert.equal(ch.sent.length, sentBefore + 1, "the second message was NOT relayed");
    const notice = target.sends[sendsBefore];
    assert.match(
      notice.content,
      /^\*\*Ferry cooldown:\*\* messages relay at most every 10 seconds/,
    );
    assert.deepEqual(notice.allowedMentions, { parse: [] });
    assert.equal(
      env.db.getAppealById(appeal.id).ferry_user_msg_id,
      "ferry-in-1",
      "a dropped message never advances the cursor",
    );
  });

  /* ══ 6. image relay re-hosts bytes through the SSRF guard ══════════════════ */

  it("an image DM re-hosts its bytes through the SSRF guard (zero DNS, byte-server fetch) and rides the relay as a file", async () => {
    const bytes = Buffer.from("fake-png-bytes-for-the-ferry-test");
    const url = serveFile("shot.png", bytes, "image/png");
    const { target, appeal, ch } = await openAppealCycle("image");
    const sentBefore = ch.sent.length;

    await emitUserDm(target, {
      id: "ferry-img-1",
      content: "proof screenshot",
      attachments: [
        { id: "att-1", name: "shot.png", url, size: bytes.length, content_type: "image/png" },
      ],
    });

    const relay = ch.sent[sentBefore];
    assert.ok(relay, "the image message was relayed");
    assert.equal(
      relay.content,
      `**${target.username} · ${target.id}:** proof screenshot`,
    );
    assert.equal(relay.files.length, 1, "the re-hosted file rides the send");
    assert.equal(relay.files[0].name, "shot.png");
    assert.equal(Buffer.compare(Buffer.from(relay.files[0].data), bytes), 0,
      "the bytes on the relay are the re-hosted originals");
    assert.deepEqual(relay.allowedMentions, { parse: [] });

    assert.deepEqual(attempted.fetch, [url], "the download rode the byte server");
    assert.deepEqual(attempted.dns, [], "the IP-literal hop performed zero DNS lookups");
    assert.equal(env.db.getAppealById(appeal.id).ferry_user_msg_id, "ferry-img-1");
  });

  /* ══ 7. audio refusal (sender named, ticket silent) ════════════════════════ */

  it("an audio DM gets the specific not-shared notice to the user, keeps the ticket silent, and does NOT burn the flood budget", async () => {
    const { target, ch } = await openAppealCycle("audio");
    const sentBefore = ch.sent.length;

    await emitUserDm(target, {
      id: "ferry-audio-1",
      content: "",
      attachments: [
        { id: "att-1", name: "voice.ogg", url: "https://93.184.216.34/mock-cdn/voice.ogg", size: 9000, content_type: "audio/ogg" },
      ],
    });
    assert.equal(ch.sent.length, sentBefore, "the ticket stayed silent");
    const notice = target.sends.at(-1);
    assert.equal(notice.content, ferry.FERRY_COPY.audio, "the sender gets the exact audio refusal");
    assert.deepEqual(notice.allowedMentions, { parse: [] });

    // The refusal was a classification drop (never a relay): the flood gate
    // is untouched, so the next plain text relays immediately.
    await emitUserDm(target, { id: "ferry-after-audio", content: "typing it instead" });
    assert.equal(
      ch.sent[sentBefore]?.content,
      `**${target.username} · ${target.id}:** typing it instead`,
      "text right after the audio refusal still relays (no cooldown consumed)",
    );
  });

  /* ══ 8. ferry ticket→user: staff reply + loop-proof belt ═══════════════════ */

  it("a staff ticket message relays to the user as '**<display name>:**' with NO id; bot-authored chatter never ferries", async () => {
    const { target, appeal, ch } = await openAppealCycle("staffreply");
    await emitUserDm(target, { id: "ferry-open-1", content: "hello?" });

    const dmBefore = target.sends.length;
    await emitTicketMessage(appeal, env.users.adminUser, {
      id: "msg-staff-1",
      content: "we are reviewing the case now",
      displayName: "Admin One",
    });
    const relay = target.sends[dmBefore];
    assert.ok(relay, "the staff message reached the user DM");
    assert.equal(
      relay.content,
      "**Admin One:** we are reviewing the case now",
      "display name only — NO id in user-facing copy (§3/§6)",
    );
    assert.ok(!relay.content.includes(env.users.adminUser.id), "the staff id never travels");
    assert.deepEqual(relay.allowedMentions, { parse: [] });

    const row = env.db.getAppealById(appeal.id);
    assert.equal(row.ferry_ticket_msg_id, "msg-staff-1", "the ticket-side cursor advanced");

    // Loop-proof listener belt: a bot-authored ticket message (other bots,
    // stray relays) is silently dropped — no user DM, no cursor move.
    await emitTicketMessage(appeal, { id: "999001", username: "other-bot", bot: true }, {
      id: "msg-bot-1",
      content: "bot noise that must never travel",
    });
    assert.equal(target.sends.length, dmBefore + 1, "no new user DM from bot chatter");
    assert.equal(env.db.getAppealById(appeal.id).ferry_ticket_msg_id, "msg-staff-1");
  });

  /* ══ 9. pause / resume (deliverable 5, REAL router dispatch) ═══════════════ */

  it("ap:pause silences BOTH directions; resume restores the relay and flips the header button label", async () => {
    const { target, appeal, ch } = await openAppealCycle("pause");

    const pauseIx = await ticketClick(`ap:pause:${appeal.id}`);
    assert.equal(pauseIx.updates.length, 1, "the header buttons update in place");
    const pausedRow = builderJson(pauseIx.updates[0].components[0]);
    assert.equal(
      pausedRow.components[2].label,
      C.BUTTON_LABEL_RESUME,
      "the pause button flipped to Resume relaying",
    );
    assert.equal(Number(env.db.getAppealById(appeal.id).ferry_paused), 1);

    // While paused both directions drop SILENTLY (structural skip precedes
    // the flood gate — nothing is consumed, nothing is noticed).
    const dmBefore = target.sends.length;
    const ticketSendsBefore = ch.sent.length;
    await emitTicketMessage(appeal, env.users.adminUser, {
      id: "msg-staff-paused",
      content: "internal staff discussion",
      displayName: "Admin One",
    });
    assert.equal(target.sends.length, dmBefore, "paused: nothing reaches the user");
    await emitUserDm(target, { id: "ferry-paused", content: "can you hear me?" });
    assert.equal(ch.sent.length, ticketSendsBefore, "paused: nothing enters the ticket");

    const resumeIx = await ticketClick(`ap:pause:${appeal.id}`);
    const resumedRow = builderJson(resumeIx.updates[0].components[0]);
    assert.equal(resumedRow.components[2].label, C.BUTTON_LABEL_PAUSE);
    assert.equal(Number(env.db.getAppealById(appeal.id).ferry_paused), 0);

    // Resume proof on the ticket→user direction (no user-side flood gate —
    // deterministic without any wall-clock dependency).
    await emitTicketMessage(appeal, env.users.adminUser, {
      id: "msg-staff-resumed",
      content: "sorry for the silence — back to you",
      displayName: "Admin One",
    });
    assert.equal(
      target.sends.at(-1).content,
      "**Admin One:** sorry for the silence — back to you",
      "the relay flows again after resume",
    );
  });

  /* ══ 10. clemency (deliverable 6) ══════════════════════════════════════════ */

  it("ap:clemency runs the locked order: welcome spend, unban, permanent invite, exactly ONE DM, ticket closed, header stripped, statuses + audits — and the GuildBanRemove twin stays silent", async () => {
    const { target, record, appeal, ch } = await openAppealCycle("clemency");
    const header = headerMessage(appeal);
    assert.ok(header, "the header fake message is reachable for the strip proof");

    const ix = await ticketClick(`ap:clemency:${appeal.id}`, { message: header });
    assert.ok(ix.deferred, "the outcome arm deferred the update first");
    assert.match(
      lastReplyContent(ix),
      new RegExp(`\\*\\*Clemency:\\*\\* granted — appeal #${appeal.id}\\.`),
    );

    // Discord side: exactly one unban with the clemency reason; the ban gone.
    assert.equal(env.guild._unbans.length, 1, "exactly one unban call");
    assert.equal(env.guild._unbans[0].user.id, target.id);
    assert.equal(env.guild._unbans[0].reason, outcomes.CLEMENCY_UNBAN_REASON);
    assert.equal(env.guild._bans.length, 0, "the ban entry is gone");

    // Invite: minted in the first text channel with the PINNED policy.
    assert.equal(env.guild._invites.length, 1, "one invite minted");
    assert.equal(env.guild._invites[0].channelId, env.channels.general.id);
    assert.deepEqual(env.guild._invites[0].options, {
      maxAge: 0,
      maxUses: 0,
      unique: false,
      reason: `Ban appeal — clemency granted (appeal ${appeal.id})`,
    });

    // EXACTLY ONE user DM — the clemency DM (invite + welcome); the generic
    // #772 welcome-back DM is structurally suppressed (claim spent BEFORE
    // the unban, proven by the flag below + the twin-event leg).
    const clemencyDms = target.sends.filter((p) =>
      /\*\*Appeal:\*\* granted — your ban in/.test(String(p?.content || "")),
    );
    assert.equal(clemencyDms.length, 1, "exactly one clemency DM");
    assert.equal(
      target.sends.filter((p) => /unbanned from/i.test(String(p?.content || ""))).length,
      0,
      "no generic welcome-back DM",
    );
    assert.match(clemencyDms[0].content, /\*\*Invite:\*\* https:\/\/discord\.gg\/mock-inv-\d+/);
    assert.deepEqual(clemencyDms[0].allowedMentions, { parse: [] });

    // Row truths: appeal granted (decided_by = the clicking staff), ban
    // settled clemency_granted, the welcome claim SPENT before the unban.
    const liveAppeal = env.db.getAppealById(appeal.id);
    assert.equal(liveAppeal.status, "granted");
    assert.equal(liveAppeal.decided_by, env.users.adminUser.id);
    assert.ok(Number(liveAppeal.decided_at) > 0);
    assert.equal(
      env.db.getBanRecord(record.id).status,
      "clemency_granted",
      "the record settled",
    );
    assert.ok(!activeRecord(target), "no ACTIVE record survives clemency");
    assert.equal(env.db.getBanRecord(record.id).welcome_dm_sent, 1,
      "the welcome claim was spent (structural one-DM guarantee)");

    // Ticket closed through the SHARED flow: row closed + close embed naming
    // /ticket archive; header buttons stripped via the message-edit path.
    assert.equal(String(env.db.getTicketByChannel(env.communityId, ch.id).status), "closed");
    const closeEmbed = builderJson(ch.sent.at(-1).embeds[0]);
    assert.match(closeEmbed.title, /closed$/);
    assert.match(closeEmbed.description, /\/ticket archive/);
    assert.ok(
      header.edits.some((patch) => Array.isArray(patch.components) && patch.components.length === 0),
      "the header's outcome buttons were stripped",
    );

    // §5 audits: the outcome row + the pinned invite-policy row.
    assert.equal(auditRowsFor("banAppeals.clemency_granted", target.id).length, 1);
    assert.ok(
      auditRows("banAppeals.invite_created").some(
        (r) => r.target_id === String(appeal.id) && JSON.parse(r.details_json).max_age === 0,
      ),
      "the invite policy is audited",
    );

    // The GUILDBANREMOVE TWIN of the bot's own unban (real Discord emits it):
    // the banLifecycle listener's active-record gate must bail — no second
    // settle, no second welcome DM, statuses hold.
    env.client.emit(Events.GuildBanRemove, { guild: env.guild, user: target, reason: null });
    await drain();
    assert.equal(env.db.getBanRecord(record.id).status, "clemency_granted");
    assert.equal(
      target.sends.filter((p) => /granted|unbanned from/i.test(String(p?.content || ""))).length,
      1,
      "the twin event added no DM",
    );
    assert.equal(env.guild._unbans.length, 1, "no second unban");
  });

  /* ══ 11. deny (deliverable 7): second cycle end to end ═════════════════════ */

  it("a second ban after clemency files a fresh appeal; ap:deny → reason modal → denial DM with eligibility + staff note; first-decision-wins answers every re-click", async () => {
    // Cycle 1: ban → appeal → clemency settles it (re-ban becomes lawful).
    const target = (await openAppealCycle("denyc1")).target;
    const first = activeRecord(target);
    const firstAppeal = appealRowFor(first);
    const header1 = headerMessage(firstAppeal);
    const clemency = await ticketClick(`ap:clemency:${firstAppeal.id}`, { message: header1 });
    assert.match(lastReplyContent(clemency), /\*\*Clemency:\*\* granted/);

    // Cycle 2: the same member re-banned → new record → new appeal.
    await slashBan(target, { reason: "raid relapse", duration: "24h" });
    const record2 = activeRecord(target);
    assert.ok(record2, "a fresh active record for the new cycle");
    assert.equal(record2.ban_number, first.ban_number + 1, "ban numbering continues");

    const banDm2 = target._dmStore.get(dmMessageId(target));
    await emitGuildless(
      guildlessPress({ user: target, customId: `${C.APPEAL_PREFIX}${record2.id}`, message: banDm2 }),
    );
    await emitGuildless(
      guildlessModalSubmit({
        user: target,
        customId: `${C.MODAL_APPEAL_PREFIX}${record2.id}`,
        statement: "the relapse was a mistake, second chance please",
        message: banDm2,
      }),
    );
    const appeal2 = appealRowFor(record2);
    assert.ok(appeal2 && appeal2.status === "open", "second appeal is open");
    const ch2 = ticketChannel(appeal2);

    // PRESS → the optional-reason modal rides the durable appeal id.
    const press = await ticketClick(`ap:deny:${appeal2.id}`, { message: headerMessage(appeal2) });
    assert.equal(press.modals.length, 1, "the press opened the denial modal");
    assert.equal(builderJson(press.modals[0]).custom_id, `ap:deny:m:${appeal2.id}`);

    // MODAL SUBMIT → denial lands.
    const ix = await ticketModalSubmit(
      `ap:deny:m:${appeal2.id}`,
      { [outcomes.MODAL_FIELD_REASON]: "Repeat pattern — see B-1." },
      { message: headerMessage(appeal2) },
    );
    assert.match(
      lastReplyContent(ix),
      new RegExp(`\\*\\*Denied:\\*\\* appeal #${appeal2.id} denied`),
    );

    // The denial DM: decision + <t:F> (<t:R>) eligibility + the staff note.
    const denial = target.sends.at(-1);
    assert.match(denial.content, /\*\*Appeal:\*\* denied — staff reviewed your appeal/);
    assert.match(denial.content, /\*\*Eligible again:\*\* <t:\d+:F> \(<t:\d+:R>\)/);
    assert.match(denial.content, /\*\*Staff note:\*\* Repeat pattern/);
    assert.match(denial.content, /\*\*Conversation:\*\* this appeal's staff conversation is now closed/);
    assert.deepEqual(denial.allowedMentions, { parse: [] });

    // Row truths: denied with the stored reason; the BAN IS UNTOUCHED.
    const liveAppeal2 = env.db.getAppealById(appeal2.id);
    assert.equal(liveAppeal2.status, "denied");
    assert.equal(liveAppeal2.denial_reason, "Repeat pattern — see B-1.");
    assert.equal(liveAppeal2.decided_by, env.users.adminUser.id);
    assert.equal(env.db.getBanRecord(record2.id).status, "active", "deny never touches the ban");
    assert.equal(env.guild._unbans.length, 1, "no unban beyond cycle 1's clemency");
    assert.ok(
      env.guild._bans.some((b) => String(b.userId) === target.id),
      "the member is still banned",
    );

    // Close→archive invoked through the shared flow (row + channel notice).
    assert.equal(String(env.db.getTicketByChannel(env.communityId, ch2.id).status), "closed");
    assert.match(
      builderJson(ch2.sent.at(-1).embeds[0]).description,
      /\/ticket archive/,
      "the close notice routes staff to /ticket archive",
    );
    assert.equal(auditRowsFor("banAppeals.denied", target.id).length, 1);

    // First decision wins: every re-click on the decided row answers with
    // the LIVE truth and mutates nothing.
    const reDeny = await ticketClick(`ap:deny:${appeal2.id}`);
    assert.match(lastReplyContent(reDeny), /already decided as `denied`/);
    assert.equal(reDeny.modals.length, 0, "a decided row never re-opens the modal");
    const reClemency = await ticketClick(`ap:clemency:${appeal2.id}`, {
      message: headerMessage(appeal2),
    });
    assert.match(lastReplyContent(reClemency), /already decided as `denied`/);
    assert.equal(env.guild._unbans.length, 1, "the losing clemency click unbanned nothing");

    // Re-pressing the ban-DM button on a denied cycle: named refusal.
    const repress = await emitGuildless(
      guildlessPress({ user: target, customId: `${C.APPEAL_PREFIX}${record2.id}`, message: banDm2 }),
    );
    assert.equal(lastReplyContent(repress), C.refusalAlreadyFiled("denied"));
  });

  /* ══ 12. plain-close via ChannelDelete (deliverable 8) ═════════════════════ */

  it("deleting a live appeal's ticket channel plain-closes it: neutral DM, appeal=closed, ban untouched, later traffic silent", async () => {
    const { target, record, appeal, ch } = await openAppealCycle("planclose");
    const dmBefore = target.sends.length;

    await ch.delete();
    env.client.emit(Events.ChannelDelete, ch);
    await drain();

    const row = env.db.getAppealById(appeal.id);
    assert.equal(row.status, "closed");
    assert.equal(row.decided_by, null, "the event path closes without attribution");
    assert.ok(Number(row.decided_at) > 0);

    // The NEUTRAL notice — no decision claimed, the ban stands.
    const dm = target.sends[dmBefore];
    assert.ok(dm, "the user was notified");
    assert.match(dm.content, /\*\*Appeal:\*\* staff ended the conversation/);
    assert.match(dm.content, /without a decision — the ban stands/);
    assert.deepEqual(dm.allowedMentions, { parse: [] });

    // Ban + record untouched (zero ban-side writes of any kind).
    assert.equal(env.db.getBanRecord(record.id).status, "active");
    assert.equal(env.guild._unbans.length, 0);
    assert.equal(env.guild._invites.length, 0, "plain-close mints nothing");
    // The ticket ROW stays open: the channel is unreachable, so the shared
    // close is skipped by design (the appeal row is the decided truth).
    assert.equal(String(env.db.getTicketByChannel(env.communityId, ch.id).status), "open");
    assert.equal(auditRows("banAppeals.closed").filter((r) => r.target_id === String(appeal.id)).length, 1);

    // After the close the ferry is structurally dead: a further DM changes
    // nothing (status guard precedes the flood gate — silent skip).
    const sendsAfter = target.sends.length;
    await emitUserDm(target, { id: "ferry-post-close", content: "anyone there?" });
    assert.equal(target.sends.length, sendsAfter, "no notice after the close");
    assert.equal(env.db.getAppealById(appeal.id).status, "closed");
  });

  /* ══ 13. cross-community belt + unreachable-guild pending truth ════════════ */

  it("an ap: click on another community's appeal refuses with nothing run; filing for an unreachable guild keeps the honest pending truth", async () => {
    // (a) Belt: an OPEN appeal owned by a DIFFERENT community, clicked here.
    const foreignCommunity = require("../../src/platform/community").ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: "guild-it-foreign",
    });
    const foreignTarget = addAppealTarget("foreign");
    const seeded = env.db.createBanRecord({
      communityId: foreignCommunity,
      userId: foreignTarget.id,
      moderatorId: env.users.adminUser.id,
      source: "staff",
      reason: "foreign guild ban",
      bannedAt: Date.now(),
      expiresAt: Date.now() + DAY,
    });
    assert.ok(seeded.ok);
    const filed = env.db.fileAppeal({
      communityId: foreignCommunity,
      banRecordId: seeded.record.id,
      appealStatement: "foreign statement",
    });
    assert.ok(filed.ok);
    env.db.attachAppealTicketChannel(filed.appeal.id, "channel-foreign-ticket");
    env.db.openAppeal(filed.appeal.id);

    const unbansBefore = env.guild._unbans.length;
    const ix = await ticketClick(`ap:clemency:${filed.appeal.id}`);
    assert.match(
      lastReplyContent(ix),
      /That appeal does not belong to this server — nothing was run\./,
    );
    assert.equal(lastReplyEphemeral(ix), true);
    const foreignRow = env.db.getAppealById(filed.appeal.id);
    assert.equal(foreignRow.status, "open", "the belt ran BEFORE any mutation");
    assert.equal(env.guild._unbans.length, unbansBefore, "no unban was attempted");
    assert.equal(foreignTarget.sends.length, 0, "no DM was sent");

    // (b) Pending truth (#730): a record in a REGISTERED community whose
    // guild the bot cannot see — filing saves the appeal but the ticket
    // cannot open, and the user learns the SPECIFIC cause (never "filed").
    const darkCommunity = require("../../src/platform/community").ensureCommunity({
      platform: "discord",
      instanceKey: "discord",
      externalGuildId: "guild-it-unreachable", // no guild double exists
    });
    const darkTarget = addAppealTarget("dark");
    const darkRecord = env.db.createBanRecord({
      communityId: darkCommunity,
      userId: darkTarget.id,
      moderatorId: env.users.adminUser.id,
      source: "staff",
      reason: "ban in an unreachable guild",
      bannedAt: Date.now(),
      expiresAt: null,
    });
    assert.ok(darkRecord.ok);

    const press = await emitGuildless(
      guildlessPress({ user: darkTarget, customId: `${C.APPEAL_PREFIX}${darkRecord.record.id}` }),
    );
    assert.equal(press.modals.length, 1, "the press passed (community rides the record)");
    const submit = await emitGuildless(
      guildlessModalSubmit({
        user: darkTarget,
        customId: `${C.MODAL_APPEAL_PREFIX}${darkRecord.record.id}`,
        statement: "please review, I cannot see the server anymore",
      }),
    );
    assert.match(
      lastReplyContent(submit),
      /\*\*Appeal:\*\* your statement was saved, but the private staff review channel could not be opened/,
      "the honest pending truth, with the specific cause",
    );
    assert.ok(
      /guild-it-unreachable/.test(lastReplyContent(submit)),
      "the cause names the unreachable guild",
    );
    const darkAppeal = env.db.getAppealByBanRecord(darkCommunity, darkRecord.record.id);
    assert.equal(darkAppeal.status, "filed", "the row stays filed (never claimed open)");
    assert.equal(darkAppeal.ticket_channel_id, null, "no ticket reference was stored");
  });

  /* ══ 14. boot catch-up is inert past the cursors ═══════════════════════════ */

  it("runBootCatchUp replays strictly-after the cursors: one open appeal, zero duplicate relays", async () => {
    const { target, appeal, ch } = await openAppealCycle("catchup");

    // One live relay per direction so BOTH cursor pairs are current, and the
    // staff side lives IN the channel history (the catch-up's fetch source).
    await emitUserDm(target, { id: "ferry-in-1", content: "the relayed one" });
    const staffMsg = ch.addMessage({
      id: "msg-staff-1",
      content: "the staff side relayed live",
      author: env.users.adminUser,
    });
    staffMsg.member = { displayName: "Admin One" };
    env.client.emit(Events.MessageCreate, staffMsg);
    await drain();

    const dmCount = target.sends.length;
    const ticketCount = ch.sent.length;

    // The harness never calls the feature's start() hook (index.js owns
    // that), so this is the first possible catch-up run — and the cursors
    // sit exactly on the newest relayed message of each side: every fetched
    // history id sorts BEFORE the cursor ids (dm-* < ferry-in-1,
    // msg-sent-* < msg-staff-1), so the STRICTLY-after filter relays zero.
    const out = await appealsEvents.runBootCatchUp(env.supervisor);
    assert.deepEqual(out, { ran: true, appeals: 1, relayed: 0 });
    assert.equal(target.sends.length, dmCount, "no duplicate DM relays");
    assert.equal(ch.sent.length, ticketCount, "no duplicate ticket relays");
    const row = env.db.getAppealById(appeal.id);
    assert.equal(row.ferry_user_msg_id, "ferry-in-1", "cursors stayed truthful");
    assert.equal(row.ferry_ticket_msg_id, "msg-staff-1");
  });

  /* ══ 15. documented skips (unit-tier coverage pointers) ════════════════════ */

  it.skip("Fluxer NO-PARITY refusal — unreachable through the offline Discord harness", () => {
    // Same posture as test/integration/ban-lifecycle.test.js: the Fluxer
    // slash dispatcher is a separate wire surface no integration test
    // mints. The refusal is pinned against the SAME shipped handler arms by
    // the unit suites (banAppeals commands /banappeals Fluxer-context arm →
    // NOT_ON_FLUXER with zero mutation).
  });

  it.skip("statement cap, hourly flood cap, 8 MB attachment cap, welcome-claim CAS races — unit-tier law", () => {
    // Deliberately NOT integration legs: MAX_APPEAL_STATEMENT /
    // refusalStatementTooLong and MAX_DENIAL_REASON are repository caps the
    // Discord modal clamps first (test/ban-appeals-intake*.test.js); the
    // hourly flood cap and the 8 MB declared-size pre-skip are pure-engine
    // paths (test/ban-appeals-ferry*.test.js drive classifyOutbound +
    // relayUserToTicket with injected deps.now / fake fetches); the
    // claimWelcome-vs-recordWelcomeDmSent CAS domain is pinned by
    // test/ban-records-repo.test.js + the outcomes units. The live 10 s
    // cooldown belt THAT would race wall clocks IS pinned here (relay test).
  });
});
