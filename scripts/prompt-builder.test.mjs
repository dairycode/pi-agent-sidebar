import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadPromptBuilder() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-prompt-builder-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "prompt-builder.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "src", "promptBuilder.ts")],
		outfile: output,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
	});
	return {
		module: await import(`${pathToFileURL(output).href}?v=${Date.now()}`),
		dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
	};
}

function attachment(kind, filePath) {
	return {
		summary: { id: `${kind}-id`, path: filePath, label: path.basename(filePath), kind },
		filePath,
		temporary: false,
		...(kind === "image" ? { mimeType: "image/png" } : {}),
	};
}

function attachmentStore(imageData = Buffer.from("image")) {
	return {
		validated: [],
		async validateRegularFile(value) {
			this.validated.push(value.filePath);
		},
		async readImage(value) {
			return {
				data: imageData,
				mimeType: value.mimeType ?? "image/png",
			};
		},
	};
}

test("prompt builder preserves structured context order and prompt text", async () => {
	const loaded = await loadPromptBuilder();
	try {
		const store = attachmentStore();
		const references = [
			{
				summary: { kind: "file" },
				payload: {
					path: "/workspace/src/file.ts",
					uri: "file:///workspace/src/file.ts",
					displayPath: "src/file.ts",
					marker: "@src/file.ts",
				},
			},
			{
				summary: { kind: "selection" },
				payload: {
					path: "/workspace/src/selected.ts",
					uri: "file:///workspace/src/selected.ts",
					displayPath: "src/selected.ts",
					marker: "@src/selected.ts#2",
					languageId: "typescript",
					startLine: 2,
					endLine: 2,
					text: "const selected = true;",
				},
				diagnostics: [
					{ line: 2, severity: "warning", message: "Example warning" },
				],
				symbol: "selected",
			},
		];
		const result = await loaded.module.buildPrompt(
			"Compare @src/file.ts with @src/selected.ts#2",
			[attachment("file", "/workspace/package.json")],
			references,
			store,
		);

		assert.deepEqual(store.validated, ["/workspace/package.json"]);
		assert.deepEqual(result.images, []);
		assert.match(result.message, /^<pi-context>\n/u);
		assert.ok(
			result.message.indexOf('- file: "/workspace/package.json"') <
				result.message.indexOf('- file: {"path":"/workspace/src/file.ts"'),
		);
		assert.ok(
			result.message.indexOf('- file: {"path":"/workspace/src/file.ts"') <
				result.message.indexOf('- selection: {"path":"/workspace/src/selected.ts"'),
		);
		assert.match(result.message, /- diagnostics: .*Example warning/u);
		assert.match(result.message, /- symbol: .*selected/u);
		assert.match(
			result.message,
			/<\/pi-context>\n\nCompare @src\/file\.ts with @src\/selected\.ts#2$/u,
		);
	} finally {
		await loaded.dispose();
	}
});

test("prompt builder supplies context-specific defaults and encodes images", async () => {
	const loaded = await loadPromptBuilder();
	try {
		const image = attachment("image", "/tmp/image.png");
		const imageResult = await loaded.module.buildPrompt(
			"",
			[image],
			[],
			attachmentStore(Buffer.from("png")),
		);
		assert.equal(imageResult.message, "Inspect the attached image.");
		assert.deepEqual(imageResult.images, [
			{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
		]);

		const referenceResult = await loaded.module.buildPrompt(
			" ",
			[],
			[
				{
					summary: { kind: "file" },
					payload: {
						path: "/workspace/file.ts",
						displayPath: "file.ts",
						marker: "@file.ts",
					},
				},
			],
			attachmentStore(),
		);
		assert.match(referenceResult.message, /Inspect the referenced file\.$/u);
	} finally {
		await loaded.dispose();
	}
});

test("prompt builder enforces message and total image limits", async () => {
	const loaded = await loadPromptBuilder();
	try {
		await assert.rejects(
			loaded.module.buildPrompt(
				"x".repeat(1_000_001),
				[],
				[],
				attachmentStore(),
			),
			/Message is too large/iu,
		);
		const image = attachment("image", "/tmp/image.png");
		await assert.rejects(
			loaded.module.buildPrompt(
				"inspect",
				[image],
				[],
				attachmentStore(Buffer.alloc(12 * 1024 * 1024 + 1)),
			),
			/12 MB total limit/iu,
		);
	} finally {
		await loaded.dispose();
	}
});
