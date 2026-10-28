import { ScrollAnchor } from "./scrollAnchor.js";
import { PinnedPromptController } from "./pinnedPrompt.js";
import { mountOverlayScrollbar } from "./overlayScrollbar.js";
import type { FrameCoordinator } from "../ui/frameCoordinator.js";

export interface TranscriptViewportOptions {
 elements: {
  transcript: HTMLElement; messages: HTMLElement; transcriptFrame: HTMLElement;
  jumpToBottom: HTMLButtonElement; pinnedPrompt: HTMLElement; pinnedPromptText: HTMLElement;
  pinnedPromptToggle: HTMLButtonElement; pinnedPromptBody: HTMLButtonElement;
 };
 frames: Pick<FrameCoordinator, "requestScrollFrame" | "cancelScrollFrame" | "scheduleMeasure">;
 scheduleRender(): void;
 cancelSubmitFollow(): void;
}

/** Owns viewport gestures and pinned-prompt measurement, separate from message reconciliation. */
export function createTranscriptViewport(options: TranscriptViewportOptions) {
 const { elements, frames } = options;
 const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
 const pinnedPrompt = new PinnedPromptController({
  viewport: elements.transcript,
  prompts: () => [...elements.messages.querySelectorAll<HTMLElement>(".user-message")],
  row: elements.pinnedPrompt, text: elements.pinnedPromptText, toggle: elements.pinnedPromptToggle,
 });
 const anchor = new ScrollAnchor({
  viewport: elements.transcript,
  requestFrame: (callback) => frames.requestScrollFrame(callback),
  cancelFrame: (handle) => frames.cancelScrollFrame(handle),
  shouldAnimate: () => !reducedMotion.matches,
 });
 mountOverlayScrollbar({
  viewport: elements.transcript, content: elements.messages, frame: elements.transcriptFrame,
  onUserIntent: noteUserIntent, onDragStart: startScrollbarDrag, onDragEnd: finishScrollbarDrag,
 });
 let scrollTimer: ReturnType<typeof setTimeout> | undefined;
 let touchY: number | undefined;
 let isScrollbarDragging = false;
 function syncJumpButton(): void {
  elements.jumpToBottom.classList.toggle("is-visible", !anchor.isFollowing && anchor.distanceFromBottomPx > 48);
 }
 function scheduleMeasure(): void { frames.scheduleMeasure(); }
 function scheduleScrollSettle(): void {
  if (scrollTimer !== undefined) clearTimeout(scrollTimer);
  if (isScrollbarDragging) return;
  scrollTimer = setTimeout(() => {
   scrollTimer = undefined;
   if (anchor.finishUserScroll()) anchor.stickToBottomIfFollowing();
   scheduleMeasure();
  }, 120);
 }
 function noteUserIntent(deltaY: number): void {
  if (deltaY !== 0) options.cancelSubmitFollow();
  if (anchor.noteUserIntent(deltaY)) scheduleScrollSettle();
 }
 function startScrollbarDrag(): void {
  isScrollbarDragging = true;
  if (scrollTimer !== undefined) clearTimeout(scrollTimer);
  scrollTimer = undefined;
  options.cancelSubmitFollow();
  anchor.detach();
 }
 function finishScrollbarDrag(): void {
  isScrollbarDragging = false;
  // A click without movement emits no intent; preserve the direction of real drags.
  if (!anchor.isReaderScrolling) anchor.noteUserIntent(1);
  // Pointer release can arrive before the final native scroll event.
  anchor.noteScroll();
  if (anchor.finishUserScroll()) anchor.stickToBottomIfFollowing();
  syncJumpButton();
  scheduleMeasure();
 }
 function resumeFollowing(): void {
  if (document.hidden) return;
  if (anchor.resume()) options.scheduleRender();
  syncJumpButton();
  scheduleMeasure();
 }
 window.addEventListener("blur", () => anchor.suspend());
 window.addEventListener("focus", resumeFollowing);
 document.addEventListener("visibilitychange", () => {
  if (document.hidden) anchor.suspend();
  else resumeFollowing();
 });
 function clearTouchAnchor(): void {
  touchY = undefined;
  if (anchor.isReaderScrolling) scheduleScrollSettle();
 }
 elements.transcript.addEventListener("scroll", () => {
  if (anchor.noteScroll()) scheduleScrollSettle();
  syncJumpButton();
 }, { passive: true });
 elements.transcript.addEventListener("wheel", (event) => {
  noteUserIntent(event.deltaY);
 }, { passive: true });
 elements.transcript.addEventListener("pointerdown", (event) => {
  if (event.target === elements.transcript) options.cancelSubmitFollow();
 }, { passive: true });
 elements.transcript.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (event.target instanceof Element) {
   if (event.target.closest("input, textarea, select, [contenteditable]")) return;
   // Space activates a button; navigation keys still scroll its container.
   if (event.key === " " && event.target.closest("button")) return;
  }
  const isUp = ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey);
  const isDown = ["ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey);
  if (isUp || isDown) noteUserIntent(isUp ? -1 : 1);
 });
 elements.transcript.addEventListener("touchstart", (event) => { touchY = event.touches[0]?.clientY; }, { passive: true });
 elements.transcript.addEventListener("touchmove", (event) => {
  const currentY = event.touches[0]?.clientY;
  if (currentY === undefined || touchY === undefined) return;
  const delta = touchY - currentY;
  noteUserIntent(delta);
  touchY = currentY;
 }, { passive: true });
 elements.transcript.addEventListener("touchend", clearTouchAnchor, { passive: true });
 elements.transcript.addEventListener("touchcancel", clearTouchAnchor, { passive: true });
 elements.jumpToBottom.addEventListener("click", () => {
  anchor.follow();
  anchor.stickToBottomIfFollowing();
  syncJumpButton();
  elements.jumpToBottom.blur();
 });
 window.addEventListener("resize", () => {
  scheduleMeasure();
  if (anchor.isFollowing) options.scheduleRender();
  else syncJumpButton();
 });
 elements.pinnedPromptBody.addEventListener("click", () => pinnedPrompt.revealActivePrompt());
 elements.pinnedPromptToggle.addEventListener("click", () => pinnedPrompt.toggleExpanded());
 return { anchor, syncJumpButton, scheduleMeasure, measure: () => pinnedPrompt.sync() };
}
