import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadFrameCoordinator() {
	return loadBundledModule({
		entry: "webview/ui/frameCoordinator.ts",
		name: "frame-coordinator",
		platform: "browser",
	});
}

function frameHarness(
	module,
	render,
	measure = () => {},
	advance,
	renderAdvance,
) {
	let nextNativeHandle = 0;
	let nativeFrame;
	const coordinator = new module.FrameCoordinator({
		requestFrame: (callback) => {
			nextNativeHandle += 1;
			nativeFrame = callback;
			return nextNativeHandle;
		},
		cancelFrame: () => {
			nativeFrame = undefined;
		},
		measure,
		advance,
		render,
		renderAdvance,
	});
	return {
		coordinator,
		runFrame(timestamp = 0) {
			const callback = nativeFrame;
			nativeFrame = undefined;
			assert.ok(callback, "a native animation frame should be pending");
			callback(timestamp);
		},
		hasFrame: () => nativeFrame !== undefined,
	};
}

test("measurement runs before render and an already queued scroll step", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		const harness = frameHarness(
			loaded.module,
			() => order.push("render"),
			() => order.push("measure"),
		);
		harness.coordinator.requestScrollFrame(() => order.push("scroll"));
		harness.coordinator.scheduleRender();
		harness.coordinator.scheduleMeasure();

		harness.runFrame();

		assert.deepEqual(order, ["measure", "render", "scroll"]);
		assert.equal(harness.hasFrame(), false);
	} finally {
		await loaded.dispose();
	}
});

test("measurement requested by render waits for the next frame", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		let coordinator;
		const harness = frameHarness(
			loaded.module,
			() => {
				order.push("render");
				coordinator.scheduleMeasure();
			},
			() => order.push("measure"),
		);
		coordinator = harness.coordinator;
		coordinator.scheduleRender();

		harness.runFrame(0);
		assert.deepEqual(order, ["render"]);
		assert.equal(harness.hasFrame(), true);

		harness.runFrame(1000 / 60);
		assert.deepEqual(order, ["render", "measure"]);
	} finally {
		await loaded.dispose();
	}
});

test("playback advances between measurement and render before scrolling", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		const harness = frameHarness(
			loaded.module,
			() => order.push("render"),
			() => order.push("measure"),
			(timestamp) => {
				order.push(`advance:${timestamp}`);
				return false;
			},
		);
		harness.coordinator.requestScrollFrame(() => order.push("scroll"));
		harness.coordinator.scheduleMeasure();
		harness.coordinator.scheduleAdvance();

		harness.runFrame(42);

		assert.deepEqual(order, ["measure", "advance:42", "render", "scroll"]);
		assert.equal(harness.hasFrame(), false);
	} finally {
		await loaded.dispose();
	}
});

test("playback keeps scheduling lightweight frames only while work remains", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		let advances = 0;
		const harness = frameHarness(
			loaded.module,
			() => order.push("full-render"),
			undefined,
			() => {
				advances += 1;
				order.push(`advance:${advances}`);
				return advances < 2;
			},
			() => order.push("stream-render"),
		);
		harness.coordinator.scheduleAdvance();

		harness.runFrame(0);
		assert.deepEqual(order, ["advance:1", "stream-render"]);
		assert.equal(harness.hasFrame(), true);

		harness.runFrame(1000 / 60);
		assert.deepEqual(order, [
			"advance:1",
			"stream-render",
			"advance:2",
			"stream-render",
		]);
		assert.equal(harness.hasFrame(), false);
	} finally {
		await loaded.dispose();
	}
});

test("a full render supersedes the lightweight playback render", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		const harness = frameHarness(
			loaded.module,
			() => order.push("full-render"),
			undefined,
			() => {
				order.push("advance");
				return false;
			},
			() => order.push("stream-render"),
		);
		harness.coordinator.scheduleAdvance();
		harness.coordinator.scheduleRender();

		harness.runFrame();

		assert.deepEqual(order, ["advance", "full-render"]);
	} finally {
		await loaded.dispose();
	}
});

test("tool transcript updates coalesce into one lightweight render", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		const harness = frameHarness(
			loaded.module,
			() => order.push("full-render"),
			undefined,
			undefined,
			() => order.push("transcript-render"),
		);
		harness.coordinator.scheduleTranscriptRender();
		harness.coordinator.scheduleTranscriptRender();

		harness.runFrame();

		assert.deepEqual(order, ["transcript-render"]);
		assert.equal(harness.hasFrame(), false);
	} finally {
		await loaded.dispose();
	}
});

test("a full render supersedes a queued tool transcript render", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		const harness = frameHarness(
			loaded.module,
			() => order.push("full-render"),
			undefined,
			undefined,
			() => order.push("transcript-render"),
		);
		harness.coordinator.scheduleTranscriptRender();
		harness.coordinator.scheduleRender();

		harness.runFrame();

		assert.deepEqual(order, ["full-render"]);
	} finally {
		await loaded.dispose();
	}
});

test("render runs before an already queued scroll step", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		const harness = frameHarness(loaded.module, () => order.push("render"));
		harness.coordinator.requestScrollFrame(() => order.push("scroll"));
		harness.coordinator.scheduleRender();

		harness.runFrame();

		assert.deepEqual(order, ["render", "scroll"]);
		assert.equal(harness.hasFrame(), false);
	} finally {
		await loaded.dispose();
	}
});

test("a scroll step requested by render waits for the next frame", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		let coordinator;
		const harness = frameHarness(loaded.module, () => {
			order.push("render");
			coordinator.requestScrollFrame(() => order.push("new-scroll"));
		});
		coordinator = harness.coordinator;
		coordinator.scheduleRender();

		harness.runFrame(0);
		assert.deepEqual(order, ["render"]);
		assert.equal(harness.hasFrame(), true);

		harness.runFrame(1000 / 60);
		assert.deepEqual(order, ["render", "new-scroll"]);
	} finally {
		await loaded.dispose();
	}
});

test("cancelling the only pending scroll cancels its native frame", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const harness = frameHarness(loaded.module, () => {});
		const handle = harness.coordinator.requestScrollFrame(() => {});
		assert.equal(harness.hasFrame(), true);

		harness.coordinator.cancelScrollFrame(handle);

		assert.equal(harness.hasFrame(), false);
	} finally {
		await loaded.dispose();
	}
});

test("render can cancel the scroll step captured for the same frame", async () => {
	const loaded = await loadFrameCoordinator();
	try {
		const order = [];
		let coordinator;
		let scrollHandle;
		const harness = frameHarness(loaded.module, () => {
			order.push("render");
			coordinator.cancelScrollFrame(scrollHandle);
		});
		coordinator = harness.coordinator;
		scrollHandle = coordinator.requestScrollFrame(() => order.push("scroll"));
		coordinator.scheduleRender();

		harness.runFrame();

		assert.deepEqual(order, ["render"]);
		assert.equal(harness.hasFrame(), false);
	} finally {
		await loaded.dispose();
	}
});
