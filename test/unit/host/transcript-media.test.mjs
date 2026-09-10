import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadTranscriptMedia() {
	return loadBundledModule({
		entry: "src/services/transcriptMedia.ts",
		name: "transcript-media",
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
							const state = () => globalThis.__transcriptMediaVscodeMock;
							const toFileUri = (value) => ({
								scheme: "file",
								fsPath: value,
								toString: () => "file://" + value,
							});
							export const Uri = {
								file: (value) => toFileUri(value),
								parse: (value) => {
									const text = String(value);
									if (!text.startsWith("file://")) throw new Error("not a file uri");
									return toFileUri(decodeURIComponent(text.slice(7)));
								},
							};
							export const FileType = { File: 1, Directory: 2 };
							export const workspace = {
								fs: {
									stat: async (uri) => {
										const entry = state()?.files?.[uri.fsPath];
										if (!entry) throw new Error("ENOENT");
										return {
											type: entry.kind === "directory" ? 2 : 1,
											size: entry.size ?? 1024,
										};
									},
								},
							};
						`,
					}));
				},
			},
		],
	});
}

/**
 * A made-up file system. `files` is keyed by the path a transcript would name:
 * `real` is where a symlink points, and a path absent from the map does not
 * exist at all.
 */
function harness(
	module,
	{ roots = ["/workspace"], cwd = "/workspace", files = {} } = {},
) {
	globalThis.__transcriptMediaVscodeMock = { files };
	const canonical = (value) => files[value]?.real ?? value;
	return new module.TranscriptMedia(
		() => roots,
		() => cwd,
		{
			realpathSync: canonical,
			realpath: async (value) => {
				if (!files[value]) throw new Error("ENOENT");
				return canonical(value);
			},
		},
	);
}

function png(size = 1024, extra = {}) {
	return { kind: "file", size, ...extra };
}

test("a workspace image resolves to its canonical file path", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const media = harness(loaded.module, {
			files: { "/workspace/docs/shot.png": png() },
		});

		const uri = await media.resolve("/workspace/docs/shot.png");

		assert.equal(uri?.fsPath, "/workspace/docs/shot.png");
	} finally {
		await loaded.dispose();
	}
});

test("a relative path resolves against pi's working directory", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const media = harness(loaded.module, {
			roots: ["/workspace"],
			cwd: "/workspace/packages/app",
			files: { "/workspace/packages/app/out/chart.png": png() },
		});

		const uri = await media.resolve("out/chart.png");

		assert.equal(uri?.fsPath, "/workspace/packages/app/out/chart.png");
	} finally {
		await loaded.dispose();
	}
});

test("the temp directory renders, because that is where previews land", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const media = harness(loaded.module, {
			files: { "/tmp/pi-block-preview/compare.png": png() },
		});

		const uri = await media.resolve("/tmp/pi-block-preview/compare.png");

		assert.equal(uri?.fsPath, "/tmp/pi-block-preview/compare.png");
	} finally {
		await loaded.dispose();
	}
});

test("a path outside every allowed root is refused", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const media = harness(loaded.module, {
			files: {
				"/Users/someone/Pictures/private.png": png(),
				// The escaped target exists, so it is containment that refuses it and not
				// a missing file: `../outside.png` resolves to `/outside.png`.
				"/outside.png": png(),
				"/workspace-other/chart.png": png(),
			},
		});

		assert.equal(
			await media.resolve("/Users/someone/Pictures/private.png"),
			undefined,
		);
		assert.equal(await media.resolve("../outside.png"), undefined);
		// A root's name is a prefix of this one; only a real separator makes a path
		// inside it.
		assert.equal(await media.resolve("/workspace-other/chart.png"), undefined);
		// Refused by the extension check rather than by containment, but still never
		// served.
		assert.equal(await media.resolve("/etc/passwd"), undefined);
	} finally {
		await loaded.dispose();
	}
});

test("a symlink cannot walk out of the allowed roots", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const media = harness(loaded.module, {
			files: {
				"/workspace/link.png": png(1024, { real: "/Users/someone/secret.png" }),
				"/Users/someone/secret.png": png(),
			},
		});

		assert.equal(await media.resolve("/workspace/link.png"), undefined);
	} finally {
		await loaded.dispose();
	}
});

test("only regular images under the size ceiling are served", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const media = harness(loaded.module, {
			files: {
				"/workspace/diagram.png": png(),
				"/workspace/notes.md": { kind: "file", size: 10 },
				"/workspace/scripts": { kind: "directory" },
				// The ceiling admits exactly 24 MB; one byte more is refused.
				"/workspace/exact.png": png(24 * 1024 * 1024),
				"/workspace/huge.png": png(24 * 1024 * 1024 + 1),
			},
		});

		assert.equal(
			(await media.resolve("/workspace/diagram.png"))?.fsPath,
			"/workspace/diagram.png",
		);
		assert.equal(await media.resolve("/workspace/notes.md"), undefined);
		assert.equal(await media.resolve("/workspace/scripts"), undefined);
		assert.equal(
			(await media.resolve("/workspace/exact.png"))?.fsPath,
			"/workspace/exact.png",
		);
		assert.equal(await media.resolve("/workspace/huge.png"), undefined);
		assert.equal(await media.resolve("/workspace/missing.png"), undefined);
	} finally {
		await loaded.dispose();
	}
});

test("only allow-listed image extensions are served", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const accepted = [
			"icon.png",
			"icon.jpg",
			"icon.jpeg",
			"icon.gif",
			"icon.webp",
			"icon.bmp",
			"icon.avif",
			"icon.svg",
			"SCREENSHOT.PNG",
		];
		const refused = [
			"notes.txt",
			"page.html",
			"bundle.js",
			"archive.png.zip",
			"shot.png.bak",
			"no-extension",
		];
		const files = {};
		for (const name of [...accepted, ...refused]) {
			files[`/workspace/${name}`] = png();
		}
		const media = harness(loaded.module, { files });

		for (const name of accepted) {
			assert.equal(
				(await media.resolve(`/workspace/${name}`))?.fsPath,
				`/workspace/${name}`,
			);
		}
		// The files exist, so the extension is what refuses them.
		for (const name of refused) {
			assert.equal(await media.resolve(`/workspace/${name}`), undefined);
		}
	} finally {
		await loaded.dispose();
	}
});

test("a name that merely starts with dots is inside the root", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const media = harness(loaded.module, {
			files: { "/workspace/..cache/preview.png": png() },
		});

		assert.equal(
			(await media.resolve("/workspace/..cache/preview.png"))?.fsPath,
			"/workspace/..cache/preview.png",
		);
	} finally {
		await loaded.dispose();
	}
});

test("a file URI and an escaped path name the same image", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const media = harness(loaded.module, {
			files: {
				"/workspace/my shot.png": png(),
				"/workspace/chart.png": png(),
			},
		});

		assert.equal(
			(await media.resolve("file:///workspace/my%20shot.png"))?.fsPath,
			"/workspace/my shot.png",
		);
		assert.equal(
			(await media.resolve("/workspace/my%20shot.png"))?.fsPath,
			"/workspace/my shot.png",
		);
		assert.equal(
			(await media.resolve("/workspace/chart.png?v=2"))?.fsPath,
			"/workspace/chart.png",
		);
	} finally {
		await loaded.dispose();
	}
});

test("a remote or embedded source never reaches the resolver", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		const media = harness(loaded.module, {
			files: { "/workspace/https:/example.com/a.png": png() },
		});

		assert.equal(await media.resolve("https://example.com/a.png"), undefined);
		assert.equal(await media.resolve("data:image/png;base64,AAAA"), undefined);
		assert.equal(await media.resolve(""), undefined);
		assert.equal(await media.resolve("   "), undefined);
	} finally {
		await loaded.dispose();
	}
});

test("localResourceRoots covers the workspace and the temp directory once", async () => {
	const loaded = await loadTranscriptMedia();
	try {
		globalThis.__transcriptMediaVscodeMock = { files: {} };
		const canonicalized = [];
		const media = new loaded.module.TranscriptMedia(
			() => ["/workspace", "/workspace", "/extra"],
			() => "/workspace",
			{
				realpathSync: (value) => {
					canonicalized.push(value);
					return value;
				},
				realpath: async (value) => value,
			},
		);

		// `os.tmpdir()` is `/tmp` itself on most Linux machines and `roots()` dedupes,
		// so the expectation has to be built the same way: written out literally it
		// would only pass where TMPDIR points somewhere else.
		const expectedRoots = [
			...new Set(["/workspace", "/extra", os.tmpdir(), "/tmp"]),
		];
		assert.deepEqual(media.roots(), expectedRoots);
		// Read live so a folder added later is still allowed, but canonicalized once
		// per root: resolution asks on every image.
		assert.deepEqual(media.roots(), expectedRoots);
		assert.deepEqual(canonicalized, expectedRoots);
	} finally {
		await loaded.dispose();
	}
});
