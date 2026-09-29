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

/**
 * Formatting runs per visible message on every streaming delta, and building an
 * `Intl` formatter costs far more than formatting with one. The locale is fixed
 * for a session, so each call site should build its formatter once and keep it —
 * and a locale change must still produce a new one rather than reusing the old.
 */
test("formatters are built once per locale rather than per call", async () => {
	const loaded = await loadMessageTime();
	const realDateTimeFormat = Intl.DateTimeFormat;
	const realNumberFormat = Intl.NumberFormat;
	let dateConstructions = 0;
	let numberConstructions = 0;
	// Subclasses, not plain functions: the module calls these with `new`, and an
	// arrow function cannot be constructed — it throws, the module falls back to its
	// `catch` branch, and the counters below would read zero for the wrong reason.
	class CountingDateTimeFormat extends realDateTimeFormat {
		constructor(...args) {
			super(...args);
			dateConstructions += 1;
		}
	}
	class CountingNumberFormat extends realNumberFormat {
		constructor(...args) {
			super(...args);
			numberConstructions += 1;
		}
	}
	Intl.DateTimeFormat = CountingDateTimeFormat;
	Intl.NumberFormat = CountingNumberFormat;
	try {
		const {
			formatAbsoluteTime,
			formatCost,
			formatDaySeparator,
			formatRelativeTime,
			formatTokenCount,
		} = loaded.module;
		const now = Date.parse("2026-03-04T05:06:07.000Z");
		const threeDaysAgo = now - 3 * DAY;
		for (let repeat = 0; repeat < 50; repeat += 1) {
			formatRelativeTime(threeDaysAgo, now, "en");
			formatAbsoluteTime(now, "en");
			formatDaySeparator(threeDaysAgo, now, "en");
			formatTokenCount(12_345, "en");
			formatCost(0.0042, "en");
			formatCost(1.23, "en");
		}
		// Three date call sites, three number variants. Not 300.
		assert.equal(dateConstructions, 3);
		assert.equal(numberConstructions, 3);

		formatAbsoluteTime(now, "de");
		assert.equal(dateConstructions, 4, "a new locale needs its own formatter");

		// The cached formatter still formats, and these must be the real localised
		// labels: the module's `catch` branches return ISO slices and a bare number, so
		// a mistake in this test's stubs would otherwise show up as a passing zero.
		assert.equal(formatRelativeTime(threeDaysAgo, now, "en"), "Mar 1");
		assert.equal(formatDaySeparator(threeDaysAgo, now, "en"), "March 1, 2026");
		assert.equal(formatTokenCount(1_234_567, "en"), "1,234,567");
	} finally {
		Intl.DateTimeFormat = realDateTimeFormat;
		Intl.NumberFormat = realNumberFormat;
		await loaded.dispose();
	}
});
