import type { PiContentBlock, PiMessage } from "../../shared/protocol.js";
import type { RpcEventLiveTool } from "../rpcEventReducer.js";
import { contentText } from "../../shared/messageContent.js";
import { adoptSnapshotIdentities, type MessageIdentity } from "./messageIdentity.js";
import { StreamingMessagePlayback } from "./streaming.js";
import { TranscriptView, type TranscriptEntry } from "./transcriptView.js";
import { ProgressiveWindow } from "./progressiveWindow.js";
import { insertReply, withLiveReply } from "./transcriptOrder.js";
import { thinkingGroupKeyIndex } from "./thinkingGroups.js";
import { formatDaySeparator, isNewLocalDay, normalizeEpochMs } from "./messageTime.js";
import { isRenderableMessage, messageRenderSignature } from "./renderer.js";

export interface TranscriptState {
 messages: PiMessage[];
 streamingMessage?: PiMessage;
 streamingIndex: number;
 omittedMessageCount: number;
 timeContext: { locale: string };
}

export interface MessageRenderContext {
 byKey: ReadonlyMap<string, PiMessage>;
 omitted: number;
 resultMap: ReadonlyMap<string, PiMessage>;
 separatorLabels: ReadonlyMap<string, string>;
}

export interface TranscriptControllerOptions {
 state: TranscriptState;
 container: HTMLElement;
 createNode(entry: TranscriptEntry, previous: Element | undefined, context: MessageRenderContext): Element;
 patchStreaming(slot: Element, message: PiMessage, results: ReadonlyMap<string, PiMessage>, key: string): Element | undefined;
 scheduleRender(): void;
 scheduleMeasure(): void;
 pinToBottom(): void;
 syncJumpButton(): void;
 followFresh(): void;
 clearMediaRefusals(): void;
 now(): number;
}

/** Owns transcript identity, playback, disclosure and reconciliation across sessions. */
export class TranscriptController {
 readonly liveTools = new Map<string, RpcEventLiveTool>();
 readonly toolResults = new Map<string, PiMessage>();
 readonly expandedThinkingKeys = new Set<string>();
 readonly playback: StreamingMessagePlayback;
 private readonly view: TranscriptView<Element>;
 private readonly window = new ProgressiveWindow({ threshold: 60, initial: 40, chunk: 40 });
 private readonly identities = new WeakMap<PiMessage, MessageIdentity>();
 private nextKey = 0;
 private context: MessageRenderContext | undefined;
 private pendingToggle: { thinkingKey: string; viewportTop: number } | undefined;
 private readonly limit = 150;

 constructor(private readonly options: TranscriptControllerOptions) {
  this.playback = new StreamingMessagePlayback({
   shouldAnimateThinking: (message, index) => this.expandedThinkingKeys.has(
    `${this.messageKey(message)}-thinking-${thinkingGroupKeyIndex(messageBlocks(this.playback.target ?? message), index)}`,
   ),
  });
  this.view = new TranscriptView<Element>({
   container: options.container,
   createNode: (entry, previous) => {
    if (!this.context) throw new Error("createNode called outside transcript render");
    return options.createNode(entry, previous, this.context);
   },
  });
 }

 messageKey(message: PiMessage): string { return `message-${this.identity(message).key}`; }
 private identity(message: PiMessage): MessageIdentity {
  const existing = this.identities.get(message);
  if (existing) return existing;
  const identity = { key: ++this.nextKey, version: 0 };
  this.identities.set(message, identity);
  return identity;
 }
 private inherit(from: PiMessage | undefined, to: PiMessage): void {
  if (!from || from === to) return;
  const previous = this.identities.get(from);
  if (previous) this.identities.set(to, { key: previous.key, version: previous.version + 1 });
 }
 private signature = (message: PiMessage): string => {
  const identity = this.identity(message);
  return `${identity.key}.${identity.version}`;
 };

 /** Adopt before swapping arrays so unchanged snapshots preserve nodes and disclosure state. */
 adoptSnapshot(messages: PiMessage[]): void {
  const { state } = this.options;
  adoptSnapshotIdentities({
   previous: state.messages, next: messages, windowSize: this.limit * 2,
   identityOf: (message) => this.identities.get(message),
   adopt: (message, identity) => this.identities.set(message, { ...identity }),
  });
  state.messages = messages;
 }

 reconcileSnapshot(sessionChanged: boolean, isStreaming: boolean): void {
  const { state } = this.options;
  const live = state.streamingMessage;
  const finishing = this.playback.isFinishing;
  let listed: PiMessage | undefined;
  if (finishing && live) {
   for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const candidate = state.messages[index];
    if (candidate && isSameMessage(candidate, live)) { listed = candidate; break; }
   }
  }
  if (listed && live) {
   this.playback.reset();
   state.streamingIndex = state.messages.indexOf(listed);
   this.settle(listed);
  } else if (live && !sessionChanged && (finishing || isStreaming)) {
   state.streamingIndex = state.messages.length;
  } else {
   this.playback.reset();
   state.streamingMessage = undefined;
  }
  this.liveTools.clear();
  this.toolResults.clear();
  for (const message of state.messages) {
   if (message.role === "toolResult" && message.toolCallId) this.toolResults.set(message.toolCallId, message);
  }
  if (sessionChanged) {
   this.expandedThinkingKeys.clear();
   this.pendingToggle = undefined;
   this.options.clearMediaRefusals();
   this.view.clear();
  }
  if (sessionChanged || this.view.size === 0) this.options.followFresh();
 }

 advance(timestamp: number): boolean {
  const frame = this.playback.advance(timestamp);
  if (!frame) return this.playback.needsFrame;
  if (frame.completed) {
   this.settle(frame.message);
   this.options.scheduleMeasure();
   return false;
  }
  this.inherit(this.options.state.streamingMessage, frame.message);
  this.options.state.streamingMessage = frame.message;
  return this.playback.needsFrame;
 }

 /** Settle in pi's order: follow-ups arriving during playback belong after this reply. */
 settle(message: PiMessage): void {
  const { state } = this.options;
  this.inherit(state.streamingMessage, message);
  if (!hasEquivalentTail(state.messages, message)) insertReply(state.messages, message, state.streamingIndex);
  state.streamingMessage = undefined;
 }

 interrupt(detail?: string): void {
  const active = this.playback.completeImmediately() ?? this.options.state.streamingMessage;
  if (active) this.settle({ ...active, stopReason: "aborted" });
  for (const tool of this.liveTools.values()) {
   if (tool.status !== "running") continue;
   tool.status = "error";
   if (tool.result === undefined) {
    tool.result = { content: [{ type: "text", text: detail || "Pi disconnected before this tool completed." }] };
   }
   tool.revision += 1;
  }
 }

 renderStreamingFrame(): void {
  const message = this.options.state.streamingMessage;
  const key = message && this.messageKey(message);
  const slot = key && this.view.nodeFor(key);
  if (!message || !key || !slot || !this.options.patchStreaming(slot, message, this.toolResults, key)) this.render();
  this.options.pinToBottom();
  this.options.syncJumpButton();
 }

 render(): void {
  const { state } = this.options;
  const streaming = state.streamingMessage;
  const content = streaming?.content;
  const live = (typeof content === "string" || Array.isArray(content)) && content.length > 0 ? streaming : undefined;
  const renderable = withLiveReply(state.messages, live, state.streamingIndex).filter(isRenderableMessage);
  const capped = renderable.slice(-this.limit);
  const visible = this.window.window(capped, this.view.size === 0);
  const omitted = renderable.length - capped.length + state.omittedMessageCount;
  this.pruneThinking(visible);
  const entries: TranscriptEntry[] = omitted > 0 ? [{ key: "history-omitted", signature: `omitted:${omitted}` }] : [];
  const byKey = new Map<string, PiMessage>();
  const separatorLabels = new Map<string, string>();
  let previousEpoch: number | undefined;
  for (const message of visible) {
   const key = this.messageKey(message);
   byKey.set(key, message);
   const epoch = normalizeEpochMs(message.timestamp);
   if (epoch !== undefined) {
    if (isNewLocalDay(previousEpoch, epoch)) {
     const label = formatDaySeparator(epoch, this.options.now(), state.timeContext.locale || undefined);
     separatorLabels.set(`day-${key}`, label);
     entries.push({ key: `day-${key}`, signature: `day:${label}` });
    }
    previousEpoch = epoch;
   }
   entries.push({ key, signature: `${messageRenderSignature(message, this.toolResults, this.liveTools, message === streaming, this.signature)}|ts${epoch ?? "-"}|tk${this.thinkingSignature(message, key)}` });
  }
  this.context = { byKey, omitted, resultMap: this.toolResults, separatorLabels };
  try { this.view.update(entries); } finally { this.context = undefined; }
  if (visible.length < capped.length) this.options.scheduleRender();
 }

 private thinkingSignature(message: PiMessage, key: string): string {
  let signature = "";
  let index = 0;
  for (const block of messageBlocks(message)) {
   if (block.type !== "thinking") continue;
   signature += this.expandedThinkingKeys.has(`${key}-thinking-${index}`) ? "1" : "0";
   index += 1;
  }
  return signature || "-";
 }
 private pruneThinking(messages: readonly PiMessage[]): void {
  if (this.expandedThinkingKeys.size === 0) return;
  const retained = new Set<string>();
  for (const message of messages) {
   const key = this.messageKey(message);
   let index = 0;
   for (const block of messageBlocks(message)) {
    if (block.type !== "thinking") continue;
    retained.add(`${key}-thinking-${index}`);
    index += 1;
   }
  }
  for (const key of this.expandedThinkingKeys) if (!retained.has(key)) this.expandedThinkingKeys.delete(key);
 }

 setThinkingVisibility(element: HTMLElement, expanded: boolean): void {
  const key = element.dataset.thinkingKey;
  if (!key) return;
  this.pendingToggle = { thinkingKey: key, viewportTop: element.getBoundingClientRect().top };
  if (expanded) this.expandedThinkingKeys.add(key);
  else this.expandedThinkingKeys.delete(key);
  this.options.scheduleRender();
 }
 restoreThinkingAnchor(adjustBy: (offset: number) => void): void {
  const pending = this.pendingToggle;
  this.pendingToggle = undefined;
  if (!pending) return;
  const element = this.options.container.querySelector<HTMLElement>(`.thinking-block[data-thinking-key="${CSS.escape(pending.thinkingKey)}"]`);
  if (element) adjustBy(element.getBoundingClientRect().top - pending.viewportTop);
 }
}

export function messageBlocks(message: PiMessage): readonly PiContentBlock[] {
 return Array.isArray(message.content) ? message.content : [];
}
export function isSameMessage(left: PiMessage, right: PiMessage): boolean {
 if (left.role !== right.role) return false;
 if (left.timestamp && right.timestamp) return left.timestamp === right.timestamp;
 return contentText(left.content) === contentText(right.content);
}
export function hasEquivalentTail(messages: PiMessage[], candidate: PiMessage): boolean {
 const tail = messages.at(-1);
 return Boolean(tail && isSameMessage(tail, candidate));
}
