/**
 * Time formatting for the transcript and the session list.
 *
 * Every function is pure and takes `nowMs` explicitly. Reading the clock inside
 * a formatter would make the output untestable and would hide the host/webview
 * clock skew that Remote SSH introduces.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Rejects anything that is not a usable epoch-millisecond value. */
export function normalizeEpochMs(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	}
	if (typeof value === "string" && value.length > 0 && value.length <= 128) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	}
	return undefined;
}

/**
 * Compact relative label for the session list.
 *
 * Terse ("now", "5m ago", "3h ago") because the column is ~180px at its
 * narrowest; the full timestamp lives in the tooltip instead. `ago` is spelled
 * out because a bare "5m" does not say whether it is an age, a duration, or a
 * count.
 */
export function formatRelativeTime(
	epochMs: number,
	nowMs: number,
	locale?: string,
): string {
	const difference = nowMs - epochMs;
	// A message stamped slightly in the future (clock skew) reads as "now"
	// rather than as a negative age.
	if (difference < MINUTE_MS) return "just now";
	if (difference < HOUR_MS) return `${Math.floor(difference / MINUTE_MS)}m ago`;
	if (difference < DAY_MS) return `${Math.floor(difference / HOUR_MS)}h ago`;
	return formatShortDate(epochMs, locale);
}

/**
 * Wall-clock label for a transcript message, e.g. `14:32`.
 *
 * Absolute rather than relative: the transcript already carries day separators,
 * so the day is established by context and only the time of day is missing. A
 * bare relative label ("3h") answers a question the reader was not asking and
 * has to be decoded against the current time. It also never goes stale, so a
 * message stamp needs no refresh pass — unlike the session list, where recency
 * is the point.
 */
export function formatClockTime(epochMs: number, locale?: string): string {
	try {
		return new Intl.DateTimeFormat(locale || undefined, {
			timeStyle: "short",
		}).format(epochMs);
	} catch {
		return new Date(epochMs).toISOString().slice(11, 16);
	}
}

export function formatShortDate(epochMs: number, locale?: string): string {
	try {
		return new Intl.DateTimeFormat(locale || undefined, {
			month: "short",
			day: "numeric",
		}).format(epochMs);
	} catch {
		return new Date(epochMs).toISOString().slice(0, 10);
	}
}

/**
 * Full local time used as the tooltip and accessible label.
 *
 * Formatted in the reader's timezone: the machine running pi may be elsewhere,
 * and its timezone is not part of the message.
 */
export function formatAbsoluteTime(epochMs: number, locale?: string): string {
	try {
		return new Intl.DateTimeFormat(locale || undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(epochMs);
	} catch {
		return new Date(epochMs).toISOString();
	}
}

/**
 * Milliseconds until the relative label would change.
 *
 * Timers are scheduled to the next display boundary rather than to a fixed
 * interval, so an idle transcript does no periodic work. Returns `undefined`
 * once the label has become a static date and will never change again.
 */
export function nextRelativeBoundaryMs(
	epochMs: number,
	nowMs: number,
): number | undefined {
	const difference = nowMs - epochMs;
	if (difference < 0) return -difference + MINUTE_MS;
	if (difference < MINUTE_MS) return MINUTE_MS - difference;
	if (difference < HOUR_MS) return MINUTE_MS - (difference % MINUTE_MS);
	if (difference < DAY_MS) return HOUR_MS - (difference % HOUR_MS);
	return undefined;
}

/**
 * Picks the soonest boundary across every visible timestamp.
 *
 * One timer for the whole transcript: a timer per message would mean hundreds
 * of wakeups for a long conversation.
 */
export function nextRefreshDelayMs(
	epochValues: readonly number[],
	nowMs: number,
): number | undefined {
	let soonest: number | undefined;
	for (const epochMs of epochValues) {
		const delay = nextRelativeBoundaryMs(epochMs, nowMs);
		if (delay === undefined) continue;
		if (soonest === undefined || delay < soonest) soonest = delay;
	}
	// Never busier than once a second, even if several boundaries nearly coincide.
	return soonest === undefined ? undefined : Math.max(soonest, 1_000);
}

/**
 * Whether a date separator belongs between two messages.
 *
 * Compared in the reader's local calendar day, so a conversation spanning
 * midnight is split where the reader would expect.
 */
export function isNewLocalDay(
	previousEpochMs: number | undefined,
	epochMs: number,
): boolean {
	if (previousEpochMs === undefined) return true;
	const previous = new Date(previousEpochMs);
	const current = new Date(epochMs);
	return (
		previous.getFullYear() !== current.getFullYear() ||
		previous.getMonth() !== current.getMonth() ||
		previous.getDate() !== current.getDate()
	);
}

export function formatDaySeparator(
	epochMs: number,
	nowMs: number,
	locale?: string,
): string {
	const today = new Date(nowMs);
	const value = new Date(epochMs);
	const sameDay =
		today.getFullYear() === value.getFullYear() &&
		today.getMonth() === value.getMonth() &&
		today.getDate() === value.getDate();
	if (sameDay) return "Today";
	const yesterday = new Date(nowMs - DAY_MS);
	if (
		yesterday.getFullYear() === value.getFullYear() &&
		yesterday.getMonth() === value.getMonth() &&
		yesterday.getDate() === value.getDate()
	) {
		return "Yesterday";
	}
	try {
		return new Intl.DateTimeFormat(locale || undefined, {
			dateStyle: "long",
		}).format(epochMs);
	} catch {
		return new Date(epochMs).toISOString().slice(0, 10);
	}
}

/**
 * Formats token and cost details for the usage panel.
 *
 * `null` is preserved as "unavailable": pi reports null context usage right
 * after compaction, and showing 0% there would be a lie.
 */
export function formatTokenCount(value: unknown, locale?: string): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	try {
		return new Intl.NumberFormat(locale || undefined).format(Math.round(value));
	} catch {
		return String(Math.round(value));
	}
}

export function formatCost(value: unknown, locale?: string): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	try {
		return new Intl.NumberFormat(locale || undefined, {
			style: "currency",
			currency: "USD",
			minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
			maximumFractionDigits: 4,
		}).format(value);
	} catch {
		return `$${value.toFixed(4)}`;
	}
}

/**
 * Wall-clock span between the first and last activity.
 *
 * Explicitly a wall-clock span, not compute time: the gap includes however long
 * the user was away from the keyboard.
 */
export function formatDuration(
	fromEpochMs: number | undefined,
	toEpochMs: number | undefined,
): string | undefined {
	if (fromEpochMs === undefined || toEpochMs === undefined) return undefined;
	const span = toEpochMs - fromEpochMs;
	if (!Number.isFinite(span) || span < 0) return undefined;
	if (span < MINUTE_MS) return "under a minute";
	if (span < HOUR_MS) return `${Math.floor(span / MINUTE_MS)} min`;
	if (span < DAY_MS) {
		const hours = Math.floor(span / HOUR_MS);
		const minutes = Math.floor((span % HOUR_MS) / MINUTE_MS);
		return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
	}
	const days = Math.floor(span / DAY_MS);
	const hours = Math.floor((span % DAY_MS) / HOUR_MS);
	return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
}
