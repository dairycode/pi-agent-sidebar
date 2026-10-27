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
 mountOverlayScrollbar({ viewport: elements.transcript, content: elements.messages, frame: elements.transcriptFrame });
 let scrollTimer: ReturnType<typeof setTimeout> | undefined;
 let touchY: number | undefined;
 function syncJumpButton(): void {
  elements.jumpToBottom.classList.toggle("is-visible", !anchor.isFollowing && anchor.distanceFromBottomPx > 48);
 }
 function scheduleMeasure(): void { frames.scheduleMeasure(); }
 function scheduleScrollSettle(): void {
  if (scrollTimer !== undefined) clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
   scrollTimer = undefined;
   if (anchor.finishUserScroll()) anchor.stickToBottomIfFollowing();
   scheduleMeasure();
  }, 120);
 }
 function clearTouchAnchor(): void {
  touchY = undefined;
  if (anchor.isReaderScrolling) scheduleScrollSettle();
 }
 elements.transcript.addEventListener("scroll", () => {
  if (anchor.noteScroll()) scheduleScrollSettle();
  syncJumpButton();
 }, { passive: true });
 elements.transcript.addEventListener("wheel", (event) => {
  if (event.deltaY < 0) options.cancelSubmitFollow();
  if (anchor.noteUserIntent(event.deltaY)) scheduleScrollSettle();
 }, { passive: true });
 elements.transcript.addEventListener("pointerdown", (event) => {
  if (event.target === elements.transcript) options.cancelSubmitFollow();
 }, { passive: true });
 elements.transcript.addEventListener("keydown", (event) => {
  if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) options.cancelSubmitFollow();
 });
 elements.transcript.addEventListener("touchstart", (event) => { touchY = event.touches[0]?.clientY; }, { passive: true });
 elements.transcript.addEventListener("touchmove", (event) => {
  const currentY = event.touches[0]?.clientY;
  if (currentY === undefined || touchY === undefined) return;
  const delta = touchY - currentY;
  if (delta < 0) options.cancelSubmitFollow();
  if (anchor.noteUserIntent(delta)) scheduleScrollSettle();
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
