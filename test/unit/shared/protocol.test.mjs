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
