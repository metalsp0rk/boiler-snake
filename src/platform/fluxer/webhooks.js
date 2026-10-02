/**
 * Fluxer webhook lifecycle module (roadmap/bridge.md §10.3 delta 3).
 *
 * Adapter-owned plumbing: create / execute / patch / delete over the platform
 *'s webhook routes. ZERO bridge, pairing, state, or audit references — policy
 * lives in src/features/bridge/ (KD 1).
 *
 * Routes are the live OpenAPI set (§10.3):
 *   POST   /v1/channels/{id}/webhooks                    (create; bot token)
 *   POST   /v1/webhooks/{id}/{token}?wait=true          (execute; token auth)
 *   PATCH  /v1/webhooks/{id}/{token}/messages/{mid}     (edit)
 *   DELETE /v1/webhooks/{id}/{token}/messages/{mid}     (delete; 404 = ok)
 *   DELETE /v1/webhooks/{id}/{token}                    (delete webhook)
 *
 * Transport is INJECTED for testability (same posture as createFluxerOutbound
 * taking a handle):
 *   - `rest`    contract-5 REST facade `{ request(method, path, { body, query }) }`
 *              — the bot-authorized path (create only).
 *   - `fetch`  fetch-compatible function for the TOKEN endpoints. These carry
 *              the webhook token IN THE URL, so they never travel the
 *              bot-authorized facade; per spec (spike B13) the execute call
 *              sends NO `Origin` header — Fluxer refuses first-party web
 *              origins with INVALID_API_ORIGIN. This module never sets an
 *              Origin header on any request.
 *
 * Token hygiene (AGENTS.md): the webhook token appears only in module RETURN
 * values (webhook.token, plaintext in memory; encryption at rest is PR 5's
 * tokenCrypto). Error strings name the webhook by ID only — never the URL,
 * which embeds the token.
 */

const { assertCommunityId } = require("../community");

/**
 * Specific, human-readable cause for a thrown value (never a token: no
 * message built here contains a URL).
 * @param {unknown} err
 * @returns {string}
 */
function causeOf(err) {
  return String(err?.message || err);
}

/**
 * API error code from a transport error, stringified at the boundary
 * (same posture as the outbound adapters).
 * @param {unknown} err
 * @returns {string|undefined}
 */
function codeOf(err) {
  return err?.code != null ? String(err.code) : undefined;
}

/**
 * HTTP status from a response/error, when it exposes one.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function statusOf(value) {
  const s = Number(value?.status ?? value?.statusCode);
  return Number.isFinite(s) && s > 0 ? s : undefined;
}

/**
 * 429 and 5xx are transient (retry the send); 4xx are terminal (the caller
 * must change something). A transport-level throw (no status) is transient.
 * @param {number|undefined} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * "method: detail failed: cause (status N, code X)" — status and API code go
 * into the message (AGENTS.md rule 2); no URL is ever embedded, so the
 * webhook token can never reach a log through here.
 */
function failureText(method, detail, err) {
  const bits = [];
  const status = statusOf(err);
  const code = codeOf(err);
  if (status != null) bits.push(`status ${status}`);
  if (code != null) bits.push(`code ${code}`);
  const suffix = bits.length ? ` (${bits.join(", ")})` : "";
  return `${method}: ${detail} failed: ${causeOf(err)}${suffix}`;
}

/**
 * Read a JSON body from a Response-shaped object, best-effort: non-ok
 * bodies are parsed for their `code`/`message`, and an unparseable body
 * yields null (the status line is then the whole cause).
 * @param {any} res
 * @returns {Promise<any|null>}
 */
async function readJsonSafe(res) {
  if (!res || typeof res.json !== "function") return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Normalize one `files` entry to { name, data, contentType } — the same
 * descriptor shape the OutboundClient send paths accept (spec § Embeds and
 * attachments vocabulary), mirrored here so the webhook module stands alone.
 *
 * @param {unknown} file
 * @param {number} index
 * @param {string} method
 * @returns {{ ok: true, file: { name: string, data: Buffer, contentType: string } }
 *   | { ok: false, error: string }}
 */
function normalizeSendFile(file, index, method) {
  const name = typeof file?.name === "string" && file.name !== "" ? file.name : null;
  if (name == null) {
    return {
      ok: false,
      error: `${method}: files[${index}] needs a non-empty string name (files entries are { name, data, contentType? })`,
    };
  }
  let data = null;
  const raw = file?.data ?? file?.attachment;
  if (Buffer.isBuffer(raw)) data = raw;
  else if (typeof raw === "string") data = Buffer.from(raw, "utf8");
  else if (raw instanceof ArrayBuffer) data = Buffer.from(new Uint8Array(raw));
  else if (ArrayBuffer.isView(raw)) data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (data == null) {
    return {
      ok: false,
      error:
        `${method}: files[${index}] ("${name}") needs Buffer data, got ` +
        `${raw == null ? String(raw) : typeof raw}`,
    };
  }
  const contentType =
    typeof file.contentType === "string" && file.contentType !== ""
      ? file.contentType
      : "application/octet-stream";
  return { ok: true, file: { name, data, contentType } };
}

/**
 * Validate the RelayWebhook handle { id, token } (§10.3 typedef). Returns an
 * error string naming the METHOD and the webhook id — never the token.
 * @param {object} webhook
 * @param {string} method
 * @returns {string|null}
 */
function validateWebhook(webhook, method) {
  if (!webhook || typeof webhook !== "object") {
    return `${method}: webhook must be { id, token }`;
  }
  if (webhook.id == null || String(webhook.id) === "") {
    return `${method}: webhook.id is required`;
  }
  if (typeof webhook.token !== "string" || webhook.token === "") {
    return `${method}: webhook ${String(webhook.id)} has no token`;
  }
  return null;
}

/**
 * Build the webhook lifecycle bound to one instance's transports.
 *
 * @param {{
 *   rest?: { request: (method: string, path: string, opts?: { body?: any, query?: any }) => Promise<any> },
 *   apiOrigin?: string,
 *   fetch?: (url: string, init?: object) => Promise<any>,
 * }} transport
 *   `rest` is required by createRelayWebhook (bot-authorized). Token
 *   endpoints need `fetch`; `apiOrigin` (e.g. the instance's API origin from
 *   discovery) prefixes their URLs — with it empty the fetch receives the
 *   `/v1/...` path verbatim, which is what the test doubles assert on.
 * @returns {{
 *   createRelayWebhook: (communityId: number, channelId: string, opts: { name: string }) => Promise<object>,
 *   executeRelayWebhook: (webhook: object, opts: object) => Promise<object>,
 *   patchRelayMessage: (webhook: object, messageId: string, opts: object) => Promise<object>,
 *   deleteRelayMessage: (webhook: object, messageId: string) => Promise<object>,
 *   deleteRelayWebhook: (webhook: object) => Promise<object>,
 * }}
 */
function createFluxerWebhooks(transport = {}) {
  const rest = transport.rest;
  const apiOrigin =
    typeof transport.apiOrigin === "string" ? transport.apiOrigin.replace(/\/+$/, "") : "";
  const fetchImpl =
    typeof transport.fetch === "function"
      ? transport.fetch
      : (url, init) => globalThis.fetch(url, init);

  /** Full URL for a token endpoint path (apiOrigin-prefixed). */
  function tokenUrl(path) {
    return `${apiOrigin}${path}`;
  }

  /** `/v1/webhooks/{id}/{token}` — token goes in the PATH, never a log. */
  function webhookPath(webhook, suffix = "") {
    return `/v1/webhooks/${encodeURIComponent(String(webhook.id))}/${encodeURIComponent(
      String(webhook.token),
    )}${suffix}`;
  }

  /**
   * Build the JSON body for execute/patch. Only defined fields are sent —
   * the API treats absent as "unchanged/none". allowedMentions passes 1:1
   * (the relay sends `{}` to pin suppression; §10.6). username/avatar_url/
   * flags/nonce are execute-only (§10.3 signatures).
   */
  function buildBody(options, { forExecute }) {
    const body = {};
    if (options.content != null) body.content = String(options.content);
    if (forExecute) {
      if (options.username != null) body.username = String(options.username);
      if (options.avatarUrl != null) body.avatar_url = String(options.avatarUrl);
      if (options.allowedMentions !== undefined) body.allowed_mentions = options.allowedMentions;
      if (typeof options.flags === "number") body.flags = options.flags;
      if (options.nonce != null) body.nonce = String(options.nonce);
    }
    return { ok: true, body };
  }

  /**
   * files → FormData (payload_json + files[i] parts, the Phase 0-confirmed
   * multipart shape shared with the send paths).
   */
  function buildMultipart(body, files, method) {
    let form;
    try {
      form = new FormData();
      form.append("payload_json", JSON.stringify(body));
      files.forEach((f, i) => {
        form.append(
          `files[${i}]`,
          new Blob([new Uint8Array(f.data)], { type: f.contentType }),
          f.name,
        );
      });
    } catch (err) {
      return { ok: false, error: `${method}: multipart body build failed: ${causeOf(err)}` };
    }
    return { ok: true, form };
  }

  /** Normalize+validate the files array; returns { ok, files } | { ok: false, error }. */
  function prepareFiles(options, method) {
    const filesIn = Array.isArray(options.files) ? options.files : [];
    const files = [];
    for (let i = 0; i < filesIn.length; i += 1) {
      const norm = normalizeSendFile(filesIn[i], i, method);
      if (!norm.ok) return { ok: false, error: norm.error };
      files.push(norm.file);
    }
    return { ok: true, files };
  }

  /**
   * One token-endpoint call: request → { ok, payload } | { ok: false, error, retryable, code }.
   * Never embeds the URL (it carries the token) into the error text.
   */
  async function tokenRequest(methodName, httpMethod, path, body, headers) {
    const init = { method: httpMethod, headers: headers ?? {} };
    if (body !== undefined) init.body = body;
    // NOTE: no `Origin` header is ever set (INVALID_API_ORIGIN, spike B13).
    let res;
    try {
      res = await fetchImpl(tokenUrl(path), init);
    } catch (err) {
      // Transport-level failure (DNS, socket, abort): transient.
      return {
        ok: false,
        error: `${methodName}: request failed: ${causeOf(err)}`,
        retryable: true,
      };
    }
    const status = statusOf(res);
    if (res && res.ok === true) {
      return { ok: true, payload: await readJsonSafe(res), status };
    }
    const payload = await readJsonSafe(res);
    const code = payload?.code != null ? String(payload.code) : undefined;
    const bits = [];
    if (status != null) bits.push(`HTTP ${status}`);
    if (code != null) bits.push(code);
    if (typeof payload?.message === "string" && payload.message !== "") {
      bits.push(payload.message);
    }
    return {
      ok: false,
      error: `${methodName}: request failed: ${bits.length ? bits.join(" ") : "no HTTP status"}`,
      status,
      code,
      retryable: isRetryableStatus(status),
    };
  }

  const api = {
    /**
     * Create a channel webhook (bot-authorized create route — NOT gated by
     * the K8 elevated flag; that set is roles/channels/bans).
     *
     * @param {number} communityId
     * @param {string} channelId
     * @param {{ name: string }} [options]
     * @returns {Promise<{ ok: true, webhook: { id: string, token: string } }|{ ok: false, error: string, code?: string }>}
     */
    async createRelayWebhook(communityId, channelId, options = {}) {
      assertCommunityId(communityId);
      if (typeof options.name !== "string" || options.name.trim() === "") {
        return {
          ok: false,
          error: "createRelayWebhook: { name } needs a non-empty string name",
        };
      }
      if (!rest || typeof rest.request !== "function") {
        return {
          ok: false,
          error: "createRelayWebhook: transport needs a rest facade with request()",
        };
      }
      let data;
      try {
        data = await rest.request("POST", `/v1/channels/${String(channelId)}/webhooks`, {
          body: { name: options.name.trim() },
        });
      } catch (err) {
        return {
          ok: false,
          error: failureText("createRelayWebhook", `webhook create in channel ${channelId}`, err),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
      // The create response returns the webhook FULLY, token included
      // (spec: "token returned in full"). A response missing id/token is a
      // failure naming the gap — never a half-built RelayWebhook.
      if (!data || data.id == null) {
        return {
          ok: false,
          error: `createRelayWebhook: webhook create in channel ${channelId} returned no webhook id`,
        };
      }
      if (typeof data.token !== "string" || data.token === "") {
        return {
          ok: false,
          error: `createRelayWebhook: webhook ${String(data.id)} in channel ${channelId} came back without a token`,
        };
      }
      return { ok: true, webhook: { id: String(data.id), token: data.token } };
    },

    /**
     * Execute the webhook with `wait=true` (the send path needs the message
     * id back synchronously; §10.6 idempotency pins `nonce` + `wait=true`
     * on every relay send — this method always sets wait=true).
     *
     * @param {{ id: string, token: string }} webhook RelayWebhook
     * @param {{ content?: string, username?: string, avatarUrl?: string,
     *   files?: Array<{ name: string, data: Buffer|string, contentType?: string }>,
     *   allowedMentions?: object, flags?: number, nonce?: string }} [options]
     * @returns {Promise<{ ok: true, messageId: string|null }|{ ok: false, error: string, retryable: boolean, code?: string }>}
     */
    async executeRelayWebhook(webhook, options = {}) {
      const invalid = validateWebhook(webhook, "executeRelayWebhook");
      if (invalid) return { ok: false, error: invalid, retryable: false };

      const built = buildBody(options, { forExecute: true });
      const filesPrep = prepareFiles(options, "executeRelayWebhook");
      if (!filesPrep.ok) return { ok: false, error: filesPrep.error, retryable: false };

      let body;
      let headers = { "content-type": "application/json" };
      if (filesPrep.files.length > 0) {
        const form = buildMultipart(built.body, filesPrep.files, "executeRelayWebhook");
        if (!form.ok) return { ok: false, error: form.error, retryable: false };
        body = form.form;
        headers = {}; // multipart: let fetch set the boundary content-type
      } else {
        body = JSON.stringify(built.body);
      }

      const res = await tokenRequest(
        "executeRelayWebhook",
        "POST",
        webhookPath(webhook, "?wait=true"),
        body,
        headers,
      );
      if (!res.ok) {
        return {
          ok: false,
          error: res.error,
          retryable: res.retryable,
          ...(res.code != null ? { code: res.code } : {}),
        };
      }
      // wait=true: the response body is the created message. A body without
      // an id is still a delivered send — surface messageId null (at-least-
      // once semantics own the unconfirmed-id case; §10.6).
      return {
        ok: true,
        messageId: res.payload?.id != null ? String(res.payload.id) : null,
      };
    },

    /**
     * Edit a message this webhook created (spike B5 gates platform support;
     * a refused PATCH surfaces as { ok: false } with the platform code).
     *
     * @param {{ id: string, token: string }} webhook RelayWebhook
     * @param {string} messageId
     * @param {{ content?: string, files?: Array<object> }} [options]
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async patchRelayMessage(webhook, messageId, options = {}) {
      const invalid = validateWebhook(webhook, "patchRelayMessage");
      if (invalid) return { ok: false, error: invalid };
      if (messageId == null || String(messageId) === "") {
        return { ok: false, error: "patchRelayMessage: a messageId is required" };
      }
      const built = buildBody(options, { forExecute: false });
      const filesPrep = prepareFiles(options, "patchRelayMessage");
      if (!filesPrep.ok) return { ok: false, error: filesPrep.error };

      let body;
      let headers = { "content-type": "application/json" };
      if (filesPrep.files.length > 0) {
        const form = buildMultipart(built.body, filesPrep.files, "patchRelayMessage");
        if (!form.ok) return { ok: false, error: form.error };
        body = form.form;
        headers = {};
      } else {
        body = JSON.stringify(built.body);
      }

      const res = await tokenRequest(
        "patchRelayMessage",
        "PATCH",
        webhookPath(webhook, `/messages/${encodeURIComponent(String(messageId))}`),
        body,
        headers,
      );
      if (!res.ok) {
        return { ok: false, error: res.error, ...(res.code != null ? { code: res.code } : {}) };
      }
      return { ok: true };
    },

    /**
     * Delete a message this webhook created. 404 counts as ok: the desired
     * end-state (message gone) is reached (§10.3).
     *
     * @param {{ id: string, token: string }} webhook RelayWebhook
     * @param {string} messageId
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async deleteRelayMessage(webhook, messageId) {
      const invalid = validateWebhook(webhook, "deleteRelayMessage");
      if (invalid) return { ok: false, error: invalid };
      if (messageId == null || String(messageId) === "") {
        return { ok: false, error: "deleteRelayMessage: a messageId is required" };
      }
      const res = await tokenRequest(
        "deleteRelayMessage",
        "DELETE",
        webhookPath(webhook, `/messages/${encodeURIComponent(String(messageId))}`),
        undefined,
        {},
      );
      if (!res.ok) {
        if (res.status === 404) return { ok: true }; // idempotent delete
        return { ok: false, error: res.error, ...(res.code != null ? { code: res.code } : {}) };
      }
      return { ok: true };
    },

    /**
     * Delete the webhook itself (disconnect cleanup). 404 counts as ok, and
     * per §10.3 the failure shape carries no platform code.
     *
     * @param {{ id: string, token: string }} webhook RelayWebhook
     * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
     */
    async deleteRelayWebhook(webhook) {
      const invalid = validateWebhook(webhook, "deleteRelayWebhook");
      if (invalid) return { ok: false, error: invalid };
      const res = await tokenRequest("deleteRelayWebhook", "DELETE", webhookPath(webhook), undefined, {});
      if (!res.ok) {
        if (res.status === 404) return { ok: true }; // idempotent delete
        return { ok: false, error: res.error };
      }
      return { ok: true };
    },
  };

  return api;
}

module.exports = { createFluxerWebhooks };
