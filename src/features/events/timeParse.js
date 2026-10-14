/**
 * Time and duration parsing for /event (E3).
 *
 * Everything stores UTC instants; naive user input is interpreted in the
 * guild's configured IANA time zone (event_guild_settings.time_zone) so a
 * "7pm" entry means 7pm WHERE THE GUILD LIVES, and the confirmation shows a
 * Discord <t:…:F> stamp that localizes in each viewer's client.
 *
 * Accepted start-time shapes:
 *   in <n><m|h|d>          "in 90m", "in 2h", "in 3d", "in 2 hours"
 *   <ISO date>[T<time>[Z|±hh:mm]]   "2026-11-05T19:00Z", "2026-11-05 19:00"
 *   <time> [today|tomorrow] "19:00", "7pm", "tomorrow 7:30pm"
 *   <Month D> [time] [year]  "Nov 5 19:00", "November 5th, 7pm 2026", "5 Nov 19:00"
 *   explicit "… UTC" suffix overrides the guild zone
 *
 * Durations: "90" (minutes), "45m", "1h30m", "2 hours", "1.5h".
 */

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

const MAX_YEARS_OUT = 2;

/**
 * Offset (ms) of `tz` at instant `atMs`: localWallClock - utc.
 * Implemented with Intl.formatToParts (no external tz library).
 */
function tzOffsetMs(atMs, tz = "UTC") {
  if (!tz || tz === "UTC") return 0;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(atMs));
  } catch {
    return null; // unknown zone — caller reports it
  }
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

/** Wall-clock (yyyy-mm-dd hh:mm) of instant `atMs` in `tz`. */
function wallClockParts(atMs, tz) {
  const shifted = atMs + tzOffsetMs(atMs, tz);
  if (shifted == null) return null;
  const d = new Date(shifted);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

/** Interpret wall-clock fields in `tz` as a UTC ms instant (two-pass for DST). */
function wallToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, 0);
  const off1 = tzOffsetMs(guess, tz);
  if (off1 == null) return null;
  let at = guess - off1;
  // one refinement pass handles a DST boundary between guess and result
  const off2 = tzOffsetMs(at, tz);
  if (off2 == null) return null;
  if (off2 !== off1) at = guess - off2;
  return at;
}

/** "7pm", "19:00", "7:30 pm", "19.30" → {h, mi} | null */
function parseClock(text) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase().replace(/\s+/g, " ");
  let m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (m) {
    let h = Number(m[1]);
    const mi = Number(m[2]);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (h > 23 || mi > 59) return null;
    return { h, mi };
  }
  m = t.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[2] === "pm") h += 12;
    return { h, mi: 0 };
  }
  m = t.match(/^(\d{1,2})$/);
  if (m) {
    const h = Number(m[1]);
    return h <= 23 ? { h, mi: 0 } : null;
  }
  return null;
}

/**
 * Parse a start-time string.
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.timeZone="UTC"] IANA zone for naive times
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {{ ok: true, atMs: number, note?: string }|{ ok: false, error: string }}
 */
function parseEventTime(text, { timeZone = "UTC", nowMs = Date.now() } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, error: "A start time is required (e.g. `in 2h` or `Nov 5 19:00`)." };
  let tz = String(timeZone || "UTC");
  let body = raw;

  // explicit UTC override
  const utcSuffix = body.match(/\s*\(\s*utc\s*\)$/i) || body.match(/\s+utc$/i);
  if (utcSuffix) {
    tz = "UTC";
    body = body.slice(0, utcSuffix.index).trim();
  }
  // offset like " 19:00 +02:00" handled only for ISO-with-Z below; naive offsets unsupported.

  if (tz !== "UTC" && tzOffsetMs(nowMs, tz) == null) {
    return {
      ok: false,
      error: `Unknown time zone \`${tz}\` in guild settings (staff can fix it with \`/eventconfig settings timezone\`).`,
    };
  }

  // "in 2h30m" / "in 90m" / "in 3 days"
  let m = body.match(/^in\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|days?)$/i);
  if (m) {
    const unit = m[2][0].toLowerCase();
    const n = Number(m[1]);
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    if (!(n > 0) || !Number.isFinite(ms)) return { ok: false, error: `Could not understand \`${raw}\`.` };
    return { ok: true, atMs: nowMs + Math.round(ms) };
  }
  // bare relative without "in": "2h from now"
  m = body.match(/^(\d+(?:\.\d+)?)\s*(m|h|d)\b\s*(from now)?$/i);
  if (m) {
    return parseEventTime(`in ${m[1]}${m[2].toLowerCase()}`, { timeZone: tz, nowMs });
  }

  // ISO-ish with zone designator or full date-time
  m = body.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (m) {
    const [, y, mo, d, h, mi, , zone] = m;
    if (zone) {
      const iso = `${y}-${mo}-${d}T${h || "00"}:${mi || "00"}:00${zone === "Z" ? "Z" : zone.replace(/(\+\d{2})(\d{2})/, "$1:$2")}`;
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) return { ok: false, error: `Could not understand \`${raw}\`.` };
      return { ok: true, atMs: at };
    }
    const at = wallToUtc(
      Number(y), Number(mo) - 1, Number(d),
      h == null ? 0 : Number(h), mi == null ? 0 : Number(mi), tz,
    );
    if (at == null) return { ok: false, error: `Could not understand \`${raw}\`.` };
    return rollForward(at, nowMs, raw);
  }

  // "tomorrow 7pm" / "today 19:00"
  m = body.match(/^(today|tomorrow|tmrw|tmr)?\s*(.+)$/i);
  if (m) {
    const dayWord = (m[1] || "").toLowerCase();
    const rest = m[2].trim();

    // "Month D" forms first
    const monthRe =
      /^(?:(\d{1,2})\s+)?([a-z]{3,9})\.?\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\s*(.*)$/i;
    const mm = rest.match(monthRe);
    const clockOnly = parseClock(rest);
    if (!clockOnly && mm && !Number.isNaN(monthIndex(mm[2]))) {
      const dayOfMonth = Number(mm[3]);
      const year = mm[4] ? Number(mm[4]) : null;
      const clock = parseClock(mm[5]) || { h: 0, mi: 0 };
      if (dayOfMonth < 1 || dayOfMonth > 31) return { ok: false, error: `Day of month out of range in \`${raw}\`.` };
      const nowW = wallClockParts(nowMs, tz);
      let y = year ?? nowW.y;
      let at = wallToUtc(y, monthIndex(mm[2]), dayOfMonth, clock.h, clock.mi, tz);
      if (at == null) return { ok: false, error: `Could not understand \`${raw}\`.` };
      if (year == null) {
        if (at < nowMs - 60_000) {
          at = wallToUtc(y + 1, monthIndex(mm[2]), dayOfMonth, clock.h, clock.mi, tz);
          if (at == null) return { ok: false, error: `Could not understand \`${raw}\`.` };
        }
        if (at > nowMs + MAX_YEARS_OUT * 365 * 86_400_000)
          return { ok: false, error: `\`${raw}\` is too far in the future.` };
      }
      return { ok: true, atMs: at };
    }

    // weekday forms: "friday 7pm", "next fri 19:00"
    const wd = rest.match(
      /^(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\s*(.*)$/i,
    );
    if (wd) {
      const dow = weekdayIndex(wd[1]);
      const clock = parseClock(wd[2]) || { h: 0, mi: 0 };
      if (dow == null) return { ok: false, error: `Could not understand \`${raw}\`.` };
      const nowW = wallClockParts(nowMs, tz);
      let add = (dow - nowW.dow + 7) % 7;
      const baseUtc = wallToUtc(nowW.y, nowW.mo, nowW.d + add, clock.h, clock.mi, tz);
      let at = baseUtc;
      if (at == null) return { ok: false, error: `Could not understand \`${raw}\`.` };
      if (at <= nowMs + 60_000) {
        at = wallToUtc(nowW.y, nowW.mo, nowW.d + add + 7, clock.h, clock.mi, tz);
      }
      return { ok: true, atMs: at, note: "next occurrence" };
    }

    const clock = parseClock(rest);
    if (clock) {
      const nowW = wallClockParts(nowMs, tz);
      const dayShift = dayWord === "tomorrow" || dayWord === "tmrw" || dayWord === "tmr" ? 1 : 0;
      let at = wallToUtc(nowW.y, nowW.mo, nowW.d + dayShift, clock.h, clock.mi, tz);
      if (at == null) return { ok: false, error: `Could not understand \`${raw}\`.` };
      if (dayWord === "today" && at <= nowMs) {
        return {
          ok: false,
          error: `\`${raw}\` has already passed today — try \`tomorrow\` or a future time.`,
        };
      }
      if (!dayWord && at <= nowMs + 60_000) {
        at = wallToUtc(nowW.y, nowW.mo, nowW.d + 1, clock.h, clock.mi, tz); // roll to tomorrow
      }
      return { ok: true, atMs: at };
    }
  }

  return {
    ok: false,
    error:
      `Could not understand \`${raw}\`. Try \`in 2h\`, \`in 90m\`, \`tomorrow 7pm\`, ` +
      `\`Fri 19:00\`, \`Nov 5 19:00\`, or \`2026-11-05T19:00Z\`.`,
  };
}

/** Bare times/dates must never land in the past silently; past dates error. */
function rollForward(at, nowMs, raw) {
  if (at < nowMs - 10 * 60_000) {
    return { ok: false, error: `\`${raw}\` is in the past — add a year or use a future time.` };
  }
  if (at > nowMs + MAX_YEARS_OUT * 365 * 86_400_000) {
    return { ok: false, error: `\`${raw}\` is too far in the future.` };
  }
  return { ok: true, atMs: at };
}

function monthIndex(name) {
  const key = String(name).slice(0, 3).toLowerCase();
  const i = MONTHS.indexOf(key);
  return i === -1 ? NaN : i; // NaN so callers' Number.isNaN guard rejects
}

function weekdayIndex(name) {
  const table = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  };
  const v = table[String(name).toLowerCase()];
  return v === undefined ? null : v;
}

/**
 * Parse a duration into minutes.
 * @param {string|number|null|undefined} text
 * @returns {{ ok: true, minutes: number }|{ ok: false, error: string }}
 */
function parseDuration(text) {
  if (text == null || String(text).trim() === "") return { ok: true, minutes: null };
  if (typeof text === "number" && Number.isFinite(text) && text > 0) {
    return { ok: true, minutes: Math.round(text) };
  }
  const t = String(text).trim().toLowerCase().replace(/\s+/g, "");
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Math.round(Number(t));
    if (n <= 0) return { ok: false, error: "Duration must be positive." };
    return { ok: true, minutes: n };
  }
  const m = t.match(/^(?:(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?)?(?:(\d+)\s*m(?:ins?|utes?)?)?$/);
  if (m && (m[1] != null || m[2] != null)) {
    const minutes = Math.round(Number(m[1] || 0) * 60 + Number(m[2] || 0));
    if (minutes <= 0) return { ok: false, error: "Duration must be positive." };
    return { ok: true, minutes };
  }
  return {
    ok: false,
    error: `Could not understand duration \`${text}\`. Try \`90\`, \`1h30m\`, or \`2 hours\`.`,
  };
}

/**
 * Parse a signup cutoff phrase (phase 2). Returns OFFSET MINUTES relative to
 * start (negative = before start). "at start" → 0, "30m before" → -30,
 * "1h after" → +60.
 */
function parseCutoff(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return { ok: true, offsetMinutes: null };
  if (/^(at\s+)?(the\s+)?start(\s+time)?$/.test(t)) return { ok: true, offsetMinutes: 0 };
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(m|h|d)\s*(before|after|prior|earlier|later)$/);
  if (m) {
    const unit = m[2];
    const n = Number(m[1]) * (unit === "m" ? 1 : unit === "h" ? 60 : 1440);
    const sign = m[3] === "after" || m[3] === "later" ? 1 : -1;
    return { ok: true, offsetMinutes: sign * Math.round(n) };
  }
  if (/^(no cutoff|open|never|anytime)$/.test(t)) return { ok: true, offsetMinutes: null };
  return {
    ok: false,
    error: `Could not understand cutoff \`${text}\`. Try \`at start\`, \`30m before\`, or \`1h after\`.`,
  };
}

module.exports = {
  parseEventTime,
  parseDuration,
  parseCutoff,
  tzOffsetMs,
  wallClockParts,
  wallToUtc,
  parseClock,
};
