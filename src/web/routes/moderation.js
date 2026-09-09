/**
 * Web moderation lists (Phase 1, subtask 17) + Phase-3 mutation actions
 * (roadmap/web-admin.md §8.6 "Moderation: warnings list/issue/void, notes |
 * Staff | Staff | 1 read · 3 write"; subtask 29).
 *
 * Routes (UNDER the /g/:guildId guildScope mounted by dashboard/guildShell —
 * register AFTER registerGuildShellRoutes in app.js, like routes/users.js):
 *   GET  /g/:guildId/warnings — staff+ — guild-wide warnings + the issue/void
 *        forms; filters: u (subject snowflake) · state=active|voided|all
 *        (default active, mirroring slash) · n page size (≤100) · o offset.
 *   GET  /g/:guildId/notes    — staff+ — guild-wide staff notes + the add
 *        form; filters: u · state=active|all (all ≡ slash include_deleted,
 *        rows BADGED) · n · o.
 *   POST /g/:guildId/moderation/warnings/issue — warn add (slash /warn add)
 *   POST /g/:guildId/moderation/warnings/void  — warn void (slash /warn void)
 *   POST /g/:guildId/moderation/notes          — note add (slash /note add)
 *   (All three STAFF tier per §8.6; the warning number rides the BODY
 *   (`warning_number`), NOT a path param — the methodGate matches mutation
 *   templates with :guildId as the ONLY parameter segment (app.js
 *   matchesMutationPath), so every Phase-2/3 mutation is a literal path. The
 *   subtask sketch `warnings/:id/void` is realized as body-field routing —
 *   same contract, gate-compatible.)
 *
 * SERVICE PARITY (the whole point — features/warnings/index.js handleAdd/
 * handleVoid + features/staffNotes/index.js handleAdd, mirrored exactly):
 *  - issue: same helper (createWarning with warning_number allocation +
 *    expiresDays/guildDefaultDays resolution via resolveExpiryDays INSIDE
 *    the repo), same option bounds (reason ≤ MAX_WARN_REASON, evidence text
 *    ≤ MAX_EVIDENCE_TEXT via normalizeEvidenceText, evidence URL validated
 *    guild-scoped via normalizeEvidenceMessageUrl, note link resolved via
 *    getStaffNote, expires_days 0…MAX_EXPIRY_DAYS with EMPTY = guild default
 *    = slash IntegerOption omitted), same bot refusal (proven-by-cache only,
 *    xpActions doctrine), same warn_dm_members-gated member DM (cache-only
 *    user seam, graceful skip, silent checkbox = slash silent option);
 *  - void: voidWarning(guildId, warningNumber, { voidedBy, voidReason }) —
 *    the repo's ALREADY_VOIDED / cross-guild-not-found rules answer with
 *    slugs, zero side effects; the void author + reason are the row's;
 *  - note: createStaffNote (sequential N-ref, 2000-char INVALID_CONTENT
 *    bound PRE-validated at the route so a rejection reaches zero write
 *    helpers, exactly like slash's maxLength option) — notes NEVER DM.
 *
 * AUDIT (§8.6, DB-first fail-closed via req.audit, origin defaults 'web'):
 * ONE admin_audit row per mutation reusing the EXACT slash vocabulary +
 * detail shape — warnings.add {warning_id, warning_number, reason,
 * expires_at, silent} (features/warnings/index.js:492), warnings.void
 * {warning_number, subject_user_id, void_reason} (:781), notes.add
 * {note_number, subject_user_id, content: snippet(content, 500)}
 * (features/staffNotes/index.js:348) — plus the channel MIRROR through the
 * same helper paths the slash uses: kind "warn" (logWarnEvent's sendWarnLog:
 * dedicated warn-log channel with audit fallback) for issue/void, default
 * kind (logConfigChange's sendAuditLog) for notes (§8.1-7; snippet() is the
 * features' own exported helper, so mirror lines are byte-identical).
 * Rejections write NOTHING; an audit insert failure aborts with the generic
 * 500 (fail-closed — the mutation outcome is never silently claimed).
 *
 * MUTATION CONTRACT (Phase-2 doctrine): the methodGate registry entry and
 * the Express route are minted from ONE path constant via postMutation
 * (registerWebMutation + app.post + requireTier("staff") lockstep — they
 * cannot drift). CSRF is auto-enforced on every /g/ POST
 * (middleware/csrf.js); the list-page forms embed the hidden _csrf from
 * req.csrfToken. Body fields arrive pre-parsed on req.bodyFields (body-cap
 * consumed the stream — no express parsers on top). PRG: success ⇒ 302 to
 * the matching LIST page with `?done=<slug>`, a validation refusal ⇒ 302
 * `?error=<slug>` — slugs are frozen constants re-checked against the
 * view's whitelists before the Location is minted; NO submitted value is
 * ever echoed into a redirect (§8.7).
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const {
  renderWarningsBody,
  renderNotesBody,
  flashFromQuery,
  WARN_FLASH_DONE,
  WARN_FLASH_ERROR,
  NOTE_FLASH_DONE,
  NOTE_FLASH_ERROR,
} = require("../views/moderation");
const {
  buildWarningsPage,
  buildNotesPage,
  USER_ID_RE,
} = require("../data/moderation");
const { getBoundAuditClient } = require("../middleware/audit");
const { formatWarnRef, formatNoteRef, tsFull, Color } = require("../../core/theme");

/** List pages (POST PRG redirect targets; staff tier like the mutations). */
const WARNINGS_PAGE = "/g/:guildId/warnings";
const NOTES_PAGE = "/g/:guildId/notes";

/** Mutation surfaces (ONE constant each: registry ↔ route lockstep). */
const WARN_ISSUE_PATH = "/g/:guildId/moderation/warnings/issue";
const WARN_VOID_PATH = "/g/:guildId/moderation/warnings/void";
const NOTE_ADD_PATH = "/g/:guildId/moderation/notes";

/** Warning number shape (slash IntegerOption min:1 — digits, ≥ 1). */
const WARN_NUMBER_RE = /^[1-9][0-9]{0,8}$/;
/** Note number shape (slash note option min:1). */
const NOTE_NUMBER_RE = /^[1-9][0-9]{0,8}$/;
/** Whole non-negative days ≤ 4 digits pre-screened against MAX_EXPIRY_DAYS. */
const DAYS_RE = /^(0|[1-9][0-9]{0,3})$/;

/** Checkbox spellings that mean "yes" (the form sends value="1"). */
const TRUTHY = new Set(["1", "true", "on", "yes"]);

/**
 * Parse the RAW url query (app doctrine: never req.query — the Express 5
 * "simple" parser and path-to-regexp decoding must not decide behavior
 * here; same local helper as routes/users.js, deliberately duplicated
 * rather than reaching into another owner's route module).
 * @param {string} rawUrl
 * @returns {URLSearchParams}
 */
function rawParams(rawUrl) {
  const idx = String(rawUrl || "").indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : String(rawUrl).slice(idx + 1));
}

/** Raw-url flash read (xpActions doctrine): { done, error } raw values. */
function rawFlashQuery(rawUrl) {
  const params = rawParams(rawUrl);
  return { done: params.get("done"), error: params.get("error") };
}

/** Shared switcher list for shell pages (never fails the page open/closed). */
async function shellGuilds(resolver, req) {
  const listed = await resolver.listGuilds(req.webSession);
  const guilds = listed.guilds.slice();
  const currentId = req.guildAccess.guildId;
  if (!guilds.some((g) => g.id === currentId)) {
    guilds.unshift({ id: currentId, name: currentId });
  }
  return guilds;
}

/** Parsed urlencoded fields (bodyCap/CSRF contract — no express parsers). */
function readFields(req) {
  const src = req?.bodyFields;
  return src && typeof src === "object" ? src : {};
}

/**
 * Cache-only bot probe (slash parity: `if (target.bot)` refusals in
 * handleAdd/handleNoteAdd). Reads the bot's caches ONLY — guild member
 * cache, then global user cache — and only ever REFUSES on PROVEN bot
 * status. An unanswerable cache (client unbound, user unknown) makes no
 * claim and lets the mutation proceed: the slash picker can only resolve
 * real users, and the orchestrator-mandated cache-only seam never fetches.
 * @param {any} client resolved client or null
 * @param {string} guildId
 * @param {string} userId
 * @returns {boolean} true ONLY when a cache proves the target is a bot
 */
function isProvenBot(client, guildId, userId) {
  try {
    const guild = client?.guilds?.cache?.get?.(guildId) ?? null;
    const member = guild?.members?.cache?.get?.(userId) ?? null;
    const memberBot = member?.user?.bot === true || member?.bot === true;
    if (memberBot) return true;
    const cachedUser = client?.users?.cache?.get?.(userId) ?? null;
    return cachedUser?.bot === true;
  } catch {
    return false; // a broken cache object can never PROVE a bot
  }
}

/**
 * Cache-ONLY member/user resolution for the warn DM (slash void resolves
 * users.cache → users.fetch → guild.members.fetch; the WEB seam stops at
 * the caches and gracefully SKIPS — a web request never hits the Discord
 * API, xpActions doctrine).
 * @param {any} client resolved client or null
 * @param {string} guildId
 * @param {string} userId
 * @returns {any|null} a cache-resolved user-ish object (maybe .send-less)
 */
function resolveUserCacheOnly(client, guildId, userId) {
  try {
    const direct = client?.users?.cache?.get?.(userId) ?? null;
    if (direct) return direct;
    const member =
      client?.guilds?.cache?.get?.(guildId)?.members?.cache?.get?.(userId) ?? null;
    return member?.user ?? member ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort DM to a cache-resolved user. Never throws; never rolls back
 * DB (identical to features/warnings/index.js tryDmUser).
 * @param {any} user
 * @param {object} payload
 * @returns {Promise<boolean>} true if sent
 */
async function tryDmUser(user, payload) {
  if (!user || typeof user.send !== "function") return false;
  try {
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guild-wide default expiry days — byte-parity mirror of the feature's
 * LOCAL guildWarnExpiryDays (features/warnings/index.js:336; not exported,
 * so the web re-implements the 4-line clamp rather than reaching into
 * slash-internal state).
 * @param {object} settings getGuildSettings row
 * @param {number} maxExpiryDays MAX_EXPIRY_DAYS
 * @returns {number}
 */
function guildWarnExpiryDays(settings, maxExpiryDays) {
  const n = Number(settings.warn_expiry_days ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), maxExpiryDays);
}

/**
 * Member-DM toggle for warnings — mirror of the feature's local
 * warnDmEnabled (features/warnings/index.js:327): missing/anything but a
 * literal 0 means ON (slash default).
 * @param {object} settings getGuildSettings row
 * @returns {boolean}
 */
function warnDmEnabled(settings) {
  return Number(settings.warn_dm_members ?? 1) !== 0;
}

/**
 * Slash-identical "Warning issued" DM payload (features/warnings/index.js
 * handleAdd DM fields: ref / issued-by / active count / reason ≤1024 / when
 * / expires-when-set / footer). Plain embed JSON (EmbedBuilder.toJSON's
 * shape) — same fields, no discord.js class needed on the web path.
 */
function buildWarnIssueDm({ ref, actorLabel, activeCount, reason, createdMs, expiresMs, guildName }) {
  const fields = [
    { name: "Warning", value: ref, inline: true },
    { name: "Issued by", value: actorLabel || "staff", inline: true },
    { name: "Active warnings", value: String(activeCount), inline: true },
    { name: "Reason", value: String(reason).slice(0, 1024) },
    { name: "When", value: tsFull(createdMs), inline: true },
  ];
  if (expiresMs != null) {
    fields.push({ name: "Expires", value: tsFull(expiresMs), inline: true });
  }
  return {
    embeds: [
      {
        color: Color.danger, // COLOR_ISSUE in the slash builder
        title: `Warning issued in ${guildName}`,
        fields,
        footer: { text: "View your history anytime with /warn mine" },
      },
    ],
  };
}

/**
 * Slash-identical "Warning voided" DM payload (features/warnings/index.js
 * handleVoid DM fields). Evidence stays staff-only (never in the DM) —
 * same as slash.
 */
function buildWarnVoidDm({ ref, actorLabel, activeCount, voidReason, guildName }) {
  return {
    embeds: [
      {
        color: Color.muted, // COLOR_VOID in the slash builder
        title: `Warning voided in ${guildName}`,
        fields: [
          { name: "Warning", value: ref, inline: true },
          { name: "Voided by", value: actorLabel || "staff", inline: true },
          { name: "Active warnings remaining", value: String(activeCount), inline: true },
          { name: "Void reason", value: (voidReason || "—").slice(0, 1024) },
        ],
        footer: { text: "View your history anytime with /warn mine" },
      },
    ],
  };
}

/**
 * PRG 302 to a list page with a WHITELISTED flash slug. Both the flag and
 * the slug are re-checked against the view's frozen vocabularies before the
 * Location is minted (settings.js redirectSettings doctrine): a bug at a
 * call site can still never reflect input into a redirect (§8.7).
 * @param {import("http").ServerResponse} res
 * @param {string} pageConcrete e.g. /g/123/warnings (server-derived ids only)
 * @param {"done"|"error"} flag
 * @param {string} slug
 * @param {Readonly<Record<string,string>>} doneTable
 * @param {Readonly<Record<string,string>>} errorTable
 */
function respondFlash(res, pageConcrete, flag, slug, doneTable, errorTable) {
  const safeFlag = flag === "done" ? "done" : "error";
  const table = safeFlag === "done" ? doneTable : errorTable;
  const safeSlug =
    typeof slug === "string" && table[slug] ? slug : Object.keys(table)[0];
  res.writeHead(302, {
    Location: `${pageConcrete}?${safeFlag}=${safeSlug}`,
    "Cache-Control": "no-store",
  });
  res.end();
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess] pre-built resolver (tests)
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {(() => import("discord.js").Client|null)|null} [options.getClient]
 *   live bot client — cache-only bot probe + cache-only DM seam. The app.js
 *   moderation mount predates this seam and stays UNCHANGED (subtask 29
 *   constraint), so production falls back to the SAME boot-bound client the
 *   audit mirror uses (bindAuditClient at web boot; null in tests/dark boot
 *   ⇒ graceful skips identical to slash's member-miss paths). Tests inject
 *   their own fake via this option.
 * @param {object} [options.db] db facade (slash-parity helpers); default
 *   src/db — resolved at registration time, so the loadDb require-cache
 *   reset in tests binds the fresh connection first (routes/staff.js
 *   doctrine). Helpers are called via PROPERTY ACCESS at call time so the
 *   Phase-2/3 gate's facade recorder (installed before the first POST) is
 *   what actually runs — zero route SQL.
 * @param {{snippetWarn?: Function, snippetNote?: Function}} [options.helpers]
 *   snippet overrides for tests; production resolves the FEATURES' OWN
 *   exported snippet (lazy require) so mirror/audit detail strings are
 *   byte-identical to slash.
 */
function registerModerationRoutes(app, options = {}) {
  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  // Slash-identical service layer on the shared facade (property access at
  // call time — see JSDoc above for the recorder doctrine).
  const facade = options.db || require("../../db");
  const MAX_WARN_REASON = facade.MAX_WARN_REASON;
  const MAX_EVIDENCE_TEXT = facade.MAX_EVIDENCE_TEXT;
  const MAX_EXPIRY_DAYS = facade.MAX_EXPIRY_DAYS;
  const MAX_NOTE_CONTENT = facade.MAX_NOTE_CONTENT;

  // The snippet() the slash records into details/mirrors — resolved LAZILY
  // from the features' own exports (pure functions; lazy so route load
  // order never couples to feature load order and tests can override).
  const snippetWarn =
    options.helpers?.snippetWarn ||
    ((s, max) => require("../../features/warnings").snippet(s, max));
  const snippetNote =
    options.helpers?.snippetNote ||
    ((s, max) => require("../../features/staffNotes").snippet(s, max));

  // Client seam: injected getClient (tests) or the boot-bound mirror client
  // (production — same object features/web binds for the audit channel
  // mirrors). Cache-only reads downstream; NEVER a fetch on a request path.
  const getClient =
    typeof options.getClient === "function"
      ? options.getClient
      : getBoundAuditClient;

  // LAZY require: app.js requires THIS module while app.js itself is still
  // loading, so a top-level `require("../app")` would observe a partially
  // initialized module. registerModerationRoutes only ever runs from inside
  // createWebApp(), long after ../app's exports are complete.
  const { registerWebMutation } = require("../app");

  /**
   * Structural lockstep (mutation-gate contract): the methodGate registry
   * entry and the Express route are minted from ONE call with ONE template
   * constant — they cannot drift. All three moderation mutations are STAFF
   * tier (§8.6 Moderation/Users rows; slash requireStaff parity).
   * @param {string} template
   * @param {(req: any, res: any, next: (err?: unknown) => void) => Promise<void>|void} handler
   */
  const postMutation = (template, handler) => {
    registerWebMutation(app, "POST", template);
    app.post(template, requireTier("staff"), handler);
  };

  const warnPage = (guildId) => `/g/${encodeURIComponent(guildId)}/warnings`;
  const notesPage = (guildId) => `/g/${encodeURIComponent(guildId)}/notes`;
  const warnFlash = (res, guildId, flag, slug) =>
    respondFlash(res, warnPage(guildId), flag, slug, WARN_FLASH_DONE, WARN_FLASH_ERROR);
  const noteFlash = (res, guildId, flag, slug) =>
    respondFlash(res, notesPage(guildId), flag, slug, NOTE_FLASH_DONE, NOTE_FLASH_ERROR);

  // ---- staff: guild-wide warnings list -------------------------------------
  app.get(WARNINGS_PAGE, requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const params = rawParams(req.url);
      const page = buildWarningsPage(guildId, {
        u: params.get("u"),
        state: params.get("state"),
        n: params.get("n"),
        o: params.get("o"),
      });
      const document = renderShellPage(req, {
        title: "Warnings",
        heading: "Warnings",
        subheading: "Guild-wide formal record — voided rows stay, badged. Issue/void run the exact slash pipeline, audit included.",
        content: renderWarningsBody(req, {
          page,
          flash: flashFromQuery(rawFlashQuery(req.url), WARN_FLASH_DONE, WARN_FLASH_ERROR),
          csrfToken: req.csrfToken || null,
          bounds: { maxReason: MAX_WARN_REASON, maxEvidence: MAX_EVIDENCE_TEXT, maxExpiryDays: MAX_EXPIRY_DAYS },
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err); // → handleAppError: generic 500, nothing leaked
    }
  });

  // ---- staff: guild-wide staff-notes list ----------------------------------
  app.get(NOTES_PAGE, requireTier("staff"), async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const params = rawParams(req.url);
      const page = buildNotesPage(guildId, {
        u: params.get("u"),
        state: params.get("state"),
        n: params.get("n"),
        o: params.get("o"),
      });
      const document = renderShellPage(req, {
        title: "Staff notes",
        heading: "Staff notes",
        subheading: "Guild-wide staff-only memory — soft-deleted rows stay hidden until revealed, exactly like /note list.",
        content: renderNotesBody(req, {
          page,
          flash: flashFromQuery(rawFlashQuery(req.url), NOTE_FLASH_DONE, NOTE_FLASH_ERROR),
          csrfToken: req.csrfToken || null,
          bounds: { maxContent: MAX_NOTE_CONTENT },
        }),
        guilds: await shellGuilds(resolver, req),
      });
      writeShellHtml(req, res, { status: 200, document });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Phase 3 mutations (subtask 29). Route choreography: CSRF (auto, /g/) →
  // requireTier("staff") → validation (slash bounds, ZERO write helpers on
  // refusal) → slash-identical service helper via the facade → ONE req.audit
  // row (fail-closed, mirror through the slash's own channel path) →
  // best-effort member DM (issue/void only, cache-only seam) → 302 PRG with
  // a whitelisted slug.
  // =========================================================================

  /**
   * Parse + validate one /warn add submission into the slash-equivalent
   * inputs (pure validate-at-boundary). Bounds are the slash's OWN option
   * definitions re-checked with the repository's OWN validators where one
   * exists (normalizeEvidenceMessageUrl / normalizeEvidenceText are the
   * exact validators handleAdd runs — web mirrors them literally, including
   * the guild-scoped message-link rule and the empty→null normalizations).
   * @param {Record<string, unknown>} fields req.bodyFields
   * @param {string} guildId server-derived (guildScope snowflake)
   */
  function parseWarnIssueInput(fields, guildId) {
    const rawUser = String(fields.user_id == null ? "" : fields.user_id).trim();
    if (!USER_ID_RE.test(rawUser) || rawUser === String(guildId)) {
      return { ok: false, errorSlug: "invalid_user" };
    }

    const reason = String(fields.reason == null ? "" : fields.reason).trim();
    if (!reason) return { ok: false, errorSlug: "missing_reason" };
    if (reason.length > MAX_WARN_REASON) {
      return { ok: false, errorSlug: "reason_too_long" };
    }

    // Evidence message link — the slash's exact validator (guild-scoped).
    const messageOpt = String(fields.message == null ? "" : fields.message).trim();
    const urlCheck = facade.normalizeEvidenceMessageUrl(
      messageOpt || null,
      guildId
    );
    if (!urlCheck.ok) return { ok: false, errorSlug: "invalid_evidence_url" };

    // Evidence freeform text — the slash's exact validator.
    const evidenceOpt = String(fields.evidence == null ? "" : fields.evidence);
    const evidenceCheck = facade.normalizeEvidenceText(evidenceOpt);
    if (!evidenceCheck.ok) {
      return { ok: false, errorSlug: "invalid_evidence_text" };
    }

    // Linked staff note NUMBER → note row id (slash: unknown number =
    // refusal "No staff note N-x in this server", zero writes).
    const rawNote = String(fields.note == null ? "" : fields.note).trim();
    let relatedNoteId = null;
    if (rawNote) {
      if (!NOTE_NUMBER_RE.test(rawNote)) {
        return { ok: false, errorSlug: "invalid_note" };
      }
      const note = facade.getStaffNote(guildId, Number(rawNote));
      if (!note) return { ok: false, errorSlug: "invalid_note" };
      relatedNoteId = note.id;
    }

    // Expiry override: EMPTY = omitted = guild default (slash IntegerOption
    // null); digits only, 0…MAX_EXPIRY_DAYS (slash min:0 max:3650).
    const rawDays = String(fields.expires_days == null ? "" : fields.expires_days).trim();
    let expiresDays = null;
    if (rawDays) {
      if (!DAYS_RE.test(rawDays) || Number(rawDays) > MAX_EXPIRY_DAYS) {
        return { ok: false, errorSlug: "invalid_expiry" };
      }
      expiresDays = Number(rawDays);
    }

    return {
      ok: true,
      userId: rawUser,
      reason,
      relatedNoteId,
      expiresDays,
      evidenceMessageUrl: urlCheck.url,
      evidenceText: evidenceCheck.text,
      silent: TRUTHY.has(String(fields.silent ?? "").trim().toLowerCase()),
    };
  }

  // ---- POST issue (slash /warn add twin) ------------------------------------
  postMutation(WARN_ISSUE_PATH, async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const parsed = parseWarnIssueInput(readFields(req), guildId);
      if (!parsed.ok) {
        warnFlash(res, guildId, "error", parsed.errorSlug);
        return;
      }
      const { userId, reason, relatedNoteId, expiresDays, evidenceMessageUrl, evidenceText, silent } = parsed;

      // Client reads are CACHE-ONLY (never a network fetch on a request path).
      let client = null;
      try {
        client = getClient();
      } catch {
        client = null;
      }

      // Slash parity: `if (target.bot)` refusal ("Warnings are for human
      // members, not bots.") — refusal only on PROVEN bot evidence.
      if (isProvenBot(client, guildId, userId)) {
        warnFlash(res, guildId, "error", "bot_target");
        return;
      }

      // Slash-identical expiry inputs (handleAdd: guildWarnExpiryDays +
      // pass-through of expiresDays/guildDefaultDays to the repo, which
      // resolves expires_at via resolveExpiryDays + warning_number
      // allocation inside ONE transaction).
      const settings = facade.getGuildSettings(guildId);
      const guildDefaultDays = guildWarnExpiryDays(settings, MAX_EXPIRY_DAYS);

      let warn;
      try {
        warn = facade.createWarning({
          guildId,
          userId,
          issuerId: req.user.userId,
          reason,
          relatedNoteId,
          expiresDays,
          guildDefaultDays,
          evidenceMessageUrl,
          evidenceText,
        });
      } catch (err) {
        // Every INVALID_* bound is pre-validated above; a throw here is a
        // defense-in-depth backstop (zero rows written — the repo's tx
        // aborted). Slash answers the repo message; the web collapses it to
        // the matching fixed slug (no echo, §8.7).
        const code = err?.code;
        if (code === "INVALID_REASON") {
          warnFlash(res, guildId, "error", "missing_reason");
          return;
        }
        if (code === "INVALID_NOTE") {
          warnFlash(res, guildId, "error", "invalid_note");
          return;
        }
        if (code === "INVALID_EVIDENCE_URL") {
          warnFlash(res, guildId, "error", "invalid_evidence_url");
          return;
        }
        if (code === "INVALID_EVIDENCE_TEXT") {
          warnFlash(res, guildId, "error", "invalid_evidence_text");
          return;
        }
        if (code === "INVALID_EXPIRY") {
          warnFlash(res, guildId, "error", "invalid_expiry");
          return;
        }
        throw err; // DB error → generic 500 (slash logs + "database error")
      }

      const activeCount = facade.countActiveWarnings(guildId, userId);
      const ref = formatWarnRef(warn.warning_number);

      // Audit mirror of the slash recordSlashAudit call EXACTLY — action,
      // target, and detail shape (origin stays the 'web' default, §8.6) —
      // plus the logWarnEvent mirror (kind "warn": dedicated warn-log
      // channel with audit fallback, same resolveLogChannel path).
      req.audit({
        action: "warnings.add",
        targetType: "user",
        targetId: userId,
        guildId,
        details: {
          warning_id: warn.id,
          warning_number: warn.warning_number,
          reason: warn.reason,
          expires_at: warn.expires_at ?? null,
          silent,
        },
        mirror: {
          kind: "warn",
          title: "Warning issued",
          command: "/warn add",
          changes: [
            `${ref} on <@${userId}>`,
            `Active count: **${activeCount}**`,
            snippetWarn(warn.reason, 120),
            warn.expires_at != null
              ? `Expires: ${tsFull(warn.expires_at)}`
              : "Expires: never",
          ],
        },
      });

      // Member DM — slash order (record → log → DM), same toggle
      // (warn_dm_members) and silent option; cache-only resolution, so an
      // uncached member degrades exactly like slash's unresolvable-target
      // path: warn + audit still happened, the DM is honestly skipped.
      if (!silent && warnDmEnabled(settings)) {
        const target = resolveUserCacheOnly(client, guildId, userId);
        await tryDmUser(target, buildWarnIssueDm({
          ref,
          actorLabel: req.user.discordTag || "staff",
          activeCount,
          reason: warn.reason,
          createdMs: warn.created_at,
          expiresMs: warn.expires_at ?? null,
          guildName: cachedGuildName(client, guildId),
        }));
      }

      warnFlash(res, guildId, "done", "warn_issued");
    } catch (err) {
      next(err); // fail-closed: an audit throw aborts with the generic 500
    }
  });

  /** Cache-only guild name for the DM title (slash: interaction.guild?.name). */
  function cachedGuildName(client, guildId) {
    try {
      return client?.guilds?.cache?.get?.(guildId)?.name || "this server";
    } catch {
      return "this server";
    }
  }

  // ---- POST void (slash /warn void twin) -------------------------------------
  postMutation(WARN_VOID_PATH, async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const fields = readFields(req);

      // Warning NUMBER (slash IntegerOption id min:1) on the body — digits,
      // ≥ 1; anything else never reaches the service.
      const rawNumber = String(
        fields.warning_number == null ? "" : fields.warning_number
      ).trim();
      if (!WARN_NUMBER_RE.test(rawNumber)) {
        warnFlash(res, guildId, "error", "invalid_warning_number");
        return;
      }
      const warningNumber = Number(rawNumber);

      // Void reason — same bounds as the slash (required, ≤ MAX_WARN_REASON,
      // repo label "Void reason"). Pre-validated so a refusal writes NOTHING.
      const rawReason = String(fields.reason == null ? "" : fields.reason);
      const voidReason = rawReason.trim();
      if (!voidReason) {
        warnFlash(res, guildId, "error", "void_reason_missing");
        return;
      }
      if (voidReason.length > MAX_WARN_REASON) {
        warnFlash(res, guildId, "error", "void_reason_too_long");
        return;
      }

      let warn;
      try {
        // Guild-scoped by construction: a number issued in guild B simply
        // does not resolve under guild A (warn_not_found, zero side effects).
        warn = facade.voidWarning(guildId, warningNumber, {
          voidedBy: req.user.userId,
          voidReason,
        });
      } catch (err) {
        if (err?.code === "ALREADY_VOIDED") {
          // Slash keeps the row and replies; the web throws PRE-update, so
          // this refusal is zero-write by construction.
          warnFlash(res, guildId, "error", "already_voided");
          return;
        }
        if (err?.code === "INVALID_REASON") {
          warnFlash(res, guildId, "error", "void_reason_missing");
          return;
        }
        throw err; // DB error → generic 500
      }

      if (!warn) {
        warnFlash(res, guildId, "error", "warn_not_found");
        return;
      }

      const activeCount = facade.countActiveWarnings(guildId, warn.user_id);
      const ref = formatWarnRef(warn.warning_number);

      // Slash-exact vocabulary + detail shape (features/warnings/index.js
      // handleVoid recordSlashAudit), kind "warn" mirror (logWarnEvent path).
      req.audit({
        action: "warnings.void",
        targetType: "warning",
        targetId: String(warn.id),
        guildId,
        details: {
          warning_number: warn.warning_number,
          subject_user_id: warn.user_id,
          void_reason: warn.void_reason,
        },
        mirror: {
          kind: "warn",
          title: "Warning voided",
          command: "/warn void",
          changes: [
            `${ref} on <@${warn.user_id}>`,
            `Remaining active: **${activeCount}**`,
            snippetWarn(warn.void_reason, 120),
          ],
        },
      });

      // Member DM when the guild has warn DMs ON (slash handleVoid sends the
      // void DM whenever warn_dm_members allows, no silent option on void).
      const settings = facade.getGuildSettings(guildId);
      if (warnDmEnabled(settings)) {
        let client = null;
        try {
          client = getClient();
        } catch {
          client = null;
        }
        const target = resolveUserCacheOnly(client, guildId, warn.user_id);
        await tryDmUser(target, buildWarnVoidDm({
          ref,
          actorLabel: req.user.discordTag || "staff",
          activeCount,
          voidReason: warn.void_reason,
          guildName: cachedGuildName(client, guildId),
        }));
      }

      warnFlash(res, guildId, "done", "warn_voided");
    } catch (err) {
      next(err);
    }
  });

  // ---- POST note add (slash /note add twin) ----------------------------------
  postMutation(NOTE_ADD_PATH, async (req, res, next) => {
    try {
      const guildId = req.guildAccess.guildId;
      const fields = readFields(req);

      const rawUser = String(fields.user_id == null ? "" : fields.user_id).trim();
      if (!USER_ID_RE.test(rawUser) || rawUser === String(guildId)) {
        noteFlash(res, guildId, "error", "invalid_user");
        return;
      }

      // Content — slash setMaxLength(MAX_NOTE_CONTENT) + the modal's
      // required text (persistNewNote INVALID_CONTENT empty bound): bounds
      // pre-validated, so a refusal reaches ZERO write helpers.
      const rawContent = String(fields.content == null ? "" : fields.content);
      const content = rawContent.trim();
      if (!content) {
        noteFlash(res, guildId, "error", "content_empty");
        return;
      }
      if (content.length > MAX_NOTE_CONTENT) {
        noteFlash(res, guildId, "error", "content_too_long");
        return;
      }

      let client = null;
      try {
        client = getClient();
      } catch {
        client = null;
      }
      // Slash parity: "Staff notes are for human members, not bots."
      if (isProvenBot(client, guildId, rawUser)) {
        noteFlash(res, guildId, "error", "bot_target");
        return;
      }

      let note;
      try {
        // Sequential note_number + INVALID_CONTENT guard live in the repo —
        // same helper the slash's persistNewNote calls, same args.
        note = facade.createStaffNote({
          guildId,
          userId: rawUser,
          authorId: req.user.userId,
          content,
        });
      } catch (err) {
        if (err?.code === "INVALID_CONTENT") {
          noteFlash(res, guildId, "error", content ? "content_too_long" : "content_empty");
          return;
        }
        throw err; // DB error → generic 500
      }

      // Slash-exact vocabulary + detail shape (features/staffNotes/index.js
      // handleAdd recordSlashAudit: content snippeted to 500 with the
      // FEATURE's own snippet). Default mirror kind = logConfigChange's
      // audit-channel path ("Staff note created", "/note add") — notes post
      // NO warn-log embed and NEVER DM the subject (slash parity).
      req.audit({
        action: "notes.add",
        targetType: "note",
        targetId: String(note.id),
        guildId,
        details: {
          note_number: note.note_number,
          subject_user_id: rawUser,
          content: snippetNote(note.content, 500),
        },
        mirror: {
          title: "Staff note created",
          command: "/note add",
          changes: [
            `${formatNoteRef(note.note_number)} on <@${rawUser}>`,
            snippetNote(note.content, 120),
          ],
        },
      });

      noteFlash(res, guildId, "done", "note_added");
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  registerModerationRoutes,
  // List pages (pinned by test/web-routes-moderation.test.js + Phase-1 gate)
  WARNINGS_PAGE,
  NOTES_PAGE,
  // Mutation surface (pinned by test/web-moderation-actions.test.js + the
  // Phase-2 gate lockstep suites)
  WARN_ISSUE_PATH,
  WARN_VOID_PATH,
  NOTE_ADD_PATH,
  // Validation shapes (pure helpers exercised directly by the test suite)
  WARN_NUMBER_RE,
  NOTE_NUMBER_RE,
  DAYS_RE,
  isProvenBot,
  resolveUserCacheOnly,
  guildWarnExpiryDays,
  warnDmEnabled,
};
