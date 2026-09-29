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

/**
 * The rule for recognising a prompt's echo is shared with the snapshot recovery
 * in `main.ts`: both have to agree on what a submitted prompt looks like once pi
 * has wrapped it, or one of them silently stops matching.
 */
/**
 * The snapshot recovery has to recognise an accepted prompt without accepting a
 * repeat of one: `clearUnansweredSubmit` unlocks the composer on a true, so a
 * false positive here shows the reader a sent prompt that pi never took.
 */
test("a snapshot acknowledges the submit only through its own newest prompt", async () => {
	const loaded = await loadCoordinator();
	try {
		const { snapshotAcknowledgesSubmit } = loaded.module;
		const submittedAtMs = Date.parse("2026-03-04T05:00:00.000Z");
		const base = { draft: "make it faster", submittedAtMs, clockSkewMs: 0 };
		const user = (text, timestamp) => ({
			role: "user",
			content: [{ type: "text", text }],
			timestamp,
		});
		const assistant = (text, timestamp) => ({
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp,
		});

		// The acceptance: pi appended the wrapped prompt, then answered it.
		assert.equal(
			snapshotAcknowledgesSubmit(
				[
					user(
						"<pi-context>file.ts</pi-context>\n\nmake it faster",
						submittedAtMs + 200,
					),
					assistant("on it", submittedAtMs + 900),
				],
				base,
			),
			true,
		);

		// The reader asked the same thing earlier in the session. That echo is not this
		// submit's acceptance, which the timestamp is what separates.
		assert.equal(
			snapshotAcknowledgesSubmit(
				[user("make it faster", submittedAtMs - 300_000)],
				base,
			),
			false,
		);

		// A newer prompt that is not this draft means pi took something else.
		assert.equal(
			snapshotAcknowledgesSubmit(
				[
					user("make it faster", submittedAtMs - 1_000),
					user("actually, revert that", submittedAtMs + 500),
				],
				base,
			),
			false,
		);

		// Nothing to match, an unreadable timestamp, and a stamp outside the tolerance
		// are all "not proven" rather than "refused".
		assert.equal(
			snapshotAcknowledgesSubmit([assistant("hello", submittedAtMs + 10)], base),
			false,
		);
		assert.equal(snapshotAcknowledgesSubmit([], base), false);
		assert.equal(
			snapshotAcknowledgesSubmit([user("make it faster", undefined)], base),
			false,
		);
		assert.equal(
			snapshotAcknowledgesSubmit(
				[user("make it faster", submittedAtMs - 120_000)],
				base,
			),
			false,
		);

		// The comparison is on pi's clock: a host five minutes ahead still recognises
		// its own timestamp.
		assert.equal(
			snapshotAcknowledgesSubmit(
				[user("make it faster", submittedAtMs + 300_000)],
				{ ...base, clockSkewMs: 300_000 },
			),
			true,
		);
	} finally {
		await loaded.dispose();
	}
});

/**
 * The rule for recognising a prompt's echo is shared with the snapshot recovery
 * in `main.ts`: both have to agree on what a submitted prompt looks like once pi
 * has wrapped it, or one of them silently stops matching.
 */
test("a submitted draft matches its own echo and nothing else", async () => {
	const loaded = await loadCoordinator();
	try {
		const { matchesSubmittedDraft } = loaded.module;
		assert.equal(matchesSubmittedDraft("plain prompt", "plain prompt"), true);
		// pi-context and reference blocks are prepended, separated by a blank line.
		assert.equal(
			matchesSubmittedDraft(
				"<pi-context>file.ts</pi-context>\n\nplain prompt",
				"plain prompt",
			),
			true,
		);
		assert.equal(matchesSubmittedDraft("plain prompt!", "plain prompt"), false);
		assert.equal(
			matchesSubmittedDraft("prefix plain prompt", "plain prompt"),
			false,
		);
		assert.equal(matchesSubmittedDraft("plain", "plain prompt"), false);
	} finally {
		await loaded.dispose();
	}
});
