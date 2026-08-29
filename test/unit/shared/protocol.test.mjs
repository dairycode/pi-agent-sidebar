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
