import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadPopupPosition() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-popup-position-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "popup-position.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "webview", "ui", "popupPosition.ts")],
		outfile: output,
		bundle: true,
		platform: "browser",
		format: "esm",
		target: "chrome120",
		logLevel: "silent",
	});
	return {
		module: await import(`${pathToFileURL(output).href}?v=${Date.now()}`),
		dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
	};
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
