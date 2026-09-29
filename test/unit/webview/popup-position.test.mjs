import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadPopupPosition() {
	return loadBundledModule({
		entry: "webview/ui/popupPosition.ts",
		name: "popup-position",
		platform: "browser",
	});
}

function element(rect) {
	return { getBoundingClientRect: () => ({ ...rect }) };
}

function popup(width, initialLeft = "73px") {
	const style = { bottom: "", left: initialLeft, maxHeight: "" };
	let leftWhenMeasured;
	return {
		style,
		get offsetWidth() {
			leftWhenMeasured = style.left;
			return width;
		},
		get leftWhenMeasured() {
			return leftWhenMeasured;
		},
	};
}

test("popup placement uses available space and natural width", async () => {
	const loaded = await loadPopupPosition();
	try {
		const target = popup(140);
		loaded.module.positionPopupAbove({
			container: element({ top: 10, bottom: 510, left: 20, width: 380 }),
			anchor: element({ top: 410, left: 250 }),
			popup: target,
		});

		assert.deepEqual(target.style, {
			bottom: "104px",
			left: "230px",
			maxHeight: "388px",
		});
		assert.equal(target.leftWhenMeasured, "0px");
	} finally {
		await loaded.dispose();
	}
});

test("popup placement clamps both horizontal edges and minimum height", async () => {
	const loaded = await loadPopupPosition();
	try {
		const leftTarget = popup(80);
		loaded.module.positionPopupAbove({
			container: element({ top: 0, bottom: 300, left: 30, width: 200 }),
			anchor: element({ top: 70, left: 10 }),
			popup: leftTarget,
		});
		assert.equal(leftTarget.style.left, "8px");
		assert.equal(leftTarget.style.maxHeight, "120px");

		const rightTarget = popup(90);
		loaded.module.positionPopupAbove({
			container: element({ top: 0, bottom: 300, left: 30, width: 200 }),
			anchor: element({ top: 250, left: 220 }),
			popup: rightTarget,
		});
		assert.equal(rightTarget.style.left, "102px");
	} finally {
		await loaded.dispose();
	}
});

test("popup placement accepts explicit spacing constraints", async () => {
	const loaded = await loadPopupPosition();
	try {
		const target = popup(100);
		loaded.module.positionPopupAbove({
			container: element({ top: 100, bottom: 600, left: 50, width: 300 }),
			anchor: element({ top: 180, left: 60 }),
			popup: target,
			gap: 9,
			minHeight: 150,
			viewportInset: 12,
		});
		assert.deepEqual(target.style, {
			bottom: "429px",
			left: "12px",
			maxHeight: "150px",
		});
	} finally {
		await loaded.dispose();
	}
});

test("below placement hangs off the anchor's lower edge", async () => {
	const loaded = await loadPopupPosition();
	try {
		// The header menu's case: an anchor at the top of the sidebar, so the room
		// below it is nearly the whole viewport.
		const target = popup(120);
		loaded.module.positionPopupBelow({
			container: element({ top: 0, bottom: 600, left: 0, width: 380 }),
			anchor: element({ top: 0, bottom: 38, left: 300 }),
			popup: target,
		});
		assert.equal(target.style.top, "42px");
		assert.equal(target.style.maxHeight, "550px");
		assert.equal(target.style.left, "252px");
		assert.equal(target.leftWhenMeasured, "0px");
	} finally {
		await loaded.dispose();
	}
});

test("below placement keeps the minimum height and both horizontal edges", async () => {
	const loaded = await loadPopupPosition();
	try {
		// An anchor near the container's bottom leaves less room than `minHeight`:
		// the popup keeps its floor and scrolls rather than collapsing into the gap.
		const target = popup(80);
		loaded.module.positionPopupBelow({
			container: element({ top: 0, bottom: 300, left: 30, width: 200 }),
			anchor: element({ bottom: 280, left: 220 }),
			popup: target,
		});
		assert.equal(target.style.maxHeight, "120px");
		// Flush against the container's right edge, never past it.
		assert.equal(target.style.left, "112px");
	} finally {
		await loaded.dispose();
	}
});
