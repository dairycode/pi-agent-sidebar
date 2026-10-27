import type { JsonRecord, PiMessage } from "../shared/protocol.js";
import { numberValue, objectValue, stringValue } from "../shared/jsonValues.js";
import { contentText } from "../shared/messageContent.js";
import { StreamingUsageTracker } from "./streamUsage.js";
import { StreamingMessagePlayback } from "./transcript/streaming.js";

export interface RpcEventUiState {
	busy: boolean;
	messages: PiMessage[];
	streamingMessage?: PiMessage;
	streamingIndex: number;
	queue: { steering: string[]; followUp: string[] };
}

export interface RpcEventLiveTool {
	id: string;
	name: string;
	args: JsonRecord;
	status: "running" | "success" | "error";
	result?: unknown;
	startedAt: number;
	revision: number;
}

export interface RpcEventReducerOptions {
	ui: RpcEventUiState;
	liveTools: Map<string, RpcEventLiveTool>;
	toolResults: Map<string, PiMessage>;
	streamingPlayback: StreamingMessagePlayback;
	streamingUsage: StreamingUsageTracker;
	scheduleRender(): void;
	scheduleTranscriptRender(): void;
	scheduleAdvance(): void;
	renderRuntimeMeta(): void;
	settleStreamingMessage(message: PiMessage): void;
	noteUserMessage(text: string): void;
	hasEquivalentTail(message: PiMessage): boolean;
	refreshExpandedTool(toolId: string): void;
	announce(message: string): void;
	showToast(message: string, kind: "info" | "error"): void;
	friendlyToolName(name: string): string;
	setExtensionStatus(key: string, value: string): void;
	clearExtensionStatus(key: string): void;
	setExtensionWidget(key: string, lines: string[]): void;
}

/** Reduces pi RPC events into Webview state and schedules the smallest UI update. */
export class RpcEventReducer {
	public constructor(private readonly options: RpcEventReducerOptions) {}

	public reduce(event: JsonRecord): void {
		const { options } = this;
		let needsImmediateRender = true;
		switch (event.type) {
			case "agent_start":
				options.ui.busy = true;
				options.announce("Pi started working");
				options.streamingUsage.startAgentRun();
				break;
			case "agent_settled":
				options.ui.busy = false;
				options.announce("Pi finished responding");
				break;
			case "message_start":
				needsImmediateRender = this.messageStart(event);
				break;
			case "message_update":
				this.messageUpdate(event);
				needsImmediateRender = false;
				break;
			case "message_end":
				needsImmediateRender = this.messageEnd(event);
				break;
			case "tool_execution_start":
				needsImmediateRender = this.toolStart(event);
				break;
			case "tool_execution_update":
				needsImmediateRender = this.toolUpdate(event);
				break;
			case "tool_execution_end":
				needsImmediateRender = this.toolEnd(event);
				break;
			case "queue_update":
				options.ui.queue = {
					steering: stringArray(event.steering),
					followUp: stringArray(event.followUp),
				};
				break;
			case "compaction_start":
				options.ui.busy = true;
				options.setExtensionStatus("compaction", "Compacting context...");
				break;
			case "compaction_end":
				options.clearExtensionStatus("compaction");
				break;
			case "auto_retry_start":
				options.setExtensionStatus(
					"retry",
					`Retrying (${numberValue(event.attempt)}/${numberValue(event.maxAttempts)})...`,
				);
				break;
			case "auto_retry_end":
				options.clearExtensionStatus("retry");
				break;
			case "extension_error":
				options.showToast(stringValue(event.error) || "A pi extension failed", "error");
				break;
			case "extension_ui_request":
				this.extensionUi(event);
				break;
			default:
				// Unknown public events remain forward-compatible and keep the old render fallback.
				break;
		}
		if (needsImmediateRender) options.scheduleRender();
	}

	private messageStart(event: JsonRecord): boolean {
		const message = asMessage(event.message);
		if (!message) return true;
		if (message.role === "assistant") {
			const overlapping = this.options.streamingPlayback.completeImmediately();
			if (overlapping) this.options.settleStreamingMessage(overlapping);
			this.options.ui.streamingIndex = this.options.ui.messages.length;
			this.options.ui.streamingMessage = this.options.streamingPlayback.start(message);
			this.options.streamingUsage.beginCall();
			this.options.scheduleAdvance();
			return false;
		}
		if (message.role === "user") {
			this.options.noteUserMessage(contentText(message.content));
			if (!this.options.hasEquivalentTail(message)) this.options.ui.messages.push(message);
			return true;
		}
		if (message.role === "custom" && !this.options.hasEquivalentTail(message)) {
			this.options.ui.messages.push(message);
		}
		return true;
	}

	private messageUpdate(event: JsonRecord): void {
		if (this.options.streamingUsage.applyUpdate(event.usage)) {
			this.options.renderRuntimeMeta();
		}
		if (event.assistantMessageEvent !== undefined && this.options.streamingPlayback.isActive) {
			this.options.streamingPlayback.applyDelta(event);
			this.options.scheduleAdvance();
			return;
		}
		const message = asMessage(event.message);
		if (!message) return;
		if (this.options.streamingPlayback.isActive) {
			this.options.streamingPlayback.updateTarget(message);
		} else {
			this.options.ui.streamingIndex = this.options.ui.messages.length;
			this.options.ui.streamingMessage = event.assistantMessageEvent !== undefined
				? this.options.streamingPlayback.resume(message)
				: this.options.streamingPlayback.start(message);
		}
		this.options.scheduleAdvance();
	}

	private messageEnd(event: JsonRecord): boolean {
		const message = asMessage(event.message);
		if (!message) return true;
		if (message.role === "assistant") {
			this.options.ui.streamingIndex = this.options.ui.messages.length;
			this.options.streamingPlayback.finish(message);
			if (this.options.streamingUsage.commitCall(objectValue(event.message).usage, stringValue(objectValue(event.message).stopReason))) {
				this.options.renderRuntimeMeta();
			}
			this.options.scheduleAdvance();
			return false;
		}
		if (message.role === "toolResult" && message.toolCallId) {
			if (!this.options.toolResults.has(message.toolCallId)) this.options.ui.messages.push(message);
			this.options.toolResults.set(message.toolCallId, message);
			if (this.options.streamingUsage.addToolUsage(objectValue(event.message).usage)) this.options.renderRuntimeMeta();
			this.options.scheduleTranscriptRender();
			return false;
		}
		if (message.role === "custom" && !this.options.hasEquivalentTail(message)) this.options.ui.messages.push(message);
		return true;
	}

	private toolStart(event: JsonRecord): boolean {
		const id = stringValue(event.toolCallId);
		if (!id) return true;
		this.options.liveTools.set(id, {
			id,
			name: stringValue(event.toolName) || "tool",
			args: objectValue(event.args),
			status: "running",
			startedAt: Date.now(),
			revision: 0,
		});
		this.options.scheduleTranscriptRender();
		return false;
	}

	private toolUpdate(event: JsonRecord): boolean {
		const id = stringValue(event.toolCallId);
		const tool = this.options.liveTools.get(id);
		if (!tool) return true;
		const hadResult = tool.result !== undefined;
		tool.result = event.partialResult;
		if (!hadResult) {
			tool.revision += 1;
			this.options.scheduleTranscriptRender();
		} else {
			this.options.refreshExpandedTool(id);
		}
		return false;
	}

	private toolEnd(event: JsonRecord): boolean {
		const id = stringValue(event.toolCallId);
		const existing = this.options.liveTools.get(id);
		const args = objectValue(event.args);
		const name = stringValue(event.toolName) || existing?.name || "tool";
		const status = event.isError === true ? "error" : "success";
		this.options.liveTools.set(id, {
			id,
			name,
			args: Object.keys(args).length > 0 ? args : (existing?.args ?? {}),
			status,
			result: event.result,
			startedAt: existing?.startedAt ?? Date.now(),
			revision: (existing?.revision ?? 0) + 1,
		});
		this.options.announce(`${this.options.friendlyToolName(name)} ${status === "error" ? "failed" : "completed"}`);
		this.options.scheduleTranscriptRender();
		return false;
	}

	private extensionUi(event: JsonRecord): void {
		if (stringValue(event.method) !== "setWidget") return;
		const key = stringValue(event.widgetKey);
		if (!key) return;
		const lines = stringArray(event.widgetLines).map(cleanExtensionText).filter(Boolean);
		this.options.setExtensionWidget(key, lines);
	}
}

function asMessage(value: unknown): PiMessage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const message = value as PiMessage;
	return typeof message.role === "string" ? message : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function cleanExtensionText(value: string): string {
	return value
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/\[(?:\d{1,3}(?:;\d{1,3})*)m/gu, "")
		.trim();
}
