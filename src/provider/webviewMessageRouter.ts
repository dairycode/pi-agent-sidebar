import { assertNever } from "../../shared/assertNever.js";
import type { WebviewToHostMessage } from "../../shared/protocol.js";

type ActionMessage = Extract<WebviewToHostMessage, { actionId: string }>;
type AsyncOperation = () => Promise<void>;

export interface WebviewMessageRouterOptions {
	onReady(): Promise<void>;
	onComposerFocused(requestId: number): void;
	respondToAction(actionId: string, operation: AsyncOperation): Promise<void>;
	onSubmit(message: Extract<WebviewToHostMessage, { type: "submit" }>): Promise<void>;
	onAbort(): Promise<void>;
	onNewSession(): Promise<void>;
	onCloneSession(): Promise<void>;
	onListForkCandidates(): Promise<void>;
	onForkSession(entryId: string): Promise<void>;
	onSwitchSession(path: string): Promise<void>;
	onDeleteSession(path: string): Promise<void>;
	onRenameSession(name: string): Promise<void>;
	onSetModel(provider: string, modelId: string): Promise<void>;
	onSetThinking(level: string): Promise<void>;
	onCompact(): Promise<void>;
	onRestart(): Promise<void>;
	onListSessions(): Promise<void>;
	onListCommands(): Promise<void>;
	onListWorkspaceFiles(requestId: number, query: string): Promise<void>;
	onResolveMedia(requestId: number, sources: string[]): Promise<void>;
	onPickAttachments(): Promise<void>;
	onAddResources(resources: string[]): Promise<void>;
	onPasteImages(images: Extract<WebviewToHostMessage, { type: "pasteImages" }>['images']): Promise<void>;
	onRemoveAttachment(id: string): Promise<void>;
	onRemoveComposerReference(id: string, revision: number): Promise<void>;
	onOpenComposerReference(id: string): Promise<void>;
	onOpenExternal(href: string): Promise<void>;
	onOpenResource(uri: string, line?: number): Promise<void>;
	onOpenWorkspacePath(path: string, line?: number): Promise<void>;
	onShowLogs(): void;
}

/** Routes decoded Webview messages to host-side operations. */
export class WebviewMessageRouter {
	public constructor(private readonly options: WebviewMessageRouterOptions) {}

	public async dispatch(message: WebviewToHostMessage): Promise<void> {
		switch (message.type) {
			case "ready":
				await this.options.onReady();
				return;
			case "composerFocused":
				this.options.onComposerFocused(message.requestId);
				return;
			case "submit":
				await this.runAction(message, () => this.options.onSubmit(message));
				return;
			case "abort":
				await this.runAction(message, () => this.options.onAbort());
				return;
			case "newSession":
				await this.runAction(message, () => this.options.onNewSession());
				return;
			case "cloneSession":
				await this.runAction(message, () => this.options.onCloneSession());
				return;
			case "listForkCandidates":
				await this.runAction(message, () => this.options.onListForkCandidates());
				return;
			case "forkSession":
				await this.runAction(message, () => this.options.onForkSession(message.entryId));
				return;
			case "switchSession":
				await this.runAction(message, () => this.options.onSwitchSession(message.path));
				return;
			case "deleteSession":
				await this.runAction(message, () => this.options.onDeleteSession(message.path));
				return;
			case "renameSession":
				await this.runAction(message, () => this.options.onRenameSession(message.name));
				return;
			case "setModel":
				await this.runAction(message, () => this.options.onSetModel(message.provider, message.modelId));
				return;
			case "setThinking":
				await this.runAction(message, () => this.options.onSetThinking(message.level));
				return;
			case "compact":
				await this.runAction(message, () => this.options.onCompact());
				return;
			case "restart":
				await this.runAction(message, () => this.options.onRestart());
				return;
			case "listSessions":
				await this.options.onListSessions();
				return;
			case "listCommands":
				await this.options.onListCommands();
				return;
			case "listWorkspaceFiles":
				await this.options.onListWorkspaceFiles(message.requestId, message.query);
				return;
			case "resolveMedia":
				await this.options.onResolveMedia(message.requestId, message.sources);
				return;
			case "pickAttachments":
				await this.options.onPickAttachments();
				return;
			case "addResources":
				await this.runAction(message, () => this.options.onAddResources(message.resources));
				return;
			case "pasteImages":
				await this.runAction(message, () => this.options.onPasteImages(message.images));
				return;
			case "removeAttachment":
				await this.options.onRemoveAttachment(message.id);
				return;
			case "removeComposerReference":
				await this.options.onRemoveComposerReference(message.id, message.revision);
				return;
			case "openComposerReference":
				await this.options.onOpenComposerReference(message.id);
				return;
			case "openExternal":
				await this.options.onOpenExternal(message.href);
				return;
			case "openResource":
				await this.options.onOpenResource(message.uri, message.line);
				return;
			case "openWorkspacePath":
				await this.options.onOpenWorkspacePath(message.path, message.line);
				return;
			case "showLogs":
				this.options.onShowLogs();
				return;
			default:
				assertNever(message);
		}
	}

	private runAction(message: ActionMessage, operation: AsyncOperation): Promise<void> {
		return this.options.respondToAction(message.actionId, operation);
	}
}
