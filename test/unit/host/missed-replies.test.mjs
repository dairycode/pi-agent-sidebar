import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

/**
 * The queue exists because the editor refuses to deliver messages to a hidden
 * view even with `retainContextWhenHidden` set, and the webview cannot tell a
 * refused reply from one still in flight. What it holds therefore has to be
 * exactly the replies the webview cannot ask for again: too narrow and the
 * composer's submit latch never clears, too wide and a stale answer is replayed
 * over newer state.
 */
async function loadMissedReplies() {
	return loadBundledModule({
		entry: "src/provider/missedReplies.ts",
		name: "missed-replies",
	});
}

test("only replies the webview cannot re-request are queued", async () => {
	const loaded = await loadMissedReplies();
	try {
		const { isReplayableReply } = loaded.module;
		assert.equal(
			isReplayableReply({ type: "actionResult", actionId: "a", ok: true }),
			true,
		);
		assert.equal(
			isReplayableReply({ type: "mediaResolved", requestId: 1, resolved: [] }),
			true,
		);
		// Every one of these can be asked for again by reopening the panel that
		// asked, and a snapshot is rebuilt on reveal anyway.
		for (const message of [
			{ type: "sessionList", sessions: [] },
			{ type: "commandList", commands: [] },
			{ type: "forkCandidates", candidates: [] },
			{ type: "workspaceFileList", requestId: 1, query: "", entries: [] },
			{ type: "attachments", attachments: [] },
			{ type: "rpcEvent", event: {} },
			{ type: "connection", phase: "ready" },
		]) {
			assert.equal(isReplayableReply(message), false, message.type);
		}
	} finally {
		await loaded.dispose();
	}
});

test("the queue replays in order and drains empty", async () => {
	const loaded = await loadMissedReplies();
	try {
		const { MissedReplyQueue } = loaded.module;
		const queue = new MissedReplyQueue();
		assert.deepEqual(queue.drain(), []);

		const first = { type: "actionResult", actionId: "one", ok: true };
		const second = { type: "mediaResolved", requestId: 2, resolved: [] };
		assert.equal(queue.push(first), undefined);
		assert.equal(queue.push(second), undefined);
		assert.deepEqual(queue.drain(), [first, second]);
		// Draining takes everything: a second drain must not replay them again.
		assert.deepEqual(queue.drain(), []);
	} finally {
		await loaded.dispose();
	}
});

test("the queue is bounded and reports the reply it drops", async () => {
	const loaded = await loadMissedReplies();
	try {
		const { MAX_MISSED_REPLIES, MissedReplyQueue } = loaded.module;
		const queue = new MissedReplyQueue();
		const replies = Array.from({ length: MAX_MISSED_REPLIES }, (_, index) => ({
			type: "actionResult",
			actionId: `action-${index}`,
			ok: true,
		}));
		for (const reply of replies) {
			assert.equal(queue.push(reply), undefined);
		}

		// One past the cap drops the oldest, which is the answer a visible webview is
		// least likely to still be waiting for.
		const newest = { type: "actionResult", actionId: "overflow", ok: true };
		assert.deepEqual(queue.push(newest), replies[0]);
		const drained = queue.drain();
		assert.equal(drained.length, MAX_MISSED_REPLIES);
		assert.equal(drained.at(-1), newest);
		assert.equal(drained[0], replies[1]);
	} finally {
		await loaded.dispose();
	}
});
