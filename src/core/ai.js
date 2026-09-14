/**
 * Shared OpenAI-compatible AI client (raw global fetch, no SDK).
 *
 * Used by the tickets feature (structured summaries) and gork
 * (keyword Q&A + web_search tool loop). Provider config comes from
 * env via getAiConfig() (AI_* vars with OPENAI_* fallbacks).
 *
 * Every async entry point never throws: it resolves to a result object
 * with `ok` plus enough detail (`status`, `error`, `reason`) for
 * callers to degrade gracefully.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";

/** Max chars kept from a provider error response body for diagnostics. */
const ERROR_BODY_MAX_CHARS = 300;

/**
 * Fire one optional capture event. A sink failure must never break the
 * completion loop or escape into the reply path — it degrades to a warn
 * (same never-throw sink idiom as the gork audit log).
 *
 * @param {Function|null|undefined} onEvent capture sink (inert when absent)
 * @param {object} evt capture event ({type:"request"|"response"|"tool", ...})
 */
function emitEvent(onEvent, evt) {
  if (typeof onEvent !== "function") return;
  try {
    onEvent(evt);
  } catch (err) {
    console.warn("[ai] interaction event failed:", err?.message || err);
  }
}

/**
 * Read AI provider config from env.
 * AI_* vars take precedence over OPENAI_* fallbacks; baseUrl has its
 * trailing slash stripped.
 * @returns {{ apiKey: string|null, baseUrl: string, model: string }}
 *   apiKey is null when no key is configured (features then stay off).
 */
function getAiConfig() {
  return {
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || null,
    baseUrl: (
      process.env.AI_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, ""),
    model: process.env.AI_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL,
  };
}

/**
 * One chat/completions HTTP round trip against cfg.baseUrl.
 * Never throws.
 *
 * @param {{ apiKey: string, baseUrl: string, model: string }} cfg
 *   getAiConfig() result.
 * @param {object} payload Request body (model, messages, ...).
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] Abort the request after this many ms.
 * @param {AbortSignal} [opts.signal] External abort signal (deadline).
 * @param {Function} [opts.fetchImpl] Injectable fetch (tests).
 * @returns {Promise<object>}
 *   ok:true → data (parsed JSON body).
 *   ok:false → status (HTTP code) and/or error + reason
 *   ("http" | "network" | "timeout"), plus url (the endpoint that was
 *   hit) and — on an HTTP error — errorBody: a truncated snippet of the
 *   provider's error response body, which usually names the real cause
 *   ("invalid API key", "model not found", context-length overflow…)
 *   that a bare `HTTP 4xx` never tells.
 */
async function requestCompletion(cfg, payload, opts = {}) {
  const controller = new AbortController();
  let timer = null;
  const onAbort = () => controller.abort();
  if (opts.timeoutMs) {
    timer = setTimeout(onAbort, opts.timeoutMs);
  }
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const url = `${cfg.baseUrl}/chat/completions`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Diagnostic capture: the provider's error body almost always
      // explains a fast reject (wrong model name, bad key, unknown
      // param, context overflow). Read it best-effort — a broken/absent
      // body reader must never change the result shape.
      let errorBody = "";
      try {
        if (typeof res.text === "function") {
          errorBody = (await res.text()).trim().slice(0, ERROR_BODY_MAX_CHARS);
        }
      } catch {
        // Body unreadable: keep the status-only error.
      }
      return {
        ok: false,
        status: res.status,
        reason: "http",
        error: `HTTP ${res.status}`,
        url,
        ...(errorBody ? { errorBody } : {}),
      };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : "network",
      error: err?.message || String(err),
      url,
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * One completion round trip; resolves to the raw assistant message.
 * Never throws.
 *
 * @param {{ apiKey: string, baseUrl: string, model: string }} cfg
 * @param {object} opts
 * @param {object[]} opts.messages Chat messages.
 * @param {object[]} [opts.tools] OpenAI tool definitions.
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens] Sent as max_tokens when set.
 * @param {number} [opts.thinkingTokenBudget] Sent as
 *   thinking_token_budget ONLY when a positive finite number (reasoning
 *   cap passthrough for servers that enforce it, e.g. vLLM with
 *   --reasoning-parser).
 * @param {object} [opts.responseFormat] e.g. { type: "json_object" }.
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.fetchImpl]
 * @param {(evt: object) => void} [opts.onEvent] Capture sink (optional,
 *   never affects behavior; sink errors are caught). Emits, in order:
 *   `{type:"request", payload}` — the exact wire body, right after build;
 *   then `{type:"response", ok, status?, reason?, error?, data?,
 *   finishReason?, usage?, durationMs}` — `data` is the raw parsed body on
 *   success only (omitted on failure to keep captures small).
 * @returns {Promise<object>}
 *   ok:true → message (raw assistant message, may include tool_calls)
 *   plus finishReason/usage from the provider response.
 *   ok:false → status/error/reason as in requestCompletion, or
 *   reason "empty" when the response carries no assistant message.
 */
async function completeOnce(cfg, opts) {
  const payload = { model: cfg.model, messages: opts.messages };
  if (typeof opts.temperature === "number") {
    payload.temperature = opts.temperature;
  }
  if (typeof opts.maxTokens === "number") payload.max_tokens = opts.maxTokens;
  // Strict-provider safety: OpenAI-compatible frontends reject unknown
  // params, so thinking_token_budget is sent ONLY on an explicit positive
  // opt-in — never by default.
  if (
    Number.isFinite(opts.thinkingTokenBudget) &&
    opts.thinkingTokenBudget > 0
  ) {
    payload.thinking_token_budget = Math.trunc(opts.thinkingTokenBudget);
  }
  if (opts.responseFormat) payload.response_format = opts.responseFormat;
  if (opts.tools?.length) payload.tools = opts.tools;

  // Capture seam: the request event carries the exact wire body, emitted
  // before the HTTP attempt so a network-level failure still has its request
  // recorded. opts.onEvent is deliberately NOT part of the payload above.
  emitEvent(opts.onEvent, { type: "request", payload });
  const httpStartedAt = Date.now();
  const res = await requestCompletion(cfg, payload, opts);
  if (!res.ok) {
    emitEvent(opts.onEvent, {
      type: "response",
      ok: false,
      status: res.status ?? null,
      reason: res.reason,
      error: res.error,
      // Endpoint + provider error-body snippet: a fast HTTP reject is
      // meaningless without them (the interaction log records these).
      url: res.url ?? null,
      errorBody: res.errorBody ?? null,
      durationMs: Date.now() - httpStartedAt,
    });
    return res;
  }
  const message = res.data?.choices?.[0]?.message;
  if (!message) {
    emitEvent(opts.onEvent, {
      type: "response",
      ok: false,
      status: null,
      reason: "empty",
      error: "no assistant message in response",
      durationMs: Date.now() - httpStartedAt,
    });
    return {
      ok: false,
      reason: "empty",
      error: "no assistant message in response",
    };
  }
  emitEvent(opts.onEvent, {
    type: "response",
    ok: true,
    data: res.data,
    finishReason: res.data?.choices?.[0]?.finish_reason ?? null,
    usage: res.data?.usage ?? null,
    durationMs: Date.now() - httpStartedAt,
  });
  return {
    ok: true,
    message,
    finishReason: res.data?.choices?.[0]?.finish_reason ?? null,
    usage: res.data?.usage ?? null,
  };
}

/**
 * Normalize a failed round trip into a public AiResult.
 * @param {{ status?: number, error?: string, reason?: string }} result
 * @param {number} startedAt
 * @param {number} toolCalls
 * @returns {object} AiResult
 */
function failure(result, startedAt, toolCalls) {
  return {
    ok: false,
    content: null,
    status: result.status ?? null,
    error: result.error || "unknown error",
    reason: result.reason || "network",
    // Diagnostic passthrough (see requestCompletion): which endpoint was
    // hit, and the provider's own words when it sent an error body.
    url: result.url ?? null,
    errorBody: result.errorBody ?? null,
    durationMs: Date.now() - startedAt,
    toolCalls,
    finishReason: null,
    usage: null,
  };
}

/**
 * Build a successful AiResult.
 * @param {string|null} content
 * @param {number} startedAt
 * @param {number} toolCalls
 * @param {{ finishReason?: string|null, usage?: object|null }} [meta]
 *   Provider diagnostics from the final round.
 * @returns {object} AiResult
 */
function success(content, startedAt, toolCalls, meta = {}) {
  return {
    ok: true,
    content,
    status: null,
    error: null,
    reason: null,
    durationMs: Date.now() - startedAt,
    toolCalls,
    finishReason: meta.finishReason ?? null,
    usage: meta.usage ?? null,
  };
}

/**
 * @typedef {object} AiResult
 * @property {boolean} ok
 * @property {string|null} content Final assistant text (null when absent)
 * @property {string|null} error Human-readable failure reason
 * @property {number|null} status HTTP status on provider error
 * @property {string|null} reason "http" | "network" | "timeout" | "empty" | "cap" | null
 * @property {string|null} url Endpoint hit on failure (null when absent)
 * @property {string|null} errorBody Truncated provider error response body
 *   on HTTP failure (null when absent/unreadable)
 * @property {number} durationMs Wall-clock ms for the whole call
 * @property {number} toolCalls Tool executions (tool loop only)
 * @property {string|null} finishReason Provider finish_reason of the final
 *   round (null when absent)
 * @property {object|null} usage Final round's provider usage object
 *   (null when absent)
 */

/**
 * Single chat completion (no tool loop). Never throws.
 *
 * @param {{ apiKey: string, baseUrl: string, model: string }} cfg
 *   getAiConfig() result.
 * @param {object} opts
 * @param {object[]} opts.messages Chat messages (system/user/...).
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.thinkingTokenBudget] Reasoning cap passthrough
 *   (sent only when a positive finite number).
 * @param {object} [opts.responseFormat] e.g. { type: "json_object" }.
 * @param {number} [opts.timeoutMs] Overall timeout for this request (ms).
 * @param {Function} [opts.fetchImpl] Injectable fetch (tests).
 * @param {(evt: object) => void} [opts.onEvent] Capture sink forwarded to
 *   completeOnce: `{type:"request", payload}` + `{type:"response", ok, ...}`
 *   events (see completeOnce); strictly optional, never affects behavior.
 * @returns {Promise<AiResult>}
 *   ok is true whenever the provider round trip succeeded (content may
 *   still be null — callers should check content). ok:false → status
 *   (HTTP), error, reason ("http" | "network" | "timeout" | "empty").
 */
async function chatCompletion(cfg, opts = {}) {
  const startedAt = Date.now();
  const res = await completeOnce(cfg, opts);
  if (!res.ok) return failure(res, startedAt, 0);
  return success(
    res.message?.content == null ? null : String(res.message.content),
    startedAt,
    0,
    { finishReason: res.finishReason, usage: res.usage },
  );
}

/**
 * Execute all tool calls from one assistant message and append the
 * `tool` results to the conversation (immutably).
 * @param {object[]} conversation
 * @param {object[]} calls assistant message tool_calls
 * @param {(name: string, args: object) => (string|Promise<string>)} executeTool
 * @param {Function|null} [onEvent] Capture sink (optional): emits
 *   `{type:"tool", name, args, output, ok, durationMs}` per execution;
 *   `ok:false` when executeTool threw (the failure string still feeds the
 *   model, exactly as before).
 * @returns {Promise<{ conversation: object[], count: number }>}
 */
async function applyToolCalls(conversation, calls, executeTool, onEvent = null) {
  let count = 0;
  let next = conversation;
  for (const call of calls) {
    count += 1;
    const name = call?.function?.name || "unknown";
    let args = {};
    try {
      args = JSON.parse(call?.function?.arguments || "{}");
    } catch {
      args = {};
    }
    let output;
    let ok = true;
    const toolStartedAt = Date.now();
    try {
      output = await executeTool(name, args);
    } catch (err) {
      output = `tool "${name}" failed: ${err?.message || String(err)}`;
      ok = false;
    }
    const content = output == null ? "" : String(output);
    emitEvent(onEvent, {
      type: "tool",
      name,
      args,
      output: content,
      ok,
      durationMs: Date.now() - toolStartedAt,
    });
    next = [...next, { role: "tool", tool_call_id: call?.id || "", content }];
  }
  return { conversation: next, count };
}

/**
 * Chat completion with an OpenAI-compatible tool-calling loop.
 *
 * While the model responds with tool_calls, each call is executed via
 * executeTool(name, args) and the result fed back as a `tool` message.
 * The loop ends when the model responds with plain content, after
 * maxToolRounds tool rounds, or on timeout/error. Never throws.
 *
 * @param {{ apiKey: string, baseUrl: string, model: string }} cfg
 *   getAiConfig() result.
 * @param {object} opts
 * @param {object[]} opts.messages Initial chat messages.
 * @param {object[]} opts.tools OpenAI tool definitions (e.g. web_search).
 * @param {(name: string, args: object) => (string|Promise<string>)} opts.executeTool
 *   Runs a tool and returns the string result fed back to the model.
 *   Thrown errors are reported to the model as a failure string.
 * @param {number} [opts.maxToolRounds=3] Max rounds in which the model
 *   may call tools.
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.thinkingTokenBudget] Reasoning cap passthrough
 *   forwarded to every round (sent only when a positive finite number).
 * @param {number} [opts.timeoutMs] Overall timeout for the whole loop (ms).
 * @param {Function} [opts.fetchImpl] Injectable fetch (tests).
 * @param {(evt: object) => void} [opts.onEvent] Capture sink, every event
 *   round-tagged: `{type:"request"|"response", round, ...}` per wire round
 *   plus `{type:"tool", round, name, args, output, ok, durationMs}` per
 *   tool execution (see completeOnce); strictly optional.
 * @returns {Promise<AiResult>}
 *   content is the final assistant text; toolCalls is the total number of
 *   tool executions; durationMs covers the whole loop. ok:false → reason
 *   ("http" | "network" | "timeout" | "empty" | "cap").
 */
async function chatWithTools(cfg, opts) {
  const startedAt = Date.now();
  const deadline = opts.timeoutMs ? startedAt + opts.timeoutMs : null;
  const controller = new AbortController();
  let timer = null;
  const armDeadline = () => {
    if (!deadline) return;
    if (timer) clearTimeout(timer);
    const remaining = deadline - Date.now();
    if (remaining <= 0) controller.abort();
    else timer = setTimeout(() => controller.abort(), remaining);
  };
  armDeadline();
  const maxRounds = Math.max(0, Math.trunc(opts.maxToolRounds ?? 3));
  // Capture seam: one round-tagging wrapper around the caller's sink;
  // undefined when no sink was passed so every downstream emit stays inert.
  const emit = typeof opts.onEvent === "function" ? opts.onEvent : null;
  let conversation = [...(opts.messages || [])];
  let toolCalls = 0;
  try {
    for (let round = 0; ; round += 1) {
      if (deadline && Date.now() >= deadline) {
        return {
          ok: false,
          content: null,
          status: null,
          error: "timed out",
          reason: "timeout",
          durationMs: Date.now() - startedAt,
          toolCalls,
        };
      }
      // Per-round capture wrapper (`let round` gives each iteration its own
      // binding); undefined stays fully inert in the sinks below.
      const child = emit ? (evt) => emit({ ...evt, round }) : undefined;
      const res = await completeOnce(cfg, {
        messages: conversation,
        tools: opts.tools,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        thinkingTokenBudget: opts.thinkingTokenBudget,
        signal: controller.signal,
        fetchImpl: opts.fetchImpl,
        onEvent: child,
      });
      if (!res.ok) return failure(res, startedAt, toolCalls);
      const message = res.message;
      conversation = [...conversation, message];
      const calls = Array.isArray(message.tool_calls)
        ? message.tool_calls
        : [];
      if (!calls.length) {
        return success(
          message.content == null ? null : String(message.content),
          startedAt,
          toolCalls,
          { finishReason: res.finishReason, usage: res.usage },
        );
      }
      if (round >= maxRounds) {
        return {
          ok: false,
          content: message.content == null ? null : String(message.content),
          status: null,
          error: "max tool rounds reached",
          reason: "cap",
          durationMs: Date.now() - startedAt,
          toolCalls,
          finishReason: res.finishReason ?? null,
          usage: res.usage ?? null,
        };
      }
      const applied = await applyToolCalls(conversation, calls, opts.executeTool, child);
      conversation = applied.conversation;
      toolCalls += applied.count;
      armDeadline();
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  getAiConfig,
  chatCompletion,
  chatWithTools,
};
