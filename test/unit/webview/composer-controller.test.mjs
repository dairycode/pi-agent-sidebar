import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadComposerController() {
	return loadBundledModule({
		entry: "webview/composer/controller.ts",
		name: "composer-controller",
	});
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

test("staged file references are highlighted before the host adopts them", async () => {
	const loaded = await loadComposerController();
	try {
		const harness = createHarness(
			loaded.module.ComposerController,
			"inspect @src",
		);
		const pendingId = harness.controller.stageFileReference(
			"src/file.ts",
			8,
			12,
		);

		assert.equal(harness.editor.value, "inspect @src/file.ts ");
		assert.equal(harness.controller.references.length, 0);
		assert.equal(harness.controller.referenceCount, 1);
		assert.equal(harness.controller.hasPendingReferences, true);
		assert.equal(harness.controller.isPendingReference(pendingId), true);
		assert.equal(harness.controller.managedReferences().length, 1);
		assert.equal(harness.refreshes, 1);

		const stagedText = harness.editor.value;
		const changed = harness.controller.applyIncoming([fileReference()]);
		assert.equal(harness.editor.value, stagedText);
		assert.equal(harness.controller.references.length, 1);
		assert.equal(harness.controller.referenceCount, 1);
		assert.equal(harness.controller.hasPendingReferences, false);
		assert.equal(harness.controller.isPendingReference(pendingId), false);
		assert.equal(changed[0].start, "inspect ".length);
		assert.equal(changed[0].end, "inspect @src/file.ts".length);
	} finally {
		await loaded.dispose();
	}
});

test("staged directory references are highlighted before the host adopts them", async () => {
	const loaded = await loadComposerController();
	try {
		const harness = createHarness(
			loaded.module.ComposerController,
			"inspect @test/",
		);
		const pendingId = harness.controller.stageDirectoryReference("test", 8, 14);

		assert.equal(harness.editor.value, "inspect @test/ ");
		assert.equal(harness.controller.referenceCount, 1);
		assert.equal(harness.controller.isPendingReference(pendingId), true);
		assert.deepEqual(
			harness.controller.managedReferences().map((reference) => ({
				kind: reference.kind,
				marker: reference.marker,
				displayPath: reference.displayPath,
			})),
			[{ kind: "directory", marker: "@test/", displayPath: "test" }],
		);

		const stagedText = harness.editor.value;
		const changed = harness.controller.applyIncoming([
			{
				kind: "directory",
				id: "directory-reference",
				revision: 0,
				marker: "@test/",
				displayPath: "test",
			},
		]);
		assert.equal(harness.editor.value, stagedText);
		assert.equal(harness.controller.references[0].kind, "directory");
		assert.equal(harness.controller.hasPendingReferences, false);
		assert.equal(changed[0].start, "inspect ".length);
	} finally {
		await loaded.dispose();
	}
});

test("staged directory references preserve whitespace terminators and caret", async () => {
	const loaded = await loadComposerController();
	try {
		for (const terminator of [" ", "  ", "\t", "\n"]) {
			const initialText = `inspect @test/${terminator}`;
			const harness = createHarness(
				loaded.module.ComposerController,
				initialText,
			);
			const pendingId = harness.controller.stageDirectoryReference(
				"test",
				8,
				14,
			);

			assert.equal(harness.editor.value, initialText);
			assert.equal(harness.editor.selectionStart, initialText.length);
			assert.equal(harness.controller.isPendingReference(pendingId), true);
			assert.equal(
				harness.editor.value.slice("inspect @test/".length),
				terminator,
			);
		}
	} finally {
		await loaded.dispose();
	}
});

test("failed staged file references are removed cleanly", async () => {
	const loaded = await loadComposerController();
	try {
		const harness = createHarness(
			loaded.module.ComposerController,
			"inspect @src",
		);
		const pendingId = harness.controller.stageFileReference(
			"src/file.ts",
			8,
			12,
		);

		harness.controller.discardPendingReference(pendingId);
		assert.equal(harness.editor.value, "inspect ");
		assert.equal(harness.controller.referenceCount, 0);
		assert.equal(harness.controller.managedReferences().length, 0);
		assert.deepEqual(harness.posts, []);
	} finally {
		await loaded.dispose();
	}
});

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
