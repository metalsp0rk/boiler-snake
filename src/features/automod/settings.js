/**
 * Auto-moderation settings service (#725, epic #723).
 *
 * Single validation/write seam for the `/automodconfig` arms and (later)
 * the referral gate. Contract (AGENTS.md § Error Handling 6): every
 * function returns `{ ok: true, ... }` or `{ ok: false, error }` with a
 * SPECIFIC, actionable message — it never throws and never replies to
 * Discord itself; handlers decide how to surface the error.
 *
 * Storage truth lives in migration 067 + `src/db/repositories/automodSettings.js`;
 * this service adds the user-facing validation layer (reject-out-of-range
 * with the offending value named — never silently clamp a typed number).
 */

const {
  getGuildSettings,
  updateGuildSettings,
  getAutomodBudget,
  setAutomodPause,
  clearAutomodPause,
  isAutomodPaused,
} = require("../../db");
const {
  AUTOMOD_ACTIONS,
  AUTOMOD_MODES,
  AUTOMOD_RULES_MAX_LEN,
  AUTOMOD_TIMEOUT_CAP_MIN,
  AUTOMOD_TIMEOUT_CAP_MAX,
  AUTOMOD_BUDGET_MIN,
  AUTOMOD_BUDGET_MAX,
  automodModeColumn,
  normalizeAutomodMode,
} = require("./constants");

/** 28 days rendered the way staff think about it (cap error copy). */
const CAP_MAX_HOURS = AUTOMOD_TIMEOUT_CAP_MAX / 3600;

/**
 * Wrap any unexpected repository/db failure into a specific, actionable
 * service error, logged with the community id so the row is reproducible
 * from logs alone (AGENTS.md error rule 2 — the service never replies to
 * Discord itself, this line is the only full-context trace of the failure).
 */
function fail(what, communityId, err) {
  console.error(
    `[automod] ${what} failed (community ${communityId}):`,
    err?.message || err,
  );
  return {
    ok: false,
    error: `Could not save the auto-mod setting (${what}): ${err?.message || "database error"}`,
  };
}

/**
 * Normalized settings view for `/automod status` and the referral gate.
 * Never throws — a missing settings row materializes through the
 * repository's ensure-on-read.
 *
 * @param {number} communityId
 * @param {number} [nowMs] injectable UTC clock for the budget view
 * @returns {{ ok: true, settings: object } | { ok: false, error: string }}
 */
function readSettings(communityId, nowMs) {
  try {
    const s = getGuildSettings(communityId);
    const budget = getAutomodBudget(communityId, nowMs);
    const pause = isAutomodPaused(communityId);
    const modes = {};
    for (const action of AUTOMOD_ACTIONS) {
      modes[action] = s[`automod_mode_${action}`] ?? "suggest";
    }
    const rules = typeof s.automod_rules === "string" ? s.automod_rules.trim() : "";
    return {
      ok: true,
      settings: {
        enabled: Number(s.automod_enabled) === 1,
        channelId: s.automod_channel_id || null,
        rules,
        rulesChars: rules.length,
        modes,
        timeoutCap: Number(s.automod_timeout_cap) || 3600,
        dailyCaseLimit: budget.limit,
        casesUsed: budget.used,
        casesRemaining: budget.remaining,
        paused: pause.paused,
        pausedAt: pause.pausedAt,
        pauseReason: pause.reason,
      },
    };
  } catch (err) {
    return fail("settings read", communityId, err);
  }
}

/**
 * Set the automod (case-card) channel id. Validated as a non-empty id
 * string — channel existence/permissions are checked by the handler's
 * Discord-side overwrites read, not here.
 */
function setChannel(communityId, channelId) {
  const id = channelId == null ? "" : String(channelId).trim();
  if (!id) {
    return { ok: false, error: "No channel provided — pick a text channel for the case cards." };
  }
  try {
    updateGuildSettings(communityId, { automod_channel_id: id });
    return { ok: true, channelId: id };
  } catch (err) {
    return fail("channel set", communityId, err);
  }
}

/**
 * Clear the channel. ALLOWED while enabled (epic #723): referrals then
 * refuse naming the missing piece — this issue never blocks config hygiene.
 */
function clearChannel(communityId) {
  try {
    updateGuildSettings(communityId, { automod_channel_id: null });
    return { ok: true };
  } catch (err) {
    return fail("channel clear", communityId, err);
  }
}

/**
 * Set the guild rules text (required to run a case). Trimmed; the 4000-char
 * cap is REJECTED with the offending length — never silently truncated.
 */
function setRules(communityId, text) {
  const rules = text == null ? "" : String(text).trim();
  if (!rules) {
    return {
      ok: false,
      error: "Rules text is required — a case cannot run without the guild rules to judge against. Type the text or omit the option to open the modal.",
    };
  }
  if (rules.length > AUTOMOD_RULES_MAX_LEN) {
    return {
      ok: false,
      error: `Rules text is ${rules.length} characters — the cap is ${AUTOMOD_RULES_MAX_LEN}. Shorten it (keep the rules a judge can apply).`,
    };
  }
  try {
    updateGuildSettings(communityId, { automod_rules: rules });
    return { ok: true, rules, rulesChars: rules.length };
  } catch (err) {
    return fail("rules set", communityId, err);
  }
}

/** Clear the rules text (allowed while enabled — see clearChannel). */
function clearRules(communityId) {
  try {
    updateGuildSettings(communityId, { automod_rules: null });
    return { ok: true };
  } catch (err) {
    return fail("rules clear", communityId, err);
  }
}

/** Master switch. Default off; referral replies name this cause while off. */
function setEnabled(communityId, on) {
  if (typeof on !== "boolean") {
    return { ok: false, error: "Choose `on` or `off` for the auto-mod master switch." };
  }
  try {
    updateGuildSettings(communityId, { automod_enabled: on ? 1 : 0 });
    return { ok: true, enabled: on };
  } catch (err) {
    return fail("enable toggle", communityId, err);
  }
}

/** Per-action mode (off | suggest | auto). Staff notes deliberately have no mode. */
function setMode(communityId, action, mode) {
  const act = String(action ?? "").trim().toLowerCase();
  const column = automodModeColumn(act);
  if (!column) {
    return {
      ok: false,
      error: `Unknown action \`${action}\` — choose one of: ${AUTOMOD_ACTIONS.join(", ")}. (Staff notes are always on and have no mode.)`,
    };
  }
  const normalized = normalizeAutomodMode(mode);
  if (!normalized) {
    return {
      ok: false,
      error: `Unknown mode \`${mode}\` — choose one of: ${AUTOMOD_MODES.join(", ")}.`,
    };
  }
  try {
    updateGuildSettings(communityId, { [column]: normalized });
    return { ok: true, action: act, mode: normalized };
  } catch (err) {
    return fail("mode set", communityId, err);
  }
}

/**
 * Timeout cap in seconds. Out-of-range is REJECTED with the offending value
 * (60 s floor, 28-day Discord ceiling) — a clamped timeout would silently
 * shorten what staff believe they authorized.
 */
function setTimeoutCap(communityId, seconds) {
  const n = Number(seconds);
  if (!Number.isInteger(n) || n < AUTOMOD_TIMEOUT_CAP_MIN || n > AUTOMOD_TIMEOUT_CAP_MAX) {
    return {
      ok: false,
      error:
        `Timeout cap must be a whole number of seconds between ${AUTOMOD_TIMEOUT_CAP_MIN} (1 minute) and ${AUTOMOD_TIMEOUT_CAP_MAX} (${CAP_MAX_HOURS} hours = 28 days, Discord's timeout maximum)` +
        (seconds != null && String(seconds).trim() !== "" ? ` — got \`${seconds}\`.` : "."),
    };
  }
  try {
    updateGuildSettings(communityId, { automod_timeout_cap: n });
    return { ok: true, timeoutCap: n };
  } catch (err) {
    return fail("timeout cap set", communityId, err);
  }
}

/**
 * Daily case budget (tri-state, SEPARATE from gork_daily_limit):
 * -1 blocked, 0 unlimited, 1..100000 cases per community per UTC day.
 */
function setDailyBudget(communityId, limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < AUTOMOD_BUDGET_MIN || n > AUTOMOD_BUDGET_MAX) {
    return {
      ok: false,
      error:
        `Daily case budget must be a whole number: \`${AUTOMOD_BUDGET_MIN}\` blocks all cases, \`0\` is unlimited, \`1-${AUTOMOD_BUDGET_MAX}\` caps cases per UTC day` +
        (limit != null && String(limit).trim() !== "" ? ` — got \`${limit}\`.` : "."),
    };
  }
  try {
    updateGuildSettings(communityId, { automod_daily_case_limit: n });
    return { ok: true, dailyCaseLimit: n };
  } catch (err) {
    return fail("budget set", communityId, err);
  }
}

/**
 * Clear the persisted circuit-breaker pause. The CONFIRM gate (H2-15) lives
 * in the handler — this is the mutation only. Returns the pre-clear pause
 * state so the caller can report what was re-armed.
 */
function resumeSafety(communityId) {
  try {
    const before = isAutomodPaused(communityId);
    if (!before.paused) {
      return { ok: false, error: "Auto-mod safety is not paused — nothing to resume." };
    }
    clearAutomodPause(communityId);
    return { ok: true, wasPausedAt: before.pausedAt, wasReason: before.reason };
  } catch (err) {
    return fail("safety resume", communityId, err);
  }
}

// Re-exported for the breaker issue (#739) and tests: the trip write.
module.exports = {
  readSettings,
  setChannel,
  clearChannel,
  setRules,
  clearRules,
  setEnabled,
  setMode,
  setTimeoutCap,
  setDailyBudget,
  resumeSafety,
  setAutomodPause,
};
