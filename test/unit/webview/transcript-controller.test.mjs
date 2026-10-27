import assert from "node:assert/strict";
import test from "node:test";
import { transcriptHarness } from "../../helpers/transcript-harness.mjs";

const message = (role, text, timestamp) => ({ role, content: [{ type: "text", text }], timestamp });

test("snapshot preserves buffered reply and session switch drops it and disclosures", async (t) => {
 const { controller, state, effects } = await transcriptHarness(t);
 const reply = message("assistant", "partial", 2);
 state.streamingMessage = controller.playback.start(reply);
 controller.expandedThinkingKeys.add("old-thinking-0");
 controller.adoptSnapshot([message("user", "question", 1)]);
 controller.reconcileSnapshot(false, true);
 assert.equal(controller.playback.isActive, true);
 assert.equal(state.streamingIndex, 1);
 controller.adoptSnapshot([message("user", "new session", 3)]);
 controller.reconcileSnapshot(true, false);
 assert.equal(state.streamingMessage, undefined);
 assert.equal(controller.playback.isActive, false);
 assert.equal(controller.expandedThinkingKeys.size, 0);
 assert.ok(effects.includes("media"));
 assert.ok(effects.includes("follow"));
});

test("a final reply listed in snapshot is not duplicated", async (t) => {
 const { controller, state } = await transcriptHarness(t);
 const reply = message("assistant", "answer", 2);
 state.streamingMessage = controller.playback.start(reply);
 controller.playback.finish(reply);
 controller.adoptSnapshot([message("user", "question", 1), { ...reply }]);
 controller.reconcileSnapshot(false, false);
 assert.equal(state.messages.length, 2);
 assert.equal(state.streamingMessage, undefined);
});

test("interrupt keeps reply ahead of follow-up and marks only running tools failed", async (t) => {
 const { controller, state } = await transcriptHarness(t);
 state.messages = [message("user", "question", 1), message("user", "follow-up", 3)];
 state.streamingIndex = 1;
 state.streamingMessage = controller.playback.start(message("assistant", "answer", 2));
 controller.liveTools.set("running", { status: "running", revision: 0 });
 controller.liveTools.set("done", { status: "success", revision: 1 });
 controller.interrupt("Disconnected");
 assert.deepEqual(state.messages.map((value) => value.timestamp), [1, 2, 3]);
 assert.equal(state.messages[1].stopReason, "aborted");
 assert.equal(controller.liveTools.get("running").status, "error");
 assert.equal(controller.liveTools.get("running").result.content[0].text, "Disconnected");
 assert.equal(controller.liveTools.get("done").status, "success");
});

test("progressive transcript keeps omitted count stable and hides empty streaming shell", async (t) => {
 const { controller, state, children } = await transcriptHarness(t);
 state.messages = Array.from({ length: 160 }, (_, index) => message("user", String(index), index + 1));
 state.omittedMessageCount = 20;
 state.streamingMessage = { role: "assistant", content: [] };
 controller.render();
 assert.equal(children.find((node) => node.key === "history-omitted").omitted, 30);
 assert.equal(children.filter((node) => node.message).length, 40);
 for (let index = 0; index < 4; index++) controller.render();
 assert.equal(children.filter((node) => node.message).length, 150);
 assert.equal(children.some((node) => node.message?.role === "assistant"), false);
});
