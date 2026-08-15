import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadComposerReferences() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-composer-reference-test-"),
	);
	const output = path.join(
		temporaryDirectory,
		"bundle",
		"composer-references.mjs",
	);
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "src", "composerReferences.ts")],
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

test("composer references format file and selection markers", async () => {
	const loaded = await loadComposerReferences();
	try {
		assert.deepEqual(loaded.module.selectedLineRange(4, 5, 0), {
			startLine: 5,
			endLine: 5,
		});
		assert.deepEqual(loaded.module.selectedLineRange(4, 5, 3), {
			startLine: 5,
			endLine: 6,
		});
		assert.equal(
			loaded.module.formatComposerReferenceLocation({
				kind: "selection",
				displayPath: "src/example.ts",
				startLine: 5,
				endLine: 5,
			}),
			"src/example.ts:5",
		);
		assert.equal(
			loaded.module.formatComposerReferenceLocation({
				kind: "file",
				displayPath: "src/example.ts",
			}),
			"src/example.ts",
		);
		assert.equal(
			loaded.module.formatFileReferenceMarker("src/example.ts"),
			"@src/example.ts",
		);
		assert.equal(
			loaded.module.formatSelectionReferenceMarker("src/example.ts", 5, 7),
			"@src/example.ts#5-7",
		);
		assert.equal(
			loaded.module.uniqueComposerReferenceMarker(
				"@src/example.ts#5",
				"abcdef12-3456",
				new Set(["@src/example.ts#5"]),
			),
			"@src/example.ts#5~abcdef",
		);
		assert.equal(loaded.module.nearestOffset(50, 12, 58), 58);
		assert.equal(loaded.module.nearestOffset(50, -1, -1), -1);
		assert.equal(
			loaded.module.shouldSnapshotFileReference("file", false),
			false,
		);
		assert.equal(loaded.module.shouldSnapshotFileReference("file", true), true);
		assert.equal(
			loaded.module.shouldSnapshotFileReference("untitled", false),
			true,
		);
	} finally {
		await loaded.dispose();
	}
});

test("composer reference markers preserve and clean up composer text", async () => {
	const loaded = await loadComposerReferences();
	try {
		const marker = "@package.json#47-49";
		assert.deepEqual(
			loaded.module.insertComposerReferenceMarker("selected", 0, marker),
			{
				text: `${marker} selected`,
				caret: marker.length + 1,
				markerStart: 0,
				markerEnd: marker.length,
			},
		);
		assert.deepEqual(
			loaded.module.insertComposerReferenceMarker("explain this", 7, marker),
			{
				text: `explain ${marker} this`,
				caret: 8 + marker.length,
				markerStart: 8,
				markerEnd: 8 + marker.length,
			},
		);
		assert.equal(
			loaded.module.removeComposerReferenceMarker(
				`${marker} explain ${marker} please`,
				marker,
			),
			"explain please",
		);
		const shortMarker = "@foo.ts#1";
		assert.equal(
			loaded.module.findComposerReferenceMarker("@foo.ts#10", shortMarker),
			-1,
		);
		assert.equal(
			loaded.module.hasComposerReferenceMarker("@foo.ts#1-2", shortMarker),
			false,
		);
		assert.equal(
			loaded.module.removeComposerReferenceMarker("@foo.ts#10", shortMarker),
			"@foo.ts#10",
		);
		assert.equal(
			loaded.module.findComposerReferenceMarker(
				`before ${shortMarker} after`,
				shortMarker,
			),
			7,
		);
		assert.equal(
			loaded.module.removeComposerReferenceRanges(
				`literal ${marker} managed ${marker} tail`,
				[{ start: 8, end: 8 + marker.length }],
			),
			`literal managed ${marker} tail`,
		);
	} finally {
		await loaded.dispose();
	}
});

test("composer reference payloads safely round-trip context", async () => {
	const loaded = await loadComposerReferences();
	try {
		const reference = {
			path: "/workspace/src/example.ts",
			uri: "file:///workspace/src/example.ts",
			displayPath: "src/example.ts",
			marker: "@src/example.ts#9-10",
			languageId: "typescript",
			startLine: 9,
			endLine: 10,
			text: "const marker = '</pi-context>';\nconsole.log(marker);\u2028\u2029",
		};
		const serialized =
			loaded.module.serializeSelectionReferencePayload(reference);
		assert.equal(serialized.includes("</pi-context>"), false);
		assert.equal(serialized.includes("\u2028"), false);
		assert.equal(serialized.includes("\u2029"), false);
		assert.deepEqual(
			loaded.module.parseSelectionReferencePayload(serialized),
			reference,
		);
		assert.equal(
			loaded.module.parseSelectionReferencePayload('{"startLine": 0}'),
			undefined,
		);
		assert.equal(
			loaded.module.parseSelectionReferencePayload(
				JSON.stringify({ ...reference, path: "" }),
			),
			undefined,
		);
		const file = {
			path: "/workspace/src/example.ts",
			uri: "file:///workspace/src/example.ts",
			displayPath: "src/example.ts",
			marker: "@src/example.ts",
		};
		assert.deepEqual(
			loaded.module.parseFileReferencePayload(JSON.stringify(file)),
			file,
		);
		const legacyFile = { ...file, uri: undefined };
		assert.deepEqual(
			loaded.module.parseFileReferencePayload(JSON.stringify(legacyFile)),
			{
				path: legacyFile.path,
				displayPath: legacyFile.displayPath,
				marker: legacyFile.marker,
			},
		);
		assert.equal(
			loaded.module.parseFileReferencePayload(
				JSON.stringify({ ...file, uri: 42 }),
			),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});
