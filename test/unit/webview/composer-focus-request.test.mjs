import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadFocusRequests() {
	return loadBundledModule({
		entry: "webview/composer/focusRequest.ts",
		name: "composer-focus-request",
		platform: "browser",
	});
}

function createInput() {
	return {
		disabled: false,
		isFocused: false,
		focusOptions: undefined,
		isFocusRefused: false,
		focus(options) {
			this.focusOptions = options;
			if (!this.isFocusRefused) this.isFocused = true;
		},
	};
}

function createHarness({ input = createInput() } = {}) {
	const frames = [];
	const focused = [];
	return {
		input,
		focused,
		requestFrame(callback) {
			frames.push(callback);
			return frames.length;
		},
		get pendingFrames() {
			return frames.length;
		},
		runFrame() {
			for (const callback of frames.splice(0)) callback(0);
		},
	};
}

test("a newer request is completed once and reported once", async () => {
	const loaded = await loadFocusRequests();
	try {
		const { ComposerFocusRequests } = loaded.module;
		const harness = createHarness();
		const requests = new ComposerFocusRequests({
			input: harness.input,
			isInputFocused: () => harness.input.isFocused,
			notifyFocused: (requestId) => harness.focused.push(requestId),
			requestFrame: harness.requestFrame,
		});

		assert.equal(requests.accept(1), "announce");
		requests.attempt();
		harness.runFrame();
		assert.deepEqual(harness.input.focusOptions, { preventScroll: true });
		assert.deepEqual(harness.focused, [1]);
		// The reply released the host, so the same id is stale from here on.
		assert.equal(requests.accept(1), undefined);
	} finally {
		await loaded.dispose();
	}
});

test("a duplicate id re-registers without announcing again", async () => {
	const loaded = await loadFocusRequests();
	try {
		const { ComposerFocusRequests } = loaded.module;
		const harness = createHarness();
		const requests = new ComposerFocusRequests({
			input: harness.input,
			isInputFocused: () => harness.input.isFocused,
			notifyFocused: (requestId) => harness.focused.push(requestId),
			requestFrame: harness.requestFrame,
		});

		assert.equal(requests.accept(4), "announce");
		assert.equal(requests.accept(4), "silent");
		assert.equal(requests.accept(3), undefined);
	} finally {
		await loaded.dispose();
	}
});

test("a disabled composer defers the attempt until it is enabled", async () => {
	const loaded = await loadFocusRequests();
	try {
		const { ComposerFocusRequests } = loaded.module;
		const harness = createHarness();
		const requests = new ComposerFocusRequests({
			input: harness.input,
			isInputFocused: () => harness.input.isFocused,
			notifyFocused: (requestId) => harness.focused.push(requestId),
			requestFrame: harness.requestFrame,
		});

		harness.input.disabled = true;
		requests.accept(1);
		requests.attempt();
		assert.equal(harness.pendingFrames, 0);
		assert.deepEqual(harness.focused, []);

		harness.input.disabled = false;
		requests.attempt();
		harness.runFrame();
		assert.deepEqual(harness.focused, [1]);
	} finally {
		await loaded.dispose();
	}
});

test("a request superseded before its frame runs completes only the newest", async () => {
	const loaded = await loadFocusRequests();
	try {
		const { ComposerFocusRequests } = loaded.module;
		const harness = createHarness();
		const requests = new ComposerFocusRequests({
			input: harness.input,
			isInputFocused: () => harness.input.isFocused,
			notifyFocused: (requestId) => harness.focused.push(requestId),
			requestFrame: harness.requestFrame,
		});

		requests.accept(1);
		requests.attempt();
		assert.equal(requests.accept(2), "announce");
		// The frame that was carrying id 1 re-arms for id 2 instead of answering
		// with a request the composer is no longer being focused for.
		harness.runFrame();
		assert.deepEqual(harness.focused, []);
		harness.runFrame();
		assert.deepEqual(harness.focused, [2]);
	} finally {
		await loaded.dispose();
	}
});

test("a refused focus leaves the request pending for the next attempt", async () => {
	const loaded = await loadFocusRequests();
	try {
		const { ComposerFocusRequests } = loaded.module;
		const harness = createHarness();
		const requests = new ComposerFocusRequests({
			input: harness.input,
			isInputFocused: () => harness.input.isFocused,
			notifyFocused: (requestId) => harness.focused.push(requestId),
			requestFrame: harness.requestFrame,
		});

		// The sidebar is hidden: `focus()` is called and does nothing.
		harness.input.isFocusRefused = true;
		requests.accept(1);
		requests.attempt();
		harness.runFrame();
		assert.deepEqual(harness.focused, []);

		// Same request, now that focus can land: the host still gets its reply.
		harness.input.isFocusRefused = false;
		requests.attempt();
		harness.runFrame();
		assert.deepEqual(harness.focused, [1]);
	} finally {
		await loaded.dispose();
	}
});
