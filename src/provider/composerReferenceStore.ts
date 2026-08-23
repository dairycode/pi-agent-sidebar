import { randomUUID } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import {
	formatDirectoryReferenceMarker,
	formatFileReferenceMarker,
	formatSelectionReferenceMarker,
	nearestOffset,
	selectedLineRange,
	uniqueComposerReferenceMarker,
	type FileReferencePayload,
	type SelectionReferencePayload,
} from "../../shared/composerReferences.js";
import {
	MAX_COMPOSER_REFERENCE_COUNT,
	type ComposerReference,
	type DirectoryComposerReference,
	type FileComposerReference,
	type SelectionComposerReference,
} from "../../shared/protocol.js";

const MAX_COMPOSER_REFERENCE_BYTES = 64 * 1024;
export const MAX_TOTAL_COMPOSER_REFERENCE_BYTES = 256 * 1024;
const MAX_DIAGNOSTICS_PER_REFERENCE = 20;

interface DiagnosticEntry {
	line: number;
	severity: string;
	message: string;
	source?: string;
	code?: string;
}

interface CapturedFileReference {
	summary: FileComposerReference;
	payload: FileReferencePayload;
	uri: vscode.Uri;
	key: string;
}

interface CapturedDirectoryReference {
	summary: DirectoryComposerReference;
	payload: FileReferencePayload;
	uri: vscode.Uri;
	key: string;
}

interface CapturedSelectionReference {
	summary: SelectionComposerReference;
	payload: SelectionReferencePayload;
	uri: vscode.Uri;
	selection: vscode.Selection;
	startOffset: number;
	key: string;
	byteLength: number;
	diagnostics: DiagnosticEntry[];
	symbol?: string;
}

export type CapturedComposerReference =
	| CapturedFileReference
	| CapturedDirectoryReference
	| CapturedSelectionReference;

export interface SubmittedComposerReference {
	reference: CapturedComposerReference;
	start: number;
	end: number;
}

function isCapturedSelectionReference(
	reference: CapturedComposerReference,
): reference is CapturedSelectionReference {
	return reference.summary.kind === "selection";
}

/** Owns host-side composer reference capture, revisions, and submission checks. */
export class ComposerReferenceStore {
	private readonly references = new Map<string, CapturedComposerReference>();

	public constructor(private readonly output: vscode.OutputChannel) {}

	public summaries(): ComposerReference[] {
		return [...this.references.values()].map((reference) => reference.summary);
	}

	public snapshot(): CapturedComposerReference[] {
		return [...this.references.values()];
	}

	public consume(references: readonly CapturedComposerReference[]): void {
		for (const reference of references) {
			if (this.references.get(reference.summary.id) === reference) {
				this.references.delete(reference.summary.id);
			}
		}
	}

	public clear(): void {
		this.references.clear();
	}

	public captureSelection(
		editor: vscode.TextEditor,
		selection = editor.selection,
		maxByteLength = MAX_COMPOSER_REFERENCE_BYTES,
	): string | undefined {
		const { document } = editor;
		const text = document.getText(selection);
		if (!text) return undefined;

		const byteLength = Buffer.byteLength(text, "utf8");
		if (byteLength > maxByteLength) {
			throw new Error(
				maxByteLength === MAX_COMPOSER_REFERENCE_BYTES
					? "Select at most 64 KB of code for one reference."
					: "Unsaved file content exceeds the 256 KB reference limit.",
			);
		}

		const key = [
			document.uri.toString(),
			selection.start.line,
			selection.start.character,
			selection.end.line,
			selection.end.character,
		].join(":");
		const existing = [...this.references.values()].find(
			(reference): reference is CapturedSelectionReference =>
				reference.summary.kind === "selection" && reference.key === key,
		);
		if (!existing && this.references.size >= MAX_COMPOSER_REFERENCE_COUNT) {
			throw new Error(
				`Add at most ${MAX_COMPOSER_REFERENCE_COUNT} references per message.`,
			);
		}
		const totalBytes = [...this.references.values()].reduce(
			(total, reference) =>
				isCapturedSelectionReference(reference) && reference !== existing
					? total + reference.byteLength
					: total,
			0,
		);
		if (totalBytes + byteLength > MAX_TOTAL_COMPOSER_REFERENCE_BYTES) {
			throw new Error("Selection references exceed the 256 KB total limit.");
		}

		const lines = selectedLineRange(
			selection.start.line,
			selection.end.line,
			selection.end.character,
		);
		const displayPath = this.displayPath(document.uri, document.fileName);
		const id = existing?.summary.id ?? randomUUID();
		const revision = (existing?.summary.revision ?? -1) + 1;
		const baseMarker = formatSelectionReferenceMarker(
			displayPath,
			lines.startLine,
			lines.endLine,
		);
		const marker =
			existing?.summary.marker ??
			uniqueComposerReferenceMarker(
				baseMarker,
				id,
				new Set(
					[...this.references.values()].map(
						(reference) => reference.summary.marker,
					),
				),
			);
		const payload: SelectionReferencePayload = {
			path:
				document.uri.scheme === "untitled"
					? document.uri.toString(true)
					: document.uri.fsPath || document.uri.toString(true),
			uri: document.uri.toString(),
			displayPath,
			marker,
			languageId: document.languageId,
			startLine: lines.startLine,
			endLine: lines.endLine,
			text,
		};
		this.references.set(id, {
			summary: {
				kind: "selection",
				id,
				revision,
				marker,
				displayPath,
				...lines,
			},
			payload,
			uri: document.uri,
			selection,
			startOffset: document.offsetAt(selection.start),
			key,
			byteLength,
			diagnostics: collectDiagnostics(document.uri, selection),
			symbol: existing?.symbol,
		});
		return id;
	}

	public captureFile(uri: vscode.Uri): string {
		return this.captureResource(uri, "file");
	}

	public captureDirectory(uri: vscode.Uri): string {
		return this.captureResource(uri, "directory");
	}

	private captureResource(uri: vscode.Uri, kind: "file" | "directory"): string {
		const key = `${kind}:${uri.toString()}`;
		const existing = [...this.references.values()].find(
			(reference) => reference.summary.kind === kind && reference.key === key,
		);
		if (existing) return existing.summary.id;
		if (this.references.size >= MAX_COMPOSER_REFERENCE_COUNT) {
			throw new Error(
				`Add at most ${MAX_COMPOSER_REFERENCE_COUNT} references per message.`,
			);
		}

		const displayPath = this.displayPath(uri);
		const id = randomUUID();
		const marker = uniqueComposerReferenceMarker(
			kind === "directory"
				? formatDirectoryReferenceMarker(displayPath)
				: formatFileReferenceMarker(displayPath),
			id,
			new Set(
				[...this.references.values()].map(
					(reference) => reference.summary.marker,
				),
			),
		);
		const payload = {
			path: uri.fsPath || uri.toString(true),
			uri: uri.toString(),
			displayPath,
			marker,
		};
		// `kind` is a union here, so one spread cannot satisfy either summary type;
		// the branches differ only in the literal that narrows them.
		const base = { id, revision: 0, marker, displayPath };
		this.references.set(
			id,
			kind === "directory"
				? { summary: { kind, ...base }, payload, uri, key }
				: { summary: { kind, ...base }, payload, uri, key },
		);
		return id;
	}

	public registerResources(
		resources: ReadonlyArray<{
			uri: vscode.Uri;
			kind: "file" | "directory";
		}>,
	): void {
		const pendingResourceCount = resources.filter(({ uri, kind }) => {
			const key = `${kind}:${uri.toString()}`;
			return ![...this.references.values()].some(
				(reference) => reference.summary.kind === kind && reference.key === key,
			);
		}).length;
		if (
			this.references.size + pendingResourceCount >
			MAX_COMPOSER_REFERENCE_COUNT
		) {
			throw new Error(
				`Add at most ${MAX_COMPOSER_REFERENCE_COUNT} references per message.`,
			);
		}
		for (const { uri, kind } of resources) {
			if (kind === "directory") {
				this.captureDirectory(uri);
			} else {
				this.captureFile(uri);
			}
		}
	}

	public async enrichWithSymbol(
		id: string | undefined,
		editor: vscode.TextEditor,
	): Promise<void> {
		if (!id) return;
		const symbol = await resolveEnclosingSymbol(
			editor.document.uri,
			editor.selection,
		);
		if (!symbol) return;
		const reference = this.references.get(id);
		if (!reference || !isCapturedSelectionReference(reference)) return;
		reference.symbol = symbol;
	}

	public remove(id: unknown, revision: unknown): boolean {
		if (
			typeof id !== "string" ||
			typeof revision !== "number" ||
			!Number.isInteger(revision)
		) {
			return false;
		}
		const reference = this.references.get(id);
		if (!reference || reference.summary.revision !== revision) return false;
		return this.references.delete(id);
	}

	public async open(id: string): Promise<void> {
		const reference = this.references.get(id);
		if (!reference) return;
		try {
			if (reference.summary.kind === "directory") {
				await vscode.commands.executeCommand("revealInExplorer", reference.uri);
				return;
			}
			const document = await vscode.workspace.openTextDocument(reference.uri);
			const editor = await vscode.window.showTextDocument(document, {
				preview: true,
			});
			if (!isCapturedSelectionReference(reference)) return;
			const start = document.validatePosition(reference.selection.start);
			const end = document.validatePosition(reference.selection.end);
			let selection = new vscode.Selection(start, end);
			if (document.getText(selection) !== reference.payload.text) {
				const documentText = document.getText();
				const anchor = Math.min(reference.startOffset, documentText.length);
				const before = documentText.lastIndexOf(reference.payload.text, anchor);
				const after = documentText.indexOf(reference.payload.text, anchor);
				const match = nearestOffset(anchor, before, after);
				if (match >= 0) {
					selection = new vscode.Selection(
						document.positionAt(match),
						document.positionAt(match + reference.payload.text.length),
					);
				}
			}
			editor.selection = selection;
			editor.revealRange(
				selection,
				vscode.TextEditorRevealType.InCenterIfOutsideViewport,
			);
		} catch (error) {
			this.output.appendLine(
				`[reference] Failed to open composer reference: ${toErrorMessage(error)}`,
			);
			void vscode.window.showWarningMessage(
				`Unable to open ${reference.summary.displayPath}.`,
			);
		}
	}

	public resolve(values: unknown, text: string): SubmittedComposerReference[] {
		if (!Array.isArray(values)) return [];
		if (values.length > MAX_COMPOSER_REFERENCE_COUNT) {
			throw new Error(
				`Add at most ${MAX_COMPOSER_REFERENCE_COUNT} references per message.`,
			);
		}
		const references: SubmittedComposerReference[] = [];
		const seen = new Set<string>();
		for (const value of values) {
			if (!value || typeof value !== "object") {
				throw new Error("Invalid composer reference.");
			}
			const { id, revision, start, end } = value as {
				id?: unknown;
				revision?: unknown;
				start?: unknown;
				end?: unknown;
			};
			if (
				typeof id !== "string" ||
				id.length === 0 ||
				id.length > 128 ||
				typeof revision !== "number" ||
				!Number.isSafeInteger(revision) ||
				revision < 0 ||
				typeof start !== "number" ||
				!Number.isSafeInteger(start) ||
				start < 0 ||
				typeof end !== "number" ||
				!Number.isSafeInteger(end) ||
				end <= start ||
				end > text.length
			) {
				throw new Error("Invalid composer reference.");
			}
			const key = `${id}:${revision}`;
			if (seen.has(key)) throw new Error("Duplicate composer reference.");
			seen.add(key);
			const reference = this.references.get(id);
			if (!reference || reference.summary.revision !== revision) {
				throw new Error("A composer reference changed. Add it again.");
			}
			if (text.slice(start, end) !== reference.summary.marker) {
				throw new Error("A composer reference marker changed. Add it again.");
			}
			references.push({ reference, start, end });
		}
		const sorted = [...references].sort(
			(left, right) => left.start - right.start,
		);
		for (let index = 1; index < sorted.length; index += 1) {
			if ((sorted[index - 1]?.end ?? 0) > (sorted[index]?.start ?? 0)) {
				throw new Error("Composer reference markers overlap.");
			}
		}
		return references;
	}

	private displayPath(uri: vscode.Uri, fileName = uri.fsPath): string {
		if (uri.scheme === "untitled") {
			return path.basename(fileName) || "Untitled";
		}
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (folder) {
			const includeWorkspaceFolder =
				(vscode.workspace.workspaceFolders?.length ?? 0) > 1;
			return vscode.workspace
				.asRelativePath(uri, includeWorkspaceFolder)
				.split(path.sep)
				.join("/");
		}
		return fileName || uri.toString(true);
	}
}

function diagnosticSeverityLabel(severity: vscode.DiagnosticSeverity): string {
	switch (severity) {
		case vscode.DiagnosticSeverity.Error:
			return "error";
		case vscode.DiagnosticSeverity.Warning:
			return "warning";
		case vscode.DiagnosticSeverity.Information:
			return "info";
		default:
			return "hint";
	}
}

function diagnosticCodeLabel(
	code: vscode.Diagnostic["code"],
): string | undefined {
	if (code === undefined || code === null) return undefined;
	if (typeof code === "object") return String(code.value);
	return String(code);
}

function collectDiagnostics(
	uri: vscode.Uri,
	range?: vscode.Range,
): DiagnosticEntry[] {
	const all = vscode.languages.getDiagnostics(uri);
	const entries: DiagnosticEntry[] = [];
	for (const diagnostic of all) {
		if (
			diagnostic.severity !== vscode.DiagnosticSeverity.Error &&
			diagnostic.severity !== vscode.DiagnosticSeverity.Warning
		) {
			continue;
		}
		if (range && !range.intersection(diagnostic.range)) continue;
		const code = diagnosticCodeLabel(diagnostic.code);
		entries.push({
			line: diagnostic.range.start.line + 1,
			severity: diagnosticSeverityLabel(diagnostic.severity),
			message: diagnostic.message,
			...(diagnostic.source ? { source: diagnostic.source } : {}),
			...(code ? { code } : {}),
		});
		if (entries.length >= MAX_DIAGNOSTICS_PER_REFERENCE) break;
	}
	return entries.sort((left, right) => left.line - right.line);
}

function symbolKindLabel(kind: vscode.SymbolKind): string {
	return vscode.SymbolKind[kind]?.toLowerCase() ?? "symbol";
}

function findEnclosingSymbol(
	symbols: vscode.DocumentSymbol[],
	range: vscode.Range,
	trail: string[] = [],
): string | undefined {
	for (const symbol of symbols) {
		if (!symbol.range.contains(range)) continue;
		const here = `${symbolKindLabel(symbol.kind)} ${symbol.name}`;
		const nested = findEnclosingSymbol(symbol.children ?? [], range, [
			...trail,
			here,
		]);
		return nested ?? [...trail, here].join(" > ");
	}
	return trail.length > 0 ? trail.join(" > ") : undefined;
}

async function resolveEnclosingSymbol(
	uri: vscode.Uri,
	range: vscode.Range,
): Promise<string | undefined> {
	try {
		const symbols = await vscode.commands.executeCommand<
			vscode.DocumentSymbol[]
		>("vscode.executeDocumentSymbolProvider", uri);
		if (!Array.isArray(symbols) || symbols.length === 0) return undefined;
		return findEnclosingSymbol(symbols, range);
	} catch {
		return undefined;
	}
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
