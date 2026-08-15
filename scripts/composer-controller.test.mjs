import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadComposerController() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-composer-controller-test-"),
	);
	const output = path.join(
		temporaryDirectory,
		"bundle",
		"composer-controller.mjs",
	);
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "webview", "composerController.ts")],
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

function createHarness(
	ComposerController,
	initialText = "",
	persistedReferences,
) {
	const posts = [];
	const announcements = [];
	const persisted = [];
	const pendingActions = [];
	let invalidations = 0;
	let refreshes = 0;
	let active = true;
	const editor = {
		value: initialText,
		selectionStart: initialText.length,
		focused: false,
		setSelectionRange(start) {
			this.selectionStart = start;
		},
		focus() {
			this.focused = true;
		},
	};
	const controller = new ComposerController(
		{
			editor,
			persist(draft, references) {
				persisted.push({
					draft,
					references: references.map((reference) => ({ ...reference })),
				});
			},
			post(message) {
				posts.push(message);
			},
			announce(message) {
				announcements.push(message);
			},
			invalidate() {
				invalidations += 1;
			},
			refreshEditorView() {
				refreshes += 1;
			},
			isEditorActive() {
				return active;
			},
			pendingActions() {
				return pendingActions;
			},
		},
		persistedReferences,
	);
	return {
		controller,
		editor,
		posts,
		announcements,
		persisted,
		pendingActions,
		get invalidations() {
			return invalidations;
		},
		get refreshes() {
			return refreshes;
		},
		setActive(value) {
			active = value;
		},
	};
}

function fileReference(revision = 0) {
	return {
		kind: "file",
		id: "file-reference",
		revision,
		marker: "@src/file.ts",
		displayPath: "src/file.ts",
	};
}

test("local marker removal suppresses stale host echoes", async () => {
	const loaded = await loadComposerController();
	try {
		const harness = createHarness(loaded.module.ComposerController);
		const reference = fileReference();
		harness.controller.applyIncoming([reference]);
		assert.equal(harness.editor.value, "@src/file.ts ");
		assert.equal(harness.controller.references.length, 1);

		harness.editor.value = "";
		harness.editor.selectionStart = 0;
		harness.controller.handleInput();
		assert.deepEqual(harness.posts, [
			{
				type: "removeComposerReference",
				id: reference.id,
				revision: reference.revision,
			},
		]);
		assert.deepEqual(harness.announcements, ["Removed src/file.ts"]);
		assert.equal(harness.controller.references.length, 0);

		assert.deepEqual(harness.controller.applyIncoming([reference]), []);
		assert.equal(harness.editor.value, "");
		assert.equal(harness.controller.references.length, 0);
	} finally {
		await loaded.dispose();
	}
});

test("editor changes keep pending reference snapshots aligned", async () => {
	const loaded = await loadComposerController();
	try {
		const harness = createHarness(loaded.module.ComposerController);
		harness.controller.applyIncoming([fileReference()]);
		const action = {
			type: "submit",
			draft: harness.editor.value,
			referenceSnapshots: harness.controller.snapshotReferences(),
		};
		harness.pendingActions.push(action);
		const original = action.referenceSnapshots[0];

		harness.editor.value = `prefix ${harness.editor.value}`;
		harness.editor.selectionStart = harness.editor.value.length;
		harness.controller.handleInput();

		assert.equal(action.referenceSnapshots.length, 1);
		assert.equal(
			action.referenceSnapshots[0].start,
			original.start + "prefix ".length,
		);
		assert.equal(
			action.referenceSnapshots[0].end,
			original.end + "prefix ".length,
		);
		assert.equal(harness.controller.references[0].start, original.start + 7);
	} finally {
		await loaded.dispose();
	}
});

test("successful completion preserves edits made while submit was pending", async () => {
	const loaded = await loadComposerController();
	try {
		const harness = createHarness(loaded.module.ComposerController);
		harness.controller.applyIncoming([fileReference()]);
		const action = {
			type: "submit",
			draft: harness.editor.value,
			referenceSnapshots: harness.controller.snapshotReferences(),
		};
		harness.pendingActions.push(action);

		harness.editor.value = `${harness.editor.value}keep this edit`;
		harness.editor.selectionStart = harness.editor.value.length;
		harness.controller.handleInput();
		harness.pendingActions.splice(0, 1);
		harness.controller.completeSubmittedReferences(action);

		assert.equal(harness.editor.value, "keep this edit");
		assert.equal(harness.controller.references.length, 0);
		assert.ok(harness.refreshes > 0);
		assert.equal(harness.persisted.at(-1).draft, "keep this edit");
	} finally {
		await loaded.dispose();
	}
});

test("setText retains active reference identities and focuses the editor", async () => {
	const loaded = await loadComposerController();
	try {
		const harness = createHarness(loaded.module.ComposerController, "draft");
		harness.controller.applyIncoming([fileReference()]);
		harness.controller.setText("Explain this file");

		assert.equal(harness.editor.focused, true);
		assert.match(harness.editor.value, /^Explain this file @src\/file\.ts /u);
		assert.equal(harness.controller.references.length, 1);
		assert.equal(harness.persisted.at(-1).draft, harness.editor.value);
	} finally {
		await loaded.dispose();
	}
});
