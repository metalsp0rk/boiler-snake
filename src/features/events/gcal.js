/**
 * Google Calendar integration for community events (epic #218, phase 5).
 *
 * Two surfaces, both opt-in per user:
 *  • `/eventconfig google connect` → standard OAuth (auth code + offline refresh),
 *    callback on the public web server at GET /oauth/gcal/callback; tokens
 *    are envelope-encrypted at rest (TOKEN_ENCRYPTION_KEY, audit C6 rule:
 *    refuse the grant when the key can't store it).
 *  • `📅 My calendar` button on a posted event adds it to the clicker's
 *    connected calendar; a guild can also designate one calendar as the
 *    community calendar (`/eventconfig google autoset`) that every posted event
 *    auto-syncs into.
 *
 * No googleSDK dependency — plain fetch against the REST endpoints.
 */
const repo = require("../../db/repositories/events");
const {
  encryptToken,
  decryptToken,
  hasTokenKey,
  keyMissingError,
  needsTokenReencrypt,
} = require("../../core/thirdPartyTokens");
const { createOAuthState, verifyOAuthState, PURPOSES } = require("../commandPermissions/oauthState");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];
const OAUTH_PATH = "/oauth/gcal/callback";
const REFRESH_SKEW_MS = 5 * 60_000;

/** {GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_BASE_URL} */
function getConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID || null;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || null;
  const base = process.env.GOOGLE_REDIRECT_URI
    || (process.env.PUBLIC_BASE_URL
      ? `${String(process.env.PUBLIC_BASE_URL).replace(/\/$/, "")}${OAUTH_PATH}`
      : null);
  const missing = [];
  if (!clientId) missing.push("GOOGLE_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
  if (!base) missing.push("GOOGLE_REDIRECT_URI or PUBLIC_BASE_URL");
  return { ready: missing.length === 0, missing, clientId, clientSecret, redirectUri: base };
}

/** `/eventconfig google connect` → authorize URL for the user's DM/reply. */
function startConnect(communityId, userId) {
  const cfg = getConfig();
  if (!cfg.ready) {
    return { ok: false, error: `Google Calendar isn't configured — missing ${cfg.missing.join(", ")}.` };
  }
  if (!hasTokenKey()) {
    return {
      ok: false,
      error: keyMissingError("Google tokens").message
        || `TOKEN_ENCRYPTION_KEY is not configured — I can't store Google tokens safely.`,
    };
  }
  let state;
  try {
    const external = require("../../platform/community").getCommunityById(communityId);
    state = createOAuthState({
      purpose: PURPOSES.GCAL,
      guildId: String(external?.externalGuildId || ""),
      userId: String(userId),
    });
  } catch (err) {
    return { ok: false, error: `Could not start the connect flow: ${err?.message || err}` };
  }
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return { ok: true, url: url.toString() };
}

async function postTokenForm(form) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error_description || json?.error || `token endpoint HTTP ${res.status}`);
  }
  return json;
}

/** GET /oauth/gcal/callback handler (web server route). */
async function handleCallback(req, res, params) {
  const cfg = getConfig();
  const send = (code, title, body) => {
    res.status(code).type("html").send(
      `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui;background:#313338;color:#dbdee1;display:flex;` +
      `min-height:100vh;align-items:center;justify-content:center;margin:0">` +
      `<div style="background:#2b2d31;border-radius:8px;padding:2rem;max-width:26rem">` +
      `<h1 style="font-size:1.2rem;margin:0 0 .5rem">${title}</h1><p>${body}</p></div></body>`
    );
  };
  const state = params.get("state");
  const code = params.get("code");
  const errText = params.get("error");
  if (errText) return send(400, "Google connect failed", `Google reported: <code>${escapeHtml(errText)}</code>`);
  if (!state || !code) return send(400, "Incomplete request", "Missing <code>state</code> or <code>code</code>.");
  let payload;
  try {
    payload = verifyOAuthState(state);
  } catch (err) {
    return send(400, "Connect link expired", `Open it again from Discord (<code>${escapeHtml(err?.message || "invalid state")}</code>).`);
  }
  if (payload.purpose !== PURPOSES.GCAL) {
    return send(400, "Wrong flow", "This link was not a calendar connect.");
  }
  const guildId = String(payload.guildId || "");
  const userId = String(payload.userId);
  if (!guildId || !userId) return send(400, "Incomplete state", "The connect link lost its guild/user binding.");
  const communityId = require("../../platform/community").ensureCommunity({
    platform: "discord",
    instanceKey: "discord",
    externalGuildId: guildId,
  });
  try {
    const tokens = await postTokenForm({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    });
    if (!hasTokenKey()) throw new Error("TOKEN_ENCRYPTION_KEY vanished mid-flow — refusing to store tokens");
    const expiry = tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 - REFRESH_SKEW_MS : null;
    const email = await fetchPrimaryEmail(tokens.access_token);
    const upsert = repo.upsertEventGoogleLink({
      communityId,
      userId,
      email: email || null,
      accessTokenEnc: encryptToken(String(tokens.access_token)),
      refreshTokenEnc: tokens.refresh_token ? encryptToken(String(tokens.refresh_token)) : null,
      expiry,
    });
    if (upsert && upsert.ok === false) throw new Error(upsert.error);
    send(200, "Calendar connected ✅", "Back to Discord — you can now tap <b>📅 My calendar</b> on any event.");
  } catch (err) {
    console.error(`[events] gcal callback guild=${communityId} user=${userId}:`, err?.message || err);
    send(500, "Calendar connect failed", `Could not complete the connect: <code>${escapeHtml(err?.message || err)}</code>`);
  }
}

// #452: shared core escaper (this file used to keep its own map-form copy).
const { escapeHtml } = require("../../core/escapeHtml");

async function fetchPrimaryEmail(accessToken) {
  try {
    const res = await fetch(`${API_BASE}/users/me/calendarList/primary`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => ({}));
    return json?.id === "primary" ? (json?.email || null) : (json?.id || null);
  } catch {
    return null;
  }
}

/**
 * #281 lazy convergence: once stored envelopes decrypt, re-seal them with
 * the CURRENT TOKEN_ENCRYPTION_KEY so rows migrate forward after a key
 * rotation. Best-effort — a failed re-seal never breaks calendar work.
 */
function resealStaleLinkSecrets(
  communityId,
  link,
  { accessTokenPlain, refreshTokenPlain } = {}
) {
  const patch = {};
  if (
    link.access_token_enc &&
    accessTokenPlain != null &&
    needsTokenReencrypt(link.access_token_enc)
  ) {
    patch.accessTokenEnc = encryptToken(accessTokenPlain);
  }
  if (
    link.refresh_token_enc &&
    refreshTokenPlain != null &&
    needsTokenReencrypt(link.refresh_token_enc)
  ) {
    patch.refreshTokenEnc = encryptToken(refreshTokenPlain);
  }
  if (!patch.accessTokenEnc && !patch.refreshTokenEnc) return;
  try {
    repo.resealEventGoogleLinkSecrets(communityId, link.user_id, patch);
  } catch (err) {
    console.error(
      `[events] gcal link re-seal failed (community ${communityId} ` +
        `user ${link.user_id}) (#281): ${err?.message || err}`,
    );
  }
}

/** Fresh access token (refresh once when near expiry). Returns null+error. */
async function freshToken(communityId, userId) {
  const link = repo.getEventGoogleLink(communityId, userId);
  if (!link || link.enabled !== 1) return { ok: false, error: "No connected Google Calendar (use /eventconfig google connect)." };
  const needsRefresh = link.expiry == null || Date.now() >= Number(link.expiry);
  if (!needsRefresh) {
    try {
      const accessTokenPlain = decryptToken(link.access_token_enc);
      // #281: converge both envelopes forward while their plaintexts are
      // reachable (a refresh column the current key-set cannot open is
      // left alone — decrypt would throw, not corrupt).
      let refreshTokenPlain = null;
      if (link.refresh_token_enc && needsTokenReencrypt(link.refresh_token_enc)) {
        try {
          refreshTokenPlain = decryptToken(link.refresh_token_enc);
        } catch {
          /* leave it; the access path works without it */
        }
      }
      resealStaleLinkSecrets(communityId, link, { accessTokenPlain, refreshTokenPlain });
      return { ok: true, token: accessTokenPlain, link };
    } catch (err) {
      return { ok: false, error: `Stored token unreadable (key change?): ${err?.message || err}` };
    }
  }
  if (!link.refresh_token_enc) {
    return { ok: false, error: "The saved grant has no refresh token — connect again." };
  }
  const cfg = getConfig();
  if (!cfg.ready) return { ok: false, error: "Google OAuth is no longer configured server-side." };
  try {
    const refreshPlain = decryptToken(link.refresh_token_enc);
    const tokens = await postTokenForm({
      refresh_token: refreshPlain,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
    });
    const expiry = tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 - REFRESH_SKEW_MS : null;
    repo.updateEventGoogleLinkTokens(communityId, userId, {
      accessTokenEnc: encryptToken(String(tokens.access_token)),
      expiry,
    });
    // #281: the access column converged above (fresh v2 seal); the refresh
    // column converges here with the rotated-or-existing plaintext.
    resealStaleLinkSecrets(communityId, link, {
      refreshTokenPlain: tokens.refresh_token || refreshPlain,
    });
    return { ok: true, token: String(tokens.access_token), link };
  } catch (err) {
    return { ok: false, error: `Token refresh failed (reconnect needed): ${err?.message || err}` };
  }
}

/** Add one event to a user's Google calendar. */
async function addToCalendar(client, communityId, userId, event) {
  const tokenRes = await freshToken(communityId, userId);
  if (!tokenRes.ok) return { ok: false, error: tokenRes.error };
  const link = tokenRes.link;
  const startIso = new Date(Number(event.start_at)).toISOString();
  const endIso = new Date(Number(event.end_at) || Number(event.start_at) + 3_600_000).toISOString();
  const linkUrl = require("./service").messageLink(event);
  const body = {
    summary: event.title,
    location: event.location || (event.channel_id ? `Discord <#${event.channel_id}>` : undefined),
    description: [event.description, linkUrl ? `Event message: ${linkUrl}` : null]
      .filter(Boolean)
      .join("\n\n") || undefined,
    start: { dateTime: startIso, timeZone: "UTC" },
    end: { dateTime: endIso, timeZone: "UTC" },
  };
  try {
    const res = await fetch(
      `${API_BASE}/calendars/${encodeURIComponent(link.calendar_id || "primary")}/events?sendUpdates=none`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenRes.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: `Google rejected the event: ${json?.error?.message || `HTTP ${res.status}`}` };
    }
    return { ok: true, htmlLink: json?.htmlLink || null };
  } catch (err) {
    return { ok: false, error: `Google API unreachable: ${err?.message || err}` };
  }
}

/** Post hook: community-calendar auto-sync (guild opt-in). */
async function autoSyncOnPost(client, event) {
  const settings = repo.getEventGuildSettings(event.community_id);
  if (!settings.google_auto_enabled || !settings.google_auto_user_id) return { warnings: [], synced: 0 };
  const res = await addToCalendar(client, event.community_id, String(settings.google_auto_user_id), event);
  if (res.ok) return { warnings: [], synced: 1 };
  console.error(`[events] gcal autosync event=${event.id}: ${res.error}`);
  return { warnings: [`calendar auto-sync: ${res.error}`], synced: 0 };
}

function status(communityId, userId) {
  const link = repo.getEventGoogleLink(communityId, userId);
  if (!link) return { connected: false };
  return {
    connected: link.enabled === 1,
    email: link.email,
    calendarId: link.calendar_id,
    since: link.created_at,
  };
}

function disconnect(communityId, userId) {
  repo.deleteEventGoogleLink(communityId, userId);
  return { ok: true };
}

/**
 * `/eventconfig google autoset [--member] [--off]` — community-calendar toggle.
 * member omitted = the caller.
 */
function autoset(communityId, callerId, { memberId = null, off = false } = {}) {
  const target = off ? null : String(memberId || callerId);
  if (!off) {
    // #349: this persisted UNCONDITIONALLY — pointing auto-sync at a member
    // with no connected link made `settings show` advertise an impossible
    // promise and made EVERY later post carry a calendar warning the poster
    // never asked for and only staff could fix. The toggle now requires the
    // target to actually hold an enabled link (later disconnects were
    // always handled gracefully by autoSyncOnPost; the gap was only here).
    const st = status(communityId, target);
    if (!st.connected) {
      return {
        ok: false,
        error: `<@${target}> has no connected calendar — they must run \`/eventconfig google connect\` first.`,
      };
    }
  }
  const settings = repo.updateEventGuildSettings(communityId, {
    google_auto_user_id: target,
    google_auto_enabled: off ? 0 : 1,
  });
  return { ok: true, settings };
}

module.exports = {
  OAUTH_PATH,
  getConfig,
  startConnect,
  handleCallback,
  freshToken,
  addToCalendar,
  autoSyncOnPost,
  status,
  disconnect,
  autoset,
};
