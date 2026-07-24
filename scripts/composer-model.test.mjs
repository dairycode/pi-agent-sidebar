import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadComposerModel() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-composer-model-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "composer-model.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "webview", "composerModel.ts")],
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

function summary(id, marker) {
	return {
		id,
		revision: 0,
		marker,
		displayPath: "src/example.ts",
		startLine: 1,
		endLine: 1,
	};
}

test("managed references preserve literals and distinguish same-line selections", async () => {
	const loaded = await loadComposerModel();
	try {
		const base = "@src/example.ts#1";
		let text = `literal ${base}`;
		let references = [];
		const first = loaded.module.insertManagedReference(
			text,
			text.length,
			summary("first", base),
			references,
		);
		text = first.text;
		references = first.references;
		const second = loaded.module.insertManagedReference(
			text,
			first.caret,
			summary("second", `${base}~second`),
			references,
		);
		text = second.text;
		references = second.references;

		assert.equal(references.length, 2);
		assert.equal(text.startsWith(`literal ${base}`), true);
		assert.equal(text.slice(references[0].start, references[0].end), base);
		assert.equal(
			text.slice(references[1].start, references[1].end),
			`${base}~second`,
		);

		const removed = loaded.module.removeManagedReferences(text, references, [
			{ id: "first", revision: 0 },
		]);
		assert.equal(removed.references.length, 1);
		assert.equal(removed.text.includes(`literal ${base}`), true);
		assert.equal(removed.text.includes(`${base}~second`), true);
	} finally {
		await loaded.dispose();
	}
});

test("composer edits shift intact spans and detach only an edited marker", async () => {
	const loaded = await loadComposerModel();
	try {
		const marker = "@src/example.ts#3";
		const inserted = loaded.module.insertManagedReference(
			"explain",
			0,
			summary("reference", marker),
			[],
		);
		const prefixed = `please ${inserted.text}`;
		const shifted = loaded.module.reconcileComposerEdit(
			inserted.text,
			prefixed,
			inserted.references,
		);
		assert.equal(shifted.removed.length, 0);
		assert.equal(shifted.references[0].start, inserted.references[0].start + 7);

		const reference = shifted.references[0];
		const edited = `${prefixed.slice(0, reference.start + 1)}x${prefixed.slice(reference.start + 1)}`;
		const detached = loaded.module.reconcileComposerEdit(
			prefixed,
			edited,
			shifted.references,
		);
		assert.equal(detached.references.length, 0);
		assert.equal(detached.removed[0].id, "reference");
	} finally {
		await loaded.dispose();
	}
});
