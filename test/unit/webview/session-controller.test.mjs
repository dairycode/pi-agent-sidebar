import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function setup(t) {
 const controllerModule = await loadBundledModule({ entry: "webview/session/controller.ts" });
 const stateModule = await loadBundledModule({ entry: "webview/app/state.ts" });
 t.after(controllerModule.dispose); t.after(stateModule.dispose);
 const state = stateModule.module.createUiState();
 const calls = [];
 const controller = new controllerModule.module.SessionController({
  state,
  transcript: {
   adoptSnapshot: (messages) => { calls.push(["adopt", state.messages]); state.messages = messages; },
   reconcileSnapshot: (...args) => calls.push(["reconcile", ...args]),
   interrupt: (detail) => calls.push(["interrupt", detail]),
  },
  usage: { reset: () => calls.push(["reset"]) },
  clearUnansweredSubmit: () => calls.push(["submit", state.clockSkewMs]),
  cancelFollow: () => calls.push(["cancel"]), clearExtensionUi: () => calls.push(["clear"]),
  scheduleRender: () => calls.push(["render"]), announce: (text) => calls.push(["announce", text]), now: () => 100,
 });
 return { controller, state, calls };
}
function snapshot(id, extra = {}) {
 return { type: "snapshot", state: { sessionId: id }, messages: [], models: [], thinkingLevels: [], commands: [], workspaceName: "workspace", ...extra };
}

test("session snapshot updates clock before submit recovery and preserves optional capability state", async (t) => {
 const { controller, state, calls } = await setup(t);
 state.capabilities.clone = false;
 const old = state.messages;
 controller.applySnapshot(snapshot("first", { timeContext: { locale: "en", hostNowMs: 150 } }));
 assert.equal(state.capabilities.clone, false);
 assert.equal(state.clockSkewMs, 50);
 assert.deepEqual(calls[0], ["adopt", old]);
 assert.deepEqual(calls[2], ["submit", 50]);
 assert.deepEqual(calls[3], ["reconcile", false, false]);
 assert.equal(calls.some(([name]) => name === "clear"), false);
 calls.length = 0;
 controller.applySnapshot(snapshot("second", { state: { sessionId: "second", isStreaming: true } }));
 assert.equal(state.busy, true);
 assert.deepEqual(calls.slice(-3), [["cancel"], ["clear"], ["render"]]);
});

test("disconnect settles transcript and clears transient state, ready clears the banner only", async (t) => {
 const { controller, state, calls } = await setup(t);
 state.busy = true;
 controller.applyConnection("error", "lost");
 assert.equal(state.busy, false);
 assert.deepEqual(calls, [["cancel"], ["interrupt", "lost"], ["clear"], ["announce", "lost"], ["render"]]);
 calls.length = 0;
 controller.applyConnection("ready", "old detail");
 assert.equal(state.connectionDetail, "");
 assert.deepEqual(calls, [["announce", "Pi is ready"], ["render"]]);
});
