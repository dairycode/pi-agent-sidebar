import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function setup(t) {
 const loaded = await loadBundledModule({ entry: "webview/rpcEventReducer.ts" });
 t.after(loaded.dispose);
 const calls = [];
 const ui = { busy: false, messages: [], streamingIndex: 0, queue: { steering: [], followUp: [] } };
 const effect = (name) => (...args) => calls.push([name, ...args]);
 const options = {
  ui, liveTools: new Map(), toolResults: new Map(),
  streamingPlayback: { isActive: false, completeImmediately: () => undefined, start: (message) => message, resume: (message) => message, finish: effect("finish"), applyDelta: effect("delta"), updateTarget: effect("target") },
  streamingUsage: { startAgentRun: effect("run"), beginCall: effect("call"), applyUpdate: () => false, commitCall: () => false, addToolUsage: () => false },
  scheduleRender: effect("render"), scheduleTranscriptRender: effect("transcript"), scheduleAdvance: effect("advance"), renderRuntimeMeta: effect("usage"),
  settleStreamingMessage: effect("settle"), noteUserMessage: effect("user"), hasEquivalentTail: (message) => ui.messages.at(-1) === message,
  refreshExpandedTool: effect("tool"), announce: effect("announce"), showToast: effect("toast"), friendlyToolName: (name) => name,
  setExtensionStatus: effect("status"), clearExtensionStatus: effect("clearStatus"), setExtensionWidget: effect("widget"),
 };
 return { reducer: new loaded.module.RpcEventReducer(options), options, calls, ui };
}

test("assistant start schedules playback, not a full render", async (t) => {
 const { reducer, calls, ui } = await setup(t);
 const message = { role: "assistant", content: [] };
 reducer.reduce({ type: "message_start", message });
 assert.equal(ui.streamingMessage, message);
 assert.deepEqual(calls, [["call"], ["advance"]]);
});

test("user echoes preserve text block newlines and exclude thinking", async (t) => {
 const { reducer, calls, ui } = await setup(t);
 const message = { role: "user", content: [{ type: "text", text: "one" }, { type: "thinking", thinking: "hidden" }, { type: "text", text: "two" }] };
 reducer.reduce({ type: "message_start", message });
 reducer.reduce({ type: "message_start", message });
 assert.equal(ui.messages.length, 1);
 assert.deepEqual(calls[0], ["user", "one\ntwo"]);
});

test("widgets strip ANSI and orphan SGR without removing line structure", async (t) => {
 const { reducer, calls } = await setup(t);
 reducer.reduce({ type: "extension_ui_request", method: "setWidget", widgetKey: "test", widgetLines: ["\u001b[31mred\u001b[0m", "[32mgreen[0m", "one\ntwo", " ", 42] });
 assert.deepEqual(calls[0], ["widget", "test", ["red", "green", "one\ntwo"]]);
 reducer.reduce({ type: "extension_ui_request", method: "setWidget", widgetKey: "test", widgetLines: [] });
 assert.deepEqual(calls.at(-2), ["widget", "test", []]);
});

test("tool chunks rebuild once then refresh only the expanded body", async (t) => {
 const { reducer, options, calls } = await setup(t);
 reducer.reduce({ type: "tool_execution_start", toolCallId: "id", toolName: "read", args: { path: "file" } });
 reducer.reduce({ type: "tool_execution_update", toolCallId: "id", partialResult: "first" });
 reducer.reduce({ type: "tool_execution_update", toolCallId: "id", partialResult: "second" });
 assert.deepEqual(calls, [["transcript"], ["transcript"], ["tool", "id"]]);
 reducer.reduce({ type: "tool_execution_end", toolCallId: "id", result: "done" });
 assert.equal(options.liveTools.get("id").revision, 2);
 assert.deepEqual(options.liveTools.get("id").args, { path: "file" });
 assert.equal(options.liveTools.get("id").status, "success");
});

test("reload deltas resume while legacy cumulative events start playback", async (t) => {
 const { reducer, options, calls, ui } = await setup(t);
 const message = { role: "assistant", content: "partial" };
 options.streamingPlayback.resume = (value) => { calls.push(["resume"]); return value; };
 reducer.reduce({ type: "message_update", message, assistantMessageEvent: {} });
 assert.equal(ui.streamingMessage, message);
 assert.deepEqual(calls, [["resume"], ["advance"]]);
 options.streamingPlayback.isActive = true;
 reducer.reduce({ type: "message_update", assistantMessageEvent: {} });
 assert.equal(calls.at(-2)[0], "delta");
});

test("tool results deduplicate and queue/status events keep their original effects", async (t) => {
 const { reducer, ui, calls } = await setup(t);
 const message = { role: "toolResult", toolCallId: "id", content: "done" };
 reducer.reduce({ type: "message_end", message });
 reducer.reduce({ type: "message_end", message });
 assert.equal(ui.messages.length, 1);
 reducer.reduce({ type: "queue_update", steering: ["one", 2], followUp: ["two"] });
 assert.deepEqual(ui.queue, { steering: ["one"], followUp: ["two"] });
 reducer.reduce({ type: "compaction_start" });
 assert.equal(ui.busy, true);
 reducer.reduce({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 });
 assert.deepEqual(calls.at(-2), ["status", "retry", "Retrying (1/3)..."]);
 reducer.reduce({ type: "agent_settled" });
 assert.equal(ui.busy, false);
});
