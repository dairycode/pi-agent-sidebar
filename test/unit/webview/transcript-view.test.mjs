import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadTranscriptView() {
	return loadBundledModule({
		entry: "webview/transcript/transcriptView.ts",
		name: "transcript-view",
		platform: "browser",
	});
}

/**
 * A minimal ordered child list standing in for the messages container, plus a
 * log of every node built so tests can assert on what was *not* rebuilt.
 */
function harness(TranscriptView) {
	const children = [];
	const built = [];
	const view = new TranscriptView({
		container: {
			insertBefore(node, reference) {
				const existing = children.indexOf(node);
				if (existing >= 0) children.splice(existing, 1);
				const at =
					reference === null ? children.length : children.indexOf(reference);
				children.splice(at < 0 ? children.length : at, 0, node);
			},
			removeChild(node) {
				const at = children.indexOf(node);
				if (at >= 0) children.splice(at, 1);
			},
		},
		createNode(entry, previous) {
			built.push({ key: entry.key, replaced: previous?.id });
			return { id: `${entry.key}@${entry.signature}`, key: entry.key };
		},
	});
	return {
		view,
		built,
		keys: () => children.map((node) => node.key),
		ids: () => children.map((node) => node.id),
	};
}

function entry(key, signature) {
	return { key, signature };
}

test("a first pass builds every entry in order", async () => {
	const loaded = await loadTranscriptView();
	try {
		const { view, built, keys } = harness(loaded.module.TranscriptView);

		const stats = view.update([entry("a", "1"), entry("b", "1")]);

		assert.deepEqual(keys(), ["a", "b"]);
		assert.deepEqual(
			built.map((record) => record.key),
			["a", "b"],
		);
		assert.equal(stats.created, 2);
		assert.equal(stats.reused, 0);
	} finally {
		await loaded.dispose();
	}
});

test("only the changed entry is rebuilt", async () => {
	const loaded = await loadTranscriptView();
	try {
		const { view, built, ids } = harness(loaded.module.TranscriptView);
		view.update([entry("a", "1"), entry("b", "1")]);
		const before = ids();
		built.length = 0;

		// The streaming case: the last message grows, history does not change.
		const stats = view.update([entry("a", "1"), entry("b", "2")]);

		assert.deepEqual(
			built.map((record) => record.key),
			["b"],
			"history must not be rebuilt",
		);
		assert.equal(stats.created, 1);
		assert.equal(stats.reused, 1);
		assert.equal(ids()[0], before[0], "the reused node must be the same object");
		assert.equal(ids()[1], "b@2");
	} finally {
		await loaded.dispose();
	}
});

test("appending a message leaves existing nodes untouched", async () => {
	const loaded = await loadTranscriptView();
	try {
		const { view, built, keys, ids } = harness(loaded.module.TranscriptView);
		view.update([entry("a", "1"), entry("b", "1")]);
		const before = ids();
		built.length = 0;

		const stats = view.update([
			entry("a", "1"),
			entry("b", "1"),
			entry("c", "1"),
		]);

		assert.deepEqual(keys(), ["a", "b", "c"]);
		assert.deepEqual(
			built.map((record) => record.key),
			["c"],
		);
		assert.equal(stats.reused, 2);
		assert.equal(stats.moved, 0, "an append must not move existing nodes");
		assert.deepEqual(ids().slice(0, 2), before);
	} finally {
		await loaded.dispose();
	}
});

test("dropped entries are removed and the rest keep their nodes", async () => {
	const loaded = await loadTranscriptView();
	try {
		const { view, built, keys, ids } = harness(loaded.module.TranscriptView);
		view.update([entry("a", "1"), entry("b", "1"), entry("c", "1")]);
		const beforeC = ids()[2];
		built.length = 0;

		// History scrolling past the render cap drops the oldest entry.
		const stats = view.update([entry("b", "1"), entry("c", "1")]);

		assert.deepEqual(keys(), ["b", "c"]);
		assert.equal(stats.removed, 1);
		assert.equal(stats.created, 0, "surviving messages must not be rebuilt");
		assert.equal(ids()[1], beforeC);
	} finally {
		await loaded.dispose();
	}
});

test("a rebuilt node is offered the node it replaces", async () => {
	const loaded = await loadTranscriptView();
	try {
		const { view, built } = harness(loaded.module.TranscriptView);
		view.update([entry("a", "1")]);
		const previousId = "a@1";
		built.length = 0;

		view.update([entry("a", "2")]);

		// This is how DOM-only state (an opened tool disclosure) survives a rebuild.
		assert.deepEqual(built, [{ key: "a", replaced: previousId }]);
	} finally {
		await loaded.dispose();
	}
});

test("reordered entries are moved rather than rebuilt", async () => {
	const loaded = await loadTranscriptView();
	try {
		const { view, built, keys } = harness(loaded.module.TranscriptView);
		view.update([entry("a", "1"), entry("b", "1")]);
		built.length = 0;

		const stats = view.update([entry("b", "1"), entry("a", "1")]);

		assert.deepEqual(keys(), ["b", "a"]);
		assert.equal(stats.created, 0);
		assert.equal(stats.reused, 2);
		assert.deepEqual(built, []);
	} finally {
		await loaded.dispose();
	}
});

test("clear() detaches everything so a new session starts empty", async () => {
	const loaded = await loadTranscriptView();
	try {
		const { view, keys, built } = harness(loaded.module.TranscriptView);
		view.update([entry("a", "1"), entry("b", "1")]);
		built.length = 0;

		view.clear();
		assert.deepEqual(keys(), []);

		const stats = view.update([entry("a", "1")]);
		assert.equal(stats.created, 1, "nothing may be reused across a clear");
		assert.deepEqual(keys(), ["a"]);
	} finally {
		await loaded.dispose();
	}
});

test("nodeFor exposes the live node and forgets removed keys", async () => {
	const loaded = await loadTranscriptView();
	try {
		const { view } = harness(loaded.module.TranscriptView);
		view.update([entry("a", "1")]);
		assert.equal(view.nodeFor("a")?.id, "a@1");

		view.update([]);
		assert.equal(view.nodeFor("a"), undefined);
	} finally {
		await loaded.dispose();
	}
});
