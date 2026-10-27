import type { PiMessage } from "../../shared/protocol.js";
import type { TranscriptController, MessageRenderContext } from "./controller.js";
import type { TranscriptEntry } from "./transcriptView.js";
import type { ScrollAnchor } from "./scrollAnchor.js";
import { assistantMessageSections, messageHtml, streamingMarkdownParts, toolBodyHtml } from "./renderer.js";
import { enhanceMermaidBlocks } from "./mermaid.js";
import { WORKSPACE_PATH_PATTERN } from "./workspacePaths.js";

export interface TranscriptDomOptions {
 controller(): TranscriptController;
 state: { streamingMessage?: PiMessage };
 anchor: Pick<ScrollAnchor, "detach">;
 sanitizedNodes(html: string): Node[];
 createCodicon(name: string): HTMLElement;
 bindImageReflow(root: ParentNode): void;
 enhanceImages(root: ParentNode): void;
 scheduleMeasure(): void;
}

/** Materializes transcript nodes; state and reconciliation stay in TranscriptController. */
export function createTranscriptDom(options: TranscriptDomOptions) {
 const { state: ui, sanitizedNodes, createCodicon } = options;
 const streamingSectionSource = new WeakMap<HTMLElement, string>();

 function patchStreamingMessage(slot: Element, message: PiMessage, resultMap: ReadonlyMap<string, PiMessage>, messageKey: string): Element | undefined {
  const { liveTools, expandedThinkingKeys } = options.controller();
  const sections = assistantMessageSections(message, resultMap, liveTools, true, messageKey, true, expandedThinkingKeys);
  const host = slot.querySelector(":scope > .message");
  if (!host || !host.classList.contains("assistant-message")) return undefined;
  const snapshot = captureExpandableState(slot);
  const oldSections = Array.from(host.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
  const previous = new Map<string, HTMLElement>();
  for (const element of oldSections) {
   const key = element.dataset.sectionKey;
   if (key) previous.set(key, element);
  }
  const freshNodes: Element[] = [];
  for (const section of sections) {
   const old = previous.get(section.key);
   if (old && old.dataset.sectionHash === section.hash) {
    // Streaming hashes sample edges; equal-length corrections still need a full text comparison.
    if (!section.streamUpdate || streamingSectionSource.get(old) === section.streamUpdate.text) continue;
   }
   if (old && section.streamUpdate && appendStreamingText(old, section)) continue;
   const nodes = sanitizedNodes(section.html);
   if (nodes.length !== 1 || !(nodes[0] instanceof Element)) return undefined;
   const fresh = nodes[0] as HTMLElement;
   if (section.streamUpdate) materializeStreamingText(fresh, section.streamUpdate);
   if (old) host.replaceChild(fresh, old);
   else host.append(fresh);
   if (!section.streamUpdate) freshNodes.push(fresh);
  }
  const wanted = new Set(sections.map((section) => section.key));
  for (const element of oldSections) {
   const key = element.dataset.sectionKey;
   if (key && !wanted.has(key)) element.remove();
   else if (!key) return undefined;
  }
  for (const node of freshNodes) enhanceRenderedNodes(node);
  applyExpandableState(host, snapshot);
  return slot;
 }

 function materializeStreamingText(root: HTMLElement, update: StreamUpdate): void {
  const target = update.selector ? root.querySelector<HTMLElement>(update.selector) : root;
  if (!target) return;
  streamingSectionSource.set(root, update.text);
  if (update.format === "plain") { target.replaceChildren(document.createTextNode(update.text)); return; }
  materializeStreamingMarkdown(root, target, update.text);
 }
 function materializeStreamingMarkdown(root: HTMLElement, target: HTMLElement, text: string): void {
  const parts = streamingMarkdownParts(text);
  const stableNodes = sanitizedNodes(parts.stableHtml);
  const active = document.createElement("div");
  active.className = "streaming-markdown-active";
  active.replaceChildren(...sanitizedNodes(parts.activeHtml));
  target.replaceChildren(...stableNodes, active);
  root.dataset.streamStableLength = String(parts.stableSourceLength);
  root.dataset.streamAppendMode = parts.appendMode;
  enhanceStableStreamingNodes(stableNodes);
 }
 function appendStreamingText(root: HTMLElement, section: { hash: string; streamUpdate?: StreamUpdate }): boolean {
  const update = section.streamUpdate;
  if (!update) return false;
  const target = update.selector ? root.querySelector<HTMLElement>(update.selector) : root;
  if (!target) return false;
  const previousLength = Number(root.dataset.streamLength);
  if (!Number.isSafeInteger(previousLength) || previousLength < 0 || update.text.length < previousLength) return false;
  if (update.format === "plain") {
   const textNode = target.firstChild;
   if (!(textNode instanceof Text) || target.childNodes.length !== 1 || textNode.data.length !== previousLength) return false;
   textNode.appendData(update.text.slice(previousLength));
  } else {
   const active = Array.from(target.children).find((child) => child.classList.contains("streaming-markdown-active"));
   const stableLength = Number(root.dataset.streamStableLength);
   if (!(active instanceof HTMLElement) || !Number.isSafeInteger(stableLength)) {
    materializeStreamingMarkdown(root, target, update.text);
   } else {
    const suffix = update.text.slice(previousLength);
    const mode = root.dataset.streamAppendMode;
    let didAppend = false;
    if (mode === "plain") didAppend = suffix.length > 0 && /^[\p{L}\p{M}\p{N}\p{Zs}]+$/u.test(suffix) && appendToLastTextNode(active, suffix);
    else if (mode === "code") didAppend = suffix.length > 0 && !/[\r\n`~]/u.test(suffix) && appendToCodeTail(active, suffix);
    if (didAppend) {
     root.dataset.streamLength = String(update.text.length);
     root.dataset.sectionHash = section.hash;
     return true;
    }
    const parts = streamingMarkdownParts(update.text, stableLength);
    if (parts.reset) materializeStreamingMarkdown(root, target, update.text);
    else {
     const stableNodes = sanitizedNodes(parts.stableHtml);
     if (stableNodes.length > 0) { active.before(...stableNodes); enhanceStableStreamingNodes(stableNodes); }
     active.replaceChildren(...sanitizedNodes(parts.activeHtml));
     root.dataset.streamStableLength = String(parts.stableSourceLength);
     root.dataset.streamAppendMode = parts.appendMode;
    }
   }
  }
  root.dataset.streamLength = String(update.text.length);
  root.dataset.sectionHash = section.hash;
  streamingSectionSource.set(root, update.text);
  return true;
 }
 function enhanceStableStreamingNodes(nodes: Node[]): void {
  for (const node of nodes) if (node instanceof Element) enhanceRenderedNodes(node);
 }

 function createMessageNode(entry: TranscriptEntry, previous: Element | undefined, context: MessageRenderContext): Element {
  if (entry.key === "history-omitted") {
   const node = document.createElement("div");
   node.className = "history-omitted";
   node.textContent = `${context.omitted} earlier messages omitted`;
   return node;
  }
  const separator = context.separatorLabels.get(entry.key);
  if (separator !== undefined) {
   const node = document.createElement("div");
   node.className = "day-separator";
   node.setAttribute("role", "separator");
   node.textContent = separator;
   return node;
  }
  const message = context.byKey.get(entry.key);
  if (!message) throw new Error(`No message for transcript key ${entry.key}`);
  if (previous && message === ui.streamingMessage) {
   const patched = patchStreamingMessage(previous, message, context.resultMap, entry.key);
   if (patched) { applyMessageBoundaryClasses(patched, message); return patched; }
  }
  const isStreaming = message === ui.streamingMessage;
  const { liveTools, expandedThinkingKeys } = options.controller();
  const html = messageHtml(message, context.resultMap, liveTools, isStreaming, entry.key, expandedThinkingKeys);
  const node = document.createElement("div");
  node.className = "message-slot";
  applyMessageBoundaryClasses(node, message);
  node.replaceChildren(...sanitizedNodes(html));
  if (previous) applyExpandableState(node, captureExpandableState(previous));
  if (!isStreaming) enhanceRenderedNodes(node);
  return node;
 }

 function applyExpandableState(node: Element, snapshot: ExpandableSnapshot): void {
  if (snapshot.tools.size === 0 && snapshot.skills.size === 0) return;
  for (const tool of node.querySelectorAll<HTMLElement>(".tool-call.expandable[data-tool-key]")) {
   const key = tool.dataset.toolKey;
   if (key && snapshot.tools.has(key)) { ensureToolBodyMounted(tool); setExpandedState(tool, true); }
  }
  for (const skill of node.querySelectorAll<HTMLElement>(".skill-block[data-skill-key]")) {
   const key = skill.dataset.skillKey;
   if (key && snapshot.skills.has(key)) setExpandedState(skill, true);
  }
 }
 function toggleExpandable(element: HTMLElement): void {
  if (window.getSelection()?.toString()) return;
  options.anchor.detach();
  const isThinking = element.dataset.expandable === "thinking";
  const isExpanding = !element.classList.contains(isThinking ? "is-expanded" : "expanded");
  if (isThinking) options.controller().setThinkingVisibility(element, isExpanding);
  else {
   if (isExpanding && element.dataset.expandable === "tool") ensureToolBodyMounted(element);
   setExpandedState(element, isExpanding);
  }
  options.scheduleMeasure();
 }
 function ensureToolBodyMounted(element: HTMLElement): void {
  if (element.dataset.toolBody !== "lazy") return;
  const id = element.dataset.toolKey;
  if (!id) return;
  const { liveTools, toolResults } = options.controller();
  const html = toolBodyHtml(toolResults.get(id), liveTools.get(id));
  if (!html) return;
  element.append(...sanitizedNodes(html));
  element.dataset.toolBody = "mounted";
 }
 function refreshExpandedToolBody(section: HTMLElement, toolId: string): void {
  const { liveTools, toolResults } = options.controller();
  const html = toolBodyHtml(toolResults.get(toolId), liveTools.get(toolId));
  if (!html) return;
  for (const child of [...section.children]) {
   if (child.classList.contains("tool-output") || child.classList.contains("tool-diff")) child.remove();
  }
  section.append(...sanitizedNodes(html));
 }
 function enhanceRenderedNodes(root: Element): void {
  enhanceCodeBlocks(root);
  enhanceMermaidBlocks(root);
  linkifyWorkspacePaths(root);
  options.bindImageReflow(root);
  options.enhanceImages(root);
 }
 function enhanceCodeBlocks(root: ParentNode): void {
  for (const pre of root.querySelectorAll("pre")) {
   if (pre.closest(".tool-output") || pre.parentElement?.classList.contains("code-block")) continue;
   const wrapper = document.createElement("div");
   wrapper.className = "code-block";
   pre.replaceWith(wrapper);
   wrapper.append(pre);
   const button = document.createElement("button");
   button.type = "button";
   button.className = "copy-code-button icon-button";
   button.title = "Copy code";
   button.setAttribute("aria-label", "Copy code");
   button.setAttribute("data-copy-code", "true");
   button.append(createCodicon("copy"));
   wrapper.append(button);
  }
 }
 return { createMessageNode, patchStreamingMessage, toggleExpandable, refreshExpandedToolBody };
}

interface StreamUpdate { selector?: string; text: string; format: "markdown" | "plain"; }
interface ExpandableSnapshot { tools: Set<string>; skills: Set<string>; }
function captureExpandableState(previous: Element): ExpandableSnapshot {
 const tools = new Set<string>();
 for (const tool of previous.querySelectorAll<HTMLElement>(".tool-call.expandable.expanded[data-tool-key]")) {
  if (tool.dataset.toolKey) tools.add(tool.dataset.toolKey);
 }
 const skills = new Set<string>();
 for (const skill of previous.querySelectorAll<HTMLElement>(".skill-block[data-skill-key]")) {
  if (skill.dataset.skillKey && skill.classList.contains("expanded")) skills.add(skill.dataset.skillKey);
 }
 return { tools, skills };
}
function setExpandedState(element: HTMLElement, expanded: boolean): void {
 const thinking = element.dataset.expandable === "thinking";
 element.classList.toggle(thinking ? "is-expanded" : "expanded", expanded);
 element.setAttribute("aria-expanded", expanded ? "true" : "false");
 if (thinking) element.setAttribute("aria-label", `Reasoning, click to ${expanded ? "collapse" : "expand"}`);
}
function applyMessageBoundaryClasses(slot: Element, message: PiMessage): void {
 const blocks = Array.isArray(message.content) ? message.content : [];
 const visible = blocks.filter((block) => block.type !== "text" || (block.text ?? "").trim().length > 0);
 slot.classList.toggle("user-turn", message.role === "user");
 slot.classList.toggle("assistant-starts-text", message.role === "assistant" && visible[0]?.type === "text");
 slot.classList.toggle("assistant-ends-thinking", message.role === "assistant" && visible.at(-1)?.type === "thinking");
}
function appendToCodeTail(root: Element, suffix: string): boolean {
 const code = root.querySelector("pre > code");
 if (!code) return false;
 if (code.lastChild instanceof Text) code.lastChild.appendData(suffix);
 else code.append(document.createTextNode(suffix));
 return true;
}
function appendToLastTextNode(root: Element, suffix: string): boolean {
 if (!suffix) return true;
 // Skip serializer-owned whitespace between blocks; append inside the last semantic node.
 let current = root.lastElementChild ?? root;
 while (current.matches("ul, ol, blockquote") && current.lastElementChild) current = current.lastElementChild;
 const walker = document.createTreeWalker(current, NodeFilter.SHOW_TEXT);
 let last: Text | undefined;
 for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
 if (!last) return false;
 last.appendData(suffix);
 return true;
}
function linkifyWorkspacePaths(root: Element): void {
 const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
  acceptNode(node): number {
   const parent = node.parentElement;
   if (!parent || parent.closest("pre, a, .tool-call, .thinking-block, [data-workspace-path]")) return NodeFilter.FILTER_REJECT;
   WORKSPACE_PATH_PATTERN.lastIndex = 0;
   return WORKSPACE_PATH_PATTERN.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
  },
 });
 const targets: Text[] = [];
 for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node as Text);
 for (const node of targets) {
  const text = node.nodeValue ?? "";
  WORKSPACE_PATH_PATTERN.lastIndex = 0;
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let match = WORKSPACE_PATH_PATTERN.exec(text);
  while (match) {
   const [full, filePath, line] = match;
   if (match.index > lastIndex) fragment.append(text.slice(lastIndex, match.index));
   const link = document.createElement("span");
   link.className = "workspace-path-link";
   link.setAttribute("role", "link");
   link.tabIndex = 0;
   link.dataset.workspacePath = filePath;
   if (line) link.dataset.workspaceLine = line;
   link.textContent = full;
   fragment.append(link);
   lastIndex = match.index + full.length;
   match = WORKSPACE_PATH_PATTERN.exec(text);
  }
  if (lastIndex === 0) continue;
  if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
  node.parentNode?.replaceChild(fragment, node);
 }
}
