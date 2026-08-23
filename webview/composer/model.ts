import {
	expandComposerReferenceRemovalRange,
	insertComposerReferenceMarker,
} from "../../shared/composerReferences.js";
import {
	MAX_COMPOSER_REFERENCE_COUNT,
	type ComposerReference,
} from "../../shared/protocol.js";

export type ManagedComposerReference = ComposerReference & {
	start: number;
	end: number;
};

interface PersistedReferenceCandidate {
	id?: unknown;
	revision?: unknown;
	marker?: unknown;
	displayPath?: unknown;
	kind?: unknown;
	startLine?: unknown;
	endLine?: unknown;
	start?: unknown;
	end?: unknown;
}

export interface ComposerEditResult {
	references: ManagedComposerReference[];
	removed: ManagedComposerReference[];
}

export function parsePersistedReferences(
	value: unknown,
	text: string,
): ManagedComposerReference[] {
	if (!Array.isArray(value) || value.length > MAX_COMPOSER_REFERENCE_COUNT)
		return [];
	const references: ManagedComposerReference[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const candidate = item as PersistedReferenceCandidate;
		if (
			typeof candidate.id !== "string" ||
			candidate.id.length === 0 ||
			typeof candidate.revision !== "number" ||
			!Number.isSafeInteger(candidate.revision) ||
			candidate.revision < 0 ||
			typeof candidate.marker !== "string" ||
			candidate.marker.length === 0 ||
			typeof candidate.displayPath !== "string" ||
			(candidate.kind !== "file" &&
				candidate.kind !== "directory" &&
				candidate.kind !== "selection") ||
			typeof candidate.start !== "number" ||
			typeof candidate.end !== "number"
		) {
			return [];
		}
		let reference: ManagedComposerReference;
		if (candidate.kind === "file" || candidate.kind === "directory") {
			reference = {
				kind: candidate.kind,
				id: candidate.id,
				revision: candidate.revision,
				marker: candidate.marker,
				displayPath: candidate.displayPath,
				start: candidate.start,
				end: candidate.end,
			};
		} else {
			if (
				typeof candidate.startLine !== "number" ||
				!Number.isSafeInteger(candidate.startLine) ||
				candidate.startLine < 1 ||
				typeof candidate.endLine !== "number" ||
				!Number.isSafeInteger(candidate.endLine) ||
				candidate.endLine < candidate.startLine
			)
				return [];
			reference = {
				kind: "selection",
				id: candidate.id,
				revision: candidate.revision,
				marker: candidate.marker,
				displayPath: candidate.displayPath,
				startLine: candidate.startLine,
				endLine: candidate.endLine,
				start: candidate.start,
				end: candidate.end,
			};
		}
		const key = `${reference.id}:${reference.revision}`;
		if (seen.has(key) || !isManagedReferenceValid(text, reference)) return [];
		seen.add(key);
		references.push(reference);
	}
	return references;
}

export function isManagedReferenceValid(
	text: string,
	reference: ManagedComposerReference,
): boolean {
	return (
		Number.isInteger(reference.start) &&
		Number.isInteger(reference.end) &&
		reference.start >= 0 &&
		reference.end === reference.start + reference.marker.length &&
		reference.end <= text.length &&
		text.slice(reference.start, reference.end) === reference.marker
	);
}

export function reconcileComposerEdit(
	previousText: string,
	nextText: string,
	references: ManagedComposerReference[],
): ComposerEditResult {
	if (previousText === nextText) return { references, removed: [] };

	let prefixLength = 0;
	const sharedLength = Math.min(previousText.length, nextText.length);
	while (
		prefixLength < sharedLength &&
		previousText[prefixLength] === nextText[prefixLength]
	) {
		prefixLength += 1;
	}

	let suffixLength = 0;
	while (
		suffixLength < previousText.length - prefixLength &&
		suffixLength < nextText.length - prefixLength &&
		previousText[previousText.length - suffixLength - 1] ===
			nextText[nextText.length - suffixLength - 1]
	) {
		suffixLength += 1;
	}

	const oldEnd = previousText.length - suffixLength;
	const newEnd = nextText.length - suffixLength;
	const delta = newEnd - oldEnd;
	const insertion = oldEnd === prefixLength;
	const kept: ManagedComposerReference[] = [];
	const removed: ManagedComposerReference[] = [];

	for (const reference of references) {
		let adjusted = reference;
		if (insertion) {
			if (prefixLength <= reference.start) {
				adjusted = {
					...reference,
					start: reference.start + delta,
					end: reference.end + delta,
				};
			} else if (prefixLength < reference.end) {
				removed.push(reference);
				continue;
			}
		} else if (oldEnd <= reference.start) {
			adjusted = {
				...reference,
				start: reference.start + delta,
				end: reference.end + delta,
			};
		} else if (prefixLength < reference.end && oldEnd > reference.start) {
			removed.push(reference);
			continue;
		}

		if (isManagedReferenceValid(nextText, adjusted)) kept.push(adjusted);
		else removed.push(reference);
	}

	return { references: kept, removed };
}

export function insertManagedReference(
	text: string,
	caret: number,
	reference: ComposerReference,
	references: ManagedComposerReference[],
): { text: string; caret: number; references: ManagedComposerReference[] } {
	let insertionOffset = Math.max(0, Math.min(caret, text.length));
	for (const existing of references) {
		if (insertionOffset > existing.start && insertionOffset <= existing.end) {
			insertionOffset = existing.end;
			break;
		}
	}
	const insertion = insertComposerReferenceMarker(
		text,
		insertionOffset,
		reference.marker,
	);
	const adjusted = reconcileComposerEdit(text, insertion.text, references);
	return {
		text: insertion.text,
		caret: insertion.caret,
		references: [
			...adjusted.references,
			{
				...reference,
				start: insertion.markerStart,
				end: insertion.markerEnd,
			},
		],
	};
}

export function removeManagedReferences(
	text: string,
	references: ManagedComposerReference[],
	identities: Array<{ id: string; revision: number }>,
): { text: string; references: ManagedComposerReference[] } {
	const removedKeys = new Set(
		identities.map((identity) => `${identity.id}:${identity.revision}`),
	);
	const targets = references
		.filter((reference) =>
			removedKeys.has(`${reference.id}:${reference.revision}`),
		)
		.sort((left, right) => right.start - left.start);
	let currentText = text;
	let currentReferences = references;
	for (const target of targets) {
		const removal = expandComposerReferenceRemovalRange(currentText, target);
		const delta = removal.start - removal.end;
		currentReferences = currentReferences.flatMap((reference) => {
			if (
				reference.id === target.id &&
				reference.revision === target.revision
			) {
				return [];
			}
			if (reference.end <= removal.start) return [reference];
			if (reference.start >= removal.end) {
				return [
					{
						...reference,
						start: reference.start + delta,
						end: reference.end + delta,
					},
				];
			}
			return [];
		});
		currentText = `${currentText.slice(0, removal.start)}${currentText.slice(removal.end)}`;
	}
	return { text: currentText, references: currentReferences };
}

export function referenceAtOffset(
	references: ManagedComposerReference[],
	offset: number,
): ManagedComposerReference | undefined {
	return references.find(
		(reference) => offset >= reference.start && offset <= reference.end,
	);
}
