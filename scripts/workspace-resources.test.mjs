import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadWorkspaceResources() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-workspace-resources-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "workspace-resources.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "src", "workspaceResources.ts")],
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
					buildApi.onLoad(
						{ filter: /.*/, namespace: "mock-vscode" },
						() => ({
							loader: "js",
							contents: `
								export const Uri = {
									file: (value) => ({ scheme: "file", fsPath: value, value }),
									parse: (value) => {
										if (!/^[a-z][a-z0-9+.-]*:/iu.test(value)) throw new Error("invalid URI");
										return { scheme: value.slice(0, value.indexOf(":")), value };
									},
									joinPath: () => undefined,
								};
								export const workspace = {};
								export const window = {};
								export const FileType = { File: 1 };
								export class Position {}
								export class Selection {}
								export class Range {}
								export const TextEditorRevealType = { InCenterIfOutsideViewport: 0 };
							`,
						}),
					);
				},
			},
		],
	});
	return {
		module: await import(`${pathToFileURL(output).href}?v=${Date.now()}`),
		dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
	};
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
		assert.deepEqual(loaded.module.parseDroppedResource("/workspace/main.ts"), {
			scheme: "file",
			fsPath: "/workspace/main.ts",
			value: "/workspace/main.ts",
		});
		assert.deepEqual(
			loaded.module.parseDroppedResource("vscode-remote://host/workspace/main.ts"),
			{
				scheme: "vscode-remote",
				value: "vscode-remote://host/workspace/main.ts",
			},
		);
		assert.throws(
			() => loaded.module.parseDroppedResource("not a URI"),
			/valid file URI/iu,
		);
	} finally {
		await loaded.dispose();
	}
});
