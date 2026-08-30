import assert from "node:assert/strict";
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
		const message = (streaming) => ({
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
			message(true),
			results,
			liveTools,
			true,
			"message-1",
		);
		const settled = assistantMessageSections(
			message(false),
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
			sections[0].html.startsWith(`<div class="assistant-text" data-section-key`),
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
