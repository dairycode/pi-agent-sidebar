import DOMPurify from "dompurify";
import { marked } from "marked";
import {
	formatCodeReferenceLocation,
	formatCodeReferenceMarker,
	parseCodeReferencePayload,
} from "../src/codeReferences.js";
import {
	insertManagedReference,
	isManagedReferenceValid,
	parsePersistedReferences,
	reconcileComposerEdit,
	referenceAtOffset,
	removeManagedReferences,
	type ManagedCodeReference,
} from "./composerModel.js";
import type {
	AttachmentRef,
	CodeReference,
	HostToWebviewMessage,
	JsonRecord,
	PiCommand,
	PiContentBlock,
	PiMessage,
	PiModel,
	PastedImage,
	PiState,
	PiStats,
	SessionSummary,
	WebviewToHostMessage,
} from "../src/shared/protocol.js";

declare function acquireVsCodeApi<T = unknown>(): {
	postMessage(message: WebviewToHostMessage): void;
	getState(): T | undefined;
	setState(state: T): void;
};

interface PersistedState {
	draft: string;
	codeReferences?: ManagedCodeReference[];
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
	referenceSnapshots?: ManagedCodeReference[];
}

interface ConfirmOptions {
	title: string;
	message: string;
	confirmLabel: string;
	onConfirm: () => void;
	destructive?: boolean;
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
	codeReferences: ManagedCodeReference[];
	sessions: SessionSummary[];
	queue: { steering: string[]; followUp: string[] };
	busy: boolean;
}

const vscode = acquireVsCodeApi<PersistedState>();
marked.setOptions({ gfm: true, breaks: true });

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
	codeReferences: [],
	sessions: [],
	queue: { steering: [], followUp: [] },
	busy: false,
};

const liveTools = new Map<string, LiveTool>();
const pendingActions = new Map<string, PendingAction>();
const extensionStatuses = new Map<string, string>();
const extensionWidgets = new Map<string, string[]>();
const locallyRemovedCodeReferenceRevisions = new Map<string, number>();
let renderQueued = false;
let pendingSubmit = false;
let composerFocusRequestId: number | undefined;
let composerFocusQueued = false;
let lastAnnouncedFocusRequestId = 0;
let lastCompletedFocusRequestId = 0;
let renderedPromptText: string | undefined;
let renderedPromptMarkerSignature: string | undefined;
let composerTextSnapshot = "";
let lastComposerCaret = 0;
let modalReturnFocus: HTMLElement | null = null;

const SUPPORTED_CLIPBOARD_IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_COUNT = 4;
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
	composer: element<HTMLFormElement>("composer"),
	promptEditor: element<HTMLElement>("prompt-editor"),
	promptHighlights: element<HTMLElement>("prompt-highlights"),
	input: element<HTMLTextAreaElement>("prompt-input"),
	attachButton: element<HTMLButtonElement>("attach-button"),
	commandButton: element<HTMLButtonElement>("command-button"),
	commandPanel: element<HTMLElement>("command-panel"),
	commandSearch: element<HTMLInputElement>("command-search"),
	commandList: element<HTMLElement>("command-list"),
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

const persisted = vscode.getState();
if (persisted?.draft) elements.input.value = persisted.draft;
const restoredCodeReferences = new Map(
	parsePersistedReferences(persisted?.codeReferences, elements.input.value).map(
		(reference) => [reference.id, reference],
	),
);
composerTextSnapshot = elements.input.value;
resizeInput();
renderComposerHighlights();

window.addEventListener(
	"message",
	(event: MessageEvent<HostToWebviewMessage>) => {
		handleHostMessage(event.data);
	},
);

window.addEventListener("keydown", (event) => {
	if (!elements.modalBackdrop.hidden) {
		handleModalKeydown(event);
		return;
	}
	if (event.key !== "Escape") return;
	if (activeSelect) {
		closeSelect(true);
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
	if (
		activeSelect &&
		!elements.selectPopup.contains(event.target) &&
		!selectTrigger(activeSelect).contains(event.target)
	) {
		closeSelect(false);
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
		!elements.modalBackdrop.hidden ||
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
	if (activeSelect) closeSelect(false);
	if (!elements.commandPanel.hidden) dismissCommandPalette();
	if (!elements.historyPanel.hidden) dismissHistory();
});

elements.input.addEventListener("input", () => {
	reconcileCodeReferencesWithComposer();
	rememberComposerCaret();
	resizeInput();
	persistComposerState();
	renderComposerHighlights();
	syncInlineCommandPalette();
});

elements.input.addEventListener("keyup", (event) => {
	rememberComposerCaret();
	// Caret keys move without firing `input`, so the inline palette has to
	// re-check whether the caret is still inside its token.
	if (
		event.key.startsWith("Arrow") ||
		event.key === "Home" ||
		event.key === "End"
	) {
		syncInlineCommandPalette();
	}
});
elements.input.addEventListener("pointerup", () => {
	rememberComposerCaret();
	syncInlineCommandPalette();
});
elements.input.addEventListener("select", rememberComposerCaret);
elements.input.addEventListener("blur", rememberComposerCaret);

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
	if (activeSelect) positionSelectPopup(selectTrigger(activeSelect));
	if (!elements.commandPanel.hidden) positionCommandPanel();
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
	// the composer's own send and reference-jump handling.
	if (handleInlineCommandKeydown(event)) return;
	if (event.key === "F12") {
		const reference = codeReferenceAtOffset(elements.input.selectionStart);
		if (!reference) return;
		event.preventDefault();
		post({ type: "openCodeReference", id: reference.id });
		return;
	}
	if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
	event.preventDefault();
	if (ui.connection !== "ready") return;
	sendPrompt();
});

elements.input.addEventListener("paste", (event) => {
	void handleImagePaste(event);
});

elements.input.addEventListener("click", (event) => {
	if (!event.metaKey && !event.ctrlKey) return;
	const reference = codeReferenceAtOffset(elements.input.selectionStart);
	if (!reference) return;
	post({ type: "openCodeReference", id: reference.id });
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

elements.modelSelect.addEventListener("click", () => toggleSelect("model"));
elements.thinkingSelect.addEventListener("click", () =>
	toggleSelect("thinking"),
);
for (const kind of ["model", "thinking"] as const) {
	selectTrigger(kind).addEventListener("keydown", (event) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		if (activeSelect !== kind) openSelect(kind);
	});
}

elements.selectPopup.addEventListener("click", (event) => {
	if (!activeSelect || !(event.target instanceof HTMLElement)) return;
	const value =
		event.target.closest<HTMLElement>(".select-option")?.dataset.value;
	if (value !== undefined) commitSelect(activeSelect, value);
});

elements.selectPopup.addEventListener("keydown", (event) => {
	const kind = activeSelect;
	if (!kind) return;
	const rows = [
		...elements.selectPopup.querySelectorAll<HTMLElement>(".select-option"),
	];
	if (rows.length === 0) return;
	const index = rows.findIndex((row) => row === document.activeElement);
	if (event.key === "Escape" || event.key === "Tab") {
		event.preventDefault();
		closeSelect(true);
		return;
	}
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		const value = rows[index]?.dataset.value;
		if (value !== undefined) commitSelect(kind, value);
		return;
	}
	let next = -1;
	if (event.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1);
	else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = rows.length - 1;
	if (next < 0) return;
	event.preventDefault();
	focusSelectOption(rows[next]);
});

window.addEventListener("resize", () => {
	if (activeSelect) positionSelectPopup(selectTrigger(activeSelect));
});

elements.modalBackdrop.addEventListener("click", (event) => {
	if (event.target === elements.modalBackdrop) closeModal();
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
	const pathLink = target.closest<HTMLElement>("[data-workspace-path]");
	if (pathLink) {
		event.preventDefault();
		const workspacePath = pathLink.dataset.workspacePath;
		if (workspacePath) {
			const lineValue = Number(pathLink.dataset.workspaceLine);
			post({
				type: "openWorkspacePath",
				path: workspacePath,
				...(Number.isInteger(lineValue) && lineValue >= 1
					? { line: lineValue }
					: {}),
			});
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
		case "attachments": {
			ui.attachments = message.attachments;
			scheduleRender();
			break;
		}
		case "codeReferences": {
			const changedReference = applyIncomingCodeReferences(
				message.references,
			).at(-1);
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
							`Referenced ${formatCodeReferenceLocation(changedReference.displayPath, changedReference.startLine, changedReference.endLine)}`,
						);
					} else if (ui.codeReferences.length > 0) {
						announce(
							`Pi Agent input focused with ${ui.codeReferences.length} code ${ui.codeReferences.length === 1 ? "reference" : "references"}`,
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
			const references = ui.codeReferences.map(
				({ start: _start, end: _end, ...reference }) => reference,
			);
			reconcilePendingReferenceEdits(elements.input.value, message.text);
			ui.codeReferences = [];
			writeComposerDraft(message.text, message.text.length);
			applyIncomingCodeReferences(references);
			elements.input.focus();
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
		const draftUnchanged = elements.input.value === action.draft;
		const submittedIds = new Set(action.attachmentIds ?? []);
		ui.attachments = ui.attachments.filter(
			(attachment) => !submittedIds.has(attachment.id),
		);
		const submittedReferences = new Map(
			(action.referenceSnapshots ?? []).map((reference) => [
				reference.id,
				reference.revision,
			]),
		);
		ui.codeReferences = ui.codeReferences.filter(
			(reference) =>
				submittedReferences.get(reference.id) !== reference.revision,
		);
		const activeKeys = new Set(
			ui.codeReferences.map(
				(reference) => `${reference.id}:${reference.revision}`,
			),
		);
		if (draftUnchanged) {
			const activeReferences = ui.codeReferences.map(
				({ start: _start, end: _end, ...reference }) => reference,
			);
			ui.codeReferences = [];
			writeComposerDraft("", 0);
			applyIncomingCodeReferences(activeReferences);
		} else {
			removeManagedReferencesFromComposer(
				(action.referenceSnapshots ?? []).filter(
					(reference) =>
						!activeKeys.has(`${reference.id}:${reference.revision}`),
				),
			);
		}
	}
	if (ok && action?.type === "pasteImages") {
		showToast("Clipboard image attached", "info");
		announce("Clipboard image attached");
	}
	if (ok && action?.type === "deleteSession") {
		showToast("Session deleted", "info");
		announce("Session deleted");
		if (!elements.historyPanel.hidden) elements.sessionSearch.focus();
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
			const message = asMessage(event.message);
			if (message) ui.streamingMessage = message;
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
	elements.modelSelect.disabled = !enabled || ui.models.length === 0;
	elements.thinkingSelect.disabled = !enabled || ui.thinkingLevels.length <= 1;
	if (activeSelect && selectTrigger(activeSelect).disabled) closeSelect(false);
	if (!enabled) dismissCommandPalette();
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
	const allMessages = ui.streamingMessage
		? [...ui.messages, ui.streamingMessage]
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

function messageHtml(
	message: PiMessage,
	results: Map<string, PiMessage>,
	streaming: boolean,
	messageKey: string,
): string {
	if (message.role === "toolResult") return "";
	if (message.role === "user") return userMessageHtml(message);
	if (message.role === "assistant")
		return assistantMessageHtml(message, results, streaming, messageKey);
	if (message.role === "bashExecution") {
		return `<div class="message system-message">${toolDisclosureHtml(
			"bash-execution",
			"bash",
			{ command: message.command },
			undefined,
			{
				id: "bash-execution",
				name: "bash",
				args: { command: message.command },
				status: message.exitCode === 0 ? "success" : "error",
				output: stringValue(message.output),
				startedAt: 0,
			},
		)}</div>`;
	}
	if (
		message.role === "compactionSummary" ||
		message.role === "branchSummary"
	) {
		return `<div class="context-divider"><i class="codicon codicon-fold"></i> Context summarized</div>`;
	}
	if (message.role === "custom" && message.display !== false) {
		return `<div class="message system-message custom-message">${markdown(contentText(message.content))}</div>`;
	}
	return "";
}

function userMessageHtml(message: PiMessage): string {
	const rawText = contentText(message.content);
	const contextMatch = rawText.match(
		/^<pi-context>\n([\s\S]*?)\n<\/pi-context>\n\n/u,
	);
	const context = contextMatch?.[1] ?? "";
	const text = contextMatch ? rawText.slice(contextMatch[0].length) : rawText;
	const markers = context
		.split("\n")
		.map(contextInlineMarker)
		.filter((marker): marker is InlineMarker => Boolean(marker));
	const bodyHtml = renderUserBodyHtml(text, markers);
	const imageHtml = contentImages(message.content)
		.map(
			(image) =>
				`<img class="message-image" src="data:${escapeHtml(image.mimeType ?? "image/png")};base64,${image.data ?? ""}" alt="Attached image">`,
		)
		.join("");
	return `<article class="message user-message"><div class="user-message-text">${bodyHtml}</div>${imageHtml}</article>`;
}

function markerSpanHtml(marker: InlineMarker): string {
	const attrs = marker.workspacePath
		? ` data-workspace-path="${escapeHtml(marker.workspacePath)}"${
				marker.line ? ` data-workspace-line="${marker.line}"` : ""
			}`
		: "";
	return `<span class="code-reference-highlight"${attrs}>${escapeHtml(marker.label)}</span>`;
}

/**
 * Render the user message body. Reference markers are kept in place within the
 * text (see buildPrompt), so locate each marker where it actually appears and
 * replace it with a highlight span. Markers not found inline (e.g. plain file
 * attachments) are prefixed so their context is still visible.
 */
function renderUserBodyHtml(text: string, markers: InlineMarker[]): string {
	const inline: Array<{ start: number; end: number; marker: InlineMarker }> =
		[];
	const leftover: InlineMarker[] = [];
	let searchFrom = 0;
	for (const marker of markers) {
		const index = text.indexOf(marker.label, searchFrom);
		if (index >= 0) {
			inline.push({ start: index, end: index + marker.label.length, marker });
			searchFrom = index + marker.label.length;
		} else {
			leftover.push(marker);
		}
	}
	let body = "";
	let cursor = 0;
	for (const { start, end, marker } of inline) {
		body += escapeHtml(text.slice(cursor, start));
		body += markerSpanHtml(marker);
		cursor = end;
	}
	body += escapeHtml(text.slice(cursor));
	const prefix = leftover.map(markerSpanHtml).join(" ");
	if (!prefix) return body;
	return body ? `${prefix} ${body}` : prefix;
}

interface InlineMarker {
	label: string;
	workspacePath?: string;
	line?: number;
}

function contextInlineMarker(line: string): InlineMarker | undefined {
	const filePrefix = "- file: ";
	if (line.startsWith(filePrefix)) {
		try {
			const filePath = JSON.parse(line.slice(filePrefix.length)) as unknown;
			if (typeof filePath !== "string") return { label: "@file" };
			const name = filePath.split(/[/\\]/u).pop() || filePath;
			return { label: `@${name}` };
		} catch {
			return { label: "@file" };
		}
	}
	// symbol/diagnostics are supplemental data for a selection; keep them in the
	// payload sent to pi but do not render an inline marker.
	if (line.startsWith("- symbol: ") || line.startsWith("- diagnostics: ")) {
		return undefined;
	}
	const selectionPrefix = "- selection: ";
	if (!line.startsWith(selectionPrefix)) return undefined;
	const reference = parseCodeReferencePayload(
		line.slice(selectionPrefix.length),
	);
	if (!reference) return undefined;
	return {
		label: formatCodeReferenceMarker(
			reference.displayPath,
			reference.startLine,
			reference.endLine,
		),
		workspacePath: reference.displayPath,
		line: reference.startLine,
	};
}

function assistantMessageHtml(
	message: PiMessage,
	results: Map<string, PiMessage>,
	streaming: boolean,
	messageKey: string,
): string {
	const blocks = Array.isArray(message.content) ? message.content : [];
	const sections: string[] = [];
	let activity: string[] = [];
	let thinkingIndex = 0;
	const isActivityBlock = (type: string | undefined): boolean =>
		type === "thinking" || type === "toolCall";
	const startsWithActivity = isActivityBlock(blocks[0]?.type);
	const endsWithActivity = isActivityBlock(blocks.at(-1)?.type);
	const flushActivity = (): void => {
		if (activity.length === 0) return;
		sections.push(`<div class="activity-timeline">${activity.join("")}</div>`);
		activity = [];
	};

	for (const block of blocks) {
		if (block.type === "text") {
			flushActivity();
			sections.push(
				`<div class="assistant-text">${markdown(block.text ?? "")}</div>`,
			);
		}
		if (block.type === "thinking") {
			const thinkingKey = `${messageKey}-thinking-${thinkingIndex}`;
			const streamingState = streaming ? " streaming" : "";
			const openState = streaming ? " open" : "";
			thinkingIndex += 1;
			activity.push(
				`<details class="activity-item thinking-block${streamingState}" data-thinking-key="${escapeHtml(thinkingKey)}"${openState}><summary class="thinking-summary"><span class="activity-marker"><i class="codicon codicon-lightbulb" aria-hidden="true"></i></span><span class="thinking-summary-content"><span class="thinking-label">Reasoning</span><i class="codicon codicon-chevron-right thinking-chevron" aria-hidden="true"></i></span></summary><div class="thinking-content">${markdown(block.thinking ?? "")}</div></details>`,
			);
		}
		if (block.type === "toolCall" && block.id && block.name) {
			activity.push(
				toolDisclosureHtml(
					block.id,
					block.name,
					block.arguments ?? {},
					results.get(block.id),
					liveTools.get(block.id),
				),
			);
		}
	}
	flushActivity();
	if (message.errorMessage)
		sections.push(
			`<div class="message-error">${escapeHtml(message.errorMessage)}</div>`,
		);
	if (message.stopReason === "aborted")
		sections.push('<div class="cancelled-note">Cancelled</div>');
	const activityClasses = `${startsWithActivity ? " starts-with-activity" : ""}${endsWithActivity ? " ends-with-activity" : ""}`;
	return `<article class="message assistant-message${activityClasses}">${sections.join("")}</article>`;
}

function toolDisclosureHtml(
	id: string,
	name: string,
	args: JsonRecord,
	result?: PiMessage,
	live?: LiveTool,
): string {
	const status = resolveToolStatus(result, live);
	const output = live?.output || (result ? contentText(result.content) : "");
	const { label: statusLabel, icon } = toolStatusPresentation(status);
	const target = summarizeTool(name, args);
	const diff = live?.diff ?? (result ? extractResultDiff(result) : "");
	const diffHtml = status === "success" && diff ? renderDiffBlock(diff) : "";
	// For file edits the diff replaces the noisy "Successfully replaced..."
	// output, so only show tool output when there is no diff to display.
	const outputHtml =
		output && !diffHtml
			? `<div class="tool-output"><pre>${escapeHtml(truncate(output, 20_000))}</pre></div>`
			: "";
	return `<details class="activity-item tool-call ${status}" data-tool-key="${escapeHtml(id)}" ${status === "error" ? "open" : ""}>
    <summary>
      <span class="activity-marker"><i class="codicon codicon-${icon}" aria-hidden="true"></i></span>
      <span class="tool-summary-content"><span class="tool-summary-main"><span class="tool-name">${escapeHtml(friendlyToolName(name))}</span><span class="tool-target">${escapeHtml(target)}</span></span><span class="tool-status">${statusLabel}</span></span>
    </summary>
    ${outputHtml}
    ${diffHtml}
  </details>`;
}

const MAX_DIFF_LINES = 400;

/**
 * Render a diff string produced by pi (the `result.details.diff` field of a
 * file-editing tool). Each line already begins with `+`, `-`, or a leading
 * space for context; the client only classifies and colorizes it, and never
 * recomputes the diff itself.
 */
function renderDiffBlock(diff: string): string {
	const lines = diff.replace(/\n$/u, "").split("\n");
	const truncated = lines.length > MAX_DIFF_LINES;
	const shown = truncated ? lines.slice(0, MAX_DIFF_LINES) : lines;
	const rows = shown
		.map((line) => {
			const marker = line.charAt(0);
			const kind =
				marker === "+" ? "add" : marker === "-" ? "remove" : "context";
			return `<div class="diff-line diff-${kind}"><span class="diff-text">${escapeHtml(line) || "&nbsp;"}</span></div>`;
		})
		.join("");
	const more = truncated
		? `<div class="diff-line diff-context"><span class="diff-text">\u2026 ${lines.length - MAX_DIFF_LINES} more lines</span></div>`
		: "";
	return `<div class="tool-diff">${rows}${more}</div>`;
}

function extractResultDiff(result: unknown): string {
	const record = objectValue(result);
	const details = objectValue(record.details);
	return stringValue(details.diff);
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

function acceptIncomingCodeReferences(
	references: CodeReference[],
): CodeReference[] {
	const incomingById = new Map(
		references.map((reference) => [reference.id, reference]),
	);
	for (const [id, removedRevision] of locallyRemovedCodeReferenceRevisions) {
		const incoming = incomingById.get(id);
		if (!incoming || incoming.revision > removedRevision) {
			locallyRemovedCodeReferenceRevisions.delete(id);
		}
	}
	return references.filter((reference) => {
		const removedRevision = locallyRemovedCodeReferenceRevisions.get(
			reference.id,
		);
		return (
			removedRevision === undefined || reference.revision > removedRevision
		);
	});
}

function managedCodeReferences(): ManagedCodeReference[] {
	const references = new Map<string, ManagedCodeReference>();
	for (const reference of ui.codeReferences) {
		if (isManagedReferenceValid(elements.input.value, reference)) {
			references.set(`${reference.id}:${reference.revision}`, reference);
		}
	}
	for (const action of pendingActions.values()) {
		for (const reference of action.referenceSnapshots ?? []) {
			if (isManagedReferenceValid(elements.input.value, reference)) {
				references.set(`${reference.id}:${reference.revision}`, reference);
			}
		}
	}
	for (const reference of restoredCodeReferences.values()) {
		if (isManagedReferenceValid(elements.input.value, reference)) {
			references.set(`${reference.id}:${reference.revision}`, reference);
		}
	}
	return [...references.values()];
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
	const references = managedCodeReferences().sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
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
		highlight.className = "code-reference-highlight";
		highlight.textContent = text.slice(range.start, range.end);
		fragment.append(highlight);
		cursor = range.end;
	}
	fragment.append(document.createTextNode(text.slice(cursor)));
	if (text.endsWith("\n")) fragment.append(document.createTextNode("\u200b"));
	elements.promptHighlights.replaceChildren(fragment);
	syncPromptHighlightScroll();
}

function persistComposerState(): void {
	vscode.setState({
		draft: elements.input.value,
		codeReferences: ui.codeReferences,
	});
}

function writeComposerDraft(text: string, caret: number): void {
	const nextCaret = Math.max(0, Math.min(caret, text.length));
	elements.input.value = text;
	composerTextSnapshot = text;
	elements.input.setSelectionRange(nextCaret, nextCaret);
	lastComposerCaret = nextCaret;
	persistComposerState();
	resizeInput();
	renderComposerHighlights();
}

function rememberComposerCaret(): void {
	const caret = elements.input.selectionStart;
	if (typeof caret === "number") lastComposerCaret = caret;
}

function reconcilePendingReferenceEdits(
	previousText: string,
	nextText: string,
): void {
	for (const action of pendingActions.values()) {
		if (!action.referenceSnapshots) continue;
		action.referenceSnapshots = reconcileComposerEdit(
			previousText,
			nextText,
			action.referenceSnapshots,
		).references;
	}
}

function removeManagedReferencesFromComposer(
	references: ManagedCodeReference[],
): void {
	if (references.length === 0) return;
	const previousText = elements.input.value;
	const originalPrefix = previousText.slice(0, elements.input.selectionStart);
	const identities = references.map(({ id, revision }) => ({ id, revision }));
	const activeKeys = new Set(
		ui.codeReferences.map(
			(reference) => `${reference.id}:${reference.revision}`,
		),
	);
	const working = new Map(
		[...ui.codeReferences, ...references].map((reference) => [
			`${reference.id}:${reference.revision}`,
			reference,
		]),
	);
	const result = removeManagedReferences(
		previousText,
		[...working.values()],
		identities,
	);
	const prefixResult = removeManagedReferences(
		originalPrefix,
		references.filter((reference) => reference.end <= originalPrefix.length),
		identities,
	);
	reconcilePendingReferenceEdits(previousText, result.text);
	ui.codeReferences = result.references.filter((reference) =>
		activeKeys.has(`${reference.id}:${reference.revision}`),
	);
	writeComposerDraft(result.text, prefixResult.text.length);
}

function isPendingCodeReference(reference: CodeReference): boolean {
	for (const action of pendingActions.values()) {
		if (
			action.referenceSnapshots?.some(
				(snapshot) =>
					snapshot.id === reference.id &&
					snapshot.revision === reference.revision,
			)
		)
			return true;
	}
	return false;
}

function applyIncomingCodeReferences(
	incoming: CodeReference[],
): ManagedCodeReference[] {
	const references = acceptIncomingCodeReferences(incoming);
	const previousById = new Map(
		ui.codeReferences.map((reference) => [reference.id, reference]),
	);
	const acceptedIds = new Set(references.map((reference) => reference.id));
	const restoredOrphans = [...restoredCodeReferences.values()].filter(
		(reference) => !acceptedIds.has(reference.id),
	);
	if (restoredOrphans.length > 0) {
		ui.codeReferences.push(...restoredOrphans);
		removeManagedReferencesFromComposer(restoredOrphans);
	}
	const stale = ui.codeReferences.filter(
		(reference) =>
			!acceptedIds.has(reference.id) && !isPendingCodeReference(reference),
	);
	removeManagedReferencesFromComposer(stale);
	ui.codeReferences = ui.codeReferences.filter((reference) =>
		acceptedIds.has(reference.id),
	);

	const changed: ManagedCodeReference[] = [];
	for (const summary of references) {
		const current = ui.codeReferences.find(
			(reference) => reference.id === summary.id,
		);
		const restored = restoredCodeReferences.get(summary.id);
		restoredCodeReferences.delete(summary.id);
		const pending = managedCodeReferences().find(
			(reference) =>
				reference.id === summary.id && reference.marker === summary.marker,
		);
		const candidate = [current, restored, pending].find(
			(reference): reference is ManagedCodeReference =>
				Boolean(
					reference &&
						reference.marker === summary.marker &&
						isManagedReferenceValid(elements.input.value, reference),
				),
		);
		if (candidate) {
			const updated = {
				...summary,
				start: candidate.start,
				end: candidate.end,
			};
			ui.codeReferences = ui.codeReferences.filter(
				(reference) => reference.id !== summary.id,
			);
			ui.codeReferences.push(updated);
			if (previousById.get(summary.id)?.revision !== summary.revision) {
				changed.push(updated);
			}
			continue;
		}

		const previousText = elements.input.value;
		const caretSource =
			document.activeElement === elements.input
				? (elements.input.selectionStart ?? lastComposerCaret)
				: lastComposerCaret;
		const insertion = insertManagedReference(
			previousText,
			Math.min(caretSource, previousText.length),
			summary,
			ui.codeReferences,
		);
		reconcilePendingReferenceEdits(previousText, insertion.text);
		ui.codeReferences = insertion.references;
		writeComposerDraft(insertion.text, insertion.caret);
		const inserted = ui.codeReferences.find(
			(reference) => reference.id === summary.id,
		);
		if (inserted) changed.push(inserted);
	}
	ui.codeReferences.sort((left, right) => left.start - right.start);
	persistComposerState();
	return changed;
}

function reconcileCodeReferencesWithComposer(): void {
	const nextText = elements.input.value;
	const result = reconcileComposerEdit(
		composerTextSnapshot,
		nextText,
		ui.codeReferences,
	);
	reconcilePendingReferenceEdits(composerTextSnapshot, nextText);
	ui.codeReferences = result.references;
	composerTextSnapshot = nextText;
	for (const reference of result.removed) {
		locallyRemovedCodeReferenceRevisions.set(reference.id, reference.revision);
		post({
			type: "removeCodeReference",
			id: reference.id,
			revision: reference.revision,
		});
	}
	if (result.removed.length > 0) {
		const first = result.removed[0];
		const label =
			result.removed.length === 1 && first
				? formatCodeReferenceLocation(
						first.displayPath,
						first.startLine,
						first.endLine,
					)
				: `${result.removed.length} code references`;
		announce(`Removed ${label}`);
		scheduleRender();
	}
}

function codeReferenceAtOffset(
	offset: number,
): ManagedCodeReference | undefined {
	return referenceAtOffset(ui.codeReferences, offset);
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

	// A re-render mid-selection (streaming keeps them coming) must not rebuild the
	// open list and drop focus; only the checkmarks are refreshed in place.
	if (!activeSelect) return;
	const current = selectedValue(activeSelect);
	for (const row of elements.selectPopup.querySelectorAll<HTMLElement>(
		".select-option",
	)) {
		const selected = row.dataset.value === current;
		row.setAttribute("aria-selected", String(selected));
		row
			.querySelector(".select-option-check")
			?.classList.toggle("is-hidden", !selected);
	}
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
	elements.composerStatusRow.hidden =
		elements.queueStatus.hidden && elements.runtimeMeta.hidden;
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

		row.append(openButton, deleteButton);
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
	closeSelect(false);
	dismissHistory();
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
		: Math.max(0, Math.min(lastComposerCaret, text.length));
	let end = token ? token.end : start;
	if (!token) {
		// Never split a marker: land after it instead.
		const marker = referenceAtOffset(ui.codeReferences, start);
		if (marker && start > marker.start && start < marker.end) {
			start = marker.end;
			end = marker.end;
		}
	}

	const caret = start + insertion.length;
	elements.input.value = `${text.slice(0, start)}${insertion}${text.slice(end)}`;
	elements.input.setSelectionRange(caret, caret);
	lastComposerCaret = caret;
	dismissCommandPalette();
	// Same sequence as the composer's `input` listener: this diffs against the
	// previous snapshot, posts any lost code references, and refreshes highlights.
	reconcileCodeReferencesWithComposer();
	resizeInput();
	persistComposerState();
	renderComposerHighlights();
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
 * The model and thinking pickers are custom popups rather than native
 * `<select>` elements: a native dropdown's list is drawn by the OS, so it
 * cannot follow the VS Code theme or this view's styling. The popup lives under
 * `#app` because both `.composer` and `#app` clip their overflow.
 */
type SelectKind = "model" | "thinking";

let activeSelect: SelectKind | undefined;

function selectTrigger(kind: SelectKind): HTMLButtonElement {
	return kind === "model" ? elements.modelSelect : elements.thinkingSelect;
}

function selectOptions(kind: SelectKind): { value: string; label: string }[] {
	if (kind === "thinking")
		return ui.thinkingLevels.map((level) => ({ value: level, label: level }));
	return ui.models.map((model) => ({
		value: `${model.provider}/${model.id}`,
		label: model.name || model.id,
	}));
}

function selectedValue(kind: SelectKind): string {
	if (kind === "thinking") return ui.state.thinkingLevel ?? "";
	return ui.state.model
		? `${ui.state.model.provider}/${ui.state.model.id}`
		: "";
}

function toggleSelect(kind: SelectKind): void {
	if (activeSelect === kind) closeSelect(true);
	else openSelect(kind);
}

function openSelect(kind: SelectKind): void {
	const trigger = selectTrigger(kind);
	if (trigger.disabled) return;
	const options = selectOptions(kind);
	if (options.length === 0) return;
	if (activeSelect) closeSelect(false);
	dismissHistory();
	dismissCommandPalette();
	activeSelect = kind;

	const current = selectedValue(kind);
	const rows = options.map((option) => {
		const row = document.createElement("div");
		row.className = "select-option";
		row.setAttribute("role", "option");
		row.tabIndex = -1;
		row.dataset.value = option.value;
		const selected = option.value === current;
		row.setAttribute("aria-selected", String(selected));
		const check = document.createElement("i");
		check.className = `codicon codicon-check select-option-check${
			selected ? "" : " is-hidden"
		}`;
		check.setAttribute("aria-hidden", "true");
		const label = document.createElement("span");
		label.className = "select-option-label";
		label.textContent = option.label;
		row.append(check, label);
		return row;
	});

	elements.selectPopup.replaceChildren(...rows);
	elements.selectPopup.classList.toggle("is-thinking", kind === "thinking");
	elements.selectPopup.hidden = false;
	trigger.setAttribute("aria-expanded", "true");
	positionSelectPopup(trigger);
	focusSelectOption(
		rows.find((row) => row.getAttribute("aria-selected") === "true") ?? rows[0],
	);
}

function focusSelectOption(row: HTMLElement | undefined): void {
	if (!row) return;
	row.focus();
	row.scrollIntoView({ block: "nearest" });
}

function positionSelectPopup(trigger: HTMLElement): void {
	positionPopupAbove(trigger, elements.selectPopup);
}

/**
 * Places a popup above a composer element, inside `#app`.
 *
 * Shared by the model/thinking listbox and the slash-command palette: the
 * composer sits at the bottom of the view, so both open upward, cap their height
 * at the space actually available, and clamp horizontally to stay in view.
 *
 * `anchor` defaults to the trigger but the palette passes the whole composer.
 * Anchoring the palette to its toolbar button put its bottom edge level with the
 * button, which is *below* the textarea — so the panel covered the text being
 * typed. The listbox pickers are short-lived and keep anchoring to their trigger.
 */
function positionPopupAbove(
	trigger: HTMLElement,
	popup: HTMLElement,
	anchor: HTMLElement = trigger,
): void {
	const appRect = elements.app.getBoundingClientRect();
	const rect = anchor.getBoundingClientRect();
	popup.style.bottom = `${Math.round(appRect.bottom - rect.top + 4)}px`;
	popup.style.maxHeight = `${Math.max(
		120,
		Math.round(rect.top - appRect.top - 12),
	)}px`;
	// Reset before measuring: offsetWidth has to be read at the popup's natural
	// width, not at whatever the previous placement left behind.
	popup.style.left = "0px";
	const left = Math.max(
		8,
		Math.min(
			Math.round(rect.left - appRect.left),
			Math.round(appRect.width - popup.offsetWidth - 8),
		),
	);
	popup.style.left = `${left}px`;
}

/**
 * Positions the command palette above the composer and matches its width, so the
 * list lines up with the input it writes into.
 */
function positionCommandPanel(): void {
	elements.commandPanel.style.width = `${Math.round(
		elements.composer.getBoundingClientRect().width,
	)}px`;
	positionPopupAbove(
		elements.commandButton,
		elements.commandPanel,
		elements.composer,
	);
}

function closeSelect(restoreFocus: boolean): void {
	const kind = activeSelect;
	activeSelect = undefined;
	elements.selectPopup.hidden = true;
	elements.selectPopup.replaceChildren();
	if (!kind) return;
	const trigger = selectTrigger(kind);
	trigger.setAttribute("aria-expanded", "false");
	if (restoreFocus) trigger.focus();
}

function commitSelect(kind: SelectKind, value: string): void {
	const unchanged = value === selectedValue(kind);
	closeSelect(true);
	if (unchanged) return;
	if (kind === "thinking") {
		runAction("setThinking", { level: value });
		return;
	}
	const [provider, ...idParts] = value.split("/");
	const modelId = idParts.join("/");
	if (provider && modelId) runAction("setModel", { provider, modelId });
}

async function handleImagePaste(event: ClipboardEvent): Promise<void> {
	const clipboard = event.clipboardData;
	if (!clipboard) return;
	const files = [...clipboard.items]
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter((file): file is File => Boolean(file));
	if (files.length === 0) return;
	event.preventDefault();

	const attachedImageCount = ui.attachments.filter(
		(attachment) => attachment.kind === "image",
	).length;
	if (attachedImageCount + files.length > MAX_IMAGE_COUNT) {
		showToast(`Attach at most ${MAX_IMAGE_COUNT} images per message`, "error");
		return;
	}

	let totalBytes = 0;
	for (const file of files) {
		if (!SUPPORTED_CLIPBOARD_IMAGE_TYPES.has(file.type.toLowerCase())) {
			showToast("Paste PNG, JPEG, GIF, or WebP images", "error");
			return;
		}
		if (file.size > MAX_IMAGE_BYTES) {
			showToast(
				`${file.name || "Clipboard image"} exceeds the 10 MB limit`,
				"error",
			);
			return;
		}
		totalBytes += file.size;
	}
	if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
		showToast("Pasted images exceed the 12 MB total limit", "error");
		return;
	}

	try {
		const images: PastedImage[] = await Promise.all(
			files.map(async (file, index) => ({
				name: file.name || `Pasted image ${index + 1}`,
				mimeType: file.type.toLowerCase(),
				data: await readFileAsBase64(file),
			})),
		);
		runAction("pasteImages", { images });
	} catch (error) {
		showToast(
			error instanceof Error ? error.message : "Could not read clipboard image",
			"error",
		);
	}
}

function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("error", () =>
			reject(new Error("Could not read clipboard image")),
		);
		reader.addEventListener("load", () => {
			if (typeof reader.result !== "string") {
				reject(new Error("Could not read clipboard image"));
				return;
			}
			const separator = reader.result.indexOf(",");
			if (separator < 0) {
				reject(new Error("Invalid clipboard image"));
				return;
			}
			resolve(reader.result.slice(separator + 1));
		});
		reader.readAsDataURL(file);
	});
}

function sendPrompt(): void {
	if (pendingSubmit || ui.connection !== "ready") return;
	const text = elements.input.value;
	if (
		!text.trim() &&
		ui.attachments.length === 0 &&
		ui.codeReferences.length === 0
	)
		return;
	// The send button can be clicked while the palette is open, and submitting
	// clears the text the palette was filtering on.
	dismissCommandPalette();
	pendingSubmit = true;
	runAction("submit", {
		text,
		attachmentIds: ui.attachments.map((attachment) => attachment.id),
		references: ui.codeReferences.map((reference) => ({
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
		| "setModel"
		| "setThinking"
		| "compact"
		| "restart"
		| "pasteImages",
	fields: JsonRecord = {},
): void {
	const actionId = crypto.randomUUID();
	const action: PendingAction = { type };
	if (type === "submit" || type === "newSession") {
		action.draft = elements.input.value;
		action.attachmentIds = ui.attachments.map((attachment) => attachment.id);
		action.referenceSnapshots = ui.codeReferences.map((reference) => ({
			...reference,
		}));
	}
	pendingActions.set(actionId, action);
	post({ type, actionId, ...fields } as WebviewToHostMessage);
}

function post(message: WebviewToHostMessage): void {
	vscode.postMessage(message);
}

function openConfirm(options: ConfirmOptions): void {
	if (options.dismissHistory) dismissHistory();
	elements.modalBackdrop.replaceChildren();
	const dialog = document.createElement("section");
	dialog.className = "modal";
	dialog.setAttribute("role", "dialog");
	dialog.setAttribute("aria-modal", "true");
	dialog.setAttribute("aria-label", options.title);
	const heading = document.createElement("h2");
	heading.textContent = options.title;
	const detail = document.createElement("p");
	detail.textContent = options.message;
	const actions = document.createElement("div");
	actions.className = "modal-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "secondary-button";
	cancel.textContent = "Cancel";
	cancel.addEventListener("click", closeModal);
	const confirm = document.createElement("button");
	confirm.type = "button";
	confirm.className = options.destructive ? "danger-button" : "primary-button";
	confirm.textContent = options.confirmLabel;
	confirm.addEventListener("click", () => {
		closeModal();
		options.onConfirm();
	});
	actions.append(cancel, confirm);
	dialog.append(heading, detail, actions);
	modalReturnFocus =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	elements.modalBackdrop.append(dialog);
	elements.modalBackdrop.hidden = false;
	setBackgroundInert(true);
	cancel.focus();
}

function closeModal(): void {
	elements.modalBackdrop.hidden = true;
	elements.modalBackdrop.replaceChildren();
	setBackgroundInert(false);
	modalReturnFocus?.focus();
	modalReturnFocus = null;
}

function handleModalKeydown(event: KeyboardEvent): void {
	if (event.key === "Escape") {
		event.preventDefault();
		closeModal();
		return;
	}
	if (event.key !== "Tab") return;
	const focusable = [
		...elements.modalBackdrop.querySelectorAll<HTMLElement>(
			"button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])",
		),
	].filter((item) => !item.hasAttribute("disabled"));
	if (focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable.at(-1);
	if (!first || !last) return;
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}

function setBackgroundInert(inert: boolean): void {
	elements.sessionHeader.inert = inert;
	elements.historyPanel.inert = inert;
	elements.transcript.inert = inert;
	elements.widgetArea.inert = inert;
	elements.composerShell.inert = inert;
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

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const value of content) {
		if (!value || typeof value !== "object") continue;
		const block = value as PiContentBlock;
		if (block.type === "text" && block.text) parts.push(block.text);
	}
	return parts.join("\n");
}

function contentImages(content: unknown): PiContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is PiContentBlock =>
		Boolean(block && typeof block === "object" && block.type === "image"),
	);
}

function markdown(text: string): string {
	return DOMPurify.sanitize(marked.parse(text) as string, {
		USE_PROFILES: { html: true },
		ADD_ATTR: ["target", "rel"],
	});
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

function summarizeTool(name: string, args: JsonRecord): string {
	const value =
		name === "bash"
			? stringValue(args.command)
			: stringValue(args.path) ||
				stringValue(args.file_path) ||
				stringValue(args.pattern) ||
				stringValue(args.query);
	return truncate(value || "", 88);
}

function resolveToolStatus(
	result?: PiMessage,
	live?: LiveTool,
): LiveTool["status"] {
	if (live) return live.status;
	if (!result) return "running";
	return result.isError ? "error" : "success";
}

function toolStatusPresentation(status: LiveTool["status"]): {
	label: string;
	icon: string;
} {
	if (status === "running")
		return { label: "Running", icon: "loading codicon-modifier-spin" };
	if (status === "error") return { label: "Failed", icon: "error" };
	return { label: "Done", icon: "check" };
}

function friendlyToolName(name: string): string {
	const labels: Record<string, string> = {
		bash: "Run command",
		read: "Read file",
		write: "Write file",
		edit: "Edit file",
		grep: "Search text",
		find: "Find files",
		ls: "List files",
	};
	return labels[name] ?? name.replaceAll("_", " ");
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

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/gu,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
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
