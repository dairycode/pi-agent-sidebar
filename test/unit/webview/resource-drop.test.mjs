import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadResourceDrop() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-resource-drop-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "resource-drop.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "webview", "resourceDrop.ts")],
		outfile: output,
		bundle: true,
		platform: "browser",
		format: "esm",
		target: "chrome120",
		logLevel: "silent",
	});
	return {
		module: await import(`${pathToFileURL(output).href}?v=${Date.now()}`),
		dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
	};
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
			]),
		});
		assert.equal(loaded.module.containsDroppedResources(transfer), true);
		assert.deepEqual(loaded.module.extractDroppedResources(transfer), [
			"file:///workspace/src/main.ts",
			"file:///workspace/src/view.ts",
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
