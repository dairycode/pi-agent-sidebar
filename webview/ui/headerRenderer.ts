import type { UiState } from "../app/state.js";
import { contentText } from "../../shared/messageContent.js";

interface HeaderElements {
 app: HTMLElement;
 sessionTitle: HTMLElement;
 emptyState: HTMLElement;
 emptyDetail: HTMLElement;
 connectionDot: HTMLElement;
 connectionBanner: HTMLElement;
 transcript: HTMLElement;
 renameSessionButton: HTMLButtonElement;
 cloneSessionButton: HTMLButtonElement;
 forkSessionButton: HTMLButtonElement;
 sessionMenuButton: HTMLButtonElement;
}
export interface HeaderRendererOptions {
 elements: HeaderElements;
 state: UiState;
 isSubmitPending(): boolean;
 dismissSessionMenu(): void;
 dismissForkPicker(): void;
 restart(): void;
 createCodicon(name: string): HTMLElement;
}

/** Renders connection/session chrome without touching transcript or composer content. */
export function createHeaderRenderer(options: HeaderRendererOptions) {
 const { elements, state } = options;
 function render(): void {
  const pending = options.isSubmitPending();
  const working = state.busy || pending;
  const title = sessionTitle(state);
  elements.sessionTitle.textContent = title;
  elements.sessionTitle.title = title;
  elements.emptyState.hidden = state.messages.length > 0 || Boolean(state.streamingMessage) || pending;
  elements.emptyDetail.textContent = state.connection === "ready" ? `Ready in ${state.workspaceName}` : state.connectionDetail || "Starting pi...";
  elements.app.classList.toggle("is-working", working);
  elements.connectionDot.className = `connection-dot ${state.connection}`;
  elements.connectionDot.title = connectionLabel(state);
  elements.connectionDot.setAttribute("aria-label", connectionLabel(state));
  elements.transcript.setAttribute("aria-busy", String(working));
  renderBanner();
 }
 function renderActions(): void {
  const enabled = state.connection === "ready";
  elements.renameSessionButton.disabled = !enabled;
  // Busy clicks are refused with feedback rather than disabling these actions.
  elements.cloneSessionButton.hidden = !state.capabilities.clone;
  elements.cloneSessionButton.disabled = !enabled;
  elements.forkSessionButton.hidden = !state.capabilities.fork || !state.capabilities.forkMessages;
  elements.forkSessionButton.disabled = !enabled;
  const hasItems = !elements.cloneSessionButton.hidden || !elements.forkSessionButton.hidden;
  elements.sessionMenuButton.hidden = !hasItems;
  elements.sessionMenuButton.disabled = !enabled;
  if (!hasItems || !enabled) options.dismissSessionMenu();
  if (elements.forkSessionButton.hidden || !enabled || state.busy) options.dismissForkPicker();
 }
 function renderBanner(): void {
  const show = ["disconnected", "error", "no-workspace"].includes(state.connection);
  elements.connectionBanner.hidden = !show;
  if (!show) return;
  const text = document.createElement("span");
  text.textContent = state.connectionDetail || "Pi is unavailable.";
  elements.connectionBanner.replaceChildren(text);
  if (state.connection === "no-workspace") return;
  const restart = document.createElement("button");
  restart.type = "button";
  restart.className = "text-button";
  restart.append(options.createCodicon("refresh"), document.createTextNode(" Restart"));
  restart.addEventListener("click", options.restart);
  elements.connectionBanner.append(restart);
 }
 return { render, renderActions };
}

export function connectionLabel(state: Pick<UiState, "connection" | "busy" | "connectionDetail">): string {
 if (state.connection === "ready") return state.busy ? "Pi is working" : "Pi is ready";
 if (state.connection === "starting") return "Pi is starting";
 if (state.connection === "no-workspace") return "Workspace required";
 return state.connectionDetail || "Pi is disconnected";
}

export function sessionTitle(state: Pick<UiState, "state" | "titleSeed" | "messages" | "workspaceName">): string {
 if (state.state.sessionName?.trim()) return state.state.sessionName.trim();
 const first = state.messages.find((message) => message.role === "user");
 const seed = state.titleSeed || (first ? contentText(first.content) : "");
 const text = seed.replace(/^<pi-context>[\s\S]*?<\/pi-context>\s*/u, "").trim();
 return truncate(text.replace(/\s+/gu, " "), 54) || "Untitled";
}
function truncate(value: string, length: number): string {
 return value.length > length ? `${value.slice(0, Math.max(0, length - 1))}…` : value;
}
