/**
 * Apply staff_roles allow-list overwrites to staff-tier slash commands.
 */

const { REST, Routes } = require("discord.js");
const {
  listStaffRoles,
  setCommandPermissionSyncResult,
  hasCommandPermissionOauth,
} = require("../../db");
const { staffSyncCommandNames } = require("../../core/commandVisibility");
const { buildStaffRoleAllowPermissions } = require("./permissionsPayload");
const { getValidAccessToken } = require("./oauthTokens");

const API_BASE = "https://discord.com/api/v10";

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} url
 * @param {object} opts
 * @param {string} [opts.method]
 * @param {Record<string, string>} [opts.headers]
 * @param {string} [opts.body]
 * @param {number} [opts._retries]
 */
async function fetchWithRetry(url, opts = {}) {
  const retries = opts._retries ?? 0;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: opts.headers,
    body: opts.body,
  });

  if (res.status === 429 && retries < 5) {
    const json = await res.json().catch(() => ({}));
    const retryAfter =
      Number(json.retry_after) ||
      Number(res.headers.get("retry-after")) ||
      1;
    await sleep(Math.ceil(retryAfter * 1000) + 50);
    return fetchWithRetry(url, { ...opts, _retries: retries + 1 });
  }

  return res;
}

/**
 * Fetch guild command name → id map using the bot token.
 * @param {string} guildId
 * @returns {Promise<Map<string, string>>}
 */
async function fetchGuildCommandIdMap(guildId) {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  if (!token || !clientId) {
    throw new Error("DISCORD_TOKEN and CLIENT_ID required to list guild commands");
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const commands = await rest.get(
    Routes.applicationGuildCommands(clientId, guildId)
  );
  const map = new Map();
  for (const cmd of commands || []) {
    if (cmd?.name && cmd?.id) map.set(cmd.name, cmd.id);
  }
  return map;
}

/**
 * PUT permissions for one command.
 * @param {object} opts
 * @param {string} opts.applicationId
 * @param {string} opts.guildId
 * @param {string} opts.commandId
 * @param {string} opts.accessToken
 * @param {object[]} opts.permissions
 */
async function putCommandPermissions(opts) {
  const url = `${API_BASE}/applications/${opts.applicationId}/guilds/${opts.guildId}/commands/${opts.commandId}/permissions`;
  const res = await fetchWithRetry(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ permissions: opts.permissions }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.message || j.error || text;
    } catch {
      /* keep text */
    }
    const err = new Error(
      `PUT permissions failed (${res.status}): ${detail}`
    );
    err.status = res.status;
    throw err;
  }
}

/**
 * Sync staff-tier command overwrites for a guild.
 * @param {string} guildId
 * @param {object} [opts]
 * @param {string} [opts.accessToken] skip token load when just exchanged
 * @returns {Promise<{
 *   updated: string[],
 *   failed: { name: string, error: string }[],
 *   missingCommands: string[],
 *   roleCount: number,
 * }>}
 */
async function applyGuildCommandPermissions(guildId, opts = {}) {
  const applicationId = process.env.CLIENT_ID;
  if (!applicationId) throw new Error("CLIENT_ID required");

  let accessToken = opts.accessToken;
  if (!accessToken) {
    accessToken = await getValidAccessToken(guildId);
  }

  const roleIds = listStaffRoles(guildId).map((r) => r.role_id);
  const permissions = buildStaffRoleAllowPermissions(roleIds);
  const idMap = await fetchGuildCommandIdMap(guildId);
  const targets = staffSyncCommandNames();

  const updated = [];
  const failed = [];
  const missingCommands = [];

  for (const name of targets) {
    const commandId = idMap.get(name);
    if (!commandId) {
      missingCommands.push(name);
      continue;
    }
    try {
      await putCommandPermissions({
        applicationId,
        guildId,
        commandId,
        accessToken,
        permissions,
      });
      updated.push(name);
      // mild pacing to avoid burst 429s
      await sleep(150);
    } catch (err) {
      failed.push({
        name,
        error: err?.message || String(err),
      });
      if (err.status === 401 || err.status === 403) {
        // abort remaining — token / permission problem
        break;
      }
    }
  }

  const errorSummary =
    failed.length > 0
      ? failed.map((f) => `${f.name}: ${f.error}`).join("; ").slice(0, 500)
      : null;

  if (hasCommandPermissionOauth(guildId)) {
    setCommandPermissionSyncResult(guildId, {
      lastSyncAt: Date.now(),
      lastSyncError: errorSummary,
    });
  }

  return {
    updated,
    failed,
    missingCommands,
    roleCount: roleIds.length,
  };
}

/**
 * Best-effort re-sync after staff role changes (never throws to caller path).
 * @param {string} guildId
 * @returns {Promise<void>}
 */
async function maybeAutoSyncCommandPermissions(guildId) {
  if (!hasCommandPermissionOauth(guildId)) return;
  try {
    const result = await applyGuildCommandPermissions(guildId);
    if (result.failed.length) {
      console.warn(
        `[commandPermissions] auto-sync partial failure for ${guildId}:`,
        result.failed.map((f) => f.name).join(", ")
      );
    } else {
      console.log(
        `[commandPermissions] auto-synced ${result.updated.length} commands for ${guildId} (${result.roleCount} staff roles)`
      );
    }
  } catch (err) {
    console.warn(
      `[commandPermissions] auto-sync failed for ${guildId}:`,
      err?.message || err
    );
  }
}

module.exports = {
  fetchGuildCommandIdMap,
  putCommandPermissions,
  applyGuildCommandPermissions,
  maybeAutoSyncCommandPermissions,
};
