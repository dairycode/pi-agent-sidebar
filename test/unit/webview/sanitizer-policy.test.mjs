import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	loadBundledModule,
	projectRoot,
} from "../../helpers/load-bundled-module.mjs";

/**
 * The transcript sanitizer policy forbids `style` in both forms, and this file
 * is what keeps it that way.
 *
 * DOMPurify's html profile allows the `<style>` tag and the `style=` attribute,
 * and the webview CSP must keep `'unsafe-inline'` for styles because mermaid's
 * SVG carries its own. The policy is therefore the only thing preventing any
 * text that reaches the transcript from repainting the composer, the connection
 * banner, or a dialog.
 *
 * The policy is shared by `transcript/renderer.ts` and `main.ts`, so asserting
 * the object once covers both call sites. The wiring test below additionally
 * proves the renderer hands it to DOMPurify rather than rebuilding a looser
 * configuration inline.
 */
const FORBIDDEN = ["style"];

async function loadPolicy() {
	return loadBundledModule({
		entry: "webview/sanitizerPolicy.ts",
		name: "sanitizer-policy",
		platform: "browser",
	});
}

test("the transcript policy forbids inline and element styles", async () => {
	const loaded = await loadPolicy();
	try {
		const policy = loaded.module.TRANSCRIPT_SANITIZE_OPTIONS;
		for (const attribute of FORBIDDEN) {
			assert.ok(
				policy.FORBID_ATTR?.includes(attribute),
				`FORBID_ATTR must include ${attribute}`,
			);
		}
		for (const tag of FORBIDDEN) {
			assert.ok(
				policy.FORBID_TAGS?.includes(tag),
				`FORBID_TAGS must include ${tag}`,
			);
		}
	} finally {
		await loaded.dispose();
	}
});

test("the transcript policy keeps the html profile and link attributes", async () => {
	const loaded = await loadPolicy();
	try {
		const policy = loaded.module.TRANSCRIPT_SANITIZE_OPTIONS;
		assert.equal(policy.USE_PROFILES?.html, true);
		// Markdown links need `target`/`rel` to open safely in a new tab; the
		// transcript's click handler depends on the anchor surviving sanitizing.
		assert.ok(policy.ADD_ATTR?.includes("target"));
		assert.ok(policy.ADD_ATTR?.includes("rel"));
	} finally {
		await loaded.dispose();
	}
});

test("the renderer sanitizes through the shared policy", async () => {
	const loaded = await loadBundledModule({
		entry: "webview/transcript/renderer.ts",
		name: "sanitizer-wiring",
		platform: "browser",
		plugins: [
			{
				name: "capture-dompurify-config",
				setup(buildApi) {
					buildApi.onResolve({ filter: /^dompurify$/ }, () => ({
						path: "dompurify",
						namespace: "capture-dompurify",
					}));
					buildApi.onLoad(
						{ filter: /^dompurify$/, namespace: "capture-dompurify" },
						() => ({
							loader: "js",
							contents: `
								globalThis.__dompurifyConfigs = [];
								export default {
									sanitize(value, config) {
										globalThis.__dompurifyConfigs.push(config);
										return String(value);
									},
								};
							`,
						}),
					);
				},
			},
		],
	});
	try {
		loaded.module.messageHtml(
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
			new Map(),
			new Map(),
			false,
			"key-1",
		);
		const configs = globalThis.__dompurifyConfigs;
		assert.ok(configs.length > 0, "the renderer should have sanitized something");
		for (const config of configs) {
			assert.ok(config.FORBID_TAGS?.includes("style"));
			assert.ok(config.FORBID_ATTR?.includes("style"));
		}
	} finally {
		delete globalThis.__dompurifyConfigs;
		await loaded.dispose();
	}
});

/**
 * `main.ts` is the second call site but cannot be imported: it acquires the
 * VS Code API and resolves its DOM elements at module scope. This source
 * assertion is a stand-in until that pipeline moves into a testable module;
 * delete it then.
 */
test("main.ts sanitizes through the shared policy", async () => {
	const source = await readFile(
		path.join(projectRoot, "webview/main.ts"),
		"utf8",
	);
	assert.match(
		source,
		/DOMPurify\.sanitize\(html, TRANSCRIPT_SANITIZE_OPTIONS\)/u,
	);
	assert.doesNotMatch(
		source,
		/USE_PROFILES:\s*\{\s*html:\s*true\s*\}/u,
		"main.ts must not rebuild a sanitizer configuration inline",
	);
});
