import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

/** Mocks only markdown: the functions under test produce plain text, not HTML. */
async function loadRenderer() {
	return loadBundledModule({
		entry: "webview/transcript/renderer.ts",
		name: "message-actions",
		platform: "browser",
		plugins: [
			{
				name: "mock-markdown",
				setup(buildApi) {
					// esbuild filters are Go regexes: a JS `u` flag becomes `(?u)`, which
					// Go rejects. Plain literals only.
					buildApi.onResolve({ filter: /^dompurify$/ }, () => ({
						path: "dompurify",
						namespace: "mock-markdown",
					}));
					buildApi.onResolve({ filter: /^marked$/ }, () => ({
						path: "marked",
						namespace: "mock-markdown",
					}));
					buildApi.onLoad(
						{ filter: /^dompurify$/, namespace: "mock-markdown" },
						() => ({
							loader: "js",
							contents:
								"export default { sanitize: (value) => String(value) };",
						}),
					);
					buildApi.onLoad(
						{ filter: /^marked$/, namespace: "mock-markdown" },
						() => ({
							loader: "js",
							contents:
								"export const marked = { setOptions() {}, use() {}, parse: (value) => `<p>${value}</p>` };",
						}),
					);
				},
			},
		],
	});
}

test("copying a message yields its text without injected context", async () => {
	const loaded = await loadRenderer();
	try {
		const { messagePlainText } = loaded.module;

		assert.equal(
			messagePlainText({ role: "user", content: "Explain this function" }),
			"Explain this function",
		);

		// The `<pi-context>` preamble is injected by the extension, not typed by
		// the user, so it must not be part of what they copy.
		assert.equal(
			messagePlainText({
				role: "user",
				content:
					"<pi-context>\nfile: src/main.ts\nselection: 1-20\n</pi-context>\n\nWhat does this do?",
			}),
			"What does this do?",
		);

		// Only `text` blocks survive: reasoning and tool calls are not part of the
		// message a reader means to copy.
		assert.equal(
			messagePlainText({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "internal reasoning" },
					{ type: "text", text: "Here is the answer." },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: {} },
				],
			}),
			"Here is the answer.",
		);

		// Several text blocks join as separate lines.
		assert.equal(
			messagePlainText({
				role: "assistant",
				content: [
					{ type: "text", text: "First." },
					{ type: "text", text: "Second." },
				],
			}),
			"First.\nSecond.",
		);
	} finally {
		await loaded.dispose();
	}
});

test("a message with no copyable text reports empty rather than chrome", async () => {
	const loaded = await loadRenderer();
	try {
		const { messagePlainText } = loaded.module;
		// Image-only, tool-only, and empty messages must yield "", which is what
		// suppresses the action buttons.
		assert.equal(
			messagePlainText({
				role: "user",
				content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
			}),
			"",
		);
		assert.equal(
			messagePlainText({
				role: "assistant",
				content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }],
			}),
			"",
		);
		assert.equal(messagePlainText({ role: "user", content: "   \n  " }), "");
		assert.equal(messagePlainText({ role: "user" }), "");
		// A context block with nothing after it leaves nothing to copy.
		assert.equal(
			messagePlainText({
				role: "user",
				content: "<pi-context>\nfile: a.ts\n</pi-context>\n\n",
			}),
			"",
		);
	} finally {
		await loaded.dispose();
	}
});

test("quoting keeps the whole message inside one block quote", async () => {
	const loaded = await loadRenderer();
	try {
		const { quotedText } = loaded.module;
		assert.equal(quotedText("one line"), "> one line");
		assert.equal(quotedText("first\nsecond"), "> first\n> second");
		// A truly empty line would end the block quote and leave the remainder as
		// ordinary text, so blank lines carry a bare marker.
		assert.equal(
			quotedText("para one\n\npara two"),
			"> para one\n>\n> para two",
		);
		// Already-quoted text nests rather than being flattened.
		assert.equal(quotedText("> quoted"), "> > quoted");
	} finally {
		await loaded.dispose();
	}
});
