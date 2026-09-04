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

test("streaming growth is eased into the latest bottom position", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		let nextHandle = 0;
		let nextFrame;
		const anchor = new loaded.module.ScrollAnchor({
			viewport,
			requestFrame: (callback) => {
				nextHandle += 1;
				nextFrame = callback;
				return nextHandle;
			},
			cancelFrame: () => {
				nextFrame = undefined;
			},
		});
		const runFrame = (timestamp) => {
			const callback = nextFrame;
			nextFrame = undefined;
			assert.ok(callback, "an animation frame should be pending");
			callback(timestamp);
		};

		viewport.scrollHeight = 1200;
		anchor.stickToBottomIfFollowing();
		assert.equal(viewport.scrollTop, 600, "the first update must not jump");
		runFrame(0);
		assert.ok(viewport.scrollTop > 600 && viewport.scrollTop < 800);

		const positionBeforeRetarget = viewport.scrollTop;
		viewport.scrollHeight = 1400;
		anchor.stickToBottomIfFollowing();
		assert.equal(
			viewport.scrollTop,
			positionBeforeRetarget,
			"a streaming update should retarget the current animation",
		);

		let frame = 1;
		while (nextFrame && frame <= 120) {
			runFrame(frame * (1000 / 60));
			frame += 1;
		}
		assert.equal(nextFrame, undefined, "the animation should settle");
		assert.ok(Math.abs(viewport.scrollTop - 1000) <= 0.5);
	} finally {
		await loaded.dispose();
	}
});

test("a delayed animation scroll cannot undo a newer upward gesture", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport({ scrollHeight: 1020 });
		let nextHandle = 0;
		let nextFrame;
		const anchor = new loaded.module.ScrollAnchor({
			viewport,
			requestFrame: (callback) => {
				nextHandle += 1;
				nextFrame = callback;
				return nextHandle;
			},
			cancelFrame: () => {
				nextFrame = undefined;
			},
		});
		const runFrame = (timestamp) => {
			const callback = nextFrame;
			nextFrame = undefined;
			assert.ok(callback, "an animation frame should be pending");
			callback(timestamp);
		};

		viewport.scrollTop = 600;
		anchor.stickToBottomIfFollowing();
		runFrame(0);
		anchor.noteScroll();
		runFrame(1000 / 60);

		// The second assignment's scroll event has not arrived yet when the reader
		// starts moving up. Its delayed event must remain classified as ours.
		anchor.noteUserIntent(-40);
		assert.equal(anchor.isFollowing, false);
		anchor.noteScroll();
		assert.equal(
			anchor.isFollowing,
			false,
			"the delayed programmatic event must not re-attach",
		);
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

test("a downward scroll into the attach window re-attaches before the strict line", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		const anchor = new loaded.module.ScrollAnchor({ viewport });
		anchor.noteUserIntent(-40);
		assert.equal(anchor.isFollowing, false);

		// The last inertial tick of a return-to-bottom can land a few pixels
		// short of the strict 4px line while streaming keeps growing the content;
		// with no further scroll event arriving, that state would stick forever.
		// A scroll still moving towards the bottom inside the attach window is
		// the next tick of the same gesture, so it re-attaches.
		viewport.scrollTop = 576; // 24px above the bottom: unknown direction
		anchor.noteScroll();
		assert.equal(
			anchor.isFollowing,
			false,
			"the first observed scroll must be conservative",
		);

		viewport.scrollTop = 580; // 20px above the bottom, moving downwards
		anchor.noteScroll();
		assert.equal(
			anchor.isFollowing,
			true,
			"a downward scroll into the window re-attaches",
		);
	} finally {
		await loaded.dispose();
	}
});

test("overflow anchoring inside the attach window stays detached", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		const anchor = new loaded.module.ScrollAnchor({ viewport });
		anchor.noteUserIntent(-40);
		viewport.scrollTop = 576;
		anchor.noteScroll();
		assert.equal(anchor.isFollowing, false);

		// Content inserted above the viewport increases both values equally. The
		// reader did not move closer to the bottom even though scrollTop increased.
		viewport.scrollHeight += 100;
		viewport.scrollTop += 100;
		anchor.noteScroll();
		assert.equal(
			anchor.isFollowing,
			false,
			"layout anchoring must not be mistaken for a downward gesture",
		);
	} finally {
		await loaded.dispose();
	}
});

test("an upward scroll through the attach window stays detached", async () => {
	const loaded = await loadScrollAnchor();
	try {
		const viewport = fakeViewport();
		const anchor = new loaded.module.ScrollAnchor({ viewport });
		anchor.noteUserIntent(-200);
		viewport.scrollTop = 585; // 15px above the bottom, inside the window
		anchor.noteScroll();
		assert.equal(anchor.isFollowing, false);

		// Moving away from the bottom must never re-attach, however close to it:
		// this is the short-upward-drag case that a generous threshold used to
		// snap back to the bottom.
		viewport.scrollTop = 580; // 20px above the bottom, moving upwards
		anchor.noteScroll();
		assert.equal(
			anchor.isFollowing,
			false,
			"moving away from the bottom must not re-attach",
		);
	} finally {
		await loaded.dispose();
	}
});
