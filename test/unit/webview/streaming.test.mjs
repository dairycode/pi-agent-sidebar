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

function visibleText(frame) {
	return frame?.message.content?.[0]?.text ?? "";
}

test("bursty provider text is revealed over multiple frames", async () => {
	const loaded = await loadStreaming();
	try {
		const { StreamingMessagePlayback } = loaded.module;
		const playback = new StreamingMessagePlayback();
		playback.start({ role: "assistant", content: [] });
		playback.applyDelta(
			update({ type: "text_delta", contentIndex: 0, delta: "x".repeat(100) }),
		);

		const first = playback.advance(0);
		const second = playback.advance(1000 / 60);
		assert.ok(visibleText(first).length > 0);
		assert.ok(visibleText(first).length < 100);
		assert.ok(visibleText(second).length > visibleText(first).length);
		assert.equal(playback.needsFrame, true);
	} finally {
		await loaded.dispose();
	}
});

test("large backlogs catch up without making one frame unbounded", async () => {
	const loaded = await loadStreaming();
	try {
		const { StreamingMessagePlayback } = loaded.module;
		const playback = new StreamingMessagePlayback();
		playback.start({ role: "assistant", content: [] });
		playback.applyDelta(
			update({ type: "text_delta", contentIndex: 0, delta: "x".repeat(10_000) }),
		);

		const firstLength = visibleText(playback.advance(0)).length;
		assert.equal(firstLength, 512, "one frame must obey the hard work limit");
		assert.equal(playback.needsFrame, true);
	} finally {
		await loaded.dispose();
	}
});

test("later text frames never serialize completed tool arguments", async () => {
	const loaded = await loadStreaming();
	try {
		const { StreamingMessagePlayback } = loaded.module;
		const playback = new StreamingMessagePlayback();
		const unreadableArguments = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("tool arguments were enumerated");
				},
			},
		);
		const toolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "write",
			arguments: unreadableArguments,
		};
		playback.start({ role: "assistant", content: [] });
		playback.updateTarget({
			role: "assistant",
			content: [toolCall, { type: "text", text: "after tool ".repeat(1000) }],
		});

		assert.doesNotThrow(() => {
			for (let frame = 0; frame < 10; frame += 1) {
				playback.advance(frame * (1000 / 60));
			}
		});
		assert.equal(playback.target.content[0], toolCall);
	} finally {
		await loaded.dispose();
	}
});

test("message_end waits for buffered text before completing", async () => {
	const loaded = await loadStreaming();
	try {
		const { StreamingMessagePlayback } = loaded.module;
		const playback = new StreamingMessagePlayback();
		playback.start({ role: "assistant", content: [] });
		const finalMessage = {
			role: "assistant",
			content: [{ type: "text", text: "final ".repeat(40) }],
			stopReason: "stop",
		};
		playback.finish(finalMessage);

		let frame = playback.advance(0);
		assert.equal(frame.completed, false);
		assert.notEqual(frame.message, finalMessage);
		let timestamp = 1000 / 60;
		while (!frame.completed) {
			frame = playback.advance(timestamp);
			timestamp += 1000 / 60;
		}
		assert.equal(frame.message, finalMessage);
		assert.equal(playback.isActive, false);
	} finally {
		await loaded.dispose();
	}
});

test("a full 10,000-character stream plays out without losing or repeating", async () => {
	const loaded = await loadStreaming();
	try {
		const { StreamingMessagePlayback } = loaded.module;
		const playback = new StreamingMessagePlayback();
		const text = "0123456789".repeat(1000); // exactly 10,000 chars
		playback.start({ role: "assistant", content: [] });

		// Feed the stream in network-sized chunks, mirroring real pi deltas,
		// and let playback run between chunks so a backlog builds up.
		const chunkSize = 1000;
		let received = "";
		let timestamp = 0;
		const frameDuration = 1000 / 60;
		const seenLengths = [];
		for (let offset = 0; offset < text.length; offset += chunkSize) {
			const chunk = text.slice(offset, offset + chunkSize);
			received += chunk;
			playback.applyDelta(
				update({ type: "text_delta", contentIndex: 0, delta: chunk }),
			);
			timestamp += frameDuration;
			const frame = playback.advance(timestamp);
			if (frame) {
				const visible = visibleText(frame);
				assert.ok(
					received.startsWith(visible),
					"displayed text must always be a prefix of the received stream",
				);
				seenLengths.push(visible.length);
			}
		}

		// No frame may have revealed the whole stream yet; the rest must arrive
		// after message_end while the buffer drains.
		assert.ok(seenLengths.at(-1) < text.length);
		assert.equal(playback.isActive, true);

		const finalMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
		};
		playback.finish(finalMessage);

		let completedFrame;
		while (!completedFrame) {
			timestamp += frameDuration;
			const frame = playback.advance(timestamp);
			assert.ok(frame, "playback must stay active until the buffer drains");
			if (frame.completed) completedFrame = frame;
		}

		// The finished frame is the authoritative message, fully revealed.
		assert.equal(completedFrame.message, finalMessage);
		assert.equal(visibleText(completedFrame), text);
		assert.equal(playback.isActive, false);
	} finally {
		await loaded.dispose();
	}
});

test("a frame never exposes half of an emoji surrogate pair", async () => {
	const loaded = await loadStreaming();
	try {
		const { StreamingMessagePlayback } = loaded.module;
		const playback = new StreamingMessagePlayback();
		playback.start({ role: "assistant", content: [] });
		playback.applyDelta(
			update({ type: "text_delta", contentIndex: 0, delta: "😀".repeat(100) }),
		);

		const text = visibleText(playback.advance(0));
		assert.ok(text.length > 0);
		assert.equal([...text].at(-1), "😀");
		assert.doesNotMatch(text, /[\uD800-\uDBFF]$/u);
	} finally {
		await loaded.dispose();
	}
});

test("resume adopts a snapshot message without replaying its prefix", async () => {
	const loaded = await loadStreaming();
	try {
		const { StreamingMessagePlayback } = loaded.module;
		const playback = new StreamingMessagePlayback();
		const snapshotMessage = {
			role: "assistant",
			content: [{ type: "text", text: "delivered prefix" }],
		};

		const resumed = playback.resume(snapshotMessage);
		assert.equal(
			resumed,
			snapshotMessage,
			"the snapshot speaks for what is shown",
		);
		assert.equal(
			playback.needsFrame,
			false,
			"the delivered prefix must not be replayed from an empty shell",
		);

		playback.applyDelta(
			update({ type: "text_delta", contentIndex: 0, delta: " plus tail" }),
		);
		assert.equal(playback.needsFrame, true);
		let timestamp = 1000 / 60;
		let frame;
		while (playback.needsFrame) {
			frame = playback.advance(timestamp);
			timestamp += 1000 / 60;
		}

		assert.equal(
			visibleText(frame),
			"delivered prefix plus tail",
			"deltas continue on top of the snapshot content",
		);
	} finally {
		await loaded.dispose();
	}
});

test("an equal-length provider correction replaces the shown text", async () => {
	const loaded = await loadStreaming();
	try {
		const { StreamingMessagePlayback } = loaded.module;
		const playback = new StreamingMessagePlayback();
		playback.start({ role: "assistant", content: [] });
		playback.applyDelta(
			update({ type: "text_delta", contentIndex: 0, delta: "abc def" }),
		);
		let timestamp = 1000 / 60;
		let frame;
		while (playback.needsFrame) {
			frame = playback.advance(timestamp);
			timestamp += 1000 / 60;
		}
		assert.equal(visibleText(frame), "abc def");

		// A provider rewrite of the middle without changing length or edges is
		// exactly the frame the DOM patcher must not trust a cheap fingerprint for.
		playback.updateTarget({
			role: "assistant",
			content: [{ type: "text", text: "abc xef" }],
		});
		timestamp += 1000 / 60;
		while (playback.needsFrame) {
			frame = playback.advance(timestamp);
			timestamp += 1000 / 60;
		}
		assert.equal(visibleText(frame), "abc xef");
		assert.equal(playback.needsFrame, false);
	} finally {
		await loaded.dispose();
	}
});
