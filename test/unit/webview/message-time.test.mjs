import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadMessageTime() {
	return loadBundledModule({
		entry: "webview/transcript/messageTime.ts",
		name: "message-time",
		platform: "browser",
	});
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("epoch normalization accepts pi's two timestamp shapes and rejects junk", async () => {
	const loaded = await loadMessageTime();
	try {
		const { normalizeEpochMs } = loaded.module;
		// `get_messages` reports epoch milliseconds.
		assert.equal(normalizeEpochMs(1767323041000), 1767323041000);
		// Session entries and the session list report ISO strings.
		assert.equal(
			normalizeEpochMs("2026-01-02T03:04:01.000Z"),
			Date.parse("2026-01-02T03:04:01.000Z"),
		);
		for (const invalid of [
			undefined,
			null,
			0,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"",
			"not a date",
			{},
			"x".repeat(200),
		]) {
			assert.equal(
				normalizeEpochMs(invalid),
				undefined,
				`expected ${String(invalid)} to be rejected`,
			);
		}
	} finally {
		await loaded.dispose();
	}
});

test("relative labels stay compact and never read as negative", async () => {
	const loaded = await loadMessageTime();
	try {
		const { formatRelativeTime } = loaded.module;
		const now = Date.parse("2026-03-01T12:00:00.000Z");
		// `ago` is spelled out: a bare "5m" does not say whether it is an age, a
		// duration, or a count.
		assert.equal(formatRelativeTime(now, now, "en-US"), "just now");
		assert.equal(formatRelativeTime(now - 59_000, now, "en-US"), "just now");
		assert.equal(formatRelativeTime(now - MINUTE, now, "en-US"), "1m ago");
		assert.equal(formatRelativeTime(now - 59 * MINUTE, now, "en-US"), "59m ago");
		assert.equal(formatRelativeTime(now - HOUR, now, "en-US"), "1h ago");
		assert.equal(formatRelativeTime(now - 23 * HOUR, now, "en-US"), "23h ago");
		// Past a day it becomes a short date rather than a growing hour count.
		assert.match(formatRelativeTime(now - 3 * DAY, now, "en-US"), /Feb/u);
		// Host/webview clock skew can put a message slightly in the future; that
		// must read as the present, not as a negative age.
		assert.equal(formatRelativeTime(now + 5_000, now, "en-US"), "just now");
	} finally {
		await loaded.dispose();
	}
});

test("refresh timers wake at the next label boundary, not on a fixed interval", async () => {
	const loaded = await loadMessageTime();
	try {
		const { nextRelativeBoundaryMs, nextRefreshDelayMs } = loaded.module;
		const now = Date.parse("2026-03-01T12:00:00.000Z");

		// 40s old: the label flips to "1m" in 20s.
		assert.equal(nextRelativeBoundaryMs(now - 40_000, now), 20_000);
		// 90s old: the next minute rolls over in 30s.
		assert.equal(nextRelativeBoundaryMs(now - 90_000, now), 30_000);
		// 90min old: the hour count changes in 30min.
		assert.equal(nextRelativeBoundaryMs(now - 90 * MINUTE, now), 30 * MINUTE);
		// Already a static date: never needs refreshing again.
		assert.equal(nextRelativeBoundaryMs(now - 3 * DAY, now), undefined);

		// One timer for the whole transcript, set to the soonest boundary.
		assert.equal(
			nextRefreshDelayMs([now - 40_000, now - 90 * MINUTE, now - 3 * DAY], now),
			20_000,
		);
		// Nothing left to refresh once every label is a static date.
		assert.equal(
			nextRefreshDelayMs([now - 3 * DAY, now - 9 * DAY], now),
			undefined,
		);
		assert.equal(nextRefreshDelayMs([], now), undefined);
		// Floored at 1s so several near-coincident boundaries cannot busy-loop.
		assert.equal(nextRefreshDelayMs([now - 59_900], now), 1_000);
	} finally {
		await loaded.dispose();
	}
});

test("date separators break on the local calendar day", async () => {
	const loaded = await loadMessageTime();
	try {
		const { isNewLocalDay, formatDaySeparator } = loaded.module;
		const noon = new Date(2026, 2, 1, 12, 0, 0).getTime();
		const laterSameDay = new Date(2026, 2, 1, 23, 30, 0).getTime();
		const nextDay = new Date(2026, 2, 2, 0, 30, 0).getTime();

		// The first message always opens a day group.
		assert.equal(isNewLocalDay(undefined, noon), true);
		assert.equal(isNewLocalDay(noon, laterSameDay), false);
		// Crossing local midnight starts a new group even 1h apart.
		assert.equal(isNewLocalDay(laterSameDay, nextDay), true);

		assert.equal(formatDaySeparator(noon, noon, "en-US"), "Today");
		assert.equal(formatDaySeparator(noon, nextDay, "en-US"), "Yesterday");
		// Anything older gets an explicit date rather than a vague age.
		assert.match(
			formatDaySeparator(noon, noon + 10 * DAY, "en-US"),
			/March 1, 2026/u,
		);
	} finally {
		await loaded.dispose();
	}
});

test("usage formatting keeps null distinguishable from zero", async () => {
	const loaded = await loadMessageTime();
	try {
		const { formatTokenCount, formatCost } = loaded.module;
		assert.equal(formatTokenCount(105000, "en-US"), "105,000");
		assert.equal(formatTokenCount(0, "en-US"), "0");
		// pi reports null context usage right after compaction. It must not render
		// as 0, which would claim an empty context window.
		assert.equal(formatTokenCount(null, "en-US"), "—");
		assert.equal(formatTokenCount(undefined, "en-US"), "—");

		assert.equal(formatCost(0.45, "en-US"), "$0.45");
		// A sub-cent cost keeps enough precision to not read as free.
		assert.equal(formatCost(0.0002, "en-US"), "$0.0002");
		assert.equal(formatCost(null, "en-US"), "—");
	} finally {
		await loaded.dispose();
	}
});
