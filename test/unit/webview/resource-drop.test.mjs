import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadResourceDrop() {
	return loadBundledModule({
		entry: "webview/resourceDrop.ts",
		name: "resource-drop",
		platform: "browser",
	});
}

function dataTransfer(values) {
	const entries = new Map(
		Object.entries(values).map(([type, value]) => [type.toLowerCase(), value]),
	);
	return {
		types: [...entries.keys()],
		getData: (type) => entries.get(type.toLowerCase()) ?? "",
	};
}

test("VS Code resource drags are detected and deduplicated", async () => {
	const loaded = await loadResourceDrop();
	try {
		const transfer = dataTransfer({
			ResourceURLs: JSON.stringify([
				"file:///workspace/src/main.ts",
				"file:///workspace/src/main.ts",
				"file:///workspace/src/view.ts",
				"file:///workspace/src/components",
			]),
		});
		assert.equal(loaded.module.containsDroppedResources(transfer), true);
		assert.deepEqual(loaded.module.extractDroppedResources(transfer), [
			"file:///workspace/src/main.ts",
			"file:///workspace/src/view.ts",
			"file:///workspace/src/components",
		]);
	} finally {
		await loaded.dispose();
	}
});

test("malformed private data falls back to a standard URI list", async () => {
	const loaded = await loadResourceDrop();
	try {
		const transfer = dataTransfer({
			ResourceURLs: "not-json",
			"text/uri-list": [
				"# VS Code resource drag",
				"file:///workspace/src/main.ts",
				"",
				"file:///workspace/src/view.ts",
			].join("\r\n"),
		});
		assert.deepEqual(loaded.module.extractDroppedResources(transfer), [
			"file:///workspace/src/main.ts",
			"file:///workspace/src/view.ts",
		]);
	} finally {
		await loaded.dispose();
	}
});

test("CodeFiles paths are accepted without treating plain text as a resource", async () => {
	const loaded = await loadResourceDrop();
	try {
		const codeFiles = dataTransfer({
			CodeFiles: JSON.stringify(["/workspace/src/main.ts"]),
		});
		assert.deepEqual(loaded.module.extractDroppedResources(codeFiles), [
			"/workspace/src/main.ts",
		]);

		const plainText = dataTransfer({ "text/plain": "/workspace/secret.txt" });
		assert.equal(loaded.module.containsDroppedResources(plainText), false);
		assert.deepEqual(loaded.module.extractDroppedResources(plainText), []);
	} finally {
		await loaded.dispose();
	}
});
