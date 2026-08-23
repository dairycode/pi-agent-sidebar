import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadWorkspaceResources() {
	return loadBundledModule({
		entry: "src/services/workspaceResources.ts",
		name: "workspace-resources",
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
							const state = () => globalThis.__workspaceResourcesVscodeMock;
							const makeUri = (value, scheme = "file", authority = "") => ({
								scheme,
								authority,
								fsPath: scheme === "file"
									? (value.startsWith("file://") ? value.slice(7) : value)
									: new URL(value).pathname,
								value,
								with: () => makeUri(value, scheme, authority),
								toString: () => value,
							});
							export const Uri = {
								file: (value) => makeUri(value, "file"),
								parse: (value) => {
									const parsed = new URL(value);
									return makeUri(value, parsed.protocol.slice(0, -1), parsed.host);
								},
								joinPath: (base, child) => makeUri(
									(base.value.endsWith("/") ? base.value : base.value + "/") + child,
									base.scheme,
									base.authority,
								),
							};
							export const workspace = {
								get workspaceFolders() { return state()?.workspaceFolders ?? []; },
								get textDocuments() { return []; },
								fs: { stat: (uri) => state().stat(uri) },
								getWorkspaceFolder: (uri) => state().getWorkspaceFolder(uri),
								openTextDocument: (uri) => state().openTextDocument(uri),
							};
							export const window = {
								showWarningMessage: (message) => state().warnings.push(message),
								showTextDocument: (document, options) => state().showTextDocument(document, options),
							};
							export const commands = {
								executeCommand: (...args) => state().executeCommand(...args),
							};
							export const FileType = { File: 1, Directory: 2 };
							export class Position {}
							export class Selection {}
							export class Range {}
							export const TextEditorRevealType = { InCenterIfOutsideViewport: 0 };
						`,
					}));
				},
			},
		],
	});
}

function installVscodeState(module) {
	const calls = { opened: [], revealed: [] };
	const workspaceUri = module.parseDroppedResource("/workspace");
	const state = {
		workspaceFolders: [{ name: "workspace", uri: workspaceUri }],
		warnings: [],
		stat: async (uri) => ({
			type: uri.fsPath.endsWith("/src") ? 2 : 1,
			ctime: 0,
			mtime: 0,
			size: 0,
		}),
		getWorkspaceFolder: (uri) =>
			uri.fsPath.startsWith("/workspace")
				? state.workspaceFolders[0]
				: undefined,
		openTextDocument: async (uri) => {
			calls.opened.push(uri.fsPath);
			return { uri, lineCount: 1 };
		},
		showTextDocument: async () => ({}),
		executeCommand: async (command, uri) => {
			calls.revealed.push([command, uri.fsPath]);
		},
	};
	globalThis.__workspaceResourcesVscodeMock = state;
	return { state, calls };
}

test("workspace display paths resolve explicit multi-root prefixes", async () => {
	const loaded = await loadWorkspaceResources();
	try {
		assert.deepEqual(
			loaded.module.splitWorkspaceReferencePath("docs/src/guide.md", [
				"app",
				"docs",
			]),
			{
				workspaceFolderName: "docs",
				relativePath: "src/guide.md",
			},
		);
		assert.equal(
			loaded.module.splitWorkspaceReferencePath("src/guide.md", ["app"]),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});

test("dropped resources accept absolute paths and strict URIs", async () => {
	const loaded = await loadWorkspaceResources();
	try {
		const local = loaded.module.parseDroppedResource("/workspace/main.ts");
		assert.equal(local.scheme, "file");
		assert.equal(local.fsPath, "/workspace/main.ts");

		const remote = loaded.module.parseDroppedResource(
			"vscode-remote://host/workspace/main.ts",
		);
		assert.equal(remote.scheme, "vscode-remote");
		assert.equal(remote.authority, "host");
		assert.equal(remote.fsPath, "/workspace/main.ts");
		assert.throws(
			() => loaded.module.parseDroppedResource("not a URI"),
			/valid file URI/iu,
		);
	} finally {
		await loaded.dispose();
	}
});

test("reference validation classifies files and directories without reading them", async () => {
	const loaded = await loadWorkspaceResources();
	try {
		installVscodeState(loaded.module);
		const resources = new loaded.module.WorkspaceResources(
			async () => globalThis.__workspaceResourcesVscodeMock.workspaceFolders[0],
		);
		const file = loaded.module.parseDroppedResource("/workspace/main.ts");
		const directory = loaded.module.parseDroppedResource("/workspace/src");

		assert.deepEqual(
			(await resources.validateReferences([file, directory])).map(
				(resource) => resource.kind,
			),
			["file", "directory"],
		);
		await assert.rejects(
			resources.validateFiles([directory]),
			/src is not a regular file/iu,
		);
	} finally {
		delete globalThis.__workspaceResourcesVscodeMock;
		await loaded.dispose();
	}
});

test("opening a directory reveals it while files still open as text", async () => {
	const loaded = await loadWorkspaceResources();
	try {
		const { state, calls } = installVscodeState(loaded.module);
		const resources = new loaded.module.WorkspaceResources(
			async () => state.workspaceFolders[0],
		);

		await resources.openResource("file:///workspace/src");
		await resources.openResource("file:///workspace/main.ts");

		assert.deepEqual(calls.revealed, [["revealInExplorer", "/workspace/src"]]);
		assert.deepEqual(calls.opened, ["/workspace/main.ts"]);
	} finally {
		delete globalThis.__workspaceResourcesVscodeMock;
		await loaded.dispose();
	}
});
