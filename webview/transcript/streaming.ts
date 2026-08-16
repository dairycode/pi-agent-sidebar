import type {
	JsonRecord,
	PiContentBlock,
	PiMessage,
} from "../../shared/protocol.js";

function objectValue(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

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
		? message.content.map((block) => ({ ...block }))
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
