import { createComposerRenderer } from "./composer/renderer.js";
import { createHeaderRenderer } from "./ui/headerRenderer.js";
import { createRuntimeRenderer } from "./ui/runtimeRenderer.js";
import { createUiState } from "./app/state.js";
import { createSessionPanels } from "./session/panels.js";
import { SessionController } from "./session/controller.js";
import DOMPurify from "dompurify";
import { formatComposerReferenceLocation } from "../shared/composerReferences.js";
import { RpcEventReducer } from "./rpcEventReducer.js";
import { HostMessageHandler } from "./hostMessageHandler.js";
import { handleImagePaste } from "./attachments/imagePaste.js";
import type { ManagedComposerReference } from "./composer/model.js";
import { ComposerController } from "./composer/controller.js";
import { ComposerFocusRequests } from "./composer/focusRequest.js";
import { MentionController } from "./composer/mentions.js";
import { createTranscriptDom } from "./transcript/dom.js";
import { TranscriptController, hasEquivalentTail } from "./transcript/controller.js";
import {
	formatAbsoluteTime,
	formatRelativeTime,
	nextRefreshDelayMs,
} from "./transcript/messageTime.js";
import { StreamingUsageTracker } from "./streamUsage.js";
import { createTranscriptViewport } from "./transcript/viewport.js";
import {
	MediaSources,
	type ResolvedMediaSource,
} from "./transcript/mediaSources.js";
import {
	SubmitFollowCoordinator,
	snapshotAcknowledgesSubmit,
} from "./transcript/submitFollow.js";
import { friendlyToolName } from "./transcript/renderer.js";
import {
	containsDroppedResources,
	extractDroppedResources,
} from "./resourceDrop.js";
import { positionPopupAbove } from "./ui/popupPosition.js";
import { FrameCoordinator } from "./ui/frameCoordinator.js";
import { TRANSCRIPT_SANITIZE_OPTIONS } from "./sanitizerPolicy.js";
import { LiveStatusAnnouncer } from "./ui/liveStatus.js";
import { SelectController } from "./ui/selectController.js";
import { ModalController } from "./ui/modalController.js";
import {
	MAX_COMPOSER_REFERENCE_COUNT,
	type HostToWebviewMessage,
	type JsonRecord,
	type PiCommand,
	type PiMessage,
	type SubmitDelivery,
	type WebviewToHostMessage,
	type WorkspaceReferenceSuggestion,
} from "../shared/protocol.js";

declare function acquireVsCodeApi<T = unknown>(): {
	postMessage(message: WebviewToHostMessage): void;
	getState(): T | undefined;
	setState(state: T): void;
};

interface PersistedState {
	draft: string;
	composerReferences?: ManagedComposerReference[];
}

interface PendingAction {
	type: string;
	draft?: string;
	attachmentIds?: string[];
	referenceSnapshots?: ManagedComposerReference[];
	stagedReferenceId?: string;
	/**
	 * When this webview asked for the submit, on its own clock.
	 *
	 * Only set for submits: the snapshot recovery compares it against the timestamp
	 * pi stamped the message with, so a repeated prompt from earlier in the session
	 * cannot pass as the answer to this one.
	 */
	submittedAtMs?: number;
}

const vscode = acquireVsCodeApi<PersistedState>();
const ui = createUiState();

const pendingActions = new Map<string, PendingAction>();

/**
 * Whether a submit is in flight.
 *
 * Derived from the two other places the same fact already lives — the registered
 * actions and the follow coordinator — rather than mirrored in a third variable.
 * The mirror was correct only as long as every removal of a `submit` action also
 * cleared it, and the two paths that remove one are the reply path and the
 * reply-lost recovery path.
 */
function isSubmitPending(): boolean {
	for (const action of pendingActions.values()) {
		if (action.type === "submit") return true;
	}
	return false;
}
const extensionStatuses = new Map<string, string>();
const extensionWidgets = new Map<string, string[]>();
/** Single transcript-wide timer for relative time labels. */
let relativeTimeTimer: ReturnType<typeof setTimeout> | undefined;
let resourceDragDepth = 0;
const MAX_SESSION_NAME_LENGTH = 200;

const elements = {
	app: element<HTMLElement>("app"),
	sessionHeader: element<HTMLElement>("session-header"),
	transcript: element<HTMLElement>("transcript"),
	transcriptFrame: element<HTMLElement>("transcript-frame"),
	jumpToBottom: element<HTMLButtonElement>("jump-to-bottom"),
	messages: element<HTMLElement>("messages"),
	emptyState: element<HTMLElement>("empty-state"),
	emptyDetail: element<HTMLElement>("empty-detail"),
	connectionDot: element<HTMLElement>("connection-dot"),
	connectionBanner: element<HTMLElement>("connection-banner"),
	pinnedPrompt: element<HTMLElement>("pinned-prompt"),
	pinnedPromptBody: element<HTMLButtonElement>("pinned-prompt-body"),
	pinnedPromptText: element<HTMLElement>("pinned-prompt-text"),
	pinnedPromptToggle: element<HTMLButtonElement>("pinned-prompt-toggle"),
	sessionTitle: element<HTMLElement>("session-title"),
	renameSessionButton: element<HTMLButtonElement>("rename-session-button"),
	sessionMenuButton: element<HTMLButtonElement>("session-menu-button"),
	sessionMenu: element<HTMLElement>("session-menu"),
	cloneSessionButton: element<HTMLButtonElement>("clone-session-button"),
	forkSessionButton: element<HTMLButtonElement>("fork-session-button"),
	historyButton: element<HTMLButtonElement>("history-button"),
	newSessionButton: element<HTMLButtonElement>("new-session-button"),
	historyPanel: element<HTMLElement>("history-panel"),
	sessionSearch: element<HTMLInputElement>("session-search"),
	sessionList: element<HTMLElement>("session-list"),
	forkPanel: element<HTMLElement>("fork-panel"),
	forkSearch: element<HTMLInputElement>("fork-search"),
	forkList: element<HTMLElement>("fork-list"),
	forkDraftWarning: element<HTMLElement>("fork-draft-warning"),
	widgetArea: element<HTMLElement>("widget-area"),
	composerStatusRow: element<HTMLElement>("composer-status-row"),
	queueStatus: element<HTMLElement>("queue-status"),
	attachmentList: element<HTMLElement>("attachment-list"),
	composerShell: element<HTMLElement>("composer-shell"),
	resourceDropOverlay: element<HTMLElement>("resource-drop-overlay"),
	composer: element<HTMLFormElement>("composer"),
	promptEditor: element<HTMLElement>("prompt-editor"),
	promptHighlights: element<HTMLElement>("prompt-highlights"),
	input: element<HTMLTextAreaElement>("prompt-input"),
	attachButton: element<HTMLButtonElement>("attach-button"),
	commandButton: element<HTMLButtonElement>("command-button"),
	commandPanel: element<HTMLElement>("command-panel"),
	commandSearch: element<HTMLInputElement>("command-search"),
	commandList: element<HTMLElement>("command-list"),
	mentionPanel: element<HTMLElement>("mention-panel"),
	mentionList: element<HTMLElement>("mention-list"),
	composerTools: element<HTMLElement>("composer-tools"),
	modelSelect: element<HTMLButtonElement>("model-select"),
	modelSelectValue: element<HTMLElement>("model-select-value"),
	thinkingSelect: element<HTMLButtonElement>("thinking-select"),
	thinkingSelectValue: element<HTMLElement>("thinking-select-value"),
	selectPopup: element<HTMLElement>("select-popup"),
	sendButton: element<HTMLButtonElement>("send-button"),
	sendHint: element<HTMLElement>("send-hint"),
	runtimeMeta: element<HTMLButtonElement>("runtime-meta"),
	usagePanel: element<HTMLElement>("usage-panel"),
	toastRegion: element<HTMLElement>("toast-region"),
	liveStatus: element<HTMLElement>("live-status"),
	modalBackdrop: element<HTMLElement>("modal-backdrop"),
};

const announcer = new LiveStatusAnnouncer({
	liveStatus: elements.liveStatus,
	requestFrame: (callback) => requestAnimationFrame(callback),
});

const composerFocusRequests = new ComposerFocusRequests({
	input: elements.input,
	isInputFocused: () => document.activeElement === elements.input,
	notifyFocused: (requestId) => post({ type: "composerFocused", requestId }),
	requestFrame: (callback) => requestAnimationFrame(callback),
});

const modalController = new ModalController({
	backdrop: elements.modalBackdrop,
	inertRoots: [
		elements.sessionHeader,
		elements.historyPanel,
		elements.transcript,
		elements.widgetArea,
		elements.composerShell,
	],
});

const selectorController = new SelectController({
	popup: elements.selectPopup,
	triggers: {
		model: elements.modelSelect,
		thinking: elements.thinkingSelect,
	},
	getOptions: (kind) =>
		kind === "thinking"
			? ui.thinkingLevels.map((level) => ({ value: level, label: level }))
			: ui.models.map((model) => ({
					value: `${model.provider}/${model.id}`,
					label: model.name || model.id,
				})),
	getSelectedValue: (kind) => {
		if (kind === "thinking") return ui.state.thinkingLevel ?? "";
		return ui.state.model
			? `${ui.state.model.provider}/${ui.state.model.id}`
			: "";
	},
	onCommit: (kind, value) => {
		if (kind === "thinking") {
			runAction("setThinking", { level: value });
			return;
		}
		const [provider, ...idParts] = value.split("/");
		const modelId = idParts.join("/");
		if (provider && modelId) runAction("setModel", { provider, modelId });
	},
	beforeOpen: () => {
		dismissHistory();
		dismissSessionMenu();
		dismissCommandPalette();
		mentionController.dismiss();
	},
	position: (trigger, popup) =>
		positionPopupAbove({ container: elements.app, popup, anchor: trigger }),
});

const persisted = vscode.getState();
if (persisted?.draft) elements.input.value = persisted.draft;
const composerController = new ComposerController(
	{
		editor: elements.input,
		persist: (draft, composerReferences) =>
			vscode.setState({ draft, composerReferences }),
		post,
		announce: (message) => announcer.announce(message),
		invalidate: scheduleRender,
		refreshEditorView: () => {
			resizeInput();
			renderComposerHighlights();
		},
		isEditorActive: () => document.activeElement === elements.input,
		pendingActions: () => pendingActions.values(),
	},
	persisted?.composerReferences,
);

/**
 * `@` mention popup for workspace files.
 *
 * Picking a row immediately replaces the query with a locally highlighted
 * marker, then goes through `addResources`, the same host path the Explorer drag
 * and drop uses. The host remains the owner of reference identity and revisions;
 * its response adopts the staged marker's range without another text update.
 */
const mentionController = new MentionController({
	panel: elements.mentionPanel,
	list: elements.mentionList,
	editor: elements.input,
	requestFiles: (requestId, query) =>
		post({ type: "listWorkspaceFiles", requestId, query }),
	commit: (file, token) => addMentionReference(file, token),
	navigate: (directoryPath, token) =>
		composerController.replaceRange(
			token.start,
			token.end,
			`@${directoryPath}/`,
		),
	announce: (message) => announcer.announce(message),
	isEnabled: () => ui.connection === "ready" && !elements.input.disabled,
	position: positionMentionPanel,
	isProtectedOffset: (offset) =>
		Boolean(composerController.referenceAtOffset(offset)),
});
const sessionPanels = createSessionPanels({
	elements, state: ui, runAction, openRenamePrompt, applyRelativeTime, createCodicon,
	requestSessions: () => post({ type: "listSessions" }),
	composerHasContent: () => elements.input.value.trim().length > 0 || ui.attachments.length > 0 || composerController.references.length > 0,
	closeComposerPopups: () => {
		selectorController.close(false);
		dismissCommandPalette();
		mentionController.dismiss();
	},
});
const { renderSessions, toggleSessionMenu, dismissSessionMenu, closeSessionMenu,
	focusSessionMenuItem, toggleHistory, dismissHistory, closeHistory,
	openForkPicker, dismissForkPicker, closeForkPicker, renderForkCandidates, moveActiveFork } = sessionPanels;

const composerRenderer = createComposerRenderer({
	elements, state: ui, composer: composerController, selectors: selectorController,
	createCodicon, post, scheduleRender, isSubmitPending, showSendHint, hideSendHint,
	dismissPopups: () => { dismissCommandPalette(); mentionController.dismiss(); },
});
const { renderComposerHighlights, syncPromptHighlightScroll } = composerRenderer;
const headerRenderer = createHeaderRenderer({
	elements, state: ui, isSubmitPending, dismissSessionMenu, dismissForkPicker,
	restart: () => { runAction("restart"); }, createCodicon,
});
resizeInput();
renderComposerHighlights();

const frameCoordinator = new FrameCoordinator({
	requestFrame: (callback) => window.requestAnimationFrame(callback),
	cancelFrame: (handle) => window.cancelAnimationFrame(handle),
	measure: () => transcriptViewport.measure(),
	advance: (timestamp) => transcriptController.advance(timestamp),
	render,
	renderAdvance: () => transcriptController.renderStreamingFrame(),
});
const transcriptViewport = createTranscriptViewport({
	elements, frames: frameCoordinator, scheduleRender,
	cancelSubmitFollow: () => submitFollowCoordinator.cancelAll(),
});
const { anchor: scrollAnchor, syncJumpButton: syncJumpToBottomButton, scheduleMeasure: scheduleTranscriptMeasure } = transcriptViewport;
const submitFollowCoordinator = new SubmitFollowCoordinator({
	// Every coordinator follow lands on a render: `follow` alone clears the
	// anchor's recorded position, and until the next render pins the viewport a
	// single native scroll event reads as a reader gesture and undoes it. The
	// ack and composer-resize paths have no render of their own, so scheduling
	// here is what closes that gap.
	onFollow: () => {
		scrollAnchor.follow();
		scheduleRender();
	},
});

const transcriptDom = createTranscriptDom({
	controller: () => transcriptController, state: ui, anchor: scrollAnchor,
	sanitizedNodes, createCodicon, bindImageReflow, enhanceImages: enhanceTranscriptImages,
	scheduleMeasure: scheduleTranscriptMeasure,
});
const { createMessageNode, patchStreamingMessage, toggleExpandable, refreshExpandedToolBody } = transcriptDom;
const transcriptController = new TranscriptController({
	state: ui,
	container: elements.messages,
	createNode: createMessageNode,
	patchStreaming: patchStreamingMessage,
	scheduleRender,
	scheduleMeasure: scheduleTranscriptMeasure,
	pinToBottom: () => scrollAnchor.stickToBottomIfFollowing(),
	syncJumpButton: syncJumpToBottomButton,
	followFresh: () => scrollAnchor.follow({ snap: true }),
	clearMediaRefusals: () => mediaSources.clearRefusals(),
	now: hostNow,
});
const { liveTools, toolResults, playback: streamingPlayback } = transcriptController;

/**
 * Answer cache for the image paths a transcript names.
 *
 * Module-scoped rather than per-render: the host answers a batch as a whole, and
 * the reply usually arrives after the frame that asked for it. Clearing this with
 * the transcript would re-ask for the same path on every streaming delta.
 */
const mediaSources = new MediaSources((requestId, sources) =>
	post({ type: "resolveMedia", requestId, sources }),
);


window.addEventListener("keydown", (event) => {
	if (modalController.isOpen) {
		modalController.handleKeydown(event);
		return;
	}
	if (event.key !== "Escape") return;
	if (selectorController.activeKind) {
		selectorController.close(true);
		return;
	}
	if (!elements.sessionMenu.hidden) {
		closeSessionMenu();
		return;
	}
	if (mentionController.isOpen) {
		mentionController.dismiss();
		return;
	}
	if (!elements.usagePanel.hidden) {
		dismissUsagePanel();
		elements.runtimeMeta.focus();
		return;
	}
	if (!elements.commandPanel.hidden) {
		closeCommandPalette(true);
		return;
	}
	if (!elements.forkPanel.hidden) {
		closeForkPicker();
		return;
	}
	if (!elements.historyPanel.hidden) closeHistory();
});

window.addEventListener("pointerdown", (event) => {
	if (!(event.target instanceof Node)) return;
	const activeSelect = selectorController.activeKind;
	if (
		activeSelect &&
		!elements.selectPopup.contains(event.target) &&
		!selectorController.trigger(activeSelect).contains(event.target)
	) {
		selectorController.close(false);
	}
	if (
		!elements.commandPanel.hidden &&
		!elements.commandPanel.contains(event.target) &&
		!elements.commandButton.contains(event.target) &&
		// The inline palette is driven by the composer, so clicking inside the
		// textarea must not dismiss it; the caret checks decide that instead.
		!(commandPaletteMode === "inline" && elements.input.contains(event.target))
	) {
		dismissCommandPalette();
	}
	if (
		mentionController.isOpen &&
		!elements.mentionPanel.contains(event.target) &&
		// Same reasoning as the inline palette: the composer is the mention popup's
		// search field, so a click inside it is handled by the caret checks.
		!elements.input.contains(event.target)
	) {
		mentionController.dismiss();
	}
	// The menu's own items are excluded: hiding the popup on pointerdown would
	// pull the item out from under the click that is still on its way.
	if (
		!elements.sessionMenu.hidden &&
		!elements.sessionMenu.contains(event.target) &&
		!elements.sessionMenuButton.contains(event.target)
	) {
		dismissSessionMenu();
	}
	// Checked before the history panel, whose branch returns early.
	if (
		!elements.forkPanel.hidden &&
		!elements.forkPanel.contains(event.target) &&
		!elements.forkSessionButton.contains(event.target)
	) {
		dismissForkPicker();
	}
	if (
		modalController.isOpen ||
		elements.historyPanel.hidden ||
		elements.historyPanel.contains(event.target) ||
		elements.historyButton.contains(event.target)
	)
		return;
	dismissHistory();
});

// Pointer events do not cross the webview boundary. Dismiss transient panels
// when focus moves to the editor or another VS Code surface, without restoring
// focus to their triggers and pulling it back into the sidebar.
window.addEventListener("blur", () => {
	if (selectorController.activeKind) selectorController.close(false);
	if (!elements.commandPanel.hidden) dismissCommandPalette();
	mentionController.dismiss();
	if (!elements.historyPanel.hidden) dismissHistory();
	dismissForkPicker();
	dismissSessionMenu();
	if (!elements.usagePanel.hidden) dismissUsagePanel();
});

elements.input.addEventListener("input", () => {
	composerController.handleInput();
	syncInlineCommandPalette();
	mentionController.syncAfterInput();
});

elements.input.addEventListener("keyup", (event) => {
	composerController.rememberCaret();
	// Caret keys move without firing `input`, so the inline palette has to
	// re-check whether the caret is still inside its token.
	if (
		event.key.startsWith("Arrow") ||
		event.key === "Home" ||
		event.key === "End"
	) {
		syncInlineCommandPalette();
		mentionController.sync();
	}
});
elements.input.addEventListener("pointerup", () => {
	composerController.rememberCaret();
	syncInlineCommandPalette();
	mentionController.sync();
});
elements.input.addEventListener("select", () =>
	composerController.rememberCaret(),
);
elements.input.addEventListener("blur", () =>
	composerController.rememberCaret(),
);

elements.input.addEventListener("scroll", syncPromptHighlightScroll);
window.addEventListener("resize", syncPromptHighlightScroll);

const promptHighlightResizeObserver = new ResizeObserver(
	syncPromptHighlightScroll,
);
promptHighlightResizeObserver.observe(elements.input);

// Dragging the sidebar edge changes the available width without any state
// change, so the label stages have to be re-measured here as well as in render().
const composerToolsResizeObserver = new ResizeObserver(() => {
	// The row's width is one of the fold's two inputs, and the only one no render
	// pass can see change: dropping the measured signature makes the next call do
	// the work again.
	composerRenderer.resizeTools();
	selectorController.reposition();
	if (!elements.commandPanel.hidden) positionCommandPanel();
	mentionController.reposition();
});
composerToolsResizeObserver.observe(elements.composerTools);

// Keep floating feedback immediately above the composer when attachments or a
// multi-line draft change its height.
const composerShellResizeObserver = new ResizeObserver(() => {
	updateComposerOverlayOffset();
	if (submitFollowCoordinator.noteComposerResize()) {
		// Grid row sizes are final only in ResizeObserver. Re-targeting here avoids
		// retaining the bottom computed while a multi-line composer was still tall.
		scrollAnchor.stickToBottomIfFollowing();
	}
});
composerShellResizeObserver.observe(elements.composerShell);
updateComposerOverlayOffset();

elements.input.addEventListener("keydown", (event) => {
	// The palette claims Enter/Tab/arrows while it is open, so this runs before
	// the composer's own send and reference-jump handling. The mention popup is
	// checked first for the same reason; only one of the two can be open, because
	// a `/` token and an `@` token cannot share a caret.
	if (mentionController.handleKeydown(event)) return;
	if (handleInlineCommandKeydown(event)) return;
	if (event.key === "F12") {
		const reference = composerController.referenceAtOffset(
			elements.input.selectionStart,
		);
		if (!reference || composerController.isPendingReference(reference.id))
			return;
		event.preventDefault();
		post({ type: "openComposerReference", id: reference.id });
		return;
	}
	// Alt+Enter queues the draft as a follow-up, mirroring pi's TUI shortcut.
	// pi ignores the delivery hint when idle, so this doubles as a plain send.
	if (
		event.key === "Enter" &&
		event.altKey &&
		!event.shiftKey &&
		!event.isComposing
	) {
		event.preventDefault();
		if (ui.connection !== "ready") return;
		sendPrompt("followUp");
		return;
	}
	if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
	event.preventDefault();
	if (ui.connection !== "ready") return;
	sendPrompt();
});

elements.input.addEventListener("paste", (event) => {
	void handleImagePaste(event, {
		attachedImageCount: () =>
			ui.attachments.filter((attachment) => attachment.kind === "image").length,
		onImages: (images) => runAction("pasteImages", { images }),
		onError: (message) => showToast(message, "error"),
	});
});

window.addEventListener("dragenter", (event) => {
	if (!isAttachableResourceDrag(event.dataTransfer)) return;
	event.preventDefault();
	if (resourceDragDepth === 0) {
		elements.resourceDropOverlay.hidden = false;
		elements.app.classList.add("is-resource-drag");
		announcer.announce("Drop files or folders to add as context");
	}
	resourceDragDepth += 1;
});

window.addEventListener("dragover", (event) => {
	if (!isAttachableResourceDrag(event.dataTransfer)) return;
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", () => {
	if (resourceDragDepth === 0) return;
	resourceDragDepth -= 1;
	if (resourceDragDepth === 0) clearResourceDragState();
});

window.addEventListener("drop", (event) => {
	const dataTransfer = event.dataTransfer;
	if (!isAttachableResourceDrag(dataTransfer)) return;
	event.preventDefault();
	clearResourceDragState();
	const resources = extractDroppedResources(dataTransfer);
	if (resources.length === 0) {
		showToast("Could not read the dropped VS Code resources", "error");
		return;
	}
	const availableReferenceCount = Math.max(
		0,
		MAX_COMPOSER_REFERENCE_COUNT - composerController.referenceCount,
	);
	if (resources.length > availableReferenceCount) {
		showToast(
			availableReferenceCount === 0
				? `Remove a reference before adding another (maximum ${MAX_COMPOSER_REFERENCE_COUNT})`
				: `Add at most ${availableReferenceCount} more ${availableReferenceCount === 1 ? "reference" : "references"}`,
			"error",
		);
		return;
	}
	runAction("addResources", { resources });
});

window.addEventListener("dragend", clearResourceDragState);

elements.input.addEventListener("click", (event) => {
	if (!event.metaKey && !event.ctrlKey) return;
	const reference = composerController.referenceAtOffset(
		elements.input.selectionStart,
	);
	if (!reference || composerController.isPendingReference(reference.id)) return;
	post({ type: "openComposerReference", id: reference.id });
});

elements.composer.addEventListener("submit", (event) => {
	event.preventDefault();
	if (ui.busy) abortRun();
	else sendPrompt();
});

// Alt+Enter has no on-screen control, so hovering the send button is where the
// two delivery modes get named. Focus is included because a keyboard user
// reaching the button never triggers a pointer hover.
for (const event of ["pointerenter", "focus"] as const) {
	elements.sendButton.addEventListener(event, showSendHint);
}
for (const event of ["pointerleave", "blur"] as const) {
	elements.sendButton.addEventListener(event, hideSendHint);
}

elements.attachButton.addEventListener("click", () =>
	post({ type: "pickAttachments" }),
);
elements.commandButton.addEventListener("click", toggleCommandPalette);
elements.commandSearch.addEventListener("input", renderCommands);
elements.commandSearch.addEventListener("keydown", (event) => {
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		moveActiveCommand(event.key === "ArrowDown" ? 1 : -1);
		return;
	}
	if (event.key !== "Enter" || event.isComposing || !activeCommandName) return;
	event.preventDefault();
	insertSlashCommand(activeCommandName);
});
elements.historyButton.addEventListener("click", toggleHistory);
elements.sessionMenuButton.addEventListener("click", toggleSessionMenu);
// The keys `role="menu"` promises: the arrows walk the items and wrap, Home and
// End jump to the ends — the same four the composer's pickers answer. Tab leaves
// the way every other exit does — focus goes back to the trigger first, and the
// browser tabs on from there rather than from a popup that is about to hide.
elements.sessionMenu.addEventListener("keydown", (event) => {
	if (
		event.key === "ArrowDown" ||
		event.key === "ArrowUp" ||
		event.key === "Home" ||
		event.key === "End"
	) {
		event.preventDefault();
		focusSessionMenuItem(event.key);
		return;
	}
	if (event.key === "Tab") closeSessionMenu();
});
elements.sessionSearch.addEventListener("input", renderSessions);
elements.sessionSearch.addEventListener("keydown", (event) => {
	if (event.key !== "ArrowDown") return;
	const firstSession =
		elements.sessionList.querySelector<HTMLButtonElement>(".session-open");
	if (!firstSession) return;
	event.preventDefault();
	firstSession.focus();
});
elements.sessionList.addEventListener("keydown", (event) => {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	if (!(event.target instanceof HTMLElement)) return;
	const currentRow = event.target.closest<HTMLElement>(".session-row");
	const rows = [
		...elements.sessionList.querySelectorAll<HTMLElement>(".session-row"),
	];
	const index = currentRow ? rows.indexOf(currentRow) : -1;
	if (index < 0) return;
	event.preventDefault();
	if (event.key === "ArrowUp" && index === 0) {
		elements.sessionSearch.focus();
		return;
	}
	const nextIndex =
		event.key === "ArrowDown"
			? Math.min(index + 1, rows.length - 1)
			: index - 1;
	rows[nextIndex]?.querySelector<HTMLButtonElement>(".session-open")?.focus();
});
// No confirmation: pi keeps the current conversation in session history, so
// starting a new session never discards anything.
elements.newSessionButton.addEventListener("click", () =>
	runAction("newSession"),
);
elements.renameSessionButton.addEventListener("click", () =>
	openRenamePrompt(),
);
// Cloning replaces the active session, so it must wait for pi to go idle. The
// button stays clickable while busy; the refusal is a toast, matching the other
// header actions. Closing the menu first keeps focus somewhere real either way:
// an activated item is inside a popup that is about to hide.
elements.cloneSessionButton.addEventListener("click", () => {
	closeSessionMenu();
	if (ui.busy) {
		showToast("Wait for pi to finish before duplicating this session", "error");
		return;
	}
	if (ui.connection !== "ready") return;
	runAction("cloneSession");
});
// The picker is a webview list, so the whole choice happens here and the host
// only executes the entry id it is handed.
elements.forkSessionButton.addEventListener("click", () => {
	if (ui.busy) {
		showToast("Wait for pi to finish before forking this session", "error");
		closeSessionMenu();
		return;
	}
	if (elements.forkPanel.hidden) openForkPicker();
	else closeForkPicker();
});
elements.forkSearch.addEventListener("input", () => renderForkCandidates());
elements.forkSearch.addEventListener("keydown", (event) => {
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		moveActiveFork(event.key === "ArrowDown" ? 1 : -1);
		return;
	}
	if (event.key !== "Enter" || event.isComposing) return;
	event.preventDefault();
	// Enter with nothing highlighted does nothing: the first row is not an obvious
	// default, and a fork is not silently undoable.
	sessionPanels.submitActiveFork();
});
elements.runtimeMeta.addEventListener("click", () => toggleUsagePanel());
document.addEventListener("pointerdown", (event) => {
	if (elements.usagePanel.hidden) return;
	const target = event.target as Node | null;
	if (
		target &&
		(elements.usagePanel.contains(target) ||
			elements.runtimeMeta.contains(target))
	) {
		return;
	}
	dismissUsagePanel();
});
// A hidden webview schedules no refresh at all, so labels are brought back up
// to date the moment it becomes visible again.
document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		if (relativeTimeTimer !== undefined) {
			clearTimeout(relativeTimeTimer);
			relativeTimeTimer = undefined;
		}
		return;
	}
	refreshRelativeTimes();
	// Same reason: a focus request that landed while the sidebar was collapsed is
	// retried only from a render pass, and nothing here is guaranteed to schedule
	// one. The host is waiting on the `composerFocused` reply.
	composerFocusRequests.attempt();
	// No frame ran while the view was hidden, but its geometry kept changing:
	// images finished loading, diagrams mounted, the composer reflowed, and a
	// resync may have replaced nodes. A viewport that was attached owes itself a
	// re-pin once frames run again, before any clamp the drift produced can be
	// mistaken for a reader gesture. A detached one drifted too — its gap moved
	// with no scroll event to report it, and the chip re-reads that gap here.
	if (scrollAnchor.isFollowing) scheduleRender();
	else syncJumpToBottomButton();
});

window.addEventListener("resize", () => selectorController.reposition());

// The send hint is placed against the button's live rect, so a resize that
// moves the composer leaves it floating until it is re-placed.
window.addEventListener("resize", () => {
	if (!elements.sendHint.hidden) showSendHint();
});

elements.messages.addEventListener("click", (event) => {
	const target = event.target as HTMLElement;
	const copyButton = target.closest<HTMLButtonElement>("[data-copy-code]");
	if (copyButton) {
		const code =
			copyButton.closest(".code-block")?.querySelector("code")?.textContent ??
			"";
		void navigator.clipboard
			.writeText(code)
			.then(() => showToast("Copied", "info"));
		return;
	}
	const pathLink = target.closest<HTMLElement>(
		"[data-resource-uri], [data-workspace-path]",
	);
	if (pathLink) {
		event.preventDefault();
		const lineValue = Number(pathLink.dataset.workspaceLine);
		const line =
			Number.isInteger(lineValue) && lineValue >= 1 ? { line: lineValue } : {};
		const resourceUri = pathLink.dataset.resourceUri;
		const workspacePath = pathLink.dataset.workspacePath;
		if (resourceUri) post({ type: "openResource", uri: resourceUri, ...line });
		else if (workspacePath) {
			post({ type: "openWorkspacePath", path: workspacePath, ...line });
		}
		return;
	}
	// Enlarged before the expandable and anchor branches below: a picture inside a
	// collapsible card, or inside a link, is still the thing the reader aimed at.
	const picture = target.closest<HTMLImageElement>(PREVIEWABLE_IMAGE_SELECTOR);
	if (picture) {
		// A picture inside a link consumes the click: the anchor branch below never
		// runs for it, and VS Code's injected handler ignores `defaultPrevented`, so
		// without this the click would open the link as well as the picture.
		if (picture.closest("a[href]")) {
			event.preventDefault();
			event.stopPropagation();
		}
		// Skipped for a picture the host refused or has not answered yet, which has
		// no source to enlarge, and for a click that ended a drag-select: that one is
		// the reader copying text, not asking for a bigger picture.
		const selection = window.getSelection();
		if (picture.hasAttribute("src") && (!selection || selection.isCollapsed)) {
			openImagePreview(picture);
		}
		return;
	}
	// Checked after the path link so a clickable path inside tool output still
	// opens the file rather than collapsing the block around it.
	const expandable = target.closest<HTMLElement>("[data-expandable]");
	if (expandable) {
		toggleExpandable(expandable);
		return;
	}
	const anchor = target.closest<HTMLAnchorElement>("a[href]");
	if (anchor) {
		// VS Code's injected window-level anchor handler opens links with
		// `fromWorkspace: true`, and its trusted-domain validator returns early for
		// that flag in a trusted workspace (`trustedDomains.promptInTrustedWorkspace`
		// defaults to false), so it never prompts. Routing through the host instead
		// reaches the validator without that flag and keeps the prompt. The event
		// must also stop bubbling: that handler ignores `defaultPrevented`, so
		// leaving it to run would open the link a second time, unprompted.
		event.preventDefault();
		event.stopPropagation();
		if (!isExternallyOpenable(anchor.protocol)) {
			showToast("Only http and https links can be opened", "error");
			return;
		}
		post({ type: "openExternal", href: anchor.href });
	}
});

// `<summary>` used to supply keyboard activation for free. The expandables that
// replaced it are plain elements carrying the button role, so Enter and Space
// have to be wired up by hand to honour that role's contract.
elements.messages.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" && event.key !== " ") return;
	// A previewable picture carries the button role, so the gesture that opens it
	// has to answer to the keyboard too: Enter or Space on the picture the reader
	// reached with Tab. Space would otherwise scroll the transcript.
	const picture = (event.target as HTMLElement).closest<HTMLImageElement>(
		PREVIEWABLE_IMAGE_SELECTOR,
	);
	if (picture?.hasAttribute("src")) {
		event.preventDefault();
		openImagePreview(picture);
		return;
	}
	const expandable = (event.target as HTMLElement).closest<HTMLElement>(
		"[data-expandable]",
	);
	if (!expandable) return;
	// Space scrolls the transcript by default, which would move the block the
	// reader just aimed at out from under them.
	event.preventDefault();
	toggleExpandable(expandable);
});



/**
 * Clears a submit the host never answered.
 *
 * `handleActionResult` is the documented place the in-flight submit is settled,
 * so a reply lost while the view was hidden left Enter dead and the send button
 * disabled until the webview reloaded. The host's reply queue covers that path;
 * this is the second line of defence, for a reply that never reached the queue —
 * or that lost the race against an `agent_settled` snapshot, which the host posts
 * without waiting for the submit handler to finish.
 *
 * The condition lives in `snapshotAcknowledgesSubmit`: the snapshot's newest user
 * message has to be this submit's own prompt, stamped at or after the submit. That
 * pairing is what makes acceptance provable rather than merely plausible — a
 * snapshot without it may have arrived mid-flight, where dropping the action would
 * let the reader submit the same prompt twice. A result that arrives later finds
 * no action and no-ops.
 */
function clearUnansweredSubmit(snapshotMessages: readonly PiMessage[]): void {
	for (const [actionId, action] of pendingActions) {
		if (action.type !== "submit" || !action.draft) continue;
		if (action.submittedAtMs === undefined) continue;
		if (
			!snapshotAcknowledgesSubmit(snapshotMessages, {
				draft: action.draft,
				submittedAtMs: action.submittedAtMs,
				clockSkewMs: ui.clockSkewMs,
			})
		) {
			continue;
		}
		pendingActions.delete(actionId);
		applySendSuccess(actionId, action);
		return;
	}
}

/**
 * Applies the success side of an accepted submit or new-session request:
 * clears what was sent from the composer and re-attaches the transcript.
 *
 * Shared with `clearUnansweredSubmit`, which reaches the same state from the
 * other direction — a snapshot proves acceptance before any action result does.
 */
function applySendSuccess(actionId: string, action: PendingAction): void {
	const submittedIds = new Set(action.attachmentIds ?? []);
	ui.attachments = ui.attachments.filter(
		(attachment) => !submittedIds.has(attachment.id),
	);
	composerController.completeSubmittedReferences(action);
	if (action.type === "submit") {
		// The action result can precede or follow the user-message RPC echo. In
		// either order, clearing a multi-line composer is part of the same explicit
		// "show me what I sent" action and must keep the transcript attached.
		submitFollowCoordinator.settleAction(
			actionId,
			true,
			elements.input.getBoundingClientRect().height,
		);
	}
}

function handleActionResult(
	actionId: string,
	ok: boolean,
	error?: string,
	cancelled = false,
): void {
	const action = pendingActions.get(actionId);
	pendingActions.delete(actionId);
	if (action?.type === "submit") {
		if (!ok || cancelled) {
			submitFollowCoordinator.settleAction(actionId, false, 0);
		}
	}
	if (
		ok &&
		!cancelled &&
		action &&
		(action.type === "submit" || action.type === "newSession")
	) {
		applySendSuccess(actionId, action);
	}
	if (ok && !cancelled && action?.type === "pasteImages") {
		showToast("Clipboard image attached", "info");
		announcer.announce("Clipboard image attached");
	}
	if (ok && !cancelled && action?.type === "addResources") {
		showToast("Resources added to the input", "info");
		announcer.announce("Resources added to the input");
	}
	if (
		action?.stagedReferenceId &&
		composerController.isPendingReference(action.stagedReferenceId)
	) {
		composerController.discardPendingReference(action.stagedReferenceId);
	}
	if (ok && !cancelled && action?.type === "deleteSession") {
		showToast("Session deleted", "info");
		announcer.announce("Session deleted");
		if (!elements.historyPanel.hidden) elements.sessionSearch.focus();
	}
	if (ok && !cancelled && action?.type === "renameSession") {
		showToast("Session renamed", "info");
		announcer.announce("Session renamed");
	}
	if (ok && !cancelled && action?.type === "cloneSession") {
		showToast("Session duplicated", "info");
		announcer.announce("Session duplicated");
	}
	if (ok && !cancelled && action?.type === "forkSession") {
		showToast("Session forked", "info");
		announcer.announce("Session forked");
	}
	// The generic error toast below explains the failure; the picker closes because
	// it has no list to show and its entry ids were never delivered.
	if (!ok && action?.type === "listForkCandidates") dismissForkPicker();
	if (!ok) showToast(error ?? "Action failed", "error");
	scheduleRender();
}

/**
 * 流式实时用量：pi 的 message_update 带当次调用的实时 usage，而 snapshot 只在
 * 回复结束后刷新；两者的合成与重置规则见 StreamingUsageTracker。
 */
const streamingUsage = new StreamingUsageTracker();
const { renderQueue, renderWidgets, renderRuntimeMeta, toggleUsagePanel, dismissUsagePanel } = createRuntimeRenderer({
	elements, state: ui, usage: streamingUsage, statuses: extensionStatuses, widgets: extensionWidgets,
});
const sessionController = new SessionController({
	state: ui,
	transcript: transcriptController,
	usage: streamingUsage,
	clearUnansweredSubmit,
	cancelFollow: () => submitFollowCoordinator.cancelAll(),
	clearExtensionUi: () => { extensionStatuses.clear(); extensionWidgets.clear(); },
	scheduleRender,
	announce: (message) => announcer.announce(message),
	now: Date.now,
});

const rpcEventReducer = new RpcEventReducer({
	ui,
	liveTools,
	toolResults,
	streamingPlayback,
	streamingUsage,
	scheduleRender,
	scheduleTranscriptRender: () => frameCoordinator.scheduleTranscriptRender(),
	scheduleAdvance: () => frameCoordinator.scheduleAdvance(),
	renderRuntimeMeta,
	settleStreamingMessage: (message) => transcriptController.settle(message),
	noteUserMessage: (text) => submitFollowCoordinator.noteUserMessage(text),
	hasEquivalentTail: (message) => hasEquivalentTail(ui.messages, message),
	refreshExpandedTool: (toolId) => {
		const section = elements.messages.querySelector<HTMLElement>(
			`.tool-call[data-tool-key="${CSS.escape(toolId)}"]`,
		);
		if (section?.classList.contains("expanded")) refreshExpandedToolBody(section, toolId);
	},
	announce: (message) => announcer.announce(message),
	showToast,
	friendlyToolName,
	setExtensionStatus: (key, value) => extensionStatuses.set(key, value),
	clearExtensionStatus: (key) => extensionStatuses.delete(key),
	setExtensionWidget: (key, lines) => {
		if (lines.length > 0) extensionWidgets.set(key, lines);
		else extensionWidgets.delete(key);
	},
});

const hostMessageHandler = new HostMessageHandler({
	onBootstrap: (message) => {
		ui.connection = message.phase === "no-workspace" ? "no-workspace" : "starting";
		ui.connectionDetail = message.detail ?? "Starting pi...";
		ui.workspaceName = message.workspaceName ?? ui.workspaceName;
		scheduleRender();
	},
	onSnapshot: (message) => sessionController.applySnapshot(message),
	onRpcEvent: (event) => rpcEventReducer.reduce(event),
	onActionResult: (message) => handleActionResult(message.actionId, message.ok, message.error, message.cancelled),
	onSessionList: (message) => {
		ui.sessions = message.sessions;
		renderSessions();
	},
	onForkCandidates: (message) => sessionPanels.applyForkCandidates(message.candidates),
	onCapabilities: (message) => {
		ui.capabilities = message.capabilities;
		scheduleRender();
	},
	onCommandList: (message) => {
		ui.commands = message.commands;
		if (!elements.commandPanel.hidden) renderCommands();
		scheduleRender();
	},
	onWorkspaceFileList: (message) => mentionController.applyResults(message.requestId, message.query, message.entries),
	onMediaResolved: (message) => applyResolvedMedia(message.requestId, message.resolved),
	onAttachments: (message) => {
		ui.attachments = message.attachments;
		scheduleRender();
	},
	onComposerReferences: (message) => {
		const changedReference = composerController.applyIncoming(message.references).at(-1);
		const requestId = message.focusRequestId;
		const focusRequest = typeof requestId === "number" ? composerFocusRequests.accept(requestId) : undefined;
		if (focusRequest) {
			dismissHistory();
			if (focusRequest === "announce") {
				if (changedReference) announcer.announce(`Referenced ${formatComposerReferenceLocation(changedReference)}`);
				else if (composerController.references.length > 0) {
					const count = composerController.references.length;
					announcer.announce(`Pi Agent input focused with ${count} ${count === 1 ? "reference" : "references"}`);
				} else announcer.announce("Pi Agent input focused");
			}
		}
		scheduleRender();
	},
	onNotice: (message) => showToast(message.detail, message.kind),
	onConnection: (message) => sessionController.applyConnection(message.phase, message.detail),
	onSetComposerText: (text) => composerController.setText(text),
});

// Install the listener only after all message dependencies have been initialized.
window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
	hostMessageHandler.handle(event.data);
});
post({ type: "ready" });

function scheduleRender(): void {
	frameCoordinator.scheduleRender();
}

function render(): void {
	headerRenderer.render();
	transcriptController.render();
	transcriptController.restoreThinkingAnchor((offset) => scrollAnchor.adjustBy(offset));
	composerRenderer.renderAttachments();
	renderComposerHighlights();
	composerRenderer.renderSelectors();
	renderQueue();
	renderWidgets();
	renderRuntimeMeta();
	composerRenderer.renderStatusRow();
	composerRenderer.renderSendButton();
	composerRenderer.renderAvailability();
	headerRenderer.renderActions();
	composerRenderer.finishRender();
	composerFocusRequests.attempt();

	// Pin only after all regions finish writing DOM and refreshing time labels.
	refreshRelativeTimes();
	scrollAnchor.stickToBottomIfFollowing();
	syncJumpToBottomButton();
	scheduleTranscriptMeasure();
}


const PREVIEWABLE_IMAGE_SELECTOR = ".message-image, .message-media";

/**
 * Re-pins the bottom once an image finishes loading.
 *
 * An image contributes no height until it decodes, so a transcript that was
 * flush with the bottom drifts away from it the moment one lands. Bound per
 * image, once, and only while following.
 */
function bindImageReflow(root: ParentNode): void {
	for (const image of root.querySelectorAll<HTMLImageElement>(
		PREVIEWABLE_IMAGE_SELECTOR,
	)) {
		// Only a picture with a source can be clicked: one whose path the host has
		// not answered yet has nothing to enlarge.
		if (image.hasAttribute("src")) markPreviewableImage(image);
		bindImageLoadReflow(image);
	}
}

/**
 * Names the gesture that enlarges a picture.
 *
 * A picture, unlike a button, carries no affordance of its own: the click has to
 * be advertised. `cursor: zoom-in` in the stylesheet covers the mouse; the
 * tooltip also reaches the reader who has not tried it. Markdown that titled the
 * image keeps its own text.
 */
function markPreviewableImage(image: HTMLImageElement): void {
	// A picture is not focusable and carries no role, so the gesture has to be
	// advertised and reachable. The tooltip and `cursor: zoom-in` cover the mouse;
	// the button role and a tab stop are what make it available from the keyboard,
	// which the transcript's keydown handler honours.
	image.tabIndex = 0;
	image.setAttribute("role", "button");
	// The alt text already names the picture; only a silent one needs a label.
	if (!image.alt) image.setAttribute("aria-label", "Enlarge image");
	if (image.title) return;
	image.title = "Click to enlarge";
}

/** Opens the enlarged view for one transcript picture. */
function openImagePreview(picture: HTMLImageElement): void {
	modalController.openImage({
		src: picture.currentSrc || picture.src,
		alt: picture.alt,
	});
}

/**
 * Re-anchors the transcript once one image has changed the page height.
 *
 * Called for images that are already laid out as well as for ones whose `src` is
 * about to be set: an `<img>` without a source counts as `complete` in the DOM,
 * so the media resolver has to bind the listener itself or the picture would land
 * under the reader's viewport without the transcript following it.
 */
function bindImageLoadReflow(image: HTMLImageElement): void {
	if (image.complete || image.dataset.scrollBound === "true") return;
	image.dataset.scrollBound = "true";
	image.addEventListener(
		"load",
		() => {
			scrollAnchor.stickToBottomIfFollowing();
			scheduleTranscriptMeasure();
		},
		{ once: true },
	);
}

const MEDIA_IMAGE_SELECTOR = "img[data-media-source]";

/**
 * Fills in the `src` of the image paths the host has already resolved.
 *
 * The renderer writes a path into `data-media-source` rather than `src`, because
 * a webview cannot turn a file path into something it is allowed to load: a
 * relative one resolves against the webview's own origin. Paths with no answer
 * yet are collected into one batch, and `applyResolvedMedia` finishes the images
 * that are already in the DOM when the reply arrives.
 */
function enhanceTranscriptImages(root: ParentNode): void {
	const unanswered = new Set<string>();
	for (const image of root.querySelectorAll<HTMLImageElement>(
		MEDIA_IMAGE_SELECTOR,
	)) {
		if (!applyKnownMedia(image)) continue;
		const source = image.dataset.mediaSource;
		if (source) unanswered.add(source);
	}
	if (unanswered.size === 0) return;
	if (mediaSources.request([...unanswered]).length === 0) return;
	// A source the resolver refused without asking — one too long to survive the
	// parser — still has to become its alt text, or it stays an invisible gap until
	// the next pass rebuilds this node.
	for (const image of root.querySelectorAll<HTMLImageElement>(
		MEDIA_IMAGE_SELECTOR,
	)) {
		applyKnownMedia(image);
	}
}

function applyResolvedMedia(
	requestId: number,
	resolved: ResolvedMediaSource[],
): void {
	if (mediaSources.applyResolved(requestId, resolved).length === 0) return;
	// Every image in the document, not just one message: a batch can cover images
	// from several sections, and by now their nodes may have been rebuilt.
	for (const image of document.querySelectorAll<HTMLImageElement>(
		MEDIA_IMAGE_SELECTOR,
	)) {
		applyKnownMedia(image);
	}
}

/**
 * Applies what the host already knows about one image.
 *
 * Returns true while the source is still unanswered, so the caller can collect it
 * into a batch instead of asking per image.
 */
function applyKnownMedia(image: HTMLImageElement): boolean {
	const source = image.dataset.mediaSource;
	if (!source || image.dataset.mediaState === "resolved") return false;
	const uri = mediaSources.uriFor(source);
	if (uri) {
		image.dataset.mediaState = "resolved";
		image.src = uri;
		markPreviewableImage(image);
		bindImageLoadReflow(image);
		return false;
	}
	if (mediaSources.isRefused(source)) {
		applyMediaFallback(image, source);
		return false;
	}
	return true;
}

/**
 * Replaces an image the sidebar may not load with its alt text.
 *
 * Refusing silently would be worse than a broken image: a transcript naming a
 * path outside the allowed roots should say so, rather than leave a gap the
 * reader cannot tell apart from an image that is still loading.
 */
function applyMediaFallback(image: HTMLImageElement, source: string): void {
	const fallback = document.createElement("span");
	fallback.className = "message-media-fallback";
	fallback.textContent = image.alt || source;
	fallback.title = `Not an image this workspace can load: ${source}`;
	image.replaceWith(fallback);
}




/**
 * Relabels every visible timestamp in place.
 *
 * Deliberately bypasses TranscriptView: a label going from "59s" to "1m" must
 * not re-parse markdown or replace DOM nodes, which would also reset the
 * reader's open disclosures and scroll position.
 */
function refreshRelativeTimes(): void {
	const epochValues: number[] = [];
	for (const node of document.querySelectorAll<HTMLElement>(
		"[data-epoch-ms]",
	)) {
		const epochMs = Number(node.dataset.epochMs);
		if (!Number.isFinite(epochMs)) continue;
		epochValues.push(epochMs);
		applyRelativeTime(node, epochMs);
	}
	scheduleRelativeTimeRefresh(epochValues);
}

function applyRelativeTime(node: HTMLElement, epochMs: number): void {
	const locale = ui.timeContext.locale || undefined;
	const absolute = formatAbsoluteTime(epochMs, locale);
	node.textContent = formatRelativeTime(epochMs, hostNow(), locale);
	node.title = absolute;
	node.setAttribute("aria-label", absolute);
}

/**
 * Wakes only at the next label boundary rather than on a fixed interval, so an
 * idle transcript costs nothing. A hidden webview schedules nothing at all.
 */
function scheduleRelativeTimeRefresh(epochValues: readonly number[]): void {
	if (relativeTimeTimer !== undefined) {
		clearTimeout(relativeTimeTimer);
		relativeTimeTimer = undefined;
	}
	if (document.hidden) return;
	const delay = nextRefreshDelayMs(epochValues, hostNow());
	if (delay === undefined) return;
	relativeTimeTimer = setTimeout(() => {
		relativeTimeTimer = undefined;
		refreshRelativeTimes();
	}, delay);
}



/**
 * Slash-command palette.
 *
 * pi's `prompt` command already recognises a leading `/name` and expands
 * extension commands, prompt templates, and skills itself, so this palette only
 * has to write text into the composer — it never needs to know what a command
 * does. Selecting a row inserts `/name ` rather than submitting, because many
 * commands take arguments (`/deploy prod`); no-argument commands cost one extra
 * Enter in exchange for supporting both.
 *
 * Two entry points share one panel:
 *  - the toolbar button, which owns its own search field, and
 *  - a `/` token typed at the start of a composer line, where the textarea
 *    itself is the search field (`is-inline`).
 */
type CommandPaletteMode = "button" | "inline";

interface InlineCommandToken {
	start: number;
	end: number;
	query: string;
}

const COMMAND_GROUP_ORDER = ["extension", "prompt", "skill"];
const COMMAND_GROUP_LABELS: Record<string, string> = {
	extension: "Extensions",
	prompt: "Prompts",
	skill: "Skills",
};

let commandPaletteMode: CommandPaletteMode | undefined;
let activeCommandName: string | undefined;
let renderedCommandNames: string[] = [];

function commandPaletteQuery(): string {
	if (commandPaletteMode === "inline") return inlineCommandToken()?.query ?? "";
	return elements.commandSearch.value.trim();
}

/**
 * Finds the `/token` the caret currently sits in, or `undefined` when it is not
 * inside one.
 *
 * The token has to start a line so ordinary prose like `and/or` and paths like
 * `src/main.ts` never trigger the palette, and it stops at the first whitespace
 * — once a space is typed the user is writing arguments, not picking a command.
 */
function inlineCommandToken(): InlineCommandToken | undefined {
	const text = elements.input.value;
	const caret = elements.input.selectionStart;
	if (typeof caret !== "number" || caret !== elements.input.selectionEnd)
		return undefined;
	const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
	if (text[lineStart] !== "/") return undefined;
	let end = lineStart + 1;
	while (end < text.length && !/\s/u.test(text[end] ?? "")) end += 1;
	if (caret < lineStart + 1 || caret > end) return undefined;
	return { start: lineStart, end, query: text.slice(lineStart + 1, end) };
}

function matchingCommands(): PiCommand[] {
	return commandsMatching(commandPaletteQuery());
}

function commandsMatching(query: string): PiCommand[] {
	const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
	if (terms.length === 0) return ui.commands;
	return ui.commands.filter((command) => {
		const searchable =
			`${command.name}\n${command.description ?? ""}`.toLocaleLowerCase();
		return terms.every((term) => searchable.includes(term));
	});
}

function renderCommands(): void {
	const commands = matchingCommands();
	renderedCommandNames = commands.map((command) => command.name);
	if (activeCommandName && !renderedCommandNames.includes(activeCommandName))
		activeCommandName = undefined;
	if (!activeCommandName) activeCommandName = renderedCommandNames[0];

	if (commands.length === 0) {
		const empty = document.createElement("div");
		empty.className = "command-list-empty";
		empty.textContent =
			ui.commands.length === 0
				? "No commands available"
				: "No matching commands";
		elements.commandList.replaceChildren(empty);
		setCommandActiveDescendant(undefined);
		return;
	}

	// Unknown sources keep their raw key as a heading instead of being dropped, so
	// a command kind pi adds later still appears.
	const groups = new Map<string, PiCommand[]>();
	for (const command of commands) {
		const key = command.source ?? "other";
		const existing = groups.get(key);
		if (existing) existing.push(command);
		else groups.set(key, [command]);
	}
	const orderedKeys = [
		...COMMAND_GROUP_ORDER.filter((key) => groups.has(key)),
		...[...groups.keys()].filter((key) => !COMMAND_GROUP_ORDER.includes(key)),
	];

	const nodes: HTMLElement[] = [];
	let rowIndex = 0;
	for (const key of orderedKeys) {
		const group = groups.get(key) ?? [];
		if (group.length === 0) continue;
		if (groups.size > 1) {
			const label = document.createElement("div");
			label.className = "command-group-label";
			label.textContent = COMMAND_GROUP_LABELS[key] ?? key;
			nodes.push(label);
		}
		for (const command of group) {
			nodes.push(createCommandRow(command, rowIndex));
			rowIndex += 1;
		}
	}
	elements.commandList.replaceChildren(...nodes);
	highlightActiveCommand(false);
}

function createCommandRow(command: PiCommand, index: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "command-row";
	row.id = `command-row-${index}`;
	row.setAttribute("role", "option");
	row.dataset.command = command.name;
	row.tabIndex = -1;
	// The row shows the name only, so the tooltip carries the description and the
	// source path. Filtering still matches description text — see matchingCommands.
	row.title = [`/${command.name}`, command.description, command.path]
		.filter(Boolean)
		.join("\n");

	const name = document.createElement("span");
	name.className = "command-row-name";
	name.textContent = `/${command.name}`;
	row.append(name);

	if (command.location) {
		const scope = document.createElement("span");
		scope.className = "command-row-scope";
		scope.textContent = command.location;
		row.append(scope);
	}

	row.addEventListener("click", () => insertSlashCommand(command.name));
	return row;
}

/**
 * Marks the active row and points the focused element at it.
 *
 * `aria-activedescendant` has to live on whichever element holds focus, not on
 * the list: in button mode that is the search input, and in inline mode it is the
 * composer textarea. Setting it on the list meant screen readers never announced
 * the highlighted command.
 */
function highlightActiveCommand(scroll = true): void {
	let activeId: string | undefined;
	for (const row of elements.commandList.querySelectorAll<HTMLElement>(
		".command-row",
	)) {
		const active = row.dataset.command === activeCommandName;
		row.classList.toggle("is-active", active);
		row.setAttribute("aria-selected", String(active));
		if (!active) continue;
		activeId = row.id;
		if (scroll) row.scrollIntoView({ block: "nearest" });
	}
	setCommandActiveDescendant(activeId);
}

function commandFocusHost(): HTMLElement {
	return commandPaletteMode === "inline"
		? elements.input
		: elements.commandSearch;
}

function setCommandActiveDescendant(rowId: string | undefined): void {
	// Both hosts are cleared: the mode can flip between renders, and a stale
	// pointer on the other element would outlive the row it names.
	for (const host of [elements.input, elements.commandSearch]) {
		host.removeAttribute("aria-activedescendant");
	}
	if (rowId) commandFocusHost().setAttribute("aria-activedescendant", rowId);
}

function moveActiveCommand(delta: number): void {
	if (renderedCommandNames.length === 0) return;
	const current = activeCommandName
		? renderedCommandNames.indexOf(activeCommandName)
		: -1;
	const next =
		(current + delta + renderedCommandNames.length) %
		renderedCommandNames.length;
	activeCommandName = renderedCommandNames[next];
	highlightActiveCommand();
}

function openCommandPalette(mode: CommandPaletteMode): void {
	if (ui.connection !== "ready") return;
	selectorController.close(false);
	dismissHistory();
	mentionController.dismiss();
	commandPaletteMode = mode;
	activeCommandName = undefined;
	elements.commandPanel.classList.toggle("is-inline", mode === "inline");
	elements.commandPanel.hidden = false;
	elements.commandButton.setAttribute("aria-expanded", "true");
	if (mode === "button") elements.commandSearch.value = "";

	// The snapshot copy renders immediately so the panel never flashes empty; the
	// refresh matters because extensions and skills load independently of the
	// session events that trigger a snapshot.
	renderCommands();
	post({ type: "listCommands" });
	positionCommandPanel();
	if (mode === "button") elements.commandSearch.focus();
}

function dismissCommandPalette(): void {
	if (elements.commandPanel.hidden) return;
	commandPaletteMode = undefined;
	activeCommandName = undefined;
	renderedCommandNames = [];
	elements.commandPanel.hidden = true;
	elements.commandPanel.classList.remove("is-inline");
	setCommandActiveDescendant(undefined);
	elements.commandList.replaceChildren();
	elements.commandButton.setAttribute("aria-expanded", "false");
}

function closeCommandPalette(restoreFocus: boolean): void {
	const wasInline = commandPaletteMode === "inline";
	dismissCommandPalette();
	if (!restoreFocus) return;
	if (wasInline) elements.input.focus();
	else elements.commandButton.focus();
}

function toggleCommandPalette(): void {
	if (elements.commandPanel.hidden) openCommandPalette("button");
	else closeCommandPalette(true);
}

/**
 * Writes `/name ` into the composer.
 *
 * Inline mode replaces the `/token` in place; button mode inserts at the
 * remembered caret. The edit is then pushed through the same path the composer's
 * own `input` handler uses, so a marker destroyed by the insertion is reported to
 * the host rather than only dropped locally.
 */
function insertSlashCommand(name: string): void {
	const text = elements.input.value;
	const insertion = `/${name} `;
	const token =
		commandPaletteMode === "inline" ? inlineCommandToken() : undefined;

	let start = token
		? token.start
		: Math.max(0, Math.min(composerController.lastCaret, text.length));
	let end = token ? token.end : start;
	if (!token) {
		// Never split a marker: land after it instead.
		const marker = composerController.referenceAtOffset(start);
		if (marker && start > marker.start && start < marker.end) {
			start = marker.end;
			end = marker.end;
		}
	}

	composerController.replaceRange(start, end, insertion);
	dismissCommandPalette();
	elements.input.focus();
	announcer.announce(`Inserted /${name}`);
}

/**
 * Re-evaluates the inline palette after the composer changes.
 *
 * Driven from the composer `input` and caret handlers so every edit path lands
 * here: typing `/` at a line start opens it, deleting the slash or typing a
 * space closes it, and moving the caret out of the token closes it too.
 */
function syncInlineCommandPalette(): void {
	const token = inlineCommandToken();
	if (!token) {
		if (commandPaletteMode === "inline") dismissCommandPalette();
		return;
	}
	if (commandPaletteMode === "button") return;
	if (commandPaletteMode === undefined) {
		// A bare `/` always opens, which also refreshes the list. A longer token
		// that matches nothing does not: it was dismissed as prose a keystroke ago,
		// and reopening it here would flip the panel open and shut on every
		// subsequent character.
		if (token.query.length > 0 && commandsMatching(token.query).length === 0)
			return;
		openCommandPalette("inline");
		return;
	}
	renderCommands();
	// A query that matches nothing is just prose, so get out of the way.
	if (renderedCommandNames.length === 0) dismissCommandPalette();
	else positionCommandPanel();
}

/**
 * Handles keys while the inline palette owns the composer.
 *
 * Returns true when the key was consumed so the composer's own Enter-to-send and
 * caret movement stay untouched whenever the palette is closed.
 */
function handleInlineCommandKeydown(event: KeyboardEvent): boolean {
	if (commandPaletteMode !== "inline" || elements.commandPanel.hidden)
		return false;
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		moveActiveCommand(event.key === "ArrowDown" ? 1 : -1);
		return true;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		closeCommandPalette(true);
		return true;
	}
	if (event.key !== "Tab" && event.key !== "Enter") return false;
	if (event.shiftKey || event.isComposing || !activeCommandName) return false;
	event.preventDefault();
	insertSlashCommand(activeCommandName);
	return true;
}

/**
 * Positions the command palette above the composer and matches its width, so the
 * list lines up with the input it writes into.
 */
function positionCommandPanel(): void {
	elements.commandPanel.style.width = `${Math.round(
		elements.composer.getBoundingClientRect().width,
	)}px`;
	positionPopupAbove({
		container: elements.app,
		popup: elements.commandPanel,
		anchor: elements.composer,
	});
}

/**
 * Positions the mention popup on the same anchor as the command palette so both
 * lists occupy the same place above the composer.
 */
function positionMentionPanel(): void {
	elements.mentionPanel.style.width = `${Math.round(
		elements.composer.getBoundingClientRect().width,
	)}px`;
	positionPopupAbove({
		container: elements.app,
		popup: elements.mentionPanel,
		anchor: elements.composer,
	});
}

/**
 * Turns a picked mention into a real composer reference.
 *
 * The final marker is staged locally so there is no empty frame while the host
 * registers its identity. Duplicate picks only remove the query because the
 * existing reference already owns the highlighted marker.
 */
function addMentionReference(
	resource: WorkspaceReferenceSuggestion,
	token: { start: number; end: number },
): void {
	const alreadyReferenced = composerController
		.managedReferences()
		.some(
			(reference) =>
				reference.kind === resource.kind &&
				reference.displayPath === resource.displayPath,
		);
	if (
		!alreadyReferenced &&
		composerController.referenceCount >= MAX_COMPOSER_REFERENCE_COUNT
	) {
		showToast(
			`Remove a reference before adding another (maximum ${MAX_COMPOSER_REFERENCE_COUNT})`,
			"error",
		);
		return;
	}
	if (alreadyReferenced) {
		composerController.replaceRange(token.start, token.end, "");
		elements.input.focus();
		return;
	}
	const stagedReferenceId =
		resource.kind === "directory"
			? composerController.stageDirectoryReference(
					resource.displayPath,
					token.start,
					token.end,
				)
			: composerController.stageFileReference(
					resource.displayPath,
					token.start,
					token.end,
				);
	elements.input.focus();
	runAction("addResources", {
		resources: [resource.uri],
		stagedReferenceId,
	});
}

function isAttachableResourceDrag(
	dataTransfer: DataTransfer | null,
): dataTransfer is DataTransfer {
	return Boolean(
		dataTransfer &&
		ui.connection === "ready" &&
		containsDroppedResources(dataTransfer),
	);
}

function clearResourceDragState(): void {
	resourceDragDepth = 0;
	elements.resourceDropOverlay.hidden = true;
	elements.app.classList.remove("is-resource-drag");
}

function sendPrompt(delivery?: SubmitDelivery): void {
	if (
		isSubmitPending() ||
		ui.connection !== "ready" ||
		composerController.hasPendingReferences
	)
		return;
	const text = elements.input.value;
	if (
		!text.trim() &&
		ui.attachments.length === 0 &&
		composerController.references.length === 0
	)
		return;
	// The send button can be clicked while the palette is open, and submitting
	// clears the text the palette was filtering on.
	dismissCommandPalette();
	mentionController.dismiss();
	// Nothing latches the submit here: registering the `submit` action inside
	// `runAction` below is what marks one in flight, and `isSubmitPending()` reads
	// that as the single source of the fact.
	//
	// Sending is an explicit "show me what happens next", so it re-attaches the
	// transcript to its bottom edge even if the reader had scrolled up.
	scrollAnchor.follow();
	const actionId = runAction("submit", {
		text,
		attachmentIds: ui.attachments.map((attachment) => attachment.id),
		references: composerController.references.map((reference) => ({
			id: reference.id,
			revision: reference.revision,
			start: reference.start,
			end: reference.end,
		})),
		delivery,
	});
	submitFollowCoordinator.start(
		actionId,
		text,
		elements.input.getBoundingClientRect().height,
	);
	scheduleRender();
}

function abortRun(): void {
	if (ui.connection !== "ready") return;
	runAction("abort");
}

function runAction(
	type:
		| "submit"
		| "abort"
		| "newSession"
		| "cloneSession"
		| "listForkCandidates"
		| "forkSession"
		| "switchSession"
		| "deleteSession"
		| "renameSession"
		| "setModel"
		| "setThinking"
		| "compact"
		| "restart"
		| "addResources"
		| "pasteImages",
	fields: JsonRecord = {},
): string {
	const actionId = crypto.randomUUID();
	const action: PendingAction = { type };
	if (typeof fields.stagedReferenceId === "string") {
		action.stagedReferenceId = fields.stagedReferenceId;
	}
	if (type === "submit" || type === "newSession") {
		action.draft = elements.input.value;
		action.attachmentIds = ui.attachments.map((attachment) => attachment.id);
		action.referenceSnapshots = composerController.snapshotReferences();
	}
	// The snapshot recovery needs to tell this submit's own prompt from an
	// identical one the reader sent earlier in the session.
	if (type === "submit") action.submittedAtMs = Date.now();
	pendingActions.set(actionId, action);
	const { stagedReferenceId: _stagedReferenceId, ...outgoingFields } = fields;
	post({ type, actionId, ...outgoingFields } as WebviewToHostMessage);
	return actionId;
}

function post(message: WebviewToHostMessage): void {
	vscode.postMessage(message);
}

/**
 * Renames the current session through pi's `set_session_name` RPC, which only
 * applies to the active session. The name is left empty when the session has
 * no custom name yet, so a message-derived title is never offered as an
 * editing target.
 */
function openRenamePrompt(): void {
	modalController.openTextPrompt({
		title: "Rename session",
		label: "Session name",
		initialValue: ui.state.sessionName ?? "",
		confirmLabel: "Rename",
		maxLength: MAX_SESSION_NAME_LENGTH,
		onSubmit: (name: string) => runAction("renameSession", { name }),
	});
}

/**
 * Whether the host will open a link with this protocol.
 *
 * The host throws for anything but HTTP and HTTPS, and a thrown error on a
 * message carrying no `actionId` is reported as a fatal `connection: error`:
 * the in-flight reply is marked aborted, sending is disabled, and the banner
 * offers only Restart. Relative links (`[doc](README.md)`), fragments
 * (`#section`) and `mailto:` all arrive at the anchor branch, so the scheme is
 * checked before the round trip turns a stray click into a dead session.
 */
function isExternallyOpenable(protocol: string): boolean {
	return protocol === "http:" || protocol === "https:";
}

function showToast(message: string, kind: "info" | "error"): void {
	const toast = document.createElement("div");
	toast.className = `toast ${kind}`;
	toast.textContent = message;
	elements.toastRegion.append(toast);
	setTimeout(() => toast.remove(), 4_500);
}

function updateComposerOverlayOffset(): void {
	const appRect = elements.app.getBoundingClientRect();
	const composerRect = elements.composerShell.getBoundingClientRect();
	const offset = Math.max(8, Math.round(appRect.bottom - composerRect.top + 8));
	elements.app.style.setProperty("--pi-composer-overlay-offset", `${offset}px`);
}

/**
 * Names what Enter and Alt+Enter will do, next to the button that does it.
 *
 * Enter is not one action: pi rejects a prompt sent mid-run unless a delivery
 * mode is attached, so the host steers a plain Enter while pi is streaming and
 * sends it outright while pi is idle. The hint therefore has to follow the run
 * state instead of stating one fixed pair of labels.
 *
 * The screen reader equivalent lives in `#prompt-input-help`, so this stays
 * `aria-hidden` rather than announcing the same thing twice.
 */
function showSendHint(): void {
	if (elements.sendButton.disabled) return;
	const rows: Array<[keys: string[], label: string]> = [
		[["Enter"], ui.busy ? "steer" : "send"],
		[["Alt+Enter"], "follow-up"],
	];
	elements.sendHint.replaceChildren(
		...rows.map(([keys, label]) => {
			const row = document.createElement("span");
			row.className = "send-hint-row";
			for (const key of keys) {
				const kbd = document.createElement("kbd");
				kbd.textContent = key;
				row.append(kbd);
			}
			const text = document.createElement("span");
			text.textContent = label;
			row.append(text);
			return row;
		}),
	);
	elements.sendHint.hidden = false;
	positionPopupAbove({
		container: elements.app,
		popup: elements.sendHint,
		anchor: elements.sendButton,
		gap: 6,
		minHeight: 0,
	});
}

function hideSendHint(): void {
	elements.sendHint.hidden = true;
}

function resizeInput(): void {
	elements.input.style.height = "auto";
	elements.input.style.height = `${Math.min(elements.input.scrollHeight, 150)}px`;
}


/**
 * The host's wall clock, corrected for webview clock skew.
 *
 * Remote SSH runs pi on another machine, so a message timestamp is compared
 * against the host's clock rather than the webview's.
 */
function hostNow(): number {
	return Date.now() + ui.clockSkewMs;
}

function createCodicon(name: string): HTMLElement {
	const icon = document.createElement("i");
	icon.className = `codicon codicon-${name}`;
	icon.setAttribute("aria-hidden", "true");
	return icon;
}

function sanitizedNodes(html: string): Node[] {
	const sanitized = DOMPurify.sanitize(html, TRANSCRIPT_SANITIZE_OPTIONS);
	const parsed = new DOMParser().parseFromString(sanitized, "text/html");
	return [...parsed.body.childNodes].map((node) =>
		document.importNode(node, true),
	);
}

function element<T extends HTMLElement>(id: string): T {
	const value = document.querySelector(`#${CSS.escape(id)}`);
	if (!value) throw new Error(`Missing #${id}`);
	return value as T;
}
