import type { JsonRecord } from "./protocol.js";

/**
 * Coercions for untrusted JSON coming off the pi RPC stream.
 *
 * Every reader of that stream needs the same "give me something usable or give
 * me an empty value" behaviour, so these live here rather than beside any one
 * caller: three byte-identical copies had already accumulated across the webview
 * and they are exactly the kind of helper that drifts apart once one copy is
 * tweaked.
 *
 * Each returns a benign empty value rather than throwing. A malformed event
 * should render as a blank field, not tear down the transcript.
 */

/** Arrays are rejected as well as primitives: callers want keyed access. */
export function objectValue(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: {};
}

export function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function numberValue(value: unknown): number {
	return typeof value === "number" ? value : 0;
}
