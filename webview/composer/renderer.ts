import type { UiState } from "../app/state.js";
import type { ComposerController } from "./controller.js";
import type { SelectController } from "../ui/selectController.js";
import type { WebviewToHostMessage } from "../../shared/protocol.js";
import { commandHighlightRanges } from "./commandHighlights.js";

interface ComposerElements {
 input: HTMLTextAreaElement;
 attachmentList: HTMLElement;
 promptEditor: HTMLElement;
 promptHighlights: HTMLElement;
 modelSelect: HTMLButtonElement;
 modelSelectValue: HTMLElement;
 thinkingSelect: HTMLButtonElement;
 thinkingSelectValue: HTMLElement;
 attachButton: HTMLButtonElement;
 commandButton: HTMLButtonElement;
 composerStatusRow: HTMLElement;
 sendButton: HTMLButtonElement;
 sendHint: HTMLElement;
 composer: HTMLElement;
 composerTools: HTMLElement;
}
export interface ComposerRendererOptions {
 elements: ComposerElements;
 state: Pick<UiState, "attachments" | "commands" | "state" | "busy" | "connection" | "models" | "thinkingLevels">;
 composer: ComposerController;
 selectors: SelectController;
 createCodicon(name: string): HTMLElement;
 post(message: WebviewToHostMessage): void;
 scheduleRender(): void;
 isSubmitPending(): boolean;
 showSendHint(): void;
 hideSendHint(): void;
 dismissPopups(): void;
}

/** Owns composer render caches; editing and reference identity remain in ComposerController. */
export function createComposerRenderer(options: ComposerRendererOptions) {
 const { elements, state: ui, composer, selectors } = options;
 let attachmentSignature: string | undefined;
 let promptText: string | undefined;
 let promptSignature: string | undefined;
 let toolsSignature: string | undefined;

 function renderAttachments(): void {
  const signature = ui.attachments.map((item) => `${item.id}:${item.kind}:${item.label}:${item.path}`).join("\u0000");
  if (signature === attachmentSignature) return;
  attachmentSignature = signature;
  elements.attachmentList.replaceChildren();
  for (const attachment of ui.attachments) {
   const chip = document.createElement("div");
   chip.className = "attachment-chip";
   chip.title = attachment.path;
   const icon = document.createElement("i");
   icon.className = `codicon codicon-${attachment.kind === "image" ? "file-media" : "file"}`;
   const label = document.createElement("span");
   label.textContent = attachment.label;
   const remove = document.createElement("button");
   remove.type = "button";
   remove.className = "attachment-remove";
   remove.title = `Remove ${attachment.label}`;
   remove.setAttribute("aria-label", `Remove ${attachment.label}`);
   remove.append(options.createCodicon("close"));
   remove.addEventListener("click", () => {
    ui.attachments = ui.attachments.filter((item) => item.id !== attachment.id);
    options.post({ type: "removeAttachment", id: attachment.id });
    options.scheduleRender();
   });
   chip.append(icon, label, remove);
   elements.attachmentList.append(chip);
  }
 }
 function syncPromptHighlightScroll(): void {
  const width = elements.input.clientWidth;
  const { scrollLeft, scrollTop } = elements.input;
  if (width > 0) elements.promptHighlights.style.width = `${width}px`;
  elements.promptHighlights.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
 }
 function renderComposerHighlights(): void {
  const text = elements.input.value;
  if (text.length > 200_000) {
   promptText = undefined;
   promptSignature = undefined;
   elements.promptEditor.classList.remove("has-token-highlights");
   if (elements.promptHighlights.childNodes.length > 0) elements.promptHighlights.replaceChildren();
   syncPromptHighlightScroll();
   return;
  }
  const references = composer.managedReferences().sort((left, right) => left.start - right.start || left.end - right.end);
  const names = ui.commands.map((command) => command.name);
  const signature = [...references.map((item) => `reference:${item.id}:${item.revision}:${item.start}:${item.end}`), `commands:${names.join("\u0000")}`].join("\u0000");
  if (text === promptText && signature === promptSignature) { syncPromptHighlightScroll(); return; }
  promptText = text;
  promptSignature = signature;
  const ranges = [
   ...references.map(({ start, end }) => ({ start, end, className: "composer-reference-highlight" })),
   ...commandHighlightRanges(text, names).map(({ start, end }) => ({ start, end, className: "composer-command-highlight" })),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  elements.promptEditor.classList.toggle("has-token-highlights", ranges.length > 0);
  if (ranges.length === 0) { elements.promptHighlights.replaceChildren(); syncPromptHighlightScroll(); return; }
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges) {
   if (range.start < cursor) continue;
   fragment.append(document.createTextNode(text.slice(cursor, range.start)));
   const mark = document.createElement("mark");
   mark.className = range.className;
   mark.textContent = text.slice(range.start, range.end);
   fragment.append(mark);
   cursor = range.end;
  }
  fragment.append(document.createTextNode(text.slice(cursor)));
  if (text.endsWith("\n")) fragment.append(document.createTextNode("\u200b"));
  elements.promptHighlights.replaceChildren(fragment);
  syncPromptHighlightScroll();
 }
 function renderSelectors(): void {
  const model = ui.state.model;
  elements.modelSelectValue.textContent = model ? model.name || model.id : "No model";
  elements.modelSelect.title = model ? `${model.provider}/${model.id}` : "No model";
  elements.thinkingSelectValue.textContent = ui.state.thinkingLevel || "off";
  elements.thinkingSelect.title = ui.state.thinkingLevel || "Thinking level";
  selectors.syncSelected();
 }
 function renderSendButton(): void {
  const label = ui.busy ? "Stop pi" : "Send message";
  const icon = elements.sendButton.querySelector("i");
  if (icon) icon.className = `codicon codicon-${ui.busy ? "debug-stop" : "arrow-up"}`;
  elements.sendButton.title = label;
  elements.sendButton.setAttribute("aria-label", label);
  elements.sendButton.disabled = ui.connection !== "ready" || (!ui.busy && (options.isSubmitPending() || composer.hasPendingReferences));
  elements.composer.classList.toggle("busy", ui.busy || options.isSubmitPending());
  if (!elements.sendHint.hidden) {
   if (elements.sendButton.disabled) options.hideSendHint();
   else options.showSendHint();
  }
 }
 function renderAvailability(): void {
  const enabled = ui.connection === "ready";
  elements.input.disabled = !enabled;
  elements.attachButton.disabled = !enabled;
  elements.commandButton.disabled = !enabled;
 }
 function finishRender(): void {
  const enabled = ui.connection === "ready";
  elements.modelSelect.disabled = !enabled || ui.models.length === 0;
  elements.thinkingSelect.disabled = !enabled || ui.thinkingLevels.length <= 1;
  const active = selectors.activeKind;
  if (active && selectors.trigger(active).disabled) selectors.close(false);
  if (!enabled) options.dismissPopups();
  reflowComposerTools();
 }
 function reflowComposerTools(): void {
  const tools = elements.composerTools;
  const signature = `${elements.modelSelectValue.textContent}\u0000${elements.thinkingSelectValue.textContent}`;
  if (signature === toolsSignature) return;
  toolsSignature = signature;
  tools.classList.remove("is-icons", "is-minimal");
  if (tools.scrollWidth <= tools.clientWidth) return;
  tools.classList.add("is-icons");
  if (tools.scrollWidth <= tools.clientWidth) return;
  tools.classList.add("is-minimal");
 }
 function resizeTools(): void { toolsSignature = undefined; reflowComposerTools(); }
 function renderStatusRow(): void {
  // Keep the row's layout slot even with no queue: hiding it would jump the transcript.
  elements.composerStatusRow.hidden = false;
 }
 return { renderAttachments, renderComposerHighlights, syncPromptHighlightScroll, renderSelectors, renderSendButton, renderAvailability, finishRender, resizeTools, renderStatusRow };
}
