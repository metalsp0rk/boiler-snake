/**
 * Unit tests for the context-menu report INVOKE handlers (#745 subtask 05):
 * src/features/tickets/report.js — handleReportMessage / handleReportUser.
 *
 * House style follows the gork command tests: real db facade on a temp
 * SQLite via loadDb(), real requireStaff gating (ManageGuild member leg AND
 * a seeded staff_roles leg), and the process-wide pendingReports singleton
 * inspected through its own public take/count/reset seams.
 *
 * The shared ./helpers/discord factory covers chat/modal/button interactions
 * only, so this file owns a local context-menu interaction mock. It records
 * the OPTION NAMES the handler resolves — the tests pin those to the
 * lowercase literals ("message"/"user") that discord.js' own
 * targetMessage/targetUser getters pass to the resolver (verified in
 * node_modules: MessageContextMenuCommandInteraction.js /
 * UserContextMenuCommandInteraction.js).
 *
 * Covers (acceptance): non-staff denial without modal or snapshot; message
 * happy path (showModal once, tk:rep:m:<32-hex>, full snapshot incl.
 * attachment URLs); user happy path (tk:rep:u:<32-hex>, subjectUserId);
 * bot-target and self-report rejections BEFORE any modal; store-refused put
 * → specific reply and NEVER a dead-token modal; handler throw → ids log +
 * safeErrorReply; showModal rejection → cause-logged, replied.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb, communityKey } = require("./helpers/env");

const {
  createGuild,
  createClient,
  createTextChannel,
  createUser,
  createMember,
  lastReplyContent,
  lastReplyEphemeral,
  PermissionFlagsBits,
} = require("./helpers/discord");

let api;
let cleanup;
let report;
let pendingReports;
let constants;
let reportModals;

before(() => {
  // CONTRACT: loadDb() runs before every `src/` require in this file — the
  // report handler pulls in the db facade through core/permissions, so the
  // requires below load only after DB_PATH points at a fresh temp SQLite.
  ({ api, cleanup } = loadDb());
  report = require("../src/features/tickets/report.js");
  pendingReports = require("../src/features/tickets/pendingReports.js");
  constants = require("../src/features/tickets/constants.js");
  reportModals = require("../src/features/tickets/reportModals.js");
});

after(() => cleanup?.());

beforeEach(() => {
  // The invoke handlers put into the PROCESS-WIDE store; every test starts
  // and is asserted from an empty one.
  pendingReports.resetPendingReportsForTests();
});

// ---------- harness ----------

/**
 * Context-menu invocation mock (MessageContextMenuCommandInteraction /
 * UserContextMenuCommandInteraction shape). `resolved` records every option
 * name the handler asks the resolver for, so tests can pin the exact
 * lowercase target names. `failShowModal` / `throwOnResolve` are the
 * failure-injection seams.
 *
 * @param {object} opts
 * @param {"message"|"user"} opts.kind
 * @param {object|null} opts.guild
 * @param {object} opts.user
 * @param {object} [opts.member]
 * @param {boolean} [opts.admin]
 * @param {object} [opts.targetMessage]
 * @param {object} [opts.targetUser]
 * @param {boolean} [opts.failShowModal]
 * @param {boolean} [opts.throwOnResolve]
 */
function createContextMenuInteraction(opts) {
  const guild = opts.guild ?? null;
  const user = opts.user;
  const member = opts.member ?? null;
  const replies = [];
  const modals = [];
  const resolved = [];
  const isMessage = opts.kind === "message";

  let admin =
    opts.admin != null
      ? opts.admin
      : member
        ? member.permissions.has(PermissionFlagsBits.ManageGuild)
        : false;

  const memberPermissions = {
    has: (flag) => {
      if (admin && String(flag) === String(PermissionFlagsBits.ManageGuild)) {
        return true;
      }
      if (member?.permissions) return member.permissions.has(flag);
      return false;
    },
  };

  const interaction = {
    commandName: opts.commandName ?? (isMessage ? "Report Post" : "Report User"),
    guild,
    guildId: guild?.id ?? null,
    channelId: opts.channelId ?? guild?.channels?.cache?.keys?.().next()?.value ?? null,
    channel: opts.channel ?? null,
    client: opts.client ?? null,
    user,
    member,
    memberPermissions,
    replied: false,
    deferred: false,
    replies,
    modals,
    resolved,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isModalSubmit: () => false,
    isButton: () => false,
    isMessageContextMenuCommand: () => isMessage,
    isUserContextMenuCommand: () => !isMessage,
    options: {
      getMessage: (name) => {
        resolved.push(name);
        if (opts.throwOnResolve) throw new Error("resolver exploded");
        return opts.targetMessage ?? null;
      },
      getUser: (name) => {
        resolved.push(name);
        if (opts.throwOnResolve) throw new Error("resolver exploded");
        return opts.targetUser ?? null;
      },
    },
    reply: async (payload) => {
      if (interaction.replied || interaction.deferred) {
        const err = new Error("InteractionAlreadyReplied");
        err.code = "InteractionAlreadyReplied";
        throw err;
      }
      interaction.replied = true;
      replies.push(payload);
      return payload;
    },
    followUp: async (payload) => {
      replies.push(payload);
      return payload;
    },
    deferReply: async () => {
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      if (!interaction.replied && !interaction.deferred) {
        const err = new Error("DiscordAPIError[40060]: not acknowledged");
        err.code = 40060;
        throw err;
      }
      replies.push({ ...payload, _edited: true });
      return payload;
    },
    showModal: async (modal) => {
      if (opts.failShowModal) {
        throw new Error("Interaction expired");
      }
      modals.push(modal);
      interaction.replied = true;
      return modal;
    },
    setAdmin: (value) => {
      admin = value;
    },
  };
  return interaction;
}

/** ModalBuilder → plain REST JSON (showModal receives builders; the wire form is JSON). */
function modalJson(modal) {
  return typeof modal?.toJSON === "function" ? modal.toJSON() : modal;
}

/** Swap console.error for a capture buffer; returns lines + restore(). */
function captureConsoleError() {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

/**
 * Fresh guild with a source channel, an admin member (ManageGuild leg of
 * requireStaff) and a plain member (denied).
 */
function makeEnv(guildId) {
  const guild = createGuild({ id: guildId });
  const sourceChannel = createTextChannel({
    id: `src-${guildId}`,
    guild,
    name: "general",
  });
  guild.addChannel(sourceChannel);
  const client = createClient();
  client.addGuild(guild);

  const adminUser = createUser({ id: `admin-${guildId}` });
  const adminMember = createMember({ guild, user: adminUser, admin: true });
  guild.addMember(adminMember);

  const plainUser = createUser({ id: `plain-${guildId}` });
  const plainMember = createMember({ guild, user: plainUser });
  guild.addMember(plainMember);

  return { guild, sourceChannel, client, adminUser, adminMember, plainUser, plainMember };
}

/** Reported message with one attachment, one embed URL, one sticker. */
function makeReportedMessage(env, overrides = {}) {
  const msg = env.sourceChannel.addMessage({
    id: overrides.id || "msg-reported",
    content: overrides.content ?? "come join my server, free boosts",
    author: overrides.author || {
      id: "author-spam",
      username: "spammer",
      bot: overrides.botAuthor ?? false,
    },
    embeds: overrides.embeds ?? [{ url: "https://spam.example/boost" }],
    attachments: overrides.attachments ?? [
      {
        id: "att-1",
        name: "hook.png",
        url: "https://cdn.discord.example/attachments/att-1/hook.png",
        size: 20480,
        contentType: "image/png",
      },
    ],
  });
  msg.stickers = overrides.stickers ?? [{ id: "stick-1", name: "wave" }];
  return msg;
}

// ---------- staff gate ----------

describe("report invoke — staff gate (handlers are the security source of truth)", () => {
  it("non-staff Report Post: standard ephemeral denial, no modal, NO snapshot", async () => {
    const env = makeEnv("7001");
    const msg = makeReportedMessage(env);
    const interaction = createContextMenuInteraction({
      kind: "message",
      guild: env.guild,
      user: env.plainUser,
      member: env.plainMember,
      targetMessage: msg,
    });

    await report.handleReportMessage(interaction, {});

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /don't have permission/);
    assert.ok(lastReplyEphemeral(interaction), "denial must be ephemeral");
    assert.deepEqual(interaction.modals, [], "no modal for non-staff");
    assert.equal(pendingReports.pendingReportCountForTests(), 0, "no snapshot stored");
    // Gate ran FIRST: the resolver for the target was never touched.
    assert.deepEqual(interaction.resolved, []);
  });

  it("non-staff Report User: standard ephemeral denial, no modal, NO snapshot", async () => {
    const env = makeEnv("7002");
    const target = createUser({ id: "target-7002" });
    const interaction = createContextMenuInteraction({
      kind: "user",
      guild: env.guild,
      user: env.plainUser,
      member: env.plainMember,
      targetUser: target,
    });

    await report.handleReportUser(interaction, {});

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /don't have permission/);
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(interaction.modals, []);
    assert.equal(pendingReports.pendingReportCountForTests(), 0);
    assert.deepEqual(interaction.resolved, []);
  });

  it("staff via a seeded staff_roles row (no ManageGuild bits) is served", async () => {
    const env = makeEnv("7003");
    const communityId = communityKey("7003");
    api.addStaffRole(communityId, "role-mod-7003", "junior");
    const modUser = createUser({ id: `mod-${"7003"}` });
    const modMember = createMember({
      guild: env.guild,
      user: modUser,
      roleIds: ["role-mod-7003"],
    });
    env.guild.addMember(modMember);

    const interaction = createContextMenuInteraction({
      kind: "user",
      guild: env.guild,
      user: modUser,
      member: modMember,
      targetUser: createUser({ id: "target-7003" }),
    });

    await report.handleReportUser(interaction, {});

    assert.equal(interaction.modals.length, 1, "junior staff_roles passes the gate");
    assert.deepEqual(interaction.replies, []);
  });
});

// ---------- message variant ----------

describe("report invoke — handleReportMessage (Report Post)", () => {
  it("staff invoke: showModal once, tk:rep:m:<32-hex>, full invoke-time snapshot", async () => {
    const env = makeEnv("7010");
    const msg = makeReportedMessage(env);
    const interaction = createContextMenuInteraction({
      kind: "message",
      guild: env.guild,
      user: env.adminUser,
      member: env.adminMember,
      channel: env.sourceChannel,
      channelId: env.sourceChannel.id,
      client: env.client,
      targetMessage: msg,
    });

    await report.handleReportMessage(interaction, {});

    // One modal, straight from the invoke — no intermediate anything.
    assert.equal(interaction.modals.length, 1);
    assert.deepEqual(interaction.replies, []);

    // The resolver contract: discord.js' own targetMessage getter passes the
    // literal lowercase name; the handler must match it (verified in
    // node_modules, not memory).
    assert.deepEqual(interaction.resolved, ["message"]);

    const json = modalJson(interaction.modals[0]);
    const prefix = constants.MODAL_REPORT_MESSAGE_PREFIX;
    assert.ok(
      json.custom_id.startsWith(prefix),
      `customId ${json.custom_id} must start with ${prefix}`,
    );
    const token = json.custom_id.slice(prefix.length);
    assert.match(token, /^[0-9a-f]{32}$/, "token is the 32-hex pendingReports mint");

    // The snapshot the modal-submit pipeline (subtasks 06/08) reads back.
    const snap = pendingReports.takeReport(token);
    assert.ok(snap, "token resolves to the stored snapshot");
    assert.equal(snap.kind, "message");
    assert.equal(snap.guildId, "7010");
    assert.equal(snap.reporterUserId, env.adminUser.id);
    assert.equal(snap.messageId, "msg-reported");
    assert.equal(snap.channelId, env.sourceChannel.id);
    assert.equal(snap.channelName, "general");
    assert.equal(snap.authorId, "author-spam");
    assert.equal(snap.subjectUserId, "author-spam", "message variant subjects the author");
    assert.equal(snap.content, "come join my server, free boosts");
    assert.equal(snap.attachments.length, 1);
    assert.equal(
      snap.attachments[0].url,
      "https://cdn.discord.example/attachments/att-1/hook.png",
    );
    assert.equal(snap.attachments[0].name, "hook.png");
    assert.equal(snap.attachments[0].size, 20480);
    assert.equal(snap.attachments[0].contentType, "image/png");
    assert.deepEqual(snap.embedUrls, ["https://spam.example/boost"]);
    assert.deepEqual(snap.stickers, ["wave"]);
  });

  it("unresolvable target message: specific ephemeral, no modal, no snapshot", async () => {
    const env = makeEnv("7011");
    const interaction = createContextMenuInteraction({
      kind: "message",
      guild: env.guild,
      user: env.adminUser,
      member: env.adminMember,
      targetMessage: null,
    });

    await report.handleReportMessage(interaction, {});

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /could not resolve the reported message/i);
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(interaction.modals, []);
    assert.equal(pendingReports.pendingReportCountForTests(), 0);
  });

  it("store-refused put (null token): specific reply, NEVER showModal with a dead token", async () => {
    // A guildless invoke is the natural null-guildId path (the router
    // normally drops these first — the handler still refuses to show a modal
    // whose token the store never kept).
    const env = makeEnv("7012");
    const msg = makeReportedMessage(env);
    msg.guild = null;
    msg.guildId = null;
    const interaction = createContextMenuInteraction({
      kind: "message",
      guild: null,
      user: env.adminUser,
      admin: true,
      targetMessage: msg,
    });

    await report.handleReportMessage(interaction, {});

    assert.deepEqual(interaction.modals, [], "no modal without a stored token");
    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /could not start that report/i);
    assert.match(lastReplyContent(interaction), /run the command again/i);
    assert.ok(lastReplyEphemeral(interaction));
    assert.equal(pendingReports.pendingReportCountForTests(), 0);
  });
});

// ---------- user variant ----------

describe("report invoke — handleReportUser (Report User)", () => {
  it("staff invoke: showModal once, tk:rep:u:<32-hex>, subject snapshot", async () => {
    const env = makeEnv("7020");
    const target = createUser({ id: "target-7020", username: "suspect" });
    const interaction = createContextMenuInteraction({
      kind: "user",
      guild: env.guild,
      user: env.adminUser,
      member: env.adminMember,
      client: env.client,
      targetUser: target,
    });

    await report.handleReportUser(interaction, {});

    assert.equal(interaction.modals.length, 1);
    assert.deepEqual(interaction.replies, []);
    assert.deepEqual(interaction.resolved, ["user"]);

    const json = modalJson(interaction.modals[0]);
    const prefix = constants.MODAL_REPORT_USER_PREFIX;
    assert.ok(json.custom_id.startsWith(prefix));
    const token = json.custom_id.slice(prefix.length);
    assert.match(token, /^[0-9a-f]{32}$/);

    const snap = pendingReports.takeReport(token);
    assert.ok(snap);
    assert.equal(snap.kind, "user");
    assert.equal(snap.guildId, "7020");
    assert.equal(snap.reporterUserId, env.adminUser.id);
    assert.equal(snap.subjectUserId, "target-7020");
    // No message fields invented for a user report.
    assert.equal(snap.messageId, null);
    assert.equal(snap.content, "");
    assert.deepEqual(snap.attachments, []);
  });

  it("bot target: handleFor-mirroring copy BEFORE any modal, no snapshot", async () => {
    const env = makeEnv("7021");
    const bot = createUser({ id: "bot-7021", username: "fauna", bot: true });
    const interaction = createContextMenuInteraction({
      kind: "user",
      guild: env.guild,
      user: env.adminUser,
      member: env.adminMember,
      targetUser: bot,
    });

    await report.handleReportUser(interaction, {});

    assert.equal(interaction.replies.length, 1);
    assert.equal(
      lastReplyContent(interaction),
      "Cannot open a ticket for a bot.",
      "copy mirrors handleFor (create.js)",
    );
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(interaction.modals, []);
    assert.equal(pendingReports.pendingReportCountForTests(), 0);
  });

  it("self-report: specific reply BEFORE any modal, no snapshot", async () => {
    const env = makeEnv("7022");
    const interaction = createContextMenuInteraction({
      kind: "user",
      guild: env.guild,
      user: env.adminUser,
      member: env.adminMember,
      targetUser: env.adminUser,
    });

    await report.handleReportUser(interaction, {});

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /can't report yourself/i);
    assert.match(lastReplyContent(interaction), /\/ticket create/);
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(interaction.modals, []);
    assert.equal(pendingReports.pendingReportCountForTests(), 0);
  });

  it("unresolvable target user: specific ephemeral, no modal, no snapshot", async () => {
    const env = makeEnv("7023");
    const interaction = createContextMenuInteraction({
      kind: "user",
      guild: env.guild,
      user: env.adminUser,
      member: env.adminMember,
      targetUser: null,
    });

    await report.handleReportUser(interaction, {});

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /could not resolve the reported member/i);
    assert.ok(lastReplyEphemeral(interaction));
    assert.deepEqual(interaction.modals, []);
  });
});

// ---------- failure semantics (error rules 1–3) ----------

describe("report invoke — failure semantics", () => {
  it("handler throw (resolver explodes): ids + cause logged, safeErrorReply sent", async () => {
    const env = makeEnv("7030");
    const interaction = createContextMenuInteraction({
      kind: "message",
      guild: env.guild,
      user: env.adminUser,
      member: env.adminMember,
      targetMessage: makeReportedMessage(env),
      throwOnResolve: true,
    });

    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportMessage(interaction, {});
    } finally {
      restore();
    }

    const log = lines.join("\n");
    assert.match(log, /\[tickets\] report invoke failed:/);
    assert.match(log, /guild=7030/);
    assert.match(log, new RegExp(`user=${env.adminUser.id}`));
    assert.match(log, /command=Report Post/);
    assert.match(log, /resolver exploded/, "cause surfaced in the log");

    assert.equal(interaction.replies.length, 1);
    assert.match(
      lastReplyContent(interaction),
      /something went wrong/i,
      "router-sanctioned generic via safeErrorReply",
    );
    assert.ok(lastReplyEphemeral(interaction));
  });

  it("showModal rejection: cause logged with ids AND the reply names the failure", async () => {
    const env = makeEnv("7031");
    const interaction = createContextMenuInteraction({
      kind: "user",
      guild: env.guild,
      user: env.adminUser,
      member: env.adminMember,
      targetUser: createUser({ id: "target-7031" }),
      failShowModal: true,
    });

    const { lines, restore } = captureConsoleError();
    try {
      await report.handleReportUser(interaction, {});
    } finally {
      restore();
    }

    const log = lines.join("\n");
    assert.match(log, /\[tickets\] report user modal show failed:/);
    assert.match(log, /guild=7031/);
    assert.match(log, new RegExp(`user=${env.adminUser.id}`));
    assert.match(log, /command=Report User/);
    assert.match(log, /Interaction expired/, "cause surfaced in the log");

    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /could not open the report form/i);
    assert.match(lastReplyContent(interaction), /Interaction expired/);
    assert.match(lastReplyContent(interaction), /run the command again/i);
    assert.ok(lastReplyEphemeral(interaction));

    // The orphaned snapshot has no modal to ride in: it ages out via the
    // store TTL (documented, lazy-swept) — nothing else was created.
    assert.equal(pendingReports.pendingReportCountForTests(), 1);
  });

  it("store-refused user put: specific reply, NEVER showModal", async () => {
    const interaction = createContextMenuInteraction({
      kind: "user",
      guild: null,
      user: createUser({ id: "admin-no-guild" }),
      admin: true,
      targetUser: createUser({ id: "target-no-guild" }),
    });

    await report.handleReportUser(interaction, {});

    assert.deepEqual(interaction.modals, []);
    assert.equal(interaction.replies.length, 1);
    assert.match(lastReplyContent(interaction), /could not start that report/i);
    assert.ok(lastReplyEphemeral(interaction));
  });
});

// ---------- modal builders (decision 1: TEXT INPUTS ONLY) ----------

describe("reportModals — single text-input-only modals", () => {
  const TOKEN = "0".repeat(32);

  /** Flat list of every component across the modal's action rows. */
  function flatComponents(json) {
    return json.components.flatMap((row) => row.components);
  }

  it("message modal: context (Paragraph, required, 4000) + delete (Short, required, no default)", () => {
    const json = modalJson(reportModals.buildReportMessageModal(TOKEN));
    assert.equal(json.custom_id, constants.MODAL_REPORT_MESSAGE_PREFIX + TOKEN);
    assert.equal(json.title, "Report this post");
    assert.equal(json.components.length, 2, "two single-input action rows");

    const inputs = flatComponents(json);
    assert.deepEqual(
      inputs.map((c) => c.custom_id),
      [constants.MODAL_REPORT_FIELD_CONTEXT, constants.MODAL_REPORT_FIELD_DELETE],
    );
    // 4 = Text — a context-menu modal carries nothing else (decision 1).
    assert.deepEqual(inputs.map((c) => c.type), [4, 4]);

    const [context, del] = inputs;
    assert.equal(context.label, "Additional context");
    assert.equal(context.style, 2, "Paragraph");
    assert.equal(context.required, true);
    assert.equal(context.max_length, 4000);
    assert.equal(del.label, "Delete original? (yes/no)");
    assert.equal(del.style, 1, "Short");
    assert.equal(del.required, true, "delete-choice is required, NO default");
    assert.equal(del.value, undefined, "no pre-filled answer");
    assert.equal(del.max_length, 10);
  });

  it("user modal: context input only, token in the customId", () => {
    const json = modalJson(reportModals.buildReportUserModal(TOKEN));
    assert.equal(json.custom_id, constants.MODAL_REPORT_USER_PREFIX + TOKEN);
    assert.equal(json.title, "Report this user");

    const inputs = flatComponents(json);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].type, 4, "text input only");
    assert.equal(inputs[0].custom_id, constants.MODAL_REPORT_FIELD_CONTEXT);
    assert.equal(inputs[0].style, 2, "Paragraph");
    assert.equal(inputs[0].required, true);
    assert.equal(inputs[0].max_length, 4000);
  });

  it("both customIds stay inside Discord's 100-char cap", () => {
    for (const build of [
      reportModals.buildReportMessageModal,
      reportModals.buildReportUserModal,
    ]) {
      assert.ok(modalJson(build(TOKEN)).custom_id.length <= 100);
    }
  });
});
