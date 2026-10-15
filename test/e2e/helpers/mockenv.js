/**
 * Fauxcord mock-Discord client for the E2E suite.
 *
 * Talks to a running fauxcord server (scripts/e2e/start-mock.sh) over HTTP:
 * provisioning (bot/guild/channels/users), test-interaction simulation
 * (slash + component clicks), and tape inspection (stored messages,
 * interaction replies). Every namespace (see e2eEnv.js) owns one bot token
 * + guild, so suite files never collide.
 *
 * Mock API notes (verified against fauxcord @ pinned patch base):
 *  - `/_test/*` routes are unauthenticated test control; `/api/*` is the
 *    Discord-compatible REST surface (needs `Authorization: Bot <token>`).
 *  - `GET /_test/messages/:channelId` is a SIMPLIFIED tape view (drops
 *    components/flags) — for full-fidelity reads use
 *    `GET /api/channels/:channelId/messages/:messageId` via message().
 *  - Interaction replies are fetched with the interaction token as a
 *    webhook token: `GET /webhooks/:applicationId/:token/messages/@original`
 *    (mock serves ephemerals to any caller; real Discord does not).
 */

const DEFAULT_BASE = (process.env.FAUXCORD_URL || "http://127.0.0.1:3100").replace(
  /\/+$/,
  "",
);

/** JSON fetch: throws Error with method+url+status+body context on failure. */
async function j(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(
      `${res.status} ${res.statusText} on ${opts.method || "GET"} ${url}`,
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Poll until `fn()` returns a truthy value; rejects with a labeled timeout
 * error (carrying `lastErr` for diagnosis) once the deadline passes.
 */
async function poll(fn, { timeoutMs = 8000, everyMs = 200, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() >= deadline) {
      const err = new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
      err.lastErr = lastErr ? err.lastErr || lastErr.message : undefined;
      throw err;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Flat per-namespace snowflake-ish id block (never parsed as Number). */
function namespaceIds(ns) {
  const id = (slot) => `440000000000${String(ns).padStart(2, "0")}${String(slot).padStart(3, "0")}`;
  return {
    token: `e2e-fauxcord-token-ns${ns}`,
    app: id(1),
    guild: id(10),
    general: id(11),
    staffRole: id(12),
    channel2: id(13),
    human: id(20), // primary operator (seeded staff where the scenario says so)
    target: id(21), // interaction subject (never staff)
    outsider: id(22), // unprivileged human (never staff, never in allow-lists)
  };
}

/**
 * HTTP facade for one fauxcord namespace.
 */
class MockEnv {
  /**
   * @param {{base?: string, ids: ReturnType<typeof namespaceIds>}} opts
   */
  constructor({ base = DEFAULT_BASE, ids }) {
    this.base = base;
    this.ids = ids;
  }

  get auth() {
    return { authorization: `Bot ${this.ids.token}` };
  }

  /** True when the mock answers /_mock/health. */
  async healthy() {
    try {
      const h = await j(`${this.base}/_mock/health`);
      return h?.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Idempotent namespace provisioning: remove any previous setup for this
   * token (cascades guild/channels/messages/guild commands/interactions),
   * create guild + text channels, ensure test users, then bootstrap guild
   * membership by injecting one message per human (fauxcord upserts the
   * guild_members row of an injected message author — interactions embed
   * `member` only when that row exists).
   * @param {{users?: Array<{id: string, username: string}>, channels?: Array<{id: string, name: string}>}} [spec]
   */
  async provision(spec = {}) {
    const { ids } = this;
    const channels = spec.channels || [{ id: ids.general, name: "general" }];
    const users = spec.users || [
      { id: ids.human, username: "E2EOperator" },
      { id: ids.target, username: "E2ETarget" },
      { id: ids.outsider, username: "E2EOutsider" },
    ];

    await fetch(
      `${this.base}/_test/setup/${encodeURIComponent(`Bot ${ids.token}`)}`,
      { method: "DELETE" },
    ).catch(() => {});
    await j(`${this.base}/_test/setup`, {
      method: "POST",
      body: JSON.stringify({
        token: `Bot ${ids.token}`,
        user: { id: ids.app, username: "E2ESnake" },
        guilds: [{ id: ids.guild, name: "E2E Guild", channels }],
      }),
    });

    for (const user of users) {
      await j(`${this.base}/_test/users`, {
        method: "POST",
        body: JSON.stringify(user),
      }).catch((err) => {
        // Test users survive setup deletion — reuse the existing row.
        if (!/409|CONFLICT/i.test(`${err.status} ${err.message}`)) throw err;
      });
      await this.inject(`member-bootstrap ${user.id}`, user.id, channels[0].id);
    }
    return { users, channels };
  }

  /** Wipe ALL mock state (single-namespace runs only — never between files). */
  async resetAll() {
    await j(`${this.base}/_test/reset`, { method: "POST", body: "{}" }).catch(
      (err) => err,
    );
  }

  /** Create a guild role (bot-authenticated REST). Returns the role object. */
  async createRole(name, { permissions } = {}) {
    return j(`${this.base}/api/guilds/${this.ids.guild}/roles`, {
      method: "POST",
      headers: this.auth,
      body: JSON.stringify({ name, ...(permissions != null && { permissions }) }),
    });
  }

  /** Grant a role to a user (guild member must exist; see provision()). */
  async grantRole(userId, roleId) {
    return j(
      `${this.base}/api/guilds/${this.ids.guild}/members/${userId}/roles/${roleId}`,
      { method: "PUT", headers: this.auth, body: "{}" },
    );
  }

  /**
   * Inject a human-authored message (also upserts guild membership).
   * @param {string} content
   * @param {string} authorId
   * @param {string} [channelId]
   */
  async inject(content, authorId, channelId = this.ids.general) {
    return j(`${this.base}/_test/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, author: { id: authorId } }),
    });
  }

  /**
   * Simulate an APPLICATION_COMMAND (type 2) INTERACTION_CREATE.
   * @param {{command: string, options?: object[], userId?: string, channelId?: string}} req
   */
  async slash({ command, options, userId = this.ids.human, channelId = this.ids.general }) {
    return j(`${this.base}/_test/interactions`, {
      method: "POST",
      body: JSON.stringify({
        application_id: this.ids.app,
        command_name: command,
        guild_id: this.ids.guild,
        channel_id: channelId,
        user_id: userId,
        ...(options && { options }),
      }),
    });
  }

  /**
   * Simulate a MESSAGE_COMPONENT (type 3) INTERACTION_CREATE — a button
   * click attached to a stored message (part of the vendored patch series).
   * @param {{customId: string, messageId: string, componentType?: number, values?: string[], userId?: string, channelId?: string}} req
   */
  async click({
    customId,
    messageId,
    componentType = 2,
    values,
    userId = this.ids.human,
    channelId = this.ids.general,
  }) {
    return j(`${this.base}/_test/interactions`, {
      method: "POST",
      body: JSON.stringify({
        application_id: this.ids.app,
        type: 3,
        custom_id: customId,
        component_type: componentType,
        message_id: messageId,
        ...(values && { values }),
        guild_id: this.ids.guild,
        channel_id: channelId,
        user_id: userId,
      }),
    });
  }

  /**
   * Await the bot's initial reply for an interaction (ephemerals included —
   * the token acts as the followup webhook token; mock quirk: visible to
   * any caller, real Discord restricts to the invoker).
   * @param {{id: string, token: string}} interaction
   */
  async awaitReply(interaction, { timeoutMs = 10_000 } = {}) {
    return poll(
      () =>
        j(`${this.base}/webhooks/${this.ids.app}/${interaction.token}/messages/@original`).catch(
          (err) => (err.status === 404 ? null : Promise.reject(err)),
        ),
      { timeoutMs, label: `reply for interaction ${interaction.id}` },
    );
  }

  /** Full-fidelity stored message read (components/flags intact). */
  async message(messageId, channelId = this.ids.general) {
    return j(`${this.base}/api/channels/${channelId}/messages/${messageId}`, {
      headers: this.auth,
    });
  }

  /** Flattened button components of a stored message. */
  async buttons(messageId, channelId) {
    const msg = await this.message(messageId, channelId);
    return (msg.components || []).flatMap((row) =>
      row.type === 1 ? row.components || [] : [row],
    );
  }

  /** Simplified tape (id/author/content only — no components/flags). */
  async tape(channelId = this.ids.general) {
    const tape = await j(`${this.base}/_test/messages/${channelId}`);
    return Array.isArray(tape) ? tape : tape?.messages || [];
  }
}

module.exports = { MockEnv, namespaceIds, j, poll, DEFAULT_BASE };
