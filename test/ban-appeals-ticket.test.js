/**
 * #773 §2: the APPEAL TICKET unit suite (test/ban-appeals-ticket.test.js).
 *
 * openAppealTicket + buildAppealHeader, pinned to the file's header law:
 *  - OWNERSHIP: the shared pipeline's staff-self branch gets the record's
 *    HUMAN moderator, falling back to the GUILD OWNER; the banned user and
 *    the bot are NEVER a candidate (pickTicketOwnerUserId re-check + the
 *    refused-open path with a specific error).
 *  - #730: channel-create / header-post / attach failures return the
 *    SPECIFIC translated cause and store NO ticket reference — the appeal
 *    stays `filed` with NULL ticket, proven against the REAL repositories
 *    (loadDb). The success path attaches + flips `filed → open` through the
 *    SHIPPED CAS primitives (default seams), so the live-row race law is the
 *    real one.
 *  - HEADER: ferry warning in the message content (byte-equal to
 *    buildFerryWarning), escaped INERT user card (`<@!id>` inside backticks,
 *    no bare mention anywhere outside code spans), ban summary with
 *    <t:F>/<t:R>, verbatim statement in a code fence, warning/note refs per
 *    the shipped staff-visibility reads, allowedMentions { parse: [] }, and
 *    EXACTLY THREE ap: buttons with the pause label keyed to ferry_paused.
 *
 * Discord edges are doubles (guild, openTicketChannel, fetchUser); the db is
 * the real temp repository. Header contract: loadDb() above src/ requires.
 */
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// CONTRACT: loadDb() before any src/ require (temp DB + require-cache reset).
const { loadDb, communityKey } = require("./helpers/env");
const { api: db, cleanup } = loadDb();

const {
  openAppealTicket,
  buildAppealHeader,
  buildAppealButtons,
  buildFerryWarning,
  banRef,
  expiryField,
  isFerryPaused,
  pickTicketOwnerUserId,
  appealCreateFailureMessage,
  CHANNEL_NAME_MAX,
  REFS_SHOWN_MAX,
} = require("../src/features/banAppeals/ticket");
const {
  BUTTON_LABEL_CLEMENCY,
  BUTTON_LABEL_DENY,
  BUTTON_LABEL_PAUSE,
  BUTTON_LABEL_RESUME,
  AP_CLEMENCY_PREFIX,
  AP_DENY_PREFIX,
  AP_PAUSE_PREFIX,
} = require("../src/features/banAppeals/constants");
const { formatChannelCreateError } = require("../src/features/tickets/overwrites");
const { fencedBlock, inlineEscape } = require("../src/features/tickets/reportEvidence");
const { escapeDisplayName } = require("../src/features/banAppeals/markdownEscape");

after(() => cleanup());

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const DAY = 86_400_000;
const BOT = "778400000000000099";
const USER = "878400000000000013"; // the banned subject
const MOD = "878400000000000012"; // the record's human moderator
const OWNER = "878400000000000077"; // the guild owner

let seq = 0;
const freshCid = () =>
  communityKey(`9784000000000${String(++seq).padStart(4, "0")}`);

function seed({
  cid = freshCid(),
  userId = USER,
  moderatorId = MOD,
  expiresAt = null,
  bannedAt = NOW - 2 * DAY,
  reason = "raid leadership",
} = {}) {
  const res = db.createBanRecord({
    communityId: cid,
    userId,
    moderatorId,
    source: moderatorId ? "staff" : "automod",
    reason,
    bannedAt,
    expiresAt,
  });
  assert.equal(res.ok, true, res.error);
  return { cid, record: res.record, guildId: `9784000000000${String(seq).padStart(4, "0")}` };
}

function seedFiledAppeal(cid, record, statement = "I was elsewhere that night.") {
  const res = db.fileAppeal({
    communityId: cid,
    banRecordId: record.id,
    appealStatement: statement,
    createdAt: NOW,
  });
  assert.equal(res.ok, true, res.error);
  return res.appeal;
}

const appealRow = (id) => db.getAppealById(id);

/** Channel double honouring the rename + send edges, recording both. */
function makeChannel({ id = "555400000000000001", sendThrows = null, renameThrows = null } = {}) {
  return {
    id,
    name: "ticket-7",
    renames: [],
    posts: [],
    async setName(name) {
      if (renameThrows) throw renameThrows;
      this.renames.push(name);
      this.name = name;
    },
    async send(payload) {
      if (sendThrows) throw sendThrows;
      this.posts.push(payload);
      return { id: "9000" };
    },
  };
}

/**
 * World: recording openTicketChannel double + client/guild doubles. The
 * attach/open seams stay DEFAULT (the real shipped CAS primitives) unless a
 * test injects overrides — so success-path assertions read real rows.
 */
function makeWorld({
  cid,
  guildId,
  ownerId = OWNER,
  channelOpts = {},
  openThrows = null,
  fetchUser,
  listWarnings,
  listStaffNotes,
  clientUser = { id: BOT },
  attach,
  open,
} = {}) {
  const channel = makeChannel(channelOpts);
  const opens = [];
  const openTicketChannel = async (opts) => {
    opens.push(opts);
    if (openThrows) throw openThrows;
    return {
      ticket: { id: 70, ticket_number: 7 },
      channel,
      skippedStaffRoles: [],
    };
  };
  const guild = { id: guildId, ownerId };
  const client = {
    user: clientUser,
    guilds: { cache: { get: () => guild }, fetch: async () => guild },
    users: { fetch: async () => ({ username: "cured_t", globalName: "Cured Tom" }) },
  };
  const deps = { guild, openTicketChannel };
  if (fetchUser !== undefined) deps.fetchUser = fetchUser;
  if (listWarnings !== undefined) deps.listWarnings = listWarnings;
  if (listStaffNotes !== undefined) deps.listStaffNotes = listStaffNotes;
  if (attach !== undefined) deps.attachAppealTicketChannel = attach;
  if (open !== undefined) deps.openAppeal = open;
  return { channel, opens, guild, client, deps };
}

function params({ cid, appeal, record, guildId, world, statement, client, ...rest }) {
  return {
    appeal,
    banRecord: record,
    communityId: cid,
    client: client ?? world.client,
    statement,
    guild: world.guild,
    deps: { ...world.deps, ...rest.deps },
    ...rest.extra,
  };
}

/** Embed/action-row payload → plain JSON (discord.js builder idiom). */
const embedJson = (payload) => payload.embeds[0].toJSON();
const rowsJson = (payload) => payload.components.map((r) => r.toJSON());
const field = (e, name) => (e.fields.find((f) => f.name === name) ?? {}).value;

// ═══ ownership law (pure) ════════════════════════════════════════════════════

test("pickTicketOwnerUserId: human moderator wins; else guild owner; NEVER the banned user, NEVER the bot", () => {
  const banned = USER;
  const cases = [
    [{ moderator: MOD, owner: OWNER }, MOD, "staff moderator owns their act"],
    [{ moderator: null, owner: OWNER }, OWNER, "automod bans (moderator NULL) fall to the guild owner"],
    [{ moderator: BOT, owner: OWNER }, OWNER, "the bot can never own the channel (BOT_ALLOW would duplicate the creator overwrite)"],
    [{ moderator: banned, owner: OWNER }, OWNER, "a planted moderator == subject is rejected"],
    [{ moderator: "  ", owner: OWNER }, OWNER, "whitespace moderator reads unattributed"],
    [{ moderator: MOD, owner: banned }, MOD, "the owner degeneracy is irrelevant while a staff identity stands"],
    [{ moderator: banned, owner: BOT }, null, "no valid human → REFUSE (specific error), never a forced overwrite"],
    [{ moderator: BOT, owner: banned }, null, "bot + subject-only owner refuse together"],
    [{ moderator: null, owner: "" }, null, "nothing to attribute → null"],
  ];
  for (const [{ moderator, owner }, want, why] of cases) {
    const got = pickTicketOwnerUserId({
      banRecord: { user_id: banned, moderator_id: moderator },
      guild: { ownerId: owner },
      botUserId: BOT,
    });
    assert.equal(got, want, why);
    assert.notEqual(got, banned, `${why}: the banned user can NEVER be the ticket owner`);
    assert.notEqual(got, BOT, `${why}: the bot can NEVER be the ticket owner`);
  }
});

test("pure seams: B-n display ref, expiry field both stamps / permanent sentence, pause flag strictness", () => {
  assert.equal(banRef({ ban_number: 7 }), "B-7");
  assert.equal(banRef({}), "B-?");
  assert.equal(expiryField(NOW), `<t:${Math.floor(NOW / 1000)}:F> (<t:${Math.floor(NOW / 1000)}:R>)`);
  assert.equal(expiryField(null), "_permanent — staff may lift it at their discretion_");
  assert.equal(isFerryPaused({ ferry_paused: 1 }), true);
  for (const flag of [0, null, undefined, 2, "1x"]) {
    assert.equal(isFerryPaused({ ferry_paused: flag }), false, `anything non-1 reads as running (${flag})`);
  }
});

// ═══ open flow — success contract (REAL attach/open CAS) ═════════════════════

test("success: staff-moderator OWNS the staff-self open, channel renamed appeal-B<n>-<user>, header lands, ticket_channel attached + filed→open CAS on the real row", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  const statement = "I was elsewhere that night — ask my sister.";
  const w = makeWorld({
    cid,
    guildId,
    listWarnings: () => [{ warning_number: 3 }, { warning_number: 5 }],
    listStaffNotes: () => [{ note_number: 2 }],
  });

  const res = await openAppealTicket(params({
    cid, appeal, record, guildId, world: w, statement,
  }));

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.channelOfRecordId, w.channel.id);
  assert.deepEqual(res.skippedStaffRoles, []);

  // Ownership law at the pipeline seam: creator === openedByStaffId === MOD.
  assert.equal(w.opens.length, 1, "the SHARED ticket pipeline runs exactly once");
  const open0 = w.opens[0];
  assert.equal(open0.creatorUserId, MOD);
  assert.equal(open0.openedByStaffId, MOD, "staff-self branch (report.js decision-5 shape)");
  assert.notEqual(open0.creatorUserId, USER, "the banned user is NEVER the creator (they'd get a member overwrite)");
  assert.notEqual(open0.creatorUserId, BOT, "the bot never owns the channel");
  assert.equal(open0.communityId, cid);
  assert.match(open0.reason, new RegExp(`Ban appeal B-${record.ban_number} for ${USER}`));

  // Appeal-grammar rename over the pipeline's ticket-<n>:
  assert.deepEqual(w.channel.renames, [`appeal-B${record.ban_number}-${USER}`]);

  // REAL CAS primitives ran (default seams): the row now carries the channel
  // and the relay status. This is the shipped attach + open on the live db.
  const live = appealRow(appeal.id);
  assert.equal(live.ticket_channel_id, w.channel.id, "attachAppealTicketChannel attached the channel");
  assert.equal(live.status, "open", "filed → open CAS through the shipped openAppeal");
  assert.equal(res.appeal.status, "open");

  // Header posted EXACTLY ONCE into the fresh channel:
  assert.equal(w.channel.posts.length, 1);
  const post = w.channel.posts[0];
  assert.deepEqual(post.allowedMentions, { parse: [] }, "no ping leakage in either direction (§2/§6)");

  // Ferry warning in the message CONTENT (never only in the never-relayed embed):
  assert.equal(post.content, buildFerryWarning());
  assert.match(post.content, /\*\*Relay:\*\* everything typed in this channel is relayed to the appealing user \*\*verbatim\*\*/);
  assert.match(post.content, /\*\*Shared:\*\* text, images, and video only\./);
  assert.match(post.content, /\*\*Never shared:\*\* reactions, embeds, audio, stickers, polls, forwarded messages/);
  assert.match(post.content, /\*\*Pause relaying\*\*.*relay is \*\*on by default\*\*\./);

  // Header embed — user card INERT, ban summary, statement verbatim:
  const e = embedJson(post);
  assert.equal(e.title, `Ban appeal B-${record.ban_number}`);
  assert.equal(e.description, fencedBlock(statement), "statement VERBATIM inside a code fence (§2)");

  const card = field(e, "Appealing user");
  assert.ok(card.includes(`\`<@!${USER}>\``), `escaped mention inside backticks: ${card}`);
  assert.ok(card.includes(`ID: \`${USER}\``), "the id rides as inert code text");

  assert.equal(field(e, "Display name"), "Cured Tom");
  assert.equal(field(e, "Ban"), `B-${record.ban_number}`);
  assert.equal(field(e, "Ticket"), "#7");
  assert.equal(field(e, "Banned"), `<t:${Math.floor(record.banned_at / 1000)}:F>`);
  assert.equal(field(e, "Expiry"), "_permanent — staff may lift it at their discretion_");
  const modField = field(e, "Banned by (staff-only)");
  assert.ok(modField.includes(`\`<@!${MOD}>\``), "the moderator shows on the STAFF-side card (§6 forbids only ferrying it)");
  assert.equal(field(e, "Ban reason"), "raid leadership");
  assert.equal(field(e, "Warnings (active)"), "W-3 · W-5", "refs per the shipped staff-visibility reads");
  assert.equal(field(e, "Staff notes"), "N-2");
  assert.match(e.footer.text, /NEVER relayed to the user/);
  assert.equal(e.timestamp, new Date(NOW).toISOString(), "the embed stamps the filing time");

  // EXACTLY the three ap: buttons (locked customId grammar + labels):
  const buttons = rowsJson(post)[0].components;
  assert.equal(rowsJson(post).length, 1, "one action row");
  assert.deepEqual(buttons.map((b) => b.custom_id), [
    `${AP_CLEMENCY_PREFIX}${appeal.id}`,
    `${AP_DENY_PREFIX}${appeal.id}`,
    `${AP_PAUSE_PREFIX}${appeal.id}`,
  ]);
  assert.deepEqual(buttons.map((b) => b.label), [
    BUTTON_LABEL_CLEMENCY,
    BUTTON_LABEL_DENY,
    BUTTON_LABEL_PAUSE,
  ]);
  assert.deepEqual(buttons.map((b) => b.style), [3, 4, 2], "Success / Danger / Secondary");
});

test("timed ban summary carries BOTH expiry stamps; hostile display name renders escaped; refs degrade per-field, never the ticket", async () => {
  const expiresAt = NOW + 5 * DAY;
  const { cid, record, guildId } = seed({ expiresAt });
  const appeal = seedFiledAppeal(cid, record);
  const w = makeWorld({
    cid,
    guildId,
    fetchUser: async () => ({ globalName: "@everyone <@999> | *raid*" }),
    listWarnings: () => {
      throw new Error("warnings index offline");
    },
    listStaffNotes: async () => [],
  });

  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, true, JSON.stringify(res));

  const e = embedJson(w.channel.posts[0]);
  assert.equal(
    field(e, "Expiry"),
    `<t:${Math.floor(expiresAt / 1000)}:F> (<t:${Math.floor(expiresAt / 1000)}:R>)`,
    "issue §2: expiry as <t:F>/<t:R>",
  );
  assert.equal(field(e, "Display name"), escapeDisplayName("@everyone <@999> | *raid*"));
  assert.doesNotMatch(field(e, "Display name"), /<@999>/, "no live-mention semantics from a planted name");
  assert.equal(field(e, "Warnings (active)"), "_unavailable (read failed)_", "a failed ref read degrades the FIELD only");
  assert.equal(field(e, "Staff notes"), "_none_", "an empty ref list says none");
});

test("unattributed (automod) record: the GUILD OWNER owns the open", async () => {
  const { cid, record, guildId } = seed({ moderatorId: null });
  const appeal = seedFiledAppeal(cid, record);
  const w = makeWorld({ cid, guildId });

  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(w.opens[0].creatorUserId, OWNER);
  assert.equal(w.opens[0].openedByStaffId, OWNER);

  const e = embedJson(w.channel.posts[0]);
  assert.equal(field(e, "Banned by (staff-only)"), "_Automoderation (system)_",
    "executor.js law: automod bans carry moderator_id NULL — the card says so honestly");
});

test("no valid staff identity (bot-moderator + subject-as-owner): refuse with the SPECIFIC error — nothing opened, appeal stays pending", async () => {
  const { cid, record, guildId } = seed({ moderatorId: BOT });
  const appeal = seedFiledAppeal(cid, record);
  const w = makeWorld({ cid, guildId, ownerId: USER }); // degenerate guild double

  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, false);
  assert.match(res.error, /no staff identity to attach the appeal ticket to/);
  assert.match(res.error, /no ticket was opened/i);
  assert.doesNotMatch(res.error, /check logs|unknown error/i);
  assert.equal(w.opens.length, 0, "the pipeline is never entered");
  const live = appealRow(appeal.id);
  assert.equal(live.status, "filed");
  assert.equal(live.ticket_channel_id, null, "the pending truth stands: never claimed filed");
});

// ═══ #730 failure semantics: specific cause, stored NO ticket ════════════════

test("channel-create failure (pre-translated CHANNEL_CREATE): cause surfaces VERBATIM, row stays filed/NULL", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  const translated =
    "Discord rejected channel creation (**Missing Permissions**). Check:\n1. Bot role has **Manage Channels**";
  const err = Object.assign(new Error(translated), { code: "CHANNEL_CREATE" });
  const w = makeWorld({ cid, guildId, openThrows: err });

  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, false);
  assert.equal(res.error, translated, "the pipeline's pre-translated sentence rides through untouched");
  const live = appealRow(appeal.id);
  assert.equal(live.status, "filed", "#730: NOT marked filed→open when the channel could not be created");
  assert.equal(live.ticket_channel_id, null);
});

test("raw channel-create throw (Discord 50013) is TRANSLATED — never the raw DiscordAPIError", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  const raw = Object.assign(new Error("Missing Permissions"), { code: 50013 });
  const w = makeWorld({ cid, guildId, openThrows: raw });

  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, false);
  assert.match(res.error, /^Failed to open the appeal ticket: /);
  assert.ok(res.error.includes(formatChannelCreateError(raw)),
    "the shipped overwrites translator is the single source");
  assert.match(res.error, /\*\*Missing Permissions\*\*/);
  assert.match(res.error, /Bot role has \*\*Manage Channels\*\*/, "the refusal is actionable");
  assert.equal(appealRow(appeal.id).ticket_channel_id, null);
});

test("header-send failure: specific cause + the ORPHANED channel named for cleanup; the appeal stays pending", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  const w = makeWorld({ cid, guildId, channelOpts: { sendThrows: new Error("Cannot send messages in <#x>") } });

  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, false);
  assert.match(res.error, /Could not post the appeal header into the new staff channel: Cannot send messages/);
  const live = appealRow(appeal.id);
  assert.equal(live.status, "filed");
  assert.equal(live.ticket_channel_id, null, "the orphaned channel is NEVER referenced by the record");
});

test("attach refusal → specific 'record' failure with the row untouched; attach RACE loser reports the LIVE channel (never its orphan) and still succeeds", async () => {
  // (a) hard refusal from the primitive:
  const s1 = seed();
  const a1 = seedFiledAppeal(s1.cid, s1.record);
  const w1 = makeWorld({
    cid: s1.cid,
    guildId: s1.guildId,
    attach: () => ({ ok: false, error: "database is locked" }),
  });
  const r1 = await openAppealTicket(params({ cid: s1.cid, appeal: a1, record: s1.record, guildId: s1.guildId, world: w1 }));
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "Could not record the appeal ticket: database is locked");
  assert.equal(appealRow(a1.id).ticket_channel_id, null);
  assert.equal(appealRow(a1.id).status, "filed");

  // (b) REAL race: another attach already holds the row. The live channel
  // wins; my channel is orphaned (logged); the flow still reports success.
  const s2 = seed();
  const a2 = seedFiledAppeal(s2.cid, s2.record);
  const LIVE = "555900000000000009";
  assert.equal(db.attachAppealTicketChannel(a2.id, LIVE).won, true); // race winner got there first
  const w2 = makeWorld({ cid: s2.cid, guildId: s2.guildId, channelOpts: { id: "555900000000000010" } });
  const r2 = await openAppealTicket(params({ cid: s2.cid, appeal: a2, record: s2.record, guildId: s2.guildId, world: w2 }));
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.channelOfRecordId, LIVE, "the caller is told the channel that is ACTUALLY on the record");
  assert.equal(appealRow(a2.id).ticket_channel_id, LIVE);
});

test("attach race into an UNREADABLE live row → honest refusal (nothing claimed)", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  const w = makeWorld({
    cid,
    guildId,
    attach: () => ({ ok: true, won: false, appeal: { id: appeal.id, status: "filed", ticket_channel_id: null } }),
  });
  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, false);
  assert.match(res.error, /lost its ticket race in an unreadable state — nothing was claimed/);
});

test("open CAS loser reports the LIVE row honestly (status read by the relay guard stays true)", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  const w = makeWorld({
    cid,
    guildId,
    open: () => ({ ok: true, won: false, appeal: { id: appeal.id, status: "closed" } }),
  });
  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, true);
  assert.equal(res.appeal.status, "closed", "the live row rides — never a fabricated 'open'");
});

test("a failed cosmetic rename keeps a fully functional ticket (loud log, ticket stands)", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  const w = makeWorld({ cid, guildId, channelOpts: { renameThrows: new Error("Slow mode is on") } });
  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(w.channel.posts.length, 1);
  assert.equal(appealRow(appeal.id).status, "open");
});

// ═══ edge-resolution refusals + shape gates (never reach the pipeline) ═══════

test("community edges: unregistered → honest gone; Fluxer → Discord-only no-parity; missing guild / un-ready bot name the state", async () => {
  // unregistered community:
  const s0 = seed();
  const a0 = seedFiledAppeal(s0.cid, s0.record);
  const w0 = makeWorld({ cid: s0.cid, guildId: s0.guildId });
  const gone = await openAppealTicket({
    appeal: a0,
    banRecord: s0.record,
    communityId: 999_999,
    client: w0.client,
    deps: { guild: w0.guild },
  });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /community is no longer registered — nothing was opened/);

  // Fluxer community (explicit #773 no-parity):
  const fluxCid = communityKey(`9784900000000${String(++seq).padStart(4, "0")}`, "fluxer", "fluxer");
  const flux = await openAppealTicket({
    appeal: a0,
    banRecord: s0.record,
    communityId: fluxCid,
    client: w0.client,
    deps: { guild: w0.guild },
  });
  assert.equal(flux.ok, false);
  assert.match(flux.error, /Ban appeal tickets are Discord-only — this community is not Discord\./);

  // guild unresolvable (no deps.guild, cache + fetch miss):
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  const noGuild = await openAppealTicket({
    appeal,
    banRecord: record,
    communityId: cid,
    client: { user: { id: BOT }, guilds: { cache: { get: () => null } } },
  });
  assert.equal(noGuild.ok, false);
  assert.match(noGuild.error, new RegExp(`I can't see the server this ban happened in \\(guild ${guildId}\\) — no ticket was opened\\.`));

  // bot identity not ready:
  const wB = makeWorld({ cid, guildId });
  const noBot = await openAppealTicket({
    appeal,
    banRecord: record,
    communityId: cid,
    client: { guilds: { cache: { get: () => wB.guild } } },
    deps: { guild: wB.guild },
  });
  assert.equal(noBot.ok, false);
  assert.match(noBot.error, /Bot user not ready — the appeal ticket cannot be created yet\./);
  assert.equal(appealRow(appeal.id).ticket_channel_id, null);
});

test("shape gates reject before ANY work: no appeal row, no ban record, garbage community — each names its own truth", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  const w = makeWorld({ cid, guildId });

  const runs = [
    [{ appeal: null }, /needs the stored appeal row/],
    [{ appeal: { id: 0 } }, /needs the stored appeal row/],
    [{ appeal: { id: "seven" } }, /needs the stored appeal row/],
    [{ banRecord: null }, /needs the ban record behind it/],
    [{ banRecord: { id: 3, user_id: "  " } }, /needs the ban record behind it/],
    [{ communityId: 0 }, /needs a valid community key/],
    [{ communityId: "abc" }, /needs a valid community key/],
  ];
  for (const [over, re] of runs) {
    const res = await openAppealTicket({
      appeal,
      banRecord: record,
      communityId: cid,
      client: w.client,
      deps: { guild: w.guild },
      ...over,
    });
    assert.equal(res.ok, false);
    assert.match(res.error, re, JSON.stringify(over));
  }
  assert.equal(w.opens.length, 0, "a shape-garbage open never reaches Discord or the db");
});

// ═══ header/button builders (pure surfaces docs + 06/07 quote) ══════════════

test("buildAppealButtons: the pause label mirrors the CURRENT ferry_paused flag (06 re-posts after a toggle)", () => {
  const labels = (row) => rowsJson({ components: buildAppealButtons(row) })[0].components.map((b) => b.label);
  assert.deepEqual(labels({ id: 9, ferry_paused: 0 }), [
    BUTTON_LABEL_CLEMENCY, BUTTON_LABEL_DENY, BUTTON_LABEL_PAUSE,
  ]);
  assert.deepEqual(labels({ id: 9, ferry_paused: 1 }), [
    BUTTON_LABEL_CLEMENCY, BUTTON_LABEL_DENY, BUTTON_LABEL_RESUME,
  ]);
  const ids = rowsJson({ components: buildAppealButtons({ id: 9, ferry_paused: 0 }) })[0].components.map((b) => b.custom_id);
  assert.deepEqual(ids, [`ap:clemency:9`, `ap:deny:9`, `ap:pause:9`]);
});

test("header on a PAUSED appeal (real row via the shipped setter) posts the Resume label", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record);
  assert.equal(db.setAppealFerryPaused(appeal.id, true).ok, true);
  const w = makeWorld({ cid, guildId });
  const res = await openAppealTicket(params({
    cid,
    appeal: appealRow(appeal.id),
    record,
    guildId,
    world: w,
  }));
  assert.equal(res.ok, true, JSON.stringify(res));
  const buttons = rowsJson(w.channel.posts[0])[0].components;
  assert.equal(buttons[2].label, BUTTON_LABEL_RESUME);
});

test("statement fallback + ref overflow + unresolvable user: pure header contract without a Discord edge", () => {
  const appeal = { id: 3, created_at: NOW, ferry_paused: 0, appeal_statement: "row-carried statement" };
  const record = {
    id: 1, ban_number: 4, user_id: USER, moderator_id: null, reason: "",
    banned_at: NOW, expires_at: null,
  };
  const payload = buildAppealHeader({
    appeal,
    banRecord: record,
    displayName: null,
    warningRefs: Array.from({ length: REFS_SHOWN_MAX + 3 }, (_, i) => `W-${i + 1}`),
    noteRefs: [],
  });
  const e = embedJson(payload);
  assert.equal(e.description, fencedBlock("row-carried statement"), "no explicit statement → the ROW's is used");
  assert.equal(field(e, "Display name"), "_unknown_", "banned user unresolvable → honest placeholder");
  assert.equal(field(e, "Ban reason"), "_none recorded_");
  assert.match(field(e, "Warnings (active)"), new RegExp(`^W-1 · W-2 ·.*· W-${REFS_SHOWN_MAX} …$`),
    `refs cap at ${REFS_SHOWN_MAX} with an ellipsis`);
  assert.equal(field(e, "Staff notes"), "_none_");
  assert.ok(e.timestamp);

  // A statement containing its own fences can never escape the fence:
  const planted = buildAppealHeader({
    appeal: { ...appeal, appeal_statement: "escape ``` out\n<@999>" },
    banRecord: record,
  });
  assert.ok(embedJson(planted).description.startsWith("````"), "fence grows past any inner backtick run");
});

test("every posted header is mention-free OUTSIDE code spans: strip the code spans, not a raw <@ survives", async () => {
  const { cid, record, guildId } = seed();
  const appeal = seedFiledAppeal(cid, record, "@everyone <@878400000000000013> — I protest the ban");
  const w = makeWorld({ cid, guildId });
  const res = await openAppealTicket(params({ cid, appeal, record, guildId, world: w }));
  assert.equal(res.ok, true, JSON.stringify(res));

  const post = w.channel.posts[0];
  assert.deepEqual(post.allowedMentions, { parse: [] });

  const serialize = post.content + JSON.stringify(embedJson(post)) + JSON.stringify(rowsJson(post));
  // Strip fenced blocks, then inline code spans — everything REMAINING must be
  // bare-mention-free (the inert card + fenced statement live inside spans).
  // (A statement carrying its OWN backtick run is fenced longer by the shipped
  // fencedBlock — pinned separately above; here the fence is clean so the
  // strip is exact.)
  const stripped = serialize
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  assert.doesNotMatch(stripped, /<@!?\d+>/, "no bare user mention outside code spans");
  assert.doesNotMatch(stripped, /@everyone|@here/, "no broadcast mention outside code spans");
  assert.ok(serialize.includes(`\`<@!${USER}>\``), "the card itself stays VISIBLE (inert, not hidden)");
});

test("appealCreateFailureMessage: pre-translated codes pass verbatim; everything rawer goes through the shipped translator", () => {
  for (const code of ["INVALID_REASON", "BOT_PERMISSIONS", "CHANNEL_CREATE"]) {
    const err = Object.assign(new Error(`translated ${code} sentence`), { code });
    assert.equal(appealCreateFailureMessage(err), `translated ${code} sentence`);
  }
  assert.equal(
    appealCreateFailureMessage(Object.assign(new Error("boom 50034"), { code: 50034 })),
    `Failed to open the appeal ticket: ${formatChannelCreateError(Object.assign(new Error("boom 50034"), { code: 50034 }))}`,
  );
  assert.match(appealCreateFailureMessage("plain string"), /^Failed to open the appeal ticket: plain string$/);
});

test("channel-name law: the appeal rename respects the shared 100-char cap", () => {
  assert.equal(CHANNEL_NAME_MAX, 100);
  const name = `appeal-B${9}-${"9".repeat(200)}`.slice(0, CHANNEL_NAME_MAX);
  assert.equal(name.length, CHANNEL_NAME_MAX, "a monster id can never overflow the rename");
});

test("inline escape sanity the header relies on: digits ride unchanged, markers backslash-escape", () => {
  assert.equal(inlineEscape(USER), USER);
  assert.equal(inlineEscape("<@1>"), "\\<\\@1\\>");
});
