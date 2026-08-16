import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadWorkspaceFileSearch() {
	return loadBundledModule({
		entry: "src/services/workspaceFileSearch.ts",
		name: "workspace-file-search",
		plugins: [
			{
				name: "mock-vscode",
				setup(buildApi) {
					buildApi.onResolve({ filter: /^vscode$/ }, () => ({
						path: "vscode",
						namespace: "mock-vscode",
					}));
					buildApi.onLoad({ filter: /.*/, namespace: "mock-vscode" }, () => ({
						loader: "js",
						contents: `
							export const workspace = {
								workspaceFolders: [{ name: "app" }],
								getWorkspaceFolder: () => ({ name: "app" }),
								asRelativePath: (uri) => uri.path,
								findFiles: async () => [],
								createFileSystemWatcher: () => ({
									dispose() {},
									onDidCreate: () => ({ dispose() {} }),
									onDidDelete: () => ({ dispose() {} }),
								}),
								onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
							};
						`,
					}));
				},
			},
		],
	});
}

function candidate(displayPath) {
	return {
		uri: { toString: () => `file:///${displayPath}` },
		displayPath,
	};
}

const candidates = [
	candidate("src/provider/piViewProvider.ts"),
	candidate("src/provider/composerReferenceStore.ts"),
	candidate("src/services/workspaceFileSearch.ts"),
	candidate("webview/composer/mentions.ts"),
	candidate("webview/main.ts"),
	candidate("test/unit/webview/mentions.test.mjs"),
	candidate("README.md"),
];

function simplify(entries) {
	return entries.map(({ kind, displayPath }) => ({ kind, displayPath }));
}

test("a bare mention lists only workspace-root children", async () => {
	const loaded = await loadWorkspaceFileSearch();
	try {
		assert.deepEqual(
			simplify(loaded.module.listWorkspaceEntries(candidates, "")),
			[
				{ kind: "directory", displayPath: "src" },
				{ kind: "directory", displayPath: "test" },
				{ kind: "directory", displayPath: "webview" },
				{ kind: "file", displayPath: "README.md" },
			],
		);
	} finally {
		await loaded.dispose();
	}
});

test("entering a directory reveals only its immediate children", async () => {
	const loaded = await loadWorkspaceFileSearch();
	try {
		assert.deepEqual(
			simplify(loaded.module.listWorkspaceEntries(candidates, "src/")),
			[
				{ kind: "directory", displayPath: "src/provider" },
				{ kind: "directory", displayPath: "src/services" },
			],
		);
		assert.deepEqual(
			simplify(loaded.module.listWorkspaceEntries(candidates, "src/provider/")),
			[
				{ kind: "file", displayPath: "src/provider/composerReferenceStore.ts" },
				{ kind: "file", displayPath: "src/provider/piViewProvider.ts" },
			],
		);
	} finally {
		await loaded.dispose();
	}
});

test("typing filters names only within the current directory", async () => {
	const loaded = await loadWorkspaceFileSearch();
	try {
		assert.deepEqual(
			simplify(loaded.module.listWorkspaceEntries(candidates, "sr")),
			[{ kind: "directory", displayPath: "src" }],
		);
		assert.deepEqual(
			simplify(loaded.module.listWorkspaceEntries(candidates, "src/pro")),
			[{ kind: "directory", displayPath: "src/provider" }],
		);
		assert.deepEqual(
			simplify(loaded.module.listWorkspaceEntries(candidates, "src/piview")),
			[],
			"a descendant file must not leak into its parent level",
		);
	} finally {
		await loaded.dispose();
	}
});

test("directory entries are deduplicated, directories sort first, and limits apply", async () => {
	const loaded = await loadWorkspaceFileSearch();
	try {
		const entries = loaded.module.listWorkspaceEntries(candidates, "", 2);
		assert.equal(entries.length, 2);
		assert.ok(entries.every((entry) => entry.kind === "directory"));
		assert.equal(
			loaded.module
				.listWorkspaceEntries(candidates, "webview/")
				.filter((entry) => entry.displayPath === "webview/composer").length,
			1,
		);
	} finally {
		await loaded.dispose();
	}
});

test("backslashes navigate the same hierarchy as forward slashes", async () => {
	const loaded = await loadWorkspaceFileSearch();
	try {
		assert.deepEqual(
			simplify(
				loaded.module.listWorkspaceEntries(candidates, "src\\provider\\"),
			),
			simplify(loaded.module.listWorkspaceEntries(candidates, "src/provider/")),
		);
	} finally {
		await loaded.dispose();
	}
});
