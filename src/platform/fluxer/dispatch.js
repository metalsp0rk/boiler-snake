/**
 * Fluxer prefix-command dispatcher (bundle contract 3; roadmap/fluxer.md
 * § Prefix grammar 6–7 + § Command-channel allow-list + § Help).
 *
 * dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor })
 * runs the fixed order:
 *
 *  1. `!help` (parsed.help)  → render help, send in channel (public).
 *  2. parsed.usageError        → reason line + help block for the matched scope.
 *  2.5 Permission mask         → resolveFluxerPermissions (PR 8, spec §
 *     Permissions): the caller's channel bigint mask, computed BEFORE the
 *     command-channel gate. Resolution failure aborts with the specific
 *     fail-closed copy and the handler is NOT called.
 *  3. Option resolution        → user/role/channel refs resolve through the
 *     structured mentions arrays (K10); bare ids resolve through fetchUser /
 *     fetchChannel ONCE; unresolvable → the specific "Could not resolve …"
 *     reply and the handler is NOT called.
 *  4. Command-channel gate     → commandsAllowedFromIds; denial is a plain
 *     channel reply (the error, never a sensitive body).
 *  5. Handler API gate         → only "context"-API handlers run on Fluxer;
 *     interaction-API commands get the NOT_ON_FLUXER line.
 *  6. Handler invocation       → CommandContext (contract 6) + featureCtx
 *     { client, supervisor, registry, ensureHoneypotWarning: null }. A handler
 *     throw is logged and answered with the router-parity generic copy.
 *
 * Async and SDK-free: it touches the registry JSON, the message payload, and
 * the OutboundClient only. Handler throws never escape (AGENTS.md rule 1).
 */

const { buildFluxerCommandContext } = require("./context");
const {
  resolveFluxerPermissions,
  hasBit,
  MANAGE_GUILD,
} = require("./permissions");
const {
  OPTION_TYPE,
  K10_USER_COPY,
  K10_ROLE_COPY,
  K10_CHANNEL_COPY,
  formatCommandHelpFromTree,
  formatCommandList,
  buildFluxerCommandTree,
} = require("./commands");
const { commandsAllowedFromIds } = require("../../core/permissions");
const { MSG_GENERIC_ERROR } = require("../../core/theme");

/** Exact PR 5 copy (src/features/gork/handlers.js NOT_ON_FLUXER). */
const NOT_ON_FLUXER = "That command is not available on Fluxer yet.";

/**
 * The parser validated id SHAPE; dispatch resolves the reference against the
 * message payload (K10 — structured mentions, never markup scraping).
 *
 * @param {object} opt parsed option {value, mentionIndex}
 * @param {object} message NormalizedMessage
 * @param {"users"|"roles"|"channels"} kind
 * @returns {{ id: string }|{ error: string }}
 */
function resolveReferenceId(opt, message, kind) {
  const value = String(opt.value);
  if (/^\d+$/.test(value)) return { id: value };
  const arr = Array.isArray(message.mentions?.[kind]) ? message.mentions[kind] : [];
  if (arr.length === 0) {
    const copy =
      kind === "users" ? K10_USER_COPY
        : kind === "roles" ? K10_ROLE_COPY
          : K10_CHANNEL_COPY;
    if (/^<[@#][!&]?\d{1,25}>$/.test(value)) return { error: copy };
    const kindLabel = kind === "users" ? "user" : kind === "roles" ? "role" : "channel";
    return {
      error:
        `Option "${opt.name}" needs a ${kindLabel} id (5–20 digits). "${value}" is not an id, ` +
        `and this message has no ${kindLabel} mentions to pick from.`,
    };
  }
  const idx = Number.isInteger(opt.mentionIndex) ? opt.mentionIndex : 0;
  const id = arr[idx];
  if (id == null) {
    return {
      error:
        `Option "${opt.name}" refers to ${kind} mention #${idx + 1}, but this message has only ` +
        `${arr.length} ${kind} mention(s). Pass the ${kindLabelKind(kind)} by id (5–20 digits).`,
    };
  }
  return { id: String(id) };
}

/**
 * @param {"users"|"roles"|"channels"} kind
 * @returns {string}
 */
function kindLabelKind(kind) {
  return kind === "users" ? "user" : kind === "roles" ? "role" : "channel";
}

/**
 * Step 3: resolve every parsed option into the typed value the context getters
 * return (spec § Prefix grammar 6–7, K10/step 7).
 *
 * @param {object} parsed
 * @param {object} message
 * @param {object} outbound
 * @returns {Promise<{ resolved: Map<string, *>, reply: string|null }>}
 *   `reply` is the channel reply to send when resolution fails (the handler
 *   is not called in that case).
 */
async function resolveOptions(parsed, message, outbound) {
  const resolved = new Map();
  const fetchCache = new Map();

  for (const opt of parsed.options ?? []) {
    switch (opt.type) {
      case OPTION_TYPE.USER: {
        const ref = resolveReferenceId(opt, message, "users");
        if (ref.error) return { resolved, reply: ref.error };
        const id = ref.id;
        if (id === String(message.authorId)) {
          resolved.set(
            opt.name,
            {
              id,
              username: message.authorRaw?.username ?? null,
              bot: Boolean(message.authorBot),
            },
          );
          break;
        }
        const mentionBot = message.mentionBots?.get?.(id);
        if (mentionBot !== undefined) {
          // Mentioned user: username/bot come straight off the gateway payload.
          const raw = Array.isArray(message.mentionUsersRaw)
            ? message.mentionUsersRaw.find((u) => String(u?.id) === id)
            : null;
          resolved.set(
            opt.name,
            { id, username: raw?.username ?? null, bot: Boolean(mentionBot) },
          );
          break;
        }
        const key = `user:${id}`;
        if (!fetchCache.has(key)) {
          fetchCache.set(key, outbound.fetchUser(message.communityId, id));
        }
        const user = await fetchCache.get(key);
        if (!user) {
          return {
            resolved,
            reply:
              `Could not resolve user ${id}: the instance returned no user record. ` +
              `Check the id, or mention the user so the gateway sends their profile.`,
          };
        }
        resolved.set(opt.name, {
          id: String(user.id),
          username: user.username ?? null,
          bot: Boolean(user.bot),
        });
        break;
      }
      case OPTION_TYPE.CHANNEL: {
        const ref = resolveReferenceId(opt, message, "channels");
        if (ref.error) return { resolved, reply: ref.error };
        const id = ref.id;
        let type = message.channelTypes?.get?.(id);
        if (type == null) {
          const key = `channel:${id}`;
          if (!fetchCache.has(key)) {
            fetchCache.set(key, outbound.fetchChannel(message.communityId, id));
          }
          const fetched = await fetchCache.get(key);
          if (!fetched) {
            return {
              resolved,
              reply:
                `Could not resolve channel ${id}: the instance returned no channel record. ` +
                `Check the id, or mention the channel so the gateway sends its metadata.`,
            };
          }
          type = fetched.type ?? null;
        }
        const allowed = Array.isArray(opt.allowedChannelTypes) ? opt.allowedChannelTypes : null;
        if (allowed && allowed.length > 0 && type != null && !allowed.includes(type)) {
          return {
            resolved,
            reply:
              `Channel ${id} is type ${type}, which option "${opt.name}" does not accept ` +
              `(allowed types: ${allowed.join(", ")}). Pick a channel of a listed type.`,
          };
        }
        resolved.set(opt.name, { id, type: type ?? null });
        break;
      }
      case OPTION_TYPE.ROLE: {
        const ref = resolveReferenceId(opt, message, "roles");
        if (ref.error) return { resolved, reply: ref.error };
        resolved.set(opt.name, { id: ref.id });
        break;
      }
      case OPTION_TYPE.INTEGER:
      case OPTION_TYPE.NUMBER: {
        const n = Number(opt.value);
        resolved.set(opt.name, Number.isFinite(n) ? n : null);
        break;
      }
      case OPTION_TYPE.BOOLEAN: {
        resolved.set(opt.name, opt.value === "true");
        break;
      }
      default: {
        // STRING and anything typeless: the parser's value is final.
        resolved.set(opt.name, opt.value);
      }
    }
  }
  return { resolved, reply: null };
}

/**
 * Render `!help` (spec § Help): bare `!help` lists commands; `!help <cmd>`,
 * `!help <cmd> <sub|group>`, and the group form take their blocks from the
 * shared renderer (commands.js owns the tree).
 *
 * @param {Array<object>} registryCommands
 * @param {string[]} tokens parser help tokens
 * @returns {string}
 */
function renderHelp(registryCommands, tokens) {
  if (!tokens || tokens.length === 0) return formatCommandList(registryCommands);
  const tree = buildFluxerCommandTree(registryCommands);
  return formatCommandHelpFromTree(tree, tokens[0], tokens);
}

/**
 * Dispatch one parsed prefix command. Never throws: expected failures are
 * channel replies; handler throws are logged and answered with the router's
 * generic copy (spec 652 — DM-if-sensitive with K2 fallback).
 *
 * @param {object} outbound OutboundClient for the message's instance
 * @param {object} message NormalizedMessage (communityId resolved by the pipeline)
 * @param {object|null} parsed ParsedCommand from parsePrefix
 * @param {object} deps
 * @param {object} deps.registry CommandRegistry (commands JSON + handlers)
 * @param {object|null} [deps.supervisor] platform supervisor (featureCtx parity)
 * @returns {Promise<void>}
 */
async function dispatchPrefixCommand(outbound, message, parsed, { registry, supervisor } = {}) {
  try {
    if (!parsed || typeof parsed.commandName !== "string") return;
    if (!registry) {
      console.error(
        `[fluxer] dispatch /${parsed.commandName}: registry missing (message ${message?.id}) — command dropped`,
      );
      return;
    }

    // Step 1: !help (public reply — help is not sensitive data).
    if (parsed.help) {
      await outbound.sendChannel(message.channelId, {
        content: renderHelp(registry.commands, parsed.help.tokens),
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Step 2: usage error = reason line + the help block for the matched scope.
    if (parsed.usageError) {
      const u = parsed.usageError;
      const scope = [u.commandName, u.group, u.sub].filter(Boolean);
      const help = formatCommandHelpFromTree(
        buildFluxerCommandTree(registry.commands),
        u.commandName,
        scope.map((s) => String(s).toLowerCase()),
      );
      await outbound.sendChannel(message.channelId, {
        content: `${u.reason}\n${help}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Step 2.5 (PR 8, spec § Permissions): compute the caller's channel
    // permission mask BEFORE the command-channel gate. The gateway member
    // payload IS the instance cache (spec "Cache misses, fail closed" rule 1:
    // fetchMember is the FALLBACK for a member the message did not carry).
    // A resolve failure is the specific fail-closed copy in the channel and
    // the handler is never reached — never a silent zero-mask fallback.
    let permissions = null;
    let authorOverride = null;
    if (Number.isInteger(message.communityId)) {
      const resolvedPerms = await resolveFluxerPermissions({
        outbound,
        communityId: message.communityId,
        userId: message.authorId,
        channelId: message.channelId,
        instanceKey: message.instanceKey ?? outbound.instanceKey ?? "fluxer",
        member: Array.isArray(message.memberRoleIds)
          ? {
              roleIds: message.memberRoleIds,
              bot: Boolean(message.authorBot),
              username: message.authorRaw?.username ?? null,
            }
          : null,
      });
      if (!resolvedPerms.ok) {
        await outbound.sendChannel(message.channelId, {
          content: resolvedPerms.error,
          allowedMentions: { parse: [] },
        });
        return;
      }
      permissions = {
        channelPermissions: resolvedPerms.channelPermissions,
        memberRoleIds: resolvedPerms.memberRoleIds,
        user: resolvedPerms.author,
      };
      authorOverride = resolvedPerms.author ?? null;
    }

    // Step 3: resolve option references against the payload (K10) with the
    // one-shot fetch fallbacks (spec § Prefix grammar step 7).
    const { resolved, reply } = await resolveOptions(parsed, message, outbound);
    if (reply) {
      await outbound.sendChannel(message.channelId, {
        content: reply,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Step 4: command-channel allow-list (spec § Command-channel allow-list).
    // PR 8: the computed mask is real now, so admins (MANAGE_GUILD bit, owner
    // and administrator included — both arrive as ALL) keep the Discord-parity
    // exemption: setcommandchannel runs from any channel for them.
    const isAdmin = hasBit(
      permissions ? permissions.channelPermissions : 0n,
      MANAGE_GUILD,
    );
    const allowed = commandsAllowedFromIds(
      parsed.commandName,
      message.communityId,
      message.channelId,
      isAdmin,
    );
    if (!allowed) {
      await outbound.sendChannel(message.channelId, {
        content: "Commands aren't enabled in this channel.",
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Step 5: only context-API handlers are Fluxer-capable in PR 5's cutover.
    const api = registry.getHandlerApi(parsed.commandName);
    if (api !== "context") {
      await outbound.sendChannel(message.channelId, {
        content: NOT_ON_FLUXER,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Step 6: build the context and run the handler. The mask bundle from
    // step 2.5 rides along (contract 3); when permissions is null (message
    // without a resolved communityId) the builder keeps its PR 6 defaults.
    const commandCtx = buildFluxerCommandContext(parsed, message, {
      outbound,
      resolved,
      permissions,
      authorOverride,
    });
    const handler = registry.getHandler(parsed.commandName);
    const featureCtx = {
      client: supervisor?.discord ?? null,
      supervisor,
      registry,
      ensureHoneypotWarning: null,
    };
    try {
      await handler(commandCtx, featureCtx);
    } catch (err) {
      // Router-parity: log with the cause, reply the sanctioned generic copy
      // (spec 652) through the context so K2 (DM-first) applies.
      console.error(
        `[fluxer] /${parsed.commandName} failed: ${err?.message || err}`,
      );
      await commandCtx.reply({ content: MSG_GENERIC_ERROR, sensitive: true });
    }
  } catch (err) {
    // Dispatch's own boundary: a reply-send failure must not kill the pipeline.
    console.error(
      `[fluxer] dispatch /${parsed?.commandName ?? "?"} failed: ${err?.message || err}`,
    );
  }
}

module.exports = { dispatchPrefixCommand, NOT_ON_FLUXER };
