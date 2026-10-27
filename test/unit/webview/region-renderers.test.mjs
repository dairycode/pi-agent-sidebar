import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

test("header title preserves trimming, context stripping, title seed and truncation", async (t) => {
 const loaded = await loadBundledModule({ entry: "webview/ui/headerRenderer.ts" });
 t.after(loaded.dispose);
 const { sessionTitle, connectionLabel } = loaded.module;
 const state = { state: {}, messages: [], titleSeed: "", workspaceName: "workspace" };
 assert.equal(sessionTitle(state), "Untitled");
 state.state.sessionName = "  named  ";
 assert.equal(sessionTitle(state), "named");
 state.state.sessionName = " ";
 state.messages = [{ role: "user", content: [{ type: "text", text: "fallback\nquestion" }] }];
 assert.equal(sessionTitle(state), "fallback question");
 state.titleSeed = "<pi-context>hidden selection</pi-context>  real\n prompt";
 assert.equal(sessionTitle(state), "real prompt");
 state.titleSeed = "x".repeat(80);
 assert.equal(sessionTitle(state), `${"x".repeat(53)}…`);
 assert.equal(connectionLabel({ connection: "ready", busy: true }), "Pi is working");
 assert.equal(connectionLabel({ connection: "no-workspace" }), "Workspace required");
});

test("runtime rows preserve unknown context, zero cost and reported token counts", async (t) => {
 const loaded = await loadBundledModule({ entry: "webview/ui/runtimeRenderer.ts" });
 t.after(loaded.dispose);
 const { usageRows } = loaded.module;
 assert.deepEqual(usageRows(undefined), [["Usage", "Not reported by pi yet"]]);
 const rows = usageRows({ contextUsage: { tokens: null, percent: null, contextWindow: 200000 }, cost: 0, totalMessages: 0, toolCalls: 0, tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, total: 19 } }, "en");
 assert.deepEqual(rows[0], ["Context", "Unavailable until the next response"]);
 assert.ok(rows.some(([label, value]) => label === "Total tokens" && value === "19"));
 assert.ok(rows.some(([label]) => label === "Cost"));
 assert.ok(rows.some(([label, value]) => label === "Messages" && value === "0"));
});

test("composer renderer preserves input caching, pending-submit and busy button behavior", async (t) => {
 const loaded = await loadBundledModule({ entry: "webview/composer/renderer.ts" });
 t.after(loaded.dispose);
 const node = () => ({ hidden: true, disabled: false, textContent: "", value: "", style: {}, childNodes: [], classList: { toggle() {}, remove() {}, add() {} }, setAttribute() {}, replaceChildren() {}, querySelector: () => ({ className: "" }) });
 const elements = Object.fromEntries(["input", "attachmentList", "promptEditor", "promptHighlights", "modelSelect", "modelSelectValue", "thinkingSelect", "thinkingSelectValue", "attachButton", "commandButton", "composerStatusRow", "sendButton", "sendHint", "composer", "composerTools"].map((key) => [key, node()]));
 let writes = 0;
 elements.promptHighlights.replaceChildren = () => { writes++; };
 elements.input.clientWidth = 100;
 elements.input.scrollLeft = 2;
 elements.input.scrollTop = 3;
 const state = { state: {}, commands: [], attachments: [], connection: "ready", busy: false, models: [], thinkingLevels: ["off"] };
 let pending = false;
 const renderer = loaded.module.createComposerRenderer({ elements, state,
  composer: { managedReferences: () => [], hasPendingReferences: false }, selectors: { syncSelected() {}, close() {} },
  isSubmitPending: () => pending, showSendHint() {}, hideSendHint() {}, dismissPopups() {}, scheduleRender() {}, post() {}, createCodicon() {},
 });
 renderer.renderComposerHighlights();
 renderer.renderComposerHighlights();
 assert.equal(writes, 1, "unchanged composer must not rebuild highlights");
 assert.equal(elements.promptHighlights.style.transform, "translate(-2px, -3px)");
 renderer.renderSendButton();
 assert.equal(elements.sendButton.disabled, false);
 pending = true;
 renderer.renderSendButton();
 assert.equal(elements.sendButton.disabled, true);
 state.busy = true;
 renderer.renderSendButton();
 assert.equal(elements.sendButton.disabled, false, "stop remains available while busy");
 assert.equal(elements.sendButton.title, "Stop pi");
 state.connection = "error";
 renderer.renderAvailability();
 renderer.renderSendButton();
 assert.equal(elements.input.disabled, true);
 assert.equal(elements.sendButton.disabled, true);
 renderer.renderStatusRow();
 assert.equal(elements.composerStatusRow.hidden, false);
});
