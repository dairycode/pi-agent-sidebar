import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadProtocol() {
	return loadBundledModule({
		entry: "shared/protocol.ts",
		name: "protocol",
	});
}

test("webview submit messages require bounded host identities and marker spans", async () => {
	const loaded = await loadProtocol();
	try {
		const valid = loaded.module.parseWebviewMessage({
			type: "submit",
			actionId: "action",
			text: "@src/file.ts#1 inspect",
			attachmentIds: ["attachment"],
			attachments: [{ path: "/forged/path", kind: "image" }],
			references: [{ id: "reference", revision: 2, start: 0, end: 14 }],
		});
		assert.deepEqual(valid, {
			type: "submit",
			actionId: "action",
			text: "@src/file.ts#1 inspect",
			attachmentIds: ["attachment"],
			references: [{ id: "reference", revision: 2, start: 0, end: 14 }],
		});
		assert.equal(
			loaded.module.parseWebviewMessage({
				type: "submit",
				actionId: "action",
				text: "prompt",
				attachmentIds: Array.from({ length: 21 }, (_, index) => String(index)),
				references: [],
			}),
			undefined,
		);
		assert.equal(
			loaded.module.parseWebviewMessage({
				type: "submit",
				actionId: "action",
				text: "prompt",
				attachmentIds: [],
				references: [{ id: "reference", revision: 0, start: 4, end: 4 }],
			}),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});

test("webview submit delivery is bounded to pi's streamingBehavior modes", async () => {
	const loaded = await loadProtocol();
	try {
		const base = {
			type: "submit",
			actionId: "action",
			text: "nudge",
			attachmentIds: [],
			references: [],
		};
		for (const delivery of ["steer", "followUp"]) {
			const parsed = loaded.module.parseWebviewMessage({
				...base,
				delivery,
			});
			assert.equal(parsed.delivery, delivery);
		}
		for (const delivery of ["queue-everything", "auto", "", 1, null]) {
			assert.equal(
				loaded.module.parseWebviewMessage({ ...base, delivery }).delivery,
				undefined,
			);
		}
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				...base,
				delivery: undefined,
			}),
			{
				type: "submit",
				actionId: "action",
				text: "nudge",
				attachmentIds: [],
				references: [],
			},
		);
	} finally {
		await loaded.dispose();
	}
});

test("webview protocol rejects malformed action payloads", async () => {
	const loaded = await loadProtocol();
	try {
		assert.equal(
			loaded.module.parseWebviewMessage({ type: "removeAttachment", id: "" }),
			undefined,
		);
		assert.equal(
			loaded.module.parseWebviewMessage({
				type: "pasteImages",
				actionId: "action",
				images: [
					{
						name: "huge.png",
						mimeType: "image/png",
						data: "a".repeat(16 * 1024 * 1024 + 17),
					},
				],
			}),
			undefined,
		);
		assert.equal(
			loaded.module.parseWebviewMessage({ type: "openExternal", href: 42 }),
			undefined,
		);
		assert.equal(
			loaded.module.parseWebviewMessage({ type: "openResource", uri: "" }),
			undefined,
		);
		assert.equal(
			loaded.module.parseWebviewMessage({
				type: "addResources",
				actionId: "action",
				resources: [],
			}),
			undefined,
		);
		assert.equal(
			loaded.module.parseWebviewMessage({
				type: "addResources",
				actionId: "action",
				resources: Array.from({ length: 11 }, (_, index) => `file-${index}`),
			}),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});

test("webview protocol accepts bounded dropped resources", async () => {
	const loaded = await loadProtocol();
	try {
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "addResources",
				actionId: "action",
				resources: ["file:///workspace/src/main.ts", "/workspace/src/view.ts"],
			}),
			{
				type: "addResources",
				actionId: "action",
				resources: ["file:///workspace/src/main.ts", "/workspace/src/view.ts"],
			},
		);
	} finally {
		await loaded.dispose();
	}
});

test("webview protocol accepts canonical resource navigation", async () => {
	const loaded = await loadProtocol();
	try {
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "openResource",
				uri: "vscode-remote://ssh-remote+host/workspace/src/main.ts",
				line: 9,
			}),
			{
				type: "openResource",
				uri: "vscode-remote://ssh-remote+host/workspace/src/main.ts",
				line: 9,
			},
		);
	} finally {
		await loaded.dispose();
	}
});

test("webview protocol accepts bounded renameSession payloads", async () => {
	const loaded = await loadProtocol();
	try {
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "renameSession",
				actionId: "action",
				name: "My feature work",
			}),
			{ type: "renameSession", actionId: "action", name: "My feature work" },
		);
		assert.equal(
			loaded.module.parseWebviewMessage({
				type: "renameSession",
				actionId: "action",
				name: "",
			}),
			undefined,
		);
		assert.equal(
			loaded.module.parseWebviewMessage({
				type: "renameSession",
				actionId: "action",
				name: "x".repeat(201),
			}),
			undefined,
		);
		assert.equal(
			loaded.module.parseWebviewMessage({
				type: "renameSession",
				actionId: "action",
				name: 42,
			}),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});

test("workspace file mention queries require a bounded query and request id", async () => {
	const loaded = await loadProtocol();
	try {
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "listWorkspaceFiles",
				requestId: 3,
				query: "src/main",
			}),
			{ type: "listWorkspaceFiles", requestId: 3, query: "src/main" },
		);
		// A bare `@` is an empty query, and it must list files rather than be dropped.
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "listWorkspaceFiles",
				requestId: 0,
				query: "",
			}),
			{ type: "listWorkspaceFiles", requestId: 0, query: "" },
		);
		for (const invalid of [
			{ requestId: -1, query: "src" },
			{ requestId: 1.5, query: "src" },
			{ query: "src" },
			{ requestId: 1, query: "x".repeat(513) },
			{ requestId: 1, query: 42 },
		]) {
			assert.equal(
				loaded.module.parseWebviewMessage({
					type: "listWorkspaceFiles",
					...invalid,
				}),
				undefined,
			);
		}
	} finally {
		await loaded.dispose();
	}
});

test("media requests carry a bounded batch of sources and a request id", async () => {
	const loaded = await loadProtocol();
	try {
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "resolveMedia",
				requestId: 2,
				sources: ["/tmp/a.png", "docs/b.png"],
			}),
			{
				type: "resolveMedia",
				requestId: 2,
				sources: ["/tmp/a.png", "docs/b.png"],
			},
		);
		const ceiling = loaded.module.MAX_RESOLVE_MEDIA_SOURCES;
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "resolveMedia",
				requestId: 0,
				sources: Array.from({ length: ceiling }, (_, index) => `/tmp/${index}.png`),
			})?.sources.length,
			ceiling,
		);
		for (const invalid of [
			{ sources: ["/tmp/a.png"] },
			{ requestId: 2 },
			{ requestId: 2, sources: [] },
			{ requestId: 2, sources: "/tmp/a.png" },
			{ requestId: 2, sources: [""] },
			{ requestId: 2, sources: [42] },
			{
				requestId: 2,
				sources: Array.from(
					{ length: ceiling + 1 },
					(_, index) => `/tmp/${index}.png`,
				),
			},
			{ requestId: 2, sources: ["x".repeat(32 * 1024 + 1)] },
		]) {
			assert.equal(
				loaded.module.parseWebviewMessage({ type: "resolveMedia", ...invalid }),
				undefined,
			);
		}
	} finally {
		await loaded.dispose();
	}
});

test("webview protocol accepts argument-free requests", async () => {
	const loaded = await loadProtocol();
	try {
		for (const type of [
			"ready",
			"listSessions",
			"listCommands",
			"pickAttachments",
			"showLogs",
		]) {
			assert.deepEqual(loaded.module.parseWebviewMessage({ type }), { type });
		}
		assert.equal(
			loaded.module.parseWebviewMessage({ type: "listCommandz" }),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});

test("fork requests carry an action id and an opaque entry id", async () => {
	const loaded = await loadProtocol();
	try {
		// The candidate list is a plain action: the reply arrives as its own message,
		// but a failure has to land on this request so it can be explained.
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "listForkCandidates",
				actionId: "action",
			}),
			{ type: "listForkCandidates", actionId: "action" },
		);
		assert.equal(
			loaded.module.parseWebviewMessage({ type: "listForkCandidates" }),
			undefined,
		);

		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "forkSession",
				actionId: "action",
				entryId: "entry-7",
			}),
			{ type: "forkSession", actionId: "action", entryId: "entry-7" },
		);

		// The entry id is the whole decision, so a fork with no usable cursor must
		// not reach the host: it would be rejected there as a stale-branch error and
		// read as a bug rather than a dropped message.
		for (const entryId of ["", undefined, 7, null, "e".repeat(513)]) {
			assert.equal(
				loaded.module.parseWebviewMessage({
					type: "forkSession",
					actionId: "action",
					entryId,
				}),
				undefined,
			);
		}
		assert.equal(
			loaded.module.parseWebviewMessage({
				type: "forkSession",
				entryId: "entry-7",
			}),
			undefined,
		);

		// An entry id at the ceiling is still accepted: the bound exists to stop an
		// unbounded string, not to reject a long opaque id pi actually issued.
		const maxLength = "e".repeat(512);
		assert.deepEqual(
			loaded.module.parseWebviewMessage({
				type: "forkSession",
				actionId: "action",
				entryId: maxLength,
			}),
			{ type: "forkSession", actionId: "action", entryId: maxLength },
		);
	} finally {
		await loaded.dispose();
	}
});

/**
 * Valid values for every field the parser reads, so a per-type case only has to
 * name the fields it needs. A field used by two types with different meanings
 * (`path` is a session path for `switchSession` and a workspace path for
 * `openWorkspacePath`) carries a value that satisfies the parser for both: the
 * parser validates shape, not meaning.
 */
const SAMPLE_FIELDS = {
	actionId: "action-1",
	requestId: 1,
	id: "reference-1",
	revision: 2,
	name: "Session name",
	level: "high",
	provider: "anthropic",
	modelId: "claude-sonnet-4-5",
	entryId: "entry-1",
	path: "/workspace/src/app.ts",
	uri: "file:///workspace/src/app.ts",
	href: "https://example.com/docs",
	query: "src",
	sources: ["/workspace/diagram.png"],
	resources: ["/workspace/notes.md"],
	images: [{ name: "pasted.png", mimeType: "image/png", data: "aGVsbG8=" }],
	text: "hello",
	attachmentIds: [],
	references: [{ id: "reference-1", revision: 1, start: 0, end: 5 }],
};

/**
 * The fields each message type requires.
 *
 * This table is half of the maintenance contract the protocol declares:
 * `WEBVIEW_REQUEST_TYPES` names the types and the compiler enforces that the
 * union names no others, while this table says what a valid message of each
 * type carries. The test below walks both and compares them, so a new variant
 * cannot be added to the protocol, or dropped from the parser, without a
 * failure here — which is exactly what used to go unnoticed: a message type the
 * parser no longer accepted only produced one line in the output channel.
 */
const VALID_PAYLOADS = {
	ready: [],
	composerFocused: ["requestId"],
	submit: ["actionId", "text", "attachmentIds", "references"],
	abort: ["actionId"],
	newSession: ["actionId"],
	cloneSession: ["actionId"],
	listForkCandidates: ["actionId"],
	forkSession: ["actionId", "entryId"],
	switchSession: ["actionId", "path"],
	deleteSession: ["actionId", "path"],
	renameSession: ["actionId", "name"],
	setModel: ["actionId", "provider", "modelId"],
	setThinking: ["actionId", "level"],
	compact: ["actionId"],
	restart: ["actionId"],
	listSessions: [],
	listCommands: [],
	listWorkspaceFiles: ["requestId", "query"],
	resolveMedia: ["requestId", "sources"],
	pickAttachments: [],
	addResources: ["actionId", "resources"],
	pasteImages: ["actionId", "images"],
	removeAttachment: ["id"],
	removeComposerReference: ["id", "revision"],
	openComposerReference: ["id"],
	openExternal: ["href"],
	openResource: ["uri"],
	openWorkspacePath: ["path"],
	showLogs: [],
};

test("the parser accepts every message type the protocol declares", async () => {
	const loaded = await loadProtocol();
	try {
		const { WEBVIEW_REQUEST_TYPES, parseWebviewMessage } = loaded.module;

		// Compared in both directions, so neither list can drift: a type present in
		// one and missing from the other fails here rather than becoming a message
		// the host quietly ignores.
		assert.deepEqual(
			Object.keys(VALID_PAYLOADS).sort(),
			[...WEBVIEW_REQUEST_TYPES].sort(),
		);

		for (const type of WEBVIEW_REQUEST_TYPES) {
			const payload = Object.fromEntries(
				VALID_PAYLOADS[type].map((field) => [field, SAMPLE_FIELDS[field]]),
			);
			const parsed = parseWebviewMessage({ type, ...payload });
			assert.ok(parsed, `parseWebviewMessage must accept a valid ${type}`);
			assert.equal(parsed.type, type);
		}
	} finally {
		await loaded.dispose();
	}
});

test("the parser rejects an unknown message type", async () => {
	const loaded = await loadProtocol();
	try {
		assert.equal(
			loaded.module.parseWebviewMessage({ type: "notARealMessage" }),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});
