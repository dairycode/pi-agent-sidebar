import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

/**
 * `WORKSPACE_PATH_PATTERN` decides which transcript text becomes a clickable
 * workspace path, so what it refuses matters as much as what it matches.
 *
 * Two regressions are pinned here:
 *
 * - The pattern used `\b`, which treats the dot in `.vscode/settings.json` as a
 *   word boundary. Matching then began after the dot and `linkifyWorkspacePaths`
 *   produced `vscode/settings.json` — a path that does not open.
 * - `\b` also matched inside a URL, so `https://github.com/org/repo.ts`
 *   linkified `github.com/org/repo.ts`. Requiring the preceding character to be
 *   neither a word character nor a path separator rejects both.
 */
async function loadPattern() {
	return loadBundledModule({
		entry: "webview/transcript/workspacePaths.ts",
		name: "workspace-paths",
		platform: "browser",
	});
}

function findPaths(pattern, text) {
	pattern.lastIndex = 0;
	return [...text.matchAll(pattern)].map((match) =>
		match[2] === undefined ? match[1] : `${match[1]}:${match[2]}`,
	);
}

test("workspace paths survive a leading dot and a line suffix", async () => {
	const loaded = await loadPattern();
	try {
		const { WORKSPACE_PATH_PATTERN: pattern } = loaded.module;
		const cases = [
			[
				"see .github/workflows/ci.yml and src/app.ts:42",
				[".github/workflows/ci.yml", "src/app.ts:42"],
			],
			["check .vscode/settings.json", [".vscode/settings.json"]],
			["edit .pi/agent/config.json", [".pi/agent/config.json"]],
			["open src/a..b.ts", ["src/a..b.ts"]],
			["src/app.ts is here", ["src/app.ts"]],
			["see src/app.ts.", ["src/app.ts"]],
			["详见（src/nested/deep/app.ts）", ["src/nested/deep/app.ts"]],
			["`src/nested/deep/app.ts`", ["src/nested/deep/app.ts"]],
		];
		for (const [text, expected] of cases) {
			assert.deepEqual(findPaths(pattern, text), expected, text);
		}
	} finally {
		await loaded.dispose();
	}
});

test("workspace paths do not start inside a longer path or a URL", async () => {
	const loaded = await loadPattern();
	try {
		const { WORKSPACE_PATH_PATTERN: pattern } = loaded.module;
		const cases = [
			// A whole path matches, not the tail of one.
			["a/src/app.ts", ["a/src/app.ts"]],
			["https://github.com/org/repo.ts", []],
			["file:///workspace/src/app.ts", []],
			// Not a path: no directory segment.
			[".gitignore", []],
			["no path here", []],
			["", []],
		];
		for (const [text, expected] of cases) {
			assert.deepEqual(findPaths(pattern, text), expected, text);
		}
	} finally {
		await loaded.dispose();
	}
});
