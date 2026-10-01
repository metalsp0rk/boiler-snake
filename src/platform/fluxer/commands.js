/**
 * Fluxer prefix-command parser (roadmap/fluxer.md § Prefix grammar, lines 433–506).
 *
 * The algorithm 1–7 in that section is the contract; this file implements it
 * verbatim:
 *
 *  1. Trim leading whitespace; literal, case-sensitive prefix check (default `!`).
 *  2. Strip the prefix. Empty remainder is not a command.
 *  3. Tokenize on ASCII whitespace; a double-quoted span is one token;
 *     a backslash inside quotes escapes the next character.
 *  4. Token 0 is the command name, matched case-insensitively. `help` is the
 *     synthetic Fluxer command (step 4b consumes up to two bare tokens).
 *  5. Subcommand groups / subcommands are bare tokens, not name/value pairs.
 *  6. Remaining tokens are `name value` pairs typed against the registry's
 *     SlashCommandBuilder JSON plus the Fluxer-only overlay (userinfo
 *     view/window/page; note add/edit content REQUIRED).
 *  7. User/role/channel values resolve through the structured mentions arrays
 *     (K10). The parser NEVER scans content for `<@id>` markup.
 *
 * Sync, SDK-free, discord.js-free: registry JSON is plain data, loaded lazily
 * from src/commands/registry.js only when a caller does not pass its own
 * `registryCommands`.
 *
 * Returned ParsedCommand (bundle contract 2, plus the documented `mentionIndex`
 * / `allowedChannelTypes` extras dispatch consumes):
 *   {
 *     commandName, subcommandGroup, subcommand,
 *     options: [{ name, type, value, mentionIndex, allowedChannelTypes }],
 *     help: null | { tokens: string[] },
 *     usageError: null | { reason, commandName, group, sub },
 *   }
 */

/** discord.js OptionType numbers (spec: the command tree IS the builder JSON). */
const OPTION_TYPE = Object.freeze({
  SUB_COMMAND: 1,
  SUB_COMMAND_GROUP: 2,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  CHANNEL: 7,
  ROLE: 8,
  MENTIONABLE: 9,
  NUMBER: 10,
  ATTACHMENT: 11,
});

/** Human labels for option types, used by the help renderer. */
const TYPE_LABELS = Object.freeze({
  [OPTION_TYPE.STRING]: "string",
  [OPTION_TYPE.INTEGER]: "integer",
  [OPTION_TYPE.BOOLEAN]: "boolean",
  [OPTION_TYPE.USER]: "user",
  [OPTION_TYPE.CHANNEL]: "channel",
  [OPTION_TYPE.ROLE]: "role",
  [OPTION_TYPE.MENTIONABLE]: "mentionable",
  [OPTION_TYPE.NUMBER]: "number",
});

/** Commands whose whole surface is Discord-only (spec § Help, line 503). */
const DISCORD_ONLY_COMMANDS = Object.freeze({
  eventreminder: "Discord only (scheduled events)",
  play: "Discord only (voice playback)",
  music: "Discord only (music player)",
});

/** Subcommand-level Discord-only notes (spec: `ticket panel` is Discord-only). */
const DISCORD_ONLY_SUBCOMMANDS = Object.freeze({
  ticket: { panel: "Discord only (ticket channel panels)" },
});

/** K10 copy (spec § Mentions, line 482) — verbatim, the parser never decodes markup. */
const K10_USER_COPY =
  "Pass a user id. This bot does not read mention markup in the command text.";
const K10_ROLE_COPY =
  "Pass a role id. This bot does not read mention markup in the command text.";
const K10_CHANNEL_COPY =
  "Pass a channel id. This bot does not read mention markup in the command text.";

/** A token that looks like Discord mention markup: <@id>, <@!id>, <@&id>, <#id>. */
const MARKUP_RE = /^<[@#][!&]?\d{1,25}>$/;
/** Bare decimal id: 5–20 digits (spec line 479 — `42` is not a user id). */
const BARE_ID_RE = /^\d{5,20}$/;
/** Integer token (spec line 464). */
const INT_RE = /^-?\d+$/;
/** Number token: finite decimal float, optional exponent. */
const NUMBER_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Fluxer-only overlay (spec table, lines 441–445). Never touches the Discord
 * slash JSON — `npm run register` uploads what the builders define.
 */
const FLUXER_OVERLAYS = Object.freeze({
  userinfo: {
    options: [
      {
        name: "view",
        type: OPTION_TYPE.STRING,
        required: false,
        description: "View to show (default overview)",
        choices: [
          { name: "overview", value: "overview" },
          { name: "notes", value: "notes" },
          { name: "warnings", value: "warnings" },
          { name: "activity-channels", value: "activity-channels" },
          { name: "activity-categories", value: "activity-categories" },
        ],
      },
      {
        name: "window",
        type: OPTION_TYPE.STRING,
        required: false,
        description: "Activity window (default a = all time)",
        choices: [
          { name: "a", value: "a" },
          { name: "7", value: "7" },
          { name: "30", value: "30" },
          { name: "90", value: "90" },
        ],
      },
      {
        name: "page",
        type: OPTION_TYPE.INTEGER,
        required: false,
        min_value: 1,
        description: "Page number (default 1)",
      },
    ],
    subcommands: {},
  },
  note: {
    options: [],
    // Slash JSON marks content optional (Discord opens a modal); Fluxer has no
    // modal surface, so the overlay makes it required and the parser rejects a
    // missing content before the handler (spec line 445).
    subcommands: { add: { requireOption: "content" }, edit: { requireOption: "content" } },
  },
});

/**
 * Default prefix resolution. `getFluxerCommandPrefix` lands with the PR 6
 * config module (Agent A). Wrapped so a partial checkout — config mid-edit,
 * no env — still parses with the spec default `!` (K1).
 * @returns {string}
 */
function defaultPrefix() {
  try {
    const config = require("../config");
    if (typeof config.getFluxerCommandPrefix === "function") {
      return config.getFluxerCommandPrefix();
    }
  } catch {
    // config unavailable: K1 default below.
  }
  return "!";
}

/**
 * Validate an explicit opts.prefix the same rules § Prefix grammar step 1
 * pins for FLUXER_COMMAND_PREFIX: 1–8 chars, no whitespace, no `<`/`>`.
 * @param {unknown} prefix
 * @returns {string}
 */
function assertPrefix(prefix) {
  if (typeof prefix !== "string" || prefix.length < 1 || prefix.length > 8) {
    throw new Error(
      `Command prefix must be a string of 1-8 characters, got ${JSON.stringify(prefix)}`,
    );
  }
  if (/[\s<>]/.test(prefix)) {
    throw new Error(
      `Command prefix must contain no whitespace and no < or > characters, got ${JSON.stringify(prefix)}`,
    );
  }
  return prefix;
}

/**
 * Step 3 tokenizer. ASCII whitespace separates tokens; a double-quoted span is
 * ONE token (a quoted empty string is an empty token, preserved). `\\` inside
 * quotes escapes the next character. Returns the token list and whether any
 * quote was left unclosed.
 *
 * @param {string} input text after the prefix
 * @returns {{ tokens: Array<{ value: string, quoted: boolean }>, unclosed: boolean }}
 */
function tokenize(input) {
  const tokens = [];
  let unclosed = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\v" || ch === "\f") {
      i += 1;
      continue;
    }
    let value = "";
    let sawQuote = false;
    let closedAll = true;
    while (i < input.length && !/[\s]/.test(input[i])) {
      const c = input[i];
      if (c === '"') {
        sawQuote = true;
        i += 1;
        let closed = false;
        while (i < input.length) {
          if (input[i] === "\\" && i + 1 < input.length) {
            value += input[i + 1];
            i += 2;
            continue;
          }
          if (input[i] === '"') {
            i += 1;
            closed = true;
            break;
          }
          value += input[i];
          i += 1;
        }
        if (!closed) {
          closedAll = false;
          break;
        }
        continue;
      }
      value += c;
      i += 1;
    }
    if (sawQuote || value !== "") tokens.push({ value, quoted: sawQuote });
    if (!closedAll) {
      unclosed = true;
      break;
    }
  }
  return { tokens, unclosed };
}

/**
 * Clone a command JSON option array so overlay edits never mutate the
 * registry's own objects.
 * @param {Array<object>} options
 * @returns {Array<object>}
 */
function cloneOptions(options) {
  return (options ?? []).map((opt) => ({
    ...opt,
    choices: Array.isArray(opt.choices) ? opt.choices.map((c) => ({ ...c })) : undefined,
  }));
}

/**
 * Build the lookup tree for one parse. Registry JSON nests groups→subcommands→
 * options, subcommands→options, and flat options (spec line 437). The Fluxer
 * overlay is merged here, never into the registry.
 *
 * @param {Array<object>} registryCommands
 * @returns {Map<string, {name: string, description: string, options: Array<object>, subcommands: Map<string, object>, groups: Map<string, object>}>}
 */
function buildFluxerCommandTree(registryCommands) {
  const tree = new Map();
  for (const cmd of registryCommands ?? []) {
    if (!cmd || typeof cmd.name !== "string" || !cmd.name) continue;
    const entry = {
      name: cmd.name,
      description: cmd.description ?? "",
      options: [],
      subcommands: new Map(),
      groups: new Map(),
    };
    for (const opt of cmd.options ?? []) {
      const name = String(opt?.name ?? "").toLowerCase();
      if (!name) continue;
      if (opt.type === OPTION_TYPE.SUB_COMMAND_GROUP) {
        const subs = new Map();
        for (const sub of opt.options ?? []) {
          const subName = String(sub?.name ?? "").toLowerCase();
          if (!subName) continue;
          subs.set(subName, {
            name: sub.name,
            description: sub.description ?? "",
            options: cloneOptions(sub.options),
          });
        }
        entry.groups.set(name, {
          name: opt.name,
          description: opt.description ?? "",
          subcommands: subs,
        });
      } else if (opt.type === OPTION_TYPE.SUB_COMMAND) {
        entry.subcommands.set(name, {
          name: opt.name,
          description: opt.description ?? "",
          options: cloneOptions(opt.options),
        });
      } else {
        // Flat option: clone the option itself (choices array cloned too).
        // cloneOptions is for option ARRAYS (subcommand option lists).
        entry.options.push({
          ...opt,
          choices: Array.isArray(opt.choices) ? opt.choices.map((c) => ({ ...c })) : opt.choices,
        });
      }
    }
    tree.set(String(cmd.name).toLowerCase(), entry);
  }
  applyFluxerOverlays(tree);
  return tree;
}

/**
 * Merge the Fluxer-only overlay (spec § Prefix grammar table) into a tree.
 * @param {Map<string, object>} tree
 */
function applyFluxerOverlays(tree) {
  for (const [name, overlay] of Object.entries(FLUXER_OVERLAYS)) {
    const entry = tree.get(name);
    if (!entry) continue;
    for (const opt of overlay.options ?? []) {
      const lower = opt.name.toLowerCase();
      if (!entry.options.some((o) => o.name.toLowerCase() === lower)) {
        entry.options.push({ ...opt });
      }
    }
    for (const [subName, rule] of Object.entries(overlay.subcommands ?? {})) {
      const sub = entry.subcommands.get(subName);
      if (!sub) continue;
      const opt = sub.options.find(
        (o) => o.name.toLowerCase() === String(rule.requireOption).toLowerCase(),
      );
      if (opt) opt.required = true;
      else {
        sub.options.push({
          name: rule.requireOption,
          type: OPTION_TYPE.STRING,
          required: true,
          description: "Required on Fluxer (no modal surface)",
        });
      }
    }
  }
}

// Lazy default tree (registry pulls in every feature module; tests pass their
// own commands to keep the parser pure).
let _defaultTree = null;

/**
 * @returns {Map<string, object>}
 */
function defaultTree() {
  if (!_defaultTree) {
    const { buildDefaultRegistry } = require("../commands/registry");
    _defaultTree = buildFluxerCommandTree(buildDefaultRegistry().commands);
  }
  return _defaultTree;
}

/**
 * Look up the option set (name→def) a parse lands on, from raw tokens.
 * Returns null when token 0 matches no command.
 *
 * @param {Map<string, object>} tree
 * @param {string} commandName lowercased token 0
 * @returns {object|null}
 */
function lookupCommand(tree, commandName) {
  return tree.get(String(commandName).toLowerCase()) ?? null;
}

/**
 * `!help` token rules (step 4b): at most two bare tokens; a third is kept only
 * in the group form (`!help honeypot channel add`). A third token outside that
 * shape collapses to the token-1 help line (spec: "not a name/value usage
 * error. The reply is the help line for token 1").
 *
 * @param {string[]} args lowercased bare tokens after `help`
 * @param {Map<string, object>} tree
 * @returns {string[]}
 */
function helpTokens(args, tree) {
  const tokens = [];
  const t1 = args[0];
  if (t1 == null) return tokens;
  tokens.push(t1);
  const t2 = args[1];
  if (t2 == null) return tokens;
  const t3 = args[2];
  if (t3 == null) {
    tokens.push(t2);
    return tokens;
  }
  const entry = lookupCommand(tree, t1);
  const groupForm =
    Boolean(entry) && entry.groups.size > 0 && entry.groups.has(t2);
  if (groupForm) {
    tokens.push(t2, t3);
    return tokens;
  }
  // Third token present, shape not met: help for token 1 only.
  return tokens;
}

/**
 * Build a usage-error result with the matched coordinates so dispatch can
 * render the help block for the right scope.
 * @param {string} reason
 * @param {string} commandName
 * @param {string|null} group
 * @param {string|null} sub
 * @returns {object}
 */
function usage(reason, commandName, group = null, sub = null) {
  return {
    reason,
    commandName,
    group: group ? group.name : null,
    sub: sub ? sub.name : null,
  };
}

/**
 * Format one option for the help lines: `name <type>` required /
 * `name [type]` optional (spec § Help, line 504: "warn add — user <user>,
 * reason <string>, silent [boolean]"), plus min/max, length bounds, choices,
 * and channel types when set.
 *
 * @param {object} opt option JSON
 * @returns {string}
 */
function formatOption(opt) {
  const label = TYPE_LABELS[opt.type] ?? `type ${opt.type}`;
  const marker = opt.required ? `<${label}>` : `[${label}]`;
  const extras = [];
  if (opt.min_value != null && opt.max_value != null) extras.push(`${opt.min_value}-${opt.max_value}`);
  else if (opt.min_value != null) extras.push(`min ${opt.min_value}`);
  else if (opt.max_value != null) extras.push(`max ${opt.max_value}`);
  if (opt.min_length != null && opt.max_length != null) extras.push(`${opt.min_length}-${opt.max_length} chars`);
  else if (opt.min_length != null) extras.push(`min ${opt.min_length} chars`);
  else if (opt.max_length != null) extras.push(`max ${opt.max_length} chars`);
  if (Array.isArray(opt.choices) && opt.choices.length) {
    extras.push(`one of: ${opt.choices.map((c) => c.value).join("|")}`);
  }
  if (Array.isArray(opt.channel_types) && opt.channel_types.length) {
    extras.push(`types ${opt.channel_types.join("/")}`);
  }
  const core = `${opt.name} ${marker}`;
  return extras.length ? `${core} (${extras.join("; ")})` : core;
}

/**
 * Render the help block for a command (dispatch step 7 / spec § Help).
 * `sub` may be a subcommand name, a subcommand-group name, both
 * (`!help honeypot channel add`), and `tokens` carries the raw help args so
 * unknown topics get `No command warnx.`.
 *
 * @param {Array<object>} registryCommands registry JSON (overlay applied here)
 * @param {string} commandName token 1 of `!help ...` (may be unknown)
 * @param {string[]} helpTokensArr parser help tokens (lowercased)
 * @returns {string} plain-text help reply
 */
function formatCommandHelp(registryCommands, commandName, helpTokensArr = []) {
  const tree = buildFluxerCommandTree(registryCommands);
  return formatCommandHelpFromTree(tree, commandName, helpTokensArr);
}

/**
 * @param {Map<string, object>} tree
 * @param {string} commandName
 * @param {string[]} helpTokensArr
 * @returns {string}
 */
function formatCommandHelpFromTree(tree, commandName, helpTokensArr = []) {
  const name = String(commandName ?? "").toLowerCase();
  const entry = tree.get(name);
  if (!entry) return `No command ${commandName}.`;

  const onlyNote = DISCORD_ONLY_COMMANDS[name];
  if (onlyNote) return `${entry.name} — ${onlyNote}`;

  const lines = [];
  const subArg = helpTokensArr[1] != null ? String(helpTokensArr[1]).toLowerCase() : null;
  const thirdArg = helpTokensArr[2] != null ? String(helpTokensArr[2]).toLowerCase() : null;

  const renderOptions = (label, description, options) => {
    const optText = (options ?? [])
      .filter((o) => o.name && TYPE_LABELS[o.type])
      .map(formatOption)
      .join(", ");
    // `label` ends with the subcommand or group NAME ("warn add", "ticket panel").
    // Discord-only notes exist at both levels (ticket's `panel` is a GROUP).
    const lastToken = label.split(" ").pop()?.toLowerCase?.() ?? "";
    const note = DISCORD_ONLY_SUBCOMMANDS[name]?.[lastToken];
    const suffix = note ? ` — ${note}` : "";
    return [
      optText ? `${label} — ${optText}${suffix}` : `${label} — ${description || "No options."}${suffix}`,
    ];
  };

  const hasStructure = entry.subcommands.size > 0 || entry.groups.size > 0;

  if (!subArg) {
    lines.push(`${entry.name} — ${entry.description}`);
    if (entry.options.length) lines.push(...renderOptions(entry.name, entry.description, entry.options));
    for (const [key, sub] of entry.subcommands) {
      lines.push(...renderOptions(`${entry.name} ${sub.name}`, sub.description, sub.options));
    }
    for (const [, group] of entry.groups) {
      lines.push(`${entry.name} ${group.name} — ${group.description}`);
      for (const [key, sub] of group.subcommands) {
        lines.push(...renderOptions(`${entry.name} ${group.name} ${sub.name}`, sub.description, sub.options));
      }
    }
    return lines.join("\n");
  }

  // Second token: subcommand, group, or an unknown help topic.
  if (entry.groups.size > 0 && entry.groups.has(subArg)) {
    const group = entry.groups.get(subArg);
    if (thirdArg != null && group.subcommands.has(thirdArg)) {
      const sub = group.subcommands.get(thirdArg);
      lines.push(...renderOptions(`${entry.name} ${group.name} ${sub.name}`, sub.description, sub.options));
      return lines.join("\n");
    }
    lines.push(`${entry.name} ${group.name} — ${group.description}`);
    for (const [key, sub] of group.subcommands) {
      lines.push(...renderOptions(`${entry.name} ${group.name} ${sub.name}`, sub.description, sub.options));
    }
    return lines.join("\n");
  }
  if (entry.subcommands.has(subArg)) {
    const sub = entry.subcommands.get(subArg);
    lines.push(...renderOptions(`${entry.name} ${sub.name}`, sub.description, sub.options));
    return lines.join("\n");
  }
  // Unknown second token: the help LINE for token 1 (spec step 4b).
  if (!hasStructure) {
    lines.push(`${entry.name} — ${entry.description}`);
    if (entry.options.length) lines.push(...renderOptions(entry.name, entry.description, entry.options));
    return lines.join("\n");
  }
  return `Unknown help topic: ${subArg}. See: ${[
    ...entry.subcommands.keys(),
    ...entry.groups.keys(),
  ].join(", ")}`;
}

/**
 * Render the top-level `!help` command list (spec: public commands always;
 * PR 6 has no permission mask, so every registered command is listed;
 * Discord-only commands show the Discord-only line).
 *
 * @param {Array<object>} registryCommands
 * @returns {string}
 */
function formatCommandList(registryCommands) {
  const tree = buildFluxerCommandTree(registryCommands);
  const lines = [
    "Commands (run `help <command>` for option details):",
  ];
  for (const entry of tree.values()) {
    const note = DISCORD_ONLY_COMMANDS[entry.name.toLowerCase()];
    if (note) {
      lines.push(`- ${entry.name} — ${note}`);
      continue;
    }
    lines.push(`- ${entry.name} — ${entry.description}`);
    const subNotes = DISCORD_ONLY_SUBCOMMANDS[entry.name.toLowerCase()];
    if (subNotes) {
      for (const [subName, subNote] of Object.entries(subNotes)) {
        if (
          entry.subcommands.has(subName) ||
          entry.groups.has(subName) ||
          [...entry.groups.values()].some((g) => g.subcommands.has(subName))
        ) {
          lines.push(`  ${entry.name} ${subName} — ${subNote}`);
        }
      }
    }
  }
  lines.push("- help — List commands (this message).");
  return lines.join("\n");
}

/**
 * Type-coerce one option value token (spec § Prefix grammar step 6). Returns
 * `{ ok: true, value }` (string form; dispatch coerces numbers/booleans) or
 * `{ ok: false, reason }` with the usage-error line.
 *
 * @param {object} def option definition JSON
 * @param {string} token raw token value
 * @returns {{ ok: true, value: string }|{ ok: false, reason: string }}
 */
function coerceValue(def, token) {
  const label = `Option "${def.name}"`;
  switch (def.type) {
    case OPTION_TYPE.INTEGER: {
      if (!INT_RE.test(token))
        return { ok: false, reason: `${label} must be a whole number (got "${token}").` };
      const n = Number(token);
      if (!Number.isSafeInteger(n))
        return { ok: false, reason: `${label} is outside the supported number range (got "${token}").` };
      if (def.min_value != null && n < def.min_value)
        return { ok: false, reason: `${label} must be at least ${def.min_value} (got ${n}).` };
      if (def.max_value != null && n > def.max_value)
        return { ok: false, reason: `${label} must be at most ${def.max_value} (got ${n}).` };
      return { ok: true, value: String(n) };
    }
    case OPTION_TYPE.NUMBER: {
      if (!NUMBER_RE.test(token))
        return { ok: false, reason: `${label} must be a number (got "${token}").` };
      const n = Number(token);
      if (!Number.isFinite(n))
        return { ok: false, reason: `${label} must be a finite number (got "${token}").` };
      if (def.min_value != null && n < def.min_value)
        return { ok: false, reason: `${label} must be at least ${def.min_value} (got ${n}).` };
      if (def.max_value != null && n > def.max_value)
        return { ok: false, reason: `${label} must be at most ${def.max_value} (got ${n}).` };
      return { ok: true, value: String(n) };
    }
    case OPTION_TYPE.BOOLEAN: {
      const lower = token.toLowerCase();
      if (["true", "yes", "on", "1"].includes(lower)) return { ok: true, value: "true" };
      if (["false", "no", "off", "0"].includes(lower)) return { ok: true, value: "false" };
      return {
        ok: false,
        reason: `${label} must be one of true, false, yes, no, on, off, 1, 0 (got "${token}").`,
      };
    }
    case OPTION_TYPE.STRING: {
      if (Array.isArray(def.choices) && def.choices.length) {
        const hit = def.choices.find(
          (c) =>
            String(c.value).toLowerCase() === token.toLowerCase() ||
            String(c.name).toLowerCase() === token.toLowerCase(),
        );
        if (!hit) {
          return {
            ok: false,
            reason: `${label} must be one of: ${def.choices.map((c) => c.value).join(", ")} (got "${token}").`,
          };
        }
        return { ok: true, value: String(hit.value) };
      }
      if (def.min_length != null && token.length < def.min_length) {
        return {
          ok: false,
          reason: `${label} must be at least ${def.min_length} characters (got ${token.length}).`,
        };
      }
      if (def.max_length != null && token.length > def.max_length) {
        return {
          ok: false,
          reason: `${label} must be at most ${def.max_length} characters (got ${token.length}).`,
        };
      }
      return { ok: true, value: token };
    }
    case OPTION_TYPE.USER:
    case OPTION_TYPE.ROLE:
    case OPTION_TYPE.CHANNEL:
      // Reference resolution is dispatch's job (it owns the message payload).
      // The parser only validates the SHAPE of a bare decimal id (spec 479).
      if (/^\d+$/.test(token)) {
        if (!BARE_ID_RE.test(token)) {
          const kind = typeKindLabel(def.type);
          return {
            ok: false,
            reason: `Option "${def.name}" needs a ${kind} id of 5–20 digits (got "${token}").`,
          };
        }
        return { ok: true, value: token };
      }
      // Mention reference (index) or markup token — resolved at dispatch (K10).
      return { ok: true, value: token };
    default:
      return { ok: true, value: token };
  }
}

/**
 * @param {number} type option type number
 * @returns {string}
 */
function typeKindLabel(type) {
  if (type === OPTION_TYPE.USER) return "user";
  if (type === OPTION_TYPE.ROLE) return "role";
  if (type === OPTION_TYPE.CHANNEL) return "channel";
  return "entity";
}

/**
 * Parse a message line into a ParsedCommand (spec § Prefix grammar algorithm 1–7).
 *
 * @param {string} content raw message content
 * @param {object} [opts]
 * @param {string} [opts.prefix] override prefix (default: config, K1 `!`)
 * @param {Array<object>} [opts.registryCommands] command JSON (default: the
 *   lazily built default registry)
 * @param {{users?: Array, roles?: Array, channels?: Array}} [opts.mentions]
 *   structured mentions of the message (enables the K10 markup rule in-parser;
 *   dispatch re-checks them against the real payload)
 * @returns {object|null} ParsedCommand, or null when not a command
 */
function parsePrefix(content, opts = {}) {
  if (typeof content !== "string") return null;
  const prefix = opts.prefix !== undefined && opts.prefix !== null
    ? assertPrefix(opts.prefix)
    : defaultPrefix();

  const tree = opts.registryCommands
    ? buildFluxerCommandTree(opts.registryCommands)
    : defaultTree();

  // Step 1 — leading whitespace trim, literal prefix.
  const trimmed = content.replace(/^[ \t\n\r\v\f]+/, "");
  if (!trimmed.startsWith(prefix)) return null;

  // Step 2 — strip the prefix; empty remainder is not a command.
  const rest = trimmed.slice(prefix.length);
  if (rest.trim() === "") return null;

  // Step 3 — tokenize.
  const { tokens, unclosed } = tokenize(rest);
  if (tokens.length === 0) return null;

  // Step 4 — command name, case-insensitive.
  const nameToken = tokens[0].value.toLowerCase();

  if (nameToken === "help") {
    const args = tokens.slice(1).map((t) => String(t.value).toLowerCase());
    return {
      commandName: "help",
      subcommandGroup: null,
      subcommand: null,
      options: [],
      help: { tokens: helpTokens(args, tree) },
      usageError: null,
    };
  }

  const entry = lookupCommand(tree, nameToken);
  if (!entry) return null; // unknown command: not a command at all (XP-eligible)

  if (unclosed) {
    // An unclosed quote on a KNOWN command is a usage error (spec step 3).
    return {
      commandName: entry.name,
      subcommandGroup: null,
      subcommand: null,
      options: [],
      help: null,
      usageError: usage(
        `Unclosed quote — close the quoted text with a double quote (") and send again.`,
        entry.name,
      ),
    };
  }

  // Step 5 — group / subcommand navigation (bare tokens, never name/value pairs).
  let group = null;
  let sub = null;
  let optionDefs = entry.options;
  let next = 1;

  const hasStructure = entry.groups.size > 0 || entry.subcommands.size > 0;
  if (hasStructure) {
    const first = tokens[1] ? String(tokens[1].value).toLowerCase() : null;
    if (first == null) {
      const expected = [
        ...entry.groups.keys(),
        ...entry.subcommands.keys(),
      ];
      return {
        commandName: entry.name,
        subcommandGroup: null,
        subcommand: null,
        options: [],
        help: null,
        usageError: usage(
          `The command "${entry.name}" needs a subcommand: ${expected.join(", ")}.`,
          entry.name,
        ),
      };
    }
    if (entry.groups.size > 0 && entry.groups.has(first)) {
      group = entry.groups.get(first);
      const second = tokens[2] ? String(tokens[2].value).toLowerCase() : null;
      if (second == null || !group.subcommands.has(second)) {
        return {
          commandName: entry.name,
          subcommandGroup: group?.name ?? null,
          subcommand: null,
          options: [],
          help: null,
          usageError: usage(
            second == null
              ? `The command "${entry.name} ${group.name}" needs a subcommand: ${[...group.subcommands.keys()].join(", ")}.`
              : `Unknown subcommand "${tokens[2].value}" for "${entry.name} ${group.name}". Expected one of: ${[...group.subcommands.keys()].join(", ")}.`,
            entry.name,
            group,
          ),
        };
      }
      sub = group.subcommands.get(second);
      optionDefs = sub.options;
      next = 3;
    } else if (entry.subcommands.has(first)) {
      sub = entry.subcommands.get(first);
      optionDefs = sub.options;
      next = 2;
    } else {
      const expected = [...entry.groups.keys(), ...entry.subcommands.keys()];
      return {
        commandName: entry.name,
        subcommandGroup: null,
        subcommand: null,
        options: [],
        help: null,
        usageError: usage(
          `Unknown subcommand "${tokens[1].value}" for "${entry.name}". Expected one of: ${expected.join(", ")}.`,
          entry.name,
        ),
      };
    }
  }

  // Step 6 — name value pairs.
  const byName = new Map(optionDefs.map((o) => [String(o.name).toLowerCase(), o]));
  const seen = new Set();
  const options = [];
  const mentionCounters = { 6: 0, 7: 0, 8: 0, 9: 0 }; // USER, CHANNEL, ROLE, MENTIONABLE
  const scopeLabel = sub ? `${entry.name} ${group ? group.name + " " : ""}${sub.name}` : entry.name;

  for (let i = next; i < tokens.length; i += 2) {
    const nameToken = String(tokens[i].value).toLowerCase();
    const def = byName.get(nameToken);
    if (!def) {
      return {
        commandName: entry.name,
        subcommandGroup: group?.name ?? null,
        subcommand: sub?.name ?? null,
        options: [],
        help: null,
        usageError: usage(
          `Unknown option "${tokens[i].value}" for "${scopeLabel}". Options are named — write them as name value pairs (see the help below).`,
          entry.name,
          group,
          sub,
        ),
      };
    }
    if (seen.has(nameToken)) {
      return {
        commandName: entry.name,
        subcommandGroup: group?.name ?? null,
        subcommand: sub?.name ?? null,
        options: [],
        help: null,
        usageError: usage(
          `Option "${def.name}" was given twice for "${scopeLabel}". Each option takes one value.`,
          entry.name,
          group,
          sub,
        ),
      };
    }
    const valueToken = tokens[i + 1];
    if (valueToken === undefined) {
      return {
        commandName: entry.name,
        subcommandGroup: group?.name ?? null,
        subcommand: sub?.name ?? null,
        options: [],
        help: null,
        usageError: usage(
          `Option "${def.name}" for "${scopeLabel}" has no value — a trailing option name needs its value after it.`,
          entry.name,
          group,
          sub,
        ),
      };
    }
    seen.add(nameToken);

    const coerced = coerceValue(def, String(valueToken.value));
    if (!coerced.ok) {
      return {
        commandName: entry.name,
        subcommandGroup: group?.name ?? null,
        subcommand: sub?.name ?? null,
        options: [],
        help: null,
        usageError: usage(coerced.reason, entry.name, group, sub),
      };
    }

    let mentionIndex = null;
    if (def.type === OPTION_TYPE.USER || def.type === OPTION_TYPE.ROLE || def.type === OPTION_TYPE.CHANNEL) {
      const guard = k10Guard(def, String(valueToken.value), opts.mentions, scopeLabel);
      if (guard) {
        return {
          commandName: entry.name,
          subcommandGroup: group?.name ?? null,
          subcommand: sub?.name ?? null,
          options: [],
          help: null,
          usageError: usage(guard, entry.name, group, sub),
        };
      }
      if (!/^\d+$/.test(String(valueToken.value))) {
        mentionIndex = mentionCounters[def.type]++;
      }
    }

    options.push({
      name: def.name,
      type: def.type,
      value: coerced.value,
      mentionIndex,
      allowedChannelTypes: Array.isArray(def.channel_types) ? def.channel_types.slice() : null,
    });
  }

  // Step 6 (cont.) — required options that were never named.
  for (const def of optionDefs) {
    if (def.required && !seen.has(String(def.name).toLowerCase())) {
      return {
        commandName: entry.name,
        subcommandGroup: group?.name ?? null,
        subcommand: sub?.name ?? null,
        options: [],
        help: null,
        usageError: usage(
          `Missing required option "${def.name}" for "${scopeLabel}". Add it as: ${def.name} <${TYPE_LABELS[def.type] ?? def.type}>.`,
          entry.name,
          group,
          sub,
        ),
      };
    }
  }

  return {
    commandName: entry.name,
    subcommandGroup: group ? group.name : null,
    subcommand: sub ? sub.name : null,
    options,
    help: null,
    usageError: null,
  };
}

/**
 * K10 markup guard with the real option name (parser-side, only when
 * opts.mentions were supplied — dispatch re-validates against the payload).
 *
 * @param {object} def
 * @param {string} token
 * @param {object|undefined} mentions
 * @param {string} scopeLabel
 * @returns {string|null}
 */
function k10Guard(def, token, mentions, scopeLabel) {
  if (!mentions) return null;
  const kind =
    def.type === OPTION_TYPE.USER ? "users" : def.type === OPTION_TYPE.ROLE ? "roles" : "channels";
  const arr = Array.isArray(mentions[kind]) ? mentions[kind] : [];
  if (arr.length > 0) return null;
  if (MARKUP_RE.test(token)) {
    return def.type === OPTION_TYPE.USER
      ? K10_USER_COPY
      : def.type === OPTION_TYPE.ROLE
        ? K10_ROLE_COPY
        : K10_CHANNEL_COPY;
  }
  if (!/^\d+$/.test(token)) {
    const kindLabel = typeKindLabel(def.type);
    return `Option "${def.name}" needs a ${kindLabel} id (5–20 digits). "${token}" is not an id, and this message has no ${kindLabel} mentions to match against.`;
  }
  return null;
}

module.exports = {
  OPTION_TYPE,
  TYPE_LABELS,
  K10_USER_COPY,
  K10_ROLE_COPY,
  K10_CHANNEL_COPY,
  DISCORD_ONLY_COMMANDS,
  DISCORD_ONLY_SUBCOMMANDS,
  parsePrefix,
  buildFluxerCommandTree,
  formatCommandHelp,
  formatCommandHelpFromTree,
  formatCommandList,
  tokenize,
};
