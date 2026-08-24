import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadScrollAnchor() {
	return loadBundledModule({
		entry: "webview/transcript/scrollAnchor.ts",
		name: "scroll-anchor",
		platform: "browser",
	});
}

/** A scroll container whose height and offset the test drives directly. */
function fakeViewport({ scrollHeight = 1000, clientHeight = 400 } = {}) {
	return { scrollTop: scrollHeight - clientHeight, scrollHeight, clientHeight };
}

test("a fresh anchor follows the bottom and pins on request", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		const anchor = new loaded.module.ScrollAnchor({ viewport });

		assert.equal(anchor.isFollowing, true);
		viewport.scrollHeight = 1200;
		assert.equal(anchor.stickToBottomIfFollowing(), true);
		assert.equal(viewport.scrollTop, 1200);
	} finally {
		await loaded.dispose();
	}
});

test("an upward gesture detaches before any scrolling happens", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		const anchor = new loaded.module.ScrollAnchor({ viewport });

		// The gesture that used to be undone by the next streaming frame: the
		// viewport is still exactly at the bottom, so a distance-based check alone
		// would keep following and pin the reader back down.
		anchor.noteUserIntent(-40);

		assert.equal(anchor.isFollowing, false);
		assert.equal(anchor.stickToBottomIfFollowing(), false);
		assert.equal(viewport.scrollTop, 600, "must not be pulled to the bottom");
	} finally {
		await loaded.dispose();
	}
});

test("downward gestures alone do not re-attach; reaching the bottom does", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		const anchor = new loaded.module.ScrollAnchor({ viewport });
		anchor.noteUserIntent(-40);
		viewport.scrollTop = 200;
		anchor.noteScroll();
		assert.equal(anchor.isFollowing, false);

		// Scrolling back down mid-flight is not enough: re-attaching early would
		// make the transcript jump ahead of the reader's own momentum.
		anchor.noteUserIntent(40);
		viewport.scrollTop = 500;
		anchor.noteScroll();
		assert.equal(anchor.isFollowing, false);

		viewport.scrollTop = 600;
		anchor.noteScroll();
		assert.equal(anchor.isFollowing, true);
	} finally {
		await loaded.dispose();
	}
});

test("a scrollbar drag detaches even though it fires no wheel event", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		const anchor = new loaded.module.ScrollAnchor({ viewport });

		viewport.scrollTop = 120;
		anchor.noteScroll();

		assert.equal(anchor.isFollowing, false);
	} finally {
		await loaded.dispose();
	}
});

test("our own bottom-pinning scroll is not mistaken for the reader's", async () => {
	const loaded = await loadScrollAnchor();
	try {
		// Bottom-pinning sets scrollTop to scrollHeight, which the browser clamps to
		// scrollHeight - clientHeight. That clamped value must still read as ours.
		const viewport = fakeViewport({ scrollHeight: 1000, clientHeight: 400 });
		const anchor = new loaded.module.ScrollAnchor({ viewport });
		anchor.stickToBottomIfFollowing();

		// Content arrives, so the same offset is now short of the bottom.
		viewport.scrollHeight = 1400;
		anchor.noteScroll();

		assert.equal(anchor.isFollowing, true);
	} finally {
		await loaded.dispose();
	}
});

test("follow() overrides a detached state for send and session switches", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		const anchor = new loaded.module.ScrollAnchor({ viewport });
		anchor.noteUserIntent(-100);
		assert.equal(anchor.isFollowing, false);

		anchor.follow();

		assert.equal(anchor.isFollowing, true);
		assert.equal(anchor.stickToBottomIfFollowing(), true);
	} finally {
		await loaded.dispose();
	}
});

test("the bottom threshold is tight enough that short drags still detach", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		const anchor = new loaded.module.ScrollAnchor({
			viewport,
			bottomThresholdPx: 4,
		});

		// A ~24px nudge upward, well inside the old 96px allowance that used to
		// snap the reader back to the bottom.
		viewport.scrollTop = 576;
		anchor.noteScroll();

		assert.equal(anchor.isFollowing, false);
	} finally {
		await loaded.dispose();
	}
});
