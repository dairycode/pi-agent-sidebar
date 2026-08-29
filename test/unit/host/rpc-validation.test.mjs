import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadValidation() {
	return loadBundledModule({
		entry: "src/rpc/rpcValidation.ts",
		name: "validation",
	});
}

test("Pi snapshot validation accepts supported records", async () => {
	const loaded = await loadValidation();
	try {
		assert.equal(
			loaded.module.parsePiState({ sessionId: "session", isStreaming: false })
				.sessionId,
			"session",
		);
		assert.deepEqual(
			loaded.module.parseMessagesResponse({
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
					},
				],
			}),
			[
				{
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
				},
			],
		);
	} finally {
		await loaded.dispose();
	}
});

test("Pi snapshot validation rejects malformed shapes and oversized content", async () => {
	const loaded = await loadValidation();
	try {
		assert.throws(
			() => loaded.module.parsePiState(null),
			/must be an object/iu,
		);
		assert.throws(
			() => loaded.module.parseMessagesResponse({ messages: "not-an-array" }),
			/must be an array/iu,
		);
		assert.throws(
			() =>
				loaded.module.parseMessagesResponse({
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "x".repeat(1_000_001) }],
						},
					],
				}),
			/is too large/iu,
		);
		assert.throws(
			() =>
				loaded.module.validateRpcEvent({
					type: "message_update",
					message: 3,
				}),
			/must be an object/iu,
		);
	} finally {
		await loaded.dispose();
	}
});

test("message_update validates delta events and keeps legacy message shape", async () => {
	const loaded = await loadValidation();
	try {
		// pi >= 0.84 streams deltas without a cumulative message snapshot.
		loaded.module.validateRpcEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "Hello",
			},
		});
		loaded.module.validateRpcEvent({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: {
					type: "toolCall",
					id: "call_1",
					name: "bash",
					arguments: { command: "ls" },
				},
			},
		});
		// No delta payload at all must not fail the stream.
		loaded.module.validateRpcEvent({ type: "message_update" });
		// A malformed delta payload still fails.
		assert.throws(
			() =>
				loaded.module.validateRpcEvent({
					type: "message_update",
					assistantMessageEvent: 3,
				}),
			/must be an object/iu,
		);
		// Older binaries that still send a cumulative message are validated.
		assert.throws(
			() =>
				loaded.module.validateRpcEvent({
					type: "message_update",
					message: { role: 3 },
				}),
			/must be a string/iu,
		);
	} finally {
		await loaded.dispose();
	}
});

test("command validation keeps usable rows and drops unusable ones", async () => {
	const loaded = await loadValidation();
	try {
		const commands = loaded.module.parseCommandsResponse({
			commands: [
				{
					name: "session-name",
					description: "Set or clear session name",
					source: "extension",
					path: "/home/user/.pi/agent/extensions/session.ts",
				},
				{ name: "fix-tests", source: "prompt", location: "project" },
				{ name: "skill:brave-search", source: "skill", location: "user" },
			],
		});
		assert.deepEqual(
			commands.map((command) => command.name),
			["session-name", "fix-tests", "skill:brave-search"],
		);
		assert.equal(commands[0].description, "Set or clear session name");
		assert.equal(commands[1].location, "project");
		assert.equal(commands[1].description, undefined);

		// A source pi adds later must survive: the panel should lose the grouping
		// header, not the row.
		assert.equal(
			loaded.module.parseCommandsResponse({
				commands: [{ name: "future", source: "workflow" }],
			})[0].source,
			"workflow",
		);

		// One malformed entry must not blank the whole list.
		assert.deepEqual(
			loaded.module
				.parseCommandsResponse({
					commands: [
						{ description: "no name at all" },
						{ name: "" },
						{ name: 42 },
						{ name: "x".repeat(513) },
						{ name: "keeper" },
					],
				})
				.map((command) => command.name),
			["keeper"],
		);
	} finally {
		await loaded.dispose();
	}
});

test("session change results separate cancellation from failure fields", async () => {
	const loaded = await loadValidation();
	try {
		const { parseSessionChangeResult } = loaded.module;
		// pi reports extension cancellation as a successful response carrying
		// `data.cancelled`, so the parser must surface it as data, not an error.
		assert.deepEqual(parseSessionChangeResult({ cancelled: true }), {
			cancelled: true,
		});
		assert.deepEqual(parseSessionChangeResult({ cancelled: false }), {
			cancelled: false,
		});
		// `fork` echoes the forked prompt text alongside the cancellation flag.
		assert.deepEqual(
			parseSessionChangeResult({ text: "original prompt", cancelled: true }),
			{ text: "original prompt", cancelled: true },
		);
		// `set_session_name` answers with no data at all.
		assert.deepEqual(parseSessionChangeResult(undefined), {});
		assert.deepEqual(parseSessionChangeResult(null), {});
		assert.throws(
			() => parseSessionChangeResult({ cancelled: "yes" }),
			/must be a boolean/iu,
		);
		assert.throws(
			() => parseSessionChangeResult({ text: 42 }),
			/must be a string/iu,
		);
	} finally {
		await loaded.dispose();
	}
});

test("fork candidates keep opaque entry ids and reject inferred identities", async () => {
	const loaded = await loadValidation();
	try {
		const { parseForkMessagesResponse } = loaded.module;
		// Shape captured from a live `get_fork_messages` probe.
		assert.deepEqual(
			parseForkMessagesResponse({
				messages: [
					{ entryId: "user-one", text: "First prompt" },
					{ entryId: "user-two", text: "Second prompt" },
				],
			}),
			[
				{ entryId: "user-one", text: "First prompt" },
				{ entryId: "user-two", text: "Second prompt" },
			],
		);
		// An empty prompt is legitimate; a missing or blank id is not, because it
		// cannot be used as a fork cursor.
		assert.deepEqual(
			parseForkMessagesResponse({
				messages: [{ entryId: "user-one", text: "" }],
			}),
			[{ entryId: "user-one", text: "" }],
		);
		assert.throws(
			() => parseForkMessagesResponse({ messages: [{ text: "no id" }] }),
			/must be a string/iu,
		);
		assert.throws(
			() =>
				parseForkMessagesResponse({
					messages: [{ entryId: "", text: "blank id" }],
				}),
			/must not be empty/iu,
		);
		assert.throws(
			() =>
				parseForkMessagesResponse({
					messages: [
						{ entryId: "dup", text: "first" },
						{ entryId: "dup", text: "second" },
					],
				}),
			/duplicated/iu,
		);
		assert.throws(
			() =>
				parseForkMessagesResponse({
					messages: [{ entryId: "user-one", text: "x", timestamp: -1 }],
				}),
			/non-negative epoch-millisecond integer/iu,
		);
		assert.throws(
			() => parseForkMessagesResponse({ messages: "nope" }),
			/must be an array/iu,
		);
	} finally {
		await loaded.dispose();
	}
});

test("session entries preserve ids, parent links, and the leaf cursor", async () => {
	const loaded = await loadValidation();
	try {
		const { parseSessionEntriesResponse } = loaded.module;
		const parsed = parseSessionEntriesResponse({
			entries: [
				{
					type: "message",
					id: "user-one",
					parentId: null,
					timestamp: "2026-01-02T03:04:01.000Z",
					message: { role: "user", content: "First prompt" },
				},
				{
					type: "thinking_level_change",
					id: "level-one",
					parentId: "user-one",
					timestamp: "2026-01-02T03:04:02.000Z",
					thinkingLevel: "max",
				},
			],
			leafId: "level-one",
		});
		assert.deepEqual(
			parsed.entries.map((entry) => [entry.id, entry.parentId, entry.type]),
			[
				["user-one", null, "message"],
				["level-one", "user-one", "thinking_level_change"],
			],
		);
		assert.equal(parsed.leafId, "level-one");
		// An empty session reports a null leaf rather than omitting the field.
		assert.deepEqual(
			parseSessionEntriesResponse({ entries: [], leafId: null }),
			{ entries: [], leafId: null },
		);
		assert.throws(
			() =>
				parseSessionEntriesResponse({
					entries: [
						{ type: "message", parentId: null, timestamp: "2026-01-02" },
					],
					leafId: null,
				}),
			/id must be a string/iu,
		);
		assert.throws(
			() =>
				parseSessionEntriesResponse({
					entries: [
						{
							type: "message",
							id: "one",
							parentId: null,
							timestamp: "2026-01-02T03:04:01.000Z",
						},
						{
							type: "message",
							id: "one",
							parentId: null,
							timestamp: "2026-01-02T03:04:02.000Z",
						},
					],
					leafId: "one",
				}),
			/duplicated/iu,
		);
		assert.throws(
			() => parseSessionEntriesResponse({ entries: [], leafId: "" }),
			/must not be empty/iu,
		);
	} finally {
		await loaded.dispose();
	}
});

test("session tree parsing is bounded in depth and node count", async () => {
	const loaded = await loadValidation();
	try {
		const { parseSessionTreeResponse, MAX_SESSION_TREE_DEPTH } = loaded.module;
		const entry = (id, parentId) => ({
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-02T03:04:01.000Z",
		});
		const parsed = parseSessionTreeResponse({
			tree: [
				{
					entry: entry("root", null),
					children: [{ entry: entry("child", "root"), children: [] }],
				},
			],
			leafId: "child",
		});
		assert.equal(parsed.tree[0].entry.id, "root");
		assert.equal(parsed.tree[0].children[0].entry.id, "child");
		assert.equal(parsed.leafId, "child");

		// A pathological chain must fail loudly instead of blowing the stack.
		let deep = { entry: entry("leaf-0", null), children: [] };
		for (let index = 1; index <= MAX_SESSION_TREE_DEPTH + 2; index += 1) {
			deep = { entry: entry(`node-${index}`, null), children: [deep] };
		}
		assert.throws(
			() => parseSessionTreeResponse({ tree: [deep], leafId: "leaf-0" }),
			/depth limit/iu,
		);
		assert.throws(
			() =>
				parseSessionTreeResponse({ tree: [{ children: [] }], leafId: null }),
			/entry must be an object/iu,
		);
	} finally {
		await loaded.dispose();
	}
});

test("state and stats reject nonsense counters but keep null context usage", async () => {
	const loaded = await loadValidation();
	try {
		const { parsePiState, parsePiStats } = loaded.module;
		assert.equal(parsePiState({ messageCount: 4 }).messageCount, 4);
		assert.throws(
			() => parsePiState({ messageCount: -1 }),
			/non-negative integer/iu,
		);
		assert.throws(
			() => parsePiState({ pendingMessageCount: 1.5 }),
			/non-negative integer/iu,
		);
		// pi reports null context usage right after compaction; that must survive so
		// the UI can say "unavailable" instead of showing a fake 0%.
		const stats = parsePiStats({
			userMessages: 5,
			assistantMessages: 5,
			toolResults: 12,
			toolCalls: 12,
			totalMessages: 22,
			cost: 0.45,
			contextUsage: { tokens: null, contextWindow: 200000, percent: null },
		});
		assert.equal(stats.contextUsage.tokens, null);
		assert.equal(stats.contextUsage.percent, null);
		assert.equal(stats.userMessages, 5);
		assert.throws(
			() => parsePiStats({ toolCalls: -3 }),
			/non-negative integer/iu,
		);
	} finally {
		await loaded.dispose();
	}
});

test("message timestamps must be epoch milliseconds", async () => {
	const loaded = await loadValidation();
	try {
		const { parseMessagesResponse } = loaded.module;
		assert.equal(
			parseMessagesResponse({
				messages: [{ role: "user", content: "hi", timestamp: 1767323041000 }],
			})[0].timestamp,
			1767323041000,
		);
		// An ISO string here would be an entry timestamp, not a message timestamp.
		assert.throws(
			() =>
				parseMessagesResponse({
					messages: [{ role: "user", timestamp: "2026-01-02T03:04:01.000Z" }],
				}),
			/epoch-millisecond/iu,
		);
	} finally {
		await loaded.dispose();
	}
});

test("command validation rejects malformed envelopes and oversized fields", async () => {
	const loaded = await loadValidation();
	try {
		assert.throws(
			() => loaded.module.parseCommandsResponse(null),
			/must be an object/iu,
		);
		assert.throws(
			() => loaded.module.parseCommandsResponse({ commands: "nope" }),
			/must be an array/iu,
		);
		assert.throws(
			() =>
				loaded.module.parseCommandsResponse({
					commands: Array.from({ length: 2_001 }, (_value, index) => ({
						name: `command-${index}`,
					})),
				}),
			/exceeds the 2000-item limit/iu,
		);
		assert.throws(
			() =>
				loaded.module.parseCommandsResponse({
					commands: [{ name: "big", description: "x".repeat(8 * 1024 + 1) }],
				}),
			/is too large/iu,
		);
		assert.throws(
			() =>
				loaded.module.parseCommandsResponse({
					commands: [{ name: "bad-source", source: 7 }],
				}),
			/must be a string/iu,
		);
	} finally {
		await loaded.dispose();
	}
});
