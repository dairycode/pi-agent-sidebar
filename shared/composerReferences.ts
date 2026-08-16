import type {
	FileComposerReference,
	JsonRecord,
	SelectionComposerReference,
} from "./protocol.js";

export interface FileReferencePayload {
	path: string;
	displayPath: string;
	marker: string;
	/** Canonical source URI used to reopen references from submitted messages. */
	uri?: string;
}

export interface SelectionReferencePayload extends FileReferencePayload {
	languageId: string;
	startLine: number;
	endLine: number;
	text: string;
}

const MAX_SERIALIZED_TEXT_LENGTH = 1_000_000;

type ReferencePayloadCandidate = FileReferencePayload & JsonRecord;

export function shouldSnapshotFileReference(
	scheme: string,
	isDirty: boolean,
): boolean {
	return scheme === "untitled" || isDirty;
}

export function selectedLineRange(
	startLine: number,
	endLine: number,
	endCharacter: number,
): { startLine: number; endLine: number } {
	const firstLine = startLine + 1;
	const inclusiveEndLine =
		endCharacter === 0 && endLine > startLine ? endLine : endLine + 1;
	return {
		startLine: firstLine,
		endLine: Math.max(firstLine, inclusiveEndLine),
	};
}

export function nearestOffset(anchor: number, ...candidates: number[]): number {
	let nearest = -1;
	for (const candidate of candidates) {
		if (candidate < 0) continue;
		if (
			nearest < 0 ||
			Math.abs(candidate - anchor) < Math.abs(nearest - anchor)
		) {
			nearest = candidate;
		}
	}
	return nearest;
}

export function formatComposerReferenceLocation(
	reference:
		| Pick<FileComposerReference, "kind" | "displayPath">
		| Pick<
				SelectionComposerReference,
				"kind" | "displayPath" | "startLine" | "endLine"
		  >,
): string {
	if (reference.kind === "file") return reference.displayPath;
	return reference.endLine === reference.startLine
		? `${reference.displayPath}:${reference.startLine}`
		: `${reference.displayPath}:${reference.startLine}-${reference.endLine}`;
}

export function formatFileReferenceMarker(displayPath: string): string {
	return `@${displayPath.replace(/[\r\n]+/gu, " ")}`;
}

export function formatSelectionReferenceMarker(
	displayPath: string,
	startLine: number,
	endLine: number,
): string {
	const path = displayPath.replace(/[\r\n]+/gu, " ");
	return endLine === startLine
		? `@${path}#${startLine}`
		: `@${path}#${startLine}-${endLine}`;
}

export function uniqueComposerReferenceMarker(
	baseMarker: string,
	id: string,
	usedMarkers: ReadonlySet<string>,
): string {
	if (!usedMarkers.has(baseMarker)) return baseMarker;
	const suffix = id.replace(/[^a-z0-9]/giu, "").slice(0, 6) || "ref";
	let candidate = `${baseMarker}~${suffix}`;
	let ordinal = 2;
	while (usedMarkers.has(candidate)) {
		candidate = `${baseMarker}~${suffix}-${ordinal}`;
		ordinal += 1;
	}
	return candidate;
}

export function insertComposerReferenceMarker(
	text: string,
	offset: number,
	marker: string,
): { text: string; caret: number; markerStart: number; markerEnd: number } {
	const insertionOffset = Math.max(0, Math.min(offset, text.length));
	const before = text.slice(0, insertionOffset);
	const after = text.slice(insertionOffset);
	const leadingSpace = before.length > 0 && !/\s$/u.test(before) ? " " : "";
	const trailingSpace = after.length === 0 || !/^\s/u.test(after) ? " " : "";
	const insertion = `${leadingSpace}${marker}${trailingSpace}`;
	const markerStart = insertionOffset + leadingSpace.length;
	return {
		text: `${before}${insertion}${after}`,
		caret: insertionOffset + insertion.length,
		markerStart,
		markerEnd: markerStart + marker.length,
	};
}

export function findComposerReferenceMarker(
	text: string,
	marker: string,
	fromIndex = 0,
): number {
	if (!marker) return -1;
	let index = text.indexOf(marker, Math.max(0, fromIndex));
	while (index >= 0) {
		const before = index > 0 ? text[index - 1] : undefined;
		const afterIndex = index + marker.length;
		const after = afterIndex < text.length ? text[afterIndex] : undefined;
		if ((!before || /\s/u.test(before)) && (!after || /\s/u.test(after))) {
			return index;
		}
		index = text.indexOf(marker, index + 1);
	}
	return -1;
}

export function hasComposerReferenceMarker(
	text: string,
	marker: string,
): boolean {
	return findComposerReferenceMarker(text, marker) >= 0;
}

export function removeComposerReferenceMarker(
	text: string,
	marker: string,
): string {
	let result = text;
	let index = findComposerReferenceMarker(result, marker);
	while (index >= 0) {
		let start = index;
		let end = index + marker.length;
		const hasLeadingSpace = start > 0 && /[\t ]/u.test(result[start - 1] ?? "");
		const hasTrailingSpace =
			end < result.length && /[\t ]/u.test(result[end] ?? "");
		if (hasLeadingSpace && hasTrailingSpace) end += 1;
		else if (start === 0 && hasTrailingSpace) end += 1;
		else if (end === result.length && hasLeadingSpace) start -= 1;
		result = `${result.slice(0, start)}${result.slice(end)}`;
		index = findComposerReferenceMarker(result, marker);
	}
	return result;
}

export function expandComposerReferenceRemovalRange(
	text: string,
	range: { start: number; end: number },
): { start: number; end: number } {
	let { start, end } = range;
	const hasLeadingSpace = start > 0 && /[\t ]/u.test(text[start - 1] ?? "");
	const hasTrailingSpace = end < text.length && /[\t ]/u.test(text[end] ?? "");
	if (hasLeadingSpace && hasTrailingSpace) end += 1;
	else if (start === 0 && hasTrailingSpace) end += 1;
	else if (end === text.length && hasLeadingSpace) start -= 1;
	return { start, end };
}

export function removeComposerReferenceRanges(
	text: string,
	ranges: Array<{ start: number; end: number }>,
): string {
	let result = text;
	const sorted = [...ranges].sort((left, right) => right.start - left.start);
	let nextStart = text.length;
	for (const range of sorted) {
		if (
			!Number.isInteger(range.start) ||
			!Number.isInteger(range.end) ||
			range.start < 0 ||
			range.end <= range.start ||
			range.end > result.length ||
			range.end > nextStart
		) {
			throw new Error("Invalid composer reference range.");
		}
		const removal = expandComposerReferenceRemovalRange(result, range);
		result = `${result.slice(0, removal.start)}${result.slice(removal.end)}`;
		nextStart = removal.start;
	}
	return result;
}

export function serializeContextValue(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

export function serializeSelectionReferencePayload(
	reference: SelectionReferencePayload,
): string {
	return serializeContextValue(reference);
}

export function parseFileReferencePayload(
	value: string,
): FileReferencePayload | undefined {
	return parseReferencePayloadCandidate(value);
}

function parseReferencePayloadCandidate(
	value: string,
): ReferencePayloadCandidate | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	return isReferencePayloadCandidate(parsed) ? parsed : undefined;
}

export function parseSelectionReferencePayload(
	value: string,
): SelectionReferencePayload | undefined {
	const candidate = parseReferencePayloadCandidate(value);
	return candidate && isSelectionReferencePayload(candidate)
		? candidate
		: undefined;
}

function isJsonRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isReferencePayloadCandidate(
	value: unknown,
): value is ReferencePayloadCandidate {
	return (
		isJsonRecord(value) &&
		[value.path, value.displayPath, value.marker].every(
			(field) => typeof field === "string" && field.length > 0,
		) &&
		(value.uri === undefined ||
			(typeof value.uri === "string" && value.uri.length > 0))
	);
}

function isSelectionReferencePayload(
	value: ReferencePayloadCandidate,
): value is ReferencePayloadCandidate & SelectionReferencePayload {
	const { languageId, startLine, endLine, text } = value;
	return (
		typeof languageId === "string" &&
		isPositiveInteger(startLine) &&
		isPositiveInteger(endLine) &&
		endLine >= startLine &&
		typeof text === "string" &&
		text.length <= MAX_SERIALIZED_TEXT_LENGTH
	);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}
