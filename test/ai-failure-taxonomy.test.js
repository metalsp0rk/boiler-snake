/**
 * #469 (F1-7): src/core/ai.js failure honesty.
 *
 * 1. A 200 response whose body is NOT valid JSON was caught by the same
 *    catch as connection failures → `reason:"network"`. A lying proxy was
 *    diagnosed as flaky networking (webSearch.js in this very repo already
 *    kept a "parse" class — two taxonomies for one job). Now: "parse".
 * 2. The chatWithTools loop's deadline return hand-rolled a shape without
 *    url/errorBody/finishReason/usage that failure() (every other path)
 *    carries — the "shape-stable AiResult" typedef was true everywhere
 *    except the one path an operator reads during an outage.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { chatCompletion, chatWithTools } = require("../src/core/ai");

const AI_CFG = { apiKey: "test-key", baseUrl: "https://ai.example/v1", model: "test-model" };

describe("#469 (F1-7): a malformed 200 body is PARSE, not network", () => {
  it("garbage JSON on HTTP 200 → reason 'parse' with the status kept", async () => {
    const r = await chatCompletion(AI_CFG, {
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token '<' … is not valid JSON");
        },
      }),
    });
    assert.equal(r.ok, false);
    assert.equal(
      r.reason,
      "parse",
      'old code reported the lying proxy as "network" — operators chased ghosts',
    );
    assert.equal(r.status, 200, "the transport WORKED — the status proves it");
    assert.match(r.error, /not valid JSON|body is not JSON/i);
  });

  it("an abort WHILE reading the body stays 'timeout'", async () => {
    const controller = new AbortController();
    controller.abort(); // already fired when the body read starts
    const r = await chatCompletion(AI_CFG, {
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("This operation was aborted");
        },
      }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "timeout", "an abort is not a parse failure");
  });

  it("a transport-level failure is still 'network' (parity)", async () => {
    const r = await chatCompletion(AI_CFG, {
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "network");
  });
});

describe("#469 (F1-7): the loop timeout returns the FULL failure shape", () => {
  it("deadline hit between rounds carries url/errorBody/finishReason/usage", async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const r = await chatWithTools(AI_CFG, {
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      // One tool round eats the deadline, so the NEXT round-start check
      // takes the early return (the previously mis-shaped path).
      executeTool: async () => {
        await sleep(120);
        return "done";
      },
      maxToolRounds: 3,
      timeoutMs: 50,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "sleepy", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {},
        }),
      }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "timeout");
    // The typedef promises ONE shape for AiResult. Every other failure path
    // runs through failure() and carries these keys; the loop's deadline
    // return used to hand-roll a short shape.
    for (const key of ["url", "errorBody", "finishReason", "usage", "status", "durationMs"]) {
      assert.ok(key in r, `failure shape must carry ${key} (typedef) — got ${JSON.stringify(Object.keys(r))}`);
    }
    assert.equal(r.url, null);
    assert.equal(r.errorBody, null);
    assert.equal(r.finishReason, null);
    assert.equal(r.usage, null);
  });
});
