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
							contents: "export default { sanitize: (value) => String(value) };",
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

		assert.match(html, /class="message assistant-message"/u);
		// Reasoning is visible while it streams and has no collapse control yet:
		// there is nothing stable to collapse to until the content settles.
		assert.match(
			html,
			/thinking-block streaming is-expanded" data-thinking-key="message-7-thinking-0"/u,
		);
		assert.doesNotMatch(html, /data-expandable="thinking"/u);
		assert.ok(html.indexOf("checking") < html.indexOf("answer"));
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
		// pi labels the box with the raw tool name; the friendly name is reserved
		// for the screen-reader label, where "edit" alone reads as a verb.
		assert.match(html, /<span class="tool-name">edit<\/span>/u);
		// Colour is pi's only status channel. A visually-hidden note keeps the
		// state reachable by assistive tech; it rides in a span rather than an
		// aria-label because a label on a plain div has no role to attach to.
		assert.match(html, /<span class="sr-only">Edit file: done<\/span>/u);
		assert.match(html, /<span class="tool-path">src\/file\.ts<\/span>/u);
		assert.match(html, /diff-remove/u);
		assert.match(html, /diff-add/u);
		assert.doesNotMatch(html, /persisted output|live output/u);
	} finally {
		await loaded.dispose();
	}
});

test("skill invocation renders as a collapsed card with the arguments below", async () => {
	const loaded = await loadTranscript();
	try {
		const content = [
			'<skill name="code-review" location="/skills/code-review/SKILL.md">',
			"References are relative to /skills/code-review.",
			"",
			"# Code Review Skill",
			"",
			"Review the diff carefully.",
			"</skill>",
			"",
			"please review my branch",
		].join("\n");
		const html = loaded.module.messageHtml(
			{ role: "user", content },
			new Map(),
			new Map(),
			false,
			"message-skill",
		);

		assert.match(
			html,
			/class="skill-block expandable" data-expandable="skill" data-skill-key="code-review"/u,
		);
		// Collapsed by default, like pi's SkillInvocationMessageComponent; the
		// file path has no room in the card so it rides in the title.
		assert.match(html, /aria-expanded="false"/u);
		assert.match(html, /title="\/skills\/code-review\/SKILL\.md"/u);
		assert.match(html, /<span class="skill-label">\[skill\]<\/span>/u);
		assert.match(html, /<span class="skill-name">code-review<\/span>/u);
		assert.match(html, /<span class="skill-hint">5 lines<\/span>/u);
		// The body renders through the same sanitized markdown pipeline as any
		// other message content (the mocked marked wraps it in <p>).
		assert.match(html, /<div class="skill-body"><p>/u);
		// The typed arguments stay a separate user bubble, not raw text inside
		// the card.
		assert.match(
			html,
			/<article class="message user-message"><div class="user-message-text">please review my branch<\/div><\/article>/u,
		);
		// No arguments after </skill> means no empty bubble.
		const bare = loaded.module.messageHtml(
			{
				role: "user",
				content:
					'<skill name="code-review" location="/skills/code-review/SKILL.md">\nbody\n</skill>',
			},
			new Map(),
			new Map(),
			false,
			"message-skill-bare",
		);
		assert.match(bare, /skill-block/u);
		assert.doesNotMatch(bare, /user-message/u);
	} finally {
		await loaded.dispose();
	}
});

test("skill card escapes the payload and leaves plain user text alone", async () => {
	const loaded = await loadTranscript();
	try {
		const hostile = loaded.module.messageHtml(
			{
				role: "user",
				content:
					'<skill name="<img src=x onerror=alert(1)>" location="<script>">\nbody\n</skill>',
			},
			new Map(),
			new Map(),
			false,
			"message-skill-hostile",
		);
		assert.match(
			hostile,
			/data-skill-key="&lt;img src=x onerror=alert\(1\)&gt;"/u,
		);
		assert.match(hostile, /title="&lt;script&gt;"/u);
		assert.doesNotMatch(hostile, /<img src=x/u);

		// An unclosed tag is ordinary prose, not a skill invocation: it must
		// keep the plain user-message rendering.
		const partial = loaded.module.messageHtml(
			{ role: "user", content: '<skill name="broken">\nnever closed' },
			new Map(),
			new Map(),
			false,
			"message-skill-partial",
		);
		assert.doesNotMatch(partial, /skill-block/u);
		assert.match(partial, /class="message user-message"/u);
	} finally {
		await loaded.dispose();
	}
});
