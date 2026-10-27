import type { ForkCandidate, SessionSummary } from "../../shared/protocol.js";
import type { UiState } from "../app/state.js";
import { normalizeEpochMs } from "../transcript/messageTime.js";
import { positionPopupBelow } from "../ui/popupPosition.js";

interface SessionElements {
 app: HTMLElement;
 sessionMenu: HTMLElement;
 sessionMenuButton: HTMLButtonElement;
 historyPanel: HTMLElement;
 historyButton: HTMLButtonElement;
 sessionSearch: HTMLInputElement;
 sessionList: HTMLElement;
 forkPanel: HTMLElement;
 forkSessionButton: HTMLButtonElement;
 forkSearch: HTMLInputElement;
 forkList: HTMLElement;
 forkDraftWarning: HTMLElement;
}
export interface SessionPanelsOptions {
 elements: SessionElements;
 state: Pick<UiState, "sessions" | "connection" | "busy" | "capabilities">;
 closeComposerPopups(): void;
 composerHasContent(): boolean;
 requestSessions(): void;
 runAction(type: "switchSession" | "deleteSession" | "listForkCandidates" | "forkSession", fields?: { path?: string; entryId?: string }): void;
 openRenamePrompt(): void;
 applyRelativeTime(node: HTMLElement, epoch: number): void;
 createCodicon(name: string): HTMLElement;
}

/** Owns history/menu/fork UI state; opaque session paths and entry IDs go straight to the host. */
export function createSessionPanels(options: SessionPanelsOptions) {
 const { elements, state: ui, runAction, openRenamePrompt, applyRelativeTime, createCodicon } = options;
 let forkCandidates: ForkCandidate[] = [];
 let activeForkEntryId: string | undefined;
 let renderedForkEntryIds: string[] = [];
 let isForkLoading = false;

 function renderSessions(): void {
  const terms = searchTerms(elements.sessionSearch.value);
  const sessions = ui.sessions.filter((session) => matchesTerms(`${session.title}\n${session.excerpt}`, terms));
  if (sessions.length === 0) {
   showEmpty(elements.sessionList, ui.sessions.length === 0 ? "No saved sessions" : "No matching sessions");
   return;
  }
  elements.sessionList.replaceChildren(...sessions.map(createSessionRow));
 }
 function createSessionRow(session: SessionSummary): HTMLElement {
  const row = document.createElement("div");
  row.className = `session-row${session.active ? " active" : ""}`;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "session-open";
  open.title = session.title;
  if (session.active) open.setAttribute("aria-current", "true");
  const title = document.createElement("strong");
  title.textContent = session.title;
  const time = document.createElement("time");
  const epoch = normalizeEpochMs(session.lastActivityAt ?? session.createdAt);
  if (epoch !== undefined) {
   time.dateTime = new Date(epoch).toISOString();
   time.dataset.epochMs = String(epoch);
   applyRelativeTime(time, epoch);
  }
  open.append(title, time);
  open.addEventListener("click", () => {
   if (!session.active) runAction("switchSession", { path: session.path });
   closeHistory();
  });
  const action = document.createElement("button");
  action.type = "button";
  action.className = session.active ? "session-rename" : "session-delete";
  action.title = session.active ? "Rename session" : "Delete session";
  action.setAttribute("aria-label", `${session.active ? "Rename" : "Delete"} ${session.title}`);
  action.append(createCodicon(session.active ? "edit" : "trash"));
  action.addEventListener("click", () => session.active ? openRenamePrompt() : runAction("deleteSession", { path: session.path }));
  row.append(open, action);
  return row;
 }
 function sessionMenuItems(): HTMLButtonElement[] {
  return [...elements.sessionMenu.querySelectorAll<HTMLButtonElement>(".menu-item")].filter((item) => !item.hidden && !item.disabled);
 }
 function toggleSessionMenu(): void {
  if (!elements.sessionMenu.hidden) { closeSessionMenu(); return; }
  dismissHistory();
  dismissForkPicker();
  options.closeComposerPopups();
  elements.sessionMenu.hidden = false;
  elements.sessionMenuButton.setAttribute("aria-expanded", "true");
  positionPopupBelow({ container: elements.app, popup: elements.sessionMenu, anchor: elements.sessionMenuButton });
  sessionMenuItems()[0]?.focus();
 }
 function dismissSessionMenu(): void {
  if (elements.sessionMenu.hidden) return;
  elements.sessionMenu.hidden = true;
  elements.sessionMenuButton.setAttribute("aria-expanded", "false");
 }
 function closeSessionMenu(): void {
  const wasOpen = !elements.sessionMenu.hidden;
  dismissSessionMenu();
  if (wasOpen) elements.sessionMenuButton.focus();
 }
 function focusSessionMenuItem(key: string): void {
  const items = sessionMenuItems();
  if (items.length === 0) return;
  if (key === "Home") { items[0]?.focus(); return; }
  if (key === "End") { items.at(-1)?.focus(); return; }
  const active = document.activeElement;
  const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
  const delta = key === "ArrowDown" ? 1 : -1;
  items[index < 0 ? 0 : (index + delta + items.length) % items.length]?.focus();
 }
 function toggleHistory(): void {
  if (!elements.historyPanel.hidden) { closeHistory(); return; }
  dismissForkPicker();
  dismissSessionMenu();
  elements.historyPanel.hidden = false;
  elements.historyButton.setAttribute("aria-expanded", "true");
  elements.sessionSearch.value = "";
  showEmpty(elements.sessionList, "Loading...");
  elements.sessionSearch.focus();
  options.requestSessions();
 }
 function dismissHistory(): void {
  elements.historyPanel.hidden = true;
  elements.historyButton.setAttribute("aria-expanded", "false");
 }
 function closeHistory(): void { dismissHistory(); elements.historyButton.focus(); }
 function openForkPicker(): void {
  if (ui.connection !== "ready" || ui.busy || !ui.capabilities.fork || !ui.capabilities.forkMessages) return;
  dismissHistory();
  dismissSessionMenu();
  options.closeComposerPopups();
  forkCandidates = [];
  activeForkEntryId = undefined;
  renderedForkEntryIds = [];
  isForkLoading = true;
  elements.forkSearch.value = "";
  elements.forkPanel.hidden = false;
  elements.forkSessionButton.setAttribute("aria-expanded", "true");
  elements.forkDraftWarning.hidden = !options.composerHasContent();
  renderForkCandidates();
  elements.forkSearch.focus();
  runAction("listForkCandidates");
 }
 function dismissForkPicker(): void {
  if (elements.forkPanel.hidden) return;
  elements.forkPanel.hidden = true;
  forkCandidates = [];
  activeForkEntryId = undefined;
  renderedForkEntryIds = [];
  isForkLoading = false;
  elements.forkSearch.removeAttribute("aria-activedescendant");
  elements.forkList.replaceChildren();
  elements.forkSessionButton.setAttribute("aria-expanded", "false");
 }
 function closeForkPicker(): void {
  const wasOpen = !elements.forkPanel.hidden;
  dismissForkPicker();
  if (wasOpen) elements.sessionMenuButton.focus();
 }
 function applyForkCandidates(candidates: ForkCandidate[]): void {
  isForkLoading = false;
  forkCandidates = candidates;
  // A late reply must not repopulate a closed picker.
  if (!elements.forkPanel.hidden) renderForkCandidates();
 }
 function renderForkCandidates(): void {
  if (isForkLoading) {
   renderedForkEntryIds = [];
   showEmpty(elements.forkList, "Loading...");
   elements.forkSearch.removeAttribute("aria-activedescendant");
   return;
  }
  const terms = searchTerms(elements.forkSearch.value);
  const matches = forkCandidates.filter((candidate) => matchesTerms(candidate.text, terms));
  renderedForkEntryIds = matches.map((candidate) => candidate.entryId);
  if (matches.length === 0) {
   showEmpty(elements.forkList, forkCandidates.length === 0 ? "No earlier prompt to fork from" : "No matching prompts");
   elements.forkSearch.removeAttribute("aria-activedescendant");
   return;
  }
  if (activeForkEntryId && !renderedForkEntryIds.includes(activeForkEntryId)) activeForkEntryId = undefined;
  elements.forkList.replaceChildren(...matches.map(createForkRow));
  highlightActiveFork(false);
 }
 function createForkRow(candidate: ForkCandidate, index: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "fork-row";
  row.id = `fork-row-${index}`;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  row.dataset.forkEntryId = candidate.entryId;
  row.tabIndex = -1;
  row.title = candidate.text || "(empty prompt)";
  const label = document.createElement("span");
  label.className = "fork-row-text";
  label.textContent = row.title;
  row.append(label);
  const epoch = normalizeEpochMs(candidate.timestamp);
  if (epoch !== undefined) {
   const time = document.createElement("time");
   time.className = "fork-row-time";
   time.dateTime = new Date(epoch).toISOString();
   time.dataset.epochMs = String(epoch);
   applyRelativeTime(time, epoch);
   row.append(time);
  }
  row.addEventListener("click", () => submitFork(candidate.entryId));
  return row;
 }
 function highlightActiveFork(scroll = true): void {
  let activeId: string | undefined;
  for (const row of elements.forkList.querySelectorAll<HTMLElement>(".fork-row")) {
   const active = row.dataset.forkEntryId === activeForkEntryId;
   row.classList.toggle("is-active", active);
   row.setAttribute("aria-selected", String(active));
   if (!active) continue;
   activeId = row.id;
   if (scroll) row.scrollIntoView({ block: "nearest" });
  }
  if (activeId) elements.forkSearch.setAttribute("aria-activedescendant", activeId);
  else elements.forkSearch.removeAttribute("aria-activedescendant");
 }
 function moveActiveFork(delta: number): void {
  if (renderedForkEntryIds.length === 0) return;
  const current = activeForkEntryId ? renderedForkEntryIds.indexOf(activeForkEntryId) : -1;
  const next = current < 0 ? (delta > 0 ? 0 : renderedForkEntryIds.length - 1) : (current + delta + renderedForkEntryIds.length) % renderedForkEntryIds.length;
  activeForkEntryId = renderedForkEntryIds[next];
  highlightActiveFork();
 }
 function submitFork(entryId: string): void {
  if (ui.connection !== "ready" || ui.busy) return;
  dismissForkPicker();
  elements.sessionMenuButton.focus();
  runAction("forkSession", { entryId });
 }
 function submitActiveFork(): void {
  if (activeForkEntryId && renderedForkEntryIds.includes(activeForkEntryId)) submitFork(activeForkEntryId);
 }
 return { renderSessions, toggleSessionMenu, dismissSessionMenu, closeSessionMenu, focusSessionMenuItem, toggleHistory, dismissHistory, closeHistory, openForkPicker, dismissForkPicker, closeForkPicker, applyForkCandidates, renderForkCandidates, moveActiveFork, submitActiveFork };
}

function searchTerms(query: string): string[] { return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean); }
function matchesTerms(text: string, terms: string[]): boolean {
 const searchable = text.toLocaleLowerCase();
 return terms.every((term) => searchable.includes(term));
}
function showEmpty(container: HTMLElement, text: string): void {
 const empty = document.createElement("div");
 empty.className = "session-list-empty";
 empty.textContent = text;
 container.replaceChildren(empty);
}
