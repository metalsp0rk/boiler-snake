/**
 * Ban-appeal proxy-chat ferry engine (#773 §3 + §6) — the COMPLETE relay law.
 *
 * Both directions between the banned user's DM and the private staff ticket.
 * This module is the ENGINE ONLY: it never binds listeners (banAppeals/events
 * JS — subtask 07 — owns the client listeners, resolving the appeal row and
 * the channel/DM message sources, then drives the three entry points below).
 * Messages are PLAIN-OBJECT DUCKS (`{ id, content, author, attachments, … }`),
 * never discord.js classes: the offline harness and the pure units (10) drive
 * the exact same code paths with bare literals.
 *
 * ── §3 LOCKED LAW TABLE (every row lands here) ─────────────────────────────
 *  Never ferry bots:   bot-authored (incl. the bot's OWN relays — loop-proof),
 *                      webhook, and self-authored messages are never relayed,
 *                      silently. TWO belts: the author/webhook/self check and
 *                      a bounded in-memory guard of message ids this engine
 *                      itself sent (noteRelayedMessageId).
 *  User → ticket:      `**<escaped username · id>:** <text>` + attachments.
 *                      Never a guild mention: the name rides escaped
 *                      (markdownEscape) and every send carries
 *                      allowedMentions { parse: [] }.
 *  Ticket → user:      `**<staff display name>:** <text>` — display name only,
 *                      NO id in the copy (issue §3). Plain human-authored
 *                      messages only; system messages (type ≠ 0) never.
 *                      Never the moderator's identity from ban metadata (§6):
 *                      the header names only the AUTHOR of the relayed
 *                      message; ban-record fields never enter a relay.
 *  Payloads:           text, images, video ONLY. audio/voice, stickers, polls,
 *                      forwarded messages (FIELD_REFS / snapshots),
 *                      component/action messages, and embed-only messages
 *                      (no content, no attachments, embeds present) are NOT
 *                      shared — the SENDER gets the specific per-kind "not
 *                      shared" notice naming what was dropped; the other side
 *                      stays silent. Empty (text-less, attachment-less) and
 *                      system messages drop silently.
 *  Reactions/edits/    ENGINE IS ADD-ONLY: there are NO messageUpdate /
 *  deletes:            messageDelete / messageReaction handlers here, by law
 *                      (issue §3 "add-only relay"). 07 binds MessageCreate
 *                      ONLY — nothing else can ferry.
 *  Durability:         attachments are RE-HOSTED (bytes fetched through the
 *                      shared SSRF guard and re-uploaded as {name, data} file
 *                      descriptors on the send) so relays survive original
 *                      deletion. LOCKED DEVIATION from mirrorTicketAssets:
 *                      that pipeline downloads to the web-transcript asset
 *                      tree for archived serving — live ferry relay needs
 *                      in-memory buffers on the send instead, so this module
 *                      reuses the FETCH discipline (downloadGuarded, declared-
 *                      size pre-skip, per-file partial failure) but re-uploads
 *                      from the buffer. Cap FERRY_ATTACHMENT_MAX_BYTES (8 MB)
 *                      per attachment: over-cap gets a SPECIFIC refusal to
 *                      the sender naming the size; bytes are never truncated.
 *  Ordering/resume:    one persisted (message id, created_at) cursor PAIR per
 *                      direction (banAppeals repo — save always writes both
 *                      halves). The cursor advances ONLY AFTER a successful
 *                      send (resume-skip law: half-sent relays replay, never
 *                      silently skip). Boot catch-up replays messages STRICTLY
 *                      after the cursor pair, ordered by created_at THEN id
 *                      (id monotonicity is NOT assumed), bounded by
 *                      FERRY_CATCHUP_MAX; any single failure STOPS at that
 *                      message (no skip-ahead) and reports it.
 *  Flooding:           user-side only: FERRY_USER_COOLDOWN_MS spacing +
 *                      FERRY_USER_HOURLY_CAP per rolling hour, keyed per
 *                      appeal id in memory (a restart resets the ledger — the
 *                      persisted cursors already prevent relay REPLAY, so the
 *                      worst reset case is a one-message-per-event cooldown
 *                      miss, never a re-relay). Drops are specific to the
 *                      SENDER (throttled so the notice itself cannot storm)
 *                      and silent to staff. Staff-side relies on the existing
 *                      channel cooldowns — no second ledger.
 *
 * ── §6 privacy ─────────────────────────────────────────────────────────────
 *  Only PLAIN AUTHORED MESSAGES ever travel: bot-authored content (the header
 *  embed card, system cards, other bots) is dropped by the loop-proof gate,
 *  embeds are never carried on a relay, and ban-record metadata (moderator
 *  ids, automod case ids, warning/staff-note bodies) is never interpolated —
 *  this module does not even read the ban record.
 *
 * ── error contract (AGENTS.md rules 2/3/5/6) ───────────────────────────────
 *  Every exported function NEVER THROWS and reports { ok:false, error } with
 *  a specific cause; every failure logs `[appeals] … community= record=
 *  appeal= user= ticket=` ids. Partial failures (per-file fetch, notice send)
 *  report partial results — the relay carries what survived plus one specific
 *  notice per dropped part.
 *
 * ── cursor semantics (what 07 + 10 may rely on) ────────────────────────────
 *  • A cursor pair advances ONLY when ALL chunks of that one relayed message
 *    sent successfully. Multi-part messages resend from part 1 after a crash
 *    (bounded duplicate risk, logged).
 *  • Blocked/empty/system/loop messages do NOT advance the cursor (they were
 *    never relayed — there is nothing to resume past). A restart within the
 *    catch-up bound can therefore RE-NOTICE an already-blocked message; it
 *    can never RE-RELAY content. Accepted and documented.
 *  • Flood/blocked live messages sit behind the cursor; a later boot catch-up
 *    (bounded) is the one case that replays them — the relay paths re-run the
 *    full law on each, so the outcome is identical modulo notice timing.
 */

const { escapeDisplayName } = require("./markdownEscape");
const { safeCutIndex } = require("../../core/text");
const { downloadGuarded } = require("../../core/ssrfGuard");
// sanitizeFilename + mediaKind are the shipped classification/file-safety law
// (tickets/assets.js). The markdownEscape → reportEvidence → assets chain is
// already loaded at require time by this feature, so this direct require
// adds no new boot weight and keeps ONE mediaKind + ONE filename law.
const { sanitizeFilename, mediaKind } = require("../tickets/assets");
const {
  LOG_PREFIX,
  FERRY_ATTACHMENT_MAX_BYTES,
  FERRY_USER_COOLDOWN_MS,
  FERRY_USER_HOURLY_CAP,
  FERRY_CATCHUP_MAX,
} = require("./constants");

/* ── Module-local constants (platform mirrors, not policy knobs) ────────────
 * The FERRY_* POLICY caps live in constants.js (acceptance: no new env vars,
 * no policy const invented here). These three mirror hard platform limits or
 * guard shapes and are therefore local and pinned. */

/** Discord's hard 10-files-per-message cap — the relay must not exceed it. */
const RELAY_MAX_FILES = 10;

/** Safety margin under Discord's 2000-char content cap for one relay chunk. */
const RELAY_CHUNK_CHARS = 1800;

/** Relay echo guard size: bounded FIFO of outbound ids this engine produced. */
const RELAYED_ID_GUARD_MAX = 500;

/** MessageFlags.FieldRefs — set on forwarded messages (issue §3 row). */
const FLAG_FIELD_REFS = 1 << 15;
/** MessageFlags.IsVoiceMessage — an audio attachment that is a voice memo. */
const FLAG_IS_VOICE = 1 << 13;
/** Attachment flags: same bit meanings as message flags on attachments. */
const ATTACHMENT_FLAG_IS_VOICE = FLAG_IS_VOICE;

/** Snowflake epoch (ms) — created_at fallback derived from the id (#first-sight). */
const DISCORD_EPOCH_MS = 1420070400000n;

/**
 * Ferry directions — mirrors the repo's FERRY_DIRECTIONS (repositories/
 * banAppeals.js). Mirrored locally (not required) so this engine module
 * touches no SQLite at require time; the repo re-validates direction on save.
 */
const FERRY_DIRECTIONS = Object.freeze(["user", "ticket"]);

/** Hourly window for the flood ledger (one rolling hour). */
const HOURLY_MS = 60 * 60 * 1000;

/* ── Tolerant readers (plain-object duck shapes; nothing here throws) ────── */

function toText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function optionalText(value) {
  const t = toText(value);
  if (t == null) return null;
  const trimmed = t.trim();
  return trimmed === "" ? null : trimmed;
}

/** Iterates arrays, Maps/Collections (.values()), other iterables → array. */
function toArrayLike(container) {
  if (Array.isArray(container)) return container;
  if (container == null) return [];
  if (typeof container.values === "function") {
    try {
      return [...container.values()];
    } catch {
      return [];
    }
  }
  if (typeof container[Symbol.iterator] === "function") {
    try {
      return [...container];
    } catch {
      return [];
    }
  }
  return [];
}

/** BitField (has), bigint, or number flag holder → is `bit` set? */
function flagSet(flags, bit) {
  if (flags == null) return false;
  if (typeof flags.has === "function") {
    try {
      return Boolean(flags.has(bit));
    } catch {
      return false;
    }
  }
  if (typeof flags === "bigint") return Boolean(flags & BigInt(bit));
  if (typeof flags === "number") return Boolean(flags & bit);
  return false;
}

/** Snowflake → ms (null for anything non-numeric; the harness may fake ids). */
function snowflakeToMs(id) {
  try {
    const n = BigInt(String(id ?? ""));
    if (n <= 0n) return null;
    return Number((n >> 22n) + DISCORD_EPOCH_MS);
  } catch {
    return null;
  }
}

/**
 * created_at for a duck-shaped message, ms epoch (or null): the discord.js
 * field first, then the raw/ISO timestamp, then the snowflake itself. Catch-up
 * ordering and the cursor pair ride this ONE reader.
 */
function messageTimestampMs(message) {
  const ct = Number(message?.createdTimestamp);
  if (Number.isFinite(ct) && ct > 0) return Math.floor(ct);
  const t = message?.timestamp;
  if (typeof t === "number" && Number.isFinite(t) && t > 0) return Math.floor(t);
  if (t instanceof Date) {
    const ms = t.getTime();
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  if (typeof t === "string") {
    const parsed = Date.parse(t);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return snowflakeToMs(message?.id);
}

/** Snowflake-order compare with a lexicographic fallback (messageWindow law). */
function compareIds(a, b) {
  try {
    const x = BigInt(String(a));
    const y = BigInt(String(b));
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  } catch {
    return String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;
  }
}

/* ── Relay copy (issue §3: every notice names the EXACT payload kind) ───────
 * constants.js owns INTAKE/OUTCOME refusal copy; relay notices are ferry
 * copy and live here, exported so the 10 units pin the exact strings.
 * Reply-copy convention (#471 H2-13): `**Label:** value` — label + colon
 * inside the bold. Interpolations are ids/filenames/numbers only, never
 * raw user bodies (the log line carries those). */

const NOT_SHARED_TAIL =
  "Only text, images, and video are shared with the other side — reactions, " +
  "edits, and embeds never are.";

const FERRY_COPY = Object.freeze({
  /** Per-kind "not shared" notices (whole message or dropped part). */
  sticker:
    `**Not shared:** that sticker is not ferried. ${NOT_SHARED_TAIL}`,
  audio:
    `**Not shared:** that audio/voice message is not ferried. ${NOT_SHARED_TAIL}`,
  poll:
    `**Not shared:** that poll is not ferried. ${NOT_SHARED_TAIL}`,
  forwarded:
    "**Not shared:** forwarded messages are not ferried — copy the wanted " +
    `text into a plain message instead. ${NOT_SHARED_TAIL}`,
  component:
    "**Not shared:** that button/menu (component) message is not ferried — " +
    `type your message as plain text instead. ${NOT_SHARED_TAIL}`,
  embedOnly:
    "**Not shared:** that message carried only embeds/link previews — paste " +
    `the text itself instead. ${NOT_SHARED_TAIL}`,
  /** Unsupported attachment kind (a .zip, .txt, …) — names the file. */
  fileKind(name) {
    return `**Not shared:** the file \`${name}\` is not ferried. ${NOT_SHARED_TAIL}`;
  },
  /** 8 MB cap refusal — names the declared size AND the cap (acceptance). */
  attachmentTooLarge(name, declaredBytes) {
    return (
      `**Not shared:** the attachment \`${name}\` (~${fmtBytes(declaredBytes)}) ` +
      `is over the ${fmtBytes(FERRY_ATTACHMENT_MAX_BYTES)} relay limit — it was ` +
      `not sent on. ${NOT_SHARED_TAIL}`
    );
  },
  /** Fetch failure — the specific downloadGuarded reason rides along. */
  attachmentFailed(name, reason) {
    return (
      `**Not shared:** the attachment \`${name}\` could not be fetched ` +
      `(${reason}) — it was not sent on; the rest of the message was. ` +
      NOT_SHARED_TAIL
    );
  },
  /** Discord's 10-file cap overflow (platform mirror, specific count). */
  attachmentFileCap(extraCount) {
    return (
      `**Not shared:** a message can ferry at most ${RELAY_MAX_FILES} files — ` +
      `${extraCount} attachment(s) beyond that were not sent on. ${NOT_SHARED_TAIL}`
    );
  },
  /** Flood notices (specific to the SENDER; staff/the user on the far side stay silent). */
  floodCooldown(waitMs) {
    const secs = Math.max(1, Math.ceil(waitMs / 1000));
    return (
      `**Ferry cooldown:** messages relay at most every ` +
      `${Math.round(FERRY_USER_COOLDOWN_MS / 1000)} seconds — this one was not ` +
      `relayed. Send it again in about ${secs} more second(s).`
    );
  },
  floodHourly() {
    return (
      `**Ferry limit:** this appeal already relayed ${FERRY_USER_HOURLY_CAP} ` +
      "messages in the last hour — this one was not relayed. Please wait a " +
      "while before continuing."
    );
  },
});

/** Byte copy for refusal lines (mirrors reportEvidence's private formatter). */
function fmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  if (b >= 1024 * 1024) return `${Math.round(b / (1024 * 1024))} MiB`;
  return `${Math.max(1, Math.round(b / 1024))} KiB`;
}

/* ── Shared module state (two belts; deps override for tests/units) ───────── */

/** Per-appeal user-side flood ledger: appeal id → { lastSentAt, sentTimes, lastNoticeAt }. */
const defaultFloodLedger = new Map();

/** Relay echo guard (loop-proof belt #2): ids of messages THIS engine sent. */
const defaultRelayedIds = new Set();
const defaultRelayedOrder = [];

function noteRelayedMessageId(id, guard = defaultRelayedIds, order = defaultRelayedOrder) {
  const text = optionalText(id);
  if (!text || guard.has(text)) return;
  guard.add(text);
  order.push(text);
  while (order.length > RELAYED_ID_GUARD_MAX) guard.delete(order.shift());
}

function isRelayedMessageId(id, guard) {
  const text = optionalText(id);
  return text != null && guard.has(text);
}

/* ── Loop-proofing (issue §3 row 1, belt #1) ──────────────────────────────── */

/**
 * Bots (including our own ferry relays), webhooks, and the bot's OWN id are
 * never ferried. webhook_id (raw API shape) AND webhookId (camel shapes) are
 * both read — an absent author cannot be relayed either (no author ⇒ never
 * claim authorship on a relay).
 */
function isLoopAuthored(message, clientUserId) {
  const author = message?.author;
  if (author == null) return true;
  if (author.bot === true) return true;
  if (message?.webhook_id != null || message?.webhookId != null) return true;
  const self = optionalText(clientUserId);
  const authorId = optionalText(author.id);
  if (self != null && authorId === self) return true;
  return false;
}

/* ── Classification (the PURE §3 matrix; units land in 10) ───────────────── */

/** Normalized attachment descriptor from any duck shape. */
function readAttachments(message) {
  return toArrayLike(message?.attachments)
    .filter((a) => a != null)
    .map((a) => {
      const name = optionalText(a.name) ?? "";
      const contentType = optionalText(a.content_type ?? a.contentType);
      const declared = Number(a.size);
      const media0 = mediaKind(name || "file", contentType);
      const voice = flagSet(a.flags, ATTACHMENT_FLAG_IS_VOICE);
      return {
        id: optionalText(a.id),
        url: optionalText(a.url) ?? optionalText(a.proxy_url),
        name,
        size: Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : null,
        contentType,
        media: voice && media0 === "file" ? "audio" : media0,
      };
    });
}

function stickerCount(message) {
  const s = message?.stickers;
  if (s == null) return 0;
  if (typeof s.size === "number") return s.size;
  if (Array.isArray(s)) return s.length;
  return 0;
}

function embedCount(message) {
  const e = message?.embeds;
  if (e == null) return 0;
  if (typeof e.length === "number") return e.length;
  return toArrayLike(e).length;
}

function snapshotCount(message) {
  const s = message?.message_snapshots ?? message?.messageSnapshots;
  if (s == null) return 0;
  if (typeof s.size === "number") return s.size;
  if (typeof s.length === "number") return s.length;
  return 0;
}

function isPollMessage(message) {
  if (message?.poll != null) return true;
  return Number(message?.type) === 21; // v14 poll message type id
}

function isForwardedMessage(message) {
  return flagSet(message?.flags, FLAG_FIELD_REFS) || snapshotCount(message) > 0;
}

function hasComponents(message) {
  const c = message?.components;
  if (!Array.isArray(c)) return toArrayLike(c).length > 0;
  return c.length > 0;
}

/**
 * Plain human-authored types: Default (0) and the stored legacy reply type
 * (19 — pre-v13 rows, still author-typed text). Every OTHER type is a
 * system/card message: never relayed (§3 + §6 — no system cards travel).
 */
function isPlainMessage(message) {
  const t = message?.type;
  if (t == null) return true;
  if (typeof t === "number") return t === 0 || t === 19;
  return t === "Default" || t === "default" || t === "LegacyReply";
}

/**
 * THE classification matrix (pure; no deps, no state).
 *
 * Returns:
 *   relay      — a shareable payload exists (whole message, or text/allowed
 *                attachments with the disallowed PARTS dropped + noticed).
 *   kind       — primary payload kind: 'text'|'image'|'video' when relay=true;
 *                'poll'|'forwarded'|'component'|'sticker'|'audio'|'file'|
 *                'embed_only'|'empty'|'system'|'loop_proof' when not shared.
 *   silent     — drop with NO notice to anybody (empty/system/loop-proof).
 *   refusal    — the complete SENDER notice (aggregated per-kind sentences),
 *                null when silent or when nothing was dropped.
 *   text       — the verbatim body.
 *   shareable  — normalized image/video attachments the relay loop re-hosts.
 *   drops      — [{ name, size, copy }] per dropped attachment (units inspect).
 */
function classifyOutbound(message, opts = {}) {
  const m = message || {};
  const base = {
    relay: false,
    kind: "empty",
    silent: true,
    refusal: null,
    text: optionalText(m.content) ?? "",
    shareable: [],
    drops: [],
  };

  // Loop-proof authors classify as non-relay so ONE function covers the
  // whole matrix (relay paths still run their own independent belt).
  if (isLoopAuthored(m, opts.clientUserId ?? null)) {
    return { ...base, kind: "loop_proof", silent: true };
  }

  if (isPollMessage(m)) {
    return { ...base, kind: "poll", silent: false, refusal: FERRY_COPY.poll };
  }
  if (isForwardedMessage(m)) {
    return { ...base, kind: "forwarded", silent: false, refusal: FERRY_COPY.forwarded };
  }
  if (hasComponents(m)) {
    return { ...base, kind: "component", silent: false, refusal: FERRY_COPY.component };
  }
  // Any non-plain message type (system/card) — silent: nobody authored it.
  // (Checks ABOVE run first so a poll — a typed non-zero type — gets its
  // specific notice rather than the silent bucket.)
  if (!isPlainMessage(m)) {
    return { ...base, kind: "system", silent: true };
  }

  const attachments = readAttachments(m);
  const shareable = attachments.filter((a) => a.media === "image" || a.media === "video");
  const dropped = [];

  // Attachment-part drops (partial-failure law: the text/allowed media still
  // travels; the sender learns exactly what did not).
  for (const a of attachments) {
    if (a.media === "image" || a.media === "video") continue;
    if (a.media === "audio") {
      dropped.push({ name: a.name || "audio message", size: a.size, copy: FERRY_COPY.audio });
    } else {
      const label = sanitizeFilename(a.name || "file");
      dropped.push({
        name: label,
        size: a.size,
        copy: FERRY_COPY.fileKind(label),
      });
    }
  }

  const stickers = stickerCount(m);
  const hasText = base.text !== "";
  const hasEmbeds = embedCount(m) > 0;

  if (stickers > 0 && !hasText && shareable.length === 0) {
    // Sticker-only (or sticker+embed, sticker+dropped files): not shared —
    // the notice names the sticker AND every other dropped part.
    return {
      ...base,
      kind: "sticker",
      silent: false,
      refusal: aggregateRefusals(dropped, FERRY_COPY.sticker),
      drops: dropped,
    };
  }
  if (shareable.length === 0 && !hasText && attachments.length > 0) {
    // Attachment-only payload where nothing was shareable (audio- or
    // file-only): refuse with the per-kind notices of every dropped part.
    const refusal = aggregateRefusals(dropped, null);
    return {
      ...base,
      kind: dropped.some((d) => d.copy === FERRY_COPY.audio) ? "audio" : "file",
      silent: false,
      refusal,
      drops: dropped,
    };
  }
  if (shareable.length === 0 && !hasText && hasEmbeds) {
    return { ...base, kind: "embed_only", silent: false, refusal: FERRY_COPY.embedOnly };
  }
  if (shareable.length === 0 && !hasText) {
    return { ...base, kind: "empty", silent: true }; // reactions are never messages here; add-only law
  }

  // RELAY rows: text / image / video. Attachments outrank text for `kind`;
  // video outranks image (deterministic tie-break, documented in the header).
  const kind = shareable.some((a) => a.media === "video")
    ? "video"
    : shareable.some((a) => a.media === "image")
      ? "image"
      : "text";
  return {
    relay: true,
    kind,
    silent: false,
    refusal: aggregateRefusals(dropped, null),
    text: base.text,
    shareable,
    drops: dropped,
  };
}

/** Join per-kind drop sentences into ONE sender notice (null when nothing dropped). */
function aggregateRefusals(dropped, extraCopy) {
  const parts = [];
  for (const d of dropped) {
    if (d?.copy && !parts.includes(d.copy)) parts.push(d.copy);
  }
  if (extraCopy && !parts.includes(extraCopy)) parts.push(extraCopy);
  return parts.length > 0 ? parts.join(" ") : null;
}

/* ── Logging (every failure carries the full id set; AGENTS.md rule 2) ───── */

function idsOf(appeal, extra = {}) {
  return {
    community: appeal?.community_id ?? "?",
    record: appeal?.ban_record_id ?? "?",
    appeal: appeal?.id ?? "?",
    user: extra.userId ?? "?",
    ticket: appeal?.ticket_channel_id ?? "?",
  };
}

function logFerry(level, what, ids, cause) {
  const line =
    `${LOG_PREFIX} ${what} community=${ids.community} record=${ids.record} ` +
    `appeal=${ids.appeal} user=${ids.user} ticket=${ids.ticket}`;
  if (cause == null) {
    (level === "error" ? console.error : console.warn)(`${line}: no cause reported`);
    return;
  }
  (level === "error" ? console.error : console.warn)(
    `${line}:`,
    cause?.message || cause,
  );
}

/* ── Relay shaping helpers ────────────────────────────────────────────────── */

/** Cursor-safe timestamp: the duck's created_at, else the injected clock. */
function cursorTimestamp(message, nowFn) {
  return messageTimestampMs(message) ?? Math.floor(nowFn());
}

/** Collision-free relay file names (mirrors reportEvidence's uniqueName law). */
function uniqueRelayName(base, used) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Split the relayed body into ≤ RELAY_CHUNK_CHARS pieces (code-point safe);
 * the FIRST piece carries the `**<name · id>:**` signature. Files ride the
 * first payload (header and media stay adjacent).
 */
function buildRelayChunks(header, text) {
  if (text === "") return [header];
  const firstBudget = Math.max(
    200,
    RELAY_CHUNK_CHARS - header.length - 1, // 1 = the space after the header
  );
  const chunks = [];
  let rest = text;
  let budget = firstBudget;
  while (rest.length > budget) {
    const cut = safeCutIndex(rest, budget);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
    budget = RELAY_CHUNK_CHARS;
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  chunks[0] = `${header} ${chunks[0]}`;
  return chunks;
}

/* ── Attachment re-host (recoverAttachments' loop shape, buffer destination) */

async function rehostAttachments(shareable, { deps, notices }) {
  const files = [];
  const used = new Set();
  for (const att of shareable.slice(0, RELAY_MAX_FILES)) {
    const baseName = sanitizeFilename(att.name || "file");
    const name = uniqueRelayName(baseName, used);

    if (att.size != null && att.size > FERRY_ATTACHMENT_MAX_BYTES) {
      // Declared-size pre-skip: never DOWNLOAD a file we must refuse (the
      // 8 MB law), and REFUSE SPECIFICALLY — the copy names size and cap.
      notices.push(FERRY_COPY.attachmentTooLarge(name, att.size));
      continue;
    }
    if (!att.url) {
      notices.push(FERRY_COPY.attachmentFailed(name, "no source url was present"));
      continue;
    }
    // downloadGuarded NEVER throws: https-only + host checks + maxBytes are
    // enforced twice (declared header AND streamed bytes); refusals arrive as
    // { ok:false, reason } (the exact-size truth, never an inflated claim).
    const res = await downloadGuarded(att.url, {
      maxBytes: FERRY_ATTACHMENT_MAX_BYTES,
      fetchImpl: typeof deps.fetchImpl === "function" ? deps.fetchImpl : undefined,
      resolveHost: typeof deps.resolveHost === "function" ? deps.resolveHost : undefined,
      timeoutMs: Number.isFinite(deps.downloadTimeoutMs) ? deps.downloadTimeoutMs : undefined,
    });
    if (!res.ok) {
      notices.push(FERRY_COPY.attachmentFailed(name, res.reason || "unknown download failure"));
      continue;
    }
    // Re-upload (LOCKED deviation from mirrorTicketAssets' on-disk pipeline):
    // the bytes ride the platform-neutral send as { name, data } descriptors —
    // normalizeReplyFiles law (src/platform/context.js) — so the relay owns a
    // copy from the moment it sends and survives original deletion.
    files.push({ name, data: res.bytes });
  }
  if (shareable.length > RELAY_MAX_FILES) {
    notices.push(FERRY_COPY.attachmentFileCap(shareable.length - RELAY_MAX_FILES));
  }
  return files;
}

/* ── Structural gate (issue §3 "Active only while…") ─────────────────────── */

function structuralSkip(appeal, direction) {
  if (appeal == null || optionalText(appeal.id) == null) {
    return { reason: "no_row", error: "ferry relay needs the appeal row — load it by id or ticket channel first." };
  }
  if (String(appeal.status) !== "open") {
    // Status guard IS the structural stop: filed (no ticket yet) and every
    // decided status end the relay — outcome changes need no ferry edits.
    return { reason: `status_${appeal.status}`, error: null };
  }
  if (Number(appeal.ferry_paused) === 1 || appeal.ferry_paused === true) {
    // Pause silences the WHOLE relay BOTH ways (repo law, 075); nothing was
    // lost: the cursor stayed behind, so a bounded boot catch-up can still
    // cover the quiet period.
    return { reason: "paused", error: null };
  }
  if (direction === "user" && optionalText(appeal.ticket_channel_id) == null) {
    return {
      reason: "no_ticket",
      error: "this appeal is open but carries no ticket channel — nothing to relay into (ticket.js must attach the channel before opening).",
    };
  }
  return null;
}

/* ── Flood gate (user side only) ─────────────────────────────────────────── */

function floodGate(ledger, appealId, now) {
  const key = String(appealId);
  const entry = ledger.get(key) || { lastSentAt: null, sentTimes: [], lastNoticeAt: null };
  const recent = entry.sentTimes.filter((t) => now - t < HOURLY_MS);
  if (entry.lastSentAt != null && now - entry.lastSentAt < FERRY_USER_COOLDOWN_MS) {
    return {
      blocked: "cooldown",
      waitMs: FERRY_USER_COOLDOWN_MS - (now - entry.lastSentAt),
      noticeDue: entry.lastNoticeAt == null || now - entry.lastNoticeAt >= FERRY_USER_COOLDOWN_MS,
      entry: { ...entry, sentTimes: recent },
    };
  }
  if (recent.length >= FERRY_USER_HOURLY_CAP) {
    return {
      blocked: "hourly",
      waitMs: null,
      noticeDue: entry.lastNoticeAt == null || now - entry.lastNoticeAt >= FERRY_USER_COOLDOWN_MS,
      entry: { ...entry, sentTimes: recent },
    };
  }
  return { blocked: null, entry: { ...entry, sentTimes: recent } };
}

function floodRecord(ledger, appealId, gate, now) {
  ledger.set(String(appealId), {
    lastSentAt: now,
    sentTimes: [...gate.entry.sentTimes, now],
    lastNoticeAt: gate.entry.lastNoticeAt,
  });
}

function floodNoticed(ledger, appealId, gate, now) {
  ledger.set(String(appealId), { ...gate.entry, lastNoticeAt: now });
}

/* ── The relay core (both directions share the whole law; direction picks ──
    the signature, the notice target, the send target, and the flood gate) ── */

function directionDeps(direction) {
  if (!FERRY_DIRECTIONS.includes(direction)) {
    return {
      error: `unknown ferry direction \`${direction}\` — relay only runs \`${FERRY_DIRECTIONS.join("\` or \`")}\`.`,
    };
  }
  return { error: null };
}

function signatureFor(direction, message) {
  const author = message?.author ?? {};
  if (direction === "user") {
    const name =
      optionalText(author.global_name ?? author.globalName) ??
      optionalText(author.username) ??
      optionalText(author.displayName) ??
      "unknown user";
    // `**<username · id>:**` — escaped name AND id (escape is a no-op on real
    // digit ids, but a planted id can never smuggle markup), colon INSIDE the
    // bold; never a <@id> mention (the send belts with allowedMentions).
    return `**${escapeDisplayName(name)} · ${escapeDisplayName(String(optionalText(author.id)))}:**`;
  }
  // Ticket → user: display name ONLY (issue §3 copy — the user learns WHO,
  // never an id; §6 keeps the ban's moderator identity entirely out of DMs).
  const name =
    optionalText(message?.member?.displayName) ??
    optionalText(author.displayName) ??
    optionalText(author.global_name ?? author.globalName) ??
    optionalText(author.username) ??
    "staff";
  return `**${escapeDisplayName(name)}:**`;
}

async function relayMessageCore({ appeal, message, direction, deps = {}, userId = null, enforceFlood = true }) {
  const dirCheck = directionDeps(direction);
  if (dirCheck.error) return { ok: false, error: dirCheck.error };

  const authorId = optionalText(message?.author?.id);
  const ids = idsOf(appeal, { userId: userId ?? authorId });
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const floodLedger = deps.floodLedger || defaultFloodLedger;
  const relayedIds = deps.relayedIds || defaultRelayedIds;
  const relayedOrder = deps.relayedOrder || defaultRelayedOrder;

  try {
    // Lazy facade require INSIDE the guard (#699 law): a boot-order require
    // failure must surface as { ok:false }, never as a thrown event-loop kill.
    const repo = deps.repo || require("../../db");

    // 1. Structural (status open + pause + ticket).
    const skip = structuralSkip(appeal, direction);
    if (skip) {
      if (skip.error) {
        logFerry("error", `ferry ${direction}→ relay blocked`, ids, skip.error);
        return { ok: false, error: skip.error };
      }
      return { ok: true, relayed: false, skipped: skip.reason, direction };
    }

    const userIdText = userId ?? optionalText(appeal.user_id) ?? optionalText(appeal.ban_user_id);

    // 2. Loop-proof (BELT #1 author flags + belt #2 relayed-id guard).
    if (isLoopAuthored(message, deps.clientUserId ?? null)) {
      return { ok: true, relayed: false, skipped: "loop_proof", direction };
    }
    if (isRelayedMessageId(message?.id, relayedIds)) {
      return { ok: true, relayed: false, skipped: "relay_echo", direction };
    }
    if (authorId == null) {
      const error = "a ferried message needs an author id — refusing to sign a relay with no author.";
      logFerry("error", `ferry ${direction}→ relay refused`, ids, error);
      return { ok: false, error };
    }

    // 3. Classification (the whole §3 payload matrix).
    const cls = classifyOutbound(message, { clientUserId: deps.clientUserId ?? null });
    if (cls.kind === "loop_proof") return { ok: true, relayed: false, skipped: "loop_proof", direction };
    if (!cls.relay) {
      const noticeTarget = direction === "user" ? userIdText ?? authorId : authorId;
      let refusalSent = false;
      if (!cls.silent && cls.refusal) {
        refusalSent = await sendNotice({
          direction,
          appeal,
          deps,
          userId: noticeTarget,
          text: cls.refusal,
          ids,
        });
      }
      return {
        ok: true,
        relayed: false,
        skipped: cls.kind,
        refusalSent,
        direction,
      };
    }

    // 4. Flood gate (user side only, live events only — catch-up replays
    //    bounded history, not fresh flood).
    let gate = null;
    if (direction === "user" && enforceFlood) {
      gate = floodGate(floodLedger, appeal.id, now());
      if (gate.blocked) {
        const copy =
          gate.blocked === "cooldown"
            ? FERRY_COPY.floodCooldown(gate.waitMs)
            : FERRY_COPY.floodHourly();
        let refusalSent = false;
        if (gate.noticeDue) {
          // Drops are SPECIFIC TO THE SENDER, silent to the other side; the
          // notice itself is cooldown-throttled so flooding cannot storm it.
          refusalSent = await sendNotice({
            direction,
            appeal,
            deps,
            userId: userIdText ?? authorId,
            text: copy,
            ids,
          });
          if (refusalSent) floodNoticed(floodLedger, appeal.id, gate, now());
        }
        return {
          ok: true,
          relayed: false,
          skipped: `flood_${gate.blocked}`,
          refusalSent,
          direction,
        };
      }
    }

    // 5. Re-host attachments (per-file partial failure; notices to SENDER).
    const notices = [];
    const files = await rehostAttachments(cls.shareable, { deps, notices });
    const hasText = cls.text !== "";
    if (files.length === 0 && !hasText && cls.shareable.length > 0) {
      // Attachment-only message whose files ALL failed: nothing can travel.
      // Still tell the sender exactly why (their message otherwise vanishes).
      const text = aggregateRefusals([], notices.join(" "));
      await sendNotice({ direction, appeal, deps, userId: direction === "user" ? userIdText ?? authorId : authorId, text, ids });
      const error = `every relayed attachment failed to re-host: ${notices.join(" ")}`;
      logFerry("error", `ferry ${direction}→ relay had no survivable payload`, ids, error);
      return { ok: false, error };
    }

    // 6. Send (chunked under the platform content cap; allowedMentions belt).
    const header = signatureFor(direction, message);
    const chunks = buildRelayChunks(header, hasText ? cls.text : "");
    const send = buildSender({ direction, appeal, deps, userId: userIdText });
    if (!send) {
      const error =
        direction === "ticket"
          ? "ticket→user ferry needs deps.sendDm and the appeal's user id (wire outbound.sendDm in events.js; resolve the user from the ban record)"
          : "ferry relay needs deps.sendChannel (wire it from the outbound supervisor, #462 law)";
      logFerry("error", `ferry ${direction}→ relay refused`, ids, error);
      return { ok: false, error };
    }

    const sentIds = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const payload = { content: chunks[i], allowedMentions: { parse: [] } };
      if (i === 0 && files.length > 0) payload.files = files;
      let res;
      try {
        res = await send(payload);
      } catch (err) {
        res = { ok: false, error: err?.message || String(err) };
      }
      if (!res || res.ok !== true) {
        const error = `relay send failed on part ${i + 1}/${chunks.length}: ${res?.error || "the send reported no success and no reason"}`;
        logFerry("error", `ferry ${direction}→ relay send`, ids, error);
        // Cursor STAYS BEHIND (resume-skip law): bounded re-send risk, never
        // a silent skip. Partial chunks already sent are echo-guarded below.
        for (const id of sentIds) noteRelayedMessageId(id, relayedIds, relayedOrder);
        return { ok: false, error, relayed: false, sentParts: sentIds.length };
      }
      if (res.id != null) sentIds.push(String(res.id));
    }
    for (const id of sentIds) noteRelayedMessageId(id, relayedIds, relayedOrder);

    // 7. Per-file refusals ride AFTER the relay (sender sees what shipped).
    let noticesSent = 0;
    for (const notice of notices) {
      if (await sendNotice({ direction, appeal, deps, userId: direction === "user" ? userIdText ?? authorId : authorId, text: notice, ids })) {
        noticesSent += 1;
      }
    }

    // 8. Flood window advances ONLY now that the relay actually shipped.
    if (direction === "user" && enforceFlood && gate) {
      floodRecord(floodLedger, appeal.id, gate, now());
    }

    // 9. Cursor pair AFTER successful send (never before — resume-skip law).
    const messageId = optionalText(message.id);
    let cursorSaved = false;
    let cursorError = null;
    if (messageId == null) {
      cursorError = "the relayed message carried no id — the cursor could not advance (restart may replay it).";
      logFerry("warn", `ferry ${direction}→ cursor`, ids, cursorError);
    } else {
      // A THROWING repo must not retroactively un-send the relay: the send
      // DID happen (partial-failure law) — the cursor failure degrades to a
      // specific cursorError + error log, never to a whole-relay ok:false.
      let saved;
      try {
        saved = repo.saveAppealCursor(appeal.id, direction, {
          messageId,
          timestampMs: cursorTimestamp(message, now),
        });
      } catch (err) {
        saved = { ok: false, error: err?.message || String(err) };
      }
      if (!saved || saved.ok !== true) {
        cursorError = `relay shipped but the cursor did not save: ${saved?.error || "the repo reported no reason"}`;
        logFerry("error", `ferry ${direction}→ cursor save`, ids, cursorError);
      } else {
        cursorSaved = true;
      }
    }

    return {
      ok: true,
      relayed: true,
      direction,
      sentIds,
      cursorSaved,
      ...(cursorError ? { cursorError } : {}),
      noticesSent,
    };
  } catch (err) {
    const error = `ferry ${direction}→ relay failed: ${err?.message || err}`;
    logFerry("error", `ferry ${direction}→ relay`, ids, err);
    return { ok: false, error };
  }
}

/**
 * Notice delivery (SENDER side): user→ticket drops notice the appealing
 * user in their DM; ticket→user drops notice the author IN THE TICKET.
 * Failure is a warn (the drop itself already happened; never escalate).
 */
async function sendNotice({ direction, appeal, deps, userId, text, ids }) {
  const body = optionalText(text);
  if (!body) return false;
  const payload = { content: body, allowedMentions: { parse: [] } };
  try {
    if (direction === "user") {
      if (typeof deps.sendDm !== "function" || userId == null) {
        logFerry("warn", `ferry user→ notice undelivered (no DM seam or user id)`, ids, "the sender could not be told what was not shared");
        return false;
      }
      const res = await deps.sendDm(String(userId), payload);
      if (!res || res.ok !== true) {
        logFerry("warn", `ferry user→ notice send`, ids, res?.error || "the DM send reported no success and no reason");
        return false;
      }
      return true;
    }
    if (typeof deps.sendChannel !== "function" || optionalText(appeal?.ticket_channel_id) == null) {
      logFerry("warn", `ferry ticket→ notice undelivered (no channel seam or ticket)`, ids, "the sender could not be told what was not shared");
      return false;
    }
    const res = await deps.sendChannel(String(appeal.ticket_channel_id), payload);
    if (!res || res.ok !== true) {
      logFerry("warn", `ferry ticket→ notice send`, ids, res?.error || "the channel send reported no success and no reason");
      return false;
    }
    return true;
  } catch (err) {
    logFerry("warn", `ferry ${direction}→ notice send threw`, ids, err);
    return false;
  }
}

/** Send seam for the relay payload itself (null = unwired → specific error). */
function buildSender({ direction, appeal, deps, userId }) {
  if (direction === "ticket") {
    if (typeof deps.sendDm !== "function" || userId == null) return null;
    return (payload) => deps.sendDm(String(userId), payload);
  }
  if (typeof deps.sendChannel !== "function") return null;
  return (payload) => deps.sendChannel(String(appeal.ticket_channel_id), payload);
}

/* ── Public entry points (what 07 wires) ─────────────────────────────────── */

/**
 * Relay ONE message from the banned user's DM into the staff ticket.
 * `deps` contract (07 wires all four):
 *   sendChannel(channelId, payload) — outbound.sendChannel shape
 *   sendDm(userId, payload)         — outbound.sendDm shape (notices to the user)
 *   clientUserId                    — the bot's own id (self-echo belt)
 *   repo?                           — db facade default
 *   now?, fetchImpl?, resolveHost?, downloadTimeoutMs?, floodLedger?,
 *   relayedIds?, relayedOrder?      — test seams
 * Never throws: { ok:false, error } carries every failure with a cause.
 */
async function relayUserToTicket({ appeal, message, deps = {} } = {}) {
  return relayMessageCore({ appeal, message, direction: "user", deps });
}

/**
 * Relay ONE staff message from the ticket into the user's DM. `userId` is
 * the banned user — 07 resolves it from the ban record (or any row column
 * named user_id); the relay NEVER reads ban metadata into the payload (§6).
 */
async function relayTicketToUser({ appeal, message, deps = {}, userId = null } = {}) {
  return relayMessageCore({ appeal, message, direction: "ticket", deps, userId });
}

/**
 * Boot catch-up for ONE direction of ONE appeal (07 enumerates open appeals
 * on start and calls this with a bound messagesFetcher).
 *
 * messagesFetcher({ limit, after, direction }) resolves an array (or
 * Collection) of message ducks — newest-first like discord.js; the engine
 * re-filters STRICTLY after the persisted cursor pair, re-orders by
 * created_at THEN id (id monotonicity is NOT assumed), and relays at most
 * FERRY_CATCHUP_MAX through the same relay paths (flood gate relaxed — this
 * is bounded history replay; the bound caps what a boot can storm).
 *
 * A single relay failure STOPS at that message (no skip-ahead) and reports
 * it; unprocessed history inside the fetched page is counted and logged so a
 * catch-up that did not fully run is never claimed as one that did.
 */
async function catchUpOnBoot({ appeal, direction, messagesFetcher, deps = {}, userId = null } = {}) {
  const dirCheck = directionDeps(direction);
  if (dirCheck.error) return { ok: false, error: dirCheck.error };
  if (typeof messagesFetcher !== "function") {
    return { ok: false, error: `ferry catch-up needs a messagesFetcher for the ${direction} side (bind the channel/DM history in events.js).` };
  }
  const ids = idsOf(appeal, { userId });
  try {
    const repo = deps.repo || require("../../db"); // lazy, guarded (#699 law)
    const skip = structuralSkip(appeal, direction);
    if (skip) {
      if (skip.error) {
        logFerry("error", `ferry catch-up ${direction} blocked`, ids, skip.error);
        return { ok: false, error: skip.error };
      }
      return { ok: true, relayed: 0, skipped: skip.reason, direction };
    }

    const loaded = repo.loadAppealCursor(appeal.id, direction);
    if (!loaded || loaded.ok !== true) {
      const error = `could not read the ${direction} ferry cursor: ${loaded?.error || "the repo reported no reason"}`;
      logFerry("error", `ferry catch-up ${direction} cursor read`, ids, error);
      return { ok: false, error };
    }
    const cursor = loaded.cursor;

    // One bounded page: the caller may page deeper, but the RELAY bound is
    // engine law (FERRY_CATCHUP_MAX) — never an unbounded boot storm.
    const fetched = await messagesFetcher({
      limit: Math.min(100, FERRY_CATCHUP_MAX * 2),
      after: cursor?.messageId ?? null,
      direction,
    });
    const list = toArrayLike(fetched)
      .filter((m) => m != null)
      .map((m) => ({ message: m, ts: messageTimestampMs(m) }))
      .filter((entry) => {
        if (cursor == null) return true;
        const ts = entry.ts ?? 0;
        if (ts > cursor.timestampMs) return true;
        if (ts < cursor.timestampMs) return false;
        return compareIds(entry.message.id, cursor.messageId) > 0;
      })
      .sort((a, b) => {
        const at = a.ts ?? 0;
        const bt = b.ts ?? 0;
        if (at !== bt) return at - bt;
        return compareIds(a.message.id, b.message.id);
      });

    const bounded = list.slice(0, FERRY_CATCHUP_MAX);
    const floodLedger = deps.floodLedger || defaultFloodLedger;
    const relayedIds = deps.relayedIds || defaultRelayedIds;
    const relayedOrder = deps.relayedOrder || defaultRelayedOrder;

    let relayed = 0;
    for (const entry of bounded) {
      const res = await relayMessageCore({
        appeal,
        message: entry.message,
        direction,
        deps: { ...deps, floodLedger, relayedIds, relayedOrder },
        userId,
        enforceFlood: false, // history replay, not live flood surface
      });
      if (!res.ok) {
        const unprocessed = list.length - bounded.indexOf(entry);
        logFerry(
          "error",
          `ferry catch-up ${direction} stopped at message ${entry.message?.id ?? "?"}`,
          ids,
          res.error,
        );
        return {
          ok: false,
          error: `catch-up stopped at message ${entry.message?.id ?? "?"}: ${res.error}`,
          relayed,
          stoppedAt: optionalText(entry.message?.id),
          unprocessed,
          direction,
        };
      }
      if (res.relayed) relayed += 1;
    }

    const unprocessed = list.length - bounded.length;
    if (unprocessed > 0) {
      // Never claim a catch-up that did not run: the bound is reported and
      // the cursor truthfully stopped where the relay stopped.
      console.log(
        `${LOG_PREFIX} ferry catch-up ${direction} bound reached community=${ids.community} ` +
          `record=${ids.record} appeal=${ids.appeal} relayed=${relayed} unprocessed=${unprocessed} ` +
          `(bound ${FERRY_CATCHUP_MAX}) — the cursor stays truthful; later history awaits the next boot or live traffic.`,
      );
    }
    return { ok: true, relayed, unprocessed, direction };
  } catch (err) {
    const error = `ferry catch-up ${direction} failed: ${err?.message || err}`;
    logFerry("error", `ferry catch-up ${direction}`, ids, err);
    return { ok: false, error };
  }
}

module.exports = {
  // Engine entry points (07 wires these; units in 10 pin the pure parts).
  classifyOutbound,
  relayUserToTicket,
  relayTicketToUser,
  catchUpOnBoot,
  // Loop-proof belt for callers that relay outside these paths (none today).
  noteRelayedMessageId,
  isLoopAuthored,
  // Copy + law exports (exact-string pinning in the 10 units).
  FERRY_COPY,
  FERRY_DIRECTIONS,
  // Guarded seams for white-box tests (same idiom as banLifecycle/events.js).
  internals: {
    buildRelayChunks,
    signatureFor,
    structuralSkip,
    floodGate,
    messageTimestampMs,
    compareIds,
    cursorTimestamp,
    readAttachments,
    isForwardedMessage,
    hasComponents,
    isPollMessage,
    isPlainMessage,
    flagSet,
    uniqueRelayName,
    fmtBytes,
    RELAY_MAX_FILES,
    RELAY_CHUNK_CHARS,
    RELAYED_ID_GUARD_MAX,
    FLAG_FIELD_REFS,
    HOURLY_MS,
  },
};
