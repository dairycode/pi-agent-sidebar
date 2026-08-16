import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadCommandHighlights() {
	return loadBundledModule({
		entry: "webview/composer/commandHighlights.ts",
		name: "command-highlights",
	});
}

test("complete valid slash commands are highlighted without their arguments", async () => {
	const loaded = await loadCommandHighlights();
	try {
		const text = "/compact now\n/explain src/main.ts\nplain /compact";
		assert.deepEqual(
			loaded.module.commandHighlightRanges(text, ["compact", "explain"]),
			[
				{ start: 0, end: "/compact".length },
				{
					start: "/compact now\n".length,
					end: "/compact now\n/explain".length,
				},
			],
		);
	} finally {
		await loaded.dispose();
	}
});

test("unknown, incomplete, case-mismatched, and path tokens stay unhighlighted", async () => {
	const loaded = await loadCommandHighlights();
	try {
		const text = [
			"/comp",
			"/unknown",
			"/Compact",
			"src/main.ts",
			"plain /compact",
		].join("\n");
		assert.deepEqual(
			loaded.module.commandHighlightRanges(text, ["compact"]),
			[],
		);
	} finally {
		await loaded.dispose();
	}
});

test("command matching uses the exact token up to any whitespace", async () => {
	const loaded = await loadCommandHighlights();
	try {
		const text = "/deploy\tprod\n/deploy\u00a0staging";
		assert.deepEqual(
			loaded.module.commandHighlightRanges(text, new Set(["deploy"])),
			[
				{ start: 0, end: 7 },
				{ start: 13, end: 20 },
			],
		);
	} finally {
		await loaded.dispose();
	}
});
