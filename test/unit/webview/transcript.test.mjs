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
								"export const marked = { setOptions() {}, use(config) { globalThis.__transcriptMarkedRenderer = config.renderer; }, parse: (value) => `<p>${value}</p>` };",
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
		// Reasoning starts collapsed and has a collapse control even while it
		// streams; the reader opts in to seeing it, so the body stays out of the
		// DOM until then (a settle would otherwise parse a long reasoning wall
		// the reader never asked to see).
		assert.match(
			html,
			/thinking-block streaming" data-thinking-key="message-7-thinking-0" data-expandable="thinking"/u,
		);
		assert.doesNotMatch(html, /is-expanded|checking/u);
		assert.match(html, /partial failure/u);
		assert.match(html, /Cancelled/u);

		// An explicitly expanded streaming block renders its (sanitized) body and
		// streams updates into it instead.
		const expanded = loaded.module.messageHtml(
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
			new Set(["message-7-thinking-0"]),
		);
		assert.match(
			expanded,
			/thinking-block streaming is-expanded" data-thinking-key="message-7-thinking-0"/u,
		);
		assert.match(expanded, /aria-expanded="true"/u);
		assert.ok(expanded.indexOf("checking") < expanded.indexOf("answer"));
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
		assert.match(html, /data-tool-body="lazy"/u);
		assert.match(html, /<span class="tool-hint">output<\/span>/u);
		assert.doesNotMatch(
			html,
			/diff-remove|diff-add|persisted output|live output/u,
			"collapsed tool cards must not materialize hidden output",
		);

		const body = loaded.module.toolBodyHtml(
			results.get("tool-1"),
			liveTools.get("tool-1"),
		);
		assert.match(body, /diff-remove/u);
		assert.match(body, /diff-add/u);
		assert.doesNotMatch(body, /persisted output|live output/u);

		const rawBody = loaded.module.toolBodyHtml(undefined, {
			...liveTools.get("tool-1"),
			output: undefined,
			diff: undefined,
			result: {
				content: [{ type: "text", text: "raw output" }],
				details: { diff: "-raw old\n+raw new" },
			},
		});
		assert.match(rawBody, /raw old/u);
		assert.match(rawBody, /raw new/u);
		assert.doesNotMatch(rawBody, /raw output/u);

		const unreadResult = {};
		Object.defineProperties(unreadResult, {
			content: {
				get() {
					throw new Error("collapsed rendering read tool content");
				},
			},
			details: {
				get() {
					throw new Error("collapsed rendering read tool details");
				},
			},
		});
		assert.doesNotThrow(() =>
			loaded.module.messageHtml(
				toolCall,
				new Map(),
				new Map([
					[
						"tool-1",
						{
							...liveTools.get("tool-1"),
							output: undefined,
							diff: undefined,
							result: unreadResult,
						},
					],
				]),
				true,
				"message-1",
			),
		);
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

/**
 * The image renderer registered with marked, captured by the mock in
 * `loadTranscript` because the real marked never runs under Node.
 */
function imageRenderer() {
	return globalThis.__transcriptMarkedRenderer.image;
}

test("an image path becomes a placeholder the host resolves", async () => {
	const loaded = await loadTranscript();
	try {
		const image = imageRenderer();

		// No `src`: a path is not loadable from a webview, and a made-up `src` would
		// render as a broken image before the host ever answers.
		assert.equal(
			image({ href: "/tmp/preview.png", title: null, text: "preview" }),
			'<img class="message-media" data-media-source="/tmp/preview.png" alt="preview">',
		);
		assert.equal(
			image({ href: "docs/chart.png", title: null, text: "" }),
			'<img class="message-media" data-media-source="docs/chart.png" alt="">',
		);
		// The path is attacker-controlled text like any other: it lands in the DOM
		// escaped, so a hostile destination cannot add a tag or an attribute.
		assert.equal(
			image({
				href: 'x.png" onerror="alert(1)',
				title: 'a "quoted" title',
				text: "<shot>",
			}),
			'<img class="message-media" data-media-source="x.png&quot; onerror=&quot;alert(1)" alt="&lt;shot&gt;" title="a &quot;quoted&quot; title">',
		);
	} finally {
		await loaded.dispose();
	}
});

test("an image the webview can load keeps its src", async () => {
	const loaded = await loadTranscript();
	try {
		const image = imageRenderer();

		// Pasted and inline images rendered before this renderer existed, and still
		// must: only sources the webview cannot fetch take the host round trip.
		assert.equal(
			image({
				href: "data:image/png;base64,AAAA",
				title: null,
				text: "pasted",
			}),
			'<img class="message-media" src="data:image/png;base64,AAAA" alt="pasted">',
		);
		// A remote URL is not one of them: the CSP allows no third-party image host,
		// so it goes to the resolver and comes back as its alt text rather than as a
		// broken image box.
		assert.equal(
			image({ href: "https://example.com/a.png", title: null, text: "remote" }),
			'<img class="message-media" data-media-source="https://example.com/a.png" alt="remote">',
		);
	} finally {
		await loaded.dispose();
	}
});
