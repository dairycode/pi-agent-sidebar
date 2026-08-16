import {
	formatComposerReferenceLocation,
	formatFileReferenceMarker,
	insertComposerReferenceMarker,
} from "../../shared/composerReferences.js";
import type {
	ComposerReference,
	WebviewToHostMessage,
} from "../../shared/protocol.js";
import {
	insertManagedReference,
	isManagedReferenceValid,
	parsePersistedReferences,
	reconcileComposerEdit,
	referenceAtOffset,
	removeManagedReferences,
	type ManagedComposerReference,
} from "./model.js";

export interface ComposerPendingAction {
	type: string;
	draft?: string;
	referenceSnapshots?: ManagedComposerReference[];
}

export interface ComposerEditor {
	value: string;
	selectionStart: number;
	setSelectionRange(start: number, end: number): void;
	focus(): void;
}

export interface ComposerControllerOptions {
	editor: ComposerEditor;
	persist(draft: string, references: ManagedComposerReference[]): void;
	post(message: WebviewToHostMessage): void;
	announce(message: string): void;
	invalidate(): void;
	refreshEditorView(): void;
	isEditorActive(): boolean;
	pendingActions(): Iterable<ComposerPendingAction>;
}

export class ComposerController {
	private activeReferences: ManagedComposerReference[] = [];
	private pendingReferences: ManagedComposerReference[] = [];
	private readonly restoredReferences: Map<string, ManagedComposerReference>;
	private readonly locallyRemovedRevisions = new Map<string, number>();
	private textSnapshot: string;
	private rememberedCaret = 0;
	private pendingReferenceSequence = 0;

	public constructor(
		private readonly options: ComposerControllerOptions,
		persistedReferences: unknown,
	) {
		this.textSnapshot = options.editor.value;
		this.restoredReferences = new Map(
			parsePersistedReferences(persistedReferences, options.editor.value).map(
				(reference) => [reference.id, reference],
			),
		);
	}

	public get references(): readonly ManagedComposerReference[] {
		return this.activeReferences;
	}

	public get referenceCount(): number {
		return this.activeReferences.length + this.pendingReferences.length;
	}

	public get hasPendingReferences(): boolean {
		return this.pendingReferences.length > 0;
	}

	public get lastCaret(): number {
		return this.rememberedCaret;
	}

	public rememberCaret(): void {
		const caret = this.options.editor.selectionStart;
		if (typeof caret === "number") this.rememberedCaret = caret;
	}

	public handleInput(): void {
		this.reconcileInput();
		this.rememberCaret();
		this.persist();
		this.options.refreshEditorView();
	}

	public snapshotReferences(): ManagedComposerReference[] {
		return this.activeReferences.map((reference) => ({ ...reference }));
	}

	public managedReferences(): ManagedComposerReference[] {
		const references = new Map<string, ManagedComposerReference>();
		for (const reference of this.activeReferences) {
			if (isManagedReferenceValid(this.options.editor.value, reference)) {
				references.set(`${reference.id}:${reference.revision}`, reference);
			}
		}
		for (const reference of this.pendingReferences) {
			if (isManagedReferenceValid(this.options.editor.value, reference)) {
				references.set(`${reference.id}:${reference.revision}`, reference);
			}
		}
		for (const action of this.options.pendingActions()) {
			for (const reference of action.referenceSnapshots ?? []) {
				if (isManagedReferenceValid(this.options.editor.value, reference)) {
					references.set(`${reference.id}:${reference.revision}`, reference);
				}
			}
		}
		for (const reference of this.restoredReferences.values()) {
			if (isManagedReferenceValid(this.options.editor.value, reference)) {
				references.set(`${reference.id}:${reference.revision}`, reference);
			}
		}
		return [...references.values()];
	}

	public applyIncoming(
		incoming: ComposerReference[],
	): ManagedComposerReference[] {
		const references = this.acceptIncoming(incoming);
		const previousById = new Map(
			this.activeReferences.map((reference) => [reference.id, reference]),
		);
		const acceptedIds = new Set(references.map((reference) => reference.id));
		const restoredOrphans = [...this.restoredReferences.values()].filter(
			(reference) => !acceptedIds.has(reference.id),
		);
		if (restoredOrphans.length > 0) {
			this.activeReferences.push(...restoredOrphans);
			this.removeManaged(restoredOrphans);
		}
		const stale = this.activeReferences.filter(
			(reference) =>
				!acceptedIds.has(reference.id) && !this.isPending(reference),
		);
		this.removeManaged(stale);
		this.activeReferences = this.activeReferences.filter((reference) =>
			acceptedIds.has(reference.id),
		);

		const changed: ManagedComposerReference[] = [];
		for (const summary of references) {
			const current = this.activeReferences.find(
				(reference) => reference.id === summary.id,
			);
			const restored = this.restoredReferences.get(summary.id);
			this.restoredReferences.delete(summary.id);
			const actionPending = this.managedReferences().find(
				(reference) =>
					reference.id === summary.id && reference.marker === summary.marker,
			);
			const localPending = this.pendingReferences.find(
				(reference) =>
					reference.kind === summary.kind &&
					reference.marker === summary.marker &&
					reference.displayPath === summary.displayPath,
			);
			const candidate = [current, restored, actionPending, localPending].find(
				(reference): reference is ManagedComposerReference =>
					Boolean(
						reference &&
							reference.marker === summary.marker &&
							isManagedReferenceValid(this.options.editor.value, reference),
					),
			);
			if (candidate) {
				const updated = {
					...summary,
					start: candidate.start,
					end: candidate.end,
				};
				this.activeReferences = this.activeReferences.filter(
					(reference) => reference.id !== summary.id,
				);
				if (localPending) {
					this.pendingReferences = this.pendingReferences.filter(
						(reference) => reference.id !== localPending.id,
					);
				}
				this.activeReferences.push(updated);
				if (
					localPending ||
					previousById.get(summary.id)?.revision !== summary.revision
				) {
					changed.push(updated);
				}
				continue;
			}

			const previousText = this.options.editor.value;
			const caretSource = this.options.isEditorActive()
				? (this.options.editor.selectionStart ?? this.rememberedCaret)
				: this.rememberedCaret;
			const insertion = insertManagedReference(
				previousText,
				Math.min(caretSource, previousText.length),
				summary,
				this.activeReferences,
			);
			this.reconcilePendingEdits(previousText, insertion.text);
			this.activeReferences = insertion.references;
			this.writeDraft(insertion.text, insertion.caret);
			const inserted = this.activeReferences.find(
				(reference) => reference.id === summary.id,
			);
			if (inserted) changed.push(inserted);
		}
		this.activeReferences.sort((left, right) => left.start - right.start);
		this.persist();
		return changed;
	}

	public setText(text: string): void {
		const references = this.activeReferences.map(
			({ start: _start, end: _end, ...reference }) => reference,
		);
		this.reconcilePendingEdits(this.options.editor.value, text);
		this.activeReferences = [];
		this.writeDraft(text, text.length);
		this.applyIncoming(references);
		this.options.editor.focus();
	}

	public reconcileInput(): void {
		const nextText = this.options.editor.value;
		const result = reconcileComposerEdit(
			this.textSnapshot,
			nextText,
			this.activeReferences,
		);
		this.reconcilePendingEdits(this.textSnapshot, nextText);
		this.activeReferences = result.references;
		const pendingResult = reconcileComposerEdit(
			this.textSnapshot,
			nextText,
			this.pendingReferences,
		);
		this.pendingReferences = pendingResult.references;
		this.textSnapshot = nextText;
		for (const reference of result.removed) {
			this.locallyRemovedRevisions.set(reference.id, reference.revision);
			this.options.post({
				type: "removeComposerReference",
				id: reference.id,
				revision: reference.revision,
			});
		}
		if (result.removed.length > 0) {
			const first = result.removed[0];
			const label =
				result.removed.length === 1 && first
					? formatComposerReferenceLocation(first)
					: `${result.removed.length} references`;
			this.options.announce(`Removed ${label}`);
			this.options.invalidate();
		}
	}

	public replaceRange(start: number, end: number, insertion: string): number {
		const text = this.options.editor.value;
		const caret = start + insertion.length;
		this.options.editor.value = `${text.slice(0, start)}${insertion}${text.slice(end)}`;
		this.options.editor.setSelectionRange(caret, caret);
		this.rememberedCaret = caret;
		this.reconcileInput();
		this.persist();
		this.options.refreshEditorView();
		return caret;
	}

	/**
	 * Replaces an `@query` with its final marker before the host round-trip.
	 * The host-owned reference adopts this exact range in applyIncoming(), so
	 * the composer never paints an empty intermediate frame.
	 */
	public stageFileReference(
		displayPath: string,
		start: number,
		end: number,
	): string {
		const previousText = this.options.editor.value;
		const textWithoutQuery = `${previousText.slice(0, start)}${previousText.slice(end)}`;
		const marker = formatFileReferenceMarker(displayPath);
		const insertion = insertComposerReferenceMarker(
			textWithoutQuery,
			start,
			marker,
		);
		this.options.editor.value = insertion.text;
		this.options.editor.setSelectionRange(insertion.caret, insertion.caret);
		this.reconcileInput();

		const id = `pending-file-${++this.pendingReferenceSequence}`;
		this.pendingReferences.push({
			kind: "file",
			id,
			revision: 0,
			marker,
			displayPath,
			start: insertion.markerStart,
			end: insertion.markerEnd,
		});
		this.rememberedCaret = insertion.caret;
		this.persist();
		this.options.refreshEditorView();
		this.options.invalidate();
		return id;
	}

	public discardPendingReference(id: string): void {
		const pending = this.pendingReferences.find(
			(reference) => reference.id === id,
		);
		if (!pending) return;
		this.removeManaged([pending]);
	}

	public referenceAtOffset(
		offset: number,
	): ManagedComposerReference | undefined {
		return referenceAtOffset(
			[...this.activeReferences, ...this.pendingReferences],
			offset,
		);
	}

	public isPendingReference(id: string): boolean {
		return this.pendingReferences.some((reference) => reference.id === id);
	}

	public completeSubmittedReferences(action: ComposerPendingAction): void {
		const submittedReferences = new Map(
			(action.referenceSnapshots ?? []).map((reference) => [
				reference.id,
				reference.revision,
			]),
		);
		this.activeReferences = this.activeReferences.filter(
			(reference) =>
				submittedReferences.get(reference.id) !== reference.revision,
		);
		const activeKeys = new Set(
			this.activeReferences.map(
				(reference) => `${reference.id}:${reference.revision}`,
			),
		);
		if (this.options.editor.value === action.draft) {
			const activeReferences = this.activeReferences.map(
				({ start: _start, end: _end, ...reference }) => reference,
			);
			this.activeReferences = [];
			this.writeDraft("", 0);
			this.applyIncoming(activeReferences);
		} else {
			this.removeManaged(
				(action.referenceSnapshots ?? []).filter(
					(reference) =>
						!activeKeys.has(`${reference.id}:${reference.revision}`),
				),
			);
		}
	}

	private acceptIncoming(references: ComposerReference[]): ComposerReference[] {
		const incomingById = new Map(
			references.map((reference) => [reference.id, reference]),
		);
		for (const [id, removedRevision] of this.locallyRemovedRevisions) {
			const incoming = incomingById.get(id);
			if (!incoming || incoming.revision > removedRevision) {
				this.locallyRemovedRevisions.delete(id);
			}
		}
		return references.filter((reference) => {
			const removedRevision = this.locallyRemovedRevisions.get(reference.id);
			return (
				removedRevision === undefined || reference.revision > removedRevision
			);
		});
	}

	private removeManaged(references: ManagedComposerReference[]): void {
		if (references.length === 0) return;
		const previousText = this.options.editor.value;
		const originalPrefix = previousText.slice(
			0,
			this.options.editor.selectionStart,
		);
		const identities = references.map(({ id, revision }) => ({ id, revision }));
		const activeKeys = new Set(
			this.activeReferences.map(
				(reference) => `${reference.id}:${reference.revision}`,
			),
		);
		const pendingKeys = new Set(
			this.pendingReferences.map(
				(reference) => `${reference.id}:${reference.revision}`,
			),
		);
		const working = new Map(
			[...this.activeReferences, ...this.pendingReferences, ...references].map(
				(reference) => [`${reference.id}:${reference.revision}`, reference],
			),
		);
		const result = removeManagedReferences(
			previousText,
			[...working.values()],
			identities,
		);
		const prefixResult = removeManagedReferences(
			originalPrefix,
			references.filter((reference) => reference.end <= originalPrefix.length),
			identities,
		);
		this.reconcilePendingEdits(previousText, result.text);
		this.activeReferences = result.references.filter((reference) =>
			activeKeys.has(`${reference.id}:${reference.revision}`),
		);
		this.pendingReferences = result.references.filter((reference) =>
			pendingKeys.has(`${reference.id}:${reference.revision}`),
		);
		this.writeDraft(result.text, prefixResult.text.length);
	}

	private isPending(reference: ComposerReference): boolean {
		for (const action of this.options.pendingActions()) {
			if (
				action.referenceSnapshots?.some(
					(snapshot) =>
						snapshot.id === reference.id &&
						snapshot.revision === reference.revision,
				)
			) {
				return true;
			}
		}
		return false;
	}

	private reconcilePendingEdits(previousText: string, nextText: string): void {
		for (const action of this.options.pendingActions()) {
			if (!action.referenceSnapshots) continue;
			action.referenceSnapshots = reconcileComposerEdit(
				previousText,
				nextText,
				action.referenceSnapshots,
			).references;
		}
	}

	private writeDraft(text: string, caret: number): void {
		const nextCaret = Math.max(0, Math.min(caret, text.length));
		this.options.editor.value = text;
		this.textSnapshot = text;
		this.options.editor.setSelectionRange(nextCaret, nextCaret);
		this.rememberedCaret = nextCaret;
		this.persist();
		this.options.refreshEditorView();
	}

	private persist(): void {
		this.options.persist(this.options.editor.value, this.activeReferences);
	}
}
