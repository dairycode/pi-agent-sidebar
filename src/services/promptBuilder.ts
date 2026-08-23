import {
	MAX_TOTAL_IMAGE_BYTES,
	type AttachmentStore,
	type ResolvedAttachment,
} from "./attachmentStore.js";
import {
	serializeContextValue,
	serializeSelectionReferencePayload,
	type FileReferencePayload,
	type SelectionReferencePayload,
} from "../../shared/composerReferences.js";

const MAX_MESSAGE_LENGTH = 1_000_000;

export interface PromptDiagnostic {
	line: number;
	severity: string;
	message: string;
	source?: string;
	code?: string;
}

export interface PromptFileReference {
	summary: { kind: "file" };
	payload: FileReferencePayload;
}

export interface PromptDirectoryReference {
	summary: { kind: "directory" };
	payload: FileReferencePayload;
}

export interface PromptSelectionReference {
	summary: { kind: "selection" };
	payload: SelectionReferencePayload;
	diagnostics: PromptDiagnostic[];
	symbol?: string;
}

export type PromptReference =
	| PromptFileReference
	| PromptDirectoryReference
	| PromptSelectionReference;

export interface BuiltPrompt {
	message: string;
	images: Array<{ type: "image"; data: string; mimeType: string }>;
}

export async function buildPrompt(
	text: string,
	attachments: ResolvedAttachment[],
	references: PromptReference[],
	attachmentStore: Pick<AttachmentStore, "validateRegularFile" | "readImage">,
): Promise<BuiltPrompt> {
	if (typeof text !== "string" || text.length > MAX_MESSAGE_LENGTH) {
		throw new Error("Message is too large.");
	}

	const files: string[] = [];
	const images: BuiltPrompt["images"] = [];
	let totalImageBytes = 0;
	for (const attachment of attachments) {
		if (attachment.summary.kind === "file") {
			await attachmentStore.validateRegularFile(attachment);
			files.push(attachment.filePath);
			continue;
		}
		const image = await attachmentStore.readImage(attachment);
		totalImageBytes += image.data.byteLength;
		if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
			throw new Error("Attached images exceed the 12 MB total limit.");
		}
		images.push({
			type: "image",
			data: image.data.toString("base64"),
			mimeType: image.mimeType,
		});
	}

	const fileReferences = references.filter(
		(reference): reference is PromptFileReference =>
			reference.summary.kind === "file",
	);
	const directoryReferences = references.filter(
		(reference): reference is PromptDirectoryReference =>
			reference.summary.kind === "directory",
	);
	const selectionReferences = references.filter(
		(reference): reference is PromptSelectionReference =>
			reference.summary.kind === "selection",
	);
	const contextLines = [
		...files.map((file) => `- file: ${serializeContextValue(file)}`),
		...fileReferences.map(
			(reference) => `- file: ${serializeContextValue(reference.payload)}`,
		),
		...directoryReferences.map(
			(reference) => `- directory: ${serializeContextValue(reference.payload)}`,
		),
		...selectionReferences.map(
			(reference) =>
				`- selection: ${serializeSelectionReferencePayload(reference.payload)}`,
		),
		...selectionReferences.flatMap((reference) =>
			reference.diagnostics.length > 0
				? [
						`- diagnostics: ${serializeContextValue({
							path: reference.payload.displayPath,
							items: reference.diagnostics,
						})}`,
					]
				: [],
		),
		...selectionReferences.flatMap((reference) =>
			reference.symbol
				? [
						`- symbol: ${serializeContextValue({
							path: reference.payload.displayPath,
							name: reference.symbol,
						})}`,
					]
				: [],
		),
	];
	const contextBlock =
		contextLines.length > 0
			? `<pi-context>\n${contextLines.join("\n")}\n</pi-context>\n\n`
			: "";

	// Keep reference markers in place so their position in the sentence remains
	// available to pi and to the rendered message bubble. Structured context
	// carries the full file and selection data.
	let promptText = text;
	if (!promptText.trim()) {
		if (files.length > 0) promptText = "Inspect the attached file.";
		else if (fileReferences.length > 0)
			promptText = "Inspect the referenced file.";
		else if (directoryReferences.length > 0)
			promptText = "Inspect the referenced directory.";
		else if (selectionReferences.length > 0)
			promptText = "Inspect the selected code.";
		else if (images.length > 0) promptText = "Inspect the attached image.";
	}
	const message = `${contextBlock}${promptText}`;
	if (message.length > MAX_MESSAGE_LENGTH)
		throw new Error("Message is too large.");
	return { message, images };
}
