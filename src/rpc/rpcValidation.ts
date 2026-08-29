import type {
	ForkCandidate,
	JsonRecord,
	PiCommand,
	PiContentBlock,
	PiMessage,
	PiModel,
	PiSessionChangeResult,
	PiSessionEntries,
	PiSessionEntry,
	PiSessionTree,
	PiSessionTreeNode,
	PiState,
	PiStats,
} from "../../shared/protocol.js";

const MAX_MESSAGES = 5_000;
const MAX_CONTENT_BLOCKS = 10_000;
const MAX_MODELS = 1_000;
const MAX_COMMANDS = 2_000;
export const MAX_FORK_CANDIDATES = 5_000;
export const MAX_SESSION_ENTRIES = 20_000;
export const MAX_SESSION_TREE_DEPTH = 200;
export const MAX_SESSION_ENTRY_ID_LENGTH = 512;
export const MAX_SESSION_ENTRY_TIMESTAMP_LENGTH = 128;
const MAX_COMMAND_NAME_LENGTH = 512;
const MAX_COMMAND_DESCRIPTION_LENGTH = 8 * 1024;
const MAX_THINKING_LEVELS = 100;
const MAX_TEXT_LENGTH = 1_000_000;
const MAX_IMAGE_DATA_LENGTH = 16 * 1024 * 1024 + 16;

export class ProtocolValidationError extends Error {}

export function parsePiState(value: unknown): PiState {
	const state = record(value, "state");
	optionalString(state.sessionFile, "state.sessionFile", 32 * 1024);
	optionalString(state.sessionId, "state.sessionId", 512);
	optionalString(state.sessionName, "state.sessionName", 8 * 1024);
	optionalString(state.thinkingLevel, "state.thinkingLevel", 128);
	optionalBoolean(state.isStreaming, "state.isStreaming");
	optionalBoolean(state.isCompacting, "state.isCompacting");
	optionalNonNegativeInteger(state.messageCount, "state.messageCount");
	optionalNonNegativeInteger(
		state.pendingMessageCount,
		"state.pendingMessageCount",
	);
	optionalNullableNumber(state.contextPercent, "state.contextPercent");
	if (state.model !== undefined && state.model !== null)
		parsePiModel(state.model);
	return state as PiState;
}

export function parseMessagesResponse(value: unknown): PiMessage[] {
	const response = record(value, "messages response");
	return array(response.messages, "messages", MAX_MESSAGES).map(
		(message, index) => parsePiMessage(message, `messages[${index}]`),
	);
}

export function parseModelsResponse(value: unknown): PiModel[] {
	const response = record(value, "models response");
	return array(response.models, "models", MAX_MODELS).map((model) =>
		parsePiModel(model),
	);
}

export function parseThinkingLevelsResponse(value: unknown): string[] {
	const response = record(value, "thinking-levels response");
	return array(response.levels, "levels", MAX_THINKING_LEVELS).map(
		(level, index) => string(level, `levels[${index}]`, 128),
	);
}

/**
 * Extracts the command fields the sidebar renders.
 *
 * Rows missing a usable `name` are dropped rather than throwing: a single
 * malformed entry from an extension should not blank the entire command list.
 * Unknown `source`/`location` values pass through untouched so a newly added
 * pi command kind only loses its grouping header.
 */
export function parseCommandsResponse(value: unknown): PiCommand[] {
	const response = record(value, "commands response");
	const commands: PiCommand[] = [];
	for (const [index, entry] of array(
		response.commands,
		"commands",
		MAX_COMMANDS,
	).entries()) {
		const command = record(entry, `commands[${index}]`);
		const name = command.name;
		if (
			typeof name !== "string" ||
			name.length === 0 ||
			name.length > MAX_COMMAND_NAME_LENGTH
		) {
			continue;
		}
		const parsed: PiCommand = { ...command, name };
		parsed.description = optionalString(
			command.description,
			`commands[${index}].description`,
			MAX_COMMAND_DESCRIPTION_LENGTH,
		);
		parsed.source = optionalString(
			command.source,
			`commands[${index}].source`,
			128,
		);
		parsed.location = optionalString(
			command.location,
			`commands[${index}].location`,
			128,
		);
		parsed.path = optionalString(
			command.path,
			`commands[${index}].path`,
			32 * 1024,
		);
		commands.push(parsed);
	}
	return commands;
}

export function parsePiStats(value: unknown): PiStats {
	const stats = record(value, "session stats");
	optionalNumber(stats.cost, "stats.cost");
	optionalNonNegativeInteger(stats.totalMessages, "stats.totalMessages");
	optionalNonNegativeInteger(stats.userMessages, "stats.userMessages");
	optionalNonNegativeInteger(
		stats.assistantMessages,
		"stats.assistantMessages",
	);
	optionalNonNegativeInteger(stats.toolResults, "stats.toolResults");
	optionalNonNegativeInteger(stats.toolCalls, "stats.toolCalls");
	if (stats.contextUsage !== undefined) {
		const usage = record(stats.contextUsage, "stats.contextUsage");
		optionalNullableNumber(usage.tokens, "stats.contextUsage.tokens");
		optionalNumber(usage.contextWindow, "stats.contextUsage.contextWindow");
		optionalNullableNumber(usage.percent, "stats.contextUsage.percent");
	}
	if (stats.tokens !== undefined) {
		const tokens = record(stats.tokens, "stats.tokens");
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
			optionalNumber(tokens[key], `stats.tokens.${key}`);
		}
	}
	return stats as PiStats;
}

export function parseSessionChangeResult(
	value: unknown,
): PiSessionChangeResult {
	if (value === undefined || value === null) return {};
	const result = record(value, "session change response");
	optionalBoolean(result.cancelled, "session change response.cancelled");
	optionalString(result.text, "session change response.text", MAX_TEXT_LENGTH);
	optionalString(result.sessionId, "session change response.sessionId", 512);
	optionalString(
		result.sessionFile,
		"session change response.sessionFile",
		32 * 1024,
	);
	return result as PiSessionChangeResult;
}

/**
 * Parses the stable identities pi returns for its fork picker. The text is a
 * display/copy value; `entryId` remains the only value suitable for a fork
 * command.
 */
export function parseForkMessagesResponse(value: unknown): ForkCandidate[] {
	const response = record(value, "fork-messages response");
	const candidates: ForkCandidate[] = [];
	const ids = new Set<string>();
	for (const [index, item] of array(
		response.messages,
		"fork-messages.messages",
		MAX_FORK_CANDIDATES,
	).entries()) {
		const candidate = record(item, `fork-messages.messages[${index}]`);
		const entryId = nonEmptyString(
			candidate.entryId,
			`fork-messages.messages[${index}].entryId`,
			MAX_SESSION_ENTRY_ID_LENGTH,
		);
		if (ids.has(entryId))
			throw new ProtocolValidationError(
				`fork-messages.messages[${index}].entryId is duplicated.`,
			);
		ids.add(entryId);
		const text = string(
			candidate.text,
			`fork-messages.messages[${index}].text`,
			MAX_TEXT_LENGTH,
		);
		optionalTimestamp(
			candidate.timestamp,
			`fork-messages.messages[${index}].timestamp`,
		);
		candidates.push({ ...candidate, entryId, text });
	}
	return candidates;
}

/** Parse an append-ordered `get_entries` response without assuming a branch. */
export function parseSessionEntriesResponse(value: unknown): PiSessionEntries {
	const response = record(value, "session entries response");
	const rawEntries = array(
		response.entries,
		"session entries response.entries",
		MAX_SESSION_ENTRIES,
	);
	const ids = new Set<string>();
	const entries = rawEntries.map((entry, index) => {
		const parsed = parseSessionEntry(
			entry,
			`session entries response.entries[${index}]`,
		);
		if (ids.has(parsed.id))
			throw new ProtocolValidationError(
				`session entries response.entries[${index}].id is duplicated.`,
			);
		ids.add(parsed.id);
		return parsed;
	});
	const leafId = nullableString(
		response.leafId,
		"session entries response.leafId",
		MAX_SESSION_ENTRY_ID_LENGTH,
	);
	return { ...response, entries, leafId } as PiSessionEntries;
}

/** Parse a bounded recursive `get_tree` response. */
export function parseSessionTreeResponse(value: unknown): PiSessionTree {
	const response = record(value, "session tree response");
	const ids = new Set<string>();
	let nodeCount = 0;
	const parseNode = (
		nodeValue: unknown,
		label: string,
		depth: number,
	): PiSessionTreeNode => {
		if (depth > MAX_SESSION_TREE_DEPTH)
			throw new ProtocolValidationError(
				`${label} exceeds the ${MAX_SESSION_TREE_DEPTH}-level depth limit.`,
			);
		nodeCount += 1;
		if (nodeCount > MAX_SESSION_ENTRIES)
			throw new ProtocolValidationError(
				`session tree exceeds the ${MAX_SESSION_ENTRIES}-node limit.`,
			);
		const node = record(nodeValue, label);
		const entry = parseSessionEntry(node.entry, `${label}.entry`);
		if (ids.has(entry.id))
			throw new ProtocolValidationError(`${label}.entry.id is duplicated.`);
		ids.add(entry.id);
		const children = array(
			node.children,
			`${label}.children`,
			MAX_SESSION_ENTRIES,
		).map((child, index) =>
			parseNode(child, `${label}.children[${index}]`, depth + 1),
		);
		const parsed: PiSessionTreeNode = { ...node, entry, children };
		parsed.label = optionalString(node.label, `${label}.label`, 8 * 1024);
		parsed.labelTimestamp = optionalString(
			node.labelTimestamp,
			`${label}.labelTimestamp`,
			MAX_SESSION_ENTRY_TIMESTAMP_LENGTH,
		);
		return parsed;
	};
	const tree = array(
		response.tree,
		"session tree response.tree",
		MAX_SESSION_ENTRIES,
	).map((node, index) =>
		parseNode(node, `session tree response.tree[${index}]`, 0),
	);
	const leafId = nullableString(
		response.leafId,
		"session tree response.leafId",
		MAX_SESSION_ENTRY_ID_LENGTH,
	);
	return { ...response, tree, leafId } as PiSessionTree;
}

export function validateRpcEvent(event: JsonRecord): JsonRecord {
	const type = optionalString(event.type, "event.type", 128);
	if (!type) throw new ProtocolValidationError("Pi event is missing a type.");
	if (["message_start", "message_end"].includes(type)) {
		parsePiMessage(event.message, `${type}.message`);
	}
	if (type === "message_update") {
		// pi streams message updates as deltas (`assistantMessageEvent`) rather
		// than cumulative message snapshots. `message` may still appear when
		// talking to an older binary, so validate it when present.
		if (event.message !== undefined) {
			parsePiMessage(event.message, "message_update.message");
		}
		parseAssistantMessageEvent(event.assistantMessageEvent);
	}
	if (type.startsWith("tool_execution_")) {
		optionalString(event.toolCallId, `${type}.toolCallId`, 512);
		optionalString(event.toolName, `${type}.toolName`, 512);
	}
	return event;
}

/**
 * Validates a `message_update` delta payload. The field is optional so a
 * bare event (no delta yet) cannot fail the whole stream.
 */
function parseAssistantMessageEvent(value: unknown): void {
	if (value === undefined || value === null) return;
	const label = "message_update.assistantMessageEvent";
	const delta = record(value, label);
	optionalString(delta.type, `${label}.type`, 128);
	optionalNumber(delta.contentIndex, `${label}.contentIndex`);
	optionalString(delta.delta, `${label}.delta`, MAX_TEXT_LENGTH);
	optionalString(delta.content, `${label}.content`, MAX_TEXT_LENGTH);
	if (delta.toolCall !== undefined) {
		const toolCall = record(delta.toolCall, `${label}.toolCall`);
		optionalString(toolCall.id, `${label}.toolCall.id`, 512);
		optionalString(toolCall.name, `${label}.toolCall.name`, 512);
	}
}

function parsePiMessage(value: unknown, label = "message"): PiMessage {
	const message = record(value, label);
	string(message.role, `${label}.role`, 128);
	optionalTimestamp(message.timestamp, `${label}.timestamp`);
	optionalString(message.toolCallId, `${label}.toolCallId`, 512);
	optionalString(message.toolName, `${label}.toolName`, 512);
	optionalString(
		message.errorMessage,
		`${label}.errorMessage`,
		MAX_TEXT_LENGTH,
	);
	optionalString(message.command, `${label}.command`, MAX_TEXT_LENGTH);
	optionalString(message.output, `${label}.output`, MAX_TEXT_LENGTH);
	optionalString(message.summary, `${label}.summary`, MAX_TEXT_LENGTH);
	if (message.content !== undefined) {
		if (typeof message.content === "string") {
			string(message.content, `${label}.content`, MAX_TEXT_LENGTH);
		} else {
			for (const [index, block] of array(
				message.content,
				`${label}.content`,
				MAX_CONTENT_BLOCKS,
			).entries()) {
				parseContentBlock(block, `${label}.content[${index}]`);
			}
		}
	}
	return message as PiMessage;
}

function parseContentBlock(value: unknown, label: string): PiContentBlock {
	const block = record(value, label);
	string(block.type, `${label}.type`, 128);
	optionalString(block.text, `${label}.text`, MAX_TEXT_LENGTH);
	optionalString(block.thinking, `${label}.thinking`, MAX_TEXT_LENGTH);
	optionalString(block.data, `${label}.data`, MAX_IMAGE_DATA_LENGTH);
	optionalString(block.mimeType, `${label}.mimeType`, 128);
	optionalString(block.id, `${label}.id`, 512);
	optionalString(block.name, `${label}.name`, 512);
	if (block.arguments !== undefined)
		record(block.arguments, `${label}.arguments`);
	return block as PiContentBlock;
}

function parseSessionEntry(value: unknown, label: string): PiSessionEntry {
	const entry = record(value, label);
	const type = nonEmptyString(entry.type, `${label}.type`, 128);
	const id = nonEmptyString(
		entry.id,
		`${label}.id`,
		MAX_SESSION_ENTRY_ID_LENGTH,
	);
	const parentId =
		entry.parentId === null
			? null
			: nonEmptyString(
					entry.parentId,
					`${label}.parentId`,
					MAX_SESSION_ENTRY_ID_LENGTH,
				);
	const timestamp = nonEmptyString(
		entry.timestamp,
		`${label}.timestamp`,
		MAX_SESSION_ENTRY_TIMESTAMP_LENGTH,
	);
	return { ...entry, type, id, parentId, timestamp } as PiSessionEntry;
}

function parsePiModel(value: unknown): PiModel {
	const model = record(value, "model");
	string(model.id, "model.id", 512);
	string(model.name, "model.name", 512);
	string(model.provider, "model.provider", 512);
	optionalBoolean(model.reasoning, "model.reasoning");
	optionalNumber(model.contextWindow, "model.contextWindow");
	return model as PiModel;
}

function record(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ProtocolValidationError(`${label} must be an object.`);
	}
	return value as JsonRecord;
}

function array(value: unknown, label: string, maxLength: number): unknown[] {
	if (!Array.isArray(value)) {
		throw new ProtocolValidationError(`${label} must be an array.`);
	}
	if (value.length > maxLength) {
		throw new ProtocolValidationError(
			`${label} exceeds the ${maxLength}-item limit.`,
		);
	}
	return value;
}

function string(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string") {
		throw new ProtocolValidationError(`${label} must be a string.`);
	}
	if (value.length > maxLength) {
		throw new ProtocolValidationError(`${label} is too large.`);
	}
	return value;
}

function optionalString(
	value: unknown,
	label: string,
	maxLength: number,
): string | undefined {
	return value === undefined ? undefined : string(value, label, maxLength);
}

function nonEmptyString(
	value: unknown,
	label: string,
	maxLength: number,
): string {
	const parsed = string(value, label, maxLength);
	if (parsed.length === 0)
		throw new ProtocolValidationError(`${label} must not be empty.`);
	return parsed;
}

function nullableString(
	value: unknown,
	label: string,
	maxLength: number,
): string | null {
	return value === null ? null : nonEmptyString(value, label, maxLength);
}

function optionalBoolean(value: unknown, label: string): void {
	if (value !== undefined && typeof value !== "boolean") {
		throw new ProtocolValidationError(`${label} must be a boolean.`);
	}
}

function optionalNumber(value: unknown, label: string): void {
	if (
		value !== undefined &&
		(typeof value !== "number" || !Number.isFinite(value))
	) {
		throw new ProtocolValidationError(`${label} must be a finite number.`);
	}
}

function optionalNonNegativeInteger(value: unknown, label: string): void {
	if (
		value !== undefined &&
		(typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
	) {
		throw new ProtocolValidationError(
			`${label} must be a non-negative integer.`,
		);
	}
}

function optionalTimestamp(value: unknown, label: string): void {
	if (
		value !== undefined &&
		(typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
	) {
		throw new ProtocolValidationError(
			`${label} must be a non-negative epoch-millisecond integer.`,
		);
	}
}

function optionalNullableNumber(value: unknown, label: string): void {
	if (value !== null) optionalNumber(value, label);
}
