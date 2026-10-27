import { loadBundledModule } from "./load-bundled-module.mjs";

/** Real transcript controller with only its DOM node factory replaced. */
export async function transcriptHarness(t) {
 const loaded = await loadBundledModule({ entry: "webview/transcript/controller.ts", platform: "browser" });
 t.after(loaded.dispose);
 const state = { messages: [], streamingIndex: 0, omittedMessageCount: 0, timeContext: { locale: "en" } };
 const children = [];
 const builds = [];
 const effects = [];
 const container = {
  insertBefore(node, reference) {
   const existing = children.indexOf(node);
   if (existing >= 0) children.splice(existing, 1);
   const index = reference === null ? children.length : children.indexOf(reference);
   children.splice(index < 0 ? children.length : index, 0, node);
  },
  removeChild(node) { const index = children.indexOf(node); if (index >= 0) children.splice(index, 1); },
 };
 const controller = new loaded.module.TranscriptController({
  state, container,
  createNode(entry, previous, context) {
   const node = { ...entry, message: context.byKey.get(entry.key), omitted: context.omitted };
   builds.push(node);
   return node;
  },
  patchStreaming: () => undefined,
  scheduleRender: () => effects.push("render"), scheduleMeasure: () => effects.push("measure"),
  pinToBottom: () => effects.push("pin"), syncJumpButton: () => effects.push("jump"),
  followFresh: () => effects.push("follow"), clearMediaRefusals: () => effects.push("media"), now: () => 1000,
 });
 return { controller, state, children, builds, effects };
}
