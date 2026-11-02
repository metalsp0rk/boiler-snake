const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// Loading the registry pulls in every feature module, which opens SQLite at
// require time (db facade side effect). CONTRACT: loadDb() must stay above
// every `src/` require in this file — it points this process at a private
// temp DB (fresh DB_PATH + src require-cache reset) before those requires
// load, because the project-root default (xpbot.sqlite) is racy when
// node --test runs files in parallel (SQLITE_ERROR flakes).
const { cleanup } = loadDb();

const { buildDefaultRegistry, createRegistry } = require("../src/commands/registry");
const features = require("../src/features");

// Closes the tracked DB handles and removes the temp dir (idempotent,
// never throws).
after(cleanup);

// #773: the banAppeals feature module is BOOT-WIRED (src/features/index.js,
// subtask 07) — the former merge stopgap that grafted its command module onto
// a raw buildDefaultRegistry() is GONE: /banappeals now arrives through the
// real registry like every other command, and these pins cover the wired
// surface directly.

describe("command definitions via registry", () => {
  it("exports 43 slash commands + 5 context menus with unique names", () => {
    const { commands } = buildDefaultRegistry();
    // #745: 37 slash builders + "Report Post"/"Report User" context menus.
    // #725: + /automod and /automodconfig (auto-moderation epic #723).
    // #726: + "Refer to automod" context menu (/automod refer is a
    // SUBCOMMAND of the existing /automod builder — top-level count moves
    // only by the one menu).
    // #771: + /set-moderation-queue (admin alias over the automod channel).
    // #794: + "Open ticket for user" context menu (twin of the EXISTING
    // /ticket for subcommand — one new top-level menu, no new slash).
    // #772: + /ban, /bannotify and the "Ban member" context menu
    // (ban lifecycle: two new slashes + one menu).
    // #773: + /banappeals (ban appeals intake toggle) — wired through
    // src/features/index.js like every other feature command.
    assert.equal(commands.length, 48);
    const names = commands.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes("eventreminder"));
    assert.ok(names.includes("ban"), "#772 staff ban surface");
    assert.ok(names.includes("bannotify"), "#772 ban notification toggles");
    assert.ok(names.includes("Ban member"), "#772 ban context menu");
    assert.ok(names.includes("banappeals"), "#773 ban appeals toggle");
    // /event split (APPLICATION_COMMAND_TOO_LARGE): all four names registered.
    assert.ok(names.includes("event"));
    assert.ok(names.includes("eventsignup"));
    assert.ok(names.includes("eventconfig"));
    assert.ok(names.includes("eventchannels"));
    assert.ok(names.includes("bridge"));
    assert.ok(names.includes("link"));
    assert.ok(names.includes("note"));
    assert.ok(names.includes("staff"));
    // #599: staff-visible read-only twin of /staff role list + /staff settings.
    assert.ok(names.includes("staffsettings"));
    assert.ok(names.includes("warn"));
    assert.ok(names.includes("setwarn"));
    assert.ok(names.includes("userinfo"));
    assert.ok(names.includes("activityconfig"));
    assert.ok(names.includes("ticket"));
    assert.ok(names.includes("grantxp"));
    assert.ok(names.includes("play"));
    assert.ok(names.includes("music"));
    assert.ok(names.includes("twitch"));
    assert.ok(names.includes("settwitch"));
    assert.ok(names.includes("gork"));
    assert.ok(names.includes("github"));
    // #305: RSS feed notifications.
    assert.ok(names.includes("rss"));
    assert.ok(names.includes("setrss"));
    // #745: Discord context-menu report commands (display names — spaces and
    // caps are legal there and double as the registry + visibility-map keys).
    assert.ok(names.includes("Report Post"));
    assert.ok(names.includes("Report User"));
    // #726: auto-mod referral context menu (exact display name).
    assert.ok(names.includes("Refer to automod"));
    // #794: staff proxy-ticket context menu (twin of /ticket for).
    assert.ok(names.includes("Open ticket for user"));
    // #725: auto-moderation settings + config commands.
    assert.ok(names.includes("automod"));
    assert.ok(names.includes("automodconfig"));
  });
});

describe("buildDefaultRegistry", () => {
  it("registers a handler for every defined command", () => {
    const registry = buildDefaultRegistry();
    for (const cmd of registry.commands) {
      assert.equal(
        typeof registry.getHandler(cmd.name),
        "function",
        `missing handler for /${cmd.name}`
      );
    }
  });

  it("keeps the context-menu report handlers on the interaction api", () => {
    // #745: "Report Post"/"Report User" ride the raw interaction (the target
    // message/user only exists there); they must NOT be flagged "context".
    // #726: "Refer to automod" the same — options.getMessage() is the only
    // way to reach the referred message.
    // #794: "Open ticket for user" the same — options.getUser("user") is the
    // only way to reach the menu target.
    const registry = buildDefaultRegistry();
    for (const name of [
      "Report Post",
      "Report User",
      "Refer to automod",
      "Open ticket for user",
    ]) {
      assert.equal(typeof registry.getHandler(name), "function", name);
      assert.equal(registry.getHandlerApi(name), "interaction", name);
    }
  });

  it("flags the migrated commands on the context api", () => {
    // load.js passes feature.handlerApi into registerHandler. PR 3 migrated
    // the xp commands; PR 4 adds the staff text commands; PR 5 adds the
    // integrations, moderation surface, tickets text, and gork. Everything
    // left (music, eventreminder, play) stays on the interaction arm until
    // its feature PR flips the flag. `ticket panel` is Discord-only INSIDE
    // the migrated /ticket handler (rawInteraction bridge) — the command
    // itself is context.
    const registry = buildDefaultRegistry();
    const migrated = [
      "xp",
      "leaderboard",
      "setxp",
      "grantxp",
      "note",
      "warn",
      "setwarn",
      "userinfo",
      "staff",
      // #599: the staff-visible read twin rides the same CommandContext arm.
      "staffsettings",
      "settings",
      "setcommandchannel",
      "setdecay",
      "leveltorole",
      "setlog",
      "youtube",
      "setyoutube",
      "testnotification",
      "twitch",
      "settwitch",
      "github",
      "activityconfig",
      "honeypot",
      "reactionrole",
      "ticket",
      "gork",
      "link",
      // #725: auto-moderation status + config ride the CommandContext arm.
      "automod",
      "automodconfig",
      // #772: staff ban surface + notification toggles ride the same arm.
      "ban",
      "bannotify",
      // #773: the ban-appeals toggle rides the same arm (boot-wired through
      // src/features/index.js since subtask 07 — the merge stopgap is gone).
      "banappeals",
    ];
    for (const name of migrated) {
      assert.equal(registry.getHandlerApi(name), "context", name);
    }
    for (const name of ["music", "eventreminder", "play"]) {
      assert.equal(registry.getHandlerApi(name), "interaction", name);
    }
  });

  it("registers youtube autocomplete", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getAutocomplete("youtube"), "function");
  });

  it("registers eventreminder autocomplete and modal handler", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getAutocomplete("eventreminder"), "function");
    assert.equal(
      typeof registry.getModalHandler("er:create:abc123"),
      "function"
    );
  });

  it("loads feature modules by name", () => {
    const names = features.map((f) => f.name);
    for (const expected of [
      "settings",
      "commandChannels",
      "xp",
      "decay",
      "voice",
      "levelRoles",
      "logs",
      "youtube",
      "twitch",
      "honeypot",
      "reactionRoles",
      "eventReminders",
      "staffRoles",
      "commandPermissions",
      "staffNotes",
      "warnings",
      // #772: ban lifecycle (records, lifecycle DMs, auto-unban ticker).
      "banLifecycle",
      // #773: ban appeals (DM intake, staff ticket, ferry, outcomes).
      "banAppeals",
      "userinfo",
      "userActivity",
      "retention",
      "tickets",
      "music",
      "gork",
      "githubReleases",
      "web",
      "bridge",
      "linking",
      "rss",
      "automod",
    ]) {
      assert.ok(names.includes(expected), `missing feature ${expected}`);
    }
    assert.equal(features.length, 31);
  });

  it("registers userinfo button handler", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getButtonHandler("ui:n:123"), "function");
  });

  it("registers music button handler", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getButtonHandler("music:skip"), "function");
    assert.equal(typeof registry.getButtonHandler("music:pause"), "function");
  });

  it("registers ticket panel button and modal handlers", () => {
    const registry = buildDefaultRegistry();
    assert.equal(typeof registry.getButtonHandler("tk:open"), "function");
    assert.equal(typeof registry.getModalHandler("tk:create"), "function");
    assert.equal(typeof registry.getButtonHandler("tk:sn:42"), "function");
    assert.equal(typeof registry.getModalHandler("tk:snm:42"), "function");
  });

  it("registers staff note modal handlers", () => {
    const registry = buildDefaultRegistry();
    assert.equal(
      typeof registry.getModalHandler("note:add:1234567890"),
      "function"
    );
    assert.equal(typeof registry.getModalHandler("note:edit:12"), "function");
  });

  it("routes the automod referral modal; the rules-text modal is retired", () => {
    const registry = buildDefaultRegistry();
    // #771: the referral intake form (longest-prefix `am:refer:<token>`).
    assert.equal(
      typeof registry.getModalHandler("am:refer:0123456789abcdef0123456789abcdef"),
      "function",
    );
    // Epic #723 rules-sourcing change: `am:rules` (the old rules-text modal)
    // is GONE — rules are extracted from the rules channel, never typed.
    assert.equal(registry.getModalHandler("am:rules"), undefined);
  });
});

describe("createRegistry", () => {
  it("throws on invalid handler registration", () => {
    const registry = createRegistry();
    assert.throws(() => registry.registerHandler("", () => {}), /name required/);
    assert.throws(() => registry.registerHandler("foo", null), /fn must be a function/);
  });

  it("defaults the handler api to interaction", () => {
    const registry = createRegistry();
    const fn = () => {};
    registry.registerHandler("xp", fn);
    assert.equal(registry.getHandlerApi("xp"), "interaction");
    assert.equal(registry.getHandler("xp"), fn);
  });

  it("stores the context api when flagged", () => {
    const registry = createRegistry();
    const fn = () => {};
    registry.registerHandler("xp", fn, { api: "context" });
    assert.equal(registry.getHandlerApi("xp"), "context");
    assert.equal(registry.getHandler("xp"), fn);
  });

  it("getHandlerApi is null for unregistered commands", () => {
    const registry = createRegistry();
    assert.equal(registry.getHandlerApi("notarealcommand"), null);
  });

  it("throws on an invalid api value", () => {
    const registry = createRegistry();
    assert.throws(
      () => registry.registerHandler("xp", () => {}, { api: "bogus" }),
      /api must be/,
    );
  });

  it("re-registering without opts replaces fn and resets api to interaction", () => {
    const registry = createRegistry();
    const first = () => {};
    const second = () => {};
    registry.registerHandler("xp", first, { api: "context" });
    assert.equal(registry.getHandlerApi("xp"), "context");
    registry.registerHandler("xp", second);
    assert.equal(registry.getHandlerApi("xp"), "interaction");
    assert.equal(registry.getHandler("xp"), second);
  });

  it("throws on duplicate command names", () => {
    const registry = createRegistry();
    const fake = { toJSON: () => ({ name: "dup" }) };
    registry.addCommand(fake);
    assert.throws(() => registry.addCommand(fake), /duplicate/);
  });
});
