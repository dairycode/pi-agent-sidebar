(() => {
 const sent = [];
 const errors = [];
 // Chrome's virtual-time dump does not reliably produce compositor frames.
 // Keep the real FrameCoordinator, but drive its browser clock with timers.
 window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 16);
 window.cancelAnimationFrame = (handle) => clearTimeout(handle);
 window.addEventListener("error", (event) => { errors.push(event.message); document.body.dataset.testError = event.message; });
 window.addEventListener("unhandledrejection", (event) => { document.body.dataset.testError = String(event.reason); });
 window.acquireVsCodeApi = () => ({
  postMessage(message) { sent.push(message); if (message.type === "ready") setTimeout(() => void scenario(), 10); },
  getState: () => undefined, setState() {},
 });
 const get = (id) => document.getElementById(id);
 const wait = () => new Promise((resolve) => setTimeout(resolve, 150));
 const check = (condition, message) => { if (!condition) throw new Error(message); };
 const post = async (data) => { window.dispatchEvent(new MessageEvent("message", { data, source: null })); await wait(); };
 const rpc = (event) => post({ type: "rpcEvent", event });
 const prompt = { role: "user", timestamp: 1000, content: [{ type: "text", text: "first question" }] };
 const snapshot = (id, messages = [prompt]) => ({ type: "snapshot", state: { sessionId: id }, messages, models: [], thinkingLevels: ["off"], commands: [], workspaceName: "workspace", stats: { cost: 0.1, contextUsage: { tokens: null, percent: null, contextWindow: 200000 } } });
 async function scenario() {
  try {
   check(sent.filter((item) => item.type === "ready").length === 1, "ready handshake exactly once");
   await post({ type: "bootstrap", phase: "starting", workspaceName: "workspace" });
   await post(snapshot("one"));
   await post({ type: "connection", phase: "ready" });
   check(!get("prompt-input").disabled, "composer enabled after ready");
   check(get("messages").textContent.includes("first question"), "snapshot rendered");
   const original = get("messages").querySelector(".user-message");
   await post(snapshot("one", [JSON.parse(JSON.stringify(prompt))]));
   check(get("messages").querySelector(".user-message") === original, "unchanged snapshot preserves DOM identity");
   get("runtime-meta").click();
   check(get("usage-panel").textContent.includes("Unavailable until the next response"), "null context remains unavailable");
   get("runtime-meta").click();
   await rpc({ type: "extension_ui_request", method: "setWidget", widgetKey: "test", widgetLines: ["\u001b[31mred\u001b[0m"] });
   check(get("widget-area").textContent === "red", "widget ANSI cleanup");
   await post({ type: "setComposerText", text: "draft" });
   get("new-session-button").click();
   const action = sent.findLast((item) => item.type === "newSession");
   check(action?.actionId, "new session action retains ID");
   await post({ type: "actionResult", actionId: action.actionId, ok: true, cancelled: true });
   check(get("prompt-input").value === "draft", "cancelled action preserves draft");
   get("history-button").click();
   await post({ type: "sessionList", sessions: [{ title: "Earlier", excerpt: "example", path: "/opaque/session", active: false, createdAt: 1000 }] });
   get("session-list").querySelector(".session-open").click();
   check(sent.some((item) => item.type === "switchSession" && item.path === "/opaque/session"), "session path forwarded");
   get("fork-session-button").click();
   await post({ type: "forkCandidates", candidates: [{ entryId: "opaque-entry", text: "first question", timestamp: 1000 }] });
   get("fork-search").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
   check(!sent.some((item) => item.type === "forkSession"), "fork has no implicit default");
   get("fork-search").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
   get("fork-search").value = "no match";
   get("fork-search").dispatchEvent(new Event("input"));
   get("fork-search").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
   check(!sent.some((item) => item.type === "forkSession"), "filter cannot submit an invisible fork row");
   get("fork-search").value = "";
   get("fork-search").dispatchEvent(new Event("input"));
   get("fork-search").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
   get("fork-search").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
   check(sent.some((item) => item.type === "forkSession" && item.entryId === "opaque-entry"), "fork entry forwarded");
   await post({ type: "forkCandidates", candidates: [{ entryId: "late", text: "late reply" }] });
   check(get("fork-panel").hidden && get("fork-list").children.length === 0, "late fork reply stays hidden");
   await post({ type: "setComposerText", text: "" });
   await rpc({ type: "agent_start" });
   const reply = { role: "assistant", timestamp: 2000, content: [{ type: "thinking", thinking: "reasoning text" }, { type: "text", text: "streamed answer" }, { type: "toolCall", id: "tool-id", name: "bash", arguments: { command: "echo ok" } }] };
   await rpc({ type: "message_start", message: { ...reply, content: [] } });
   await rpc({ type: "message_update", message: reply });
   await rpc({ type: "message_end", message: reply });
   await rpc({ type: "agent_settled" });
   await wait();
   check(get("messages").textContent.includes("streamed answer"), "streaming settles visibly");
   await rpc({ type: "tool_execution_start", toolCallId: "tool-id", toolName: "bash", args: { command: "echo ok" } });
   await rpc({ type: "tool_execution_update", toolCallId: "tool-id", partialResult: { content: [{ type: "text", text: "first output" }] } });
   const tool = get("messages").querySelector('.tool-call[data-tool-key="tool-id"]');
   check(tool, "tool card rendered");
   tool.click();
   await rpc({ type: "tool_execution_update", toolCallId: "tool-id", partialResult: { content: [{ type: "text", text: "updated output" }] } });
   check(tool.classList.contains("expanded") && tool.textContent.includes("updated output"), "expanded tool refreshes in place");
   const thinking = get("messages").querySelector(".thinking-block");
   thinking.click();
   await wait();
   check(get("messages").querySelector(".thinking-block").classList.contains("is-expanded"), "thinking expands through controller state");
   await post(snapshot("two", [{ role: "user", content: "new session question", timestamp: 3000 }]));
   check(!get("messages").textContent.includes("streamed answer"), "session switch clears old reply");
   check(get("widget-area").hidden, "session switch clears widgets");
   const longHistory = Array.from({ length: 80 }, (_, index) => ({ role: "user", content: `history message ${index}`, timestamp: 4000 + index }));
   await post(snapshot("three", longHistory));
   await wait();
   const viewport = get("transcript");
   viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
   viewport.scrollTop = 0;
   viewport.dispatchEvent(new Event("scroll"));
   await wait();
   check(get("jump-to-bottom").classList.contains("is-visible"), "reader scroll detaches from bottom");
   get("jump-to-bottom").click();
   await wait();
   check(!get("jump-to-bottom").classList.contains("is-visible"), "jump reattaches bottom following");
   await post({ type: "connection", phase: "error", detail: "Disconnected" });
   check(get("prompt-input").disabled && !get("connection-banner").hidden, "disconnect disables composer and shows banner");
   check(errors.length === 0, "no runtime errors");
   document.body.dataset.testComplete = "true";
  } catch (error) { document.body.dataset.testError = errors[0] || error.stack || String(error); }
 }
})();
