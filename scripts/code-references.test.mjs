import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadCodeReferences() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-code-reference-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "code-references.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "src", "codeReferences.ts")],
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

test("code reference ranges use inclusive display lines", async () => {
	const loaded = await loadCodeReferences();
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
			loaded.module.formatCodeReferenceLocation("src/example.ts", 5, 5),
			"src/example.ts:5",
		);
		assert.equal(
			loaded.module.formatCodeReferenceMarker("src/example.ts", 5, 7),
			"@src/example.ts#5-7",
		);
		assert.equal(
			loaded.module.uniqueCodeReferenceMarker(
				"@src/example.ts#5",
				"abcdef12-3456",
				new Set(["@src/example.ts#5"]),
			),
			"@src/example.ts#5~abcdef",
		);
		assert.equal(loaded.module.nearestOffset(50, 12, 58), 58);
		assert.equal(loaded.module.nearestOffset(50, -1, -1), -1);
	} finally {
		await loaded.dispose();
	}
});

test("code reference markers preserve and clean up composer text", async () => {
	const loaded = await loadCodeReferences();
	try {
		const marker = "@package.json#47-49";
		assert.deepEqual(
			loaded.module.insertCodeReferenceMarker("selected", 0, marker),
			{
				text: `${marker} selected`,
				caret: marker.length + 1,
				markerStart: 0,
				markerEnd: marker.length,
			},
		);
		assert.deepEqual(
			loaded.module.insertCodeReferenceMarker("explain this", 7, marker),
			{
				text: `explain ${marker} this`,
				caret: 8 + marker.length,
				markerStart: 8,
				markerEnd: 8 + marker.length,
			},
		);
		assert.equal(
			loaded.module.removeCodeReferenceMarker(
				`${marker} explain ${marker} please`,
				marker,
			),
			"explain please",
		);
		const shortMarker = "@foo.ts#1";
		assert.equal(
			loaded.module.findCodeReferenceMarker("@foo.ts#10", shortMarker),
			-1,
		);
		assert.equal(
			loaded.module.hasCodeReferenceMarker("@foo.ts#1-2", shortMarker),
			false,
		);
		assert.equal(
			loaded.module.removeCodeReferenceMarker("@foo.ts#10", shortMarker),
			"@foo.ts#10",
		);
		assert.equal(
			loaded.module.findCodeReferenceMarker(
				`before ${shortMarker} after`,
				shortMarker,
			),
			7,
		);
		assert.equal(
			loaded.module.removeCodeReferenceRanges(
				`literal ${marker} managed ${marker} tail`,
				[{ start: 8, end: 8 + marker.length }],
			),
			`literal managed ${marker} tail`,
		);
	} finally {
		await loaded.dispose();
	}
});

test("code reference payloads safely round-trip selected source", async () => {
	const loaded = await loadCodeReferences();
	try {
		const reference = {
			path: "/workspace/src/example.ts",
			displayPath: "src/example.ts",
			languageId: "typescript",
			startLine: 9,
			endLine: 10,
			text: "const marker = '</pi-context>';\nconsole.log(marker);\u2028\u2029",
		};
		const serialized = loaded.module.serializeCodeReferencePayload(reference);
		assert.equal(serialized.includes("</pi-context>"), false);
		assert.equal(serialized.includes("\u2028"), false);
		assert.equal(serialized.includes("\u2029"), false);
		assert.deepEqual(
			loaded.module.parseCodeReferencePayload(serialized),
			reference,
		);
		assert.equal(
			loaded.module.parseCodeReferencePayload('{"startLine": 0}'),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});
