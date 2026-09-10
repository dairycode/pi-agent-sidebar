import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadStreamUsage() {
	return loadBundledModule({
		entry: "webview/streamUsage.ts",
		name: "stream-usage",
		platform: "browser",
	});
}

/**
 * pi 的 Usage 形状，字段名与 RPC 线上的 `message_update.usage` /
 * `message.usage` 一致。
 */
function piUsage({
	input = 0,
	output = 0,
	cacheRead = 0,
	cacheWrite = 0,
	cost = 0,
} = {}) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

/** A snapshot stats object as `get_session_stats` reports it. */
function sessionStats({
	contextWindow = 1000,
	contextTokens = 500,
	tokens = { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50 },
	cost = 1.5,
} = {}) {
	return {
		totalMessages: 8,
		toolCalls: 3,
		cost,
		tokens: {
			...tokens,
			total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
		},
		contextUsage: {
			tokens: contextTokens,
			contextWindow,
			percent:
				contextTokens === null ? null : (contextTokens / contextWindow) * 100,
		},
	};
}

const BASE_TOKEN_TOTAL = 1650;

test("parses a pi usage payload into tokens and cost", async () => {
	const loaded = await loadStreamUsage();
	try {
		const parsed = loaded.module.parseUsageParts(
			piUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 5 }),
		);
		assert.deepEqual(parsed, {
			tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
			cost: 5,
		});
	} finally {
		await loaded.dispose();
	}
});

test("treats a missing cost breakdown as zero cost", async () => {
	const loaded = await loadStreamUsage();
	try {
		const parsed = loaded.module.parseUsageParts({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
		});
		assert.equal(parsed.cost, 0);
		assert.equal(loaded.module.usagePartsTotal(parsed), 10);
	} finally {
		await loaded.dispose();
	}
});

test("rejects payloads that are not usable usage", async () => {
	const loaded = await loadStreamUsage();
	try {
		const { parseUsageParts } = loaded.module;
		assert.equal(parseUsageParts(undefined), undefined);
		assert.equal(parseUsageParts(null), undefined);
		assert.equal(parseUsageParts("100"), undefined);
		assert.equal(parseUsageParts(100), undefined);
		assert.equal(
			parseUsageParts({ input: "1", output: 2, cacheRead: 3, cacheWrite: 4 }),
			undefined,
		);
		assert.equal(
			parseUsageParts({ input: NaN, output: 2, cacheRead: 3, cacheWrite: 4 }),
			undefined,
		);
		assert.equal(
			parseUsageParts({
				input: Infinity,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
			}),
			undefined,
		);
		assert.equal(
			parseUsageParts({ input: 1, output: 2, cacheRead: 3 }),
			undefined,
		);
	} finally {
		await loaded.dispose();
	}
});

test("adds and inspects usage parts without mutating inputs", async () => {
	const loaded = await loadStreamUsage();
	try {
		const { addUsageParts, isEmptyUsageParts, zeroUsageParts, usagePartsTotal } =
			loaded.module;
		const base = {
			tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
			cost: 0.5,
		};
		const extra = {
			tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
			cost: 1.5,
		};
		const sum = addUsageParts(base, extra);
		assert.deepEqual(sum, {
			tokens: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 },
			cost: 2,
		});
		assert.equal(usagePartsTotal(sum), 110);
		assert.deepEqual(base.tokens, {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
		});
		assert.deepEqual(extra.tokens, {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
		});
		assert.equal(isEmptyUsageParts(zeroUsageParts()), true);
		assert.equal(isEmptyUsageParts({ ...zeroUsageParts(), cost: 0.01 }), false);
		assert.equal(
			isEmptyUsageParts({
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1 },
				cost: 0,
			}),
			false,
		);
	} finally {
		await loaded.dispose();
	}
});

test("returns the snapshot unchanged while nothing is streaming", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		const stats = sessionStats();
		assert.equal(tracker.displayStats(stats), stats);
		assert.equal(tracker.displayStats(undefined), undefined);
		assert.equal(tracker.hasLiveUsage(), false);
	} finally {
		await loaded.dispose();
	}
});

test("accumulates every finished round instead of replacing the previous one", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.applyUpdate(piUsage({ input: 200, output: 50 }));
		tracker.commitCall(piUsage({ input: 200, output: 50, cost: 0.02 }), "stop");
		tracker.applyUpdate(piUsage({ input: 400, output: 100, cost: 0.03 }));
		tracker.commitCall(piUsage({ input: 400, output: 100, cost: 0.03 }), "stop");

		const displayed = tracker.displayStats(sessionStats());
		assert.equal(displayed.tokens.input, 1000 + 200 + 400);
		assert.equal(displayed.tokens.output, 500 + 50 + 100);
		assert.equal(displayed.tokens.cacheRead, 100);
		assert.equal(displayed.tokens.cacheWrite, 50);
		assert.equal(displayed.tokens.total, BASE_TOKEN_TOTAL + 250 + 500);
		assert.equal(displayed.cost, 1.5 + 0.02 + 0.03);
	} finally {
		await loaded.dispose();
	}
});

test("counts an in-flight call once, not twice, across its commit", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.applyUpdate(piUsage({ input: 250, cost: 0.01 }));
		assert.equal(
			tracker.displayStats(sessionStats()).tokens.total,
			BASE_TOKEN_TOTAL + 250,
		);
		tracker.commitCall(piUsage({ input: 250, cost: 0.01 }), "stop");
		assert.equal(
			tracker.displayStats(sessionStats()).tokens.total,
			BASE_TOKEN_TOTAL + 250,
		);
		assert.equal(tracker.displayStats(sessionStats()).cost, 1.51);
	} finally {
		await loaded.dispose();
	}
});

test("shows progress for an in-flight call before it is committed", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.applyUpdate(piUsage({ input: 250 }));
		const inFlight = tracker.displayStats(sessionStats());
		assert.equal(inFlight.contextUsage.tokens, 250);
		assert.equal(inFlight.contextUsage.percent, 25);
	} finally {
		await loaded.dispose();
	}
});

test("derives context from the latest call, not the running total", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.commitCall(piUsage({ input: 250 }), "stop");
		assert.equal(tracker.displayStats(sessionStats()).contextUsage.percent, 25);

		tracker.beginCall();
		tracker.applyUpdate(piUsage({ input: 500 }));
		const displayed = tracker.displayStats(sessionStats());
		assert.equal(displayed.contextUsage.tokens, 500);
		assert.equal(displayed.contextUsage.percent, 50);
		assert.equal(displayed.contextUsage.contextWindow, 1000);
	} finally {
		await loaded.dispose();
	}
});

test("keeps the previous context while the provider reports all-zero usage", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.commitCall(piUsage({ input: 250 }), "stop");
		tracker.beginCall();
		tracker.applyUpdate(piUsage());
		assert.equal(tracker.displayStats(sessionStats()).contextUsage.percent, 25);
	} finally {
		await loaded.dispose();
	}
});

test("skips aborted and errored calls for context but still counts their tokens", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.commitCall(piUsage({ input: 250 }), "stop");
		tracker.beginCall();
		tracker.commitCall(piUsage({ input: 600, cost: 0.04 }), "aborted");
		let displayed = tracker.displayStats(sessionStats());
		assert.equal(displayed.contextUsage.percent, 25);
		assert.equal(displayed.tokens.total, BASE_TOKEN_TOTAL + 250 + 600);

		tracker.beginCall();
		tracker.commitCall(piUsage({ input: 750, cost: 0.05 }), "error");
		displayed = tracker.displayStats(sessionStats());
		assert.equal(displayed.contextUsage.percent, 25);
		assert.equal(displayed.tokens.total, BASE_TOKEN_TOTAL + 250 + 600 + 750);
	} finally {
		await loaded.dispose();
	}
});

test("never reports context from an all-zero committed call", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.commitCall(piUsage(), "stop");
		const displayed = tracker.displayStats(sessionStats({ contextTokens: 321 }));
		assert.equal(displayed.contextUsage.tokens, 321);
	} finally {
		await loaded.dispose();
	}
});

test("counts tool usage in session totals without moving context", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.commitCall(piUsage({ input: 250 }), "stop");
		tracker.addToolUsage(piUsage({ input: 1000, cost: 0.5 }));
		const displayed = tracker.displayStats(sessionStats());
		assert.equal(displayed.contextUsage.percent, 25);
		assert.equal(displayed.tokens.total, BASE_TOKEN_TOTAL + 250 + 1000);
		assert.equal(displayed.cost, 2);
	} finally {
		await loaded.dispose();
	}
});

test("fills the post-compaction null context as soon as a call reports usage", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		const compacted = sessionStats({ contextTokens: null });
		assert.equal(tracker.displayStats(compacted).contextUsage.tokens, null);

		tracker.startAgentRun();
		tracker.applyUpdate(piUsage({ input: 250 }));
		const displayed = tracker.displayStats(compacted);
		assert.equal(displayed.contextUsage.tokens, 250);
		assert.equal(displayed.contextUsage.percent, 25);
	} finally {
		await loaded.dispose();
	}
});

test("leaves context alone when the snapshot has no usable window", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.applyUpdate(piUsage({ input: 250 }));

		const noContext = { totalMessages: 1, cost: 0 };
		assert.equal(tracker.displayStats(noContext).contextUsage, undefined);

		const zeroWindow = {
			...noContext,
			contextUsage: { tokens: 10, contextWindow: 0, percent: 1 },
		};
		assert.equal(tracker.displayStats(zeroWindow).contextUsage.tokens, 10);
	} finally {
		await loaded.dispose();
	}
});

test("starts from the fresh snapshot after a reset", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.applyUpdate(piUsage({ input: 250 }));

		tracker.reset();
		const authoritative = sessionStats();
		assert.equal(tracker.displayStats(authoritative), authoritative);

		tracker.applyUpdate(piUsage({ input: 500 }));
		assert.equal(
			tracker.displayStats(authoritative).tokens.total,
			BASE_TOKEN_TOTAL + 500,
		);
	} finally {
		await loaded.dispose();
	}
});

test("each agent run starts over from the snapshot it was given", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.commitCall(piUsage({ input: 250 }), "stop");
		assert.equal(
			tracker.displayStats(sessionStats()).tokens.total,
			BASE_TOKEN_TOTAL + 250,
		);

		// 第二次运行前宿主已刷新 snapshot，新的权威值已包含上一轮的 250。
		const refreshed = sessionStats({
			tokens: { input: 1250, output: 500, cacheRead: 100, cacheWrite: 50 },
		});
		tracker.startAgentRun();
		tracker.applyUpdate(piUsage({ input: 500 }));
		assert.equal(
			tracker.displayStats(refreshed).tokens.total,
			BASE_TOKEN_TOTAL + 250 + 500,
		);
	} finally {
		await loaded.dispose();
	}
});

test("treats a snapshot without token or cost fields as zero base", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.commitCall(piUsage({ input: 250, cost: 0.02 }), "stop");
		const displayed = tracker.displayStats({
			contextUsage: { contextWindow: 1000 },
		});
		assert.deepEqual(displayed.tokens, {
			input: 250,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 250,
		});
		assert.equal(displayed.cost, 0.02);
	} finally {
		await loaded.dispose();
	}
});

test("keeps unrelated snapshot fields untouched", async () => {
	const loaded = await loadStreamUsage();
	try {
		const tracker = new loaded.module.StreamingUsageTracker();
		tracker.startAgentRun();
		tracker.commitCall(piUsage({ input: 250 }), "stop");
		const stats = sessionStats();
		const displayed = tracker.displayStats(stats);
		assert.equal(displayed.totalMessages, stats.totalMessages);
		assert.equal(displayed.toolCalls, stats.toolCalls);
		assert.notEqual(displayed, stats);
	} finally {
		await loaded.dispose();
	}
});
