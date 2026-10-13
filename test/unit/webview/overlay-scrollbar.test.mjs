import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadOverlayScrollbar() {
	return loadBundledModule({
		entry: "webview/transcript/overlayScrollbar.ts",
		name: "overlay-scrollbar",
		platform: "browser",
	});
}

test("a fitting transcript has no thumb at all", async () => {
	const { module } = await loadOverlayScrollbar();
	const { computeThumbMetrics } = module;

	assert.equal(computeThumbMetrics(0, 600, 600), undefined);
	// Sub-pixel layout rounding must not read as an overflow of its own.
	assert.equal(computeThumbMetrics(0, 600.5, 600), undefined);
});

test("the thumb keeps a grabbable floor on very tall content", async () => {
	const { module } = await loadOverlayScrollbar();
	const { computeThumbMetrics } = module;

	// The proportional height would be 600 * 600 / 100000 ≈ 3.6px — smaller
	// than any pointer aims at, so the floor takes over.
	const metrics = computeThumbMetrics(0, 100_000, 600);
	assert.equal(metrics.height, 24);
	assert.equal(metrics.top, 0);
});

test("the thumb rides the whole track between the exact endpoints", async () => {
	const { module } = await loadOverlayScrollbar();
	const { computeThumbMetrics } = module;

	const scrollHeight = 6000;
	const clientHeight = 600;
	const { height, top: topEdge } = computeThumbMetrics(0, scrollHeight, clientHeight);
	const travel = clientHeight - height;
	assert.equal(topEdge, 0);

	const bottomEdge = computeThumbMetrics(
		scrollHeight - clientHeight,
		scrollHeight,
		clientHeight,
	);
	assert.equal(bottomEdge.top, travel);

	// A mid-point scroll lands the thumb proportionally between them.
	const middle = computeThumbMetrics(
		(scrollHeight - clientHeight) / 2,
		scrollHeight,
		clientHeight,
	);
	assert.ok(Math.abs(middle.top - travel / 2) < 0.01);
});

test("scrollTop beyond the content clamps instead of escaping the track", async () => {
	const { module } = await loadOverlayScrollbar();
	const { computeThumbMetrics } = module;

	const metrics = computeThumbMetrics(999_999, 6000, 600);
	const travel = 600 - metrics.height;
	assert.equal(metrics.top, travel);
});
