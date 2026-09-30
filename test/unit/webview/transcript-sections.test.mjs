import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadSections() {
	return loadBundledModule({
		entry: "webview/transcript/renderer.ts",
		name: "transcript-sections",
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

test("streaming thinking paragraphs keep their settled spacing", async () => {
	const css = await readFile("webview/styles/transcript.css", "utf8");
	assert.match(
		css,
		/\.thinking-text p \+ p,\s*\.thinking-text > p \+ \.streaming-markdown-active > p:first-child\s*\{\s*margin-top: var\(--pi-line-half\);\s*\}/u,
		"the active paragraph must receive its final margin before it becomes stable",
	);
});

test("a collapsed tool box clips from its first frame, body or not", async () => {
	const css = await readFile("webview/styles/transcript.css", "utf8");
	// The clip must not be qualified by `.expandable`: a call is drawn before its
	// output exists, and a box that only starts clipping once it has a body
	// changes height in the middle of the run.
	assert.match(
		css,
		/\.tool-call:not\(\.expanded\) \.tool-command,\s*\.tool-call:not\(\.expanded\) \.tool-header,\s*\.skill-block:not\(\.expanded\) \.skill-header\s*\{\s*display: flex;\s*align-items: baseline;\s*white-space: nowrap;\s*\}/u,
		"every collapsed header stays on one line",
	);
	assert.match(
		css,
		/\.tool-call:not\(\.expanded\) \.header-text,\s*\.skill-block:not\(\.expanded\) \.header-text\s*\{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*\}/u,
		"the clipped header needs a shrinkable box to draw its ellipsis in",
	);
});

test("a running call breathes on its border, the header carries only the output column", async () => {
	const css = await readFile("webview/styles/transcript.css", "utf8");
	// The call's status lives on the box: a running border breathes between a
	// faint and the full-strength pending edge, with a halo swelling around it.
	// The header carries no glyph, so nothing in the row enters or leaves the
	// layout when the state changes — the `output` column every header clips
	// against keeps its width, and the ellipsis never moves. Both ends of the
	// breath derive from the palette's pending token, which is also the box's
	// static running edge: key frames outrank it while the breath runs, so
	// `prefers-reduced-motion` can drop the animation and the tint — with the
	// sr-only note — still carries the state. Forced-colours mode overrides
	// tint and halo both, so there the border style carries the state instead.
	assert.match(
		css,
		/\.tool-call\.running\s*\{\s*animation: tool-breathe [^}]*\}/u,
		"the running state is what starts the breath",
	);
	assert.match(
		css,
		/\.tool-call\.running\s*\{[^}]*border-color: var\(--pi-theme-tool-pending-border\);/u,
		"the tint is the static half: a frame without the animation still reads as pending",
	);
	assert.match(
		css,
		/from\s*\{\s*border-color: color-mix\(\s*in srgb,\s*var\(--pi-theme-tool-pending-border\) 45%,\s*transparent\s*\);\s*box-shadow: 0 0 0 0 transparent;\s*\}/su,
		"the faint end of the breath mixes the pending border toward transparent",
	);
	assert.match(
		css,
		/to\s*\{\s*border-color: var\(--pi-theme-tool-pending-border\);\s*box-shadow: 0 0 0 3px\s*color-mix\(\s*in srgb,\s*var\(--pi-theme-tool-pending-border\) 25%,\s*transparent\);\s*\}/su,
		"the bright end is the pending border itself, with the halo at low strength",
	);
	assert.match(
		css,
		/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.tool-call\.running\s*\{\s*animation: none;\s*\}\s*\}/u,
		"the animation can be dropped without silencing the state",
	);
	assert.match(
		css,
		/@media \(forced-colors: active\)\s*\{\s*\.tool-call\.running\s*\{\s*border-style: dashed;\s*\}\s*\}/u,
		"forced-colours overrides tint and halo, so the surviving border channel carries the state",
	);
	assert.match(
		css,
		/\.tool-call\.running \.tool-hint\s*\{\s*visibility: hidden;\s*\}/u,
		"the hint waits for the call to land instead of sharing the line",
	);
	assert.match(
		css,
		/\.tool-call:not\(\.expandable\) \.tool-hint\s*\{\s*visibility: hidden;\s*\}/u,
		"a call with nothing to reveal keeps the column empty, not absent",
	);
	assert.match(
		css,
		/\.tool-call:not\(\.expanded\) \.header-trail\s*\{\s*margin-left: auto;\s*\}/u,
		"the output column rides the row's right edge, not the end of its text",
	);
	assert.match(
		css,
		/\.tool-hint\s*\{[^}]*margin-left: 7px;/su,
		"the word keeps a gap from the ellipsis it sits beside, or it reads as the command's own continuation",
	);
	assert.doesNotMatch(
		css,
		/\.skill-block:not\(\.expanded\) \.header-trail[^{]*\{[^}]*margin-left: auto/u,
		"a skill card's line count stays beside the name it counts",
	);
	assert.doesNotMatch(
		css,
		/tool-spinner/u,
		"the header carries no status glyph any more",
	);
});

test("a new user turn gets a full-line boundary without moving the composer", async () => {
	const [transcriptCss, composerCss, mainSource] = await Promise.all([
		readFile("webview/styles/transcript.css", "utf8"),
		readFile("webview/styles/composer.css", "utf8"),
		readFile("webview/main.ts", "utf8"),
	]);
	assert.match(
		transcriptCss,
		/\.message-slot:not\(\.user-turn\) \+ \.message-slot\.user-turn\s*\{\s*margin-top: var\(--pi-line-half\);\s*\}/u,
	);
	assert.match(
		mainSource,
		/classList\.toggle\("user-turn", message\.role === "user"\)/u,
	);
	assert.match(
		composerCss,
		/\.composer-shell\s*\{[^}]*padding: 7px 7px 9px;/su,
	);
});

test("only the active collapsed streaming thinking animates", async () => {
	const loaded = await loadSections();
	try {
		const { assistantMessageSections } = loaded.module;
		const render = (content, streaming = true, expandedKeys) =>
			assistantMessageSections(
				{ role: "assistant", content },
				new Map(),
				new Map(),
				streaming,
				"message-1",
				false,
				expandedKeys,
			);
		const thinking = { type: "thinking", thinking: "working" };

		const active = render([thinking]);
		assert.match(active[0].html, /thinking-activity is-active-thinking/u);
		assert.match(
			active[0].html,
			/<span class="thinking-label">Thinking<\/span><span class="thinking-dots" aria-hidden="true"><span class="thinking-dot-one">\.<\/span><span class="thinking-dot-two">\.<\/span><span class="thinking-dot-three">\.<\/span><\/span>/u,
		);

		const beforeText = render([thinking, { type: "text", text: "answer" }]);
		assert.doesNotMatch(beforeText[0].html, /is-active-thinking/u);
		const beforeTool = render([
			thinking,
			{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
		]);
		assert.doesNotMatch(beforeTool[0].html, /is-active-thinking/u);

		const expanded = render(
			[thinking],
			true,
			new Set(["message-1-thinking-0"]),
		);
		assert.doesNotMatch(expanded[0].html, /is-active-thinking/u);
		const settled = render([thinking], false);
		assert.doesNotMatch(settled[0].html, /is-active-thinking/u);
	} finally {
		await loaded.dispose();
	}
});

test("thinking animation preserves layout and respects reduced motion", async () => {
	const [transcriptCss, responsiveCss] = await Promise.all([
		readFile("webview/styles/transcript.css", "utf8"),
		readFile("webview/styles/responsive.css", "utf8"),
	]);
	assert.match(transcriptCss, /\.thinking-dots\s*\{[^}]*width: 1\.5em;/su);
	assert.match(
		transcriptCss,
		/\.thinking-collapsed\s*\{\s*animation: thinking-breathe 2\.4s/u,
	);
	assert.match(
		transcriptCss,
		/\.thinking-dot-one\s*\{\s*animation: thinking-dot-one 2s/u,
	);
	assert.match(
		transcriptCss,
		/\.thinking-dot-two\s*\{\s*animation: thinking-dot-two/u,
	);
	assert.match(
		transcriptCss,
		/\.thinking-dot-three\s*\{\s*animation: thinking-dot-three/u,
	);
	assert.match(
		responsiveCss,
		/prefers-reduced-motion: reduce[\s\S]*\.thinking-dot-one[\s\S]*\.thinking-dot-two[\s\S]*\.thinking-dot-three[\s\S]*animation: none;/u,
	);
});

test("section keys are stable while a text block grows", async () => {
	const loaded = await loadSections();
	try {
		const { assistantMessageSections } = loaded.module;
		const results = new Map();
		const liveTools = new Map();

		const grow = (text) =>
			assistantMessageSections(
				{ role: "assistant", content: [{ type: "text", text }] },
				results,
				liveTools,
				true,
				"message-1",
			);

		const first = grow("Hello ");
		const second = grow("Hello world");

		assert.deepEqual(
			first.map((section) => section.key),
			["content-0"],
		);
		assert.deepEqual(
			second.map((section) => section.key),
			["content-0"],
			"a growing text block must keep its key",
		);
		assert.notEqual(
			first[0].hash,
			second[0].hash,
			"changed content must change the hash",
		);
	} finally {
		await loaded.dispose();
	}
});

test("a settled message and its streaming twin keep the same keys", async () => {
	const loaded = await loadSections();
	try {
		const { assistantMessageSections } = loaded.module;
		const results = new Map();
		const liveTools = new Map();
		const message = () => ({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Reasoning..." },
				{ type: "text", text: "Answer" },
				{
					type: "toolCall",
					id: "tool-1",
					name: "edit",
					arguments: { path: "src/file.ts" },
				},
			],
		});

		const streamed = assistantMessageSections(
			message(),
			results,
			liveTools,
			true,
			"message-1",
		);
		const settled = assistantMessageSections(
			message(),
			results,
			liveTools,
			false,
			"message-1",
		);

		assert.deepEqual(
			streamed.map((section) => section.key),
			["activity-0", "content-0", "activity-1"],
		);
		assert.deepEqual(
			settled.map((section) => section.key),
			["activity-0", "content-0", "activity-1"],
			"settling must not reshuffle section keys",
		);
	} finally {
		await loaded.dispose();
	}
});

test("streaming text renders Markdown before the settled highlight pass", async () => {
	const loaded = await loadSections();
	try {
		const { assistantMessageSections } = loaded.module;
		const results = new Map();
		const liveTools = new Map();
		const message = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "**reasoning** <unsafe>" },
				{ type: "text", text: "**answer** <unsafe>" },
			],
		};

		const streamed = assistantMessageSections(
			message,
			results,
			liveTools,
			true,
			"message-1",
			false,
			new Set(["message-1-thinking-0"]),
		);
		assert.match(streamed[0].html, /<p>\*\*reasoning\*\* <unsafe><\/p>/u);
		assert.match(streamed[1].html, /<p>\*\*answer\*\* <unsafe><\/p>/u);
		assert.equal(streamed[0].streamUpdate.text, "**reasoning** <unsafe>");
		assert.equal(streamed[0].streamUpdate.format, "markdown");
		assert.equal(streamed[1].streamUpdate.text, "**answer** <unsafe>");
		assert.equal(streamed[1].streamUpdate.format, "markdown");

		const settled = assistantMessageSections(
			message,
			results,
			liveTools,
			false,
			"message-1",
			false,
			new Set(["message-1-thinking-0"]),
		);
		assert.match(settled[0].html, /<p>\*\*reasoning\*\* <unsafe><\/p>/u);
		assert.match(settled[1].html, /<p>\*\*answer\*\* <unsafe><\/p>/u);
		assert.equal(settled[0].streamUpdate, undefined);
		assert.equal(settled[1].streamUpdate, undefined);

		// Without the key set, both forms stay collapsed: no body, no streaming
		// update — the collapsed settle is the hot path a reader never pays for.
		const collapsed = assistantMessageSections(
			message,
			results,
			liveTools,
			false,
			"message-1",
		);
		assert.doesNotMatch(collapsed[0].html, /<p>|<\/p>/u);
		assert.equal(collapsed[0].streamUpdate, undefined);
	} finally {
		await loaded.dispose();
	}
});

test("streaming thinking updates independently from an adjacent tool", async () => {
	const loaded = await loadSections();
	try {
		const { assistantMessageSections } = loaded.module;
		const toolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "read",
			arguments: { path: "src/file.ts" },
		};
		const render = (thinking) =>
			assistantMessageSections(
				{
					role: "assistant",
					content: [{ type: "thinking", thinking }, toolCall],
				},
				new Map(),
				new Map(),
				true,
				"message-1",
				true,
				new Set(["message-1-thinking-0"]),
			);

		const before = render("Inspect");
		const after = render("Inspect the result <carefully>");

		assert.deepEqual(
			after.map((section) => section.key),
			["activity-0", "activity-1"],
			"thinking and tools need separate stable patch targets",
		);
		assert.equal(after[0].streamUpdate.text, "Inspect the result <carefully>");
		assert.equal(after[0].streamUpdate.format, "markdown");
		assert.notEqual(after[0].hash, before[0].hash);
		assert.equal(
			after[1].hash,
			before[1].hash,
			"growing thinking must not rebuild its neighbouring tool",
		);
		assert.match(after[1].html, /src\/file\.ts/u);
	} finally {
		await loaded.dispose();
	}
});

test("appending a tool call adds a section without shifting earlier keys", async () => {
	const loaded = await loadSections();
	try {
		const { assistantMessageSections } = loaded.module;
		const results = new Map();
		const liveTools = new Map();

		const before = assistantMessageSections(
			{
				role: "assistant",
				content: [{ type: "text", text: "Planning" }],
			},
			results,
			liveTools,
			true,
			"message-1",
		);
		const after = assistantMessageSections(
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Planning" },
					{
						type: "toolCall",
						id: "tool-1",
						name: "write",
						arguments: { path: "src/file.ts" },
					},
				],
			},
			results,
			liveTools,
			true,
			"message-1",
		);

		assert.deepEqual(
			before.map((section) => section.key),
			["content-0"],
		);
		assert.deepEqual(
			after.map((section) => section.key),
			["content-0", "activity-0"],
			"a trailing tool call must append, not shift",
		);
		assert.equal(after[0].hash, before[0].hash);
	} finally {
		await loaded.dispose();
	}
});

test("sections carry the marker attributes the streaming patcher reads", async () => {
	const loaded = await loadSections();
	try {
		const { assistantMessageSections } = loaded.module;
		const results = new Map();
		const liveTools = new Map();

		const sections = assistantMessageSections(
			{
				role: "assistant",
				content: [{ type: "text", text: "Marked text" }],
			},
			results,
			liveTools,
			true,
			"message-1",
		);

		assert.match(
			sections[0].html,
			/data-section-key="content-0"/u,
			"the marker must ride on the section root",
		);
		assert.match(
			sections[0].html,
			/data-section-hash="[a-z0-9]+"/u,
			"the content hash must ride on the section root",
		);
		assert.ok(
			sections[0].html.startsWith(
				`<div class="assistant-text" data-section-key`,
			),
			"the marker must be injected into the root tag, not a child",
		);
	} finally {
		await loaded.dispose();
	}
});

test("the hash is content-derived and independent of the marker", async () => {
	const loaded = await loadSections();
	try {
		const { assistantMessageSections } = loaded.module;
		const results = new Map();
		const liveTools = new Map();

		const a = assistantMessageSections(
			{ role: "assistant", content: [{ type: "text", text: "Same" }] },
			results,
			liveTools,
			true,
			"message-1",
		);
		const b = assistantMessageSections(
			{ role: "assistant", content: [{ type: "text", text: "Same" }] },
			results,
			liveTools,
			true,
			"message-2",
		);

		assert.equal(a[0].hash, b[0].hash, "hash must ignore message keys");
		assert.match(a[0].html, /data-section-key="content-0"/u);
	} finally {
		await loaded.dispose();
	}
});
