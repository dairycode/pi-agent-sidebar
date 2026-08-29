import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadTranscript() {
	return loadBundledModule({
		entry: "webview/transcript/renderer.ts",
		name: "transcript",
		plugins: [
			{
				name: "mock-markdown",
				setup(buildApi) {
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

test("user transcript markers retain canonical URI and selection line", async () => {
	const loaded = await loadTranscript();
	try {
		const file = {
			path: "/workspace/src/file.ts",
			uri: "file:///workspace/src/file.ts",
			displayPath: "src/file.ts",
			marker: "@src/file.ts",
		};
		const directory = {
			path: "/workspace/src/provider",
			uri: "file:///workspace/src/provider",
			displayPath: "src/provider",
			marker: "@src/provider/",
		};
		const selection = {
			path: "/workspace/src/selected.ts",
			uri: "file:///workspace/src/selected.ts",
			displayPath: "src/selected.ts",
			marker: "@src/selected.ts#4",
			languageId: "typescript",
			startLine: 4,
			endLine: 4,
			text: "const selected = true;",
		};
		const content = [
			"<pi-context>",
			`- file: ${JSON.stringify(file)}`,
			`- directory: ${JSON.stringify(directory)}`,
			`- selection: ${JSON.stringify(selection)}`,
			"</pi-context>",
			"",
			"Compare @src/file.ts, @src/provider/, and @src/selected.ts#4",
		].join("\n");
		const html = loaded.module.messageHtml(
			{ role: "user", content },
			new Map(),
			new Map(),
			false,
			"message-0",
		);

		assert.match(
			html,
			/data-resource-uri="file:\/\/\/workspace\/src\/file\.ts"/u,
		);
		assert.match(
			html,
			/data-resource-uri="file:\/\/\/workspace\/src\/provider"[^>]*>@src\/provider\//u,
		);
		assert.match(
			html,
			/data-resource-uri="file:\/\/\/workspace\/src\/selected\.ts" data-workspace-line="4"/u,
		);
		assert.match(
			html,
			/Compare .*@src\/file\.ts.*, .*@src\/provider\/.*, and .*@src\/selected\.ts#4/u,
		);
	} finally {
		await loaded.dispose();
	}
});

test("assistant transcript preserves activity ordering and stream state", async () => {
	const loaded = await loadTranscript();
	try {
		const html = loaded.module.messageHtml(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "checking" },
					{ type: "text", text: "answer" },
				],
				stopReason: "aborted",
				errorMessage: "partial failure",
			},
			new Map(),
			new Map(),
			true,
			"message-7",
		);

		assert.match(html, /assistant-message starts-with-activity/u);
		assert.match(
			html,
			/thinking-block streaming" data-thinking-key="message-7-thinking-0" open/u,
		);
		assert.ok(html.indexOf("Reasoning") < html.indexOf("answer"));
		assert.match(html, /partial failure/u);
		assert.match(html, /Cancelled/u);
	} finally {
		await loaded.dispose();
	}
});

test("live successful tool diff replaces persisted tool output", async () => {
	const loaded = await loadTranscript();
	try {
		const toolCall = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tool-1",
					name: "edit",
					arguments: { path: "src/file.ts" },
				},
			],
		};
		const results = new Map([
			[
				"tool-1",
				{
					role: "toolResult",
					toolCallId: "tool-1",
					content: [{ type: "text", text: "persisted output" }],
				},
			],
		]);
		const liveTools = new Map([
			[
				"tool-1",
				{
					id: "tool-1",
					name: "edit",
					args: { path: "src/file.ts" },
					status: "success",
					output: "live output",
					diff: "-old\n+new",
					startedAt: 0,
				},
			],
		]);
		const html = loaded.module.messageHtml(
			toolCall,
			results,
			liveTools,
			false,
			"message-1",
		);

		assert.match(html, /tool-call success/u);
		assert.match(html, /Edit file/u);
		assert.match(html, /src\/file\.ts/u);
		assert.match(html, /diff-remove/u);
		assert.match(html, /diff-add/u);
		assert.doesNotMatch(html, /persisted output|live output/u);
	} finally {
		await loaded.dispose();
	}
});
