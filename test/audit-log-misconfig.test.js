// Unit tests for the misconfiguration / failure paths of
// src/features/logs/auditLog.js (wishlist T11, Part A).
//
// auditLog's shipped contract: the send helpers (sendAuditLog / sendMessageLog /
// sendWarnLog) resolve the configured log channel from guild_settings and
// return a boolean — `false` for every misconfig/failure branch (no channel
// configured, channel not found, fetch failure, non-text channel, missing
// send(), send rejection) rather than throwing or falling back to a generic
// "something failed". Send failures must log a *specific* cause with ids
// (AGENTS.md error-handling law), and high-level helpers (logConfigChange,
// logWarnEvent) must degrade without killing the caller. These tests pin that
// contract; the success path is pinned as a positive control per kind.

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const { loadDb } = require("./helpers/env");

// CONTRACT (same as test/command-permissions-oauth.test.js): loadDb() must
// stay above every `src/` require — it points this process at a private temp
// DB (fresh DB_PATH + src require-cache reset) so auditLog's destructured
// getGuildSettings binds to the temp DB instance.
const { cleanup, api: dbApi } = loadDb();

// Closes the tracked DB handles and removes the temp dir (idempotent).
after(cleanup);

const auditLog = require("../src/features/logs/auditLog");
const {
  createClient,
  createGuild,
  createTextChannel,
} = require("./helpers/discord");

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Fresh mock client + guild (unique guild id → isolated guild_settings row).
 */
function makeEnv(guildId) {
  const client = createClient();
  const guild = createGuild({ id: guildId });
  client.addGuild(guild);
  return { client, guild };
}

/** Register a text channel in the guild so client.channels.fetch finds it. */
function addChannel(guild, id) {
  const ch = createTextChannel({ id, guild });
  guild.addChannel(ch);
  return ch;
}

/** Configure log-channel ids on the guild_settings row via the real DB. */
function configure(guildId, ids) {
  dbApi.updateGuildSettings(guildId, ids);
}

const PAYLOAD = { embeds: [{ data: { title: "pinned-payload" } }] };

/**
 * Run `fn` with console.warn captured; returns [result, warnings[]].
 * Restores console.warn even on assertion/throw failure.
 */
async function withWarnCapture(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await fn();
    return [result, warnings];
  } finally {
    console.warn = original;
  }
}

// ── sendAuditLog: misconfig + failure branches (negative) ─────────────────

describe("auditLog.sendAuditLog misconfiguration paths", () => {
  it("returns false without throwing when no audit channel is configured", async () => {
    // Objective: unset guild_settings.audit_log_channel_id is a handled
    // misconfiguration (false), not a crash and not a generic error path.
    // Arrange
    const { client, guild } = makeEnv("g-audit-unset");
    const stray = addChannel(guild, "c-stray");

    // Act
    const sent = await auditLog.sendAuditLog(client, "g-audit-unset", PAYLOAD);

    // Assert — no channel configured → nothing sent anywhere, boolean false.
    assert.equal(sent, false);
    assert.equal(stray.sent.length, 0);
  });

  it("returns false when the configured channel no longer exists (fetch resolves null)", async () => {
    // Objective: stale/deleted channel id → resolveLogChannel yields null →
    // false, silently skipped (no send, no throw).
    // Arrange
    const gid = "g-audit-gone";
    const { client } = makeEnv(gid);
    configure(gid, { audit_log_channel_id: "c-deleted-channel" });

    // Act
    const sent = await auditLog.sendAuditLog(client, gid, PAYLOAD);

    // Assert
    assert.equal(sent, false);
  });

  it("returns false when channel fetch rejects (Discord REST failure)", async () => {
    // Objective: a rejecting fetch (e.g. 500003 Missing Access) is swallowed
    // by the .catch(() => null) branch → false, never an unhandled rejection.
    // Arrange
    const gid = "g-audit-fetch-reject";
    const { client } = makeEnv(gid);
    configure(gid, { audit_log_channel_id: "c-any" });
    client.channels.fetch = async () => {
      throw new Error("500003: Missing Access");
    };

    // Act
    const sent = await auditLog.sendAuditLog(client, gid, PAYLOAD);

    // Assert
    assert.equal(sent, false);
  });

  it("returns false when channel fetch throws synchronously", async () => {
    // Objective: the outer try/catch also covers non-promise fetch failures →
    // false, never a throw to the caller.
    // Arrange
    const gid = "g-audit-fetch-throw";
    const { client } = makeEnv(gid);
    configure(gid, { audit_log_channel_id: "c-any" });
    client.channels.fetch = () => {
      throw new Error("client torn down");
    };

    // Act / Assert — resolves to false instead of rejecting.
    const sent = await auditLog.sendAuditLog(client, gid, PAYLOAD);
    assert.equal(sent, false);
  });

  it("refuses a non-text channel (isTextBased() false) and never calls send", async () => {
    // Objective: invalid channel type (voice/category) is rejected by the
    // isTextBased guard — the payload must not reach channel.send.
    // Arrange
    const gid = "g-audit-voice";
    const { client, guild } = makeEnv(gid);
    const voiceLike = addChannel(guild, "c-voice-like");
    voiceLike.isTextBased = () => false;
    configure(gid, { audit_log_channel_id: "c-voice-like" });

    // Act
    const sent = await auditLog.sendAuditLog(client, gid, PAYLOAD);

    // Assert
    assert.equal(sent, false);
    assert.equal(voiceLike.sent.length, 0);
  });

  it("refuses a channel object without send()", async () => {
    // Objective: resolved object lacking send (wrong type/edge shape) is
    // dropped by the typeof channel.send guard → false.
    // Arrange
    const gid = "g-audit-no-send";
    const { client, guild } = makeEnv(gid);
    const ch = addChannel(guild, "c-no-send");
    delete ch.send;
    configure(gid, { audit_log_channel_id: "c-no-send" });

    // Act
    const sent = await auditLog.sendAuditLog(client, gid, PAYLOAD);

    // Assert
    assert.equal(sent, false);
  });

  it("returns false and logs the specific cause + ids when send rejects (missing permissions)", async () => {
    // Objective: send-time failure (e.g. Missing Permissions) must (a) return
    // false to the caller and (b) log a SPECIFIC cause with guild id and the
    // underlying error message (AGENTS.md: log with context, never generic).
    // Arrange
    const gid = "g-audit-send-fail";
    const { client, guild } = makeEnv(gid);
    const ch = addChannel(guild, "c-audit-target");
    ch.send = async () => {
      throw new Error("Missing Permissions");
    };
    configure(gid, { audit_log_channel_id: "c-audit-target" });

    // Act
    const [sent, warnings] = await withWarnCapture(() =>
      auditLog.sendAuditLog(client, gid, PAYLOAD)
    );

    // Assert — false (not thrown), with cause-specific log context.
    assert.equal(sent, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[auditLog\] Failed to send audit log in guild g-audit-send-fail/);
    assert.match(warnings[0], /Missing Permissions/);
  });

  it("posts to the configured audit channel when everything is set up (positive control)", async () => {
    // Objective control: the false paths above are misconfig-specific — with
    // a valid config the same call returns true and the payload lands exactly
    // once on the configured channel.
    // Arrange
    const gid = "g-audit-ok";
    const { client, guild } = makeEnv(gid);
    const ch = addChannel(guild, "c-audit-ok");
    configure(gid, { audit_log_channel_id: "c-audit-ok" });

    // Act
    const sent = await auditLog.sendAuditLog(client, gid, PAYLOAD);

    // Assert
    assert.equal(sent, true);
    assert.equal(ch.sent.length, 1);
    assert.equal(ch.sent[0].embeds[0].data.title, "pinned-payload");
  });
});

// ── Per-kind channel selection contract (message / warn) ────────────────────

describe("auditLog per-kind log-channel routing", () => {
  it("sendMessageLog does NOT fall back to the audit channel when message log is unset", async () => {
    // Objective: message log has no fallback — unset → false and the audit
    // channel must stay untouched (pins the per-kind mapping).
    // Arrange
    const gid = "g-msg-no-fallback";
    const { client, guild } = makeEnv(gid);
    const auditCh = addChannel(guild, "c-audit-only");
    configure(gid, { audit_log_channel_id: "c-audit-only" });

    // Act
    const sent = await auditLog.sendMessageLog(client, gid, PAYLOAD);

    // Assert
    assert.equal(sent, false);
    assert.equal(auditCh.sent.length, 0);
  });

  it("sendMessageLog delivers to the dedicated message_log_channel_id", async () => {
    // Objective: positive control for the message kind routing.
    // Arrange
    const gid = "g-msg-ok";
    const { client, guild } = makeEnv(gid);
    const msgCh = addChannel(guild, "c-msg-log");
    configure(gid, { message_log_channel_id: "c-msg-log" });

    // Act
    const sent = await auditLog.sendMessageLog(client, gid, PAYLOAD);

    // Assert
    assert.equal(sent, true);
    assert.equal(msgCh.sent.length, 1);
  });

  it("sendWarnLog prefers warn_log_channel_id over the audit channel", async () => {
    // Objective: when both are configured, warn events go to the warn channel
    // and not to the general audit channel.
    // Arrange
    const gid = "g-warn-pref";
    const { client, guild } = makeEnv(gid);
    const warnCh = addChannel(guild, "c-warn");
    const auditCh = addChannel(guild, "c-audit");
    configure(gid, {
      warn_log_channel_id: "c-warn",
      audit_log_channel_id: "c-audit",
    });

    // Act
    const sent = await auditLog.sendWarnLog(client, gid, PAYLOAD);

    // Assert
    assert.equal(sent, true);
    assert.equal(warnCh.sent.length, 1);
    assert.equal(auditCh.sent.length, 0);
  });

  it("sendWarnLog falls back to the audit channel when warn channel is unset", async () => {
    // Objective: documented fallback — warn events still land on the general
    // audit log when no dedicated warn channel exists.
    // Arrange
    const gid = "g-warn-fallback";
    const { client, guild } = makeEnv(gid);
    const auditCh = addChannel(guild, "c-audit-fb");
    configure(gid, { audit_log_channel_id: "c-audit-fb" });

    // Act
    const sent = await auditLog.sendWarnLog(client, gid, PAYLOAD);

    // Assert
    assert.equal(sent, true);
    assert.equal(auditCh.sent.length, 1);
  });

  it("sendWarnLog returns false when neither warn nor audit channel is configured", async () => {
    // Objective: negative case for the fallback branch — no config at all →
    // false, no throw.
    // Arrange
    const { client } = makeEnv("g-warn-unset");

    // Act
    const sent = await auditLog.sendWarnLog(client, "g-warn-unset", PAYLOAD);

    // Assert
    assert.equal(sent, false);
  });
});

// ── High-level helpers degrade gracefully on misconfig ─────────────────────

describe("auditLog high-level helpers under misconfiguration", () => {
  it("logConfigChange resolves quietly (no throw, no send) with no channel configured", async () => {
    // Objective: fire-and-forget callers (settings features) rely on
    // logConfigChange never rejecting when the audit channel is unset —
    // misconfig must not kill the calling pipeline.
    // Arrange
    const gid = "g-cfgchange-unset";
    const { client, guild } = makeEnv(gid);
    const stray = addChannel(guild, "c-stray-cfg");

    // Act
    const result = await auditLog.logConfigChange(client, gid, {
      title: "XP settings updated",
      changes: ["msg_xp: 5 → **10**"],
    });

    // Assert — void helper, no crash, nothing posted.
    assert.equal(result, undefined);
    assert.equal(stray.sent.length, 0);
  });

  it("logWarnEvent builds the config-change embed and routes it to the warn channel", async () => {
    // Objective positive control: the warn-event flow composes
    // buildConfigChangeEmbed + warn routing (incl. bullet normalization of
    // change lines) — pinned end to end.
    // Arrange
    const gid = "g-warnevent-route";
    const { client, guild } = makeEnv(gid);
    const warnCh = addChannel(guild, "c-warn-route");
    configure(gid, { warn_log_channel_id: "c-warn-route" });

    // Act
    await auditLog.logWarnEvent(client, gid, {
      title: "Warning issued",
      command: "/warn add",
      changes: ["member: u1", "- already-bulleted line"],
    });

    // Assert
    assert.equal(warnCh.sent.length, 1);
    const embed = warnCh.sent[0].embeds[0].toJSON();
    assert.equal(embed.title, "Warning issued");
    const changesField = embed.fields.find((f) => f.name === "Changes");
    assert.ok(changesField, "Changes field present");
    // Non-bulleted lines get "• ", existing "- " bullets are kept as-is.
    assert.equal(changesField.value, "• member: u1\n- already-bulleted line");
    const commandField = embed.fields.find((f) => f.name === "Command");
    assert.equal(commandField.value, "`/warn add`");
  });
});
