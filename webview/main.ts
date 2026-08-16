import DOMPurify from "dompurify";
import { formatComposerReferenceLocation } from "../shared/composerReferences.js";
import { handleImagePaste } from "./attachments/imagePaste.js";
import type { ManagedComposerReference } from "./composer/model.js";
import { ComposerController } from "./composer/controller.js";
import { MentionController } from "./composer/mentions.js";
import { applyAssistantMessageDelta } from "./transcript/streaming.js";
import {
	contentText,
	extractResultDiff,
	friendlyToolName,
	messageHtml,
} from "./transcript/renderer.js";
import {
	containsDroppedResources,
	extractDroppedResources,
} from "./resourceDrop.js";
import {
	ModalController,
	type ConfirmDialogOptions,
} from "./ui/modalController.js";
import { positionPopupAbove } from "./ui/popupPosition.js";
import { SelectController } from "./ui/selectController.js";
import {
	MAX_COMPOSER_REFERENCE_COUNT,
	type AttachmentRef,
	type HostToWebviewMessage,
	type JsonRecord,
	type PiCommand,
	type PiMessage,
	type PiModel,
	type PiState,
	type PiStats,
	type SessionSummary,
	type WebviewToHostMessage,
	type WorkspaceFileSuggestion,
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

interface LiveTool {
	id: string;
	name: string;
	args: JsonRecord;
	status: "running" | "success" | "error";
	output: string;
	diff?: string;
	startedAt: number;
}

interface PendingAction {
	type: string;
	draft?: string;
	attachmentIds?: string[];
	referenceSnapshots?: ManagedComposerReference[];
}

interface ConfirmOptions extends ConfirmDialogOptions {
	dismissHistory?: boolean;
}

interface UiState {
	connection: "starting" | "ready" | "disconnected" | "error" | "no-workspace";
	connectionDetail: string;
	workspaceName: string;
	state: PiState;
	stats?: PiStats;
	messages: PiMessage[];
	streamingMessage?: PiMessage;
	models: PiModel[];
	thinkingLevels: string[];
	commands: PiCommand[];
	attachments: AttachmentRef[];
	sessions: SessionSummary[];
	queue: { steering: string[]; followUp: string[] };
	busy: boolean;
}

const vscode = acquireVsCodeApi<PersistedState>();

const ui: UiState = {
	connection: "starting",
	connectionDetail: "Starting pi...",
	workspaceName: "",
	state: {},
	messages: [],
	models: [],
	thinkingLevels: ["off"],
	commands: [],
	attachments: [],
	sessions: [],
	queue: { steering: [], followUp: [] },
	busy: false,
};

const liveTools = new Map<string, LiveTool>();
const pendingActions = new Map<string, PendingAction>();
const extensionStatuses = new Map<string, string>();
const extensionWidgets = new Map<string, string[]>();
let renderQueued = false;
let pendingSubmit = false;
let composerFocusRequestId: number | undefined;
let composerFocusQueued = false;
let lastAnnouncedFocusRequestId = 0;
let lastCompletedFocusRequestId = 0;
let renderedPromptText: string | undefined;
let renderedPromptMarkerSignature: string | undefined;
let resourceDragDepth = 0;

const MAX_SESSION_NAME_LENGTH = 200;
const MAX_HIGHLIGHTED_COMPOSER_LENGTH = 200_000;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const ORPHAN_SGR_PATTERN = /\[(?:\d{1,3}(?:;\d{1,3})*)m/gu;

const elements = {
	app: element<HTMLElement>("app"),
	sessionHeader: element<HTMLElement>("session-header"),
	transcript: element<HTMLElement>("transcript"),
	messages: element<HTMLElement>("messages"),
	emptyState: element<HTMLElement>("empty-state"),
	emptyDetail: element<HTMLElement>("empty-detail"),
	connectionDot: element<HTMLElement>("connection-dot"),
	connectionBanner: element<HTMLElement>("connection-banner"),
	sessionTitle: element<HTMLElement>("session-title"),
	renameSessionButton: element<HTMLButtonElement>("rename-session-button"),
	historyButton: element<HTMLButtonElement>("history-button"),
	newSessionButton: element<HTMLButtonElement>("new-session-button"),
	historyPanel: element<HTMLElement>("history-panel"),
	sessionSearch: element<HTMLInputElement>("session-search"),
	sessionList: element<HTMLElement>("session-list"),
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
	runtimeMeta: element<HTMLElement>("runtime-meta"),
	toastRegion: element<HTMLElement>("toast-region"),
	liveStatus: element<HTMLElement>("live-status"),
	modalBackdrop: element<HTMLElement>("modal-backdrop"),
};

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
		announce,
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
 * Picking a row goes through `addResources`, the same host path the Explorer drag
 * and drop uses, so the host stays the single owner of reference identity,
 * revisions, and marker text. The webview only removes the typed `@query` — the
 * marker itself arrives back as a `composerReferences` update.
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
	announce,
	isEnabled: () => ui.connection === "ready" && !elements.input.disabled,
	position: positionMentionPanel,
	isProtectedOffset: (offset) =>
		Boolean(composerController.referenceAtOffset(offset)),
});
resizeInput();
renderComposerHighlights();

window.addEventListener(
	"message",
	(event: MessageEvent<HostToWebviewMessage>) => {
		handleHostMessage(event.data);
	},
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
	if (mentionController.isOpen) {
		mentionController.dismiss();
		return;
	}
	if (!elements.commandPanel.hidden) {
		closeCommandPalette(true);
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
});

elements.input.addEventListener("input", () => {
	composerController.handleInput();
	syncInlineCommandPalette();
	mentionController.sync();
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
	reflowComposerTools();
	selectorController.reposition();
	if (!elements.commandPanel.hidden) positionCommandPanel();
	mentionController.reposition();
});
composerToolsResizeObserver.observe(elements.composerTools);

// Keep floating feedback immediately above the composer when attachments or a
// multi-line draft change its height.
const composerShellResizeObserver = new ResizeObserver(
	updateComposerOverlayOffset,
);
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
		if (!reference) return;
		event.preventDefault();
		post({ type: "openComposerReference", id: reference.id });
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
		announce("Drop files to add as context");
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
		showToast("Could not read the dropped VS Code files", "error");
		return;
	}
	const availableReferenceCount = Math.max(
		0,
		MAX_COMPOSER_REFERENCE_COUNT - composerController.references.length,
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
	if (!reference) return;
	post({ type: "openComposerReference", id: reference.id });
});

elements.composer.addEventListener("submit", (event) => {
	event.preventDefault();
	if (ui.busy) abortRun();
	else sendPrompt();
});

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
elements.newSessionButton.addEventListener("click", () => {
	if (ui.messages.length > 0) {
		openConfirm({
			title: "New session",
			message: "The current conversation stays available in session history.",
			confirmLabel: "New Session",
			dismissHistory: true,
			onConfirm: () => runAction("newSession"),
		});
	} else {
		runAction("newSession");
	}
});
elements.renameSessionButton.addEventListener("click", () =>
	openRenamePrompt(),
);

window.addEventListener("resize", () => selectorController.reposition());

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
		post({ type: "openExternal", href: anchor.href });
	}
});

post({ type: "ready" });

function handleHostMessage(message: HostToWebviewMessage): void {
	switch (message.type) {
		case "bootstrap": {
			ui.connection =
				message.phase === "no-workspace" ? "no-workspace" : "starting";
			ui.connectionDetail = message.detail ?? "Starting pi...";
			ui.workspaceName = message.workspaceName ?? ui.workspaceName;
			scheduleRender();
			break;
		}
		case "snapshot": {
			applySnapshot(message);
			break;
		}
		case "rpcEvent": {
			reduceRpcEvent(message.event);
			break;
		}
		case "actionResult": {
			handleActionResult(message.actionId, message.ok, message.error);
			break;
		}
		case "sessionList": {
			ui.sessions = message.sessions;
			renderSessions();
			break;
		}
		case "commandList": {
			ui.commands = message.commands;
			if (!elements.commandPanel.hidden) renderCommands();
			break;
		}
		case "workspaceFileList": {
			mentionController.applyResults(
				message.requestId,
				message.query,
				message.entries,
			);
			break;
		}
		case "attachments": {
			ui.attachments = message.attachments;
			scheduleRender();
			break;
		}
		case "composerReferences": {
			const changedReference = composerController
				.applyIncoming(message.references)
				.at(-1);
			const requestId = message.focusRequestId;
			if (
				typeof requestId === "number" &&
				Number.isInteger(requestId) &&
				requestId > lastCompletedFocusRequestId &&
				requestId >= (composerFocusRequestId ?? 0)
			) {
				composerFocusRequestId = requestId;
				dismissHistory();
				if (requestId > lastAnnouncedFocusRequestId) {
					lastAnnouncedFocusRequestId = requestId;
					if (changedReference) {
						announce(
							`Referenced ${formatComposerReferenceLocation(changedReference)}`,
						);
					} else if (composerController.references.length > 0) {
						announce(
							`Pi Agent input focused with ${composerController.references.length} ${composerController.references.length === 1 ? "reference" : "references"}`,
						);
					} else {
						announce("Pi Agent input focused");
					}
				}
			}
			scheduleRender();
			break;
		}
		case "connection": {
			applyConnection(message.phase, message.detail);
			break;
		}
		case "setComposerText": {
			composerController.setText(message.text);
			break;
		}
		default:
			break;
	}
}

function applySnapshot(
	message: Extract<HostToWebviewMessage, { type: "snapshot" }>,
): void {
	const sessionChanged = Boolean(
		ui.state.sessionId && ui.state.sessionId !== message.state.sessionId,
	);
	ui.state = message.state;
	ui.messages = message.messages;
	ui.stats = message.stats;
	ui.models = message.models;
	ui.thinkingLevels = message.thinkingLevels;
	ui.commands = message.commands;
	ui.workspaceName = message.workspaceName;
	ui.busy = Boolean(message.state.isStreaming || message.state.isCompacting);
	ui.streamingMessage = undefined;
	liveTools.clear();
	if (sessionChanged) {
		extensionStatuses.clear();
		extensionWidgets.clear();
	}
	scheduleRender();
}

function applyConnection(
	phase: "starting" | "ready" | "disconnected" | "error",
	detail?: string,
): void {
	ui.connection = phase;
	ui.connectionDetail = phase === "ready" ? "" : (detail ?? "");
	if (phase === "starting") {
		extensionStatuses.clear();
		extensionWidgets.clear();
	}
	if (phase === "disconnected" || phase === "error")
		finishInterruptedRun(detail);
	announce(phase === "ready" ? "Pi is ready" : detail || `Pi is ${phase}`);
	scheduleRender();
}

function finishInterruptedRun(detail?: string): void {
	ui.busy = false;
	if (ui.streamingMessage) {
		const interrupted = { ...ui.streamingMessage, stopReason: "aborted" };
		if (!hasEquivalentTail(ui.messages, interrupted))
			ui.messages.push(interrupted);
		ui.streamingMessage = undefined;
	}
	for (const tool of liveTools.values()) {
		if (tool.status === "running") {
			tool.status = "error";
			if (!tool.output)
				tool.output = detail || "Pi disconnected before this tool completed.";
		}
	}
	extensionStatuses.clear();
	extensionWidgets.clear();
}

function handleActionResult(
	actionId: string,
	ok: boolean,
	error?: string,
): void {
	const action = pendingActions.get(actionId);
	pendingActions.delete(actionId);
	if (action?.type === "submit") pendingSubmit = false;
	if (
		ok &&
		action &&
		(action.type === "submit" || action.type === "newSession")
	) {
		const submittedIds = new Set(action.attachmentIds ?? []);
		ui.attachments = ui.attachments.filter(
			(attachment) => !submittedIds.has(attachment.id),
		);
		composerController.completeSubmittedReferences(action);
	}
	if (ok && action?.type === "pasteImages") {
		showToast("Clipboard image attached", "info");
		announce("Clipboard image attached");
	}
	if (ok && action?.type === "addResources") {
		showToast("Resources added to the input", "info");
		announce("Resources added to the input");
	}
	if (ok && action?.type === "deleteSession") {
		showToast("Session deleted", "info");
		announce("Session deleted");
		if (!elements.historyPanel.hidden) elements.sessionSearch.focus();
	}
	if (ok && action?.type === "renameSession") {
		showToast("Session renamed", "info");
		announce("Session renamed");
	}
	if (!ok) showToast(error ?? "Action failed", "error");
	scheduleRender();
}

function reduceRpcEvent(event: JsonRecord): void {
	switch (event.type) {
		case "agent_start":
			ui.busy = true;
			announce("Pi started working");
			break;
		case "agent_settled":
			ui.busy = false;
			announce("Pi finished responding");
			break;
		case "message_start": {
			const message = asMessage(event.message);
			if (!message) break;
			if (message.role === "assistant") ui.streamingMessage = message;
			else if (
				(message.role === "user" || message.role === "custom") &&
				!hasEquivalentTail(ui.messages, message)
			)
				ui.messages.push(message);
			break;
		}
		case "message_update": {
			if (event.assistantMessageEvent !== undefined && ui.streamingMessage) {
				ui.streamingMessage = applyAssistantMessageDelta(
					ui.streamingMessage,
					event,
				);
			} else {
				// Older pi builds sent a cumulative message snapshot here.
				const message = asMessage(event.message);
				if (message) ui.streamingMessage = message;
			}
			break;
		}
		case "message_end": {
			const message = asMessage(event.message);
			if (!message) break;
			if (message.role === "assistant") {
				if (!hasEquivalentTail(ui.messages, message)) ui.messages.push(message);
				ui.streamingMessage = undefined;
			} else if (
				(message.role === "toolResult" || message.role === "custom") &&
				!hasEquivalentTail(ui.messages, message)
			) {
				ui.messages.push(message);
			}
			break;
		}
		case "tool_execution_start": {
			const id = stringValue(event.toolCallId);
			if (!id) break;
			liveTools.set(id, {
				id,
				name: stringValue(event.toolName) || "tool",
				args: objectValue(event.args),
				status: "running",
				output: "",
				startedAt: Date.now(),
			});
			break;
		}
		case "tool_execution_update": {
			const id = stringValue(event.toolCallId);
			const tool = liveTools.get(id);
			if (!tool) break;
			tool.output = extractResultText(event.partialResult);
			break;
		}
		case "tool_execution_end": {
			const id = stringValue(event.toolCallId);
			const existing = liveTools.get(id);
			const eventArgs = objectValue(event.args);
			const status = event.isError === true ? "error" : "success";
			const toolName = stringValue(event.toolName) || existing?.name || "tool";
			liveTools.set(id, {
				id,
				name: toolName,
				args:
					Object.keys(eventArgs).length > 0
						? eventArgs
						: (existing?.args ?? {}),
				status,
				output: extractResultText(event.result),
				diff: extractResultDiff(event.result),
				startedAt: existing?.startedAt ?? Date.now(),
			});
			announce(
				`${friendlyToolName(toolName)} ${status === "error" ? "failed" : "completed"}`,
			);
			break;
		}
		case "queue_update":
			ui.queue = {
				steering: stringArray(event.steering),
				followUp: stringArray(event.followUp),
			};
			break;
		case "compaction_start":
			ui.busy = true;
			extensionStatuses.set("compaction", "Compacting context...");
			break;
		case "compaction_end":
			extensionStatuses.delete("compaction");
			break;
		case "auto_retry_start":
			extensionStatuses.set(
				"retry",
				`Retrying (${numberValue(event.attempt)}/${numberValue(event.maxAttempts)})...`,
			);
			break;
		case "auto_retry_end":
			extensionStatuses.delete("retry");
			break;
		case "extension_error":
			showToast(stringValue(event.error) || "A pi extension failed", "error");
			break;
		case "extension_ui_request":
			reduceExtensionUiEvent(event);
			break;
		default:
			break;
	}
	scheduleRender();
}

function reduceExtensionUiEvent(event: JsonRecord): void {
	const method = stringValue(event.method);
	if (method === "setStatus") {
		const key = stringValue(event.statusKey);
		const text = cleanExtensionText(stringValue(event.statusText));
		if (key && text) extensionStatuses.set(key, text);
		else if (key) extensionStatuses.delete(key);
	}
	if (method === "setWidget") {
		const key = stringValue(event.widgetKey);
		const lines = stringArray(event.widgetLines)
			.map(cleanExtensionText)
			.filter(Boolean);
		if (key && lines.length > 0) extensionWidgets.set(key, lines);
		else if (key) extensionWidgets.delete(key);
	}
}

function scheduleRender(): void {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(() => {
		renderQueued = false;
		render();
	});
}

function render(): void {
	const nearBottom =
		elements.transcript.scrollHeight -
			elements.transcript.scrollTop -
			elements.transcript.clientHeight <
		96;
	const hasMessages =
		ui.messages.length > 0 || Boolean(ui.streamingMessage) || pendingSubmit;
	const title = deriveSessionTitle();
	const working = ui.busy || pendingSubmit;

	elements.sessionTitle.textContent = title;
	elements.sessionTitle.title = title;
	elements.emptyState.hidden = hasMessages;
	elements.emptyDetail.textContent =
		ui.connection === "ready"
			? `Ready in ${ui.workspaceName}`
			: ui.connectionDetail || "Starting pi...";

	elements.app.classList.toggle("is-working", working);
	elements.connectionDot.className = `connection-dot ${ui.connection}`;
	elements.connectionDot.title = connectionLabel();
	elements.connectionDot.setAttribute("aria-label", connectionLabel());
	elements.transcript.setAttribute("aria-busy", String(working));
	renderConnectionBanner();
	renderMessages();
	renderAttachments();
	renderComposerHighlights();
	renderSelectors();
	renderQueue();
	renderWidgets();
	renderRuntimeMeta();
	renderComposerStatusRow();
	renderSendButton();

	const enabled = ui.connection === "ready";
	elements.input.disabled = !enabled;
	elements.attachButton.disabled = !enabled;
	elements.commandButton.disabled = !enabled;
	elements.renameSessionButton.disabled = !enabled;
	elements.modelSelect.disabled = !enabled || ui.models.length === 0;
	elements.thinkingSelect.disabled = !enabled || ui.thinkingLevels.length <= 1;
	const activeSelect = selectorController.activeKind;
	if (activeSelect && selectorController.trigger(activeSelect).disabled) {
		selectorController.close(false);
	}
	if (!enabled) {
		dismissCommandPalette();
		mentionController.dismiss();
	}
	reflowComposerTools();
	focusComposerIfRequested();

	if (nearBottom) scrollTranscriptToBottom();
}

/**
 * Chooses how much of the composer toolbar fits.
 *
 * Three states, widest first: both pickers labelled, both as icons, then both
 * hidden. Every control is shown at full size or not at all, and the row's gaps
 * are identical in all three — narrowing the sidebar removes controls but never
 * squeezes, truncates, or clips them.
 *
 * The last state is not optional. A VS Code sidebar drags down to roughly 170px,
 * which leaves about 128px inside the composer's padding, while five controls need
 * about 158px. Something has to go, and hiding whole controls beats slicing an
 * icon in half.
 *
 * Known limitation: while hidden, model and thinking cannot be changed from this
 * view at all — the extension registers no command for either, and the status row
 * reports only context and cost. Widening the sidebar restores both pickers.
 *
 * Measured rather than driven by a media query because label widths range from
 * "Max" to "Claude Sonnet 4.5 (latest)", so no fixed breakpoint is right for
 * every model. All reads happen in one frame, so intermediate states are never
 * painted.
 */
function reflowComposerTools(): void {
	const tools = elements.composerTools;
	tools.classList.remove("is-icons", "is-minimal");
	if (tools.scrollWidth <= tools.clientWidth) return;
	tools.classList.add("is-icons");
	if (tools.scrollWidth <= tools.clientWidth) return;
	tools.classList.add("is-minimal");
}

function scrollTranscriptToBottom(): void {
	elements.transcript.scrollTop = elements.transcript.scrollHeight;
	for (const image of elements.messages.querySelectorAll<HTMLImageElement>(
		".message-image",
	)) {
		if (image.complete || image.dataset.scrollBound === "true") continue;
		image.dataset.scrollBound = "true";
		image.addEventListener(
			"load",
			() => {
				elements.transcript.scrollTop = elements.transcript.scrollHeight;
			},
			{ once: true },
		);
	}
}

function renderConnectionBanner(): void {
	const show =
		ui.connection === "disconnected" ||
		ui.connection === "error" ||
		ui.connection === "no-workspace";
	elements.connectionBanner.hidden = !show;
	if (!show) return;

	elements.connectionBanner.replaceChildren();
	const text = document.createElement("span");
	text.textContent = ui.connectionDetail || "Pi is unavailable.";
	elements.connectionBanner.append(text);
	if (ui.connection !== "no-workspace") {
		const restart = document.createElement("button");
		restart.type = "button";
		restart.className = "text-button";
		restart.append(
			createCodicon("refresh"),
			document.createTextNode(" Restart"),
		);
		restart.addEventListener("click", () => runAction("restart"));
		elements.connectionBanner.append(restart);
	}
}

function renderMessages(): void {
	const openToolKeys = new Set(
		[
			...elements.messages.querySelectorAll<HTMLDetailsElement>(
				".tool-call[open]",
			),
		]
			.map((details) => details.dataset.toolKey)
			.filter((key): key is string => Boolean(key)),
	);
	const openThinkingKeys = new Set(
		[
			...elements.messages.querySelectorAll<HTMLDetailsElement>(
				".thinking-block[open]:not(.streaming)",
			),
		]
			.map((details) => details.dataset.thinkingKey)
			.filter((key): key is string => Boolean(key)),
	);
	const resultMap = buildToolResultMap();
	const streamingMessage = ui.streamingMessage;
	// pi opens assistant messages with an empty `content: []` and fills them
	// via message_update deltas. Rendering that empty shell would insert a
	// blank message slot (20px of flex gap plus the article) that shoves a
	// bottom-anchored transcript up before the first delta arrives — the
	// visible "jump" right as streaming starts. Skip the placeholder until a
	// content block exists; the busy indicator already covers the gap.
	let streamingVisible = false;
	if (streamingMessage) {
		const content = streamingMessage.content;
		streamingVisible =
			typeof content === "string"
				? content.length > 0
				: Array.isArray(content) && content.length > 0;
	}
	const allMessages =
		streamingVisible && streamingMessage
			? [...ui.messages, streamingMessage]
			: ui.messages;
	const visible = allMessages.slice(-150);
	const omitted = allMessages.length - visible.length;
	let html =
		omitted > 0
			? `<div class="history-omitted">${omitted} earlier messages omitted</div>`
			: "";

	for (const [index, message] of visible.entries())
		html += messageHtml(
			message,
			resultMap,
			liveTools,
			message === ui.streamingMessage,
			`message-${omitted + index}`,
		);
	elements.messages.replaceChildren(...sanitizedNodes(html));
	for (const details of elements.messages.querySelectorAll<HTMLDetailsElement>(
		".tool-call[data-tool-key]",
	)) {
		if (details.dataset.toolKey && openToolKeys.has(details.dataset.toolKey))
			details.open = true;
	}
	for (const details of elements.messages.querySelectorAll<HTMLDetailsElement>(
		".thinking-block[data-thinking-key]:not(.streaming)",
	)) {
		if (
			details.dataset.thinkingKey &&
			openThinkingKeys.has(details.dataset.thinkingKey)
		)
			details.open = true;
	}

	for (const pre of elements.messages.querySelectorAll("pre")) {
		if (pre.parentElement?.classList.contains("tool-output")) continue;
		if (pre.parentElement?.classList.contains("code-block")) continue;
		// The button must live outside the scrolling <pre> so horizontal scrolling
		// cannot drag it along: an absolute child is positioned against the
		// scroll container's content box, not its visible frame.
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

	linkifyWorkspacePaths();
}

const WORKSPACE_PATH_PATTERN =
	/\b([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z][\w]*)(?::(\d+))?/gu;

/**
 * Walk rendered assistant/user message text nodes and turn `path/to/file.ts`
 * or `path/to/file.ts:42` tokens into clickable spans. Code blocks, links,
 * and already-processed nodes are skipped so inline code stays literal.
 */
function linkifyWorkspacePaths(): void {
	const walker = document.createTreeWalker(
		elements.messages,
		NodeFilter.SHOW_TEXT,
		{
			acceptNode(node): number {
				const parent = node.parentElement;
				if (!parent) return NodeFilter.FILTER_REJECT;
				// Skip code BLOCKS (pre), links, tool/thinking widgets, and
				// already-linkified spans. Inline <code> is allowed so paths that
				// pi wraps in backticks still become clickable.
				if (
					parent.closest(
						"pre, a, .tool-call, .thinking-block, [data-workspace-path]",
					)
				) {
					return NodeFilter.FILTER_REJECT;
				}
				WORKSPACE_PATH_PATTERN.lastIndex = 0;
				return WORKSPACE_PATH_PATTERN.test(node.nodeValue ?? "")
					? NodeFilter.FILTER_ACCEPT
					: NodeFilter.FILTER_REJECT;
			},
		},
	);
	const targets: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		targets.push(node as Text);
	}
	for (const textNode of targets) {
		const text = textNode.nodeValue ?? "";
		WORKSPACE_PATH_PATTERN.lastIndex = 0;
		const fragment = document.createDocumentFragment();
		let lastIndex = 0;
		let match = WORKSPACE_PATH_PATTERN.exec(text);
		while (match) {
			const [full, filePath, lineText] = match;
			if (match.index > lastIndex) {
				fragment.append(text.slice(lastIndex, match.index));
			}
			const link = document.createElement("span");
			link.className = "workspace-path-link";
			link.setAttribute("role", "link");
			link.tabIndex = 0;
			link.dataset.workspacePath = filePath;
			if (lineText) link.dataset.workspaceLine = lineText;
			link.textContent = full;
			fragment.append(link);
			lastIndex = match.index + full.length;
			match = WORKSPACE_PATH_PATTERN.exec(text);
		}
		if (lastIndex === 0) continue;
		if (lastIndex < text.length) fragment.append(text.slice(lastIndex));
		textNode.parentNode?.replaceChild(fragment, textNode);
	}
}

function buildToolResultMap(): Map<string, PiMessage> {
	const results = new Map<string, PiMessage>();
	for (const message of ui.messages) {
		if (message.role === "toolResult" && message.toolCallId)
			results.set(message.toolCallId, message);
	}
	return results;
}

function renderAttachments(): void {
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
		remove.append(createCodicon("close"));
		remove.addEventListener("click", () => {
			ui.attachments = ui.attachments.filter(
				(item) => item.id !== attachment.id,
			);
			post({ type: "removeAttachment", id: attachment.id });
			scheduleRender();
		});
		chip.append(icon, label, remove);
		elements.attachmentList.append(chip);
	}
}

function syncPromptHighlightScroll(): void {
	if (elements.input.clientWidth > 0) {
		elements.promptHighlights.style.width = `${elements.input.clientWidth}px`;
	}
	elements.promptHighlights.style.transform = `translate(${-elements.input.scrollLeft}px, ${-elements.input.scrollTop}px)`;
}

function renderComposerHighlights(): void {
	const text = elements.input.value;
	if (text.length > MAX_HIGHLIGHTED_COMPOSER_LENGTH) {
		renderedPromptText = undefined;
		renderedPromptMarkerSignature = undefined;
		elements.promptEditor.classList.remove("has-reference-highlights");
		if (elements.promptHighlights.childNodes.length > 0) {
			elements.promptHighlights.replaceChildren();
		}
		syncPromptHighlightScroll();
		return;
	}
	const references = composerController
		.managedReferences()
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const markerSignature = references
		.map(
			(reference) =>
				`${reference.id}:${reference.revision}:${reference.start}:${reference.end}`,
		)
		.join("\u0000");
	if (
		text === renderedPromptText &&
		markerSignature === renderedPromptMarkerSignature
	) {
		syncPromptHighlightScroll();
		return;
	}
	renderedPromptText = text;
	renderedPromptMarkerSignature = markerSignature;

	const ranges = references.map(({ start, end }) => ({ start, end }));
	elements.promptEditor.classList.toggle(
		"has-reference-highlights",
		ranges.length > 0,
	);
	if (ranges.length === 0) {
		elements.promptHighlights.replaceChildren();
		syncPromptHighlightScroll();
		return;
	}

	const fragment = document.createDocumentFragment();
	let cursor = 0;
	for (const range of ranges) {
		if (range.start < cursor) continue;
		fragment.append(document.createTextNode(text.slice(cursor, range.start)));
		const highlight = document.createElement("mark");
		highlight.className = "composer-reference-highlight";
		highlight.textContent = text.slice(range.start, range.end);
		fragment.append(highlight);
		cursor = range.end;
	}
	fragment.append(document.createTextNode(text.slice(cursor)));
	if (text.endsWith("\n")) fragment.append(document.createTextNode("\u200b"));
	elements.promptHighlights.replaceChildren(fragment);
	syncPromptHighlightScroll();
}

function renderSelectors(): void {
	const model = ui.state.model;
	elements.modelSelectValue.textContent = model
		? model.name || model.id
		: "No model";
	elements.modelSelect.title = model
		? `${model.provider}/${model.id}`
		: "No model";

	elements.thinkingSelectValue.textContent = ui.state.thinkingLevel || "off";
	elements.thinkingSelect.title = ui.state.thinkingLevel || "Thinking level";

	// Preserve focus while streaming renders update the selected value.
	selectorController.syncSelected();
}

function renderQueue(): void {
	const total = ui.queue.steering.length + ui.queue.followUp.length;
	const statuses = [...extensionStatuses.values()].filter(
		(status) => !isInactiveLspStatus(status),
	);
	const parts: string[] = [];
	if (total > 0) parts.push(`${total} queued`);
	parts.push(...statuses);
	const text = parts.join(" · ");
	elements.queueStatus.hidden = text.length === 0;
	elements.queueStatus.textContent = text;
	elements.queueStatus.title = text;
}

function isInactiveLspStatus(status: string): boolean {
	return /^LSP(?:\s+status)?\s*:?\s*(?:inactive|disabled)\b/iu.test(
		status.trim(),
	);
}

function renderWidgets(): void {
	const lines = [...extensionWidgets.values()].flat();
	elements.widgetArea.hidden = lines.length === 0;
	elements.widgetArea.textContent = lines.join("\n");
}

function renderRuntimeMeta(): void {
	const parts: string[] = [];
	const context = ui.stats?.contextUsage?.percent;
	if (typeof context === "number")
		parts.push(`${Math.round(context)}% context`);
	if (typeof ui.stats?.cost === "number" && ui.stats.cost > 0)
		parts.push(`$${ui.stats.cost.toFixed(3)}`);
	const text = parts.join(" · ");
	elements.runtimeMeta.hidden = text.length === 0;
	elements.runtimeMeta.textContent = text;
	elements.runtimeMeta.title = text;
}

function renderComposerStatusRow(): void {
	// The row keeps its slot even when empty: toggling it would change the
	// transcript height the moment queue/status text appears (e.g. "1 queued"
	// while pi is busy), which shoves the whole layout up ~21px under a
	// bottom-anchored viewport and back down when the queue drains.
	elements.composerStatusRow.hidden = false;
}

function renderSendButton(): void {
	const label = ui.busy ? "Stop pi" : "Send message";
	const icon = elements.sendButton.querySelector("i");
	if (icon)
		icon.className = `codicon codicon-${ui.busy ? "debug-stop" : "arrow-up"}`;
	elements.sendButton.title = label;
	elements.sendButton.setAttribute("aria-label", label);
	elements.sendButton.disabled =
		ui.connection !== "ready" || (!ui.busy && pendingSubmit);
	elements.composer.classList.toggle("busy", ui.busy || pendingSubmit);
}

function renderSessions(): void {
	const queryTerms = elements.sessionSearch.value
		.trim()
		.toLocaleLowerCase()
		.split(/\s+/u)
		.filter(Boolean);
	const sessions =
		queryTerms.length === 0
			? ui.sessions
			: ui.sessions.filter((session) => {
					const searchable =
						`${session.title}\n${session.excerpt}`.toLocaleLowerCase();
					return queryTerms.every((term) => searchable.includes(term));
				});

	if (sessions.length === 0) {
		const empty = document.createElement("div");
		empty.className = "session-list-empty";
		empty.textContent =
			ui.sessions.length === 0 ? "No saved sessions" : "No matching sessions";
		elements.sessionList.replaceChildren(empty);
		return;
	}
	const rows = sessions.map((session) => {
		const row = document.createElement("div");
		row.className = `session-row${session.active ? " active" : ""}`;

		const openButton = document.createElement("button");
		openButton.type = "button";
		openButton.className = "session-open";
		openButton.title = session.title;
		if (session.active) openButton.setAttribute("aria-current", "true");
		const title = document.createElement("strong");
		title.textContent = session.title;
		const time = document.createElement("time");
		time.dateTime = session.timestamp;
		time.textContent = formatRelativeTime(session.timestamp);
		openButton.append(title, time);
		openButton.addEventListener("click", () => {
			if (!session.active) runAction("switchSession", { path: session.path });
			closeHistory();
		});

		const deleteButton = document.createElement("button");
		deleteButton.type = "button";
		deleteButton.className = "session-delete";
		deleteButton.disabled = session.active;
		deleteButton.title = session.active
			? "The active session cannot be deleted"
			: "Delete session";
		deleteButton.setAttribute(
			"aria-label",
			session.active
				? "The active session cannot be deleted"
				: `Delete ${session.title}`,
		);
		deleteButton.append(createCodicon("trash"));
		deleteButton.addEventListener("click", () => {
			openConfirm({
				title: "Delete session",
				message: `Delete "${truncate(session.title, 72)}"? This cannot be undone.`,
				confirmLabel: "Delete",
				destructive: true,
				onConfirm: () => runAction("deleteSession", { path: session.path }),
			});
		});

		const renameButton = document.createElement("button");
		renameButton.type = "button";
		renameButton.className = "session-rename";
		renameButton.disabled = !session.active;
		renameButton.title = session.active
			? "Rename session"
			: "Open the session to rename it";
		renameButton.setAttribute(
			"aria-label",
			session.active
				? `Rename ${session.title}`
				: "Open the session to rename it",
		);
		renameButton.append(createCodicon("edit"));
		renameButton.addEventListener("click", () => openRenamePrompt());

		row.append(openButton, renameButton, deleteButton);
		return row;
	});
	elements.sessionList.replaceChildren(...rows);
}

function toggleHistory(): void {
	if (elements.historyPanel.hidden) {
		elements.historyPanel.hidden = false;
		elements.historyButton.setAttribute("aria-expanded", "true");
		elements.sessionSearch.value = "";
		const loading = document.createElement("div");
		loading.className = "session-list-empty";
		loading.textContent = "Loading...";
		elements.sessionList.replaceChildren(loading);
		elements.sessionSearch.focus();
		post({ type: "listSessions" });
	} else {
		closeHistory();
	}
}

function dismissHistory(): void {
	elements.historyPanel.hidden = true;
	elements.historyButton.setAttribute("aria-expanded", "false");
}

function closeHistory(): void {
	dismissHistory();
	elements.historyButton.focus();
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
	announce(`Inserted /${name}`);
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
 * The typed `@query` is removed first and the host is then asked to register the
 * file, which comes back as a `composerReferences` update carrying the marker.
 * The order matters: the host-owned marker is inserted at the caret, so the caret
 * has to already sit where the query was for the marker to land there.
 *
 * Local removal also covers the duplicate case. Picking a file that is already
 * referenced produces no new reference from the host, so leaving the query behind
 * would strand `@src/main.ts` as plain prose beside the real marker.
 */
function addMentionReference(
	file: WorkspaceFileSuggestion,
	token: { start: number; end: number },
): void {
	const alreadyReferenced = composerController.references.some(
		(reference) => reference.displayPath === file.displayPath,
	);
	if (
		!alreadyReferenced &&
		composerController.references.length >= MAX_COMPOSER_REFERENCE_COUNT
	) {
		showToast(
			`Remove a reference before adding another (maximum ${MAX_COMPOSER_REFERENCE_COUNT})`,
			"error",
		);
		return;
	}
	composerController.replaceRange(token.start, token.end, "");
	elements.input.focus();
	runAction("addResources", { resources: [file.uri] });
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

function sendPrompt(): void {
	if (pendingSubmit || ui.connection !== "ready") return;
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
	pendingSubmit = true;
	runAction("submit", {
		text,
		attachmentIds: ui.attachments.map((attachment) => attachment.id),
		references: composerController.references.map((reference) => ({
			id: reference.id,
			revision: reference.revision,
			start: reference.start,
			end: reference.end,
		})),
	});
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
): void {
	const actionId = crypto.randomUUID();
	const action: PendingAction = { type };
	if (type === "submit" || type === "newSession") {
		action.draft = elements.input.value;
		action.attachmentIds = ui.attachments.map((attachment) => attachment.id);
		action.referenceSnapshots = composerController.snapshotReferences();
	}
	pendingActions.set(actionId, action);
	post({ type, actionId, ...fields } as WebviewToHostMessage);
}

function post(message: WebviewToHostMessage): void {
	vscode.postMessage(message);
}

function openConfirm(options: ConfirmOptions): void {
	if (options.dismissHistory) dismissHistory();
	modalController.openConfirm({
		title: options.title,
		message: options.message,
		confirmLabel: options.confirmLabel,
		destructive: options.destructive,
		onConfirm: options.onConfirm,
	});
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
		onSubmit: (name) => runAction("renameSession", { name }),
	});
}

function announce(message: string): void {
	elements.liveStatus.textContent = "";
	requestAnimationFrame(() => {
		elements.liveStatus.textContent = message;
	});
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

function focusComposerIfRequested(): void {
	if (
		composerFocusRequestId === undefined ||
		composerFocusQueued ||
		elements.input.disabled
	)
		return;
	const requestId = composerFocusRequestId;
	composerFocusQueued = true;
	requestAnimationFrame(() => {
		composerFocusQueued = false;
		if (composerFocusRequestId !== requestId || elements.input.disabled) {
			focusComposerIfRequested();
			return;
		}
		elements.input.focus({ preventScroll: true });
		if (document.activeElement !== elements.input) return;
		lastCompletedFocusRequestId = requestId;
		composerFocusRequestId = undefined;
		post({ type: "composerFocused", requestId });
	});
}

function resizeInput(): void {
	elements.input.style.height = "auto";
	elements.input.style.height = `${Math.min(elements.input.scrollHeight, 150)}px`;
}

function deriveSessionTitle(): string {
	if (ui.state.sessionName?.trim()) return ui.state.sessionName.trim();
	const firstUser = ui.messages.find((message) => message.role === "user");
	const text = firstUser
		? contentText(firstUser.content)
				.replace(/^<pi-context>[\s\S]*?<\/pi-context>\s*/u, "")
				.trim()
		: "";
	return truncate(text.replace(/\s+/gu, " "), 54) || "Untitled";
}

function connectionLabel(): string {
	if (ui.connection === "ready")
		return ui.busy ? "Pi is working" : "Pi is ready";
	if (ui.connection === "starting") return "Pi is starting";
	if (ui.connection === "no-workspace") return "Workspace required";
	return ui.connectionDetail || "Pi is disconnected";
}

function extractResultText(value: unknown): string {
	const result = objectValue(value);
	const content = result.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const text = stringValue((item as JsonRecord).text);
		if (text) parts.push(text);
	}
	return parts.join("\n");
}

function hasEquivalentTail(
	messages: PiMessage[],
	candidate: PiMessage,
): boolean {
	const tail = messages.at(-1);
	if (!tail || tail.role !== candidate.role) return false;
	if (tail.timestamp && candidate.timestamp)
		return tail.timestamp === candidate.timestamp;
	return contentText(tail.content) === contentText(candidate.content);
}

function asMessage(value: unknown): PiMessage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const message = value as PiMessage;
	return typeof message.role === "string" ? message : undefined;
}

function objectValue(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function cleanExtensionText(value: string): string {
	return value
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(ORPHAN_SGR_PATTERN, "")
		.trim();
}

function numberValue(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function truncate(value: string, length: number): string {
	return value.length > length
		? `${value.slice(0, Math.max(0, length - 1))}…`
		: value;
}

function formatRelativeTime(timestamp: string): string {
	const value = new Date(timestamp).getTime();
	const difference = Date.now() - value;
	if (!Number.isFinite(value)) return "";
	if (difference < 60_000) return "now";
	if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m`;
	if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h`;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	}).format(value);
}

function createCodicon(name: string): HTMLElement {
	const icon = document.createElement("i");
	icon.className = `codicon codicon-${name}`;
	icon.setAttribute("aria-hidden", "true");
	return icon;
}

function sanitizedNodes(html: string): Node[] {
	const sanitized = DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true },
		ADD_ATTR: ["target", "rel", "data-copy-code"],
	});
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
