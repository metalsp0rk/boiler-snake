/**
 * Web admin calendar for Community Events (issue #222, roadmap §12.4).
 *
 * Same data as Discord; edits made here update the Discord message. Every
 * mutation flows through the feature service layer (message refresh,
 * reminder re-arm, role sync, activity log) and writes `admin_audit` via
 * req.audit. Without a live client things degrade honestly: where the DB
 * write is safe alone it lands (flagged "not synced", with a visible
 * "Retry Discord sync"), where Discord is REQUIRED (posting, organizer
 * role grants) the user gets the specific reason, never silence.
 *
 * Route position: registered AFTER routes/dashboard.js in app.js so the
 * guild shell already ran (anon ⇒ login redirect, cross-guild/stranger ⇒
 * generic 404 — never 403). requireTier("staff") mirrors the console pages;
 * per-event creator/edit-role gates run service.canManageEvent whenever the
 * acting member is resolvable from the client cache (web tier IS staff
 * authority when it is not — same posture as the settings console).
 *
 * Mutation contract (web-admin §8, matchesMutationPath): :guildId is the
 * ONLY parameter segment any POST template may carry, so mutations are
 * literal paths — the event/series/preset id rides the form BODY:
 *   POST /g/:guildId/events                    create draft
 *   POST /g/:guildId/events/action             action=<name> + event_id + fields
 *   POST /g/:guildId/events/series             action=skip|stop + series_id
 *   POST /g/:guildId/events/presets            save preset
 *   POST /g/:guildId/events/presets/delete     preset_id
 * CSRF/method gating/audit plumbing is app-level (csrf.js auto-enforces
 * `_csrf` on /g/ mutations; forms embed req.csrfToken).
 */

const db = require("../../db");
const service = require("../../features/events/service.js");
const series = require("../../features/events/series.js");
const ui = require("../../features/events/ui.js");
const { createGuildAccessResolver } = require("../auth/guildAccess");
const { requireTier } = require("../middleware/requireTier");
const { renderShellPage, writeShellHtml } = require("../views/layout");
const { shellGuilds } = require("./shared/shell.js");
const views = require("../views/events.js");

// events.status vocabulary (migration 042 CHECK): draft | pending_confirm |
// posted | archived | skipped. There is NO "scheduled"/"post_failed" status:
// a QUEUED POST is a draft with post_at set; post failures live on the draft
// (post_attempts / last_post_error) until the ticker succeeds.
const MONTH_STATUSES = ["draft", "pending_confirm", "posted"];
const DRAFT_STATUSES = ["draft", "pending_confirm"];

/** Queued/failed posts = drafts carrying post_at or failed-attempt bookkeeping. */
function isQueuedPost(ev) {
  return (
    DRAFT_STATUSES.includes(ev.status) &&
    (ev.post_at != null ||
      (ev.post_attempts != null && ev.post_attempts > 0) ||
      ev.last_post_error != null)
  );
}

const POST_PATHS = Object.freeze([
  "/g/:guildId/events",
  "/g/:guildId/events/action",
  "/g/:guildId/events/series",
  "/g/:guildId/events/presets",
  "/g/:guildId/events/presets/delete",
]);

function registerEventsCalendarRoutes(app, options = {}) {
  // LAZY require: app.js requires THIS module while app.js itself is still
  // loading, so a top-level `require("../app")` would observe a partially
  // initialized module (same discipline as routes/ticketActions.js).
  const { registerWebMutation } = require("../app");
  for (const path of POST_PATHS) registerWebMutation(app, "POST", path);

  const resolver =
    options.guildAccess ||
    createGuildAccessResolver({
      apiBase: options.apiBase,
      fetchImpl: options.fetchImpl,
      botGuilds: options.botGuilds,
    });

  const clientOf = () => {
    try {
      return typeof options.getClient === "function" ? options.getClient() : null;
    } catch {
      return null;
    }
  };

  /** Logged-in member from the guild cache (null when dark/unresolvable). */
  async function actor(req) {
    const client = clientOf();
    const communityId = req.guildAccess.communityId;
    let guild = null;
    try {
      guild = client ? await service.guildFor(client, communityId) : null;
    } catch {
      guild = null;
    }
    let member = null;
    try {
      member = guild?.members?.cache?.get(req.user?.userId) ?? null;
    } catch {
      member = null;
    }
    return { client, guild, member };
  }

  /**
   * Per-event manage gate. When the acting member is cache-resolvable the
   * feature gate decides (creator / edit role / delete role / staff). When it
   * is NOT resolvable (bot cache miss), the web staff tier (ManageGuild or a
   * staff_roles row — exactly what requireTier verified) stands in; the
   * console's whole surface presumes that authority.
   */
  async function canManage(req, ev, kind = "edit") {
    const { member } = await actor(req);
    if (!member) return true;
    const res = service.canManageEvent(member, req.guildAccess.communityId, ev, kind);
    return res.ok === true;
  }

  /**
   * Visibility follows Discord channel permissions for the LOGGED-IN member:
   * hide events whose channel the member definitely cannot ViewChannel
   * (cache-only — never a REST fan-out). Unknown (no client / no cached
   * member / no channel row) fails OPEN: this console is staff-only already.
   */
  function channelVisible(req, guild, channelId) {
    if (!guild || !channelId) return true;
    try {
      const channel = guild.channels?.cache?.get(String(channelId));
      const member = guild.members?.cache?.get(req.user?.userId);
      if (!channel || !member) return true;
      return channel.permissionsFor?.(member)?.has?.("ViewChannel") !== false;
    } catch {
      return true;
    }
  }

  async function shell(req, res, { status = 200, title, heading, content }) {
    const document = renderShellPage(req, {
      title,
      heading,
      content,
      guilds: await shellGuilds(resolver, req),
    });
    writeShellHtml(req, res, { status, document });
  }

  /** Event row from the BODY id (mutation contract) or 404 page. */
  function loadEvent(req, res) {
    const id = Number(req.body?.event_id ?? req.params?.eventId);
    let ev = null;
    if (Number.isInteger(id) && id > 0)
      ev = db.getEventForCommunity(id, req.guildAccess.communityId);
    if (!ev) {
      writeShellHtml(req, res, {
        status: 404,
        document: renderShellPage(req, {
          title: "Not found",
          heading: "Not found",
          content: "<p>No such event.</p>",
          guilds: [],
        }),
      });
      return null;
    }
    return ev;
  }

  // ── GET pages ─────────────────────────────────────────────────────────────

  app.get("/g/:guildId/events", requireTier("staff"), async (req, res, next) => {
    try {
      const cid = req.guildAccess.communityId;
      const settings = db.getEventGuildSettings(cid);
      const zone = settings.time_zone || "UTC";
      const now = Date.now();
      const nowInZone = new Date(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: zone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(now)) + "T12:00:00Z",
      );
      const y = clampInt(req.query?.y, 2000, 2100, nowInZone.getUTCFullYear());
      const m = clampInt(req.query?.m, 1, 12, nowInZone.getUTCMonth() + 1);
      const from = Date.UTC(y, m - 1, 1);
      const to = Date.UTC(y, m, 0, 23, 59, 59);
      const { guild } = await actor(req);
      const events = db
        // Phase-1 statement budget (§8.6): every page statement caps at ≤100
        // rows (the gate rejects any captured LIMIT > 100). Month grids with
        // 100+ events are vanishingly rare; counts elsewhere stay exact.
        .listEvents(cid, { statuses: MONTH_STATUSES, from, to, limit: 100 })
        .filter((ev) => channelVisible(req, guild, ev.channel_id));
      const draftRows = db
        .listEvents(cid, { statuses: DRAFT_STATUSES, limit: 50 })
        .filter((ev) => channelVisible(req, guild, ev.channel_id));
      const drafts = draftRows.filter((ev) => !isQueuedPost(ev));
      const scheduled = draftRows.filter(isQueuedPost);
      const content = views.withReq(req, () =>
        views.renderEventsMonth({
          cid,
          year: y,
          month: m,
          zone,
          events,
          drafts,
          scheduled,
          nowMs: now,
          csrfToken: req.csrfToken || null,
        }),
      );
      await shell(req, res, { title: "Events", heading: "Event calendar", content });
    } catch (err) {
      next(err);
    }
  });

  app.get(
    "/g/:guildId/events/archive",
    requireTier("staff"),
    async (req, res, next) => {
      try {
        const cid = req.guildAccess.communityId;
        const settings = db.getEventGuildSettings(cid);
        // ≤100 (phase-1 statement budget, see calendar note above).
        const rows = db.listEvents(cid, { statuses: ["archived"], limit: 100 });
        const content = views.withReq(req, () =>
          views.renderArchive({
            cid,
            rows,
            zone: settings.time_zone || "UTC",
            csrfToken: req.csrfToken || null,
          }),
        );
        await shell(req, res, { title: "Event archive", heading: "Archive", content });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/g/:guildId/events/presets",
    requireTier("staff"),
    async (req, res, next) => {
      try {
        const cid = req.guildAccess.communityId;
        const presets = db.listEventPresets(cid); // options attached by repo
        const content = views.withReq(req, () =>
          views.renderPresets({ cid, presets, csrfToken: req.csrfToken || null }),
        );
        await shell(req, res, {
          title: "Signup presets",
          heading: "Signup presets",
          content,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/g/:guildId/events/series",
    requireTier("staff"),
    async (req, res, next) => {
      try {
        const cid = req.guildAccess.communityId;
        const settings = db.getEventGuildSettings(cid);
        const rows = db.listEventSeries(cid).map((s) => ({
          ...s,
          weekdays: safeJson(s.weekdays),
        }));
        const content = views.withReq(req, () =>
          views.renderSeries({
            cid,
            series: rows,
            zone: settings.time_zone || "UTC",
            csrfToken: req.csrfToken || null,
          }),
        );
        await shell(req, res, { title: "Series", heading: "Recurring series", content });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/g/:guildId/events/scheduled",
    requireTier("staff"),
    async (req, res, next) => {
      try {
        const cid = req.guildAccess.communityId;
        const settings = db.getEventGuildSettings(cid);
        const rows = db
          .listEvents(cid, { statuses: DRAFT_STATUSES, limit: 100 })
          .filter(isQueuedPost)
          .sort(
            (a, b) =>
              Number(a.post_at ?? a.start_at) - Number(b.post_at ?? b.start_at),
          );
        const content = views.withReq(req, () =>
          views.renderScheduled({
            cid,
            rows,
            zone: settings.time_zone || "UTC",
            csrfToken: req.csrfToken || null,
          }),
        );
        await shell(req, res, {
          title: "Scheduled posts",
          heading: "Scheduled posts",
          content,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get(
    "/g/:guildId/events/:eventId",
    requireTier("staff"),
    async (req, res, next) => {
      try {
        const ev = loadEvent(req, res);
        if (!ev) return;
        const cid = req.guildAccess.communityId;
        const settings = db.getEventGuildSettings(cid);
        const zone = settings.time_zone || "UTC";
        const { guild } = await actor(req);
        const options = db.listEventOptions(ev.id);
        // ≤100 name list (phase-1 statement budget); the ATTENDING totals
        // come from countEventSignups (aggregate, exact).
        const signups = db.listEventSignups(ev.id, { limit: 100 });
        const signupsByOption = new Map();
        const waitlist = new Map();
        for (const s of signups) {
          if (s.state === "signed_up") {
            if (!signupsByOption.has(s.option_id)) signupsByOption.set(s.option_id, []);
            signupsByOption.get(s.option_id).push(s.user_id);
          } else if (s.state === "waitlisted") {
            if (!waitlist.has(s.option_id)) waitlist.set(s.option_id, []);
            waitlist.get(s.option_id).push(s);
          }
        }
        const counts = db.countEventSignups(ev.id);
        const totals = Object.values(counts).reduce(
          (acc, c) => ({
            attending: acc.attending + c.signedUp,
            waiting: acc.waiting + c.waitlisted,
          }),
          { attending: 0, waiting: 0 },
        );
        const manage = await canManage(req, ev);
        const content = views.withReq(req, () =>
          views.renderEventDetail({
            cid,
            ev,
            settings,
            zone,
            options,
            signupsByOption,
            waitlist,
            counts: totals,
            reminders: db.listEventReminders(ev.id),
            activity: db.listEventActivity(ev.id, 40),
            // messageLink wants the EXTERNAL snowflake — repo rows carry the
            // integer community id, so enrich like every slash-command caller.
            messageLinkUrl: ev.message_id
              ? service.messageLink({ ...ev, guild_external_id: req.guildAccess.guildId })
              : null,
            canManage: manage,
            csrfToken: req.csrfToken || null,
          }),
        );
        await shell(req, res, {
          title: ev.title.slice(0, 60),
          heading: "Event",
          content,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST: create ──────────────────────────────────────────────────────────

  app.post("/g/:guildId/events", requireTier("staff"), async (req, res, next) => {
    try {
      const cid = req.guildAccess.communityId;
      const settings = db.getEventGuildSettings(cid);
      const title = String(req.body?.title || "").trim().slice(0, 150);
      const startText = String(req.body?.start || "").trim();
      const channelId = String(req.body?.channel_id || "").trim() || null;
      if (!title || !startText)
        return bad(res, cid, `/g/${cid}/events`, "Title and start time are required.");
      const at = service.resolveStartAt(startText, settings);
      if (!at.ok) return bad(res, cid, `/g/${cid}/events`, at.error);
      const created = db.createEvent({
        communityId: cid,
        creatorId: req.user.userId,
        title,
        status: "draft",
        startAt: at.atMs,
        channelId,
      });
      if (!created.ok) return bad(res, cid, `/g/${cid}/events`, created.error);
      audit(req, "events.create", created.event, { via: "web", start: at.atMs });
      return ok(
        res,
        cid,
        `/g/${cid}/events/${created.event.id}`,
        "Draft saved — review, then Publish.",
      );
    } catch (err) {
      next(err);
    }
  });

  // ── POST: per-event actions (id + verb in the BODY) ───────────────────────

  const EVENT_ACTIONS = {
    publish: actPublish,
    duplicate: actDuplicate,
    edit: actEdit,
    "retry-sync": actRetrySync,
    archive: actArchive,
    unarchive: actUnarchive,
    delete: actDelete,
    "option-add": actOptionAdd,
    "option-remove": actOptionRemove,
    "signup-add": actSignupAdd,
    "signup-remove": actSignupRemove,
    "reminder-add": actReminderAdd,
    "reminder-remove": actReminderRemove,
  };

  app.post(
    "/g/:guildId/events/action",
    requireTier("staff"),
    async (req, res, next) => {
      const name = String(req.body?.action || "");
      const handler = EVENT_ACTIONS[name];
      if (!handler) {
        const cid = req.guildAccess.communityId;
        const back = eventPath(req);
        return bad(
          res,
          cid,
          back,
          `Unknown event action \`${name.slice(0, 40) || "(none)"}\`.`,
        );
      }
      try {
        const ev = loadEvent(req, res);
        if (!ev) return;
        await handler(req, res, ev);
      } catch (err) {
        next(err);
      }
    },
  );

  async function actPublish(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const { client } = await actor(req);
    if (!client)
      return bad(
        res,
        cid,
        path,
        "Discord connection unavailable — posting needs the live client; try again shortly.",
      );
    const out = await service.postEventNow(client, ev, { actorId: req.user.userId });
    audit(req, "events.publish", ev, { via: "web", ok: !!out?.ok });
    outcomeRedirect(res, cid, path, out, out?.reply || "Posted.");
  }

  async function actDuplicate(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const { client } = await actor(req);
    const out = await service.duplicateEvent(client, ev, req.user.userId);
    audit(req, "events.duplicate", ev, { via: "web" });
    if (out?.ok)
      return redirect(res, cid, `/g/${cid}/events/${out.event.id}`, "ok", "Duplicated as a draft.");
    return bad(res, cid, path, out?.error);
  }

  async function actEdit(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const settings = db.getEventGuildSettings(cid);
    const patch = {};
    const b = req.body || {};
    if (String(b.title || "").trim()) patch.title = String(b.title).trim().slice(0, 150);
    for (const key of ["description", "location", "image_url"]) {
      if (typeof b[key] === "string" && b[key].trim() !== "")
        patch[key] = b[key].trim().slice(0, key === "description" ? 1000 : 400);
    }
    if (typeof b.color === "string" && b.color.trim() !== "") {
      const parsed = ui.parseColor(b.color);
      if (!parsed.ok) return bad(res, cid, path, parsed.error);
      patch.color = parsed.color;
    }
    if (typeof b.start === "string" && b.start.trim() !== "") {
      const at = service.resolveStartAt(b.start.trim(), settings);
      if (!at.ok) return bad(res, cid, path, at.error);
      patch.start_at = at.atMs;
    }
    if (typeof b.end === "string" && b.end.trim() !== "") {
      const at = service.resolveStartAt(b.end.trim(), settings);
      if (!at.ok) return bad(res, cid, path, at.error);
      patch.end_at = at.atMs;
      if (patch.start_at != null && at.atMs <= patch.start_at)
        return bad(res, cid, path, "End time must be after the start time.");
    }
    if (b.cutoff_minutes != null && String(b.cutoff_minutes) !== "") {
      const min = Number(b.cutoff_minutes);
      if (!Number.isFinite(min)) return bad(res, cid, path, "Cutoff must be a number of minutes.");
      const startRef = patch.start_at ?? Number(ev.start_at);
      patch.cutoff_at = min < 0 ? null : startRef - Math.round(min) * 60_000;
    }
    if (typeof b.attendee_role_existing === "string" && b.attendee_role_existing !== "") {
      if (b.attendee_role_existing === "1") {
        const roleId = String(b.attendee_role_id || "").trim();
        if (!/^\d{5,20}$/.test(roleId))
          return bad(res, cid, path, "Existing attendee mode needs a numeric role id.");
        patch.attendee_role_existing = 1;
        patch.role_mode = "existing";
        patch.attendee_role_id = roleId;
      } else {
        patch.attendee_role_existing = 0;
        patch.role_mode = "temp";
        patch.attendee_role_id = null;
      }
    }
    if (!Object.keys(patch).length) return bad(res, cid, path, "Nothing to change.");

    const { client, member } = await actor(req);
    let out;
    if (member) {
      out = await service.editEvent(client, {
        member,
        communityId: cid,
        event: ev,
        patch,
        actorId: req.user.userId,
      });
    } else {
      // Degraded path (cache miss): core edit + reminder move + activity,
      // best-effort Discord refresh; "Retry Discord sync" re-runs refresh.
      const upd = db.updateEvent(ev.id, patch);
      if (!upd.ok) return bad(res, cid, path, upd.error);
      if (patch.start_at != null && Number(patch.start_at) !== Number(ev.start_at)) {
        db.rescheduleUnsentEventReminders(ev.id, Number(patch.start_at));
      }
      db.logEventActivity({
        eventId: ev.id,
        actorId: req.user.userId,
        action: "edited",
        detail: `${Object.keys(patch).join(",")} (web, member not cached)`,
      });
      const refresh = await service.refreshEventMessages(client, db.getEventById(ev.id));
      out = {
        ok: true,
        warnings: [
          "Discord not synced — acting member not in bot cache",
          ...(refresh?.warnings || []),
        ],
      };
    }
    audit(req, "events.edit", ev, { via: "web", fields: Object.keys(patch) });
    outcomeRedirect(res, cid, path, out, "Saved.");
  }

  async function actRetrySync(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const { client } = await actor(req);
    if (!client) return bad(res, cid, path, "Discord connection unavailable.");
    const fresh = db.getEventById(ev.id);
    const refresh = await service.refreshEventMessages(client, fresh);
    audit(req, "events.retry_sync", ev, { via: "web" });
    const warns = (refresh?.warnings || []).filter(Boolean);
    redirect(
      res,
      cid,
      path,
      warns.length ? "err" : "ok",
      warns.length ? warns.join("; ") : "Discord messages refreshed.",
    );
  }

  async function actArchive(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const { client } = await actor(req);
    const out = await service.archiveEvent(client, ev, { reason: "web-archive" });
    audit(req, "events.archive", ev, { via: "web" });
    outcomeRedirect(res, cid, path, out, "Archived.");
  }

  async function actUnarchive(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    if (ev.status !== "archived") return bad(res, cid, path, "Not archived.");
    const out = db.updateEvent(ev.id, { status: ev.message_id ? "posted" : "draft" });
    if (!out.ok) return bad(res, cid, path, out.error);
    db.logEventActivity({
      eventId: ev.id,
      actorId: req.user.userId,
      action: "unarchived",
      detail: "web",
    });
    audit(req, "events.unarchive", ev, { via: "web" });
    ok(res, cid, path, "Unarchived.");
  }

  async function actDelete(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (String(req.body?.confirm || "").trim() !== "DELETE")
      return bad(res, cid, path, "Type DELETE to permanently delete.");
    if (!(await canManage(req, ev, "delete")))
      return bad(res, cid, path, "You don't hold event-delete rights here.");
    const { client } = await actor(req);
    const out = await service.deleteEvent(client, ev, {
      actorId: req.user.userId,
      removeDiscord: Boolean(client) && Boolean(ev.message_id),
    });
    audit(req, "events.delete", ev, { via: "web" });
    if (out?.ok) return ok(res, cid, `/g/${cid}/events`, `Deleted "${ev.title}".`);
    return bad(res, cid, path, out?.error);
  }

  async function actOptionAdd(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const label = String(req.body?.label || "").trim().slice(0, 50);
    if (!label) return bad(res, cid, path, "Option label required.");
    const capacity = Math.max(0, Number(req.body?.capacity) || 0);
    const out = db.createEventOption(ev.id, {
      label,
      capacity,
      waitlist_on: req.body?.waitlist ? 1 : 0,
      reminders_on: db.listEventOptions(ev.id).length === 0 ? 1 : 0,
    });
    if (!out.ok) return bad(res, cid, path, out.error || "Option rejected.");
    db.logEventActivity({
      eventId: ev.id,
      actorId: req.user.userId,
      action: "option_added",
      detail: label,
    });
    audit(req, "events.option_add", ev, { via: "web", label });
    const { client } = await actor(req);
    await service.refreshEventMessages(client, ev);
    ok(res, cid, path, `Option "${label}" added.`);
  }

  async function actOptionRemove(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const opt = db.getEventOptionById(Number(req.body?.option_id));
    if (!opt || opt.event_id !== ev.id)
      return bad(res, cid, path, "That option is not part of this event.");
    db.deleteEventOption(opt.id);
    db.logEventActivity({
      eventId: ev.id,
      actorId: req.user.userId,
      action: "option_removed",
      detail: opt.label,
    });
    audit(req, "events.option_remove", ev, { via: "web", label: opt.label });
    const { client } = await actor(req);
    await service.refreshEventMessages(client, ev);
    ok(res, cid, path, `Option "${opt.label}" removed.`);
  }

  async function actSignupAdd(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const userId = String(req.body?.user_id || "").trim();
    const optionId = Number(req.body?.option_id);
    if (!/^\d{5,20}$/.test(userId)) return bad(res, cid, path, "User id required.");
    const { client, guild } = await actor(req);
    if (!guild)
      return bad(
        res,
        cid,
        path,
        "Discord guild not resolvable from the bot cache — try again shortly.",
      );
    const out = await service.organizerAdd(client, {
      guild,
      event: ev,
      userId,
      optionId,
      actorId: req.user.userId,
    });
    audit(req, "events.signup_add", ev, { via: "web", userId, optionId });
    outcomeRedirect(res, cid, path, out, "Signup added.");
  }

  async function actSignupRemove(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const userId = String(req.body?.user_id || "").trim();
    const optionId = Number(req.body?.option_id);
    if (!/^\d{5,20}$/.test(userId)) return bad(res, cid, path, "User id required.");
    const { client, guild } = await actor(req);
    if (!guild)
      return bad(
        res,
        cid,
        path,
        "Discord guild not resolvable from the bot cache — try again shortly.",
      );
    const out = await service.organizerRemove(client, {
      guild,
      event: ev,
      userId,
      optionId,
      actorId: req.user.userId,
    });
    audit(req, "events.signup_remove", ev, { via: "web", userId, optionId });
    outcomeRedirect(res, cid, path, out, "Signup removed.");
  }

  async function actReminderAdd(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const minutes = Number(req.body?.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 20160)
      return bad(res, cid, path, "Minutes must be between 1 and 20160.");
    const roleId = String(req.body?.role_id || "").trim() || null;
    const body = String(req.body?.body || "").trim() || null;
    const out = db.createEventReminders(ev.id, [
      {
        offsetMinutes: minutes,
        fireAt: Number(ev.start_at) - Math.round(minutes) * 60_000,
        message: body,
        target: roleId ? "role" : "attendees",
        roleId,
      },
    ]);
    if (out?.ok)
      db.logEventActivity({
        eventId: ev.id,
        actorId: req.user.userId,
        action: "reminder_added",
        detail: `${minutes} min before start`,
      });
    audit(req, "events.reminder_add", ev, { via: "web", minutes });
    outcomeRedirect(res, cid, path, out, `Reminder armed for ${minutes} min before start.`);
  }

  async function actReminderRemove(req, res, ev) {
    const cid = req.guildAccess.communityId;
    const path = `/g/${cid}/events/${ev.id}`;
    if (!(await canManage(req, ev)))
      return bad(res, cid, path, "You don't hold event-edit rights here.");
    const row = db.getEventReminderById(Number(req.body?.reminder_id));
    if (!row || row.event_id !== ev.id)
      return bad(res, cid, path, "That reminder isn't on this event.");
    db.deleteEventReminder(row.id);
    db.logEventActivity({
      eventId: ev.id,
      actorId: req.user.userId,
      action: "reminder_removed",
      detail: `#${row.id} (${row.offset_minutes} min)`,
    });
    audit(req, "events.reminder_remove", ev, { via: "web", reminderId: row.id });
    ok(res, cid, path, "Reminder removed.");
  }

  // ── POST: series + presets (ids in the BODY) ──────────────────────────────

  app.post(
    "/g/:guildId/events/series",
    requireTier("staff"),
    async (req, res, next) => {
      const cid = req.guildAccess.communityId;
      const path = `/g/${cid}/events/series`;
      const action = String(req.body?.action || "");
      try {
        if (action !== "skip" && action !== "stop")
          return bad(res, cid, path, `Unknown series action \`${action.slice(0, 40)}\`.`);
        const s = db.getEventSeriesForCommunity(Number(req.body?.series_id), cid);
        if (!s) return bad(res, cid, path, "No such series.");
        const template = db.getEventById(s.template_event_id);
        if (!template) return bad(res, cid, path, "Series template event is gone.");
        if (!(await canManage(req, template)))
          return bad(res, cid, path, "You don't hold event-edit rights here.");
        // Same semantics as `/eventconfig series skip <event>`: skip targets the
        // NEXT unposted occurrence sitting at the cursor, not the template.
        let target = template;
        if (action === "skip" && s.next_occurrence_at != null) {
          const open = db.listEvents(cid, {
            statuses: DRAFT_STATUSES,
            seriesId: s.id,
            limit: 50,
          });
          const atCursor = open
            .filter(
              (ev) =>
                Number(ev.start_at) >= Number(s.next_occurrence_at) - 86_400_000 &&
                Number(ev.start_at) <= Number(s.next_occurrence_at) + 86_400_000,
            )
            .sort((a, b) => Number(a.start_at) - Number(b.start_at))[0];
          if (atCursor) target = atCursor;
        }
        const out =
          action === "skip"
            ? series.skipOccurrence(target)
            : series.stopSeries(target, req.user.userId);
        audit(req, `events.series_${action}`, target, { via: "web", seriesId: s.id });
        if (out?.ok)
          return ok(res, cid, path, action === "skip" ? "Next occurrence skipped." : "Series stopped.");
        return bad(res, cid, path, out?.error);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/g/:guildId/events/presets",
    requireTier("staff"),
    async (req, res, next) => {
      const cid = req.guildAccess.communityId;
      const path = `/g/${cid}/events/presets`;
      try {
        const name = String(req.body?.name || "").trim().slice(0, 60);
        const spec = ui.parseSignupOptionSpec(req.body?.spec || "");
        if (!name) return bad(res, cid, path, "Preset name required.");
        if (!spec.ok) return bad(res, cid, path, spec.error);
        const out = db.createEventPreset(cid, name, spec.options, req.user.userId);
        if (!out.ok) return bad(res, cid, path, out.error);
        audit(req, "events.preset_save", out.preset, { via: "web", name: out.preset?.name ?? name });
        ok(res, cid, path, `Preset "${name}" saved.`);
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    "/g/:guildId/events/presets/delete",
    requireTier("staff"),
    async (req, res, next) => {
      const cid = req.guildAccess.communityId;
      const path = `/g/${cid}/events/presets`;
      try {
        const p = db.getEventPreset(Number(req.body?.preset_id));
        // Order matters (#649): a missing/foreign preset fails the OWNERSHIP
        // check first (same "No such preset here." redirect, nothing
        // deleted); only an OWNED preset then requires the typed DELETE —
        // the same comparison (and the same idiom) permanent event delete
        // already uses. The confirm value is a POST body field, never a
        // query parameter.
        if (!p || p.community_id !== cid) return bad(res, cid, path, "No such preset here.");
        if (String(req.body?.confirm || "").trim() !== "DELETE")
          return bad(res, cid, path, "Type DELETE to permanently delete.");
        db.deleteEventPreset(p.id);
        audit(req, "events.preset_delete", p, { via: "web", name: p.name });
        ok(res, cid, path, `Preset "${p.name}" deleted.`);
      } catch (err) {
        next(err);
      }
    },
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────

function eventPath(req) {
  const id = Number(req.body?.event_id);
  const cid = req.guildAccess.communityId;
  return Number.isInteger(id) && id > 0
    ? `/g/${cid}/events/${id}`
    : `/g/${cid}/events`;
}

function redirect(res, cid, path, kind, message) {
  const q = message
    ? `?${kind}=${encodeURIComponent(String(message).slice(0, 240))}`
    : "";
  // Bodyless 302 PRG — the §8.8 mutation contract (settings.js
  // redirectSettings posture): no express redirect body, no-store.
  res.writeHead(302, {
    Location: `${path}${q}`,
    "Cache-Control": "no-store",
  });
  res.end();
}

const ok = (res, cid, path, msg) => redirect(res, cid, path, "ok", msg);
const bad = (res, cid, path, msg) =>
  redirect(res, cid, path, "err", msg || "Action failed.");

/**
 * Surface a `{ok:false,error}` service result per the error doctrine: the
 * SPECIFIC reason reaches the user (escaped in the flash), never a generic
 * "something failed". Partial successes carry their warnings along.
 */
function outcomeRedirect(res, cid, path, out, okMsg) {
  if (out && out.ok) {
    const warns = Array.isArray(out.warnings) ? out.warnings.filter(Boolean) : [];
    const msg = warns.length
      ? `${okMsg || "Done."} (${warns.join("; ").slice(0, 160)})`
      : okMsg || "Done.";
    return redirect(res, cid, path, "ok", msg);
  }
  return redirect(res, cid, path, "err", out?.error || "Rejected by the service layer.");
}

/** Staff mutations mirror into admin_audit (same posture as settings.js). */
function audit(req, action, ev, details = {}) {
  req.audit({
    action,
    targetType: "event",
    targetId: String(ev?.id ?? "none"),
    guildId: req.guildAccess.guildId,
    details,
  });
}

function clampInt(raw, lo, hi, dflt) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < lo || n > hi) return dflt;
  return n;
}

function safeJson(value) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

module.exports = { registerEventsCalendarRoutes };
