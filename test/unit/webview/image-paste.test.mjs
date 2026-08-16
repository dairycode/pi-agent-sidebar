import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();
const MB = 1024 * 1024;

async function loadImagePaste() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-image-paste-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "image-paste.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "webview", "attachments", "imagePaste.ts")],
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

function file(name, type, size) {
	return { name, type, size };
}

function pasteEvent(items) {
	let prevented = 0;
	return {
		clipboardData: { items },
		preventDefault() {
			prevented += 1;
		},
		get prevented() {
			return prevented;
		},
	};
}

function item(kind, type, value) {
	return { kind, type, getAsFile: () => value };
}

function harness(options = {}) {
	const images = [];
	const errors = [];
	return {
		images,
		errors,
		dependencies: {
			attachedImageCount: () => options.attachedImageCount ?? 0,
			onImages: (value) => images.push(value),
			onError: (message) => errors.push(message),
			readFile: options.readFile ?? (async (value) => `data:${value.name}`),
		},
	};
}

test("non-image clipboard data is left to the textarea", async () => {
	const loaded = await loadImagePaste();
	try {
		const event = pasteEvent([
			item("string", "text/plain", null),
			item("file", "application/pdf", file("doc.pdf", "application/pdf", 10)),
		]);
		const state = harness();
		await loaded.module.handleImagePaste(event, state.dependencies);
		assert.equal(event.prevented, 0);
		assert.deepEqual(state.images, []);
		assert.deepEqual(state.errors, []);
	} finally {
		await loaded.dispose();
	}
});

test("valid images are converted in order with normalized MIME and fallback names", async () => {
	const loaded = await loadImagePaste();
	try {
		const event = pasteEvent([
			item("file", "image/PNG", file("first.png", "image/PNG", 12)),
			item("file", "image/jpeg", file("", "image/jpeg", 20)),
		]);
		const state = harness({
			readFile: async (value) => {
				if (value.name === "first.png") await Promise.resolve();
				return `base64:${value.type}`;
			},
		});
		await loaded.module.handleImagePaste(event, state.dependencies);
		assert.equal(event.prevented, 1);
		assert.deepEqual(state.errors, []);
		assert.deepEqual(state.images, [
			[
				{
					name: "first.png",
					mimeType: "image/png",
					data: "base64:image/PNG",
				},
				{
					name: "Pasted image 2",
					mimeType: "image/jpeg",
					data: "base64:image/jpeg",
				},
			],
		]);
	} finally {
		await loaded.dispose();
	}
});

test("image validation rejects unsupported, oversized, and excessive batches", async () => {
	const loaded = await loadImagePaste();
	try {
		const cases = [
			{
				event: pasteEvent([
					item("file", "image/bmp", file("x.bmp", "image/bmp", 10)),
				]),
				state: harness(),
				error: "Paste PNG, JPEG, GIF, or WebP images",
			},
			{
				event: pasteEvent([
					item(
						"file",
						"image/png",
						file("large.png", "image/png", 10 * MB + 1),
					),
				]),
				state: harness(),
				error: "large.png exceeds the 10 MB limit",
			},
			{
				event: pasteEvent([
					item("file", "image/png", file("a.png", "image/png", 7 * MB)),
					item("file", "image/png", file("b.png", "image/png", 6 * MB)),
				]),
				state: harness(),
				error: "Pasted images exceed the 12 MB total limit",
			},
			{
				event: pasteEvent([
					item("file", "image/png", file("extra.png", "image/png", 1)),
				]),
				state: harness({ attachedImageCount: 4 }),
				error: "Attach at most 4 images per message",
			},
		];
		for (const current of cases) {
			await loaded.module.handleImagePaste(
				current.event,
				current.state.dependencies,
			);
			assert.equal(current.event.prevented, 1);
			assert.deepEqual(current.state.images, []);
			assert.deepEqual(current.state.errors, [current.error]);
		}
	} finally {
		await loaded.dispose();
	}
});

test("a conversion failure rejects the whole paste", async () => {
	const loaded = await loadImagePaste();
	try {
		const event = pasteEvent([
			item("file", "image/png", file("good.png", "image/png", 10)),
			item("file", "image/png", file("bad.png", "image/png", 10)),
		]);
		const state = harness({
			readFile: async (value) => {
				if (value.name === "bad.png") throw new Error("Could not decode image");
				return "ok";
			},
		});
		await loaded.module.handleImagePaste(event, state.dependencies);
		assert.deepEqual(state.images, []);
		assert.deepEqual(state.errors, ["Could not decode image"]);
	} finally {
		await loaded.dispose();
	}
});
