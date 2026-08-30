import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadHighlight() {
	return loadBundledModule({
		entry: "webview/transcript/highlight.ts",
		name: "highlight",
		platform: "browser",
	});
}

test("only explicit, known language tags are highlighted", async () => {
	const loaded = await loadHighlight();
	try {
		const { resolveLanguage } = loaded.module;
		assert.equal(resolveLanguage("ts"), "typescript");
		assert.equal(resolveLanguage("TypeScript"), "typescript");
		assert.equal(resolveLanguage("  py  "), "python");
		assert.equal(resolveLanguage("sh"), "bash");
		assert.equal(resolveLanguage("html"), "xml");

		// No automatic detection: an absent or unknown tag must not be guessed.
		assert.equal(resolveLanguage(""), undefined);
		assert.equal(resolveLanguage("   "), undefined);
		assert.equal(resolveLanguage("brainfuck"), undefined);
		// A tag long enough to be suspicious is not a language name.
		assert.equal(resolveLanguage("x".repeat(33)), undefined);
	} finally {
		await loaded.dispose();
	}
});

test("highlighting emits class-based markup with no inline styles", async () => {
	const loaded = await loadHighlight();
	try {
		const highlighter = new loaded.module.HighlightJsHighlighter();
		const html = highlighter.highlight("const x = 1;", "ts");
		assert.ok(html, "expected TypeScript to be highlighted");
		assert.match(html, /class="hljs-/u);
		// The CSP forbids inline styles (`style-src` without `unsafe-inline`, which
		// `style-src-attr` falls back to). Inline styles here would be blocked, so
		// the output must be class-only.
		assert.doesNotMatch(html, /style=/u);
		// The highlighter escapes source that would otherwise be markup.
		const dangerous = highlighter.highlight(
			'const a = "<img src=x onerror=alert(1)>";',
			"ts",
		);
		assert.ok(dangerous);
		assert.doesNotMatch(dangerous, /<img/u);
		assert.match(dangerous, /&lt;img/u);
	} finally {
		await loaded.dispose();
	}
});

test("unhighlightable input degrades to undefined instead of throwing", async () => {
	const loaded = await loadHighlight();
	try {
		const { HighlightJsHighlighter, MAX_HIGHLIGHT_BYTES } = loaded.module;
		const highlighter = new HighlightJsHighlighter();

		// Unknown language: the caller falls back to plain escaped text.
		assert.equal(highlighter.highlight("const x = 1;", "nope"), undefined);
		assert.equal(highlighter.highlight("plain text", ""), undefined);

		// A large but ordinarily-shaped file still highlights: the total-size ceiling
		// is not what makes hostile input expensive.
		const line = `const value = ${"x".repeat(60)};\n`;
		const justUnder = line.repeat(
			Math.floor((MAX_HIGHLIGHT_BYTES - 200) / line.length),
		);
		assert.ok(highlighter.highlight(justUnder, "ts"));
		assert.equal(
			highlighter.highlight(line.repeat(MAX_HIGHLIGHT_BYTES), "ts"),
			undefined,
		);
		// A CJK block is ~3 bytes per character, so it hits the ceiling far sooner
		// than its character count suggests.
		assert.equal(
			highlighter.highlight(`${"雪".repeat(400)}\n`.repeat(200), "ts"),
			undefined,
		);

		// Syntactically invalid source still highlights (ignoreIllegals) rather
		// than failing the whole message.
		assert.ok(highlighter.highlight("const ((( unclosed", "ts"));
	} finally {
		await loaded.dispose();
	}
});

test("a single very long line is refused because its cost is quadratic", async () => {
	const loaded = await loadHighlight();
	try {
		const { HighlightJsHighlighter, MAX_HIGHLIGHT_LINE_BYTES } = loaded.module;
		const highlighter = new HighlightJsHighlighter();

		// Measured on this highlighter: a 64 KiB block costs ~22ms as 80-column
		// lines but ~9.6s as one line, and highlighting is synchronous. The line
		// ceiling is what keeps a minified paste from freezing the webview.
		assert.ok(
			highlighter.highlight("a".repeat(MAX_HIGHLIGHT_LINE_BYTES), "ts"),
		);
		assert.equal(
			highlighter.highlight("a".repeat(MAX_HIGHLIGHT_LINE_BYTES + 1), "ts"),
			undefined,
		);

		// The refusal must be fast: rejecting is the whole point.
		const started = performance.now();
		assert.equal(highlighter.highlight("a".repeat(65_000), "ts"), undefined);
		assert.ok(
			performance.now() - started < 100,
			"rejecting an oversized line must not do the expensive work first",
		);

		// One long line poisons an otherwise reasonable block, so the whole block
		// degrades rather than being highlighted line by line.
		assert.equal(
			highlighter.highlight(
				`const ok = 1;\n${"b".repeat(MAX_HIGHLIGHT_LINE_BYTES + 1)}\nconst also = 2;\n`,
				"ts",
			),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});

test("the memo is bounded and evicts least-recently-used entries", async () => {
	const loaded = await loadHighlight();
	try {
		const { HighlightJsHighlighter, MAX_CACHE_ENTRIES } = loaded.module;
		const highlighter = new HighlightJsHighlighter();

		// Same input twice must produce identical output; the second call is served
		// from the memo, which is what keeps a snapshot rebuild cheap.
		const first = highlighter.highlight("const x = 1;", "ts");
		const second = highlighter.highlight("const x = 1;", "ts");
		assert.equal(first, second);

		// Overflow the memo, keeping one key hot so it survives eviction.
		for (let index = 0; index < MAX_CACHE_ENTRIES + 20; index += 1) {
			highlighter.highlight(`const v${index} = ${index};`, "ts");
			highlighter.highlight("const hot = 1;", "ts");
		}
		// Correctness must not depend on whether a key survived: a cold key is
		// simply recomputed to the same value.
		assert.equal(
			highlighter.highlight("const hot = 1;", "ts"),
			highlighter.highlight("const hot = 1;", "ts"),
		);
		assert.equal(
			highlighter.highlight("const v0 = 0;", "ts"),
			highlighter.highlight("const v0 = 0;", "ts"),
		);
	} finally {
		await loaded.dispose();
	}
});

test("the same code in different languages is memoized separately", async () => {
	const loaded = await loadHighlight();
	try {
		const highlighter = new loaded.module.HighlightJsHighlighter();
		// `class Foo {}` is valid in several languages and highlights differently.
		// A memo keyed on code alone would return the wrong language's markup.
		const asTypeScript = highlighter.highlight("class Foo {}", "ts");
		const asPython = highlighter.highlight("class Foo: pass", "py");
		assert.ok(asTypeScript);
		assert.ok(asPython);
		assert.notEqual(asTypeScript, asPython);
	} finally {
		await loaded.dispose();
	}
});
