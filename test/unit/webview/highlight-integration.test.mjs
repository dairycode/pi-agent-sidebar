import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

/**
 * Loads the renderer with the real `marked` and the real highlighter, mocking
 * only DOMPurify.
 *
 * DOMPurify needs a DOM, which this environment has no need to provide: the
 * behaviour under test is whether highlighting runs at all and what markup it
 * produces. A pass-through sanitizer keeps that markup observable. Class
 * survival through the real DOMPurify is covered by the existing transcript
 * rendering, which depends on `class` attributes throughout.
 */
async function loadRenderer() {
	return loadBundledModule({
		entry: "webview/transcript/renderer.ts",
		name: "highlight-integration",
		platform: "browser",
		plugins: [
			{
				name: "mock-dompurify",
				setup(buildApi) {
					buildApi.onResolve({ filter: /^dompurify$/ }, () => ({
						path: "dompurify",
						namespace: "mock-dompurify",
					}));
					buildApi.onLoad(
						{ filter: /^dompurify$/, namespace: "mock-dompurify" },
						() => ({
							loader: "js",
							contents:
								"export default { sanitize: (value) => String(value) };",
						}),
					);
				},
			},
		],
	});
}

function assistantMessage(text) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

const FENCED = "```ts\nconst x: number = 1;\n```";

test("a settled assistant message highlights fenced code", async () => {
	const loaded = await loadRenderer();
	try {
		const html = loaded.module.messageHtml(
			assistantMessage(FENCED),
			new Map(),
			new Map(),
			false,
			"key-1",
		);
		assert.match(html, /class="hljs language-typescript"/u);
		assert.match(html, /hljs-keyword/u);
		// The <pre> wrapper must survive: `enhanceCodeBlocks` finds it to attach
		// the copy button.
		assert.match(html, /<pre><code/u);
	} finally {
		await loaded.dispose();
	}
});

test("a streaming assistant message never runs the highlighter", async () => {
	const loaded = await loadRenderer();
	try {
		const html = loaded.module.messageHtml(
			assistantMessage(FENCED),
			new Map(),
			new Map(),
			true,
			"key-1",
		);
		// Highlighting on the streaming path would re-highlight the whole block on
		// every delta, so it must not produce token markup.
		assert.doesNotMatch(html, /hljs-keyword/u);
		// The language class is still emitted, so the block reports its language
		// even while streaming.
		assert.match(html, /class="hljs language-typescript"/u);
		assert.match(html, /const x: number = 1;/u);
	} finally {
		await loaded.dispose();
	}
});

test("an unknown language renders as escaped plain text", async () => {
	const loaded = await loadRenderer();
	try {
		const html = loaded.module.messageHtml(
			assistantMessage("```notalanguage\nconst x = 1;\n```"),
			new Map(),
			new Map(),
			false,
			"key-1",
		);
		assert.doesNotMatch(html, /hljs-keyword/u);
		assert.doesNotMatch(html, /language-/u);
		assert.match(html, /<pre><code class="hljs">/u);
	} finally {
		await loaded.dispose();
	}
});

test("code content is escaped whether or not it is highlighted", async () => {
	const loaded = await loadRenderer();
	try {
		const payload = 'const a = "<img src=x onerror=alert(1)>";';
		for (const [label, lang, streaming] of [
			["highlighted", "ts", false],
			["streaming", "ts", true],
			["unknown language", "notalanguage", false],
		]) {
			const html = loaded.module.messageHtml(
				assistantMessage(`\`\`\`${lang}\n${payload}\n\`\`\``),
				new Map(),
				new Map(),
				streaming,
				"key-1",
			);
			assert.doesNotMatch(html, /<img/u, `${label} must not emit raw markup`);
			assert.match(html, /&lt;img/u, `${label} must escape the payload`);
		}
	} finally {
		await loaded.dispose();
	}
});

test("a single-line block too long to highlight still renders as text", async () => {
	const loaded = await loadRenderer();
	try {
		// Past the per-line ceiling: highlight.js cost is quadratic in line length,
		// so this degrades to plain text rather than freezing the webview.
		const long = "a".repeat(4096);
		const html = loaded.module.messageHtml(
			assistantMessage(`\`\`\`ts\n${long}\n\`\`\``),
			new Map(),
			new Map(),
			false,
			"key-1",
		);
		assert.doesNotMatch(html, /hljs-/u);
		assert.match(html, new RegExp(`a{${long.length}}`, "u"));
	} finally {
		await loaded.dispose();
	}
});

test("highlighting does not leak across a streaming render", async () => {
	const loaded = await loadRenderer();
	try {
		// The renderer arms highlighting with a module-level flag. Rendering a
		// settled message and then a streaming one must not leave it armed.
		loaded.module.messageHtml(
			assistantMessage(FENCED),
			new Map(),
			new Map(),
			false,
			"settled",
		);
		const streamingHtml = loaded.module.messageHtml(
			assistantMessage(FENCED),
			new Map(),
			new Map(),
			true,
			"streaming",
		);
		assert.doesNotMatch(streamingHtml, /hljs-keyword/u);
	} finally {
		await loaded.dispose();
	}
});
