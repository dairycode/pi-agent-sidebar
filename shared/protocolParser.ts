import type { PastedImage, SubmitDelivery, WebviewToHostMessage } from "./protocol.js";
import {
	MAX_ATTACHMENT_COUNT,
	MAX_COMPOSER_REFERENCE_COUNT,
	MAX_IMAGE_ATTACHMENT_COUNT,
	MAX_PATH_LENGTH,
	MAX_RESOLVE_MEDIA_SOURCES,
} from "./protocol.js";

const MAX_ACTION_ID_LENGTH = 128;
const MAX_ENTRY_ID_LENGTH = 512;
const MAX_SESSION_NAME_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 1_000_000;
const MAX_MENTION_QUERY_LENGTH = 512;
const MAX_PASTED_IMAGE_DATA_LENGTH = 16 * 1024 * 1024 + 16;

export function parseWebviewMessage(
	value: unknown,
): WebviewToHostMessage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const message = value as Record<string, unknown>;
	const type = boundedString(message.type, 64);
	if (!type) return;

	if (["ready", "listSessions", "listCommands", "pickAttachments", "showLogs"].includes(type)) {
		return { type } as WebviewToHostMessage;
	}
	if (type === "composerFocused") {
		const requestId = nonNegativeInteger(message.requestId);
		return requestId === undefined ? undefined : { type, requestId };
	}
	if (type === "listWorkspaceFiles") {
		const requestId = nonNegativeInteger(message.requestId);
		const query = boundedString(message.query, MAX_MENTION_QUERY_LENGTH, true);
		return requestId === undefined || query === undefined ? undefined : { type, requestId, query };
	}
	if (type === "resolveMedia") {
		const requestId = nonNegativeInteger(message.requestId);
		const sources = boundedStringArray(message.sources, MAX_RESOLVE_MEDIA_SOURCES, MAX_PATH_LENGTH);
		return requestId === undefined || !sources || sources.length === 0 ? undefined : { type, requestId, sources };
	}
	if (["abort", "newSession", "cloneSession", "listForkCandidates", "compact", "restart"].includes(type)) {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		return actionId ? ({ type, actionId } as WebviewToHostMessage) : undefined;
	}
	if (type === "submit") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const text = boundedString(message.text, MAX_MESSAGE_LENGTH, true);
		const attachmentIds = boundedStringArray(message.attachmentIds, MAX_ATTACHMENT_COUNT, 128);
		const references = parseReferenceIdentities(message.references);
		if (!actionId || text === undefined || !attachmentIds || !references) return;
		const delivery = parseSubmitDelivery(message.delivery);
		return delivery ? { type, actionId, text, attachmentIds, references, delivery } : { type, actionId, text, attachmentIds, references };
	}
	if (type === "forkSession") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const entryId = boundedString(message.entryId, MAX_ENTRY_ID_LENGTH);
		return actionId && entryId ? { type, actionId, entryId } : undefined;
	}
	if (type === "switchSession" || type === "deleteSession") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const sessionPath = boundedString(message.path, MAX_PATH_LENGTH);
		return actionId && sessionPath ? { type, actionId, path: sessionPath } : undefined;
	}
	if (type === "setModel") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const provider = boundedString(message.provider, 512);
		const modelId = boundedString(message.modelId, 512);
		return actionId && provider && modelId ? { type, actionId, provider, modelId } : undefined;
	}
	if (type === "setThinking") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const level = boundedString(message.level, 128);
		return actionId && level ? { type, actionId, level } : undefined;
	}
	if (type === "renameSession") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const name = boundedString(message.name, MAX_SESSION_NAME_LENGTH);
		return actionId && name ? { type, actionId, name } : undefined;
	}
	if (type === "pasteImages") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const images = parsePastedImages(message.images);
		return actionId && images ? { type, actionId, images } : undefined;
	}
	if (type === "addResources") {
		const actionId = boundedString(message.actionId, MAX_ACTION_ID_LENGTH);
		const resources = boundedStringArray(message.resources, MAX_COMPOSER_REFERENCE_COUNT, MAX_PATH_LENGTH);
		return actionId && resources && resources.length > 0 ? { type, actionId, resources } : undefined;
	}
	if (type === "removeAttachment" || type === "openComposerReference") {
		const id = boundedString(message.id, 128);
		return id ? { type, id } : undefined;
	}
	if (type === "removeComposerReference") {
		const id = boundedString(message.id, 128);
		const revision = nonNegativeInteger(message.revision);
		return id && revision !== undefined ? { type, id, revision } : undefined;
	}
	if (type === "openExternal") {
		const href = boundedString(message.href, 8 * 1024);
		return href ? { type, href } : undefined;
	}
	if (type === "openResource") {
		const uri = boundedString(message.uri, MAX_PATH_LENGTH);
		if (!uri) return undefined;
		const line = nonNegativeInteger(message.line);
		return line === undefined ? { type, uri } : { type, uri, line };
	}
	if (type === "openWorkspacePath") {
		const workspacePath = boundedString(message.path, MAX_PATH_LENGTH);
		if (!workspacePath) return undefined;
		const line = nonNegativeInteger(message.line);
		return line === undefined ? { type, path: workspacePath } : { type, path: workspacePath, line };
	}
	return;
}

function parseSubmitDelivery(value: unknown): SubmitDelivery | undefined {
	return value === "steer" || value === "followUp" ? value : undefined;
}

function parseReferenceIdentities(value: unknown): Array<{ id: string; revision: number; start: number; end: number }> | undefined {
	if (!Array.isArray(value) || value.length > MAX_COMPOSER_REFERENCE_COUNT) return;
	const references: Array<{ id: string; revision: number; start: number; end: number }> = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return;
		const candidate = item as Record<string, unknown>;
		const id = boundedString(candidate.id, 128);
		const revision = nonNegativeInteger(candidate.revision);
		const start = nonNegativeInteger(candidate.start);
		const end = nonNegativeInteger(candidate.end);
		if (!id || revision === undefined || start === undefined || end === undefined || end <= start) return;
		references.push({ id, revision, start, end });
	}
	return references;
}

function parsePastedImages(value: unknown): PastedImage[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMAGE_ATTACHMENT_COUNT) return;
	const images: PastedImage[] = [];
	let totalDataLength = 0;
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return;
		const candidate = item as Record<string, unknown>;
		const name = boundedString(candidate.name, 512, true);
		const mimeType = boundedString(candidate.mimeType, 128);
		const data = boundedString(candidate.data, MAX_PASTED_IMAGE_DATA_LENGTH, true);
		if (name === undefined || !mimeType || data === undefined) return;
		totalDataLength += data.length;
		if (totalDataLength > MAX_PASTED_IMAGE_DATA_LENGTH) return;
		images.push({ name, mimeType, data });
	}
	return images;
}

function boundedString(value: unknown, maxLength: number, allowEmpty = false): string | undefined {
	if (typeof value !== "string" || value.length > maxLength) return;
	if (!allowEmpty && value.length === 0) return;
	return value;
}

function boundedStringArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
	if (!Array.isArray(value) || value.length > maxItems) return;
	const values: string[] = [];
	for (const item of value) {
		const parsed = boundedString(item, maxLength);
		if (!parsed) return;
		values.push(parsed);
	}
	return values;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
