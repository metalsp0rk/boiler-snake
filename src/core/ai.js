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
 *   ("http" | "network" | "timeout").
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
  try {
    const res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: "http",
        error: `HTTP ${res.status}`,
      };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      reason: controller.signal.aborted ? "timeout" : "network",
      error: err?.message || String(err),
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
 * @param {object} [opts.responseFormat] e.g. { type: "json_object" }.
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<object>}
 *   ok:true → message (raw assistant message, may include tool_calls).
 *   ok:false → status/error/reason as in requestCompletion, or
 *   reason "empty" when the response carries no assistant message.
 */
async function completeOnce(cfg, opts) {
  const payload = { model: cfg.model, messages: opts.messages };
  if (typeof opts.temperature === "number") {
    payload.temperature = opts.temperature;
  }
  if (typeof opts.maxTokens === "number") payload.max_tokens = opts.maxTokens;
  if (opts.responseFormat) payload.response_format = opts.responseFormat;
  if (opts.tools?.length) payload.tools = opts.tools;

  const res = await requestCompletion(cfg, payload, opts);
  if (!res.ok) return res;
  const message = res.data?.choices?.[0]?.message;
  if (!message) {
    return {
      ok: false,
      reason: "empty",
      error: "no assistant message in response",
    };
  }
  return { ok: true, message };
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
    durationMs: Date.now() - startedAt,
    toolCalls,
  };
}

/**
 * Build a successful AiResult.
 * @param {string|null} content
 * @param {number} startedAt
 * @param {number} toolCalls
 * @returns {object} AiResult
 */
function success(content, startedAt, toolCalls) {
  return {
    ok: true,
    content,
    status: null,
    error: null,
    reason: null,
    durationMs: Date.now() - startedAt,
    toolCalls,
  };
}

/**
 * @typedef {object} AiResult
 * @property {boolean} ok
 * @property {string|null} content Final assistant text (null when absent)
 * @property {string|null} error Human-readable failure reason
 * @property {number|null} status HTTP status on provider error
 * @property {string|null} reason "http" | "network" | "timeout" | "empty" | "cap" | null
 * @property {number} durationMs Wall-clock ms for the whole call
 * @property {number} toolCalls Tool executions (tool loop only)
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
 * @param {object} [opts.responseFormat] e.g. { type: "json_object" }.
 * @param {number} [opts.timeoutMs] Overall timeout for this request (ms).
 * @param {Function} [opts.fetchImpl] Injectable fetch (tests).
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
  );
}

/**
 * Execute all tool calls from one assistant message and append the
 * `tool` results to the conversation (immutably).
 * @param {object[]} conversation
 * @param {object[]} calls assistant message tool_calls
 * @param {(name: string, args: object) => (string|Promise<string>)} executeTool
 * @returns {Promise<{ conversation: object[], count: number }>}
 */
async function applyToolCalls(conversation, calls, executeTool) {
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
    try {
      output = await executeTool(name, args);
    } catch (err) {
      output = `tool "${name}" failed: ${err?.message || String(err)}`;
    }
    next = [
      ...next,
      {
        role: "tool",
        tool_call_id: call?.id || "",
        content: output == null ? "" : String(output),
      },
    ];
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
 * @param {number} [opts.timeoutMs] Overall timeout for the whole loop (ms).
 * @param {Function} [opts.fetchImpl] Injectable fetch (tests).
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
      const res = await completeOnce(cfg, {
        messages: conversation,
        tools: opts.tools,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: controller.signal,
        fetchImpl: opts.fetchImpl,
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
        };
      }
      const applied = await applyToolCalls(conversation, calls, opts.executeTool);
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
