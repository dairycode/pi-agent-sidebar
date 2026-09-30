import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadGroups() {
	return loadBundledModule({
		entry: "webview/transcript/thinkingGroups.ts",
		name: "thinking-groups",
	});
}

test("a run of adjacent thinking blocks becomes one group", async () => {
	const loaded = await loadGroups();
	try {
		const { thinkingGroups, thinkingGroupKeyIndex } = loaded.module;
		// The shape GPT streams: one `thinking` block per reasoning part.
		const blocks = [
			{ type: "thinking", thinking: "first part" },
			{ type: "thinking", thinking: "second part" },
			{ type: "thinking", thinking: "third part" },
			{ type: "text", text: "the answer" },
		];
		const groups = thinkingGroups(blocks);
		assert.equal(groups.length, 1);
		assert.equal(groups[0].startIndex, 0);
		assert.equal(groups[0].endIndex, 3);
		assert.equal(groups[0].blocks.length, 3);
		assert.equal(
			groups[0].text,
			"first part\n\nsecond part\n\nthird part",
			"parts are joined by a blank line, each one already being a block of headline",
		);
		// Every part keys the same section, or one part would expand on its own.
		for (const ordinal of [0, 1, 2]) {
			assert.equal(thinkingGroupKeyIndex(blocks, ordinal), 0);
		}
	} finally {
		await loaded.dispose();
	}
});

test("group text and key lookup avoid eager reasoning reads", async () => {
	const loaded = await loadGroups();
	try {
		const { thinkingGroups, thinkingGroupKeyIndex } = loaded.module;
		let reads = 0;
		const blocks = [
			{
				type: "thinking",
				get thinking() {
					reads += 1;
					return "first part";
				},
			},
			{
				type: "thinking",
				get thinking() {
					reads += 1;
					return "second part";
				},
			},
		];
		const groups = thinkingGroups(blocks);
		assert.equal(reads, 0, "group structure must not build hidden reasoning text");
		assert.equal(thinkingGroupKeyIndex(blocks, 1), 0);
		assert.equal(reads, 0, "key lookup must not read reasoning text");
		assert.equal(groups[0].text, "first part\n\nsecond part");
		assert.equal(reads, 2);
		assert.equal(groups[0].text, "first part\n\nsecond part");
		assert.equal(reads, 2, "group text should be memoized after expansion");
	} finally {
		await loaded.dispose();
	}
});

test("a blank text block does not split a run", async () => {
	const loaded = await loadGroups();
	try {
		const { thinkingGroups } = loaded.module;
		const groups = thinkingGroups([
			{ type: "thinking", thinking: "first part" },
			{ type: "text", text: "  \n " },
			{ type: "thinking", thinking: "second part" },
		]);
		assert.equal(groups.length, 1, "an invisible block must not split the section");
		assert.equal(groups[0].blocks.length, 2);
		assert.equal(groups[0].endIndex, 3);
	} finally {
		await loaded.dispose();
	}
});

test("visible content between reasoning parts keeps them apart", async () => {
	const loaded = await loadGroups();
	try {
		const { thinkingGroups, thinkingGroupKeyIndex } = loaded.module;
		const blocks = [
			{ type: "thinking", thinking: "before the call" },
			{ type: "text", text: "prose" },
			{ type: "thinking", thinking: "after the prose" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: {} },
			{ type: "thinking", thinking: "after the call" },
		];
		assert.deepEqual(
			thinkingGroups(blocks).map((group) => [group.startIndex, group.endIndex]),
			[
				[0, 1],
				[2, 3],
				[4, 5],
			],
		);
		assert.equal(thinkingGroupKeyIndex(blocks, 0), 0);
		assert.equal(thinkingGroupKeyIndex(blocks, 1), 1);
		assert.equal(thinkingGroupKeyIndex(blocks, 2), 2);
	} finally {
		await loaded.dispose();
	}
});

test("empty parts are held out of the joined text", async () => {
	const loaded = await loadGroups();
	try {
		const { thinkingGroups } = loaded.module;
		// A streaming frame: the second part has started but holds nothing yet.
		const streaming = thinkingGroups([
			{ type: "thinking", thinking: "first part" },
			{ type: "thinking", thinking: "" },
		]);
		assert.equal(streaming[0].text, "first part");
		// An empty part contributes no separator, so the text only ever grows at
		// its end — which is what lets the stream patcher append to the DOM node.
		const filled = thinkingGroups([
			{ type: "thinking", thinking: "first part" },
			{ type: "thinking", thinking: "second" },
		]);
		assert.ok(filled[0].text.startsWith(streaming[0].text));
	} finally {
		await loaded.dispose();
	}
});

test("a thinking ordinal the message does not hold keys itself", async () => {
	const loaded = await loadGroups();
	try {
		const { thinkingGroupKeyIndex, thinkingGroups } = loaded.module;
		const blocks = [
			{ type: "thinking", thinking: "first part" },
			{ type: "thinking", thinking: "second part" },
		];
		assert.equal(thinkingGroupKeyIndex(blocks, 1), 0);
		assert.equal(thinkingGroupKeyIndex(blocks, 2), 2);
		assert.deepEqual(thinkingGroups([]), []);
	} finally {
		await loaded.dispose();
	}
});
