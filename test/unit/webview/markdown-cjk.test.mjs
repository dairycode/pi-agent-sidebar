import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

// Real parser and extension; only the DOM-dependent sanitizer is stubbed.
async function loadRenderer() {
	return loadBundledModule({
		entry: "webview/transcript/renderer.ts",
		name: "markdown-cjk",
		platform: "browser",
		plugins: [{
			name: "mock-dompurify",
			setup(build) {
				build.onResolve({ filter: /^dompurify$/ }, () => ({ path: "dompurify", namespace: "mock" }));
				build.onLoad({ filter: /.*/, namespace: "mock" }, () => ({
					loader: "js",
					contents: "export default { sanitize: (html) => html };",
				}));
			},
		}],
	});
}

const cases = [
	["**剩余验证边界：**新增的手势", "<strong>剩余验证边界：</strong>新增的手势"],
	["**测试通过。**继续检查", "<strong>测试通过。</strong>继续检查"],
	["中文**（说明）**正文", "中文<strong>（说明）</strong>正文"],
	["中文__（说明）__正文", "中文<strong>（说明）</strong>正文"],
	["中文*（说明）*正文", "中文<em>（说明）</em>正文"],
	["**边界：**正文 *unfinished", "<strong>边界：</strong>正文 unfinished"],
	["`**边界：**正文`", "<code>**边界：**正文</code>"],
	["\\*\\*边界：\\*\\*正文", "**边界：**正文"],
	["**bold *nested* text**", "<strong>bold <em>nested</em> text</strong>"],
	["```text\n**边界：**正文\n```", "**边界：**正文</code>"],
	["~~removed~~", "<del>removed</del>"],
];

test("CJK emphasis renders in settled and active streaming Markdown", async () => {
	const loaded = await loadRenderer();
	try {
		for (const [source, expected] of cases) {
			const parts = loaded.module.streamingMarkdownParts(source);
			assert.ok((parts.stableHtml + parts.activeHtml).includes(expected), `stream: ${source}: ${parts.activeHtml}`);
			if (source.includes("unfinished")) continue;
			const html = loaded.module.messageHtml(
				{ role: "assistant", content: [{ type: "text", text: source }] },
				new Map(), new Map(), false, "cjk",
			);
			assert.ok(html.includes(expected), `settled: ${source}: ${html}`);
		}
	} finally {
		await loaded.dispose();
	}
});

test("CJK emphasis survives each suffix and promotion to a stable paragraph", async () => {
	const loaded = await loadRenderer();
	try {
		const prefix = "**剩余验证边界：**";
		const suffix = "新增的手势测试";
		for (let length = 0; length <= suffix.length; length += 1) {
			const parts = loaded.module.streamingMarkdownParts(prefix + suffix.slice(0, length));
			assert.ok(parts.activeHtml.includes("<strong>剩余验证边界：</strong>"));
		}
		const parts = loaded.module.streamingMarkdownParts(prefix + suffix + "\n\n后续段落");
		assert.ok(parts.stableHtml.includes("<strong>剩余验证边界：</strong>"));
	} finally {
		await loaded.dispose();
	}
});
