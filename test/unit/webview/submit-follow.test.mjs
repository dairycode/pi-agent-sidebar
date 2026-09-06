import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadCoordinator() {
	return loadBundledModule({
		entry: "webview/transcript/submitFollow.ts",
		name: "submit-follow",
	});
}

test("user echo then composer shrink keeps the submit followed through both stages", async () => {
	const loaded = await loadCoordinator();
	try {
		let followCount = 0;
		const coordinator = new loaded.module.SubmitFollowCoordinator({
			onFollow: () => {
				followCount += 1;
			},
		});

		coordinator.start("action-1", "first\nsecond\nthird", 120);
		assert.equal(coordinator.noteUserMessage("first\nsecond\nthird"), true);
		assert.equal(followCount, 1);

		coordinator.settleAction("action-1", true, 44);
		assert.equal(followCount, 2);
		assert.equal(coordinator.noteComposerResize(), true);
		assert.equal(followCount, 3);

		assert.equal(coordinator.noteUserMessage("first\nsecond\nthird"), false);
		assert.equal(coordinator.noteComposerResize(), false);
		assert.equal(followCount, 3);
	} finally {
		await loaded.dispose();
	}
});

test("action result may shrink the composer before the user echo arrives", async () => {
	const loaded = await loadCoordinator();
	try {
		let followCount = 0;
		const coordinator = new loaded.module.SubmitFollowCoordinator({
			onFollow: () => {
				followCount += 1;
			},
		});

		coordinator.start("action-1", "submitted draft", 120);
		coordinator.settleAction("action-1", true, 44);
		assert.equal(coordinator.noteComposerResize(), true);
		assert.equal(followCount, 2);

		assert.equal(
			coordinator.noteUserMessage(
				'<pi-context>\n- file: "/tmp/a"\n</pi-context>\n\nsubmitted draft',
			),
			true,
		);
		assert.equal(followCount, 3);
		assert.equal(coordinator.noteUserMessage("submitted draft"), false);
	} finally {
		await loaded.dispose();
	}
});

test("single-line submits complete without waiting for a resize", async () => {
	const loaded = await loadCoordinator();
	try {
		let followCount = 0;
		const coordinator = new loaded.module.SubmitFollowCoordinator({
			onFollow: () => {
				followCount += 1;
			},
		});

		coordinator.start("action-1", "one line", 44);
		assert.equal(coordinator.noteUserMessage("one line"), true);
		coordinator.settleAction("action-1", true, 44);
		assert.equal(followCount, 2);
		assert.equal(coordinator.noteComposerResize(), false);
		assert.equal(coordinator.noteUserMessage("one line"), false);
	} finally {
		await loaded.dispose();
	}
});

test("reader cancellation and failed actions cannot reattach later", async () => {
	const loaded = await loadCoordinator();
	try {
		let followCount = 0;
		const coordinator = new loaded.module.SubmitFollowCoordinator({
			onFollow: () => {
				followCount += 1;
			},
		});

		coordinator.start("cancelled", "cancel me", 120);
		coordinator.cancelAll();
		assert.equal(coordinator.noteUserMessage("cancel me"), false);
		coordinator.settleAction("cancelled", true, 44);

		coordinator.start("failed", "failed draft", 120);
		coordinator.settleAction("failed", false, 44);
		assert.equal(coordinator.noteUserMessage("failed draft"), false);
		assert.equal(coordinator.noteComposerResize(), false);
		assert.equal(followCount, 0);
	} finally {
		await loaded.dispose();
	}
});

test("a new submit supersedes an older lock with no user echo", async () => {
	const loaded = await loadCoordinator();
	try {
		let followCount = 0;
		const coordinator = new loaded.module.SubmitFollowCoordinator({
			onFollow: () => {
				followCount += 1;
			},
		});

		coordinator.start("old-action", "same draft", 120);
		coordinator.start("new-action", "new draft", 120);
		assert.equal(coordinator.noteUserMessage("same draft"), false);
		assert.equal(coordinator.noteUserMessage("new draft"), true);
		coordinator.settleAction("old-action", true, 44);
		assert.equal(followCount, 1);
	} finally {
		await loaded.dispose();
	}
});

test("stale and unrelated user messages do not claim a submit follow", async () => {
	const loaded = await loadCoordinator();
	try {
		let now = 1_000;
		let followCount = 0;
		const coordinator = new loaded.module.SubmitFollowCoordinator({
			now: () => now,
			expiryMs: 100,
			onFollow: () => {
				followCount += 1;
			},
		});

		coordinator.start("action-1", "expected", 120);
		assert.equal(coordinator.noteUserMessage("another prompt"), false);
		now += 101;
		assert.equal(coordinator.noteUserMessage("expected"), false);
		coordinator.settleAction("action-1", true, 44);
		assert.equal(followCount, 0);
	} finally {
		await loaded.dispose();
	}
});
