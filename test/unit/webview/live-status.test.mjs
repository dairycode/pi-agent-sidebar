import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadLiveStatus() {
	return loadBundledModule({
		entry: "webview/ui/liveStatus.ts",
		name: "live-status",
		platform: "browser",
	});
}

/** Hands out frames on demand so a test can decide what a frame boundary means. */
function createFrameQueue() {
	const callbacks = [];
	return {
		requestFrame(callback) {
			callbacks.push(callback);
			return callbacks.length;
		},
		run() {
			for (const callback of callbacks.splice(0)) callback(0);
		},
		get pending() {
			return callbacks.length;
		},
	};
}

test("sentences announced in one frame are read out together", async () => {
	const loaded = await loadLiveStatus();
	try {
		const { LiveStatusAnnouncer } = loaded.module;
		const frames = createFrameQueue();
		const region = { textContent: "" };
		const announcer = new LiveStatusAnnouncer({
			liveStatus: region,
			requestFrame: frames.requestFrame,
		});

		announcer.announce("Session renamed");
		announcer.announce("Pi is ready");
		// One fill per frame, and it carries both: a second fill would replace the
		// first, leaving a screen reader with only the last sentence.
		assert.equal(region.textContent, "");
		assert.equal(frames.pending, 1);
		frames.run();
		assert.equal(region.textContent, "Session renamed Pi is ready");
	} finally {
		await loaded.dispose();
	}
});

test("the region is emptied before it is filled, so a repeat is a change", async () => {
	const loaded = await loadLiveStatus();
	try {
		const { LiveStatusAnnouncer } = loaded.module;
		const frames = createFrameQueue();
		const region = { textContent: "" };
		const announcer = new LiveStatusAnnouncer({
			liveStatus: region,
			requestFrame: frames.requestFrame,
		});

		announcer.announce("Pi is ready");
		frames.run();
		assert.equal(region.textContent, "Pi is ready");
		announcer.announce("Pi is ready");
		assert.equal(region.textContent, "");
		frames.run();
		assert.equal(region.textContent, "Pi is ready");
	} finally {
		await loaded.dispose();
	}
});

test("an empty sentence is ignored", async () => {
	const loaded = await loadLiveStatus();
	try {
		const { LiveStatusAnnouncer } = loaded.module;
		const frames = createFrameQueue();
		const region = { textContent: "previous" };
		const announcer = new LiveStatusAnnouncer({
			liveStatus: region,
			requestFrame: frames.requestFrame,
		});

		announcer.announce("");
		assert.equal(region.textContent, "previous");
		assert.equal(frames.pending, 0);
	} finally {
		await loaded.dispose();
	}
});
