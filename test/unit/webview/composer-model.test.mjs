import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";


async function loadComposerModel() {
	return loadBundledModule({
		entry: "webview/composer/model.ts",
		name: "composer-model",
	});
}

function summary(id, marker) {
	return {
		kind: "selection",
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

test("file references persist without selection-only fields", async () => {
	const loaded = await loadComposerModel();
	try {
		const reference = {
			kind: "file",
			id: "file-reference",
			revision: 0,
			marker: "@src/example.ts",
			displayPath: "src/example.ts",
		};
		const inserted = loaded.module.insertManagedReference(
			"inspect",
			0,
			reference,
			[],
		);
		assert.deepEqual(
			loaded.module.parsePersistedReferences(
				inserted.references,
				inserted.text,
			),
			inserted.references,
		);
	} finally {
		await loaded.dispose();
	}
});
