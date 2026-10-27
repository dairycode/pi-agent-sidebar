import { assertNever } from "../shared/assertNever.js";
import type { HostToWebviewMessage } from "../shared/protocol.js";

export interface HostMessageHandlerOptions {
	onBootstrap(message: Extract<HostToWebviewMessage, { type: "bootstrap" }>): void;
	onSnapshot(message: Extract<HostToWebviewMessage, { type: "snapshot" }>): void;
	onRpcEvent(event: Extract<HostToWebviewMessage, { type: "rpcEvent" }>['event']): void;
	onActionResult(message: Extract<HostToWebviewMessage, { type: "actionResult" }>): void;
	onSessionList(message: Extract<HostToWebviewMessage, { type: "sessionList" }>): void;
	onForkCandidates(message: Extract<HostToWebviewMessage, { type: "forkCandidates" }>): void;
	onCapabilities(message: Extract<HostToWebviewMessage, { type: "capabilities" }>): void;
	onCommandList(message: Extract<HostToWebviewMessage, { type: "commandList" }>): void;
	onWorkspaceFileList(message: Extract<HostToWebviewMessage, { type: "workspaceFileList" }>): void;
	onMediaResolved(message: Extract<HostToWebviewMessage, { type: "mediaResolved" }>): void;
	onAttachments(message: Extract<HostToWebviewMessage, { type: "attachments" }>): void;
	onComposerReferences(message: Extract<HostToWebviewMessage, { type: "composerReferences" }>): void;
	onNotice(message: Extract<HostToWebviewMessage, { type: "notice" }>): void;
	onConnection(message: Extract<HostToWebviewMessage, { type: "connection" }>): void;
	onSetComposerText(text: string): void;
}

/** Dispatches validated Host messages without knowing the Webview's state model. */
export class HostMessageHandler {
	public constructor(private readonly options: HostMessageHandlerOptions) {}

	public handle(message: HostToWebviewMessage): void {
		switch (message.type) {
			case "bootstrap":
				this.options.onBootstrap(message);
				return;
			case "snapshot":
				this.options.onSnapshot(message);
				return;
			case "rpcEvent":
				this.options.onRpcEvent(message.event);
				return;
			case "actionResult":
				this.options.onActionResult(message);
				return;
			case "sessionList":
				this.options.onSessionList(message);
				return;
			case "forkCandidates":
				this.options.onForkCandidates(message);
				return;
			case "capabilities":
				this.options.onCapabilities(message);
				return;
			case "commandList":
				this.options.onCommandList(message);
				return;
			case "workspaceFileList":
				this.options.onWorkspaceFileList(message);
				return;
			case "mediaResolved":
				this.options.onMediaResolved(message);
				return;
			case "attachments":
				this.options.onAttachments(message);
				return;
			case "composerReferences":
				this.options.onComposerReferences(message);
				return;
			case "notice":
				this.options.onNotice(message);
				return;
			case "connection":
				this.options.onConnection(message);
				return;
			case "setComposerText":
				this.options.onSetComposerText(message.text);
				return;
			default:
				assertNever(message);
		}
	}
}
