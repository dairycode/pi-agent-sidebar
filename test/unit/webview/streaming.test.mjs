import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";


async function loadStreaming() {
	return loadBundledModule({
		entry: "webview/transcript/streaming.ts",
		name: "streaming",
	});
}

const update = (assistantMessageEvent) => ({
	type: "message_update",
	assistantMessageEvent,
});

test("text deltas assemble into a single content block", async () => {
	const loaded = await loadStreaming();
	try {
		const { applyAssistantMessageDelta } = loaded.module;
		let message = { role: "assistant", content: [] };
		for (const event of [
			update({ type: "text_start", contentIndex: 0 }),
			update({ type: "text_delta", contentIndex: 0, delta: "Hello" }),
			update({ type: "text_delta", contentIndex: 0, delta: " world" }),
		]) {
			message = applyAssistantMessageDelta(message, event);
		}
		assert.deepEqual(message.content, [{ type: "text", text: "Hello world" }]);
		// text_end carries the authoritative full text.
		message = applyAssistantMessageDelta(
			message,
			update({ type: "text_end", contentIndex: 0, content: "Hello world!" }),
		);
		assert.deepEqual(message.content, [{ type: "text", text: "Hello world!" }]);
	} finally {
		await loaded.dispose();
	}
});

test("thinking then toolcall deltas assemble with distinct contentIndexes", async () => {
	const loaded = await loadStreaming();
	try {
		const { applyAssistantMessageDelta } = loaded.module;
		let message = { role: "assistant", content: [] };
		// Mirrors a real pi stream: thinking at index 0, tool call at index 1.
		const events = [
			update({ type: "thinking_start", contentIndex: 0 }),
			update({ type: "thinking_delta", contentIndex: 0, delta: "The " }),
			update({ type: "thinking_delta", contentIndex: 0, delta: "user wants" }),
			update({ type: "toolcall_start", contentIndex: 1 }),
			update({ type: "toolcall_delta", contentIndex: 1, delta: '{"command":' }),
			update({ type: "toolcall_delta", contentIndex: 1, delta: '"echo hi"}' }),
			update({
				type: "thinking_end",
				contentIndex: 0,
				content: "The user wants a simple bash command.",
			}),
			update({
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					type: "toolCall",
					id: "call_1",
					name: "bash",
					arguments: { command: "echo hi" },
				},
			}),
		];
		for (const event of events)
			message = applyAssistantMessageDelta(message, event);
		assert.deepEqual(message.content, [
			{ type: "thinking", thinking: "The user wants a simple bash command." },
			{
				type: "toolCall",
				id: "call_1",
				name: "bash",
				arguments: { command: "echo hi" },
			},
		]);
	} finally {
		await loaded.dispose();
	}
});

test("unknown deltas return the message untouched", async () => {
	const loaded = await loadStreaming();
	try {
		const { applyAssistantMessageDelta } = loaded.module;
		const message = { role: "assistant", content: [] };
		assert.equal(
			applyAssistantMessageDelta(message, update({ type: "mystery" })),
			message,
		);
	} finally {
		await loaded.dispose();
	}
});

test("string content messages are normalized to blocks", async () => {
	const loaded = await loadStreaming();
	try {
		const { applyAssistantMessageDelta } = loaded.module;
		let message = applyAssistantMessageDelta(
			{ role: "assistant", content: "prefix" },
			update({ type: "text_start", contentIndex: 0 }),
		);
		message = applyAssistantMessageDelta(
			message,
			update({ type: "text_delta", contentIndex: 0, delta: "suffix" }),
		);
		assert.deepEqual(message.content, [{ type: "text", text: "suffix" }]);
	} finally {
		await loaded.dispose();
	}
});
