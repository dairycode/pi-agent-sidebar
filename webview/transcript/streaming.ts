import type {
	JsonRecord,
	PiContentBlock,
	PiMessage,
} from "../../shared/protocol.js";
import {
	numberValue,
	objectValue,
	stringValue,
} from "../../shared/jsonValues.js";

/**
 * Applies a `message_update` delta (`assistantMessageEvent`) to the in-flight
 * assistant message. pi streams text/thinking/toolcall chunks with a
 * `contentIndex`; the client assembles the partial message so the panel can
 * render it live. `message_end.message` remains the authoritative copy and
 * replaces this partial when the message completes.
 *
 * Returns the original message (shared reference) when the delta is unknown,
 * so callers can cheaply skip re-rendering.
 */
export function applyAssistantMessageDelta(
	message: PiMessage,
	event: JsonRecord,
): PiMessage {
	const delta = objectValue(event.assistantMessageEvent);
	const deltaType = stringValue(delta.type);
	const contentIndex = numberValue(delta.contentIndex);
	const blocks: PiContentBlock[] = Array.isArray(message.content)
		? [...message.content]
		: [];
	while (blocks.length <= contentIndex) {
		blocks.push({ type: "text", text: "" });
	}
	const block = blocks[contentIndex];
	if (!block) return message;

	let replacement: PiContentBlock | undefined;
	switch (deltaType) {
		case "text_start":
			replacement = { type: "text", text: "" };
			break;
		case "text_delta":
			replacement = {
				type: "text",
				text:
					(block.type === "text" ? (block.text ?? "") : "") +
					stringValue(delta.delta),
			};
			break;
		case "text_end":
			replacement = {
				type: "text",
				text:
					stringValue(delta.content) ||
					(block.type === "text" ? (block.text ?? "") : ""),
			};
			break;
		case "thinking_start":
			replacement = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			replacement = {
				type: "thinking",
				thinking:
					(block.type === "thinking" ? (block.thinking ?? "") : "") +
					stringValue(delta.delta),
			};
			break;
		case "thinking_end":
			replacement = {
				type: "thinking",
				thinking:
					stringValue(delta.content) ||
					(block.type === "thinking" ? (block.thinking ?? "") : ""),
			};
			break;
		case "toolcall_start":
			replacement = { type: "toolCall", id: "", name: "", arguments: {} };
			break;
		case "toolcall_delta":
			// Arguments stream as JSON string chunks; the completed object
			// arrives with toolcall_end, so chunks need no buffering here.
			replacement = { type: "toolCall" };
			break;
		case "toolcall_end": {
			const toolCall = objectValue(delta.toolCall);
			replacement = {
				type: "toolCall",
				id: stringValue(toolCall.id),
				name: stringValue(toolCall.name),
				arguments: objectValue(toolCall.arguments),
			};
			break;
		}
		default:
			return message;
	}
	blocks[contentIndex] = replacement;
	return { ...message, content: blocks };
}

export interface StreamingPlaybackFrame {
	message: PiMessage;
	completed: boolean;
}

const DEFAULT_FRAME_DURATION_MS = 1000 / 60;
const MAX_FRAME_DURATION_MS = 50;
const TARGET_BUFFER_LATENCY_MS = 80;
const MAX_CHARACTERS_PER_FRAME = 512;

/**
 * Decouples pi's network-sized deltas from the text shown in the webview.
 *
 * The target message always receives deltas immediately. The displayed message
 * approaches that target over several animation frames, so bursty providers do
 * not turn into bursty paints. This class knows nothing about scroll position:
 * reading older content can stop viewport following without pausing playback.
 */
export class StreamingMessagePlayback {
	private targetMessage: PiMessage | undefined;
	private displayedMessage: PiMessage | undefined;
	private finalMessage: PiMessage | undefined;
	private previousFrameTime: number | undefined;

	public get isActive(): boolean {
		return this.targetMessage !== undefined;
	}

	public get target(): PiMessage | undefined {
		return this.targetMessage;
	}

	public get isFinishing(): boolean {
		return this.finalMessage !== undefined;
	}

	public get needsFrame(): boolean {
		return Boolean(
			this.targetMessage &&
				(this.finalMessage ||
					!contentMatches(this.displayedMessage, this.targetMessage)),
		);
	}

	public start(message: PiMessage): PiMessage {
		this.targetMessage = message;
		this.finalMessage = undefined;
		this.previousFrameTime = undefined;
		this.displayedMessage = { ...message, content: [] };
		return this.displayedMessage;
	}

	/**
	 * Resumes playback from an authoritative snapshot without replaying content.
	 *
	 * A snapshot can arrive while pi is still streaming (connection recovery,
	 * state refresh). Its final assistant message already holds the delivered
	 * prefix, so it becomes both target and displayed message: later
	 * message_update deltas apply on top of it instead of restarting from an
	 * empty shell and re-revealing text the reader has already seen.
	 */
	public resume(message: PiMessage): PiMessage {
		this.targetMessage = message;
		this.finalMessage = undefined;
		this.previousFrameTime = undefined;
		this.displayedMessage = message;
		return this.displayedMessage;
	}

	public updateTarget(message: PiMessage): void {
		if (!this.targetMessage) {
			this.start(message);
			return;
		}
		this.targetMessage = message;
		// Legacy pi builds send cumulative snapshots, which may revise an earlier
		// prefix rather than append. Modern delta streams avoid this O(n) check.
		this.reconcileDisplayedPrefix();
	}

	public applyDelta(event: JsonRecord): void {
		if (!this.targetMessage) return;
		this.targetMessage = applyAssistantMessageDelta(this.targetMessage, event);
		const deltaType = stringValue(objectValue(event.assistantMessageEvent).type);
		if (deltaType.endsWith("_end")) this.reconcileDisplayedPrefix();
	}

	/** Keeps the authoritative message hidden until its buffered text is visible. */
	public finish(message: PiMessage): void {
		if (!this.targetMessage) this.start(message);
		this.targetMessage = message;
		this.finalMessage = message;
		this.reconcileDisplayedPrefix();
	}

	/** Completes an overlap/session transition without losing received content. */
	public completeImmediately(): PiMessage | undefined {
		const completed = this.finalMessage ?? this.targetMessage;
		this.reset();
		return completed;
	}

	public reset(): void {
		this.targetMessage = undefined;
		this.displayedMessage = undefined;
		this.finalMessage = undefined;
		this.previousFrameTime = undefined;
	}

	public advance(timestamp: number): StreamingPlaybackFrame | undefined {
		const target = this.targetMessage;
		const displayed = this.displayedMessage;
		if (!target || !displayed || !this.needsFrame) return undefined;

		const frameDuration = Math.min(
			this.previousFrameTime === undefined
				? DEFAULT_FRAME_DURATION_MS
				: Math.max(0, timestamp - this.previousFrameTime),
			MAX_FRAME_DURATION_MS,
		);
		this.previousFrameTime = timestamp;
		const bufferedCharacters = pendingCharacterCount(displayed, target);
		const characterBudget =
			bufferedCharacters === 0
				? 0
				: Math.max(
						1,
						Math.min(
							MAX_CHARACTERS_PER_FRAME,
							Math.ceil(
								(bufferedCharacters * frameDuration) / TARGET_BUFFER_LATENCY_MS,
							),
						),
					);
		const next = revealMessage(displayed, target, characterBudget);
		this.displayedMessage = next;

		if (contentMatches(next, target)) {
			this.previousFrameTime = undefined;
			if (this.finalMessage) {
				const completed = this.finalMessage;
				this.reset();
				return { message: completed, completed: true };
			}
		}
		return { message: next, completed: false };
	}

	/**
	 * End events can correct provider text instead of merely extending it. This
	 * one-time scan rewinds the displayed model to the common prefix; the DOM
	 * patcher then performs one replacement and resumes append-only updates.
	 */
	private reconcileDisplayedPrefix(): void {
		if (!this.displayedMessage || !this.targetMessage) return;
		this.displayedMessage = commonPrefixMessage(
			this.displayedMessage,
			this.targetMessage,
		);
	}
}

function contentBlocks(message: PiMessage | undefined): PiContentBlock[] {
	if (!message) return [];
	if (Array.isArray(message.content)) return message.content;
	if (typeof message.content === "string") {
		return [{ type: "text", text: message.content }];
	}
	return [];
}

function blockText(block: PiContentBlock): string | undefined {
	if (block.type === "text") return block.text ?? "";
	if (block.type === "thinking") return block.thinking ?? "";
	return undefined;
}

function pendingCharacterCount(
	displayed: PiMessage,
	target: PiMessage,
): number {
	const displayedBlocks = contentBlocks(displayed);
	return contentBlocks(target).reduce((total, targetBlock, index) => {
		const targetText = blockText(targetBlock);
		if (targetText === undefined) return total;
		const displayedBlock = displayedBlocks[index];
		const displayedText =
			displayedBlock?.type === targetBlock.type
				? (blockText(displayedBlock) ?? "")
				: "";
		return total + Math.max(0, targetText.length - displayedText.length);
	}, 0);
}

function contentMatches(
	displayed: PiMessage | undefined,
	target: PiMessage,
): boolean {
	const displayedBlocks = contentBlocks(displayed);
	const targetBlocks = contentBlocks(target);
	if (displayedBlocks.length !== targetBlocks.length) return false;
	return targetBlocks.every((targetBlock, index) => {
		const displayedBlock = displayedBlocks[index];
		if (displayedBlock === targetBlock) return true;
		if (!displayedBlock || displayedBlock.type !== targetBlock.type) return false;
		const targetText = blockText(targetBlock);
		if (targetText !== undefined) return blockText(displayedBlock) === targetText;
		// Non-text blocks are revealed atomically and retained by identity. Comparing
		// serialized tool arguments here made every later character frame O(size of
		// the tool input), which is especially expensive for write/edit/bash calls.
		return false;
	});
}

function revealMessage(
	displayed: PiMessage,
	target: PiMessage,
	characterBudget: number,
): PiMessage {
	const displayedBlocks = contentBlocks(displayed);
	let remainingBudget = characterBudget;
	const nextBlocks = contentBlocks(target).map((targetBlock, index) => {
		const targetText = blockText(targetBlock);
		if (targetText === undefined) return targetBlock;
		const displayedBlock = displayedBlocks[index];
		const displayedText =
			displayedBlock?.type === targetBlock.type
				? (blockText(displayedBlock) ?? "")
				: "";
		if (displayedBlock && displayedText === targetText) return displayedBlock;
		let nextText = displayedText;
		if (targetText.length <= displayedText.length) {
			// End events may correct earlier provider text. Equal/shorter content is
			// applied atomically; the append-only hot path below never scans the prefix.
			nextText = targetText;
		} else if (remainingBudget > 0) {
			const end = safeSliceEnd(targetText, displayedText.length, remainingBudget);
			nextText = targetText.slice(0, end);
			remainingBudget -= end - displayedText.length;
		}
		if (nextText === targetText) return targetBlock;
		return targetBlock.type === "thinking"
			? { ...targetBlock, thinking: nextText }
			: { ...targetBlock, text: nextText };
	});
	return { ...target, content: nextBlocks };
}

function commonPrefixMessage(
	displayed: PiMessage,
	target: PiMessage,
): PiMessage {
	const displayedBlocks = contentBlocks(displayed);
	const nextBlocks = contentBlocks(target).map((targetBlock, index) => {
		const targetText = blockText(targetBlock);
		if (targetText === undefined) return targetBlock;
		const displayedBlock = displayedBlocks[index];
		const displayedText =
			displayedBlock?.type === targetBlock.type
				? (blockText(displayedBlock) ?? "")
				: "";
		if (targetText.startsWith(displayedText)) {
			return targetBlock.type === "thinking"
				? { ...targetBlock, thinking: displayedText }
				: { ...targetBlock, text: displayedText };
		}
		let prefixLength = 0;
		const maxPrefixLength = Math.min(displayedText.length, targetText.length);
		while (
			prefixLength < maxPrefixLength &&
			displayedText.charCodeAt(prefixLength) ===
				targetText.charCodeAt(prefixLength)
		) {
			prefixLength += 1;
		}
		const prefix = targetText.slice(0, prefixLength);
		return targetBlock.type === "thinking"
			? { ...targetBlock, thinking: prefix }
			: { ...targetBlock, text: prefix };
	});
	return { ...target, content: nextBlocks };
}

/** Avoids painting half of a UTF-16 surrogate pair for one frame. */
function safeSliceEnd(text: string, start: number, budget: number): number {
	let end = Math.min(text.length, start + budget);
	if (
		end < text.length &&
		end > start &&
		text.charCodeAt(end - 1) >= 0xd800 &&
		text.charCodeAt(end - 1) <= 0xdbff
	) {
		end += 1;
	}
	return end;
}
