import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadProgressiveWindow() {
	return loadBundledModule({
		entry: "webview/transcript/progressiveWindow.ts",
		name: "progressive-window",
	});
}

const make = (loaded) =>
	new loaded.module.ProgressiveWindow({
		threshold: 60,
		initial: 40,
		chunk: 40,
	});

const range = (n) => Array.from({ length: n }, (_, i) => i);

test("a window at or below the threshold builds in one pass", async () => {
	const loaded = await loadProgressiveWindow();
	try {
		const progressive = make(loaded);
		const items = range(50);
		assert.equal(progressive.window(items, true), items);
		assert.equal(progressive.window(items, false), items);
	} finally {
		await loaded.dispose();
	}
});

test("a fresh build stages the tail, then backfill widens to everything", async () => {
	const loaded = await loadProgressiveWindow();
	try {
		const progressive = make(loaded);
		const items = range(150);
		// First pass: the reader lands on the newest 40.
		let staged = progressive.window(items, true);
		assert.deepEqual(staged, items.slice(-40));
		// Backfill passes widen the suffix one chunk at a time...
		staged = progressive.window(items, false);
		assert.deepEqual(staged, items.slice(-80));
		staged = progressive.window(items, false);
		assert.deepEqual(staged, items.slice(-120));
		// ...and the pass that covers the window ends the staging.
		staged = progressive.window(items, false);
		assert.equal(staged, items);
		assert.equal(progressive.window(items, false), items);
	} finally {
		await loaded.dispose();
	}
});

test("a fresh build rearms staging mid-backfill", async () => {
	const loaded = await loadProgressiveWindow();
	try {
		const progressive = make(loaded);
		const items = range(150);
		progressive.window(items, true);
		// A session switch cleared the view mid-backfill: the next build is
		// fresh again, and staging restarts from the initial window.
		const staged = progressive.window(items, true);
		assert.deepEqual(staged, items.slice(-40));
	} finally {
		await loaded.dispose();
	}
});

test("messages arriving during backfill keep the window a suffix", async () => {
	const loaded = await loadProgressiveWindow();
	try {
		const progressive = make(loaded);
		let items = range(150);
		progressive.window(items, true);
		// A new message lands mid-backfill: the window is still a suffix, so
		// backfill keeps inserting above the fold, never under the reader.
		items = [...items, 150];
		const staged = progressive.window(items, false);
		assert.deepEqual(staged, items.slice(-80));
		assert.equal(staged[staged.length - 1], 150);
	} finally {
		await loaded.dispose();
	}
});
