import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadStore() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-composer-reference-store-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "store.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [
			path.join(root, "src", "provider", "composerReferenceStore.ts"),
		],
		outfile: output,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
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
								const state = () => globalThis.__composerReferenceVscodeMock;
								export const DiagnosticSeverity = {
									Error: 0,
									Warning: 1,
									Information: 2,
									Hint: 3,
								};
								export const SymbolKind = new Proxy({}, {
									get: (_target, key) => state().symbolKinds?.[key],
								});
								export class Selection {
									constructor(start, end) { this.start = start; this.end = end; }
								}
								export const TextEditorRevealType = { InCenterIfOutsideViewport: 0 };
								export const languages = {
									getDiagnostics: (uri) => state().diagnostics.get(uri.toString()) ?? [],
								};
								export const workspace = {
									get workspaceFolders() { return state().workspaceFolders; },
									getWorkspaceFolder: (uri) => state().getWorkspaceFolder(uri),
									asRelativePath: (uri, includeFolder) => state().asRelativePath(uri, includeFolder),
									openTextDocument: (uri) => state().openTextDocument(uri),
								};
								export const window = {
									showTextDocument: (document, options) => state().showTextDocument(document, options),
									showWarningMessage: (message) => state().warnings.push(message),
								};
								export const commands = {
									executeCommand: (...args) => state().executeCommand(...args),
								};
							`,
					}));
				},
			},
		],
	});
	return {
		module: await import(`${pathToFileURL(output).href}?v=${Date.now()}`),
		dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
	};
}

function uri(value, scheme = "file") {
	return {
		scheme,
		fsPath: scheme === "file" ? value : "",
		toString: () =>
			scheme === "file" ? `file://${value}` : `${scheme}:${value}`,
	};
}

function position(line, character) {
	return { line, character };
}

function selection(startLine, startCharacter, endLine, endCharacter) {
	const start = position(startLine, startCharacter);
	const end = position(endLine, endCharacter);
	return {
		start,
		end,
		isEmpty: startLine === endLine && startCharacter === endCharacter,
		intersection: () => ({}),
	};
}

function documentFor(fileUri, text, languageId = "typescript") {
	return {
		uri: fileUri,
		fileName: fileUri.fsPath,
		languageId,
		getText: (range) => {
			if (!range) return text;
			return text.slice(range.start.character, range.end.character);
		},
		offsetAt: (value) => value.character,
		positionAt: (offset) => position(0, offset),
		validatePosition: (value) => value,
	};
}

function editorFor(document, selected) {
	return { document, selection: selected };
}

function installVscodeState() {
	const state = {
		workspaceFolders: [{ name: "workspace", uri: uri("/workspace") }],
		diagnostics: new Map(),
		warnings: [],
		symbolKinds: { 5: "Method" },
		getWorkspaceFolder: (value) =>
			value.fsPath.startsWith("/workspace/")
				? state.workspaceFolders[0]
				: undefined,
		asRelativePath: (value, includeFolder) =>
			`${includeFolder ? "workspace/" : ""}${value.fsPath.replace("/workspace/", "")}`,
		openTextDocument: async () => {
			throw new Error("not configured");
		},
		showTextDocument: async () => {
			throw new Error("not configured");
		},
		executeCommand: async () => undefined,
	};
	globalThis.__composerReferenceVscodeMock = state;
	return state;
}

function output() {
	const lines = [];
	return { lines, appendLine: (line) => lines.push(line) };
}

test("selection recapture preserves identity, marker order, and increments revision", async () => {
	const loaded = await loadStore();
	try {
		installVscodeState();
		const store = new loaded.module.ComposerReferenceStore(output());
		const document = documentFor(
			uri("/workspace/src/example.ts"),
			"const answer = 42;",
		);
		const selected = selection(0, 6, 0, 12);
		const editor = editorFor(document, selected);

		const id = store.captureSelection(editor);
		const first = store.summaries()[0];
		assert.equal(first.id, id);
		assert.equal(first.revision, 0);
		assert.equal(first.marker, "@src/example.ts#1");

		assert.equal(store.captureSelection(editor), id);
		const second = store.summaries()[0];
		assert.equal(second.id, id);
		assert.equal(second.revision, 1);
		assert.equal(second.marker, first.marker);
		assert.equal(store.summaries().length, 1);
	} finally {
		delete globalThis.__composerReferenceVscodeMock;
		await loaded.dispose();
	}
});

test("resolve validates marker identity and returns prompt-compatible captures", async () => {
	const loaded = await loadStore();
	try {
		installVscodeState();
		const store = new loaded.module.ComposerReferenceStore(output());
		const fileId = store.captureFile(uri("/workspace/src/file.ts"));
		const summary = store.summaries()[0];
		const text = `Review ${summary.marker} now`;
		const start = text.indexOf(summary.marker);
		const resolved = store.resolve(
			[{ id: fileId, revision: 0, start, end: start + summary.marker.length }],
			text,
		);
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0].reference.summary, summary);
		assert.equal(resolved[0].reference.payload.path, "/workspace/src/file.ts");

		assert.throws(
			() =>
				store.resolve(
					[
						{
							id: fileId,
							revision: 1,
							start,
							end: start + summary.marker.length,
						},
					],
					text,
				),
			/A composer reference changed/u,
		);
		assert.throws(
			() =>
				store.resolve(
					[{ id: fileId, revision: 0, start: 0, end: summary.marker.length }],
					text,
				),
			/A composer reference marker changed/u,
		);
		assert.throws(
			() =>
				store.resolve(
					[
						{
							id: fileId,
							revision: 0,
							start,
							end: start + summary.marker.length,
						},
						{
							id: fileId,
							revision: 0,
							start,
							end: start + summary.marker.length,
						},
					],
					text,
				),
			/Duplicate composer reference/u,
		);
	} finally {
		delete globalThis.__composerReferenceVscodeMock;
		await loaded.dispose();
	}
});

test("identity-safe consume does not remove a newer revision", async () => {
	const loaded = await loadStore();
	try {
		installVscodeState();
		const store = new loaded.module.ComposerReferenceStore(output());
		const document = documentFor(uri("/workspace/src/example.ts"), "abcdef");
		const editor = editorFor(document, selection(0, 1, 0, 4));
		store.captureSelection(editor);
		const pendingSnapshot = store.snapshot();
		store.captureSelection(editor);
		assert.equal(store.summaries()[0].revision, 1);

		store.consume(pendingSnapshot);
		assert.equal(store.summaries().length, 1);
		assert.equal(store.summaries()[0].revision, 1);
		store.consume(store.snapshot());
		assert.deepEqual(store.summaries(), []);
	} finally {
		delete globalThis.__composerReferenceVscodeMock;
		await loaded.dispose();
	}
});

test("registerFiles enforces the shared count limit and remove is revision-safe", async () => {
	const loaded = await loadStore();
	try {
		installVscodeState();
		const store = new loaded.module.ComposerReferenceStore(output());
		store.registerFiles(
			Array.from({ length: 10 }, (_, index) =>
				uri(`/workspace/src/file-${index}.ts`),
			),
		);
		assert.equal(store.summaries().length, 10);
		assert.throws(
			() => store.registerFiles([uri("/workspace/src/overflow.ts")]),
			/Add at most 10 references/u,
		);
		const first = store.summaries()[0];
		assert.equal(store.remove(first.id, first.revision + 1), false);
		assert.equal(store.remove(first.id, first.revision), true);
		assert.equal(store.summaries().length, 9);
	} finally {
		delete globalThis.__composerReferenceVscodeMock;
		await loaded.dispose();
	}
});
