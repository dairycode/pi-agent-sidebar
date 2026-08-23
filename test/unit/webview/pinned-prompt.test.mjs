import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadPinnedPrompt() {
	return loadBundledModule({
		entry: "webview/transcript/pinnedPrompt.ts",
		name: "pinned-prompt",
		platform: "browser",
	});
}

/** A rendered `.user-message` whose vertical position the test controls. */
function fakePrompt(text, { top, bottom }, chips = []) {
	const scrolled = [];
	return {
		scrolled,
		getBoundingClientRect: () => ({ top, bottom }),
		querySelector(selector) {
			if (selector !== ".user-message-text") return null;
			return {
				textContent: text,
				cloneNode() {
					return {
						childNodes: [`clone:${text}`],
						querySelectorAll(chipSelector) {
							assert.equal(
								chipSelector,
								"[data-resource-uri], [data-workspace-path]",
							);
							return chips;
						},
					};
				},
			};
		},
		scrollIntoView(options) {
			scrolled.push(options);
		},
	};
}

function harness(PinnedPromptController, prompts, { textWidths } = {}) {
	const row = {
		hidden: true,
		className: "",
		classList: {
			toggle(name, force) {
				const values = new Set(row.className.split(/\s+/u).filter(Boolean));
				if (force) values.add(name);
				else values.delete(name);
				row.className = [...values].join(" ");
			},
			contains: (name) => row.className.split(/\s+/u).includes(name),
		},
	};
	const text = {
		children: [],
		scrollWidth: textWidths?.scrollWidth ?? 100,
		clientWidth: textWidths?.clientWidth ?? 100,
		replaceChildren(...nodes) {
			this.children = nodes;
		},
	};
	const toggle = {
		hidden: false,
		title: "",
		attributes: new Map(),
		setAttribute(name, value) {
			this.attributes.set(name, value);
		},
	};
	let promptList = prompts;
	const controller = new PinnedPromptController({
		// The viewport's top edge is 0, so a prompt is "past" it once its bottom
		// is negative (allowing for the small tolerance).
		viewport: { getBoundingClientRect: () => ({ top: 0, bottom: 600 }) },
		prompts: () => promptList,
		row,
		text,
		toggle,
	});
	return {
		controller,
		row,
		text,
		toggle,
		setPrompts(next) {
			promptList = next;
		},
	};
}

test("no turn is labelled while the viewport sits above the first prompt", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		// Both prompts are still on screen (positive bottom), so nothing is pinned.
		const state = harness(loaded.module.PinnedPromptController, [
			fakePrompt("first", { top: 40, bottom: 90 }),
			fakePrompt("second", { top: 200, bottom: 250 }),
		]);
		state.controller.sync();
		assert.equal(state.row.hidden, true);
		assert.equal(state.controller.isPinned, false);
		assert.deepEqual(state.text.children, []);
	} finally {
		await loaded.dispose();
	}
});

test("the label names the newest prompt scrolled past the top edge", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const state = harness(loaded.module.PinnedPromptController, [
			fakePrompt("oldest", { top: -400, bottom: -350 }),
			fakePrompt("middle", { top: -200, bottom: -150 }),
			fakePrompt("newest", { top: 300, bottom: 360 }),
		]);
		state.controller.sync();

		// "newest" is still visible, so the turn on screen belongs to "middle".
		assert.equal(state.row.hidden, false);
		assert.equal(state.controller.pinnedText, "middle");
		assert.deepEqual(state.text.children, ["clone:middle"]);
	} finally {
		await loaded.dispose();
	}
});

test("scrolling back through history relabels each earlier turn", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const state = harness(loaded.module.PinnedPromptController, [
			fakePrompt("first", { top: -300, bottom: -250 }),
			fakePrompt("second", { top: -100, bottom: -50 }),
		]);
		state.controller.sync();
		assert.equal(state.controller.pinnedText, "second");

		// Scroll up: "second" comes back on screen, so its turn is no longer the
		// one being viewed and the label falls back to "first".
		state.setPrompts([
			fakePrompt("first", { top: -120, bottom: -70 }),
			fakePrompt("second", { top: 120, bottom: 170 }),
		]);
		state.controller.sync();
		assert.equal(state.controller.pinnedText, "first");
		assert.deepEqual(state.text.children, ["clone:first"]);

		// Scroll further up until even the first prompt is visible again.
		state.setPrompts([
			fakePrompt("first", { top: 60, bottom: 110 }),
			fakePrompt("second", { top: 300, bottom: 350 }),
		]);
		state.controller.sync();
		assert.equal(state.row.hidden, true);
	} finally {
		await loaded.dispose();
	}
});

test("neighbouring turns with identical text still swap the label", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		// Two "continue" turns: text alone cannot distinguish them, so the label
		// has to key on position as well or it would silently keep the stale clone.
		const state = harness(loaded.module.PinnedPromptController, [
			fakePrompt("continue", { top: -300, bottom: -250 }),
			fakePrompt("continue", { top: -100, bottom: -50 }),
		]);
		state.controller.sync();
		state.text.replaceChildren("sentinel");

		state.setPrompts([
			fakePrompt("continue", { top: -120, bottom: -70 }),
			fakePrompt("continue", { top: 120, bottom: 170 }),
		]);
		state.controller.sync();
		assert.deepEqual(
			state.text.children,
			["clone:continue"],
			"the label must be re-cloned when the turn changes, not left stale",
		);
	} finally {
		await loaded.dispose();
	}
});

test("reference chips in the label are made inert", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const removed = [];
		const chip = {
			removeAttribute: (name) => removed.push(name),
		};
		const state = harness(loaded.module.PinnedPromptController, [
			fakePrompt("see @src/", { top: -100, bottom: -50 }, [chip]),
		]);
		state.controller.sync();
		// The row's own click scrolls to the message, so a chip inside it must not
		// keep the hooks that would also open its target.
		assert.deepEqual(removed, [
			"data-resource-uri",
			"data-workspace-path",
			"data-workspace-line",
		]);
	} finally {
		await loaded.dispose();
	}
});

test("the toggle appears only when the collapsed label overflows", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const fits = harness(
			loaded.module.PinnedPromptController,
			[fakePrompt("short", { top: -100, bottom: -50 })],
			{ textWidths: { scrollWidth: 80, clientWidth: 100 } },
		);
		fits.controller.sync();
		assert.equal(fits.toggle.hidden, true, "no toggle when the text fits");

		const overflows = harness(
			loaded.module.PinnedPromptController,
			[fakePrompt("a very long prompt", { top: -100, bottom: -50 })],
			{ textWidths: { scrollWidth: 400, clientWidth: 100 } },
		);
		overflows.controller.sync();
		assert.equal(overflows.toggle.hidden, false);
		assert.equal(overflows.toggle.attributes.get("aria-expanded"), "false");
		assert.equal(overflows.toggle.title, "Expand this message");
	} finally {
		await loaded.dispose();
	}
});

test("multi-line prompts can expand even when they fit on one line", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const state = harness(
			loaded.module.PinnedPromptController,
			[fakePrompt("line one\nline two", { top: -100, bottom: -50 })],
			{ textWidths: { scrollWidth: 80, clientWidth: 100 } },
		);
		state.controller.sync();
		assert.equal(state.toggle.hidden, false);
	} finally {
		await loaded.dispose();
	}
});

test("expanding marks the row and relabels the toggle", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const state = harness(
			loaded.module.PinnedPromptController,
			[fakePrompt("long prompt", { top: -100, bottom: -50 })],
			{ textWidths: { scrollWidth: 400, clientWidth: 100 } },
		);
		state.controller.sync();

		state.controller.toggleExpanded();
		assert.equal(state.row.classList.contains("is-expanded"), true);
		assert.equal(state.toggle.attributes.get("aria-expanded"), "true");
		assert.equal(state.toggle.title, "Collapse this message");

		state.controller.toggleExpanded();
		assert.equal(state.row.classList.contains("is-expanded"), false);
		assert.equal(state.toggle.title, "Expand this message");
	} finally {
		await loaded.dispose();
	}
});

test("a sync while expanded keeps the expansion and its measurement", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const state = harness(
			loaded.module.PinnedPromptController,
			[fakePrompt("long prompt", { top: -100, bottom: -50 })],
			{ textWidths: { scrollWidth: 400, clientWidth: 100 } },
		);
		state.controller.sync();
		state.controller.toggleExpanded();

		// Expanding switches the text to wrapped layout, which removes the
		// horizontal overflow. Re-measuring now would wrongly conclude the label
		// no longer needs a toggle, so the expanded pass must skip measurement.
		state.text.scrollWidth = 100;
		state.controller.sync();
		assert.equal(state.row.classList.contains("is-expanded"), true);
		assert.equal(state.toggle.hidden, false);
	} finally {
		await loaded.dispose();
	}
});

test("changing turns collapses the label again", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const state = harness(
			loaded.module.PinnedPromptController,
			[
				fakePrompt("first", { top: -300, bottom: -250 }),
				fakePrompt("second", { top: -100, bottom: -50 }),
			],
			{ textWidths: { scrollWidth: 400, clientWidth: 100 } },
		);
		state.controller.sync();
		state.controller.toggleExpanded();
		assert.equal(state.row.classList.contains("is-expanded"), true);

		state.setPrompts([
			fakePrompt("first", { top: -120, bottom: -70 }),
			fakePrompt("second", { top: 120, bottom: 170 }),
		]);
		state.controller.sync();
		assert.equal(state.row.classList.contains("is-expanded"), false);
	} finally {
		await loaded.dispose();
	}
});

test("revealing scrolls to the labelled prompt, not the newest one", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const middle = fakePrompt("middle", { top: -200, bottom: -150 });
		const newest = fakePrompt("newest", { top: 300, bottom: 360 });
		const state = harness(loaded.module.PinnedPromptController, [
			fakePrompt("oldest", { top: -400, bottom: -350 }),
			middle,
			newest,
		]);
		state.controller.sync();
		state.controller.revealActivePrompt();

		assert.deepEqual(middle.scrolled, [{ block: "start" }]);
		assert.deepEqual(newest.scrolled, [], "must not jump to the newest prompt");
	} finally {
		await loaded.dispose();
	}
});

test("a blank prompt is never labelled", async () => {
	const loaded = await loadPinnedPrompt();
	try {
		const state = harness(loaded.module.PinnedPromptController, [
			fakePrompt("   \n  ", { top: -100, bottom: -50 }),
		]);
		state.controller.sync();
		assert.equal(state.row.hidden, true);
	} finally {
		await loaded.dispose();
	}
});
