/**
 * POST /g/:guildId/tickets/{claim,close,summarize} + GET form page — the
 * Phase-3 TICKET ACTION surface (roadmap/web-admin.md §8.6 "Tickets" row:
 * "Senior: claim/close/summary regen"; §8.8 Phase 3; subtask 30). These are
 * the ONLY web ticket mutations; creation/transfer/members/sensitive/archive
 * stay slash-only (§8.6 read/write split — the web scope is exactly the
 * three mutations the design row names).
 *
 * SERVICE PARITY (the whole point — features/tickets/index.js handleClaim/
 * handleClose/handleSummarize mirrored exactly, helpers reused, state
 * machines NEVER re-implemented):
 *  - claim: facade.claimTicket(id, actor) — the VERY helper slash
 *    handleClaim calls (features/tickets/index.js:1650). Slash has NO
 *    already-claimed rejection: claim is an idempotent TAKEOVER on an OPEN
 *    ticket (the repo clears is_owner on others; the audit's previous_owner
 *    records the hand-off). The web mirrors that semantic exactly; the only
 *    gate is slash's own requireOpenTicketChannel status rule, enforced
 *    BEFORE the helper runs (zero writes on refusal). Best-effort channel
 *    overwrites + the "claimed this ticket." channel notice run after the
 *    audit through the CACHE-ONLY channel seam (slash:1662–1682 does the
 *    same, try/catch-swallowed); an uncached channel skips exactly like
 *    slash's null-channel path.
 *  - close: the slash's OWN softCloseTicket (close.js:358) with the same
 *    args — markTicketClosed transition (WHERE status='open'), close_reason
 *    storage, closed_by, staff-only overwrite pass, close notice, requester
 *    DM all live INSIDE the helper. Channel handling: the channel is read
 *    from the client's cache only; a missing/uncached channel degrades
 *    EXACTLY like the slash service's own degraded path (slash cannot even
 *    run outside a channel, so softCloseTicket's behavior with an
 *    unresolvable channel IS the slash-degraded reference: DB transition
 *    committed first, permission pass + notice skipped as swallowed
 *    warnings, requester DM best-effort). The flash claims ONLY the close
 *    transition — which genuinely happened — never the Discord-side steps.
 *  - summarize: the slash's OWN summarizeTicket (handleSummarize:2143, empty
 *    opts) over listTicketMessages(ticket.id). Slash's live-ticket rule
 *    (requireLiveTicketChannel: open OR soft-closed, archived refused) is
 *    mirrored; the archived refusal collapses to a fixed slug. Slash's
 *    message fallback reads the Discord channel (fetchAllMessages) — the
 *    web NEVER fetches: empty stored rows ⇒ refusal mirroring slash's
 *    own read-failure reply ("Could not read the ticket conversation…").
 *    Slash's on-demand summarize persists NOTHING (only the archive
 *    pipeline writes ai_summary_json) — the web persists nothing either
 *    (same way: the audit row + flash source slug carry the outcome).
 *
 * DOCUMENTED PARITY DELTAS (web STRICTENSING only — each asserted by
 * test/web-ticket-actions.test.js and pinned as the Phase-2/3 gate rows):
 *  (1) TIER: all three are SENIOR here (§8.6 "Mutate tier: Senior") while
 *      the slash gates them with requireStaff (staff tier suffices). That
 *      is the design's deliberate tightening — junior staff keep the Phase
 *      0c READ/transcript access untouched and simply lose these writes.
 *  (2) SENSITIVE summarize: slash summarizes a sensitive ticket in-channel
 *      (ephemeral staff embed); the web REFUSES with the generic 404 (same
 *      bytes as unknown/cross-guild) before touching messages or the AI —
 *      §8.4 never ships sensitive content to the web transport.
 *  (3) AI guardrail: slash degrades to a stats-only fallback when no
 *      AI_API_KEY is configured; the web refuses up front with the named
 *      slug (ai_not_configured) and ZERO AI calls — a regeneration request
 *      without a configured AI is a misconfiguration, not a summary. Same
 *      web-hardening precedent as Phase-2 youtube/add refusing without
 *      YOUTUBE_API_KEY (Phase-2 gate delta (b)).
 *  (4) Close staff_note: slash's optional one-shot staff_note option is
 *      NOT part of the web surface (the close FLOW is identical; the note
 *      add-on keeps its own slash/notes surface).
 *
 * TIER + SECURITY CHOREOGRAPHY: methodGate (POST allowed only because
 * registerWebMutation carries the exact template) → session → audit
 * middleware → body cap → mutation rate limit → CSRF (auto on /g/, hidden
 * _csrf) → guildScope (anon ⇒ 302 login, cross-guild/stranger ⇒ generic
 * 404, never 403) → requireTier("senior") (junior ⇒ fixed 403) → handler.
 * Ticket id is a BODY field (methodGate templates carry :guildId as their
 * ONLY param segment — moderation doctrine); the ticket row is loaded via
 * the facade and MUST belong to THIS guild or the response is the generic
 * 404 (no id enumeration).
 *
 * AUDIT (§8.6, DB-first fail-closed via req.audit, origin 'web'): ONE
 * admin_audit row per mutation reusing the EXACT slash vocabulary + detail
 * shape — tickets.claim {ticket_number, previous_owner, staff_owner_id}
 * (index.js:1651), tickets.close {ticket_number, close_reason, status}
 * (:1410), tickets.summarize {ticket_number, source, message_count}
 * (:2145). Slash mirrors NO channel embed for these three (no
 * logConfigChange in those handlers), so the web entries carry no mirror
 * descriptor either. Rejections write NOTHING; an audit insert failure
 * aborts with the generic 500 (fail-closed — the action outcome is never
 * silently claimed).
 *
 * MUTATION CONTRACT (Phase-2 doctrine): the methodGate registry entry and
 * the Express route are minted from ONE path constant via postMutation
 * (registerWebMutation + app.post + requireTier("senior") lockstep — they
 * cannot drift). Body fields arrive pre-parsed on req.bodyFields (body-cap
 * consumed the stream — no express parsers on top). PRG: success ⇒ 302 to
 * the actions page with `?done=<slug>`, a refusal ⇒ 302 `?error=<slug>` —
 * slugs are frozen constants re-checked against the view's whitelists
 * before the Location is minted; NO submitted value is ever echoed into a
 * redirect (§8.7). Ticket-existence/guild/sensitive refusals answer the
 * generic 404 "Not found" instead (indistinguishable from unknown).
 */

const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { getBoundAuditClient } = require("../middleware/audit");
const { readFields } = require("./shared/req.js");
const { makeFlashRedirect } = require("./shared/flash.js");
const { rawFlashQuery } = require("./shared/req.js");
const { rawParams } = require("./shared/req.js");
const { shellGuilds } = require("./shared/shell.js");
const {
  renderTicketActionsBody,
  flashFromQuery,
  FLASH_DONE,
  FLASH_ERROR,
} = require("../views/ticketActions");

/** Actions surface (GET form + the three POST targets share the prefix). */
const ACTIONS_PAGE = "/g/:guildId/tickets";
const CLAIM_PATH = "/g/:guildId/tickets/claim";
const CLOSE_PATH = "/g/:guildId/tickets/close";
const SUMMARIZE_PATH = "/g/:guildId/tickets/summarize";

/**
 * Ticket id field shape: the DB row id (digits, no leading zero, ≤ 12
 * digits — JS-safe). EVIDENCE for "row id, not T-number": slash carries
 * `ticket.id` internally (`tk:sn:<ticketId>` buttons, close.js), the audit
 * targetId is `String(ticket.id)`, and the page lists the id next to the
 * human T-ref. The human ticket_number stays display-only (form values and
 * audit details carry both — details.ticket_number mirrors slash's shape).
 */
const TICKET_ID_RE = /^[1-9][0-9]{0,11}$/;

/** Open-ticket page list bound (the repo clamps LIMIT to ≤ 50 anyway). */
const OPEN_LIST_LIMIT = 50;

/**
 * Parse + validate one ticket action submission (pure validate-at-boundary).
 * @param {Record<string, unknown>} fields req.bodyFields
 * @returns {{ ok: true, ticketId: number } | { ok: false, errorSlug: string }}
 */
function parseTicketIdField(fields) {
  const raw = String(fields.ticket_id == null ? "" : fields.ticket_id).trim();
  if (!TICKET_ID_RE.test(raw)) {
    return { ok: false, errorSlug: "invalid_ticket_id" };
  }
  const ticketId = Number(raw);
  if (!Number.isSafeInteger(ticketId)) {
    return { ok: false, errorSlug: "invalid_ticket_id" };
  }
  return { ok: true, ticketId };
}

/** Generic plain 404 (byte-identical to app.js handleNotFound) — unknown
 * ticket, foreign-guild ticket and the sensitive-summarize refusal are
 * INDISTINGUISHABLE (§8.6 no-enumeration doctrine extended to resources). */
function sendNotFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}





/**
 * Cache-ONLY ticket-channel lookup (slash resolveChannel minus its fetch
 * step — a web request NEVER hits the Discord API). The channel object,
 * when cached, is the SAME live channel slash receives, so the feature's
 * own best-effort Discord operations (overwrites, notices, requester DM)
 * behave identically; a cache miss degrades exactly like slash's
 * null-channel path (graceful skip), never a fabricated success claim.
 * @param {any} client resolved client or null
 * @param {string} channelId ticket.channel_id
 * @returns {any|null}
 */
function resolveChannelCacheOnly(client, channelId) {
  if (!channelId) return null;
  try {
    return client?.channels?.cache?.get?.(channelId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Cache-ONLY bot member (slash resolveBotMember minus its
 * guild.members.fetch fallback — cache miss ⇒ null, identical to slash's
 * member-fetch-failure path; softCloseTicket tolerates a null botMember).
 * @param {any} client resolved client or null
 * @param {string} guildId
 * @returns {any|null}
 */
function resolveBotMemberCacheOnly(client, guildId) {
  try {
    const guild = client?.guilds?.cache?.get?.(guildId) ?? null;
    if (!guild) return null;
    if (guild.members?.me) return guild.members.me;
    const botId = client?.user?.id;
    if (!botId) return null;
    return guild.members?.cache?.get?.(botId) ?? null;
  } catch {
    return null;
  }
}

/** Cache-only guild object (claim overwrites need everyoneId = guild.id). */
function resolveGuildCacheOnly(client, guildId) {
  try {
    return client?.guilds?.cache?.get?.(guildId) ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {import("express").Express} app
 * @param {object} [options]
 * @param {{resolve: Function, listGuilds: Function}} [options.guildAccess]
 *   pre-built resolver (app.js passes the SAME instance the guild shell
 *   uses — one tier cache, §8.3); default builds one from the seams below.
 * @param {string} [options.apiBase] @param {typeof fetch} [options.fetchImpl]
 * @param {() => string[]|Promise<string[]>} [options.botGuilds]
 * @param {(() => import("discord.js").Client|null)|null} [options.getClient]
 *   live bot client — CACHE-ONLY channel/guild/member seams (tests inject
 *   fakes whose network methods are ABSENT; production falls back to the
 *   boot-bound mirror client, same seam as routes/moderation.js).
 * @param {object} [options.db] db facade (slash-parity helpers); default
 *   src/db — resolved at registration time, so the loadDb require-cache
 *   reset in tests binds the fresh connection first (routes/staff.js
 *   doctrine). Helpers are called via PROPERTY ACCESS at call time so the
 *   gate's facade recorder (installed before the first POST) is what the
 *   handlers actually run — zero route SQL.
 * @param {{summarizeTicket?: Function, isAiConfigured?: Function}}
 *   [options.ticketActions] AI seams for tests (call-through spies);
 *   production omits them and the REAL features/tickets/summary + core/ai
 *   modules resolve lazily PER CALL (lazy so route load order never couples
 *   to feature load order AND the recorder/module swaps bind first).
 * @param {{softCloseTicket?: Function, applyTicketOverwrites?: Function}}
 *   [options.services] service-layer overrides for tests (call-through
 *   spies — the moderation/xp `services` seam pattern); production omits
 *   them and the slash's OWN features/tickets helpers resolve lazily.
 */
function registerTicketActionsRoutes(app, options = {}) {
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
  const MAX_TICKET_REASON = facade.MAX_TICKET_REASON;

  // Client seam: injected getClient (tests) or the boot-bound mirror client
  // (moderation doctrine). Cache-only reads downstream; NEVER a fetch on a
  // request path (the fakes omit network methods to prove it).
  const getClient =
    typeof options.getClient === "function"
      ? options.getClient
      : getBoundAuditClient;

  // Lazy service bindings (per call) — softCloseTicket is the slash's OWN
  // close helper; summarizeTicket the slash's OWN AI/fallback summarizer.
  const softClose =
    options.services?.softCloseTicket ||
    ((...args) => require("../../features/tickets/close").softCloseTicket(...args));
  const applyOverwrites =
    options.services?.applyTicketOverwrites ||
    ((...args) => require("../../features/tickets/overwrites").applyTicketOverwrites(...args));
  const summarizeTicket =
    options.ticketActions?.summarizeTicket ||
    ((...args) => require("../../features/tickets/summary").summarizeTicket(...args));
  // AI guardrail (web hardening delta (3) — see header): refuse BEFORE any
  // AI call when no key is configured. Env is read at CALL time.
  const aiConfigured =
    options.ticketActions?.isAiConfigured ||
    (() => Boolean(require("../../core/ai").getAiConfig().apiKey));

  const readClient = () => {
    try {
      return getClient() ?? null;
    } catch {
      return null;
    }
  };

  // LAZY require: app.js requires THIS module while app.js itself is still
  // loading, so a top-level `require("../app")` would observe a partially
  // initialized module. registerTicketActionsRoutes only ever runs from
  // inside createWebApp(), long after ../app's exports are complete.
  const { registerWebMutation } = require("../app");

  /**
   * Structural lockstep (mutation-gate contract): the methodGate registry
   * entry and the Express route are minted from ONE call with ONE template
   * constant — they cannot drift. All three ticket mutations are SENIOR
   * tier (§8.6 Tickets row; the documented tightening vs slash requireStaff
   * — see header delta (1)).
   * @param {string} template
   * @param {(req: any, res: any, next: (err?: unknown) => void) => Promise<void>|void} handler
   */
  const postMutation = (template, handler) => {
    registerWebMutation(app, "POST", template);
    app.post(template, requireTier("senior"), handler);
  };

  const actionsPage = (guildId) => `/g/${encodeURIComponent(guildId)}/tickets`;

  /**
   * PRG 302 to the actions page with a WHITELISTED flash slug. Both the
   * flag and the slug are re-checked against the view's frozen vocabularies
   * before the Location is minted (settings.js redirectSettings doctrine):
   * a bug at a call site can still never reflect input into a redirect.
   */
  const flash = makeFlashRedirect({
    pageOf: actionsPage,
    doneTable: FLASH_DONE,
    errorTable: FLASH_ERROR,
  });

  /**
   * Load the ticket the body names and prove it belongs to THIS guild.
   * Unknown id and foreign-guild id are the SAME generic 404 (resource-
   * level no-enumeration; guildScope already answered the guild-level rule).
   * @returns {{ ok: true, ticket: object } | { ok: false, refused: "invalid"|"not_found", errorSlug?: string }}
   */
  const loadTicket = (fields, guildId) => {
    const parsed = parseTicketIdField(fields);
    if (!parsed.ok) {
      return { ok: false, refused: "invalid", errorSlug: parsed.errorSlug };
    }
    const ticket = facade.getTicketById(parsed.ticketId);
    if (!ticket || String(ticket.guild_id) !== String(guildId)) {
      return { ok: false, refused: "not_found" };
    }
    return { ok: true, ticket };
  };

  // ---- senior: ticket actions page (GET) — open tickets + forms ---------
  // Senior-only end to end: the page hosts ONLY senior controls (xpActions
  // "never render a form that 403s" doctrine). The Phase-0c ticket READ
  // surfaces (/t index + transcripts, staff-or-participant §8.4) are
  // untouched by this module.
  app.get(ACTIONS_PAGE, requireTier("senior"), async (req, res) => {
    const guildId = req.guildAccess.guildId;
    const tickets = facade.listOpenTickets(guildId, { limit: OPEN_LIST_LIMIT });
    const document = renderShellPage(req, {
      title: "Ticket actions",
      heading: "Ticket actions",
      subheading:
        "Senior staff — claim / close / summary regen run the exact slash pipelines (audit origin web). Archive and creation stay slash-only.",
      content: renderTicketActionsBody({
        guildId,
        tickets,
        csrfToken: req.csrfToken || null,
        flash: flashFromQuery(rawFlashQuery(req.url)),
        maxReason: MAX_TICKET_REASON,
      }),
      guilds: await shellGuilds(resolver, req),
    });
    writeShellHtml(req, res, { status: 200, document });
  });

  // =========================================================================
  // Phase 3 mutations (subtask 30). Route choreography: CSRF (auto, /g/) →
  // requireTier("senior") → id validation (zero write helpers on refusal) →
  // ticket load + guild scoping (generic 404) → slash-status rules → the
  // slash's OWN helper through the facade/seams → ONE req.audit row
  // (fail-closed) → best-effort cache-only Discord side effects → 302 PRG
  // with a whitelisted slug.
  // =========================================================================

  // ---- POST claim (slash /ticket claim twin) ------------------------------
  postMutation(CLAIM_PATH, async (req, res) => {
    const guildId = req.guildAccess.guildId;
    const loaded = loadTicket(readFields(req), guildId);
    if (!loaded.ok) {
      if (loaded.refused === "not_found") {
        sendNotFound(res);
        return;
      }
      flash(res, guildId, "error", loaded.errorSlug);
      return;
    }
    const { ticket } = loaded;

    // Slash requireOpenTicketChannel (index.js:604): OPEN only. Refusal
    // happens BEFORE claimTicket — zero writes, zero audit.
    if (ticket.status !== "open") {
      flash(res, guildId, "error", "ticket_not_open");
      return;
    }

    // Slash-identical claim (handleClaim:1650): the SAME helper, actor =
    // the web user. Idempotent takeover semantics preserved (no
    // already-claimed rejection exists on the slash path).
    const updated = facade.claimTicket(ticket.id, req.user.userId);

    // Audit BEFORE the Discord niceties — the exact slash order
    // (claimTicket → recordSlashAudit → overwrites → channel notice).
    // Details shape = index.js:1651-1661; origin stays 'web'.
    req.audit({
      action: "tickets.claim",
      targetType: "ticket",
      targetId: String(ticket.id),
      guildId,
      details: {
        ticket_number: ticket.ticket_number,
        previous_owner: ticket.staff_owner_id ?? null,
        staff_owner_id: updated?.staff_owner_id ?? req.user.userId,
      },
      // No mirror descriptor: the slash claim handler posts NO
      // logConfigChange channel embed (§8.1-7 mirrors mirror slash).
    });

    // Best-effort Discord side effects — CACHE-ONLY seam, graceful skip
    // (slash:1662-1682: `if (channel)` overwrites try/catch-warned, then
    // the "claimed" channel notice try/catch-ignored).
    const client = readClient();
    const channel = resolveChannelCacheOnly(client, ticket.channel_id);
    if (channel) {
      const guild = resolveGuildCacheOnly(client, guildId);
      try {
        await applyOverwrites(channel, {
          guildId,
          everyoneId: guild?.id ?? guildId,
          botUserId: client?.user?.id,
          ticket: updated,
        });
      } catch (err) {
        console.warn("[web.tickets] claim overwrites:", err?.message || err);
      }
      try {
        if (channel.send) {
          await channel.send(`<@${req.user.userId}> claimed this ticket.`);
        }
      } catch {
        // slash ignores it too (index.js:1678-1682)
      }
    }

    flash(res, guildId, "done", "ticket_claimed");
    // fail-closed: an audit throw aborts with the generic 500
  });

  // ---- POST close (slash /ticket close twin — soft close) -----------------
  postMutation(CLOSE_PATH, async (req, res) => {
    const guildId = req.guildAccess.guildId;
    const fields = readFields(req);
    const loaded = loadTicket(fields, guildId);
    if (!loaded.ok) {
      if (loaded.refused === "not_found") {
        sendNotFound(res);
        return;
      }
      flash(res, guildId, "error", loaded.errorSlug);
      return;
    }
    const { ticket } = loaded;

    // Slash requireOpenTicketChannel: close runs on OPEN tickets only
    // (archive of a closed ticket stays slash /ticket archive — out of
    // the §8.6 web mutation scope). Zero writes on refusal.
    if (ticket.status !== "open") {
      flash(res, guildId, "error", "ticket_not_open");
      return;
    }

    // Close reason — the slash option bound (setMaxLength
    // MAX_TICKET_REASON) pre-validated so a refusal reaches ZERO write
    // helpers; trimmed-empty collapses to null (slash: `?? null` audit
    // shape, repo normalizeTicketReason allowEmpty).
    const rawReason = String(fields.reason == null ? "" : fields.reason).trim();
    if (rawReason.length > MAX_TICKET_REASON) {
      flash(res, guildId, "error", "close_reason_too_long");
      return;
    }
    const closeReason = rawReason || null;

    // The slash's OWN close helper with the same args
    // (handleClose:1401 → softCloseTicket{client, channel, ticket,
    // closedBy, closeReason, botMember}). Cache-only channel/member
    // seams: a missing channel degrades exactly like the helper's own
    // degraded path (DB transition committed first — WHERE status=
    // 'open'; permission pass + close notice skipped as swallowed
    // warnings; requester DM best-effort). The flash claims the close
    // transition, which genuinely happened, and nothing more.
    const client = readClient();
    const channel = resolveChannelCacheOnly(client, ticket.channel_id);
    const botMember = resolveBotMemberCacheOnly(client, guildId);
    const result = await softClose({
      client,
      channel,
      ticket,
      closedBy: req.user.userId,
      closeReason,
      botMember,
    });

    // Slash-exact vocabulary + detail shape (handleClose:1410-1420).
    req.audit({
      action: "tickets.close",
      targetType: "ticket",
      targetId: String(ticket.id),
      guildId,
      details: {
        ticket_number: ticket.ticket_number,
        close_reason: closeReason ?? null,
        status: result?.ticket?.status ?? ticket.status,
      },
      // No mirror: the slash close handler posts NO logConfigChange
      // (only its staff-note add-on does — delta (4) drops the add-on).
    });

    flash(res, guildId, "done", "ticket_closed");
  });

  // ---- POST summarize (slash /ticket summarize twin — regen) --------------
  postMutation(SUMMARIZE_PATH, async (req, res) => {
    const guildId = req.guildAccess.guildId;
    const loaded = loadTicket(readFields(req), guildId);
    if (!loaded.ok) {
      if (loaded.refused === "not_found") {
        sendNotFound(res);
        return;
      }
      flash(res, guildId, "error", loaded.errorSlug);
      return;
    }
    const { ticket } = loaded;

    // Sensitive ⇒ generic 404 (delta (2)): BEFORE reading messages or the
    // AI, indistinguishable from unknown/foreign. The web NEVER renders
    // or regenerates sensitive-ticket summaries (§8.4).
    if (Number(ticket.is_sensitive) === 1) {
      sendNotFound(res);
      return;
    }

    // Slash requireLiveTicketChannel archived rule (index.js:647):
    // archived tickets are refused. Open AND soft-closed are allowed —
    // exactly what slash status:"any" permits for live channels.
    if (Number(ticket.archived) === 1) {
      flash(res, guildId, "error", "ticket_archived");
      return;
    }

    // AI guardrail (delta (3)): named-var refusal with ZERO AI calls —
    // the slash silently returns a stats fallback here; the web refuses
    // instead of pretending a "regeneration" happened without one.
    if (!aiConfigured()) {
      flash(res, guildId, "error", "ai_not_configured");
      return;
    }

    // Stored rows ONLY (slash reads listTicketMessages first, then falls
    // back to a channel FETCH — the web never fetches). Empty mirrors
    // slash's read-failure reply ("Could not read the ticket
    // conversation…") as a fixed slug; zero writes, zero audit.
    const messages = facade.listTicketMessages(ticket.id);
    if (!messages.length) {
      flash(res, guildId, "error", "messages_unavailable");
      return;
    }

    // The slash's OWN summarizer with the same args (handleSummarize:
    // 2143: summarizeTicket(ticket, messages, {}) — AI when configured,
    // stats fallback on any failure; it NEVER throws). Persisting the
    // summary is NOT part of this path on either transport (only the
    // archive pipeline writes ai_summary_json) — the audit row and the
    // source-specific done slug carry the outcome.
    const summary = await summarizeTicket(ticket, messages, {});

    // Slash-exact vocabulary + detail shape (handleSummarize:2145-2155).
    req.audit({
      action: "tickets.summarize",
      targetType: "ticket",
      targetId: String(ticket.id),
      guildId,
      details: {
        ticket_number: ticket.ticket_number,
        source: summary?.source ?? null,
        message_count: summary?.message_count ?? messages.length,
      },
      // No mirror: the slash summarize posts NO channel embed.
    });

    flash(res, guildId, "done", summary?.source === "ai" ? "summary_ai" : "summary_fallback");
  });
}

module.exports = {
  registerTicketActionsRoutes,
  // Actions surface (pinned by test/web-ticket-actions.test.js + the
  // Phase-2/3 gate lockstep suites)
  ACTIONS_PAGE,
  CLAIM_PATH,
  CLOSE_PATH,
  SUMMARIZE_PATH,
  // Body-id parser (pinned directly at web-ticket-actions.test.js:575-578)
  parseTicketIdField,
};
