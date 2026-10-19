/**
 * #466 (FLX-9): the ONE home for the adapter error/file utility set.
 *
 * causeOf/codeOf/statusOf/failureText/normalizeSendFile/validateWebhook/
 * toNumberOrNull/toIdOrNull/toIsoString/mapStickerList lived as 2–5
 * verbatim-or-near-verbatim copies across fluxer/outbound, fluxer/webhooks,
 * discord/outbound, discord/webhooks and discord/normalize (the fluxer
 * webhooks module even self-documented the copy: "mirrored here so the
 * webhook module stands alone"). Every future fix — a retry_after parse, a
 * file-descriptor validation change — had to be replicated 3–4×: this
 * module is where it happens ONCE now (the BRG-14 lesson, applied before
 * the drift the audit's earlier bundles kept finding).
 *
 * Unification notes (bodies otherwise verbatim from fluxer/outbound):
 * - statusOf took `err` in outbound and `value` in fluxer/webhooks — same
 *   behavior, one parameter name;
 * - mapStickerList used `instanceof Map` in fluxer/outbound but duck-typed
 *   `values()` in the discord copies — the duck form (a superset: arrays,
 *   Maps, discord.js Collections) ships everywhere;
 * - normalizeSendFile (Fluxer wire form { name, data, contentType }) and
 *   toDiscordFile (discord.js AttachmentBuilder form { attachment, name,
 *   contentType? }) keep their distinct SHAPES — the platforms genuinely
 *   differ — but the name rule and byte coercion live in one place now.
 */

/** Deepest Error.cause message in the chain (empty string when absent). */
function causeOf(err) {
  return String(err?.message || err);
}

/** API error code (Fluxer `code` / discord `code`) as string, or undefined. */
function codeOf(err) {
  return err?.code != null ? String(err.code) : undefined;
}

/** HTTP status (status/statusCode) as finite positive number, else undefined. */
function statusOf(value) {
  const s = Number(value?.status ?? value?.statusCode);
  return Number.isFinite(s) && s > 0 ? s : undefined;
}

/** Standard `{method}: {detail} ({cause} {status} {code})` failure sentence for error replies. */
function failureText(method, detail, err) {
  const bits = [];
  const status = statusOf(err);
  const code = codeOf(err);
  if (status != null) bits.push(`status ${status}`);
  if (code != null) bits.push(`code ${code}`);
  const suffix = bits.length ? ` (${bits.join(", ")})` : "";
  return `${method}: ${detail} failed: ${causeOf(err)}${suffix}`;
}

/** Numeric relay fields (size, flags): finite numbers and bigint BitFields → number; anything else → null (never a lossy 0). Idempotent. */
function toNumberOrNull(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw =
    value && typeof value === "object" && typeof value.valueOf === "function"
      ? value.valueOf()
      : null;
  if (typeof raw === "bigint") return Number(raw);
  return null;
}

/** id → non-empty string, else null. */
function toIdOrNull(value) {
  return value != null ? String(value) : null;
}

/** Date/epoch-ms/ISO string → ISO string, else null. */
function toIsoString(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Sticker Collection/array/Map → [{ id, name }] (duck-typed `values()` accepted). Idempotent. */
function mapStickerList(value) {
  const list =
    Array.isArray(value) ? value : typeof value?.values === "function" ? [...value.values()] : [];
  return list
    .filter((s) => s && typeof s === "object" && s.id != null)
    .map((s) => ({ id: String(s.id), name: s.name ?? null }));
}

/** Fluxer file-descriptor validation → { ok, file: { name, data(Buffer), contentType } } or { ok:false, error } naming the index. */
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

/** discord.js file-descriptor validation → { ok, file: { attachment(Buffer), name, contentType? } } (AttachmentBuilder-shaped). */
function toDiscordFile(file, index, method) {
  const name = typeof file?.name === "string" && file.name !== "" ? file.name : null;
  if (name == null) {
    return {
      ok: false,
      error: `${method}: files[${index}] needs a non-empty string name (files entries are { name, data, contentType? })`,
    };
  }
  let attachment = null;
  const raw = file?.data ?? file?.attachment;
  if (Buffer.isBuffer(raw)) attachment = raw;
  else if (typeof raw === "string") attachment = Buffer.from(raw, "utf8");
  else if (raw instanceof ArrayBuffer) attachment = Buffer.from(new Uint8Array(raw));
  else if (ArrayBuffer.isView(raw)) attachment = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (attachment == null) {
    return {
      ok: false,
      error:
        `${method}: files[${index}] ("${name}") needs Buffer data, got ` +
        `${raw == null ? String(raw) : typeof raw}`,
    };
  }
  const entry = { attachment, name };
  if (typeof file.contentType === "string" && file.contentType !== "") {
    entry.contentType = file.contentType;
  }
  return { ok: true, file: entry };
}

/** Webhook handle check: {ok:false, error} unless it is an object with id + token strings. */
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


module.exports = {
  causeOf,
  codeOf,
  statusOf,
  failureText,
  toNumberOrNull,
  toIdOrNull,
  toIsoString,
  mapStickerList,
  normalizeSendFile,
  toDiscordFile,
  validateWebhook,
};
