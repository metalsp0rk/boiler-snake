/**
 * `/gork memory` command tests (roadmap/gork.md §7.16.4 — contract H).
 *
 * Same fake-interaction style as the rest of the gork unit suite: real db
 * facade on a temp SQLite file via loadDb() from ./helpers/env (fresh temp
 * DB_PATH + src require-cache reset + tracked cleanup), real requireStaff
 * gating,
 * and createChatInputInteraction from the shared helpers. Audit assertions
 * ride the REAL logConfigChange path: the guild's audit channel is a fake
 * text channel whose `sent` payloads we inspect.
 *
 * `./memory` (owned by the parallel runtime subtask) is lazy-required
 * inside the budget handler; when the real module is not on disk yet this
 * file pre-seeds a contract-faithful clamp so it never depends on it.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

const { loadDb } = require("./helpers/env");

const {
  createChatInputInteraction,
  createClient,
  createGuild,
  createMember,
  createTextChannel,
  createUser,
  lastReplyContent,
  lastReplyEphemeral,
  PermissionFlagsBits,
} = require("./helpers/discord");

const DEFAULT_BUDGET = 12000;

/** Contract-D clamp, used ONLY while the real memory module is absent. */
function contractClamp(value) {
  if (value === null || value === undefined) return DEFAULT_BUDGET;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BUDGET;
  const int = Math.floor(n);
  if (int < 0) return DEFAULT_BUDGET;
  return Math.min(int, 64000);
}

/** Prefer the real memory module; fall back to a contract-faithful shim. */
function installMemoryShim() {
  const memPath = path.resolve(
    __dirname,
    "..",
    "src",
    "features",
    "gork",
    "memory.js",
  );
  try {
    require(memPath);
  } catch {
    const shim = new Module(memPath, module);
    shim.filename = memPath;
    shim.loaded = true;
    shim.exports = {
      clampMemoryChars: contractClamp,
      loadMemoryContext: () => ({
        block: "",
        mode: "none",
        indexed: 0,
        selectedIds: [],
        rows: [],
      }),
      runMemoryTurn: async () => ({ stored: 0, skippedInvalid: 0, mode: "none" }),
      memoryTurnConfig: () => ({}),
    };
    require.cache[memPath] = shim;
  }
}

let api;
let gork;
let cleanup;

before(() => {
  // Contract: loadDb() must run before every `src/` require in this file —
  // installMemoryShim() and the gork feature require below load src modules
  // that touch the db facade, so loadDb() has to point DB_PATH at a fresh
  // temp SQLite file (and reset the src require cache) before they run;
  // otherwise they would open the project-root xpbot.sqlite, which is racy
  // across parallel `node --test` files.
  ({ api, cleanup } = loadDb());
  installMemoryShim();
  gork = require("../src/features/gork/index.js");
});

// Closes the tracked DB handles and removes the temp dir (idempotent,
// never throws).
after(() => cleanup?.());

// ---------- harness ----------

/**
 * Fresh per-test guild env: own settings row, own audit channel wired into
 * the settings so logConfigChange embeds land in `auditChannel.sent`.
 */
function makeEnv(guildId) {
  const guild = createGuild({ id: guildId });
  const auditChannel = createTextChannel({
    id: `audit-${guildId}`,
    guild,
    name: "audit",
  });
  guild.addChannel(auditChannel);
  const client = createClient();
  client.addGuild(guild);
  api.updateGuildSettings(guildId, { audit_log_channel_id: auditChannel.id });

  const staffUser = createUser({ id: `staff-${guildId}` });
  const staffMember = createMember({ guild, user: staffUser, admin: true });
  guild.addMember(staffMember);

  const plainUser = createUser({ id: `plain-${guildId}` });
  const plainMember = createMember({ guild, user: plainUser });
  guild.addMember(plainMember);

  return { guild, auditChannel, client, staffUser, staffMember };
}

async function runMemory(guildId, options, env, { staff = true } = {}) {
  const interaction = createChatInputInteraction({
    commandName: "gork",
    subcommand: "memory",
    guild: env.guild,
    user: staff ? env.staffUser : env.plainUser,
    member: staff ? env.staffMember : env.plainMember,
    options,
    client: env.client,
  });
  await gork.handlers.gork(interaction, { client: env.client });
  return interaction;
}

async function runStatus(guildId, env) {
  const interaction = createChatInputInteraction({
    commandName: "gork",
    subcommand: "status",
    guild: env.guild,
    user: env.staffUser,
    member: env.staffMember,
    options: {},
    client: env.client,
  });
  await gork.handlers.gork(interaction, { client: env.client });
  return interaction;
}

function seed(guildId, subjectUserId, opts = {}) {
  const {
    title,
    body = "plain body",
    memDate = "2026-09-09",
    importance = 3,
    kind = "profile",
  } = opts;
  return api.gorkMemoryUpsert({
    guildId,
    subjectUserId,
    memDate,
    title,
    titleKey: title.trim().toLowerCase().replace(/\s+/g, " "),
    body,
    kind,
    importance,
    sourceMessageIds: ["111"],
  });
}

/** Flat searchable text of every embed sent to the audit channel. */
function auditText(env) {
  return env.auditChannel.sent
    .flatMap((payload) => (payload && payload.embeds) || [])
    .map((embed) => JSON.stringify(embed.toJSON ? embed.toJSON() : embed))
    .join("\n");
}

/** Fields of the last embed reply (status embeds). */
function embedFields(interaction) {
  const reply = interaction.replies[interaction.replies.length - 1];
  const embed = reply && reply.embeds && reply.embeds[0];
  const data = embed ? (embed.toJSON ? embed.toJSON() : embed) : null;
  return (data && data.fields) || [];
}

// ---------- command surface ----------

describe("/gork memory command surface (contract H)", () => {
  it("registers a memory subcommand: required action choices + optional flags", () => {
    const cmd = gork.commands[0].toJSON();
    assert.equal(
      String(cmd.default_member_permissions),
      String(PermissionFlagsBits.ManageGuild),
      "command-level ManageGuild gate unchanged",
    );
    const mem = cmd.options.find((o) => o.name === "memory");
    assert.ok(mem, "memory subcommand present");
    assert.equal(mem.type, 1, "sub-command");

    const action = mem.options.find((o) => o.name === "action");
    assert.equal(action.type, 3, "string option");
    assert.equal(action.required, true);
    assert.deepEqual(
      action.choices.map((c) => c.value),
      ["show", "forget", "clear", "on", "off", "budget"],
    );

    for (const [name, type] of [
      ["user", 6],
      ["id", 4],
      ["chars", 4],
      ["confirm", 5],
    ]) {
      const opt = mem.options.find((o) => o.name === name);
      assert.ok(opt, `${name} option present`);
      assert.equal(opt.type, type, `${name} option type`);
      assert.equal(opt.required, false, `${name} optional`);
    }
    assert.ok(
      !mem.options.some((o) => o.type === 1 || o.type === 2),
      "no subcommand nesting — Discord depth stays at 2",
    );
  });
});

// ---------- show ----------

describe("/gork memory show", () => {
  it("empty guild → friendly none, ephemeral", async () => {
    const G = "g-mem-show-empty";
    const env = makeEnv(G);
    const interaction = await runMemory(G, { action: "show" }, env);
    assert.ok(lastReplyEphemeral(interaction), "ephemeral");
    assert.match(lastReplyContent(interaction), /no memories stored/i);
  });

  it("empty for a specific user → friendly none", async () => {
    const G = "g-mem-show-empty-user";
    const env = makeEnv(G);
    const stranger = createUser({ id: "sub-stranger" });
    const interaction = await runMemory(
      G,
      { action: "show", user: stranger },
      env,
    );
    assert.match(lastReplyContent(interaction), /no memories stored/i);
    assert.ok(lastReplyContent(interaction).includes("<@sub-stranger>"));
  });

  it("user scope lists ONLY that person's rows as `#id — <@user> — date · title: body`", async () => {
    const G = "g-mem-show-user";
    const env = makeEnv(G);
    const older = seed(G, "sub-a", {
      title: "loves rust",
      body: "keeps a rusty mechanical keyboard",
    });
    const newer = seed(G, "sub-a", {
      title: "ships on fridays",
      body: "deploys every friday",
      memDate: "2026-09-10",
    });
    seed(G, "sub-b", { title: "hates coffee" });

    const interaction = await runMemory(
      G,
      { action: "show", user: createUser({ id: "sub-a" }) },
      env,
    );
    const text = lastReplyContent(interaction);
    assert.ok(lastReplyEphemeral(interaction));
    assert.ok(
      text.includes(
        `#${newer.id} — <@sub-a> — 2026-09-10 · ships on fridays: deploys every friday`,
      ),
      text,
    );
    assert.ok(
      text.includes(
        `#${older.id} — <@sub-a> — 2026-09-09 · loves rust: keeps a rusty mechanical keyboard`,
      ),
      text,
    );
    assert.ok(
      text.indexOf(`#${newer.id}`) < text.indexOf(`#${older.id}`),
      "newest first",
    );
    assert.ok(!text.includes("<@sub-b>"), "other people's memories excluded");
    assert.match(text, /for <@sub-a>/);
  });

  it("guild scope (no user) lists rows of every person", async () => {
    const G = "g-mem-show-guild";
    const env = makeEnv(G);
    const a = seed(G, "sub-x", { title: "keeps bees" });
    const b = seed(G, "sub-x", { title: "hates mint", memDate: "2026-09-08" });
    const c = seed(G, "sub-y", { title: "runs marathons" });

    const interaction = await runMemory(G, { action: "show" }, env);
    const text = lastReplyContent(interaction);
    for (const row of [a, b, c]) {
      assert.ok(text.includes(`#${row.id} — `), `row #${row.id} listed`);
    }
    assert.ok(text.includes("<@sub-x>") && text.includes("<@sub-y>"));
  });

  it("bodies over 120 chars truncate to 120 + ellipsis", async () => {
    const G = "g-mem-show-trunc";
    const env = makeEnv(G);
    const longBody = "y".repeat(200);
    const row = seed(G, "sub-t", { title: "verbose", body: longBody });

    const interaction = await runMemory(G, { action: "show" }, env);
    const text = lastReplyContent(interaction);
    assert.ok(text.includes(`#${row.id}`));
    assert.ok(
      text.includes("y".repeat(120) + "…"),
      "120-char body preview + ellipsis",
    );
    assert.ok(!text.includes("y".repeat(121)), "rest of the body is cut");
  });

  it("big listings stay within the total budget and end with '…and N more'", async () => {
    const G = "g-mem-show-cap";
    const env = makeEnv(G);
    for (let i = 0; i < 25; i += 1) {
      seed(G, "sub-p1", { title: `p1 fact ${i}`, body: "b".repeat(200) });
    }
    for (let i = 0; i < 25; i += 1) {
      seed(G, "sub-p2", { title: `p2 fact ${i}`, body: "b".repeat(200) });
    }

    const interaction = await runMemory(G, { action: "show" }, env);
    const text = lastReplyContent(interaction);
    const shown = (text.match(/^#\d+ — /gm) || []).length;
    assert.ok(shown > 0 && shown < 25, `line budget kicked in (shown=${shown})`);
    assert.match(text, /…and \d+ more/, "hidden rows summarized");
    assert.ok(text.length <= 4096, `fits a Discord message (${text.length})`);
  });
});

// ---------- forget ----------

describe("/gork memory forget", () => {
  it("deletes the row, echoes the title, and audits 'Gork memory forgotten'", async () => {
    const G = "g-mem-forget-ok";
    const env = makeEnv(G);
    const row = seed(G, "sub-f", { title: "quiet typer" });

    const interaction = await runMemory(G, { action: "forget", id: row.id }, env);
    const text = lastReplyContent(interaction);
    assert.ok(lastReplyEphemeral(interaction));
    assert.ok(/forgot memory/i.test(text), text);
    assert.ok(text.includes("quiet typer"), "success echoes the title");
    assert.equal(api.gorkMemoryGetById(G, row.id), null, "row gone");

    const audit = auditText(env);
    assert.ok(audit.includes("Gork memory forgotten"), audit);
    assert.ok(audit.includes("/gork memory"), "audited under /gork memory");
  });

  it("guild-scoped miss → 'no memory #N in this guild', no cross-guild hint", async () => {
    const G = "g-mem-forget-miss";
    const env = makeEnv(G);
    seed(G, "sub-f", { title: "kept" });

    const interaction = await runMemory(G, { action: "forget", id: 424242 }, env);
    assert.match(
      lastReplyContent(interaction),
      /no memory #424242 in this guild/i,
    );
    assert.equal(api.gorkMemoryCountForGuild(G), 1, "nothing deleted");
    assert.ok(!auditText(env).includes("forgotten"), "misses are not audited");
  });

  it("non-positive / missing id → ephemeral error, nothing deleted", async () => {
    const G = "g-mem-forget-bad";
    const env = makeEnv(G);
    seed(G, "sub-f", { title: "kept" });

    for (const bad of [{ action: "forget", id: 0 }, { action: "forget", id: -5 }, { action: "forget" }]) {
      const interaction = await runMemory(G, bad, env);
      assert.match(lastReplyContent(interaction), /positive whole number/i);
      assert.ok(lastReplyEphemeral(interaction));
    }
    assert.equal(api.gorkMemoryCountForGuild(G), 1, "rows intact");
  });
});

// ---------- clear ----------

describe("/gork memory clear", () => {
  it("preview-only without confirm (per-user) shows the count and erases nothing", async () => {
    const G = "g-mem-clear-preview-user";
    const env = makeEnv(G);
    seed(G, "sub-c", { title: "one" });
    seed(G, "sub-c", { title: "two", memDate: "2026-09-10" });
    seed(G, "sub-keep", { title: "other" });

    const interaction = await runMemory(
      G,
      { action: "clear", user: createUser({ id: "sub-c" }) },
      env,
    );
    const text = lastReplyContent(interaction);
    assert.match(text, /this will erase/i);
    assert.ok(text.includes("**2**"), `count shown: ${text}`);
    assert.ok(text.includes("<@sub-c>"));
    assert.match(text, /confirm: true/, "re-run hint");
    assert.equal(api.gorkMemoryCountForGuild(G), 3, "preview erases nothing");
  });

  it("preview-only without confirm (guild scope) counts the whole guild", async () => {
    const G = "g-mem-clear-preview-guild";
    const env = makeEnv(G);
    seed(G, "sub-c", { title: "one" });
    seed(G, "sub-c", { title: "two", memDate: "2026-09-10" });
    seed(G, "sub-other", { title: "three" });

    const interaction = await runMemory(G, { action: "clear" }, env);
    const text = lastReplyContent(interaction);
    assert.match(text, /this will erase/i);
    assert.ok(text.includes("**3**"), `guild count: ${text}`);
    assert.equal(api.gorkMemoryCountForGuild(G), 3);
  });

  it("confirm wipes ONE person only and audits 'Gork memory cleared'", async () => {
    const G = "g-mem-clear-user";
    const env = makeEnv(G);
    seed(G, "sub-c", { title: "one" });
    seed(G, "sub-c", { title: "two", memDate: "2026-09-10" });
    seed(G, "sub-keep", { title: "survivor" });

    const interaction = await runMemory(
      G,
      { action: "clear", user: createUser({ id: "sub-c" }), confirm: true },
      env,
    );
    assert.match(lastReplyContent(interaction), /erased \*\*2\*\*/i);
    assert.equal(api.gorkMemoryListForSubject(G, "sub-c").length, 0);
    assert.equal(api.gorkMemoryListForSubject(G, "sub-keep").length, 1);
    assert.ok(auditText(env).includes("Gork memory cleared"));
  });

  it("confirm without user wipes the whole guild and audits", async () => {
    const G = "g-mem-clear-guild";
    const env = makeEnv(G);
    seed(G, "sub-c", { title: "one" });
    seed(G, "sub-c2", { title: "two" });
    seed(G, "sub-c3", { title: "three" });

    const interaction = await runMemory(G, { action: "clear", confirm: true }, env);
    assert.match(lastReplyContent(interaction), /erased \*\*3\*\*/i);
    assert.equal(api.gorkMemoryCountForGuild(G), 0);
    assert.ok(auditText(env).includes("Gork memory cleared"));
  });

  it("clearing an empty scope is a friendly no-op", async () => {
    const G = "g-mem-clear-empty";
    const env = makeEnv(G);
    const interaction = await runMemory(G, { action: "clear", confirm: true }, env);
    assert.match(lastReplyContent(interaction), /nothing to erase/i);
  });
});

// ---------- on / off ----------

describe("/gork memory on/off", () => {
  it("persists gork_memory_enabled, replies briefly, and audits", async () => {
    const G = "g-mem-onoff";
    const env = makeEnv(G);

    const on = await runMemory(G, { action: "on" }, env);
    assert.equal(api.getGuildSettings(G).gork_memory_enabled, 1);
    assert.match(lastReplyContent(on), /memory is now \*\*on\*\*/i);
    let audit = auditText(env);
    assert.ok(audit.includes("Gork memory enabled"), audit);
    assert.ok(audit.includes("/gork memory"));

    const off = await runMemory(G, { action: "off" }, env);
    assert.equal(api.getGuildSettings(G).gork_memory_enabled, 0);
    assert.match(lastReplyContent(off), /memory is now \*\*off\*\*/i);
    audit = auditText(env);
    assert.ok(audit.includes("Gork memory disabled"), audit);
  });
});

// ---------- budget ----------

describe("/gork memory budget", () => {
  it("stores a valid budget and echoes it", async () => {
    const G = "g-mem-budget-ok";
    const env = makeEnv(G);
    const interaction = await runMemory(G, { action: "budget", chars: 8000 }, env);
    assert.equal(api.getGuildSettings(G).gork_memory_chars, 8000);
    assert.match(lastReplyContent(interaction), /\*\*8000\*\* chars/);
    assert.ok(auditText(env).includes("Gork memory budget updated"));
  });

  it("stores the CLAMPED value for out-of-range input", async () => {
    const G = "g-mem-budget-clamp";
    const env = makeEnv(G);
    await runMemory(G, { action: "budget", chars: 999999 }, env);
    assert.equal(api.getGuildSettings(G).gork_memory_chars, 64000);
  });

  it("0 is VALID and stores as 0 (unlimited)", async () => {
    const G = "g-mem-budget-zero";
    const env = makeEnv(G);
    const interaction = await runMemory(G, { action: "budget", chars: 0 }, env);
    assert.equal(api.getGuildSettings(G).gork_memory_chars, 0);
    assert.match(lastReplyContent(interaction), /unlimited/);
  });

  it("garbage falls back to the 12,000 default", async () => {
    const G = "g-mem-budget-garbage";
    const env = makeEnv(G);
    await runMemory(G, { action: "budget", chars: "abc" }, env);
    assert.equal(api.getGuildSettings(G).gork_memory_chars, DEFAULT_BUDGET);
  });

  it("missing chars → ephemeral error, settings untouched", async () => {
    const G = "g-mem-budget-missing";
    const env = makeEnv(G);
    const interaction = await runMemory(G, { action: "budget" }, env);
    assert.match(lastReplyContent(interaction), /chars/i);
    assert.equal(api.getGuildSettings(G).gork_memory_chars, DEFAULT_BUDGET);
    assert.ok(!auditText(env).includes("budget updated"));
  });
});

// ---------- status + gating ----------

describe("/gork status Memory field & gating", () => {
  it("memory ON shows 'on · <budget> chars · <N> stored', OFF shows 'off'", async () => {
    const G = "g-mem-status";
    const env = makeEnv(G);

    const offStatus = await runStatus(G, env);
    const offField = embedFields(offStatus).find((f) => f.name === "Memory");
    assert.ok(offField, "Memory field present");
    assert.equal(offField.value, "off");

    await runMemory(G, { action: "on" }, env);
    await runMemory(G, { action: "budget", chars: 5000 }, env);
    seed(G, "sub-s", { title: "one" });
    seed(G, "sub-s2", { title: "two" });

    const onStatus = await runStatus(G, env);
    const onField = embedFields(onStatus).find((f) => f.name === "Memory");
    assert.equal(onField.value, "on · 5000 chars · 2 stored");
  });

  it("unknown action → ephemeral error", async () => {
    const G = "g-mem-unknown";
    const env = makeEnv(G);
    const interaction = await runMemory(G, { action: "explode" }, env);
    assert.match(lastReplyContent(interaction), /unknown memory action/i);
    assert.ok(lastReplyEphemeral(interaction));
  });

  it("non-staff invokers are denied by requireStaff", async () => {
    const G = "g-mem-gate";
    const env = makeEnv(G);
    const interaction = await runMemory(
      G,
      { action: "show" },
      env,
      { staff: false },
    );
    assert.match(lastReplyContent(interaction), /permission/i);
    assert.ok(lastReplyEphemeral(interaction));
  });
});
