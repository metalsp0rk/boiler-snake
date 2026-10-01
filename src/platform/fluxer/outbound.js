/**
 * Fluxer OutboundClient (roadmap/fluxer.md § Outbound client, 374–406) over the
 * handle's REST transport (contract 5: `handle.rest.request(method, path,
 * { body?, query? })` → data, SDK-Rest-compatible).
 *
 * Wire facts are the Phase 0 record (law): send = POST /v1/channels/{id}/messages
 * (JSON; embeds-only JSON accepted; PR 8 adds the file paths — multipart via
 * FormData/Blob and the presigned attachment flow, per spec § Embeds and
 * attachments), DM channel = POST /v1/users/@me/channels {recipient_id} (200,
 * idempotent), member = GET /v1/guilds/{g}/members/{u}, roles =
 * GET /v1/guilds/{g}/roles (permissions = decimal string), history =
 * GET /v1/channels/{c}/messages?before/after/limit (max 100), reactions =
 * PUT/DELETE /v1/channels/{c}/messages/{m}/reactions/{emoji}/@me.
 *
 * Contract (AGENTS.md § Error Handling 6): expected platform failures resolve
 * { ok:false, error } naming the method, target, and cause (status + API code
 * when the transport supplies them) — the bot token NEVER enters an error
 * string; services never throw for HTTP outcomes. `assertCommunityId`
 * violations throw: they are programmer errors, same as the Discord adapter.
 *
 * K8 / Phase 0: `addRole`, `removeRole`, `createChannel`, `setOverwrites`,
 * `banMember` are ELEVATED. While the community's `elevated_permissions` flag
 * is 0 (the default until Phase 0 open item 3 closes) they return
 * { ok:false, code:"elevated_disabled" } WITHOUT touching the network.
 * Reactions are NOT elevated in PR 6.
 */

const { assertCommunityId, getCommunityById, getCommunityByExternal } = require("../community");

/**
 * Specific, human-readable cause for a thrown value (never a token: transports
 * carry auth in headers, and no caller stringifies headers here).
 * @param {unknown} err
 * @returns {string}
 */
function causeOf(err) {
  return String(err?.message || err);
}

/**
 * API error code from a transport error (Fluxer codes are strings like
 * "RATE_LIMITED"; numeric codes stringify as such).
 * @param {unknown} err
 * @returns {string|undefined}
 */
function codeOf(err) {
  return err?.code != null ? String(err.code) : undefined;
}

/**
 * HTTP status from a transport error, when it exposes one.
 * @param {unknown} err
 * @returns {number|undefined}
 */
function statusOf(err) {
  const s = Number(err?.status ?? err?.statusCode);
  return Number.isFinite(s) && s > 0 ? s : undefined;
}

/**
 * "method: detail failed: cause (status N, code X)" — status and API code go
 * into the message per spec 404/630 so callers can act on the response.
 * @param {string} method
 * @param {string} detail
 * @param {unknown} err
 * @returns {string}
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
 * Map the platform-neutral allowedMentions onto the wire `allowed_mentions`
 * (Phase 0: maps 1:1 — `{parse: []}` sends `parse: []`, `{roles:[ids]}` sends
 * `roles: [...]`). Unknown keys are passed through 1:1.
 *
 * @param {object|undefined} allowedMentions
 * @returns {object|undefined}
 */
function toWireAllowedMentions(allowedMentions) {
  if (!allowedMentions || typeof allowedMentions !== "object") return undefined;
  return { ...allowedMentions };
}

/**
 * Build the JSON body for POST/PATCH message endpoints. Only defined fields
 * are sent (the API rejects some nulls; content and embeds pass through).
 *
 * @param {object} payload ReplyPayload-shaped
 * @param {string} method caller name for validation errors
 * @returns {{ ok: true, body: object }|{ ok: false, error: string }}
 */
function buildMessageBody(payload, method) {
  const body = {};
  if (payload.content != null) body.content = String(payload.content);
  if (payload.embeds != null) body.embeds = payload.embeds;
  const allowed = toWireAllowedMentions(payload.allowedMentions);
  if (allowed) body.allowed_mentions = allowed;
  if (payload.message_reference && payload.message_reference.message_id != null) {
    body.message_reference = { message_id: String(payload.message_reference.message_id) };
  } else if (payload.messageReference?.messageId != null) {
    body.message_reference = { message_id: String(payload.messageReference.messageId) };
  }
  if (payload.files != null && payload.files.length > 0) {
    // Files ride the SEND path only (spec § Embeds and attachments pins the
    // send typedef; PATCH has no recorded file shape). Name the cause.
    return {
      ok: false,
      error:
        `${method}: file attachments send via POST /channels/{id}/messages, not PATCH — ` +
        `edits carry content/embeds only.`,
    };
  }
  return { ok: true, body };
}

/**
 * Normalize one ReplyPayload `files` entry to { name, data, contentType } —
 * the shape src/platform/discord/outbound.js accepts (plain
 * { name, data: Buffer|string, contentType? } descriptors; the Discord adapter
 * wraps the same entries in AttachmentBuilder, Fluxer has no builder class).
 *
 * @param {unknown} file raw entry
 * @param {number} index position in the files array (named in rejections)
 * @param {string} method caller name for specific failures
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
  // Data sources: { name, data } plain payloads (string tolerated) AND
  // discord.js AttachmentBuilder instances, which handlers pass through
  // (handleLeaderboard's PNG file). AttachmentBuilder stores bytes on
  // `.attachment` (Buffer from canvas.toBuffer; typed arrays tolerated).
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
 * Map a URL to origin+pathname for LOGGING. A presigned upload_url carries its
 * grant in the query string — credentials never reach a log line (AGENTS.md).
 * @param {unknown} url
 * @returns {string}
 */
function urlForLog(url) {
  try {
    const u = new URL(String(url));
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(unusable URL)";
  }
}

/**
 * Build the Fluxer OutboundClient for one instance handle.
 *
 * @param {object} handle `{ instanceKey, rest, userId, fetchGuild(externalId), guildFetch(communityId, guildId), features? }`
 *   `features` is the discovery feature map; `presignedAttachmentUploads`
 *   selects the presigned file-send flow (spec 630: "a presigned upload when
 *   discovery features.presigned_attachment_uploads is true").
 * @param {{ fetch?: (url: string, init?: object) => Promise<any> }} [options]
 *   `fetch` overrides the transport used for presigned media PUTs (tests inject
 *   a fake; production reads globalThis.fetch at call time).
 * @returns {object} OutboundClient (spec § Outbound client typedef)
 */
function createFluxerOutbound(handle, { fetch: fetchOverride } = {}) {
  if (!handle || !handle.rest || typeof handle.rest.request !== "function") {
    throw new Error("createFluxerOutbound: handle.rest.request required");
  }
  const rest = handle.rest;
  const instanceKey = String(handle.instanceKey ?? "fluxer");

  /**
   * POST a message to a channel id with a JSON body. Shared by the JSON send
   * path (sendFluxerMessage) — the file paths post their own bodies.
   * @param {string} channelId
   * @param {object} body
   * @returns {Promise<{ ok: true, id: string }|{ ok: false, error: string, code?: string }>}
   */
  async function postMessage(channelId, body) {
    try {
      const data = await rest.request("POST", `/v1/channels/${channelId}/messages`, { body });
      return { ok: true, id: data?.id != null ? String(data.id) : "" };
    } catch (err) {
      return {
        ok: false,
        error: failureText("sendChannel", `send to channel ${channelId}`, err),
        ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
      };
    }
  }

  /**
   * The single send adapter (spec § Embeds and attachments, 610–634):
   * `sendChannel` / `sendDm` and the Fluxer command reply path all route here.
   * The implementation owns the wire format; handlers pass ReplyPayload only.
   *
   * - No files → JSON POST /v1/channels/{id}/messages (Phase 0: content and
   *   embeds accepted as JSON).
   * - Files + instance feature `presignedAttachmentUploads` → Phase 0 presigned
   *   flow: POST /v1/channels/{id}/attachments → PUT each `upload_url` (NO
   *   auth: "PUT bytes with no auth") → claim via message
   *   `attachments: [{ id, upload_filename }]`. Only the recorded
   *   `upload_mode: "singlepart"` runs (chunked is Phase 0 open item 5) —
   *   other modes return { ok:false } naming the mode.
   * - Files otherwise → multipart POST (Phase 0 PASS: `payload_json` +
   *   `files[i]` entries via the Node 18+ FormData/Blob globals).
   *
   * Every failure resolves { ok:false, error } naming method, target, and
   * cause — 413/400 responses carry the response status and the API error
   * code into the message (spec 630), never the token.
   *
   * @param {object} args
   * @param {string} [args.channelId] target channel (mutually exclusive with dmUserId)
   * @param {string} [args.dmUserId] recipient user for the K2 DM path
   * @param {string} [args.content]
   * @param {Array<object>} [args.embeds] plain embed objects (never builder classes)
   * @param {Array<{ name: string, data: Buffer|string, contentType?: string }>} [args.files]
   * @param {object} [args.allowedMentions]
   * @param {{ message_id?: string }|{ messageId?: string }} [args.message_reference]
   * @returns {Promise<{ ok: true, id: string }|{ ok: false, error: string, code?: string }>}
   */
  async function sendFluxerMessage(args) {
    const method = args.dmUserId != null ? "sendDm" : "sendChannel";
    if (args.dmUserId == null && (args.channelId == null || String(args.channelId) === "")) {
      return {
        ok: false,
        error: "sendChannel: args need a channelId (or dmUserId for the K2 DM path)",
      };
    }
    const body = {};
    if (args.content != null) body.content = String(args.content);
    if (args.embeds != null) body.embeds = args.embeds;
    const allowed = toWireAllowedMentions(args.allowedMentions);
    if (allowed) body.allowed_mentions = allowed;
    if (args.message_reference && args.message_reference.message_id != null) {
      body.message_reference = { message_id: String(args.message_reference.message_id) };
    } else if (args.messageReference?.messageId != null) {
      body.message_reference = { message_id: String(args.messageReference.messageId) };
    }

    // Files normalize BEFORE the first network call: a bad descriptor must
    // fail with its index named, not half-send a reply.
    const filesIn = Array.isArray(args.files) ? args.files : [];
    const files = [];
    if (filesIn.length > 0) {
      for (let i = 0; i < filesIn.length; i += 1) {
        const norm = normalizeSendFile(filesIn[i], i, method);
        if (!norm.ok) return { ok: false, error: norm.error };
        files.push(norm.file);
      }
    }

    // Resolve the target channel. DM (K2): open the DM channel first —
    // Phase 0: POST /v1/users/@me/channels is 200-idempotent, and success is
    // NOT recipient validation (open item 7); send-time codes are what surface.
    let channelId = args.channelId != null ? String(args.channelId) : "";
    if (args.dmUserId != null) {
      let dm;
      try {
        dm = await rest.request("POST", "/v1/users/@me/channels", {
          body: { recipient_id: String(args.dmUserId) },
        });
      } catch (err) {
        return {
          ok: false,
          error: failureText(method, `DM channel open for user ${args.dmUserId}`, err),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
      channelId = dm?.id != null ? String(dm.id) : "";
      if (!channelId) {
        return {
          ok: false,
          error: `${method}: opening a DM channel with user ${args.dmUserId} returned no channel id`,
        };
      }
    }
    const target = args.dmUserId != null ? `DM channel ${channelId}` : `channel ${channelId}`;

    // --- files + presigned feature flag: the Phase 0 presigned flow.
    if (files.length > 0 && handle.features?.presignedAttachmentUploads === true) {
      const fetchImpl =
        typeof fetchOverride === "function"
          ? fetchOverride
          : (url, init) => globalThis.fetch(url, init);
      let plan;
      try {
        plan = await rest.request("POST", `/v1/channels/${channelId}/attachments`, {
          body: {
            files: files.map((f) => ({
              filename: f.name,
              content_type: f.contentType,
              file_size: f.data.length,
            })),
          },
        });
      } catch (err) {
        return {
          ok: false,
          error: failureText(method, `attachment plan for ${target}`, err),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
      if (plan?.upload_mode != null && plan.upload_mode !== "singlepart") {
        return {
          ok: false,
          error:
            `${method}: attachment plan for ${target} uses upload_mode "${plan.upload_mode}", ` +
            `which is not supported (Phase 0 recorded "singlepart"; chunked is open item 5).`,
        };
      }
      const uploads = Array.isArray(plan?.uploads) ? plan.uploads : [];
      if (uploads.length !== files.length) {
        return {
          ok: false,
          error:
            `${method}: attachment plan for ${target} returned ${uploads.length} upload(s) ` +
            `for ${files.length} file(s) — refusing to claim a partial attachment set.`,
        };
      }
      for (let i = 0; i < files.length; i += 1) {
        const upload = uploads[i] ?? {};
        if (typeof upload.upload_url !== "string" || upload.upload_url.trim() === "") {
          return {
            ok: false,
            error:
              `${method}: attachment plan for ${target} has no upload_url for files[${i}] ` +
              `("${files[i].name}") — nothing was uploaded.`,
          };
        }
        try {
          // PUT the bytes with NO auth (Phase 0 law — the grant lives in the
          // signed URL, so it never enters a header, a log, or an error text).
          const put = await fetchImpl(upload.upload_url, {
            method: "PUT",
            body: new Uint8Array(files[i].data),
            headers: { "content-type": files[i].contentType },
          });
          if (put && put.ok === false) {
            return {
              ok: false,
              error:
                `${method}: presigned upload ${i} for ${target} failed: HTTP ${put.status} ` +
                `(PUT ${urlForLog(upload.upload_url)})`,
            };
          }
        } catch (err) {
          return {
            ok: false,
            error: `${method}: presigned upload ${i} for ${target} failed: ${causeOf(err)} (PUT ${urlForLog(upload.upload_url)})`,
          };
        }
      }
      try {
        const data = await rest.request("POST", `/v1/channels/${channelId}/messages`, {
          body: {
            ...body,
            // Claim the uploads by position: { id: <index>, upload_filename }
            // — the exact shape Phase 0 ran end to end.
            attachments: files.map((f, i) => ({
              id: i,
              upload_filename: uploads[i].upload_filename,
            })),
          },
        });
        return { ok: true, id: data?.id != null ? String(data.id) : "" };
      } catch (err) {
        return {
          ok: false,
          error: failureText(method, `send to ${target}`, err),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    }

    // --- files, no presigned flag: multipart POST (Phase 0 PASS: a
    // payload_json part plus files[i] parts, FormData/Blob Node 18+ globals).
    if (files.length > 0) {
      let form;
      try {
        form = new FormData();
        form.append("payload_json", JSON.stringify(body));
        files.forEach((f, i) => {
          form.append(`files[${i}]`, new Blob([new Uint8Array(f.data)], { type: f.contentType }), f.name);
        });
      } catch (err) {
        return {
          ok: false,
          error: `${method}: multipart send to ${target} failed: ${causeOf(err)}`,
        };
      }
      try {
        const data = await rest.request("POST", `/v1/channels/${channelId}/messages`, {
          body: form,
        });
        return { ok: true, id: data?.id != null ? String(data.id) : "" };
      } catch (err) {
        return {
          ok: false,
          error: failureText(method, `send to ${target}`, err),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    }

    // --- JSON path (no files): the Phase 0-confirmed JSON send.
    return postMessage(channelId, body);
  }

  /**
   * Elevated gate (K8): true when the community's `elevated_permissions` flag
   * is not 1. Flag 0 (every new Fluxer row, Phase 0) keeps role/channel/ban
   * writes off; the reason string is the user-visible cause.
   *
   * @param {number} communityId
   * @param {string} method
   * @returns {Promise<{ blocked: true, error: string }|{ blocked: false }>}
   */
  async function elevatedBlocked(communityId, method) {
    let row = null;
    try {
      row = getCommunityById(communityId);
    } catch (err) {
      return {
        blocked: true,
        error: `${method}: ${causeOf(err)}`,
      };
    }
    if (!row) {
      return {
        blocked: true,
        error: `${method}: no communities row for id ${communityId}`,
      };
    }
    if (Number(row.elevatedPermissions) !== 1) {
      return {
        blocked: true,
        error:
          `${method}: elevated Fluxer actions are disabled for community ${communityId} ` +
          `(elevated_permissions=${Number(row.elevatedPermissions) || 0}). ` +
          `They unlock when Phase 0 records the MFA/2FA result for instance ${instanceKey}.`,
      };
    }
    return { blocked: false };
  }

  /**
   * Resolve a community id to its external guild id for guild-scoped endpoints.
   * @param {number} communityId
   * @param {string} method
   * @returns {{ externalGuildId: string }|{ error: string }}
   */
  function resolveGuild(communityId, method) {
    const row = getCommunityById(communityId);
    if (!row) return { error: `${method}: no communities row for id ${communityId}` };
    if (!row.externalGuildId) {
      return { error: `${method}: community ${communityId} has no external guild id` };
    }
    return { externalGuildId: String(row.externalGuildId) };
  }

  const outbound = {
    platform: "fluxer",
    instanceKey,
    // The single send adapter (spec § Embeds and attachments): exposed for
    // the send-path consumers (sendChannel/sendDm delegate to it).
    sendFluxerMessage,
    get botUserId() {
      return handle.userId != null ? String(handle.userId) : "";
    },

    /**
     * @param {number} communityId
     * @returns {Promise<{ id: string, name: string, ownerId: string|null, afkChannelId: string|null }|null>}
     */
    async fetchGuild(communityId) {
      assertCommunityId(communityId);
      const found = resolveGuild(communityId, "fetchGuild");
      if (found.error) {
        console.error(`[fluxer] fetchGuild ${found.error}`);
        return null;
      }
      try {
        return (await handle.fetchGuild?.(found.externalGuildId)) ?? null;
      } catch (err) {
        console.error(
          `[fluxer] fetchGuild community ${communityId} guild ${found.externalGuildId} failed: ${causeOf(err)}`,
        );
        return null;
      }
    },

    /**
     * @param {number} communityId
     * @param {string} channelId
     * @returns {Promise<{ id: string, type: number|null, permissionOverwrites: object[]|null }|null>}
     */
    async fetchChannel(communityId, channelId) {
      assertCommunityId(communityId);
      try {
        const d = await rest.request("GET", `/v1/channels/${String(channelId)}`);
        if (!d || typeof d !== "object") return null;
        return {
          id: String(d.id ?? channelId),
          type: typeof d.type === "number" ? d.type : (d.type ?? null),
          permissionOverwrites: d.permission_overwrites ?? null,
        };
      } catch (err) {
        console.error(
          `[fluxer] fetchChannel community ${communityId} channel ${channelId} failed: ${causeOf(err)}`,
        );
        return null;
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @returns {Promise<{ id: string, username: string, bot: boolean }|null>}
     */
    async fetchUser(communityId, userId) {
      assertCommunityId(communityId);
      try {
        const d = await rest.request("GET", `/v1/users/${String(userId)}`);
        if (!d || typeof d !== "object") return null;
        return {
          id: String(d.id ?? userId),
          username: d.username ?? "",
          bot: Boolean(d.bot),
        };
      } catch (err) {
        console.error(
          `[fluxer] fetchUser community ${communityId} user ${userId} failed: ${causeOf(err)}`,
        );
        return null;
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @returns {Promise<{ id: string, username: string, bot: boolean, roleIds: string[] }|null>} MemberHandle
     */
    async fetchMember(communityId, userId) {
      assertCommunityId(communityId);
      const found = resolveGuild(communityId, "fetchMember");
      if (found.error) {
        console.error(`[fluxer] fetchMember ${found.error}`);
        return null;
      }
      try {
        const d = await rest.request(
          "GET",
          `/v1/guilds/${found.externalGuildId}/members/${String(userId)}`,
        );
        if (!d || typeof d !== "object") return null;
        return {
          id: String(d.user?.id ?? d.id ?? userId),
          username: d.user?.username ?? "",
          bot: Boolean(d.user?.bot),
          roleIds: (Array.isArray(d.roles) ? d.roles : []).map(String),
        };
      } catch (err) {
        console.error(
          `[fluxer] fetchMember community ${communityId} user ${userId} failed: ${causeOf(err)}`,
        );
        return null;
      }
    },

    /**
     * @param {number} communityId
     * @returns {Promise<Array<{ id: string, name: string, position: number, permissions: string }>>}
     *   RoleHandle[] — permissions is a decimal string, never a JS number.
     */
    async fetchRoles(communityId) {
      assertCommunityId(communityId);
      const found = resolveGuild(communityId, "fetchRoles");
      if (found.error) {
        console.error(`[fluxer] fetchRoles ${found.error}`);
        return [];
      }
      try {
        const rows = await rest.request("GET", `/v1/guilds/${found.externalGuildId}/roles`);
        if (!Array.isArray(rows)) return [];
        return rows
          .filter((r) => r && typeof r === "object" && r.id != null)
          .map((r) => ({
            id: String(r.id),
            name: r.name ?? "",
            position: r.position ?? 0,
            // Decimal string at the boundary (spec 400): a 64-bit mask string
            // passes through untouched; numbers stringify to decimal.
            permissions: String(r.permissions ?? "0"),
          }));
      } catch (err) {
        console.error(`[fluxer] fetchRoles community ${communityId} failed: ${causeOf(err)}`);
        return [];
      }
    },

    /**
     * @param {string} channelId
     * @param {object|string} payload ReplyPayload (files: [{ name, data, contentType? }])
     * @returns {Promise<{ ok: true, id: string }|{ ok: false, error: string, code?: string }>}
     */
    async sendChannel(channelId, payload) {
      const p = typeof payload === "string" ? { content: payload } : (payload ?? {});
      return sendFluxerMessage({
        channelId: String(channelId),
        content: p.content,
        embeds: p.embeds,
        files: p.files,
        allowedMentions: p.allowedMentions,
        message_reference: p.message_reference ?? p.messageReference,
      });
    },

    /**
     * K2 DM: open the DM channel (Phase 0: POST /v1/users/@me/channels is
     * 200-idempotent), then post there — files included (the /warn export
     * markdown rides the same adapter, matrix 687). Channel-create success is
     * NOT recipient validation (Phase 0 open item 7) — send-time codes are
     * what surface.
     *
     * @param {string} userId
     * @param {object|string} payload ReplyPayload
     * @returns {Promise<{ ok: true, id: string }|{ ok: false, error: string, code?: string }>}
     */
    async sendDm(userId, payload) {
      const p = typeof payload === "string" ? { content: payload } : (payload ?? {});
      const sent = await sendFluxerMessage({
        dmUserId: String(userId),
        content: p.content,
        embeds: p.embeds,
        files: p.files,
        allowedMentions: p.allowedMentions,
        message_reference: p.message_reference ?? p.messageReference,
      });
      if (!sent.ok) {
        // Keep the PR 6 error identity: a failing DM post names sendDm, not
        // the generic send label (context.js's K2 fallback surfaces this
        // string verbatim to the channel, AGENTS.md rule 3).
        return {
          ok: false,
          error: sent.error.replace("sendChannel:", "sendDm:"),
          ...(sent.code != null ? { code: sent.code } : {}),
        };
      }
      return sent;
    },

    /**
     * @param {{ communityId: number, channelId: string, messageId: string }} ref
     * @param {object|string} payload ReplyPayload
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async editMessage(ref, payload) {
      assertCommunityId(ref?.communityId);
      const built = buildMessageBody(
        typeof payload === "string" ? { content: payload } : (payload ?? {}),
        "editMessage",
      );
      if (!built.ok) return { ok: false, error: built.error };
      try {
        await rest.request(
          "PATCH",
          `/v1/channels/${String(ref.channelId)}/messages/${String(ref.messageId)}`,
          { body: built.body },
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: failureText(
            "editMessage",
            `edit ${ref?.messageId} in channel ${ref?.channelId}`,
            err,
          ),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @param {string} roleId
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async addRole(communityId, userId, roleId) {
      assertCommunityId(communityId);
      const gate = await elevatedBlocked(communityId, "addRole");
      if (gate.blocked) return { ok: false, error: gate.error, code: "elevated_disabled" };
      const found = resolveGuild(communityId, "addRole");
      if (found.error) return { ok: false, error: found.error };
      try {
        await rest.request(
          "PUT",
          `/v1/guilds/${found.externalGuildId}/members/${String(userId)}/roles/${String(roleId)}`,
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: failureText(
            "addRole",
            `role ${roleId} for user ${userId} in community ${communityId}`,
            err,
          ),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @param {string} roleId
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async removeRole(communityId, userId, roleId) {
      assertCommunityId(communityId);
      const gate = await elevatedBlocked(communityId, "removeRole");
      if (gate.blocked) return { ok: false, error: gate.error, code: "elevated_disabled" };
      const found = resolveGuild(communityId, "removeRole");
      if (found.error) return { ok: false, error: found.error };
      try {
        await rest.request(
          "DELETE",
          `/v1/guilds/${found.externalGuildId}/members/${String(userId)}/roles/${String(roleId)}`,
          // Phase 0: DELETE role endpoints are 204-idempotent, no body required.
          { body: {} },
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: failureText(
            "removeRole",
            `role ${roleId} for user ${userId} in community ${communityId}`,
            err,
          ),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    },

    /**
     * @param {string} channelId
     * @param {string} messageId
     * @param {string} emojiKey
     * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
     */
    async addReaction(channelId, messageId, emojiKey) {
      try {
        await rest.request(
          "PUT",
          `/v1/channels/${String(channelId)}/messages/${String(messageId)}/reactions/${encodeURIComponent(String(emojiKey))}/@me`,
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: failureText(
            "addReaction",
            `${emojiKey} on message ${messageId} in channel ${channelId}`,
            err,
          ),
        };
      }
    },

    /**
     * @param {string} channelId
     * @param {string} messageId
     * @param {string} emojiKey
     * @param {string} userId
     * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
     */
    async removeUserReaction(channelId, messageId, emojiKey, userId) {
      const who =
        userId == null || String(userId) === "@me" || String(userId) === outbound.botUserId
          ? "@me"
          : String(userId);
      try {
        await rest.request(
          "DELETE",
          `/v1/channels/${String(channelId)}/messages/${String(messageId)}/reactions/${encodeURIComponent(String(emojiKey))}/${who}`,
          { body: {} },
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: failureText(
            "removeUserReaction",
            `${emojiKey} by user ${who} on message ${messageId} in channel ${channelId}`,
            err,
          ),
        };
      }
    },

    /**
     * Clears every user's reaction for one emoji (panel reset).
     * @param {string} channelId
     * @param {string} messageId
     * @param {string} emojiKey
     * @returns {Promise<{ ok: true }|{ ok: false, error: string }>}
     */
    async removeEmojiReaction(channelId, messageId, emojiKey) {
      try {
        await rest.request(
          "DELETE",
          `/v1/channels/${String(channelId)}/messages/${String(messageId)}/reactions/${encodeURIComponent(String(emojiKey))}`,
          { body: {} },
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: failureText(
            "removeEmojiReaction",
            `${emojiKey} on message ${messageId} in channel ${channelId}`,
            err,
          ),
        };
      }
    },

    /**
     * @param {{ communityId: number, name: string, parentId: string|null, type: number, overwrites: object[] }} args CreateChannelArgs
     * @returns {Promise<{ ok: true, id: string }|{ ok: false, error: string, code?: string }>}
     */
    async createChannel(args) {
      const communityId = args?.communityId;
      assertCommunityId(communityId);
      const gate = await elevatedBlocked(communityId, "createChannel");
      if (gate.blocked) return { ok: false, error: gate.error, code: "elevated_disabled" };
      const found = resolveGuild(communityId, "createChannel");
      if (found.error) return { ok: false, error: found.error };
      try {
        const d = await rest.request("POST", `/v1/guilds/${found.externalGuildId}/channels`, {
          body: {
            name: String(args.name ?? ""),
            type: args.type,
            ...(args.parentId != null ? { parent_id: String(args.parentId) } : {}),
            // Phase 0: the wire field is `type` (0 role, 1 member), NOT `kind`.
            permission_overwrites: (args.overwrites ?? []).map((ow) => ({
              id: String(ow.id),
              type: ow.kind === "member" ? 1 : 0,
              allow: String(ow.allow ?? "0"),
              deny: String(ow.deny ?? "0"),
            })),
          },
        });
        return { ok: true, id: d?.id != null ? String(d.id) : "" };
      } catch (err) {
        return {
          ok: false,
          error: failureText("createChannel", `"${args?.name}" in community ${communityId}`, err),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    },

    /**
     * @param {string} channelId
     * @param {Array<{ id: string, kind: "role"|"member", allow: string, deny: string }>} overwrites ChannelOverwrite[]
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, skipped: Array<{ id: string, reason: string }> }>}
     */
    async setOverwrites(channelId, overwrites) {
      const list = (overwrites ?? []).map((ow) => ({
        id: String(ow.id),
        type: ow.kind === "member" ? 1 : 0,
        allow: String(ow.allow ?? "0"),
        deny: String(ow.deny ?? "0"),
      }));
      // The elevated check resolves the channel's community from the wire object
      // (setOverwrites is guild-scoped, the typedef takes only a channel id).
      const cid = await this.communityIdForChannel(channelId);
      if (cid == null) {
        return {
          ok: false,
          error: `setOverwrites: cannot resolve the community owning channel ${channelId}`,
          skipped: list.map((ow) => ({ id: ow.id, reason: "community unresolved" })),
        };
      }
      const gate = await elevatedBlocked(cid, "setOverwrites");
      if (gate.blocked) {
        return {
          ok: false,
          error: gate.error,
          code: "elevated_disabled",
          skipped: list.map((ow) => ({ id: ow.id, reason: "elevated_permissions=0" })),
        };
      }
      try {
        await rest.request("PUT", `/v1/channels/${String(channelId)}`, {
          body: { permission_overwrites: list },
        });
        return { ok: true };
      } catch (err) {
        const reason = failureText("setOverwrites", `applying ${list.length} overwrite(s) to channel ${channelId}`, err);
        return { ok: false, error: reason, skipped: list.map((ow) => ({ id: ow.id, reason })) };
      }
    },

    /**
     * @param {number} communityId
     * @param {string} userId
     * @param {string} reason
     * @returns {Promise<{ ok: true }|{ ok: false, error: string, code?: string }>}
     */
    async banMember(communityId, userId, reason) {
      assertCommunityId(communityId);
      const gate = await elevatedBlocked(communityId, "banMember");
      if (gate.blocked) return { ok: false, error: gate.error, code: "elevated_disabled" };
      const found = resolveGuild(communityId, "banMember");
      if (found.error) return { ok: false, error: found.error };
      try {
        await rest.request("PUT", `/v1/guilds/${found.externalGuildId}/bans/${String(userId)}`, {
          body: { reason: String(reason ?? "") },
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: failureText("banMember", `user ${userId} in community ${communityId}`, err),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
    },

    /**
     * History page (activity backfill / gork read_history). Phase 0 confirmed
     * `before`/`after`/`limit≤100` on GET /v1/channels/{c}/messages.
     *
     * @param {string} channelId
     * @param {{ before?: string, after?: string, limit: number }} query
     * @returns {Promise<{ ok: true, messages: Array<{ id: string, authorId: string|null, authorBot: boolean, content: string, createdAt: string|null }> }|{ ok: false, error: string, code?: string }>}
     */
    async fetchMessages(channelId, query = {}) {
      const limit = Number.isSafeInteger(query?.limit) ? query.limit : 100;
      const q = { limit };
      if (query?.before) q.before = String(query.before);
      if (query?.after) q.after = String(query.after);
      let rows;
      try {
        rows = await rest.request("GET", `/v1/channels/${String(channelId)}/messages`, { query: q });
      } catch (err) {
        return {
          ok: false,
          error: failureText("fetchMessages", `history for channel ${channelId}`, err),
          ...(codeOf(err) != null ? { code: codeOf(err) } : {}),
        };
      }
      if (!Array.isArray(rows)) {
        return {
          ok: false,
          error: `fetchMessages: history for channel ${channelId} returned a non-array body`,
        };
      }
      return {
        ok: true,
        messages: rows.map((m) => ({
          id: String(m.id),
          authorId: m.author?.id != null ? String(m.author.id) : null,
          authorBot: Boolean(m.author?.bot),
          content: m.content ?? "",
          createdAt: m.timestamp ?? null,
        })),
      };
    },

    /**
     * Resolve the community owning a channel (Phase 0: GET /v1/channels/{id}
     * → `community_id`, guild id alias `guild_id` tolerated). Exposed because
     * ticket tooling resolves channel ownership.
     *
     * @param {string} channelId
     * @returns {Promise<number|null>}
     */
    async communityIdForChannel(channelId) {
      let d = null;
      try {
        d = await rest.request("GET", `/v1/channels/${String(channelId)}`);
      } catch (err) {
        console.error(
          `[fluxer] communityIdForChannel ${channelId} failed: ${causeOf(err)}`,
        );
        return null;
      }
      const external = d?.community_id ?? d?.guild_id ?? null;
      if (external == null) return null;
      const row = getCommunityByExternal("fluxer", instanceKey, String(external));
      return row ?? null;
    },
  };

  return outbound;
}

module.exports = { createFluxerOutbound };
