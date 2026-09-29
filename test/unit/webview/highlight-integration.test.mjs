import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

/**
 * Loads the renderer with the real `marked` and the real highlighter, mocking
 * only DOMPurify.
 *
 * DOMPurify needs a DOM, which this environment has no need to provide: the
 * behaviour under test is whether highlighting runs at all and what markup it
 * produces. A pass-through sanitizer keeps that markup observable.
 *
 * That pass-through is also why this file cannot observe the sanitizer policy:
 * any configuration is accepted and ignored. `sanitizer-policy.test.mjs`
 * asserts the policy itself, and the other renderer tests that mock DOMPurify
 * the same way (`transcript.test.mjs`, `transcript-sections.test.mjs`) share
 * this limitation.
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
							contents: "export default { sanitize: (value) => String(value) };",
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

test("a streaming assistant message renders Markdown without highlighting", async () => {
	const loaded = await loadRenderer();
	try {
		const html = loaded.module.messageHtml(
			assistantMessage(FENCED),
			new Map(),
			new Map(),
			true,
			"key-1",
		);
		// Markdown structure appears while text is streaming, but expensive syntax
		// highlighting waits for the settled authoritative message.
		assert.doesNotMatch(html, /hljs-keyword/u);
		assert.match(html, /<pre><code class="hljs language-typescript">/u);
		assert.match(html, /const x: number = 1;/u);
	} finally {
		await loaded.dispose();
	}
});

test("streaming Markdown keeps only the final top-level token active", async () => {
	const loaded = await loadRenderer();
	try {
		const first = loaded.module.streamingMarkdownParts(
			"# Heading\n\nFirst paragraph",
		);
		assert.match(first.stableHtml, /<h1>Heading<\/h1>/u);
		assert.match(first.activeHtml, /<p>First paragraph<\/p>/u);
		assert.equal(first.reset, false);

		const second = loaded.module.streamingMarkdownParts(
			"# Heading\n\nFirst paragraph\n\n- one\n- two",
			first.stableSourceLength,
		);
		assert.match(second.stableHtml, /<p>First paragraph<\/p>/u);
		assert.match(second.activeHtml, /<ul>/u);
		assert.match(second.activeHtml, /<li>one<\/li>/u);
		assert.match(second.activeHtml, /<li>two<\/li>/u);
		assert.equal(second.reset, false);
	} finally {
		await loaded.dispose();
	}
});

test("an unfinished fenced block is live Markdown but remains unhighlighted", async () => {
	const loaded = await loadRenderer();
	try {
		const parts = loaded.module.streamingMarkdownParts(
			"```ts\nconst value = 1;\n",
		);
		assert.match(
			parts.activeHtml,
			/<pre><code class="hljs language-typescript">/u,
		);
		assert.doesNotMatch(parts.activeHtml, /hljs-keyword/u);
		assert.equal(
			parts.appendMode,
			"none",
			"a frame ending on a newline reparses once to preserve the code line break",
		);
	} finally {
		await loaded.dispose();
	}
});

test("streaming append modes preserve inline Markdown boundaries", async () => {
	const loaded = await loadRenderer();
	try {
		assert.equal(
			loaded.module.streamingMarkdownParts("plain text").appendMode,
			"plain",
		);
		assert.equal(
			loaded.module.streamingMarkdownParts("plain **bold**").appendMode,
			"none",
			"new text after strong markup must not be appended inside <strong>",
		);
		assert.equal(
			loaded.module.streamingMarkdownParts("plain [link](https://example.com)")
				.appendMode,
			"none",
			"new text after a link must not be appended inside <a>",
		);
		assert.equal(
			loaded.module.streamingMarkdownParts("```ts\nconst value = 1;").appendMode,
			"code",
		);
		assert.equal(
			loaded.module.streamingMarkdownParts("```ts\nconst value = 1;\n```")
				.appendMode,
			"none",
		);
	} finally {
		await loaded.dispose();
	}
});

test("streaming Markdown does not expose delimiters that vanish on the next frame", async () => {
	const loaded = await loadRenderer();
	try {
		const boldOpen = loaded.module.streamingMarkdownParts("Start **bold text");
		assert.match(boldOpen.activeHtml, /<p>Start bold text<\/p>/u);
		assert.doesNotMatch(boldOpen.activeHtml, /\*/u);

		const boldAlmostClosed =
			loaded.module.streamingMarkdownParts("Start **bold text*");
		assert.match(boldAlmostClosed.activeHtml, /<p>Start bold text<\/p>/u);
		assert.doesNotMatch(boldAlmostClosed.activeHtml, /\*/u);

		const boldClosed = loaded.module.streamingMarkdownParts(
			"Start **bold text**",
		);
		assert.match(boldClosed.activeHtml, /<strong>bold text<\/strong>/u);

		const codeOpen = loaded.module.streamingMarkdownParts("and `inline code");
		assert.match(codeOpen.activeHtml, /<p>and inline code<\/p>/u);
		assert.doesNotMatch(codeOpen.activeHtml, /`/u);

		const codeClosed = loaded.module.streamingMarkdownParts("and `inline code`");
		assert.match(codeClosed.activeHtml, /<code>inline code<\/code>/u);

		const strikeOpen = loaded.module.streamingMarkdownParts("Strike ~~removed~");
		assert.match(strikeOpen.activeHtml, /<p>Strike removed<\/p>/u);
		assert.doesNotMatch(strikeOpen.activeHtml, /~/u);
		const strikeClosed =
			loaded.module.streamingMarkdownParts("Strike ~~removed~~");
		assert.match(strikeClosed.activeHtml, /<del>removed<\/del>/u);

		const ordinaryOperator = loaded.module.streamingMarkdownParts("math 5 * 3.");
		assert.match(ordinaryOperator.activeHtml, /math 5 \* 3\./u);

		const escaped = loaded.module.streamingMarkdownParts("Escaped \\*literal\\*");
		assert.match(escaped.activeHtml, /Escaped \*literal\*/u);
	} finally {
		await loaded.dispose();
	}
});

test("streaming block markers become structure without leaking temporary text", async () => {
	const loaded = await loadRenderer();
	try {
		const pendingList = loaded.module.streamingMarkdownParts("- ");
		assert.equal(pendingList.activeHtml, "");
		assert.equal(pendingList.appendMode, "none");

		const list = loaded.module.streamingMarkdownParts("- first item");
		assert.match(list.activeHtml, /<li>first item<\/li>/u);
		assert.doesNotMatch(list.activeHtml, />- /u);

		for (const pendingSetext of [
			"Reasoning line\n-",
			"Reasoning line\n--",
			"Reasoning line\n=",
		]) {
			const parts = loaded.module.streamingMarkdownParts(pendingSetext);
			assert.match(parts.activeHtml, /<p>Reasoning line<\/p>/u);
			assert.doesNotMatch(parts.activeHtml, /<h[12]>|<hr>|<li>/u);
			assert.equal(parts.appendMode, "none");
		}
		const listAfterReasoning = loaded.module.streamingMarkdownParts(
			"Reasoning line\n- first item",
		);
		assert.match(listAfterReasoning.stableHtml, /<p>Reasoning line<\/p>/u);
		assert.match(listAfterReasoning.activeHtml, /<li>first item<\/li>/u);

		for (const pendingDivider of ["-", "--", "*", "**", "_"]) {
			const parts = loaded.module.streamingMarkdownParts(pendingDivider);
			assert.equal(parts.activeHtml, "");
			assert.equal(parts.appendMode, "none");
		}
		const divider = loaded.module.streamingMarkdownParts("---");
		assert.match(divider.activeHtml, /<hr>/u);

		const pendingOrderedList = loaded.module.streamingMarkdownParts("1");
		assert.equal(pendingOrderedList.activeHtml, "");
		assert.equal(pendingOrderedList.appendMode, "none");
		const orderedList = loaded.module.streamingMarkdownParts("1. first item");
		assert.match(orderedList.activeHtml, /<ol>/u);
		assert.match(orderedList.activeHtml, /<li>first item<\/li>/u);

		const pendingLink = loaded.module.streamingMarkdownParts(
			"Read [docs](https://example.com",
		);
		assert.match(pendingLink.activeHtml, /<p>Read docs<\/p>/u);
		assert.doesNotMatch(pendingLink.activeHtml, /\[|\]|https:\/\//u);
		assert.equal(pendingLink.appendMode, "none");
		const link = loaded.module.streamingMarkdownParts(
			"Read [docs](https://example.com)",
		);
		assert.match(link.activeHtml, /<a href="https:\/\/example\.com">docs<\/a>/u);

		const heading = loaded.module.streamingMarkdownParts("# Heading **bold");
		assert.match(heading.activeHtml, /<h1>Heading bold<\/h1>/u);
		assert.doesNotMatch(heading.activeHtml, /#|\*/u);
		const listInline = loaded.module.streamingMarkdownParts("- item **bold");
		assert.match(listInline.activeHtml, /<li>item bold<\/li>/u);
		assert.doesNotMatch(listInline.activeHtml, /\*/u);
		const quoteInline = loaded.module.streamingMarkdownParts("> quote `code");
		assert.match(quoteInline.activeHtml, /<p>quote code<\/p>/u);
		assert.doesNotMatch(quoteInline.activeHtml, /`/u);

		const language = loaded.module.streamingMarkdownParts("```ts");
		assert.match(language.activeHtml, /language-typescript/u);
		assert.doesNotMatch(language.activeHtml, />ts/u);
		assert.equal(language.appendMode, "none");

		for (const suffix of ["\n", "\n`", "\n``", "\n```"]) {
			const fence = loaded.module.streamingMarkdownParts(
				`\`\`\`ts\nvalue${suffix}`,
			);
			assert.match(fence.activeHtml, />value<\/code>/u);
			assert.doesNotMatch(fence.activeHtml, /value\n|`/u);
		}

		const nextCodeLine =
			loaded.module.streamingMarkdownParts("```ts\nvalue\nnext");
		assert.match(nextCodeLine.activeHtml, />value\nnext<\/code>/u);
	} finally {
		await loaded.dispose();
	}
});

test("reference definitions reset the streaming prefix cache", async () => {
	const loaded = await loadRenderer();
	try {
		const definitionOnly = loaded.module.streamingMarkdownParts(
			"[docs]: https://example.com",
		);
		assert.equal(definitionOnly.reset, true);
		assert.equal(definitionOnly.stableSourceLength, 0);

		const beforeDefinition = "# Heading\n\nRead [docs]";
		const first = loaded.module.streamingMarkdownParts(beforeDefinition);
		assert.ok(first.stableSourceLength > 0);

		const parts = loaded.module.streamingMarkdownParts(
			`${beforeDefinition}\n\n[docs]: https://example.com`,
			first.stableSourceLength,
		);
		assert.equal(parts.reset, true);
		assert.equal(parts.stableSourceLength, 0);
		assert.match(parts.activeHtml, /href="https:\/\/example\.com"/u);
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
