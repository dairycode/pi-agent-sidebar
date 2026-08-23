import { stat } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { AsyncQueue } from "./asyncQueue.js";
import {
	AttachmentStore,
	imageMimeTypeFromPath,
} from "../services/attachmentStore.js";
import { probePiBinary } from "../rpc/binaryProbe.js";
import { shouldSnapshotFileReference } from "../../shared/composerReferences.js";
import { PiRpcClient } from "../rpc/piRpcClient.js";
import { buildPrompt } from "../services/promptBuilder.js";
import {
	parseCommandsResponse,
	parseMessagesResponse,
	parseModelsResponse,
	parsePiState,
	parsePiStats,
	parseSessionChangeResult,
	parseThinkingLevelsResponse,
	validateRpcEvent,
} from "../rpc/rpcValidation.js";
import {
	deleteProjectSession,
	listProjectSessions,
	resolveSessionDirectory,
} from "../services/sessionStore.js";
import {
	parseWebviewMessage,
	type HostToWebviewMessage,
	type JsonRecord,
	type PiModel,
	type PiState,
	type PiStats,
	type WorkspaceEntrySuggestion,
} from "../../shared/protocol.js";
import {
	ComposerReferenceStore,
	MAX_TOTAL_COMPOSER_REFERENCE_BYTES,
} from "./composerReferenceStore.js";
import { createWebviewDocument } from "../webviewDocument.js";
import {
	parseDroppedResource,
	WorkspaceResources,
} from "../services/workspaceResources.js";
import { WorkspaceFileSearch } from "../services/workspaceFileSearch.js";
import { notificationDestination } from "./notificationPolicy.js";

const VIEW_TYPE = "piAgentSidebar.chatView";
const LONG_COMMAND_TIMEOUT_MS = 10 * 60_000;
const RESERVED_ARGUMENTS = new Set([
	"--mode",
	"--session",
	"--session-dir",
	"--continue",
	"-c",
	"--resume",
	"-r",
]);

export type PresetPromptKind =
	| "explainSelection"
	| "explainFile"
	| "refactorSelection"
	| "generateTests"
	| "explainDiagnostics";

const PRESET_INSTRUCTIONS: Record<PresetPromptKind, string> = {
	explainSelection:
		"Explain what the selected code does, step by step, and note anything surprising or risky.",
	explainFile:
		"Explain what this file does, its main responsibilities, and how its pieces fit together.",
	refactorSelection:
		"Refactor the selected code for clarity and maintainability without changing its behavior. Explain the key changes.",
	generateTests:
		"Write focused unit tests for the selected code using the project's existing test framework and conventions.",
	explainDiagnostics:
		"Explain the reported diagnostics for the selected code and propose a fix.",
};

class RuntimeUnavailableError extends Error {}

export class PiViewProvider
	implements vscode.WebviewViewProvider, vscode.Disposable
{
	public static readonly viewType = VIEW_TYPE;

	private view: vscode.WebviewView | undefined;
	private client: PiRpcClient | undefined;
	private startPromise: Promise<void> | undefined;
	private workspaceFolder: vscode.WorkspaceFolder | undefined;
	private state: PiState = {};
	private models: PiModel[] = [];
	private thinkingLevels: string[] = ["off"];
	private streaming = false;
	private disposed = false;
	private webviewReady = false;
	private composerFocusRequestSequence = Date.now();
	private pendingComposerFocusRequestId: number | undefined;
	private workspaceGeneration = 0;
	private snapshotSequence = 0;
	/**
	 * Set when a post is refused because the view is hidden.
	 *
	 * `retainContextWhenHidden` keeps the DOM alive, but the editor still drops
	 * messages aimed at a hidden view. Tracking the refusal means becoming visible
	 * again only costs a snapshot when something was actually missed — collapsing
	 * and expanding an idle session leaves the retained view untouched.
	 */
	private missedPostWhileHidden = false;
	private shutdownPromise: Promise<void> | undefined;
	private statusBarItem: vscode.StatusBarItem | undefined;
	private readonly sessionMutations = new AsyncQueue();
	private readonly attachmentStore: AttachmentStore;
	private readonly workspaceResources: WorkspaceResources;
	private readonly composerReferenceStore: ComposerReferenceStore;
	private readonly workspaceFileSearch = new WorkspaceFileSearch();

	public constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
	) {
		this.attachmentStore = new AttachmentStore(context.globalStorageUri.fsPath);
		this.workspaceResources = new WorkspaceResources(() =>
			this.selectWorkspaceFolder(),
		);
		this.composerReferenceStore = new ComposerReferenceStore(output);
		void this.attachmentStore.initialize().catch((error: unknown) => {
			this.output.appendLine(`[attachments] ${toErrorMessage(error)}`);
		});
	}

	public resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		this.webviewReady = false;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview"),
			],
		};
		view.webview.html = this.getHtml(view.webview);

		const messageDisposable = view.webview.onDidReceiveMessage(
			(message: unknown) => {
				void this.handleWebviewMessage(message);
			},
		);
		// `retainContextWhenHidden` keeps the DOM alive across a collapse, but the
		// editor refuses to deliver messages to a hidden view — so any pi event that
		// arrived while collapsed was dropped and the transcript came back stale.
		// Re-syncing on the way back fills that gap.
		const visibilityDisposable = view.onDidChangeVisibility(() => {
			if (!view.visible || this.view !== view || !this.webviewReady) return;
			void this.resyncAfterHidden();
		});
		const disposeDisposable = view.onDidDispose(() => {
			messageDisposable.dispose();
			visibilityDisposable.dispose();
			disposeDisposable.dispose();
			if (this.view === view) {
				this.view = undefined;
				this.webviewReady = false;
			}
		});

		void this.post({
			type: "bootstrap",
			phase: "starting",
			detail: "Starting pi...",
		});
	}

	public async reveal(): Promise<void> {
		await vscode.commands.executeCommand(`${VIEW_TYPE}.focus`);
	}

	/**
	 * Brings the webview back in step after it was hidden.
	 *
	 * Skipped unless a post was actually refused while hidden: a snapshot rebuilds
	 * the whole transcript DOM and resets the reader's scroll position, so paying
	 * that on every expand made an idle session flicker for no reason.
	 *
	 * Only runs when a pi process is already up: with no client there is nothing to
	 * snapshot, and `ready` handles the initial start. Failures are logged rather
	 * than surfaced — the view still holds its retained content, so a missed resync
	 * is a staleness problem, not a broken view.
	 */
	private async resyncAfterHidden(): Promise<void> {
		if (!this.missedPostWhileHidden) return;
		this.missedPostWhileHidden = false;
		if (!this.client?.isRunning) return;
		try {
			await Promise.all([
				this.syncAttachments(),
				this.syncComposerReferences(),
			]);
			await this.refreshSnapshot();
		} catch (error) {
			this.output.appendLine(`[visibility] ${toErrorMessage(error)}`);
		}
	}

	public async focusInputWithSelection(
		editor: vscode.TextEditor | undefined,
	): Promise<void> {
		if (editor && !editor.selection.isEmpty) {
			try {
				const id = this.composerReferenceStore.captureSelection(editor);
				await this.composerReferenceStore.enrichWithSymbol(id, editor);
			} catch (error) {
				void vscode.window.showWarningMessage(toErrorMessage(error));
			}
		}
		this.composerFocusRequestSequence += 1;
		this.pendingComposerFocusRequestId = this.composerFocusRequestSequence;
		await this.reveal();
		await Promise.all([this.syncAttachments(), this.syncComposerReferences()]);
	}

	public async addExplorerResources(
		primary: vscode.Uri | undefined,
		selected: readonly vscode.Uri[] | undefined,
	): Promise<void> {
		const uris =
			selected && selected.length > 0 ? selected : primary ? [primary] : [];
		if (uris.length === 0) return;
		await this.registerComposerReferences(uris);
		this.composerFocusRequestSequence += 1;
		this.pendingComposerFocusRequestId = this.composerFocusRequestSequence;
		await this.reveal();
		await this.syncComposerReferences();
	}

	public async runPresetPrompt(
		kind: PresetPromptKind,
		editor: vscode.TextEditor | undefined,
	): Promise<void> {
		if (!editor) {
			void vscode.window.showInformationMessage(
				"Open a file in the editor to use this Pi action.",
			);
			return;
		}
		const needsSelection =
			kind === "explainSelection" ||
			kind === "refactorSelection" ||
			kind === "generateTests" ||
			kind === "explainDiagnostics";
		if (needsSelection && editor.selection.isEmpty) {
			// Fall back to the whole document range so the reference is meaningful.
			const fullRange = new vscode.Selection(
				editor.document.positionAt(0),
				editor.document.positionAt(editor.document.getText().length),
			);
			editor.selection = fullRange;
		}
		try {
			if (kind === "explainFile") {
				const { document } = editor;
				if (
					shouldSnapshotFileReference(document.uri.scheme, document.isDirty)
				) {
					const fullRange = new vscode.Selection(
						document.positionAt(0),
						document.positionAt(document.getText().length),
					);
					this.composerReferenceStore.captureSelection(
						editor,
						fullRange,
						MAX_TOTAL_COMPOSER_REFERENCE_BYTES,
					);
				} else {
					this.composerReferenceStore.captureFile(document.uri);
				}
			} else {
				const id = this.composerReferenceStore.captureSelection(editor);
				await this.composerReferenceStore.enrichWithSymbol(id, editor);
			}
		} catch (error) {
			void vscode.window.showWarningMessage(toErrorMessage(error));
		}
		this.composerFocusRequestSequence += 1;
		this.pendingComposerFocusRequestId = this.composerFocusRequestSequence;
		await this.reveal();
		await this.syncComposerReferences();
		await this.post({
			type: "setComposerText",
			text: PRESET_INSTRUCTIONS[kind],
		});
	}

	public async exportSessionHtml(): Promise<void> {
		const client = await this.ensureClient();
		const result = (await client.request({ type: "export_html" })) as
			| { path?: unknown }
			| undefined;
		const exportedPath =
			result && typeof result.path === "string" ? result.path : undefined;
		if (!exportedPath) {
			void vscode.window.showWarningMessage(
				"Pi did not return an exported file path.",
			);
			return;
		}
		const choice = await vscode.window.showInformationMessage(
			`Exported session to ${exportedPath}`,
			"Open",
		);
		if (choice === "Open") {
			const document = await vscode.workspace.openTextDocument(
				vscode.Uri.file(exportedPath),
			);
			await vscode.window.showTextDocument(document, { preview: true });
		}
	}

	public async renameSession(): Promise<void> {
		const name = await vscode.window.showInputBox({
			title: "Rename Pi Session",
			prompt: "Enter a display name for the current session.",
			value:
				typeof this.state.sessionName === "string"
					? this.state.sessionName
					: "",
			ignoreFocusOut: true,
		});
		if (name === undefined) return;
		await this.applySessionName(name);
	}

	/**
	 * Shared rename core for the command palette and webview flows. The name is
	 * applied through pi's public `set_session_name` RPC, which only ever targets
	 * the current session, so non-active sessions cannot be renamed without
	 * switching to them first.
	 */
	private applySessionName(name: string): Promise<void> {
		return this.sessionMutations.enqueue(async () => {
			const trimmed = name.trim();
			if (!trimmed) throw new Error("Session name cannot be empty.");
			const client = await this.ensureClient();
			await client.request({ type: "set_session_name", name: trimmed });
			await this.refreshSnapshot();
			await this.sendSessionList();
		});
	}

	public bindStatusBar(item: vscode.StatusBarItem): void {
		this.statusBarItem = item;
		this.updateStatusBar("starting");
	}

	private updateStatusBar(
		phase: "starting" | "ready" | "disconnected" | "error" | "no-workspace",
	): void {
		const item = this.statusBarItem;
		if (!item) return;
		const modelName = this.state.model?.name ?? this.state.model?.id;
		let icon = "$(sparkle)";
		let label = "Pi";
		switch (phase) {
			case "ready":
				icon = this.streaming ? "$(sync~spin)" : "$(sparkle)";
				label = modelName ? `Pi · ${modelName}` : "Pi";
				break;
			case "starting":
				icon = "$(loading~spin)";
				label = "Pi starting";
				break;
			case "disconnected":
				icon = "$(debug-disconnect)";
				label = "Pi stopped";
				break;
			case "error":
				icon = "$(error)";
				label = "Pi error";
				break;
			case "no-workspace":
				icon = "$(folder)";
				label = "Pi";
				break;
			default:
				break;
		}
		item.text = `${icon} ${label}`;
		const tooltipParts = ["Open Pi Agent"];
		if (modelName) tooltipParts.push(`Model: ${modelName}`);
		if (this.state.thinkingLevel)
			tooltipParts.push(`Thinking: ${this.state.thinkingLevel}`);
		const contextPercent = this.state.contextPercent;
		if (typeof contextPercent === "number")
			tooltipParts.push(`Context: ${contextPercent}%`);
		item.tooltip = tooltipParts.join("\n");
		item.show();
	}

	public async createNewSession(requireConfirmation = true): Promise<boolean> {
		if (requireConfirmation && (this.state.messageCount ?? 0) > 0) {
			const choice = await vscode.window.showWarningMessage(
				"Start a new pi session? The current session remains available in history.",
				{ modal: true },
				"New Session",
			);
			if (choice !== "New Session") return false;
		}
		const references = this.composerReferenceStore.snapshot();
		const attachments = this.attachmentStore.resolve(
			this.attachmentStore.list().map((attachment) => attachment.id),
		);
		return this.sessionMutations.enqueue(async () => {
			const client = await this.ensureClient();
			const result = parseSessionChangeResult(
				await client.request({ type: "new_session" }),
			);
			if (result?.cancelled) return false;
			this.composerReferenceStore.consume(references);
			await this.attachmentStore.removeResolved(attachments);
			await Promise.all([
				this.syncAttachments(),
				this.syncComposerReferences(),
			]);
			await this.refreshSnapshot();
			return true;
		});
	}

	public async restart(): Promise<void> {
		await this.startClient(true);
	}

	public async handleWorkspaceFoldersChanged(): Promise<void> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (
			this.workspaceFolder &&
			folders.some(
				(folder) =>
					folder.uri.toString() === this.workspaceFolder?.uri.toString(),
			)
		) {
			return;
		}

		this.workspaceGeneration += 1;
		const pendingStart = this.startPromise;
		const client = this.client;
		this.workspaceFolder = undefined;
		this.state = {};
		this.client = undefined;
		this.composerReferenceStore.clear();
		this.workspaceFileSearch.invalidate();
		this.pendingComposerFocusRequestId = undefined;
		await this.attachmentStore.clear();
		if (client) await client.stop();
		await this.post({
			type: "bootstrap",
			phase: "starting",
			detail: "Workspace changed. Starting pi...",
		});
		await Promise.all([this.syncAttachments(), this.syncComposerReferences()]);
		if (pendingStart) await pendingStart.catch(() => undefined);
		if (this.view) {
			try {
				await this.ensureClient();
			} catch (error) {
				if (!(error instanceof RuntimeUnavailableError)) throw error;
			}
		}
	}

	public shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.disposed = true;
		this.workspaceGeneration += 1;
		const client = this.client;
		this.client = undefined;
		this.shutdownPromise = (async () => {
			if (client) await client.stop();
			await this.sessionMutations.drain();
			await this.attachmentStore.dispose();
			this.workspaceFileSearch.dispose();
		})();
		return this.shutdownPromise;
	}

	public dispose(): void {
		void this.shutdown();
	}

	private async handleWebviewMessage(value: unknown): Promise<void> {
		const message = parseWebviewMessage(value);
		if (!message) {
			this.output.appendLine("[webview] Ignored an invalid message.");
			return;
		}
		try {
			switch (message.type) {
				case "ready": {
					this.webviewReady = true;
					await Promise.all([
						this.syncAttachments(),
						this.syncComposerReferences(),
					]);
					const wasRunning = Boolean(this.client?.isRunning);
					await this.ensureClient();
					if (wasRunning) await this.refreshSnapshot();
					break;
				}
				case "composerFocused": {
					if (message.requestId === this.pendingComposerFocusRequestId) {
						this.pendingComposerFocusRequestId = undefined;
					}
					break;
				}
				case "submit": {
					await this.respondToAction(message.actionId, () =>
						this.submitPrompt(
							message.text,
							message.attachmentIds,
							message.references,
						),
					);
					break;
				}
				case "abort": {
					await this.respondToAction(message.actionId, () =>
						this.abortPrompt(),
					);
					break;
				}
				case "newSession": {
					await this.respondToAction(message.actionId, async () => {
						if (!(await this.createNewSession(false))) {
							throw new Error("New session was cancelled by a pi extension.");
						}
					});
					break;
				}
				case "switchSession": {
					await this.respondToAction(message.actionId, () =>
						this.switchSession(message.path),
					);
					break;
				}
				case "deleteSession": {
					await this.respondToAction(message.actionId, () =>
						this.deleteSession(message.path),
					);
					break;
				}
				case "renameSession": {
					await this.respondToAction(message.actionId, () =>
						this.applySessionName(message.name),
					);
					break;
				}
				case "setModel": {
					await this.respondToAction(message.actionId, () =>
						this.setModel(message.provider, message.modelId),
					);
					break;
				}
				case "setThinking": {
					await this.respondToAction(message.actionId, () =>
						this.setThinkingLevel(message.level),
					);
					break;
				}
				case "compact": {
					await this.respondToAction(message.actionId, () =>
						this.compactSession(),
					);
					break;
				}
				case "restart": {
					await this.respondToAction(message.actionId, async () =>
						this.startClient(true),
					);
					break;
				}
				case "listSessions": {
					await this.sendSessionList();
					break;
				}
				case "listCommands": {
					await this.sendCommandList();
					break;
				}
				case "listWorkspaceFiles": {
					await this.sendWorkspaceFileList(message.requestId, message.query);
					break;
				}
				case "pickAttachments": {
					await this.pickAttachments();
					break;
				}
				case "addResources": {
					await this.respondToAction(message.actionId, () =>
						this.addResources(message.resources),
					);
					break;
				}
				case "pasteImages": {
					await this.respondToAction(message.actionId, async () => {
						await this.attachmentStore.storePastedImages(message.images);
						await this.syncAttachments();
					});
					break;
				}
				case "removeAttachment": {
					await this.attachmentStore.remove(message.id);
					await this.syncAttachments();
					break;
				}
				case "removeComposerReference": {
					await this.removeComposerReference(message.id, message.revision);
					break;
				}
				case "openComposerReference": {
					await this.openComposerReference(message.id);
					break;
				}
				case "openExternal": {
					await this.openExternal(message.href);
					break;
				}
				case "openResource": {
					await this.workspaceResources.openResource(message.uri, message.line);
					break;
				}
				case "openWorkspacePath": {
					await this.workspaceResources.openWorkspacePath(
						message.path,
						message.line,
					);
					break;
				}
				case "showLogs": {
					this.output.show(true);
					break;
				}
				default:
					break;
			}
		} catch (error) {
			if (error instanceof RuntimeUnavailableError) return;
			const detail = toErrorMessage(error);
			this.output.appendLine(`[webview] ${detail}`);
			if ("actionId" in message && typeof message.actionId === "string") {
				await this.post({
					type: "actionResult",
					actionId: message.actionId,
					ok: false,
					error: detail,
				});
			} else {
				await this.post({ type: "connection", phase: "error", detail });
			}
		}
	}

	private async submitPrompt(
		text: string,
		attachmentIds: unknown,
		referenceIdentities: unknown,
	): Promise<void> {
		const attachments = this.attachmentStore.resolve(attachmentIds);
		const references = this.composerReferenceStore.resolve(
			referenceIdentities,
			text,
		);
		const client = await this.ensureClient();
		const prompt = await buildPrompt(
			text,
			attachments,
			references.map(({ reference }) => reference),
			this.attachmentStore,
		);
		if (!prompt.message.trim() && prompt.images.length === 0)
			throw new Error("Enter a message or attach context.");
		await client.request({
			type: "prompt",
			message: prompt.message,
			images: prompt.images.length > 0 ? prompt.images : undefined,
			streamingBehavior: this.streaming ? "steer" : undefined,
		});
		this.composerReferenceStore.consume(
			references.map(({ reference }) => reference),
		);
		await this.attachmentStore.removeResolved(attachments);
		await Promise.all([this.syncAttachments(), this.syncComposerReferences()]);
	}

	private async abortPrompt(): Promise<void> {
		const client = await this.ensureClient();
		await client.request({ type: "abort" });
	}

	private switchSession(sessionPath: string): Promise<void> {
		return this.sessionMutations.enqueue(async () => {
			const client = await this.ensureClient();
			const folder = await this.workspaceResources.requireWorkspaceFolder();
			const sessions = await listProjectSessions(
				folder.uri.fsPath,
				this.state.sessionFile,
				this.configuredSessionDirectory(folder),
			);
			if (!sessions.some((session) => session.path === sessionPath)) {
				throw new Error("Session is not part of this workspace.");
			}
			const result = parseSessionChangeResult(
				await client.request({ type: "switch_session", sessionPath }),
			);
			if (result?.cancelled) {
				throw new Error("Session switch was cancelled by a pi extension.");
			}
			await this.refreshSnapshot();
		});
	}

	private deleteSession(sessionPath: string): Promise<void> {
		return this.sessionMutations.enqueue(async () => {
			const folder = await this.workspaceResources.requireWorkspaceFolder();
			const client = await this.ensureClient();
			const freshState = parsePiState(
				await client.request({ type: "get_state" }),
			);
			if (this.client !== client) {
				throw new Error("Pi restarted before the session could be deleted.");
			}
			this.state = freshState;
			await deleteProjectSession(
				folder.uri.fsPath,
				sessionPath,
				freshState.sessionFile,
				this.configuredSessionDirectory(folder),
			);
			await this.sendSessionList();
		});
	}

	private async setModel(provider: string, modelId: string): Promise<void> {
		if (
			!this.models.some(
				(model) => model.provider === provider && model.id === modelId,
			)
		) {
			throw new Error("Selected model is no longer available.");
		}
		const client = await this.ensureClient();
		await client.request({ type: "set_model", provider, modelId });
		await this.refreshSnapshot();
	}

	private async setThinkingLevel(level: string): Promise<void> {
		if (!this.thinkingLevels.includes(level))
			throw new Error("Thinking level is not supported by this model.");
		const client = await this.ensureClient();
		await client.request({ type: "set_thinking_level", level });
		await this.refreshSnapshot();
	}

	private async compactSession(): Promise<void> {
		const client = await this.ensureClient();
		await client.request({ type: "compact" }, LONG_COMMAND_TIMEOUT_MS);
		await this.refreshSnapshot();
	}

	private async ensureClient(): Promise<PiRpcClient> {
		if (this.startPromise) await this.startPromise;
		if (this.client?.isRunning) return this.client;
		await this.startClient(false);
		if (!this.client?.isRunning)
			throw new RuntimeUnavailableError("Pi runtime is unavailable.");
		return this.client;
	}

	private async startClient(force: boolean): Promise<void> {
		if (this.startPromise) return this.startPromise;
		if (!force && this.client?.isRunning) return;

		this.startPromise = this.doStartClient(force).finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	private async doStartClient(force: boolean): Promise<void> {
		if (this.disposed) return;
		const generation = this.workspaceGeneration;
		await this.post({
			type: "connection",
			phase: "starting",
			detail: force ? "Restarting pi..." : "Starting pi...",
		});

		if (!vscode.workspace.isTrusted) {
			await this.post({
				type: "bootstrap",
				phase: "no-workspace",
				detail:
					"Trust this workspace to let pi read, edit, and run project files.",
			});
			return;
		}

		const folder = await this.selectWorkspaceFolder();
		if (generation !== this.workspaceGeneration) return;
		if (!folder) {
			await this.post({
				type: "bootstrap",
				phase: "no-workspace",
				detail: "Open a workspace folder to start pi.",
			});
			return;
		}

		const configuration = vscode.workspace.getConfiguration("piAgentSidebar");
		const binary = configuration.get<string>("binaryPath", "pi").trim() || "pi";
		const additionalArguments = configuration.get<string[]>(
			"additionalArguments",
			[],
		);
		this.validateAdditionalArguments(additionalArguments);

		const probe = await probePiBinary(binary, folder.uri.fsPath);
		if (generation !== this.workspaceGeneration) return;
		this.output.appendLine(
			`[runtime] ${binary} ${probe.version} in ${folder.uri.fsPath}`,
		);
		if (probe.warning) {
			this.output.appendLine(`[runtime] ${probe.warning}`);
			void vscode.window.showWarningMessage(probe.warning);
		}

		const previousClient = this.client;
		this.client = undefined;
		if (previousClient) await previousClient.stop();
		if (generation !== this.workspaceGeneration) return;

		const args = [...additionalArguments, "--mode", "rpc"];
		const sessionDirectory = this.configuredSessionDirectory(folder);
		if (sessionDirectory) args.push("--session-dir", sessionDirectory);
		if (configuration.get<boolean>("trustProjectResources", true))
			args.push("--approve");
		else args.push("--no-approve");

		if (configuration.get<boolean>("restoreSession", true)) {
			const lastSession = this.context.workspaceState.get<string>(
				this.sessionStorageKey(folder),
			);
			if (lastSession && (await fileExists(lastSession)))
				args.push("--session", lastSession);
		}
		if (generation !== this.workspaceGeneration) return;

		const client = new PiRpcClient({
			binary,
			args,
			cwd: folder.uri.fsPath,
			env: process.env,
		});
		this.client = client;
		this.attachClientListeners(client);
		await client.start();
		if (generation !== this.workspaceGeneration) {
			if (this.client === client) this.client = undefined;
			await client.stop();
			return;
		}
		const autoRetry = configuration.get<boolean>("autoRetry", true);
		try {
			await client.request({ type: "set_auto_retry", enabled: autoRetry });
		} catch (error) {
			this.output.appendLine(
				`[runtime] set_auto_retry: ${toErrorMessage(error)}`,
			);
		}
		await this.refreshSnapshot();
	}

	private attachClientListeners(client: PiRpcClient): void {
		client.onStderr((text) => this.output.append(text));
		client.onProtocolError((message) => {
			this.output.appendLine(`[protocol] ${message}`);
			void this.post({ type: "connection", phase: "error", detail: message });
		});
		client.onExit((exit) => {
			if (this.client !== client) return;
			this.streaming = false;
			this.output.appendLine(
				`[runtime] Pi exited with code ${String(exit.code)}, signal ${String(exit.signal)}.`,
			);
			void this.post({
				type: "connection",
				phase: "disconnected",
				detail: "Pi stopped. Restart the runtime to continue.",
			});
		});
		client.onEvent((event) => {
			if (this.client !== client) return;
			try {
				validateRpcEvent(event);
			} catch (error) {
				this.output.appendLine(`[protocol] ${toErrorMessage(error)}`);
				return;
			}
			if (event.type === "agent_start") this.streaming = true;
			if (event.type === "agent_settled") {
				this.streaming = false;
				void this.refreshSnapshot().catch((error: unknown) => {
					this.handleSnapshotError(error);
				});
			}
			if (event.type === "extension_ui_request") {
				void this.handleExtensionUiRequest(client, event).catch(
					(error: unknown) => {
						this.output.appendLine(`[extension-ui] ${toErrorMessage(error)}`);
					},
				);
				return;
			}
			void this.post({ type: "rpcEvent", event });
		});
	}

	private async handleExtensionUiRequest(
		client: PiRpcClient,
		event: JsonRecord,
	): Promise<void> {
		const id = typeof event.id === "string" ? event.id : undefined;
		const method = typeof event.method === "string" ? event.method : "";
		if (!id || this.client !== client) return;

		try {
			if (method === "notify") {
				const message =
					typeof event.message === "string" ? event.message : "Pi notification";
				const destination = notificationDestination(event.notifyType);
				if (destination === "error")
					void vscode.window.showErrorMessage(message);
				else if (destination === "warning")
					void vscode.window.showWarningMessage(message);
				else this.output.appendLine(`[pi notification] ${message}`);
				return;
			}
			if (method === "set_editor_text" && typeof event.text === "string") {
				if (this.client === client) {
					await this.post({ type: "setComposerText", text: event.text });
				}
				return;
			}
			if (
				method === "setTitle" &&
				typeof event.title === "string" &&
				this.client === client &&
				this.view
			) {
				this.view.title = event.title;
				return;
			}
			if (["setStatus", "setWidget"].includes(method)) {
				if (this.client === client)
					await this.post({ type: "rpcEvent", event });
				return;
			}

			if (method === "select") {
				const options = Array.isArray(event.options)
					? event.options.filter(
							(item): item is string => typeof item === "string",
						)
					: [];
				const value = await vscode.window.showQuickPick(options, {
					title: typeof event.title === "string" ? event.title : "Pi",
					ignoreFocusOut: true,
				});
				await this.notifyExtensionUiResponse(
					client,
					value === undefined
						? { type: "extension_ui_response", id, cancelled: true }
						: { type: "extension_ui_response", id, value },
				);
				return;
			}
			if (method === "confirm") {
				const accepted = await vscode.window.showInformationMessage(
					typeof event.message === "string" ? event.message : "Continue?",
					{
						modal: true,
						detail: typeof event.title === "string" ? event.title : undefined,
					},
					"Confirm",
				);
				await this.notifyExtensionUiResponse(client, {
					type: "extension_ui_response",
					id,
					confirmed: accepted === "Confirm",
				});
				return;
			}
			if (method === "input") {
				const value = await vscode.window.showInputBox({
					title: typeof event.title === "string" ? event.title : "Pi input",
					placeHolder:
						typeof event.placeholder === "string"
							? event.placeholder
							: undefined,
					ignoreFocusOut: true,
				});
				await this.notifyExtensionUiResponse(
					client,
					value === undefined
						? { type: "extension_ui_response", id, cancelled: true }
						: { type: "extension_ui_response", id, value },
				);
				return;
			}
			if (method === "editor") {
				const document = await vscode.workspace.openTextDocument({
					content: typeof event.prefill === "string" ? event.prefill : "",
					language: "markdown",
				});
				await vscode.window.showTextDocument(document, { preview: true });
				const choice = await vscode.window.showInformationMessage(
					typeof event.title === "string"
						? event.title
						: "Edit the pi response",
					{
						detail:
							"Edit the opened document, then submit or cancel this request.",
					},
					"Submit",
					"Cancel",
				);
				await this.notifyExtensionUiResponse(
					client,
					choice === "Submit"
						? { type: "extension_ui_response", id, value: document.getText() }
						: { type: "extension_ui_response", id, cancelled: true },
				);
				return;
			}
			await this.notifyExtensionUiResponse(client, {
				type: "extension_ui_response",
				id,
				cancelled: true,
			});
		} catch (error) {
			this.output.appendLine(`[extension-ui] ${toErrorMessage(error)}`);
			try {
				await this.notifyExtensionUiResponse(client, {
					type: "extension_ui_response",
					id,
					cancelled: true,
				});
			} catch (responseError) {
				this.output.appendLine(
					`[extension-ui] Failed to cancel request: ${toErrorMessage(responseError)}`,
				);
			}
		}
	}

	private async notifyExtensionUiResponse(
		client: PiRpcClient,
		response: JsonRecord,
	): Promise<void> {
		if (this.client !== client || !client.isRunning) return;
		await client.notify(response);
	}

	private handleSnapshotError(error: unknown): void {
		const detail = `Unable to refresh the pi session: ${toErrorMessage(error)}`;
		this.output.appendLine(`[snapshot] ${detail}`);
		void this.post({ type: "connection", phase: "error", detail });
	}

	private async refreshSnapshot(): Promise<void> {
		const sequence = ++this.snapshotSequence;
		const client = this.client;
		const folder = this.workspaceFolder;
		if (!client?.isRunning || !folder) return;

		const [
			stateResult,
			messagesResult,
			statsResult,
			modelsResult,
			levelsResult,
			commandsResult,
		] = await Promise.allSettled([
			client.request({ type: "get_state" }),
			client.request({ type: "get_messages" }),
			client.request({ type: "get_session_stats" }),
			client.request({ type: "get_available_models" }),
			client.request({ type: "get_available_thinking_levels" }),
			client.request({ type: "get_commands" }),
		]);

		if (this.client !== client || sequence !== this.snapshotSequence) return;
		if (stateResult.status === "rejected") throw stateResult.reason;
		if (messagesResult.status === "rejected") throw messagesResult.reason;

		this.state = parsePiState(stateResult.value);
		const messages = parseMessagesResponse(messagesResult.value);
		this.streaming = Boolean(this.state.isStreaming);
		this.models = this.parseOptionalSnapshot(
			"models",
			modelsResult,
			parseModelsResponse,
			[],
		);
		this.thinkingLevels = this.parseOptionalSnapshot(
			"thinking levels",
			levelsResult,
			parseThinkingLevelsResponse,
			["off"],
		);
		const stats = this.parseOptionalSnapshot<PiStats | undefined>(
			"session stats",
			statsResult,
			parsePiStats,
			undefined,
		);
		const commands = this.parseOptionalSnapshot(
			"commands",
			commandsResult,
			parseCommandsResponse,
			[],
		);

		if (this.state.sessionFile) {
			await this.context.workspaceState.update(
				this.sessionStorageKey(folder),
				this.state.sessionFile,
			);
		}

		await this.post({
			type: "snapshot",
			state: this.state,
			messages,
			stats,
			models: this.models,
			thinkingLevels: this.thinkingLevels,
			commands,
			workspaceName: folder.name,
		});
		await this.post({ type: "connection", phase: "ready" });
	}

	private parseOptionalSnapshot<T>(
		label: string,
		result: PromiseSettledResult<unknown>,
		parse: (value: unknown) => T,
		fallback: T,
	): T {
		if (result.status === "rejected") {
			this.output.appendLine(
				`[snapshot] ${label}: ${toErrorMessage(result.reason)}`,
			);
			return fallback;
		}
		try {
			return parse(result.value);
		} catch (error) {
			this.output.appendLine(`[snapshot] ${label}: ${toErrorMessage(error)}`);
			return fallback;
		}
	}

	private async respondToAction(
		actionId: string,
		operation: () => Promise<void>,
	): Promise<void> {
		try {
			await operation();
			await this.post({ type: "actionResult", actionId, ok: true });
		} catch (error) {
			await this.post({
				type: "actionResult",
				actionId,
				ok: false,
				error: toErrorMessage(error),
			});
		}
	}

	private async sendSessionList(): Promise<void> {
		const folder = await this.workspaceResources.requireWorkspaceFolder();
		const sessions = await listProjectSessions(
			folder.uri.fsPath,
			this.state.sessionFile,
			this.configuredSessionDirectory(folder),
		);
		await this.post({ type: "sessionList", sessions });
	}

	/**
	 * Re-reads pi's command list on demand.
	 *
	 * The snapshot copy can be stale: extensions, prompt templates, and skills
	 * are loaded (and reloaded) independently of the session events that trigger
	 * a snapshot refresh. A failure here is non-fatal — the panel keeps showing
	 * whatever the last snapshot carried.
	 */
	private async sendCommandList(): Promise<void> {
		const client = await this.ensureClient();
		try {
			const response = await client.request({ type: "get_commands" });
			await this.post({
				type: "commandList",
				commands: parseCommandsResponse(response),
			});
		} catch (error) {
			this.output.appendLine(`[commands] ${toErrorMessage(error)}`);
		}
	}

	/**
	 * Answers one `@` mention query.
	 *
	 * The request id travels back with the results so the webview can drop
	 * responses that a newer keystroke has already superseded — searches resolve
	 * out of order once a cold cache walk overlaps a warm one.
	 */
	private async sendWorkspaceFileList(
		requestId: number,
		query: string,
	): Promise<void> {
		if (!this.webviewReady) return;
		let entries: WorkspaceEntrySuggestion[] = [];
		try {
			entries = await this.workspaceFileSearch.search(query);
		} catch (error) {
			this.output.appendLine(`[mentions] ${toErrorMessage(error)}`);
		}
		await this.post({ type: "workspaceFileList", requestId, query, entries });
	}

	private async syncComposerReferences(): Promise<void> {
		if (!this.webviewReady) return;
		await this.post({
			type: "composerReferences",
			references: this.composerReferenceStore.summaries(),
			focusRequestId: this.pendingComposerFocusRequestId,
		});
	}

	private async removeComposerReference(
		id: unknown,
		revision: unknown,
	): Promise<void> {
		if (!this.composerReferenceStore.remove(id, revision)) return;
		await this.syncComposerReferences();
	}

	private async openComposerReference(id: string): Promise<void> {
		await this.composerReferenceStore.open(id);
	}

	private async pickAttachments(): Promise<void> {
		const folder = await this.workspaceResources.requireWorkspaceFolder();
		const selected = await vscode.window.showOpenDialog({
			defaultUri: folder.uri,
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			openLabel: "Attach to pi",
		});
		if (!selected) return;

		try {
			const uris = await this.workspaceResources.validateFiles(selected);
			this.attachmentStore.registerSelected(
				uris.map((uri) => {
					const mimeType = imageMimeTypeFromPath(uri.fsPath);
					return {
						filePath: uri.fsPath,
						label: path.basename(uri.fsPath) || uri.fsPath,
						kind: mimeType ? ("image" as const) : ("file" as const),
						mimeType,
					};
				}),
			);
			await this.syncAttachments();
		} catch (error) {
			void vscode.window.showWarningMessage(toErrorMessage(error));
		}
	}

	private async addResources(resources: string[]): Promise<void> {
		const uris = resources.map(parseDroppedResource);
		await this.registerComposerReferences(uris);
		await this.syncComposerReferences();
	}

	private async registerComposerReferences(
		uris: readonly vscode.Uri[],
	): Promise<void> {
		const fileUris = await this.workspaceResources.validateFiles(uris);
		this.composerReferenceStore.registerFiles(fileUris);
	}

	private async syncAttachments(): Promise<void> {
		if (!this.webviewReady) return;
		await this.post({
			type: "attachments",
			attachments: this.attachmentStore.list(),
		});
	}

	private async selectWorkspaceFolder(): Promise<
		vscode.WorkspaceFolder | undefined
	> {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) return undefined;
		if (
			this.workspaceFolder &&
			folders.some(
				(folder) =>
					folder.uri.toString() === this.workspaceFolder?.uri.toString(),
			)
		) {
			return this.workspaceFolder;
		}

		const savedUri = this.context.workspaceState.get<string>(
			"piAgentSidebar.workspaceFolder",
		);
		const saved = folders.find((folder) => folder.uri.toString() === savedUri);
		if (saved) {
			this.workspaceFolder = saved;
			return saved;
		}

		const selected =
			folders.length === 1
				? folders[0]
				: await vscode.window.showWorkspaceFolderPick({
						placeHolder:
							"Select the workspace folder pi can edit and run commands in",
					});
		if (selected) {
			this.workspaceFolder = selected;
			await this.context.workspaceState.update(
				"piAgentSidebar.workspaceFolder",
				selected.uri.toString(),
			);
		}
		return selected;
	}

	private validateAdditionalArguments(args: string[]): void {
		for (const argument of args) {
			const key = argument.split("=")[0];
			if (key && RESERVED_ARGUMENTS.has(key)) {
				throw new Error(
					`Remove reserved argument '${argument}' from piAgentSidebar.additionalArguments.`,
				);
			}
		}
	}

	/**
	 * Opens a link from the transcript. Going through the host rather than
	 * letting VS Code's injected anchor handler do it is deliberate: that handler
	 * passes `fromWorkspace: true`, which makes the trusted-domain validator
	 * return early in a trusted workspace, so it never prompts. This path has no
	 * such flag and still gets validated.
	 */
	private async openExternal(href: string): Promise<void> {
		let uri: vscode.Uri;
		try {
			uri = vscode.Uri.parse(href, true);
		} catch {
			throw new Error("Invalid external link.");
		}
		if (uri.scheme !== "https" && uri.scheme !== "http")
			throw new Error("Only HTTP and HTTPS links can be opened.");
		await vscode.env.openExternal(uri);
	}

	private configuredSessionDirectory(
		folder: vscode.WorkspaceFolder,
	): string | undefined {
		const configured = vscode.workspace
			.getConfiguration("piAgentSidebar")
			.get<string>("sessionDirectory", "");
		return resolveSessionDirectory(folder.uri.fsPath, configured);
	}

	private sessionStorageKey(folder: vscode.WorkspaceFolder): string {
		return `piAgentSidebar.lastSession:${folder.uri.toString()}`;
	}

	private async post(message: HostToWebviewMessage): Promise<boolean> {
		if (message.type === "connection") this.updateStatusBar(message.phase);
		else if (message.type === "bootstrap" && message.phase === "no-workspace")
			this.updateStatusBar("no-workspace");
		else if (message.type === "snapshot") this.updateStatusBar("ready");
		if (!this.view) return false;
		const delivered = await this.view.webview.postMessage(message);
		// A hidden view refuses delivery; remember it so the next reveal resyncs.
		if (!delivered) this.missedPostWhileHidden = true;
		return delivered;
	}

	private getHtml(webview: vscode.Webview): string {
		return createWebviewDocument(webview, this.context.extensionUri);
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
