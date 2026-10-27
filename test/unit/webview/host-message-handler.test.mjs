import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

test("host handler forwards every protocol variant exactly once", async (t) => {
 const loaded = await loadBundledModule({ entry: "webview/hostMessageHandler.ts" });
 t.after(loaded.dispose);
 const types = ["bootstrap", "snapshot", "rpcEvent", "actionResult", "sessionList", "forkCandidates", "capabilities", "commandList", "workspaceFileList", "mediaResolved", "attachments", "composerReferences", "notice", "connection", "setComposerText"];
 const calls = [];
 const options = Object.fromEntries(types.map((type) => [`on${type[0].toUpperCase()}${type.slice(1)}`, (value) => calls.push([type, value])]));
 const handler = new loaded.module.HostMessageHandler(options);
 for (const type of types) {
  const message = { type, event: { type: "agent_start" }, text: "draft", cancelled: true };
  handler.handle(message);
  assert.deepEqual(calls.pop(), [type, type === "rpcEvent" ? message.event : type === "setComposerText" ? message.text : message]);
  assert.equal(calls.length, 0);
 }
});
